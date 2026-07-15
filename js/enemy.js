/**
 * enemy.js — Week 2, Days 10-11 scope
 *
 * Movement now branches on enemy.state:
 *   - 'patrol' : the same fixed waypoint loop from Days 4-5
 *   - 'hunt'   : moves directly toward the player's current position,
 *                faster than patrol speed
 *
 * Important design choice: enemy.js still owns all movement logic.
 * director.js only ever flips enemy.state — it never touches position
 * directly. That separation is what keeps the Director "just a decision
 * maker" instead of a tangle of movement code spread across two files.
 */

Game.enemy = {
  mesh: null,
  waypoints: [],
  currentWaypointIndex: 0,
  speed: 1.4, // patrol speed, m/s
  huntSpeedMultiplier: 1.8, // hunt speed = speed * this
  state: 'patrol', // 'patrol' | 'hunt' — set by director.js
};

function initEnemy() {
  const material = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.95 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 1.4, 8), material);
  body.position.y = 0.9;
  body.castShadow = true;

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 8), material);
  head.position.y = 1.75;
  head.castShadow = true;

  const group = new THREE.Group();
  group.add(body);
  group.add(head);

  Game.enemy.mesh = group;

  Game.enemy.waypoints = [
    new THREE.Vector3(0, 0, -15),
    new THREE.Vector3(3, 0, -15),
    new THREE.Vector3(3, 0, -18.5),
    new THREE.Vector3(-3, 0, -18.5),
    new THREE.Vector3(-3, 0, -15),
  ];

  group.position.copy(Game.enemy.waypoints[0]);
  Game.scene.add(group);
}

function updateEnemy(delta) {
  const enemy = Game.enemy;
  if (!enemy.mesh) return;

  if (enemy.state === 'hunt') {
    huntTowardPlayer(delta);
  } else {
    patrolWaypoints(delta);
  }
}

function patrolWaypoints(delta) {
  const enemy = Game.enemy;
  if (enemy.waypoints.length === 0) return;

  const target = enemy.waypoints[enemy.currentWaypointIndex];
  const pos = enemy.mesh.position;

  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);

  if (dist < 0.15) {
    enemy.currentWaypointIndex = (enemy.currentWaypointIndex + 1) % enemy.waypoints.length;
    return;
  }

  const step = Math.min(enemy.speed * delta, dist);
  pos.x += (dx / dist) * step;
  pos.z += (dz / dist) * step;
  enemy.mesh.rotation.y = Math.atan2(dx, dz);
}

function huntTowardPlayer(delta) {
  const enemy = Game.enemy;
  const pos = enemy.mesh.position;
  const target = Game.camera.position;

  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.05) return;

  const huntSpeed = enemy.speed * enemy.huntSpeedMultiplier;
  const step = Math.min(huntSpeed * delta, dist);
  pos.x += (dx / dist) * step;
  pos.z += (dz / dist) * step;
  enemy.mesh.rotation.y = Math.atan2(dx, dz);
}