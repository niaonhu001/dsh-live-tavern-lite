/** Song production: the tool contract, job registry and the audio route guards. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, internals } from '../lib/index.mjs'

const { resolveConfig } = internals

/** A pack with a Live2D model, so the stage has a selection. */
async function packFixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-song-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'sherry')
  await mkdir(join(pack, 'model'), { recursive: true })
  await writeFile(join(pack, 'model', 'a.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: { Moc: 'a.moc3', Textures: [] },
  }))
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
    async *[Symbol.asyncIterator]() {
      if (body === undefined) return
      yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
  await route.handler(req, res)
  return { status: res.statusCode, text: res.text }
}

test('the song tool refuses a request without lyrics or a source', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, songEnabled: true })
  const tool = harness.tools.find(entry => entry.name === 'live2d_sing')
  assert.ok(tool !== undefined, 'live2d_sing is registered')

  const noLyrics = await tool.execute({ mode: 'sing' }, { agent: { id: 's1' } })
  assert.equal(noLyrics.ok, false)
  assert.match(noLyrics.error, /歌词/)

  const noSource = await tool.execute({ mode: 'cover', src: 'D:/nope/missing.wav' }, { agent: { id: 's1' } })
  assert.equal(noSource.ok, false)
  assert.match(noSource.error, /翻唱/)

  const unknown = await tool.execute({ jobId: 'song-nope' }, { agent: { id: 's1' } })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /没有这个任务/)
})

test('the song switch can be turned off, and the routes say so', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, songEnabled: false })
  const startRoute = harness.routes.find(entry => entry.path.endsWith('/song/start'))
  const answer = await call(startRoute, { method: 'POST', body: { mode: 'sing', lyrics: '一句' } })
  assert.equal(answer.status, 400)
  assert.match(JSON.parse(answer.text).error, /没有打开/)
})

test('the audio route refuses a job that has not produced anything yet', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, songEnabled: true })
  const audioRoute = harness.routes.find(entry => entry.path.endsWith('/song/audio'))
  const answer = await call(audioRoute, { url: `${audioRoute.path}?id=song-missing` })
  assert.equal(answer.status, 404)
  assert.match(JSON.parse(answer.text).error, /还没有成品/)
})

test('song paths resolve from defaults and accept overrides', async () => {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-song-cfg-'))
  const defaults = resolveConfig({}).song
  assert.equal(defaults.enabled, true)
  assert.match(defaults.yuE2Url, /^http/)
  assert.match(defaults.voiceModel, /\.pt$/)
  assert.match(defaults.pipelineDir, /dsh-cover-pipeline$/)
  const asked = resolveConfig({ songYuE2Url: 'http://127.0.0.1:9999', songWorkRoot: 'D:/work' }).song
  assert.equal(asked.yuE2Url, 'http://127.0.0.1:9999')
  assert.equal(asked.workRoot, 'D:/work')
})
