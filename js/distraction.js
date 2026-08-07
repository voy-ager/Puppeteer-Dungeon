/**
 * distraction.js — Throwable distraction mechanic
 *
 * Gives the player an active tool to redirect the enemy's attention.
 * Q throws a small projectile in the camera's forward direction; when it
 * lands it plays a knock sound and causes the enemy to investigate the
 * landing point using the same `checkingSpot` mechanism already built
 * for hiding-spot re-checks in enemy.js — no new enemy logic needed.
 *
 * Design notes:
 *
 *   Escape tool vs. redirect tool:
 *   If the enemy is hunting, the throw calls endHunt() first (stopping
 *   the chase), then sets checkingSpot to the landing position. The enemy
 *   pivots from hunting the player to investigating the noise. This gives
 *   the player a reliable escape option distinct from hiding, at the cost
 *   of a 5-second cooldown.
 *
 *   Why no 35% probability roll?
 *   The existing patrol-time hiding-spot re-check is a passive, ambient
 *   mechanic that adds tension over time — randomness is correct there.
 *   A thrown distraction is a deliberate player action; making it
 *   probabilistic would feel broken and unfair. It works every time.
 *
 *   Why 6m fixed throw distance?
 *   Long enough to reach across a corridor and into the next room, short
 *   enough that the player must think about aim rather than throwing from
 *   safety. No physics simulation: a simple parabola approximation over
 *   0.4 seconds is visually sufficient and keeps the code minimal.
 *
 * Depends on:
 *   - endHunt() (director.js)
 *   - playDistantKnock() (audio.js)
 *   - Game.enemy, Game.scene, Game.camera (available at runtime)
 */

// ---------------------------------------------------------------------------
// Game.distraction — module state
// ---------------------------------------------------------------------------

Game.distraction = {
  lastThrowTime:   -999, // initialised to -999 so the first throw is always
                         // immediately available rather than waiting 5 seconds
  cooldownSeconds: 5,
  projectiles:     [],   // array of in-flight { mesh, startPos, endPos,
                         //                       startTime, duration, landed }
};

// ---------------------------------------------------------------------------
// initDistraction — called once at boot from main.js
// ---------------------------------------------------------------------------

function initDistraction() {
  // No scene setup needed — projectile meshes are created on demand in
  // throwDistraction(). This function exists for structural consistency with
  // the other init* functions called in main.js's boot sequence.
}

// ---------------------------------------------------------------------------
// throwDistraction — called from the 'KeyQ' handler in main.js
// ---------------------------------------------------------------------------

/**
 * Throws a distraction projectile in the camera's forward direction.
 * Guards on state and cooldown; all side effects are deferred to
 * updateDistraction() once the projectile's animation completes.
 */
function throwDistraction() {
  // State guard: only usable while actively playing — not from the title
  // screen, pause overlay, or ending screens.
  if (Game.state !== 'playing') return;

  // Cooldown guard: enforced with elapsedTime so it pauses correctly when
  // the game is paused (elapsedTime only advances while state === 'playing').
  if (Game.elapsedTime - Game.distraction.lastThrowTime < Game.distraction.cooldownSeconds) return;

  Game.distraction.lastThrowTime = Game.elapsedTime;

  // --- Compute landing position ---
  // Forward direction derived from camera yaw only (ignoring pitch) so the
  // throw always lands on the floor plane regardless of where the player
  // is looking vertically. controls.js uses the same yaw-only convention.
  const yaw = Game.controls.yaw;
  const fwdX = -Math.sin(yaw);
  const fwdZ = -Math.cos(yaw);

  const THROW_DISTANCE = 6; // metres — fixed, no physics
  const startPos = Game.camera.position.clone(); // launches from camera eye level
  const endPos = new THREE.Vector3(
    startPos.x + fwdX * THROW_DISTANCE,
    0, // force to floor plane at landing
    startPos.z + fwdZ * THROW_DISTANCE
  );

  // --- Create visual projectile ---
  // Tiny dark sphere matching the prop style of the dungeon (same roughness/
  // colour family as the crate and hiding-spot markers). Small enough to read
  // as "small thrown object" without dominating the view during the throw.
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 6, 5),
    new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.9 })
  );
  mesh.position.copy(startPos);
  mesh.castShadow = true;
  Game.scene.add(mesh);

  Game.distraction.projectiles.push({
    mesh,
    startPos: startPos.clone(),
    endPos:   endPos.clone(),
    startTime: Game.elapsedTime,
    duration:  0.4, // seconds — snappy enough to feel responsive, slow enough
                    // to be visible and trackable mid-throw
    landed:   false,
  });

  console.log(`[Distraction] thrown to (${endPos.x.toFixed(1)}, 0, ${endPos.z.toFixed(1)})`);
}

// ---------------------------------------------------------------------------
// updateDistraction — called every frame from main.js animate() loop
// ---------------------------------------------------------------------------

/**
 * Advances each in-flight projectile's arc animation and triggers landing
 * logic when the animation completes.
 *
 * Animation:
 *   progress t = elapsed / duration, clamped to [0, 1].
 *   XZ: straight lerp from startPos to endPos.
 *   Y:  lerp from startPos.y (camera height ~1.6) down to 0 (floor), plus a
 *       parabolic arc overlay: 4 * peakY * t * (1-t). The parabola evaluates
 *       to 0 at both t=0 and t=1 and peaks at t=0.5 — a clean arc up, then
 *       back down to the floor, without any physics simulation.
 *
 * Landing (t >= 1):
 *   - playDistantKnock() for the impact sound (reusing the existing ambient
 *     audio function — no new audio work needed)
 *   - Enemy response depends on current state (see inline comments)
 *   - Mesh removed from scene
 *
 * @param {number} delta — frame delta time in seconds (passed from animate())
 */
function updateDistraction(delta) {
  const PEAK_Y = 0.5; // metres of arc height at the midpoint of the throw

  for (let i = Game.distraction.projectiles.length - 1; i >= 0; i--) {
    const p = Game.distraction.projectiles[i];
    if (p.landed) continue; // shouldn't happen, but safe guard

    const elapsed  = Game.elapsedTime - p.startTime;
    const t        = Math.min(elapsed / p.duration, 1);

    // XZ: straight lerp
    p.mesh.position.x = p.startPos.x + (p.endPos.x - p.startPos.x) * t;
    p.mesh.position.z = p.startPos.z + (p.endPos.z - p.startPos.z) * t;

    // Y: lerp from launch height to 0, plus parabolic arc overlay
    const baseY = p.startPos.y + (0 - p.startPos.y) * t; // lerp to floor
    const arcY  = 4 * PEAK_Y * t * (1 - t);              // parabola, peaks at t=0.5
    p.mesh.position.y = baseY + arcY;

    if (t >= 1) {
      // --- Landing ---
      p.landed = true;

      // Impact sound: reuse playDistantKnock() as the landing "clink".
      // It's already used for ambient environmental knocks, so it fits
      // the dungeon's audio palette without any new sound work.
      playDistantKnock();

      // Enemy response — two branches, same checkingSpot mechanism:
      if (Game.enemy && Game.enemy.state === 'hunt') {
        // Escape tool: end the active hunt (stops heartbeat, sets cooldown,
        // shows 'relief' narrative line — endHunt() owns all of that), then
        // immediately redirect the enemy to investigate the landing point.
        // Setting checkingSpot after endHunt() works because patrolWaypoints()
        // checks `if (enemy.checkingSpot)` first on every frame, before the
        // normal waypoint loop — so the enemy detours to the landing point
        // rather than snapping back to its patrol route.
        endHunt();
        Game.enemy.checkingSpot = { position: p.endPos.clone() };
        console.log('[Distraction] hunt interrupted — enemy redirected to landing point');
      } else if (Game.enemy) {
        // Redirect during patrol: no probabilistic roll — a deliberate player
        // action is reliable by design. The 35% roll in enemy.js's patrol
        // update is for passive hiding-spot ambient re-checks only.
        Game.enemy.checkingSpot = { position: p.endPos.clone() };
        console.log('[Distraction] enemy redirected to landing point (patrol)');
      }

      // Remove mesh from scene and splice out of the array.
      // Iterating in reverse (i--) means splicing at i is safe — it doesn't
      // shift any unprocessed entries since we only look at lower indices next.
      Game.scene.remove(p.mesh);
      Game.distraction.projectiles.splice(i, 1);
    }
  }
}
