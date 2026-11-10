import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MoodState, moodFor } from './voxel/mood.ts';
import { Sea, MARGIN, buildField, type Field } from './voxel/sea.ts';
import { Crab, glintSprite } from './voxel/crab.ts';
import { Glints, Particles, Rings, glowTexture } from './voxel/fx.ts';
import { Shore } from './voxel/shore.ts';
import { box, hash01, isCoarse, mat, radialTexture, shadedBox, swayMaterial, swayTime, tint } from './voxel/util.ts';

// The tidal flats, built from voxels: a sandbar of instanced sand blocks on a moving sea, numbers
// painted on dug tiles, urchins, pearls, clams, kelp-flag marks and voxel hermit crabs. The same
// world shows live rounds, the guided tutorial, the title screen's attract mode and rockpool raids.
// Everything is procedural (boxes, instanced where there are many); no model files, no textures
// beyond tiny canvases for digits and names. Each sandbar shape has its own time of day (voxel/
// mood.ts); the sea is a shader (voxel/sea.ts). Soft sun shadows on desktop only; on touch screens
// the pixel ratio is capped and nothing casts shadows, so it runs on weak phone GPUs.

/** Tile codes the world understands (same as the rules' views): */
export const W_WATER = -2, W_HIDDEN = -1, W_URCHIN = -3, W_ROCK = -4, W_CACHE = -5;

export interface CrabState { at: number; name: string; color: string; stun: number; pry: number; crowned: boolean; me: boolean; pearls: number }
export interface Frame { tiles: number[]; items: number[]; crabs: CrabState[] }

export const SEAT_COLORS = ['#ff7a59', '#4cc3ff', '#b18cff', '#ffd166'];
const NUM_COLORS = ['', '#2f73d6', '#2e9e57', '#e0453d', '#4a3fb8', '#a8323a', '#15928d', '#333344', '#7a7a86'];

const C = {
  sand: 0xf0d398,
  urchin: 0x3b1f52, spine: 0x6c3fa0, pearl: 0xfff6ff, clamA: 0xff9eb5, clamB: 0xffc7d4, rock: 0x7b8794, rockHi: 0x9aa6b2,
  kelp: 0x2f8f4e, flag: 0xff4d6d, hover: 0xffffff, crab: 0xe0533b, crabDark: 0xa83a28, gold: 0xffcc33,
};

/** Sand, by how far a tile is from the water: wet at the shore, dry and golden inland; dug sand is paler. */
const SAND_BURIED = [0xd6a35e, 0xe5b56b, 0xefc477], SAND_DUG = [0xeed6a6, 0xfae4b9, 0xfff0cc];
const sandColor = (dug: boolean, fromWater: number, i: number, c: THREE.Color): THREE.Color =>
  c.set((dug ? SAND_DUG : SAND_BURIED)[Math.min(2, Math.max(0, fromWater - 1))]).offsetHSL(0, 0, (hash01(i) - 0.5) * 0.035);

/** One canvas-texture plane per digit, shared by every board. */
const digitTex = new Map<number, THREE.Texture>();
function digitTexture(n: number): THREE.Texture {
  let t = digitTex.get(n);
  if (t) return t;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d')!;
  g.font = '900 100px "Pixelify Sans", "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const s = String(n), x = 64, y = 70;
  // a soft shadow pressed into the sand, a cream halo, a darker rim of the digit's own colour, the fill and a highlight
  g.fillStyle = 'rgba(90,60,20,.28)';
  g.fillText(s, x + 4, y + 6);
  g.lineWidth = 20;
  g.strokeStyle = 'rgba(255,248,228,.96)';
  g.strokeText(s, x, y);
  g.lineWidth = 7;
  g.strokeStyle = new THREE.Color(NUM_COLORS[n]).offsetHSL(0, 0, -0.14).getStyle();
  g.strokeText(s, x, y);
  g.fillStyle = NUM_COLORS[n];
  g.fillText(s, x, y);
  g.save();
  g.beginPath(); g.rect(0, 0, 128, 58); g.clip();
  g.fillStyle = 'rgba(255,255,255,.22)';
  g.fillText(s, x, y);
  g.restore();
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
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
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
})();
const flagGeo = (() => {
  // a kelp stalk that kinks as it rises, with a bladder and leaves, and a red pennant at the top
  const stick = mergeGeometries([box(0.05, 0.22, 0.05, 0, 0.11, 0), box(0.05, 0.2, 0.05, 0.025, 0.3, 0), box(0.05, 0.2, 0.05, 0, 0.48, 0), box(0.09, 0.09, 0.09, 0.01, 0.62, 0), box(0.12, 0.04, 0.03, -0.06, 0.24, 0), box(0.1, 0.04, 0.03, 0.07, 0.4, 0)].map((g) => g.toNonIndexed()));
  const cloth = mergeGeometries([box(0.24, 0.16, 0.03, 0.14, 0.56, 0), box(0.1, 0.1, 0.03, 0.3, 0.56, 0)].map((g) => g.toNonIndexed()));
  return { stick, cloth };
})();
const rockGeo = mergeGeometries([box(0.7, 0.35, 0.6, 0, 0.17, 0), box(0.45, 0.3, 0.45, 0.1, 0.45, -0.05), box(0.3, 0.18, 0.25, -0.18, 0.4, 0.15)].map((g) => g.toNonIndexed()));

/** One half of a clam: a fan of ribs, longest in the middle, with a hinge at the back. */
const clamHalf = (y: number, up: number): THREE.BufferGeometry => {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = -3; k <= 3; k++) {
    const len = 0.5 - Math.abs(k) * 0.055, c = k % 2 ? C.clamB : C.clamA;
    parts.push(tint(box(0.085, 0.1, len, k * 0.088, y, len / 2 - 0.02), c));
    parts.push(tint(box(0.07, 0.03, 0.06, k * 0.088, y + up * 0.05, len - 0.04), 0xffe2ea));
  }
  parts.push(tint(box(0.22, 0.09, 0.08, 0, y, -0.03), 0xd77a92));
  return mergeGeometries(parts);
};
const CLAM_BOTTOM = clamHalf(0.05, 1), CLAM_LID = clamHalf(0.05, 1);
const clamMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const GLOW_GEO = new THREE.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2);
const freeClam = (c: THREE.Group): void => { ((c.getObjectByName('glow') as THREE.Mesh).material as THREE.Material).dispose(); ((c.getObjectByName('gleam') as THREE.Sprite).material).dispose(); };
const pearlMat = new THREE.MeshLambertMaterial({ color: C.pearl, emissive: 0x806a8a, emissiveIntensity: 0.7 });

function makeClam(): THREE.Group {
  const g = new THREE.Group();
  const bottom = new THREE.Mesh(CLAM_BOTTOM, clamMat);
  bottom.position.z = -0.22;
  bottom.castShadow = true;
  g.add(bottom);
  const lid = new THREE.Group();
  lid.position.set(0, 0.11, -0.24);
  const lidMesh = new THREE.Mesh(CLAM_LID, clamMat);
  lidMesh.castShadow = true;
  lidMesh.position.y = -0.05;
  lid.add(lidMesh);
  lid.name = 'lid';
  g.add(lid);
  const pearl = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 1), pearlMat);
  pearl.position.set(0, 0.18, 0.02);
  pearl.name = 'pearl';
  g.add(pearl);
  // a gleam on the pearl as the lid lifts
  const gleam = glintSprite(0.7);
  gleam.position.set(0.05, 0.28, 0.06);
  gleam.name = 'gleam';
  gleam.visible = false;
  g.add(gleam);
  const glow = new THREE.Mesh(GLOW_GEO, new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  glow.position.y = 0.02;
  glow.name = 'glow';
  g.add(glow);
  return g;
}

// ---------- the world ----------

interface CrabObj { crab: Crab; g: THREE.Group; label: THREE.Sprite | null; labelKey: string; from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; arc: number; at: number; spin: number; stun: number; pry: number; crowned: boolean }

export class World {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private sea: Sea;
  private shoreDetail: Shore;
  private mood = new MoodState(moodFor());
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private field: Field | null = null;
  /** tiles from the water, per board tile (1 = on the shore) */
  private fromWater: number[] = [];
  private seaY = 0.9;
  private seaTarget = -0.08;
  /** how far inland the tide has swept (tiles), and where it's heading */
  private front = 0;
  private frontGoal = 0;
  /** seconds since this sandbar started rising out of the sea */
  private riseT = 9;
  private particles: Particles;
  private rings: Rings;
  private glints: Glints;
  private hollows: THREE.InstancedMesh | null = null;
  private pearlGlow: THREE.InstancedMesh | null = null;
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
    this.scene.background = this.mood.haze.clone();
    this.scene.fog = new THREE.Fog(this.mood.haze.clone(), 30, 72);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.4);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.sun, this.sun.target);
    if (!isCoarse) {
      // soft sun shadows on desktop; phones skip them
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      this.sun.shadow.radius = 3;
      this.sun.shadow.bias = -0.0008;
      this.sun.shadow.normalBias = 0.02;
    }
    this.sea = new Sea(this.scene, isCoarse ? 64 : 112);
    this.scene.add(this.boardGroup);
    this.shoreDetail = new Shore(this.scene);
    this.particles = new Particles(this.scene);
    this.rings = new Rings(this.scene);
    this.glints = new Glints(this.scene);

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

  /** mood: the sandbar's shape key (bar, atoll, …), 'tutorial' or 'rockpool'; picks the time of day. */
  setBoard(w: number, h: number, land: number[], mood?: string): void {
    this.clearBoard();
    this.w = w; this.h = h; this.land = land.slice();
    this.last = null;
    this.marks.clear();
    this.follow = -1;
    const n = w * h;
    this.field?.tex.dispose();
    const field = buildField(w, h, land);
    this.field = field;
    this.sea.setField(field);
    this.fromWater = Array.from({ length: n }, (_, i) => field.dist[(Math.floor(i / w) + MARGIN) * field.gw + (i % w) + MARGIN]);
    this.shoreDetail.build(w, h, field, mood === 'rockpool');
    this.mood.set(moodFor(mood));
    const tileGeo = shadedBox(0.98, 1, 0.98);
    this.tiles = new THREE.InstancedMesh(tileGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), n);
    this.tiles.castShadow = this.tiles.receiveShadow = true;
    this.tileTop = new Array(n).fill(0.34);
    this.tileGoal = this.tileTop.slice();
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      if (!land[i]) { this.tiles.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0)); this.tiles.setColorAt(i, col.set(0)); continue; }
      this.setTileMatrix(i);
      this.tiles.setColorAt(i, sandColor(false, this.fromWater[i], i, col));
    }
    this.boardGroup.add(this.tiles);
    // dug tiles look scooped: a soft darker rim pressed into the sand under the number
    this.hollows = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.98, 0.98).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(150,100,40,0)', 'rgba(120,78,28,0.34)'), transparent: true, depthWrite: false }), n);
    this.hollows.count = 0;
    this.hollows.renderOrder = 1;
    this.boardGroup.add(this.hollows);
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
    this.urchins.castShadow = true;
    this.boardGroup.add(this.urchins);
    this.pearls = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.15, 1), pearlMat, n);
    this.pearls.count = 0;
    this.pearls.castShadow = true;
    this.boardGroup.add(this.pearls);
    // a soft glow on the sand under every loose pearl (no post-processing)
    this.pearlGlow = new THREE.InstancedMesh(GLOW_GEO, new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 }), n);
    this.pearlGlow.count = 0;
    this.pearlGlow.renderOrder = 3;
    this.boardGroup.add(this.pearlGlow);
    this.rocks = new THREE.InstancedMesh(rockGeo, mat(C.rock), n);
    this.rocks.count = 0;
    this.rocks.castShadow = this.rocks.receiveShadow = true;
    this.boardGroup.add(this.rocks);
    this.flags = [new THREE.InstancedMesh(flagGeo.stick, swayMaterial({ color: C.kelp }, 0.05, 2.2), n), new THREE.InstancedMesh(flagGeo.cloth, swayMaterial({ color: C.flag, emissive: 0x550010 }, 0.05, 2.2), n)];
    for (const f of this.flags) { f.count = 0; f.castShadow = true; this.boardGroup.add(f); }
    const fit = Math.max(w / Math.max(0.4, this.camera.aspect) * 1.45, h * 1.9);
    const cap = isCoarse ? 22 : 34;
    this.dist = THREE.MathUtils.clamp(fit, 13, cap);
    // when the whole sandbar fits on screen the camera stays put; otherwise it follows you
    this.followK = fit > cap ? 0.85 : 0.08;
    this.target.set(0, 0, 0);
    // the sandbar rises out of the sea: the water drains off it from the middle outwards
    this.seaY = 0.9; this.seaTarget = -0.08;
    this.front = field.inner + 1.5; this.frontGoal = 0;
    this.riseT = 0;
    // the sun's shadow covers the whole sandbar
    const sh = this.sun.shadow.camera;
    const r = Math.max(w, h) / 2 + 3;
    sh.left = -r; sh.right = r; sh.top = r; sh.bottom = -r; sh.near = 1; sh.far = 60;
    sh.updateProjectionMatrix();
  }

  private setTileMatrix(i: number): void {
    let top = this.tileTop[i];
    if (this.riseT < 3) {
      // rising: inland tiles first, a little jitter so it isn't a ruler-straight wave
      const inner = this.field?.inner ?? 1;
      const delay = (inner - this.fromWater[i]) * 0.09 + hash01(i + 5) * 0.14;
      const e = THREE.MathUtils.clamp((this.riseT - delay) / 0.55, 0, 1);
      const back = 1 + 2.2 * Math.pow(e - 1, 3) + 1.2 * Math.pow(e - 1, 2); // ease out, a little overshoot
      top = -0.6 + (top + 0.6) * back;
    }
    const p = this.pos(i);
    this.tiles!.setMatrixAt(i, new THREE.Matrix4().makeScale(1, top + 0.7, 1).setPosition(p.x, (top - 0.7) / 2, p.z));
  }

  private clearBoard(): void {
    for (const c of [...this.boardGroup.children]) {
      this.boardGroup.remove(c);
      if (c instanceof THREE.InstancedMesh) {
        c.dispose();
        if (c.geometry !== urchinGeo && c.geometry !== rockGeo && c.geometry !== flagGeo.stick && c.geometry !== flagGeo.cloth && c.geometry !== GLOW_GEO) c.geometry.dispose();
        if (c.material !== pearlMat) (c.material as THREE.Material).dispose();
      }
    }
    for (const c of this.crabs) { this.scene.remove(c.g, c.crab.ground); c.crab.dispose(); if (c.label) { c.label.material.map?.dispose(); c.label.material.dispose(); } }
    this.crabs = [];
    for (const c of this.clams.values()) freeClam(c);
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
    let u = 0, p = 0, r = 0, hl = 0, puffs = 0;
    const t = this.clock.elapsedTime;
    for (let i = 0; i < f.tiles.length; i++) {
      const v = f.tiles[i];
      if (v === W_WATER) continue;
      const dug = v >= 0 || v === W_URCHIN || v === W_CACHE;
      const goal = v === W_ROCK ? 0.12 : dug ? 0.12 : 0.34;
      if (this.tileGoal[i] !== goal) {
        this.tileGoal[i] = goal;
        this.tiles.setColorAt(i, sandColor(dug || v === W_ROCK, this.fromWater[i], i, col));
        if (this.tiles.instanceColor) this.tiles.instanceColor.needsUpdate = true;
        if (prev && dug && prev.tiles[i] === W_HIDDEN && puffs++ < 14) {
          // a dig puff: clods of sand and a ring of dust (a big flood only puffs its first few tiles)
          const at = this.pos(i, 0.3);
          this.particles.burst(at, sandColor(false, this.fromWater[i], i, col).getHex(), 5, { speed: 1.7, size: 0.1, life: 0.5, jitter: 0.08 });
          this.rings.spawn(at.setY(0.15), 0xfff1d2, 0.75, 0.35);
        }
      }
      const at = this.pos(i, 0.125);
      if (dug) { m4.makeTranslation(at.x, 0.123, at.z); this.hollows!.setMatrixAt(hl++, m4); }
      if (v >= 1 && v <= 8) { m4.makeTranslation(at.x, at.y, at.z); this.digits[v - 1].setMatrixAt(counts[v]++, m4); }
      if (v === W_URCHIN) {
        m4.makeRotationY(i).setPosition(at.x, 0.12, at.z);
        this.urchins!.setMatrixAt(u++, m4);
        if (prev && prev.tiles[i] !== W_URCHIN) {
          // the urchin bursts: spines fly and a purple shockwave rolls over the sand
          this.particles.burst(this.pos(i, 0.4), C.spine, 16, { speed: 3.4, size: 0.09, life: 0.7, drag: 1.5 });
          this.particles.burst(this.pos(i, 0.3), C.urchin, 8, { speed: 2, size: 0.12, life: 0.6 });
          this.rings.spawn(this.pos(i, 0.16), 0x9a5cff, 1.9, 0.55);
        }
      }
      if (v === W_ROCK) { m4.makeRotationY((i % 4) * 1.3).setPosition(at.x, 0.12, at.z); this.rocks!.setMatrixAt(r++, m4); }
      if (f.items[i] === 2) { m4.makeTranslation(at.x, 0.3 + Math.sin(t * 3 + i) * 0.04, at.z); this.pearls!.setMatrixAt(p++, m4); }
      const clamHere = f.items[i] === 3 || v === W_CACHE;
      if (clamHere && !this.clams.has(i)) {
        const c = makeClam();
        c.position.copy(this.pos(i, 0.12));
        if (v === W_CACHE) c.scale.setScalar(1.35);
        c.traverse((o) => { o.castShadow = true; });
        this.clams.set(i, c);
        this.boardGroup.add(c);
      } else if (!clamHere && this.clams.has(i)) {
        const c = this.clams.get(i)!;
        this.boardGroup.remove(c);
        freeClam(c);
        this.clams.delete(i);
        this.particles.burst(this.pos(i, 0.4), C.clamA, 12, { speed: 2.2, size: 0.09, life: 0.6 });
        this.particles.burst(this.pos(i, 0.5), 0xfff6d8, 14, { speed: 1.2, size: 0.06, life: 1.1, gravity: -1.2, drag: 2.5 });
        this.rings.spawn(this.pos(i, 0.16), C.gold, 1.5, 0.6, true);
        this.glints.spawn(this.pos(i, 0.7), 1.3, 0.7);
      }
    }
    for (let d = 1; d <= 8; d++) { this.digits[d - 1].count = counts[d]; this.digits[d - 1].instanceMatrix.needsUpdate = true; }
    this.urchins!.count = u; this.urchins!.instanceMatrix.needsUpdate = true;
    this.pearls!.count = p; this.pearls!.instanceMatrix.needsUpdate = true;
    this.pearlGlow!.count = p;
    this.hollows!.count = hl; this.hollows!.instanceMatrix.needsUpdate = true;
    this.rocks!.count = r; this.rocks!.instanceMatrix.needsUpdate = true;
    // picked-up pearls sparkle
    if (prev) for (let i = 0; i < f.items.length; i++) if (prev.items[i] === 2 && f.items[i] !== 2) {
      this.particles.burst(this.pos(i, 0.35), 0xffffff, 10, { speed: 1.1, size: 0.06, life: 0.8, gravity: -1.5, drag: 3 });
      this.glints.spawn(this.pos(i, 0.45), 0.9, 0.45);
      this.rings.spawn(this.pos(i, 0.15), 0xfff4e6, 0.6, 0.3, true);
    }
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
      const crab = new Crab(c.color, k);
      const g = crab.g;
      const at = this.pos(c.at, this.tileTop[c.at] ?? 0.12);
      g.position.copy(at);
      this.scene.add(g, crab.ground);
      this.crabs.push({ crab, g, label: null, labelKey: '', from: at.clone(), to: at.clone(), t: 1, dur: 0.3, arc: 0.3, at: c.at, spin: 0, stun: 0, pry: 0, crowned: false });
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
      o.stun = c.stun; o.pry = c.pry; o.crowned = c.crowned;
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
    if (kind === 'sting') { this.particles.burst(p, C.spine, 16, { speed: 3.2, size: 0.1, life: 0.8, drag: 1 }); this.rings.spawn(this.pos(tile, 0.16), 0x9a5cff, 1.4, 0.45); }
    if (kind === 'clam') { this.particles.burst(p, C.gold, 18, { speed: 3, size: 0.08, life: 0.9 }); this.glints.spawn(this.pos(tile, 0.9), 1.4, 0.8); }
    if (kind === 'pinch') { this.particles.burst(p, C.gold, 10, { speed: 2, size: 0.07, life: 0.6 }); this.glints.spawn(this.pos(tile, 0.8), 0.8, 0.4); }
    if (kind === 'emote' && seat >= 0 && this.crabs[seat]) {
      const g = this.crabs[seat].g;
      this.crabs[seat].crab.clack = 0.8;
      this.particles.burst(g.position.clone().setY(1.2), 0xffffff, 6, { speed: 1.4, size: 0.06, life: 0.5 });
    }
  }

  /** The tide comes in and swallows the sandbar. */
  tide(): void { this.seaTarget = 0.9; this.frontGoal = (this.field?.inner ?? 4) + 1.5; }

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
    // light and sea: ease towards this sandbar's mood
    const m = this.mood;
    m.step(Math.min(1, dt * 1.6));
    this.hemi.color.copy(m.sky); this.hemi.groundColor.copy(m.ground); this.hemi.intensity = m.hemiI;
    this.sun.color.copy(m.sun); this.sun.intensity = m.sunI;
    this.sun.target.position.set(this.target.x, 0, this.target.z);
    this.sun.position.copy(m.sunDir).multiplyScalar(25).add(this.sun.target.position);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(m.haze);
    (this.scene.background as THREE.Color).copy(m.haze);
    // the tide: the water rises, and its front sweeps over the sand from the shore inwards (or
    // drains off a new sandbar from the middle outwards)
    this.seaY += (this.seaTarget - this.seaY) * Math.min(1, dt * (this.seaTarget > 0 ? 1.6 : 2.2));
    const span = (this.field?.inner ?? 4) + 1.5;
    const fs = span / (this.frontGoal > this.front ? 2.6 : 1.3);
    this.front += THREE.MathUtils.clamp(this.frontGoal - this.front, -fs * dt, fs * dt);
    this.sea.update(t, this.seaY, this.front, m, fog);
    swayTime.value = t;
    // tiles settle towards their height (digging sinks them); a new sandbar rises
    if (this.tiles) {
      let changed = false;
      const rising = this.riseT < 3;
      this.riseT += dt;
      for (let i = 0; i < this.tileTop.length; i++) {
        if (!this.land[i]) continue;
        if (rising) { this.setTileMatrix(i); changed = true; }
        if (this.tileTop[i] === this.tileGoal[i]) continue;
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
        const g4 = new THREE.Matrix4();
        this.last.items.forEach((it, i) => {
          if (it !== 2) return;
          const at = this.pos(i), b = Math.sin(t * 3 + i);
          m4.makeRotationY(t + i).setPosition(at.x, 0.32 + b * 0.06, at.z);
          this.pearls!.setMatrixAt(p, m4);
          const gs = 0.85 + b * 0.12;
          g4.makeScale(gs, 1, gs).setPosition(at.x, 0.13, at.z);
          this.pearlGlow!.setMatrixAt(p++, g4);
        });
        this.pearls.instanceMatrix.needsUpdate = true;
        this.pearlGlow!.instanceMatrix.needsUpdate = true;
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
      // the pearl gleams and glows as the lid lifts
      const open = THREE.MathUtils.clamp(-lid.rotation.x / 1.1, 0, 1);
      const gleam = c.getObjectByName('gleam') as THREE.Sprite;
      gleam.visible = open > 0.3;
      gleam.scale.setScalar((0.25 + open * 0.5) * (0.75 + Math.max(0, Math.sin(t * 5 + i)) ** 6 * 0.6));
      gleam.material.rotation = t * 0.8;
      ((c.getObjectByName('glow') as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = open * 0.85;
    }
    // crabs: hops are little arcs; a sting is a big tumbling fling back to the shore
    for (const o of this.crabs) {
      if (o.t < 1) {
        o.t = Math.min(1, o.t + dt / o.dur);
        const e = o.t;
        o.g.position.lerpVectors(o.from, o.to, e);
        o.g.position.y = o.from.y + (o.to.y - o.from.y) * e + Math.sin(Math.PI * e) * o.arc;
        if (o.spin) o.crab.rig.rotation.x = o.spin * e;
        if (o.t >= 1) { o.crab.rig.rotation.x = 0; if (o.spin) { this.particles.burst(o.g.position.clone(), C.sand, 10, { speed: 2, size: 0.09, life: 0.5 }); this.rings.spawn(o.g.position.clone().setY(0.15), 0xfff1d2, 1, 0.4); } }
      } else {
        o.g.position.y = this.pos(o.at, 0.12).y;
      }
      // the shadow, seat ring and aura stay on the sand under the crab
      o.crab.ground.position.set(o.g.position.x, 0.13, o.g.position.z);
      const sc = 1 - Math.min(0.5, (o.g.position.y - 0.12) * 0.25);
      o.crab.ground.scale.set(sc, 1, sc);
      o.crab.animate(dt, t, { hopping: o.t < 1 && !o.spin, dazed: o.stun > 0 && o.t >= 1, prying: o.pry > 0, crowned: o.crowned });
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
    this.rings.update(dt);
    this.glints.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
