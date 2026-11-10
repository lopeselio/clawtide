import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// The tidal flats, built from voxels: a sandbar of instanced sand blocks on a moving sea, numbers
// painted on dug tiles, urchins, pearls, clams, kelp-flag marks and voxel hermit crabs. The same
// world shows live rounds, the guided tutorial, the title screen's attract mode and rockpool raids.
// Everything is procedural (boxes, instanced where there are many); no model files, no textures
// beyond tiny canvases for digits and names. Pixel ratio is capped and nothing casts shadows, so
// it runs on weak phone GPUs.

/** Tile codes the world understands (same as the rules' views): */
export const W_WATER = -2, W_HIDDEN = -1, W_URCHIN = -3, W_ROCK = -4, W_CACHE = -5;

export interface CrabState { at: number; name: string; color: string; stun: number; pry: number; crowned: boolean; me: boolean; pearls: number }
export interface Frame { tiles: number[]; items: number[]; crabs: CrabState[] }

export const SEAT_COLORS = ['#ff7a59', '#4cc3ff', '#b18cff', '#ffd166'];
const NUM_COLORS = ['', '#1f5fae', '#2a8a4a', '#c4302b', '#2a3f8f', '#8f2a2a', '#1c7a78', '#222222', '#6b6b6b'];

const C = {
  sky: 0x8fd3e8, fog: 0x9fdcec, sea: 0x1f8fb3, seaDeep: 0x13607f, foam: 0xe9fbff,
  sand: 0xf0d398, sandDug: 0xf7e4b8, sandHidden: 0xdcb56f, wet: 0xc79f5f,
  urchin: 0x3b1f52, spine: 0x6c3fa0, pearl: 0xfff6ff, clamA: 0xff9eb5, clamB: 0xffc7d4, rock: 0x7b8794, rockHi: 0x9aa6b2,
  kelp: 0x2f8f4e, flag: 0xff4d6d, hover: 0xffffff, crab: 0xe0533b, crabDark: 0xa83a28, gold: 0xffcc33,
};

const isCoarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}
const mat = (color: THREE.ColorRepresentation, emissive = 0): THREE.MeshLambertMaterial =>
  new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: emissive ? 0.6 : 0 });

/** One canvas-texture plane per digit, shared by every board. */
const digitTex = new Map<number, THREE.Texture>();
function digitTexture(n: number): THREE.Texture {
  let t = digitTex.get(n);
  if (t) return t;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  g.font = '900 50px "Pixelify Sans", "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(255,250,235,.95)';
  g.strokeText(String(n), 32, 35);
  g.fillStyle = NUM_COLORS[n];
  g.fillText(String(n), 32, 35);
  t = new THREE.CanvasTexture(cv);
  t.anisotropy = 4;
  digitTex.set(n, t);
  return t;
}

function labelSprite(text: string, color: string, crowned: boolean): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d')!;
  g.font = '700 26px Inter, sans-serif';
  const w = Math.min(250, g.measureText(text).width + 26);
  g.fillStyle = 'rgba(8,30,45,.72)';
  g.beginPath(); g.roundRect((256 - w) / 2, 10, w, 42, 14); g.fill();
  g.fillStyle = crowned ? '#ffd166' : color;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 32);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
  s.scale.set(2.2, 0.55, 1);
  s.renderOrder = 10;
  return s;
}

// ---------- shared geometry ----------

const urchinGeo = (() => {
  const parts: THREE.BufferGeometry[] = [new THREE.IcosahedronGeometry(0.2, 0).translate(0, 0.2, 0)];
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1], [0.7, 0.7, 0], [-0.7, 0.7, 0], [0, 0.7, 0.7], [0, 0.7, -0.7], [0.7, 0, 0.7], [-0.7, 0, 0.7], [0.7, 0, -0.7], [-0.7, 0, -0.7]];
  for (const [x, y, z] of dirs) {
    const g = new THREE.ConeGeometry(0.035, 0.26, 4);
    const v = new THREE.Vector3(x, y, z).normalize();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v));
    g.translate(v.x * 0.28, 0.2 + v.y * 0.28, v.z * 0.28);
    parts.push(g);
  }
  return mergeGeometries(parts.map((p) => p.toNonIndexed()));
})();
const flagGeo = (() => {
  const stick = box(0.04, 0.6, 0.04, 0, 0.3, 0).toNonIndexed();
  const cloth = box(0.26, 0.18, 0.03, 0.14, 0.5, 0).toNonIndexed();
  return { stick, cloth };
})();
const rockGeo = mergeGeometries([box(0.7, 0.35, 0.6, 0, 0.17, 0), box(0.45, 0.3, 0.45, 0.1, 0.45, -0.05), box(0.3, 0.18, 0.25, -0.18, 0.4, 0.15)].map((g) => g.toNonIndexed()));

// ---------- the crab ----------

function makeCrab(color: string): THREE.Group {
  const g = new THREE.Group();
  const shellM = mat(color), stripeM = mat(new THREE.Color(color).offsetHSL(0, -0.1, 0.18)), bodyM = mat(C.crab), darkM = mat(C.crabDark), eyeM = mat(0xffffff), pupilM = mat(0x111111);
  const add = (geo: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh => { const mesh = new THREE.Mesh(geo, m); g.add(mesh); return mesh; };
  // a spiral conch, voxel by voxel
  add(box(0.52, 0.34, 0.5, 0, 0.42, -0.08), shellM);
  add(box(0.4, 0.26, 0.4, 0.05, 0.68, -0.12), stripeM);
  add(box(0.28, 0.2, 0.28, 0.09, 0.88, -0.15), shellM);
  add(box(0.15, 0.14, 0.15, 0.12, 1.03, -0.17), stripeM);
  // body, claws, eyes on stalks, legs
  add(box(0.44, 0.18, 0.3, 0, 0.2, 0.14), bodyM);
  const clawL = add(box(0.2, 0.15, 0.22, -0.27, 0.22, 0.33), bodyM);
  const clawR = add(box(0.14, 0.11, 0.16, 0.25, 0.2, 0.32), bodyM);
  clawL.name = 'clawL'; clawR.name = 'clawR';
  add(box(0.05, 0.18, 0.05, -0.09, 0.38, 0.25), darkM);
  add(box(0.05, 0.18, 0.05, 0.09, 0.38, 0.25), darkM);
  add(box(0.09, 0.09, 0.09, -0.09, 0.5, 0.26), eyeM);
  add(box(0.09, 0.09, 0.09, 0.09, 0.5, 0.26), eyeM);
  add(box(0.045, 0.045, 0.02, -0.09, 0.5, 0.31), pupilM);
  add(box(0.045, 0.045, 0.02, 0.09, 0.5, 0.31), pupilM);
  for (const s of [-1, 1]) for (let k = 0; k < 3; k++) add(box(0.22, 0.05, 0.05, s * 0.3, 0.1, 0.04 + k * 0.1), darkM);
  return g;
}

function makeCrown(): THREE.Group {
  const g = new THREE.Group();
  const m = mat(C.gold, 0x6a4a00);
  g.add(new THREE.Mesh(box(0.42, 0.1, 0.42), m));
  for (const [x, z] of [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]]) g.add(new THREE.Mesh(box(0.09, 0.16, 0.09, x, 0.12, z), m));
  const gem = new THREE.Mesh(box(0.1, 0.1, 0.1, 0, 0.1, 0.22), mat(0xfff6ff, 0x553366));
  g.add(gem);
  return g;
}

function makeClam(): THREE.Group {
  const g = new THREE.Group();
  const a = mat(C.clamA), b = mat(C.clamB);
  const bottom = new THREE.Group();
  bottom.add(new THREE.Mesh(box(0.62, 0.12, 0.5, 0, 0.06, 0), a));
  for (let k = -2; k <= 2; k++) bottom.add(new THREE.Mesh(box(0.06, 0.13, 0.5, k * 0.12, 0.07, 0), b));
  g.add(bottom);
  const lid = new THREE.Group();
  lid.position.set(0, 0.13, -0.24);
  const lidMesh = new THREE.Group();
  lidMesh.add(new THREE.Mesh(box(0.62, 0.12, 0.5, 0, 0.06, 0.24), a));
  for (let k = -2; k <= 2; k++) lidMesh.add(new THREE.Mesh(box(0.06, 0.14, 0.5, k * 0.12, 0.08, 0.24), b));
  lid.add(lidMesh);
  lid.name = 'lid';
  g.add(lid);
  const pearl = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 1), mat(C.pearl, 0x664466));
  pearl.position.set(0, 0.18, 0.02);
  pearl.name = 'pearl';
  g.add(pearl);
  return g;
}

// ---------- particles ----------

interface Particle { i: number; life: number; max: number; vel: THREE.Vector3; pos: THREE.Vector3; size: number }
class Particles {
  mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private live: Particle[] = [];
  private m = new THREE.Matrix4();
  constructor(scene: THREE.Scene, n = 400) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) { this.free.push(i); this.mesh.setMatrixAt(i, zero); this.mesh.setColorAt(i, new THREE.Color(0xffffff)); }
    scene.add(this.mesh);
  }
  burst(at: THREE.Vector3, color: number, n: number, speed = 2, size = 0.08, life = 0.6): void {
    const col = new THREE.Color(color);
    for (let k = 0; k < n; k++) {
      const i = this.free.pop();
      if (i === undefined) return;
      const a = Math.random() * Math.PI * 2, up = 0.5 + Math.random();
      this.live.push({ i, life, max: life, size: size * (0.6 + Math.random() * 0.8), pos: at.clone(), vel: new THREE.Vector3(Math.cos(a) * speed * Math.random(), up * speed, Math.sin(a) * speed * Math.random()) });
      this.mesh.setColorAt(i, col);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  update(dt: number): void {
    if (!this.live.length) return;
    const keep: Particle[] = [];
    for (const p of this.live) {
      p.life -= dt;
      if (p.life <= 0) { this.mesh.setMatrixAt(p.i, this.m.makeScale(0, 0, 0)); this.free.push(p.i); continue; }
      p.vel.y -= 6 * dt;
      p.pos.addScaledVector(p.vel, dt);
      const s = p.size * (p.life / p.max);
      this.m.makeScale(s, s, s).setPosition(p.pos);
      this.mesh.setMatrixAt(p.i, this.m);
      keep.push(p);
    }
    this.live = keep;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------- the world ----------

interface CrabObj { g: THREE.Group; label: THREE.Sprite | null; labelKey: string; crown: THREE.Group; stars: THREE.Group; from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; arc: number; at: number; spin: number }

export class World {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private sea: THREE.Mesh;
  private seaY = -0.08;
  private seaTarget = -0.08;
  private particles: Particles;
  private clock = new THREE.Clock();
  private boardGroup = new THREE.Group();
  w = 0;
  h = 0;
  private land: number[] = [];
  private tiles: THREE.InstancedMesh | null = null;
  private tileTop: number[] = [];
  private tileGoal: number[] = [];
  private digits: THREE.InstancedMesh[] = [];
  private urchins: THREE.InstancedMesh | null = null;
  private pearls: THREE.InstancedMesh | null = null;
  private flags: THREE.InstancedMesh[] = [];
  private rocks: THREE.InstancedMesh | null = null;
  private clams = new Map<number, THREE.Group>();
  private crabs: CrabObj[] = [];
  private hover: THREE.Mesh;
  private reach: THREE.InstancedMesh;
  private last: Frame | null = null;
  marks = new Set<number>();
  private target = new THREE.Vector3();
  private dist = 16;
  private follow = -1;
  private followK = 0.5;
  private userMovedAt = 0;
  private hoverTile = -1;
  onTap: ((tile: number) => void) | null = null;
  onMark: ((tile: number) => void) | null = null;
  onHover: ((tile: number) => void) | null = null;
  /** tiles one hop from my crab glow faintly (the raid and the tutorial use this) */
  showReach = false;
  private dirty = new Set<string>();

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: !isCoarse, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isCoarse ? 1.5 : 2));
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(40, host.clientWidth / Math.max(1, host.clientHeight), 0.1, 200);
    this.scene.background = new THREE.Color(C.sky);
    this.scene.fog = new THREE.Fog(C.fog, 30, 70);
    this.scene.add(new THREE.HemisphereLight(0xfff4dc, 0x2a6f8a, 1.6));
    const sun = new THREE.DirectionalLight(0xfff0d0, 1.6);
    sun.position.set(-8, 14, 10);
    this.scene.add(sun);

    const seaGeo = new THREE.PlaneGeometry(120, 120, 48, 48);
    seaGeo.rotateX(-Math.PI / 2);
    this.sea = new THREE.Mesh(seaGeo, new THREE.MeshLambertMaterial({ color: C.sea, transparent: true, opacity: 0.92, flatShading: true }));
    this.sea.position.y = this.seaY;
    this.scene.add(this.sea);
    const deep = new THREE.Mesh(new THREE.PlaneGeometry(120, 120).rotateX(-Math.PI / 2), mat(C.seaDeep));
    deep.position.y = -0.7;
    this.scene.add(deep);
    this.scene.add(this.boardGroup);
    this.particles = new Particles(this.scene);

    this.hover = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.06, 1.02), new THREE.MeshBasicMaterial({ color: C.hover, transparent: true, opacity: 0.35, depthWrite: false }));
    this.hover.visible = false;
    this.scene.add(this.hover);
    this.reach = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 0.04, 0.9), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }), 8);
    this.reach.count = 0;
    this.scene.add(this.reach);

    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(host);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- coordinates ----------

  pos(i: number, y = 0): THREE.Vector3 {
    const x = i % this.w, z = Math.floor(i / this.w);
    return new THREE.Vector3(x - this.w / 2 + 0.5, y, z - this.h / 2 + 0.5);
  }
  private tileAt(clientX: number, clientY: number): number {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.2), hit)) return -1;
    const x = Math.floor(hit.x + this.w / 2), z = Math.floor(hit.z + this.h / 2);
    if (x < 0 || z < 0 || x >= this.w || z >= this.h) return -1;
    const i = z * this.w + x;
    return this.land[i] ? i : -1;
  }

  // ---------- building a board ----------

  setBoard(w: number, h: number, land: number[]): void {
    this.clearBoard();
    this.w = w; this.h = h; this.land = land.slice();
    this.last = null;
    this.marks.clear();
    this.follow = -1;
    const n = w * h;
    const tileGeo = new THREE.BoxGeometry(0.98, 1, 0.98);
    this.tiles = new THREE.InstancedMesh(tileGeo, new THREE.MeshLambertMaterial(), n);
    this.tileTop = new Array(n).fill(0.34);
    this.tileGoal = this.tileTop.slice();
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      if (!land[i]) { this.tiles.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0)); this.tiles.setColorAt(i, col.set(0)); continue; }
      this.setTileMatrix(i);
      this.tiles.setColorAt(i, col.set(this.shore(i) ? C.wet : C.sandHidden).offsetHSL(0, 0, ((i * 7919) % 13) / 260 - 0.025));
    }
    this.boardGroup.add(this.tiles);
    this.digits = [];
    for (let d = 1; d <= 8; d++) {
      const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.78, 0.78).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: digitTexture(d), transparent: true, depthWrite: false }), n);
      m.count = 0;
      m.renderOrder = 2;
      this.digits.push(m);
      this.boardGroup.add(m);
    }
    this.urchins = new THREE.InstancedMesh(urchinGeo, mat(C.urchin, 0x2a0f40), n);
    this.urchins.count = 0;
    this.boardGroup.add(this.urchins);
    this.pearls = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.15, 1), mat(C.pearl, 0x5a4a6a), n);
    this.pearls.count = 0;
    this.boardGroup.add(this.pearls);
    this.rocks = new THREE.InstancedMesh(rockGeo, mat(C.rock), n);
    this.rocks.count = 0;
    this.boardGroup.add(this.rocks);
    this.flags = [new THREE.InstancedMesh(flagGeo.stick, mat(C.kelp), n), new THREE.InstancedMesh(flagGeo.cloth, mat(C.flag, 0x550010), n)];
    for (const f of this.flags) { f.count = 0; this.boardGroup.add(f); }
    // foam around the sand
    const foam = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.03, 1), new THREE.MeshBasicMaterial({ color: C.foam, transparent: true, opacity: 0.45 }), n);
    let f = 0;
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      if (land[i]) continue;
      const x = i % w, z = Math.floor(i / w);
      let near = false;
      for (let dz = -1; dz <= 1 && !near; dz++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, zz = z + dz; if (xx >= 0 && zz >= 0 && xx < w && zz < h && land[zz * w + xx]) { near = true; break; } }
      if (near) { m4.makeTranslation(x - w / 2 + 0.5, -0.04, z - h / 2 + 0.5); foam.setMatrixAt(f++, m4); }
    }
    foam.count = f;
    foam.name = 'foam';
    this.boardGroup.add(foam);
    const fit = Math.max(w / Math.max(0.4, this.camera.aspect) * 1.45, h * 1.9);
    const cap = isCoarse ? 22 : 34;
    this.dist = THREE.MathUtils.clamp(fit, 13, cap);
    // when the whole sandbar fits on screen the camera stays put; otherwise it follows you
    this.followK = fit > cap ? 0.85 : 0.08;
    this.target.set(0, 0, 0);
    this.seaY = -0.8; this.seaTarget = -0.08; // the sandbar rises out of the sea
  }

  private shore(i: number): boolean {
    const x = i % this.w, z = Math.floor(i / this.w);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, zz = z + dz;
      if (xx < 0 || zz < 0 || xx >= this.w || zz >= this.h || !this.land[zz * this.w + xx]) return true;
    }
    return false;
  }

  private setTileMatrix(i: number): void {
    const top = this.tileTop[i];
    const p = this.pos(i);
    this.tiles!.setMatrixAt(i, new THREE.Matrix4().makeScale(1, top + 0.7, 1).setPosition(p.x, (top - 0.7) / 2, p.z));
  }

  private clearBoard(): void {
    for (const c of [...this.boardGroup.children]) {
      this.boardGroup.remove(c);
      if (c instanceof THREE.InstancedMesh) { c.dispose(); if (c.geometry !== urchinGeo && c.geometry !== rockGeo && c.geometry !== flagGeo.stick && c.geometry !== flagGeo.cloth) c.geometry.dispose(); }
    }
    for (const c of this.crabs) this.scene.remove(c.g);
    this.crabs = [];
    this.clams.clear();
    this.tiles = null;
  }

  // ---------- updating from a view ----------

  update(f: Frame): void {
    if (!this.tiles) return;
    const prev = this.last;
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    const counts = new Array(9).fill(0);
    let u = 0, p = 0, r = 0;
    const t = this.clock.elapsedTime;
    for (let i = 0; i < f.tiles.length; i++) {
      const v = f.tiles[i];
      if (v === W_WATER) continue;
      const dug = v >= 0 || v === W_URCHIN || v === W_CACHE;
      const goal = v === W_ROCK ? 0.12 : dug ? 0.12 : 0.34;
      if (this.tileGoal[i] !== goal) {
        this.tileGoal[i] = goal;
        this.tiles.setColorAt(i, col.set(dug || v === W_ROCK ? C.sandDug : this.shore(i) ? C.wet : C.sandHidden).offsetHSL(0, 0, ((i * 7919) % 13) / 300 - 0.02));
        if (this.tiles.instanceColor) this.tiles.instanceColor.needsUpdate = true;
        if (prev && dug && prev.tiles[i] === W_HIDDEN) this.particles.burst(this.pos(i, 0.35), C.sand, 3, 1.5, 0.08, 0.45);
      }
      const at = this.pos(i, 0.125);
      if (v >= 1 && v <= 8) { m4.makeTranslation(at.x, at.y, at.z); this.digits[v - 1].setMatrixAt(counts[v]++, m4); }
      if (v === W_URCHIN) {
        m4.makeRotationY(i).setPosition(at.x, 0.12, at.z);
        this.urchins!.setMatrixAt(u++, m4);
        if (prev && prev.tiles[i] !== W_URCHIN) this.particles.burst(this.pos(i, 0.4), C.spine, 14, 3, 0.09, 0.7);
      }
      if (v === W_ROCK) { m4.makeRotationY((i % 4) * 1.3).setPosition(at.x, 0.12, at.z); this.rocks!.setMatrixAt(r++, m4); }
      if (f.items[i] === 2) { m4.makeTranslation(at.x, 0.3 + Math.sin(t * 3 + i) * 0.04, at.z); this.pearls!.setMatrixAt(p++, m4); }
      const clamHere = f.items[i] === 3 || v === W_CACHE;
      if (clamHere && !this.clams.has(i)) {
        const c = makeClam();
        c.position.copy(this.pos(i, 0.12));
        if (v === W_CACHE) c.scale.setScalar(1.35);
        this.clams.set(i, c);
        this.boardGroup.add(c);
      } else if (!clamHere && this.clams.has(i)) {
        const c = this.clams.get(i)!;
        this.boardGroup.remove(c);
        this.clams.delete(i);
        this.particles.burst(this.pos(i, 0.4), 0xffffff, 18, 2.6, 0.07, 0.8);
        this.particles.burst(this.pos(i, 0.4), C.clamA, 10, 2, 0.08, 0.6);
      }
    }
    for (let d = 1; d <= 8; d++) { this.digits[d - 1].count = counts[d]; this.digits[d - 1].instanceMatrix.needsUpdate = true; }
    this.urchins!.count = u; this.urchins!.instanceMatrix.needsUpdate = true;
    this.pearls!.count = p; this.pearls!.instanceMatrix.needsUpdate = true;
    this.rocks!.count = r; this.rocks!.instanceMatrix.needsUpdate = true;
    // picked-up pearls sparkle
    if (prev) for (let i = 0; i < f.items.length; i++) if (prev.items[i] === 2 && f.items[i] !== 2) this.particles.burst(this.pos(i, 0.35), C.pearl, 8, 1.8, 0.06, 0.5);
    this.syncMarks(f);
    this.syncCrabs(f, prev);
    this.last = f;
  }

  private syncMarks(f: Frame): void {
    let k = 0;
    const m4 = new THREE.Matrix4();
    for (const i of this.marks) {
      if (f.tiles[i] !== W_HIDDEN) { this.marks.delete(i); continue; }
      const p = this.pos(i, 0.34);
      m4.makeTranslation(p.x - 0.1, p.y, p.z);
      this.flags[0].setMatrixAt(k, m4);
      this.flags[1].setMatrixAt(k, m4);
      k++;
    }
    for (const fl of this.flags) { fl.count = k; fl.instanceMatrix.needsUpdate = true; }
  }

  toggleMark(i: number): boolean {
    if (!this.last || this.last.tiles[i] !== W_HIDDEN) return false;
    if (this.marks.has(i)) this.marks.delete(i); else this.marks.add(i);
    this.syncMarks(this.last);
    return true;
  }

  private syncCrabs(f: Frame, prev: Frame | null): void {
    while (this.crabs.length < f.crabs.length) {
      const k = this.crabs.length;
      const c = f.crabs[k];
      const g = makeCrab(c.color);
      const crown = makeCrown();
      crown.position.y = 1.18;
      crown.visible = false;
      g.add(crown);
      const stars = new THREE.Group();
      for (let s = 0; s < 3; s++) { const st = new THREE.Mesh(box(0.1, 0.1, 0.1), mat(0xfff27a, 0xaa9900)); st.position.set(Math.cos(s * 2.1) * 0.35, 1.25, Math.sin(s * 2.1) * 0.35); stars.add(st); }
      stars.visible = false;
      g.add(stars);
      const at = this.pos(c.at, this.tileTop[c.at] ?? 0.12);
      g.position.copy(at);
      this.scene.add(g);
      this.crabs.push({ g, label: null, labelKey: '', crown, stars, from: at.clone(), to: at.clone(), t: 1, dur: 0.3, arc: 0.3, at: c.at, spin: 0 });
    }
    f.crabs.forEach((c, k) => {
      const o = this.crabs[k];
      if (c.at !== o.at) {
        const stung = c.stun > 0 && (!prev || prev.crabs[k]?.stun === 0);
        o.from = o.g.position.clone();
        o.to = this.pos(c.at, 0.12);
        o.t = 0;
        o.dur = stung ? 0.9 : 0.28;
        o.arc = stung ? 3.2 : 0.35;
        o.spin = stung ? 4 * Math.PI : 0;
        const dx = o.to.x - o.from.x, dz = o.to.z - o.from.z;
        // crabs scuttle sideways
        if (!stung && (dx || dz)) o.g.rotation.y = Math.atan2(dx, dz) + Math.PI / 2;
        o.at = c.at;
      }
      o.crown.visible = c.crowned;
      o.stars.visible = c.stun > 0;
      o.g.userData.pry = c.pry;
      const key = `${c.name}|${c.pearls}|${c.crowned}|${c.me}`;
      if (key !== o.labelKey) {
        if (o.label) { o.g.remove(o.label); o.label.material.map?.dispose(); o.label.material.dispose(); }
        o.label = labelSprite(`${c.me ? '▸ ' : ''}${c.name} · ${c.pearls}`, c.color, c.crowned);
        o.label.position.y = c.crowned ? 1.95 : 1.7;
        o.g.add(o.label);
        o.labelKey = key;
      }
      if (c.me) this.follow = k;
    });
  }

  /** The crab that just got stung bursts spines where it stepped. */
  fx(kind: 'sting' | 'clam' | 'pearl' | 'pinch' | 'splash' | 'emote', tile: number, seat = -1): void {
    const p = this.pos(tile, 0.4);
    if (kind === 'sting') this.particles.burst(p, C.spine, 16, 3.2, 0.1, 0.8);
    if (kind === 'clam') this.particles.burst(p, C.gold, 16, 3, 0.08, 0.9);
    if (kind === 'pinch') this.particles.burst(p, C.gold, 10, 2, 0.07, 0.6);
    if (kind === 'emote' && seat >= 0 && this.crabs[seat]) {
      const g = this.crabs[seat].g;
      g.userData.clack = 0.8;
      this.particles.burst(g.position.clone().setY(1.2), 0xffffff, 6, 1.4, 0.06, 0.5);
    }
  }

  /** The tide comes in and swallows the sandbar. */
  tide(): void { this.seaTarget = 0.9; }

  focus(tile: number): void { if (tile >= 0) { const p = this.pos(tile); this.target.set(p.x, 0, p.z); } }
  recenter(): void { this.userMovedAt = 0; }

  // ---------- input ----------

  private bindInput(): void {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    const pts = new Map<number, { x: number; y: number; sx: number; sy: number; t: number }>();
    let moved = false, pinch0 = 0, dist0 = 0, longTimer = 0, longFired = false;
    const clearLong = (): void => { if (longTimer) { clearTimeout(longTimer); longTimer = 0; } };
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
      moved = false; longFired = false;
      if (pts.size === 1) {
        clearLong();
        longTimer = window.setTimeout(() => {
          if (moved || pts.size !== 1) return;
          longFired = true;
          const tile = this.tileAt(e.clientX, e.clientY);
          if (tile >= 0) { this.onMark?.(tile); navigator.vibrate?.(20); }
        }, 450);
      }
      if (pts.size === 2) {
        clearLong();
        const [a, b] = [...pts.values()];
        pinch0 = Math.hypot(a.x - b.x, a.y - b.y); dist0 = this.dist;
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') { const t = this.tileAt(e.clientX, e.clientY); if (t !== this.hoverTile) { this.hoverTile = t; this.onHover?.(t); } }
        return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (Math.hypot(p.x - p.sx, p.y - p.sy) > 9) { moved = true; clearLong(); }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch0 > 0) this.dist = THREE.MathUtils.clamp(dist0 * (pinch0 / d), 5, 40);
        this.pan(dx / 2, dy / 2);
      } else if (moved) this.pan(dx, dy);
      if (e.pointerType === 'mouse') { const t = this.tileAt(e.clientX, e.clientY); if (t !== this.hoverTile) { this.hoverTile = t; this.onHover?.(t); } }
    });
    const up = (e: PointerEvent): void => {
      const p = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      clearLong();
      if (!p || pts.size > 0) return;
      if (!moved && !longFired && performance.now() - p.t < 600) {
        const tile = this.tileAt(e.clientX, e.clientY);
        if (tile >= 0) this.onTap?.(tile);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); clearLong(); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const tile = this.tileAt(e.clientX, e.clientY);
      if (tile >= 0) this.onMark?.(tile);
    });
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.dist = THREE.MathUtils.clamp(this.dist * (1 + Math.sign(e.deltaY) * 0.1), 5, 40); }, { passive: false });
    el.addEventListener('pointerleave', () => { this.hoverTile = -1; this.onHover?.(-1); });
  }

  private pan(dx: number, dy: number): void {
    const k = this.dist / Math.max(300, this.host.clientHeight) * 1.1;
    this.target.x -= dx * k;
    this.target.z -= dy * k * 1.3;
    const lim = Math.max(this.w, this.h) / 2 + 2;
    this.target.x = THREE.MathUtils.clamp(this.target.x, -lim, lim);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -lim, lim);
    this.userMovedAt = performance.now();
  }

  hovered(): number { return this.hoverTile; }

  // ---------- per frame ----------

  private resize(): void {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    // sea: gentle swell, and the tide
    this.seaY += (this.seaTarget - this.seaY) * Math.min(1, dt * (this.seaTarget > 0 ? 0.9 : 2));
    this.sea.position.y = this.seaY;
    const pa = this.sea.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) pa.setY(i, Math.sin(pa.getX(i) * 0.6 + t * 1.3) * 0.05 + Math.cos(pa.getZ(i) * 0.7 + t) * 0.04);
    pa.needsUpdate = true;
    if (this.sea.geometry.attributes.normal) this.sea.geometry.computeVertexNormals();
    // tiles settle towards their height (digging sinks them)
    if (this.tiles) {
      let changed = false;
      for (let i = 0; i < this.tileTop.length; i++) {
        if (!this.land[i] || this.tileTop[i] === this.tileGoal[i]) continue;
        const d = this.tileGoal[i] - this.tileTop[i];
        this.tileTop[i] = Math.abs(d) < 0.01 ? this.tileGoal[i] : this.tileTop[i] + d * Math.min(1, dt * 14);
        this.setTileMatrix(i);
        changed = true;
      }
      if (changed) this.tiles.instanceMatrix.needsUpdate = true;
      // pearls bob
      if (this.last && this.pearls && this.pearls.count) {
        const m4 = new THREE.Matrix4();
        let p = 0;
        this.last.items.forEach((it, i) => { if (it === 2) { const at = this.pos(i); m4.makeRotationY(t + i).setPosition(at.x, 0.3 + Math.sin(t * 3 + i) * 0.05, at.z); this.pearls!.setMatrixAt(p++, m4); } });
        this.pearls.instanceMatrix.needsUpdate = true;
      }
    }
    // clams: the lid opens as a crab pries
    const pry = new Map<number, number>();
    if (this.last) this.last.crabs.forEach((c) => { if (this.clams.has(c.at)) pry.set(c.at, Math.max(pry.get(c.at) ?? 0, c.pry)); });
    for (const [i, c] of this.clams) {
      const lid = c.getObjectByName('lid')!;
      const goal = -(Math.min(1, (pry.get(i) ?? 0) / 18)) * 1.1 - (this.last?.tiles[i] === W_CACHE ? 0.5 : 0);
      lid.rotation.x += (goal - lid.rotation.x) * Math.min(1, dt * 10);
      const pearl = c.getObjectByName('pearl')!;
      pearl.visible = lid.rotation.x < -0.2;
      pearl.position.y = 0.18 + Math.sin(t * 4) * 0.02;
    }
    // crabs: hops are little arcs; a sting is a big tumbling fling back to the shore
    for (const o of this.crabs) {
      if (o.t < 1) {
        o.t = Math.min(1, o.t + dt / o.dur);
        const e = o.t;
        o.g.position.lerpVectors(o.from, o.to, e);
        o.g.position.y = o.from.y + (o.to.y - o.from.y) * e + Math.sin(Math.PI * e) * o.arc;
        if (o.spin) o.g.rotation.x = o.spin * e;
        if (o.t >= 1) { o.g.rotation.x = 0; if (o.spin) this.particles.burst(o.g.position.clone(), C.sand, 8, 2, 0.08, 0.5); }
      } else {
        const p = this.pos(o.at, 0.12);
        o.g.position.y = p.y + Math.abs(Math.sin(t * 6 + o.at)) * 0.02;
      }
      const clack = (o.g.userData.clack as number) ?? 0;
      const pr = (o.g.userData.pry as number) ?? 0;
      const clawL = o.g.getObjectByName('clawL')!, clawR = o.g.getObjectByName('clawR')!;
      const wave = clack > 0 || pr > 0 ? Math.sin(t * 22) * 0.25 : Math.sin(t * 2 + o.at) * 0.04;
      clawL.position.y = 0.0 + wave; clawR.position.y = 0.0 - wave;
      if (clack > 0) o.g.userData.clack = clack - dt;
      o.stars.rotation.y += dt * 4;
      o.crown.rotation.y += dt * 1.2;
    }
    // camera: follow my crab unless the player has panned recently
    if (this.follow >= 0 && this.crabs[this.follow] && performance.now() - this.userMovedAt > 2500) {
      const g = this.crabs[this.follow].g.position;
      const k = Math.min(1, dt * 2.5);
      // small sandbars stay centred; big ones follow you further
      const f = this.followK;
      this.target.x += (g.x * f - this.target.x) * k;
      this.target.z += (g.z * f - this.target.z) * k;
    }
    const pitch = 0.98;
    this.camera.position.set(this.target.x, Math.sin(pitch) * this.dist, this.target.z + Math.cos(pitch) * this.dist);
    this.camera.lookAt(this.target.x, 0, this.target.z - 0.4);
    // hover and reach hints
    if (this.hoverTile >= 0 && this.last && this.last.tiles[this.hoverTile] !== W_WATER) {
      this.hover.visible = true;
      this.hover.position.copy(this.pos(this.hoverTile, (this.tileTop[this.hoverTile] ?? 0.12) + 0.03));
    } else this.hover.visible = false;
    this.reach.count = 0;
    if (this.showReach && this.last && this.follow >= 0) {
      const me = this.last.crabs[this.follow];
      if (me && !me.stun) {
        const x = me.at % this.w, z = Math.floor(me.at / this.w);
        const m4 = new THREE.Matrix4();
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const xx = x + dx, zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= this.w || zz >= this.h) continue;
          const i = zz * this.w + xx;
          const v = this.last.tiles[i];
          if (v === W_WATER || v === W_ROCK || v === W_URCHIN) continue;
          const p = this.pos(i, (this.tileTop[i] ?? 0.12) + 0.03);
          m4.makeTranslation(p.x, p.y, p.z);
          this.reach.setMatrixAt(this.reach.count++, m4);
        }
        this.reach.instanceMatrix.needsUpdate = true;
        (this.reach.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(t * 4) * 0.08;
      }
    }
    this.particles.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
