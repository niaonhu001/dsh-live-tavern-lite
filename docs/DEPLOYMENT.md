# 部署：音乐、翻唱、运动

这份文档写给**要在这台机器上把三个功能跑起来的人**（或 agent）。它只写验证过的版本、路径与判定条件；每一步都有「怎么算成功」。

三个功能互相独立，可以只装其中一个：

| 功能 | 工具 | 需要什么 | 不装会怎样 |
| --- | --- | --- | --- |
| 运动 | `live2d_motion` | `sample` 零依赖；`ardy` 需要本地 ARDY 引擎 | 没有生成服务时用内置 `sample` |
| 翻唱 | `live2d_sing {mode:"cover"}` | MSST + DDSP + 音色模型 + 混音脚本 | 工具会报「翻唱需要…」 |
| 唱歌 | `live2d_sing {mode:"sing"}` | 翻唱全部依赖 + YuE2 服务 | 工具会报 YuE2 连接失败 |

---

## 0. 先装插件

插件由两半组成：宿主（`lib/index.mjs`，状态、路由、工具）与浏览器（`lib/client.js`，舞台渲染）。仓库里带构建好的 `lib/client.js`，安装方不需要 pnpm 或 esbuild。

```sh
# 本地目录（开发时）
dsh plugin --profile web add link:/path/to/dsh-live-tavern-lite

# 或从仓库安装
dsh plugin --profile web install github:niaonhu001/dsh-live-tavern-lite
```

装完**重启一次** `dsh web`（宿主模块每个进程只导入一次），再**刷新页面**（浏览器模块）。

判定：`GET /dsh-live-tavern-lite/status` 返回 `toolsRegistered: true`，且设置页出现「舞台 / 动作生成 / 气泡 / 语音 / 跨会话模型 / 世界书 / 映射表 / 位置 / 参数工作台」九个可折叠块。

---

## 1. 运动：`live2d_motion`

三选一，设 `motionProvider`：

### 1.1 `sample`（零部署，先验证舞台）

不需要任何外部进程，六个内置动作：`wave` / `bow` / `nod` / `crouch` / `turn` / `dance`。

```sh
node scripts/motion.mjs sample:wave out/wave.vrma --duration 2
```

判定：生成 `out/wave.vrma` 且浏览器能播放。只要这一条通了，就说明舞台、路由、播放都对——引擎问题可以晚点再查。

### 1.2 `ardy`（本地引擎）

插件只负责**调用与转换**：POST `/generate` → 度数转四元数 → 人形骨映射 → 写 `.vrma` → 播放。真正的动作模型不在插件里，必须由外部进程提供。

引擎来自 [Kirakun0328/text-to-vrma](https://github.com/Kirakun0328/text-to-vrma)（底层是 [nv-tlabs/ardy](https://github.com/nv-tlabs/ardy)）。**只需要它的 `tools/ardy-engine/`**，不需要整套应用（Electron 界面、Web 前端、日语翻译、Jev 分析都与 taveren 无关）。

依赖：

- Python 3.10+、git
- 约 **20 GB** 模型下载（ARDY + Llama-3-8B 文本编码器）
- 显存实测约 **1.2 GB**（8B 文本编码器放 CPU，必须 `TEXT_ENCODER_DEVICE=cpu`）
- 内存 16 GB 起，32 GB 更稳
- 端口 **2337**

```sh
git clone https://github.com/Kirakun0328/text-to-vrma
cd text-to-vrma
powershell -ExecutionPolicy Bypass -File tools\ardy-engine\install.ps1

set TEXT_ENCODER_DEVICE=cpu
python tools\ardy-engine\server.py        # 监听 2337

curl http://127.0.0.1:2337/health          # {"status":"ok",...}
```

设置：

| 设置项 | 值 |
| --- | --- |
| `motionProvider` | `ardy` |
| `motionEndpoint` | `http://127.0.0.1:2337`（留空也是这个默认） |
| `motionTimeout` | `0` 表示不设上限（引擎生成完才回响应头） |

判定：

```sh
node scripts/motion.mjs "a person waves with the right hand" out/wave.vrma --provider ardy
```

生成出 `.vrma` 即通。注意 **prompt 必须是英文**：引擎的文本编码器读不了中日韩，插件会当场拒绝并提示改写。

### 1.3 `http`（任意服务）

任何进程，只要 `POST {prompt, duration, seed}` 回以下三者之一：VRMA 字节、`{url}`、`{vrma: base64}`。设 `motionEndpoint` 为它的地址。

判定：同样的 CLI 命令加 `--provider http` 能出 `.vrma`。

---

## 2. 翻唱：`live2d_sing {mode:"cover"}`

链路：源音频 → 44.1 kHz → MSST 分离人声 → 主唱/和声二级分离 → DDSP-SVC 换音色 → 混音 + 五门验收 → mp3。

依赖四项：

### 2.1 MSST（人声分离）

目录里要有：

```
<MSST>/
├─ inference.py
├─ configs/config_vocals_mel_band_roformer_kim.yaml
├─ configs/config_karaoke_frazer_becruily.yaml
├─ pretrain/MelBandRoformer_kim.ckpt
├─ pretrain/bs_roformer_karaoke_frazer_becruily.ckpt
└─ env/python.exe
```

环境实测：**Python 3.10.18、torch 2.8.0+cu128**。两个补丁必须打，否则混音一步会失败：

```sh
<MSST>/env/python.exe -m pip install pyloudnorm "pedalboard>=0.9.26"
```

（旧版 `pedalboard` 没有 `BrickwallLimiter`，`mix.py` 会直接 `ImportError`。）

### 2.2 DDSP-SVC 6.2（换声）

目录里要有：

```
<DDSP>/DDSP-barbara-6.2/
├─ batch_infer.py
├─ pretrain/contentvec/checkpoint_best_legacy_500.pt
├─ pretrain/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02/model.ckpt
├─ pretrain/rmvpe/
└─ env/python.exe
```

环境实测：**Python 3.10.16、torch 2.1.2+cu118、numpy 1.26.4**。`numpy` 必须是 1.x：

```sh
<DDSP>/env/python.exe -m pip install "numpy<2"
```

### 2.3 音色模型

一个 `model_*.pt` 加**同目录**的 `config.yaml`（DDSP-SVC reflow 格式，44.1 kHz）。来源可以是 8 人音色包，也可以是 `dsh-advanced-training` 训出来的模型。

### 2.4 混音脚本

[dsh-cover-pipeline](https://github.com/InariNGT-Ofiicial/dsh-cover-pipeline) 仓库根目录，`runtime/` 下至少这三个：

```
runtime/convert.py
runtime/mix.py
runtime/verify_mix.py
```

### 2.5 通用

- `ffmpeg`（要带 `ffprobe`、`libx264`；NVENC 可选）
- 显存约 2–3 GB
- 每首歌 100–300 MB 中间文件；**工作目录不要放快满的盘**
- 同一时间只跑一首

### 2.6 设置项

| 设置项 | 指向 |
| --- | --- |
| `songEnabled` | 开启 |
| `songVoiceModel` | `model_*.pt` 绝对路径 |
| `songWorkRoot` | 歌曲工作目录 |
| `songMsstDir` / `songMsstEnv` | 2.1 的目录与 python |
| `songDdspDir` / `songDdspEnv` | 2.2 的工程目录与 python |
| `songFFmpeg` | ffmpeg.exe |
| `songPipelineDir` | cover-pipeline 仓库根 |

判定（25 秒源，整链约 2 分钟）：

```
live2d_sing {mode:"cover", src:"D:/test/song.wav", key:0}
```

`GET /song/status?id=…` 最终 `status:"done"`，`result.verified:true`，`result.audio` 能在舞台上播放。

---

## 3. 唱歌：`live2d_sing {mode:"sing"}`

唱歌 = **YuE2 作曲演唱** + 翻唱那套后半段（分离→换声→混音）。所以第 2 节必须全部就绪。

### 3.1 YuE2 整合包

整合包来自 **B 站 UP 主「余子越Talk」**（启动器 `YZY启动器-YuE2-261011.exe`，随包说明文档：<https://yuziyuetalk.feishu.cn/docx/Ml9RdeXsyoANFnxo77NcxyU0nbh>）。整合包与模型版权归原作者，本插件只调用它的本地接口，不随包分发。

结构：Gradio 前端（:9000）+ ComfyUI 后端（:8188）+ `models/checkpoints/yue2_3b_int8_convrot.safetensors`（int8 3B，8 GB 显存可跑）。

```sh
cd <YuE2>/app
.\build_venv\python.exe webui.py        # 或直接开 YZY启动器
```

判定：

```sh
curl http://127.0.0.1:9000/                  # 200
curl http://127.0.0.1:8188/system_stats      # 200
```

设置：`songYuE2Url` = `http://127.0.0.1:9000`。

### 3.2 显存纪律

YuE2 生成完仍会占着显存。8 GB 卡上换声可能 OOM，所以：

- 插件**串行**执行：YuE2 出歌之后才启动换声；
- 如果仍 OOM，在两次之间释放一次：

```sh
curl -X POST http://127.0.0.1:8188/free -H "content-type: application/json" \
     -d "{\"unload_models\":true,\"free_memory\":true}"
```

判定：一首 30–60 行的歌词（约 1–3 分钟）能完整跑完，`result.verified:true`。

---

## 4. Agent 部署清单

按顺序做，每一步都有判定；失败就停在这一步，不要跳。

1. **读环境**：`dsh plugin --profile web list` 里有本插件；`GET /dsh-live-tavern-lite/status` → `toolsRegistered:true`。
2. **运动通路**：`node scripts/motion.mjs sample:wave out/wave.vrma` 能出文件、舞台能播。通了再考虑引擎。
3. **翻唱依赖**：逐项确认 2.1–2.4 的文件存在；`pip show pedalboard` ≥ 0.9.26；DDSP env 的 `numpy` < 2。
4. **翻唱冒烟**：用 25 秒音频跑 `live2d_sing {mode:"cover"}`，看 `status:done` + `verified:true`。
5. **YuE2**：`:9000` 与 `:8188` 都 200；再用 8 行歌词跑一首短歌。
6. **长歌**：30–60 行歌词，确认时长与验收；记录耗时。
7. **汇报**：把实际路径、版本号、每步耗时写回配置或文档，不要凭记忆。

### 失败对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `unknown setting 'song...'` | 宿主是旧版本 | 重启 `dsh web`，确认版本 ≥ 1.2.0 |
| `YuE2 提交失败：HTTP 000` | 服务没开 / 端口不对 | 先起 webui，`curl :9000` |
| 换声阶段 `CUDA out of memory` | YuE2 还占着卡 | `POST :8188/free`，或先关 YuE2 |
| `ImportError: BrickwallLimiter` | pedalboard 太旧 | `pip install "pedalboard>=0.9.26"` |
| `Numba needs NumPy 2.0 or less` | DDSP env 的 numpy 被升到 2.x | `pip install "numpy<2"` |
| `tracks must be 44.1kHz … aligned` | 三轨长度/采样率不一致 | 用同一次分离产物，别混不同窗口 |
| `ARDY 只接受英文 prompt` | prompt 里有中日韩字符 | 改写成英文再调 |
| `/health` 一直不 ok | 模型还在加载（约 20 GB） | 等；`/progress` 看进度 |

### 不要做

- 不要同时跑 YuE2 与 DDSP（一张 8 GB 卡放不下两份）。
- 不要把音色模型、音频、整合包提交进 git。
- 不要把工作目录设在快满的盘（本项目机器上 D: 只剩约 11 GB）。
- 不要用 `sample` 之外的方式在没有引擎时硬试 `ardy`：会等到超时。
