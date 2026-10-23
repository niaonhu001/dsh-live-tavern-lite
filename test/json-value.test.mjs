/**
 * The tool result must survive the harness's lossless-JSON gate.
 *
 * `tools.execute()` snapshots every result with `snapshotJsonValue` and rejects
 * anything an object literal can hold but JSON cannot — most commonly an
 * `undefined` member. That rejection reaches the model as a tool error, so the
 * control tool would look "broken" while doing its work. These tests import the
 * real checker from the DSH checkout instead of re-implementing its rules.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate from the real profile: its settings.json pins absolute directories.
const TEST_HOME = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-home-'))
process.env.DSH_HOME = TEST_HOME

const { apply } = await import('../lib/index.mjs')

const CHECKOUT = 'E:/program/deepseek-harness/packages/util/values/lib/index.js'
const available = existsSync(CHECKOUT)
const values = available ? await import(pathToFileURL(CHECKOUT).href) : undefined
const TOOLS_CHECKOUT = 'E:/program/deepseek-harness/packages/core/tools/lib/index.js'
const toolsAvailable = existsSync(TOOLS_CHECKOUT)
const toolsLib = toolsAvailable ? await import(pathToFileURL(TOOLS_CHECKOUT).href) : undefined

/** A capture-only context: this test cares about tool values, not HTTP. */
function harness() {
  const tools = []
  const ctx = {
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    on: () => () => {},
    inject: (names, callback) => {
      const child = { effect: ctx.effect, on: ctx.on }
      if (names.includes('tools')) {
        child.tools = {
          register(definition) {
            tools.push(definition)
            return () => {}
          },
        }
      }
      if (names.includes('systemPrompt')) {
        child.systemPrompt = { section: () => () => {}, getSectionOrder: () => 2400 }
      }
      return callback(child)
    },
    effect: fn => {
      const dispose = fn()
      return dispose
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, tools }
}

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-json-'))
  await mkdir(join(root, 'demo'), { recursive: true })
  await writeFile(join(root, 'demo', 'demo.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: 'demo.moc3',
      Textures: [],
      Expressions: [{ Name: 'alpha', File: 'a.exp3.json' }],
      Motions: { '': [{ File: 'idle.motion3.json' }] },
    },
  }))
  await writeFile(join(root, 'demo', 'binding.json'), JSON.stringify({
    version: 1,
    expressions: { alpha: { emotion: 'joy', valence: 0.8, arousal: 0.5 } },
  }))
  return root
}

test('a tool result is lossless JSON for every request shape', { skip: !available && 'DSH checkout not present' }, async () => {
  const root = await fixtureRoot()
  const { ctx, tools } = harness()
  apply(ctx, { modelsRoot: root })
  const tool = tools.find(entry => entry.name === 'live2d_act')
  assert.ok(tool, 'live2d_act registered')

  const cases = [
    { emotion: 'joy', line: '在的' },
    { emotion: 'joy', expression: 'alpha' },
    { emotion: 'wistful' },
    { emotion: 'sad', motion: { group: '', index: 0 } },
  ]
  for (const args of cases) {
    const value = await tool.execute(args, { agent: { id: 's1' } })
    assert.equal(values.isJsonValue(value), true, `result for ${JSON.stringify(args)} must be lossless JSON`)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
    for (const [key, member] of Object.entries(value)) {
      assert.notEqual(member, undefined, `${key} must not be undefined`)
    }
  }
})

test('an undefined member is rejected by the real checker', { skip: !available && 'DSH checkout not present' }, () => {
  assert.equal(values.isJsonValue({ ok: true, hint: undefined }), false)
  assert.equal(values.isJsonValue({ ok: true, hint: null }), true)
})

test('every tool result also satisfies its own output schema', { skip: !toolsAvailable && 'DSH checkout not present' }, async () => {
  const root = await fixtureRoot()
  const { ctx, tools } = harness()
  apply(ctx, { modelsRoot: root })
  const tool = tools.find(entry => entry.name === 'live2d_act')
  assert.ok(tool, 'live2d_act registered')

  // The registry validates the returned value against output.schema, so a valid
  // schema is not enough — the value must conform to it. A `null` for an
  // object-typed field fails here even though null is legal JSON.
  const cases = [
    { emotion: 'joy', line: '在的' },
    { emotion: 'joy', expression: 'alpha' },
    { emotion: 'wistful' },
    { emotion: 'sad', motion: { group: '', index: 0 } },
    { emotion: 'anger', expression: 'alpha', motion: { group: '', index: 0 }, line: '哼' },
  ]
  for (const args of cases) {
    const value = await tool.execute(args, { agent: { id: 's1' } })
    const violations = toolsLib.validateJsonSchemaValue(tool.output.schema, value)
    assert.deepEqual(violations, [], `result for ${JSON.stringify(args)} violates its schema`)
  }
})
