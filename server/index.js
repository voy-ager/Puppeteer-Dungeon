/**
 * index.js — Narrative Engine entry point
 *
 * Startup order matters here:
 *   1. dotenv loads .env so every downstream module can read process.env
 *      at require-time — modules like watsonxClient.js check env vars the
 *      moment they are first imported, so dotenv must come first.
 *   2. Express is configured with CORS before routes are mounted — the game
 *      client is a browser page served from a different origin, and without
 *      CORS headers the browser's same-origin policy will silently block
 *      every request.
 *   3. The HTTP server starts, then the pool scheduler is kicked off inside
 *      the listen callback — this ensures we're not trying to warm the pool
 *      before the process is fully ready to handle async work.
 *
 * This file intentionally contains no pipeline logic. Its only job is
 * wiring: load config, mount middleware, mount routes, start listening.
 * All generation, quality-checking, and pooling live in their own modules.
 */

// Resolve the .env path explicitly to the project root — one level above
// /server. When `node index.js` is run with cwd set to /server (as npm
// start does), the default dotenv search finds nothing because .env lives
// at the repo root, not inside /server. __dirname is always the directory
// of this file regardless of cwd, so path.resolve is reliable here.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const express = require('express');
const cors    = require('cors');

const narrativeRouter = require('./routes/narrative');
const narrativePool   = require('./pool/narrativePool');

const app  = express();
const PORT = process.env.PORT || 3001;

// Allow requests from any origin — the game is a static browser page and
// may be served from file://, localhost, or a CDN in different environments.
app.use(cors());
app.use(express.json());

app.use('/api/narrative', narrativeRouter);

app.listen(PORT, () => {
  console.log(`[NarrativeEngine] Listening on port ${PORT}`);

  // Warm the pool after the server is up. startScheduler() does an eager
  // initial fill for all beat types, then runs a periodic refill check.
  // Calling it here (rather than at module load) keeps startup synchronous
  // and avoids firing API calls before the process is fully initialised.
  narrativePool.startScheduler();
});
