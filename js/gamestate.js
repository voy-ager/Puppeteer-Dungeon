/**
 * gamestate.js — Single source of truth for the game's current mode
 *
 * Game.state is the authoritative answer to "what is the game doing right
 * now?" Every other system should READ Game.state rather than maintaining
 * its own independent flag. Only setGameState() may WRITE it.
 *
 * Valid states:
 *   'title'   — start overlay is visible, pointer lock not held, no gameplay
 *   'playing' — pointer lock held, all gameplay systems active
 *   'paused'  — pointer lock released by the player (ESC), start overlay
 *               re-shown as the resume prompt
 *   'recap'   — escaped ending overlay is showing; dismiss re-locks and resumes
 *   'caught'  — caught ending overlay is showing; dismiss reloads the page
 *
 * Why centralise this here?
 * Previously, controls.js and main.js each listened to 'pointerlockchange'
 * independently and toggled separate flags without knowing each other's
 * intent. That caused the start-overlay to incorrectly flash when recap.js
 * deliberately called exitPointerLock() — each new overlay state would have
 * needed its own bespoke guard bolted onto the pointerlockchange handler.
 * A single state string makes the intent explicit and the transitions safe.
 *
 * Depends on:
 *   - audio.js (pauseAudio / resumeAudio must be defined before this file loads)
 *   - DOM elements #start-overlay and #crosshair (queried at call time, not at
 *     load time, so they are always present when setGameState is first called)
 */

// ---------------------------------------------------------------------------
// Game.state — initialised to 'title' at page load
// ---------------------------------------------------------------------------

// 'title' is correct at load: the start overlay is visible, pointer lock is
// not held, and no gameplay is running yet.
Game.state = 'title';

// ---------------------------------------------------------------------------
// setGameState — the only function allowed to write Game.state
// ---------------------------------------------------------------------------

/**
 * Transitions the game to a new state and applies the UI and audio
 * consequences of that transition.
 *
 * This function deliberately handles ONLY the start-overlay / crosshair pair
 * and audio — the two effects whose uncoordinated management caused the
 * original overlay-flash bug. States with dedicated overlays ('recap', and
 * future 'caught'/'escaped') are intentionally left alone here: those modules
 * own their own DOM and must never have start-overlay shown beneath them.
 *
 * @param {string} newState — one of 'title' | 'playing' | 'paused' | 'recap' | 'caught'
 */
function setGameState(newState) {
  Game.state = newState;

  // Query at call time rather than caching at load time. These elements are
  // guaranteed present (they're in the initial HTML), and querying once per
  // transition (rare event) is cheaper than holding a reference that could
  // theoretically become stale if the DOM were rebuilt.
  const overlay  = document.getElementById('start-overlay');
  const crosshair = document.getElementById('crosshair');

  if (newState === 'title' || newState === 'paused') {
    // Show the start overlay as the resume prompt. Pause audio so the
    // ambient drone doesn't keep playing while the game is suspended —
    // having sound continue into a paused state would break immersion and
    // waste CPU on audio processing that nobody is hearing.
    overlay.classList.remove('hidden');
    crosshair.classList.add('hidden');
    pauseAudio();

  } else if (newState === 'playing') {
    // Hide the start overlay and show the crosshair. Resume audio so the
    // drone and any active heartbeat pick up exactly where they left off.
    overlay.classList.add('hidden');
    crosshair.classList.remove('hidden');
    resumeAudio();

  }
  // 'recap' (and future 'caught'/'escaped'): deliberately no action on
  // start-overlay or crosshair. recap.js owns #recap-overlay directly and
  // calls exitPointerLock() itself — the crosshair will hide via the
  // pointerlockchange listener setting Game.controls.enabled = false, which
  // onMouseMove checks. Audio is already paused by the time the player reads
  // the recap because audio.js gameplay updates are gated on Game.state.
  //
  // Note: audio is NOT explicitly suspended on entering 'recap' here because
  // the transition to 'recap' is driven by triggerRecap(), which calls
  // exitPointerLock(). The browser fires pointerlockchange, the consolidated
  // listener in main.js sees Game.state === 'recap' (not 'playing') and does
  // NOT call setGameState('paused'), so no pauseAudio() fires. The ambient
  // drone continuing quietly under the recap overlay is intentional —
  // it keeps the atmosphere present while the player reads. If a deliberate
  // audio-cut on recap entry is ever wanted, add pauseAudio() in this branch.
}
