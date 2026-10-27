// Blood maps: the blood painted into the floor, the walls and the columns (stamped, drying, running, draining);
// bloody feet and their prints
import { DECAL_SHAPE_GRID, DECAL_SHAPES, SPLAT_SDF, shapeRT } from './decals.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { renderer } from './setup.js';
import { TILE } from './tiles.js';
import { ARENA, WALL_ROWS, COLUMN_SIDE, COLUMNS, COLUMN_APOTHEM, PLATFORM_SIDE, PLATFORM_H, PLATFORM_APOTHEM, _pf,
  platformDist } from './arena.js';
import { camera } from './camera.js';
import { _clearColor } from './blood-sheets.js';
import { audio, shotOut } from './audio.js';
import { npcs } from './enemies.js';
import { jumpY } from './main.js';

// Blood maps (Splatoon's ink maps): blood on the arena's floor, walls and columns isn't stickers but paint in a
// texture over each, BLOOD_PX texels a metre (one a surface pixel, so it lands on their pixel grid), never cleared.
// R: how much blood (summed: splats that overlap merge into one pool, deeper where they pile up); G: how much of it's
// still wet (also summed, then dried: multiplied down over time, by BLOOD_DRY_TAU). A landing stamps the stain's shape
// (the stickers' baked splats: see shapeRT) in, added. The surfaces read it (addBlood): blood where there's any, its
// colour by depth and wetness, glossy while wet, matte dried, bulged at its edges (a normal from how fast the depth
// changes, so a pool's rim catches the light).
// The floor's map (bloodMap) lies over the arena floor. The walls' and columns' (wallBlood) is an atlas of their
// surfaces unwrapped: each wall a strip (along it × up), then a strip of the four columns, each its eight faces side by
// side. On it the blood runs (see the flow): wet blood past what sticks drips down, leaving a film, its front a bead;
// what runs off the bottom drains onto the floor's map at the base, where it pools.
// Everything else (platform, stairs, towers) keeps the stickers.
export const BLOOD_PX = 32, BLOOD_RES = 2 * ARENA * BLOOD_PX, BLOOD_DRY_TAU = 10, BLOOD_DRY_STEP = 0.25; // texels/m, texels, s, s
const BLOOD_STAMPS = 512; // most landings painted a frame, per map
// The platform's top has its own map (topBloodMap), TOP_BLOOD_HALF m each way from the centre: the floor's would do,
// but splats at the platform's foot would show on its top edge
export const TOP_BLOOD_HALF = 5.5, TOP_BLOOD_RES = 2 * TOP_BLOOD_HALF * BLOOD_PX;
export const bloodTarget = (w, h) => new THREE.WebGLRenderTarget(w, h, {
  type: THREE.HalfFloatType, format: THREE.RGFormat, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, depthBuffer: false });
export const bloodMap = bloodTarget(BLOOD_RES, BLOOD_RES), floorBloodTex = { value: bloodMap.texture };
export const topBloodMap = bloodTarget(TOP_BLOOD_RES, TOP_BLOOD_RES), topBloodTex = { value: topBloodMap.texture };
export const onPlatformTop = (x, y, z) => Math.abs(y - PLATFORM_H) < 0.02 && platformDist(x, z) < PLATFORM_APOTHEM;
// the walls' and columns' atlas: WALL_BLOOD_ROWS texels a strip (the walls' height), 4 wall strips, the columns', then
// the centre platform's sides (its eight side by side; only its bottom PLATFORM_H of the strip used)
export const WALL_BLOOD_ROWS = WALL_ROWS * TILE * BLOOD_PX, WALL_BLOOD_W = BLOOD_RES, WALL_BLOOD_H = 6 * WALL_BLOOD_ROWS;
export const FACE_PX = COLUMN_SIDE * BLOOD_PX, COLUMN_PX = 8 * FACE_PX; // a column face's texels across; a column's
export const PLAT_FACE_PX = PLATFORM_SIDE * BLOOD_PX; // a platform side's texels across
const wallBloodRTs = [bloodTarget(WALL_BLOOD_W, WALL_BLOOD_H), bloodTarget(WALL_BLOOD_W, WALL_BLOOD_H)]; // ping-pong (the flow)
let wallBloodCur = 0;
export const wallBloodTex = { value: wallBloodRTs[0].texture }; // the current one, shared by the materials
// The flow: every BLOOD_FLOW_STEP s, a share (BLOOD_FLOW_RATE) of each texel's wet blood past what sticks (BLOOD_HOLD,
// varied per texel column so it runs in separate streaks) moves one texel down. Dried blood doesn't run; the walls
// dry slower than the floor (BLOOD_WALL_DRY_TAU), so drips run a metre or two before they stop
const BLOOD_FLOW_STEP = 1 / 30, BLOOD_FLOW_RATE = 0.5, BLOOD_HOLD = 0.15, BLOOD_WALL_DRY_TAU = 12, BLOOD_WALL_IDLE = 40; // s, share, depth, s, s
export function onBloodFloor(x, y, z) { // the floor proper (not the platform's top or a stair), inside the arena
  return y <= 0.01 && Math.abs(x) < ARENA && Math.abs(z) < ARENA;
}
// where a point on a wall or a column face is in the atlas (texels, x along, y up), or null: not one
export function wallBloodAt(p) {
  if (p.y < 0 || p.y >= WALL_ROWS * TILE) return null;
  const v = p.y * BLOOD_PX;
  if (Math.abs(p.x) > ARENA - 0.05) return [(p.z + ARENA) * BLOOD_PX, (p.x > 0 ? 0 : 1) * WALL_BLOOD_ROWS + v];
  if (Math.abs(p.z) > ARENA - 0.05) return [(p.x + ARENA) * BLOOD_PX, (p.z > 0 ? 2 : 3) * WALL_BLOOD_ROWS + v];
  if (p.y < PLATFORM_H && Math.abs(platformDist(p.x, p.z) - PLATFORM_APOTHEM) < 0.05) { // a platform side (its normal: _pf)
    const f = (Math.round(Math.atan2(_pf.x, _pf.y) / (Math.PI / 4)) + 8) % 8, a = f * Math.PI / 4;
    const s = p.x * Math.cos(a) - p.z * Math.sin(a); // along it
    return [f * PLAT_FACE_PX + (s + PLATFORM_SIDE / 2) * BLOOD_PX, 5 * WALL_BLOOD_ROWS + v];
  }
  for (let k = 0; k < COLUMNS.length; k++) {
    const dx = p.x - COLUMNS[k].x, dz = p.z - COLUMNS[k].y, f = (Math.round(Math.atan2(dx, dz) / (Math.PI / 4)) + 8) % 8, a = f * Math.PI / 4;
    if (Math.abs(dx * Math.sin(a) + dz * Math.cos(a) - COLUMN_APOTHEM) > 0.05) continue;
    const s = dx * Math.cos(a) - dz * Math.sin(a); // along the face
    return [k * COLUMN_PX + f * FACE_PX + (s + COLUMN_SIDE / 2) * BLOOD_PX, 4 * WALL_BLOOD_ROWS + v];
  }
  return null;
}
// Stamps: a stain's quad, local x along aAxis, aHalf its half-sizes (local units), placed at aCentre (clip space);
// uScale takes local units to clip space (the floor's: metres; the atlas's: texels)
function makeStamps(scaleX, scaleY) {
  const geo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(2, 2));
  const attr = (name, n) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(BLOOD_STAMPS * n), n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    return a;
  };
  const attrs = [attr('aCentre', 2), attr('aAxis', 2), attr('aHalf', 2), attr('aSeed', 2)];
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uShapes: { value: shapeRT.texture }, uScale: { value: new THREE.Vector2(scaleX, scaleY) } },
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    depthTest: false, depthWrite: false,
    vertexShader: `
      uniform vec2 uScale;
      attribute vec2 aCentre, aAxis, aHalf, aSeed;
      varying vec2 vP;
      varying float vSeed, vStretch;
      void main() {
        vP = position.xy; vSeed = aSeed.x; vStretch = aSeed.y;
        vec2 w = aAxis * position.x * aHalf.x + vec2(-aAxis.y, aAxis.x) * position.y * aHalf.y;
        gl_Position = vec4(aCentre + w * uScale, 0.0, 1.0);
      }`,
    fragmentShader: SPLAT_SDF + `
      uniform sampler2D uShapes;
      varying vec2 vP;
      varying float vSeed, vStretch;
      float splat(vec2 p, float seed) { // as the stickers' (see decalMat)
        if (max(abs(p.x), abs(p.y)) > 0.98) return 1.0;
        float k = floor(seed);
        if (fract(seed) > 0.5) p.x = -p.x;
        vec2 uv = (vec2(mod(k, ${DECAL_SHAPE_GRID}.0), floor(k / ${DECAL_SHAPE_GRID}.0)) + p * 0.5 + 0.5) / ${DECAL_SHAPE_GRID}.0;
        return texture2D(uShapes, uv).r;
      }
      // footprints (vStretch < 0; vSeed: how much blood), over −1…1, x forward: −1 a boot (a sole and a heel),
      // −2 a demon's claw (a pad and three toes)
      float footprint(vec2 p, float kind) {
        if (kind > -1.5) return min(length((p - vec2(0.25, 0.0)) / vec2(0.7, 0.85)) - 1.0, length((p - vec2(-0.68, 0.0)) / vec2(0.3, 0.7)) - 1.0);
        float d = length((p - vec2(-0.45, 0.0)) / vec2(0.4, 0.55)) - 1.0;
        for (int k = -1; k <= 1; k++) d = min(d, sdCapsule(p, vec2(-0.2, 0.0), vec2(0.9, 0.0) * cos(float(k) * 0.5) + vec2(0.0, float(k) * 0.55), 0.22, 0.08) / 0.3);
        return d;
      }
      void main() {
        if (vStretch < 0.0) { // a footprint: a thin film, a little of it wet
          if (footprint(vP, vStretch) > 0.0) discard;
          gl_FragColor = vec4(vSeed, vSeed * 0.6, 0.0, 1.0);
          return;
        }
        float d = splat(vP, vSeed);
        if (vStretch > 1.3) d = smin(d, sdCapsule(vP, vec2(0.0), vec2(0.85, 0.0), 0.12, 0.03), 0.06); // a slanted impact's tail
        if (d > 0.0) discard;
        float h = 0.15 + 0.85 * min(-d / 0.12, 1.0); // its depth: thin at the edges and in the fingers, full in the body
        gl_FragColor = vec4(h, h, 0.0, 1.0); // all of it wet
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat), scn = new THREE.Scene();
  mesh.frustumCulled = false;
  scn.add(mesh);
  let count = 0;
  return {
    // centre (clip), axis, half-sizes (local units), stretch (< 0: a footprint, see footprint), seed (a footprint's: its blood)
    add(cx, cy, ax, ay, hx, hy, stretch, seed = Math.floor(Math.random() * DECAL_SHAPES) + Math.random() * 0.999) {
      if (count >= BLOOD_STAMPS) return;
      const k = count++;
      attrs[0].array.set([cx, cy], k * 2);
      attrs[1].array.set([ax, ay], k * 2);
      attrs[2].array.set([hx, hy], k * 2);
      attrs[3].array.set([seed, stretch], k * 2);
    },
    draw() { // into the current render target
      if (!count) return false;
      geo.instanceCount = count;
      for (const a of attrs) a.needsUpdate = true;
      renderer.render(scn, bloodCam);
      count = 0;
      return true;
    },
  };
}
const floorStamps = makeStamps(1 / ARENA, 1 / ARENA), wallStamps = makeStamps(2 / WALL_BLOOD_W, 2 / WALL_BLOOD_H);
const topStamps = makeStamps(1 / TOP_BLOOD_HALF, 1 / TOP_BLOOD_HALF);
// a stain on the floor: at x, z, its local x along (ax, az), size m, stretched along it
export function stampBlood(x, z, ax, az, size, stretch) { floorStamps.add(x / ARENA, z / ARENA, ax, az, size * stretch, size, stretch); }
// on the platform's top (see topBloodMap)
export function stampTopBlood(x, z, ax, az, size, stretch) { topStamps.add(x / TOP_BLOOD_HALF, z / TOP_BLOOD_HALF, ax, az, size * stretch, size, stretch); }
// a stain on a wall or column, at atlas texel (u, v), size m
let wallIdle = Infinity; // s since blood last landed on a wall (the flow sleeps once it's all dry)
export function stampWallBlood(u, v, size) {
  wallStamps.add(u / WALL_BLOOD_W * 2 - 1, v / WALL_BLOOD_H * 2 - 1, 1, 0, size * BLOOD_PX, size * BLOOD_PX, 1);
  wallIdle = 0;
}
export const fullQuad = (mat) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat), s = new THREE.Scene(); m.frustumCulled = false; s.add(m); return s; };
export const fullQuadVS = `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
// drying: G multiplied by uKeep (the blend: what's there × the source colour), R untouched
const dryMat = new THREE.ShaderMaterial({
  uniforms: { uKeep: { value: 1 } },
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
  depthTest: false, depthWrite: false, vertexShader: fullQuadVS,
  fragmentShader: `uniform float uKeep; void main() { gl_FragColor = vec4(1.0, uKeep, 1.0, 1.0); }`,
});
const dryScene = fullQuad(dryMat);
// what flows out of an atlas texel down to the one below (R, and G: its wet share) in a flow step
const FLOW_OUT = `
    float bloodHold(ivec2 t) { // what sticks: varied per texel column (and strip), so it runs in streaks
      return ${BLOOD_HOLD.toFixed(2)} * (0.5 + fract(sin(float(t.x) * 12.9898 + float(t.y / ${WALL_BLOOD_ROWS}) * 78.233) * 43758.5453));
    }
    vec2 flowOut(sampler2D src, ivec2 t) {
      vec2 b = texelFetch(src, t, 0).rg;
      float wet = clamp(b.g / max(b.r, 1e-4), 0.0, 1.0), out_ = max(b.r - bloodHold(t), 0.0) * ${BLOOD_FLOW_RATE.toFixed(2)} * wet;
      return vec2(out_, out_ * wet);
    }`;
const flowMat = new THREE.ShaderMaterial({
  uniforms: { uSrc: { value: null }, uKeep: { value: 1 } }, depthTest: false, depthWrite: false, vertexShader: fullQuadVS,
  fragmentShader: `
    uniform sampler2D uSrc;
    uniform float uKeep;
    ${FLOW_OUT}
    void main() {
      ivec2 t = ivec2(gl_FragCoord.xy);
      vec2 b = texelFetch(uSrc, t, 0).rg - flowOut(uSrc, t);
      if (t.y % ${WALL_BLOOD_ROWS} != ${WALL_BLOOD_ROWS - 1}) b += flowOut(uSrc, t + ivec2(0, 1)); // from above (its strip's)
      gl_FragColor = vec4(b.r, b.g * uKeep, 0.0, 1.0);
    }`,
});
const flowScene = fullQuad(flowMat);
// the drain: each atlas column's bottom texel's outflow, painted onto the floor's map at the foot of its wall or
// column face, a little puddle (BLOOD_DRAIN_PX across)
const BLOOD_DRAIN_PX = 11, BLOOD_DRAIN = 0.35; // texels; share of the outflow each puddle texel gets
const drainCount = 4 * WALL_BLOOD_W + COLUMNS.length * COLUMN_PX + 8 * PLAT_FACE_PX;
const drainGeo = new THREE.BufferGeometry();
drainGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(drainCount * 3), 3));
drainGeo.setAttribute('aIdx', new THREE.Float32BufferAttribute(Float32Array.from({ length: drainCount }, (_, i) => i), 1));
const drainMat = new THREE.ShaderMaterial({
  uniforms: { uSrc: { value: null } },
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  depthTest: false, depthWrite: false,
  vertexShader: `
    uniform sampler2D uSrc;
    attribute float aIdx;
    varying vec2 vAmt;
    ${FLOW_OUT}
    void main() {
      int i = int(aIdx + 0.5);
      ivec2 t;
      vec2 xz;
      const float A = ${ARENA.toFixed(1)}, IN = 0.17; // the puddle's centre: this far out from the surface
      if (i < ${4 * WALL_BLOOD_W}) {
        int w = i / ${WALL_BLOOD_W}, u = i - w * ${WALL_BLOOD_W};
        t = ivec2(u, w * ${WALL_BLOOD_ROWS});
        float along = (float(u) + 0.5) / ${BLOOD_PX.toFixed(1)} - A;
        xz = w == 0 ? vec2(A - IN, along) : w == 1 ? vec2(IN - A, along) : w == 2 ? vec2(along, A - IN) : vec2(along, IN - A);
      } else if (i >= ${4 * WALL_BLOOD_W + COLUMNS.length * COLUMN_PX}) { // a platform side's foot
        int j = i - ${4 * WALL_BLOOD_W + COLUMNS.length * COLUMN_PX}, f = j / ${PLAT_FACE_PX};
        t = ivec2(j, ${5 * WALL_BLOOD_ROWS});
        float a = float(f) * ${(Math.PI / 4).toFixed(6)}, s = (float(j - f * ${PLAT_FACE_PX}) + 0.5) / ${BLOOD_PX.toFixed(1)} - ${(PLATFORM_SIDE / 2).toFixed(2)};
        xz = vec2(sin(a), cos(a)) * (${PLATFORM_APOTHEM.toFixed(4)} + IN) + vec2(cos(a), -sin(a)) * s;
      } else {
        int j = i - ${4 * WALL_BLOOD_W}, k = j / ${COLUMN_PX}, u = j - k * ${COLUMN_PX}, f = u / ${FACE_PX};
        t = ivec2(j, ${4 * WALL_BLOOD_ROWS});
        float a = float(f) * ${(Math.PI / 4).toFixed(6)}, s = (float(u - f * ${FACE_PX}) + 0.5) / ${BLOOD_PX.toFixed(1)} - ${(COLUMN_SIDE / 2).toFixed(2)};
        vec2 c = ${COLUMNS.map((c, k) => (k < COLUMNS.length - 1 ? `k == ${k} ? ` : '') + `vec2(${c.x.toFixed(1)}, ${c.y.toFixed(1)})`).join(' : ')};
        xz = c + vec2(sin(a), cos(a)) * (${COLUMN_APOTHEM.toFixed(4)} + IN) + vec2(cos(a), -sin(a)) * s;
      }
      vAmt = flowOut(uSrc, t);
      gl_Position = vAmt.x > 0.0 ? vec4(xz / A, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = ${BLOOD_DRAIN_PX.toFixed(1)};
    }`,
  fragmentShader: `
    varying vec2 vAmt;
    void main() {
      float r = length(gl_PointCoord - 0.5) * 2.0;
      if (r > 1.0) discard;
      gl_FragColor = vec4(vAmt * ${BLOOD_DRAIN.toFixed(2)} * (1.0 - r * r), 0.0, 1.0);
    }`,
});
const drainPoints = new THREE.Points(drainGeo, drainMat), drainScene = new THREE.Scene();
drainPoints.frustumCulled = false;
drainScene.add(drainPoints);
export const bloodCam = new THREE.Camera(); // (the shaders place everything themselves)
let bloodMapsClear = false, bloodDryWait = 0, flowWait = 0;
export function flushBlood(dt) { // before the scene's drawn: this frame's stains into the maps, the drips, the drying
  const target = renderer.getRenderTarget(), autoClear = renderer.autoClear;
  renderer.autoClear = false;
  if (!bloodMapsClear) { // their first use: empty
    renderer.getClearColor(_clearColor);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const rt of [bloodMap, topBloodMap, ...wallBloodRTs]) { renderer.setRenderTarget(rt); renderer.clear(); }
    renderer.setClearColor(_clearColor, alpha);
    bloodMapsClear = true;
  }
  // the walls: new stains, then the flow (each step: the bottom row's outflow drained onto the floor, then the move)
  renderer.setRenderTarget(wallBloodRTs[wallBloodCur]);
  wallStamps.draw();
  wallIdle += dt;
  flowWait = wallIdle < BLOOD_WALL_IDLE ? Math.min(flowWait + dt, 2 * BLOOD_FLOW_STEP) : 0;
  for (; flowWait >= BLOOD_FLOW_STEP; flowWait -= BLOOD_FLOW_STEP) {
    const src = wallBloodRTs[wallBloodCur].texture;
    drainMat.uniforms.uSrc.value = flowMat.uniforms.uSrc.value = src;
    flowMat.uniforms.uKeep.value = Math.exp(-BLOOD_FLOW_STEP / BLOOD_WALL_DRY_TAU);
    renderer.setRenderTarget(bloodMap);
    renderer.render(drainScene, bloodCam);
    wallBloodCur ^= 1;
    renderer.setRenderTarget(wallBloodRTs[wallBloodCur]);
    renderer.render(flowScene, bloodCam);
  }
  wallBloodTex.value = wallBloodRTs[wallBloodCur].texture;
  // the floor and the platform's top: drying, then new stains
  const dry = (bloodDryWait += dt) >= BLOOD_DRY_STEP;
  if (dry) { dryMat.uniforms.uKeep.value = Math.exp(-bloodDryWait / BLOOD_DRY_TAU); bloodDryWait = 0; }
  renderer.setRenderTarget(topBloodMap);
  if (dry) renderer.render(dryScene, bloodCam);
  topStamps.draw();
  renderer.setRenderTarget(bloodMap);
  if (dry) renderer.render(dryScene, bloodCam);
  floorStamps.draw();
  renderer.setRenderTarget(target);
  renderer.autoClear = autoClear;
  probeFeet();
}
// Feet in the blood: the game needs to know where the blood is, which only the GPU does, so each frame it samples the
// floor's map under every foot (you and each demon: BLOOD_PROBES at most), the most blood and wet blood within a texel
// of it, into a strip of texels read back without waiting (it lands a frame or two later; feet move slowly).
// Stepping in wet blood soaks the boots (or claws): each step after leaves a print, fainter each time
// (BOOT_KEEP), till they're clean. In wet blood, a step squelches.
const BLOOD_PROBES = 256, BOOT_KEEP = 0.8, BOOT_PRINT = 0.9; // probes, of the soaking kept a print, a print's blood (soaked)
export const PRINT_STRIDE = 0.8; // m: your feet come down this far apart (your step sound's every STEP_LENGTH: not every foot)
const feetRT = new THREE.WebGLRenderTarget(BLOOD_PROBES, 1, { type: THREE.FloatType, depthBuffer: false });
const feetGeo = new THREE.BufferGeometry();
feetGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(BLOOD_PROBES * 3), 3));
feetGeo.setAttribute('aXZ', new THREE.Float32BufferAttribute(new Float32Array(BLOOD_PROBES * 2), 2).setUsage(THREE.DynamicDrawUsage));
feetGeo.setAttribute('aIdx', new THREE.Float32BufferAttribute(Float32Array.from({ length: BLOOD_PROBES }, (_, i) => i), 1));
const feetMat = new THREE.ShaderMaterial({
  uniforms: { uMap: floorBloodTex }, depthTest: false, depthWrite: false,
  vertexShader: `
    attribute vec2 aXZ;
    attribute float aIdx;
    flat out vec2 vXZ;
    void main() { vXZ = aXZ; gl_Position = vec4((aIdx + 0.5) / ${BLOOD_PROBES}.0 * 2.0 - 1.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; }`,
  fragmentShader: `
    uniform sampler2D uMap;
    flat in vec2 vXZ;
    void main() {
      ivec2 t = ivec2(floor((vXZ + ${ARENA.toFixed(1)}) * ${BLOOD_PX.toFixed(1)}));
      vec2 b = vec2(0.0);
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++)
        b = max(b, texelFetch(uMap, clamp(t + ivec2(x, y), ivec2(0), ivec2(${BLOOD_RES - 1})), 0).rg);
      gl_FragColor = vec4(b, 0.0, 1.0); // the most blood, the most wet blood
    }`,
});
const feetPoints = new THREE.Points(feetGeo, feetMat), feetScene = new THREE.Scene();
feetPoints.frustumCulled = false;
feetScene.add(feetPoints);
const feetBuf = new Float32Array(BLOOD_PROBES * 4);
let probing = false;
// what's under a foot (as last read): { depth, wet } (wet: how much of it, 0…1); you: player
export const player = { under: { depth: 0, wet: 0 }, boot: 0, foot: 1 };
const offFloor = (x, z) => !onBloodFloor(x, 0, z) || platformDist(x, z) < PLATFORM_APOTHEM; // (the platform: not the floor's map)
function probeFeet() { // after flushBlood: sample under every foot; read back (when the last read's back)
  if (probing) return;
  const who = [player, ...npcs.slice(0, BLOOD_PROBES - 1)], xz = feetGeo.attributes.aXZ.array;
  who.forEach((w, i) => {
    const p = w === player ? camera.position : w.imp.model.position;
    xz[i * 2] = p.x; xz[i * 2 + 1] = p.z;
  });
  feetGeo.attributes.aXZ.needsUpdate = true;
  feetGeo.setDrawRange(0, who.length);
  const target = renderer.getRenderTarget();
  renderer.setRenderTarget(feetRT);
  renderer.render(feetScene, bloodCam);
  renderer.setRenderTarget(target);
  probing = true;
  renderer.readRenderTargetPixelsAsync(feetRT, 0, 0, BLOOD_PROBES, 1, feetBuf).then(() => {
    who.forEach((w, i) => {
      const p = w === player ? camera.position : w.imp.model.position;
      const depth = (w === player ? jumpY : p.y) > 0.01 || offFloor(p.x, p.z) ? 0 : feetBuf[i * 4]; // (feet off the floor: none)
      w.under = { depth, wet: depth > 0.01 ? Math.min(feetBuf[i * 4 + 1] / depth, 1) : 0 };
      if (w.under.wet > 0.3 && depth > 0.1) w.boot = 1; // stepped in wet blood: soaked
    });
  }).finally(() => { probing = false; });
}
// is w (player or a demon) standing in wet blood (so its step squelches)?
export const inWetBlood = (w) => (w.under?.wet ?? 0) > 0.3 && (w.under?.depth ?? 0) > 0.1;
// a foot of w's coming down at p, facing (fx, fz): its print, if its boots are bloody
export function footPrint(w, p, fx, fz, claw) {
  w.foot = -(w.foot ?? 1);
  if ((w.boot ?? 0) > 0.05 && !offFloor(p.x, p.z)) {
    const side = claw ? 0.22 : 0.12, x = p.x + fz * side * w.foot, z = p.z - fx * side * w.foot; // its foot: left or right of its middle
    const [hx, hy] = claw ? [0.2, 0.16] : [0.15, 0.065];
    floorStamps.add(x / ARENA, z / ARENA, fx, fz, hx, hy, claw ? -2 : -1, BOOT_PRINT * w.boot);
    w.boot *= BOOT_KEEP;
  }
}
// A squelch: no recording yet, so made here: a short burst of noise through a band that sweeps down, a wet slap
let squelchNoise = null; // (made on first use: the audio context comes later, in audio.js)
export function playSquelch(level, pitch = 1) {
  if (!squelchNoise) {
    squelchNoise = audio.createBuffer(1, audio.sampleRate * 0.25, audio.sampleRate);
    const d = squelchNoise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = audio.currentTime, src = audio.createBufferSource(), band = audio.createBiquadFilter(), gain = audio.createGain();
  src.buffer = squelchNoise;
  band.type = 'bandpass'; band.Q.value = 3;
  band.frequency.setValueAtTime(1600 * pitch * (0.9 + Math.random() * 0.2), t);
  band.frequency.exponentialRampToValueAtTime(350 * pitch, t + 0.14);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(level, t + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  src.connect(band).connect(gain).connect(shotOut);
  src.start(t);
  src.stop(t + 0.25);
}

