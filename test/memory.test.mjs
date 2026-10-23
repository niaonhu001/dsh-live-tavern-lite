/** Pure tests for the layered memory module: importance, consolidation, summaries. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addFact,
  consolidate,
  factWeight,
  makeFact,
  mergeMemories,
  selectFacts,
  sharedRun,
} from '../lib/memory.mjs'

const empty = () => ({ version: 2, facts: [], summaries: [], affinity: 0, updatedAt: 0 })

test('a fact carries kind, importance and provenance', () => {
  const fact = makeFact({ text: '玩家答应周五前给答复', kind: 'promise', importance: 5 }, {
    source: { sessionId: 's1', round: 4 },
    now: 1_000,
  })
  assert.deepEqual(
    { kind: fact.kind, importance: fact.importance, at: fact.at, sessionId: fact.sessionId, round: fact.round },
    { kind: 'promise', importance: 5, at: 1_000, sessionId: 's1', round: 4 },
  )
  // Unknown kinds fall back to note, and importance is clamped to 1..5.
  assert.equal(makeFact({ text: 'x', kind: 'nonsense', importance: 99 }).kind, 'note')
  assert.equal(makeFact({ text: 'x', importance: 99 }).importance, 5)
  assert.equal(makeFact({ text: '   ' }), undefined)
})

test('importance and kind change the retention weight', () => {
  const promise = makeFact({ text: 'a', kind: 'promise', importance: 5 })
  const note = makeFact({ text: 'b', kind: 'note', importance: 1 })
  assert.ok(factWeight(promise) > factWeight(note) * 5)
})

test('a repeat is reinforced instead of duplicated', () => {
  let memory = addFact(empty(), { text: '玩家在写插件', kind: 'note', importance: 2 }).memory
  const again = addFact(memory, { text: '玩家在写插件', kind: 'note', importance: 2 })
  assert.equal(again.action, 'skipped', 'the same sentence is not stored twice')

  // A near-duplicate of the same kind is merged and gets stronger.
  const near = addFact(memory, { text: '玩家在写插件这件事', kind: 'note', importance: 2 })
  assert.equal(near.action, 'reinforced')
  assert.equal(near.memory.facts.length, 1)
  assert.ok(near.memory.facts[0].importance >= 3)
  assert.equal(near.memory.facts[0].reinforced, 2)
})

test('a contradicting fact replaces the one it supersedes', () => {
  const base = addFact(empty(), { text: '玩家喜欢被叫老板', kind: 'preference', importance: 3 }).memory
  const changed = addFact(base, { text: '玩家不喜欢被叫老板', kind: 'preference', importance: 4 })
  assert.equal(changed.action, 'replaced')
  assert.equal(changed.memory.facts.length, 1)
  assert.equal(changed.memory.facts[0].text, '玩家不喜欢被叫老板')
  assert.equal(changed.memory.facts[0].supersedes, '玩家喜欢被叫老板')
})

test('overflow is archived as a summary instead of dropped', () => {
  let memory = empty()
  const texts = ['玩家住在城东', '玩家有一只猫叫团子', '玩家讨厌香菜', '玩家在写插件', '玩家喜欢冰美式']
  texts.forEach((text, index) => {
    memory = addFact(memory, { text, kind: 'note', importance: index + 1 }, { source: { sessionId: 's', round: index } }).memory
  })
  memory = addFact(memory, { text: '玩家答应周五前给答复', kind: 'promise', importance: 5 }).memory
  const result = consolidate(memory, { maxFacts: 3 })
  assert.equal(result.memory.facts.length, 3)
  assert.equal(result.archived, 3)
  assert.equal(result.memory.summaries.length, 1)
  // The promise survives; the weakest notes become the summary line.
  assert.ok(result.memory.facts.some(fact => fact.kind === 'promise'))
  assert.match(result.memory.summaries[0].text, /玩家住在城东/)
})

test('selection prefers relevance and importance, and keeps summaries nearby', () => {
  const facts = [
    makeFact({ text: '玩家在写 Live2D 插件', kind: 'identity', importance: 5, at: 1 }),
    makeFact({ text: '玩家喜欢冰美式', kind: 'preference', importance: 2, at: 2 }),
  ]
  const digest = [{ role: 'user', text: '插件那个报错还在' }]
  const picked = selectFacts(facts, digest, { summaries: [{ text: '玩家搬到城东住了', at: 1 }] })
  assert.deepEqual(picked.facts.map(fact => fact.text), ['玩家在写 Live2D 插件'])
  assert.deepEqual(picked.summaries, [], 'an unrelated summary stays out')

  // Nothing relevant: the strongest facts travel rather than nothing.
  const idle = selectFacts(facts, [{ role: 'user', text: '嗯' }], {})
  assert.equal(idle.facts[0].text, '玩家在写 Live2D 插件')
})

test('merging sessions dedupes, keeps the strongest copy and averages mood', () => {
  const a = {
    facts: [makeFact({ text: '同一件事', kind: 'note', importance: 1, at: 1 })],
    summaries: [{ text: 'A 的摘要', at: 1 }],
    affinity: 0.4,
  }
  const b = {
    facts: [makeFact({ text: '同一件事', kind: 'identity', importance: 5, at: 2 })],
    summaries: [{ text: 'B 的摘要', at: 2 }],
    affinity: 0,
  }
  const merged = mergeMemories([a, b], { maxFacts: 10 })
  assert.equal(merged.facts.length, 1)
  assert.equal(merged.facts[0].importance, 5, 'the stronger copy wins')
  assert.deepEqual(merged.summaries.map(summary => summary.text), ['A 的摘要', 'B 的摘要'])
  assert.equal(merged.affinity, 0.2)
})

test('similarity needs a real shared run', () => {
  assert.ok(sharedRun('玩家在写插件', '玩家正在写插件') >= 4)
  assert.equal(sharedRun('玩家在写插件', '今天天气不错'), 0)
})
