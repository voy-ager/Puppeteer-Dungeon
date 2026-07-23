/**
 * director.js — Day 14 scope
 *
 * Same escalation/relief logic as Days 10-11. Two additions:
 *   1. startHunt()/endHunt() now also call showNarrativeLine() — the
 *      Director already decides WHEN something dramatically important
 *      happens, so it's the natural place to also decide when to speak.
 *   2. A periodic ambient/tension check-in during calm patrol, so the
 *      game isn't silent the whole time between hunts.
 *
 * Noise-detection update:
 *   3. A second, independent hunt trigger: if the player moves loudly
 *      while close enough to be heard, startHunt() is called immediately,
 *      bypassing the comfort-based decisionInterval throttle. This gives
 *      the player real agency — sneak past danger, or move fast and risk it.
 *      Both pathways converge on the same startHunt() call; the Director
 *      doesn't need to know which reason fired.
 *
 * Deliberately NOT changed: this file still never touches enemy position
 * or displays anything itself — narrativeUI.js owns the fetch/display,
 * enemy.js owns movement. The Director only ever decides.
 */

Game.director = {
  lastDecisionTime: 0,
  decisionInterval: 2,
  huntCooldownUntil: 0,
  huntStartTime: 0,
  maxHuntDuration: 12,
  huntEndDistance: 1.2,
  reliefDuration: 15,
  idleStreakThreshold: 6,
  safeEscalationDistance: 4, // comfort-based escalation won't fire closer than this
  lastEvent: null,

  // --- Day 14 additions: ambient/tension check-in pacing ---
  ambientIntervalSeconds: 25, // how often to speak during calm patrol
  lastAmbientTime: 0,

  // --- Noise-detection additions ---
  // hearingRadius is larger than safeEscalationDistance (4m) because hearing
  // outranges the "too close to safely escalate" check — being heard when the
  // enemy is 3m away is a fair consequence of making noise, not an ambush.
  hearingRadius: 7,
  // At noiseTriggerThreshold 0.6, a sprinting player (~noiseLevel 0.9) always
  // triggers it; a walking player (~0.5) stays just below it; sneaking (0)
  // never triggers it. Tuned to make the choice feel meaningful, not punishing.
  noiseTriggerThreshold: 0.6,
};

function updateDirector(delta) {
  const d = Game.director;
  const t = Game.telemetry;
  const enemy = Game.enemy;

  if (enemy.state === 'hunt') {
    const huntElapsed = Game.elapsedTime - d.huntStartTime;
    const caughtUp = t.enemyDistance !== null && t.enemyDistance < d.huntEndDistance;

    if (huntElapsed > d.maxHuntDuration || caughtUp) {
      endHunt();
    }
    return;
  }

  // --- Noise-triggered hunt pathway ---
  // Runs every frame (no decisionInterval throttle) so that loud movement
  // triggers a hunt immediately rather than waiting up to 2 seconds for the
  // next comfort check. The huntCooldownUntil gate is still respected — noise
  // cannot force a hunt during the guaranteed calm window after a hunt ends,
  // which preserves the game's rhythm and stops the mechanic from feeling
  // like a punishment loop.
  // This is entirely independent of the comfort-based check below — two
  // different reasons a hunt can start, both converging on startHunt().
  if (
    Game.elapsedTime >= d.huntCooldownUntil &&
    t.enemyDistance !== null &&
    t.enemyDistance < d.hearingRadius &&
    t.noiseLevel > d.noiseTriggerThreshold
  ) {
    d.lastEvent = 'noise trigger — player heard';
    startHunt();
    return;
  }

  // --- Comfort-based escalation ---
  if (Game.elapsedTime - d.lastDecisionTime < d.decisionInterval) return;
  d.lastDecisionTime = Game.elapsedTime;

  // --- Ambient/tension check-in ---
  // Runs independently of the escalation cooldown below — the game should
  // still speak occasionally even during a post-hunt relief window, just
  // never escalate to a hunt during it.
  if (Game.elapsedTime - d.lastAmbientTime > d.ambientIntervalSeconds) {
    d.lastAmbientTime = Game.elapsedTime;
    const beatType = t.idleStreak > d.idleStreakThreshold || isBacktracking() ? 'tension' : 'ambient';
    showNarrativeLine(beatType);
  }

  if (Game.elapsedTime < d.huntCooldownUntil) return;

  const playerSeemsComfortable =
    t.idleStreak > d.idleStreakThreshold || isBacktracking();
  const enemyFarEnoughToEscalate =
    t.enemyDistance === null || t.enemyDistance > d.safeEscalationDistance;

  if (playerSeemsComfortable && enemyFarEnoughToEscalate) {
    startHunt();
  }
}

function startHunt() {
  Game.enemy.state = 'hunt';
  Game.director.huntStartTime = Game.elapsedTime;
  Game.director.lastEvent = 'escalating — enemy is hunting';
  console.log('[Director] escalating: switching enemy to hunt');
  showNarrativeLine('hunt_taunt');
}

function endHunt() {
  Game.enemy.state = 'patrol';
  Game.enemy.currentWaypointIndex = 0;
  Game.director.huntCooldownUntil = Game.elapsedTime + Game.director.reliefDuration;
  Game.director.lastEvent = `relief — patrol resumes (calm for ${Game.director.reliefDuration}s)`;
  console.log('[Director] relief: enemy back to patrol');
  showNarrativeLine('relief');
}