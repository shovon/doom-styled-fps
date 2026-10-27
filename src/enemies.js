// The demons: their footfalls, the living (npcs) and the dead (corpses), adding and removing them
import './gun-blood.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { SpriteImpostor } from './sprites.js';
import { ENEMIES, KINDS, renderer, scene } from './setup.js';
import { ARENA, floorAt } from './arena.js';
import { camera, composer, opts } from './camera.js';
import { footPrint } from './blood-maps.js';
import { WOUND_RES, bloodyMaterial } from './shots.js';
import { demonShot } from './player.js';
import { DEMON_HEALTH, AI_ORBIT } from './enemy-ai.js';
import { POLICE_STAND } from './police.js';
import { fallSkull } from './skulls.js';
import { portals, portalSpot, openPortal } from './portals.js';
import { clock } from './main.js';

// ---------------------------------------------------------------------------
// Demons
// ---------------------------------------------------------------------------
// Enemy footfalls: when each foot comes down in the walk clip, a print if it's bloody (no sound: their footsteps were
// cut). The moments are found once from the clip itself (a kind's footfalls: s into each of its walking clips, by its
// name): a stand-in plays it through, and a foot's down where its height drops into the bottom of its swing.
export function findFootfalls(gltf, name, feetNames) {
  const model = cloneSkinned(gltf.scene), mixer = new THREE.AnimationMixer(model);
  const clip = THREE.AnimationClip.findByName(gltf.animations, name);
  mixer.clipAction(clip).play();
  const feet = feetNames.map((n) => model.getObjectByName(n) ?? model.getObjectByName(n.replace('.', '')));
  if (feet.some((f) => !f)) { console.warn('no feet', feetNames); return []; }
  const N = 120, ys = feet.map(() => []), p = new THREE.Vector3(), out = [];
  for (let i = 0; i < N; i++) {
    mixer.setTime((clip.duration * i) / N);
    model.updateMatrixWorld(true);
    feet.forEach((f, k) => ys[k].push(f.getWorldPosition(p).y));
  }
  for (const y of ys) {
    const lo = Math.min(...y), hi = Math.max(...y), down = lo + (hi - lo) * 0.15;
    for (let i = 0; i < N; i++) if (y[i] <= down && y[(i + N - 1) % N] > down) out.push((clip.duration * i) / N);
  }
  return out;
}
export const _stepE = new THREE.Euler();
// Did a clip's time (looping) pass f, going from was to t? (t wraps round at the loop)
export const crossed = (was, t, f) => (t >= was ? was < f && f <= t : f > was || f <= t);
export function demonSteps(npc, pace) { // after its walk has moved on this frame: did a foot come down?
  const t = npc.walk.time, was = npc.walkWas ?? t;
  npc.walkWas = t;
  if (pace < 0.05 || npc.walk.getEffectiveWeight() < 0.5) return;
  for (const f of npc.kind.footfalls[npc.walk.getClip().name] ?? []) if (crossed(was, t, f)) {
    const m = npc.imp.model;
    const yaw = _stepE.setFromQuaternion(m.quaternion, 'YXZ').y - npc.kind.facing; // its heading (see steer)
    if (m.position.y < 0.01) footPrint(npc, m.position, Math.sin(yaw), Math.cos(yaw), npc.demon); // its print, if bloody (a demon's
    // claws; else a boot), on the floor (up the stairs, it printed the floor under them)
  }
}
export const npcs = []; // { kind, zombie, police, demon, imp, walk, fire, idle, death, muzzle, shooter, firing, timer, pace, paceTarget, paceTimer, stagger, knock, shakeDir, health, dead, act, fireWas }
// The dead: when an enemy dies its body goes on as a corpse, and the enemy (its mind, its moves) is dropped. A corpse
// keeps what a body needs: its sprite (imp: the model, its death clip playing out), its mesh and wound mask (shots still
// wound it: see paintWound) and, a skull's, its fall (see fallSkull). Once it's settled (its death clip over; a skull at
// rest, its fire out), its sprite stops being re-posed (see SpriteImpostor's still).
export const corpses = []; // { demon, imp, mesh, dead: true, bloodRT, death, trauma, hurtAt, carcass, diedAt, deathTrauma, cut, gone } or a skull's { imp, mesh, dead: true, skull: true, fire, glow, vel, spin, fade, resting }
export function updateCorpses(dt) {
  for (const c of corpses) {
    if (c.skull) fallSkull(c, dt);
    else if (!c.imp.still && !c.death.isRunning()) { // (down: a carcass from now, see Gibs; counted from its death, a demon
      // burst a moment after it, as it fell: as if it, not its carcass, had)
      c.imp.still = true; c.carcass = 0;
      const p = c.imp.model.position, edge = ARENA - 0.01, under = floorAt(THREE.MathUtils.clamp(p.x + c.imp.fit.x, -edge, edge),
        THREE.MathUtils.clamp(p.z + c.imp.fit.z, -edge, edge), p.y + 1); // (fallen out over an edge: its
      if (under < p.y) { p.y = under; c.imp.lastKey = undefined; } // middle's what it lies on, not where its feet were)
    }
  }
}
const NPC_SPAWN_GAP = 10; // m: none starts nearer you than this
export const _v = new THREE.Vector3();

let dealt = 0; // enemies added so far (each the next kind in ENEMIES)
export function addNpcs(n) {
  for (let i = 0; i < n; i++) {
    const name = ENEMIES[dealt++ % ENEMIES.length], kind = KINDS[name], police = name === 'police', { gltf, rig } = kind;
    const model = cloneSkinned(gltf.scene);
    portalSpot(model.position, NPC_SPAWN_GAP); // (not on top of you, nor in anything)
    if (police) model.rotation.y = Math.random() * 2 * Math.PI; // (facing all ways: what they see, see policeLook)
    model.traverse((o) => { if (o.isMesh) o.castShadow = false; }); // blob/sprite shadows in both modes, so V compares fairly
    const bloodRT = new THREE.WebGLRenderTarget(WOUND_RES, WOUND_RES); // its wounds (see paintWound)
    let mesh;
    model.traverse((o) => { if (o.isSkinnedMesh) { mesh = o; o.material = bloodyMaterial(o.material, bloodRT.texture); } });
    const imp = new SpriteImpostor(model, new THREE.AnimationMixer(model), opts);
    scene.add(imp);
    const clip = (name) => imp.mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, name));
    const walk = clip(rig.walk), fire = clip(rig.fire), death = clip(rig.death), idle = clip('Idle'); // (fire: a zombie's punch)
    const run = rig.run ? clip(rig.run) : null, aimWalk = rig.aimWalk ? clip(rig.aimWalk) : null; // (the police's: walk is
    // whichever it's in, standing, walking, walking with the rifle up or running)
    death.setLoop(THREE.LoopOnce, 1);
    death.clampWhenFinished = true; // and stays lying there
    const stand = police ? idle : walk; // (the police start out standing about: see POLICE_SIGHT)
    stand.play().time = Math.random() * stand.getClip().duration; // out of step with each other
    const npc = {
      kind, zombie: name === 'zombie', police, demon: name === 'demon', // which it is
      imp, walk: stand, fire, idle, run, aimWalk, walkGait: walk, muzzle: model.getObjectByName('muzzle'), mesh, bloodRT,
      shooter: police || Math.random() < 0.5, firing: false, timer: nextVolley(), // (every officer has a rifle; a zombie: none)
      pace: kind.pace, paceTarget: kind.pace, paceTimer: 0, // switches between normal and fast every few seconds
      orbitR: AI_ORBIT[0] + Math.random() * (AI_ORBIT[1] - AI_ORBIT[0]),
      orbitDir: Math.random() < 0.5 ? -1 : 1,
      orbitTimer: 0, dodge: 0, dodgeSide: 1, closing: false, // see thinkDemon
      alert: false, sees: false, seenAt: new THREE.Vector2(), seenTime: -Infinity, // the police's (see policeLook):
      strolling: false, strollTo: new THREE.Vector2(), standUntil: clock.elapsedTime + Math.random() * POLICE_STAND[1],
      bestGap: Infinity, bestBy: 0, // (see stalled)
      stagger: 0, knock: new THREE.Vector3(), shakeDir: new THREE.Vector3(), // hit reaction (see staggerNpc)
      health: DEMON_HEALTH, dead: false, death, // see damageNpc
    };
    if (npc.demon) imp.mixer.addEventListener('loop', (e) => { if (e.action === fire && !npc.dead) demonShot(npc); }); // each shot
    // in through a portal (see Portals): unseen till then, but posed now, its programs built (see prewarm); one of them
    // (moving, fighting, to be shot) once it's built up
    imp.visible = false;
    imp.update(renderer, camera, 0);
    prewarm(imp);
    openPortal(model.position.x, model.position.z, model.position.y + imp.fit.y, () => {
      npc.standUntil = clock.elapsedTime + Math.random() * POLICE_STAND[1]; // (an officer stands about first: from now)
      npcs.push(npc);
    }, npc, imp);
  }
}
export function removeNpcs(n) { // the newest first, those still coming in first of all (called off: their portals go)
  const dispose = ({ imp, bloodRT, mesh }) => { imp.dispose(); bloodRT.dispose(); mesh.material.dispose(); };
  for (const p of portals.filter((p) => p.npc && p.arrive).slice(-n)) { p.arrive = null; p.t = Infinity; dispose(p.npc); n--; }
  if (n > 0) for (const npc of npcs.splice(-n)) dispose(npc); // (n > 0: splice(-0) takes them all)
}
// Its programs built now, hidden or out of view (compile goes through both; drawing it skipped what you couldn't see),
// into targets like those it's drawn into (their keys: no tone mapping, linear), so not as it comes in, mid-play
export function prewarm(imp) {
  const was = renderer.getRenderTarget();
  renderer.setRenderTarget(imp.rt); renderer.compile(imp.model, imp.cam, opts.stage); // its sprite
  renderer.setRenderTarget(composer.renderTarget1); renderer.compile(imp, camera, scene); // its card
  renderer.setRenderTarget(was);
}
export const nextVolley = () => 3 + Math.random() * 5; // seconds of walking between volleys

