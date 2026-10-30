/**
 * VRM Animation 1.0 (`.vrma`) writing and inspection, with no dependencies.
 *
 * A `.vrma` is a glTF binary whose humanoid nodes carry the rest pose and whose
 * animation channels carry humanoid-local rotations, so the clip is
 * avatar-independent: the player retargets it onto any VRM by bone name.
 *
 * The clip this module writes follows what `@pixiv/three-vrm-animation` reads
 * back: identity node rotations, a T-pose translation table, one LINEAR sampler
 * per bone, and a `hips` translation track when the caller supplies one.
 */

/** Uniform metres-to-metres scaffold the rest pose uses; VRM normalises by bone name. */
export const REST_WORLD = {
  hips: [0, 0.92, 0],
  spine: [0, 1.02, 0],
  chest: [0, 1.11, 0],
  upperChest: [0, 1.19, 0],
  neck: [0, 1.31, 0],
  head: [0, 1.39, 0],
  leftShoulder: [0.04, 1.31, 0],
  leftUpperArm: [0.12, 1.33, 0],
  leftLowerArm: [0.38, 1.33, 0],
  leftHand: [0.63, 1.33, 0],
  rightShoulder: [-0.04, 1.31, 0],
  rightUpperArm: [-0.12, 1.33, 0],
  rightLowerArm: [-0.38, 1.33, 0],
  rightHand: [-0.63, 1.33, 0],
  leftUpperLeg: [0.09, 0.88, 0],
  leftLowerLeg: [0.09, 0.48, 0],
  leftFoot: [0.09, 0.08, 0],
  leftToes: [0.09, 0.03, 0.10],
  rightUpperLeg: [-0.09, 0.88, 0],
  rightLowerLeg: [-0.09, 0.48, 0],
  rightFoot: [-0.09, 0.08, 0],
  rightToes: [-0.09, 0.03, 0.10],
}

/** Humanoid parent of every bone in `REST_WORLD`. */
const REST_PARENT = {
  hips: null,
  spine: 'hips',
  chest: 'spine',
  upperChest: 'chest',
  neck: 'upperChest',
  head: 'neck',
  leftShoulder: 'upperChest',
  leftUpperArm: 'leftShoulder',
  leftLowerArm: 'leftUpperArm',
  leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest',
  rightUpperArm: 'rightShoulder',
  rightLowerArm: 'rightUpperArm',
  rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg',
  leftFoot: 'leftLowerLeg',
  leftToes: 'leftFoot',
  rightUpperLeg: 'hips',
  rightLowerLeg: 'rightUpperLeg',
  rightFoot: 'rightLowerLeg',
  rightToes: 'rightFoot',
}

/** Every humanoid bone the writer emits, in hierarchy order. */
export const HUMANOID_BONES = Object.keys(REST_PARENT)

/** Length of one identity quaternion. */
export const IDENTITY = [0, 0, 0, 1]

/**
 * Multiply two quaternions in `[x, y, z, w]` order.
 *
 * @param a - Left factor.
 * @param b - Right factor.
 * @returns The Hamilton product `a * b`.
 */
export function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

/**
 * Build a quaternion from an axis and an angle.
 *
 * @param axis - Unit axis, `[x, y, z]`.
 * @param radians - Rotation angle in radians.
 * @returns The quaternion in `[x, y, z, w]` order.
 */
export function quatFromAxisAngle(axis, radians) {
  const [x, y, z] = axis
  const length = Math.hypot(x, y, z) || 1
  const half = radians / 2
  const scale = Math.sin(half) / length
  return [x * scale, y * scale, z * scale, Math.cos(half)]
}

/**
 * Normalise a quaternion, falling back to identity for a degenerate value.
 *
 * @param value - Quaternion in `[x, y, z, w]` order.
 * @returns The unit quaternion.
 */
export function quatNormalize(value) {
  const length = Math.hypot(value[0], value[1], value[2], value[3])
  if (!(length > 1e-8)) return [...IDENTITY]
  return value.map(component => component / length)
}

/**
 * Rotate one generic channel by an axis and an angle, relative to a bone's rest.
 *
 * Chained calls compose in argument order, so `(X, then Z)` reads like the pose
 * it describes instead of the quaternion algebra behind it.
 *
 * @param axis - Unit axis in the bone's parent frame.
 * @param degrees - Angle in degrees.
 * @param rest - Quaternion the rotation multiplies, default identity.
 * @returns The composed quaternion.
 */
export function rotate(axis, degrees, rest = IDENTITY) {
  return quatNormalize(quatMultiply(quatFromAxisAngle(axis, (degrees * Math.PI) / 180), rest))
}

/**
 * Build a glTF binary container around one JSON and one binary chunk.
 *
 * @param json - The glTF document.
 * @param bin - The binary chunk payload.
 * @returns The complete `.glb` bytes.
 */
function packGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  const binPad = (4 - (bin.length % 4)) % 4
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)])
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)])
  const length = 12 + 8 + jsonChunk.length + (binChunk.length === 0 ? 0 : 8 + binChunk.length)
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(length, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonChunk.length, 0)
  jsonHeader.write('JSON', 4, 'ascii')
  const parts = [header, jsonHeader, jsonChunk]
  if (binChunk.length > 0) {
    const binHeader = Buffer.alloc(8)
    binHeader.writeUInt32LE(binChunk.length, 0)
    binHeader.write('BIN\u0000', 4, 'binary')
    parts.push(binHeader, binChunk)
  }
  return Buffer.concat(parts)
}

/**
 * Write a `.vrma` clip.
 *
 * @param clip - `{ name, fps, frames }`; each frame is `{ t, rot, hips }` where
 *   `rot` maps humanoid bone names to `[x, y, z, w]` local rotations and `hips`
 *   carries the optional root translation in metres.
 * @returns The `.vrma` file bytes.
 */
export function writeVrma(clip) {
  const name = typeof clip?.name === 'string' && clip.name !== '' ? clip.name : 'motion'
  const frames = Array.isArray(clip?.frames) ? clip.frames : []
  if (frames.length === 0) throw new Error('writeVrma: a clip needs at least one frame')
  const tracks = new Map()
  for (const frame of frames) {
    for (const [bone, rotation] of Object.entries(frame?.rot ?? {})) {
      // `hips` is the root, so its parent is `null` — a truthiness test would drop
      // its rotation track, which is where whole-body yaw lives (a turn, a walk
      // heading). Membership, not truthiness, decides whether a bone has a node.
      if (!(bone in REST_PARENT)) continue
      const list = tracks.get(bone) ?? []
      list.push(Array.isArray(rotation) && rotation.length === 4 ? quatNormalize(rotation.map(Number)) : [...IDENTITY])
      tracks.set(bone, list)
    }
  }
  const hipsTrack = frames.map(frame => (Array.isArray(frame?.hips) && frame.hips.length === 3
    ? frame.hips.map(Number)
    : null))
  const hasHips = hipsTrack.some(value => value !== null)
  if (hasHips) {
    for (let index = 0; index < hipsTrack.length; index += 1) {
      if (hipsTrack[index] === null) hipsTrack[index] = REST_WORLD.hips.slice()
    }
  }

  const nodes = HUMANOID_BONES.map(bone => {
    const parent = REST_PARENT[bone]
    const local = REST_WORLD[bone].map((value, axis) => value - (parent === null ? 0 : REST_WORLD[parent][axis]))
    return { name: bone, translation: local.map(value => Math.round(value * 1e6) / 1e6), children: [] }
  })
  const indexOf = new Map(HUMANOID_BONES.map((bone, index) => [bone, index]))
  for (const bone of HUMANOID_BONES) {
    const parent = REST_PARENT[bone]
    if (parent === null) continue
    nodes[indexOf.get(parent)].children.push(indexOf.get(bone))
  }

  const bin = []
  const bufferViews = []
  const accessors = []
  let binLength = 0
  const pushFloats = (values) => {
    const data = Float32Array.from(values)
    const view = { buffer: 0, byteOffset: binLength, byteLength: data.byteLength }
    bin.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    binLength += data.byteLength
    bufferViews.push(view)
    return bufferViews.length - 1
  }
  const times = frames.map(frame => Math.max(0, Number(frame?.t ?? 0)))
  // glTF requires an accessor's declared min/max to equal the stored values, and
  // the store is float32: 2.4 becomes 2.4000000953674316. Rounding in doubles
  // first produced clips whose declared bounds rejected every strict validator.
  const storedTimes = Float32Array.from(times)
  const timeView = pushFloats(storedTimes)
  const timeAccessor = {
    bufferView: timeView,
    componentType: 5126,
    count: storedTimes.length,
    type: 'SCALAR',
    min: [Math.min(...storedTimes)],
    max: [Math.max(...storedTimes)],
  }
  accessors.push(timeAccessor)

  const samplers = []
  const channels = []
  for (const [bone, rotations] of tracks) {
    const padded = frames.map((_, frameIndex) => rotations[frameIndex] ?? [...IDENTITY])
    const view = pushFloats(padded.flat())
    accessors.push({ bufferView: view, componentType: 5126, count: padded.length, type: 'VEC4' })
    samplers.push({ input: accessors.indexOf(timeAccessor), output: accessors.length - 1, interpolation: 'LINEAR' })
    channels.push({ sampler: samplers.length - 1, target: { node: indexOf.get(bone), path: 'rotation' } })
  }
  if (hasHips) {
    const view = pushFloats(hipsTrack.flat())
    accessors.push({ bufferView: view, componentType: 5126, count: hipsTrack.length, type: 'VEC3' })
    samplers.push({ input: accessors.indexOf(timeAccessor), output: accessors.length - 1, interpolation: 'LINEAR' })
    channels.push({ sampler: samplers.length - 1, target: { node: indexOf.get('hips'), path: 'translation' } })
  }

  const gltf = {
    asset: { version: '2.0', generator: 'dsh-live-tavern-lite motion' },
    scene: 0,
    scenes: [{ nodes: [indexOf.get('hips')] }],
    nodes,
    animations: [{ name, channels, samplers }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.reduce((total, chunk) => total + chunk.length, 0) }],
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: {
          humanBones: Object.fromEntries(HUMANOID_BONES.map(bone => [bone, { node: indexOf.get(bone) }])),
        },
      },
    },
  }
  return packGlb(gltf, Buffer.concat(bin))
}

/**
 * Split a glTF binary into its JSON document and binary chunk.
 *
 * @param bytes - The `.glb` bytes.
 * @returns `{ json, bin }`.
 */
export function readGlb(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error('not a GLB: bad magic')
  }
  let offset = 12
  let json = null
  let bin = Buffer.alloc(0)
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'JSON') json = JSON.parse(body.toString('utf8').replace(/\u0000+$/, '').trim())
    else if (type.startsWith('BIN')) bin = body
    offset += 8 + length
  }
  if (json === null) throw new Error('not a GLB: no JSON chunk')
  return { json, bin }
}

/**
 * Read back what a `.vrma` contains, for validation and for the tool result.
 *
 * @param bytes - The `.vrma` bytes.
 * @returns `{ specVersion, bones, tracks, duration, samples, size }`.
 */
export function inspectVrma(bytes) {
  const { json } = readGlb(bytes)
  const extension = json?.extensions?.VRMC_vrm_animation
  if (extension === undefined) throw new Error('not a VRMA: missing VRMC_vrm_animation')
  const bones = Object.keys(extension?.humanoid?.humanBones ?? {})
  const animation = Array.isArray(json.animations) ? json.animations[0] : undefined
  const channels = Array.isArray(animation?.channels) ? animation.channels : []
  const nodeName = new Map((json.nodes ?? []).map((node, index) => [index, node.name ?? `node${index}`]))
  const durations = []
  const tracks = []
  let samples = 0
  for (const channel of channels) {
    const sampler = animation.samplers?.[channel.sampler]
    const input = sampler === undefined ? undefined : json.accessors?.[sampler.input]
    if (input === undefined) continue
    if (Array.isArray(input.max) && input.max.length > 0) durations.push(Number(input.max[0]))
    samples = Math.max(samples, Number(input.count) || 0)
    tracks.push({
      bone: nodeName.get(channel.target?.node) ?? null,
      path: channel.target?.path ?? null,
      samples: Number(input.count) || 0,
    })
  }
  return {
    specVersion: extension?.specVersion ?? null,
    bones,
    tracks,
    duration: durations.length === 0 ? 0 : Math.round(Math.max(...durations) * 1000) / 1000,
    samples,
    size: Buffer.isBuffer(bytes) ? bytes.length : Buffer.from(bytes).length,
  }
}

/**
 * Whether a buffer looks like a playable VRMA clip.
 *
 * @param bytes - The candidate bytes.
 * @returns True when the extension and at least one rotation track exist.
 */
export function isVrma(bytes) {
  try {
    const info = inspectVrma(bytes)
    return info.bones.length > 0 && info.tracks.some(track => track.path === 'rotation')
  } catch {
    return false
  }
}
