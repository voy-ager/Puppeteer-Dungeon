/**
 * enemy.js — Week 2, Days 10-11 scope
 *
 * Movement now branches on enemy.state:
 *   - 'patrol' : the same fixed waypoint loop from Days 4-5
 *   - 'hunt'   : moves directly toward the player's current position,
 *                faster than patrol speed
 *
 * Important design choice: enemy.js still owns all movement logic.
 * director.js only ever flips enemy.state — it never touches position
 * directly. That separation is what keeps the Director "just a decision
 * maker" instead of a tangle of movement code spread across two files.
 *
 * Visual rework (Days 12+):
 * The placeholder cylinder+sphere is replaced with a humanoid rig built
 * from Group hierarchies and primitive geometries. The rig is intentionally
 * "wrong" in three specific ways — see updateWalkAnimation() for the full
 * rationale. The movement functions (patrolWaypoints, huntTowardPlayer) are
 * completely unchanged; this file only changes what the mesh looks like and
 * how its limbs move.
 */

Game.enemy = {
  mesh: null,
  waypoints: [],
  currentWaypointIndex: 0,
  speed: 1.4,             // patrol speed, m/s
  huntSpeedMultiplier: 1.8, // hunt speed = speed * this
  state: 'patrol',        // 'patrol' | 'hunt' — set by director.js

  // --- Animation state ---
  walkPhase: 0,           // phase accumulator for the walk cycle; advances while moving,
                          // frozen while idle so the idle sway can use a separate clock
  lastPosition: null,     // THREE.Vector3 snapshot from last frame; used to derive
                          // per-frame velocity without needing a separate speed variable
  limbRefs: null,         // named references to every animated Group, populated in
                          // initEnemy() so updateWalkAnimation() reaches them in O(1)
                          // without traversing the scene graph each frame
};

// ---------------------------------------------------------------------------
// Rig geometry constants — kept at the top so proportions are easy to adjust
// without hunting through the construction code below.
// ---------------------------------------------------------------------------

const TORSO_W = 0.5, TORSO_H = 0.9, TORSO_D = 0.3;
const HEAD_R   = 0.22;
const ARM_R    = 0.06, ARM_LEN  = 1.0;  // arms are deliberately longer than
                                         // the torso (1.0 vs 0.9) — one wrong
                                         // proportion that reads as "not quite human"
const LEG_R    = 0.09, LEG_LEN  = 0.9;

// Shoulder and hip x-offsets from the body centre-line
const SHOULDER_X = 0.35;
const HIP_X      = 0.15;

function initEnemy() {
  // Single material instance shared by every mesh on the rig — same spec as
  // the original placeholder so the enemy's appearance doesn't change in
  // colour or finish, only in silhouette.
  const material = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.95 });

  // --- Torso ---
  const torsoMesh = new THREE.Mesh(
    new THREE.BoxGeometry(TORSO_W, TORSO_H, TORSO_D),
    material
  );
  // Offset upward by half the torso height so the bottom of the torso sits
  // at the hip line (y=0 within the body group) rather than centring on it.
  torsoMesh.position.y = TORSO_H / 2;
  torsoMesh.castShadow = true;

  // --- Head ---
  // headGroup is the pivot point at the top of the torso. The mesh is then
  // offset upward by its own radius so the bottom of the head sphere sits at
  // the pivot rather than the centre — this makes headGroup rotation feel
  // like a natural neck pivot.
  const headGroup = new THREE.Group();
  headGroup.position.y = TORSO_H; // top of torso

  const headMesh = new THREE.Mesh(
    new THREE.SphereGeometry(HEAD_R, 10, 8),
    material
  );
  headMesh.position.y = HEAD_R;
  headMesh.castShadow = true;

  // Permanent tilt — rotation.z is set once here and never touched again by
  // the animation code. A fixed asymmetry at rest is more unsettling than a
  // symmetrical posture: it implies the figure was built slightly wrong, or
  // damaged, rather than just animated badly.
  headMesh.rotation.z = 0.15;

  headGroup.add(headMesh);

  // --- Left arm ---
  // The shoulder Group is the pivot point at shoulder height. The cylinder
  // mesh is offset downward by half its length so the TOP of the cylinder
  // sits at the pivot — rotating the group then swings the arm correctly
  // from the shoulder rather than rotating about its own centre.
  const leftShoulderGroup = new THREE.Group();
  leftShoulderGroup.position.set(-SHOULDER_X, TORSO_H * 0.88, 0);

  const leftArmMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(ARM_R, ARM_R, ARM_LEN, 6),
    material
  );
  leftArmMesh.position.y = -(ARM_LEN / 2);
  leftArmMesh.castShadow = true;
  leftShoulderGroup.add(leftArmMesh);

  // --- Right arm ---
  const rightShoulderGroup = new THREE.Group();
  rightShoulderGroup.position.set(SHOULDER_X, TORSO_H * 0.88, 0);

  const rightArmMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(ARM_R, ARM_R, ARM_LEN, 6),
    material
  );
  rightArmMesh.position.y = -(ARM_LEN / 2);
  rightArmMesh.castShadow = true;
  rightShoulderGroup.add(rightArmMesh);

  // --- Left leg ---
  // Same pivot-at-joint pattern: hip Group at y=0 (the hip line within the
  // body group), leg mesh offset downward so it hangs from the hip.
  const leftHipGroup = new THREE.Group();
  leftHipGroup.position.set(-HIP_X, 0, 0);

  const leftLegMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(LEG_R, LEG_R, LEG_LEN, 6),
    material
  );
  leftLegMesh.position.y = -(LEG_LEN / 2);
  leftLegMesh.castShadow = true;
  leftHipGroup.add(leftLegMesh);

  // --- Right leg ---
  const rightHipGroup = new THREE.Group();
  rightHipGroup.position.set(HIP_X, 0, 0);

  const rightLegMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(LEG_R, LEG_R, LEG_LEN, 6),
    material
  );
  rightLegMesh.position.y = -(LEG_LEN / 2);
  rightLegMesh.castShadow = true;
  rightHipGroup.add(rightLegMesh);

  // --- Body group: assembles all parts above the floor ---
  const body = new THREE.Group();
  body.add(torsoMesh);
  body.add(headGroup);
  body.add(leftShoulderGroup);
  body.add(rightShoulderGroup);
  body.add(leftHipGroup);
  body.add(rightHipGroup);

  // --- Root group ---
  const group = new THREE.Group();
  group.add(body);

  // Ground-level fix: body sits at y=LEG_LEN within the root group so that:
  //   hip joints  → world y = 0.9
  //   leg centres → world y = 0.9 − 0.45 = 0.45
  //   feet (bottom of legs) → world y = 0.9 − 0.9 = 0.0  ← floor plane
  // The root group's position.y stays 0, matching existing waypoints.
  body.position.y = LEG_LEN;

  Game.enemy.mesh = group;

  // Store named references to every animated Group so updateWalkAnimation()
  // can reach them in O(1) each frame without traversing the scene graph.
  Game.enemy.limbRefs = {
    body,
    headGroup,
    leftHip:       leftHipGroup,
    rightHip:      rightHipGroup,
    leftShoulder:  leftShoulderGroup,
    rightShoulder: rightShoulderGroup,
  };

  Game.enemy.waypoints = [
    new THREE.Vector3(0,  0, -15),
    new THREE.Vector3(3,  0, -15),
    new THREE.Vector3(3,  0, -18.5),
    new THREE.Vector3(-3, 0, -18.5),
    new THREE.Vector3(-3, 0, -15),
  ];

  group.position.copy(Game.enemy.waypoints[0]);
  Game.enemy.lastPosition = group.position.clone();
  Game.scene.add(group);
}

// ---------------------------------------------------------------------------

function updateEnemy(delta) {
  const enemy = Game.enemy;
  if (!enemy.mesh) return;

  if (enemy.state === 'hunt') {
    huntTowardPlayer(delta);
  } else {
    patrolWaypoints(delta);
  }

  // Animate limbs after movement so the walk cycle reflects this frame's
  // actual displacement rather than last frame's position.
  updateWalkAnimation(delta);
}

function patrolWaypoints(delta) {
  const enemy = Game.enemy;
  if (enemy.waypoints.length === 0) return;

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

function huntTowardPlayer(delta) {
  const enemy = Game.enemy;
  const pos = enemy.mesh.position;
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

/**
 * updateWalkAnimation — procedural limb animation, called every frame from
 * updateEnemy() after the movement step has already updated position.
 *
 * Three deliberate "wrong" details are baked into the animation:
 *
 *   1. LIMP — the left leg swings with a smaller amplitude than the right
 *      (LEFT_LEG_AMP vs RIGHT_LEG_AMP, roughly 30% smaller). The choice of
 *      which leg is weaker is arbitrary but intentional — it's commented as
 *      such rather than implying any narrative reason. A limp implies history
 *      and damage; it reads as more unsettling than either a clean walk or
 *      something obviously mechanical.
 *
 *   2. SAME-SIDE ARM SWING — arms swing in phase with the leg on their own
 *      side, not the opposite side as in normal human gait. Humans counter-
 *      swing (right arm forward when left leg is forward) as a natural
 *      balance mechanism. Breaking that rule is imperceptible at a glance but
 *      registers as "wrong" on close inspection — exactly the kind of detail
 *      that makes a horror enemy unsettling rather than scary.
 *
 *   3. IDLE TREMOR using two incommensurate sine waves — when the enemy is
 *      nearly still, the body and head get a low-amplitude sway driven by
 *      sin(t * 0.7) + sin(t * 1.1). The ratio 0.7/1.1 ≈ 0.636 is irrational,
 *      so the combined wave never perfectly repeats. A looping idle animation
 *      reads as "game idle"; a never-repeating tremor reads as breathing or
 *      barely-contained tension.
 *
 * The idle sway uses Game.elapsedTime as its time source rather than walkPhase
 * because walkPhase is deliberately frozen while idle — using a frozen
 * accumulator for a time-varying sway would produce a fixed, static pose
 * rather than continuous tremor.
 */

// Animation constants — named and grouped here so the "feel" of the walk
// can be tuned without touching the logic below.
const LEFT_LEG_AMP   = 0.38; // left leg swing amplitude (radians) — the weaker side
const RIGHT_LEG_AMP  = 0.55; // right leg swing amplitude — larger, producing the limp
const ARM_AMP        = 0.30; // arm swing amplitude; subtler than legs
const IDLE_SPEED_THRESHOLD = 0.05; // m/s — below this the enemy is considered still
const IDLE_SWAY_AMP  = 0.03; // radians — small enough to be barely perceptible at distance

function updateWalkAnimation(delta) {
  const enemy = Game.enemy;
  if (!enemy.limbRefs || !enemy.lastPosition) return;

  const { body, headGroup, leftHip, rightHip, leftShoulder, rightShoulder } = enemy.limbRefs;
  const pos = enemy.mesh.position;

  // Derive current speed from how far the enemy moved this frame.
  // This naturally produces zero speed at waypoint pauses and smoothly
  // scales with hunt vs patrol speed without needing separate constants.
  const dx = pos.x - enemy.lastPosition.x;
  const dz = pos.z - enemy.lastPosition.z;
  const stepDistance = Math.hypot(dx, dz);
  const speed = delta > 0 ? stepDistance / delta : 0;

  const isMoving = speed > IDLE_SPEED_THRESHOLD;

  if (isMoving) {
    // Advance the walk phase proportionally to speed so faster movement
    // produces faster leg cycling. The multiplier 2.5 is a tuning value:
    // it maps typical patrol speed (~1.4 m/s) to a phase rate that looks
    // like a natural stride frequency.
    enemy.walkPhase += speed * 2.5 * delta;

    const phase = enemy.walkPhase;

    // Legs: opposite phase (standard walk cycle), unequal amplitude (limp).
    leftHip.rotation.x  =  Math.sin(phase)       * LEFT_LEG_AMP;
    rightHip.rotation.x =  Math.sin(phase + Math.PI) * RIGHT_LEG_AMP;

    // Arms: SAME phase as the leg on their own side (not the opposite side).
    // This is the subtle wrongness — see block comment above for rationale.
    leftShoulder.rotation.x  =  Math.sin(phase)       * ARM_AMP;
    rightShoulder.rotation.x =  Math.sin(phase + Math.PI) * ARM_AMP;

    // While walking, fade idle sway back toward neutral so it doesn't fight
    // the walk cycle. lerp at 0.15 per frame is fast enough to feel
    // responsive but slow enough not to snap.
    body.rotation.z      += (0 - body.rotation.z)      * 0.15;
    headGroup.rotation.z += (0 - headGroup.rotation.z) * 0.15;

  } else {
    // --- Idle branch ---
    // walkPhase is frozen; use Game.elapsedTime so the sway advances
    // continuously regardless of whether the enemy is moving.
    const t = Game.elapsedTime;

    // Two sine waves with an irrational frequency ratio — the combined
    // signal never repeats exactly, so it never feels like a looped idle.
    const sway = Math.sin(t * 0.7) * IDLE_SWAY_AMP
               + Math.sin(t * 1.1) * IDLE_SWAY_AMP * 0.6;

    // Body sway on the Z axis (side-to-side lean).
    body.rotation.z = sway;

    // Head gets a small independent secondary sway, slightly out of phase
    // with the body by adding an offset to t. This breaks the synchrony
    // between torso and head — a subtle tell that the figure is alive and
    // wrong, not just a static mesh.
    headGroup.rotation.z = Math.sin(t * 0.7 + 0.8) * IDLE_SWAY_AMP * 0.5;

    // Blend limbs toward rest so the transition from walk to idle is smooth
    // rather than snapping to zero. The lerp factor here is gentler (0.08)
    // than the walk→idle blend above because we want a slow, eerie settle.
    leftHip.rotation.x       += (0 - leftHip.rotation.x)       * 0.08;
    rightHip.rotation.x      += (0 - rightHip.rotation.x)      * 0.08;
    leftShoulder.rotation.x  += (0 - leftShoulder.rotation.x)  * 0.08;
    rightShoulder.rotation.x += (0 - rightShoulder.rotation.x) * 0.08;
  }

  // Record position for next frame's velocity calculation.
  enemy.lastPosition.copy(pos);
}
