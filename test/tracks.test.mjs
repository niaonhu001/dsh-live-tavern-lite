/** Pure tests for the track parser and interpolator. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseTracks, startTracks, stepTracks } from '../lib/tracks.mjs'

test('a track line parses parameter, value and duration', () => {
  const entries = parseTracks('ParamAngleX=18@600; ParamEyeLOpen=0@900')
  assert.deepEqual(entries.map(entry => [entry.id, entry.value, entry.ms]), [
    ['ParamAngleX', 18, 600],
    ['ParamEyeLOpen', 0, 900],
  ])
  assert.equal(entries[0].ease, 'smooth')
})

test('the same parameter twice runs as consecutive segments', () => {
  // ParamYL2=1@120; ParamYL2=0@260 used to start together and cancel out.
  const channels = startTracks(parseTracks('ParamYL2=1@120; ParamYL2=0@260'), () => 0, 1_000)
  assert.equal(channels.length, 1, 'one channel per parameter')
  assert.deepEqual(channels[0].segments.map(seg => [seg.from, seg.to, seg.start, seg.end]), [
    [0, 1, 1_000, 1_120],
    [1, 0, 1_120, 1_380],
  ])
  const peak = stepTracks(channels, 1_120).values.get('ParamYL2').value
  assert.equal(peak, 1, 'reaches the first target before coming back')
  assert.equal(stepTracks(channels, 1_250).values.get('ParamYL2').value < 1, true)
  const landed = stepTracks(channels, 1_380)
  assert.equal(landed.values.get('ParamYL2').value, 0)
  assert.equal(landed.active, false)
})

test('an offset channel leaves the parameter underneath alone', () => {
  const entries = parseTracks('ParamYL2+=0.1@200; ParamYL2+=0@200')
  assert.deepEqual(entries.map(entry => [entry.mode, entry.value]), [['add', 0.1], ['add', 0]])
  // The base of an additive channel is a zero offset, never the live value.
  const channels = startTracks(entries, () => 0.6, 0)
  assert.equal(channels[0].base, 0)
  assert.equal(stepTracks(channels, 100).values.get('ParamYL2').value > 0, true)
  assert.equal(stepTracks(channels, 400).values.get('ParamYL2').value, 0)
})

test('-= moves the other way', () => {
  const entries = parseTracks('ParamAngleZ-=4@300')
  assert.equal(entries[0].mode, 'add')
  assert.equal(entries[0].value, -4)
})

test('the separators a reply might use all parse', () => {
  // The dash form the user asked for, the colon form, and plain spaces.
  assert.equal(parseTracks('ParamAngleX=18@600-ParamAngleY=-4@600').length, 2)
  assert.equal(parseTracks('ParamAngleX:18:600').length, 1)
  assert.equal(parseTracks('ParamAngleX 18 600').length, 1)
  assert.equal(parseTracks('ParamAngleX=18@600~linear')[0].ease, 'linear')
})

test('prose and out-of-range durations do not become tracks', () => {
  assert.deepEqual(parseTracks('她歪了歪头，没有说话。'), [])
  assert.deepEqual(parseTracks(''), [])
  assert.deepEqual(parseTracks('ParamAngleX=18@5'), [], 'too short to be an animation')
  assert.deepEqual(parseTracks('ParamAngleX=18@999999'), [], 'too long to be an animation')
})

test('a track interpolates from the current value and lands', () => {
  const read = (id) => (id === 'ParamAngleX' ? 2 : 0)
  const tracks = startTracks(parseTracks('ParamAngleX=10@100'), read, 1_000)
  const mid = stepTracks(tracks, 1_050)
  assert.ok(mid.active)
  const value = mid.values.get('ParamAngleX').value
  assert.ok(value > 2 && value < 10, `mid value ${value} sits between the endpoints`)
  const end = stepTracks(tracks, 1_100)
  assert.equal(end.active, false)
  assert.equal(end.values.get('ParamAngleX').value, 10)
})

test('easing changes the path but not the endpoints', () => {
  const linear = startTracks(parseTracks('ParamAngleX=10@100~linear'), () => 0, 0)
  const gentle = startTracks(parseTracks('ParamAngleX=10@100~smooth'), () => 0, 0)
  assert.equal(stepTracks(linear, 50).values.get('ParamAngleX').value, 5)
  // Smoothstep eases in and out, so it lags the straight line early on.
  assert.ok(stepTracks(gentle, 25).values.get('ParamAngleX').value < 2.5, 'smooth starts slower than linear')
  assert.equal(stepTracks(gentle, 100).values.get('ParamAngleX').value, 10)
})
