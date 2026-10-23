import { readFileSync, writeFileSync } from 'node:fs'

const file = 'assets/pose-recipes.json'
const library = JSON.parse(readFileSync(file, 'utf8'))
const recipe = library.recipes.find(entry => entry.id === 'crouch')
if (recipe === undefined) throw new Error('crouch recipe missing')

// Solved by scripts/../hands-solve: both hands land 6.4 cm from the knee joints, knees spread
// 30 degrees outward so they clear the skirt.
recipe.params = {
  BoneLeftUpperLegX: 85,
  BoneRightUpperLegX: 85,
  BoneLeftUpperLegZ: -30,
  BoneRightUpperLegZ: 30,
  BoneLeftLowerLegX: -160,
  BoneRightLowerLegX: -160,
  BoneLeftFootX: 25,
  BoneRightFootX: 25,
  BoneSpineX: -16,
  BoneChestX: -8,
  BoneNeckX: 12,
  BoneHeadX: 10,
  BoneLeftShoulderZ: 20,
  BoneRightShoulderZ: -20,
  BoneLeftUpperArmZ: 20,
  BoneRightUpperArmZ: -20,
  BoneLeftUpperArmY: -60,
  BoneRightUpperArmY: 60,
  BoneLeftLowerArmZ: 5,
  BoneRightLowerArmZ: -5,
}
recipe.translate = { hips: [0, -0.69, 0] }
recipe.checks = [
  { type: 'headHeightRatio', target: 0.46, tolerance: 0.08 },
  { type: 'footOnGround', max: 0.03 },
  { type: 'handToKnee', side: 'left', max: 0.08 },
  { type: 'handToKnee', side: 'right', max: 0.08 },
]
recipe.note = '膝盖外开 30° 让膝盖露出裙摆，双手解到离膝 6.4 cm（手掌落在膝上）；头顶约为站立的 46%'
recipe.easeMs = 750

writeFileSync(file, `${JSON.stringify(library, null, 2)}\n`, 'utf8')
console.log('crouch updated:', Object.keys(recipe.params).length, 'channels, checks', recipe.checks.length)
