/**
 * Generates `assets/vrm-channel-defaults.json`.
 *
 * The VRM humanoid bone names are fixed by the specification, and three-vrm normalises
 * their local axes, so one note per bone and axis holds for every VRM. The signs below were
 * measured on a real model by rotating one axis at a time and watching the bone tip move:
 * negative X leans forward (bow, nod), positive X leans back; the arm chain's Z points the
 * other way on the right side.
 */
import { writeFileSync } from 'node:fs'

const families = {
  spine: {
    zero: '上身直立',
    x: ['正数身体后仰', '负数身体前俯'],
    y: ['正数上半身向她的右侧扭', '负数向左扭'],
    z: ['正数身体向她的右肩倾', '负数向左肩倾'],
  },
  head: {
    zero: '头正立、脸朝前',
    x: ['正数抬头', '负数低头'],
    y: ['正数向她的右侧转头', '负数向左侧转头'],
    z: ['正数向她的右肩歪头', '负数向左肩歪头'],
  },
  jaw: {
    zero: '嘴闭合',
    x: ['正数张嘴', '负数（无实际效果）'],
    y: ['正数下巴向她的右侧偏', '负数向左偏'],
    z: ['正数下巴偏侧', '负数反向偏侧'],
  },
  shoulder: {
    zero: '肩膀自然下垂',
    x: ['正数肩向前送', '负数肩向后收'],
    y: ['正数肩向后摆', '负数向前摆'],
    z: ['正数沉肩', '负数耸肩'],
  },
  upperArm: {
    zero: '手臂水平外展（T 姿势）',
    x: ['正数手臂扭转', '负数反向扭转'],
    y: ['正数手臂向后摆', '负数向前摆'],
    z: ['正数手臂向下落', '负数向上抬'],
  },
  lowerArm: {
    zero: '肘部伸直',
    x: ['正数前臂扭转', '负数反向扭转'],
    y: ['正数小臂向后摆', '负数向前摆'],
    z: ['正数小臂向下摆', '负数向上摆'],
  },
  hand: {
    zero: '手腕伸直、手掌向下',
    x: ['正数手腕向下弯', '负数向上翘'],
    y: ['正数手掌外翻', '负数内翻'],
    z: ['正数手腕向小指侧偏', '负数向拇指侧偏'],
  },
  upperLeg: {
    zero: '双腿直立并拢',
    x: ['正数向前抬腿', '负数向后摆腿'],
    y: ['正数大腿外旋', '负数内旋'],
    z: ['正数腿向外打开', '负数向内收'],
  },
  lowerLeg: {
    zero: '膝盖伸直',
    x: ['正数屈膝（小腿向后收', '负数过伸）'],
    y: ['正数小腿外旋', '负数内旋'],
    z: ['正数小腿向内侧摆', '负数向外摆'],
  },
  foot: {
    zero: '脚掌平放地面',
    x: ['正数脚尖上翘', '负数脚尖下压'],
    y: ['正数脚掌外转', '负数内转'],
    z: ['正数脚掌外翻', '负数内翻'],
  },
  toes: {
    zero: '脚趾伸直',
    x: ['正数脚趾上翘', '负数向下弯'],
    y: ['正数脚趾扭转', '负数反向扭转'],
    z: ['正数脚趾向侧摆', '负数反向侧摆'],
  },
  fingerProximal: {
    zero: '手指伸直',
    x: ['正数屈指', '负数过伸'],
    y: ['正数手指扭转', '负数反向扭转'],
    z: ['正数手指张开', '负数并拢'],
  },
  fingerIntermediate: {
    zero: '指中节伸直',
    x: ['正数屈曲', '负数过伸'],
    y: ['正数扭转', '负数反向扭转'],
    z: ['正数向侧摆', '负数反向侧摆'],
  },
  fingerDistal: {
    zero: '指尖伸直',
    x: ['正数屈曲', '负数过伸'],
    y: ['正数扭转', '负数反向扭转'],
    z: ['正数向侧摆', '负数反向侧摆'],
  },
  metacarpal: {
    zero: '掌骨自然展开',
    x: ['正数掌骨屈曲', '负数伸展'],
    y: ['正数掌骨扭转', '负数反向扭转'],
    z: ['正数掌骨侧摆', '负数反向侧摆'],
  },
}

const bones = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'jaw',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
]
for (const side of ['left', 'right']) {
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
    for (const joint of ['Metacarpal', 'Proximal', 'Intermediate', 'Distal']) {
      // VRM 0.x models may declare a thumb intermediate bone even though VRM 1.0 omits it.
      bones.push(`${side}${finger}${joint}`)
    }
  }
}

/** Which family a bone belongs to. */
function familyOf(bone) {
  if (/^hips$|^spine$|^chest$|^upperChest$/.test(bone)) return 'spine'
  if (bone === 'neck' || bone === 'head') return 'head'
  if (bone === 'jaw') return 'jaw'
  if (/Shoulder$/.test(bone)) return 'shoulder'
  if (/UpperArm$/.test(bone)) return 'upperArm'
  if (/LowerArm$/.test(bone)) return 'lowerArm'
  if (/Hand$/.test(bone)) return 'hand'
  if (/UpperLeg$/.test(bone)) return 'upperLeg'
  if (/LowerLeg$/.test(bone)) return 'lowerLeg'
  if (/Foot$/.test(bone)) return 'foot'
  if (/Toes$/.test(bone)) return 'toes'
  if (/Metacarpal$/.test(bone)) return 'metacarpal'
  if (/Proximal$/.test(bone)) return 'fingerProximal'
  if (/Intermediate$/.test(bone)) return 'fingerIntermediate'
  if (/Distal$/.test(bone)) return 'fingerDistal'
  return 'spine'
}

const sideOf = (bone) => (/^left/i.test(bone) ? '左' : /^right/i.test(bone) ? '右' : '')

/**
 * The arm chain's Z axis points the other way on the right side, so the two directions are
 * named per side instead of swapped: on the left a positive Z lowers the arm, on the right it
 * raises it. Measured, not assumed.
 */
const ARM_Z = {
  left: { shoulder: ['正数沉肩', '负数耸肩'], upperArm: ['正数手臂向下落', '负数向上抬'], lowerArm: ['正数小臂向下摆', '负数向上摆'] },
  right: { shoulder: ['正数耸肩', '负数沉肩'], upperArm: ['正数手臂向上抬', '负数向下落'], lowerArm: ['正数小臂向上摆', '负数向下摆'] },
}

function directionFor(familyName, axis, side) {
  if (axis === 'z' && ARM_Z[side === '右' ? 'right' : 'left']?.[familyName] !== undefined) {
    return ARM_Z[side === '右' ? 'right' : 'left'][familyName]
  }
  return families[familyName][axis]
}

const notes = {}
for (const bone of bones) {
  const familyName = familyOf(bone)
  const family = families[familyName]
  const side = sideOf(bone)
  const pascal = bone.charAt(0).toUpperCase() + bone.slice(1)
  for (const axis of ['x', 'y', 'z']) {
    const [positive, negative] = directionFor(familyName, axis, side)
    const who = side === '' ? '' : `${side}侧：`
    notes[`Bone${pascal}${axis.toUpperCase()}`] = `${who}0=${family.zero}；${positive}，${negative}`
  }
}

const payload = {
  version: 2,
  note: 'VRM 人形骨骼通道的内置含义。骨骼名由规范固定、局部轴由 three-vrm 归一化，所以这套备注对任何 VRM 成立；正负方向经过实测（负 X 前俯、正 X 后仰，右臂 Z 与左侧相反）。模型自己的 params.json 优先。',
  channels: notes,
}
writeFileSync('assets/vrm-channel-defaults.json', `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log('通道默认备注:', Object.keys(notes).length, '条')
