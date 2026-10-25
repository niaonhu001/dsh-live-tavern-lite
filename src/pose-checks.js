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
  elbowAngle: '肘的夹角（度，180=伸直，越小弯得越多）',
  kneeAngle: '膝的夹角（度，180=伸直）',
  handForward: '手掌相对肩的前后位置（米，正=身前）',
  handUp: '手掌相对肩的高低位置（米，正=高于肩）',
  handLateral: '手掌相对肩的左右位置（米，正=更靠外侧）',
  handDirForward: '手的朝向：前后分量（-1 到 1）',
  handDirUp: '手的朝向：高低分量（-1 到 1）',
  handDirLateral: '手的朝向：左右分量（-1 到 1）',
  wristAngle: '手相对前臂的偏转（度，静止值 ≈ 20–30，随屈伸增大）',
  elbowFlexion: '肘的弯曲角度（度，0=伸直）',
  kneeFlexion: '膝的弯曲角度（度，0=伸直）',
}

/**
 * Read the points a check needs.
 *
 * @param vrm - A loaded `VRM` instance.
 * @returns World positions and the standing reference, or null when the rig lacks the bones.
 */
export function readPoseSkeleton(vrm, scale = 1) {
  const node = (name) => vrm?.humanoid?.getNormalizedBoneNode?.(name) ?? null
  const names = ['head', 'hips', 'leftHand', 'rightHand', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot',
    'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg']
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
  // 手腕的旋转不移动腕关节，只能靠「手朝哪儿」来量。取手的局部 +Z 轴转到世界。
  for (const side of ['left', 'right']) {
    const hand = nodes[`${side}Hand`]
    if (hand === null || hand === undefined) continue
    const quaternion = new THREE.Quaternion()
    hand.getWorldQuaternion(quaternion)
    world[`${side}HandDir`] = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)
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
      continue
    }
    if (type === 'wristAngle') {
      const forearmFrom = world[`${side}LowerArm`]
      const forearmTo = world[`${side}Hand`]
      const dir = world[`${side}HandDir`]
      if (forearmFrom === undefined || forearmTo === undefined || dir === undefined) continue
      const forearm = forearmTo.clone().sub(forearmFrom).normalize()
      const degrees = (Math.acos(Math.max(-1, Math.min(1, forearm.dot(dir.clone().normalize())))) * 180) / Math.PI
      results.push({ type, side, value: degrees, target: 0, ok: true, text: `${side === 'right' ? '右' : '左'}手相对前臂 ${degrees.toFixed(1)}°` })
      continue
    }
    if (type === 'handDirForward' || type === 'handDirUp' || type === 'handDirLateral') {
      const dir = world[`${side}HandDir`]
      if (dir === undefined) continue
      const value = type === 'handDirForward' ? dir.z : type === 'handDirUp' ? dir.y : dir.x
      const target = Number.isFinite(Number(check.target)) ? Number(check.target) : 0
      results.push({ type, side, value, target, ok: true, text: `${side === 'right' ? '右' : '左'}手朝向 ${type === 'handDirForward' ? '前后' : type === 'handDirUp' ? '高低' : '左右'} ${value.toFixed(3)}` })
      continue
    }
    // 关节角只是「弯了多少」；铰链对不对要看手往哪儿走。这三个分量量的是
    // 手掌相对肩的位移：真正的肘屈曲应该是「向前 + 向上」，不该往侧面甩。
    if (type === 'handForward' || type === 'handUp' || type === 'handLateral') {
      const shoulder = world[`${side}UpperArm`]
      const hand = world[`${side}Hand`]
      if (shoulder === undefined || hand === undefined) continue
      const delta = hand.clone().sub(shoulder)
      const value = type === 'handForward' ? delta.z : type === 'handUp' ? delta.y : Math.abs(delta.x)
      const target = Number.isFinite(Number(check.target)) ? Number(check.target) : 0
      results.push({ type, side, value, target, ok: true, text: `${side === 'right' ? '右' : '左'}手相对肩 ${type === 'handForward' ? '前后' : type === 'handUp' ? '高低' : '左右'} ${value.toFixed(3)} m` })
      continue
    }
    // Joint angles: distance alone cannot tell "arm raised" from "elbow bent", so the
    // calibration needs the angle the rig actually made.
    if (type === 'elbowAngle' || type === 'kneeAngle') {
      const upper = world[`${side}${type === 'elbowAngle' ? 'UpperArm' : 'UpperLeg'}`]
      const lower = world[`${side}${type === 'elbowAngle' ? 'LowerArm' : 'LowerLeg'}`]
      const tip = type === 'elbowAngle' ? world[`${side}Hand`] : world[`${side}Foot`]
      if (upper === undefined || lower === undefined || tip === undefined) continue
      const a = lower.clone().sub(upper)
      const b = tip.clone().sub(lower)
      const degrees = (Math.acos(Math.max(-1, Math.min(1, a.normalize().dot(b.normalize())))) * 180) / Math.PI
      const value = 180 - degrees
      const target = Number.isFinite(Number(check.target)) ? Number(check.target) : 0
      results.push({ type, side, value, target, ok: Math.abs(value - target) <= tolerance, text: `${side === 'right' ? '右' : '左'}${type === 'elbowAngle' ? '肘' : '膝'}弯曲 ${value.toFixed(1)}°（目标 ${target}° ± ${(tolerance * 100).toFixed(0)}%）` })
    }
  }
  return results
}
