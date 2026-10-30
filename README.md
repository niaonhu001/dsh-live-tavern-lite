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

## 包文件查找（1.0.4）

角色包里的 `rig.json` / `params.json` / `presets.json` / `memory.json` / `card.json` 都按**同一个包目录**找，而这个目录现在有三种来源：

1. 绝对路径选中的包 → **它自己**（`config.packPath`）
2. `packsRoot/<id>`（含 `model/` 子目录）
3. `modelsRoot/<id>`（旧布局）

1.0.3 之前的 `packFilePath()` 只认后两者，于是「用绝对路径选的包」里那张 `rig.json` 永远读不到，`/config` 会静默回退到插件自带的 11 参数表——表里没有的 `Paramheadxy` 自然也就没有 `fixed: true` 这条规则。现在绝对路径的包同样参与查找，`rig.source` 会如实变成 `model`。

## 安卓端的三个修复（1.0.3）

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 满屏红框盖住界面 | 失败提示被渲染成 `position:fixed`、z-index 极高的层，启动期的瞬时失败也会触发 | 诊断信息只进 `console` 与 `/status`，**不再往页面塞任何浮层** |
| 配置还没到就 `TypeError` | `apply()` 之后立刻有启动尝试，`S.config` 还是 null | 启动入口判空即返回，等配置到达再挂 |
| 一只都看不见 | 引擎用渲染组的世界矩阵乘自身 `groupTransform`；某些 WebView 上两者都不带模型的局部变换，Cubism 拿到单位矩阵，把 -1..1 的顶点当像素画——模型不到 1 像素 | 构建时在**退化矩阵**（a、d 都接近 0）这一明确条件下补一次 `localTransform`，桌面端行为不变 |
| 身高占比拉不动 | 手机视口窄，宽度上限永远先命中，`min(按高度, 按宽度)` 恒等于按宽度 | 手机壳（`capabilities.workbench === false`）改为**身高说了算**，允许两侧裁切 |
| 角色卡里混进 QQ、微信、下载目录 | 绝对包路径把父目录当成了 `packsRoot`，于是把邻居文件夹都当角色包扫 | 绝对路径只代表**它自己**那个文件夹；`packPath` 单独保存，扫描根不再被改写 |

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
├─ worldbook.json      可选 —— 世界书，跨会话模式关闭或带人设模式下注入
├─ rig.json            可选 —— 情绪向量 → 模型参数
├─ params.json         可选 —— 参数工作台写下的备注
├─ presets.json        可选 —— 自定义预设表情
├─ defaults.json       可选 —— 加载后先套用的默认表情
├─ stage.json          可选 —— 这个角色包在舞台上的尺寸
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

卡里的 `{{user}}` 与 `{{char}}` 在进提示词前会被替换。人物卡与世界书在**跨会话模式关闭**、或**跨会话·带人设模式**下注入本会话模型。

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
- **开关型参数（特效、配件、服装）也不要放进来**：表里的每个参数每帧都会被写，会盖掉 `.exp3.json` 表情设下的同一个开关。这类「一直保持」的状态交给 `stage-state.json`。

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

### `stage.json`

这个角色包在舞台上的尺寸，写在包里而不是设置里，换台机器、换浏览器都是同一个大小。浏览器先按布局高度和 `widthCap` 自动适配，再乘上这里的 `scale`。

```json
{ "scale": 0.8 }
```

- `scale` 取 `0.2`–`2`，缺省（没有这个文件）为 `1`，即自动适配后的大小；`0.8` 表示画成适配尺寸的八成。
- 只改这一项，改完刷新页面即可看到，不需要重新打包插件。
- 文件写坏（不是合法 JSON）只会被忽略并回落到 `1`，人物卡和世界书照常加载。

自动适配量的是「真正画出来的那部分」，画布自带的空白边距已经扣掉；`scale` 是在这个结果上再缩放，所以它和设置页的高度、`widthCap` 是乘法关系，三者可以一起用。

### `stage-state.json`

模型自己决定「一直保持」的状态：配件、服装、表情。`live2d_act` 的 `persist` 写这个文件，浏览器每帧回放，刷新、切会话都还在。

```json
{
  "version": 1,
  "params": { "key11": 1, "Clothes1": 0 },
  "expression": "脸红",
  "updatedAt": 1793369000000
}
```

- `params` 是参数 id → 值，写的是模型真实参数（开关类如 `key11` 黑框眼镜、`Clothes1` 长短裙；`1/0` 是开/关）。
- `expression` 是 `.exp3.json` 的表情名，模型声明过才生效。
- 回放顺序：映射表 → 预设 → 工作台 → **这里** → 动画轨道。所以持久状态能压住映射表，但一次 `animation` 仍可短暂覆盖它。
- `persist.clear` 清空；也可以直接删文件。写坏同样是忽略，不会让舞台起不来。
- 谁能写这个文件由**模式**决定：跨会话模式关闭时是会话模型（`live2d_act` 的 `persist`）；跨会话模式开启时是场外模型（它回复 JSON 里的 `persist`）。两个入口写同一份状态，切换模式不会丢。

### `Exp3/*.exp3.json`

模型的 `.model3.json` 必须在 `FileReferences.Expressions` 里列出这些文件，工作台的「默认表情」与 `live2d_act` 的 `expression` 才选得到。大肥鱼公皮原本没有这段（文件在、没人引用），2026-10-30 补齐 23 个；换别的模型时若发现表情列表是空的，先看这里。


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
| `live2d_motion` | 仅 VRM 注册 | 一句动作描述 → 生成一段整段全身动作并播到舞台。走 ARDY 引擎 / HTTP 服务；没有生成服务时可以给内置 `sample`。 |

**按舞台种类收窄的工具面**：宿主判断当前角色包是不是 3D（`stageIsVrm()`：看选中的包里有 `.vrm`，绝对路径包也认，且运行时支持 VRM），结果缓存在一次设置保存之内。挂的是 Live2D 模型时——

- `live2d_motion` **根本不注册**：它产出的 VRMA 只有人形骨架能播，留着只会让模型去调一个必然失败的工具。
- `live2d_act` 的 `recipe` / `body` / `translate` 三个成员连同说明一起不出现（它们分别指骨骼配方、整段动作的英文描述、按骨骼名位移），`params` 的例子换成 `{"ParamAngleZ":12}` 这样的参数 id。
- `live2d_params` 的 `guide` 参数不出现，说明里也不再提骨骼通道；真被问到指南时直接回答「只对 VRM 有效」。
- 场外模型的提示词按种类换一套措辞：Live2D 给的是「可用的参数 id（0 是静止位）」和 `ParamAngleY=8@140` 这种例子，不再拿「单位：度」和 `BoneHeadX` 去描述一套它没有的骨架。

这三个成员与工具说明是**按请求投影**的（工具定义上挂的是 getter，注册表每次组装都会重新读），所以设置页换角色包后保存一次就生效，不用重启宿主；`live2d_motion` 的注册/注销也挂在同一次保存上。

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

- **跨会话模式·关闭**：本会话模型自己调用 `live2d_act`，`animation` 里写参数/骨骼关键帧。
- **跨会话模式 · 不带人设**：本会话模型就是一个普通助手，人物卡与世界书不进它的提示词；`live2d_act` 会被拒绝，由场外模型（`live2d_direct` 的同一套裁判）决定表情与动作；它的回复里也可以带 `animation`，可用的通道来自当前模型（VRM 是骨骼通道，Live2D 是映射表的参数 id），越界的通道会被丢掉。
- **跨会话模式 · 带人设**：人物卡与世界书**同时**进本会话模型的提示词——它按她的人设说话——但气泡台词、表情与动作仍由场外模型生成。场外模型在这一模式下也会拿到人物卡和本回合正在生效的世界书条目，否则那句台词会是「一个无名木偶」说的。

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

### 文字生成动作（ARDY → VRMA）

`live2d_motion` 把一句动作描述变成一段舞台能播的 VRMA：

```
prompt → ARDY（text-to-vrma 引擎，关节序列） → ardyspec.mjs（度 → 四元数） → .vrma → three-vrm-animation 播放
```

三个 provider，在设置里选 `motionProvider`：

| provider | 做什么 | 需要什么 |
| --- | --- | --- |
| `ardy` | `POST /generate` 到 text-to-vrma 的 ARDY 引擎，拿回一份 motion spec（VRM 人骨名 + 局部欧拉角），由 `ardyspec.mjs` 转成 VRMA。**prompt 必须是英文**，引擎的文本编码器读不了中日韩 | 已部署的 ARDY 引擎（默认 `http://127.0.0.1:2337`）。引擎侧建议 `TEXT_ENCODER_DEVICE=cpu`，否则 8B 编码器会占掉约 15GB 显存 |
| `http` | `POST {prompt, duration, seed}` 到一个服务；响应可以是 VRMA 字节、`{url}` 或 `{vrma: base64}` | 一个已经会说这套接口的进程 |
| `sample` | 内置示例动作（`wave` / `bow` / `nod` / `crouch` / `turn` / `dance`），不联网、不加载权重 | 无 |

`ardy` 的两点须知：

- **英文是硬要求**。选了这个 provider 时，`live2d_motion` 的工具说明会要求模型直接用英文写 prompt；真收到中日韩字符，provider 会当场拒绝并说明原因，模型可以在同一轮里改写成英文重试。插件不做自动翻译。
- **没有超时**。ARDY 的 `/generate` 是生成完才回响应头，所以这一条走 `node:http` 而不是 `fetch`（后者默认 5 分钟掐断响应头），一次生成等多久都行，想停自己停。`motionTimeout` 设为 `0` 即不设上限。

生成的片段写进角色包的 `motions/`，和模型文件同一条 `/models/<包>/motions/<文件>` 路由提供，所以浏览器不需要第二个源；`motions/index.json` 记着每段的 prompt、provider、时长与生成时间，重启后还在。

播放由 `@pixiv/three-vrm-animation` 完成：`createVRMAnimationClip(vrma, vrm)` 按人形骨骼名把轨道绑到目标模型的归一化骨骼，所以给这尊模型生成的片段，换一尊 VRM 也照样能播。带片段的帧里没有姿势通道（`params` / `animation` / `translate` 都不会跟着发），身体只由片段说了算——姿势通道和片段各写一遍同一批四元数会抖，那样播完还会跳一下。播完停在片段的最后一帧：骨骼保留最后一次写入的旋转，髋的位移（走位、蹲下的高度）作为身体位移保留下来，直到之后某一帧自己给出身体位移（`translate.hips` 或 `HipsY` 关键帧）才交回去。

没有引擎、也没配服务时，用 `sample` 试通路：

```bash
node scripts/motion.mjs sample:wave out/wave.vrma --duration 2
node scripts/motion.mjs "a person waves with the right hand" out/wave.vrma   # 走设置里的 provider
```

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
| 舞台 | `placement`、`pack`、`playerName`、`textureLod`、`opacity`、`contentAlpha`（内容层透明度 0–100）、`widthCap`、`lookAtPointer`、物理与点击 |
| 气泡 | `bubbleWidth`、`bubbleFontSize`、`bubbleOpacity`（单独一块，带即时预览的示例台词） |
| 跨会话模型 | `rateLimits`（频率限制总开关：关掉后下面几项全部不生效）、`directorMode`（`off` / `hybrid` 不带人设 / `persona` 带人设）、`directorProvider`、`directorModel`、`directorEffort`、`directorMaxTokens`、`directorMaxCallsPerHour`、`directorMaxFacts`、`stageEveryTurns`（哪些轮可以更新）、`stageUpdatesPerTurn`（每轮至少更新几次，是下限不是上限）、`interaction`（点击或拖动触发场外模型）、`memoryScope`（`session` 或 `all`）、`sessionMaxFacts`、`recallScope`（`session` 或 `character`） |
| 动作生成 | `motionProvider`、`motionEndpoint`、`motionDuration`、`motionTimeout`（只对 VRM 舞台显示） |
| 语音 | `ttsProvider`、`ttsApiKey`、`ttsModel`、`ttsVoice`、`ttsRate`、`ttsPitch`、`ttsInstruction`（`ttsBaseUrl` 隐藏） |
| 世界书 | `worldbookBudgetTokens`、`worldbookScanDepth`、`worldbookCooldownRounds`，下面紧接着世界书诊断 |
| 映射表 | `rigMaxTokens` |

### 展示位置：侧栏是「站进那一列」

`placement=sidebar` 时，座位不再是一整屏，而是**切成侧栏那一列的矩形**：`left/top/width/height` 取 `.sidebarCol` 的 `getBoundingClientRect()`，配 `overflow:hidden` 裁边。下游全部跟着宿主盒走——渲染器尺寸、`fitModel` 的身高与宽度上限、点击框、气泡锚点——所以她在侧栏里是「按列缩放、脚踩列底」，不再是站在窗口正中、只是被换了张画布。

列宽是会变的（收起／展开是动画轨道，窗口缩放也会动），所以用一个 `ResizeObserver` 盯住 `[class*="sidebarCol"]`：列一变就重写座位矩形，宿主自己的 observer 再把渲染器 resize 并重新 fit。侧栏收起时列宽为 0，座位跟着变成 0——不会趁收起的时候铺满整个窗口。VRM 舞台同理，`fitVrm` 的量尺也从 `window.innerWidth/Height` 换成了宿主盒。

因为座位画在负 `z-index`（内容后面），侧栏自己的两层实底会挡住她：框架的 `--dsw-alias-bg-base` 与 `sidebarCol`/侧栏根的 `--dsw-specific-sidebar-fill`。所以选侧栏时会自动给 `<html>` 打 `data-dsh-l2d-stage="sidebar"`，只清这两层，**换成别的展示位置就原样还原**；会话列不受影响（它的实底与页面底色同色，清了也看不出来）。这一条不需要打开「内容层透明」——那个开关清的是会话区那一侧。

### 侧栏里的角色选项卡

侧栏位置的座位默认贴在侧栏那列后面，列表和面板会压住她。展示位置选**「侧栏」**时，插件向右侧栏注册一个「角色」页（kind `live-tavern-stage`，实现 id `dsh-live-tavern-lite-stage`），并在右栏的**起始页**放一个「角色」入口：点它才打开，不点她就还是站在侧栏列后面。

打开后选项卡里渲染一块内容区，座位改挂到它上面——矩形取内容区自己的 `getBoundingClientRect()`，`z-index` 从 `-1` 提到 `1`，于是她站进选项卡里，而不是躲在列表和面板后面。

选项卡关掉时座位自动回到侧栏列，换别的展示位置也照旧。同一时间只保留一个（一个 WebGL 画布只能画一个座位，重复打开是聚焦而不是再建一个）。

### 内容层透明度（`contentAlpha`）

舞台在 `chat` / `sidebar` 位置是**画在内容后面**的（座位 `z-index:-1`），所以挡住角色的从来不是模型，而是官方那几块不透明面板：窗口框架自己的 `--dsw-alias-bg-base`、会话列里的列容器，以及输入区停靠座那条「从透明渐变到主题底色」的白纱。

`contentAlpha` 调的是**这些底色的不透明度**，是一个 **0–100 的百分比**：`100` 原样不动；`60` 保留六成底色（会话区看得清、角色从下面透出来）；`0` 才是完全透出。插件给 `<html>` 打 `data-dsh-l2d-clear` 并写 CSS 变量 `--dsh-l2d-clear-alpha`，CSS 用 `color-mix(in srgb, 原色 <alpha>, transparent)` 只压**框架底板与会话区的容器底色**——侧栏、右侧栏、消息气泡、代码块、引用块、输入卡片都保留自己的底，所以文字和导航不会跟着变淡。

`color-mix` 不支持的老内核会忽略整条声明，页面退回原样（不会变成全透明）。旧设置里的 `contentTransparent: true` 读作 `0`、`false` 读作 `100`，老安装不会突然变糊。

框架元素靠 `[data-slot="root"]` 往下找（CSS Modules 的哈希类名（`pI_x6G_frame`）每次发版都会变），找到后打 `data-dsh-l2d-frame`，样式只认这个属性；布局观察器每次 DOM 变动都会补一次标记，所以重开设置面板、切换会话、旋转屏幕都不会把透明度弄丢。

改动**立刻生效**（保存仍在 120ms 后写进设置文件）；回到 100 时把属性、变量和标记一起摘掉，页面回到官方外观。

### 语音（TTS）

**语言**：`ttsLanguage` 是下拉（自动 / 中文 / 英语 / 日语 / 韩语 / 法语 / 德语 / 西语 / 意语 / 葡语 / 俄语 / 阿语 / 泰语 / 印尼语 / 越南语 / 马来语 / 菲律宾语）。选定后有两件事同时发生：① 合成请求带上 `input.language_hints`；② 写台词的模型被要求**先把内容翻译成该语言再填 `line`**——场外模型的提示词里多一句「台词语言：line 必须用 X 写，先翻译再填」，跨会话关闭时 `live2d_act` 的提示段也加了同样一句。选「自动」则不翻译、不传 hint，交给平台按文本判断。试听按钮会按语言挑一句对应的示例（中文/英语/日语/韩语，其余回落到英语）。

**音色与语言的匹配提示**：随包音色表里每个音色都记了它覆盖的语言（`languages`）——例如 `longanhuan_v3.1` 这类多语种音色是 `zh, ja, ko, fr, de, pt, it, vi`，精品中文音色只有 `zh`，而官方表没写覆盖范围的音色记为 `null`。选了语言又选了一个没覆盖该语言的音色时，语音块里会出现一行**提示**（不是错误、不会拦住你）：「提示：X 的音色表只标注了中文，没有英语。照样能念，但可能不太自然」。`null` 的音色不做任何猜测，保持沉默。这行提示在设计上就是软的：它只告诉你哪一边可以换。

**克隆音色**：语音块底部有「克隆音色」——先挑**要绑定到哪个模型**（下拉，默认是当前在用的那个；克隆是绑模型创建的，跨模型不能混用），再选一段 10～20 秒的干净人声（WAV 16-bit / MP3 / M4A，≤60 秒、≤10 MB），起一个只含字母数字的名字（≤10 字符），点按钮即可。平台把音色绑定在**你在克隆区选的那个模型**上（跨模型不能混用），返回的 voice id 会排进「它所属模型」的音色下拉最上面，显示为「克隆 · 你的名字」；如果绑定的模型正是当前在用的那个，会顺手切成默认音色，若不是，则只提示「要用它请把上面的语音模型也切成这个」，不会偷偷改你的模型。克隆列表存在 `~/.dsh/live2d/tts/voices.json`，每行右侧的 ✕ 会同时删除平台上的音色与本地记录。

**谁说了算**：音色是**账号资产**，平台才是权威。面板打开「语音」时会用 `list_voice` 查一次（缓存一分钟，`?refresh=1` 可强制刷新），把在别的机器、甚至控制台里建的克隆也一起列出来；`voices.json` 因此只是**本地缓存**——记住你起的名字、样本路径，并在查询失败时保证旧音色仍然可见（`source: api | local`）。删音色仍按 id 调 `delete_voice`。

**跨模型**：复刻音色在创建时绑定 `target_model`，**不能跨模型使用**——同一族也不行（`cosyvoice-v3.5-plus` 建的音色只能给 `cosyvoice-v3.5-plus` 用）。要让同一个声音在别的模型上也有，就用同一段样本再克隆一次：克隆列表每行有「再克隆」，它读回存好的样本、按「克隆到」下拉里的模型重新建一个（名字会带上模型后缀以示区分）。两边各存一份样本，所以还能继续往第三个模型复制。

**本地留存**：能落在本机的东西有三样——① 音色清单（`tts/voices.json`：id、名字、绑定模型、创建时间）；② 参考录音（`tts/samples/<voiceId>.<wav|mp3|m4a>`，就是当初上传的那段样本，列表里的「样本」可以再下载回来）；③ 每句合成出来的音频（`packs/<角色>/voice/<hash>.wav`，按文本+音色+语言+语速+语气缓存）。音色本身归平台所有、无法下载成模型文件（`query_voice` 会回一个 `resource_link` 指向参考音频，但它依赖平台链接可用）——所以本地留的是「怎么重建它」的凭据：录音 + 清单。删掉音色时样本文件也会一起删除。

相关路由：`GET /tts/voices`（列表与可用模型）、`POST /tts/voices/clone`（body: `{ audio: dataURI, prefix, label, targetModel }`）、`POST /tts/voices/delete`（body: `{ voiceId }`）。底层是平台的 `services/audio/tts/customization` 接口的 `create_voice` / `list_voice` / `delete_voice`。

「语音」这一块是台词念出来的入口：把千问 AI 平台的 API Key 填进 `ttsApiKey`，选好模型与音色，`ttsProvider` 选成 `dashscope` 即可。Key 只写进本机的 `~/.dsh/live2d/settings.json`，`/config` 只回 `hasKey` 与 `keySource`，不会把 Key 本身送进浏览器；环境变量 `DASHSCOPE_API_KEY` 也能用，但设置里填的那个优先级更高。

`ttsModel` 与 `ttsVoice` 不用手打：面板会向宿主要选项——模型列表在有 Key 时实时问平台的 `/compatible-mode/v1/models`（只保留语音类模型），音色来自随包的《Qwen-Audio-TTS 音色列表》（`assets/tts-voices.json`，72 个系统音色，按模型分组，带性别与「支持指令/SSML/时间戳」）。两者都是下拉框：模型列出账号能用的语音模型，音色跟着所选模型换一组；列表末尾有一条「自定义 id…」，选中后换成文本框，复刻音色或表外 id 照样能填。音色表随官方文档更新时跑 `node scripts/build-tts-catalog.mjs` 重新生成即可。

字段含义：`ttsModel` 默认 `qwen-audio-3.1-tts-flash`；`ttsVoice` 默认 `longanhuan_v3.1`。

**语速、音调与语气由写台词的那个模型决定**：场外模型（或跨会话关闭时的本会话模型）在给 `line` 时顺带给出 `speech: { rate, pitch, tone }`——它最清楚这句话该怎么念。`ttsModelControls` 就是这个开关（默认开）；关掉后一律用设置里的 `ttsRate` / `ttsPitch` / `ttsInstruction`。开着时三项设置只是**兜底**：模型没给语速/音调时用它们，语气则依次退回 `ttsInstruction`、再退回按情绪选的一句（`joy` → 轻快带笑意、`sad` → 低落放慢、`anger` → 压着火低声……）。模型给的值会被夹进 0.5–2，不会因为手滑把音调推到 9。

这一块底部有一个 **试听一句** 按钮：它先保存当前表单，再让宿主用**当前设置**合成一句「你好呀，我是屏幕上的那个角色。这句话是刚刚合成出来的。」，成功后显示耗时与音频大小并当场播放，失败则原样给出平台返回的原因（Key 缺失、模型或音色不匹配、额度不足都会写清楚）。合成走 `POST /tts/test`，音频以 data URL 返回，不落盘。

台词现在会真的出声：`ttsProvider` 选成 `dashscope` 后，宿主在发布带台词的帧之前先把这句话合成成 `packs/<角色>/voice/<hash>.wav`（目录跟着模型走，与模型同一条 `/models` 路由提供），再把 `speech.audio` 塞进帧里——浏览器收到帧时气泡与声音同一刻开始，不会一句先到一句后到。

- **同一句只付一次钱**：文件名是「模型 + 音色 + 语速 + 音调 + 语气 + 文本」的哈希，命中即复用。
- **不会为一句台词卡住舞台**：合成最多等 12 秒，超时或失败就照常发气泡（只是没声音），原因写进 console。
- **首次出声需要一次点击**：浏览器的自动播放策略挡下第一次时，会把音频挂起，你的下一次点击自动补播。
- 开关是 `ttsProvider`：`off` 时台词只走气泡；`dashscope` 时才合成为声音。

设置页的每一块都是可折叠的（`<details>`，键盘可用、Ctrl+F 会自动展开命中项）：舞台、动作生成、气泡、跨会话模型、世界书、映射表、位置、参数工作台。折叠状态按块记在 `localStorage`（每个浏览器各记各的），下次打开设置页还是你上次的样子。两个按钮各归各位：**重新加载页面**在「舞台」块底（它重建的是渲染器），**全部归位**在「位置」块底（它只动这一块里的位置、身高与气泡偏移）。

每个浏览器各自的布局（模型与气泡偏移、身高占比）**不在**设置文件里，而是存在 `localStorage`：同一个角色在两个窗口里可以摆得不一样。双击舞台归位。

气泡的**宽度、字号与底色不透明度**属于设置文件，在设置页里单独一块（标题「气泡」，带一条即时预览的示例台词）：`bubbleWidth` 180–720px、`bubbleFontSize` 11–26px、`bubbleOpacity` 0.2–1。同一台机器所有窗口一致，保存后不用刷新——它们只是三个 CSS 变量（`--dsh-l2d-bubble-width/font/alpha`），保存成功时直接改写。不透明度只作用于底色和那个小尖角，台词文字始终不透明，所以调淡了也不会糊。越界值在宿主与浏览器两侧各夹一次。

## 一个回合怎么走

1. 已提交的消息进入该会话的对话摘要与正文记录。
2. **跨会话关闭**：会话模型可以在回合中调 `live2d_act`；人物卡与世界书在它的提示词里。
3. **跨会话开启**：`live2d_act` 拒绝，改由 `live2d_direct` 递交草稿；带人设模式下本会话模型另外拿到人物卡与世界书。每到第 N 轮结束时，场外模型读最近的对话（以及被节奏跳过的那些轮）、相关的事实与摘要，回一个情绪、一个表情、一个动作、一句台词，并可选地记一件事。开启互动模式时，点击或拖动模型也会向它要一次反应。
4. 帧通过 SSE 送到浏览器；台词只出现在气泡里，不会回到对话。浏览器把参数缓动到目标值，并叠加关键帧轨道。

## HTTP 路由

都在 `/dsh-live-tavern-lite` 下：

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/core.js` | GET | Cubism 运行时 |
| `/config` | GET | 模型目录、角色包、映射表、显示设置 |
| `/models` | GET | 模型文件 |
| `/tts/options` | GET | 可用的语音模型（有 Key 时实时查）与各模型的音色列表 |
| `/motion` | GET/POST | 列出／生成一段文字动作（VRM） |
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
