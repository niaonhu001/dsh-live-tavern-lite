/**
 * Prompt sections must ship plain strings.
 *
 * The system-prompt assembler interpolates `section.text` directly with
 * `text.indexOf`, so a section that ships a function throws inside a live request
 * and takes the plugin fiber down with it — which is exactly how a prompt edit
 * once broke the whole stage. This check pins the contract without importing the
 * assembler: the plugin package does not resolve harness packages in tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.mjs'

function fakeContext() {
  const sections = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on() { return () => {} },
    inject(_names, fn) {
      fn({
        tools: { register: () => () => {} },
        systemPrompt: {
          section: (section) => { sections.push(section); return () => {} },
          getSectionOrder: () => 100,
        },
        on: () => () => {},
        effect: ctx.effect,
      })
      return () => {}
    },
    webServer: { register: () => () => {} },
    logger: { info() {}, warn() {} },
  }
  return { ctx, sections }
}

test('every prompt section ships a string the assembler can interpolate', () => {
  const harness = fakeContext()
  apply(harness.ctx, {})
  assert.ok(harness.sections.length > 0, 'sections registered')

  for (const section of harness.sections) {
    assert.equal(typeof section.name, 'string')
    // An interpolated section has its text passed straight to `text.indexOf`, so a
    // function there throws; only a literal section may compute its text.
    const literal = section.interpolate === false
    if (literal) {
      assert.ok(['string', 'function'].includes(typeof section.text), `section ${section.name}`)
    } else {
      assert.equal(typeof section.text, 'string', `section ${section.name} must ship a string`)
      assert.ok(!/\{\{[^}]*$/.test(section.text), `section ${section.name} ends inside a variable reference`)
    }
  }
})

test('the control section names the tool, the prototypes and the rig ids', () => {
  const harness = fakeContext()
  apply(harness.ctx, {})
  const section = harness.sections.find(entry => entry.name === 'tool:live2d')
  assert.ok(section !== undefined)
  // Literal section: the text is built per assembly so notes and ids stay current.
  const text = typeof section.text === 'function' ? section.text({}) : section.text
  assert.match(text, /live2d_act/)
  assert.match(text, /animation/)
  // The packaged rig supplies the ids, so a model can copy real parameter names.
  assert.match(text, /ParamAngleX/)
})
