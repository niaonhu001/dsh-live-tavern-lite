/** Speech settings: the key the panel collects, and the shape the browser sees. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, internals } from '../lib/index.mjs'

const { resolveConfig } = internals

/** A pack with a Live2D model, so `/config` answers with a real selection. */
async function packFixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-tts-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'sherry')
  await mkdir(join(pack, 'model'), { recursive: true })
  await writeFile(join(pack, 'model', 'a.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: { Moc: 'a.moc3', Textures: [] },
  }))
  await writeFile(join(pack, 'model', 'a.moc3'), 'moc')
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

test('the key in the settings file wins over the environment, and both work', async () => {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-tts-home-'))
  const previous = process.env.DASHSCOPE_API_KEY
  try {
    delete process.env.DASHSCOPE_API_KEY
    const fromEnvMissing = resolveConfig({ ttsProvider: 'dashscope' })
    assert.equal(fromEnvMissing.tts.apiKey, '')
    assert.equal(fromEnvMissing.tts.keySource, '')

    process.env.DASHSCOPE_API_KEY = 'sk-from-env'
    const fromEnv = resolveConfig({ ttsProvider: 'dashscope' })
    assert.equal(fromEnv.tts.apiKey, 'sk-from-env')
    assert.equal(fromEnv.tts.keySource, 'env')
    // The form still shows the file's value, so an env key never gets copied into it.
    assert.equal(fromEnv.tts.apiKeySetting, '')

    const fromSettings = resolveConfig({ ttsProvider: 'dashscope', ttsApiKey: 'sk-typed' })
    assert.equal(fromSettings.tts.apiKey, 'sk-typed')
    assert.equal(fromSettings.tts.keySource, 'settings')
    assert.equal(fromSettings.tts.apiKeySetting, 'sk-typed')
  } finally {
    if (previous === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previous
  }
})

test('voice defaults and ranges are pinned', async () => {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-tts-home-'))
  const bare = resolveConfig({})
  assert.equal(bare.tts.provider, 'off')
  assert.equal(bare.tts.model, 'qwen-audio-3.1-tts-flash')
  assert.equal(bare.tts.voice, 'longanhuan_v3.1')
  assert.equal(bare.tts.rate, 1)
  assert.equal(bare.tts.pitch, 1)
  assert.equal(bare.tts.baseUrl, 'https://maas.qianwenaiapi.com')
  // Out-of-range numbers are clamped instead of failing the load.
  const loud = resolveConfig({ ttsRate: 9, ttsPitch: 0.1 })
  assert.equal(loud.tts.rate, 2)
  assert.equal(loud.tts.pitch, 0.5)
  assert.throws(() => resolveConfig({ ttsProvider: 'nope' }), /ttsProvider/)
})

test('the panel can save a key, and /config never echoes it back', async () => {
  const { pack, home } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack: 'sherry' })

  const settings = harness.routes.find(entry => entry.path.endsWith('/settings'))
  const initial = JSON.parse((await call(settings)).text)
  const keys = initial.fields.map(field => field.key)
  for (const key of ['ttsProvider', 'ttsApiKey', 'ttsModel', 'ttsVoice', 'ttsRate', 'ttsPitch', 'ttsInstruction']) {
    assert.ok(keys.includes(key), `${key} is offered`)
  }
  assert.equal(initial.fields.find(field => field.key === 'ttsApiKey').section, 'voice')

  const saved = await call(settings, {
    method: 'POST',
    body: JSON.stringify({
      ttsProvider: 'dashscope',
      ttsApiKey: 'sk-secret-value',
      ttsVoice: 'longanhuan_v3.1',
      ttsRate: 1.1,
      ttsInstruction: '用轻快、带笑意的语气说',
    }),
  })
  assert.equal(saved.status, 200)
  const onDisk = JSON.parse(await readFile(join(home, 'live2d', 'settings.json'), 'utf8'))
  assert.equal(onDisk.ttsProvider, 'dashscope')
  assert.equal(onDisk.ttsApiKey, 'sk-secret-value')

  const config = JSON.parse((await call(harness.routes.find(entry => entry.path.endsWith('/config')))).text)
  assert.equal(config.tts.provider, 'dashscope')
  assert.equal(config.tts.hasKey, true)
  assert.equal(config.tts.keySource, 'settings')
  assert.equal(config.tts.rate, 1.1)
  // The secret itself must not travel to the browser through /config.
  assert.equal(JSON.stringify(config).includes('sk-secret-value'), false)

  // A malformed provider is refused rather than stored.
  const bad = await call(settings, { method: 'POST', body: JSON.stringify({ ttsProvider: 'nope' }) })
  assert.equal(bad.status, 400)
})

test('the panel gets real model and voice choices from the Host', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack })
  const route = harness.routes.find(entry => entry.path.endsWith('/tts/options'))
  assert.ok(route !== undefined, 'the options route is registered')

  const all = JSON.parse((await call(route)).text)
  assert.ok(Array.isArray(all.models) && all.models.length > 0, 'models are listed')
  assert.equal(all.sources.voices, 'catalog')
  const flash = all.models.find(model => model.id === 'qwen-audio-3.1-tts-flash')
  assert.ok(flash !== undefined, 'the default model is offered')
  assert.ok(flash.voiceCount > 0, 'and it carries its voices')
  const voices = all.voicesByModel[flash.id]
  assert.ok(voices.length >= 10, 'the voice list is populated')
  assert.ok(voices.every(voice => typeof voice.id === 'string'), 'every voice has an id')
  assert.ok(voices.some(voice => voice.gender === 'female'), 'gender is kept for display')

  // `?model=` answers with just that model's voices, which is what the panel needs
  // after the model field changes.
  const filtered = JSON.parse((await call(route, { url: `${route.path}?model=${encodeURIComponent(flash.id)}` })).text)
  assert.equal(filtered.voices.length, voices.length)
})

test('the live model list is filtered down to speech models', async () => {
  const { ttsOptions, loadVoiceCatalog, mergeModels } = await import('../lib/tts.mjs')
  const catalog = await loadVoiceCatalog()
  assert.ok(catalog.models.length > 0, 'the bundled catalog parses')
  const merged = mergeModels(catalog.models, ['qwen-audio-3.1-tts-flash', 'qwen-max'])
  assert.deepEqual(merged.map(model => model.id).slice(0, 2), ['qwen-audio-3.1-tts-plus', 'qwen-audio-3.1-tts-flash'])
  assert.ok(merged.some(model => model.id === 'qwen-max'), 'an unknown live model still shows up')

  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return {
      ok: true,
      async json() {
        return {
          data: [
            { id: 'qwen-audio-3.1-tts-flash' },
            { id: 'cosyvoice-v3-flash' },
            { id: 'qwen-max' },
            { id: 'text-embedding-v4' },
          ],
        }
      },
    }
  }
  const options = await ttsOptions({
    baseUrl: 'https://example.invalid',
    apiKey: 'sk-test',
    fetchImpl,
    refresh: true,
  })
  assert.equal(options.sources.models, 'api')
  assert.equal(calls[0], 'https://example.invalid/compatible-mode/v1/models')
  assert.ok(options.models.some(model => model.id === 'cosyvoice-v3-flash'), 'speech models from the account are kept')
  assert.equal(options.models.some(model => model.id === 'text-embedding-v4'), false, 'chat/embedding models are dropped')
})

test('synthesis sends the configured model/voice and returns the bytes', async () => {
  const { synthesizeSpeech } = await import('../lib/tts.mjs')
  const calls = []
  const wav = Buffer.from('RIFF-headless-test-audio')
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (String(url).includes('/api/v1/services/audio/tts/SpeechSynthesizer')) {
      return { ok: true, async json() { return { output: { audio: { url: 'https://example.invalid/a.wav', expires_at: 1 } } } } }
    }
    return { ok: true, async arrayBuffer() { return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) } }
  }
  const result = await synthesizeSpeech({
    text: '你好呀。',
    apiKey: 'sk-test',
    model: 'qwen-audio-3.1-tts-flash',
    voice: 'longanhuan_v3.1',
    rate: 1.1,
    instruction: '轻快一点',
    baseUrl: 'https://example.invalid',
    fetchImpl,
  })
  assert.equal(result.ok, true)
  assert.equal(result.format, 'wav')
  assert.ok(Buffer.isBuffer(result.audio) && result.audio.length === wav.length)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'qwen-audio-3.1-tts-flash')
  assert.equal(body.input.voice, 'longanhuan_v3.1')
  assert.equal(body.input.text, '你好呀。')
  assert.equal(body.input.format, 'wav')
  assert.equal(body.input.rate, 1.1)
  assert.equal(body.input.instruction, '轻快一点')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test')

  // A missing key is a clear refusal, not a network attempt.
  const refused = await synthesizeSpeech({ text: '你好', fetchImpl })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /API Key/)
})

test('the 试听 route synthesizes with the saved settings', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, ttsProvider: 'dashscope', ttsApiKey: 'sk-saved' })
  const route = harness.routes.find(entry => entry.path.endsWith('/tts/test'))
  assert.ok(route !== undefined, 'the test route is registered')

  const previousFetch = globalThis.fetch
  const wav = Buffer.from('RIFF-fake-audio-bytes')
  globalThis.fetch = async (url) => {
    if (String(url).includes('SpeechSynthesizer')) {
      return { ok: true, async json() { return { output: { audio: { url: 'https://example.invalid/x.wav' } } } } }
    }
    return { ok: true, async arrayBuffer() { return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) } }
  }
  try {
    const answer = JSON.parse((await call(route, { method: 'POST', body: '{}' })).text)
    assert.equal(answer.ok, true)
    assert.ok(answer.audio.startsWith('data:audio/wav;base64,'))
    assert.equal(answer.voice, 'longanhuan_v3.1')
    assert.ok(answer.ms >= 0)
  } finally {
    globalThis.fetch = previousFetch
  }

  // GET is not a synthesis request.
  const wrong = await call(route, { method: 'GET' })
  assert.equal(wrong.status, 405)
})

test('试听 without a key explains itself instead of failing blind', async () => {
  const { pack } = await packFixture()
  const previousKey = process.env.DASHSCOPE_API_KEY
  delete process.env.DASHSCOPE_API_KEY
  try {
    const harness = fakeContext()
    apply(harness.ctx, { pack, ttsProvider: 'dashscope' })
    const route = harness.routes.find(entry => entry.path.endsWith('/tts/test'))
    const answer = JSON.parse((await call(route, { method: 'POST', body: '{}' })).text)
    assert.equal(answer.ok, false)
    assert.match(answer.error, /API Key/)
  } finally {
    if (previousKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousKey
  }
})

test('the model that writes the line decides how it is spoken', async () => {
  const { resolveSpeechParams, EMOTION_TONE } = await import('../lib/tts.mjs')
  const defaults = { rate: 1, pitch: 1, instruction: '' }

  // The model's values win, and out-of-range ones are clamped rather than rejected.
  const asked = resolveSpeechParams({
    emotion: 'joy',
    requested: { rate: 9, pitch: 0.1, tone: '压着火气，低声说' },
    defaults,
    modelControls: true,
  })
  assert.equal(asked.rate, 2)
  assert.equal(asked.pitch, 0.5)
  assert.equal(asked.instruction, '压着火气，低声说')
  assert.equal(asked.source, 'model')

  // No delivery note: the settings instruction, then the emotion map.
  const fromSettings = resolveSpeechParams({
    emotion: 'sad',
    requested: {},
    defaults: { rate: 0.9, pitch: 1, instruction: '念慢一点' },
    modelControls: true,
  })
  assert.equal(fromSettings.instruction, '念慢一点')
  assert.equal(fromSettings.rate, 0.9)

  const fromEmotion = resolveSpeechParams({ emotion: 'shy', requested: {}, defaults, modelControls: true })
  assert.equal(fromEmotion.instruction, EMOTION_TONE.shy)
  assert.equal(fromEmotion.source, 'fallback')

  // The switch can pin everything to the settings.
  const pinned = resolveSpeechParams({
    emotion: 'joy',
    requested: { rate: 1.6, pitch: 1.4, tone: '轻快' },
    defaults: { rate: 0.8, pitch: 1.2, instruction: '固定的语气' },
    modelControls: false,
  })
  assert.equal(pinned.rate, 0.8)
  assert.equal(pinned.pitch, 1.2)
  assert.equal(pinned.instruction, '固定的语气')
  assert.equal(pinned.source, 'settings')
})

test('a director reply carries its delivery note into the frame', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-tts-director-'))
  process.env.DSH_HOME = home
  await mkdir(join(home, 'live2d'), { recursive: true })
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'sherry', director: true }))
  const pack = join(home, 'live2d', 'packs', 'sherry')
  await mkdir(join(pack, 'model'), { recursive: true })
  await writeFile(join(pack, 'model', 'a.model3.json'), JSON.stringify({ Version: 3, FileReferences: { Moc: 'a.moc3', Textures: [] } }))

  const tools = []
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on() { return () => {} },
    inject(names, fn) {
      const face = {
        tools: { register: (definition) => { tools.push(definition); return () => {} } },
        systemPrompt: { section: () => () => {}, getSectionOrder: () => 100 },
        on: () => () => {},
        effect: ctx.effect,
        llm: {
          async *stream() {
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                emotion: 'joy',
                line: '我找到啦。',
                speech: { rate: 1.25, pitch: 1.1, tone: '轻快、带笑意的语气' },
              }),
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        },
        agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      }
      fn(face)
      return () => {}
    },
    webServer: { register: () => () => {} },
    logger: { info() {}, warn() {} },
  }
  const { apply } = await import('../lib/index.mjs')
  apply(ctx, {})
  const direct = tools.find(tool => tool.name === 'live2d_direct')
  const answer = await direct.execute({ content: '她想说：我找到啦。' }, { agent: { id: 's1' } })
  assert.equal(answer.ok, true)
  assert.equal(answer.speech.rate, 1.25)
  assert.equal(answer.speech.pitch, 1.1)
  assert.equal(answer.speech.instruction, '轻快、带笑意的语气')
  assert.equal(answer.speech.source, 'model')
})

/** A fake SSE response that records everything the Host writes. */
function sseSink() {
  const chunks = []
  const handlers = new Map()
  return {
    chunks,
    statusCode: 0,
    writeHead(code) { this.statusCode = code; return this },
    write(chunk) { chunks.push(String(chunk)); return true },
    end() { return this },
    on(name, handler) { handlers.set(name, handler); return this },
    close() { const handler = handlers.get('close'); if (handler !== undefined) handler() },
    frames() {
      return this.events('stage')
    },
    events(name) {
      const prefix = `event: ${name}
`
      return chunks
        .filter(chunk => chunk.startsWith(prefix))
        .map(chunk => JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6).trim()))
    },
  }
}

test('a line is published with its clip, and the same line is not synthesized twice', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, {
    pack,
    director: false,
    ttsProvider: 'dashscope',
    ttsApiKey: 'sk-cached',
    stageEveryTurns: 1,
  })
  const stageRoute = harness.routes.find(entry => entry.path.endsWith('/stage'))
  const sink = sseSink()
  await stageRoute.handler({ url: stageRoute.path, on() {}, method: 'GET', headers: {} }, sink)

  const previousFetch = globalThis.fetch
  const wav = Buffer.from('RIFF-cached-clip')
  let synthCalls = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('SpeechSynthesizer')) {
      synthCalls += 1
      return { ok: true, async json() { return { output: { audio: { url: 'https://example.invalid/clip.wav' } } } } }
    }
    return { ok: true, async arrayBuffer() { return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) } }
  }
  try {
    const act = harness.tools.find(entry => entry.name === 'live2d_act')
    assert.ok(act !== undefined, 'the act tool is registered')
    await act.execute({ emotion: 'joy', line: '我找到啦。' }, { agent: { id: 's1' } })
    await new Promise(resolve => setTimeout(resolve, 150))

    const frames = sink.frames()
    const spoken = frames[frames.length - 1]
    assert.equal(spoken.line, '我找到啦。')
    assert.match(String(spoken.speech?.audio ?? ''), /\/models\/sherry\/voice\/[0-9a-f]{16}\.wav$/)
    assert.ok(Number(spoken.speech.audioMs) >= 0)
    assert.equal(synthCalls, 1)
    // The clip lands beside the model (a unified pack keeps it under `model/`),
    // which is the directory the `/models` route serves from.
    const clip = await readFile(join(pack, 'model', 'voice', `${String(spoken.speech.audio).split('/').pop()}`))
    assert.equal(clip.length, wav.length)

    // The same words reuse the cached clip: no second synthesis request.
    await act.execute({ emotion: 'joy', line: '我找到啦。' }, { agent: { id: 's1' } })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(synthCalls, 1, 'a repeated line is not paid for twice')
  } finally {
    globalThis.fetch = previousFetch
    sink.close()
  }
})

test('with TTS off, a line still reaches the bubble without audio', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, director: false, ttsProvider: 'off', stageEveryTurns: 1 })
  const stageRoute = harness.routes.find(entry => entry.path.endsWith('/stage'))
  const sink = sseSink()
  await stageRoute.handler({ url: stageRoute.path, on() {}, method: 'GET', headers: {} }, sink)
  const act = harness.tools.find(entry => entry.name === 'live2d_act')
  await act.execute({ emotion: 'calm', line: '安静一点。' }, { agent: { id: 's2' } })
  await new Promise(resolve => setTimeout(resolve, 100))
  const frame = sink.frames().pop()
  assert.equal(frame.line, '安静一点。')
  assert.equal(frame.speech?.audio, undefined)
  sink.close()
})

test('cloning sends the sample, the target model and the prefix', async () => {
  const { cloneVoice, isValidVoicePrefix, listClonedVoices, deleteClonedVoice } = await import('../lib/tts.mjs')
  assert.equal(isValidVoicePrefix('myvoice1'), true)
  assert.equal(isValidVoicePrefix('my voice'), false)
  assert.equal(isValidVoicePrefix('非常长的名字超过十个字符'), false)

  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    const input = JSON.parse(init.body).input
    if (input.action === 'create_voice') {
      return { ok: true, async json() { return { output: { voice_id: 'qwen-audio-3.1-tts-flash-myvoice-abc' } } } }
    }
    if (input.action === 'list_voice') {
      return { ok: true, async json() { return { output: { voices: [{ voice_id: 'v-1', target_model: 'qwen-audio-3.1-tts-flash' }] } } } }
    }
    return { ok: true, async json() { return { output: {} } } }
  }

  const created = await cloneVoice({
    apiKey: 'sk-clone',
    baseUrl: 'https://example.invalid',
    targetModel: 'qwen-audio-3.1-tts-flash',
    prefix: 'myvoice',
    audio: 'data:audio/wav;base64,UklGRg==',
    fetchImpl,
  })
  assert.equal(created.ok, true)
  assert.equal(created.voiceId, 'qwen-audio-3.1-tts-flash-myvoice-abc')
  assert.equal(calls[0].body.model, 'voice-enrollment')
  assert.equal(calls[0].body.input.action, 'create_voice')
  assert.equal(calls[0].body.input.target_model, 'qwen-audio-3.1-tts-flash')
  assert.equal(calls[0].body.input.prefix, 'myvoice')
  assert.equal(calls[0].body.input.audio, 'data:audio/wav;base64,UklGRg==')

  // Refusals stay local: no request goes out for a bad model or an unusable name.
  const before = calls.length
  assert.equal((await cloneVoice({ apiKey: 'k', targetModel: 'qwen-max', prefix: 'ok', audio: 'data:audio/wav;base64,AA', fetchImpl })).ok, false)
  assert.equal((await cloneVoice({ apiKey: 'k', targetModel: 'qwen-audio-3.1-tts-flash', prefix: '坏名字', audio: 'data:audio/wav;base64,AA', fetchImpl })).ok, false)
  assert.equal(calls.length, before, 'invalid input never reaches the network')

  const listed = await listClonedVoices({ apiKey: 'k', baseUrl: 'https://example.invalid', fetchImpl })
  assert.deepEqual(listed.voices, [{ id: 'v-1', targetModel: 'qwen-audio-3.1-tts-flash' }])
  assert.equal((await deleteClonedVoice({ apiKey: 'k', voiceId: 'v-1', baseUrl: 'https://example.invalid', fetchImpl })).ok, true)
})

test('the panel can clone a voice and then pick it', async () => {
  const { pack, home } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, ttsProvider: 'dashscope', ttsApiKey: 'sk-clone' })
  const voicesRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices'))
  const cloneRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices/clone'))
  const deleteRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices/delete'))
  assert.ok(voicesRoute && cloneRoute && deleteRoute, 'voice routes are registered')

  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(init.body).input
    if (input.action === 'create_voice') {
      return { ok: true, async json() { return { output: { voice_id: 'qwen-audio-3.1-tts-flash-sherry-xyz' } } } }
    }
    return { ok: true, async json() { return { output: {} } } }
  }
  try {
    const created = JSON.parse((await call(cloneRoute, {
      method: 'POST',
      body: JSON.stringify({ audio: 'data:audio/wav;base64,UklGRg==', prefix: 'sherry', label: '雪莉的样本' }),
    })).text)
    assert.equal(created.ok, true)
    assert.equal(created.voice.id, 'qwen-audio-3.1-tts-flash-sherry-xyz')

    // The manifest survives outside the pack, next to the settings file.
    const manifest = JSON.parse(await readFile(join(home, 'live2d', 'tts', 'voices.json'), 'utf8'))
    assert.equal(manifest.voices[0].name, '雪莉的样本')

    const listed = JSON.parse((await call(voicesRoute)).text)
    assert.equal(listed.voices.length, 1)
    assert.ok(listed.models.includes('qwen-audio-3.1-tts-flash'))

    // The clone shows up in the dropdown the panel builds for its model.
    const options = JSON.parse((await call(harness.routes.find(entry => entry.path.endsWith('/tts/options')))).text)
    const voices = options.voicesByModel['qwen-audio-3.1-tts-flash'] ?? []
    assert.ok(voices.some(voice => voice.id === 'qwen-audio-3.1-tts-flash-sherry-xyz' && voice.cloned === true))

    // A name the platform would refuse is caught before any upload.
    const badName = await call(cloneRoute, {
      method: 'POST',
      body: JSON.stringify({ audio: 'data:audio/wav;base64,UklGRg==', prefix: '雪莉' }),
    })
    assert.equal(badName.status, 400, 'a name the platform would refuse is rejected locally')
    assert.match(JSON.parse(badName.text).error, /英文字母和数字/)

    const removed = JSON.parse((await call(deleteRoute, {
      method: 'POST',
      body: JSON.stringify({ voiceId: 'qwen-audio-3.1-tts-flash-sherry-xyz' }),
    })).text)
    assert.equal(removed.ok, true)
    assert.deepEqual(removed.voices, [])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a chosen language is sent as language_hints and taught to the line writer', async () => {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-lang-'))
  const { resolveConfig: resolve } = internals
  assert.equal(resolve({}).tts.language, 'auto')
  assert.equal(resolve({ ttsLanguage: 'en' }).tts.language, 'en')
  assert.equal(resolve({ ttsLanguage: 'ja' }).tts.language, 'ja')
  // An unknown code falls back to auto instead of failing the load.
  assert.equal(resolve({ ttsLanguage: 'klingon' }).tts.language, 'auto')

  const { synthesizeSpeech, languageLabel, TTS_LANGUAGES } = await import('../lib/tts.mjs')
  assert.equal(languageLabel('en'), '英语')
  assert.equal(languageLabel('auto'), '')
  assert.ok(TTS_LANGUAGES.length >= 15)
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body))
    return { ok: true, async json() { return { output: { audio: { url: 'https://example.invalid/a.wav' } } } } }
  }
  const audioFetcher = async () => ({ ok: true, async arrayBuffer() { return new ArrayBuffer(4) } })
  const merged = async (url, init) => (String(url).includes('SpeechSynthesizer') ? fetchImpl(url, init) : audioFetcher())

  await synthesizeSpeech({ text: 'hello', apiKey: 'k', language: 'en', fetchImpl: merged, baseUrl: 'https://example.invalid' })
  assert.deepEqual(calls[0].input.language_hints, ['en'])
  calls.length = 0
  await synthesizeSpeech({ text: '你好', apiKey: 'k', language: 'auto', fetchImpl: merged, baseUrl: 'https://example.invalid' })
  assert.equal(calls[0].input.language_hints, undefined, 'auto sends no hint')
})

test('the director is told to translate the line into the chosen language', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-lang-director-'))
  process.env.DSH_HOME = home
  await mkdir(join(home, 'live2d'), { recursive: true })
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ pack: 'sherry', director: true, ttsLanguage: 'en' }))
  const pack = join(home, 'live2d', 'packs', 'sherry')
  await mkdir(join(pack, 'model'), { recursive: true })
  await writeFile(join(pack, 'model', 'a.model3.json'), JSON.stringify({ Version: 3, FileReferences: { Moc: 'a.moc3', Textures: [] } }))

  const tools = []
  const seen = []
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on() { return () => {} },
    inject(names, fn) {
      fn({
        tools: { register: (definition) => { tools.push(definition); return () => {} } },
        systemPrompt: { section: () => () => {}, getSectionOrder: () => 100 },
        on: () => () => {},
        effect: ctx.effect,
        llm: {
          async *stream(options) {
            seen.push(options)
            yield { type: 'text-delta', text: JSON.stringify({ emotion: 'calm', line: 'I found it.' }) }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        },
        agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      })
      return () => {}
    },
    webServer: { register: () => () => {} },
    logger: { info() {}, warn() {} },
  }
  const { apply: boot } = await import('../lib/index.mjs')
  boot(ctx, {})
  const direct = tools.find(tool => tool.name === 'live2d_direct')
  const answer = await direct.execute({ content: '她想说：找到了。' }, { agent: { id: 's1' } })
  assert.equal(answer.ok, true)
  assert.match(seen[0].system, /line 必须用英语写/)
  assert.match(seen[0].system, /翻译成英语/)
})

test('voice options carry the language coverage the hint needs', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, ttsProvider: 'off' })
  const options = JSON.parse((await call(harness.routes.find(entry => entry.path.endsWith('/tts/options')))).text)
  const voices = options.voicesByModel['qwen-audio-3.1-tts-flash'] ?? []
  assert.ok(voices.length > 10, 'the catalog is served')

  const multilingual = voices.find(voice => voice.id === 'longanhuan_v3.1')
  assert.ok(Array.isArray(multilingual.languages), 'a multilingual voice declares its languages')
  assert.ok(multilingual.languages.includes('zh'))
  assert.ok(multilingual.languages.includes('ja'), 'Japanese is covered by the multilingual voice')

  const chineseOnly = voices.filter(voice => Array.isArray(voice.languages) && voice.languages.length === 1 && voice.languages[0] === 'zh')
  assert.ok(chineseOnly.length > 0, 'Chinese-only voices are marked as such')

  // A voice the published table does not describe stays silent: no coverage data,
  // so the panel must not guess and warn about it.
  const unknown = voices.find(voice => voice.languages === null)
  assert.ok(unknown !== undefined, 'unlisted coverage is null, not []')
})

test('a clone can be bound to a model other than the one currently in use', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, ttsProvider: 'dashscope', ttsApiKey: 'sk-clone', ttsModel: 'qwen-audio-3.1-tts-flash' })
  const cloneRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices/clone'))
  const optionsRoute = harness.routes.find(entry => entry.path.endsWith('/tts/options'))

  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(init.body).input
    if (input.action === 'create_voice') {
      // The platform echoes the target model back inside the id.
      return { ok: true, async json() { return { output: { voice_id: `${input.target_model}-other-1` } } } }
    }
    return { ok: true, async json() { return { output: {} } } }
  }
  try {
    const created = JSON.parse((await call(cloneRoute, {
      method: 'POST',
      body: JSON.stringify({
        audio: 'data:audio/wav;base64,UklGRg==',
        prefix: 'other',
        label: '别的模型用',
        targetModel: 'cosyvoice-v3-flash',
      }),
    })).text)
    assert.equal(created.ok, true)
    assert.equal(created.voice.targetModel, 'cosyvoice-v3-flash')

    const options = JSON.parse((await call(optionsRoute)).text)
    const voices = options.voicesByModel['cosyvoice-v3-flash'] ?? []
    assert.ok(voices.some(voice => voice.id === 'cosyvoice-v3-flash-other-1' && voice.cloned === true), 'it is offered under its own model')

    // A model the platform cannot clone from is refused before the upload goes out.
    const bad = await call(cloneRoute, {
      method: 'POST',
      body: JSON.stringify({ audio: 'data:audio/wav;base64,UklGRg==', prefix: 'x', targetModel: 'qwen-max' }),
    })
    assert.equal(bad.status, 400)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('the reference recording is kept locally and can be downloaded back', async () => {
  const { pack, home } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, ttsProvider: 'dashscope', ttsApiKey: 'sk-sample' })
  const cloneRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices/clone'))
  const voicesRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices'))
  const sampleRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices/sample'))
  const deleteRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices/delete'))
  assert.ok(sampleRoute !== undefined, 'the sample route is registered')

  const wav = Buffer.from('RIFF-reference-recording-bytes')
  const dataUri = `data:audio/wav;base64,${wav.toString('base64')}`
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, async json() { return { output: { voice_id: 'qwen-audio-3.1-tts-flash-samp-1' } } } })
  try {
    const created = JSON.parse((await call(cloneRoute, {
      method: 'POST',
      body: JSON.stringify({ audio: dataUri, prefix: 'samp', label: '样本音色' }),
    })).text)
    assert.equal(created.ok, true)

    const sampleFile = join(home, 'live2d', 'tts', 'samples', 'qwen-audio-3.1-tts-flash-samp-1.wav')
    const stored = await readFile(sampleFile)
    assert.equal(stored.length, wav.length)

    const listed = JSON.parse((await call(voicesRoute)).text)
    assert.equal(listed.voices[0].sample, 'qwen-audio-3.1-tts-flash-samp-1.wav')
    assert.equal(listed.voices[0].sampleBytes, wav.length)
    assert.match(listed.voices[0].sampleUrl, /\/tts\/voices\/sample\?voiceId=/)

    const { Writable } = await import('node:stream')
    const chunks = []
    // `serveFile` pipes a read stream, so the fake response has to be a real Writable.
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })
    res.statusCode = 0
    res.writeHead = (code) => { res.statusCode = code; return res }
    res.setHeader = () => {}
    const finished = new Promise(resolve => res.on('finish', resolve))
    await sampleRoute.handler({
      method: 'GET',
      url: `${sampleRoute.path}?voiceId=qwen-audio-3.1-tts-flash-samp-1`,
      headers: {},
    }, res)
    // The body is piped; wait for the stream to finish before counting the bytes.
    await finished
    assert.equal(res.statusCode, 200)
    assert.equal(Buffer.concat(chunks).length, wav.length)

    await call(deleteRoute, { method: 'POST', body: JSON.stringify({ voiceId: 'qwen-audio-3.1-tts-flash-samp-1' }) })
    await assert.rejects(() => readFile(sampleFile), /ENOENT/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('clones made elsewhere are discovered through the API key', async () => {
  const { pack, home } = await packFixture()
  const harness = fakeContext()
  // One voice is known locally; the platform reports it plus one made elsewhere.
  await mkdir(join(home, 'live2d', 'tts'), { recursive: true })
  await writeFile(join(home, 'live2d', 'tts', 'voices.json'), JSON.stringify({
    version: 1,
    voices: [{ id: 'qwen-audio-3.1-tts-flash-mine-aaa', name: '我的本地名', targetModel: 'qwen-audio-3.1-tts-flash' }],
  }))
  apply(harness.ctx, { pack, ttsProvider: 'dashscope', ttsApiKey: 'sk-enum' })

  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(init.body).input
    if (input.action === 'list_voice') {
      return {
        ok: true,
        async json() {
          return {
            output: {
              voice_list: [
                { voice_id: 'qwen-audio-3.1-tts-flash-mine-aaa' },
                { voice_id: 'cosyvoice-v3-flash-elsewhere-bbb' },
              ],
            },
          }
        },
      }
    }
    return { ok: true, async json() { return { output: {} } } }
  }
  try {
    const voicesRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices'))
    const listed = JSON.parse((await call(voicesRoute)).text)
    assert.equal(listed.source, 'api')
    assert.equal(listed.voices.length, 2, 'both the local and the remote clone are listed')
    const mine = listed.voices.find(voice => voice.id === 'qwen-audio-3.1-tts-flash-mine-aaa')
    assert.equal(mine.name, '我的本地名', 'a local friendly name wins over the raw id')
    const elsewhere = listed.voices.find(voice => voice.id === 'cosyvoice-v3-flash-elsewhere-bbb')
    assert.equal(elsewhere.targetModel, 'cosyvoice-v3-flash', 'the model is read from the id')
    assert.equal(elsewhere.remote, true)

    // And it is offered in the dropdown of its own model.
    const options = JSON.parse((await call(harness.routes.find(entry => entry.path.endsWith('/tts/options')))).text)
    assert.ok((options.voicesByModel['cosyvoice-v3-flash'] ?? []).some(voice => voice.id === 'cosyvoice-v3-flash-elsewhere-bbb'))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a failed query keeps the local clones visible', async () => {
  const { pack, home } = await packFixture()
  const harness = fakeContext()
  await mkdir(join(home, 'live2d', 'tts'), { recursive: true })
  await writeFile(join(home, 'live2d', 'tts', 'voices.json'), JSON.stringify({
    version: 1,
    voices: [{ id: 'qwen-audio-3.1-tts-flash-keep-ccc', name: '离线也要在', targetModel: 'qwen-audio-3.1-tts-flash' }],
  }))
  apply(harness.ctx, { pack, ttsProvider: 'dashscope', ttsApiKey: 'sk-bad' })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    async json() { return { message: 'boom' } },
  })
  try {
    const voicesRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices'))
    const listed = JSON.parse((await call(voicesRoute)).text)
    assert.equal(listed.source, 'local')
    assert.equal(listed.voices.length, 1)
    assert.equal(listed.voices[0].name, '离线也要在')
    assert.ok(typeof listed.note === 'string' && listed.note !== '', 'the failure is explained')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a fresh clone shows up in the dropdown immediately, not after the cache expires', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, ttsProvider: 'dashscope', ttsApiKey: 'sk-fresh' })
  const optionsRoute = harness.routes.find(entry => entry.path.endsWith('/tts/options'))
  const cloneRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices/clone'))

  const previousFetch = globalThis.fetch
  let listCalls = 0
  let created = false
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(init.body).input
    if (input.action === 'list_voice') {
      listCalls += 1
      return {
        ok: true,
        async json() {
          return {
            output: {
              voice_list: created ? [{ voice_id: 'qwen-audio-3.1-tts-flash-fresh-1' }] : [],
            },
          }
        },
      }
    }
    if (input.action === 'create_voice') {
      created = true
      return { ok: true, async json() { return { output: { voice_id: 'qwen-audio-3.1-tts-flash-fresh-1' } } } }
    }
    return { ok: true, async json() { return { output: {} } } }
  }
  try {
    // Warm the cache with a list that does not contain the clone yet.
    await call(optionsRoute)
    assert.equal(listCalls, 1)

    await call(cloneRoute, {
      method: 'POST',
      body: JSON.stringify({ audio: 'data:audio/wav;base64,UklGRg==', prefix: 'fresh', label: '新音色' }),
    })

    // A plain read already sees it: creating a voice drops the cached list.
    const after = JSON.parse((await call(optionsRoute)).text)
    const voices = after.voicesByModel['qwen-audio-3.1-tts-flash'] ?? []
    assert.ok(voices.some(voice => voice.id === 'qwen-audio-3.1-tts-flash-fresh-1'), 'the clone is in the list')

    // `?refresh=1` is the explicit escape hatch the panel uses after cloning.
    const forced = JSON.parse((await call(optionsRoute, { url: `${optionsRoute.path}?refresh=1` })).text)
    assert.ok((forced.voicesByModel['qwen-audio-3.1-tts-flash'] ?? []).some(voice => voice.id === 'qwen-audio-3.1-tts-flash-fresh-1'))
    assert.ok(listCalls >= 2, 'the forced read asked the platform again')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a model that only exists because of a clone is still selectable', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, ttsProvider: 'dashscope', ttsApiKey: 'sk-model' })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(init.body).input
    if (input.action === 'list_voice') {
      // cosyvoice is not among the live chat models the platform lists.
      return { ok: true, async json() { return { output: { voice_list: [{ voice_id: 'cosyvoice-v3.5-plus-frieren-1' }] } } } }
    }
    return { ok: true, async json() { return { output: {} } } }
  }
  try {
    const options = JSON.parse((await call(harness.routes.find(entry => entry.path.endsWith('/tts/options')))).text)
    const model = options.models.find(entry => entry.id === 'cosyvoice-v3.5-plus')
    assert.ok(model !== undefined, 'the clone-only model is offered')
    assert.equal(model.clonedOnly, true)
    assert.ok((options.voicesByModel['cosyvoice-v3.5-plus'] ?? []).some(voice => String(voice.id).includes('frieren')))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('one sample can be cloned onto a second model', async () => {
  const { pack, home } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, ttsProvider: 'dashscope', ttsApiKey: 'sk-two' })
  const cloneRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices/clone'))
  const voicesRoute = harness.routes.find(entry => entry.path.endsWith('/tts/voices'))

  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(init.body).input
    if (input.action === 'create_voice') {
      return { ok: true, async json() { return { output: { voice_id: `${input.target_model}-dup-1` } } } }
    }
    return { ok: true, async json() { return { output: {} } } }
  }
  try {
    const audio = 'data:audio/wav;base64,UklGRg=='
    await call(cloneRoute, { method: 'POST', body: JSON.stringify({ audio, prefix: 'dup', label: 'Frieren', targetModel: 'cosyvoice-v3.5-plus' }) })
    await call(cloneRoute, { method: 'POST', body: JSON.stringify({ audio, prefix: 'dup', label: 'Frieren · qwen', targetModel: 'qwen-audio-3.1-tts-flash' }) })

    const listed = JSON.parse((await call(voicesRoute)).text)
    assert.equal(listed.voices.length, 2, 'two clones, one per model')
    const models = listed.voices.map(voice => voice.targetModel).sort()
    assert.deepEqual(models, ['cosyvoice-v3.5-plus', 'qwen-audio-3.1-tts-flash'])
    // The manifest keeps both samples (ids differ), so either can be rebuilt again.
    for (const voice of listed.voices) assert.ok(typeof voice.sample === 'string' && voice.sample !== '')
    assert.ok((await readFile(join(home, 'live2d', 'tts', 'samples', 'cosyvoice-v3.5-plus-dup-1.wav'))).length > 0)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('the stream snapshot restores the pose without replaying an old clip', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, { pack, director: false, ttsProvider: 'dashscope', ttsApiKey: 'sk-snap', stageEveryTurns: 1 })
  const stageRoute = harness.routes.find(entry => entry.path.endsWith('/stage'))

  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('SpeechSynthesizer')) {
      return { ok: true, async json() { return { output: { audio: { url: 'https://example.invalid/a.wav' } } } } }
    }
    return { ok: true, async arrayBuffer() { return new ArrayBuffer(8) } }
  }
  try {
    const live = sseSink()
    await stageRoute.handler({ url: stageRoute.path, on() {}, method: 'GET', headers: {} }, live)
    const act = harness.tools.find(entry => entry.name === 'live2d_act')
    await act.execute({ emotion: 'joy', line: '我回来了。' }, { agent: { id: 's9' } })
    await new Promise(resolve => setTimeout(resolve, 150))
    const spoken = live.frames().pop()
    assert.ok(typeof spoken.speech?.audio === 'string' && spoken.speech.audio !== '', 'the live frame carries its clip')

    // A page opened later gets the pose, never the sound: two copies of the same
    // recording, offset by a few milliseconds, read as reverb.
    const late = sseSink()
    await stageRoute.handler({ url: stageRoute.path, on() {}, method: 'GET', headers: {} }, late)
    const replayed = late.frames().pop()
    assert.equal(replayed.line, '我回来了。', 'the bubble text still replays')
    assert.equal(replayed.speech?.audio, undefined, 'the clip does not')
    live.close()
    late.close()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('text-first mode publishes the bubble at once and streams the clip afterwards', async () => {
  const { pack } = await packFixture()
  const harness = fakeContext()
  apply(harness.ctx, {
    pack,
    director: false,
    ttsProvider: 'dashscope',
    ttsApiKey: 'sk-async',
    ttsSyncMode: 'text-first',
    stageEveryTurns: 1,
  })
  const stageRoute = harness.routes.find(entry => entry.path.endsWith('/stage'))
  const sink = sseSink()
  await stageRoute.handler({ url: stageRoute.path, on() {}, method: 'GET', headers: {} }, sink)

  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('SpeechSynthesizer')) {
      // A slow platform: the bubble must not wait for this.
      await new Promise(resolve => setTimeout(resolve, 300))
      return { ok: true, async json() { return { output: { audio: { url: 'https://example.invalid/a.wav' } } } } }
    }
    return { ok: true, async arrayBuffer() { return new ArrayBuffer(8) } }
  }
  try {
    const act = harness.tools.find(entry => entry.name === 'live2d_act')
    const started = Date.now()
    await act.execute({ emotion: 'joy', line: '我回来了。' }, { agent: { id: 's3' } })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 250, `the call returns before synthesis finishes (took ${elapsed}ms)`)

    const stageFrames = sink.frames()
    assert.equal(stageFrames.length, 1, 'one pose frame')
    assert.equal(stageFrames[0].line, '我回来了。')
    assert.equal(stageFrames[0].speech?.audio, undefined, 'the frame does not wait for the clip')

    await new Promise(resolve => setTimeout(resolve, 500))
    const clip = sink.events('speech').pop()
    assert.ok(clip !== undefined, 'the clip arrives as its own event')
    assert.equal(clip.time, stageFrames[0].time, 'the clip is tied to that bubble')
    assert.match(String(clip.audio), /\/models\/sherry\/voice\/[0-9a-f]{16}\.wav$/)
    sink.close()
  } finally {
    globalThis.fetch = previousFetch
  }
})
