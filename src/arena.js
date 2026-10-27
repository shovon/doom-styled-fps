// The arena: its wall and lamps, the ceiling, the columns and towers; the centre platform, its stairs and the
// balcony laid out, and what you and the demons stand on and bump into (floorAt, standOn, rayConvex...)
import { TILE, BAKE_FIXTURES, loadMap, ONE, AXIS_Y, AXIS_Z, randomTurn, tileMat, GRIME_TILE, withGrimeOffsets,
  addParallax } from './tiles.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { scene } from './setup.js';
import { STRIP_LIGHTS_IN_WORLD } from './lights.js';
import { addWallBlood } from './blood-surfaces.js';

// Arena wall: a square ARENA m out each way, WALL_ROWS tiles high, in WALL_PANEL m panels (2 × 2 floor tiles, on the
// floor's seams), stood up facing inward. Flat: each panel one textures/wallpanel, a corrugated steel sheet in a frame,
// braced across by an X, frame and X flush with the waves' crests (one flat face, futuristic: standing out as real
// beams, it was a warehouse). Single-sided: you can't get out to see the back (the player is kept inside).
export const ARENA = 28, WALL_ROWS = 4; // 8 m ceiling (14 panels a wall: 16 was too big)
const WALL_PANEL = 2 * TILE; // m
// Its lamps: a strip light flush in the frame between the rows, in the middle of every WALL_LAMP_EVERY'th panel, glowing
// (a lens, brighter than white so it blooms, as the towers' lamps); their light washes the wall round them (worked out
// in the wall's own shader: see addWallLamps), and their glow lights the sprites and the gun as the other lamps' does
// (the strip pool)
const WALL_LAMP = new THREE.Vector2(0.7, 3 / 32), WALL_LAMP_EVERY = 2; // m: its lens (along, up: between the frame's
// two pills there); panels
const WALL_LAMP_Y = WALL_PANEL - 7 / 32; // m: its height, the middle of the lower panel's frame along its top (the
// generator's WALL_BAND / 2 px, at 32 px/m)
// A flood lamp, shining down: a cone of light (WALL_LAMP_CONE: its full and its edge's half-angles off its axis, which
// leans WALL_LAMP_TILT off straight down into the wall) from WALL_LAMP_OUT m out from it, so it lights a scallop on the
// wall below it, its top a curve under the lamp, spreading to the floor (none above it: the top row's lit by the
// ceiling). Its top about 0.3 m under the lamp, fully lit by 0.6 m (further out, or less leaning, it started lower)
const WALL_LAMP_INTENSITY = 30, WALL_LAMP_OUT = 0.5; // candela; m
const WALL_LAMP_CONE = [THREE.MathUtils.degToRad(20), THREE.MathUtils.degToRad(38)], WALL_LAMP_TILT = THREE.MathUtils.degToRad(20);
// its light's matte share on the wall (as the brush scratches and the grime scatter it), on top of the steel's mirror-
// like sheen: light from above glances off polished steel down, away from you, so only the scallop's top showed
const WALL_LAMP_MATTE = 0.4;
const WALL_LAMP_RANGE = WALL_PANEL * WALL_LAMP_EVERY; // m: its light, faded out by the next lamp (so a pixel only ever
// has the two either side: further, one swapping in or out as you pass a lamp left a step)
export const wallLamps = []; // where each one's glow sits (the strip pool)
// The light fixture the wall had, the columns' now (their lamp panels share its material, 'drip:walllight'): a tube in
// a deep recess under a ridged clear cover, drawn with parallax mapping
const WALL_STRIP_OFFSET = 0.6; // m off the wall: a wall lamp's glow (strip pool): further out than the floor's, so it doesn't hot-spot its own fixture
const WALL_LIGHT_DEPTH = 6 / 64; // UV units: the generator's PARALLAX_RANGE (px) over the 64 px tile
{
  const mat = tileMat('walllight', 'drip:walllight', { drip: true });
  Object.assign(mat, {
    clearcoat: 1, clearcoatMap: loadMap('walllight_ccm'), clearcoatNormalMap: loadMap('walllight_ccn'),
    clearcoatRoughness: 0.08, // the clear cover: a glossy layer over the recess, its ridges in the normal map
  });
  addParallax(mat, 'walllight_depth', WALL_LIGHT_DEPTH, { coverOpacity: 0.2, coverScatter: 0.6 }); // a frosted cover
}
// The lamps' light on the wall: each pixel lit by the lamps either side of it along its wall and, round the corner it's
// nearer, that wall's nearest one, each a spot light (see WALL_LAMP_CONE), through the material's own lighting (so the
// corrugation and the steel's brush catch it). Worked out here, not by real lights: one of those costs every pixel on
// screen (see the spots), this only the wall's. No shadows, and the floor doesn't get it. (Off when real lights light
// the wall: the bake or the strips in the world)
const wallLampLight = { value: new THREE.Color(0x96d2ff).multiplyScalar(WALL_LAMP_INTENSITY) }; // STRIP_COLOR
function addWallLamps(mat) {
  const before = mat.onBeforeCompile, key = mat.customProgramCacheKey, f = (v) => v.toFixed(4);
  const lamps = 2 * ARENA / WALL_PANEL / WALL_LAMP_EVERY, step = f(WALL_PANEL * WALL_LAMP_EVERY); // a wall's; m apart
  const first = f(WALL_PANEL / 2 - ARENA), last = f(WALL_PANEL / 2 - ARENA + (lamps - 1) * WALL_PANEL * WALL_LAMP_EVERY); // along it
  mat.customProgramCacheKey = () => `${key ? key.call(mat) : ''}:walllamps`;
  mat.onBeforeCompile = (shader, r) => {
    before?.(shader, r);
    if (BAKE_FIXTURES || STRIP_LIGHTS_IN_WORLD) return; // (real lights have it: not twice)
    shader.uniforms.uWallLamp = wallLampLight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLampW;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  {
    vec4 lw = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      lw = instanceMatrix * lw;
    #endif
    vLampW = (modelMatrix * lw).xyz;
  }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uWallLamp;\nvarying vec3 vLampW;')
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
  {
    bool xWall = abs(vLampW.x) > abs(vLampW.z);
    float along = xWall ? vLampW.z : vLampW.x, side = sign(xWall ? vLampW.x : vLampW.z), off = side * ${f(ARENA - WALL_LAMP_OUT)};
    float j0 = floor((along - ${first}) / ${step}); // (the lamp before it along its wall)
    IncidentLight wl;
    wl.visible = true;
    for (int i = 0; i <= 2; i++) { // the lamps either side of it, and round the corner it's nearer, that wall's nearest
      vec3 lamp, axis; // (where it is; which way it shines: down, leaning into its wall)
      if (i == 2) {
        float s = along < 0.0 ? -1.0 : 1.0, end = side > 0.0 ? ${last} : ${first}; // (not sign(): 0 on the middle seam, a lamp there)
        lamp = xWall ? vec3(end, ${f(WALL_LAMP_Y)}, s * ${f(ARENA - WALL_LAMP_OUT)}) : vec3(s * ${f(ARENA - WALL_LAMP_OUT)}, ${f(WALL_LAMP_Y)}, end);
        axis = xWall ? vec3(0.0, -1.0, s * ${f(Math.tan(WALL_LAMP_TILT))}) : vec3(s * ${f(Math.tan(WALL_LAMP_TILT))}, -1.0, 0.0);
      } else {
        float j = j0 + float(i), a = ${first} + j * ${step};
        if (j < 0.0 || j > ${f(lamps - 1)}) continue; // (past the wall's ends: none)
        lamp = xWall ? vec3(off, ${f(WALL_LAMP_Y)}, a) : vec3(a, ${f(WALL_LAMP_Y)}, off);
        axis = xWall ? vec3(side * ${f(Math.tan(WALL_LAMP_TILT))}, -1.0, 0.0) : vec3(0.0, -1.0, side * ${f(Math.tan(WALL_LAMP_TILT))});
      }
      vec3 down = vLampW - lamp; // (the lamp to here)
      float spot = smoothstep(${f(Math.cos(WALL_LAMP_CONE[1]))}, ${f(Math.cos(WALL_LAMP_CONE[0]))}, dot(normalize(down), normalize(axis))); // (in its cone?)
      if (spot <= 0.0) continue;
      vec3 lv = (viewMatrix * vec4(lamp, 1.0)).xyz - geometryPosition;
      float d = length(lv);
      wl.direction = lv / d;
      wl.color = uWallLamp * spot * getDistanceAttenuation(d, ${f(WALL_LAMP_RANGE)}, 2.0);
      RE_Direct(wl, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
      reflectedLight.directDiffuse += wl.color * saturate(dot(geometryNormal, wl.direction)) * diffuseColor.rgb * ${f(WALL_LAMP_MATTE)} * RECIPROCAL_PI;
    }
  }`);
  };
}
{ // the panels, and the lamps' lenses
  const cols = (2 * ARENA) / WALL_PANEL, rows = (WALL_ROWS * TILE) / WALL_PANEL, lenses = [];
  const panels = {}; // its set's name → the panels with it
  for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) { // each wall's inward normal
    const q = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, Math.atan2(nx, nz));
    const at = (along, y, out) => (nx ? new THREE.Vector3(-nx * (ARENA - out), y, along) : new THREE.Vector3(along, y, -nz * (ARENA - out)));
    for (let k = 0; k < cols; k++) {
      const along = -ARENA + (k + 0.5) * WALL_PANEL;
      for (let r = 0; r < rows; r++) (panels[r ? 'wallpanel' : nx ? 'wallpanel_striped' : 'wallpanel_yellow'] ??= [])
        .push(new THREE.Matrix4().compose(at(along, (r + 0.5) * WALL_PANEL, 0), q, ONE));
      if (k % WALL_LAMP_EVERY) continue;
      lenses.push(new THREE.Matrix4().compose(at(along, WALL_LAMP_Y, 0.002), q, ONE)); // (a hair out: over the panel)
      wallLamps.push(at(along, WALL_LAMP_Y, WALL_STRIP_OFFSET));
    }
  }
  // a panel: a quad, its uvs in tiles (so its drip grime's as dense as a tile's) and its maps scaled to match (the 4 m
  // texture on it once), not turned (its drips run down). The bottom row's its own sets, the lower half of its sheet
  // painted: the ±z walls' the hazard stripes' yellow, the ±x walls' white striped in it (textures/wallpanel_yellow,
  // wallpanel_striped)
  const geo = new THREE.PlaneGeometry(WALL_PANEL, WALL_PANEL), uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * WALL_PANEL / TILE, uv.getY(i) * WALL_PANEL / TILE);
  for (const [name, row] of Object.entries(panels)) {
    const mat = tileMat(name, `drip:${name}`, { drip: true }); // (16 px/m: chunkier than the tiles' 32)
    for (const t of Object.values(mat)) if (t?.isTexture) t.repeat.set(TILE / WALL_PANEL, TILE / WALL_PANEL);
    addWallBlood(mat); // (see wallBlood)
    addWallLamps(mat);
    const mesh = new THREE.InstancedMesh(withGrimeOffsets(geo, row.length, WALL_PANEL / TILE * GRIME_TILE), mat, row.length);
    row.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
  }
  const lens = new THREE.InstancedMesh(new THREE.PlaneGeometry(WALL_LAMP.x, WALL_LAMP.y),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x96d2ff, emissiveIntensity: 5 }), lenses.length); // STRIP_COLOR
  lenses.forEach((m, i) => lens.setMatrixAt(i, m));
  scene.add(lens);
}

// Ceiling: closes the arena on top of the wall, tiles facing down in a checkerboard of slit vents and plain,
// with a light tile every CEIL_LIGHT_EVERY tiles each way (in place of a vent)
const CEILING_TILES = ['slits', 'plain', 'light'], CEIL_LIGHT_EVERY = 4;
const ceilingGeo = new THREE.PlaneGeometry(TILE, TILE).rotateX(Math.PI / 2); // faces down
export const ceilLightTiles = []; // where the ceiling lights are, just under the ceiling, each with its .color
// Ceiling light colours come in sections, not light by light: the lights fall in 16 m blocks of 2 × 2, and each
// block takes the colour of its nearest colour seed (7 scattered at random, every colour used at least once), so
// the colours form a few irregular, contiguous regions. All four are scaled to the original blue LED's luminance,
// so they read equally bright and all still clear the bloom threshold (which goes by luminance).
// Now all white (add hues back, e.g. green: [0.15, 1, 0.25], blue: [0.2, 0.45, 1], red: [1, 0.12, 0.08], for sections).
// The light they cast is CEIL_CAST of that: about what one of the red, green or blue lights put out, a third of white;
// the lenses themselves stay at full brightness, so they still bloom.
const CEIL_COLORS = { white: [1, 1, 1] }; // linear hues
const CEIL_CAST = 1 / 3;
const CEIL_SECTION = 16, CEIL_COLOR_SEEDS = 7; // m: a colour block; seeds
const LED = new THREE.Color(0x96d2ff); // the light tile's baked LED colour (LIGHT in the generator), linear
const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const ceilColors = Object.fromEntries(Object.entries(CEIL_COLORS).map(([k, v]) => {
  const c = new THREE.Color().setRGB(...v);
  return [k, c.multiplyScalar(luminance(LED) / luminance(c))];
}));
{
  const names = Object.keys(ceilColors);
  const seeds = Array.from({ length: CEIL_COLOR_SEEDS }, (_, i) => ({
    x: (Math.random() - 0.5) * 2 * ARENA, z: (Math.random() - 0.5) * 2 * ARENA, color: names[i % names.length] }));
  const sectionColor = (x, z) => { // the seed nearest the centre of the 16 m block this point is in
    const cx = (Math.floor((x + ARENA) / CEIL_SECTION) + 0.5) * CEIL_SECTION - ARENA;
    const cz = (Math.floor((z + ARENA) / CEIL_SECTION) + 0.5) * CEIL_SECTION - ARENA;
    return seeds.reduce((a, b) => (Math.hypot(b.x - cx, b.z - cz) < Math.hypot(a.x - cx, a.z - cz) ? b : a)).color;
  };
  const count = (2 * ARENA) / TILE, cells = Object.fromEntries(CEILING_TILES.map((n) => [n, []]));
  for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) {
    const p = new THREE.Vector3((i - count / 2 + 0.5) * TILE, WALL_ROWS * TILE, (j - count / 2 + 0.5) * TILE);
    const lit = i % CEIL_LIGHT_EVERY === CEIL_LIGHT_EVERY / 2 && j % CEIL_LIGHT_EVERY === CEIL_LIGHT_EVERY / 2;
    const key = lit ? `light:${sectionColor(p.x, p.z)}` : CEILING_TILES[(i + j) % 2];
    (cells[key] ??= []).push(p);
    if (lit) ceilLightTiles.push(Object.assign(p.clone().setY(p.y - 0.02), { color: ceilColors[key.split(':')[1]].clone().multiplyScalar(CEIL_CAST) }));
  }
  for (const [key, ps] of Object.entries(cells)) {
    if (!ps.length) continue;
    const [name, colour] = key.split(':'), m = new THREE.Matrix4();
    const mat = tileMat(name, key);
    // the lens's glow texture is the blue LED; this factor turns it into the section's colour
    if (colour) mat.emissive.setRGB(ceilColors[colour].r / LED.r, ceilColors[colour].g / LED.g, ceilColors[colour].b / LED.b);
    const mesh = new THREE.InstancedMesh(withGrimeOffsets(ceilingGeo, ps.length), mat, ps.length);
    ps.forEach((p, i) => mesh.setMatrixAt(i, m.compose(p, randomTurn(AXIS_Y, 4), ONE))); // quarter turns
    scene.add(mesh);
  }
}

// Columns: regular octagons (all sides equal), floor to ceiling, on a centred square lattice: one towards each
// corner (the middle has the platform, below). Each face is one 2 m tile wide (~4.8 m across), the same panels as the floor,
// walls and ceiling: a whole plate per 2 m × 2 m, every panel with its own grime window. The top and bottom panels
// carry thin light slits, alternating round the column between the ceiling and floor edges, each with a spot light
// aimed away from it (see the spot pool).
export const COLUMN_SIDE = TILE, COLUMN_SPACING = 16; // m: face width; lattice step out from the centre
const COLUMN_TINT = 0x35b8a0; // the bottom row of panels: a greenish-blue (teal) steel
export const COLUMNS = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([i, j]) => new THREE.Vector2(i, j).multiplyScalar(COLUMN_SPACING));
export const COLUMN_APOTHEM = COLUMN_SIDE / 2 / Math.tan(Math.PI / 8);          // centre → middle of a face
export const COLUMN_REACH = COLUMN_APOTHEM / Math.cos(Math.PI / 8) + 0.4;       // centre → corner, plus the player's body
export const NPC_REACH = 0.8; // m: an enemy's body plus yours (you can't walk into the living)
export const NPC_FEET = 0.15; // m: how far its feet reach out from its middle (over a step by that much, it's up on it)
export const slitTiles = []; // the columns' light slits: positions, each with .aim (where its spot points, relative)
export const columnLamps = []; // the columns' wall lamps (the parallax fixture the walls had): where each one's glow sits
{
  const panel = new THREE.PlaneGeometry(COLUMN_SIDE, TILE); // faces +Z
  const uv = panel.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, (uv.getX(i) * COLUMN_SIDE) / TILE); // a face narrower than a tile shows part of a plate, not a squashed one
  const panels = {}, m = new THREE.Matrix4(); // by tile name, ':low' for the bottom row (tinted)
  const upsideDown = new THREE.Quaternion().setFromAxisAngle(AXIS_Z, Math.PI); // in the panel's plane
  for (const c of COLUMNS) for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4, q = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, a); // face k looks out at angle a
    const out = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    for (let r = 0; r < WALL_ROWS; r++) {
      // 8 slits a column, alternating round it: even faces have one along the top panel's top edge (under the
      // ceiling), spot aimed down; odd faces one along the bottom panel's bottom edge (the same panel upside
      // down), spot aimed up. Each slit sits 0.25 m from its edge; its spot hangs just off the face, tilted a
      // little outward, washing the column face and lighting the floor (or the ceiling) around it.
      const top = r === WALL_ROWS - 1 && k % 2 === 0, bottom = r === 0 && k % 2 === 1, slit = top || bottom;
      const lamp = r === 1 && k % 2 === 0; // a wall lamp on the second panel up, every other face (over a plain one)
      if (lamp) columnLamps.push(new THREE.Vector3(c.x, (r + 0.5) * TILE, c.y).addScaledVector(out, COLUMN_APOTHEM + WALL_STRIP_OFFSET));
      (panels[(slit ? 'slitlight' : lamp ? 'walllight' : 'plain') + (r === 0 ? ':low' : '')] ??= []).push(m.clone().compose(
        new THREE.Vector3(c.x, (r + 0.5) * TILE, c.y).addScaledVector(out, COLUMN_APOTHEM), bottom ? q.clone().multiply(upsideDown) : q, ONE));
      if (slit) slitTiles.push(Object.assign(
        new THREE.Vector3(c.x, top ? (r + 1) * TILE - 0.25 : 0.25, c.y).addScaledVector(out, COLUMN_APOTHEM + 0.15),
        { aim: out.clone().multiplyScalar(1.5).setY(top ? -6 : 6) }));
    }
  }
  for (const [key, mats] of Object.entries(panels)) {
    const [name, low] = key.split(':'), mat = tileMat(name, `drip:${key}`, { drip: true });
    addWallBlood(mat); // (see wallBlood)
    if (low) mat.color.set(COLUMN_TINT); // the bottom row: tinted steel, still metal (the tint colours its reflections)
    const mesh = new THREE.InstancedMesh(withGrimeOffsets(panel, mats.length), mat, mats.length);
    mats.forEach((mm, i) => mesh.setMatrixAt(i, mm));
    scene.add(mesh);
  }
}

// Braced towers: four cheap supports on the edges, between the corner columns. A square of four corner posts,
// floor to ceiling, an X brace across each face of each 2 m storey and a strut round every storey line: open
// steelwork you see (and shoot) through. Each member is a box: { m: its matrix, size } — drawn, and shot at as a
// convex solid (rayTowers).
export const TOWERS = [[0, -1], [0, 1], [-1, 0], [1, 0]].map(([i, j]) => new THREE.Vector2(i, j).multiplyScalar(COLUMN_SPACING));
export const TOWER_HALF = 0.75, TOWER_POST = 5 / 32, TOWER_BAR = 3 / 32; // m: post centre lines ± this; post section; bar section
export const TOWER_REACH = TOWER_HALF * Math.SQRT2 + 0.4; // centre → corner post, plus the player's body
const TOWER_PARTS = [];
const TOWER_LAMP_STOREY = WALL_ROWS - 2; // a strip light across each face, mid-way up the second storey from the top
export const towerLamps = []; // where each one's glow sits (the strip pool)
{
  const H = WALL_ROWS * TILE, span = 2 * TOWER_HALF, brace = Math.hypot(span, TILE), lean = Math.atan2(TILE, span);
  const post = new THREE.Vector3(TOWER_POST, H, TOWER_POST), strut = new THREE.Vector3(span, TOWER_BAR, TOWER_BAR);
  const bar = new THREE.Vector3(brace, TOWER_BAR, TOWER_BAR / 2);
  const lamp = new THREE.Vector3(span - TOWER_POST - 0.1, 3 / 32, 2.5 / 32); // a housing between the posts, lens facing out
  const add = (size, pos, q) => TOWER_PARTS.push({ size, m: new THREE.Matrix4().compose(pos, q, ONE) });
  for (const c of TOWERS) {
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(post, new THREE.Vector3(c.x + sx * TOWER_HALF, H / 2, c.y + sz * TOWER_HALF), new THREE.Quaternion());
    for (let f = 0; f < 4; f++) { // each face: its outward normal at yaw f × 90°, its x along the face
      const yaw = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, f * Math.PI / 2), out = new THREE.Vector3(0, 0, 1).applyQuaternion(yaw);
      const at = (y) => new THREE.Vector3(c.x, y, c.y).addScaledVector(out, TOWER_HALF);
      for (let r = 0; r <= WALL_ROWS; r++) add(strut, at(THREE.MathUtils.clamp(r * TILE, TOWER_BAR / 2, H - TOWER_BAR / 2)), yaw);
      for (let r = 0; r < WALL_ROWS; r++) for (const sign of [1, -1])
        add(bar, at((r + 0.5) * TILE), yaw.clone().multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_Z, sign * lean)));
      const y = (TOWER_LAMP_STOREY + 0.5) * TILE; // the lamp: bolted on over the braces' crossing
      add(lamp, at(y).addScaledVector(out, TOWER_BAR / 4 + lamp.z / 2), yaw);
      towerLamps.push(at(y).addScaledVector(out, WALL_STRIP_OFFSET));
    }
  }
  // drawn: one instanced box per member size (see tiledBox)
  const mat = tileMat('plain', 'drip:plain', { drip: true });
  for (const size of [post, strut, bar]) {
    const parts = TOWER_PARTS.filter((p) => p.size === size);
    const mesh = new THREE.InstancedMesh(withGrimeOffsets(tiledBox(size), parts.length), mat, parts.length);
    parts.forEach((p, i) => mesh.setMatrixAt(i, p.m));
    scene.add(mesh);
  }
  { // the lamps: steel housings, the front face a glowing lens (brighter than white, so it blooms)
    const parts = TOWER_PARTS.filter((p) => p.size === lamp), geo = new THREE.BoxGeometry(lamp.x, lamp.y, lamp.z);
    const lens = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x96d2ff, emissiveIntensity: 5 }); // STRIP_COLOR
    const mesh = new THREE.InstancedMesh(withGrimeOffsets(geo, parts.length), [mat, mat, mat, mat, lens, mat], parts.length);
    parts.forEach((p, i) => mesh.setMatrixAt(i, p.m));
    scene.add(mesh);
  }
  // shot at: each member's six faces as planes n·p ≤ k
  const ax = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], at = new THREE.Vector3();
  for (const p of TOWER_PARTS) {
    p.m.extractBasis(...ax); at.setFromMatrixPosition(p.m);
    p.planes = ax.flatMap((a, i) => {
      const h = [p.size.x, p.size.y, p.size.z][i] / 2, d = a.dot(at);
      return [[a.x, a.y, a.z, d + h], [-a.x, -a.y, -a.z, h - d]];
    });
  }
}
// A box (a steel member), its uvs in tile units of each face's size (no stretched plate)
export function tiledBox(size) {
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z), uv = geo.attributes.uv;
  for (const g of geo.groups) {
    const [w, h] = [[size.z, size.y], [size.z, size.y], [size.x, size.z], [size.x, size.z], [size.x, size.y], [size.x, size.y]][g.materialIndex];
    for (let i = g.start / 1.5; i < (g.start + g.count) / 1.5; i++) uv.setXY(i, uv.getX(i) * w / TILE, uv.getY(i) * h / TILE);
  }
  return geo;
}
export function rayTowers(o, dir) { // the nearest tower member a ray hits: { t, normal } or null
  let best = null;
  for (const c of TOWERS) {
    // skip a tower the ray passes well clear of (in plan)
    const ox = c.x - o.x, oz = c.y - o.z, a = dir.x * dir.x + dir.z * dir.z, t = a > 1e-9 ? (ox * dir.x + oz * dir.z) / a : 0;
    if (Math.hypot(ox - dir.x * t, oz - dir.z * t) > TOWER_HALF * 2 && Math.hypot(ox, oz) > TOWER_HALF * 2) continue;
    for (const p of TOWER_PARTS) {
      if (Math.abs(p.m.elements[12] - c.x) > 1 || Math.abs(p.m.elements[14] - c.y) > 1) continue; // another tower's
      const h = rayConvex(o, dir, p.planes);
      if (h && (!best || h.t < best.t)) best = h;
    }
  }
  return best;
}

// The centre platform: a regular octagon, two panels to a side (4 m sides, ~9.7 m across), half a panel (1 m) tall. Its sides are steel panels cut to half height (each shows half a plate); its top is plates on the 2 m
// floor grid, each clipped to the octagon. You can jump up onto it (your jump just clears it), or go up its stairs (as
// the enemies do); otherwise it's solid, to you, them, shots and blood.
export const PLATFORM_SIDE = 2 * TILE, PLATFORM_H = TILE / 2, PLATFORM_STEP = 0.3; // m; m; how far short of a top still lands (or steps) you onto it: more than a stair's rise
export const PLATFORM_APOTHEM = PLATFORM_SIDE / 2 / Math.tan(Math.PI / 8); // centre → middle of a side
export const PLATFORM_FACES = Array.from({ length: 8 }, (_, k) => new THREE.Vector2(Math.sin(k * Math.PI / 4), Math.cos(k * Math.PI / 4))); // side k's outward normal (x, z)
export const PLATFORM_TILES = { plain: 0.6, plain_bolted: 0.2, plain_welded: 0.2 }; // the sides; the top is tread plate
export const PLATFORM_STRIP_SQUARE = 3; // m: two strip lights set into the top, opposite sides of a square this size in the middle
export const platformLamps = []; // where their glow sits (the strip pool): two per strip
// How far out from the centre a point is, measured across the nearest side (< PLATFORM_APOTHEM: over the platform);
// the side's normal in _pf
export const _pf = new THREE.Vector2();
export function platformDist(x, z) {
  let best = -Infinity;
  for (const n of PLATFORM_FACES) { const d = n.x * x + n.y * z; if (d > best) { best = d; _pf.copy(n); } }
  return best;
}
export function pushOutOfPlatform(p, pad) { // p: a position (x, z used), kept pad metres off the platform's sides
  const d = platformDist(p.x, p.z);
  if (d < PLATFORM_APOTHEM + pad) { p.x += _pf.x * (PLATFORM_APOTHEM + pad - d); p.z += _pf.y * (PLATFORM_APOTHEM + pad - d); }
}
// Where a ray (origin o, direction dir) enters the platform's solid octagonal prism, its stairs or the balcony (see
// STAIR_PIECES): its distance, or Infinity
export function rayPlatform(o, dir) {
  let tIn = -Infinity, tOut = Infinity;
  const clip = (den, num) => { // the half-space n·(o + t dir) ≤ k, with den = n·dir, num = k − n·o
    if (Math.abs(den) < 1e-9) { if (num < 0) tIn = Infinity; } else if (den > 0) tOut = Math.min(tOut, num / den); else tIn = Math.max(tIn, num / den);
  };
  for (const n of PLATFORM_FACES) clip(n.x * dir.x + n.y * dir.z, PLATFORM_APOTHEM - (n.x * o.x + n.y * o.z));
  clip(dir.y, PLATFORM_H - o.y); clip(-dir.y, o.y);
  const t = tIn <= tOut && tOut > 0 ? Math.max(tIn, 0) : Infinity;
  return Math.min(t, ...[...STAIR_PIECES, ...BALCONY_PIECES].map((p) => rayConvex(o, dir, p)?.t ?? Infinity));
}
// Stairs: flights one tile wide, rises of 25 cm, treads of grating each two of the slit tile's rows deep (⅔ m): up the
// platform's four sides square to the grid (4 rises, so a flight runs one tile out), and up to the balcony (see below).
// A flight: { n: out from its top (x, z), t: across it, o: n·p at its top, c: t·p of its middle, half: half its width,
// e0..e1 (0..run): how far out it runs, top: its top's height, topAt: a metre in on its top, footAt: STAIR_FOOT m out in
// front of its bottom step (both on its middle line: see stairsTo), steps }. Each step is a solid box, the same but
// e0..e1 m out from the top, its top h, its bottom y0: STRINGER_D under its tread (under the high ones you walk, and
// shots, blood, everything goes).
export const STAIR_SIDES = [0, 2, 4, 6], STAIR_RISE = PLATFORM_H / 4, STAIR_RUN = TILE / 3, STAIR_HALF = TILE / 2;
export const STAIR_TREAD = 3 / 32, STRINGER_W = 2 / 32, STRINGER_D = 0.35, STAIR_SLOPE = STAIR_RISE / STAIR_RUN; // m; m; m
export const STAIR_FOOT = 0.8; // m
function flight(n, o, c, top, half = STAIR_HALF) {
  const count = Math.round(top / STAIR_RISE) - 1, run = count * STAIR_RUN, t = new THREE.Vector2(n.y, -n.x);
  const at = (e) => new THREE.Vector2(n.x * (o + e) + t.x * c, n.y * (o + e) + t.y * c);
  const f = { n, t, o, c, half, e0: 0, e1: run, run, top, topAt: at(-1), footAt: at(run + STAIR_FOOT) };
  f.steps = Array.from({ length: count }, (_, j) => {
    const h = top - (j + 1) * STAIR_RISE;
    return { ...f, e0: j * STAIR_RUN, e1: (j + 1) * STAIR_RUN, h, y0: Math.max(h - STRINGER_D, 0) };
  });
  return f;
}
export const FLIGHTS = STAIR_SIDES.map((k) => flight(PLATFORM_FACES[k], PLATFORM_APOTHEM, 0, PLATFORM_H)); // the platform's
// The balcony: a mesh floor (the treads' grating, laid edge to edge) round the whole of the walls, four cells wide (8 m
// out from them) and two up (4 m: its top at the wall panels' seam), held out from the walls by steel joists, stuck to
// them: nothing under it but the floor, to walk about on. Its stairs run up along the −z wall, under it, in the cell
// next to the wall, which is open over them (the stairwell): you come up through it. To everything, its floor is boxes
// like a step's (DECKS): each wall's strip (round the walls like a pinwheel, each taking the corner at its −t end; the
// −z one in three, round the stairwell), and the bridges'.
// Bridges across the room between its opposite strips, one each way: a cell wide, beside the towers between them, just
// clear of them (BALCONY_BRIDGE along the wall it sets out from: x for the one along z, −z for the one along x), the
// two crossing near the middle.
export const BALCONY_Y = WALL_PANEL, BALCONY_D = 4 * TILE, BALCONY_IN = ARENA - BALCONY_D; // m: its top; how far out from the walls; its open edge, out from the middle
export const BALCONY_WALLS = [[0, 1], [-1, 0], [0, -1], [1, 0]].map(([x, z]) => new THREE.Vector2(x, z)); // out from each wall: −z, +x, +z, −x
export const BALCONY_WELL = [-4 * TILE, TILE]; // m: the stairwell's ends along the −z wall (x): its flight's run; its top on a joist (see BALCONY_STEEL)
export const deckBox = (n, a0, a1, d0, d1) => ({ n, t: new THREE.Vector2(n.y, -n.x), o: -ARENA, c: (a0 + a1) / 2, half: (a1 - a0) / 2,
  e0: d0, e1: d1, h: BALCONY_Y, y0: BALCONY_Y - STRINGER_D }); // a0..a1 along wall n (t), d0..d1 out from it
export const BALCONY_BRIDGE = [TILE, 2 * TILE]; // m
export const BALCONY_BRIDGES = [BALCONY_WALLS[0], BALCONY_WALLS[3]].map((n) => deckBox(n, ...BALCONY_BRIDGE, BALCONY_D, 2 * ARENA - BALCONY_D)); // (along z, along x)
export const DECKS = BALCONY_WALLS.flatMap((n, k) => {
  const [w0, w1] = BALCONY_WELL;
  return k ? [deckBox(n, -ARENA, BALCONY_IN, 0, BALCONY_D)]
    : [deckBox(n, -ARENA, w0, 0, BALCONY_D), deckBox(n, w1, BALCONY_IN, 0, BALCONY_D), deckBox(n, w0, w1, TILE, BALCONY_D)];
}).concat(BALCONY_BRIDGES);
export const overDeck = (x, z) => DECKS.some((b) => inStairBox(b, x, z, 1e-6)); // (on a seam between two: on it)
export const BALCONY_FLIGHT = flight(new THREE.Vector2(1, 0), BALCONY_WELL[0], ARENA - STAIR_HALF, BALCONY_Y, STAIR_HALF - STRINGER_W); // (down
// the stairwell, its stringers in the cell: the outer one on the wall)
// The balcony's steel, each { at: its middle, size } (a box along the axes), under the treads: a joist out from the wall
// at every other panel seam (between the wall lamps: see WALL_LAMP_EVERY; short of the stairwell), a beam along each
// strip's open edge; the stairwell's, along its open side and across its foot (its top's on a joist); and under each
// bridge a beam along either side and a joist across at every other panel seam (the one along x broken where the other
// crosses it: that one carries the crossing)
const BEAM_D = STRINGER_D - STAIR_TREAD; // m (down to the floor's y0)
const beam = (x0, x1, z0, z1) => ({ at: new THREE.Vector3((x0 + x1) / 2, BALCONY_Y - STAIR_TREAD - BEAM_D / 2, (z0 + z1) / 2),
  size: new THREE.Vector3(Math.abs(x1 - x0), BEAM_D, Math.abs(z1 - z0)) }); // (x0..x1, z0..z1)
function steelBox(n, a0, a1, d0, d1) { // a0..a1 along wall n, d0..d1 out from it
  const t = new THREE.Vector2(n.y, -n.x), x = (a, d) => t.x * a + n.x * (d - ARENA), z = (a, d) => t.y * a + n.y * (d - ARENA);
  return beam(x(a0, d0), x(a1, d1), z(a0, d0), z(a1, d1));
}
export const BALCONY_STEEL = BALCONY_WALLS.flatMap((n, k) => {
  const W = STRINGER_W, [w0, w1] = BALCONY_WELL, steel = [steelBox(n, -BALCONY_IN, BALCONY_IN, BALCONY_D - W, BALCONY_D)];
  for (let a = WALL_PANEL - ARENA; a <= BALCONY_IN; a += WALL_PANEL) {
    const well = !k && a > w0 && a < w1;
    steel.push(steelBox(n, a - W / 2, a + W / 2, well ? TILE + W : 0, BALCONY_D - W));
  }
  if (!k) steel.push(steelBox(n, w0, w1, TILE, TILE + W), steelBox(n, w1, w1 + W, 0, TILE));
  return steel;
});
{ // the bridges' (x0..x1 across the one along z, z0..z1 across the one along x)
  const W = STRINGER_W, I = BALCONY_IN, [x0, x1] = BALCONY_BRIDGE, z0 = -x1, z1 = -x0;
  BALCONY_STEEL.push(beam(x0, x0 + W, -I, I), beam(x1 - W, x1, -I, I));
  for (const [u0, u1] of [[-I, x0], [x1, I]]) BALCONY_STEEL.push(beam(u0, u1, z0, z0 + W), beam(u0, u1, z1 - W, z1));
  for (let u = WALL_PANEL - I; u < I; u += WALL_PANEL) {
    BALCONY_STEEL.push(beam(x0 + W, x1 - W, u - W / 2, u + W / 2));
    if (u < x0 || u > x1) BALCONY_STEEL.push(beam(u - W / 2, u + W / 2, z0 + W, z1 - W));
  }
}
export const ALL_FLIGHTS = [...FLIGHTS, BALCONY_FLIGHT], STAIR_BOXES = ALL_FLIGHTS.flatMap((f) => f.steps), BOXES = [...STAIR_BOXES, ...DECKS];
export const stairLocal = (b, x, z) => [b.n.x * x + b.n.y * z - b.o, b.t.x * x + b.t.y * z - b.c]; // [out, along]
export const inStairBox = (b, x, z, pad = 0) => {
  const [e, a] = stairLocal(b, x, z);
  return e > b.e0 - pad && e < b.e1 + pad && Math.abs(a) < b.half + pad;
};
// Over (x, z), for something at height y: the top of the highest step (of boxes: the balcony's too) it isn't under, or
// 0; the bottom of the lowest one it is under, or the ceiling
export const stairHeight = (x, z, y, boxes = STAIR_BOXES) => boxes.reduce((h, b) => (y >= b.y0 && inStairBox(b, x, z) ? Math.max(h, b.h) : h), 0);
export const ceilingAt = (x, z, y, pad = 0) => BOXES.reduce((c, b) => (y < b.y0 && inStairBox(b, x, z, pad) ? Math.min(c, b.y0) : c), WALL_ROWS * TILE);
export const floorAt = (x, z, y) => Math.max(platformDist(x, z) < PLATFORM_APOTHEM ? PLATFORM_H : 0, stairHeight(x, z, y, BOXES)); // the platform's top, a step, the balcony (a bridge over the platform), or 0
export function pushOutOfStairBox(p, b, pad) { // the shortest way out of one step's (padded) footprint
  const [e, a] = stairLocal(b, p.x, p.z);
  const ways = [[b.e1 + pad - e, b.n.x, b.n.y], [e - b.e0 + pad, -b.n.x, -b.n.y],
    [b.half + pad - a, b.t.x, b.t.y], [a + b.half + pad, -b.t.x, -b.t.y]];
  const [d, x, z] = ways.reduce((m, w) => (w[0] < m[0] ? w : m));
  if (d > 0) { p.x += x * d; p.z += z * d; }
}
// What a body at p (its feet at y, pad m round, BODY_H tall) stands on: the floor (0), or the platform's top, a step or
// the balcony its feet (foot m round its middle) are over, if they're up to it (within PLATFORM_STEP of its top: it
// steps up onto it, so up the stairs a step at a time). One too high is a wall: p is pushed out of it; one it's all
// under, it walks under. (You, and the enemies: they climb the stairs too)
export const BODY_H = 1.9; // m
export function standOn(p, y, pad, foot = pad) {
  let floor = 0;
  const d = platformDist(p.x, p.z);
  if (d < PLATFORM_APOTHEM + pad) {
    if (y < PLATFORM_H - PLATFORM_STEP) pushOutOfPlatform(p, pad);
    else if (d < PLATFORM_APOTHEM + foot) floor = PLATFORM_H;
  }
  for (const b of BOXES) if (y + BODY_H > b.y0 && inStairBox(b, p.x, p.z, pad)) {
    if (y < b.h - PLATFORM_STEP) pushOutOfStairBox(p, b, pad);
    else if (inStairBox(b, p.x, p.z, foot)) floor = Math.max(floor, b.h);
  }
  return floor;
}
// The stairs are open (cheap): each tread a thin grating, slotted right through, carried between two slanted
// stringers; no risers, nothing underneath. You still walk them as the solid steps above (but for ducking under the
// balcony's high ones), but shots and sight lines see only the treads and stringers (and the balcony's floor and
// steel): each a convex solid, its faces' planes n·p ≤ k.
const treadPiece = (b) => [[b.n.x, 0, b.n.y, b.o + b.e1], [-b.n.x, 0, -b.n.y, -b.o - b.e0],
  [b.t.x, 0, b.t.y, b.c + b.half], [-b.t.x, 0, -b.t.y, b.half - b.c], [0, 1, 0, b.h], [0, -1, 0, STAIR_TREAD - b.h]];
const flightPieces = (f) => f.steps.map(treadPiece).concat([1, -1].map((side) => { // its treads; its stringers
  const { n, t, o, top } = f, lo = f.c + (side > 0 ? f.half : -f.half - STRINGER_W), s = STAIR_SLOPE;
  return [[t.x, 0, t.y, lo + STRINGER_W], [-t.x, 0, -t.y, -lo], [n.x, 0, n.y, o + f.run], [-n.x, 0, -n.y, -o],
    [0, -1, 0, 0], [s * n.x, 1, s * n.y, top + s * o], [-s * n.x, -1, -s * n.y, STRINGER_D - top - s * o]];
}));
const boxPiece = ({ at, size }) => [[1, 0, 0, at.x + size.x / 2], [-1, 0, 0, size.x / 2 - at.x],
  [0, 1, 0, at.y + size.y / 2], [0, -1, 0, size.y / 2 - at.y], [0, 0, 1, at.z + size.z / 2], [0, 0, -1, size.z / 2 - at.z]];
export const STAIR_PIECES = FLIGHTS.flatMap(flightPieces); // (the platform's: see wayTo)
export const BALCONY_PIECES = [...flightPieces(BALCONY_FLIGHT), ...DECKS.map(treadPiece), ...BALCONY_STEEL.map(boxPiece)];
export function rayConvex(o, dir, planes) { // where a ray enters a convex solid: { t, normal } or null
  let tIn = -Infinity, tOut = Infinity, nIn = null;
  for (const [nx, ny, nz, k] of planes) {
    const den = nx * dir.x + ny * dir.y + nz * dir.z, num = k - (nx * o.x + ny * o.y + nz * o.z);
    if (Math.abs(den) < 1e-9) { if (num < 0) return null; } else if (den > 0) tOut = Math.min(tOut, num / den);
    else if (num / den > tIn) { tIn = num / den; nIn = [nx, ny, nz]; }
  }
  return tIn <= tOut && tIn > 0 && nIn ? { t: tIn, normal: new THREE.Vector3(...nIn).normalize() } : null;
}
