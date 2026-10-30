/**
 * Build the bundled TTS voice catalog from the official voice-list page.
 *
 * The model list is fetched live from the platform (it depends on the account's
 * entitlements), but the system voices and their language coverage are a published
 * table: bundling them keeps the settings panel useful before any API key exists,
 * and lets the panel warn about a voice/language mismatch without blocking it.
 *
 *   node scripts/build-tts-catalog.mjs           # fetch and write assets/tts-voices.json
 *   node scripts/build-tts-catalog.mjs --local path/to/voices.md
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = 'https://platform.qianwenai.com/docs/developer-guides/speech/voice-list/qwen-audio-tts'
const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'assets', 'tts-voices.json')

/** A model section starts with `### <id> <span …>`; sub-tabs inside it are `<Tab title="…">`. */
const MODEL_HEADING = /^###\s+([a-z0-9.\-]+)\s+<span/

/** Chinese language names → the codes `language_hints` accepts. */
const LANGUAGE_CODES = {
  中文: 'zh',
  普通话: 'zh',
  英语: 'en',
  日语: 'ja',
  韩语: 'ko',
  法语: 'fr',
  德语: 'de',
  西班牙语: 'es',
  意大利语: 'it',
  葡萄牙语: 'pt',
  俄语: 'ru',
  阿拉伯语: 'ar',
  泰语: 'th',
  印尼语: 'id',
  越南语: 'vi',
  马来语: 'ms',
  菲律宾语: 'fil',
}

/**
 * Which languages one tab of the voice table covers.
 *
 * The page states coverage per tab ("以下四个音色均支持下列全部方言和语言"), and a
 * Chinese-only tab says so in its title. A tab that says nothing yields `null`,
 * which the panel reads as "unknown — do not warn".
 *
 * @param title - Tab title, e.g. 旗舰音色 / 多语种与方言音色 / 精品中文音色.
 * @param text - That tab's body.
 * @returns Language codes, or null when the page does not say.
 */
function languagesOf(title, text) {
  const declared = /语言[：:]\s*([^\n<]+)/.exec(text)
  if (declared !== null) {
    const codes = declared[1]
      .split(/[、,，\s]+/)
      .map(name => LANGUAGE_CODES[name.trim()])
      .filter(code => typeof code === 'string')
    if (codes.length > 0) return [...new Set(['zh', ...codes])]
  }
  if (/中文/.test(title)) return ['zh']
  return null
}

/**
 * Parse one voice table into rows.
 *
 * @param text - Markdown/HTML hybrid of one tab.
 * @param languages - Language codes the tab covers, or null.
 * @returns Voice entries, in document order.
 */
function parseVoices(text, languages) {
  const voices = []
  const pattern = /名称\*\*:\s*([^\n]+?)\s*\n?\s*\*\*voice 参数\*\*:\s*<code>([^<]+)<\/code>([\s\S]*?)(?=<tr>|<\/tbody>|$)/g
  for (const match of text.matchAll(pattern)) {
    const name = match[1].replace(/\\/g, '').trim()
    const id = match[2].replace(/\\/g, '').trim()
    const tail = match[3]
    const gender = /<\/td>\s*<td[^>]*>\s*(女|男)\s*<\/td>/.exec(tail)?.[1] ?? ''
    const flag = (label) => new RegExp(`${label}:\\s*支持`).test(tail)
    voices.push({
      id,
      name,
      gender: gender === '女' ? 'female' : gender === '男' ? 'male' : '',
      ssml: flag('SSML'),
      instruction: flag('指令控制'),
      timestamp: flag('时间戳'),
      languages,
    })
  }
  return voices
}

const localIndex = process.argv.indexOf('--local')
const text = localIndex !== -1
  ? await readFile(process.argv[localIndex + 1], 'utf8')
  : await (async () => {
    const response = await fetch(`${SOURCE}.md`)
    if (!response.ok) throw new Error(`voice list returned ${response.status}`)
    return response.text()
  })()

/** Split by model heading; a `####` or `<Tab>` inside stays with its model. */
const models = []
let current = null
for (const line of text.split('\n')) {
  const heading = MODEL_HEADING.exec(line)
  if (heading !== null) {
    current = { id: heading[1], lines: [] }
    models.push(current)
    continue
  }
  if (current !== null && /^#{1,2}\s/.test(line)) current = null
  if (current !== null) current.lines.push(line)
}

/**
 * Walk one model section, splitting it into tabs.
 *
 * @param lines - The section body.
 * @returns `[{ title, body }]`; text before the first tab keeps an empty title.
 */
function splitTabs(lines) {
  const tabs = [{ title: '', body: [] }]
  for (const line of lines) {
    const tab = /<Tab title="([^"]+)"/.exec(line)
    if (tab !== null) {
      tabs.push({ title: tab[1], body: [] })
      continue
    }
    tabs[tabs.length - 1].body.push(line)
  }
  return tabs.map(tab => ({ title: tab.title, body: tab.body.join('\n') }))
}

const catalog = {
  version: 2,
  source: SOURCE,
  fetchedAt: new Date().toISOString(),
  models: models
    .map((model) => {
      const voices = []
      for (const tab of splitTabs(model.lines)) {
        const languages = languagesOf(tab.title, tab.body)
        for (const voice of parseVoices(tab.body, languages)) {
          if (voices.some(seen => seen.id === voice.id)) continue
          voices.push(voice)
        }
      }
      return { id: model.id, voices }
    })
    .filter(model => model.voices.length > 0),
}

await writeFile(target, `${JSON.stringify(catalog, null, 2)}\n`)
const total = catalog.models.reduce((sum, model) => sum + model.voices.length, 0)
const known = catalog.models.reduce((sum, model) => sum + model.voices.filter(voice => Array.isArray(voice.languages)).length, 0)
console.log(`wrote ${target}`)
for (const model of catalog.models) console.log(`  ${model.id}: ${model.voices.length} voices`)
console.log(`total ${total} voices, ${known} with language coverage`)
