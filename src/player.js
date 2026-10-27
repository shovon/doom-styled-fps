// You: your health, and being shot (hurtPlayer, demonShot)
import './firing.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { muzzleFlash } from './setup.js';
import { camera } from './camera.js';
import { HIT_KICK, shake } from './weapons.js';
import { rayWorld } from './holes.js';
import { _hudV, hudHit } from './hud.js';
import { demonVoice } from './enemy-ai.js';
import { policeHear } from './police.js';
import { clock, playerMoving } from './main.js';

export const ammoEl = document.getElementById('ammo');
// Getting shot: each demon shot (demonShot) can hit you. The chance falls off with distance (DEMON_ACCURACY at point
// blank, down to a floor) and is cut a little while you're moving (DEMON_MOVING_AIM); a column or the platform in between blocks it. A hit takes
// DEMON_DAMAGE off your health (shown bottom left; at 0 it stays at 0: there's no dying yet), kicks the view a
// little, flicks a few specks of blood onto your view (hudFx) and shows a red arc round the centre of the screen,
// pointing the way the shot came from.
export const PLAYER_HEALTH = 100, DEMON_DAMAGE = 4, DEMON_ACCURACY = 0.45, DEMON_ACCURACY_MIN = 0.1, DEMON_ACCURACY_FALLOFF = 0.015;
const DEMON_MOVING_AIM = 0.8; // their hit chance while you move (share of it standing still)
// The police (see KINDS) shoot in bursts, not a stream: the rifle up for POLICE_AIM s, then POLICE_BURSTS bursts of
// POLICE_BURST rounds, POLICE_SHOT_GAP s apart, POLICE_PAUSE s between bursts (the trigger let go), each round as a
// demon's shot (its chance to hit, its damage); then on the move again
export const POLICE_AIM = 0.35, POLICE_BURSTS = [2, 3], POLICE_BURST = [3, 5], POLICE_SHOT_GAP = 0.09, POLICE_PAUSE = [0.5, 1.1]; // s; ; rounds; s; s
export const POLICE_DAMAGE = 2; // a round's, if it hits (a demon's shot: DEMON_DAMAGE; every officer shoots, and in bursts)
export const randRange = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1)); // a whole number from a to b
export let playerHealth = PLAYER_HEALTH;
const healthEl = document.getElementById('health');
const updateHealth = () => (healthEl.textContent = `+ ${Math.max(Math.ceil(playerHealth), 0)}`);
updateHealth();
export const _shotFrom = new THREE.Vector3(), _shotDir = new THREE.Vector3();
// You're hit, from world point from: health, a jolt away from it (turned from its side, tipped up, springing back),
// a shake, and the HUD's blood and arc pointing at it
export function hurtPlayer(from, damage) {
  playerHealth = Math.max(playerHealth - damage, 0);
  updateHealth();
  _hudV.copy(from).applyMatrix4(camera.matrixWorldInverse);
  const side = Math.atan2(_hudV.x, -_hudV.z);
  shake.hitYaw += HIT_KICK * Math.sin(side); // from the right: the view's knocked left, and so on
  shake.hitPitch += HIT_KICK * 0.6;
  shake.trauma = Math.max(shake.trauma, Math.min(shake.trauma + 0.47, 1)); // (never lowering a punch's, above 1)
  hudHit(from);
}
// Zombies (see KINDS): one within ZOMBIE_REACH of you (its middle to your eye, across the floor) stops and swings, and
// keeps swinging till you're past ZOMBIE_LET_GO; a blow lands ZOMBIE_HITS s into Punch (its fist at full stretch, ~0.9 m
// out: an overhead, then a jab) for ZOMBIE_DAMAGE, unless you're ZOMBIE_CLEAR above or below it (jumped, or up a step or
// two). Up on the platform, you're not out of their reach: they come up the stairs after you (see stairsTo).
export const ZOMBIE_REACH = 1.2, ZOMBIE_LET_GO = 1.4, ZOMBIE_HITS = [1.27, 1.87], ZOMBIE_DAMAGE = 10, ZOMBIE_CLEAR = 0.6; // m; m; s; ; m
export const ZOMBIE_SPACING = 1.5; // m: how far apart they like to keep (closer than demons: they crowd you)
export function demonShot(npc, damage = DEMON_DAMAGE) {
  const from = npc.muzzle.getWorldPosition(_shotFrom);
  muzzleFlash(from);
  // its gun (sounds/demon_shot.wav: freesound "submachine gun", one shot and its tail), quieter the further off
  demonVoice(npc, 'demon_shot', 0.9);
  if (npc.police) policeHear(from, npc.seenAt.x, npc.seenAt.y, clock.elapsedTime, npc.seenOn); // (the others too: at where it thinks you are)
  _shotDir.subVectors(camera.position, from);
  const dist = _shotDir.length();
  _shotDir.divideScalar(dist);
  const w = rayWorld(from, _shotDir);
  if (w && w.t < dist - 0.3) return; // something's in the way
  let chance = Math.max(DEMON_ACCURACY - dist * DEMON_ACCURACY_FALLOFF, DEMON_ACCURACY_MIN);
  if (playerMoving) chance *= DEMON_MOVING_AIM;
  if (Math.random() >= chance) return;
  hurtPlayer(from, damage);
}
