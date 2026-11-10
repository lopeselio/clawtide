import * as THREE from 'three';
import { glintSprite } from './crab.ts';
import { radialTexture } from './util.ts';

// Pooled effects, nothing allocated per burst: voxel particles (one instanced mesh; colour jitter,
// spin, drag, gravity or float-up sparkles), flat shockwave rings on the sand, and star glints.

interface Particle { i: number; life: number; max: number; vel: THREE.Vector3; pos: THREE.Vector3; size: number; spin: number; g: number; drag: number }
export interface BurstOpts { speed?: number; size?: number; life?: number; gravity?: number; drag?: number; up?: number; jitter?: number }

export class Particles {
  mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private live: Particle[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  constructor(scene: THREE.Scene, n = 500) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) { this.free.push(i); this.mesh.setMatrixAt(i, zero); this.mesh.setColorAt(i, this.c.set(0xffffff)); }
    scene.add(this.mesh);
  }
  burst(at: THREE.Vector3, color: number, n: number, o: BurstOpts = {}): void {
    const { speed = 2, size = 0.08, life = 0.6, gravity = 6, drag = 0, up = 1, jitter = 0.06 } = o;
    for (let k = 0; k < n; k++) {
      const i = this.free.pop();
      if (i === undefined) break;
      const a = Math.random() * Math.PI * 2, r = speed * (0.35 + Math.random() * 0.65);
      this.live.push({
        i, life: life * (0.7 + Math.random() * 0.5), max: life, size: size * (0.6 + Math.random() * 0.8), spin: (Math.random() - 0.5) * 12, g: gravity, drag,
        pos: at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.2, 0, (Math.random() - 0.5) * 0.2)),
        vel: new THREE.Vector3(Math.cos(a) * r, (0.4 + Math.random() * 0.8) * speed * up, Math.sin(a) * r),
      });
      this.mesh.setColorAt(i, this.c.set(color).offsetHSL(0, 0, (Math.random() - 0.5) * jitter * 2));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  update(dt: number): void {
    if (!this.live.length) return;
    const keep: Particle[] = [];
    for (const p of this.live) {
      p.life -= dt;
      if (p.life <= 0) { this.mesh.setMatrixAt(p.i, this.m.makeScale(0, 0, 0)); this.free.push(p.i); continue; }
      p.vel.y -= p.g * dt;
      if (p.drag) p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      const k = p.life / p.max, sz = p.size * Math.min(1, k * 1.6);
      const a = p.spin * (p.max - p.life);
      this.q.setFromEuler(this.e.set(a, a * 0.7, 0));
      this.m.compose(p.pos, this.q, this.s.setScalar(sz));
      this.mesh.setMatrixAt(p.i, this.m);
      keep.push(p);
    }
    this.live = keep;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Flat rings that grow and fade on the sand (urchin shockwaves, dig dust, pearl pickups). */
export class Rings {
  private pool: { m: THREE.Mesh; t: number; dur: number; r: number }[] = [];
  constructor(scene: THREE.Scene, n = 14) {
    const geo = new THREE.RingGeometry(0.78, 1, 32).rotateX(-Math.PI / 2);
    for (let k = 0; k < n; k++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0 }));
      m.visible = false;
      m.renderOrder = 4;
      scene.add(m);
      this.pool.push({ m, t: 1, dur: 1, r: 1 });
    }
  }
  spawn(at: THREE.Vector3, color: number, radius = 1.2, dur = 0.5, additive = false): void {
    const p = this.pool.find((x) => x.t >= 1) ?? this.pool[0];
    p.t = 0; p.dur = dur; p.r = radius;
    p.m.position.copy(at);
    const mt = p.m.material as THREE.MeshBasicMaterial;
    mt.color.set(color);
    mt.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    p.m.visible = true;
  }
  update(dt: number): void {
    for (const p of this.pool) {
      if (p.t >= 1) continue;
      p.t = Math.min(1, p.t + dt / p.dur);
      const e = 1 - (1 - p.t) ** 3;
      p.m.scale.setScalar(0.1 + e * p.r);
      (p.m.material as THREE.MeshBasicMaterial).opacity = (1 - p.t) * 0.85;
      if (p.t >= 1) p.m.visible = false;
    }
  }
}

/** Star glints that flash and spin (pearl pickups, an opening clam's pearl). */
export class Glints {
  private pool: { s: THREE.Sprite; t: number; dur: number; size: number }[] = [];
  constructor(scene: THREE.Scene, n = 10) {
    for (let k = 0; k < n; k++) {
      const s = glintSprite(0.6);
      s.visible = false;
      s.renderOrder = 11;
      scene.add(s);
      this.pool.push({ s, t: 1, dur: 0.5, size: 1 });
    }
  }
  spawn(at: THREE.Vector3, size = 0.9, dur = 0.55): void {
    const p = this.pool.find((x) => x.t >= 1) ?? this.pool[0];
    p.t = 0; p.dur = dur; p.size = size;
    p.s.position.copy(at);
    p.s.visible = true;
  }
  update(dt: number): void {
    for (const p of this.pool) {
      if (p.t >= 1) continue;
      p.t = Math.min(1, p.t + dt / p.dur);
      p.s.scale.setScalar(Math.sin(p.t * Math.PI) * p.size);
      p.s.material.rotation = p.t * 2;
      if (p.t >= 1) p.s.visible = false;
    }
  }
}

/** A soft glow disc texture for pearls and gleams. */
export const glowTexture = (): THREE.Texture => radialTexture('rgba(255,248,235,0.95)', 'rgba(255,240,220,0)');
