// The view's own effects, over everything: blood on the lens, the hit arcs, the vignette; your grunt when hit
import './player.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { renderer } from './setup.js';
import { camera, hurtFocus, sceneTex } from './camera.js';
import { hudScene, hudCam } from './weapons.js';
import { audio, GRUNTS, playSound } from './audio.js';
import { GUN_SPLASH_RANGE, splashGun } from './gun-blood.js';

// The view's own effects, drawn over everything (after the gun): blood specks that landed on your view, and arcs
// pointing at what hit you. One full-screen pass, a few uniforms: HUD_SPECKS splats and HUD_ARCS arcs at most.
const HUD_SPECKS = 12, HUD_ARCS = 4, SPECK_LIFE = 1.6, ARC_LIFE = 1.1; // s
// The vignette: darkening from VIGNETTE[0] out from the middle to full at VIGNETTE[1] (1: the middle of an edge; ~1.41:
// a corner), up to VIGNETTE_STRENGTH dark
const VIGNETTE = [0.45, 1.45], VIGNETTE_STRENGTH = 0.6;
// And a red one, thickening as your health goes: by p(1 − h), h your health (0..1 of PLAYER_HEALTH), p the polynomial
// HURT_VIGNETTE (its coefficients, the constant first: x², so it's next to nothing till you're well down, then comes on
// fast). At p = 0, none; at 1, red from HURT_VIGNETTE_IN out from the middle, to HURT_VIGNETTE_MAX at the edges
export const HURT_VIGNETTE = [0, 0, 1], HURT_VIGNETTE_IN = 0.35, HURT_VIGNETTE_MAX = 0.9;
export const poly = (c, x) => c.reduceRight((s, k) => s * x + k, 0); // c[0] + c[1] x + c[2] x² + …
// A speck: a scatter of SPECK_DROPS droplets, SPECK_DROP_MIN..MAX in radius (screen heights; the big ones fewer and
// nearer the middle). They're on the lens, too near to focus on, so they're drawn as a camera would see them: sharp
// first (lensDrops: little domes, lit, what's behind showing through them, and a tiny, very bright glint where each
// catches the light), into an HDR image SPECK_PIXEL screen px per texel (pixel art), then that whole image blurred
// (lensBlur: a plain gaussian, SPECK_BLUR its sigma in screen heights). The blur spreads every drop out alike, but a
// glint is so much brighter than the rest that more of its spread stays bright: it swells into a wide soft disc, the
// brighter the wider, like the sun's glints off water when you're focused past them.
const SPECK_DROPS = 10, SPECK_DROP_MIN = 0.006, SPECK_DROP_MAX = 0.018, SPECK_PIXEL = 3, SPECK_BLUR = 0.012;
// how much a drop's dome tilts at its rim (0 flat, 1 a half sphere), how far it bends what's behind it (of the
// screen), and how bright its glint (HDR, for the biggest drop under the ceiling lights; × what it reflects)
const SPECK_TILT = 0.8, SPECK_REFRACT = 0.03, SPECK_GLINT = 300, SPECK_GLINTING = 0.35; // share of drops that catch it
export const hudFx = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: {
    uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uFlash: { value: 0 }, uScene: { value: null },
    uSpecks: { value: Array.from({ length: HUD_SPECKS }, () => new THREE.Vector4(0, 0, 0, -1e3)) }, // x, y (0..1), size, birth
    uArcs: { value: Array.from({ length: HUD_ARCS }, () => new THREE.Vector2(0, -1e3)) },             // angle, birth
    uLens: { value: null }, // the blurred drops (lensBlur), or null: none
    uLow: { value: 0 }, // how low your health is, through HURT_VIGNETTE (0..1)
  },
  vertexShader: `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    uniform vec2 uRes;
    uniform float uTime, uLow;
    uniform vec2 uArcs[${HUD_ARCS}];
    uniform sampler2D uLens;
    uniform bool uLensOn;
    void main() {
      // the drops, blurred: HDR light (premultiplied) and how much they hide; tone mapped as the world is, the light
      // added (so a glint's spread brightens past the drop itself)
      vec4 col = vec4(0.0);
      if (uLensOn) {
        vec4 b = texelFetch(uLens, ivec2(gl_FragCoord.xy / uRes * vec2(textureSize(uLens, 0))), 0);
        col = vec4(linearToOutputTexel(vec4(toneMapping(b.rgb), 1.0)).rgb, b.a);
      }
      // arcs: a thin curve round the centre, the way the shot came from (up the screen: ahead), tapering to its ends,
      // and from its middle a soft point, pointing out; one red, one soft edge, fading as it ages
      vec2 o = (gl_FragCoord.xy - uRes * 0.5) / uRes.y;
      float rad = length(o), ang = atan(o.x, o.y); // 0 straight up the screen, clockwise
      for (int i = 0; i < ${HUD_ARCS}; i++) {
        float age = uTime - uArcs[i].y;
        if (age < 0.0 || age > ${ARC_LIFE.toFixed(2)}) continue;
        float t = abs(atan(sin(ang - uArcs[i].x), cos(ang - uArcs[i].x))) / 0.9; // along it, 0 middle .. 1 ends
        float w = mix(0.02, 0.006, min(t * t, 1.0)); // its width, tapering; a gaussian across: blurred
        float dr = (rad - 0.2) / w;
        float arc = exp(-dr * dr) * (1.0 - smoothstep(0.7, 1.0, t));
        vec2 dir = vec2(sin(uArcs[i].x), cos(uArcs[i].x));
        float out_ = dot(o, dir), across = abs(dot(o, vec2(dir.y, -dir.x)));
        const float BASE = 0.195, TIP = 0.235, HALF = 0.024, K = (TIP - BASE) / HALF;
        float d = min(out_ - BASE, (TIP - out_ - across * K) / sqrt(1.0 + K * K)); // about how far inside the point
        float a = max(arc, smoothstep(-0.022, 0.012, d)) * (1.0 - smoothstep(0.0, ${ARC_LIFE.toFixed(2)}, age)) * 0.85;
        if (a > col.a) col = vec4(vec3(0.85, 0.05, 0.04) * a, a);
      }
      // the hurt: red in from the edges, thicker and redder the lower your health (see HURT_VIGNETTE), under the rest
      vec2 vo = (gl_FragCoord.xy / uRes - 0.5) * 2.0; // −1…1 across and up
      if (uLow > 0.0) {
        float r0 = mix(${VIGNETTE[1].toFixed(2)}, ${HURT_VIGNETTE_IN.toFixed(2)}, uLow); // where it starts, out from the middle
        float red = smoothstep(r0, r0 + 0.55, length(vo)) * mix(0.35, ${HURT_VIGNETTE_MAX.toFixed(2)}, uLow);
        col.rgb += vec3(0.5, 0.02, 0.01) * red * (1.0 - col.a);
        col.a += red * (1.0 - col.a);
      }
      // the vignette: the lens darker toward the edges and corners, under the rest (black, premultiplied: the red's
      // corners darker still)
      float vig = smoothstep(${VIGNETTE[0].toFixed(2)}, ${VIGNETTE[1].toFixed(2)}, length(vo)) * ${VIGNETTE_STRENGTH.toFixed(2)};
      col.a += vig * (1.0 - col.a);
      if (col.a <= 0.0 && dot(col.rgb, vec3(1.0)) <= 0.0) discard;
      gl_FragColor = col; // premultiplied
    }`,
  transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
}));
hudFx.material.uniforms.uLensOn = { value: false };
hudFx.frustumCulled = false;
hudFx.renderOrder = 1; // over the gun
hudScene.add(hudFx);
// the drops, sharp, into lensRT[0]; blurred across into lensRT[1], then up, back into lensRT[0]
const lensRT = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, depthBuffer: false }));
const lensDrops = new THREE.ShaderMaterial({
  uniforms: { // shared with hudFx: hudHit writes the specks there
    uSpecks: hudFx.material.uniforms.uSpecks, uTime: hudFx.material.uniforms.uTime, uFlash: hudFx.material.uniforms.uFlash,
    uScene: hudFx.material.uniforms.uScene, uRes: hudFx.material.uniforms.uRes,
  },
  vertexShader: `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    uniform float uTime, uFlash; // uFlash: your muzzle flash, now (0..1)
    uniform vec4 uSpecks[${HUD_SPECKS}];
    uniform sampler2D uScene; // the world behind, HDR (see sceneTex)
    uniform vec2 uRes; // the canvas's pixels
    vec2 hash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
    float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    void main() {
      vec2 size = uRes / ${SPECK_PIXEL.toFixed(1)}; // this image's (about)
      vec2 uv = gl_FragCoord.xy / size, q = gl_FragCoord.xy / size.y; // 0..1; screen heights
      float texel = 1.0 / size.y;
      vec3 L = normalize(vec3(-0.25, 0.75, 0.6)), H = normalize(L + vec3(0.0, 0.0, 1.0)); // the ceiling lights: above
      // the frontmost drop here (the tallest dome), and every drop's glint
      float best = 0.0, bestR = 1.0, bestFade = 0.0;
      vec2 bestD = vec2(0.0);
      vec3 glints = vec3(0.0);
      for (int i = 0; i < ${HUD_SPECKS}; i++) {
        vec4 s = uSpecks[i]; // its middle (0..1 across and up the screen), its spread, its birth
        float age = uTime - s.w;
        if (age < 0.0 || age > ${SPECK_LIFE.toFixed(2)}) continue;
        vec2 c = vec2(s.x * size.x / size.y, s.y);
        if (length(q - c) > s.z + ${SPECK_DROP_MAX.toFixed(3)} + 2.0 * texel) continue; // nowhere near
        float fade = 1.0 - smoothstep(${(SPECK_LIFE * 0.6).toFixed(2)}, ${SPECK_LIFE.toFixed(2)}, age);
        for (int k = 0; k < ${SPECK_DROPS}; k++) {
          vec2 h = hash2(vec2(s.w * 13.1 + float(i), float(k))), g = hash2(vec2(float(k) + 0.5, s.w * 7.3 + float(i)));
          float out_ = sqrt(h.y), ang = h.x * 6.283; // where, round its middle
          float r = mix(${SPECK_DROP_MIN.toFixed(3)}, ${SPECK_DROP_MAX.toFixed(3)}, g.x * g.x * (1.0 - 0.6 * out_));
          vec2 dc = c + vec2(cos(ang), sin(ang)) * out_ * s.z;
          dc.y -= min(age, 0.8) * g.y * r; // the bigger ones creep down a little
          vec2 d = (q - dc) / r;
          float h2 = 1.0 - dot(d, d); // its dome's height here, squared (of r)
          if (h2 > best) { best = h2; bestR = r; bestD = d; bestFade = fade; }
          // its glint, if it catches the light (SPECK_GLINTING of them do): where its dome faces halfway between you
          // and the light, one texel or so across (a point, too small to draw sharper), as bright as the drop is big
          // and what it reflects (the lights, your flash)
          if (fract(g.x * 31.7 + h.y * 17.3) > ${SPECK_GLINTING.toFixed(2)}) continue;
          vec2 gp = dc + H.xy / ${SPECK_TILT.toFixed(2)} * r * 0.9;
          vec2 gd = (q - gp) / texel;
          float shine = 0.04 + lum(textureLod(uScene, gp * size.y / size + H.xy * 0.15, 0.0).rgb) * 0.5 + uFlash * 2.0;
          glints += vec3(1.0, 0.92, 0.85) * exp(-dot(gd, gd) * 1.5) * shine * fade
            * ${SPECK_GLINT.toFixed(1)} * pow(r / ${SPECK_DROP_MAX.toFixed(3)}, 2.0);
        }
      }
      if (best <= 0.0) { gl_FragColor = vec4(glints, 0.0); return; } // a glint's edge past its drop: light, no cover
      // the drop: a dome, lit from above; what's behind shows through it, bent, the thicker the redder
      float th = sqrt(best);
      vec3 n = normalize(vec3(bestD * ${SPECK_TILT.toFixed(2)}, th));
      vec3 behind = textureLod(uScene, uv - n.xy * ${SPECK_REFRACT.toFixed(3)}, 0.0).rgb;
      vec3 through = behind * exp(-(0.3 + th) * vec3(0.4, 5.0, 6.0)) * 0.8; // blood lets red through
      vec3 body = vec3(0.5, 0.02, 0.02) * (0.25 + 0.5 * max(dot(n, L), 0.0)) * (1.0 + uFlash * 4.0);
      float a = bestFade * 0.95;
      gl_FragColor = vec4((body + through) * a + glints, a); // premultiplied
    }`,
  depthTest: false, depthWrite: false,
});
const lensBlur = new THREE.ShaderMaterial({
  uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2() }, uSigma: { value: 1 } },
  vertexShader: `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    uniform sampler2D uTex;
    uniform vec2 uDir; // across (1, 0) or up (0, 1)
    uniform float uSigma; // texels
    void main() { // a plain gaussian, one way
      ivec2 p = ivec2(gl_FragCoord.xy), last = textureSize(uTex, 0) - 1;
      vec4 sum = vec4(0.0);
      float wsum = 0.0;
      for (int i = -32; i <= 32; i++) {
        float x = float(i);
        if (abs(x) > 3.0 * uSigma) continue;
        float w = exp(-x * x / (2.0 * uSigma * uSigma));
        sum += texelFetch(uTex, clamp(p + ivec2(uDir * x), ivec2(0), last), 0) * w;
        wsum += w;
      }
      gl_FragColor = sum / wsum;
    }`,
  depthTest: false, depthWrite: false,
});
const lensQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lensDrops), lensScene = new THREE.Scene();
lensQuad.frustumCulled = false;
lensScene.add(lensQuad);
export function drawLens(now) { // before the HUD: the drops, sharp, then blurred (see SPECK_BLUR); none, nothing
  const u = hudFx.material.uniforms;
  u.uLensOn.value = u.uSpecks.value.some((s) => now - s.w >= 0 && now - s.w <= SPECK_LIFE) && !!sceneTex;
  if (!u.uLensOn.value) return;
  const w = Math.ceil(u.uRes.value.x / SPECK_PIXEL), h = Math.ceil(u.uRes.value.y / SPECK_PIXEL);
  for (const rt of lensRT) if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
  lensBlur.uniforms.uSigma.value = Math.min(SPECK_BLUR * h, 10);
  const pass = (mat, target) => { lensQuad.material = mat; renderer.setRenderTarget(target); renderer.render(lensScene, hudCam); };
  pass(lensDrops, lensRT[0]);
  lensBlur.uniforms.uTex.value = lensRT[0].texture; lensBlur.uniforms.uDir.value.set(1, 0); pass(lensBlur, lensRT[1]);
  lensBlur.uniforms.uTex.value = lensRT[1].texture; lensBlur.uniforms.uDir.value.set(0, 1); pass(lensBlur, lensRT[0]);
  renderer.setRenderTarget(null);
  u.uLens.value = lensRT[0].texture;
}
let speckNext = 0, arcNext = 0;
export const _hudV = new THREE.Vector3();
// You, hit: a grunt, one of GRUNTS at random (never the same twice running), at most one per GRUNT_GAP s so a volley
// doesn't stack them
const GRUNT_GAP = 0.45;
let lastGrunt = -Infinity, lastGruntK = -1;
// n specks of blood onto the lens, landing at t: towards its left and right edges (the right with chance `right`),
// clear of the crosshair
function flickSpecks(n, t, right = 0.5) {
  for (let k = 0; k < n; k++) {
    const side = Math.random() < right ? 1 : -1;
    hudFx.material.uniforms.uSpecks.value[speckNext++ % HUD_SPECKS]
      .set(0.5 + side * (0.2 + Math.random() * 0.28), 0.15 + Math.random() * 0.7, 0.03 + Math.random() * 0.04, t);
  }
}
export function hudHit(from) {
  const u = hudFx.material.uniforms, t = u.uTime.value;
  hurtFocus(); // knocked out of focus (see HURT_BLUR)
  if (audio.currentTime - lastGrunt >= GRUNT_GAP) {
    let k = (Math.random() * (GRUNTS - 1)) | 0;
    if (k >= lastGruntK) k++;
    lastGrunt = audio.currentTime;
    playSound(`hurt_grunt_${(lastGruntK = k % GRUNTS)}`, 1, 0.05);
  }
  flickSpecks(2 + ((Math.random() * 3) | 0), t);
  _hudV.copy(from).applyMatrix4(camera.matrixWorldInverse); // where it came from, in view space
  u.uArcs.value[arcNext++ % HUD_ARCS].set(Math.atan2(_hudV.x, -_hudV.z), t);
}
// Blood flung your way: a burst within LENS_SPLASH_RANGE m of you, and in view, splashes the lens too, where you see
// it, as when you're hit (flickSpecks), mostly on its side of the screen, once it's flown that far (at
// LENS_SPLASH_SPEED); the nearer, the more
const LENS_SPLASH_RANGE = 4, LENS_SPLASH_SPEED = 5; // m; m/s
const _lensP = new THREE.Vector3();
export function splashLens(at) {
  const d = at.distanceTo(camera.position), near = 1 - d / LENS_SPLASH_RANGE;
  if (near <= 0) return;
  _lensP.copy(at).project(camera);
  if (_lensP.z > 1 || Math.abs(_lensP.x) > 1.2 || Math.abs(_lensP.y) > 1.2) return; // behind you, or out of view
  flickSpecks(Math.round(near * 3 + Math.random()), hudFx.material.uniforms.uTime.value + d / LENS_SPLASH_SPEED,
    0.5 + 0.35 * THREE.MathUtils.clamp(_lensP.x * 3, -1, 1));
  if (d < GUN_SPLASH_RANGE) splashGun(at, 1 - d / GUN_SPLASH_RANGE);
}

