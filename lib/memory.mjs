/**
 * Layered memory: facts, their importance, consolidation, and summaries.
 *
 * The layers this module keeps straight:
 *
 * - **episodic** — the transcripts, untouched elsewhere; facts point back at them
 * - **semantic** — one-line facts with a kind, an importance and provenance
 * - **summary** — what consolidation archived when facts overflowed or merged
 *
 * A fact is `{ text, kind, importance, at, sessionId, round, reinforced, supersedes }`.
 * Writes merge near-duplicates instead of stacking them, a new fact for the same
 * kind supersedes an older conflicting one, and when a file overflows the oldest
 * material becomes a summary line rather than disappearing.
 *
 * @module dsh-live-tavern-lite/memory
 */

/** Fact kinds and the retention weight each gets. */
export const FACT_KINDS = {
  identity: 1.0,
  promise: 0.95,
  preference: 0.8,
  event: 0.7,
  summary: 0.6,
  note: 0.5,
}

/** Longest accepted fact sentence. */
export const MAX_FACT_LENGTH = 200

/** Longest accepted summary line. */
export const MAX_SUMMARY_LENGTH = 240

/** Facts per memory file unless the settings say otherwise. */
export const DEFAULT_MAX_FACTS = 24

/** Summary lines kept beside the facts. */
export const DEFAULT_MAX_SUMMARIES = 6

/** Shared-run length that means "the same thing said twice". */
const SIMILAR_RUN = 6

/** Normalize for matching: case folded, punctuation and spacing dropped. */
export function foldText(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\u3000,，.。!！?？;；:：、"'“”‘’()（）[\]【】「」『』<>《》~～\-—_…·/\\|]+/gu, '')
}

/** Longest run of text shared by both strings, capped at `max`. */
export function sharedRun(left, right, max = 8) {
  const a = foldText(left)
  const b = foldText(right)
  if (a === '' || b === '') return 0
  for (let size = Math.min(max, a.length, b.length); size >= 2; size -= 1) {
    for (let start = 0; start + size <= a.length; start += 1) {
      if (b.includes(a.slice(start, start + size))) return size
    }
  }
  return 0
}

/** Clamp one importance value to the 1..5 scale. */
function clampImportance(value, fallback = 3) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(5, Math.max(1, Math.round(number)))
}

/** A fact's kind, or `note` for anything unknown. */
function resolveKind(value) {
  return Object.hasOwn(FACT_KINDS, String(value)) ? String(value) : 'note'
}

/**
 * Build a normalized fact.
 *
 * @param raw - `{ text, kind, importance, sessionId, round, at }`.
 * @param options - `now` and the default kind/importance for a bare sentence.
 * @returns The fact, or undefined when the text is empty.
 */
export function makeFact(raw, { now = Date.now(), source } = {}) {
  const text = String(raw?.text ?? '').trim().slice(0, MAX_FACT_LENGTH)
  if (text === '') return undefined
  return {
    text,
    kind: resolveKind(raw?.kind),
    importance: clampImportance(raw?.importance),
    at: Number.isFinite(raw?.at) ? raw.at : now,
    ...(typeof (raw?.sessionId ?? source?.sessionId) === 'string'
      ? { sessionId: raw?.sessionId ?? source.sessionId }
      : {}),
    ...(Number.isFinite(raw?.round ?? source?.round) ? { round: raw?.round ?? source.round } : {}),
    ...(Number.isFinite(raw?.reinforced) && raw.reinforced > 1 ? { reinforced: raw.reinforced } : {}),
  }
}

/** Higher means "keep me": importance, kind weight and reinforcement together. */
export function factWeight(fact) {
  const kind = FACT_KINDS[fact?.kind] ?? FACT_KINDS.note
  const importance = clampImportance(fact?.importance)
  const reinforced = Math.max(1, Number(fact?.reinforced) || 1)
  return importance * kind * (1 + Math.min(1, (reinforced - 1) * 0.15))
}

/**
 * Add one fact to a memory, merging near-duplicates and replacing conflicts.
 *
 * Rules, in order:
 * 1. The same sentence, or a long shared run of the same kind, is a repeat: keep
 *    the newer wording, raise its importance, and note the reinforcement.
 * 2. A same-kind fact that shares a long run with a different meaning (one has a
 *    negation the other does not) is superseded: the new fact replaces it and
 *    records what it replaced.
 * 3. Otherwise the fact is appended.
 *
 * @param memory - Current memory document.
 * @param input - `{ text, kind, importance }`.
 * @param options - `source`, `now`, `maxFacts`.
 * @returns `{ memory, changed, action }` where action is `added`/`reinforced`/`replaced`/`skipped`.
 */
export function addFact(memory, input, { source, now = Date.now(), maxFacts = DEFAULT_MAX_FACTS } = {}) {
  const facts = Array.isArray(memory?.facts) ? memory.facts.map(fact => ({ ...fact })) : []
  const next = makeFact(input, { now, source })
  if (next === undefined) {
    return { memory: { ...baseOf(memory), facts }, changed: false, action: 'skipped' }
  }
  const exact = facts.find(fact => fact.text === next.text)
  if (exact !== undefined) {
    return { memory: { ...baseOf(memory), facts }, changed: false, action: 'skipped' }
  }
  const near = facts.find(fact => fact.kind === next.kind && sharedRun(fact.text, next.text) >= SIMILAR_RUN)
  if (near !== undefined) {
    const negated = /不|没|別|别|无|未/.test(near.text) !== /不|没|別|别|无|未/.test(next.text)
    if (negated) {
      const index = facts.indexOf(near)
      facts[index] = { ...next, supersedes: near.text }
      return {
        memory: { ...baseOf(memory), facts: clampFacts(facts, maxFacts), updatedAt: now },
        changed: true,
        action: 'replaced',
      }
    }
    const index = facts.indexOf(near)
    facts[index] = {
      ...near,
      text: next.text,
      importance: clampImportance(Math.max(near.importance ?? 3, next.importance ?? 3) + 1),
      reinforced: Math.max(1, Number(near.reinforced) || 1) + 1,
      at: now,
    }
    return {
      memory: { ...baseOf(memory), facts: clampFacts(facts, maxFacts), updatedAt: now },
      changed: true,
      action: 'reinforced',
    }
  }
  facts.push(next)
  return {
    memory: { ...baseOf(memory), facts: clampFacts(facts, maxFacts), updatedAt: now },
    changed: true,
    action: 'added',
  }
}

/** Memory fields that survive an edit. */
function baseOf(memory) {
  return {
    version: 2,
    affinity: typeof memory?.affinity === 'number' ? memory.affinity : 0,
    summaries: Array.isArray(memory?.summaries) ? memory.summaries.slice() : [],
    updatedAt: memory?.updatedAt ?? 0,
  }
}

/** Keep the strongest `maxFacts`, newest first on a tie. */
function clampFacts(facts, maxFacts) {
  if (facts.length <= maxFacts) return facts
  return facts
    .map((fact, index) => ({ fact, index }))
    .sort((left, right) => factWeight(right.fact) - factWeight(left.fact) || right.fact.at - left.fact.at)
    .slice(0, maxFacts)
    .sort((left, right) => left.index - right.index)
    .map(entry => entry.fact)
}

/**
 * Consolidate a memory: merge near-duplicates, then archive the weakest facts
 * into a summary line instead of dropping them.
 *
 * This is the "consolidation pass" the layered model expects: it runs after a
 * write, costs nothing but arithmetic, and keeps the episodic pointer on every
 * fact it archives.
 *
 * @param memory - Current memory document.
 * @param options - `maxFacts`, `maxSummaries`, `now`.
 * @returns `{ memory, changed, merged, archived }`.
 */
export function consolidate(memory, { maxFacts = DEFAULT_MAX_FACTS, maxSummaries = DEFAULT_MAX_SUMMARIES, now = Date.now() } = {}) {
  const base = baseOf(memory)
  let facts = (Array.isArray(memory?.facts) ? memory.facts : []).map(fact => ({ ...fact }))
  let merged = 0
  // Merge same-kind neighbours that say the same thing.
  for (let left = 0; left < facts.length; left += 1) {
    for (let right = facts.length - 1; right > left; right -= 1) {
      const a = facts[left]
      const b = facts[right]
      if (a.kind !== b.kind) continue
      if (sharedRun(a.text, b.text) < SIMILAR_RUN) continue
      const newer = b.at >= a.at ? b : a
      const older = newer === b ? a : b
      const mergedFact = {
        ...newer,
        importance: clampImportance(Math.max(a.importance ?? 3, b.importance ?? 3) + 1),
        reinforced: Math.max(1, Number(a.reinforced) || 1) + Math.max(1, Number(b.reinforced) || 1),
        at: newer.at,
        ...(older.supersedes === undefined ? {} : { supersedes: older.supersedes }),
      }
      facts[left] = mergedFact
      facts.splice(right, 1)
      merged += 1
    }
  }
  // Overflow becomes a summary line, not a deletion.
  const summaries = base.summaries.slice()
  let archived = 0
  if (facts.length > maxFacts) {
    const ranked = facts
      .map((fact, index) => ({ fact, index }))
      .sort((left, right) => factWeight(left.fact) - factWeight(right.fact) || left.fact.at - right.fact.at)
    const overflow = ranked.slice(0, facts.length - maxFacts)
    const keep = new Set(overflow.map(entry => entry.index))
    const archivedFacts = overflow.map(entry => entry.fact)
    facts = facts.filter((_fact, index) => !keep.has(index))
    archived = archivedFacts.length
    const line = archivedFacts
      .map(fact => fact.text)
      .join('；')
      .slice(0, MAX_SUMMARY_LENGTH)
    if (line !== '') {
      summaries.push({
        text: line,
        rounds: archivedFacts
          .map(fact => fact.round)
          .filter(round => Number.isFinite(round)),
        at: now,
      })
    }
  }
  const trimmedSummaries = summaries.length > maxSummaries
    ? summaries.slice(summaries.length - maxSummaries)
    : summaries
  const changed = merged > 0 || archived > 0 || trimmedSummaries.length !== base.summaries.length
  return { memory: { ...base, facts, summaries: trimmedSummaries, updatedAt: changed ? now : base.updatedAt }, changed, merged, archived }
}

/**
 * Merge several memory files into one view.
 *
 * Used by the cross-session `all` scope: facts stay deduplicated by text, the
 * strongest copy wins, and every session's summaries ride along so an archived
 * session still contributes its gist.
 *
 * @param memories - Memory documents to merge.
 * @param options - `maxFacts`, `maxSummaries`.
 * @returns A merged memory document.
 */
export function mergeMemories(memories, { maxFacts = DEFAULT_MAX_FACTS, maxSummaries = DEFAULT_MAX_SUMMARIES, now = Date.now() } = {}) {
  const byText = new Map()
  const summaries = []
  let affinityTotal = 0
  let affinityCount = 0
  for (const memory of memories) {
    if (memory === null || typeof memory !== 'object') continue
    for (const fact of Array.isArray(memory.facts) ? memory.facts : []) {
      if (typeof fact?.text !== 'string') continue
      const existing = byText.get(fact.text)
      if (existing === undefined || factWeight(fact) > factWeight(existing)) byText.set(fact.text, fact)
    }
    for (const summary of Array.isArray(memory.summaries) ? memory.summaries : []) {
      if (typeof summary?.text === 'string' && !summaries.some(item => item.text === summary.text)) summaries.push(summary)
    }
    if (typeof memory.affinity === 'number') {
      affinityTotal += memory.affinity
      affinityCount += 1
    }
  }
  const facts = [...byText.values()].sort((left, right) => left.at - right.at)
  return {
    version: 2,
    facts: clampFacts(facts, maxFacts),
    summaries: summaries.slice(-maxSummaries),
    affinity: affinityCount === 0 ? 0 : affinityTotal / affinityCount,
    updatedAt: now,
  }
}

/** Match needles against fact text: a needle is a substring, never a regex. */
function normalizeNeedles(needles) {
  return (Array.isArray(needles) ? needles : [needles])
    .map(value => String(value ?? '').trim())
    .filter(value => value !== '')
}

/**
 * Drop the facts whose text contains one of the given fragments.
 *
 * The judgement belongs to the model — this module only applies it, so a model can
 * retire a fact it has superseded instead of waiting for the retention pass.
 *
 * @param memory - Current memory document.
 * @param needles - Text fragments naming the facts to drop.
 * @returns `{ memory, removed }`.
 */
export function forgetFacts(memory, needles) {
  const list = normalizeNeedles(needles)
  const base = baseOf(memory)
  const facts = (Array.isArray(memory?.facts) ? memory.facts : [])
    .filter(fact => !list.some(needle => String(fact?.text ?? '').includes(needle)))
  const removed = (Array.isArray(memory?.facts) ? memory.facts.length : 0) - facts.length
  return {
    memory: { ...base, facts, updatedAt: removed > 0 ? Date.now() : base.updatedAt },
    removed,
  }
}

/**
 * Fold several facts into one, the way a model does when it distills a topic.
 *
 * Matching facts are dropped, then the merged sentence is added through the same
 * merge rules a fresh fact gets (duplicate detection included).
 *
 * @param memory - Current memory document.
 * @param needles - Text fragments naming the facts to fold in.
 * @param text - The distilled sentence.
 * @param options - `kind`, `importance`, `now`.
 * @returns `{ memory, changed, dropped, action }`.
 */
export function mergeFacts(memory, needles, text, { kind, importance, now = Date.now() } = {}) {
  const list = normalizeNeedles(needles)
  const current = Array.isArray(memory?.facts) ? memory.facts : []
  const kept = current.filter(fact => !list.some(needle => String(fact?.text ?? '').includes(needle)))
  const dropped = current.length - kept.length
  const base = { ...baseOf(memory), facts: kept }
  const added = addFact(base, { text, kind, importance }, { now })
  return {
    memory: added.memory,
    changed: dropped > 0 || added.changed,
    dropped,
    action: added.action,
  }
}

/**
 * Pick the facts worth showing this turn.
 *
 * Score = relevance (longest shared run with the digest) × importance weight, with
 * recency breaking ties. When nothing is relevant the strongest few still travel,
 * so she is never amnesiac; summaries are appended when they are relevant.
 *
 * @param facts - Candidate facts.
 * @param digest - Recent `{ role, text }` pairs.
 * @param options - `limit` caps how many facts travel (default 8), `summaries` and `limitSummaries`.
 * @returns The selected facts, most relevant first.
 */
export function selectFacts(facts, digest, { limit = 8, summaries = [], limitSummaries = 2 } = {}) {
  const list = (Array.isArray(facts) ? facts : []).filter(fact => typeof fact?.text === 'string')
  const haystack = foldText((Array.isArray(digest) ? digest : []).map(entry => entry.text ?? '').join('\n'))
  const cap = Math.max(1, Math.trunc(Number(limit) || 8))
  const scored = list.map((fact, index) => {
    const run = haystack === '' ? 0 : sharedRun(fact.text, haystack, 8)
    return { fact, index, run, score: run === 0 ? 0 : run * factWeight(fact) }
  })
  const relevant = scored.filter(entry => entry.score > 0)
  const chosen = relevant.length > 0
    ? relevant.sort((left, right) => right.score - left.score || right.fact.at - left.fact.at)
    : scored.sort((left, right) => factWeight(right.fact) - factWeight(left.fact) || right.fact.at - left.fact.at)
  const picked = chosen.slice(0, cap).map(entry => entry.fact)
  const summaryPool = (Array.isArray(summaries) ? summaries : [])
    .filter(summary => typeof summary?.text === 'string')
    .map(summary => ({ summary, run: sharedRun(summary.text, haystack, 8) }))
    .filter(entry => entry.run > 0)
    .sort((left, right) => right.run - left.run)
    .slice(0, Math.max(0, Math.trunc(limitSummaries)))
    .map(entry => entry.summary.text)
  return { facts: picked, summaries: summaryPool }
}
