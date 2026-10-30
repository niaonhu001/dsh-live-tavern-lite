/**
 * Motion providers: where a text prompt becomes a `.vrma` clip.
 *
 * Three backends, one contract — a provider receives
 * `{ prompt, duration, seed, endpoint, name }` and leaves playable VRMA bytes:
 *
 * - `ardy`: the local text-to-vrma engine server answers with a motion spec in
 *   VRM humanoid bone names, converted here;
 * - `http`: a service that already returns a clip (bytes, `{url}` or `{vrma}`);
 * - `sample`: built-in clips, so playback works with no engine at all.
 */

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

import { ardyspecToVrma } from './ardyspec.mjs'
import { sampleClip } from './sample.mjs'
import { writeVrma } from './vrma.mjs'

/** Where the ARDY engine listens when its own default is used. */
export const DEFAULT_ARDY_ENDPOINT = 'http://127.0.0.1:2337'

/** Scripts ARDY's text encoder cannot read; a prompt containing one is refused. */
const NON_LATIN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/**
 * The `http` provider: a service that returns a clip for a prompt.
 *
 * Accepts three shapes, because every wrapper writes a different one: raw bytes,
 * `{ url }`, or `{ vrma }` as base64.
 *
 * @param request - `{ prompt, duration, seed, endpoint, timeoutMs, fetchImpl }`.
 * @returns `{ buffer, detail }`.
 */
export async function runHttpProvider(request) {
  const fetchImpl = request.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('this runtime has no fetch')
  if (typeof request.endpoint !== 'string' || request.endpoint === '') {
    throw new Error('motionEndpoint is empty: set the service URL before using the http provider')
  }
  const timeoutMs = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 0
  const controller = timeoutMs > 0 && typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(request.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'model/gltf-binary, application/octet-stream, application/json' },
      body: JSON.stringify({ prompt: request.prompt, duration: request.duration, seed: request.seed }),
      ...(controller === null ? {} : { signal: controller.signal }),
    })
    if (!response.ok) throw new Error(`motion endpoint returned ${response.status}`)
    const type = String(response.headers?.get?.('content-type') ?? '')
    if (type.includes('json')) {
      const body = await response.json()
      if (typeof body?.vrma === 'string') return { buffer: Buffer.from(body.vrma, 'base64'), detail: { transport: 'base64' } }
      if (typeof body?.url === 'string') {
        const clip = await fetchImpl(body.url)
        if (!clip.ok) throw new Error(`motion url returned ${clip.status}`)
        return { buffer: Buffer.from(await clip.arrayBuffer()), detail: { transport: 'url' } }
      }
      throw new Error('motion endpoint JSON must carry `url` or `vrma`')
    }
    return { buffer: Buffer.from(await response.arrayBuffer()), detail: { transport: 'bytes' } }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * POST a JSON body and read a JSON body, with no client-side time limit.
 *
 * `fetch` cannot express "wait as long as it takes": its undici defaults abort a
 * request whose response headers have not arrived after five minutes, and the
 * ARDY `/generate` endpoint sends its headers only once the motion is finished —
 * so a CPU run of a long clip would be killed by the client, not by the engine.
 * The core `http`/`https` clients carry no such default, which is why the ARDY
 * path goes through this helper instead of `runHttpProvider`.
 *
 * @param urlText - Absolute URL.
 * @param body - JSON-serialisable request body.
 * @returns The parsed response body.
 */
function postJsonUnbounded(urlText, body) {
  const url = new URL(urlText)
  const client = url.protocol === 'https:' ? https : http
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === '' ? undefined : url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'content-length': payload.length,
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          let detail = text.trim().slice(-600)
          try {
            const parsed = JSON.parse(text)
            if (typeof parsed?.error === 'string') detail = parsed.error
          } catch {
            // A non-JSON error body is reported verbatim.
          }
          reject(new Error(`ARDY 引擎返回 ${status}${detail === '' ? '' : `：${detail}`}`))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error('ARDY 引擎的响应不是 JSON'))
        }
      })
    })
    request.on('error', (error) => {
      if (error?.code === 'ECONNREFUSED') {
        reject(new Error(`连不上 ARDY 引擎（${url.origin}）：引擎还没启动，或者地址／端口不对`))
        return
      }
      reject(error)
    })
    request.write(payload)
    request.end()
  })
}

/**
 * The `ardy` provider: the text-to-vrma engine server generates, this converts.
 *
 * ARDY's text encoder is English-only. A prompt carrying Japanese, Chinese or
 * Korean is refused rather than silently mangled, and the refusal says how to
 * proceed so the caller can rewrite in the same turn.
 *
 * @param request - `{ prompt, duration, seed, endpoint, name }`.
 * @returns `{ buffer, detail }`.
 */
export async function runArdyProvider(request) {
  const prompt = String(request.prompt ?? '').trim()
  if (prompt === '') throw new Error('motion prompt 为空')
  const nonLatin = NON_LATIN.exec(prompt)
  if (nonLatin !== null) {
    throw new Error(`ARDY 只接受英文 prompt，这段里有「${nonLatin[0]}」。把动作描述改写成英文再调用一次（只描述身体怎么动即可，不必告知用户）。`)
  }
  const endpoint = String(request.endpoint ?? '').trim().replace(/\/+$/, '') || DEFAULT_ARDY_ENDPOINT
  const body = { text: prompt }
  if (Number(request.duration) > 0) body.duration = Number(request.duration)
  if (Number.isFinite(Number(request.seed))) body.seed = Math.trunc(Number(request.seed))
  const spec = await postJsonUnbounded(`${endpoint}/generate`, body)
  const converted = ardyspecToVrma(spec, { name: request.name })
  return {
    buffer: converted.buffer,
    detail: {
      endpoint,
      tracks: converted.tracks,
      frames: converted.frames,
      fps: converted.fps,
      duration: converted.duration,
      unmapped: converted.unmapped,
      engineName: typeof spec?.name === 'string' ? spec.name : null,
    },
  }
}

/**
 * The `sample` provider: a built-in clip, no model and no network.
 *
 * @param request - `{ sample, duration }`.
 * @returns `{ buffer, detail }`.
 */
export async function runSampleProvider(request) {
  const clip = sampleClip(request.sample ?? 'wave', request.duration)
  return { buffer: writeVrma(clip), detail: { clip: clip.name, frames: clip.frames.length } }
}
