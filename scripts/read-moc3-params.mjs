/**
 * Read one moc3's parameter table (id, min, max, default) with the bundled Cubism
 * Core, so a rig table can quote the model's real ranges instead of guesses.
 *
 * Usage: node scripts/read-moc3-params.mjs <model.moc3> [out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const corePath = join(root, 'assets', 'vendor', 'live2dcubismcore.min.js')

const [, , source, target] = process.argv
if (source === undefined) {
  console.error('usage: node scripts/read-moc3-params.mjs <model.moc3> [out.json]')
  process.exit(1)
}

globalThis.window = globalThis
globalThis.self = globalThis
globalThis.document = {
  createElement: () => ({ getContext: () => null, style: {} }),
  addEventListener() {},
  querySelector: () => null,
}

const code = readFileSync(corePath, 'utf8')
try {
  // eslint-disable-next-line no-eval
  ;(0, eval)(code)
} catch {
  // The script publishes `Live2DCubismCore` before anything that touches the DOM.
}

const core = globalThis.Live2DCubismCore
if (core === undefined) {
  console.error('core did not load')
  process.exit(1)
}

/** Resolve once the embedded wasm runtime is ready. */
const ready = () => new Promise((resolveReady, rejectReady) => {
  if (core.Model?.fromMoc !== undefined && core._ready !== false) {
    // The runtime is initialised lazily on first use in the browser; give it a turn here too.
    setTimeout(resolveReady, 1200)
    return
  }
  setTimeout(resolveReady, 1200)
  void rejectReady
})

await ready()

const buffer = readFileSync(source)
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)

const moc = core.Moc.fromArrayBuffer(arrayBuffer)
const model = core.Model.fromMoc(moc)
const parameters = model.parameters
const count = parameters.count

/** One parameter id, whichever string wrapper the Core build uses. */
function idAt(index) {
  const ids = parameters.ids
  const entry = typeof ids.at === 'function' ? ids.at(index) : ids[index]
  if (typeof entry === 'string') return entry
  if (typeof entry?.getString === 'function') return entry.getString()
  if (typeof entry?.s === 'string') return entry.s
  return String(entry ?? '')
}

const rows = []
for (let index = 0; index < count; index += 1) {
  rows.push({
    id: idAt(index),
    min: parameters.minimumValues.at(index),
    max: parameters.maximumValues.at(index),
    base: parameters.defaultValues.at(index),
  })
}

const payload = { source, count, parameters: rows }
if (target !== undefined) {
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`wrote ${target} (${count} parameters)`)
} else {
  console.log(JSON.stringify(payload, null, 2))
}
