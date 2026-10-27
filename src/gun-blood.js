// Demon blood on your gun and gloves; the ammo count
import './hud.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { renderer } from './setup.js';
import { camera } from './camera.js';
import { FISTS, MAG, gunCam, gun } from './weapons.js';
import { bloodTarget, fullQuad, fullQuadVS, bloodCam } from './blood-maps.js';
import { _clearColor } from './blood-sheets.js';
import { ammoEl } from './player.js';
import { clock } from './main.js';

// Demon blood on your gun and arms (only theirs: your own blood only ever reaches the lens). Each of the weapon's
// materials (the hand, the glove, the rifle's parts, which share one texture, the bullets) gets a mask over its texture
// (R: blood, G: the wet part of it, as the floor's), painted when a demon bursts within GUN_SPLASH_RANGE m and in view:
// drops and splats flung onto the faces you can see (those facing up and back at you: blood from the front would land
// on the side you never see), more on the burst's side of the screen, more the nearer it is. Wet it's glossy scarlet;
// it dries dark and matte over GUN_BLOOD_DRY_TAU s and wears off over GUN_BLOOD_FADE s.
export const GUN_SPLASH_RANGE = 3, GUN_BLOOD_RES = 512; // m; px per material's mask
const GUN_BLOOD_DROP = 0.006, GUN_BLOOD_SPLAT = 0.025; // m: the drops' and the splats' spacing (their grid's cells)
const GUN_BLOOD_DRY_TAU = 20, GUN_BLOOD_FADE = 150, GUN_BLOOD_STEP = 0.5; // s; s; s between drying steps
const gunPaint = new THREE.ShaderMaterial({
  uniforms: { uView: { value: new THREE.Matrix4() }, uFrom: { value: new THREE.Vector3() }, uSide: { value: 0 },
    uAmount: { value: 0 }, uSeed: { value: 0 } },
  vertexShader: `
    #include <common>
    #include <skinning_pars_vertex>
    uniform mat4 uView;
    varying vec3 vView, vN;
    void main() {
      #include <skinbase_vertex>
      #include <begin_vertex>
      #include <beginnormal_vertex>
      #include <skinnormal_vertex>
      #include <skinning_vertex>
      vView = (uView * modelMatrix * vec4(transformed, 1.0)).xyz; // in the eye's space
      vN = mat3(uView) * mat3(modelMatrix) * objectNormal;
      gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); // where it is in the texture
    }`,
  fragmentShader: `
    uniform vec3 uFrom; // the way the blood comes from (unit, eye space)
    uniform float uSide, uAmount, uSeed; // the burst's side of the screen (−1…1); how much (0…1)
    varying vec3 vView, vN;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }
    // round drops on a grid of cells (cell m apart, as seen from where the blood comes from), one in a cell at
    // chance 'odds', each its own size and spot
    float drops(vec2 q, float cell, float odds) {
      vec2 c = floor(q / cell);
      float v = 0.0;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 k = c + vec2(x, y);
        if (hash(k) > odds) continue;
        vec2 at = (k + 0.5 + (vec2(hash(k + 7.1), hash(k + 3.7)) - 0.5) * 0.8) * cell;
        float r = cell * mix(0.15, 0.5, hash(k + 1.3) * hash(k + 1.3));
        v = max(v, 1.0 - smoothstep(r * 0.7, r, length(q - at)));
      }
      return v;
    }
    void main() {
      float face = dot(normalize(vN), uFrom);
      if (face < 0.1) discard; // turned away from it
      // as seen from where it comes from: a plane across its way
      vec3 a = normalize(cross(uFrom, abs(uFrom.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))), b = cross(uFrom, a);
      vec2 q = vec2(dot(vView, a), dot(vView, b));
      // more on the burst's side of the screen; patchy, not an even coat
      float side = mix(0.35, 1.0, smoothstep(-0.4, 0.4, uSide * vView.x / max(-vView.z, 0.05)));
      float patchy = smoothstep(0.3, 0.8, hash(floor(q / 0.05)));
      float odds = uAmount * side * (0.3 + 0.7 * patchy);
      float v = max(0.7 * drops(q, ${GUN_BLOOD_DROP.toFixed(3)}, odds * 0.45), drops(q + 0.37, ${GUN_BLOOD_SPLAT.toFixed(3)}, odds * 0.2));
      if (v <= 0.0) discard;
      gl_FragColor = vec4(v, v, 0.0, 1.0); // fresh: all wet
    }`,
  side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
});
// drying: the wet part (G) shrinks fast, the blood itself (R) slowly
const gunDryMat = new THREE.ShaderMaterial({
  uniforms: { uKeep: { value: new THREE.Vector2(1, 1) } },
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
  depthTest: false, depthWrite: false, vertexShader: fullQuadVS,
  fragmentShader: `uniform vec2 uKeep; void main() { gl_FragColor = vec4(uKeep, 1.0, 1.0); }`,
});
const gunDryScene = fullQuad(gunDryMat);
// The weapon's materials, each given a blood mask (cleared) and the shading for it: [{ rt, meshes }]
export function addGunBlood(root) {
  const byMat = new Map();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.material.map) return; // (the mask is read over the colour texture's layout; hidden: none)
    if (!byMat.has(o.material)) byMat.set(o.material, { rt: bloodTarget(GUN_BLOOD_RES, GUN_BLOOD_RES), meshes: [] });
    byMat.get(o.material).meshes.push(o);
  });
  const target = renderer.getRenderTarget(), alpha = renderer.getClearAlpha();
  renderer.getClearColor(_clearColor);
  renderer.setClearColor(0x000000, 0);
  for (const [mat, { rt }] of byMat) {
    renderer.setRenderTarget(rt);
    renderer.clear();
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uGunBlood = { value: rt.texture };
      shader.fragmentShader = 'uniform sampler2D uGunBlood;\n' + shader.fragmentShader.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  vec2 gb = texture2D(uGunBlood, vMapUv).rg; // demon blood (see splashGun)
  float gbOn = min(gb.r * 1.6, 1.0), gbWet = gb.r > 0.001 ? clamp(gb.g / gb.r, 0.0, 1.0) : 0.0;
  // wet: scarlet where thin, deep red where thick, glossy; dried: dark brown-red, matte; not metal either way
  vec3 gbCol = mix(vec3(0.09, 0.012, 0.008), mix(vec3(0.45, 0.015, 0.025), vec3(0.2, 0.004, 0.01), gb.r), gbWet);
  diffuseColor.rgb = mix(diffuseColor.rgb, gbCol, gbOn);
  roughnessFactor = mix(roughnessFactor, mix(0.75, 0.12, gbWet), gbOn);
  metalnessFactor = mix(metalnessFactor, 0.0, gbOn);`);
    };
    mat.needsUpdate = true;
  }
  renderer.setRenderTarget(target);
  renderer.setClearColor(_clearColor, alpha);
  return [...byMat.values()];
}
const _gunTo = new THREE.Vector3();
let gunBloodAt = -Infinity, gunDryWait = 0; // when it was last painted; s since the last drying step
// A demon's burst at 'at', 'near' (0…1) how close: its blood onto your weapon, painted when it's next drawn (paintGunBlood),
// in that pose
export function splashGun(at, near) {
  if (!gun?.blood) return;
  _gunTo.copy(at).applyMatrix4(camera.matrixWorldInverse).normalize(); // the burst, from your eye (view space: the gun's too)
  // (fists: both fists show the right arm's blood, mirrored, so it takes every burst as if on its own side: a burst on
  // the left otherwise gave both a thin coat)
  gun.splashes.push({ x: FISTS ? Math.abs(_gunTo.x) : _gunTo.x, near });
  gun.dirty = true;
}
export function paintGunBlood() { // in updateGun, posed and its eye placed, before it's drawn
  const u = gunPaint.uniforms, target = renderer.getRenderTarget(), autoClear = renderer.autoClear;
  u.uView.value.copy(gunCam.matrixWorldInverse);
  renderer.autoClear = false;
  for (const { x, near } of gun.splashes) {
    u.uFrom.value.set(x * 0.5, 1, 0.7).normalize(); // from above, towards you, a little from its side
    u.uSide.value = THREE.MathUtils.clamp(x * 3, -1, 1);
    u.uAmount.value = near;
    u.uSeed.value = Math.random() * 100;
    for (const { rt, meshes } of gun.blood) {
      renderer.setRenderTarget(rt);
      for (const m of meshes) {
        const keep = m.material, culled = m.frustumCulled;
        m.material = gunPaint; m.frustumCulled = false;
        renderer.render(m, gunCam);
        m.material = keep; m.frustumCulled = culled;
      }
    }
  }
  gun.splashes.length = 0;
  renderer.setRenderTarget(target);
  renderer.autoClear = autoClear;
  gunBloodAt = clock.elapsedTime;
}
export function dryGunBlood(dt) { // every GUN_BLOOD_STEP s while there's blood on it (till it's all but worn off)
  if (!gun.blood || clock.elapsedTime - gunBloodAt > 4 * GUN_BLOOD_FADE || (gunDryWait += dt) < GUN_BLOOD_STEP) return;
  gunDryMat.uniforms.uKeep.value.set(Math.exp(-gunDryWait / GUN_BLOOD_FADE), Math.exp(-gunDryWait / GUN_BLOOD_DRY_TAU) * Math.exp(-gunDryWait / GUN_BLOOD_FADE));
  gunDryWait = 0;
  const target = renderer.getRenderTarget(), autoClear = renderer.autoClear;
  renderer.autoClear = false;
  for (const { rt } of gun.blood) { renderer.setRenderTarget(rt); renderer.render(gunDryScene, bloodCam); }
  renderer.setRenderTarget(target);
  renderer.autoClear = autoClear;
  gun.dirty = true;
}

export function updateAmmo() {
  const reloading = gun && (gun.actions.Reload.isRunning() || gun.actions.Reload_Empty.isRunning()); // (not busy: that's drawing, too)
  ammoEl.textContent = gun && !FISTS ? `${gun.ammo} / ${MAG}${reloading ? '  reloading' : ''}` : '';
}

