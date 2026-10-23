# CANIK RIVAL S (Cam Diep Minh, CC-BY-4.0) → the game's layout: metres (×0.1: 206 mm without the comp), the trigger at
# the origin, the barrel along glTF −Z, up +Y; the slide (and what rides on it) as child "Slide", so it can cycle;
# the spare magazine lying beside the gun dropped; textures at TEX px; one GLB. Run with:
#   Blender -b --factory-startup --python tools/pistol.py -- <sketchfab download>/scene.gltf models/pistol/pistol.glb 512
# It prints the muzzle (the comp's front, on the bore) and the slide's bounds (glTF axes), for PISTOL_* in index.html.
import bpy, sys, math, mathutils
src, out, TEX = sys.argv[-3], sys.argv[-2], int(sys.argv[-1])
SCALE = 0.1
TRIGGER = mathutils.Vector((0.171, 0, 0.158))  # the trigger blade's middle (source units), from its bounds
BORE_Z = 0.55  # the barrel's axis height (source units)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
SPARE = ('BezierCircle_low.001', 'buttplate_low.001', 'follower_low.001', 'mag.002')  # the loose magazine
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in meshes:
    w = o.matrix_world.copy(); o.parent = None; o.matrix_world = w
for o in list(bpy.data.objects):
    if o.type != 'MESH' or o.name.startswith(SPARE): bpy.data.objects.remove(o)
meshes = list(bpy.data.objects)
slide = [o for o in meshes if o.material_slots and o.material_slots[0].material.name.startswith('slide_low')]
body = [o for o in meshes if o not in slide]
# muzzle −X → Blender +Y (glTF −Z); the trigger to the origin; metres
turn = mathutils.Matrix.Scale(SCALE, 4) @ mathutils.Matrix.Rotation(-math.pi / 2, 4, 'Z') @ mathutils.Matrix.Translation(-TRIGGER)
for o in meshes: o.matrix_world = turn @ o.matrix_world
def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(objs) > 1: bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = ob.data.name = name
    return ob
pistol, sl = join(body, 'Pistol'), join(slide, 'Slide')
sl.parent = pistol
g = lambda v: tuple(round(c, 4) for c in (v.x, v.z, -v.y))  # Blender → glTF (three.js) axes
front = max(v.co.y for v in pistol.data.vertices)
print('MUZZLE', g(mathutils.Vector((0, front, (BORE_Z - TRIGGER.z) * SCALE))))
sv = [v.co for v in sl.data.vertices]
print('SLIDE min', g(mathutils.Vector([min(v[i] for v in sv) for i in range(3)])), 'max', g(mathutils.Vector([max(v[i] for v in sv) for i in range(3)])))
for img in bpy.data.images:
    if img.size[0] > TEX: img.scale(TEX, TEX * img.size[1] // img.size[0])
    img.pack()
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_image_format='AUTO', export_apply=True)
