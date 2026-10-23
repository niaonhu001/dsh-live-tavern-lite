/** Presets: user-named expressions that `live2d_act` can use as `emotion`. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, internals } from '../lib/index.mjs'

const { normalizePresets } = internals

/** A pack with one model that declares two expressions. */
async function packFixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-presets-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'ailian')
  await mkdir(join(pack, 'model'), { recursive: true })
  await writeFile(join(pack, 'model', 'ailian.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: 'a.moc3',
      Textures: ['t.png'],
      Expressions: [{ Name: 'smile', File: 's.exp3.json' }, { Name: 'pout', File: 'p.exp3.json' }],
    },
  }))
  await writeFile(join(pack, 'model', 'a.moc3'), 'moc')
  await writeFile(join(pack, 'model', 't.png'), 'png')
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

test('a preset id is validated, and the list stays bounded', () => {
  assert.deepEqual(normalizePresets(null).presets, [])
  const one = normalizePresets({ presets: [{ id: 'smirk', label: '坏笑', expression: 'smile', valence: 0.4, arousal: 0.2 }] })
  assert.equal(one.presets[0].id, 'smirk')
  assert.equal(one.presets[0].label, '坏笑')
  assert.equal(one.presets[0].valence, 0.4)
  // Missing label falls back to the id; out-of-range axes clamp.
  assert.equal(normalizePresets({ presets: [{ id: 'blank' }] }).presets[0].label, 'blank')
  assert.equal(normalizePresets({ presets: [{ id: 'x', valence: 9 }] }).presets[0].valence, 1)
  // Parameter values are kept, junk is dropped.
  const withParams = normalizePresets({ presets: [{ id: 'p', params: { ParamAngleZ: 12.345, 'bad id': 1, ParamMouthForm: 'nope' } }] })
  assert.deepEqual(withParams.presets[0].params, { ParamAngleZ: 12.345 })
  assert.throws(() => normalizePresets({ presets: [{ id: '1bad' }] }), /must start with a letter/)
  assert.throws(() => normalizePresets({ presets: [{ id: 'a' }, { id: 'a' }] }), /declared twice/)
})

test('a saved preset becomes a usable emotion id', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  // The control tool only speaks with the cross-session mode off.
  apply(harness.ctx, { director: false })
  const route = harness.routes.find(entry => entry.path.endsWith('/presets'))
  assert.ok(route !== undefined, 'the route is registered')

  const empty = JSON.parse((await call(route)).text)
  assert.deepEqual(empty.expressions, ['smile', 'pout'])

  const save = await call(route, {
    method: 'POST',
    body: JSON.stringify({
      version: 1,
      presets: [{
        id: 'smirk',
        label: '坏笑',
        expression: 'smile',
        valence: 0.5,
        arousal: 0.2,
        // Concrete values captured in the workbench, on and off the rig table.
        params: { ParamAngleZ: 12.5, ParamMouthForm: 0.8 },
      }],
    }),
  })
  assert.equal(save.status, 200)
  const written = JSON.parse(await readFile(join(pack, 'presets.json'), 'utf8'))
  assert.equal(written.presets[0].id, 'smirk')

  const act = harness.tools.find(tool => tool.name === 'live2d_act')
  const answer = await act.execute({ emotion: 'smirk' }, { agent: { id: 's1' } })
  assert.equal(answer.ok, true)
  // The preset's own label wins over the built-in neutral fallback.
  assert.equal(answer.label, '坏笑')
  // And its expression is applied through the generated binding.
  assert.equal(answer.expression, 'smile')
  // Its pinned parameter values reach the frame, on top of the emotion mapping.
  assert.equal(answer.params.ParamAngleZ, 12.5)
  assert.equal(answer.params.ParamMouthForm, 0.8)
})

test('a bad preset list is refused before anything is written', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, {})
  const route = harness.routes.find(entry => entry.path.endsWith('/presets'))
  const bad = await call(route, { method: 'POST', body: JSON.stringify({ presets: [{ id: '9nope' }] }) })
  assert.equal(bad.status, 400)
  await assert.rejects(() => readFile(join(pack, 'presets.json'), 'utf8'), /ENOENT/)
})

test('a custom preset is offered as a default pose and can be saved as one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-preset-default-'))
  const pack = join(home, 'live2d', 'packs', 'whale')
  await mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'whale.vrm'), Buffer.from('glTF'))
  await writeFile(join(pack, 'presets.json'), JSON.stringify({
    version: 1,
    presets: [{ id: 'Standing_wai', label: '歪头站着', params: { BoneHeadZ: 14 } }],
  }))
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'whale', director: false }))
  process.env.DSH_HOME = home

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: join(home, 'live2d', 'packs'), modelsRoot: join(home, 'live2d', 'models') })

  const params = harness.routes.find(entry => entry.path.endsWith('/params'))
  const listed = JSON.parse((await call(params)).text)
  assert.deepEqual(listed.presets, [{ id: 'Standing_wai', label: '歪头站着' }])

  const defaults = harness.routes.find(entry => entry.path.endsWith('/defaults'))
  const saved = await call(defaults, { method: 'POST', body: JSON.stringify({ expression: '', emotion: 'Standing_wai' }) })
  assert.equal(saved.status, 200)
  assert.equal(JSON.parse(saved.text).defaults.emotion, 'Standing_wai')

  // The preview frame carries the preset's own parameter values.
  const preview = harness.routes.find(entry => entry.path.endsWith('/stage/preview'))
  const frame = JSON.parse((await call(preview, { url: `${preview.path}?emotion=Standing_wai` })).text)
  assert.equal(frame.params.BoneHeadZ, 14)
})
