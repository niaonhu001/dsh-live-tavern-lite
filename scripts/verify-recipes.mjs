/**
 * Render every pose recipe and paint a contact sheet, so the numbers can be looked at.
 *
 * The recipes are hand-authored, and this tool is the check: each one is applied to the pack's
 * model and captured twice — full body and a zoom on the part it moves — with the channel
 * values printed under each tile.
 *
 * Usage:
 *   node scripts/verify-recipes.mjs --pack ~/.dsh/live2d/packs/<name>
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
const pack = args.pack === undefined
  ? undefined
  : resolve(String(args.pack).replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? ''))
if (pack === undefined || !existsSync(pack)) {
  console.error('usage: node scripts/verify-recipes.mjs --pack <角色包目录>')
  process.exit(1)
}

const recipeFile = resolve(String(args.recipes ?? join(root, 'assets', 'pose-recipes.json')))
const library = JSON.parse(await readFile(recipeFile, 'utf8'))
const recipes = Array.isArray(library.recipes) ? library.recipes : []
// The runtime applies the base pose under every recipe, so the check must too.
const baseFile = resolve(String(args.base ?? join(root, 'assets', 'pose-base.json')))
const base = await readFile(baseFile, 'utf8').then(text => JSON.parse(text)?.params ?? {}).catch(() => ({}))

const entries = await readdir(pack)
const modelName = entries.find(entry => entry.toLowerCase().endsWith('.vrm'))
if (modelName === undefined) {
  console.error(`${pack} 里没有 .vrm`)
  process.exit(1)
}
const model = join(pack, modelName)

const outDir = resolve(String(args.out ?? join(root, 'inspect', basename(pack), 'recipes')))
await mkdir(outDir, { recursive: true })

const esbuild = createRequire(import.meta.url)('esbuild')
const bundlePath = join(tmpdir(), `dsh-live-tavern-recipes-${process.pid}.js`)
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
  console.error('找不到 playwright：可用 DSH_CHECKOUT 指定一个装了它的 DSH 检出')
  process.exit(1)
}

const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#f4efe9}canvas{display:block;width:100vw;height:100vh}</style>
<canvas id="c"></canvas><script type="module" src="/inspect.js"></script>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
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

const executable = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await playwright.chromium.launch({
  ...(existsSync(executable) ? { executablePath: executable } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const context = await browser.newContext({ viewport: { width: 420, height: 560 } })
const tab = await context.newPage()
const logs = []
tab.on('pageerror', error => logs.push(`pageerror: ${error.message}`))
await tab.goto(`http://127.0.0.1:${port}/`)
try {
  await tab.waitForFunction(() => window.__probe !== undefined, { timeout: 60000 })
} catch {
  console.error('页面没有就绪：', JSON.stringify(logs.slice(0, 5)))
  await browser.close()
  server.close()
  process.exit(1)
}

/**
 * A still pose is its `params`; a sequenced recipe is checked at its peak bend, so the frame
 * shows the gesture instead of the return to rest.
 */
function poseOf(recipe) {
  if (recipe.params !== undefined) return recipe.params
  const pose = {}
  for (const step of String(recipe.animation ?? '').split(';')) {
    const match = /^\s*(Bone[A-Za-z]+[XYZ])\s*=\s*(-?[\d.]+)\s*@/.exec(step)
    if (match === null) continue
    const channel = match[1]
    const value = Number(match[2])
    if (pose[channel] === undefined || Math.abs(value) > Math.abs(pose[channel])) pose[channel] = value
  }
  return pose
}

/** Which zoom shows this recipe best. */
function zoomOf(recipe) {
  const channels = Object.keys(poseOf(recipe))
  if (channels.some(channel => /Head|Neck|Jaw/.test(channel))) return 'head'
  if (channels.some(channel => /Hand|Arm|Shoulder|Thumb|Index|Middle|Ring|Little/.test(channel))) return 'arm'
  return 'all'
}

const rendered = []
for (const recipe of recipes) {
  const pose = { ...base, ...poseOf(recipe) }
  const zoom = zoomOf(recipe)
  const translate = recipe.translate ?? null
  const full = await tab.evaluate(({ pose, translate }) => window.__poseAt(pose, 'all', translate), { pose, translate })
  const zoomed = await tab.evaluate(({ pose, zoom, translate }) => window.__poseAt(pose, zoom, translate), { pose, zoom, translate })
  await writeFile(join(outDir, `${recipe.id}-full.png`), Buffer.from(full.split(',')[1], 'base64'))
  await writeFile(join(outDir, `${recipe.id}-${zoom}.png`), Buffer.from(zoomed.split(',')[1], 'base64'))
  rendered.push({ recipe, pose, zoom })
  process.stdout.write(`\r${rendered.length}/${recipes.length} ${recipe.id}          `)
}
process.stdout.write('\n')
await browser.close()
server.close()

const tiles = rendered.map(({ recipe, pose, zoom }) => {
  const values = Object.entries(pose).map(([channel, degrees]) => `${channel.replace(/^Bone/, '')} ${degrees}°`).join('　')
  const sequence = recipe.animation === undefined ? '' : `<div class="seq">${recipe.animation}</div>`
  return `<figure>
  <div class="pair"><img src="${recipe.id}-full.png" alt="${recipe.id}"><img src="${recipe.id}-${zoom}.png" alt="${recipe.id} 特写"></div>
  <figcaption><b>${recipe.id}</b> · ${recipe.label} — ${recipe.intent}<div class="vals">${values || '（无静止值）'}</div>${sequence}</figcaption>
</figure>`
}).join('\n')

await writeFile(join(outDir, 'index.html'), `<!doctype html><meta charset="utf-8">
<title>${basename(pack)} 配方核对</title>
<style>
body{margin:0;background:#f6f1ea;color:#2b241d;font:14px/1.6 ui-sans-serif,system-ui}
header{padding:18px 22px 8px}
h1{font-size:18px;margin:0 0 4px}
p{margin:0;color:#6b6259;font-size:12.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;padding:14px 22px 32px}
figure{margin:0;background:#fffdfb;border:1px solid #e8e2db;border-radius:12px;overflow:hidden}
.pair{display:grid;grid-template-columns:1fr 1fr}
img{display:block;width:100%;height:auto;background:#f4efe9}
figcaption{padding:8px 10px;font-size:11.5px;line-height:1.6}
.vals{margin-top:4px;font-family:ui-monospace,monospace;font-size:10.5px;color:#6b6259}
.seq{margin-top:4px;font-family:ui-monospace,monospace;font-size:10.5px;color:#8a5a2b}
</style>
<header><h1>${basename(pack)} · ${recipes.length} 个配方</h1>
<p>左边是全身，右边是按部位放大；数值就是配方里写的角度。</p></header>
<div class="grid">${tiles}</div>` , 'utf8')

console.log(`完成：${rendered.length} 个配方 → ${outDir}`)
console.log(`核对表：${join(outDir, 'index.html')}`)
