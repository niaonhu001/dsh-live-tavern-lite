/**
 * Apply the host-side half of the geometric pose checks.
 *
 * Run from the package directory: `node scripts/patch-checks.mjs`.
 * It edits `lib/index.mjs` in place and is kept as a script so the exact edits stay readable.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const file = 'lib/index.mjs'
copyFileSync(file, `${file}.pre-checks.bak`)
let text = readFileSync(file, 'utf8')

function replaceOnce(search, replacement, label) {
  const index = text.indexOf(search)
  if (index < 0) throw new Error(`patch-checks: cannot find ${label}`)
  text = `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`
}

// 1. Recipes carry their acceptance criteria.
replaceOnce(
  "      easeMs: Number.isFinite(Number(entry.easeMs)) ? Math.min(4000, Math.max(60, Number(entry.easeMs))) : 400,",
  `      easeMs: Number.isFinite(Number(entry.easeMs)) ? Math.min(4000, Math.max(60, Number(entry.easeMs))) : 400,
      // Geometric acceptance criteria the browser evaluates after applying the pose.
      checks: (Array.isArray(entry.checks) ? entry.checks : [])
        .filter(item => item !== null && typeof item === 'object' && typeof item.type === 'string')
        .slice(0, 6)
        .map(item => ({
          type: item.type.slice(0, 24),
          ...(item.side === 'right' ? { side: 'right' } : {}),
          ...(Number.isFinite(Number(item.max)) ? { max: Number(item.max) } : {}),
          ...(Number.isFinite(Number(item.target)) ? { target: Number(item.target) } : {}),
          ...(Number.isFinite(Number(item.tolerance)) ? { tolerance: Number(item.tolerance) } : {}),
        })),`,
  'recipe checks',
)

// 2. The frame carries them to the browser.
replaceOnce(
  "      ...(recipe === undefined ? {} : { recipe: recipe.id }),",
  `      ...(recipe === undefined ? {} : { recipe: recipe.id }),
      ...(recipe?.checks !== undefined && recipe.checks.length > 0 ? { checks: recipe.checks } : {}),`,
  'frame checks',
)

// 3. Store the last measurement reported by the browser.
replaceOnce(
  '  /** The effective values the settings form edits, resolved once per request. */',
  `  /** Latest geometric check results, pushed by the browser after applying a pose. */
  let lastPoseChecks = null

  /**
   * Wait briefly for the browser to report the checks of the pose just published.
   *
   * The Host cannot measure a skeleton; the browser can, and it answers within a frame or two.
   * Handing the numbers back with the tool result is what makes a bad pose visible instead of
   * silently accepted.
   *
   * @param since - Timestamp taken before the frame was published.
   * @param budgetMs - How long to wait.
   * @returns The reported result, or null when nothing arrived.
   */
  const waitForChecks = async (since, budgetMs) => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (lastPoseChecks !== null && lastPoseChecks.at !== null && lastPoseChecks.at >= since) return lastPoseChecks
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return null
  }

  /** The effective values the settings form edits, resolved once per request. */`,
  'lastPoseChecks',
)

// 4. The browser reports here.
replaceOnce(
  `  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: \`\${ROUTE_PREFIX}/settings\`,`,
  `  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: \`\${ROUTE_PREFIX}/checks\`,
    async handler(req, res) {
      if (req.method === 'GET') {
        sendJson(res, 200, lastPoseChecks ?? { recipe: null, results: [], at: null })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'use GET or POST' })
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req, 64 * 1024))
      } catch (error) {
        sendJson(res, 400, { error: \`body: \${error?.message ?? error}\` })
        return
      }
      const results = (Array.isArray(body?.results) ? body.results : [])
        .filter(item => item !== null && typeof item === 'object' && typeof item.type === 'string')
        .slice(0, 8)
        .map(item => ({
          type: item.type.slice(0, 24),
          ok: item.ok === true,
          value: Number.isFinite(Number(item.value)) ? Number(Number(item.value).toFixed(3)) : null,
          target: Number.isFinite(Number(item.target)) ? Number(item.target) : null,
          text: typeof item.text === 'string' ? item.text.slice(0, 120) : '',
        }))
      lastPoseChecks = {
        recipe: typeof body?.recipe === 'string' ? body.recipe.slice(0, 32) : null,
        results,
        at: Date.now(),
      }
      sendJson(res, 200, { ok: true, count: results.length })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: \`\${ROUTE_PREFIX}/settings\`,`,
  'checks route',
)

// 5. The act tool reports the verdict it just caused.
replaceOnce(
  `      const state = await stageStateFor(request, 'local')
      const key = String(exec?.agent?.id ?? '')`,
  `      const publishedAt = Date.now()
      const state = await stageStateFor(request, 'local')
      const key = String(exec?.agent?.id ?? '')`,
  'publishedAt',
)
replaceOnce(
  `      const { line: _spoken, ...frame } = state
      return {
        ok: true,`,
  `      const { line: _spoken, ...frame } = state
      // A pose that ships checks is only "done" once the browser has measured it.
      const measured = Array.isArray(state.checks) && state.checks.length > 0
        ? await waitForChecks(publishedAt, 600)
        : null
      return {
        ok: true,
        ...(measured === null
          ? {}
          : {
            checks: {
              passed: measured.results.filter(entry => entry.ok === true).length,
              failed: measured.results.filter(entry => entry.ok !== true).length,
              results: measured.results,
            },
          }),`,
  'act checks',
)

writeFileSync(file, text)
console.log('patched lib/index.mjs')
