# dsh-live-tavern-lite

给 DeepSeek Harness 的 Web 界面加一个可被模型驱动的 Live2D 角色：她站在舞台上、按情绪做表情、用气泡说话，并且记得对话——愿意的话，记得跨越会话。

一个角色的全部内容装在一个**角色包**里：一个文件夹同时放模型、人物卡、世界书、映射表和记忆。只有模型是必需的，其余缺哪个就关掉哪项能力。

- [安装](#安装)
- [角色包](#角色包)
- [各文件格式](#各文件格式)
- [模型可用的工具](#模型可用的工具)
- [设置项](#设置项)
- [一个回合怎么走](#一个回合怎么走)
- [HTTP 路由](#http-路由)
- [开发](#开发)

## 启动时序（为什么不会把壳卡在启动页）

手机壳的启动探针把「插件激活抛错」判定为启动失败并进降级模式，所以插件的一半在激活阶段**不碰网络**：

| 阶段 | 行为 |
| --- | --- |
| `apply()` | 只注册设置页与样式，立刻返回；启动任务丢进后台 |
| 等宿主 | `/config` 静默重试（约 16 秒）。页签不可见时的中断不计为失败 |
| 模型文件 | 交给加载器之前先自己取一次这个 URL，取不到就等 2 秒重来，而不是报错 |
| 瞬时失败 | `Network error` / `Failed to fetch` / `status 0` 只重试一次，不弹错误层 |
| 真失败 | 重试窗口耗尽后才提示，且只写一行状态，不抛出 |

角色包路径最后一段的空格也会被去掉（`Download/ ailian` → `ailian`），避免「路径看着对、id 差一个空格」这种玄学。

## 角色包路径的校验与选择

**路径必须先证明里面有模型，插件才会上台。** 宿主在挂载前检查包目录：

| 情况 | 结果 |
| --- | --- |
| 路径为空 | 待机，`packProblem.state = "empty"` |
| 目录不存在 | 待机，`state = "missing"`（`/config` 里带 `packProblem.hint`） |
| 目录在、但没有 `.model3.json` / `.vrm` | 待机，`state = "no-model"`——不会硬加载一个空包 |
| 找到模型文件 | 正常上台 |

**选择文件夹**：桌面端用宿主提供的系统对话框；安卓端 WebView 既没有 File System Access API，也没有系统目录对话框，所以设置页内置了一个目录浏览器（`GET /browse`）：只列配置根目录（角色包根、模型根、DSH 主目录、`/sdcard`）下的子文件夹，并给已经含模型的目录打标记；输入框下方还有一行实时状态，直接告诉你「找到模型：xxx.model3.json」或「这个文件夹里没有模型文件」。

## 没有模型时插件是待机状态

角色包路径留空 = 没有配置模型：舞台不会去猜「第一个找到的模型」，页面不挂 canvas、不弹错误提示，工具调用会明确回答没有可用模型。要出角色，就把角色包路径填上（`pack`），或经由设置页选一个。

## 安卓端（DSH for Android）

插件会自己认出安卓：宿主的 `process.platform === 'android'`（Android 上的 Node 报的是这个值，不是 `linux`）。

认出之后，**VRM 相关的功能整体不存在**，而不是「装上了但一按就报错」：

| 位置 | 安卓端行为 |
| --- | --- |
| 模型列表 | VRM 角色包不出现；若设置里还指着某个 VRM 包，回退到第一个可用 Live2D 模型并回报 `vrmDropped` |
| 工具 | `live2d_act` 的 `recipe` 只认 Live2D 侧配方，`double_yeah` / `crouch` 这类 3D 配方不会被解析 |
| 提示词 | 配方表里不列 3D 姿势，模型无从点名 |
| 设置页 | 物理重力、物理强度这两个 spring-bone 开关消失（只跟 three-vrm 有关） |
| 客户端 | 万一页面还带着 VRM 选择，直接给出「当前环境不支持 VRM 舞台」而不是硬建一个 WebGL 场景 |

想在没有 3D 环境的机器上手工关掉，也可以写 `settings.json`：`{"vrmStage": "off"}`（默认 `auto`，即按平台判断）。

移动端还少两样东西，都由同一个平台判断决定：

- **座位只剩两个**：聊天区底部（`chat`）与前景浮层（`foreground`）。桌面配置里存的 `sidebar` 在手机上会被丢弃而不是报错——副栏在手机壳里没有锚点。
- **没有参数工作台**：`/params` 与 `/rig/generate` 在移动端直接返回 404，设置页也不再出现「打开参数工作台」入口。

两点都可以用 `settings.json` 的 `"mobileUi": "on"` 在桌面端强行模拟。

**安装层面**：three / @pixiv/three-vrm 是 `devDependencies`，只在打包时把代码内联进 `lib/client.js`；从 npm 安装本插件**不会**拉取任何 3D 依赖，安卓端也不会有它们的安装记录。

## 安装

插件由两半组成：宿主模块管状态、记忆与路由，浏览器模块负责渲染舞台。

```sh
# 从 npm 安装（发布之后）
dsh plugin --profile web install dsh-live-tavern-lite

# 或直接从 GitHub 安装
dsh plugin --profile web install github:niaonhu001/dsh-live-tavern-lite

# 从本地目录链接（开发时）
dsh plugin --profile web install link:/path/to/dsh-live-tavern-lite
```

`install` 也可以写成 `add` 或 `i`。安装器会克隆仓库、检出这个包、选中它的 bundle；仓库里已经带了构建好的 `lib/client.js`，所以安装方不需要 pnpm、esbuild 或任何运行依赖。

装完重启一次 `dsh web`（宿主模块每个进程只导入一次）。之后浏览器侧的改动刷新页面即可。

## 角色包

```
~/.dsh/live2d/packs/<角色>/
├─ model/              必需 —— Live2D 模型（Cubism 3+）
│  ├─ *.model3.json    入口文件
│  ├─ *.moc3
│  ├─ *.png            纹理
│  ├─ *.exp3.json      表情（可选）
│  ├─ *.motion3.json   动作（可选）
│  └─ *.cdi3.json      参数显示信息（可选，有它才能生成映射表）
├─ card.json           可选 —— 人物卡（SillyTavern v2）
├─ worldbook.json      可选 —— 世界书，跨会话模式关闭时注入
├─ rig.json            可选 —— 情绪向量 → 模型参数
├─ params.json         可选 —— 参数工作台写下的备注
├─ presets.json        可选 —— 自定义预设表情
├─ defaults.json       可选 —— 加载后先套用的默认表情
├─ memory.json         可选 —— 旧的单文件记忆，仍作为基线读取
├─ memory/<会话>.json        每会话的事实与摘要
└─ transcripts/<会话>.json   已提交的对话正文，供 live2d_recall 检索
```

旧布局仍然可用：模型放在 `~/.dsh/live2d/models/<id>/`，或者把包内文件留在模型目录里。没有 `card.json` 也是合法的包——角色名回落到目录名。

入口文件取 `model/` 顶层第一个 `*.model3.json`；纹理、表情与动作都从它的 `FileReferences` 读。

## 各文件格式

### `card.json`

SillyTavern 角色卡 v2，可以包在 `{ "spec": "chara_card_v2", "data": … }` 里，也可以平铺。只读文本字段。

```json
{
  "spec": "chara_card_v2",
  "data": {
    "name": "艾莲·乔",
    "description": "……",
    "personality": "……",
    "scenario": "……",
    "first_mes": "……",
    "mes_example": "……",
    "system_prompt": "",
    "post_history_instructions": "",
    "alternate_greetings": ["……"],
    "tags": ["……"]
  }
}
```

卡里的 `{{user}}` 与 `{{char}}` 在进提示词前会被替换。人物卡与世界书只在**跨会话模式关闭**时注入。

### `worldbook.json`

两种写法都认：`{ "entries": { "0": { … } } }` 或 `{ "entries": [ … ] }`。条目只要求有内容，其余字段有默认值。

```json
{
  "entries": [
    {
      "uid": 1,
      "comment": "海沟",
      "content": "海沟在城东，夜里会起雾。",
      "keys": ["海沟", "城东"],
      "secondary_keys": [],
      "selective": false,
      "constant": false,
      "disable": false,
      "insertion_order": 100,
      "depth": 4
    }
  ]
}
```

注入顺序：扫描最近窗口匹配关键词（`constant` 条目始终生效）→ 分组覆盖 → 插入顺序 → token 预算 → 冷却轮数。预算、扫描深度、冷却都是设置项；诊断面板会说明哪些进了、哪些因为预算或冷却被丢掉。

### `rig.json`

情绪映射表。由参数工作台生成，也可以手写。

```json
{
  "version": 2,
  "params": [
    {
      "id": "ParamAngleZ",
      "role": "歪头",
      "zone": "face",
      "confidence": "verified",
      "base": 0,
      "min": -30,
      "max": 30,
      "weights": { "valence": 0.2, "arousal": -0.4, "dominance": 0 },
      "note": ""
    },
    {
      "id": "Paramheadxy",
      "role": "头部开关",
      "zone": "pose",
      "base": 30,
      "min": 0,
      "max": 30,
      "fixed": true
    }
  ]
}
```

- `zone` 是 `face` 或 `pose`，缺省 `face`。
- `weights` 每个轴 `-1..1`；目标是 `clamp(base + intensity × (v·wV + a·wA + d·wD))`。
- `fixed` 条目不写 `weights`，也永远不动：每帧只写它自己的值。`min === max` 等价于 fixed。
- 模型自己会动的身体参数（重心、呼吸）不要放进这里，改用 `animation` 轨道——映射表的参数每帧都会被写，会把它们冻住。

### `params.json`

参数工作台收集的备注。`verified` 表示用户确认过，映射表生成器没有确认过的备注不跑。

```json
{
  "version": 1,
  "updatedAt": 1760000000000,
  "params": {
    "ParamAngleX": { "note": "头部左右", "verified": true },
    "ParamMouthForm": { "note": "嘴角上扬为正" }
  }
}
```

### `presets.json`

自定义预设表情：给模型一个短 id 代替整串情绪向量。每条预设可以指向模型自己的表情文件，之后这个 id 就能直接填进 `live2d_act` 的 `emotion`。

```json
{
  "version": 1,
  "presets": [
    {
      "id": "smirk",
      "label": "坏笑",
      "expression": "smile",
      "valence": 0.5,
      "arousal": 0.2,
      "dominance": 0.3,
      "intensity": 0.5,
      "line": "",
      "params": { "ParamAngleZ": 12.5, "ParamMouthForm": 0.8 }
    }
  ]
}
```

- `id` 以字母开头，最多 24 位字母、数字、`-` 或 `_`。
- `expression` 必须是模型声明过的名字；留空则只用参数值驱动。
- `params` 是工作台里抓下来的具体参数值：它们盖过情绪映射，而且可以写映射表里根本没有的参数。
- 最多 32 条。id 与内置原型重名时，预设会替换内置那条。

在 **参数工作台 → 预设表情** 里编辑：先拖几个滑块，填个 id，点「把当前参数存为预设」。保存即写这个文件。

### `defaults.json`

加载完成后先套用的姿势，在工作台的 **默认表情** 面板里选：`expression` 是模型声明的表情文件，`emotion` 是情绪原型，两个都可以单独用，也可以同时用。

```json
{ "version": 1, "expression": "", "emotion": "joy" }
```

`emotion` 既可以是内置原型，也可以是 `presets.json` 里自定义的预设 id（下拉里单独分组）。Live2D 的情绪或预设由宿主换算成参数（浏览器请求 `/stage/preview`），VRM 则落到骨骼通道与自带表情。保存后当场生效，下次加载自动套用。

工作台里的拖动与滚轮只移动**这次预览**，不写进设置里的位置与身高——关掉工作台，她回到设置里那个位置。

### `memory.json` 与 `memory/<会话>.json`

每个会话一份记忆。包根的 `memory.json` 是旧文件，仍作为基线读取，老安装不会丢事实。

```json
{
  "version": 2,
  "facts": [
    {
      "text": "玩家在写一个 Live2D 插件",
      "kind": "identity",
      "importance": 4,
      "at": 1760000000000,
      "sessionId": "…",
      "round": 7,
      "reinforced": 2
    }
  ],
  "summaries": [{ "text": "更早的三件事……", "rounds": [1, 2, 3], "at": 1760000000000 }],
  "affinity": 0.08,
  "updatedAt": 1760000000000
}
```

- `kind` 取 `identity` / `promise` / `preference` / `event` / `note`（权重 1.0 … 0.5）。
- `importance` 是 1–5；保留权重 = 重要度 × 种类 × 强化次数。
- 近义写入会合并（提升重要度）；同类矛盾会取代旧条目，并把旧文本记进 `supersedes`。
- 文件装满时，最弱的几条归档进 `summaries`，而不是直接删掉。
- `affinity` 是缓慢阻尼的好感度标量。

### `transcripts/<会话>.json`

已提交的对话正文——事实所指回的那份权威记录。

```json
{
  "version": 1,
  "entries": [{ "role": "user", "text": "你的尾巴在动", "at": 1760000000000 }]
}
```

每会话最多 400 条。只写入已提交的回合：隐藏推理、工具轨迹、未提交的候选都不会进来。

## 模型可用的工具

| 工具 | 模式 | 用途 |
| --- | --- | --- |
| `live2d_act` | 跨会话**关闭** | 一次给全：情绪向量、表情、动作、参数关键帧、一句气泡台词，以及顺手记一件事。跨会话模式开启时会被拒绝。 |
| `live2d_direct` | 跨会话**开启** | 把想法或正文草稿交给场外模型，由它回情绪、表情、动作、台词与记忆。 |
| `live2d_remember` | 两种 | 记一条事实，带种类与重要度。 |
| `live2d_recall` | 两种 | 检索已提交的正文：先给命中目录，再按轮次读原文。 |
| `live2d_params` | 两种 | 按需读取参数/骨骼通道的含义备注（工作台里填的那些）。提示词只给 id，备注不进提示词。 |

`live2d_act` 的 `animation` 参数关键帧：

```
ParamAngleY+=8@140; ParamAngleY+=0@180
```

一次要给一整套姿势时，用 `params` 代替一长串 `animation`：

```json
{ "params": { "BoneHeadZ": 12, "BoneSpineX": 4 }, "easeMs": 600 }
```

键是通道 id，值是目标值（绝对），`easeMs` 控制过渡时长（默认 400ms）。通道多的时候这比逐个写 `id=value@ms` 省 token，也不会写错分隔符；模型没声明的 id 会被丢弃而不是整次失败。有先后顺序的动作仍用 `animation`。

每项是 `参数=目标值@毫秒`。同一参数写多次会接着走，所以点头是一行。`+=` / `-=` 表示偏移——叠在这一帧映射表或模型自己算出的值之上，结束后自然还回去，适合身体参数，因为它不会把那参数钉住。`~linear`、`~smooth`（默认）、`~in`、`~out` 选缓动曲线。

3D（VRM）模型没有 `Param*`，`animation` 改用骨骼通道，单位是度：

```
BoneHeadX=12@160; BoneHeadX=0@200
```

弹簧骨（头发、裙摆、披风）由 three-vrm 的 `vrm.update()` 每帧推进，模型自带的 `stiffness` / `dragForce` / `gravityPower` 原样生效。这尊模型的 `gravityPower` 是 0、`stiffness` 0.93，所以几乎不动——设置里有两个旋钮：**物理强度**（0–5，默认 1=模型自带）放软链条、让它更快响应；**物理重力**（0–20，默认 0）给每个弹簧关节追加下垂力。实测这尊模型的弹簧链很短，单靠重力位移有限，把强度拉到 2–3 再补一点重力最明显。

两处兼容处理，都在加载后自动完成：

1. **MToon 描边**：VRM 0.x 的材质若没声明 `outlineWidth`，转换器仍会生成一个描边材质，它的顶点偏移算出来是 NaN——整块黑片会盖满屏幕。这类没有可用宽度的描边材质会被丢弃（模型真的声明了宽度就保留），`/status` 的 `render.outlinesRemoved` 会报删掉几个。
2. **alpha 镂空**：有些烘焙过的 VRM 0.x 把材质声明成 `OPAQUE`，贴图却带 alpha 通道——浏览器会忠实地忽略 alpha，于是发卡、睫毛那些卡片会画成黑色方块。加载时会为这类材质补一个 `alphaTest = 0.5` 的镂空（`MASK` 按声明的 `alphaCutoff`，`BLEND` 开混合），MToon 材质不动。

可用通道：`BoneHeadX/Y/Z`、`BoneNeckY`、`BoneSpineX/Y/Z`、`BoneChestZ`、`BoneHipsY`、`BoneLeftUpperArmZ`、`BoneRightUpperArmZ`。值是相对静止姿势的偏移，`+=` / `-=` 在此基础上叠加。

### 谁来出动作

- **跨会话模式关闭**：本会话模型自己调用 `live2d_act`，`animation` 里写参数/骨骼关键帧。
- **跨会话模式开启**：`live2d_act` 会被拒绝，由场外模型（`live2d_direct` 的同一套裁判）决定表情与动作；它的回复里也可以带 `animation`，可用的通道来自当前模型（VRM 是骨骼通道，Live2D 是映射表的参数 id），越界的通道会被丢掉。

### BVH → VRMA

把一段 BVH 动作转成标准 VRMA，用：

```bash
node scripts/bvh2vrma.mjs input.bvh output.vrma            # 厘米单位的常规 BVH
node scripts/bvh2vrma.mjs in.bvh out.vrma --metres         # 源数据已是米（MoMask 的 template 就是）
```

它做四件事，和 mumoe 的 `convertBVHToVRMAnimation` 一致：

1. **改名**：BVH 关节名（`LeftUpLeg` / `mixamorig:LeftArm`…）映射到 VRM 人形骨骼名；
2. **单位**：默认认为源是厘米，乘 0.01（`--metres` 关掉）；
3. **根位移**：只保留 `hips` 的位置轨道，并减掉静止偏移；其余关节的位移丢弃；
4. **着地**：骨架最低点低于 0 时整体抬高。

最后用 `GLTFExporter` + 一个写 `VRMC_vrm_animation` 扩展的小插件导出 `.vrma`——**人形映射表就写在这个扩展里**，所以文件不含任何具体模型，任何 VRM 都能播。真正的「套到另一副骨架上」发生在播放时：`@pixiv/three-vrm-animation` 的 `createVRMAnimationClip(vrma, vrm)` 按人形骨骼名把轨道绑到目标模型的归一化骨骼上。

注意它不是 IK 重定向：源骨架的静止姿势与 VRM 的归一化约定不一致时，动作会歪。MoMask 的 template 骨架满足这个约定，所以直接可用。

### VRM 标准了什么，我们加了什么

VRM 规范固定了这些**语义**，所以模型能装进任何 VRM 应用：

- **人形骨骼的名字**（`hips`、`spine`、`head`、`leftUpperArm`…，VRM 0.x 与 1.0 同一套）；
- **表情的预置名**（`happy` / `angry` / `sad` / `relaxed` / `surprised` / `neutral` / 口型 / `blink` / `lookAt`）；
- **lookAt**、**SpringBone**（`stiffness` / `dragForce` / `gravityPower` / `hitRadius`）与 **MToon** 材质参数；
- **VRMA**（`.vrma`）用于人形动画：把动作做成 glTF 动画片段，跨模型通用。

规范**没有**的东西：Live2D 那种「参数 id + 量程 + 语义」的总线。VRM 里没有 `ParamAngleX` 这类名字——动作要么是一段动画片段，要么是直接写骨骼旋转（四元数），而每个轴的含义取决于该骨骼在模型里的静止朝向。

所以我们加了一层适配：`BoneHeadX/Y/Z` 这类通道名是**本插件定义的**，建在 three-vrm 的归一化人形骨架上（旋转是相对 T 姿势的增量），因此同一个通道在不同 VRM 模型上含义一致——`Y` 是沿骨骼的扭转（头就是左右转），`X` / `Z` 是摆动（点头 / 歪头）。表情则始终走规范里的预置名，不自己发明。

### 控制指南（给模型看的）

ssets/vrm-control-guide.md 由实测生成（
ode scripts/build-control-guide.mjs）：坐标系与单位、每个通道正数 15° 的效果、扭转轴清单、手指怎么屈怎么张、下蹲怎么拼、验收阈值、常见坑。

模型不需要读 150 行备注：调用 live2d_params 且 guide: true 就拿到整份指南，提示词里也指向它。

### 通道观察（看每个参数到底做了什么）

```bash
pnpm inspect -- --pack ~/.dsh/live2d/packs/橘雪莉            # 153 条通道全测
pnpm inspect -- --pack <包> --group head --delta 20          # 只看头颈，转 20°
```

它用 headless Chromium 把模型加载起来，从静止姿势出发**逐个通道**旋转固定角度，然后写出：

- `inspect/<包>/report.json`：每条通道的像素变化率 + 头/手/脚/脚尖的位移；
- `inspect/<包>/index.html`：联系表，静止姿势旁边一张张摆出「这条通道动了之后的样子」；
- `inspect/<包>/<通道>.png`：单张截图。

像素变化率能直接筛出「在这个镜头下看不见的通道」（橘雪莉有 98 条，几乎都是手指），位移摘要能看出方向。工具只是观察，不改模型、不写备注——看完再决定写什么。

### 姿势配方

模型不必记住 153 条骨骼 —— `assets/pose-recipes.json` 把「有名字的动作」映射到具体通道：

```json
{ "emotion": "tender", "recipe": "bow" }
```

| id | 意思 |
| --- | --- |
| `nod` / `shake` | 点头 / 摇头（这两条有先后顺序，宿主转成 `animation`） |
| `tilt` | 歪头思考 |
| `lean_in` / `recoil` | 凑近 / 后仰 |
| `shrug` / `wave` | 耸肩 / 挥手 |
| `bow` / `examine` | 鞠躬 / 俯身查看 |
| `arms_crossed` / `hands_up` / `point` | 抱臂 / 举手 / 指向 |

数值按实测轴符号写，大动作拆到多个关节分摊，每个关节都落在该部位的常用范围内。核对的命令是：

```bash
pnpm verify:recipes -- --pack ~/.dsh/live2d/packs/橘雪莉
```

它会为每个配方渲染「全身 + 部位放大」两张图，写成 `inspect/<包>/recipes/index.html` 联系表——前后俯仰类动作（鞠躬、俯身）从正面看不出来，看图请配侧视。

配方只描述语义（`label`、`intent`），数值在文件里，可手改可增删；`params` 与 `recipe` 同给时，`params` 覆盖配方里的同名通道。提示词只列出配方，不列 153 条通道 —— 需要具体通道时，模型用 `live2d_params` 的 `group`（head/torso/arm/leg/finger）按部位取。

### 内置通道含义

`assets/vrm-channel-defaults.json` 存了**每根标准 VRM 骨骼、每个轴**的含义（189 条）。每条都写明三件事：**0 值是什么状态**、正数往哪、负数往哪，例如 `BoneHeadZ`「0=头正立、脸朝前；正数向她的右肩歪头，负数向左肩歪头」。T 姿势是骨架的静止姿态，模型光看通道名猜不出来，所以 0 值必须写进备注。因为骨骼名字是规范固定的、局部轴由 three-vrm 归一化，这套备注对任何 VRM 都成立——换模型时工作台直接以灰字预填，改了就存进该包的 `params.json`，没改不占文件。

优先级：包的 `params.json` > 内置默认。`live2d_params` 返回未改动的通道时会带 `"source": "default"`，模型能分清「标准含义」和「这台机器上的补充」。

重新生成：`node scripts/build-vrm-defaults.mjs`。

想给某个角色包一次性补齐备注（保留手写的那几条），用 `node scripts/calibrate-pack.mjs <角色包目录>`：它读取该包自己的 `.vrm`，只给模型真正声明过、且还没有备注的通道写入默认含义，并先把旧文件备份成 `params.json.bak`。

### 工作台列出哪些参数

- **Live2D**：`cdi3.json` 只是「显示信息」，可以只写作者关心的那几个。工作台会把它的条目与**运行中 Cubism 模型实际声明的参数**取并集，所以模型有的参数不会漏。
- **3D（VRM）**：宿主直接解析 VRM 里的人形骨骼（0.x 与 1.0 都读），每个骨骼的 X/Y/Z 三个轴各给一条通道，眼骨除外——这尊橘雪莉有 51 根骨骼、153 条通道，工作台里全都在。提示词里仍只列精选的十一条，省 token。

### 参数备注按需读取

工作台里填的参数/骨骼通道备注**不进提示词**：提示词只有 id，模型需要知道某个 id 在这尊模型上的确切含义时，调用 `live2d_params`（可带 `filter` 只取相关几条）。这样每轮上下文里只有清单，不会为用不到的备注付 token。

## 设置项

值存在 `~/.dsh/live2d/settings.json`，在 **设置 → Live Tavern** 里改。说明文字悬浮显示，每个字段都有归位按钮。

| 分组 | 键 |
| --- | --- |
| 舞台 | `placement`、`pack`、`playerName`、`textureLod`、`opacity`、`widthCap`、`lookAtPointer` |
| 节奏 | `stageEveryTurns`（哪些轮可以更新）、`stageUpdatesPerTurn`（每轮至少更新几次，是下限不是上限）、`interaction`（点击或拖动触发场外模型） |
| 跨会话 | `director`、`directorProvider`、`directorModel`、`directorEffort`、`directorMaxTokens`、`directorMaxCallsPerHour`、`directorMaxFacts` |
| 记忆 | `memoryScope`（`session` 或 `all`）、`sessionMaxFacts`、`recallScope`（`session` 或 `character`） |
| 世界书 | `worldbookBudgetTokens`、`worldbookScanDepth`、`worldbookCooldownRounds` |
| 映射表 | `rigMaxTokens` |

每个浏览器各自的布局（模型与气泡偏移、身高占比）**不在**设置文件里，而是存在 `localStorage`：同一个角色在两个窗口里可以摆得不一样。双击舞台归位。

## 一个回合怎么走

1. 已提交的消息进入该会话的对话摘要与正文记录。
2. **跨会话关闭**：会话模型可以在回合中调 `live2d_act`；人物卡与世界书在它的提示词里。
3. **跨会话开启**：`live2d_act` 拒绝，改由 `live2d_direct` 递交草稿。每到第 N 轮结束时，场外模型读最近的对话（以及被节奏跳过的那些轮）、相关的事实与摘要，回一个情绪、一个表情、一个动作、一句台词，并可选地记一件事。开启互动模式时，点击或拖动模型也会向它要一次反应。
4. 帧通过 SSE 送到浏览器；台词只出现在气泡里，不会回到对话。浏览器把参数缓动到目标值，并叠加关键帧轨道。

## HTTP 路由

都在 `/dsh-live-tavern-lite` 下：

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/core.js` | GET | Cubism 运行时 |
| `/config` | GET | 模型目录、角色包、映射表、显示设置 |
| `/models` | GET | 模型文件 |
| `/models/catalog` | GET | provider、模型与思考强度 |
| `/settings` | GET/POST | 读取字段与值；校验并保存 |
| `/params` | GET/POST | 参数 id、范围与备注 |
| `/presets` | GET/POST | 自定义预设表情 |
| `/rig/generate` | POST | 生成或更新映射表（`mode: update \| regenerate`） |
| `/worldbook` | GET | 世界书诊断 |
| `/stage` | GET (SSE) | 舞台帧 |
| `/status` | GET/POST | 宿主诊断；浏览器自报 |
| `/interact` | POST | 玩家的一次点击或拖动 |
| `/binding` | GET/POST | 每个模型的表情标定 |
| `/directory` | GET | 目录选择桥接 |

## 开发

### 发布到 npm

```bash
npm login                          # 一次即可
npm run build                      # 重新生成 lib/client.js（发布前会自动再跑）
npm test                           # 117 项
npm publish                        # 首版 1.0.0；开了两步验证就加 --otp=123456
npm version patch && npm publish   # 之后的每次发版
```

`prepublishOnly` 会在打包前跑 `build` 与 `test`；`npm pack --dry-run` 可以先看包里有什么（16 个文件、约 960 kB，其中 `lib/client.js` 4.3 MB）。

```sh
node build.mjs          # 由 src/client.js 构建 lib/client.js
node --test test/*.mjs  # 单元与路由测试
node scripts/probe-routes.mjs   # 用真实配置逐个调用路由
```

`src/client.js` 会被打包成 `lib/client.js`（前面拼上 Cubism 运行时）；其余模块在宿主里作为普通 ESM 运行。纯逻辑模块——`rig.mjs`、`memory.mjs`、`recall.mjs`、`speech.mjs`、`tracks.mjs`、`pack.mjs`——不做 I/O，全部有单元测试。
