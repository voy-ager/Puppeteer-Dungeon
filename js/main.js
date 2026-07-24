/**
 * main.js — Day 14 scope
 *
 * One addition: initNarrativeUI() in the boot sequence, so the subtitle
 * element reference is cached before the Director ever tries to use it.
 *
 * NPC update: initNPC() added to boot sequence; updateNPC(delta) added to
 * the per-frame loop alongside the other update calls.
 *
 * Recap update: initRecap() added to boot sequence; checkRecapAutoTrigger()
 * called every frame; gameplay updates gated on !Game.recap.active so the
 * game visibly pauses while the player reads the recap overlay.
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
  const crosshair = document.getElementById('crosshair');
  const debugOverlay = document.getElementById('debug-overlay');

  overlay.addEventListener('click', () => {
    // initAudio() must be called inside a user-gesture handler — browsers
    // block AudioContext creation before any interaction. The overlay click
    // is the natural trigger since it's the first deliberate action the player
    // takes. initAudio() is a no-op on subsequent clicks (guards on ctx).
    initAudio();
    Game.renderer.domElement.requestPointerLock();
  });

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === Game.renderer.domElement;
    // Only toggle the start-overlay when the recap isn't active.
    // triggerRecap() calls document.exitPointerLock() deliberately — without
    // this guard the start-overlay would reappear underneath the recap overlay.
    if (!Game.recap.active) {
      overlay.classList.toggle('hidden', locked);
    }
    crosshair.classList.toggle('hidden', !locked);
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

  if (Game.controls.enabled && !Game.recap.active) {
    // Gameplay updates are gated on both pointer-lock state AND recap state.
    // While the recap overlay is showing the game world is effectively paused —
    // enemy movement, telemetry, and the Director all hold their last state.
    Game.elapsedTime += delta;

    updateControls(delta);
    updateTelemetry(delta);
    updateDirector(delta);
    updateEnemy(delta);
    updateNPC(delta);
    renderDebugOverlay();
  }

  // checkRecapAutoTrigger runs outside the gameplay gate — it needs to fire
  // even before pointer lock is acquired (won't trigger in practice since
  // currentRoom stays null until the player enters the dungeon, but keeping
  // it unconditional is simpler than tracking an extra condition here).
  checkRecapAutoTrigger();

  Game.renderer.render(Game.scene, Game.camera);
}