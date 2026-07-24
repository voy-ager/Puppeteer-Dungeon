# Procedural Audio System — Implementation Plan

## Top-Level Overview

A new `js/audio.js` file implements a fully procedural Web Audio API soundscape
with zero external files. It is wired into the existing codebase at exactly
four call sites — two in `director.js` (`startHunt`, `endHunt`) and two in
`main.js` (the overlay click handler for AudioContext init, and the
`updateDirector` per-frame path for relief-window drone shaping). The audio
system must never throw or break gameplay — every public function is wrapped in
a try/catch guard.

Comment style matches the rest of the project: block-level `/**` explains *why*
each audio design choice was made (frequency selection, envelope shape, node
topology), not just the Web Audio API mechanics.

---

## Web Audio Node Graphs

### Drone (continuous, Part 2)

```
osc1 (sine, ~55 Hz) ──┐
osc2 (sine, ~58 Hz) ──┼──► droneGain ──► droneFilter (lowpass) ──► masterGain ──► destination
osc3 (triangle,~62 Hz)┘
```

- Three oscillators run simultaneously, each a few Hz apart. The slight
  detuning produces gentle beating interference — an organic "breathing"
  quality that a single oscillator cannot. Sine/triangle chosen over sawtooth
  or square because higher harmonics would read as musical rather than
  subterranean.
- `droneGain` is the volume modulation target for `setDroneIntensity()`.
- `droneFilter` cutoff is also modulated: higher intensity → slightly higher
  cutoff (more presence), lower intensity → more muffled/buried.
- `masterGain` is a fixed low value (≈ 0.15) that caps total drone volume
  regardless of intensity so the drone never overwhelms speech/narration.

### Heartbeat (hunt only, Part 3)

No persistent oscillator — each beat is a freshly created, short-lived
`OscillatorNode` with a `GainNode` envelope, scheduled via the AudioContext
clock. This avoids the "held oscillator + volume gate" approach which causes
audible clicks at the gate transitions.

```
(per-beat, created+destroyed each thump)
OscillatorNode (sine, 60 Hz) ──► beatGain (fast envelope) ──► masterGain ──► destination
```

The beat gain envelope:
- `t=0`: gain 0
- `t+0.005s`: gain 0.7 (near-instant attack — thump starts hard)
- `t+0.15s`: gain 0 (exponential ramp down — natural decay)
- Node disconnected and discarded after decay completes

A `setTimeout` re-schedules the next beat after `heartbeatInterval` ms.
`heartbeatInterval` is recalculated from `enemyDistance` each time the beat
fires, so tempo changes happen smoothly on the next beat rather than mid-beat.

Distance-to-interval mapping:
- `enemyDistance >= 10m` (or null) → 1100ms
- `enemyDistance <= 1.5m` → 400ms
- Linear interpolation between those endpoints, clamped

### Hunt stinger (one-shot, Part 4)

Two parallel branches, both short-lived:

```
Branch A — pitch drop:
OscillatorNode (sine, 400→80 Hz over 250ms) ──► stingerGainA ──► masterGain ──► destination

Branch B — noise burst:
AudioBufferSourceNode (white noise buffer) ──► noiseFilter (bandpass ~200 Hz) ──► stingerGainB ──► masterGain ──► destination
```

- Branch A creates a visceral "drop" feeling — the pitch fall from 400 Hz to
  80 Hz in 250ms mimics a sudden loss of tension, like the floor dropping out.
  High frequencies cut through mix; low endpoint transitions into the drone.
- Branch B adds texture — pure tones alone sound thin and electronic. A short
  burst of bandpass-filtered noise bridges the stinger to the existing drone
  bed so the transition sounds like the room responding rather than a UI cue.
- Both branches fire simultaneously and self-terminate.
- The white noise buffer is generated once at init time (1-second buffer,
  filled with `Math.random() * 2 - 1`) and reused for every stinger — cheap,
  and short enough that the same buffer never sounds like a loop.

---

## `Game.audio` Object Shape

```js
Game.audio = {
  ctx: null,            // AudioContext, created on first user interaction
  masterGain: null,     // fixed low-volume output bus

  // Drone nodes — created once in startAmbientDrone(), persistent
  droneOscillators: [], // array of 3 OscillatorNode references
  droneGain: null,      // GainNode — volume modulated by setDroneIntensity()
  droneFilter: null,    // BiquadFilterNode — cutoff also modulated

  // Heartbeat state
  heartbeatActive: false,
  heartbeatTimeout: null,  // return value of setTimeout, for cancellation
  heartbeatInterval: 1100, // current ms between beats, updated per-beat

  // Stinger noise buffer — generated once, reused
  noiseBuffer: null,
};
```

---

## Public API

| Function | Called from | Effect |
|---|---|---|
| `initAudio()` | `main.js` overlay click handler | Creates AudioContext, masterGain, noise buffer; calls `startAmbientDrone()` |
| `startAmbientDrone()` | `initAudio()` | Creates and connects drone oscillators+filter+gain; starts oscillators |
| `setDroneIntensity(level)` | `updateDirector` per-frame (patrol/relief only) | Ramps `droneGain.gain` and `droneFilter.frequency` to target values |
| `startHeartbeat()` | `startHunt()` in director.js | Sets `heartbeatActive = true`, schedules first beat immediately |
| `stopHeartbeat()` | `endHunt()` in director.js | Sets `heartbeatActive = false`, clears pending timeout |
| `updateHeartbeatTempo(dist)` | `updateDirector` per-frame during hunt | Recalculates `heartbeatInterval` from distance; takes effect on next beat |
| `playStinger()` | `startHunt()` in director.js | Fires the one-shot pitch-drop + noise burst |

---

## Sub-Tasks

---

### Sub-Task 1 — `js/audio.js`: setup, `Game.audio`, and `initAudio()`

**Intent**
Establish the AudioContext lazily (only on first user click — browsers block
audio creation before a gesture), set up the master output bus, and generate
the reusable noise buffer. Every subsequent audio function depends on `ctx`
being set; the `if (!Game.audio.ctx) return` guard at the top of each function
is what makes the whole system fail-silent.

**Expected Outcomes**
- `Game.audio` object declared with all fields null/false/empty.
- `initAudio()` creates `AudioContext`, a `masterGain` node (fixed gain ≈ 0.15)
  connected to destination, and a 1-second white noise `AudioBuffer` stored in
  `Game.audio.noiseBuffer`.
- Calling `initAudio()` a second time is a no-op (guard on `ctx` already set).
- File-level `/**` block explains the lazy-init pattern and why zero external
  files are needed.

**Todo List**
1. Declare `Game.audio = { ctx, masterGain, droneOscillators, droneGain,
   droneFilter, heartbeatActive, heartbeatTimeout, heartbeatInterval,
   noiseBuffer }` with all fields initialised to null/false/defaults.
2. Write `initAudio()` with `try/catch` guard: create `AudioContext`, create
   and connect `masterGain` (gain 0.15) to `ctx.destination`, fill
   `noiseBuffer` with random samples via `ctx.createBuffer`.
3. Guard against double-init with `if (Game.audio.ctx) return` at top.
4. Call `startAmbientDrone()` at the end of `initAudio()`.
5. Add the file-level `/**` block.

**Relevant Context**
- `main.js:19` — overlay click handler; `initAudio()` call goes here
- `index.html:41` — audio.js `<script>` tag goes after `director.js` and
  before `main.js` (audio.js depends on `Game` existing; main.js calls
  `initAudio()`)

**Status** `[ ] pending`

---

### Sub-Task 2 — `js/audio.js`: `startAmbientDrone()` and `setDroneIntensity(level)`

**Intent**
Create the continuous three-oscillator drone that plays from game start to
finish. `setDroneIntensity()` is the only control surface — callers vary
intensity between states (calm patrol ≈ 0.3, relief ≈ 0.6, never called
during hunt because heartbeat takes over) and the drone bed subtly shifts
without restarting or clicking.

**Expected Outcomes**
- `startAmbientDrone()` creates 3 oscillators (sine/sine/triangle at 55, 58,
  62 Hz), a `GainNode` (starting gain ≈ 0.4 = mid intensity), and a
  `BiquadFilterNode` (lowpass, starting cutoff ≈ 180 Hz). Connects the chain
  and calls `oscillator.start()` on all three.
- `setDroneIntensity(level)` maps 0–1 to: gain range 0.1–0.7, filter cutoff
  range 120–320 Hz. Uses `linearRampToValueAtTime` over 2 seconds so changes
  are gradual, never stepped.
- Calling `startAmbientDrone()` twice is a no-op (guard on
  `droneOscillators.length`).

**Todo List**
1. Write `startAmbientDrone()` — create nodes, set initial values, connect
   graph, start oscillators. Comment the frequency choices (why 55/58/62 Hz,
   why triangle for the third).
2. Write `setDroneIntensity(level)` — clamp input to [0,1], compute target
   gain and filter cutoff, schedule ramps. Comment why `linearRampToValueAtTime`
   is used over an instant `.value =` assignment (avoids audible stepping).
3. Add `try/catch` to both functions.

**Relevant Context**
- Node graph diagram in the overview section above
- `updateDirector` in director.js — `setDroneIntensity` call goes in the
  patrol/relief portion only (described in Sub-Task 5)

**Status** `[ ] pending`

---

### Sub-Task 3 — `js/audio.js`: `startHeartbeat()`, `stopHeartbeat()`, `updateHeartbeatTempo()`

**Intent**
A per-beat scheduling pattern (create fresh nodes per thump, schedule via
AudioContext clock) avoids the click artifacts of gating a held oscillator and
naturally handles tempo changes on beat boundaries. The self-scheduling pattern
(`setTimeout` re-arms itself each beat) keeps the code simple while letting
`heartbeatInterval` update mid-hunt.

**Expected Outcomes**
- `startHeartbeat()` sets `heartbeatActive = true` and calls the internal
  `scheduleBeat()` function immediately.
- `scheduleBeat()` creates a fresh OscillatorNode (sine, 60 Hz) + GainNode,
  applies the fast-attack/150ms-decay envelope via `setValueAtTime` and
  `exponentialRampToValueAtTime`, starts and stops the oscillator on a tight
  window, then calls `setTimeout(scheduleBeat, heartbeatInterval)` to
  re-arm — but only if `heartbeatActive` is still true.
- `stopHeartbeat()` sets `heartbeatActive = false` and calls `clearTimeout`
  on the pending timeout reference so no orphaned beats fire after a hunt ends.
- `updateHeartbeatTempo(dist)` recalculates `heartbeatInterval` from distance:
  linear map from `[10, 1.5]` metres → `[1100, 400]` ms, clamped. Distance
  `null` → 1100ms (safest default). The new value is picked up automatically
  on the next `scheduleBeat` reschedule.

**Todo List**
1. Write `scheduleBeat()` as an internal (non-exported) function.
2. Write `startHeartbeat()`, `stopHeartbeat()`, `updateHeartbeatTempo(dist)`.
3. Comment the envelope shape rationale: near-instant attack so the thump
   lands hard rather than swelling in; exponential (not linear) decay so it
   tails off naturally, matching how acoustic thuds behave.
4. Comment why nodes are created fresh each beat rather than gated (avoiding
   click artifacts at the gate boundary — a persistent oscillator silenced
   by a sudden gain change to 0 produces a discontinuity in the waveform).
5. Add `try/catch` to all exported functions.

**Status** `[ ] pending`

---

### Sub-Task 4 — `js/audio.js`: `playStinger()`

**Intent**
A one-shot sound that marks the exact moment a hunt begins. Two parallel
branches — a pitch-dropping tone and a filtered noise burst — fire
simultaneously and self-terminate. The dual-branch design is intentional: a
pure tone alone sounds like a UI notification; the noise burst makes it feel
like the room reacting.

**Expected Outcomes**
- `playStinger()` creates the two branch graphs (described in the node graph
  overview), schedules all parameter ramps using the AudioContext clock (not
  `setTimeout`), and starts both nodes at `ctx.currentTime`.
- Pitch drop: frequency ramps from 400 Hz to 80 Hz over 0.25s via
  `exponentialRampToValueAtTime`; gain ramps from 0.5 to 0 over 0.3s.
- Noise burst: `AudioBufferSourceNode` using `Game.audio.noiseBuffer` (loop
  false, plays once), routed through a bandpass filter at 200 Hz (Q ≈ 2.0),
  then a gain that ramps from 0.3 to 0 over 0.25s.
- Both nodes scheduled to `.stop()` at `ctx.currentTime + 0.35s` to guarantee
  cleanup even if the ramp doesn't fully silence them.
- `try/catch` guard — a failed stinger is cosmetic, never gameplay-critical.

**Todo List**
1. Write `playStinger()` — branch A (oscillator pitch drop), branch B (noise
   burst through bandpass filter).
2. Comment the frequency choices for both branches.
3. Comment why AudioContext clock scheduling is used over `setTimeout` here
   (sub-millisecond precision vs. ~4ms minimum `setTimeout` resolution — for
   a one-shot transient the timing accuracy matters).
4. Add `try/catch`.

**Status** `[ ] pending`

---

### Sub-Task 5 — Integration: `director.js` and `main.js` call sites

**Intent**
Wire the audio functions into the four exact locations the spec names. Minimal
changes: four lines in `director.js`, two lines in `main.js`. The drone
intensity update during the relief window is the only logic that lives in
`updateDirector` — it reads the existing `huntCooldownUntil` timing to shape
the signal, no new state needed.

**Expected Outcomes**

`director.js` — `startHunt()`:
```js
playStinger();
startHeartbeat();
```

`director.js` — `endHunt()`:
```js
stopHeartbeat();
```

`director.js` — `updateDirector()`, inside the hunt branch (before `return`):
```js
updateHeartbeatTempo(t.enemyDistance);
```

`director.js` — `updateDirector()`, in the patrol/relief section (after the
hunt early-exit), drone intensity driven by relief cooldown progress:
```js
// Relief cooldown drains from huntCooldownUntil back toward now.
// Map remaining relief time → intensity: full relief = 0.6, fully calm = 0.25.
const reliefRemaining = Math.max(0, d.huntCooldownUntil - Game.elapsedTime);
const droneIntensity = 0.25 + (reliefRemaining / d.reliefDuration) * 0.35;
setDroneIntensity(droneIntensity);
```

`main.js` — overlay click handler:
```js
overlay.addEventListener('click', () => {
  initAudio();                              // ← new line, before requestPointerLock
  Game.renderer.domElement.requestPointerLock();
});
```

`index.html`:
```html
<script src="js/audio.js"></script>   <!-- after director.js, before main.js -->
```

**Todo List**
1. Add `playStinger()` and `startHeartbeat()` to `startHunt()` in director.js.
2. Add `stopHeartbeat()` to `endHunt()` in director.js.
3. Add `updateHeartbeatTempo(t.enemyDistance)` inside the hunt-active early
   return block in `updateDirector` (after the `caughtUp` check, before the
   `return`).
4. Add `setDroneIntensity(droneIntensity)` call in the patrol section of
   `updateDirector`, computing intensity from relief cooldown as shown above.
5. Add `initAudio()` call to overlay click handler in main.js.
6. Add `<script src="js/audio.js"></script>` in index.html after `director.js`
   and before `main.js`.
7. Comment each addition in the existing file style.

**Relevant Context**
- `js/director.js:112` — `startHunt()` body
- `js/director.js:120` — `endHunt()` body
- `js/director.js:56` — hunt-active early-return block; `updateHeartbeatTempo`
  goes before the `return` on line 63
- `js/director.js:86` — patrol section, after the comfort-escalation guard;
  `setDroneIntensity` call goes here, runs every throttled tick (2s) which is
  fine since the ramp is 2s — it just refreshes the target each tick
- `js/main.js:19` — overlay click handler

**Status** `[ ] pending`
