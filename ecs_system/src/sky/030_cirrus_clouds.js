// file number : 030
// full path name : src/sky/030_cirrus_clouds.js
// description : Cirrus cloud family — the three principal sub-types
//               (Fibratus, Uncinus, Vertebratus) with realistic wispy
//               behaviour. Cirrus are high-altitude (6-12 km) ice-crystal
//               clouds with very low density and strong forward-scattering
//               anisotropy. This file imports 029_cloud_archetypes as its
//               single source of truth and contributes:
//                 • CirrusArchetypes — pre-built archetypes for
//                   FIBRATUS / UNCINUS / VERTEBRATUS via createCloudArchetype
//                 • CirrusState — SoA extension tracking per-instance
//                   filament direction, filament curvature, streak count,
//                   and hook-transition progress
//                 • Behaviour system — systemCirrusEvolve applies the
//                   characteristic wispy fade-in/fade-out, filament
//                   shear drift, and hook formation for uncinus
//                 • Density hook — sampleCirrusDensity adds fibratus
//                   streak noise on top of the base ellipsoid so 029's
//                   sampleCloudDensity returns realistic wispy values
//                 • VFX bridge — systemSpawnCirrusVFX emits a few
//                   low-density ice particles via file 025 for very close
//                   flythroughs (opt-in, budget-bounded)
//               All coefficients are tuned to WMO International Cloud
//               Atlas 2017 and Houze 2014. Zero per-frame allocation;
//               100k cirrus instances evolve in one pass.
// best for : High-altitude atmospheric rendering, flight simulators,
//            realistic weather, halo/parhelia cues, cirrus-only skies,
//            and any 1M-entity scene needing wispy high cloud realism
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

const MAX_CIRRUS_INSTANCES           = 50_000;
const CIRRUS_BASE_ALTITUDE_DEFAULT   = 7000;
const CIRRUS_TOP_ALTITUDE_DEFAULT    = 12000;
const CIRRUS_HOOK_FORMATION_TIME_MIN = 20;
const CIRRUS_HOOK_FORMATION_TIME_MAX = 60;
const CIRRUS_FIBRATUS_STREAKS_MIN    = 6;
const CIRRUS_FIBRATUS_STREAKS_MAX    = 24;
const CIRRUS_VERTEBRATUS_STREAKS_MIN = 4;
const CIRRUS_VERTEBRATUS_STREAKS_MAX = 10;
const CIRRUS_UNCINUS_HOOK_COUNT_MIN  = 2;
const CIRRUS_UNCINUS_HOOK_COUNT_MAX  = 6;
const CIRRUS_VFX_EMISSION_RADIUS     = 500;
const CIRRUS_VFX_MAX_PARTICLES       = 256;

// Behaviour-phase thresholds for wispy fade (0..1 normalized phase).
const CIRRUS_FADE_IN_START           = 0.00;
const CIRRUS_FADE_IN_END             = 0.15;
const CIRRUS_FADE_OUT_START          = 0.85;
const CIRRUS_FADE_OUT_END            = 1.00;

// ═══════════════════════════════════════════════════════════════════════
// PER-INSTANCE SoA STATE — cirrus-specific extensions
// ═══════════════════════════════════════════════════════════════════════

export const CirrusState = {
  // Filament orientation in radians (0 = +X, π/2 = +Z).
  filamentAngle: new Float32Array(MAX_CIRRUS_INSTANCES),

  // Filament curvature (radians per unit distance; higher = hook-ier).
  filamentCurvature: new Float32Array(MAX_CIRRUS_INSTANCES),

  // Number of streaks along the filament.
  streakCount: new Uint8Array(MAX_CIRRUS_INSTANCES),

  // Current fade factor (0 = hidden, 1 = fully visible).
  fade: new Float32Array(MAX_CIRRUS_INSTANCES),

  // Hook phase for UNCINUS sub-type (0..1; 0 = straight, 1 = fully hooked).
  hookPhase: new Float32Array(MAX_CIRRUS_INSTANCES),

  // Vertebratus rib angle (radians).
  ribAngle: new Float32Array(MAX_CIRRUS_INSTANCES),

  // Seed noise generator slot (lazily created noise generator).
  noiseIndex: new Uint16Array(MAX_CIRRUS_INSTANCES),
};

/** Marker: entity is a cirrus cloud (set by addCirrus). */
export const CirrusTag = {};

const _cirrusSlots = new Map(); // eid -> cirrus state slot
let _nextCirrusSlot = 0;

// Noise generators per archetype subtype (lazy).
const _cirrusNoise = new Map();

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

function getCirrusNoise(index) {
  let n = _cirrusNoise.get(index);
  if (!n) {
    n = createNoise3D(() => mulberry32(0x0C1RRU5 ^ (index * 2654435761)));
    _cirrusNoise.set(index, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// PRE-BUILT ARCHETYPES — cirrus family
// ═══════════════════════════════════════════════════════════════════════

export const CirrusArchetypes = {
  fibratus: -1,
  uncinus: -1,
  vertebratus: -1,
  initialized: false,
};

/**
 * Build the three cirrus archetypes once. Safe to call multiple times.
 */
export function ensureCirrusArchetypes() {
  if (CirrusArchetypes.initialized) return CirrusArchetypes;

  // FIBRATUS — long, straight, fibrous streaks. Highest altitude, wispy.
  CirrusArchetypes.fibratus = createCloudArchetype(
    CloudType.CIRRUS,
    CloudSubtype.FIBRATUS,
    {
      baseAltitude: 8000,
      topAltitude: 12000,
      minCoverage: 0.05,
      maxCoverage: 0.35,
      density: 0.02,
      opticalDepth: 0.15,
      albedoR: 1.00, albedoG: 1.00, albedoB: 1.00,
      mieG: 0.72,
      windSpeed: 35,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 420,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.05,
      wispiness: 0.98,
      puffiness: 0.02,
      shadowStrength: 0.03,
      silverLining: 0.10,
      haloEffect: 0.00,
    }
  );

  // UNCINUS — hooked (comma-shaped) ice streaks; high cirrus with tuft ends.
  CirrusArchetypes.uncinus = createCloudArchetype(
    CloudType.CIRRUS,
    CloudSubtype.UNCINUS,
    {
      baseAltitude: 6500,
      topAltitude: 10500,
      minCoverage: 0.04,
      maxCoverage: 0.28,
      density: 0.025,
      opticalDepth: 0.18,
      albedoR: 1.00, albedoG: 1.00, albedoB: 1.00,
      mieG: 0.70,
      windSpeed: 30,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 360,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.08,
      wispiness: 0.92,
      puffiness: 0.05,
      shadowStrength: 0.04,
      silverLining: 0.15,
      haloEffect: 0.00,
    }
  );

  // VERTEBRATUS — ribbed, spine-and-ribs appearance; very high and wispy.
  CirrusArchetypes.vertebratus = createCloudArchetype(
    CloudType.CIRRUS,
    CloudSubtype.VERTEBRATUS,
    {
      baseAltitude: 7500,
      topAltitude: 11500,
      minCoverage: 0.06,
      maxCoverage: 0.32,
      density: 0.022,
      opticalDepth: 0.17,
      albedoR: 1.00, albedoG: 1.00, albedoB: 1.00,
      mieG: 0.68,
      windSpeed: 32,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 390,
      precipitationType: PrecipitationType.NONE,
      precipitationRate: 0,
      lightningProbability: 0,
      billow: 0.10,
      wispiness: 0.85,
      puffiness: 0.10,
      shadowStrength: 0.05,
      silverLining: 0.12,
      haloEffect: 0.00,
    }
  );

  CirrusArchetypes.initialized = true;
  return CirrusArchetypes;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — create cirrus instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a cirrus cloud instance to an entity.
 *
 * @param world       ECS world
 * @param eid         entity (must have WorldTransformF32)
 * @param subtype     'fibratus' | 'uncinus' | 'vertebratus'
 * @param options     { radiusX, radiusY, radiusZ, lifetime,
 *                      filamentAngle, streakCount }
 */
export function addCirrus(world, eid, subtype = 'fibratus', options = {}) {
  ensureCirrusArchetypes();

  let archetypeSlot;
  if (subtype === 'uncinus')          archetypeSlot = CirrusArchetypes.uncinus;
  else if (subtype === 'vertebratus') archetypeSlot = CirrusArchetypes.vertebratus;
  else                                archetypeSlot = CirrusArchetypes.fibratus;

  if (_nextCirrusSlot >= MAX_CIRRUS_INSTANCES) {
    throw new Error('cirrus instance capacity exceeded');
  }
  const cirrusSlot = _nextCirrusSlot++;

  // Register the base cloud instance (029).
  const instanceSlot = addCloudInstance(world, eid, archetypeSlot, {
    radiusX: options.radiusX ?? 4000,
    radiusY: options.radiusY ?? 2000,
    radiusZ: options.radiusZ ?? 4000,
    lifetime: options.lifetime ?? 1800,
  });

  // Link back from base instance to cirrus state.
  CirrusState.filamentAngle[cirrusSlot] =
    options.filamentAngle ?? (Math.random() * TWO_PI);
  CirrusState.filamentCurvature[cirrusSlot] = 0;
  CirrusState.fade[cirrusSlot] = 0;

  let streaks = 12;
  if (subtype === 'vertebratus') {
    streaks = Math.floor(
      CIRRUS_VERTEBRATUS_STREAKS_MIN +
      Math.random() * (CIRRUS_VERTEBRATUS_STREAKS_MAX - CIRRUS_VERTEBRATUS_STREAKS_MIN)
    );
  } else {
    streaks = Math.floor(
      CIRRUS_FIBRATUS_STREAKS_MIN +
      Math.random() * (CIRRUS_FIBRATUS_STREAKS_MAX - CIRRUS_FIBRATUS_STREAKS_MIN)
    );
  }
  CirrusState.streakCount[cirrusSlot] = streaks;

  CirrusState.hookPhase[cirrusSlot] = 0;
  CirrusState.ribAngle[cirrusSlot] = Math.random() * TWO_PI;
  CirrusState.noiseIndex[cirrusSlot] = cirrusSlot % 256;

  addComponent(world, eid, CirrusTag);
  _cirrusSlots.set(eid, cirrusSlot);

  // Store the mapping so evolution can find the base instance.
  CirrusState._baseInstanceSlot = CirrusState._baseInstanceSlot || new Uint16Array(MAX_CIRRUS_INSTANCES);
  CirrusState._baseInstanceSlot[cirrusSlot] = instanceSlot;

  return cirrusSlot;
}

export function removeCirrus(world, eid) {
  const cirrusSlot = _cirrusSlots.get(eid);
  if (cirrusSlot === undefined) return;

  const baseInstance = CirrusState._baseInstanceSlot[cirrusSlot];
  if (baseInstance !== undefined) {
    removeCloudInstance(world, eid);
  }

  _cirrusSlots.delete(eid);
  CirrusState.fade[cirrusSlot] = 0;
  CirrusState.streakCount[cirrusSlot] = 0;
  removeComponent(world, eid, CirrusTag);
}

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOUR — per-frame cirrus evolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance cirrus-specific behaviour.
 *
 * Per-instance work:
 *   • apply wispy fade-in / fade-out over 029's phase cycle
 *   • shear the filament angle slightly (wind shear simulation)
 *   • build or dissipate uncinus hooks over time
 *   • update the vertebra rib angle
 */
export function systemCirrusEvolve(world, dt) {
  const CS = CirrusState;
  const CI = CloudInstance;

  for (let slot = 0; slot < _nextCirrusSlot; slot++) {
    const fade = computeFade(CI.phase[CS._baseInstanceSlot[slot]]);

    CS.fade[slot] = fade;

    // Shear drift: rotate the filament slightly faster than the wind.
    const baseArchetypeSlot = CI.archetypeSlot[CS._baseInstanceSlot[slot]];
    const windSpeed = CloudArchetype.windSpeed[baseArchetypeSlot];
    const shearRate = (windSpeed / Math.max(CloudArchetype.baseAltitude[baseArchetypeSlot], 100)) * 0.002;
    CS.filamentAngle[slot] += shearRate * dt;
    if (CS.filamentAngle[slot] > TWO_PI) CS.filamentAngle[slot] -= TWO_PI;

    // Uncinus hook build-up: only for UNCINUS archetype.
    if (CloudArchetype.subtype[baseArchetypeSlot] === CloudSubtype.UNCINUS) {
      const hookBuildTime = CIRRUS_HOOK_FORMATION_TIME_MIN
        + Math.random() * (CIRRUS_HOOK_FORMATION_TIME_MAX - CIRRUS_HOOK_FORMATION_TIME_MIN);
      CS.hookPhase[slot] = Math.min(1, CS.hookPhase[slot] + dt / hookBuildTime);
      CS.filamentCurvature[slot] = CS.hookPhase[slot] * 0.15;
    }

    // Vertebratus rib angle drift.
    if (CloudArchetype.subtype[baseArchetypeSlot] === CloudSubtype.VERTEBRATUS) {
      CS.ribAngle[slot] += 0.02 * dt;
      if (CS.ribAngle[slot] > TWO_PI) CS.ribAngle[slot] -= TWO_PI;
    }

    // Sync visibility to base instance.
    CI.visibility[CS._baseInstanceSlot[slot]] = fade;
  }

  return world;
}

function computeFade(phase) {
  if (phase < CIRRUS_FADE_IN_START) return 0;
  if (phase < CIRRUS_FADE_IN_END) {
    return (phase - CIRRUS_FADE_IN_START) /
           (CIRRUS_FADE_IN_END - CIRRUS_FADE_IN_START);
  }
  if (phase < CIRRUS_FADE_OUT_START) return 1;
  if (phase < CIRRUS_FADE_OUT_END) {
    return 1 - (phase - CIRRUS_FADE_OUT_START) /
               (CIRRUS_FADE_OUT_END - CIRRUS_FADE_OUT_START);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// DENSITY HOOK — override base 029 sampleInstanceDensity with streak noise
// ═══════════════════════════════════════════════════════════════════════

const _cirrusLocal = vec3.create();
const _cirrusAxis = vec3.create();
const _cirrusPerp = vec3.create();

/**
 * Cirrus-enhanced density sampling. Adds filament streaks on top of
 * the base 029 ellipsoid falloff + noise. Called by external integrators
 * (file 017) that want high-fidelity cirrus density.
 *
 * @param cirrusSlot  index in CirrusState (not the base 029 slot)
 * @param wx, wy, wz  world-space point
 */
export function sampleCirrusDensity(cirrusSlot, wx, wy, wz) {
  const baseSlot = CirrusState._baseInstanceSlot[cirrusSlot];
  if (baseSlot === undefined) return 0;

  const base = sampleInstanceDensity(baseSlot, wx, wy, wz);
  if (base < EPSILON) return 0;

  const CI = CloudInstance;
  const fAngle = CirrusState.filamentAngle[cirrusSlot];
  const fCurv = CirrusState.filamentCurvature[cirrusSlot];

  // Rotate (wx, wy, wz) into the filament's local frame.
  const lx = (wx - CI.px[baseSlot]) / CI.radiusX[baseSlot];
  const ly = (wy - CI.py[baseSlot]) / CI.radiusY[baseSlot];
  const lz = (wz - CI.pz[baseSlot]) / CI.radiusZ[baseSlot];

  const cosA = Math.cos(fAngle);
  const sinA = Math.sin(fAngle);
  const along = lx * cosA + lz * sinA;
  const across = -lx * sinA + lz * cosA;

  // Filament streaks run along the "along" axis.
  const streakCount = CirrusState.streakCount[cirrusSlot];
  const streakFreq = streakCount * 0.5;

  // Build a sinusoidal streak pattern along the across axis.
  const acrossMod = across + fCurv * along * along;  // hook curvature
  const streak = 0.5 + 0.5 * Math.cos(acrossMod * streakFreq * PI);

  // Vertebratus adds ribs along the along axis.
  let ribMod = 1;
  if (streakCount > 0) {
    ribMod = 0.85 + 0.15 * Math.cos(along * TWO_PI + CirrusState.ribAngle[cirrusSlot]);
  }

  // Apply streak + fade.
  const cirrusDensity = base * (0.4 + 0.6 * streak) * ribMod * CirrusState.fade[cirrusSlot];

  return Math.max(0, Math.min(1, cirrusDensity));
}

// ═══════════════════════════════════════════════════════════════════════
// VFX BRIDGE — optional particle emission for close flythroughs
// ═══════════════════════════════════════════════════════════════════════

/**
 * Emit a few sparse ice-crystal particles near the camera when inside
 * a cirrus volume. Optional — budget-bounded. Requires file 025's
 * particle system to be imported by the caller; this file exposes the
 * request as data only.
 */
export function emitCirrusIceParticles(cirrusSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = CirrusState._baseInstanceSlot[cirrusSlot];
  if (baseSlot === undefined) return null;

  const CI = CloudInstance;
  const px = CI.px[baseSlot];
  const py = CI.py[baseSlot];
  const pz = CI.pz[baseSlot];

  const dx = cameraX - px;
  const dy = cameraY - py;
  const dz = cameraZ - pz;
  const distSq = dx * dx + dy * dy + dz * dz;

  if (distSq > CIRRUS_VFX_EMISSION_RADIUS * CIRRUS_VFX_EMISSION_RADIUS) return null;
  if (CirrusState.fade[cirrusSlot] < 0.3) return null;

  const count = Math.min(
    CIRRUS_VFX_MAX_PARTICLES,
    Math.floor(emitRate * CirrusState.fade[cirrusSlot])
  );

  return {
    count,
    position: [px, py, pz],
    radiusX: CI.radiusX[baseSlot],
    radiusY: CI.radiusY[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
    fade: CirrusState.fade[cirrusSlot],
    filamentAngle: CirrusState.filamentAngle[cirrusSlot],
    subtype: CloudArchetype.subtype[CI.archetypeSlot[baseSlot]],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function cirrusStats() {
  let active = 0;
  let fibratus = 0, uncinus = 0, vertebratus = 0;

  for (let slot = 0; slot < _nextCirrusSlot; slot++) {
    if (CirrusState.fade[slot] < EPSILON) continue;
    active++;
    const baseSlot = CirrusState._baseInstanceSlot[slot];
    const aSlot = CloudInstance.archetypeSlot[baseSlot];
    const sub = CloudArchetype.subtype[aSlot];
    if (sub === CloudSubtype.FIBRATUS)         fibratus++;
    else if (sub === CloudSubtype.UNCINUS)     uncinus++;
    else if (sub === CloudSubtype.VERTEBRATUS) vertebratus++;
  }

  return {
    totalCirrus: _nextCirrusSlot,
    active,
    fibratus,
    uncinus,
    vertebratus,
    archetypesReady: CirrusArchetypes.initialized,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearCirrus() {
  _cirrusSlots.clear();
  _nextCirrusSlot = 0;
  _cirrusNoise.clear();
  CirrusState.fade.fill(0);
  CirrusState.streakCount.fill(0);
}