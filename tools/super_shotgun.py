# Sci-fi Super Shotgun (tnnv, CC-BY-4.0) → the game's layout: metres, trigger at the origin, barrels along glTF −Z,
# the barrels + forend as child "Barrels" with its origin on the hinge, textures at TEX px, one GLB. Run with:
#   Blender -b --factory-startup --python tools/super_shotgun.py -- <sketchfab download>/scene.gltf models/super_shotgun/super_shotgun.glb 512
# It prints the hinge, the barrels' front and back and the body's bounds (glTF axes), for SHOTGUN_* in index.html.
import bpy, sys, math, mathutils
src, out, TEX = sys.argv[-3], sys.argv[-2], int(sys.argv[-1])
TRIGGER = mathutils.Vector((0, -0.0769, -0.0131))  # Blender space, read off a side render
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
body = next(o for o in bpy.data.objects if o.name.startswith('ShotgunLow.004_'))
barrels = next(o for o in bpy.data.objects if o.name.startswith('ShotgunLow.005_'))
for o in (body, barrels):
    w = o.matrix_world.copy(); o.parent = None; o.matrix_world = w
for o in list(bpy.data.objects):
    if o not in (body, barrels): bpy.data.objects.remove(o)
turn = mathutils.Matrix.Rotation(math.pi, 4, 'Z') @ mathutils.Matrix.Translation(-TRIGGER)
for o in (body, barrels):
    o.matrix_world = turn @ o.matrix_world
    bpy.context.view_layer.objects.active = o
    for s in bpy.context.selected_objects: s.select_set(False)
    o.select_set(True)
    bpy.ops.object.transform_apply(location=(o is body), rotation=True, scale=True)
body.name, barrels.name = 'Shotgun', 'Barrels'
w = barrels.matrix_world.copy(); barrels.parent = body; barrels.matrix_world = w
g = lambda v: tuple(round(c, 4) for c in (v.x, v.z, -v.y))  # Blender → glTF (three.js) axes
vs = [barrels.matrix_world @ v.co for v in barrels.data.vertices]
front = max(v.y for v in vs); back = min(v.y for v in vs)
tip = [v for v in vs if v.y > front - 0.004]
print('HINGE', g(barrels.matrix_world.translation))
print('FRONT_Y', round(front, 4), 'BACK_Y', round(back, 4))
print('TIP x', sorted(set(round(v.x, 3) for v in tip)), 'z', sorted(set(round(v.z, 3) for v in tip)))
bb = [body.matrix_world @ mathutils.Vector(c) for c in body.bound_box]
print('BODY min', g(mathutils.Vector([min(b[i] for b in bb) for i in range(3)])), 'max', g(mathutils.Vector([max(b[i] for b in bb) for i in range(3)])))
for img in bpy.data.images:
    if img.size[0] > TEX: img.scale(TEX, TEX)
    img.pack()
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_image_format='AUTO', export_apply=True)
