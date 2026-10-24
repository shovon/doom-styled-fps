# Rigs an image-to-3d character (an unrigged mesh, standing in an A-pose) with the Mixamo skeleton fitted to it, and
# retargets Mixamo clips (downloaded on the stock X Bot) onto it; optionally puts a rifle (the M4 pack's) in its hands.
# Run with:
#   Blender -b --factory-startup --python tools/rig_mixamo.py -- <character.glb> <out.glb> <Name>=<clip.fbx>[:<root>] ...
#     [--rifle <models/m4/scene.gltf> <Name of the clip to fit it in>] [--preview <dir>]
# root: 'in place' (the default: its travel taken out; the game moves it), 'keep' (its travel kept, from where it
# starts), 'ground' (kept, and the body put on the floor each frame: a death).
# models/zombie.glb (image-to-3d out/zombie/zombie.glb; the clips from Mixamo):
#   ... -- zombie.glb models/zombie.glb "Run=Zombie Running.fbx" "Idle=Zombie Idle.fbx" "Punch=Zombie Punching.fbx:keep"
#   "Die=Zombie Dying.fbx:ground"
# models/police.glb (image-to-3d out/police/textured_art_shaded.glb):
#   ... -- police.glb models/police.glb "Idle=Rifle Idle.fbx" "Walk=Rifle Walk.fbx" "WalkAim=Walking.fbx"
#   "Run=Run Forward.fbx" "Fire=Firing Rifle.fbx" "Die=Zombie Dying.fbx:ground" --rifle models/m4/scene.gltf Fire
#   (Walking.fbx: Mixamo's "Walking" with the rifle up, aimed)
# The rig: the X Bot's skeleton, each joint moved onto the character's (its middles found by slicing the mesh), each
# bone turned the least it takes to point along the character's limb (so the arms hang in its A-pose); the fingers ride
# with the hand (no weights of their own: the mesh's hands are mitts). Skinned by Blender's bone heat.
# The clips: every bone takes the X Bot's turn in the world each frame (the mesh is bound in the character's own pose,
# so its limbs follow from there), and the hips' height scaled to the character's.
# The rifle: in the right hand, its grip in the palm, pointing at the left hand, as they are in the clip named (a hold
# every Mixamo rifle clip shares), riding on the right hand from then on; a "muzzle" empty at its barrel's end.
import bpy, sys, math, os
import numpy as np
from mathutils import Vector, Matrix, Quaternion

args = sys.argv[sys.argv.index('--') + 1:]
def option(name, n=1):
    if name not in args: return None
    i = args.index(name); v = args[i + 1:i + 1 + n]; del args[i:i + 1 + n]
    return v
preview = (option('--preview') or [None])[0]
rifle_args = option('--rifle', 2)
char_glb, out_glb, *clip_args = args
HEIGHT = 1.82      # m: the X Bot's, so the clips' poses fit
FACES = 12000      # decimated to: plenty for a sprite a couple of hundred pixels tall
TEX = 512          # texture size
CLIPS = []
for c in clip_args:
    name, rest = c.split('=', 1)
    path, _, root = rest.partition(':')
    CLIPS.append((name, path, root or 'in place'))
P = 'mixamorig:'

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30

def import_fbx(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = [o for o in new if o.type == 'ARMATURE'][0]
    return arm, [o for o in new if o.type == 'MESH']

# --- the zombie mesh: 1.82 m tall, feet on the floor, decimated, its texture shrunk
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=char_glb)
body = [o for o in bpy.data.objects if o not in before and o.type == 'MESH'][0]
for o in [o for o in bpy.data.objects if o not in before and o is not body]:
    bpy.data.objects.remove(o)
body.parent = None
co = np.empty(len(body.data.vertices) * 3); body.data.vertices.foreach_get('co', co)
co = co.reshape(-1, 3) @ np.array(body.matrix_world.to_3x3()).T + np.array(body.matrix_world.translation)
s = HEIGHT / (co[:, 2].max() - co[:, 2].min())
body.matrix_world = Matrix.Translation((0, 0, -co[:, 2].min() * s)) @ Matrix.Scale(s, 4) @ body.matrix_world
bpy.context.view_layer.objects.active = body
body.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
dec = body.modifiers.new('decimate', 'DECIMATE')
dec.ratio = FACES / len(body.data.polygons)
bpy.ops.object.modifier_apply(modifier=dec.name)
body.name = body.data.name = os.path.splitext(os.path.basename(out_glb))[0].capitalize()
co = np.empty(len(body.data.vertices) * 3); body.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
print('zombie', len(body.data.vertices), 'verts', len(body.data.polygons), 'faces')

# --- the zombie's joints: middles of the mesh's slices (it faces -Y; +X is its left)
def middle(z, xlo, xhi, dz=0.015):
    sel = co[(np.abs(co[:, 2] - z) < dz) & (co[:, 0] > xlo) & (co[:, 0] < xhi)]
    c = (sel.min(axis=0) + sel.max(axis=0)) / 2
    return Vector((c[0], c[1], z))
def outer(z, sgn, dz=0.015):  # an arm's slice: what's past the widest gap across x on that side (torso to arm: the
    # decimated mesh has smaller gaps inside a limb, and a stray vertex or two out past it)
    sel = co[(np.abs(co[:, 2] - z) < dz) & (np.sign(co[:, 0]) == sgn)]
    xs = np.sort(sel[:, 0] * sgn); g = np.diff(xs)
    arm = sel[sel[:, 0] * sgn >= (xs[np.argmax(g) + 1] if len(g) and g.max() > 0.03 else xs[0])]
    c = (arm.min(axis=0) + arm.max(axis=0)) / 2
    return Vector((c[0], c[1], z))
J = {}
for side, sgn in (('Left', 1), ('Right', -1)):
    lo, hi = (0.0, 0.33) if sgn > 0 else (-0.33, 0.0)  # a leg, not the hand hanging beside it
    J[side + 'UpLeg'] = middle(0.79, lo, hi) * Vector((0.6, 1, 1))  # the hip joint: in from the thigh's middle
    J[side + 'Leg'] = middle(0.45, lo, hi)                           # the knee
    J[side + 'Foot'] = middle(0.10, lo, hi)                          # the ankle
    toe = co[(co[:, 2] < 0.06) & (np.sign(co[:, 0]) == sgn)]
    J[side + 'ToeBase'] = Vector((J[side + 'Foot'].x, (J[side + 'Foot'].y + toe[:, 1].min()) / 2, 0.02))  # the ball
    J[side + 'Toe_End'] = Vector((J[side + 'Foot'].x, toe[:, 1].min(), 0.02))
    J[side + 'Arm'] = Vector((0.19 * sgn, middle(1.40, -0.3, 0.3).y, 1.40))  # the shoulder joint
    J[side + 'ForeArm'] = outer(1.15, sgn)                                    # the elbow
    J[side + 'Hand'] = outer(0.96, sgn)                                       # the wrist
    J[side + 'HandEnd'] = outer(0.84, sgn)                                    # the hand's end
    J[side + 'Shoulder'] = Vector((0.05 * sgn, J[side + 'Arm'].y, 1.45))
J['Hips'] = Vector((0, middle(0.86, -0.3, 0.3).y, 0.86))
J['Neck'] = Vector((0, middle(1.56, -0.2, 0.2).y, 1.56))
J['Head'] = Vector((0, middle(1.63, -0.2, 0.2).y, 1.63))
J['HeadTop_End'] = Vector((0, J['Head'].y, HEIGHT))
for k in sorted(J): print('joint', k, [round(v, 3) for v in J[k]])

# --- the rig: the X Bot's skeleton, its joints moved onto the zombie's
src, xbot = import_fbx(CLIPS[0][1])
for o in xbot: bpy.data.objects.remove(o)
scene.frame_set(0)
srest = {b.name: src.matrix_world @ b.matrix_local for b in src.data.bones}
shead = {b.name: src.matrix_world @ b.head_local for b in src.data.bones}
stail = {b.name: src.matrix_world @ b.tail_local for b in src.data.bones}
def target_head(name):
    n = name[len(P):]
    if n in J: return J[n]
    # spine: between the hips and the neck, as on the X Bot
    if n.startswith('Spine'):
        t = (shead[name].z - shead[P + 'Hips'].z) / (shead[P + 'Neck'].z - shead[P + 'Hips'].z)
        return J['Hips'].lerp(J['Neck'], t)
    return None
arm_data = bpy.data.armatures.new('ZombieRig')
rig = bpy.data.objects.new('ZombieRig', arm_data)
scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
eb = {b.name: arm_data.edit_bones.new(b.name) for b in src.data.bones}
for b in src.data.bones:
    eb[b.name].parent = eb[b.parent.name] if b.parent else None
# heads: fitted where known; else carried with the parent (the fingers with the hand: turned and scaled with it)
fit = {}
def place(b):
    n = b.name
    h = target_head(n)
    if h is None:
        pb_ = b.parent.name
        ph, pt = fit[pb_]
        srcvec = stail[pb_] - shead[pb_]
        dstvec = pt - ph
        q = srcvec.rotation_difference(dstvec)
        k = dstvec.length / max(srcvec.length, 1e-6)
        h = pt + q @ ((shead[n] - stail[pb_]) * k)
        t = pt + q @ ((stail[n] - stail[pb_]) * k)
    else:
        # (the child it points at on the X Bot: the hips at the spine, not a leg)
        kids = sorted([c for c in b.children if target_head(c.name) is not None], key=lambda c: (shead[c.name] - stail[n]).length)
        end = {'Hand': 'HandEnd', 'Head': 'HeadTop_End', 'ToeBase': 'Toe_End'}
        short = n[len(P):].replace('Left', '').replace('Right', '')
        if short in end: t = J[n[len(P):].replace(short, end[short])]
        elif kids: t = target_head(kids[0].name)
        else: t = h + (stail[n] - shead[n])
        if (t - h).length < 1e-4: t = h + (stail[n] - shead[n])
    fit[n] = (h, t)
    for c in b.children: place(c)
for b in src.data.bones:
    if b.parent is None: place(b)
# each bone: the X Bot's, turned the least it takes to point from its new head to its new tail
for n, (h, t) in fit.items():
    e = eb[n]
    q = (stail[n] - shead[n]).rotation_difference(t - h)
    m = (q.to_matrix().to_4x4() @ Matrix.Translation(-shead[n]) @ srest[n]).normalized()
    m.translation = h
    e.head, e.tail = h, t
    e.matrix = m  # (sets the roll so it turns as the X Bot's)
    e.length = (t - h).length
    e.use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')
# the fingers, eyes and ends ride along, weightless
for b in arm_data.bones:
    n = b.name[len(P):]
    b.use_deform = not (n.endswith('_End') or 'Hand' in n and n not in ('LeftHand', 'RightHand'))
print('deforming bones', sum(b.use_deform for b in arm_data.bones), 'of', len(arm_data.bones))

# --- skin: bone heat, worked out on a closed copy (the generated mesh is split along its texture seams, and bone heat
# needs one closed surface: on the mesh itself it found nothing), then carried to the mesh by the nearest surface
proxy = body.copy(); proxy.data = body.data.copy(); scene.collection.objects.link(proxy)
rem = proxy.modifiers.new('remesh', 'REMESH'); rem.mode = 'VOXEL'; rem.voxel_size = 0.015
bpy.ops.object.select_all(action='DESELECT')
proxy.select_set(True); bpy.context.view_layer.objects.active = proxy
bpy.ops.object.modifier_apply(modifier=rem.name)
print('proxy', len(proxy.data.vertices), 'verts')
bpy.ops.object.select_all(action='DESELECT')
proxy.select_set(True); rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
print('proxy weighted', sum(1 for v in proxy.data.vertices if v.groups), 'of', len(proxy.data.vertices))
for g in proxy.vertex_groups: body.vertex_groups.new(name=g.name)
dt = body.modifiers.new('weights', 'DATA_TRANSFER')
dt.object = proxy
dt.use_vert_data = True
dt.data_types_verts = {'VGROUP_WEIGHTS'}
dt.vert_mapping = 'POLYINTERP_NEAREST'
bpy.ops.object.select_all(action='DESELECT')
body.select_set(True); bpy.context.view_layer.objects.active = body
bpy.ops.object.modifier_apply(modifier=dt.name)
bpy.data.objects.remove(proxy)
# a few bits (loose specks the copy closed over) got nothing: each takes its nearest weighted neighbour's weights, or
# it stays standing at its rest place as the body moves (a spike from the body up to there)
from mathutils.kdtree import KDTree
have = [v for v in body.data.vertices if v.groups]
none = [v.index for v in body.data.vertices if not v.groups]
kd = KDTree(len(have))
for i, v in enumerate(have): kd.insert(v.co, i)
kd.balance()
for i in none:
    _, j, _ = kd.find(body.data.vertices[i].co)
    for g in [(g.group, g.weight) for g in have[j].groups]: body.vertex_groups[g[0]].add([i], g[1], 'REPLACE')
print('unweighted given their neighbour\'s', len(none))
bpy.ops.object.select_all(action='DESELECT')
body.select_set(True); bpy.context.view_layer.objects.active = body
bpy.ops.object.vertex_group_normalize_all(lock_active=False)
body.parent = rig
mod = body.modifiers.new('rig', 'ARMATURE'); mod.object = rig
weighted = sum(1 for v in body.data.vertices if v.groups)
print('weighted vertices', weighted, 'of', len(body.data.vertices))

# --- the clips
rig.animation_data_create()
rest = {b.name: rig.matrix_world @ b.matrix_local for b in rig.data.bones}
order = []
def visit(b):
    order.append(b)
    for c in b.children: visit(c)
for b in rig.data.bones:
    if b.parent is None: visit(b)
rot = lambda m: m.to_3x3().normalized().to_quaternion()
k = J['Hips'].z / shead[P + 'Hips'].z  # hip heights: the zombie's legs are shorter
print('hip ratio', round(k, 3))
body_bones = {b.name for b in rig.data.bones if b.use_deform and not any(s in b.name for s in ('Arm', 'Hand', 'Shoulder'))}

for clip, fbx, root in CLIPS:
    s2, extra = import_fbx(fbx)
    for o in extra: bpy.data.objects.remove(o)
    sact = s2.animation_data.action
    f0, f1 = map(int, sact.frame_range)
    scene.frame_set(f0); first = (s2.matrix_world @ s2.pose.bones[P + 'Hips'].head).copy()
    scene.frame_set(f1); last = (s2.matrix_world @ s2.pose.bones[P + 'Hips'].head).copy()
    print(clip, 'frames', f0, f1, 'hips travel', [round(v, 3) for v in last - first])
    act = bpy.data.actions.new(clip)
    rig.animation_data.action = act
    prev = {}
    for f in range(f0, f1 + 1):
        scene.frame_set(f)
        sp = {pb.name: s2.matrix_world @ pb.matrix for pb in s2.pose.bones}
        world = {}
        for b in order:
            pb = rig.pose.bones[b.name]
            pb.rotation_mode = 'QUATERNION'
            restrel = (b.parent.matrix_local.inverted() @ b.matrix_local) if b.parent else b.matrix_local
            base = (world[b.parent.name] if b.parent else Quaternion()) @ rot(restrel)
            desired = rot(sp[b.name])  # the X Bot's turn in the world
            basis = base.inverted() @ desired
            world[b.name] = desired
            if b.name in prev and prev[b.name].dot(basis) < 0: basis.negate()  # (one hemisphere: no spins)
            prev[b.name] = basis.copy()
            pb.rotation_quaternion = basis
            pb.keyframe_insert('rotation_quaternion', frame=f - f0)
            if b.parent is None:  # the hips: the X Bot's, scaled; Run and Idle stay put (the game moves them)
                h = sp[b.name].translation.copy()
                t = (f - f0) / max(f1 - f0, 1)
                if root == 'in place': h -= Vector(((last - first).x * t, (last - first).y * t, 0)) + Vector((first.x, first.y, 0))
                else: h -= Vector((first.x, first.y, 0))
                want = Vector((h.x * k, h.y * k, h.z * k))
                pb.location = rot(b.matrix_local).inverted() @ (want - b.head_local)
                pb.keyframe_insert('location', frame=f - f0)
    if root == 'ground':  # the lowest of the body (not the arms) on the floor, each frame
        hb, hpb = rig.data.bones[order[0].name], rig.pose.bones[order[0].name]
        names = {g.index: g.name for g in body.vertex_groups}
        idx = np.array([v.index for v in body.data.vertices if v.groups and names.get(max(v.groups, key=lambda g: g.weight).group) in body_bones])
        lows = []
        for f in range(0, f1 - f0 + 1):
            scene.frame_set(f)
            dg = bpy.context.evaluated_depsgraph_get(); e = body.evaluated_get(dg); me = e.to_mesh()
            c = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', c); e.to_mesh_clear()
            low = float(c.reshape(-1, 3)[idx, 2].min())
            hpb.location = hpb.location + rot(hb.matrix_local).inverted() @ Vector((0, 0, -low))
            hpb.keyframe_insert('location', frame=f)
            lows.append(round(low, 3))
        print(clip, 'grounding (lowest body point per frame, before):', lows[::6])
    track = rig.animation_data.nla_tracks.new()
    track.name = clip
    track.strips.new(clip, 0, act)
    rig.animation_data.action = None
    bpy.data.objects.remove(s2)
bpy.data.objects.remove(src)

# --- the rifle: the M4 pack's (its body, magazine, bolt, catch, trigger and safety), in the right hand
if rifle_args:
    m4, fit = rifle_args
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=m4)
    new = [o for o in bpy.data.objects if o not in before]
    bpy.context.view_layer.update()
    keep = ('Main_M4', 'Mag1_M4', 'Bolt_M4', 'BoltCatch_M4', 'Trigger_M4', 'Safety_M4')
    parts = [o for o in new if o.type == 'MESH' and not o.find_armature() and o.name.startswith(keep)]
    wv = lambda o: np.array([o.matrix_world @ v.co for v in o.data.vertices])
    main = wv([o for o in parts if o.name.startswith('Main_M4')][0])
    trig = wv([o for o in parts if o.name.startswith('Trigger_M4')][0]).mean(axis=0)
    mag = wv([o for o in parts if o.name.startswith('Mag1_M4')][0]).mean(axis=0)
    # its length: the way its vertices spread furthest (it comes in posed by the pack's first clip: at a slant); the
    # muzzle end, the thinner of the two ends (the stock's the bulkier)
    mid = main.mean(axis=0)
    length = np.linalg.eigh((main - mid).T @ (main - mid))[1][:, -1]
    t = (main - mid) @ length
    ends = [main[t < t.min() + 0.02], main[t > t.max() - 0.02]]
    tip = ends[int(np.argmin([np.ptp(e, axis=0).sum() for e in ends]))].mean(axis=0)
    axis = Vector(length) * (1 if np.dot(tip - mid, length) > 0 else -1)
    up = Vector(main.mean(axis=0) - mag); up -= axis * up.dot(axis); up.normalize()  # (the magazine hangs below)
    grip = Vector(trig) - axis * 0.045 - up * 0.05  # the pistol grip: behind and below the trigger
    new_names = [o.name for o in new]  # (the parts are gone once joined: kept by name)
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts: o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')  # (off their bones, where they sit, in metres)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.join()
    gun = bpy.context.view_layer.objects.active
    gun.name = gun.data.name = 'Rifle'
    for n in new_names:  # the rest of the pack: its arms, rig and spare magazine
        if n in bpy.data.objects and bpy.data.objects[n] is not gun: bpy.data.objects.remove(bpy.data.objects[n])
    # the rifle's own frame: grip at its origin, the barrel along -Y, up +Z (Blender: so it exports barrel +Z, up +Y)
    rot = Matrix((up.cross(axis), -axis, up)).transposed().to_4x4()  # columns: its x, y (back), z (up) in the world
    gun.data.transform(rot.inverted() @ Matrix.Translation(-grip))
    muzzle = bpy.data.objects.new('muzzle', None); scene.collection.objects.link(muzzle)
    muzzle.parent = gun; muzzle.location = rot.inverted().to_3x3() @ (Vector(tip) - grip)
    # the hold: in the named clip, a little way in, the right palm and the left
    for tr in rig.animation_data.nla_tracks: tr.mute = tr.name != fit
    scene.frame_set(int(bpy.data.actions[fit].frame_range[1]) // 3)
    bpy.context.view_layer.update()
    at = lambda n: rig.matrix_world @ rig.pose.bones[P + n].head
    right = (at('RightHand') + at('RightHandMiddle1')) / 2
    left = (at('LeftHand') + at('LeftHandMiddle1')) / 2
    d = (left - right).normalized(); u = Vector((0, 0, 1)); u = (u - d * u.dot(d)).normalized()
    want = Matrix((u.cross(d), -d, u)).transposed().to_4x4(); want.translation = right
    # on the right hand: its place on the hand, from the hand as it is in that pose (a bone's child hangs off its tail)
    pb = rig.pose.bones[P + 'RightHand']
    hand = rig.matrix_world @ pb.matrix @ Matrix.Translation((0, pb.bone.length, 0))
    gun.parent = rig; gun.parent_type = 'BONE'; gun.parent_bone = P + 'RightHand'
    gun.matrix_parent_inverse = Matrix.Identity(4)
    gun.matrix_basis = hand.inverted() @ want
    bpy.context.view_layer.update()
    print('rifle placed: barrel', [round(v, 2) for v in (gun.matrix_world.to_3x3() @ Vector((0, -1, 0)))], 'wanted', [round(v, 2) for v in d])
    for tr in rig.animation_data.nla_tracks: tr.mute = False
    print('rifle', round((Vector(tip) - grip).length, 3), 'm from grip to muzzle; hands', round((left - right).length, 3), 'm apart')

# --- previews: a few frames of each clip, front and side
if preview:
    os.makedirs(preview, exist_ok=True)
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.color_type = 'TEXTURE'
    scene.render.resolution_x, scene.render.resolution_y = 300, 400
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam); scene.camera = cam
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = 2.4
    for track in rig.animation_data.nla_tracks: track.mute = True
    for track in rig.animation_data.nla_tracks:
        track.mute = False
        a = track.strips[0].action
        n = int(a.frame_range[1])
        for f in (0, n // 3, 2 * n // 3, n):
            scene.frame_set(f)
            for label, loc, r in (('front', (0, -5, 1.0), (math.pi / 2, 0, 0)), ('side', (5, 0, 1.0), (math.pi / 2, 0, math.pi / 2))):
                cam.location, cam.rotation_euler = loc, r
                scene.render.filepath = os.path.join(preview, f'{track.name}_{f:03d}_{label}.png')
                bpy.ops.render.render(write_still=True)
        track.mute = True
    for track in rig.animation_data.nla_tracks: track.mute = False
    bpy.data.objects.remove(cam)

for img in bpy.data.images:
    if img.size[0] > TEX: img.scale(TEX, TEX * img.size[1] // img.size[0])
    img.pack()
bpy.ops.object.select_all(action='DESELECT')
body.select_set(True); rig.select_set(True)
for o in bpy.data.objects:
    if o.name in ('Rifle', 'muzzle'): o.select_set(True)
bpy.ops.export_scene.gltf(filepath=out_glb, export_format='GLB', use_selection=True, export_animation_mode='NLA_TRACKS',
                          export_force_sampling=True, export_image_format='AUTO')
print('wrote', out_glb)
