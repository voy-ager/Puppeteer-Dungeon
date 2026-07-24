/**
 * npc.js — Stationary ally NPC
 *
 * A companion figure standing in room_3 (world position ~(2, 0, -26)).
 * Built using the same Group-hierarchy rig pattern as enemy.js — torso,
 * head, arms, and legs as primitives, each limb rotating around a pivot
 * Group so the skeleton is correctly proportioned — but with two deliberate
 * contrasts that make this character read as trustworthy rather than wrong:
 *
 *   1. CORRECT proportions — arm length matches torso height (0.9 each),
 *      no permanent head tilt. The enemy's proportional wrongness is what
 *      makes it unsettling; restoring correctness here signals "safe."
 *
 *   2. CORRECT idle animation — the body's gentle side-to-side sway uses a
 *      normal two-sine blend. Arms are held still (not swaying). A standing
 *      figure with swaying arms reads as reaching; held-still arms reads as
 *      calm attentiveness. The head nods slightly out of phase with the body,
 *      which reads as breathing rather than mechanical oscillation.
 *
 * The NPC speaks via the existing showNarrativeLine() function when the
 * player gets within ~4m, subject to a 20-second cooldown and a guard that
 * prevents interrupting an already-visible subtitle. It contributes no new
 * Director state and introduces no new beat types — it is simply a second,
 * location-gated trigger source for beat types that already exist.
 */

// ---------------------------------------------------------------------------
// NPC rig geometry constants
// Prefixed NPC_ to avoid collision with enemy.js's unprefixed constants,
// which are in the same global scope.
// ---------------------------------------------------------------------------

const NPC_TORSO_W = 0.5,  NPC_TORSO_H = 0.9, NPC_TORSO_D = 0.3;
const NPC_HEAD_R  = 0.22;
const NPC_ARM_R   = 0.06, NPC_ARM_LEN = 0.9;  // 0.9 matches torso height —
                                                // correct human proportion,
                                                // unlike the enemy's too-long 1.0
const NPC_LEG_R   = 0.09, NPC_LEG_LEN = 0.9;

const NPC_SHOULDER_X = 0.35;
const NPC_HIP_X      = 0.15;

// Idle sway amplitude — slightly smaller than the enemy's 0.03.
// The ally should feel calmer, less agitated.
const NPC_IDLE_SWAY_AMP = 0.02;

// ---------------------------------------------------------------------------
// Game.npc — state object
// ---------------------------------------------------------------------------

Game.npc = {
  mesh:          null,
  limbRefs:      null, // { body, headGroup } — only these two sway in idle
  lastSpokenTime: -999, // Game.elapsedTime value when NPC last spoke.
                        // Initialised to -999 so the first proximity event
                        // fires immediately rather than waiting 20 seconds.
};

// ---------------------------------------------------------------------------
// initNPC — builds the rig and places it in the scene
// ---------------------------------------------------------------------------

function initNPC() {
  // Lighter, warmer material — dull fabric brown rather than near-black.
  // The colour contrast with the enemy (0x0a0a0c) and the dungeon geometry
  // is intentional: something visually distinct reads as "different kind of
  // thing" before the player is close enough to read its posture.
  const material = new THREE.MeshStandardMaterial({
    color: 0x4a4238,
    roughness: 0.85,
  });

  // --- Torso ---
  const torsoMesh = new THREE.Mesh(
    new THREE.BoxGeometry(NPC_TORSO_W, NPC_TORSO_H, NPC_TORSO_D),
    material
  );
  torsoMesh.position.y = NPC_TORSO_H / 2;
  torsoMesh.castShadow = true;

  // --- Head ---
  // headGroup is the neck pivot; mesh sits above it by its own radius.
  // No permanent tilt — the ally should look straight ahead, undamaged.
  const headGroup = new THREE.Group();
  headGroup.position.y = NPC_TORSO_H;

  const headMesh = new THREE.Mesh(
    new THREE.SphereGeometry(NPC_HEAD_R, 10, 8),
    material
  );
  headMesh.position.y = NPC_HEAD_R;
  headMesh.castShadow = true;
  headGroup.add(headMesh);

  // --- Left arm ---
  const leftShoulderGroup = new THREE.Group();
  leftShoulderGroup.position.set(-NPC_SHOULDER_X, NPC_TORSO_H * 0.88, 0);

  const leftArmMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(NPC_ARM_R, NPC_ARM_R, NPC_ARM_LEN, 6),
    material
  );
  leftArmMesh.position.y = -(NPC_ARM_LEN / 2);
  leftArmMesh.castShadow = true;
  leftShoulderGroup.add(leftArmMesh);

  // --- Right arm ---
  const rightShoulderGroup = new THREE.Group();
  rightShoulderGroup.position.set(NPC_SHOULDER_X, NPC_TORSO_H * 0.88, 0);

  const rightArmMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(NPC_ARM_R, NPC_ARM_R, NPC_ARM_LEN, 6),
    material
  );
  rightArmMesh.position.y = -(NPC_ARM_LEN / 2);
  rightArmMesh.castShadow = true;
  rightShoulderGroup.add(rightArmMesh);

  // --- Left leg ---
  const leftHipGroup = new THREE.Group();
  leftHipGroup.position.set(-NPC_HIP_X, 0, 0);

  const leftLegMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(NPC_LEG_R, NPC_LEG_R, NPC_LEG_LEN, 6),
    material
  );
  leftLegMesh.position.y = -(NPC_LEG_LEN / 2);
  leftLegMesh.castShadow = true;
  leftHipGroup.add(leftLegMesh);

  // --- Right leg ---
  const rightHipGroup = new THREE.Group();
  rightHipGroup.position.set(NPC_HIP_X, 0, 0);

  const rightLegMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(NPC_LEG_R, NPC_LEG_R, NPC_LEG_LEN, 6),
    material
  );
  rightLegMesh.position.y = -(NPC_LEG_LEN / 2);
  rightLegMesh.castShadow = true;
  rightHipGroup.add(rightLegMesh);

  // --- Body group ---
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

  // Same ground-level offset as enemy.js: body.position.y = LEG_LEN puts
  // hips at world y=0.9, feet at world y=0.0, flush with the floor plane.
  body.position.y = NPC_LEG_LEN;

  // room_3 centre (0, -27), 8×8 m → bounds X[-4,4], Z[-31,-23].
  // Placed at (2, 0, -26): off the centreline so it doesn't block the
  // corridor axis, well inside the room, visible as the player enters.
  group.position.set(2, 0, -26);

  Game.npc.mesh     = group;
  Game.npc.limbRefs = { body, headGroup };

  Game.scene.add(group);
}

// ---------------------------------------------------------------------------
// updateNPC — idle animation and proximity-triggered narration
// ---------------------------------------------------------------------------

/**
 * Called every frame from main.js's animate() loop.
 *
 * Two responsibilities:
 *   1. Idle sway — a gentle two-sine body sway using Game.elapsedTime, so it
 *      advances continuously regardless of whether the player is nearby.
 *      Arms are NOT animated. A stationary figure with swaying arms reads as
 *      reaching or unsteady; held-still arms with a breathing torso reads as
 *      calm and attentive — the intended impression.
 *
 *   2. Proximity trigger — when the player is within 4m, the NPC hasn't
 *      spoken in 20 seconds, and no subtitle is currently visible, request
 *      a narration line matching the current dramatic beat. Beat type is
 *      inferred from the same telemetry signals the Director uses —
 *      isBacktracking() and idleStreak — so the NPC's line always fits the
 *      moment even though the NPC has no Director state of its own.
 *
 *      The subtitle visibility guard (checking for the 'visible' class) is
 *      the minimal fix for the timer-overlap problem: the Director's own
 *      25-second ambient timer and this 20-second NPC timer can both fire
 *      in the same window. Without the guard, a just-displayed Director line
 *      could be immediately overwritten by an NPC line (or vice versa),
 *      because narrativeUI.js's request-ID mechanism discards older responses
 *      when a newer request has been issued. The guard simply defers the NPC
 *      trigger by one frame if something is already showing — the proximity
 *      condition remains true, so it will fire on the next eligible frame.
 */
function updateNPC(delta) {
  const npc = Game.npc;
  if (!npc.mesh || !npc.limbRefs) return;

  const { body, headGroup } = npc.limbRefs;
  const t = Game.elapsedTime;

  // --- Idle sway ---
  // Two incommensurate sine frequencies (same technique as enemy idle) so the
  // sway never perfectly loops. Frequencies chosen to be calmer than the
  // enemy's (0.5 and 0.8 Hz vs enemy's 0.7 and 1.1 Hz) — slower = more serene.
  const sway = Math.sin(t * 0.5) * NPC_IDLE_SWAY_AMP
             + Math.sin(t * 0.8) * NPC_IDLE_SWAY_AMP * 0.5;

  body.rotation.z = sway;

  // Head nods slightly behind the body — a small phase offset (0.6 rad)
  // breaks synchrony between torso and head, reading as a natural secondary
  // motion rather than a rigid two-part block oscillating together.
  headGroup.rotation.z = Math.sin(t * 0.5 + 0.6) * NPC_IDLE_SWAY_AMP * 0.4;

  // --- Proximity trigger ---
  const pos = Game.camera.position;
  const npcPos = npc.mesh.position;
  const npcDistance = Math.hypot(pos.x - npcPos.x, pos.z - npcPos.z);

  // 4m trigger radius: close enough that the player clearly chose to approach,
  // wide enough that they don't have to stand on the NPC's feet to hear it.
  // 20s cooldown: long enough to avoid spam; short enough that the NPC still
  // speaks at a few distinct moments during a typical playthrough of this room.
  // Subtitle guard: skip this frame if something is already displaying — the
  // proximity condition stays true and will retrigger as soon as the subtitle
  // clears, without missing the moment or requiring any coordination state.
  if (
    npcDistance < 4.0 &&
    Game.elapsedTime - npc.lastSpokenTime > 20 &&
    Game.narrativeUI.element &&
    !Game.narrativeUI.element.classList.contains('visible')
  ) {
    // Key grant — fires exactly once, on the first proximity event.
    // Guard on !Game.hasKey so subsequent proximity triggers (the NPC still
    // speaks on the normal 20s cooldown) don't re-grant or re-show the message.
    // The displaySubtitle call happens regardless of subtitle visibility — the
    // key pickup is a one-time story beat that should always show, not be
    // suppressed because another subtitle happened to be fading.
    if (!Game.hasKey) {
      Game.hasKey = true;
      displaySubtitle('You found a key.');
    }

    // Choose beat type using the same telemetry signals the Director uses,
    // so the NPC's line always fits the current dramatic moment. The NPC
    // never decides to escalate — it only reflects what's already happening.
    const beatType =
      (Game.telemetry.idleStreak > Game.director.idleStreakThreshold || isBacktracking())
        ? 'tension'
        : 'ambient';

    showNarrativeLine(beatType);
    npc.lastSpokenTime = Game.elapsedTime;
  }
}
