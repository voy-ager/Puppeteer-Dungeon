# Recap Generator — Implementation Plan

## Top-Level Overview

A personalized end-of-session narrative summary, shown when the player reaches
`final_chamber` (or on demand with `R`). One paragraph (~80-120 words) generated
by Granite referencing actual telemetry numbers. Entirely separate code path from
the beat-type pool system — no pool interaction, no pool changes.

**Data flow:**
```
final_chamber reached
  → checkRecapAutoTrigger() [js/recap.js, called from main.js]
    → buildRecapStats()     [assembles from Game.telemetry + Game.director]
      → POST /api/narrative/recap [server/routes/narrative.js]
        → generateRecapWithFallback(stats) [server/pipeline/qualityCheck.js]
          → buildRecapPrompt(stats)         [server/pipeline/promptBuilder.js]
            → generateText(prompt)          [server/pipeline/watsonxClient.js]
        → { recap, source }
      → display in #recap-overlay [js/recap.js + css/style.css]
```

---

## Stats shape (confirmed)

```json
{
  "totalDistance":         245.3,
  "totalPlayTimeSeconds":  412,
  "huntCount":             4,
  "noiseTriggeredCount":   1,
  "comfortTriggeredCount": 3,
  "closeCallSeconds":      38.2,
  "sneakTimeSeconds":      65.0,
  "backtrackedRooms":      ["room_2", "entry_hall"]
}
```

Sources:
- `totalDistance` ← `Game.telemetry.totalDistance`
- `totalPlayTimeSeconds` ← `Game.elapsedTime`
- `huntCount`, `noiseTriggeredCount`, `comfortTriggeredCount` ← new counters
  added to `Game.director` (Sub-Task 4)
- `closeCallSeconds` ← `Game.telemetry.closeCallSeconds`
- `sneakTimeSeconds` ← new `Game.telemetry.sneakTime` accumulator (Sub-Task 5)
- `backtrackedRooms` ← derived from `Game.telemetry.visitCounts` — rooms with
  count > 1, with room name strings cleaned (`_` → space for prompt, raw for
  the stats readout)

---

## Sub-Tasks

---

### Sub-Task 1 — `server/pipeline/promptBuilder.js`: add `buildRecapPrompt(stats)`

**Intent**
A distinct prompt function for the recap — same file, same tone contract, but
completely separate from the beat-type `BEAT_INSTRUCTIONS` map. The recap prompt
instructs Granite to write in second person ("You..."), referencing real numbers
from `stats`, targeting ~80-120 words, atmospheric and dread-toned, no
meta-commentary, no surrounding quotes.

**Expected Outcomes**
- `buildRecapPrompt(stats)` exported alongside existing `buildPrompt`.
- A dedicated `RECAP_PREAMBLE` constant (separate from `SYSTEM_PREAMBLE`) that
  establishes: second-person narrator, full paragraph (not one line), same no-gore
  no-"darkness" tone contract, 80-120 word target.
- The assembled prompt injects stats naturally:
  - Play time in minutes (rounded)
  - Rooms backtracked (if any)
  - Hunt count and how many were noise-triggered vs comfort-triggered
  - Close-call seconds (if > 5)
  - Sneak time (if > 10s)
  - Total distance walked
- Stats are formatted into the prompt as readable prose instructions, not raw
  JSON. Fields with value 0 or empty arrays are omitted via conditional logic so
  the prompt doesn't include awkward "0 times you..." phrasing.
- Output instruction at the end: "Write the paragraph now. No quotation marks.
  No headings. No summary label. Begin with 'You'."

**Todo List**
1. Add `RECAP_PREAMBLE` constant below the existing `SYSTEM_PREAMBLE`.
2. Write `buildRecapPrompt(stats)` — assemble preamble + conditionally-included
   stat lines + output instruction.
3. Export `buildRecapPrompt` alongside `buildPrompt`.
4. Add `/**` block explaining why recap gets its own preamble rather than reusing
   `SYSTEM_PREAMBLE` (different output format: paragraph vs single line).

**Relevant Context**
- [`server/pipeline/promptBuilder.js:31`](server/pipeline/promptBuilder.js:31) —
  `SYSTEM_PREAMBLE` pattern to mirror

**Status** `[ ] pending`

---

### Sub-Task 2 — `server/pipeline/qualityCheck.js`: add `generateRecapWithFallback(stats)`

**Intent**
Parallel to `generateWithFallback` but for recaps: same retry-once-then-fallback
pattern, same `generateText` call, but with a relaxed word cap (180 words instead
of 40) and its own hardcoded fallback paragraph. The existing
`cleanAndValidate` function is reused for stripping artifacts; a new
`cleanAndValidateRecap(rawText)` handles the different word limit.

**Expected Outcomes**
- `FALLBACK_RECAP` constant — one atmospheric paragraph referencing the dungeon
  remembering the player passed through. Generic but still tone-consistent and
  written in second person. (~60-80 words.)
- `cleanAndValidateRecap(rawText)` — same stripping logic as `cleanAndValidate`,
  but rejects if empty OR over 180 words (not 40).
- `generateRecapWithFallback(stats)` async — calls `buildRecapPrompt(stats)`,
  then `generateText(prompt)`, then `cleanAndValidateRecap`. Retries once on
  null/throw. Falls back to `FALLBACK_RECAP` on second failure. Always resolves.
- Comment explaining why the word limit is relaxed for recaps (a paragraph is
  the intended output; 40 words would reject every valid response).

**Todo List**
1. Add `FALLBACK_RECAP` constant.
2. Add `cleanAndValidateRecap(rawText)` — same stripping, cap at 180 words.
3. Add `generateRecapWithFallback(stats)` async — build prompt, call
   `generateText`, validate, retry once, return fallback.
4. Export `generateRecapWithFallback` and `FALLBACK_RECAP`.
5. Add `require('./promptBuilder')` import for `buildRecapPrompt` (already
   imported, just destructure the new export).

**Relevant Context**
- [`server/pipeline/qualityCheck.js:130`](server/pipeline/qualityCheck.js:130) —
  `generateWithFallback` to mirror structurally

**Status** `[ ] pending`

---

### Sub-Task 3 — `server/routes/narrative.js`: add `POST /api/narrative/recap`

**Intent**
Thin route handler: validate body presence, delegate to
`generateRecapWithFallback`, return `{ recap, source }`. No pool interaction,
no beat-type validation.

**Expected Outcomes**
- `POST /api/narrative/recap` accepts `{ ...stats }` JSON body.
- Returns 400 if body is completely absent/empty.
- Calls `generateRecapWithFallback(req.body)`, awaits the result.
- Returns `{ recap: string, source: 'granite'|'fallback' }` — source detected
  by comparing result to `FALLBACK_RECAP`.
- Route-level `/**` block added documenting the endpoint.

**Todo List**
1. Add `generateRecapWithFallback, FALLBACK_RECAP` to the `require` from
   `qualityCheck`.
2. Add the `POST /recap` route handler.
3. Update the file-level `/**` block's endpoint list to include `/recap`.

**Relevant Context**
- [`server/routes/narrative.js:75`](server/routes/narrative.js:75) — existing
  `test-generate` route as structural model

**Status** `[ ] pending`

---

### Sub-Task 4 — `js/director.js`: hunt counters + `startHunt(reason)`

**Intent**
Track how many hunts occurred and what caused each one — essential stats for the
recap. The `reason` parameter makes the call sites explicit about which pathway
fired, which also makes the code self-documenting.

**Expected Outcomes**
- Three new fields on `Game.director`: `huntCount: 0`, `noiseTriggeredCount: 0`,
  `comfortTriggeredCount: 0`.
- `startHunt()` signature becomes `startHunt(reason)` where `reason` is
  `'comfort'` or `'noise'`.
- Inside `startHunt`, always increment `huntCount`; increment
  `noiseTriggeredCount` or `comfortTriggeredCount` based on `reason`.
- The noise-pathway call site: `startHunt('noise')`.
- The comfort-pathway call site: `startHunt('comfort')`.
- `lastEvent` string unchanged — `reason` is for stats only.
- Comment in `startHunt` explaining why reason is a parameter rather than
  inferred from state (by the time `startHunt` runs, both pathways look
  identical from the inside — the call site is the only place that knows why).

**Todo List**
1. Add `huntCount`, `noiseTriggeredCount`, `comfortTriggeredCount` to
   `Game.director`.
2. Change `startHunt()` to `startHunt(reason)`.
3. Add counter increments inside `startHunt`.
4. Update noise-pathway call site (line 130): `startHunt('noise')`.
5. Update comfort-pathway call site (line 167): `startHunt('comfort')`.

**Relevant Context**
- [`js/director.js:130`](js/director.js:130) — noise pathway call site
- [`js/director.js:167`](js/director.js:167) — comfort pathway call site
- [`js/director.js:171`](js/director.js:171) — `startHunt()` definition

**Status** `[ ] pending`

---

### Sub-Task 5 — `js/telemetry.js`: add `sneakTime` accumulator

**Intent**
Simple lifetime total of seconds spent sneaking — one new field, one new
accumulator line in `updateTelemetry`. No decay, no threshold logic.

**Expected Outcomes**
- `sneakTime: 0` added to `Game.telemetry`.
- In `updateTelemetry(delta)`, after the existing sneak-dependent noise block:
  `if (Game.controls.sneaking) { t.sneakTime += delta; }`
- Inline comment explaining this is a lifetime total for the recap stats
  (contrast with `noiseLevel` which is a real-time signal, not a counter).

**Todo List**
1. Add `sneakTime: 0` to `Game.telemetry`.
2. Add the `sneakTime` increment inside `updateTelemetry`.

**Relevant Context**
- [`js/telemetry.js:78`](js/telemetry.js:78) — `Game.controls.sneaking` already
  read here for noise targeting; `sneakTime` increment goes nearby

**Status** `[ ] pending`

---

### Sub-Task 6 — `js/recap.js`: new file

**Intent**
Self-contained module that owns the recap overlay lifecycle: stat assembly,
fetch, display, dismiss. Two entry points for `main.js`: `initRecap()` (boot)
and `checkRecapAutoTrigger()` (per-frame).

**`Game.recap` shape:**
```js
Game.recap = {
  active:     false,  // true while overlay is showing; blocks gameplay updates
  autoShown:  false,  // true once final_chamber trigger has fired (one-shot)
  element:    null,   // cached #recap-overlay DOM reference
};
```

**`buildRecapStats()`** — assembles the stats object from live game state:
- `totalDistance`: `Math.round(Game.telemetry.totalDistance * 10) / 10`
- `totalPlayTimeSeconds`: `Math.round(Game.elapsedTime)`
- `huntCount`, `noiseTriggeredCount`, `comfortTriggeredCount`: from `Game.director`
- `closeCallSeconds`: `Math.round(Game.telemetry.closeCallSeconds * 10) / 10`
- `sneakTimeSeconds`: `Math.round(Game.telemetry.sneakTime)`
- `backtrackedRooms`: `Object.keys(Game.telemetry.visitCounts).filter(r => Game.telemetry.visitCounts[r] > 1)`

**`triggerRecap()`** — the main action:
1. Guard: if `Game.recap.active` already, no-op.
2. Set `Game.recap.active = true`.
3. Show overlay with a loading state ("The dungeon is remembering…").
4. `document.exitPointerLock()` so player can read.
5. `fetch(NARRATIVE_API_BASE + '/recap', { method: 'POST', body: JSON.stringify(buildRecapStats()) })`.
6. On success: populate overlay with recap paragraph + stats readout, replace loading state.
7. On any failure: show client-side fallback paragraph (different from the
   server fallback — this one covers the case where the server is completely
   unreachable). Never leave the overlay in a broken state.
8. Overlay has a click handler (set once at init) and a keydown handler for
   `Escape` to dismiss: sets `Game.recap.active = false`, hides overlay,
   calls `Game.renderer.domElement.requestPointerLock()` to resume.

**`checkRecapAutoTrigger()`** — one-shot check:
```js
if (Game.telemetry.currentRoom === 'final_chamber'
    && !Game.recap.autoShown
    && !Game.recap.active) {
  Game.recap.autoShown = true;
  triggerRecap();
}
```

**`initRecap()`** — caches `element`, attaches the overlay click/key dismiss handler.

**Todo List**
1. Declare `Game.recap` object.
2. Write `buildRecapStats()`.
3. Write `initRecap()` — cache element, attach dismiss handlers.
4. Write `triggerRecap()` — guard, set active, exit pointer lock, show
   loading state, fetch, populate or show client fallback.
5. Write `checkRecapAutoTrigger()`.
6. Add file-level `/**` block explaining this is the only place that
   touches the recap overlay DOM, and why `Game.recap.active` pauses
   gameplay (reading the recap while the enemy is still moving would
   be disorienting and risk missing the dismiss click).

**Relevant Context**
- `NARRATIVE_API_BASE` is defined in `narrativeUI.js` (same file-scope global —
  `recap.js` loads after it, so the constant is already available)
- [`js/narrativeUI.js:19`](js/narrativeUI.js:19) — `NARRATIVE_API_BASE`
- [`js/director.js:24`](js/director.js:24) — `Game.director` fields to read
- [`js/telemetry.js:20`](js/telemetry.js:20) — `Game.telemetry` fields to read

**Status** `[ ] pending`

---

### Sub-Task 7 — `js/main.js`: wiring

**Intent**
Four minimal additions to `main.js` — one init call, one per-frame trigger
check, gating gameplay updates on `Game.recap.active`, and an `R` key shortcut.

**Expected Outcomes**
- `initRecap()` called in the boot sequence after `initNarrativeUI()`.
- In `animate()`, the existing gameplay block becomes:
  ```js
  if (Game.controls.enabled && !Game.recap.active) {
    // ... existing updateControls, updateTelemetry, etc.
  }
  ```
- `checkRecapAutoTrigger()` called every frame, outside the gated block —
  it needs to fire even when `Game.controls.enabled` is false (e.g. before
  pointer lock) since it only reads `currentRoom` and guards on `autoShown`.
- `renderDebugOverlay()` keeps running normally (outside the gate).
- `'KeyR'` added to the keydown handler: calls `triggerRecap()` at any time
  for manual/demo use.

**Todo List**
1. Add `initRecap()` to boot sequence.
2. Add `!Game.recap.active` to the `animate()` gameplay gate.
3. Add `checkRecapAutoTrigger()` call in `animate()`, outside the gate.
4. Add `'KeyR'` handler.

**Relevant Context**
- [`js/main.js:59`](js/main.js:59) — existing `if (Game.controls.enabled)` gate

**Status** `[ ] pending`

---

### Sub-Task 8 — `index.html` + `css/style.css`: recap overlay

**Intent**
Add the `#recap-overlay` div and its child structure, plus CSS that matches the
existing dark/atmospheric visual language. Hidden by default, same `.hidden`
pattern as `#start-overlay`.

**`#recap-overlay` HTML structure:**
```html
<div id="recap-overlay" class="hidden">
  <div class="recap-box">
    <p class="recap-text"></p>
    <p class="recap-stats"></p>
    <p class="recap-hint">Click or press ESC to continue</p>
  </div>
</div>
```

**CSS design:**
- `#recap-overlay`: `position: fixed; inset: 0; z-index: 25` (above start-overlay
  at 20); `background: rgba(0,0,0,0.88)`; `display: flex; align-items: center;
  justify-content: center`. Same `.hidden` opacity-fade pattern as `#start-overlay`.
- `.recap-box`: `max-width: 640px; padding: 3rem 2.5rem; text-align: center`.
- `.recap-text`: a Georgia/serif font (`font-family: Georgia, 'Times New Roman', serif`),
  `font-style: italic`, warm colour `#d8d0c0` (matching `#narrative-subtitle`),
  `font-size: 1.15rem`, `line-height: 1.8`.
- `.recap-stats`: `font-family: 'Courier New', monospace` (matching project default),
  `font-size: 0.78rem`, `color: #7a746a` (matching `.start-box .tagline`),
  `margin-top: 1.8rem`, `line-height: 1.7`.
- `.recap-hint`: same dimmed monospace style as `.start-box .instructions span`.
- `<script src="js/recap.js">` added after `narrativeUI.js`, before `audio.js`.

**Todo List**
1. Add `#recap-overlay` div to `index.html` between `#narrative-subtitle` and
   `#start-overlay`.
2. Add recap CSS rules to `css/style.css`.
3. Add `<script src="js/recap.js">` tag after `narrativeUI.js`.

**Relevant Context**
- [`index.html:21`](index.html:21) — placement: after `#narrative-subtitle`,
  before `#start-overlay`
- [`css/style.css:80`](css/style.css:80) — `#start-overlay` as structural and
  visual model for the overlay

**Status** `[ ] pending`
