/**
 * Build the control guide LLM reads from the measured channel table.
 *
 * Every row is copied from `inspect/<pack>/channel-meanings.json`, so the guide cannot drift
 * from what the model actually does: the wording is the measured motion, not a guess.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const meanings = JSON.parse(readFileSync('inspect/橘雪莉/channel-meanings.json', 'utf8'))
const channels = new Map(meanings.channels.map(entry => [entry.channel, entry]))

const FAMILIES = [
  ['躯干', ['hips', 'spine', 'chest', 'upperChest']],
  ['头颈', ['neck', 'head', 'jaw']],
  ['肩与臂', ['shoulder', 'upperArm', 'lowerArm', 'hand']],
  ['手指', ['index', 'middle', 'ring', 'little', 'thumb']],
  ['腿脚', ['upperLeg', 'lowerLeg', 'foot', 'toes']],
]

const pascal = (bone) => bone.charAt(0).toUpperCase() + bone.slice(1)
const axisId = (bone, axis) => `Bone${pascal(bone)}${axis.toUpperCase()}`

function rowsFor(kind, name) {
  const rows = []
  for (const axis of ['x', 'y', 'z']) {
    if (kind === 'exact') {
      const entry = channels.get(axisId(name, axis))
      if (entry !== undefined) rows.push([axis.toUpperCase(), entry])
    } else {
      // One representative per finger, all four joints share the same axes.
      const entry = channels.get(axisId(`left${pascal(name)}Proximal`, axis))
      if (entry !== undefined) rows.push([axis.toUpperCase(), entry])
    }
  }
  return rows
}

function describe(entry) {
  if (entry === undefined) return '（未测到）'
  if (entry.dead) return '扭转轴：只改这节骨骼自身的滚转，末端几乎不移动'
  return `下一节骨骼朝${entry.at15.words}偏 ${entry.at15.angle}°`
}

const lines = []
lines.push('# VRM 控制指南（由实测生成）', '')
lines.push('这份表来自逐通道测量：把某个通道单独转 15°，看下一节骨骼往哪走、走了多少度。')
lines.push('「扭转轴」表示这条轴不会移动末端，只改变骨骼自身的滚转——想做出可见动作时别用它。', '')
lines.push('## 单位与坐标系', '')
lines.push('- 旋转通道的值是**度**，相对静止姿势（T 姿势）。')
lines.push('- `translate` 是**米**，键是骨骼名：`{"hips":[0,-0.46,0]}` 让整个人下沉 0.46 米。')
lines.push('- 舞台相机在 +Z，她面朝 +Z；+Y 向上；+X 是她的**左侧**。')
lines.push('- 屏幕上的 1 个单位 = 1 像素；模型被整体缩放适配窗口，脚本量距离时要除以缩放。', '')
lines.push('## 通道含义表', '')

for (const [label, names] of FAMILIES) {
  lines.push(`### ${label}`, '')
  lines.push('| 通道 | 正数 15° 的效果 |', '| --- | --- |')
  if (label === '手指') {
    for (const name of names) {
      for (const [axis, entry] of rowsFor('family', name)) {
        lines.push(`| 任一手指的 ${pascal(name)}Proximal${axis} / Intermediate${axis} | ${describe(entry)} |`)
      }
    }
  } else {
    for (const name of names) {
      for (const [axis, entry] of rowsFor('exact', name)) {
        lines.push(`| ${axisId(name, axis)} | ${describe(entry)} |`)
      }
    }
  }
  lines.push('')
}

lines.push('## 怎么拼一个动作', '')
lines.push('- 躯干前俯用 **负数** SpineX/ChestX；后仰用正数。脖子与头同理：负数低头、正数抬头。')
lines.push('- 抬手：左臂 UpperArmZ 取**负数**、右臂取**正数**；手臂向前挥：左臂 UpperArmY 负数、右臂正数。')
lines.push('- 手指**屈起**用 Z 正数（近节 55 / 中节 65 / 末节 45 大致握拳）；')
lines.push('- 两根手指**张开**用 Y 轴反向（±30 约 3.5 cm、±60 约 7 cm），Z 轴只会让它们前后错开。')
lines.push('- 手掌**翻转**用腕骨 X 轴滚转（180° 翻面且手不动），别用 Z——那会把手甩到袖子后面。')
lines.push('- 想让人**变矮**只能靠 `translate.hips` 负值；纯旋转会让脚离地。')
lines.push('- 蹲下：hips 下沉 0.46–0.62 m + 大腿前抬 60–85° + 屈膝 120–160°，脚离地误差控制在 3 cm 内。', '')
lines.push('## 验收（checks）', '')
lines.push('配方里可以写几何验收条件，浏览器应用后测量并回报：')
lines.push('- `headHeightRatio`：头顶高度 ÷ 站立高度（0.46 约等于蹲到底）')
lines.push('- `footOnGround`：脚相对静止位置的高度差，建议 ≤ 0.03')
lines.push('- `handToKnee` / `handToHip`：手掌到膝/胯的距离，建议 ≤ 0.08 / ≤ 0.22')
lines.push('')
lines.push('## 常见坑', '')
lines.push('- **透视**：围成圈时若圈面朝镜头，手指是往屏幕里伸，正面几乎看不到位移。把圈面转向侧面再滑入。')
lines.push('- **裙摆**：长裙会盖住腿，蹲下主要靠整体高度和膝盖外开表达。')
lines.push('- **扭转 ≠ 摆动**：表中标「扭转轴」的通道做不出可见动作。')
lines.push('- **单位**：舞台缩放约 300 倍，世界坐标不能当米用。')

writeFileSync('assets/vrm-control-guide.md', `${lines.join('\n')}\n`, 'utf8')
console.log('guide written:', lines.length, 'lines')
