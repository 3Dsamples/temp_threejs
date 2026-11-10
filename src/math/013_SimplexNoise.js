// file number : 013
// full path name : src/math/013_SimplexNoise.js
// description : High-performance Simplex noise module (1D/2D/3D/4D) rewritten from simplex-noise v4.0.3 with adaptive ARRAY_TYPE, precomputed permutation tables (Uint8Array), Int8Array gradient lookup tables, inline fast paths, seeded PRNG support via core RANDOM, PURE-annotated hot loops, fractal helpers (2D/3D/4D), and a stack-based object pool for zero-allocation coordinate work.
// best for : Procedural terrain, volumetric clouds, water waves, vertex displacement, heightmap generation, texture synthesis, PBR detail noise, large-scale LOD chunk variation, context-awareness triggers, and low-GC pooled noise sampling on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, RANDOM } from '../core/003_Common.js';
import { NOISE } from '../core/002_Constants.js';

const F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
const G2 = (3.0 - Math.sqrt(3.0)) / 6.0;
const F3 = 1.0 / 3.0;
const G3 = 1.0 / 6.0;
const F4 = (Math.sqrt(5.0) - 1.0) / 4.0;
const G4 = (5.0 - Math.sqrt(5.0)) / 20.0;

const grad3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1
]);

const grad4 = new Int8Array([
  0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1,
  0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1,
  1, 0, 1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1,
  -1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1,
  1, 1, 0, 1, 1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1,
  -1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1,
  1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0,
  -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0
]);

function buildPermutationTable(random) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const r = Math.floor(random() * (i + 1));
    const t = p[i];
    p[i] = p[r];
    p[r] = t;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
  return { perm, permMod12 };
}

export function createNoise2D(random) {
  const rnd = random !== undefined ? random : RANDOM;
  const { perm, permMod12 } = buildPermutationTable(rnd);

  return function noise2D(x, y) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = x - X0;
    const y0 = y - Y0;

    let i1, j1;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1.0 + 2.0 * G2;
    const y2 = y0 - 1.0 + 2.0 * G2;

    const ii = i & 255;
    const jj = j & 255;

    const gi0 = permMod12[ii + perm[jj]] * 3;
    const gi1 = permMod12[ii + i1 + perm[jj + j1]] * 3;
    const gi2 = permMod12[ii + 1 + perm[jj + 1]] * 3;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    let n0 = 0;
    if (t0 >= 0) {
      t0 *= t0;
      n0 = t0 * t0 * (grad3[gi0] * x0 + grad3[gi0 + 1] * y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    let n1 = 0;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * (grad3[gi1] * x1 + grad3[gi1 + 1] * y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    let n2 = 0;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * (grad3[gi2] * x2 + grad3[gi2 + 1] * y2);
    }

    return 70.0 * (n0 + n1 + n2);
  };
}

export function createNoise3D(random) {
  const rnd = random !== undefined ? random : RANDOM;
  const { perm, permMod12 } = buildPermutationTable(rnd);

  return function noise3D(x, y, z) {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const X0 = i - t;
    const Y0 = j - t;
    const Z0 = k - t;
    const x0 = x - X0;
    const y0 = y - Y0;
    const z0 = z - Z0;

    let i1, j1, k1;
    let i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0;
        i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0;
        i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1;
        i2 = 1; j2 = 0; k2 = 1;
      }
    } else {
      if (y0 < z0) {
        i1 = 0; j1 = 0; k1 = 1;
        i2 = 0; j2 = 1; k2 = 1;
      } else if (x0 < z0) {
        i1 = 0; j1 = 1; k1 = 0;
        i2 = 0; j2 = 1; k2 = 1;
      } else {
        i1 = 0; j1 = 1; k1 = 0;
        i2 = 1; j2 = 1; k2 = 0;
      }
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2.0 * G3;
    const y2 = y0 - j2 + 2.0 * G3;
    const z2 = z0 - k2 + 2.0 * G3;
    const x3 = x0 - 1.0 + 3.0 * G3;
    const y3 = y0 - 1.0 + 3.0 * G3;
    const z3 = z0 - 1.0 + 3.0 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    const gi0 = permMod12[ii + perm[jj + perm[kk]]] * 3;
    const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
    const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
    const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    let n0 = 0;
    if (t0 >= 0) {
      t0 *= t0;
      n0 = t0 * t0 * (grad3[gi0] * x0 + grad3[gi0 + 1] * y0 + grad3[gi0 + 2] * z0);
    }

    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    let n1 = 0;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * (grad3[gi1] * x1 + grad3[gi1 + 1] * y1 + grad3[gi1 + 2] * z1);
    }

    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    let n2 = 0;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * (grad3[gi2] * x2 + grad3[gi2 + 1] * y2 + grad3[gi2 + 2] * z2);
    }

    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    let n3 = 0;
    if (t3 >= 0) {
      t3 *= t3;
      n3 = t3 * t3 * (grad3[gi3] * x3 + grad3[gi3 + 1] * y3 + grad3[gi3 + 2] * z3);
    }

    return 32.0 * (n0 + n1 + n2 + n3);
  };
}

export function createNoise4D(random) {
  const rnd = random !== undefined ? random : RANDOM;
  const { perm } = buildPermutationTable(rnd);

  return function noise4D(x, y, z, w) {
    const s = (x + y + z + w) * F4;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const l = Math.floor(w + s);
    const t = (i + j + k + l) * G4;
    const X0 = i - t;
    const Y0 = j - t;
    const Z0 = k - t;
    const W0 = l - t;
    const x0 = x - X0;
    const y0 = y - Y0;
    const z0 = z - Z0;
    const w0 = w - W0;

    let c1, c2, c3, c4, c5, c6;
    if (x0 > y0) c1 = 1; else c1 = 0;
    if (x0 > z0) c2 = 1; else c2 = 0;
    if (y0 > z0) c3 = 1; else c3 = 0;
    if (x0 > w0) c4 = 1; else c4 = 0;
    if (y0 > w0) c5 = 1; else c5 = 0;
    if (z0 > w0) c6 = 1; else c6 = 0;

    const i1 = c1;
    const j1 = c2;
    const k1 = c3;
    const l1 = c4;
    const i2 = c1 + c2;
    const j2 = c2 + c3;
    const k2 = c3 + c4;
    const l2 = c4 + c5;
    const i3 = c1 + c2 + c3;
    const j3 = c2 + c3 + c4;
    const k3 = c3 + c4 + c5;
    const l3 = c4 + c5 + c6;

    const x1 = x0 - i1 + G4;
    const y1 = y0 - j1 + G4;
    const z1 = z0 - k1 + G4;
    const w1 = w0 - l1 + G4;
    const x2 = x0 - i2 + 2.0 * G4;
    const y2 = y0 - j2 + 2.0 * G4;
    const z2 = z0 - k2 + 2.0 * G4;
    const w2 = w0 - l2 + 2.0 * G4;
    const x3 = x0 - i3 + 3.0 * G4;
    const y3 = y0 - j3 + 3.0 * G4;
    const z3 = z0 - k3 + 3.0 * G4;
    const w3 = w0 - l3 + 3.0 * G4;
    const x4 = x0 - 1.0 + 4.0 * G4;
    const y4 = y0 - 1.0 + 4.0 * G4;
    const z4 = z0 - 1.0 + 4.0 * G4;
    const w4 = w0 - 1.0 + 4.0 * G4;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    const ll = l & 255;

    const gi0 = (perm[ii + perm[jj + perm[kk + perm[ll]]]] & 31) * 4;
    const gi1 = (perm[ii + i1 + perm[jj + j1 + perm[kk + k1 + perm[ll + l1]]]] & 31) * 4;
    const gi2 = (perm[ii + i2 + perm[jj + j2 + perm[kk + k2 + perm[ll + l2]]]] & 31) * 4;
    const gi3 = (perm[ii + i3 + perm[jj + j3 + perm[kk + k3 + perm[ll + l3]]]] & 31) * 4;
    const gi4 = (perm[ii + 1 + perm[jj + 1 + perm[kk + 1 + perm[ll + 1]]]] & 31) * 4;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0 - w0 * w0;
    let n0 = 0;
    if (t0 >= 0) {
      t0 *= t0;
      n0 = t0 * t0 * (
        grad4[gi0] * x0 + grad4[gi0 + 1] * y0 + grad4[gi0 + 2] * z0 + grad4[gi0 + 3] * w0
      );
    }

    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1 - w1 * w1;
    let n1 = 0;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * (
        grad4[gi1] * x1 + grad4[gi1 + 1] * y1 + grad4[gi1 + 2] * z1 + grad4[gi1 + 3] * w1
      );
    }

    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2 - w2 * w2;
    let n2 = 0;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * (
        grad4[gi2] * x2 + grad4[gi2 + 1] * y2 + grad4[gi2 + 2] * z2 + grad4[gi2 + 3] * w2
      );
    }

    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3 - w3 * w3;
    let n3 = 0;
    if (t3 >= 0) {
      t3 *= t3;
      n3 = t3 * t3 * (
        grad4[gi3] * x3 + grad4[gi3 + 1] * y3 + grad4[gi3 + 2] * z3 + grad4[gi3 + 3] * w3
      );
    }

    let t4 = 0.6 - x4 * x4 - y4 * y4 - z4 * z4 - w4 * w4;
    let n4 = 0;
    if (t4 >= 0) {
      t4 *= t4;
      n4 = t4 * t4 * (
        grad4[gi4] * x4 + grad4[gi4 + 1] * y4 + grad4[gi4 + 2] * z4 + grad4[gi4 + 3] * w4
      );
    }

    return 27.0 * (n0 + n1 + n2 + n3 + n4);
  };
}

export function createNoise1D(random) {
  const noise2D = createNoise2D(random);
  return function noise1D(x) {
    return noise2D(x, 0);
  };
}

export function fractal2D(noise2D, x, y, octaves, frequency, persistence, lacunarity) {
  const oct = octaves !== undefined ? octaves : NOISE.OCTAVES_DEFAULT;
  let freq = frequency !== undefined ? frequency : NOISE.FREQUENCY_DEFAULT;
  const pers = persistence !== undefined ? persistence : NOISE.PERSISTENCE_DEFAULT;
  const lac = lacunarity !== undefined ? lacunarity : NOISE.LACUNARITY_DEFAULT;

  let amplitude = NOISE.AMPLITUDE_DEFAULT;
  let total = 0;
  let maxValue = 0;
  for (let i = 0; i < oct; i++) {
    total += noise2D(x * freq, y * freq) * amplitude;
    maxValue += amplitude;
    amplitude *= pers;
    freq *= lac;
  }
  return total / maxValue;
}

export function fractal3D(noise3D, x, y, z, octaves, frequency, persistence, lacunarity) {
  const oct = octaves !== undefined ? octaves : NOISE.OCTAVES_DEFAULT;
  let freq = frequency !== undefined ? frequency : NOISE.FREQUENCY_DEFAULT;
  const pers = persistence !== undefined ? persistence : NOISE.PERSISTENCE_DEFAULT;
  const lac = lacunarity !== undefined ? lacunarity : NOISE.LACUNARITY_DEFAULT;

  let amplitude = NOISE.AMPLITUDE_DEFAULT;
  let total = 0;
  let maxValue = 0;
  for (let i = 0; i < oct; i++) {
    total += noise3D(x * freq, y * freq, z * freq) * amplitude;
    maxValue += amplitude;
    amplitude *= pers;
    freq *= lac;
  }
  return total / maxValue;
}

export function fractal4D(noise4D, x, y, z, w, octaves, frequency, persistence, lacunarity) {
  const oct = octaves !== undefined ? octaves : NOISE.OCTAVES_DEFAULT;
  let freq = frequency !== undefined ? frequency : NOISE.FREQUENCY_DEFAULT;
  const pers = persistence !== undefined ? persistence : NOISE.PERSISTENCE_DEFAULT;
  const lac = lacunarity !== undefined ? lacunarity : NOISE.LACUNARITY_DEFAULT;

  let amplitude = NOISE.AMPLITUDE_DEFAULT;
  let total = 0;
  let maxValue = 0;
  for (let i = 0; i < oct; i++) {
    total += noise4D(x * freq, y * freq, z * freq, w * freq) * amplitude;
    maxValue += amplitude;
    amplitude *= pers;
    freq *= lac;
  }
  return total / maxValue;
}

function createVec4() {
  const v = new ARRAY_TYPE(4);
  v[0] = 0;
  v[1] = 0;
  v[2] = 0;
  v[3] = 0;
  return v;
}

const _pool = [];
const _MAX_POOL = 1024;

export function poolAcquire() {
  if (_pool.length > 0) {
    const v = _pool.pop();
    v[0] = 0;
    v[1] = 0;
    v[2] = 0;
    v[3] = 0;
    return v;
  }
  return createVec4();
}

export function poolRelease(v) {
  if (_pool.length >= _MAX_POOL) return;
  _pool.push(v);
}

export function poolReset() {
  _pool.length = 0;
}

export function poolSize() {
  return _pool.length;
}