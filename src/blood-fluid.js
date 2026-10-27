// Blood in the air: the fluid a hit throws (bursts, bleeding wounds), and where it lands
import './blood-surfaces.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { ARENA, COLUMNS, COLUMN_APOTHEM, PLATFORM_H, PLATFORM_APOTHEM, _pf, platformDist, stairHeight, floorAt } from './arena.js';
import { spawnDecal } from './decals.js';
import { addSheet, landSheet, showBlood } from './blood-sheets.js';

// Blood, thrown like paint: a hit bursts FL_GOBS gobs up and out of the demon, fanned all round the wound,
// simulated as a fluid with Position Based Fluids (Macklin & Müller 2013). A gob is a packet of particles at rest spacing FL_SPACING, launched front faster than back, so it stretches
// as it flies. Each step, every particle's density (from its neighbours within FL_H) is pushed towards the rest
// density both ways: crowded particles push apart, and ones at a thinning surface pull back in, which holds the
// liquid together in gobs and ropes (cohesion standing in for surface tension) until a rope stretches past the
// kernel's reach and snaps. XSPH viscosity pulls each particle's velocity towards its neighbours', so it moves as
// thick paint, not water. Gravity arcs it down; a particle that touches the floor, a wall or a column is gone, and
// some leave a stain.
// Drawn as screen-space metaballs: each particle is splatted as a soft blob into a low-res field (one texel per
// GOO_PIXEL screen px), summing weight, depth and a sphere normal; then a full-screen pass in the world draws liquid
// wherever the summed weight passes GOO_THRESHOLD, so neighbouring particles merge into one surface and necks
// vanish as they thin. It's shaded smoothly from the blended normal and writes the liquid's depth, so walls
// and demons in front hide it. Lit like the demons (see bloodLight), fogged like the world.
export const FL_MAX = 4096, FL_SPACING = 0.018, FL_H = 2.2 * FL_SPACING, FL_NB = 48; // particles, m rest spacing, m kernel reach, neighbours kept
export const FL_STEP = 1 / 60, FL_ITERS = 3, FL_GRAVITY = 12, FL_LIFE = 2;  // s, solver passes per step, m/s², s
const FL_GOB_START = 0.15, FL_WOUND_OUT = 0.15, FL_TOWARDS_YOU = 0.6; // m out from the wound each gob starts; m the
// wound is pulled out of the body towards you (the hit sphere is rough); how much the burst leans towards you
const FL_ELEVATION = [0.5, 1.2]; // rad, how steeply each gob is thrown up (from, to)
const FL_MAX_MOVE = 0.1 * FL_SPACING; // m, most a particle's moved per solver pass
const FL_VISCOSITY = 0.3, FL_COHESION = 0.4, FL_EPS = 50 * (0.065 / FL_H) ** 2; // XSPH share per step; most density deficit pulled
// in; relaxation (the constraint gradients grow as 1/reach², so it does too: tuned at a 0.065 m reach)
export const FL_GOBS = 4, FL_GOB_R = 0.025, FL_GOB_LEN = 0.15, FL_SPREAD = 0.35, FL_DECAL_EVERY = 16; // per hit, m, m, back slower by, 1 in
// Stains: where a gob's splat lands, one big stain about its size: the stain's body is a quarter of its size (its
// fingers reach ~0.6), so STAIN_SHARE of the drawn splat's half-size makes the body as wide as the splat's solid
// centre (SHEET_CORE) and the fingers reach its arms; every FL_DECAL_EVERY'th stray particle leaves a small satellite
// drop (FL_DROP m)
export const STAIN_SHARE = 1.0, STAIN_MAX = 1.0, FL_DROP = 0.02; // a landed rope is long, so most reach STAIN_MAX
export const GOO_PIXEL = 4, GOO_SPLAT = 3 * FL_SPACING, GOO_THRESHOLD = 1.2; // screen px per field texel; m splat radius; liquid weight
export const BLOOD_METABALLS = false; // trying: the web billboards alone (the particles still fly, carrying them)
export const GOO_MIN_SPLAT = 1.5; // field texels: a far splat is drawn at least this big, or it'd fall between texels and flicker
const FL_H2 = FL_H * FL_H, POLY6 = 315 / (64 * Math.PI * FL_H ** 9), SPIKY = -45 / (Math.PI * FL_H ** 6);
const poly6 = (r2) => (r2 < FL_H2 ? POLY6 * (FL_H2 - r2) ** 3 : 0);
let FL_RHO0 = 0; // rest density: a particle's neighbourhood packed at FL_SPACING
for (let x = -3; x <= 3; x++) for (let y = -3; y <= 3; y++) for (let z = -3; z <= 3; z++) FL_RHO0 += poly6((x * x + y * y + z * z) * FL_SPACING ** 2);
const SCORR_W = poly6((0.2 * FL_H) ** 2); // artificial pressure (keeps particles from clumping in pairs)
const scorr = (r2) => -0.02 * (poly6(r2) / SCORR_W) ** 4;

export const flP = new Float32Array(FL_MAX * 3), flX = new Float32Array(FL_MAX * 3), flV = new Float32Array(FL_MAX * 3);
export const flSerial = new Uint32Array(FL_MAX); // which particle holds a slot (slots are reused): sheets check theirs is still there
export const flSheet = new Int32Array(FL_MAX).fill(-1); // the sheet a particle carries (as one of its ends), or -1
let flSerialNext = 1;
const flD = new Float32Array(FL_MAX * 3), flLam = new Float32Array(FL_MAX), flLife = new Float32Array(FL_MAX);
export const flAlive = new Uint8Array(FL_MAX), flAct = new Int32Array(FL_MAX);
const flNb = new Int32Array(FL_MAX * FL_NB), flNbN = new Int32Array(FL_MAX);
let flHead = 0, flN = 0;
// neighbour search: a spatial hash of FL_H cells, counting-sorted each step
const FL_CELLS = 8192, cellStart = new Int32Array(FL_CELLS + 1), cellOf = new Int32Array(FL_MAX), cellSorted = new Int32Array(FL_MAX);
const cellFill = new Int32Array(FL_CELLS);
const cellKey = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (FL_CELLS - 1);
const _seen = new Int32Array(27);
function flNeighbours() {
  cellStart.fill(0);
  for (let a = 0; a < flN; a++) {
    const i = flAct[a], k = i * 3;
    cellStart[(cellOf[i] = cellKey(Math.floor(flX[k] / FL_H), Math.floor(flX[k + 1] / FL_H), Math.floor(flX[k + 2] / FL_H))) + 1]++;
  }
  for (let c = 1; c <= FL_CELLS; c++) cellStart[c] += cellStart[c - 1]; // cell c's particles: cellStart[c] … cellStart[c + 1]
  cellFill.set(cellStart.subarray(0, FL_CELLS));
  for (let a = 0; a < flN; a++) { const i = flAct[a]; cellSorted[cellFill[cellOf[i]]++] = i; }
  for (let a = 0; a < flN; a++) {
    const i = flAct[a], k = i * 3, x = flX[k], y = flX[k + 1], z = flX[k + 2];
    const cx = Math.floor(x / FL_H), cy = Math.floor(y / FL_H), cz = Math.floor(z / FL_H);
    let n = 0, seen = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const c = cellKey(cx + dx, cy + dy, cz + dz);
      let dup = false;
      for (let s = 0; s < seen; s++) if (_seen[s] === c) dup = true;
      if (dup) continue; // two cells hashed to one bucket: it's already been searched
      _seen[seen++] = c;
      for (let s = cellStart[c], e = cellStart[c + 1]; s < e && n < FL_NB; s++) {
        const j = cellSorted[s], m = j * 3;
        if (j === i) continue;
        const ex = x - flX[m], ey = y - flX[m + 1], ez = z - flX[m + 2];
        if (ex * ex + ey * ey + ez * ez < FL_H2) flNb[i * FL_NB + n++] = j;
      }
    }
    flNbN[i] = n;
  }
}
export function flStep(dt) {
  flN = 0; // predict: gravity, then where each particle would go
  for (let i = 0; i < FL_MAX; i++) {
    if (!flAlive[i]) continue;
    if ((flLife[i] -= dt) <= 0) { flAlive[i] = 0; continue; }
    const k = i * 3;
    flV[k + 1] -= FL_GRAVITY * dt;
    for (let c = 0; c < 3; c++) flX[k + c] = flP[k + c] + flV[k + c] * dt;
    flAct[flN++] = i;
  }
  if (!flN) return;
  flNeighbours();
  for (let it = 0; it < FL_ITERS; it++) {
    for (let a = 0; a < flN; a++) { // each particle's density error, and how far that moves it per unit λ
      const i = flAct[a], k = i * 3, nb = i * FL_NB;
      let rho = poly6(0), gx = 0, gy = 0, gz = 0, g2 = 0;
      for (let b = 0; b < flNbN[i]; b++) {
        const m = flNb[nb + b] * 3, ex = flX[k] - flX[m], ey = flX[k + 1] - flX[m + 1], ez = flX[k + 2] - flX[m + 2];
        const r2 = ex * ex + ey * ey + ez * ez, r = Math.sqrt(r2);
        if (r >= FL_H || r < 1e-7) continue;
        rho += poly6(r2);
        const g = SPIKY * (FL_H - r) ** 2 / (r * FL_RHO0);
        gx += g * ex; gy += g * ey; gz += g * ez; g2 += g * g * r2;
      }
      const C = Math.max(rho / FL_RHO0 - 1, -FL_COHESION); // > 0 crowded: push apart; < 0 sparse: pull together
      flLam[i] = -C / (g2 + gx * gx + gy * gy + gz * gz + FL_EPS);
    }
    for (let a = 0; a < flN; a++) { // move each particle to cancel its and its neighbours' errors
      const i = flAct[a], k = i * 3, nb = i * FL_NB;
      let dx = 0, dy = 0, dz = 0;
      for (let b = 0; b < flNbN[i]; b++) {
        const j = flNb[nb + b], m = j * 3, ex = flX[k] - flX[m], ey = flX[k + 1] - flX[m + 1], ez = flX[k + 2] - flX[m + 2];
        const r2 = ex * ex + ey * ey + ez * ez, r = Math.sqrt(r2);
        if (r >= FL_H || r < 1e-7) continue;
        const s = (flLam[i] + flLam[j] + scorr(r2)) * SPIKY * (FL_H - r) ** 2 / (r * FL_RHO0);
        dx += s * ex; dy += s * ey; dz += s * ez;
      }
      const len = Math.hypot(dx, dy, dz), cap = Math.min(1, FL_MAX_MOVE / Math.max(len, 1e-9)); // overlapping gobs part gently
      flD[k] = dx * cap; flD[k + 1] = dy * cap; flD[k + 2] = dz * cap;
    }
    for (let a = 0; a < flN; a++) { const k = flAct[a] * 3; flX[k] += flD[k]; flX[k + 1] += flD[k + 1]; flX[k + 2] += flD[k + 2]; }
  }
  for (let a = 0; a < flN; a++) { // velocity from how far it actually went
    const k = flAct[a] * 3;
    for (let c = 0; c < 3; c++) flV[k + c] = (flX[k + c] - flP[k + c]) / dt;
  }
  for (let a = 0; a < flN; a++) { // XSPH viscosity: towards the neighbourhood's (weighted) mean velocity
    const i = flAct[a], k = i * 3, nb = i * FL_NB;
    let w0 = poly6(0), vx = 0, vy = 0, vz = 0;
    for (let b = 0; b < flNbN[i]; b++) {
      const m = flNb[nb + b] * 3, ex = flX[k] - flX[m], ey = flX[k + 1] - flX[m + 1], ez = flX[k + 2] - flX[m + 2];
      const w = poly6(ex * ex + ey * ey + ez * ez);
      w0 += w; vx += w * (flV[m] - flV[k]); vy += w * (flV[m + 1] - flV[k + 1]); vz += w * (flV[m + 2] - flV[k + 2]);
    }
    flD[k] = FL_VISCOSITY * vx / w0; flD[k + 1] = FL_VISCOSITY * vy / w0; flD[k + 2] = FL_VISCOSITY * vz / w0;
  }
  for (let a = 0; a < flN; a++) {
    const i = flAct[a], k = i * 3;
    for (let c = 0; c < 3; c++) { flV[k + c] += flD[k + c]; flP[k + c] = flX[k + c]; }
    _bp.fromArray(flP, k);
    const surface = gooSurface(flV[k + 1] > 0);
    if (!surface) continue;
    const normal = surface === 'floor' ? null : _bn;
    if (flSheet[i] >= 0) landSheet(flSheet[i], i, normal);
    else if (i % FL_DECAL_EVERY === 0) spawnDecal(_bp, normal, _bv.fromArray(flV, k), FL_DROP);
    flAlive[i] = 0; // it's on the surface now
  }
}

const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _gobDir = new THREE.Vector3(), _gobFrom = new THREE.Vector3();
// A hit bursts up and out of the wound: FL_GOBS gobs fanned evenly round it (with a little jitter), each tipped up by
// FL_ELEVATION, out of the entry wound and leaning back towards the shooter (so it's in front of the demon, not
// hidden behind its body)
export function burstBlood({ entry, dir }, gobs = FL_GOBS, strength = 1, scale = 1) { // (strength: how fast, 1 a fresh hit's; scale: see SPLAT_SCALE)
  showBlood(); // now, not at the next tick
  const s = FL_SPACING, from = _gobFrom.copy(entry).addScaledVector(dir, -FL_WOUND_OUT), turn = Math.random() * 2 * Math.PI;
  for (let g = 0; g < gobs; g++) {
    const az = turn + (g + 0.6 * (Math.random() - 0.5)) * 2 * Math.PI / gobs;
    const el = THREE.MathUtils.lerp(FL_ELEVATION[0], FL_ELEVATION[1], Math.random());
    const d = _gobDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).addScaledVector(dir, -FL_TOWARDS_YOU).normalize();
    const speed = (3.5 + Math.random() * 2.5) * strength, R = FL_GOB_R * (0.7 + 0.6 * Math.random()), L = FL_GOB_LEN, U = L + 2 * R;
    _t1.set(0, 1, 0).cross(d).normalize(); _t2.copy(d).cross(_t1);
    let front = -1, back = -1; // its first and last particles: a web sheet spans them
    // a capsule of particles on the rest lattice along d, its back FL_GOB_START out from the wound (so the gobs
    // start apart: launched touching, cohesion would fuse them into one lump)
    for (let u = 0; u <= U; u += s) for (let a = -R; a <= R; a += s) for (let b = -R; b <= R; b += s) {
      const along = Math.max(Math.abs(u - U / 2) - L / 2, 0);
      if (along * along + a * a + b * b > R * R) continue;
      const i = flHead++ % FL_MAX, k = i * 3, sp = speed * (1 - FL_SPREAD * u / U); // the back lags: it stretches
      for (let c = 0; c < 3; c++) {
        const e = c === 0 ? 'x' : c === 1 ? 'y' : 'z';
        flP[k + c] = from[e] + d[e] * (FL_GOB_START + U - u) + _t1[e] * a + _t2[e] * b + (Math.random() - 0.5) * 0.002;
        flV[k + c] = d[e] * sp + (Math.random() - 0.5) * 0.3;
      }
      flSerial[i] = flSerialNext++;
      flSheet[i] = -1;
      if (front < 0) front = i;
      back = i;
      flLife[i] = FL_LIFE;
      flAlive[i] = 1;
    }
    if (front >= 0) addSheet(front, back, scale);
  }
}
// Bleeding: a hit demon goes on spurting from the wound after the burst, smaller and weaker spurts every BLEED_EVERY
// s, for BLEED_TIME × the shot's POWER (the shotgun's: about half a second; the M4's: none, its hits come too fast
// to need it). The wound moves with the demon.
const BLEED_TIME = 0.5, BLEED_EVERY = 0.08, BLEED_GOBS = 2, BLEED_MAX = 12; // s at POWER 1, s, gobs a spurt, wounds at once
export const bleedSpurts = (power) => Math.floor(BLEED_TIME * power / BLEED_EVERY + 1e-6); // a wound's, from a weapon of this POWER
export const bleeds = []; // { npc, at (from the demon's origin, m), dir, next (s), left, spurts } and a stump's bone, root (see cutBody)
export function startBleed(hit, now, spurts) { // (spurts: bleedSpurts of the weapon that fired: it may be put away since)
  if (!spurts) return;
  if (bleeds.length >= BLEED_MAX) bleeds.shift();
  bleeds.push({ npc: hit.npc, at: hit.entry.clone().sub(hit.npc.imp.model.position), dir: hit.dir.clone(), next: now + BLEED_EVERY, left: spurts, spurts });
}
const _bleedAt = new THREE.Vector3(), _bleedDir = new THREE.Vector3();
export function updateBleeds(now) {
  for (let k = bleeds.length - 1; k >= 0; k--) {
    const b = bleeds[k];
    if (now < b.next) continue;
    b.next += BLEED_EVERY;
    // (a stump's: from its bone, out along the spine where the top half was, as its legs fall; it hung in the air)
    const at = b.bone ? b.bone.getWorldPosition(_bleedAt) : _bleedAt.copy(b.npc.imp.model.position).add(b.at);
    const dir = b.bone ? b.root.getWorldPosition(_bleedDir).sub(at).normalize() : b.dir;
    burstBlood({ entry: at, dir }, BLEED_GOBS, 0.4 + 0.5 * b.left / b.spurts);
    if (--b.left <= 0) bleeds.splice(k, 1);
  }
  for (let k = unflown.length - 1; k >= 0; k--) { // (see throwUnflown) the stains of gobs that weren't flown, as they land
    const u = unflown[k];
    if (now < u.when) continue;
    spawnDecal(u.at, null, u.v, 0, u.size);
    unflown.splice(k, 1);
  }
}
// The floor's share of a hit isn't capped (the airborne splash is: see BURST_GOBS_MAX). The gobs a hit would have
// thrown beyond its splash's aren't flown, but still land: each thrown as burstBlood throws one, its arc stepped
// through to where it meets the floor (or the platform or a stair; one that reaches a wall is let go; ponytail: columns
// aren't checked, so one can land behind one), and its stain laid there as it would land, about as big as a flown gob's
// (see landSheet: most reach STAIN_MAX). Only the shotgun has any: one bullet never goes over the splash's cap.
const unflown = []; // { at, v (at landing), when, size }
export function throwUnflown(hit, gobs, now) {
  const from = hit.entry.clone().addScaledVector(hit.dir, -FL_WOUND_OUT);
  for (let g = 0; g < gobs; g++) {
    const az = Math.random() * 2 * Math.PI, el = THREE.MathUtils.lerp(FL_ELEVATION[0], FL_ELEVATION[1], Math.random());
    const d = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).addScaledVector(hit.dir, -FL_TOWARDS_YOU).normalize();
    const p = from.clone().addScaledVector(d, FL_GOB_START), v = d.multiplyScalar(3.5 + Math.random() * 2.5);
    for (let t = 0; t < FL_LIFE; t += FL_STEP) {
      v.y -= FL_GRAVITY * FL_STEP;
      const was = p.y;
      p.addScaledVector(v, FL_STEP);
      if (Math.abs(p.x) > ARENA - 0.05 || Math.abs(p.z) > ARENA - 0.05) break; // a wall
      const ground = floorAt(p.x, p.z, was);
      if (p.y > ground || v.y > 0) continue; // (not going up: up into a high step from under it, it isn't on it)
      unflown.push({ at: p.setY(ground), v, when: now + t, size: STAIN_MAX * (0.6 + 0.4 * Math.random()) });
      break;
    }
  }
}
export const _bv = new THREE.Vector3(), _bp = new THREE.Vector3(), _bn = new THREE.Vector3();
// What a blob at _bp hit (rising: going up), the floor, a wall (the arena's square) or a column (inside its face distance:
// snapped onto that face, its normal in _bn); null if nothing
function gooSurface(rising) {
  if (_bp.y <= 0.01) { _bp.y = 0; return 'floor'; }
  const sh = stairHeight(_bp.x, _bp.z, _bp.y);
  if (_bp.y <= sh && !rising) { _bp.y = sh; return 'floor'; } // a stair: onto its tread, from over it (not the balcony: it
  // goes through its mesh)
  const pd = platformDist(_bp.x, _bp.z);
  if (pd < PLATFORM_APOTHEM && _bp.y <= PLATFORM_H) { // the platform: its top or a side, whichever it's nearer
    if (PLATFORM_H - _bp.y < PLATFORM_APOTHEM - pd) { _bp.y = PLATFORM_H; return 'floor'; }
    _bn.set(_pf.x, 0, _pf.y);
    _bp.addScaledVector(_bn, PLATFORM_APOTHEM - pd);
    return 'wall';
  }
  if (Math.abs(_bp.x) >= ARENA - 0.01 || Math.abs(_bp.z) >= ARENA - 0.01) {
    const xWall = Math.abs(_bp.x) > Math.abs(_bp.z);
    if (xWall) _bn.set(-Math.sign(_bp.x), 0, 0); else _bn.set(0, 0, -Math.sign(_bp.z));
    _bp.addScaledVector(_bn, (xWall ? Math.abs(_bp.x) : Math.abs(_bp.z)) - ARENA);
    return 'wall';
  }
  for (const c of COLUMNS) {
    const dx = _bp.x - c.x, dz = _bp.z - c.y;
    if (dx * dx + dz * dz < COLUMN_APOTHEM * COLUMN_APOTHEM) {
      const a = Math.round(Math.atan2(dx, dz) / (Math.PI / 4)) * (Math.PI / 4);
      _bn.set(Math.sin(a), 0, Math.cos(a));
      _bp.addScaledVector(_bn, COLUMN_APOTHEM - (dx * _bn.x + dz * _bn.z));
      return 'column';
    }
  }
  return null;
}

