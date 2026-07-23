/**
 * telemetry.js — Week 2, Days 10-11 scope
 *
 * One addition: idleStreak. The existing idleTime is cumulative for the
 * whole session (useful for stats, useless for decisions — once it
 * crosses a threshold it stays crossed forever). idleStreak resets to 0
 * the moment the player moves at speed, so it actually answers "is the
 * player comfortable *right now*," which is what director.js needs.
 *
 * Also extends the debug overlay to show enemy/director state, so you
 * can watch escalation and relief happen live.
 *
 * Noise mechanic (noise-detection update):
 * noiseLevel (0–1) reflects how loudly the player is moving right now.
 * It rises quickly when sprinting, decays slowly when still, and is
 * zeroed while sneaking. director.js compares it against a threshold
 * to trigger noise-based hunts independently of the comfort-based logic.
 */

Game.telemetry = {
  currentRoom: null,
  roomEnterTime: 0,
  visitCounts: {},
  timeInRoom: {},
  totalDistance: 0,
  idleTime: 0, // cumulative, whole session
  idleStreak: 0, // resets on movement — "currently idle for N seconds"
  idleSpeedThreshold: 0.3,
  lastPosition: null,
  enemyDistance: null,
  closeCallThreshold: 2.5,
  closeCallSeconds: 0,
  noiseLevel: 0, // 0–1 signal consumed by director.js for the noise-triggered hunt pathway
};

// How fast the player needs to move (m/s) to reach noiseLevel 1.0.
// Full sprint (~4.5 m/s) maps to ~0.9; a normal walk (~2.5 m/s) maps to
// ~0.5, which is just below the director's noiseTriggerThreshold of 0.6 —
// so walking is safe, sprinting is not (unless sneaking).
const NOISE_SPEED_SCALE = 5.0;

function initTelemetry() {
  Game.telemetry.lastPosition = Game.camera.position.clone();
  Game.telemetry.roomEnterTime = performance.now();
}

function findRoomAt(x, z) {
  for (const room of Game.rooms) {
    if (x >= room.minX && x <= room.maxX && z >= room.minZ && z <= room.maxZ) {
      return room.name;
    }
  }
  return 'corridor';
}

function updateTelemetry(delta) {
  const t = Game.telemetry;
  const pos = Game.camera.position;

  const dx = pos.x - t.lastPosition.x;
  const dz = pos.z - t.lastPosition.z;
  const stepDistance = Math.hypot(dx, dz);
  t.totalDistance += stepDistance;

  const speed = delta > 0 ? stepDistance / delta : 0;
  if (speed < t.idleSpeedThreshold) {
    t.idleTime += delta;
    t.idleStreak += delta;
  } else {
    t.idleStreak = 0;
  }

  // --- Noise level update ---
  // targetNoise is what noiseLevel should converge toward this frame.
  // Sneaking zeros it completely — Shift is the explicit "be quiet" contract,
  // and a partial noise floor while sneaking would undermine the mechanic.
  // At normal speed, target scales linearly with velocity up to 1.0.
  const targetNoise = Game.controls.sneaking
    ? 0
    : Math.min(speed / NOISE_SPEED_SCALE, 1);

  if (targetNoise > t.noiseLevel) {
    // Rise quickly — the player just started moving loudly and the enemy
    // should react fast, not on a delay. Factor 8 reaches ~0.9 of the gap
    // in about 0.3s at 60fps.
    t.noiseLevel += (targetNoise - t.noiseLevel) * 8 * delta;
  } else {
    // Decay slowly — a brief pause doesn't instantly silence the player.
    // Factor 1.5 halves noise in ~0.46s and reaches near-zero in ~2s,
    // giving the enemy a small window to react even after the player stops.
    t.noiseLevel += (targetNoise - t.noiseLevel) * 1.5 * delta;
  }

  // Clamp to [0, 1] — floating-point lerp can drift just outside bounds.
  t.noiseLevel = Math.max(0, Math.min(1, t.noiseLevel));

  const roomHere = findRoomAt(pos.x, pos.z);
  if (roomHere !== t.currentRoom) {
    if (t.currentRoom) {
      const secondsSpent = (performance.now() - t.roomEnterTime) / 1000;
      t.timeInRoom[t.currentRoom] = (t.timeInRoom[t.currentRoom] || 0) + secondsSpent;
    }
    t.visitCounts[roomHere] = (t.visitCounts[roomHere] || 0) + 1;
    t.currentRoom = roomHere;
    t.roomEnterTime = performance.now();
  }

  if (Game.enemy && Game.enemy.mesh) {
    const edx = pos.x - Game.enemy.mesh.position.x;
    const edz = pos.z - Game.enemy.mesh.position.z;
    t.enemyDistance = Math.hypot(edx, edz);
    if (t.enemyDistance < t.closeCallThreshold) {
      t.closeCallSeconds += delta;
    }
  }

  t.lastPosition.copy(pos);
}

function isBacktracking() {
  const t = Game.telemetry;
  return (t.visitCounts[t.currentRoom] || 0) > 1;
}

function renderDebugOverlay() {
  const el = document.getElementById('debug-overlay');
  if (!el || el.classList.contains('hidden')) return;

  const t = Game.telemetry;
  const enemyDist = t.enemyDistance !== null ? t.enemyDistance.toFixed(1) + 'm' : '—';

  el.innerHTML = `
    <div>room: <b>${t.currentRoom || '—'}</b>${isBacktracking() ? ' (revisit)' : ''}</div>
    <div>distance walked: ${t.totalDistance.toFixed(1)}m</div>
    <div>idle streak: ${t.idleStreak.toFixed(1)}s</div>
    <div>noise: ${t.noiseLevel.toFixed(2)}${Game.controls.sneaking ? ' (sneaking)' : ''}</div>
    <div>enemy distance: ${enemyDist}</div>
    <div>close-call time: ${t.closeCallSeconds.toFixed(1)}s</div>
    <div style="margin-top:6px;">enemy state: <b>${Game.enemy.state}</b></div>
    <div>director: ${Game.director.lastEvent || '—'}</div>
    <div style="opacity:0.5; margin-top:6px;">press T to hide</div>
  `;
}