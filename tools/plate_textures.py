"""Authors pixel-art brushed (#4 satin) stainless floor tiles as PBR sets, one per hole pattern (64px, one tile each):
  vent   round holes, staggered near-hex lattice (5 rows of 5 and 4)
  slits  long narrow slots spanning the tile (4 rows, a blank row's margin top and bottom)
  plain  no holes, just the plate
  plain_bolted  plain plate held down by a domed bolt (with washer) in each corner
  plain_welded  plain plate with a weld bead across the middle, rippled, in a band of heat tint
  light  plate with a recessed LED strip across the middle
  slitlight  plain plate with a thin glowing slit along its top edge (a downlight; the game hangs a spot under it)
  sidelight  plain plate with a thin vertical glowing slit inside each side edge
  sidelight_left  the same with only the left slit (a half turn makes it a right one)
  cover  plain plate with an octagonal cover plate laid on top, a domed rivet in each corner
  vent_patch  vent with a repair plate welded over part of the lattice (weld bead, heat-tint ring)
  slits_strapped  slits with two raised reinforcing straps across the slots
  cover_hatch  cover plate with a recessed lifting slot in the middle (an access panel)
  treadplate  anti-slip pine-green rubber sheet: raised lozenges in a staggered grid, alternating ±45° (diamond plate)
  wallpanel  the walls' 4 m panel (128 px, 2 × 2 tiles): a corrugated sheet (rounded waves along it, dirt in the
         troughs) in a frame, braced across by an X, frame and X flush with the waves' crests: one flat face; a
         pill-shaped recess on each arm of the X, two on each side of the frame; the frame in front of the X (the
         X's arms run on under it); square plates fastening it on its corners and its middle, riveted; a cell of its own, a
         bevelled bezel round its edge; drawn at 128 px, written at 64 (16 px/m: chunkier pixels than the tiles')
  wallpanel_yellow, wallpanel_striped  the same, for the bottom row of the walls: the lower half of its sheet painted,
         the hazard stripes' yellow / white, a few diagonal stripes of that yellow on it; its frame, X and
         plates bare steel. One pair of opposite walls each
  slits_cut  slits' see-through mask (the stair treads)
  glass_slits, glass_panels  a framed glass window onto the void under the floor: pipes over the slits / cover plate, on and on
  weld_end, weld_corner, weld_tee, weld_cross  plain_welded's other pieces: the bead from the centre to the W / W+N / W+E+N / every edge
  walllight  plate with a deep recessed fixture: a glowing semi-cylindrical tube with metal end caps in a dark
         housing, under a clear cover embossed with ridges along the slot (built for parallax mapping)
Tiles are self-contained (holes never cross the edge, a recessed seam runs round it) so any two can
sit side by side; the seamless ones (tread plate, wall panel) have none: each is one long sheet, its tiles run on.

Scale: one tile is 2 m (texture X and Y), 64 px, so ~31 mm per pixel (a bigger set, its .size px: as many tiles' worth
of brushing). Brush direction: texture X.
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
On top lies a worn grime/oxide film, quantised to 4 dithered levels. It's a dielectric, so where it lies the
steel goes darker, non-metallic, rough and loses its brush anisotropy: it stops mirroring the sun. Two parts:
- dirt packed into seams, round holes and plate edges (grime_mask): part of the tile's shape, baked into its maps
- drip streaks (drip_grime): the walls' and columns' grime instead of the scuff patches, NOT baked; one
  textures/grime_drip.png the game reads in world space (see drip_grime).
- scuff patches (patch_grime): NOT baked. One shared, tileable textures/grime.png (GRIME_N px, mask in R); the
  game gives every tile its own random window into it, so no two tiles share a smudge pattern.
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
Parallax tiles (walllight) also write:
  textures/<name>_depth.png  depth below the plate, 0 (surface) .. 255 (PARALLAX_RANGE px down), for the shader
  textures/<name>_ccn.png    clearcoat normal map: the clear cover's embossed ridges
  textures/<name>_ccm.png    the clear cover: R = clearcoat (gloss, dulled by dirt), G = dirt, B = where the cover is
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
GRIME_N = 256                           # px: the shared patch texture (a 4×4-tile area; the game samples 64 px of it)
DRIP_W, DRIP_H = 1024, 256              # px: the walls' drip grime, 32 m along a wall × the 8 m wall (32 px/m, like the tiles)
DRIP_SEAMS = (64, 128, 192)             # px down from the top: the tile rows' seams, ledges where water collects
GRIME_DRIP = 0.95                       # how much the drip streaks contribute
FLASH_N, FLASH_VARIANTS = 64, 4         # px per muzzle-flash frame; shots cycle through this many shapes
FLASH_LEVELS = 8                        # the flash's heat is stepped to this many levels (pixel art), not coloured here


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


BOLTS = [(6, 6), (N - 6, 6), (6, N - 6), (N - 6, N - 6)]  # centres on pixel corners: all four rasterise alike


def plain_bolted(x, y):
    """Plain plate with a forged bolt head (smooth: no brush grain) on a washer in each corner."""
    r = min(math.hypot(x + 0.5 - cx, y + 0.5 - cy) for cx, cy in BOLTS)
    if r < 1.8: return STEEL_SRGB, 1.1 + 0.3 * math.sqrt(1 - (r / 1.8) ** 2), 1.0, 0.35, 1.0, 1.0  # domed head
    if r < 2.7: return STEEL_SRGB, 1.1, 0.9, 0.4, 1.0, 1.0                                        # washer
    return math.inf, 0


# Heat tint: the oxide colours welding leaves on stainless, from the bead out (a real film colour, not lighting)
HEAT_TINT = [(2.5, (96, 96, 128)), (3.4, (150, 112, 74)), (4.4, (196, 178, 124))]  # outer edge (px from the centre line): blue, bronze, straw


def plain_welded(x, y):
    """Plain plate with a weld bead across the middle (rows 30..33): a rounded bead with periodic ripples, rough
    and darker weld metal, in a band of heat tint on the brushed sheet either side."""
    dy = abs(y + 0.5 - N / 2)
    if dy < 1.6:
        ripple = 0.85 + 0.15 * math.cos(2 * math.pi * x / 3)                                 # weld puddle ripples
        return (128, 126, 122), 1 + 0.25 * math.sqrt(1 - (dy / 1.6) ** 2) * ripple, 1.0, 0.6, 1.0, 1.0
    for edge, colour in HEAT_TINT:
        if dy < edge: return colour, 1.0, 1.0, None, 1.0, 1.0                              # tinted, still brushed
    return math.inf, 0


# The weld seam's other pieces, so the game can join seams up across the floor (it lays them out as a maze): the
# bead runs from the plate's centre to the middle of each named edge (W/E: left/right, N/S: top/bottom of the image).
# plain_welded is the straight one (W–E).
WELD_EDGES = {'W': (0, N / 2), 'E': (N, N / 2), 'N': (N / 2, 0), 'S': (N / 2, N)}


def welded(name, edges):
    def shape(x, y):
        px, py, c = x + 0.5, y + 0.5, N / 2
        dy, along = math.inf, 0.0
        for e in edges:  # nearest point on the bead's centre line (segments from the centre out)
            ex, ey = WELD_EDGES[e]
            t = max(0.0, min(1.0, ((px - c) * (ex - c) + (py - c) * (ey - c)) / ((ex - c) ** 2 + (ey - c) ** 2)))
            d = math.hypot(px - c - t * (ex - c), py - c - t * (ey - c))
            if d < dy: dy, along = d, (x if ey == c else y)
        if dy < 1.6:
            ripple = 0.85 + 0.15 * math.cos(2 * math.pi * along / 3)
            return (128, 126, 122), 1 + 0.25 * math.sqrt(1 - (dy / 1.6) ** 2) * ripple, 1.0, 0.6, 1.0, 1.0
        for edge, colour in HEAT_TINT:
            if dy < edge: return colour, 1.0, 1.0, None, 1.0, 1.0
        return math.inf, 0
    shape.__name__ = name
    return shape


weld_end, weld_corner, weld_tee, weld_cross = (welded(n, e) for n, e in
                                               (('weld_end', 'W'), ('weld_corner', 'WN'), ('weld_tee', 'WEN'), ('weld_cross', 'WENS')))


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


TREAD_SRGB = (1, 121, 111)  # pine green
TREAD_STEP, TREAD_LEN, TREAD_R, TREAD_H = 64 / 6, 3.8, 1.6, 0.6  # px: lug spacing (an even count per tile); half-length; half-width; lift


def treadplate(x, y):
    """Diamond (tread) plate: raised lozenges, one per TREAD_STEP cell, alternate cells turned the other way (±45°),
    so they cross-hatch the plate for grip. Pine-green rubber, moulded: not metal, a glossy sheen, the worn lug tops
    a touch shinier than the sheet between them. No seam groove: it's cut from one big sheet, so tiles
    run into each other unbroken."""
    i, j = math.floor((x + 0.5) / TREAD_STEP), math.floor((y + 0.5) / TREAD_STEP)
    cx, cy = (i + 0.5) * TREAD_STEP, (j + 0.5) * TREAD_STEP
    s = 1 if (i + j) % 2 else -1  # which way this cell's lug leans
    ux, uy = math.sqrt(0.5), s * math.sqrt(0.5)
    px, py = x + 0.5 - cx, y + 0.5 - cy
    t = max(-TREAD_LEN, min(TREAD_LEN, px * ux + py * uy))  # nearest point on the lug's spine
    d = math.hypot(px - t * ux, py - t * uy)
    if d < TREAD_R:  # the lug: a rounded ridge, highest along its spine
        return TREAD_SRGB, 1 + TREAD_H * math.sqrt(1 - (d / TREAD_R) ** 2), 1.0, 0.28, 0.0, 1.0
    if d < TREAD_R + 0.8: return TREAD_SRGB, 1.0, 0.8, 0.42, 0.0, 1.0  # the sheet right at its foot: shaded a little
    return TREAD_SRGB, 1.0, 1.0, 0.36, 0.0, 1.0  # the sheet
treadplate.seamless = True


srgb = lambda l: round(255 * (12.92 * l if l <= 0.0031308 else 1.055 * l ** (1 / 2.4) - 0.055))
STEEL_SRGB = tuple(srgb(c) for c in STEEL)

CORR_P, CORR_A = 8, 0.55  # px: the wall's corrugation's pitch (25 cm: 16 waves a panel, so it tiles); its depth, crest to
# trough (feature units, × BUMP px: about 5 cm)
WALL_N, WALL_BAND, WALL_BRACE, WALL_RIM = 128, 14, 7, 0.4  # px: the panel (4 m); its frame's band in from each edge
# (its own: each panel a cell of its own, two frames side by side where they meet); the X's half-width (as wide as a
# frame); how far the frame's rim drops into the sheet (feature units: its outermost pixel, bevelled: a solid border)
WALL_BEZEL = 1.0  # feature units: how far the frame drops at the panel's edge, over its 2 outermost px (a bevelled
# groove between cells)
WALL_X_RIM, WALL_X_SHADOW = 0.8, 0.7  # the X, a piece of its own behind the frame, on the sheet (as one with the frame,
# it looked part of it; laid over it, bigger than it): how far its rim drops (feature units, its outermost pixel);
# the shadows, 1 px: the X's on the sheet, the frame's on the X where it goes under it
WALL_BOXES = [(c, d, 9) for c in (11, WALL_N - 11) for d in (11, WALL_N - 11)] + [(WALL_N / 2, WALL_N / 2, 11)]  # px:
# the square plates fastening it (centre x, y, half its side), in front of everything, bigger than the frame and the X
# they hold: on each corner (just clear of the bezel) and over the X's crossing
WALL_BOX_RIM = 0.8  # feature units: how far a plate's rim drops (its outermost pixel, bevelled); its shadow: WALL_X_SHADOW
WALL_RIVET_IN, WALL_RIVET_R, WALL_RIVET_H = 3, 1.8, 0.5  # px in from each corner of a plate, along both its sides: a
# rivet holding it (on pixel corners: all four rasterise alike); its round head's radius, px; how high it's domed
WALL_RIVETS = [(cx + sx * (h - WALL_RIVET_IN), cy + sy * (h - WALL_RIVET_IN)) for cx, cy, h in WALL_BOXES
               for sx in (-1, 1) for sy in (-1, 1)]
WALL_PILL_SRGB, WALL_PILL_ARC = (96, 98, 102), math.radians(60)  # a pill's trough at its deepest (shaded, dirty); how
# much of a cylinder's round it is (90°: a half cylinder, its edge a sharp lip)
WALL_PILL_L, WALL_PILL_R, WALL_PILL_D = 12, 4, 0.8  # px: the pill-shaped recesses on the X's arms and the frame's sides:
# half their length (between their round ends' middles), their radius; how deep (feature units) (narrower and
# shallower, they were lost at a distance)
WALL_FRAME_PILL_L = 10  # px: the frame's pills' half length (shorter: between the corner plates and the lamp's lens)


def wallpanel_parts(x, y):  # px: in from the panel's edge; how far onto the frame (> 0: on it), onto the X, onto a plate
    px, py, n = x + 0.5, y + 0.5, WALL_N
    e = min(px, n - px, py, n - py)
    box = max(h - max(abs(px - cx), abs(py - cy)) for cx, cy, h in WALL_BOXES)
    return e, WALL_BAND - e, WALL_BRACE - min(abs(px - py), abs(px + py - n)) / math.sqrt(2), box


def wallpanel_region(x, y):  # 'box' (a plate, in front of everything), 'frame', 'x' (behind it: its arms run on under
    # it) or 'sheet' (at the back)
    e, frame, x_, box = wallpanel_parts(x, y)
    return 'box' if box > 0 else 'frame' if frame > 0 else 'x' if x_ > 0 else 'sheet'


def wallpanel_pills():  # its pill-shaped recesses, the X's and the frame's: (centre x, y, along x, y, half-length, radius), px
    n, q, a = WALL_N, WALL_N / 4, math.sqrt(0.5)
    L, R = WALL_PILL_L, WALL_PILL_R
    x = [(cx, cy, a, a if (cx < 2 * q) == (cy < 2 * q) else -a, L, R)  # one half way along each arm of the X (a little
         for cx, cy in ((q + 2, q + 2), (3 * q - 2, q + 2), (q + 2, 3 * q - 2), (3 * q - 2, 3 * q - 2))]  # in: clear of
    # the corner plates)
    m, at, Lf = WALL_BAND / 2, (n / 2 - 26, n / 2 + 26), WALL_FRAME_PILL_L  # (the frame's middle line, in from the edge;
    # where along a side, clear of the corner plates; a little shorter, the lamp's lens between the two)
    frame = [(m_, c, 0, 1, Lf, R) for m_ in (m, n - m) for c in at] + [(c, m_, 1, 0, Lf, R) for m_ in (m, n - m) for c in at]
    return {'x': x, 'frame': frame}  # (two up each side of the frame, two along its top and its bottom)
WALL_PILLS = wallpanel_pills()


def wallpanel_pill(part, x, y):  # how deep in the nearest of that part's pill recesses, 0..1 (1: the bottom of its
    # trough): each rounded, a cylinder's arc across it (WALL_PILL_ARC), deepest down its middle, its ends rounded the same
    # way (flat bottomed, a bevel round it, it looked cratered)
    px, py, deep = x + 0.5, y + 0.5, 0.0
    s, c = math.sin(WALL_PILL_ARC), math.cos(WALL_PILL_ARC)
    for cx, cy, ux, uy, L, R in WALL_PILLS[part]:
        t = max(-L, min(L, (px - cx) * ux + (py - cy) * uy))
        r = math.hypot(px - cx - t * ux, py - cy - t * uy) / R  # (0 down its middle, 1 at its edge)
        if r < 1: deep = max(deep, (math.sqrt(1 - (r * s) ** 2) - c) / (1 - c))
    return deep


def wallpanel_rivet(x, y):  # how high on the nearest of the plates' rivets, 0..1 (1: its head's top; 0: off it)
    px, py = x + 0.5, y + 0.5
    r = min(math.hypot(px - cx, py - cy) for cx, cy in WALL_RIVETS) / WALL_RIVET_R
    return math.sqrt(1 - r * r) if r < 1 else 0.0


def wallpanel_height(region, x, y):  # that part's own surface at (x, y), carried on past its edge
    if region == 'sheet': return 1 + CORR_A * (0.5 + 0.5 * math.cos(2 * math.pi * (y + 0.5) / CORR_P))
    e, frame, x_, box = wallpanel_parts(x, y)
    top = 1 + CORR_A
    if region == 'box': return top - WALL_BOX_RIM * max(0.0, 1 - box) + WALL_RIVET_H * wallpanel_rivet(x, y)  # (flat,
    # its rim bevelled, its rivets domed)
    if region == 'x': return top - WALL_X_RIM * max(0.0, 1 - x_) - WALL_PILL_D * wallpanel_pill('x', x, y)  # (its rim)
    return (top - WALL_RIM * max(0.0, 1 - frame) - WALL_BEZEL * max(0.0, 1 - e / 2) - WALL_PILL_D * wallpanel_pill('frame', x, y))
    # (flat, bevelled down round its edge into the sheet (its rim) and at the panel's edge (the bezel))


def wallpanel(x, y):
    """The walls' panel: a corrugated sheet (rounded waves, a cosine, running along it, CORR_P px apart, brushed along
    them, a little shaded in the bottom of each trough so dirt packs there) in a frame, braced corner to corner by an X.
    Futuristic: frame and X lie flat, level with the sheet's crests (no beams standing out), each a piece of its own
    with a solid bevelled rim: the frame in front, the X behind it on the sheet (its arms run on under the frame, the
    frame's rim across them, its shadow on them; the X's shadow on the sheet); a pill-shaped recess half way along each
    arm of the X, two along each side of the frame; square plates fastening it on, on its corners and over the X's
    crossing, in front of everything, a domed rivet in each of their corners. The waves run on unchanged right up to them: each part's
    normals come from its own surface (wallpanel.region/height: from the heights across the edge, the waves flattened
    into the band). A cell of its own: its frame all round it, a bevelled bezel at its edge, a groove where it meets the
    next (sharing a frame, it ran into it)."""
    region = wallpanel_region(x, y)
    h = wallpanel_height(region, x, y)
    e, frame, x_, box = wallpanel_parts(x, y)
    shade = WALL_X_SHADOW if (region == 'sheet' and x_ > -1) or (region == 'x' and frame > -1) or (region != 'box' and box > -1) else 1.0
    # (the shadows: the X's on the sheet round it, the frame's on the X where it goes under it, a plate's round it)
    dim = lambda c: tuple(round(v * shade) for v in c)
    if region == 'box':  # (a rivet's head forged: smooth, no brush grain)
        return dim(STEEL_SRGB), h, 1.0, (0.3 if wallpanel_rivet(x, y) > 0 else None), 1.0, 1.0
    if region != 'sheet':  # (a pill darker the deeper: shaded, dirty; its occlusion alone only dims the room's light, and
        # the lamps' light is direct: it didn't show)
        deep = wallpanel_pill(region, x, y)
        return dim(tuple(a + (p - a) * deep for a, p in zip(STEEL_SRGB, WALL_PILL_SRGB))), h, 1 - 0.4 * deep, None, 1.0, 1.0
    c = math.cos(2 * math.pi * (y + 0.5) / CORR_P)
    return dim(STEEL_SRGB), h, 0.85 if c < -0.9 else 1.0, None, 1.0, 1.0
wallpanel.seamless, wallpanel.size, wallpanel.half = True, WALL_N, True  # (half: written at 64 px, 16 px/m: its pixels
# twice the tiles', chunkier; its px figures above are in the 128 px it's drawn at)
wallpanel.region, wallpanel.height = wallpanel_region, wallpanel_height

HAZARD_SRGB = (226, 176, 18)  # the hazard stripes' yellow (the game's hazard band, round the platform's top: src/platform.js)
PAINT_WHITE_SRGB = (236, 236, 230)  # a white paint, a little warm
WALL_STRIPE, WALL_STRIPE_W = 32, 8  # px (at 128 px a panel, 32 px/m): its yellow stripes' period, and their width (the
# hazard band's: 0.25 m; spaced 1 m, a few on the white); the panel's width a whole number of them, so they run on
# from one panel into the next


def wallpanel_painted(name, paint):
    """The walls' panel for their bottom row: the lower half of its corrugated sheet painted paint(x, y) (sRGB; paint:
    not metal, not brushed, a little glossy), its waves and their dirty troughs and the shadows on it as wallpanel's;
    the frame, the X and the plates bare steel, as above."""
    def shape(x, y):
        t = wallpanel(x, y)
        if y < WALL_N / 2 or wallpanel_region(x, y) != 'sheet': return t
        shade = t[0][0] / STEEL_SRGB[0]  # (the X's and the plates' shadows on it: see wallpanel)
        return tuple(round(c * shade) for c in paint(x, y)), t[1], t[2], 0.6, 0.0, 1.0
    shape.__name__, shape.seamless, shape.size, shape.half = name, True, WALL_N, True
    shape.region, shape.height = wallpanel_region, wallpanel_height
    return shape


wallpanel_yellow = wallpanel_painted('wallpanel_yellow', lambda x, y: HAZARD_SRGB)
wallpanel_striped = wallpanel_painted('wallpanel_striped', lambda x, y: HAZARD_SRGB if (x + y) % WALL_STRIPE < WALL_STRIPE_W else PAINT_WHITE_SRGB)


PARALLAX_RANGE = 6.0  # px: the depth map's full scale (match WALL_LIGHT_DEPTH in the game: PARALLAX_RANGE / N)
WL_X0, WL_X1, WL_Y0, WL_Y1 = 4, 60, 26, 38  # housing, frame included; the cavity is 2 px inside it
WL_CAVITY, WL_TUBE_R = 6.0, 2.5              # px: cavity floor below the plate (~18 cm); tube radius
HOUSING = (40, 40, 44)                        # dark painted housing interior


def walllight(x, y):
    """Recessed light fixture. Heights here are true pixel depths (feature height = 1 − depth / BUMP, so the
    normal map and the parallax depth map agree). The clear cover is flush with the plate and isn't in the
    height at all: it's the material's clearcoat (see clearcoat_wl)."""
    if not (WL_X0 <= x < WL_X1 and WL_Y0 <= y < WL_Y1): return math.inf, 0
    h = lambda depth: 1 - depth / BUMP
    f = min(x - WL_X0, WL_X1 - 1 - x, y - WL_Y0, WL_Y1 - 1 - y) + 0.5  # px in from the housing's outer edge
    if f < 2: return HOUSING, h(WL_CAVITY * f / 2), 0.6, 0.7, 0.0, 1.0  # chamfered frame down into the cavity
    t = (y + 0.5 - (WL_Y0 + WL_Y1) / 2) / WL_TUBE_R                     # across the tube, -1..1
    if abs(t) < 1 and WL_X0 + 4 <= x < WL_X1 - 4:                        # tube: frosted glass, glowing
        glow = 0.35 + 0.65 * math.sqrt(1 - t * t)  # brightest along the crest, so it reads as a half-cylinder
        # mid grey, not white: it glows by its emissive; a white surface would re-light itself from the strip
        # light hung in front of it and blow out
        return (110, 115, 120), h(WL_CAVITY - WL_TUBE_R * math.sqrt(1 - t * t)), 1.0, 0.3, 0.0, 1.0, \
            tuple(round(c * glow) for c in LIGHT)
    if abs(t) < 0.8 and x in (WL_X0 + 2, WL_X0 + 3, WL_X1 - 4, WL_X1 - 3):  # end caps: steel pins
        return STEEL_SRGB, h(WL_CAVITY - 2.5), 0.8, 0.4, 1.0, 1.0
    return HOUSING, h(WL_CAVITY), 0.4, 0.7, 0.0, 1.0                     # cavity floor


walllight.parallax = True


# Glass floor panels: a steel frame round a window of glass, looking down into the void under the floor: no pit, no
# walls. It runs on under the neighbouring panels every way, the floor down there one of the arena's own plates
# (slits, or cover: the real tile, at its own size, repeating), painted service pipes (yellow) running
# through it side by side, on and on. Lamps under the neighbouring panels light it (a line under each edge of the
# tile, out of sight), so it's brightest towards the window's edges, dimmer in the middle, and dark further off.
# No real light reaches inside the parallax: the things down there are dark (unlit) but for their emissive, which
# is baked here as if fully lit (the lamps' colour through the faintly green glass, shadows and all); the game
# scales it by the lamps' falloff at where the ray actually lands (the textures repeat, so baked light would too). Drawn with parallax mapping, the glass a
# clearcoat: the depth map holds two spans per texel (see layers in glass) over a floor at GLASS_DEPTH, and the
# textures repeat, so a ray can go under the frame and past the tile's edge and find more of the same.
GLASS_FRAME, GLASS_DEPTH = 5, 12.0          # px: the frame's width; the floor of the void below the plate (~37 cm)
GLASS_PLATE = 1.0                           # px: the frame plate's thickness (the void runs on under it)
GLASS_RIPPLE = 0.12                         # the glass's ripples: their slope (it's thick, rolled glass)
GLASS_SCRATCHES = 16                        # scratch marks on each panel's glass
GLASS_TINT = (215, 240, 228)                # the glass: a faint green, as thick glass is
INCANDESCENT = (255, 185, 115)              # a warm bulb (LEDs: LIGHT)
PIPE_RED, PIPE_YELLOW, PIPE_GREEN = (190, 38, 28), (228, 178, 30), (40, 150, 62)  # painted service pipes
PIPE_R, PIPE_LIFT = 2.5, 1.5                # px: a pipe's radius (~16 cm across); its gap over the floor (on brackets)
# Pipes through the void, side by side: (runs along 'x' or 'y', at px across, colour), the whole tile through (so
# on and on). Round all the way round: a ray can pass under one. The same run under every glass panel (the game
# lays them unturned), so the pipes line up from one window to the next.
PIPES = (('x', 20, PIPE_YELLOW), ('x', 30, PIPE_YELLOW), ('x', 40, PIPE_YELLOW))  # all yellow


def glass_window(x, y):  # px inside the window's edge (< 0: the frame)
    return min(x, N - 1 - x, y, N - 1 - y) - GLASS_FRAME + 0.5


def glass(name, source, light, pipes):
    """source: the floor down there (a tile's shape function); pipes: what runs through (PIPES)."""
    tint = tuple(l * g / 255 for l, g in zip(light, GLASS_TINT))  # the light, as seen through the glass

    def plate(x, y):  # the source tile's finished texel, its seam groove too
        t = source(x, y)
        return seam(x, y, t if len(t) > 2 else texel(*t))

    def pipe_at(x, y):  # → (paint, top px, bottom px) or None
        for axis, at, paint in pipes:
            d = (y if axis == 'x' else x) + 0.5 - at                                   # px from its centre line
            if abs(d) < PIPE_R:
                c, centre = math.sqrt(1 - (d / PIPE_R) ** 2), GLASS_DEPTH - PIPE_R - PIPE_LIFT
                return paint, centre - PIPE_R * c, centre + PIPE_R * c

    def pipe_glow(x, y, paint):  # fully lit, unshaded: the game shades it by where the ray hit its round
        return tuple(round(p / 255 * k) for p, k in zip(paint, tint))

    def floor_glow(x, y):  # the plate down there, shadowed under and beside the pipes
        t, ao = plate(x, y), plate(x, y)[2]
        for axis, at, _ in pipes:
            d = abs((y if axis == 'x' else x) + 0.5 - at)
            if d < PIPE_R + 1.5: ao *= 0.35 if d < PIPE_R else 0.55
        return tuple(round(c / 255 * k * ao) for c, k in zip(t[0], tint)), t[0], ao  # fully lit (the game: the lamps)

    def shape(x, y):  # the main maps: what a ray straight down meets first
        if glass_window(x, y) < 0: return math.inf, 0                               # the frame: plain plate
        h, p = (lambda depth: 1 - depth / BUMP), pipe_at(x, y)
        if p: return tuple(round(c * 0.12) for c in p[0]), h(p[1]), 1.0, 0.35, 0.0, 1.0, pipe_glow(x, y, p[0])
        glow, col, ao = floor_glow(x, y)
        return tuple(round(c * 0.12) for c in col), h(GLASS_DEPTH), ao, 0.6, 0.0, 1.0, glow

    # The depth map, two spans of solid per texel (px down; inf: none) over the floor at GLASS_DEPTH: under the
    # window, a pipe (if one's there); under the frame, the frame's plate, then a pipe. under: the glow of that
    # second span (a pipe under the frame); floor: the floor's glow, everywhere.
    def layers(x, y):
        p = pipe_at(x, y)
        span = (p[1], p[2]) if p else (math.inf, math.inf)
        return (0.0, GLASS_PLATE) + span if glass_window(x, y) < 0 else span + (math.inf, math.inf)

    def under(x, y):
        p = pipe_at(x, y)
        return pipe_glow(x, y, p[0]) if p and glass_window(x, y) < 0 else (0, 0, 0)
    shape.layers, shape.under, shape.floor = layers, under, lambda x, y: floor_glow(x, y)[0]
    shape.parallax_range = GLASS_DEPTH + 2
    shape.__name__, shape.parallax = name, True
    def clearcoat(x, y):  # thick glass (it takes bullets and boots), rolled: ripples along the pipes, so it warps both
        # the reflections and (the game refracts through it) the view down, in bands parallel to them
        if glass_window(x, y) < 0: return 0, (128, 128, 255)
        ny = GLASS_RIPPLE * (math.sin(2 * math.pi * y / 9) + 0.45 * math.sin(2 * math.pi * y / 4.3 + 1))
        l = math.sqrt(ny * ny + 1)
        return 255, (128, b(ny / l * 0.5 + 0.5), b(1 / l * 0.5 + 0.5))
    shape.clearcoat = clearcoat

    noise = []

    def smudge(x, y):  # grime trodden on: soft patches (value_noise is defined further down: built on first use)
        if not noise: noise.append(value_noise(random.Random(f'{name} smudges'), 16, N))
        return noise[0](x, y)

    def dirt(x, y):  # a little along the glass's rim (lightly: no dark border to give the void an edge), specks, smudges
        f = glass_window(x, y)
        if f < 0: return 0
        speck = random.Random(f'{name} {x} {y}').random()
        g = max(1 - f / 2.2, 0) * (0.15 + 0.2 * speck) + (0.4 if speck > 0.96 else 0)
        g += 0.45 * min(max((smudge(x, y) - 0.55) / 0.25, 0), 1)
        return min(int(min(g, 1) * 3 + ((0, 2), (3, 1))[y % 2][x % 2] / 4), 3) / 3
    shape.cover_dirt = dirt

    # Scratches: boots and dragged kit, fine 1 px lines, fading out at their ends (the game shows them pale, catching
    # the room's light, and takes the gloss off the glass along them)
    rng, marks = random.Random(f'{name} scratches'), {}
    for _ in range(GLASS_SCRATCHES):
        x0, y0, a = rng.uniform(GLASS_FRAME, N - GLASS_FRAME), rng.uniform(GLASS_FRAME, N - GLASS_FRAME), rng.uniform(0, math.pi)
        length, k = rng.uniform(5, 18), rng.uniform(0.4, 1.0)
        for i in range(int(length * 2) + 1):
            t = i / (length * 2)
            x, y = int(x0 + math.cos(a) * length * t), int(y0 + math.sin(a) * length * t)
            if glass_window(x, y) >= 0: marks[x, y] = max(marks.get((x, y), 0), k * (0.5 + 0.5 * math.sin(math.pi * t)))
    shape.scratch = lambda x, y: marks.get((x, y), 0)
    return shape


glass_slits, glass_panels = glass('glass_slits', slits, LIGHT, PIPES), glass('glass_panels', cover, INCANDESCENT, PIPES)


def slitlight(x, y):
    """Plain plate with a thin light slit near its top edge (on a column's top panel: just under the ceiling): a 2 px
    LED line in a 4 px recessed slot with a dark 1 px frame (rows 6..9, x 4..59), ends dimmed."""
    X0, X1, Y0, Y1 = 4, 60, 6, 10
    if not (X0 <= x < X1 and Y0 <= y < Y1): return math.inf, 0
    if x in (X0, X1 - 1) or y in (Y0, Y1 - 1): return HOUSING, 0.55, 0.5, 0.7, 0.0, 1.0  # recessed dark frame
    glow = 0.6 if x in (X0 + 1, X1 - 2) else 1.0
    return (210, 225, 235), 0.6, 1.0, 0.25, 0.0, 1.0, tuple(round(c * glow) for c in LIGHT)  # frosted LED line


def clearcoat_wl(x, y):
    """→ (mask, normal rgb): the clear cover over the cavity, embossed with ridges along the slot (every 2 rows,
    alternating tilt across Y)."""
    if not (WL_X0 + 2 <= x < WL_X1 - 2 and WL_Y0 + 2 <= y < WL_Y1 - 2): return 0, (128, 128, 255)
    ny = 0.35 if (y - WL_Y0) % 2 == 0 else -0.35
    l = math.sqrt(ny * ny + 1)
    return 255, (128, b(ny / l * 0.5 + 0.5), b(1 / l * 0.5 + 0.5))


def side_slits(x, y, edges):
    """A thin vertical light slit inside the given side edges (x 4..7 and/or 56..59, y 6..57; vertically centred,
    so a half turn moves a left slit to the right edge): slitlight's slot, stood upright."""
    if not 6 <= y < 58: return math.inf, 0
    for X0 in edges:
        if X0 <= x < X0 + 4:
            if x in (X0, X0 + 3) or y in (6, 57): return HOUSING, 0.55, 0.5, 0.7, 0.0, 1.0  # recessed dark frame
            glow = 0.6 if y in (7, 56) else 1.0
            return (210, 225, 235), 0.6, 1.0, 0.25, 0.0, 1.0, tuple(round(c * glow) for c in LIGHT)
    return math.inf, 0


def sidelight(x, y):  # a slit inside each side edge: neighbouring tiles' slits pair up at the seam
    return side_slits(x, y, (4, N - 8))


def sidelight_left(x, y):  # one slit, inside the left edge (half-turned in the game, it's a right one)
    return side_slits(x, y, (4,))


def cover_dirt(x, y):
    """0..1 grime on the clear cover: packed along its rim (where it meets the frame), thinning over ~2 px, with a
    few specks inward; 4 dithered steps like the plate's grime."""
    x0, x1, y0, y1 = WL_X0 + 2, WL_X1 - 2, WL_Y0 + 2, WL_Y1 - 2
    if not (x0 <= x < x1 and y0 <= y < y1): return 0
    d = min(x - x0, x1 - 1 - x, y - y0, y1 - 1 - y)        # px in from the cover's edge
    speck = random.Random(f'cover {x} {y}').random()        # per texel, reproducible
    g = max(1 - d / 2.2, 0) * (0.35 + 0.4 * speck) + (0.4 if speck > 0.94 else 0)  # a little: light, not caked
    return min(int(min(g, 1) * 3 + ((0, 2), (3, 1))[y % 2][x % 2] / 4), 3) / 3


PATCH = (18, 46, 16, 38)  # vent_patch's repair plate: x0, x1, y0, y1 (px)


def vent_patch(x, y):
    """Vent with a repair plate welded on top: brushed plate (holes under it hidden), a weld bead round its edge
    and heat tint just outside, where holes still poke through."""
    x0, x1, y0, y1 = PATCH
    if x0 <= x < x1 and y0 <= y < y1:
        if min(x - x0, x1 - 1 - x, y - y0, y1 - 1 - y) == 0: return (128, 126, 122), 1.3, 0.85, 0.6, 1.0, 1.0  # weld
        return STEEL_SRGB, 1.2, 1.0, None, 1.0, 1.0                                                          # plate
    out = max(x0 - 1 - x, x - x1, y0 - 1 - y, y - y1)  # px outside the plate, 0 = touching
    d, R = vent(x, y)
    if out < len(HEAT_TINT) and d >= R + BEVEL_W: return HEAT_TINT[out][1], 1.0, 1.0, None, 1.0, 1.0
    return d, R


STRAPS = ((20, 23), (41, 44))  # slits_strapped: straps' x spans (px), across the slot rows


def slits_strapped(x, y):
    """Slits with two rolled-steel straps on top, running across all the slots (smooth: not brushed)."""
    for a, b_ in STRAPS:
        if a <= x < b_ and 9 <= y < N - 9:
            t = (x + 0.5 - (a + b_) / 2) / ((b_ - a) / 2)
            return STEEL_SRGB, 1.0 + 0.3 * math.sqrt(max(1 - t * t, 0)), 1.0, 0.5, 1.0, 1.0
    return slits(x, y)


def cover_hatch(x, y):
    """Cover plate with a recessed lifting slot (14 × 4 px stadium) in the middle, chamfered 1 px in."""
    t = cover(x, y)
    if len(t) == 2: return t
    d = math.hypot(max(abs(x + 0.5 - N / 2) - 5, 0), y + 0.5 - N / 2) - 2  # <0 inside the slot
    if d < 0: return STEEL_SRGB, t[1] - 0.45, 0.35, 0.6, 1.0, 1.0
    if d < 1: return STEEL_SRGB, t[1] - 0.45 * (1 - d), 0.7, 0.6, 1.0, 1.0
    return t


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


def value_noise(rng, cell, size):
    """Periodic value noise: a random value per cell corner (cell must divide size), smoothstep-blended."""
    g = size // cell
    v = [[rng.random() for _ in range(g)] for _ in range(g)]

    def f(x, y):
        fx, fy = (x + 0.5) / cell - 0.5, (y + 0.5) / cell - 0.5
        x0, y0 = math.floor(fx), math.floor(fy)
        sx, sy = (lambda t: t * t * (3 - 2 * t))(fx - x0), (lambda t: t * t * (3 - 2 * t))(fy - y0)
        row = lambda yy: v[yy % g][x0 % g] + (v[yy % g][(x0 + 1) % g] - v[yy % g][x0 % g]) * sx
        return row(y0) + (row(y0 + 1) - row(y0)) * sy
    return f


BAYER = ((0, 2), (3, 1))
dither4 = lambda g, x, y: min(int(min(g, 1) * 3 + BAYER[y % 2][x % 2] / 4), 3) / 3  # 4 levels, 2×2 ordered dither


def grime_mask(name, T):
    """0..1 baked grime per texel: dirt packed within a pixel of anything occluded (the AO channel marks the
    cavities). Only on steel (and the tread plate's rubber): holes and the lens stay clean."""
    M = [[0.0] * N for _ in range(N)]
    for y in range(N):
        for x in range(N):
            t = T[y][x]
            if (t[4] < 1 and name != 'treadplate') or t[5] < 1: continue
            edge = max(1 - T[(y + j) % N][(x + i) % N][2] for i in (-1, 0, 1) for j in (-1, 0, 1))
            M[y][x] = dither4(GRIME_EDGE * edge, x, y)
    return M


def patch_grime():
    """The scuff patches, shared by every tile: three octaves of periodic value noise (cells 16, 8, 4 px),
    thresholded and dithered, over GRIME_N px so each tile's 64 px window is different."""
    rng = random.Random('patch grime')
    o1, o2, o3 = (value_noise(rng, c, GRIME_N) for c in (16, 8, 4))
    def g(x, y):
        n = 0.55 * o1(x, y) + 0.3 * o2(x, y) + 0.15 * o3(x, y)
        return dither4(GRIME_PATCH * min(max((n - 0.5) / 0.25, 0), 1), x, y)
    return [[g(x, y) for x in range(GRIME_N)] for y in range(GRIME_N)]


def muzzle_flash(rng, stage):
    """One muzzle-flash frame, FLASH_N px, seen end-on from behind the gun: a white-hot core and flame prongs bursting
    out of the flash hider (an M4's birdcage vents up and to the sides, so the prongs favour the top half), their
    edges ragged with noise. stage 0 is the bang (big, hot); stage 1 the next instant (the core gone dim, prongs
    shorter, broken and cooler, a few sparks). It's only heat, 0…1 stepped to FLASH_LEVELS (grey; black: nothing):
    the game turns heat into light, brighter than white at the core, and adds it to whatever's behind, as a flame
    does, so it's see-through wherever it's dim. Returns grey rows."""
    c = FLASH_N / 2
    k = rng.randint(4, 6)
    prongs = []
    for i in range(k):
        a = -math.pi / 2 + (i - (k - 1) / 2) * (2.4 / k) + rng.uniform(-0.25, 0.25)  # around the top, y down
        if rng.random() < 0.3: a += math.pi  # now and then one out of the bottom
        prongs.append((a, rng.uniform(0.55, 0.95) * c, rng.uniform(0.12, 0.22)))
    noise = value_noise(rng, 8, FLASH_N)
    core_r = (0.32 if stage == 0 else 0.18) * c
    scale, cool = (1.0, 0.0) if stage == 0 else (0.75, 0.3)
    rows = []
    for y in range(FLASH_N):
        row = []
        for x in range(FLASH_N):
            dx, dy = x + 0.5 - c, y + 0.5 - c
            r, ang = math.hypot(dx, dy), math.atan2(dy, dx)
            jag = 0.75 + 0.5 * noise(x, y)
            h = max(0.0, 1 - r / (core_r * jag)) * 1.4  # the core
            for a, L, w in prongs:
                da = abs((ang - a + math.pi) % (2 * math.pi) - math.pi)
                t = r / (L * scale * jag)
                if t < 1 and da < w * (1 - 0.7 * t) * 2.2:
                    h = max(h, (1 - t) ** 0.8 * (1 - da / (w * (1 - 0.7 * t) * 2.2)) * 1.1)
            h -= cool * (0.6 + 0.8 * noise(x * 2 + 7, y * 2 + 3) - 0.4) if stage else 0
            if stage and h < 0.12 and rng.random() < 0.012 and r < c * 0.9: h = 0.5  # sparks
            v = round(min(max(h, 0), 1) * FLASH_LEVELS) / FLASH_LEVELS
            row.append((round(v * 255),) * 3)
        rows.append(row)
    return rows


def drip_grime():
    """The walls' grime: years of moisture sliding down. Streaks start at leak points (mostly the ceiling joint and
    the row seams, where water collects), run down meandering a pixel now and then, strongest at the source and fading
    as they go, some ending in a bead; older ones wider and fainter. A stain line sits under each seam where water
    stood, and dirt is splashed up near the floor. Slow noise along the wall clusters it all, so some stretches are
    badly stained and others nearly clean. Row 0 is the top of the wall; tiles round the 32 m width. Dithered to the
    same 4 levels as the other grime. The game reads it in world space, so streaks run down across tile rows."""
    rng = random.Random('drip grime')
    G = [[0.0] * DRIP_W for _ in range(DRIP_H)]
    def add(x, y, v):  # stains build up: 1 − Π(1 − v)
        if 0 <= y < DRIP_H:
            row = G[y]; x %= DRIP_W
            row[x] = 1 - (1 - row[x]) * (1 - min(v, 1))
    def noise1(cell):  # periodic 1D value noise along the wall (cell divides DRIP_W)
        g = DRIP_W // cell; v = [rng.random() for _ in range(g)]
        def f(x):
            t = x / cell; i = math.floor(t); u = t - i; u = u * u * (3 - 2 * u)
            return v[i % g] * (1 - u) + v[(i + 1) % g] * u
        return f
    n1, n2, n3, n4 = noise1(128), noise1(32), noise1(8), noise1(4)
    leak = lambda x: max(0.0, 0.6 * n1(x) + 0.4 * n2(x) - 0.15) / 0.85  # 0 dry … 1 badly stained
    # the old wash: under every leaky stretch a faint curtain of fine vertical striations runs down from the
    # ceiling joint and each seam, fading as it goes (the sum of decades of streaks too faint to tell apart)
    for y in range(DRIP_H):
        below = y - max([0, *[sy for sy in DRIP_SEAMS if sy <= y]])
        fade = math.exp(-below / 30)
        for x in range(DRIP_W):
            add(x, y, 0.5 * leak(x) ** 2 * fade * (0.3 + 0.7 * n4(x)))
    for _ in range(1600):
        x = rng.randrange(DRIP_W)
        if rng.random() > leak(x) ** 1.5: continue
        y0 = rng.choice((0, 0, *DRIP_SEAMS, rng.randrange(DRIP_H)))
        for _ in range(rng.randint(1, 5)):  # a leak sheds a few streaks close together
            age = rng.random()  # 0 new … 1 old
            w = 1 if age < 0.5 else 2 if age < 0.85 else 3
            s = (0.9 - 0.55 * age) * (0.6 + 0.4 * rng.random())
            L = min(DRIP_H - y0, int(rng.expovariate(1 / (40 + 120 * leak(x)))) + 6)
            cx = x + round(rng.gauss(0, 3))
            for i in range(L):
                if rng.random() < 0.06: cx += rng.choice((-1, 1))  # meanders
                f = s * (1 - i / L) ** 0.7 * (1.3 if i < 2 else 1)  # strongest at the source, fading
                for dx in range(w): add(cx + dx, y0 + i, f * (0.75 if w > 2 and dx in (0, w - 1) else 1))
            if rng.random() < 0.4:  # a bead where it stopped
                for dx in range(-1, w + 1):
                    for dy in (-1, 0): add(cx + dx, y0 + L + dy, 0.9 * s)
    for sy in DRIP_SEAMS:  # stain lines where water stood on each seam
        for x in range(DRIP_W):
            add(x, sy, 0.45 * leak(x)); add(x, sy + 1, 0.25 * leak(x))
    for y in range(DRIP_H - 24, DRIP_H):  # splashed up from the floor, patchy
        t = (y - (DRIP_H - 24)) / 24
        for x in range(DRIP_W):
            add(x, y, 0.55 * t * t * (0.5 + 0.5 * n3(x + 3 * y)) * (0.4 + 0.6 * leak(x)))
    return [[dither4(GRIME_DRIP * v, x, y) for x, v in enumerate(row)] for y, row in enumerate(G)]


def brushed(seed):
    """Simulated #4 brushing → S×S height field (sample units), tileable."""
    rng = random.Random(seed)
    S = N * SS
    H = [0.0] * (S * S)
    p1, p2 = rng.random() * 6.28, rng.random() * 6.28
    tile = 64 * SS  # (a tile's samples: the banding a tile's, however big the set)
    band = [1 + 0.35 * math.sin(4 * math.pi * y / tile + p1) + 0.2 * math.sin(14 * math.pi * y / tile + p2) for y in range(S)]
    for deg in PASSES:
        tan_a = math.tan(math.radians(deg))
        for _ in range(SCRATCHES * (N // 64) ** 2):  # (as dense on a bigger set)
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
    for _ in range(PITS * (N // 64) ** 2):
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
    w, h = len(rows[0]), len(rows)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, bits, color, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    print('wrote', path)


b = lambda v: max(0, min(255, round(v * 255)))
out = Path(__file__).resolve().parent.parent / 'textures'
out.mkdir(exist_ok=True)
P = patch_grime()
png(out / 'grime.png', [[(b(v),) * 3 for v in row] for row in P])
print(f'  grime: patches cover {sum(map(sum, P)) / GRIME_N / GRIME_N:.0%} on average (applied per tile in the game)')
rng = random.Random('muzzle flash')
frames = [[muzzle_flash(random.Random(f'flash {v}'), st) for v in range(FLASH_VARIANTS)] for st in (0, 1)]
png(out / 'muzzle_flash.png', [sum((f[y] for f in row), []) for row in frames for y in range(FLASH_N)])  # variants across, stages down
D = drip_grime()
png(out / 'grime_drip.png', [[(b(v),) * 3 for v in row] for row in D])
print(f'  drip grime: streaks cover {sum(map(sum, D)) / DRIP_W / DRIP_H:.0%} of the walls on average')
for shape in (vent, vent_patch, slits, slits_strapped, plain, plain_bolted, plain_welded, light, slitlight, sidelight, sidelight_left, cover, cover_hatch, walllight, treadplate, weld_end, weld_corner, weld_tee, weld_cross, glass_slits, glass_panels, wallpanel, wallpanel_yellow, wallpanel_striped):
    name, N = shape.__name__, getattr(shape, 'size', 64)  # (N: read by everything below, brushed() and grime_mask() too)
    _, var_x, var_y = downsample(*brushed(name))  # scratch heights stay out of the normal map (see top)
    alpha = lambda var: [[math.sqrt(BASE_ALPHA ** 2 + 2 * v) for v in row] for row in var]  # LEAN/Toksvig
    alpha_x, alpha_y = alpha(var_x), alpha(var_y)
    # A shape gives (distance to a hole, its radius), or a finished texel for features that aren't holes
    edge = (lambda x, y, t: t) if getattr(shape, 'seamless', False) else seam  # one sheet: no tile seams
    T = [[edge(x, y, s if len(s) > 2 else texel(*s)) for x in range(N) for s in [shape(x, y)]] for y in range(N)]
    brush = [[T[y][x][3] is None for x in range(N)] for y in range(N)]
    H = [[BUMP * T[y][x][1] for x in range(N)] for y in range(N)]  # height in pixel units: the pressed features
    h = lambda x, y: H[y % N][x % N]  # wraps, so the normal map tiles seamlessly
    G = grime_mask(name, T)  # a film: changes colour/roughness/metal, not the shape (normals)

    def colour(x, y):
        g = G[y][x]
        return tuple(srgb(lin(c) * (1 - g) + gc * g) for c, gc in zip(T[y][x][0], GRIME))

    region = getattr(shape, 'region', None)  # (a shape of separate surfaces: each pixel's normal from its own's heights)
    def normal(x, y):
        # Image rows run down but texture v runs up (flipY), hence the sign on ny
        hh = (lambda x_, y_: BUMP * shape.height(r, x_ % N, y_ % N)) if region and (r := region(x, y)) else h
        nx, ny = -(hh(x + 1, y) - hh(x - 1, y)) / 2, (hh(x, y + 1) - hh(x, y - 1)) / 2
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
    if getattr(shape, 'half', False):  # drawn at N px, written at half that: each 2 × 2 averaged (colour as light,
        # normals renormalised): chunkier pixels than it was drawn with
        half = lambda f: [[f([(x * 2 + i, y * 2 + j) for j in (0, 1) for i in (0, 1)]) for x in range(N // 2)] for y in range(N // 2)]
        mean = lambda g, n_: lambda ps: tuple(sum(g(*p)[k] for p in ps) / 4 for k in range(n_))
        def nhalf(ps):
            v = mean(lambda x, y: [c / 255 * 2 - 1 for c in normal(x, y)], 3)(ps); l = math.sqrt(sum(c * c for c in v))
            return tuple(b(c / l * 0.5 + 0.5) for c in v)
        png(out / f'{name}.png', half(lambda ps: tuple(srgb(v) for v in mean(lambda x, y: [lin(c) for c in colour(x, y)], 3)(ps))))
        png(out / f'{name}_h.png', half(lambda ps: round(sum((H[y][x] - lo) / (hi - lo) for x, y in ps) / 4 * 65535)), bits=16)
        png(out / f'{name}_n.png', half(nhalf))
        png(out / f'{name}_orm.png', half(lambda ps: tuple(round(v) for v in mean(orm, 4)(ps))))
        png(out / f'{name}_a.png', half(lambda ps: tuple(round(v) for v in mean(aniso, 3)(ps))))
    else:
        png(out / f'{name}.png', [[colour(x, y) for x in range(N)] for y in range(N)])
        png(out / f'{name}_h.png', [[round((v - lo) / (hi - lo) * 65535) for v in row] for row in H], bits=16)
        png(out / f'{name}_n.png', [[normal(x, y) for x in range(N)] for y in range(N)])
        png(out / f'{name}_orm.png', [[orm(x, y) for x in range(N)] for y in range(N)])
        png(out / f'{name}_a.png', [[aniso(x, y) for x in range(N)] for y in range(N)])
    if shape is slits:  # the stair treads' grating: the slots cut right through (white = metal, black = open)
        png(out / 'slits_cut.png', [[(255 if T[y][x][1] >= 0.5 else 0,) * 3 for x in range(N)] for y in range(N)])
    if any(len(t) > 6 for row in T for t in row):
        png(out / f'{name}_e.png', [[t[6] if len(t) > 6 else (0, 0, 0) for t in row] for row in T])
    if getattr(shape, 'parallax', False):
        rng_ = getattr(shape, 'parallax_range', PARALLAX_RANGE)
        cc, dirt = getattr(shape, 'clearcoat', clearcoat_wl), getattr(shape, 'cover_dirt', cover_dirt)
        depth = lambda v: (b(min(max((BUMP - v) / rng_, 0), 1)),) * 3  # plate (BUMP px) = 0
        if hasattr(shape, 'layers'):  # two spans of solid: RG the first's top and bottom, BA the second's; then a floor
            png(out / f'{name}_depth.png', [[tuple(b(min(v / rng_, 1)) for v in shape.layers(x, y)) for x in range(N)] for y in range(N)])
            png(out / f'{name}_under.png', [[shape.under(x, y) for x in range(N)] for y in range(N)])
            png(out / f'{name}_floor.png', [[shape.floor(x, y) for x in range(N)] for y in range(N)])
        else:
            png(out / f'{name}_depth.png', [[depth(v) for v in row] for row in H])
        png(out / f'{name}_ccn.png', [[cc(x, y)[1] for x in range(N)] for y in range(N)])
        sc = getattr(shape, 'scratch', lambda x, y: 0)  # A: 255 − scratch (an RGB map reads as A = 1: no scratches)
        png(out / f'{name}_ccm.png', [[(round(cc(x, y)[0] * (1 - 0.8 * dirt(x, y)) * (1 - 0.5 * sc(x, y))), b(dirt(x, y)),
                                        cc(x, y)[0]) + ((b(1 - sc(x, y)),) if hasattr(shape, 'scratch') else ())
                                       for x in range(N)] for y in range(N)])

    # Still clearly brushed: at least 2× smoother along the brush than across
    pairs = sorted((alpha_y[y][x], alpha_x[y][x]) for y in range(N) for x in range(N) if brush[y][x])
    if not pairs:  # nothing brushed (treadplate): rolled, not brushed
        print(f'  {name}: height {lo:.2f}..{hi:.2f} px, unbrushed, edge grime {sum(map(sum, G)) / N / N:.0%} average')
        continue
    ay_med, ax_med = pairs[len(pairs) // 2][0], sorted(p[1] for p in pairs)[len(pairs) // 2]
    print(f'  {name}: height {lo:.2f}..{hi:.2f} px, alpha across {ay_med:.3f} / along {ax_med:.3f} = {ay_med / ax_med:.1f}×,'
          f' edge grime {sum(map(sum, G)) / N / N:.0%} average')
    # (a parallax tile's brushed part is only its frame: too few texels for a fair median)
    assert ay_med / ax_med >= 2 or getattr(shape, 'parallax', False), 'brush lines must be at least 2× smoother along than across'
