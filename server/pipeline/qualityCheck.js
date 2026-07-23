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

const { interpretContext } = require('./interpreter');
const { buildPrompt }      = require('./promptBuilder');
const { generateText }     = require('./watsonxClient');

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

module.exports = { cleanAndValidate, generateWithFallback, FALLBACK_LINES };
