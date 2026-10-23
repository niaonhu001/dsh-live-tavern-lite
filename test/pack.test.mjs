/** Pure tests for character-pack normalization, world-book activation and rendering. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activateWorldBook,
  applyMacros,
  estimateTokens,
  normalizeCard,
  normalizeWorldBook,
  planWorldBook,
  renderCardSection,
  renderWorldBookSection,
} from '../lib/pack.mjs'

const V2 = {
  spec: 'chara_card_v2',
  data: {
    name: '艾莲·乔',
    description: '鲨鱼妹，慢吞吞的。',
    personality: '懒散、嘴硬、其实很在意。',
    scenario: '你在深潜者小队基地遇见她。',
    first_mes: '……干嘛。',
    mes_example: '{{user}}：在吗\n{{char}}：……在。',
    system_prompt: '保持懒散的语气。',
    post_history_instructions: '不要跳戏。',
    alternate_greetings: ['又是你。', '  '],
    tags: ['zzz', 42],
  },
}

test('cards accept the V2 wrapper and the flat form', () => {
  const card = normalizeCard(V2, 'ailian')
  assert.equal(card.name, '艾莲·乔')
  assert.equal(card.firstMes, '……干嘛。')
  assert.deepEqual(card.greetings, ['又是你。'])
  assert.deepEqual(card.tags, ['zzz'])

  const flat = normalizeCard({ name: '无人', description: 'x' }, 'fallback')
  assert.equal(flat.name, '无人')
  assert.equal(flat.personality, '')

  // A card without a name falls back to the pack id rather than rendering empty.
  assert.equal(normalizeCard({}, 'fallback').name, 'fallback')
})

test('world books accept the map and array dialects', () => {
  const map = normalizeWorldBook({
    entries: {
      0: { uid: 7, keys: ['鲨鱼'], content: '她有一条尾巴。', insertion_order: 20, constant: false },
      1: { keys: ['空'], content: '   ' },
      2: { content: '常驻设定', constant: true },
    },
  })
  assert.equal(map.length, 2)
  assert.equal(map[0].id, 7)
  assert.equal(map[0].order, 20)
  assert.equal(map[1].constant, true)

  const array = normalizeWorldBook({ entries: [{ content: 'A', keys: ['a'] }] })
  assert.equal(array.length, 1)
  assert.deepEqual(array[0].keys, ['a'])
  assert.equal(normalizeWorldBook(undefined).length, 0)
})

test('activation honours constant, keyword, secondary and disable', () => {
  const entries = normalizeWorldBook({
    entries: [
      { content: '常量条目', constant: true, insertion_order: 10 },
      { content: '提到鲨鱼', keys: ['鲨鱼'], insertion_order: 30 },
      { content: '没提到', keys: ['潜水艇'], insertion_order: 20 },
      { content: '需要两个词', keys: ['鲨鱼'], secondary_keys: ['尾巴'], selective: true, insertion_order: 40 },
      { content: '被禁用', keys: ['鲨鱼'], disable: true, insertion_order: 50 },
    ],
  })
  const digest = [{ role: 'user', text: '你的鲨鱼尾巴好可爱' }]
  const active = activateWorldBook(entries, digest)
  assert.deepEqual(active.map(entry => entry.content), ['常量条目', '提到鲨鱼', '需要两个词'])

  // Only the secondary requirement fails when the second word is absent.
  const narrow = activateWorldBook(entries, [{ role: 'user', text: '鲨鱼' }])
  assert.deepEqual(narrow.map(entry => entry.content), ['常量条目', '提到鲨鱼'])

  assert.equal(activateWorldBook(entries, []).length, 1, 'only the constant entry survives an empty digest')
})

test('activation respects the character budget without dropping constants first', () => {
  const entries = normalizeWorldBook({
    entries: [
      { content: 'x'.repeat(50), constant: true, insertion_order: 10 },
      { content: 'y'.repeat(50), keys: ['触发'], insertion_order: 20 },
      { content: 'z'.repeat(50), keys: ['触发'], insertion_order: 30 },
    ],
  })
  // 50 ASCII characters is about 13 estimated tokens, so a 20-token budget fits
  // the constant and nothing else.
  const active = activateWorldBook(entries, [{ role: 'user', text: '触发' }], { budgetTokens: 20 })
  assert.equal(active.length, 1)
  assert.equal(active[0].content.startsWith('x'), true)

  // The report says why the two keyed entries were skipped.
  const { report } = planWorldBook(entries, [{ role: 'user', text: '触发' }], { budgetTokens: 20 })
  assert.equal(report.injected.length, 1)
  assert.equal(report.droppedBudget.length, 2)
})

test('rendered sections carry the character and the matched lore', () => {
  const card = normalizeCard(V2, 'ailian')
  const cardText = renderCardSection(card)
  assert.match(cardText, /## 角色：艾莲·乔/)
  assert.match(cardText, /### 性格/)
  assert.match(cardText, /保持懒散的语气/)
  assert.match(cardText, /不要跳出角色/)

  const entries = normalizeWorldBook({ entries: [{ comment: '尾巴', content: '她有一条尾巴。' }] })
  const bookText = renderWorldBookSection(entries)
  assert.match(bookText, /## 本回合已知设定/)
  assert.match(bookText, /- 尾巴/)
  assert.equal(renderWorldBookSection([]), '')
})

test('SillyTavern macros never survive into a prompt section', () => {
  // The prompt renderer rejects unknown {{variables}} and fails the whole
  // assembly, so card and lore text must arrive with no braces left.
  const card = normalizeCard({
    data: {
      name: '艾莲',
      mes_example: '{{user}}：在吗\n{{char}}：……在。',
      description: '被 {{persona}} 叫到会抬头',
      scenario: '{{user}} 走进休息室',
    },
  }, 'ailian')
  const text = renderCardSection(card, { userName: '先生' })
  assert.match(text, /先生：在吗/)
  assert.match(text, /艾莲：……在。/)
  assert.match(text, /被 先生 叫到会抬头/)
  assert.match(text, /先生 走进休息室/)
  assert.doesNotMatch(text, /\{\{/)

  const lore = renderWorldBookSection(
    [{ comment: '称呼', content: '{{user}} 被 <BOT> 叫名字' }],
    { charName: '艾莲', userName: '先生' },
  )
  assert.match(lore, /先生 被 艾莲 叫名字/)
  assert.doesNotMatch(lore, /\{\{|<BOT>|<USER>/)

  // An unknown macro is left alone; interpolate:false keeps it from failing.
  assert.equal(applyMacros('{{unknown}}', { charName: 'A', userName: 'B' }), '{{unknown}}')
})

test('the scan window only reads the recent tail of the digest', () => {
  const entries = normalizeWorldBook({ entries: [
    { content: '旧话题的设定', keys: ['灯塔'], insertion_order: 10 },
    { content: '新话题的设定', keys: ['尾巴'], insertion_order: 20 },
  ] })
  const digest = [
    { role: 'user', text: '我们去灯塔吧' },
    { role: 'assistant', text: '好' },
    { role: 'user', text: '你尾巴在动' },
  ]
  // Depth 1 only sees the last message, so the old topic stops triggering.
  const narrow = planWorldBook(entries, digest, { scanDepth: 1, budgetTokens: 1000 })
  assert.deepEqual(narrow.entries.map(entry => entry.content), ['新话题的设定'])
  assert.equal(narrow.report.scannedMessages, 1)
  const wide = planWorldBook(entries, digest, { scanDepth: 0, budgetTokens: 1000 })
  assert.deepEqual(wide.entries.map(entry => entry.content), ['旧话题的设定', '新话题的设定'])
})

test('cooldown rests an entry after two assemblies in a row', () => {
  const entries = normalizeWorldBook({ entries: [
    { content: '尾巴的设定', keys: ['尾巴'], insertion_order: 10 },
  ] })
  const digest = [{ role: 'user', text: '你尾巴在动' }]
  const state = { assemblies: 0, entries: new Map() }
  const options = { scanDepth: 0, budgetTokens: 1000, cooldownAfter: 2, cooldownRounds: 2, state }
  assert.equal(planWorldBook(entries, digest, options).entries.length, 1)
  assert.equal(planWorldBook(entries, digest, options).entries.length, 1)
  // Third and fourth assemblies rest.
  assert.equal(planWorldBook(entries, digest, options).report.droppedCooldown.length, 1)
  assert.equal(planWorldBook(entries, digest, options).entries.length, 0)
  // Fifth is available again.
  assert.equal(planWorldBook(entries, digest, options).entries.length, 1)
})

test('a group override admits one entry per group', () => {
  const entries = normalizeWorldBook({ entries: [
    { content: '轻描述', keys: ['她'], group: 'mood', groupOverride: true, groupWeight: 10, insertion_order: 10 },
    { content: '重描述', keys: ['她'], group: 'mood', groupOverride: true, groupWeight: 90, insertion_order: 20 },
    { content: '无关组', keys: ['她'], insertion_order: 30 },
  ] })
  const { entries: picked, report } = planWorldBook(entries, [{ role: 'user', text: '她' }], { scanDepth: 0, budgetTokens: 1000 })
  assert.deepEqual(picked.map(entry => entry.content), ['重描述', '无关组'])
  assert.equal(report.droppedGroup.length, 1)
  assert.equal(report.droppedGroup[0].group, 'mood')
})

test('the token estimate counts CJK at one and ASCII at a quarter', () => {
  assert.equal(estimateTokens('尾巴'), 2)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens(''), 1)
})
