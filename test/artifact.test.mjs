/**
 * The browser artifact is generated, so its packaging is easy to break in a way
 * no Host test notices: the module table needs one classic script that calls
 * `__ModuleLoader__.load` with this package's id, after the Cubism runtime that
 * the engine reads from `window` at module scope, and the whole bundle must be
 * inlined because the table cannot load split chunks.
 *
 * This evaluates the real artifact against a stub loader and asserts the
 * wrapper contract. It stops short of rendering: that needs a browser.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const ARTIFACT = new URL('../lib/client.js', import.meta.url)

/** Evaluate the artifact in an isolated context whose `window` is its own global. */
async function runArtifact() {
  const source = await readFile(ARTIFACT, 'utf8')
  const registered = []
  const sandbox = {
    __ModuleLoader__: {
      load(registration) {
        registered.push(registration)
      },
    },
    document: {
      createElement: () => ({ style: {}, setAttribute() {}, append() {}, addEventListener() {} }),
      head: { append() {} },
      body: { append() {} },
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
    },
    navigator: { userAgent: 'node' },
    location: { pathname: '/', search: '' },
    performance: { now: () => Date.now() },
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    atob,
    btoa,
    TextDecoder,
    TextEncoder,
    WebAssembly,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    EventSource: class {
      addEventListener() {}
      close() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    HTMLCanvasElement: class {},
    Image: class {},
    Audio: class {},
  }
  // A browser's top-level `var` lands on `window`; the Cubism runtime publishes
  // itself that way, and the engine reads it back through `window`.
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, vm.isContext(sandbox) ? sandbox : undefined, { filename: 'client.js' })
  return { registered, sandbox }
}

test('the artifact registers exactly one client module under the package id', async () => {
  const { registered } = await runArtifact()
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'dsh-live-tavern-lite')
  assert.equal(typeof registered[0].factory, 'function')
})

test('the Cubism runtime is parsed before the module table registration', async () => {
  const source = await readFile(ARTIFACT, 'utf8')
  const coreAt = source.indexOf('var Live2DCubismCore')
  const loaderAt = source.indexOf('__ModuleLoader__.load')
  assert.ok(coreAt > 0, 'artifact inlines the Cubism runtime')
  assert.ok(loaderAt > coreAt, 'the runtime is parsed before the plugin registers')
  assert.match(source, /id: 'dsh-live-tavern-lite'/)
})

test('the frosted low-opacity delivery covers input, bubbles and the assistant body', async () => {
  const source = await readFile(ARTIFACT, 'utf8')
  // The hooks are the shipped shell's own attributes and class stems: the input
  // card and the message bubble carry them verbatim, while the assistant body is
  // the `assistant-step` flow kind — `assistant` is only the folded final
  // message and never owns a flow row, so a rule keyed on it is dead.
  for (const hook of ['[data-composer-card]', '[class*="bubble"]', '[data-chat-flow-kind="assistant-step"]']) {
    assert.ok(source.includes(hook), `frost rules target ${hook}`)
  }
  assert.match(source, /data-dsh-l2d-frost/)
  // Transparency is one document variable the settings form moves, so a hard-coded
  // colour-mix percentage would silently pin the glass again.
  assert.match(source, /--dsh-l2d-frost-alpha/)
  // The blur rides the same setting: a pane that blurs 18px still reads as opaque
  // even when its colour share is zero, so both have to come from the variable.
  assert.match(source, /--dsh-l2d-frost-blur/)
  assert.doesNotMatch(source, /backdrop-filter:blur\(18px\)/, 'no pinned blur radius')
  // The frame and the centre column sit between her layer and those panels: an
  // opaque fill there leaves the glass blurring a flat backdrop, which is why the
  // concentration used to look inert. They must fade by the shared wash variable
  // rather than turning into a hole, or the mode would ignore the setting.
  const frostLayers = source.slice(source.indexOf('html[data-dsh-l2d-frost] [data-dsh-l2d-frame]'))
  const frameRule = frostLayers.slice(0, frostLayers.indexOf('}'))
  assert.ok(frameRule.includes('--dsh-l2d-clear-alpha'), 'frost layers follow the wash setting')
  assert.ok(!frameRule.includes('background-color:transparent'), 'frost layers are not a hole')
  assert.ok(
    source.includes('html[data-dsh-l2d-frost] [class*="centerCol"]'),
    'frost clears the centre column fill',
  )
  // The opacity setting belongs to the shell: she never fades with it.
  assert.match(source, /model\.alpha = 1\b/)
  assert.doesNotMatch(source, /model\.alpha = S2?\.config\.opacity/)
})

test('the wrapper is self-contained and exposes only apply', async () => {
  const source = await readFile(ARTIFACT, 'utf8')
  // The module table cannot load split chunks, so nothing may be dynamic.
  assert.doesNotMatch(source, /\bimport\s*\(/)
  // Host-provided modules must stay external; everything else is inlined.
  assert.doesNotMatch(source, /require\("(?:pixi\.js|untitled-pixi-live2d-engine)/)
  assert.match(source, /var module = \{ exports: \{\} \}/)
  assert.match(source, /return module\.exports/)
  assert.match(source, /apply: \(\) => apply/)
})
