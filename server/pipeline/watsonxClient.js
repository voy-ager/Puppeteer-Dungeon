/**
 * watsonxClient.js — Pipeline Stage 3: prompt → raw generated text
 *
 * This is the only file in the service that knows about the IBM watsonx.ai
 * API. Everything specific to IBM's HTTP contract lives here:
 *   - The two-step auth flow (API key → IAM access token → Bearer header)
 *   - The generation endpoint URL and query string
 *   - The request body shape (model_id, input, parameters)
 *   - The response parsing path (results[0].generated_text)
 *
 * Keeping this isolated means that if we ever swap watsonx.ai for a
 * different provider, or IBM changes their API shape, only this file needs
 * to change — qualityCheck.js, the pool, and the routes are all unaffected.
 *
 * --- Auth flow explained ---
 * watsonx.ai does NOT accept the raw API key as a Bearer token. Instead:
 *   1. Exchange WATSONX_API_KEY at the IBM Cloud IAM endpoint for a
 *      short-lived access token (valid ~1 hour).
 *   2. Use that access token as the Authorization: Bearer header on the
 *      actual generation request.
 * The token is cached in module scope. getIamToken() only calls the IAM
 * endpoint again when the cached token is absent or within 5 minutes of
 * expiry — this avoids an extra round-trip on every generation call while
 * still handling the ~hourly rotation automatically.
 */

'use strict';

const fetch = require('node-fetch');

// --- Configuration constants ------------------------------------------------

/**
 * The Granite model to use for generation. Declared as a named constant
 * rather than buried in the request body so it's easy to swap without
 * hunting through the code.
 */
const GRANITE_MODEL_ID = 'ibm/granite-3-8b-instruct';

/**
 * Generation parameters sent with every request.
 * - max_new_tokens: 60 is generous for a ≤25-word line; qualityCheck.js
 *   rejects anything over 40 words anyway, so headroom here doesn't hurt.
 * - temperature: 0.85 — enough variety to avoid repetitive outputs without
 *   wandering into incoherence.
 * - stop_sequences: stop at the first newline so Granite doesn't continue
 *   into a second sentence even if max_new_tokens hasn't been hit.
 */
const GENERATION_PARAMS = {
  max_new_tokens: 60,
  temperature: 0.85,
  stop_sequences: ['\n'],
};

/** IBM Cloud IAM token endpoint — exchanges an API key for a Bearer token. */
const IAM_TOKEN_URL = 'https://iam.cloud.ibm.com/identity/token';

/**
 * How many seconds before the cached IAM token's expiry we treat it as
 * expired and proactively fetch a new one. 5 minutes gives enough buffer
 * to avoid a mid-request expiry in normal conditions.
 */
const IAM_TOKEN_REFRESH_BUFFER_SECONDS = 300;

// --- Environment variables --------------------------------------------------
// Read at module load time so a missing variable is caught (and logged) the
// moment the server starts, not the first time a generation is attempted.

const WATSONX_API_KEY    = process.env.WATSONX_API_KEY;
const WATSONX_PROJECT_ID = process.env.WATSONX_PROJECT_ID;
const WATSONX_URL        = process.env.WATSONX_URL;

if (!WATSONX_API_KEY || !WATSONX_PROJECT_ID || !WATSONX_URL) {
  console.warn(
    '[watsonxClient] WARNING: One or more watsonx.ai env vars are missing ' +
    '(WATSONX_API_KEY, WATSONX_PROJECT_ID, WATSONX_URL). ' +
    'Generation calls will fail and the engine will fall back to hardcoded lines.'
  );
}

// --- IAM token cache --------------------------------------------------------

/**
 * Module-scoped token cache. We store the token string and the Unix
 * timestamp (in seconds) at which it expires. Both start null so the first
 * call to getIamToken() always performs a fresh exchange.
 */
let cachedToken      = null;
let tokenExpiresAt   = 0; // Unix epoch seconds

/**
 * getIamToken — returns a valid IBM Cloud IAM Bearer token, fetching a
 * new one from the IAM endpoint only when the cache is stale.
 *
 * @returns {Promise<string>} A valid access_token string.
 * @throws  {Error} if the IAM exchange HTTP call fails or returns non-2xx.
 */
async function getIamToken() {
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Return the cached token if it won't expire within the refresh buffer.
  // This is the common path — the IAM endpoint is only hit ~once per hour.
  if (cachedToken && nowSeconds < tokenExpiresAt - IAM_TOKEN_REFRESH_BUFFER_SECONDS) {
    return cachedToken;
  }

  // Exchange the API key for an access token using IBM's OAuth grant type.
  const response = await fetch(IAM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `apikey=${encodeURIComponent(WATSONX_API_KEY)}&grant_type=urn:ibm:params:oauth:grant-type:apikey`,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[watsonxClient] IAM token exchange failed (${response.status}): ${body}`);
  }

  const data = await response.json();

  // expires_in is the token lifetime in seconds from the moment of issue.
  // We record when it expires so getIamToken() can decide autonomously
  // when to refresh without needing an external scheduler.
  cachedToken    = data.access_token;
  tokenExpiresAt = nowSeconds + (data.expires_in || 3600);

  console.log(`[watsonxClient] IAM token refreshed — expires in ${data.expires_in || 3600}s`);
  return cachedToken;
}

// --- Text generation --------------------------------------------------------

/**
 * generateText — sends a prompt to Granite and returns the raw generated
 * text string. Does NOT clean or validate the output — that is Stage 4's
 * job (qualityCheck.js).
 *
 * @param {string} prompt - The fully-assembled prompt from promptBuilder.js.
 * @returns {Promise<string>} Raw generated text from Granite.
 * @throws  {Error} on non-2xx responses or unexpected response shape.
 */
async function generateText(prompt) {
  // Always obtain a valid token first — getIamToken() handles caching so
  // this is cheap in the common case.
  const token = await getIamToken();

  const url = `${WATSONX_URL}/ml/v1/text/generation?version=2023-05-29`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      model_id:   GRANITE_MODEL_ID,
      project_id: WATSONX_PROJECT_ID,
      input:      prompt,
      parameters: GENERATION_PARAMS,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[watsonxClient] Generation request failed (${response.status}): ${body}`);
  }

  const data = await response.json();

  // Defensive parsing: if the expected path doesn't exist, throw so
  // qualityCheck.js catches it and retries / falls back cleanly.
  if (!data.results || !data.results[0] || data.results[0].generated_text == null) {
    throw new Error('[watsonxClient] Unexpected response shape — results[0].generated_text missing');
  }

  return data.results[0].generated_text;
}

module.exports = { generateText };
