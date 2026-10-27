// Sound: the samples, playSound, your footsteps
import './shots.js'; // (first: this file runs after that one; see main.js)
import { ENEMIES } from './setup.js';
import { camera } from './camera.js';
import { SHOTGUN } from './weapons.js';
import { PRINT_STRIDE, player, inWetBlood, footPrint, playSquelch } from './blood-maps.js';
import { move, jumpY } from './main.js';

// Sound: the rifle's report on every shot (sounds/rifle_shot.wav: freesound "assaultrifle2", trimmed to its crack and
// 1.5 s of tail). At full auto the copies overlap into the burst; each a touch different in pitch and level, so it
// doesn't machine-gun one identical sample. Web Audio: decoded once, started on the click that locks the pointer.
// The shotgun's blast instead: sounds/shotgun_blast.wav (Pixabay, universfield "shotgun blast"). A punch landing:
// sounds/punch.wav (Pixabay, universfield "punch", 140236), its leading silence cut.
export const audio = new AudioContext();
// Music: sounds/dream_cheater.mp3 ("Dream Cheater"), looped at half volume; streamed by an <audio> element (8 minutes:
// decoded whole into Web Audio it'd be ~170 MB), started with the rest of the sound on the first click
export const music = Object.assign(new Audio('sounds/dream_cheater.mp3'), { loop: true, volume: 0.5 });
export const shotOut = audio.createGain();
shotOut.gain.value = 0.6;
shotOut.connect(audio.destination);
export const sounds = {};
const FOOTSTEPS = 11; // sounds/footstep_0..10.wav: single steps from "walking up the stairs" (freeeverythingxx)
export const GRUNTS = 5; // sounds/hurt_grunt_0..4.wav: from heckingfeck's royalty-free "male pain grunts" (its 0:00, 0:02, 0:03, 0:07, 0:13)
export const DEMON_GRUNTS = 4; // sounds/demon_grunt_0..3.wav: freesound "monster chase grunts" (its four)
export const DEMON_DEATHS = 4; // sounds/demon_death_0..3.wav: the four calls in dragon-studio "monster call"
// sounds/zombie_00..17.wav: the zombies' snarls and groans as they chase you, from "assortment of zombie sounds" (split
// at its silences, mono, trimmed, faded, and peak-normalized like the others); sounds/zombie_death.wav, its death, from
// "zombie dying" (one, whole: its gasps and last rattle, trimmed and levelled the same)
export const ZOMBIE_SOUNDS = 18, zombieSound = (k) => `zombie_${String(k).padStart(2, '0')}`;
// sounds/portal_spark_00..25.wav: the portals' lightning crackling (see Portals), the bursts of freesound "electric
// sparks" (split at its quiet gaps, levelled like the others); sounds/portal_whoosh.wav, one coming through: dragon-studio
// "sci-fi portal jump" (cut where it dies away, 1.55 s in, faded: the rest was near silence)
export const PORTAL_ZAPS = 26, portalZap = (k) => `portal_spark_${String(k).padStart(2, '0')}`;
for (const name of ['rifle_shot', 'shotgun_blast', 'punch', 'shell_drop', 'reload', 'demon_shot', ...Array.from({ length: DEMON_GRUNTS }, (_, k) => `demon_grunt_${k}`),
  ...(ENEMIES.includes('zombie') ? [...Array.from({ length: ZOMBIE_SOUNDS }, (_, k) => zombieSound(k)), 'zombie_death'] : []),
  ...Array.from({ length: DEMON_DEATHS }, (_, k) => `demon_death_${k}`),
  ...Array.from({ length: PORTAL_ZAPS }, (_, k) => portalZap(k)), 'portal_whoosh',
  ...Array.from({ length: GRUNTS }, (_, k) => `hurt_grunt_${k}`),
  ...Array.from({ length: FOOTSTEPS }, (_, k) => `footstep_${k}`)])
  fetch(`sounds/${name}.wav`).then((r) => r.arrayBuffer()).then((b) => audio.decodeAudioData(b)).then((b) => (sounds[name] = b));
export function playSound(name, level, pitch) { // pitch: ± this fraction, at random
  if (!sounds[name]) return;
  const src = audio.createBufferSource(), gain = audio.createGain();
  src.buffer = sounds[name];
  src.playbackRate.value = 1 + (Math.random() * 2 - 1) * pitch;
  gain.gain.value = level;
  src.connect(gain).connect(shotOut);
  src.start();
  return src;
}
export const playShot = () => playSound(SHOTGUN ? 'shotgun_blast' : 'rifle_shot', 0.85 + Math.random() * 0.15, 0.04);
// A casing hitting the floor (sounds/shell_drop.wav: the first drop of freesound "bullet shells", its clink and its
// little bounces after): once, on its first landing; quieter the further it fell from you
export const playShellDrop = (d) => playSound('shell_drop', (0.5 + Math.random() * 0.3) / (1 + d * 0.6), 0.08);
// Footsteps: one of the steps at random, never the same twice running
let lastStep = -1;
function playStep(level) {
  let k = (Math.random() * (FOOTSTEPS - 1)) | 0;
  if (k >= lastStep) k++;
  playSound(`footstep_${(lastStep = k % FOOTSTEPS)}`, level * (0.85 + Math.random() * 0.15), 0.05);
}
// your step's sound: squelching in wet blood (the step under it)
export function playerStep(level) {
  const wet = jumpY <= 0 && inWetBlood(player);
  playStep(wet ? level * 0.6 : level);
  if (wet) playSquelch(level * 1.4);
}
// your feet, every PRINT_STRIDE m walked on the floor: a print each (if your boots are bloody), facing the way you're
// walking (move: this frame's, normalized)
let printDist = 0;
export function playerFeet(dist) {
  if ((printDist += dist) < PRINT_STRIDE) return;
  printDist -= PRINT_STRIDE;
  footPrint(player, camera.position, move.x, move.z, false);
}

