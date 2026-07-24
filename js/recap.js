/**
 * recap.js — Session recap overlay
 *
 * The one "keepable artifact" from a playthrough: a personalised paragraph
 * narrating what actually happened in this specific session. Triggered
 * automatically when the player reaches final_chamber, or manually at any
 * time by pressing R.
 *
 * This module is the only place that touches the recap overlay DOM. It owns:
 *   - Assembling the stats object from live telemetry and director state
 *   - Fetching the generated paragraph from the Narrative Engine backend
 *   - Displaying, loading-stating, and dismissing the overlay
 *
 * Why does Game.state === 'recap' pause gameplay?
 * The recap is the culminating moment of the session. Having the enemy
 * continue moving while the player reads (and can't react because they've
 * exited pointer lock) would be disorienting and unfair. Setting state to
 * 'recap' gates out all gameplay updates in main.js's animate() loop, making
 * the pause authoritative rather than a flag that every system must remember
 * to check independently.
 *
 * Depends on:
 *   - NARRATIVE_API_BASE (defined in narrativeUI.js, loaded before this file)
 *   - Game.telemetry, Game.director, Game.elapsedTime (all available at runtime)
 *   - setGameState() (defined in gamestate.js, loaded before this file)
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
// Client-side fallback — shown only if the backend is completely unreachable.
// This is intentionally different from the server's FALLBACK_RECAP: the
// server fallback is "Granite failed but the server responded"; this fallback
// is "the server itself couldn't be reached." The player must never see a
// blank or broken screen at this specific moment.
// ---------------------------------------------------------------------------

const RECAP_CLIENT_FALLBACK =
  'You made it to the end. The dungeon watched every step — the hesitations, ' +
  'the choices, the moments you moved too quickly or waited too long. ' +
  'It remembers you passed through. That is enough.';

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
 * @returns {object} Stats payload ready for JSON serialisation.
 */
function buildRecapStats() {
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

  const overlay = Game.recap.element;
  if (!overlay) return;

  // Unhide the overlay and show a loading state while the fetch runs.
  overlay.classList.remove('hidden');
  const textEl  = overlay.querySelector('.recap-text');
  const statsEl = overlay.querySelector('.recap-stats');
  if (textEl)  textEl.textContent  = 'The dungeon is remembering\u2026';
  if (statsEl) statsEl.textContent = '';

  // Exit pointer lock so the player can interact with the overlay normally.
  // Game.state is already 'recap', so the pointerlockchange listener in
  // main.js will see it and NOT call setGameState('paused') — the start-overlay
  // will not reappear beneath the recap overlay.
  document.exitPointerLock();

  const stats = buildRecapStats();

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
// initRecap — called once at boot from main.js
// ---------------------------------------------------------------------------

function initRecap() {
  Game.recap.element = document.getElementById('recap-overlay');

  const overlay = Game.recap.element;
  if (!overlay) return;

  // Click anywhere on the overlay to dismiss.
  overlay.addEventListener('click', dismissRecap);
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
    Game.state !== 'recap'
  ) {
    Game.recap.autoShown = true;
    triggerRecap();
  }
}
