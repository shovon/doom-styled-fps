// The fixtures' light: pools of real lights that follow the nearest strips, ceiling lamps and slits (or, baked)
import './platform.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { scene, stage } from './setup.js';
import { FLOOR_TILES, TILE, FLOOR_LAMP, BAKE_FIXTURES, tilePick, tilePos, bakedUniforms } from './tiles.js';
import { ARENA, WALL_ROWS, wallLamps, ceilLightTiles, slitTiles, columnLamps, towerLamps, platformLamps } from './arena.js';
import { camera } from './camera.js';

// Strip lights: the light tiles' glow on their surroundings. ~2000 light tiles is far too many real lights,
// so a fixed pool follows the nearest ones (fixed count = no shader recompiles), mirrored into the sprite
// stage like the flashes. Each fades out toward the pool's edge (the next-nearest tile left out, or
// STRIP_REACH), so a light handing over to another tile is already at zero: no popping.
export const STRIP_POOL = 8, STRIP_REACH = 14, STRIP_FADE = 4; // lights, metres, metres
// Trying: the floor strips and the lamps light nothing in the world, only glow (emissive + bloom). Their pool still lights
// the demon sprites and the gun.
export const STRIP_LIGHTS_IN_WORLD = false;
export const STRIP_COLOR = 0x96d2ff, STRIP_INTENSITY = 2, STRIP_RANGE = 5, STRIP_HEIGHT = 0.25; // match LIGHT in the generator
const lightType = Object.keys(FLOOR_TILES).indexOf(FLOOR_LAMP);
export const stripTiles = [
  ...tilePick.flatMap((t, cell) => (t === lightType ? [tilePos(cell, STRIP_HEIGHT)] : []))
    .filter((p) => Math.abs(p.x) < ARENA && Math.abs(p.z) < ARENA), // only those inside the arena can be seen
  ...columnLamps,
  ...towerLamps,
  ...wallLamps,
  ...platformLamps,
];
export const stripLights = Array.from({ length: STRIP_POOL }, () => {
  const world = new THREE.PointLight(STRIP_COLOR, 0, STRIP_RANGE, 2);
  const sprite = world.clone();
  if (!BAKE_FIXTURES && STRIP_LIGHTS_IN_WORLD) scene.add(world); // otherwise it only places the gun's copy
  stage.add(sprite);
  return { world, sprite };
});
// Moves a pool of { world, sprite } lights onto the tiles nearest the camera, fading each out toward the
// pool's edge so a light hands over to another tile at zero
export function updatePool(tiles, lights, reach, fade, intensity) {
  const near = [];
  for (const p of tiles) {
    const d = p.distanceTo(camera.position);
    if (d < reach) near.push({ d, p });
  }
  near.sort((a, b) => a.d - b.d);
  const edge = Math.min(reach, near[lights.length]?.d ?? Infinity);
  lights.forEach(({ world, sprite }, i) => {
    const n = near[i];
    if (n) { world.position.copy(n.p); sprite.position.copy(n.p); }
    if (n && n.p.color) { world.color.copy(n.p.color); sprite.color.copy(n.p.color); } // e.g. a ceiling section's
    if (n && world.isSpotLight) { world.target.position.copy(n.p).add(n.p.aim); sprite.target.position.copy(world.target.position); }
    world.intensity = sprite.intensity = n ? intensity * THREE.MathUtils.clamp((edge - n.d) / fade, 0, 1) : 0;
  });
}

// Ceiling lights: rect area lights, the strip's own shape (1.6 × 0.2 m, the lens on the tile), shining down
// only: soft, shaped highlights instead of a point's pinprick. Pricier per pixel than a point light and no
// shadows, so again a pool over the nearest; not in the sprites' light mask (no `distance`), so a demon's
// sprite picks up changes on its next pose step (a still one's: as you move, see STILL_RELIGHT).
// Intensity scales with the ceiling height squared to keep the floor as lit: 120 at 4 m, so 480 at 8 m
export const CEIL_POOL = 8, CEIL_REACH = 20, CEIL_FADE = 6, CEIL_INTENSITY = 120 * (WALL_ROWS * TILE / 4) ** 2;
RectAreaLightUniformsLib.init(); // rect area lights need their lookup tables
const ceilLight = () => {
  const l = new THREE.RectAreaLight(STRIP_COLOR, 0, 1.6, 0.2);
  l.rotation.x = -Math.PI / 2; // it emits along its -Z: straight down, long side along X like the tile
  return l;
};
export const ceilLights = Array.from({ length: CEIL_POOL }, () => {
  const world = ceilLight(), sprite = ceilLight();
  if (!BAKE_FIXTURES) scene.add(world); // baked: only placing the gun's copy
  stage.add(sprite);
  return { world, sprite };
});

// Column slit lights: spot lights (a cone, like a downlight or uplight) at the columns' slits, aimed down from the
// ceiling slits and up from the floor ones, a little outward. 40 slits, so again a pool over the nearest, mirrored
// into the sprite stage (and the gun). Each spot costs ~1.8 ms/frame at 1600×1000, hence 8: one column's set.
export const SPOT_POOL = 8, SPOT_REACH = 24, SPOT_FADE = 6, SPOT_INTENSITY = 40; // lights (a whole column's 8 slits), m, m, candela
// Like the floor strips: the column slits light nothing in the world, only glow (emissive + bloom); their pool
// still lights the demon sprites and the gun.
const SLIT_LIGHTS_IN_WORLD = false;
// Point mode: a point light 0.45 m further out from the face instead of an aimed cone
export const spotLight = () => (BAKE_FIXTURES
  ? new THREE.SpotLight(STRIP_COLOR, 0, 14, Math.PI / 5, 0.6, 2) // range 14 m, 36° cone, soft edge
  : new THREE.PointLight(STRIP_COLOR, 0, 14, 2));
export const spotPoolTiles = BAKE_FIXTURES ? slitTiles
  : slitTiles.map((p) => p.clone().addScaledVector(new THREE.Vector3(p.aim.x, 0, p.aim.z).normalize(), 0.45));
export const spotLights = Array.from({ length: SPOT_POOL }, () => {
  const world = spotLight(), sprite = spotLight();
  if (!BAKE_FIXTURES && SLIT_LIGHTS_IN_WORLD) scene.add(world); // otherwise it only places the gun's copy
  stage.add(sprite);
  if (sprite.target) stage.add(sprite.target); // a spot's target must be in the scene to follow its position
  return { world, sprite };
});

// The bake (see addBakedLight): every static fixture's light summed into a volume over the arena (2·ARENA × 8 × 2·ARENA m) in 0.5 m cells, with
// the same falloff three.js uses (1/d², windowed to zero at the range), spot cones, and the ceiling's area lights
// as small down-facing (cosine) emitters along each strip. Per cell: rgb = Σ light × direction to it, a = Σ light.
// Done at load, since the floor's light tiles are placed at random. Each source only touches cells within its reach.
// No occlusion: light passes through the columns. The main scene keeps only the muzzle flashes and the portals' lights
// (see portalLights) as real lights; the
// pools above stay for the sprite stage and the gun, which are drawn small and cheap.
if (BAKE_FIXTURES) {
  const CELL = 0.5, W = (2 * ARENA) / CELL, H = (WALL_ROWS * TILE) / CELL, D = W;
  const origin = new THREE.Vector3(-ARENA, 0, -ARENA), acc = new Float32Array(W * H * D * 4);
  const sources = [
    ...stripTiles.filter((p) => Math.abs(p.x) < ARENA && Math.abs(p.z) < ARENA) // the floor strips (inside the arena) and the lamps
      .map((p) => ({ p, I: STRIP_INTENSITY, range: STRIP_RANGE })),
    ...ceilLightTiles.flatMap((p) => [-0.6, 0, 0.6].map((o) => ({ // 1.6 × 0.2 m at CEIL_INTENSITY nits, in 3 pieces
      p: p.clone().setX(p.x + o), I: (CEIL_INTENSITY * 1.6 * 0.2) / 3, range: 16, axis: new THREE.Vector3(0, -1, 0), lambert: true }))),
    ...slitTiles.map((p) => ({ p, I: SPOT_INTENSITY, range: 14, axis: p.aim.clone().normalize(),
      cone: [Math.cos(Math.PI / 5), Math.cos((Math.PI / 5) * (1 - 0.6))] })), // the spotLight() cone and penumbra
  ];
  const t0 = performance.now(), L = new THREE.Vector3();
  for (const { p, I, range, axis, lambert, cone } of sources) {
    const lo = (v, o) => Math.max(Math.floor((v - range - o) / CELL), 0), hi = (v, o, n) => Math.min(Math.ceil((v + range - o) / CELL), n - 1);
    for (let z = lo(p.z, origin.z); z <= hi(p.z, origin.z, D); z++)
      for (let y = lo(p.y, 0); y <= hi(p.y, 0, H); y++)
        for (let x = lo(p.x, origin.x); x <= hi(p.x, origin.x, W); x++) {
          L.set(p.x - (origin.x + (x + 0.5) * CELL), p.y - (y + 0.5) * CELL, p.z - (origin.z + (z + 0.5) * CELL));
          const d = L.length();
          if (d >= range) continue;
          L.divideScalar(d); // cell → light
          let e = (I / Math.max(d * d, 0.12)) * (1 - (d / range) ** 4) ** 2; // floor of ~0.35 m: no pinprick hot cells
          if (axis) {
            const c = -L.dot(axis); // cosine between the light's aim and the cell
            if (lambert) e *= Math.max(c, 0);
            if (cone) e *= THREE.MathUtils.smoothstep(c, cone[0], cone[1]);
          }
          if (e <= 0) continue;
          const i = 4 * (x + W * (y + H * z));
          acc[i] += e * L.x; acc[i + 1] += e * L.y; acc[i + 2] += e * L.z; acc[i + 3] += e;
        }
  }
  const half = new Uint16Array(acc.length);
  for (let i = 0; i < acc.length; i++) half[i] = THREE.DataUtils.toHalfFloat(acc[i]);
  const tex = new THREE.Data3DTexture(half, W, H, D);
  Object.assign(tex, { format: THREE.RGBAFormat, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    unpackAlignment: 1, needsUpdate: true });
  bakedUniforms.bakedLight.value = tex;
  bakedUniforms.bakedOrigin.value.copy(origin);
  bakedUniforms.bakedSize.value.set(2 * ARENA, WALL_ROWS * TILE, 2 * ARENA);
  bakedUniforms.bakedColor.value.set(STRIP_COLOR);
  console.info(`baked ${sources.length} fixture lights into ${W}×${H}×${D} cells in ${(performance.now() - t0).toFixed(0)} ms`);
}

