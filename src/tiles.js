// The floor's tiles: which goes where, and their materials (grime, parallax, the baked fixture light)
import { renderer } from './setup.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';

// Floor: 400 m square of 2 m steel tiles, each picked at random from FLOOR_TILES by weight. PBR sets authored by
// tools/plate_textures.py; every map is point-sampled up close so highlights land per texel (the chunky
// "realistic pixel art" look). One InstancedMesh per tile type = one draw call each.
// name: share of tiles. Blank plates (bare or covered) stay 45%; each type keeps most of its share for the plain
// version, with a structural variant or two taking the rest
export const FLOOR_TILES = {
  plain: 0.18, plain_bolted: 0.06, cover: 0.1, cover_hatch: 0.05,
  vent: 0.19, vent_patch: 0.06, slits: 0.19, slits_strapped: 0.06, sidelight_left: 0, // the lamp: not at random (below)
  plain_welded: 0, weld_end: 0, weld_corner: 0, weld_tee: 0, weld_cross: 0, // the weld seams: laid out as a maze (see platform.js)
}, TILE = 2, TILES = 200;
// The floor lights run in rows (east–west), every FLOOR_LIGHT_EVERY rows: along the
// row, a FLOOR_LAMP panel (one thin light slit down a side) with its slit on the right, one with it on the left, so
// the two slits pair up at their shared edge, then a plain tile; and again
export const FLOOR_LIGHT_EVERY = 3, FLOOR_LAMP = 'sidelight_left';
// Tiles that glow, and how hard: emissiveIntensity > 1 is brighter than white in the HDR buffer, before ACES
// tone mapping. It glows in the dark and under a flash, but lights nothing else (that needs real lights).
// 5 puts the lens centre at ~3× white (luminance): over BLOOM_THRESHOLD, still LED-blue rather than blown out.
// The wall fixture (the columns' lamps): its frosted, diffusing cover dims and spreads the tube (measured peak ≈ 0.33 × glow), so it needs ~2×
// the others' glow to clear the bloom threshold: 10 puts the cover's peak at ~3.3, like the other strips' lens centres.
const TILE_GLOW = { light: 5, slitlight: 5, sidelight: 5, sidelight_left: 5, walllight: 10 };
// Fixture lighting. true: every static fixture baked into a light volume, read as one light per pixel (~3 ms/frame at
// 1600×1000). false: real lights, pooled over the nearest, in the world as well as for the demon sprites and the
// gun: points for the floor strips, the columns' lamps and slits, rect area lights for the ceiling strips.
export const BAKE_FIXTURES = false;
export const texLoader = new THREE.TextureLoader();
export const loadMap = (file, colorSpace = THREE.NoColorSpace) => {
  const t = texLoader.load(`textures/${file}.png`);
  t.colorSpace = colorSpace; // albedo and emissive are colour; normal/ORM are data and stay linear
  t.magFilter = THREE.NearestFilter; // mipmaps still keep the distance from shimmering
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
};
export const tileGeo = new THREE.PlaneGeometry(TILE, TILE).rotateX(-Math.PI / 2);
const tileWeights = Object.values(FLOOR_TILES);
export const floorLightType = Object.keys(FLOOR_TILES).indexOf(FLOOR_LAMP);
export const tilePick = Array.from({ length: TILES * TILES }, (_, cell) => {
  if (Math.floor(cell / TILES) % FLOOR_LIGHT_EVERY === 0 && cell % TILES % 3 < 2) return floorLightType; // a lamp row's slits
  let r = Math.random() * tileWeights.reduce((a, w) => a + w, 0), type = 0;
  while (type < tileWeights.length - 1 && (r -= tileWeights[type]) > 0) type++;
  return type;
});
// Variation: every tile is laid at a random turn about its face, so one tile type's baked smudges and brush
// direction don't sit the same way everywhere. Rotations only: a mirrored instance would turn inside out (culled).
export const ONE = new THREE.Vector3(1, 1, 1), AXIS_Y = new THREE.Vector3(0, 1, 0), AXIS_Z = new THREE.Vector3(0, 0, 1);
export const randomTurn = (axis, steps) => new THREE.Quaternion().setFromAxisAngle(axis, ((Math.random() * steps) | 0) * (2 * Math.PI / steps));
export const tilePos = (cell, y = 0) =>
  new THREE.Vector3(((cell % TILES) - TILES / 2 + 0.5) * TILE, y, (Math.floor(cell / TILES) - TILES / 2 + 0.5) * TILE);
const tileMats = {}; // name → material, built on first use and shared by the floor, wall and ceiling
// key: a separately tunable copy of a tile's material (e.g. a light colour); drip: for vertical surfaces, its grime is
// the moisture streaks (see addGrime) instead of the scuff patches
export function tileMat(name, key = name, { drip = false } = {}) {
  if (tileMats[key]) return tileMats[key];
  const orm = loadMap(`${name}_orm`);
  // Physical, not Standard, for the per-texel specular strength (ORM alpha): it zeroes the ~4% sheen every
  // non-metal has, so the black holes stay black even under a muzzle flash
  const mat = new THREE.MeshPhysicalMaterial({
    map: loadMap(name, THREE.SRGBColorSpace), normalMap: loadMap(`${name}_n`),
    aoMap: orm, roughnessMap: orm, metalnessMap: orm, specularIntensityMap: orm,
    metalness: 1, // the maps multiply these factors, and metalness defaults to 0 (= no metal at all)
    // Brushed steel: rougher across the brush lines than along them, so highlights streak across the lines
    anisotropy: 1, anisotropyMap: loadMap(`${name}_a`),
    envMapIntensity: 0.47, // metal has no diffuse: reflections are most of what you see. Tuned with the
    // stainless base colour (0.56 linear) to keep the floor as bright as the old darker plate at 0.8
    ...(TILE_GLOW[name] && { emissive: 0xffffff, emissiveMap: loadMap(`${name}_e`, THREE.SRGBColorSpace), emissiveIntensity: TILE_GLOW[name] }),
    shadowSide: THREE.DoubleSide, // single-sided wall tiles still cast shadows whichever way they face the sun
  });
  addGrime(mat, drip, name === 'treadplate'); // the rubber has no holes or lenses to keep clean: dirt goes anywhere
  if (BAKE_FIXTURES) addBakedLight(mat);
  return (tileMats[key] = mat);
}

// Scuff grime, per tile: the generator bakes only the dirt packed into cavities; the scuff patches live in one
// shared texture (textures/grime.png, GRIME_N = 256 px) and each tile instance reads its own random 64 px window
// of it (instance attribute grimeOffset, whole pixels so it stays on the tile's pixel grid). Composited like
// the baked grime, a dielectric film: darker, rough, not metal, no brush streaks; only where the tile is bare
// steel (its metalness), so holes, lenses and the light housing stay clean.
// Walls, columns and the platform's sides instead get drip grime (textures/grime_drip.png): moisture streaks. Read
// the same way as the scuffs, a window per panel (the drip texture squeezed 4× across, so the streaks are dense),
// each panel its own patch of streaks.
export const GRIME_TILE = 64 / 256; // a tile's window, in grime-texture UVs
const grimeMap = loadMap('grime'), dripMap = loadMap('grime_drip');
grimeMap.wrapS = grimeMap.wrapT = dripMap.wrapS = THREE.RepeatWrapping;
function addGrime(mat, drip = false, everywhere = false) {
  // Its own program per variant: three.js keys programs by onBeforeCompile's source text, the same for every
  // variant here, so otherwise whichever compiled first would be used for all of them
  mat.customProgramCacheKey = () => `grime:${everywhere}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.grimeMap = { value: drip ? dripMap : grimeMap };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 grimeOffset;\nvarying vec2 vGrimeUv;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n  vGrimeUv = uv * ${GRIME_TILE.toFixed(4)} + grimeOffset;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D grimeMap;\nvarying vec2 vGrimeUv;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  float grimePatch = texture(grimeMap, vGrimeUv).r * ${everywhere ? '1.0' : 'metalnessFactor'};
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.046, 0.042), grimePatch); // GRIME, GRIME_ROUGH in the generator
  roughnessFactor = mix(roughnessFactor, 0.85, grimePatch);
  metalnessFactor *= 1.0 - grimePatch;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_ANISOTROPY
  material.anisotropy *= 1.0 - grimePatch; // grime hides the brush lines
  material.alphaT = mix(pow2(material.roughness), 1.0, pow2(material.anisotropy));
#endif`);
  };
}
// Baked fixture light: every static fixture (floor, wall and ceiling strips, column slits) is summed at load into
// one light volume over the arena (see the bake, after the light pools): per 0.5 m cell, the light arriving and its
// dominant direction. Each tile shades it as a single virtual light from that direction, so the metal's highlights,
// brush streaks and normal maps still respond, at the cost of one light instead of a pool of dozens.
export const bakedUniforms = {
  bakedLight: { value: null }, bakedOrigin: { value: new THREE.Vector3() }, bakedSize: { value: new THREE.Vector3(1, 1, 1) },
  bakedColor: { value: new THREE.Color() },
};
function addBakedLight(mat) {
  const before = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    Object.assign(shader.uniforms, bakedUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 bakedOrigin, bakedSize;\nvarying vec3 vBakedUvw;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  { // world position, nudged 0.3 m off the surface so the volume is read on the lit side
    vec4 bp = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      bp = instanceMatrix * bp;
    #endif
    vec3 bn = normalize((vec4(transformedNormal, 0.0) * viewMatrix).xyz);
    vBakedUvw = ((modelMatrix * bp).xyz + bn * 0.3 - bakedOrigin) / bakedSize;
  }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform highp sampler3D bakedLight;\nuniform vec3 bakedColor;\nvarying vec3 vBakedUvw;')
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
  { // the baked fixtures, as one light: rgb = direction × light (world space), a = total light arriving
    vec4 bk = texture(bakedLight, vBakedUvw);
    if (bk.a > 1e-4) {
      IncidentLight baked;
      vec3 d = dot(bk.xyz, bk.xyz) > 1e-8 ? bk.xyz : vec3(0.0, 1.0, 0.0);
      baked.direction = normalize((viewMatrix * vec4(d, 0.0)).xyz);
      baked.color = bakedColor * bk.a;
      baked.visible = true;
      RE_Direct(baked, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
    }
  }`);
  };
}

// Each instanced tile mesh gets its own copy of the geometry, carrying a random grime window per instance
// span: how tall the mesh's window is (grime-texture v): its offset kept so the window stays in the texture (the drip
// texture doesn't tile up and down: clamped past its top, its top row ran on up as stripes)
export const withGrimeOffsets = (geo, count, span = 0) => geo.clone().setAttribute('grimeOffset', new THREE.InstancedBufferAttribute(
  Float32Array.from({ length: count * 2 }, (_, i) => ((Math.random() * 256 * (i % 2 ? 1 - Math.min(span, 1) : 1)) | 0) / 256), 2));

// Parallax mapping, pixel-art style: per pixel, march the eye ray down into a depth map through whole layers
// and read every other map where it lands, so recessed parts slide behind the rim as you move (a normal map
// only tilts the shading). three.js has none built in, so it's injected into the physical shader:
// - the tangent frame comes from screen-space derivatives (no tangent attribute needed)
// - the clearcoat keeps the surface UVs: it's a clear cover lying on top, not down in the recess
// - lookups use the unshifted UVs' gradients for mip selection, since the shifted UVs jump at layer edges
// depth: the depth map's full scale in UV units. coverOpacity: how milky the clearcoat cover is (0 = clear): over
// its mask, what's seen through it blends that far toward frosted white and dims by as much, glow included.
// The clearcoat map carries the cover: R = gloss, G = dirt (grime: dark, rough, blocks the glow), B = cover.
// coverScatter: how much the cover diffuses what's behind it (0 = clear). Over the cover, 8 eye rays tilted by up
// to that much (mostly across the ridges, the way a prismatic cover spreads light) are each marched into the
// depth map and the colour and glow they land on averaged: deeper things blur more, like real frosted plastic.
export function addParallax(mat, depthFile, depth, { coverOpacity = 0, coverScatter = 0 } = {}) {
  const depthMap = loadMap(depthFile);
  depthMap.minFilter = THREE.NearestFilter; // read at full resolution only: crisp layers
  depthMap.generateMipmaps = false;
  mat.customProgramCacheKey = () => 'parallax';
  const before = mat.onBeforeCompile; // the grime layer
  mat.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.uniforms.parallaxMap = { value: depthMap };
    shader.uniforms.parallaxDepth = { value: depth };
    shader.uniforms.coverOpacity = { value: coverOpacity };
    shader.uniforms.coverScatter = { value: coverScatter };
    const uvs = ['vMapUv', 'vAoMapUv', 'vRoughnessMapUv', 'vMetalnessMapUv', 'vEmissiveMapUv', 'vSpecularIntensityMapUv', 'vAnisotropyMapUv'];
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D parallaxMap;
uniform float parallaxDepth;
uniform float coverOpacity;
uniform float coverScatter;
vec2 parallaxUv(vec2 uv, vec3 v) { // v: toward the eye, tangent space
  const float LAYERS = 24.0;
  vec2 stepUv = v.xy / max(v.z, 0.25) * parallaxDepth / LAYERS;
  float layer = 0.0, d = textureLod(parallaxMap, uv, 0.0).r;
  for (int i = 0; i < 24; i++) {
    if (layer >= d) break;
    uv -= stepUv;
    layer += 1.0 / LAYERS;
    d = textureLod(parallaxMap, uv, 0.0).r;
  }
  return uv;
}`)
      .replace('void main() {', `void main() {
  vec2 pomDx = dFdx(vMapUv), pomDy = dFdy(vMapUv);
  vec3 pomN = normalize(vNormal), pomQ0 = dFdx(-vViewPosition), pomQ1 = dFdy(-vViewPosition);
  vec3 pomT = cross(pomQ1, pomN) * pomDx.x + cross(pomN, pomQ0) * pomDy.x;
  vec3 pomB = cross(pomQ1, pomN) * pomDx.y + cross(pomN, pomQ0) * pomDy.y;
  float pomS = inversesqrt(max(max(dot(pomT, pomT), dot(pomB, pomB)), 1e-20));
  vec3 pomV = normalize(vViewPosition);
  vec3 pomVt = normalize(vec3(dot(pomT, pomV) * pomS, dot(pomB, pomV) * pomS, dot(pomN, pomV))); // eye, tangent space
  vec2 pomUv0 = vMapUv; // the surface UV, kept for the cover's scattered rays
  vec2 pomUv = parallaxUv(vMapUv, pomVt);
  #undef texture2D
  #define texture2D(s, c) textureGrad(s, c, pomDx, pomDy)
${uvs.map((u) => `  #define ${u} pomUv`).join('\n')}`)
      // after normal_fragment_begin, whose tangent frame needs the smooth UVs
      .replace('#include <normal_fragment_maps>', '#define vNormalMapUv pomUv\n#include <normal_fragment_maps>')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#ifdef USE_CLEARCOATMAP
  vec4 coverTexel = texture2D(clearcoatMap, vClearcoatMapUv); // the cover lies at the surface: unshifted UVs
#if defined( USE_MAP ) && defined( USE_EMISSIVEMAP )
  if (coverTexel.b > 0.5 && coverScatter > 0.0) { // diffusion: average what 8 scattered rays see behind the cover
    vec3 alb = vec3(0.0), em = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float t = (float(i) + 0.5) / 4.0 - 1.0; // -0.875 .. 0.875
      vec3 v = normalize(pomVt + coverScatter * vec3(0.25 * t * (i % 2 == 0 ? 1.0 : -1.0), t, 0.0));
      vec2 uv = parallaxUv(pomUv0, v);
      alb += textureGrad(map, uv, pomDx, pomDy).rgb;
      em += textureGrad(emissiveMap, uv, pomDx, pomDy).rgb;
    }
    diffuseColor.rgb = alb / 8.0;
    totalEmissiveRadiance = emissive * em / 8.0;
  }
#endif
  float cover = coverTexel.b * coverOpacity, dirt = coverTexel.g;
  float scratch = 1.0 - coverTexel.a; // scratches (an RGB map reads as A = 1: none): pale lines, catching the light
  diffuseColor.rgb = mix(mix(mix(diffuseColor.rgb, vec3(0.8), cover), vec3(0.75), scratch * 0.7), vec3(0.05, 0.046, 0.042), dirt); // GRIME (generator)
  metalnessFactor *= (1.0 - cover) * (1.0 - dirt) * (1.0 - scratch);
  roughnessFactor = mix(mix(roughnessFactor, 0.6, scratch), 0.85, dirt);
  totalEmissiveRadiance *= (1.0 - cover) * (1.0 - dirt) * (1.0 - 0.4 * scratch);
#endif`);
  };
}


