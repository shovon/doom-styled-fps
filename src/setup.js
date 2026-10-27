// Settings read first (your moves, the enemy kinds, the sprites' sizes); the renderer, the scene and its lights
import './sprites.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ---------------------------------------------------------------------------
// Demo: first-person, Doom-style. The world's demons are SpriteImpostors; your
// weapon is the same trick drawn flat over the screen.
// ---------------------------------------------------------------------------
export const MOVE = 4.5, SPRINT = 7.5;  // player m/s
export const STEP_LENGTH = 1.8;         // m walked per footstep sound
export const EYE_HEIGHT = 1.6;
export const GRAVITY = 20, JUMP_HEIGHT = 1.0;     // m/s² (snappy, ~2× Earth), m: about 0.6 s in the air
const DEMON_WALK = 1.33;     // NPC demon m/s: Orc Walk stride (1.65 m per 1.13 s cycle) × 0.91 leg scale
const DEMON_PACE = 1.5, DEMON_FAST = 2.2; // normal and fast pace multipliers; the walk clip speeds up by the same factor, so feet still match
const DEMON_FACING = 0;      // demon.glb facing offset (0 = faces +Z); set Math.PI if they walk backwards
// The enemies: a mix of three kinds, dealt out in turn (a zombie, an officer, a demon, a zombie…: see addNpcs), each
// with its own model, clips and ways (see KINDS; npc.zombie, npc.police, npc.demon say which it is):
// - 'police': zombie police officers with rifles (models/police.glb: image-to-3d, rigged with Mixamo's skeleton and
//   given Mixamo's rifle Idle, Walk, WalkAim, Run and Fire, and the zombie's Die, holding the M4: tools/rig_mixamo.py), standing
//   about and strolling till they're on to you (see POLICE_SIGHT), then running at you, circling you, running off your
//   aim, and stopping to fire bursts (see POLICE_BURST)
// - 'zombie': models/zombie.glb (the same, with Run, Idle, Punch, Die), running at you and punching
// - 'demon': demon.glb (Walk/Fire/Death), shooting volleys, orbiting you, dodging your aim
// and flying skulls with them (see SKULLS). ?enemy=zombie (or police, or demon) makes them all the one kind.
const ENEMY_KINDS = ['zombie', 'police', 'demon'], ONLY_KIND = new URLSearchParams(location.search).get('enemy');
export const ENEMIES = ENEMY_KINDS.includes(ONLY_KIND) ? [ONLY_KIND] : ENEMY_KINDS; // the kinds in play
const ZOMBIE_RUN = 2.35;     // m/s: Run's stride (a planted foot slides back at this; 0.8 s a cycle)
const ZOMBIE_PACE = 1, ZOMBIE_FAST = 1.3; // it runs already: 2.35 / 3.05 m/s (you: MOVE)
// m/s: the police's Walk (the rifle held low: not on to you), WalkAim (the rifle up, aimed: on to you) and Run strides
// (a planted foot slides back at these)
export const POLICE_WALK = 0.94, POLICE_AIM_WALK = 0.77, POLICE_RUN = 3.74;
const FEET = ['mixamorigLeftFoot', 'mixamorigRightFoot']; // (GLTFLoader drops the ':' from Mixamo's bone names)
// Each kind: its files (the model, then any clips to add to it), its clips and its feet (rig), its walking clip's stride
// (m/s), its paces (normal and fast, × stride: the clip's sped up the same, so its feet still match) and which way its
// model faces (0: +Z; Mixamo's characters face +Z too). Loaded, it gets its gltf and its footfalls (see findFootfalls).
export const KINDS = {
  zombie: { files: ['models/zombie.glb'], rig: { walk: 'Run', fire: 'Punch', death: 'Die', feet: FEET },
    stride: ZOMBIE_RUN, pace: ZOMBIE_PACE, fast: ZOMBIE_FAST, facing: 0 },
  police: { files: ['models/police.glb'], rig: { walk: 'Walk', aimWalk: 'WalkAim', run: 'Run', fire: 'Fire', death: 'Die', feet: FEET },
    stride: POLICE_WALK, pace: 1, fast: 1, facing: 0 },
  demon: { files: ['models/demon.glb', 'models/demon_walk.glb', 'models/demon_death.glb'],
    rig: { walk: 'Walk', fire: 'Fire', death: 'Death', feet: ['foot.L', 'foot.R'] }, stride: DEMON_WALK, pace: DEMON_PACE, fast: DEMON_FAST, facing: DEMON_FACING },
};
export const RT_SIZES = [128, 256, 512, 64]; // sprite resolutions cycled with P (first is the default)

export const renderer = new THREE.WebGLRenderer({ antialias: true });
// 1 canvas pixel per CSS pixel, even on Retina; the browser scales the canvas up, crisp (see CSS). That's for the
// overlays (the lens blood, the hit arcs, the vignette, the weapon): the world itself is drawn at worldScale of it
// (see composer).
renderer.setPixelRatio(1);
// The world (the scene, depth of field, bloom) at worldScale of the canvas's pixels per axis (½: a quarter of them),
// scaled up crisp: every one of those passes' work shrinks with it, and with 64 px textures and low-res sprites
// there's little detail to lose.
// Frame rate: capped at FPS_CAP (on a faster display, its extra frames are skipped: twice the work for a game that
// poses its demons at 12 fps).
// Dynamic resolution: worldScale steps through WORLD_SCALES (whole fractions, so the crisp upscale's blocks are all one
// size) to hold that. Measured by the time between frames (the GPU's own timers proved unreliable on Apple's driver):
// over each SCALE_WINDOW s, a median past SLOW × the frame time is a step down; after upWait s on time, a step up
// to try, kept if PROBE s stay on time, else back down and twice as long before the next try (to UP_WAIT_MAX).
// The first SCALE_SETTLE s (loading, shaders compiling) don't count. ?scale= fixes it, to compare.
export const FPS_CAP = 60, FRAME_MS = 1000 / FPS_CAP;
export const WORLD_SCALES = [1 / 2, 1 / 3, 1 / 4];
export const SCALE_WINDOW = 0.5, SLOW = 1.3, UP_WAIT = 5, UP_WAIT_MAX = 60, PROBE = 2, SCALE_SETTLE = 3; // s; ×; s; s; s; s
export const fixedScale = Number(new URLSearchParams(location.search).get('scale')) || 0;
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.setClearColor(0x000000, 0); // transparent sprite backgrounds
renderer.info.autoReset = false;     // count every render call in a frame, not just the last one
document.body.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
// Dim ambient: the room environment (the even fill light, and what metal reflects; a three.js AmbientLight
// would skip metal, which has no diffuse) at a low 0.015, so the arena reads while the ceiling lights, glowing strips
// and muzzle flashes carry it. Tried: 0.1 too bright, 0.03 a little flat, 0.0075 too dark, 0 hides the demons in the
// dark. The sprite stage and the gun copy this intensity.
// Fog: thick and blood red. Fog isn't lit (it blends each pixel toward its colour by distance), so it's a
// dark red that reads as murk, not a glow. Exponential-squared: ~half gone at 20 m, nearly solid by 40 m.
const FOG_COLOR = 0x5c1010, FOG_DENSITY = 0.042;
scene.background = new THREE.Color(FOG_COLOR);
scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment()).texture;
scene.environmentIntensity = 0.015;

export const sunOffset = new THREE.Vector3(8, 15, 6);
// The arena is roofed (the ceiling: see arena.js), so no sunlight gets in: intensity 0, and no shadow pass to pay for.
// The sprite stage and the gun copy this intensity. Inside, light comes from the strip lights and muzzle
// flashes. For daylight again: 2.5 and castShadow = true.
export const sun = new THREE.DirectionalLight(0xfff2e0, 0);
sun.castShadow = false;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15 });
scene.add(sun, sun.target);

// Stage = lighting for sprite renders: same sun direction and environment, no shadows, fog or background
export const stage = new THREE.Scene();
stage.environment = scene.environment;
stage.environmentIntensity = scene.environmentIntensity;
const stageSun = new THREE.DirectionalLight(sun.color, sun.intensity);
stageSun.position.copy(sunOffset); // direction only; target stays at the origin
stage.add(stageSun);

// Muzzle flashes: a fixed pool of point lights, each mirrored into the sprite stage at the same world
// position. The stage works in world coordinates, so a copy at the same spot lights sprites correctly.
// Fixed count = no shader recompiles; idle lights just sit at intensity 0.
export const FLASH_COLOR = 0xffa040, FLASH_INTENSITY = 30, FLASH_RANGE = 8, FLASH_TIME = 0.1;
export const flashes = Array.from({ length: 4 }, () => {
  const world = new THREE.PointLight(FLASH_COLOR, 0, FLASH_RANGE, 2);
  const sprite = world.clone();
  scene.add(world);
  stage.add(sprite);
  return { world, sprite, ttl: 0 };
});
// ponytail: pool of 4; shots beyond 4 simultaneous flashes don't light anything. Raise it if that shows.
// The portals' light (see Portals): a pool like the flashes', given to the portals lighting you most (see updatePortals)
export const PORTAL_LIGHT_COLOR = 0xff4a14, PORTAL_LIGHTS = 2, PORTAL_RANGE = 8, PORTAL_INTENSITY = 30;
// m: its light on you (and all round you) never more than from this near (by 1/d², it went up without end as you neared
// one: a flash, as from behind you, of one you'd backed up to); and its sparks, its point and its streak fade out in
// front of you over this, nearer (one passing your eye was a bar of light across the screen)
export const PORTAL_NEAR = 3, PORTAL_NEAR_FADE = [0.4, 1.4];
export const portalLights = Array.from({ length: PORTAL_LIGHTS }, () => {
  const world = new THREE.PointLight(PORTAL_LIGHT_COLOR, 0, PORTAL_RANGE, 2);
  const sprite = world.clone();
  scene.add(world);
  stage.add(sprite);
  return { world, sprite };
});
export function muzzleFlash(position) {
  const f = flashes.find((f) => f.ttl <= 0);
  if (!f) return;
  f.world.position.copy(position);
  f.sprite.position.copy(position);
  f.world.intensity = f.sprite.intensity = FLASH_INTENSITY;
  f.ttl = FLASH_TIME;
}

