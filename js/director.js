/**
 * director.js — Week 2, Days 10-11 scope
 *
 * The actual "AI Director." This file makes exactly one kind of decision
 * right now: when to escalate the enemy from patrol to hunt, and when to
 * back off again. It NEVER moves anything directly — it only ever sets
 * Game.enemy.state, and enemy.js is the one place that turns that state
 * into actual movement. Keeping that boundary strict is what will let us
 * add more decision types later (dialogue, ambient tension, item
 * placement) without the logic turning into spaghetti.
 *
 * The rule, in plain words: if the player has seemed "comfortable" for
 * a couple of seconds (either standing still for a while, or backtracking
 * — both suggest they've relaxed or gotten a little lost) AND the enemy
 * is currently far enough away that a hunt won't feel like an instant,
 * unfair ambush, escalate. Once a hunt ends, wait 15 seconds before
 * escalating again, so the game has actual rhythm instead of constant
 * pressure.
 */

Game.director = {
  lastDecisionTime: 0,
  decisionInterval: 2, // seconds between escalation checks — decisions shouldn't flicker every frame
  huntCooldownUntil: 0, // Game.elapsedTime value before another hunt is allowed to start
  huntStartTime: 0,
  maxHuntDuration: 12, // seconds — give up and return to patrol if the hunt runs this long
  huntEndDistance: 1.2, // meters — "caught up to the player," end the hunt
  reliefDuration: 15, // seconds of guaranteed calm after a hunt ends
  idleStreakThreshold: 6, // seconds of standing still that counts as "comfortable"
  safeEscalationDistance: 4, // meters — don't escalate if the enemy is already this close
  lastEvent: null, // human-readable string, shown in the debug overlay
};

function updateDirector(delta) {
  const d = Game.director;
  const t = Game.telemetry;
  const enemy = Game.enemy;

  // If a hunt is already in progress, only ever check whether it should end.
  // No new decisions get made mid-hunt — that keeps behavior predictable.
  if (enemy.state === 'hunt') {
    const huntElapsed = Game.elapsedTime - d.huntStartTime;
    const caughtUp = t.enemyDistance !== null && t.enemyDistance < d.huntEndDistance;

    if (huntElapsed > d.maxHuntDuration || caughtUp) {
      endHunt();
    }
    return;
  }

  // Throttle decision-making — re-evaluate every `decisionInterval` seconds,
  // not every frame. Frequent re-checks would make the Director "flicker."
  if (Game.elapsedTime - d.lastDecisionTime < d.decisionInterval) return;
  d.lastDecisionTime = Game.elapsedTime;

  // Respect the relief window after the last hunt.
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
}

function endHunt() {
  Game.enemy.state = 'patrol';
  Game.enemy.currentWaypointIndex = 0; // resume patrol from a known point, not wherever the hunt ended
  Game.director.huntCooldownUntil = Game.elapsedTime + Game.director.reliefDuration;
  Game.director.lastEvent = `relief — patrol resumes (calm for ${Game.director.reliefDuration}s)`;
  console.log('[Director] relief: enemy back to patrol');
}