/**
 * `live2d_direct`: the session model hands the judge a draft.
 *
 * In the cross-session mode the stage belongs to the director. The session model
 * cannot drive the face itself, so this tool is its channel: it sends what it is
 * thinking or about to say, and the judge answers with the emotion, the line, the
 * expression and the motion — the same path the automatic turn-end call uses.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../lib/index.mjs'

/** A harness with a fake llm that answers the director's JSON. */
async function harnessWith({ director = true, reply, everyTurns, interaction } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-direct-'))
  process.env.DSH_HOME = home
  const packs = join(home, 'live2d', 'packs', 'ailian')
  await mkdir(join(packs, 'model'), { recursive: true })
  await writeFile(join(packs, 'model', 'ailian.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: 'a.moc3',
      Textures: ['t.png'],
      Expressions: [{ Name: 'smile', File: 's.exp3.json' }],
      Motions: { Idle: [{ File: 'i.motion3.json' }] },
    },
  }))
  await writeFile(join(packs, 'model', 'a.moc3'), 'moc')
  await writeFile(join(packs, 'model', 't.png'), 'png')
  await mkdir(join(home, 'live2d'), { recursive: true })
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify({ director, ...(everyTurns === undefined ? {} : { stageEveryTurns: everyTurns }), ...(interaction === undefined ? {} : { interaction }) }))

  const tools = []
  const seen = []
  const listeners = []
  const routes = []
  const llm = {
    async *stream(options) {
      seen.push(options)
      const text = reply ?? JSON.stringify({ emotion: 'joy', line: '别催。', expression: 'smile', motion: { group: 'Idle', index: 0 }, valence: 0.6, arousal: 0.2, affinity: 0.1 })
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(name, listener) {
      if (name === 'session/event') listeners.push(listener)
      return () => {}
    },
    inject(names, fn) {
      const face = {
        tools: { register: (definition) => { tools.push(definition); return () => {} } },
        systemPrompt: { section: () => () => {}, getSectionOrder: () => 100 },
        on: () => () => {},
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
  /** Emit one session event the way the Host does. */
  const emit = (sessionId, event) => {
    for (const listener of listeners) listener({ id: sessionId, header: { id: sessionId } }, event)
  }
  return { tools, seen, emit, routes }
}

test('the session model can hand a draft to the judge', async () => {
  const { tools, seen } = await harnessWith()
  const direct = tools.find(tool => tool.name === 'live2d_direct')
  assert.ok(direct !== undefined, 'the tool is registered')

  const answer = await direct.execute({ content: '她想说：别催我。', kind: 'thought' }, { agent: { id: 's1' } })
  assert.equal(answer.ok, true)
  assert.equal(answer.emotion, 'joy')
  // The line goes to the bubble; returning it would invite a repeat in chat.
  assert.equal(answer.line, undefined)
  assert.equal(answer.expression, 'smile')
  assert.deepEqual(answer.motion, { group: 'Idle', index: 0 })
  // The judge's prompt carries the draft and the model's own vocabulary.
  const prompt = seen[0].messages[0].content[0].text
  assert.match(prompt, /她心里正在想/)
  assert.match(prompt, /别催我/)
  assert.match(seen[0].system, /smile/)
})

test('the judge does not run when the cross-session mode is off', async () => {
  const { tools, seen } = await harnessWith({ director: false })
  const direct = tools.find(tool => tool.name === 'live2d_direct')
  const answer = await direct.execute({ content: '随便说点什么' }, { agent: { id: 's1' } })
  assert.equal(answer.ok, false)
  assert.match(answer.hint, /跨会话模式已关闭/)
  assert.equal(seen.length, 0, 'no model call is made')
})

test('an empty draft is refused before any call', async () => {
  const { tools, seen } = await harnessWith()
  const direct = tools.find(tool => tool.name === 'live2d_direct')
  const answer = await direct.execute({ content: '   ' }, { agent: { id: 's1' } })
  assert.equal(answer.ok, false)
  assert.equal(seen.length, 0)
})

test('the judge runs every Nth turn, counted instead of timed', async () => {
  const { seen, emit } = await harnessWith({ everyTurns: 2 })
  const user = (text) => ({ type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } })
  const assistant = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  const end = { type: 'turn/end' }

  // Turn 1: 1 % 2 !== 0, so the judge stays out.
  emit('s1', user('第一句'))
  emit('s1', assistant('嗯。'))
  emit('s1', end)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(seen.length, 0, 'no call on an off-cadence turn')

  // Turn 2: the counter reaches the interval and the judge takes over.
  emit('s1', user('第二句'))
  emit('s1', assistant('……'))
  emit('s1', end)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(seen.length, 1, 'exactly one call on the cadence turn')
})

test('a turn the cadence skipped still reaches the judge next time', async () => {
  const { seen, emit } = await harnessWith({ everyTurns: 2 })
  const user = (text) => ({ type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } })
  const assistant = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  const end = { type: 'turn/end' }

  // Turn 1 is skipped by the cadence, but its text is remembered for later.
  emit('s1', user('我下周要搬家'))
  emit('s1', assistant('……哦。'))
  emit('s1', end)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(seen.length, 0)

  // Turn 2 takes over and the judge sees the skipped turn in its prompt.
  emit('s1', user('东西好多'))
  emit('s1', assistant('要我帮忙吗。'))
  emit('s1', end)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(seen.length, 1)
  const prompt = seen[0].messages[0].content[0].text
  assert.match(prompt, /我下周要搬家/, 'the skipped turn is replayed')
  assert.match(prompt, /这一段里/)
})

test('a tap reaches the judge when the interaction mode is on', async () => {
  const { routes, seen, emit } = await harnessWith({ interaction: true, director: true })
  const user = (text) => ({ type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } })
  emit('s1', user('在这里。'))

  const route = routes.find(entry => entry.path.endsWith('/interact'))
  assert.ok(route !== undefined, 'the route is registered')
  const body = JSON.stringify({ kind: 'tap' })
  const res = {
    statusCode: 0,
    text: '',
    writeHead(code) { this.statusCode = code; return this },
    write(chunk) { this.text += String(chunk); return true },
    end(chunk) { if (chunk !== undefined) this.text += String(chunk) },
  }
  const req = {
    method: 'POST',
    url: route.path,
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
  await route.handler(req, res)
  assert.equal(res.statusCode, 200)
  const answer = JSON.parse(res.text)
  assert.equal(answer.ok, true)
  assert.equal(answer.emotion, 'joy')
  // The judge saw the gesture described in words.
  assert.match(seen[0].messages[0].content[0].text, /点了你一下/)
})

test('a tap is refused when the interaction mode is off', async () => {
  const { routes, seen, emit } = await harnessWith({ director: true })
  emit('s1', { type: 'user/message', data: { message: { content: [{ type: 'text', text: '嗯。' }] } } })
  const route = routes.find(entry => entry.path.endsWith('/interact'))
  const res = {
    statusCode: 0,
    text: '',
    writeHead(code) { this.statusCode = code; return this },
    write() { return true },
    end(chunk) { if (chunk !== undefined) this.text += String(chunk) },
  }
  const req = { method: 'POST', url: route.path, async *[Symbol.asyncIterator]() { yield Buffer.from('{"kind":"tap"}') } }
  await route.handler(req, res)
  assert.equal(res.statusCode, 409)
  assert.equal(seen.length, 0, 'no model call is made')
})
