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
  // Kill-switch for demo comparison — toggled by pressing 'O' in main.js.
  // When false, updateDirector() returns immediately: no escalation, no
  // narrative triggers, no drone changes. The enemy stays in whatever state
  // it was in at the moment of the toggle — if it was hunting, it keeps
  // hunting; the "off" comparison should show what zero Director logic
  // produces from that point, not a scripted clean state.
  enabled: true,

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

  // --- Recap stats counters ---
  // Lifetime totals used to personalise the recap paragraph at session end.
  huntCount:             0, // total number of hunts this session
  noiseTriggeredCount:   0, // hunts triggered by the player moving too loudly
  comfortTriggeredCount: 0, // hunts triggered by comfort signals (idle/backtrack)

  // --- Audio: hunt-state drone timer ---
  // Tracks when the drone was last updated during a hunt. Kept separate from
  // decisionInterval because enemy distance changes fast during a chase — we
  // want the drone to track that at 0.4s resolution, not the 2s outer throttle.
  huntDroneLastUpdate: 0,
};

function updateDirector(delta) {
  // Kill-switch: when disabled the Director makes no decisions at all.
  // See Game.director.enabled comment above for the design rationale.
  if (!Game.director.enabled) return;

  const d = Game.director;
  const t = Game.telemetry;
  const enemy = Game.enemy;

  if (enemy.state === 'hunt') {
    const huntElapsed = Game.elapsedTime - d.huntStartTime;
    const caughtUp = t.enemyDistance !== null && t.enemyDistance < d.huntEndDistance;

    if (huntElapsed > d.maxHuntDuration || caughtUp) {
      endHunt();
    }
    // Update heartbeat tempo every frame while hunting — the new interval
    // takes effect on the next scheduleBeat() reschedule, so tempo changes
    // are smooth rather than mid-beat.
    updateHeartbeatTempo(t.enemyDistance);

    // Update the drone intensity on its own 0.4s timer, independent of both
    // the per-frame heartbeat update and the 2s patrol throttle. Distance
    // changes fast during a chase; 0.4s keeps the drone responsive without
    // saturating the Web Audio automation queue.
    // rampDuration 0.4 is passed explicitly so the ramp matches the call
    // interval — each ramp completes before the next begins, preventing the
    // overlapping-ramp glitch that a shorter ramp or longer interval would cause.
    if (Game.elapsedTime - d.huntDroneLastUpdate >= 0.4) {
      d.huntDroneLastUpdate = Game.elapsedTime;

      // Map enemyDistance to intensity over the same [1.5, 10] metre range
      // that updateHeartbeatTempo uses, so drone and heartbeat respond in sync.
      const dist = t.enemyDistance;
      let huntDroneIntensity;
      if (dist === null || dist >= 10) {
        huntDroneIntensity = 0.25; // enemy far away — calm floor
      } else if (dist <= 1.5) {
        huntDroneIntensity = 0.95; // enemy very close — maximum presence
      } else {
        // Linear map: 10m → 0.25, 1.5m → 0.95
        const frac = (dist - 1.5) / (10 - 1.5); // 1=far, 0=near
        huntDroneIntensity = 0.95 - frac * 0.70;
      }
      setDroneIntensity(huntDroneIntensity, 0.4);
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
    startHunt('noise');
    return;
  }

  // --- Comfort-based escalation ---
  if (Game.elapsedTime - d.lastDecisionTime < d.decisionInterval) return;
  d.lastDecisionTime = Game.elapsedTime;

  // --- Drone intensity: driven by relief-window progress ---
  // reliefRemaining counts down from reliefDuration to 0 after each hunt.
  // At full relief (just after a hunt), intensity is elevated (0.60) so
  // the bed sounds unsettled. As the cooldown drains, it returns to the
  // calm floor (0.25). During ordinary patrol (no recent hunt) reliefRemaining
  // is 0 and intensity stays at the floor. No new state needed — huntCooldownUntil
  // and reliefDuration already encode everything required.
  const reliefRemaining = Math.max(0, d.huntCooldownUntil - Game.elapsedTime);
  const droneIntensity  = 0.25 + (reliefRemaining / d.reliefDuration) * 0.35;
  setDroneIntensity(droneIntensity);

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
    startHunt('comfort');
  }
}

/**
 * startHunt(reason) — escalates the enemy to hunt state.
 *
 * @param {'comfort'|'noise'} reason  Why the hunt was triggered.
 *   'comfort' — player was idle or backtracking (comfort-based pathway)
 *   'noise'   — player moved too loudly within hearing range
 *
 * The reason parameter is only used here for stats tracking; by the time this
 * function runs, both pathways look identical from the inside (enemy.state is
 * 'patrol', cooldown has cleared). The call site is the only place that knows
 * why the hunt started — passing it in makes the code self-documenting and
 * gives the recap generator accurate data to write from.
 */
function startHunt(reason) {
  Game.enemy.state = 'hunt';
  Game.director.huntStartTime = Game.elapsedTime;
  Game.director.lastEvent = 'escalating — enemy is hunting';
  console.log('[Director] escalating: switching enemy to hunt');
  showNarrativeLine('hunt_taunt');
  // Audio: the stinger fires once at the moment of escalation (a transient
  // cue that something changed), then the heartbeat runs for the hunt's
  // duration. Both are fire-and-forget — director.js doesn't manage their
  // internals, only the start/stop boundary.
  playStinger();
  startHeartbeat();

  // Increment session-level hunt counters for the recap generator.
  Game.director.huntCount++;
  if (reason === 'noise') {
    Game.director.noiseTriggeredCount++;
  } else {
    Game.director.comfortTriggeredCount++;
  }
}

function endHunt() {
  Game.enemy.state = 'patrol';
  Game.enemy.currentWaypointIndex = 0;
  Game.director.huntCooldownUntil = Game.elapsedTime + Game.director.reliefDuration;
  Game.director.lastEvent = `relief — patrol resumes (calm for ${Game.director.reliefDuration}s)`;
  console.log('[Director] relief: enemy back to patrol');
  showNarrativeLine('relief');
  // Audio: silence the heartbeat as soon as the hunt ends. The drone will
  // gradually settle from its elevated relief intensity back to calm over
  // the next few setDroneIntensity() calls in updateDirector().
  stopHeartbeat();
}