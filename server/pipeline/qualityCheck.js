/**
 * qualityCheck.js — Pipeline Stage 4: raw text → clean string, with retry
 * and fallback
 *
 * This is the last gate before a generated line reaches the pool or the
 * client. Its two responsibilities are deliberately separate:
 *
 *   cleanAndValidate(rawText)
 *     A pure, synchronous filter. It strips cosmetic artifacts that Granite
 *     sometimes produces (surrounding quotes, markdown fences, leading
 *     whitespace) and rejects output that is empty or implausibly long.
 *     Returns a clean string on success, null on rejection — no throwing,
 *     no side effects.
 *
 *   generateWithFallback(beatType, gameState)
 *     Orchestrates the full pipeline: interpreter → promptBuilder →
 *     watsonxClient → cleanAndValidate. If the first attempt produces null
 *     or throws, it retries once. If the second attempt also fails, it
 *     returns a hardcoded fallback line for that beat type.
 *
 * The "always returns a string" contract is the load-bearing promise this
 * module makes to the rest of the service. The pool and the route handlers
 * never need to handle API errors — they just call generateWithFallback
 * and get a line back. The game must never hang or break because watsonx.ai
 * had a bad moment.
 *
 * Why exactly one retry?
 * A single retry catches the most common transient failure modes (momentary
 * network blip, rate-limit spike) without adding meaningful latency. Two
 * retries would roughly triple the worst-case wait time for a background
 * refill, which starts to defeat the purpose of the pool.
 */

'use strict';

const { interpretContext }            = require('./interpreter');
const { buildPrompt, buildRecapPrompt } = require('./promptBuilder');
const { generateText }                = require('./watsonxClient');

// --- Fallback lines ---------------------------------------------------------

/**
 * FALLBACK_LINES — one atmospheric one-liner per beat type, used when
 * Granite fails twice in a row.
 *
 * These are written to the same tone contract as generated lines (dread,
 * isolation, no gore) so a fallback never feels jarring if it surfaces in
 * the game. They are intentionally generic — no room names — because a
 * fallback can appear in any context.
 */
const FALLBACK_LINES = {
  ambient:    'The silence here has weight.',
  tension:    'Something in the dark has noticed you stopped moving.',
  hunt_taunt: 'It knows exactly where you are.',
  relief:     'It has gone quiet — but it has not gone far.',
};

// Maximum word count that a generated line is allowed to have.
// The prompt asks for ≤25 words; the validator accepts up to 40 to give
// Granite reasonable slack. Beyond 40 words the line is too long to work
// as on-screen narration and is rejected.
const MAX_WORD_COUNT = 40;

// --- cleanAndValidate -------------------------------------------------------

/**
 * cleanAndValidate — strips cosmetic artifacts from raw Granite output and
 * validates that the result is usable as a narration line.
 *
 * Strips:
 *   - Surrounding double or single quotes
 *   - Surrounding triple-backtick markdown fences
 *   - Leading/trailing whitespace and newlines
 *
 * Rejects (returns null) when:
 *   - The cleaned string is empty
 *   - The word count exceeds MAX_WORD_COUNT
 *
 * @param {string} rawText - Text as returned by generateText()
 * @returns {string|null}  - Clean string, or null if unusable
 */
function cleanAndValidate(rawText) {
  if (typeof rawText !== 'string') return null;

  let cleaned = rawText.trim();

  // Strip markdown code fences — Granite occasionally wraps output in
  // ```...``` even when the prompt explicitly asks it not to.
  cleaned = cleaned.replace(/^```[\s\S]*?```$/m, s => s.slice(3, -3).trim());
  cleaned = cleaned.replace(/^```|```$/g, '').trim();

  // Strip surrounding quotation marks (single or double). Only strip when
  // the entire string is wrapped — a quote mid-sentence is intentional.
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  if (!cleaned) return null;

  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  if (wordCount > MAX_WORD_COUNT) {
    console.warn(`[qualityCheck] Rejected — ${wordCount} words (max ${MAX_WORD_COUNT}): "${cleaned.slice(0, 60)}..."`);
    return null;
  }

  return cleaned;
}

// --- generateWithFallback ---------------------------------------------------

/**
 * generateWithFallback — runs the full pipeline and always returns a string.
 *
 * Pipeline:
 *   interpretContext(gameState) → beatType
 *   buildPrompt(beatType, gameState) → prompt
 *   generateText(prompt) → rawText
 *   cleanAndValidate(rawText) → clean string or null
 *
 * On null result or any thrown error: retries once.
 * On second failure: returns FALLBACK_LINES[beatType].
 *
 * @param {string} beatType  - The beat type (may already be known by caller)
 * @param {object} gameState - The game-state snapshot
 * @returns {Promise<string>} A narration line — never rejects.
 */
async function generateWithFallback(beatType, gameState) {
  // beatType may be pre-determined by the caller (e.g. the pool scheduler
  // passing "ambient" directly) or derived from gameState by the interpreter.
  // We resolve it once here so both the attempt and the fallback key agree.
  const resolvedBeatType = beatType || interpretContext(gameState || {});

  const fallback = FALLBACK_LINES[resolvedBeatType] || FALLBACK_LINES.ambient;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const prompt  = buildPrompt(resolvedBeatType, gameState || {});
      const rawText = await generateText(prompt);
      const line    = cleanAndValidate(rawText);

      if (line) {
        // Log on success so we can see what Granite produced in server logs.
        console.log(`[qualityCheck] attempt ${attempt} OK [${resolvedBeatType}]: "${line}"`);
        return line;
      }

      // cleanAndValidate returned null — treat as a soft failure and retry.
      console.warn(`[qualityCheck] attempt ${attempt} produced unusable output for beat "${resolvedBeatType}" — ${attempt < 2 ? 'retrying' : 'using fallback'}`);

    } catch (err) {
      console.warn(`[qualityCheck] attempt ${attempt} threw for beat "${resolvedBeatType}": ${err.message} — ${attempt < 2 ? 'retrying' : 'using fallback'}`);
    }
  }

  // Both attempts failed. Return the hardcoded line so the caller always
  // gets something safe to display.
  console.warn(`[qualityCheck] Falling back to hardcoded line for beat "${resolvedBeatType}"`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Recap validation and generation
// ---------------------------------------------------------------------------

/**
 * FALLBACK_RECAP — hardcoded paragraph served when Granite fails twice for an
 * 'escaped' recap. Written in the same second-person, reflective-atmospheric
 * tone as generated recaps so a fallback never feels like an error state.
 *
 * Generic by necessity (no session-specific numbers), but still evocative —
 * the player should feel the dungeon acknowledged them even if Granite was
 * unavailable.
 */
const FALLBACK_RECAP = `You passed through, and the dungeon noted it. The stone corridors registered \
your footsteps, your pauses, the moments you hesitated at a junction and chose wrong. Something was \
present the entire time — patient, unhurried, certain of its ground. Whether you moved quickly or \
slowly, loudly or in near-silence, it watched. The dungeon does not forget the ones who walk its \
halls. It simply waits for the next one.`;

/**
 * FALLBACK_CAUGHT — hardcoded paragraph served when Granite fails twice for a
 * 'caught' recap. Mirrors FALLBACK_RECAP's purpose but with the inverted
 * framing: the dungeon closed in, the narrative ended in failure. Still
 * atmospheric, still no gore — psychological inevitability only.
 */
const FALLBACK_CAUGHT = `You stayed too long, moved too loudly, or simply ran out of room. The dungeon \
was patient in a way you were not. It did not chase you — it simply waited at the right corner, in \
the right silence, until the distance between you was nothing. The stone remembered every step you \
took toward it. It always does. The ones who pass through leave something behind. You left more than most.`;

/**
 * MAX_RECAP_WORD_COUNT — the upper bound for a valid recap paragraph.
 * Set to 180 to accommodate Granite's natural tendency to run slightly over
 * the 120-word target. Beyond 180 words the paragraph is too long to read
 * comfortably as a single-screen overlay and is rejected so the retry has
 * a chance to produce something tighter.
 */
const MAX_RECAP_WORD_COUNT = 180;

/**
 * cleanAndValidateRecap — strips cosmetic artifacts from raw Granite output
 * and validates that the result is usable as a recap paragraph.
 *
 * Uses the same stripping logic as cleanAndValidate (markdown fences,
 * surrounding quotes, whitespace) but with a relaxed word-count ceiling.
 * The 40-word cap used for beat-type lines would reject every valid recap —
 * a paragraph is the intended output here, not a one-liner.
 *
 * @param {string} rawText
 * @returns {string|null} Clean paragraph, or null if empty or over the cap.
 */
function cleanAndValidateRecap(rawText) {
  if (typeof rawText !== 'string') return null;

  let cleaned = rawText.trim();

  cleaned = cleaned.replace(/^```[\s\S]*?```$/m, s => s.slice(3, -3).trim());
  cleaned = cleaned.replace(/^```|```$/g, '').trim();

  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  if (!cleaned) return null;

  // Leakage-phrase rejection: guard against the model echoing prompt
  // instructions back instead of producing narrative. These exact phrases
  // appear in the preamble as format directives — if any of them surface in
  // the output, the model has regurgitated the prompt rather than followed it.
  // Reject early (before the word-count check) so the retry has a chance to
  // produce a clean paragraph rather than a word-count-valid but useless one.
  const lower = cleaned.toLowerCase();
  const leakagePhrases = [
    'exactly one paragraph',
    'words.',
    'no quotation marks',
    'no headings',
    'no summary label',
    'begin with the word',
  ];
  for (const phrase of leakagePhrases) {
    if (lower.includes(phrase)) {
      console.warn(`[qualityCheck] Recap rejected — prompt leakage detected ("${phrase}"): "${cleaned.slice(0, 60)}..."`);
      return null;
    }
  }

  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  if (wordCount > MAX_RECAP_WORD_COUNT) {
    console.warn(`[qualityCheck] Recap rejected — ${wordCount} words (max ${MAX_RECAP_WORD_COUNT})`);
    return null;
  }

  return cleaned;
}

/**
 * generateRecapWithFallback — builds and generates a session recap paragraph,
 * always resolving to a non-empty string.
 *
 * Structurally parallel to generateWithFallback: same retry-once-then-fallback
 * pattern, same generateText call, same "always returns a string" contract.
 * The differences are:
 *   - Uses buildRecapPrompt(stats) instead of buildPrompt(beatType, gameState)
 *   - Validates with cleanAndValidateRecap (180-word cap) not cleanAndValidate
 *   - Falls back to FALLBACK_RECAP not FALLBACK_LINES
 *
 * Why the same retry count (one)?
 * A recap is a single synchronous request that the player is actively waiting
 * for — the loading state is visible. Two retries would mean up to ~6s of
 * visible "thinking" on a slow API, which feels worse than showing the fallback
 * quickly. One retry catches transient errors; a second failure gets the fallback.
 *
 * @param {object} stats - Session stats from buildRecapStats() on the client.
 * @returns {Promise<string>} Always resolves to a paragraph string.
 */
async function generateRecapWithFallback(stats) {
  // Select the correct fallback before the loop so both the warn log and the
  // return value use the same tone-matched string. FALLBACK_CAUGHT is used
  // when the session ended in capture; FALLBACK_RECAP for the escaped ending.
  const fallback = (stats.outcome === 'caught') ? FALLBACK_CAUGHT : FALLBACK_RECAP;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const prompt  = buildRecapPrompt(stats);
      const rawText = await generateText(prompt);
      const recap   = cleanAndValidateRecap(rawText);

      if (recap) {
        console.log(`[qualityCheck] recap attempt ${attempt} OK [${stats.outcome || 'escaped'}] (${recap.split(/\s+/).length} words)`);
        return recap;
      }

      console.warn(`[qualityCheck] recap attempt ${attempt} unusable [${stats.outcome || 'escaped'}] — ${attempt < 2 ? 'retrying' : 'using fallback'}`);

    } catch (err) {
      console.warn(`[qualityCheck] recap attempt ${attempt} threw [${stats.outcome || 'escaped'}]: ${err.message} — ${attempt < 2 ? 'retrying' : 'using fallback'}`);
    }
  }

  console.warn(`[qualityCheck] Recap falling back to hardcoded paragraph [${stats.outcome || 'escaped'}]`);
  return fallback;
}

module.exports = {
  cleanAndValidate,
  generateWithFallback,
  FALLBACK_LINES,
  cleanAndValidateRecap,
  generateRecapWithFallback,
  FALLBACK_RECAP,
  FALLBACK_CAUGHT,
};
