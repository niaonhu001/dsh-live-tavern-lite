/**
 * Built-in motion clips.
 *
 * They exist so the whole chain — prompt, clip file, browser playback — can be
 * exercised on a machine with no motion engine running, and so a failed provider
 * has something honest to fall back to. They are hand-tuned poses, not model
 * output; the generated report says which provider produced a clip.
 */

import { rotate } from './vrma.mjs'

/** Frame rate every built-in clip is sampled at. */
const FPS = 30

/**
 * Sample one built-in clip on a fixed grid.
 *
 * @param id - Clip id: `wave`, `bow`, `nod`, `crouch`, `turn`, `dance`.
 * @param seconds - Requested duration; clamped to 1–12 seconds.
 * @returns `{ name, fps, frames }` ready for `writeVrma`.
 */
export function sampleClip(id, seconds = 4) {
  const duration = Math.min(12, Math.max(1, Number(seconds) || 4))
  const pose = POSE_LIBRARY[id] ?? POSE_LIBRARY.wave
  const count = Math.max(2, Math.round(duration * FPS))
  const frames = []
  for (let index = 0; index <= count; index += 1) {
    const t = (index / count) * duration
    frames.push({ t, ...pose(t / duration, duration) })
  }
  return { name: `sample-${id}`, fps: FPS, frames }
}

/** Ids `sampleClip` understands; the tool lists them in its description. */
export const SAMPLE_IDS = ['wave', 'bow', 'nod', 'crouch', 'turn', 'dance']

/**
 * One authored pose per built-in clip.
 *
 * Each function receives normalised time 0–1 and the duration, and returns
 * `{ rot, hips }` in the convention `writeVrma` documents: rotations are local
 * to the parent and relative to the T-pose.
 */
const POSE_LIBRARY = {
  /** Left arm up, elbow oscillating: the shape of a greeting. */
  wave(u, _duration) {
    const swing = Math.sin(u * Math.PI * 6) * 14
    const ramp = Math.min(1, u * 4) * Math.min(1, (1 - u) * 4)
    return {
      rot: {
        leftShoulder: rotate([0, 0, 1], 6 * ramp),
        leftUpperArm: rotate([0, 0, 1], 78 * ramp),
        leftLowerArm: rotate([0, 0, 1], (18 + swing) * ramp),
        leftHand: rotate([0, 1, 0], swing * 0.8 * ramp),
        head: rotate([0, 0, 1], 4 * ramp),
      },
    }
  },
  /** A seated bow: hips, spine and neck share the fold. */
  bow(u, _duration) {
    const fold = u < 0.4 ? u / 0.4 : u > 0.75 ? (1 - u) / 0.25 : 1
    return {
      rot: {
        hips: rotate([1, 0, 0], 4 * fold),
        spine: rotate([1, 0, 0], 18 * fold),
        chest: rotate([1, 0, 0], 14 * fold),
        neck: rotate([1, 0, 0], 8 * fold),
        head: rotate([1, 0, 0], 4 * fold),
        leftUpperArm: rotate([0, 0, 1], -34 * fold),
        rightUpperArm: rotate([0, 0, 1], 34 * fold),
      },
    }
  },
  /** Two nods and a settle. */
  nod(u, _duration) {
    const wave = Math.sin(u * Math.PI * 4)
    return { rot: { neck: rotate([1, 0, 0], 6 * Math.max(0, wave)), head: rotate([1, 0, 0], 12 * Math.max(0, wave)) } }
  },
  /** A squat that comes back up: knees bend, hips drop, feet stay planted. */
  crouch(u, _duration) {
    const bend = u < 0.5 ? Math.min(1, u * 2.6) : Math.max(0, (1 - u) * 2.6)
    const drop = 0.34 * bend
    return {
      rot: {
        hips: rotate([1, 0, 0], 10 * bend),
        spine: rotate([1, 0, 0], 8 * bend),
        chest: rotate([1, 0, 0], 6 * bend),
        leftUpperLeg: rotate([1, 0, 0], -58 * bend),
        rightUpperLeg: rotate([1, 0, 0], -58 * bend),
        leftLowerLeg: rotate([1, 0, 0], 92 * bend),
        rightLowerLeg: rotate([1, 0, 0], 92 * bend),
        leftFoot: rotate([1, 0, 0], -32 * bend),
        rightFoot: rotate([1, 0, 0], -32 * bend),
      },
      hips: [0, 0.92 - drop, 0],
    }
  },
  /** A quarter turn each way, driven from the hips. */
  turn(u, _duration) {
    const angle = Math.sin(u * Math.PI * 2) * 55
    return {
      rot: {
        hips: rotate([0, 1, 0], angle),
        spine: rotate([0, 1, 0], angle * 0.12),
        head: rotate([0, 1, 0], angle * 0.18),
      },
    }
  },
  /** Weight shift with the arms keeping the beat. */
  dance(u, _duration) {
    const beat = Math.sin(u * Math.PI * 8)
    const sway = Math.sin(u * Math.PI * 4)
    return {
      rot: {
        hips: rotate([0, 0, 1], sway * 6),
        spine: rotate([0, 0, 1], sway * 5),
        chest: rotate([0, 0, 1], sway * 4),
        leftUpperArm: rotate([0, 0, 1], -40 + beat * 22),
        rightUpperArm: rotate([0, 0, 1], 40 - beat * 22),
        leftLowerArm: rotate([0, 0, 1], 34 + beat * 18),
        rightLowerArm: rotate([0, 0, 1], -34 - beat * 18),
        head: rotate([0, 0, 1], sway * 5),
      },
    }
  },
}
