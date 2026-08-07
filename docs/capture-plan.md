# Capture Ending Plan

## Overview

Extend the existing Recap Generator into a two-outcome ending system.
Reaching `final_chamber` is the **escaped** ending (existing). Getting caught
during a hunt (enemy closes to within `huntEndDistance` while hunting) is the
**caught** ending (new). Both outcomes share the same `#recap-overlay` element,
the same backend route, and the same prompt pipeline — the `outcome` field
branches tone inside `buildRecapPrompt`, not structure.

No new overlay, no new route, no new pipeline. The changes are:
1. Backend: branch prompt tone and add a second fallback constant.
2. `director.js`: proximity end-of-hunt → `triggerCapture()` instead of `endHunt()`.
3. `recap.js`: `buildRecapStats(outcome)` + new `triggerCapture()` function.
4. `css/style.css`: `#recap-overlay.outcome-caught` tint modifier.
5. `index.html`: `#recap-hint` content updated dynamically by JS, not hardcoded.

---

## Exact Branch Logic Confirmation

### `updateDirector()` hunt-active block (director.js lines 80-118)

**BEFORE:**
```js
if (huntElapsed > d.maxHuntDuration || caughtUp) {
  endHunt();
}
```

**AFTER:**
```js
if (caughtUp) {
  // Proximity during a hunt is lethal. See design comment in implementation.
  triggerCapture();
  return;
}
if (huntElapsed > d.maxHuntDuration) {
  endHunt();
}
```

`return` after `triggerCapture()` is required — without it, the drone-update
block below the if-statement would still run this frame, and `updateHeartbeatTempo`
would be called on a frame where the hunt is already conceptually over.

### `recap.js` state-transition handling for 'caught'

`triggerCapture()` sets `Game.state = 'caught'` **directly** (not via
`setGameState()`), for exactly the same reason `triggerRecap()` sets
`Game.state = 'recap'` — both are terminal overlay states that own their own
DOM and must not trigger start-overlay/crosshair manipulation in `setGameState`.
`setGameState` was explicitly designed to leave these states unhandled.

The critical ordering in `triggerCapture()` mirrors `triggerRecap()`:
1. Set `Game.state = 'caught'` — must be first, before `exitPointerLock()`
2. Call audio effects (`playStinger()`, `stopHeartbeat()`, `pauseAudio()`)
3. Show overlay with loading state
4. Call `document.exitPointerLock()`
5. Fetch narrative

**Dismiss behavior for 'caught'** is fundamentally different from 'escaped':
- 'escaped' (`dismissRecap`): requests pointer lock, continues playing
- 'caught' (`dismissCapture`): calls `location.reload()` — full clean restart

`dismissCapture` is registered on the overlay's click listener in `initRecap()`
conditionally based on `Game.state`. Since both outcomes share `#recap-overlay`,
`initRecap()` uses a single delegating click handler that reads `Game.state` at
click time and calls the appropriate dismiss function.

The `R` key dismiss for 'caught' is handled in `main.js`'s existing keydown
listener — the `Escape` handler already calls `dismissRecap()`; a parallel call
to `dismissCapture()` is added for both `KeyR` and `Escape` (each dismiss
function guards on its own state, so only the correct one will fire).

---

## Sub-Tasks

### Sub-Task 1 — server/pipeline/promptBuilder.js: branch outcome tone
**Status:** [x] done

**Intent:** `buildRecapPrompt(stats)` reads `stats.outcome` and uses different
framing. 'escaped' keeps existing relieved/reflective voice. 'caught' uses
second-person dread — the dungeon having caught up, the narrative closing in
failure. Both reference the same stat fields with the same omit-on-zero logic.

**Expected Outcomes:**
- `buildRecapPrompt` accepts `outcome` from `stats.outcome` (defaults `'escaped'`)
- A `CAUGHT_PREAMBLE` constant replaces `RECAP_PREAMBLE` when outcome is 'caught'
- The context block (distance, hunts, close calls, sneak, backtracked rooms) is
  shared between both outcomes — only the framing preamble differs
- The 'caught' preamble instructs the model: second person, sense of the narrative
  ending, dungeon that caught up, no gore, no graphic violence, same ~80-120 words

**Todo List:**
1. Add `CAUGHT_PREAMBLE` constant after `RECAP_PREAMBLE`
2. In `buildRecapPrompt(stats)`, destructure `outcome` from stats (default `'escaped'`)
3. Select preamble based on outcome: `const preamble = outcome === 'caught' ? CAUGHT_PREAMBLE : RECAP_PREAMBLE`
4. Use `preamble` in the assembled prompt array
5. Update JSDoc to document the `stats.outcome` parameter

**Relevant Context:**
- `promptBuilder.js` line 126: `RECAP_PREAMBLE` — the escaped preamble stays unchanged
- `promptBuilder.js` line 154: `buildRecapPrompt(stats)` — add outcome destructuring here
- `promptBuilder.js` line 237: `module.exports` — no change needed

---

### Sub-Task 2 — server/pipeline/qualityCheck.js: add FALLBACK_CAUGHT + outcome selection
**Status:** [x] done

**Intent:** When both Granite attempts fail on a 'caught' outcome, the player
should see a tone-matched caught fallback, not the relieved escaped fallback.
Add `FALLBACK_CAUGHT` and make `generateRecapWithFallback` select by
`stats.outcome`.

**Expected Outcomes:**
- `FALLBACK_CAUGHT` constant added — second-person, dread-toned, failure-framing
- `generateRecapWithFallback(stats)` selects fallback:
  `const fallback = stats.outcome === 'caught' ? FALLBACK_CAUGHT : FALLBACK_RECAP`
- `FALLBACK_CAUGHT` exported alongside `FALLBACK_RECAP`
- No structural change to the retry loop — just the fallback selection and export

**Todo List:**
1. Add `FALLBACK_CAUGHT` constant after `FALLBACK_RECAP`
2. In `generateRecapWithFallback`, compute `fallback` from `stats.outcome` before the loop
3. Replace the hardcoded `return FALLBACK_RECAP` at the end of the function with `return fallback`
4. Add `FALLBACK_CAUGHT` to `module.exports`

**Relevant Context:**
- `qualityCheck.js` line 177: `FALLBACK_RECAP`
- `qualityCheck.js` line 250: `generateRecapWithFallback` — fallback selected here
- `qualityCheck.js` line 273: `module.exports`

---

### Sub-Task 3 — server/routes/narrative.js: export FALLBACK_CAUGHT
**Status:** [x] done

**Intent:** The route currently imports `FALLBACK_RECAP` for its `source` detection
(`recap === FALLBACK_RECAP ? 'fallback' : 'granite'`). With two possible fallbacks,
this comparison needs to check both. Also update the route's file-level doc to mention
the `outcome` field passthrough.

**Expected Outcomes:**
- `FALLBACK_CAUGHT` imported alongside `FALLBACK_RECAP`
- The `source` determination on the recap route checks
  `recap === FALLBACK_RECAP || recap === FALLBACK_CAUGHT ? 'fallback' : 'granite'`
- File-level doc updated to note `outcome` field is passed through to the prompt builder
- No route signature changes — `req.body` already passes through unchanged

**Todo List:**
1. Add `FALLBACK_CAUGHT` to the destructured import from `qualityCheck`
2. Update the `source` comparison on line 130
3. Update the route JSDoc to mention the `outcome` field

**Relevant Context:**
- `narrative.js` lines 37-42: destructured import from qualityCheck
- `narrative.js` line 130: `const source = recap === FALLBACK_RECAP ? 'fallback' : 'granite'`

---

### Sub-Task 4 — js/director.js: caughtUp → triggerCapture()
**Status:** [x] done

**Intent:** Proximity during a hunt is now the actual danger. Outlasting the timer
is how you survive. This is the single most important gameplay change in the spec.

**Expected Outcomes:**
- `caughtUp` check fires `triggerCapture()` and returns immediately
- `huntElapsed > maxHuntDuration` check fires `endHunt()` as before
- The two conditions are now separate if-statements (not combined with `||`)
- A detailed comment explains the design change at the branch point
- `endHunt()` is never called when the player is caught — the hunt ends through
  capture, not relief

**Todo List:**
1. Split the single `if (huntElapsed > d.maxHuntDuration || caughtUp)` into two:
   - `if (caughtUp) { triggerCapture(); return; }` — check first (proximity is
     more immediately relevant than elapsed time)
   - `if (huntElapsed > d.maxHuntDuration) { endHunt(); return; }` — check second
2. Add a block comment above the `caughtUp` branch explaining the core design change

**Relevant Context:**
- `director.js` lines 80-118: the hunt-active block
- `director.js` line 82: `caughtUp` definition
- `director.js` line 84: the combined `if` being split

---

### Sub-Task 5 — js/recap.js: buildRecapStats(outcome) + triggerCapture()
**Status:** [x] done

**Intent:** Add `outcome` to the stats payload and add `triggerCapture()` as a
parallel to `triggerRecap()`. Reuse the same overlay, same endpoint, same fetch
pattern. The dismiss behavior for 'caught' is a reload, not a pointer lock request.

**Expected Outcomes:**
- `buildRecapStats(outcome)` includes `outcome` in the returned object
- `RECAP_CLIENT_CAUGHT_FALLBACK` constant added (client-side fallback for caught ending)
- `triggerCapture()`:
  - Guards on `Game.state === 'caught'` to prevent stacking
  - Sets `Game.state = 'caught'` directly (not via `setGameState`) — same pattern
    as `triggerRecap()` setting `'recap'`
  - Adds `'outcome-caught'` CSS class to `#recap-overlay` for the tint modifier
  - Calls `playStinger()`, `stopHeartbeat()`, `pauseAudio()` before exitPointerLock
  - Updates `.recap-hint` to "Press R or click to try again"
  - Fetches the same endpoint with `buildRecapStats('caught')` as body
  - Falls back to `RECAP_CLIENT_CAUGHT_FALLBACK` on fetch failure
- `dismissCapture()`:
  - Guards on `Game.state !== 'caught'`
  - Calls `location.reload()`
  - Comment explains why reload vs. manual reset
- `triggerRecap()` updated to call `buildRecapStats('escaped')` (previously no argument)
- `initRecap()`'s click handler replaced with a delegating handler that reads
  `Game.state` at click time and calls either `dismissRecap()` or `dismissCapture()`
- `checkRecapAutoTrigger()` updated: also guard `Game.state !== 'caught'` (a player
  who was caught should not then also trigger the escaped ending)

**Todo List:**
1. Add `RECAP_CLIENT_CAUGHT_FALLBACK` constant
2. Change `buildRecapStats()` signature to `buildRecapStats(outcome)` and add `outcome`
   to the returned object
3. Update `triggerRecap()` call to `buildRecapStats('escaped')`
4. Add `triggerCapture()` function after `triggerRecap()`
5. Add `dismissCapture()` function after `dismissRecap()`
6. Replace the single click handler in `initRecap()` with a delegating handler
7. Update `checkRecapAutoTrigger()` to also check `Game.state !== 'caught'`
8. Update file-level doc to reflect the module now handles both endings

**Relevant Context:**
- `recap.js` line 67: `buildRecapStats()` — add `outcome` parameter
- `recap.js` line 129: `triggerRecap()` — update `buildRecapStats` call
- `recap.js` line 207: `initRecap()` — replace click handler
- `recap.js` line 230: `checkRecapAutoTrigger()` — add 'caught' guard
- `gamestate.js` line 55: lists valid states — 'caught' is already noted in the
  comment as a future state; `setGameState` intentionally has no branch for it

---

### Sub-Task 6 — css/style.css + index.html: outcome-caught tint + hint content
**Status:** [x] done

**Intent:** Give the caught overlay a subtly different visual tone without needing
a second overlay element. A CSS modifier class (`outcome-caught`) on `#recap-overlay`
adds a faint red tint to the background. The `.recap-hint` text is updated
dynamically by `triggerCapture()` so the hint always matches the outcome.

**Expected Outcomes:**
- `#recap-overlay.outcome-caught` adds a reddish background tint
  (`rgba(40, 0, 0, 0.92)` or similar — dark enough to feel distinct, subtle
  enough not to look garish)
- `'outcome-caught'` class is added by `triggerCapture()` and removed by
  `triggerRecap()` (so replaying after a reload starts clean — not strictly
  needed since reload resets everything, but defensive)
- The `#recap-hint` paragraph in `index.html` has a generic default ("Click or
  press ESC to continue") which is overwritten at runtime by the JS functions —
  no HTML change strictly needed, but the CSS comment on `#recap-overlay` should
  be updated to remove the stale `!Game.recap.active` reference from a prior
  implementation

**Todo List:**
1. Add `.outcome-caught` CSS rule after `#recap-overlay.hidden`
2. Update the CSS comment block header (line 135 reference to `!Game.recap.active`
   is stale — replace with current explanation)

**Relevant Context:**
- `css/style.css` line 131-154: `#recap-overlay` block
- The `.recap-hint` default text in `index.html` line 30 stays as-is;
  `triggerCapture()` and `triggerRecap()` overwrite it at runtime

---

### Sub-Task 7 — js/main.js: wire dismissCapture into keydown handler
**Status:** [x] done

**Intent:** The existing `Escape` keydown handler calls `dismissRecap()`. The `R`
handler calls `triggerRecap()`. Both need to also handle the 'caught' state.
Since each dismiss function is guarded on its own state, calling both is safe —
only the one matching the current state will do anything.

**Expected Outcomes:**
- `Escape` keydown: calls both `dismissRecap()` AND `dismissCapture()` (order
  doesn't matter; only the matching guard fires)
- `KeyR` keydown: when NOT in `'caught'` state, calls `triggerRecap()` as before;
  when IN `'caught'` state, calls `dismissCapture()` (R is the "try again" key
  for the caught ending, as specified)

**Todo List:**
1. In the `Escape` handler, add `dismissCapture()` after `dismissRecap()`
2. In the `KeyR` handler, change from unconditionally calling `triggerRecap()`
   to: if `Game.state === 'caught'` call `dismissCapture()`, else call `triggerRecap()`

**Relevant Context:**
- `main.js` lines 92-102: keydown handler
