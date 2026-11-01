/**
 * Song production for the tavern: turn lyrics (or an existing recording) into a
 * finished track in the character's voice.
 *
 * The chain is deliberately the same one the cover pipeline uses by hand:
 *   sing  → YuE2 writes and performs the song from lyrics + style
 *   cover → the supplied recording is the source
 *   both  → MSST separates vocals → karaoke split keeps the backing vocals
 *         → DDSP-SVC replaces the timbre with the character's model
 *         → mix + technical verification
 *
 * Every step is a child process; the caller only sees progress lines, so a Host
 * restart can never leave a half-written result pretending to be done.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** How long one external step may take before it is killed. */
const STEP_TIMEOUT_MS = 20 * 60 * 1000
/** The Gradio song generation is the slowest single step. */
const YUE_TIMEOUT_MS = 20 * 60 * 1000

/**
 * Run one command and collect its output.
 *
 * @param command - Executable.
 * @param args - Argument list.
 * @param options - `{ cwd, env, timeoutMs, onLine }`.
 * @returns `{ code, output }`; `code` is null when the timeout fired.
 */
function run(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : STEP_TIMEOUT_MS
  return new Promise((resolvePromise) => {
    let output = ''
    let settled = false
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolvePromise({ code: null, output: `${output}\n[timeout after ${timeoutMs} ms]` })
    }, timeoutMs)
    const collect = (chunk) => {
      const text = String(chunk)
      output += text
      if (output.length > 200_000) output = output.slice(-100_000)
      if (typeof options.onLine === 'function') {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim() !== '') options.onLine(line.trim())
        }
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code: -1, output: `${output}\n${error?.message ?? error}` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, output })
    })
  })
}

/** Format millesimals as seconds with two decimals. */
function seconds(value) {
  return `${(Number(value) / 1000).toFixed(2)}s`
}

/**
 * Ask YuE2 for a song and return the rendered file.
 *
 * Uses Gradio's call API: a POST returns an event id, then the SSE stream ends
 * with a `complete` event carrying the file description.
 *
 * @param options - `{ baseUrl, style, lyrics, seed, onLine }`.
 * @returns The absolute path of the generated flac.
 */
async function generateWithYuE2(options) {
  const base = String(options.baseUrl ?? '').replace(/\/+$/, '')
  if (base === '') throw new Error('没有配置 YuE2 地址')
  const submit = await fetch(`${base}/gradio_api/call/on_text2music_generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: [String(options.style ?? ''), String(options.lyrics ?? ''), Number(options.seed) || 1] }),
  })
  if (!submit.ok) throw new Error(`YuE2 提交失败：HTTP ${submit.status} ${(await submit.text()).slice(0, 200)}`)
  const { event_id: eventId } = await submit.json()
  if (typeof eventId !== 'string' || eventId === '') throw new Error('YuE2 没有返回 event id')
  options.onLine?.(`YuE2 任务 ${eventId}`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), YUE_TIMEOUT_MS)
  try {
    const response = await fetch(`${base}/gradio_api/call/on_text2music_generate/${eventId}`, { signal: controller.signal })
    if (!response.ok || response.body === null) throw new Error(`YuE2 事件流失败：HTTP ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const event = chunk.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim()
        const data = chunk.split('\n').find(line => line.startsWith('data:'))?.slice(5).trim()
        if (event === 'error') throw new Error(`YuE2 生成失败：${String(data).slice(0, 200)}`)
        if (event !== 'complete' || data === undefined) continue
        const payload = JSON.parse(data)
        const file = Array.isArray(payload) ? payload[0] : payload
        const path = typeof file?.path === 'string' ? file.path : ''
        if (path === '' || !existsSync(path)) throw new Error('YuE2 完成但找不到音频文件')
        return path
      }
    }
    throw new Error('YuE2 事件流结束了却没有结果')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Produce one song end to end.
 *
 * @param spec - Configuration and request:
 *   `{ mode, lyrics, style, src, key, seed, workRoot, yuE2Url, ffmpeg,
 *      msstDir, msstEnv, ddspDir, ddspEnv, voiceModel, pipelineDir }`.
 * @param hooks - `{ onProgress(step, detail) }`.
 * @returns `{ master, mp3, verify, duration, steps }`.
 */
export async function runSong(spec, hooks = {}) {
  const progress = (step, detail) => hooks.onProgress?.(step, detail)
  const workRoot = String(spec.workRoot ?? '')
  if (workRoot === '') throw new Error('没有配置歌曲工作目录')
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const dir = join(workRoot, id)
  const paths = {
    input: join(dir, 'input'),
    sep: join(dir, 'sep'),
    karaIn: join(dir, 'kara_in'),
    kara: join(dir, 'kara'),
    conv: join(dir, 'conv'),
  }
  await Promise.all(Object.values(paths).map(folder => mkdir(folder, { recursive: true })))
  const steps = []
  const mark = (step, detail) => {
    steps.push({ step, detail, at: Date.now() })
    progress(step, detail)
  }

  // 1. Source: generate it, or take the recording that was given.
  let source
  const mode = spec.mode === 'cover' ? 'cover' : 'sing'
  if (mode === 'sing') {
    if (String(spec.lyrics ?? '').trim() === '') throw new Error('唱歌需要歌词')
    mark('compose', 'YuE2 正在写歌并演唱')
    source = await generateWithYuE2({
      baseUrl: spec.yuE2Url,
      style: spec.style,
      lyrics: spec.lyrics,
      seed: spec.seed,
      onLine: (line) => hooks.onLog?.(line),
    })
    mark('compose', `生成完成：${basename(source)}`)
  } else {
    source = String(spec.src ?? '')
    if (source === '' || !existsSync(source)) throw new Error(`找不到源文件：${source}`)
    mark('source', `使用 ${basename(source)}`)
  }

  // 2. Normalise to the sample rate the rest of the chain expects.
  const song = join(paths.input, 'song.wav')
  const ff = String(spec.ffmpeg ?? 'ffmpeg')
  const converted = await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_f32le', song])
  if (converted.code !== 0) throw new Error(`转码失败：${converted.output.slice(-400)}`)
  mark('source', '已转成 44.1 kHz 立体声')

  // 3. Voice / backing separation, then lead / backing-vocal split.
  const msstDir = String(spec.msstDir ?? '')
  const msstEnv = String(spec.msstEnv ?? '')
  if (msstDir === '' || msstEnv === '') throw new Error('没有配置人声分离工程')
  mark('separate', '分离人声与伴奏')
  const sep = await run(msstEnv, [
    'inference.py',
    '--model_type', 'mel_band_roformer',
    '--config_path', 'configs/config_vocals_mel_band_roformer_kim.yaml',
    '--start_check_point', 'pretrain/MelBandRoformer_kim.ckpt',
    '--input_folder', paths.input,
    '--store_dir', paths.sep,
    '--extract_instrumental', '--disable_detailed_pbar',
  ], { cwd: msstDir, timeoutMs: STEP_TIMEOUT_MS })
  if (sep.code !== 0) throw new Error(`人声分离失败：${sep.output.slice(-400)}`)
  const vocals = join(paths.sep, 'song', 'vocals.wav')
  if (!existsSync(vocals)) throw new Error('人声分离没有产出 vocals.wav')
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', vocals, join(paths.karaIn, 'vocals.wav')])
  mark('separate', '主唱与和声再分离')
  const kara = await run(msstEnv, [
    'inference.py',
    '--model_type', 'bs_roformer',
    '--config_path', 'configs/config_karaoke_frazer_becruily.yaml',
    '--start_check_point', 'pretrain/bs_roformer_karaoke_frazer_becruily.ckpt',
    '--input_folder', paths.karaIn,
    '--store_dir', paths.kara,
    '--extract_instrumental', '--disable_detailed_pbar',
  ], { cwd: msstDir, timeoutMs: STEP_TIMEOUT_MS })
  if (kara.code !== 0) throw new Error(`主唱分离失败：${kara.output.slice(-400)}`)

  // 4. Replace the timbre.
  const pipelineDir = String(spec.pipelineDir ?? '')
  const convertScript = join(pipelineDir, 'runtime', 'convert.py')
  if (!existsSync(convertScript)) throw new Error(`找不到 ${convertScript}`)
  const ddspEnv = String(spec.ddspEnv ?? '')
  const ddspDir = String(spec.ddspDir ?? '')
  const voiceModel = String(spec.voiceModel ?? '')
  if (ddspEnv === '' || ddspDir === '' || !existsSync(voiceModel)) throw new Error('换声工程或音色模型没有配置好')
  mark('convert', '换成她的音色')
  const lead = join(paths.conv, 'lead.wav')
  const key = Number.isFinite(Number(spec.key)) ? Number(spec.key) : 0
  const conv = await run(ddspEnv, [
    convertScript,
    '--src', join(paths.kara, 'vocals', 'Vocals.wav'),
    '--out', lead,
    '--model', voiceModel,
    '--ddsp-dir', ddspDir,
    '--backend', 'baseline', '--mode', 'full',
    '--key', String(key), '--step', '50', '--method', 'euler', '--t-start', '0.7',
  ], { cwd: join(pipelineDir, 'runtime'), timeoutMs: STEP_TIMEOUT_MS })
  if (conv.code !== 0) throw new Error(`换声失败：${conv.output.slice(-400)}`)

  // 5. Mix and verify.
  const master = join(dir, 'master.wav')
  mark('mix', '混音与母带')
  const mix = await run(msstEnv, [
    join(pipelineDir, 'runtime', 'mix.py'),
    '--mix-dir', join(pipelineDir, 'runtime'),
    '--out', master,
    '--profile', 'standard', '--target', '-14',
    '--set', `inst=${join(paths.sep, 'song', 'instrumental.wav')}`,
    '--set', `lead=${lead}`,
    '--set', `harm=${join(paths.kara, 'vocals', 'instrumental.wav')}`,
  ], { cwd: pipeDirIfExists(pipelineDir), timeoutMs: STEP_TIMEOUT_MS })
  if (mix.code !== 0) throw new Error(`混音失败：${mix.output.slice(-400)}`)

  const verifyJson = join(dir, 'master.verify.json')
  const verify = await run(msstEnv, [join(pipelineDir, 'runtime', 'verify_mix.py'), master, '--target-lufs', '-14', '--json', verifyJson], {
    cwd: pipeDirIfExists(pipelineDir),
    timeoutMs: 120_000,
  })
  const report = existsSync(verifyJson) ? JSON.parse(await readFile(verifyJson, 'utf8')) : null

  // 6. A share copy plus the numbers the panel shows.
  const mp3 = join(dir, 'master.mp3')
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', master, '-c:a', 'libmp3lame', '-b:a', '320k', mp3])
  mark('done', '完成')
  const info = await run(ff, ['-hide_banner', '-i', master], { timeoutMs: 30_000 })
  const duration = Number(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(info.output)?.slice(1).reduce((sum, part, index) => sum + Number(part) * [3600, 60, 1][index], 0) ?? 0)
  const summary = {
    id,
    dir,
    mode,
    master,
    mp3,
    verify: report,
    duration,
    steps,
    verified: verify.code === 0,
    key,
  }
  await writeFile(join(dir, 'song.json'), JSON.stringify(summary, null, 2))
  return summary
}

/** The cover pipeline's runtime folder, when it exists. */
function pipeDirIfExists(pipelineDir) {
  const runtime = join(pipelineDir, 'runtime')
  return existsSync(runtime) ? runtime : undefined
}

export { seconds }
