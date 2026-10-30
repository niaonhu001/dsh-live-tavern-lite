/** Speech-bubble display settings: size, font size and background opacity. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, internals } from '../lib/index.mjs'

const { resolveConfig, settingsFields } = internals

const BUBBLE_KEYS = ['bubbleWidth', 'bubbleFontSize', 'bubbleOpacity']

/** A pack with a Live2D model, or a VRM one when `kind` says so. */
async function packFixture(kind = 'live2d') {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-bubble-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'sherry')
  await mkdir(join(pack, 'model'), { recursive: true })
  if (kind === 'vrm') {
    await writeFile(join(pack, 'sherry.vrm'), 'glTF')
  } else {
    await writeFile(join(pack, 'model', 'a.model3.json'), JSON.stringify({
      Version: 3,
      FileReferences: { Moc: 'a.moc3', Textures: [] },
    }))
  }
  return { home, pack }
}

function fakeContext() {
  const routes = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on() { return () => {} },
    inject(_names, fn) {
      fn({
        tools: { register: () => () => {} },
        systemPrompt: { section: () => () => {}, getSectionOrder: () => 100 },
        on: () => () => {},
        effect: ctx.effect,
      })
      return () => {}
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    logger: { info() {}, warn() {} },
  }
  return { ctx, routes }
}

async function call(route, { method = 'GET', body } = {}) {
  const res = {
    statusCode: 0,
    text: '',
    writeHead(code) { this.statusCode = code; return this },
    write(chunk) { this.text += String(chunk); return true },
    end(chunk) { if (chunk !== undefined) this.text += String(chunk) },
  }
  const req = {
    method,
    url: route.path,
    headers: {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
  }
  await route.handler(req, res)
  return { status: res.statusCode, text: res.text }
}

test('bubble values are clamped into a usable range', async () => {
  // `resolveConfig` layers the settings file over the row config, so the test
  // must read from a throwaway DSH_HOME instead of the developer's own settings.
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-bubble-home-'))
  const wide = resolveConfig({ bubbleWidth: 9999, bubbleFontSize: 2, bubbleOpacity: 5 })
  assert.equal(wide.bubbleWidth, 720)
  assert.equal(wide.bubbleFontSize, 11)
  assert.equal(wide.bubbleOpacity, 1)

  const narrow = resolveConfig({ bubbleWidth: 10, bubbleFontSize: 900, bubbleOpacity: -3 })
  assert.equal(narrow.bubbleWidth, 180)
  assert.equal(narrow.bubbleFontSize, 26)
  assert.equal(narrow.bubbleOpacity, 0.2)

  // Missing or unparsable entries keep today's look instead of failing the load.
  const bare = resolveConfig({})
  assert.equal(bare.bubbleWidth, 360)
  assert.equal(bare.bubbleFontSize, 13)
  assert.equal(bare.bubbleOpacity, 0.93)
  const junk = resolveConfig({ bubbleWidth: 'wide', bubbleFontSize: null, bubbleOpacity: '' })
  assert.equal(junk.bubbleWidth, 360)
  assert.equal(junk.bubbleFontSize, 13)
  assert.equal(junk.bubbleOpacity, 0.93)
})

test('the three bubble fields are offered on both stage kinds', async () => {
  for (const kind of ['live2d', 'vrm']) {
    await packFixture(kind)
    const harness = fakeContext()
    apply(harness.ctx, { pack: 'sherry', director: false })
    const route = harness.routes.find(entry => entry.path.endsWith('/settings'))
    const payload = JSON.parse((await call(route)).text)
    const keys = payload.fields.map(field => field.key)
    for (const key of BUBBLE_KEYS) {
      assert.ok(keys.includes(key), `${key} is offered for ${kind}`)
    }
    // A field with `kinds` would have hidden it on one of the two stages.
    for (const key of BUBBLE_KEYS) {
      const field = settingsFields.find(entry => entry.key === key)
      assert.equal(field.kinds, undefined, `${key} is not stage-specific`)
      // The form builds one titled block per `section`; the three bubble rows
      // must land there instead of being scattered through the main grid.
      assert.equal(field.section, 'bubble', `${key} is grouped under 气泡`)
      assert.equal(payload.fields.find(entry => entry.key === key).section, 'bubble', `${key} ships its section`)
    }
    for (const key of BUBBLE_KEYS) {
      assert.equal(typeof payload.values[key], 'number', `${key} has a value`)
    }
  }
})

test('every visible setting belongs to a collapsible section', async () => {
  const known = new Set(['stage', 'motion', 'bubble', 'voice', 'director', 'worldbook', 'rig'])
  for (const kind of ['live2d', 'vrm']) {
    await packFixture(kind)
    const harness = fakeContext()
    apply(harness.ctx, { pack: 'sherry', director: false })
    const route = harness.routes.find(entry => entry.path.endsWith('/settings'))
    const payload = JSON.parse((await call(route)).text)
    for (const field of payload.fields) {
      if (field.hidden === true) continue
      assert.ok(
        typeof field.section === 'string' && known.has(field.section),
        `${field.key} declares a section (${kind}): ${field.section}`,
      )
    }
    const sections = new Set(payload.fields.filter(field => field.hidden !== true).map(field => field.section))
    // 世界书的三个数字与跨会话那组都在，且各自成块。
    for (const id of ['stage', 'bubble', 'voice', 'director', 'worldbook']) {
      assert.ok(sections.has(id), `${id} has fields on ${kind}`)
    }
  }
})

test('a saved bubble size reaches /config and the browser-facing payload', async () => {
  await packFixture('vrm')
  const harness = fakeContext()
  apply(harness.ctx, { pack: 'sherry', director: false })
  const settings = harness.routes.find(entry => entry.path.endsWith('/settings'))
  const saved = await call(settings, {
    method: 'POST',
    body: JSON.stringify({ bubbleWidth: 520, bubbleFontSize: 18, bubbleOpacity: 0.4 }),
  })
  assert.equal(saved.status, 200)
  const config = harness.routes.find(entry => entry.path.endsWith('/config'))
  const payload = JSON.parse((await call(config)).text)
  assert.equal(payload.bubbleWidth, 520)
  assert.equal(payload.bubbleFontSize, 18)
  assert.equal(payload.bubbleOpacity, 0.4)
})
