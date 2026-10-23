/**
 * Character packs: a SillyTavern-shaped character card plus a world book.
 *
 * A pack is data, not code: `card.json` and `worldbook.json` sit in
 * `<packsRoot>/<id>/` and are read on every prompt assembly, so editing a pack
 * never needs a rebuild. Only the fields this plugin actually renders are kept;
 * everything else stays in the file untouched.
 *
 * Pure module: the caller owns files, agents and prompt registration.
 */


/** Default per-assembly budget for non-constant entries, in estimated tokens. */
const DEFAULT_BUDGET_TOKENS = 8_192
/** How many recent digest entries the scan looks at when the caller says nothing. */
const DEFAULT_SCAN_DEPTH = 8
const MAX_ENTRIES = 40

/** Text of a card field, accepting the V2 `data` wrapper or a flat object. */
function textOf(source, key) {
  const value = source?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Estimate the token cost of one piece of lore text.
 *
 * SillyTavern's own estimate is the yardstick the operator already knows: a CJK
 * character is about one token, other characters about a quarter. This is an
 * estimate, not a tokenizer, so it only ever decides which entries fit.
 *
 * @param text - Lore text or comment.
 * @returns Estimated tokens, never below one.
 */
export function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const character of String(text ?? '')) {
    const code = character.codePointAt(0) ?? 0
    const wide = (code >= 0x2e80 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef)
      || (code >= 0x20000 && code <= 0x2ffff)
    if (wide) cjk += 1
    else other += 1
  }
  return Math.max(1, Math.ceil(cjk + other / 4))
}

/**
 * Normalize a character card.
 *
 * @param raw - Parsed `card.json`, in `chara_card_v2` or flat form.
 * @param fallbackId - Pack id used when the card has no name.
 * @returns The fields the prompt renders.
 */
export function normalizeCard(raw, fallbackId = 'character') {
  const data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : raw ?? {}
  const name = textOf(data, 'name') || fallbackId
  const greetings = Array.isArray(data.alternate_greetings)
    ? data.alternate_greetings.filter(item => typeof item === 'string' && item.trim() !== '')
    : []
  return {
    name,
    description: textOf(data, 'description'),
    personality: textOf(data, 'personality'),
    scenario: textOf(data, 'scenario'),
    firstMes: textOf(data, 'first_mes'),
    mesExample: textOf(data, 'mes_example'),
    systemPrompt: textOf(data, 'system_prompt'),
    postHistory: textOf(data, 'post_history_instructions'),
    greetings,
    tags: Array.isArray(data.tags) ? data.tags.filter(tag => typeof tag === 'string') : [],
  }
}

/** Normalize one world-book entry from either the map or the array dialect. */
export function normalizeWorldBookEntry(raw, index) {
  if (raw === null || typeof raw !== 'object') return undefined
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  if (content === '') return undefined
  const keys = Array.isArray(raw.keys) ? raw.keys.filter(key => typeof key === 'string' && key.trim() !== '') : []
  const secondary = Array.isArray(raw.secondary_keys)
    ? raw.secondary_keys.filter(key => typeof key === 'string' && key.trim() !== '')
    : []
  return {
    id: typeof raw.uid === 'number' ? raw.uid : Number.isFinite(Number(raw.id)) ? Number(raw.id) : index,
    comment: typeof raw.comment === 'string' ? raw.comment : '',
    content,
    keys,
    secondary,
    selective: raw.selective === true,
    constant: raw.constant === true,
    disabled: raw.disable === true,
    order: Number.isFinite(Number(raw.insertion_order)) ? Number(raw.insertion_order) : 100,
    depth: Number.isFinite(Number(raw.depth)) ? Number(raw.depth) : 4,
    // Grouping (`group` + `groupOverride` + `groupWeight`) is how a world book
    // says "these entries are alternatives": SillyTavern ships the same three.
    group: typeof raw.group === 'string' ? raw.group.trim() : '',
    groupOverride: raw.groupOverride === true || raw.group_override === true,
    groupWeight: Number.isFinite(Number(raw.groupWeight))
      ? Number(raw.groupWeight)
      : Number.isFinite(Number(raw.group_weight)) ? Number(raw.group_weight) : 100,
  }
}

/**
 * Normalize a world book.
 *
 * @param raw - Parsed `worldbook.json`, with `entries` as an object or array.
 * @returns Normalized entries in declaration order.
 */
export function normalizeWorldBook(raw) {
  const entries = raw?.entries
  const list = Array.isArray(entries)
    ? entries
    : entries && typeof entries === 'object'
      ? Object.values(entries)
      : []
  const normalized = []
  list.forEach((entry, index) => {
    const value = normalizeWorldBookEntry(entry, index)
    if (value !== undefined) normalized.push(value)
  })
  return normalized
}

function matches(text, keys, caseSensitive) {
  const haystack = caseSensitive ? text : text.toLowerCase()
  return keys.some((key) => {
    const needle = caseSensitive ? key : key.toLowerCase()
    return needle !== '' && haystack.includes(needle)
  })
}

/**
 * The scan window: how many recent digest entries the keys are matched against.
 *
 * A whole-session digest was the earlier behaviour, and it made an old topic keep
 * triggering its entries forever — the budget then only ever admitted the same
 * few. SillyTavern solves this with `scan_depth`; this is the same idea.
 *
 * @param digest - Recent `{ role, text }` pairs for the session.
 * @param depth - How many trailing entries to look at; `0` scans everything.
 * @returns The tail of the digest that the scan may read.
 */
function scanWindow(digest, depth) {
  if (!Array.isArray(digest) || digest.length === 0) return []
  if (!Number.isFinite(depth) || depth <= 0 || depth >= digest.length) return digest
  return digest.slice(digest.length - depth)
}

/**
 * Pick the entries one assembly carries, and explain the decision.
 *
 * Constant entries always apply. The rest need a primary key inside the scan
 * window and, when `selective` with secondary keys, one of those too. Selection
 * then runs in `order`, spending a token budget: an entry that no longer fits is
 * skipped, never truncated. A group marked `groupOverride` contributes one entry
 * per assembly (highest `groupWeight`, then `order`). Entries that were selected
 * `cooldownAfter` assemblies in a row rest for `cooldownRounds` assemblies, so one
 * ever-present topic cannot crowd out the rest.
 *
 * @param entries - Normalized world book.
 * @param digest - Recent `{ role, text }` pairs for this session.
 * @param options - Budget, scan window, cooldown, case sensitivity and the
 *   per-session `state` the cooldown counters live in (`{ assemblies, entries }`).
 * @returns `{ entries, report }` — the chosen entries plus why each was dropped.
 */
export function planWorldBook(entries, digest, {
  budgetTokens = DEFAULT_BUDGET_TOKENS,
  scanDepth = DEFAULT_SCAN_DEPTH,
  cooldownAfter = 0,
  cooldownRounds = 0,
  caseSensitive = false,
  state,
} = {}) {
  const window = scanWindow(digest, scanDepth)
  const text = window.map(entry => entry.text).join('\n')
  const memory = state !== undefined && state !== null && state.entries instanceof Map ? state : undefined
  const assembly = memory === undefined ? 0 : (memory.assemblies = (Number(memory.assemblies) || 0) + 1)
  const report = {
    assembly,
    scannedMessages: window.length,
    digestMessages: Array.isArray(digest) ? digest.length : 0,
    budgetTokens,
    scanDepth,
    cooldownAfter,
    cooldownRounds,
    usedTokens: 0,
    matched: [],
    injected: [],
    droppedBudget: [],
    droppedCooldown: [],
    droppedGroup: [],
    droppedConstantBudget: [],
  }

  const matched = []
  for (const entry of entries) {
    if (entry.disabled) continue
    let live = entry.constant
    if (!live && entry.keys.length > 0) {
      live = matches(text, entry.keys, caseSensitive)
        && (!entry.selective || entry.secondary.length === 0 || matches(text, entry.secondary, caseSensitive))
    }
    if (live) matched.push(entry)
  }
  matched.sort((left, right) => left.order - right.order || left.id - right.id)
  report.matched = matched.map(entry => ({ id: entry.id, comment: entry.comment, constant: entry.constant }))

  // Cooldown: an entry rests after it was selected `cooldownAfter` assemblies in
  // a row, for `cooldownRounds` assemblies. Constant entries never rest.
  const resting = (entry) => {
    if (memory === undefined || cooldownAfter <= 0 || cooldownRounds <= 0 || entry.constant) return false
    const slot = memory.entries.get(entry.id)
    return slot !== undefined && assembly <= slot.until
  }
  const available = []
  for (const entry of matched) {
    if (resting(entry)) report.droppedCooldown.push({ id: entry.id, comment: entry.comment })
    else available.push(entry)
  }

  // Group override: within one group only the heaviest entry competes.
  const groupWinner = new Map()
  const screened = []
  for (const entry of available) {
    if (entry.group === '' || entry.groupOverride !== true) {
      screened.push(entry)
      continue
    }
    const current = groupWinner.get(entry.group)
    const weight = Number.isFinite(entry.groupWeight) ? entry.groupWeight : 100
    if (current === undefined
      || weight > current.weight
      || (weight === current.weight && entry.order < current.entry.order)) {
      groupWinner.set(entry.group, { entry, weight })
    }
  }
  for (const [group, winner] of groupWinner) {
    screened.push(winner.entry)
    for (const entry of available) {
      if (entry !== winner.entry && entry.group === group && entry.groupOverride === true) {
        report.droppedGroup.push({ id: entry.id, comment: entry.comment, group })
      }
    }
  }
  screened.sort((left, right) => left.order - right.order || left.id - right.id)

  const selected = []
  let used = 0
  for (const entry of screened) {
    if (selected.length >= MAX_ENTRIES) break
    const cost = estimateTokens(entry.content) + (entry.comment === '' ? 0 : estimateTokens(entry.comment))
    if (used + cost > budgetTokens) {
      const bucket = entry.constant ? report.droppedConstantBudget : report.droppedBudget
      bucket.push({ id: entry.id, comment: entry.comment, tokens: cost })
      continue
    }
    used += cost
    selected.push(entry)
    report.injected.push({ id: entry.id, comment: entry.comment, tokens: cost, constant: entry.constant })
  }
  report.usedTokens = used

  if (memory !== undefined) {
    for (const entry of matched) {
      const chosen = selected.includes(entry)
      const slot = memory.entries.get(entry.id) ?? { hits: 0, until: 0 }
      if (chosen) {
        slot.hits += 1
        if (cooldownAfter > 0 && cooldownRounds > 0 && slot.hits >= cooldownAfter && !entry.constant) {
          slot.until = assembly + cooldownRounds
          slot.hits = 0
        }
      } else {
        slot.hits = 0
      }
      memory.entries.set(entry.id, slot)
    }
  }
  return { entries: selected, report }
}

/** Select the entries one assembly should carry, without cooldown tracking. */
export function activateWorldBook(entries, digest, options = {}) {
  return planWorldBook(entries, digest, options).entries
}

/**
 * Substitute SillyTavern macros in card and lore text.
 *
 * The system-prompt renderer treats `{{variable}}` as its own template syntax and
 * rejects unknown names, which would fail the whole assembly — so card text must
 * never reach it with braces intact.
 *
 * @param text - Raw card or lore text.
 * @param names - Character and player display names.
 * @returns Text with every known macro replaced.
 */
export function applyMacros(text, { charName = '', userName = '玩家' } = {}) {
  return String(text)
    .replaceAll('{{char}}', charName)
    .replaceAll('{{user}}', userName)
    .replaceAll('{{persona}}', userName)
    .replaceAll('<BOT>', charName)
    .replaceAll('<USER>', userName)
}

/** The system-prompt text one character card contributes. */
export function renderCardSection(card, names = {}) {
  const charName = names.charName ?? card.name
  const macro = text => applyMacros(text, { charName, userName: names.userName })
  const lines = [`## 角色：${charName}`]
  if (card.systemPrompt !== '') lines.push(macro(card.systemPrompt))
  if (card.description !== '') lines.push(`### 设定\n${macro(card.description)}`)
  if (card.personality !== '') lines.push(`### 性格\n${macro(card.personality)}`)
  if (card.scenario !== '') lines.push(`### 场景\n${macro(card.scenario)}`)
  if (card.mesExample !== '') lines.push(`### 说话示例\n${macro(card.mesExample)}`)
  if (card.postHistory !== '') lines.push(macro(card.postHistory))
  lines.push('用这个角色的口吻回答，不要跳出角色，不要描述自己正在扮演。')
  return lines.join('\n\n')
}

/** The system-prompt text the activated world-book entries contribute. */
export function renderWorldBookSection(entries, names = {}) {
  if (entries.length === 0) return ''
  const body = entries
    .map(entry => {
      const content = applyMacros(entry.content, names)
      return entry.comment === '' ? content : `- ${applyMacros(entry.comment, names)}\n${content}`
    })
    .join('\n\n')
  return `## 本回合已知设定\n\n${body}`
}
