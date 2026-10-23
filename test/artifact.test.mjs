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
