/**
 * Turn `inspect/<pack>/channel-meanings.json` into channel notes and write them into the pack.
 *
 * The note states what the measurement found: which way the next bone in the chain moved and by
 * how many degrees. Nothing is translated into a verb that a table guessed.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'

const meaningsFile = process.argv[2] ?? 'inspect/橘雪莉/channel-meanings.json'
const paramsFile = process.argv[3]
// The pack lives in the user's data directory, which this repository does not know.
if (meaningsFile === undefined || paramsFile === undefined) {
  console.error('usage: node scripts/apply-meanings.mjs <channel-meanings.json> <params.json>')
  process.exit(1)
}

/** The rest state a channel starts from, by bone family (bone names are camelCase). */
function restState(bone) {
  const key = String(bone).toLowerCase()
  if (/^(hips|spine|chest|upperchest)$/.test(key)) return '上身直立'
  if (/^(neck|head)$/.test(key)) return '头正立、脸朝前'
  if (/shoulder$/.test(key)) return '肩膀自然下垂'
  if (/upperarm$/.test(key)) return '手臂水平外展（T 姿势）'
  if (/lowerarm$/.test(key)) return '肘部伸直'
  if (/hand$/.test(key)) return '手腕伸直'
  if (/thumb|index|middle|ring|little/.test(key)) return '手指伸直'
  if (/upperleg$/.test(key)) return '双腿直立'
  if (/lowerleg$/.test(key)) return '膝盖伸直'
  if (/foot$/.test(key)) return '脚掌平放地面'
  if (/toes$/.test(key)) return '脚趾伸直'
  return '静止姿势'
}

const meanings = JSON.parse(readFileSync(meaningsFile, 'utf8'))
const store = JSON.parse(readFileSync(paramsFile, 'utf8'))
const params = store.params !== null && typeof store.params === 'object' ? store.params : {}

let written = 0
for (const entry of meanings.channels ?? []) {
  const note = entry.dead === true
    ? `0=${restState(entry.bone)}；正数 15°：骨骼朝向几乎不变，这是扭转轴，只改自身的滚转。`
    : `0=${restState(entry.bone)}；正数 15°：下一节骨骼朝${entry.at15.words}偏 ${entry.at15.angle}°；负数反向。`
  params[entry.channel] = { note }
  written += 1
}

copyFileSync(paramsFile, `${paramsFile}.bak`)
writeFileSync(paramsFile, `${JSON.stringify({ version: 1, updatedAt: Date.now(), params }, null, 2)}\n`, 'utf8')
console.log(`写入 ${written} 条 · 总计 ${Object.keys(params).length}`)
