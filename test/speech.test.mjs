/** The spoken line is cut at a sentence boundary, never mid-word. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { trimToSentence } from '../lib/speech.mjs'

test('a short line is untouched', () => {
  assert.equal(trimToSentence('……热的。', 160), '……热的。')
  assert.equal(trimToSentence('  嗯  ', 160), '嗯')
})

test('a long line keeps whole sentences', () => {
  const line = '她说了很久。然后又说了很多。最后一句在这里还没有结束'
  // 20 fits the first two sentences (14 characters) and not the third.
  assert.equal(trimToSentence(line, 20), '她说了很久。然后又说了很多。')
})

test('quoting marks travel with the sentence they close', () => {
  const line = '「我记得你。」她说。「别乱想。」'
  assert.equal(trimToSentence(line, 12), '「我记得你。」她说。')
})

test('a tiny limit still lands on a sentence, not a fragment', () => {
  const line = '别催。我还没睡醒呢，再等一下下就好，真的就一下下。'
  // The floor is 8 characters, and the first sentence fits inside it.
  assert.equal(trimToSentence(line, 3), '别催。')
})

test('a sentence longer than the limit keeps one sentence and marks the cut', () => {
  const line = '她一直在说个不停说了很久很久都没有停下来过。下一句。'
  const trimmed = trimToSentence(line, 10)
  assert.equal(trimmed, '她一直在说个不停说了很久很久都没有停下来过。…')
  assert.ok(trimmed.startsWith('她一直在说'))
})

test('text without any sentence mark is cut with an ellipsis', () => {
  const trimmed = trimToSentence('一二三四五六七八九十', 8)
  assert.equal(trimmed.endsWith('…'), true)
  assert.ok(trimmed.length <= 8)
})
