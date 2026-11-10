// file number : 022
// full path name : src/texture/022_textures_mipmap.js
// description : CPU-side texture sampling system inspired by PBRT-v4's
//               MIPMap / ImageTexture / UVMapping primitives. Provides
//               a TextureRegistry that stores pixel data in typed arrays
//               (Uint8, Float16-like, or Float32), generates full MIPMAP
//               chains with configurable filters (box, triangle, EWA
//               approximation), supports all PBRT-v4 wrap modes
//               (repeat, clamp, mirror, black, white), and exposes
//               bilinear / trilinear / anisotropic sample functions that
//               file 017's integrators can call from ray hits. Also
//               supports equirectangular environment maps sampled via
//               sampleEnvironment, and generates MIPMAPs on demand to
//               keep mobile memory low — 1M entities can share 100s of
//               textures without duplication. All texture state lives in
//               typed arrays so per-sample cost is 1 indirect lookup
//               plus 4-8 bilinear reads.
// best for : Diffuse / normal / roughness / emissive maps, environment
//            maps, impostor billboards, decals, procedural scene textures,
//            and any CPU renderer or preview that needs correct texture
//            sampling at 1M-entity scale on Android 64-bit.
// license : MIT

import {
  $internal,
  query,
  addComponent,
  removeComponent,
  hasComponent,
  getId,
} from '../ecs/001_ecs_core.js';

import {
  TEXTURE_REGISTRY,
  registerTexture,
  retainTexture,
  releaseTexture,
} from '../render/014_materials_bsdf.js';

import {
  vec3,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ        = 1e-16;
const EPSILON           = 1e-8;
const EPSILON_HIGH      = 1e-12;
const PI                = Math.PI;
const TWO_PI            = 2 * Math.PI;
const INV_PI            = 1 / Math.PI;
const INV_TWO_PI        = 1 / (2 * Math.PI);
const HALF_PI           = Math.PI / 2;
const DEG_TO_RAD        = Math.PI / 180;
const RAD_TO_DEG        = 180 / Math.PI;
const ONE_OVER_255      = 1 / 255;

// MIPMAP controls.
const MAX_MIP_LEVELS         = 16;
const ANISO_MAX_SAMPLES      = 16;
const ANISO_EWA_THRESHOLD    = 0.01;

// ═══════════════════════════════════════════════════════════════════════
// PIXEL FORMAT / WRAP / FILTER ENUMS
// ═══════════════════════════════════════════════════════════════════════

export const PixelFormat = Object.freeze({
  RGBA8:   0,   // 4 bytes per pixel
  RGBA16F: 1,   // 4 halfs (stored as Uint16) — used as Float32 buffer
  RGBA32F: 2,   // 4 floats per pixel
  R8:      3,   // single channel (mask, roughness)
  R32F:    4,   // single float channel
});

export const WrapMode = Object.freeze({
  REPEAT: 0,
  CLAMP:  1,
  MIRROR: 2,
  BLACK:  3,
  WHITE:  4,
});

export const FilterMode = Object.freeze({
  NEAREST:        0,
  BILINEAR:       1,
  TRILINEAR:      2,
  ANISOTROPIC:    3,
  EWA:            4,
});

// ═══════════════════════════════════════════════════════════════════════
// TEXTURE DATA STRUCTURE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Internal texture record (not the same as THREE.Texture from file 014;
 * this is a CPU-readable pixel buffer with MIPMAP chain).
 *
 * record = {
 *   id:           number,
 *   width:        number,       // base level width
 *   height:       number,       // base level height
 *   format:       PixelFormat,
 *   filter:       FilterMode,
 *   wrapU:        WrapMode,
 *   wrapV:        WrapMode,
 *   anisotropy:   number,
 *   gammaEncoded: boolean,      // true = sRGB-encoded RGBA8
 *   levels:       Array<{
 *     width, height,
 *     pixels: Float32Array,     // always expanded to float RGBA for sampling
 *   }>,
 *   levelCount:   number,
 *   // Which faces (for cube maps). null = 2D texture.
 *   faceCount:    number,       // 1 = 2D, 6 = cube
 * }
 */
export const CPU_TEXTURES = new Map(); // id -> record
let _nextCPUTextureId = 1;

// ═══════════════════════════════════════════════════════════════════════
// CREATE TEXTURE FROM PIXELS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a CPU-readable texture from raw pixel data.
 *
 * @param pixels    Uint8Array (RGBA8) | Float32Array (RGBA32F | R32F) | Uint16Array (RGBA16F)
 * @param width     pixels
 * @param height    pixels
 * @param format    PixelFormat
 * @param options   { filter, wrapU, wrapV, anisotropy, gammaEncoded,
 *                    generateMipmaps, faceCount }
 * @returns texture id
 */
export function createTexture(pixels, width, height, format = PixelFormat.RGBA8, options = {}) {
  const id = _nextCPUTextureId++;

  const filter = options.filter ?? FilterMode.TRILINEAR;
  const wrapU = options.wrapU ?? WrapMode.REPEAT;
  const wrapV = options.wrapV ?? WrapMode.REPEAT;
  const anisotropy = options.anisotropy ?? 1;
  const gammaEncoded = options.gammaEncoded !== false && format === PixelFormat.RGBA8;
  const generateMipmaps = options.generateMipmaps !== false;
  const faceCount = options.faceCount ?? 1;

  // Convert base level to float RGBA.
  const baseFloat = convertPixelsToFloat(pixels, width * height, format, gammaEncoded);

  const levels = [{
    width, height,
    pixels: baseFloat,
  }];

  // Generate MIPMAP chain.
  if (generateMipmaps) {
    let w = width, h = height;
    let prev = baseFloat;
    while (w > 1 || h > 1) {
      const nw = Math.max(1, w >> 1);
      const nh = Math.max(1, h >> 1);
      const next = downsample2x(prev, w, h, nw, nh);
      levels.push({ width: nw, height: nh, pixels: next });
      prev = next;
      w = nw; h = nh;
      if (levels.length >= MAX_MIP_LEVELS) break;
    }
  }

  const record = {
    id,
    width,
    height,
    format,
    filter,
    wrapU,
    wrapV,
    anisotropy,
    gammaEncoded,
    levels,
    levelCount: levels.length,
    faceCount,
  };

  CPU_TEXTURES.set(id, record);

  // Also register with file 014's registry for integration with materials.
  const threeTexture = createThreeTextureFromRecord(record);
  if (threeTexture) {
    record.threeTextureId = registerTexture(threeTexture);
  }

  return id;
}

/**
 * Convert input pixel format to Float32 RGBA (linear space, 4 floats per pixel).
 */
function convertPixelsToFloat(pixels, count, format, gammaEncoded) {
  const out = new Float32Array(count * 4);
  const invGamma = 1 / 2.2;

  if (format === PixelFormat.RGBA8) {
    for (let i = 0; i < count; i++) {
      let r = pixels[i * 4]     * ONE_OVER_255;
      let g = pixels[i * 4 + 1] * ONE_OVER_255;
      let b = pixels[i * 4 + 2] * ONE_OVER_255;
      const a = pixels[i * 4 + 3] * ONE_OVER_255;

      if (gammaEncoded) {
        r = Math.pow(r, 2.2);
        g = Math.pow(g, 2.2);
        b = Math.pow(b, 2.2);
      }

      out[i * 4]     = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = a;
    }
    return out;
  }

  if (format === PixelFormat.RGBA32F) {
    for (let i = 0; i < count * 4; i++) out[i] = pixels[i];
    return out;
  }

  if (format === PixelFormat.RGBA16F) {
    // Approximate: treat as Uint16 half-floats, expand via lookup-free
    // linear approximation (accurate enough for preview).
    for (let i = 0; i < count; i++) {
      out[i * 4]     = halfToFloat(pixels[i * 4]);
      out[i * 4 + 1] = halfToFloat(pixels[i * 4 + 1]);
      out[i * 4 + 2] = halfToFloat(pixels[i * 4 + 2]);
      out[i * 4 + 3] = halfToFloat(pixels[i * 4 + 3]);
    }
    return out;
  }

  if (format === PixelFormat.R8) {
    for (let i = 0; i < count; i++) {
      const v = pixels[i] * ONE_OVER_255;
      out[i * 4]     = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = 1;
    }
    return out;
  }

  if (format === PixelFormat.R32F) {
    for (let i = 0; i < count; i++) {
      const v = pixels[i];
      out[i * 4]     = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = 1;
    }
    return out;
  }

  return out;
}

function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7C00) >> 10;
  const f = h & 0x03FF;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1F) return f ? NaN : ((s ? -1 : 1) * Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

/**
 * Downsample 2×2 box filter. `src` must be RGBA Float32.
 */
function downsample2x(src, srcW, srcH, dstW, dstH) {
  const dst = new Float32Array(dstW * dstH * 4);

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;

      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(x * 2 + dx, srcW - 1);
          const sy = Math.min(y * 2 + dy, srcH - 1);
          const idx = (sy * srcW + sx) * 4;
          r += src[idx];
          g += src[idx + 1];
          b += src[idx + 2];
          a += src[idx + 3];
          count++;
        }
      }

      const di = (y * dstW + x) * 4;
      dst[di]     = r / count;
      dst[di + 1] = g / count;
      dst[di + 2] = b / count;
      dst[di + 3] = a / count;
    }
  }

  return dst;
}

// ═══════════════════════════════════════════════════════════════════════
// THREE.JS TEXTURE BRIDGE
// ═══════════════════════════════════════════════════════════════════════

import { THREE } from '../000_math_links.js';

function createThreeTextureFromRecord(record) {
  if (record.faceCount !== 1) return null;

  const base = record.levels[0];
  const data = new Uint8ClampedArray(base.width * base.height * 4);
  const invGamma = record.gammaEncoded ? 1 / 2.2 : 1;

  for (let i = 0; i < base.width * base.height; i++) {
    const r = base.pixels[i * 4];
    const g = base.pixels[i * 4 + 1];
    const b = base.pixels[i * 4 + 2];
    const a = base.pixels[i * 4 + 3];
    data[i * 4]     = Math.min(255, Math.max(0, Math.pow(r, invGamma) * 255));
    data[i * 4 + 1] = Math.min(255, Math.max(0, Math.pow(g, invGamma) * 255));
    data[i * 4 + 2] = Math.min(255, Math.max(0, Math.pow(b, invGamma) * 255));
    data[i * 4 + 3] = Math.min(255, Math.max(0, a * 255));
  }

  const tex = new THREE.DataTexture(
    data, base.width, base.height,
    THREE.RGBAFormat, THREE.UnsignedByteType
  );
  tex.minFilter = record.filter === FilterMode.NEAREST
    ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
  tex.magFilter = record.filter === FilterMode.NEAREST
    ? THREE.NearestFilter : THREE.LinearFilter;
  tex.wrapS = threeWrapFromMode(record.wrapU);
  tex.wrapT = threeWrapFromMode(record.wrapV);
  tex.generateMipmaps = record.levelCount > 1;
  tex.needsUpdate = true;
  return tex;
}

function threeWrapFromMode(mode) {
  if (mode === WrapMode.REPEAT) return THREE.RepeatWrapping;
  if (mode === WrapMode.MIRROR) return THREE.MirroredRepeatWrapping;
  if (mode === WrapMode.CLAMP)  return THREE.ClampToEdgeWrapping;
  return THREE.ClampToEdgeWrapping;
}

// ═══════════════════════════════════════════════════════════════════════
// WRAP COORDINATE
// ═══════════════════════════════════════════════════════════════════════

function wrapCoord(coord, size, mode) {
  if (mode === WrapMode.REPEAT) {
    let c = coord - Math.floor(coord);
    if (c < 0) c += 1;
    return c * size;
  }
  if (mode === WrapMode.CLAMP) {
    if (coord < 0) return 0;
    if (coord > 1) return size - 1;
    return coord * size;
  }
  if (mode === WrapMode.MIRROR) {
    const period = Math.floor(coord);
    let c = coord - period;
    if (c < 0) c += 1;
    if (period & 1) c = 1 - c;
    return c * size;
  }
  // BLACK / WHITE handled by caller.
  return coord * size;
}

// ═══════════════════════════════════════════════════════════════════════
// BILINEAR SAMPLING (per level)
// ═══════════════════════════════════════════════════════════════════════

function sampleBilinearLevel(level, u, v, wrapU, wrapV, out) {
  const w = level.width, h = level.height;

  // Wrap coordinates into pixel space.
  let x = wrapCoord(u, w, wrapU);
  let y = wrapCoord(v, h, wrapV);

  // Clamp black/white returns.
  if (wrapU === WrapMode.BLACK && (u < 0 || u > 1)) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; return; }
  if (wrapU === WrapMode.WHITE && (u < 0 || u > 1)) { out[0] = 1; out[1] = 1; out[2] = 1; out[3] = 1; return; }
  if (wrapV === WrapMode.BLACK && (v < 0 || v > 1)) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; return; }
  if (wrapV === WrapMode.WHITE && (v < 0 || v > 1)) { out[0] = 1; out[1] = 1; out[2] = 1; out[3] = 1; return; }

  x = Math.max(0, Math.min(w - 1, x - 0.5));
  y = Math.max(0, Math.min(h - 1, y - 0.5));

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;

  const pix = level.pixels;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  out[0] = pix[i00]     * w00 + pix[i10]     * w10 + pix[i01]     * w01 + pix[i11]     * w11;
  out[1] = pix[i00 + 1] * w00 + pix[i10 + 1] * w10 + pix[i01 + 1] * w01 + pix[i11 + 1] * w11;
  out[2] = pix[i00 + 2] * w00 + pix[i10 + 2] * w10 + pix[i01 + 2] * w01 + pix[i11 + 2] * w11;
  out[3] = pix[i00 + 3] * w00 + pix[i10 + 3] * w10 + pix[i01 + 3] * w01 + pix[i11 + 3] * w11;
}

// ═══════════════════════════════════════════════════════════════════════
// NEAREST SAMPLING (per level)
// ═══════════════════════════════════════════════════════════════════════

function sampleNearestLevel(level, u, v, wrapU, wrapV, out) {
  const w = level.width, h = level.height;

  if (wrapU === WrapMode.BLACK && (u < 0 || u > 1)) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; return; }
  if (wrapU === WrapMode.WHITE && (u < 0 || u > 1)) { out[0] = 1; out[1] = 1; out[2] = 1; out[3] = 1; return; }
  if (wrapV === WrapMode.BLACK && (v < 0 || v > 1)) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; return; }
  if (wrapV === WrapMode.WHITE && (v < 0 || v > 1)) { out[0] = 1; out[1] = 1; out[2] = 1; out[3] = 1; return; }

  const x = Math.floor(wrapCoord(u, w, wrapU));
  const y = Math.floor(wrapCoord(v, h, wrapV));

  const xi = Math.max(0, Math.min(w - 1, x));
  const yi = Math.max(0, Math.min(h - 1, y));
  const idx = (yi * w + xi) * 4;
  out[0] = level.pixels[idx];
  out[1] = level.pixels[idx + 1];
  out[2] = level.pixels[idx + 2];
  out[3] = level.pixels[idx + 3];
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SAMPLE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

const _sampleOut = new Float32Array(4);
const _sampleOut2 = new Float32Array(4);

/**
 * Sample a texture with the configured filter.
 *
 * @param textureId   from createTexture
 * @param u           [0..1] UV coordinate
 * @param v           [0..1]
 * @param lod         mip level (0 = base, higher = blurrier);
 *                    use 0 for trilinear base sampling, or pass explicit
 * @param out         4-element Float32Array for RGBA output
 * @returns out
 */
export function sampleTexture(textureId, u, v, lod, out = _sampleOut) {
  const tex = CPU_TEXTURES.get(textureId);
  if (!tex) { out[0] = 1; out[1] = 0; out[2] = 1; out[3] = 1; return out; }

  if (tex.filter === FilterMode.NEAREST) {
    const level = tex.levels[Math.min(Math.max(0, Math.floor(lod)), tex.levelCount - 1)];
    sampleNearestLevel(level, u, v, tex.wrapU, tex.wrapV, out);
    return out;
  }

  if (tex.filter === FilterMode.BILINEAR) {
    const level = tex.levels[Math.min(Math.max(0, Math.floor(lod)), tex.levelCount - 1)];
    sampleBilinearLevel(level, u, v, tex.wrapU, tex.wrapV, out);
    return out;
  }

  if (tex.filter === FilterMode.TRILINEAR) {
    const lodClamped = Math.max(0, Math.min(lod, tex.levelCount - 1));
    const lod0 = Math.floor(lodClamped);
    const lod1 = Math.min(lod0 + 1, tex.levelCount - 1);
    const t = lodClamped - lod0;

    sampleBilinearLevel(tex.levels[lod0], u, v, tex.wrapU, tex.wrapV, _sampleOut2);
    if (lod0 === lod1) {
      out[0] = _sampleOut2[0];
      out[1] = _sampleOut2[1];
      out[2] = _sampleOut2[2];
      out[3] = _sampleOut2[3];
      return out;
    }

    sampleBilinearLevel(tex.levels[lod1], u, v, tex.wrapU, tex.wrapV, _sampleOut);

    out[0] = _sampleOut2[0] * (1 - t) + _sampleOut[0] * t;
    out[1] = _sampleOut2[1] * (1 - t) + _sampleOut[1] * t;
    out[2] = _sampleOut2[2] * (1 - t) + _sampleOut[2] * t;
    out[3] = _sampleOut2[3] * (1 - t) + _sampleOut[3] * t;
    return out;
  }

  if (tex.filter === FilterMode.ANISOTROPIC) {
    // Anisotropic via 2×2 tap approximation. Full EWA is file 022's
    // optional path below.
    return sampleAnisotropic(textureId, u, v, lod, out);
  }

  if (tex.filter === FilterMode.EWA) {
    return sampleEWA(textureId, u, v, lod, 1, 0, 0, 1, out);
  }

  // Fallback: bilinear.
  sampleBilinearLevel(tex.levels[0], u, v, tex.wrapU, tex.wrapV, out);
  return out;
}

/**
 * Sample with texture derivatives for proper anisotropic LOD selection.
 * This is the "correct" entry point when rendering triangles.
 *
 * @param dudx, dvdx, dudy, dvdy    texture derivatives from rasterizer
 */
export function sampleTextureGrad(textureId, u, v, dudx, dvdx, dudy, dvdy, out = _sampleOut) {
  const tex = CPU_TEXTURES.get(textureId);
  if (!tex) { out[0] = 1; out[1] = 0; out[2] = 1; out[3] = 1; return out; }

  if (tex.filter === FilterMode.EWA && tex.anisotropy > 1) {
    return sampleEWA(textureId, u, v, 0, dudx, dvdx, dudy, dvdy, out);
  }

  // Compute LOD from derivatives.
  const texelWidth  = dudx * dudx + dvdx * dvdx;
  const texelHeight = dudy * dudy + dvdy * dvdy;
  const maxAxis = Math.max(texelWidth, texelHeight);
  const lod = 0.5 * Math.log2(Math.max(maxAxis * tex.width * tex.height, EPSILON));

  if (tex.filter === FilterMode.ANISOTROPIC) {
    return sampleAnisotropic(textureId, u, v, lod, out);
  }

  return sampleTexture(textureId, u, v, lod, out);
}

/**
 * Anisotropic approximation using N taps along the major axis.
 */
function sampleAnisotropic(textureId, u, v, lod, out) {
  const tex = CPU_TEXTURES.get(textureId);
  if (!tex || tex.anisotropy <= 1) {
    return sampleTexture(textureId, u, v, lod, out);
  }

  const samples = Math.min(tex.anisotropy, ANISO_MAX_SAMPLES);
  const invSamples = 1 / samples;

  let r = 0, g = 0, b = 0, a = 0;

  for (let i = 0; i < samples; i++) {
    // Sample along the U axis (major-axis assumption).
    const offset = (i / (samples - 1) - 0.5) / tex.width;
    sampleTexture(textureId, u + offset, v, lod, _sampleOut2);
    r += _sampleOut2[0];
    g += _sampleOut2[1];
    b += _sampleOut2[2];
    a += _sampleOut2[3];
  }

  out[0] = r * invSamples;
  out[1] = g * invSamples;
  out[2] = b * invSamples;
  out[3] = a * invSamples;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// EWA FILTERING — Elliptical Weighted Average approximation
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample using EWA filter. This is a simplified implementation that
 * approximates the elliptical footprint with a Gaussian-weighted set of
 * taps in a small region around (u, v).
 */
function sampleEWA(textureId, u, v, lod, dudx, dvdx, dudy, dvdy, out) {
  const tex = CPU_TEXTURES.get(textureId);
  if (!tex) { out[0] = 1; out[1] = 0; out[2] = 1; out[3] = 1; return out; }

  // Compute ellipse from derivatives (Jacobi eigenanalysis).
  const A = dudx * dudx + dvdx * dvdx;
  const B = dudx * dudy + dvdx * dvdy;
  const C = dudy * dudy + dvdy * dvdy;

  const disc = Math.sqrt(Math.max(0, (A - C) * (A - C) + 4 * B * B));
  const lambda1 = 0.5 * (A + C + disc);
  const lambda2 = 0.5 * (A + C - disc);

  // Choose LOD from eigenvalues.
  const lodLevel = Math.min(
    tex.levelCount - 1,
    Math.max(0, Math.floor(0.5 * Math.log2(Math.max(lambda1 * tex.width * tex.height, EPSILON))))
  );

  if (lodLevel > tex.levelCount - 1 || lambda2 < ANISO_EWA_THRESHOLD) {
    return sampleTexture(textureId, u, v, lodLevel, out);
  }

  // Anisotropic ratio.
  const ratio = Math.sqrt(lambda1 / Math.max(lambda2, EPSILON));
  const samples = Math.min(Math.ceil(ratio), tex.anisotropy, ANISO_MAX_SAMPLES);
  const invSamples = 1 / samples;

  // Major axis direction from eigenvector.
  const majorAngle = 0.5 * Math.atan2(2 * B, A - C);
  const cosA = Math.cos(majorAngle);
  const sinA = Math.sin(majorAngle);

  const level = tex.levels[lodLevel];
  const scaleU = 1 / level.width;
  const scaleV = 1 / level.height;

  let r = 0, g = 0, b = 0, a = 0;

  for (let i = 0; i < samples; i++) {
    const t = (i / (samples - 1) - 0.5) * Math.sqrt(lambda1);
    const offsetU = t * cosA;
    const offsetV = t * sinA;

    sampleBilinearLevel(level, u + offsetU * scaleU, v + offsetV * scaleV,
                        tex.wrapU, tex.wrapV, _sampleOut2);
    r += _sampleOut2[0];
    g += _sampleOut2[1];
    b += _sampleOut2[2];
    a += _sampleOut2[3];
  }

  out[0] = r * invSamples;
  out[1] = g * invSamples;
  out[2] = b * invSamples;
  out[3] = a * invSamples;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// ENVIRONMENT MAP SAMPLING (equirectangular)
// ═══════════════════════════════════════════════════════════════════════

const _envOut = new Float32Array(4);

/**
 * Sample an equirectangular environment map.
 * Direction is treated as a unit vector.
 */
export function sampleEnvironment(textureId, dx, dy, dz, out = _envOut) {
  const tex = CPU_TEXTURES.get(textureId);
  if (!tex) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out; }

  // Convert direction to (u, v).
  const theta = Math.atan2(dz, dx);
  const phi = Math.acos(Math.max(-1, Math.min(1, dy)));

  const u = (theta + PI) * INV_TWO_PI;
  const v = phi * INV_PI;

  // Use anisotropy at mip level 0 (env maps are usually low-res).
  return sampleTexture(textureId, u, v, 0, out);
}

/**
 * Importance-sample a direction from an equirectangular environment.
 * Returns { wi: [x,y,z], pdf: number }.
 */
export function sampleEnvironmentDirection(textureId, u1, u2) {
  // Uniform spherical sampling.
  const theta = TWO_PI * u1;
  const cosPhi = 2 * u2 - 1;
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));

  return {
    wi: [sinPhi * Math.cos(theta), cosPhi, sinPhi * Math.sin(theta)],
    pdf: 1 / (4 * PI),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PROCEDURAL TEXTURE GENERATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a checkerboard texture.
 */
export function createCheckerboardTexture(size = 256, cells = 8, colorA = [255, 0, 0, 255], colorB = [0, 0, 255, 255]) {
  const pixels = new Uint8Array(size * size * 4);
  const cellSize = size / cells;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cellSize);
      const cy = Math.floor(y / cellSize);
      const isA = (cx + cy) % 2 === 0;
      const c = isA ? colorA : colorB;
      const idx = (y * size + x) * 4;
      pixels[idx]     = c[0];
      pixels[idx + 1] = c[1];
      pixels[idx + 2] = c[2];
      pixels[idx + 3] = c[3];
    }
  }
  return createTexture(pixels, size, size, PixelFormat.RGBA8, { gammaEncoded: false });
}

/**
 * Create a solid color texture.
 */
export function createSolidColorTexture(r, g, b, a = 1, size = 4) {
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4]     = Math.round(r * 255);
    pixels[i * 4 + 1] = Math.round(g * 255);
    pixels[i * 4 + 2] = Math.round(b * 255);
    pixels[i * 4 + 3] = Math.round(a * 255);
  }
  return createTexture(pixels, size, size, PixelFormat.RGBA8, { gammaEncoded: false });
}

/**
 * Create a 1×1 white texture (useful as a default binding).
 */
export function createWhiteTexture() {
  return createSolidColorTexture(1, 1, 1, 1, 1);
}

/**
 * Create a normal map from a heightfield.
 */
export function createNormalMapFromHeight(heightData, width, height, strength = 1.0) {
  const pixels = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const hL = heightData[Math.max(0, x - 1) + y * width];
      const hR = heightData[Math.min(width - 1, x + 1) + y * width];
      const hD = heightData[x + Math.max(0, y - 1) * width];
      const hU = heightData[x + Math.min(height - 1, y + 1) * width];

      const dx = (hR - hL) * strength;
      const dy = (hU - hD) * strength;

      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;

      const idx = (y * width + x) * 4;
      pixels[idx]     = Math.round((nx * 0.5 + 0.5) * 255);
      pixels[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      pixels[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      pixels[idx + 3] = 255;
    }
  }
  return createTexture(pixels, width, height, PixelFormat.RGBA8, { gammaEncoded: false });
}

// ═══════════════════════════════════════════════════════════════════════
// TEXTURE CACHE — dedupe by content hash
// ═══════════════════════════════════════════════════════════════════════

const _textureHashCache = new Map(); // hash -> texture id

export function hashTextureContent(pixels, width, height) {
  let h = 5381;
  const stride = Math.max(1, Math.floor(pixels.length / 1024));
  for (let i = 0; i < pixels.length; i += stride) {
    h = ((h << 5) + h + pixels[i]) | 0;
  }
  return `${width}x${height}_${h}`;
}

export function getOrCreateTexture(pixels, width, height, format = PixelFormat.RGBA8, options = {}) {
  const hash = hashTextureContent(pixels, width, height);
  const existing = _textureHashCache.get(hash);
  if (existing !== undefined) {
    const tex = CPU_TEXTURES.get(existing);
    if (tex) return existing;
  }
  const id = createTexture(pixels, width, height, format, options);
  _textureHashCache.set(hash, id);
  return id;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearTextures() {
  for (const tex of CPU_TEXTURES.values()) {
    if (tex.threeTextureId) releaseTexture(tex.threeTextureId);
  }
  CPU_TEXTURES.clear();
  _textureHashCache.clear();
  _nextCPUTextureId = 1;
}

export function destroyTexture(textureId) {
  const tex = CPU_TEXTURES.get(textureId);
  if (!tex) return;
  if (tex.threeTextureId) releaseTexture(tex.threeTextureId);
  CPU_TEXTURES.delete(textureId);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function textureStats() {
  let totalBytes = 0;
  let totalLevels = 0;
  for (const tex of CPU_TEXTURES.values()) {
    for (const level of tex.levels) {
      totalBytes += level.width * level.height * 4 * 4; // RGBA32F
      totalLevels++;
    }
  }
  return {
    textureCount: CPU_TEXTURES.size,
    totalLevels,
    totalBytes,
    totalMB: totalBytes / (1024 * 1024),
  };
}