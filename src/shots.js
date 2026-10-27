// Where a shot hits: a demon (a probe of its sprite, on the GPU) or the world; the wounds painted on them
import './casings.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { renderer } from './setup.js';
import { COLUMNS, COLUMN_APOTHEM, rayTowers, rayPlatform, STAIR_TREAD, BOXES, inStairBox } from './arena.js';
import { camera } from './camera.js';
import { PELLETS, SPREAD, POWER, SPLAT_SCALE } from './weapons.js';
import { FL_GOBS, burstBlood, bleedSpurts, startBleed, throwUnflown } from './blood-fluid.js';
import { _clearColor } from './blood-sheets.js';
import { spawnHole, rayWorld } from './holes.js';
import { splashLens } from './hud.js';
import { npcs, corpses, _v } from './enemies.js';
import { damageNpc } from './enemy-ai.js';
import { skulls, hitSkull } from './skulls.js';
import { GIB_TRAUMA, GIB_KILL_MIN, GIB_KILL_WINDOW, traumatize, cutBody, gibBody } from './gibs.js';
import { clock } from './main.js';

// Where a shot from the centre of the view hits a demon: a ray against a sphere round each demon's body (its
// sprite's bounding radius, at its centre height); the nearest wins, unless a column (in plan, a circle round its
// corners) is in the way. A demon's sphere only nominates it: the hit is where the shot touches its actual animated
// body (probeShot); a hit bursts blood, wounds and damages it, a miss leaves a hole in the arena.
const _toC = new THREE.Vector3();
// A shot (a bullet, or one pellet) along dir, fired now: the demons it passes near are probed (probeShot); resolves
// when that's read back, a frame or two later, to the hit (see firePellets), or nothing (a miss: it's left a hole)
function fireShot(dir) {
  const o = camera.position.clone();
  const near = []; // demons (skulls, the dead) whose sphere the shot passes through, nearest first
  for (const npc of npcs.concat(skulls, corpses)) {
    const { imp } = npc;
    const R = imp.r * 0.5;
    _toC.copy(imp.model.position).add(imp.fit).sub(o);
    const t = _toC.dot(dir), d2 = _toC.lengthSq() - t * t;
    if (t > 0 && d2 < (imp.r * imp.r)) near.push({ npc, t, out: t + Math.sqrt(Math.max(R * R - d2, 0)) });
  }
  near.sort((p, q) => p.t - q.t);
  near.length = Math.min(near.length, PROBE_MAX);
  if (!near.length) return Promise.resolve(shotMissed(o, dir));
  return probeShot(near, o, dir).then((buf) => {
    // the first whose actual body the shot touches (between the legs isn't a hit)
    const k = near.findIndex((_, k) => buf[k * 4 + 3] > 0.5);
    if (k < 0) return shotMissed(o, dir);
    const best = buf[k * 4], c = near[k];
    if (rayPlatform(o, dir) < best || (rayTowers(o, dir)?.t ?? Infinity) < best || rayColumns(o, dir) < best) return shotMissed(o, dir);
    return { entry: o.clone().addScaledVector(dir, best), exit: o.clone().addScaledVector(dir, Math.max(c.out, best + 0.1)), dir, npc: c.npc };
  }, () => {});
}
// One shot's PELLETS (1 for the M4), each up to SPREAD off the aim. Every pellet that hits wounds and damages its
// demon; a demon hit bursts blood once a shot, from the first pellet's wound, one big splash: FL_GOBS gobs and one more
// for each other pellet that hit it, up to BURST_GOBS_MAX (a burst a pellet, all at once, was one dense blob). The
// floor still gets every pellet's burst (see throwUnflown). It also splashes the lens and starts bleeding (see
// startBleed) once a shot.
export const BURST_GOBS_MAX = 10;
const _pel = new THREE.Vector3(), _pelR = new THREE.Vector3(), _pelU = new THREE.Vector3();
export function firePellets() {
  camera.getWorldDirection(_pel);
  _pelR.crossVectors(_pel, camera.up).normalize();
  _pelU.crossVectors(_pelR, _pel);
  const shots = [];
  for (let k = 0; k < PELLETS; k++) {
    const r = SPREAD * Math.sqrt(Math.random()), a = Math.random() * 2 * Math.PI; // evenly over a disc
    shots.push(fireShot(_pel.clone().addScaledVector(_pelR, r * Math.cos(a)).addScaledVector(_pelU, r * Math.sin(a)).normalize()));
  }
  const splat = SPLAT_SCALE, spurts = bleedSpurts(POWER); // (this weapon's: the hits land a frame or two later, maybe after a switch)
  Promise.all(shots).then((hits) => {
    const byDemon = new Map(); // the demon → its first hit, and how many pellets hit it
    const now = clock.elapsedTime;
    for (const hit of hits) {
      if (!hit || (hit.npc.corpse ?? hit.npc).gone) continue; // (gone: burst by an earlier shot, still in the air)
      const b = byDemon.get(hit.npc);
      if (b) b.n++; else byDemon.set(hit.npc, { hit, n: 1 });
      if (!hit.npc.skull) { traumatize(hit.npc.corpse ?? hit.npc, 1, now); paintWound(hit.npc, hit.entry); damageNpc(hit.npc, hit.dir); }
    }
    for (const { hit, n } of byDemon.values()) {
      if (hit.npc.skull) { hitSkull(hit.npc, hit.entry, hit.dir, n); continue; } // (bone: no blood; one knock a shot)
      const body = hit.npc.corpse ?? hit.npc; // (killed by this shot: its corpse)
      if (body.dead && !body.demon && !body.cut && body.trauma >= GIB_TRAUMA && body.deathTrauma >= GIB_KILL_MIN && now - body.diedAt < GIB_KILL_WINDOW) {
        cutBody(body, hit); continue; // shredded as it died: its top half
      }
      if (body.dead && body.imp.still && body.carcass >= GIB_TRAUMA) { gibBody(body, hit); continue; } // a carcass, down: all of it
      const gobs = Math.min(FL_GOBS + n - 1, BURST_GOBS_MAX);
      burstBlood(hit, gobs, 1, splat);
      throwUnflown(hit, n * FL_GOBS - gobs, clock.elapsedTime); // the rest, a gob burst a pellet, only on the floor
      startBleed(hit, clock.elapsedTime, spurts);
      splashLens(hit.entry);
    }
  });
}
function shotMissed(o, dir) { // it hits the arena
  const w = rayWorld(o, dir);
  if (!w) return;
  const at = _v.copy(o).addScaledVector(dir, w.t);
  if (w.normal.y < -0.5 && BOXES.some((b) => Math.abs(at.y - (b.h - STAIR_TREAD)) < 1e-4 && inStairBox(b, at.x, at.z, 1e-4))) at.y += STAIR_TREAD; // (a
  // tread's underside, or the balcony's: drawn at its grating, the top seen from under it; else the hole hung under it)
  spawnHole(at, w.normal);
}
// How far along the shot it first meets a column (their octagons, as circles round them), or Infinity
function rayColumns(o, dir) {
  const Rc = COLUMN_APOTHEM / Math.cos(Math.PI / 8), a = dir.x * dir.x + dir.z * dir.z;
  let best = Infinity;
  for (const c of COLUMNS) {
    const ox = o.x - c.x, oz = o.z - c.y, b = 2 * (dir.x * ox + dir.z * oz), disc = b * b - 4 * a * (ox * ox + oz * oz - Rc * Rc);
    if (disc > 0 && a > 1e-9) {
      const t0 = (-b - Math.sqrt(disc)) / (2 * a);
      if (t0 > 0) best = Math.min(best, t0);
    }
  }
  return best;
}

// Wounds: the shot's exact hit on a demon's animated body, and blood painted onto it. A ray against the 50k-triangle
// skinned mesh on the CPU takes ~20 ms, so both run on the GPU with the model's own skinning:
// - the probe renders the body's distance along the shot into a 1 px target (a camera looking down the shot, a
//   1 cm view), read back: where the shot touches it, or nothing
// - each demon has a blood mask in its texture's layout (WOUND_RES², unique UVs, no mirroring); a hit draws the body
//   into it in UV space, every texel testing its posed 3D position against the hit, so a wound crosses texture
//   seams cleanly; stretched downward, as blood runs, with a ragged noisy edge, the mask keeping the most
//   blood each texel has had. The demon's material mixes the mask in (dark wet red, glossy), lit by the sprite stage
//   like the rest of it, and its sprite re-renders.
export const WOUND_RES = 256, WOUND_RADIUS = 0.17, WOUND_RUN = 2.5; // px; m; how much further it runs down than across
const WOUND_STREAKS = 5, WOUND_STREAK_LEN = 0.9, WOUND_SPATTER = 0.7; // runs down the body from each wound, m (longest); m: specks round it
const woundVertex = `
  #include <common>
  #include <skinning_pars_vertex>
  attribute float aUpper; // (see markTopHalf)
  varying vec3 vWorld;
  varying float vUpper;
  void main() {
    vUpper = aUpper;
    #include <skinbase_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    vec4 w = modelMatrix * vec4(transformed, 1.0);
    vWorld = w.xyz;
  #ifdef PAINT
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); // where it is in the texture
  #else
    gl_Position = projectionMatrix * viewMatrix * w;
  #endif
  }`;
const probeMat = new THREE.ShaderMaterial({
  uniforms: { uCut: { value: 0 } }, // (1: its top half's gone, shots go through where it was: see cutBody)
  vertexShader: woundVertex,
  fragmentShader: `uniform float uCut;\nvarying vec3 vWorld;\nvarying float vUpper;
void main() { if (uCut > 0.5 && vUpper > 0.5) discard; gl_FragColor = vec4(distance(vWorld, cameraPosition), 0.0, 0.0, 1.0); }`,
  side: THREE.DoubleSide,
});
const PROBE_MAX = 8; // the most demons one shot probes (the nearest along it)
const probeRT = new THREE.WebGLRenderTarget(PROBE_MAX, 1, { type: THREE.FloatType, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
const probeCam = new THREE.OrthographicCamera(-0.005, 0.005, 0.005, -0.005, 0.01, 200);
// Renders a demon with its mesh's material swapped (its pose current) into target, cleared to transparent black
// first or drawn over what's there; the renderer's state is put back after
function renderDemon(npc, mat, target, cam, clear) {
  const model = npc.imp.model, mesh = npc.mesh, keep = mesh.material, culled = mesh.frustumCulled, parent = model.parent;
  probeMat.uniforms.uCut.value = (npc.corpse ?? npc).cut ? 1 : 0;
  const autoClear = renderer.autoClear, alpha = renderer.getClearAlpha(), rt = renderer.getRenderTarget();
  renderer.getClearColor(_clearColor);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = clear;
  if (parent) parent.remove(model);
  mesh.material = mat; mesh.frustumCulled = false;
  const others = []; // only its body: anything else it carries (the police's rifle) would draw in its own colours
  model.traverse((o) => { if (o.isMesh && o !== mesh && o.visible) { o.visible = false; others.push(o); } });
  renderer.setRenderTarget(target);
  renderer.render(model, cam);
  for (const o of others) o.visible = true;
  mesh.material = keep; mesh.frustumCulled = culled;
  if (parent) parent.add(model);
  renderer.setRenderTarget(rt);
  renderer.autoClear = autoClear;
  renderer.setClearColor(_clearColor, alpha);
}
// How far along the shot (origin o, direction dir) it first touches each of these demons' bodies: each drawn into its
// own texel of probeRT (alpha 1: touched; the first clears it all), read back without waiting for the GPU (a blocking
// read stalled every shot until the GPU had finished all its queued work: painful on a slow one). Resolves to the texels.
function probeShot(near, o, dir) {
  probeCam.position.copy(o);
  probeCam.lookAt(_v.copy(o).add(dir));
  probeCam.updateMatrixWorld();
  near.forEach((c, k) => {
    probeRT.viewport.set(k, 0, 1, 1);
    renderDemon(c.npc, probeMat, probeRT, probeCam, k === 0);
  });
  probeRT.viewport.set(0, 0, PROBE_MAX, 1);
  const buf = new Float32Array(PROBE_MAX * 4);
  return renderer.readRenderTargetPixelsAsync(probeRT, 0, 0, PROBE_MAX, 1, buf).then(() => buf);
}
const woundMat = new THREE.ShaderMaterial({
  defines: { PAINT: '' },
  uniforms: { uHit: { value: new THREE.Vector3() }, uSeed: { value: 0 } },
  vertexShader: woundVertex,
  fragmentShader: `
    uniform vec3 uHit;
    uniform float uSeed;
    varying vec3 vWorld;
    float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7)) + uSeed) * 43758.5453); }
    float vnoise(vec3 p) {
      vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }
    void main() {
      vec3 d = vWorld - uHit;
      d.y = d.y > 0.0 ? d.y * 1.5 : d.y / ${WOUND_RUN.toFixed(1)}; // runs down further than it spreads up
      float r = length(d) / ${WOUND_RADIUS.toFixed(3)} + 0.45 * (vnoise(vWorld * 60.0) - 0.5) + 0.25 * (vnoise(vWorld * 150.0) - 0.5);
      float v = 1.0 - smoothstep(0.55, 1.0, r);
      // smeared round it: a fainter, patchy stain out to twice its size
      v = max(v, 0.4 * (1.0 - smoothstep(1.0, 2.0, r)) * step(0.45, vnoise(vWorld * 35.0)));
      // runs: a few thin streaks running straight down the body from the wound (vertical lines in the world, each its
      // own length), thinning towards the end
      for (int k = 0; k < ${WOUND_STREAKS}; k++) {
        float fk = float(k);
        vec2 off = (vec2(hash(vec3(fk, 1.0, 2.0)), hash(vec3(fk, 3.0, 4.0))) - 0.5) * ${(WOUND_RADIUS * 1.2).toFixed(3)};
        float len = ${WOUND_STREAK_LEN.toFixed(2)} * (0.3 + 0.7 * hash(vec3(fk, 5.0, 6.0))), down = uHit.y - vWorld.y;
        float along = clamp(down / len, 0.0, 1.0);
        float w = 0.03 * (1.0 - 0.6 * along) * (0.7 + 0.6 * vnoise(vWorld * 90.0));
        if (down > 0.0 && down < len && length(vWorld.xz - uHit.xz - off) < w) v = max(v, 0.9 - 0.3 * along);
      }
      // spatter: specks flung round it, sparser further out
      float far = length(vWorld - uHit) / ${WOUND_SPATTER.toFixed(2)};
      if (far < 1.0 && vnoise(vWorld * 110.0) > 0.6 + 0.3 * far) v = max(v, 0.8 - 0.4 * far);
      if (v <= 0.0) discard;
      gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
    }`,
  side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
});
const woundCam = new THREE.Camera(); // unused by the UV-space pass, but render() wants one
export function paintWound(npc, at) {
  woundMat.uniforms.uHit.value.copy(at);
  woundMat.uniforms.uSeed.value = Math.random() * 100;
  renderDemon(npc, woundMat, npc.bloodRT, woundCam, false);
  npc.imp.lastKey = undefined; // its sprite re-renders with the new wound
}
// The demons' material: a copy each, its roughnessMap slot carrying that demon's blood mask (three binds a map per
// material, so they all share one program)
export function bloodyMaterial(mat, mask) {
  const m = mat.clone();
  m.roughnessMap = mask;
  m.userData.cut = { value: 0 }; // (1: its top half blown off: see cutBody)
  m.side = THREE.DoubleSide; // (from the start: its back faces dropped till it's cut, see below; switched by a cut, its
  // program was rebuilt mid-burst, a stall)
  m.onBeforeCompile = bloodOnBeforeCompile;
  return m;
}
function bloodOnBeforeCompile(shader) { // (this: the material)
  shader.uniforms.uCut = this.userData.cut;
  shader.vertexShader = 'attribute float aUpper;\nvarying float vUpper;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vUpper = aUpper;');
  shader.fragmentShader = 'uniform float uCut;\nvarying float vUpper;\n' + shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  if (uCut > 0.5 ? vUpper > 0.5 : !gl_FrontFacing) discard; // cut: its top half blown off (see markTopHalf); else its back faces, as culling would`).replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  float blood = texture2D(roughnessMap, vRoughnessMapUv).r; // the wound mask (see paintWound)
  // wet red: brighter scarlet where it's thin (the edges, runs and specks), deep red where it's pooled; glossy
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.45, 0.015, 0.025), vec3(0.2, 0.004, 0.01), blood), min(blood * 1.6, 1.0));
  roughnessFactor = mix(roughnessFactor, 0.15, blood);
#endif
  if (!gl_FrontFacing) { diffuseColor.rgb = vec3(0.3, 0.025, 0.03); roughnessFactor = 0.2; } // inside, open at a cut: wet flesh`);
}

