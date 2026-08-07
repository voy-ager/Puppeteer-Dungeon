# Task A — Audio Fixes + Task B — Ally NPC

## Scope

Two independent tasks touching different files with no shared state:

- **Task A**: five targeted edits to `js/audio.js` and `js/director.js`
- **Task B**: new file `js/npc.js` + two lines in `js/main.js` + one script
  tag in `index.html`

---

# TASK A — Audio Fixes

## Overview

Five changes: two numeric constant bumps, one oscillator added to the drone,
one new distance-driven drone update during hunts (with its own faster timer),
and a `setDroneIntensity` ramp-duration parameter so the ramp always matches
the call interval.

The key design constraint is **ramp duration = call interval**. The existing
patrol path already satisfies this (2s ramp, 2s throttle). The new hunt path
requires the same discipline at 0.4s — the call and ramp must be matched or
overlapping ramps cause parameter-automation glitching.

---

## A — Sub-Task 1: Constant changes in `audio.js`

**Changes**
1. `masterGain` initial value: `0.15` → `0.28` (line 75)
2. `setDroneIntensity` gain formula: `0.1 + clamped * 0.6` → `0.25 + clamped * 0.70`
   (maps 0→0.25, 1→0.95)
3. `setDroneIntensity` filter formula: unchanged (120–320 Hz range stays)
4. Comment on masterGain updated to reflect new value
5. Comment on gain range updated to reflect new values

**Files touched**: `js/audio.js` only

**Status** `[ ] pending`

---

## A — Sub-Task 2: Fourth drone oscillator in `startAmbientDrone()`

**Change**
Add `{ type: 'sine', freq: 56.5 }` to the `specs` array between the 55 Hz
and 58 Hz entries. Update the `droneOscillators` comment in `Game.audio` from
"array of 3" to "array of 4". Update the node-graph comment in
`startAmbientDrone()`'s `/**` block to show four inputs. Add one sentence
explaining why 56.5 Hz specifically: it sits between the existing 55 and 58 Hz
tones, producing two new beating pairs (1.5 Hz and 1.5 Hz) that interleave
with the original 3 Hz beat, making the modulation pattern less regular and
more unsettling.

**Files touched**: `js/audio.js` only

**Status** `[ ] pending`

---

## A — Sub-Task 3: Ramp-duration parameter in `setDroneIntensity()`

**Change**
Add an optional second parameter `rampDuration = 2.0` to `setDroneIntensity`.
Replace the hardcoded `now + 2.0` with `now + rampDuration`. Update the
`@param` JSDoc and the inline comment explaining the ramp to note that callers
must pass a ramp duration that matches their call interval to avoid
overlapping-ramp glitching.

The patrol/relief call site in `director.js` already passes no second argument
(uses default 2.0 — no change needed there). The new hunt call site (Sub-Task 4)
will pass 0.4 explicitly.

**Files touched**: `js/audio.js` only

**Status** `[ ] pending`

---

## A — Sub-Task 4: Hunt-state drone update in `director.js`

**Change**
Inside the `if (enemy.state === 'hunt')` block in `updateDirector`, after the
existing `updateHeartbeatTempo(t.enemyDistance)` call, add:

- A new field `huntDroneLastUpdate: 0` in `Game.director` — a timestamp
  tracking when the hunt-drone update last fired.
- A throttle check: only call `setDroneIntensity` if
  `Game.elapsedTime - d.huntDroneLastUpdate >= 0.4`. When it fires, update
  `d.huntDroneLastUpdate = Game.elapsedTime`.
- The intensity calculation mirrors `updateHeartbeatTempo`'s distance mapping:
  `dist >= 10m` → 0.25, `dist <= 1.5m` → 0.95, linear between. `null` distance
  → 0.25 (same safe default as heartbeat tempo).
- Call `setDroneIntensity(huntDroneIntensity, 0.4)` — passing the 0.4s ramp
  duration to match the 0.4s call interval.

Comment: explain that the hunt-state drone update uses a separate 0.4s timer
rather than the outer `decisionInterval` (2s) because enemy distance changes
meaningfully faster during a chase. Also explain the ramp/interval parity
requirement explicitly.

**Files touched**: `js/director.js` only

**Status** `[ ] pending`

---

# TASK B — Ally NPC (`js/npc.js`)

## Overview

A new stationary humanoid figure in room_3, built with the same Group-hierarchy
rig pattern as `enemy.js`. Distinct visually (lighter material) and
behaviourally (correct idle sway, sympathetic read). Speaks via the existing
`showNarrativeLine()` on proximity, with a 20-second cooldown.

room_3 is centred at world `(0, -27)`, 8×8 m. NPC placed at `(2, 0, -26)` —
off the centreline so it doesn't obstruct the corridor, clearly inside room
bounds (X: [-4, 4], Z: [-31, -23]).

---

## B — Sub-Task 5: `js/npc.js` — rig construction (`initNPC`)

**Intent**
The NPC rig reuses the exact same geometry constants and Group-pivot pattern
as `enemy.js`, but with its own local constants prefixed `NPC_` to avoid
name collisions. The material is lighter (`0x4a4238`, dull fabric brown,
roughness 0.85) to visually distinguish it from the near-black enemy and the
dark geometry everywhere else. No "wrong" proportions: arm length matches
torso height (0.9), no permanent head tilt, no limp.

**`Game.npc` object**
```js
Game.npc = {
  mesh: null,
  limbRefs: null,       // { body, headGroup } — only body+head sway in idle
  lastSpokenTime: -999, // Game.elapsedTime value when NPC last triggered a line;
                        // starts at -999 so the first proximity triggers immediately
};
```

**Geometry** (intentionally "correct" proportions, unlike enemy):
| Part | Value | Rationale |
|---|---|---|
| Torso | 0.5 × 0.9 × 0.3 | Same as enemy — humanoid baseline |
| Head | r = 0.22 | Same as enemy |
| Arms | r=0.06, len=0.9 | Matches torso height — correct proportion |
| Legs | r=0.09, len=0.9 | Same as enemy |
| Material | 0x4a4238, roughness 0.85 | Lighter, slightly warmer — reads as clothing |

`body.position.y = LEG_LEN` (same ground-level fix as enemy).
No permanent head tilt. `castShadow = true` on all meshes.

**Todo List**
1. Declare `NPC_`-prefixed geometry constants (torso, head, arm, leg, shoulder/hip offsets).
2. Declare `Game.npc` object.
3. Write `initNPC()` — builds the full rig (same structure as `initEnemy()` minus
   the wrong proportions and head tilt), sets `Game.npc.mesh`, `Game.npc.limbRefs`,
   positions the root group at `(2, 0, -26)`, adds to `Game.scene`.
4. Add file-level `/**` block explaining that correct proportions and counter-swing
   are intentional design — trustworthy reads as human, so it must *move* human.

**Files touched**: `js/npc.js` (new)

**Status** `[ ] pending`

---

## B — Sub-Task 6: `js/npc.js` — idle animation (`updateNPC`)

**Intent**
Normal counter-swing idle sway (body Z-axis, head slightly out of phase) using
`Game.elapsedTime` as the time source — same two-sine technique as enemy idle
but without the deliberate wrongness. Arms do NOT sway (stationary ally,
standing still — arm animation would look unnatural without a walk cycle). The
sway amplitude is slightly smaller than the enemy's (`IDLE_SWAY_AMP = 0.02`
vs enemy's 0.03) — subtler, calmer.

**Proximity check**
Inside `updateNPC(delta)`, after the sway update:
- Compute `npcDistance` from `Game.camera.position` to `Game.npc.mesh.position`
  using `Math.hypot`.
- If `npcDistance < 4.0` AND `Game.elapsedTime - Game.npc.lastSpokenTime > 20`:
  - Determine `beatType`: if
    `Game.telemetry.idleStreak > Game.director.idleStreakThreshold || isBacktracking()`
    → `'tension'`, otherwise `'ambient'`.
  - Call `showNarrativeLine(beatType)`.
  - Set `Game.npc.lastSpokenTime = Game.elapsedTime`.

**Important**: `updateNPC` must guard on `Game.npc.mesh` being non-null before
doing anything, same pattern as `updateEnemy`.

**Todo List**
1. Define `NPC_IDLE_SWAY_AMP = 0.02` constant.
2. Write `updateNPC(delta)` — null-guard, compute idle sway on body + headGroup
   using `Game.elapsedTime`, then proximity + cooldown check triggering
   `showNarrativeLine`.
3. Comment the counter-swing choice (sympathetic read requires correct human motion),
   the 20s cooldown (long enough that the NPC doesn't spam, short enough that it
   speaks at meaningful moments), the 4m trigger radius (close enough to feel
   intentional, wide enough that the player doesn't have to hug the figure).

**Files touched**: `js/npc.js` (new)

**Status** `[ ] pending`

---

## B — Sub-Task 7: Wire into `main.js` and `index.html`

**`main.js`**: add `initNPC()` to the boot sequence (alongside `initEnemy()` etc.),
and add `updateNPC(delta)` to the `animate()` loop (alongside `updateEnemy(delta)`).

**`index.html`**: add `<script src="js/npc.js"></script>` after `enemy.js` and
before `director.js` (npc.js reads `Game.telemetry` and calls `showNarrativeLine`,
both of which are defined earlier; it doesn't depend on director.js being loaded
first, but `director.js` doesn't depend on npc.js either — ordering after `enemy.js`
and before `director.js` is cleanest).

**Todo List**
1. Add `initNPC()` call in `main.js` boot sequence after `initEnemy()`.
2. Add `updateNPC(delta)` call in `animate()` after `updateEnemy(delta)`.
3. Add `<script src="js/npc.js"></script>` in `index.html`.

**Files touched**: `js/main.js`, `index.html`

**Status** `[ ] pending`
