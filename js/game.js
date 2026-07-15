/**
 * game.js — Week 2 scope (Telemetry prep)
 *
 * Changes from Days 4-5:
 *   1. Flashlight target lifted further (0.2 -> 0.35) per your feedback —
 *      more of the corridor walls are lit at eye level now
 *   2. buildRoomShell now takes a `name` and registers each room's
 *      bounds in Game.rooms — this is the lookup table telemetry.js
 *      uses to know which room the player is currently standing in
 */

const WALL_HEIGHT = 4;
const WALL_THICKNESS = 0.3;

const wallMaterial = new THREE.MeshStandardMaterial({
  color: 0x2a2823,
  roughness: 0.92,
  metalness: 0.02,
});
const floorMaterial = new THREE.MeshStandardMaterial({
  color: 0x1c1a17,
  roughness: 0.95,
});
const ceilingMaterial = new THREE.MeshStandardMaterial({
  color: 0x08080a,
  roughness: 1,
});

const Game = {
  scene: null,
  camera: null,
  renderer: null,
  clock: new THREE.Clock(),
  elapsedTime: 0, 
  colliders: [], // 2D (X/Z) bounding boxes for every wall segment
  rooms: [], // { name, minX, maxX, minZ, maxZ } — used by telemetry.js
};

function initScene() {
  Game.scene = new THREE.Scene();
  Game.scene.fog = new THREE.FogExp2(0x030302, 0.075);

  Game.camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  Game.camera.position.set(0, 1.6, 3);
  Game.scene.add(Game.camera);

  Game.renderer = new THREE.WebGLRenderer({ antialias: true });
  Game.renderer.setSize(window.innerWidth, window.innerHeight);
  Game.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  Game.renderer.shadowMap.enabled = true;
  Game.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  Game.renderer.outputEncoding = THREE.sRGBEncoding;
  document.body.appendChild(Game.renderer.domElement);

  const ambient = new THREE.AmbientLight(0x0d0d14, 0.35);
  Game.scene.add(ambient);

  const flashlight = new THREE.SpotLight(0xfff2d9, 2.6, 17, Math.PI / 5, 0.4, 1.6);
  flashlight.castShadow = true;
  flashlight.shadow.mapSize.set(1024, 1024);
  flashlight.shadow.camera.near = 0.5;
  flashlight.shadow.camera.far = 18;
  Game.camera.add(flashlight);

  const flashlightTarget = new THREE.Object3D();
  // y raised again: 0.2 -> 0.35 (~19 degrees upward from level) so the
  // beam catches corridor walls at eye height, not mostly the floor.
  flashlightTarget.position.set(0, 0.35, -1);
  Game.camera.add(flashlightTarget);
  flashlight.target = flashlightTarget;

  buildDungeon();

  window.addEventListener('resize', onWindowResize);
}

function buildDungeon() {
  const doorWidth = 3;

  buildRoomShell(0, 0, 10, 10, { north: { width: doorWidth, center: 0 } }, 'entry_hall');
  buildCorridorZ(0, -5, -11, doorWidth);

  buildRoomShell(
    0,
    -15,
    8,
    8,
    { south: { width: doorWidth, center: 0 }, north: { width: doorWidth, center: 0 } },
    'room_2'
  );
  buildCorridorZ(0, -19, -23, doorWidth);

  buildRoomShell(
    0,
    -27,
    8,
    8,
    { south: { width: doorWidth, center: 0 }, north: { width: doorWidth, center: 0 } },
    'room_3'
  );
  buildCorridorZ(0, -31, -34.5, doorWidth);

  buildRoomShell(0, -39, 9, 9, { south: { width: doorWidth, center: 0 } }, 'final_chamber');

  const crate = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x3a2f22, roughness: 0.8 })
  );
  crate.position.set(2, 0.5, -2);
  crate.castShadow = true;
  crate.receiveShadow = true;
  Game.scene.add(crate);
}

/**
 * Builds a rectangular room and registers its bounds under `name` in
 * Game.rooms — telemetry.js uses this list to detect which room the
 * player is currently standing in.
 */
function buildRoomShell(cx, cz, sizeX, sizeZ, doors = {}, name = null) {
  const halfX = sizeX / 2;
  const halfZ = sizeZ / 2;

  Game.rooms.push({
    name: name || `room_${Game.rooms.length + 1}`,
    minX: cx - halfX,
    maxX: cx + halfX,
    minZ: cz - halfZ,
    maxZ: cz + halfZ,
  });

  addFloorCeiling(cx, cz, sizeX, sizeZ);

  buildWallRun('x', cz - halfZ, cx - halfX, cx + halfX, doors.north);
  buildWallRun('x', cz + halfZ, cx - halfX, cx + halfX, doors.south);
  buildWallRun('z', cx - halfX, cz - halfZ, cz + halfZ, doors.west);
  buildWallRun('z', cx + halfX, cz - halfZ, cz + halfZ, doors.east);
}

function buildCorridorZ(centerX, zFrom, zTo, width) {
  const length = Math.abs(zTo - zFrom);
  const cz = (zFrom + zTo) / 2;

  addFloorCeiling(centerX, cz, width, length);

  const zMin = Math.min(zFrom, zTo);
  const zMax = Math.max(zFrom, zTo);
  addWallSegment('z', centerX - width / 2, zMin, zMax);
  addWallSegment('z', centerX + width / 2, zMin, zMax);
}

function addFloorCeiling(cx, cz, sizeX, sizeZ) {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(sizeX, sizeZ), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.receiveShadow = true;
  Game.scene.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(sizeX, sizeZ), ceilingMaterial);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(cx, WALL_HEIGHT, cz);
  ceiling.receiveShadow = true;
  Game.scene.add(ceiling);
}

function buildWallRun(axis, fixed, rangeStart, rangeEnd, door) {
  if (!door) {
    addWallSegment(axis, fixed, rangeStart, rangeEnd);
    return;
  }

  const gapStart = door.center - door.width / 2;
  const gapEnd = door.center + door.width / 2;

  if (gapStart > rangeStart) addWallSegment(axis, fixed, rangeStart, gapStart);
  if (gapEnd < rangeEnd) addWallSegment(axis, fixed, gapEnd, rangeEnd);
}

function addWallSegment(axis, fixed, from, to) {
  const length = to - from;
  if (length <= 0.01) return;

  const center = (from + to) / 2;
  let mesh, box;

  if (axis === 'x') {
    mesh = new THREE.Mesh(
      new THREE.BoxGeometry(length, WALL_HEIGHT, WALL_THICKNESS),
      wallMaterial
    );
    mesh.position.set(center, WALL_HEIGHT / 2, fixed);
    box = {
      minX: center - length / 2,
      maxX: center + length / 2,
      minZ: fixed - WALL_THICKNESS / 2,
      maxZ: fixed + WALL_THICKNESS / 2,
    };
  } else {
    mesh = new THREE.Mesh(
      new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, length),
      wallMaterial
    );
    mesh.position.set(fixed, WALL_HEIGHT / 2, center);
    box = {
      minX: fixed - WALL_THICKNESS / 2,
      maxX: fixed + WALL_THICKNESS / 2,
      minZ: center - length / 2,
      maxZ: center + length / 2,
    };
  }

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  Game.scene.add(mesh);
  Game.colliders.push(box);
}

function onWindowResize() {
  Game.camera.aspect = window.innerWidth / window.innerHeight;
  Game.camera.updateProjectionMatrix();
  Game.renderer.setSize(window.innerWidth, window.innerHeight);
}