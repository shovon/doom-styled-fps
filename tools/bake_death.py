# Makes models/demon_death.glb: retargets Mixamo's "Death From Back Headshot" onto the demon rig. Run with:
#   Blender -b --factory-startup --python tools/bake_death.py -- <demon_rigged.blend> "<Death From Back Headshot.fbx>" models/demon_death.glb <preview dir>
# (demon_rigged.blend: hunyuan3d-mv/out/demon/; the .fbx: Mixamo)
# Retarget a Mixamo death onto the DemonRig and export just that clip ("Death") as a GLB.
# Opens the .blend read-only (never saves it).
import bpy, sys, math
from mathutils import Quaternion, Vector

blend, fbx, out_glb, preview_dir = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.open_mainfile(filepath=blend)
scene = bpy.context.scene
scene.render.fps = 30  # Mixamo clips are 30 fps
arm = bpy.data.objects["DemonRig"]

# IK / constraints would override the baked rotations; drop them for this session only
for pb in arm.pose.bones:
    for c in list(pb.constraints):
        print("removing constraint", pb.name, c.type, getattr(c, "subtarget", ""))
        pb.constraints.remove(c)
    pb.rotation_mode = "QUATERNION"
    pb.location, pb.rotation_quaternion, pb.scale = (0, 0, 0), (1, 0, 0, 0), (1, 1, 1)
if arm.animation_data:
    arm.animation_data.action = None

before = set(bpy.data.objects)
bpy.ops.import_scene.fbx(filepath=fbx)
src = [o for o in bpy.data.objects if o not in before and o.type == "ARMATURE"][0]
sact = src.animation_data.action
f0, f1 = map(int, sact.frame_range)
P = "mixamorig:"

def rot(m): return m.to_3x3().normalized().to_quaternion()
def ydir(m): return m.to_3x3().normalized().col[1].normalized()

# Legs/spine: apply the source's rotation relative to its rest (keeps the demon's bent-leg shape).
DELTA = {"hips": "Hips", "spine": "Spine", "chest": "Spine2", "neck": "Neck", "head": "Head",
         "thigh.L": "LeftUpLeg", "shin.L": "LeftLeg", "foot.L": "LeftFoot", "toe.L": "LeftToeBase",
         "thigh.R": "RightUpLeg", "shin.R": "RightLeg", "foot.R": "RightFoot", "toe.R": "RightToeBase"}
# Arms: rest poses differ (T-pose vs angled down), so match the source's bone directions instead.
MATCH = {"upper_arm.L": "LeftArm", "forearm.L": "LeftForeArm", "hand.L": "LeftHand", "upper_arm.R": "RightArm"}
SRC = {**DELTA, **MATCH}  # gun.R and unmapped bones keep their rest pose relative to their parent

src_rest = {b.name: src.matrix_world @ b.matrix_local for b in src.data.bones}
tgt_rest = {b.name: arm.matrix_world @ b.matrix_local for b in arm.data.bones}
offset = {}
for t, s in DELTA.items():
    offset[t] = rot(src_rest[P + s]).inverted() @ rot(tgt_rest[t])
for t, s in MATCH.items():
    align = ydir(tgt_rest[t]).rotation_difference(ydir(src_rest[P + s]))
    offset[t] = rot(src_rest[P + s]).inverted() @ align @ rot(tgt_rest[t])

k = tgt_rest["hips"].translation.z / src_rest[P + "Hips"].translation.z  # hip-height ratio
print("hip height ratio", round(k, 3), "frames", f0, f1)

order = []
def visit(b):
    order.append(b)
    for c in b.children: visit(c)
for b in arm.data.bones:
    if b.parent is None: visit(b)

arm_rot_inv = rot(arm.matrix_world).inverted()
arm_m3_inv = arm.matrix_world.to_3x3().inverted()

scene.frame_set(f0); first = (src.matrix_world @ src.pose.bones[P + "Hips"].matrix).translation.copy()
scene.frame_set(f1); last = (src.matrix_world @ src.pose.bones[P + "Hips"].matrix).translation.copy()
print("source hips travel per cycle (m):", round((last - first).length, 3))

act = bpy.data.actions.new("DeathBaked")
arm.animation_data_create()
arm.animation_data.action = act
prev = {}
for f in range(f0, f1 + 1):
    scene.frame_set(f)
    sp = {pb.name: src.matrix_world @ pb.matrix for pb in src.pose.bones}
    pose_q = {}
    for b in order:
        pb = arm.pose.bones[b.name]
        restrel = (b.parent.matrix_local.inverted() @ b.matrix_local) if b.parent else b.matrix_local
        base = (pose_q[b.parent.name] if b.parent else Quaternion()) @ rot(restrel)
        if b.name in offset:
            desired = arm_rot_inv @ rot(sp[P + SRC[b.name]]) @ offset[b.name]
            basis = base.inverted() @ desired
        else:
            desired, basis = base, Quaternion()
        pose_q[b.name] = desired
        if b.name in prev and prev[b.name].dot(basis) < 0:
            basis.negate()  # keep quaternion keys on one hemisphere so interpolation doesn't spin
        prev[b.name] = basis.copy()
        pb.rotation_quaternion = basis
        pb.keyframe_insert("rotation_quaternion", frame=f - f0)
        if b.name == "hips":
            # Keep the fall's travel (relative to where it starts), scaled to the demon's size
            h = sp[P + "Hips"].translation
            disp = Vector((h.x - first.x, h.y - first.y, h.z - src_rest[P + "Hips"].translation.z)) * k
            pb.location = rot(b.matrix_local).inverted() @ (arm_m3_inv @ disp)
            pb.keyframe_insert("location", frame=f - f0)

# Ground: by the mesh's body (the vertices mostly driven by the hips, spine, chest, neck, head and legs), each frame
# its lowest point is put on the floor (lifted or lowered), so the demon stands on it at the start and lies on it at
# the end. Not by every vertex: the gun arm's cannon points down under it as it falls, and grounding on that props
# the whole body up off the floor; it's let sink in instead (the floor hides it).
import numpy as np
meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.find_armature() == arm]
BODY = {"hips", "spine", "chest", "neck", "head", "thigh.L", "thigh.R", "shin.L", "shin.R", "foot.L", "foot.R", "toe.L", "toe.R"}
body_idx = {}
for o in meshes:
    names = {g.index: g.name for g in o.vertex_groups}
    idx = [v.index for v in o.data.vertices if v.groups and names.get(max(v.groups, key=lambda g: g.weight).group) in BODY]
    body_idx[o.name] = np.array(idx, dtype=np.int64)
    print("body vertices in", o.name, len(idx), "of", len(o.data.vertices))
hips_pb, hips_b = arm.pose.bones["hips"], arm.data.bones["hips"]
lows = []
for f in range(0, f1 - f0 + 1):
    scene.frame_set(f)
    dg = bpy.context.evaluated_depsgraph_get()
    low = 1e9
    for o in meshes:
        e = o.evaluated_get(dg); me = e.to_mesh()
        co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3) @ np.array(e.matrix_world.to_3x3()).T + np.array(e.matrix_world.translation)
        low = min(low, float(co[body_idx[o.name], 2].min())); e.to_mesh_clear()
    hips_pb.location = hips_pb.location + rot(hips_b.matrix_local).inverted() @ (arm_m3_inv @ Vector((0, 0, -low)))
    hips_pb.keyframe_insert("location", frame=f)
    lows.append(round(low, 3))
print("lowest vertex per frame (before grounding):", lows[::8])
scene.frame_set(f1 - f0)
hp = (arm.matrix_world @ arm.pose.bones["hips"].head)
print("final hips position:", [round(v, 3) for v in hp], "frames:", f1 - f0)

# Limbs: lying, the retarget keeps the demon's own bent legs and arm angles, so legs and arms hang up off the floor.
# Pull each limb's end down to the floor with Blender's IK (two bones each), as much as the body is down (by the
# chest's height: none while standing or falling, all of it once it's lying, and it stays), then bake it into the keys.
# Each: the IK bone (whose tail is pulled down), and how high off the floor that point rests (the limb's thickness).
LIMBS = {"shin.L": 0.12, "shin.R": 0.12,  # ankles
         "forearm.L": 0.1,                # the wrist (the claws carry on into the floor)
         "gun.R": 0.12}                   # the cannon's muzzle end: the gun arm is upper arm + cannon
F = f1 - f0
chest_h, ends = [], []
for f in range(F + 1):
    scene.frame_set(f)
    chest_h.append((arm.matrix_world @ arm.pose.bones["chest"].head).z)
    ends.append({n: (arm.matrix_world @ arm.pose.bones[n].tail).copy() for n in LIMBS})
stand, lie = chest_h[0], chest_h[F]  # standing, and lying at the end
iks = {}
for n in LIMBS:
    e = bpy.data.objects.new(f"target.{n}", None); scene.collection.objects.link(e)
    c = arm.pose.bones[n].constraints.new("IK"); c.target = e; c.chain_count = 2
    iks[n] = (e, c)
w_held = 0.0
for f in range(F + 1):
    t = max(0.0, min(1.0, (stand - chest_h[f]) / max(stand - lie, 1e-6)))
    w = max(0.0, min(1.0, (t - 0.7) / 0.3)); w = w * w * (3 - 2 * w)  # smoothstep: only once it's well down
    w = w_held = max(w, w_held)  # and once down, it stays down
    for n, (e, c) in iks.items():
        p = ends[f][n]
        e.location = (p.x, p.y, LIMBS[n]); e.keyframe_insert("location", frame=f)
        c.influence = w; c.keyframe_insert("influence", frame=f)
print("limb ends at the end, before:", {n: round(ends[F][n].z, 2) for n in LIMBS})
bpy.context.view_layer.objects.active = arm
arm.select_set(True)
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.select_all(action="SELECT")
bpy.ops.nla.bake(frame_start=0, frame_end=F, only_selected=False, visual_keying=True, clear_constraints=True,
                 use_current_action=True, bake_types={"POSE"})
bpy.ops.object.mode_set(mode="OBJECT")
act = arm.animation_data.action
scene.frame_set(F)
print("limb ends at the end, after:", {n: round((arm.matrix_world @ arm.pose.bones[n].tail).z, 2) for n in LIMBS})
act.name = "Death"
scene.frame_start, scene.frame_end = 0, f1 - f0

# Preview renders (side + front), hide the source skeleton
src.hide_render = True
for c in src.children_recursive: c.hide_render = True  # its mannequin mesh too
bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0))  # floor, preview only
scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x = scene.render.resolution_y = 360
scene.render.film_transparent = False
cam_data = bpy.data.cameras.new("PreviewCam"); cam_data.type = "ORTHO"; cam_data.ortho_scale = 3.2
cam = bpy.data.objects.new("PreviewCam", cam_data); scene.collection.objects.link(cam); scene.camera = cam
for view, loc, rot_e in (("side", (6, 0.2, 1.3), (math.radians(90), 0, math.radians(90))),
                         ("front", (0.03, -6, 1.3), (math.radians(90), 0, 0))):
    cam.location, cam.rotation_euler = loc, rot_e
    for f in (0, (f1 - f0) // 3, 2 * (f1 - f0) // 3, f1 - f0):
        scene.frame_set(f)
        scene.render.filepath = f"{preview_dir}/{view}_{f:02d}.png"
        bpy.ops.render.render(write_still=True)

# Export only the rig + Walk: drop everything else from this (unsaved) session
for o in list(bpy.data.objects):
    if o is not arm: bpy.data.objects.remove(o, do_unlink=True)
for a in list(bpy.data.actions):
    if a is not act: bpy.data.actions.remove(a)
bpy.ops.export_scene.gltf(filepath=out_glb, export_format="GLB", export_animations=True,
                          export_animation_mode="ACTIONS", export_force_sampling=True, export_def_bones=True)
print("exported", out_glb)
