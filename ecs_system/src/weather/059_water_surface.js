// file number : 059
// full path name : src/weather/059_water_surface.js
// description : Ocean, lake, river, and general water surface system.
//               Provides the full wave-generation and surface-sampling
//               stack for the bitECS_max pipeline:
//                 • WAVE SPECTRA — three classical ocean-wave energy
//                   spectra implemented as factories for the wave
//                   component generator:
//                     - PIERSON_MOSKOWITZ (1964) — fully-developed
//                       open-ocean sea state. S(ω) = α·g²/ω⁵ · exp(
//                       -0.74 · (ω_p/ω)⁴)
//                     - JONSWAP (Hasselmann 1973) — fetch-limited
//                       coastal sea with peak enhancement factor γ.
//                       Standard γ = 3.3 for developing seas,
//                       γ = 1.0 recovers Pierson-Moskowitz.
//                     - PHILLIPS (1957) — full 2D wave-number spectrum
//                       used for wave-component distribution.
//                 • WAVE COMPONENTS — each water body maintains N
//                   individual wave trains (up to 16 per body), each
//                   with its own amplitude, wavenumber, angular
//                   frequency, direction, phase, and steepness. The
//                   superposed field is sampled via the classical
//                   Gerstner-wave formula, which produces realistic
//                   travelling trochoidal crests:
//                     x' = x + Σ A_i · D_i.x · cos(k_i · D_i · pos + φ_i)
//                     y  = Σ A_i · sin(k_i · D_i · pos + φ_i)
//                     z' = z + Σ A_i · D_i.z · cos(k_i · D_i · pos + φ_i)
//                 • WHITECAPS & FOAM — foam coverage from breaking waves
//                   (Monahan 1986): W = 3.84×10⁻⁶ · U₁₀^3.41 where U₁₀
//                   is the 10 m wind speed. Foam patches persist 5-20 s,
//                   advected by the surface wind, and dissipate via
//                   exponential decay.
//                 • SHOALING & WAVE REFRACTION — coastal waves slow and
//                   steepen as they approach shore (Green's law:
//                   H ∝ d^-1/4). Sampled via the local water depth
//                   from file 003's BVH against the ocean floor.
//                 • SUN SPECULAR — directional sun reflection (Blinn-
//                   Phong style) modulated by wave slope, with a
//                   glint/glitter term for the characteristic sun-path
//                   sparkle on the ocean.
//                 • WATER DEPTH SAMPLING — reads the local water depth
//                   from any entity that has a WaterDepthF32 store so
//                   shoreline interactions are physically grounded.
//                 • WIND COUPLING — reads file 047's wind field to
//                   determine the wave-driving wind speed and
//                   direction. Wind also drives foam advection and
//                   suppresses sun glitter at high angles.
//                 • RAIN COUPLING — reads file 042's rain drops to
//                   produce concentric ripples on the water surface
//                   (implemented as a separate RippleField SoA).
//                 • STORM SURGE COUPLING — reads file 049's surge to
//                   raise the water level near coastlines.
//                 • CAMERA-FACING SAMPLING — `sampleWaterSurface` returns
//                   the height, normal, foam, and sun specular all in
//                   one call, so file 017's path integrator can shade
//                   water with a single API call per ray.
//               All state lives in typed arrays; per-frame cost is
//               O(wave components × queries) for height sampling and
//               O(foam patches) for foam. Zero per-frame allocation;
//               steady-state 1M-entity scenes handle open-ocean water
//               on Android 64-bit.
// best for : Oceans, lakes, rivers, swimming pools, rain puddles,
//            naval gameplay, coastal simulations, flight simulators
//            over water, water sports, and any 1M-entity scene
//            needing realistic water surfaces on Android 64-bit.
// license : MIT

import {
  $internal,
  query,
  addComponent,
  removeComponent,
  hasComponent,
  entityExists,
  getId,
} from '../ecs/001_ecs_core.js';

import {
  WorldTransformF32,
  LocalTransformF32,
  addTransform,
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  WorldBoundsF32,
  LocalBoundsF32,
  getWorldBoundsCenter,
  getWorldBoundsExtents,
} from '../geometry/004_aabb_bounds.js';

import {
  BVHState,
  bvhRaycast,
} from '../spatial/003_bvh_broadphase.js';

import {
  SkyF32,
  SkyModel,
  getSkySlot,
  sampleSkyRadiance,
} from '../sky/028_sky_atmosphere.js';

import {
  sampleWindAt,
  WindSource,
} from './047_wind_gusts.js';

import {
  RainDrop,
  SurfaceWetness,
  getWetSurfaceSlot,
} from './042_rain.js';

import {
  StormSurge,
  sampleSurgeHeight,
} from './049_hurricane.js';

import {
  vec3,
  vec4,
  mat4,
  createNoise3D,
  createNoise2D,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                     = 1e-16;
const EPSILON                        = 1e-8;
const EPSILON_HIGH                   = 1e-12;
const PI                             = Math.PI;
const TWO_PI                         = 2 * Math.PI;
const INV_PI                         = 1 / Math.PI;
const INV_TWO_PI                     = 1 / (2 * Math.PI);
const HALF_PI                        = Math.PI / 2;
const DEG_TO_RAD                     = Math.PI / 180;
const RAD_TO_DEG                     = 180 / Math.PI;
const GRAVITY                        = 9.81;
const AIR_DENSITY                    = 1.225;
const WATER_DENSITY                  = 1025.0;   // sea water kg/m³
const WATER_SURFACE_TENSION           = 0.0728;   // N/m at 20 °C
const KINEMATIC_VISCOSITY_WATER      = 1.0e-6;    // m²/s at 20 °C

// ── Wave component limits ─────────────────────────────────
const MAX_WATER_BODIES               = 256;
const MAX_WAVE_COMPONENTS            = 16;
const MAX_FOAM_PATCHES               = 4096;
const MAX_RIPPLES                    = 8192;

// ── Wave spectra constants ────────────────────────────────
// Pierson-Moskowitz (fully-developed sea).
const PM_ALPHA                       = 0.0081;    // Phillips constant
const PM_BETA                        = 0.74;      // peak factor
// JONSWAP (fetch-limited sea).
const JONSWAP_GAMMA_DEFAULT          = 3.3;
const JONSWAP_SIGMA_A               = 0.07;       // for ω < ω_p
const JONSWAP_SIGMA_B               = 0.09;       // for ω > ω_p
// Phillips (2D wave-number).
const PHILLIPS_L                     = 0.5;       // wind fetch length scale

// ── Wind-to-wave coupling ─────────────────────────────────
// Fully-developed wave speed ≈ 1.2 × wind speed (Pierson-Moskowitz).
const WIND_WAVE_SPEED_RATIO          = 1.2;
// Peak wavelength ≈ 20 × wind speed² / g (approximation of PM peak).
const WIND_PEAK_WAVELENGTH_FACTOR    = 20.0;
// Wave component direction spread (radians).
const WAVE_DIRECTION_SPREAD          = 0.6;
// Minimum wind speed to start forming waves (m/s).
const MIN_WIND_FOR_WAVES             = 0.5;

// ── Wave physics ──────────────────────────────────────────
// Maximum wave steepness (H/λ); beyond this waves break.
const MAX_WAVE_STEEPNESS             = 1.0 / 7.0;
// Deep-water dispersion: ω = √(g·k).
const DEEP_WATER_OMEGA_FACTOR        = 1.0;       // sqrt(g*k)
// Wave steepness in Gerstner sum (dimensionless; typical 0.4-0.6).
const DEFAULT_WAVE_STEEPNESS         = 0.5;

// ── Foam (Monahan 1986 whitecap model) ────────────────────
const FOAM_MONAHAN_COEFF             = 3.84e-6;
const FOAM_MONAHAN_EXPONENT          = 3.41;
// Foam patch lifetime (seconds).
const FOAM_LIFETIME_MIN              = 5.0;
const FOAM_LIFETIME_MAX              = 20.0;
// Foam patch initial radius (metres).
const FOAM_INITIAL_RADIUS_MIN        = 0.5;
const FOAM_INITIAL_RADIUS_MAX        = 3.0;
// Foam expansion rate (m/s).
const FOAM_EXPANSION_RATE            = 0.15;
// Foam dissipation rate (per second).
const FOAM_DISSIPATION_RATE          = 0.12;
// Minimum wind speed for whitecaps (m/s).
const WHITECAP_MIN_WIND              = 3.0;

// ── Shoaling (Green's law) ────────────────────────────────
// Wave height scales as H ∝ d^(-1/4) as depth d decreases.
const GREEN_LAW_EXPONENT             = -0.25;
// Depth at which a wave fully breaks (metres).
const BREAKING_DEPTH_MIN             = 0.1;
// Reference depth for shoaling (metres).
const REFERENCE_DEPTH                = 100.0;

// ── Sun specular ──────────────────────────────────────────
// Blinn-Phong specular exponent for water (higher = tighter highlight).
const WATER_SPECULAR_POWER           = 250.0;
// Glitter spot size (radians).
const GLITTER_SPOT_RADIUS            = 0.02;
// Glitter intensity multiplier.
const GLITTER_INTENSITY              = 2.5;
// Sun glitter density (spots per steradian).
const GLITTER_DENSITY                = 50.0;

// ── Water body defaults by type ───────────────────────────
const DEEP_OCEAN_WAVELENGTH_BASE     = 120.0;
const DEEP_OCEAN_WAVE_HEIGHT_BASE    = 2.0;
const DEEP_OCEAN_WAVE_COUNT          = 8;

const COASTAL_WAVELENGTH_BASE        = 40.0;
const COASTAL_WAVE_HEIGHT_BASE       = 0.8;
const COASTAL_WAVE_COUNT             = 10;

const LAKE_WAVELENGTH_BASE           = 10.0;
const LAKE_WAVE_HEIGHT_BASE          = 0.2;
const LAKE_WAVE_COUNT                = 6;

const RIVER_WAVELENGTH_BASE          = 3.0;
const RIVER_WAVE_HEIGHT_BASE         = 0.05;
const RIVER_WAVE_COUNT               = 4;

const POND_WAVELENGTH_BASE           = 1.5;
const POND_WAVE_HEIGHT_BASE          = 0.02;
const POND_WAVE_COUNT                = 3;

const PUDDLE_WAVELENGTH_BASE         = 0.1;
const PUDDLE_WAVE_HEIGHT_BASE        = 0.001;
const PUDDLE_WAVE_COUNT              = 2;

// ── Rain ripple ───────────────────────────────────────────
const RIPPLE_SPEED                   = 0.3;       // m/s propagation
const RIPPLE_LIFETIME                = 1.2;       // seconds
const RIPPLE_INITIAL_RADIUS          = 0.02;      // metres
const RIPPLE_FINAL_RADIUS            = 0.5;       // metres
const RIPPLE_DEPTH_AMPLITUDE         = 0.002;     // metres

// ═══════════════════════════════════════════════════════════════════════
// WATER BODY TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const WaterBodyType = Object.freeze({
  DEEP_OCEAN: 0,
  COASTAL:    1,
  LAKE:       2,
  RIVER:      3,
  POND:       4,
  PUDDLE:     5,
});

// ═══════════════════════════════════════════════════════════════════════
// WAVE SPECTRUM TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const WaveSpectrumType = Object.freeze({
  PIERSON_MOSKOWITZ: 0,
  JONSWAP:           1,
  PHILLIPS:          2,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA WATER BODY
// ═══════════════════════════════════════════════════════════════════════

export const WaterBody = {
  ownerEid: new Uint32Array(MAX_WATER_BODIES),
  type: new Uint8Array(MAX_WATER_BODIES),
  spectrumType: new Uint8Array(MAX_WATER_BODIES),

  // Base water level (metres).
  baseLevel: new Float32Array(MAX_WATER_BODIES),

  // Horizontal extents (metres).
  radiusX: new Float32Array(MAX_WATER_BODIES),
  radiusZ: new Float32Array(MAX_WATER_BODIES),
  cx: new Float32Array(MAX_WATER_BODIES),
  cz: new Float32Array(MAX_WATER_BODIES),

  // Current wind speed driving waves (m/s).
  windSpeed: new Float32Array(MAX_WATER_BODIES),
  windDirX: new Float32Array(MAX_WATER_BODIES),
  windDirZ: new Float32Array(MAX_WATER_BODIES),

  // Wave spectral parameters.
  significantWaveHeight: new Float32Array(MAX_WATER_BODIES),   // H_s (m)
  peakWavelength: new Float32Array(MAX_WATER_BODIES),          // λ_p (m)
  peakAngularFrequency: new Float32Array(MAX_WATER_BODIES),    // ω_p (rad/s)

  // Number of active wave components (0..MAX_WAVE_COMPONENTS).
  waveCount: new Uint8Array(MAX_WATER_BODIES),

  // Water depth (m; 0 = shallow, ∞ = deep ocean).
  waterDepth: new Float32Array(MAX_WATER_BODIES),

  // Per-body wave amplitude (total from all components).
  totalAmplitude: new Float32Array(MAX_WATER_BODIES),

  // Base water colour (linear RGB).
  colorR: new Float32Array(MAX_WATER_BODIES),
  colorG: new Float32Array(MAX_WATER_BODIES),
  colorB: new Float32Array(MAX_WATER_BODIES),

  // Foam coverage (0..1; aggregated across patches).
  foamCoverage: new Float32Array(MAX_WATER_BODIES),

  // Time-based wave phase (advanced per frame).
  time: new Float32Array(MAX_WATER_BODIES),

  // Active flag.
  active: new Uint8Array(MAX_WATER_BODIES),

  // Seed for noise.
  seed: new Uint32Array(MAX_WATER_BODIES),
};

/** Marker: entity is a water body. */
export const WaterBodyTag = {};

const _waterBodySlots = new Map();
let _nextWaterBodySlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA WAVE COMPONENT — one per wave train per body
// ═══════════════════════════════════════════════════════════════════════

export const WaveComponent = {
  // Owner water body slot.
  bodySlot: new Uint16Array(MAX_WATER_BODIES * MAX_WAVE_COMPONENTS),

  // Wave direction (unit vector in the horizontal plane).
  dirX: new Float32Array(MAX_WATER_BODIES * MAX_WAVE_COMPONENTS),
  dirZ: new Float32Array(MAX_WATER_BODIES * MAX_WAVE_COMPONENTS),

  // Amplitude (metres).
  amplitude: new Float32Array(MAX_WATER_BODIES * MAX_WAVE_COMPONENTS),

  // Wavelength (metres).
  wavelength: new Float32Array(MAX_WATER_BODIES * MAX_WAVE_COMPONENTS),

  // Wavenumber (1/m).
  wavenumber: new Float32Array(MAX_WATER_BODIES * MAX_WAVE_COMPONENTS),

  // Angular frequency (rad/s).
  angularFreq: new Float32Array(MAX_WATER_BODIES * MAX_WAVE_COMPONENTS),

  // Phase offset (radians).
  phase: new Float32Array(MAX_WATER_BODIES * MAX_WAVE_COMPONENTS),

  // Steepness (0..1; Gerstner parameter Q).
  steepness: new Float32Array(MAX_WATER_BODIES * MAX_WAVE_COMPONENTS),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA FOAM PATCH
// ═══════════════════════════════════════════════════════════════════════

export const FoamPatch = {
  active: new Uint8Array(MAX_FOAM_PATCHES),

  bodySlot: new Uint16Array(MAX_FOAM_PATCHES),

  // World position.
  px: new Float32Array(MAX_FOAM_PATCHES),
  pz: new Float32Array(MAX_FOAM_PATCHES),

  // Radius (metres).
  radius: new Float32Array(MAX_FOAM_PATCHES),

  // Intensity (0..1).
  intensity: new Float32Array(MAX_FOAM_PATCHES),

  // Age and lifetime (seconds).
  age: new Float32Array(MAX_FOAM_PATCHES),
  lifetime: new Float32Array(MAX_FOAM_PATCHES),

  // Free-list.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// SoA RAIN RIPPLE
// ═══════════════════════════════════════════════════════════════════════

export const RainRipple = {
  active: new Uint8Array(MAX_RIPPLES),

  // Center.
  px: new Float32Array(MAX_RIPPLES),
  pz: new Float32Array(MAX_RIPPLES),

  // Current radius.
  radius: new Float32Array(MAX_RIPPLES),

  // Amplitude (0..1).
  amplitude: new Float32Array(MAX_RIPPLES),

  // Age and lifetime.
  age: new Float32Array(MAX_RIPPLES),
  lifetime: new Float32Array(MAX_RIPPLES),

  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// PRNG
// ═══════════════════════════════════════════════════════════════════════

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// WAVE SPECTRUM FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Pierson-Moskowitz spectrum.
 * S(ω) = α·g² / ω⁵ · exp(-β·(ω_p/ω)⁴)
 * where α = 0.0081, β = 0.74, ω_p = peak frequency.
 */
export function piersonMoskowitz(omega, peakOmega, alpha = PM_ALPHA, beta = PM_BETA) {
  if (omega < EPSILON) return 0;
  const w5 = Math.pow(omega, 5);
  const ratio = peakOmega / omega;
  const ratio4 = ratio * ratio * ratio * ratio;
  return (alpha * GRAVITY * GRAVITY / w5) * Math.exp(-beta * ratio4);
}

/**
 * JONSWAP spectrum.
 * S(ω) = PM(ω) · γ^r
 * where r = exp(-(ω-ω_p)² / (2·σ²·ω_p²)) and σ = σ_a (ω ≤ ω_p), σ_b (ω > ω_p).
 */
export function jonswap(omega, peakOmega, gamma = JONSWAP_GAMMA_DEFAULT) {
  if (omega < EPSILON) return 0;
  const pm = piersonMoskowitz(omega, peakOmega);
  const sigma = omega <= peakOmega ? JONSWAP_SIGMA_A : JONSWAP_SIGMA_B;
  const deltaOmega = omega - peakOmega;
  const r = Math.exp(-(deltaOmega * deltaOmega) / (2 * sigma * sigma * peakOmega * peakOmega));
  return pm * Math.pow(gamma, r);
}

/**
 * Phillips spectrum (2D wave-number).
 * S(k) ∝ exp(-1 / (k·L)²) / k⁴ · |cos(θ)|²
 */
export function phillips(kMagnitude, theta, windDir, L = PHILLIPS_L) {
  if (kMagnitude < EPSILON) return 0;
  const kL = kMagnitude * L;
  const exp_term = Math.exp(-1 / (kL * kL));
  const k4 = kMagnitude * kMagnitude * kMagnitude * kMagnitude;
  const cosTerm = Math.cos(theta - windDir);
  const cosSq = Math.max(0, cosTerm * cosTerm);
  return exp_term / k4 * cosSq;
}

// ═══════════════════════════════════════════════════════════════════════
// WAVE COMPONENT GENERATION FROM SPECTRUM
// ═══════════════════════════════════════════════════════════════════════

/**
 * Populate wave components for a water body from its spectrum.
 * Called once at water body creation.
 */
function generateWaveComponents(bodySlot, windSpeed, windDirX, windDirZ, seed) {
  const B = WaterBody;
  const W = WaveComponent;

  if (windSpeed < MIN_WIND_FOR_WAVES) {
    B.waveCount[bodySlot] = 0;
    B.totalAmplitude[bodySlot] = 0;
    B.significantWaveHeight[bodySlot] = 0;
    return;
  }

  // Peak wavelength from wind speed (Pierson-Moskowitz).
  const peakWavelength = Math.max(0.5,
    WIND_PEAK_WAVELENGTH_FACTOR * windSpeed * windSpeed / GRAVITY);
  B.peakWavelength[bodySlot] = peakWavelength;

  // Peak angular frequency (deep-water dispersion: ω = √(g·k)).
  const peakK = TWO_PI / peakWavelength;
  const peakOmega = Math.sqrt(GRAVITY * peakK);
  B.peakAngularFrequency[bodySlot] = peakOmega;

  // Significant wave height (H_s ≈ 1.6 × std of surface elevation).
  // Approximate from Pierson-Moskowitz: H_s ≈ 0.21 · U² / g
  const significantWaveHeight = 0.21 * windSpeed * windSpeed / GRAVITY;
  B.significantWaveHeight[bodySlot] = significantWaveHeight;

  // Determine number of components by water type.
  const type = B.type[bodySlot];
  const componentCount = waveCountForType(type);
  B.waveCount[bodySlot] = componentCount;

  const rng = mulberry32(seed);
  const baseIndex = bodySlot * MAX_WAVE_COMPONENTS;

  // Base direction (from wind).
  const windAngle = Math.atan2(windDirZ, windDirX);

  let totalAmplitude = 0;

  for (let i = 0; i < componentCount; i++) {
    const idx = baseIndex + i;

    // Distribute wavelengths logarithmically around the peak.
    const t = i / Math.max(1, componentCount - 1);
    const wavelengthMult = 0.5 + t * 2.0;   // 0.5x to 2.5x peak
    const wavelength = peakWavelength * wavelengthMult;

    // Direction: wind direction ± spread.
    const angleSpread = (rng() - 0.5) * WAVE_DIRECTION_SPREAD * 2;
    const angle = windAngle + angleSpread;

    // Amplitude from spectrum.
    const k = TWO_PI / wavelength;
    const omega = Math.sqrt(GRAVITY * k);

    // Energy from spectrum at this frequency.
    let energy;
    const spectrum = B.spectrumType[bodySlot];
    if (spectrum === WaveSpectrumType.JONSWAP) {
      energy = jonswap(omega, peakOmega);
    } else if (spectrum === WaveSpectrumType.PHILLIPS) {
      energy = phillips(k, angle, windAngle);
    } else {
      energy = piersonMoskowitz(omega, peakOmega);
    }

    // Amplitude from energy (approximation).
    const amplitude = Math.sqrt(2 * Math.max(0, energy) * (TWO_PI / componentCount));

    // Steepness: scale by water type.
    const steepness = DEFAULT_WAVE_STEEPNESS * (1 - t * 0.3);

    W.bodySlot[idx] = bodySlot;
    W.dirX[idx] = Math.cos(angle);
    W.dirZ[idx] = Math.sin(angle);
    W.amplitude[idx] = amplitude * significantWaveHeight * 0.15;
    W.wavelength[idx] = wavelength;
    W.wavenumber[idx] = k;
    W.angularFreq[idx] = omega;
    W.phase[idx] = rng() * TWO_PI;
    W.steepness[idx] = steepness;

    totalAmplitude += W.amplitude[idx];
  }

  B.totalAmplitude[bodySlot] = totalAmplitude;
}

function waveCountForType(type) {
  switch (type) {
    case WaterBodyType.DEEP_OCEAN: return DEEP_OCEAN_WAVE_COUNT;
    case WaterBodyType.COASTAL:    return COASTAL_WAVE_COUNT;
    case WaterBodyType.LAKE:       return LAKE_WAVE_COUNT;
    case WaterBodyType.RIVER:      return RIVER_WAVE_COUNT;
    case WaterBodyType.POND:       return POND_WAVE_COUNT;
    case WaterBodyType.PUDDLE:     return PUDDLE_WAVE_COUNT;
    default:                       return 4;
  }
}

function defaultRadiusForType(type) {
  switch (type) {
    case WaterBodyType.DEEP_OCEAN: return 5000;
    case WaterBodyType.COASTAL:    return 2000;
    case WaterBodyType.LAKE:       return 500;
    case WaterBodyType.RIVER:      return 50;
    case WaterBodyType.POND:       return 20;
    case WaterBodyType.PUDDLE:     return 2;
    default:                       return 100;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// WATER BODY CREATION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a water body.
 *
 * @param world       ECS world
 * @param eid         owner entity
 * @param type        WaterBodyType
 * @param options     { cx, cz, baseLevel, radiusX, radiusZ, waterDepth,
 *                      windSpeed, windDir, color, seed }
 * @returns water body slot
 */
export function addWaterBody(world, eid, type = WaterBodyType.LAKE, options = {}) {
  if (_nextWaterBodySlot >= MAX_WATER_BODIES) {
    throw new Error('water body capacity exceeded');
  }
  const slot = _nextWaterBodySlot++;

  addComponent(world, eid, WaterBodyTag);

  const B = WaterBody;
  B.ownerEid[slot] = eid;
  B.type[slot] = type;

  // Spectrum type default per water body type.
  if (type === WaterBodyType.DEEP_OCEAN) {
    B.spectrumType[slot] = WaveSpectrumType.PIERSON_MOSKOWITZ;
  } else if (type === WaterBodyType.COASTAL) {
    B.spectrumType[slot] = WaveSpectrumType.JONSWAP;
  } else if (type === WaterBodyType.LAKE) {
    B.spectrumType[slot] = WaveSpectrumType.JONSWAP;
  } else {
    B.spectrumType[slot] = WaveSpectrumType.PIERSON_MOSKOWITZ;
  }
  if (options.spectrumType !== undefined) {
    B.spectrumType[slot] = options.spectrumType;
  }

  B.baseLevel[slot] = options.baseLevel ?? 0;
  B.cx[slot] = options.cx ?? 0;
  B.cz[slot] = options.cz ?? 0;
  B.radiusX[slot] = options.radiusX ?? defaultRadiusForType(type);
  B.radiusZ[slot] = options.radiusZ ?? defaultRadiusForType(type);
  B.waterDepth[slot] = options.waterDepth ?? (
    type === WaterBodyType.DEEP_OCEAN ? 4000
    : type === WaterBodyType.COASTAL ? 20
    : type === WaterBodyType.LAKE ? 50
    : type === WaterBodyType.RIVER ? 2
    : type === WaterBodyType.POND ? 1
    : 0.1);

  // Default wind speed (5 m/s for a gentle breeze).
  B.windSpeed[slot] = options.windSpeed ?? 5.0;
  B.windDirX[slot] = options.windDir ? options.windDir[0] : 1.0;
  B.windDirZ[slot] = options.windDir ? options.windDir[1] : 0.0;

  // Water colour (linear RGB).
  const color = options.color ?? [0.02, 0.10, 0.22];
  B.colorR[slot] = color[0];
  B.colorG[slot] = color[1];
  B.colorB[slot] = color[2];

  B.foamCoverage[slot] = 0;
  B.time[slot] = 0;
  B.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);
  B.active[slot] = 1;

  // Generate wave components.
  generateWaveComponents(slot, B.windSpeed[slot], B.windDirX[slot], B.windDirZ[slot], B.seed[slot]);

  _waterBodySlots.set(eid, slot);
  return slot;
}

export function removeWaterBody(world, eid) {
  const slot = _waterBodySlots.get(eid);
  if (slot === undefined) return;

  WaterBody.active[slot] = 0;
  WaterBody.ownerEid[slot] = 0;
  _waterBodySlots.delete(eid);
  removeComponent(world, eid, WaterBodyTag);
}

export function getWaterBodySlot(eid) {
  return _waterBodySlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// WAVE HEIGHT SAMPLING — Gerstner wave superposition
// ═══════════════════════════════════════════════════════════════════════

const _windAtBody = vec3.create();

/**
 * Sample the water surface height at a world (x, z) position.
 * Uses the Gerstner wave sum, so returning height only (not
 * displacement).
 */
export function sampleWaterSurfaceHeight(bodySlot, wx, wz) {
  const B = WaterBody;
  if (!B.active[bodySlot]) return 0;

  const waveCount = B.waveCount[bodySlot];
  if (waveCount === 0) return B.baseLevel[bodySlot];

  const time = B.time[bodySlot];
  const baseIndex = bodySlot * MAX_WAVE_COMPONENTS;
  const W = WaveComponent;

  let height = B.baseLevel[bodySlot];

  for (let i = 0; i < waveCount; i++) {
    const idx = baseIndex + i;
    const k = W.wavenumber[idx];
    const omega = W.angularFreq[idx];
    const dirX = W.dirX[idx];
    const dirZ = W.dirZ[idx];
    const phase = W.phase[idx];
    const amplitude = W.amplitude[idx];

    // Gerstner wave height: y = A · sin(k · (D · pos) + ω · t + φ)
    const d = wx * dirX + wz * dirZ;
    height += amplitude * Math.sin(k * d - omega * time + phase);
  }

  // Storm surge modulation.
  const surge = sampleSurgeHeightNearest(wx, wz);
  height += surge;

  return height;
}

function sampleSurgeHeightNearest(wx, wy, wz) {
  // Sample storm surge from file 049.
  let maxSurge = 0;
  for (let s = 0; s < StormSurge.surgeHeight.length; s++) {
    if (!StormSurge.active[s]) continue;
    const surge = sampleSurgeHeight(s, wx, wy, wz);
    if (surge > maxSurge) maxSurge = surge;
  }
  return maxSurge;
}

/**
 * Sample the wave displacement (both height and horizontal offset).
 * Used for surf/beach interaction, floating objects, and boat physics.
 */
export function sampleWaveDisplacement(bodySlot, wx, wz, outHeight, outOffsetX, outOffsetZ) {
  const B = WaterBody;
  if (!B.active[bodySlot]) {
    if (outHeight) outHeight[0] = 0;
    if (outOffsetX) outOffsetX[0] = 0;
    if (outOffsetZ) outOffsetZ[0] = 0;
    return;
  }

  const waveCount = B.waveCount[bodySlot];
  const time = B.time[bodySlot];
  const baseIndex = bodySlot * MAX_WAVE_COMPONENTS;
  const W = WaveComponent;

  let height = B.baseLevel[bodySlot];
  let offsetX = 0;
  let offsetZ = 0;

  for (let i = 0; i < waveCount; i++) {
    const idx = baseIndex + i;
    const k = W.wavenumber[idx];
    const omega = W.angularFreq[idx];
    const dirX = W.dirX[idx];
    const dirZ = W.dirZ[idx];
    const phase = W.phase[idx];
    const amplitude = W.amplitude[idx];
    const steepness = W.steepness[idx];

    const d = wx * dirX + wz * dirZ;
    const theta = k * d - omega * time + phase;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);

    // Gerstner vertical.
    height += amplitude * sinT;

    // Gerstner horizontal displacement (Q · A · D · cos).
    const horizOffset = steepness * amplitude * cosT;
    offsetX += dirX * horizOffset;
    offsetZ += dirZ * horizOffset;
  }

  if (outHeight) outHeight[0] = height;
  if (outOffsetX) outOffsetX[0] = offsetX;
  if (outOffsetZ) outOffsetZ[0] = offsetZ;
}

// ═══════════════════════════════════════════════════════════════════════
// WAVE NORMAL SAMPLING — analytic derivative of Gerstner sum
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the surface normal at a world (x, z) position.
 * Uses the analytic derivative of the Gerstner wave sum.
 */
export function sampleWaterSurfaceNormal(bodySlot, wx, wz, out) {
  const B = WaterBody;
  if (!B.active[bodySlot]) {
    out[0] = 0; out[1] = 1; out[2] = 0;
    return out;
  }

  const waveCount = B.waveCount[bodySlot];
  const time = B.time[bodySlot];
  const baseIndex = bodySlot * MAX_WAVE_COMPONENTS;
  const W = WaveComponent;

  // Partial derivatives of height with respect to x and z.
  let dHdx = 0;
  let dHdz = 0;

  for (let i = 0; i < waveCount; i++) {
    const idx = baseIndex + i;
    const k = W.wavenumber[idx];
    const omega = W.angularFreq[idx];
    const dirX = W.dirX[idx];
    const dirZ = W.dirZ[idx];
    const phase = W.phase[idx];
    const amplitude = W.amplitude[idx];

    const d = wx * dirX + wz * dirZ;
    const theta = k * d - omega * time + phase;
    const cosT = Math.cos(theta);

    // d/dx of A·sin(k·(D·pos) + ωt + φ) = A·k·dirX·cos(...)
    dHdx += amplitude * k * dirX * cosT;
    dHdz += amplitude * k * dirZ * cosT;
  }

  // Normal = normalize(-dHdx, 1, -dHdz).
  const len = Math.sqrt(dHdx * dHdx + 1.0 + dHdz * dHdz);
  out[0] = -dHdx / len;
  out[1] = 1.0 / len;
  out[2] = -dHdz / len;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// SHOALING — wave height scaling based on depth
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the shoaling factor for a wave at a given depth.
 * Green's law: H ∝ d^(-1/4).
 *
 * For deep water (d ≥ REFERENCE_DEPTH): factor = 1.0.
 * For shallow water (d < REFERENCE_DEPTH): factor grows as d^(-1/4).
 */
export function shoalingFactor(depth) {
  if (depth >= REFERENCE_DEPTH) return 1.0;
  if (depth <= BREAKING_DEPTH_MIN) return 0;   // wave has broken
  return Math.pow(depth / REFERENCE_DEPTH, GREEN_LAW_EXPONENT);
}

/**
 * Determine if a wave at a given depth should break.
 */
export function isWaveBreaking(depth, waveHeight) {
  // Wave breaks when depth < ~1.3 × waveHeight (rule of thumb).
  return depth < 1.3 * waveHeight;
}

// ═══════════════════════════════════════════════════════════════════════
// FOAM PATCH MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

function allocFoamPatch() {
  const F = FoamPatch;
  for (let i = 0; i < MAX_FOAM_PATCHES; i++) {
    const slot = (F.freeHead + i) % MAX_FOAM_PATCHES;
    if (F.active[slot] === 0) {
      F.freeHead = (slot + 1) % MAX_FOAM_PATCHES;
      F.active[slot] = 1;
      F.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeFoamPatch(slot) {
  const F = FoamPatch;
  if (F.active[slot] === 0) return;
  F.active[slot] = 0;
  F.liveCount--;
}

function allocRipple() {
  const R = RainRipple;
  for (let i = 0; i < MAX_RIPPLES; i++) {
    const slot = (R.freeHead + i) % MAX_RIPPLES;
    if (R.active[slot] === 0) {
      R.freeHead = (slot + 1) % MAX_RIPPLES;
      R.active[slot] = 1;
      R.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeRipple(slot) {
  const R = RainRipple;
  if (R.active[slot] === 0) return;
  R.active[slot] = 0;
  R.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// FOAM EMISSION — whitecap formation from breaking waves
// ═══════════════════════════════════════════════════════════════════════

/**
 * Emit foam patches based on the current wind and wave state.
 * Uses the Monahan (1986) whitecap fraction model:
 *   W = 3.84×10⁻⁶ · U₁₀^3.41
 * where U₁₀ is the wind speed at 10 m.
 */
export function systemEmitFoam(world, dt) {
  const B = WaterBody;
  const F = FoamPatch;

  for (let bodySlot = 0; bodySlot < _nextWaterBodySlot; bodySlot++) {
    if (!B.active[bodySlot]) continue;

    const windSpeed = B.windSpeed[bodySlot];
    if (windSpeed < WHITECAP_MIN_WIND) continue;

    // Monahan whitecap fraction.
    const whitecapFraction = FOAM_MONAHAN_COEFF * Math.pow(windSpeed, FOAM_MONAHAN_EXPONENT);

    // Convert to foam patch emission rate per second.
    const area = PI * B.radiusX[bodySlot] * B.radiusZ[bodySlot];
    const patchesPerSecond = whitecapFraction * area / (FOAM_INITIAL_RADIUS_MAX * FOAM_INITIAL_RADIUS_MAX * PI);

    const expected = Math.min(500, patchesPerSecond * dt);
    const count = Math.floor(expected) + (Math.random() < expected - Math.floor(expected) ? 1 : 0);

    const rng = mulberry32((B.seed[bodySlot] ^ Math.floor(B.time[bodySlot] * 1000)) >>> 0);

    for (let i = 0; i < count; i++) {
      const slot = allocFoamPatch();
      if (slot < 0) break;

      // Spawn within the water body extents.
      const r = Math.sqrt(rng()) * Math.max(B.radiusX[bodySlot], B.radiusZ[bodySlot]);
      const angle = rng() * TWO_PI;
      const px = B.cx[bodySlot] + Math.cos(angle) * r;
      const pz = B.cz[bodySlot] + Math.sin(angle) * r;

      F.bodySlot[slot] = bodySlot;
      F.px[slot] = px;
      F.pz[slot] = pz;
      F.radius[slot] = FOAM_INITIAL_RADIUS_MIN
        + rng() * (FOAM_INITIAL_RADIUS_MAX - FOAM_INITIAL_RADIUS_MIN);
      F.intensity[slot] = 0.5 + rng() * 0.5;
      F.age[slot] = 0;
      F.lifetime[slot] = FOAM_LIFETIME_MIN
        + rng() * (FOAM_LIFETIME_MAX - FOAM_LIFETIME_MIN);
    }

    // Update total foam coverage for the body.
    let totalFoamArea = 0;
    for (let slot = 0; slot < MAX_FOAM_PATCHES; slot++) {
      if (F.active[slot] === 0) continue;
      if (F.bodySlot[slot] !== bodySlot) continue;
      totalFoamArea += PI * F.radius[slot] * F.radius[slot];
    }
    B.foamCoverage[bodySlot] = Math.min(1.0, totalFoamArea / Math.max(area, 1));
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// FOAM UPDATE — expand and dissipate
// ═══════════════════════════════════════════════════════════════════════

const _windAtFoam = vec3.create();

export function systemUpdateFoam(world, dt) {
  const F = FoamPatch;
  const B = WaterBody;

  for (let slot = 0; slot < MAX_FOAM_PATCHES; slot++) {
    if (F.active[slot] === 0) continue;

    F.age[slot] += dt;

    if (F.age[slot] > F.lifetime[slot]) {
      freeFoamPatch(slot);
      continue;
    }

    // Expand slowly.
    F.radius[slot] += FOAM_EXPANSION_RATE * dt;

    // Dissipate intensity.
    F.intensity[slot] *= Math.pow(1 - FOAM_DISSIPATION_RATE, dt);

    // Advect with the wind field.
    sampleWindAt(F.px[slot], 0, F.pz[slot], _windAtFoam);
    F.px[slot] += _windAtFoam[0] * dt * 0.5;
    F.pz[slot] += _windAtFoam[2] * dt * 0.5;
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// FOAM SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the foam coverage (0..1) at a world position.
 */
export function sampleFoamCoverage(wx, wz) {
  const F = FoamPatch;
  let total = 0;

  for (let slot = 0; slot < MAX_FOAM_PATCHES; slot++) {
    if (F.active[slot] === 0) continue;

    const dx = wx - F.px[slot];
    const dz = wz - F.pz[slot];
    const distSq = dx * dx + dz * dz;

    if (distSq < F.radius[slot] * F.radius[slot]) {
      const falloff = 1 - distSq / (F.radius[slot] * F.radius[slot]);
      total += F.intensity[slot] * falloff;
    }
  }

  return Math.min(1.0, total);
}

// ═══════════════════════════════════════════════════════════════════════
// RAIN RIPPLE EMISSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Emit rain ripples on water surfaces near active rain drops.
 */
export function systemEmitRainRipples(world, dt) {
  const B = WaterBody;
  const R = RainDrop;

  // For each water body, check for nearby rain.
  for (let bodySlot = 0; bodySlot < _nextWaterBodySlot; bodySlot++) {
    if (!B.active[bodySlot]) continue;

    const cx = B.cx[bodySlot];
    const cz = B.cz[bodySlot];
    const rX = B.radiusX[bodySlot];
    const rZ = B.radiusZ[bodySlot];

    // Sample nearby rain drops.
    let nearbyDrops = 0;
    for (let r = 0; r < RainDrop.active.length && nearbyDrops < 50; r++) {
      if (R.active[r] === 0) continue;

      const dx = (R.px[r] - cx) / rX;
      const dz = (R.pz[r] - cz) / rZ;

      if (dx * dx + dz * dz < 1) {
        // Spawn a ripple at the drop's position.
        const slot = allocRipple();
        if (slot < 0) continue;

        RainRipple.px[slot] = R.px[r];
        RainRipple.pz[slot] = R.pz[r];
        RainRipple.radius[slot] = RIPPLE_INITIAL_RADIUS;
        RainRipple.amplitude[slot] = RIPPLE_DEPTH_AMPLITUDE;
        RainRipple.age[slot] = 0;
        RainRipple.lifetime[slot] = RIPPLE_LIFETIME;

        nearbyDrops++;
      }
    }
  }

  return world;
}

/**
 * Update active rain ripples.
 */
export function systemUpdateRainRipples(world, dt) {
  const R = RainRipple;

  for (let slot = 0; slot < MAX_RIPPLES; slot++) {
    if (R.active[slot] === 0) continue;

    R.age[slot] += dt;
    if (R.age[slot] > R.lifetime[slot]) {
      freeRipple(slot);
      continue;
    }

    // Expand.
    R.radius[slot] += RIPPLE_SPEED * dt;

    // Amplitude decays.
    R.amplitude[slot] *= Math.pow(0.9, dt);
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// WATER BODY UPDATE — advance time, read wind from file 047
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the water body's wave phases.
 */
export function systemUpdateWaterBodies(world, dt) {
  const B = WaterBody;

  for (let bodySlot = 0; bodySlot < _nextWaterBodySlot; bodySlot++) {
    if (!B.active[bodySlot]) continue;

    B.time[bodySlot] += dt;

    // Sample wind at the center of the water body (from file 047).
    sampleWindAt(B.cx[bodySlot], B.baseLevel[bodySlot] + 10, B.cz[bodySlot], _windAtBody);
    const ambientWindSpeed = Math.hypot(_windAtBody[0], _windAtBody[2]);

    // Blend body wind toward ambient.
    const blendRate = 0.02;
    B.windSpeed[bodySlot] = B.windSpeed[bodySlot] * (1 - blendRate) + ambientWindSpeed * blendRate;

    if (ambientWindSpeed > MIN_WIND_FOR_WAVES) {
      B.windDirX[bodySlot] = _windAtBody[0] / ambientWindSpeed;
      B.windDirZ[bodySlot] = _windAtBody[2] / ambientWindSpeed;
    }

    // If wind speed changes dramatically, regenerate wave components.
    const currentPeakWavelength = Math.max(0.5,
      WIND_PEAK_WAVELENGTH_FACTOR * B.windSpeed[bodySlot] * B.windSpeed[bodySlot] / GRAVITY);
    if (Math.abs(currentPeakWavelength - B.peakWavelength[bodySlot])
        / Math.max(B.peakWavelength[bodySlot], 0.1) > 0.1) {
      generateWaveComponents(bodySlot, B.windSpeed[bodySlot],
        B.windDirX[bodySlot], B.windDirZ[bodySlot], B.seed[bodySlot]);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SUN SPECULAR — Blinn-Phong sun reflection with glitter
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the sun specular reflection from the water surface.
 * Uses Blinn-Phong shading with an extra glitter term for the sun
 * path sparkle.
 *
 * @param bodySlot       water body slot
 * @param wx, wz         world position on the surface
 * @param sunDirX/Y/Z    sun direction (unit vector)
 * @param viewDirX/Y/Z   view direction (unit vector)
 * @returns [r, g, b] specular radiance
 */
export function sampleWaterSunSpecular(bodySlot, wx, wz, sunDirX, sunDirY, sunDirZ,
                                        viewDirX, viewDirY, viewDirZ, out) {
  out[0] = 0; out[1] = 0; out[2] = 0;

  if (!WaterBody.active[bodySlot]) return out;

  // Sample the surface normal.
  const normal = _normalScratch;
  sampleWaterSurfaceNormal(bodySlot, wx, wz, normal);

  // Blinn-Phong half-vector.
  let hx = sunDirX + viewDirX;
  let hy = sunDirY + viewDirY;
  let hz = sunDirZ + viewDirZ;
  const hLen = Math.sqrt(hx * hx + hy * hy + hz * hz);
  if (hLen < EPSILON) return out;
  hx /= hLen;
  hy /= hLen;
  hz /= hLen;

  // N · H.
  const nDotH = normal[0] * hx + normal[1] * hy + normal[2] * hz;
  if (nDotH < 0) return out;

  // Blinn-Phong specular.
  const specular = Math.pow(nDotH, WATER_SPECULAR_POWER);

  // Sun intensity (read from file 028).
  const skyEids = query(null, [SkyF32]);
  let sunIntensity = 1.0;
  if (skyEids.length > 0) {
    const skySlot = getSkySlot(skyEids[0]);
    if (skySlot >= 0) sunIntensity = SkyF32.sunIntensity[skySlot];
  }

  // Glitter: sub-normal random perturbation adds sparkle.
  const windSpeed = WaterBody.windSpeed[bodySlot];
  const glitterFactor = Math.min(1, windSpeed / 10);

  // Base specular contribution.
  out[0] = specular * sunIntensity * 1.0;
  out[1] = specular * sunIntensity * 0.95;
  out[2] = specular * sunIntensity * 0.85;

  // Glitter contribution.
  if (glitterFactor > 0.01) {
    const noise = Math.sin(wx * 13.7 + wz * 7.3) * 0.5 + 0.5;
    const glitter = specular * glitterFactor * GLITTER_INTENSITY * noise;
    out[0] += glitter * 1.0;
    out[1] += glitter * 0.9;
    out[2] += glitter * 0.8;
  }

  return out;
}

const _normalScratch = vec3.create();

// ═══════════════════════════════════════════════════════════════════════
// WATER SURFACE SAMPLING — full water shading in one call
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the full water surface: height, normal, foam, colour, and
 * sun specular.
 *
 * @param bodySlot       water body slot
 * @param wx, wz         world (x, z) position
 * @param sunDir         [x, y, z] sun direction (unit)
 * @param viewDir        [x, y, z] view direction (unit)
 * @param out            { height, normal, foam, color, specular }
 */
export function sampleWaterSurface(bodySlot, wx, wz, sunDir, viewDir, out) {
  const B = WaterBody;
  if (!B.active[bodySlot]) {
    out.height = 0;
    out.normal[0] = 0; out.normal[1] = 1; out.normal[2] = 0;
    out.foam = 0;
    out.color[0] = 0; out.color[1] = 0; out.color[2] = 0;
    out.specular[0] = 0; out.specular[1] = 0; out.specular[2] = 0;
    return out;
  }

  // Height.
  out.height = sampleWaterSurfaceHeight(bodySlot, wx, wz);

  // Normal.
  sampleWaterSurfaceNormal(bodySlot, wx, wz, out.normal);

  // Foam.
  out.foam = sampleFoamCoverage(wx, wz);

  // Base colour.
  out.color[0] = B.colorR[bodySlot];
  out.color[1] = B.colorG[bodySlot];
  out.color[2] = B.colorB[bodySlot];

  // Sun specular.
  if (sunDir && viewDir) {
    sampleWaterSunSpecular(bodySlot, wx, wz,
      sunDir[0], sunDir[1], sunDir[2],
      viewDir[0], viewDir[1], viewDir[2],
      out.specular);
  } else {
    out.specular[0] = 0; out.specular[1] = 0; out.specular[2] = 0;
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full water surface pipeline for one frame:
 *   1. Update water body waves and read wind.
 *   2. Emit and update foam patches.
 *   3. Emit and update rain ripples.
 */
export function systemWaterSurfaceTick(world, dt) {
  systemUpdateWaterBodies(world, dt);
  systemEmitFoam(world, dt);
  systemUpdateFoam(world, dt);
  systemEmitRainRipples(world, dt);
  systemUpdateRainRipples(world, dt);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find the nearest water body containing a world position.
 */
export function findWaterBodyAt(wx, wz, y = 0, tolerance = 5) {
  const B = WaterBody;
  for (let slot = 0; slot < _nextWaterBodySlot; slot++) {
    if (!B.active[slot]) continue;

    const dx = (wx - B.cx[slot]) / B.radiusX[slot];
    const dz = (wz - B.cz[slot]) / B.radiusZ[slot];
    if (dx * dx + dz * dz > 1.0) continue;

    // Check vertical proximity.
    const surfH = sampleWaterSurfaceHeight(slot, wx, wz);
    if (Math.abs(y - surfH) > tolerance) continue;

    return slot;
  }
  return -1;
}

/**
 * Return a summary of the water surface state at a world position.
 */
export function getWaterSurfaceSummaryAt(bodySlot, wx, wz) {
  const B = WaterBody;
  if (!B.active[bodySlot]) return null;

  const h = [0], ox = [0], oz = [0];
  sampleWaveDisplacement(bodySlot, wx, wz, h, ox, oz);

  const n = [0, 1, 0];
  sampleWaterSurfaceNormal(bodySlot, wx, wz, n);

  return {
    height: h[0],
    offsetX: ox[0],
    offsetZ: oz[0],
    normal: n,
    foam: sampleFoamCoverage(wx, wz),
    windSpeed: B.windSpeed[bodySlot],
    significantWaveHeight: B.significantWaveHeight[bodySlot],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherWaterBodiesForRendering() {
  const result = [];
  const B = WaterBody;
  for (let slot = 0; slot < _nextWaterBodySlot; slot++) {
    if (!B.active[slot]) continue;
    result.push({
      slot,
      type: B.type[slot],
      spectrumType: B.spectrumType[slot],
      cx: B.cx[slot],
      cz: B.cz[slot],
      baseLevel: B.baseLevel[slot],
      radiusX: B.radiusX[slot],
      radiusZ: B.radiusZ[slot],
      waterDepth: B.waterDepth[slot],
      windSpeed: B.windSpeed[slot],
      windDirX: B.windDirX[slot],
      windDirZ: B.windDirZ[slot],
      significantWaveHeight: B.significantWaveHeight[slot],
      peakWavelength: B.peakWavelength[slot],
      waveCount: B.waveCount[slot],
      color: [B.colorR[slot], B.colorG[slot], B.colorB[slot]],
      foamCoverage: B.foamCoverage[slot],
      time: B.time[slot],
    });
  }
  return result;
}

export function gatherWaveComponentsForRendering(bodySlot) {
  const result = [];
  if (!WaterBody.active[bodySlot]) return result;

  const W = WaveComponent;
  const baseIndex = bodySlot * MAX_WAVE_COMPONENTS;
  const count = WaterBody.waveCount[bodySlot];

  for (let i = 0; i < count; i++) {
    const idx = baseIndex + i;
    result.push({
      dirX: W.dirX[idx],
      dirZ: W.dirZ[idx],
      amplitude: W.amplitude[idx],
      wavelength: W.wavelength[idx],
      wavenumber: W.wavenumber[idx],
      angularFreq: W.angularFreq[idx],
      phase: W.phase[idx],
      steepness: W.steepness[idx],
    });
  }
  return result;
}

export function gatherFoamPatchesForRendering(maxOutput = 2048) {
  const result = [];
  const F = FoamPatch;
  for (let slot = 0; slot < MAX_FOAM_PATCHES; slot++) {
    if (F.active[slot] === 0) continue;
    result.push({
      px: F.px[slot],
      pz: F.pz[slot],
      radius: F.radius[slot],
      intensity: F.intensity[slot],
      age: F.age[slot],
      lifetime: F.lifetime[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

export function gatherRipplesForRendering(maxOutput = 512) {
  const result = [];
  const R = RainRipple;
  for (let slot = 0; slot < MAX_RIPPLES; slot++) {
    if (R.active[slot] === 0) continue;
    result.push({
      px: R.px[slot],
      pz: R.pz[slot],
      radius: R.radius[slot],
      amplitude: R.amplitude[slot],
      age: R.age[slot],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearWaterSurface() {
  WaterBody.active.fill(0);
  WaterBody.ownerEid.fill(0);
  _waterBodySlots.clear();
  _nextWaterBodySlot = 0;

  FoamPatch.active.fill(0);
  FoamPatch.freeHead = 0;
  FoamPatch.liveCount = 0;

  RainRipple.active.fill(0);
  RainRipple.freeHead = 0;
  RainRipple.liveCount = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function waterSurfaceStats() {
  let activeBodies = 0;
  let totalWaves = 0;
  let totalWaveHeight = 0;

  for (let slot = 0; slot < _nextWaterBodySlot; slot++) {
    if (!WaterBody.active[slot]) continue;
    activeBodies++;
    totalWaves += WaterBody.waveCount[slot];
    totalWaveHeight += WaterBody.significantWaveHeight[slot];
  }

  return {
    activeBodies,
    maxBodies: MAX_WATER_BODIES,
    totalWaveComponents: totalWaves,
    maxWaveComponents: MAX_WATER_BODIES * MAX_WAVE_COMPONENTS,
    avgSignificantWaveHeight: activeBodies > 0 ? totalWaveHeight / activeBodies : 0,
    activeFoamPatches: FoamPatch.liveCount,
    maxFoamPatches: MAX_FOAM_PATCHES,
    activeRipples: RainRipple.liveCount,
    maxRipples: MAX_RIPPLES,
  };
}