/**
 * Which acts are whole-body motion, and how to say them in English.
 *
 * The stage has two ways to move. Bone channels are instant and per-joint: the
 * right tool for a head tilt or a shy glance. A generated clip is seconds and
 * whole-body: the only way to walk, turn, crouch or dance, because locomotion
 * needs root motion and ground contact that joint angles cannot express.
 *
 * The split this module draws is anatomical — hands, feet, waist and hips go to
 * the generator; head, neck and face stay on channels. It also has to speak the
 * generator's language: ARDY reads English, and the act's own fields are channel
 * ids and recipe names, so an English sentence has to be supplied or derived.
 */

/**
 * Recipes whose motion lives in the large limbs, with a sentence to generate.
 *
 * Head-only recipes are deliberately absent; they are listed in `HEAD_RECIPES`
 * and never leave the channel path.
 */
const BODY_RECIPES = {
  bow: 'a person bows politely, then stands up straight',
  wave: 'a person raises one hand and waves',
  point: 'a person points forward with one hand and holds it',
  crouch: 'a person crouches down low and stays there',
  examine: 'a person leans the upper body forward and looks closely at something',
  shrug: 'a person shrugs both shoulders',
  hands_up: 'a person raises both hands up',
  double_yeah: 'a person makes a V sign with both hands',
  hands_clasped: 'a person folds both hands together in front',
  lean_in: 'a person leans the upper body forward',
  recoil: 'a person leans the upper body backward',
  dance_hold: 'a person sways the body side to side to a beat',
  dance_bounce: 'a person bounces the body up and down to a beat',
}

/** Recipes that only move head or neck; these keep the instant channel path. */
const HEAD_RECIPES = new Set(['nod', 'shake', 'tilt'])

/** Dance and choreography families; each prefix maps to one sentence. */
const DANCE_PREFIXES = ['dance_', 'shin_takarajima', 'qianxia', 'gokuraku', 'complex_', 'body_dance']

/** Sentence used for any choreography recipe. */
const DANCE_PROMPT = 'a person dances a short whole-body phrase to a beat'

/** Vertical hips offset, in metres, that counts as the body moving rather than shifting weight. */
const BODY_SINK_METRES = 0.06

/**
 * Read the English body description an act asks for, if any.
 *
 * Priority: an explicit `body` sentence, then a known whole-body recipe, then a
 * significant hips translation. Channel-only acts return `null` on purpose —
 * inventing an English sentence from arbitrary joint angles would describe
 * something the caller did not ask for.
 *
 * @param request - The act's arguments.
 * @returns An English prompt, or `null` when the act is not whole-body motion.
 */
export function bodyPromptFor(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return null

  const explicit = typeof request.body === 'string' ? request.body.trim() : ''
  if (explicit !== '') return explicit

  const recipe = typeof request.recipe === 'string' ? request.recipe.trim() : ''
  if (recipe !== '' && !HEAD_RECIPES.has(recipe)) {
    const known = BODY_RECIPES[recipe]
    if (known !== undefined) return known
    if (DANCE_PREFIXES.some((prefix) => recipe.startsWith(prefix))) return DANCE_PROMPT
  }

  // A hips translation is a deliberate vertical move of the whole body; rotations
  // alone cannot do it, so the channel path has no way to honour it well.
  const hips = request.translate !== null && typeof request.translate === 'object'
    ? request.translate.hips
    : undefined
  if (Array.isArray(hips) && hips.length === 3) {
    const drop = Number(hips[1])
    if (Number.isFinite(drop) && Math.abs(drop) >= BODY_SINK_METRES) {
      return drop < 0
        ? 'a person sinks the hips down and lowers the whole body'
        : 'a person rises up onto the toes and lifts the body'
    }
  }

  return null
}

/** Recipe ids this module routes to the generator; the tool description lists them. */
export const WHOLE_BODY_RECIPES = Object.keys(BODY_RECIPES)
