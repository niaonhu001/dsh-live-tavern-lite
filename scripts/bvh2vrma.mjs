/**
 * Convert a BVH motion to VRMA (`.vrma`), the standard VRM animation format.
 *
 * The conversion is deliberately the same one mumoe uses: a BVH is a skeleton plus one
 * quaternion track per joint, so the job is to rename those tracks to VRM humanoid bone
 * names, keep only the root translation, fix units, and declare the humanoid map in the
 * glTF extension. Rescaling a pose onto another model's proportions happens at playback
 * time inside `@pixiv/three-vrm-animation`, not here.
 *
 * Usage:
 *   node scripts/bvh2vrma.mjs input.bvh output.vrma [--metres] [--scale=0.01]
 *
 * `--metres` says the source is already in metres (MoMask's template is); the default is
 * centimetres, which is what most BVH exporters write.
 */
import { readFile, writeFile } from 'node:fs/promises'
import * as THREE from 'three'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

/** BVH joint name → VRM humanoid bone name. Covers the usual Mixamo/MoMask spellings. */
const BONE_MAP = {
  hips: 'hips',
  spine: 'spine',
  spine1: 'chest',
  spine2: 'upperChest',
  spine3: 'upperChest',
  neck: 'neck',
  head: 'head',
  leftshoulder: 'leftShoulder',
  leftarm: 'leftUpperArm',
  leftforearm: 'leftLowerArm',
  lefthand: 'leftHand',
  rightshoulder: 'rightShoulder',
  rightarm: 'rightUpperArm',
  rightforearm: 'rightLowerArm',
  righthand: 'rightHand',
  leftupleg: 'leftUpperLeg',
  leftleg: 'leftLowerLeg',
  leftfoot: 'leftFoot',
  lefttoe: 'leftToes',
  lefttoebase: 'leftToes',
  rightupleg: 'rightUpperLeg',
  rightleg: 'rightLowerLeg',
  rightfoot: 'rightFoot',
  righttoe: 'rightToes',
  righttoebase: 'rightToes',
  jaw: 'jaw',
}

/** Normalise a BVH joint name for lookup: strip the `.bones[` prefix and punctuation. */
const lookup = (name) => name
  .replace(/^.*\.bones\[(.*)\]$/, '$1')
  .replace(/^mixamorig:?/i, '')
  .replace(/[_\s-]/g, '')
  .toLowerCase()

/**
 * GLTFExporter plugin that declares the VRMA humanoid map.
 *
 * `VRMC_vrm_animation` is what makes the file portable: the player reads this table and
 * binds the clips onto the target model's own bones.
 */
class VrmAnimationExporterPlugin {
  constructor(writer) {
    this.writer = writer
    this.name = 'VRMC_vrm_animation'
  }

  afterParse(input) {
    const root = Array.isArray(input) ? input[0] : input
    const map = root?.userData?.vrmBoneMap
    if (map === undefined || map === null) return
    const humanBones = {}
    for (const [boneName, bone] of map) {
      const node = this.writer.nodeMap?.get(bone)
      if (node !== undefined && node !== null) humanBones[boneName] = { node }
    }
    const json = this.writer.json
    json.extensionsUsed ??= []
    json.extensionsUsed.push(this.name)
    json.extensions ??= {}
    json.extensions[this.name] = { specVersion: '1.0', humanoid: { humanBones } }
  }
}

/** GLTFExporter reaches for FileReader, which Node does not have. */
class NodeFileReader {
  constructor() {
    this.result = null
    this.onload = null
    this.onloadend = null
    this.onerror = null
  }

  readAsArrayBuffer(blob) {
    void blob.arrayBuffer().then((result) => {
      this.result = result
      this.onload?.({ target: this })
      this.onloadend?.()
    }).catch((error) => this.onerror?.(error))
  }
}

const args = process.argv.slice(2)
const positional = args.filter(argument => !argument.startsWith('--'))
const flags = new Set(args.filter(argument => argument.startsWith('--') && !argument.includes('=')))
const scaleFlag = args.find(argument => argument.startsWith('--scale='))

if (positional.length !== 2) {
  console.error('usage: node scripts/bvh2vrma.mjs input.bvh output.vrma [--metres] [--scale=0.01]')
  process.exit(1)
}
const [inputPath, outputPath] = positional

const bvhText = await readFile(inputPath, 'utf8')
const bvh = new BVHLoader().parse(bvhText)
const skeleton = bvh.skeleton.clone()
const clip = bvh.clip.clone()

// One unit fix, applied to bone offsets and to the root translation track alike.
const scale = scaleFlag !== undefined
  ? Number(scaleFlag.slice('--scale='.length))
  : (flags.has('--metres') ? 1 : 0.01)
if (!Number.isFinite(scale) || scale <= 0) {
  console.error(`invalid scale: ${scale}`)
  process.exit(1)
}

const rootBone = skeleton.bones[0]
rootBone.traverse((bone) => { bone.position.multiplyScalar(scale) })
rootBone.updateWorldMatrix(false, true)

const vrmBoneMap = new Map()
const unmapped = []
rootBone.traverse((bone) => {
  if (bone.isBone !== true) return
  const target = BONE_MAP[lookup(bone.name)]
  if (target === undefined) {
    unmapped.push(bone.name)
    return
  }
  if (!vrmBoneMap.has(target)) vrmBoneMap.set(target, bone)
})
if (vrmBoneMap.size === 0) {
  console.error('没有找到任何可映射的骨骼：检查 BVH 关节名，或在此脚本的 BONE_MAP 里补充')
  process.exit(1)
}
rootBone.userData.vrmBoneMap = vrmBoneMap

const hipsBone = vrmBoneMap.get('hips')
if (hipsBone === undefined) {
  console.error('缺少 hips：VRM 人形动画必须有根骨骼')
  process.exit(1)
}

// Rename the rotation tracks; keep one translation track (the root) and drop the rest.
const tracks = []
let hipsPositionTrack
for (const original of clip.tracks) {
  const track = original.clone()
  track.name = track.name.replace(/\.bones\[(.*)\]/, '$1')
  if (track.name.endsWith('.quaternion')) {
    tracks.push(track)
    continue
  }
  if (track.name === `${hipsBone.name}.position`) {
    const scaled = track.clone()
    scaled.values = track.values.map(value => value * scale)
    hipsPositionTrack = scaled
    tracks.push(scaled)
  }
}
clip.tracks = tracks

if (hipsPositionTrack !== undefined) {
  const offset = hipsBone.position.toArray()
  for (let index = 0; index < hipsPositionTrack.values.length; index += 1) {
    hipsPositionTrack.values[index] -= offset[index % 3]
  }
}

// BVH files often sink through the floor; lift the skeleton so its lowest bone is at 0.
const box = new THREE.Box3()
const probe = new THREE.Vector3()
for (const bone of skeleton.bones) box.expandByPoint(bone.getWorldPosition(probe))
if (box.min.y < 0) rootBone.position.y -= box.min.y

globalThis.FileReader = NodeFileReader
const exporter = new GLTFExporter()
exporter.register(writer => new VrmAnimationExporterPlugin(writer))
const gltf = await exporter.parseAsync(rootBone, { animations: [clip], binary: true })
await writeFile(outputPath, Buffer.from(gltf))

console.log(JSON.stringify({
  input: inputPath,
  output: outputPath,
  bones: vrmBoneMap.size,
  frames: bvh.clip.tracks[0]?.times.length ?? 0,
  duration: Number(bvh.clip.duration.toFixed(2)),
  scale,
  bytes: Buffer.from(gltf).byteLength,
  unmapped: unmapped.slice(0, 8),
}, null, 2))
