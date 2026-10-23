/**
 * The emotion-rig resolver, pinned down.
 *
 * These tests cover the contract the model relies on: a vector alone produces
 * parameter targets, intensity scales only the deviation from the resting face,
 * and clamping keeps every value inside the range the table declares.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { loadRig, resolveRig, normalizeRig } = await import('../lib/rig.mjs')

const RIG = loadRig(join(fileURLToPath(new URL('..', import.meta.url)), 'assets', 'emotion-rig.json'))

test('the packaged rig only carries parameters proven to move the model', () => {
  // Every entry was dragged by hand in the parameter probe before it earned a
  // place here; a parameter wired to nothing would render the whole table a lie.
  assert.equal(RIG.params.length, 11)
  const ids = RIG.params.map(entry => entry.id)
  for (const id of ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm', 'ParamMouthOpenY', 'ParamAngleY', 'ParamBreath']) {
    assert.ok(ids.includes(id), `rig is missing ${id}`)
  }
  assert.equal(RIG.params.filter(entry => entry.zone === 'face').length, 7)
  assert.equal(RIG.params.filter(entry => entry.zone === 'pose').length, 4)
  for (const entry of RIG.params) assert.equal(entry.confidence, 'verified', entry.id)
  // The parameters the probe found dead must not linger in the table.
  for (const dead of ['ParamEyeLSmile', 'ParamBrowLY', 'ParamBodyAngleXinput', 'ParambodyXY2']) {
    assert.equal(ids.includes(dead), false, `${dead} has no visible effect`)
  }
})

test('a neutral vector returns the resting face', () => {
  const { params } = resolveRig(RIG, { valence: 0, arousal: 0, dominance: 0, intensity: 1 })
  for (const entry of RIG.params) assert.equal(params[entry.id], entry.base, entry.id)
})

test('intensity zero also returns the resting face', () => {
  const { params } = resolveRig(RIG, { valence: 1, arousal: 1, dominance: 1, intensity: 0 })
  for (const entry of RIG.params) assert.equal(params[entry.id], entry.base, entry.id)
})

test('happiness reads through the mouth, and energy through the eyes', () => {
  // This model has no eye-smile parameter, so the mouth carries joy while the
  // eyelids carry energy: a calm happy face keeps its eyes open instead of
  // faking a squint the art cannot show.
  const happy = resolveRig(RIG, { valence: 1, arousal: 0.2, dominance: 0, intensity: 0.8 }).params
  assert.ok(happy.ParamMouthForm > 0.6, `mouth ${happy.ParamMouthForm}`)
  assert.ok(happy.ParamAngleZ > 0, `head tilt ${happy.ParamAngleZ}`)
  const tired = resolveRig(RIG, { valence: -0.05, arousal: -0.95, dominance: -0.3, intensity: 1 }).params
  assert.ok(tired.ParamEyeLOpen < 0.7, `eye open ${tired.ParamEyeLOpen}`)
  assert.ok(tired.ParamMouthForm < 0, `mouth ${tired.ParamMouthForm}`)
})

test('a low-arousal vector droops the eyelids', () => {
  const { params } = resolveRig(RIG, { valence: 0.1, arousal: -0.85, dominance: -0.2, intensity: 1 })
  assert.ok(params.ParamEyeLOpen < 0.8, `eye open ${params.ParamEyeLOpen}`)
})

test('values never leave the declared range', () => {
  for (const vector of [
    { valence: 1, arousal: 1, dominance: 1, intensity: 1 },
    { valence: -1, arousal: -1, dominance: -1, intensity: 1 },
  ]) {
    const { params } = resolveRig(RIG, vector)
    for (const entry of RIG.params) {
      assert.ok(params[entry.id] >= entry.min, `${entry.id} below min`)
      assert.ok(params[entry.id] <= entry.max, `${entry.id} above max`)
    }
  }
})

test('missing axes fall back to zero, and unknown axes are rejected by validation', () => {
  const { params } = resolveRig(RIG, {})
  for (const entry of RIG.params) assert.equal(params[entry.id], entry.base, entry.id)

  assert.throws(() => normalizeRig({
    params: [{ id: 'X', zone: 'face', base: 0, min: -1, max: 1, weights: { valence: 0, arousal: 0 } }],
  }), /weight 'dominance'/)
  assert.throws(() => normalizeRig({
    params: [{ id: 'X', zone: 'elbow', base: 0, min: -1, max: 1, weights: { valence: 0, arousal: 0, dominance: 0 } }],
  }), /unknown zone/)
})

test('every prototype lands on its own face', () => {
  // Two prototypes resolving to the same parameters means the character cannot
  // show the difference at all, which is worse than a wrong weight: nothing in
  // the logs would ever reveal it. Distances are normalised per parameter range.
  const library = JSON.parse(readFileSync(new URL('../assets/emotions.json', import.meta.url), 'utf8'))
  const faces = library.prototypes.map(prototype => ({
    id: prototype.id,
    params: resolveRig(RIG, prototype).params,
  }))
  const normalise = face => RIG.params.map(entry =>
    (face.params[entry.id] - entry.min) / (entry.max - entry.min))
  const vectors = faces.map(face => ({ id: face.id, values: normalise(face) }))
  let closest = { pair: '', distance: Infinity }
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const distance = Math.hypot(...vectors[i].values.map((value, k) => value - vectors[j].values[k]))
      if (distance < closest.distance) {
        closest = { pair: `${vectors[i].id} × ${vectors[j].id}`, distance }
      }
    }
  }
  assert.ok(closest.distance >= 0.1, `too close: ${closest.pair} at ${closest.distance.toFixed(3)}`)
})

test('a generated table may omit the zone, but not misspell it', () => {
  const base = {
    id: 'ParamMouthForm',
    base: 0,
    min: -1,
    max: 1,
    confidence: 'verified',
    weights: { valence: 0.9, arousal: 0.1, dominance: 0.12 },
  }
  // Omitted: face is the default, because zone only labels the entry.
  const withoutZone = normalizeRig({ version: 2, params: [base] })
  assert.equal(withoutZone.params[0].zone, 'face')
  // Explicit and wrong: still an error, so a typo cannot slip through.
  assert.throws(
    () => normalizeRig({ version: 2, params: [{ ...base, zone: 'facce' }] }),
    /unknown zone/,
  )
  assert.equal(normalizeRig({ version: 2, params: [{ ...base, zone: 'pose' }] }).params[0].zone, 'pose')
})

test('a fixed parameter carries no weights and never moves', () => {
  const rig = normalizeRig({
    version: 2,
    params: [
      { id: 'ParamHeadSwitch', base: 30, min: 0, max: 30, fixed: true, zone: 'pose' },
      { id: 'ParamAngleX', base: 0, min: -30, max: 30, zone: 'face', weights: { valence: 10, arousal: 0, dominance: 0 } },
    ],
  })
  const fixed = rig.byId.get('ParamHeadSwitch')
  assert.equal(fixed.fixed, true)
  assert.deepEqual(fixed.weights, { valence: 0, arousal: 0, dominance: 0 })

  // No vector reaches it, whatever the intensity.
  for (const vector of [{ valence: 1, arousal: 1, dominance: 1, intensity: 1 }, { valence: -1, intensity: 1 }, {}]) {
    assert.equal(resolveRig(rig, vector).params.ParamHeadSwitch, 30)
  }
  assert.equal(resolveRig(rig, { valence: 1, intensity: 1 }).params.ParamAngleX, 10)
})

test('a zero-width range is fixed even without the flag', () => {
  const rig = normalizeRig({
    version: 2,
    params: [{ id: 'ParamSwitch', base: 1, min: 1, max: 1, zone: 'face' }],
  })
  assert.equal(rig.byId.get('ParamSwitch').fixed, true)
  assert.equal(resolveRig(rig, { valence: -1, intensity: 1 }).params.ParamSwitch, 1)
})

test('weighted entries still require their weights', () => {
  assert.throws(() => normalizeRig({
    version: 2,
    params: [{ id: 'ParamAngleX', base: 0, min: -30, max: 30, zone: 'face' }],
  }), /has no weights/)
})
