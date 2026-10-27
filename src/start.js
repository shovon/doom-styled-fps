// Loading the models: then the gun's set up, and on your first click the enemies come
import { findFootfalls, addNpcs } from './enemies.js'; // (first: this file runs after that one; see main.js)
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ENEMIES, KINDS } from './setup.js';
import { firstClick, opts } from './camera.js';
import { setupGun } from './weapons.js';
import { shellModel, bakeCasings } from './casings.js';
import { SKULLS, addSkulls } from './skulls.js';
import { markTopHalf } from './gibs.js';

const loader = new GLTFLoader();
const enemyFiles = ENEMIES.flatMap((k) => KINDS[k].files);
Promise.all([
  loader.loadAsync('models/m4/scene.gltf'), loader.loadAsync('models/bullet_case/scene.gltf'),
  loader.loadAsync('models/pistol/pistol.glb'), loader.loadAsync('models/super_shotgun/super_shotgun.glb'),
  loader.loadAsync('models/skull.glb'), ...enemyFiles.map((f) => loader.loadAsync(f)),
]).then(([m4, bulletCase, pistol, shotgun, skull, ...enemyGltfs]) => {
  const brass = bulletCase.scene.getObjectByName('pCylinder3');
  bakeCasings(brass, 'rifle');
  bakeCasings(brass, 'pistol');
  bakeCasings(shellModel(), 'shell');
  for (const k of ENEMIES) {
    const kind = KINDS[k], [enemy, ...more] = enemyGltfs.splice(0, kind.files.length);
    if (k === 'demon') {
      const [demonWalk, demonDeath] = more;
      // demon_walk.glb: Mixamo "Orc Walk" retargeted onto the demon rig in Blender; replaces the built-in Walk
      enemy.animations = enemy.animations.filter((c) => c.name !== 'Walk').concat(demonWalk.animations);
      // demon_death.glb: Mixamo "Death From Back Headshot" retargeted the same way, grounded by the mesh
      enemy.animations.push(...demonDeath.animations);
    }
    kind.gltf = enemy;
    kind.footfalls = {};
    for (const name of [kind.rig.walk, kind.rig.aimWalk, kind.rig.run]) if (name) kind.footfalls[name] = findFootfalls(enemy, name, kind.rig.feet);
    markTopHalf(enemy.scene); // (for cutBody)
  }
  setupGun(m4, { pistol: pistol.scene, shotgun: shotgun.scene });
  // ?n=100 spawns 100 enemies (default 8, dealt out between the kinds), ?skulls=n that many skulls (default SKULLS), ?real starts in real-3D mode
  const params = new URLSearchParams(location.search);
  firstClick.then(() => { // (not till you first click to play: else they were on you while the page sat waiting)
    addNpcs(params.has('n') ? Number(params.get('n')) : 8);
    addSkulls(skull, params.has('skulls') ? Number(params.get('skulls')) : SKULLS);
  });
  opts.real = params.has('real');
});

