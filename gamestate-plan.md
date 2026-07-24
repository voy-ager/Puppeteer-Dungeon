# Game State Machine Plan

## Overview

Replace three independently-reacting flags (`Game.controls.enabled`,
`Game.recap.active`, the `pointerlockchange` overlay-toggle logic) with a single
authoritative `Game.state` string. A new `gamestate.js` module owns the state
machine; the existing modules shed their competing pointer-lock listeners and
ad-hoc active flags.

**Goal:** every "what mode is the game in?" question is answered by reading
`Game.state` from one place, not by AND-ing multiple flags.

**Scope:** state machine + audio pause/resume only. No gameplay changes.

---

## Exact Before/After at Each Call Site

### controls.js — `initControls()` (line 32)
- **BEFORE:** registers `document.addEventListener('pointerlockchange', onPointerLockChange)` which sets `Game.controls.enabled`
- **AFTER:** that line is deleted; `onPointerLockChange` function (lines 38-40) is deleted entirely

### controls.js — `updateControls()` / `onMouseMove()` (lines 43, 80)
- These already gate on `Game.controls.enabled` — no change needed; main.js's consolidated listener sets that field directly, so these guards continue to work without modification.

### main.js — `pointerlockchange` listener (lines 37-46)
- **BEFORE:** single listener toggles overlay/crosshair classes, guarded by `!Game.recap.active`
- **AFTER:** replaced by consolidated listener that sets `Game.controls.enabled` AND calls `setGameState('playing')` or `setGameState('paused')` based on lock state AND current `Game.state`

### main.js — `#start-overlay` click handler (lines 28-35)
- **BEFORE:** always calls `requestPointerLock()`
- **AFTER:** guards with `if (Game.state !== 'playing')` to avoid redundant lock request

### main.js — `animate()` gameplay gate (line 80)
- **BEFORE:** `if (Game.controls.enabled && !Game.recap.active)`
- **AFTER:** `if (Game.state === 'playing')`

### recap.js — `Game.recap` object (lines 30-35)
- **BEFORE:** `active: false` field present, checked by `triggerRecap`, `dismissRecap`, `checkRecapAutoTrigger`, and `main.js`
- **AFTER:** `active` field removed from `Game.recap`; all checks replaced by `Game.state === 'recap'`

### recap.js — `triggerRecap()` (line 126-128)
- **BEFORE:** `if (Game.recap.active) return;` then `Game.recap.active = true;`
- **AFTER:** `if (Game.state === 'recap') return;` then `setGameState('recap');`

### recap.js — `dismissRecap()` (lines 174-176)
- **BEFORE:** `if (!Game.recap.active) return;` then `Game.recap.active = false;`
- **AFTER:** `if (Game.state !== 'recap') return;` — remove the `active = false` line; keep overlay hide + requestPointerLock; do NOT call setGameState here (transition to 'playing' happens via pointerlockchange once browser grants the new lock)

### recap.js — `checkRecapAutoTrigger()` (line 219)
- **BEFORE:** `!Game.recap.active`
- **AFTER:** `Game.state !== 'recap'`

### recap.js — file-level doc block (lines 14-18)
- **BEFORE:** "Why does Game.recap.active pause gameplay?"
- **AFTER:** updated to explain that `Game.state === 'recap'` is the pause mechanism

---

## Sub-Tasks

### Sub-Task 1 — audio.js: add pauseAudio() / resumeAudio()
**Status:** [x] done

**Intent:** Give `gamestate.js` two functions it can call when transitioning to/from
`'paused'`. Using `AudioContext.suspend()/resume()` rather than gain manipulation
is correct because it halts all audio processing atomically — no need to enumerate
individual nodes. Adding here keeps the audio module self-contained.

**Expected Outcomes:**
- `pauseAudio()` suspends the AudioContext if it exists and is running
- `resumeAudio()` resumes it if suspended
- Both are no-ops if `ctx` is null (pre-first-click) — no errors thrown
- Both wrapped in try/catch matching the style of every other function in `audio.js`

**Todo List:**
1. Append `pauseAudio()` and `resumeAudio()` after `playStinger()` at the end of `audio.js`
2. Add a one-line comment above each explaining its specific role

**Relevant Context:**
- `audio.js` line 40: `ctx: null` — guard pattern needed (`if (!a.ctx) return`)
- `audio.js` line 82: `initAudio()` guard style: `try { ... } catch (e) { console.warn(...) }`
- Placement: after `playStinger()` (line 558), before end of file

---

### Sub-Task 2 — New file: js/gamestate.js
**Status:** [x] done

**Intent:** Single module that owns `Game.state` and the `setGameState(newState)`
function. This is the only place that reads from `Game.state` to drive
start-overlay / crosshair visibility and audio. All other modules only ever
READ `Game.state`; they never write it except by calling `setGameState`.

**Expected Outcomes:**
- `Game.state` initialised to `'title'` at load
- `setGameState()` correctly drives start-overlay/crosshair for `'title'`, `'paused'`, `'playing'`
- `setGameState('recap')` (and future `'caught'`/`'escaped'`) intentionally does nothing to start-overlay/crosshair — those states own their own DOM
- `pauseAudio()`/`resumeAudio()` called on transitions to/from `'playing'`
- File-level doc block explains single-source-of-truth purpose

**Todo List:**
1. Create `js/gamestate.js`
2. Write `Game.state = 'title'` at top
3. Write `setGameState(newState)` per the spec (start-overlay/crosshair/audio only for `'title'`/`'paused'`/`'playing'`; no action for `'recap'`)
4. Add file-level JSDoc block

**Relevant Context:**
- `setGameState` calls `pauseAudio()`/`resumeAudio()` from `audio.js` — must load after `audio.js`
- `setGameState` is called from `main.js` — must load before `main.js`
- Therefore script order in `index.html`: `audio.js` → `gamestate.js` → `main.js`

---

### Sub-Task 3 — controls.js: remove duplicate pointerlockchange listener
**Status:** [x] done

**Intent:** Eliminate the competing listener so there is exactly one authoritative
response to pointer-lock events (in `main.js`). `Game.controls.enabled` is still
the mechanism — main.js's consolidated listener sets it directly.

**Expected Outcomes:**
- `initControls()` no longer registers a `pointerlockchange` listener
- `onPointerLockChange()` function no longer exists in `controls.js`
- All other logic in `controls.js` unchanged
- `onMouseMove` and `updateControls` continue using `Game.controls.enabled` unmodified

**Todo List:**
1. Delete line 32 (`document.addEventListener('pointerlockchange', onPointerLockChange)`) from `initControls()`
2. Delete the `onPointerLockChange` function (lines 38-40)

**Relevant Context:**
- `controls.js` lines 29-36: `initControls()`
- `controls.js` lines 38-40: `onPointerLockChange()`

---

### Sub-Task 4 — main.js: consolidate pointerlockchange + update animate gate
**Status:** [x] done

**Intent:** Replace the two-flag gameplay gate and the fragile overlay-toggle listener
with a single state-machine-driven listener. `Game.controls.enabled` is still set here
(controls.js and onMouseMove need it), but overlay/crosshair and audio are now
delegated to `setGameState()`.

**Expected Outcomes:**
- One `pointerlockchange` listener, with comments explaining the critical guard for `'recap'`
- Overlay click handler guards on `Game.state !== 'playing'`
- `animate()` gate reads `Game.state === 'playing'` only
- `main.js` doc block updated to mention gamestate.js
- `const crosshair` and `const overlay` variables still declared (used by `setGameState` indirectly — but actually `setGameState` queries the DOM directly so they may only be needed for `debugOverlay` now — keep `overlay` for the click handler, remove `crosshair` local var if no longer used in main.js directly)

**Todo List:**
1. Replace the existing `pointerlockchange` listener (lines 37-46) with the consolidated version from the spec
2. Update the overlay click handler (line 34) to guard with `if (Game.state !== 'playing')`
3. Change the `animate()` gate from `Game.controls.enabled && !Game.recap.active` to `Game.state === 'playing'`
4. Remove the `const crosshair` variable declaration if it is no longer referenced directly in `main.js` (since `setGameState` queries the DOM itself — verify before removing)
5. Update the file-level doc comment to reference gamestate.js

**Relevant Context:**
- `main.js` lines 24-26: `overlay`, `crosshair`, `debugOverlay` declared here
- `main.js` line 80: current gameplay gate
- `setGameState` in `gamestate.js` calls `document.getElementById('crosshair')` directly, so `crosshair` local var in `main.js` becomes unused — but confirm after writing gamestate.js

---

### Sub-Task 5 — recap.js: replace Game.recap.active with Game.state checks
**Status:** [x] done

**Intent:** Remove the module-local `active` flag; all "is recap showing?" queries
now use `Game.state === 'recap'`. The dismiss flow deliberately does NOT call
`setGameState` — the transition to `'playing'` is deferred until the browser
actually confirms the pointer lock via the consolidated listener in `main.js`.

**Expected Outcomes:**
- `Game.recap.active` field gone from `Game.recap` object
- `triggerRecap()` guards on and sets via `Game.state`
- `dismissRecap()` guards on `Game.state !== 'recap'`; no `active` assignment; still hides overlay and requests lock
- `checkRecapAutoTrigger()` uses `Game.state !== 'recap'`
- File-level doc block updated: "Why does `Game.state === 'recap'` pause gameplay?"

**Todo List:**
1. Remove `active: false` from `Game.recap` object; update inline comment on `autoShown`
2. Update `triggerRecap()` guard and state-set line
3. Update `dismissRecap()` guard; remove `active = false` line; update comment explaining deferred transition
4. Update `checkRecapAutoTrigger()` condition
5. Update file-level doc block

**Relevant Context:**
- `recap.js` lines 30-35: `Game.recap` object
- `recap.js` line 126: `if (Game.recap.active) return;`
- `recap.js` line 128: `Game.recap.active = true;`
- `recap.js` line 142: comment about `!Game.recap.active` guard — needs updating
- `recap.js` line 174: `dismissRecap()` guard
- `recap.js` line 176: `Game.recap.active = false;`
- `recap.js` line 219: `!Game.recap.active`

---

### Sub-Task 6 — index.html: insert gamestate.js script tag
**Status:** [x] done

**Intent:** Ensure `gamestate.js` loads in the correct position: after `audio.js`
(so `pauseAudio`/`resumeAudio` are defined), before `main.js` (so `setGameState`
is defined when `main.js` runs).

**Expected Outcomes:**
- `<script src="js/gamestate.js"></script>` appears between `audio.js` and `main.js`
- Comment explains the ordering constraint

**Todo List:**
1. Insert `<script src="js/gamestate.js"></script>` with a brief comment between `audio.js` and `main.js` in `index.html`

**Relevant Context:**
- `index.html` lines 65-68: current `audio.js` + `main.js` script tags
