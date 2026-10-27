// The weapons in your hands (drawn flat over the screen): the fists, pistol, M4 and shotgun, their poses, aiming,
// reloads and switching; the camera's shake
import { VIEW_FOV, camera, look, opts } from './camera.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { scene, sun, flashes, portalLights } from './setup.js';
import { loadMap } from './tiles.js';
import { stripLights, ceilLights, spotLight, spotLights } from './lights.js';
import { playSquelch } from './blood-maps.js';
import { FL_GOBS, burstBlood } from './blood-fluid.js';
import { shellModel, _cf, dropCasing } from './casings.js';
import { paintWound } from './shots.js';
import { playSound } from './audio.js';
import { splashLens } from './hud.js';
import { addGunBlood, updateAmmo } from './gun-blood.js';
import { npcs } from './enemies.js';
import { damageNpc } from './enemy-ai.js';
import { skulls, hitSkull } from './skulls.js';

// ---------------------------------------------------------------------------
// Weapon "viewmodel": arms + M4 rendered off-screen from the rig's own camera joint, at low
// resolution, then drawn flat over the screen. It has its own little world (gunScene); world
// lights are carried into it through view space, since your eye is the camera in both worlds.
// ---------------------------------------------------------------------------
const GUN_RES = 240;          // weapon render height in pixels (width follows the screen's aspect)
export const GUN_FOV = 60;
// The weapons, all in the M4 pack's arms and moved by its clips, switched with keys 1-4 (see useWeapon), the pistol to
// start: fists (the arms bare: see holdFists), the pistol (models/pistol/pistol.glb, Cam Diep Minh's Canik Rival S:
// see holdPistol), the M4 (the pack's own rifle) and the shotgun (models/super_shotgun/super_shotgun.glb, tnnv's
// sawn-off side-by-side: see holdShotgun). Each one's:
//   mag: rounds (M4 30, full auto at 800 rpm, mid M4A1 range; the shotgun 2 shells, both barrels at once, 8 pellets
//     each, then it reloads; the pistol 20, the extended magazine, one shot a click; fists: a punch every interval s
//     while it's held, left and right in turn, each going out as the last gets back, a seesaw: see punch)
//   interval: s between shots; pellets a shot, up to spread rad off the aim
//   power: how hard a shot hits (shotgun 1): the camera's kick and shake, the gun's recoil, and how long a demon it
//     hits goes on bleeding (see KICK_PER_SHOT, RECOIL_BACK, BLEED_TIME)
//   splat: how much bigger a shot's airborne splash is drawn (not more of it: see burstBlood)
//   reload: how much faster the reload clips play (3.6 s → 1.45 s at 2.5; the shotgun's 1.6 s): the demons don't wait
//   flash: the muzzle flash's size (the shotgun: both barrels' in one; the pistol: a 9 mm through a compensator)
export const WEAPONS = {
  fists: { key: 'Digit1', mag: 1, interval: 0.28, pellets: 1, spread: 0, power: 0.3, splat: 1, reload: 2.5, flash: 1 },
  pistol: { key: 'Digit2', mag: 20, interval: 0.12, pellets: 1, spread: 0, power: 0.3, splat: 1, reload: 2.8, flash: 0.7 },
  m4: { key: 'Digit3', mag: 30, interval: 0.075, pellets: 1, spread: 0, power: 0.15, splat: 1, reload: 2.5, flash: 1 },
  shotgun: { key: 'Digit4', mag: 2, interval: 0.25, pellets: 16, spread: 0.05, power: 1, splat: 1.5, reload: 2.3, flash: 1.4 },
};
// The one in hand (set by useWeapon; read all over, so kept as these names)
export let WEAPON = 'pistol', SHOTGUN = false, PISTOL = true, FISTS = false;
export let MAG = 20, FIRE_INTERVAL = 0.12, PELLETS = 1, SPREAD = 0, POWER = 0.3, SPLAT_SCALE = 1, RELOAD_SPEED = 2.8;
export const BOB = 0.04;             // weapon bob size, in screen units (2 = full screen height)

export const gunScene = new THREE.Scene();
gunScene.environment = scene.environment;
gunScene.environmentIntensity = scene.environmentIntensity;
export const gunSun = new THREE.DirectionalLight(sun.color, sun.intensity);
gunScene.add(gunSun, gunSun.target);
export const gunFlashes = flashes.map((f) => { const l = f.world.clone(); gunScene.add(l); return l; });
// The strip lights too: with no ambient they're all that lights the gun between shots. Like the pose, they
// update when the weapon re-renders (stepped), not every frame.
export const gunStrips = stripLights.map((s) => { const l = s.world.clone(); gunScene.add(l); return l; });
export const gunCeil = ceilLights.map((c) => { const l = c.world.clone(); gunScene.add(l); return l; });
export const gunSpots = spotLights.map(() => { const l = spotLight(); gunScene.add(l); if (l.target) gunScene.add(l.target); return l; });
export const gunPortals = portalLights.map((p) => { const l = p.world.clone(); gunScene.add(l); return l; }); // (see Portals)
export const gunCam = new THREE.PerspectiveCamera(GUN_FOV, 1, 0.01, 10);
export const gunRT = new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter,
});
export const hudScene = new THREE.Scene(), hudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
// The gun's image is already premultiplied (drawn over a clear, transparent target), so it's laid over the world as
// such: colour + world × (1 − opacity). (three's premultipliedAlpha flag would multiply the colour by the opacity
// again, which would black out the muzzle flash: light with no opacity, that's only added.)
export const gunQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({
  map: gunRT.texture, transparent: true, depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
}));
hudScene.add(gunQuad);
// Fists: the left fist is the right one's image, mirrored (see holdFists): drawn into its own target, laid over the
// screen flipped left to right (it follows the gun's bob), under the right
export const gunMirrorRT = gunRT.clone(), gunMirrorQuad = new THREE.Mesh(gunQuad.geometry, gunQuad.material.clone());
gunMirrorQuad.material.map = gunMirrorRT.texture;
gunMirrorQuad.scale.x = -1;
gunMirrorQuad.renderOrder = -1;
gunMirrorQuad.visible = false; // (fists only: see useWeapon)
hudScene.add(gunMirrorQuad);
export function sizeGun() {
  const w = Math.round((GUN_RES * innerWidth) / innerHeight);
  gunRT.setSize(w, GUN_RES);
  gunMirrorRT.setSize(w, GUN_RES);
  gunCam.aspect = w / GUN_RES;
  gunCam.updateProjectionMatrix();
  if (gun) gun.dirty = true;
}

// The muzzle flash: textures/muzzle_flash.png (the generator's muzzle_flash), FLASH_VARIANTS shapes across, two
// frames down (the bang, then the next instant). Each shot picks a shape (mirrored half the time) and plays the bang
// for GUN_BANG_TIME (about a frame), then the second frame to GUN_FLASH_TIME: short, so at full auto it reads as
// separate bangs with gaps, not a shape hanging off the barrel. Drawn into the gun's own render, so it's pixelated
// with it; additive, screen-aligned so the flash hider's prongs point up.
export const GUN_FLASH_TIME = 0.045, GUN_BANG_TIME = 0.017, FLASH_VARIANTS = 4; // s; s; shapes in the sheet
// The sheet is only heat (grey); here heat becomes light: faint deep red at the tips, orange, then white-hot and far
// brighter than white (FLASH_GAIN) at the core. A flame is light, not stuff: it's added to whatever's behind it and
// leaves the gun image's opacity alone, so where the gun image goes over the world it adds its light there too, and it
// only reads as solid where it outshines what's behind it.
const FLASH_GAIN = 3, FLASH_FALLOFF = 2.4; // core brightness; how fast the light drops off with heat (higher: dimmer arms)
export const flashSheet = loadMap('muzzle_flash');
Object.assign(flashSheet, { minFilter: THREE.NearestFilter, generateMipmaps: false });
flashSheet.repeat.set(1 / FLASH_VARIANTS, 1 / 2);
export const muzzleSprite = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.ShaderMaterial({
  uniforms: { uHeat: { value: flashSheet } },
  vertexShader: `
    varying vec2 vUv;
    uniform sampler2D uHeat;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D uHeat;
    uniform vec2 uRepeat, uOffset;
    varying vec2 vUv;
    void main() {
      float h = texture2D(uHeat, vUv * uRepeat + uOffset).r;
      if (h <= 0.0) discard;
      vec3 col = mix(vec3(0.7, 0.12, 0.02), vec3(1.0, 0.5, 0.12), smoothstep(0.15, 0.55, h)); // deep red → orange
      col = mix(col, vec3(1.0, 0.92, 0.75), smoothstep(0.55, 0.95, h));                     // → white-hot
      gl_FragColor = vec4(col * pow(h, ${FLASH_FALLOFF.toFixed(1)}) * ${FLASH_GAIN}.0, 0.0); // light only
    }`,
  transparent: true, depthWrite: false,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
}));
muzzleSprite.material.uniforms.uRepeat = { value: flashSheet.repeat };
muzzleSprite.material.uniforms.uOffset = { value: flashSheet.offset };
muzzleSprite.visible = false;
gunScene.add(muzzleSprite);

export let gun = null;      // { root, mixer, actions, joint, muzzle, hinge, shells, arm, shellsOut, handOver, eyeBack, flick, lower, firedAt, ammo, busy, cooldown, animAcc, lastLights, dirty, flashUntil, flashVariant, flashMirror, flashFrame }
// The mouse's buttons: the left held (trigger); aiming wanted (aimHeld: the right, see ADS_TOGGLE). An object, as other
// files set them too (the input, a shot, the menu): a file can read another's let, not set it
export const mouse = { trigger: false, aimHeld: false };
export const _toGun = new THREE.Matrix4(), _gs = new THREE.Vector3(), _mw = new THREE.Vector3(), _noAim = new THREE.Vector3(); // (_noAim: a gun that can't aim)
export const _tgp = new THREE.Vector3(), _tgq = new THREE.Quaternion();
export const _flickAt = new THREE.Vector3(), _flickAxis = new THREE.Vector3(), _flickQ = new THREE.Quaternion();

// The pistol in the M4's place, as the shotgun (see holdShotgun): the rifle's meshes hidden, the pistol on the rifle's
// joint at the ready pose, its trigger (its origin) on the rifle's trigger, facing where the eye looks (metres, barrel
// along −Z, up +Y: see tools/pistol.py). Returns its muzzle (the compensator's front, on the bore: PISTOL_MUZZLE, in
// its own space) and its "Slide", which runs back SLIDE_BACK m and home over SLIDE_TIME s a shot, and stays back
// on an empty magazine.
export const PISTOL_MUZZLE = [0, 0.0392, -0.1665], SLIDE_BACK = 0.025, SLIDE_TIME = 0.08; // m; m; s
// One-handed: the left arm (from the shoulder) shrunk to nothing after every pose (the clips still move it, for the
// rifle), and the whole view shifted so the pistol sits higher, still out to the right in the right hand: the gun's
// eye moved PISTOL_VIEW m right and down (so the hand and pistol show up left and up)
export const PISTOL_VIEW = [0, -0.085];
// Aiming down the sights (the right mouse button: see ADS_TOGGLE; the pistol, the M4 and the shotgun): over ADS_TIME s
// the gun's eye moves from the hip view onto the sight line, some way behind the sights: the pistol's ADS_EYE m behind
// its optic's window (OPTIC: its glass's middle, in the pistol's space), the M4's M4_ADS_EYE m behind its rear
// sight's aperture (M4_SIGHT: its middle, in the rifle's own space, cm), in line with the front post, the shotgun's
// SHOTGUN_ADS_EYE m behind its front sight's top (SHOTGUN_SIGHT, in its space: a blade at the muzzle, looked at
// along the rib between the barrels). The view zooms to ADS_FOV (the gun's own to ADS_GUN_FOV), the look slowing
// with it; the crosshair becomes the optic's red dot (the irons have none: the front sight's the aim), the walk's bob
// stills, and depth of field focuses on what's under the crosshair (see DOF_ADS_APERTURE). Off while drawing or
// reloading (the shotgun reloads after every shot: it comes back up to the sights after).
const OPTIC = [0, 0.0685, -0.03], ADS_EYE = 0.25, M4_SIGHT = [-5.683, 153.2, 5.5], M4_ADS_EYE = 0.07; // m; m; cm; m
const SHOTGUN_SIGHT = [0, 0.0995, -0.495], SHOTGUN_ADS_EYE = 0.7; // m; m
export const ADS_TIME = 0.15, ADS_FOV = 55, ADS_GUN_FOV = 45; // s; °; °
// true: a right click aims, the next stops (and a weapon switch does); false: it aims while the button's held
export const ADS_TOGGLE = true;
export let aimT = 0, aim = 0; // how far in (0..1, linear); the same, eased
// Aiming down the sights (see OPTIC), each frame: eased in and out, the view's zoom and the look's speed with it (the
// same turn for the same move across the screen)
export function updateAim(dt) {
  aimT = THREE.MathUtils.clamp(aimT + (mouse.aimHeld && gun?.adsAt && !gun.busy ? dt : -dt) / ADS_TIME, 0, 1);
  if (smooth(aimT, 0, 1) !== aim) {
    aim = smooth(aimT, 0, 1);
    gun.dirty = true;
    camera.fov = THREE.MathUtils.lerp(VIEW_FOV, ADS_FOV, aim);
    camera.updateProjectionMatrix();
    look.pointerSpeed = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(VIEW_FOV) / 2);
    document.body.dataset.aim = aim > 0.5 ? (gun.adsDot ? 'dot' : 'irons') : '';
  }
}
// The aiming eye: back m behind a point on a gun's sight line (sight, in the gun's own space), in the eye's space, in
// metres (its bone's in cm). At the ready pose (Draw's end) the guns' sights look where the eye does (the pistol's
// placed so; the pack built the M4's so, to within 0.1°), so aiming is only a move.
function aimEye(root, draw, gun, sight, back) {
  draw.play();
  draw.time = draw.getClip().duration;
  draw.getMixer().update(0);
  root.updateMatrixWorld(true);
  const eye = root.getObjectByName('FPS_Camera_j_01');
  const at = eye.worldToLocal(gun.localToWorld(new THREE.Vector3(...sight))).multiplyScalar(eye.getWorldScale(new THREE.Vector3()).x);
  draw.stop();
  return at.setZ(at.z + back);
}
function holdPistol(root, draw, mainJoint, pistol) {
  root.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) o.visible = false; });
  draw.play();
  draw.time = draw.getClip().duration;
  draw.getMixer().update(0);
  root.updateMatrixWorld(true);
  root.getObjectByName('FPS_Camera_j_01').matrixWorld.decompose(_sgP, _sgQ, _sgS);
  new THREE.Box3().setFromObject(root.getObjectByName('Trigger_M4_D_0')).getCenter(_sgP);
  pistol.matrix.compose(_sgP, _sgQ, _sgS.set(1, 1, 1)).premultiply(mainJoint.matrixWorld.clone().invert());
  pistol.matrix.decompose(pistol.position, pistol.quaternion, pistol.scale);
  mainJoint.add(pistol);
  draw.stop();
  const ads = aimEye(root, draw, pistol, OPTIC, ADS_EYE);
  const muzzle = new THREE.Object3D();
  muzzle.position.fromArray(PISTOL_MUZZLE);
  pistol.add(muzzle);
  return { muzzle, slide: pistol.getObjectByName('Slide'), ads, adsDot: true };
}
// Fists: the rifle's meshes hidden; only the right arm is ever drawn, posed by us (reachArm, every pose); the left fist is
// its image, mirrored left to right (drawn twice: the right arm posed as the left fist would be, into the mirror's image,
// then as itself: see updateGun). The rig's two arms are only near mirror copies (the left hand ~5% smaller, the thumbs
// built differently, the light falling differently on each side), so posing the left as its own arm, even as the right's
// mirror image bone by bone, never quite looked like the same fist.
// The guard: fists up, the forearms standing up from elbows down and out to the fists (a boxer's triangle), the wrists
// straight, the curled fingers facing the other fist (thumb sides towards you); a punch drives a fist out to the middle
// of the view and back over PUNCH_TIME s (fast out, slower back), left and right in turn, the fist turning over
// (a corkscrew). Positions are the right arm's, in the eye's space (cm: its bone's units). The rig's shoulders sit where
// a rifle wants them (the right one 39 cm behind the eye, out of reach of anything in front), so the fist's is set
// (FIST_SHOULDER): low and forward; a punch drives it forward (FIST_SHOULDER_OUT) with the arm (~51 cm) to full stretch
// at FIST_OUT, level, into the view (the shoulder kept low: any further up or forward, the arm's cut-off end shows).
const FIST_SHOULDER = [32, -47, -11], FIST_SHOULDER_OUT = [16, -30, -20], FIST_GUARD = [16, -17, -36], FIST_OUT = [2, -13, -82];
// ...the arm stretched PUNCH_STRETCH longer at full stretch (a smear: the shoulder can't come further forward, so the
// reach comes from the arm)
const PUNCH_STRETCH = 0.3;
// ...while the other fist pulls back (the body turning into the punch): to FIST_BACK (nearer you and down in the
// corner, just its top still in view), its shoulder to FIST_SHOULDER_BACK
const FIST_SHOULDER_BACK = [35, -47, -4], FIST_BACK = [15, -18, -24];
const FIST_ELBOW = [65, -100, -40]; // the way the elbow bends: down and out from under the fist
const FIST_ELBOW_BACK = [100, -120, 70]; // ...and pulled back: out, down and back by your side (the forearm lying forward)
// A tight fist: each finger from straight (the rig's bind pose) bent this far at its three knuckles (rad); the thumb
// from straight bent the way the rig's own pose bends it (round the rifle's grip), times FIST_THUMB_CLOSE at its base,
// knuckle and last joint (so it closes along the joints' own axes: aimed at points instead, it twisted and tore), then
// turned FIST_THUMB_LOWER rad down the fist at its base (it sat high); the guard breathing FIST_SWAY cm up and down
const FIST_BEND = [1.45, 1.75, 1.1], FIST_THUMB_CLOSE = [1.7, 1.9, 1.85], FIST_THUMB_LOWER = 0.7;
export const FIST_SWAY = 0.5, FIST_SWAY_HZ = 0.8, PUNCH_TIME = 0.34; // cm; Hz; s
// ...and a punch turns the fist over PUNCH_TWIST rad about the forearm on its way out (a corkscrew: palm down at full
// stretch, the pinky a little up), the turn running ahead of the reach (and staying till the fist's nearly back); the
// fist pulling back turns PULL_TWIST over the same way (palm down along its forearm)
const PUNCH_TWIST = 1.65, PULL_TWIST = 1.57, PUNCH_TWIST_FORE = 0.65; // rad; the forearm's share (the rest's the wrist's)
// A punch lands on the nearest demon in front, its body within PUNCH_REACH m of your eye and within PUNCH_CONE (rad)
// of your aim, PUNCH_HIT of the way into the punch, for PUNCH_DAMAGE (a shot does 1; each point knocks it back too),
// shaking the view with PUNCH_SHAKE trauma (see shakeCamera: a shotgun blast is 1, the most a gun can add) and
// snapping it PUNCH_JOLT rad (up, and to a side), springing back as from being shot
export const PUNCH_REACH = 1.4, PUNCH_CONE = 0.45, PUNCH_HIT = 0.12, PUNCH_DAMAGE = 3, PUNCH_SHAKE = 2, PUNCH_JOLT = 0.07;
// A punch is timed from PUNCH_LEAD s before the click (a fifth of its way out, in time: half way, as it's fastest at
// the start), and posed every frame till it's out (see updateGun): the click's frame shows the fist half way out, the
// next two (at 60 fps) the rest of the way, as it lands; no frame of it still in the guard (s)
const PUNCH_LEAD = PUNCH_TIME * PUNCH_HIT * 0.2;
// The fists, [left, right]: the right arm with all it needs to pose; the left only its punch (it's the right, mirrored)
function holdFists(root, draw) {
  let skeleton = null;
  root.traverse((o) => { if (o.isSkinnedMesh) skeleton = o.skeleton; });
  const bindWorld = (b) => new THREE.Matrix4().copy(skeleton.boneInverses[skeleton.bones.indexOf(b)]).invert();
  const bindTurn = (b) => { // a bone's turn on its parent in the bind pose
    const local = bindWorld(b.parent).invert().multiply(bindWorld(b));
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(local));
  };
  root.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) o.visible = false; });
  draw.play();
  draw.time = draw.getClip().duration;
  draw.getMixer().update(0);
  root.updateMatrixWorld(true);
  const at = (b) => b.getWorldPosition(new THREE.Vector3());
  const bone = (re) => { let f = null; root.traverse((o) => { if (!f && re.test(o.name)) f = o; }); return f; };
  const L = { punchAt: -Infinity };
  const R = { upper: bone(/^RightArm_\d+$/), fore: bone(/^RightForeArm_\d+$/), hand: bone(/^RightHand_\d+$/), punchAt: -Infinity };
  // the right hand's own directions (its bone's space): along it (wrist to knuckles), and the way the fingers curl
  const wrist = at(R.hand), along = at(bone(/^RightHandMiddle1_/)).sub(wrist).normalize();
  const curl = at(bone(/^RightHandMiddle4_/)).sub(wrist);
  curl.addScaledVector(along, -curl.dot(along)).normalize();
  const inv = R.hand.getWorldQuaternion(new THREE.Quaternion()).invert();
  R.along = along.applyQuaternion(inv); R.curl = curl.applyQuaternion(inv);
  R.side = R.along.clone().cross(R.curl); // (the fingers curl round it)
  const S0 = at(R.upper), E0 = at(R.fore);
  R.elbowAxis = E0.clone().sub(S0).cross(wrist.clone().sub(E0)).normalize().applyQuaternion(R.upper.getWorldQuaternion(new THREE.Quaternion()).invert());
  R.fingers = [];
  R.hand.traverse((b) => { if (/^RightHand(Index|Middle|Ring|Pinky)[123]_/.test(b.name)) R.fingers.push(b); });
  R.joint = R.fingers.map((b) => +/([123])_\d+$/.exec(b.name)[1] - 1); // (0: the knuckle)
  R.thumb = [1, 2, 3].map((j) => bone(new RegExp(`^RightHandThumb${j}_`)));
  R.thumbRest = R.thumb.map((b) => b.quaternion.clone()); // (the rig's pose: the clips don't move the thumbs)
  // ...straight (their turns in the bind pose), bent from there each pose: the clips don't move the fingers, so
  // nothing else puts them back between poses (bent from wherever they were, they wound round and round)
  R.fingerBind = R.fingers.map(bindTurn);
  R.thumbBind = R.thumb.map(bindTurn);
  R.handBind = bindTurn(R.hand); // (the wrist straight)
  // ...and the arm as the clip leaves it (Draw's end): each pose starts from there. Once Draw has ended nothing else puts
  // the arm back (three only writes a bone when the clip's value changes), and reachArm turns the forearm the least it
  // can from wherever it was, so its roll about its length crept ~6° a punch, for good
  R.armRest = [R.upper.quaternion.clone(), R.fore.quaternion.clone()];
  R.boneLength = [R.fore.position.clone(), R.hand.position.clone()]; // (the elbow and wrist on their parents: stretched)
  draw.stop();
  return [L, R];
}
const _fa = new THREE.Vector3(), _fb = new THREE.Vector3(), _fc = new THREE.Vector3(), _fd = new THREE.Vector3();
const _fm = new THREE.Matrix4(), _fn = new THREE.Matrix4(), _fq = new THREE.Quaternion(), _fp = new THREE.Quaternion(), _fr = new THREE.Quaternion();
// How far out a punch thrown at punchAt is at now (0: in the guard, 1: all the way out): out at full speed from the
// first frame, easing into the hit (cubic ease-out), then eased slower back to the guard
function punchOut(punchAt, now) {
  const t = (now - punchAt) / PUNCH_TIME;
  return t < 0 || t >= 1 ? 0 : t < PUNCH_HIT ? 1 - (1 - t / PUNCH_HIT) ** 3 : 1 - smooth(t, PUNCH_HIT, 1);
}
// The right arm posed, as at now (the latest pose's time), its punch thrown at punchAt, the other fist's at otherAt
export function poseFist(arm, punchAt, otherAt, now) {
  const eye = gun.joint;
  arm.upper.quaternion.copy(arm.armRest[0]);
  arm.fore.quaternion.copy(arm.armRest[1]); // (reachArm updates the chain's matrices)
  const out = punchOut(punchAt, now), back = punchOut(otherAt, now);
  arm.fore.position.copy(arm.boneLength[0]).multiplyScalar(1 + PUNCH_STRETCH * out);
  arm.hand.position.copy(arm.boneLength[1]).multiplyScalar(1 + PUNCH_STRETCH * out);
  const sway = FIST_SWAY * Math.sin(now * FIST_SWAY_HZ * 2 * Math.PI) * (1 - out);
  _fa.fromArray(FIST_GUARD).lerp(_fb.fromArray(FIST_BACK), back).lerp(_fb.fromArray(FIST_OUT), out);
  const wrist = eye.localToWorld(_fa.setY(_fa.y + sway));
  _fb.fromArray(FIST_SHOULDER).lerp(_fc.fromArray(FIST_SHOULDER_BACK), back);
  const shoulder = eye.localToWorld(_fb.lerp(_fc.fromArray(FIST_SHOULDER_OUT), out));
  // (the pulled-back elbow only as the fist gets back: on a fist still out in front, it swung the elbow over the top)
  const elbowAt = eye.localToWorld(_fc.fromArray(FIST_ELBOW).lerp(_fd.fromArray(FIST_ELBOW_BACK), back * (1 - out)));
  reachArm(arm, wrist, shoulder, 1, elbowAt);
  // the fist: knuckles along the forearm (elbow to wrist), the curled fingers facing the other fist in the guard,
  // turned over as it punches out (PUNCH_TWIST) or pulls back (PULL_TWIST)
  const A = arm.hand.getWorldPosition(_fa).sub(arm.fore.getWorldPosition(_fb)).normalize();
  const twist = -Math.max(PUNCH_TWIST * (1 - (1 - out) ** 2), PULL_TWIST * back); // (both palm down: the larger)
  const D = eye.localToWorld(_fc.set(-1, 0, 0)).sub(eye.getWorldPosition(_fd)).normalize();
  D.addScaledVector(A, -D.dot(A)).normalize().applyAxisAngle(A, twist);
  _fm.makeBasis(A, D, _fb.crossVectors(A, D)); // world: along, curl, side
  _fn.makeBasis(arm.along, arm.curl, _fd.crossVectors(arm.along, arm.curl)).transpose(); // (local, inverted)
  _fq.setFromRotationMatrix(_fm.multiply(_fn));
  // The hand's turn on the forearm about its length (from the wrist straight), PUNCH_TWIST_FORE of it rolled into the
  // forearm instead: the rig has no twist bones, and all of it at the wrist pinched the cuff. Measured, not the twist
  // asked for: where the elbow's bend comes out the other way round, the forearm's rolled over with it.
  _fr.copy(arm.fore.getWorldQuaternion(_fp)).invert().multiply(_fq).multiply(_fp.copy(arm.handBind).invert());
  if (_fr.w < 0) _fr.set(-_fr.x, -_fr.y, -_fr.z, -_fr.w);
  const length = _fd.copy(arm.boneLength[1]).normalize();
  turnAbout(arm.fore, A, PUNCH_TWIST_FORE * 2 * Math.atan2(_fr.x * length.x + _fr.y * length.y + _fr.z * length.z, _fr.w));
  arm.hand.quaternion.copy(arm.fore.getWorldQuaternion(_fp).invert().multiply(_fq));
  arm.hand.updateMatrixWorld(true);
  const side = _fa.copy(arm.side).applyQuaternion(arm.hand.getWorldQuaternion(_fp));
  arm.fingers.forEach((b, i) => { b.quaternion.copy(arm.fingerBind[i]); b.updateMatrixWorld(true); turnAbout(b, side, FIST_BEND[arm.joint[i]]); });
  arm.thumb.forEach((b, i) => { b.quaternion.slerpQuaternions(arm.thumbBind[i], arm.thumbRest[i], FIST_THUMB_CLOSE[i]); b.updateMatrixWorld(true); });
  turnAbout(arm.thumb[0], _fa.copy(arm.curl).applyQuaternion(arm.hand.getWorldQuaternion(_fp)), FIST_THUMB_LOWER);
}
// A punch (from tryFire): the next fist goes out; it lands PUNCH_HIT of the way in (see landPunch, from updateGun)
export function punch(now) {
  const arm = gun.fists[gun.nextFist ^= 1];
  arm.punchAt = now - PUNCH_LEAD;
  gun.punchLands = arm.punchAt + PUNCH_TIME * PUNCH_HIT;
  gun.dirty = true;
  shake.kick += KICK_PER_SHOT * 0.5;
}
const _pa = new THREE.Vector3(), _pt = new THREE.Vector3();
export function landPunch() {
  gun.punchLands = Infinity;
  const o = camera.position, aim = camera.getWorldDirection(_pa);
  let best = null, bestT = Infinity;
  for (const npc of npcs.concat(skulls)) { // (the living: punches don't land on the dead)
    const c = _pt.copy(npc.imp.model.position).add(npc.imp.fit).sub(o), r = npc.imp.r * 0.5;
    const t = c.dot(aim), d = c.length();
    if (t <= 0 || d - r > PUNCH_REACH || Math.acos(Math.min(t / d, 1)) > PUNCH_CONE + Math.atan2(r, d)) continue;
    if (d < bestT) { bestT = d; best = npc; }
  }
  if (!best) return;
  // where it lands: on the near side of its body, along the line from you to it
  const c = _pt.copy(best.imp.model.position).add(best.imp.fit), dir = c.clone().sub(o).normalize();
  const entry = c.clone().addScaledVector(dir, -best.imp.r * (best.demon ? 0.35 : 0.18)); // (a man's ~0.2-0.3 m deep, a demon's more)
  const hit = { entry, exit: entry.clone().addScaledVector(dir, 0.1), dir, npc: best };
  if (best.skull) hitSkull(best, entry, dir, PUNCH_DAMAGE); // (bone: no blood)
  else {
    paintWound(best, entry);
    for (let k = 0; k < PUNCH_DAMAGE; k++) damageNpc(best, dir);
    burstBlood(hit, FL_GOBS, 0.7);
    splashLens(entry);
    playSquelch(0.6, 0.8);
  }
  playSound('punch', 1, 0.08);
  shake.kick += KICK_PER_SHOT;
  shake.trauma = Math.max(shake.trauma, PUNCH_SHAKE);
  shake.hitPitch += PUNCH_JOLT; shake.hitYaw += PUNCH_JOLT * (Math.random() < 0.5 ? -0.6 : 0.6);
}
// The shotgun in the M4's place: the rifle's own meshes hidden (the arms stay), the shotgun on the rifle's joint so
// every clip carries it. Placed at the ready pose (the end of Draw): its trigger (its origin) on the rifle's trigger,
// facing where the eye looks (it's in metres, barrels along −Z, up +Y: see tools/super_shotgun.py). Returns its
// muzzle, between the two barrels' ends (SHOTGUN_MUZZLE, in its own space), and its hinge: its "Barrels" piece (the
// barrels and forend), whose origin is the hinge pin at the front of the action (see breakOpen).
const SHOTGUN_MUZZLE = [0, 0.064, -0.518], SHOTGUN_BARREL_X = 0.0145; // m; each barrel's centre is ± this in x
const SHOTGUN_BREECH = [0, 0.064, -0.05]; // (the barrels' back ends, between them)
const _sgP = new THREE.Vector3(), _sgQ = new THREE.Quaternion(), _sgS = new THREE.Vector3();
function holdShotgun(root, draw, mainJoint, shotgun) {
  const hinge = shotgun.getObjectByName('Barrels');
  root.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) o.visible = false; });
  draw.play();
  draw.time = draw.getClip().duration;
  draw.getMixer().update(0);
  root.updateMatrixWorld(true);
  const arm = { upper: root.getObjectByName('LeftArm_026'), fore: root.getObjectByName('LeftForeArm_027'), hand: root.getObjectByName('LeftHand_028') };
  root.getObjectByName('FPS_Camera_j_01').matrixWorld.decompose(_sgP, _sgQ, _sgS);
  new THREE.Box3().setFromObject(root.getObjectByName('Trigger_M4_D_0')).getCenter(_sgP);
  shotgun.matrix.compose(_sgP, _sgQ, _sgS.set(1, 1, 1)).premultiply(mainJoint.matrixWorld.clone().invert());
  shotgun.matrix.decompose(shotgun.position, shotgun.quaternion, shotgun.scale);
  mainJoint.add(shotgun);
  draw.stop();
  const muzzle = new THREE.Object3D();
  muzzle.position.fromArray(SHOTGUN_MUZZLE);
  shotgun.add(muzzle);
  shotgun.updateMatrixWorld(true);
  // the shoulder at the ready pose, against the eye (it stays put relative to your head while the arm moves)
  arm.rest = root.getObjectByName('FPS_Camera_j_01').worldToLocal(arm.upper.getWorldPosition(new THREE.Vector3()));
  arm.grip = hinge.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(arm.hand.getWorldQuaternion(new THREE.Quaternion())); // and the hand's turn
  // ...and how the hand sits on the forearm, and the forearm on the upper arm, relaxed (inverted: see twistOf)
  const wq = (b) => b.getWorldQuaternion(new THREE.Quaternion());
  arm.wristRest = wq(arm.hand).invert().multiply(wq(arm.fore));
  arm.elbowRest = wq(arm.fore).invert().multiply(wq(arm.upper));
  // the hand's own directions (in its bone's space): along it (wrist to knuckles), and its palm (the way the fingers
  // curl); the fingers close into a fist round the axis across them (side: see shotgunReload)
  const handQ = arm.hand.getWorldQuaternion(new THREE.Quaternion()).invert(), at = (name) => root.getObjectByName(name).getWorldPosition(new THREE.Vector3());
  const wrist = at('LeftHand_028'), along = at('LeftHandMiddle1_037').sub(wrist).normalize(), palm = at('LeftHandMiddle4_040').sub(wrist);
  // the elbow's hinge: across the plane of the arm's bend (in the upper arm's space)
  const S0 = at('LeftArm_026'), E0 = at('LeftForeArm_027');
  arm.elbowAxis = E0.clone().sub(S0).cross(wrist.clone().sub(E0)).normalize().applyQuaternion(wq(arm.upper).invert());
  palm.addScaledVector(along, -palm.dot(along)).normalize();
  along.applyQuaternion(handQ); palm.applyQuaternion(handQ);
  arm.side = along.clone().cross(palm); // (the fingers curl round it, towards the palm)
  arm.fingers = [];
  arm.hand.traverse((b) => { if (/^LeftHand(Index|Middle|Ring|Pinky)[123]_/.test(b.name)) arm.fingers.push(b); });
  arm.thumb = [1, 2, 3].map((j) => { let f = null; arm.hand.traverse((b) => { if (!f && new RegExp(`^LeftHandThumb${j}_`).test(b.name)) f = b; }); return f; });
  arm.gripRest = [...arm.fingers, ...arm.thumb].map((b) => b.quaternion.clone()); // (their grip on the forend, at the ready)
  // every bone shotgunReload changes, with the clip's pose for it and what shotgunReload last left it at (see clipPose)
  arm.kept = [arm.upper, arm.fore, arm.hand, ...arm.fingers, ...arm.thumb].map((bone) => ({
    bone, q: bone.quaternion.clone(), p: bone.position.clone(), outQ: new THREE.Quaternion(0, 0, 0, 0), outP: new THREE.Vector3(NaN, 0, 0),
  }));
  // the two shells in the chambers (seen only while it's open: see shotgunReload), rims at the group's origin
  const shells = new THREE.Group(), shell = shellModel();
  for (const x of [-SHOTGUN_BARREL_X, SHOTGUN_BARREL_X]) {
    const s = shell.clone();
    s.position.x = x;
    s.rotation.x = -Math.PI / 2; // along the barrels (−Z)
    shells.add(s);
  }
  shells.visible = false;
  hinge.add(shells);
  splitLeftArm(root);
  return { muzzle, hinge, shells, arm, ads: aimEye(root, draw, shotgun, SHOTGUN_SIGHT, SHOTGUN_ADS_EYE) };
}
// How far open it is through the reload clip (t: 0…1 of it), rad: tips open, held while the shells go in, snapped
// shut (speeding up, as if flung) by the gun's flick up (see SWING_UP)
const BREAK_ANGLE = 0.6, smooth = THREE.MathUtils.smoothstep;
const breakOpen = (t) => BREAK_ANGLE * Math.min(smooth(t, 0.08, 0.22), 1 - THREE.MathUtils.clamp((t - 0.8) / 0.04, 0, 1) ** 2);
// ...and that flick: the gun swung up this far (rad) round the right hand's grip, quickly, then settling back down
// onto the left hand
const SWING_UP = 0.35;
// The gun's kick on firing: thrown back this far (m) and its muzzle up this far (rad, round its grip) at POWER 1, at
// once, easing back with this time constant (s)
export let RECOIL_BACK = 0.07 * POWER, RECOIL_PITCH = 0.3 * POWER; // (see useWeapon)
export const RECOIL_TIME = 0.1;
// The gun and both arms are lowered this far (m) while it's open and being loaded, and brought back up by the flick
const RELOAD_LOWER = 0.05;
const SHELLS_SEATED = [0, SHOTGUN_BREECH[1] - 0.0271, SHOTGUN_BREECH[2] + 0.1049]; // rims on the breech face
// where the wrist goes when the arm's pulled out of view: back by the shoulder, left of and below the screen, in the
// eye's space (cm), so the punch comes forward from the lower left
const OFFSCREEN = [-40, -40, -8];
const FOREND_GRIP = [-0.064, -0.014, -0.045]; // the hand's grip on the forend, in the barrels' space (m: the clip's own)
// the fist round the shells' back ends: its middle this far behind their rims, the wrist this far behind that
const FIST_BEHIND_RIMS = 0.02, FIST_REACH = 0.07, FIST_CURL = 0.5; // m, m, rad more at each finger joint than the clip has
const ROLL_WAY = -1; // the forearm's roll: −1 is clockwise to knuckles up (seen along the forearm from behind), as a left hand turns
const WRIST_TWIST = 0.15; // the share of that roll at the wrist (the forearm takes the rest: see shotgunReload)
// the gun's so close to your eye in the clip that the fist would fill the view, so the view eases back this far (m)
const RELOAD_EYE_BACK = 0.1;
const _tw1 = new THREE.Quaternion(), _tw2 = new THREE.Quaternion(), _tw3 = new THREE.Quaternion(), _tw4 = new THREE.Quaternion();
const _twA = new THREE.Vector3();
// How far a joint is twisted round axis (world), from relaxed: the child bone's turn (child, world) on its parent's
// (parent, world), against how it sits relaxed (rest: the inverse of that); rad, −π…π
function twistOf(parent, child, rest, axis) {
  const e = _tw3.copy(parent).invert().multiply(child).multiply(rest);
  const a = _twA.copy(axis).applyQuaternion(_tw4.copy(parent).invert()); // (the axis in the parent's space)
  const angle = 2 * Math.atan2(e.x * a.x + e.y * a.y + e.z * a.z, e.w);
  return angle > Math.PI ? angle - 2 * Math.PI : angle < -Math.PI ? angle + 2 * Math.PI : angle;
}
const _rl = Array.from({ length: 6 }, () => new THREE.Vector3());
const _rf = new THREE.Quaternion(), _rg = new THREE.Quaternion();
// The shotgun's reload, layered over the M4's reload clip (t: 0…1 through it; 0 when not reloading). The clip still
// moves the gun and right arm (a tilt that shows you the breech); the left arm is all ours (reachArm). As in the latest
// Dooms:
//   on the forend, it rides the barrels down as they break open (the spent shells drop out)
//   it pulls right out of view, and there turns knuckles up, the new shells in its fist
//   it punches them in from there, straight into the chambers, speeding up until it lands, and rests there a moment
//   it pulls right out of view again, and there turns back palm up
//   the right arm flicks the gun up, snapping the barrels shut, and the gun comes down to rest on the left hand, back
//   up under the forend; the clip has it back from there
// (Turning only out of view, nothing is seen to twist.)
export function shotgunReload(t) {
  gun.hinge.rotation.x = -breakOpen(t); // −: muzzles down
  gun.hinge.updateWorldMatrix(true, false);
  const spent = gun.modes.shotgun; // (spent: fired since its shells last dropped; a reload begun again after a switch drops none)
  if (t > 0.2 && !gun.shellsOut) { gun.shellsOut = true; if (spent.spent) { spent.spent = false; dropShells(); } }
  const w = smooth(t, 0, 0.05) * (1 - smooth(t, 0.96, 0.998)); // how much the left arm is ours, not the clip's
  gun.eyeBack = RELOAD_EYE_BACK * smooth(t, 0.34, 0.42) * (1 - smooth(t, 0.7, 0.8)); // (eased while it's out of view)
  gun.handOver = t > 0.42 && t < 0.72; // drawn over the gun while it punches and rests there (see splitLeftArm)
  gun.flick = SWING_UP * smooth(t, 0.78, 0.83) * (1 - smooth(t, 0.85, 0.95));
  gun.lower = RELOAD_LOWER * smooth(t, 0.04, 0.2) * (1 - smooth(t, 0.78, 0.85));
  const sh = gun.shells;
  sh.visible = t > 0 && ((t < 0.2 && spent.spent) || t > 0.36); // the spent shells until they drop, then the new ones
  sh.position.fromArray(SHELLS_SEATED);
  if (w <= 0) return;
  const arm = gun.arm, hand = arm.hand, H = gun.hinge;
  const shoulder = gun.joint.localToWorld(_rl[0].copy(arm.rest));
  const off = gun.joint.localToWorld(_rl[1].fromArray(OFFSCREEN)), grip = H.localToWorld(_rl[2].fromArray(FOREND_GRIP));
  // the punch: from out of view, the fist's middle (FIST_REACH ahead of the wrist) into the chambers, just behind the
  // shells' rims; its line is aim
  const landed = H.localToWorld(_rl[3].fromArray(SHELLS_SEATED).setZ(SHELLS_SEATED[2] + FIST_BEHIND_RIMS));
  const aim = _rl[4].subVectors(landed, off).normalize();
  const punch = THREE.MathUtils.clamp((t - 0.42) / 0.14, 0, 1) ** 1.6; // (landing at 0.56, resting there until 0.68)
  const wrist = _rl[5].copy(landed).addScaledVector(aim, -FIST_REACH).sub(off).multiplyScalar(punch).add(off);
  if (t > 0.36 && punch < 1) { // the shells in the fist
    H.worldToLocal(sh.position.copy(wrist).addScaledVector(aim, FIST_REACH));
    sh.position.z -= FIST_BEHIND_RIMS;
  }
  // before it: from the forend out of view; after it: out of view again, and back to the forend
  if (t < 0.42) wrist.copy(grip).lerp(off, smooth(t, 0.22, 0.34));
  else wrist.lerp(off, smooth(t, 0.68, 0.77)).lerp(grip, smooth(t, 0.86, 0.95));
  // knuckles up (1) or palm up (0), turning only out of view; the fingers closed round the shells while it's a fist
  const fisted = smooth(t, 0.34, 0.42) * (1 - smooth(t, 0.75, 0.8)), closed = fisted;
  // the elbow: out to the left and down, but while it punches, behind the wrist on the punch's line (so the forearm
  // lies along it, and the fist punches straight)
  const punchElbow = smooth(t, 0.36, 0.42) * (1 - smooth(t, 0.68, 0.76));
  const elbowAt = gun.joint.localToWorld(_rl[3].set(-100, -100, 0)).lerp(_rl[1].copy(wrist).addScaledVector(aim, -0.3), punchElbow);
  reachArm(arm, wrist, shoulder, w, elbowAt);
  // The roll, round the forearm's length, from how the arm sits relaxed (the forend grip, palm up) by fisted's half
  // turn: the forearm first untwisted from however the clip's pose left it, then turned most of the way (a real forearm
  // turns along its whole length; this one is a single bone, so its turn shows where its skin meets the next bone's, at
  // the elbow, off the screen), the wrist the rest (WRIST_TWIST: more looked pinched). Set, not measured, so it's
  // smooth and always goes the way it's told.
  const along = hand.getWorldPosition(_rl[0]).sub(arm.fore.getWorldPosition(_rl[1])).normalize();
  const roll = ROLL_WAY * -Math.PI * fisted;
  const untwist = -twistOf(arm.upper.getWorldQuaternion(_tw2), arm.fore.getWorldQuaternion(_tw1), arm.elbowRest, along);
  turnAbout(arm.fore, along, w * (untwist + roll * (1 - WRIST_TWIST)));
  // the hand: on the forearm as it sits relaxed, turned the rest of the roll; exactly its forend grip while on it
  const q = _rf.setFromAxisAngle(along, roll * WRIST_TWIST).multiply(arm.fore.getWorldQuaternion(_tw1)).multiply(_tw3.copy(arm.wristRest).invert());
  q.slerp(H.getWorldQuaternion(_rg).multiply(arm.grip), Math.max(1 - smooth(t, 0.22, 0.3), smooth(t, 0.9, 0.95)));
  // (holding the forend, the barrels' turn adds a twist at the wrist too: most of that goes to the forearm as well)
  const atElbow = twistOf(arm.upper.getWorldQuaternion(_tw2), arm.fore.getWorldQuaternion(_tw1), arm.elbowRest, along);
  const atWrist = twistOf(arm.fore.getWorldQuaternion(_tw1), q, arm.wristRest, along);
  turnAbout(arm.fore, along, w * ((1 - WRIST_TWIST) * atWrist - WRIST_TWIST * atElbow));
  hand.quaternion.slerp(hand.parent.getWorldQuaternion(_rp).invert().multiply(q), w);
  // The fingers and thumb, which the clip moves about (its hand is busy with a magazine): on the forend (till it leaves
  // for the shells, and back on it at the end) held in their grip at the ready (the clip lifted the index finger, to a
  // magazine release); in the fist, held as they were when it first closed (the thumb swung out of it as it rested on the
  // breech, the fingers twitched under the curl), easing back to the clip's as it opens; the fingers curled into a fist
  // on top (each joint turned round the hand's side axis, which the turns leave where it is)
  const digits = [...arm.fingers, ...arm.thumb], onForend = Math.max(1 - smooth(t, 0.22, 0.3), smooth(t, 0.8, 0.88)); // (forming as it comes back)
  digits.forEach((b, i) => b.quaternion.slerp(arm.gripRest[i], onForend * w));
  if (closed <= 0) arm.held = null;
  else if (closed >= 0.999 && !arm.held) arm.held = digits.map((b) => b.quaternion.clone());
  if (arm.held) digits.forEach((b, i) => b.quaternion.slerp(arm.held[i], closed * w));
  const side = _rl[0].copy(arm.side).applyQuaternion(hand.getWorldQuaternion(_rg));
  for (const bone of arm.fingers) turnAbout(bone, side, FIST_CURL * closed * w);
  for (const bone of arm.thumb) bone.updateMatrixWorld(true);
}
// The bones shotgunReload changes, put back to the clip's pose before it changes them again. three's mixer writes a
// bone only when the clip's value for it changes: where the clip holds one still, the bone kept the last pose's changes
// and the next ones went on top. The fingers' curl went on again every pose (at full frame rate they spun round while
// the fist held, then snapped back when the clip moved them). A bone still exactly as shotgunReload left it wasn't
// written: back to the clip's value it had; otherwise the mixer's fresh value is the clip's.
export function clipPose(kept) {
  for (const k of kept) {
    if (k.bone.quaternion.equals(k.outQ)) k.bone.quaternion.copy(k.q); else k.q.copy(k.bone.quaternion);
    if (k.bone.position.equals(k.outP)) k.bone.position.copy(k.p); else k.p.copy(k.bone.position);
  }
}
export function keepPose(kept) { for (const k of kept) { k.outQ.copy(k.bone.quaternion); k.outP.copy(k.bone.position); } }
// Turns bone by angle (rad) round axis (world, through the bone's origin)
const _ta = new THREE.Quaternion(), _tp = new THREE.Quaternion();
function turnAbout(bone, axis, angle) {
  bone.parent.getWorldQuaternion(_tp);
  bone.quaternion.premultiply(_ta.setFromAxisAngle(axis, angle).premultiply(_tp.clone().invert()).multiply(_tp));
  bone.updateMatrixWorld(true);
}
// Two-bone reach: moves the shoulder (upper's origin) w of the way to shoulder, then turns the upper arm and forearm so
// the wrist (hand's origin) is w of the way from where the clip had it to target (all in world space), the elbow
// bent towards elbowAt
const _rS = new THREE.Vector3(), _rE = new THREE.Vector3(), _rW = new THREE.Vector3(), _rT = new THREE.Vector3(), _rA = new THREE.Vector3(), _rL = new THREE.Vector3();
const _rDir = new THREE.Vector3(), _rOut = new THREE.Vector3(), _rq = new THREE.Quaternion(), _rp = new THREE.Quaternion();
function reachArm({ upper, fore, hand, elbowAxis }, target, shoulder, w, elbowAt) {
  upper.parent.updateWorldMatrix(true, false);
  upper.position.lerp(upper.parent.worldToLocal(shoulder), w);
  upper.updateMatrixWorld(true);
  const S = upper.getWorldPosition(_rS), E = fore.getWorldPosition(_rE), W = hand.getWorldPosition(_rW);
  const a = S.distanceTo(E), b = E.distanceTo(W), T = _rT.copy(W).lerp(target, w);
  const dir = _rDir.subVectors(T, S), d = Math.min(dir.length(), (a + b) * 0.999);
  dir.normalize();
  const x = (a * a - b * b + d * d) / (2 * d), h = Math.sqrt(Math.max(a * a - x * x, 0));
  const out = _rOut.subVectors(elbowAt, S);
  out.addScaledVector(dir, -out.dot(dir)).normalize();
  turnBone(upper, E, _rOut.multiplyScalar(h).addScaledVector(dir, x).add(S)); // the elbow
  turnBone(fore, hand.getWorldPosition(_rW), _rT.copy(S).addScaledVector(dir, d)); // the wrist
  // The upper arm turned round its length (at the shoulder, off the screen) so the elbow bends the way it does at rest,
  // its hinge across the arm's bend, not twisted the way the clip's pose happened to leave it; then the wrist aimed
  // again. Without this, the hand has to twist back round the forearm, and the wrist pinches.
  const len = _rL.subVectors(fore.getWorldPosition(_rE), S).normalize();
  const bend = _rOut.copy(len).cross(_rW.subVectors(hand.getWorldPosition(_rW), _rE));
  if (bend.lengthSq() > 1e-8) {
    const hinge = _rE.copy(elbowAxis).applyQuaternion(upper.getWorldQuaternion(_rq));
    turnAbout(upper, len, w * Math.atan2(len.dot(_rA.crossVectors(hinge, bend)), hinge.dot(bend)));
    turnBone(fore, hand.getWorldPosition(_rW), _rT.copy(S).addScaledVector(dir, d));
  }
}
const _rO = new THREE.Vector3();
function turnBone(bone, from, to) { // turns bone about its origin so the world point from moves towards to (both changed)
  const o = bone.getWorldPosition(_rO);
  _rq.setFromUnitVectors(from.sub(o).normalize(), to.sub(o).normalize());
  bone.parent.getWorldQuaternion(_rp);
  bone.quaternion.premultiply(_rq.premultiply(_rp.clone().invert()).multiply(_rp)); // the world turn, in the parent's space
  bone.updateMatrixWorld(true);
}
// The left arm as meshes of their own (its triangles split off the arms' meshes, on the same skeleton), drawn after
// everything else in the gun's world. While it loads the shells (gun.handOver) the depth is cleared first, so the hand
// is drawn over the gun: right by the breech, any pose that keeps it clear of the gun covers the chambers.
function splitLeftArm(root) {
  const arms = [], left = [];
  root.traverse((o) => { if (o.isSkinnedMesh) arms.push(o); });
  for (const mesh of arms) {
    const g = mesh.geometry, bones = mesh.skeleton.bones, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, idx = g.index.array;
    const isLeft = (v) => { // its strongest bone is one of the left arm's
      let k = 0;
      for (let c = 1; c < 4; c++) if (sw.getComponent(v, c) > sw.getComponent(v, k)) k = c;
      return bones[si.getComponent(v, k)].name.startsWith('Left');
    };
    const mine = [], rest = [];
    for (let i = 0; i < idx.length; i += 3) (isLeft(idx[i]) ? mine : rest).push(idx[i], idx[i + 1], idx[i + 2]);
    const lg = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(g.attributes)) lg.setAttribute(name, a);
    lg.setIndex(mine);
    g.setIndex(rest);
    const m = new THREE.SkinnedMesh(lg, mesh.material);
    m.bind(mesh.skeleton, mesh.bindMatrix);
    m.frustumCulled = false;
    m.renderOrder = 1 + left.length;
    mesh.parent.add(m);
    left.push(m);
  }
  left[0].onBeforeRender = (r) => { if (gun.handOver) r.clearDepth(); };
}
// Once it's open, the two spent shells drop out of the breech (as casings: see dropCasing), to land at your feet
const _brP = new THREE.Vector3(), _brV = new THREE.Vector3();
function dropShells() {
  gun.root.updateMatrixWorld(true);
  camera.getWorldDirection(_cf);
  for (const x of [-SHOTGUN_BARREL_X, SHOTGUN_BARREL_X]) {
    _brP.set(x, SHOTGUN_BREECH[1], SHOTGUN_BREECH[2]).sub(gun.hinge.position); // (in the hinge's space)
    gun.hinge.localToWorld(_brP).applyMatrix4(gunCam.matrixWorldInverse).applyMatrix4(camera.matrixWorld); // gun → view → world
    _brV.copy(_cf).multiplyScalar(-0.2).add(camera.up).addScaledVector(_cf.clone().cross(camera.up), x * 30 * Math.random());
    dropCasing(_brP, _brV, 'shell');
  }
}
export function setupGun(g, models) { // models: the pistol's and the shotgun's scenes
  // The pack's clips are slices of one long timeline (Fire's keys sit at 7.5–8.3 s); move each to start at 0
  for (const clip of g.animations) {
    const start = Math.min(...clip.tracks.map((t) => t.times[0]));
    clip.tracks.forEach((t) => t.shift(-start));
    clip.resetDuration();
  }
  const root = g.scene;
  // Skinned meshes get their culling sphere from the pose they're first drawn in. Draw starts with the
  // arms below the screen, so the gloves were culled for good afterwards. The weapon is always in view.
  root.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
  gunScene.add(root);
  root.updateMatrixWorld(true);
  // No muzzle bone: take the front-most vertices of the rifle body as the barrel tip
  const main = root.getObjectByName('Main_M4_D_0'), mainJoint = root.getObjectByName('Main_j_049');
  const pos = main.geometry.attributes.position, v = new THREE.Vector3(), tip = new THREE.Vector3();
  let maxZ = -Infinity, n = 0;
  for (let i = 0; i < pos.count; i++) maxZ = Math.max(maxZ, v.fromBufferAttribute(pos, i).applyMatrix4(main.matrixWorld).z);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(main.matrixWorld);
    if (v.z > maxZ - 0.01) { tip.add(v); n++; }
  }
  let muzzle = new THREE.Object3D();
  mainJoint.add(muzzle);
  muzzle.position.copy(mainJoint.worldToLocal(tip.divideScalar(n)));

  const mixer = new THREE.AnimationMixer(root);
  const actions = Object.fromEntries(g.animations.map((c) => {
    const a = mixer.clipAction(c);
    a.setLoop(THREE.LoopOnce);
    a.clampWhenFinished = true; // every clip ends in the ready pose, so holding the last frame = idle
    return [c.name, a];
  }));
  // Every weapon set up on the one rig, each one's parts kept apart (modes: what useWeapon swaps in), each from the rig
  // as it comes (pristine: every bone's place, turn and size), which a weapon is put back to when it's taken up
  const pristine = [];
  root.traverse((o) => { if (o.isBone) pristine.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });
  const restore = () => { for (const [b, p, q, sc] of pristine) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(sc); } };
  const meshesOf = (o) => { const m = []; o.traverse((c) => { if (c.isMesh && !c.isSkinnedMesh) m.push(c); }); return m; };
  const leftArm = root.getObjectByName('LeftArm_026'); // (hidden, for the pistol: see PISTOL_VIEW; and fists: see holdFists)
  const modes = { m4: { muzzle, meshes: meshesOf(root), ads: aimEye(root, actions.Draw, main, M4_SIGHT, M4_ADS_EYE) } };
  modes.shotgun = { ...holdShotgun(root, actions.Draw, mainJoint, models.shotgun), meshes: meshesOf(models.shotgun) };
  restore();
  modes.pistol = { ...holdPistol(root, actions.Draw, mainJoint, models.pistol), meshes: meshesOf(models.pistol), offArm: leftArm };
  restore();
  modes.fists = { fists: holdFists(root, actions.Draw), meshes: [], offArm: leftArm };
  restore();
  gun = {
    root, mixer, actions, modes, pristine, ammoOf: {}, joint: root.getObjectByName('FPS_Camera_j_01'), nextFist: 1, posedAt: 0,
    animAcc: 1 / opts.animFps, lastLights: -1, flashVariant: 0, flashMirror: false, flashFrame: -1,
  };
  mixer.addEventListener('finished', (e) => {
    if (e.action === actions.Reload || e.action === actions.Reload_Empty) gun.ammo = MAG;
    if (e.action !== actions.Fire) gun.busy = false;
    updateAmmo();
  });
  for (const m of Object.values(modes)) for (const o of m.meshes) o.visible = true; // (blood masks are made for what's shown)
  gun.blood = addGunBlood(root);
  gun.splashes = []; // demon blood to paint on it (see splashGun)
  sizeGun();
  useWeapon(WEAPON);
}
// Takes up a weapon (see WEAPONS): its numbers in place; the rig put back as it came (nothing of the last one's pose
// carries over: fists' curled fingers, the pistol's hidden arm, the shotgun's reloading arm), only its parts shown,
// at rest; its own ammo (as it was left); then drawn
export function useWeapon(name) {
  const w = WEAPONS[name], m = gun.modes[name];
  gun.ammoOf[WEAPON] = gun.ammo;
  WEAPON = name; SHOTGUN = name === 'shotgun'; PISTOL = name === 'pistol'; FISTS = name === 'fists';
  ({ mag: MAG, interval: FIRE_INTERVAL, pellets: PELLETS, spread: SPREAD, power: POWER, splat: SPLAT_SCALE, reload: RELOAD_SPEED } = w);
  RECOIL_BACK = 0.07 * POWER; RECOIL_PITCH = 0.3 * POWER; KICK_PER_SHOT = 0.04 * POWER; TRAUMA_PER_SHOT = POWER;
  muzzleSprite.scale.setScalar(w.flash);
  gunMirrorQuad.visible = FISTS;
  mouse.trigger = false;
  if (ADS_TOGGLE) mouse.aimHeld = false; // (a new weapon comes up at the hip)
  aimT = 0; // (at once, as everything else in a switch: easing out, the new one was drawn zoomed, the old one's sights)
  for (const [b, p, q, sc] of gun.pristine) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(sc); }
  for (const [k, mode] of Object.entries(gun.modes)) for (const o of mode.meshes) o.visible = k === name;
  Object.assign(gun, {
    muzzle: m.muzzle ?? gun.modes.m4.muzzle, hinge: m.hinge ?? null, shells: m.shells ?? null, arm: m.arm ?? null,
    slide: m.slide ?? null, offArm: m.offArm ?? null, fists: m.fists ?? null, ammo: gun.ammoOf[name] ?? MAG, busy: true,
    adsAt: m.ads ?? null, adsDot: !!m.adsDot,
    cooldown: 0, firedAt: -Infinity, flashUntil: 0, punchLands: Infinity, handOver: false, eyeBack: 0, lower: 0, flick: 0,
    shellsOut: false, dirty: true, animAcc: 1 / opts.animFps, // (posed at once: else the rig's rest pose showed a moment)
  });
  gun.reloadSound?.stop(); // (the last one's reload, if it was mid-way)
  if (gun.hinge) gun.hinge.rotation.x = 0; // (shut)
  if (gun.shells) gun.shells.visible = false;
  if (gun.slide) gun.slide.position.z = 0;
  for (const f of gun.fists ?? []) f.punchAt = -Infinity;
  gun.actions.Reload.timeScale = gun.actions.Reload_Empty.timeScale = RELOAD_SPEED;
  playGun('Draw');
  updateAmmo();
}

export function playGun(name) {
  // Hard cut: all clips start from the ready pose, and stopping the rest keeps clamped clips from blending in
  for (const a of Object.values(gun.actions)) if (a !== gun.actions[name]) a.stop();
  gun.actions[name].reset().play();
}

// Camera shake on firing: a recoil kick (each shot snaps the view up a little, springing back) plus trauma
// shake (each shot adds trauma, which decays; the shake is proportional to it, and one shot adds most of the
// way to full, so it rattles hard from the first shot and a sustained burst only tops it up a little), on smooth
// noise so it rattles rather than jitters. Applied to the
// camera only for the render and undone straight after, so the mouse look never inherits it.
export let KICK_PER_SHOT = 0.04 * POWER, TRAUMA_PER_SHOT = POWER; // (see useWeapon)
export const KICK_RETURN = 14, HIT_KICK = 0.05, HIT_KICK_RETURN = 9; // rad; 1/s: being shot                       // rad, 1/s spring back
const TRAUMA_DECAY = 2.2, SHAKE_ANGLE = 0.018; // (trauma 0..1) per s, rad at full trauma
export const shake = { kick: 0, trauma: 0, hitYaw: 0, hitPitch: 0 }; // hit…: a jolt from being shot (see demonShot). (An object:
// your shots and the ones at you add to it from other files too: see mouse)
export const _shakeE = new THREE.Euler(0, 0, 0, 'YXZ'), _shakeQ = new THREE.Quaternion(), _camQ = new THREE.Quaternion();
const wobble = (t, seed) => 0.6 * Math.sin(t * 37 + seed) + 0.4 * Math.sin(t * 61 + seed * 2.3); // smooth, ~-1..1
export function shakeCamera(dt, now) { // returns false when there's nothing to apply
  shake.kick *= Math.exp(-KICK_RETURN * dt);
  const back = Math.exp(-HIT_KICK_RETURN * dt);
  shake.hitYaw *= back; shake.hitPitch *= back;
  shake.trauma = Math.max(shake.trauma - TRAUMA_DECAY * dt, 0);
  const s = SHAKE_ANGLE * shake.trauma;
  if (shake.kick < 1e-5 && s < 1e-5 && Math.abs(shake.hitYaw) + Math.abs(shake.hitPitch) < 1e-5) return false;
  _camQ.copy(camera.quaternion);
  _shakeE.set(shake.kick + shake.hitPitch + s * wobble(now, 1), shake.hitYaw + s * wobble(now, 2), 0.5 * s * wobble(now, 3)); // pitch (up), yaw, roll
  camera.quaternion.multiply(_shakeQ.setFromEuler(_shakeE));
  camera.updateMatrixWorld();
  return true;
}

