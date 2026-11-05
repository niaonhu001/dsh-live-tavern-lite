/** Pure tests for transcript rounds, recall search and fact selection. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDirectorPrompt, mergeDirectorMemory, selectRelevantFacts } from '../lib/director.mjs'
import { digestReply } from '../lib/memory.mjs'
import { buildRounds, normalizeForSearch, readRounds, searchRounds, trimTranscript } from '../lib/recall.mjs'

const TRANSCRIPT = [
  { role: 'user', text: '你的尾巴在动' },
  { role: 'assistant', text: '……热的。' },
  { role: 'user', text: '明天去海沟那边吗' },
  { role: 'assistant', text: '随你。反正也是加班。' },
]

test('a round starts at a user line and carries the reply', () => {
  const rounds = buildRounds(TRANSCRIPT)
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0].user, '你的尾巴在动')
  assert.equal(rounds[0].assistant, '……热的。')
  assert.equal(rounds[1].round, 2)
  // A leading greeting belongs to the first round rather than being dropped.
  assert.equal(buildRounds([{ role: 'assistant', text: '欢迎' }])[0].user, '')
})

test('search returns a short directory ranked by where the phrase appears', () => {
  const rounds = buildRounds(TRANSCRIPT)
  const found = searchRounds(rounds, '尾巴')
  assert.equal(found.found, true)
  assert.equal(found.hits.length, 1)
  assert.equal(found.hits[0].round, 1)
  assert.equal(found.hits[0].where, 'user')
  // Punctuation and case do not matter.
  assert.equal(searchRounds(rounds, '海沟').found, true)
  assert.equal(normalizeForSearch('……热的。'), '热的')
  const missing = searchRounds(rounds, '不存在的词')
  assert.equal(missing.found, false)
  assert.deepEqual(missing.hits, [])
})

test('reading a round brings its neighbours when asked', () => {
  const rounds = buildRounds(TRANSCRIPT)
  assert.deepEqual(readRounds(rounds, 2).map(entry => entry.round), [2])
  assert.deepEqual(readRounds(rounds, 2, { radius: 1 }).map(entry => entry.round), [1, 2])
  assert.deepEqual(readRounds(rounds, 99), [])
})

test('the transcript stays under a byte budget, not an entry count', () => {
  const many = Array.from({ length: 400 }, (_, index) => ({ role: 'user', text: `第${index}句，长度差不多的一句话` }))
  // Well under the budget: nothing is dropped, however many entries that is.
  assert.equal(trimTranscript(many, 10 * 1024 * 1024).length, 400)
  // A small budget keeps only the tail, and the newest entry is always kept.
  const trimmed = trimTranscript(many, 2048)
  assert.ok(trimmed.length < 400)
  assert.equal(trimmed[trimmed.length - 1].text, many[399].text)
  // One oversized entry still survives: dropping what was just said is worse.
  const huge = [{ role: 'assistant', text: 'x'.repeat(5000) }]
  assert.equal(trimTranscript(huge, 1024).length, 1)
})

test('a reply is digested to its sentences and loses its scaffolding', () => {
  const reply = [
    '先说结论：这条通不过。',
    '',
    '```js',
    'const x = 1',
    '```',
    '',
    '| 列 | 值 |',
    '| --- | --- |',
    '',
    '原因是缓存没失效。清掉再试一次。',
  ].join('\n')
  const digest = digestReply(reply)
  assert.match(digest, /先说结论/)
  assert.match(digest, /原因是缓存没失效/)
  // Nothing is abridged: the second sentence of the paragraph stays too.
  assert.match(digest, /清掉再试一次/)
  assert.doesNotMatch(digest, /const x = 1/)
  assert.doesNotMatch(digest, /\| 列 \| 值 \|/)
  // A plain paragraph comes back word for word.
  assert.equal(digestReply('第一句。第二句。第三句。'), '第一句。第二句。第三句。')
  // A reply that was nothing but code leaves nothing worth keeping.
  assert.equal(digestReply('```js\nconst y = 2\n```'), '')
  assert.equal(digestReply(''), '')
})

test('a spoken line joins the round as performed speech, not as a reply', () => {
  const rounds = buildRounds([
    { role: 'user', text: '过来' },
    { role: 'assistant', kind: 'line', text: '来了。' },
    { role: 'assistant', kind: 'digest', text: '她贴到了边框上。' },
  ])
  assert.equal(rounds.length, 1)
  // Both are assistant speech in one round, but only the bubble is marked performed.
  assert.match(rounds[0].assistant, /〔气泡〕来了。/)
  assert.match(rounds[0].assistant, /她贴到了边框上。/)
  assert.doesNotMatch(rounds[0].assistant, /〔气泡〕她贴到了边框上/)
})

test('only facts that touch the current conversation travel with the prompt', () => {
  const facts = [
    { text: '玩家在调试 Live2D 插件', at: 1 },
    { text: '玩家喜欢喝美式', at: 2 },
    { text: '玩家养了一只叫团子的猫', at: 3 },
  ]
  const digest = [{ role: 'user', text: '插件又报错了，看看 Live2D 的日志' }]
  const chosen = selectRelevantFacts(facts, digest, { limit: 8 })
  assert.deepEqual(chosen.map(fact => fact.text), ['玩家在调试 Live2D 插件'])

  // With nothing in common the newest few stay as background instead of all of them.
  const unrelated = selectRelevantFacts(facts, [{ role: 'user', text: '嗯。' }], { limit: 8 })
  assert.equal(unrelated.length, 3)
  assert.equal(unrelated[0].text, '玩家养了一只叫团子的猫')

  // The prompt itself only carries the selected lines.
  const prompt = buildDirectorPrompt({
    library: { prototypes: [{ id: 'neutral', label: '平静' }] },
    memory: { facts, affinity: 0 },
    digest,
  })
  assert.match(prompt.user, /Live2D 插件/)
  assert.doesNotMatch(prompt.user, /美式/)
})

test('a new fact records where it came from', () => {
  const before = { version: 1, facts: [], affinity: 0, updatedAt: 0 }
  const { memory } = mergeDirectorMemory(before, { remember: '玩家在写插件' }, {
    maxFacts: 24,
    source: { sessionId: 's1', round: 7 },
  })
  assert.equal(memory.facts[0].sessionId, 's1')
  assert.equal(memory.facts[0].round, 7)
  assert.ok(Number.isFinite(memory.facts[0].at))
})

test('the judge is offered animation channels, so a gesture is possible at all', () => {
  const library = {
    prototypes: [{ id: 'neutral', label: '平静', valence: 0, arousal: 0, dominance: 0, intensity: 0 }],
    byId: new Map(),
  }
  const prompt = buildDirectorPrompt({
    library,
    memory: { facts: [] },
    digest: [],
    channels: ['BoneHeadX', 'BoneHeadZ'],
    stageKind: 'vrm',
  })
  // Without a channel list the reply schema cannot name a bone, and she would only
  // ever change expression.
  assert.match(prompt.system, /"animation"/)
  assert.match(prompt.system, /可用的动作通道/)
  assert.match(prompt.system, /BoneHeadX/)
  assert.match(prompt.system, /BoneHeadX=12@160/)

  // A model that offers none must not be told to invent one.
  const bare = buildDirectorPrompt({ library, memory: { facts: [] }, digest: [] })
  assert.doesNotMatch(bare.system, /可用的动作通道/)
})

test('a Live2D judge is offered parameters, never bone channels', () => {
  const library = {
    prototypes: [{ id: 'neutral', label: '平静', valence: 0, arousal: 0, dominance: 0, intensity: 0 }],
    byId: new Map(),
  }
  const prompt = buildDirectorPrompt({
    library,
    memory: { facts: [] },
    digest: [],
    channels: ['ParamAngleY', 'ParamAngleZ'],
  })
  // The rig is parameters, not bones: degrees and Bone* examples would describe a
  // skeleton this model does not have.
  assert.match(prompt.system, /可用的参数 id/)
  assert.match(prompt.system, /ParamAngleY/)
  assert.match(prompt.system, /ParamAngleY=8@140/)
  assert.doesNotMatch(prompt.system, /可用的动作通道/)
  assert.doesNotMatch(prompt.system, /BoneHeadX=12@160/)
})
