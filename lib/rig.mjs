/**
 * Emotion vector → model parameters.
 *
 * The model only ever emits a vector (`valence` / `arousal` / `dominance` /
 * `intensity`); this module turns it into concrete parameter targets using the
 * reference table in `assets/emotion-rig.json`. Keeping the table as data means a
 * weight can be tuned without touching code, and the resolver stays a pure
 * function that tests can pin down.
 *
 * @module dsh-live-tavern-lite/rig
 */

import { readFileSync } from 'node:fs'

/** Parameter zones the table may declare. */
export const RIG_ZONES = ['face', 'pose']

/**
 * Validate a rig document and index it by parameter id.
 *
 * A malformed entry fails loud: a wrong axis name would otherwise silently
 * produce zeros and make the whole rig look broken at runtime.
 *
 * @param raw - Parsed `emotion-rig.json`.
 * @returns The validated rig with its parameters indexed by id.
 */
export function normalizeRig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('emotion-rig: expected a JSON object')
  }
  const params = Array.isArray(raw.params) ? raw.params : []
  if (params.length === 0) throw new Error('emotion-rig: no parameters declared')
  const byId = new Map()
  for (const entry of params) {
    if (typeof entry?.id !== 'string' || entry.id.trim() === '') {
      throw new Error('emotion-rig: every parameter needs an id')
    }
    // `zone` only labels which half of the body an entry belongs to; a generated
    // table that omits it is still usable, while a misspelt one stays an error.
    const zone = entry.zone === undefined || entry.zone === null || entry.zone === ''
      ? 'face'
      : entry.zone
    if (!RIG_ZONES.includes(zone)) {
      throw new Error(`emotion-rig: '${entry.id}' has unknown zone '${String(entry.zone)}'`)
    }
    if (!Number.isFinite(entry.base) || !Number.isFinite(entry.min) || !Number.isFinite(entry.max)) {
      throw new Error(`emotion-rig: '${entry.id}' needs finite base/min/max`)
    }
    if (entry.min > entry.max) throw new Error(`emotion-rig: '${entry.id}' has min above max`)
    // A parameter that must hold one value carries no weights at all: an emotion
    // can never move it, so a generated coefficient would be noise at best.
    // A zero-width range says the same thing, whatever the table claims.
    const fixed = entry.fixed === true || entry.min === entry.max
    let weights = { valence: 0, arousal: 0, dominance: 0 }
    if (!fixed) {
      const declared = entry.weights
      if (declared === null || typeof declared !== 'object') {
        throw new Error(`emotion-rig: '${entry.id}' has no weights`)
      }
      for (const axis of ['valence', 'arousal', 'dominance']) {
        if (!Number.isFinite(declared[axis])) {
          throw new Error(`emotion-rig: '${entry.id}' weight '${axis}' must be a finite number`)
        }
      }
      weights = { valence: declared.valence, arousal: declared.arousal, dominance: declared.dominance }
    }
    byId.set(entry.id, {
      id: entry.id,
      role: String(entry.role ?? entry.id),
      zone,
      confidence: ['verified', 'standard'].includes(entry.confidence) ? entry.confidence : 'guess',
      base: entry.base,
      min: entry.min,
      max: entry.max,
      fixed,
      weights,
      note: typeof entry.note === 'string' ? entry.note : '',
    })
  }
  return { version: Number(raw.version) || 1, params: [...byId.values()], byId }
}

/** Read and validate the packaged rig table. */
export function loadRig(file) {
  return normalizeRig(JSON.parse(readFileSync(file, 'utf8')))
}

/**
 * Resolve a vector into parameter targets.
 *
 * `value = clamp(base + intensity * (v*wV + a*wA + d*wD), min, max)`: the base is
 * the model's own resting value, and intensity scales only the deviation, so
 * intensity 0 always returns the resting face instead of a flat zero. A `fixed`
 * entry skips the formula and returns its own value unchanged.
 *
 * @param rig - Result of {@link normalizeRig}.
 * @param vector - `{ valence, arousal, dominance, intensity }`, each optional.
 * @returns Parameter id → target value, plus the ids that were clamped.
 */
export function resolveRig(rig, vector) {
  const valence = clampAxis(vector?.valence)
  const arousal = clampAxis(vector?.arousal)
  const dominance = clampAxis(vector?.dominance)
  const intensity = clampAxis(vector?.intensity, 1)
  const params = {}
  const clamped = []
  for (const entry of rig.params) {
    if (entry.fixed === true) {
      // Held: the table's value wins and no vector reaches it.
      const held = Math.min(entry.max, Math.max(entry.min, entry.base))
      if (held !== entry.base) clamped.push(entry.id)
      params[entry.id] = Math.round(held * 1000) / 1000
      continue
    }
    const delta = intensity * (
      valence * entry.weights.valence
      + arousal * entry.weights.arousal
      + dominance * entry.weights.dominance
    )
    const raw = entry.base + delta
    const value = Math.min(entry.max, Math.max(entry.min, raw))
    if (value !== raw) clamped.push(entry.id)
    params[entry.id] = Math.round(value * 1000) / 1000
  }
  return { params, clamped }
}

/** Keep one vector axis inside -1..1 (intensity inside 0..1). */
function clampAxis(value, fallback = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const low = fallback === 1 ? 0 : -1
  return Math.min(1, Math.max(low, number))
}
