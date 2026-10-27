// Spent casings and shells; the muzzle's halo and smoke
import './holes.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { renderer, scene } from './setup.js';
import { ARENA, floorAt } from './arena.js';
import { camera } from './camera.js';
import { PISTOL, GUN_FLASH_TIME, GUN_BANG_TIME, gun } from './weapons.js';
import { bloodLight } from './blood-sheets.js';
import { playShellDrop } from './audio.js';
import { _v } from './enemies.js';

// Spent casings: each shot throws one out of the M4's ejection port, to your right. Sprites, like everything else:
// the casing model (models/bullet_case: its tall, bottlenecked rifle casing, pCylinder3; the other is a
// straight-walled one) is rendered once at load into CASE_FRAMES frames of CASE_PX px, a full turn of it end over
// end (seen a little from above, so its mouth and base show as it turns), lit by a plain key light and the room's
// environment. In the world each casing is a quad facing you showing the frame for its tumble angle, multiplied by
// the light where it is (bloodLight, as the demons get it). It arcs out, falls, bounces a couple of times and lies
// on its side, for CASE_LIFE s. The shotgun's spent shells are baked the same way, from shellModel. Each kind
// (CASE_KINDS: its length, m) has its row in the one sheet, at the same pixels per cm: a frame CASE_PX px, showing
// CASE_SPAN m (the longest kind fills 90% of it), so casings of every weapon can lie about at once.
const CASE_MAX = 200, CASE_FRAMES = 16, CASE_LIFE = 30; // casings, frames, s
const CASE_KINDS = { rifle: 0.045, pistol: 0.03, shell: 0.07 }, CASE_ROW = Object.fromEntries(Object.keys(CASE_KINDS).map((k, i) => [k, i]));
const CASE_SPAN = 0.07, CASE_PX = 36;
const CASE_GRAVITY = 9.8, CASE_BOUNCE = 0.35; // m/s²; share of its speed a bounce keeps (upwards)
// bloodLight's inverse-square sum has no ceiling: right by the muzzle flash or a floor light a casing would get dozens
// of times the light all over (a real one shows a small highlight, not that), so it's capped, and so is the colour,
// below BLOOM_THRESHOLD: casings brighten near lights but never glow
const CASE_LIGHT_MAX = 1.5, CASE_COLOR_MAX = 2.0;
const caseRT = new THREE.WebGLRenderTarget(CASE_FRAMES * CASE_PX, Object.keys(CASE_KINDS).length * CASE_PX, {
  type: THREE.HalfFloatType, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter,
});
// A spent 12-gauge shell, along +Y: the red plastic hull (open at the mouth, where the crimp unfolded on firing) on a
// brass head with a rim, 70 mm long and 20.5 mm across
export function shellModel() {
  const shell = new THREE.Group(), R = 0.01025;
  const red = new THREE.MeshStandardMaterial({ color: 0xa8141a, roughness: 0.55, side: THREE.DoubleSide });
  const brass = new THREE.MeshStandardMaterial({ color: 0xd4a84a, metalness: 1, roughness: 0.3 });
  const part = (r, h, y, mat, open) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16, 1, open), mat);
    m.position.y = y + h / 2;
    shell.add(m);
  };
  part(R * 1.08, 0.0015, 0, brass);           // the rim
  part(R * 1.01, 0.0145, 0.0015, brass);      // the head
  part(R, 0.054, 0.016, red, true);           // the hull
  return shell;
}
export function bakeCasings(model, kind) { // into its kind's row (see CASE_KINDS)
  const inner = new THREE.Group(), pivot = new THREE.Group();
  inner.add(model.clone(true));
  pivot.add(inner);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner), size = box.getSize(new THREE.Vector3());
  inner.position.copy(box.getCenter(new THREE.Vector3())).negate();
  pivot.scale.setScalar((1.8 / size.y) * (CASE_KINDS[kind] / CASE_SPAN)); // its length (model Y): 90% of a frame at CASE_SPAN
  const bake = new THREE.Scene(), key = new THREE.DirectionalLight(0xfff0d8, 2.5);
  bake.environment = scene.environment;
  key.position.set(-1, 2, 3);
  bake.add(key, pivot);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  cam.position.z = 5;
  const alpha = renderer.getClearAlpha(), clear = new THREE.Color();
  renderer.getClearColor(clear);
  renderer.setClearColor(0x000000, 0);
  caseRT.scissorTest = true;
  for (let k = 0; k < CASE_FRAMES; k++) {
    pivot.rotation.set(0.5, 0, (k / CASE_FRAMES) * 2 * Math.PI); // turned in your view's plane, tipped towards you
    caseRT.viewport.set(k * CASE_PX, CASE_ROW[kind] * CASE_PX, CASE_PX, CASE_PX);
    caseRT.scissor.copy(caseRT.viewport);
    renderer.setRenderTarget(caseRT);
    renderer.render(bake, cam);
  }
  renderer.setRenderTarget(null);
  renderer.setClearColor(clear, alpha);
}
const casePos = new Float32Array(CASE_MAX * 3), caseVel = new Float32Array(CASE_MAX * 3);
const caseAngle = new Float32Array(CASE_MAX), caseSpin = new Float32Array(CASE_MAX), caseLife = new Float32Array(CASE_MAX);
const caseLanded = new Uint8Array(CASE_MAX); // its drop sound played
const caseKind = new Float32Array(CASE_MAX); // its row (see CASE_KINDS)
let caseNext = 0;
const caseGeo = new THREE.InstancedBufferGeometry();
{
  const quad = new THREE.PlaneGeometry(1, 1);
  caseGeo.index = quad.index;
  caseGeo.setAttribute('position', quad.attributes.position);
}
const caseAttr = (name, n) => {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(CASE_MAX * n), n).setUsage(THREE.DynamicDrawUsage);
  caseGeo.setAttribute(name, a);
  return a;
};
const caseAttrPos = caseAttr('aPos', 3), caseAttrLight = caseAttr('aLight', 3), caseAttrFrame = caseAttr('aFrame', 1), caseAttrKind = caseAttr('aKind', 1);
caseGeo.instanceCount = 0;
const casings = new THREE.Mesh(caseGeo, new THREE.ShaderMaterial({
  uniforms: { uSheet: { value: caseRT.texture }, uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0 } },
  vertexShader: `
    attribute vec3 aPos, aLight;
    attribute float aFrame, aKind;
    varying vec2 vUv;
    varying vec3 vLight;
    varying float vZ;
    void main() {
      vec4 c = viewMatrix * vec4(aPos, 1.0);
      c.xy += position.xy * ${(CASE_SPAN / 0.9).toFixed(4)}; // facing you; a frame shows CASE_SPAN in 90% of it
      vUv = vec2((position.x + 0.5 + aFrame) / ${CASE_FRAMES}.0, (position.y + 0.5 + aKind) / ${Object.keys(CASE_KINDS).length}.0);
      vLight = min(aLight, vec3(${CASE_LIGHT_MAX.toFixed(1)})); vZ = -c.z;
      gl_Position = projectionMatrix * c;
    }`,
  fragmentShader: `
    uniform sampler2D uSheet;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    varying vec2 vUv;
    varying vec3 vLight;
    varying float vZ;
    void main() {
      vec4 t = texture2D(uSheet, vUv);
      if (t.a < 0.5) discard;
      gl_FragColor = vec4(mix(min(t.rgb / t.a * vLight, vec3(${CASE_COLOR_MAX.toFixed(1)})), uFogColor, 1.0 - exp(-uFogDensity * uFogDensity * vZ * vZ)), 1.0);
    }`,
}));
casings.frustumCulled = false;
scene.add(casings);
export const _cr = new THREE.Vector3(), _cu = new THREE.Vector3(), _cf = new THREE.Vector3();
export function ejectCasing() { // out of the port: right of and a little below your eye, just ahead
  camera.getWorldDirection(_cf);
  _cr.crossVectors(_cf, camera.up).normalize();
  _cu.crossVectors(_cr, _cf);
  const p = _v.copy(camera.position).addScaledVector(_cr, 0.14).addScaledVector(_cu, -0.12).addScaledVector(_cf, 0.45);
  dropCasing(p, _cr.clone().multiplyScalar(2.2 + Math.random()).addScaledVector(_cu, 1.2 + Math.random() * 0.8).addScaledVector(_cf, (Math.random() - 0.7) * 0.6), PISTOL ? 'pistol' : 'rifle');
}
export function dropCasing(p, v, kind) { // a casing (of a kind: see CASE_KINDS) at p (world), flying at v (m/s)
  const i = caseNext++ % CASE_MAX, k = i * 3;
  caseKind[i] = CASE_ROW[kind];
  casePos.set([p.x, p.y, p.z], k);
  caseVel.set([v.x, v.y, v.z], k);
  caseAngle[i] = Math.random() * 2 * Math.PI;
  caseSpin[i] = (Math.random() < 0.5 ? -1 : 1) * (20 + Math.random() * 15);
  caseLife[i] = CASE_LIFE;
  caseLanded[i] = 0;
}
export function updateCasings(dt) {
  let n = 0;
  const P = caseAttrPos.array, F = caseAttrFrame.array, K = caseAttrKind.array;
  for (let i = 0; i < CASE_MAX; i++) {
    if (caseLife[i] <= 0) continue;
    if ((caseLife[i] -= dt) <= 0) continue;
    const k = i * 3, y0 = casePos[k + 1]; // (where it was)
    caseVel[k + 1] -= CASE_GRAVITY * dt;
    for (let c = 0; c < 3; c++) casePos[k + c] += caseVel[k + c] * dt;
    caseAngle[i] += caseSpin[i] * dt;
    for (const c of [0, 2]) if (Math.abs(casePos[k + c]) > ARENA - 0.02) { // the walls
      casePos[k + c] = Math.sign(casePos[k + c]) * (ARENA - 0.02); caseVel[k + c] *= -0.4;
    }
    const ground = floorAt(casePos[k], casePos[k + 2], y0) + 0.008; // lying: its radius
    if (casePos[k + 1] < ground && caseVel[k + 1] <= 0) { // (not going up: up into a high step from under it, it isn't on it)
      casePos[k + 1] = ground;
      if (!caseLanded[i]) { // its first landing: the clink (the sound has its own little bounces after)
        caseLanded[i] = 1;
        playShellDrop(Math.hypot(casePos[k] - camera.position.x, casePos[k + 2] - camera.position.z));
      }
      if (caseVel[k + 1] < -0.6) { // a bounce: up a little, slowed, spinning less
        caseVel[k + 1] *= -CASE_BOUNCE; caseVel[k] *= 0.6; caseVel[k + 2] *= 0.6; caseSpin[i] *= 0.5;
      } else { // settled: slides to a stop on its side
        caseVel[k + 1] = 0; caseVel[k] *= 0.85; caseVel[k + 2] *= 0.85; caseSpin[i] = 0;
        caseAngle[i] = (Math.round(caseAngle[i] / Math.PI - 0.5) + 0.5) * Math.PI;
      }
    }
    P.set(casePos.subarray(k, k + 3), n * 3);
    bloodLight(casePos[k], casePos[k + 1], casePos[k + 2], caseAttrLight.array, n * 3);
    const turn = ((caseAngle[i] / (2 * Math.PI)) % 1 + 1) % 1;
    K[n] = caseKind[i];
    F[n++] = Math.round(turn * CASE_FRAMES) % CASE_FRAMES;
  }
  caseGeo.instanceCount = n;
  caseAttrPos.needsUpdate = caseAttrLight.needsUpdate = caseAttrFrame.needsUpdate = caseAttrKind.needsUpdate = true;
  casings.material.uniforms.uFogColor.value.copy(scene.fog.color);
  casings.material.uniforms.uFogDensity.value = scene.fog.density;
}

// The flash's glow: the gun is drawn over the finished frame, after bloom, so its flash can't glow. A bright,
// disc at the muzzle's place in the world (where its light goes) for the bang does: far over
// BLOOM_THRESHOLD at its core, so the bloom pass spreads it round the barrel like any light. A smooth falloff, not
// pixelated: it's the light, not a shape (so close to your eye, its pixels would be big glowing squares).
const HALO_SIZE = 0.3, HALO_PEAK = 9; // m across; core brightness
export const halo = new THREE.Mesh(new THREE.PlaneGeometry(HALO_SIZE, HALO_SIZE), new THREE.ShaderMaterial({
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      c.xy += position.xy; // facing you
      gl_Position = projectionMatrix * c;
    }`,
  fragmentShader: `
    varying vec2 vUv;
    void main() {
      float g = max(1.0 - length(vUv * 2.0 - 1.0), 0.0);
      if (g <= 0.0) discard;
      gl_FragColor = vec4(vec3(1.0, 0.72, 0.38) * ${HALO_PEAK}.0 * g * g * g, 1.0);
    }`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
}));
halo.frustumCulled = false;
halo.visible = false;
scene.add(halo);

// Smoke: each shot leaves a wisp at the muzzle that rises, drifts and spreads, thinning out over SMOKE_LIFE.
// Grey pixels, lit where they are (bloodLight, capped like the casings), each see-through (at most SMOKE_OPACITY,
// in SMOKE_LEVELS steps so it stays pixel art), thinning towards its ragged edge and as it ages.
const SMOKE_MAX = 48, SMOKE_LIFE = 0.7, SMOKE_PX = 10; // wisps; s; px across one
const SMOKE_OPACITY = 0.3, SMOKE_LEVELS = 3; // the most a smoke pixel covers what's behind it; steps of it (pixel art)
const smokePos = new Float32Array(SMOKE_MAX * 3), smokeVel = new Float32Array(SMOKE_MAX * 3), smokeAge = new Float32Array(SMOKE_MAX).fill(SMOKE_LIFE);
let smokeNext = 0;
const smokeGeo = new THREE.InstancedBufferGeometry();
{
  const quad = new THREE.PlaneGeometry(1, 1);
  smokeGeo.index = quad.index;
  smokeGeo.setAttribute('position', quad.attributes.position);
}
const smokeAttr = (name, n) => {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(SMOKE_MAX * n), n).setUsage(THREE.DynamicDrawUsage);
  smokeGeo.setAttribute(name, a);
  return a;
};
const smokeAttrPos = smokeAttr('aPos', 3), smokeAttrLight = smokeAttr('aLight', 3), smokeAttrT = smokeAttr('aT', 1), smokeAttrSeed = smokeAttr('aSeed', 1);
smokeGeo.instanceCount = 0;
const smoke = new THREE.Mesh(smokeGeo, new THREE.ShaderMaterial({
  uniforms: { uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0 } },
  vertexShader: `
    attribute vec3 aPos, aLight;
    attribute float aT, aSeed;
    varying vec2 vUv;
    varying vec3 vLight;
    varying float vT, vSeed, vZ;
    void main() {
      vec4 c = viewMatrix * vec4(aPos, 1.0);
      c.xy += position.xy * (0.05 + 0.22 * aT); // spreads as it rises
      vUv = position.xy + 0.5; vLight = min(aLight, vec3(${CASE_LIGHT_MAX.toFixed(1)})); vT = aT; vSeed = aSeed; vZ = -c.z;
      gl_Position = projectionMatrix * c;
    }`,
  fragmentShader: `
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    varying vec2 vUv;
    varying vec3 vLight;
    varying float vT, vSeed, vZ;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + vSeed) * 43758.5453); }
    void main() {
      vec2 px = floor(vUv * ${SMOKE_PX}.0);
      vec2 q = (px + 0.5) / ${SMOKE_PX}.0 * 2.0 - 1.0;
      float dens = clamp((1.0 - length(q) - 0.35 * hash(px)) * (1.0 - vT) * 1.4, 0.0, 1.0); // ragged, thinning
      float a = floor(dens * ${SMOKE_LEVELS}.0 + 0.5) / ${SMOKE_LEVELS}.0 * ${SMOKE_OPACITY.toFixed(2)}; // in steps
      if (a <= 0.0) discard;
      vec3 col = vec3(0.32, 0.31, 0.3) * vLight;
      gl_FragColor = vec4(mix(col, uFogColor, 1.0 - exp(-uFogDensity * uFogDensity * vZ * vZ)), a);
    }`,
  transparent: true, depthWrite: false,
}));
smoke.frustumCulled = false;
scene.add(smoke);
export function puffSmoke(at) {
  const i = smokeNext++ % SMOKE_MAX, k = i * 3;
  camera.getWorldDirection(_cf);
  smokePos.set([at.x, at.y, at.z], k);
  smokeVel.set([_cf.x * 0.4 + (Math.random() - 0.5) * 0.15, 0.35 + Math.random() * 0.2, _cf.z * 0.4 + (Math.random() - 0.5) * 0.15], k);
  smokeAge[i] = 0;
  smokeAttrSeed.array[i] = Math.random() * 100;
}
export function updateMuzzleFx(dt, now) {
  halo.visible = !!gun && now < gun.flashUntil - (GUN_FLASH_TIME - GUN_BANG_TIME); // the bang only
  let n = 0;
  for (let i = 0; i < SMOKE_MAX; i++) {
    if ((smokeAge[i] += dt) >= SMOKE_LIFE) continue;
    const k = i * 3;
    for (let c = 0; c < 3; c++) { smokePos[k + c] += smokeVel[k + c] * dt; smokeVel[k + c] *= Math.exp(-2.5 * dt); } // slows in the air
    smokeAttrPos.array.set(smokePos.subarray(k, k + 3), n * 3);
    bloodLight(smokePos[k], smokePos[k + 1], smokePos[k + 2], smokeAttrLight.array, n * 3);
    smokeAttrT.array[n] = smokeAge[i] / SMOKE_LIFE;
    smokeAttrSeed.array[n++] = smokeAttrSeed.array[i];
  }
  smokeGeo.instanceCount = n;
  smokeAttrPos.needsUpdate = smokeAttrLight.needsUpdate = smokeAttrT.needsUpdate = smokeAttrSeed.needsUpdate = true;
  smoke.material.uniforms.uFogColor.value.copy(scene.fog.color);
  smoke.material.uniforms.uFogDensity.value = scene.fog.density;
}

