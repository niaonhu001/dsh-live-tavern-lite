# VRM 控制指南（由实测生成）

这份表来自逐通道测量：把某个通道单独转 15°，看下一节骨骼往哪走、走了多少度。
「扭转轴」表示这条轴不会移动末端，只改变骨骼自身的滚转——想做出可见动作时别用它。

## 单位与坐标系

- 旋转通道的值是**度**，相对静止姿势（T 姿势）。
- `translate` 是**米**，键是骨骼名：`{"hips":[0,-0.46,0]}` 让整个人下沉 0.46 米。
- 舞台相机在 +Z，她面朝 +Z；+Y 向上；+X 是她的**左侧**。
- 屏幕上的 1 个单位 = 1 像素；模型被整体缩放适配窗口，脚本量距离时要除以缩放。

## 通道含义表

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

### 手指

| 通道 | 正数 15° 的效果 |
| --- | --- |
| 任一手指的 IndexProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 IndexProximalY / IntermediateY | 下一节骨骼朝向后偏 15° |
| 任一手指的 IndexProximalZ / IntermediateZ | 下一节骨骼朝向下偏 15° |
| 任一手指的 MiddleProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 MiddleProximalY / IntermediateY | 下一节骨骼朝向后偏 15° |
| 任一手指的 MiddleProximalZ / IntermediateZ | 下一节骨骼朝向下偏 15° |
| 任一手指的 RingProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 RingProximalY / IntermediateY | 下一节骨骼朝向后偏 15° |
| 任一手指的 RingProximalZ / IntermediateZ | 下一节骨骼朝向下偏 15° |
| 任一手指的 LittleProximalX / IntermediateX | 扭转轴：只改这节骨骼自身的滚转，末端几乎不移动 |
| 任一手指的 LittleProximalY / IntermediateY | 下一节骨骼朝向后偏 15° |
| 任一手指的 LittleProximalZ / IntermediateZ | 下一节骨骼朝向下偏 15° |
| 任一手指的 ThumbProximalX / IntermediateX | 下一节骨骼朝向上偏 8.4° |
| 任一手指的 ThumbProximalY / IntermediateY | 下一节骨骼朝向后、向她的左侧偏 14.9° |
| 任一手指的 ThumbProximalZ / IntermediateZ | 下一节骨骼朝向下偏 12.5° |

### 腿脚

| 通道 | 正数 15° 的效果 |
| --- | --- |

## 怎么拼一个动作

- 躯干前俯用 **负数** SpineX/ChestX；后仰用正数。脖子与头同理：负数低头、正数抬头。
- 抬手：左臂 UpperArmZ 取**负数**、右臂取**正数**；手臂向前挥：左臂 UpperArmY 负数、右臂正数。
- 手指**屈起**用 Z 正数（近节 55 / 中节 65 / 末节 45 大致握拳）；
- 两根手指**张开**用 Y 轴反向（±30 约 3.5 cm、±60 约 7 cm），Z 轴只会让它们前后错开。
- 手掌**翻转**用腕骨 X 轴滚转（180° 翻面且手不动），别用 Z——那会把手甩到袖子后面。
- 想让人**变矮**只能靠 `translate.hips` 负值；纯旋转会让脚离地。
- 蹲下：hips 下沉 0.46–0.62 m + 大腿前抬 60–85° + 屈膝 120–160°，脚离地误差控制在 3 cm 内。

## 验收（checks）

配方里可以写几何验收条件，浏览器应用后测量并回报：
- `headHeightRatio`：头顶高度 ÷ 站立高度（0.46 约等于蹲到底）
- `footOnGround`：脚相对静止位置的高度差，建议 ≤ 0.03
- `handToKnee` / `handToHip`：手掌到膝/胯的距离，建议 ≤ 0.08 / ≤ 0.22

## 常见坑

- **透视**：围成圈时若圈面朝镜头，手指是往屏幕里伸，正面几乎看不到位移。把圈面转向侧面再滑入。
- **裙摆**：长裙会盖住腿，蹲下主要靠整体高度和膝盖外开表达。
- **扭转 ≠ 摆动**：表中标「扭转轴」的通道做不出可见动作。
- **单位**：舞台缩放约 300 倍，世界坐标不能当米用。
