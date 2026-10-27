// The frame loop. This is the file the page loads: its first import is the file before it, whose first is the one
// before that, and so on down to sprites.js, so they all run in this order, each after the ones before it (the order
// they had as one script, which much of it needs: the renderer before the scene, every light added before the sprites
// take their list of them, the random floor drawn before its welds...). They call ahead too (the gun hurts the
// demons, further on): fine once the game is running, as by then every file has run. While they load, only into a
// function declaration (hoisted: there before its file runs) that reads nothing of its file yet (as the arena calls
// addWallBlood, which only hooks the material's shader for later)
//   sprites, setup, tiles, arena, platform, lights, camera, weapons, decals, blood-maps, blood-surfaces, blood-fluid,
//   blood-sheets, holes, casings, shots, audio, firing, player, hud, gun-blood, enemies, start, input, debug, enemy-ai,
//   police, skulls, portals, gibs, main
import { updateGibs } from './gibs.js'; // (first: see above)
import * as THREE from 'three';
import { MOVE, SPRINT, STEP_LENGTH, EYE_HEIGHT, GRAVITY, JUMP_HEIGHT, POLICE_AIM_WALK, POLICE_RUN, renderer, FRAME_MS,
  sunOffset, sun, flashes } from './setup.js';
import { ARENA, ceilLightTiles, COLUMNS, COLUMN_REACH, NPC_REACH, NPC_FEET, TOWERS, TOWER_REACH, PLATFORM_H,
  STAIR_RISE, ceilingAt, BODY_H, standOn } from './arena.js';
import { STRIP_REACH, STRIP_FADE, STRIP_INTENSITY, stripTiles, stripLights, updatePool, CEIL_REACH, CEIL_FADE,
  CEIL_INTENSITY, ceilLights, SPOT_REACH, SPOT_FADE, SPOT_INTENSITY, spotPoolTiles, spotLights } from './lights.js';
import { camera, composer, scaleWorld, updateDof, sceneTex } from './camera.js';
import { BOB, gunRT, hudScene, hudCam, gunQuad, gunMirrorQuad, gun, mouse, aim, updateAim, _camQ, shakeCamera } from './weapons.js';
import { flushBlood } from './blood-maps.js';
import { updateBleeds } from './blood-fluid.js';
import { bakeSheets, updateBlood, drawBloodField } from './blood-sheets.js';
import { updateCasings, updateMuzzleFx } from './casings.js';
import { DEMON_GRUNTS, ZOMBIE_SOUNDS, zombieSound, playerStep, playerFeet } from './audio.js';
import { tryFire, updateGun } from './firing.js';
import { PLAYER_HEALTH, POLICE_AIM, POLICE_BURSTS, POLICE_BURST, POLICE_SHOT_GAP, POLICE_PAUSE, POLICE_DAMAGE,
  randRange, playerHealth, _shotFrom, hurtPlayer, ZOMBIE_REACH, ZOMBIE_LET_GO, ZOMBIE_HITS, ZOMBIE_DAMAGE,
  ZOMBIE_CLEAR, demonShot } from './player.js';
import { HURT_VIGNETTE, poly, hudFx, drawLens } from './hud.js';
import { crossed, demonSteps, npcs, corpses, updateCorpses, nextVolley } from './enemies.js';
import { keys } from './input.js';
import { reportStats, updateSpriteDebug } from './debug.js';
import { DEMON_GRUNT_EVERY, demonVoice, updateStagger, platformGap, balconyGap, PLATFORM, BALCONY, aimedAt,
  thinkDemon, pushApart, pushOutOfColumns, steer } from './enemy-ai.js';
import { policeLook, policeStroll, policeSearch } from './police.js';
import { skulls, skullTime, updateSkull } from './skulls.js';
import { updatePortals, portalLenses } from './portals.js';

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
export const UP = new THREE.Vector3(0, 1, 0), fwd = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3(), q = new THREE.Quaternion();
export const clock = new THREE.Clock();
// You, as the loop moves you (read elsewhere too: the police keep to your level, a demon's shot misses you moving more)
export let jumpY = PLATFORM_H, jumpV = 0; // height above standing (from the start up on the centre platform: else, below its top, you
// were pushed out off its side), vertical speed
export let playerMoving = false, stepDist = 0, youOn = null; // stepDist: walked since the last footstep; youOn: the raised place
// you're up on (PLATFORM or BALCONY: above its stairs' bottom step), or null
let bobPhase = 0, bobAmp = 0, hudFlash = 0; // the weapon's bob; your muzzle flash, for the blood on the lens
let nextFrameAt = 0, lastFrameAt = 0;
renderer.setAnimationLoop((time) => {
  if (time < nextFrameAt - 1) return; // capped at FPS_CAP: too soon, skip this one of the display's frames
  nextFrameAt = Math.max(nextFrameAt, time - FRAME_MS) + FRAME_MS; // (fallen behind: from now)
  scaleWorld(time, time - lastFrameAt);
  lastFrameAt = time;
  const t0 = performance.now();
  const dt = Math.min(clock.getDelta(), 0.1), now = clock.elapsedTime;
  renderer.info.reset();
  let sprites = 0;

  // You: WASD relative to where you look, eye at a fixed height
  camera.getWorldDirection(fwd).setY(0).normalize();
  right.crossVectors(fwd, UP);
  move.set(0, 0, 0)
    .addScaledVector(fwd, (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0))
    .addScaledVector(right, (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0));
  const moving = move.lengthSq() > 0, sprinting = keys.ShiftLeft || keys.ShiftRight;
  playerMoving = moving;
  if (moving) camera.position.addScaledVector(move.normalize(), (sprinting ? SPRINT : MOVE) * dt);
  // Jump: Space launches you at the speed that peaks at JUMP_HEIGHT; held, you hop again on landing
  // the platform, the balcony, their stairs: once your feet are (nearly) up to a top you stand on it, else it's a wall
  // (or, all over your head, a roof)
  const floorY = standOn(camera.position, jumpY, 0.4);
  youOn = floorY <= STAIR_RISE ? null // (from the middle step: the zombies come up the stairs after you; the others hold off)
    : floorY > PLATFORM_H || balconyGap(camera.position.x, camera.position.z) < platformGap(camera.position.x, camera.position.z) ? BALCONY : PLATFORM;
  const grounded = jumpY <= floorY;
  if (grounded && keys.Space) jumpV = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
  jumpV -= GRAVITY * dt;
  // (under the high steps, or a bridge over the platform: a jump stops at what you were wholly under, your body's width
  // round you, not shoved out from under it)
  const roof = ceilingAt(camera.position.x, camera.position.z, jumpY + BODY_H - 0.01, 0.4) - BODY_H;
  jumpY = Math.max(jumpY + jumpV * dt, floorY);
  if (jumpY > roof) { jumpY = Math.max(roof, floorY); jumpV = Math.min(jumpV, 0); }
  const landing = jumpY === floorY && jumpV < -4; // came down from more than ~0.4 m
  if (jumpY === floorY && jumpV < 0) jumpV = 0;
  // Footsteps: one every STEP_LENGTH m walked on the ground (so quicker when sprinting), a heavier one on landing
  if (landing) { playerStep(0.55); stepDist = 0; }
  else if (moving && grounded) {
    if ((stepDist += (sprinting ? SPRINT : MOVE) * dt) >= STEP_LENGTH) { stepDist -= STEP_LENGTH; playerStep(sprinting ? 0.42 : 0.32); }
    if (jumpY <= 0) playerFeet((sprinting ? SPRINT : MOVE) * dt);
  } else stepDist = STEP_LENGTH * 0.7; // standing (or in the air): setting off, the first step comes soon
  camera.position.y = EYE_HEIGHT + jumpY;
  const reach = ARENA - 0.5; // the wall is solid: stop half a metre short of it
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -reach, reach);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -reach, reach);
  for (const [c, reach] of [...COLUMNS.map((c) => [c, COLUMN_REACH]), ...TOWERS.map((c) => [c, TOWER_REACH])]) {
    // columns and towers are solid too: push out to their reach (a circle round each)
    const dx = camera.position.x - c.x, dz = camera.position.z - c.y, d = Math.hypot(dx, dz);
    if (d < reach) {
      const k = d > 1e-6 ? reach / d : 0;
      camera.position.x = c.x + (d > 1e-6 ? dx * k : reach);
      camera.position.z = c.y + dz * k;
    }
  }
  for (const n of npcs) { // and the living: you can't walk into one (or be shoved into one) on your level
    const q = n.imp.model.position, dx = camera.position.x - q.x, dz = camera.position.z - q.z, d = Math.hypot(dx, dz);
    if (d < NPC_REACH && d > 1e-6 && Math.abs(q.y - floorY) < 0.5) { camera.position.x = q.x + dx / d * NPC_REACH; camera.position.z = q.z + dz / d * NPC_REACH; }
  }

  updateAim(dt); // aiming down the sights

  // Weapon bob: Doom's sideways sway + downward dip, snapped to whole weapon-sprite pixels; stilled while aiming
  bobAmp += ((moving && grounded && !aim ? 1 : 0) - bobAmp) * (1 - Math.exp(-8 * dt)); // no footsteps in the air
  bobPhase += dt * (sprinting ? 11 : 8);
  const tx = 2 / gunRT.width, ty = 2 / gunRT.height;
  gunQuad.position.x = Math.round((Math.cos(bobPhase) * BOB * bobAmp) / tx) * tx;
  gunQuad.position.y = -Math.round((Math.abs(Math.sin(bobPhase)) * BOB * bobAmp) / ty) * ty;
  gunMirrorQuad.position.copy(gunQuad.position);

  if (mouse.trigger) tryFire(now);
  updateBleeds(now);

  for (const npc of npcs) {
    if (npc.stagger > 0) updateStagger(npc, dt); // knocked back, but still free to turn (and a demon to shoot)
    if (npc.zombie) { // swinging at you, or coming at you (up the stairs, if you're up there)
      const m = npc.imp.model, p = m.position, dist = Math.hypot(camera.position.x - p.x, camera.position.z - p.z);
      // (only on about your level: below you, up on the platform's edge, it swung at the air)
      const act = dist < (npc.act === npc.fire ? ZOMBIE_LET_GO : ZOMBIE_REACH) && Math.abs(floorY - p.y) < ZOMBIE_CLEAR ? npc.fire : npc.walk;
      if (act !== (npc.act ??= npc.walk)) { npc.act.fadeOut(0.2); act.reset().fadeIn(0.2).play(); npc.act = act; npc.fireWas = undefined; }
      npc.fire.timeScale = npc.stagger > 0 ? 0 : 1; // a hit holds its swing too: shooting one buys you time
      if (act !== npc.walk) {
        steer(m, move.subVectors(camera.position, p).setY(0).normalize(), 0, dt, npc.kind.facing); // stands, turned to you
        if (act === npc.fire) {
          const t = npc.fire.time, was = npc.fireWas ?? t;
          npc.fireWas = t;
          if (dist < ZOMBIE_LET_GO && Math.abs(jumpY - p.y) < ZOMBIE_CLEAR && ZOMBIE_HITS.some((f) => crossed(was, t, f))) {
            hurtPlayer(_shotFrom.copy(p).add(npc.imp.fit), ZOMBIE_DAMAGE); // from its chest: the HUD's arc points at it
            demonVoice(npc, 'punch', 1, 0.75); // (your fists' thud, lower)
          }
        }
        continue;
      }
    } else {
      // Shooters: walk a while, stop, fire 2–4 shots where they're facing, walk on (the police: only on to you, seeing
      // you, in among their circling range and not dodging; and losing sight of you, they stop: see POLICE_SIGHT)
      if (npc.police) policeLook(npc, now);
      if (!npc.police || npc.alert) npc.timer -= dt;
      if (npc.police && npc.firing && !npc.sees) npc.timer = 0;
      if (npc.firing) {
        if (npc.timer > 0) { // stand still while firing, turned to you (unless you aim at it: thinkDemon breaks it off)
          steer(npc.imp.model, move.subVectors(camera.position, npc.imp.model.position).setY(0).normalize(), 0, dt, npc.kind.facing);
          if (npc.police && now >= npc.nextShot && npc.stagger <= 0) { // a shot of the burst; then the next, or a pause, or done
            demonShot(npc, POLICE_DAMAGE);
            if (--npc.burstLeft > 0) npc.nextShot = now + POLICE_SHOT_GAP;
            else if (--npc.bursts > 0) {
              npc.burstLeft = randRange(POLICE_BURST); npc.nextShot = now + POLICE_PAUSE[0] + Math.random() * (POLICE_PAUSE[1] - POLICE_PAUSE[0]);
            } else npc.timer = 0;
          }
          if (!aimedAt(npc.imp.model.position, npc.imp.model.position.y + npc.imp.fit.y)) continue;
          thinkDemon(npc, 0, move); // aimed at: it drops the volley and dodges (from next frame on)
          continue;
        }
        npc.firing = false;
        npc.timer = nextVolley();
        npc.fire.fadeOut(0.2);
        npc.walk.reset().fadeIn(0.2).play();
      } else if (npc.shooter && npc.timer <= 0 && (!npc.police || (npc.sees && !npc.closing && npc.dodge <= 0))) {
        npc.firing = true;
        npc.walk.fadeOut(0.2);
        npc.fire.reset().fadeIn(0.2).play();
        if (npc.police) { // bursts, rifle up first (they end the volley: see above)
          npc.timer = Infinity;
          npc.bursts = randRange(POLICE_BURSTS); npc.burstLeft = randRange(POLICE_BURST); npc.nextShot = now + POLICE_AIM;
        } else {
          npc.timer = (2 + Math.floor(Math.random() * 3)) * npc.fire.getClip().duration; // Fire loops, so N shots
          demonShot(npc); // first shot; later ones come from the loop event
        }
        continue;
      }
    }
    if (npc.stagger > 0) continue; // no walking while staggered
    if ((npc.paceTimer -= dt) <= 0) {
      npc.paceTarget = Math.random() < 0.5 ? npc.kind.pace : npc.kind.fast;
      npc.paceTimer = 2 + Math.random() * 4;
    }
    npc.pace += (npc.paceTarget - npc.pace) * (1 - Math.exp(-3 * dt)); // ease between paces
    // which way, and how fast (the police: standing about or strolling, on to you, or looking for you: see POLICE_SIGHT)
    const how = !npc.police || npc.sees ? thinkDemon(npc, dt, move) : npc.alert ? policeSearch(npc, now, move) : policeStroll(npc, now, move);
    const pace = npc.pace * how;
    if (npc.police) { // standing; strolling (Walk); on to you: round you, the rifle up (WalkAim: at the other, between its
      // bursts, it looked as if it couldn't care less), else running (at you, off your aim, or to where it saw you)
      const gait = how === 0 ? npc.idle : !npc.alert ? npc.walkGait : !npc.sees || npc.closing || npc.dodge > 0 ? npc.run : npc.aimWalk;
      if (gait !== npc.walk) { npc.walk.fadeOut(0.25); gait.reset().fadeIn(0.25).play(); npc.walk = gait; npc.walkWas = undefined; }
    }
    npc.walk.timeScale = npc.walk === npc.idle ? 1 : pace;
    demonSteps(npc, pace);
    npc.nextGrunt ??= now + Math.random() * DEMON_GRUNT_EVERY[1]; // (spread out from the start)
    if (now >= npc.nextGrunt) { // walking: now and then, a grunt (a zombie, chasing you: one of its sounds, never the last one again)
      if (npc.zombie) {
        npc.lastSound = ((npc.lastSound ?? -1) + 1 + Math.floor(Math.random() * (ZOMBIE_SOUNDS - 1))) % ZOMBIE_SOUNDS;
        demonVoice(npc, zombieSound(npc.lastSound), 1);
      } else demonVoice(npc, `demon_grunt_${(Math.random() * DEMON_GRUNTS) | 0}`, 0.8);
      npc.nextGrunt = now + DEMON_GRUNT_EVERY[0] + Math.random() * (DEMON_GRUNT_EVERY[1] - DEMON_GRUNT_EVERY[0]);
    }
    const stride = npc.walk === npc.run ? POLICE_RUN : npc.walk === npc.aimWalk ? POLICE_AIM_WALK : npc.kind.stride;
    if (how > 0) steer(npc.imp.model, move, stride * pace, dt, npc.kind.facing); // (standing: as it was)
    pushApart(npc);
  }
  for (const npc of npcs) { // hard collision, for every living one once they've all moved (a crowd shoves the ones standing,
    // swinging or waiting too: into a column or the platform, where they stayed)
    const p = npc.imp.model.position;
    const floor = standOn(p, p.y, 0.5, NPC_FEET); // round the platform or up it by its stairs, round the columns, inside the walls
    pushOutOfColumns(p);
    p.x = THREE.MathUtils.clamp(p.x, -ARENA + 0.5, ARENA - 0.5); p.z = THREE.MathUtils.clamp(p.z, -ARENA + 0.5, ARENA - 0.5);
    npc.fall = p.y > floor ? (npc.fall ?? 0) + GRAVITY * dt : 0; // off an edge, or down a step: it drops, as you do
    p.y = Math.max(p.y - npc.fall * dt, floor);
  }

  skullTime.value = now; // (their fire)
  for (const s of skulls) updateSkull(s, dt, now);
  updateCorpses(dt);

  sun.position.copy(camera.position).add(sunOffset); // shadows follow you
  sun.target.position.copy(camera.position);
  for (const f of flashes) if (f.ttl > 0 && (f.ttl -= dt) <= 0) f.world.intensity = f.sprite.intensity = 0;
  updatePool(stripTiles, stripLights, STRIP_REACH, STRIP_FADE, STRIP_INTENSITY);
  updatePool(ceilLightTiles, ceilLights, CEIL_REACH, CEIL_FADE, CEIL_INTENSITY);
  updatePool(spotPoolTiles, spotLights, SPOT_REACH, SPOT_FADE, SPOT_INTENSITY);
  camera.updateMatrixWorld();
  sprites += updatePortals(dt, now); // (their lights set before the sprites see them)

  for (const npc of npcs) sprites += npc.imp.update(renderer, camera, dt);
  for (const s of skulls) sprites += s.imp.update(renderer, camera, dt);
  for (const c of corpses) sprites += c.imp.update(renderer, camera, dt);
  sprites += updateGun(dt, now);
  updateBlood(dt);
  updateCasings(dt);
  updateGibs(dt);
  updateMuzzleFx(dt, now);

  const shaken = shakeCamera(dt, now);
  portalLenses();
  drawBloodField();
  updateDof(dt);
  bakeSheets();
  flushBlood(dt);
  composer.render(dt);
  hudFx.material.uniforms.uTime.value = now;
  hudFx.material.uniforms.uLow.value = THREE.MathUtils.clamp(poly(HURT_VIGNETTE, 1 - THREE.MathUtils.clamp(playerHealth / PLAYER_HEALTH, 0, 1)), 0, 1);
  // your muzzle flash, for the blood on the lens: full while it's lit, dying off fast after
  hudFlash = gun && now < gun.flashUntil ? 1 : Math.max(hudFlash - dt * 14, 0);
  hudFx.material.uniforms.uFlash.value = hudFlash;
  hudFx.material.uniforms.uScene.value = sceneTex;
  renderer.getDrawingBufferSize(hudFx.material.uniforms.uRes.value);
  drawLens(now);
  renderer.autoClear = false; // weapon goes flat on top of the world (no bloom on it)
  updateSpriteDebug();
  renderer.render(hudScene, hudCam);
  renderer.autoClear = true;
  if (shaken) camera.quaternion.copy(_camQ); // undo: the look controls own the real orientation
  reportStats(performance.now() - t0, sprites);
});
