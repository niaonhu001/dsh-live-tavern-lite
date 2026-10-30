/**
 * The two cross-session flavours.
 *
 * `hybrid` (不带人设) keeps the session model a plain assistant: the avatar is driven
 * from the outside and the card stays out of its prompt. `persona` (带人设) hands the
 * card and the world book back to the session model while the line, the face and the
 * motion still come from the director.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, internals } from '../lib/index.mjs'
import { resolveDirectorConfig } from '../lib/director.mjs'

const { resolveConfig } = internals

const CARD_MARKER = 'CV-01 · 浅蓝短发'
const WORLD_MARKER = '牢屋敷只有十三名魔女候补'

/** One pack with a card, one always-on world-book entry and a Live2D model. */
async function personaHarness(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-persona-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'sherry')
  await mkdir(join(pack, 'model'), { recursive: true })
  await writeFile(join(pack, 'model', 'a.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: { Moc: 'a.moc3', Textures: ['t.png'] },
  }))
  await writeFile(join(pack, 'model', 'a.moc3'), 'moc')
  await writeFile(join(pack, 'model', 't.png'), 'png')
  await writeFile(join(pack, 'card.json'), JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '橘雪莉',
      description: CARD_MARKER,
      personality: '笑眯眯，几乎没有道德心。',
      scenario: '',
      mes_example: '',
    },
  }))
  await writeFile(join(pack, 'worldbook.json'), JSON.stringify({
    entries: [{ uid: 1, comment: '孤岛', content: WORLD_MARKER, constant: true }],
  }))
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({
    pack: 'sherry',
    director: options.director !== false,
    directorPersona: options.directorPersona === true,
  }))

  const sections = []
  const agentSections = []
  /** `agent/created` hooks and plain session listeners are keyed by event name. */
  const agentHooks = []
  const sessionListeners = []
  const tools = []
  const seen = []
  const routes = []
  const llm = {
    async *stream(request) {
      seen.push(request)
      yield { type: 'text-delta', text: JSON.stringify({ emotion: 'joy', line: '别催。', valence: 0.5, arousal: 0.2 }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const makeSectionSink = (sink) => ({
    section: (definition) => { sink.push(definition); return () => {} },
    getSectionOrder: () => 100,
    on: (name, listener) => {
      if (name === 'agent/created') agentHooks.push(listener)
      return () => {}
    },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  })
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(name, listener) {
      if (name === 'session/event') sessionListeners.push(listener)
      return () => {}
    },
    inject(names, fn) {
      const face = {
        tools: { register: (definition) => { tools.push(definition); return () => {} } },
        systemPrompt: makeSectionSink(sections),
        on: (name, listener) => {
          if (name === 'agent/created') agentHooks.push(listener)
          return () => {}
        },
        effect: ctx.effect,
      }
      if (names.includes('llm')) {
        face.llm = llm
        face.agentDefaultModel = { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      }
      fn(face)
      return () => {}
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, {})

  /** Fire the agent/created hook the way the Host does, capturing scoped sections. */
  const createAgent = (sessionId) => {
    for (const hook of agentHooks) {
      hook({ agent: { id: sessionId, ctx: { effect: (fn) => { fn() }, systemPrompt: makeSectionSink(agentSections) } } })
    }
  }
  const sectionText = (list, name) => {
    const found = list.find(entry => entry.name === name)
    if (found === undefined) return undefined
    return typeof found.text === 'function' ? found.text() : found.text
  }
  const emit = (sessionId, event) => {
    for (const listener of sessionListeners) listener({ id: sessionId, header: { id: sessionId } }, event)
  }
  return { home, pack, tools, seen, routes, sections, agentSections, createAgent, sectionText, emit }
}

test('one mode value picks the cross-session flavour', async () => {
  // `resolveConfig` layers the settings file over the row config; without a
  // throwaway DSH_HOME this test would read the developer's own `directorMode`.
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-mode-'))
  assert.equal(resolveDirectorConfig({ directorMode: 'off' }).mode, 'off')
  assert.equal(resolveDirectorConfig({ directorMode: 'hybrid' }).mode, 'hybrid')
  assert.equal(resolveDirectorConfig({ directorMode: 'persona' }).mode, 'persona')
  assert.throws(() => resolveDirectorConfig({ directorMode: 'nope' }), /directorMode/)
  // A settings file from before the picker still resolves: boolean + persona flag.
  assert.equal(resolveDirectorConfig({ director: true }).mode, 'hybrid')
  assert.equal(resolveDirectorConfig({ director: true, directorPersona: true }).mode, 'persona')
  assert.equal(resolveDirectorConfig({ director: false, directorPersona: true }).mode, 'off')
  assert.equal(resolveDirectorConfig({}).mode, 'hybrid')
  // The resolved config carries the mode, and a legacy pair maps onto it.
  assert.equal(resolveConfig({ directorMode: 'persona' }).directorMode, 'persona')
  assert.equal(resolveConfig({ director: true, directorPersona: true }).directorMode, 'persona')
  assert.equal(resolveConfig({ director: false }).directorMode, 'off')
})

test('without the persona mode the card and the world book stay out of the session prompt', async () => {
  const harness = await personaHarness({ director: true, directorPersona: false })
  assert.equal(harness.sectionText(harness.sections, 'live2d:card'), '')
  harness.createAgent('s1')
  assert.equal(harness.sectionText(harness.agentSections, 'live2d:worldbook'), '')
})

test('the persona mode puts the card and the world book back into the session prompt', async () => {
  const harness = await personaHarness({ director: true, directorPersona: true })
  const card = harness.sectionText(harness.sections, 'live2d:card')
  assert.match(card, new RegExp('橘雪莉'))
  assert.match(card, new RegExp(CARD_MARKER))
  harness.createAgent('s1')
  const world = harness.sectionText(harness.agentSections, 'live2d:worldbook')
  assert.match(world, new RegExp(WORLD_MARKER))
})

test('the director writes her line as her: the card and the live entries reach its prompt', async () => {
  const harness = await personaHarness({ director: true, directorPersona: true })
  harness.createAgent('s1')
  // Prompt assembly for this session fills the world-book plan the judge reuses.
  harness.sectionText(harness.agentSections, 'live2d:worldbook')
  const direct = harness.tools.find(tool => tool.name === 'live2d_direct')
  assert.ok(direct !== undefined, 'the direct tool is registered')
  const answer = await direct.execute({ content: '她想说：别催。', kind: 'thought' }, { agent: { id: 's1' } })
  assert.equal(answer.ok, true)
  const system = harness.seen[0]?.system ?? ''
  assert.match(system, new RegExp(CARD_MARKER), 'the director sees the character card')
  assert.match(system, new RegExp(WORLD_MARKER), 'and the entries the world book is injecting')
})

test('the plain cross-session mode keeps the director prompt free of the card', async () => {
  const harness = await personaHarness({ director: true, directorPersona: false })
  harness.createAgent('s1')
  const direct = harness.tools.find(tool => tool.name === 'live2d_direct')
  const answer = await direct.execute({ content: '她想说：别催。', kind: 'thought' }, { agent: { id: 's1' } })
  assert.equal(answer.ok, true)
  const system = harness.seen[0]?.system ?? ''
  assert.doesNotMatch(system, new RegExp(CARD_MARKER))
  assert.doesNotMatch(system, new RegExp(WORLD_MARKER))
})

test('the settings page offers one mode select under the cross-session block', async () => {
  const harness = await personaHarness({ director: true, directorPersona: true })
  const route = harness.routes.find(entry => entry.path.endsWith('/settings'))
  assert.ok(route !== undefined, 'the settings route is registered')
  const res = {
    statusCode: 0,
    text: '',
    writeHead(code) { this.statusCode = code; return this },
    write(chunk) { this.text += String(chunk); return true },
    end(chunk) { if (chunk !== undefined) this.text += String(chunk) },
  }
  await route.handler({ method: 'GET', url: route.path, headers: {}, async *[Symbol.asyncIterator]() {} }, res)
  const payload = JSON.parse(res.text)
  const field = payload.fields.find(entry => entry.key === 'directorMode')
  assert.ok(field !== undefined, 'the mode field is offered')
  assert.equal(field.section, 'director')
  assert.equal(field.kind, 'select')
  assert.deepEqual(field.options, ['off', 'hybrid', 'persona'])
  // No leftover second switch: one control decides the mode.
  assert.equal(payload.fields.some(entry => entry.key === 'directorPersona'), false)
  assert.equal(payload.values.directorMode, 'persona')
  // The dependent rows key off the mode now.
  const memory = payload.fields.find(entry => entry.key === 'memoryScope')
  assert.deepEqual(memory.showWhen, { key: 'directorMode', notEquals: 'off' })
})

test('the persona mode still lets the judge act on the turn cadence', async () => {
  const harness = await personaHarness({ director: true, directorPersona: true })
  const user = (text) => ({ type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } })
  const assistant = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  harness.emit('s1', user('你看这个。'))
  harness.emit('s1', assistant('……嗯。'))
  harness.emit('s1', { type: 'turn/end' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(harness.seen.length, 1, 'the turn-end call reaches the director in persona mode too')
})
