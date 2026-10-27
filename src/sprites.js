// SpriteImpostor: how the demons, skulls and the dead are drawn (pixel-art sprites of their 3D models)
import * as THREE from 'three';
import { PORTAL_LIGHTS } from './setup.js';
import { floorAt } from './arena.js';
import { PORTAL_BUILD_LEAD } from './portals.js';


// ---------------------------------------------------------------------------
// SpriteImpostor: renders a model off-screen into a small texture and shows it
// on a camera-facing card. Keep the impostor itself at the origin and move/rotate
// `.model` in world coordinates.
// ---------------------------------------------------------------------------
const cardGeo = new THREE.PlaneGeometry(1, 1);
const boundsLineMat = new THREE.LineBasicMaterial({ color: 0xff00ff });
const boundsFillMat = new THREE.MeshBasicMaterial({ color: 0xff00ff, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
const edgesGeo = new THREE.EdgesGeometry(cardGeo);
const blobMat = (() => { // soft round contact shadow, one texture shared by everyone
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false });
})();
const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const silhouetteMat = new THREE.MeshBasicMaterial({ color: 0x000000 }); // shadow sprites only need the outline
const _cs = new THREE.Vector3(), _rc = new THREE.Vector3(), _toCam = new THREE.Vector3(), _facing = new THREE.Vector3(), _center = new THREE.Vector3();
const CORPSE_ELEVATION = THREE.MathUtils.degToRad(20); // a body's one view: this far above the horizontal
const SPRITE_NEAR = 0.1, SPRITE_FAR = 200, SPRITE_DEPTH_BIAS = 0.1; // m: the RT camera's clip range; card depth pulled towards you
const STILL_RELIGHT = 0.25; // s: a still sprite's relight, at most this often, while you move (see SpriteImpostor's still)
const _dir = new THREE.Vector3(), _look = new THREE.Vector3(), _bb = new THREE.Box3(), _bv3 = new THREE.Vector3();
const _frustum = new THREE.Frustum(), _vp = new THREE.Matrix4(), _sphere = new THREE.Sphere();

export class SpriteImpostor extends THREE.Group {
  // opts is shared by reference, so flipping a field changes every impostor at once:
  // { stage, resolution, snaps, pitchSnaps, distance, animFps, stepped, snap, lockDist, real, bounds,
  //   spriteShadows, sun, flashLights, lod, lodNear, lodFalloff }  (sun: the shadow-casting DirectionalLight;
  //   flashLights: point lights living in the stage, at world positions, that sprites should react to)
  constructor(model, mixer, opts) {
    super();
    this.model = model; this.mixer = mixer; this.opts = opts;
    this.animAcc = (1 + Math.random()) / opts.animFps; // pose on the first frame (no T-pose), then spread steps across frames
    this.frozenAt = null;
    this.hidden = false;        // e.g. your own character in first person: no card, but shadow stays
    this.lastKey = undefined;   // view + pose of the last sprite render; undefined = must re-render
    this.lastLights = 0;        // which flash lights were reaching it at the last render
    this.shadowKey = undefined; // same, for the shadow sprite
    this.frontOnly = false;     // only ever drawn from straight in front (see update)
    this.frontAz = 0;           // ...or this far round from its front (π: from behind)
    this.below = false;         // seen from below too (a flyer): else never from lower than level
    this.still = false;         // a settled corpse: no more poses (it was redrawn 12 times a second, the same picture);
                                // redrawn when the view or the flashes on it change, it's wounded, or (at most every
                                // STILL_RELIGHT s) you've moved (the light pools and ceiling lights follow you) or a
                                // portal's light is on it (it brightens)
    this.litFrom = new THREE.Vector3(Infinity, 0, 0); // (where you were when it was last drawn)

    // Render box from the bind pose (bone matrices start as zeros, so update them first)
    model.updateMatrixWorld(true);
    model.traverse((o) => o.isSkinnedMesh && o.skeleton.update());
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    this.r = (Math.max(size.x, size.y, size.z) / 2) * 1.2; // +20% so swinging limbs stay inside
    this.centerY = box.getCenter(new THREE.Vector3()).y - model.position.y;
    // The frame follows the pose (see refit): the bones' bounds, padded out to the flesh round them. The pad is
    // whatever takes the bind pose's bone bounds out to the box above, so standing it frames exactly as it did; a
    // pose reaching further (the death's fall, an arm thrown out) grows and moves the frame with it.
    this.bones = [];
    model.traverse((o) => o.isBone && this.bones.push(o));
    this.rBase = this.r;
    this.fit = new THREE.Vector3(0, this.centerY, 0); // the frame's centre, from the model's origin
    this.pad = 0;
    this.pad = this.rBase - this.boneBounds(new THREE.Vector3());

    // Nearest filtering = chunky pixels; no MSAA so sprite edges stay hard
    this.rt = new THREE.WebGLRenderTarget(opts.resolution, opts.resolution, {
      type: THREE.HalfFloatType, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter,
    });
    this.rt.depthTexture = new THREE.DepthTexture(opts.resolution, opts.resolution);
    this.cam = new THREE.PerspectiveCamera(); // projection set by hand
    this.cam.layers.enable(1); // layer 1: what only its sprite shows (a skull's fire), not its shadow or the hit tests

    // The card writes the model's own depth, per pixel: the RT's depth (how far behind or in front of the model's
    // centre each pixel is, as the RT camera saw it) added to the centre's depth in your view. So blood and other
    // things pass in front of and behind its limbs, not a flat cut at the card. Approximate under snapped angles (the
    // RT camera looks from up to half a snap away), so it's biased SPRITE_DEPTH_BIAS towards you.
    this.depthU = {
      uSpriteDepth: { value: this.rt.depthTexture }, uProj: { value: new THREE.Matrix4() },
      uDepthRef: { value: new THREE.Vector2() }, // the centre's depth: in your view, from the RT camera
      uBuild: { value: 1 }, // how much of it's there yet, coming through a portal (see Portals: 1, all of it)
    };
    const cardMat = new THREE.MeshBasicMaterial({
      map: this.rt.texture, transparent: true, premultipliedAlpha: true, side: THREE.DoubleSide,
    });
    cardMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.depthU);
      sh.fragmentShader = 'uniform sampler2D uSpriteDepth;\nuniform mat4 uProj;\nuniform vec2 uDepthRef;\nuniform float uBuild;\n' + `
        float buildHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float buildNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(buildHash(i), buildHash(i + vec2(1, 0)), f.x), mix(buildHash(i + vec2(0, 1)), buildHash(i + vec2(1, 1)), f.x), f.y);
        }\n` +
        sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        float sd = texture2D(uSpriteDepth, vMapUv).r;
        vec4 texel = texture2D(map, vMapUv);
        if (sd >= 1.0 && texel.r + texel.g + texel.b <= 0.0) discard; // nothing of the model here
        // light of its own over nothing of the model (a skull's fire: alpha 0, no depth): added on to what's behind,
        // fogged, at the model's middle's depth (premultiplied by its alpha above, it was gone)
        #ifdef USE_FOG
          texel.rgb *= 1.0 - fogFactor;
        #endif
        gl_FragColor.rgb += texel.rgb * (1.0 - texel.a);
        if (uBuild < 1.0) { // coming through a portal: built up from embers, as paper burns, backwards. Two fronts out
          // of its middle, one down to its foot and one up to its top, each ragged and grainy (noise on the sprite, so it
          // goes with it; the grain a speck a pixel of it, so its edge breaks up into specks): past them, not there yet;
          // at one, glowing as an ember; just behind it, charred a moment; then itself
          float grain = buildHash(floor(vMapUv * vec2(textureSize(map, 0))));
          float n = 0.75 * abs(vMapUv.y * 2.0 - 1.0) + 0.1 * (0.7 * buildNoise(vMapUv * 7.0) + 0.3 * buildNoise(vMapUv * 23.0)) + 0.15 * grain;
          float front = uBuild * ${(1 + 2 * PORTAL_BUILD_LEAD).toFixed(3)} - ${PORTAL_BUILD_LEAD.toFixed(3)}; // (nothing at first: see PORTAL_BUILD_LEAD)
          if (n > front) discard;
          float glow = smoothstep(front - 0.06, front, n), charred = smoothstep(front - 0.18, front - 0.06, n) * (1.0 - glow);
          gl_FragColor.rgb = gl_FragColor.rgb * (1.0 - 0.7 * charred) + mix(vec3(1.4, 0.2, 0.03), vec3(2.4, 1.5, 0.5), glow) * glow * 5.0; // (a red ember, a yellow-hot edge: the portals' fire)
        }
        float zs = sd >= 1.0 ? uDepthRef.y : ${SPRITE_NEAR.toFixed(2)} * ${SPRITE_FAR.toFixed(1)} / (${SPRITE_FAR.toFixed(1)} - sd * ${(SPRITE_FAR - SPRITE_NEAR).toFixed(2)});
        // (never nearer than your near plane: a demon right up against you puts its front, arm and gun, nearer than
        // its middle is far, which went behind the camera, where the depth wraps round to the far end: it vanished)
        vec4 c = uProj * vec4(0.0, 0.0, -max(uDepthRef.x + zs - uDepthRef.y - ${SPRITE_DEPTH_BIAS.toFixed(2)}, ${(SPRITE_NEAR * 1.05).toFixed(3)}), 1.0);
        gl_FragDepth = c.z / c.w * 0.5 + 0.5;`);
    };
    this.card = new THREE.Mesh(cardGeo, cardMat);
    this.bounds = new THREE.Group();
    const fill = new THREE.Mesh(cardGeo, boundsFillMat);
    fill.renderOrder = -1; // under the sprite texture
    this.bounds.add(new THREE.LineSegments(edgesGeo, boundsLineMat), fill);
    this.card.add(this.bounds);
    this.blob = new THREE.Mesh(blobGeo, blobMat);
    this.blob.renderOrder = -2;
    this.blob.scale.setScalar(this.r);

    // Shadow sprite: the silhouette as the sun sees it (orthographic, like a directional light), on an
    // invisible card facing the sun. Only the shadow pass sees it; alphaTest cuts out the silhouette.
    this.shadowRt = new THREE.WebGLRenderTarget(opts.resolution / 2, opts.resolution / 2, {
      magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter,
    });
    this.shadowCam = new THREE.OrthographicCamera(-this.r, this.r, this.r, -this.r, 0.1, 20);
    this.shadowCard = new THREE.Mesh(cardGeo, new THREE.MeshBasicMaterial({
      map: this.shadowRt.texture, alphaTest: 0.5, colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.shadowCard.castShadow = true;
    this.shadowCard.scale.setScalar(2 * this.r);
    this.add(this.card, this.blob, this.shadowCard);
  }

  // The bones' bounding box: its centre (from the model's origin) into out; returns its half-size (largest axis)
  boneBounds(out) {
    this.model.updateMatrixWorld(true);
    _bb.makeEmpty();
    for (const b of this.bones) _bb.expandByPoint(b.getWorldPosition(_bv3));
    _bb.getCenter(out).sub(this.model.position);
    _bb.getSize(_bv3);
    return Math.max(_bv3.x, _bv3.y, _bv3.z) / 2;
  }
  refit() { // on each new pose: the frame's centre and size from where the bones are now (never smaller than standing)
    if (!this.bones.length) return; // (a static model: its frame's as set)
    this.r = Math.max(this.rBase, this.boneBounds(this.fit) + this.pad);
  }

  freeze() {
    this.frozenAt = this.frozenAt ? null : this.model.position.clone();
    this.lastKey = this.shadowKey = undefined;
  }

  setResolution(n) {
    this.rt.setSize(n, n);
    // A new depth texture at the new size. three r170's setSize resizes only the colour texture: if the old depth
    // texture gets used (the card samples it) before the next sprite render, it's re-made at the old size, and once
    // made it can't be resized, so the colour and depth no longer match. WebGL then refuses to draw into the sprite
    // (an incomplete framebuffer), and the demon vanished until its next LOD step
    this.rt.depthTexture.dispose();
    this.rt.depthTexture = this.depthU.uSpriteDepth.value = new THREE.DepthTexture(n, n);
    this.shadowRt.setSize(n / 2, n / 2);
    this.lastKey = this.shadowKey = undefined;
  }

  // Distance LOD, logarithmic: full resolution up to lodNear, then each doubling of distance takes away
  // lodFalloff × base (snapped to 16 px steps, min 16 px). Gentler than halving per doubling.
  // ponytail: no hysteresis; a model pacing right on a step boundary reallocates its texture each crossing.
  applyLod(camera, center) {
    const o = this.opts;
    let n = o.resolution;
    if (o.lod) {
      const doublings = Math.max(0, Math.log2(camera.position.distanceTo(center) / o.lodNear));
      n = Math.max(Math.round((o.resolution * (1 - o.lodFalloff * doublings)) / 16) * 16, 16);
    }
    if (n !== this.rt.width) this.setResolution(n);
  }

  // Renders the model into rt from cam, in the shared lights-only stage
  renderModel(renderer, rt, cam, overrideMaterial = null) {
    const stage = this.opts.stage;
    stage.overrideMaterial = overrideMaterial;
    stage.add(this.model);
    renderer.setRenderTarget(rt);
    renderer.render(stage, cam);
    renderer.setRenderTarget(null);
    stage.remove(this.model);
    stage.overrideMaterial = null;
  }

  // Returns how many off-screen renders it did this frame (for stats).
  update(renderer, camera, dt) {
    const o = this.opts, m = this.model;

    // Stepped animation: hold each pose, then jump by the time banked since the last step
    this.animAcc += dt;
    const posed = !this.still && (!o.stepped || this.animAcc >= 1 / o.animFps);
    if (posed) { this.mixer.update(this.animAcc); this.animAcc = 0; this.refit(); }
    if (this.still && this.animAcc >= STILL_RELIGHT && (!camera.position.equals(this.litFrom)
      || this.lastLights >>> (this.opts.flashLights.length - PORTAL_LIGHTS))) { this.animAcc = 0; this.lastKey = undefined; } // (a
      // portal's light on it: the last of the flash lights, brightening as it opens)

    const at = this.frozenAt ?? m.position;
    this.blob.position.set(at.x, (this.below ? floorAt(at.x, at.z, at.y) : at.y) + 0.02, at.z); // (under its feet; a flyer's, on the floor)
    this.bounds.visible = o.bounds;

    if (o.real) { // plain 3D model in the main scene, for comparison (blob shadow)
      if (m.parent !== this) this.add(m);
      m.visible = !this.hidden;
      this.card.visible = this.shadowCard.visible = false;
      this.blob.visible = true;
      this.lastKey = this.shadowKey = undefined;
      return 0;
    }
    if (m.parent === this) this.remove(m);
    m.visible = true; // needed for its own off-screen renders
    this.card.visible = !this.hidden;
    this.blob.visible = !o.spriteShadows;
    this.shadowCard.visible = o.spriteShadows;

    const center = _center.copy(at).add(this.fit);
    this.applyLod(camera, center);
    let renders = o.spriteShadows ? this.updateShadow(renderer, center, posed) : (this.shadowKey = undefined, 0); // (off a while: its
    // silhouette may be from before it died)
    if (this.hidden) { this.lastKey = undefined; return renders; } // no card, no sprite render

    // Card: parallel to the image plane, pulled toward the eye and shrunk by the same ratio, so it covers
    // the same pixels but sits in front of the feet (the floor's depth test stops clipping them).
    _cs.copy(center).applyMatrix4(camera.matrixWorldInverse);
    // ...but never closer than 15 cm, or a model right in your face would put its card behind the near plane
    // (behind the camera, d <= 0: s = 1, card stays put behind you instead of mirroring in front of you)
    const d = -_cs.z;
    const s = Math.max(d - this.r * 0.55, Math.min(0.15, d)) / d;
    this.depthU.uProj.value.copy(camera.projectionMatrix);
    this.depthU.uDepthRef.value.x = d;
    this.card.position.copy(center).sub(camera.position).multiplyScalar(s).add(camera.position);
    this.card.scale.setScalar(2 * this.r * s);
    this.card.quaternion.copy(camera.quaternion);
    if (this.frozenAt) return renders; // frozen: same picture, still staring at you

    // Off-screen: skip the texture render, the same saving real meshes get from frustum culling
    _frustum.setFromProjectionMatrix(_vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    if (!_frustum.intersectsSphere(_sphere.set(center, this.r))) { this.lastKey = undefined; return renders; }

    let key = null; // null = view changes continuously, always re-render
    const cam = this.cam;
    if (o.snap) {
      // Doom-style: snap the RT camera to snaps × pitchSnaps views, measured from the model's facing
      _toCam.subVectors(camera.position, center);
      _facing.set(0, 0, 1).applyQuaternion(m.quaternion);
      const yaw = Math.atan2(_facing.x, _facing.z), step = (2 * Math.PI) / o.snaps;
      // frontOnly (a corpse): always the one view, from straight in front of it and CORPSE_ELEVATION up, whichever
      // side you're on and however high (Doom's one-angle bodies)
      const azIdx = this.frontOnly ? 0 : Math.round((Math.atan2(_toCam.x, _toCam.z) - yaw) / step);
      const elStep = Math.PI / 2 / o.pitchSnaps; // rows from 0° up to (not including) 90°: straight down has no "up"
      const elIdx = Math.min(Math.max(Math.round(Math.atan2(_toCam.y, Math.hypot(_toCam.x, _toCam.z)) / elStep), this.below ? 1 - o.pitchSnaps : 0), o.pitchSnaps - 1);
      const az = yaw + azIdx * step + this.frontAz, el = this.frontOnly ? CORPSE_ELEVATION : elIdx * elStep;
      const dist = o.lockDist ? o.distance : _toCam.length();
      cam.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist).add(center);
      cam.lookAt(center);
      // Locked distance + snapped view: the picture only changes when the snap or the pose changes.
      if (o.lockDist) key = ((azIdx % o.snaps) + o.snaps) % o.snaps + o.snaps * (this.frontOnly ? 0 : elIdx); // (a body: one view, at any height)
    } else {
      if (o.lockDist) cam.position.copy(camera.position).sub(center).setLength(o.distance).add(center);
      else cam.position.copy(camera.position);
      cam.quaternion.copy(camera.quaternion);
    }
    const lights = this.lightMask(center);
    if (!posed && key !== null && key === this.lastKey && lights === this.lastLights) return renders; // cached
    this.lastKey = key;
    this.lastLights = lights;

    // Frame the ±r box from the RT camera's own distance: the whole model always fills the texture
    cam.updateMatrixWorld();
    _rc.copy(center).applyMatrix4(cam.matrixWorldInverse);
    const near = SPRITE_NEAR, k = near / -_rc.z, r = this.r;
    cam.projectionMatrix.makePerspective((_rc.x - r) * k, (_rc.x + r) * k, (_rc.y + r) * k, (_rc.y - r) * k, near, SPRITE_FAR);
    this.depthU.uDepthRef.value.y = -_rc.z;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    this.renderModel(renderer, this.rt, cam);
    this.renderedAt = performance.now(); // (for the sprite debug view)
    this.litFrom.copy(camera.position);
    return renders + 1;
  }

  // Bitmask of the stage's flash lights that are on and close enough to light this model.
  // A change means the cached sprite is lit wrong, so it re-renders when a flash starts and when it ends.
  lightMask(center) {
    const ls = this.opts.flashLights ?? [];
    let mask = 0;
    for (let i = 0; i < ls.length; i++) {
      if (ls[i].intensity > 0 && ls[i].position.distanceTo(center) < ls[i].distance + this.r) mask |= 1 << i;
    }
    return mask;
  }

  // Shadow sprite: snapped to `snaps` angles around the model like the main sprite, but from the sun's side.
  // The sun never moves, so it only re-renders when the snap or the pose changes.
  updateShadow(renderer, center, posed) {
    const o = this.opts;
    _dir.copy(o.sun.position).sub(o.sun.target.position).normalize(); // toward the sun
    _facing.set(0, 0, 1).applyQuaternion(this.model.quaternion);
    const yaw = Math.atan2(_facing.x, _facing.z), step = (2 * Math.PI) / o.snaps;
    const idx = Math.round((Math.atan2(_dir.x, _dir.z) - yaw) / step);
    const az = yaw + idx * step, horiz = Math.hypot(_dir.x, _dir.z);
    _dir.set(Math.sin(az) * horiz, _dir.y, Math.cos(az) * horiz); // snapped sun direction, same elevation

    // Card faces the (snapped) sun; Object3D.lookAt points +Z at the target, matching the camera's view axis
    this.shadowCard.position.copy(center);
    this.shadowCard.lookAt(_look.copy(center).add(_dir));
    if (this.frozenAt) return 0;

    // Outside the sun's shadow box: nothing would show, skip
    const sc = o.sun.shadow.camera;
    _frustum.setFromProjectionMatrix(_vp.multiplyMatrices(sc.projectionMatrix, sc.matrixWorldInverse));
    if (!_frustum.intersectsSphere(_sphere.set(center, this.r))) { this.shadowKey = undefined; return 0; }

    const key = ((idx % o.snaps) + o.snaps) % o.snaps;
    if (!posed && key === this.shadowKey) return 0; // cached
    this.shadowKey = key;
    this.shadowCam.position.copy(center).addScaledVector(_dir, 10);
    this.shadowCam.lookAt(center);
    this.shadowCam.updateMatrixWorld();
    this.renderModel(renderer, this.shadowRt, this.shadowCam, this.ownShadow ? null : silhouetteMat); // (ownShadow: a cut body's,
    // from its own material, which leaves its top half out; only the shadow's alpha counts)
    return 1;
  }

  dispose() {
    this.removeFromParent();
    this.rt.dispose();
    this.shadowRt.dispose();
    this.card.material.dispose();
    this.shadowCard.material.dispose();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
  }
}

