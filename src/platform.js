// The centre platform, its stairs and the balcony, built (their layout's in arena.js); the floor's weld seams and tiles
import { ARENA, COLUMNS, COLUMN_APOTHEM, COLUMN_REACH, TOWERS, TOWER_REACH, tiledBox, PLATFORM_H, PLATFORM_APOTHEM,
  PLATFORM_FACES, PLATFORM_TILES, PLATFORM_STRIP_SQUARE, platformLamps, platformDist, STAIR_RUN, STAIR_HALF,
  STAIR_TREAD, STRINGER_W, STRINGER_D, STAIR_SLOPE, FLIGHTS, BALCONY_D, BALCONY_IN, BALCONY_WALLS, BALCONY_WELL,
  deckBox, BALCONY_BRIDGE, BALCONY_BRIDGES, BALCONY_FLIGHT, BALCONY_STEEL, STAIR_BOXES, inStairBox } from './arena.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { renderer, scene } from './setup.js';
import { FLOOR_TILES, TILE, TILES, loadMap, tileGeo, floorLightType, tilePick, ONE, AXIS_Y, AXIS_Z, randomTurn,
  tilePos, tileMat, GRIME_TILE, withGrimeOffsets } from './tiles.js';
import { addFloorBlood, addWallBlood, addTopBlood } from './blood-surfaces.js';

{
  const pick = (weights) => { let r = Math.random(); for (const [n, w] of Object.entries(weights)) if ((r -= w) <= 0) return n; return Object.keys(weights)[0]; };
  // sides: 8 × 2 panels, the lower half of a plate each (half turned at random, to show either half)
  const side = new THREE.PlaneGeometry(TILE, PLATFORM_H); // faces +Z
  const suv = side.attributes.uv;
  for (let i = 0; i < suv.count; i++) suv.setY(i, suv.getY(i) * PLATFORM_H / TILE);
  const sides = {}, m = new THREE.Matrix4();
  PLATFORM_FACES.forEach((n, k) => {
    const q = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, k * Math.PI / 4), along = new THREE.Vector3(n.y, 0, -n.x);
    for (const s of [-0.5, 0.5]) {
      const at = new THREE.Vector3(n.x * PLATFORM_APOTHEM, PLATFORM_H / 2, n.y * PLATFORM_APOTHEM).addScaledVector(along, s * TILE);
      (sides[pick(PLATFORM_TILES)] ??= []).push(m.clone().compose(at, q.clone().multiply(randomTurn(AXIS_Z, 2)), ONE));
    }
  });
  for (const [name, mats] of Object.entries(sides)) {
    const mat = tileMat(name, `drip:${name}`, { drip: true });
    addWallBlood(mat); // (see wallBlood: its sides' strip)
    const mesh = new THREE.InstancedMesh(withGrimeOffsets(side, mats.length), mat, mats.length);
    mats.forEach((mm, i) => mesh.setMatrixAt(i, mm));
    scene.add(mesh);
  }
  // top: each 2 m floor-grid cell the octagon covers, clipped to it (Sutherland–Hodgman), keeping the cell's uv
  const tops = {};
  const n = Math.ceil(PLATFORM_APOTHEM / Math.cos(Math.PI / 8) / TILE); // cells out to the corners
  for (let i = -n; i < n; i++) for (let j = -n; j < n; j++) {
    const x0 = i * TILE, z0 = j * TILE;
    let poly = [[x0, z0], [x0 + TILE, z0], [x0 + TILE, z0 + TILE], [x0, z0 + TILE]];
    for (const f of PLATFORM_FACES) {
      const inside = ([x, z]) => f.x * x + f.y * z <= PLATFORM_APOTHEM + 1e-6, out = [];
      poly.forEach((a, k) => {
        const b = poly[(k + 1) % poly.length], ia = inside(a), ib = inside(b);
        if (ia) out.push(a);
        if (ia !== ib) {
          const da = f.x * a[0] + f.y * a[1] - PLATFORM_APOTHEM, db = f.x * b[0] + f.y * b[1] - PLATFORM_APOTHEM, t = da / (da - db);
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
      });
      poly = out;
    }
    if (poly.length < 3) continue;
    const g = (tops.treadplate ??= { pos: [], uv: [], grime: [] });
    const grime = [i * GRIME_TILE % 1 + 1, -j * GRIME_TILE % 1 + 1]; // neighbouring windows: one sheet, its dirt unbroken
    for (let k = 1; k < poly.length - 1; k++) for (const [x, z] of [poly[0], poly[k + 1], poly[k]]) { // a fan, facing up
      g.pos.push(x, PLATFORM_H, z);
      g.uv.push((x - x0) / TILE, (z0 + TILE - z) / TILE);
      g.grime.push(...grime);
    }
  }
  for (const [name, g] of Object.entries(tops)) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geo.setAttribute('grimeOffset', new THREE.Float32BufferAttribute(g.grime, 2)); // per vertex: one window per plate
    const mat = tileMat(name);
    addTopBlood(mat); // (see topBloodMap)
    scene.add(new THREE.Mesh(geo, mat));
  }
  // Hazard band: yellow/black paint around the top's edge, 32 px/m like the tiles (one texture = 2 m of band,
  // 4 diagonal stripes), with worn-through chips. Painted on, so it isn't metal and doesn't take the tile grime.
  const W = 8, L = 64, px = new Uint8Array(L * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < L; x++) {
    const yellow = (x + y) % 16 < 8, chip = Math.random() < 0.06;
    px.set(chip ? [70, 72, 70, 255] : yellow ? [226, 176, 18, 255] : [22, 22, 22, 255], (y * L + x) * 4);
  }
  const hazardMap = Object.assign(new THREE.DataTexture(px, L, W), {
    colorSpace: THREE.SRGBColorSpace, wrapS: THREE.RepeatWrapping, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, anisotropy: renderer.capabilities.getMaxAnisotropy(), needsUpdate: true,
  });
  // The same band on the floor round each column's foot, just outside its faces. Rings: centre, inner and outer
  // apothem (the stripes' v runs from the outer edge in), height.
  const BAND = W / 32, pos = [], uv = [];
  const rings = [[0, 0, PLATFORM_APOTHEM - BAND, PLATFORM_APOTHEM, PLATFORM_H],
    ...COLUMNS.map((c) => [c.x, c.y, COLUMN_APOTHEM, COLUMN_APOTHEM + BAND, 0])];
  for (const [cx, cz, a0, a1, y] of rings) for (const n of PLATFORM_FACES) {
    const t = new THREE.Vector2(n.y, -n.x), h0 = a0 * Math.tan(Math.PI / 8), h1 = a1 * Math.tan(Math.PI / 8);
    const c = [[a1, -h1, 0], [a1, h1, 0], [a0, h0, 1], [a0, -h0, 1]] // along n, along t, v
      .map(([a, b, v]) => ({ x: cx + n.x * a + t.x * b, z: cz + n.y * a + t.y * b, u: b / 2, v }));
    for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(c[k].x, y, c[k].z); uv.push(c[k].u, c[k].v); }
  }
  const band = new THREE.BufferGeometry();
  band.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  band.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  band.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  scene.add(new THREE.Mesh(band, new THREE.MeshStandardMaterial({
    map: hazardMap, roughness: 0.6, metalness: 0, side: THREE.DoubleSide, // either winding: it only faces up
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, // painted on the top: drawn over it
  })));
  // Stairs (open: see STAIR_PIECES): the treads, a grating slab each (two rows of the slit tile, its full width,
  // the slots cut through; the underside is the same top seen from below), its nosing in the hazard stripes; and
  // the stringers, plain steel plate.
  const SLIT_ROW = 1 / 6; // the slit tile's rows (the outer two are margin)
  const plainSide = tileMat('plain', 'drip:plain', { drip: true });
  const grating = Object.assign(tileMat('slits', 'tread:slits'), { alphaMap: loadMap('slits_cut'), alphaTest: 0.5, side: THREE.DoubleSide });
  const nosing = new THREE.MeshStandardMaterial({ map: hazardMap, roughness: 0.6, metalness: 0 });
  const tread = new THREE.BoxGeometry(TILE, STAIR_TREAD, STAIR_RUN), tuv = tread.attributes.uv;
  for (const g of tread.groups) for (let i = g.start / 1.5; i < (g.start + g.count) / 1.5; i++) {
    // per face (+x, −x, +y, −y, +z, −z): edges in tile units of their size, the top on its two slit rows, the
    // nosing on the stripes' first rows
    if (g.materialIndex === 2) tuv.setY(i, 1 - 3 * SLIT_ROW + tuv.getY(i) * 2 * SLIT_ROW);
    else if (g.materialIndex === 4) tuv.setY(i, tuv.getY(i) * STAIR_TREAD * 32 / 8);
    else {
      const w = g.materialIndex < 2 ? STAIR_RUN : TILE;
      tuv.setX(i, tuv.getX(i) * w / TILE); tuv.setY(i, tuv.getY(i) * STAIR_TREAD / TILE);
    }
  }
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const lay = (boxes, mats) => { // a tread on each of boxes (its width theirs; turn: turned round), its faces drawn with mats
    const treads = new THREE.InstancedMesh(withGrimeOffsets(tread, boxes.length), mats, boxes.length);
    boxes.forEach((b, i) => {
      const e = b.o + (b.e0 + b.e1) / 2;
      treads.setMatrixAt(i, m.compose(new THREE.Vector3(b.n.x * e + b.t.x * b.c, b.h - STAIR_TREAD / 2, b.n.y * e + b.t.y * b.c),
        new THREE.Quaternion().setFromAxisAngle(AXIS_Y, Math.atan2(b.n.x, b.n.y) + (b.turn ? Math.PI : 0)), // its +z out from the top
        new THREE.Vector3(b.half / STAIR_HALF, 1, 1)));
    });
    scene.add(treads);
  };
  lay(STAIR_BOXES, [plainSide, plainSide, grating, hidden, nosing, plainSide]);
  // the balcony's floor: each wall's strip in rows of treads out from the wall, edge to edge (none over the stairwell);
  // the nosings in the stripes along its open edge and round the stairwell (those treads turned to face it), the rest
  // hidden (seen from under it, they striped the whole of it)
  const deck = [[], []], rows = Math.round(BALCONY_D / STAIR_RUN), wellRows = Math.round(TILE / STAIR_RUN), [w0, w1] = BALCONY_WELL;
  BALCONY_WALLS.forEach((n, k) => {
    for (let r = 0; r < rows; r++) for (let a = STAIR_HALF - ARENA; a < BALCONY_IN; a += TILE) { // a: a tread's middle along the wall
      const well = !k && a > w0 && a < w1;
      if (well && r < wellRows) continue;
      const d = BALCONY_D + 0.5 - ARENA, bridged = BALCONY_BRIDGES.some((b) => inStairBox(b, n.y * a + n.x * d, -n.x * a + n.y * d)); // (a
      // bridge goes on from it)
      const turn = well && r === wellRows, edge = turn || (r === rows - 1 && Math.abs(a) < BALCONY_IN && !bridged);
      deck[+edge].push({ ...deckBox(n, a - STAIR_HALF, a + STAIR_HALF, r * STAIR_RUN, (r + 1) * STAIR_RUN), turn });
    }
  });
  for (const b of BALCONY_BRIDGES) for (let r = 0; r < Math.round((b.e1 - b.e0) / STAIR_RUN); r++) { // the bridges: rows
    // of treads along each, a tread across (none on the one along x where the other crosses it)
    const e0 = b.e0 + r * STAIR_RUN, mid = e0 + STAIR_RUN / 2 - ARENA;
    if (!b.n.x || mid < BALCONY_BRIDGE[0] || mid > BALCONY_BRIDGE[1]) deck[0].push({ ...b, e0, e1: e0 + STAIR_RUN });
  }
  lay(deck[0], [plainSide, plainSide, grating, hidden, hidden, hidden]);
  lay(deck[1], [plainSide, plainSide, grating, hidden, nosing, hidden]);
  // A stringer: drawn in (out from the top, up), its top along the treads' nosings, STRINGER_D deep, cut off level
  // with the floor and the top's edge; extruded STRINGER_W across the flight (the platform's flights one shape, the
  // balcony's another)
  for (const flights of [FLIGHTS, [BALCONY_FLIGHT]]) {
    const { top, run } = flights[0], foot = (top - STRINGER_D) / STAIR_SLOPE;
    const plate = new THREE.ExtrudeGeometry(new THREE.Shape([[0, top], [0, top - STRINGER_D], [foot, 0], [run, 0],
      [run, top - run * STAIR_SLOPE]].map(([x, y]) => new THREE.Vector2(x, y))), { depth: STRINGER_W, bevelEnabled: false });
    const puv = plate.attributes.uv;
    for (let i = 0; i < puv.count; i++) puv.setXY(i, puv.getX(i) / TILE, puv.getY(i) / TILE); // metres → tiles
    const stringers = new THREE.InstancedMesh(withGrimeOffsets(plate, flights.length * 2), plainSide, flights.length * 2);
    flights.forEach((f, i) => [1, -1].forEach((side, k) => {
      // basis: x out from the top, y up, z = x × y (= −t); extruded along z, so it starts at the far edge of its strip
      const a = f.c + (side > 0 ? f.half + STRINGER_W : -f.half);
      m.makeBasis(new THREE.Vector3(f.n.x, 0, f.n.y), AXIS_Y, new THREE.Vector3(-f.t.x, 0, -f.t.y))
        .setPosition(f.n.x * f.o + f.t.x * a, 0, f.n.y * f.o + f.t.y * a);
      stringers.setMatrixAt(i * 2 + k, m);
    }));
    scene.add(stringers);
  }
  const steel = {}; // the balcony's steel (see BALCONY_STEEL): one instanced box a size
  for (const b of BALCONY_STEEL) (steel[b.size.toArray()] ??= []).push(b);
  for (const parts of Object.values(steel)) {
    const mesh = new THREE.InstancedMesh(withGrimeOffsets(tiledBox(parts[0].size), parts.length), plainSide, parts.length);
    parts.forEach((b, i) => mesh.setMatrixAt(i, m.makeTranslation(b.at)));
    scene.add(mesh);
  }
  // Two strip lights set into the top, parallel: opposite sides of a square in the middle. A shallow steel
  // housing, its top a glowing lens, barely proud of the plate (you walk over them).
  const len = PLATFORM_STRIP_SQUARE, half = len / 2, strip = new THREE.BoxGeometry(len, 0.02, 3 / 32);
  const lens = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x96d2ff, emissiveIntensity: 5 }); // STRIP_COLOR
  const strips = new THREE.InstancedMesh(withGrimeOffsets(strip, 2), [plainSide, plainSide, lens, plainSide, plainSide, plainSide], 2);
  [-half, half].forEach((z, k) => {
    strips.setMatrixAt(k, m.compose(new THREE.Vector3(0, PLATFORM_H + 0.01, z), new THREE.Quaternion(), ONE)); // along x
    for (const x of [-half / 2, half / 2]) platformLamps.push(new THREE.Vector3(x, PLATFORM_H + 0.25, z)); // STRIP_HEIGHT above it
  });
  scene.add(strips);
  // A red X painted on the middle: 2 m across, 32 px/m like everything else, bars ~25 cm wide, the paint worn
  // through in places (to the rubber: the texture's cut-out)
  const X_PX = 64, xPx = new Uint8Array(X_PX * X_PX * 4);
  for (let y = 0; y < X_PX; y++) for (let x = 0; x < X_PX; x++) {
    const paint = Math.min(Math.abs(x - y), Math.abs(x + y - (X_PX - 1))) / Math.SQRT2 < 4 && x > 1 && y > 1 && x < X_PX - 2 && y < X_PX - 2;
    xPx.set([186, 28, 22, paint && Math.random() > 0.06 ? 255 : 0], (y * X_PX + x) * 4);
  }
  const xMap = Object.assign(new THREE.DataTexture(xPx, X_PX, X_PX), {
    colorSpace: THREE.SRGBColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    anisotropy: renderer.capabilities.getMaxAnisotropy(), needsUpdate: true,
  });
  const mark = new THREE.Mesh(new THREE.PlaneGeometry(X_PX / 32, X_PX / 32).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({
    map: xMap, alphaTest: 0.5, roughness: 0.6, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, // painted on the top: drawn over it
  }));
  mark.position.y = PLATFORM_H;
  scene.add(mark);
}

// Weld seams: the welded plates aren't scattered at random. Their seams join up into networks, the way plates
// are welded along runs: grown like a maze (randomised depth-first search, the "recursive backtracker") on a
// lattice of every other tile, a node each 4 m with a passage tile between, over the open floor (clear of the
// platform, its stairs, the columns, the towers, the lamp rows and the wall). WELD_RUNS networks of up to
// WELD_RUN_NODES nodes each; then each tile takes the piece (end, straight, corner, tee, cross) and quarter turn
// that joins its seam to its neighbours'.
const WELD_RUNS = 3, WELD_RUN_NODES = 14;
const WELD_PIECES = { weld_end: 'W', plain_welded: 'WE', weld_corner: 'WN', weld_tee: 'WEN', weld_cross: 'WENS' }; // as drawn
const weldTurn = new Map(); // cell → quarter turns about +Y
{
  const DIRS = { E: [1, 0], W: [-1, 0], N: [0, -1], S: [0, 1] }, BACK = { E: 'W', W: 'E', N: 'S', S: 'N' };
  const TURN = { E: 'N', N: 'W', W: 'S', S: 'E' }; // a quarter turn about +Y (image N is −z)
  const links = new Map(); // cell → its seam's directions
  const at = (col, row) => row * TILES + col;
  const open = (col, row) => {
    const cell = at(col, row), p = tilePos(cell);
    if (tilePick[cell] === floorLightType || links.has(cell)) return false; // not the lamps
    if (Math.abs(p.x) > ARENA - TILE || Math.abs(p.z) > ARENA - TILE) return false;
    if (platformDist(p.x, p.z) < PLATFORM_APOTHEM + TILE || STAIR_BOXES.some((b) => inStairBox(b, p.x, p.z, TILE))) return false;
    return COLUMNS.every((c) => Math.hypot(p.x - c.x, p.z - c.y) > COLUMN_REACH + TILE)
      && TOWERS.every((c) => Math.hypot(p.x - c.x, p.z - c.y) > TOWER_REACH + TILE);
  };
  const link = (col, row, d) => (links.get(at(col, row)) ?? links.set(at(col, row), new Set()).get(at(col, row))).add(d);
  const nodes = [];
  for (let row = 0; row < TILES; row += 2) for (let col = 0; col < TILES; col += 2) if (open(col, row)) nodes.push([col, row]);
  for (let run = 0; run < WELD_RUNS; run++) {
    const starts = nodes.filter(([c, r]) => !links.has(at(c, r)));
    if (!starts.length) break;
    const stack = [starts[(Math.random() * starts.length) | 0]];
    links.set(at(...stack[0]), new Set());
    for (let count = 1; stack.length && count < WELD_RUN_NODES;) {
      const [c, r] = stack.at(-1);
      const ways = Object.entries(DIRS).filter(([, [dc, dr]]) => open(c + dc, r + dr) && open(c + 2 * dc, r + 2 * dr));
      if (!ways.length) { stack.pop(); continue; } // dead end: back up and branch from earlier
      const [d, [dc, dr]] = ways[(Math.random() * ways.length) | 0];
      link(c, r, d); link(c + dc, r + dr, BACK[d]); link(c + dc, r + dr, d); link(c + 2 * dc, r + 2 * dr, BACK[d]);
      stack.push([c + 2 * dc, r + 2 * dr]); count++;
    }
  }
  const names = Object.keys(FLOOR_TILES);
  for (const [cell, dirs] of links) {
    if (!dirs.size) continue; // a lone start with nowhere to go
    const fits = [];
    for (const [name, base] of Object.entries(WELD_PIECES)) {
      let set = [...base];
      for (let k = 0; k < 4; k++, set = set.map((d) => TURN[d])) if (set.length === dirs.size && set.every((d) => dirs.has(d))) fits.push([name, k]);
    }
    const [name, k] = fits[(Math.random() * fits.length) | 0];
    tilePick[cell] = names.indexOf(name);
    weldTurn.set(cell, k);
  }
}

Object.keys(FLOOR_TILES).forEach((name, type) => {
  const mat = tileMat(name);
  addFloorBlood(mat);
  const cells = tilePick.flatMap((t, i) => (t === type ? [i] : []));
  const mesh = new THREE.InstancedMesh(withGrimeOffsets(tileGeo, cells.length), mat, cells.length);
  const m = new THREE.Matrix4();
  // quarter turns at random; a lamp's slit on its right (half turned), then on its left (as authored), meeting
  const halfTurn = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, Math.PI), noTurn = new THREE.Quaternion();
  cells.forEach((cell, i) => mesh.setMatrixAt(i, m.compose(tilePos(cell),
    type === floorLightType ? (cell % TILES % 3 === 0 ? halfTurn : noTurn)
      : weldTurn.has(cell) ? new THREE.Quaternion().setFromAxisAngle(AXIS_Y, weldTurn.get(cell) * Math.PI / 2) // its seam joined up
        : randomTurn(AXIS_Y, 4), ONE)));
  mesh.receiveShadow = true;
  scene.add(mesh);
});

