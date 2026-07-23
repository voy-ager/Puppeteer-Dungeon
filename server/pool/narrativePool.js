/**
 * narrativePool.js — In-memory line pool and background refill scheduler
 *
 * Why a pool?
 * Granite generation is asynchronous and takes 1-3 seconds per call.
 * A game loop cannot pause and wait for an API round-trip every time it
 * wants a narration line — the player would feel a stutter or hang.
 * The pool solves this by pre-generating lines in the background so that
 * popLine() returns instantly, synchronously, with no network involvement.
 *
 * How it works:
 *   - Four buckets, one per beat type, each holding an array of ready strings.
 *   - popLine() removes and returns the first item from the appropriate bucket.
 *     If the bucket is empty it returns a hardcoded fallback immediately —
 *     the pool never blocks, never returns undefined, never throws.
 *   - refillBucket() generates one new line asynchronously (via the full
 *     pipeline in qualityCheck.js) and appends it to the bucket. Any error
 *     is swallowed with a warning — a failed refill is a background concern,
 *     not a user-facing problem.
 *   - startScheduler() runs setInterval every REFILL_INTERVAL_MS and checks
 *     each bucket. Any bucket below POOL_WATERMARK gets one new line queued.
 *     It also performs an eager initial fill on startup so the pool is not
 *     empty the moment the first request arrives.
 *
 * Token budget note:
 *   The IBM Cloud Lite plan provides ~300,000 tokens/month. With 60
 *   max_new_tokens per call and a 10-second scheduler interval, the pool
 *   can generate at most ~6 lines/minute under full pressure — roughly
 *   260,000 tokens/month if every beat type refills on every tick, which
 *   is unlikely in practice. The watermark of 3 and the 10-second interval
 *   are deliberately conservative. Do not tighten them without first
 *   auditing how many tokens a typical generation call actually consumes
 *   (visible in the watsonx.ai usage dashboard).
 */

'use strict';

const { generateWithFallback, FALLBACK_LINES } = require('../pipeline/qualityCheck');

// --- Constants --------------------------------------------------------------

/** All valid beat types — used to iterate the pool without hardcoding strings. */
const BEAT_TYPES = ['ambient', 'tension', 'hunt_taunt', 'relief'];

/**
 * How often (in milliseconds) the scheduler checks pool levels and refills
 * any bucket that has fallen below POOL_WATERMARK. 10 seconds is
 * conservative — see token budget note above.
 */
const REFILL_INTERVAL_MS = 10_000;

/**
 * Minimum number of ready lines per bucket. When a bucket dips below this,
 * the scheduler queues a background refill. 3 items is enough to cover a
 * burst of requests before the refill completes without wasting tokens on
 * buckets that are rarely consumed.
 */
const POOL_WATERMARK = 3;

// --- The pool ---------------------------------------------------------------

/**
 * The in-memory pool. Each key is a beat type; each value is an array of
 * ready-to-serve narration strings. Starts empty — startScheduler() fills
 * it on first run.
 */
const pool = {
  ambient:    [],
  tension:    [],
  hunt_taunt: [],
  relief:     [],
};

// --- Public API -------------------------------------------------------------

/**
 * popLine — removes and returns the oldest line from the given bucket.
 * Never blocks. If the bucket is empty, returns the hardcoded fallback for
 * that beat type so the caller always gets a usable string.
 *
 * @param {string} beatType - One of the four beat type strings.
 * @returns {string}
 */
function popLine(beatType) {
  const bucket = pool[beatType];

  if (!bucket || bucket.length === 0) {
    // The pool is dry for this beat type — return the fallback immediately.
    // This can happen on a very fresh startup or after a run of API failures.
    console.warn(`[narrativePool] Pool empty for "${beatType}" — serving fallback`);
    return FALLBACK_LINES[beatType] || FALLBACK_LINES.ambient;
  }

  // shift() removes from the front (FIFO) — the oldest pre-generated line.
  // This avoids serving the same line twice in a row when the bucket
  // refills while the game is still consuming earlier items.
  return bucket.shift();
}

/**
 * refillBucket — generates one new line asynchronously and appends it to
 * the given bucket. Fire-and-forget; never throws.
 *
 * @param {string} beatType
 * @returns {Promise<void>}
 */
async function refillBucket(beatType) {
  try {
    // generateWithFallback always resolves — it handles its own retry and
    // fallback internally. We pass a minimal gameState with the beat type
    // baked in so the interpreter doesn't need to infer it from nothing.
    const line = await generateWithFallback(beatType, { beatType });
    pool[beatType].push(line);
    console.log(`[narrativePool] Refilled "${beatType}" — pool now has ${pool[beatType].length} item(s)`);
  } catch (err) {
    // In practice generateWithFallback should never throw, but if something
    // unexpected slips through we log it and move on — a failed refill is
    // invisible to the player as long as the pool isn't completely dry.
    console.warn(`[narrativePool] refillBucket("${beatType}") unexpected error: ${err.message}`);
  }
}

/**
 * startScheduler — performs an eager initial fill, then sets up the
 * periodic refill interval.
 *
 * Called once from index.js after the HTTP server is listening.
 * Designed to be called only once — calling it twice would set up duplicate
 * intervals and double the token spend.
 */
function startScheduler() {
  // Eager initial fill: stagger one refill per beat type with a short delay
  // between each. The Lite plan rate limit is 2 req/s — firing all four
  // simultaneously saturates it instantly and causes every attempt to 429.
  // 600ms spacing keeps us well within the limit even accounting for the
  // IAM token exchange that precedes the first real generation call.
  // The pool may still be empty for the first few seconds while these
  // complete — that's fine; popLine() falls back to hardcoded lines.
  console.log('[narrativePool] Starting scheduler — performing staggered initial fill');
  BEAT_TYPES.forEach((beatType, i) => {
    setTimeout(() => refillBucket(beatType), i * 600);
  });

  // Periodic check: every REFILL_INTERVAL_MS, inspect each bucket and top
  // up any that have fallen below the watermark. Using setInterval rather
  // than a recursive setTimeout keeps the timing predictable and the code
  // simpler — the refills themselves are async and won't block the interval.
  setInterval(() => {
    const sizes = BEAT_TYPES.map(bt => `${bt}:${pool[bt].length}`).join(' ');
    console.log(`[narrativePool] Scheduler tick — pool sizes: ${sizes}`);

    for (const beatType of BEAT_TYPES) {
      if (pool[beatType].length < POOL_WATERMARK) {
        // Fire-and-forget — don't await. The interval continues regardless
        // of how long a particular refill takes.
        refillBucket(beatType);
      }
    }
  }, REFILL_INTERVAL_MS);
}

/**
 * getPoolSizes — returns a snapshot of current pool sizes per beat type.
 * Used by the /status route for debugging.
 *
 * @returns {{ ambient: number, tension: number, hunt_taunt: number, relief: number }}
 */
function getPoolSizes() {
  const sizes = {};
  for (const beatType of BEAT_TYPES) {
    sizes[beatType] = pool[beatType].length;
  }
  return sizes;
}

module.exports = { popLine, refillBucket, startScheduler, getPoolSizes, BEAT_TYPES };
