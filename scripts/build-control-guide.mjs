/**
 * Build the control guide the model reads from the measured channel table.
 *
 * Every row is copied from `inspect/<pack>/channel-meanings.json`, so the guide cannot drift
 * from what the model actually does: the wording is the measured motion, not a guess.
 *
 * Sided bones (shoulder/upperArm/lowerArm/hand/upperLeg/lowerLeg/foot/toes) are emitted once
 * per side: `BoneLeftUpperArmZ` and `BoneRightUpperArmZ` are not the same channel — the sign is
 * mirrored for the right arm. Emitting a bare `BoneShoulderX` looked up nothing and dropped the
 * whole 肩与臂 / 腿脚 table from the guide.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const meaningFile = join(PACKAGE_ROOT, 'inspect', '橘雪莉', 'channel-meanings.json')

const meanings = JSON.parse(readFileSync(meaningFile, 'utf8'))
const channels = new Map(meanings.channels.map(entry => [entry.channel, entry]))

const SIDED = new Set(['shoulder', 'upperArm', 'lowerArm', 'hand', 'upperLeg', 'lowerLeg', 'foot', 'toes'])
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
      if (SIDED.has(name)) {
        // One row per side: the two channels are mirrored, not interchangeable.
        for (const side of ['left', 'right']) {
          const id = axisId(side + pascal(name), axis)
          const entry = channels.get(id)
          if (entry !== undefined) rows.push([id, entry])
        }
      } else {
        const id = axisId(name, axis)
        const entry = channels.get(id)
        if (entry !== undefined) rows.push([id, entry])
      }
    } else {
      // One representative per finger; all four joints share the same axes.
      for (const side of ['left', 'right']) {
        const id = axisId(`${side}${pascal(name)}Proximal`, axis)
        const entry = channels.get(id)
        if (entry !== undefined) rows.push([`任一手指的 ${pascal(name)}Proximal${axis.toUpperCase()} / Intermediate${axis.toUpperCase()}`, entry])
      }
      break
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
lines.push('左右两侧的通道**符号镜像**：同一个动作，左臂与右臂常取相反的符号。', '')

for (const [label, names] of FAMILIES) {
  lines.push(`### ${label}`, '')
  lines.push('| 通道 | 正数 15° 的效果 |', '| --- | --- |')
  const isFinger = label === '手指'
  for (const name of names) {
    for (const [id, entry] of rowsFor(isFinger ? 'family' : 'exact', name)) {
      lines.push(`| ${id} | ${describe(entry)} |`)
    }
  }
  lines.push('')
}

const dead = meanings.channels.filter(entry => entry.dead).map(entry => entry.channel)
lines.push('## 扭转轴清单（写了没有画面）', '')
lines.push(`共 ${dead.length} 条：${dead.join('、')}`, '')
lines.push('## 怎么拼一个动作', '')
lines.push('- 躯干前俯用 **负数** SpineX/ChestX；后仰用正数。脖子与头同理：负数低头、正数抬头。')
lines.push('- 抬手：左臂 UpperArmZ 取**负数**、右臂取**正数**；手臂向前挥：左臂 UpperArmY 负数、右臂正数。')
lines.push('- 手指**屈起**用 Z 正数（近节 55 / 中节 65 / 末节 45 大致握拳）；')
lines.push('- 两根手指**张开**用 Y 轴反向（±30 约 3.5 cm、±60 约 7 cm），Z 轴只会让它们前后错开。')
lines.push('- 手掌**翻转**用腕骨 X 轴滚转（180° 翻面且手不动），别用 Z——那会把手甩到袖子后面。')
lines.push('- 想让人**变矮**只能靠 `translate.hips` 负值；纯旋转会让脚离地。')
lines.push('- 蹲下：hips 下沉 0.46–0.62 m + 大腿前抬 60–85° + 屈膝 120–160°，脚离地误差控制在 3 cm 内。')
lines.push('- 腿脚：UpperLegX 正数=大腿**向前**抬；LowerLegX **负数**才是屈膝；脚背压 20–25° 让脚掌贴地。', '')
lines.push('## 安全范围（来自实测配方）', '')
lines.push('| 部位 | 常用 | 极限 | 备注 |', '| --- | --- | --- | --- |')
lines.push('| 头颈 | 5–15 | 20 | 点头 13、歪头 14 |')
lines.push('| 躯干 | 5–16 | 25 | 前俯分摊到 Hips/Spine/Chest 三节 |')
lines.push('| 肩 | 4–20 | 25 | 耸肩：左 ShoulderZ 负、右正 |')
lines.push('| 上臂 | 20–80 | 100 | 举手 78；挥手 -62 + 小臂 -30 |')
lines.push('| 小臂 | 10–110 | 132 | 折叠超过 132 会穿袖子 |')
lines.push('| 手腕 | 0–12 | 180 | 只有翻转用 180 |')
lines.push('| 手指 | 45–65 | 98 | 握拳三节 55/65/45 |')
lines.push('| 腿 | 25–85 | 85 | 蹲下大腿 85、屈膝 -160 |')
lines.push('| 位移 | -0.46 ~ -0.69 m | -0.69 | 只给 `translate.hips`，负数是下沉 |', '')
lines.push('## 验收（checks）', '')
lines.push('配方里可以写几何验收条件，浏览器应用后测量并回报：')
lines.push('- `headHeightRatio`：头顶高度 ÷ 站立高度（0.46 约等于蹲到底）')
lines.push('- `footOnGround`：脚相对静止位置的高度差，建议 ≤ 0.03')
lines.push('- `handToKnee` / `handToHip`：手掌到膝/胯的距离，建议 ≤ 0.08 / ≤ 0.22', '')
lines.push('## 常见坑', '')
lines.push('- **透视**：围成圈时若圈面朝镜头，手指是往屏幕里伸，正面几乎看不到位移。把圈面转向侧面再滑入。')
lines.push('- **裙摆**：长裙会盖住腿，蹲下主要靠整体高度和膝盖外开表达。')
lines.push('- **扭转 ≠ 摆动**：表中标「扭转轴」的通道做不出可见动作。')
lines.push('- **左右不通用**：把左臂的数值原样贴给右臂，会变成一只手朝天一只手插地。')
lines.push('- **单位**：舞台缩放约 300 倍，世界坐标不能当米用。')

const out = join(PACKAGE_ROOT, 'assets', 'vrm-control-guide.md')
writeFileSync(out, `${lines.join('\n')}\n`, 'utf8')
console.log('guide written:', out, lines.length, 'lines', 'dead:', dead.length)
