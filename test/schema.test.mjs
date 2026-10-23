/**
 * Validate the control tool's schemas with the harness's own validator.
 *
 * `tools.register()` rejects a definition whose output schema leaves the
 * supported JSON-Schema subset — and it does so by throwing, which used to make
 * the tool vanish without a trace. These tests import the real
 * `assertSupportedJsonSchema` from the DSH checkout instead of a copy of the
 * rules, so a regression fails here rather than disappearing in production.
 *
 * The checkout may be absent (plugin installed on a machine without it); the
 * suite then skips explicitly rather than pretending to have checked.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

import { internals } from '../lib/index.mjs'

const CHECKOUT = 'E:/program/deepseek-harness/packages/core/tools/lib/index.js'
const available = existsSync(CHECKOUT)
const validator = available ? await import(pathToFileURL(CHECKOUT).href) : undefined

test('the control tool output schema passes the harness validator', { skip: !available && 'DSH checkout not present' }, () => {
  assert.equal(typeof validator.assertSupportedJsonSchema, 'function')
  assert.doesNotThrow(() => validator.assertSupportedJsonSchema(internals.actToolSchemas.output))
})

test('the control tool parameter schema passes the harness validator', { skip: !available && 'DSH checkout not present' }, () => {
  // The registry forwards parameters verbatim, but the model API needs a schema
  // it accepts; the supported subset is the safest proxy for that.
  assert.doesNotThrow(() => validator.assertSupportedJsonSchema(internals.actToolSchemas.parameters))
})

test('a type array is rejected — the exact mistake this guard exists for', { skip: !available && 'DSH checkout not present' }, () => {
  assert.throws(
    () => validator.assertSupportedJsonSchema({
      type: 'object',
      properties: { expression: { type: ['string', 'null'] } },
      required: [],
    }),
    /single type string/,
  )
})

test('the declared schemas stay inside the documented subset', () => {
  const keywords = new Set([
    'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
    'enum', 'const', 'description', 'title', 'default', 'examples',
  ])
  const walk = (node, path) => {
    assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${path} must be a schema object`)
    for (const key of Object.keys(node)) assert.ok(keywords.has(key), `${path}.${key} is unsupported`)
    if (node.type !== undefined) assert.equal(typeof node.type, 'string', `${path}.type must be a single string`)
    for (const [name, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.properties.${name}`)
    if (node.items !== undefined) walk(node.items, `${path}.items`)
  }
  walk(internals.actToolSchemas.output, 'output')
  walk(internals.actToolSchemas.parameters, 'parameters')
})
