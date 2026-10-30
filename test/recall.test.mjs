/** Pure tests for transcript rounds, recall search and fact selection. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDirectorPrompt, mergeDirectorMemory, selectRelevantFacts } from '../lib/director.mjs'
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

test('the transcript stays bounded', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ role: 'user', text: `第${index}句` }))
  assert.equal(trimTranscript(many, 4).length, 4)
  assert.equal(trimTranscript(many, 4)[3].text, '第9句')
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
