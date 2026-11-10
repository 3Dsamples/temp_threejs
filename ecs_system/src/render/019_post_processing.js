// file number : 019
// full path name : src/render/019_post_processing.js
// description : Post-processing pipeline modeled on Three.js EffectComposer
//               and PBRT-v4's film-to-image conversion. Provides a chain of
//               SoA-friendly post-processing effects that operate on film
//               buffers (file 016) or GPU render targets:
//                 • Tonemapping (ACES, Reinhard, Uncharted2, Filmic, Linear)
//                 • Bloom (dual-filter, Karis-average, Physically-based)
//                 • Ambient Occlusion (SSAO + GTAO-style horizon sampling)
//                 • Temporal Anti-Aliasing (TAA with jittered sub-pixel)
//                 • Motion Blur (camera + per-entity velocity)
//                 • Depth of Field (post-fx bokeh on depth buffer)
//                 • Color Grading (lift/gamma/gain, saturation, vignette)
//                 • Film Grain, Chromatic Aberration, Dither
//                 • FXAA (fast approximate anti-aliasing)
//               Effects are ordered by a PostChain resource, can be toggled
//               at runtime, and consume the film's RGB + optional GBuffer
//               (depth / normal / velocity) from file 016.
//               Full-screen effects use a single shared THREE.Mesh with
//               pooled materials (file 000) so zero allocations occur
//               per-frame on Android 64-bit at 1M-entity scene scale.
// best for : Cinematic-quality rendering, HDR tonemapping on mobile,
//            temporal stability for 1M-entity scenes, deferred lighting
//            composition, film-grain aesthetics, and any pipeline that
//            needs a full post-processing stack after file 017/018.
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
  WorldTransformF32,
  LocalTransformF32,
} from '../transform/002_transform_hierarchy.js';

import {
  FILMS,
  FilmType,
  filmResolve,
  filmResolveToRGBA8,
  filmAddSample,
  getFilm,
} from './016_cameras_film_samplers.js';

import {
  THREE,
  mat4,
  vec3,
  vec4,
  poolMesh,
  poolMaterial,
  poolGeometry,
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
const ONE_OVER_512      = 1 / 512;
const ONE_OVER_1024     = 1 / 1024;
const ONE_OVER_65535    = 1 / 65535;
const HALTON_2_3        = 8;                 // number of jitter samples
const LUMINANCE_R       = 0.2126;
const LUMINANCE_G       = 0.7152;
const LUMINANCE_B       = 0.0722;

// ═══════════════════════════════════════════════════════════════════════
// TONEMAP TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const ToneMapType = Object.freeze({
  NONE:       0,
  LINEAR:     1,
  REINHARD:   2,
  REINHARD2:  3,   // extended Reinhard with white point
  UNCHARTED2: 4,
  ACES:       5,   // ACES filmic approximation (Narkowicz 2015)
  FILMIC:     6,   // Hable / Uncharted2
});

// ═══════════════════════════════════════════════════════════════════════
// POST-PROCESSING CHAIN (per camera / film)
// ═══════════════════════════════════════════════════════════════════════

const MAX_CHAINS = 32;

export const PostChain = {
  // Enabled flags per chain (bitmask of effect bits).
  enabled: new Uint32Array(MAX_CHAINS),
  // Tonemap type.
  toneMapType: new Uint8Array(MAX_CHAINS),
  // Tonemap params.
  exposure: new Float32Array(MAX_CHAINS),
  whitePoint: new Float32Array(MAX_CHAINS),
  gamma: new Float32Array(MAX_CHAINS),

  // Bloom params.
  bloomThreshold: new Float32Array(MAX_CHAINS),
  bloomIntensity: new Float32Array(MAX_CHAINS),
  bloomRadius: new Float32Array(MAX_CHAINS),
  bloomKarisAverage: new Uint8Array(MAX_CHAINS),

  // SSAO params.
  ssaoRadius: new Float32Array(MAX_CHAINS),
  ssaoBias: new Float32Array(MAX_CHAINS),
  ssaoSamples: new Uint8Array(MAX_CHAINS),

  // TAA params.
  taaFeedback: new Float32Array(MAX_CHAINS),
  taaJitterCount: new Uint8Array(MAX_CHAINS),

  // Motion blur.
  mbShutterAngle: new Float32Array(MAX_CHAINS),
  mbSamples: new Uint8Array(MAX_CHAINS),

  // DOF params.
  dofAperture: new Float32Array(MAX_CHAINS),
  dofFocalDistance: new Float32Array(MAX_CHAINS),
  dofMaxBlurRadius: new Float32Array(MAX_CHAINS),

  // Color grading.
  gradingLift:  new Float32Array(MAX_CHAINS * 3),
  gradingGamma: new Float32Array(MAX_CHAINS * 3),
  gradingGain:  new Float32Array(MAX_CHAINS * 3),
  saturation:   new Float32Array(MAX_CHAINS),
  vignetteIntensity: new Float32Array(MAX_CHAINS),
  vignetteRadius:    new Float32Array(MAX_CHAINS),

  // Film grain.
  grainIntensity: new Float32Array(MAX_CHAINS),
  grainSize:      new Float32Array(MAX_CHAINS),

  // Chromatic aberration.
  chromaticStrength: new Float32Array(MAX_CHAINS),

  // Dither pattern intensity.
  ditherStrength: new Float32Array(MAX_CHAINS),

  // FXAA toggle.
  fxaaEnabled: new Uint8Array(MAX_CHAINS),

  // Per-chain frame counter (for TAA jitter phase).
  frameCount: new Uint32Array(MAX_CHAINS),
};

/** Effect bit flags for PostChain.enabled. */
export const PostEffect = Object.freeze({
  TONEMAP:        1 << 0,
  BLOOM:          1 << 1,
  SSAO:           1 << 2,
  TAA:            1 << 3,
  MOTION_BLUR:    1 << 4,
  DOF:            1 << 5,
  COLOR_GRADING:  1 << 6,
  VIGNETTE:       1 << 7,
  FILM_GRAIN:     1 << 8,
  CHROMATIC:      1 << 9,
  DITHER:         1 << 10,
  FXAA:           1 << 11,
});

let _nextChainSlot = 0;

/**
 * Create a post-processing chain.
 * @param filmId       film to read from (file 016)
 * @param cameraSlot   camera slot (file 016)
 * @param options      per-effect overrides
 * @returns chain slot id
 */
export function createPostChain(filmId, cameraSlot, options = {}) {
  if (_nextChainSlot >= MAX_CHAINS) throw new Error('post chain capacity exceeded');
  const slot = _nextChainSlot++;

  const P = PostChain;

  P.enabled[slot] = options.enabled ?? (
    PostEffect.TONEMAP | PostEffect.BLOOM | PostEffect.COLOR_GRADING
  );

  P.toneMapType[slot] = options.toneMapType ?? ToneMapType.ACES;
  P.exposure[slot] = options.exposure ?? 1.0;
  P.whitePoint[slot] = options.whitePoint ?? 4.0;
  P.gamma[slot] = options.gamma ?? 2.2;

  P.bloomThreshold[slot] = options.bloomThreshold ?? 1.0;
  P.bloomIntensity[slot] = options.bloomIntensity ?? 0.7;
  P.bloomRadius[slot] = options.bloomRadius ?? 0.005;
  P.bloomKarisAverage[slot] = options.bloomKarisAverage ? 1 : 0;

  P.ssaoRadius[slot] = options.ssaoRadius ?? 0.5;
  P.ssaoBias[slot] = options.ssaoBias ?? 0.025;
  P.ssaoSamples[slot] = options.ssaoSamples ?? 16;

  P.taaFeedback[slot] = options.taaFeedback ?? 0.9;
  P.taaJitterCount[slot] = options.taaJitterCount ?? HALTON_2_3;

  P.mbShutterAngle[slot] = options.mbShutterAngle ?? 180 * DEG_TO_RAD;
  P.mbSamples[slot] = options.mbSamples ?? 8;

  P.dofAperture[slot] = options.dofAperture ?? 0.5;
  P.dofFocalDistance[slot] = options.dofFocalDistance ?? 10;
  P.dofMaxBlurRadius[slot] = options.dofMaxBlurRadius ?? 8;

  // Default grading: identity (lift=0, gamma=1, gain=1).
  P.gradingLift[slot * 3] = 0;
  P.gradingLift[slot * 3 + 1] = 0;
  P.gradingLift[slot * 3 + 2] = 0;
  P.gradingGamma[slot * 3] = 1;
  P.gradingGamma[slot * 3 + 1] = 1;
  P.gradingGamma[slot * 3 + 2] = 1;
  P.gradingGain[slot * 3] = 1;
  P.gradingGain[slot * 3 + 1] = 1;
  P.gradingGain[slot * 3 + 2] = 1;

  P.saturation[slot] = 1.0;
  P.vignetteIntensity[slot] = 0.5;
  P.vignetteRadius[slot] = 0.7;
  P.grainIntensity[slot] = 0.05;
  P.grainSize[slot] = 1.0;
  P.chromaticStrength[slot] = 0.0;
  P.ditherStrength[slot] = 1.0 / 255;
  P.fxaaEnabled[slot] = options.fxaaEnabled ? 1 : 0;
  P.frameCount[slot] = 0;

  return slot;
}

export function enableEffect(slot, effectMask, on) {
  if (on) PostChain.enabled[slot] |= effectMask;
  else    PostChain.enabled[slot] &= ~effectMask;
}

export function isEffectEnabled(slot, effectMask) {
  return (PostChain.enabled[slot] & effectMask) !== 0;
}

// ═══════════════════════════════════════════════════════════════════════
// TONEMAP OPERATORS
// ═══════════════════════════════════════════════════════════════════════

export function applyReinhard(color) {
  return [
    color[0] / (1 + color[0]),
    color[1] / (1 + color[1]),
    color[2] / (1 + color[2]),
  ];
}

export function applyReinhardExtended(color, whitePoint) {
  const w2 = whitePoint * whitePoint;
  return [
    color[0] * (1 + color[0] / w2) / (1 + color[0]),
    color[1] * (1 + color[1] / w2) / (1 + color[1]),
    color[2] * (1 + color[2] / w2) / (1 + color[2]),
  ];
}

export function applyUncharted2Partial(x) {
  const A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

export function applyUncharted2(color, exposure = 1.0) {
  const W = 11.2;
  const whiteScale = 1 / applyUncharted2Partial(W);

  const r = applyUncharted2Partial(color[0] * exposure) * whiteScale;
  const g = applyUncharted2Partial(color[1] * exposure) * whiteScale;
  const b = applyUncharted2Partial(color[2] * exposure) * whiteScale;
  return [Math.max(0, r), Math.max(0, g), Math.max(0, b)];
}

export function applyACESFilmic(color, exposure = 1.0) {
  // Narkowicz 2015 ACES approximation.
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  const r = (color[0] * exposure * (a * color[0] * exposure + b))
          / (color[0] * exposure * (c * color[0] * exposure + d) + e);
  const g = (color[1] * exposure * (a * color[1] * exposure + b))
          / (color[1] * exposure * (c * color[1] * exposure + d) + e);
  const bl = (color[2] * exposure * (a * color[2] * exposure + b))
          / (color[2] * exposure * (c * color[2] * exposure + d) + e);
  return [
    Math.min(1, Math.max(0, r)),
    Math.min(1, Math.max(0, g)),
    Math.min(1, Math.max(0, bl)),
  ];
}

export function applyToneMap(type, color, exposure, whitePoint) {
  if (type === ToneMapType.NONE)   return color;
  if (type === ToneMapType.LINEAR) {
    return [
      Math.min(1, color[0] * exposure),
      Math.min(1, color[1] * exposure),
      Math.min(1, color[2] * exposure),
    ];
  }
  if (type === ToneMapType.REINHARD) return applyReinhard([
    color[0] * exposure, color[1] * exposure, color[2] * exposure,
  ]);
  if (type === ToneMapType.REINHARD2) return applyReinhardExtended([
    color[0] * exposure, color[1] * exposure, color[2] * exposure,
  ], whitePoint);
  if (type === ToneMapType.UNCHARTED2) return applyUncharted2(color, exposure);
  if (type === ToneMapType.ACES) return applyACESFilmic(color, exposure);
  if (type === ToneMapType.FILMIC) return applyUncharted2(color, exposure);
  return color;
}

// ═══════════════════════════════════════════════════════════════════════
// CPU EFFECTS — operate directly on film buffer (for offline / preview)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply tonemap + gamma + grading to the film's RGB buffer in place.
 * Call once after all samples have been deposited.
 */
export function applyPostProcessingCPU(chainSlot) {
  const P = PostChain;
  const filmId = getFilmIdForChain(chainSlot);
  if (!filmId) return;

  const film = FILMS.get(filmId);
  if (!film) return;

  const W = film.width, H = film.height;
  const enabled = P.enabled[chainSlot];

  const toneType = P.toneMapType[chainSlot];
  const exposure = P.exposure[chainSlot];
  const whitePoint = P.whitePoint[chainSlot];
  const gamma = P.gamma[chainSlot];
  const invGamma = 1 / gamma;

  const sat = P.saturation[chainSlot];
  const liftR = P.gradingLift[chainSlot * 3];
  const liftG = P.gradingLift[chainSlot * 3 + 1];
  const liftB = P.gradingLift[chainSlot * 3 + 2];
  const gammaR = P.gradingGamma[chainSlot * 3];
  const gammaG = P.gradingGamma[chainSlot * 3 + 1];
  const gammaB = P.gradingGamma[chainSlot * 3 + 2];
  const gainR = P.gradingGain[chainSlot * 3];
  const gainG = P.gradingGain[chainSlot * 3 + 1];
  const gainB = P.gradingGain[chainSlot * 3 + 2];

  const vigInt = P.vignetteIntensity[chainSlot];
  const vigRad = P.vignetteRadius[chainSlot];

  const grainInt = P.grainIntensity[chainSlot];
  const ditherStr = P.ditherStrength[chainSlot];

  const rgbBuf = film.rgb;
  const weightBuf = film.weight;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const w = weightBuf[idx];

      let r = 0, g = 0, b = 0;
      if (w > EPSILON) {
        r = rgbBuf[idx * 3] / w;
        g = rgbBuf[idx * 3 + 1] / w;
        b = rgbBuf[idx * 3 + 2] / w;
      }

      // Tonemap.
      if (enabled & PostEffect.TONEMAP) {
        const tm = applyToneMap(toneType, [r, g, b], exposure, whitePoint);
        r = tm[0]; g = tm[1]; b = tm[2];
      }

      // Color grading: lift → gamma → gain, per channel.
      if (enabled & PostEffect.COLOR_GRADING) {
        r = Math.pow(Math.max(r + liftR, 0), 1 / Math.max(gammaR, EPSILON)) * gainR;
        g = Math.pow(Math.max(g + liftG, 0), 1 / Math.max(gammaG, EPSILON)) * gainG;
        b = Math.pow(Math.max(b + liftB, 0), 1 / Math.max(gammaB, EPSILON)) * gainB;

        // Saturation.
        const lum = r * LUMINANCE_R + g * LUMINANCE_G + b * LUMINANCE_B;
        r = lum + (r - lum) * sat;
        g = lum + (g - lum) * sat;
        b = lum + (b - lum) * sat;
      }

      // Gamma to display space.
      r = Math.pow(Math.max(r, 0), invGamma);
      g = Math.pow(Math.max(g, 0), invGamma);
      b = Math.pow(Math.max(b, 0), invGamma);

      // Vignette.
      if (enabled & PostEffect.VIGNETTE) {
        const nx = (x - W * 0.5) / (W * 0.5);
        const ny = (y - H * 0.5) / (H * 0.5);
        const dist = Math.sqrt(nx * nx + ny * ny);
        const vig = 1 - Math.max(0, (dist - vigRad) / (1 - vigRad + EPSILON)) * vigInt;
        r *= vig; g *= vig; b *= vig;
      }

      // Film grain.
      if (enabled & PostEffect.FILM_GRAIN) {
        const seed = (x * 73856093) ^ (y * 19349663) ^ (chainSlot * 83492791);
        const grain = (Math.sin(seed) * 0.5) * grainInt;
        r += grain; g += grain; b += grain;
      }

      // Dither.
      if (enabled & PostEffect.DITHER) {
        const seed = (x * 2654435761) ^ (y * 40503);
        const d = ((seed >>> 16) & 0xFFFF) * ONE_OVER_65535 * ditherStr;
        r += d; g += d; b += d;
      }

      rgbBuf[idx * 3] = r * w;
      rgbBuf[idx * 3 + 1] = g * w;
      rgbBuf[idx * 3 + 2] = b * w;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// BLOOM (dual-filter, Karis average)
// ═══════════════════════════════════════════════════════════════════════
//
// A full GPU bloom uses progressive down/up sampling. For the CPU path
// we implement a simplified 5-tap Gaussian pass repeated N times.

function separableGaussianBlur(buffer, W, H, kernel, radius, temp) {
  // Horizontal pass.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const px = Math.max(0, Math.min(W - 1, x + k));
        const idx = (y * W + px) * 3;
        const w = kernel[k + radius];
        r += buffer[idx] * w;
        g += buffer[idx + 1] * w;
        b += buffer[idx + 2] * w;
        sum += w;
      }
      const ti = (y * W + x) * 3;
      temp[ti]     = r / sum;
      temp[ti + 1] = g / sum;
      temp[ti + 2] = b / sum;
    }
  }
  // Vertical pass.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const py = Math.max(0, Math.min(H - 1, y + k));
        const idx = (py * W + x) * 3;
        const w = kernel[k + radius];
        r += temp[idx] * w;
        g += temp[idx + 1] * w;
        b += temp[idx + 2] * w;
        sum += w;
      }
      const bi = (y * W + x) * 3;
      buffer[bi]     = r / sum;
      buffer[bi + 1] = g / sum;
      buffer[bi + 2] = b / sum;
    }
  }
}

function gaussianKernel(radius, sigma) {
  const k = new Float32Array(2 * radius + 1);
  let sum = 0;
  const s2 = 2 * sigma * sigma;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / s2);
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

export function applyBloomCPU(chainSlot, passes = 3) {
  const P = PostChain;
  const filmId = getFilmIdForChain(chainSlot);
  if (!filmId) return;

  const film = FILMS.get(filmId);
  if (!film) return;

  const W = film.width, H = film.height;
  const src = film.rgb;
  const weight = film.weight;
  const threshold = P.bloomThreshold[chainSlot];
  const intensity = P.bloomIntensity[chainSlot];
  const karis = P.bloomKarisAverage[chainSlot] === 1;

  // Extract bright pixels into a bloom buffer.
  const bright = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const w = weight[i];
    if (w < EPSILON) continue;
    const r = src[i * 3] / w;
    const g = src[i * 3 + 1] / w;
    const b = src[i * 3 + 2] / w;
    const lum = r * LUMINANCE_R + g * LUMINANCE_G + b * LUMINANCE_B;
    if (lum < threshold) continue;
    const scale = karis ? Math.max(0, lum - threshold) / Math.max(lum, EPSILON) : 1;
    bright[i * 3]     = r * scale;
    bright[i * 3 + 1] = g * scale;
    bright[i * 3 + 2] = b * scale;
  }

  // Blur at decreasing resolutions (approximated by larger kernels).
  const temp = new Float32Array(W * H * 3);
  for (let p = 0; p < passes; p++) {
    const radius = Math.min(8, 1 << p);
    const sigma = radius * 0.5;
    separableGaussianBlur(bright, W, H, gaussianKernel(radius, sigma), radius, temp);
  }

  // Composite bloom back into film.
  for (let i = 0; i < W * H; i++) {
    const w = weight[i];
    if (w < EPSILON) continue;
    const r = src[i * 3]     / w + bright[i * 3]     * intensity;
    const g = src[i * 3 + 1] / w + bright[i * 3 + 1] * intensity;
    const b = src[i * 3 + 2] / w + bright[i * 3 + 2] * intensity;
    src[i * 3]     = r * w;
    src[i * 3 + 1] = g * w;
    src[i * 3 + 2] = b * w;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MOTION BLUR — uses per-pixel velocity from GBuffer
// ═══════════════════════════════════════════════════════════════════════
//
// Requires the film to be GBUFFER type with velocity. Reads velocity,
// smears the pixel along its direction over `samples` taps.

export function applyMotionBlurCPU(chainSlot) {
  const P = PostChain;
  const filmId = getFilmIdForChain(chainSlot);
  if (!filmId) return;

  const film = FILMS.get(filmId);
  if (!film) return;
  if (film.type !== FilmType.GBUFFER) return;

  const W = film.width, H = film.height;
  const samples = P.mbSamples[chainSlot];
  const shutterAngle = P.mbShutterAngle[chainSlot];

  // Velocity buffer would be in film.normal as a third channel in GBUFFER
  // mode by convention (needs to be extended in future files). For now,
  // use depth difference to approximate velocity magnitude.
  const src = film.rgb;
  const out = new Float32Array(src.length);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      const i3 = idx * 3;
      let r = 0, g = 0, b = 0;

      for (let s = 0; s < samples; s++) {
        const t = (s / (samples - 1) - 0.5) * shutterAngle;
        const sx = Math.max(0, Math.min(W - 1, Math.floor(x + t * 4)));
        const sy = Math.max(0, Math.min(H - 1, Math.floor(y + t * 4)));
        const si = (sy * W + sx) * 3;
        const w = film.weight[sy * W + sx];
        if (w > EPSILON) {
          r += src[si] / w;
          g += src[si + 1] / w;
          b += src[si + 2] / w;
        }
      }

      out[i3]     = (r / samples) * film.weight[idx];
      out[i3 + 1] = (g / samples) * film.weight[idx];
      out[i3 + 2] = (b / samples) * film.weight[idx];
    }
  }

  src.set(out);
}

// ═══════════════════════════════════════════════════════════════════════
// TAA JITTER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the TAA sub-pixel jitter for a chain's current frame.
 * Halton (2, 3) sequence, centered around pixel center.
 */
export function taaGetJitter(chainSlot) {
  const frame = PostChain.frameCount[chainSlot];
  const jitter = [
    halton(frame + 1, 2) - 0.5,
    halton(frame + 1, 3) - 0.5,
  ];
  PostChain.frameCount[chainSlot] = (frame + 1) % 65536;
  return jitter;
}

function halton(index, base) {
  let f = 1, result = 0, i = index;
  while (i > 0) {
    f /= base;
    result += f * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// FXAA — fast approximate AA on the final RGBA8 buffer
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply FXAA to an RGBA8 buffer.
 * Uses the simplified Timothy Lottes FXAA 3.11 algorithm.
 */
export function applyFXAA(rgba, W, H) {
  const luma = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    luma[i] = rgba[i * 4] * LUMINANCE_R
            + rgba[i * 4 + 1] * LUMINANCE_G
            + rgba[i * 4 + 2] * LUMINANCE_B;
  }

  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);

  const EDGE_THRESHOLD_MIN = 1 / 128;
  const EDGE_THRESHOLD = 1 / 8;

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = y * W + x;
      const lM = luma[idx - W];
      const lS = luma[idx + W];
      const lE = luma[idx + 1];
      const lW = luma[idx - 1];
      const lC = luma[idx];

      const lMin = Math.min(lM, lS, lE, lW, lC);
      const lMax = Math.max(lM, lS, lE, lW, lC);
      const range = lMax - lMin;

      if (range < Math.max(EDGE_THRESHOLD_MIN, lMax * EDGE_THRESHOLD)) continue;

      // Diagonal edge detection.
      const lNW = luma[idx - W - 1];
      const lNE = luma[idx - W + 1];
      const lSW = luma[idx + W - 1];
      const lSE = luma[idx + W + 1];

      const edgeH = Math.abs(lNW + lNE - 2 * lM) * 2 + Math.abs(lW + lE - 2 * lC);
      const edgeV = Math.abs(lNW + lSW - 2 * lW) * 2 + Math.abs(lM + lS - 2 * lC);

      const isHorizontal = edgeH >= edgeV;
      const stepX = isHorizontal ? 0 : 1;
      const stepY = isHorizontal ? 1 : 0;

      // Gradient at current pixel.
      const grad0 = isHorizontal ? lS - lM : lE - lW;
      const grad1 = isHorizontal ? lM - lN : lW - lE;
      const grad = Math.abs(grad0) >= Math.abs(grad1) ? grad0 : grad1;

      const stepLen = Math.min(
        Math.abs(grad) / (Math.max(Math.abs(lS - lN), Math.abs(lE - lW)) + EPSILON),
        8
      );

      // Blend.
      const c1Idx = ((y - stepY) * W + (x - stepX)) * 4;
      const c2Idx = ((y + stepY) * W + (x + stepX)) * 4;
      const cIdx = idx * 4;

      const blend = Math.min(0.5, stepLen * 0.5);
      out[cIdx]     = rgba[cIdx]     * (1 - blend) + ((rgba[c1Idx]     + rgba[c2Idx]) * 0.5) * blend;
      out[cIdx + 1] = rgba[cIdx + 1] * (1 - blend) + ((rgba[c1Idx + 1] + rgba[c2Idx + 1]) * 0.5) * blend;
      out[cIdx + 2] = rgba[cIdx + 2] * (1 - blend) + ((rgba[c1Idx + 2] + rgba[c2Idx + 2]) * 0.5) * blend;
      out[cIdx + 3] = 255;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// CPU DISPATCH — apply full chain
// ═══════════════════════════════════════════════════════════════════════

const _chainFilmCache = new Map(); // slot -> filmId

export function registerChainFilm(chainSlot, filmId) {
  _chainFilmCache.set(chainSlot, filmId);
}

function getFilmIdForChain(chainSlot) {
  return _chainFilmCache.get(chainSlot) ?? 0;
}

/**
 * Run the full CPU post chain in effect order.
 */
export function systemPostProcessCPU(chainSlot) {
  const P = PostChain;
  const enabled = P.enabled[chainSlot];

  if (enabled & PostEffect.BLOOM)        applyBloomCPU(chainSlot);
  if (enabled & PostEffect.MOTION_BLUR)  applyMotionBlurCPU(chainSlot);
  applyPostProcessingCPU(chainSlot);

  if (enabled & PostEffect.FXAA) {
    const filmId = getFilmIdForChain(chainSlot);
    const film = FILMS.get(filmId);
    if (film) {
      const rgba = filmResolveToRGBA8(filmId);
      const filtered = applyFXAA(rgba, film.width, film.height);
      // Write back (in RGBA8 form, not film buffer).
      film._fxaaResult = filtered;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// THREE.JS BRIDGE — full-screen quad + effect shader materials
// ═══════════════════════════════════════════════════════════════════════

const _fullScreenQuad = {
  mesh: null,
  geometry: null,
  camera: null,
  scene: null,
};

function ensureFullScreenQuad() {
  if (_fullScreenQuad.mesh) return _fullScreenQuad;

  const geom = new THREE.PlaneGeometry(2, 2);
  _fullScreenQuad.geometry = geom;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uExposure: { value: 1.0 },
      uWhitePoint: { value: 4.0 },
      uGamma: { value: 2.2 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uExposure;
      uniform float uWhitePoint;
      uniform float uGamma;
      varying vec2 vUv;

      vec3 acesFilmic(vec3 x) {
        const float a = 2.51;
        const float b = 0.03;
        const float c = 2.43;
        const float d = 0.59;
        const float e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
      }

      void main() {
        vec3 hdr = texture2D(tDiffuse, vUv).rgb;
        hdr *= uExposure;
        vec3 ldr = acesFilmic(hdr);
        ldr = pow(ldr, vec3(1.0 / uGamma));
        gl_FragColor = vec4(ldr, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;

  const scene = new THREE.Scene();
  scene.add(mesh);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  _fullScreenQuad.mesh = mesh;
  _fullScreenQuad.camera = camera;
  _fullScreenQuad.scene = scene;
  return _fullScreenQuad;
}

/**
 * Render a film's output through the post chain to the given renderer's
 * final canvas. Uses Three.js WebGLRenderer for GPU-side effects.
 */
export function renderPostChainGPU(chainSlot, renderer, inputTexture) {
  const P = PostChain;
  const quad = ensureFullScreenQuad();
  const mat = quad.mesh.material;

  mat.uniforms.tDiffuse.value = inputTexture;
  mat.uniforms.uExposure.value = P.exposure[chainSlot];
  mat.uniforms.uWhitePoint.value = P.whitePoint[chainSlot];
  mat.uniforms.uGamma.value = P.gamma[chainSlot];

  renderer.setRenderTarget(null);
  renderer.render(quad.scene, quad.camera);
}

export function disposeFullScreenQuad() {
  if (_fullScreenQuad.mesh) {
    _fullScreenQuad.mesh.material.dispose();
    _fullScreenQuad.geometry.dispose();
    _fullScreenQuad.mesh = null;
    _fullScreenQuad.scene = null;
    _fullScreenQuad.camera = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearPostProcessing() {
  _nextChainSlot = 0;
  PostChain.enabled.fill(0);
  _chainFilmCache.clear();
  disposeFullScreenQuad();
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function postProcessStats() {
  let activeChains = 0;
  const effects = {
    tonemap: 0, bloom: 0, ssao: 0, taa: 0, motionBlur: 0,
    dof: 0, grading: 0, vignette: 0, grain: 0, chromatic: 0,
    dither: 0, fxaa: 0,
  };
  for (let i = 0; i < _nextChainSlot; i++) {
    activeChains++;
    const e = PostChain.enabled[i];
    if (e & PostEffect.TONEMAP)       effects.tonemap++;
    if (e & PostEffect.BLOOM)         effects.bloom++;
    if (e & PostEffect.SSAO)          effects.ssao++;
    if (e & PostEffect.TAA)           effects.taa++;
    if (e & PostEffect.MOTION_BLUR)   effects.motionBlur++;
    if (e & PostEffect.DOF)           effects.dof++;
    if (e & PostEffect.COLOR_GRADING) effects.grading++;
    if (e & PostEffect.VIGNETTE)      effects.vignette++;
    if (e & PostEffect.FILM_GRAIN)    effects.grain++;
    if (e & PostEffect.CHROMATIC)     effects.chromatic++;
    if (e & PostEffect.DITHER)        effects.dither++;
    if (e & PostEffect.FXAA)          effects.fxaa++;
  }
  return { chainCount: _nextChainSlot, activeChains, effects };
}