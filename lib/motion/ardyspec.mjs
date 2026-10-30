/**
 * ARDY motion spec to VRM Animation 1.0.
 *
 * The ARDY engine (`tools/ardy-engine/server.py` from text-to-vrma) answers with
 * a spec, not a clip:
 *
 *     {
 *       name, duration,
 *       tracks: { leftUpperArm: [{ t, r: [x, y, z] }, ...], ... },
 *       hips:   [{ t, p: [dx, dy, dz] }, ...],
 *     }
 *
 * `r` is an XYZ Euler triple in degrees, local to the parent bone and relative to
 * the T-pose. `p` is a hips offset in metres from the standing rest. Its own
 * `retarget.py` already renamed the 27 ARDY joints onto VRM humanoid bones and
 * converted world rotations to local ones, so this module has no joint table to
 * maintain: the bone names and the parent order are the ones `vrma.mjs` writes.
 *
 * The remaining work is small and entirely mechanical — degrees to quaternion,
 * offset to absolute translation, and a shared frame grid.
 */

import {
  HUMANOID_BONES,
  REST_WORLD,
  quatFromAxisAngle,
  quatMultiply,
  writeVrma,
} from './vrma.mjs'

const DEG = Math.PI / 180

/** Grid assumed when the spec leaves no measurable spacing; ARDY runs at 20 fps. */
const DEFAULT_FPS = 20

/** Bones the writer has a node for; anything else in the spec is reported, not written. */
const WRITABLE = new Set(HUMANOID_BONES)

/**
 * Turn one ARDY Euler triple into a local rotation quaternion.
 *
 * ARDY writes its angles with `scipy` `as_euler('XYZ')`, which is *intrinsic*
 * X-Y-Z. The equivalent single rotation is `Rx · Ry · Rz`, and three.js calls
 * the same composition Euler order `'XYZ'`. Reading the letters as extrinsic
 * would silently shear every pose, so the order is spelled out rather than
 * inferred from a helper name.
 *
 * @param rotation - `[x, y, z]` in degrees.
 * @returns The rotation as `[x, y, z, w]`.
 */
export function ardyspecQuaternion(rotation) {
  const [x, y, z] = Array.isArray(rotation) ? rotation : []
  const rad = (value) => (Number.isFinite(Number(value)) ? Number(value) * DEG : 0)
  return quatMultiply(
    quatMultiply(quatFromAxisAngle([1, 0, 0], rad(x)), quatFromAxisAngle([0, 1, 0], rad(y))),
    quatFromAxisAngle([0, 0, 1], rad(z)),
  )
}

/**
 * Keep only the usable keys of one track, in time order.
 *
 * @param entries - The track as the engine sent it.
 * @returns `[{ t, ...key }]` sorted ascending; keys without a finite `t` are dropped.
 */
function sortedKeys(entries) {
  if (!Array.isArray(entries)) return []
  return entries
    .filter((key) => key !== null && typeof key === 'object' && Number.isFinite(Number(key.t)))
    .map((key) => ({ ...key, t: Number(key.t) }))
    .sort((a, b) => a.t - b.t)
}

/**
 * Estimate the sample rate of a frame grid.
 *
 * @param times - Sorted key times in seconds.
 * @returns Frames per second, never zero.
 */
function inferFps(times) {
  if (times.length < 2) return DEFAULT_FPS
  const gaps = []
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index] - times[index - 1]
    if (gap > 0) gaps.push(gap)
  }
  if (gaps.length === 0) return DEFAULT_FPS
  gaps.sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  const fps = Math.round(1 / median)
  return Number.isFinite(fps) && fps > 0 ? Math.min(240, fps) : DEFAULT_FPS
}

/**
 * Convert an ARDY spec into a `.vrma` clip.
 *
 * Bones the stage cannot drive are dropped and named in `unmapped` rather than
 * failing the clip: one unknown bone must not cost the whole motion.
 *
 * @param raw - The spec, or the `{ type: 'final', spec }` envelope of the
 *   streaming endpoint.
 * @param options - `{ name }` overrides the clip name.
 * @returns `{ buffer, bones, tracks, frames, fps, duration, unmapped }`.
 */
export function ardyspecToVrma(raw, options = {}) {
  const spec = raw !== null && typeof raw === 'object' && raw.spec !== undefined ? raw.spec : raw
  if (spec === null || typeof spec !== 'object') throw new Error('ARDY 的响应不是 motion spec')

  const sourceTracks = spec.tracks !== null && typeof spec.tracks === 'object' ? spec.tracks : {}
  const hipsKeys = sortedKeys(spec.hips)

  const prepared = new Map()
  const unmapped = []
  for (const [bone, entries] of Object.entries(sourceTracks)) {
    if (!WRITABLE.has(bone)) {
      unmapped.push(bone)
      continue
    }
    const keys = sortedKeys(entries)
    if (keys.length === 0) continue
    prepared.set(bone, keys.map((key) => ({ t: key.t, q: ardyspecQuaternion(key.r) })))
  }

  const grid = new Set()
  for (const keys of prepared.values()) for (const key of keys) grid.add(key.t)
  for (const key of hipsKeys) grid.add(key.t)
  const times = [...grid].sort((a, b) => a - b)
  if (times.length === 0) throw new Error('ARDY 的响应里没有任何关键帧')

  // One cursor per bone: `times` only moves forward, so each track is walked once
  // and every frame reads the last key at or before its time. ARDY emits one key
  // per frame per bone, so this lands exactly on the intended pose.
  const cursors = new Map([...prepared.keys()].map((bone) => [bone, 0]))
  let hipsCursor = 0
  const frames = times.map((t) => {
    const rot = {}
    for (const [bone, keys] of prepared) {
      let cursor = cursors.get(bone)
      while (cursor + 1 < keys.length && keys[cursor + 1].t <= t) cursor += 1
      cursors.set(bone, cursor)
      rot[bone] = keys[cursor].q
    }
    // `REST_WORLD.hips.y` is not a height to get right — it is the value the
    // player divides out. three-vrm-animation scales every hips translation by
    // `humanoid.normalizedRestPose.hips.position.y / clipRestHipsPosition.y`, so
    // a clip standing at 0.92 lands on the target model's own rest height no
    // matter what this constant is, and matching the engine's 0.90 here would
    // change nothing visible. What matters is that it never reaches zero: the
    // ratio would be infinite and the loader warns about a T-pose violation.
    let hips
    if (hipsKeys.length > 0) {
      while (hipsCursor + 1 < hipsKeys.length && hipsKeys[hipsCursor + 1].t <= t) hipsCursor += 1
      const offset = hipsKeys[hipsCursor].p
      if (Array.isArray(offset) && offset.length >= 3) {
        hips = REST_WORLD.hips.map((rest, axis) => rest + (Number(offset[axis]) || 0))
      }
    }
    return { t, rot, ...(hips === undefined ? {} : { hips }) }
  })

  const fps = inferFps(times)
  const name = typeof options.name === 'string' && options.name !== ''
    ? options.name
    : typeof spec.name === 'string' && spec.name !== ''
      ? spec.name
      : 'ardy'
  const buffer = writeVrma({ name, fps, frames })
  const duration = Number.isFinite(Number(spec.duration)) && Number(spec.duration) > 0
    ? Number(spec.duration)
    : times[times.length - 1]

  return {
    buffer,
    bones: [...prepared.keys()],
    tracks: prepared.size,
    frames: frames.length,
    fps,
    duration,
    unmapped,
  }
}
