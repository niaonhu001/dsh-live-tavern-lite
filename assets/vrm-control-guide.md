# VRM 控制指南（由实测生成）

这份表来自逐通道测量：把某个通道单独转 15°，看下一节骨骼往哪走、走了多少度。
「扭转轴」表示这条轴不会移动末端，只改变骨骼自身的滚转——想做出可见动作时别用它。

## 单位与坐标系

- 旋转通道的值是**度**，相对静止姿势（T 姿势）。
- `translate` 是**米**，键是骨骼名：`{"hips":[0,-0.46,0]}` 让整个人下沉 0.46 米。
- 舞台相机在 +Z，她面朝 +Z；+Y 向上；+X 是她的**左侧**。
- 屏幕上的 1 个单位 = 1 像素；模型被整体缩放适配窗口，脚本量距离时要除以缩放。

## 通道含义表

左右两侧的通道**符号镜像**：同一个动作，左臂与右臂常取相反的符号。

### 躯干

| 通道 | 正数 15° 的效果 |
| --- | --- |
| BoneHipsX | 下一节骨骼朝向后偏 15° |
| BoneHipsY | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| BoneHipsZ | 下一节骨骼朝向她的左侧偏 15° |
| BoneSpineX | 下一节骨骼朝向后偏 15° |
| BoneSpineY | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| BoneSpineZ | 下一节骨骼朝向她的左侧偏 15° |
| BoneChestX | 下一节骨骼朝向下、向后偏 15° |
| BoneChestY | 下一节骨骼朝向她的右侧偏 2.2° |
| BoneChestZ | 下一节骨骼朝向她的左侧偏 14.8° |

### 头颈

| 通道 | 正数 15° 的效果 |
| --- | --- |
| BoneNeckX | 下一节骨骼朝向后偏 15° |
| BoneNeckY | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| BoneNeckZ | 下一节骨骼朝向她的左侧偏 15° |
| BoneHeadX | 下一节骨骼朝向后偏 12.6° |
| BoneHeadY | 下一节骨骼朝向后偏 8.4° |
| BoneHeadZ | 下一节骨骼朝向下、向她的左侧偏 14.9° |

### 肩与臂

| 通道 | 正数 15° 的效果 |
| --- | --- |
| BoneLeftShoulderX | 下一节骨骼朝向下、向前偏 1.7° |
| BoneRightShoulderX | 下一节骨骼朝向下、向前偏 1.7° |
| BoneLeftShoulderY | 下一节骨骼朝向后偏 14.9° |
| BoneRightShoulderY | 下一节骨骼朝向前偏 14.9° |
| BoneLeftShoulderZ | 下一节骨骼朝向下偏 15° |
| BoneRightShoulderZ | 下一节骨骼朝向上偏 15° |
| BoneLeftUpperArmX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| BoneRightUpperArmX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| BoneLeftUpperArmY | 下一节骨骼朝向后偏 15° |
| BoneRightUpperArmY | 下一节骨骼朝向前偏 15° |
| BoneLeftUpperArmZ | 下一节骨骼朝向下偏 15° |
| BoneRightUpperArmZ | 下一节骨骼朝向上偏 15° |
| BoneLeftLowerArmX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| BoneRightLowerArmX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| BoneLeftLowerArmY | 下一节骨骼朝向后偏 15° |
| BoneRightLowerArmY | 下一节骨骼朝向前偏 15° |
| BoneLeftLowerArmZ | 下一节骨骼朝向下偏 15° |
| BoneRightLowerArmZ | 下一节骨骼朝向上偏 15° |
| BoneLeftHandX | 下一节骨骼朝向上偏 10.1° |
| BoneRightHandX | 下一节骨骼朝向上偏 10.1° |
| BoneLeftHandY | 下一节骨骼朝向后、向她的左侧偏 14.8° |
| BoneRightHandY | 下一节骨骼朝向前、向她的左侧偏 14.8° |
| BoneLeftHandZ | 下一节骨骼朝向下、向她的右侧偏 11.3° |
| BoneRightHandZ | 下一节骨骼朝向上偏 11.3° |

### 手指

| 通道 | 正数 15° 的效果 |
| --- | --- |
| 任一手指的 IndexProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 IndexProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 MiddleProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 MiddleProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 RingProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 RingProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 LittleProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 LittleProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 ThumbProximalX / IntermediateX | 下一节骨骼朝向上偏 8.4° |
| 任一手指的 ThumbProximalX / IntermediateX | 下一节骨骼朝向上偏 8.4° |

### 腿脚

| 通道 | 正数 15° 的效果 |
| --- | --- |
| BoneLeftUpperLegX | 下一节骨骼朝向前偏 15° |
| BoneRightUpperLegX | 下一节骨骼朝向前偏 15° |
| BoneLeftUpperLegY | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| BoneRightUpperLegY | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| BoneLeftUpperLegZ | 下一节骨骼朝向她的右侧偏 15° |
| BoneRightUpperLegZ | 下一节骨骼朝向她的右侧偏 15° |
| BoneLeftLowerLegX | 下一节骨骼朝向前偏 15° |
| BoneRightLowerLegX | 下一节骨骼朝向前偏 15° |
| BoneLeftLowerLegY | 下一节骨骼朝向前、向她的右侧偏 1.9° |
| BoneRightLowerLegY | 下一节骨骼朝向她的右侧偏 1.9° |
| BoneLeftLowerLegZ | 下一节骨骼朝向她的右侧偏 14.9° |
| BoneRightLowerLegZ | 下一节骨骼朝向她的右侧偏 14.9° |
| BoneLeftFootX | 下一节骨骼朝向上、向前偏 15° |
| BoneRightFootX | 下一节骨骼朝向上、向前偏 15° |
| BoneLeftFootY | 下一节骨骼朝向她的左侧偏 12.3° |
| BoneRightFootY | 下一节骨骼朝向她的左侧偏 12.3° |
| BoneLeftFootZ | 下一节骨骼朝向上、向她的右侧偏 8.6° |
| BoneRightFootZ | 下一节骨骼朝向她的右侧偏 8.6° |

## 扭转轴清单（写了没有画面）

共 25 条：BoneHipsY、BoneLeftUpperLegY、BoneRightUpperLegY、BoneSpineY、BoneNeckY、BoneLeftUpperArmX、BoneRightUpperArmX、BoneLeftLowerArmX、BoneRightLowerArmX、BoneLeftIndexProximalX、BoneLeftIndexIntermediateX、BoneLeftMiddleProximalX、BoneLeftMiddleIntermediateX、BoneLeftRingProximalX、BoneLeftRingIntermediateX、BoneLeftLittleProximalX、BoneLeftLittleIntermediateX、BoneRightIndexProximalX、BoneRightIndexIntermediateX、BoneRightMiddleProximalX、BoneRightMiddleIntermediateX、BoneRightRingProximalX、BoneRightRingIntermediateX、BoneRightLittleProximalX、BoneRightLittleIntermediateX

## 怎么拼一个动作

- 躯干前俯用 **负数** SpineX/ChestX；后仰用正数。脖子与头同理：负数低头、正数抬头。
- 抬手：左臂 UpperArmZ 取**负数**、右臂取**正数**；手臂向前挥：左臂 UpperArmY 负数、右臂正数。
- 手指**屈起**用 Z 正数（近节 55 / 中节 65 / 末节 45 大致握拳）；
- 两根手指**张开**用 Y 轴反向（±30 约 3.5 cm、±60 约 7 cm），Z 轴只会让它们前后错开。
- 手掌**翻转**用腕骨 X 轴滚转（180° 翻面且手不动），别用 Z——那会把手甩到袖子后面。
- 想让人**变矮**只能靠 `translate.hips` 负值；纯旋转会让脚离地。
- 蹲下：hips 下沉 0.46–0.62 m + 大腿前抬 60–85° + 屈膝 120–160°，脚离地误差控制在 3 cm 内。
- 腿脚：UpperLegX 正数=大腿**向前**抬；LowerLegX **负数**才是屈膝；脚背压 20–25° 让脚掌贴地。

## 安全范围（来自实测配方）

| 部位 | 常用 | 极限 | 备注 |
| --- | --- | --- | --- |
| 头颈 | 5–15 | 20 | 点头 13、歪头 14 |
| 躯干 | 5–16 | 25 | 前俯分摊到 Hips/Spine/Chest 三节 |
| 肩 | 4–20 | 25 | 耸肩：左 ShoulderZ 负、右正 |
| 上臂 | 20–80 | 100 | 举手 78；挥手 -62 + 小臂 -30 |
| 小臂 | 10–110 | 132 | 折叠超过 132 会穿袖子 |
| 手腕 | 0–12 | 180 | 只有翻转用 180 |
| 手指 | 45–65 | 98 | 握拳三节 55/65/45 |
| 腿 | 25–85 | 85 | 蹲下大腿 85、屈膝 -160 |
| 位移 | -0.46 ~ -0.69 m | -0.69 | 只给 `translate.hips`，负数是下沉 |

## 验收（checks）

配方里可以写几何验收条件，浏览器应用后测量并回报：
- `headHeightRatio`：头顶高度 ÷ 站立高度（0.46 约等于蹲到底）
- `footOnGround`：脚相对静止位置的高度差，建议 ≤ 0.03
- `handToKnee` / `handToHip`：手掌到膝/胯的距离，建议 ≤ 0.08 / ≤ 0.22

## 常见坑

- **透视**：围成圈时若圈面朝镜头，手指是往屏幕里伸，正面几乎看不到位移。把圈面转向侧面再滑入。
- **裙摆**：长裙会盖住腿，蹲下主要靠整体高度和膝盖外开表达。
- **扭转 ≠ 摆动**：表中标「扭转轴」的通道做不出可见动作。
- **左右不通用**：把左臂的数值原样贴给右臂，会变成一只手朝天一只手插地。
- **单位**：舞台缩放约 300 倍，世界坐标不能当米用。
