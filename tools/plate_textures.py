"""Authors pixel-art brushed (#4 satin) stainless floor tiles as PBR sets, one per hole pattern (64px, one tile each):
  vent   round holes, staggered near-hex lattice (5 rows of 5 and 4)
  slits  long narrow slots spanning the tile (4 rows, a blank row's margin top and bottom)
  plain  no holes, just the plate
  light  plate with a recessed LED strip across the middle
  cover  plain plate with an octagonal cover plate laid on top, a domed rivet in each corner
Tiles are self-contained (holes never cross the edge, a recessed seam runs round it) so any two can
sit side by side.

Scale: one tile is 2 m (texture X and Y), 64 px, so ~31 mm per pixel. Brush direction: texture X.
The brushing is simulated, not painted: thousands of discrete abrasive scratches on a 4×-supersampled
height field (rounded grooves with small raised edges, mostly shallow with a few deep, tapered ends), three
belt passes a fraction of a degree apart, slow banding from uneven belt contact, sparse pits and faint
chatter. Real #4 scratches are microns; nothing at 31 mm/px can draw them one by one, so they're scaled up
but normalised to a given slope distribution (what reflection actually depends on): across the brush GGX
alpha ≈ BRUSH_ALPHA. Downsampling to 64 px moves their slope variance into roughness separately across and
along the lines (LEAN/Toksvig-style), which becomes roughness + anisotropy. Their mean height does NOT go
into the normal map: real scratches average out flat over a 31 mm pixel, and the scaled-up ones leaking in
read as dents. The finish is a worn floor, not a fresh mill sheet: a fresh #4 is ≥10× smoother along the
brush (near-mirror along it, glaring in the sun); here BASE_ALPHA floors it at ~2×.
On top lies a worn grime/oxide film (grime_mask): patchy scuffs from tileable noise plus dirt packed into
seams, round holes and plate edges, quantised to 4 dithered levels. It's a dielectric, so where it lies the
steel goes darker, non-metallic, rough and loses its brush anisotropy: it stops mirroring the sun.
No lighting or shading is baked into any map.

Each <name> writes:
  textures/<name>.png      base colour (sRGB): uniform stainless (0.56, 0.57, 0.585 linear); holes black
  textures/<name>_h.png    height, 16-bit grayscale, min..max per tile (range printed when run)
  textures/<name>_n.png    tangent-space normal map (OpenGL, +Y up), derived from that height
  textures/<name>_orm.png  R = ambient occlusion (cavities only), G = roughness along the brush,
                           B = metalness, A = specular strength (0 in holes: no sheen, they stay black)
  textures/<name>_a.png    anisotropy (three.js anisotropyMap): RG = direction (texture Y, across the brush,
                           where the surface is roughest), B = strength
  textures/<name>_e.png    emissive colour (sRGB), only for tiles that glow; brightness is set in the game
Run: python3 tools/plate_textures.py   (stdlib only; seeded, so output is reproducible)"""
import math, random, struct, zlib
from pathlib import Path

N = 64
WALL_W, BEVEL_W = 1.0, 1.8  # px: hole wall, edge pressed down into the hole
BUMP = 3.0                # feature height → normal strength

SS = 4                                  # height-field samples per pixel, each way
PASSES = (-0.3, 0.05, 0.35)             # belt angles, degrees off texture X
SCRATCHES = 700                         # per pass
PITS = 40
BRUSH_ALPHA = 0.55                      # GGX alpha across the brush
BASE_ALPHA = 0.25                       # wear below the height field's resolution: sets how glossy it is along the brush
STEEL = (0.56, 0.57, 0.585)             # linear base colour
GRIME = (0.05, 0.046, 0.042)            # linear: dark brown-grey oxide and dirt
GRIME_ROUGH = 0.85
GRIME_PATCH, GRIME_EDGE = 0.9, 0.8      # how much the scuff patches and the packed-in edge dirt contribute


# Hole centres sit on whole pixels at whole-pixel spacing, so every hole rasterises identically. Rows are 10 px
# apart, the hole's full footprint (2 × (R + BEVEL_W)), and columns 12 px (≈ hexagonal), so rims never clip.
# 5 rows alternating 5 and 4 holes, centred in the tile.
VENT_R = 3.2
VENT_HOLES = [(N / 2 + 12 * (k - (n - 1) / 2), N / 2 + 10 * r)
              for r in range(-2, 3) for n in [5 - abs(r) % 2] for k in range(n)]


def vent(x, y):  # → (distance to the nearest hole's core, hole radius)
    return min(math.hypot(x + 0.5 - cx, y + 0.5 - cy) for cx, cy in VENT_HOLES), VENT_R


def slits(x, y):
    R, rows = 2.0, 6
    h = N / rows
    if not 1 <= (y + 0.5) // h < rows - 1: return math.inf, R  # leave the outer rows blank: margin
    dx, dy = x + 0.5 - N / 2, (y + 0.5) % h - h / 2
    half = N / 2 - 2 - R - BEVEL_W  # slot core: a segment swept by R, ending 2 px short of the tile edge
    return math.hypot(max(abs(dx) - half, 0), dy), R


def plain(x, y):
    return math.inf, 0


LIGHT = (150, 210, 255)  # LED colour


def light(x, y):
    """Housing x 4..59, y 26..37: a 2 px recessed frame round a frosted lens. The lens texels come back
    whole (with emissive); everything else is plain plate."""
    X0, X1, Y0, Y1 = 4, 60, 26, 38
    if not (X0 <= x < X1 and Y0 <= y < Y1): return math.inf, 0
    if x in (X0, X0 + 1, X1 - 2, X1 - 1) or y in (Y0, Y0 + 1, Y1 - 2, Y1 - 1):
        return (60, 63, 68), 0.35, 0.5, 0.5, 1.0, 1.0                                    # recessed frame (own part)
    divider = (x - X0 - 2) % 4 == 3 and x < X1 - 3   # 13 LED segments
    glow = 0.45 if divider else 0.7 if y in (Y0 + 2, Y1 - 3) else 1.0                 # dimmer at the lens edge
    return (210, 225, 235), 0.5, 1.0, 0.25, 0.0, 1.0, tuple(round(c * glow) for c in LIGHT)  # frosted lens: not metal


COVER_A, COVER_C = 26, 8       # px: cover plate half-width; corner chamfer (long sides 2·(A − C), corners C·√2)
COVER_H, COVER_EDGE = 0.4, 1.5  # cover thickness (feature units, like the 1.0 plate); rounded edge width, px
RIVET_INSET, RIVET_R, RIVET_H = 7, 2.0, 0.35  # rivets sit RIVET_INSET px in from both long sides of a corner


def cover(x, y):
    """Plain plate with an octagonal plate on top (raised COVER_H, rounded edge) and a domed rivet in each
    chamfered corner. Rivet centres are on pixel corners so all four rasterise the same."""
    dx, dy = abs(x + 0.5 - N / 2), abs(y + 0.5 - N / 2)
    sd = max(dx - COVER_A, dy - COVER_A, (dx + dy - (2 * COVER_A - COVER_C)) / math.sqrt(2))  # >0 outside
    if sd >= 1: return math.inf, 0
    if sd >= 0: return STEEL_SRGB, 1.0, 0.75, None, 1.0, 1.0  # base plate just outside: the plate's edge shades it
    top = 1 + COVER_H * math.sin(min(-sd / COVER_EDGE, 1) * math.pi / 2)  # rounded edge up onto the top
    r = math.hypot(dx - (COVER_A - RIVET_INSET), dy - (COVER_A - RIVET_INSET))
    if r < RIVET_R:  # forged rivet head: smooth, no brush grain
        return STEEL_SRGB, top + RIVET_H * math.sqrt(1 - (r / RIVET_R) ** 2), 1.0, 0.3, 1.0, 1.0
    return STEEL_SRGB, top, 1.0, None, 1.0, 1.0


srgb = lambda l: round(255 * (12.92 * l if l <= 0.0031308 else 1.055 * l ** (1 / 2.4) - 0.055))
STEEL_SRGB = tuple(srgb(c) for c in STEEL)


def texel(d, R):
    """→ (base colour, height, ao, roughness, metalness, specular). Roughness None = brushed sheet: roughness
    and anisotropy come from the simulated scratches. AO only where the flat texture stands in for a cavity."""
    if d < R - WALL_W: return (0, 0, 0), 0.0, 0.15, 1.0, 0.0, 0.0                        # hole: total black, reflects nothing
    if d < R: return STEEL_SRGB, 0.5 * (d - R + WALL_W) / WALL_W, 0.4, 0.6, 1.0, 1.0      # sheared hole wall: rough, isotropic
    if d < R + BEVEL_W: return STEEL_SRGB, 1 - 0.5 * (1 - (d - R) / BEVEL_W) ** 2, 0.85, None, 1.0, 1.0  # edge rolls down into the hole
    return STEEL_SRGB, 1.0, 1.0, None, 1.0, 1.0


def seam(x, y, t):  # tile edge: a groove pressed into the same brushed sheet
    return (t[0], 0.6, 0.6) + t[3:] if x in (0, N - 1) or y in (0, N - 1) else t


lin = lambda c: (c / 255 / 12.92) if c <= 10 else ((c / 255 + 0.055) / 1.055) ** 2.4


def grime_mask(name, T):
    """0..1 grime per texel, in 4 dithered steps. Patches: three octaves of periodic value noise (cells 16, 8,
    4 px; tiles). Edges: dirt packed within a pixel of anything occluded (the AO channel marks the cavities)."""
    rng = random.Random(name + ' grime')

    def octave(cell):
        g = N // cell
        v = [[rng.random() for _ in range(g)] for _ in range(g)]

        def f(x, y):
            fx, fy = (x + 0.5) / cell - 0.5, (y + 0.5) / cell - 0.5
            x0, y0 = math.floor(fx), math.floor(fy)
            sx, sy = (lambda t: t * t * (3 - 2 * t))(fx - x0), (lambda t: t * t * (3 - 2 * t))(fy - y0)
            row = lambda yy: v[yy % g][x0 % g] + (v[yy % g][(x0 + 1) % g] - v[yy % g][x0 % g]) * sx
            return row(y0) + (row(y0 + 1) - row(y0)) * sy
        return f

    o1, o2, o3 = octave(16), octave(8), octave(4)
    BAYER = ((0, 2), (3, 1))
    M = [[0.0] * N for _ in range(N)]
    for y in range(N):
        for x in range(N):
            t = T[y][x]
            if t[4] < 1 or t[5] < 1: continue  # holes and the lens: no steel to dirty
            n = 0.55 * o1(x, y) + 0.3 * o2(x, y) + 0.15 * o3(x, y)
            patch = min(max((n - 0.5) / 0.25, 0), 1)
            edge = max(1 - T[(y + j) % N][(x + i) % N][2] for i in (-1, 0, 1) for j in (-1, 0, 1))
            g = min(GRIME_PATCH * patch + GRIME_EDGE * edge, 1)
            M[y][x] = min(int(g * 3 + BAYER[y % 2][x % 2] / 4), 3) / 3
    return M


def brushed(seed):
    """Simulated #4 brushing → S×S height field (sample units), tileable."""
    rng = random.Random(seed)
    S = N * SS
    H = [0.0] * (S * S)
    p1, p2 = rng.random() * 6.28, rng.random() * 6.28
    band = [1 + 0.35 * math.sin(4 * math.pi * y / S + p1) + 0.2 * math.sin(14 * math.pi * y / S + p2) for y in range(S)]
    for deg in PASSES:
        tan_a = math.tan(math.radians(deg))
        for _ in range(SCRATCHES):
            x0, y0 = rng.randrange(S), rng.random() * S
            L = rng.randint(40, 320)                              # finite length, in samples
            w = 0.5 + rng.expovariate(2.0)                        # half-width: mostly narrow
            d = w * rng.lognormvariate(0, 0.8) * band[int(y0)]    # mostly shallow, a few much deeper; belt banding
            reach = 1.6 * w
            for i in range(L):
                k = d * math.sin(math.pi * (i + 0.5) / L) ** 0.5  # tapers in and out
                yc, col = y0 + i * tan_a, (x0 + i) % S
                for yy in range(math.floor(yc - reach), math.ceil(yc + reach) + 1):
                    t = abs(yy + 0.5 - yc) / w
                    if t < 1: H[(yy % S) * S + col] -= k * (1 - t * t)                      # rounded groove
                    elif t < 1.6: H[(yy % S) * S + col] += k * 0.3 * math.sin(math.pi * (t - 1) / 0.6)  # raised edge
    for _ in range(PITS):
        cx, cy, r = rng.random() * S, rng.random() * S, 0.8 + rng.random() * 0.8
        for yy in range(math.floor(cy - r), math.ceil(cy + r) + 1):
            for xx in range(math.floor(cx - r), math.ceil(cx + r) + 1):
                q = ((xx + 0.5 - cx) ** 2 + (yy + 0.5 - cy) ** 2) / (r * r)
                if q < 1: H[(yy % S) * S + xx % S] -= 1.5 * r * (1 - q)
    # Grooves remove more than their edges raise, so dense bands would sink and tilt the plate; a belt removes
    # evenly, so take out each row's (along-brush) mean: banding stays in the scratch density, not a slope
    for y in range(S):
        m = sum(H[y * S:(y + 1) * S]) / S
        for x in range(S): H[y * S + x] -= m
    # Normalise to a real satin finish: scale so the typical (median) pixel's slope variance across the brush
    # gives GGX alpha BRUSH_ALPHA (alpha² = BASE_ALPHA² + 2σ²); the deep scratches sit above it
    var_y = sorted(v for row in downsample(H, S)[2] for v in row)[N * N // 2]
    k = math.sqrt((BRUSH_ALPHA ** 2 - BASE_ALPHA ** 2) / 2 / var_y)
    K = S // 12  # chatter: faint periodic marks across the brush, whole cycles so it tiles
    chatter = [BRUSH_ALPHA / math.sqrt(2) / 30 / (2 * math.pi * K / S) * math.sin(2 * math.pi * K * x / S) for x in range(S)]
    return [H[i] * k + chatter[i % S] for i in range(S * S)], S


def downsample(H, S):
    """Per pixel: mean height (in pixel units) and the slope variance along X and across Y that the mean loses."""
    h = lambda x, y: H[(y % S) * S + x % S]
    mean, ax, ay = [[0.0] * N for _ in range(N)], [[0.0] * N for _ in range(N)], [[0.0] * N for _ in range(N)]
    n = SS * SS
    for py in range(N):
        for px in range(N):
            hs = mx = my = mxx = myy = 0.0
            for y in range(py * SS, py * SS + SS):
                for x in range(px * SS, px * SS + SS):
                    sx, sy = (h(x + 1, y) - h(x - 1, y)) / 2, (h(x, y + 1) - h(x, y - 1)) / 2
                    hs += h(x, y); mx += sx; my += sy; mxx += sx * sx; myy += sy * sy
            mx, my = mx / n, my / n
            mean[py][px] = hs / n / SS  # sample → pixel units keeps slopes the same
            ax[py][px], ay[py][px] = max(mxx / n - mx * mx, 0), max(myy / n - my * my, 0)
    return mean, ax, ay


def png(path, rows, bits=8):
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    if bits == 16:  # grayscale ints 0..65535
        color, raw = 0, b''.join(b'\0' + b''.join(struct.pack('>H', v) for v in row) for row in rows)
    else:
        color = 2 if len(rows[0][0]) == 3 else 6
        raw = b''.join(b'\0' + bytes(c for px in row for c in px) for row in rows)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, bits, color, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    print('wrote', path)


b = lambda v: max(0, min(255, round(v * 255)))
out = Path(__file__).resolve().parent.parent / 'textures'
out.mkdir(exist_ok=True)
for shape in (vent, slits, plain, light, cover):
    name = shape.__name__
    _, var_x, var_y = downsample(*brushed(name))  # scratch heights stay out of the normal map (see top)
    alpha = lambda var: [[math.sqrt(BASE_ALPHA ** 2 + 2 * v) for v in row] for row in var]  # LEAN/Toksvig
    alpha_x, alpha_y = alpha(var_x), alpha(var_y)
    # A shape gives (distance to a hole, its radius), or a finished texel for features that aren't holes
    T = [[seam(x, y, s if len(s) > 2 else texel(*s)) for x in range(N) for s in [shape(x, y)]] for y in range(N)]
    brush = [[T[y][x][3] is None for x in range(N)] for y in range(N)]
    H = [[BUMP * T[y][x][1] for x in range(N)] for y in range(N)]  # height in pixel units: the pressed features
    h = lambda x, y: H[y % N][x % N]  # wraps, so the normal map tiles seamlessly
    G = grime_mask(name, T)  # a film: changes colour/roughness/metal, not the shape (normals)

    def colour(x, y):
        g = G[y][x]
        return tuple(srgb(lin(c) * (1 - g) + gc * g) for c, gc in zip(T[y][x][0], GRIME))

    def normal(x, y):
        # Image rows run down but texture v runs up (flipY), hence the sign on ny
        nx, ny = -(h(x + 1, y) - h(x - 1, y)) / 2, (h(x, y + 1) - h(x, y - 1)) / 2
        l = math.sqrt(nx * nx + ny * ny + 1)
        return tuple(b(c / l * 0.5 + 0.5) for c in (nx, ny, 1))

    def orm(x, y):
        t = T[y][x]
        rough = math.sqrt(alpha_x[y][x]) if brush[y][x] else t[3]  # three.js: alpha = roughness²
        g = G[y][x]
        return b(t[2]), b(rough + (GRIME_ROUGH - rough) * g), b(t[4] * (1 - g)), b(t[5])

    def aniso(x, y):
        # three.js stretches the highlight along the map's direction: alphaT = mix(roughness², 1, strength²)
        if not brush[y][x]: return 128, 255, 0
        ax_, ay_ = alpha_x[y][x], alpha_y[y][x]
        return 128, 255, b(math.sqrt(max(ay_ - ax_, 0) / (1 - ax_)) * (1 - G[y][x]))  # grime hides the lines

    lo, hi = min(map(min, H)), max(map(max, H))
    png(out / f'{name}.png', [[colour(x, y) for x in range(N)] for y in range(N)])
    png(out / f'{name}_h.png', [[round((v - lo) / (hi - lo) * 65535) for v in row] for row in H], bits=16)
    png(out / f'{name}_n.png', [[normal(x, y) for x in range(N)] for y in range(N)])
    png(out / f'{name}_orm.png', [[orm(x, y) for x in range(N)] for y in range(N)])
    png(out / f'{name}_a.png', [[aniso(x, y) for x in range(N)] for y in range(N)])
    if any(len(t) > 6 for row in T for t in row):
        png(out / f'{name}_e.png', [[t[6] if len(t) > 6 else (0, 0, 0) for t in row] for row in T])

    # Still clearly brushed: at least 2× smoother along the brush than across
    pairs = sorted((alpha_y[y][x], alpha_x[y][x]) for y in range(N) for x in range(N) if brush[y][x])
    ay_med, ax_med = pairs[len(pairs) // 2][0], sorted(p[1] for p in pairs)[len(pairs) // 2]
    print(f'  {name}: height {lo:.2f}..{hi:.2f} px, alpha across {ay_med:.3f} / along {ax_med:.3f} = {ay_med / ax_med:.1f}×,'
          f' grime {sum(map(sum, G)) / N / N:.0%} average')
    assert ay_med / ax_med >= 2, 'brush lines must be at least 2× smoother along than across'
