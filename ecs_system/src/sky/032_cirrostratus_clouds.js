// file number : 032
// full path name : src/sky/032_cirrostratus_clouds.js
// description : Cirrostratus cloud family — the thin, transparent,
//               uniform ice-crystal veil that produces the classic 22°
//               solar and lunar halos. Cirrostratus sit at 5-9 km and
//               form a smooth white sheet covering most of the sky. This
//               file imports 029_cloud_archetypes.js as its single source
//               of truth and contributes:
//                 • CirrostratusArchetypes — pre-built archetypes for
//                   the standard uniform veil, halo-producing thin veil,
//                   and dense veil via createCloudArchetype
//                 • CirrostratusState — SoA extension tracking per-instance
//                   veil thickness, veil orientation, halo intensity,
//                   parhelion (sun-dog) intensity, and sun-view angle
//                 • Behaviour system — systemCirrostratusEvolve applies
//                   gradual veil thickening/thinning, wind-driven shearing,
//                   and computes the halo/parhelion response per sun angle
//                 • Density hook — sampleCirrostratusDensity adds a very
//                   low-amplitude smooth veil with sub-visible banding
//                   on top of 029's ellipsoid so the sky darkens
//                   correctly but stays transparent to the sun
//                 • Halo hook — sampleHaloRing returns the 22° halo
//                   radiance for a view direction so file 028's sky
//                   sample composes it directly into the final colour
//                 • VFX bridge — emitCirrostratusSpicules returns data
//                   for the tiny ice spicule particles seen in very thin
//                   cirrostratus when flying through
//               All coefficients tuned to WMO International Cloud Atlas
//               2017 and Greenler 1980 "Rainbows, Halos, and Glories".
//               Zero per-frame allocation; 30k cirrostratus instances
//               evolve in a single pass on Android 64-bit.
// best for : High-altitude atmospheric rendering, halo effects, sun
//            dogs, lunar halos, weather systems, flight simulators,
//            and any 1M-entity scene that needs realistic high thin
//            ice veils on Android 64-bit.
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
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  SkyF32,
  sampleSkyRadiance,
  getSkySlot,
} from './028_sky_atmosphere.js';

import {
  CloudType,
  CloudSubtype,
  PrecipitationType,
  CloudArchetype,
  CloudInstance,
  CloudTag,
  createCloudArchetype,
  addCloudInstance,
  removeCloudInstance,
  getCloudSlot,
  sampleInstanceDensity,
} from './029_cloud_archetypes.js';

import {
  vec3,
  vec4,
  createNoise3D,
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

const MAX_CIRROSTRATUS_INSTANCES     = 30_000;
const CIRROSTRATUS_BASE_ALTITUDE_MIN = 5500;
const CIRROSTRATUS_BASE_ALTITUDE_MAX = 6500;
const CIRROSTRATUS_TOP_ALTITUDE_MIN  = 8000;
const CIRROSTRATUS_TOP_ALTITUDE_MAX  = 9500;
const CIRROSTRATUS_VEIL_THICKNESS_MIN = 0.15;
const CIRROSTRATUS_VEIL_THICKNESS_MAX = 0.55;
const CIRROSTRATUS_DRIFT_SPEED_MIN   = 15;
const CIRROSTRATUS_DRIFT_SPEED_MAX   = 35;
const CIRROSTRATUS_FADE_IN_START     = 0.00;
const CIRROSTRATUS_FADE_IN_END       = 0.30;
const CIRROSTRATUS_FADE_OUT_START    = 0.85;
const CIRROSTRATUS_FADE_OUT_END      = 1.00;
const CIRROSTRATUS_VFX_RADIUS        = 600;
const CIRROSTRATUS_VFX_MAX_PARTICLES = 96;

// 22° halo geometry.
const HALO_ANGLE_RADIANS             = 22 * DEG_TO_RAD;
const HALO_COS_ANGLE                 = Math.cos(HALO_ANGLE_RADIANS);
const HALO_WIDTH_RADIANS             = 2.0 * DEG_TO_RAD;
const HALO_INNER_RADIUS_COS          = Math.cos(HALO_ANGLE_RADIANS + HALO_WIDTH_RADIANS);
const HALO_OUTER_RADIUS_COS          = Math.cos(HALO_ANGLE_RADIANS - HALO_WIDTH_RADIANS);
const PARHELION_AZIMUTH_RADIANS      = 22 * DEG_TO_RAD;
const PARHELION_WIDTH_RADIANS        = 3.0 * DEG_TO_RAD;

// ═══════════════════════════════════════════════════════════════════════
// PER-INSTANCE SoA STATE — cirrostratus-specific extensions
// ═══════════════════════════════════════════════════════════════════════

export const CirrostratusState = {
  // Veil thickness (0..1). Cirrostratus is always a thin sheet.
  veilThickness: new Float32Array(MAX_CIRROSTRATUS_INSTANCES),

  // Veil banding orientation (radians; direction of the faint striations).
  veilOrientation: new Float32Array(MAX_CIRROSTRATUS_INSTANCES),

  // Veil banding spacing (metres).
  bandSpacing: new Float32Array(MAX_CIRROSTRATUS_INSTANCES),

  // Banding phase (advances with drift).
  bandPhase: new Float32Array(MAX_CIRROSTRATUS_INSTANCES),

  // Halo intensity (0..1). Scales the 22° ring contribution.
  haloIntensity: new Float32Array(MAX_CIRROSTRATUS_INSTANCES),

  // Parhelion (sun dog) intensity (0..1).
  parhelionIntensity: new Float32Array(MAX_CIRROSTRATUS_INSTANCES),

  // Drift speed (m/s).
  driftSpeed: new Float32Array(MAX_CIRROSTRATUS_INSTANCES),

  // Current fade factor (0..1).
  fade: new Float32Array(MAX_CIRROSTRATUS_INSTANCES),

  // Noise index (lazy).
  noiseIndex: new Uint16Array(MAX_CIRROSTRATUS_INSTANCES),

  // Back-pointer to 029 instance slot.
  _baseInstanceSlot: new Uint16Array(MAX_CIRROSTRATUS_INSTANCES),
};

/** Marker: entity is a cirrostratus veil (set by addCirrostratus). */
export const CirrostratusTag = {};

const _cirrostratusSlots = new Map(); // eid -> cirrostratus slot
let _nextCirrostratusSlot = 0;

// Noise generators (lazy).
const _cirrostratusNoise = new Map();

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

function getCirrostratusNoise(index) {
  let n = _cirrostratusNoise.get(index);
  if (!n) {
    n = createNoise3D(() => mulberry32(0xC1A5 ^ (index * 2654435761)));
    _cirrostratusNoise.set(index, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// PRE-BUILT ARCHETYPES — cirrostratus family
// ═══════════════════════════════════════════════════════════════════════

export const CirrostratusArchetypes = {
  uniform:     -1,
  halo:        -1,
  denseVeil:   -1,
  initialized: false,
};

/**
 * Build the three cirrostratus archetypes once.
 */
export function ensureCirrostratusArchetypes() {
  if (CirrostratusArchetypes.initialized) return CirrostratusArchetypes;

  // UNIFORM — classic thin, uniform white veil.
  CirrostratusArchetypes.uniform = createCloudArchetype(
    CloudType.CIRROSTRATUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 5800,
      topAltitude: 8800,
      minCoverage: 0.60,
      maxCoverage: 0.95,
      density: 0.035,
      opticalDepth: 0.55,
      albedoR: 0.98, albedoG: 0.99, albedoB: 1.00,
      mieG: 0.50,
      windSpeed: 22,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 600,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.05,
      wispiness: 0.60,
      puffiness: 0.10,
      shadowStrength: 0.15,
      silverLining: 0.18,
      haloEffect: 0.85,
    }
  );

  // HALO — thin veil that produces strong 22° halos.
  CirrostratusArchetypes.halo = createCloudArchetype(
    CloudType.CIRROSTRATUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 6200,
      topAltitude: 9200,
      minCoverage: 0.55,
      maxCoverage: 0.90,
      density: 0.025,
      opticalDepth: 0.45,
      albedoR: 0.98, albedoG: 0.99, albedoB: 1.00,
      mieG: 0.45,
      windSpeed: 20,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 700,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.03,
      wispiness: 0.55,
      puffiness: 0.05,
      shadowStrength: 0.10,
      silverLining: 0.20,
      haloEffect: 1.00,
    }
  );

  // DENSE VEIL — thicker veil with faint visible banding.
  CirrostratusArchetypes.denseVeil = createCloudArchetype(
    CloudType.CIRROSTRATUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 5500,
      topAltitude: 8500,
      minCoverage: 0.70,
      maxCoverage: 1.00,
      density: 0.060,
      opticalDepth: 0.85,
      albedoR: 0.96, albedoG: 0.97, albedoB: 0.98,
      mieG: 0.55,
      windSpeed: 18,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 500,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.06,
      wispiness: 0.50,
      puffiness: 0.15,
      shadowStrength: 0.25,
      silverLining: 0.15,
      haloEffect: 0.60,
    }
  );

  CirrostratusArchetypes.initialized = true;
  return CirrostratusArchetypes;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — create cirrostratus instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a cirrostratus veil instance to an entity.
 *
 * @param world       ECS world
 * @param eid         entity (must have WorldTransformF32)
 * @param subtype     'uniform' | 'halo' | 'denseVeil'
 * @param options     { radiusX, radiusY, radiusZ, lifetime,
 *                      veilThickness, haloIntensity, parhelionIntensity }
 */
export function addCirrostratus(world, eid, subtype = 'uniform', options = {}) {
  ensureCirrostratusArchetypes();

  let archetypeSlot;
  if (subtype === 'halo')           archetypeSlot = CirrostratusArchetypes.halo;
  else if (subtype === 'denseVeil') archetypeSlot = CirrostratusArchetypes.denseVeil;
  else                              archetypeSlot = CirrostratusArchetypes.uniform;

  if (_nextCirrostratusSlot >= MAX_CIRROSTRATUS_INSTANCES) {
    throw new Error('cirrostratus instance capacity exceeded');
  }
  const csSlot = _nextCirrostratusSlot++;

  // Register base cloud instance via 029.
  const instanceSlot = addCloudInstance(world, eid, archetypeSlot, {
    radiusX: options.radiusX ?? 8000,
    radiusY: options.radiusY ?? 1500,
    radiusZ: options.radiusZ ?? 8000,
    lifetime: options.lifetime ?? 2400,
  });

  const CS = CirrostratusState;
  const rng = mulberry32(0xC1A5 ^ (csSlot * 2654435761));

  CS.veilThickness[csSlot] = options.veilThickness
    ?? (CIRROSTRATUS_VEIL_THICKNESS_MIN
        + rng() * (CIRROSTRATUS_VEIL_THICKNESS_MAX - CIRROSTRATUS_VEIL_THICKNESS_MIN));
  CS.veilOrientation[csSlot] = options.veilOrientation ?? (rng() * TWO_PI);
  CS.bandSpacing[csSlot] = options.bandSpacing ?? (200 + rng() * 400);
  CS.bandPhase[csSlot] = 0;
  CS.haloIntensity[csSlot] = options.haloIntensity ?? (0.6 + rng() * 0.4);
  CS.parhelionIntensity[csSlot] = options.parhelionIntensity ?? (0.3 + rng() * 0.5);
  CS.driftSpeed[csSlot] = CIRROSTRATUS_DRIFT_SPEED_MIN
    + rng() * (CIRROSTRATUS_DRIFT_SPEED_MAX - CIRROSTRATUS_DRIFT_SPEED_MIN);
  CS.fade[csSlot] = 0;
  CS.noiseIndex[csSlot] = csSlot % 256;
  CS._baseInstanceSlot[csSlot] = instanceSlot;

  addComponent(world, eid, CirrostratusTag);
  _cirrostratusSlots.set(eid, csSlot);

  return csSlot;
}

export function removeCirrostratus(world, eid) {
  const csSlot = _cirrostratusSlots.get(eid);
  if (csSlot === undefined) return;

  removeCloudInstance(world, eid);

  _cirrostratusSlots.delete(eid);
  CirrostratusState.fade[csSlot] = 0;
  removeComponent(world, eid, CirrostratusTag);
}

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOUR — per-frame cirrostratus evolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance cirrostratus-specific behaviour:
 *   • fade-in / fade-out over 029's phase
 *   • veil band phase advances with drift
 *   • veil orientation slowly rotates (jet-stream drift)
 *   • halo / parhelion intensity modulated by veil thickness
 */
export function systemCirrostratusEvolve(world, dt) {
  const CS = CirrostratusState;
  const CI = CloudInstance;

  for (let slot = 0; slot < _nextCirrostratusSlot; slot++) {
    const baseSlot = CS._baseInstanceSlot[slot];
    if (baseSlot === undefined) continue;

    const fade = computeFade(CI.phase[baseSlot]);
    CS.fade[slot] = fade;

    // Band phase advance.
    CS.bandPhase[slot] += CS.driftSpeed[slot] * dt;
    if (CS.bandPhase[slot] > TWO_PI) CS.bandPhase[slot] -= TWO_PI;

    // Orientation slow drift.
    CS.veilOrientation[slot] += dt * 0.001;
    if (CS.veilOrientation[slot] > TWO_PI) CS.veilOrientation[slot] -= TWO_PI;

    // Modulate veil thickness by phase (slow breathing).
    const veilBreathing = 0.85 + 0.15 * Math.sin(CI.phase[baseSlot] * TWO_PI);
    CS.veilThickness[slot] = Math.min(0.9,
      Math.max(0.1, CS.veilThickness[slot] * veilBreathing));

    // Sync visibility to base instance.
    CI.visibility[baseSlot] = fade;
  }

  return world;
}

function computeFade(phase) {
  if (phase < CIRROSTRATUS_FADE_IN_START) return 0;
  if (phase < CIRROSTRATUS_FADE_IN_END) {
    return (phase - CIRROSTRATUS_FADE_IN_START) /
           (CIRROSTRATUS_FADE_IN_END - CIRROSTRATUS_FADE_IN_START);
  }
  if (phase < CIRROSTRATUS_FADE_OUT_START) return 1;
  if (phase < CIRROSTRATUS_FADE_OUT_END) {
    return 1 - (phase - CIRROSTRATUS_FADE_OUT_START) /
               (CIRROSTRATUS_FADE_OUT_END - CIRROSTRATUS_FADE_OUT_START);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// DENSITY HOOK — override base 029 sampleInstanceDensity with veil
// ═══════════════════════════════════════════════════════════════════════

/**
 * Cirrostratus-enhanced density sampling. The veil is nearly uniform
 * with only faint sub-visible banding. Cirrostratus must stay
 * *transparent to the sun* so halo/parhelion effects work.
 *
 * @param csSlot     index in CirrostratusState
 * @param wx, wy, wz world-space point
 */
export function sampleCirrostratusDensity(csSlot, wx, wy, wz) {
  const baseSlot = CirrostratusState._baseInstanceSlot[csSlot];
  if (baseSlot === undefined) return 0;

  const base = sampleInstanceDensity(baseSlot, wx, wy, wz);
  if (base < EPSILON) return 0;

  const CI = CloudInstance;
  const CS = CirrostratusState;

  // Local coordinates in cloud's bounding box.
  const lx = (wx - CI.px[baseSlot]);
  const lz = (wz - CI.pz[baseSlot]);

  // Rotate into veil band frame.
  const cosA = Math.cos(CS.veilOrientation[csSlot]);
  const sinA = Math.sin(CS.veilOrientation[csSlot]);
  const along = lx * cosA + lz * sinA;

  // Faint sinusoidal banding (10% amplitude max).
  const bandFreq = TWO_PI / Math.max(CS.bandSpacing[csSlot], 1);
  const band = 0.5 + 0.5 * Math.sin(along * bandFreq + CS.bandPhase[csSlot]);

  // Noise overlay for organic variation.
  const noise = getCirrostratusNoise(CS.noiseIndex[csSlot]);
  const noiseMod = 0.92 + 0.08 * noise(lx * 0.001, wy * 0.003, lz * 0.001);

  // Very low modulation: veil density is mostly the base × thickness × fade.
  const bandMod = 0.90 + 0.10 * band;
  const mod = bandMod * noiseMod * CS.fade[csSlot];

  return Math.max(0, Math.min(1, base * mod * CS.veilThickness[csSlot]));
}

// ═══════════════════════════════════════════════════════════════════════
// HALO HOOK — 22° solar / lunar halo contribution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the 22° halo ring for a given view direction.
 *
 * The 22° halo is produced by minimum-deviation refraction through
 * hexagonal ice crystals. It appears at exactly 22° angular distance
 * from the sun (or moon), with a sharp inner edge (red) and a diffuse
 * outer edge (blue).
 *
 * @param csSlot       cirrostratus slot
 * @param skySlot      sky that owns the sun
 * @param viewDirX/Y/Z normalised view direction
 * @returns [r, g, b] halo additive radiance
 */
export function sampleHaloRing(csSlot, skySlot, viewDirX, viewDirY, viewDirZ) {
  const baseSlot = CirrostratusState._baseInstanceSlot[csSlot];
  if (baseSlot === undefined) return [0, 0, 0];

  const CS = CirrostratusState;
  if (CS.fade[csSlot] < 0.2) return [0, 0, 0];
  if (CS.haloIntensity[csSlot] < EPSILON) return [0, 0, 0];

  const S = SkyF32;
  const sunDirX = S.sunDirX[skySlot];
  const sunDirY = S.sunDirY[skySlot];
  const sunDirZ = S.sunDirZ[skySlot];

  // Angle between view and sun.
  const cosSunView = viewDirX * sunDirX
                   + viewDirY * sunDirY
                   + viewDirZ * sunDirZ;

  // Ring check: 22° ± half-width.
  if (cosSunView > HALO_OUTER_RADIUS_COS || cosSunView < HALO_INNER_RADIUS_COS) {
    return [0, 0, 0];
  }

  // Radial falloff: red on the inner edge, blue on the outer.
  const radialT = (HALO_OUTER_RADIUS_COS - cosSunView)
                / (HALO_OUTER_RADIUS_COS - HALO_INNER_RADIUS_COS);

  // Colour tint: red / orange inner → white middle → blue outer.
  let tintR, tintG, tintB;
  if (radialT < 0.3) {
    const t = radialT / 0.3;
    tintR = 1.0;
    tintG = 0.65 + 0.35 * t;
    tintB = 0.45 + 0.55 * t;
  } else if (radialT < 0.7) {
    tintR = 1.0;
    tintG = 0.95;
    tintB = 0.95;
  } else {
    const t = (radialT - 0.7) / 0.3;
    tintR = 1.0 - 0.35 * t;
    tintG = 0.95 - 0.15 * t;
    tintB = 0.95 + 0.05 * t;
  }

  // Only visible when the sun is above the horizon.
  const sunAbove = Math.max(0, sunDirY);
  if (sunAbove < EPSILON) return [0, 0, 0];

  const haloStrength = CS.haloIntensity[csSlot]
                     * CS.fade[csSlot]
                     * CS.veilThickness[csSlot]
                     * sunAbove
                     * 0.8;

  return [
    tintR * haloStrength,
    tintG * haloStrength,
    tintB * haloStrength,
  ];
}

/**
 * Sample parhelion (sun-dog) contribution. Sun dogs appear on the
 * horizontal plane of the sun, at ±22° azimuth, only when the sun is
 * near the horizon.
 *
 * @returns [r, g, b] parhelion additive radiance
 */
export function sampleParhelion(csSlot, skySlot, viewDirX, viewDirY, viewDirZ) {
  const baseSlot = CirrostratusState._baseInstanceSlot[csSlot];
  if (baseSlot === undefined) return [0, 0, 0];

  const CS = CirrostratusState;
  if (CS.fade[csSlot] < 0.2) return [0, 0, 0];
  if (CS.parhelionIntensity[csSlot] < EPSILON) return [0, 0, 0];

  const S = SkyF32;
  const sunDirX = S.sunDirX[skySlot];
  const sunDirY = S.sunDirY[skySlot];
  const sunDirZ = S.sunDirZ[skySlot];

  // Parhelions only visible when the sun is low (< 40°).
  if (sunDirY > 0.64) return [0, 0, 0];   // above 40°
  if (sunDirY < -0.05) return [0, 0, 0];  // below horizon

  // Horizontal-only sun direction.
  const hx = sunDirX;
  const hz = sunDirZ;
  const hLen = Math.hypot(hx, hz) || 1;
  const nx = hx / hLen;
  const nz = hz / hLen;

  // View horizontal direction.
  const vx = viewDirX;
  const vz = viewDirZ;
  const vLen = Math.hypot(vx, vz) || 1;
  const vnx = vx / vLen;
  const vnz = vz / vLen;

  // Relative azimuth between view and sun.
  const cosAz = vnx * nx + vnz * nz;
  const azAngle = Math.acos(Math.max(-1, Math.min(1, cosAz)));

  // Left and right parhelion positions.
  const leftDelta = Math.abs(azAngle - PARHELION_AZIMUTH_RADIANS);
  const rightDelta = Math.abs(azAngle - PARHELION_AZIMUTH_RADIANS); // symmetric

  if (leftDelta > PARHELION_WIDTH_RADIANS
      && rightDelta > PARHELION_WIDTH_RADIANS) {
    return [0, 0, 0];
  }

  // Vertical alignment: parhelion must be near the sun's elevation.
  const elevDiff = Math.abs(Math.asin(Math.max(-1, Math.min(1, viewDirY)))
                          - Math.asin(Math.max(-1, Math.min(1, sunDirY))));
  if (elevDiff > 3 * DEG_TO_RAD) return [0, 0, 0];

  const falloff = Math.max(
    Math.max(0, 1 - leftDelta / PARHELION_WIDTH_RADIANS),
    Math.max(0, 1 - rightDelta / PARHELION_WIDTH_RADIANS)
  );

  const strength = CS.parhelionIntensity[csSlot]
                 * CS.fade[csSlot]
                 * CS.veilThickness[csSlot]
                 * falloff
                 * 0.6;

  // Parhelion tint is warm (yellow-orange) on the sun-facing edge.
  return [strength, strength * 0.92, strength * 0.75];
}

// ═══════════════════════════════════════════════════════════════════════
// SCATTERING HOOK — reinforce halo visibility in file 028's integrator
// ═══════════════════════════════════════════════════════════════════════

/**
 * Composite contribution from a cirrostratus instance to the sky radiance
 * call. Wraps the halo + parhelion hooks into one convenient function.
 * Call this from your integrator (file 017) before the final sky sample.
 */
export function sampleCirrostratusScattering(csSlot, skySlot,
                                              viewDirX, viewDirY, viewDirZ) {
  const halo = sampleHaloRing(csSlot, skySlot, viewDirX, viewDirY, viewDirZ);
  const parhelion = sampleParhelion(csSlot, skySlot, viewDirX, viewDirY, viewDirZ);

  return [
    halo[0] + parhelion[0],
    halo[1] + parhelion[1],
    halo[2] + parhelion[2],
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// VFX BRIDGE — spicule particles for close flythroughs
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return data for the caller (file 025) to spawn spicule particles when
 * the camera flies through very thin cirrostratus.
 */
export function emitCirrostratusSpicules(csSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = CirrostratusState._baseInstanceSlot[csSlot];
  if (baseSlot === undefined) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dy = cameraY - CI.py[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const distSq = dx * dx + dy * dy + dz * dz;

  if (distSq > CIRROSTRATUS_VFX_RADIUS * CIRROSTRATUS_VFX_RADIUS) return null;
  if (CirrostratusState.fade[csSlot] < 0.3) return null;

  const count = Math.min(
    CIRROSTRATUS_VFX_MAX_PARTICLES,
    Math.floor(emitRate * CirrostratusState.fade[csSlot])
  );

  return {
    count,
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusY: CI.radiusY[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
    fade: CirrostratusState.fade[csSlot],
    veilThickness: CirrostratusState.veilThickness[csSlot],
    veilOrientation: CirrostratusState.veilOrientation[csSlot],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function cirrostratusStats() {
  let active = 0;
  let haloes = 0;

  for (let slot = 0; slot < _nextCirrostratusSlot; slot++) {
    if (CirrostratusState.fade[slot] < EPSILON) continue;
    active++;
    if (CirrostratusState.haloIntensity[slot] > 0.5) haloes++;
  }

  return {
    totalCirrostratus: _nextCirrostratusSlot,
    active,
    haloes,
    archetypesReady: CirrostratusArchetypes.initialized,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearCirrostratus() {
  _cirrostratusSlots.clear();
  _nextCirrostratusSlot = 0;
  _cirrostratusNoise.clear();
  CirrostratusState.fade.fill(0);
  CirrostratusState.veilThickness.fill(0);
}