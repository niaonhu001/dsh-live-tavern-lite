/**
 * Exercised against the operator's real settings, not test fixtures.
 *
 * Every route is called the way the browser calls it, and the status plus the
 * error body are printed, so a 400 on /config shows its cause instead of only
 * a blank page.
 */

import { apply } from '../lib/index.mjs'

const routes = []
const tools = []
const sections = []

const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on() { return () => {} },
  inject(_names, fn) {
    fn({
      tools: { register: (definition) => { tools.push(definition); return () => {} } },
      systemPrompt: {
        section: (section) => { sections.push(section); return () => {} },
        getSectionOrder: () => 100,
      },
      on: () => () => {},
      effect: ctx.effect,
    })
    return () => {}
  },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  logger: { info() {}, warn() {} },
}

try {
  apply(ctx, {})
} catch (error) {
  console.log('APPLY THREW:', error?.stack ?? error)
  process.exit(1)
}

const paths = ['/config', '/settings', '/params', '/status', '/worldbook', '/models/catalog', '/directory', '/rig', '/stage']
const byPath = new Map()
for (const route of routes) {
  const clean = route.path.replace(/\/$/, '')
  if (!byPath.has(clean)) byPath.set(clean, route)
}

for (const suffix of paths) {
  const route = routes.find(entry => entry.path.replace(/\/$/, '').endsWith(suffix))
  if (route === undefined) {
    console.log(`${suffix.padEnd(18)} MISSING`)
    continue
  }
  const res = {
    statusCode: 0,
    chunks: [],
    writeHead(code) { this.statusCode = code; return this },
    write(chunk) { this.chunks.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) this.chunks.push(String(chunk)) },
    setHeader() {},
  }
  const req = { method: 'GET', url: route.path, headers: {}, on() {}, once() {}, off() {} }
  try {
    await route.handler(req, res)
    const body = res.chunks.join('').replace(/\s+/g, ' ').slice(0, 220)
    console.log(`${suffix.padEnd(18)} ${res.statusCode}  ${body}`)
  } catch (error) {
    console.log(`${suffix.padEnd(18)} THREW  ${error?.message ?? error}`)
  }
}

console.log('\ntools:', tools.map(tool => tool.name).join(', '))
console.log('sections:', sections.map(section => section.name).join(', '))
const promptSection = sections.find(section => section.name === 'tool:live2d')
if (promptSection !== undefined) {
  try {
    const text = typeof promptSection.text === 'function' ? promptSection.text({}) : promptSection.text
    console.log('prompt length:', text.length, '| has 参数 id list:', text.includes('ParamAngle'))
  } catch (error) {
    console.log('PROMPT THREW:', error?.message ?? error)
  }
}
