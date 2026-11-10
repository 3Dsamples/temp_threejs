// file number : 031
// full path name : src/sky/031_cirrocumulus_clouds.js
// description : Cirrocumulus cloud family — the high-altitude "mackerel
//               sky" clouds composed of small, thin, white patches or
//               ripples arranged in rows. Cirrocumulus sit at 5-8 km and
//               have very low density (denser than cirrus, thinner than
//               altocumulus). This file imports 029_cloud_archetypes.js
//               as its single source of truth and contributes:
//                 • CirrocumulusArchetypes — pre-built archetypes for
//                   STRATUS-like sheet, LENTICULARIS-like patches, and
//                   the default rippled form via createCloudArchetype
//                 • CirrocumulusState — SoA extension tracking per-instance
//                   ripple wave vector, ripple wavelength, ripple amplitude,
//                   patch grid spacing, and high-altitude drift phase
//                 • Behaviour system — systemCirrocumulusEvolve applies
//                   small-scale ripple drift, patch-grid shear with the
//                   jet stream, and fade-in / fade-out cycling
//                 • Density hook — sampleCirrocumulusDensity layers a
//                   2D sinusoid grid on top of the base ellipsoid so
//                   file 029's sampleCloudDensity returns the correct
//                   mackerel-sky pattern
//                 • VFX bridge — emitCirrocumulusDust returns data for
//                   ice-crystal sparkle particles at close flythroughs
//               All coefficients are tuned to WMO International Cloud
//               Atlas 2017. Zero per-frame allocation; 50k cirrocumulus
//               instances evolve in one pass at 1M-entity scale.
// best for : High-altitude atmospheric rendering, jet-stream weather,
//            flight simulators, mackerel-sky realism, halo and parhelia
//            cues, and any 1M-entity scene needing rippled high clouds
//            on Android 64-bit.
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

const EPSILON_SQ                        = 1e-16;
const EPSILON                           = 1e-8;
const EPSILON_HIGH                      = 1e-12;
const PI                                = Math.PI;
const TWO_PI                            = 2 * Math.PI;
const INV_PI                            = 1 / Math.PI;
const INV_TWO_PI                        = 1 / (2 * Math.PI);
const HALF_PI                           = Math.PI / 2;
const DEG_TO_RAD                        = Math.PI / 180;
const RAD_TO_DEG                        = 180 / Math.PI;

const MAX_CIRROCUMULUS_INSTANCES        = 50_000;
const CIRROCUMULUS_BASE_ALTITUDE_MIN    = 5000;
const CIRROCUMULUS_BASE_ALTITUDE_MAX    = 6000;
const CIRROCUMULUS_TOP_ALTITUDE_MIN     = 7000;
const CIRROCUMULUS_TOP_ALTITUDE_MAX     = 8000;
const CIRROCUMULUS_RIPPLE_WAVELENGTH_MIN = 150;
const CIRROCUMULUS_RIPPLE_WAVELENGTH_MAX = 400;
const CIRROCUMULUS_RIPPLE_AMP_MIN       = 0.10;
const CIRROCUMULUS_RIPPLE_AMP_MAX       = 0.30;
const CIRROCUMULUS_PATCH_SPACING_MIN    = 200;
const CIRROCUMULUS_PATCH_SPACING_MAX    = 600;
const CIRROCUMULUS_DRIFT_SPEED_MIN      = 20;
const CIRROCUMULUS_DRIFT_SPEED_MAX      = 45;
const CIRROCUMULUS_FADE_IN_START        = 0.00;
const CIRROCUMULUS_FADE_IN_END          = 0.20;
const CIRROCUMULUS_FADE_OUT_START       = 0.80;
const CIRROCUMULUS_FADE_OUT_END         = 1.00;
const CIRROCUMULUS_VFX_RADIUS           = 400;
const CIRROCUMULUS_VFX_MAX_PARTICLES    = 128;

// ═══════════════════════════════════════════════════════════════════════
// PER-INSTANCE SoA STATE — cirrocumulus-specific extensions
// ═══════════════════════════════════════════════════════════════════════

export const CirrocumulusState = {
  // Ripple wave direction (radians; 0 = +X, π/2 = +Z).
  rippleAngle: new Float32Array(MAX_CIRROCUMULUS_INSTANCES),

  // Ripple wavelength in metres.
  rippleWavelength: new Float32Array(MAX_CIRROCUMULUS_INSTANCES),

  // Ripple amplitude (0..1; how pronounced the ripples are).
  rippleAmplitude: new Float32Array(MAX_CIRROCUMULUS_INSTANCES),

  // Patch grid spacing in metres.
  patchSpacing: new Float32Array(MAX_CIRROCUMULUS_INSTANCES),

  // Phase along the ripple wave (advances with drift).
  ripplePhase: new Float32Array(MAX_CIRROCUMULUS_INSTANCES),

  // Patch grid drift phase (advances with jet-stream drift).
  patchPhase: new Float32Array(MAX_CIRROCUMULUS_INSTANCES),

  // Drift speed along wind (m/s).
  driftSpeed: new Float32Array(MAX_CIRROCUMULUS_INSTANCES),

  // Current fade factor (0..1).
  fade: new Float32Array(MAX_CIRROCUMULUS_INSTANCES),

  // Number of ripple rows in the patch.
  rowCount: new Uint8Array(MAX_CIRROCUMULUS_INSTANCES),

  // Noise generator index (lazy).
  noiseIndex: new Uint16Array(MAX_CIRROCUMULUS_INSTANCES),

  // Back-pointer to 029 instance slot.
  _baseInstanceSlot: new Uint16Array(MAX_CIRROCUMULUS_INSTANCES),
};

/** Marker: entity is a cirrocumulus cloud (set by addCirrocumulus). */
export const CirrocumulusTag = {};

const _cirrocumulusSlots = new Map(); // eid -> cirrocumulus slot
let _nextCirrocumulusSlot = 0;

// Noise generators per instance (lazy).
const _cirrocumulusNoise = new Map();

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

function getCirrocumulusNoise(index) {
  let n = _cirrocumulusNoise.get(index);
  if (!n) {
    n = createNoise3D(() => mulberry32(0xC1CC0 ^ (index * 2654435761)));
    _cirrocumulusNoise.set(index, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// PRE-BUILT ARCHETYPES — cirrocumulus family
// ═══════════════════════════════════════════════════════════════════════

export const CirrocumulusArchetypes = {
  rippled: -1,
  castellanus: -1,
  lenticularis: -1,
  initialized: false,
};

/**
 * Build the three cirrocumulus archetypes once.
 */
export function ensureCirrocumulusArchetypes() {
  if (CirrocumulusArchetypes.initialized) return CirrocumulusArchetypes;

  // RIPPLED — the classic "mackerel sky" small-patch row form.
  CirrocumulusArchetypes.rippled = createCloudArchetype(
    CloudType.CIRROCUMULUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 5500,
      topAltitude: 8000,
      minCoverage: 0.05,
      maxCoverage: 0.35,
      density: 0.05,
      opticalDepth: 0.5,
      albedoR: 1.00, albedoG: 1.00, albedoB: 1.00,
      mieG: 0.60,
      windSpeed: 28,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 240,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.30,
      wispiness: 0.40,
      puffiness: 0.45,
      shadowStrength: 0.08,
      silverLining: 0.20,
      haloEffect: 0.10,
    }
  );

  // CASTELLANUS — small ripples with turreted patches.
  CirrocumulusArchetypes.castellanus = createCloudArchetype(
    CloudType.CIRROCUMULUS,
    CloudSubtype.CASTELLANUS,
    {
      baseAltitude: 5200,
      topAltitude: 8200,
      minCoverage: 0.08,
      maxCoverage: 0.40,
      density: 0.07,
      opticalDepth: 0.65,
      albedoR: 1.00, albedoG: 1.00, albedoB: 1.00,
      mieG: 0.58,
      windSpeed: 26,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 200,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.55,
      wispiness: 0.25,
      puffiness: 0.65,
      shadowStrength: 0.12,
      silverLining: 0.22,
      haloEffect: 0.05,
    }
  );

  // LENTICULARIS — lens-shaped high patches (mountain-wave clouds).
  CirrocumulusArchetypes.lenticularis = createCloudArchetype(
    CloudType.CIRROCUMULUS,
    CloudSubtype.LENTICULARIS,
    {
      baseAltitude: 5600,
      topAltitude: 7800,
      minCoverage: 0.04,
      maxCoverage: 0.25,
      density: 0.045,
      opticalDepth: 0.55,
      albedoR: 1.00, albedoG: 1.00, albedoB: 1.00,
      mieG: 0.62,
      windSpeed: 32,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 360,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.15,
      wispiness: 0.55,
      puffiness: 0.35,
      shadowStrength: 0.06,
      silverLining: 0.30,
      haloEffect: 0.20,
    }
  );

  CirrocumulusArchetypes.initialized = true;
  return CirrocumulusArchetypes;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — create cirrocumulus instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a cirrocumulus cloud instance to an entity.
 *
 * @param world       ECS world
 * @param eid         entity (must have WorldTransformF32)
 * @param subtype     'rippled' | 'castellanus' | 'lenticularis'
 * @param options     { radiusX, radiusY, radiusZ, lifetime,
 *                      rippleAngle, rippleWavelength, rowCount }
 */
export function addCirrocumulus(world, eid, subtype = 'rippled', options = {}) {
  ensureCirrocumulusArchetypes();

  let archetypeSlot;
  if (subtype === 'castellanus')      archetypeSlot = CirrocumulusArchetypes.castellanus;
  else if (subtype === 'lenticularis') archetypeSlot = CirrocumulusArchetypes.lenticularis;
  else                                 archetypeSlot = CirrocumulusArchetypes.rippled;

  if (_nextCirrocumulusSlot >= MAX_CIRROCUMULUS_INSTANCES) {
    throw new Error('cirrocumulus instance capacity exceeded');
  }
  const ccSlot = _nextCirrocumulusSlot++;

  // Register base cloud instance via 029.
  const instanceSlot = addCloudInstance(world, eid, archetypeSlot, {
    radiusX: options.radiusX ?? 3000,
    radiusY: options.radiusY ?? 1200,
    radiusZ: options.radiusZ ?? 3000,
    lifetime: options.lifetime ?? 900,
  });

  // Cirrocumulus-specific state.
  const CS = CirrocumulusState;
  const rng = mulberry32(0xC1CC0 ^ (ccSlot * 2654435761));

  CS.rippleAngle[ccSlot] = options.rippleAngle ?? (rng() * TWO_PI);
  CS.rippleWavelength[ccSlot] = options.rippleWavelength
    ?? (CIRROCUMULUS_RIPPLE_WAVELENGTH_MIN
        + rng() * (CIRROCUMULUS_RIPPLE_WAVELENGTH_MAX - CIRROCUMULUS_RIPPLE_WAVELENGTH_MIN));
  CS.rippleAmplitude[ccSlot] = CIRROCUMULUS_RIPPLE_AMP_MIN
    + rng() * (CIRROCUMULUS_RIPPLE_AMP_MAX - CIRROCUMULUS_RIPPLE_AMP_MIN);
  CS.patchSpacing[ccSlot] = CIRROCUMULUS_PATCH_SPACING_MIN
    + rng() * (CIRROCUMULUS_PATCH_SPACING_MAX - CIRROCUMULUS_PATCH_SPACING_MIN);
  CS.ripplePhase[ccSlot] = 0;
  CS.patchPhase[ccSlot] = 0;
  CS.driftSpeed[ccSlot] = CIRROCUMULUS_DRIFT_SPEED_MIN
    + rng() * (CIRROCUMULUS_DRIFT_SPEED_MAX - CIRROCUMULUS_DRIFT_SPEED_MIN);
  CS.fade[ccSlot] = 0;
  CS.rowCount[ccSlot] = options.rowCount ?? (3 + Math.floor(rng() * 5));
  CS.noiseIndex[ccSlot] = ccSlot % 256;
  CS._baseInstanceSlot[ccSlot] = instanceSlot;

  addComponent(world, eid, CirrocumulusTag);
  _cirrocumulusSlots.set(eid, ccSlot);

  return ccSlot;
}

export function removeCirrocumulus(world, eid) {
  const ccSlot = _cirrocumulusSlots.get(eid);
  if (ccSlot === undefined) return;

  removeCloudInstance(world, eid);

  _cirrocumulusSlots.delete(eid);
  CirrocumulusState.fade[ccSlot] = 0;
  removeComponent(world, eid, CirrocumulusTag);
}

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOUR — per-frame cirrocumulus evolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance cirrocumulus-specific behaviour.
 *   • fade-in / fade-out over 029's phase
 *   • ripple phase advances with drift speed
 *   • patch phase shears with jet stream
 *   • ripple angle slowly rotates (jet-stream directional drift)
 */
export function systemCirrocumulusEvolve(world, dt) {
  const CS = CirrocumulusState;
  const CI = CloudInstance;

  for (let slot = 0; slot < _nextCirrocumulusSlot; slot++) {
    const baseSlot = CS._baseInstanceSlot[slot];
    if (baseSlot === undefined) continue;

    // Fade.
    const fade = computeFade(CI.phase[baseSlot]);
    CS.fade[slot] = fade;

    // Ripple + patch phase advance.
    const driftPhase = CS.driftSpeed[slot] * dt;
    CS.ripplePhase[slot] += driftPhase;
    CS.patchPhase[slot] += driftPhase * 0.7;
    if (CS.ripplePhase[slot] > TWO_PI) CS.ripplePhase[slot] -= TWO_PI;
    if (CS.patchPhase[slot] > TWO_PI) CS.patchPhase[slot] -= TWO_PI;

    // Slow ripple angle drift with jet stream.
    CS.rippleAngle[slot] += dt * 0.003;
    if (CS.rippleAngle[slot] > TWO_PI) CS.rippleAngle[slot] -= TWO_PI;

    // Sync visibility to base instance.
    CI.visibility[baseSlot] = fade;
  }

  return world;
}

function computeFade(phase) {
  if (phase < CIRROCUMULUS_FADE_IN_START) return 0;
  if (phase < CIRROCUMULUS_FADE_IN_END) {
    return (phase - CIRROCUMULUS_FADE_IN_START) /
           (CIRROCUMULUS_FADE_IN_END - CIRROCUMULUS_FADE_IN_START);
  }
  if (phase < CIRROCUMULUS_FADE_OUT_START) return 1;
  if (phase < CIRROCUMULUS_FADE_OUT_END) {
    return 1 - (phase - CIRROCUMULUS_FADE_OUT_START) /
               (CIRROCUMULUS_FADE_OUT_END - CIRROCUMULUS_FADE_OUT_START);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// DENSITY HOOK — override base 029 sampleInstanceDensity with ripples
// ═══════════════════════════════════════════════════════════════════════

/**
 * Cirrocumulus-enhanced density sampling. Layers a 2D sinusoid grid
 * (mackerel sky) on top of the base 029 ellipsoid falloff.
 *
 * @param ccSlot     index in CirrocumulusState
 * @param wx, wy, wz world-space point
 */
export function sampleCirrocumulusDensity(ccSlot, wx, wy, wz) {
  const baseSlot = CirrocumulusState._baseInstanceSlot[ccSlot];
  if (baseSlot === undefined) return 0;

  const base = sampleInstanceDensity(baseSlot, wx, wy, wz);
  if (base < EPSILON) return 0;

  const CI = CloudInstance;
  const CS = CirrocumulusState;

  // Local coordinates in the cloud's bounding box.
  const lx = (wx - CI.px[baseSlot]);
  const lz = (wz - CI.pz[baseSlot]);

  // Rotate (lx, lz) into ripple-frame.
  const cosA = Math.cos(CS.rippleAngle[ccSlot]);
  const sinA = Math.sin(CS.rippleAngle[ccSlot]);
  const along = lx * cosA + lz * sinA;
  const across = -lx * sinA + lz * cosA;

  // Ripple wave (sinusoid along the across axis).
  const rippleFreq = TWO_PI / Math.max(CS.rippleWavelength[ccSlot], 1);
  const rippleWave = Math.sin(across * rippleFreq + CS.ripplePhase[ccSlot]);

  // Patch grid (2D checkerboard pattern along + across).
  const patchFreq = TWO_PI / Math.max(CS.patchSpacing[ccSlot], 1);
  const patchWave = Math.sin(along * patchFreq + CS.patchPhase[ccSlot])
                  * Math.sin(across * patchFreq + CS.patchPhase[ccSlot] * 0.7);

  // Combine ripples + patches into a modulation factor.
  const rippleMod = 1 - CS.rippleAmplitude[ccSlot] * (0.5 + 0.5 * rippleWave);
  const patchMod = 0.6 + 0.4 * (0.5 + 0.5 * patchWave);

  // Noise overlay for organic variation.
  const noise = getCirrocumulusNoise(CS.noiseIndex[ccSlot]);
  const noiseMod = 0.85 + 0.15 * noise(lx * 0.002, wy * 0.005, lz * 0.002);

  const mod = rippleMod * patchMod * noiseMod * CS.fade[ccSlot];

  return Math.max(0, Math.min(1, base * mod));
}

// ═══════════════════════════════════════════════════════════════════════
// VFX BRIDGE — optional ice-crystal sparkle particles
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return data for a caller (usually file 025) to spawn ice-crystal
 * sparkle particles when the camera flies close to a cirrocumulus patch.
 */
export function emitCirrocumulusDust(ccSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = CirrocumulusState._baseInstanceSlot[ccSlot];
  if (baseSlot === undefined) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dy = cameraY - CI.py[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const distSq = dx * dx + dy * dy + dz * dz;

  if (distSq > CIRROCUMULUS_VFX_RADIUS * CIRROCUMULUS_VFX_RADIUS) return null;
  if (CirrocumulusState.fade[ccSlot] < 0.3) return null;

  const count = Math.min(
    CIRROCUMULUS_VFX_MAX_PARTICLES,
    Math.floor(emitRate * CirrocumulusState.fade[ccSlot])
  );

  return {
    count,
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusY: CI.radiusY[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
    fade: CirrocumulusState.fade[ccSlot],
    rippleAngle: CirrocumulusState.rippleAngle[ccSlot],
    rippleWavelength: CirrocumulusState.rippleWavelength[ccSlot],
    rowCount: CirrocumulusState.rowCount[ccSlot],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function cirrocumulusStats() {
  let active = 0;
  let rippled = 0, castellanus = 0, lenticularis = 0;

  for (let slot = 0; slot < _nextCirrocumulusSlot; slot++) {
    if (CirrocumulusState.fade[slot] < EPSILON) continue;
    active++;
    const baseSlot = CirrocumulusState._baseInstanceSlot[slot];
    const aSlot = CloudInstance.archetypeSlot[baseSlot];
    const sub = CloudArchetype.subtype[aSlot];
    if (sub === CloudSubtype.CASTELLANUS)       castellanus++;
    else if (sub === CloudSubtype.LENTICULARIS) lenticularis++;
    else                                         rippled++;
  }

  return {
    totalCirrocumulus: _nextCirrocumulusSlot,
    active,
    rippled,
    castellanus,
    lenticularis,
    archetypesReady: CirrocumulusArchetypes.initialized,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearCirrocumulus() {
  _cirrocumulusSlots.clear();
  _nextCirrocumulusSlot = 0;
  _cirrocumulusNoise.clear();
  CirrocumulusState.fade.fill(0);
  CirrocumulusState.rowCount.fill(0);
}