/**
 * Fill a pack's parameter notes with the shipped VRM channel defaults.
 *
 * The pack keeps whatever the player already wrote; this only adds the channels that have
 * no note yet, and only for the bones the model itself declares. A previous revision of
 * `params.json` is copied to `params.json.bak` first.
 *
 * Usage: `node scripts/calibrate-pack.mjs <packDir>`
 */
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packDir = process.argv[2]
if (typeof packDir !== 'string' || packDir === '') {
  console.error('usage: node scripts/calibrate-pack.mjs <packDir>')
  process.exit(1)
}
const pack = resolve(packDir)

/** Channels the model's own humanoid declares. */
async function modelChannels(dir) {
  const entries = await readdir(dir)
  const file = entries.find(name => name.toLowerCase().endsWith('.vrm'))
  if (file === undefined) return { file: undefined, channels: [] }
  const buffer = await readFile(join(dir, file))
  if (buffer.toString('ascii', 0, 4) !== 'glTF') return { file, channels: [] }
  const jsonLength = buffer.readUInt32LE(12)
  const json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength))
  const extensions = json.extensions ?? {}
  const vrm1 = extensions.VRMC_vrm?.humanoid?.humanBones
  const vrm0 = extensions.VRM?.humanoid?.humanBones
  const names = vrm1 !== null && vrm1 !== undefined && typeof vrm1 === 'object'
    ? Object.keys(vrm1)
    : (Array.isArray(vrm0) ? vrm0.map(entry => entry?.bone) : [])
  const channels = []
  for (const bone of names) {
    if (typeof bone !== 'string' || /eye/i.test(bone)) continue
    const pascal = bone.charAt(0).toUpperCase() + bone.slice(1)
    for (const axis of ['X', 'Y', 'Z']) channels.push(`Bone${pascal}${axis}`)
  }
  return { file, channels }
}

const defaults = JSON.parse(await readFile(join(root, 'assets', 'vrm-channel-defaults.json'), 'utf8')).channels
const paramsFile = join(pack, 'params.json')
const existing = existsSync(paramsFile) ? JSON.parse(await readFile(paramsFile, 'utf8')) : { params: {} }
const params = existing?.params !== null && typeof existing?.params === 'object' ? { ...existing.params } : {}

const { file, channels } = await modelChannels(pack)
if (file === undefined) {
  console.error(`${pack}: 没有 .vrm`)
  process.exit(1)
}

let added = 0
let kept = 0
for (const id of channels) {
  const note = defaults[id]
  if (typeof note !== 'string') continue
  if (params[id]?.note !== undefined) {
    kept += 1
    continue
  }
  params[id] = { note }
  added += 1
}

if (existsSync(paramsFile)) await copyFile(paramsFile, `${paramsFile}.bak`)
await writeFile(paramsFile, `${JSON.stringify({ version: 1, updatedAt: Date.now(), params }, null, 2)}\n`, 'utf8')
console.log(`${file}：通道 ${channels.length} 个 · 新增备注 ${added} 条 · 保留原有 ${kept} 条 · 写入 ${paramsFile}`)
