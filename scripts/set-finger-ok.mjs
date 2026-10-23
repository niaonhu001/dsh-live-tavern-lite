import { readFileSync, writeFileSync } from 'node:fs'

const poseFile = process.argv[2]
const recipeFile = 'assets/pose-recipes.json'
const solved = JSON.parse(readFileSync(poseFile, 'utf8'))
const library = JSON.parse(readFileSync(recipeFile, 'utf8'))
const recipe = library.recipes.find(entry => entry.id === 'finger_ok')
if (recipe === undefined) throw new Error('finger_ok missing')

const params = {}
for (const [channel, degrees] of Object.entries(solved.pose)) {
  if (Math.abs(Number(degrees)) < 0.5) continue
  params[channel] = Math.round(Number(degrees) * 10) / 10
}
recipe.params = params
recipe.easeMs = 640
recipe.note = `右手拇指与食指尖相距 ${(solved.gap * 100).toFixed(1)} mm 围成圈；左手食指穿过圈，离圈心 ${(solved.through.miss * 100).toFixed(1)} cm、穿过圈面 ${(solved.through.beyond * 100).toFixed(1)} cm、与圈轴夹角余弦 ${solved.through.alignment}`
writeFileSync(recipeFile, `${JSON.stringify(library, null, 2)}\n`, 'utf8')
console.log(`finger_ok: ${Object.keys(params).length} channels, gap ${solved.gap}, miss ${solved.through.miss}`)
