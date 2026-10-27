// The demons hit (stagger, death) and on the move: hunting you, dodging, steering clear, the way up the stairs
// and over the balcony
import './debug.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { ARENA, COLUMNS, COLUMN_APOTHEM, TOWERS, TOWER_HALF, PLATFORM_H, PLATFORM_STEP, PLATFORM_APOTHEM, _pf,
  platformDist, STAIR_RUN, STAIR_HALF, STAIR_SLOPE, STAIR_FOOT, FLIGHTS, BALCONY_Y, BALCONY_D, BALCONY_BRIDGE, DECKS,
  overDeck, BALCONY_FLIGHT, ALL_FLIGHTS, stairLocal, floorAt, BODY_H, STAIR_PIECES, rayConvex } from './arena.js';
import { camera } from './camera.js';
import { rayOctagon } from './holes.js';
import { audio, shotOut, sounds, DEMON_DEATHS } from './audio.js';
import { ZOMBIE_REACH, ZOMBIE_SPACING } from './player.js';
import { npcs, corpses, _v, nextVolley } from './enemies.js';
import { POLICE_DODGE, policeAlert } from './police.js';
import { GIB_TAU } from './gibs.js';
import { UP, move, q, clock, youOn } from './main.js';

// Hit reaction: a hit demon stops walking (its pose frozen) for STAGGER_TIME, refreshed by every hit, and is knocked
// back along the shot, the push easing off (KNOCK_DRAG) and a shudder shaking it back and forth along the shot on top.
// It's still free to turn towards where it was heading, and to shoot (a volley carries on, and new ones start).
const STAGGER_TIME = 0.35, KNOCK_SPEED = 0.8, KNOCK_DRAG = 10; // s, m/s per hit, 1/s
const SHUDDER = 0.03, SHUDDER_RATE = 45; // m, rad/s
// Health: DEMON_HEALTH hits. Each hit staggers it; the last one kills it: whatever it was doing stops, it plays
// "Death From Back Headshot" (Mixamo, retargeted onto the demon rig: models/demon_death.glb) once, turned to face you,
// and stays where it fell, lying there for good, drawn only from the front from then on. A body still bleeds and takes wounds when shot, but nothing else.
export const DEMON_HEALTH = 12;
// A demon's voice: as it walks, a grunt every DEMON_GRUNT_EVERY s or so (at random within it), quieter the further
// off; each demon pitched a little differently, so the pack doesn't all sound alike. Returns the sound (to stop it)
export const DEMON_GRUNT_EVERY = [3, 8]; // s
export function demonVoice(npc, name, level, pitch = 1) {
  npc.voice ??= 0.88 + Math.random() * 0.24;
  const d = npc.imp.model.position.distanceTo(camera.position);
  if (!sounds[name]) return;
  const src = audio.createBufferSource(), gain = audio.createGain();
  src.buffer = sounds[name];
  src.playbackRate.value = pitch * npc.voice * (0.95 + Math.random() * 0.1);
  gain.gain.value = level / (1 + d * 0.12);
  src.connect(gain).connect(shotOut);
  src.start();
  if (name !== 'demon_shot' && name !== 'punch') { (npc.voices ??= new Set()).add(src); src.onended = () => npc.voices.delete(src); } // (its
  // voice, playing: see cutBody)
  return src;
}
export function damageNpc(npc, dir) {
  if (npc.dead) return;
  if (--npc.health > 0) {
    if (npc.police) policeAlert(npc, clock.elapsedTime); // (shot, or punched: it knows where you are)
    return staggerNpc(npc, dir);
  }
  npc.dead = true;
  if (npc.zombie) demonVoice(npc, 'zombie_death', 1.2); // its death cry (a zombie's: quieter, made up for; its top blown
  else demonVoice(npc, `demon_death_${(Math.random() * DEMON_DEATHS) | 0}`, 1.0); // off, cut short: see cutBody)
  npc.stagger = 0;
  // a demon turns to face you as it dies (it falls back); a zombie or an officer falls forward whichever way it's facing,
  // as Mixamo's Zombie Dying does (turned away, it spun round as it died). From then on it's only drawn from one side:
  // where you were as it died
  const m = npc.imp.model, toYou = Math.atan2(camera.position.x - m.position.x, camera.position.z - m.position.z);
  if (npc.demon) m.quaternion.setFromAxisAngle(UP, toYou + npc.kind.facing);
  _v.set(0, 0, 1).applyQuaternion(m.quaternion);
  npc.imp.frontOnly = true;
  npc.imp.frontAz = toYou - Math.atan2(_v.x, _v.z); // (round from its front: see SpriteImpostor)
  if (npc.fall) m.position.y = floorAt(m.position.x, m.position.z, m.position.y); // (killed as it dropped off an edge: down there, not hung in the air)
  npc.firing = false;
  npc.walk.fadeOut(0.15);
  npc.fire.fadeOut(0.15);
  npc.idle.fadeOut(0.15);
  npc.run?.fadeOut(0.15);
  npc.aimWalk?.fadeOut(0.15);
  npc.walkGait.fadeOut(0.15);
  npc.death.reset().fadeIn(0.15).play();
  const k = npcs.indexOf(npc); // its body goes on as a corpse; the enemy goes
  if (k >= 0) npcs.splice(k, 1);
  const now = clock.elapsedTime, leak = Math.exp(-(now - (npc.hurtAt ?? now)) / GIB_TAU), trauma = (npc.trauma ?? 0) * leak; // (see Gibs)
  npc.corpse = { demon: npc.demon, imp: npc.imp, mesh: npc.mesh, dead: true, bloodRT: npc.bloodRT, death: npc.death, trauma, hurtAt: now, carcass: 0, diedAt: now, deathTrauma: trauma, voices: npc.voices };
  corpses.push(npc.corpse); // (and the enemy names it: a shot's later pellets still name the enemy)
}
function staggerNpc(npc, dir) {
  npc.stagger = STAGGER_TIME;
  npc.shakeDir.set(dir.x, 0, dir.z).normalize();
  npc.knock.addScaledVector(npc.shakeDir, KNOCK_SPEED);
}
export function updateStagger(npc, dt) {
  const m = npc.imp.model, p = m.position, left = npc.stagger / STAGGER_TIME;
  npc.stagger = Math.max(npc.stagger - dt, 0);
  npc.walk.timeScale = 0; // frozen mid-stride; the pace eases it back after
  if (!npc.police) npc.pace = 0; // (the police: straight back to it after; easing up from 0, their run was slow motion, a walk)
  // shudder: a velocity whose integral is SHUDDER × sin, so it shakes about where the knock carries it
  const phase = (STAGGER_TIME - npc.stagger) * SHUDDER_RATE;
  p.addScaledVector(npc.knock, dt).addScaledVector(npc.shakeDir, SHUDDER * SHUDDER_RATE * Math.cos(phase) * left * dt);
  npc.knock.multiplyScalar(Math.exp(-KNOCK_DRAG * dt));
  p.x = THREE.MathUtils.clamp(p.x, -ARENA + 0.5, ARENA - 0.5); p.z = THREE.MathUtils.clamp(p.z, -ARENA + 0.5, ARENA - 0.5);
  pushOutOfColumns(p); // (the platform and the stairs: in the hard collision, after)
  steer(m, move.subVectors(camera.position, p).setY(0).normalize(), 0, dt, npc.kind.facing); // free to turn: towards you
}
// Demons hunt you rather than wander. Each has its own distance from you (orbitR, somewhere in AI_ORBIT): further
// out, it closes in on you (mostly straight at you, angling round a little); once there, it circles you one way or the
// other (orbitDir, switching now and then); and if you close on it, inside its distance, it circles round you while
// opening the gap back up, never backing straight off. When your aim
// comes near it (its body within AI_AIM_MARGIN of your line of fire, in range), it breaks sideways off the line of
// fire, fast, for a moment, the way it's already leaning, and a volley it's firing is abandoned. Columns, the centre
// platform and the walls push it away as it nears them, plus a sideways nudge so it slides round them rather than
// stalling against them; hard collision with them after. They keep apart from each other too: another demon within
// AI_SPACING pushes it away (harder the closer), and two never overlap (AI_BODY). Shooters turn to face you to fire.
export const AI_ORBIT = [6, 12], AI_AIM_MARGIN = 1.3, AI_AIM_RANGE = 40; // m, m, m
const AI_SPACING = 3, AI_BODY = 1.2; // m: how far apart demons like to keep; closest they ever get (centre to centre)
export const AI_DODGE_TIME = 0.5, AI_DODGE_SPEED = 1.6, AI_AVOID = 2; // s; pace multiplier while dodging; m an obstacle is felt from
const AI_AHEAD = 4; // m: how far ahead it looks for something big in its way (see wayTo)
const _ai = new THREE.Vector3(), _aim = new THREE.Vector3(), _toMe = new THREE.Vector3(), _obs = new THREE.Vector3();
const COLUMN_BODY = COLUMN_APOTHEM / Math.cos(Math.PI / 8) + 0.5; // a column's corner, plus a demon's body
const TOWER_BODY = TOWER_HALF * Math.SQRT2 + 0.5; // a tower's corner post, plus a demon's body
// What an enemy goes round when it's in its way (see wayTo): its centre, the radius it's steered round (its body's,
// padded), and its solid radius, what blocks the way (null: the platform, by its own shape and stairs)
export const AROUND = [[new THREE.Vector2(), Math.hypot(PLATFORM_APOTHEM + 3 * STAIR_RUN, STAIR_HALF) + 0.5, null],
  ...COLUMNS.map((c) => [c, COLUMN_BODY, COLUMN_APOTHEM / Math.cos(Math.PI / 8)]),
  ...TOWERS.map((c) => [c, TOWER_BODY, TOWER_HALF * Math.SQRT2])];
// How far (x, z) is from the platform or its stairs; from the balcony or its; across the floor (0: on them, or under)
export const boxGap = (b, x, z) => {
  const [e, a] = stairLocal(b, x, z);
  return Math.hypot(e - THREE.MathUtils.clamp(e, b.e0, b.e1), a - THREE.MathUtils.clamp(a, -b.half, b.half));
};
export function platformGap(x, z) {
  let g = Math.max(platformDist(x, z) - PLATFORM_APOTHEM, 0);
  for (const f of FLIGHTS) g = Math.min(g, boxGap(f, x, z));
  return g;
}
export const balconyGap = (x, z) => DECKS.reduce((g, b) => Math.min(g, boxGap(b, x, z)), boxGap(BALCONY_FLIGHT, x, z));
// The raised places, to the enemies: { flights up to it, gap: how far from it (see above), y: its top } (the one
// you're up on: youOn, in the main loop)
export const PLATFORM = { flights: FLIGHTS, gap: platformGap, y: PLATFORM_H }, BALCONY = { flights: [BALCONY_FLIGHT], gap: balconyGap, y: BALCONY_Y };
const _zo = new THREE.Vector3(), _zd = new THREE.Vector3();
// Is your aim on this demon? (its body within AI_AIM_MARGIN of your line of fire); if so, which side of it it's on
export function aimedAt(p, centreY) {
  camera.getWorldDirection(_aim);
  _toMe.set(p.x, centreY, p.z).sub(camera.position);
  const along = _toMe.dot(_aim);
  if (along <= 0 || along > AI_AIM_RANGE) return 0;
  _toMe.addScaledVector(_aim, -along); // off the line of fire, sideways
  if (_toMe.length() > AI_AIM_MARGIN) return 0;
  return Math.sign(_aim.z * _toMe.x - _aim.x * _toMe.z) || 1; // which side of the line it's on
}
// The direction a living demon wants to go, into out (unit, XZ); returns its pace multiplier for this frame
export function thinkDemon(npc, dt, out) {
  const p = npc.imp.model.position;
  if ((npc.orbitTimer -= dt) <= 0) { npc.orbitDir = Math.random() < 0.3 ? -npc.orbitDir : npc.orbitDir; npc.orbitTimer = 3 + Math.random() * 5; }
  _ai.subVectors(camera.position, p).setY(0);
  const dist = Math.max(_ai.length(), 1e-3);
  _ai.divideScalar(dist); // towards you
  let pace = 1;
  if (npc.zombie) { // a zombie: straight at you (no circling, no dodging, no backing off), past anything big in the way
    wayTo(npc, p, camera.position.x, camera.position.z, youOn, out);
  } else {
    const tx = -_ai.z * npc.orbitDir, tz = _ai.x * npc.orbitDir; // round you
    const side = aimedAt(p, p.y + npc.imp.fit.y);
    npc.dodge -= dt; // (first: still aimed at as it runs out, it dodges on, never a frame off it, the run restarting)
    if (side && npc.dodge <= 0) {
      npc.dodge = npc.police ? POLICE_DODGE : AI_DODGE_TIME; npc.dodgeSide = side;
      if (npc.firing) { // aimed at: abandon the volley and move
        npc.firing = false; npc.timer = nextVolley();
        npc.fire.fadeOut(0.1); npc.walk.reset().fadeIn(0.1).play();
      }
    }
    // closing in till it's within orbitR + 0.5, and again once it's out past orbitR + 3 (at the one line, orbitR + 1, it
    // flicked between the two as it circled; the police fire only in among it, not closing); or, you up on the platform
    // (or the balcony), till it's at its edge, as near as it gets (else it circled there, closing in, for good, and
    // never fired)
    npc.closing = dist > npc.orbitR + (npc.closing ? 0.5 : 3) && !(youOn && youOn.gap(p.x, p.z) < 0.5 + AI_AVOID + 0.2);
    if (npc.dodge > 0) { // break sideways off your line of fire (perpendicular to it, the side it's on), a little forward
      camera.getWorldDirection(_aim).setY(0).normalize();
      out.set(-_aim.z * npc.dodgeSide * -1, 0, _aim.x * npc.dodgeSide * -1).addScaledVector(_ai, 0.2);
      npc.orbitDir = Math.sign(out.x * tx + out.z * tz) || npc.orbitDir; // carry on round you that way after
      pace = npc.police ? 1 : AI_DODGE_SPEED; // (the police: at a run)
    } else if (npc.closing) { // further out: close in on you, angling round a little
      out.set(tx, 0, tz).multiplyScalar(0.35).add(_ai);
    } else { // there: circle round you, opening the gap back up the closer it is (and drifting back in, outside it)
      out.set(tx, 0, tz).addScaledVector(_ai, -THREE.MathUtils.clamp((npc.orbitR - dist) / 2, -0.5, 1) * 0.8);
    }
    // and past anything big that way (its circle round you often ran through the platform: it ran on the spot at its
    // edge, pushed off it as it pushed on)
    out.normalize();
    wayTo(npc, p, p.x + out.x * AI_AHEAD, p.z + out.z * AI_AHEAD, false, out);
    // circling on into a wall it's up against: round you the other way (where its circle met the wall, the wall's push
    // and its own cancelled out: on the spot); not again for a second (in a corner it flicked from one way to the other)
    const alongX = Math.abs(p.x) > Math.abs(p.z), wall = Math.sign(alongX ? p.x : p.z) || 1; // the nearest wall's way
    if (!npc.closing && npc.dodge <= 0 && ARENA - Math.max(Math.abs(p.x), Math.abs(p.z)) < AI_AVOID + 0.6
      && (alongX ? out.x : out.z) * wall > 0.3 && clock.elapsedTime > (npc.flipAt ?? 0)) {
      npc.orbitDir = -npc.orbitDir; npc.flipAt = clock.elapsedTime + 1;
    }
  }
  // (a zombie closing on you feels obstacles less and less: backed up to a wall or a column, you were held just out of
  // its reach; the hard collisions still keep it out of them. Not on its way round to the stairs, up to you: near you
  // across the floor, it's a long way off)
  steerClear(npc, out, npc.zombie && !(youOn && !onTop(p, youOn)) ? THREE.MathUtils.clamp((dist - ZOMBIE_REACH) / AI_AVOID, 0, 1) : 1);
  return pace;
}
// out (a way to go, XZ), pushed off what's near: obstacles, as it nears them, and nudged round them the way it's going;
// the others; the walls (near: how much the obstacles count, 0-1); made unit
export function steerClear(npc, out, near) {
  const p = npc.imp.model.position;
  out.normalize();
  const avoid = (nx, nz, gap) => { // (nx, nz): unit, away from the obstacle; gap: m to its surface
    if (gap >= AI_AVOID) return;
    const k = (1 - gap / AI_AVOID) * 2.5 * near, round = out.x * -nz + out.z * nx >= 0 ? 1 : -1;
    out.x += (nx + -nz * round) * k; out.z += (nz + nx * round) * k;
  };
  const high = p.y > BALCONY_Y - 0.5; // (up on the balcony: the columns and towers aren't in its way; and the others aren't
  // felt, a bridge's only a cell wide: they pushed each other off it, and off the towers' bridges by the towers)
  if (!high) for (const [c, r] of [...COLUMNS.map((c) => [c, COLUMN_BODY]), ...TOWERS.map((c) => [c, TOWER_BODY])]) {
    _obs.set(p.x - c.x, 0, p.z - c.y);
    const d = Math.max(_obs.length(), 1e-3);
    avoid(_obs.x / d, _obs.z / d, d - r);
  }
  if (!npc.climb && p.y < 0.01) { // the platform and the stairs: in the way of one on the floor, not on its way up them
    const pd = platformDist(p.x, p.z);
    avoid(_pf.x, _pf.y, pd - PLATFORM_APOTHEM - 0.5);
    for (const f of ALL_FLIGHTS) { // each flight: away from its nearest point (of the steps it can't walk under: under
      // the balcony's high ones, you were out of reach), or inside them, out its open side (−t: the balcony's)
      const [e, a] = stairLocal(f, p.x, p.z), top = f.steps.find((b) => b.y0 < p.y + BODY_H).e0;
      const de = e - THREE.MathUtils.clamp(e, top, f.run), da = a - THREE.MathUtils.clamp(a, -f.half, f.half);
      const d = Math.hypot(de, da);
      if (d > 1e-3) avoid((f.n.x * de + f.t.x * da) / d, (f.n.y * de + f.t.y * da) / d, d - 0.5);
      else avoid(-f.t.x, -f.t.y, 0);
    }
  }
  for (const o of npcs) { // each other: pushed apart, harder the closer (not on its way up a flight: in single file up it,
    // else they held each other back at its foot, or pushed each other off its sides; they never overlap: see pushApart;
    // nor one up on the balcony and one under it)
    if (o === npc || npc.climb || high) continue;
    const q = o.imp.model.position, dx = p.x - q.x, dz = p.z - q.z, d = Math.hypot(dx, dz);
    const spacing = npc.zombie ? ZOMBIE_SPACING : AI_SPACING;
    if (d >= spacing || d < 1e-4 || Math.abs(p.y - q.y) > 1) continue;
    const k = (1 - d / spacing) * 2;
    out.x += dx / d * k; out.z += dz / d * k;
  }
  const foot = npc.stairs && npc.flight.footAt; // (the walls: not on its way up, or down, a flight, nor at its foot: the
  // balcony's runs along one, a metre off it; else, making for it along the wall, it was held off it, or stuck under it)
  if (!npc.climb && !(foot && Math.hypot(foot.x - p.x, foot.y - p.z) < AI_AVOID + 1)) {
    for (const [nx, nz, gap] of [[-1, 0, ARENA - p.x], [1, 0, ARENA + p.x], [0, -1, ARENA - p.z], [0, 1, ARENA + p.z]]) avoid(nx, nz, gap - 0.6);
  }
  out.normalize();
}
export function pushApart(npc) { // two living demons never overlap: each moves half the overlap
  const p = npc.imp.model.position;
  for (const o of npcs) {
    if (o === npc) continue;
    const q = o.imp.model.position, dx = p.x - q.x, dz = p.z - q.z, d = Math.hypot(dx, dz);
    if (d >= AI_BODY || d < 1e-4 || Math.abs(p.y - q.y) > 0.5) continue; // (one up on the platform's edge, one below it: apart)
    const k = (AI_BODY - d) / d / 2;
    p.x += dx * k; p.z += dz * k; q.x -= dx * k; q.z -= dz * k;
  }
}
export function pushOutOfColumns(p) { // and the towers
  for (const [c, r] of [...COLUMNS.map((c) => [c, COLUMN_BODY]), ...TOWERS.map((c) => [c, TOWER_BODY])]) {
    const dx = p.x - c.x, dz = p.z - c.y, d = Math.hypot(dx, dz);
    if (d < r && d > 1e-6) { p.x = c.x + dx / d * r; p.z = c.y + dz / d * r; }
  }
}
export function steer(model, dir, speed, dt, facing) { // dir: normalized XZ direction
  model.quaternion.slerp(q.setFromAxisAngle(UP, Math.atan2(dir.x, dir.z) + facing), 1 - Math.exp(-12 * dt));
  model.position.addScaledVector(dir, speed * dt);
}
// The way up to (gx, gz), on a raised place (up, see PLATFORM) or its stairs, from below: to the foot of the flight
// that's least out of the way (footAt), then straight up its middle to a metre in on the top (topAt). It keeps to the
// flight it picked unless another's 2 m less out of the way (half way between two, it dithered). Into _way the point to
// make for, and npc.climb: it's on its way up (in line with the flight, in front of it, or on a step of it; not under
// it); returns how far it is, that way, to (gx, gz)
const _way = new THREE.Vector2();
export const onTop = (p, up) => p.y > up.y - 0.01 && p.y < up.y + 1 && up.gap(p.x, p.z) < 0.5; // up on its top (not over it, on a bridge)
export function stairsTo(npc, p, gx, gz, up) {
  const was = npc.flight;
  let best = Infinity, left = Infinity;
  npc.climb = false;
  for (const f of up.flights) {
    const [e, a] = stairLocal(f, p.x, p.z), on = Math.hypot(gx - f.topAt.x, gz - f.topAt.y);
    // in line: up it (from as far out as the flight's felt, see steerClear: else, head on, its push and the pull on
    // cancelled out short of it, on the spot); not down under its high steps, or its top
    if (e > -0.5 && e < f.run + 0.5 + AI_AVOID && Math.abs(a) < f.half + (p.y > 0.01 ? 0.2 : -0.1)
      && p.y + 1 > f.top - Math.max(e, 0) * STAIR_SLOPE) {
      npc.climb = true; npc.flight = f;
      const [ge, ga] = stairLocal(f, gx, gz); // (there on this flight too: straight to it; else, coming down to you on
      // it from the top, it was turned back up each time it stepped down, and bobbed at the top step)
      if (ge > -0.4 && ge < f.run + 0.4 && Math.abs(ga) < f.half + 0.4) { _way.set(gx, gz); return Math.hypot(gx - p.x, gz - p.z); }
      _way.copy(f.topAt);
      return Math.hypot(f.topAt.x - p.x, f.topAt.y - p.z) + on;
    }
    const way = Math.hypot(f.footAt.x - p.x, f.footAt.y - p.z) + f.run + STAIR_FOOT + 1 + on;
    if (way - (f === was ? 2 : 0) < best) { best = way - (f === was ? 2 : 0); left = way; npc.flight = f; _way.copy(f.footAt); }
  }
  return left;
}
// Up on the balcony, the way over it to (gx, gz), up on it too, into _way: straight there, if that's over its floor all
// the way (a little in from its edges, to set off that way; once going straight there, less: else, a little off a
// bridge's middle, it turned back for the waypoint it had just left); else to the next of its waypoints (DECK_NODES)
// on the shortest way there by them (round it, or over a bridge: not across, that's a drop), from the one it's at, if
// it's at one. That's looked for again every BALCONY_REROUTE s, and on getting to one (npc.deckTo, npc.deckAt).
const BALCONY_RING = ARENA - BALCONY_D / 2, BALCONY_REROUTE = 0.3; // m: its walkway's middle, out from the room's; s
function deckClear(ax, az, bx, bz, m = 0.6) { // over the balcony's floor all the way from (ax, az) to (bx, bz), m in from
  // its edges? (a metre at either end: just on it)
  const len = Math.hypot(bx - ax, bz - az), n = Math.ceil(len / 0.5);
  for (let i = 0; i <= n; i++) {
    const u = n ? i / n : 0, x = ax + (bx - ax) * u, z = az + (bz - az) * u;
    if (!overDeck(x, z)) return false;
    if (m && Math.min(u, 1 - u) * len > 1 && !(overDeck(x + m, z) && overDeck(x - m, z) && overDeck(x, z + m) && overDeck(x, z - m))) return false;
  }
  return true;
}
const BRIDGE_MID = (BALCONY_BRIDGE[0] + BALCONY_BRIDGE[1]) / 2; // m: the bridges' middle lines (x = this; z = −this)
const DECK_NODES = [new THREE.Vector2(BALCONY_FLIGHT.topAt.x, -BALCONY_RING), // (by the stairs' top, and the stairwell)
  new THREE.Vector2(BRIDGE_MID, -BRIDGE_MID)]; // (where the bridges cross)
for (const s of [-1, 1]) DECK_NODES.push(new THREE.Vector2(s * BALCONY_RING, -BALCONY_RING), new THREE.Vector2(s * BALCONY_RING, BALCONY_RING), // its corners,
  new THREE.Vector2(BRIDGE_MID, s * BALCONY_RING), new THREE.Vector2(s * BALCONY_RING, -BRIDGE_MID)); // where the bridges meet it
const DECK_LINKS = DECK_NODES.map((a) => DECK_NODES.map((b) => (a !== b && deckClear(a.x, a.y, b.x, b.y) ? a.distanceTo(b) : Infinity)));
// (x, z) if it's over the balcony's floor, else the nearest spot that is (a little in), into out: what deckWay goes
// from and to (on its stairs' top step, or at its rail, feet on it and middle off it, there was no way from there, or to)
function snapDeck(x, z, out) {
  if (overDeck(x, z)) return out.set(x, z);
  let b = DECKS[0], g = Infinity;
  for (const d of DECKS) { const k = boxGap(d, x, z); if (k < g) { g = k; b = d; } }
  const [e, a] = stairLocal(b, x, z), m = 0.05;
  const ee = THREE.MathUtils.clamp(e, b.e0 + m, b.e1 - m) + b.o, aa = THREE.MathUtils.clamp(a, m - b.half, b.half - m) + b.c;
  return out.set(b.n.x * ee + b.t.x * aa, b.n.y * ee + b.t.y * aa);
}
const _deckP = new THREE.Vector2(), _deckG = new THREE.Vector2();
function deckWay(npc, p, gx, gz) {
  const P = snapDeck(p.x, p.z, _deckP), G = snapDeck(gx, gz, _deckG);
  _way.copy(G);
  if ((npc.deckStraight = deckClear(P.x, P.y, G.x, G.y, npc.deckStraight ? 0.2 : 0.6))) return;
  const now = clock.elapsedTime, to = npc.deckTo;
  if (to && now < npc.deckAt && Math.hypot(to.x - p.x, to.y - p.z) > 1) { _way.copy(to); return; }
  const n = DECK_NODES.length, done = [], first = DECK_NODES.map((_, i) => i); // first: each one's first waypoint, on the way to it
  const at = DECK_NODES.findIndex((q) => Math.hypot(q.x - P.x, q.y - P.y) < 0.5); // (the one it's at: well in, else it
  // set off from a metre short of a bridge's end, along its very edge)
  const dist = DECK_NODES.map((q, i) => (at >= 0 ? (i === at ? 0 : Infinity)
    : deckClear(P.x, P.y, q.x, q.y) ? Math.hypot(q.x - P.x, q.y - P.y) : Infinity));
  for (let k = 0; k < n; k++) { // (Dijkstra's: the nearest one not done yet, and on from it)
    let i = -1;
    for (let j = 0; j < n; j++) if (!done[j] && (i < 0 || dist[j] < dist[i])) i = j;
    if (dist[i] === Infinity) break;
    done[i] = true;
    for (let j = 0; j < n; j++) if (dist[i] + DECK_LINKS[i][j] < dist[j]) { dist[j] = dist[i] + DECK_LINKS[i][j]; first[j] = i === at ? j : first[i]; }
  }
  let best = Infinity;
  DECK_NODES.forEach((q, i) => { // (its last leg a little in from the edges: off a bridge's middle, there was none)
    const d = dist[i] + Math.hypot(G.x - q.x, G.y - q.y);
    if (d < best && deckClear(q.x, q.y, G.x, G.y, 0.3)) { best = d; if (i === at) _way.copy(G); else _way.copy(DECK_NODES[first[i]]); }
  });
  if (best === Infinity) DECK_NODES.forEach((q, i) => { // none to it: as near as they go (not straight there, across a drop)
    const d = dist[i] + Math.hypot(G.x - q.x, G.y - q.y);
    if (i !== at && d < best) { best = d; _way.copy(DECK_NODES[first[i]]); }
  });
  npc.deckStraight = best < Infinity && _way.equals(G); // (on from the one it's at, straight there)
  (npc.deckTo ??= new THREE.Vector2()).copy(_way); npc.deckAt = now + BALCONY_REROUTE;
}
// The nearest spot off the balcony's floor to (x, z) under it (a metre on from its edge, inside the walls), into _way
function offDeck(x, z) {
  _way.set(x, z);
  for (let r = 1; r < 2 * BALCONY_D; r++) for (let k = 0; k < 8; k++) {
    const sx = Math.sin(k * Math.PI / 4), sz = Math.cos(k * Math.PI / 4), qx = x + sx * r, qz = z + sz * r;
    if (Math.abs(qx) < ARENA - 1.5 && Math.abs(qz) < ARENA - 1.5 && !overDeck(qx, qz)) { _way.set(qx + sx, qz + sz); return; }
  }
}
// The way for npc, from p to (gx, gz), into out (unit, XZ): straight there, or past anything big in the way (see
// AROUND), along the line that just clears whichever of its edges is more on the way (pushing straight at it, the
// obstacle's push and the pull on cancelled out: a zombie stood there running on the spot); right by it, that's round
// its edge. That edge it keeps to till it's been clear of it a moment, or the way on's turned back from it (head on, it
// picked one, then the other, frame by frame: on the spot again; kept when it had turned round, it went back and forth,
// the obstacle in its way one frame and not the next). up: the raised place (gx, gz) is up on (see PLATFORM), if it is:
// from below, it goes by its stairs (see stairsTo; npc.stairs), and once it's on its way up them they're where it's
// going, not in the way; up on the balcony, over it (see deckWay). null: (gx, gz) is down on the floor (off the
// balcony: down its stairs, if it's on them, boxed in by its floor; to under it, off its edge, the nearest bit to it:
// see offDeck); false: it's only a way to go. (Down its stairs only from above where it can just step off them, the
// platform's height: lower, it was sent back to their foot from each low step it walked onto, for good; and not as it
// drops into the stairwell (more than a step), else it was turned back onto the floor it fell from. Off its edge even as it drops off it:
// a moment into its fall, it had turned back for you, and was lifted back up.)
export function wayTo(npc, p, gx, gz, up, out) {
  npc.climb = npc.stairs = false;
  if (up !== BALCONY && up !== false && p.y > PLATFORM_H + 0.01 && p.y - floorAt(p.x, p.z, p.y) < PLATFORM_STEP && boxGap(BALCONY_FLIGHT, p.x, p.z) < 0.5 && !onTop(p, BALCONY)) {
    gx = BALCONY_FLIGHT.footAt.x; gz = BALCONY_FLIGHT.footAt.y; up = false; npc.climb = npc.stairs = true; npc.flight = BALCONY_FLIGHT;
  } else if (up && !onTop(p, up)) { stairsTo(npc, p, gx, gz, up); gx = _way.x; gz = _way.y; up = npc.climb; npc.stairs = true; }
  else if (up === BALCONY) { deckWay(npc, p, gx, gz); gx = _way.x; gz = _way.y; }
  else if (up === null && p.y > BALCONY_Y - 1 && overDeck(gx, gz)) { offDeck(gx, gz); gx = _way.x; gz = _way.y; }
  const ex = gx - p.x, ez = gz - p.z, len = Math.max(Math.hypot(ex, ez), 1e-3);
  out.set(ex / len, 0, ez / len);
  let nearest = Infinity, round = null;
  for (const it of AROUND) {
    const [c, R, solid] = it;
    const cx = c.x - p.x, cz = c.y - p.z, d0 = Math.hypot(cx, cz);
    if (cx * ex + cz * ez <= 0 || d0 >= nearest) continue; // behind it; or a nearer one's in the way already
    if (solid === null) { // the platform: unless it's going up there, is it (or a flight of stairs) really in the way? (a
      // step above its feet: the bottom step's stepped up onto from the floor; from the top, nothing's in the way)
      if (up) continue;
      _zo.set(p.x, p.y + 0.3, p.z); _zd.set(ex / len, 0, ez / len);
      const hits = [rayOctagon(_zo, _zd, 0, 0, PLATFORM_APOTHEM, PLATFORM_H), ...STAIR_PIECES.map((s) => rayConvex(_zo, _zd, s))];
      if (!hits.some((h) => h && h.t < len)) continue;
    } else { // a column or a tower: does the way pass through it?
      const u = THREE.MathUtils.clamp((cx * ex + cz * ez) / (len * len), 0, 1); // the way there: nearest to c
      if (Math.hypot(cx - ex * u, cz - ez * u) >= solid + 0.2) continue;
    }
    nearest = d0; round = it;
  }
  if (!round) return;
  const [c, R] = round, cx = c.x - p.x, cz = c.y - p.z, d0 = nearest, now = clock.elapsedTime;
  const a = Math.asin(Math.min(R / d0, 1)), ca = Math.cos(a), sa = Math.sin(a);
  const lx = cx * ca - cz * sa, lz = cx * sa + cz * ca, rx = cx * ca + cz * sa, rz = -cx * sa + cz * ca; // either edge
  const onL = (lx * ex + lz * ez) / (d0 * len), onR = (rx * ex + rz * ez) / (d0 * len); // how much each is on the way (cos)
  if (npc.round !== round || now > npc.roundUntil || (npc.roundLeft ? onL : onR) < -0.3) { npc.round = round; npc.roundLeft = onL >= onR; }
  npc.roundUntil = now + 0.5;
  if (npc.roundLeft) out.set(lx, 0, lz).divideScalar(d0); else out.set(rx, 0, rz).divideScalar(d0);
  if (d0 < R) out.addScaledVector(_zd.set(-cx / d0, 0, -cz / d0), Math.min((R - d0) / 2, 1)); // inside: out too (past stairs)
}
