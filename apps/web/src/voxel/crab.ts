import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { box, hash01, mat, radialTexture, tint } from './util.ts';

// A voxel hermit crab with a rig: each seat wears a different shell (spiral conch, turban, tall
// whelk, flat moon snail) in its seat colour; eyes on stalks blink and look around; the big claw's
// upper pincer is hinged so it clacks; six legs run a walk cycle while hopping; idle crabs fidget.
// A dazed crab wobbles round under its stars. On the sand under each crab: a soft blob shadow and
// a ring in the seat colour (readable at a glance), plus a pulsing gold aura for the crowned crab.
// Static voxels share one merged, vertex-coloured mesh; only the moving parts are separate.

type Part = [THREE.BufferGeometry, THREE.ColorRepresentation];
const merged = (parts: Part[]): THREE.BufferGeometry => mergeGeometries(parts.map(([g, c]) => tint(g, c)));

const BODY = 0xe0533b, BODY_DARK = 0xa83a28, BELLY = 0xf08a5d;

function shellParts(kind: number, base: THREE.Color): Part[] {
  const c = base.getHex();
  const lite = base.clone().offsetHSL(0, -0.08, 0.16).getHex();
  const dark = base.clone().offsetHSL(0, 0.02, -0.16).getHex();
  const lip = 0xfff1e0;
  switch (kind) {
    case 1: // turban: a round dome in rings, knobbly
      return [
        [box(0.58, 0.2, 0.54, 0, 0.36, -0.1), c], [box(0.5, 0.06, 0.46, 0, 0.48, -0.1), dark],
        [box(0.46, 0.18, 0.42, 0, 0.6, -0.1), lite], [box(0.32, 0.14, 0.3, 0, 0.76, -0.1), c],
        [box(0.16, 0.1, 0.16, 0, 0.87, -0.1), lite],
        [box(0.08, 0.08, 0.08, 0.25, 0.62, -0.1), dark], [box(0.08, 0.08, 0.08, -0.25, 0.62, -0.1), dark], [box(0.08, 0.08, 0.08, 0, 0.62, -0.33), dark],
        [box(0.4, 0.08, 0.06, 0, 0.3, 0.17), lip],
      ];
    case 2: // whelk: tall and pointed, leaning back
      return [
        [box(0.48, 0.26, 0.46, 0, 0.4, -0.08), c], [box(0.42, 0.05, 0.4, 0, 0.55, -0.1), dark],
        [box(0.36, 0.2, 0.34, 0.02, 0.66, -0.14), lite], [box(0.3, 0.05, 0.28, 0.02, 0.78, -0.15), dark],
        [box(0.24, 0.18, 0.22, 0.04, 0.88, -0.19), c], [box(0.16, 0.14, 0.15, 0.05, 1.03, -0.23), lite],
        [box(0.09, 0.12, 0.09, 0.06, 1.15, -0.26), dark],
        [box(0.36, 0.1, 0.06, 0, 0.3, 0.16), lip],
      ];
    case 3: // moon snail: low, wide and round, with a swirl
      return [
        [box(0.64, 0.24, 0.56, 0, 0.38, -0.1), c], [box(0.5, 0.14, 0.44, 0.04, 0.56, -0.12), lite],
        [box(0.28, 0.1, 0.26, 0.1, 0.67, -0.14), c], [box(0.12, 0.06, 0.12, 0.14, 0.74, -0.15), dark],
        [box(0.66, 0.05, 0.08, 0, 0.44, -0.02), dark], [box(0.06, 0.05, 0.4, 0.3, 0.5, -0.12), dark],
        [box(0.44, 0.1, 0.06, 0, 0.3, 0.18), lip],
      ];
    default: // conch: a spiral stack of offset blocks with stripes
      return [
        [box(0.52, 0.34, 0.5, 0, 0.42, -0.08), c], [box(0.53, 0.06, 0.51, 0, 0.46, -0.08), dark],
        [box(0.4, 0.26, 0.4, 0.05, 0.68, -0.12), lite], [box(0.28, 0.2, 0.28, 0.09, 0.88, -0.15), c],
        [box(0.29, 0.05, 0.29, 0.09, 0.9, -0.15), dark], [box(0.15, 0.14, 0.15, 0.12, 1.03, -0.17), lite],
        [box(0.07, 0.1, 0.07, 0.13, 1.14, -0.18), dark],
        [box(0.4, 0.1, 0.06, 0, 0.28, 0.17), lip],
      ];
  }
}

/** A four-pointed star for glints. */
let starTex: THREE.Texture | null = null;
function starTexture(): THREE.Texture {
  if (starTex) return starTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,245,200,0.7)'); gr.addColorStop(1, 'rgba(255,230,150,0)');
  g.fillStyle = gr;
  g.beginPath();
  for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4, r = k % 2 ? 6 : 31; g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); }
  g.fill();
  starTex = new THREE.CanvasTexture(cv);
  starTex.colorSpace = THREE.SRGBColorSpace;
  return starTex;
}
export const glintSprite = (size = 0.5): THREE.Sprite => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: starTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.scale.setScalar(size);
  return s;
};

function makeCrown(): THREE.Group {
  const g = new THREE.Group();
  const m = mat(0xffcc33, 0x6a4a00);
  g.add(new THREE.Mesh(box(0.42, 0.1, 0.42), m));
  for (const [x, z] of [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]]) g.add(new THREE.Mesh(box(0.09, 0.16, 0.09, x, 0.12, z), m));
  g.add(new THREE.Mesh(box(0.1, 0.1, 0.1, 0, 0.1, 0.22), mat(0xfff6ff, 0x553366)));
  return g;
}

export interface CrabPose { hopping: boolean; dazed: boolean; prying: boolean; crowned: boolean }

export class Crab {
  /** placed and turned by the world */
  g = new THREE.Group();
  /** tumbles, bobs and fidgets inside g */
  rig = new THREE.Group();
  /** lies on the sand under the crab (added to the scene by the world) */
  ground = new THREE.Group();
  crown: THREE.Group;
  stars = new THREE.Group();
  clack = 0;
  private jawL: THREE.Group;
  private jawR: THREE.Group;
  private armL: THREE.Group;
  private armR: THREE.Group;
  private eyes: THREE.Group[] = [];
  private legs: { g: THREE.Group; side: number; k: number }[] = [];
  private glint: THREE.Sprite;
  private aura: THREE.Mesh;
  private ring: THREE.Mesh;
  private seed: number;
  private walk = 0;
  private fidget = { next: 1, kind: 0, t: 0 };
  private blink = 3;

  constructor(color: string, seat: number) {
    this.seed = hash01(seat * 977 + 13) * 100;
    const m = new THREE.MeshLambertMaterial({ vertexColors: true });
    const base = new THREE.Color(color);
    const bodyCol = new THREE.Color(BODY).offsetHSL((seat % 4) * 0.012 - 0.018, 0, 0);
    const add = (parent: THREE.Object3D, parts: Part[]): THREE.Mesh => { const mesh = new THREE.Mesh(merged(parts), m); parent.add(mesh); return mesh; };
    this.g.add(this.rig);
    this.rig.scale.setScalar(1.15);
    // shell + body, one mesh
    add(this.rig, [
      ...shellParts(seat % 4, base),
      [box(0.44, 0.18, 0.3, 0, 0.2, 0.14), bodyCol], [box(0.36, 0.06, 0.24, 0, 0.1, 0.14), BELLY],
      [box(0.08, 0.05, 0.05, -0.08, 0.2, 0.3), BODY_DARK], [box(0.08, 0.05, 0.05, 0.08, 0.2, 0.3), BODY_DARK],
    ]);
    // eyes on stalks
    for (const s of [-1, 1]) {
      const e = new THREE.Group();
      e.position.set(s * 0.09, 0.29, 0.25);
      add(e, [[box(0.05, 0.2, 0.05, 0, 0.1, 0), BODY_DARK], [box(0.1, 0.1, 0.1, 0, 0.22, 0), 0xffffff], [box(0.05, 0.05, 0.02, 0, 0.22, 0.055), 0x111111]]);
      this.rig.add(e);
      this.eyes.push(e);
    }
    // claws: a palm and a hinged upper pincer; the left one is the big one
    const claw = (s: number, k: number): [THREE.Group, THREE.Group] => {
      const arm = new THREE.Group();
      arm.position.set(s * 0.22, 0.2, 0.24);
      add(arm, [[box(0.08, 0.07, 0.12, s * 0.02, 0, 0.02), bodyCol], [box(0.2 * k, 0.12 * k, 0.16 * k, s * 0.06, 0.02, 0.12), bodyCol], [box(0.16 * k, 0.05 * k, 0.12 * k, s * 0.06, -0.02, 0.26 * k + 0.02), BODY_DARK]]);
      const jaw = new THREE.Group();
      jaw.position.set(s * 0.06, 0.08 * k, 0.16 * k);
      add(jaw, [[box(0.17 * k, 0.06 * k, 0.16 * k, 0, 0, 0.08 * k), bodyCol], [box(0.06 * k, 0.04 * k, 0.05 * k, 0, -0.03 * k, 0.16 * k), 0xfff1e0]]);
      arm.add(jaw);
      this.rig.add(arm);
      return [arm, jaw];
    };
    [this.armL, this.jawL] = claw(-1, 1.15);
    [this.armR, this.jawR] = claw(1, 0.8);
    // six legs
    for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
      const leg = new THREE.Group();
      leg.position.set(s * 0.2, 0.14, 0.06 + k * 0.09);
      add(leg, [[box(0.18, 0.05, 0.05, s * 0.09, 0, 0), BODY_DARK], [box(0.05, 0.13, 0.05, s * 0.18, -0.05, 0), bodyCol]]);
      this.rig.add(leg);
      this.legs.push({ g: leg, side: s, k });
    }
    this.rig.traverse((o) => { o.castShadow = true; });
    // crown with a glint
    this.crown = makeCrown();
    this.crown.position.y = seat % 4 === 2 ? 1.28 : seat % 4 === 3 ? 0.86 : seat % 4 === 1 ? 0.98 : 1.2;
    this.crown.visible = false;
    this.glint = glintSprite(0.55);
    this.glint.position.set(0, 0.12, 0.24);
    this.crown.add(this.glint);
    this.rig.add(this.crown);
    // dazed stars
    for (let s = 0; s < 3; s++) { const st = new THREE.Mesh(box(0.1, 0.1, 0.1), mat(0xfff27a, 0xaa9900)); st.position.set(Math.cos(s * 2.1) * 0.35, 1.25, Math.sin(s * 2.1) * 0.35); this.stars.add(st); }
    this.stars.visible = false;
    this.g.add(this.stars);
    // on the sand
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(20,30,40,0.45)'), transparent: true, depthWrite: false }));
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.48, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: base, transparent: true, opacity: 0.85, depthWrite: false }));
    this.ring.position.y = 0.005;
    this.aura = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,214,90,0.9)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.aura.position.y = 0.01;
    this.aura.visible = false;
    this.ground.add(blob, this.ring, this.aura);
    this.ground.renderOrder = 3;
  }

  /** Called every frame. */
  animate(dt: number, t: number, p: CrabPose): void {
    const ph = t + this.seed;
    // walk cycle: alternate legs while hopping, settle when still
    this.walk += ((p.hopping ? 1 : 0) - this.walk) * Math.min(1, dt * 12);
    for (const l of this.legs) {
      const a = Math.sin(t * 26 + l.k * 2.1 + (l.side > 0 ? Math.PI : 0)) * 0.55 * this.walk;
      l.g.rotation.z = l.side * (a + Math.sin(ph * 1.3 + l.k) * 0.04);
      l.g.rotation.y = l.side * Math.cos(t * 26 + l.k * 2.1) * 0.25 * this.walk;
    }
    // claws: clack (emote), snip while prying, or a slow idle breath
    if (this.clack > 0) this.clack -= dt;
    const snip = this.clack > 0 || p.prying;
    const open = snip ? (Math.sin(t * 24) * 0.5 + 0.5) * 0.7 : 0.08 + Math.sin(ph * 1.7) * 0.06;
    this.jawL.rotation.x = -open;
    this.jawR.rotation.x = -(snip ? (Math.sin(t * 24 + 1.5) * 0.5 + 0.5) * 0.7 : open * 0.8);
    this.armL.rotation.x = snip ? -0.35 + Math.sin(t * 12) * 0.12 : Math.sin(ph * 1.1) * 0.05;
    this.armR.rotation.x = snip ? -0.3 + Math.sin(t * 12 + 2) * 0.12 : Math.sin(ph * 1.1 + 1) * 0.05;
    // blinking, and idle fidgets: look around, tap a claw, shuffle
    this.blink -= dt;
    const shut = this.blink < 0.12;
    if (this.blink < 0) this.blink = 2 + hash01(Math.floor(ph * 7)) * 3;
    const f = this.fidget;
    f.next -= dt;
    if (f.next < 0 && !p.hopping && !p.dazed) { f.kind = Math.floor(hash01(Math.floor(ph * 13)) * 3); f.t = 0; f.next = 2.5 + hash01(Math.floor(ph * 3)) * 3.5; }
    f.t += dt;
    const fk = f.t < 1.1 ? Math.sin((f.t / 1.1) * Math.PI) : 0;
    let look = 0, shuffle = 0;
    if (f.kind === 0) look = fk * (hash01(Math.floor(f.next * 10)) > 0.5 ? 0.6 : -0.6);
    if (f.kind === 1 && fk > 0 && !snip) this.jawL.rotation.x = -Math.abs(Math.sin(f.t * 18)) * 0.5 * fk;
    if (f.kind === 2) shuffle = Math.sin(f.t * 16) * 0.12 * fk;
    for (const [k, e] of this.eyes.entries()) {
      e.scale.y = shut ? 0.25 : 1;
      e.rotation.y = p.dazed ? Math.sin(t * 9 + k * 3) * 0.8 : look;
      e.rotation.z = Math.sin(ph * 2 + k) * 0.08;
    }
    // body: a little breathing bob, the shuffle, and a dazed wobble
    this.rig.position.y = Math.abs(Math.sin(ph * 3)) * 0.015;
    this.rig.position.x = shuffle;
    if (p.dazed) { this.rig.rotation.y += dt * 5; this.rig.rotation.z = Math.sin(t * 7) * 0.15; }
    else { this.rig.rotation.y *= Math.max(0, 1 - dt * 8); this.rig.rotation.z *= Math.max(0, 1 - dt * 8); }
    this.stars.visible = p.dazed;
    this.stars.rotation.y += dt * 4;
    // the crown, its glint and the aura
    this.crown.visible = p.crowned;
    this.aura.visible = p.crowned;
    if (p.crowned) {
      this.crown.rotation.y = Math.sin(t * 1.2) * 0.3;
      const g = Math.max(0, Math.sin(t * 2.6)) ** 24;
      this.glint.scale.setScalar(0.1 + g * 0.7);
      this.glint.material.rotation = t;
      const s = 1 + Math.sin(t * 3) * 0.08;
      this.aura.scale.set(s, 1, s);
      (this.aura.material as THREE.MeshBasicMaterial).opacity = 0.55 + Math.sin(t * 3) * 0.2;
    }
    (this.ring.material as THREE.MeshBasicMaterial).opacity = p.dazed ? 0.35 : 0.85;
  }

  dispose(): void {
    const seen = new Set<unknown>();
    for (const root of [this.g, this.ground]) root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !seen.has(m.geometry)) { seen.add(m.geometry); m.geometry.dispose(); }
      const mt = m.material as THREE.Material | undefined;
      if (mt && !seen.has(mt)) { seen.add(mt); mt.dispose(); }
    });
  }
}
