# Bugs, Difficulty Tuning & Enemy Spot-Check Plan

## Confirmed Design Decisions

### (a) Exact locked-door collider bounds
```
minX: -1.5,  maxX: 1.5
minZ: -34.5 - 0.75 = -35.25
maxZ: -34.5 + 0.75 = -33.75
```
Thickness 1.5m, centred on z=-34.5 (same doorway, wider slab).
Max single-frame movement = speed(4.5) * maxDelta(0.1) = 0.45m < 0.75m half-thickness.
Player radius 0.35m adds to effective clearance, making tunneling impossible.

### (b) Grace-period implementation
`Game.elapsedTime` starts at 0 and is incremented per frame. The simplest approach
is a direct inline comparison — no new field needed:
```js
if (Game.elapsedTime < 20) { /* skip escalation */ }
```
Added as the FIRST guard inside the noise pathway (after the hunt-active block) and
inside the comfort-based check (before playerSeemsComfortable is evaluated).
This avoids adding sessionStartTime noise to the state object.

### (c) triggerCapture() call site in enemy.js
Location: bottom of `patrolWaypoints()`, after the movement step toward `checkingSpot`.
Exact guard condition:
```js
if (
  enemy.checkingSpot &&
  distToSpot < 1.5 &&
  Game.hiding.active &&
  Game.hiding.lastSpotUsed === enemy.checkingSpot
) {
  triggerCapture();
}
```
This uses object reference equality (`===`) so only the specific spot the enemy
investigated — not any other spot — triggers capture. `triggerCapture()` is defined
in recap.js which loads before main.js; by the time `patrolWaypoints` ever runs the
function exists.

---

## Sub-Tasks

- [ ] Fix 1: game.js — thicken locked door collider to 1.5m
- [ ] Fix 2: recap.js — disable Director after escaped trigger
- [ ] Adj 1a: director.js — tune three threshold values
- [ ] Adj 1b: director.js — add 20s grace period to both escalation paths
- [ ] Adj 2: hiding.js — reposition room_2 spot + add lastSpotUsed field
- [ ] New: enemy.js — checkingSpot detour logic in Game.enemy + patrolWaypoints
