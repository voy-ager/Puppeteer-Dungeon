/**
 * recap.js — Session endings: escaped and caught
 *
 * This module handles both possible ending states for the session:
 *
 *   'escaped' — player reaches final_chamber or presses R. Generates a
 *   reflective recap paragraph. Dismissed by re-requesting pointer lock
 *   so the player can keep exploring.
 *
 *   'caught' — enemy closed to within huntEndDistance during a hunt.
 *   Generates a dread-toned capture paragraph. Dismissed with
 *   location.reload() for a clean restart.
 *
 * Both outcomes share the same #recap-overlay element and the same
 * POST /api/narrative/recap endpoint. The `outcome` field in the stats
 * payload tells the backend which tone preamble to use.
 *
 * Why does setting Game.state = 'recap' / 'caught' pause gameplay?
 * Both are terminal states. Having the enemy continue moving while the
 * player reads (and can't react because pointer lock was released) would
 * be disorienting. Setting Game.state directly — not via setGameState() —
 * matches the same pattern used for 'recap': these are overlay states that
 * own their own DOM and must not trigger start-overlay/crosshair side effects.
 *
 * Depends on:
 *   - NARRATIVE_API_BASE (defined in narrativeUI.js, loaded before this file)
 *   - Game.telemetry, Game.director, Game.elapsedTime (all available at runtime)
 *   - setGameState() (defined in gamestate.js, loaded before this file)
 *   - pauseAudio(), playStinger(), stopHeartbeat() (defined in audio.js)
 *   - #recap-overlay DOM element (defined in index.html)
 */

// ---------------------------------------------------------------------------
// Game.recap — module state
// ---------------------------------------------------------------------------

Game.recap = {
  // 'active' has been removed — use Game.state === 'recap' instead.
  // Game.state is the single source of truth (gamestate.js); a redundant
  // local flag would drift out of sync and recreate the original bug.
  autoShown: false, // one-shot guard so final_chamber only auto-triggers once
  element:   null,  // cached #recap-overlay reference, set in initRecap()
};

// ---------------------------------------------------------------------------
// Client-side fallbacks — shown only if the backend is completely unreachable.
// These are intentionally different from the server's FALLBACK_RECAP /
// FALLBACK_CAUGHT: those cover "Granite failed but the server responded";
// these cover "the server itself couldn't be reached." There are two because
// the two endings have different emotional tones — showing the escaped fallback
// on a caught ending (or vice versa) would feel wrong and confusing.
// ---------------------------------------------------------------------------

const RECAP_CLIENT_FALLBACK =
  'You made it to the end. The dungeon watched every step — the hesitations, ' +
  'the choices, the moments you moved too quickly or waited too long. ' +
  'It remembers you passed through. That is enough.';

const CAUGHT_CLIENT_FALLBACK =
  'The dungeon finally closed the distance. It had been patient — more patient ' +
  'than you. Every step you took, every sound you made, brought it closer. ' +
  'This is where your path through the dark ends.';

// ---------------------------------------------------------------------------
// buildRecapStats — assembles the stats payload from live game state
// ---------------------------------------------------------------------------

/**
 * Reads current telemetry and director counters and packages them into the
 * stats shape expected by the Narrative Engine's /recap endpoint.
 *
 * All fields are always present — zero values are included and the backend's
 * buildRecapPrompt will simply omit them from the prompt naturally.
 *
 * @param {'escaped'|'caught'} outcome - how the session ended; included in
 *   the payload so the backend selects the correct tone preamble.
 * @returns {object} Stats payload ready for JSON serialisation.
 */
function buildRecapStats(outcome) {
  const t = Game.telemetry;
  const d = Game.director;

  // backtrackedRooms: any room in visitCounts with a visit count > 1.
  // The keys are internal room name strings (e.g. "room_2", "entry_hall").
  // The backend applies underscore→space substitution for prose; a proper
  // human-readable label map (e.g. "room_2" → "the second chamber") could
  // replace this later without changing the shape here.
  const backtrackedRooms = Object.keys(t.visitCounts).filter(
    room => t.visitCounts[room] > 1
  );

  return {
    outcome,
    totalDistance:         Math.round(t.totalDistance * 10) / 10,
    totalPlayTimeSeconds:  Math.round(Game.elapsedTime),
    huntCount:             d.huntCount             || 0,
    noiseTriggeredCount:   d.noiseTriggeredCount   || 0,
    comfortTriggeredCount: d.comfortTriggeredCount || 0,
    closeCallSeconds:      Math.round(t.closeCallSeconds * 10) / 10,
    sneakTimeSeconds:      Math.round(t.sneakTime || 0),
    backtrackedRooms,
  };
}

// ---------------------------------------------------------------------------
// Helper: format the stats readout shown below the recap paragraph
// ---------------------------------------------------------------------------

function formatStatsReadout(stats) {
  const minutes = Math.round(stats.totalPlayTimeSeconds / 60);
  const lines = [
    `${stats.totalDistance.toFixed(1)}m walked  ·  ${minutes} min`,
  ];

  if (stats.huntCount > 0) {
    lines.push(
      `hunted ${stats.huntCount}×` +
      (stats.noiseTriggeredCount > 0 ? ` (${stats.noiseTriggeredCount} by noise)` : '')
    );
  }

  if (stats.closeCallSeconds > 0) {
    lines.push(`${stats.closeCallSeconds.toFixed(1)}s in close-call range`);
  }

  if (stats.sneakTimeSeconds > 0) {
    lines.push(`${stats.sneakTimeSeconds}s sneaking`);
  }

  return lines.join('  ·  ');
}

// ---------------------------------------------------------------------------
// triggerRecap — the main action
// ---------------------------------------------------------------------------

/**
 * Shows the recap overlay, fetches the generated paragraph, and populates it.
 * Designed to always resolve cleanly — the player must never see a blank or
 * broken overlay at the end of their session.
 */
function triggerRecap() {
  if (Game.state === 'recap') return; // already showing, don't stack

  // Transition first, before exitPointerLock(). This is the critical ordering:
  // setGameState('recap') must run BEFORE the browser fires pointerlockchange,
  // so that main.js's consolidated listener sees Game.state === 'recap' (not
  // 'playing') and correctly skips the setGameState('paused') branch.
  setGameState('recap');

  // Objective complete — permanently disable the Director for this session.
  // There is no reason for continued escalation once the player has escaped:
  // the hunt system exists to create tension while the goal is unachieved.
  // Leaving it enabled would let the enemy trigger a capture notification
  // while the recap overlay is showing, which is both confusing and unfair.
  // This only applies to the 'escaped' path — the 'caught' path already
  // calls location.reload() via dismissCapture(), which resets everything.
  if (Game.director) {
    Game.director.enabled = false;
  }

  const overlay = Game.recap.element;
  if (!overlay) return;

  // Remove the caught tint modifier in case the overlay was previously shown
  // for a caught ending in the same session (defensive — reload resets this,
  // but a manual R-press after a catch could theoretically reuse the element).
  overlay.classList.remove('outcome-caught');

  // Unhide the overlay and show a loading state while the fetch runs.
  overlay.classList.remove('hidden');
  const textEl  = overlay.querySelector('.recap-text');
  const statsEl = overlay.querySelector('.recap-stats');
  const hintEl  = overlay.querySelector('.recap-hint');
  if (textEl)  textEl.textContent  = 'The dungeon is remembering\u2026';
  if (statsEl) statsEl.textContent = '';
  if (hintEl)  hintEl.textContent  = 'Click or press ESC to continue';

  // Exit pointer lock so the player can interact with the overlay normally.
  // Game.state is already 'recap', so the pointerlockchange listener in
  // main.js will see it and NOT call setGameState('paused') — the start-overlay
  // will not reappear beneath the recap overlay.
  document.exitPointerLock();

  const stats = buildRecapStats('escaped');

  fetch(NARRATIVE_API_BASE + '/recap', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(stats),
  })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      if (textEl)  textEl.textContent  = data.recap  || RECAP_CLIENT_FALLBACK;
      if (statsEl) statsEl.textContent = formatStatsReadout(stats);
    })
    .catch(err => {
      // Backend unreachable or returned an error — show the client fallback.
      // Log the error for debugging but never surface it to the player.
      console.warn('[Recap] fetch failed:', err.message);
      if (textEl)  textEl.textContent  = RECAP_CLIENT_FALLBACK;
      if (statsEl) statsEl.textContent = formatStatsReadout(stats);
    });
}

// ---------------------------------------------------------------------------
// triggerCapture — shows the caught ending overlay
// ---------------------------------------------------------------------------

/**
 * Called by director.js when the enemy closes to within huntEndDistance
 * during a hunt. Structurally parallel to triggerRecap(), but:
 *   - Sets Game.state = 'caught' directly (same pattern as triggerRecap()
 *     setting 'recap' — both are terminal overlay states that must NOT
 *     trigger start-overlay/crosshair side effects via setGameState).
 *   - Fires audio capture cues (stinger, stop heartbeat, pause audio).
 *   - Adds the 'outcome-caught' CSS class for the subtle red tint.
 *   - Dismiss action is location.reload() not requestPointerLock().
 */
function triggerCapture() {
  if (Game.state === 'caught') return; // guard against double-trigger

  // Set state FIRST — must happen before exitPointerLock() fires
  // pointerlockchange, so main.js's listener sees 'caught' and does not
  // call setGameState('paused'). Same critical ordering as triggerRecap().
  Game.state = 'caught';

  // Audio: fire the hunt-start stinger as a capture sting, then silence
  // everything. The stinger fires synchronously before pauseAudio() so it
  // has a brief window to start playing before the context is suspended.
  playStinger();
  stopHeartbeat();
  pauseAudio();

  // Release pointer lock so the overlay is fully interactive.
  document.exitPointerLock();

  const overlay = Game.recap.element;
  if (!overlay) return;

  // Apply the outcome-caught modifier class for the reddish tint.
  // Removed by triggerRecap() if the overlay is ever reused in the same page
  // load (defensive), but in practice a caught ending leads to location.reload().
  overlay.classList.add('outcome-caught');
  overlay.classList.remove('hidden');

  const textEl  = overlay.querySelector('.recap-text');
  const statsEl = overlay.querySelector('.recap-stats');
  const hintEl  = overlay.querySelector('.recap-hint');
  if (textEl)  textEl.textContent  = 'The dungeon closes in\u2026';
  if (statsEl) statsEl.textContent = '';
  if (hintEl)  hintEl.textContent  = 'Press R or click to try again';

  const stats = buildRecapStats('caught');

  fetch(NARRATIVE_API_BASE + '/recap', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(stats),
  })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      if (textEl)  textEl.textContent  = data.recap  || CAUGHT_CLIENT_FALLBACK;
      if (statsEl) statsEl.textContent = formatStatsReadout(stats);
    })
    .catch(err => {
      console.warn('[Recap] capture fetch failed:', err.message);
      if (textEl)  textEl.textContent  = CAUGHT_CLIENT_FALLBACK;
      if (statsEl) statsEl.textContent = formatStatsReadout(stats);
    });
}

// ---------------------------------------------------------------------------
// dismissRecap — hides the overlay and resumes gameplay
// ---------------------------------------------------------------------------

function dismissRecap() {
  if (Game.state !== 'recap') return;

  // Do NOT call setGameState('playing') here. The transition to 'playing'
  // is deferred until the browser actually confirms the pointer lock below —
  // the consolidated pointerlockchange listener in main.js handles it when
  // it sees Game.state === 'recap' and locked === true. Calling setGameState
  // prematurely here would hide the start-overlay before the lock is granted,
  // which could cause a brief unlit canvas flash if the browser denies or
  // delays the lock.
  const overlay = Game.recap.element;
  if (overlay) overlay.classList.add('hidden');

  // Re-request pointer lock so the player can continue exploring
  // final_chamber. The transition to 'playing' (and resumeAudio) fires
  // automatically via the pointerlockchange listener once the browser grants it.
  if (Game.renderer && Game.renderer.domElement) {
    Game.renderer.domElement.requestPointerLock();
  }
}

// ---------------------------------------------------------------------------
// dismissCapture — ends the caught overlay with a full reload
// ---------------------------------------------------------------------------

function dismissCapture() {
  if (Game.state !== 'caught') return;

  // A full page reload is the deliberate reset strategy for the caught ending.
  // Manually resetting every module (enemy position, director counters, telemetry
  // totals, audio graph nodes, pool state) would be significant additional scope
  // with real correctness risk — any forgotten reset would produce a corrupted
  // second run. location.reload() is simpler and completely reliable. This is
  // the right call for a hackathon timeline.
  location.reload();
}

// ---------------------------------------------------------------------------
// initRecap — called once at boot from main.js
// ---------------------------------------------------------------------------

function initRecap() {
  Game.recap.element = document.getElementById('recap-overlay');

  const overlay = Game.recap.element;
  if (!overlay) return;

  // Delegating click handler — reads Game.state at click time so this single
  // listener correctly handles both the 'recap' and 'caught' dismiss actions.
  // Both dismiss functions guard on their own state, so only the matching one
  // fires; calling both explicitly here would also be safe, but delegating is
  // more readable.
  overlay.addEventListener('click', () => {
    if (Game.state === 'recap')  dismissRecap();
    if (Game.state === 'caught') dismissCapture();
  });
}

// ---------------------------------------------------------------------------
// checkRecapAutoTrigger — called every frame from main.js
// ---------------------------------------------------------------------------

/**
 * Watches for the player entering final_chamber and triggers the recap once.
 * The autoShown flag is a one-shot guard — even if the player walks in and
 * out of final_chamber the recap only fires on the first entry.
 *
 * Called outside the Game.state === 'playing' gate in main.js so it can fire
 * even when gameplay is paused (in practice the trigger only matters while the
 * player is actively moving, but keeping it unconditional is simpler).
 */
function checkRecapAutoTrigger() {
  if (
    Game.telemetry.currentRoom === 'final_chamber' &&
    !Game.recap.autoShown &&
    Game.state !== 'recap' &&
    // Also guard against 'caught': if the player somehow reached final_chamber
    // during the same frame the enemy caught them, the capture takes priority.
    // In practice these can't happen simultaneously, but the guard is cheap.
    Game.state !== 'caught'
  ) {
    Game.recap.autoShown = true;
    triggerRecap();
  }
}
