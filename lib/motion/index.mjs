/**
 * Text to motion, one call.
 *
 * Resolves the configured provider, runs it, checks the bytes it produced, and
 * returns a clip plus what it actually is. Nothing here knows about packs or the
 * browser: the Host stores the bytes and publishes a frame.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { inspectVrma, isVrma } from './vrma.mjs'
import { runArdyProvider, runHttpProvider, runSampleProvider } from './providers.mjs'

/** Providers a config may name. */
export const MOTION_PROVIDERS = ['ardy', 'http', 'sample']

/** Floor for a requested clip length, in seconds. There is no ceiling. */
const MIN_DURATION = 0.5

/**
 * Resolve one generation request against the configured provider.
 *
 * @param request - `{ prompt, duration, seed, sample, provider, name }` from a tool call.
 * @param config - Resolved motion config: `{ provider, endpoint, timeoutMs, defaultDuration }`.
 * @returns `{ buffer, info, provider, detail, duration, seed }`.
 */
export async function generateMotion(request, config) {
  const provider = MOTION_PROVIDERS.includes(request?.provider) ? request.provider : config.provider
  if (!MOTION_PROVIDERS.includes(provider)) {
    throw new Error(`unknown motion provider '${provider}' — use one of ${MOTION_PROVIDERS.join(', ')}`)
  }
  const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : ''
  if (prompt === '' && provider !== 'sample') throw new Error('prompt is empty')
  if (prompt.length > 600) throw new Error('prompt is longer than 600 characters')
  const duration = Math.max(MIN_DURATION, Number(request?.duration) > 0 ? Number(request.duration) : config.defaultDuration)
  const seed = Number.isFinite(Number(request?.seed)) ? Math.trunc(Number(request.seed)) : 42
  const base = {
    prompt,
    duration,
    seed,
    timeoutMs: config.timeoutMs,
    endpoint: config.endpoint,
    name: request?.name,
  }
  let result
  if (provider === 'ardy') result = await runArdyProvider(base)
  else if (provider === 'http') result = await runHttpProvider(base)
  else result = await runSampleProvider({ ...base, sample: request?.sample ?? 'wave' })
  if (!isVrma(result.buffer)) {
    throw new Error(`provider '${provider}' did not produce a playable VRMA clip`)
  }
  const info = inspectVrma(result.buffer)
  return {
    buffer: result.buffer,
    info,
    provider,
    detail: result.detail ?? {},
    duration: info.duration > 0 ? info.duration : duration,
    seed,
    prompt,
  }
}
