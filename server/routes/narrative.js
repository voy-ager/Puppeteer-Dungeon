/**
 * routes/narrative.js — Express router for the Narrative Engine API
 *
 * Routes are intentionally thin. No pipeline logic lives here — this file
 * only validates inputs, delegates to narrativePool or qualityCheck, and
 * shapes the JSON response. The same boundary principle as director.js:
 * each layer does exactly one thing and hands off cleanly.
 *
 * Endpoints:
 *
 *   GET  /api/narrative/next?type=<beatType>
 *     Returns one ready line from the pool. If the pool is now low after
 *     the pop, triggers a background refill. Never waits on generation —
 *     always responds immediately. Falls back to a hardcoded line if the
 *     pool for that type is empty.
 *
 *   GET  /api/narrative/status
 *     Returns current pool sizes per beat type. Intended for debugging
 *     and for verifying that the scheduler is working correctly.
 *
 *   POST /api/narrative/test-generate
 *     Bypasses the pool entirely and runs the full pipeline synchronously,
 *     returning the raw result. Used for smoke-testing the Granite
 *     connection and prompt quality without waiting for the scheduler.
 */

'use strict';

const { Router }              = require('express');
const { popLine, refillBucket, getPoolSizes, BEAT_TYPES } = require('../pool/narrativePool');
const { generateWithFallback, FALLBACK_LINES }            = require('../pipeline/qualityCheck');

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/narrative/next?type=<beatType>
// ---------------------------------------------------------------------------

router.get('/next', (req, res) => {
  const beatType = req.query.type;

  if (!beatType || !BEAT_TYPES.includes(beatType)) {
    return res.status(400).json({
      error: `Missing or invalid "type" query parameter. Must be one of: ${BEAT_TYPES.join(', ')}`,
    });
  }

  const line = popLine(beatType);
  const poolSize = getPoolSizes()[beatType];

  // If the bucket has dropped below 3 items after the pop, trigger a
  // background refill. This is fire-and-forget — the response does not
  // wait for it. The scheduler will also catch any low buckets on its next
  // tick, but triggering here means the pool refills faster under load.
  if (poolSize < 3) {
    refillBucket(beatType);
  }

  return res.json({ line, beatType, poolSize });
});

// ---------------------------------------------------------------------------
// GET /api/narrative/status
// ---------------------------------------------------------------------------

router.get('/status', (req, res) => {
  // Pool sizes are a synchronous in-memory read — no async needed.
  return res.json({ pool: getPoolSizes() });
});

// ---------------------------------------------------------------------------
// POST /api/narrative/test-generate
// ---------------------------------------------------------------------------

router.post('/test-generate', async (req, res) => {
  const { beatType, gameState } = req.body || {};

  if (!beatType || !BEAT_TYPES.includes(beatType)) {
    return res.status(400).json({
      error: `Missing or invalid "beatType" body field. Must be one of: ${BEAT_TYPES.join(', ')}`,
    });
  }

  const fallback = FALLBACK_LINES[beatType];

  // generateWithFallback always resolves — it handles its own retry and
  // fallback internally. We detect whether the fallback was used by
  // comparing the returned line to the known fallback string for this type.
  const line   = await generateWithFallback(beatType, gameState || { beatType });
  const source = line === fallback ? 'fallback' : 'granite';

  return res.json({ beatType, line, source });
});

module.exports = router;
