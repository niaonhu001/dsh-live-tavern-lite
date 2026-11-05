/**
 * Transcript recall: the authoritative record, searched on demand.
 *
 * The director's `facts` are an index — short sentences written by a model. The
 * transcript is the source of truth behind them, so a fact can always be checked
 * against what was actually said. Search is a deterministic local scan, which
 * follows re-generations and edits for free: there is no index to rebuild.
 *
 * @module dsh-live-tavern-lite/recall
 */

/** Punctuation and spacing that would otherwise split a phrase apart. */
const NOISE = /[\s\u3000,，.。!！?？;；:：、"'“”‘’()（）[\]【】「」『』<>《》~～\-—_…·/\\|]+/gu

/**
 * Normalize text for matching: case-folded, punctuation and spacing removed.
 * @param text - Raw text.
 * @returns The comparable form.
 */
export function normalizeForSearch(text) {
  return String(text ?? '').toLowerCase().replace(NOISE, '')
}

/**
 * Group a flat list of entries into rounds.
 *
 * A round starts at a user entry; assistant text that follows joins it. Entries
 * before the first user line (a greeting, for instance) form round zero. A line she
 * spoke in the bubble is assistant speech too, and is marked as such so a reader can
 * tell what was written from what was performed.
 *
 * @param entries - `{ role, text, kind, at }` in transcript order.
 * @returns Rounds as `{ round, user, assistant, at }`.
 */
export function buildRounds(entries) {
  const rounds = []
  let current
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const text = typeof entry.text === 'string' ? entry.text : ''
    if (text === '') continue
    const role = entry.role === 'user' ? 'user' : 'assistant'
    if (role === 'user' || current === undefined) {
      current = { round: rounds.length + 1, user: '', assistant: '', at: Number(entry.at) || 0 }
      rounds.push(current)
    }
    const spoken = entry.kind === 'line' ? `〔气泡〕${text}` : text
    if (role === 'user') current.user = current.user === '' ? text : `${current.user}\n${text}`
    else current.assistant = current.assistant === '' ? spoken : `${current.assistant}\n${spoken}`
  }
  return rounds
}

/** A short excerpt around the first match, for the hit directory. */
function snippetOf(text, needle, width = 60) {
  const folded = String(text ?? '').toLowerCase()
  const at = needle === '' ? 0 : folded.indexOf(needle)
  const start = at <= 0 ? 0 : Math.max(0, at - Math.floor(width / 3))
  const slice = text.slice(start, start + width)
  return `${start > 0 ? '…' : ''}${slice}${start + width < text.length ? '…' : ''}`
}

/**
 * Search committed rounds for a phrase.
 *
 * Ranking is deliberately dull: an exact phrase hit in the user's line beats one
 * in the reply, then whole-query coverage, then the newer round. A model reading
 * the hit list decides what to read in full.
 *
 * @param rounds - Output of {@link buildRounds}.
 * @param query - What to look for; normalized before matching.
 * @param options - `limit` caps the directory length (default 5).
 * @returns `{ found, hits: [{ round, where, snippet }] }`.
 */
export function searchRounds(rounds, query, { limit = 5 } = {}) {
  const needle = normalizeForSearch(query)
  const hits = []
  if (needle === '') return { found: false, hits }
  for (const round of rounds) {
    const userNorm = normalizeForSearch(round.user)
    const assistantNorm = normalizeForSearch(round.assistant)
    const inUser = userNorm.includes(needle)
    const inAssistant = assistantNorm.includes(needle)
    if (!inUser && !inAssistant) continue
    hits.push({
      round: round.round,
      where: inUser ? 'user' : 'assistant',
      snippet: snippetOf(inUser ? round.user : round.assistant, String(query).toLowerCase()),
      rank: inUser ? 0 : 1,
    })
  }
  hits.sort((left, right) => left.rank - right.rank || right.round - left.round)
  const trimmed = hits.slice(0, Math.max(1, limit)).map(({ round, where, snippet }) => ({ round, where, snippet }))
  return { found: trimmed.length > 0, hits: trimmed }
}

/**
 * Read one round, optionally with its neighbours.
 *
 * @param rounds - Output of {@link buildRounds}.
 * @param round - Round number to read.
 * @param options - `radius` adds that many rounds on either side (default 0).
 * @returns The rounds found, oldest first; empty when the number is unknown.
 */
export function readRounds(rounds, round, { radius = 0 } = {}) {
  const target = Number(round)
  if (!Number.isFinite(target)) return []
  const span = Math.max(0, Math.min(3, Math.trunc(Number(radius) || 0)))
  return rounds
    .filter(entry => entry.round >= target - span && entry.round <= target + span)
    .sort((left, right) => left.round - right.round)
}

/**
 * How much transcript one character keeps, in UTF-8 bytes.
 *
 * Bytes rather than entry count: one long reply and forty short lines are not the
 * same amount of memory, and the file is what has to stay bounded.
 */
export const TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024

/** UTF-8 size of one entry, measured the way the file will store it. */
function entryBytes(entry) {
  try {
    return Buffer.byteLength(JSON.stringify(entry), 'utf8')
  } catch {
    return 0
  }
}

/**
 * Keep the transcript under a size budget without losing the recent story.
 *
 * Oldest entries go first, and the newest entry is always kept even when it alone
 * exceeds the budget — dropping what was just said would be worse than a large file.
 *
 * @param entries - Full transcript.
 * @param maxBytes - Budget in UTF-8 bytes (default 5 MB).
 * @returns The tail of the transcript.
 */
export function trimTranscript(entries, maxBytes = TRANSCRIPT_MAX_BYTES) {
  if (!Array.isArray(entries)) return []
  const budget = Number.isFinite(maxBytes) ? Math.max(1024, maxBytes) : TRANSCRIPT_MAX_BYTES
  let total = 0
  let start = entries.length
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const size = entryBytes(entries[index])
    if (start < entries.length && total + size > budget) break
    total += size
    start = index
  }
  return entries.slice(start)
}
