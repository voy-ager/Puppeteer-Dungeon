/**
 * main.js — Day 14 scope
 *
 * One addition: initNarrativeUI() in the boot sequence, so the subtitle
 * element reference is cached before the Director ever tries to use it.
 *
 * NPC update: initNPC() added to boot sequence; updateNPC(delta) added to
 * the per-frame loop alongside the other update calls.
 */

window.addEventListener('DOMContentLoaded', () => {
  initScene();
  initControls();
  initEnemy();
  initNPC();
  initTelemetry();
  initNarrativeUI();

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
    overlay.classList.toggle('hidden', locked);
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
  });

  animate();
});

function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(Game.clock.getDelta(), 0.1);

  if (Game.controls.enabled) {
    Game.elapsedTime += delta;

    updateControls(delta);
    updateTelemetry(delta);
    updateDirector(delta);
    updateEnemy(delta);
    updateNPC(delta);
    renderDebugOverlay();
  }

  Game.renderer.render(Game.scene, Game.camera);
}