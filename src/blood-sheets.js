// Blood in the air, drawn: as metaballs (off) or as sheets; and each frame's blood (updateBlood)
import { FL_MAX, FL_STEP, STAIN_SHARE, STAIN_MAX, GOO_PIXEL, GOO_SPLAT, GOO_THRESHOLD, BLOOD_METABALLS, GOO_MIN_SPLAT,
  flP, flV, flSerial, flSheet, flAlive, flStep, _bv, _bp } from './blood-fluid.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { renderer, scene, stage } from './setup.js';
import { camera, composer, opts } from './camera.js';
import { BLOOD_WET, BLOOD_UNDER, decalMat, spawnDecal } from './decals.js';

// the field: one splat per live particle, summed (additive) into half-float targets: weight, weight × view depth,
// weight × the splat's sphere normal (x, y in view space); and, in a second pass, weight × the light on it
const fieldOpts = { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter };
const fieldRT = new THREE.WebGLRenderTarget(1, 1, fieldOpts), lightRT = new THREE.WebGLRenderTarget(1, 1, fieldOpts);
const fieldScene = new THREE.Scene();
const splatGeo = new THREE.InstancedBufferGeometry();
splatGeo.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
splatGeo.setIndex([0, 1, 2, 0, 2, 3]);
const splatPos = new THREE.InstancedBufferAttribute(new Float32Array(FL_MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
const splatLight = new THREE.InstancedBufferAttribute(new Float32Array(FL_MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
splatGeo.setAttribute('aPos', splatPos);
splatGeo.setAttribute('aLight', splatLight);
splatGeo.instanceCount = 0;
const splats = new THREE.Mesh(splatGeo, new THREE.ShaderMaterial({
  uniforms: { uRadius: { value: GOO_SPLAT }, uMinPerZ: { value: 0 } }, // uMinPerZ: GOO_MIN_SPLAT texels, in m per m away
  vertexShader: `
    attribute vec2 corner;
    attribute vec3 aPos, aLight;
    uniform float uRadius, uMinPerZ;
    varying vec2 vQ;
    varying float vZ;
    varying vec3 vLight;
    void main() {
      vec4 c = viewMatrix * vec4(aPos, 1.0);
      vQ = corner; vZ = -c.z; vLight = aLight;
      gl_Position = projectionMatrix * (c + vec4(corner * max(uRadius, uMinPerZ * vZ), 0.0, 0.0)); // a billboard
    }`,
  fragmentShader: `
    varying vec2 vQ;
    varying float vZ;
    varying vec3 vLight;
    void main() {
      float r2 = dot(vQ, vQ);
      if (r2 > 1.0) discard;
      float w = (1.0 - r2) * (1.0 - r2);
    #ifdef LIGHT
      gl_FragColor = vec4(w * vLight, 0.0);
    #else
      gl_FragColor = vec4(w, w * vZ, w * vQ);
    #endif
    }`,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  depthTest: false, depthWrite: false, transparent: true,
}));
splats.frustumCulled = false;
fieldScene.add(splats);
const splatMat = splats.material, splatLightMat = splatMat.clone();
splatLightMat.uniforms = splatMat.uniforms;
splatLightMat.defines = { LIGHT: '' };
// the liquid: a full-screen pass in the world, drawn wherever the field is over the threshold, at the field's depth
const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const gooMat = new THREE.ShaderMaterial({
  uniforms: {
    uField: { value: fieldRT.texture }, uLight: { value: lightRT.texture }, uProj: { value: camera.projectionMatrix }, uRes: { value: new THREE.Vector2(1, 1) }, uThreshold: { value: GOO_THRESHOLD },
    uBody: { value: srgb(0.6, 0.02, 0.05) }, // albedo
    uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0 },
  },
  vertexShader: `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    uniform sampler2D uField, uLight;
    uniform mat4 uProj;
    uniform vec2 uRes;
    uniform float uThreshold, uFogDensity;
    uniform vec3 uBody, uFogColor;
    void main() {
      ivec2 size = textureSize(uField, 0);
      vec4 f = texelFetch(uField, ivec2(gl_FragCoord.xy / uRes * vec2(size)), 0);
      if (f.r < uThreshold) discard;
      float z = f.g / f.r; // the liquid's view depth here (its splats', weighted)
      ivec2 at = ivec2(gl_FragCoord.xy / uRes * vec2(size));
      vec2 nxy = f.ba / f.r * 1.6;
      vec3 n = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
      vec3 light = texelFetch(uLight, at, 0).rgb / f.r; // what the demon's lights put on it (see bloodLight)
      // smooth shading, lit like the demon: a soft diffuse falloff from above, plus what a wet surface reflects (the
      // light itself: a tight highlight towards a key light above and to the left; at the grazing edges Fresnel mostly
      // mirrors the dark room, so only a trace of the light)
      vec3 nn = normalize(n), key = normalize(vec3(-0.4, 0.6, 0.7));
      float diffuse = 0.45 + 0.55 * max(dot(nn, key), 0.0);
      float fresnel = 0.04 + 0.96 * pow(1.0 - nn.z, 5.0);
      float spec = pow(max(dot(nn, normalize(key + vec3(0.0, 0.0, 1.0))), 0.0), 60.0);
      vec3 col = uBody * light * diffuse * (1.0 - fresnel) + light * (0.03 * fresnel + 0.5 * spec);
      vec4 c = uProj * vec4(0.0, 0.0, -z, 1.0);
      gl_FragDepth = c.z / c.w * 0.5 + 0.5;
      gl_FragColor = vec4(mix(col, uFogColor, 1.0 - exp(-uFogDensity * uFogDensity * z * z)), 1.0);
    }`,
});
const gooQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gooMat);
gooQuad.frustumCulled = false;
gooQuad.visible = false;
scene.add(gooQuad);

// Webs: a hybrid of the metaballs and billboards. Each gob also carries a flat sheet of paint, a billboard pinned to
// its first and last particles (so it spans the rope and stretches as it does), patterned with a cellular-noise web:
// Worley F2 − F1 (second-nearest feature point's distance minus the nearest's) is zero on the borders between cells,
// so its ridges are one connected network of filaments round empty pockets; F3 − F1 is small where three cells meet,
// which knots the filaments with fat blobs; and a solid patch sits at the centre (which drains into them, below). The web
// thins towards the sheet's rim and as it ages, so the film tears into webbing and vanishes. Its uv
// stretches with the sheet, so the web does too. Drawn on the blood's pixel grid, lit like the metaballs.
const SHEET_MAX = 128, SHEET_LIFE = 0.6, SHEET_WIDTH = 0.8, SHEET_PAD = 0.05; // sheets, s, width / length, m beyond the ends
const SHEET_LIGHT_TINT = 0.15; // how much of the lights' colour the airborne blood takes (the rest: just their brightness)
const SHEET_SCALE = 3; // how much bigger than its rope a sheet is drawn (its blood pixels grow with it)
const SHEET_LIGHT_MAX = 4; // the most light a sheet takes: generous (its dark red stays out of bloom), only stops extremes
const SHEET_CURL = 1.2, SHEET_CUP = 1.2; // the splat opens like a flower: the bottom hangs at the wound and it curves
// out towards you, more the higher it goes (this many half-sizes nearer at the top) and at the upper sides; its shading
// follows that bend, exaggerated by SHEET_CUP
const SHEET_GRID = 8; // quads per side the sheet is split into, so it can bend
const SHEET_THICK = 0.35; // paint thickness (web cells) in a ball's middle
// light through it from behind; glint tightness, strength; share of the edge pixels facing the light that twinkle
const SHEET_TRANSLUCENT = 0.15, SHEET_GLOSS = 120, SHEET_GLINT = 1.5, SHEET_TWINKLE = 0.15;
const SHEET_RELIEF = 1.5; // how tall the paint stands (in blood pixels per unit height): more, the deeper its shading
// The paint's rim: a bevel rising from every contour over SHEET_BEVEL blood pixels, flat beyond it (the paint is 2D:
// nothing bulges). Its width is the same all round every shape, whatever the balls under it: the balls set the
// outline, not the surface. Its tilt is capped (SHEET_BEVEL_TILT, height per blood pixel) so the rim facing the light
// catches a clean, continuous glint; and the outermost blood pixel on that side gets a highlight of its own
// Each splat is a small pixel-art texture: its paint is baked each frame into its own SHEET_TEXELS-square tile of
// sheetAtlas (one blood pixel a texel, each worked out once whatever the splat's size on screen), then its card is
// drawn in the scene at full resolution, reading its tile without interpolation: crisp blood pixels that shrink with
// distance like the splat does (down to screen pixels, past which its finest bits drop out)
const SHEET_TEXELS = 128, SHEET_ATLAS_COLS = 16, SHEET_ATLAS_ROWS = Math.ceil(SHEET_MAX / SHEET_ATLAS_COLS);
const SHEET_BEVEL = 1.5, SHEET_BEVEL_TILT = 0.6, SHEET_EDGE_LIGHT = 0.1; // blood px; most slope; the pale lit rim's strength
// The splat's shape is a Worley web (as below); the paint itself is 2D metaballs packed into it, so the shape is
// drawn in liquid at a resolution: a jittered grid of SHEET_BALLS balls per web cell side, each as big as how deep in
// the shape its centre is (full inside, shrinking to nothing at the edge, none outside). Each ball's influence fades
// out to SHEET_REACH times its radius; the paint is wherever their sum passes 0.5. Inside the shape the balls overlap
// into solid paint; where the shape is thin (a strand barely a ball wide) they bead up into chains with stretched
// necks, which part as the strand thins: not threads, but flung liquid. More balls: the shape held closer, finer
// beads; fewer: chunkier, breaking sooner
const SHEET_BALLS = 8, SHEET_BALL_JITTER = 0.3, SHEET_BALL_EDGE = 4; // per web cell side; how far off its grid point
// (share of a step); how fast a ball reaches full size going into the shape (1 / share of the shape's depth)
const SHEET_REACH = 2.2; // a ball's influence's reach (radii)
// The hybrid (SHEET_MODE 0; M in debug mode cycles it, the dense metaballs (1), and the web alone (2)): cheaper. A few big metaballs for the splotches, shrinking as
// the sheet ages, the web's strands (one Worley lookup a pixel, not one per ball) joining them, thick near them and
// thinning away, and both merged as distances with a smooth minimum, so strands flow into the splotches in a fillet.
// How many balls; how far out from the middle (of the sheet's half-size); their radii; how much they shrink by the
// end; how softly they merge with each other, and with the strands (sheet units); how far from them the web reaches
const HYB_BALLS = 5, HYB_SPREAD = 0.45, HYB_R_MIN = 0.045, HYB_R_MAX = 0.13, HYB_SHRINK = 0.7;
const HYB_BALL_K = 0.12, HYB_BLEND = 0.06, HYB_WEB_REACH = 0.25;
const HYB_WEB_THICK = 1.8; // the web's strands and knots this much wider than SHEET_WEB / SHEET_KNOT (the balls unchanged)
const HYB_ROUND = [0, 1]; // how much the balls are shaded as domes: new (flat), and late in life (balled up; see nDome)
export let sheetMode = 0; // see SHEET_MODES
export const SHEET_MODES = ['hybrid', 'metaballs', 'worley'];
const SHEET_CELLS = 2.4, SHEET_WEB = 0.17; // web cells across the sheet's half-size; filament half-width (in cells), new
const SHEET_WARP = 0.6, SHEET_LUMPS = 0.6; // how far (in cells) smooth noise bends the web; how much strands swell and pinch
const SHEET_FLOW = 3, SHEET_SPREAD = 0.5; // how fast (noise units/s) the warp flows, so the arms writhe; how far (in
// cells, over its life) the pattern streams outwards from the centre
const SHEET_GAPS = 0.3; // how much of the web a slow noise removes near the centre, breaking closed cells into separate
// branching arms; it eases off outwards (gone by SHEET_WEB_OUT of the radius), so the edge is a connected web
const SHEET_WEB_OUT = 0.45;
const SHEET_KNOT = 0.5, SHEET_CORE = 0.4; // where filaments meet, a blob (F3 − F1 under this, in cells); solid centre (share of the sheet)
// The centre patch drains into the web: it shrinks to nothing by SHEET_CORE_GONE of its life, and the paint it
// loses fattens the strands and knots round it (most near the centre, tapering out), which then thin with the rest
const SHEET_CORE_GONE = 0.6, SHEET_FEED = 1.5; // share of its life the patch lasts; most the arms near it thicken by
const shA = new Int32Array(SHEET_MAX), shB = new Int32Array(SHEET_MAX), shSA = new Uint32Array(SHEET_MAX), shSB = new Uint32Array(SHEET_MAX);
const shBirth = new Float32Array(SHEET_MAX), shSeed = new Float32Array(SHEET_MAX), shAlive = new Uint8Array(SHEET_MAX);
const shScale = new Float32Array(SHEET_MAX); // how much bigger than SHEET_SCALE it's drawn (see SPLAT_SCALE)
const shStained = new Uint8Array(SHEET_MAX); // its gob has landed and left its stain (it may have faded from the air long before)
let shHead = 0;
export function addSheet(a, b, scale) {
  const i = shHead++ % SHEET_MAX;
  shA[i] = a; shB[i] = b; shSA[i] = flSerial[a]; shSB[i] = flSerial[b]; shScale[i] = scale;
  shBirth[i] = bloodTime; shSeed[i] = Math.random() * 100; shAlive[i] = 1; shStained[i] = 0;
  flSheet[a] = flSheet[b] = i;
}
// One of sheet sh's end particles (i) has landed, at _bp (normal: the wall's, or null for the floor): the splat lands
// with it, leaving one big stain its size, and is gone. Most gobs are still in the air after the sheet has faded out
// (SHEET_LIFE), so this goes by the gob, not by whether its sheet is still drawn.
export function landSheet(sh, i, normal) {
  flSheet[i] = -1;
  if (shStained[sh] || (shA[sh] !== i && shB[sh] !== i) || flSerial[shA[sh]] !== shSA[sh] || flSerial[shB[sh]] !== shSB[sh]) return;
  const j = shA[sh] === i ? shB[sh] : shA[sh], ki = i * 3, kj = j * 3;
  flSheet[j] = -1;
  shStained[sh] = 1;
  shAlive[sh] = 0;
  const len = Math.hypot(flP[kj] - flP[ki], flP[kj + 1] - flP[ki + 1], flP[kj + 2] - flP[ki + 2]);
  const half = (0.5 * len + SHEET_PAD) * SHEET_SCALE * shScale[sh]; // as the sheet's drawn (see sheetMat)
  const size = THREE.MathUtils.clamp(STAIN_SHARE * half, 0.15, STAIN_MAX);
  spawnDecal(_bp, normal, _bv.fromArray(flV, ki), 0, size);
}
const sheetGeo = new THREE.InstancedBufferGeometry();
{ // a grid, not one quad, so the sheet can bend (see SHEET_CURL)
  const N = SHEET_GRID, corners = [], index = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) corners.push(i / N * 2 - 1, j / N * 2 - 1);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i;
    index.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
  }
  sheetGeo.setAttribute('corner', new THREE.Float32BufferAttribute(corners, 2));
  sheetGeo.setIndex(index);
}
const sheetAttr = (name, n) => {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(SHEET_MAX * n), n).setUsage(THREE.DynamicDrawUsage);
  sheetGeo.setAttribute(name, a);
  return a;
};
const shAttrA = sheetAttr('aA', 3), shAttrB = sheetAttr('aB', 3), shAttrLight = sheetAttr('aLight', 3), shAttrLightDir = sheetAttr('aLightDir', 3);
const shAttrSeed = sheetAttr('aSeed', 1), shAttrAge = sheetAttr('aAge', 1), shAttrScale = sheetAttr('aScale', 1);
sheetGeo.instanceCount = 0;
// random texels, for the splats' noise: a fetch is cheaper than hashing with sin (the shader needs hundreds a pixel)
const NOISE_SIZE = 256;
const noiseTex = Object.assign(new THREE.DataTexture(
  Uint8Array.from({ length: NOISE_SIZE * NOISE_SIZE * 4 }, () => Math.random() * 256), NOISE_SIZE, NOISE_SIZE), {
  wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, needsUpdate: true });
const sheetMat = new THREE.ShaderMaterial({
  uniforms: {
    uNoise: { value: noiseTex },
    uBody: { value: new THREE.Color(...BLOOD_WET).multiplyScalar(BLOOD_UNDER) }, // albedo: the body, the floor's wet stains' red
    uFogColor: gooMat.uniforms.uFogColor, uFogDensity: gooMat.uniforms.uFogDensity,
  },
  vertexShader: `
    attribute vec2 corner;
    attribute vec3 aA, aB, aLight, aLightDir;
    attribute float aSeed, aAge, aScale;
    varying vec2 vUv, vS, vDir, vFit; // vDir: the card's x axis on screen (its y: vDir turned left); vFit: see fit
    varying vec3 vLight, vLightDir;
    varying float vSeed, vAge, vZ;
    void main() {
      vLightDir = normalize(mat3(viewMatrix) * aLightDir); // view space: x right, y up, z towards you
      vec4 a = viewMatrix * vec4(aA, 1.0), b = viewMatrix * vec4(aB, 1.0), c = (a + b) * 0.5;
      vec2 ax = b.xy - a.xy;
      float len = length(ax);
      vec2 dir = len > 1e-4 ? ax / len : vec2(1.0, 0.0), nrm = vec2(-dir.y, dir.x);
      vec2 half_ = vec2(0.5 * len + ${SHEET_PAD.toFixed(3)}, 0.5 * len * ${SHEET_WIDTH.toFixed(2)} + ${SHEET_PAD.toFixed(3)}) * ${SHEET_SCALE.toFixed(1)} * aScale;
      vec2 off = dir * corner.x * half_.x + nrm * corner.y * half_.y; // view space: x right, y up
      float size = length(half_);
      vS = off / size; // where on the splat, upright (y up) whichever way its rope runs
      c.xy += off;
      // the bend: flat where it hangs at the bottom, curving towards you faster the higher it goes, and the upper
      // sides curling in too, like a flower's petals
      float up = clamp(vS.y * 0.5 + 0.5, 0.0, 1.0);
      c.z += ${SHEET_CURL.toFixed(2)} * size * (up * up + 0.6 * vS.x * vS.x * up);
      vUv = corner; vSeed = aSeed; vAge = aAge; vZ = -c.z;
      vLight = min(aLight, vec3(${SHEET_LIGHT_MAX.toFixed(1)})); // capped, as for the casings (see CASE_LIGHT_MAX)
      // baked flat into its tile of the atlas (see SHEET_TEXELS), not drawn on screen: it's sheetCards that are
      vec2 tile = vec2(mod(float(gl_InstanceID), ${SHEET_ATLAS_COLS}.0), floor(float(gl_InstanceID) / ${SHEET_ATLAS_COLS}.0));
      // by its proportions, so its blood pixels are square: its long side the tile's width, the other side less
      vec2 fit = half_ / max(half_.x, half_.y);
      vDir = dir; vFit = fit;
      gl_Position = vec4((tile + (corner * fit) * 0.5 + 0.5) / vec2(${SHEET_ATLAS_COLS}.0, ${SHEET_ATLAS_ROWS}.0) * 2.0 - 1.0, 0.0, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 uBody, uFogColor;
    uniform float uFogDensity;
    varying vec2 vUv, vS, vDir, vFit; // vDir: the card's x axis on screen (its y: vDir turned left); vFit: see fit
    varying vec3 vLight, vLightDir;
    varying float vSeed, vAge, vZ;
    uniform sampler2D uNoise;
    vec2 hash2(vec2 p) { return texelFetch(uNoise, ivec2(mod(floor(p), ${NOISE_SIZE}.0)), 0).xy; } // 0..1, per whole p
    float vnoise(vec2 p) { // smooth value noise, about -1..1: the texture's own blend, between texels eased (smoothstep)
      vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
      return textureLod(uNoise, (i + u + 0.5) / ${NOISE_SIZE}.0, 0.0).z * 2.0 - 1.0;
    }
    float fbm(vec2 p) { return vnoise(p) * 0.65 + vnoise(p * 2.3 + 7.1) * 0.35; }
    vec3 worley(vec2 p) { // distances to the nearest three feature points: F1, F2, F3
      vec2 i = floor(p), f = fract(p);
      float d1 = 8.0, d2 = 8.0, d3 = 8.0;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(x, y), r = o + hash2(i + o) - f;
        float d = dot(r, r);
        if (d < d1) { d3 = d2; d2 = d1; d1 = d; } else if (d < d2) { d3 = d2; d2 = d; } else if (d < d3) d3 = d;
      }
      return sqrt(vec3(d1, d2, d3));
    }
    // the shape (the metaballs' blueprint): how far inside it a point of the sheet is, > 0 inside, about 1 deep in a
    // shape's middle; and its paint thickness there
    // a direction in the baked tile (the card's axes: x along its rope) as it is on screen, view space's x, y
    vec2 toView(vec2 v) { return vDir * v.x + vec2(-vDir.y, vDir.x) * v.y; }
    float shapeAt(vec2 uv, out float thick) {
      float r2 = dot(uv, uv);
      thick = 0.0;
      if (r2 > 1.0) return -1.0;
      // three kinds of shape, all thinning towards the rim and as the sheet ages: filaments on the cell borders
      // (F2 − F1 small), fat knots where three cells meet (F3 − F1 small), and a solid patch at the centre whose edge
      // wobbles with the cells
      float thin = max((1.0 - vAge / ${SHEET_LIFE.toFixed(2)}) * (1.0 - r2), 1e-4);
      // Worley's cell borders are straight lines; bending its coordinates with smooth noise first (a domain warp)
      // curves them into wandering strands, and more noise swells and pinches each strand along its length
      vec2 q = uv * ${SHEET_CELLS.toFixed(1)} + vSeed;
      // the warp flows with age, so the arms writhe, and the pattern streams outwards a little, as if flung
      float flow = vAge * ${SHEET_FLOW.toFixed(1)};
      q -= uv * ${SHEET_SPREAD.toFixed(2)} * ${SHEET_CELLS.toFixed(1)} * vAge / ${SHEET_LIFE.toFixed(2)};
      q += ${SHEET_WARP.toFixed(2)} * vec2(fbm(q * 0.6 + vec2(flow, 0.0)), fbm(q * 0.6 + 31.7 - vec2(0.0, flow)));
      vec3 F = worley(q);
      float lumps = (1.0 + ${SHEET_LUMPS.toFixed(2)} * vnoise(q * 2.7 + 13.3))
        * smoothstep(-0.2, 0.25, vnoise(q * 0.8 + 57.3) + 0.5 // some strands gone: arms near the centre, web outside
          - ${SHEET_GAPS.toFixed(2)} * (1.0 - smoothstep(0.2, ${SHEET_WEB_OUT.toFixed(2)}, sqrt(r2))));
      // the patch shrinks (its edge wobbling with the cells); what it loses feeds the arms round the centre
      float t = vAge / ${SHEET_LIFE.toFixed(2)}, rr = sqrt(r2);
      float patchR = ${SHEET_CORE.toFixed(2)} * (0.75 + 0.5 * F.x);
      float left = 1.0 - smoothstep(0.0, ${SHEET_CORE_GONE.toFixed(2)}, t); // share of the patch's radius still there
      float feed = 1.0 + ${SHEET_FEED.toFixed(1)} * (1.0 - left) * clamp(1.0 - rr / (1.8 * patchR), 0.0, 1.0);
      float wStrand = ${SHEET_WEB.toFixed(2)} * thin * lumps * feed, wKnot = ${SHEET_KNOT.toFixed(2)} * thin * feed;
      float wCore = patchR * left * ${SHEET_CELLS.toFixed(1)}; // all in web cells
      float strand = 1.0 - (F.y - F.x) / wStrand, knot = 1.0 - (F.z - F.x) / wKnot, core = 1.0 - rr / max(patchR * left, 1e-4);
      thick = max(max(strand * wStrand, knot * wKnot), core * wCore);
      return max(strand, max(knot, core));
    }
    // the paint: the metaballs packed into the shape (see SHEET_BALLS). How far inside it a point is (0 on its
    // contour, about 1 deep in a ball's middle), its thickness (the shape's, where the balls came from), and how that
    // depth changes across the sheet (its slope, for the shading: worked out with the sum, so it's one pass)
    float paint(vec2 uv, out float thick, out vec2 grad) {
      thick = 0.0; grad = vec2(0.0);
      if (dot(uv, uv) > 1.0) return -1.0;
      const float STEP = ${(1 / (SHEET_CELLS * SHEET_BALLS)).toFixed(4)}; // the balls' grid step (sheet units)
      // a full ball: overlapping its neighbours (solid), but reaching no further than the 3 × 3 grid cells round here
      const float R_FULL = ${((1.5 - SHEET_BALL_JITTER / 2) * 0.98).toFixed(3)} * STEP;
      vec2 g0 = floor(uv / STEP);
      float f = 0.0, tw = 0.0, tSum = 0.0;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 cell = g0 + vec2(x, y);
        vec2 c = (cell + 0.5 + ${SHEET_BALL_JITTER.toFixed(2)} * (hash2(cell + vSeed) - 0.5)) * STEP; // its centre
        float sThick, sIn = shapeAt(c, sThick);
        float R = R_FULL * clamp(sIn * ${SHEET_BALL_EDGE.toFixed(1)}, 0.0, 1.0); // its reach: by its depth in the shape
        if (R <= 0.0) continue;
        vec2 dp = uv - c;
        float d2 = dot(dp, dp) / (R * R);
        if (d2 >= 1.0) continue;
        float w = 1.0 - d2;
        f += w * w * w;
        grad -= 6.0 * w * w * dp / (R * R);
        tw += w * w * w; tSum += w * w * w * sThick;
      }
      thick = tw > 0.0 ? tSum / tw : 0.0;
      grad *= 2.0; // of (f − 0.5) / 0.5
      return (f - 0.5) / 0.5;
    }
    #if SHEET_MODE == 0
    float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
    // the hybrid's paint (see HYB_BALLS): how far inside (sheet units, a distance: < 0 outside) and the thickness
    vec3 hybBall; float hybBallW; // the nearest ball (centre, radius), and how much it, not the web, shapes this spot
    float paintHybrid(vec2 uv, out float thick) {
      thick = 0.0;
      float r2 = dot(uv, uv), t = vAge / ${SHEET_LIFE.toFixed(2)};
      if (r2 > 1.0) return -1.0;
      // the splotches: balls round the middle, drifting out and shrinking as it ages, merged softly
      float dB = 1e3, nearest = 1e3;
      for (int k = 0; k < ${HYB_BALLS}; k++) {
        vec2 h = hash2(vec2(vSeed, float(k) + 0.5)), g = hash2(vec2(float(k) + 3.7, vSeed));
        float ang = h.x * 6.283, out_ = sqrt(h.y);
        vec2 c = vec2(cos(ang), sin(ang)) * out_ * ${HYB_SPREAD.toFixed(2)} * (1.0 + ${SHEET_SPREAD.toFixed(2)} * t);
        float R = mix(${HYB_R_MIN.toFixed(2)}, ${HYB_R_MAX.toFixed(2)}, g.x) * (1.0 - 0.5 * out_) * (1.0 - ${HYB_SHRINK.toFixed(2)} * t);
        float db = length(uv - c) - R;
        if (db < nearest) { nearest = db; hybBall = vec3(c, R); }
        dB = smin(dB, db, ${HYB_BALL_K.toFixed(2)});
      }
      // the web (as shapeAt's: bent cell borders, swelling and pinching), thick near the splotches, gone away from them
      vec2 q = uv * ${SHEET_CELLS.toFixed(1)} + vSeed;
      float flow = vAge * ${SHEET_FLOW.toFixed(1)};
      q -= uv * ${SHEET_SPREAD.toFixed(2)} * ${SHEET_CELLS.toFixed(1)} * t;
      q += ${SHEET_WARP.toFixed(2)} * vec2(fbm(q * 0.6 + vec2(flow, 0.0)), fbm(q * 0.6 + 31.7 - vec2(0.0, flow)));
      vec3 F = worley(q);
      float near = exp(-max(dB, 0.0) / ${HYB_WEB_REACH.toFixed(2)}) * max((1.0 - t) * (1.0 - r2), 0.0);
      float wS = ${(SHEET_WEB * HYB_WEB_THICK).toFixed(3)} * near * (1.0 + ${SHEET_LUMPS.toFixed(2)} * vnoise(q * 2.7 + 13.3)), wK = ${(SHEET_KNOT * HYB_WEB_THICK).toFixed(3)} * near;
      float dW = min(F.y - F.x - wS, F.z - F.x - wK) * 0.5 / ${SHEET_CELLS.toFixed(1)}; // (cells to sheet units)
      float d = smin(dB, dW, ${HYB_BLEND.toFixed(2)});
      hybBallW = clamp(0.5 + 0.5 * (dW - dB) / ${HYB_BLEND.toFixed(2)}, 0.0, 1.0);
      thick = max(-d, 0.0) * ${SHEET_CELLS.toFixed(1)}; // in web cells, as shapeAt's
      return -d;
    }
    #endif
    void main() {
      // baked into the atlas, one fragment per blood pixel (see SHEET_TEXELS)
      vec2 uv = vUv, ex = dFdx(vUv), ey = dFdy(vUv); // here; one blood pixel right, and up (before any discard)
      float thick;
      #if SHEET_MODE == 1
      vec2 grad;
      float inside = paint(uv, thick, grad); // the dense metaballs
      vec2 gs = vec2(dot(grad, ex), dot(grad, ey)); // the depth's change over one blood pixel right, and up
      #else
      #if SHEET_MODE == 0
      float inside = paintHybrid(uv, thick);
      #else
      float inside = shapeAt(uv, thick); // the web alone
      #endif
      vec2 gs = vec2(dFdx(inside), dFdy(inside)); // its change over one blood pixel right, and up
      #endif
      // The rim (see SHEET_BEVEL): how many blood pixels in from the edge this is, from the field's depth over its
      // slope (screen x, y: view space's), and which way is inward. A bevel over the first SHEET_BEVEL of them, its
      // slope pointing straight in from the edge (so it turns smoothly along the contour), flat beyond
      float gl = max(length(gs), 1e-4);
      vec2 inward = toView(gs / gl); // (the tile's axes are the card's: see toView)
      float edgePx = inside / gl;
      if (edgePx <= 0.0) discard;
      float x = clamp(edgePx / ${SHEET_BEVEL.toFixed(1)}, 0.0, 1.0);
      float h = x * x * (3.0 - 2.0 * x); // 0 on the edge, 1 on the flat
      vec2 g = min(6.0 * x * (1.0 - x) / ${SHEET_BEVEL.toFixed(1)}, ${SHEET_BEVEL_TILT.toFixed(2)}) * inward; // its slope
      vec3 nPaint = normalize(vec3(-g, 1.0 / ${SHEET_RELIEF.toFixed(1)}));
      #if SHEET_MODE == 0
      // Where a ball shapes the paint, it's shaded as a dome (its normal a sphere's), so the light, its shadow side
      // and the glint fall as on a bead: more so as it ages, surface tension balling it up (see HYB_ROUND)
      {
        vec2 dv = (uv - hybBall.xy) / max(hybBall.z, 1e-4);
        float r = min(length(dv), 0.97);
        vec2 dTile = r > 1e-4 ? normalize(dv * vFit) * r : vec2(0.0);
        vec3 nDome = vec3(toView(dTile), sqrt(1.0 - r * r));
        float round_ = hybBallW * mix(${HYB_ROUND[0].toFixed(2)}, ${HYB_ROUND[1].toFixed(2)}, smoothstep(0.0, 0.7, vAge / ${SHEET_LIFE.toFixed(2)}));
        nPaint = normalize(mix(nPaint, nDome, round_));
        thick = mix(thick, max(thick, sqrt(1.0 - r * r) * ${SHEET_THICK.toFixed(2)}), round_); // deep in its middle
      }
      #endif
      // the flower's cup: flat where it hangs at the bottom, curving towards you higher up (and a little at the
      // sides up there), so it faces further down and out the higher it goes; the paint's own relief rides on it
      float up = clamp(vS.y * 0.5 + 0.5, 0.0, 1.0);
      float bend = ${(SHEET_CURL * SHEET_CUP).toFixed(2)}; // the bend's slope (from its height above), exaggerated
      vec3 nCup = normalize(vec3(-bend * 1.2 * vS.x * up, -bend * (up + 0.3 * vS.x * vS.x), 1.0));
      vec3 n = normalize(vec3(nPaint.xy + nCup.xy, nPaint.z * nCup.z));
      // Wet blood, lit as a liquid drop, like the lens blood: the body a lit red, darker only on its side away from
      // the light; lit from behind, light through the body; the light's own glint, one pale pixel; and on the side
      // facing the light, one faint pale pixel of rim. No darkening at the edges and no Fresnel: at a few pixels a drop
      // either draws an outline (tried: a dark one, and a blue-white ring under the strip lights).
      vec3 albedo = uBody;
      float diffuse = max(dot(n, vLightDir) * 0.6 + 0.4, 0.0); // wrapped, so the unlit side isn't black
      float spec = pow(max(dot(n, normalize(vLightDir + vec3(0.0, 0.0, 1.0))), 0.0), ${SHEET_GLOSS.toFixed(1)});
      // (strands and specks stay flat: the glint and rim only where a ball, a drop, shapes the paint)
      // each drop its own shade (some darker, some brighter)
      #if SHEET_MODE == 0
      float drop = step(0.5, hybBallW), dropSeed = fract(sin(dot(floor(hybBall.xy * 97.0), vec2(12.9898, 78.233))) * 43758.5453);
      albedo *= mix(1.0, 0.7 + 0.5 * dropSeed, drop);
      #else
      float drop = 0.0, dropSeed = 0.0;
      #endif
      // the glitter: on or off per blood pixel (strands and specks too), mostly on the bevel facing the light, warm white
      // and bright enough to bloom, as the lens blood's glints and the steel through the floor's stains glint
      // (as well as the glint proper, a random share of the outermost pixels on the side facing the light twinkle)
      float facing = step(edgePx, 1.0) * smoothstep(0.35, 0.75, dot(-inward, normalize(vLightDir.xy + vec2(1e-5))));
      float twinkle = facing * step(1.0 - ${SHEET_TWINKLE.toFixed(2)}, fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453));
      float glint = max(smoothstep(0.2, 0.5, spec), 0.6 * twinkle);
      vec3 sparkle = vec3(1.0, 0.86, 0.8) * dot(min(vLight, vec3(4.0)), vec3(0.2126, 0.7152, 0.0722));
      // the lit edge: the outermost blood pixel of every shape, on its side facing the light (threads: one bright edge)
      float litEdge = drop * facing;
      // the light on it: its brightness, but only SHEET_LIGHT_TINT of its colour, so blood stays the floor stains' red
      // under the blue-white strips (red under blue light has little red to give back: it went grey-blue)
      vec3 light = mix(vec3(dot(vLight, vec3(0.2126, 0.7152, 0.0722))), vLight, ${SHEET_LIGHT_TINT.toFixed(2)});
      vec3 lit = min(light, vec3(2.0)); // what a highlight reflects (capped, so a glint doesn't blow out the bloom)
      vec3 col = albedo * light * (0.25 + 0.75 * diffuse)
        + uBody * light * ${SHEET_TRANSLUCENT.toFixed(2)} * h * max(-vLightDir.z, 0.0) // light through it, from behind
        + sparkle * ${SHEET_GLINT.toFixed(2)} * glint
        + lit * ${SHEET_EDGE_LIGHT.toFixed(2)} * litEdge * (1.0 - glint); // the rim: pale (the light's colour)
      gl_FragColor = vec4(col, 1.0); // (fog's added on the card: see sheetCards)
    }`,
});
sheetMat.defines = { SHEET_MODE: sheetMode };
export function nextSheetMode() { // (M, in debug mode)
  sheetMode = (sheetMode + 1) % SHEET_MODES.length;
  sheetMat.defines = { SHEET_MODE: sheetMode };
  sheetMat.needsUpdate = true;
}
const sheets = new THREE.Mesh(sheetGeo, sheetMat); // the bake: every live splat into its tile of sheetAtlas
sheets.frustumCulled = false;
export const sheetScene = new THREE.Scene(), _clearColor = new THREE.Color();
sheetScene.add(sheets);
const sheetAtlas = new THREE.WebGLRenderTarget(SHEET_ATLAS_COLS * SHEET_TEXELS, SHEET_ATLAS_ROWS * SHEET_TEXELS,
  { type: THREE.HalfFloatType, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, depthBuffer: false });
// The cards, in the scene at full resolution: bent and turned to you as the bake had them, each reading its tile
const sheetCards = new THREE.Mesh(sheetGeo, new THREE.ShaderMaterial({
  uniforms: { uAtlas: { value: sheetAtlas.texture }, uFogColor: gooMat.uniforms.uFogColor, uFogDensity: gooMat.uniforms.uFogDensity },
  vertexShader: `
    attribute vec2 corner;
    attribute vec3 aA, aB;
    attribute float aScale;
    varying vec2 vUv;
    varying float vTile, vZ;
    void main() {
      vec4 a = viewMatrix * vec4(aA, 1.0), b = viewMatrix * vec4(aB, 1.0), c = (a + b) * 0.5;
      vec2 ax = b.xy - a.xy;
      float len = length(ax);
      vec2 dir = len > 1e-4 ? ax / len : vec2(1.0, 0.0), nrm = vec2(-dir.y, dir.x);
      vec2 half_ = vec2(0.5 * len + ${SHEET_PAD.toFixed(3)}, 0.5 * len * ${SHEET_WIDTH.toFixed(2)} + ${SHEET_PAD.toFixed(3)}) * ${SHEET_SCALE.toFixed(1)} * aScale;
      vec2 off = dir * corner.x * half_.x + nrm * corner.y * half_.y;
      float size = length(half_);
      vec2 s = off / size;
      c.xy += off;
      float up = clamp(s.y * 0.5 + 0.5, 0.0, 1.0); // the bend (as the bake's)
      c.z += ${SHEET_CURL.toFixed(2)} * size * (up * up + 0.6 * s.x * s.x * up);
      vUv = corner * half_ / max(half_.x, half_.y) * 0.5 + 0.5; vTile = float(gl_InstanceID); vZ = -c.z; // (as the bake fit it)
      gl_Position = projectionMatrix * c;
    }`,
  fragmentShader: `
    uniform sampler2D uAtlas;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    varying vec2 vUv;
    varying float vTile, vZ;
    void main() {
      float t = floor(vTile + 0.5);
      ivec2 tile = ivec2(mod(t, ${SHEET_ATLAS_COLS}.0), floor(t / ${SHEET_ATLAS_COLS}.0));
      ivec2 texel = tile * ${SHEET_TEXELS} + clamp(ivec2(vUv * ${SHEET_TEXELS}.0), ivec2(0), ivec2(${SHEET_TEXELS - 1}));
      vec4 b = texelFetch(uAtlas, texel, 0); // no interpolation: its blood pixels, crisp
      if (b.a < 0.5) discard; // no paint here
      gl_FragColor = vec4(mix(b.rgb, uFogColor, 1.0 - exp(-uFogDensity * uFogDensity * vZ * vZ)), 1.0);
    }`,
}));
sheetCards.frustumCulled = false;
scene.add(sheetCards);
export function bakeSheets() { // before the scene's drawn: the live splats' paint, into their tiles of sheetAtlas
  if (!sheetGeo.instanceCount) return;
  renderer.getClearColor(_clearColor);
  const alpha = renderer.getClearAlpha();
  renderer.setRenderTarget(sheetAtlas);
  renderer.setClearColor(0x000000, 0); // a = 0: no paint
  renderer.clear();
  renderer.render(sheetScene, camera); // (camera: the bake lights and bends them as you see them)
  renderer.setRenderTarget(null);
  renderer.setClearColor(_clearColor, alpha);
}
// Each frame: drop sheets whose gob's ends have landed (or whose slots were reused), and place the rest
function updateSheets() {
  let m = 0;
  for (let i = 0; i < SHEET_MAX; i++) {
    if (!shAlive[i]) continue;
    const a = shA[i], b = shB[i], age = bloodTime - shBirth[i];
    if (age > SHEET_LIFE || !flAlive[a] || !flAlive[b] || flSerial[a] !== shSA[i] || flSerial[b] !== shSB[i]) { shAlive[i] = 0; continue; }
    const ka = a * 3, kb = b * 3;
    shAttrA.array.set(flP.subarray(ka, ka + 3), m * 3);
    shAttrB.array.set(flP.subarray(kb, kb + 3), m * 3);
    bloodLight((flP[ka] + flP[kb]) / 2, (flP[ka + 1] + flP[kb + 1]) / 2, (flP[ka + 2] + flP[kb + 2]) / 2, shAttrLight.array, m * 3, shAttrLightDir.array);
    shAttrSeed.array[m] = shSeed[i];
    shAttrScale.array[m] = shScale[i];
    shAttrAge.array[m++] = age;
  }
  sheetGeo.instanceCount = m;
  for (const at of [shAttrA, shAttrB, shAttrLight, shAttrLightDir, shAttrSeed, shAttrAge, shAttrScale]) at.needsUpdate = true;
}

// Stepped like the demons' animation (opts.stepped, the N key): the fluid still simulates at FL_STEP, but what you
// see of the blood (the splats' places and ages, the stains' spreading and drips) only changes BLOOD_FPS times a
// second, held in between. One shared clock that subtracts its step, so it averages exactly BLOOD_FPS on any display
// and every splat changes on the same frames; a new burst shows at once rather than waiting for the next tick.
const BLOOD_FPS = Infinity; // every frame (the display's max); a number steps it, e.g. 12 like the demons
export let bloodTime = 0, flAccum = 0, bloodTick = 0, bloodFresh = false; // (bloodTime: the stains' clock, see spawnDecal)
export const showBlood = () => (bloodFresh = true); // a burst (see burstBlood): shown at once
export function updateBlood(dt) {
  bloodTime += dt;
  decalMat.uniforms.fogDensity.value = scene.fog.density;
  gooMat.uniforms.uFogColor.value.copy(scene.fog.color);
  gooMat.uniforms.uFogDensity.value = scene.fog.density;
  // fixed steps, at most one a frame: a slow frame drops time (the blood slows a little) rather than doubling up, which
  // on a slow CPU made the next frame slower still
  flAccum = Math.min(flAccum + dt, FL_STEP);
  for (; flAccum >= FL_STEP; flAccum -= FL_STEP) flStep(FL_STEP);
  bloodTick += dt;
  if (opts.stepped && bloodTick < 1 / BLOOD_FPS && !bloodFresh) return; // hold what's shown
  bloodTick = opts.stepped && !bloodFresh ? Math.min(bloodTick - 1 / BLOOD_FPS, 1 / BLOOD_FPS) : 0;
  bloodFresh = false;
  decalMat.uniforms.uTime.value = bloodTime;
  let n = 0;
  for (let i = 0; i < FL_MAX; i++) {
    if (!flAlive[i]) continue;
    const k = i * 3;
    splatPos.array.set(flP.subarray(k, k + 3), 3 * n);
    bloodLight(flP[k], flP[k + 1], flP[k + 2], splatLight.array, 3 * n++);
  }
  splatGeo.instanceCount = n;
  splatPos.needsUpdate = splatLight.needsUpdate = true;
  gooQuad.visible = BLOOD_METABALLS && n > 0;
  updateSheets();
}
// The light on a blood particle, as the demons get it: the sprite stage's lights (the pools near you and the muzzle
// flashes) and its dim environment, evaluated like three.js does for a matte surface (radiance per unit albedo:
// intensity × falloff × cos / π), with no normal (an average cos of 0.6). The ceiling's area lights count as small
// down-facing emitters (intensity × area × the cosine below them). No occlusion, like the sprites.
const stageLights = [];
stage.traverse((o) => o.isLight && stageLights.push(o));
// dirOut (optional): the main direction the light comes from, each light's unit direction weighted by its brightness
// (straight up when nothing's lit)
export function bloodLight(x, y, z, out, at, dirOut) {
  let r = stage.environmentIntensity, g = r, b = r, lx = 0, ly = 1e-4, lz = 0;
  for (const l of stageLights) {
    if (!(l.intensity > 0)) continue;
    let e = l.intensity * 0.6 / Math.PI, dx = l.position.x, dy = l.position.y, dz = l.position.z; // a sun: from its position
    if (!l.isDirectionalLight) {
      dx -= x; dy -= y; dz -= z;
      const d2 = dx * dx + dy * dy + dz * dz;
      e /= Math.max(d2, 0.01);
      if (l.isRectAreaLight) e *= l.width * l.height * Math.max(dy, 0) / Math.sqrt(d2);
      else if (l.distance > 0) { const q = d2 / (l.distance * l.distance); e *= Math.max(1 - q * q, 0) ** 2; }
    }
    r += e * l.color.r; g += e * l.color.g; b += e * l.color.b;
    const w = e * (l.color.r + l.color.g + l.color.b) / Math.max(Math.hypot(dx, dy, dz), 1e-6);
    lx += dx * w; ly += dy * w; lz += dz * w;
  }
  out[at] = r; out[at + 1] = g; out[at + 2] = b;
  if (dirOut) { const n = Math.hypot(lx, ly, lz); dirOut[at] = lx / n; dirOut[at + 1] = ly / n; dirOut[at + 2] = lz / n; }
}
// Splat the particles into the field, from the camera as it's about to render (shake included)
const _clear = new THREE.Color();
export function drawBloodField() {
  if (!gooQuad.visible) return;
  const W = composer.renderTarget1.width, H = composer.renderTarget1.height; // (the world's pixels: it's drawn in there)
  fieldRT.setSize(Math.ceil(W / GOO_PIXEL), Math.ceil(H / GOO_PIXEL));
  lightRT.setSize(fieldRT.width, fieldRT.height);
  splatMat.uniforms.uMinPerZ.value = GOO_MIN_SPLAT * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / fieldRT.height;
  gooMat.uniforms.uRes.value.set(W, H);
  const target = renderer.getRenderTarget(), alpha = renderer.getClearAlpha();
  renderer.getClearColor(_clear);
  renderer.setClearColor(0x000000, 0);
  for (const [rt, mat] of [[fieldRT, splatMat], [lightRT, splatLightMat]]) {
    splats.material = mat;
    renderer.setRenderTarget(rt);
    renderer.render(fieldScene, camera);
  }
  renderer.setRenderTarget(target);
  renderer.setClearColor(_clear, alpha);
}

