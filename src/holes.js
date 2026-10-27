// Bullet holes in the arena; where a ray hits the world (rayWorld)
import './blood-sheets.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { scene } from './setup.js';
import { TILE, ONE, AXIS_Z, randomTurn } from './tiles.js';
import { ARENA, WALL_ROWS, COLUMNS, COLUMN_APOTHEM, rayTowers, PLATFORM_H, PLATFORM_APOTHEM, PLATFORM_FACES,
  STAIR_PIECES, BALCONY_PIECES, rayConvex } from './arena.js';

// Bullet holes: a shot that misses the demons leaves a hole where it hits the arena (rayWorld). Each is a small lit
// quad on the surface, drawn on its panel's pixel grid (32 px/m; HOLE_PX px square, centred on a pixel): a ragged
// black hole, a rim of bare steel pushed up round it (metal, glossy: it catches the lights and muzzle flashes, so it
// glints in the dark rather than glowing), and a dull scorch ring, dithered, fading into the panel. A ring of
// HOLE_MAX, oldest replaced.
const HOLE_MAX = 512, HOLE_PX = 9; // holes; px across a hole's quad (odd, so the hole sits on a pixel)
const HOLE_SIZE = HOLE_PX / 32; // m
const holeGeo = new THREE.PlaneGeometry(HOLE_SIZE, HOLE_SIZE); // faces +Z
const holeSeed = new THREE.InstancedBufferAttribute(new Float32Array(HOLE_MAX), 1);
holeGeo.setAttribute('aSeed', holeSeed);
const holeMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, transparent: true, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
holeMat.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aSeed;\nvarying vec2 vHoleUv;\nvarying float vHoleSeed;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vHoleUv = uv; vHoleSeed = aSeed;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec2 vHoleUv;
varying float vHoleSeed;
float holeHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + vHoleSeed) * 43758.5453); }`)
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  {
    vec2 px = floor(vHoleUv * ${HOLE_PX.toFixed(1)}); // the panel's pixels
    vec2 c = px - ${((HOLE_PX - 1) / 2).toFixed(1)};
    float r = length(c) + 0.5 * (holeHash(px) - 0.5); // ragged
    float dith = mod(px.x + px.y, 2.0);
    if (r < 1.0) {        // the hole: nothing comes back out of it
      diffuseColor = vec4(0.0, 0.0, 0.0, 1.0); metalnessFactor = 0.0; roughnessFactor = 1.0;
    } else if (r < 2.0) { // the rim: bare steel pushed up, bright and glossy (a pixel here and there torn away)
      if (holeHash(px + 7.0) < 0.15) discard;
      diffuseColor = vec4(vec3(0.75), 1.0); metalnessFactor = 1.0; roughnessFactor = 0.25;
    } else if (r < 3.4) { // the scorch: dull, dark, dithered as it fades out
      if ((r > 2.7 && dith > 0.5) || holeHash(px + 13.0) < 0.2) discard;
      diffuseColor = vec4(vec3(0.04, 0.035, 0.03), 0.85); metalnessFactor = 0.0; roughnessFactor = 0.9;
    } else discard;
  }`);
};
const holes = new THREE.InstancedMesh(holeGeo, holeMat, HOLE_MAX);
holes.count = 0;
holes.frustumCulled = false;
scene.add(holes);
let holeNext = 0;
const _hm = new THREE.Matrix4(), _hq = new THREE.Quaternion(), _hz = new THREE.Vector3(0, 0, 1), _hp = new THREE.Vector3();
export function spawnHole(at, normal) {
  const i = holeNext++ % HOLE_MAX;
  // centred on a panel pixel (the grid is 1/32 m on every axis-aligned surface), a hair off the surface
  _hp.set(...[at.x, at.y, at.z].map((v, a) => (normal.getComponent(a) !== 0 ? v : (Math.floor(v * 32) + 0.5) / 32))).addScaledVector(normal, 0.003);
  _hq.setFromUnitVectors(_hz, normal).multiply(randomTurn(AXIS_Z, 4)); // quarter turns keep it on the pixel grid
  holes.setMatrixAt(i, _hm.compose(_hp, _hq, ONE));
  holeSeed.array[i] = Math.random() * 100;
  holes.count = Math.min(holeNext, HOLE_MAX);
  holes.instanceMatrix.needsUpdate = holeSeed.needsUpdate = true;
}
// Where a ray (origin o, direction dir) first hits the arena itself: the floor, the ceiling, the walls, a column or
// the centre platform. Returns { t, normal } (normal: the surface's, facing back at the ray) or null.
export function rayOctagon(o, dir, cx, cz, apothem, height) { // an octagonal prism (faces as PLATFORM_FACES) on the floor
  let tIn = -Infinity, tOut = Infinity, nIn = null;
  const clip = (den, num, n) => { // the half-space n·(o + t dir) ≤ k: den = n·dir, num = k − n·o
    if (Math.abs(den) < 1e-9) { if (num < 0) tIn = Infinity; } else if (den > 0) tOut = Math.min(tOut, num / den);
    else if (num / den > tIn) { tIn = num / den; nIn = n; }
  };
  for (const f of PLATFORM_FACES) clip(f.x * dir.x + f.y * dir.z, apothem - (f.x * (o.x - cx) + f.y * (o.z - cz)), [f.x, 0, f.y]);
  clip(dir.y, height - o.y, [0, 1, 0]); clip(-dir.y, o.y, [0, -1, 0]);
  return tIn <= tOut && tIn > 0 && nIn ? { t: tIn, normal: new THREE.Vector3(...nIn) } : null;
}
export function rayWorld(o, dir) {
  const H = WALL_ROWS * TILE;
  let best = null;
  const take = (t, nx, ny, nz) => { if (t > 0 && (!best || t < best.t)) best = { t, normal: new THREE.Vector3(nx, ny, nz) }; };
  if (dir.y < 0) take(-o.y / dir.y, 0, 1, 0); else if (dir.y > 0) take((H - o.y) / dir.y, 0, -1, 0);
  if (dir.x > 0) take((ARENA - o.x) / dir.x, -1, 0, 0); else if (dir.x < 0) take((-ARENA - o.x) / dir.x, 1, 0, 0);
  if (dir.z > 0) take((ARENA - o.z) / dir.z, 0, 0, -1); else if (dir.z < 0) take((-ARENA - o.z) / dir.z, 0, 0, 1);
  for (const c of COLUMNS) { const h = rayOctagon(o, dir, c.x, c.y, COLUMN_APOTHEM, H); if (h && (!best || h.t < best.t)) best = h; }
  for (const h of [rayOctagon(o, dir, 0, 0, PLATFORM_APOTHEM, PLATFORM_H), ...[...STAIR_PIECES, ...BALCONY_PIECES].map((p) => rayConvex(o, dir, p)), rayTowers(o, dir)])
    if (h && (!best || h.t < best.t)) best = h;
  return best;
}

