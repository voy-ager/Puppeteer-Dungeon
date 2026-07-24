/**
 * main.js — Game state machine integration
 *
 * The consolidated pointerlockchange listener here is the single place that
 * reacts to pointer-lock events. It sets Game.controls.enabled and calls
 * setGameState() (defined in gamestate.js), so controls.js, recap.js, and
 * all future overlay modules never need their own competing listeners.
 *
 * Gameplay gate in animate() is now simply `Game.state === 'playing'`,
 * replacing the previous two-flag check (Game.controls.enabled &&
 * !Game.recap.active). All state-change consequences (overlay visibility,
 * audio, crosshair) flow through setGameState().
 */

window.addEventListener('DOMContentLoaded', () => {
  initScene();
  initControls();
  initEnemy();
  initNPC();
  initTelemetry();
  initNarrativeUI();
  initRecap();

  const overlay = document.getElementById('start-overlay');
  // Note: crosshair is NOT declared here. setGameState() in gamestate.js
  // queries #crosshair directly, so declaring it here too would be misleading —
  // main.js is no longer the owner of that element.
  const debugOverlay = document.getElementById('debug-overlay');

  overlay.addEventListener('click', () => {
    // initAudio() must be called inside a user-gesture handler — browsers
    // block AudioContext creation before any interaction. The overlay click
    // is the natural trigger since it's the first deliberate action the player
    // takes. initAudio() is a no-op on subsequent clicks (guards on ctx).
    initAudio();
    // Guard against requesting pointer lock when already playing — e.g. if
    // the overlay somehow receives a click while lock is held. Redundant lock
    // requests are harmless but the guard makes the intent explicit.
    if (Game.state !== 'playing') {
      Game.renderer.domElement.requestPointerLock();
    }
  });

  // ---------------------------------------------------------------------------
  // Single authoritative pointerlockchange listener
  //
  // This is the ONLY place that reacts to pointer-lock events. controls.js
  // previously had its own listener that set Game.controls.enabled; that
  // duplicate has been removed. All state transitions and their UI/audio
  // consequences flow through setGameState() in gamestate.js.
  // ---------------------------------------------------------------------------
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === Game.renderer.domElement;

    // Keep Game.controls.enabled in sync — onMouseMove and updateControls
    // still gate on this flag directly for per-frame performance reasons.
    Game.controls.enabled = locked;

    if (locked) {
      // Lock was just granted. Transition to 'playing' only from states that
      // are explicitly waiting for a lock to begin or resume gameplay.
      // 'recap' is included because recap.js's dismissRecap() requests a new
      // lock without calling setGameState itself — the actual transition to
      // 'playing' is deferred until the browser confirms the lock here.
      if (Game.state === 'title' || Game.state === 'paused' || Game.state === 'recap') {
        setGameState('playing');
      }
    } else {
      // Lock was lost. Only auto-pause if we were actively playing.
      // This is the critical guard that fixes the original overlay-flash bug:
      // if we're in 'recap' (or future 'caught'/'escaped'), the lock loss was
      // caused BY that state's own code calling exitPointerLock() intentionally —
      // not by the player pressing ESC to pause — so we must NOT overwrite
      // that state here.
      if (Game.state === 'playing') {
        setGameState('paused');
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyT') {
      debugOverlay.classList.toggle('hidden');
    }
    // 'O' toggles the Director on/off for the demo comparison recording.
    // The enemy keeps its current state when toggled off — no forced reset —
    // so the "disabled" recording shows the raw baseline from that moment.
    if (e.code === 'KeyO') {
      Game.director.enabled = !Game.director.enabled;
      console.log(`[Director] toggled ${Game.director.enabled ? 'ON' : 'OFF'}`);
    }
    // 'R' manually triggers the recap at any time — useful for demo recordings
    // and for testing the overlay without waiting for final_chamber.
    if (e.code === 'KeyR') {
      triggerRecap();
    }
    // ESC dismisses the recap overlay if it's showing. The browser also fires
    // ESC to release pointer lock, which the pointerlockchange handler already
    // handles; this ensures the overlay itself is hidden in the same keypress.
    if (e.code === 'Escape') {
      dismissRecap();
    }
  });

  animate();
});

function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(Game.clock.getDelta(), 0.1);

  if (Game.state === 'playing') {
    // Single state check replaces the previous two-flag test
    // (Game.controls.enabled && !Game.recap.active). Game.state === 'playing'
    // is true if and only if pointer lock is held AND no overlay is active —
    // the consolidated pointerlockchange listener above ensures this invariant.
    Game.elapsedTime += delta;

    updateControls(delta);
    updateTelemetry(delta);
    updateDirector(delta);
    updateEnemy(delta);
    updateNPC(delta);
    renderDebugOverlay();
  }

  // checkRecapAutoTrigger runs outside the gameplay gate — it needs to fire
  // even when gameplay is paused (the trigger condition is a room check, not
  // a movement check; keeping it unconditional is simpler than tracking an
  // extra condition here and has no correctness risk since triggerRecap()
  // itself guards against double-triggering via the Game.state check).
  checkRecapAutoTrigger();

  Game.renderer.render(Game.scene, Game.camera);
}