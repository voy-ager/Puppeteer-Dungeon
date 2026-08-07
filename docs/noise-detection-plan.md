# Noise-Based Detection — Implementation Plan

## Top-Level Overview

Three targeted additions across three existing files, each self-contained:

1. **`controls.js`** — add a `sneaking` boolean to `Game.controls`, toggled by
   Shift keys, and compute an effective speed cap per frame that halves movement
   speed while sneaking without permanently mutating `Game.controls.speed`.

2. **`telemetry.js`** — add `noiseLevel` to `Game.telemetry`, updated each frame
   from the existing `speed` calculation with a Shift-awareness modifier and
   exponential decay toward zero when still.

3. **`director.js`** — add a noise-triggered hunt pathway that runs every frame
   (unthrottled) before the existing comfort-based check, gated only by `state ===
   'patrol'` and the existing `huntCooldownUntil` relief window.

No new files. No movement logic, walk animation, or Narrative Engine changes.
Comment style throughout matches the existing files — explain *why* each decision
was made, not just what the code does.

---

## Sub-Tasks

---

### Sub-Task 1 — `controls.js`: sneak modifier

**Intent**
Give the player a held-Shift sneak mode that halves their effective movement
speed. The base `Game.controls.speed` value (4.5 m/s) must not be permanently
changed — it is the tuned "normal" speed the whole codebase assumes. Sneaking
is an in-frame modifier, computed fresh each frame so releasing Shift instantly
restores full speed with no lag or state to unwind.

**Expected Outcomes**
- `Game.controls.sneaking: false` added to the `Game.controls` object.
- `setMoveState` extended to set `sneaking = true/false` on `ShiftLeft` /
  `ShiftRight` key down/up (alongside the existing WASD cases).
- In `updateControls(delta)`, the horizontal speed cap used in the
  `if (horizontalSpeed > ...)` clamp is derived as:
  ```
  const effectiveSpeed = Game.controls.sneaking
    ? Game.controls.speed * 0.5
    : Game.controls.speed;
  ```
  and the existing `Game.controls.speed` reference in that clamp is replaced
  with `effectiveSpeed`. No other lines change.
- The file-level comment block is updated to note the sneak addition.

**Todo List**
1. Add `sneaking: false` to the `Game.controls` object literal.
2. In `setMoveState`, add `case 'ShiftLeft': case 'ShiftRight':` that sets
   `Game.controls.sneaking = isDown`. Add an inline comment explaining that
   Shift is the "trade speed for quiet" mechanic — the player's main lever
   for avoiding the noise-triggered hunt.
3. In `updateControls`, introduce `effectiveSpeed` before the speed-clamp
   block and replace the single `Game.controls.speed` reference in that
   clamp with `effectiveSpeed`. Add an inline comment explaining why the
   base speed is not mutated (so no state cleanup is needed on key-up, and
   the value remains the authoritative normal-movement cap for everything
   else that reads it).
4. Update the file-level `/**` block to mention the sneak mechanic.

**Relevant Context**
- [`js/controls.js:11`](js/controls.js:11) — `Game.controls` object; add
  `sneaking` here
- [`js/controls.js:48`](js/controls.js:48) — `setMoveState`; add the Shift
  cases at the end of the switch
- [`js/controls.js:107`](js/controls.js:107) — speed-clamp block; this is
  the only place `Game.controls.speed` is used as a cap, so it is the only
  line that needs to reference `effectiveSpeed` instead

**Status** `[ ] pending`

---

### Sub-Task 2 — `telemetry.js`: `noiseLevel` signal

**Intent**
Expose a single `noiseLevel` number (0–1 range, where 1 is "running loudly")
that the Director can compare against a threshold without needing to know
anything about controls or speed. Telemetry already computes `speed` from
`stepDistance/delta` each frame — `noiseLevel` is derived from that same
value, so no extra position math is needed.

The two design rules:
- **Sneaking suppresses noise** regardless of how fast the player moves.
  A player who holds Shift is making a deliberate gameplay choice to be quiet;
  the noise system must honour that even though their physical movement speed
  is only halved (not zeroed). This is the game-feel contract: Shift is the
  "be safe" button, but it costs speed.
- **Decay, not snap.** Noise should linger for a moment after the player
  stops — a brief pause doesn't immediately silence them. This mirrors how
  real sound works and makes the mechanic feel physical rather than binary.

**Expected Outcomes**
- `noiseLevel: 0` added to `Game.telemetry`.
- In `updateTelemetry(delta)`, after the existing `speed` calculation, a new
  block computes `noiseLevel` each frame:
  - **Target** value: if sneaking, `targetNoise = 0`; otherwise
    `targetNoise = Math.min(speed / NOISE_SPEED_SCALE, 1)` where
    `NOISE_SPEED_SCALE` is a local constant (e.g. `5.0`) that maps the player's
    typical run speed (≈4.5 m/s) to roughly `noiseLevel ≈ 0.9` at full sprint.
  - **Rise rate**: when `targetNoise > noiseLevel`, lerp quickly toward target
    (rise factor ≈ `8 * delta` — noise builds fast when you start running).
  - **Decay rate**: when `targetNoise < noiseLevel`, lerp slowly toward target
    (decay factor ≈ `1.5 * delta` — roughly 0.7s to halve, ~1.5s to near-zero).
  - `noiseLevel` is clamped to [0, 1] after the update.
- `renderDebugOverlay` gets a new line: `noise: ${t.noiseLevel.toFixed(2)}`
  between the existing `idle streak` and `enemy distance` lines, styled the
  same as the surrounding lines.

**Todo List**
1. Add `noiseLevel: 0` to `Game.telemetry` with an inline comment that this
   is a 0–1 signal consumed by director.js for the noise-triggered hunt.
2. Add `NOISE_SPEED_SCALE` as a named constant above `updateTelemetry` (not
   buried inline) so it is easy to tune.
3. Inside `updateTelemetry(delta)`, after the `speed` / `idleStreak` block,
   add the `targetNoise` computation and asymmetric lerp. Comment the
   asymmetry — fast rise, slow decay — and why sneaking sets target to 0
   rather than a reduced value (Shift is the explicit "be quiet" contract).
4. In `renderDebugOverlay`, add the `noise` line.
5. Update the file-level `/**` block to mention `noiseLevel`.

**Relevant Context**
- [`js/telemetry.js:52`](js/telemetry.js:52) — `speed` is already computed
  here from `stepDistance/delta`; add the `noiseLevel` block immediately after
  the `idleStreak` update that follows it (lines 53–58)
- [`js/telemetry.js:95`](js/telemetry.js:95) — `renderDebugOverlay` template
  literal; insert the new line after `idle streak` (line 98)
- `Game.controls.sneaking` — read here, not in controls.js, so telemetry owns
  the full noise signal rather than scattering the logic

**Status** `[ ] pending`

---

### Sub-Task 3 — `director.js`: noise-triggered hunt pathway

**Intent**
Add a second, independent route to `startHunt()` that reacts immediately to
noise, rather than waiting for the 2-second `decisionInterval` throttle the
comfort-based check uses. The two pathways — noise-triggered and comfort-based
— must be clearly separated in the code so that future tuning of one doesn't
accidentally affect the other. Both converge on the same `startHunt()` call;
the Director doesn't need to know or care which reason triggered it.

The new pathway is gated by the **existing** `huntCooldownUntil` relief window.
Noise must not be able to force a hunt during the guaranteed calm period after a
hunt ends — that window is the game's rhythm contract with the player, and
breaking it would make the mechanic feel unfair rather than skill-based.

The check intentionally runs **before** the existing `decisionInterval` guard
so that a noise event is never delayed by up to 2 seconds waiting for the next
throttle tick. Reaction speed is the whole point of the noise mechanic.

**Expected Outcomes**
- Two new constants added to `Game.director`:
  - `hearingRadius: 7` — farther than `safeEscalationDistance` (4m) because
    hearing should outrange the "too close to safely escalate" check.
  - `noiseTriggerThreshold: 0.6` — noise level above which the enemy reacts.
    At `0.6`, a player walking normally (≈ `noiseLevel ~0.7`) triggers it,
    but slow walk (≈ `0.4`) does not — sneaking (0) never does.
- In `updateDirector(delta)`, a new block inserted **after** the `if
  (enemy.state === 'hunt') { ... return; }` early-exit and **before** the
  `decisionInterval` throttle — so it only runs during patrol and runs every
  frame. The check:
  ```
  if (
    Game.elapsedTime >= d.huntCooldownUntil &&
    t.enemyDistance !== null &&
    t.enemyDistance < d.hearingRadius &&
    t.noiseLevel > d.noiseTriggerThreshold
  ) {
    d.lastEvent = 'noise trigger — player heard';
    startHunt();
    return;
  }
  ```
- A clearly labelled comment section heading separates this from the
  comfort-based check below: `// --- Comfort-based escalation ---` (matching
  the existing inline comment style).
- `Game.director` object updated with the two new constants and inline
  comments explaining the threshold choices.
- File-level `/**` block updated to mention the noise pathway addition.

**Todo List**
1. Add `hearingRadius` and `noiseTriggerThreshold` to `Game.director` with
   comments explaining why each value was chosen relative to existing
   constants.
2. In `updateDirector(delta)`, insert the unthrottled noise check block
   after the hunt early-exit, before the `decisionInterval` guard. Add a
   comment block above it explaining: (a) why it runs every frame, (b) why
   it still respects `huntCooldownUntil`, (c) that it is independent of the
   comfort check below.
3. Add the `// --- Comfort-based escalation ---` section heading before the
   existing `decisionInterval` guard to make the two-pathway structure
   visually clear.
4. Update `d.lastEvent` on noise trigger with a distinct string so the debug
   overlay shows which pathway fired.
5. Update the file-level `/**` block.

**Relevant Context**
- [`js/director.js:16`](js/director.js:16) — `Game.director` object; add the
  two new constants here
- [`js/director.js:33`](js/director.js:33) — `updateDirector(delta)`; the
  noise check goes after line 46 (the `return` that ends the hunt early-exit)
  and before line 48 (the `decisionInterval` guard)
- [`js/director.js:73`](js/director.js:73) — `startHunt()` is already defined
  and handles everything including `showNarrativeLine('hunt_taunt')` — reuse
  it unchanged

**Status** `[ ] pending`
