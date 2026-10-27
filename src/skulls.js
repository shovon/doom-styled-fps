// Flying skulls
import { between } from './police.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { SpriteImpostor } from './sprites.js';
import { renderer, scene } from './setup.js';
import { TILE } from './tiles.js';
import { ARENA, WALL_ROWS, PLATFORM_H, pushOutOfPlatform, BOXES, inStairBox, ceilingAt, floorAt, pushOutOfStairBox } from './arena.js';
import { camera, opts } from './camera.js';
import { rayWorld } from './holes.js';
import { puffSmoke } from './casings.js';
import { DEMON_GRUNTS, DEMON_DEATHS } from './audio.js';
import { _shotFrom, hurtPlayer } from './player.js';
import { corpses, prewarm } from './enemies.js';
import { demonVoice, AROUND, pushOutOfColumns } from './enemy-ai.js';
import { portalSpot, openPortal } from './portals.js';
import { UP, clock } from './main.js';

// Flying skulls (models/skull.glb: image-to-3d, a static model, horned, its eyes and the cracks in it painted on
// glowing): SKULLS of them, on top of the police. Each drifts round you at its own height and distance (SKULL_HEIGHT,
// SKULL_RANGE), bobbing, turned to you; every SKULL_ATTACK s or so, if it can see you (within SKULL_REACH m), it stops
// dead and shrieks (SKULL_WINDUP s), then swoops straight at where your eye was, at SKULL_CHARGE m/s: coming within
// SKULL_BITE m of it, it bites (SKULL_DAMAGE) and bounces off; past you, or into anything, it pulls up and climbs back
// (SKULL_RECOVER s). A hit knocks it back (SKULL_KNOCK m/s) and breaks off a swoop; SKULL_HEALTH and it drops, its fire
// going out, and lies where it lands. Its fire and eyes are their own light, brighter than white (see skullFire,
// skullGlow): in the dark they're still there, and the bloom haloes them.
export const SKULLS = 4, SKULL_SIZE = 0.65; // (?skulls=n); m tall
const SKULL_FRAME = 0.8, SKULL_FRAME_UP = 0.25; // m: its sprite's half-size, its middle this far above its head's (its fire)
const SKULL_HEIGHT = [2.2, 4.5], SKULL_RANGE = [6, 12], SKULL_SPEED = 3, SKULL_CHARGE = 10; // m; m; m/s; m/s
const SKULL_ATTACK = [2.5, 6], SKULL_REACH = 18, SKULL_WINDUP = 0.5, SKULL_RECOVER = 1.2; // s; m; s; s
const SKULL_BITE = 0.8, SKULL_DAMAGE = 8, SKULL_HEALTH = 6, SKULL_KNOCK = 3; // m; ; hits; m/s
const SKULL_GLOW = 8, SKULL_FIRE = 3; // how bright its eyes and cracks are (× their colour), and its fire's hottest
export const skulls = [];
// Its fire: SKULL_TONGUES tongues of flame off the back and top of its head, each a quad turned to face the camera
// round its own length: in its sprite (the sprite's camera, layer 1), behind its head where they're behind it,
// pixelated with it. They stream up, fanned out from its head and swept back from where it's flying (uAxis). A tongue
// is noise scrolling up a tapering body, in a few flat bands of colour (pixel art), its own light: added on (alpha 0:
// the sprite's card adds it to what's behind).
const SKULL_TONGUES = 9;
const skullFireGeo = (() => {
  const pos = [], root = [], size = [], idx = [];
  for (let k = 0; k < SKULL_TONGUES; k++) {
    const a = (k / (SKULL_TONGUES - 1) - 0.5) * 2.4; // round the back of its head, one side to the other
    const r = [Math.sin(a) * 0.16, 0.1 + Math.random() * 0.12, -0.08 - Math.cos(a) * 0.1];
    const z = [0.2 + Math.random() * 0.1, 0.35 + Math.random() * 0.25, Math.random() * 10]; // width, length (m), phase
    for (const [x, y] of [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]]) { pos.push(x, y, 0); root.push(...r); size.push(...z); }
    idx.push(4 * k, 4 * k + 1, 4 * k + 2, 4 * k, 4 * k + 2, 4 * k + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aRoot', new THREE.Float32BufferAttribute(root, 3));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 3));
  g.setIndex(idx);
  return g;
})();
export const skullTime = { value: 0 };
function skullFire() {
  const fire = new THREE.Mesh(skullFireGeo, new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime: skullTime, uAxis: { value: new THREE.Vector3(0, 1, 0) }, uFade: { value: 1 } },
    fog: true, // (only the world has fog: in real-3D mode; as a sprite, its card fogs it)
    vertexShader: `
      uniform float uTime;
      uniform vec3 uAxis;
      attribute vec3 aRoot, aSize;
      varying vec2 vUv;
      varying float vPhase;
      #include <fog_pars_vertex>
      void main() {
        vUv = position.xy + vec2(0.5, 0.0);
        vPhase = aSize.z;
        vec3 root = (modelMatrix * vec4(aRoot, 1.0)).xyz;
        vec3 along = normalize(uAxis + 0.5 * normalize((modelMatrix * vec4(aRoot, 0.0)).xyz)); // fanned out from its head
        vec3 side = normalize(cross(along, cameraPosition - root) + 1e-5);
        float sway = sin(uTime * 7.0 + aSize.z) * 0.3 * position.y * position.y; // the tip licking side to side
        vec3 w = root + side * (position.x + sway) * aSize.x + along * position.y * aSize.y;
        vec4 mvPosition = viewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float uTime, uFade;
      varying vec2 vUv;
      varying float vPhase;
      #include <fog_pars_fragment>
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        float x = abs(vUv.x - 0.5) * 2.0, y = vUv.y; // 0 down its middle, 1 at its edges; 0 at its root, 1 at its tip
        float n = 0.65 * noise(vec2(vUv.x * 3.0 + vPhase, y * 2.5 - uTime * 3.0)) + 0.35 * noise(vec2(vUv.x * 7.0 - vPhase, y * 6.0 - uTime * 6.0));
        float body = (1.0 - y) * smoothstep(0.0, 0.15, y) * 1.2; // out from the root, then to a point
        float heat = floor(clamp((body - x + (n - 0.5) * 0.9 * (0.3 + y)) * 2.0 * uFade, 0.0, 1.0) * 4.0) / 4.0; // in bands
        if (heat <= 0.0) discard;
        vec3 c = heat < 0.5 ? vec3(0.8, 0.12, 0.02) : heat < 0.75 ? vec3(1.0, 0.45, 0.05) : vec3(1.0, 0.85, 0.4);
        gl_FragColor = vec4(c * heat * ${SKULL_FIRE.toFixed(1)}, 0.0);
        #ifdef USE_FOG // (light added on: dimmed by the fog, not tinted)
          #ifdef FOG_EXP2
            gl_FragColor.rgb *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          #else
            gl_FragColor.rgb *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
          #endif
        #endif
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, // (behind its head, its head hides it)
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  }));
  fire.layers.set(1);
  fire.frustumCulled = false; // (placed in its shader: its own box means nothing)
  fire.renderOrder = 1;
  return fire;
}
// Its eyes and the cracks in its head: painted on glowing (saturated orange), so those texels, picked out by their
// colour, light themselves too, glow.value × their colour, whatever light's on it (none: still there)
function skullGlow(mat, glow) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uGlow = glow;
    sh.fragmentShader = 'uniform float uGlow;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        vec3 c = pow(max(diffuseColor.rgb, 0.0), vec3(1.0 / 2.2)); // (as painted: the mask's set on that)
        float hi = max(c.r, max(c.g, c.b)), sat = (hi - min(c.r, min(c.g, c.b))) / max(hi, 1e-4);
        totalEmissiveRadiance += diffuseColor.rgb * smoothstep(0.7, 0.85, sat) * smoothstep(0.45, 0.7, c.r) * uGlow;
      }`);
  };
}
export function addSkulls(gltf, n) {
  const src = gltf.scene.getObjectByProperty('isMesh', true), size = new THREE.Box3().setFromObject(src).getSize(new THREE.Vector3());
  for (let i = 0; i < n; i++) {
    const model = new THREE.Group(), mesh = src.clone(), glow = { value: SKULL_GLOW };
    mesh.material = src.material.clone();
    skullGlow(mesh.material, glow);
    mesh.scale.setScalar(SKULL_SIZE / size.y);
    model.add(mesh);
    const imp = new SpriteImpostor(model, new THREE.AnimationMixer(model), opts);
    imp.r = imp.rBase = SKULL_FRAME; imp.fit.set(0, SKULL_FRAME_UP, 0); imp.below = true; // (its frame: its head and fire)
    imp.blob.scale.setScalar(0); // (no contact shadow, up where it comes in: see updateSkull, from when it's built)
    const fire = skullFire();
    model.add(fire);
    portalSpot(model.position, 12, between(SKULL_HEIGHT));
    scene.add(imp);
    const s = {
      imp, mesh, fire, glow, skull: true, dead: false, health: SKULL_HEALTH, vel: new THREE.Vector3(), aim: new THREE.Vector3(),
      state: 'cruise', stateAt: 0, attackAt: clock.elapsedTime + between(SKULL_ATTACK), left: 0, // see updateSkull
      height: between(SKULL_HEIGHT), range: between(SKULL_RANGE), angle: Math.random() * 2 * Math.PI,
      orbitDir: Math.random() < 0.5 ? -1 : 1, phase: Math.random() * 10, fade: 1, spin: 0, resting: false,
    };
    imp.visible = false; // (in through a portal, as the others: see addNpcs)
    imp.update(renderer, camera, 0);
    prewarm(imp);
    openPortal(model.position.x, model.position.z, model.position.y + imp.fit.y, () => { s.attackAt = clock.elapsedTime + between(SKULL_ATTACK); skulls.push(s); }, null, imp);
  }
}
const _sk = new THREE.Vector3(), _skG = new THREE.Vector3(), _skM = new THREE.Matrix4(), _skQ = new THREE.Quaternion();
// Can it see your eye from p (dist m off)?
function skullSees(p, dist) {
  const w = rayWorld(p, _skG.subVectors(camera.position, p).divideScalar(dist));
  return !w || w.t > dist - 0.3;
}
// Moves it on (v for dt) and keeps it in the room: inside the walls, out of the columns and towers, lift m above the
// floor (see floorAt), under the ceiling (and the balcony, under it). Below the platform's top before it moved, the
// platform's sides are walls to it (else it was lifted up onto it); so are a step's, or the balcony's floor's, level
// with it. Did it have to?
function keepSkullIn(p, v, dt, lift) {
  const low = p.y < PLATFORM_H + lift - 0.01, was = p.y;
  p.addScaledVector(v, dt);
  const x = p.x, y = p.y, z = p.z;
  p.x = THREE.MathUtils.clamp(p.x, -ARENA + 0.5, ARENA - 0.5); p.z = THREE.MathUtils.clamp(p.z, -ARENA + 0.5, ARENA - 0.5);
  pushOutOfColumns(p);
  if (low) pushOutOfPlatform(p, lift);
  for (const b of BOXES) if (was > b.y0 - lift && was < b.h + lift && inStairBox(b, p.x, p.z, lift)) pushOutOfStairBox(p, b, lift);
  p.y = THREE.MathUtils.clamp(p.y, floorAt(p.x, p.z, was) + lift, Math.min(ceilingAt(p.x, p.z, was) - lift, WALL_ROWS * TILE - 0.5));
  return p.x !== x || p.y !== y || p.z !== z;
}
function skullRecover(s, now) { s.state = 'recover'; s.stateAt = now; }
export function updateSkull(s, dt, now) {
  const m = s.imp.model, p = m.position, v = s.vel, you = camera.position;
  s.imp.blob.scale.setScalar(0.4 * THREE.MathUtils.clamp(1 - (p.y - floorAt(p.x, p.z, p.y) - 0.25) / 1.5, 0, 1)); // (a contact shadow: only near the floor)
  _sk.subVectors(you, p);
  const dist = Math.max(_sk.length(), 1e-3);
  if (s.state === 'cruise' || s.state === 'recover') { // to its place round you: its distance, its height (bobbing)
    s.angle += s.orbitDir * 0.25 * dt; // (drifting round)
    const edge = ARENA - 2;
    _skG.set(THREE.MathUtils.clamp(you.x + Math.sin(s.angle) * s.range, -edge, edge) - p.x, s.height + 0.3 * Math.sin(now * 1.7 + s.phase) - p.y,
      THREE.MathUtils.clamp(you.z + Math.cos(s.angle) * s.range, -edge, edge) - p.z);
    const far = _skG.length(), speed = SKULL_SPEED * (s.state === 'recover' ? 1.5 : 1);
    v.lerp(_skG.multiplyScalar(Math.min(far, speed) / Math.max(far, 1e-3)), 1 - Math.exp(-2 * dt)); // (slowing as it gets there)
    for (const [c, R] of AROUND.slice(1)) { // round the columns and towers, not into them
      const dx = p.x - c.x, dz = p.z - c.y, d = Math.hypot(dx, dz);
      if (d < R + 1.5 && d > 1e-3) { v.x += dx / d * 4 * dt; v.z += dz / d * 4 * dt; }
    }
    if (s.state === 'recover' && now - s.stateAt > SKULL_RECOVER) { s.state = 'cruise'; s.attackAt = now + between(SKULL_ATTACK); }
    if (s.state === 'cruise' && now > s.attackAt && dist < SKULL_REACH && skullSees(p, dist)) {
      s.state = 'windup'; s.stateAt = now;
      demonVoice(s, `demon_grunt_${(Math.random() * DEMON_GRUNTS) | 0}`, 1, 1.7); // (a shriek)
    }
  } else if (s.state === 'windup') { // stopped dead, shaking, then off
    v.multiplyScalar(Math.exp(-8 * dt));
    if (now - s.stateAt > SKULL_WINDUP) { s.state = 'charge'; s.aim.copy(you); v.copy(_sk).setLength(SKULL_CHARGE); s.left = dist + 3; }
  } else if (s.state === 'charge') { // straight on, past where you were: a bite if it gets you
    if (dist < SKULL_BITE) {
      hurtPlayer(_shotFrom.copy(p), SKULL_DAMAGE);
      demonVoice(s, 'punch', 1, 0.8);
      v.multiplyScalar(-0.35).y += 2; // (bounced off you)
      skullRecover(s, now);
    } else if ((s.left -= SKULL_CHARGE * dt) <= 0) skullRecover(s, now);
  }
  for (const o of skulls) { // the others: kept apart
    if (o === s) continue;
    _skG.subVectors(p, o.imp.model.position);
    const d = _skG.length();
    if (d < 1.5 && d > 1e-4) v.addScaledVector(_skG, (1.5 - d) / d * 3 * dt);
  }
  if (keepSkullIn(p, v, dt, 0.4) && s.state === 'charge') { v.multiplyScalar(-0.3); skullRecover(s, now); } // (into something)
  // turned to you (swooping: the way it's going), shaking as it winds up
  _skM.lookAt(s.state === 'charge' ? _skG.copy(p).add(v) : you, p, UP);
  m.quaternion.slerp(_skQ.setFromRotationMatrix(_skM), 1 - Math.exp(-8 * dt));
  if (s.state === 'windup') m.rotateZ((Math.random() - 0.5) * 0.4);
  s.fire.material.uniforms.uAxis.value.set(-v.x * 0.12, 1 - v.y * 0.12, -v.z * 0.12); // (up, and back from its flight)
  s.glow.value = SKULL_GLOW * (0.85 + 0.15 * Math.sin(now * 13 + s.phase) * Math.sin(now * 7.3)); // (flickering)
}
// A dead skull (its corpse, c): falling, its fire going out, then lying there; at rest, its fire out, it's settled
export function fallSkull(c, dt) {
  const m = c.imp.model, p = m.position, v = c.vel;
  c.imp.blob.scale.setScalar(0.4 * THREE.MathUtils.clamp(1 - (p.y - floorAt(p.x, p.z, p.y) - 0.25) / 1.5, 0, 1)); // (a contact shadow: only near the floor)
  c.fade = Math.max(c.fade - dt / 0.6, 0);
  c.fire.material.uniforms.uFade.value = c.fade; c.fire.visible = c.fade > 0;
  c.glow.value = SKULL_GLOW * c.fade;
  if (c.resting) { // (still once its fire's out; drawn once more then: its last picture was still faintly alight)
    if (c.fade === 0 && !c.imp.still) { c.imp.still = true; c.imp.lastKey = undefined; }
    return;
  }
  v.y -= 9.8 * dt;
  m.rotateX(c.spin * dt);
  if (keepSkullIn(p, v, dt, 0.25) && v.y < 0 && p.y <= floorAt(p.x, p.z, p.y) + 0.25) { // landed
    if (v.y < -3) { v.y *= -0.3; v.x *= 0.5; v.z *= 0.5; c.spin *= 0.5; } else { c.resting = true; v.set(0, 0, 0); } // (a bounce, then still)
  }
  if (v.y > 0 && p.y >= WALL_ROWS * TILE - 0.5) v.y *= -0.3; // (off the ceiling: shot up there, it stuck to it)
}
// Hit (a shot, all its pellets that got it; or a punch) at, along dir, for dmg: a puff of bone dust, knocked back, a
// swoop broken off; dead at 0 (its body goes on as a corpse: see corpses); a dead one's knocked about
export function hitSkull(s, at, dir, dmg) {
  puffSmoke(at);
  if (s.dead) { s.resting = false; s.imp.still = false; s.vel.addScaledVector(dir, 1).y = Math.max(s.vel.y, 2); return; } // (a hop along the shot)
  if (s.state === 'charge') s.vel.set(0, 0, 0); // (its swoop stopped dead: else it came on regardless)
  s.vel.addScaledVector(dir, SKULL_KNOCK);
  if (s.state !== 'cruise') skullRecover(s, clock.elapsedTime);
  if ((s.health -= dmg) > 0) return;
  s.dead = true;
  demonVoice(s, `demon_death_${(Math.random() * DEMON_DEATHS) | 0}`, 1, 1.5);
  puffSmoke(s.imp.model.position);
  const k = skulls.indexOf(s);
  if (k >= 0) skulls.splice(k, 1);
  corpses.push({ imp: s.imp, mesh: s.mesh, dead: true, skull: true, fire: s.fire, glow: s.glow, vel: s.vel, spin: (Math.random() - 0.5) * 12, fade: 1, resting: false });
}
