/**
 * interpreter.js — Pipeline Stage 1: game state → beat type
 *
 * This is the only place in the Narrative Engine that decides which
 * "kind" of line to generate. Keeping that decision here — isolated from
 * prompt construction, API calls, and pool management — mirrors the same
 * boundary discipline as director.js on the client: the Director only sets
 * enemy.state; it never moves the enemy itself. Here, the interpreter only
 * assigns a beat type label; it never builds a prompt or touches the API.
 *
 * That separation means:
 *   - Threshold tuning (e.g. changing idleStreak cutoffs) never risks
 *     accidentally mutating prompt templates or generation parameters.
 *   - The function is a pure mapping with no side effects — easy to unit-
 *     test without spinning up any server infrastructure.
 *   - When the client eventually sends richer game state (e.g. a health
 *     value, number of rooms cleared) the beat-type logic can expand here
 *     without touching anything downstream.
 *
 * Beat type priority order (highest to lowest):
 *   hunt_taunt  — enemy is actively hunting; most urgent, overrides everything
 *   relief      — caller explicitly signals the hunt just ended
 *   tension     — player is idle or backtracking; subtly unnerving
 *   ambient     — default; quiet atmospheric flavor
 *
 * "relief" is not inferred from raw state fields because the server has
 * no persistent session context — it can't tell the difference between
 * "patrol after a hunt" and "patrol at the start of the game." The client
 * must pass beatType: "relief" explicitly when it wants that beat.
 */

'use strict';

/**
 * The seconds-of-idling threshold above which the game starts feeling
 * "too comfortable." Mirrors director.js's idleStreakThreshold (6s) but
 * is set slightly higher here (8s) because the narrative beat should lag
 * behind the Director's escalation decision, not fire at the same moment.
 */
const IDLE_STREAK_TENSION_THRESHOLD = 8;

/**
 * interpretContext — maps a game-state snapshot to one of four beat types.
 *
 * @param {object} gameState
 * @param {string}  gameState.roomName       - current room identifier
 * @param {boolean} gameState.isBacktracking - true if player has revisited this room
 * @param {number}  gameState.idleStreak     - seconds player has been nearly still
 * @param {number}  gameState.enemyDistance  - metres between player and enemy
 * @param {string}  gameState.enemyState     - "patrol" | "hunt"
 * @param {string}  [gameState.beatType]     - if present, bypass interpretation
 *                                             and return it directly (callers
 *                                             use this to inject "relief")
 *
 * @returns {"ambient"|"tension"|"hunt_taunt"|"relief"}
 */
function interpretContext(gameState) {
  const {
    enemyState,
    isBacktracking,
    idleStreak,
    beatType: explicitBeat,
  } = gameState;

  // If the caller already knows what beat type it wants (e.g. the Director
  // just ended a hunt and wants "relief"), trust that and short-circuit.
  if (explicitBeat) return explicitBeat;

  // An active hunt is the highest-priority beat — the enemy is closing in
  // and the narration should reflect imminent danger.
  if (enemyState === 'hunt') return 'hunt_taunt';

  // Backtracking or prolonged idling both indicate the player has relaxed
  // or become uncertain. Either is a cue for subtle dread — not overt danger,
  // just the feeling that something noticed the hesitation.
  if (isBacktracking || (idleStreak != null && idleStreak > IDLE_STREAK_TENSION_THRESHOLD)) {
    return 'tension';
  }

  // Default: the player is exploring normally. Quiet, atmospheric flavor.
  return 'ambient';
}

module.exports = { interpretContext };
