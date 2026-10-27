// The camera, and what's done to its picture: the composer, bloom, depth of field (and being hurt), the world's
// resolution, the portals' lensing, the last pass; the look controls and the click to play; the sprites' options (opts)
import { stripLights, spotLights } from './lights.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { EYE_HEIGHT, RT_SIZES, renderer, FRAME_MS, WORLD_SCALES, SCALE_WINDOW, SLOW, UP_WAIT, UP_WAIT_MAX, PROBE,
  SCALE_SETTLE, fixedScale, scene, sun, stage, flashes, portalLights } from './setup.js';
import { PLATFORM_H } from './arena.js';
import { mouse, aim } from './weapons.js';
import { audio, music } from './audio.js';
import { dofOn } from './input.js';

// First-person camera: click to capture the mouse
export const VIEW_FOV = 70; // ° (narrower while aiming: see ADS_FOV)
export const camera = new THREE.PerspectiveCamera(VIEW_FOV, innerWidth / innerHeight, 0.1, 200);
camera.layers.enable(1); // (a skull's fire: see SpriteImpostor's cam)
camera.position.set(0, EYE_HEIGHT + PLATFORM_H, 0); // on the centre platform, on its X, facing −z (your feet too: see jumpY)

// Post: the world renders into an HDR buffer, everything bleeds a glow in proportion to its brightness (so only the
// emissive strips and hot metal glints show one), then OutputPass applies the renderer's ACES tone mapping and sRGB.
// No MSAA on the HDR buffer: an off-screen half-float MSAA resolve cost about as much as the whole scene, and
// hard edges suit the pixel art. Bloom runs at the world's resolution (see worldScale).
// No threshold (it was 2.5): a threshold blooms a pixel fully or not at all, so a thin lamp seen at an angle (its
// pixels' coverage rising and falling along it) bloomed only at its brightest pixels: a row of separate blobs. With
// none, the glow follows the light smoothly; the strength is low to keep the dim room from hazing (0.25 hazed it).
const BLOOM_STRENGTH = 0.15, BLOOM_RADIUS = 0.4, BLOOM_THRESHOLD = 0;
export let worldStep = 0, worldScale = fixedScale || WORLD_SCALES[0]; // the world's resolution (see scaleWorld)
export const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType,
}));
sizeWorld();
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
composer.addPass(new RenderPass(scene, camera));

// Depth of field, gameplay style: no refocusing, just distance. Everything nearer than DOF_SHARP m is sharp; past it
// the blur ramps up to DOF_MAX (a fraction of the screen's height) by DOF_SOFT m, so the far arena goes soft and
// whatever you're fighting stays crisp. A gather over a golden-angle disc of DOF_TAPS samples, each counted only where its own blur reaches
// this pixel, so a sharp thing doesn't smear into the blur round it. Reads the scene's depth: the composer's targets
// carry a depth texture. Before bloom, so blurred lights bloom wider. The gun is drawn after it all, always sharp.
const DOF_SHARP = 12, DOF_SOFT = 30, DOF_MAX = 0.004, DOF_TAPS = 24; // m; m; of the screen height; samples
// Aiming down the sights (see OPTIC), it's a lens instead, and an aggressive one: focused on what's drawn under the
// crosshair (the scene's depth at the screen's middle; refocusing as that changes, over DOF_FOCUS_TIME s, eased in
// dioptres, 1/m, as a lens's focus ring turns: see focusQuad), everything nearer or further blurred by how far off
// that it is in dioptres, DOF_ADS_APERTURE of the screen's height a dioptre, up to DOF_ADS_MAX (a real lens: focused
// near, the far wall's a blur; focused far, the near's, its blur spreading over the sharp things behind it)
const DOF_ADS_APERTURE = 0.12, DOF_ADS_MAX = 0.02, DOF_FOCUS_TIME = 0.15; // of the screen height a dioptre; of it; s
const DOF_NEAR_TAPS = 16; // samples for the near blur spreading over what's behind it (see DofPass)
// Hurt: when you're hit the whole scene goes out of focus, near and far, and comes back over HURT_RECOVER s; hits
// stack. The same pass, its blur raised everywhere to HURT_BLUR (of the screen height) × the hurt, eased.
const HURT_BLUR = 0.02, HURT_PER_HIT = 0.7, HURT_RECOVER = 1.0; // of the screen height; per hit (of 1); s
let hurt = 0;
// The world's targets sized to the window at worldScale (on a resize or a scale step), each with a depth texture
// (depth of field reads it) at its size. three r170's setSize doesn't resize a depth texture: the old one would stay
// at the old size (an incomplete framebuffer: nothing drawn), so a new one. setSize let go of the target when its size
// changed, so the new one gets attached when it's next set up.
export function sizeWorld() {
  composer.setPixelRatio(worldScale);
  composer.setSize(innerWidth, innerHeight);
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
    if (rt.depthTexture?.image.width === rt.width && rt.depthTexture.image.height === rt.height) continue;
    rt.depthTexture?.dispose();
    rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height);
  }
}
const frameGaps = []; // ms between frames, this window
let windowStart = 0, onTimeFor = 0, upWait = UP_WAIT, probeUntil = 0;
export function scaleWorld(time, gap) { // each frame (time: its rAF time, ms; gap: since the last, ms)
  if (fixedScale || time < SCALE_SETTLE * 1000) return;
  if (gap < 1000) frameGaps.push(gap); // (longer: the tab was hidden; a one-off hitch the median shrugs off)
  if (time - windowStart < SCALE_WINDOW * 1000) return;
  windowStart = time;
  if (!frameGaps.length) return;
  frameGaps.sort((a, b) => a - b);
  const slow = frameGaps[frameGaps.length >> 1] > SLOW * FRAME_MS;
  frameGaps.length = 0;
  if (slow) {
    if (probeUntil) upWait = Math.min(upWait * 2, UP_WAIT_MAX); // the step up didn't hold
    onTimeFor = probeUntil = 0;
    if (worldStep < WORLD_SCALES.length - 1) setWorldStep(worldStep + 1);
  } else {
    if (probeUntil && time >= probeUntil) { upWait = UP_WAIT; probeUntil = 0; } // it held
    if ((onTimeFor += SCALE_WINDOW) >= upWait && worldStep > 0) {
      setWorldStep(worldStep - 1);
      probeUntil = time + PROBE * 1000;
      onTimeFor = 0;
    }
  }
}
function setWorldStep(k) { worldStep = k; worldScale = WORLD_SCALES[k]; sizeWorld(); }
// Aiming's focus (see DOF_ADS_APERTURE), kept on the GPU, where the depth is: each frame it's aiming, one pixel eases
// the last focus (in a 1×1 target; two, in turn) towards the depth at the screen's middle, in dioptres
const focusRTs = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
const focusQuad = new FullScreenQuad(new THREE.ShaderMaterial({
  uniforms: { tDepth: { value: null }, tLast: { value: null }, uNear: { value: camera.near }, uFar: { value: camera.far }, uKeep: { value: 0 } },
  vertexShader: `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    #include <packing>
    uniform sampler2D tDepth, tLast;
    uniform float uNear, uFar, uKeep;
    void main() {
      float z = -perspectiveDepthToViewZ(texture2D(tDepth, vec2(0.5)).x, uNear, uFar);
      gl_FragColor = vec4(mix(1.0 / max(z, 0.3), texture2D(tLast, vec2(0.5)).x, uKeep), 0.0, 0.0, 1.0);
    }`,
}));
let focusAt = 0; // which of focusRTs holds the focus
class DofPass extends ShaderPass {
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    this.uniforms.uRes.value.set(readBuffer.width, readBuffer.height);
    if (this.uniforms.uAim.value > 0) { // refocus (see focusQuad)
      const u = focusQuad.material.uniforms;
      u.tDepth.value = readBuffer.depthTexture;
      u.tLast.value = focusRTs[focusAt].texture;
      u.uKeep.value = Math.exp(-deltaTime / DOF_FOCUS_TIME);
      renderer.setRenderTarget(focusRTs[focusAt ^= 1]);
      focusQuad.render(renderer);
    }
    this.uniforms.tFocus.value = focusRTs[focusAt].texture;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}
const dof = new DofPass({
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
    uNear: { value: camera.near }, uFar: { value: camera.far }, uDof: { value: 1 }, uHurt: { value: 0 },
    uAim: { value: 0 }, tFocus: { value: null },
  },
  vertexShader: `varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    #include <packing>
    uniform sampler2D tDiffuse, tDepth, tFocus;
    uniform vec2 uRes;
    uniform float uNear, uFar, uDof, uHurt, uAim;
    varying vec2 vUv;
    float focus; // aiming's, in dioptres (see focusQuad)
    float viewDepth(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar); }
    float coc(float z) { // px: the distance blur (giving way to aiming's lens), the lens, or the hurt's (all over): the most
      float far = uDof * (1.0 - uAim) * smoothstep(${DOF_SHARP.toFixed(1)}, ${DOF_SOFT.toFixed(1)}, z) * ${DOF_MAX};
      float lens = uAim * min(${DOF_ADS_APERTURE} * abs(focus - 1.0 / z), ${DOF_ADS_MAX});
      return max(max(far, lens), uHurt * ${HURT_BLUR}) * uRes.y;
    }
    void main() {
      focus = texture2D(tFocus, vec2(0.5)).x;
      vec4 base = texture2D(tDiffuse, vUv);
      float z0 = viewDepth(vUv), c0 = coc(z0);
      vec3 col = base.rgb;
      // alpha: how sharp it is (1: in focus, 0: blurred), for the upscale to the screen (crisp, or smooth: see OutputPass)
      float sharp = 1.0 - smoothstep(0.5, 1.5, c0);
      // Its own blur: a disc its own size, each sample counted where its own blur reaches this pixel (so a sharp thing
      // doesn't smear into the blur round it)
      if (c0 >= 0.5) {
        vec3 sum = base.rgb;
        float wsum = 1.0;
        for (int i = 0; i < ${DOF_TAPS}; i++) {
          float fi = float(i) + 0.5, r = sqrt(fi / ${DOF_TAPS}.0) * c0, a = fi * 2.39996;
          vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uRes;
          float w = clamp(coc(viewDepth(uv)) - r + 1.0, 0.0, 1.0);
          sum += texture2D(tDiffuse, uv).rgb * w;
          wsum += w;
        }
        col = sum / wsum;
      }
      // Aiming, a blurred thing nearer spreads over what's behind it, as a lens's near blur does, out to the lens's
      // most: each sample a share of this pixel, the nearer thing's colour where its blur reaches here, this pixel's
      // own where not (so the spread fades out from the edge)
      float reach = uAim * ${DOF_ADS_MAX} * uRes.y;
      if (reach >= 0.5) {
        vec3 near = vec3(0.0);
        float cover = 0.0;
        for (int i = 0; i < ${DOF_NEAR_TAPS}; i++) {
          float fi = float(i) + 0.5, r = sqrt(fi / ${DOF_NEAR_TAPS}.0) * reach, a = fi * 2.39996 + 1.0;
          vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uRes;
          float zt = viewDepth(uv);
          if (zt >= z0) continue;
          float w = clamp(coc(zt) - r + 1.0, 0.0, 1.0);
          near += texture2D(tDiffuse, uv).rgb * w;
          cover += w;
        }
        if (cover > 0.0) {
          float share = cover / ${DOF_NEAR_TAPS}.0;
          col = mix(col, near / cover, share);
          sharp *= 1.0 - clamp(share * 4.0, 0.0, 1.0); // (blurred over: not sharp)
        }
      }
      gl_FragColor = vec4(col, sharp);
    }`,
});
composer.addPass(dof);
export const hurtFocus = () => (hurt = Math.min(hurt + HURT_PER_HIT, 1)); // you're hit (see hudHit)
// Each frame: back into focus; the pass runs while the distance blur's wanted (dofOn: the F key's) or you're hurt
export function updateDof(dt) {
  hurt = Math.max(hurt - dt / HURT_RECOVER, 0); // back into focus
  dof.uniforms.uHurt.value = hurt * hurt; // eased: clears fast at first, the last of it lingers less
  dof.uniforms.uDof.value = dofOn ? 1 : 0;
  dof.uniforms.uAim.value = dofOn ? aim : 0;
  dof.enabled = dofOn || hurt > 0;
}
// Lensing (see Portals): where an enemy's just come through, a sphere of denser air bursts out round it (its refractive
// index up from air's to PORTAL_LENS_INDEX and back): the world behind it seen through it, each pixel's view bent in
// going into the sphere and again coming out (by 2·(asin ρ − asin(ρ/n)) towards its middle, ρ how far out from its
// middle it passes, n its index over air's: next to nothing in its middle, steeply more towards its rim), and carried
// on as far as what's seen there lies behind its middle (the world's depth). Only what's behind its middle is bent:
// what's come through, and anything nearer, is left be, and a bent view landing on them shows what's behind instead.
// And before that, while a portal's point hangs there: waves of bent space round it (uWaveA, uWaveB), crests laid out
// in rings round the point and running in to it at a steady pace, each dragged inwards as a brush stroke drags paint:
// strokes from every crest in towards the point (PORTAL_WAVE_STREAKS round it, each crest its own, each its own length:
// some a short way in, many all the way), a pixel on one showing what's at its crest and beyond it (the world there
// mirrored at the crest, in to the point); a stroke from further out over the ones from nearer in. The point's core
// left be (its light), dying away to their reach. LENSES of each at once at most; off when there
// are none
export const LENSES = 12; // (every portal of a wave, coming through at once)
const PORTAL_WAVE_STREAKS = 48, PORTAL_WAVE_BEND = 2; // a portal's waves: the strokes round each crest (see lensPass); how
// hard they bend (1: just the crest's world, smeared in; 2: mirrored at the crest, at its own size; more: squeezed in
// from further out)
// (drawn into its own target and copied back: the world's depth is in the composer's other target, the one a pass
// would draw into next, and a target can't be read while it's drawn into)
class LensPass extends ShaderPass {
  constructor(shader) {
    super(shader);
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.copy = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: this.target.texture } }, depthTest: false, depthWrite: false,
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`,
    }));
  }
  setSize(w, h) { this.target.setSize(w, h); }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // the world's depth: in the target it was drawn into (the depth of field drew into the other, if it ran)
    this.uniforms.tDepth.value = (dof.enabled ? writeBuffer : readBuffer).depthTexture;
    super.render(renderer, this.target, readBuffer, deltaTime, maskActive);
    renderer.setRenderTarget(readBuffer);
    this.copy.render(renderer);
  }
}
export const lensPass = new LensPass({
  uniforms: { tDiffuse: { value: null }, tDepth: { value: null }, uLens: { value: Array.from({ length: LENSES }, () => new THREE.Vector4()) },
    uDepth: { value: new Array(LENSES).fill(0) }, uAspect: { value: 1 }, uTan: { value: 1 },
    uWaveA: { value: Array.from({ length: LENSES }, () => new THREE.Vector4()) }, uWaveB: { value: Array.from({ length: LENSES }, () => new THREE.Vector4()) },
    uNear: { value: camera.near }, uFar: { value: camera.far } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform vec4 uLens[${LENSES}]; // x, y: its middle (0..1); z: its radius (screen heights); w: its index over air's (1, or 0: none)
    uniform float uDepth[${LENSES}]; // its middle's depth in your view (m)
    uniform float uAspect, uNear, uFar, uTan; // uTan: screen heights' worth of m, a m away (2 tan(fov / 2))
    uniform vec4 uWaveA[${LENSES}]; // a portal's waves: x, y: its point (0..1); z: their reach (screen heights); w: how strong (0..1; 0: none)
    uniform vec4 uWaveB[${LENSES}]; // x: their wavelength (screen heights); y: how many have run in; z: its strokes' seed; w: the point's depth (m)
    varying vec2 vUv;
    float depthAt(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar); } // (m, in your view)
    vec2 fold(vec2 uv) { return 1.0 - abs(1.0 - abs(uv)); } // (folded back at the screen's edge: a lens just off it pulled
    // what's past the edge in, and the target held that to its edge pixels, a smear)
    float hash(float x) { return fract(sin(x * 127.1) * 43758.5453); }
    float strokes(float x, float k) { // value noise round a circle (x: 0..1 round it), PORTAL_WAVE_STREAKS cells (crest k's own)
      x *= ${PORTAL_WAVE_STREAKS}.0;
      float i = floor(x), f = fract(x), o = ${PORTAL_WAVE_STREAKS}.0 * k;
      return mix(hash(mod(i, ${PORTAL_WAVE_STREAKS}.0) + o), hash(mod(i + 1.0, ${PORTAL_WAVE_STREAKS}.0) + o), f * f * (3.0 - 2.0 * f));
    }
    void main() {
      vec2 uv = vUv;
      float nearest = 1e9, z = depthAt(vUv);
      for (int i = 0; i < ${LENSES}; i++) { // the waves
        vec4 a = uWaveA[i], b = uWaveB[i];
        if (a.w <= 0.0) continue;
        vec2 d = (vUv - a.xy) * vec2(uAspect, 1.0);
        float r = length(d), behind = smoothstep(b.w + 0.3, b.w + 1.5, z);
        if (r >= a.z || r < 1e-5 || behind <= 0.0) continue;
        float round01 = atan(d.y, d.x) / 6.2831853 + 0.5 + b.z, first = floor(r / b.x + b.y) + 1.0, push = 0.0;
        for (int j = 0; j < 8; j++) { // the crests outside it, from the nearest out (crest k where r / λ + run is k, so
          // running in as the run grows; r / λ − run, they ran out)
          float k = first + float(j), crest = (k - b.y) * b.x; // (screen heights out)
          if (crest >= a.z) break;
          float reach = mix(0.25, 1.4, strokes(round01, k)), in01 = 1.0 - r / crest; // (how far in its stroke goes here, of
          // the way to the point: past 1, all the way; how far in this is)
          float on = (1.0 - smoothstep(0.7 * reach, reach, in01)) * (1.0 - smoothstep(0.55 * a.z, a.z, crest)); // (faint out
          // at their reach)
          push = mix(push, (crest - r) * ${PORTAL_WAVE_BEND.toFixed(1)}, on); // (showing what's at its crest, and beyond: over
          // the strokes from nearer in)
        }
        vec2 o = d / r * push * a.w * smoothstep(0.35 * b.x, 0.6 * b.x, r) * behind / vec2(uAspect, 1.0); // (the point's
        // core left be, its light: the strokes fading out 0.35 to 0.2 m from it, their samples always further out)
        vec2 q = vUv + o; // (and none from past the screen's edge: folded back, a stroke there would show the point again)
        uv += o * (1.0 - smoothstep(0.0, 0.05, max(max(-q.x, q.x - 1.0), max(-q.y, q.y - 1.0))));
        nearest = min(nearest, b.w);
      }
      for (int i = 0; i < ${LENSES}; i++) { // the spheres
        vec4 l = uLens[i];
        if (l.w <= 1.0) continue;
        vec2 d = (vUv - l.xy) * vec2(uAspect, 1.0); // out from its middle (screen heights)
        float r = length(d), rho = r / l.z;
        float behind = smoothstep(uDepth[i] + 0.3, uDepth[i] + 1.5, z); // (behind its middle: bent; it, and what's nearer, not)
        if (rho >= 1.0 || r < 1e-5 || behind <= 0.0) continue;
        float bent = 2.0 * (asin(rho) - asin(rho / l.w)); // (radians, towards its middle: in, and out again)
        uv -= d / r * bent * (z - uDepth[i]) / (uTan * z) * behind / vec2(uAspect, 1.0); // (carried as far as what's seen is
        // behind its middle; m there, as screen heights)
        nearest = min(nearest, uDepth[i]);
      }
      vec2 at = fold(uv);
      float keep = nearest < 1e8 ? smoothstep(nearest + 0.3, nearest + 1.5, depthAt(at)) : 1.0; // (landing on what's come
      // through, or nearer: not that)
      gl_FragColor = keep < 1.0 ? mix(texture2D(tDiffuse, vUv), texture2D(tDiffuse, at), keep) : texture2D(tDiffuse, at);
    }`,
});
lensPass.enabled = false;
composer.addPass(lensPass);

composer.addPass(bloom);
// the glow isn't blended into the world's pixels (the blocky upscale would cut its soft falloff into steps): the output
// pass adds it at the screen's, smooth, from bloom's own (composited) target
bloom.blendMaterial.visible = false;
// the finished HDR scene (bloomed, before tone mapping), kept for the blood on the lens to see through (see hudFx)
export let sceneTex = null;
composer.addPass(new (class extends OutputPass {
  // The world's pixels scaled up to the canvas: crisp where it's sharp (each read from its texel's middle: blocks), smooth
  // where depth of field blurred it (its alpha: see DofPass), so a blur's falloff isn't cut into steps; and the bloom's
  // glow added, smooth, at the canvas's pixels
  constructor() {
    super();
    this.uniforms.uSrcRes = { value: new THREE.Vector2() };
    this.uniforms.tBloom = { value: bloom.renderTargetsHorizontal[0].texture };
    this.material.fragmentShader = this.material.fragmentShader
      .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse, tBloom;\nuniform vec2 uSrcRes;')
      .replace('gl_FragColor = texture2D( tDiffuse, vUv );', `
        vec4 crisp = texture2D( tDiffuse, (floor(vUv * uSrcRes) + 0.5) / uSrcRes ), soft = texture2D( tDiffuse, vUv );
        gl_FragColor = vec4(mix(soft.rgb, crisp.rgb, crisp.a) + texture2D( tBloom, vUv ).rgb, 1.0);`);
  }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    sceneTex = readBuffer.texture;
    this.uniforms.uSrcRes.value.set(readBuffer.width, readBuffer.height);
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
})());
export const look = new PointerLockControls(camera, renderer.domElement);
renderer.domElement.addEventListener('click', () => { if (!look.isLocked) look.lock(); audio.resume(); music.play().catch(() => {}); }); // (browsers start audio on a click)
export const firstClick = new Promise((go) => renderer.domElement.addEventListener('click', go, { once: true })); // (the enemies come in then)
// Playing: just the crosshair, health, ammo and credits; paused (Esc, or not started): the menu, with the controls,
// toggles and stats over the dimmed game
look.addEventListener('lock', () => document.body.classList.add('playing'));
// Debug mode (the toggle keys, their states and the stats, over the game): the backquote key switches it, ?debug starts in it
if (new URLSearchParams(location.search).has('debug')) document.body.classList.add('debug');
look.addEventListener('unlock', () => { document.body.classList.remove('playing'); mouse.trigger = mouse.aimHeld = false; });

export const opts = {
  stage, resolution: RT_SIZES[0], snaps: 16, pitchSnaps: 8, distance: 5, animFps: 12,
  stepped: true, snap: true, lockDist: true, real: false, bounds: false, spriteShadows: false,
  lod: true, lodNear: 8, lodFalloff: 0.25, sun, flashLights: [...flashes, ...stripLights, ...spotLights, ...portalLights].map((l) => l.sprite),
};

