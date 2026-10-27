// Gibs: bodies cut in half or blown apart, and their meat
import './portals.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { scene } from './setup.js';
import { texLoader } from './tiles.js';
import { ARENA, COLUMNS, COLUMN_APOTHEM, ceilingAt, floorAt } from './arena.js';
import { camera } from './camera.js';
import { SPLAT_SCALE } from './weapons.js';
import { spawnDecal } from './decals.js';
import { playSquelch } from './blood-maps.js';
import { burstBlood, bleeds, startBleed, throwUnflown } from './blood-fluid.js';
import { bloodLight } from './blood-sheets.js';
import { BURST_GOBS_MAX } from './shots.js';
import { playSound } from './audio.js';
import { splashLens } from './hud.js';
import { corpses } from './enemies.js';
import { clock } from './main.js';

// Meat textures (textures/meat_*.png: see tools/meat_textures.py): pixels (nearest, as the sprites'), no mipmaps (they
// ate the silhouettes away with distance); lit no brighter than MEAT_LIGHT_MAX (see the gibs)
const MEAT_LIGHT_MAX = 3;
const meatMap = (file, color, onLoad) => {
  const t = texLoader.load(`textures/${file}.png`, onLoad);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  return t;
};
// Gibs: bodies shot to pieces. Every bullet or pellet that hits a body adds to its trauma, which leaks away (to 1/e in
// GIB_TAU s); a hit's traumatic when that reaches GIB_TRAUMA (two-thirds of the M4's magazine in one spray, or a
// shotgun blast up close: most of one blast's 16 pellets).
// - Shredded as it dies (it died with at least GIB_KILL_MIN on it, and its trauma, carried on into its corpse, gets
//   there within GIB_KILL_WINDOW s): a zombie or an officer loses its top half (from the waist up: what its spine, arms
//   and head move, see markTopHalf), its legs left a carcass, open at the waist, the stump gushing (GIB_GUSH spurts). A
//   demon doesn't: too big (it would take something explosive).
// - A carcass (a whole corpse, or its legs, down: done falling) whose own trauma (counted from then) gets there
//   bursts, all of it: its sprite and mesh go.
// Either way, from what bursts: blood (GIB_BURSTS full bursts, as hard as GIB_BLOOD_SPEED, as wide as
// GIB_BLOOD_SPLAT; GIB_STAINS more thrown over the floor; a splash on your lens up close) and GIB_BITS bits, all of it
// in small pieces (no big chunk left lying: a heap of meat read as dung), flying out of its bones (textures/meat_bits.png),
// away from you, tumbling (the sheet's frames: a full turn), each splatting where it lands (GIB_BIT_STAIN m), lying
// there for good (the oldest reused past GIB_MAX): small, spread out over its blood, so the bloodied floor isn't flat
// (as grass is to the ground). Each bit's a quad facing you, lit like the blood (see bloodLight: the light where it is,
// capped at MEAT_LIGHT_MAX, from its main direction on the sheet's normals, a wet glint), fogged like the casings.
export const GIB_TRAUMA = 12, GIB_TAU = 1.2, GIB_BITS = 30, GIB_MAX = 1200; // hits; s; bits a burst; bits at once (14 of 16
// pellets: a blast up close often had only 13 land; the pistol, as fast as it fires, tops out at 10.5)
// (ponytail: every bit's relit every frame, about 0.5 ms for GIB_MAX of them lying still; relight the still ones in
// turns if more are wanted)
export const GIB_KILL_MIN = 5, GIB_KILL_WINDOW = 1.5; // hits; s (see above: shredded as it dies)
const GIB_SCALE = [0.4, 0.8]; // × a bit's frame (small, a few, spread over its blood: big ones were too big on screen;
// many, too many)
const GIB_BURSTS = 1, GIB_BLOOD_SPEED = 1.3, GIB_BLOOD_SPLAT = 1.2, GIB_STAINS = 60, GIB_GUSH = 5; // ; × a hit's; × the
// weapon's splats; gobs; spurts (BLEED_EVERY apart: 0.4 s; 3 s, then 1.6, then 0.8, dragged on): the burst a big splash
// (three, harder, was too much), the stump's gush the show
const GIB_BIT_STAIN = [0.04, 0.1]; // m: a landing bit's splat
const GIB_KINDS = 6, GIB_FRAMES = 8, GIB_SIZE = 16 * 0.015; // the sheet's rows (chunk, fatty, bone, gut, flap, clot) and
// frames; m a frame (its BIT px at PX)
const GIB_PICK = [0, 0, 0, 0, 0, 1, 2, 3, 3, 4, 4, 5, 5]; // which kinds fly out, by share: chunks most
const TOP_HALF = /spine|chest|neck|head|shoulder|arm|hand|gun/i; // a body's top half: its bones' names, Mixamo's or the
// demon's (its gun arm too; the hips and legs not)
// Each vertex's share of the top half (aUpper: how much of it the top half's bones move), on the enemy's own geometry
// (its clones share it); a cut body draws (and is hit) only where that's under a half
export function markTopHalf(root) {
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const top = o.skeleton.bones.map((b) => (TOP_HALF.test(b.name) ? 1 : 0));
    const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight, up = new Float32Array(si.count);
    for (let v = 0; v < si.count; v++) for (let k = 0; k < 4; k++) up[v] += top[si.getComponent(v, k)] * sw.getComponent(v, k);
    o.geometry.setAttribute('aUpper', new THREE.BufferAttribute(up, 1));
  });
}
// A hit on a body: its trauma (and a corpse's carcass trauma: since it died, or was cut), leaked away since its last
// hit, and these hits on top
export function traumatize(body, hits, now) {
  const leak = Math.exp(-(now - (body.hurtAt ?? now)) / GIB_TAU);
  body.trauma = (body.trauma ?? 0) * leak + hits;
  if (body.dead) body.carcass = (body.carcass ?? 0) * leak + hits;
  body.hurtAt = now;
}
const gibPos = new Float32Array(GIB_MAX * 3), gibVel = new Float32Array(GIB_MAX * 3), gibAngle = new Float32Array(GIB_MAX);
const gibSpin = new Float32Array(GIB_MAX), gibKind = new Float32Array(GIB_MAX), gibMirror = new Float32Array(GIB_MAX);
const gibSize = new Float32Array(GIB_MAX), gibLive = new Uint8Array(GIB_MAX), gibLanded = new Uint8Array(GIB_MAX);
let gibNext = 0;
// Each frame's foot: how far below its middle its lowest pixel is (px), so a bit lies on it (at its middle, the floor cut
// its bottom off); measured off the sheet when it's loaded
const gibFoot = new Float32Array(GIB_KINDS * GIB_FRAMES).fill(3);
function measureGibFeet(t) {
  const N = t.image.height / GIB_KINDS, ctx = Object.assign(document.createElement('canvas'), { width: t.image.width, height: t.image.height }).getContext('2d');
  ctx.drawImage(t.image, 0, 0);
  const a = ctx.getImageData(0, 0, t.image.width, t.image.height).data;
  for (let r = 0; r < GIB_KINDS; r++) for (let f = 0; f < GIB_FRAMES; f++) {
    let low = N / 2; // (its lowest opaque row, from the frame's top)
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (a[((r * N + y) * t.image.width + f * N + x) * 4 + 3] >= 128) low = Math.max(low, y + 1);
    gibFoot[r * GIB_FRAMES + f] = low - N / 2;
  }
}
const gibGeo = new THREE.InstancedBufferGeometry();
{
  const quad = new THREE.PlaneGeometry(1, 1);
  gibGeo.index = quad.index;
  gibGeo.setAttribute('position', quad.attributes.position);
}
const gibAttr = (name, n) => {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(GIB_MAX * n), n).setUsage(THREE.DynamicDrawUsage);
  gibGeo.setAttribute(name, a);
  return a;
};
const gibAttrPos = gibAttr('aPos', 3), gibAttrLight = gibAttr('aLight', 3), gibAttrDir = gibAttr('aLightDir', 3);
const gibAttrFrame = gibAttr('aFrame', 1), gibAttrKind = gibAttr('aKind', 1), gibAttrMirror = gibAttr('aMirror', 1), gibAttrSize = gibAttr('aSize', 1);
gibGeo.instanceCount = 0;
const gibs = new THREE.Mesh(gibGeo, new THREE.ShaderMaterial({
  uniforms: { uColor: { value: meatMap('meat_bits', true, measureGibFeet) }, uNormal: { value: meatMap('meat_bits_n', false) },
    uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0 } },
  vertexShader: `
    attribute vec3 aPos, aLight, aLightDir;
    attribute float aFrame, aKind, aMirror, aSize;
    varying vec2 vUv;
    varying vec3 vLight, vL;
    varying float vZ, vMirror;
    void main() {
      vec4 c = viewMatrix * vec4(aPos, 1.0);
      c.xy += position.xy * ${GIB_SIZE.toFixed(3)} * aSize; // facing you
      float u = aMirror > 0.5 ? -position.x : position.x;
      vUv = vec2((u + 0.5 + aFrame) / ${GIB_FRAMES}.0, 1.0 - (aKind + 0.5 - position.y) / ${GIB_KINDS}.0); // (row 0: the sheet's top)
      vLight = min(aLight, vec3(${MEAT_LIGHT_MAX.toFixed(1)}));
      vL = normalize((viewMatrix * vec4(aLightDir, 0.0)).xyz); // (the sheet's normals are as you see them: in your view's axes)
      vZ = -c.z; vMirror = aMirror;
      gl_Position = projectionMatrix * c;
    }`,
  fragmentShader: `
    uniform sampler2D uColor, uNormal;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    varying vec2 vUv;
    varying vec3 vLight, vL;
    varying float vZ, vMirror;
    void main() {
      vec4 col = texture2D(uColor, vUv);
      if (col.a < 0.5) discard;
      vec4 t = texture2D(uNormal, vUv);
      vec3 n = normalize(t.xyz * 2.0 - 1.0);
      if (vMirror > 0.5) n.x = -n.x;
      float d = max(dot(n, vL), 0.0), glint = pow(max(dot(n, normalize(vL + vec3(0.0, 0.0, 1.0))), 0.0), 40.0) * t.a;
      vec3 c = col.rgb * vLight * (0.35 + d) + vLight * glint * 0.6;
      gl_FragColor = vec4(mix(c, uFogColor, 1.0 - exp(-uFogDensity * uFogDensity * vZ * vZ)), 1.0);
    }`,
}));
gibs.frustumCulled = false;
scene.add(gibs);
function spawnGib(p, v) { // a bit of a body at p (world), flying at v (m/s), of a kind at random (see GIB_PICK)
  const i = gibNext++ % GIB_MAX, k = i * 3;
  gibPos.set([p.x, p.y, p.z], k);
  gibVel.set([v.x, v.y, v.z], k);
  gibKind[i] = GIB_PICK[(Math.random() * GIB_PICK.length) | 0];
  gibAngle[i] = Math.random() * 2 * Math.PI;
  gibSpin[i] = (Math.random() < 0.5 ? -1 : 1) * (8 + Math.random() * 10);
  gibMirror[i] = Math.random() < 0.5 ? 1 : 0;
  gibSize[i] = GIB_SCALE[0] + Math.random() * (GIB_SCALE[1] - GIB_SCALE[0]);
  gibLive[i] = 1; gibLanded[i] = 0;
}
const _gibP = new THREE.Vector3(), _gibV = new THREE.Vector3(), _gibC = new THREE.Vector3();
const _gibS = new THREE.Vector3(), _gibW = new THREE.Vector3();
// Out of a body (c), by hit (its entry and dir), from these bones (where they are now: standing, falling or lying):
// blood, its bursts (each from somewhere else in it) and more thrown over the floor, a splash on your lens up close;
// its bits, out of them every way, up, and away from you; the sound
function burstFrom(c, hit, bones) {
  c.imp.model.updateMatrixWorld(true);
  const mid = new THREE.Vector3(), now = clock.elapsedTime;
  for (const b of bones) mid.add(b.getWorldPosition(_gibP));
  mid.divideScalar(bones.length);
  for (let k = 0; k < GIB_BURSTS; k++) {
    burstBlood({ entry: bones[(Math.random() * bones.length) | 0].getWorldPosition(_gibP).clone(), dir: hit.dir }, BURST_GOBS_MAX, GIB_BLOOD_SPEED, SPLAT_SCALE * GIB_BLOOD_SPLAT);
  }
  throwUnflown({ entry: mid, dir: hit.dir }, GIB_STAINS, now);
  splashLens(mid);
  for (let k = 0; k < GIB_BITS; k++) {
    const from = bones[(Math.random() * bones.length) | 0].getWorldPosition(_gibP);
    const a = Math.random() * 2 * Math.PI, out = 0.4 + 2.4 * Math.random(); // (landing all over a couple of metres round it)
    _gibV.set(Math.cos(a) * out, 1.2 + Math.random() * 2.5, Math.sin(a) * out).addScaledVector(hit.dir, 0.3 + Math.random() * 1.2);
    spawnGib(from, _gibV);
  }
  const fall = 1 + mid.distanceTo(camera.position) * 0.12; // (quieter the further off, as a demon's voice)
  playSquelch(1.2 / fall, 0.55);
  playSound('punch', 0.8 / fall, 0.1);
}
const NOT_FINGERS = (b) => !/index|thumb|middle|ring|pinky|_end/i.test(b.name);
// A zombie's or an officer's corpse, shredded as it died (see Gibs): its top half shot to pieces, its legs left
export function cutBody(c, hit) {
  c.cut = true;
  c.voices?.forEach((v) => v.stop()); // (its head gone with it: not a sound more from it, its death cry, a growl, a moan;
  // none, shredded by the shot that killed it)
  c.carcass = 0; // (its legs: a carcass of their own now)
  const mat = c.mesh.material, now = clock.elapsedTime;
  mat.userData.cut.value = 1; // (its inside shows, where it's open: see bloodOnBeforeCompile)
  c.imp.model.traverse((o) => { if (o.isMesh && o !== c.mesh) o.visible = false; }); // (an officer's rifle goes with its hands)
  c.imp.ownShadow = true; c.imp.lastKey = c.imp.shadowKey = undefined; // (redrawn, its sprite and shadow, if it had settled)
  burstFrom(c, hit, c.imp.bones.filter((b) => TOP_HALF.test(b.name) && NOT_FINGERS(b)));
  // the stump gushes (from its waist, following it as its legs fall)
  const spine = c.imp.bones.find((b) => /spine/i.test(b.name)), hips = c.imp.bones.find((b) => /hips/i.test(b.name)); // (the lowest)
  const waist = (spine ?? hips).getWorldPosition(new THREE.Vector3());
  startBleed({ npc: c, entry: waist, dir: _gibV.set(0, -1, 0) }, now, GIB_GUSH);
  if (spine && hips) Object.assign(bleeds.at(-1), { bone: spine, root: hips });
}
// A carcass (see corpses: a whole body, or a cut one's legs) shot to pieces: all that's left of it
export function gibBody(c, hit) {
  c.gone = true;
  c.voices?.forEach((v) => v.stop()); // (its head with the rest of it: see cutBody)
  corpses.splice(corpses.indexOf(c), 1);
  for (let k = bleeds.length - 1; k >= 0; k--) if ((bleeds[k].npc.corpse ?? bleeds[k].npc) === c) bleeds.splice(k, 1);
  burstFrom(c, hit, c.imp.bones.filter((b) => NOT_FINGERS(b) && !(c.cut && TOP_HALF.test(b.name)))); // (its legs, if that's all)
  c.imp.dispose(); c.bloodRT.dispose(); c.mesh.material.dispose();
}
const _gibL = [0, 0, 0], _gibD = [0, 0, 0];
export function updateGibs(dt) {
  let n = 0;
  const P = gibAttrPos.array, L = gibAttrLight.array, D = gibAttrDir.array, F = gibAttrFrame.array, K = gibAttrKind.array;
  const Mi = gibAttrMirror.array, S = gibAttrSize.array;
  for (let i = 0; i < GIB_MAX; i++) {
    if (!gibLive[i]) continue;
    const k = i * 3;
    if (gibVel[k] || gibVel[k + 1] || gibVel[k + 2]) { // flying, or sliding to a stop
      const x0 = gibPos[k], y0 = gibPos[k + 1], z0 = gibPos[k + 2]; // (where it was)
      gibVel[k + 1] -= 9.8 * dt;
      for (let c = 0; c < 3; c++) gibPos[k + c] += gibVel[k + c] * dt;
      gibAngle[i] += gibSpin[i] * dt;
      for (const c of [0, 2]) if (Math.abs(gibPos[k + c]) > ARENA - 0.05) { // the walls
        gibPos[k + c] = Math.sign(gibPos[k + c]) * (ARENA - 0.05); gibVel[k + c] *= -0.3;
      }
      for (const c of COLUMNS) { // the columns, at their own faces (not a demon's body out: bits stopped short of them),
        // bouncing off them; the towers are open steelwork (bits fly through)
        const r = COLUMN_APOTHEM / Math.cos(Math.PI / 8) + 0.05, dx = gibPos[k] - c.x, dz = gibPos[k + 2] - c.y, d = Math.hypot(dx, dz);
        if (d >= r || d < 1e-6) continue;
        const nx = dx / d, nz = dz / d, vn = gibVel[k] * nx + gibVel[k + 2] * nz;
        gibPos[k] = c.x + nx * r; gibPos[k + 2] = c.y + nz * r;
        if (vn < 0) { gibVel[k] -= 1.3 * vn * nx; gibVel[k + 2] -= 1.3 * vn * nz; }
      }
      const roof = ceilingAt(gibPos[k], gibPos[k + 2], y0); // (up into the balcony, or a high step, from under it: off it)
      if (gibPos[k + 1] > roof) { gibPos[k + 1] = roof - 0.01; gibVel[k + 1] = -0.3 * Math.abs(gibVel[k + 1]); } // (just under it)
      if (floorAt(gibPos[k], gibPos[k + 2], y0) > y0) { // the platform's or a step's side (it was below its top): a wall to it,
        gibPos[k] = x0; gibPos[k + 2] = z0; gibVel[k] *= -0.3; gibVel[k + 2] *= -0.3; // not a floor to jump up onto
      }
      const f = Math.round((((gibAngle[i] / (2 * Math.PI)) % 1 + 1) % 1) * GIB_FRAMES) % GIB_FRAMES;
      const ground = floorAt(gibPos[k], gibPos[k + 2], y0) + gibFoot[gibKind[i] * GIB_FRAMES + f] * 0.015 * gibSize[i]; // lying on its foot
      if (gibPos[k + 1] < ground) {
        gibPos[k + 1] = ground;
        if (!gibLanded[i]) { // its first landing: a splat, and a wet slap now and then (7 a burst or so: 24 at once was a roar)
          gibLanded[i] = 1;
          const under = floorAt(gibPos[k], gibPos[k + 2], y0); // (its stain on the floor under it: at its own height, it hung there)
          spawnDecal(_gibS.set(gibPos[k], under, gibPos[k + 2]), null, _gibW.set(gibVel[k], gibVel[k + 1], gibVel[k + 2]), 0,
            GIB_BIT_STAIN[0] + Math.random() * (GIB_BIT_STAIN[1] - GIB_BIT_STAIN[0]));
          const d = Math.hypot(gibPos[k] - camera.position.x, gibPos[k + 2] - camera.position.z);
          if (Math.random() < 7 / GIB_BITS) playSquelch(0.35 / (1 + d * 0.25), 1.4);
        }
        if (gibVel[k + 1] < -1.2) { // a bounce: up a little, slowed, turning less
          gibVel[k + 1] *= -0.25; gibVel[k] *= 0.5; gibVel[k + 2] *= 0.5; gibSpin[i] *= 0.4;
        } else { // down: it slides to a stop (wet meat doesn't roll)
          gibVel[k + 1] = 0; gibVel[k] *= 0.8; gibVel[k + 2] *= 0.8; gibSpin[i] = 0;
          if (Math.hypot(gibVel[k], gibVel[k + 2]) < 0.05) gibVel[k] = gibVel[k + 2] = 0; // (still: no more moving it)
        }
      }
    }
    P.set(gibPos.subarray(k, k + 3), n * 3);
    bloodLight(gibPos[k], gibPos[k + 1], gibPos[k + 2], L, n * 3, D);
    F[n] = Math.round((((gibAngle[i] / (2 * Math.PI)) % 1 + 1) % 1) * GIB_FRAMES) % GIB_FRAMES;
    K[n] = gibKind[i]; Mi[n] = gibMirror[i]; S[n++] = gibSize[i];
  }
  gibGeo.instanceCount = n;
  for (const a of [gibAttrPos, gibAttrLight, gibAttrDir, gibAttrFrame, gibAttrKind, gibAttrMirror, gibAttrSize]) a.needsUpdate = true;
  gibs.material.uniforms.uFogColor.value.copy(scene.fog.color);
  gibs.material.uniforms.uFogDensity.value = scene.fog.density;
}

