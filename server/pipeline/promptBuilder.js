/**
 * promptBuilder.js — Pipeline Stage 2: beat type + context → Granite prompt
 *
 * This is the only place that knows what a Granite prompt looks like for
 * this game. Tone decisions, word-count targets, and beat-specific framing
 * all live here. That means:
 *   - Adjusting the horror tone never requires touching generation or pool
 *     code — the same boundary discipline as director.js, which never moves
 *     the enemy directly.
 *   - A/B testing different prompt styles only requires changes in this file.
 *   - The prompt's output constraint (ONE line, ≤25 words, no quotes) is
 *     stated both here AND enforced by qualityCheck.js — belt-and-suspenders.
 *     Putting it in the prompt reduces how often the quality check has to
 *     reject and retry, which saves tokens and latency.
 *
 * Tone contract (applies to every beat type):
 *   - Dread and isolation: the player is alone and something is aware of them.
 *   - "Something is watching" — presence implied, never confirmed.
 *   - Never gory, never graphic. Psychological unease only.
 *   - Voice: a quiet narrator, or a friendly-but-frightened ally NPC.
 *     Either reads naturally as on-screen text or spoken dialogue.
 */

'use strict';

/**
 * The shared preamble injected into every prompt regardless of beat type.
 * It establishes the model's role and the absolute tone constraints before
 * any beat-specific instruction is added.
 */
const SYSTEM_PREAMBLE = `You are writing atmospheric narration for a first-person horror dungeon-crawl game. \
Your voice is that of a quiet, unsettled narrator — or a frightened ally NPC whispering to the player. \
The tone is psychological dread and isolation. Something may be watching. \
Never describe gore or graphic violence. Never use the word "darkness" as a lazy shortcut — be specific and evocative. \
Respond with exactly ONE line of narration. Under 25 words. No quotation marks. No stage directions. No line breaks.`;

/**
 * Beat-specific framing for each of the four beat types.
 * Each entry is a short instruction that follows the shared preamble,
 * telling the model what situation to write for.
 */
const BEAT_INSTRUCTIONS = {
  /**
   * ambient — the player is exploring normally.
   * Goal: quiet, unsettling flavor. The dungeon feels alive in small,
   * wrong ways. Not dangerous — just off.
   */
  ambient: `The player is moving through the dungeon. Write a quiet atmospheric line — \
something feels subtly wrong, but there is no immediate threat. \
Evoke the silence, the cold stone, the sense that the place has memory.`,

  /**
   * tension — the player has been idle or is backtracking.
   * Goal: the narration notices the hesitation. Something noticed too.
   */
  tension: `The player has been standing still or retracing their steps. \
Write a line that reflects growing unease — the dungeon (or something in it) \
has noticed the hesitation. Imply a watching presence without naming it directly.`,

  /**
   * hunt_taunt — the enemy is actively hunting the player.
   * Goal: the narration reflects the immediacy of being hunted.
   * Not a jump-scare — a creeping, certain dread.
   */
  hunt_taunt: `Something is actively hunting the player right now. \
Write a line that captures the feeling of being pursued — footsteps behind a corner, \
breath held, the predator's certainty. The threat is close. Do not name the creature.`,

  /**
   * relief — the hunt just ended; the enemy returned to patrol.
   * Goal: the silence after danger. Not safe — just a temporary reprieve.
   * The player should feel watched even now.
   */
  relief: `The immediate threat has passed, but the dungeon is not safe. \
Write a line that captures the fragile quiet after danger — the held breath released, \
the awareness that it is still out there somewhere. Relief tinged with dread.`,
};

/**
 * buildPrompt — constructs the full Granite prompt for a given beat type.
 *
 * @param {string} beatType   - "ambient" | "tension" | "hunt_taunt" | "relief"
 * @param {object} gameState  - the game-state snapshot (used for room context)
 * @param {string} [gameState.roomName] - current room identifier, if known
 *
 * @returns {string} The complete prompt string ready to send to Granite.
 */
function buildPrompt(beatType, gameState) {
  const instruction = BEAT_INSTRUCTIONS[beatType] || BEAT_INSTRUCTIONS.ambient;

  // Include the room name when available — it gives the model a concrete
  // anchor and reduces generic outputs. "The entry hall" produces better
  // results than a prompt with no spatial context at all.
  const roomLine = gameState && gameState.roomName
    ? `Current location: ${gameState.roomName.replace(/_/g, ' ')}.`
    : '';

  // Assemble: system role → beat instruction → spatial context → output reminder.
  // The output reminder at the end is redundant with the preamble, but
  // Granite (like most instruction-tuned models) is more reliably concise
  // when the constraint is repeated close to where the output begins.
  return [
    SYSTEM_PREAMBLE,
    '',
    instruction,
    roomLine,
    '',
    'Narration line:',
  ]
    .filter(line => line !== null && line !== undefined)
    .join('\n');
}

module.exports = { buildPrompt };
