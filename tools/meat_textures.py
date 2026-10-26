"""Authors pixel-art meat: small bits flung off bodies shot to pieces, tumbling, drawn by the game as quads that face
you (see the gibs in index.html). Each kind BIT_FRAMES views a full turn end over end (about an axis of its own, so its
grain turns with it), BIT px a frame:
  chunk  a lump of muscle            fatty  muscle with a rind of fat     bone  a lump of meat, a bloody stub of bone out of it
  gut    a curl of gut               flap   a torn flap of flesh         clot  a dark, wet clot of blood
(all of them chunky and red: a bare splinter, a thin flap seen edge on, they lay on the floor like litter; and nothing
bigger: a heap of them left lying read as dung)

A bit: lumps are ellipsoids (each turned its own way, most torn open: a cap cut off); bone and gut are chains of
spheres. Rendered orthographically along −Z (you're on +Z), SS× supersampled: each ray's nearest hit, its normal (the
shape's, plus a bump from the material's grain: muscle fibre along the chunk, fat's dimpling) and what it hit. Then, per
hit:
- colour: the material's (muscle a deep red with fibre streaks, marbled with fat, brighter where it's torn open; fat a
  dull yellow smeared with blood; bone ivory under blood stains, the meat still on its root, dark marrow where it's
  snapped; gut a dusky red with darker veins), blood pooled into the crevices
- occlusion (crevices): how much of the bit stands in front of it close round it (screen-space, from the hits' depths),
  baked into the colour (a quad has no shape for the lights to find)
- wetness: how glossy (clots and pooled blood most, torn faces next, gut middling, clean bone least)
Downsampled to the pixel size: hard-edged (a subsample's coverage over half: a pixel), colour and normal averaged.

No light direction is baked: the game lights each pixel by its normal, from the lights around the bit (see MEAT_* in
index.html), with a wet glint where it's wet.

Scale: PX m a pixel (as the sprites near you, ~the enemies' 128 px over 2.2 m); a bit's frame BIT px, its middle the
bit's.

Writes one sheet (a row a kind, in BITS' order; its frames across, the turn's steps in order):
  textures/meat_bits.png     colour (sRGB), occlusion and pooled blood baked in; alpha: the bit (0 or 255)
  textures/meat_bits_n.png   RGB: normal (x right, y up, z towards you; 0.5 + 0.5·n), A: wetness
Run: python3 tools/meat_textures.py [preview dir]   (stdlib only; seeded, so output is reproducible; a preview dir gets
the sheet lit from above-left and blown up, to look at)"""
import math, random, struct, sys, zlib
from pathlib import Path

SS = 4                         # subsamples a side
PX = 0.015                     # m a pixel
TILE = 8                       # px: the screen tiles that sort the shapes (only those over a tile are tested in it)

# ---------------------------------------------------------------------------------------------------------- noise ---
def hash3(x, y, z, s):
    h = (x * 374761393 + y * 668265263 + z * 2147483647 + s * 1274126177) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0

def noise3(x, y, z, s=0):  # value noise, 0..1, smooth
    xi, yi, zi = math.floor(x), math.floor(y), math.floor(z)
    fx, fy, fz = x - xi, y - yi, z - zi
    fx, fy, fz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)
    def lerp(a, b, t): return a + (b - a) * t
    c = [[[hash3(xi + i, yi + j, zi + k, s) for k in (0, 1)] for j in (0, 1)] for i in (0, 1)]
    return lerp(lerp(lerp(c[0][0][0], c[0][0][1], fz), lerp(c[0][1][0], c[0][1][1], fz), fy),
                lerp(lerp(c[1][0][0], c[1][0][1], fz), lerp(c[1][1][0], c[1][1][1], fz), fy), fx)

def fbm(x, y, z, s, octaves=3):
    v, a, t = 0.0, 0.5, 0.0
    for o in range(octaves):
        v += a * noise3(x, y, z, s + o); t += a; x, y, z, a = x * 2.03, y * 2.03, z * 2.03, a * 0.5
    return v / t

# --------------------------------------------------------------------------------------------------------- shapes ---
def rot(yaw, pitch, roll):  # rows: the shape's own axes, in the world
    cy, sy, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    # R = Ry(yaw) · Rx(pitch) · Rz(roll), its columns the local axes; return them as rows (world → local)
    m = [[cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp],
         [cp * sr, cp * cr, -sp],
         [-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp]]
    return [[m[0][i], m[1][i], m[2][i]] for i in range(3)]

class Shape:  # an ellipsoid: centre c, radii r (along its own axes R's rows), a material, a seed for its grain; cut: a
    # torn face, (n, d): only where n·u <= d of it is left (u: on its unit sphere, its own axes), or None
    def __init__(self, c, r, R, mat, seed, part=0.0, cut=None):
        self.c, self.r, self.R, self.mat, self.seed, self.part, self.cut = c, r, R, mat, seed, part, cut  # part: 0..1 along a chain
        self.reach = max(r)
    def clip(self, lo, ld, t, t1):  # a ray (lo + t·ld, on its unit sphere) in it from t to t1, cut to its side of the
        # cut: → (where it enters, through the cut face?) or None
        if not self.cut: return t, False
        n, d = self.cut
        dn, on = sum(n[i] * ld[i] for i in range(3)), sum(n[i] * lo[i] for i in range(3))
        if abs(dn) < 1e-12: return None if on > d else (t, False)
        face = False
        if dn > 0: t1 = min(t1, (d - on) / dn)
        elif (d - on) / dn > t: t, face = (d - on) / dn, True
        return (t, face) if t <= t1 else None
    def hit(self, x, y):  # the ray down −Z from (x, y): (z of the near hit, local point on the unit sphere, on its cut
        # face?) or None
        R, c, r = self.R, self.c, self.r
        o = (x - c[0], y - c[1], 10.0 - c[2])
        lo = [(R[i][0] * o[0] + R[i][1] * o[1] + R[i][2] * o[2]) / r[i] for i in range(3)]
        ld = [-R[i][2] / r[i] for i in range(3)]
        a = ld[0] * ld[0] + ld[1] * ld[1] + ld[2] * ld[2]
        b = 2 * (lo[0] * ld[0] + lo[1] * ld[1] + lo[2] * ld[2])
        cc = lo[0] * lo[0] + lo[1] * lo[1] + lo[2] * lo[2] - 1
        disc = b * b - 4 * a * cc
        if disc < 0: return None
        got = self.clip(lo, ld, (-b - math.sqrt(disc)) / (2 * a), (-b + math.sqrt(disc)) / (2 * a))
        if got is None: return None
        t, face = got
        return 10.0 - t, [lo[i] + t * ld[i] for i in range(3)], face

def tear(rng, r, odds):  # a chunk's torn face (or None): a random way through it, a cap of it cut off (in its own axes, m)
    if rng.random() >= odds: return None
    m = [rng.gauss(0, 1) for _ in range(3)]; ml = math.hypot(*m); m = [v / ml for v in m]
    return m, math.sqrt(sum((m[i] * r[i]) ** 2 for i in range(3))) * rng.uniform(0.15, 0.55)  # (its reach that way: the support)
def torn(t, rb, off):  # that face, for one of the chunk's lumps (radii rb, off its middle by off), on its unit sphere
    return ([t[0][i] * rb[i] for i in range(3)], t[1] - sum(t[0][i] * off[i] for i in range(3))) if t else None

def chain(shapes, pts, radius, mat, seed):  # spheres along a polyline, close enough to read as a tube
    seg = [(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(math.dist(a, b) for a, b in seg); done = 0.0
    for a, b in seg:
        L = math.dist(a, b); n = max(1, int(L / (radius(done / total) * 0.45)))
        for i in range(n):
            t = i / n; p = [a[k] + (b[k] - a[k]) * t for k in range(3)]; f = (done + L * t) / total
            rr = radius(f)
            shapes.append(Shape(p, [rr] * 3, rot(0, 0, 0), mat, seed, f))
        done += L
    shapes.append(Shape(pts[-1], [radius(1.0)] * 3, rot(0, 0, 0), mat, seed, 1.0))  # the end itself (a snapped bone's marrow)

# ----------------------------------------------------------------------------------------------------- materials ---
def srgb_to_lin(c): return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def lin_to_srgb(c): return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
MEAT, MEAT_DARK, FAT, BONE, MARROW, GUT, VEIN, BLOOD = ((0.68, 0.09, 0.08), (0.36, 0.02, 0.03), (0.74, 0.58, 0.4),
    (0.86, 0.8, 0.68), (0.35, 0.06, 0.05), (0.56, 0.13, 0.16), (0.34, 0.04, 0.09), (0.3, 0.02, 0.03))
# (pale pieces, clean bone, creamy fat and pink gut, glowed near white under the lights: litter, not meat. So the bone is
# stained, the fat smeared, the gut a dusky red, and blood pools over all of it)
CUT = (0.86, 0.13, 0.11)  # a torn face's raw muscle: brighter than the outside, drying darker
def mix(a, b, t): return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))

def fat(x, y, z, seed):  # fat: a dull yellow, dimpled, smeared with blood (clean and creamy, it looked like egg white)
    d = fbm(x * 30, y * 30, z * 30, seed, 3)
    col = mix(FAT, (0.88, 0.77, 0.56), d)
    smear = fbm(x * 12 + 3, y * 12, z * 12, seed + 9, 2)
    col = mix(col, BLOOD, min(max((smear - 0.3) / 0.25, 0.0), 1.0) * 0.85)
    return col, 0.45 + 0.4 * (smear > 0.45), ((d - 0.5) * 0.6, (fbm(x * 30 + 5, y * 30, z * 30, seed, 3) - 0.5) * 0.6, 0)

def material(s, lp, at, face=False):  # → (colour, wetness, bump normal offset (local), in the shape's grain); face: on its cut
    u, v, w = lp  # on its unit sphere, in its own axes
    x, y, z = at  # where it is, in the tumbling bit's own axes
    if s.mat == 'meat' and face:  # torn open: fresh muscle, bright and wet, its fibres' ends a coarse grain across it (a
        # flat face, smooth, caught the light whole: a pale disc, an egg), even through its rind (only skin deep: torn
        # through it, its face was all fat, another egg)
        fib = min(max((fbm(u * 14, v * 14, w * 14, s.seed + 1, 2) - 0.3) / 0.4, 0.0), 1.0)
        col = mix(MEAT_DARK, CUT, 0.35 + 0.65 * fib)
        if fbm(x * 18, y * 18, z * 18, s.seed + 3, 2) > 0.7: col = mix(col, BLOOD, 0.7)  # (blood welling up in it)
        return col, 0.6, ((fib - 0.5) * 1.6, (fbm(u * 14 + 3, v * 14, w * 14, s.seed + 1, 2) - 0.5) * 1.6, 0)
    if s.mat == 'meat' and w > s.part:  # its rind of fat, along one side (s.part: how far across it starts; over its whole
        return fat(x, y, z, s.seed)     # top face, a slab seen from there was a clean pale oval: an egg)
    if s.mat == 'meat':  # muscle: fibres along its long axis (local x), streaks of fat marbling, clotted patches
        fib = fbm(u * 1.5, v * 16, w * 16, s.seed, 2)
        fib = min(max((fib - 0.3) / 0.4, 0.0), 1.0)  # (streaks, contrasty)
        fresh = fbm(x * 9, y * 9, z * 9, s.seed + 11, 2)  # (fresh cuts: brighter; older surfaces darker, drying)
        col = mix(MEAT_DARK, MEAT, (0.1 + 0.9 * fib) * (0.5 + 0.7 * fresh))
        marb = fbm(u * 4 + 9, v * 5, w * 5, s.seed + 7, 3)
        if 0.57 < marb < 0.59: col = mix(col, (0.7, 0.38, 0.3), 0.6)  # (a fine streak, pinked by the blood: wider and
        # paler, where the noise ran flat across a face it spread into a pale patch, an egg)
        clot = fbm(x * 18, y * 18, z * 18, s.seed + 3, 2)
        if clot > 0.66: col = mix(col, BLOOD, 0.8)
        return col, 0.55 + 0.3 * (clot > 0.66), (0, (fib - 0.5) * 0.5, (fbm(u * 1.5 + 4, v * 14, w * 14, s.seed, 2) - 0.5) * 0.5)
    if s.mat == 'fat':  # fat, with thin pink seams
        col, wet, bump = fat(x, y, z, s.seed)
        if abs(fbm(u * 3, v * 3, w * 3, s.seed + 5, 2) - 0.5) < 0.03: col = mix(col, MEAT, 0.6)
        return col, wet, bump
    if s.mat == 'bone':  # bone: ivory under blood, stained along it in patches (clean, it read as sticks), the meat still
        # on it at its root, dark marrow at a snapped tip
        col = mix(BONE, (0.7, 0.66, 0.55), fbm(x * 40, y * 40, z * 40, s.seed, 2))
        stain = min(max((fbm(x * 14, y * 14, z * 14, s.seed + 4, 2) - 0.32) / 0.25, 0.0), 1.0)
        col = mix(col, MEAT_DARK, 0.25 + 0.65 * stain)
        if s.part < 0.3: col = mix(col, MEAT, 1 - s.part / 0.3)
        if s.part > 0.93: col = mix(col, MARROW, 0.8)
        return col, 0.35 + 0.5 * stain, (0, 0, 0)
    if s.mat == 'clot':  # a clot: near black red, glossy, lumpy
        d = fbm(x * 40, y * 40, z * 40, s.seed, 3)
        return mix(BLOOD, (0.45, 0.04, 0.05), d * 0.6), 1.0, ((d - 0.5) * 0.5, (fbm(x * 40 + 5, y * 40, z * 40, s.seed, 3) - 0.5) * 0.5, 0)
    # gut: a dusky red tube, darker veins branching over it, wet
    vn = fbm(x * 25, y * 25, z * 25, s.seed, 3)
    col = mix(GUT, VEIN, max(0.0, 1 - abs(vn - 0.5) * 18))
    col = mix(col, (0.5, 0.12, 0.14), fbm(x * 6, y * 6, z * 6, s.seed + 2, 2) * 0.5)
    return col, 0.65, ((vn - 0.5) * 0.3, (fbm(x * 25 + 3, y * 25, z * 25, s.seed, 3) - 0.5) * 0.3, 0)

# -------------------------------------------------------------------------------------------------------- render ---
def render(shapes, w, h, x0, y0, body, ao):
    # shapes into w×h px (its bottom-left corner at (x0, y0), m); body: world → its own axes (a tumbling bit's: so its
    # grain turns with it); ao: occlusion's tap radii, px. → (colour rows, normal rows), top row first
    N, M = w * SS, h * SS
    step = PX / SS
    # sort the shapes into screen tiles by their reach (conservative)
    tiles = {}
    for s in shapes:
        lo_x, hi_x = math.floor((s.c[0] - s.reach - x0) / PX) // TILE, math.floor((s.c[0] + s.reach - x0) / PX) // TILE
        lo_y, hi_y = math.floor((s.c[1] - s.reach - y0) / PX) // TILE, math.floor((s.c[1] + s.reach - y0) / PX) // TILE
        for tx in range(max(lo_x, 0), min(hi_x, (w - 1) // TILE) + 1):
            for ty in range(max(lo_y, 0), min(hi_y, (h - 1) // TILE) + 1):
                tiles.setdefault((tx, ty), []).append(s)
    Z = [[None] * N for _ in range(M)]   # nearest hit's z (None: nothing)
    hits = [[None] * N for _ in range(M)]
    for j in range(M):
        y = y0 + (j + 0.5) * step         # (row 0: the bottom)
        for i in range(N):
            x = x0 + (i + 0.5) * step
            best = None
            for s in tiles.get((i // SS // TILE, j // SS // TILE), ()):
                got = s.hit(x, y)
                if got and (best is None or got[0] > best[0]): best = (got[0], got[1], s, got[2])
            if best: Z[j][i], hits[j][i] = best[0], best
    # occlusion: how much of the bit is in front close round each hit (12 taps at 2 radii)
    taps = [(math.cos(a) * r, math.sin(a) * r) for r in (ao[0] * SS, ao[1] * SS) for a in [k * math.pi / 3 + r for k in range(6)]]
    out_col, out_n, cover = [[None] * N for _ in range(M)], [[None] * N for _ in range(M)], [[0] * N for _ in range(M)]
    for j in range(M):
        for i in range(N):
            hit = hits[j][i]
            if not hit: continue
            z, lp, s, face = hit
            occ = 0.0
            for dx, dy in taps:
                ii, jj = int(i + dx), int(j + dy)
                if 0 <= ii < N and 0 <= jj < M and Z[jj][ii] is not None:
                    dz = Z[jj][ii] - z
                    if dz > 0.005: occ += min(dz / 0.06, 1.0)
            occ = min(occ / len(taps) * 2.6, 1.0)
            y = y0 + (j + 0.5) * step
            world = (x0 + (i + 0.5) * step, y, z)
            col, wet, bump = material(s, lp, [sum(body[a][k] * world[k] for k in range(3)) for a in range(3)], face)
            # normal: the ellipsoid's (gradient on the unit sphere, scaled back; or its cut face's), with the grain's bump,
            # to the world
            R, r = s.R, s.r
            g = [v / math.hypot(*s.cut[0]) for v in s.cut[0]] if face else lp  # (unit, as lp is: else the bump swamped it)
            nl = [g[k] / r[k] + bump[k] / r[k] * 0.35 for k in range(3)]
            nw = [sum(R[k][a] * nl[k] for k in range(3)) for a in range(3)]
            nlen = math.hypot(*nw); nw = [v / nlen for v in nw]
            if nw[2] < 0.05: nw[2] = 0.05  # (facing you, as anything you see must)
            # blood: pooled in the crevices, glossy
            pool = max(occ * 1.2 - 0.25, 0)
            pool = min(pool * (0.7 + 0.6 * fbm(world[0] * 20, y * 20, z * 20, 99, 2)), 1.0)
            col = mix(col, BLOOD, pool * 0.85)
            wet = max(wet, pool)
            shade = (1 - occ * 0.85) * (0.6 + 0.4 * nw[2])  # occlusion, and a dark wet rim round each piece (where it
            # turns away from you)
            out_col[j][i] = tuple(srgb_to_lin(c) * shade for c in col)
            out_n[j][i] = (nw, wet)
            cover[j][i] = 1
    # down to pixels: hard-edged (over half its subsamples covered: a pixel), colour averaged (linear), normal averaged
    rgba, nrm = [], []
    for py in range(h - 1, -1, -1):  # (top row first)
        rc, rn = [], []
        for px in range(w):
            cs, ns, ws, n = [0, 0, 0], [0, 0, 0], 0.0, 0
            for j in range(py * SS, py * SS + SS):
                for i in range(px * SS, px * SS + SS):
                    if cover[j][i]:
                        n += 1
                        for k in range(3): cs[k] += out_col[j][i][k]; ns[k] += out_n[j][i][0][k]
                        ws += out_n[j][i][1]
            if n * 2 <= SS * SS: rc.append((0, 0, 0, 0)); rn.append((128, 128, 255, 0)); continue
            q = lambda v: max(0, min(255, round(v * 255)))
            rc.append(tuple(q(lin_to_srgb(c / n)) for c in cs) + (255,))
            L = math.hypot(*ns) or 1
            rn.append(tuple(q(0.5 + 0.5 * v / L) for v in ns) + (q(ws / n),))
        rgba.append(rc); nrm.append(rn)
    return rgba, nrm

BIT, BIT_FRAMES = 16, 8  # px a frame (0.24 m); frames a turn
def lump(rng, shapes, size, cap, flat, mat='meat', at=(0, 0, 0)):  # a bit's lump: a few ellipsoids round at
    R, seed = rot(rng.uniform(0, math.pi), rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4)), rng.randrange(1 << 16)
    r = [size * rng.uniform(1.0, 1.3), size * flat, size * rng.uniform(0.7, 0.95)]
    t = tear(rng, r, 0.8 if mat == 'meat' else 0)
    for b in range(5):  # (three, whole: smooth, they read as beans)
        off = [rng.uniform(-0.55, 0.55) * r[0], rng.uniform(-0.25, 0.25) * r[1], rng.uniform(-0.45, 0.45) * r[2]] if b else [0, 0, 0]
        wo = [sum(R[i][a] * off[i] for i in range(3)) for a in range(3)]
        sc = 1.0 if b == 0 else rng.uniform(0.5, 0.8)
        rb = [v * sc for v in r]
        shapes.append(Shape([at[k] + wo[k] for k in range(3)], rb, R, mat, seed, cap, torn(t, rb, off)))
def curl(rng, shapes):  # a curl of gut
    pts = [[math.cos(a) * 0.05, math.sin(a) * 0.035, 0.02 * math.sin(a * 2)] for a in (i / 10 * 1.5 * math.pi for i in range(11))]
    chain(shapes, pts, lambda f: 0.026 * (0.9 + 0.15 * math.sin(f * 30)), 'gut', rng.randrange(1 << 16))
BITS = {
    'chunk': lambda rng, s: lump(rng, s, 0.075, 2.0, 0.65),
    'fatty': lambda rng, s: lump(rng, s, 0.075, 0.7, 0.6),
    'bone': lambda rng, s: (lump(rng, s, 0.065, 2.0, 0.65, at=(-0.015, 0, 0)),
                            chain(s, [[0.02, 0.005, 0], [0.085, 0.02, 0]], lambda f: 0.017, 'bone', rng.randrange(1 << 16))),
    'gut': curl,
    'flap': lambda rng, s: (lump(rng, s, 0.07, 2.0, 0.35, at=(-0.03, 0, 0)), lump(rng, s, 0.055, 2.0, 0.35, at=(0.04, 0.015, 0.01))),
    # (two torn pieces, each its own way: one smooth flat oval, face on, looked like an egg)
    'clot': lambda rng, s: lump(rng, s, 0.055, 2.0, 0.75, mat='clot'),
}
def bit(name):  # its frames: the bit turned a step further about its axis each one
    rng = random.Random(f'meat bit {name}')
    shapes = []
    BITS[name](rng, shapes)
    t = rng.uniform(0, 2 * math.pi)
    ax = [math.cos(t), rng.uniform(-0.3, 0.3), math.sin(t)]  # (mostly level: end over end)
    al = math.hypot(*ax); ax = [v / al for v in ax]
    frames = []
    for f in range(BIT_FRAMES):
        a = 2 * math.pi * f / BIT_FRAMES; c, sn, (x, y, z) = math.cos(a), math.sin(a), ax
        Q = [[c + x * x * (1 - c), x * y * (1 - c) - z * sn, x * z * (1 - c) + y * sn],  # (about ax, by a)
             [y * x * (1 - c) + z * sn, c + y * y * (1 - c), y * z * (1 - c) - x * sn],
             [z * x * (1 - c) - y * sn, z * y * (1 - c) + x * sn, c + z * z * (1 - c)]]
        turned = [Shape([sum(Q[a2][k] * sh.c[k] for k in range(3)) for a2 in range(3)], sh.r,
                        [[sum(Q[a2][k] * sh.R[i][k] for k in range(3)) for a2 in range(3)] for i in range(3)], sh.mat, sh.seed, sh.part, sh.cut)
                  for sh in shapes]
        QT = [[Q[k][a2] for k in range(3)] for a2 in range(3)]  # (world → the bit's own axes)
        frames.append(render(turned, BIT, BIT, -BIT * PX / 2, -BIT * PX / 2, body=QT, ao=(1, 2)))
    return frames

def png(path, rows):
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    raw = b''.join(b'\0' + bytes(c for px in row for c in px) for row in rows)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', len(rows[0]), len(rows), 8, 6, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    print('wrote', path)

def preview(rgba, nrm, light=(-0.5, 0.7, 0.5), scale=6):  # lit from above-left as the game would (see MEAT_*), on grey
    L = [v / math.hypot(*light) for v in light]; Hh = [L[0], L[1], L[2] + 1]; hl = math.hypot(*Hh); Hh = [v / hl for v in Hh]
    rows = []
    for rc, rn in zip(rgba, nrm):
        row = []
        for c, n in zip(rc, rn):
            if not c[3]: row.extend([(40, 40, 44, 255)] * scale); continue
            nv = [(v / 255 - 0.5) * 2 for v in n[:3]]; wet = n[3] / 255
            d = max(sum(nv[k] * L[k] for k in range(3)), 0); sp = max(sum(nv[k] * Hh[k] for k in range(3)), 0) ** 40 * wet
            lit = [srgb_to_lin(c[k] / 255) * (0.35 + 1.0 * d) + sp * 0.6 for k in range(3)]
            row.extend([tuple(max(0, min(255, round(lin_to_srgb(min(v, 1)) * 255))) for v in lit) + (255,)] * scale)
        for _ in range(scale): rows.append(row)
    return rows

if __name__ == '__main__':
    out = Path(__file__).resolve().parent.parent / 'textures'
    pv = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    rows = [bit(name) for name in BITS]  # a row a kind, its frames across
    sheet = lambda k: [sum((fr[k][y] for fr in row), []) for row in rows for y in range(BIT)]
    png(out / 'meat_bits.png', sheet(0))
    png(out / 'meat_bits_n.png', sheet(1))
    print(f'  bits: {len(BITS)} kinds × {BIT_FRAMES} frames, {BIT} px')
    if pv: pv.mkdir(parents=True, exist_ok=True); png(pv / 'meat_bits_lit.png', preview(sheet(0), sheet(1), scale=8))
