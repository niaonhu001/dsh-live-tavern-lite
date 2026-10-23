/**
 * Cut a spoken line at a sentence boundary.
 *
 * A bubble that ends mid-word reads like a bug, so a line that is too long keeps
 * whole sentences and drops the rest, appending an ellipsis only when even the
 * first sentence is too long to show.
 *
 * @module dsh-live-tavern-lite/speech
 */

/** Characters that end a sentence, plus the closers that belong to it. */
const SENTENCE_END = /[。！？!?…；;.]/u
const CLOSERS = '”’」』）》〉”\'"'

/**
 * Trim text to at most `limit` characters without cutting a sentence in half.
 *
 * @param text - Raw line.
 * @param limit - Maximum characters to keep (default 160).
 * @returns The trimmed line, never longer than `limit` plus one ellipsis.
 */
export function trimToSentence(text, limit = 160) {
  const line = String(text ?? '').trim()
  const cap = Math.max(8, Math.trunc(Number(limit) || 160))
  if (line.length <= cap) return line

  // Walk the string once, remembering where each complete sentence ends.
  let lastBoundary = -1
  for (let index = 0; index < line.length && index < cap; index += 1) {
    if (!SENTENCE_END.test(line[index])) continue
    let end = index + 1
    // A closing quote or bracket belongs to the sentence it closes.
    while (end < line.length && CLOSERS.includes(line[end])) end += 1
    if (end <= cap) lastBoundary = end
  }
  if (lastBoundary > 0) return line.slice(0, lastBoundary).trim()

  // No sentence fits: keep the first one whole if there is one, otherwise ellipsis.
  const firstEnd = line.search(SENTENCE_END)
  if (firstEnd > 0) {
    let end = firstEnd + 1
    while (end < line.length && CLOSERS.includes(line[end])) end += 1
    return `${line.slice(0, end).trim()}…`
  }
  return `${line.slice(0, cap - 1).trim()}…`
}
