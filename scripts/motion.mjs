/**
 * Generate one motion clip without the GUI.
 *
 * Usage:
 *   node scripts/motion.mjs sample:wave out/wave.vrma --duration 2
 *   node scripts/motion.mjs "a person waves" out/wave.vrma --provider ardy
 *
 * The provider and command come from the settings file, so this is the same
 * path the `live2d_motion` tool takes — only the caller differs.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { internals } from '../lib/index.mjs'
import { generateMotion } from '../lib/motion/index.mjs'

const argv = process.argv.slice(2)

/**
 * Read `--name value` from argv.
 *
 * @param name - Flag name without dashes.
 * @returns The value, or undefined.
 */
function flag(name) {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

/** Positional arguments: everything that is not a flag or a flag's value. */
const targets = argv.filter((argument, index) => {
  if (argument.startsWith('--')) return false
  if (index > 0 && argv[index - 1].startsWith('--')) return false
  return true
})
const [promptArg, outputArg] = targets
if (promptArg === undefined || outputArg === undefined) {
  console.error('usage: node scripts/motion.mjs <prompt|sample:id> <out.vrma> [--duration N] [--provider P] [--seed N]')
  process.exit(2)
}

const config = internals.resolveConfig({})
const provider = flag('provider')
const sample = promptArg.startsWith('sample:') ? promptArg.slice('sample:'.length) : undefined
const prompt = sample === undefined ? promptArg : ''
const request = {
  prompt,
  // `sample:id` names the provider itself: the settings' provider may be an
  // engine that needs an English prompt, which a built-in clip does not have.
  ...(sample === undefined ? {} : { sample, provider: 'sample' }),
  ...(provider === undefined || sample !== undefined ? {} : { provider }),
  ...(flag('duration') === undefined ? {} : { duration: Number(flag('duration')) }),
  ...(flag('seed') === undefined ? {} : { seed: Number(flag('seed')) }),
}
const result = await generateMotion(request, config.motion)
const out = resolve(outputArg)
await mkdir(dirname(out), { recursive: true })
await writeFile(out, result.buffer)
console.log(`wrote ${out}`)
console.log(`provider=${result.provider} duration=${result.duration}s bones=${result.info.bones.length} tracks=${result.info.tracks.length} samples=${result.info.samples} bytes=${result.buffer.length}`)
