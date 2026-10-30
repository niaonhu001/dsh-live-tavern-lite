/** Text to motion: the VRMA writer, the ARDY bridge, and the Host route. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../lib/index.mjs'
import { bodyPromptFor } from '../lib/motion/autoBody.mjs'
import { ardyspecQuaternion, ardyspecToVrma } from '../lib/motion/ardyspec.mjs'
import { SAMPLE_IDS, sampleClip } from '../lib/motion/sample.mjs'
import { REST_WORLD, inspectVrma, isVrma, readGlb, writeVrma } from '../lib/motion/vrma.mjs'
import { runArdyProvider } from '../lib/motion/providers.mjs'
import { generateMotion } from '../lib/motion/index.mjs'

/** A pack whose model file is a VRM, so the stage mounts the 3D path. */
async function vrmPackFixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-motion-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'sherry')
  await mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'sherry.vrm'), 'glTF')
  return { home, pack }
}

function fakeContext() {
  const routes = []
  const tools = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on() { return () => {} },
    inject(_names, fn) {
      fn({
        tools: { register: (definition) => { tools.push(definition); return () => {} } },
        systemPrompt: { section: () => () => {}, getSectionOrder: () => 100 },
        on: () => () => {},
        effect: ctx.effect,
      })
      return () => {}
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    logger: { info() {}, warn() {} },
  }
  return { ctx, routes, tools }
}

async function call(route, { method = 'GET', body, url } = {}) {
  const res = {
    statusCode: 0,
    text: '',
    writeHead(code) { this.statusCode = code; return this },
    write(chunk) { this.text += String(chunk); return true },
    end(chunk) { if (chunk !== undefined) this.text += String(chunk) },
  }
  const req = {
    method,
    url: url ?? route.path,
    headers: {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
  }
  await route.handler(req, res)
  return { status: res.statusCode, text: res.text }
}

test('a written VRMA reads back as a playable clip', () => {
  const buffer = writeVrma(sampleClip('wave', 2))
  const info = inspectVrma(buffer)
  assert.equal(info.specVersion, '1.0')
  assert.equal(info.bones.length, 22)
  assert.ok(info.tracks.some(track => track.path === 'rotation'))
  assert.ok(Math.abs(info.duration - 2) < 0.05)
  assert.ok(isVrma(buffer))
  // The GLB container is well-formed, and the binary chunk backs every accessor.
  const { json, bin } = readGlb(buffer)
  assert.equal(json.buffers[0].byteLength, bin.length)
  for (const view of json.bufferViews) {
    assert.ok(view.byteOffset + view.byteLength <= bin.length)
  }
})

test('declared accessor bounds equal the stored float32 samples', () => {
  // A glTF accessor's declared max must equal the stored float32 value; declaring
  // the double 2.4 while the buffer holds 2.4000000953674316 is invalid.
  const clip = sampleClip('wave', 2.4)
  const buffer = writeVrma(clip)
  const { json, bin } = readGlb(buffer)
  const accessor = json.accessors[0]
  const view = json.bufferViews[accessor.bufferView]
  const stored = []
  for (let index = 0; index < accessor.count; index += 1) {
    stored.push(bin.readFloatLE((view.byteOffset ?? 0) + index * 4))
  }
  assert.equal(accessor.max[0], Math.max(...stored))
  assert.equal(accessor.min[0], Math.min(...stored))
  assert.ok(accessor.max[0] > 2.4, 'the float32 value is larger than the double')
})

test('every built-in clip is a valid clip with motion in it', () => {
  for (const id of SAMPLE_IDS) {
    const buffer = writeVrma(sampleClip(id, 1.5))
    const info = inspectVrma(buffer)
    assert.ok(isVrma(buffer), `${id} is playable`)
    assert.ok(info.duration > 1, `${id} has a duration`)
    assert.ok(info.tracks.length > 0, `${id} animates something`)
  }
})

test('the Host generates a clip into the pack and serves it', async () => {
  const { pack } = await vrmPackFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack: 'sherry', director: false, motionProvider: 'sample' })
  const route = harness.routes.find(entry => entry.path.endsWith('/motion'))
  assert.ok(route !== undefined, 'the route is registered')

  const empty = JSON.parse((await call(route)).text)
  assert.equal(empty.provider, 'sample')
  assert.deepEqual(empty.clips, [])

  const created = await call(route, { method: 'POST', body: JSON.stringify({ sample: 'wave', duration: 1 }) })
  assert.equal(created.status, 200)
  const body = JSON.parse(created.text)
  assert.equal(body.ok, true)
  assert.match(body.motion.url, /\/models\/sherry\/motions\/.+\.vrma$/)
  const file = decodeURIComponent(body.motion.url.split('/motions/')[1])
  const bytes = await readFile(join(pack, 'motions', file))
  assert.ok(isVrma(bytes), 'the stored file is a real clip')

  const index = JSON.parse(await readFile(join(pack, 'motions', 'index.json'), 'utf8'))
  assert.equal(index.clips.length, 1)
  assert.equal(index.clips[0].provider, 'sample')

  const listed = JSON.parse((await call(route)).text)
  assert.equal(listed.clips.length, 1)
  assert.match(listed.clips[0].url, /motions\//)
})

test('the tool reports a failing generator instead of throwing', async () => {
  await vrmPackFixture()
  const harness = fakeContext()
  apply(harness.ctx, {
    pack: 'sherry',
    director: false,
    motionProvider: 'http',
    motionEndpoint: 'http://127.0.0.1:1',
    motionTimeout: 20,
  })
  const tool = harness.tools.find(entry => entry.name === 'live2d_motion')
  assert.ok(tool !== undefined, 'the tool is registered')
  const answer = await tool.execute({ prompt: 'a person waves' }, { agent: { id: 's1' } })
  assert.equal(answer.ok, false)
  assert.match(answer.hint, /动作生成失败/)
})

test('a non-3D stage is not offered the clip tool at all', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-motion-2d-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'ailian')
  await mkdir(join(pack, 'model'), { recursive: true })
  await writeFile(join(pack, 'model', 'a.model3.json'), JSON.stringify({ Version: 3, FileReferences: { Moc: 'a.moc3', Textures: [] } }))
  const harness = fakeContext()
  apply(harness.ctx, { pack: 'ailian', director: false, motionProvider: 'sample' })
  // A Live2D model has no humanoid skeleton, so the tool is not registered: the
  // model is never told a clip generator exists.
  assert.equal(harness.tools.some(entry => entry.name === 'live2d_motion'), false)
  // The route still refuses, so a stale caller cannot write a clip into a 2D pack.
  const route = harness.routes.find(entry => entry.path.endsWith('/motion'))
  const answer = await call(route, { method: 'POST', body: JSON.stringify({ prompt: 'wave' }) })
  assert.equal(answer.status, 500)
  assert.match(answer.text, /VRM/)
})

/** A spec shaped exactly like the ARDY engine's `/generate` answer. */
function ardySpecFixture() {
  const fps = 20
  const times = Array.from({ length: 4 }, (_, index) => index / fps)
  return {
    name: 'a person waves',
    duration: times[times.length - 1],
    loop: false,
    tracks: {
      leftUpperArm: times.map(t => ({ t, r: [0, 0, 0] })),
      leftLowerArm: times.map((t, index) => ({ t, r: [0, 0, index * 10] })),
      // The whole-body yaw lives in the root bone, so it must survive the writer.
      hips: times.map((t, index) => ({ t, r: [0, index * 5, 0] })),
      mysteryPawn: times.map(t => ({ t, r: [0, 0, 0] })),
    },
    hips: times.map((t, index) => ({ t, p: [0, -0.02 * index, 0] })),
  }
}

test('an ARDY spec becomes a playable clip on the same bones', () => {
  const converted = ardyspecToVrma(ardySpecFixture(), { name: 'wave' })
  assert.equal(converted.tracks, 3, 'the bone ARDY invented is skipped, not fatal')
  assert.deepEqual(converted.unmapped, ['mysteryPawn'])
  assert.equal(converted.fps, 20)
  assert.ok(isVrma(converted.buffer))
  const info = inspectVrma(converted.buffer)
  assert.ok(info.bones.includes('leftUpperArm'))
  assert.ok(Math.abs(info.duration - 3 / 20) < 1e-6)
  assert.ok(info.tracks.some(track => track.bone === 'hips' && track.path === 'translation'))
  assert.ok(
    info.tracks.some(track => track.bone === 'hips' && track.path === 'rotation'),
    'a root rotation track exists: a turn would otherwise play in place',
  )
})

test('ARDY Euler triples are read as intrinsic X-Y-Z', () => {
  // 90° about X then 90° about Y is (0.5, 0.5, 0.5, 0.5). Read as extrinsic the
  // same numbers would be (0.5, -0.5, 0.5, 0.5), so this pins the convention.
  const quaternion = ardyspecQuaternion([90, 90, 0])
  for (const [index, expected] of [0.5, 0.5, 0.5, 0.5].entries()) {
    assert.ok(Math.abs(quaternion[index] - expected) < 1e-9, `component ${index}`)
  }
})

/** Start a throwaway HTTP server that answers with a fixed ARDY-shaped spec. */
async function ardyStub(onRequest) {
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      onRequest?.(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(ardySpecFixture()))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('the ARDY provider speaks the engine HTTP shape and leaves a clip', async () => {
  const stub = await ardyStub()
  try {
    const result = await runArdyProvider({
      prompt: 'a person waves', duration: 3, seed: 7, endpoint: stub.endpoint,
    })
    assert.ok(isVrma(result.buffer))
    assert.equal(result.detail.endpoint, stub.endpoint)
    assert.equal(result.detail.frames, 4)
    assert.deepEqual(result.detail.unmapped, ['mysteryPawn'])
  } finally {
    await stub.close()
  }
})

test('the ARDY provider refuses a prompt its text encoder cannot read', async () => {
  await assert.rejects(
    // Nothing listens on this port; the refusal must fire before any connection.
    runArdyProvider({ prompt: '向前走两步，然后挥手', duration: 3, endpoint: 'http://127.0.0.1:1' }),
    /英文/,
  )
})

test('a requested duration above the old 12 s ceiling reaches the provider', async () => {
  let seen = null
  const stub = await ardyStub((body) => { seen = body })
  try {
    const result = await generateMotion(
      { prompt: 'a person walks a long way', duration: 30 },
      { provider: 'ardy', endpoint: stub.endpoint, defaultDuration: 4, timeoutMs: 0 },
    )
    assert.equal(seen.duration, 30)
    assert.equal(result.provider, 'ardy')
  } finally {
    await stub.close()
  }
})

test('selecting ARDY makes the tool demand an English prompt', async () => {
  await vrmPackFixture()
  const harness = fakeContext()
  apply(harness.ctx, {
    pack: 'sherry',
    director: false,
    motionProvider: 'ardy',
    motionEndpoint: 'http://127.0.0.1:2337',
  })
  const tool = harness.tools.find(entry => entry.name === 'live2d_motion')
  assert.ok(tool !== undefined, 'the tool is registered')
  assert.match(tool.description, /硬性要求/)
  assert.match(tool.description, /ARDY/)
  assert.match(tool.parameters.properties.prompt.description, /英文/)
  // The refusal reaches the model through the tool result, so it can retry in
  // English inside the same turn instead of waiting for a silent failure.
  const answer = await tool.execute({ prompt: '挥手', duration: 2 }, { agent: { id: 's3' } })
  assert.equal(answer.ok, false)
  assert.match(answer.hint, /英文/)
})

test('every clip carries a non-zero rest hips height, the value the player divides by', () => {
  // Fitting a clip to a model is the player's job: three-vrm-animation scales all
  // hips translation by `modelRestHipsY / clipRestHipsY`. A zero here is not a low
  // stance, it is a division by zero, so this guards the denominator rather than
  // the constant's exact value.
  const restHipsY = (buffer) => {
    const { json } = readGlb(buffer)
    const index = json.extensions.VRMC_vrm_animation.humanoid.humanBones.hips.node
    return json.nodes[index].translation[1]
  }
  const fromArdy = restHipsY(ardyspecToVrma(ardySpecFixture()).buffer)
  const fromSample = restHipsY(writeVrma(sampleClip('wave', 1)))
  assert.ok(fromArdy > 0.5 && fromArdy < 1.2, `the rest hips height is plausible: ${fromArdy}`)
  assert.equal(fromArdy, fromSample, 'both writers share one scaffold, so the ratio stays consistent')
  assert.equal(fromArdy, REST_WORLD.hips[1])
})

test('only large-limb acts are routed to whole-body generation', () => {
  // Head-only recipes stay on the instant channel path.
  for (const recipe of ['nod', 'shake', 'tilt']) {
    assert.equal(bodyPromptFor({ recipe }), null, `${recipe} is a head beat`)
  }
  // Hands, feet and hips carry a sentence the generator can read.
  assert.match(bodyPromptFor({ recipe: 'crouch' }), /crouch/)
  assert.match(bodyPromptFor({ recipe: 'bow' }), /bow/)
  assert.match(bodyPromptFor({ recipe: 'wave' }), /waves/)
  // Choreography families are recognised by prefix, not enumerated.
  assert.match(bodyPromptFor({ recipe: 'gokuraku_3' }), /dances/)
  assert.match(bodyPromptFor({ recipe: 'qianxia_full' }), /dances/)
})

test('an explicit English body sentence wins, and channel-only acts stay on channels', () => {
  const explicit = 'a person walks two steps forward and bows'
  assert.equal(bodyPromptFor({ recipe: 'bow', body: explicit }), explicit)
  assert.equal(bodyPromptFor({ body: '  a person jumps once  ' }), 'a person jumps once')
  // No body field, no body recipe: nothing to describe, so channels keep it.
  assert.equal(bodyPromptFor({ emotion: 'joy', animation: 'ParamAngleX=12@300' }), null)
  assert.equal(bodyPromptFor(null), null)
})

test('a deliberate hips drop is whole-body even without a recipe', () => {
  assert.match(bodyPromptFor({ translate: { hips: [0, -0.24, 0] } }), /sinks the hips/)
  assert.match(bodyPromptFor({ translate: { hips: [0, 0.12, 0] } }), /rises up/)
  // Below the threshold it is a weight shift a bone channel can express.
  assert.equal(bodyPromptFor({ translate: { hips: [0, -0.02, 0] } }), null)
})

test('a whole-body act publishes the face and the clip in one frame', async () => {
  const stub = await ardyStub()
  try {
    await vrmPackFixture()
    const harness = fakeContext()
    apply(harness.ctx, {
      pack: 'sherry',
      director: false,
      motionProvider: 'ardy',
      motionEndpoint: stub.endpoint,
      motionDuration: 2,
    })
    const act = harness.tools.find(entry => entry.name === 'live2d_act')
    assert.ok(act !== undefined, 'the act tool is registered')
    // `bow` moves the hips, so the act resolves the clip before it publishes.
    const answer = await act.execute({ emotion: 'joy', recipe: 'bow' }, { agent: { id: 's4' } })
    assert.equal(answer.ok, true)
    assert.ok('emotion' in answer, 'the face travels with the same frame')
    assert.ok(answer.motion !== undefined, 'and so does the generated clip')
    assert.equal(answer.motion.provider, 'ardy')
    // The clip owns every bone it tracks: a channel pose published beside it is a second
    // writer, and the browser parks those channels for the clip's whole run.
    assert.equal(answer.params, undefined, 'no channel pose beside the clip')
    assert.equal(answer.animation, undefined, 'no channel track beside the clip')
    assert.equal(answer.recipe, undefined, 'the recipe is the clip now')
  } finally {
    await stub.close()
  }
})

test('a head-only act never asks the engine, even with ARDY configured', async () => {
  let asked = false
  const stub = await ardyStub(() => { asked = true })
  try {
    await vrmPackFixture()
    const harness = fakeContext()
    apply(harness.ctx, {
      pack: 'sherry',
      director: false,
      motionProvider: 'ardy',
      motionEndpoint: stub.endpoint,
    })
    const act = harness.tools.find(entry => entry.name === 'live2d_act')
    const answer = await act.execute({ emotion: 'shy', recipe: 'tilt' }, { agent: { id: 's5' } })
    assert.equal(answer.ok, true)
    assert.equal(answer.motion, undefined, 'no clip for a head beat')
    assert.equal(asked, false, 'the engine was never called')
  } finally {
    await stub.close()
  }
})

test('an unreachable engine degrades a body act to bone channels', async () => {
  await vrmPackFixture()
  const harness = fakeContext()
  apply(harness.ctx, {
    pack: 'sherry',
    director: false,
    motionProvider: 'ardy',
    // Nothing listens here: the act must still go through, just without a clip.
    motionEndpoint: 'http://127.0.0.1:1',
    motionDuration: 2,
  })
  const act = harness.tools.find(entry => entry.name === 'live2d_act')
  const answer = await act.execute({ emotion: 'joy', recipe: 'bow' }, { agent: { id: 's6' } })
  assert.equal(answer.ok, true, 'the act still succeeds')
  assert.equal(answer.motion, undefined, 'and keeps its bone-channel pose')
  assert.ok(answer.params !== undefined, 'the pose is what moves her when the engine is down')
})

test('a generated clip fits the act tool output schema', async () => {
  const stub = await ardyStub()
  try {
    await vrmPackFixture()
    const harness = fakeContext()
    apply(harness.ctx, {
      pack: 'sherry',
      director: false,
      motionProvider: 'ardy',
      motionEndpoint: stub.endpoint,
      motionDuration: 2,
    })
    const act = harness.tools.find(entry => entry.name === 'live2d_act')
    const answer = await act.execute({ emotion: 'joy', recipe: 'bow' }, { agent: { id: 's7' } })
    assert.ok(answer.motion !== undefined, 'the clip is in the frame')
    // The runtime validates the returned value against the registered schema, so
    // a clip field the schema does not declare makes the whole act look failed
    // even though the stage already played it. This is that regression.
    const declared = Object.keys(act.output.schema.properties.motion.properties)
    for (const key of Object.keys(answer.motion)) {
      assert.ok(declared.includes(key), `motion.${key} is declared by the tool schema`)
    }
  } finally {
    await stub.close()
  }
})
