/**
 * enemy.js — FBX skeletal model, Mixamo animations
 *
 * Movement logic (patrolWaypoints, huntTowardPlayer, checkingSpot detour)
 * is completely unchanged from the procedural-rig version — director.js,
 * hiding.js, and distraction.js all interact only with Game.enemy.state,
 * Game.enemy.checkingSpot, and Game.enemy.mesh.position, none of which
 * change meaning with a skeletal model.
 *
 * What changed:
 *   - initEnemy() is now partially async: waypoints/speed/state are set
 *     synchronously as before; mesh construction is replaced with an
 *     FBXLoader call that resolves within a second but not instantly.
 *   - updateWalkAnimation() (procedural limb rotations) is replaced by
 *     updateEnemyAnimation() (AnimationMixer crossfades between four
 *     baked Mixamo clips: idle, walk, run, crawl).
 *   - patrolWaypoints() and huntTowardPlayer() now have `if (!enemy.mesh)`
 *     early guards to handle the brief window before the async load resolves.
 *     updateEnemy() already had this guard; the others now match.
 */

// ---------------------------------------------------------------------------
// Game.enemy — state object
// ---------------------------------------------------------------------------

Game.enemy = {
  mesh:  null,    // THREE.Group — null until FBX load resolves
  state: 'patrol',            // 'patrol' | 'hunt' — set by director.js
  speed: 1.4,                 // patrol speed, m/s
  huntSpeedMultiplier: 1.8,   // hunt speed = speed * this
  waypoints: [],
  currentWaypointIndex: 0,

  // --- Skeletal animation ---
  mixer:               null,  // THREE.AnimationMixer, created after idle.fbx loads
  animations:          {},    // { idle, walk, run, crawl } — AnimationAction refs
  currentAnimationName: null, // name of the currently-playing action (string)
  stillTime:           0,     // seconds of continuous near-zero movement this session;
                               // reset to 0 the moment the enemy moves, incremented each
                               // frame it doesn't. 'idle' is only selected after this
                               // exceeds 0.2s so single skipped frames at waypoint turns
                               // don't produce a false walk→idle→walk blip.

  // --- Hiding-spot / distraction investigation ---
  // checkingSpot is set either by the passive 35% patrol roll (enemy.js) or
  // by throwDistraction() (distraction.js). patrolWaypoints() handles both
  // identically — it only reads checkingSpot.position and doesn't care about
  // the object's origin.
  checkingSpot:    null,
  nextSpotCheckTime: 0,
};

// ---------------------------------------------------------------------------
// initEnemy — synchronous setup + async FBX load
// ---------------------------------------------------------------------------

/**
 * Sets up all non-visual enemy state synchronously (waypoints, speed, etc.),
 * then starts an async FBX load chain for the mesh and animations.
 *
 * Load order:
 *   1. idle.fbx  — provides the character mesh, skeleton, and idle clip.
 *                  All subsequent loaders reuse this same skeleton via the
 *                  shared AnimationMixer, which is why idle.fbx must come first.
 *   2. walking.fbx, running.fbx, crawling.fbx — loaded after the mixer
 *      exists. Only animations[0] is extracted from each; the duplicate
 *      mesh/skeleton data in these files is ignored.
 *
 * The game loop's `if (!enemy.mesh) return` guards in updateEnemy(),
 * patrolWaypoints(), and huntTowardPlayer() safely skip all movement and
 * animation logic during this brief window (typically < 1 second).
 */
function initEnemy() {
  // --- Synchronous state (unchanged from procedural version) ---
  Game.enemy.waypoints = [
    new THREE.Vector3(0,  0, -15),
    new THREE.Vector3(3,  0, -15),
    new THREE.Vector3(3,  0, -18.5),
    new THREE.Vector3(-3, 0, -18.5),
    new THREE.Vector3(-3, 0, -15),
  ];

  // --- Async FBX load chain ---
  // Wrapped in try/catch so that a missing or broken FBXLoader script
  // (404, wrong URL, CDN outage) does not throw an uncaught error here and
  // silently abort the rest of main.js's boot sequence — without this guard,
  // a crash in initEnemy() prevents the click-to-start handler and every
  // subsequent init call from ever running, leaving a completely black screen
  // with no visible explanation. This catch surfaces the problem clearly while
  // letting everything else initialise normally.
  let loader;
  try {
    loader = new THREE.FBXLoader();
  } catch (e) {
    console.error(
      '[Enemy] THREE.FBXLoader is not available — check that the FBXLoader ' +
      'script tag in index.html loaded successfully (open Network tab and ' +
      'confirm the unpkg URL returned 200, not 404). Enemy will not appear.',
      e
    );
    return; // abort initEnemy() cleanly; Game.enemy.mesh stays null,
            // and the `if (!enemy.mesh) return` guards in updateEnemy(),
            // patrolWaypoints(), and huntTowardPlayer() will safely no-op
            // every frame without further errors.
  }

  // Step 1: idle.fbx — mesh + skeleton + idle animation
  loader.load('assets/enemy/idle.fbx', (fbx) => {
    // --- Scale correction ---
    // Mixamo exports in centimetres; Three.js uses metres.
    // 0.01 maps a 170cm character to 1.7m in world space.
    // One-time bounding-box sanity check: logs actual height so we can
    // compare against our target ~2.24m (old procedural rig height) and
    // adjust the scalar if needed without relying on visual guesswork.
    // 0.013 maps the confirmed 2.048m model to ~2.66m — noticeably imposing
    // while staying well clear of the 4m corridor ceiling.
    // (0.01 → 2.048m confirmed via earlier Box3 log; 0.013 = 0.01 * 1.3 → ~2.66m)
    fbx.scale.setScalar(0.013);
    const bbox = new THREE.Box3().setFromObject(fbx);
    console.log(
      `[Enemy] idle.fbx loaded — bounding box height: ${(bbox.max.y - bbox.min.y).toFixed(3)}m` +
      ` (target ~2.66m; corridor ceiling is 4m)`
    );

    // --- Facing-direction note ---
    // Standard Mixamo FBX exports face +Z (chest toward positive Z).
    // Math.atan2(dx, dz) in patrolWaypoints/huntTowardPlayer produces 0
    // when dx=0 and dz>0 (moving toward +Z), so rotation.y=0 → facing +Z.
    // These match: no correction offset needed.
    // If the model appears to face BACKWARD during testing, uncomment:
    //   fbx.rotation.y = Math.PI;
    // and that one-time offset will persist through all per-frame rotations.

    // --- Shadow ---
    fbx.traverse((child) => {
      if (child.isMesh) {
        child.castShadow    = true;
        child.receiveShadow = true;
      }
    });

    // --- Position at first waypoint ---
    fbx.position.copy(Game.enemy.waypoints[0]);

    Game.enemy.mesh = fbx;
    Game.scene.add(fbx);

    // --- Mixer + idle action ---
    Game.enemy.mixer = new THREE.AnimationMixer(fbx);

    const idleClip   = fbx.animations[0];
    const idleAction = Game.enemy.mixer.clipAction(idleClip);
    Game.enemy.animations.idle = idleAction;

    // Start playing idle immediately so the character is never in a
    // frozen T-pose during the brief window before the first state update.
    idleAction.play();
    Game.enemy.currentAnimationName = 'idle';

    console.log('[Enemy] idle animation playing');

    // Step 2: load walk/run/crawl clips — extract animation[0] only,
    // bound to the SAME mixer (and therefore the same skeleton).
    // The FBX "with skin" format embeds a full skeleton + mesh in every
    // file, but AnimationMixer.clipAction() binds the clip to the root
    // object supplied at mixer construction time, so the duplicate
    // geometry from these extra files is simply discarded.
    _loadEnemyClip(loader, 'assets/enemy/walking.fbx', 'walk');
    _loadEnemyClip(loader, 'assets/enemy/running.fbx',  'run');
    _loadEnemyClip(loader, 'assets/enemy/crawling.fbx', 'crawl');
  },
  // Progress callback — optional, useful during development
  undefined,
  (err) => {
    console.error('[Enemy] Failed to load idle.fbx:', err);
  });
}

/**
 * _loadEnemyClip — loads an FBX file, strips root-motion position tracks,
 * and registers the first AnimationClip as a named action on Game.enemy.mixer.
 *
 * Root-motion stripping:
 * Mixamo FBX exports without "In Place" bake forward translation into the
 * skeleton's root/hip bone as a .position keyframe track (typically named
 * "mixamorigHips.position"). If left in, the AnimationMixer applies that
 * translation to the root object every frame, conflicting with our manual
 * position updates in patrolWaypoints() / huntTowardPlayer() and producing
 * the "walks forward, snaps back to clip-start, repeats" loop.
 *
 * The fix: filter clip.tracks to remove any track whose name ends with
 * ".position" AND whose target bone name contains "hip" or "root"
 * (case-insensitive). This removes locomotion translation while preserving
 * all rotation tracks on every bone — the leg/arm/torso joint animation is
 * entirely rotation-based and is completely unaffected.
 *
 * A diagnostic log prints the full track list before stripping so the exact
 * bone name can be confirmed in the browser console. The log is left in
 * intentionally; remove it once the fix is confirmed working.
 *
 * This is an internal helper, not part of the public API. It is only called
 * from inside the idle.fbx callback (after the mixer exists).
 *
 * @param {THREE.FBXLoader} loader  - shared loader instance
 * @param {string}          path    - path to the FBX file
 * @param {string}          name    - key to store under Game.enemy.animations
 */
function _loadEnemyClip(loader, path, name) {
  loader.load(path, (fbx) => {
    if (!fbx.animations || fbx.animations.length === 0) {
      console.warn(`[Enemy] ${path} contained no animations — "${name}" will be unavailable`);
      return;
    }
    const clip = fbx.animations[0];

    // --- Diagnostic: log all track names before stripping ---
    // Check the browser console to confirm the exact root/hip position track
    // name (expected: something like "mixamorigHips.position"). Once confirmed,
    // this log can be removed.
    console.log(
      `[Enemy] "${name}" tracks:`,
      clip.tracks.map(t => t.name)
    );

    // --- Root-motion strip ---
    // Remove any track that targets the root/hip bone's .position property.
    // The test is:
    //   1. track.name ends with ".position"  — this is a translation track
    //   2. the bone portion of the name (everything before the last dot)
    //      contains "hip" or "root" (case-insensitive) — this is the
    //      locomotion bone, not a finger or spine joint
    //
    // We deliberately do NOT strip ".position" tracks on other bones (hands,
    // head, spine) — those are used for IK targets and secondary motion and
    // must be preserved. Only the root locomotion bone is stripped.
    const before = clip.tracks.length;
    clip.tracks = clip.tracks.filter((track) => {
      if (!track.name.endsWith('.position')) return true; // keep all non-position tracks
      const boneName = track.name.slice(0, track.name.lastIndexOf('.')).toLowerCase();
      const isLocomotionBone = boneName.includes('hip') || boneName.includes('root');
      if (isLocomotionBone) {
        console.log(`[Enemy] "${name}" — stripped root-motion track: "${track.name}"`);
      }
      return !isLocomotionBone; // remove locomotion position tracks, keep everything else
    });
    console.log(`[Enemy] "${name}" — ${before} tracks → ${clip.tracks.length} after strip`);

    const action = Game.enemy.mixer.clipAction(clip);
    Game.enemy.animations[name] = action;
    console.log(`[Enemy] "${name}" animation ready`);
  },
  undefined,
  (err) => {
    console.error(`[Enemy] Failed to load ${path}:`, err);
  });
}

// ---------------------------------------------------------------------------
// updateEnemy — called every frame from main.js
// ---------------------------------------------------------------------------

function updateEnemy(delta) {
  const enemy = Game.enemy;
  // Async-load guard: mesh is null for up to ~1 second after initEnemy() runs.
  // All movement and animation code below requires mesh to exist.
  if (!enemy.mesh) return;

  if (enemy.state === 'hunt') {
    huntTowardPlayer(delta);
  } else {
    // --- Hiding-spot investigation roll ---
    // Only during patrol (never during hunt) and only when there is a known
    // last-used hiding spot. The roll fires at most once per 60–120s window.
    if (
      Game.hiding &&
      Game.hiding.lastSpotUsed !== null &&
      Game.elapsedTime > enemy.nextSpotCheckTime
    ) {
      // Advance the window regardless of outcome — keeps checks infrequent.
      enemy.nextSpotCheckTime = Game.elapsedTime + 60 + Math.random() * 60;

      if (Math.random() < 0.35) {
        enemy.checkingSpot = Game.hiding.lastSpotUsed;
        console.log('[Enemy] detour: investigating last hiding spot');
      }
    }

    patrolWaypoints(delta);
  }

  // Animation update: advance mixer and crossfade to the correct clip.
  updateEnemyAnimation(delta);
}

// ---------------------------------------------------------------------------
// patrolWaypoints — waypoint loop + checkingSpot detour (unchanged logic)
// ---------------------------------------------------------------------------

function patrolWaypoints(delta) {
  const enemy = Game.enemy;
  // Async-load guard — matches the guard in updateEnemy().
  if (!enemy.mesh) return;
  if (enemy.waypoints.length === 0) return;

  // --- Hiding-spot / distraction detour branch ---
  // When checkingSpot is set, the enemy temporarily ignores its waypoint list
  // and moves toward the target position. This works identically whether the
  // spot came from a passive hiding-spot roll (enemy.js) or a thrown
  // distraction (distraction.js) — both supply a { position: Vector3 } object.
  if (enemy.checkingSpot) {
    const spotPos = enemy.checkingSpot.position;
    const pos     = enemy.mesh.position;

    const dx   = spotPos.x - pos.x;
    const dz   = spotPos.z - pos.z;
    const dist = Math.hypot(dx, dz);

    if (dist > 0.01) {
      const step = Math.min(enemy.speed * delta, dist);
      pos.x += (dx / dist) * step;
      pos.z += (dz / dist) * step;
      enemy.mesh.rotation.y = Math.atan2(dx, dz);
    }

    if (dist < 0.5) {
      // Capture check — reference equality against the actual hiding spot.
      // A distraction-thrown target is a plain { position } literal, never
      // the same object reference as a Game.hiding.spots[] element, so this
      // condition is always false for distraction throws. No capture risk.
      if (
        Game.hiding &&
        Game.hiding.active &&
        Game.hiding.lastSpotUsed === enemy.checkingSpot
      ) {
        triggerCapture();
      }

      enemy.checkingSpot = null; // investigation over — resume normal patrol
    }

    return; // skip normal waypoint logic this frame
  }

  // --- Normal waypoint patrol ---
  const target = enemy.waypoints[enemy.currentWaypointIndex];
  const pos = enemy.mesh.position;

  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);

  if (dist < 0.15) {
    enemy.currentWaypointIndex = (enemy.currentWaypointIndex + 1) % enemy.waypoints.length;
    return;
  }

  const step = Math.min(enemy.speed * delta, dist);
  pos.x += (dx / dist) * step;
  pos.z += (dz / dist) * step;
  enemy.mesh.rotation.y = Math.atan2(dx, dz);
}

// ---------------------------------------------------------------------------
// huntTowardPlayer — direct pursuit (unchanged logic)
// ---------------------------------------------------------------------------

function huntTowardPlayer(delta) {
  const enemy = Game.enemy;
  // Async-load guard — matches the guard in updateEnemy().
  if (!enemy.mesh) return;

  const pos    = enemy.mesh.position;
  const target = Game.camera.position;

  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.05) return;

  const huntSpeed = enemy.speed * enemy.huntSpeedMultiplier;
  const step = Math.min(huntSpeed * delta, dist);
  pos.x += (dx / dist) * step;
  pos.z += (dz / dist) * step;
  enemy.mesh.rotation.y = Math.atan2(dx, dz);
}

// ---------------------------------------------------------------------------
// updateEnemyAnimation — AnimationMixer tick + state-driven crossfades
// ---------------------------------------------------------------------------

/**
 * Called every frame from updateEnemy(), after the movement step.
 *
 * Always ticks the mixer first (required for any animation to play).
 * Then selects the target animation name from game state and crossfades
 * to it if the currently-playing clip differs.
 *
 * Animation priority (checked in order):
 *   1. crawl — enemy.checkingSpot is set (investigating a hiding spot or
 *              distraction target). Visual posture signals "searching",
 *              distinct from both patrol and hunt. Checked first so the
 *              crawl overrides walk/idle during an investigation regardless
 *              of enemy.state.
 *   2. run   — enemy.state === 'hunt'
 *   3. walk  — enemy is patrolling and is currently moving toward a waypoint
 *              (dist >= 0.15 threshold, same value used in patrolWaypoints)
 *   4. idle  — fallback (standing at waypoint, or clip not yet loaded)
 *
 * Crossfade uses Three.js's standard fadeOut/reset/fadeIn pattern with a
 * 0.3-second blend window. Actions that haven't loaded yet are skipped
 * safely — if Game.enemy.animations[target] is undefined (the FBX load
 * for that clip hasn't resolved yet), we stay on the current action.
 */
function updateEnemyAnimation(delta) {
  const enemy = Game.enemy;
  // Guard on mesh and mixer only — not on animations.idle specifically,
  // so mixer.update() always runs once the mixer exists, regardless of
  // which clips have finished loading.
  if (!enemy.mesh || !enemy.mixer) return;

  // Always advance the mixer first. This must happen every frame whether
  // or not we crossfade — skipping it freezes the skeleton.
  enemy.mixer.update(delta);

  // --- Determine target animation name ---
  // Priority order: crawl (investigating) → run (hunt) → walk/idle (patrol).
  let target;

  if (enemy.checkingSpot) {
    // Investigating a hiding spot or distraction — crawl posture
    target = 'crawl';
  } else if (enemy.state === 'hunt') {
    target = 'run';
  } else {
    // Patrol: determine moving vs idle using a stillTime debounce.
    //
    // The naive approach — select 'idle' whenever dist-to-waypoint < 0.15m —
    // produces a false idle blip at every waypoint turn: patrolWaypoints()
    // increments currentWaypointIndex and returns without moving on the arrival
    // frame, so this code briefly reads the NEW waypoint as its target and may
    // also find dist < 0.15 for one frame, triggering a walk→idle crossfade
    // that immediately reverses to walk→walk the next frame. At 60fps a turn
    // frame is ~16ms — well under the 200ms debounce threshold below.
    //
    // stillTime accumulates while the enemy is near-stationary and resets
    // immediately on any movement. 'idle' is only selected after 200ms of
    // genuine stillness, filtering out single-frame arrival pauses entirely.
    const wp = enemy.waypoints[enemy.currentWaypointIndex];
    const isMoving = wp && (() => {
      const dx = wp.x - enemy.mesh.position.x;
      const dz = wp.z - enemy.mesh.position.z;
      return Math.hypot(dx, dz) >= 0.15;
    })();

    if (isMoving) {
      enemy.stillTime = 0;
      target = 'walk';
    } else {
      enemy.stillTime += delta;
      // Only commit to 'idle' after 200ms of genuine stillness.
      // A single skipped frame at a waypoint turn (~16ms) never crosses this.
      target = enemy.stillTime > 0.2 ? 'idle' : 'walk';
    }
  }

  // CRITICAL early-return: only crossfade when the target actually changed.
  // Without this guard, fadeOut/reset/fadeIn would fire every single frame
  // while the state is stable — reset() snaps the clip back to frame 0 each
  // time, producing the "plays 2-3 frames then stutters back to the start"
  // symptom. This single check is the entire fix.
  if (target === enemy.currentAnimationName) return;

  const nextAction = enemy.animations[target];
  if (!nextAction) {
    // Clip not yet loaded (async still in flight) — don't update
    // currentAnimationName so we retry on the next eligible frame.
    return;
  }

  const currentAction = enemy.animations[enemy.currentAnimationName];
  if (currentAction) {
    currentAction.fadeOut(0.3);
  }

  // reset() is only safe here because this branch only runs when target
  // genuinely changed — i.e. nextAction is NOT the already-playing clip.
  // If nextAction were currently playing and we reset() it, we'd snap to
  // frame 0 mid-stride. The currentAnimationName guard above ensures that
  // can't happen: nextAction is always a different (non-current) action here.
  nextAction.reset().fadeIn(0.3).play();
  enemy.currentAnimationName = target;
}
