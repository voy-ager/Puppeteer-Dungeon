/**
 * controls.js — Days 4-5 scope
 *
 * Same mouse-look and WASD movement as Days 2-3. What's new: real wall
 * collision against Game.colliders (populated by game.js while building
 * the dungeon) instead of clamping to one rectangle. Movement is resolved
 * per-axis (X then Z) so the player slides along a wall instead of
 * stopping dead when approaching it at an angle.
 */

Game.controls = {
  enabled: false,
  yaw: 0,
  pitch: 0,
  velocity: new THREE.Vector3(),
  move: { forward: false, backward: false, left: false, right: false },
  sensitivity: 0.0022,
  speed: 4.5,
  playerRadius: 0.35,
};

function initControls() {
  Game.camera.rotation.order = 'YXZ';

  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('keydown', (e) => setMoveState(e.code, true));
  document.addEventListener('keyup', (e) => setMoveState(e.code, false));
}

function onPointerLockChange() {
  Game.controls.enabled = document.pointerLockElement === Game.renderer.domElement;
}

function onMouseMove(event) {
  if (!Game.controls.enabled) return;

  Game.controls.yaw -= event.movementX * Game.controls.sensitivity;
  Game.controls.pitch -= event.movementY * Game.controls.sensitivity;

  const maxPitch = Math.PI / 2 - 0.05;
  Game.controls.pitch = Math.max(-maxPitch, Math.min(maxPitch, Game.controls.pitch));

  Game.camera.rotation.x = Game.controls.pitch;
  Game.camera.rotation.y = Game.controls.yaw;
}

function setMoveState(code, isDown) {
  switch (code) {
    case 'KeyW':
    case 'ArrowUp':
      Game.controls.move.forward = isDown;
      break;
    case 'KeyS':
    case 'ArrowDown':
      Game.controls.move.backward = isDown;
      break;
    case 'KeyA':
    case 'ArrowLeft':
      Game.controls.move.left = isDown;
      break;
    case 'KeyD':
    case 'ArrowRight':
      Game.controls.move.right = isDown;
      break;
  }
}

/** True if a circle at (x, z) with the given radius overlaps an axis-aligned box. */
function circleIntersectsBox(x, z, radius, box) {
  const closestX = Math.max(box.minX, Math.min(x, box.maxX));
  const closestZ = Math.max(box.minZ, Math.min(z, box.maxZ));
  const dx = x - closestX;
  const dz = z - closestZ;
  return dx * dx + dz * dz < radius * radius;
}

function collidesAt(x, z) {
  const r = Game.controls.playerRadius;
  for (let i = 0; i < Game.colliders.length; i++) {
    if (circleIntersectsBox(x, z, r, Game.colliders[i])) return true;
  }
  return false;
}

function updateControls(delta) {
  const { move, yaw, velocity } = Game.controls;

  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

  const wish = new THREE.Vector3();
  if (move.forward) wish.add(forward);
  if (move.backward) wish.sub(forward);
  if (move.right) wish.add(right);
  if (move.left) wish.sub(right);
  if (wish.lengthSq() > 0) wish.normalize();

  const acceleration = 40;
  const damping = 8;

  velocity.x += wish.x * acceleration * delta;
  velocity.z += wish.z * acceleration * delta;
  velocity.x -= velocity.x * damping * delta;
  velocity.z -= velocity.z * damping * delta;

  const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
  if (horizontalSpeed > Game.controls.speed) {
    const scale = Game.controls.speed / horizontalSpeed;
    velocity.x *= scale;
    velocity.z *= scale;
  }

  // Resolve movement one axis at a time. This is the standard trick for
  // simple wall-sliding: if moving diagonally into a wall gets blocked on
  // X, the Z portion of the movement can still succeed independently,
  // so the player slides along the wall instead of stopping outright.
  const pos = Game.camera.position;

  const nextX = pos.x + velocity.x * delta;
  if (!collidesAt(nextX, pos.z)) {
    pos.x = nextX;
  } else {
    velocity.x = 0;
  }

  const nextZ = pos.z + velocity.z * delta;
  if (!collidesAt(pos.x, nextZ)) {
    pos.z = nextZ;
  } else {
    velocity.z = 0;
  }
}