/**
 * Route-level tests for the Host half.
 *
 * The DSH Loader imports a plugin module once per process, so a running server
 * keeps serving the code it booted with. These tests call the real `apply()`
 * against a fake Cordis context and exercise every registered route directly,
 * which verifies the Host half without a restart.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A real profile's settings.json pins absolute model/pack directories and would
// shadow every fixture below, so each test file runs against its own home.
const TEST_HOME = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-home-'))
process.env.DSH_HOME = TEST_HOME

const { apply, internals } = await import('../lib/index.mjs')

/** A response that records status, headers and piped bytes. */
class FakeResponse extends Writable {
  statusCode = undefined
  headers = {}
  chunks = []

  writeHead(status, headers) {
    this.statusCode = status
    this.headers = headers ?? {}
    return this
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  get body() {
    return Buffer.concat(this.chunks)
  }

  get text() {
    return this.body.toString('utf8')
  }
}

/** A request that is also async-iterable, which `readBody` relies on. */
function fakeRequest({ method = 'GET', url = '/', body = '' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req[Symbol.asyncIterator] = async function* iterate() {
    if (body !== '') yield Buffer.from(body)
  }
  return req
}

/** Poll until `check` holds, so async director work never needs a fixed sleep. */
async function waitFor(check, { timeout = 2000, step = 5 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, step))
  }
  return false
}

const SCHEMA_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', 'default', 'examples',
])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * Mirror the JSON-Schema subset the real registry enforces, including its
 * rejection of type arrays. A registration that would fail in production fails
 * here instead of silently never appearing in the model's tool list.
 */
function assertToolSchema(node, path = 'schema') {
  assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${path} must be a schema object`)
  for (const key of Object.keys(node)) assert.ok(SCHEMA_KEYWORDS.has(key), `${path}.${key} is not a supported keyword`)
  if (node.type !== undefined) {
    assert.equal(typeof node.type, 'string', `${path}.type must be a single type string`)
    assert.ok(SCHEMA_TYPES.has(node.type), `${path}.type ${String(node.type)} is unsupported`)
  }
  for (const [name, child] of Object.entries(node.properties ?? {})) assertToolSchema(child, `${path}.properties.${name}`)
  if (node.items !== undefined) assertToolSchema(node.items, `${path}.items`)
}

function fakeContext({ services = {} } = {}) {
  const routes = []
  const taps = []
  const disposers = []
  const tools = []
  const sections = []
  const listeners = new Map()
  const registry = {
    tools: {
      register(definition) {
        assert.ok(definition.label !== undefined || definition.name !== undefined, 'tool needs a name')
        assert.ok(definition.output !== undefined && typeof definition.output.render === 'function', `tool ${definition.name} must declare output.render`)
        assertToolSchema(definition.output.schema, `${definition.name}.output.schema`)
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      getSectionOrder() {
        return 2400
      },
    },
    ...services,
  }
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
      tapIndex(transform) {
        taps.push(transform)
        return () => {
          const index = taps.indexOf(transform)
          if (index >= 0) taps.splice(index, 1)
        }
      },
    },
    on(name, callback) {
      const set = listeners.get(name) ?? new Set()
      set.add(callback)
      listeners.set(name, set)
      return () => set.delete(callback)
    },
    inject(names, callback) {
      const child = { effect: ctx.effect, on: ctx.on }
      for (const name of names) {
        if (registry[name] === undefined) return () => {}
        child[name] = registry[name]
      }
      return callback(child)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return {
    ctx,
    routes,
    taps,
    tools,
    sections,
    find: path => routes.find(route => route.path === path),
    emit(name, ...args) {
      for (const callback of listeners.get(name) ?? []) callback(...args)
    },
    disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
      routes.length = 0
      taps.length = 0
      tools.length = 0
      sections.length = 0
      listeners.clear()
    },
  }
}

/** A model directory holding just enough settings for discovery. */
async function fixtureModels() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-test-'))
  const model = join(root, 'demo')
  await mkdir(join(model, 'tex'), { recursive: true })
  await writeFile(join(model, 'demo.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: 'demo.moc3',
      Textures: ['tex/0.png'],
      Expressions: [{ Name: 'alpha', File: 'a.exp3.json' }, { Name: 'beta', File: 'b.exp3.json' }],
      DisplayInfo: 'demo.cdi3.json',
      Motions: { '': [{ File: 'idle.motion3.json' }], Tap: [{ File: 'tap.motion3.json' }] },
    },
  }))
  await writeFile(join(model, 'demo.cdi3.json'), JSON.stringify({
    Parameters: [{ Id: 'ParamAngleX' }, { Id: 'ParamMouthForm' }, { Id: 'ParamHandWave' }],
  }))
  await writeFile(join(model, 'demo.moc3'), 'moc3-bytes')
  await writeFile(join(model, 'tex', '0.png'), 'png-bytes')
  await writeFile(join(model, 'secret.txt'), 'inside')
  return root
}

async function call(route, options) {
  const req = fakeRequest(options)
  const res = new FakeResponse()
  await route.handler(req, res)
  await new Promise(resolve => res.on('finish', resolve))
  return res
}

test('config enumerates models, expressions and motion groups', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo', placement: 'chat,sidebar' })

  const response = await call(harness.find('/dsh-live-tavern-lite/config'))
  assert.equal(response.statusCode, 200)
  const config = JSON.parse(response.text)
  assert.equal(typeof config.hostVersion, 'string')
  assert.deepEqual(config.models.map(model => model.id), ['demo'])
  assert.deepEqual(config.selected.expressions, ['alpha', 'beta'])
  assert.deepEqual(config.selected.motionGroups, [{ group: '', count: 1 }, { group: 'Tap', count: 1 }])
  assert.deepEqual(config.placement, ['chat', 'sidebar'])
  assert.equal(config.selected.entryUrl, '/dsh-live-tavern-lite/models/demo/demo.model3.json')
  harness.disposeAll()
})

test('model prefix route serves settings, textures and rejects escapes', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo' })
  const models = harness.find('/dsh-live-tavern-lite/models')
  assert.equal(models.kind, 'prefix')

  const settings = await call(models, { url: '/dsh-live-tavern-lite/models/demo/demo.model3.json' })
  assert.equal(settings.statusCode, 200)
  assert.equal(settings.headers['content-type'], 'application/json; charset=utf-8')

  const texture = await call(models, { url: '/dsh-live-tavern-lite/models/demo/tex/0.png' })
  assert.equal(texture.statusCode, 200)
  assert.equal(texture.headers['content-type'], 'image/png')
  assert.equal(texture.text, 'png-bytes')

  const moc = await call(models, { url: '/dsh-live-tavern-lite/models/demo/demo.moc3' })
  assert.equal(moc.headers['content-type'], 'application/octet-stream')

  const escape = await call(models, { url: '/dsh-live-tavern-lite/models/..%2F..%2Fwindows%2Fwin.ini' })
  assert.equal(escape.statusCode, 403)

  const missing = await call(models, { url: '/dsh-live-tavern-lite/models/demo/nope.png' })
  assert.equal(missing.statusCode, 404)

  harness.disposeAll()
})

test('core route serves the Cubism runtime as JavaScript', async () => {
  const harness = fakeContext()
  apply(harness.ctx, {})
  const response = await call(harness.find('/dsh-live-tavern-lite/core.js'))
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.match(response.text, /Live2DCubismCore/)
  harness.disposeAll()
})

test('binding round-trips through the model directory', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo' })
  const binding = harness.find('/dsh-live-tavern-lite/binding')

  const empty = await call(binding, { url: '/dsh-live-tavern-lite/binding?model=demo' })
  assert.equal(empty.statusCode, 200)
  assert.deepEqual(JSON.parse(empty.text), { version: 1, expressions: {} })

  const saved = await call(binding, {
    method: 'POST',
    url: '/dsh-live-tavern-lite/binding?model=demo',
    body: JSON.stringify({ version: 1, expressions: { alpha: { emotion: 'joy', valence: 0.6, arousal: 0.3 } } }),
  })
  assert.equal(saved.statusCode, 200)
  assert.deepEqual(JSON.parse(saved.text), { ok: true })
  const onDisk = JSON.parse(await readFile(join(root, 'demo', 'binding.json'), 'utf8'))
  assert.equal(onDisk.expressions.alpha.emotion, 'joy')
  assert.equal(typeof onDisk.updatedAt, 'number')

  const readBack = await call(binding, { url: '/dsh-live-tavern-lite/binding?model=demo' })
  assert.equal(JSON.parse(readBack.text).expressions.alpha.valence, 0.6)

  const badId = await call(binding, { url: '/dsh-live-tavern-lite/binding?model=../etc' })
  assert.equal(badId.statusCode, 400)

  const badBody = await call(binding, { method: 'POST', url: '/dsh-live-tavern-lite/binding?model=demo', body: '[]' })
  assert.equal(badBody.statusCode, 400)

  const badExpressions = await call(binding, { method: 'POST', url: '/dsh-live-tavern-lite/binding?model=demo', body: '{"expressions":5}' })
  assert.equal(badExpressions.statusCode, 400)

  harness.disposeAll()
})

test('both tools register, and recall reads the committed transcript', async () => {
  const harness = fakeContext()
  apply(harness.ctx, {})
  const act = harness.tools.find(entry => entry.name === 'live2d_act')
  const recall = harness.tools.find(entry => entry.name === 'live2d_recall')
  assert.ok(act, 'live2d_act registered')
  assert.ok(recall, 'live2d_recall registered')
  assert.equal(typeof recall.output.render, 'function')

  // Two committed rounds reach the transcript through the session events.
  harness.emit('session/event', { id: 's1', header: { id: 's1' } }, {
    type: 'user/message',
    data: { message: { content: [{ type: 'text', text: '你的尾巴在动' }] } },
  })
  harness.emit('session/event', { id: 's1', header: { id: 's1' } }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '……热的。' }] } },
  })
  const exec = { agent: { id: 's1' } }
  const found = await recall.execute({ query: '尾巴' }, exec)
  assert.equal(found.found, true)
  assert.equal(found.hits[0].round, 1)
  const full = await recall.execute({ round: 1 }, exec)
  assert.equal(full.messages[0].assistant, '……热的。')

  // Another session sees its own record only.
  const other = await recall.execute({ query: '尾巴' }, { agent: { id: 's2' } })
  assert.equal(other.found, false)
  harness.disposeAll()
})

test('status channel stores the last browser self-report', async () => {
  const harness = fakeContext()
  apply(harness.ctx, {})
  const status = harness.find('/dsh-live-tavern-lite/status')

  const before = await call(status)
  assert.equal(before.statusCode, 200)
  const cold = JSON.parse(before.text)
  assert.equal(cold.reported, false)
  // Host diagnostics travel with the browser report so one request accepts a restart.
  assert.equal(cold.host.toolsRegistered, true)
  assert.equal(cold.host.toolsError, null)
  assert.equal(cold.host.director.mode, 'hybrid')
  assert.equal(cold.host.director.ready, false)
  assert.equal(cold.host.stage.subscribers, 0)
  assert.equal(typeof cold.host.hostVersion, 'string')

  const posted = await call(status, {
    method: 'POST',
    body: JSON.stringify({ ok: true, coreLoaded: true, model: 'demo', seats: [{ name: 'chat', width: 800, height: 900 }] }),
  })
  assert.equal(posted.statusCode, 200)

  const after = JSON.parse((await call(status)).text)
  assert.equal(after.reported, true)
  assert.equal(after.model, 'demo')
  assert.equal(after.seats[0].width, 800)
  assert.equal(typeof after.at, 'number')

  const rejected = await call(status, { method: 'POST', body: '"nope"' })
  assert.equal(rejected.statusCode, 400)
  harness.disposeAll()
})

test('stage stream opens, emits its snapshot and closes on teardown', async () => {
  const harness = fakeContext()
  apply(harness.ctx, {})
  const route = harness.find('/dsh-live-tavern-lite/stage')
  const req = fakeRequest({ url: '/dsh-live-tavern-lite/stage?session=abc' })
  const res = new FakeResponse()
  await route.handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.match(res.text, /retry: 3000/)

  // Teardown ends open streams so a removed plugin row leaves no socket behind.
  harness.disposeAll()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(res.writableEnded, true)
})

test('disposal unregisters every route', async () => {
  const harness = fakeContext()
  apply(harness.ctx, {})
  assert.ok(harness.routes.length >= 6)
  harness.disposeAll()
  assert.equal(harness.routes.length, 0)
  assert.equal(harness.taps.length, 0)
})

test('a stage stream without a session receives every frame', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo', director: false })
  const tool = harness.tools.find(entry => entry.name === 'live2d_act')
  const stream = harness.find('/dsh-live-tavern-lite/stage')

  // The browser cannot know which Session the viewer is on, so it subscribes
  // without one and expects the wildcard.
  const browser = new FakeResponse()
  await stream.handler(fakeRequest({ url: '/dsh-live-tavern-lite/stage' }), browser)
  await tool.execute({ emotion: 'joy', line: '在的' }, { agent: { id: 's9' } })
  assert.match(browser.text, /event: stage/)
  const frame = JSON.parse(browser.text.slice(browser.text.indexOf('data: ') + 6).split('\n')[0])
  assert.equal(frame.sessionId, 's9')
  assert.equal(frame.emotion, 'joy')
  harness.disposeAll()
})

test('emotion resolution prefers the request, then calibration, then the nearest point', () => {
  const library = internals.loadEmotionLibrary()
  const expressions = ['alpha', 'beta', 'gamma']

  const requested = internals.resolveEmotionTarget({
    library,
    request: { emotion: 'joy', expression: 'gamma' },
    expressions,
    binding: {},
  })
  assert.equal(requested.expression, 'gamma')
  assert.equal(requested.expressionSource, 'requested')

  const calibrated = internals.resolveEmotionTarget({
    library,
    request: { emotion: 'joy' },
    expressions,
    binding: { beta: { emotion: 'joy', valence: 0.8, arousal: 0.5 } },
  })
  assert.equal(calibrated.expression, 'beta')
  assert.equal(calibrated.expressionSource, 'calibrated')
  assert.equal(calibrated.valence, library.byId.get('joy').valence)
  assert.equal(calibrated.label, '开心')

  // An expression labelled for another mood is never a stand-in: painting the
  // anger switch over a sad face was the bug this test now forbids.
  const mislabelled = internals.resolveEmotionTarget({
    library,
    request: { emotion: 'sad' },
    expressions,
    binding: { alpha: { emotion: 'anger', valence: -0.7, arousal: 0.7 } },
  })
  assert.equal(mislabelled.expression, undefined)
  assert.equal(mislabelled.expressionSource, 'none')

  // An unlabelled calibration entry is fair game: it only carries a point.
  const nearest = internals.resolveEmotionTarget({
    library,
    request: { emotion: 'sad' },
    expressions,
    binding: { alpha: { valence: -0.7, arousal: -0.5 } },
  })
  assert.equal(nearest.expression, 'alpha')
  assert.equal(nearest.expressionSource, 'nearest')

  const uncalibrated = internals.resolveEmotionTarget({
    library,
    request: { emotion: 'joy' },
    expressions,
    binding: {},
  })
  assert.equal(uncalibrated.expression, undefined)
  assert.equal(uncalibrated.expressionSource, 'none')

  const unknown = internals.resolveEmotionTarget({
    library,
    request: { emotion: 'nope' },
    expressions: [],
    binding: {},
  })
  assert.equal(unknown.emotion, 'neutral')
  assert.equal(unknown.unknownEmotion, 'nope')

  const clamped = internals.resolveEmotionTarget({
    library,
    request: { emotion: 'joy', valence: 5, arousal: -9, holdMs: 1 },
    expressions: [],
    binding: {},
  })
  assert.equal(clamped.valence, 1)
  assert.equal(clamped.arousal, -1)
  assert.equal(clamped.holdMs, 800)
})

test('motion requests only resolve to groups the model declares', () => {
  const groups = [{ group: '', count: 2 }, { group: 'Tap', count: 1 }]
  assert.deepEqual(internals.resolveMotion({ group: 'Tap', index: 3 }, groups), { group: 'Tap', index: 0 })
  assert.deepEqual(internals.resolveMotion('Tap#0', groups), { group: 'Tap', index: 0 })
  assert.deepEqual(internals.resolveMotion({ group: '', index: 9 }, groups), { group: '', index: 1 })
  assert.equal(internals.resolveMotion({ group: 'Nope', index: 0 }, groups), undefined)
  assert.equal(internals.resolveMotion(undefined, groups), undefined)
})

test('live2d_act publishes a stage frame the browser receives', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo', director: false, stageUpdatesPerTurn: 8 })
  await writeFile(join(root, 'demo', 'binding.json'), JSON.stringify({
    version: 1,
    expressions: { alpha: { emotion: 'joy', valence: 0.8, arousal: 0.5 } },
  }))

  const tool = harness.tools.find(entry => entry.name === 'live2d_act')
  assert.ok(tool, 'live2d_act is registered')
  assert.equal(tool.parameters.type, 'object')
  // The vector is the primary input: a prototype id is optional seasoning.
  assert.equal(tool.parameters.required, undefined)
  assert.equal(typeof tool.parameters.properties.valence.type, 'string')
  assert.equal(typeof tool.execute, 'function')

  const stream = harness.find('/dsh-live-tavern-lite/stage')
  const res = new FakeResponse()
  await stream.handler(fakeRequest({ url: '/dsh-live-tavern-lite/stage?session=s1' }), res)

  const value = await tool.execute({ emotion: 'joy', line: '你回来啦', motion: { group: 'Tap', index: 0 } }, {
    agent: { id: 's1' },
  })
  assert.equal(value.ok, true)
  assert.equal(value.emotion, 'joy')
  assert.equal(value.expression, 'alpha')
  assert.equal(value.expressionSource, 'calibrated')
  assert.deepEqual(value.motion, { group: 'Tap', index: 0 })

  assert.match(res.text, /event: stage/)
  const frame = JSON.parse(res.text.slice(res.text.indexOf('data: ') + 6).split('\n')[0])
  assert.equal(frame.sessionId, 's1')
  assert.equal(frame.expression, 'alpha')
  assert.equal(frame.line, '你回来啦')
  // Every frame carries the parameter targets the vector resolved into.
  assert.equal(Object.keys(frame.params).length, 11)
  assert.ok(frame.params.ParamMouthForm > 0.5, `mouth ${frame.params.ParamMouthForm}`)

  // A different Session must not receive this frame.
  const other = new FakeResponse()
  await stream.handler(fakeRequest({ url: '/dsh-live-tavern-lite/stage?session=s2' }), other)
  await tool.execute({ emotion: 'sad' }, { agent: { id: 's1' } })
  assert.doesNotMatch(other.text, /event: stage/)

  // An unknown emotion degrades to neutral and says so.
  const degraded = await tool.execute({ emotion: 'wistful' }, { agent: { id: 's1' } })
  assert.equal(degraded.emotion, 'neutral')
  assert.match(degraded.hint, /wistful/)

  harness.disposeAll()
})

test('a bare emotion vector drives the face without a prototype id', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo', director: false })
  const tool = harness.tools.find(entry => entry.name === 'live2d_act')

  const value = await tool.execute({ valence: 0.9, arousal: 0.2, dominance: 0.1, intensity: 0.9 }, {
    agent: { id: 's1' },
  })
  assert.equal(value.ok, true)
  // The nearest prototype only names the mood; the vector still drives it.
  assert.equal(typeof value.emotion, 'string')
  assert.equal(value.expressionSource, 'none', 'no binding exists in this fixture')

  const stream = new FakeResponse()
  await harness.find('/dsh-live-tavern-lite/stage').handler(fakeRequest({ url: '/dsh-live-tavern-lite/stage' }), stream)
  const frame = JSON.parse(stream.text.slice(stream.text.indexOf('data: ') + 6).split('\n')[0])
  assert.ok(frame.params.ParamMouthForm > 0.6, `mouth ${frame.params.ParamMouthForm}`)
  assert.ok(frame.params.ParamAngleZ > 0, `head tilt ${frame.params.ParamAngleZ}`)

  harness.disposeAll()
})

test('parameter notes round-trip and are validated', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo' })
  const route = harness.find('/dsh-live-tavern-lite/params')

  const initial = JSON.parse((await call(route)).text)
  assert.deepEqual(initial.ids, ['ParamAngleX', 'ParamMouthForm', 'ParamHandWave'])
  assert.deepEqual(initial.notes, {})
  assert.equal(initial.rig.source, 'packaged')

  const saved = await call(route, {
    method: 'POST',
    body: JSON.stringify({
      params: {
        ParamMouthForm: { note: '嘴角，正=笑', verified: true },
        ParamHandWave: { note: '只在备注里', verified: false },
        ParamAngleX: { verified: false },
      },
    }),
  })
  assert.equal(saved.statusCode, 200)
  const onDisk = JSON.parse(await readFile(join(root, 'demo', 'params.json'), 'utf8'))
  // An empty note without a confirmation carries no information; drop it.
  assert.deepEqual(Object.keys(onDisk.params), ['ParamMouthForm', 'ParamHandWave'])
  assert.equal(onDisk.params.ParamMouthForm.note, '嘴角，正=笑')

  // A note survives a fresh activation.
  const second = fakeContext()
  apply(second.ctx, { modelsRoot: root, model: 'demo' })
  const reloaded = JSON.parse((await call(second.find('/dsh-live-tavern-lite/params'))).text)
  assert.equal(reloaded.notes.ParamMouthForm.verified, true)

  const bad = await call(route, { method: 'POST', body: JSON.stringify({ params: { 'bad id': { note: 'x' } } }) })
  assert.equal(bad.statusCode, 400)

  harness.disposeAll()
  second.disposeAll()
})

test('an absolute model or pack path names that folder', async () => {
  const root = await fixtureModels()
  const modelPath = join(root, 'demo')
  const packPath = join(root, 'packs', 'demo')
  const withPath = internals.resolveConfig({ model: modelPath, pack: packPath })
  // A model path names the folder itself: its parent is the models root, its last segment the id.
  assert.equal(withPath.modelsRoot, root)
  assert.equal(withPath.model, 'demo')
  assert.equal(withPath.modelRaw, modelPath)
  // A pack path names ONE folder; its parent is not a packs root, or every neighbour folder in
  // the download directory would be scanned as a character card.
  assert.equal(withPath.packPath, packPath)
  assert.equal(withPath.pack, 'demo')
  assert.notEqual(withPath.packsRoot, join(root, 'packs'))

  // A bare name keeps resolving against the default roots.
  const withName = internals.resolveConfig({ modelsRoot: root, model: 'demo' })
  assert.equal(withName.modelsRoot, root)
  assert.equal(withName.model, 'demo')
})

test('the directory route reports a missing picker instead of failing blind', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo' })
  const route = harness.find('/dsh-live-tavern-lite/directory')
  const refused = await call(route)
  assert.equal(refused.statusCode, 501)
  assert.match(refused.text, /目录选择服务/)
  harness.disposeAll()
})

test('generating a rig validates a real reply through normalizeRig', async () => {
  // A guard against the reply path shipping with a missing import: every symbol
  // the route uses must exist in the modules it imports.
  const source = await readFile(new URL('../lib/index.mjs', import.meta.url), 'utf8')
  const importLine = source.slice(source.indexOf("from './rig.mjs'") - 90, source.indexOf("from './rig.mjs'"))
  assert.match(importLine, /normalizeRig/)
  assert.match(importLine, /loadRig/)
  assert.match(importLine, /resolveRig/)
})

test('generating a rig refuses to run without confirmed notes', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo' })
  const route = harness.find('/dsh-live-tavern-lite/rig/generate')
  const refused = await call(route, { method: 'POST' })
  assert.equal(refused.statusCode, 400)
  assert.match(refused.text, /已确认/)

  // Updating needs a table to update; a model without one can only regenerate.
  const updating = await call(route, { method: 'POST', body: JSON.stringify({ mode: 'update' }) })
  assert.equal(updating.statusCode, 400)
  assert.match(updating.text, /还没有自己的映射表/)
  harness.disposeAll()
})

test('a reloaded stage resumes the most recent frame', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo', director: false })
  const tool = harness.tools.find(entry => entry.name === 'live2d_act')
  await tool.execute({ emotion: 'anger', line: '哼' }, { agent: { id: 's1' } })

  // A page reload opens a fresh wildcard stream; it must not start blank.
  const reloaded = new FakeResponse()
  await harness.find('/dsh-live-tavern-lite/stage').handler(fakeRequest({ url: '/dsh-live-tavern-lite/stage' }), reloaded)
  assert.match(reloaded.text, /event: stage/)
  const frame = JSON.parse(reloaded.text.slice(reloaded.text.indexOf('data: ') + 6).split('\n')[0])
  assert.equal(frame.emotion, 'anger')
  assert.equal(frame.line, '哼')
  harness.disposeAll()
})

test('the director drives the stage when the local model stayed silent', async () => {
  const root = await fixtureModels()
  const captured = []
  const harness = fakeContext({
    services: {
      llm: {
        stream(options) {
          captured.push(options)
          return (async function* reply() {
            yield { type: 'text-delta', index: 0, text: '```json\n{"emotion":"shy","line":"才、才没有"}\n```' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) },
    },
  })
  apply(harness.ctx, { modelsRoot: root, model: 'demo' })
  const stream = harness.find('/dsh-live-tavern-lite/stage')
  const browser = new FakeResponse()
  await stream.handler(fakeRequest({ url: '/dsh-live-tavern-lite/stage' }), browser)

  const session = { id: 's1', header: { id: 's1' } }
  const message = text => ({ data: { message: { content: [{ type: 'text', text }] } } })
  harness.emit('session/event', session, { type: 'user/message', ...message('你是不是喜欢我') })
  harness.emit('session/event', session, { type: 'assistant/message', ...message('别乱说') })
  harness.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  assert.ok(await waitFor(() => browser.text.includes('event: stage')), 'director frame arrived')
  const frame = JSON.parse(browser.text.slice(browser.text.indexOf('data: ') + 6).split('\n')[0])
  assert.equal(frame.source, 'director')
  assert.equal(frame.emotion, 'shy')
  assert.equal(frame.line, '才、才没有')

  assert.equal(captured.length, 1)
  assert.equal(captured[0].provider, 'deepseek')
  assert.match(captured[0].system, /只输出一个 JSON 对象/)
  // Both sides of the exchange reach the prompt the planner reads.
  assert.match(captured[0].messages[0].content[0].text, /你是不是喜欢我/)
  assert.match(captured[0].messages[0].content[0].text, /别乱说/)
  harness.disposeAll()
})

test('one control call can carry the memory too', async () => {
  const root = await fixtureModels()
  // The memory lands beside the pack, so this test needs its own home rather
  // than writing into the operator's character directory.
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-memhome-'))
  // A fresh sentence: the fallback memory directory is shared with earlier runs.
  const fact = `玩家喜欢在${Date.now()}这天晚上聊天`
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo', director: false })
  const tool = harness.tools.find(entry => entry.name === 'live2d_act')
  const answer = await tool.execute({
    emotion: 'joy',
    line: '嗯。',
    expression: 'smile',
    remember: { text: fact, kind: 'preference', importance: 3 },
  }, { agent: { id: 'm1' } })
  assert.equal(answer.ok, true)
  assert.equal(answer.remembered, true)

  // The same call wrote the fact, so a second tool round is unnecessary.
  const remember = harness.tools.find(entry => entry.name === 'live2d_remember')
  const stored = await remember.execute({ text: fact }, { agent: { id: 'm1' } })
  assert.equal(stored.stored, false, 'the fact is already there')
  assert.ok(stored.total >= 1)
  harness.disposeAll()
})

test('the per-turn setting is a floor: more updates are allowed', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo', director: false, stageUpdatesPerTurn: 2 })
  const tool = harness.tools.find(entry => entry.name === 'live2d_act')

  // The floor is 2, but a third and fourth update are still accepted.
  for (const emotion of ['joy', 'calm', 'sad', 'shy']) {
    const answer = await tool.execute({ emotion }, { agent: { id: 't1' } })
    assert.equal(answer.ok, true, `${emotion} should be accepted`)
  }

  // Only the runaway guard stops it, and it says so.
  let last
  for (let index = 0; index < 12; index += 1) {
    last = await tool.execute({ emotion: 'neutral' }, { agent: { id: 't1' } })
    if (!last.ok) break
  }
  assert.equal(last.ok, false)
  assert.match(last.hint, /保护上限/)
  harness.disposeAll()
})

test('the control tool refuses while the cross-session mode is on', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo' })
  const tool = harness.tools.find(entry => entry.name === 'live2d_act')
  const answer = await tool.execute({ emotion: 'joy' }, { agent: { id: 's1' } })
  // The stage belongs to the director in this mode; the session model is told so.
  assert.equal(answer.ok, false)
  assert.match(answer.hint, /跨会话模式/)
})

test('a local live2d_act wins the turn and the director stays out', async () => {
  const root = await fixtureModels()
  let calls = 0
  const harness = fakeContext({
    services: {
      llm: {
        stream() {
          calls += 1
          return (async function* reply() {
            yield { type: 'text-delta', index: 0, text: '{"emotion":"joy"}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) },
    },
  })
  apply(harness.ctx, { modelsRoot: root, model: 'demo', director: false })
  const session = { id: 's1', header: { id: 's1' } }
  harness.emit('session/event', session, {
    type: 'user/message',
    data: { message: { content: [{ type: 'text', text: '你好' }] } },
  })

  const tool = harness.tools.find(entry => entry.name === 'live2d_act')
  await tool.execute({ emotion: 'joy' }, { agent: { id: 's1' } })
  harness.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(calls, 0, 'the director must not spend tokens after path A spoke')
  harness.disposeAll()
})


test('director memory persists across plugin activations', async () => {
  // Memory is written beside the models root, so the fixture has to live inside
  // this run's own home — a shared temp directory would carry facts from earlier
  // runs into the assertions.
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-persist-'))
  process.env.DSH_HOME = home
  const fixture = await fixtureModels()
  const root = join(home, 'live2d', 'models')
  await mkdir(root, { recursive: true })
  await cp(join(fixture, 'demo'), join(root, 'demo'), { recursive: true })
  const prompts = []
  let reply = '{"emotion":"tender","remember":"玩家叫阿澈，喜欢被叫先生","affinity":0.6}'
  const services = () => ({
    llm: {
      stream(options) {
        prompts.push(options.messages[0].content[0].text)
        return (async function* answer() {
          yield { type: 'text-delta', index: 0, text: reply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) },
  })

  const first = fakeContext({ services: services() })
  apply(first.ctx, { modelsRoot: root, model: 'demo' })
  const session = { id: 's1', header: { id: 's1' } }
  first.emit('session/event', session, {
    type: 'user/message',
    data: { message: { content: [{ type: 'text', text: '叫我先生就好' }] } },
  })
  first.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.ok(await waitFor(() => prompts.length === 1))
  // Per-session memory: beside the model that owns the character, one file per session.
  const memoryFile = join(root, 'demo', 'memory', 's1.json')
  // The write is awaited inside the director, so the file appears shortly after
  // the reply; waiting for it keeps the read from racing the write.
  assert.ok(await waitFor(() => existsSync(memoryFile)), 'memory file written')
  first.disposeAll()

  const stored = JSON.parse(await readFile(memoryFile, 'utf8'))
  assert.equal(stored.facts.length, 1)
  assert.match(stored.facts[0].text, /阿澈/)
  assert.ok(stored.affinity > 0)

  // A fresh activation reads the same file: memory is durable, not in-process.
  const second = fakeContext({ services: services() })
  apply(second.ctx, { modelsRoot: root, model: 'demo' })
  second.emit('session/event', session, {
    type: 'user/message',
    data: { message: { content: [{ type: 'text', text: '今天有点累' }] } },
  })
  second.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.ok(await waitFor(() => prompts.length === 2))
  assert.match(prompts[1], /玩家叫阿澈/)
  reply = '{"emotion":"neutral"}'
  second.disposeAll()
})

test('a character pack contributes a card section and a per-agent world book', async () => {
  const root = await fixtureModels()
  const packsRoot = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-packs-'))
  await mkdir(join(packsRoot, 'demo'), { recursive: true })
  await writeFile(join(packsRoot, 'demo', 'card.json'), JSON.stringify({
    spec: 'chara_card_v2',
    data: { name: '艾莲', description: '鲨鱼妹，慢吞吞的。' },
  }))
  await writeFile(join(packsRoot, 'demo', 'worldbook.json'), JSON.stringify({
    entries: [
      { content: '她有一条鲨鱼尾巴。', keys: ['尾巴'] },
      { content: '常驻：基地位于海沟。', constant: true },
    ],
  }))

  const harness = fakeContext()
  // The card and the world book belong to the role-playing plane, which only
  // exists while cross-session mode is off.
  apply(harness.ctx, { modelsRoot: root, packsRoot, director: false })

  const card = harness.sections.find(entry => entry.name === 'live2d:card')
  assert.ok(card, 'card section registered')
  assert.match(card.text(), /## 角色：艾莲/)
  // User-authored card text must never be treated as a prompt template.
  assert.equal(card.interpolate, false)

  const scoped = []
  const agentCtx = {
    systemPrompt: {
      section(section) {
        scoped.push(section)
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  harness.emit('agent/created', { agent: { id: 's1', ctx: agentCtx } })
  const worldbook = scoped.find(entry => entry.name === 'live2d:worldbook')
  assert.ok(worldbook, 'world book section registered per agent')
  assert.equal(worldbook.interpolate, false)
  assert.match(worldbook.text(), /常驻：基地位于海沟/, 'constant entries always apply')
  assert.doesNotMatch(worldbook.text(), /鲨鱼尾巴/, 'keyword entries wait for the conversation')

  harness.emit('session/event', { id: 's1', header: { id: 's1' } }, {
    type: 'user/message',
    data: { message: { content: [{ type: 'text', text: '你的尾巴在动' }] } },
  })
  assert.match(worldbook.text(), /鲨鱼尾巴/)
  harness.disposeAll()
})

test('cross-session mode keeps the card and the world book out of the session prompt', async () => {
  const root = await fixtureModels()
  const packsRoot = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-packs-'))
  await mkdir(join(packsRoot, 'demo'), { recursive: true })
  await writeFile(join(packsRoot, 'demo', 'card.json'), JSON.stringify({
    spec: 'chara_card_v2',
    data: { name: '艾莲', description: '鲨鱼妹。' },
  }))
  await writeFile(join(packsRoot, 'demo', 'worldbook.json'), JSON.stringify({
    entries: [{ content: '常驻：基地位于海沟。', constant: true }],
  }))

  const harness = fakeContext()
  // director defaults to on, so the role-playing plane is silent.
  apply(harness.ctx, { modelsRoot: root, packsRoot })
  const card = harness.sections.find(entry => entry.name === 'live2d:card')
  assert.equal(card.text(), '', 'no character card while cross-session mode is on')

  const scoped = []
  const agentCtx = {
    systemPrompt: {
      section(section) {
        scoped.push(section)
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  harness.emit('agent/created', { agent: { id: 's1', ctx: agentCtx } })
  const worldbook = scoped.find(entry => entry.name === 'live2d:worldbook')
  assert.equal(worldbook.text(), '', 'no world book while cross-session mode is on')
  harness.disposeAll()
})

test('settings round-trip through the file and layer over the row', async () => {
  const previousHome = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-settings-'))
  process.env.DSH_HOME = home
  try {
    const harness = fakeContext()
    apply(harness.ctx, { placement: 'chat' })
    const route = harness.find('/dsh-live-tavern-lite/settings')

    const initial = JSON.parse((await call(route)).text)
    assert.ok(initial.fields.length >= 10, 'every tunable is described')
    assert.equal(initial.values.placement, 'chat')
    assert.equal(initial.values.director, true)
    // Every resettable field ships the built-in value behind its ↺ button.
    assert.equal(initial.defaults.placement, 'chat')
    assert.equal(initial.defaults.worldbookBudgetTokens, 8192)
    assert.equal(initial.defaults.worldbookScanDepth, 8)

    const saved = await call(route, {
      method: 'POST',
      body: JSON.stringify({ placement: 'sidebar', opacity: 0.8, director: false }),
    })
    assert.equal(saved.statusCode, 200)
    const onDisk = JSON.parse(await readFile(join(home, 'live2d', 'settings.json'), 'utf8'))
    assert.equal(onDisk.placement, 'sidebar')
    assert.equal(onDisk.opacity, 0.8)

    // A fresh activation layers the stored values over the Cordis row.
    const second = fakeContext()
    apply(second.ctx, { placement: 'chat' })
    const config = JSON.parse((await call(second.find('/dsh-live-tavern-lite/config'))).text)
    assert.deepEqual(config.placement, ['sidebar'])
    assert.equal(config.opacity, 0.8)

    // Unknown keys and out-of-range values are refused, never stored.
    const unknown = await call(route, { method: 'POST', body: JSON.stringify({ nope: 1 }) })
    assert.equal(unknown.statusCode, 400)
    const badSwitch = await call(route, { method: 'POST', body: JSON.stringify({ director: 'sometimes' }) })
    assert.equal(badSwitch.statusCode, 400)
    const badType = await call(route, { method: 'POST', body: JSON.stringify({ opacity: 'big' }) })
    assert.equal(badType.statusCode, 400)

    harness.disposeAll()
    second.disposeAll()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('every settings field carries a value the form can read', async () => {
  const harness = fakeContext()
  apply(harness.ctx, { modelsDir: undefined })
  const response = await call(harness.find('/dsh-live-tavern-lite/settings'))
  const payload = JSON.parse(response.text)
  // A field with no value renders empty and then looks unsaved on reopen.
  const missing = payload.fields.filter(field => !(field.key in payload.values)).map(field => field.key)
  assert.deepEqual(missing, [], `fields without a value: ${missing.join(', ')}`)
  harness.disposeAll()
})

test('a pack chosen by absolute path serves its own rig table', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-rigpath-'))
  process.env.DSH_HOME = home
  // The pack lives outside both configured roots, exactly like /sdcard/Download/ailian.
  const pack = join(home, 'Download', 'ailian')
  await mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'ailian.model3.json'), JSON.stringify({ FileReferences: { Moc: 'a.moc3' } }))
  // A pinned parameter the packaged table does not know: the marker that the file was found.
  await writeFile(join(pack, 'rig.json'), JSON.stringify({
    id: 'ailian',
    params: [
      { id: 'Paramheadxy', base: 30, min: 0, max: 30, fixed: true, note: '水印恒取最大值' },
      { id: 'ParamMouthForm', base: 0, min: -1, max: 1, weights: { valence: 0.6, arousal: 0, dominance: 0 } },
    ],
  }))

  const harness = fakeContext()
  apply(harness.ctx, { pack: pack, packsRoot: join(home, 'live2d', 'packs'), modelsRoot: join(home, 'live2d', 'models') })
  const config = JSON.parse((await call(harness.find('/dsh-live-tavern-lite/config'))).text)
  assert.equal(config.selected.id, 'ailian')
  assert.equal(config.rig.source, 'model', 'the pack rig must be used, not the packaged fallback')
  assert.equal(config.rig.params.length, 2)
  assert.equal(config.rig.params[0].id, 'Paramheadxy')

  harness.disposeAll()
})

test('a stray space in the pack path does not hide the model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-space-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'ailian')
  await mkdir(join(pack, 'model'), { recursive: true })
  await writeFile(join(pack, 'model', 'ailian.model3.json'), JSON.stringify({ FileReferences: { Moc: 'a.moc3' } }))
  // The folder chooser on the phone handed back a trailing space; the id must still resolve.
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: `${pack} ` }))

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: join(home, 'live2d', 'packs'), modelsRoot: join(home, 'live2d', 'models') })
  const config = JSON.parse((await call(harness.find('/dsh-live-tavern-lite/config'))).text)
  assert.equal(config.selected.id, 'ailian')
  assert.equal(config.packProblem, null)

  harness.disposeAll()
})

test('a pack folder without a model is reported, not loaded', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-nomodel-'))
  process.env.DSH_HOME = home
  const packs = join(home, 'live2d', 'packs')
  // A folder that exists but holds no model file: the classic "picked the wrong folder" case.
  const wrong = join(packs, 'wrong')
  await mkdir(wrong, { recursive: true })
  await writeFile(join(wrong, 'card.json'), JSON.stringify({ spec: 'chara_card_v2', data: { name: '空包' } }))
  const good = join(packs, 'good')
  await mkdir(join(good, 'model'), { recursive: true })
  await writeFile(join(good, 'model', 'good.model3.json'), JSON.stringify({ FileReferences: { Moc: 'good.moc3' } }))

  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'wrong' }))
  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: packs, modelsRoot: join(home, 'live2d', 'models') })
  const config = JSON.parse((await call(harness.find('/dsh-live-tavern-lite/config'))).text)
  assert.equal(config.selected, null, 'a folder without a model must not be loaded')
  assert.equal(config.stageKind, null)
  assert.equal(config.packProblem.state, 'no-model')
  assert.match(config.packProblem.hint, /没有模型文件/)

  // A missing folder is its own reason.
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'ghost' }))
  const second = fakeContext()
  apply(second.ctx, { packsRoot: packs, modelsRoot: join(home, 'live2d', 'models') })
  const ghost = JSON.parse((await call(second.find('/dsh-live-tavern-lite/config'))).text)
  assert.equal(ghost.selected, null)
  assert.equal(ghost.packProblem.state, 'missing')

  // The folder that does hold a model still works.
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'good' }))
  const third = fakeContext()
  apply(third.ctx, { packsRoot: packs, modelsRoot: join(home, 'live2d', 'models') })
  const ok = JSON.parse((await call(third.find('/dsh-live-tavern-lite/config'))).text)
  assert.equal(ok.selected.id, 'good')
  assert.equal(ok.packProblem, null)

  harness.disposeAll()
  second.disposeAll()
  third.disposeAll()
})

test('the browser route lists folders and flags the ones holding a model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-browse-'))
  process.env.DSH_HOME = home
  const packs = join(home, 'live2d', 'packs')
  const withModel = join(packs, 'ailian')
  await mkdir(join(withModel, 'model'), { recursive: true })
  await writeFile(join(withModel, 'model', 'ailian.model3.json'), JSON.stringify({ FileReferences: { Moc: 'a.moc3' } }))
  await mkdir(join(packs, 'empty'), { recursive: true })
  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: packs, modelsRoot: join(home, 'live2d', 'models') })

  const browse = harness.find('/dsh-live-tavern-lite/browse')
  assert.ok(browse !== undefined, 'the browser route is registered')
  const root = JSON.parse((await call(browse, { url: `/dsh-live-tavern-lite/browse?path=${encodeURIComponent(packs)}` })).text)
  const names = root.entries.map(entry => entry.name)
  assert.deepEqual(names, ['ailian', 'empty'], 'model folders sort first, then by name')
  assert.equal(root.entries[0].hasModel, true)
  assert.equal(root.entries[1].hasModel, false)
  assert.equal(root.self.hasModel, false)

  // Descending into the pack finds the model.
  const pack = JSON.parse((await call(browse, { url: `/dsh-live-tavern-lite/browse?path=${encodeURIComponent(withModel)}` })).text)
  assert.equal(pack.self.hasModel, true)
  assert.match(pack.self.entryFile, /model3\.json$/)

  // Outside the configured roots is refused.
  const outside = await call(browse, { url: '/dsh-live-tavern-lite/browse?path=C%3A%5CWindows' })
  assert.equal(outside.statusCode, 403)

  harness.disposeAll()
})

test('an empty pack path means no model, and the plugin stays idle', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-idle-'))
  process.env.DSH_HOME = home
  // A model is discoverable, but nothing selects it: the stage must not adopt it silently.
  const model = join(home, 'live2d', 'models', 'demo')
  await mkdir(model, { recursive: true })
  await writeFile(join(model, 'demo.model3.json'), JSON.stringify({ FileReferences: { Moc: 'demo.moc3' } }))

  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: join(home, 'live2d', 'models') })
  const config = JSON.parse((await call(harness.find('/dsh-live-tavern-lite/config'))).text)
  assert.equal(config.selected, null, 'no pack path selects nothing')
  assert.equal(config.stageKind, null)
  assert.deepEqual(config.models.map(entry => entry.id), ['demo'], 'the model list still enumerates')

  // Tools answer without pretending a model exists.
  const act = harness.tools.find(tool => tool.name === 'live2d_act')
  const answer = await act.execute({ emotion: 'joy' }, {})
  assert.equal(answer.ok, false)

  harness.disposeAll()
})

test('the mobile runtime keeps two seats and no workbench', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-mobile-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'live')
  await mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'live.model3.json'), JSON.stringify({ FileReferences: { Moc: 'live.moc3' } }))
  // Sidebar is still requested in the stored settings: the mobile runtime ignores it.
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'live', placement: ['sidebar', 'chat'] }))

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: join(home, 'live2d', 'packs'), modelsRoot: join(home, 'live2d', 'models'), mobileUi: 'on' })

  const config = JSON.parse((await call(harness.find('/dsh-live-tavern-lite/config'))).text)
  assert.deepEqual(config.placement, ['chat'], 'sidebar is dropped, and a resolved seat remains')
  assert.equal(config.capabilities.workbench, false)
  assert.deepEqual(config.capabilities.placements, ['chat'])

  const settings = JSON.parse((await call(harness.find('/dsh-live-tavern-lite/settings'))).text)
  const placement = settings.fields.find(field => field.key === 'placement')
  assert.ok(placement !== undefined)
  assert.deepEqual(placement.options, ['chat', 'foreground'])

  // The workbench routes are not part of the mobile surface.
  const params = await call(harness.find('/dsh-live-tavern-lite/params'))
  assert.equal(params.statusCode, 404)
  const rig = await call(harness.find('/dsh-live-tavern-lite/rig/generate'), { method: 'POST' })
  assert.equal(rig.statusCode, 404)

  harness.disposeAll()
})

test('resolvePlacement refuses sidebar on the mobile runtime', () => {
  assert.deepEqual(internals.resolvePlacement('chat,foreground', true), ['chat', 'foreground'])
  // A desktop profile that asked for a sidebar still boots on a phone: the seat is dropped.
  assert.deepEqual(internals.resolvePlacement('sidebar', true), ['chat'])
  assert.deepEqual(internals.resolvePlacement('sidebar,foreground', true), ['foreground'])
  assert.deepEqual(internals.resolvePlacement('sidebar', false), ['sidebar'])
  assert.throws(() => internals.resolvePlacement('foo', true), /placement entries must be one of/)
})

test('a runtime without the 3D stage offers no VRM at all', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-no3d-'))
  process.env.DSH_HOME = home
  const packs = join(home, 'live2d', 'packs')

  const live = join(packs, 'live')
  await mkdir(live, { recursive: true })
  await writeFile(join(live, 'live.model3.json'), JSON.stringify({ FileReferences: { Moc: 'live.moc3' } }))

  const three = join(packs, 'three')
  await mkdir(three, { recursive: true })
  await writeFile(join(three, 'three.vrm'), Buffer.from('glTF'))
  // The stale selection points at the VRM pack, exactly like an install that upgraded to a phone.
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'three' }))

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: packs, modelsRoot: join(home, 'live2d', 'models'), vrmStage: 'off' })

  const config = JSON.parse((await call(harness.find('/dsh-live-tavern-lite/config'))).text)
  assert.equal(config.vrmSupported, false)
  assert.deepEqual(config.models.map(model => model.id), ['live'], 'the VRM pack must not be offered')
  assert.equal(config.stageKind, 'live2d', 'the stage falls back instead of failing to boot')
  assert.equal(config.vrmDropped, 'three', 'the dropped pack is reported, not silently forgotten')

  // The prompt must not teach a 3D gesture vocabulary the stage cannot perform.
  const section = harness.sections.find(entry => entry.name === 'tool:live2d')
  const promptText = typeof section.text === 'function' ? section.text({}) : section.text
  assert.doesNotMatch(promptText, /double_yeah/)
  assert.match(promptText, /live2d_act/)

  // And a 3D recipe id is not resolved even when the model asks for it by name.
  const tool = harness.tools.find(entry => entry.name === 'live2d_act')
  const answer = await tool.execute({ recipe: 'nod' }, {})
  assert.equal(answer.recipe, undefined, 'a VRM recipe must not apply here')

  harness.disposeAll()
})

test('VRM-only settings are hidden while a Live2D model is mounted', async () => {
  const vrmOnly = ['springGravity', 'springStrength']

  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-kinds-'))
  process.env.DSH_HOME = home
  const packs = join(home, 'live2d', 'packs')

  // A Live2D pack: a model settings file is what makes one.
  const live = join(packs, 'live')
  await mkdir(live, { recursive: true })
  await writeFile(join(live, 'live.model3.json'), JSON.stringify({ FileReferences: { Moc: 'live.moc3' } }))

  const threeD = join(packs, 'three')
  await mkdir(threeD, { recursive: true })
  await writeFile(join(threeD, 'three.vrm'), Buffer.from('glTF'))

  // The pack path is what selects a model, so the settings file has to exist before apply.
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'live' }))
  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: packs, modelsRoot: join(home, 'live2d', 'models') })
  const asLive2d = JSON.parse((await call(harness.find('/dsh-live-tavern-lite/settings'))).text)
  assert.equal(asLive2d.stageKind, 'live2d')
  for (const key of vrmOnly) {
    assert.ok(!asLive2d.fields.some(field => field.key === key), `${key} must not show for a Live2D model`)
  }

  // Switching the pack to a VRM brings them back.
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'three' }))
  const fresh = fakeContext()
  apply(fresh.ctx, { packsRoot: packs, modelsRoot: join(home, 'live2d', 'models') })
  const asVrm = JSON.parse((await call(fresh.find('/dsh-live-tavern-lite/settings'))).text)
  assert.equal(asVrm.stageKind, 'vrm')
  for (const key of vrmOnly) {
    assert.ok(asVrm.fields.some(field => field.key === key), `${key} must show for a VRM model`)
  }

  harness.disposeAll()
  fresh.disposeAll()
})

test('every settings field ships a reset default, mirrored by the client fallback', async () => {
  const defaults = internals.resolveConfig({}).defaults
  for (const field of internals.settingsFields) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(defaults, field.key),
      `no built-in default for '${field.key}'`,
    )
  }
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('const FALLBACK_DEFAULTS'))
  const keys = [...block.slice(0, block.indexOf('}')).matchAll(/^\s{2}(\w+):/gm)].map(match => match[1])
  assert.deepEqual([...keys].sort(), internals.settingsFields.map(field => field.key).sort())
})

test('prompt section teaches the tool and the prototype vocabulary', async () => {
  const root = await fixtureModels()
  const harness = fakeContext()
  apply(harness.ctx, { modelsRoot: root, model: 'demo' })
  const section = harness.sections.find(entry => entry.name === 'tool:live2d')
  assert.ok(section, 'prompt section registered')
  assert.equal(section.order, 2410)
  // A literal section may compute its text; that is how the channel notes stay
  // current. An interpolated one must ship a string (see prompt-section.test).
  assert.equal(section.interpolate, false)
  const text = typeof section.text === 'function' ? section.text({}) : section.text
  assert.match(text, /live2d_act/)
  assert.match(text, /joy\(开心\)/)
  assert.match(text, /只在情绪真的变化时调用/)
  assert.match(text, /animation/)
  assert.match(text, /ParamAngleX/, 'the rig parameter ids are listed')
  harness.disposeAll()
})

test('a table cut off mid-object keeps the entries that closed', () => {
  const full = '{"version":2,"params":[' 
    + '{"id":"ParamAngleX","base":0,"min":-30,"max":30,"weights":{"valence":0,"arousal":0,"dominance":0}},'
    + '{"id":"ParamAngleY","base":0,"min":-30,"max":30,"weights":{"valence":0.1,"arousal":0.2,"dominance":0.3}},'
    + '{"id":"ParamAngleZ","base":0,"min":-30,"max":30,"weights":{"valence":0.35,"arou'
  const salvaged = internals.parseRigReply(full)
  assert.equal(salvaged.salvaged, true)
  assert.equal(salvaged.kept, 2)
  assert.equal(salvaged.value.params.length, 2)
  // Real truncation still normalizes into a usable table.
  assert.equal(internals.parseRigReply(full).value.version, 2)

  // A complete reply parses without salvage.
  const whole = '{"version":2,"params":[{"id":"ParamAngleX","base":0,"min":-30,"max":30,'
    + '"weights":{"valence":0,"arousal":0,"dominance":0}}]}'
  const parsed = internals.parseRigReply(whole)
  assert.equal(parsed.salvaged, false)
  assert.equal(parsed.value.params.length, 1)

  // Prose around the JSON is ignored.
  assert.equal(internals.parseRigReply('好的，表如下：\n' + whole).value.params.length, 1)
})

test('parameter notes are read on demand, not injected every turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-params-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'whale')
  await mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'whale.vrm'), Buffer.from('glTF'))
  await writeFile(join(pack, 'params.json'), JSON.stringify({
    version: 1,
    params: { BoneHeadZ: { note: '歪头方向，正数向左', verified: true } },
  }))
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'whale', director: false }))

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: join(home, 'live2d', 'packs'), modelsRoot: join(home, 'live2d', 'models') })
  const tool = harness.tools.find(entry => entry.name === 'live2d_params')
  assert.ok(tool !== undefined, 'the parameter tool must register')

  // The prompt names the ids and points at the tool; it must not carry the notes.
  const section = harness.sections.find(entry => entry.name === 'tool:live2d')
  const text = typeof section.text === 'function' ? section.text({}) : section.text
  assert.match(text, /live2d_params/)
  assert.doesNotMatch(text, /歪头方向/)

  // Reading them returns the note, its confirmation and the channel's range.
  const answer = await tool.execute({}, {})
  assert.equal(answer.ok, true)
  assert.equal(answer.kind, 'vrm')
  assert.equal(answer.idCount, 11)
  const channel = answer.params.find(entry => entry.id === 'BoneHeadZ')
  assert.equal(channel.note, '歪头方向，正数向左')
  assert.equal(channel.verified, true)
  assert.equal(channel.min, -45)

  // A filter searches notes as well as ids.
  const filtered = await tool.execute({ filter: '歪头' }, {})
  assert.deepEqual(filtered.params.map(entry => entry.id), ['BoneHeadZ'])
})

test('the default pose is saved in the pack and refused when unknown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-defaults-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'whale')
  await mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'whale.model3.json'), JSON.stringify({ FileReferences: { Moc: 'whale.moc3' } }))
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'whale', director: false }))

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: join(home, 'live2d', 'packs'), modelsRoot: join(home, 'live2d', 'models') })
  const route = harness.routes.find(entry => entry.path.endsWith('/defaults'))
  assert.ok(route !== undefined)

  const saved = await call(route, { method: 'POST', body: JSON.stringify({ expression: '', emotion: 'joy' }) })
  assert.equal(saved.statusCode, 200)
  assert.equal(JSON.parse(saved.text).defaults.emotion, 'joy')
  const stored = JSON.parse(await readFile(join(pack, 'defaults.json'), 'utf8'))
  assert.equal(stored.emotion, 'joy')

  // The frame the browser previews comes from the Host, so the mapping lives in one place.
  const preview = harness.routes.find(entry => entry.path.endsWith('/stage/preview'))
  const frame = await call(preview, { url: `${preview.path}?emotion=joy` })
  assert.equal(frame.statusCode, 200)
  assert.equal(JSON.parse(frame.text).emotion, 'joy')

  // The saved pose reaches the browser through `/config`.
  const config = await call(harness.routes.find(entry => entry.path.endsWith('/config')))
  assert.equal(JSON.parse(config.text).defaults.emotion, 'joy')

  const refused = await call(route, { method: 'POST', body: JSON.stringify({ emotion: 'nope' }) })
  assert.equal(refused.statusCode, 400)
})

test('an empty note save cannot wipe a file it was not based on', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-notes-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'whale')
  await mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'whale.vrm'), Buffer.from('glTF'))
  await writeFile(join(pack, 'params.json'), JSON.stringify({
    version: 1,
    params: { BoneHeadZ: { note: '歪头' }, BoneHeadX: { note: '点头' } },
  }))
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'whale', director: false }))

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: join(home, 'live2d', 'packs'), modelsRoot: join(home, 'live2d', 'models') })
  const route = harness.routes.find(entry => entry.path.endsWith('/params'))

  // A stale panel (expected 0) must not clear two stored notes.
  const stale = await call(route, { method: 'POST', body: JSON.stringify({ params: {}, expected: 0 }) })
  assert.equal(stale.statusCode, 409)
  assert.equal(JSON.parse(await readFile(join(pack, 'params.json'), 'utf8')).params.BoneHeadZ.note, '歪头')

  // Clearing on purpose, from a panel that saw both, is allowed — and keeps a backup.
  const deliberate = await call(route, { method: 'POST', body: JSON.stringify({ params: {}, expected: 2 }) })
  assert.equal(deliberate.statusCode, 200)
  const backup = JSON.parse(await readFile(join(pack, 'params.json.bak'), 'utf8'))
  assert.equal(Object.keys(backup.params).length, 2)
})

test('VRM bone channels ship a standard note, and a pack note wins', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-defaults-notes-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'whale')
  await mkdir(pack, { recursive: true })
  // A minimal VRM: a GLB whose JSON chunk declares two humanoid bones.
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    extensions: { VRM: { humanoid: { humanBones: [{ bone: 'head', node: 0 }, { bone: 'neck', node: 1 }] } } },
  }), 'utf8')
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const glb = Buffer.alloc(12 + 8 + padded.length)
  glb.write('glTF', 0, 'ascii')
  glb.writeUInt32LE(2, 4)
  glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(padded.length, 12)
  glb.write('JSON', 16, 'ascii')
  padded.copy(glb, 20)
  await writeFile(join(pack, 'whale.vrm'), glb)
  await writeFile(join(pack, 'params.json'), JSON.stringify({
    version: 1,
    params: { BoneHeadY: { note: '这台机器的头左右转', verified: true } },
  }))
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'whale', director: false }))

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: join(home, 'live2d', 'packs'), modelsRoot: join(home, 'live2d', 'models') })

  const params = JSON.parse((await call(harness.routes.find(entry => entry.path.endsWith('/params')))).text)
  // Six channels: two bones, three axes each.
  assert.equal(params.ids.length, 6)
  // The shipped notes describe the axes; the pack's own note is stored separately.
  // Each note states the zero state and both directions, so a model cannot misread a sign.
  assert.match(params.defaults.BoneHeadZ, /0=/)
  assert.match(params.defaults.BoneHeadZ, /歪头/)
  assert.equal(params.notes.BoneHeadY.note, '这台机器的头左右转')

  const tool = harness.tools.find(entry => entry.name === 'live2d_params')
  const answer = await tool.execute({}, {})
  const byId = Object.fromEntries(answer.params.map(entry => [entry.id, entry]))
  // A saved note beats the shipped one; an untouched channel reports its source.
  assert.equal(byId.BoneHeadY.note, '这台机器的头左右转')
  assert.match(byId.BoneHeadZ.note, /0=/)
  assert.equal(byId.BoneHeadZ.source, 'default')
})

test('a pose patch sets many channels at once and drops unknown ids', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-pose-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'whale')
  await mkdir(pack, { recursive: true })
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    extensions: { VRM: { humanoid: { humanBones: [{ bone: 'head', node: 0 }, { bone: 'spine', node: 1 }] } } },
  }), 'utf8')
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const glb = Buffer.alloc(12 + 8 + padded.length)
  glb.write('glTF', 0, 'ascii')
  glb.writeUInt32LE(2, 4)
  glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(padded.length, 12)
  glb.write('JSON', 16, 'ascii')
  padded.copy(glb, 20)
  await writeFile(join(pack, 'whale.vrm'), glb)
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'whale', director: false }))

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: join(home, 'live2d', 'packs'), modelsRoot: join(home, 'live2d', 'models') })
  const act = harness.tools.find(entry => entry.name === 'live2d_act')
  const frame = await act.execute({
    emotion: 'joy',
    params: { BoneHeadZ: 12.5, BoneSpineX: -4, 'NotAChannel': 9 },
    easeMs: 900,
  }, { agent: { id: 's1' } })

  assert.equal(frame.ok, true)
  assert.equal(frame.params.BoneHeadZ, 12.5)
  assert.equal(frame.params.BoneSpineX, -4)
  // An id the model does not declare is dropped instead of failing the call.
  assert.equal(frame.params.NotAChannel, undefined)
  assert.equal(frame.easeMs, 900)
})

test('a named recipe becomes bone values, and a patch can refine it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-recipe-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'whale')
  await mkdir(pack, { recursive: true })
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    extensions: { VRM: { humanoid: { humanBones: [
      { bone: 'head', node: 0 }, { bone: 'neck', node: 1 }, { bone: 'spine', node: 2 }, { bone: 'leftUpperArm', node: 3 },
    ] } } },
  }), 'utf8')
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const glb = Buffer.alloc(12 + 8 + padded.length)
  glb.write('glTF', 0, 'ascii')
  glb.writeUInt32LE(2, 4)
  glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(padded.length, 12)
  glb.write('JSON', 16, 'ascii')
  padded.copy(glb, 20)
  await writeFile(join(pack, 'whale.vrm'), glb)
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'whale', director: false }))

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: join(home, 'live2d', 'packs'), modelsRoot: join(home, 'live2d', 'models') })
  const act = harness.tools.find(entry => entry.name === 'live2d_act')
  const params = harness.tools.find(entry => entry.name === 'live2d_params')

  // A recipe carries the meaning; the model only names the intent.
  const bow = await act.execute({ emotion: 'tender', recipe: 'bow' }, { agent: { id: 'r1' } })
  assert.equal(bow.recipe, 'bow')
  // Negative X leans forward on the normalised humanoid; positive would be a lean back.
  assert.ok(bow.params.BoneSpineX < 0)
  assert.equal(bow.easeMs, 700)

  // A nod is a sequence, so it arrives as animation instead of a still pose.
  const nod = await act.execute({ emotion: 'joy', recipe: 'nod' }, { agent: { id: 'r2' } })
  assert.match(nod.animation, /BoneHeadX/)

  // A patch on top of a recipe wins for the same channel.
  const refined = await act.execute({ emotion: 'joy', recipe: 'tilt', params: { BoneHeadZ: 30 } }, { agent: { id: 'r3' } })
  assert.equal(refined.params.BoneHeadZ, 30)

  // The base pose puts the arms down; without it every recipe keeps the T-pose.
  assert.ok(bow.params.BoneLeftUpperArmZ > 0, 'base pose should lower the left arm')
  assert.ok(bow.params.BoneRightUpperArmZ < 0, 'base pose should lower the right arm')

  // Channels can be read one body part at a time instead of all at once.
  const head = await params.execute({ group: 'head' }, {})
  assert.deepEqual(head.params.map(entry => entry.id).sort(), ['BoneHeadX', 'BoneHeadY', 'BoneHeadZ', 'BoneNeckX', 'BoneNeckY', 'BoneNeckZ'])
  assert.ok(head.params.every(entry => entry.group === 'head'))
})
