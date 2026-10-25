/**
 * dsh-live-tavern — Host half.
 *
 * Owns everything the browser half cannot: the same-origin model file routes,
 * the Cubism runtime script injected into the page head before any client
 * bundle evaluates, the stage event stream, and the calibration binding file.
 *
 * The plugin renders nothing on the Host. It serves bytes and holds state.
 */

import { copyFileSync, createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, isAbsolute, dirname, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  buildDirectorPrompt,
  extractText,
  mergeDirectorMemory,
  parseDirectorReply,
  pushDigest,
  resolveDirectorConfig,
} from './director.mjs'
import {
  normalizeCard,
  normalizeWorldBook,
  planWorldBook,
  renderCardSection,
  renderWorldBookSection,
} from './pack.mjs'
import { loadRig, normalizeRig, resolveRig } from './rig.mjs'
import { buildRounds, readRounds, searchRounds, trimTranscript } from './recall.mjs'
import { consolidate, mergeMemories } from './memory.mjs'
import { trimToSentence } from './speech.mjs'
import { parseTracks } from './tracks.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** A turn may update the stage this many times before something is looping. */
const STAGE_UPDATES_CEILING = 12

const ROUTE_PREFIX = '/dsh-live-tavern-lite'
/** Diagnostic identity of the loaded Host module; a stale process reports none. */
const HOST_VERSION = '0.2.0-rig'
const CORE_ASSET = join(PACKAGE_ROOT, 'assets', 'vendor', 'live2dcubismcore.min.js')
const EMOTIONS_ASSET = join(PACKAGE_ROOT, 'assets', 'emotions.json')
/** Built-in meaning for every standard VRM humanoid bone channel. */
const VRM_DEFAULTS_ASSET = join(PACKAGE_ROOT, 'assets', 'vrm-channel-defaults.json')
/** Named semantic poses: the layer between "道歉" and 153 bone channels. */
const POSE_RECIPES_ASSET = join(PACKAGE_ROOT, 'assets', 'pose-recipes.json')
/** The body state every pose starts from: arms down instead of a T-pose. */
const POSE_BASE_ASSET = join(PACKAGE_ROOT, 'assets', 'pose-base.json')
/** The measured control guide, handed to the model on request. */
const VRM_GUIDE_ASSET = join(PACKAGE_ROOT, 'assets', 'vrm-control-guide.md')
const RIG_ASSET = join(PACKAGE_ROOT, 'assets', 'emotion-rig.json')
/**
 * Longest keyframe text one call may carry.
 *
 * 22 channels × 8 beats needed ~4 kB and got silently cut at the old 4000 cap, which made
 * long routines impossible; 20000 fits a full 30-beat pass with hips and fingers keyed.
 */
// 上限已取消：nimation 长度不再裁剪（Infinity 让各处 slice 变成空操作）
const ANIMATION_LIMIT = Number.POSITIVE_INFINITY
const MODEL_SUFFIXES = ['.model3.json', '.model.json']
/** Working range per bone channel, in degrees; the workbench slider spans it. */
/** Parsed VRM channel lists, keyed by file path and mtime. */
const VRM_CHANNEL_CACHE = new Map()

/** The channel list for a model, cached against the file's mtime. */
function vrmChannelsFor(file) {
  try {
    const stamp = statSync(file).mtimeMs
    const hit = VRM_CHANNEL_CACHE.get(file)
    if (hit !== undefined && hit.stamp === stamp) return hit.channels
    const channels = readVrmChannels(file)
    VRM_CHANNEL_CACHE.set(file, { stamp, channels })
    return channels
  } catch {
    return []
  }
}

/** Which body part a channel belongs to, for grouped listings and queries. */
function channelGroup(id) {
  const name = id.replace(/^Bone/, '').toLowerCase()
  if (/thumb|index|middle|ring|little/.test(name)) return 'finger'
  if (/head|neck|jaw/.test(name)) return 'head'
  if (/shoulder|arm|hand/.test(name)) return 'arm'
  if (/leg|foot|toe/.test(name)) return 'leg'
  if (/hips|spine|chest/.test(name)) return 'torso'
  return 'other'
}

const VRM_CHANNEL_RANGE = {
  BoneHeadX: [-40, 40],
  BoneHeadY: [-50, 50],
  BoneHeadZ: [-45, 45],
  BoneNeckY: [-35, 35],
  BoneSpineX: [-25, 25],
  BoneSpineY: [-30, 30],
  BoneSpineZ: [-30, 30],
  BoneChestZ: [-20, 20],
  BoneHipsY: [-25, 25],
  BoneLeftUpperArmZ: [-90, 90],
  BoneRightUpperArmZ: [-90, 90],
}

/** Bone channels the browser half drives on a VRM model, in degrees. */
const VRM_CHANNELS = [
  'BoneHeadX', 'BoneHeadY', 'BoneHeadZ',
  'BoneNeckY',
  'BoneSpineX', 'BoneSpineY', 'BoneSpineZ',
  'BoneChestZ', 'BoneHipsY',
  'BoneLeftUpperArmZ', 'BoneRightUpperArmZ',
]
/** 3D model formats the stage can mount instead of a Live2D model. */
const VRM_SUFFIXES = ['.vrm']
const DEFAULT_MAX_BINDING_BYTES = 256 * 1024
/** Prompt position: tool guidance, right after the goal tool, before workflow tooling. */
const SECTION_ORDER_OFFSET = 10

const MIME = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.moc3', 'application/octet-stream'],
  ['.moc', 'application/octet-stream'],
  ['.vrm', 'model/gltf-binary'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
])

/** Hard dependency: every capability of this plugin is an HTTP route. */
export const inject = ['webServer']

/** One model directory the stage can load. */
function describeModel(root, id, entryFile, kind = 'live2d') {
  return {
    id,
    dir: root,
    kind,
    entryFile,
    entryUrl: `${ROUTE_PREFIX}/models/${encodeURIComponent(id)}/${entryFile.split('/').map(encodeURIComponent).join('/')}`,
  }
}

function stringList(value) {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean)
  return String(value).split(',').map(item => item.trim()).filter(Boolean)
}

/**
 * Resolve the configured seats.
 *
 * The mobile runtime has two seats only: the chat-column background and the foreground overlay.
 * A sidebar seat there would be a third DOM anchor the phone shell does not provide, so it is
 * dropped rather than rendered empty.
 *
 * @param value - Configured placement value: string or list.
 * @param mobile - True on the mobile runtime.
 * @returns Placement names, primary first.
 */
function resolvePlacement(value, mobile = false) {
  const known = new Set(['chat', 'foreground', 'sidebar'])
  const list = stringList(value)
  if (list.length === 0) return ['chat']
  const unknown = list.filter(item => !known.has(item))
  if (unknown.length > 0) {
    throw new Error(`dsh-live-tavern-lite: placement entries must be one of ${[...known].join(', ')} — got '${unknown.join("', '")}'`)
  }
  // A stored sidebar is a platform fact, not a typo: the phone shell drops the seat instead of
  // failing to boot because a desktop profile already asked for it.
  const usable = mobile ? list.filter(item => item !== 'sidebar') : list
  return usable.length === 0 ? ['chat'] : [...new Set(usable)]
}

function resolveLod(value) {
  if (value === false || value === 'false') return false
  if (value === undefined || value === null || value === '') return 'full'
  if (value === 'full' || value === 'single-auto') return value
  throw new Error("dsh-live-tavern-lite: textureLod must be 'full', 'single-auto' or false")
}

function numberOr(value, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`dsh-live-tavern-lite: ${field} must be a finite number — got '${value}'`)
  return parsed
}

/**
 * Every deployment-varying choice, described once for the settings page.
 *
 * The same descriptors drive the HTTP validation and the rendered form, so a new
 * option cannot appear in the UI without being validated here.
 */
const SETTINGS_FIELDS = [
  {
    key: 'placement',
    kind: 'select',
    options: ['chat', 'foreground', 'sidebar'],
    // The stored values stay English; the labels are what the form shows.
    optionLabels: { chat: '聊天区底部', foreground: '前景浮层', sidebar: '侧栏' },
    label: '展示位置',
    hint: '角色出现在哪一层',
  },
  // Platform capability, not a preference: hidden from the form, still validated and defaulted.
  { key: 'vrmStage', kind: 'select', options: ['auto', 'off'], hidden: true },
  { key: 'mobileUi', kind: 'select', options: ['auto', 'on'], hidden: true },
  { key: 'model', kind: 'text', label: '模型', hidden: true },
  { key: 'pack', kind: 'text', label: '角色包', wide: true, pick: 'directory', hint: '选角色包文件夹：模型必需，人物卡／世界书／映射表／记忆可缺；off=只放模型' },
  { key: 'playerName', kind: 'text', label: '玩家称呼', hint: '{{user}} 渲染成什么' },
  { key: 'textureLod', kind: 'select', options: ['full', 'single-auto'], label: '纹理 LOD', hint: 'full=原尺寸纹理；single-auto=显存吃紧时自动降档，模型会略糊' },
  { key: 'opacity', kind: 'number', label: '不透明度', hint: '0.1–1。1 为完全不透明，越低越像半透明贴纸' },
  { key: 'springGravity', kind: 'number', kinds: ['vrm'], label: '物理重力', hint: '额外下垂力：0=模型自带，数值越大头发裙摆越往下坠（0–20）' },
  { key: 'springStrength', kind: 'number', kinds: ['vrm'], label: '物理强度', hint: '头发与裙摆的弹簧骨强度：1=模型自带；调高更软更快下垂（0–5），调低更挺' },
  { key: 'widthCap', kind: 'number', label: '最大宽度占比', hint: '模型最多占舞台宽度的多少：宽幅模型会自动缩小到这条线以内（0.2–1，1=允许铺满）' },
  { key: 'hitBoxScale', kind: 'number', label: '可点击范围', hint: '点击/拖动响应区域相对模型的倍数：1=贴着轮廓，1.4=更大一圈，0.7=更只认身体中心' },
  { key: 'lookAtPointer', kind: 'boolean', label: '看向鼠标', hint: '开启后视线跟随指针；关掉则头部与眼睛完全由情绪和动画控制' },
  {
    key: 'memoryScope',
    kind: 'select',
    label: '记忆范围',
    options: ['session', 'all'],
    optionLabels: { session: '只本会话', all: '按会话累加' },
    hint: '只本会话=只用当前会话的记忆；按会话累加=合并本角色所有非跨会话会话的记忆',
    showWhen: { key: 'director', equals: true },
  },
  { key: 'sessionMaxFacts', kind: 'number', label: '单会话记忆上限', hint: '每个会话各自保留多少条事实，默认 24' },
  {
    key: 'recallScope',
    kind: 'select',
    label: '原文检索范围',
    options: ['session', 'character'],
    optionLabels: { session: '只本会话', character: '本角色所有会话' },
    hint: 'live2d_recall 查哪些对话原文；跨会话时选后者才能翻到别的会话说过的话',
  },
  {
    key: 'interaction',
    kind: 'boolean',
    label: '互动模式',
    hint: '开启后点击或拖动模型会触发场外模型回应（只在跨会话模式下生效）',
    showWhen: { key: 'director', equals: true },
  },
  { key: 'director', kind: 'boolean', label: '跨会话模式', hint: '开启后由会话外的模型决定她的情绪，跨会话记住印象' },
  // The two halves of one choice: rendered as a single composer-style picker,
  // so they stay out of the generic grid but keep their defaults and validation.
  { key: 'directorProvider', kind: 'text', label: '跨会话模型', hidden: true },
  { key: 'directorModel', kind: 'text', label: '跨会话模型', hidden: true },
  { key: 'directorEffort', kind: 'text', label: '思考强度', hidden: true },
  {
    key: 'stageEveryTurns',
    kind: 'number',
    label: '表情更新间隔(轮)',
    hint: '每 N 轮更新一次表情，两种模式都生效：1=每轮。跨会话模式下由场外模型按这个节奏接管；非跨会话模式下它限制 live2d_act 的调用轮次。',
  },
  {
    key: 'stageUpdatesPerTurn',
    kind: 'number',
    label: '每轮至少更新几次',
    hint: '一轮对话里至少更新几次表情/动作（下限，不是上限）。设 2 时，思考中动一次、写完正文再动一次。',
  },
  { key: 'directorMaxCallsPerHour', kind: 'number', label: '跨会话每小时上限', hint: '场外模型一小时最多被调用几次；防跑飞的硬上限' },
  { key: 'directorMaxFacts', kind: 'number', label: '跨会话记忆条数上限', hint: '合并多会话记忆后，一轮最多带几条进提示词' },
  {
    key: 'directorMaxTokens',
    kind: 'number',
    label: '跨会话输出上限',
    hint: '场外模型一次最多输出多少 token，默认 4096',
  },
  { key: 'worldbookBudgetTokens', kind: 'number', label: '世界书 token 预算', hint: '一轮世界书最多占多少 token；超出的条目按顺序丢弃' },
  {
    key: 'rigMaxTokens',
    kind: 'number',
    label: '映射表输出上限',
    hint: '生成映射表时一次最多输出多少 token；被截断会自动翻倍重试一次',
  },
  { key: 'worldbookScanDepth', kind: 'number', label: '世界书扫描条数', hint: '往前回看多少条对话来匹配关键词，默认 8' },
  { key: 'worldbookCooldownRounds', kind: 'number', label: '世界书冷却轮数', hint: '同一条目命中后要隔多少轮才能再次注入，避免刷屏' },
]

/** Keys the settings file may carry; anything else in it is ignored. */
const SETTINGS_KEYS = SETTINGS_FIELDS.map(field => field.key)

/** Validate one settings patch; unknown keys and wrong shapes fail loud. */
function validateSettingsPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('settings must be a JSON object')
  }
  const clean = {}
  for (const [key, value] of Object.entries(patch)) {
    const field = SETTINGS_FIELDS.find(candidate => candidate.key === key)
    if (field === undefined) throw new Error(`unknown setting '${key}'`)
    if (field.kind === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
      clean[key] = value
    } else if (field.kind === 'number') {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) throw new Error(`${key} must be a finite number`)
      clean[key] = parsed
    } else if (field.kind === 'select') {
      if (!field.options.includes(String(value))) throw new Error(`${key} must be one of ${field.options.join('/')}`)
      clean[key] = String(value)
    } else {
      if (typeof value !== 'string') throw new Error(`${key} must be a string`)
      clean[key] = value.trim()
    }
  }
  return clean
}

/**
 * Resolve the plugin config once, at load.
 *
 * Values stored by the settings page live in `<DSH_HOME>/live2d/settings.json`
 * and are layered over the Cordis row, so a GUI edit survives a reinstall while
 * the patch keeps a working default. Every deployment-varying choice is a config
 * field; a bad value fails the plugin here instead of silently producing an empty
 * stage later.
 */
function resolveConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? resolve(process.env.DSH_HOME)
    : join(homedir(), '.dsh')
  const defaults = join(home, 'live2d')
  const settingsFile = join(defaults, 'settings.json')
  const stored = readJsonSync(settingsFile)
  const overlay = stored !== null && typeof stored === 'object' && !Array.isArray(stored)
    ? Object.fromEntries(Object.entries(stored).filter(([key]) => SETTINGS_KEYS.includes(key)))
    : {}
  const merged = { ...config, ...overlay }
  const cubismCore = resolve(String(merged.cubismCore && String(merged.cubismCore).trim() || CORE_ASSET))
  // The model and the pack are picked with a folder chooser, so either field may
  // hold an absolute path. A path names the folder itself; its parent becomes the
  // root and its last segment the id, which keeps every `join(root, id)` working.
  const modelRaw = String(merged.model ?? '').trim()
  const modelsRoot = modelRaw !== '' && isAbsolute(modelRaw)
    ? dirname(resolve(modelRaw))
    : resolve(String(merged.modelsRoot && String(merged.modelsRoot).trim() || join(defaults, 'models')))
  const model = modelRaw !== '' && isAbsolute(modelRaw) ? basename(resolve(modelRaw)) : modelRaw
  const packRaw = String(merged.pack ?? '').trim()
  const packsRoot = packRaw !== '' && isAbsolute(packRaw)
    ? dirname(resolve(packRaw))
    : resolve(String(merged.packsRoot && String(merged.packsRoot).trim() || join(defaults, 'packs')))
  const pack = packRaw !== '' && isAbsolute(packRaw) ? basename(resolve(packRaw)) : packRaw
  return {
    settingsFile,
    settingsOverlay: overlay,
    /** Row config with the settings file layered on: the director reads this. */
    merged,
    modelsRoot,
    cubismCore,
    model,
    /** What the settings field shows: the id, or the picked absolute path. */
    modelRaw,
    placement: resolvePlacement(
      merged.placement,
      merged.mobileUi === 'on' || process.platform === 'android',
    ),
    calibrate: merged.calibrate !== false,
    textureLod: resolveLod(merged.textureLod),
    opacity: numberOr(merged.opacity, 1, 'opacity'),
    /** Eyes and head follow the pointer only when asked to. */
    lookAtPointer: merged.lookAtPointer === true,
    /** Absolute gravity added to every spring joint; 0 keeps the model's own. */
    vrmStage: merged.vrmStage === 'off' ? 'off' : 'auto',
    mobileUi: merged.mobileUi === 'on' ? 'on' : 'auto',
    springGravity: (() => {
      const value = Number(merged.springGravity)
      if (!Number.isFinite(value)) return 0
      return Math.min(20, Math.max(0, value))
    })(),
    /** How long one pose stays on screen before the next queued pose replaces it. */
    /** Multiplier on the authored spring-bone response; 1 keeps the model's own. */
    springStrength: (() => {
      const value = Number(merged.springStrength)
      if (!Number.isFinite(value)) return 1
      return Math.min(5, Math.max(0, value))
    })(),
    /** Widest the model may render, as a fraction of the stage width. */
    widthCap: (() => {
      const value = Number(merged.widthCap)
      if (!Number.isFinite(value)) return 0.6
      return Math.min(1, Math.max(0.2, value))
    })(),
    /** Multiplier on the character rectangle used for tap and drag hits. */
    hitBoxScale: (() => {
      const value = Number(merged.hitBoxScale)
      if (!Number.isFinite(value)) return 1
      return Math.min(2, Math.max(0.2, value))
    })(),
    /** Clicks and drags on the model reach the judge. */
    interaction: merged.interaction === true,
    /** How many stage updates one turn may carry. */
    stageUpdatesPerTurn: numberOr(merged.stageUpdatesPerTurn, 2, 'stageUpdatesPerTurn'),
    /** How often the stage may change, counted in turns. */
    stageEveryTurns: numberOr(
      merged.stageEveryTurns === undefined ? merged.directorEveryTurns : merged.stageEveryTurns,
      1,
      'stageEveryTurns',
    ),
    /** `session` keeps memory inside one conversation; `all` merges the character's others. */
    memoryScope: merged.memoryScope === 'all' ? 'all' : 'session',
    sessionMaxFacts: numberOr(merged.sessionMaxFacts, 24, 'sessionMaxFacts'),
    /** `session` recalls this conversation only; `character` searches every session. */
    recallScope: merged.recallScope === 'character' ? 'character' : 'session',
    maxBindingBytes: numberOr(merged.maxBindingBytes, DEFAULT_MAX_BINDING_BYTES, 'maxBindingBytes'),
    /** Cross-session director memory lives beside the models, not inside them. */
    memoryFile: join(dirname(modelsRoot), 'director', 'memory.json'),
    packsRoot,
    pack,
    /** What the settings field shows: the id, or the picked absolute path. */
    packRaw,
    worldbookBudgetTokens: numberOr(merged.worldbookBudgetTokens, 8_192, 'worldbookBudgetTokens'),
    rigMaxTokens: numberOr(merged.rigMaxTokens, 4_096, 'rigMaxTokens'),
    worldbookScanDepth: numberOr(merged.worldbookScanDepth, 8, 'worldbookScanDepth'),
    worldbookCooldownRounds: numberOr(merged.worldbookCooldownRounds, 2, 'worldbookCooldownRounds'),
    /** Name `{{user}}` renders as inside card and lore text. */
    playerName: String(merged.playerName ?? '').trim() || '玩家',
    /** Built-in values the per-field reset buttons restore. */
    defaults: {
      placement: 'chat',
      model: '',
      pack: '',
      playerName: '玩家',
      textureLod: 'full',
      opacity: 1,
      lookAtPointer: false,
      hitBoxScale: 1,
      vrmStage: 'auto',
    mobileUi: 'auto',
    springGravity: 0,
      springStrength: 1,
        widthCap: 0.6,
      memoryScope: 'session',
      sessionMaxFacts: 24,
      recallScope: 'session',
      director: true,
      directorProvider: '',
      directorModel: '',
      directorEffort: '',
      stageEveryTurns: 1,
      stageUpdatesPerTurn: 2,
      interaction: false,
      directorMaxCallsPerHour: 60,
      directorMaxFacts: 24,
      directorMaxTokens: 4096,
      worldbookBudgetTokens: 8192,
      rigMaxTokens: 4096,
      worldbookScanDepth: 8,
      worldbookCooldownRounds: 2,
    },
  }
}

function mimeOf(file) {
  return MIME.get(extname(file).toLowerCase()) ?? 'application/octet-stream'
}

function cacheControlOf(file) {
  const extension = extname(file).toLowerCase()
  return extension === '.json' ? 'no-cache' : 'public, max-age=86400'
}

/** True when `candidate` resolves inside `root` (equal to root is rejected). */
function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function serveFile(req, res, filePath, { allowHead = true } = {}) {
  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    throw error
  }
  if (!info.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'content-type': mimeOf(filePath),
    'content-length': info.size,
    'cache-control': cacheControlOf(filePath),
  })
  if (allowHead && req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(filePath)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error(`request body exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeJsonAtomic(file, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`
  // Keep the previous revision beside the new one: a file a person typed by hand
  // must not be lost to an accidental overwrite.
  try {
    await copyFile(file, `${file}.bak`)
  } catch {
    // A first write has nothing to copy; that is not a failure.
  }
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`)
  await writeFile(temporary, body, 'utf8')
  await rename(temporary, file)
}

/**
 * The bone channels a VRM actually exposes, read from its own JSON.
 *
 * A VRM declares its humanoid bones; the workbench should list exactly those rather than
 * a hand-picked handful, otherwise the panel looks like it is hiding parameters. Only the
 * eye bones are skipped — they belong to the look-at target, not to a gesture.
 *
 * @param file - Absolute path to the `.vrm`.
 * @returns Channel descriptors `{ id, bone, axis, min, max }`, or an empty list.
 */
function readVrmChannels(file) {
  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return []
  }
  if (buffer.length < 20 || buffer.toString('ascii', 0, 4) !== 'glTF') return []
  try {
    const jsonLength = buffer.readUInt32LE(12)
    const jsonType = buffer.toString('ascii', 16, 20)
    if (jsonType !== 'JSON') return []
    const json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength))
    const extensions = json?.extensions ?? {}
    const vrm1 = extensions.VRMC_vrm?.humanoid?.humanBones
    const vrm0 = extensions.VRM?.humanoid?.humanBones
    let names = []
    if (vrm1 !== null && typeof vrm1 === 'object') names = Object.keys(vrm1)
    else if (Array.isArray(vrm0)) names = vrm0.map(entry => entry?.bone).filter(name => typeof name === 'string')
    const bones = names
      .filter(name => !/eye/i.test(name))
      .filter(name => /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(name))
    const channels = []
    for (const bone of bones) {
      const pascal = bone.charAt(0).toUpperCase() + bone.slice(1)
      for (const [axis, range] of [['X', [-45, 45]], ['Y', [-45, 45]], ['Z', [-45, 45]]]) {
        // Arms swing much further than a spine joint.
        const wide = /arm|hand|shoulder/i.test(bone)
        channels.push({
          id: `Bone${pascal}${axis}`,
          bone,
          axis: axis.toLowerCase(),
          min: wide ? -110 : range[0],
          max: wide ? 110 : range[1],
        })
      }
    }
    return channels
  } catch {
    return []
  }
}

/** Where a pack keeps its model under the unified layout, or undefined. */
function packModelDir(packsRoot, id) {
  const nested = join(packsRoot, id, 'model')
  return existsSync(nested) ? nested : undefined
}

/**
 * The file a pack owns: `rig.json`, `params.json`, `memory.json`.
 *
 * A unified pack keeps its model under `model/`, so the file sits beside it at
 * the pack root; a legacy pack keeps the model in the models directory, and the
 * file has always lived there.
 *
 * @returns The path to write to.
 */
function packFilePath(config, id, name) {
  // A pack root is the home of its own files whenever it exists, whether the model
  // lives in `model/` or sits beside them as a single `.vrm`.
  if (existsSync(join(config.packsRoot, id))) return join(config.packsRoot, id, name)
  return join(config.modelsRoot, id, name)
}

/** Read a pack file from either layout, preferring the one that exists. */
async function readPackFile(config, id, name) {
  const candidates = [packFilePath(config, id, name), join(config.packsRoot, id, name), join(config.modelsRoot, id, name)]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const base = packModelDir(config.packsRoot, id) !== undefined ? join(config.packsRoot, id) : join(config.modelsRoot, id)
    if (!isInside(dirname(base), file) && !isInside(config.packsRoot, file)) return null
    return readJson(file)
  }
  return null
}

/** Find the model settings file at the top of one directory. */
async function describeDir(directory, id) {
  let files
  try {
    files = await readdir(directory)
  } catch {
    return undefined
  }
  for (const suffix of MODEL_SUFFIXES) {
    const match = files.find(name => name.toLowerCase().endsWith(suffix))
    if (match !== undefined) return describeModel(directory, id, match)
  }
  // No Live2D settings file: a 3D model is still a usable character.
  for (const suffix of VRM_SUFFIXES) {
    const match = files.find(name => name.toLowerCase().endsWith(suffix))
    if (match !== undefined) return describeModel(directory, id, match, 'vrm')
  }
  return undefined
}

/**
 * Where a configured pack path actually points, and whether a model lives there.
 *
 * A path that names a folder the user picked must not be trusted to contain a model: the
 * plugin reports what is missing and stays idle instead of trying to mount nothing.
 *
 * @param config - Resolved plugin config.
 * @param wanted - Pack id or absolute directory the settings name.
 * @returns `{ state, dir, described }` with state `empty`, `missing`, `no-model` or `ok`.
 */
async function inspectPackPath(config, wanted) {
  if (wanted === '') return { state: 'empty' }
  const candidates = [
    ...(await modelDirsFor(config, wanted)),
  ]
  const existing = candidates.filter(candidate => existsSync(candidate))
  // No directory at all is "missing"; a directory without a model file is a different answer,
  // because the two need different fixes.
  if (existing.length === 0) return { state: 'missing', dir: candidates[0] }
  for (const candidate of existing) {
    const described = await describeDir(candidate, wanted)
    if (described !== undefined) return { state: 'ok', dir: candidate, described }
  }
  return { state: 'no-model', dir: existing[0] }
}

/**
 * Every directory a pack id may put its model in.
 *
 * @param config - Resolved plugin config.
 * @param wanted - Pack id.
 * @returns Candidate directories, pack first, legacy model directory last.
 */
async function modelDirsFor(config, wanted) {
  const dirs = [join(config.packsRoot, wanted, 'model'), join(config.packsRoot, wanted), join(config.modelsRoot, wanted)]
  return dirs
}

/**
 * Every model this deployment can load.
 *
 * A unified pack contributes `packs/<id>/model`; a legacy model directory
 * under `modelsRoot` still counts, so an existing install keeps working without
 * moving 30 MB around.
 *
 * @param config - Resolved plugin config.
 * @param vrmAllowed - False drops VRM packs, which only the desktop stage can mount.
 * @returns Entries with `id`, `dir`, `entryFile`, `entryUrl`.
 */
async function listModelEntries(config, vrmAllowed = true) {
  const entries = new Map()
  let packs = []
  try {
    packs = readdirSync(config.packsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  for (const pack of packs) {
    // Unified packs keep the model under `model/`; a VRM pack often keeps its one
    // file at the pack root, so both places are checked.
    const nested = join(config.packsRoot, pack.name, 'model')
    const described = (existsSync(nested) ? await describeDir(nested, pack.name) : undefined)
      ?? await describeDir(join(config.packsRoot, pack.name), pack.name)
    if (described !== undefined) entries.set(pack.name, described)
  }
  let models = []
  try {
    models = readdirSync(config.modelsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  for (const model of models) {
    if (entries.has(model.name)) continue
    const described = await describeDir(join(config.modelsRoot, model.name), model.name)
    if (described !== undefined) entries.set(model.name, described)
  }
  // The VRM stage is a desktop-only capability: on Android those packs are not offered at all,
  // so nothing below has to know why they vanished.
  const visible = vrmAllowed === false
    ? [...entries.values()].filter(entry => (entry.kind ?? 'live2d') !== 'vrm')
    : [...entries.values()]
  return visible.sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }))
}

/** Every model directory that holds a Live2D settings file at its top level. */
async function scanModels(modelsRoot) {
  let entries
  try {
    entries = await readdir(modelsRoot, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const models = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(modelsRoot, entry.name)
    let files
    try {
      files = await readdir(directory)
    } catch {
      continue
    }
    // Prefer Cubism 3+ settings over the Cubism 2.1 `.model.json` form.
    let found
    for (const suffix of MODEL_SUFFIXES) {
      const match = files.find(name => name.toLowerCase().endsWith(suffix))
      if (match !== undefined) {
        found = { suffix, file: match }
        break
      }
    }
    if (found === undefined) continue
    models.push(describeModel(directory, entry.name, found.file))
  }
  models.sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }))
  return models
}

/** Expression names and motion groups a model declares, read from its settings file. */
async function readModelSettings(model) {
  const settings = await readJson(join(model.dir, model.entryFile))
  const references = settings && typeof settings.FileReferences === 'object' ? settings.FileReferences : {}
  const expressions = Array.isArray(references.Expressions)
    ? references.Expressions
      .map(item => (item && typeof item.Name === 'string' ? item.Name : undefined))
      .filter(name => name !== undefined)
    : []
  const motions = references.Motions && typeof references.Motions === 'object' ? references.Motions : {}
  const motionGroups = Object.entries(motions).map(([group, items]) => ({
    group,
    count: Array.isArray(items) ? items.length : 0,
  }))
  // The display-info file carries every parameter the editor knew, named or not.
  // It is the only file-level source for a full parameter list.
  let parameters = []
  if (typeof references.DisplayInfo === 'string') {
    const file = join(model.dir, references.DisplayInfo)
    if (isInside(model.dir, file) && existsSync(file)) {
      const info = await readJson(file)
      parameters = (Array.isArray(info?.Parameters) ? info.Parameters : [])
        .map(parameter => (parameter && typeof parameter.Id === 'string' ? parameter.Id : undefined))
        .filter(id => id !== undefined)
    }
  }
  return { expressions, motionGroups, parameters }
}

/**
 * The plugin entry.
 *
 * @param ctx - Cordis context with the `webServer` service.
 * @param rawConfig - Loader config from `cordis.patch.yml`.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** Number coercion that keeps "absent" distinct from "zero". */
function finite(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Load a JSON asset and keep it fresh while the process runs.
 *
 * A DSH plugin module is imported once per process, so tuning a weight used to
 * need a `dsh web` restart. Watching the file's mtime turns that into: edit,
 * save, next tool call. A half-written file keeps the last good copy instead of
 * taking the stage down.
 *
 * @param file - Absolute path of the JSON asset.
 * @param load - Validating loader for that asset.
 * @returns `get()` for the current value and `stamp()` for cache-busting.
 */
function watchAsset(file, load) {
  let stamp
  let value
  return {
    get() {
      let current
      try {
        current = statSync(file).mtimeMs
      } catch {
        current = stamp
      }
      if (value === undefined || current !== stamp) {
        try {
          value = load(file)
          stamp = current
        } catch (error) {
          if (value === undefined) throw error
        }
      }
      return value
    },
    stamp() {
      return stamp ?? 0
    },
  }
}

/**
 * Load and validate the shipped emotion prototype library.
 *
 * @param file - Absolute path of the library JSON.
 * @returns Prototypes, an id index and the default hold time.
 * @throws When the asset is unreadable or a prototype is malformed.
 */
/** The most presets one character pack may carry. */
const MAX_PRESETS = 32

/** A preset id: short, letters first, safe inside a parameter or a filename. */
const PRESET_ID = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/

/**
 * Validate the custom preset list a pack carries.
 *
 * A preset is a user-defined expression the model can name: an id, a label, the
 * model's own expression file, and the emotion vector it stands for. Bad values
 * fail loud at save time rather than silently doing nothing at act time.
 *
 * @param raw - Parsed `presets.json`.
 * @returns `{ version, presets }` with every field normalised.
 */
function normalizePresets(raw) {
  if (raw === null || raw === undefined) return { version: 1, presets: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-live-tavern-lite: presets must be a JSON object')
  }
  const list = Array.isArray(raw.presets) ? raw.presets : []
  if (list.length > MAX_PRESETS) {
    throw new Error(`dsh-live-tavern-lite: at most ${MAX_PRESETS} presets, got ${list.length}`)
  }
  const seen = new Set()
  const presets = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!PRESET_ID.test(id)) {
      throw new Error(`dsh-live-tavern-lite: preset id '${id}' must start with a letter and hold 1-24 letters, digits, - or _`)
    }
    if (seen.has(id)) throw new Error(`dsh-live-tavern-lite: preset '${id}' is declared twice`)
    seen.add(id)
    const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, 20) : ''
    const axis = (value) => Math.min(1, Math.max(-1, Number.isFinite(Number(value)) ? Number(value) : 0))
    presets.push({
      id,
      label: label === '' ? id : label,
      // The model's own expression file, empty when the preset only paints the rig.
      expression: typeof entry.expression === 'string' ? entry.expression.trim() : '',
      valence: axis(entry.valence),
      arousal: axis(entry.arousal),
      dominance: axis(entry.dominance),
      intensity: Math.min(1, Math.max(0, Number.isFinite(Number(entry.intensity)) ? Number(entry.intensity) : 0.5)),
      line: typeof entry.line === 'string' ? entry.line.trim().slice(0, 60) : '',
      // Concrete parameter values, set in the workbench: what makes a preset a
      // pose rather than just another emotion vector.
      params: (() => {
        const raw = entry.params
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
        const clean = {}
        let count = 0
        for (const [id, value] of Object.entries(raw)) {
          if (count >= 64) break
          if (!/^(?:Expr:)?[A-Za-z][A-Za-z0-9_]{0,63}$/.test(id)) continue
          const number = Number(value)
          if (!Number.isFinite(number)) continue
          clean[id] = Math.round(number * 1000) / 1000
          count += 1
        }
        return clean
      })(),
    })
  }
  return { version: 1, presets }
}

/** The binding a preset contributes: its expression name maps to its own id. */
function presetBinding(presets, expressions) {
  const declared = new Set(expressions)
  const binding = {}
  for (const preset of presets) {
    if (preset.expression === '' || !declared.has(preset.expression)) continue
    binding[preset.expression] = { emotion: preset.id, preset: true }
  }
  return binding
}

/**
 * The shipped channel notes.
 *
 * VRM fixes the humanoid bone names and three-vrm normalises their local axes, so these
 * notes hold for every VRM; a pack's own `params.json` takes precedence.
 *
 * @param file - Path to the defaults asset.
 * @returns `{ channels }` with `channelId → note`.
 */
function loadVrmChannelDefaults(file = VRM_DEFAULTS_ASSET) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`dsh-live-tavern-lite: cannot read the VRM channel defaults at ${file}: ${error.message}`)
  }
  const channels = parsed !== null && typeof parsed === 'object' && typeof parsed.channels === 'object' && parsed.channels !== null
    ? parsed.channels
    : {}
  const clean = {}
  for (const [id, note] of Object.entries(channels)) {
    if (typeof note === 'string' && note.trim() !== '') clean[id] = note.trim().slice(0, 200)
  }
  return { channels: clean }
}

/**
 * The shipped pose recipes.
 *
 * A model that writes `recipe: "bow"` never has to know which bones a bow bends; the table
 * keeps that mapping in one place and can be edited without touching the prompt.
 *
 * @param file - Path to the recipes asset.
 * @returns `{ recipes }` in file order, each `{ id, label, intent, kind, params?, animation?, easeMs? }`.
 */
function loadPoseRecipes(file = POSE_RECIPES_ASSET) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`dsh-live-tavern-lite: cannot read the pose recipes at ${file}: ${error.message}`)
  }
  const listed = Array.isArray(parsed?.recipes) ? parsed.recipes : []
  const recipes = []
  for (const entry of listed) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id)) continue
    const params = {}
    if (entry.params !== null && typeof entry.params === 'object' && !Array.isArray(entry.params)) {
      for (const [channel, value] of Object.entries(entry.params)) {
        const number = Number(value)
        if (Number.isFinite(number)) params[channel] = number
      }
    }
    // 空壳配方是最难发现的故障：它出现在动作清单里，调下去却什么也不发生。
    // 既没有动画、也没有姿态参数、还没有位移的条目等于空壳，直接拒绝装载并告警。
    const hasAnimation = typeof entry.animation === 'string' && entry.animation.trim() !== ''
    const hasPoseParams = Object.keys(params).length > 0
    const hasTranslate = entry.translate !== null && typeof entry.translate === 'object'
      && !Array.isArray(entry.translate) && Object.keys(entry.translate).length > 0
    if (!hasAnimation && !hasPoseParams && !hasTranslate) {
      console.warn(`[dsh-live-tavern-lite] 配方 ${id} 是空壳（无动画 / 无参数 / 无位移），已跳过`)
      continue
    }
    recipes.push({
      id,
      label: typeof entry.label === 'string' ? entry.label.slice(0, 24) : id,
      intent: typeof entry.intent === 'string' ? entry.intent.slice(0, 60) : '',
      kind: entry.kind === 'live2d' ? 'live2d' : 'vrm',
      params,
      animation: typeof entry.animation === 'string' ? entry.animation.slice(0, ANIMATION_LIMIT) : '',
      translate: entry.translate !== null && typeof entry.translate === 'object' && !Array.isArray(entry.translate)
        ? Object.fromEntries(Object.entries(entry.translate)
            .filter(([, value]) => Array.isArray(value) && value.length === 3 && value.every(number => Number.isFinite(Number(number))))
            .map(([bone, value]) => [bone, value.map(number => Math.min(2, Math.max(-2, Number(number))))]))
        : {},
      easeMs: Number.isFinite(Number(entry.easeMs)) ? Math.min(4000, Math.max(60, Number(entry.easeMs))) : 400,
      // Geometric acceptance criteria the browser evaluates after applying the pose.
      checks: (Array.isArray(entry.checks) ? entry.checks : [])
        .filter(item => item !== null && typeof item === 'object' && typeof item.type === 'string')
        .slice(0, 6)
        .map(item => ({
          type: item.type.slice(0, 24),
          ...(item.side === 'right' ? { side: 'right' } : {}),
          ...(Number.isFinite(Number(item.max)) ? { max: Number(item.max) } : {}),
          ...(Number.isFinite(Number(item.target)) ? { target: Number(item.target) } : {}),
          ...(Number.isFinite(Number(item.tolerance)) ? { tolerance: Number(item.tolerance) } : {}),
        })),
    })
  }
  return { recipes }
}

/**
 * Load the base pose: channel values applied under every recipe.
 *
 * @param file - Path to the base pose asset.
 * @returns `{ params }` with finite numbers only.
 */
function loadPoseBase(file = POSE_BASE_ASSET) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`dsh-live-tavern-lite: cannot read the base pose at ${file}: ${error.message}`)
  }
  const params = {}
  const source = parsed?.params
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [channel, value] of Object.entries(source)) {
      const number = Number(value)
      if (Number.isFinite(number)) params[channel] = number
    }
  }
  return { params }
}

function loadEmotionLibrary(file = EMOTIONS_ASSET) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`dsh-live-tavern-lite: cannot read the emotion library at ${file}: ${error.message}`)
  }
  const prototypes = Array.isArray(parsed.prototypes) ? parsed.prototypes : []
  if (prototypes.length === 0) throw new Error(`dsh-live-tavern-lite: ${file} declares no prototypes`)
  const byId = new Map()
  for (const prototype of prototypes) {
    if (typeof prototype.id !== 'string' || prototype.id === '') {
      throw new Error('dsh-live-tavern-lite: every emotion prototype needs a string id')
    }
    if (byId.has(prototype.id)) throw new Error(`dsh-live-tavern-lite: duplicate emotion prototype '${prototype.id}'`)
    for (const axis of ['valence', 'arousal', 'dominance', 'intensity']) {
      if (!Number.isFinite(Number(prototype[axis]))) {
        throw new Error(`dsh-live-tavern-lite: prototype '${prototype.id}' needs a finite ${axis}`)
      }
    }
    byId.set(prototype.id, prototype)
  }
  if (!byId.has('neutral')) throw new Error('dsh-live-tavern-lite: the emotion library must declare a neutral prototype')
  return { prototypes, byId, defaultHoldMs: finite(parsed.defaultHoldMs, 9000) }
}

/**
 * Resolve one request into the expression the visible model should wear.
 *
 * Precedence: an expression the request names and the model declares, then the
 * expression calibrated to that emotion, then the nearest calibrated expression
 * in the valence/arousal plane. An uncalibrated model simply gets none.
 *
 * @param options - Library, raw request, the model's expressions, and its binding.
 * @returns Emotion identity, resolved axes, hold time and the chosen expression.
 */
function resolveEmotionTarget({ library, request, expressions, binding }) {
  const asked = typeof request?.emotion === 'string' ? request.emotion.trim() : ''
  const prototype = library.byId.get(asked) ?? library.byId.get('neutral')
  const valence = clamp(finite(request?.valence, finite(prototype.valence, 0)), -1, 1)
  const arousal = clamp(finite(request?.arousal, finite(prototype.arousal, 0)), -1, 1)
  const dominance = clamp(finite(request?.dominance, finite(prototype.dominance, 0)), -1, 1)
  const intensity = clamp(finite(request?.intensity, finite(prototype.intensity, 0.5)), 0, 1)
  const holdMs = clamp(finite(request?.holdMs, library.defaultHoldMs), 800, 120_000)
  // Vector-only calls still need a readable name, so the nearest prototype labels
  // the mood and seeds the expression lookup.
  const named = asked === ''
    ? nearestPrototype(library, valence, arousal, dominance)
    : prototype
  const declared = new Set(expressions)
  let expression
  let expressionSource = 'none'
  if (typeof request?.expression === 'string' && declared.has(request.expression)) {
    expression = request.expression
    expressionSource = 'requested'
  } else {
    const wanted = asked === '' ? named.id : asked
    const exact = expressions.find(name => binding[name]?.emotion === wanted)
    if (exact !== undefined) {
      expression = exact
      expressionSource = 'calibrated'
    } else if (asked === '') {
      // A vector-only call already paints the face through the rig. Falling back
      // to the nearest calibrated expression there would apply a switch the user
      // labelled for a different mood, so only an exact calm match is used.
      expressionSource = 'none'
    } else {
      let best
      let bestDistance = Infinity
      for (const name of expressions) {
        const entry = binding[name]
        if (entry === null || typeof entry !== 'object') continue
        // An expression the user labelled for a different mood is not a stand-in
        // for this one: picking it paints anger over a curious face.
        if (typeof entry.emotion === 'string' && entry.emotion !== '' && entry.emotion !== wanted) continue
        const entryValence = finite(entry.valence, undefined)
        const entryArousal = finite(entry.arousal, undefined)
        if (entryValence === undefined || entryArousal === undefined) continue
        const distance = Math.hypot(entryValence - valence, entryArousal - arousal)
        if (distance < bestDistance) {
          bestDistance = distance
          best = name
        }
      }
      // The plane's diagonal is about 2.8; 1.25 keeps clearly unrelated expressions out.
      if (best !== undefined && bestDistance <= 1.25) {
        expression = best
        expressionSource = 'nearest'
      }
    }
  }
  return {
    emotion: named.id,
    label: named.label,
    ...(named.params === undefined ? {} : { params: named.params }),
    unknownEmotion: asked !== '' && !library.byId.has(asked) ? asked : undefined,
    valence,
    arousal,
    dominance,
    intensity,
    holdMs,
    expression,
    expressionSource,
  }
}

/**
 * Name the mood a bare vector lands closest to.
 *
 * @param library - Loaded emotion library.
 * @param valence - Pleasure axis, -1..1.
 * @param arousal - Activation axis, -1..1.
 * @param dominance - Control axis, -1..1.
 * @returns The nearest prototype; `neutral` when the library has nothing closer.
 */
function nearestPrototype(library, valence, arousal, dominance) {
  let best = library.byId.get('neutral')
  let bestDistance = Infinity
  for (const candidate of library.byId.values()) {
    const distance = Math.hypot(
      (candidate.valence ?? 0) - valence,
      (candidate.arousal ?? 0) - arousal,
      (candidate.dominance ?? 0) - dominance,
    )
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

/**
 * Accept `{ group, index }` or `"group#index"` and clamp it against the model's groups.
 *
 * @param requested - Raw motion request from the model.
 * @param groups - Motion groups the selected model declares.
 * @returns A playable motion, or undefined when the model has no such group.
 */
function resolveMotion(requested, groups) {
  if (requested === undefined || requested === null || requested === '') return undefined
  let group
  let index = 0
  if (typeof requested === 'string') {
    const parts = requested.split('#')
    group = parts[0] ?? ''
    index = finite(parts[1], 0)
  } else if (typeof requested === 'object') {
    group = typeof requested.group === 'string' ? requested.group : ''
    index = finite(requested.index, 0)
  } else {
    return undefined
  }
  const declared = groups.find(entry => entry.group === group)
  if (declared === undefined) return undefined
  return { group, index: clamp(Math.trunc(index), 0, Math.max(1, declared.count) - 1) }
}

/** Model-facing declaration of the character control tool. */
const ACT_TOOL_DESCRIPTION = '驱动屏幕上 Live2D 角色的情绪与一句台词。'
  + ' 用情绪向量 valence/arousal/dominance/intensity 描述即可，插件会映射成 22 个模型参数（眼、眉、嘴、头、身）；'
  + ' emotion 原型 id 是可选的，只在想顺手选一张预置表情时给。'
  + ' 只在情绪真的发生变化时调用；同一情绪不要连续调用；不要用它代替正常回答。'
  + ' 一次调用就能同时给情绪、表情、动作、关键帧、台词与记忆：expression 选表情，motion 做自带动作，animation 写参数关键帧，remember 记一件事。'
  + ' 跨会话模式开启时不要调用本工具：那时表情与动作由场外模型统一控制，调用只会被拒绝。'
  + ' 返回宿主实际套用的情绪与表情（表情是模型绑定的，可能没有对应项）。'
  + ' 想让她做一个具体动作，给 animation：`参数=目标值@毫秒` 用 ; 或 - 连接，'
  + ' 例如 "ParamAngleX=18@600; ParamAngleZ=-6@600"，从当前值插值过去，~linear/~smooth/~in/~out 可选缓动。'
  + ' 同一参数写多次会接着走；身体参数用 `+=`/`-=` 给偏移，才不会盖掉模型自带的呼吸与重心。'

const ACT_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    valence: { type: 'number', description: '愉快(1) ↔ 不悦(-1)。只给向量也能驱动表情。' },
    arousal: { type: 'number', description: '激动(1) ↔ 平静(-1)。' },
    dominance: { type: 'number', description: '主导(1) ↔ 顺从(-1)。' },
    intensity: { type: 'number', description: '0..1 的表演强度；0 回到静止表情。默认 0.5。' },
    emotion: {
      type: 'string',
      description: '可选。情绪原型 id（joy / sad / shy / anger / surprise / tender / sleepy…），给出时可顺手选一张预置表情；不填则完全按向量驱动。',
    },
    holdMs: { type: 'number', description: '保持毫秒数，默认 9000，范围 800..120000。' },
    remember: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '值得长期记住的一句话，不超过 60 字' },
        kind: {
          type: 'string',
          enum: ['identity', 'preference', 'event', 'promise', 'note'],
          description: 'identity=身份/关系，promise=承诺，preference=偏好，event=发生过的事，note=其它',
        },
        importance: { type: 'number', description: '1-5，越大越不容易被裁掉；默认 3' },
      },
      required: ['text'],
      description: '可选。顺手记一件事；跨会话模式关闭时这是会话模型写记忆的主要方式。',
    },
    animation: {
      type: 'string',
      description: '可选。参数关键帧动画，形如 "ParamAngleX=18@600; ParamYL2=1@120; ParamYL2=0@260"：每个 `参数=目标值@毫秒`，从当前值插值过去。同一参数写多次是接着走（第二笔在第一个毫秒之后开始）。想叠在模型自带的呼吸/重心上而不是覆盖它，用 `+=` / `-=` 给偏移，例如 "ParamYL2+=0.1@300; ParamYL2+=0@300"。参数名必须是模型真实存在的参数；分隔用 ; 或 -，缓动可加 ~linear/~smooth/~in/~out。',
    },
    params: {
      type: 'object',
      description: '可选。一次给一组绝对姿势，键是通道 id、值是数字：{"BoneHeadZ":12,"BoneSpineX":4}（Live2D 参数同理）。适合定格姿势；有先后顺序的动作仍用 animation。未知 id 会被忽略。',
      additionalProperties: true,
    },
    easeMs: {
      type: 'number',
      description: '可选。params 的过渡时长（毫秒，默认 400）。越大越慢。',
    },
    translate: {
      type: 'object',
      description: '可选。整体位移（米），键是骨骼名、值是 [x,y,z]：例如蹲下 {"hips":[0,-0.24,0]}。旋转做不到下沉，这个才做得到。',
      additionalProperties: true,
    },
    recipe: {
      type: 'string',
      description: '可选。语义姿势 id（见提示词里的姿势表，如 bow / tilt / wave）：由宿主换算成骨骼通道，比手写数字可靠。与 params 同给时 params 覆盖配方里的同名通道。',
    },
    expression: { type: 'string', description: '直接指定模型的表情名（该模型必须声明过）。一般不要填，交给标定绑定去选。' },
    motion: {
      type: 'object',
      additionalProperties: false,
      description: '直接指定的动作，例如 {"group":"Tap","index":0}。模型没这组动作时忽略。',
      properties: {
        group: { type: 'string' },
        index: { type: 'number' },
      },
    },
    line: { type: 'string', description: '给玩家看的一句短台词（≤60 字），显示在角色旁的对话气泡里。不要重复正文。' },
  },
}

/**
 * Output declaration for the control tool.
 *
 * The registry enforces a JSON-Schema subset and rejects type arrays ("type must
 * be a single type string"), so an optional member is expressed by leaving it out
 * of `required`, never by a `['x','null']` union.
 */
const ACT_TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    emotion: { type: 'string' },
    valence: { type: 'number' },
    arousal: { type: 'number' },
    dominance: { type: 'number' },
    intensity: { type: 'number' },
    expression: { type: 'string', description: '实际套用的表情名；没有可套的表情时省略。' },
    expressionSource: { type: 'string' },
    animation: { type: 'string', description: '已接受的参数关键帧文本；没给就没有。' },
    params: { type: 'object', description: '已套用的姿势：通道 id → 目标值。', additionalProperties: true },
    easeMs: { type: 'number', description: '这次姿势的过渡时长。' },
    recipe: { type: 'string', description: '这次套用的语义姿势 id；没有就是没给。' },
    translate: { type: 'object', description: '这次的骨骼位移（米）。', additionalProperties: true },
    remembered: { type: 'boolean', description: '这一帧顺带写入了一条记忆。' },
    motion: {
      type: 'object',
      additionalProperties: false,
      properties: {
        group: { type: 'string' },
        index: { type: 'number' },
      },
    },
    hint: { type: 'string' },
  },
  required: ['ok', 'emotion'],
}

/** Parse one JSON file, or undefined when it is absent. */
function readJsonSync(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw new Error(`dsh-live-tavern-lite: cannot read ${file}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`dsh-live-tavern-lite: ${file} is not valid JSON: ${error.message}`)
  }
}

/** Character packs: one directory per pack holding `card.json`. */
function scanPacks(packsRoot) {
  let entries
  try {
    entries = readdirSync(packsRoot, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({ id: entry.name, dir: join(packsRoot, entry.name) }))
    .sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }))
}

/**
 * Read every pack, failing loud when a named pack has no card.
 *
 * @param config - Resolved plugin config.
 * @returns Packs in directory order, each with its normalized card and world book.
 */
function loadPacks(config) {
  // `pack: off` is the safety valve: no card and no world book reach the
  // system prompt, while the stage itself keeps working.
  if (config.pack === 'off') return []
  const packs = scanPacks(config.packsRoot)
  if (config.pack !== '' && !packs.some(pack => pack.id === config.pack)) {
    throw new Error(`dsh-live-tavern-lite: pack '${config.pack}' not found under ${config.packsRoot}`)
  }
  // Everything besides the model is optional: a pack can be a model alone.
  return packs.map(pack => ({
    id: pack.id,
    dir: pack.dir,
    card: normalizeCard(readJsonSync(join(pack.dir, 'card.json')), pack.id),
    book: normalizeWorldBook(readJsonSync(join(pack.dir, 'worldbook.json'))),
  }))
}

/**
 * Parse a rig table out of a model reply, keeping the entries that survived.
 *
 * A long table can be cut off mid-object by the output budget, and a reply that
 * is 95% right should not be thrown away: this keeps every parameter object that
 * closed properly and drops the truncated tail. Output here is ids, numbers and
 * keys inside objects, so brace counting does not need string-aware scanning.
 *
 * @param text - Raw model text, possibly with prose or a code fence around it.
 * @returns `{ value, salvaged, kept, dropped }`, or undefined when nothing parses.
 */
function parseRigReply(text) {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  const slice = text.slice(start)
  const closed = slice.lastIndexOf('}')
  if (closed !== -1) {
    try {
      return { value: JSON.parse(slice.slice(0, closed + 1)), salvaged: false, kept: 0, dropped: 0 }
    } catch {
      // Fall through to salvage: the tail was probably cut mid-object.
    }
  }
  const marker = slice.search(/"params"\s*:\s*\[/)
  if (marker === -1) return undefined
  const open = slice.indexOf('[', marker)
  if (open === -1) return undefined
  const body = slice.slice(open + 1)
  const objects = []
  let depth = 0
  let objectStart = -1
  for (let index = 0; index < body.length; index++) {
    const character = body[index]
    if (character === '{') {
      if (depth === 0) objectStart = index
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0 && objectStart !== -1) {
        objects.push(body.slice(objectStart, index + 1))
        objectStart = -1
      }
      if (depth < 0) break
    } else if (character === ']' && depth === 0) {
      break
    }
  }
  for (let count = objects.length; count > 0; count--) {
    try {
      const params = JSON.parse(`[${objects.slice(0, count).join(',')}]`)
      return { value: { version: 2, params }, salvaged: true, kept: count, dropped: objects.length - count }
    } catch {
      // Drop one more entry and try again.
    }
  }
  return undefined
}

export function apply(ctx, rawConfig) {
  // Everything below registers routes, tools and prompt sections. A throw here
  // fails the whole plugin fiber, which the browser sees as a dead plugin with no
  // clue why; a caught error leaves whatever did register alive and logged.
  try {
    return applyInner(ctx, rawConfig)
  } catch (error) {
    console.warn('[dsh-live-tavern-lite] apply failed', error?.stack ?? error)
    return () => {}
  }
}

export function applyInner(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  // Stage state keyed by the visible session id; the browser half subscribes
  // over SSE and the emotion tools write into it. Display-only: never logged.
  const stages = new Map()
  const subscribers = new Set()
  // Last self-report from the browser half. It exists so the stage can be
  // verified without a browser console: `GET /dsh-live-tavern/status` answers what
  // the page saw, including why a load failed.
  let report = null
  /** Most recent frame across sessions, so a reloaded page resumes her mood. */
  let lastFrame

  /** Finger channels from the last frame, so an arm-only frame does not reset the hand pose. */
  let lastFingerParams = {}
  const isFingerChannel = (channel) => /(Proximal|Intermediate|Distal|Thumb)/.test(channel)

  const publish = (sessionId, state) => {
    const key = String(sessionId ?? '')
    const frame = { ...state, sessionId: key, time: Date.now() }
    // Fingers persist: a frame that only moves the arms keeps the hand shape from before.
    const fingerEntries = Object.entries(frame.params ?? {}).filter(([channel]) => isFingerChannel(channel))
    if (fingerEntries.length > 0) lastFingerParams = Object.fromEntries(fingerEntries)
    stages.set(key, frame)
    lastFrame = frame
    const payload = `event: stage\ndata: ${JSON.stringify(frame)}\n\n`
    for (const subscriber of subscribers) {
      // An empty subscriber session is the visible-stage wildcard: the browser
      // renders one stage and cannot know which Session the viewer is on.
      if (subscriber.sessionId !== '' && subscriber.sessionId !== key) continue
      try {
        subscriber.res.write(payload)
      } catch {
        subscribers.delete(subscriber)
      }
    }
  }

  /**
   * Which kind of stage the current selection mounts.
   *
   * Settings that only exist on one of the two stages are filtered by this, so a Live2D
   * character never shows spring-bone or VRM pose-queue switches.
   *
   * @returns `'vrm'`, `'live2d'`, or `null` when nothing is selected.
   */
  /**
   * Resolve the configured pack to a loadable model, without loading one that is not there.
   *
   * @returns `{ models, wanted, selected, vrmHidden, packProblem }`; `selected` is undefined
   *   when the pack path is empty, missing, or holds no model file.
   */
  const resolveSelection = async () => {
    const models = await listModels()
    // The pack names the character; a legacy `model` value still selects one.
    const wanted = config.pack !== '' && config.pack !== 'off' ? config.pack : config.model
    if (wanted === '') return { models, wanted, selected: undefined, vrmHidden: false, packProblem: { state: 'empty' } }
    const inspected = await inspectPackPath(config, wanted)
    const found = models.find(model => model.id === wanted)
    // A VRM pack on a runtime without the 3D stage is not an error: fall back and say so, or
    // an Android upgrade of an existing install would fail to boot the stage at all.
    const vrmHidden = found === undefined && !vrmStageSupported()
      ? (await listModelEntries(config, true)).some(model => model.id === wanted && model.kind === 'vrm')
      : false
    const selected = vrmHidden ? models[0] : found
    // A configured path without a model is reported, not swallowed: she simply does not appear.
    const packProblem = inspected.state === 'ok'
      ? undefined
      : { state: inspected.state, path: inspected.dir ?? wanted }
    return { models, wanted, selected, vrmHidden, packProblem }
  }

  const selectedStageKind = async () => {
    const { selected, packProblem } = await resolveSelection()
    if (packProblem !== undefined) return null
    return selected === undefined ? null : (selected.kind ?? 'live2d')
  }

  const modelConfig = async () => {
    const { models, wanted, selected, vrmHidden, packProblem } = await resolveSelection()
    const detail = selected === undefined || selected.kind === 'vrm'
      ? { expressions: [], motionGroups: [], parameters: [] }
      : await readModelSettings(selected)
    return {
      hostVersion: HOST_VERSION,
      // The browser half reads this instead of sniffing the platform itself.
      vrmSupported: vrmStageSupported(),
      vrmDropped: vrmHidden ? wanted : null,
      // Why nothing is on stage, when the configured path is empty or holds no model file.
      packProblem: packProblem === undefined
        ? null
        : {
          state: packProblem.state,
          path: packProblem.path ?? null,
          hint: packProblem.state === 'empty'
            ? '还没选角色包'
            : packProblem.state === 'missing'
              ? '这个目录不存在'
              : '这个目录里没有模型文件（需要 .model3.json 或 .vrm）',
        },
      // What the browser half may offer: one place decides, both halves obey.
      capabilities: {
        vrm: vrmStageSupported(),
        workbench: !mobileRuntime(),
        placements: config.placement,
      },
      models,
      pack: pack?.id ?? null,
      packs: packs.map(item => item.id),
      character: pack?.card.name ?? null,
      selected: selected === undefined ? null : {
        ...selected,
        ...detail,
        // The bones this model really declares, so the browser binds the same list the
        // workbench shows instead of a hard-coded handful.
        ...(selected.kind === 'vrm'
          ? { channels: vrmChannelsFor(join(selected.dir, selected.entryFile)) }
          : {}),
      },
      stageKind: selected === undefined ? null : (selected.kind ?? 'live2d'),
      defaults: selected === undefined || selected === null ? null : await readDefaults(selected.id),
      placement: config.placement,
        textureLod: config.textureLod,
      opacity: config.opacity,
      lookAtPointer: config.lookAtPointer === true,
      hitBoxScale: config.hitBoxScale,
      springGravity: config.springGravity,
      springStrength: config.springStrength,
      widthCap: config.widthCap,
      memoryScope: config.memoryScope,
      sessionMaxFacts: config.sessionMaxFacts,
      recallScope: config.recallScope,
      director: directorConfig.mode !== 'off',
      stageEveryTurns: directorConfig.everyTurns,
      stageUpdatesPerTurn: config.stageUpdatesPerTurn,
      interaction: config.interaction === true,
      directorMaxFacts: directorConfig.maxFacts,
      directorMaxTokens: directorConfig.maxTokens,
      modelsRoot: config.modelsRoot,
      // The rig travels to the browser: it drives the parameters each frame.
      rig: (() => {
        if (selected !== undefined && selected !== null && selected.kind === 'vrm') {
          return { version: 0, stamp: 0, params: [], source: 'none' }
        }
        const current = rigFor(selected === null || selected === undefined ? undefined : selected.id)
        return { version: current.rig.version, stamp: current.stamp, params: current.rig.params, source: current.source }
      })(),
    }
  }

  /** Calibration the panel wrote for this model, or an empty map. */
  const readBinding = async (modelId) => {
    const value = await readPackFile(config, modelId, 'binding.json')
    const expressions = value && typeof value === 'object' ? value.expressions : undefined
    return expressions && typeof expressions === 'object' && !Array.isArray(expressions) ? expressions : {}
  }

  const emotionAsset = watchAsset(EMOTIONS_ASSET, loadEmotionLibrary)
  const vrmDefaultsAsset = watchAsset(VRM_DEFAULTS_ASSET, loadVrmChannelDefaults)
  /**
   * Whether this runtime can mount the VRM stage at all.
   *
   * Node reports `'android'` on Android, and the 3D stage needs a desktop-class WebGL context
   * plus the three.js stack; the mobile build runs neither. `vrmStage: 'off'` is the escape
   * hatch for a host that wants the same behaviour for another reason.
   *
   * @returns True when the VRM stage may be offered.
   */
  /**
   * Whether this runtime is the phone shell.
   *
   * It has two seats (chat column, foreground overlay) and no parameter workbench: the workbench
   * is a wide three-pane editor, so shipping its routes and entry point to a phone only adds
   * dead surface. `mobileUi: 'on'` forces the same behaviour on a desktop for testing.
   *
   * @returns True on the mobile runtime.
   */
  const mobileRuntime = () => config.mobileUi === 'on' || process.platform === 'android'

  const vrmStageSupported = () => config.vrmStage !== 'off' && process.platform !== 'android'

  /** Catalog as this runtime may see it: VRM packs disappear where the stage cannot mount them. */
  const listModels = () => listModelEntries(config, vrmStageSupported())

  const poseRecipesAsset = watchAsset(POSE_RECIPES_ASSET, loadPoseRecipes)
  const poseBaseAsset = watchAsset(POSE_BASE_ASSET, loadPoseBase)
  const vrmGuideAsset = watchAsset(VRM_GUIDE_ASSET, (file) => {
    try {
      return readFileSync(file, 'utf8')
    } catch (error) {
      console.warn('[dsh-live-tavern-lite] control guide unreadable', error?.message ?? error)
      return ''
    }
  })

  /** Per-pack preset list, watched so a save takes effect on the next frame. */
  const presetWatchers = new Map()
  const presetsFile = (packId) => (packId === undefined || packId === ''
    ? config.memoryFile
    : packFilePath(config, packId, 'presets.json'))
  const presetsFor = (packId) => {
    if (packId === undefined || packId === '') return []
    const file = packFilePath(config, packId, 'presets.json')
    let watcher = presetWatchers.get(file)
    if (watcher === undefined) {
      watcher = watchAsset(file, (target) => {
        try {
          return normalizePresets(readJsonSync(target)).presets
        } catch (error) {
          console.warn('[dsh-live-tavern-lite] presets unreadable', error?.message ?? error)
          return []
        }
      })
      presetWatchers.set(file, watcher)
    }
    return watcher.get()
  }

  /**
   * The prototype library a character actually offers.
   *
   * Built-in prototypes plus this pack's presets; a preset with an id the built-ins
   * already use replaces it, so a user can retune a stock mood without renaming it.
   */
  const libraryFor = (packId) => {
    const base = emotionAsset.get()
    const presets = presetsFor(packId)
    if (presets.length === 0) return base
    const byId = new Map(base.byId)
    const prototypes = base.prototypes.slice()
    for (const preset of presets) {
      const entry = {
        id: preset.id,
        label: preset.label,
        valence: preset.valence,
        arousal: preset.arousal,
        dominance: preset.dominance,
        intensity: preset.intensity,
        motions: [],
        preset: true,
        ...(Object.keys(preset.params ?? {}).length === 0 ? {} : { params: preset.params }),
      }
      byId.set(preset.id, entry)
      const at = prototypes.findIndex(item => item.id === preset.id)
      if (at === -1) prototypes.push(entry)
      else prototypes[at] = entry
    }
    return { ...base, prototypes, byId }
  }

  const rigAsset = watchAsset(RIG_ASSET, loadRig)

  /**
   * The rig for one model.
   *
   * A model may carry its own `rig.json` (built from the notes the settings page
   * collected); otherwise the packaged table applies. Each file is watched, so a
   * regenerated table takes effect on the next call without a restart.
   *
   * @param modelId - Selected model id, or undefined when none is installed.
   * @returns `{ rig, stamp, source }`.
   */
  const rigWatchers = new Map()
  const rigFor = (modelId) => {
    if (typeof modelId !== 'string' || modelId === '') {
      return { rig: rigAsset.get(), stamp: rigAsset.stamp(), source: 'packaged' }
    }
    const file = packFilePath(config, modelId, 'rig.json')
    // A table may sit beside the pack, beside the model inside the pack, or in
    // the legacy models directory; the first one that exists wins.
    const besideModel = join(packModelDir(config.packsRoot, modelId) ?? join(config.modelsRoot, modelId), 'rig.json')
    const legacy = join(config.modelsRoot, modelId, 'rig.json')
    const resolvedFile = existsSync(file) ? file : existsSync(besideModel) ? besideModel : existsSync(legacy) ? legacy : undefined
    if (resolvedFile === undefined) {
      return { rig: rigAsset.get(), stamp: rigAsset.stamp(), source: 'packaged' }
    }
    let watcher = rigWatchers.get(resolvedFile)
    if (watcher === undefined) {
      // A half-written or malformed table falls back to the packaged rig: the
      // stage keeps rendering while the file is being saved.
      watcher = watchAsset(resolvedFile, (file) => {
        try {
          return { rig: loadRig(file), ok: true }
        } catch (error) {
          console.warn('[dsh-live-tavern-lite] rig table unreadable, using the packaged one', error?.message ?? error)
          return { rig: rigAsset.get(), ok: false }
        }
      })
      rigWatchers.set(resolvedFile, watcher)
    }
    const loaded = watcher.get()
    // `source` reports what is actually driving the parameters, not just which
    // file was found: a fallback must not claim to be the model's own table.
    return { rig: loaded.rig, stamp: watcher.stamp(), source: loaded.ok ? 'model' : 'packaged' }
  }

  /** Notes the settings page collected for one model's parameters. */
  const paramsFile = (modelId) => packFilePath(config, modelId, 'params.json')
  /**
   * The pose a model starts in.
   *
   * Kept in the pack, next to the model, because it describes that character rather
   * than this browser. `expression` names a file the model declares; `emotion` names
   * one of the built-in prototypes.
   */
  /** Ids the emotion library declares, in file order. */
  const emotionIds = () => {
    const library = emotionAsset.get()
    const byId = library?.byId
    if (byId instanceof Map) return [...byId.keys()]
    return byId !== null && typeof byId === 'object' ? Object.keys(byId) : []
  }
  const isEmotion = (id) => id === 'neutral' || emotionIds().includes(id)

  const defaultsFile = (modelId) => packFilePath(config, modelId, 'defaults.json')
  const readDefaults = async (modelId) => {
    const value = await readPackFile(config, modelId, 'defaults.json')
    const expression = typeof value?.expression === 'string' ? value.expression.trim().slice(0, 64) : ''
    // A saved id is returned as written: a preset may have been renamed since, and
    // silently dropping the value would look like the setting never stuck.
    const emotion = typeof value?.emotion === 'string' ? value.emotion.trim().slice(0, 64) : ''
    return { version: 1, expression, emotion }
  }

  const readParams = async (modelId) => {
    const value = await readPackFile(config, modelId, 'params.json')
    const params = value && typeof value === 'object' && typeof value.params === 'object' && value.params !== null
      ? value.params
      : {}
    return { version: 1, updatedAt: Number(value?.updatedAt) || 0, params }
  }
  // A pack that cannot be read is a configuration problem, not a load failure:
  // the plugin must stay mounted so the settings page can fix it.
  const loadPacksSafely = () => {
    try {
      return loadPacks(config)
    } catch (error) {
      console.warn('[dsh-live-tavern-lite] pack load failed', error?.message ?? error)
      return []
    }
  }
  let packs = loadPacksSafely()
  let pack = config.pack === '' ? packs[0] : packs.find(item => item.id === config.pack)
  let directorConfig = resolveDirectorConfig(config.merged)
  const digests = new Map()
  /** Turns committed per session; the round a remembered fact points at. */
  const rounds = new Map()
  /** Per-session world-book state: assembly counter and cooldown counters. */
  const worldbookStates = new Map()
  /** The plan produced for the current digest, so repeat assemblies stay identical. */
  const worldbookPlans = new Map()
  /** The most recent world-book decision, for the diagnostics panel. */
  let lastWorldbookReport
  /**
   * Committed lines since the last director run.
   *
   * When the cadence skips a turn the text must not be lost: the next takeover
   * replays this backlog, so a fact mentioned on a skipped turn is still recorded.
   */
  const pendingTurns = new Map()
  const localActAt = new Map()
  /** Session id → last time it produced a message; used to address interactions. */
  const lastSeenAt = new Map()
  const directorRunAt = new Map()
  const directorCalls = []
  let memoryCache

  /** Stage updates already taken this turn, per session: `{ round, used }`. */
  const stageSlots = new Map()

  /**
   * Count one stage update in this turn.
   *
   * `stageUpdatesPerTurn` is a floor, not a ceiling: the model is expected to move
   * her at least that often (once while thinking, once when the answer lands), and
   * may move her more. Only a runaway guard stops it.
   *
   * @param sessionId - Session asking.
   * @returns `{ ok, used, minimum, ceiling }`.
   */
  const takeStageSlot = (sessionId) => {
    const minimum = Math.max(1, Math.trunc(config.stageUpdatesPerTurn))
    const round = rounds.get(sessionId) ?? 0
    const current = stageSlots.get(sessionId)
    const now = Date.now()
    // The guard exists to stop a runaway loop inside one turn. The turn counter is bumped by
    // session events, which are not guaranteed to reach this listener in every runtime; a quiet
    // window therefore also releases the budget, or a single burst would block the stage for the
    // rest of the conversation.
    const fresh = current !== undefined && current.round === round && now - (current.at ?? 0) < 20000
    const used = fresh ? current.used : 0
    if (used >= STAGE_UPDATES_CEILING) {
      return { ok: false, used, minimum, ceiling: STAGE_UPDATES_CEILING }
    }
    stageSlots.set(sessionId, { round, used: used + 1, at: now })
    return { ok: true, used: used + 1, minimum, ceiling: STAGE_UPDATES_CEILING }
  }

  /**
   * Write one remembered fact for a session.
   *
   * Shared by `live2d_remember`, the director and `live2d_act`'s `remember`
   * field, so the merge, the conflict rules and the consolidation pass are the
   * same three lines everywhere.
   *
   * @param raw - A string or `{ text, kind, importance }`.
   * @param sessionId - Session whose memory file is written.
   * @returns Whether anything was stored.
   */
  const writeRemembered = async (raw, sessionId) => {
    const input = typeof raw === 'string' ? { text: raw } : raw
    const text = typeof input?.text === 'string' ? input.text.trim() : ''
    if (text === '') return false
    memorySession = sessionId
    const memory = await loadMemory(sessionId)
    const merged = mergeDirectorMemory(memory, {
      remember: {
        text,
        ...(typeof input?.kind === 'string' ? { kind: input.kind } : {}),
        ...(Number.isFinite(Number(input?.importance)) ? { importance: Number(input.importance) } : {}),
      },
    }, {
      maxFacts: config.sessionMaxFacts,
      source: { sessionId, round: rounds.get(sessionId) ?? 0 },
    })
    if (!merged.changed) return false
    const settled = consolidate(merged.memory, { maxFacts: config.sessionMaxFacts })
    await saveMemory(settled.memory, sessionId)
    return true
  }

  /** A memory file key: a session id, safe as a file name. */
  const memoryKeyOf = (sessionId) => String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'shared'

  /** One memory file per session, beside the pack that owns the character. */
  const sessionMemoryFile = (sessionId) => {
    const owner = memoryOwner()
    if (owner === '') return join(dirname(config.memoryFile), 'sessions', `${memoryKeyOf(sessionId)}.json`)
    return join(dirname(memoryFileFor(owner)), 'memory', `${memoryKeyOf(sessionId)}.json`)
  }

  /** The file this session's memory lives in. */
  const currentMemoryFile = (sessionId) => sessionMemoryFile(sessionId === undefined ? memorySession : sessionId)

  /** The session whose memory is being read or written; set per turn by the caller. */
  let memorySession = ''

  const emptyMemory = () => ({ version: 1, facts: [], affinity: 0, updatedAt: 0 })
  const asMemory = (value) => (value && typeof value === 'object' && Array.isArray(value.facts) ? value : undefined)

  /** Read one memory file, tolerate a missing or broken one. */
  const readMemoryFile = async (file) => {
    const direct = asMemory(await readJson(file))
    if (direct !== undefined) return direct
    return undefined
  }

  const loadMemory = async (sessionId) => {
    const file = currentMemoryFile(sessionId)
    if (memoryCache !== undefined && memoryCache.file === file) return memoryCache.memory
    let memory = await readMemoryFile(file)
    if (memory === undefined) {
      // An older install kept one memory file per character; its facts are a
      // baseline until this session has written its own.
      memory = (await readMemoryFile(memoryFileFor(memoryOwner()))) ?? emptyMemory()
    }
    memoryCache = { file, memory }
    return memory
  }

  const saveMemory = async (next, sessionId) => {
    const file = currentMemoryFile(sessionId)
    memoryCache = { file, memory: next }
    await mkdir(dirname(file), { recursive: true })
    await writeJsonAtomic(file, next)
  }

  /**
   * Every fact the current scope may use.
   *
   * `session` reads this session plus the legacy character file; `all` adds every
   * other session file this character ever wrote. Memory never crosses packs: the
   * directories are per pack, so another character cannot leak in.
   */
  const factsForScope = async (sessionId) => {
    const ownMemory = await loadMemory(sessionId)
    const facts = [...ownMemory.facts]
    const seen = new Set(facts.map(fact => fact.text))
    const add = (list) => {
      for (const fact of list) {
        if (typeof fact?.text !== 'string' || seen.has(fact.text)) continue
        seen.add(fact.text)
        facts.push(fact)
      }
    }
    add((await readMemoryFile(memoryFileFor(memoryOwner())))?.facts ?? [])
    if (config.memoryScope !== 'all') return { facts, summaries: ownMemory.summaries ?? [], affinity: ownMemory.affinity ?? 0 }
    // Merge the character's other sessions whole, so their summaries and their
    // mood come along with their facts.
    const dir = dirname(sessionMemoryFile(sessionId))
    const others = []
    try {
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.json')) continue
        if (join(dir, name) === sessionMemoryFile(sessionId)) continue
        const memory = await readMemoryFile(join(dir, name))
        if (memory !== undefined) others.push(memory)
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    const own = { ...ownMemory, facts, summaries: [] }
    const merged = mergeMemories([{ ...own, facts: [] }, ...others], { maxFacts: config.sessionMaxFacts })
    const byText = new Map(facts.map(fact => [fact.text, fact]))
    for (const fact of merged.facts) byText.set(fact.text, fact)
    return { facts: [...byText.values()], summaries: merged.summaries, affinity: merged.affinity }
  }

  /**
   * The transcript is the authoritative record; the facts are its index.
   *
   * Each session gets one file under the director directory, so a remembered
   * sentence can always be checked against what was actually said, and a rollback
   * in the session leaves the recall view consistent with what was committed.
   */
  /** The character the director is remembering, or '' when no model is chosen. */
  const memoryOwner = () => {
    const id = config.pack !== '' && config.pack !== 'off' ? config.pack : config.model
    return id === '' ? (pack?.id ?? '') : id
  }
  /** `memory.json` beside the pack that owns the character. */
  const memoryFileFor = (id) => (id === '' ? config.memoryFile : packFilePath(config, id, 'memory.json'))
  const transcriptFile = (sessionId, owner = memoryOwner()) => (
    owner === ''
      ? join(dirname(config.memoryFile), 'transcripts', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
      : join(dirname(memoryFileFor(owner)), 'transcripts', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  )
  const transcripts = new Map()
  const transcriptTimers = new Map()

  const loadTranscript = async (sessionId) => {
    const key = `${memoryOwner()}:${sessionId}`
    if (transcripts.has(key)) return transcripts.get(key)
    const file = transcriptFile(sessionId)
    const value = isInside(dirname(config.memoryFile), file) ? await readJson(file) : null
    const entries = Array.isArray(value?.entries) ? value.entries : []
    transcripts.set(key, entries)
    return entries
  }

  const saveTranscript = (sessionId) => {
    const entries = transcripts.get(`${memoryOwner()}:${sessionId}`) ?? []
    const file = transcriptFile(sessionId)
    if (!isInside(dirname(config.memoryFile), file)) return
    void (async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeJsonAtomic(file, { version: 1, entries: trimTranscript(entries) })
      } catch (error) {
        console.warn('[dsh-live-tavern-lite] transcript write failed', error?.message ?? error)
      }
    })()
  }

  /** Append one committed line and schedule a debounced write. */
  const recordTurn = (sessionId, role, text) => {
    const key = `${memoryOwner()}:${sessionId}`
    const entries = transcripts.get(key) ?? []
    entries.push({ role, text, at: Date.now() })
    transcripts.set(key, trimTranscript(entries))
    const timer = transcriptTimers.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    transcriptTimers.set(sessionId, setTimeout(() => {
      transcriptTimers.delete(sessionId)
      saveTranscript(sessionId)
    }, 1_500))
  }

  /**
   * Parameter annotations, read on demand.
   *
   * The notes explain what a channel or parameter actually does on this machine, and
   * an assembly that carries all of them every turn spends context on text the model
   * may not need. It asks when it does.
   */
  const paramsTool = {
    name: 'live2d_params',
    description: [
      '读取这台机器上角色可驱动参数的含义备注：Live2D 是参数 id，3D（VRM）模型是骨骼通道。',
      '备注由玩家在参数工作台里填写，说明某个参数/通道在这尊模型上的实际效果；提示词里只有 id，不含备注。',
      '准备做一个具体动作、或不确定某个 id 代表什么时调用一次，然后照着备注用 `live2d_act` 的 `animation`。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '只看 id 或备注里包含这段文字的参数；省略则返回全部' },
        group: {
          type: 'string',
          enum: ['head', 'torso', 'arm', 'leg', 'finger'],
          description: '按部位取：head=头颈、torso=躯干、arm=肩臂手、leg=腿脚、finger=手指。先按部位取，别一次读 150 条',
        },
        guide: {
          type: 'boolean',
          description: '可选。要一份由实测生成的「VRM 控制指南」：坐标系、每个通道的正负方向、手指怎么屈/怎么张、怎么下蹲、验收阈值与常见坑。准备设计新动作时先读一次。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          kind: { type: 'string' },
          idCount: { type: 'number' },
          noted: { type: 'number' },
          guide: { type: 'string' },
          params: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                note: { type: 'string' },
                verified: { type: 'boolean' },
                source: { type: 'string' },
                group: { type: 'string' },
                min: { type: 'number' },
                max: { type: 'number' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const request = args !== null && typeof args === 'object' ? args : {}
      // The guide answers "how do I drive this model" without reading 150 rows one by one.
      if (request.guide === true) {
        const guide = vrmGuideAsset.get() ?? ''
        return {
          ok: guide !== '',
          kind: 'guide',
          idCount: 0,
          noted: 0,
          params: [],
          ...(guide === '' ? { error: '控制指南还没生成：运行 scripts/build-control-guide.mjs' } : { guide }),
        }
      }
      const needle = typeof request.filter === 'string' ? request.filter.trim().toLowerCase() : ''
      const id = config.pack !== '' && config.pack !== 'off' ? config.pack : config.model
      if (id === '') {
        return { ok: false, kind: 'none', idCount: 0, noted: 0, params: [], error: '还没有配置角色包' }
      }
      const notes = (() => {
        try {
          const value = readJsonSync(packFilePath(config, id, 'params.json'))
          return value?.params !== null && typeof value?.params === 'object' ? value.params : {}
        } catch {
          return {}
        }
      })()
      const bones = vrmChannelIds()
      const catalog = await modelConfig()
      const selected = catalog.selected
      const entries = bones === ''
        ? rigFor(id).rig.params.map(entry => ({ id: entry.id, min: undefined, max: undefined, role: entry.role }))
        : (() => {
          const all = selected === null || selected === undefined
            ? []
            : vrmChannelsFor(join(selected.dir, selected.entryFile))
          return all.length > 0
            ? all
            : VRM_CHANNELS.map((channel) => {
              const range = VRM_CHANNEL_RANGE[channel] ?? [-45, 45]
              return { id: channel, min: range[0], max: range[1] }
            })
        })()
      const builtin = bones === '' ? {} : (vrmDefaultsAsset.get()?.channels ?? {})
      const params = entries
        .map((entry) => {
          const saved = notes[entry.id]
          const own = typeof saved?.note === 'string' ? saved.note : ''
          const fallback = typeof builtin[entry.id] === 'string' ? builtin[entry.id] : ''
          const note = own !== '' ? own : fallback
          return {
            id: entry.id,
            note,
            verified: saved?.verified === true,
            ...(own === '' && fallback !== '' ? { source: 'default' } : {}),
            ...(entry.min === undefined ? {} : { min: entry.min, max: entry.max }),
            ...(typeof entry.role === 'string' && entry.role !== '' && note === '' ? { note: '' } : {}),
          }
        })
        .filter((entry) => needle === ''
          || entry.id.toLowerCase().includes(needle)
          || entry.note.toLowerCase().includes(needle))
        .filter(entry => (typeof request.group === 'string' && request.group !== ''
          ? channelGroup(entry.id) === request.group
          : true))
        .map(entry => ({ ...entry, group: channelGroup(entry.id) }))
      return {
        ok: true,
        kind: bones === '' ? 'live2d' : 'vrm',
        idCount: entries.length,
        noted: entries.filter((entry) => notes[entry.id]?.note !== undefined).length,
        params,
      }
    },
  }

  /**
   * Recall tool: search the committed transcript, or read one round in full.
   *
   * The tool returns a short hit directory first — a model that reads everything
   * every turn is back to injection with extra steps.
   */
  const recallTool = {
    name: 'live2d_recall',
    description: [
      '检索已经发生过的对话正文，用于回忆细节、关系和剧情；不返回隐藏推理、工具轨迹或未提交的内容。',
      '范围取决于设置：默认只本会话；开启跨会话检索后覆盖本角色的所有会话，命中和原文都会标明所属会话。',
      '给 query 时返回简短命中目录（轮次 / 谁说的 / 片段）；给 round 时返回该轮及相邻轮的完整原文。',
      '检索结果是回忆资料：只用于确认已经发生的事，不得当作当前场景继续演绎，不得照搬旧台词。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查找的人名、地点、物品、承诺或事件线索' },
        round: { type: 'number', description: '要完整读取的轮次编号（来自检索结果）' },
        session: { type: 'string', description: '跨会话检索时命中的会话标识；读本会话可省略' },
        radius: { type: 'number', description: '读取 round 时一并带上前后各几轮，默认 0，最大 3' },
        limit: { type: 'number', description: '检索最多返回几项，默认 5' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          mode: { type: 'string' },
          rounds: { type: 'number' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                round: { type: 'number' },
                where: { type: 'string' },
                snippet: { type: 'string' },
                session: { type: 'string', description: '命中所属会话；只在跨会话检索时出现' },
              },
              required: ['round', 'where', 'snippet'],
              additionalProperties: false,
            },
          },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                round: { type: 'number' },
                user: { type: 'string' },
                assistant: { type: 'string' },
                session: { type: 'string' },
              },
              required: ['round', 'user', 'assistant'],
              additionalProperties: false,
            },
          },
          note: { type: 'string' },
        },
        required: ['found', 'mode'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const sessionId = String(exec?.agent?.id ?? '')
      const request = args !== null && typeof args === 'object' ? args : {}
      const note = '【历史回忆资料】以下是已经发生的历史，只用于确认和回忆；不得当作当前场景继续输出，不得重复演绎。'

      /** Every session this tool may read, own first. */
      const scopes = async () => {
        const own = { session: sessionId, rounds: buildRounds(await loadTranscript(sessionId)) }
        if (config.recallScope !== 'character') return [own]
        const list = [own]
        const dir = dirname(transcriptFile(sessionId))
        try {
          for (const name of await readdir(dir)) {
            if (!name.endsWith('.json')) continue
            if (join(dir, name) === transcriptFile(sessionId)) continue
            const label = name.replace(/\.json$/, '')
            const value = await readJson(join(dir, name))
            const entries = Array.isArray(value?.entries) ? value.entries : []
            list.push({ session: label, rounds: buildRounds(entries) })
          }
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error
        }
        return list
      }

      const all = await scopes()
      const own = all[0]
      const totalRounds = own.rounds.length

      if (request.round !== undefined) {
        // A hit from another session names it; otherwise read this conversation.
        const wanted = typeof request.session === 'string' ? request.session : ''
        const target = wanted === ''
          ? own
          : (all.find(entry => entry.session === wanted) ?? own)
        const span = readRounds(target.rounds, request.round, { radius: request.radius })
        if (span.length === 0) {
          return { found: false, mode: 'round', rounds: target.rounds.length, note: '没有这一轮。' }
        }
        return {
          found: true,
          mode: 'round',
          rounds: target.rounds.length,
          messages: span.map(entry => ({
            round: entry.round,
            user: entry.user,
            assistant: entry.assistant,
            ...(target.session === sessionId ? {} : { session: target.session }),
          })),
          note,
        }
      }
      const query = typeof request.query === 'string' ? request.query : ''
      if (query.trim() === '') {
        return { found: false, mode: 'search', rounds: totalRounds, note: 'query 与 round 至少给一个。' }
      }
      // Search every readable session, then rank the pooled hits as one list.
      const pooled = []
      for (const entry of all) {
        const result = searchRounds(entry.rounds, query, { limit: request.limit })
        for (const hit of result.hits) {
          pooled.push({
            ...hit,
            ...(entry.session === sessionId ? {} : { session: entry.session }),
          })
        }
      }
      pooled.sort((left, right) => (left.where === right.where ? 0 : left.where === 'user' ? -1 : 1))
      const limit = Math.max(1, Math.min(20, Math.trunc(Number(request.limit) || 5)))
      const hits = pooled.slice(0, limit)
      return {
        found: hits.length > 0,
        mode: 'search',
        rounds: totalRounds,
        hits,
        ...(hits.length > 0 ? { note } : { note: '没有找到。可以换个说法，或者给 round 直接读某一轮。' }),
      }
    },
  }


  /** Build one stage frame from a request, resolving against the visible model. */
  const stageStateFor = async (request, source) => {
    const catalog = await modelConfig()
    const selected = catalog.selected
    const expressions = selected === null ? [] : (selected.expressions ?? [])
    const presets = selected === null ? [] : presetsFor(selected.id)
    const target = resolveEmotionTarget({
      library: libraryFor(selected === null ? undefined : selected.id),
      request,
      expressions,
      binding: {
        ...(selected === null ? {} : await readBinding(selected.id)),
        ...presetBinding(presets, expressions),
      },
    })
    const motion = resolveMotion(request?.motion, selected === null ? [] : selected.motionGroups)
    // The model only supplies a vector; the rig turns it into parameter targets.
    const rig = rigFor(selected === null || selected === undefined ? undefined : selected.id)
    const resolved = resolveRig(rig.rig, target)
    // A recipe is looked up before the raw patch so the patch can refine it.
    const recipe = (() => {
      const asked = typeof request?.recipe === 'string' ? request.recipe.trim() : ''
      if (asked === '') return undefined
      const listed = poseRecipesAsset.get()?.recipes ?? []
      // A VRM recipe has no meaning on a runtime without the 3D stage.
      return listed.find(entry => entry.id === asked && (vrmStageSupported() || entry.kind !== 'vrm'))
    })()
    // A model may send a whole pose at once: an object is far cheaper than one
    // `id=value@ms` segment per channel when there are a hundred channels to choose
    // from. Unknown ids are dropped rather than failing the call.
    const patch = (() => {
      const raw = request?.params
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
      const allowed = new Set(poseChannelIds(selected))
      const clean = {}
      let count = 0
      for (const [id, value] of Object.entries(raw)) {
        if (count >= 160) break
        // `Expr:<name>` pins a face expression; a closed eye cannot be a bone rotation.
        const expression = /^Expr:[A-Za-z][A-Za-z0-9_]*$/.exec(id)
        if (expression === null && !allowed.has(id)) continue
        const number = Number(value)
        if (!Number.isFinite(number)) continue
        clean[id] = expression === null
          ? Math.round(number * 1000) / 1000
          : Math.min(1, Math.max(0, Math.round(number * 1000) / 1000))
        count += 1
      }
      return Object.keys(clean).length === 0 ? undefined : clean
    })()
    const easeMs = (() => {
      const value = Number(request?.easeMs)
      if (!Number.isFinite(value)) return recipe?.easeMs ?? undefined
      return Math.min(4000, Math.max(60, Math.round(value)))
    })()
    // A preset's own parameter values win over the emotion mapping: that is the
    // point of pinning a pose in the workbench.
    // The base pose is bone channels: it only means anything for a 3D stage.
    const baseParams = selected?.kind === 'vrm'
      ? (poseBaseAsset.get()?.params ?? {})
      : {}
    const params = {
      ...baseParams,
      ...resolved.params,
      ...(target.params ?? {}),
      ...(recipe?.params ?? {}),
      ...(patch ?? {}),
    }
    if (!Object.keys(params).some(channel => isFingerChannel(channel))) {
      Object.assign(params, lastFingerParams)
    }
    return {
      emotion: target.emotion,
      label: target.label,
      valence: target.valence,
      arousal: target.arousal,
      dominance: target.dominance,
      intensity: target.intensity,
      holdMs: target.holdMs,
      expressionSource: target.expressionSource,
      params,
      rigVersion: rig.stamp,
      // A bubble that ends mid-word reads like a bug: keep whole sentences.
      line: typeof request?.line === 'string' ? trimToSentence(request.line, 160) : '',
      source,
      ...(patch === undefined ? {} : { params: params }),
      ...(easeMs === undefined ? {} : { easeMs }),
      // The browser owns interpolation: it knows the live rig value to start from.
      ...(() => {
        const text = typeof request?.animation === 'string' && request.animation.trim() !== ''
          ? request.animation.trim()
          : (recipe?.animation ?? '')
        return text === '' ? {} : { animation: text.slice(0, ANIMATION_LIMIT) }
      })(),
      ...(recipe === undefined ? {} : { recipe: recipe.id }),
      ...(recipe?.checks !== undefined && recipe.checks.length > 0 ? { checks: recipe.checks } : {}),
      ...(() => {
        const merged = {}
        const add = (source) => {
          if (source === null || typeof source !== 'object') return
          for (const [bone, value] of Object.entries(source)) {
            if (!Array.isArray(value) || value.length !== 3) continue
            const numbers = value.map(Number)
            if (!numbers.every(Number.isFinite)) continue
            merged[bone] = numbers.map(number => Math.min(2, Math.max(-2, number)))
          }
        }
        add(recipe?.translate)
        add(request?.translate)
        return Object.keys(merged).length === 0 ? {} : { translate: merged }
      })(),
      // Every optional member is omitted rather than nulled: the output schema
      // declares them as `string` / `object`, so a null would fail validation,
      // and an explicit undefined would fail the JSON round trip.
      ...(target.expression === undefined ? {} : { expression: target.expression }),
      ...(motion === undefined ? {} : { motion }),
      ...(target.unknownEmotion === undefined ? {} : { unknownEmotion: target.unknownEmotion }),
    }
  }

  const actTool = {
    name: 'live2d_act',
    description: ACT_TOOL_DESCRIPTION,
    parameters: ACT_TOOL_PARAMETERS,
    output: {
      schema: ACT_TOOL_OUTPUT_SCHEMA,
      // 舞台要的是全文，模型要的是「发生了什么」。把 animation 原样回显，会让
      // 一次整段下发（可到二十多万字符）直接吃满上下文；这里只回摘要。
      render: (_args, value) => {
        const compact = { ...value }
        if (typeof compact.animation === 'string' && compact.animation.length > 0) {
          const text = compact.animation
          const parts = text.split(';').filter(part => part.includes('='))
          const channels = new Set(parts.map(part => part.split('=')[0]))
          const beat = /@(\d+)/.exec(text)
          compact.animation = `已下发 ${text.length} 字符 · ${channels.size} 条通道 · ${parts.length} 个关键帧${beat === null ? '' : ` · 每拍 ${beat[1]}ms`}（全文在舞台侧，不回显）`
        }
        return [{ type: 'text', text: JSON.stringify(compact) }]
      },
    },
    presentCall(args) {
      const name = args && typeof args === 'object' && typeof args.emotion === 'string' ? args.emotion : 'act'
      return { card: 'generic', title: `Live2D · ${name}`, kind: 'other', rawInput: args }
    },
    async execute(args, exec) {
      // With the cross-session mode on, the stage belongs to the director: the
      // session model still has the tool registered, but it must not use it.
      if (directorConfig.mode !== 'off') {
        return {
          ok: false,
          emotion: '',
          hint: '跨会话模式开启中：表情与动作由场外模型统一控制，请不要调用 live2d_act。',
        }
      }
      // The cadence is stage-wide: on an off-cadence turn the face stays put, in
      // both modes, so a chatty turn cannot make her flicker.
      const turnKey = String(exec?.agent?.id ?? '')
      const turnNow = rounds.get(turnKey) ?? 0
      if (directorConfig.everyTurns > 1 && turnNow % directorConfig.everyTurns !== 0) {
        return {
          ok: false,
          emotion: '',
          hint: `本轮不在表情更新节奏上（每 ${directorConfig.everyTurns} 轮一次），下一轮再更新即可。`,
        }
      }
      const slot = takeStageSlot(turnKey)
      if (!slot.ok) {
        return {
          ok: false,
          emotion: '',
          hint: `这一轮已经更新了 ${slot.used} 次，超过保护上限（${slot.ceiling} 次/轮），剩下的留到下一轮。`,
        }
      }
      const request = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
      const publishedAt = Date.now()
      const state = await stageStateFor(request, 'local')
      const key = String(exec?.agent?.id ?? '')
      // The browser half keys its stage by the requesting Session, so a
      // subagent's call reaches no visible stage instead of leaking onto it.
      publish(key, state)
      // One call can carry the face, the line and the memory: in this mode the
      // session model owns all three, and a second tool call would cost a turn.
      const remembered = await writeRemembered(request.remember, key)
      // Path A spoke for this turn: the director stays out of the way.
      localActAt.set(key, Date.now())
      // The line went to the bubble. Returning it would invite the model to repeat
      // it in the conversation, which is exactly what the bubble exists to avoid.
      const { line: _spoken, ...frame } = state
      // A pose that ships checks is only "done" once the browser has measured it.
      const measured = Array.isArray(state.checks) && state.checks.length > 0
        ? await waitForChecks(publishedAt, 600)
        : null
      return {
        ok: true,
        ...(measured === null
          ? {}
          : {
            checks: {
              passed: measured.results.filter(entry => entry.ok === true).length,
              failed: measured.results.filter(entry => entry.ok !== true).length,
              results: measured.results,
            },
          }),
        ...(remembered ? { remembered: true } : {}),
        ...frame,
        ...(state.unknownEmotion === undefined
          ? {}
          : { hint: `未知情绪 '${state.unknownEmotion}'，已按 neutral 处理` }),
      }
    },
  }

  /**
   * Memory a session writes for itself.
   *
   * The director remembers on its own when it runs; with the cross-session mode
   * off, nothing else would write memory, so the session model records what it
   * judged worth keeping. Both paths land in the same per-session file.
   */
  const rememberTool = {
    name: 'live2d_remember',
    description: [
      '记一条关于玩家或这段关系的事实，写进本会话的记忆。',
      '只记之后还用得上的东西：身份、偏好、承诺、反复出现的话题；不要记寒暄、也不要复述角色设定。',
      '一句话，尽量具体（「玩家在写 Live2D 插件」好过「玩家在忙」）。已经在记忆里的事实会被跳过。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '一句话事实，不超过 60 字' },
        kind: {
          type: 'string',
          enum: ['identity', 'preference', 'event', 'promise', 'note'],
          description: 'identity=身份/关系，promise=承诺，preference=偏好，event=发生过的事，note=其它',
        },
        importance: { type: 'number', description: '1-5，越大越不容易被裁掉；默认 3' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          stored: { type: 'boolean' },
          action: { type: 'string' },
          reason: { type: 'string' },
          total: { type: 'number' },
          summaries: { type: 'number' },
          limit: { type: 'number' },
        },
        required: ['stored', 'total', 'limit'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall(args) {
      const text = args && typeof args === 'object' && typeof args.text === 'string' ? args.text : 'remember'
      return { card: 'generic', title: `记忆 · ${text.slice(0, 24)}`, kind: 'other', rawInput: args }
    },
    async execute(args, exec) {
      const sessionId = String(exec?.agent?.id ?? '')
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      const stored = await writeRemembered({
        text,
        ...(typeof args?.kind === 'string' ? { kind: args.kind } : {}),
        ...(Number.isFinite(Number(args?.importance)) ? { importance: Number(args.importance) } : {}),
      }, sessionId)
      const memory = await loadMemory(sessionId)
      return {
        stored,
        ...(stored ? {} : { reason: text === '' ? '空内容' : '已经在记忆里' }),
        total: memory.facts.length,
        summaries: Array.isArray(memory.summaries) ? memory.summaries.length : 0,
        limit: config.sessionMaxFacts,
      }
    },
  }

  /**
   * Feed the director a draft.
   *
   * In the cross-session mode the stage belongs to the director, so the session
   * model cannot set the face directly. It can still tell the judge what it is
   * thinking or about to say, and the judge answers with the emotion, the line,
   * the expression and the motion.
   */
  const directTool = {
    name: 'live2d_direct',
    description: [
      '把当前的想法或即将说出的正文交给场外模型，由它生成这一刻的表情、动作、台词与记忆。',
      '只想不做也想让她的表情跟上时调用；写完正文后想定住这一刻也可以再调一次。',
      '内容用一两句概括即可，不要整段粘贴；场外模型还会看到最近几条对话。',
      '跨会话模式关闭时不要调用本工具——那时直接用 live2d_act 控制。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '此刻的想法，或你即将/刚刚说出的话' },
        kind: {
          type: 'string',
          enum: ['thought', 'output'],
          description: 'thought=心里正在想的（默认）；output=已经或即将说出口的',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          emotion: { type: 'string' },
          label: { type: 'string' },
          expression: { type: 'string' },
          motion: {
            type: 'object',
            additionalProperties: false,
            properties: { group: { type: 'string' }, index: { type: 'number' } },
          },
          remembered: { type: 'boolean' },
          hint: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall(args) {
      const text = args && typeof args === 'object' && typeof args.content === 'string' ? args.content : ''
      return { card: 'generic', title: `Live2D · ${text.slice(0, 24)}`, kind: 'other', rawInput: args }
    },
    async execute(args, exec) {
      if (directorConfig.mode === 'off') {
        return { ok: false, hint: '跨会话模式已关闭：用 live2d_act 直接控制表情与动作。' }
      }
      if (planner === undefined) {
        return { ok: false, hint: '宿主还没有可用的模型，场外模型无法运行。' }
      }
      if (!directorBudgetLeft()) {
        return { ok: false, hint: '场外模型的每小时次数已用完。' }
      }
      const sessionId = String(exec?.agent?.id ?? '')
      const content = typeof args?.content === 'string' ? args.content.trim() : ''
      if (content === '') return { ok: false, hint: 'content 不能为空。' }
      const slot = takeStageSlot(sessionId)
      if (!slot.ok) {
        return { ok: false, hint: `这一轮已经更新了 ${slot.used} 次，超过保护上限（${slot.ceiling} 次/轮），剩下的留到下一轮。` }
      }
      const result = await runDirector(sessionId, { text: content, kind: args?.kind })
      if (result === undefined) return { ok: false, hint: '场外模型没有给出可用的回复。' }
      const { state, reply } = result
      return {
        ok: true,
        emotion: state.emotion ?? '',
        ...(state.label === undefined ? {} : { label: state.label }),
        // The line is displayed in the bubble; returning it only tempts a repeat.
        ...(state.expression === undefined ? {} : { expression: state.expression }),
        ...(state.motion === undefined ? {} : { motion: state.motion }),
        remembered: reply.remember !== undefined && reply.remember !== '',
      }
    },
  }

  /** The parameter ids of the installed rig, for the prompt's animation hint. */
  /** Bone channels a VRM stage exposes, in degrees; empty for a Live2D model. */
  const vrmChannelIds = () => {
    const id = config.pack !== '' && config.pack !== 'off' ? config.pack : config.model
    if (id === '') return ''
    const candidates = [
      join(config.packsRoot, id, 'model'),
      join(config.packsRoot, id),
      join(config.modelsRoot, id),
    ]
    for (const dir of candidates) {
      try {
        if (readdirSync(dir).some(name => name.toLowerCase().endsWith('.vrm'))) {
          return VRM_CHANNELS.join(' ')
        }
      } catch {
        // A missing directory is simply not a 3D pack.
      }
    }
    return ''
  }

  /** Channels grouped by body part: one line per group instead of 150 ids in a row. */
  const groupedChannels = (bones) => {
    const groups = new Map()
    for (const id of bones.split(' ').filter(Boolean)) {
      const group = channelGroup(id)
      const list = groups.get(group) ?? []
      list.push(id.replace(/^Bone/, ''))
      groups.set(group, list)
    }
    return [...groups.entries()]
      .map(([group, ids]) => `${group}(${ids.slice(0, 8).join('/')}${ids.length > 8 ? '/…' : ''})`)
      .join(' ')
  }

  /** The recipe table the prompt shows: id(中文含义) per entry. */
  const recipeList = (recipes) => recipes
    .filter(entry => entry.kind === 'vrm' && vrmStageSupported())
    .map(entry => `${entry.id}(${entry.label}${entry.intent === '' ? '' : '：' + entry.intent})`)
    .join(' ')

  const rigIdsForPrompt = () => {
    const id = config.pack !== '' && config.pack !== 'off' ? config.pack : config.model
    const ids = rigFor(id === '' ? undefined : id).rig.params.map(entry => entry.id)
    return ids.join(' ')
  }

  // Optional services: a profile without a model plane still renders the stage.
  let toolsReady = false
  let toolsError
  ctx.inject(['tools', 'systemPrompt'], (agentCtx) => {
    try {
      agentCtx.effect(() => agentCtx.tools.register(actTool))
      toolsReady = true
    } catch (error) {
      // A rejected registration must be visible rather than silent: the agent
      // then has no way to drive the character, and nothing else reports it.
      toolsError = error?.message ?? String(error)
      console.warn('[dsh-live-tavern-lite] live2d_act 注册失败', error)
    }
    try {
      agentCtx.effect(() => agentCtx.tools.register(recallTool))
    } catch (error) {
      // Recall is a convenience; losing it must not take the character down.
      console.warn('[dsh-live-tavern-lite] live2d_recall 注册失败', error?.message ?? error)
    }
    try {
      agentCtx.effect(() => agentCtx.tools.register(rememberTool))
    } catch (error) {
      console.warn('[dsh-live-tavern-lite] live2d_remember 注册失败', error?.message ?? error)
    }
    try {
      agentCtx.effect(() => agentCtx.tools.register(directTool))
    } catch (error) {
      console.warn('[dsh-live-tavern-lite] live2d_direct 注册失败', error?.message ?? error)
    }
    try {
      agentCtx.effect(() => agentCtx.tools.register(paramsTool))
    } catch (error) {
      console.warn('[dsh-live-tavern-lite] live2d_params 注册失败', error?.message ?? error)
    }
    agentCtx.effect(() => agentCtx.systemPrompt.section({
      name: 'tool:live2d',
      order: agentCtx.systemPrompt.getSectionOrder('TOOL_GOAL') + SECTION_ORDER_OFFSET,
      // A literal section: `interpolate: false` lets the text be a function, which is
      // what keeps the channel ids and their notes current after an edit. Without the
      // flag the assembler would call `text.indexOf` on the function and throw.
      interpolate: false,
      text: () => [
        '屏幕上有玩家可见的 Live2D 角色，她的情绪表演由你决定。需要她表达情绪时调用 `live2d_act`。',
        '- `emotion` 从原型里选一个；必要时用 `valence`/`arousal` 微调。`line` 是显示在角色旁的短台词（≤60 字），不要重复正文。',
        '- 只在情绪真的变化时调用；同一情绪不要连续调用；不要每轮都调，也不要用它代替正常回答。',
        '- `line` 显示在角色旁边的气泡里，不会进入对话——所以不要在回复正文里重复它，也不要用它代替回答。',
        `- 原型：${emotionAsset.get().prototypes.map(item => `${item.id}(${item.label})`).join(' ')}`,
        '- 返回里会写明实际套用了哪个表情与动作；表情由模型标定决定，可能没有对应项，这是正常的。',
        '- 要一个具体动作（歪头、挥手、点头），给 `animation`：`参数=目标值@毫秒`，用 ; 或 - 连接，例如 `ParamAngleX=18@600; ParamAngleZ=-6@600`；它会从当前值插值过去，不是瞬切。',
        '- 同一参数写两次是接着走，不是同时跑：`ParamYL2=1@120; ParamYL2=0@260` 是先抬 120ms 再落 260ms。',
        '- 要「动一下就回来」的都用 `+=` / `-=`：点头 `ParamAngleY+=8@140; ParamAngleY+=0@180`、摇头、歪头、屈膝、尾巴摆，都会叠在当前值上再自然还回去。',
        '- `=` 只用在要停在某个确定值的地方（比如把眼闭上）；它会把值钉住，直到下一次情绪帧。',
        '- 一次要改一整套姿势时，用 `params` 对象代替一长串 `animation`：键是参数 id，值是目标值，token 更省、也不会漏掉分隔符。',
        ...(() => {
          const bones = vrmChannelIds()
          return bones === ''
            ? [
              `- 可用的参数 id：${rigIdsForPrompt()}`,
              '- 每个参数在这尊模型上的具体含义由玩家填写在工作台里，不在提示词里：需要时调用 `live2d_params` 读取。',
            ]
            : [
              `- 这是 3D（VRM）模型：动作由骨骼通道驱动，单位是度。通道按部位分组：${groupedChannels(bones)}`,
              `- 想做一个有名字的动作时，优先给 \`recipe\`（宿主会换算成骨骼值，比手写数字可靠）：${recipeList(poseRecipesAsset.get()?.recipes ?? [])}`,
              '  例：`{"emotion":"curious","recipe":"tilt"}`、`{"emotion":"joy","recipe":"nod","line":"找到啦。"}`。',
              '  需要一个配方没有的姿势时，才用 `params` 一次给全：`{"BoneHeadZ":12,"BoneSpineX":4}`，配 `easeMs` 控制过渡；有先后顺序（先点头再抬头）才写 `animation`。',
              '- 具体通道的 0 值状态、正负方向、典型幅度不在提示词里：先调用 `live2d_params`（可带 `group`：head/torso/arm/leg/finger）按部位读取，别凭名字猜；要设计新动作时先读一次 `live2d_params`（`guide: true`），那是实测生成的完整控制指南。',
              '- 生成动作之前先查现成的，别凭手感拼参数：① 上面列出的配方库里有同名动作就直接用；② 玩家的预设（`~/.dsh/live2d/packs/<角色>/presets.json`）里调好的指形与手臂优先照抄；两边都没有，才用 `params` / `animation` 现搭。',
            ]
        })(),
        ...(() => {
          const presets = presetsFor(config.pack !== '' && config.pack !== 'off' ? config.pack : config.model)
          return presets.length === 0 ? [] : [`- 自定义预设表情：${presets.map(item => `${item.id}(${item.label})`).join(' ')}——直接填进 emotion 即可。`]
        })(),
        ...(directorConfig.mode === 'off'
          ? [
            '- 这一局表情由你控制：`live2d_act` 一次就能给全——`emotion`/`valence` 定情绪，`expression` 选表情，`motion` 做模型自带动作，`animation` 写参数关键帧，`line` 是她的话，`remember` 顺手记一件事。',
            `- 这一局每轮至少要更新 ${config.stageUpdatesPerTurn} 次表情：思考到一半先动一次，正文写完再动一次；多动几次也没关系。`,
            '- 设置的「表情更新间隔」在这里同样生效：不在节奏上的轮次调用会被拒绝，留着下一轮。',
            '- 台词只走气泡：`line` 与场外模型给的台词都不会出现在对话里，别在正文重复。',
          ]
          : []),
        '忘了之前发生过什么，用 `live2d_recall` 检索：给 `query` 拿命中目录，给 `round` 读该轮原文。',
        '- 它返回的是历史回忆资料，只用于确认细节，不要当作当前场景继续演绎。',
      ].join('\n'),
    }))
  })

  // Character pack: the card is one global section, the world book is per-agent
  // so the entries follow the conversation of the session being assembled.
  if (pack !== undefined) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      const personaOrder = promptCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
      // Both sections belong to the role-playing plane. Cross-session mode keeps
      // the session agent as a normal assistant — the avatar is driven from the
      // outside there — so the card and the world book stay out of its prompt.
      // A section returning '' is dropped by the assembler, and reading the mode
      // per assembly means flipping the switch takes effect immediately.
      promptCtx.effect(() => promptCtx.systemPrompt.section({
        name: 'live2d:card',
        order: personaOrder - 10,
        // Card text is user data, not a prompt template: the renderer must not
        // interpret `{{...}}` in it, and the SillyTavern macros are already
        // substituted by renderCardSection.
        interpolate: false,
        text: () => (directorConfig.mode === 'off'
          ? renderCardSection(pack.card, { userName: config.playerName })
          : ''),
      }))
      promptCtx.effect(() => promptCtx.on('agent/created', ({ agent }) => {
        const scoped = agent?.ctx?.systemPrompt
        if (scoped === undefined) return
        const sessionId = String(agent.id)
        const disposer = agent.ctx.effect(() => scoped.section({
          name: 'live2d:worldbook',
          order: personaOrder - 5,
          interpolate: false,
          text: () => {
            if (directorConfig.mode !== 'off') return ''
            const digest = digests.get(sessionId) ?? []
            // Prompt assembly can run more than once per turn; counting each call
            // as a fresh assembly would double the cooldown counters and make the
            // report disagree with what was actually sent.
            const signature = `${digest.length}:${digest.length === 0 ? '' : digest[digest.length - 1].text}`
            const cached = worldbookPlans.get(sessionId)
            if (cached !== undefined && cached.signature === signature) {
              return renderWorldBookSection(cached.entries, {
                charName: pack.card.name,
                userName: config.playerName,
              })
            }
            const state = worldbookStates.get(sessionId) ?? { assemblies: 0, entries: new Map() }
            worldbookStates.set(sessionId, state)
            const planned = planWorldBook(pack.book, digest, {
              budgetTokens: config.worldbookBudgetTokens,
              scanDepth: config.worldbookScanDepth,
              cooldownAfter: config.worldbookCooldownRounds > 0 ? 2 : 0,
              cooldownRounds: config.worldbookCooldownRounds,
              state,
            })
            worldbookPlans.set(sessionId, { signature, entries: planned.entries, report: planned.report })
            lastWorldbookReport = {
              sessionId,
              at: Date.now(),
              pack: pack.id,
              total: pack.book.length,
              ...planned.report,
            }
            return renderWorldBookSection(planned.entries, {
              charName: pack.card.name,
              userName: config.playerName,
            })
          },
        }))
        // Unloading this plugin must not leave a section on a still-live agent.
        ctx.effect(() => disposer)
      }))
    })
  }

  /** One in-flight planner runtime, present only while `llm` and a default model exist. */
  let planner

  const directorBudgetLeft = () => {
    const now = Date.now()
    while (directorCalls.length > 0 && now - directorCalls[0] > 3_600_000) directorCalls.shift()
    return directorCalls.length < directorConfig.maxCallsPerHour
  }

  /**
   * Ask the session-external model how she feels right now.
   *
   * Failures are swallowed on purpose: the director decorates the stage, and a
   * provider outage must never surface inside the player's conversation.
   */
  /**
   * The request the director's reply becomes.
   *
   * Expression and motion are optional: an undeclared name is dropped by the
   * resolver, so a hallucinated expression cannot break the stage.
   */
  /** Ids a gesture may name for one model: bone channels or rig parameters. */
  const animatableIds = (model) => {
    if (model === null || model === undefined) return []
    const vrm = vrmChannelIds()
    if (vrm !== '') return vrm.split(' ')
    return rigFor(model.id).rig.params.map(entry => entry.id)
  }

  /**
   * Ids a pose may set: every channel the model declares, else the rig.
   *
   * A pose describes a whole body, so it may name any bone the browser bound —
   * the eleven-channel list the prompt quotes is a summary, not a limit. On a
   * Live2D model `channels` is absent and the rig table still answers.
   */
  const poseChannelIds = (model) => {
    if (model === null || model === undefined) return []
    const channels = Array.isArray(model.channels) ? model.channels : []
    // HipsY/HipsMoveY keyframe the whole-body offset (metres) rather than a bone rotation.
    if (channels.length > 0) return [...channels.map(entry => entry.id), 'HipsY', 'HipsMoveY']
    return [...animatableIds(model), 'HipsY', 'HipsMoveY']
  }

  /** Keyframe text accepted from the judge, filtered to channels that exist. */
  const cleanAnimation = (text, allowed) => {
    if (typeof text !== 'string' || text.trim() === '') return undefined
    const ids = new Set(allowed)
    const kept = parseTracks(text.trim().slice(0, ANIMATION_LIMIT), { maxEntries: 40000 }).filter(entry => ids.has(entry.id))
    if (kept.length === 0) return undefined
    return kept
      .map(entry => `${entry.id}${entry.mode === 'add' ? '+=' : entry.mode === 'subtract' ? '-=' : '='}${entry.value}@${entry.atMs}`)
      .join('; ')
      .slice(0, ANIMATION_LIMIT)
  }

  const directorRequest = (reply, allowed = []) => ({
    emotion: reply.emotion,
    valence: reply.valence,
    arousal: reply.arousal,
    line: reply.line,
    ...(() => {
      const animation = cleanAnimation(reply.animation, allowed)
      return animation === undefined ? {} : { animation }
    })(),
    ...(typeof reply.expression === 'string' && reply.expression !== '' ? { expression: reply.expression } : {}),
    ...(reply.motion !== null && typeof reply.motion === 'object' && typeof reply.motion.group === 'string'
      ? { motion: { group: reply.motion.group, index: Number(reply.motion.index) || 0 } }
      : {}),
  })

  const runDirector = async (sessionId, extra) => {
    const base = digests.get(sessionId) ?? []
    // A tool call may hand over a draft: it is visible to the judge but is not a
    // committed turn, so it never enters the digest itself.
    const draft = typeof extra?.text === 'string' ? extra.text.trim().slice(0, 600) : ''
    // Turns the cadence skipped ride along, oldest first, so nothing is lost.
    const backlog = (pendingTurns.get(sessionId) ?? []).map(entry => ({ role: 'since', from: entry.role, text: entry.text }))
    const digest = [
      ...backlog,
      ...base,
      ...(draft === '' ? [] : [{
        role: extra?.kind === 'action' ? 'action' : 'draft',
        text: draft,
        kind: extra.kind === 'output' ? 'output' : 'thought',
      }]),
    ]
    // A gesture carries meaning by itself: a tap on a session that has not spoken
    // yet still deserves an answer.
    if (digest.length === 0) return undefined
    let selection
    try {
      selection = directorConfig.provider !== '' && directorConfig.model !== ''
        ? { provider: directorConfig.provider, model: directorConfig.model }
        : planner.agentDefaultModel.currentSelection()
    } catch {
      return
    }
    const provider = typeof selection?.provider === 'string' ? selection.provider : ''
    const model = typeof selection?.model === 'string' ? selection.model : ''
    if (provider === '' || model === '') return
    directorCalls.push(Date.now())
    directorRunAt.set(sessionId, Date.now())
    try {
      memorySession = sessionId
      const memory = await loadMemory(sessionId)
      // The prompt sees the facts allowed by the chosen scope; writes stay local.
      const scoped = await factsForScope(sessionId)
      const visible = (await modelConfig()).selected
      const prompt = buildDirectorPrompt({
        library: libraryFor(visible === null ? undefined : visible.id),
        memory: scoped,
        digest,
        expressions: visible === null ? [] : (visible.expressions ?? []).slice(0, 24),
        motions: visible === null ? [] : (visible.motionGroups ?? []).slice(0, 12),
        // What a gesture may name: bone channels on a 3D model, rig parameters on a
        // Live2D one. Without this list the judge can only change her expression.
        channels: visible === null ? [] : animatableIds(visible),
      })
      let text = ''
      const chunks = planner.llm.stream({
        provider,
        model,
        // The effort is an adapter-owned value; empty leaves the provider default.
        ...(directorConfig.effort === '' ? {} : { reasoningEffort: directorConfig.effort }),
        system: prompt.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        maxTokens: directorConfig.maxTokens,
        temperature: 0.8,
      })
      for await (const chunk of chunks) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') break
      }
      const reply = parseDirectorReply(text)
      if (reply === undefined) return undefined
      const state = await stageStateFor(directorRequest(reply, animatableIds(visible)), 'director')
      publish(sessionId, state)
      const merged = mergeDirectorMemory(memory, reply, {
        maxFacts: config.sessionMaxFacts,
        source: { sessionId, round: rounds.get(sessionId) ?? 0 },
      })
      if (merged.changed) await saveMemory(merged.memory, sessionId)
      // The backlog reached the judge; the next takeover starts from the present.
      pendingTurns.delete(sessionId)
      return { reply, state }
    } catch (error) {
      console.warn('[dsh-live-tavern-lite] director call failed', error?.message ?? error)
      return undefined
    }
  }

  /** One interaction per session may reach the judge; taps are easy to spam. */
  const interactAt = new Map()
  const INTERACT_COOLDOWN_MS = 1_500

  /** The session that spoke most recently: the one the viewer is looking at. */
  const newestSession = () => {
    let best = ''
    let bestAt = -1
    for (const [id, at] of lastSeenAt) {
      if (at > bestAt) {
        best = id
        bestAt = at
      }
    }
    return best
  }

  /**
   * A click or a drag on the model.
   *
   * Only the cross-session mode has a judge to answer, so this is the one path a
   * pointer can take into it. The event is described in words, because the judge
   * reads text: it is not a coordinate it can use.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/interact`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'use POST' })
        return
      }
      if (directorConfig.mode === 'off') {
        sendJson(res, 409, { error: '跨会话模式已关闭：互动模式没有场外模型可以回应。' })
        return
      }
      if (config.interaction !== true) {
        sendJson(res, 409, { error: '互动模式未开启。' })
        return
      }
      if (planner === undefined) {
        sendJson(res, 503, { error: '宿主还没有可用的模型。' })
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req, 4 * 1024) || '{}')
      } catch (error) {
        sendJson(res, 400, { error: `body: ${error?.message ?? error}` })
        return
      }
      // The stage subscriber is a wildcard, so a frame addressed to a synthetic key
      // still reaches the page: an interaction before the first message works.
      const sessionId = String(body?.session ?? '') || newestSession() || 'interaction'
      if (!directorBudgetLeft()) {
        sendJson(res, 429, { error: '场外模型的每小时次数已用完。' })
        return
      }
      const last = interactAt.get(sessionId) ?? 0
      if (Date.now() - last < INTERACT_COOLDOWN_MS) {
        sendJson(res, 429, { error: '刚回应过，等一下再碰。' })
        return
      }
      interactAt.set(sessionId, Date.now())
      const kind = body?.kind === 'drag' ? 'drag' : 'tap'
      const text = kind === 'drag'
        ? '（玩家把你拖到了别的位置）'
        : '（玩家伸手点了你一下）'
      const result = await runDirector(sessionId, { text, kind: 'action' })
      if (result === undefined) {
        sendJson(res, 502, { error: '场外模型没有给出可用的回复。' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        emotion: result.state.emotion ?? '',
        ...(result.state.expression === undefined ? {} : { expression: result.state.expression }),
        ...(result.state.motion === undefined ? {} : { motion: result.state.motion }),
      })
    },
  }))

  /** Hybrid arbitration: path A wins the turn it spoke in; otherwise the director may act. */
  const considerDirector = (sessionId) => {
    if (directorConfig.mode !== 'hybrid' || planner === undefined) return
    if ((digests.get(sessionId) ?? []).length === 0) return
    // Cadence is a turn count, not a clock: every Nth turn the judge takes over.
    // The counter is the session's own user-turn number, so a long pause or a
    // burst of messages never changes the rhythm.
    const turns = rounds.get(sessionId) ?? 0
    if (directorConfig.everyTurns > 1 && turns % directorConfig.everyTurns !== 0) return
    if (!directorBudgetLeft()) return
    void runDirector(sessionId)
  }

  // Conversation bookkeeping is unconditional: the world book needs the same
  // digest whether or not a model plane is mounted for the director.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const key = String(session.id)
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      // Only root sessions: subagent traffic is not the player's mood.
      if (session.header?.parentSession !== undefined) return
      const text = extractText(event.data.message)
      if (text !== '') {
        lastSeenAt.set(key, Date.now())
        const role = event.type === 'user/message' ? 'user' : 'assistant'
        digests.set(key, pushDigest(digests.get(key) ?? [], role, text))
        // The transcript is the authoritative record behind the director's facts.
        if (role === 'user') rounds.set(key, (rounds.get(key) ?? 0) + 1)
        recordTurn(key, role, text)
        // Kept until the next takeover, so a skipped turn still reaches the judge.
        const backlog = pendingTurns.get(key) ?? []
        backlog.push({ role, text: text.slice(0, 600) })
        pendingTurns.set(key, backlog.slice(-24))
      }
      return
    }
    if (event.type === 'turn/end') considerDirector(key)
  }))

  ctx.inject(['llm', 'agentDefaultModel'], (plannerCtx) => {
    planner = plannerCtx
    plannerCtx.effect(() => () => {
      planner = undefined
    })
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/core.js`,
    async handler(req, res) {
      await serveFile(req, res, config.cubismCore)
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/config`,
    async handler(req, res) {
      try {
        sendJson(res, 200, await modelConfig())
      } catch (error) {
        // A broken install must still answer, or the browser half gives up and
        // the panel cannot be used to fix the very thing that broke.
        console.warn('[dsh-live-tavern-lite] /config failed', error?.message ?? error)
        sendJson(res, 200, {
          hostVersion: HOST_VERSION,
          error: error?.message ?? String(error),
          models: [],
          packs: [],
          pack: null,
          character: null,
          selected: null,
          placement: config.placement,
          textureLod: config.textureLod,
          opacity: config.opacity,
          lookAtPointer: config.lookAtPointer === true,
          hitBoxScale: config.hitBoxScale,
          memoryScope: config.memoryScope,
          sessionMaxFacts: config.sessionMaxFacts,
          recallScope: config.recallScope,
          director: directorConfig.mode !== 'off',
          stageEveryTurns: directorConfig.everyTurns,
          stageUpdatesPerTurn: config.stageUpdatesPerTurn,
          interaction: config.interaction === true,
          directorMaxFacts: directorConfig.maxFacts,
          directorMaxTokens: directorConfig.maxTokens,
          modelsRoot: config.modelsRoot,
          rig: { version: 0, stamp: 0, params: [], source: 'packaged' },
        })
      }
    },
  }))

  /**
   * Re-resolve the config after the settings page wrote the file.
   *
   * `resolveConfig` runs once at load, so the object every reader closes over
   * holds the values from that moment. Writing the file alone left the running
   * plugin on the old values until a restart, which looked exactly like a save
   * that did nothing: the form reported success while nothing moved.
   */
  const reloadSettings = () => {
    const fresh = resolveConfig(rawConfig)
    for (const key of Object.keys(fresh)) config[key] = fresh[key]
    directorConfig = resolveDirectorConfig(config.merged)
    packs = loadPacksSafely()
    pack = config.pack === '' ? packs[0] : packs.find(item => item.id === config.pack)
  }

  /** Latest geometric check results, pushed by the browser after applying a pose. */
  let lastPoseChecks = null

  /**
   * Wait briefly for the browser to report the checks of the pose just published.
   *
   * The Host cannot measure a skeleton; the browser can, and it answers within a frame or two.
   * Handing the numbers back with the tool result is what makes a bad pose visible instead of
   * silently accepted.
   *
   * @param since - Timestamp taken before the frame was published.
   * @param budgetMs - How long to wait.
   * @returns The reported result, or null when nothing arrived.
   */
  const waitForChecks = async (since, budgetMs) => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (lastPoseChecks !== null && lastPoseChecks.at !== null && lastPoseChecks.at >= since) return lastPoseChecks
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return null
  }

  /** The effective values the settings form edits, resolved once per request. */
  const settingsValues = () => ({
    placement: config.placement[0] ?? 'chat',
    vrmStage: config.vrmStage,
    mobileUi: config.mobileUi,
    model: config.modelRaw,
    pack: config.packRaw,
    playerName: config.playerName,
    textureLod: config.textureLod === false ? 'full' : String(config.textureLod),
    opacity: config.opacity,
    lookAtPointer: config.lookAtPointer === true,
    hitBoxScale: config.hitBoxScale,
    springGravity: config.springGravity,
    springStrength: config.springStrength,
    widthCap: config.widthCap,
    memoryScope: config.memoryScope,
    sessionMaxFacts: config.sessionMaxFacts,
    recallScope: config.recallScope,
    director: directorConfig.mode !== 'off',
    directorProvider: directorConfig.provider,
    directorModel: directorConfig.model,
    directorEffort: directorConfig.effort,
    stageEveryTurns: directorConfig.everyTurns,
    stageUpdatesPerTurn: config.stageUpdatesPerTurn,
    interaction: config.interaction === true,
    directorMaxCallsPerHour: directorConfig.maxCallsPerHour,
    directorMaxFacts: directorConfig.maxFacts,
    directorMaxTokens: directorConfig.maxTokens,
    worldbookBudgetTokens: config.worldbookBudgetTokens,
    rigMaxTokens: config.rigMaxTokens,
    worldbookScanDepth: config.worldbookScanDepth,
    worldbookCooldownRounds: config.worldbookCooldownRounds,
  })

  /**
   * The directory-picker service, resolved only through injection.
   *
   * Reading `ctx.directoryPicker` directly throws in Cordis when the name is not
   * a declared dependency, and that throw happened during apply — which aborted
   * every route registration, so the whole plugin looked missing.
   */
  let directoryPicker
  try {
    ctx.inject(['directoryPicker'], (pickerCtx) => {
      directoryPicker = pickerCtx.directoryPicker
      ctx.effect(() => () => { directoryPicker = undefined })
    })
  } catch {
    // A context that refuses the injection just leaves the chooser unavailable;
    // it must never take the routes down with it.
  }
  const directoryPickerOf = () => directoryPicker

  /**
   * The models the cross-session model may use.
   *
   * The composer's model picker is provider-grouped with a search field, so this
   * returns the same shape: every adapter's providers, each with its models, plus
   * the session default so the picker can offer "follow this session".
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/models/catalog`,
    async handler(req, res) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      if (planner === undefined) {
        sendJson(res, 501, { error: '当前会话没有模型服务' })
        return
      }
      let session
      try {
        const current = planner.agentDefaultModel.currentSelection()
        session = {
          provider: typeof current?.provider === 'string' ? current.provider : '',
          model: typeof current?.model === 'string' ? current.model : '',
        }
      } catch {
        session = undefined
      }
      const providers = []
      for (const provider of planner.llm.listProviders()) {
        let models = []
        try {
          const listed = await planner.llm.listModels(provider.id)
          models = await Promise.all(listed.map(async (model) => {
            const entry = { id: model.id, name: typeof model.name === 'string' ? model.name : model.id }
            try {
              // Only the route knows which reasoning efforts it accepts.
              const resolved = await planner.llm.resolveModelInfo(provider.id, model.id)
              const efforts = resolved?.reasoning?.efforts
              if (Array.isArray(efforts) && efforts.length > 0) {
                entry.efforts = efforts.map(effort => ({
                  id: String(effort.id),
                  name: typeof effort.name === 'string' ? effort.name : String(effort.id),
                  ...(typeof effort.description === 'string' ? { description: effort.description } : {}),
                }))
                if (resolved.reasoning.defaultEffort !== undefined) {
                  entry.defaultEffort = String(resolved.reasoning.defaultEffort)
                }
              }
            } catch {
              // A model with no reasoning metadata is still selectable.
            }
            return entry
          }))
        } catch {
          // A provider whose catalog cannot be read still appears, so the picker
          // shows the real world instead of hiding it.
        }
        providers.push({
          provider: provider.id,
          label: typeof provider.name === 'string' ? provider.name : provider.id,
          models,
        })
      }
      sendJson(res, 200, {
        providers,
        ...(session === undefined ? {} : { session }),
        selected: {
          provider: directorConfig.provider,
          model: directorConfig.model,
        },
      })
    },
  }))

  /**
   * Open the host's folder chooser and return what the operator picked.
   *
   * The model and the pack are folders on this machine, so the browser cannot
   * know their paths: a directory input only ever reveals file names. The Host
   * owns the chooser seam, so the browser asks here and gets an absolute path.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/directory`,
    async handler(req, res) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const picker = directoryPickerOf()
      if (picker === undefined) {
        sendJson(res, 501, { error: '宿主没有挂载目录选择服务' })
        return
      }
      let capability
      try {
        capability = picker.capability()
      } catch (error) {
        sendJson(res, 501, { error: error?.message ?? String(error) })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      // `probe=1` reports the interaction without opening anything, so the form
      // can explain why picking is unavailable instead of guessing.
      if (url.searchParams.get('probe') === '1') {
        sendJson(res, 200, { kind: capability?.kind ?? 'none', canPick: capability?.kind === 'native' })
        return
      }
      if (capability?.kind !== 'native') {
        sendJson(res, 501, {
          error: '当前宿主用的是浏览器内目录浏览，弹不出系统对话框',
          kind: capability?.kind ?? 'none',
        })
        return
      }
      const controller = new AbortController()
      if (typeof res.on === 'function') res.on('close', () => controller.abort())
      try {
        const picked = await capability.pick(controller.signal)
        sendJson(res, 200, { path: typeof picked === 'string' ? picked : null })
      } catch (error) {
        sendJson(res, 502, { error: error?.message ?? String(error) })
      }
    },
  }))

  /**
   * List one directory of the filesystem, so a folder can be chosen without a native dialog.
   *
   * The Android build has no file-system access API in its WebView and no system folder
   * chooser, so the settings page walks the tree through this route instead. Only directories
   * under the configured roots are listed: a pack lives in one of them, and nothing else on
   * the machine is this route's business.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/browse`,
    async handler(req, res) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const roots = [config.packsRoot, config.modelsRoot, dirname(config.settingsFile), '/sdcard', '/storage/emulated/0']
        .filter(root => typeof root === 'string' && root !== '' && existsSync(root))
      if (roots.length === 0) {
        sendJson(res, 503, { error: '没有可浏览的根目录' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const asked = (url.searchParams.get('path') ?? '').trim()
      const target = asked === '' ? roots[0] : resolve(asked)
      if (!roots.some(root => isInside(root, target))) {
        sendJson(res, 403, { error: '这个路径不在可浏览范围内', roots })
        return
      }
      let dirents
      try {
        dirents = await readdir(target, { withFileTypes: true })
      } catch (error) {
        sendJson(res, 404, { error: `读不了这个目录：${error?.code ?? error?.message ?? error}`, path: target })
        return
      }
      const entries = []
      for (const dirent of dirents) {
        if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
        const child = join(target, dirent.name)
        // A model is what makes a folder selectable as a pack: flag it here so the list can say so.
        const described = await describeDir(child, dirent.name)
        const nested = described ?? await describeDir(join(child, 'model'), dirent.name)
        entries.push({
          name: dirent.name,
          path: child,
          hasModel: nested !== undefined,
          kind: nested?.kind ?? null,
        })
      }
      entries.sort((left, right) => Number(right.hasModel) - Number(left.hasModel) || left.name.localeCompare(right.name, 'en'))
      const selfDescribed = await describeDir(target, basename(target))
        ?? await describeDir(join(target, 'model'), basename(target))
      const parent = roots.some(root => isInside(root, dirname(target)) && dirname(target) !== root) ? dirname(target) : null
      sendJson(res, 200, {
        path: target,
        parent,
        roots,
        entries,
        self: {
          hasModel: selfDescribed !== undefined,
          kind: selfDescribed?.kind ?? null,
          entryFile: selfDescribed?.entryFile ?? null,
        },
      })
    },
  }))

  /**
   * What the last prompt assembly put in from the world book, and why the rest
   * stayed out. Without this, tuning the budget or the scan depth is guesswork.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/worldbook`,
    handler(req, res) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      sendJson(res, 200, {
        pack: pack?.id ?? null,
        entries: pack?.book.length ?? 0,
        settings: {
          budgetTokens: config.worldbookBudgetTokens,
          scanDepth: config.worldbookScanDepth,
          cooldownRounds: config.worldbookCooldownRounds,
        },
        report: lastWorldbookReport ?? null,
      })
    },
  }))

  /**
   * The parameter workbench: every parameter the model declares, plus whatever
   * the user wrote next to it. The notes live beside the model, not in the
   * package, because they describe that model's art.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/params`,
    async handler(req, res) {
      if (mobileRuntime()) {
        sendJson(res, 404, { error: '参数工作台只在桌面端提供（安卓端没有工作台）' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const catalog = await modelConfig()
      const selected = catalog.selected
      if (selected === null) {
        sendJson(res, 404, { error: '还没有可用模型' })
        return
      }
      if (req.method === 'GET') {
        const notes = await readParams(selected.id)
        // A 3D model has no model3 parameters: its editable channels are the bones.
        if (selected.kind === 'vrm') {
          const parsed = vrmChannelsFor(join(selected.dir, selected.entryFile))
          const channels = parsed.length > 0
            ? parsed
            : VRM_CHANNELS.map((id) => {
              const range = VRM_CHANNEL_RANGE[id] ?? [-45, 45]
              return { id, bone: '', axis: '', min: range[0], max: range[1] }
            })
          sendJson(res, 200, {
            model: selected.id,
            kind: 'vrm',
            expressions: [],
            emotions: emotionIds(),
            presets: presetsFor(selected.id).map(entry => ({ id: entry.id, label: entry.label })),
            defaults: await readDefaults(selected.id),
            ids: channels.map(entry => entry.id),
            ranges: Object.fromEntries(channels.map(entry => [entry.id, [entry.min, entry.max]])),
            channels,
            notes: notes.params,
            defaults: vrmDefaultsAsset.get()?.channels ?? {},
            rig: { source: 'none', ids: [], described: {} },
            file: paramsFile(selected.id),
          })
          return
        }
        const current = rigFor(selected.id)
        sendJson(res, 200, {
          model: selected.id,
          kind: 'live2d',
          expressions: selected.expressions ?? [],
          emotions: emotionIds(),
          presets: presetsFor(selected.id).map(entry => ({ id: entry.id, label: entry.label })),
          defaults: await readDefaults(selected.id),
          ids: selected.parameters ?? [],
          notes: notes.params,
          rig: {
            source: current.source,
            ids: current.rig.params.map(entry => entry.id),
            // Existing roles and notes seed the workbench: a parameter that the
            // table already describes should not open as an empty box.
            described: Object.fromEntries(current.rig.params.map(entry => [entry.id, {
              role: entry.role,
              ...(entry.note === '' ? {} : { note: entry.note }),
            }])),
          },
          file: paramsFile(selected.id),
        })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let patch
      try {
        patch = JSON.parse(await readBody(req, 512 * 1024))
      } catch (error) {
        sendJson(res, 400, { error: error?.message ?? String(error) })
        return
      }
      const incoming = patch && typeof patch === 'object' && patch.params !== null && typeof patch === 'object' ? patch.params : null
      if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
        sendJson(res, 400, { error: 'params must be an object' })
        return
      }
      const clean = {}
      for (const [id, value] of Object.entries(incoming)) {
        if (!/^[A-Za-z0-9_]+$/.test(id)) {
          sendJson(res, 400, { error: `invalid parameter id '${id}'` })
          return
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          sendJson(res, 400, { error: `${id}: note must be an object` })
          return
        }
        const note = typeof value.note === 'string' ? value.note.trim().slice(0, 200) : ''
        const verified = value.verified === true
        if (note === '' && !verified) continue
        clean[id] = { ...(note === '' ? {} : { note }), ...(verified ? { verified: true } : {}) }
      }
      const next = { version: 1, updatedAt: Date.now(), params: clean }
      // Refuse to wipe a file this request was not based on. A workbench tab opened
      // before someone else's write would otherwise save an empty table over it.
      const existing = Object.keys((await readParams(selected.id)).params).length
      const expected = Number(patch?.expected)
      if (existing > 0 && Object.keys(clean).length === 0 && expected !== existing) {
        sendJson(res, 409, {
          error: `备注文件里已有 ${existing} 条，这次提交只基于 ${Number.isFinite(expected) ? expected : 0} 条：可能是在别处写入过，刷新工作台再试。`,
          existing,
        })
        return
      }
      const file = paramsFile(selected.id)
      if (!isInside(config.packsRoot, file) && !isInside(config.modelsRoot, file)) {
        sendJson(res, 400, { error: 'model path escapes the models root' })
        return
      }
      await mkdir(dirname(file), { recursive: true })
      await writeJsonAtomic(file, next)
      sendJson(res, 200, { ok: true, model: selected.id, params: clean, file })
    },
  }))

  /**
   * The pose the model starts in.
   *
   * Written from the parameter workbench, applied by the browser once the model is
   * ready: `expression` names a file the model declares, `emotion` names a prototype
   * the rig or the expression map knows how to resolve.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/defaults`,
    async handler(req, res) {
      const catalog = await modelConfig()
      const selected = catalog.selected
      if (selected === null) {
        sendJson(res, 404, { error: '还没有可用模型' })
        return
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { model: selected.id, defaults: await readDefaults(selected.id), file: defaultsFile(selected.id) })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let patch
      try {
        patch = JSON.parse(await readBody(req, 64 * 1024))
      } catch (error) {
        sendJson(res, 400, { error: error?.message ?? String(error) })
        return
      }
      const expression = typeof patch?.expression === 'string' ? patch.expression.trim() : ''
      const emotion = typeof patch?.emotion === 'string' ? patch.emotion.trim() : ''
      if (expression.length > 64) {
        sendJson(res, 400, { error: 'expression name is too long' })
        return
      }
      const presetIds = new Set(presetsFor(selected.id).map(entry => entry.id))
      if (emotion !== '' && !isEmotion(emotion) && !presetIds.has(emotion)) {
        sendJson(res, 400, { error: `unknown emotion '${emotion}'` })
        return
      }
      const next = { version: 1, updatedAt: Date.now(), expression, emotion }
      const file = defaultsFile(selected.id)
      if (!isInside(config.packsRoot, file) && !isInside(config.modelsRoot, file)) {
        sendJson(res, 400, { error: 'model path escapes the models root' })
        return
      }
      await mkdir(dirname(file), { recursive: true })
      await writeJsonAtomic(file, next)
      sendJson(res, 200, { ok: true, model: selected.id, defaults: { expression, emotion }, file })
    },
  }))

  /**
   * Resolve one emotion into a frame without going through a model call.
   *
   * The workbench needs this to preview a default pose: the mapping table lives on the
   * Host, and duplicating it in the browser would drift.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/stage/preview`,
    async handler(req, res) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const emotion = (url.searchParams.get('emotion') ?? '').trim()
      if (emotion === '') {
        sendJson(res, 400, { error: 'emotion is required' })
        return
      }
      const frame = await stageStateFor({ emotion, intensity: 0.8 }, 'preview')
      sendJson(res, 200, frame)
    },
  }))

  /**
   * Ask the configured model to turn the collected notes into a rig table.
   *
   * The result is validated before it is written, so a hallucinated parameter id
   * or a weight outside the range cannot reach the renderer.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/rig/generate`,
    async handler(req, res) {
      if (mobileRuntime()) {
        sendJson(res, 404, { error: '参数工作台只在桌面端提供（安卓端没有工作台）' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const catalog = await modelConfig()
      const selected = catalog.selected
      if (selected === null) {
        sendJson(res, 404, { error: '还没有可用模型' })
        return
      }
      let body = {}
      try {
        body = JSON.parse(await readBody(req, 16 * 1024)) ?? {}
      } catch {
        // An empty body means the default mode.
      }
      const mode = body.mode === 'update' ? 'update' : 'regenerate'
      const tableFile = packFilePath(config, selected.id, 'rig.json')
      if (!isInside(config.packsRoot, tableFile) && !isInside(config.modelsRoot, tableFile)) {
        sendJson(res, 400, { error: 'model path escapes the models root' })
        return
      }
      const current = rigFor(selected.id)
      if (mode === 'update' && current.source !== 'model') {
        sendJson(res, 400, { error: '这个模型还没有自己的映射表，只能重新生成' })
        return
      }
      const notes = await readParams(selected.id)
      const described = Object.entries(notes.params).filter(([, value]) => value.verified === true)
      if (described.length === 0) {
        sendJson(res, 400, { error: '先在参数工作台里把至少一个参数标为“已确认”并写备注' })
        return
      }
      if (planner === undefined || planner === null) {
        sendJson(res, 501, { error: '当前会话没有可用的默认模型，无法生成' })
        return
      }
      let selection
      try {
        selection = directorConfig.provider !== '' && directorConfig.model !== ''
          ? { provider: directorConfig.provider, model: directorConfig.model }
          : planner.agentDefaultModel.currentSelection()
      } catch {
        selection = undefined
      }
      const provider = typeof selection?.provider === 'string' ? selection.provider : ''
      const model = typeof selection?.model === 'string' ? selection.model : ''
      if (provider === '' || model === '') {
        sendJson(res, 501, { error: '当前会话没有可用的默认模型，无法生成' })
        return
      }
      const known = new Set(selected.parameters ?? [])
      const lines = described.map(([id, value]) => `- ${id}：${value.note ?? '（无备注）'}`)
      const prompt = {
        system: [
          '你是一个 Live2D 参数映射器。用户会给出一批模型参数与人工备注，',
          '你要输出一张「情绪向量 → 参数」的映射表，格式是严格的 JSON。',
          '规则：',
          '1. 只使用用户给出的参数 id，不得发明新的 id。',
          '2. 每个参数给 base（静止时的值，未知就 0，眼睛睁开类给 1）、min、max、',
          '   weights（valence/arousal/dominance 各一个 -1..1 的系数）。',
          '   还要给 zone：脸部参数写 "face"，身体与四肢写 "pose"。',
          '3. 备注里明确方向的按备注来；不确定的方向给 0，不要瞎猜。',
          '4. 参数数量控制在 30 个以内，优先给备注最明确的那几个。',
          '5. 备注要求「一直保持最大值」「恒定不变」「常驻」「开关」这类不随情绪变化的参数，',
          '   给它们 "fixed": true，base 取备注要求的那个值（常开写 max、常关写 min），',
          '   并且不要给 weights：这类参数不接受任何情绪系数，写了的权重会被忽略。',
          '   它们必须收录，不受第 4 条上限限制。',
          '5b. min 与 max 相同的参数同样视为 fixed，也不用给 weights。',
          '6. 输出必须是 {"version":2,"params":[...]} 的 JSON，不要解释、不要代码块，也不要用省略号。',
        ].join('\n'),
        user: [
          `模型参数与备注（共 ${lines.length} 条）：`,
          ...lines,
          '',
          ...(mode === 'update'
            ? [
              '当前已有的映射表（JSON）：',
              JSON.stringify({ version: 2, params: current.rig.params }),
              '',
              '这是更新，不是重做：现有条目一律保留，它们的 base/min/max/weights/fixed 除非',
              '备注明确提出，否则原样照抄；fixed 条目不要补上 weights；',
              '只需为备注里新出现、表里还没有的参数补条目。',
              '仍然输出完整的一张表。',
              '',
            ]
            : []),
          `参数 id 必须取自：${[...known].slice(0, 240).join('、')}`,
        ].join('\n'),
      }

      /**
       * Run one request and keep why it stopped.
       *
       * An empty reply used to surface as "模型没有返回 JSON" with no evidence: the
       * stream can finish with `max-tokens` (a reasoning model spending the whole
       * output budget thinking), `error`, or `aborted`, and each of those has a
       * different fix. Keep the reason and the failure message.
       *
       * @param maxTokens - Output budget for this attempt.
       * @returns Text, reasoning size and the finish evidence.
       */
      const runStream = async (maxTokens) => {
        let text = ''
        let reasoningChars = 0
        let reason
        let failure
        const kinds = new Map()
        const chunks = planner.llm.stream({
          provider,
          model,
          system: prompt.system,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
          maxTokens,
          temperature: 0.2,
        })
        for await (const chunk of chunks) {
          kinds.set(chunk.type, (kinds.get(chunk.type) ?? 0) + 1)
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
          else if (chunk.type === 'finish') {
            reason = chunk.reason?.kind
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
              failure = chunk.reason.failure?.message ?? chunk.reason.failure?.code
            }
            if (chunk.reason?.kind !== 'stop') break
          }
        }
        return { text, reasoningChars, reason, failure, kinds: Object.fromEntries(kinds) }
      }

      let attempt
      try {
        attempt = await runStream(config.rigMaxTokens)
        // An empty first answer is worth one retry whatever the reason: a
        // reasoning model can spend the whole budget before writing anything, and
        // a provider can also stop cleanly with no content.
        if (attempt.text.trim() === '') {
          attempt = await runStream(config.rigMaxTokens * 2)
        }
      } catch (error) {
        sendJson(res, 502, { error: `生成失败：${error?.message ?? error}` })
        return
      }
      const text = attempt.text
      if (text.trim() === '') {
        sendJson(res, 502, {
          error: `模型没有返回正文（结束时原因：${attempt.reason ?? '未知'}）`,
          reason: attempt.reason ?? null,
          ...(attempt.failure === undefined ? {} : { failure: String(attempt.failure) }),
          reasoningChars: attempt.reasoningChars,
          chunkKinds: attempt.kinds,
        })
        return
      }
      let reply = parseRigReply(text)
      // A table cut off by the output budget is worth one bigger attempt before
      // the salvaged remainder is accepted.
      if (reply === undefined && attempt.reason === 'max-tokens') {
        try {
          attempt = await runStream(config.rigMaxTokens * 2)
        } catch (error) {
          sendJson(res, 502, { error: `生成失败：${error?.message ?? error}` })
          return
        }
        reply = parseRigReply(attempt.text)
      }
      if (reply === undefined) {
        sendJson(res, 502, {
          error: '模型返回的内容里没有可用的映射表',
          reason: attempt.reason ?? null,
          chars: text.length,
          raw: text.slice(0, 400),
        })
        return
      }
      let parsed
      try {
        parsed = normalizeRig(reply.value)
      } catch (error) {
        sendJson(res, 422, {
          error: `映射表不合法：${error?.message ?? error}`,
          ...(reply.salvaged ? { salvaged: reply.kept } : {}),
          raw: text.slice(0, 400),
        })
        return
      }
      const rejected = parsed.params.filter(entry => !known.has(entry.id)).map(entry => entry.id)
      if (rejected.length > 0) {
        sendJson(res, 422, { error: `映射表用了模型没有的参数：${rejected.join('、')}` })
        return
      }
      await mkdir(dirname(tableFile), { recursive: true })
      await writeJsonAtomic(tableFile, { version: 2, params: parsed.params })
      sendJson(res, 200, {
        ok: true,
        model: selected.id,
        mode,
        file: tableFile,
        ...(reply.salvaged ? { salvaged: reply.kept, dropped: reply.dropped } : {}),
        params: parsed.params.map(entry => ({ id: entry.id, role: entry.role })),
      })
    },
  }))

  /**
   * Custom presets: list them, and replace the list.
   *
   * The model's own expressions are the vocabulary; a preset names one of them and
   * fixes the emotion vector it stands for, so `live2d_act` can be given a short id
   * the user wrote instead of a vector every time.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/presets`,
    async handler(req, res) {
      const catalog = await modelConfig()
      const selected = catalog.selected
      if (selected === null) {
        sendJson(res, 409, { error: '还没有选中的模型。' })
        return
      }
      if (req.method === 'GET') {
        sendJson(res, 200, {
          pack: catalog.pack,
          expressions: selected.expressions ?? [],
          presets: presetsFor(selected.id),
          file: packFilePath(config, selected.id, 'presets.json'),
        })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'use GET or POST' })
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req, 128 * 1024))
      } catch (error) {
        sendJson(res, 400, { error: `body: ${error?.message ?? error}` })
        return
      }
      let next
      try {
        next = normalizePresets(body)
      } catch (error) {
        sendJson(res, 400, { error: error?.message ?? String(error) })
        return
      }
      const file = packFilePath(config, selected.id, 'presets.json')
      if (!isInside(config.packsRoot, file) && !isInside(config.modelsRoot, file)) {
        sendJson(res, 400, { error: 'model path escapes the models root' })
        return
      }
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeJsonAtomic(file, next)
      } catch (error) {
        sendJson(res, 500, { error: `write failed: ${error?.message ?? error}` })
        return
      }
      // The watcher notices the new mtime; drop the cache so this response sees it.
      presetWatchers.delete(file)
      sendJson(res, 200, { ok: true, presets: normalizePresets(next).presets, file })
    },
  }))

  /**
   * Save the pose currently dialled into the workbench as a named recipe.
   *
   * Poses are judged by eye, and the only eye at the stage is the player's, so authoring has to
   * happen there: sliders move the model, one button writes the result back as a recipe.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/recipes`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'use POST' })
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req, 128 * 1024))
      } catch (error) {
        sendJson(res, 400, { error: `body: ${error?.message ?? error}` })
        return
      }
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      if (!/^[a-z][a-z0-9_-]{1,31}$/.test(id)) {
        sendJson(res, 400, { error: '配方 id 只能用小写字母、数字、下划线和短横，且以字母开头' })
        return
      }
      const params = {}
      for (const [channel, value] of Object.entries(body?.params ?? {})) {
        const number = Number(value)
        if (!/^Bone[A-Za-z]+[XYZ]$/.test(channel) || !Number.isFinite(number)) continue
        if (Math.abs(number) < 0.5) continue
        params[channel] = Math.min(180, Math.max(-180, Math.round(number)))
      }
      if (Object.keys(params).length === 0) {
        sendJson(res, 400, { error: '没有可保存的通道值：先把滑块拖离中线' })
        return
      }
      const translate = {}
      const hips = body?.translate?.hips
      if (Array.isArray(hips) && hips.length === 3 && hips.every(value => Number.isFinite(Number(value)))) {
        const numbers = hips.map(value => Number(value))
        if (numbers.some(value => Math.abs(value) > 0.001)) {
          translate.hips = numbers.map(value => Math.min(2, Math.max(-2, Number(value.toFixed(3)))))
        }
      }
      let library
      try {
        library = JSON.parse(readFileSync(POSE_RECIPES_ASSET, 'utf8'))
      } catch (error) {
        sendJson(res, 500, { error: `读取配方表失败：${error?.message ?? error}` })
        return
      }
      const recipes = Array.isArray(library?.recipes) ? library.recipes : []
      const entry = {
        id,
        label: typeof body?.label === 'string' && body.label.trim() !== '' ? body.label.trim().slice(0, 24) : id,
        intent: typeof body?.intent === 'string' ? body.intent.trim().slice(0, 60) : '',
        kind: 'vrm',
        params,
        ...(Object.keys(translate).length === 0 ? {} : { translate }),
        easeMs: Math.min(4000, Math.max(60, Math.round(Number(body?.easeMs) || 600))),
      }
      const index = recipes.findIndex(item => item?.id === id)
      if (index >= 0) recipes[index] = { ...recipes[index], ...entry }
      else recipes.push(entry)
      library.recipes = recipes
      try {
        copyFileSync(POSE_RECIPES_ASSET, `${POSE_RECIPES_ASSET}.bak`)
        writeFileSync(POSE_RECIPES_ASSET, `${JSON.stringify(library, null, 2)}
`, 'utf8')
      } catch (error) {
        sendJson(res, 500, { error: `写入配方表失败：${error?.message ?? error}` })
        return
      }
      sendJson(res, 200, { ok: true, id, params: Object.keys(params).length, file: POSE_RECIPES_ASSET })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/checks`,
    async handler(req, res) {
      if (req.method === 'GET') {
        sendJson(res, 200, lastPoseChecks ?? { recipe: null, results: [], at: null })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'use GET or POST' })
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req, 64 * 1024))
      } catch (error) {
        sendJson(res, 400, { error: `body: ${error?.message ?? error}` })
        return
      }
      const results = (Array.isArray(body?.results) ? body.results : [])
        .filter(item => item !== null && typeof item === 'object' && typeof item.type === 'string')
        .slice(0, 8)
        .map(item => ({
          type: item.type.slice(0, 24),
          ok: item.ok === true,
          value: Number.isFinite(Number(item.value)) ? Number(Number(item.value).toFixed(3)) : null,
          target: Number.isFinite(Number(item.target)) ? Number(item.target) : null,
          text: typeof item.text === 'string' ? item.text.slice(0, 120) : '',
        }))
      lastPoseChecks = {
        recipe: typeof body?.recipe === 'string' ? body.recipe.slice(0, 32) : null,
        results,
        at: Date.now(),
      }
      sendJson(res, 200, { ok: true, count: results.length })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/settings`,
    async handler(req, res) {
      if (req.method === 'GET') {
        const kind = await selectedStageKind()
        const mobile = mobileRuntime()
        sendJson(res, 200, {
          // A field with `kinds` only exists for those stages; the rest are for both.
          fields: SETTINGS_FIELDS
            .filter(field => field.kinds === undefined || field.kinds.includes(kind))
            // The phone shell has no sidebar anchor, so the option is not offered there.
            .map(field => (field.key === 'placement' && mobile
              ? { ...field, options: field.options.filter(option => option !== 'sidebar') }
              : field)),
          stageKind: kind,
          values: settingsValues(),
          defaults: config.defaults,
          stored: config.settingsOverlay,
          file: config.settingsFile,
        })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let patch
      try {
        patch = validateSettingsPatch(JSON.parse(await readBody(req, 64 * 1024)))
      } catch (error) {
        sendJson(res, 400, { error: error?.message ?? String(error) })
        return
      }
      const next = { ...config.settingsOverlay, ...patch }
      await mkdir(dirname(config.settingsFile), { recursive: true })
      await writeJsonAtomic(config.settingsFile, next)
      reloadSettings()
      sendJson(res, 200, { ok: true, values: settingsValues(), stored: config.settingsOverlay })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/models`,
    async handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const requested = decodeURIComponent(url.pathname.slice(`${ROUTE_PREFIX}/models/`.length))
      if (requested === '') {
        sendJson(res, 400, { error: 'missing model path' })
        return
      }
      const slash = requested.indexOf('/')
      const modelId = slash === -1 ? requested : requested.slice(0, slash)
      const rest = slash === -1 ? '' : requested.slice(slash + 1)
      const catalog = await listModels()
      const found = catalog.find(model => model.id === modelId)
      const root = found === undefined ? undefined : found.dir
      const target = root === undefined ? undefined : resolve(root, rest)
      if (root === undefined || !isInside(root, target)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      await serveFile(req, res, target)
    },
  }))

  /**
   * One-shot picture of what this Host module actually loaded.
   *
   * It exists so a restarted process can be accepted with a single request
   * instead of a browser console: version, pack, director readiness, whether the
   * control tool registered, and whether any stage is connected.
   */
  const hostDiagnostics = () => ({
    hostVersion: HOST_VERSION,
    modelsRoot: config.modelsRoot,
    model: config.model === '' ? 'auto' : config.model,
    placement: config.placement,
    pack: pack?.id ?? null,
    cards: packs.map(item => ({ id: item.id, name: item.card.name, worldbook: item.book.length })),
    toolsRegistered: toolsReady,
    toolsError: toolsError ?? null,
    director: {
      mode: directorConfig.mode,
      ready: planner !== undefined,
      callsLastHour: directorCalls.length,
      memoryFile: dirname(currentMemoryFile()),
      memoryScope: config.memoryScope,
      sessionMaxFacts: config.sessionMaxFacts,
      facts: Array.isArray(memoryCache?.facts) ? memoryCache.facts.length : 0,
    },
    stage: {
      subscribers: subscribers.size,
      lastFrameAt: lastFrame?.time ?? null,
      lastEmotion: lastFrame?.emotion ?? null,
      lastSource: lastFrame?.source ?? null,
    },
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/status`,
    async handler(req, res) {
      if (req.method === 'GET') {
        sendJson(res, 200, { reported: report !== null, ...(report ?? {}), host: hostDiagnostics() })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = JSON.parse(await readBody(req, 64 * 1024))
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'report must be a JSON object' })
        return
      }
      report = { reported: true, at: Date.now(), ...body }
      sendJson(res, 200, { ok: true })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/binding`,
    async handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const modelId = String(url.searchParams.get('model') ?? '').trim()
      if (modelId === '' || modelId.includes('/') || modelId.includes('\\') || modelId.startsWith('.')) {
        sendJson(res, 400, { error: 'invalid model id' })
        return
      }
      const file = join(config.modelsRoot, modelId, 'binding.json')
      if (!isInside(config.modelsRoot, file)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      if (req.method === 'GET') {
        sendJson(res, 200, (await readJson(file)) ?? { version: 1, expressions: {} })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = JSON.parse(await readBody(req, config.maxBindingBytes))
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'binding must be a JSON object' })
        return
      }
      const expressions = body.expressions
      if (expressions !== undefined && (expressions === null || typeof expressions !== 'object' || Array.isArray(expressions))) {
        sendJson(res, 400, { error: 'binding.expressions must be an object' })
        return
      }
      await mkdir(dirname(file), { recursive: true })
      await writeJsonAtomic(file, { version: 1, updatedAt: Date.now(), expressions: expressions ?? {} })
      sendJson(res, 200, { ok: true })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/stage`,
    handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = String(url.searchParams.get('session') ?? '')
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const subscriber = { sessionId, res }
      subscribers.add(subscriber)
      res.write(`retry: 3000\n\n`)
      const current = sessionId === '' ? lastFrame : stages.get(sessionId)
      if (current !== undefined) res.write(`event: stage\ndata: ${JSON.stringify(current)}\n\n`)
      const heartbeat = setInterval(() => {
        try {
          res.write(': keep-alive\n\n')
        } catch {
          clearInterval(heartbeat)
          subscribers.delete(subscriber)
        }
      }, 20_000)
      if (typeof heartbeat.unref === 'function') heartbeat.unref()
      const close = () => {
        clearInterval(heartbeat)
        subscribers.delete(subscriber)
      }
      req.on('close', close)
      res.on('close', close)
    },
  }))

  // Disposal keeps no timers or sockets alive behind a removed plugin row.
  ctx.effect(() => () => {
    for (const subscriber of subscribers) {
      try {
        subscriber.res.end()
      } catch {
        // The peer may already be gone; nothing to release in that case.
      }
    }
    subscribers.clear()
    stages.clear()
  })

  ctx.effect(() => {
    ctx.logger.info?.('dsh-live-tavern-lite: models at %s, placement %s', config.modelsRoot, config.placement.join(','))
  })
}

/** Exported for tests: the pure config/emotion/URL helpers the plugin relies on. */
export const internals = {
  resolveConfig,
  resolvePlacement,
  resolveLod,
  isInside,
  scanModels,
  mimeOf,
  loadEmotionLibrary,
  /** Preset normalisation, so its validation stays covered without a route. */
  normalizePresets,
  resolveEmotionTarget,
  resolveMotion,
  clamp,
  /** The reply parser, so the truncation path stays covered. */
  parseRigReply,
  /** The exact schemas the control tool registers; validated by `test/schema.test.mjs`. */
  actToolSchemas: { parameters: ACT_TOOL_PARAMETERS, output: ACT_TOOL_OUTPUT_SCHEMA },
  /** Settings descriptors and their validator, shared by the route and the page. */
  settingsFields: SETTINGS_FIELDS,
  validateSettingsPatch,
}
