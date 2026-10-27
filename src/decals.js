// Blood stains as stickers: where thrown blood lands, a splat
import './weapons.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { renderer, scene } from './setup.js';
import { AXIS_Y } from './tiles.js';
import { STRINGER_D, BALCONY_Y, overDeck, floorAt } from './arena.js';
import { BLOOD_PX, onPlatformTop, onBloodFloor, wallBloodAt, stampBlood, stampTopBlood, stampWallBlood } from './blood-maps.js';
import { bloodTime } from './blood-sheets.js';

// Stains: where a blob of thrown blood lands (some of each stream's), it leaves a splat. The pattern is a single
// drop's impact: a wobbly round body, streaks breaking off
// its rim (the crown's fingers), a droplet on each tip and satellites flung beyond, drawn as a signed-distance
// shape on the floor's pixel grid (32 px/m). Faster impacts spread wider; a slanted one on the floor stretches along
// its travel (width / length = sin(impact angle)) with a tail out the leading end. It spreads in DECAL_SPREAD s,
// then dries over DECAL_DRY s, wet red to dark brown-red with the rim darkening first (the coffee-ring effect). On
// a wall or column the stain runs: a drip grows down, fast then slowing, ending in a bead. Multiply-blended, so a
// stain tints what's under it and is lit by whatever lights that: deep red under sa light, unseen in the dark.
// The colour of wet blood: the stains' tint (they multiply what's under them) and, times BLOOD_UNDER, the airborne
// blood's, so blood in the air and blood on the floor are the same red. Only the colour is shared: a stain is lit by
// the shiny floor under it, the airborne blood as a matte drop, so BLOOD_UNDER is set by eye (measured on screen: at
// 1.0 the two come out about equally bright)
export const BLOOD_WET = [0.62, 0.04, 0.06], BLOOD_DRY = [0.28, 0.035, 0.035], BLOOD_UNDER = 1.0; // linear
const DECAL_MAX = 1536, DECAL_SPREAD = 0.06, DECAL_DRY = 25, DECAL_LIFE = 40; // decals (~10 s of full-auto), s, s, s
const decalAttrs = { aSeed: 1, aBirth: 1, aStretch: 1, aKind: 1, aPixels: 2 };
const decalGeo = new THREE.PlaneGeometry(2, 2); // faces +Z; per-instance scale makes it the stain's size
for (const [name, n] of Object.entries(decalAttrs))
  decalGeo.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(DECAL_MAX * n).fill(name === 'aBirth' ? -1 : 0), n).setUsage(THREE.DynamicDrawUsage));
// A 4×4 ordered (Bayer) dither threshold for a pixel, 0…1: the blood's fades and mixes go by it, pixel by pixel, so
// they break up in a fixed cross-hatch (like the textures' grime) instead of blending smoothly
const BAYER4 = `
    float bayer4(vec2 p) {
      int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
      ivec2 i = ivec2(mod(p, 4.0));
      return (float(m[i.y * 4 + i.x]) + 0.5) / 16.0;
    }`;
// The stain's shape: a wobbly round body, streaks breaking off its rim (the crown's fingers), a droplet on each tip
// and satellites flung beyond, as a signed distance (< 0 inside) over −1…1. Costly (nine fingers, each a capsule and
// two circles, blended), and it never changes, so DECAL_SHAPES variants are baked once into shapeRT (a
// DECAL_SHAPE_GRID² grid of DECAL_SHAPE_RES px tiles) and each stain looks its shape up: the per-pixel work that's
// left is its growth, a slanted impact's tail, a wall stain's drips and the drying.
export const DECAL_SHAPE_GRID = 4, DECAL_SHAPES = DECAL_SHAPE_GRID * DECAL_SHAPE_GRID, DECAL_SHAPE_RES = 128;
export const SPLAT_SDF = `
    float hash1(float n) { return fract(sin(n) * 43758.5453); }
    float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
    float sdCapsule(vec2 p, vec2 a, vec2 b, float ra, float rb) {
      vec2 pa = p - a, ba = b - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * h) - mix(ra, rb, h);
    }
    // a paint splat (Splatoon's, thrown from a can): a big fat body, wobbling; thick arms flung off it, each ending in a
    // round blob; and fat drops beyond
    float splatShape(vec2 p, float seed) {
      float ang = atan(p.y, p.x);
      float d = length(p) - 0.38 * (1.0 + 0.12 * sin(ang * 3.0 + seed) + 0.08 * sin(ang * 5.0 + seed * 2.0));
      for (int i = 0; i < 9; i++) {
        float fi = float(i) + seed * 10.0;
        float a = hash1(fi) * 6.283, len = 0.45 + 0.3 * hash1(fi + 1.0);
        vec2 dir = vec2(cos(a), sin(a)), tip = dir * len;
        d = smin(d, sdCapsule(p, vec2(0.0), tip, 0.13, 0.05), 0.08);
        d = smin(d, length(p - tip) - 0.06 - 0.04 * hash1(fi + 2.0), 0.05);
        d = min(d, length(p - dir * (len + 0.1 + 0.08 * hash1(fi + 3.0))) - 0.025 - 0.035 * hash1(fi + 4.0));
      }
      return d;
    }`;
export const shapeRT = new THREE.WebGLRenderTarget(DECAL_SHAPE_GRID * DECAL_SHAPE_RES, DECAL_SHAPE_GRID * DECAL_SHAPE_RES, {
  type: THREE.HalfFloatType, depthBuffer: false, // linear filtering: a distance field interpolates cleanly
});
{
  const bake = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    vertexShader: `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: SPLAT_SDF + `
    void main() {
      vec2 t = gl_FragCoord.xy / ${DECAL_SHAPE_RES}.0, tile = floor(t);
      float k = tile.x + tile.y * ${DECAL_SHAPE_GRID}.0;
      gl_FragColor = vec4(splatShape(fract(t) * 2.0 - 1.0, k * 6.13 + 1.7), 0.0, 0.0, 1.0);
    }`,
  }));
  renderer.setRenderTarget(shapeRT);
  renderer.render(bake, new THREE.Camera());
  renderer.setRenderTarget(null);
  bake.geometry.dispose(); bake.material.dispose();
}
export const decalMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, // sits on the surface without fighting it
  uniforms: { uTime: { value: 0 }, fogDensity: { value: 0 }, uShapes: { value: shapeRT.texture } },
  vertexShader: `
    attribute float aSeed, aBirth, aStretch, aKind;
    attribute vec2 aPixels;
    varying vec2 vUv, vPixels;
    varying float vSeed, vBirth, vStretch, vKind, vDepth;
    void main() {
      vUv = uv; vPixels = aPixels; vSeed = aSeed; vBirth = aBirth; vStretch = aStretch; vKind = aKind;
      vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: SPLAT_SDF + BAYER4 + `
    uniform float uTime, fogDensity;
    varying vec2 vUv, vPixels;
    varying float vSeed, vBirth, vStretch, vKind, vDepth;
    uniform sampler2D uShapes;
    // the splat's distance field, baked (see shapeRT): variant floor(seed), mirrored by its fraction; far outside 1
    float splat(vec2 p, float seed) {
      if (max(abs(p.x), abs(p.y)) > 0.98) return 1.0;
      float k = floor(seed);
      if (fract(seed) > 0.5) p.x = -p.x;
      vec2 uv = (vec2(mod(k, ${DECAL_SHAPE_GRID}.0), floor(k / ${DECAL_SHAPE_GRID}.0)) + p * 0.5 + 0.5) / ${DECAL_SHAPE_GRID}.0;
      return texture2D(uShapes, uv).r;
    }
    void main() {
      float age = max(uTime - vBirth, 0.0); // uTime is held between blood ticks, so a new stain can be younger
      if (vBirth < 0.0 || age > ${DECAL_LIFE.toFixed(1)}) discard;
      vec2 q = (floor(vUv * vPixels) + 0.5) / vPixels * 2.0 - 1.0;         // whole pixels, -1..1 over the quad
      vec2 p = vKind > 0.5 ? vec2(q.x, (q.y - 2.0 / 3.0) * 3.0) : q;        // walls: a tall quad, the splat in its top third
      float grow = 0.3 + 0.7 * smoothstep(0.0, ${DECAL_SPREAD.toFixed(3)}, age);
      vec2 ps = p / grow;
      float d = splat(ps, vSeed);
      if (vStretch > 1.3) d = smin(d, sdCapsule(ps, vec2(0.0), vec2(0.85, 0.0), 0.12, 0.03), 0.06); // slanted impact's tail
      if (vKind > 0.5) { // runs: a drip or two, growing down and slowing, a bead at the tip
        for (int j = 0; j < 2; j++) {
          float s = vSeed + float(j) * 7.0, x = (hash1(s) - 0.5) * 0.35, len = (0.5 + 1.3 * hash1(s + 1.0)) * (1.0 - exp(-age / (0.5 + hash1(s + 2.0)))); // up to ~1.8 splat radii
          d = smin(d, sdCapsule(p, vec2(x, -0.1), vec2(x, -0.1 - len), 0.07, 0.035), 0.05);
          d = min(d, length(p - vec2(x, -0.12 - len)) - 0.065);
        }
      }
      if (d > 0.0) discard;
      // dithered, on the stain's own pixels: drying turns it from wet red to dried brown-red a pixel at a time (more
      // of its pixels dry as it ages), and at the end of its life its pixels drop out the same way
      float th = bayer4(floor(vUv * vPixels));
      bool isDry = th < smoothstep(0.5, ${DECAL_DRY.toFixed(1)}, age);
      vec3 tint = isDry ? vec3(${BLOOD_DRY.join(', ')}) : vec3(${BLOOD_WET.join(', ')}); // wet red or dried brown-red
      tint *= step(-0.035, d) > 0.5 ? (isDry ? 0.55 : 0.85) : 1.0;                 // coffee ring: the rim darkens as it dries
      if (th >= 1.0 - smoothstep(${(DECAL_LIFE - 5).toFixed(1)}, ${DECAL_LIFE.toFixed(1)}, age)) discard; // fading out
      float keep = exp(-fogDensity * fogDensity * vDepth * vDepth);
      gl_FragColor = vec4(mix(vec3(1.0), tint, keep), 1.0);                         // multiply: 1 = no change
    }`,
});
const decals = new THREE.InstancedMesh(decalGeo, decalMat, DECAL_MAX);
decals.frustumCulled = false;
scene.add(decals);
let decalNext = 0;
const _dm = new THREE.Matrix4(), _dq = new THREE.Quaternion(), _dq2 = new THREE.Quaternion(), _ds = new THREE.Vector3(), _dp = new THREE.Vector3();
const DECAL_FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
// at: where it landed; normal: the wall's or column's outward face normal (null: the floor); v: its velocity
// size (optional): the stain's radius outright, instead of from the drop's size and speed
// Paint: on the blood maps a landing's stain is PAINT_SCALE times a sticker's (to PAINT_MAX m), and one bigger than
// PAINT_SPRAY_FROM m throws PAINT_SPRAY smaller ones on around it: a can of red paint flung, not a drop
const PAINT_SCALE = 1.5, PAINT_MAX = 1.2, PAINT_SPRAY_FROM = 0.4, PAINT_SPRAY = 3; // −, m, m, splats
const _throughDeck = new THREE.Vector3();
export function spawnDecal(at, normal, v, dropSize, size = THREE.MathUtils.clamp(dropSize * (1.5 + 0.6 * v.length()), 0.06, 0.45)) {
  if (!normal && at.y > BALCONY_Y - 0.05 && overDeck(at.x, at.z)) at = _throughDeck.copy(at).setY(floorAt(at.x, at.z, BALCONY_Y - STRINGER_D - 0.01)); // (on
  // the balcony: through its mesh, onto the floor, or the platform's top under a bridge)
  // into the blood maps: as paint (see PAINT_SCALE), a big splat and, for a big one, a spray of smaller ones thrown on
  // ahead of it along its travel
  const onWall = normal && wallBloodAt(at), paint = Math.min(size * PAINT_SCALE, PAINT_MAX);
  if (onWall) { // a wall or column (see wallBlood): the spray across it, to either side
    stampWallBlood(onWall[0], onWall[1], paint);
    for (let k = 0, n = paint > PAINT_SPRAY_FROM ? PAINT_SPRAY : 0; k < n; k++) {
      const a = Math.random() * 2 * Math.PI, r = paint * (1 + 1.5 * Math.random());
      stampWallBlood(onWall[0] + Math.cos(a) * r * BLOOD_PX, onWall[1] + Math.sin(a) * r * BLOOD_PX, paint * (0.2 + 0.3 * Math.random()));
    }
    return;
  }
  const top = !normal && onPlatformTop(at.x, at.y, at.z);
  if (top || (!normal && onBloodFloor(at.x, at.y, at.z))) { // the floor (see bloodMap) or the platform's top: the spray thrown on forward
    const stamp = top ? stampTopBlood : stampBlood;
    const h = Math.hypot(v.x, v.z), stretch = THREE.MathUtils.clamp(v.length() / Math.max(Math.abs(v.y), 1e-3), 1, 3);
    const ax = h < 1e-3 ? 1 : v.x / h, az = h < 1e-3 ? 0 : v.z / h;
    stamp(at.x, at.z, ax, az, paint, stretch);
    for (let k = 0, n = paint > PAINT_SPRAY_FROM ? PAINT_SPRAY : 0; k < n; k++) {
      const a = (Math.random() - 0.5) * (h < 1e-3 ? 2 * Math.PI : 1.6), r = paint * (1 + 2 * Math.random()); // a fan ahead
      const dx = ax * Math.cos(a) - az * Math.sin(a), dz = ax * Math.sin(a) + az * Math.cos(a);
      stamp(at.x + dx * r, at.z + dz * r, dx, dz, paint * (0.15 + 0.3 * Math.random()), 1 + Math.random());
    }
    return;
  }
  const i = decalNext++ % DECAL_MAX, speed = v.length(); // size: m, harder impacts spread wider
  let stretch = 1, kind = 0;
  if (normal) { // a wall or column: round, with a drip; the tall quad's centre sits two splat radii below the splat
    kind = 1;
    _dq.setFromAxisAngle(AXIS_Y, Math.atan2(normal.x, normal.z));
    _dp.copy(at).addScaledVector(normal, 0.01).setY(at.y - 2 * size);
    _ds.set(size, 3 * size, 1);
  } else { // the floor: stretched along its travel by 1 / sin(impact angle)
    const h = Math.hypot(v.x, v.z);
    stretch = THREE.MathUtils.clamp(speed / Math.max(Math.abs(v.y), 1e-3), 1, 3);
    _dq.setFromAxisAngle(AXIS_Y, Math.atan2(-v.z, v.x)).multiply(DECAL_FLAT); // local X along the travel
    if (h < 1e-3) _dq.copy(DECAL_FLAT);
    _dp.copy(at).setY(at.y + 0.004); // the floor, or the platform's top
    _ds.set(size * stretch, size, 1);
  }
  decals.setMatrixAt(i, _dm.compose(_dp, _dq, _ds));
  decals.instanceMatrix.needsUpdate = true;
  const set = (name, ...vals) => { const at_ = decalGeo.attributes[name]; at_.array.set(vals, i * at_.itemSize); at_.needsUpdate = true; };
  set('aSeed', Math.floor(Math.random() * DECAL_SHAPES) + Math.random() * 0.999); // shape variant; fraction: mirror, drips
  set('aBirth', bloodTime);
  set('aStretch', stretch);
  set('aKind', kind);
  const px = Math.max(Math.round(2 * size * 32), 6); // the floor's pixel scale
  set('aPixels', px * stretch, kind ? px * 3 : px);
}

