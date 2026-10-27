// The stats (the fps; in debug mode, the rest) and the sprite debug view
import { spriteDebug } from './input.js'; // (first: this file runs after that one; see main.js)
import * as THREE from 'three';
import { renderer, fixedScale } from './setup.js';
import { camera, worldScale, opts } from './camera.js';
import { hudScene } from './weapons.js';
import { rayWorld } from './holes.js';
import { npcs, corpses } from './enemies.js';
import { skulls } from './skulls.js';

// --- Benchmark stats: averaged over half-second windows ---
const statsEl = document.getElementById('stats'), fpsEl = document.getElementById('fps'); // fps: always shown (the game's in the works)
let statFrames = 0, statCpu = 0, statSprites = 0, statStart = performance.now();
export function reportStats(cpuMs, sprites) {
  statFrames++; statCpu += cpuMs; statSprites += sprites;
  const now = performance.now();
  if (now - statStart < 500) return;
  const { calls, triangles } = renderer.info.render;
  fpsEl.textContent = `${(statFrames * 1000 / (now - statStart)).toFixed(0)} fps`;
  const count = (k) => npcs.filter((n) => n[k]).length;
  statsEl.textContent = `${count('zombie')} zombies, ${count('police')} police, ${count('demon')} demons + ${skulls.length} skulls, ${corpses.length} dead (${opts.real ? 'REAL 3D' : 'sprites'}) · world 1/${Math.round(1 / worldScale)}${fixedScale ? ' (fixed)' : ''} · ` +
    `${(statFrames * 1000 / (now - statStart)).toFixed(0)} fps · CPU ${(statCpu / statFrames).toFixed(2)} ms/frame · ` +
    `${calls} draw calls · ${(triangles / 1000).toFixed(0)}k tris · ${(statSprites / statFrames).toFixed(1)} sprite renders/frame`;
  statFrames = statCpu = statSprites = 0; statStart = now;
}

// Sprite debug (I, in debug mode): to catch a demon that's vanished. Every demon on screen gets a marker with its
// number (green: nothing between you and it; grey: something is, so not seeing it is right), and the top right shows
// every demon's sprite image as it is now (its number, distance, texture size and how long since it was last drawn under
// it), each on a dark square: an empty square is an empty sprite. Up to SPRITE_DEBUG_MAX of them.
const SPRITE_DEBUG_MAX = 24, SPRITE_DEBUG_COLS = 6, SPRITE_DEBUG_SIZE = 0.11; // demons; columns; of the screen height
const spriteDebugLayer = Object.assign(document.createElement('div'), { style: 'position:fixed;inset:0;pointer-events:none;z-index:40;display:none;font:bold 11px monospace' });
document.body.appendChild(spriteDebugLayer);
const spriteDebugMarks = [], spriteDebugLabels = [], spriteDebugThumbs = [];
const _sdc = new THREE.Vector3(), _sdp = new THREE.Vector3(), _sdd = new THREE.Vector3();
export function updateSpriteDebug() {
  spriteDebugLayer.style.display = spriteDebug ? 'block' : 'none';
  spriteDebugThumbs.forEach((t) => (t.visible = false));
  if (!spriteDebug) return;
  const aspect = innerWidth / innerHeight, h = 2 * SPRITE_DEBUG_SIZE, w = h / aspect; // a thumbnail, in clip units
  npcs.concat(corpses).slice(0, SPRITE_DEBUG_MAX).forEach((n, i) => {
    if (!spriteDebugMarks[i]) { // made on first use
      spriteDebugMarks[i] = spriteDebugLayer.appendChild(Object.assign(document.createElement('div'), { style: 'position:absolute;width:14px;height:14px;border:2px solid' }));
      spriteDebugLabels[i] = spriteDebugLayer.appendChild(Object.assign(document.createElement('div'), { style: 'position:absolute;color:#fff;text-shadow:0 0 2px #000;font-size:10px' }));
      const back = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x202020, depthTest: false, depthWrite: false }));
      const pic = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false }));
      back.renderOrder = 10; pic.renderOrder = 11; back.frustumCulled = pic.frustumCulled = false;
      spriteDebugThumbs.push(back, pic);
      hudScene.add(back, pic);
    }
    // its marker, where its middle is on screen
    const im = n.imp, mark = spriteDebugMarks[i], c = _sdc.copy(im.model.position).add(im.fit), p = _sdp.copy(c).project(camera);
    const dist = c.distanceTo(camera.position), hit = rayWorld(camera.position, _sdd.copy(c).sub(camera.position).normalize());
    const onScreen = p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1;
    mark.style.display = onScreen ? 'block' : 'none';
    mark.style.left = `${(p.x * 0.5 + 0.5) * innerWidth - 9}px`;
    mark.style.top = `${(-p.y * 0.5 + 0.5) * innerHeight - 9}px`;
    mark.style.borderColor = mark.style.color = hit && hit.t < dist - 0.5 ? '#888' : '#3f3';
    mark.textContent = i;
    // its sprite image, in the grid
    const col = i % SPRITE_DEBUG_COLS, row = Math.floor(i / SPRITE_DEBUG_COLS);
    const x = 1 - (col + 0.5) * w * 1.08 - 0.01, y = 1 - (row + 0.5) * h * 1.25 - 0.06;
    const [back, pic] = spriteDebugThumbs.slice(i * 2, i * 2 + 2);
    back.position.set(x, y, 0); back.scale.set(w, h, 1);
    pic.position.set(x, y, 0); pic.scale.set(w, h, 1);
    if (pic.material.map !== im.rt.texture) { pic.material.map = im.rt.texture; pic.material.needsUpdate = true; }
    back.visible = pic.visible = true;
    const label = spriteDebugLabels[i];
    label.style.left = `${(x - w / 2 + 1) * 0.5 * innerWidth}px`;
    label.style.top = `${(1 - (y - h / 2)) * 0.5 * innerHeight}px`;
    const age = im.renderedAt ? (performance.now() - im.renderedAt) / 1000 : Infinity; // s since its sprite was last drawn
    label.textContent = `${i}${n.dead ? '†' : ''} ${dist.toFixed(0)}m ${im.rt.width}px ${age < 10 ? age.toFixed(1) + 's' : '—'}`;
  });
}

