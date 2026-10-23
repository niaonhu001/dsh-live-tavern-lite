/**
 * Geometric checks for a posed VRM.
 *
 * A recipe says what a pose should look like ("hand on the knee", "head at 46% of standing
 * height"). These helpers measure the posed skeleton against those targets, so a pose that is
 * geometrically wrong says so instead of waiting to be noticed by eye.
 *
 * All measurements are in metres, in world space, with the feet at rest height as the floor.
 */

import * as THREE from 'three'

/** The channels a check may ask about, and what they mean. */
export const CHECK_TYPES = {
  handToKnee: '手掌到膝盖的距离（米，越小越贴）',
  headHeightRatio: '头顶高度 ÷ 站立高度（0.46≈蹲到底，1=站直）',
  footOnGround: '脚相对静止位置的高低差（米，0=踩在地上）',
  handToHip: '手掌到胯骨的距离（米）',
}

/**
 * Read the points a check needs.
 *
 * @param vrm - A loaded `VRM` instance.
 * @returns World positions and the standing reference, or null when the rig lacks the bones.
 */
export function readPoseSkeleton(vrm, scale = 1) {
  const node = (name) => vrm?.humanoid?.getNormalizedBoneNode?.(name) ?? null
  const names = ['head', 'hips', 'leftHand', 'rightHand', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot']
  const nodes = {}
  for (const name of names) {
    const value = node(name)
    if (value === null || value === undefined) return null
    nodes[name] = value
  }
  // The stage scales the whole model to fit; world units would report screen metres instead of
  // body metres, so every point is converted back to model units.
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
  const world = {}
  for (const [name, value] of Object.entries(nodes)) {
    const point = new THREE.Vector3()
    value.getWorldPosition(point)
    world[name] = point.divideScalar(factor)
  }
  return world
}

/**
 * Evaluate every check against the current pose.
 *
 * @param vrm - A loaded `VRM` instance.
 * @param checks - The recipe's `checks` array.
 * @param rest - Standing reference captured before posing: `{ headY, footY }`.
 * @returns One result per check: `{ type, value, target, ok, text }`.
 */
export function evaluateChecks(vrm, checks, rest, scale = 1) {
  const world = readPoseSkeleton(vrm, scale)
  if (world === null || !Array.isArray(checks) || checks.length === 0) return []
  const results = []
  for (const check of checks) {
    const type = check?.type
    const side = check?.side === 'right' ? 'right' : 'left'
    if (typeof type !== 'string') continue
    const max = Number.isFinite(Number(check.max)) ? Number(check.max) : undefined
    const tolerance = Number.isFinite(Number(check.tolerance)) ? Number(check.tolerance) : 0.08
    if (type === 'handToKnee') {
      const value = world[`${side}Hand`].distanceTo(world[`${side}LowerLeg`])
      const limit = max ?? 0.12
      results.push({ type, side, value, target: limit, ok: value <= limit, text: `${side === 'right' ? '右' : '左'}手掌到膝盖 ${value.toFixed(3)} m（要求 ≤ ${limit}）` })
      continue
    }
    if (type === 'handToHip') {
      const value = world[`${side}Hand`].distanceTo(world.hips)
      const limit = max ?? 0.22
      results.push({ type, side, value, target: limit, ok: value <= limit, text: `${side === 'right' ? '右' : '左'}手掌到胯 ${value.toFixed(3)} m（要求 ≤ ${limit}）` })
      continue
    }
    if (type === 'headHeightRatio') {
      const floor = Number(rest?.footY ?? 0)
      const standing = Number(rest?.headY ?? 1) - floor
      const target = Number.isFinite(Number(check.target)) ? Number(check.target) : 0.5
      const value = standing > 0.01 ? (world.head.y - floor) / standing : 1
      results.push({ type, value, target, ok: Math.abs(value - target) <= tolerance, text: `头顶高度 ${(value * 100).toFixed(0)}%（目标 ${(target * 100).toFixed(0)}% ± ${(tolerance * 100).toFixed(0)}%）` })
      continue
    }
    if (type === 'footOnGround') {
      const floor = Number(rest?.footY ?? 0)
      const value = Math.max(Math.abs(world.leftFoot.y - floor), Math.abs(world.rightFoot.y - floor))
      const limit = max ?? 0.03
      results.push({ type, value, target: limit, ok: value <= limit, text: `脚离地 ${(value * 100).toFixed(1)} cm（要求 ≤ ${(limit * 100).toFixed(0)} cm）` })
    }
  }
  return results
}
