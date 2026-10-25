/** Tests for the unified character-pack layout. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, internals } from '../lib/index.mjs'

/** A pack with its model nested under `model/`, and no card at all. */
async function unifiedPack() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-pack-'))
  // Isolate from the operator's own settings.json, which pins real folders.
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  process.env.DSH_HOME = home
  const packsRoot = join(root, 'packs')
  const pack = join(packsRoot, 'ailian')
  await mkdir(join(pack, 'model', 'tex'), { recursive: true })
  await writeFile(join(pack, 'model', 'ailian.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: 'ailian.moc3',
      Textures: ['tex/0.png'],
      Expressions: [{ Name: 'smile', File: 'smile.exp3.json' }],
      Motions: { '': [{ File: 'idle.motion3.json' }] },
      DisplayInfo: 'ailian.cdi3.json',
    },
  }))
  await writeFile(join(pack, 'model', 'ailian.moc3'), 'moc3')
  await writeFile(join(pack, 'model', 'ailian.cdi3.json'), JSON.stringify({ Parameters: [{ Id: 'ParamAngleX' }] }))
  await writeFile(join(pack, 'model', 'tex', '0.png'), 'png')
  return { root, packsRoot, pack, modelsRoot: join(root, 'models'), home }
}

function fakeContext() {
  const routes = []
  const tools = []
  const sections = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on() { return () => {} },
    inject(_names, fn) {
      const face = {
        tools: { register: definition => { tools.push(definition); return () => {} } },
        systemPrompt: {
          section(section) { sections.push(section); return () => {} },
          getSectionOrder() { return 100 },
        },
        on() { return () => {} },
        effect: ctx.effect,
      }
      fn(face)
      return () => {}
    },
    webServer: {
      register(route) { routes.push(route); return () => {} },
    },
    logger: { info() {}, warn() {} },
  }
  return { ctx, routes, tools, sections }
}

async function call(route) {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code; return this },
    write(chunk) { this.body += chunk; return true },
    end(chunk) { if (chunk !== undefined) this.body += chunk },
  }
  await route.handler({ method: 'GET', url: route.path, headers: {}, on() {}, once() {}, off() {} }, res)
  return { status: res.statusCode, text: res.body }
}

test('a pack holds its model, and everything else may be missing', async () => {
  const { packsRoot, modelsRoot } = await unifiedPack()
  const harness = fakeContext()
  // The pack path is what selects the model; an empty one means no stage at all.
  apply(harness.ctx, { packsRoot, modelsRoot, pack: 'ailian' })

  const config = harness.routes.find(route => route.path.endsWith('/config'))
  const answer = await call(config)
  assert.equal(answer.status, 200)
  const payload = JSON.parse(answer.text)
  assert.equal(payload.selected.id, 'ailian', 'the model is found inside the pack')
  assert.deepEqual(payload.selected.expressions, ['smile'])
  assert.equal(payload.pack, 'ailian')
  // No card and no world book, and that is not an error: the name falls back
  // to the pack id until a card exists.
  assert.equal(payload.character, 'ailian')
})

test('pack files sit beside the model, and legacy files still read', async () => {
  const { packsRoot, pack, modelsRoot } = await unifiedPack()
  await writeFile(join(pack, 'card.json'), JSON.stringify({ spec: 'chara_card_v2', data: { name: '艾莲' } }))
  await writeFile(join(pack, 'params.json'), JSON.stringify({ version: 1, params: { ParamAngleX: { note: '头左右', verified: true } } }))
  const harness = fakeContext()
  apply(harness.ctx, { packsRoot, modelsRoot, pack: 'ailian' })

  const params = harness.routes.find(route => route.path.endsWith('/params'))
  const answer = await call(params)
  assert.equal(answer.status, 200)
  const payload = JSON.parse(answer.text)
  assert.deepEqual(payload.ids, ['ParamAngleX'])
  assert.equal(payload.notes.ParamAngleX.note, '头左右')
  // The pack root is where the write path points.
  assert.equal(payload.file, join(pack, 'params.json'))
  assert.equal(existsSync(payload.file), true)
})

test('a broken rig table or pack does not take /config down', async () => {
  const { packsRoot, modelsRoot, pack } = await unifiedPack()
  await writeFile(join(pack, 'card.json'), JSON.stringify({ spec: 'chara_card_v2', data: { name: '艾莲' } }))
  // Half-written table: the stage must fall back to the packaged rig.
  await writeFile(join(pack, 'rig.json'), '{ not json')

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot, modelsRoot, pack: 'ailian' })
  const config = harness.routes.find(route => route.path.endsWith('/config'))
  const answer = await call(config)
  assert.equal(answer.status, 200)
  const payload = JSON.parse(answer.text)
  assert.equal(payload.selected.id, 'ailian')
  assert.equal(payload.rig.source, 'packaged')
  assert.equal(payload.error, undefined)
})

test('a missing configured pack still answers /config', async () => {
  const { packsRoot, modelsRoot } = await unifiedPack()
  const harness = fakeContext()
  // `pack` names a folder that is not there: the plugin stays mounted.
  apply(harness.ctx, { packsRoot, modelsRoot, pack: 'ghost' })
  const config = harness.routes.find(route => route.path.endsWith('/config'))
  const answer = await call(config)
  assert.equal(answer.status, 200)
  const payload = JSON.parse(answer.text)
  assert.ok(payload.selected !== undefined)
})

test('a pack that holds only a VRM is a character', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-vrm-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'whale')
  await mkdir(pack, { recursive: true })
  // One file at the pack root, no model/ directory, no model3.json.
  await writeFile(join(pack, 'whale.vrm'), Buffer.from('glTF'))
  await writeFile(join(pack, 'card.json'), JSON.stringify({ spec: 'chara_card_v2', data: { name: '小肥鱼' } }))

  const harness = fakeContext()
  apply(harness.ctx, { packsRoot: join(home, 'live2d', 'packs'), modelsRoot: join(home, 'live2d', 'models'), pack: 'whale' })
  const config = harness.routes.find(route => route.path.endsWith('/config'))
  const answer = await call(config)
  assert.equal(answer.status, 200)
  const payload = JSON.parse(answer.text)
  assert.equal(payload.stageKind, 'vrm')
  assert.equal(payload.selected.kind, 'vrm')
  assert.equal(payload.selected.entryFile, 'whale.vrm')
  // No Live2D rig applies to a 3D model.
  assert.deepEqual(payload.rig.params, [])
  assert.equal(payload.rig.source, 'none')
})
