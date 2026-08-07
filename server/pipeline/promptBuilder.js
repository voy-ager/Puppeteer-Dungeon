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

// ---------------------------------------------------------------------------
// Recap prompt
// ---------------------------------------------------------------------------

/**
 * RECAP_PREAMBLE — the system instruction for the 'escaped' recap.
 *
 * Kept separate from SYSTEM_PREAMBLE because the two outputs have fundamentally
 * different requirements: SYSTEM_PREAMBLE asks for one line under 25 words;
 * the recap asks for a full paragraph of 80-120 words in second person.
 * Reusing the same preamble would fight against the length target on every call.
 */
const RECAP_PREAMBLE = `You are writing a personalized narrative recap for a player who has just finished \
a horror dungeon-crawl game. Write in second person ("You..."). The tone is the same atmospheric dread \
and isolation as the rest of the game — cold stone, something watching, the weight of passing through \
a place that remembers you. Never describe gore or graphic violence. Never use the word "darkness" as a \
lazy shortcut. The response should be a single flowing paragraph, roughly 80 to 120 words long, \
delivered without quotation marks, headings, or labels of any kind, beginning with the word "You".`;

/**
 * CAUGHT_PREAMBLE — the system instruction for the 'caught' recap.
 *
 * Same length and format requirements as RECAP_PREAMBLE, but the emotional
 * framing is inverted: this is a failure ending. The dungeon caught up. The
 * narrative closes in. The tone is not relieved — it is the dread of something
 * that was always going to happen. Still second person, still atmospheric,
 * still no gore or graphic violence. The failure is felt, not shown.
 */
const CAUGHT_PREAMBLE = `You are writing a personalized narrative recap for a player who has just been \
caught in a horror dungeon-crawl game. Write in second person ("You..."). The tone is atmospheric dread — \
the feeling of a story that has reached its inevitable end, a place that was always going to claim you. \
The dungeon caught up. Not violent, not graphic — psychological. The weight of inevitability. \
Something patient finally closing the distance. Never describe gore or graphic violence. \
Never use the word "darkness" as a lazy shortcut. The response should be a single flowing paragraph, \
roughly 80 to 120 words long, delivered without quotation marks, headings, or labels of any kind, \
beginning with the word "You".`;

/**
 * buildRecapPrompt — constructs a Granite prompt personalised to this session's stats.
 *
 * Stats with zero or empty values are omitted from the prompt so Granite is
 * never asked to write about things that didn't happen (e.g. "0 hunts" would
 * produce awkward phrasing). Each included stat is framed as a natural prose
 * instruction rather than raw JSON so the model can weave the numbers into
 * narrative rather than listing them.
 *
 * The preamble branches on stats.outcome so the same context block drives two
 * emotionally distinct tones without duplicating the stat-assembly logic. The
 * 'escaped' preamble is reflective and atmospheric; the 'caught' preamble
 * frames the same facts as the dungeon closing in.
 *
 * @param {object} stats
 * @param {'escaped'|'caught'} [stats.outcome='escaped'] - how the session ended
 * @param {number}   stats.totalDistance         - metres walked this session
 * @param {number}   stats.totalPlayTimeSeconds   - total elapsed seconds
 * @param {number}   stats.huntCount              - times the enemy hunted the player
 * @param {number}   stats.noiseTriggeredCount    - hunts triggered by noise
 * @param {number}   stats.comfortTriggeredCount  - hunts triggered by comfort signals
 * @param {number}   stats.closeCallSeconds       - seconds within close-call range
 * @param {number}   stats.sneakTimeSeconds       - seconds spent sneaking
 * @param {string[]} stats.backtrackedRooms        - rooms visited more than once
 *
 * @returns {string} Complete prompt ready for Granite.
 */
function buildRecapPrompt(stats) {
  const {
    outcome              = 'escaped',
    totalDistance        = 0,
    totalPlayTimeSeconds = 0,
    huntCount            = 0,
    noiseTriggeredCount  = 0,
    comfortTriggeredCount = 0,
    closeCallSeconds     = 0,
    sneakTimeSeconds     = 0,
    backtrackedRooms     = [],
  } = stats;

  // Select preamble based on outcome. Both share identical context assembly
  // below — the preamble is the only thing that changes between the two endings.
  const preamble = outcome === 'caught' ? CAUGHT_PREAMBLE : RECAP_PREAMBLE;

  const minutes = Math.round(totalPlayTimeSeconds / 60);

  // Build an array of contextual lines — only include stats that actually
  // happened in this session. Empty lines are filtered before joining.
  const contextLines = [];

  if (minutes > 0) {
    contextLines.push(`The player spent approximately ${minutes} minute${minutes !== 1 ? 's' : ''} in the dungeon.`);
  }

  if (totalDistance > 0) {
    contextLines.push(`They walked roughly ${totalDistance.toFixed(1)} metres in total.`);
  }

  if (huntCount > 0) {
    // Break down hunt causes when both types occurred — the distinction
    // between "heard" and "comfortable" adds texture to the recap.
    if (noiseTriggeredCount > 0 && comfortTriggeredCount > 0) {
      contextLines.push(
        `They were hunted ${huntCount} time${huntCount !== 1 ? 's' : ''} — ` +
        `${noiseTriggeredCount} because they moved too loudly, ` +
        `${comfortTriggeredCount} because they seemed too comfortable.`
      );
    } else if (noiseTriggeredCount > 0) {
      contextLines.push(
        `They were hunted ${huntCount} time${huntCount !== 1 ? 's' : ''}, each time because they moved too loudly.`
      );
    } else {
      contextLines.push(
        `They were hunted ${huntCount} time${huntCount !== 1 ? 's' : ''}, each time by lingering too long.`
      );
    }
  }

  if (closeCallSeconds > 5) {
    contextLines.push(
      `They spent ${closeCallSeconds.toFixed(1)} seconds within arm's reach of the creature.`
    );
  }

  if (sneakTimeSeconds > 10) {
    contextLines.push(
      `They crept silently for ${sneakTimeSeconds} second${sneakTimeSeconds !== 1 ? 's' : ''} — ` +
      `long enough that it must have mattered.`
    );
  }

  if (backtrackedRooms.length > 0) {
    // Underscore-to-space substitution for legibility in the prompt.
    // A proper human-readable label map (e.g. "room_2" → "the second chamber")
    // could replace this later; for now the room identifiers are clear enough.
    const roomList = backtrackedRooms
      .map(r => r.replace(/_/g, ' '))
      .join(' and ');
    contextLines.push(`They retraced their steps through the ${roomList}.`);
  }

  const contextBlock = contextLines.length > 0
    ? contextLines.join(' ')
    : 'The player moved through the dungeon without incident.';

  return [
    preamble,
    '',
    'Session details:',
    contextBlock,
    '',
    'Write the recap paragraph now, beginning with "You".',
  ].join('\n');
}

module.exports = { buildPrompt, buildRecapPrompt };
