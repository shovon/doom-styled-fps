// Input: the mouse and the keys (the debug toggles too), resizing
import './start.js'; // (first: this file runs after that one; see main.js)
import { RT_SIZES, renderer } from './setup.js';
import { camera, sizeWorld, look, opts } from './camera.js';
import { WEAPONS, WEAPON, sizeGun, gun, mouse, ADS_TOGGLE, useWeapon } from './weapons.js';
import { sheetMode, SHEET_MODES, nextSheetMode } from './blood-sheets.js';
import { reload } from './firing.js';
import { npcs, corpses, addNpcs, removeNpcs } from './enemies.js';
import { skulls } from './skulls.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
export const keys = {};
// the debug keys' (see the HUD line): the P key's (which of RT_SIZES), the F key's (the distance blur, and aiming's:
// see updateDof), the I key's (see updateSpriteDebug)
export let rtSizeIdx = 0, dofOn = true, spriteDebug = false;
const hud = document.getElementById('hud'), HUD = hud.textContent;
addEventListener('mousedown', (e) => {
  if (e.button === 0 && look.isLocked) mouse.trigger = true;
  if (e.button === 2 && look.isLocked) mouse.aimHeld = ADS_TOGGLE ? !mouse.aimHeld : true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) mouse.trigger = false; if (e.button === 2 && !ADS_TOGGLE) mouse.aimHeld = false; });
addEventListener('contextmenu', (e) => e.preventDefault()); // (the right button aims: no menu)
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (!gun) return;
  if (e.code === 'KeyR') reload();
  const pick = Object.keys(WEAPONS).find((w) => WEAPONS[w].key === e.code); // 1-4: a weapon
  if (pick && pick !== WEAPON) useWeapon(pick);
  if (e.code === 'Backquote') document.body.classList.toggle('debug');
  if (!document.body.classList.contains('debug')) return; // the rest are debug toggles
  if (e.code === 'KeyB') opts.bounds = !opts.bounds;
  if (e.code === 'KeyH') opts.spriteShadows = !opts.spriteShadows;
  if (e.code === 'KeyO') opts.lod = !opts.lod;
  if (e.code === 'KeyV') opts.real = !opts.real;
  if (e.code === 'KeyN') opts.stepped = !opts.stepped;
  if (e.code === 'KeyL') opts.lockDist = !opts.lockDist;
  if (e.code === 'KeyK') opts.snap = !opts.snap;
  if (e.code === 'KeyF') dofOn = !dofOn;
  if (e.code === 'KeyI') spriteDebug = !spriteDebug; // see updateSpriteDebug
  if (e.code === 'KeyM') nextSheetMode(); // the airborne blood: the next of SHEET_MODES
  if (e.code === 'KeyP') {
    rtSizeIdx = (rtSizeIdx + 1) % RT_SIZES.length;
    opts.resolution = RT_SIZES[rtSizeIdx];
    for (const { imp } of npcs.concat(skulls, corpses)) imp.setResolution(opts.resolution);
  }
  if (e.code === 'Equal') addNpcs(10);
  if (e.code === 'Minus') removeNpcs(10);
  hud.textContent = HUD + `  |  bounds ${opts.bounds ? 'ON' : 'off'} · showing ${opts.real ? 'REAL 3D' : 'sprites'} · anim ${opts.stepped ? opts.animFps + 'fps' : 'smooth'} · RT dolly ${opts.lockDist ? 'LOCKED' : 'follows'} · angles ${opts.snap ? opts.snaps + '×' + opts.pitchSnaps + ' snaps' : 'free'} · sprite ${opts.resolution}px${opts.lod ? ' (LOD)' : ''} · shadows ${opts.spriteShadows ? 'SPRITE' : 'blob'} · DoF ${dofOn ? 'ON' : 'off'} · blood ${SHEET_MODES[sheetMode]}`;
});
addEventListener('keyup', (e) => (keys[e.code] = false));
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  sizeWorld();
  sizeGun();
});
sizeGun();

