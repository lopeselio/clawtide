import * as THREE from 'three';

// Small helpers shared by the voxel world: boxes, materials, a stable hash, and a material whose
// vertices sway with height (seaweed, kelp flags), animated on the GPU from one time uniform.

export const isCoarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

export const mat = (color: THREE.ColorRepresentation, emissive = 0): THREE.MeshLambertMaterial =>
  new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: emissive ? 0.6 : 0 });

/** A stable 0..1 hash of an integer (placement of shore details, colour jitter). */
export function hash01(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Bakes one colour into a geometry's vertex colours (to merge differently coloured voxels into one mesh). */
export function tint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}

/** Box faces shaded by direction (top bright, sides darker, bottom darkest), multiplied into the instance colour. */
export function shadedBox(w: number, h: number, d: number, top = 1, side = 0.8, bottom = 0.55): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const nrm = g.attributes.normal;
  const a = new Float32Array(nrm.count * 3);
  for (let i = 0; i < nrm.count; i++) {
    const ny = nrm.getY(i), nz = nrm.getZ(i);
    // the camera looks from +z: front faces a touch lighter than the left/right ones
    const k = ny > 0.5 ? top : ny < -0.5 ? bottom : nz > 0.5 ? side + 0.06 : side;
    a[i * 3] = a[i * 3 + 1] = a[i * 3 + 2] = k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** One time uniform shared by every swaying material. */
export const swayTime = { value: 0 };

/** A Lambert material whose vertices lean with the current, more the higher they are (instanced or not). */
export function swayMaterial(params: THREE.MeshLambertMaterialParameters, amp = 0.08, freq = 1.6): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial(params);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSway = swayTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uSway;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 base = vec3(0.0);
          #ifdef USE_INSTANCING
            base = instanceMatrix[3].xyz;
          #endif
          float ph = base.x * 1.7 + base.z * 2.3;
          float k = max(transformed.y, 0.0);
          transformed.x += sin(uSway * ${freq.toFixed(2)} + ph) * ${amp.toFixed(3)} * k * k * 4.0;
          transformed.z += cos(uSway * ${(freq * 0.8).toFixed(2)} + ph * 1.3) * ${(amp * 0.6).toFixed(3)} * k * k * 4.0;
        }`);
  };
  m.customProgramCacheKey = () => `sway-${amp}-${freq}`;
  return m;
}

/** A soft round texture (dust, glows, blob shadows), drawn once per colour. */
const radialCache = new Map<string, THREE.Texture>();
export function radialTexture(inner: string, outer = 'rgba(0,0,0,0)', size = 64): THREE.Texture {
  const key = `${inner}|${outer}|${size}`;
  let t = radialCache.get(key);
  if (t) return t;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d')!;
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, inner);
  gr.addColorStop(1, outer);
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  radialCache.set(key, t);
  return t;
}
