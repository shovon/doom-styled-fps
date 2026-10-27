// The surfaces' materials, reading the blood maps (addFloorBlood, addTopBlood, addWallBlood)
import { BLOOD_PX, TOP_BLOOD_HALF, floorBloodTex, topBloodTex, WALL_BLOOD_ROWS, FACE_PX, COLUMN_PX, PLAT_FACE_PX,
  wallBloodTex } from './blood-maps.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { TILE } from './tiles.js';
import { ARENA, WALL_ROWS, COLUMN_SIDE, COLUMNS, COLUMN_APOTHEM, PLATFORM_SIDE, PLATFORM_H, PLATFORM_APOTHEM } from './arena.js';

// A surface's material reads a blood map: where there's blood, its colour, gloss and bulge replace the steel's.
// Thin blood is a film the steel shows through, its reflection tinted (as the stickers' multiply did): BLOOD_FILM
// wet and dry; thick blood hides it, an opaque coat (BLOOD_COAT wet and dry), glossy while wet
const bloodSrgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const BLOOD_FILM = [new THREE.Color(0.62, 0.04, 0.06), new THREE.Color(0.28, 0.035, 0.035)];
const BLOOD_COAT = [bloodSrgb(0.66, 0.02, 0.035), bloodSrgb(0.3, 0.03, 0.025)]; // paint red; dried, darker
const BLOOD_RELIEF = 4; // how steep its edges bulge
// where this pixel is in the map: GLSL that sets bOn, bt (its texel), and the surface's world normal bN and the
// directions its texels run along, bU (x) and bV (y); vBloodW: its world position
const FLOOR_BLOOD_AT = `
  if (vBloodW.y < 0.05 && max(abs(vBloodW.x), abs(vBloodW.z)) < ${ARENA.toFixed(1)}) { // (the ceiling shares materials)
    bOn = true;
    bt = ivec2(floor((vBloodW.xz + ${ARENA.toFixed(1)}) * ${BLOOD_PX.toFixed(1)}));
  }`;
const TOP_BLOOD_AT = `
  if (abs(vBloodW.y - ${PLATFORM_H.toFixed(2)}) < 0.05 && max(abs(vBloodW.x), abs(vBloodW.z)) < ${TOP_BLOOD_HALF.toFixed(1)}) {
    bOn = true;
    bt = ivec2(floor((vBloodW.xz + ${TOP_BLOOD_HALF.toFixed(1)}) * ${BLOOD_PX.toFixed(1)}));
  }`;
const WALL_BLOOD_AT = `
  if (vBloodW.y >= 0.0 && vBloodW.y < ${(WALL_ROWS * TILE).toFixed(1)}) {
    vec3 p = vBloodW;
    const float A = ${ARENA.toFixed(1)}, PX = ${BLOOD_PX.toFixed(1)};
    int v = int(floor(p.y * PX));
    bV = vec3(0.0, 1.0, 0.0);
    if (abs(p.x) > A - 0.05 && abs(p.z) < A) {
      bOn = true; bt = ivec2(floor((p.z + A) * PX), (p.x > 0.0 ? 0 : 1) * ${WALL_BLOOD_ROWS} + v);
      bN = vec3(-sign(p.x), 0.0, 0.0); bU = vec3(0.0, 0.0, 1.0);
    } else if (abs(p.z) > A - 0.05 && abs(p.x) < A) {
      bOn = true; bt = ivec2(floor((p.x + A) * PX), (p.z > 0.0 ? 2 : 3) * ${WALL_BLOOD_ROWS} + v);
      bN = vec3(0.0, 0.0, -sign(p.z)); bU = vec3(1.0, 0.0, 0.0);
    } else if (p.y < ${PLATFORM_H.toFixed(2)} && length(p.xz) < ${(PLATFORM_APOTHEM / Math.cos(Math.PI / 8) + 0.1).toFixed(2)}) { // a platform side?
      for (int f = 0; f < 8; f++) {
        float a = float(f) * ${(Math.PI / 4).toFixed(6)};
        vec2 n = vec2(sin(a), cos(a)), tg = vec2(cos(a), -sin(a));
        float s = dot(p.xz, tg);
        if (abs(dot(p.xz, n) - ${PLATFORM_APOTHEM.toFixed(4)}) < 0.05 && abs(s) <= ${(PLATFORM_SIDE / 2).toFixed(2)}) {
          bOn = true;
          bt = ivec2(f * ${PLAT_FACE_PX} + int(floor((s + ${(PLATFORM_SIDE / 2).toFixed(2)}) * PX)), ${5 * WALL_BLOOD_ROWS} + v);
          bN = vec3(n.x, 0.0, n.y); bU = vec3(tg.x, 0.0, tg.y);
        }
      }
    } else {
      ${COLUMNS.map((c, k) => `{
        vec2 d = p.xz - vec2(${c.x.toFixed(1)}, ${c.y.toFixed(1)});
        float f = mod(floor(atan(d.x, d.y) / ${(Math.PI / 4).toFixed(6)} + 0.5) + 8.0, 8.0), a = f * ${(Math.PI / 4).toFixed(6)};
        vec2 n = vec2(sin(a), cos(a)), tg = vec2(cos(a), -sin(a));
        float s = dot(d, tg);
        if (abs(dot(d, n) - ${COLUMN_APOTHEM.toFixed(4)}) < 0.05 && abs(s) <= ${(COLUMN_SIDE / 2).toFixed(2)}) {
          bOn = true;
          bt = ivec2(${k * COLUMN_PX} + int(f) * ${FACE_PX} + int(floor((s + ${(COLUMN_SIDE / 2).toFixed(2)}) * PX)), ${4 * WALL_BLOOD_ROWS} + v);
          bN = vec3(n.x, 0.0, n.y); bU = vec3(tg.x, 0.0, tg.y);
        }
      }`).join('\n      ')}
    }
  }`;
// (declared, not const: the floor and walls are built, and call these, before the maps exist; the maps are only
// read once the shaders compile, at the first frame)
function addBlood(mat, kind) { // kind: 'floor', 'top' (the platform's) or 'wall'
  if (mat.userData.blood) return; // (materials are shared: once each)
  mat.userData.blood = true;
  const before = mat.onBeforeCompile, key = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => `${key ? key.call(mat) : ''}:blood:${kind}`;
  mat.onBeforeCompile = (shader, r) => {
    before?.(shader, r);
    const at = { wall: WALL_BLOOD_AT, top: TOP_BLOOD_AT, floor: FLOOR_BLOOD_AT }[kind];
    shader.uniforms.uBloodTex = { wall: wallBloodTex, top: topBloodTex, floor: floorBloodTex }[kind];
    const c = (v) => `vec3(${v.r.toFixed(4)}, ${v.g.toFixed(4)}, ${v.b.toFixed(4)})`;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBloodW;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  {
    vec4 bw = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      bw = instanceMatrix * bw;
    #endif
    vBloodW = (modelMatrix * bw).xyz;
  }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uBloodTex;
varying vec3 vBloodW;
float bloodDepth(ivec2 t) { // how thick the blood stands at a texel: piles up, levelling off
  return 1.0 - exp(-1.5 * texelFetch(uBloodTex, clamp(t, ivec2(0), textureSize(uBloodTex, 0) - 1), 0).r);
}`)
      .replace('#include <lights_physical_fragment>', `
  float bloodOn = 0.0;
  {
    bool bOn = false;
    ivec2 bt = ivec2(0);
    vec3 bN = vec3(0.0, 1.0, 0.0), bU = vec3(1.0, 0.0, 0.0), bV = vec3(0.0, 0.0, 1.0);
#ifdef USE_SPECULAR_INTENSITYMAP
    vec2 bUvX = dFdx(vSpecularIntensityMapUv), bUvY = dFdy(vSpecularIntensityMapUv); // (here: before any branching)
    vec3 bWX = dFdx(vBloodW), bWY = dFdy(vBloodW);
#endif
    ${at}
    vec2 b = bOn ? texelFetch(uBloodTex, bt, 0).rg : vec2(0.0);
    // Holes: the vents and slits are bottomless, so blood falls through: none over a hole (the tile's specular strength
    // is 0 there: its ORM alpha, see tools/plate_textures.py), and round one the blood ends in the same border it has
    // where it meets bare floor (the hole counts as no blood when its surface is worked out: see g below; it's the
    // blood's own edge, not the tile's normal map). solid(o): is the surface o blood texels along (bU, bV) solid? Its uv
    // there, from how the surface's uv and world position change across the screen (the tiles lie at random quarter
    // turns, so the map's axes aren't the uv's)
    vec2 bStepU = vec2(0.0), bStepV = vec2(0.0);
#ifdef USE_SPECULAR_INTENSITYMAP
    if (texture2D(specularIntensityMap, vSpecularIntensityMapUv).a < 0.5) b = vec2(0.0);
    mat2 bW = mat2(dot(bWX, bU), dot(bWX, bV), dot(bWY, bU), dot(bWY, bV)); // world (along bU, bV) per screen x, y
    if (abs(determinant(bW)) > 1e-12) {
      mat2 bJ = mat2(bUvX, bUvY) * inverse(bW); // world (m) → uv
      bStepU = bJ * vec2(${(1 / BLOOD_PX).toFixed(5)}, 0.0); bStepV = bJ * vec2(0.0, ${(1 / BLOOD_PX).toFixed(5)});
    }
    #define BLOOD_SOLID(o) step(0.5, textureLod(specularIntensityMap, vSpecularIntensityMapUv + bStepU * float(o.x) + bStepV * float(o.y), 0.0).a)
#else
    #define BLOOD_SOLID(o) 1.0
#endif
    if (b.r > 0.01) {
      bloodOn = 1.0;
      float thick = bloodDepth(bt);
      // wet: how much of its blood is still wet; the thin edges dry first, the thick middle last (the coffee ring)
      float wet = smoothstep(0.05, 0.5, clamp(b.g / b.r, 0.0, 1.0) * (0.5 + 1.5 * thick));
      float deep = smoothstep(0.05, 0.35, thick); // 0: a film over the steel; 1: an opaque coat (most of it: paint)
      vec3 film = diffuseColor.rgb * mix(${c(BLOOD_FILM[1])}, ${c(BLOOD_FILM[0])}, wet), coat = mix(${c(BLOOD_COAT[1])}, ${c(BLOOD_COAT[0])}, wet);
      diffuseColor.rgb = mix(film, coat, deep);
      metalnessFactor *= 1.0 - deep;
      roughnessFactor = mix(mix(max(roughnessFactor, 0.6), 0.75, deep), mix(0.15, 0.06, deep), wet);
      // its surface: from how its depth changes to the neighbouring texels (per texel: the surface's chunky pixels)
      // (a hole next to it counts as no blood, as bare floor does: the border)
      #define BLOOD_H(o) (bloodDepth(bt + o) * BLOOD_SOLID(o))
      vec2 g = vec2(BLOOD_H(ivec2(1, 0)) - BLOOD_H(ivec2(-1, 0)), BLOOD_H(ivec2(0, 1)) - BLOOD_H(ivec2(0, -1))) * 0.5;
      vec3 nBlood = normalize((viewMatrix * vec4(normalize(bN - (g.x * bU + g.y * bV) * ${BLOOD_RELIEF.toFixed(1)}), 0.0)).xyz);
      // wet, it's its own surface (bulging at its edges); dried, a crust that follows the surface under it: its normal
      // map's bumps and grooves (normal here is still the surface's)
      normal = normalize(mix(normal, nBlood, wet));
      totalEmissiveRadiance *= 0.1; // a lamp under it barely shows
    }
  }
#include <lights_physical_fragment>
  if (bloodOn > 0.0) { // the coat's a liquid's (or dried blood's) sheen, the film's the steel's tinted; no brush streaks
    material.specularColor = mix(vec3(0.04), diffuseColor.rgb, metalnessFactor);
    material.specularF90 = 1.0;
#ifdef USE_ANISOTROPY
    material.anisotropy = 0.0;
    material.alphaT = pow2(material.roughness);
#endif
  }`);
  };
}
export function addFloorBlood(mat) { addBlood(mat, 'floor'); }
export function addWallBlood(mat) { addBlood(mat, 'wall'); }
export function addTopBlood(mat) { addBlood(mat, 'top'); }

