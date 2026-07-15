/**
 * main.js — Week 2, Days 10-11 scope
 *
 * Adds updateDirector(delta) to the loop, and accumulates Game.elapsedTime.
 * Order matters here: telemetry must be updated before the Director reads
 * it, and the Director must decide before the enemy moves, so the enemy
 * acts on the current frame's decision rather than lagging a frame behind.
 */

window.addEventListener('DOMContentLoaded', () => {
  initScene();
  initControls();
  initEnemy();
  initTelemetry();

  const overlay = document.getElementById('start-overlay');
  const crosshair = document.getElementById('crosshair');
  const debugOverlay = document.getElementById('debug-overlay');

  overlay.addEventListener('click', () => {
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
    renderDebugOverlay();
  }

  Game.renderer.render(Game.scene, Game.camera);
}