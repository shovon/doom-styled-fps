// Firing (tryFire), reloading, and each frame's gun (updateGun)
import { playSound, playShot } from './audio.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { renderer, sunOffset, FLASH_RANGE, flashes, portalLights, muzzleFlash } from './setup.js';
import { stripLights, ceilLights, spotLights } from './lights.js';
import { camera, opts } from './camera.js';
import { GUN_FOV, SHOTGUN, PISTOL, FISTS, MAG, FIRE_INTERVAL, gunScene, gunSun, gunFlashes, gunStrips, gunCeil,
  gunSpots, gunPortals, gunCam, gunRT, gunMirrorRT, GUN_FLASH_TIME, GUN_BANG_TIME, FLASH_VARIANTS, flashSheet,
  muzzleSprite, gun, mouse, _toGun, _gs, _mw, _noAim, _tgp, _tgq, _flickAt, _flickAxis, _flickQ, SLIDE_BACK,
  SLIDE_TIME, PISTOL_VIEW, ADS_GUN_FOV, aim, PUNCH_TIME, PUNCH_HIT, poseFist, punch, landPunch, RECOIL_BACK,
  RECOIL_PITCH, RECOIL_TIME, shotgunReload, clipPose, keepPose, playGun, KICK_PER_SHOT, TRAUMA_PER_SHOT, shake } from './weapons.js';
import { ejectCasing, halo, puffSmoke } from './casings.js';
import { firePellets } from './shots.js';
import { paintGunBlood, dryGunBlood, updateAmmo } from './gun-blood.js';
import { policeHear } from './police.js';

export function tryFire(now) {
  if (!gun || gun.busy || gun.cooldown > 0) return;
  if (FISTS) { gun.cooldown = Math.max(gun.cooldown, -0.05) + FIRE_INTERVAL; return punch(now); }
  if (gun.ammo === 0) return reload();
  gun.ammo--;
  if (SHOTGUN) { mouse.trigger = false; gun.ammo = 0; gun.modes.shotgun.spent = true; } // one shot a click: both barrels
  if (PISTOL) mouse.trigger = false; // one shot a click
  // Carry leftover time into the next shot so the rate isn't rounded up to whole frames (capped, so a
  // long pause doesn't bank a burst)
  gun.cooldown = Math.max(gun.cooldown, -0.05) + FIRE_INTERVAL;
  playGun('Fire');
  playShot();
  // Muzzle in gun space → view space → world: lights the floor, the demons' sprites, and (mapped back) the gun
  gun.root.updateMatrixWorld(true);
  gun.muzzle.getWorldPosition(_mw).applyMatrix4(gunCam.matrixWorldInverse).applyMatrix4(camera.matrixWorld);
  muzzleFlash(_mw);
  halo.position.copy(_mw);
  puffSmoke(_mw);
  gun.flashUntil = now + GUN_FLASH_TIME;
  gun.firedAt = now; // (the kick: see RECOIL_BACK)
  if (!SHOTGUN) ejectCasing(); // (the shells stay in the barrels)
  gun.flashVariant = (Math.random() * FLASH_VARIANTS) | 0;
  gun.flashMirror = Math.random() < 0.5;
  gun.flashFrame = -1; // a new shot: re-render now
  shake.kick += KICK_PER_SHOT;
  shake.trauma = Math.max(shake.trauma, Math.min(shake.trauma + TRAUMA_PER_SHOT, 1)); // (never lowering a punch's, above 1)
  firePellets();
  policeHear(camera.position, camera.position.x, camera.position.z, now); // (see POLICE_HEAR)
  updateAmmo();
}

export function reload() {
  if (!gun || gun.busy || gun.ammo === MAG) return;
  gun.busy = true;
  gun.shellsOut = false;
  playGun(gun.ammo === 0 && !SHOTGUN ? 'Reload_Empty' : 'Reload'); // (Reload_Empty works the M4's bolt)
  // sounds/reload.wav (dragon-studio "gun reload"): 1.5 s, magazine out at 0.56 s and in at 0.81 s, about the length
  // of the sped-up reload clip, so it plays from the start, unvaried
  gun.reloadSound = playSound('reload', 0.6, 0);
  updateAmmo();
}

// Returns 1 if it re-rendered the weapon texture this frame (for stats)
export function updateGun(dt, now) {
  if (!gun) return 0;
  gun.cooldown -= dt;
  if (SHOTGUN && gun.ammo === 0 && gun.cooldown <= 0) reload(); // a reload every shot
  if (now >= gun.punchLands) landPunch();
  gun.animAcc += dt;
  // same stepped animation as the demons; a punch at twice that (three poses was too few), and every frame on its way
  // out, till a pose shows it all the way out
  const punching = gun.fists?.some((a) => now - a.punchAt < PUNCH_TIME + 0.1);
  const striking = gun.fists?.some((a) => gun.posedAt - a.punchAt < PUNCH_TIME * PUNCH_HIT);
  const posed = striking || !opts.stepped || gun.animAcc >= 1 / (punching ? 2 * opts.animFps : opts.animFps);
  if (posed) {
    gun.mixer.update(gun.animAcc); gun.animAcc = 0;
    gun.offArm?.scale.setScalar(1e-4); // one-handed (see PISTOL_VIEW), or the left fist mirrored (see holdFists)
    if (gun.fists) gun.posedAt = now; // (the fists are posed as they're drawn: see below)
    const r = gun.actions.Reload;
    if (gun.hinge) {
      clipPose(gun.arm.kept);
      shotgunReload(r.isRunning() ? r.time / r.getClip().duration : 0);
      keepPose(gun.arm.kept);
    }
  }

  let lights = 0; // which flash lights reach your eye; a change means a re-render
  flashes.forEach((f, i) => { if (f.world.intensity > 0 && f.world.position.distanceTo(camera.position) < FLASH_RANGE + 1) lights |= 1 << i; });
  // the flash's frame: 0 the bang, 1 the next instant, -1 none; a change means a re-render
  const flashFrame = now < gun.flashUntil ? (now < gun.flashUntil - (GUN_FLASH_TIME - GUN_BANG_TIME) ? 0 : 1) : -1;
  if (flashFrame !== gun.flashFrame) { gun.flashFrame = flashFrame; gun.dirty = true; }
  if (gun.slide) { // back and home after a shot (a quick out, a slower return), held back once it's empty
    const t = (now - gun.firedAt) / SLIDE_TIME, z = gun.ammo === 0 && !gun.busy ? SLIDE_BACK
      : t < 1 ? SLIDE_BACK * (t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7) : 0;
    if (z !== gun.slide.position.z) { gun.slide.position.z = z; gun.dirty = true; }
  }
  dryGunBlood(dt);
  if (!posed && lights === gun.lastLights && !gun.dirty) return 0;
  gun.lastLights = lights;
  gun.dirty = false;

  gun.root.updateMatrixWorld(true);
  gun.joint.matrixWorld.decompose(gunCam.position, gunCam.quaternion, _gs); // the animated camera joint is the eye
  // the pistol higher (see PISTOL_VIEW); aiming, the eye down the sights (see OPTIC)
  const hip = PISTOL ? PISTOL_VIEW : [0, 0], at = gun.adsAt ?? _noAim, lerp = THREE.MathUtils.lerp;
  gunCam.translateX(lerp(hip[0], at.x, aim)).translateY(lerp(hip[1], at.y, aim)).translateZ(at.z * aim);
  const gunFov = THREE.MathUtils.lerp(GUN_FOV, ADS_GUN_FOV, aim);
  if (gunCam.fov !== gunFov) { gunCam.fov = gunFov; gunCam.updateProjectionMatrix(); }
  if (gun.eyeBack) gunCam.translateZ(gun.eyeBack); // (see RELOAD_EYE_BACK)
  if (gun.lower) gunCam.translateY(gun.lower); // (see RELOAD_LOWER: the eye up, so everything it sees is lower)
  // the kick (see RECOIL_BACK): back at you, at once, easing off
  const kick = Math.exp(-(now - gun.firedAt) / RECOIL_TIME);
  if (kick > 0.01) gunCam.translateZ(-RECOIL_BACK * kick); // (the eye forward: the gun comes back at it)
  const pitch = (gun.flick || 0) + RECOIL_PITCH * (kick > 0.01 ? kick : 0);
  if (pitch) { // (see SWING_UP) the gun swung up round its grip: the eye turned the other way round it
    gun.muzzle.parent.getWorldPosition(_flickAt); // (the gun: the shotgun's origin is its grip)
    _flickQ.setFromAxisAngle(_flickAxis.set(1, 0, 0).applyQuaternion(gunCam.quaternion), -pitch);
    gunCam.position.sub(_flickAt).applyQuaternion(_flickQ).add(_flickAt);
    gunCam.quaternion.premultiply(_flickQ);
  }
  gunCam.updateMatrixWorld();

  // World → gun space via the shared view space: sun direction and flash lights follow you into the gun's world
  _toGun.multiplyMatrices(gunCam.matrixWorld, camera.matrixWorldInverse);
  gunSun.target.position.copy(gunCam.position);
  gunSun.position.copy(sunOffset).transformDirection(_toGun).multiplyScalar(10).add(gunCam.position);
  flashes.forEach((f, i) => {
    gunFlashes[i].position.copy(f.world.position).applyMatrix4(_toGun);
    gunFlashes[i].intensity = f.world.intensity;
  });
  stripLights.forEach((s, i) => {
    gunStrips[i].position.copy(s.world.position).applyMatrix4(_toGun);
    gunStrips[i].intensity = s.world.intensity;
  });
  portalLights.forEach((p, i) => {
    gunPortals[i].position.copy(p.world.position).applyMatrix4(_toGun);
    gunPortals[i].intensity = p.world.intensity;
  });
  _toGun.decompose(_tgp, _tgq, _gs);
  ceilLights.forEach((c, i) => { // area lights have a facing too
    gunCeil[i].position.copy(c.world.position).applyMatrix4(_toGun);
    gunCeil[i].quaternion.multiplyQuaternions(_tgq, c.world.quaternion);
    gunCeil[i].intensity = c.world.intensity;
    gunCeil[i].color.copy(c.world.color);
  });
  spotLights.forEach((s, i) => { // spots have an aim: carry the target over too
    gunSpots[i].position.copy(s.world.position).applyMatrix4(_toGun);
    if (gunSpots[i].target) gunSpots[i].target.position.copy(s.world.target.position).applyMatrix4(_toGun);
    gunSpots[i].intensity = s.world.intensity;
  });

  muzzleSprite.visible = gun.flashFrame >= 0;
  if (muzzleSprite.visible) {
    gun.muzzle.getWorldPosition(muzzleSprite.position);
    muzzleSprite.quaternion.copy(gunCam.quaternion); // facing the eye, upright on screen
    const v = gun.flashVariant, m = gun.flashMirror; // its cell in the sheet (rows: the bang on top; flipY)
    flashSheet.repeat.x = (m ? -1 : 1) / FLASH_VARIANTS;
    flashSheet.offset.set((v + (m ? 1 : 0)) / FLASH_VARIANTS, gun.flashFrame === 0 ? 0.5 : 0);
  }

  if (gun.fists) poseFist(gun.fists[1], gun.fists[1].punchAt, gun.fists[0].punchAt, gun.posedAt); // (posed before the blood's painted on it)
  if (gun.splashes.length) paintGunBlood();
  renderer.setRenderTarget(gunRT);
  renderer.render(gunScene, gunCam);
  if (gun.fists) { // then as the left fist would be, into the mirror's image (see holdFists)
    poseFist(gun.fists[1], gun.fists[0].punchAt, gun.fists[1].punchAt, gun.posedAt);
    renderer.setRenderTarget(gunMirrorRT);
    renderer.render(gunScene, gunCam);
  }
  renderer.setRenderTarget(null);
  return 1;
}

