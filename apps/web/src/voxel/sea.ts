import * as THREE from 'three';
import type { MoodState } from './mood.ts';

// The sea is one plane with its swell, colour and foam worked out on the GPU (nothing per vertex
// on the CPU). A small texture holds the signed distance from every tile to the shoreline, so the
// water is turquoise in the shallows and deep blue further out, foam hugs the sand, a wavelet
// washes in every few seconds, and blocky caustics and sparkles play over the shallows. The tide
// is a front in that same distance: it sweeps over the sand from the shore inwards when the last
// clam opens, and drains back off a new sandbar from the middle outwards.

/** How far (in tiles) the distance field reaches beyond the board. */
export const MARGIN = 10;

export interface Field {
  /** the field grid is the board plus MARGIN tiles on every side */
  gw: number; gh: number;
  /** tiles from the nearest sand (water) or the nearest water (sand), 8-connected; 0 outside the grid */
  dist: Int16Array;
  land: Uint8Array;
  /** the deepest sand tile's distance from the water */
  inner: number;
  tex: THREE.DataTexture;
  /** world x/z of the grid's corner and its size */
  rect: THREE.Vector4;
}

function bfs(gw: number, gh: number, from: (i: number) => boolean): Int16Array {
  const d = new Int16Array(gw * gh).fill(-1);
  const q = new Int32Array(gw * gh);
  let head = 0, tail = 0;
  for (let i = 0; i < gw * gh; i++) if (from(i)) { d[i] = 0; q[tail++] = i; }
  while (head < tail) {
    const i = q[head++], x = i % gw, z = (i / gw) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, zz = z + dz;
      if (xx < 0 || zz < 0 || xx >= gw || zz >= gh) continue;
      const j = zz * gw + xx;
      if (d[j] >= 0) continue;
      d[j] = d[i] + 1;
      q[tail++] = j;
    }
  }
  return d;
}

export function buildField(w: number, h: number, land: number[]): Field {
  const gw = w + MARGIN * 2, gh = h + MARGIN * 2;
  const L = new Uint8Array(gw * gh);
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) if (land[z * w + x]) L[(z + MARGIN) * gw + x + MARGIN] = 1;
  const toLand = bfs(gw, gh, (i) => L[i] === 1);
  const toWater = bfs(gw, gh, (i) => L[i] === 0);
  const dist = new Int16Array(gw * gh);
  const px = new Uint8Array(gw * gh);
  let inner = 1;
  for (let i = 0; i < gw * gh; i++) {
    const dd = L[i] ? toWater[i] : toLand[i];
    dist[i] = dd < 0 ? 99 : dd;
    if (L[i]) inner = Math.max(inner, dist[i]);
    // signed: + out at sea, - inland, 0 on the shoreline between a sand and a water tile
    const sd = L[i] ? -(dist[i] - 0.5) : dist[i] - 0.5;
    px[i] = Math.max(0, Math.min(255, Math.round(128 + sd * 8)));
  }
  const tex = new THREE.DataTexture(px, gw, gh, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  const rect = new THREE.Vector4(-w / 2 - MARGIN, -h / 2 - MARGIN, gw, gh);
  return { gw, gh, dist, land: L, inner, tex, rect };
}

const vert = /* glsl */ `
uniform float uTime;
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  float t = uTime;
  w.y += sin(w.x * 0.55 + t * 1.15) * 0.045 + cos(w.z * 0.7 + t * 0.85) * 0.035 + sin((w.x - w.z) * 1.4 + t * 2.0) * 0.012;
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const frag = /* glsl */ `
uniform float uTime, uFront, uFogNear, uFogFar;
uniform vec3 uDeep, uMid, uShallow, uFoam, uSun, uSunDir, uFog;
uniform sampler2D uField;
uniform vec4 uRect;
varying vec3 vW;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float field(vec2 xz) { return (texture2D(uField, (xz - uRect.xy) / uRect.zw).r * 255.0 - 128.0) / 8.0; }
void main() {
  float t = uTime;
  // quarter-tile voxels: colour bands, caustics and foam all step in blocks
  vec2 cell = floor(vW.xz * 4.0);
  vec2 q = (cell + 0.5) / 4.0;
  float wob = (hash(cell) - 0.5) * 0.22;
  float d = field(q) - uFront + wob;
  if (d < -0.05) discard;
  vec3 col = mix(uShallow, uMid, smoothstep(0.3, 2.4, d));
  col = mix(col, uDeep, smoothstep(2.4, 6.5, d));
  float shallow = 1.0 - smoothstep(0.0, 2.6, d);
  // caustics
  float c = sin(q.x * 2.3 + sin(q.y * 1.9 + t * 0.9) * 1.3 + t * 0.7) * sin(q.y * 2.6 + sin(q.x * 1.4 - t * 0.8) * 1.2 - t * 0.5);
  col += pow(abs(c), 5.0) * 0.25 * shallow * uSun;
  // faceted light
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  if (n.y < 0.0) n = -n;
  col *= 0.82 + 0.22 * max(dot(n, uSunDir), 0.0);
  vec3 v = normalize(cameraPosition - vW);
  col += uSun * pow(max(dot(reflect(-uSunDir, n), v), 0.0), 60.0) * 0.3;
  // sparkles, most in the shallows
  vec2 sc = floor(vW.xz * 6.0);
  float h = hash(sc + 17.0);
  col += uSun * step(0.988, h) * pow(max(sin(t * 2.4 + h * 80.0), 0.0), 18.0) * (1.0 - smoothstep(0.6, 3.0, d)) * 0.9;
  // foam: a lapping band at the waterline and a wavelet washing in
  float lap = 0.42 + 0.16 * sin(t * 1.6 + q.x * 1.7 + q.y * 2.1);
  float foam = 1.0 - smoothstep(lap - 0.1, lap, d);
  float ph = fract(t * 0.21 + hash(floor(q * 0.25)) * 0.12);
  float wave = (1.0 - smoothstep(0.0, 0.18, abs(d - 2.4 * (1.0 - ph)))) * smoothstep(0.0, 0.25, ph) * (1.0 - ph);
  foam = max(foam, wave * 0.75 * step(0.55, hash(cell * 0.5 + floor(t * 0.21))));
  col = mix(col, uFoam, foam * 0.9);
  float a = mix(mix(0.62, 0.95, smoothstep(0.2, 3.5, d)), 1.0, foam * 0.9);
  float f = smoothstep(uFogNear, uFogFar, length(vW - cameraPosition));
  gl_FragColor = vec4(mix(col, uFog, f), mix(a, 1.0, f));
  #include <colorspace_fragment>
}`;

export class Sea {
  mesh: THREE.Mesh;
  floor: THREE.Mesh;
  private u: Record<string, THREE.IUniform>;
  private empty = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  constructor(scene: THREE.Scene, segs: number) {
    this.empty.needsUpdate = true;
    this.u = {
      uTime: { value: 0 }, uFront: { value: 0 }, uFogNear: { value: 30 }, uFogFar: { value: 70 },
      uDeep: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uShallow: { value: new THREE.Color() },
      uFoam: { value: new THREE.Color() }, uSun: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uFog: { value: new THREE.Color() },
      uField: { value: this.empty }, uRect: { value: new THREE.Vector4(-1, -1, 2, 2) },
    };
    const geo = new THREE.PlaneGeometry(140, 140, segs, segs).rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5; // after the digits, so a risen tide covers them
    scene.add(this.mesh);
    // the sea floor far below, so deep water reads as deep
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(140, 140).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0a3550, fog: true }));
    this.floor.position.y = -1.1;
    scene.add(this.floor);
  }
  setField(f: Field): void {
    const old = this.u.uField.value as THREE.Texture;
    if (old !== this.empty) old.dispose();
    this.u.uField.value = f.tex;
    (this.u.uRect.value as THREE.Vector4).copy(f.rect);
  }
  /** front: how far inland (in tiles) the tide has swept; y: the water's height */
  update(t: number, y: number, front: number, m: MoodState, fog: THREE.Fog): void {
    this.mesh.position.y = y;
    const u = this.u;
    u.uTime.value = t;
    u.uFront.value = -front;
    (u.uDeep.value as THREE.Color).copy(m.deep);
    (u.uMid.value as THREE.Color).copy(m.mid);
    (u.uShallow.value as THREE.Color).copy(m.shallow);
    (u.uFoam.value as THREE.Color).copy(m.foam);
    (u.uSun.value as THREE.Color).copy(m.sun).multiplyScalar(Math.min(1.2, m.sunI / 1.6));
    (u.uSunDir.value as THREE.Vector3).copy(m.sunDir);
    (u.uFog.value as THREE.Color).copy(fog.color);
    u.uFogNear.value = fog.near;
    u.uFogFar.value = fog.far;
    (this.floor.material as THREE.MeshBasicMaterial).color.copy(m.deep).multiplyScalar(0.45);
  }
}
