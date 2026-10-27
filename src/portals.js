// Portals: how the enemies come in
import './skulls.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { renderer, scene, PORTAL_LIGHT_COLOR, PORTAL_LIGHTS, PORTAL_INTENSITY, PORTAL_NEAR, PORTAL_NEAR_FADE,
  portalLights } from './setup.js';
import { ARENA, STRINGER_D, BALCONY_Y, overDeck, BALCONY_FLIGHT, floorAt } from './arena.js';
import { camera, composer, LENSES, lensPass } from './camera.js';
import { rayWorld } from './holes.js';
import { PORTAL_ZAPS, portalZap, playSound } from './audio.js';
import { AROUND, boxGap, platformGap } from './enemy-ai.js';
import { between } from './police.js';

// ---------------------------------------------------------------------------
// Portals
// ---------------------------------------------------------------------------
// How an enemy comes in: not all at once, nor out of nowhere. Each where it'll stand (or fly), after up to PORTAL_DELAY
// s, over PORTAL_TIME s:
// - waves of bent space round its point (lensing, see lensPass), their crests running in to it and dragged in after it
//   in streaks, as brush strokes; swelling as it grows
// - a point of light hangs at its middle, swelling and brightening, light drawn in to it from all round (streaks
//   rushing in, and sparks falling in to it, stretched by their speed, drifting off as embers once it's gone: see
//   sparkGeo); a real light too, for the
//   PORTAL_LIGHTS lighting you most (see portalLights: it lights the floor, the walls)
// - lightning out of it (a Lichtenberg figure: lightning's branching, in the air all round it: see crackle), reaching
//   further as it grows, its newest tips brightest, crackling (a new one every PORTAL_CRACKLE s or so), striking the
//   floor where it gets down to it
// - a streak of light through its point, straight up and down your view (as a lens, or an eye, smears a light this
//   bright: an astigmatism streak, not a thing in the room), drawing out, then fading again: gone as the enemy comes
//   through
// then it's there, built up from embers over PORTAL_BUILD s (burning backwards, out from its middle to its foot and its top;
// one of them, moving, fighting and to be shot, only once it's built): the point
// flares and is gone, a sphere of denser air bursts out round it (the world behind bent
// through it: see lensPass), fast at first, its index back to air's as it spreads, over PORTAL_LENS s; and the
// lightning dies away over PORTAL_FADE s. All of it light (added on, brighter than white: the bloom
// haloes it), in bands like the skulls' fire, fogged. It crackles as long as its lightning's there (a burst of sparks
// every PORTAL_ZAP s or so, one at random, louder as it grows), and what comes through comes with a whoosh, from its
// first pixels (see portalZap).
const PORTAL_TIME = 2.6, PORTAL_FADE = 0.9, PORTAL_DELAY = 4, PORTAL_FLARE = 0.15, PORTAL_LENS = 0.8; // s
const PORTAL_FIGURE = 1.6, PORTAL_STREAK = 3, PORTAL_ORB = 1.3, PORTAL_LENS_R = 2.5, PORTAL_GAP = 3; // m: the
// lightning's reach, the streak's (up and down), the drawn-in light's, the lens sphere's (burst out to); how far apart two open
// its waves (see lensPass): m out from its point; m between crests; crests run in a s
const PORTAL_WAVE_R = 3, PORTAL_WAVE_LENGTH = 0.6, PORTAL_WAVE_RATE = 1.4;
const PORTAL_LENS_INDEX = 1.077, AIR_INDEX = 1.000293; // the lens sphere's refractive index at its peak, and air's (of vacuum)
const PORTAL_STREAK_PX = 12; // the streak's card: the world's pixels across (its line a couple of them: sharp, however far)
const PORTAL_CRACKLE = [0.06, 0.14], PORTAL_ZAP = [0.25, 0.9]; // s: how long one figure of its lightning lasts; between its crackles' bursts
const PORTAL_SPARKS = 48, PORTAL_SPARK_FROM = [0.7, 1.6]; // sparks a portal; m: how far out each starts falling in
const PORTAL_BUILD = 0.7; // s: what comes through, built up from embers over this (see SpriteImpostor's uBuild)
export const PORTAL_BUILD_LEAD = 0.1; // how far short of its middle its fronts start (of the burn's 0..1 out to its ends): none
// of it there for that first share of PORTAL_BUILD, then its first pixels, at its middle (its whoosh starts with them)
const PORTAL_BUILD_FIRST = 0.05; // how far out its fronts have got (as above) when its first pixel shows: its middle row's
// least noise and grain (in the burn; measured: 0.03–0.06 over the zombie, the officer and the demon, from all round)
const PORTAL_EMBERS = 1.4, PORTAL_EMBER_SLOW = 0.3; // s: how long its sparks linger once it's come through (embers); how
// quickly they lose the speed they had (to 1/e)
const PORTAL_GLOW = 14, PORTAL_TINT = new THREE.Color(PORTAL_LIGHT_COLOR); // its point at its brightest (× white); its colour:
// red-orange, as hellfire (it was a cold violet: not frightening), its hottest a yellow-orange (PORTAL_HOT: not white,
// else between the two it went pink)
const PORTAL_HOT = new THREE.Color(0xffd27a);
// Its lightning: a tree of it out of its point, every way. Arms wander out, forking as they go (each fork dimmer and
// shorter), drawn as lines (a pixel wide: the world's); one that gets down to the floor strikes it and stops there.
// Each vertex: how far along the branches it is (of the furthest: when the growth gets there) and how bright its
// branch is (aWhen, aBright).
const BOLT_SEGS = 600, BOLT_STEP = 0.07, BOLT_ARMS = 7; // segments at most; m a step; arms out of the point
const boltGeometry = () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BOLT_SEGS * 6), 3).setUsage(THREE.DynamicDrawUsage));
  for (const a of ['aWhen', 'aBright']) g.setAttribute(a, new THREE.BufferAttribute(new Float32Array(BOLT_SEGS * 2), 1).setUsage(THREE.DynamicDrawUsage));
  g.setDrawRange(0, 0);
  return g;
};
function crackle(geo, up) { // a new figure into geo, round its point (up m above the floor)
  const P = geo.attributes.position.array, W = geo.attributes.aWhen.array, B = geo.attributes.aBright.array;
  let n = 0, furthest = 1e-3;
  const grow = (x, y, z, dx, dy, dz, steps, b, d, depth) => {
    const ax = dx, ay = dy, az = dz; // (the way it set out: it wanders, but on out, not back)
    for (let s = 0; s < steps && n < BOLT_SEGS; s++) {
      dx = dx * 0.6 + ax * 0.4 + (Math.random() - 0.5) * 1.2; dy = dy * 0.6 + ay * 0.4 + (Math.random() - 0.5) * 1.2;
      dz = dz * 0.6 + az * 0.4 + (Math.random() - 0.5) * 1.2;
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      const nx = x + dx * BOLT_STEP, nz = z + dz * BOLT_STEP, floor = 0.02 - up, ny = Math.max(y + dy * BOLT_STEP, floor);
      P.set([x, y, z, nx, ny, nz], n * 6);
      W[n * 2] = d; W[n * 2 + 1] = d + BOLT_STEP; B[n * 2] = B[n * 2 + 1] = b;
      n++; d += BOLT_STEP; furthest = Math.max(furthest, d);
      x = nx; y = ny; z = nz;
      if (y <= floor) return; // (struck the floor)
      if (depth < 4 && Math.random() < 0.14) {
        grow(x, y, z, dx + (Math.random() - 0.5) * 1.6, dy + (Math.random() - 0.5) * 1.6, dz + (Math.random() - 0.5) * 1.6,
          (steps - s) * (0.4 + Math.random() * 0.35), b * 0.65, d, depth + 1);
      }
    }
  };
  for (let k = 0; k < BOLT_ARMS; k++) {
    const a = (k + Math.random()) / BOLT_ARMS * 2 * Math.PI, e = (Math.random() - 0.6) * 1.6; // (round it, more down than up)
    grow(0, 0, 0, Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), PORTAL_FIGURE / BOLT_STEP, 1, 0, 0);
  }
  for (let i = 0; i < n * 2; i++) W[i] /= furthest;
  geo.setDrawRange(0, n * 2);
  for (const a of ['position', 'aWhen', 'aBright']) geo.attributes[a].needsUpdate = true;
}
const PORTAL_NOISE = `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p, float period) { // value noise, repeating every period along x (round a circle: no seam)
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float i0 = mod(i.x, period), i1 = mod(i.x + 1.0, period);
    return mix(mix(hash(vec2(i0, i.y)), hash(vec2(i1, i.y)), f.x), mix(hash(vec2(i0, i.y + 1.0)), hash(vec2(i1, i.y + 1.0)), f.x), f.y);
  }`;
const PORTAL_FOG = `
  #ifdef USE_FOG // (light added on: dimmed by the fog, not tinted)
    gl_FragColor.rgb *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #endif`;
const portalVertex = (body, decls) => `
  attribute float aWhen, aBright;
  ${decls}
  varying vec2 vUv;
  varying vec3 vN, vV, vLocal;
  varying float vWhen, vBright;
  uniform vec3 uAt;
  uniform float uSize;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv; vLocal = position; vWhen = aWhen; vBright = aBright;
    ${body}
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const portalMaterial = (vertexBody, fragmentBody, decls = '') => new THREE.ShaderMaterial({ // (fresh uniforms each: the program's shared)
  uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTint: { value: PORTAL_TINT }, uHot: { value: PORTAL_HOT },
    uAt: { value: new THREE.Vector3() }, uSize: { value: 1 }, uGrow: { value: 0 }, uGlow: { value: 0 }, uFlare: { value: 0 },
    uTime: { value: 0 }, uSeed: { value: 0 }, uAfter: { value: 0 } },
  fog: true,
  vertexShader: portalVertex(vertexBody, decls),
  fragmentShader: `
    uniform vec3 uTint, uHot;
    uniform float uGrow, uGlow, uFlare, uTime, uSeed;
    varying vec2 vUv;
    varying vec3 vN, vV, vLocal;
    varying float vWhen, vBright;
    #include <fog_pars_fragment>
    ${PORTAL_NOISE}
    void main() {
      ${fragmentBody}
      ${PORTAL_FOG}
    }`,
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
});
// the lightning: there as far as it's grown, its newest tips brightest, its trunks brighter than its forks
const boltVertex = `vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);`;
const boltFragment = `
  if (vWhen > uGrow) discard;
  float tip = smoothstep(uGrow - 0.2, uGrow, vWhen);
  float b = floor((0.4 + 0.8 * vBright + 1.2 * tip) * uGlow * 3.0) / 3.0; // (in bands)
  if (b <= 0.0) discard;
  gl_FragColor = vec4(mix(uTint, uHot, 0.3 + 0.5 * max(vBright, tip)) * b, 0.0);`;
// the streak: a card on its point, upright in your view, PORTAL_STREAK m up and down it and PORTAL_STREAK_PX of the
// world's pixels across (uSize: a pixel's size, in m per m away), whatever the distance; a thin hot line down its
// middle in a soft glow, tapering in steps to its tips. Drawn over what's nearer (it's in the lens, not the room),
// while its point's in sight (see updatePortals)
const streakVertex = `
  vec4 mvPosition = viewMatrix * vec4(uAt, 1.0);
  mvPosition.xy += position.xy * vec2(${PORTAL_STREAK_PX}.0 * uSize * -mvPosition.z, ${(2 * PORTAL_STREAK).toFixed(1)});
  vWhen = smoothstep(${PORTAL_NEAR_FADE[0].toFixed(1)}, ${PORTAL_NEAR_FADE[1].toFixed(1)}, -mvPosition.z); // (not in your face: see PORTAL_NEAR_FADE)`;
const streakFragment = `
  vec2 q = vUv * 2.0 - 1.0;
  float px = abs(q.x) * ${(PORTAL_STREAK_PX / 2).toFixed(1)}; // (pixels out from its line)
  float b = (exp(-px * px / 1.2) + 0.45 * exp(-px / 2.5)) * pow(1.0 - abs(q.y), 2.0) * uGlow * vWhen;
  b = floor(b * 4.0) / 4.0;
  if (b <= 0.0) discard;
  gl_FragColor = vec4(mix(uTint, uHot, exp(-px * px / 1.2) * 0.7) * b, 0.0);`;
// the point and the light drawn in to it: a card facing you at its middle. A hot core, swelling as it grows and flaring
// as it comes through; streaks all round it, rushing in (the noise's rings run in as time goes on), faster as it grows
const orbVertex = `
  vec4 mvPosition = viewMatrix * vec4(uAt, 1.0);
  mvPosition.xy += position.xy * uSize;
  vWhen = smoothstep(${PORTAL_NEAR_FADE[0].toFixed(1)}, ${PORTAL_NEAR_FADE[1].toFixed(1)}, -mvPosition.z); // (not in your face: see PORTAL_NEAR_FADE)`;
const orbFragment = `
  vec2 q = vUv * 2.0 - 1.0;
  float r = length(q);
  if (r >= 1.0) discard;
  float s = 0.025 + 0.06 * uGrow + 0.3 * uFlare;
  float core = exp(-r * r / (s * s));
  float n = noise(vec2((atan(q.y, q.x) / 6.2831853 + 0.5) * 64.0, r * 1.2 + uTime + uSeed), 64.0); // (uTime: how far they've rushed, see updatePortals)
  float streak = smoothstep(0.72, 0.9, n) * smoothstep(1.0, 0.45, r) * smoothstep(0.03, 0.15, r) * uGrow; // (thin, long:
  // round it, many and narrow; out along it, slow)
  float b = (core * (1.0 + 2.0 * uFlare) * uGlow + streak * (1.0 + 3.0 * uGrow) * (1.4 - r)) * vWhen;
  b = floor(b * 4.0) / 4.0;
  if (b <= 0.0) discard;
  gl_FragColor = vec4(mix(uTint, uHot, clamp(core * 1.5, 0.0, 1.0)) * b, 0.0);`;
// the sparks: each falling in to the point from its own way and distance, over and over (where it is in its fall
// worked out from the time: nothing to move each frame), faster as it nears it, and faster and more often as the
// portal grows; a little ellipse facing you, stretched out along its fall as you see it, by its speed. Fading in where
// it sets out, out as it's swallowed; none once the point's gone. (Every portal's the same sparks, turned its own way.)
const sparkGeo = new THREE.InstancedBufferGeometry();
{
  const quad = new THREE.PlaneGeometry(1, 1), dir = [], phase = [], from = [];
  sparkGeo.index = quad.index;
  sparkGeo.setAttribute('position', quad.attributes.position);
  for (let i = 0; i < PORTAL_SPARKS; i++) {
    const e = Math.asin(Math.random() * 2 - 1) * 0.8, a = Math.random() * 2 * Math.PI; // (round it, flatter than a ball)
    dir.push(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
    phase.push(Math.random()); from.push(between(PORTAL_SPARK_FROM));
  }
  sparkGeo.setAttribute('aDir', new THREE.InstancedBufferAttribute(new Float32Array(dir), 3));
  sparkGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(phase), 1));
  sparkGeo.setAttribute('aFrom', new THREE.InstancedBufferAttribute(new Float32Array(from), 1));
  sparkGeo.instanceCount = PORTAL_SPARKS;
}
const sparkDecls = `attribute vec3 aDir; attribute float aPhase, aFrom; uniform float uTime, uGrow, uSeed, uAfter; // uSize: a world pixel, m per m away`;
const sparkVertex = `
  vec3 dir = vec3(cos(uSeed) * aDir.x - sin(uSeed) * aDir.z, aDir.y, sin(uSeed) * aDir.x + cos(uSeed) * aDir.z);
  float rate = 0.5 + 1.3 * uGrow, life = fract(uTime + aPhase); // (uTime: its falls so far, see updatePortals; life: 0
  // setting out, 1 swallowed)
  float r = aFrom * (1.0 - life * life), speed = 2.0 * aFrom * life * rate; // m; m/s (from rest, ever faster: drawn in)
  // come through (uAfter s ago; its fall stopped there, see updatePortals): nothing pulling it in now. It carries on the
  // way it was going, slowing (to 1/e in PORTAL_EMBER_SLOW s), and drifts as an ember does: fluttering, rising a little
  float go = ${PORTAL_EMBER_SLOW.toFixed(2)} * (1.0 - exp(-uAfter / ${PORTAL_EMBER_SLOW.toFixed(2)}));
  vec3 drift = -dir * speed * go + vec3(sin(uAfter * 3.1 + aPhase * 40.0), 0.0, cos(uAfter * 2.7 + aPhase * 23.0)) * 0.08 * min(uAfter, 1.0)
    + vec3(0.0, 0.12 * uAfter + 0.05 * sin(uAfter * 4.3 + aPhase * 17.0), 0.0);
  speed *= exp(-uAfter / ${PORTAL_EMBER_SLOW.toFixed(2)}); // (and so rounds, its streak gone)
  vec4 mvPosition = viewMatrix * vec4(uAt + dir * r + drift, 1.0);
  vec3 fall = (viewMatrix * vec4(-dir, 0.0)).xyz;
  vec2 sv = fall.xy - mvPosition.xy * fall.z / min(mvPosition.z, -0.1); // (its fall as you see it, perspective and all)
  vec2 along = normalize(sv + vec2(1e-5, 0.0)), across = vec2(-along.y, along.x);
  float w = max(0.035, 1.5 * uSize * -mvPosition.z); // m: its width (never under a pixel and a half: it shimmered, or went)
  float len = max(0.04 + 0.12 * speed * length(sv), 2.0 * w); // (stretched by how fast it falls across your view)
  mvPosition.xy += along * (position.y - 0.5) * len + across * position.x * w; // (its head at the front)
  vUv = position.xy * 2.0;
  vWhen = smoothstep(0.0, 0.2, life) * smoothstep(0.0, 0.1, r) * uGrow;
  if (uAfter > 0.0) vWhen *= (1.0 - smoothstep(0.4 * ${PORTAL_EMBERS.toFixed(2)}, ${PORTAL_EMBERS.toFixed(2)}, uAfter)) // (flickering out)
    * (0.5 + 0.5 * step(0.35, fract(sin(floor(uAfter * 14.0) + aPhase * 91.0) * 43758.5453)));
  vWhen *= smoothstep(${PORTAL_NEAR_FADE[0].toFixed(1)}, ${PORTAL_NEAR_FADE[1].toFixed(1)}, -mvPosition.z); // (not in your face: see PORTAL_NEAR_FADE)`;
const sparkFragment = `
  float e = 1.0 - dot(vUv, vUv);
  if (e <= 0.0) discard;
  float b = floor(min(e * 2.0, 1.0) * vWhen * uGlow * 3.0) / 3.0;
  if (b <= 0.0) discard;
  gl_FragColor = vec4(mix(uTint, uHot, 0.6) * b, 0.0);`;
const orbGeo = new THREE.PlaneGeometry(1, 1);
export const portals = [];
// Where an enemy can come in: on the open floor (clear of the platform, the stairs, the columns and the towers; under the
// balcony's fine, a skull not in its floor), at least gap m from you, not on top of another coming in; into out (its y: y)
export function portalSpot(out, gap, y = 0) {
  for (let tries = 0; ; tries++) {
    out.set((Math.random() - 0.5) * 2 * (ARENA - 3), y, (Math.random() - 0.5) * 2 * (ARENA - 3));
    if (Math.hypot(out.x - camera.position.x, out.z - camera.position.z) < gap) continue;
    if (y > BALCONY_Y - STRINGER_D - 0.5 && y < BALCONY_Y + 0.5 && overDeck(out.x, out.z)) continue;
    if (platformGap(out.x, out.z) < 1.5 || boxGap(BALCONY_FLIGHT, out.x, out.z) < 1.5 || AROUND.some(([c, R], i) => i > 0 && Math.hypot(c.x - out.x, c.y - out.z) < R + 0.5)) continue;
    if (tries < 50 && portals.some((p) => Math.hypot(p.x - out.x, p.z - out.z) < PORTAL_GAP)) continue; // (crowded: by
    // another, then; never in anything, nor on you)
    return out;
  }
}
// A portal at (x, z), its point orbY up; arrive: what comes through, when it does (npc: that, if an enemy: see removeNpcs;
// imp: its sprite, built up as it comes through)
export function openPortal(x, z, orbY, arrive, npc, imp) {
  const floor = floorAt(x, z, orbY), parts = [[boltGeometry(), boltVertex, boltFragment], [orbGeo, streakVertex, streakFragment],
    [orbGeo, orbVertex, orbFragment], [sparkGeo, sparkVertex, sparkFragment, sparkDecls]].map(([g, v, f, d], i) => {
    const m = new (i ? THREE.Mesh : THREE.LineSegments)(g, portalMaterial(v, f, d));
    m.position.set(x, floor, z); m.frustumCulled = false; m.renderOrder = 1; m.visible = false;
    m.material.uniforms.uSeed.value = Math.random() * 100;
    scene.add(m);
    return m;
  });
  const was = renderer.getRenderTarget(); // (its programs built now, in the spawn, not as it opens mid-play: see prewarm)
  renderer.setRenderTarget(composer.renderTarget1);
  for (const m of parts) renderer.compile(m, camera, scene);
  renderer.setRenderTarget(was);
  parts[0].position.y = orbY; // (out of its point)
  parts[1].material.uniforms.uAt.value.set(x, orbY, z);
  parts[1].material.depthTest = false; parts[1].renderOrder = 10; // (over everything: see streakVertex)
  parts[2].material.uniforms.uAt.value.set(x, orbY, z);
  parts[3].material.uniforms.uAt.value.set(x, orbY, z);
  parts[3].material.uniforms.uSeed.value = Math.random() * 2 * Math.PI; // (its sparks turned its own way)
  parts[2].material.uniforms.uSize.value = 2 * PORTAL_ORB;
  if (imp) imp.depthU.uBuild.value = 0;
  portals.push({ x, z, orbY, arrive, npc, imp, t: -Math.random() * PORTAL_DELAY, parts, light: 0, crackleAt: 0, spark: 0, swirl: 0,
    turn: Math.random() }); // (turn: its waves' strokes' seed)
}
const _portalP = new THREE.Vector3(), _portalD = new THREE.Vector3();
// Is p's point in sight from you (nothing in between)? Into _portalP, it (and its distance: returned)
function portalSeen(p) {
  _portalP.set(p.x, p.orbY, p.z);
  const dist = _portalP.distanceTo(camera.position), w = rayWorld(camera.position, _portalD.subVectors(_portalP, camera.position).divideScalar(dist));
  return !w || w.t > dist - 0.5 ? dist : 0;
}
const portalSound = (p, name, level) => playSound(name, level / (1 + Math.hypot(p.x - camera.position.x, p.orbY - camera.position.y,
  p.z - camera.position.z) * 0.12), 0.12); // (quieter the further off, as a demon's voice; pitched a little at random)
export function updatePortals(dt, now) {
  const px = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / composer.renderTarget1.height; // (a world pixel, m per m)
  for (let k = portals.length - 1; k >= 0; k--) {
    const p = portals[k], [bolts, streak, orb, sparks] = p.parts;
    p.t += dt;
    if (p.t < 0) continue; // (not yet)
    const grow = Math.min(p.t / PORTAL_TIME, 1), after = Math.max(p.t - PORTAL_TIME, 0), fade = 1 - Math.min(after / PORTAL_FADE, 1);
    if (p.imp) p.imp.depthU.uBuild.value = THREE.MathUtils.clamp(after / PORTAL_BUILD, 0, 1); // (built up as it comes through)
    if (after > 0) p.lens ??= portals.filter((q) => q.lens && q.t > PORTAL_TIME && q.t < PORTAL_TIME + PORTAL_LENS).length < LENSES; // (its
    // lens, if there's one left: claimed as it comes through, none cut off part way)
    if (after > 0 && p.arrive) { // it's here: seen as it's built up (held still: see below), one of them once it's built
      if (p.imp && !p.imp.visible) { p.imp.visible = true; p.imp.lastKey = undefined; } // (drawn afresh: its picture's
      // from the spawn, seconds ago, lit as you were then)
      if (after >= PORTAL_BUILD) { p.arrive(); p.arrive = null; }
    }
    if (fade <= 0 && after >= Math.max(PORTAL_EMBERS, PORTAL_BUILD)) { for (const m of p.parts) { scene.remove(m); m.material.dispose(); } bolts.geometry.dispose(); portals.splice(k, 1); continue; } // (all of it built first)
    const flare = after > 0 ? Math.max(1 - after / PORTAL_FLARE, 0) : 0;
    bolts.visible = true;
    const streakGlow = THREE.MathUtils.smoothstep(grow, 0.05, 0.4) * (1 - THREE.MathUtils.smoothstep(grow, 0.7, 1)) * 5;
    p.seen = p.t < PORTAL_TIME + PORTAL_LENS ? portalSeen(p) : 0; // (its point in sight: how far; 0: hidden)
    p.wave ??= portals.filter((q) => q.wave && q.t >= 0 && q.t < PORTAL_TIME).length < LENSES; // (its waves, if there's room: claimed as it opens)
    streak.visible = streakGlow > 0 && p.seen > 0; // (behind something: its point hidden, no streak, as with a lens)
    orb.visible = after < PORTAL_FLARE;
    sparks.visible = after < PORTAL_EMBERS; // (embers, once it's come through)
    for (const m of p.parts) m.material.uniforms.uTime.value = now;
    // (the sparks' falls and the drawn-in streaks' rush, each so far: their pace grows with it; as the time × the pace,
    // they raced ever faster the longer the game had run)
    if (after <= 0) p.spark += dt * (0.5 + 1.3 * grow); // (stopped as it comes through: embers from there)
    sparks.material.uniforms.uTime.value = p.spark;
    sparks.material.uniforms.uAfter.value = after;
    orb.material.uniforms.uTime.value = p.swirl += dt * (0.6 + 1.4 * grow);
    if (p.t >= p.crackleAt) { // a new figure of its lightning, flickering brighter or dimmer
      crackle(bolts.geometry, p.orbY - floorAt(p.x, p.z, p.orbY));
      p.crackleAt = p.t + between(PORTAL_CRACKLE); p.flick = 0.6 + 0.4 * Math.random();
    }
    const whooshAt = PORTAL_TIME + PORTAL_BUILD * (PORTAL_BUILD_LEAD + PORTAL_BUILD_FIRST) / (1 + 2 * PORTAL_BUILD_LEAD); // (with
    // the first pixel of what comes through: see PORTAL_BUILD_FIRST)
    if (p.t >= whooshAt && !p.whooshed) { p.whooshed = true; portalSound(p, 'portal_whoosh', 1); }
    if (fade > 0 && now >= (p.zapAt ?? 0)) { // and its sound: a burst of sparks
      portalSound(p, portalZap((Math.random() * PORTAL_ZAPS) | 0), (0.2 + 0.5 * grow + 0.3 * flare) * fade);
      p.zapAt = now + between(PORTAL_ZAP);
    }
    bolts.material.uniforms.uGrow.value = Math.min(grow * 1.1, 1) + flare; // (all of it, as it comes through)
    bolts.material.uniforms.uGlow.value = (0.6 + 1.4 * grow + 2 * flare) * fade * p.flick;
    streak.material.uniforms.uGlow.value = streakGlow;
    streak.material.uniforms.uSize.value = px;
    orb.material.uniforms.uGrow.value = grow;
    orb.material.uniforms.uGlow.value = PORTAL_GLOW * grow * grow;
    orb.material.uniforms.uFlare.value = flare;
    sparks.material.uniforms.uGrow.value = grow;
    sparks.material.uniforms.uGlow.value = (1.5 + 4 * grow) * (after > 0 ? 0.7 : 1);
    sparks.material.uniforms.uSize.value = px;
    p.light = after > 0 ? flare : grow * grow; // (its light: as bright as its point)
  }
  // the lights: to the portals giving you the most light (theirs over how far off), each dimmed as the next one's nears
  // its own, so it hands over at nothing (by distance alone, a pool of light jumped from one to the next)
  const give = (p) => p.light / Math.max((p.x - camera.position.x) ** 2 + (p.z - camera.position.z) ** 2, 1);
  const lit = portals.filter((p) => p.t >= 0 && p.light > 0).sort((a, b) => give(b) - give(a));
  const next = lit.length > PORTAL_LIGHTS ? give(lit[PORTAL_LIGHTS]) : 0;
  portalLights.forEach((l, i) => {
    const p = lit[i];
    const near = p ? Math.min(1, ((p.x - camera.position.x) ** 2 + (p.orbY - camera.position.y) ** 2 + (p.z - camera.position.z) ** 2) / PORTAL_NEAR ** 2) : 0;
    l.world.intensity = l.sprite.intensity = p ? PORTAL_INTENSITY * p.light * Math.min(1, 4 * (1 - next / give(p))) * near : 0;
    if (p) { l.world.position.set(p.x, p.orbY, p.z); l.sprite.position.copy(l.world.position); }
  });
  // what's being built up: not one of them yet (nothing updates it), so its sprite here, facing you, in these lights, its
  // pose held (no time for it: it starts moving once it's built)
  let renders = 0;
  for (const p of portals) if (p.imp?.visible && p.arrive) renders += p.imp.update(renderer, camera, 0);
  return renders;
}
// The lens, for each come through within PORTAL_LENS s: where its point is on your screen (its size by how deep it is
// in your view), if it's in front of you and in sight. Its sphere bursts out (fast, then slowing) to PORTAL_LENS_R, its
// index up to PORTAL_LENS_INDEX at once and back to air's as it goes. After the camera's shaken (see the frame), so it's
// on its spot
let lensBuilt = false; // (the pass drawn once, on the first frame, bending nothing: its program built then, not mid-play)
export function portalLenses() {
  let lenses = 0, waves = 0;
  const tan2 = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  for (const p of portals) { // the waves, as it grows (gone as it comes through, the sphere taking over)
    const grow = p.t / PORTAL_TIME;
    if (!(p.wave && grow > 0 && grow < 1) || waves >= LENSES || !(p.seen > 0)) continue;
    _portalP.set(p.x, p.orbY, p.z).applyMatrix4(camera.matrixWorldInverse);
    const depth = -_portalP.z;
    _portalP.applyMatrix4(camera.projectionMatrix);
    if (depth <= 0.1) continue;
    const m = 1 / (tan2 * depth), swell = THREE.MathUtils.smoothstep(grow, 0.05, 0.4) * (1 - THREE.MathUtils.smoothstep(grow, 0.92, 1));
    lensPass.uniforms.uWaveA.value[waves].set(_portalP.x * 0.5 + 0.5, _portalP.y * 0.5 + 0.5, Math.min(PORTAL_WAVE_R, 0.3 * p.seen) * m, swell);
    lensPass.uniforms.uWaveB.value[waves++].set(PORTAL_WAVE_LENGTH * m, p.t * PORTAL_WAVE_RATE, p.turn, depth);
  }
  for (let i = waves; i < LENSES; i++) lensPass.uniforms.uWaveA.value[i].w = 0;
  for (const p of portals) {
    const age = (p.t - PORTAL_TIME) / PORTAL_LENS; // (0 as it comes through, 1 gone)
    if (!(p.lens && age > 0 && age < 1) || lenses >= LENSES) continue;
    const dist = p.seen; // (see updatePortals)
    _portalP.set(p.x, p.orbY, p.z).applyMatrix4(camera.matrixWorldInverse);
    const depth = -_portalP.z;
    _portalP.applyMatrix4(camera.projectionMatrix);
    if (depth > 0.1 && dist > 0) {
      const radius = Math.min(PORTAL_LENS_R, 0.3 * dist) * (0.05 + 0.95 * (1 - (1 - age) ** 3)); // m (never up to you: walked
      // up to it as it came through, it filled the screen and smeared it)
      const swell = THREE.MathUtils.smoothstep(age, 0, 0.1) * (1 - THREE.MathUtils.smoothstep(age, 0.25, 1));
      lensPass.uniforms.uDepth.value[lenses] = depth;
      lensPass.uniforms.uTan.value = tan2;
      lensPass.uniforms.uLens.value[lenses++].set(_portalP.x * 0.5 + 0.5, _portalP.y * 0.5 + 0.5, radius / (tan2 * depth),
        (AIR_INDEX + (PORTAL_LENS_INDEX - AIR_INDEX) * swell) / AIR_INDEX);
    }
  }
  for (let i = lenses; i < LENSES; i++) lensPass.uniforms.uLens.value[i].w = 0;
  lensPass.enabled = lenses > 0 || waves > 0 || !lensBuilt;
  lensBuilt = true;
  lensPass.uniforms.uAspect.value = camera.aspect;
}
