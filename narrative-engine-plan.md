# Narrative Engine — Implementation Plan

## Top-Level Overview

A standalone Node.js/Express backend service lives in `/server`. It generates
short, atmospheric horror narration lines (≤25 words) via IBM Granite on
watsonx.ai. A multi-stage pipeline (context → beat type → prompt → API call →
quality check) produces lines that are pre-buffered in an in-memory pool so the
game client never blocks on a live API call. The service exposes three routes.
No client code is touched; integration happens in a later phase.

The comment style throughout mirrors `js/director.js`: block-level `/**` docs
explain *why* something is done, inline comments explain non-obvious choices.

---

## File Map

```
server/
  package.json          — dependencies, "npm start" script
  .env.example          — documents the three variable names (symlinks to root intent)
  index.js              — Express entry point; mounts routes, starts scheduler
  pipeline/
    interpreter.js      — Stage 1: game state JSON → beat type string
    promptBuilder.js    — Stage 2: beat type + context → Granite prompt string
    watsonxClient.js    — Stage 3: prompt → raw text (HTTP call to watsonx.ai)
    qualityCheck.js     — Stage 4: raw text → clean string or null (retry logic)
  pool/
    narrativePool.js    — In-memory pool, refill scheduler, fallback lines
  routes/
    narrative.js        — Express router for the three API endpoints
```

---

## Sub-Tasks

---

### Sub-Task 1 — Scaffold: `package.json` and entry `index.js`

**Intent**
Establish the Node.js service skeleton — dependencies, start script, and the
Express app that will host routes and kick off the background pool scheduler.
This is the load-bearing frame everything else plugs into.

**Expected Outcomes**
- `server/package.json` with `express`, `dotenv`, `cors`, `node-fetch` (or
  native fetch if Node ≥18 is targeted) as dependencies and
  `"start": "node index.js"` script.
- `server/index.js` that loads `.env` via dotenv, creates an Express app,
  applies `cors()` middleware so browser clients are not blocked, mounts the
  narrative router at `/api/narrative`, starts the HTTP server, and — after
  startup — calls the pool scheduler's init function.
- Running `npm start` from `/server` launches the server without errors (routes
  can return 501 stubs at this stage).

**Todo List**
1. Create `server/package.json` — name `narrative-engine`, main `index.js`,
   scripts `{ "start": "node index.js" }`, dependencies: `express`, `dotenv`,
   `cors`, `node-fetch` (pin to v2 for CommonJS compatibility if Node < 18).
2. Create `server/index.js` — `require('dotenv').config()` at top, instantiate
   Express, `app.use(cors())` before any routes (this service will be called
   from a browser-based game client — without CORS headers those requests will
   be blocked by the browser's same-origin policy), `app.use(express.json())`,
   import & mount router from `./routes/narrative`, `app.listen(3001, ...)`
   with a startup log line.
3. In `index.js`, after `app.listen` callback fires, call
   `narrativePool.startScheduler()` so the pool begins warming once the server
   is ready.
4. Add a brief `/**` block at the top of `index.js` explaining the service
   purpose and startup order — matching the director.js style.

**Relevant Context**
- `js/director.js` — doc block + boundary-of-responsibility comment pattern to emulate
- `.env.example` at root — already documents the three variable names; the
  server-level `.env.example` is just a reminder, not a duplicate source of truth

**Status** `[ ] pending`

---

### Sub-Task 2 — Stage 1: `pipeline/interpreter.js`

**Intent**
Translate a raw game-state JSON object into one of four beat type strings
(`ambient`, `tension`, `hunt_taunt`, `relief`). This mirrors how `director.js`
makes a single, bounded decision — the interpreter never builds prompts or calls
APIs; it only reads game state and assigns a label.

**Expected Outcomes**
- `interpretContext(gameState)` exported function that accepts the game-state
  snapshot and returns one of the four beat type strings.
- Decision logic (priority-ordered): if `enemyState === 'hunt'` → `hunt_taunt`;
  if `isBacktracking === true` or `idleStreak > 8` → `tension`; else → `ambient`.
  `relief` is a valid incoming type too (passed explicitly if the director just
  ended a hunt) but the interpreter doesn't need to *infer* it from raw state —
  callers may pass `beatType` directly to skip interpretation.
- Unit-testable in isolation — no side effects, pure function.

**Expected game state shape** (mirrors `Game.telemetry` + `Game.director` fields):
```json
{
  "roomName": "room_2",
  "isBacktracking": false,
  "idleStreak": 3.2,
  "enemyDistance": 6.1,
  "enemyState": "patrol"
}
```

**Todo List**
1. Create `server/pipeline/interpreter.js`.
2. Export `interpretContext(gameState)` — implement the priority-ordered
   decision tree above with inline comments explaining each threshold choice.
3. Add file-level `/**` doc block explaining that this is the only place
   beat-type assignment lives and why keeping it isolated matters.

**Relevant Context**
- `js/director.js` — `updateDirector()` uses the same field names (`idleStreak`,
  `enemyDistance`, `enemyState`); the interpreter mirrors that logic on the server
- `js/telemetry.js` — `idleStreak`, `enemyDistance`, `currentRoom`, `visitCounts`
  confirm the exact field shapes the client will eventually send

**Status** `[ ] pending`

---

### Sub-Task 3 — Stage 2: `pipeline/promptBuilder.js`

**Intent**
Own the entire craft of prompt construction. Keeping prompt text in one file
means tone adjustments don't require touching generation or pool logic — a clean
separation analogous to how `director.js` never moves the enemy directly.

**Expected Outcomes**
- `buildPrompt(beatType, gameState)` exported function returning a prompt string.
- Tone instruction embedded in every prompt: dread/isolation/"something is
  watching," never gory or graphic, first-person narrator or ally NPC voice.
- Beat-specific framing per type: `ambient` asks for quiet atmospheric flavor;
  `tension` references player idleness/backtracking; `hunt_taunt` references
  the enemy closing in; `relief` references the silence that follows.
- Prompt always ends with an explicit instruction: generate ONE line, under
  ~25 words, no surrounding quotes, no stage directions.
- Room name included in context when present.

**Todo List**
1. Create `server/pipeline/promptBuilder.js`.
2. Define a `BEAT_INSTRUCTIONS` map — one entry per beat type with its
   specific framing text and tone notes.
3. Export `buildPrompt(beatType, gameState)` — assembles system preamble +
   beat instruction + context + output constraint into a single string.
4. Comment why the output constraint is included in the prompt itself (not
   just handled in quality-check) — belt-and-suspenders approach.

**Relevant Context**
- The 25-word target and "no gore" constraint come directly from the user spec
- `js/director.js` — comment philosophy to match

**Status** `[ ] pending`

---

### Sub-Task 4 — Stage 3: `pipeline/watsonxClient.js`

**Intent**
Encapsulate everything about the watsonx.ai REST call — IAM token exchange, URL
construction, auth header, request body shape, and response parsing — so nothing
else in the service ever has to know what the IBM API looks like. Hardcoded
values for API key/project ID are explicitly forbidden; they must come from
`process.env`.

**Expected Outcomes**
- `getIamToken()` internal async function that exchanges `WATSONX_API_KEY` for
  a short-lived IBM Cloud IAM Bearer token via a POST to
  `https://iam.cloud.ibm.com/identity/token` (Content-Type:
  `application/x-www-form-urlencoded`, body:
  `apikey=<key>&grant_type=urn:ibm:params:oauth:grant-type:apikey`). The
  token is cached in module scope alongside its expiry timestamp; a new
  exchange is only triggered when the cached token is absent or expired (IAM
  tokens are valid for ~1 hour — refresh 5 minutes before expiry to be safe).
- `generateText(prompt)` exported async function that calls `getIamToken()`
  first, then uses the returned token as the `Authorization: Bearer` header on
  the generation request — `WATSONX_API_KEY` is never sent to watsonx.ai
  directly.
- Reads `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_URL` from
  `process.env`; logs a clear startup warning if any are missing.
- Uses the watsonx.ai `/ml/v1/text/generation` REST endpoint with the
  `ibm/granite-13b-instruct-v2` model (model ID configurable via a constant
  at the top of the file).
- Request body: `model_id`, `input` (the prompt), `parameters` with
  `max_new_tokens: 60`, `temperature: 0.85`, `stop_sequences: ["\n"]`.
- Response parsed: extracts `results[0].generated_text`.

**Todo List**
1. Create `server/pipeline/watsonxClient.js`.
2. At module load, read the three env vars and log a warning if any are
   falsy (server still starts — callers fall back to hardcoded lines).
3. Implement `getIamToken()` — POST to the IAM token endpoint, parse
   `access_token` and `expires_in` from the response, store both in module
   scope, and return the cached token on subsequent calls until 5 minutes
   before expiry.
4. Export `generateText(prompt)` — call `getIamToken()`, build the
   watsonx.ai fetch request using the IAM token as the Bearer header, parse
   JSON response, return extracted text string.
5. Add file-level `/**` block explaining that this is the only file that
   knows about the IBM API shape (including the two-step auth flow) and why
   that matters for future swaps.

**Relevant Context**
- `.env.example` at project root — the three variable names are already documented
- IBM IAM token endpoint: POST `https://iam.cloud.ibm.com/identity/token`
  with `Content-Type: application/x-www-form-urlencoded` and body
  `apikey=<WATSONX_API_KEY>&grant_type=urn:ibm:params:oauth:grant-type:apikey`
- watsonx.ai generation endpoint: POST
  `{WATSONX_URL}/ml/v1/text/generation?version=2023-05-29` with
  `Authorization: Bearer <iam_access_token>` and JSON body
  `{ model_id, project_id, input, parameters }`

**Status** `[ ] pending`

---

### Sub-Task 5 — Stage 4: `pipeline/qualityCheck.js`

**Intent**
Be the last line of defense before a generated string enters the pool. Strips
cosmetic artifacts (quotes, markdown fences), rejects empty or over-length
output, and implements retry + fallback so the rest of the system never has to
handle API failure — it just gets a string back, always.

**Expected Outcomes**
- `generateWithFallback(beatType, gameState)` exported async function that
  orchestrates the full pipeline (calls interpreter if needed, builds prompt,
  calls client, quality-checks) and always returns a non-empty string.
- `cleanAndValidate(rawText)` — strips surrounding quotes/backticks/markdown,
  returns `null` if empty or > 40 words.
- On first failure (null or thrown): retries once.
- On second failure: returns the hardcoded fallback for that beat type.
- Fallback lines (one per beat type) defined as constants in this file.

**Todo List**
1. Create `server/pipeline/qualityCheck.js`.
2. Define `FALLBACK_LINES` — one atmospheric one-liner per beat type
   (`ambient`, `tension`, `hunt_taunt`, `relief`).
3. Export `cleanAndValidate(rawText)` — strip/validate, return clean string
   or `null`.
4. Export `generateWithFallback(beatType, gameState)` — runs the full
   pipeline with try/retry/fallback logic; comment why two attempts are the
   right number (one retry catches transient errors without hanging the game).
5. Import `interpretContext`, `buildPrompt`, `generateText` here — this is the
   only place that knows the full pipeline sequence.

**Relevant Context**
- `js/director.js` — `endHunt()` pattern: do the thing, then ensure a known-
  good state always follows
- The "game must never hang or break" constraint from the spec is what drives
  the fallback design

**Status** `[ ] pending`

---

### Sub-Task 6 — `pool/narrativePool.js`

**Intent**
Decouple API latency from the game loop. The pool pre-generates lines so that
when the client requests one it gets an instant response. The scheduler quietly
keeps each beat-type bucket above a minimum watermark in the background.

**Expected Outcomes**
- `pool` object: `{ ambient: [], tension: [], hunt_taunt: [], relief: [] }`.
- `popLine(beatType)` — removes and returns the first line from the bucket, or
  returns the fallback if the bucket is empty (never blocks).
- `refillBucket(beatType)` async — calls `generateWithFallback` and pushes
  the result into the bucket. Runs silently on errors (logs only).
- `startScheduler()` — calls `setInterval` every 10 000 ms; for each beat
  type, if its bucket has fewer than 3 items, calls `refillBucket` (non-
  blocking, fire-and-forget). Logs pool sizes at each tick for observability.
- On startup (called from `index.js`), does an initial eager fill: calls
  `refillBucket` once for each beat type so the pool is not empty on the
  first request.

**Todo List**
1. Create `server/pool/narrativePool.js`.
2. Define the `pool` object and `BEAT_TYPES` array constant.
3. Export `popLine(beatType)` — pop or return fallback.
4. Export `refillBucket(beatType)` async — generate and push; swallow errors
   with a `console.warn`.
5. Export `startScheduler()` — set up the interval loop + initial eager fill.
6. Add file-level `/**` block explaining *why* the pool exists (API latency
   vs. game responsiveness), the chosen watermark of 3, and a note that the
   IBM Cloud Lite plan provides ~300,000 tokens/month — the 10-second
   interval and watermark of 3 are deliberately conservative and should not
   be tightened without auditing how many tokens each generation consumes.

**Relevant Context**
- `js/director.js` — `decisionInterval` + throttling pattern as a model for
  the scheduler's rhythm
- qualityCheck.js `generateWithFallback` is the only external dependency

**Status** `[ ] pending`

---

### Sub-Task 7 — `routes/narrative.js` and final wiring

**Intent**
Expose the three API endpoints the spec requires. Routes are thin — they
delegate to `narrativePool` and `generateWithFallback`; no pipeline logic
lives here.

**Expected Outcomes**
- `GET /api/narrative/next?type=<beatType>` — validates the type param,
  calls `popLine`, triggers a background `refillBucket` if the bucket is
  now below watermark, returns `{ line, beatType, poolSize }`.
- `GET /api/narrative/status` — returns `{ pool: { ambient: N, tension: N, ... } }`.
- `POST /api/narrative/test-generate` — accepts `{ beatType, gameState }` body,
  calls `generateWithFallback` directly (bypasses pool), returns
  `{ beatType, line, source: "granite"|"fallback" }`.
- All routes return JSON; unknown beat types return 400.
- Route file has a `/**` block explaining that routes are intentionally thin.

**Todo List**
1. Create `server/routes/narrative.js` — Express Router.
2. Implement `GET /next` with type validation, `popLine`, background refill trigger.
3. Implement `GET /status` returning pool sizes.
4. Implement `POST /test-generate` for pipeline smoke-testing.
5. Mount router in `index.js` at `/api/narrative`.
6. Smoke-test manually: `npm start` → `curl localhost:3001/api/narrative/status`
   should return the pool object.

**Relevant Context**
- Pool and quality-check modules from Sub-Tasks 5 and 6
- The three route specs are verbatim from the user request

**Status** `[ ] pending`
