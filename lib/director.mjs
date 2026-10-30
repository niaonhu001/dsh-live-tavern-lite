/**
 * The director: the session-external model that carries cross-session memory.
 *
 * It is deliberately *not* an Agent. One `llm.stream` call per turn boundary is
 * enough to answer "how does she feel right now, and what should I remember",
 * it costs a fraction of a spawned Agent's context, and every failure stays
 * inside this module instead of touching the conversation loop.
 *
 * Everything here is pure: the caller owns files, timers and the event stream.
 */

import { addFact, selectFacts } from './memory.mjs'

const DEFAULT_EVERY_TURNS = 1
const DEFAULT_MAX_CALLS_PER_HOUR = 60
const DEFAULT_MAX_FACTS = 24
const DEFAULT_MAX_TOKENS = 4_096
const MAX_DIGEST_MESSAGES = 6
const MAX_FACT_LENGTH = 160

/** Validated director settings; a bad value fails the plugin instead of the turn. */
export function resolveDirectorConfig(config) {
  // The setting is a switch now, but a stored settings.json may still hold the old
  // `'hybrid'` / `'off'` strings, so both spellings stay readable.
  const raw = value => (value === undefined || value === '' ? undefined : value)
  // The mode picker is the authority; `director` (boolean) and `directorPersona`
  // remain readable so a settings file written before it still resolves.
  const requestedMode = raw(config?.directorMode)
  const requested = raw(config?.director)
  let mode
  if (requestedMode === 'off' || requestedMode === 'hybrid' || requestedMode === 'persona') {
    mode = requestedMode
  } else if (requestedMode !== undefined) {
    throw new Error(`dsh-live-tavern-lite: directorMode must be off, hybrid or persona — got '${String(requestedMode)}'`)
  } else if (requested === undefined) mode = 'hybrid'
  else if (typeof requested === 'boolean') mode = requested ? 'hybrid' : 'off'
  else if (requested === 'hybrid' || requested === 'off' || requested === 'persona') mode = requested
  else throw new Error(`dsh-live-tavern-lite: director must be a boolean — got '${String(requested)}'`)
  // Two cross-session flavours: `hybrid` keeps the session model a plain assistant,
  // `persona` hands it the character card and the world book as well. The lines and
  // the face stay with the director in both.
  if (requestedMode === undefined && mode !== 'off' && config?.directorPersona === true) mode = 'persona'
  const positive = (value, fallback, field) => {
    if (value === undefined || value === null || value === '') return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`dsh-live-tavern-lite: ${field} must be a positive number — got '${value}'`)
    }
    return parsed
  }
  return {
    mode,
    provider: typeof config?.directorProvider === 'string' ? config.directorProvider.trim() : '',
    model: typeof config?.directorModel === 'string' ? config.directorModel.trim() : '',
    /** Adapter-owned reasoning effort; empty leaves the provider default. */
    effort: typeof config?.directorEffort === 'string' ? config.directorEffort.trim() : '',
    // Cadence is counted in turns now; the millisecond window stays readable for
    // an older settings file but no longer gates anything.
    // The cadence is stage-wide; the old key is still readable.
    everyTurns: Math.trunc(positive(
      config?.stageEveryTurns === undefined ? config?.directorEveryTurns : config.stageEveryTurns,
      DEFAULT_EVERY_TURNS,
      'stageEveryTurns',
    )),
    minIntervalMs: Number.isFinite(Number(config?.directorMinIntervalMs)) ? Number(config.directorMinIntervalMs) : 0,
    maxCallsPerHour: positive(config?.directorMaxCallsPerHour, DEFAULT_MAX_CALLS_PER_HOUR, 'directorMaxCallsPerHour'),
    maxFacts: Math.trunc(positive(config?.directorMaxFacts, DEFAULT_MAX_FACTS, 'directorMaxFacts')),
    maxTokens: Math.trunc(positive(config?.directorMaxTokens, DEFAULT_MAX_TOKENS, 'directorMaxTokens')),
  }
}

/** The text of one message's first text block, or an empty string. */
export function extractText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Pick the facts worth showing this turn.
 *
 * Dumping every remembered line into each request spends the director's small
 * budget on things that cannot matter right now. A fact earns its place by
 * sharing content with the recent conversation; when nothing matches, the newest
 * few stay as background so she is not amnesiac, and the rest wait on disk.
 *
 * @param facts - Remembered `{ text, at, sessionId?, round? }` entries.
 * @param digest - Recent `{ role, text }` pairs.
 * @param options - `limit` caps how many facts travel (default 8).
 * @returns The selected facts, most relevant first.
 */
export function selectRelevantFacts(facts, digest, { limit = 8 } = {}) {
  const list = Array.isArray(facts) ? facts.filter(fact => fact !== null && typeof fact?.text === 'string') : []
  if (list.length === 0) return []
  const cap = Math.max(1, Math.trunc(Number(limit) || 8))
  const haystack = normalizeForSearch((Array.isArray(digest) ? digest : []).map(entry => entry.text).join('\n'))
  const scored = list.map((fact, index) => {
    const needle = normalizeForSearch(fact.text)
    let score = 0
    if (needle !== '' && haystack !== '') {
      // Longest shared run wins, so a name or a place counts for more than a
      // stray character that happens to appear in both.
      for (let size = Math.min(6, needle.length); size >= 2; size -= 1) {
        let hit = false
        for (let start = 0; start + size <= needle.length; start += 1) {
          if (haystack.includes(needle.slice(start, start + size))) {
            hit = true
            break
          }
        }
        if (hit) {
          score = size
          break
        }
      }
    }
    return { fact, score, index }
  })
  const matched = scored.filter(entry => entry.score > 0)
  const chosen = matched.length > 0
    ? matched.sort((left, right) => right.score - left.score || right.index - left.index)
    : scored.slice().sort((left, right) => Number(right.fact.at ?? 0) - Number(left.fact.at ?? 0)).slice(0, Math.min(cap, 3)).map(entry => ({ ...entry, score: 0 }))
  return chosen.slice(0, cap).map(entry => entry.fact)
}

/** Text with punctuation, spacing and case folded away, for the scorer above. */
function normalizeForSearch(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\u3000,，.。!！?？;；:：、"'“”‘’()（）[\]【】「」『』<>《》~～\-—_…·/\\|]+/gu, '')
}

/**
 * The prompt the director answers.
 *
 * @param options - Prototype library, long-term memory and the recent digest; in the
 *   persona mode it also carries the character card and the live world-book entries,
 *   because the line it writes has to sound like her. `stageKind` decides how the
 *   animatable ids are described: bone channels in degrees on a 3D model, model
 *   parameters (0 is the rest position) on a Live2D one.
 * @returns System and user text for one model call.
 */
export function buildDirectorPrompt({
  library,
  memory,
  digest,
  expressions = [],
  motions = [],
  channels = [],
  switches = [],
  stageKind = 'live2d',
  persona = '',
  worldbook = '',
  lineLanguage = '',
  defaultRate = 0.97,
}) {
  const prototypeList = library.prototypes.map(item => `${item.id}(${item.label})`).join(' ')
  // Relevance × importance picks the facts; archived material arrives as summaries.
  const picked = selectFacts(memory?.facts, digest, { summaries: memory?.summaries })
  const lines = picked.facts.map(fact => `- ${fact.text}`)
  for (const summary of picked.summaries) lines.push(`- （更早的，摘要）${summary}`)
  const facts = lines.length > 0 ? lines.join('\n') : '（还没有）'
  const conversation = digest.length === 0
    ? '（空）'
    : digest.map((entry) => {
      if (entry.role === 'draft') {
        return `${entry.kind === 'output' ? '（她即将说出口）' : '（她心里正在想）'}${entry.text}`
      }
      // A player action on the model: a tap or a drag.
      if (entry.role === 'action') return `（动作）${entry.text}`
      // A backlog line: committed while the judge was not looking.
      if (entry.role === 'since') {
        return `（这一段里）${entry.from === 'user' ? '玩家' : '角色'}：${entry.text}`
      }
      return `${entry.role === 'user' ? '玩家' : '角色'}：${entry.text}`
    }).join('\n')
  const system = [
    '你在扮演屏幕上的 Live2D 角色。玩家看不见这段文字，只会看见她的表情和一句台词。',
    // The persona block is what makes 带人设模式 different: without it the judge
    // writes a line for a nameless puppet, with it the line is hers.
    ...(persona === '' ? [] : ['', '角色的设定（人物卡）：', persona]),
    ...(worldbook === '' ? [] : ['', '这次对话正在生效的世界书条目：', worldbook]),
    '读下面最近的一小段对话，判断角色此刻最真实的情绪；如果玩家透露了值得长期记住的事，就记下来。',
    '只输出一个 JSON 对象，不要解释，不要代码块围栏：',
    '{"emotion":"原型id","expression":"表情名或空串","motion":{"group":"动作组","index":0},"animation":"参数关键帧或空串","valence":-1到1,"arousal":-1到1,"line":"一句台词，不超过40字，可以是空串","speech":{"rate":1.0,"pitch":1.0,"tone":"这句台词该怎么念，例如：轻快、带笑意的语气"},"remember":{"text":"值得长期记住的新事实","kind":"identity|preference|event|promise|note","importance":1到5},"affinity":-1到1,"persist":{"params":{"参数id":值},"expression":"表情名","clear":false}}',
    `情绪原型：${prototypeList}`,
    '规则：line 用角色的口吻，不要复述对话，不要总结；没有新事实就省略 remember；不要编造玩家没说过的事；拿不准就用 neutral。',
    ...(lineLanguage === ''
      ? []
      : [`台词语言：line 必须用${lineLanguage}写——先把你想说的话翻译成${lineLanguage}再填进 line，不要中英混排；气泡里显示的就是这句话。speech.tone 仍可用中文描述语气。`]),
    `speech 是给语音合成用的：tone 一句话说明这句怎么念（快慢、情绪、气声），rate/pitch 取 0.5–2，1 是正常值；除非专门拖长音，rate 不要低于兜底语速 ${defaultRate}；line 为空时省略 speech。`,
    'remember.kind 用来决定保留策略：身份/承诺最重要，偏好其次，事件与闲聊最低；importance 1-5 自己判断。',
    ...(expressions.length === 0 ? [] : [`可用的表情名：${expressions.join(' ')}——只能从这里选，不确定就留空串。`]),
    ...(motions.length === 0
      ? []
      : [`可用的动作组：${motions.map(item => `${item.group}(${item.count})`).join(' ')}——只在真的要做动作时给，index 从 0 开始。`]),
    ...(channels.length === 0
      ? []
      : stageKind === 'vrm'
        ? [
          `可用的动作通道（单位：度）：${channels.join(' ')}——要给具体动作时写 animation，例如 "BoneHeadX=12@160; BoneHeadX=0@200"（点头）、"BoneHeadZ=10@220; BoneHeadZ=0@260"（歪头）。`,
          'animation 是可选的：只是说话、表情变化时留空串。同一通道写两次会接着走；用 += / -= 表示相对当前姿势的偏移。',
        ]
        : [
          `可用的参数 id（Live2D 参数，0 是静止位）：${channels.join(' ')}——要给具体动作时写 animation，例如 "ParamAngleY=8@140; ParamAngleY=0@180"（点头）、"ParamAngleZ=10@220; ParamAngleZ=0@260"（歪头）。`,
          'animation 是可选的：只是说话、表情变化时留空串。同一参数写两次会接着走；用 += / -= 表示相对当前姿势的偏移。',
        ]),
    ...(switches.length === 0
      ? []
      : [`可长期保持的开关参数：${switches.join(' ')}——用 persist.params 写 0/1 决定开关，例如 {"key11":1} 戴黑框眼镜、{"Clothes1":0} 换短裙、{"Clothes4":1} 换鞋；persist.expression 可以长期保持一张表情（上面的表情名）。`]),
    'persist 只在对话里真的需要「一直保持」时才给（她决定一直戴着、一直穿着）；一次性表情/动作不要写进 persist。要全部摘掉时给 {"clear":true}。',
  ].join('\n')
  const user = [
    `长期印象（affinity）：${typeof memory?.affinity === 'number' ? memory.affinity.toFixed(2) : '0.00'}`,
    '已知事实：',
    facts,
    '最近对话：',
    conversation,
  ].join('\n')
  return { system, user }
}

/**
 * Parse the director's reply, tolerating fences and surrounding prose.
 *
 * @param text - Raw model output.
 * @returns The parsed object, or undefined when no JSON object is present.
 */
export function parseDirectorReply(text) {
  if (typeof text !== 'string') return undefined
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed
}

/**
 * Fold one reply into the long-term memory.
 *
 * @param memory - Current memory.
 * @param reply - Parsed director reply.
 * @param options - Fact cap from config.
 * @returns The next memory plus whether it differs from the input.
 */
export function mergeDirectorMemory(memory, reply, { maxFacts = DEFAULT_MAX_FACTS, source } = {}) {
  // A reply may name the kind and importance of what it remembers.
  const remember = typeof reply?.remember === 'string'
    ? { text: reply.remember }
    : (reply?.remember !== null && typeof reply?.remember === 'object' ? reply.remember : undefined)
  const written = addFact(memory, {
    ...(remember ?? {}),
    ...(reply?.rememberKind === undefined ? {} : { kind: reply.rememberKind }),
    ...(reply?.rememberImportance === undefined ? {} : { importance: reply.rememberImportance }),
  }, { source, maxFacts })
  const facts = written.memory.facts
  const added = written.changed
  let affinity = typeof memory?.affinity === 'number' ? memory.affinity : 0
  let affinityChanged = false
  const asked = Number(reply?.affinity)
  if (Number.isFinite(asked)) {
    // Follow the director but damp it, so one odd turn cannot flip the mood.
    const next = Math.min(1, Math.max(-1, affinity * 0.7 + asked * 0.3))
    if (Math.abs(next - affinity) > 0.001) affinityChanged = true
    affinity = next
  }
  const changed = added || affinityChanged
  return {
    changed,
    action: written.action,
    memory: changed
      ? { ...written.memory, affinity, updatedAt: Date.now() }
      : { ...written.memory, affinity, updatedAt: memory?.updatedAt ?? 0 },
  }
}

/** Keep only the tail of a session digest, truncated per message. */
export function pushDigest(list, role, text, { limit = MAX_DIGEST_MESSAGES, maxLength = 600 } = {}) {
  const next = list.slice()
  const trimmed = text.trim()
  if (trimmed === '') return next
  next.push({ role, text: trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed })
  while (next.length > limit) next.shift()
  return next
}
