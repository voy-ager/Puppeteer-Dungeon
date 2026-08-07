# Enemy Visual Rework — Implementation Plan

## Top-Level Overview

Replace the two-mesh placeholder (cylinder + sphere) in `js/enemy.js` with a
humanoid rig built from Group hierarchies and primitive geometries, and add a
`updateWalkAnimation(delta)` function that runs procedural, deliberately
"wrong" limb animation every frame. No other files change. The movement logic
(`patrolWaypoints`, `huntTowardPlayer`) and the `Game.enemy` object shape are
untouched.

Comment style mirrors `js/director.js` and `js/enemy.js`: block-level `/**`
explains *why* each unsettling design choice was made; inline comments explain
non-obvious arithmetic.

---

## Rig Hierarchy

```
enemy.mesh  (THREE.Group — the root; position/rotation.y owned by patrol/hunt logic)
  └─ body          (THREE.Group — body.position.y = 0.9 on the root)
       ├─ torsoMesh     (BoxGeometry 0.5 × 0.9 × 0.3, y-offset +0.45 so it sits above hip line)
       ├─ headGroup     (THREE.Group — pivot at top of torso, y = +0.9)
       │    └─ headMesh (SphereGeometry r=0.22, y-offset +0.22 above group pivot)
       │       [permanent rotation.z = 0.15 set once in init, never animated]
       ├─ leftShoulderGroup   (THREE.Group — pivot at shoulder, y = +0.8, x = -0.35)
       │    └─ leftArmMesh    (CylinderGeometry, y-offset −0.5 so it hangs from pivot)
       ├─ rightShoulderGroup  (THREE.Group — pivot at shoulder, y = +0.8, x = +0.35)
       │    └─ rightArmMesh   (CylinderGeometry, y-offset −0.5)
       ├─ leftHipGroup        (THREE.Group — pivot at hip,      y = 0,    x = -0.15)
       │    └─ leftLegMesh    (CylinderGeometry, y-offset −0.45 so it hangs from pivot)
       └─ rightHipGroup       (THREE.Group — pivot at hip,      y = 0,    x = +0.15)
            └─ rightLegMesh   (CylinderGeometry, y-offset −0.45)
```

**Ground-level accounting:** `body.position.y = 0.9` (equal to `LEG_LENGTH`) is
set when body is added to the root group. This means:
- Hip Groups sit at world y = 0 + 0.9 = **0.9**
- Leg mesh centres at world y = 0.9 − 0.45 = **0.45**
- Feet (bottom of legs) at world y = 0.9 − 0.9 = **0.0** ← lands on the floor plane

The root group's `position.y` stays at 0, matching the existing waypoints and
the convention the current placeholder already follows.

---

## Geometry & Material Dimensions

| Part         | Geometry                          | Local y-offset inside parent group |
|--------------|-----------------------------------|-------------------------------------|
| Torso        | BoxGeometry(0.5, 0.9, 0.3)        | y = +0.45 (sits above hip line)     |
| Head         | SphereGeometry(0.22, 10, 8)       | y = +0.22 (centre above neck pivot) |
| Arm (each)   | CylinderGeometry(0.06, 0.06, 1.0) | y = −0.5  (hangs from shoulder)     |
| Leg (each)   | CylinderGeometry(0.09, 0.09, 0.9) | y = −0.45 (hangs from hip)          |

Arms are deliberately 1.0 long vs. the 0.9-tall torso — slightly too long to
be correct, the "one wrong detail" in the silhouette.

All meshes share the **single material instance** already created at the top
of `initEnemy()`: `{ color: 0x0a0a0c, roughness: 0.95 }` — no duplicate.

---

## Animation State

Two new fields are added to `Game.enemy` at declaration time (alongside the
existing `mesh`, `speed`, etc.):

```js
walkPhase: 0,      // accumulator, advances each frame; drives all limb cycles
limbRefs: null,    // { leftHip, rightHip, leftShoulder, rightShoulder, body, headGroup }
                   // populated in initEnemy() after rig is built, so updateWalkAnimation
                   // can reach limb Groups without traversing the scene graph each frame
```

---

## Sub-Tasks

---

### Sub-Task 1 — Rewrite `initEnemy()`: rig construction

**Intent**
Replace the two-mesh placeholder with the full Group hierarchy described above.
The root Group (`enemy.mesh`) keeps the same interface the rest of the code
expects — `position`, `rotation.y`, `castShadow` propagation via child meshes.
All limb Group references are stored in `enemy.limbRefs` so the animation
function can reach them in O(1) without scene-graph traversal.

**Expected Outcomes**
- `initEnemy()` produces a standing humanoid silhouette ~2.2 m tall.
- Head has a permanent `rotation.z = 0.15` (applied once, never overwritten
  by animation).
- Arms are visibly longer than feels "correct" relative to the torso.
- `Game.enemy.limbRefs` is populated with named references to every animated
  Group before `initEnemy()` returns.
- Waypoints, initial position, and `Game.scene.add(group)` remain identical
  to the current code — nothing in `main.js` or elsewhere needs to change.

**Todo List**
1. Add `walkPhase: 0` and `limbRefs: null` to the `Game.enemy` object literal.
2. In `initEnemy()`, create the single `material` instance (unchanged).
3. Build the `body` Group and `torsoMesh`; add torsoMesh to body.
4. Build `headGroup` at shoulder-top y, add `headMesh` with `rotation.z = 0.15`
   permanent tilt; add headGroup to body.
5. Build `leftShoulderGroup` + `leftArmMesh` (y-offset −0.5); add to body.
6. Build `rightShoulderGroup` + `rightArmMesh` (y-offset −0.5); add to body.
7. Build `leftHipGroup` + `leftLegMesh` (y-offset −0.45); add to body.
8. Build `rightHipGroup` + `rightLegMesh` (y-offset −0.45); add to body.
9. Create root `group`, add `body` to it.
10. Set `Game.enemy.mesh = group`.
11. Assign `Game.enemy.limbRefs = { leftHip, rightHip, leftShoulder, rightShoulder, body, headGroup }`.
12. Waypoints and `group.position` copy unchanged from current code.

**Relevant Context**
- [`js/enemy.js`](js/enemy.js:24) — current `initEnemy()` (lines 24–51)
- [`js/game.js`](js/game.js:29) — `Game` object definition; `Game.scene` is
  where the root group gets added
- [`js/main.js`](js/main.js:11) — `initEnemy()` is called once at boot;
  no signature change needed

**Status** `[ ] pending`

---

### Sub-Task 2 — Add `updateWalkAnimation(delta)`

**Intent**
Procedurally animate the rig every frame based on `Game.enemy.walkPhase`.
Three distinct behaviours, selected by current movement speed:

**A — Moving (patrol or hunt)**
- Advance `walkPhase` by `delta × phaseSpeed`, where `phaseSpeed` is faster
  during hunt than patrol (scaled by `huntSpeedMultiplier`).
- Left leg: `rotation.x = sin(walkPhase) × LEFT_AMP`
- Right leg: `rotation.x = sin(walkPhase + π) × RIGHT_AMP` (opposite phase)
- `LEFT_AMP ≠ RIGHT_AMP` — e.g. `0.55` vs `0.38` — so one leg swings less
  than the other, producing a limp. The comment explains this is intentional
  and *which* leg is the "weak" one.
- Left arm: `rotation.x = sin(walkPhase) × ARM_AMP`  ← same phase as LEFT leg
- Right arm: `rotation.x = sin(walkPhase + π) × ARM_AMP` ← same phase as RIGHT leg
  (not the human counter-swing — arms and same-side leg move together, which
  is subtly wrong and unsettling on close inspection)
- Torso and headGroup idle sway: blended toward 0 while moving
  (so the idle tremor doesn't fight the walk cycle).

**B — Still (velocity near zero)**
- Do not advance `walkPhase`.
- Apply a low-frequency idle sway to `body.rotation` and `headGroup.rotation`
  using two sine waves of incommensurate periods (e.g. `sin(t × 0.7)` and
  `sin(t × 1.1)`, neither of which is a multiple of the other) combined
  additively. Use `Game.elapsedTime` as the time source `t` — it advances
  every frame regardless of enemy state, so it works correctly here even
  though `walkPhase` is frozen while idle. This creates a tremor that
  never perfectly repeats, so it never looks like a looping idle animation.
- Blend limb rotations gently toward 0 (lerp, not snap) so the transition
  from walk to idle is smooth.

**Velocity detection**: compare `enemy.mesh.position` this frame to last frame,
stored as `enemy.lastPosition` (a new `THREE.Vector3` field). Speed ≈ 0 when
`stepDistance / delta < IDLE_SPEED_THRESHOLD`.

**Expected Outcomes**
- Legs swing opposite each other with uneven amplitude (visible limp).
- Arms swing with the same-side leg (wrong counter-swing).
- Head has a permanent off-tilt that is never zeroed by animation.
- At rest: a low-frequency, never-perfectly-repeating body tremor.
- Smooth transitions between walk and idle.
- No change to `patrolWaypoints()` or `huntTowardPlayer()`.

**Todo List**
1. Add `lastPosition: null` to `Game.enemy` (set to `enemy.mesh.position.clone()`
   at the end of `initEnemy()`).
2. Write `updateWalkAnimation(delta)` as a standalone function in `enemy.js`.
3. Define animation constants at the top of the function (or as module-level
   named constants): `LEFT_LEG_AMP`, `RIGHT_LEG_AMP`, `ARM_AMP`,
   `IDLE_SPEED_THRESHOLD`, `IDLE_SWAY_AMP`. Note: no `WALK_PHASE_SPEED_PATROL`
   or `WALK_PHASE_SPEED_HUNT` constants needed — phase speed is derived from
   actual `stepDistance / delta` each frame, not a hardcoded value.
4. Implement velocity detection using `lastPosition`.
5. Implement the moving branch (phase advance + limb sine waves).
6. Implement the still branch (two-sine idle sway on body and head).
7. Add lerp-based blend for limb rotations on the transition.
8. At the end of `updateWalkAnimation`, copy current position to `lastPosition`.
9. Add `updateWalkAnimation(delta)` call at the bottom of `updateEnemy(delta)`,
   after the existing patrol/hunt branch.
10. Add block-level `/**` comment above the function explaining the design
    choices: why the limp (left leg is the weaker/smaller-amplitude side —
    arbitrary but intentional, commented as such), why the wrong arm-swing,
    why two incommensurate sines for idle, and why `Game.elapsedTime` is used
    as the idle time source instead of a separate accumulator.

**Relevant Context**
- [`js/enemy.js`](js/enemy.js:53) — `updateEnemy(delta)` (lines 53–62); the
  call to `updateWalkAnimation` goes after the `if/else` block on line 61
- [`js/director.js`](js/director.js:19) — `enemy.speed` and
  `enemy.huntSpeedMultiplier` values to use for phase speed scaling
- [`js/telemetry.js`](js/telemetry.js:52) — `idleSpeedThreshold` (0.3 m/s)
  as a reference point for choosing `IDLE_SPEED_THRESHOLD`

**Status** `[ ] pending`
