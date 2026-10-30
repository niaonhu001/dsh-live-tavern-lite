/**
 * TTS option discovery: which models the account can use, and which voices each
 * model offers.
 *
 * Models are read live from the platform's OpenAI-compatible `/models` endpoint,
 * because that list depends on the account's entitlements. System voices are a
 * published table (`assets/tts-voices.json`, rebuilt by
 * `scripts/build-tts-catalog.mjs`), so the panel still shows choices before any
 * request has been authorised.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Bundled voice catalog, refreshed by `scripts/build-tts-catalog.mjs`. */
export const CATALOG_ASSET = join(HERE, '..', 'assets', 'tts-voices.json')

/** Models to offer when neither the API nor the catalog can answer. */
export const FALLBACK_MODELS = [
  'qwen-audio-3.1-tts-flash',
  'qwen-audio-3.1-tts-plus',
  'qwen-audio-3.0-tts-flash',
  'qwen-audio-3.0-tts-plus',
  'cosyvoice-v3-flash',
  'cosyvoice-v3.5-plus',
]

/** How long a live model list is trusted, in milliseconds. */
const MODEL_CACHE_MS = 10 * 60 * 1000

/** name → `{ at, models }`, keyed by base URL and key fingerprint. */
const modelCache = new Map()

/**
 * Read and validate the bundled voice catalog.
 *
 * @param file - Catalog path; defaults to the bundled one.
 * @returns `{ models: [{ id, voices }], source }`; an unreadable file yields an empty catalog.
 */
export async function loadVoiceCatalog(file = CATALOG_ASSET) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const models = Array.isArray(parsed?.models) ? parsed.models : []
    return {
      source: typeof parsed?.source === 'string' ? parsed.source : '',
      fetchedAt: typeof parsed?.fetchedAt === 'string' ? parsed.fetchedAt : '',
      models: models
        .filter(model => typeof model?.id === 'string' && Array.isArray(model.voices))
        .map(model => ({
          id: model.id,
          voices: model.voices.filter(voice => typeof voice?.id === 'string'),
        })),
    }
  } catch {
    return { source: '', fetchedAt: '', models: [] }
  }
}

/**
 * Turn a model list into `{ id, voices }` rows, keeping the catalog order first.
 *
 * @param catalogModels - Catalog rows.
 * @param liveIds - Model ids the account reported.
 * @returns Model rows with `voiceCount`.
 */
export function mergeModels(catalogModels, liveIds) {
  const seen = new Set()
  const rows = []
  const push = (id, voiceCount) => {
    if (seen.has(id)) return
    seen.add(id)
    rows.push({ id, voiceCount })
  }
  for (const model of catalogModels) push(model.id, model.voices.length)
  for (const id of liveIds) push(id, catalogModels.find(model => model.id === id)?.voices.length ?? 0)
  if (rows.length === 0) for (const id of FALLBACK_MODELS) push(id, 0)
  return rows
}

/**
 * Ask the platform which models this key may use.
 *
 * @param options - `{ baseUrl, apiKey, fetchImpl, timeoutMs, refresh }`.
 * @returns `{ ids, source, note }`; `source` is `api`, `cached` or `unavailable`.
 */
export async function listLiveModels(options = {}) {
  const baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '') || 'https://maas.qianwenaiapi.com'
  const apiKey = String(options.apiKey ?? '').trim()
  if (apiKey === '') return { ids: [], source: 'unavailable', note: '还没有 API Key，先按随包音色表列模型' }
  const key = `${baseUrl}\u0000${apiKey.slice(-8)}`
  const cached = modelCache.get(key)
  if (options.refresh !== true && cached !== undefined && Date.now() - cached.at < MODEL_CACHE_MS) {
    return { ids: cached.ids, source: 'cached', note: '' }
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ids: [], source: 'unavailable', note: '这个运行时没有 fetch' }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000)
  try {
    const response = await fetchImpl(`${baseUrl}/compatible-mode/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      ...(controller === null ? {} : { signal: controller.signal }),
    })
    if (!response.ok) return { ids: [], source: 'unavailable', note: `模型列表返回 ${response.status}` }
    const body = await response.json()
    const all = Array.isArray(body?.data) ? body.data.map(item => item?.id).filter(id => typeof id === 'string') : []
    // The endpoint lists every model on the account; only speech models belong here.
    const ids = all.filter(id => /(tts|cosyvoice|speech|sambert)/i.test(id))
    modelCache.set(key, { at: Date.now(), ids })
    return { ids, source: 'api', note: ids.length === 0 ? '账号下没有语音模型，检查是否已开通' : '' }
  } catch (error) {
    return { ids: [], source: 'unavailable', note: `模型列表获取失败：${error?.message ?? error}` }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * Everything the settings panel needs to render two dropdowns.
 *
 * @param options - `{ baseUrl, apiKey, fetchImpl, timeoutMs, refresh }`.
 * @returns `{ models, voicesByModel, sources, note, catalogFetchedAt }`.
 */
export async function ttsOptions(options = {}) {
  const catalog = await loadVoiceCatalog(options.catalogFile)
  const live = await listLiveModels(options)
  const models = mergeModels(catalog.models, live.ids)
  /** Model id → its voices; a model without catalog voices gets an empty list. */
  const voicesByModel = {}
  for (const model of models) {
    const hit = catalog.models.find(entry => entry.id === model.id)
    voicesByModel[model.id] = hit === undefined ? [] : hit.voices
  }
  return {
    models,
    voicesByModel,
    sources: { models: live.source, voices: catalog.models.length > 0 ? 'catalog' : 'none' },
    note: live.note,
    catalogFetchedAt: catalog.fetchedAt,
  }
}

/**
 * Languages the synthesis endpoint accepts in `input.language_hints`.
 *
 * `auto` means "do not send the hint": the platform guesses from the text, which
 * is what you want when the line is already written in its own language.
 */
export const TTS_LANGUAGES = [
  { code: 'auto', label: '自动（不指定）' },
  { code: 'zh', label: '中文' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'it', label: '意大利语' },
  { code: 'pt', label: '葡萄牙语' },
  { code: 'ru', label: '俄语' },
  { code: 'ar', label: '阿拉伯语' },
  { code: 'th', label: '泰语' },
  { code: 'id', label: '印尼语' },
  { code: 'vi', label: '越南语' },
  { code: 'ms', label: '马来语' },
  { code: 'fil', label: '菲律宾语' },
]

/**
 * Which lines the line should be written in, for the prompt.
 *
 * @param code - Language code from `TTS_LANGUAGES`.
 * @returns The Chinese label, or an empty string for `auto`/unknown.
 */
export function languageLabel(code) {
  const found = TTS_LANGUAGES.find(item => item.code === code)
  return found === undefined || found.code === 'auto' ? '' : found.label
}

/** Longest test sentence the panel will send; the API caps text per request. */
export const TEST_TEXT_MAX = 500

/** Format the test always asks for: playable in a browser without a decoder of ours. */
const TEST_FORMAT = 'wav'

/**
 * Synthesize one sentence and hand back the bytes.
 *
 * This is the same call the stage will make for a spoken line; keeping it here
 * means the settings page can verify a key without any of the playback machinery.
 *
 * @param options - `{ text, apiKey, model, voice, rate, pitch, instruction, baseUrl, fetchImpl, timeoutMs }`.
 * @returns `{ ok, audio, format, ms, sourceUrl }` or `{ ok: false, error }`.
 */
export async function synthesizeSpeech(options = {}) {
  const apiKey = String(options.apiKey ?? '').trim()
  if (apiKey === '') return { ok: false, error: '还没有 API Key：先在「语音」里填一个，或设置 DASHSCOPE_API_KEY' }
  const text = String(options.text ?? '').trim().slice(0, TEST_TEXT_MAX)
  if (text === '') return { ok: false, error: '要念的内容是空的' }
  const baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '') || 'https://maas.qianwenaiapi.com'
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, error: '这个运行时没有 fetch' }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000
  const input = {
    text,
    voice: String(options.voice ?? '').trim() || 'longanhuan_v3.1',
    format: TEST_FORMAT,
    sample_rate: 24000,
  }
  // Optional knobs are only sent when set, so the service defaults stay in charge.
  if (Number.isFinite(Number(options.rate))) input.rate = Number(options.rate)
  if (Number.isFinite(Number(options.pitch))) input.pitch = Number(options.pitch)
  // The endpoint takes an array but only reads the first entry.
  const language = String(options.language ?? '').trim()
  if (language !== '' && language !== 'auto') input.language_hints = [language]
  const instruction = String(options.instruction ?? '').trim()
  if (instruction !== '') input.instruction = instruction
  const started = Date.now()
  const signal = typeof AbortController === 'function' ? new AbortController() : null
  const timer = signal === null ? null : setTimeout(() => signal.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${baseUrl}/api/v1/services/audio/tts/SpeechSynthesizer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: String(options.model ?? '').trim() || 'qwen-audio-3.1-tts-flash', input }),
      ...(signal === null ? {} : { signal: signal.signal }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = typeof payload?.message === 'string'
        ? payload.message
        : typeof payload?.error?.message === 'string'
          ? payload.error.message
          : `HTTP ${response.status}`
      return { ok: false, error: `语音合成失败：${detail}` }
    }
    const sourceUrl = payload?.output?.audio?.url
    if (typeof sourceUrl !== 'string' || sourceUrl === '') {
      return { ok: false, error: '语音合成没有返回音频地址' }
    }
    const audioResponse = await fetchImpl(sourceUrl)
    if (!audioResponse.ok) return { ok: false, error: `下载音频失败：HTTP ${audioResponse.status}` }
    const audio = Buffer.from(await audioResponse.arrayBuffer())
    if (audio.length === 0) return { ok: false, error: '音频是空的' }
    return {
      ok: true,
      audio,
      format: TEST_FORMAT,
      ms: Date.now() - started,
      sourceUrl,
      expiresAt: typeof payload?.output?.audio?.expires_at === 'number' ? payload.output.audio.expires_at : null,
    }
  } catch (error) {
    return { ok: false, error: `语音合成请求失败：${error?.message ?? error}` }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * How each emotion usually sounds when spoken.
 *
 * This is the fallback the director's own `speech.tone` beats: it keeps a line
 * from being read flat when the model only filled in the emotion field.
 */
export const EMOTION_TONE = {
  joy: '轻快、带笑意的语气',
  tender: '温柔、放轻一点',
  shy: '小声、有点害羞',
  sad: '低落，语速慢一点',
  anger: '压着火气，低声说',
  annoyed: '有点不耐烦的语气',
  surprise: '惊讶，语调上扬',
  fear: '发着抖，小声紧张',
  lonely: '轻轻叹气似的',
  sleepy: '困倦、含糊一点',
  calm: '平稳、安静的语调',
  smug: '得意，尾音微微上扬',
  curious: '好奇，语速稍快',
  neutral: '自然、平实的语气',
}

/**
 * Decide how one line is spoken.
 *
 * The model that wrote the line is the best judge of its delivery, so its
 * `speech` values win; the settings are the fallback, and the emotion map is the
 * last resort. `ttsModelControls: false` pins everything to the settings.
 *
 * @param options - `{ emotion, requested, defaults, modelControls }`.
 *   `requested` is the model's `{ rate, pitch, tone }`; `defaults` comes from settings.
 * @returns `{ rate, pitch, instruction, source }` — `source` is `model`, `settings` or `fallback`.
 */
export function resolveSpeechParams(options = {}) {
  const clamp = (value, low, high) => {
    const number = Number(value)
    return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : undefined
  }
  const defaults = options.defaults ?? {}
  const rate = clamp(defaults.rate, 0.5, 2) ?? 1
  const pitch = clamp(defaults.pitch, 0.5, 2) ?? 1
  const defaultInstruction = String(defaults.instruction ?? '').trim()
  if (options.modelControls === false) {
    return { rate, pitch, instruction: defaultInstruction, source: 'settings' }
  }
  const asked = options.requested !== null && typeof options.requested === 'object' ? options.requested : {}
  const askedRate = clamp(asked.rate, 0.5, 2)
  const askedPitch = clamp(asked.pitch, 0.5, 2)
  const askedTone = typeof asked.tone === 'string' ? asked.tone.trim().slice(0, 80) : ''
  const emotion = String(options.emotion ?? '').trim()
  const instruction = askedTone !== ''
    ? askedTone
    : defaultInstruction !== ''
      ? defaultInstruction
      : (EMOTION_TONE[emotion] ?? EMOTION_TONE.neutral)
  const fromModel = askedTone !== '' || askedRate !== undefined || askedPitch !== undefined
  return {
    rate: askedRate ?? rate,
    pitch: askedPitch ?? pitch,
    instruction,
    source: fromModel ? 'model' : 'fallback',
  }
}

/** Voice management lives beside synthesis, on the same customization endpoint. */
export const CUSTOMIZATION_PATH = '/api/v1/services/audio/tts/customization'

/** Models that accept a cloned voice; the clone is bound to one of these at creation. */
export const CLONE_MODELS = [
  'qwen-audio-3.1-tts-plus',
  'qwen-audio-3.1-tts-flash',
  'qwen-audio-3.0-tts-plus',
  'qwen-audio-3.0-tts-flash',
  'cosyvoice-v3.5-plus',
  'cosyvoice-v3.5-flash',
  'cosyvoice-v3-plus',
  'cosyvoice-v3-flash',
]

/** Longest sample the platform accepts, in bytes (60 s of 16-bit wav is far below this). */
export const CLONE_AUDIO_MAX_BYTES = 10 * 1024 * 1024

/**
 * Whether a name is usable as a voice prefix.
 *
 * The platform allows letters and digits only, at most ten characters; the final
 * id becomes `{model}-{prefix}-{suffix}`.
 *
 * @param text - Candidate prefix.
 * @returns True when the platform would accept it.
 */
export function isValidVoicePrefix(text) {
  return /^[A-Za-z0-9]{1,10}$/.test(String(text ?? ''))
}

/**
 * Call the voice-management endpoint.
 *
 * @param options - `{ apiKey, baseUrl, input, fetchImpl, timeoutMs }`.
 * @returns The parsed `output`, or `{ error }`.
 */
async function customization(options) {
  const apiKey = String(options.apiKey ?? '').trim()
  if (apiKey === '') return { error: '还没有 API Key，先在「语音」里填一个' }
  const baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '') || 'https://maas.qianwenaiapi.com'
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { error: '这个运行时没有 fetch' }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${baseUrl}${CUSTOMIZATION_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'voice-enrollment', input: options.input }),
      ...(controller === null ? {} : { signal: controller.signal }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = payload?.message ?? payload?.error?.message ?? `HTTP ${response.status}`
      return { error: String(detail) }
    }
    return payload?.output ?? { error: '平台没有返回结果' }
  } catch (error) {
    return { error: `请求失败：${error?.message ?? error}` }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * Clone a voice from a sample recording.
 *
 * @param options - `{ apiKey, baseUrl, targetModel, prefix, audio, fetchImpl, timeoutMs }`;
 *   `audio` is a public URL or a `data:audio/...;base64,…` URI.
 * @returns `{ ok: true, voiceId }` or `{ ok: false, error }`.
 */
export async function cloneVoice(options = {}) {
  const targetModel = String(options.targetModel ?? '').trim()
  if (!CLONE_MODELS.includes(targetModel)) {
    return { ok: false, error: `这个模型不支持复刻音色：${targetModel || '（空）'}` }
  }
  const prefix = String(options.prefix ?? '').trim()
  if (!isValidVoicePrefix(prefix)) {
    return { ok: false, error: '音色名只能用英文字母和数字，最多 10 个字符' }
  }
  const audio = String(options.audio ?? '').trim()
  if (audio === '') return { ok: false, error: '没有收到参考音频' }
  if (!/^https?:\/\//i.test(audio) && !/^data:audio\//i.test(audio)) {
    return { ok: false, error: '参考音频必须是公网 URL 或 data:audio/... 的 Base64' }
  }
  const output = await customization({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    input: { action: 'create_voice', target_model: targetModel, prefix, audio },
  })
  if (output.error !== undefined) return { ok: false, error: output.error }
  const voiceId = String(output.voice_id ?? output.voiceId ?? '')
  if (voiceId === '') return { ok: false, error: '平台没有返回音色 ID' }
  return { ok: true, voiceId, targetModel }
}

/**
 * List the clones this account already owns.
 *
 * @param options - `{ apiKey, baseUrl, prefix, fetchImpl, timeoutMs }`.
 * @returns `{ ok: true, voices: [{ id, targetModel }] }` or `{ ok: false, error }`.
 */
export async function listClonedVoices(options = {}) {
  const output = await customization({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    input: {
      action: 'list_voice',
      ...(isValidVoicePrefix(options.prefix) ? { prefix: String(options.prefix) } : {}),
      page_index: 0,
      page_size: 100,
    },
  })
  if (output.error !== undefined) return { ok: false, error: output.error }
  const raw = output.voices ?? output.voice_list ?? output.data ?? output.items
  const voices = (Array.isArray(raw) ? raw : []).map((entry) => {
    const id = String(entry?.voice_id ?? entry?.voiceId ?? entry?.id ?? '')
    return {
      id,
      targetModel: String(entry?.target_model ?? entry?.targetModel ?? '') || cloneModelFromId(id),
    }
  }).filter(voice => voice.id !== '')
  return { ok: true, voices }
}

/**
 * Delete one cloned voice.
 *
 * @param options - `{ apiKey, baseUrl, voiceId, fetchImpl, timeoutMs }`.
 * @returns `{ ok: true }` or `{ ok: false, error }`.
 */
export async function deleteClonedVoice(options = {}) {
  const voiceId = String(options.voiceId ?? '').trim()
  if (voiceId === '') return { ok: false, error: 'voiceId 为空' }
  const output = await customization({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    input: { action: 'delete_voice', voice_id: voiceId },
  })
  if (output.error !== undefined) return { ok: false, error: output.error }
  return { ok: true }
}

/**
 * Which model a voice id belongs to, when the list API does not say.
 *
 * Ids are shaped `{target_model}-{prefix}-{suffix}`, and model names contain
 * dashes, so the known model list is matched longest-first rather than split.
 *
 * @param voiceId - Voice id from `list_voice`.
 * @returns The model id, or an empty string when nothing matches.
 */
export function cloneModelFromId(voiceId) {
  const id = String(voiceId ?? '')
  const matches = CLONE_MODELS.filter(model => id.startsWith(`${model}-`))
  return matches.sort((left, right) => right.length - left.length)[0] ?? ''
}
