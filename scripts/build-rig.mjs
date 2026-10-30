/**
 * Build a pack's emotion rig from the model itself.
 *
 * The moc3 is the authority for parameter ids, ranges and default values; the cdi3
 * supplies the human names the workbench shows. This script joins them, applies the
 * emotion weights declared below, and writes the pack's `rig.json` plus a readable
 * inventory of every parameter the model declares.
 *
 * Usage: node scripts/build-rig.mjs <pack dir or model dir> [--dry]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const [, , target, ...flags] = process.argv
if (target === undefined) {
  console.error('usage: node scripts/build-rig.mjs <pack dir or model dir> [--dry]')
  process.exit(1)
}
const dry = flags.includes('--dry')

const given = resolve(target)
const modelDir = existsSync(join(given, 'model')) ? join(given, 'model') : given
const packDir = modelDir === given ? dirname(given) : given

const modelFile = readdirSync(modelDir).find(name => name.toLowerCase().endsWith('.model3.json'))
if (modelFile === undefined) {
  console.error(`no .model3.json under ${modelDir}`)
  process.exit(1)
}
const model = JSON.parse(readFileSync(join(modelDir, modelFile), 'utf8'))
const mocFile = model?.FileReferences?.Moc
const cdiFile = model?.FileReferences?.DisplayInfo
if (typeof mocFile !== 'string' || !existsSync(join(modelDir, mocFile))) {
  console.error(`model declares no readable Moc: ${String(mocFile)}`)
  process.exit(1)
}

/** Parameter ranges straight from the moc3, via the packaged Cubism Core. */
const scratch = mkdtempSync(join(tmpdir(), 'dsh-rig-'))
const rangesFile = join(scratch, 'ranges.json')
execFileSync(process.execPath, [join(here, 'read-moc3-params.mjs'), join(modelDir, mocFile), rangesFile], { stdio: 'pipe' })
const ranges = JSON.parse(readFileSync(rangesFile, 'utf8')).parameters
const rangeById = new Map(ranges.map(entry => [entry.id, entry]))

const display = cdiFile !== undefined && existsSync(join(modelDir, cdiFile))
  ? JSON.parse(readFileSync(join(modelDir, cdiFile), 'utf8'))
  : { Parameters: [], ParameterGroups: [] }
const groupNames = new Map((display.ParameterGroups ?? []).map(group => [group.Id, group.Name ?? group.Id]))
const nameById = new Map()
const groupById = new Map()
for (const entry of display.Parameters ?? []) {
  nameById.set(entry.Id, String(entry.Name ?? '').trim())
  groupById.set(entry.Id, groupNames.get(entry.GroupId) ?? String(entry.GroupId ?? ''))
}

/**
 * Emotion weights: `[id, role, zone, base, min, max, [valence, arousal, dominance], note]`.
 *
 * Only parameters an emotion should move belong here; physics and idle-animation
 * channels stay out so the model keeps driving them itself.
 */
const EMOTION = [
  // Eyes
  ['ParamEyeLOpen', '左眼开合', 'face', 1, 0, 1.5, [-0.12, 0.38, 0.06], '唤醒度决定眼皮：惊讶睁大，困倦/难过垂下'],
  ['ParamEyeROpen', '右眼开合', 'face', 1, 0, 1.5, [-0.12, 0.38, 0.06], '与左眼同步'],
  ['ParamEyeBallX', '眼珠左右', 'face', 0, -1, 1, [0, 0.12, 0.22], '主导时更直视，顺从时视线偏开'],
  ['ParamEyeBallY', '眼珠上下', 'face', 0, -1, 1, [0.08, 0.08, 0.42], '主导时抬眼，低落时视线向下'],
  ['EyeSmile', '笑眼', 'face', 0, -1, 1, [0.55, 0.05, 0.05], '愉快时弯眼；负值可用于委屈'],
  ['LEyeSquint', '左眼眯起', 'face', 0, 0, 1, [0.25, 0.18, -0.05], '愉快/强烈情绪时微眯'],
  ['REyeSquint', '右眼眯起', 'face', 0, 0, 1, [0.25, 0.18, -0.05], '与左眼同步'],
  ['PupilX', '瞳孔透视 X', 'face', 0, -1, 1, [0, 0.1, 0.15], '与眼珠同向的小幅偏移，避免眼神发死'],
  ['PupilY', '瞳孔透视 Y', 'face', 0, -1, 1, [0.05, 0.1, 0.2], '同上'],
  // Brows
  ['ParamBrowLY', '左眉上下', 'face', 0, -1, 1, [0.42, 0.16, 0.12], '愉快抬眉，低沉时压眉'],
  ['ParamBrowRY', '右眉上下', 'face', 0, -1, 1, [0.42, 0.16, 0.12], '与左眉同步'],
  ['ParamBrowLAngle', '左眉角度', 'face', 0, -1, 1, [-0.28, 0.12, 0.06], '负值皱眉（生气/困惑）'],
  ['ParamBrowRAngle', '右眉角度', 'face', 0, -1, 1, [-0.28, 0.12, 0.06], '与左眉同步'],
  // Mouth
  ['ParamMouthForm', '嘴角', 'face', 0, -1, 1, [0.9, 0.1, 0.12], '愉快上扬，难过下撇'],
  ['ParamMouthOpenY', '张嘴', 'face', 0, 0, 1, [0.05, 0.78, 0.1], '唤醒度决定张嘴：惊讶/生气，平静时闭着'],
  ['JawOpen', '下巴开合', 'face', 0, 0, 1, [0.02, 0.35, 0], '大声说话/惊讶时下巴下沉'],
  ['MouthSmile_L', '左嘴角笑', 'face', 0, 0, 1, [0.5, 0, 0], '与 ParamMouthForm 配合补足笑弧'],
  ['MouthSmile_R', '右嘴角笑', 'face', 0, 0, 1, [0.5, 0, 0], '同上'],
  ['Mouthpucker', '撅嘴', 'face', 0, 0, 1, [-0.22, 0.12, 0], '低落/撒娇时撅嘴'],
  ['Press', '嘴唇用力', 'face', 0, 0, 1, [-0.18, 0.1, 0.05], '不高兴时抿嘴'],
  ['CheeckPuff', '鼓腮', 'face', 0, 0, 1, [-0.3, 0.1, -0.1], '偷吃/憋气时鼓起'],
  ['TongueOut', '伸舌头', 'face', 0, 0, 1, [0.1, 0.2, 0], '调皮时轻轻吐出'],
  // Head and body
  ['ParamAngleX', '头左右转', 'pose', 0, -30, 30, [0, 0.05, 0.12], '主导时看向对方，回避时偏开'],
  ['ParamAngleY', '头上下', 'pose', 0, -30, 30, [0.1, 0.08, 0.5], '主导/自信时抬头'],
  ['ParamAngleZ', '头歪', 'pose', 0, -30, 30, [0.3, 0.04, 0], '愉快时歪头'],
  ['ParamBodyAngleX', '身体左右倾', 'pose', 0, -30, 30, [0, 0.05, 0.15], '跟随头部的小幅重心偏移'],
  ['ParamBodyAngleZ', '身体歪', 'pose', 0, -30, 30, [0.2, 0.03, 0], '与头歪同侧的放松'],
  ['ParamBreath', '呼吸起伏', 'pose', 0, 0, 1, [0.04, 0.4, 0], '唤醒度高时呼吸更明显'],
]

/**
 * Held channels are NOT written into the rig table: the renderer writes every rig
 * entry on every frame, which would fight the model's own expressions (an `.exp3`
 * that switches the skirt sets the same parameter). Switches live in the pack's
 * `stage-state.json` instead, where the model itself decides what to keep.
 */
const SWITCH_PREFIXES = ['key', 'Clothes', 'Movement']
const switchIds = ranges
  .filter(real => SWITCH_PREFIXES.some(prefix => real.id.startsWith(prefix)))
  .filter(real => /^(key\d+|Clothes\d+|Movement\d+)$/.test(real.id))
  .map(real => real.id)

const params = []
for (const [id, role, zone, base, min, max, weights, note] of EMOTION) {
  const real = rangeById.get(id)
  if (real === undefined) {
    console.warn(`skip ${id}: the model does not declare it`)
    continue
  }
  params.push({
    id,
    role,
    zone,
    confidence: 'verified',
    base: Math.min(real.max, Math.max(real.min, base)),
    min: real.min,
    max: real.max,
    weights: { valence: weights[0], arousal: weights[1], dominance: weights[2] },
    note,
  })
}

const rig = { version: 2, params }
const rigFile = join(packDir, 'rig.json')
if (!dry) writeFileSync(rigFile, `${JSON.stringify(rig, null, 2)}\n`)

// Inventory: every parameter the model declares, grouped the way the author grouped it.
const inRig = new Set(params.map(entry => entry.id))
const byGroup = new Map()
for (const real of ranges) {
  const group = groupById.get(real.id) ?? ''
  if (!byGroup.has(group)) byGroup.set(group, [])
  byGroup.get(group).push({
    id: real.id,
    name: nameById.get(real.id) ?? '',
    min: real.min,
    max: real.max,
    base: real.base,
    inRig: inRig.has(real.id),
  })
}
const lines = [`# 参数清单 · ${packDir.split(/[\\/]/).pop()}`, '']
lines.push(`模型：\`${modelFile}\` · 参数 ${ranges.length} 个 · 映射表 ${params.length} 条`)
lines.push('')
for (const [group, entries] of byGroup) {
  lines.push(`## ${group === '' ? '（未分组）' : group}（${entries.length}）`)
  lines.push('')
  lines.push('| 参数 | 名称 | 范围 | 默认 | 映射表 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const entry of entries) {
    lines.push(`| \`${entry.id}\` | ${entry.name} | ${entry.min} ~ ${entry.max} | ${entry.base} | ${entry.inRig ? '是' : ''} |`)
  }
  lines.push('')
}
const inventoryFile = join(packDir, '参数清单.md')
if (!dry) writeFileSync(inventoryFile, lines.join('\n'))

console.log(`${dry ? '[dry] ' : ''}rig.json: ${params.length} emotion entries`)
console.log(`${dry ? '[dry] ' : ''}switches: ${switchIds.length} parameters left out of the table (persist them instead)`)
console.log(`${dry ? '[dry] ' : ''}inventory: ${ranges.length} parameters in ${byGroup.size} groups`)
