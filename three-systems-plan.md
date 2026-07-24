# Three Systems Plan: Audio Redesign / Hiding / NPC Key

## Geometry Reference (derived from game.js)

```
room_2:        cx=0, cz=-15, 8×8m → X[-4,4]  Z[-19,-11]
room_3:        cx=0, cz=-27, 8×8m → X[-4,4]  Z[-31,-23]
final_chamber: cx=0, cz=-39, 9×9m → X[-4.5,4.5]  Z[-43.5,-34.5]

final_chamber south wall: z = -34.5  (cz + halfZ = -39 + 4.5)
Door gap: x ∈ [-1.5, 1.5] at z = -34.5  (width=3, center=0)
Locked door collider: { minX:-1.5, maxX:1.5, minZ:-34.65, maxZ:-34.35 }
  (WALL_THICKNESS = 0.3 → ±0.15 either side of z=-34.5)

Enemy waypoints (room_2 only):
  (0,-15), (3,-15), (3,-18.5), (-3,-18.5), (-3,-15)
  → all x∈[-3,3], z∈[-18.5,-15]

NPC position: (2, 0, -26) — room_3

Corridor between room_2 and room_3: z ∈ [-23,-19], width 3 → X[-1.5,1.5]
```

---

## TASK A — Audio Redesign (js/audio.js only)

### Overview

Full rewrite of `startAmbientDrone()`, `setDroneIntensity()`, and the `Game.audio`
state object. The node graph simplifies: 4 oscillators → 2, the dry/wet split and
WaveShaperNode are removed, the dissonant layer is removed. A new sparse ambient
event scheduler (`startAmbientEvents()` / `scheduleAmbientEvent()`) fires
intermittent environmental sounds using fresh nodes per play (same pattern as
`playStinger()`). `initAudio()` gets one new line at the end calling
`startAmbientEvents()`.

### Part A1 — Game.audio state object changes

**BEFORE** (lines 39-67):
```
droneOscillators: [] // comment says indices 0-3; [3] is the 62 Hz triangle
dryGain: null
distortion: null
wetGain: null
dissonantOsc: null
dissonantFilter: null
dissonantGain: null
```

**AFTER**: Remove `dryGain`, `distortion`, `wetGain`, `dissonantOsc`, `dissonantFilter`,
`dissonantGain`. Update `droneOscillators` comment to say indices 0-1; [1] is the
62 Hz triangle. Add:
```
ambientEventsActive: false
ambientEventTimeout: null
```

### Part A2 — startAmbientDrone() rewrite (lines 156-251)

Remove the entire doc block and function body. Replace with a 2-oscillator version:

**New node graph:**
```
osc[0] sine     55.0 Hz ──┐
osc[1] triangle 62.0 Hz ──┴──► droneGain ──► droneFilter ──► masterGain
```

- `droneGain.gain.value = 0.08` (new quiet floor)
- `droneFilter`: lowpass, frequency 120 Hz, Q 0.8
- Connect `droneFilter` directly to `masterGain` (no dry/wet split)
- `specs` array: only `{ type: 'sine', freq: 55.0 }` and `{ type: 'triangle', freq: 62.0 }`
- **62 Hz triangle is now index 1** (not 3) — call this out in a comment
- Remove `dissonantOsc.start()` line
- Remove all dry/wet/dissonant construction code

Also delete `makeSoftClipCurve()` entirely (lines 263-272) — no longer referenced.

### Part A3 — setDroneIntensity() rewrite (lines 291-336)

Remove dissonant gain ramp block (lines 315-320) and wet gain ramp block (lines 322-331).
Update gain range comment and values:
- **BEFORE**: `0.25 + clamped * 0.70` (range 0.25–0.95)
- **AFTER**: `0.08 + clamped * 0.27` (range 0.08–0.35)

Update pitch-bend line: `a.droneOscillators[3]` → `a.droneOscillators[1]` (62 Hz triangle
moved from index 3 to index 1 after removing the two middle oscillators).

### Part A4 — New: three one-shot ambient sounds + scheduler

Add after `playStinger()` (after line 558), before `pauseAudio()`:

**`playCreak()`** — oscillator sweep 300→150 Hz (sawtooth), bandpass ~250Hz Q≈3,
150-400ms duration. Randomize base ±15% per play. StereoPannerNode (random ±0.7).

**`playDistantKnock()`** — single sine ~45Hz, fast attack (5ms) / exponential decay
(~80ms total). StereoPannerNode (random ±0.7).

**`playFaintScrape()`** — reuse `Game.audio.noiseBuffer` through narrow bandpass
600-900Hz, 200ms attack / 800ms decay (1000ms total). StereoPannerNode (random ±0.7).
Guard on `!a.noiseBuffer` (same pattern as `playStinger()`).

**`scheduleAmbientEvent()`** (internal, not exported) — picks random interval
15000-40000ms. If `Game.enemy.state === 'hunt'`, skips playing this cycle but still
reschedules. Otherwise picks one of three sounds randomly and plays it.
Stores setTimeout result in `Game.audio.ambientEventTimeout`.

**`startAmbientEvents()`** — sets `ambientEventsActive = true`, calls
`scheduleAmbientEvent()` immediately.

**`stopAmbientEvents()`** — clears `ambientEventTimeout`, sets `ambientEventsActive = false`.

### Part A5 — initAudio() addition (line 113)

Add one line after `startAmbientDrone()`:
```js
startAmbientEvents();
```

### Part A6 — File-level doc block update (lines 1-33)

Update the layer list: remove dissonant layer, dry/wet layer descriptions. Add a new
"Sparse environmental sounds" layer description.

### Sub-tasks for A

| # | Change | Lines affected |
|---|---|---|
| A1 | Rewrite `Game.audio` state object | 39-67 |
| A2 | Rewrite `startAmbientDrone()` and delete `makeSoftClipCurve()` | 156-272 |
| A3 | Rewrite `setDroneIntensity()` | 291-336 |
| A4 | Add `playCreak`, `playDistantKnock`, `playFaintScrape`, `scheduleAmbientEvent`, `startAmbientEvents`, `stopAmbientEvents` | after line 558 |
| A5 | Add `startAmbientEvents()` call in `initAudio()` | line 113 |
| A6 | Update file-level doc block | 1-33 |

---

## TASK B — Hiding Mechanic (new js/hiding.js + touches main.js, director.js, index.html)

### Overview

New file `js/hiding.js`. Two fixed hiding spots with visual markers. `toggleHiding()`
is the only public API called from main.js. `updateHiding()` runs inside the
`Game.state === 'playing'` gate. Director is fully suppressed while hiding.

### Hiding spot coordinates

Both spots are positioned against the west wall of their respective rooms (x = -2),
away from the centre corridor axis and clear of enemy patrol waypoints.

**Spot 1 — room_2**: `(-2, 0, -16)`
- room_2 bounds: X[-4,4], Z[-19,-11]. Centre z = -15.
- Patrol waypoints reach x=-3 at z=-18.5 and z=-15. This spot is at x=-2, z=-16 —
  inside the room, close to the west wall, NOT on any waypoint.
- Distance from nearest patrol point ((-3,-15)): √(1² + 1²) ≈ 1.4m — clearly separate.

**Spot 2 — room_3**: `(-2, 0, -28)`
- room_3 bounds: X[-4,4], Z[-31,-23]. Centre z = -27. NPC at (2,0,-26).
- x=-2, z=-28 is on the west side, south of centre, well away from the NPC's (2,-26).
- Distance from NPC: √(4² + 2²) ≈ 4.5m — outside NPC proximity trigger (4m). Good.

**Visual marker**: a small dark box (0.6×1.6×0.6, y-centred at 0.8) using the same
dark material as the existing crate (`0x3a2f22`, roughness 0.8) so it reads as dungeon
furniture not a UI element. Slightly narrower than the crate (0.6 vs 1.0) to look like
a nook or alcove marker.

### Hint message guard pattern

A module-level variable `let _lastHidingHint = null` tracks what was last shown. Only
call `displaySubtitle()` when the message would change. Do NOT call `showNarrativeLine()`
— call `displaySubtitle()` directly (same as hiding.js spec says: reuse the existing
function from narrativeUI.js). Text:
- Near a spot, not hiding: `"Press E to hide"`
- Currently hiding: `"Hidden — press E to leave"`
- Not near any spot, not hiding: no call (let subtitle expire naturally)

### Sub-tasks for B

**B1 — js/hiding.js** (new file):
- `Game.hiding = { active: false, spots: [] }`
- `initHiding()`: create spot objects, marker meshes, add to scene
- `updateHiding(delta)`: proximity detection + hint display (with last-hint guard)
- `toggleHiding()`: enter/exit logic; if entering during hunt → `endHunt()`

**B2 — js/director.js**: Add `if (Game.hiding.active) return;` as the FIRST line of
`updateDirector()` (line 71, inside the function body, immediately after the opening
brace and before the existing `if (!Game.director.enabled) return;` check — or directly
after it; place it AFTER the enabled check since disabled+hiding is already a no-op,
so order doesn't matter, but hiding check second reads more clearly: "bail out if
disabled OR if player is hidden").

**B3 — js/main.js** animate():
- Wrap `updateControls(delta)` (line 129): `if (!Game.hiding.active) updateControls(delta);`
- Add `updateHiding(delta)` inside the `Game.state === 'playing'` block
- Add `'KeyE'` handler in the existing keydown listener: `if (e.code === 'KeyE') toggleHiding();`

**B4 — index.html**: Insert `<script src="js/hiding.js"></script>` between
`director.js` (line 58) and `narrativeUI.js` (line 59).

---

## TASK C — NPC Key + Locked Door (touches npc.js, game.js, telemetry.js, index.html)

### Overview

`Game.hasKey = false` is the single new global flag. The NPC grants the key on first
proximity. `game.js` adds a locked-door collider at `buildDungeon()` time and stores
it as `Game.lockedDoorCollider`. The unlock check (remove collider when hasKey is true)
runs in `telemetry.js` per-frame with a null-guard so it only runs once. A proximity
hint near the locked door reuses the `_lastDoorHint` guard pattern.

### Exact locked door collider

The final_chamber south wall is the x-axis wall at `z = -34.5`.
`buildWallRun('x', -34.5, -4.5, 4.5, { width: 3, center: 0 })` leaves segments:
  - west stub: x ∈ [-4.5, -1.5]  (added by `addWallSegment`)
  - east stub: x ∈ [1.5, 4.5]    (added by `addWallSegment`)
  - gap: x ∈ [-1.5, 1.5] — this is the doorway

The locked door collider fills exactly this gap:
```js
Game.lockedDoorCollider = {
  minX: -1.5,
  maxX:  1.5,
  minZ: -34.5 - WALL_THICKNESS / 2,  // = -34.65
  maxZ: -34.5 + WALL_THICKNESS / 2,  // = -34.35
};
Game.colliders.push(Game.lockedDoorCollider);
```

No mesh is added for the locked door — the collider alone blocks movement. When
unlocked, the collider is spliced out of `Game.colliders` and `Game.lockedDoorCollider`
is set to `null`.

### Proximity hint for locked door

Check in `updateTelemetry()` (at the end, or as a separate check in main.js):
- Player within 2m of the door centre (0, 0, -34.5) AND `Game.hasKey === false`
- Show `"The way is sealed. Something else in this place may help."`
- Guard with `_lastDoorHint` pattern (module-level variable in telemetry.js or a new
  thin function) — only call `displaySubtitle()` when the state changes

Since `telemetry.js` already does per-frame position math and proximity is a
per-frame check, add the door-hint and unlock logic there. `displaySubtitle` is
callable from telemetry.js because it's defined in `narrativeUI.js` which loads
before `telemetry.js` runs... wait — check script order: `narrativeUI.js` loads after
`telemetry.js`. The function is defined at load time so it's available at runtime.
The call happens inside `updateTelemetry()` which only runs inside the game loop
after all scripts have loaded. **This is safe** — function definitions are hoisted by
the time any update runs.

### NPC key grant

In `updateNPC()`, the existing proximity trigger block (lines 235-251) fires when
`npcDistance < 4.0`. Add an additional one-time guard: the FIRST time the player
enters that radius (`Game.hasKey === false`), set `Game.hasKey = true` and call
`displaySubtitle("You found a key.")`. This fires before (or in the same frame as)
the existing `showNarrativeLine()` call. Guard: `if (!Game.hasKey)` — once set true,
this branch never runs again. The existing 20-second cooldown and subtitle guard
below it are unchanged.

### Sub-tasks for C

**C1 — js/game.js `buildDungeon()`**: After `buildRoomShell(... 'final_chamber')` and
before the crate code:
```js
Game.hasKey = false;
Game.lockedDoorCollider = {
  minX: -1.5, maxX: 1.5,
  minZ: -34.5 - WALL_THICKNESS / 2,
  maxZ: -34.5 + WALL_THICKNESS / 2,
};
Game.colliders.push(Game.lockedDoorCollider);
```
(No separate mesh — invisible blocker.)

**C2 — js/npc.js `updateNPC()`**: Inside the existing proximity block (line 235),
add a key-grant branch before the existing `showNarrativeLine()` call:
```js
if (!Game.hasKey) {
  Game.hasKey = true;
  displaySubtitle('You found a key.');
}
```
The existing `showNarrativeLine(beatType)` call and `npc.lastSpokenTime` assignment
follow unchanged. The `if (!Game.hasKey)` guard means the key is granted exactly
once — the NPC still speaks on every eligible proximity trigger after that.

**C3 — js/telemetry.js `updateTelemetry()`**: At the end of the function, add two
checks:

1. **Unlock check** — runs every frame but is a no-op once door is removed:
```js
if (Game.hasKey && Game.lockedDoorCollider) {
  const idx = Game.colliders.indexOf(Game.lockedDoorCollider);
  if (idx !== -1) Game.colliders.splice(idx, 1);
  Game.lockedDoorCollider = null;
}
```

2. **Door hint check** — proximity to door centre (0, 0, -34.5), radius 2m, only
when `!Game.hasKey`, with a last-hint guard:
```js
// module-level: let _doorHintShown = false;
const doorDist = Math.hypot(pos.x - 0, pos.z - (-34.5));
if (!Game.hasKey && doorDist < 2 && !_doorHintShown) {
  _doorHintShown = true;
  displaySubtitle('The way is sealed. Something else in this place may help.');
}
// Reset if player walks away, so hint re-shows if they return:
if (doorDist >= 2) _doorHintShown = false;
```

---

## index.html Script Order Summary (after all three tasks)

```
game.js
controls.js
enemy.js
npc.js
telemetry.js
director.js
hiding.js        ← NEW (Task B) — after director.js, before narrativeUI.js
narrativeUI.js
recap.js
audio.js
gamestate.js
main.js
```

---

## Sub-Task Status

### Task A
- [ ] A1: Rewrite Game.audio state object (audio.js lines 39-67)
- [ ] A2: Rewrite startAmbientDrone(), delete makeSoftClipCurve() (audio.js lines 156-272)
- [ ] A3: Rewrite setDroneIntensity() (audio.js lines 291-336)
- [ ] A4: Add playCreak, playDistantKnock, playFaintScrape, scheduleAmbientEvent, startAmbientEvents, stopAmbientEvents (audio.js after line 558)
- [ ] A5: Add startAmbientEvents() call in initAudio() (audio.js line ~113)
- [ ] A6: Update file-level doc block (audio.js lines 1-33)

### Task B
- [ ] B1: Create js/hiding.js
- [ ] B2: Add hiding guard to director.js updateDirector()
- [ ] B3: Wrap updateControls, add updateHiding, add KeyE in main.js
- [ ] B4: Add hiding.js script tag in index.html

### Task C
- [ ] C1: Add Game.hasKey, Game.lockedDoorCollider to game.js buildDungeon()
- [ ] C2: Add key-grant branch in npc.js updateNPC()
- [ ] C3: Add unlock check + door hint in telemetry.js updateTelemetry()
