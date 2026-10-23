/**
 * Browser half of the channel inspector.
 *
 * `window.__inspect({ channel, delta })` puts the skeleton back to rest, rotates one channel,
 * renders, and reports both the pixel image and where the end effectors went. The driver
 * (`scripts/inspect-channels.mjs`) walks every channel and writes a gallery.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

const canvas = document.getElementById('c')
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true })
renderer.setSize(window.innerWidth, window.innerHeight, false)
renderer.setClearColor(0x000000, 0)
renderer.outputColorSpace = THREE.SRGBColorSpace

const scene = new THREE.Scene()
scene.background = new THREE.Color(0xf4efe9)
const camera = new THREE.OrthographicCamera(
  -window.innerWidth / 2, window.innerWidth / 2,
  window.innerHeight / 2, -window.innerHeight / 2, 0.1, 6000,
)
camera.position.set(0, 0, 1500)
scene.add(new THREE.AmbientLight(0xffffff, 1.1))
const key = new THREE.DirectionalLight(0xffffff, 1.0)
key.position.set(-0.4, 1, 1.2)
scene.add(key)

const loader = new GLTFLoader()
loader.register(parser => new VRMLoaderPlugin(parser))
const gltf = await loader.loadAsync('/model.vrm')
const vrm = gltf.userData.vrm
VRMUtils.removeUnnecessaryVertices(gltf.scene)
VRMUtils.combineSkeletons(gltf.scene)
VRMUtils.rotateVRM0(vrm)
// The broken outline hull of some VRM 0.x packs would render as a black sheet.
vrm.scene.traverse((object) => {
  if (object.isMesh !== true) return
  object.frustumCulled = false
  if (!Array.isArray(object.material)) return
  const kept = object.material.filter(material => material?._isOutline !== true)
  if (kept.length !== object.material.length) object.material = kept.length === 1 ? kept[0] : kept
})
const pivot = new THREE.Group()
pivot.add(vrm.scene)
scene.add(pivot)
vrm.update(0)

const DEG = Math.PI / 180
// The humanoid bone names this model declares, whatever the VRM version.
const declaredBones = (() => {
  const human = vrm.humanoid
  const bag = human?.humanBones ?? {}
  const names = Array.isArray(bag) ? bag.map(entry => entry?.bone) : Object.keys(bag)
  return names.filter(name => typeof name === 'string')
})()

/** Bones whose position is worth watching: the extremities tell us what an axis does. */
const probes = ['head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes', 'chest']
const probeNodes = new Map()
for (const name of probes) {
  const node = vrm.humanoid?.getNormalizedBoneNode?.(name) ?? null
  if (node !== null && node !== undefined) probeNodes.set(name, node)
}
// A rotated bone does not move itself, only its children: watch a point above the head so a
// nod shows up as movement instead of "the axis twists".
const headNode = vrm.humanoid?.getNormalizedBoneNode?.('head') ?? null
const _tip = new THREE.Vector3()
const headTip = headNode === null || headNode === undefined
  ? null
  : {
      getWorldPosition: (target) => {
        target.copy(_tip.set(0, 0.18, 0).applyMatrix4(headNode.matrixWorld))
        return target
      },
    }
if (headTip !== null) probeNodes.set('headTip', headTip)

// A toe bone rotates around its own root, so its own position barely moves. Watch the point
// past the toes instead: foot → toes doubled.
for (const side of ['left', 'right']) {
  const footNode = vrm.humanoid?.getNormalizedBoneNode?.(`${side}Foot`) ?? null
  const toesNode = vrm.humanoid?.getNormalizedBoneNode?.(`${side}Toes`) ?? null
  if (footNode === null || toesNode === null || footNode === undefined || toesNode === undefined) continue
  // Express foot→toes in the toes bone's own space, so the sampled tip turns with the bone
  // instead of staying pinned to the joint.
  const footPos = new THREE.Vector3()
  const toesPos = new THREE.Vector3()
  footNode.getWorldPosition(footPos)
  toesNode.getWorldPosition(toesPos)
  const localDir = toesPos.clone().sub(footPos)
  toesNode.updateWorldMatrix(true, false)
  localDir.applyMatrix4(new THREE.Matrix4().copy(toesNode.matrixWorld).invert())
  probeNodes.set(`${side}ToeTip`, {
    getWorldPosition: (target) => {
      toesNode.updateWorldMatrix(true, false)
      return target.copy(localDir).applyMatrix4(toesNode.matrixWorld)
    },
  })
}
const restRotations = new Map()
vrm.scene.traverse((object) => {
  if (object.isBone === true) restRotations.set(object, object.rotation.clone())
})

const normalizedNode = (boneName) => vrm.humanoid?.getNormalizedBoneNode?.(boneName) ?? null
const hipsNode = normalizedNode('hips')
const hipsRest = hipsNode === null ? null : hipsNode.position.clone()
let stageBox = null

/**
 * Reset the pose, then frame the model exactly like the stage does.
 *
 * The stage scales the model so its height is 92% of the viewport (width capped), puts its
 * feet on the bottom edge and never refits afterwards. Measuring under the same framing is
 * the point: an auto-fit preview hides how low a crouch really is.
 */
function resetAndFit() {
  // The rendered skeleton and the normalised humanoid rig are separate: reset both, or poses
  // measured one after another pile up.
  for (const [bone, rotation] of restRotations) bone.rotation.copy(rotation)
  for (const name of declaredBones) {
    const node = vrm.humanoid?.getNormalizedBoneNode?.(name) ?? null
    if (node !== null && node !== undefined) node.rotation.set(0, 0, 0)
  }
  if (hipsNode !== null) hipsNode.position.copy(hipsRest)
  vrm.scene.position.set(0, 0, 0)
  vrm.scene.scale.setScalar(1)
  vrm.scene.updateMatrixWorld(true)
  vrm.update(0)
  if (stageBox === null) stageBox = new THREE.Box3().setFromObject(vrm.scene)
  const size = stageBox.getSize(new THREE.Vector3())
  const targetHeight = window.innerHeight * 0.92
  const maxWidth = window.innerWidth * 0.6
  const scale = Math.min(targetHeight / (size.y > 0.01 ? size.y : 1.6), maxWidth / (size.x > 0.01 ? size.x : 1))
  vrm.scene.scale.setScalar(scale)
  vrm.scene.updateMatrixWorld(true)
  vrm.scene.position.set(0, -window.innerHeight / 2 - stageBox.min.y * scale, 0)
  vrm.scene.updateMatrixWorld(true)
}

/** Where the watched bones are, in world units. */
function readProbes() {
  const out = {}
  for (const [name, node] of probeNodes) {
    const v = new THREE.Vector3()
    node.getWorldPosition(v)
    out[name] = [Number(v.x.toFixed(4)), Number(v.y.toFixed(4)), Number(v.z.toFixed(4))]
  }
  return out
}

function capture() {
  renderer.render(scene, camera)
  const copy = document.createElement('canvas')
  copy.width = canvas.width
  copy.height = canvas.height
  const context = copy.getContext('2d')
  context.drawImage(canvas, 0, 0)
  return { png: copy.toDataURL('image/png'), pixels: context.getImageData(0, 0, copy.width, copy.height).data }
}

/**
 * How far each watched bone moved on screen, in pixels.
 *
 * A world-space delta says nothing about whether a player notices; the same movement is huge
 * when zoomed in and invisible on the stage.
 */
function readScreenProbes() {
  const out = {}
  const projected = new THREE.Vector3()
  for (const [name, node] of probeNodes) {
    node.getWorldPosition(projected)
    projected.project(camera)
    out[name] = [
      Number(((projected.x * 0.5 + 0.5) * window.innerWidth).toFixed(1)),
      Number(((-projected.y * 0.5 + 0.5) * window.innerHeight).toFixed(1)),
    ]
  }
  return out
}

/** Share of pixels that differ from the rest pose, so a dead channel is obvious. */
function differenceRatio(a, b) {
  let different = 0
  let counted = 0
  for (let index = 0; index < a.length; index += 4 * 5) {
    counted += 1
    if (Math.abs(a[index] - b[index]) > 6 || Math.abs(a[index + 1] - b[index + 1]) > 6 || Math.abs(a[index + 2] - b[index + 2]) > 6) {
      different += 1
    }
  }
  return counted === 0 ? 0 : Number((different / counted).toFixed(4))
}

const setup = { probes: [...probeNodes.keys()], channels: declaredBones }

/**
 * Frame one body part.
 *
 * The fit scales the whole character into the viewport, so a finger is a few pixels tall.
 * Measuring its axis needs the camera to look at the hand instead of the room.
 *
 * @param group - `head` / `torso` / `arm` / `leg` / `hand` / `finger` / `all`.
 * @returns The framed box, or null when the group has no bones in this model.
 */
window.__setZoom = (group) => {
  resetAndFit()
  if (group === 'all' || group === null || group === undefined) {
    // The stage camera: ortho, viewport-sized, model already fitted by resetAndFit.
    camera.left = -window.innerWidth / 2
    camera.right = window.innerWidth / 2
    camera.top = window.innerHeight / 2
    camera.bottom = -window.innerHeight / 2
    camera.position.set(0, 0, 1200)
    camera.updateProjectionMatrix()
    return null
  }
  const wanted = {
    head: /head|neck|jaw/i,
    torso: /^(hips|spine|chest|upperChest)$/i,
    arm: /shoulder|upperArm|lowerArm/i,
    hand: /hand$/i,
    finger: /thumb|index|middle|ring|little/i,
    leg: /upperLeg|lowerLeg|foot|toes/i,
  }[group]
  const box = new THREE.Box3()
  const point = new THREE.Vector3()
  let count = 0
  vrm.scene.traverse((object) => {
    if (object.isBone !== true) return
    const name = object.name
    if (wanted !== undefined && !wanted.test(name)) return
    object.getWorldPosition(point)
    box.expandByPoint(point)
    count += 1
  })
  if (count === 0 || box.isEmpty()) {
    camera.left = -window.innerWidth / 2
    camera.right = window.innerWidth / 2
    camera.top = window.innerHeight / 2
    camera.bottom = -window.innerHeight / 2
    camera.position.set(0, 0, 1500)
    camera.updateProjectionMatrix()
    return null
  }
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  // A hand needs more air around it than a head; keep both inside a comfortable frame.
  const pad = group === 'finger' ? 3.2 : group === 'hand' ? 2.2 : 1.35
  const halfWidth = Math.max(size.x, size.y * 0.8, 24) * pad
  const halfHeight = Math.max(size.y, 24) * pad
  camera.left = center.x - halfWidth
  camera.right = center.x + halfWidth
  camera.top = center.y + halfHeight
  camera.bottom = center.y - halfHeight
  camera.position.set(center.x, center.y, 1500)
  camera.updateProjectionMatrix()
  return { center: center.toArray().map(n => Number(n.toFixed(2))), size: size.toArray().map(n => Number(n.toFixed(2))), bones: count }
}

resetAndFit()
const baseline = capture()
const baselineProbes = readProbes()
const baselineScreen = readScreenProbes()

window.__inspect = ({ bone, axis, delta, keepFrame, group }) => {
  resetAndFit()
  if (keepFrame === true) window.__setZoom(group)
  const node = normalizedNode(bone)
  if (node === null || node === undefined) return { ok: false, reason: 'no-bone' }
  const rest = node.rotation[axis]
  node.rotation[axis] = rest + delta * DEG
  vrm.update(0)
  vrm.scene.updateMatrixWorld(true)
  const posed = capture()
  const moved = readProbes()
  const deltas = {}
  for (const name of Object.keys(moved)) {
    const from = baselineProbes[name]
    const to = moved[name]
    if (from === undefined) continue
    deltas[name] = [Number((to[0] - from[0]).toFixed(4)), Number((to[1] - from[1]).toFixed(4)), Number((to[2] - from[2]).toFixed(4))]
  }
  node.rotation[axis] = rest
  vrm.update(0)
  const reference = groupBaseline.get(group ?? 'all') ?? baseline.pixels
  const screen = readScreenProbes()
  let movedPx = 0
  for (const [name, point] of Object.entries(screen)) {
    const from = baselineScreen[name]
    if (from === undefined) continue
    movedPx = Math.max(movedPx, Math.hypot(point[0] - from[0], point[1] - from[1]))
  }
  return {
    ok: true,
    image: posed.png,
    changed: differenceRatio(reference, posed.pixels),
    deltas,
    movedPx: Number(movedPx.toFixed(1)),
  }
}

/**
 * Render one named pose, so a recipe can be checked without replaying it in the plugin.
 *
 * @param pose - Channel → degrees, for example `{ BoneSpineX: -16 }`.
 * @param group - Optional zoom group (`all`, `head`, `hand`, …).
 * @returns The frame as a PNG data URL.
 */
window.__poseAt = (pose, group, translate) => {
  resetAndFit()
  window.__setZoom(group ?? 'all')
  for (const [channel, degrees] of Object.entries(pose ?? {})) {
    const match = /^Bone([A-Z][A-Za-z]*?)([XYZ])$/.exec(channel)
    if (match === null) continue
    const boneName = match[1].charAt(0).toLowerCase() + match[1].slice(1)
    const node = normalizedNode(boneName)
    if (node === null || node === undefined) continue
    const axis = match[2].toLowerCase()
    node.rotation[axis] = node.rotation[axis] + Number(degrees) * DEG
  }
  const hips = vrm.humanoid?.getNormalizedBoneNode?.('hips') ?? null
  if (hips !== null && hips !== undefined) {
    if (translate !== null && translate !== undefined && Array.isArray(translate.hips)) {
      hips.position.set(hips.position.x + Number(translate.hips[0] ?? 0), hips.position.y + Number(translate.hips[1] ?? 0), hips.position.z + Number(translate.hips[2] ?? 0))
    }
  }
  vrm.update(0)
  vrm.scene.updateMatrixWorld(true)
  return capture().png
}

window.__baseline = { image: baseline.png, probes: baselineProbes }

/** The rest pose as seen through one zoom group, for per-group pixel diffs. */
const groupBaseline = new Map()
window.__baselineAt = (group) => {
  const frame = window.__setZoom(group)
  const shot = capture()
  groupBaseline.set(group ?? 'all', shot.pixels)
  return { image: shot.png, frame }
}
window.__setup = setup
window.__probe = { ok: true }
document.title = 'ready'
