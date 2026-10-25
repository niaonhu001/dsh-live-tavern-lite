/**
 * Parameter tracks: a model reply becomes a short animation.
 *
 * A reply may carry a track line such as
 *
 *     ParamAngleX=18@600; ParamYL2=1@120; ParamYL2=0@260; ParamAngleZ+=4@300
 *
 * Each entry names a parameter, the value to reach and how long the move takes.
 * An entry's millisecond value is the duration of *that* segment, and a second
 * entry for the same parameter continues where the first ended — so the line
 * above raises ParamYL2 over 120 ms and lowers it over the next 260 ms, instead
 * of both running at once and cancelling out.
 *
 * `=` sets the parameter; `+=` / `-=` move it by an offset instead, leaving
 * whatever the rig or the model's own idle animation put underneath untouched.
 * That is the mode for body parameters: a set would pin the value forever, while
 * an offset rides on top of the breathing and the weight shift.
 *
 * Accepted separators between entries are `;`, `,`, `-` and newlines; `@` may be
 * `:` or ` `, so "ParamAngleX 18 600" also parses. A trailing `~ease` name picks
 * the interpolation: `linear`, `smooth` (default), `in`, `out`.
 *
 * @module dsh-live-tavern-lite/tracks
 */

/** Easing curves by name, all clamped to 0..1. */
const EASING = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
}

/**
 * Parse a track line into entries, in the order they were written.
 *
 * Values are only accepted from identifiers that look like Live2D parameters, so
 * prose in the same reply cannot create a track by accident.
 *
 * @param text - The raw line from a model reply.
 * @param options - `maxEntries` caps the list. The default is high enough for a\n * fully sampled routine: 40 s at 0.1 s is 400 keys × 25 channels = 10000 entries.
 * @returns Entries as `{ id, mode, value, ms, ease }`, possibly empty.
 */
export function parseTracks(text, { maxEntries = 200_000 } = {}) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const pattern = /([A-Za-z_][A-Za-z0-9_]{1,40})\s*(\+=|-=|=|:)?\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*[@:：\s]\s*(\d{1,6})(?:\s*~\s*([a-zA-Z]+))?/g
  const entries = []
  let match
  while ((match = pattern.exec(text)) !== null && entries.length < maxEntries) {
    const ms = Number(match[4])
    const written = Number(match[3])
    if (!Number.isFinite(ms) || !Number.isFinite(written)) continue
    if (ms < 40 || ms > 60_000) continue
    const operator = match[2] ?? '='
    const mode = operator === '+=' || operator === '-=' ? 'add' : 'set'
    entries.push({
      id: match[1],
      mode,
      value: operator === '-=' ? -written : written,
      ms,
      ease: EASING[String(match[5] ?? '').toLowerCase()] === undefined ? 'smooth' : String(match[5]).toLowerCase(),
      // 记下「作者有没有显式写了缓动名」。没写 ≠ 想要缓入缓出：
      // 从视频逐帧采样出来的密集轨道必须线性插值，否则每个采样点都会顿一下。
      easeExplicit: match[5] !== undefined && EASING[String(match[5]).toLowerCase()] !== undefined,
    })
  }
  return entries
}

/**
 * Build running channels from parsed entries.
 *
 * Entries for one parameter become consecutive segments: each starts where the
 * previous one landed. A set channel starts from the parameter's live value; an
 * additive channel starts from a zero offset, so nothing underneath is disturbed.
 *
 * @param entries - Output of {@link parseTracks}.
 * @param read - Reads the parameter's current value by id.
 * @param now - Start time in milliseconds.
 * @returns One channel per parameter, in first-appearance order.
 */
export function startTracks(entries, read, now) {
  const channels = new Map()
  for (const entry of entries) {
    let channel = channels.get(entry.id)
    if (channel === undefined) {
      const live = Number(read(entry.id))
      const started = Number.isFinite(live) ? live : 0
      channel = {
        id: entry.id,
        mode: entry.mode,
        base: entry.mode === 'add' ? 0 : started,
        cursor: now,
        segments: [],
        value: entry.mode === 'add' ? 0 : started,
      }
      channels.set(entry.id, channel)
    }
    const last = channel.segments[channel.segments.length - 1]
    channel.segments.push({
      from: last === undefined ? channel.base : last.to,
      to: entry.value,
      start: channel.cursor,
      end: channel.cursor + entry.ms,
      ease: entry.ease,
      easeExplicit: entry.easeExplicit === true,
    })
    channel.cursor += entry.ms
  }
  return [...channels.values()]
}

/**
 * Advance every channel and report the values to write.
 *
 * @param channels - Channels from {@link startTracks}.
 * @param now - Current time in milliseconds.
 * @returns `{ values, active }` — `values` maps id to `{ mode, value }`, and
 * `active` is false once every channel reached its last segment.
 */
export function stepTracks(channels, now) {
  const values = new Map()
  let active = false
  for (const channel of channels) {
    const segments = channel.segments
    const final = segments[segments.length - 1]
    let current = final
    for (const segment of segments) {
      if (now < segment.end) {
        current = segment
        break
      }
    }
    const span = Math.max(1, current.end - current.start)
    const t = Math.min(1, Math.max(0, (now - current.start) / span))
    // 密集轨道（≥8 段）且作者没显式写缓动时走线性：从视频逐帧采样的曲线本身就是数据点，
    // 每段再做一次缓入缓出会在每个采样点把速度压到零，看起来一顿一顿。
    const dense = channel.segments.length >= 8 && current.easeExplicit !== true
    const curve = dense ? EASING.linear : (EASING[current.ease] ?? EASING.smooth)
    channel.value = current.from + (current.to - current.from) * curve(t)
    values.set(channel.id, { mode: channel.mode, value: channel.value })
    // A channel is done only past its final segment; an earlier one is just
    // between segments and must keep being written.
    if (now < final.end) active = true
  }
  return { values, active }
}
