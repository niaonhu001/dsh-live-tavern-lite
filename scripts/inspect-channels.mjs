/**
 * Measure what every bone channel does to a VRM, and paint the result into a gallery.
 *
 * For each declared humanoid bone and each axis it rotates the channel by a fixed angle in a
 * headless browser, records where the head, hands, feet and toes went, and how much of the
 * frame changed. The output is a directory with one image per channel plus a report:
 *
 *   inspect/<pack>/report.json    metrics per channel, including a plain-language verdict
 *   inspect/<pack>/index.html     contact sheet: rest pose next to each channel's pose
 *   inspect/<pack>/<channel>.png  the posed frame
 *
 * Usage:
 *   node scripts/inspect-channels.mjs --pack ~/.dsh/live2d/packs/<name> [--delta 15] [--group head]
 *
 * Playwright is only needed for this tool; it is looked up in the DSH checkout's node_modules.
 */
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** Parse `--name value` / `--flag` pairs. */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[name] = true
    else {
      out[name] = next
      index += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const delta = Number(args.delta ?? 15)
const group = typeof args.group === 'string' ? args.group : ''
const pack = args.pack === undefined
  ? undefined
  : resolve(String(args.pack).replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? ''))

if (pack === undefined || !existsSync(pack)) {
  console.error('usage: node scripts/inspect-channels.mjs --pack <角色包目录> [--delta 15] [--group head]')
  process.exit(1)
}

/** The pack's `.vrm`, or undefined. */
async function modelFile(directory) {
  const entries = await readdir(directory)
  const name = entries.find(entry => entry.toLowerCase().endsWith('.vrm'))
  return name === undefined ? undefined : join(directory, name)
}
const model = await modelFile(pack)
if (model === undefined) {
  console.error(`${pack} 里没有 .vrm`)
  process.exit(1)
}

const outDir = resolve(String(args.out ?? join(root, 'inspect', basename(pack))))
await mkdir(outDir, { recursive: true })

/** Bundle the browser half, so the tool runs from the package as installed. */
const esbuild = createRequire(import.meta.url)('esbuild')
const bundlePath = join(tmpdir(), `dsh-live-tavern-inspect-${process.pid}.js`)
esbuild.buildSync({
  entryPoints: [join(here, 'inspect-page.mjs')],
  bundle: true,
  format: 'esm',
  outfile: bundlePath,
  absWorkingDir: root,
  nodePaths: [join(root, 'node_modules')],
  logLevel: 'warning',
})

/** Playwright lives in the DSH checkout, not in this package. */
function loadPlaywright() {
  const candidates = [
    process.env.DSH_CHECKOUT === undefined ? undefined : join(process.env.DSH_CHECKOUT, 'apps/web/package.json'),
    'E:/program/deepseek-harness/apps/web/package.json',
    join(process.cwd(), 'apps/web/package.json'),
  ].filter(candidate => candidate !== undefined)
  for (const candidate of candidates) {
    try {
      return createRequire(candidate)('playwright')
    } catch {
      continue
    }
  }
  return undefined
}
const playwright = loadPlaywright()
if (playwright === undefined) {
  console.error('找不到 playwright：这个工具需要一个装了 playwright 的 DSH 检出（可用 DSH_CHECKOUT 指定）')
  process.exit(1)
}

const page = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#f4efe9}canvas{display:block;width:100vw;height:100vh}</style>
<canvas id="c"></canvas><script type="module" src="/inspect.js"></script>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page)
      return
    }
    if (url.pathname === '/inspect.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(await readFile(bundlePath))
      return
    }
    if (url.pathname === '/model.vrm') {
      const body = await readFile(model)
      res.writeHead(200, { 'content-type': 'model/gltf-binary', 'content-length': body.length })
      res.end(body)
      return
    }
    res.writeHead(404).end('no')
  } catch (error) {
    res.writeHead(500).end(String(error))
  }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const port = server.address().port

const executable = process.env.CHROME_PATH
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await playwright.chromium.launch({
  ...(existsSync(executable) ? { executablePath: executable } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const context = await browser.newContext({ viewport: { width: 480, height: 640 } })
const tab = await context.newPage()
const logs = []
tab.on('pageerror', error => logs.push(`pageerror: ${error.message}`))
tab.on('console', message => logs.push(`${message.type()}: ${message.text()}`))
await tab.goto(`http://127.0.0.1:${port}/`)
try {
  await tab.waitForFunction(() => window.__probe !== undefined, { timeout: 60000 })
} catch {
  console.error('页面没有就绪：', JSON.stringify(logs.slice(0, 5)))
  await browser.close()
  server.close()
  process.exit(1)
}

// The humanoid bone list comes from the page: it is whatever the model declares.
const declared = await tab.evaluate(() => window.__setup?.channels ?? [])

const groups = {
  head: /^(head|neck|jaw|leftEye|rightEye)$/,
  torso: /^(hips|spine|chest|upperChest)$/,
  arm: /(Shoulder|UpperArm|LowerArm|Hand$|Thumb|Index|Middle|Ring|Little)/,
  leg: /(UpperLeg|LowerLeg|Foot$|Toes$)/,
}

const wanted = declared
  .filter(name => !/eye/i.test(name))
  .filter(name => group === '' || (groups[group] === undefined ? true : groups[group].test(name)))
  .sort()

/** Which zoom group a bone belongs to. */
function zoomGroupOf(bone) {
  // Under the stage camera everything is measured at the size the player actually sees.
  if (process.env.STAGE_ONLY === '1') return 'all'
  if (/^(head|neck|jaw)$/i.test(bone)) return 'head'
  if (/^(hips|spine|chest|upperChest)$/i.test(bone)) return 'torso'
  if (/thumb|index|middle|ring|little/i.test(bone)) return 'finger'
  if (/hand$/i.test(bone)) return 'hand'
  if (/shoulder|upperArm|lowerArm/i.test(bone)) return 'arm'
  if (/upperLeg|lowerLeg|foot|toes/i.test(bone)) return 'leg'
  return 'all'
}

/** Bone family, which decides the vocabulary of the generated note. */
const FAMILY_OF = (bone) => {
  if (/^(head|neck|jaw)$/i.test(bone)) return 'head'
  if (/^(hips|spine|chest|upperChest)$/i.test(bone)) return 'torso'
  if (/shoulder$/i.test(bone)) return 'shoulder'
  if (/upperArm$/i.test(bone)) return 'upperArm'
  if (/lowerArm$/i.test(bone)) return 'lowerArm'
  if (/hand$/i.test(bone)) return 'hand'
  if (/thumb|index|middle|ring|little/i.test(bone)) return 'finger'
  if (/upperLeg$/i.test(bone)) return 'upperLeg'
  if (/lowerLeg$/i.test(bone)) return 'lowerLeg'
  if (/foot$/i.test(bone)) return 'foot'
  if (/toes$/i.test(bone)) return 'toes'
  return 'other'
}

const VERBS = {
  head: { x: ['低头', '抬头'], y: ['向她的右侧转头', '向她的左侧转头'], z: ['向她的右肩歪头', '向她的左肩歪头'] },
  torso: { x: ['身体前俯', '身体后仰'], y: ['上身向她的右侧扭', '向她的左侧扭'], z: ['身体向她的右侧倾', '向她的左侧倾'] },
  shoulder: { x: ['肩向前送', '肩向后收'], y: ['肩向后摆', '肩向前摆'], z: ['沉肩', '耸肩'] },
  upperArm: { x: ['手臂扭转', '手臂反向扭转'], y: ['手臂向后摆', '手臂向前摆'], z: ['手臂向下落', '手臂向上抬'] },
  lowerArm: { x: ['前臂扭转', '前臂反向扭转'], y: ['小臂向后摆', '小臂向前摆'], z: ['小臂向下摆', '小臂向上摆'] },
  hand: { x: ['手腕向下弯', '手腕向上翘'], y: ['手掌外翻', '手掌内翻'], z: ['手腕向小指侧偏', '手腕向拇指侧偏'] },
  finger: { x: ['屈指', '伸指'], y: ['手指扭转', '手指反向扭转'], z: ['手指向一侧摆', '手指向另一侧摆'] },
  upperLeg: { x: ['向前抬腿', '向后摆腿'], y: ['大腿外旋', '大腿内旋'], z: ['腿向外打开', '腿向内收'] },
  lowerLeg: { x: ['小腿向前抬起', '小腿向后收'], y: ['小腿外旋', '小腿内旋'], z: ['小腿向内侧摆', '小腿向外侧摆'] },
  foot: { x: ['脚尖上翘', '脚尖下压'], y: ['脚掌外转', '脚掌内转'], z: ['脚掌外翻', '脚掌内翻'] },
  toes: { x: ['脚趾上翘', '脚趾下弯'], y: ['脚趾扭转', '脚趾反向扭转'], z: ['脚趾向一侧摆', '脚趾向另一侧摆'] },
  other: { x: ['正向转动', '反向转动'], y: ['正向转动', '反向转动'], z: ['正向转动', '反向转动'] },
}

const REST = {
  head: '头正立、脸朝前', torso: '上身直立', shoulder: '肩膀自然下垂',
  upperArm: '手臂水平外展（T 姿势）', lowerArm: '肘部伸直', hand: '手腕伸直',
  finger: '手指伸直', upperLeg: '双腿直立', lowerLeg: '膝盖伸直', foot: '脚掌平放地面',
  toes: '脚趾伸直', other: '静止姿势',
}

const RANGE = { head: 30, torso: 20, shoulder: 25, upperArm: 80, lowerArm: 100, hand: 45, finger: 55, upperLeg: 70, lowerLeg: 100, foot: 40, toes: 30, other: 45 }


/**
 * Decide which of the two verbs describes a *positive* value.
 *
 * The verb table lists the two motions an axis can produce; the measured movement says
 * which one a positive angle actually gives. Without this, a note can claim "positive lowers
 * the head" on a model where it raises it — which is exactly the mistake that made a bow lean
 * backwards.
 *
 * @param family - Bone family.
 * @param axis - `x` / `y` / `z`.
 * @param deltas - Measured movement per watched bone.
 * @returns 0 when the first verb is positive, 1 when the order must be swapped.
 */
function positiveOrder(family, axis, deltas, bone) {
  const biggest = Object.entries(deltas ?? {})
    .map(([name, value]) => ({ name, value, size: Math.hypot(value[0], value[1], value[2]) }))
    .sort((a, b) => b.size - a.size)[0]
  if (biggest === undefined) return 0
  const [x, y, z] = biggest.value
  const pick = (firstWhen) => (firstWhen ? 0 : 1)
  if (family === 'head' && axis === 'x') return pick(z > 0)
  if (family === 'head' && axis === 'z') return pick(x >= 0)
  if (family === 'torso' && axis === 'x') return pick(z > 0)
  if (family === 'torso' && axis === 'z') return pick(x >= 0)
  if ((family === 'upperArm' || family === 'shoulder' || family === 'lowerArm') && axis === 'z') return pick(y < 0)
  if ((family === 'upperArm' || family === 'lowerArm') && axis === 'y') return pick(z < 0)
  if (family === 'upperLeg' && axis === 'x') return pick(z > 0)
  if (family === 'upperLeg' && axis === 'z') return pick(Math.abs(x) >= 0 && x >= 0)
  if (family === 'lowerLeg' && axis === 'x') return pick(z > 0)
  if (family === 'foot' && axis === 'x') return pick(y > 0)
  if (family === 'foot' && (axis === 'y' || axis === 'z')) {
    // Outward means +x for the left foot and -x for the right one; both axes follow that.
    const outward = /^left/i.test(String(bone ?? '')) ? x > 0 : x < 0
    return pick(outward)
  }
  if (family === 'hand' || family === 'finger') {
    if (axis === 'x') return pick(y < 0)
    if (axis === 'z') return pick(Math.abs(x) > 0 && x >= 0)
  }
  return 0
}

const zoomGroups = [...new Set(wanted.map(zoomGroupOf))]
const results = []
for (const groupName of zoomGroups) {
  // Each group gets its own framing, so a finger fills as many pixels as a head.
  const baseline = await tab.evaluate(name => window.__baselineAt(name), groupName)
  await writeFile(join(outDir, `rest-${groupName}.png`), Buffer.from(baseline.image.split(',')[1], 'base64'))
  for (const bone of wanted.filter(entry => zoomGroupOf(entry) === groupName)) {
    for (const axis of ['x', 'y', 'z']) {
      const answer = await tab.evaluate(
        ({ bone, axis, delta, group }) => window.__inspect({ bone, axis, delta, keepFrame: true, group }),
        { bone, axis, delta, group: groupName },
      )
      if (answer?.ok !== true) continue
      const channel = `Bone${bone.charAt(0).toUpperCase()}${bone.slice(1)}${axis.toUpperCase()}`
      await writeFile(join(outDir, `${channel}.png`), Buffer.from(answer.image.split(',')[1], 'base64'))
      const family = FAMILY_OF(bone)
      const verbs = VERBS[family]?.[axis] ?? VERBS.other[axis]
      // A positive angle may produce either of the two motions; the measurement decides.
      const order = positiveOrder(family, axis, answer.deltas, bone)
      const positive = verbs[order]
      const negative = verbs[1 - order]
      // The stage camera is orthographic with a viewport-tall frustum, so one world unit is
      // one CSS pixel; the largest end-effector delta is the on-screen movement.
      const movedPx = Math.max(0, ...Object.values(answer.deltas ?? {})
        .map(value => Math.hypot(value[0], value[1], value[2])))
      // 3 px is roughly the smallest movement a player can see on a normal display.
      const visible = movedPx >= 3
      // Legs and feet move too little of the frame at 15° to judge by eye, so the note keeps
      // the measured direction; a channel that changes nothing is called out honestly.
      // The note states what the measurement saw, instead of mapping it onto a vocabulary
      // that has to guess which word belongs to the positive direction.
      const moving = describe(answer.deltas, answer.changed)
      const visibleNote = visible
        ? `0=${REST[family] ?? '静止姿势'}；正数转到 ${delta}° 时${moving}，负数方向相反。常用 ±${RANGE[family] ?? 45}°（屏幕上约 ${Math.round(movedPx)} 像素）`
        : `0=${REST[family] ?? '静止姿势'}；转了看不出变化：这尊模型没有给这条通道蒙皮。`
      results.push({
        channel,
        bone,
        axis,
        family,
        zoom: groupName,
        delta,
        changed: answer.changed,
        movedPx: Number(movedPx.toFixed(1)),
        deltas: answer.deltas,
        visible,
        verdict: describe(answer.deltas, answer.changed),
        meaning: positive,
        note: visibleNote,
      })
      process.stdout.write(`\r${results.length}/${wanted.length * 3} ${channel}          `)
    }
  }
}
process.stdout.write('\n')

await browser.close()
server.close()

/**
 * Turn the end-effector movement into one short sentence a person can check.
 *
 * The camera sits on +Z, so +z is toward the viewer, +y is up and +x is the viewer's right.
 * @param deltas - Movement per watched bone.
 * @param changed - Share of pixels that moved.
 * @returns A human-readable verdict.
 */
function describe(deltas, changed) {
  if (changed !== undefined && changed < 0.0004) return '几乎看不到变化'
  const parts = []
  const label = (name) => ({
    head: '头部基准', headTip: '头顶', leftHand: '左手', rightHand: '右手', leftFoot: '左脚', rightFoot: '右脚',
    leftToes: '左脚尖', rightToes: '右脚尖', leftToeTip: '左脚趾端', rightToeTip: '右脚趾端', chest: '胸',
  })[name] ?? name
  for (const [name, delta] of Object.entries(deltas ?? {})) {
    const [x, y, z] = delta
    const size = Math.hypot(x, y, z)
    if (size < 0.004) continue
    const words = []
    if (Math.abs(y) > 0.004) words.push(y > 0 ? '上' : '下')
    if (Math.abs(z) > 0.004) words.push(z > 0 ? '向镜头' : '离镜头')
    if (Math.abs(x) > 0.004) words.push(x > 0 ? '向画面右' : '向画面左')
    parts.push(`${label(name)}${words.join('')}`)
  }
  if (parts.length === 0) return '轴上有旋转，但末端几乎不动（多为扭转）'
  return parts.slice(0, 3).join('，')
}

await writeFile(join(outDir, 'report.json'), `${JSON.stringify({
  model: basename(model),
  delta,
  group: group === '' ? 'all' : group,
  generatedAt: new Date().toISOString(),
  channels: results,
  suggestedNotes: Object.fromEntries(results.map(entry => [entry.channel, entry.note])),
}, null, 2)}\n`, 'utf8')

// Contact sheet: the rest pose, then one tile per channel with its verdict under the image.
const tiles = results.map((entry) => {
  const image = `${entry.channel}.png`
  return `<figure><img src="${image}" alt="${entry.channel}"><figcaption><b>${entry.channel}</b><br>${entry.verdict}<br><span>${(entry.changed * 100).toFixed(1)}% 像素变化</span></figcaption></figure>`
}).join('\n')
await writeFile(join(outDir, 'index.html'), `<!doctype html><meta charset="utf-8">
<title>${basename(pack)} 通道观察表</title>
<style>
body{margin:0;background:#f6f1ea;color:#2b241d;font:14px/1.6 ui-sans-serif,system-ui}
header{padding:18px 22px 6px}
h1{font-size:18px;font-weight:600;margin:0 0 4px}
p{margin:0;color:#6b6259;font-size:12.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:16px 22px 32px}
figure{margin:0;background:#fffdfb;border:1px solid #e8e2db;border-radius:12px;overflow:hidden}
img{display:block;width:100%;height:auto;background:#f4efe9}
figcaption{padding:8px 10px;font-size:11.5px;line-height:1.6}
figcaption b{font-size:12px}
figcaption span{color:#8a8175}
.rest{max-width:260px}
</style>
<header><h1>${basename(pack)} · 每通道 ${delta}° 的作用</h1>
<p>从静止姿势开始，逐个通道旋转 ${delta}°，右侧是变化后的画面。相机在 +z，所以「向镜头」= 向前；文字是末端骨骼的位移摘要，头部这类自身旋转的轴以图为准。</p></header>
<div style="padding:0 22px"><figure class="rest"><img src="rest.png" alt="rest"><figcaption><b>静止（T 姿势）</b></figcaption></figure></div>
<div class="grid">${tiles}</div>` , 'utf8')

console.log(`完成：${results.length} 条通道 → ${outDir}`)
console.log(`报告：${join(outDir, 'report.json')}`)
console.log(`观察表：${join(outDir, 'index.html')}`)
