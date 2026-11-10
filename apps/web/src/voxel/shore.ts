import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MARGIN, type Field } from './sea.ts';
import { box, hash01, isCoarse, shadedBox, swayMaterial, tint } from './util.ts';

// Around every sandbar: a shelf of wet sand stepping down under the shallows (so the shape reads
// as an island, not a cut-out), and small shore details placed by a stable hash of the tile:
// shells, pebbles, starfish, swaying seaweed and the odd piece of driftwood. Every kind is one
// instanced mesh with baked vertex colours.

const merge = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));

const SHELL = merge([
  tint(box(0.16, 0.05, 0.12, 0, 0.025, 0), 0xffc2cf), tint(box(0.03, 0.06, 0.13, -0.05, 0.03, 0), 0xffe3ea),
  tint(box(0.03, 0.06, 0.13, 0.05, 0.03, 0), 0xffe3ea), tint(box(0.06, 0.04, 0.04, 0, 0.02, -0.08), 0xf29bb0),
]);
const SHELL2 = merge([tint(box(0.11, 0.08, 0.11, 0, 0.04, 0), 0xf6efe2), tint(box(0.07, 0.07, 0.07, 0.02, 0.1, 0.01), 0xe8d9c0), tint(box(0.04, 0.05, 0.04, 0.03, 0.15, 0.02), 0xd9c3a3)]);
const PEBBLES = merge([tint(box(0.16, 0.08, 0.13, 0, 0.04, 0), 0x8d969e), tint(box(0.1, 0.07, 0.1, 0.13, 0.035, 0.08), 0xa9b1b8), tint(box(0.08, 0.06, 0.07, -0.1, 0.03, 0.1), 0x75808a)]);
const STAR = merge([tint(box(0.3, 0.04, 0.07, 0, 0.02, 0), 0xff8a4c), tint(box(0.07, 0.04, 0.3, 0, 0.02, 0), 0xff8a4c), tint(box(0.08, 0.05, 0.08, 0, 0.03, 0), 0xffb07a)]);
const WEED = merge([
  tint(box(0.05, 0.5, 0.05, 0, 0.25, 0), 0x2f8f4e), tint(box(0.05, 0.38, 0.05, 0.1, 0.19, 0.05), 0x3fa860),
  tint(box(0.05, 0.62, 0.05, -0.08, 0.31, -0.04), 0x2a7d45), tint(box(0.09, 0.05, 0.03, 0.03, 0.44, 0), 0x56c070),
]);
const DRIFT = merge([
  tint(box(1.3, 0.14, 0.16, 0, 0.07, 0), 0x9c7a55), tint(box(0.3, 0.1, 0.1, 0.45, 0.1, 0.16), 0x8a6a48),
  tint(box(0.16, 0.18, 0.2, -0.66, 0.09, 0), 0x7a5c3e), tint(box(1.0, 0.03, 0.17, 0.05, 0.15, 0), 0xb89970),
]);

export class Shore {
  group = new THREE.Group();
  constructor(parent: THREE.Object3D) { parent.add(this.group); }

  clear(): void {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      if (c instanceof THREE.InstancedMesh) { c.dispose(); (c.material as THREE.Material).dispose(); if (c.userData.ownGeo) c.geometry.dispose(); }
    }
  }

  build(w: number, h: number, f: Field, rocky: boolean): void {
    this.clear();
    const { gw, gh, dist, land } = f;
    const ox = -w / 2 - MARGIN + 0.5, oz = -h / 2 - MARGIN + 0.5;
    // the shelf: two steps down from the shore
    const shelfTiles: number[] = [];
    for (let i = 0; i < gw * gh; i++) if (!land[i] && dist[i] <= 2) shelfTiles.push(i);
    const shelf = new THREE.InstancedMesh(shadedBox(1, 1, 1, 1, 0.78, 0.55), new THREE.MeshLambertMaterial({ vertexColors: true }), shelfTiles.length);
    shelf.userData.ownGeo = true;
    const m4 = new THREE.Matrix4(), col = new THREE.Color(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const tops = [0, -0.15, -0.36];
    shelfTiles.forEach((i, k) => {
      const d = dist[i], top = tops[d] - hash01(i) * 0.05;
      m4.makeScale(1, top + 1.2, 1).setPosition(ox + (i % gw), (top - 1.2) / 2, oz + Math.floor(i / gw));
      shelf.setMatrixAt(k, m4);
      shelf.setColorAt(k, col.set(rocky ? 0xa29d8c : 0xe2c48e).offsetHSL(0, -0.03 * d, -0.05 * d + hash01(i + 7) * 0.03));
    });
    shelf.receiveShadow = true;
    this.group.add(shelf);

    // details on the first two steps
    const kinds = [
      { geo: SHELL, at: [] as number[][], sway: false },
      { geo: SHELL2, at: [] as number[][], sway: false },
      { geo: PEBBLES, at: [] as number[][], sway: false },
      { geo: STAR, at: [] as number[][], sway: false },
      { geo: WEED, at: [] as number[][], sway: true },
      { geo: DRIFT, at: [] as number[][], sway: false },
    ];
    let drift = 0;
    const want = isCoarse ? 0.16 : 0.24;
    for (const i of shelfTiles) {
      const d = dist[i];
      if (d > 2) continue;
      const r = hash01(i * 31 + w * 7 + h), r2 = hash01(i * 17 + 3);
      if (r > want) continue;
      const x = ox + (i % gw) + (r2 - 0.5) * 0.5, z = oz + Math.floor(i / gw) + (hash01(i + 99) - 0.5) * 0.5, y = tops[d];
      let k: number;
      if (d === 1 && drift < 2 && r2 > 0.93) { k = 5; drift++; }
      else if (d === 2) k = r2 < 0.6 ? 4 : 2;
      else k = r2 < 0.25 ? 0 : r2 < 0.42 ? 1 : r2 < 0.62 ? 2 : r2 < 0.74 ? 3 : 4;
      kinds[k].at.push([x, y, z, r2 * 6.283]);
    }
    for (const kd of kinds) {
      if (!kd.at.length) continue;
      const m = kd.sway ? swayMaterial({ vertexColors: true }, 0.06, 1.3) : new THREE.MeshLambertMaterial({ vertexColors: true });
      const im = new THREE.InstancedMesh(kd.geo, m, kd.at.length);
      kd.at.forEach(([x, y, z, a], j) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
        s.setScalar(0.85 + hash01(j + Math.round(x * 13)) * 0.4);
        m4.compose(p.set(x, y, z), q, s);
        im.setMatrixAt(j, m4);
      });
      im.castShadow = true;
      this.group.add(im);
    }
  }
}
