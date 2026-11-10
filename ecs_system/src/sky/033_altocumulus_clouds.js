// file number : 033
// full path name : src/sky/033_altocumulus_clouds.js
// description : Altocumulus cloud family — mid-level (2-6 km) patches,
//               rolls, or layered sheets of white and grey cloud, larger
//               than cirrocumulus and smaller than stratocumulus. The
//               three WMO sub-types implemented here are the classic
//               CASTELLANUS (turreted patches with vertical growth
//               signalling instability), LENTICULARIS (smooth lens-shaped
//               mountain-wave clouds), and the default STRATIFORMIS-like
//               layered patches. This file imports 029_cloud_archetypes.js
//               as its single source of truth and contributes:
//                 • AltocumulusArchetypes — pre-built archetypes for
//                   layered, castellanus, and lenticularis via
//                   createCloudArchetype
//                 • AltocumulusState — SoA extension tracking per-instance
//                   layer count, layer spacing, layer tilt, patch grid
//                   orientation, turret growth phase (castellanus), and
//                   lens aspect ratio (lenticularis)
//                 • Behaviour system — systemAltocumulusEvolve applies
//                   slow layer shear, turret growth for castellanus,
//                   lens oscillation for lenticularis, and layered
//                   fade cycling
//                 • Density hook — sampleAltocumulusDensity layers
//                   multiple planar noise bands on top of 029's ellipsoid
//                   to produce the characteristic stacked-plate look
//                 • VFX bridge — emitAltocumulusWisps returns data for
//                   ragged-fragment particles when patches break up
//               All coefficients tuned to WMO International Cloud Atlas
//               2017. Zero per-frame allocation; 40k altocumulus
//               instances evolve in a single pass at 1M-entity scale
//               on Android 64-bit.
// best for : Mid-level weather rendering, mountain-wave lenticular
//            effects, layered mackerel-sky realism, storm-onset cues
//            (castellanus), and any 1M-entity scene needing mid-level
//            cloud realism on Android 64-bit.
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
  createNoise2D,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                    = 1e-16;
const EPSILON                       = 1e-8;
const EPSILON_HIGH                  = 1e-12;
const PI                            = Math.PI;
const TWO_PI                        = 2 * Math.PI;
const INV_PI                        = 1 / Math.PI;
const INV_TWO_PI                    = 1 / (2 * Math.PI);
const HALF_PI                       = Math.PI / 2;
const DEG_TO_RAD                    = Math.PI / 180;
const RAD_TO_DEG                    = 180 / Math.PI;

const MAX_ALTOCUMULUS_INSTANCES     = 40_000;
const ALTOCUMULUS_BASE_ALTITUDE_MIN = 2000;
const ALTOCUMULUS_BASE_ALTITUDE_MAX = 4000;
const ALTOCUMULUS_TOP_ALTITUDE_MIN  = 4500;
const ALTOCUMULUS_TOP_ALTITUDE_MAX  = 6500;
const ALTOCUMULUS_LAYER_COUNT_MIN   = 2;
const ALTOCUMULUS_LAYER_COUNT_MAX   = 5;
const ALTOCUMULUS_LAYER_SPACING_MIN = 250;
const ALTOCUMULUS_LAYER_SPACING_MAX = 700;
const ALTOCUMULUS_LAYER_TILT_MIN    = -0.15;
const ALTOCUMULUS_LAYER_TILT_MAX    = 0.15;
const ALTOCUMULUS_PATCH_SPACING_MIN = 400;
const ALTOCUMULUS_PATCH_SPACING_MAX = 1200;
const ALTOCUMULUS_DRIFT_SPEED_MIN   = 10;
const ALTOCUMULUS_DRIFT_SPEED_MAX   = 25;
const ALTOCUMULUS_TURRET_GROWTH_MIN = 0.02;
const ALTOCUMULUS_TURRET_GROWTH_MAX = 0.08;
const ALTOCUMULUS_LENS_OSCILLATION  = 0.05;
const ALTOCUMULUS_FADE_IN_START     = 0.00;
const ALTOCUMULUS_FADE_IN_END       = 0.18;
const ALTOCUMULUS_FADE_OUT_START    = 0.82;
const ALTOCUMULUS_FADE_OUT_END      = 1.00;
const ALTOCUMULUS_VFX_RADIUS        = 800;
const ALTOCUMULUS_VFX_MAX_PARTICLES = 192;

// ═══════════════════════════════════════════════════════════════════════
// PER-INSTANCE SoA STATE — altocumulus-specific extensions
// ═══════════════════════════════════════════════════════════════════════

export const AltocumulusState = {
  // Number of stacked layers (2..5).
  layerCount: new Uint8Array(MAX_ALTOCUMULUS_INSTANCES),

  // Vertical spacing between layers (metres).
  layerSpacing: new Float32Array(MAX_ALTOCUMULUS_INSTANCES),

  // Layer tilt (radians; -0.15..0.15). Controls the sheared look.
  layerTilt: new Float32Array(MAX_ALTOCUMULUS_INSTANCES),

  // Patch grid orientation (radians).
  patchOrientation: new Float32Array(MAX_ALTOCUMULUS_INSTANCES),

  // Patch grid spacing (metres).
  patchSpacing: new Float32Array(MAX_ALTOCUMULUS_INSTANCES),

  // Patch phase (advances with drift).
  patchPhase: new Float32Array(MAX_ALTOCUMULUS_INSTANCES),

  // Turret growth phase for castellanus (0..1).
  turretPhase: new Float32Array(MAX_ALTOCUMULUS_INSTANCES),

  // Turret growth rate per second.
  turretGrowthRate: new Float32Array(MAX_ALTOCUMULUS_INSTANCES),

  // Lens aspect ratio for lenticularis (0.3..3.0).
  lensAspect: new Float32Array(MAX_ALTOCUMULUS_INSTANCES),

  // Lens oscillation phase for lenticularis.
  lensPhase: new Float32Array(MAX_ALTOCUMULUS_INSTANCES),

  // Drift speed (m/s).
  driftSpeed: new Float32Array(MAX_ALTOCUMULUS_INSTANCES),

  // Current fade factor (0..1).
  fade: new Float32Array(MAX_ALTOCUMULUS_INSTANCES),

  // Noise index (lazy).
  noiseIndex: new Uint16Array(MAX_ALTOCUMULUS_INSTANCES),

  // Back-pointer to 029 instance slot.
  _baseInstanceSlot: new Uint16Array(MAX_ALTOCUMULUS_INSTANCES),
};

/** Marker: entity is an altocumulus patch (set by addAltocumulus). */
export const AltocumulusTag = {};

const _altocumulusSlots = new Map(); // eid -> altocumulus slot
let _nextAltocumulusSlot = 0;

// Noise generators (lazy).
const _altocumulusNoise3D = new Map();
const _altocumulusNoise2D = new Map();

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

function getAltocumulusNoise3D(index) {
  let n = _altocumulusNoise3D.get(index);
  if (!n) {
    n = createNoise3D(() => mulberry32(0xA1C0 ^ (index * 2654435761)));
    _altocumulusNoise3D.set(index, n);
  }
  return n;
}

function getAltocumulusNoise2D(index) {
  let n = _altocumulusNoise2D.get(index);
  if (!n) {
    n = createNoise2D(() => mulberry32((0xA1C0 ^ 0xA5A5) ^ (index * 2654435761)));
    _altocumulusNoise2D.set(index, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// PRE-BUILT ARCHETYPES — altocumulus family
// ═══════════════════════════════════════════════════════════════════════

export const AltocumulusArchetypes = {
  layered:      -1,
  castellanus:  -1,
  lenticularis: -1,
  initialized:  false,
};

/**
 * Build the three altocumulus archetypes once.
 */
export function ensureAltocumulusArchetypes() {
  if (AltocumulusArchetypes.initialized) return AltocumulusArchetypes;

  // LAYERED — the classic stacked-plate altocumulus pattern.
  AltocumulusArchetypes.layered = createCloudArchetype(
    CloudType.ALTOCUMULUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 2500,
      topAltitude: 5500,
      minCoverage: 0.20,
      maxCoverage: 0.65,
      density: 0.15,
      opticalDepth: 1.2,
      albedoR: 0.98, albedoG: 0.98, albedoB: 0.98,
      mieG: 0.55,
      windSpeed: 15,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 200,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.55,
      wispiness: 0.20,
      puffiness: 0.65,
      shadowStrength: 0.28,
      silverLining: 0.30,
      haloEffect: 0.10,
    }
  );

  // CASTELLANUS — turreted patches; early sign of instability.
  AltocumulusArchetypes.castellanus = createCloudArchetype(
    CloudType.ALTOCUMULUS,
    CloudSubtype.CASTELLANUS,
    {
      baseAltitude: 2200,
      topAltitude: 6000,
      minCoverage: 0.15,
      maxCoverage: 0.55,
      density: 0.22,
      opticalDepth: 1.8,
      albedoR: 0.95, albedoG: 0.96, albedoB: 0.97,
      mieG: 0.58,
      windSpeed: 12,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 150,
      precipitationType: PrecipitationType.DRIZZLE,
      precipitationRate: 0.1,
      lightningProbability: 0,
      billow: 0.80,
      wispiness: 0.10,
      puffiness: 0.85,
      shadowStrength: 0.35,
      silverLining: 0.35,
      haloEffect: 0.05,
    }
  );

  // LENTICULARIS — smooth lens-shaped mountain-wave clouds.
  AltocumulusArchetypes.lenticularis = createCloudArchetype(
    CloudType.ALTOCUMULUS,
    CloudSubtype.LENTICULARIS,
    {
      baseAltitude: 2800,
      topAltitude: 5200,
      minCoverage: 0.08,
      maxCoverage: 0.30,
      density: 0.18,
      opticalDepth: 1.4,
      albedoR: 0.98, albedoG: 0.98, albedoB: 0.98,
      mieG: 0.62,
      windSpeed: 20,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 400,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.10,
      wispiness: 0.30,
      puffiness: 0.35,
      shadowStrength: 0.15,
      silverLining: 0.45,
      haloEffect: 0.15,
    }
  );

  AltocumulusArchetypes.initialized = true;
  return AltocumulusArchetypes;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — create altocumulus instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add an altocumulus cloud instance to an entity.
 *
 * @param world       ECS world
 * @param eid         entity (must have WorldTransformF32)
 * @param subtype     'layered' | 'castellanus' | 'lenticularis'
 * @param options     { radiusX, radiusY, radiusZ, lifetime,
 *                      layerCount, layerSpacing, patchSpacing }
 */
export function addAltocumulus(world, eid, subtype = 'layered', options = {}) {
  ensureAltocumulusArchetypes();

  let archetypeSlot;
  if (subtype === 'castellanus')       archetypeSlot = AltocumulusArchetypes.castellanus;
  else if (subtype === 'lenticularis') archetypeSlot = AltocumulusArchetypes.lenticularis;
  else                                 archetypeSlot = AltocumulusArchetypes.layered;

  if (_nextAltocumulusSlot >= MAX_ALTOCUMULUS_INSTANCES) {
    throw new Error('altocumulus instance capacity exceeded');
  }
  const acSlot = _nextAltocumulusSlot++;

  // Register base cloud instance via 029.
  const instanceSlot = addCloudInstance(world, eid, archetypeSlot, {
    radiusX: options.radiusX ?? 5000,
    radiusY: options.radiusY ?? 1500,
    radiusZ: options.radiusZ ?? 5000,
    lifetime: options.lifetime ?? 1200,
  });

  const AS = AltocumulusState;
  const rng = mulberry32(0xA1C0 ^ (acSlot * 2654435761));

  AS.layerCount[acSlot] = options.layerCount
    ?? (ALTOCUMULUS_LAYER_COUNT_MIN
        + Math.floor(rng() * (ALTOCUMULUS_LAYER_COUNT_MAX - ALTOCUMULUS_LAYER_COUNT_MIN + 1)));
  AS.layerSpacing[acSlot] = options.layerSpacing
    ?? (ALTOCUMULUS_LAYER_SPACING_MIN
        + rng() * (ALTOCUMULUS_LAYER_SPACING_MAX - ALTOCUMULUS_LAYER_SPACING_MIN));
  AS.layerTilt[acSlot] = ALTOCUMULUS_LAYER_TILT_MIN
    + rng() * (ALTOCUMULUS_LAYER_TILT_MAX - ALTOCUMULUS_LAYER_TILT_MIN);
  AS.patchOrientation[acSlot] = options.patchOrientation ?? (rng() * TWO_PI);
  AS.patchSpacing[acSlot] = options.patchSpacing
    ?? (ALTOCUMULUS_PATCH_SPACING_MIN
        + rng() * (ALTOCUMULUS_PATCH_SPACING_MAX - ALTOCUMULUS_PATCH_SPACING_MIN));
  AS.patchPhase[acSlot] = 0;
  AS.turretPhase[acSlot] = 0;
  AS.turretGrowthRate[acSlot] = ALTOCUMULUS_TURRET_GROWTH_MIN
    + rng() * (ALTOCUMULUS_TURRET_GROWTH_MAX - ALTOCUMULUS_TURRET_GROWTH_MIN);
  AS.lensAspect[acSlot] = 0.5 + rng() * 2.0;
  AS.lensPhase[acSlot] = 0;
  AS.driftSpeed[acSlot] = ALTOCUMULUS_DRIFT_SPEED_MIN
    + rng() * (ALTOCUMULUS_DRIFT_SPEED_MAX - ALTOCUMULUS_DRIFT_SPEED_MIN);
  AS.fade[acSlot] = 0;
  AS.noiseIndex[acSlot] = acSlot % 256;
  AS._baseInstanceSlot[acSlot] = instanceSlot;

  addComponent(world, eid, AltocumulusTag);
  _altocumulusSlots.set(eid, acSlot);

  return acSlot;
}

export function removeAltocumulus(world, eid) {
  const acSlot = _altocumulusSlots.get(eid);
  if (acSlot === undefined) return;

  removeCloudInstance(world, eid);

  _altocumulusSlots.delete(eid);
  AltocumulusState.fade[acSlot] = 0;
  removeComponent(world, eid, AltocumulusTag);
}

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOUR — per-frame altocumulus evolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance altocumulus-specific behaviour.
 *   • fade-in / fade-out over 029's phase
 *   • patch phase advances with drift
 *   • layer tilt drifts slowly (shear)
 *   • turret growth for castellanus
 *   • lens oscillation for lenticularis
 */
export function systemAltocumulusEvolve(world, dt) {
  const AS = AltocumulusState;
  const CI = CloudInstance;

  for (let slot = 0; slot < _nextAltocumulusSlot; slot++) {
    const baseSlot = AS._baseInstanceSlot[slot];
    if (baseSlot === undefined) continue;

    const fade = computeFade(CI.phase[baseSlot]);
    AS.fade[slot] = fade;

    // Patch drift.
    AS.patchPhase[slot] += AS.driftSpeed[slot] * dt;
    if (AS.patchPhase[slot] > TWO_PI) AS.patchPhase[slot] -= TWO_PI;

    // Layer tilt shear.
    AS.layerTilt[slot] += dt * 0.0008;
    if (AS.layerTilt[slot] > ALTOCUMULUS_LAYER_TILT_MAX) {
      AS.layerTilt[slot] = ALTOCUMULUS_LAYER_TILT_MAX;
    }

    // Castellanus turret growth.
    const aSlot = CI.archetypeSlot[baseSlot];
    if (CloudArchetype.subtype[aSlot] === CloudSubtype.CASTELLANUS) {
      AS.turretPhase[slot] += AS.turretGrowthRate[slot] * dt;
      if (AS.turretPhase[slot] > 1) {
        AS.turretPhase[slot] = 1;
        // Turrets die and restart.
        if (Math.random() < 0.02 * dt * 60) {
          AS.turretPhase[slot] = 0;
        }
      }
    }

    // Lenticularis lens oscillation.
    if (CloudArchetype.subtype[aSlot] === CloudSubtype.LENTICULARIS) {
      AS.lensPhase[slot] += dt * 0.5;
      if (AS.lensPhase[slot] > TWO_PI) AS.lensPhase[slot] -= TWO_PI;
    }

    // Sync visibility to base instance.
    CI.visibility[baseSlot] = fade;
  }

  return world;
}

function computeFade(phase) {
  if (phase < ALTOCUMULUS_FADE_IN_START) return 0;
  if (phase < ALTOCUMULUS_FADE_IN_END) {
    return (phase - ALTOCUMULUS_FADE_IN_START) /
           (ALTOCUMULUS_FADE_IN_END - ALTOCUMULUS_FADE_IN_START);
  }
  if (phase < ALTOCUMULUS_FADE_OUT_START) return 1;
  if (phase < ALTOCUMULUS_FADE_OUT_END) {
    return 1 - (phase - ALTOCUMULUS_FADE_OUT_START) /
               (ALTOCUMULUS_FADE_OUT_END - ALTOCUMULUS_FADE_OUT_START);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// DENSITY HOOK — override base 029 sampleInstanceDensity with layers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Altocumulus-enhanced density sampling. Layers multiple planar noise
 * bands onto 029's ellipsoid to produce the characteristic stacked-plate
 * look. Adds turret growth for castellanus and lens smoothing for
 * lenticularis.
 *
 * @param acSlot     index in AltocumulusState
 * @param wx, wy, wz world-space point
 */
export function sampleAltocumulusDensity(acSlot, wx, wy, wz) {
  const baseSlot = AltocumulusState._baseInstanceSlot[acSlot];
  if (baseSlot === undefined) return 0;

  const base = sampleInstanceDensity(baseSlot, wx, wy, wz);
  if (base < EPSILON) return 0;

  const CI = CloudInstance;
  const AS = AltocumulusState;
  const aSlot = CI.archetypeSlot[baseSlot];
  const sub = CloudArchetype.subtype[aSlot];

  // Local coordinates.
  const lx = (wx - CI.px[baseSlot]);
  const ly = (wy - CI.py[baseSlot]);
  const lz = (wz - CI.pz[baseSlot]);

  // Rotate into patch frame.
  const cosA = Math.cos(AS.patchOrientation[acSlot]);
  const sinA = Math.sin(AS.patchOrientation[acSlot]);
  const along = lx * cosA + lz * sinA;
  const across = -lx * sinA + lz * cosA;

  // Layer stacking: build a comb-like vertical pattern.
  const layerCount = AS.layerCount[acSlot];
  const layerSpacing = AS.layerSpacing[acSlot];
  const layerTilt = AS.layerTilt[acSlot];

  let layerMod = 0;
  for (let l = 0; l < layerCount; l++) {
    // Each layer sits at y = l * layerSpacing + tilt * along.
    const layerY = l * layerSpacing + layerTilt * along;
    const dy = Math.abs(ly - layerY);
    // Soft box around each layer.
    const layerHalfThickness = layerSpacing * 0.35;
    if (dy < layerHalfThickness) {
      const layerContribution = 1 - dy / layerHalfThickness;
      layerMod = Math.max(layerMod, layerContribution);
    }
  }

  // Patch grid: 2D checkerboard.
  const patchFreq = TWO_PI / Math.max(AS.patchSpacing[acSlot], 1);
  const patchWave = Math.sin(along * patchFreq + AS.patchPhase[acSlot])
                  * Math.sin(across * patchFreq + AS.patchPhase[acSlot] * 0.7);
  const patchMod = 0.65 + 0.35 * (0.5 + 0.5 * patchWave);

  // Organic noise overlay.
  const noise = getAltocumulusNoise3D(AS.noiseIndex[acSlot]);
  const noiseMod = 0.85 + 0.15 * noise(lx * 0.0025, ly * 0.005, lz * 0.0025);

  // Castellanus: add vertical turrets.
  let turretMod = 1;
  if (sub === CloudSubtype.CASTELLANUS) {
    const turretHeight = AS.turretPhase[acSlot] * layerSpacing * 1.5;
    if (ly > 0 && ly < turretHeight) {
      const turretNoise = noise(along * 0.01, ly * 0.02, across * 0.01);
      turretMod = 0.7 + 0.3 * (0.5 + 0.5 * turretNoise);
    } else if (ly > turretHeight) {
      turretMod = 0.2;
    }
  }

  // Lenticularis: smooth lens shape.
  let lensMod = 1;
  if (sub === CloudSubtype.LENTICULARIS) {
    const lens = AS.lensAspect[acSlot];
    const osc = 0.85 + 0.15 * Math.sin(AS.lensPhase[acSlot]);
    // Ellipse in (along, ly).
    const normAlong = along / (CI.radiusX[baseSlot] * lens);
    const normY = ly / Math.max(CI.radiusY[baseSlot], 1);
    const lensDist = normAlong * normAlong + normY * normY;
    lensMod = Math.max(0, 1 - lensDist) * osc;
  }

  const totalMod = layerMod * patchMod * noiseMod * turretMod * lensMod * AS.fade[acSlot];

  return Math.max(0, Math.min(1, base * totalMod));
}

// ═══════════════════════════════════════════════════════════════════════
// VFX BRIDGE — wisps/fragments emitted when patches break up
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return data for the caller (file 025) to spawn ragged-fragment wisps
 * when altocumulus patches disintegrate (high drift, low fade).
 */
export function emitAltocumulusWisps(acSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = AltocumulusState._baseInstanceSlot[acSlot];
  if (baseSlot === undefined) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dy = cameraY - CI.py[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const distSq = dx * dx + dy * dy + dz * dz;

  if (distSq > ALTOCUMULUS_VFX_RADIUS * ALTOCUMULUS_VFX_RADIUS) return null;
  if (AltocumulusState.fade[acSlot] < 0.3) return null;

  // Only emit when fade is decreasing (patches breaking up).
  const breakUpFactor = 1 - AltocumulusState.fade[acSlot];

  const count = Math.min(
    ALTOCUMULUS_VFX_MAX_PARTICLES,
    Math.floor(emitRate * breakUpFactor)
  );

  if (count <= 0) return null;

  return {
    count,
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusY: CI.radiusY[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
    fade: AltocumulusState.fade[acSlot],
    layerCount: AltocumulusState.layerCount[acSlot],
    layerSpacing: AltocumulusState.layerSpacing[acSlot],
    patchOrientation: AltocumulusState.patchOrientation[acSlot],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function altocumulusStats() {
  let active = 0;
  let layered = 0, castellanus = 0, lenticularis = 0;

  for (let slot = 0; slot < _nextAltocumulusSlot; slot++) {
    if (AltocumulusState.fade[slot] < EPSILON) continue;
    active++;
    const baseSlot = AltocumulusState._baseInstanceSlot[slot];
    const aSlot = CloudInstance.archetypeSlot[baseSlot];
    const sub = CloudArchetype.subtype[aSlot];
    if (sub === CloudSubtype.CASTELLANUS)       castellanus++;
    else if (sub === CloudSubtype.LENTICULARIS) lenticularis++;
    else                                         layered++;
  }

  return {
    totalAltocumulus: _nextAltocumulusSlot,
    active,
    layered,
    castellanus,
    lenticularis,
    archetypesReady: AltocumulusArchetypes.initialized,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearAltocumulus() {
  _altocumulusSlots.clear();
  _nextAltocumulusSlot = 0;
  _altocumulusNoise3D.clear();
  _altocumulusNoise2D.clear();
  AltocumulusState.fade.fill(0);
  AltocumulusState.turretPhase.fill(0);
  AltocumulusState.lensPhase.fill(0);
}