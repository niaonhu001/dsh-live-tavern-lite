/**
 * Per-session memory, and the scope that decides how much of it a turn sees.
 *
 * A session writes only its own file; the cross-session mode's `session` scope
 * reads that one file, and `all` adds the character's other sessions. Memory never
 * crosses packs, because the directories are per pack.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../lib/index.mjs'

async function harnessWith(settings = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-live-tavern-mem-'))
  process.env.DSH_HOME = home
  const pack = join(home, 'live2d', 'packs', 'ailian')
  await mkdir(join(pack, 'model'), { recursive: true })
  await writeFile(join(pack, 'model', 'ailian.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: { Moc: 'a.moc3', Textures: ['t.png'] },
  }))
  await writeFile(join(pack, 'model', 'a.moc3'), 'moc')
  await writeFile(join(pack, 'model', 't.png'), 'png')
  await writeFile(join(pack, 'settings-plan.json'), '{}')
  await mkdir(join(home, 'live2d'), { recursive: true })
  await writeFile(join(home, 'live2d', 'settings.json'), JSON.stringify(settings))

  const tools = []
  const routes = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on() { return () => {} },
    inject(_names, fn) {
      fn({
        tools: { register: (definition) => { tools.push(definition); return () => {} } },
        systemPrompt: { section: () => () => {}, getSectionOrder: () => 100 },
        on: () => () => {},
        effect: ctx.effect,
      })
      return () => {}
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, {})
  return { home, pack, tools }
}

test('each session remembers into its own file', async () => {
  const { pack, tools } = await harnessWith()
  const remember = tools.find(tool => tool.name === 'live2d_remember')
  assert.ok(remember !== undefined, 'the session can write memory without the director')

  const first = await remember.execute({ text: '玩家在写一个 Live2D 插件' }, { agent: { id: 'session-a' } })
  assert.equal(first.stored, true)
  assert.equal(first.total, 1)

  const again = await remember.execute({ text: '玩家在写一个 Live2D 插件' }, { agent: { id: 'session-a' } })
  assert.equal(again.stored, false, 'the same sentence is not stored twice')

  await remember.execute({ text: '玩家养了一只猫' }, { agent: { id: 'session-b' } })

  const a = JSON.parse(await readFile(join(pack, 'memory', 'session-a.json'), 'utf8'))
  const b = JSON.parse(await readFile(join(pack, 'memory', 'session-b.json'), 'utf8'))
  assert.deepEqual(a.facts.map(fact => fact.text), ['玩家在写一个 Live2D 插件'])
  assert.deepEqual(b.facts.map(fact => fact.text), ['玩家养了一只猫'])
  // Provenance still points at the session that wrote it.
  assert.equal(a.facts[0].sessionId, 'session-a')
})

test('the per-session cap is the configured one', async () => {
  const { pack, tools } = await harnessWith({ sessionMaxFacts: 2 })
  const remember = tools.find(tool => tool.name === 'live2d_remember')
  for (const text of ['一', '二', '三']) {
    await remember.execute({ text }, { agent: { id: 'cap' } })
  }
  const memory = JSON.parse(await readFile(join(pack, 'memory', 'cap.json'), 'utf8'))
  assert.equal(memory.facts.length, 2, 'older facts are dropped at the cap')
  assert.deepEqual(memory.facts.map(fact => fact.text), ['二', '三'])
  assert.equal(memory.facts[1].text, '三')
})

test('memory never leaves the character that owns it', async () => {
  const { home, pack, tools } = await harnessWith()
  // A second character with its own model: its directory must stay untouched.
  const other = join(home, 'live2d', 'packs', 'other')
  await mkdir(join(other, 'model'), { recursive: true })
  await writeFile(join(other, 'model', 'other.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: { Moc: 'o.moc3', Textures: ['o.png'] },
  }))
  await writeFile(join(other, 'model', 'o.moc3'), 'moc')
  await writeFile(join(other, 'model', 'o.png'), 'png')

  const remember = tools.find(tool => tool.name === 'live2d_remember')
  await remember.execute({ text: '属于第一个角色的事' }, { agent: { id: 's1' } })

  const first = JSON.parse(await readFile(join(pack, 'memory', 's1.json'), 'utf8'))
  assert.equal(first.facts.length, 1)
  await assert.rejects(
    () => readFile(join(other, 'memory', 's1.json'), 'utf8'),
    /ENOENT/,
    'the other pack has no memory file',
  )
})
