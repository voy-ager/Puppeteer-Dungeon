/**
 * hiding.js — Player hiding spots
 *
 * Provides two fixed alcove hiding spots where the player can crouch and
 * become completely undetectable. Entering a hiding spot during an active
 * hunt ends the hunt immediately via endHunt() — the player successfully
 * evaded by hiding rather than outrunning the enemy.
 *
 * Design rationale:
 * Without hiding, the only response to a hunt is to outrun the enemy, which
 * degenerates into a test of corridor geometry knowledge. Hiding spots give
 * the player a spatial, deliberate option: find the alcove before the timer
 * runs out. This makes the dungeon's layout meaningful for defence, not just
 * exploration.
 *
 * Why freeze movement while hidden?
 * A "hiding spot" that still lets the player walk around is not a hiding
 * mechanic — it's just an invisibility toggle. Freezing camera and movement
 * (updateControls is bypassed in main.js) makes the hiding feel physical and
 * the risk/reward real: you are committed to the spot until you press E again.
 *
 * Why does the Director return immediately while hidden?
 * The player is meant to be completely safe inside a hiding spot. Letting the
 * Director make escalation or capture decisions while the player is hidden
 * would be an invisible penalty on a mechanic whose whole promise is safety.
 * The Director returning early is a hard guarantee, not a soft signal.
 *
 * Depends on:
 *   - endHunt() (defined in director.js, loaded before this file)
 *   - displaySubtitle() (defined in narrativeUI.js, loaded after this file
 *     but available at runtime since all functions are defined before any
 *     update loop runs)
 *   - Game.enemy, Game.scene, Game.camera (available at runtime)
 */

// ---------------------------------------------------------------------------
// Game.hiding — module state
// ---------------------------------------------------------------------------

Game.hiding = {
  active: false, // true while the player is crouched in a hiding spot
  spots:  [],    // array of { position: THREE.Vector3, radius: number }
};

// ---------------------------------------------------------------------------
// Hint display — last-shown guard
// ---------------------------------------------------------------------------

// Tracks what text is currently showing as a hiding hint so displaySubtitle()
// is only called when the message changes. Calling it every frame would
// restart the 5-second fade timer on every single frame, keeping the subtitle
// permanently visible and preventing any other subtitle from showing.
let _lastHidingHint = null;

// ---------------------------------------------------------------------------
// initHiding — called once at boot from main.js
// ---------------------------------------------------------------------------

function initHiding() {
  // --- Spot definitions ---
  // Spot 1: room_2 (X[-4,4], Z[-19,-11]), west wall, z=-16.
  //   Enemy patrol waypoints cover x∈[-3,3], z∈[-18.5,-15].
  //   x=-2, z=-16 is clear of all waypoints (nearest is (-3,-15), ~1.4m away).
  //
  // Spot 2: room_3 (X[-4,4], Z[-31,-23]), west wall, z=-28.
  //   NPC is at (2,0,-26). x=-2, z=-28 is ~4.5m from the NPC — outside
  //   the NPC's 4m proximity trigger, so the NPC won't fire immediately
  //   when the player enters the hiding spot.

  const spotDefs = [
    { x: -2, z: -16 }, // room_2 west alcove
    { x: -2, z: -28 }, // room_3 west alcove
  ];

  const RADIUS = 1.5; // metres — comfortable but not enormous

  // Dark box marker: same colour/roughness as the existing crate in game.js
  // (0x3a2f22, roughness 0.8) so it reads as dungeon furniture, not a UI hint.
  // Slightly narrower than the crate (0.6 vs 1.0) and taller (1.6) to suggest
  // a nook or alcove rather than a standalone box.
  const markerMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a2f22,
    roughness: 0.8,
  });

  for (const def of spotDefs) {
    const pos = new THREE.Vector3(def.x, 0, def.z);

    // Visual marker: centred at (x, 0.8, z) so bottom sits on the floor.
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 1.6, 0.6),
      markerMaterial
    );
    marker.position.set(def.x, 0.8, def.z);
    marker.castShadow    = true;
    marker.receiveShadow = true;
    Game.scene.add(marker);

    Game.hiding.spots.push({ position: pos, radius: RADIUS });
  }
}

// ---------------------------------------------------------------------------
// updateHiding — called every frame inside the Game.state === 'playing' gate
// ---------------------------------------------------------------------------

/**
 * Each frame: check proximity to hiding spots and update the hint subtitle.
 * Only calls displaySubtitle() when the message changes — the _lastHidingHint
 * guard prevents restarting the 5-second fade timer on every frame.
 */
function updateHiding(delta) {
  const pos = Game.camera.position;
  let nearSpot = false;

  for (const spot of Game.hiding.spots) {
    const dist = Math.hypot(pos.x - spot.position.x, pos.z - spot.position.z);
    if (dist < spot.radius) {
      nearSpot = true;
      break;
    }
  }

  if (Game.hiding.active) {
    // Currently hiding: show the "press E to leave" hint once.
    const msg = 'Hidden \u2014 press E to leave';
    if (_lastHidingHint !== msg) {
      _lastHidingHint = msg;
      displaySubtitle(msg);
    }
  } else if (nearSpot) {
    // Near a spot but not hiding: show the "press E to hide" hint once.
    const msg = 'Press E to hide';
    if (_lastHidingHint !== msg) {
      _lastHidingHint = msg;
      displaySubtitle(msg);
    }
  } else {
    // Not near any spot and not hiding: clear the last hint so it re-shows
    // if the player approaches again after the subtitle has faded.
    _lastHidingHint = null;
  }
}

// ---------------------------------------------------------------------------
// toggleHiding — called from the 'KeyE' handler in main.js
// ---------------------------------------------------------------------------

/**
 * Enter or exit a hiding spot.
 *
 * Entering: requires proximity to at least one spot. If a hunt is active when
 * the player enters, endHunt() fires immediately — the player successfully
 * evaded by hiding. endHunt() handles resetting the enemy, cooldown, and the
 * 'relief' narrative line, so none of that needs repeating here.
 *
 * Exiting: clears the active flag. Movement (updateControls) and Director
 * decisions both resume on the next frame automatically since they gate on
 * Game.hiding.active.
 */
function toggleHiding() {
  const pos = Game.camera.position;

  if (Game.hiding.active) {
    // Exit hiding — always allowed regardless of proximity.
    Game.hiding.active = false;
    // Clear the hint so it re-shows if the player re-enters the radius.
    _lastHidingHint = null;
    return;
  }

  // Attempt to enter: only succeeds if within radius of a spot.
  for (const spot of Game.hiding.spots) {
    const dist = Math.hypot(pos.x - spot.position.x, pos.z - spot.position.z);
    if (dist < spot.radius) {
      Game.hiding.active = true;

      // If a hunt is in progress, the player successfully evaded by hiding.
      // endHunt() handles all consequences: enemy back to patrol, cooldown set,
      // 'relief' narrative line shown, heartbeat stopped. Don't duplicate any
      // of that here — just call endHunt() and let it own those side effects.
      if (Game.enemy && Game.enemy.state === 'hunt') {
        endHunt();
      }

      return; // found a valid spot — stop checking
    }
  }
  // Not near any spot — toggle is a silent no-op.
}
