// The police: standing about, strolling, spotting you, searching
import { demonVoice, AI_AVOID, AROUND, boxGap, platformGap, BALCONY, steerClear, onTop, stairsTo, wayTo } from './enemy-ai.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { ARENA, BALCONY_FLIGHT } from './arena.js';
import { camera } from './camera.js';
import { rayWorld } from './holes.js';
import { DEMON_GRUNTS } from './audio.js';
import { _stepE, npcs } from './enemies.js';
import { youOn } from './main.js';

// The police aren't always on to you. Till they are, they stand about (POLICE_STAND s) and stroll somewhere near
// (POLICE_STROLL m off), at a walk. They're on to you once they see you (your eye from theirs, nothing in the way, within
// POLICE_SIGHT m and inside their view, POLICE_VIEW either side of where they face, or within POLICE_FEEL m, any way),
// hear a shot (yours, or another officer's, within POLICE_HEAR m of them) or are hurt. On to you, they run at you (see
// thinkDemon) till they're in among their circling range, walk round you there with the rifle up, stopping to fire,
// and run off your line of fire when you aim at them (for POLICE_DODGE s). Out of sight, they run to where they last
// saw (or heard) you; not seeing you for POLICE_FORGET s, they give up, and stand about again.
const POLICE_SIGHT = 30, POLICE_VIEW = THREE.MathUtils.degToRad(60), POLICE_FEEL = 3, POLICE_HEAR = 24, POLICE_EYE = 1.6; // m; ; m; m; m
export const POLICE_FORGET = 6, POLICE_STAND = [2, 6], POLICE_STROLL = [3, 8], POLICE_DODGE = 0.9, POLICE_LOOK_EVERY = 0.2; // s; s; m; s; s
const POLICE_STALL = 1; // s: getting no nearer where it's going for this long, it stops there (see stalled)
export const between = ([a, b]) => a + Math.random() * (b - a);
const _eye = new THREE.Vector3(), _toYou = new THREE.Vector3();
// Is it on to you? It looks every POLICE_LOOK_EVERY s or so (a ray through the world)
export function policeLook(npc, now) {
  if (now >= (npc.lookAt ?? 0)) {
    npc.lookAt = now + POLICE_LOOK_EVERY * (0.5 + Math.random()); // (not all on the same frame)
    const m = npc.imp.model, p = m.position;
    _eye.set(p.x, p.y + POLICE_EYE, p.z);
    _toYou.subVectors(camera.position, _eye);
    const d = _toYou.length(), across = Math.hypot(_toYou.x, _toYou.z);
    const yaw = _stepE.setFromQuaternion(m.quaternion, 'YXZ').y - npc.kind.facing; // where it's facing (see steer)
    const off = Math.acos(THREE.MathUtils.clamp((Math.sin(yaw) * _toYou.x + Math.cos(yaw) * _toYou.z) / Math.max(across, 1e-3), -1, 1));
    let sees = d < POLICE_SIGHT && (npc.alert || across < POLICE_FEEL || off < POLICE_VIEW); // (on to you: it looks round for you)
    if (sees) { const w = rayWorld(_eye, _toYou.divideScalar(d)); sees = !w || w.t > d - 0.3; }
    npc.sees = sees;
    if (!sees) npc.closing = true; // (out of sight: in range again before it fires; else, seeing you again from far off, it
    // stopped and fired a whole volley there, then ran in)
    if (sees) policeAlert(npc, now); // (only as it looks: between, it would see where you'd gone, out of sight)
  }
  if (!npc.sees && npc.alert && now - npc.seenTime > POLICE_FORGET) { npc.alert = false; npc.strolling = false; npc.standUntil = now + between(POLICE_STAND); }
}
export function policeAlert(npc, now, x = camera.position.x, z = camera.position.z, on = youOn) { // on to you, at (x, z), up on
  // on (see PLATFORM): where you are now
  if (!npc.alert) demonVoice(npc, `demon_grunt_${(Math.random() * DEMON_GRUNTS) | 0}`, 1); // (a growl: it's on to you)
  npc.alert = true; npc.seenTime = now; npc.seenAt.set(x, z); npc.seenOn = on; npc.bestGap = Infinity;
}
// Is it getting no nearer to where it's going (gap m off) for POLICE_STALL s? (others got there first, and it was
// pushed off them; or it's in the way of something: it ran on the spot)
function stalled(npc, gap, now) {
  if (gap < npc.bestGap - 0.5) { npc.bestGap = gap; npc.bestBy = now + POLICE_STALL; }
  if (now <= npc.bestBy) return false;
  npc.bestGap = -Infinity; // (and stays so till it's going somewhere new: else, nudged nearer, it set off again, and stalled)
  return true;
}
// A shot, from from (x, z: you, there, as far as they can tell): those in earshot are on to you (an officer's shot gives
// away where it's shooting, not where you are: when it couldn't see you, they all ran straight to you)
export function policeHear(from, x, z, now, on = youOn) {
  for (const npc of npcs) {
    const q = npc.imp.model.position;
    if (npc.police && !npc.sees && Math.hypot(q.x - from.x, q.z - from.z) < POLICE_HEAR) policeAlert(npc, now, x, z, on);
  }
}
// Not on to you: standing about, then strolling somewhere near, and standing again; somewhere out in the open, clear of
// the platform, the columns, the towers and the walls by more than they're felt from (AI_AVOID: else it was pushed off
// short of it, round and round it); into out (unit, XZ) the way it's going; returns its pace (0: standing)
export function policeStroll(npc, now, out) {
  const p = npc.imp.model.position, g = npc.strollTo;
  if (npc.strolling && (Math.hypot(g.x - p.x, g.y - p.z) < 0.7 || stalled(npc, Math.hypot(g.x - p.x, g.y - p.z), now))) { // there, or near as it gets
    npc.strolling = false; npc.standUntil = now + between(POLICE_STAND);
  }
  if (!npc.strolling) {
    if (now < npc.standUntil) return 0;
    const a = Math.random() * 2 * Math.PI, r = between(POLICE_STROLL);
    const edge = ARENA - 0.6 - AI_AVOID - 0.3;
    g.set(THREE.MathUtils.clamp(p.x + Math.sin(a) * r, -edge, edge), THREE.MathUtils.clamp(p.z + Math.cos(a) * r, -edge, edge));
    if (platformGap(g.x, g.y) < 0.5 + AI_AVOID + 0.3 || AROUND.some(([c, R], i) => i > 0 && c.distanceTo(g) < R + AI_AVOID + 0.3)) {
      npc.standUntil = now + 0.5; return 0; // (somewhere else, in a moment)
    }
    npc.strolling = true; npc.bestGap = Infinity;
  }
  wayTo(npc, p, g.x, g.y, false, out);
  steerClear(npc, out, 1);
  return 1;
}
// On to you, not seeing you: to where it last saw (or heard) you (up the stairs, if that's up on the platform or the
// balcony: how far it is that way, then), and there (near enough: it may be right by a column, where it's pushed off)
// it waits; or as near as it gets (see stalled); into out (unit, XZ) the way it's going; returns its pace (0: waiting)
export function policeSearch(npc, now, out) {
  const p = npc.imp.model.position, g = npc.seenAt, up = npc.seenOn, byStairs = up && !onTop(p, up);
  const down = !up && p.y > 0.01 && boxGap(BALCONY_FLIGHT, p.x, p.z) < 0.5 && !onTop(p, BALCONY); // (down the balcony's stairs)
  const gap = byStairs ? stairsTo(npc, p, g.x, g.y, up) : Math.hypot(g.x - p.x, g.y - p.z);
  // (not stalled on its way round to the stairs: held back at their foot by the others going up first, it gave up there;
  // and in line again, it's a fresh POLICE_STALL from there; nor on its way down the balcony's, away from you at first.
  // There only on your level: else it waited on the balcony, right over you)
  if ((byStairs && !npc.climb) || down) npc.bestGap = Infinity;
  if ((gap < 2 && Math.abs(p.y - (up ? up.y : 0)) < 1) || (!(byStairs && !npc.climb) && !down && stalled(npc, gap, now))) return 0;
  wayTo(npc, p, g.x, g.y, up, out);
  steerClear(npc, out, 1);
  return 1;
}
