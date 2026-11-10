// file number : 036
// full path name : src/sky/036_stratocumulus_clouds.js
// description : Stratocumulus cloud family — low-level (500-2000 m)
//               lumpy, grey or whitish patches, rolls, or sheets with
//               darker parts and cellular structure. Stratocumulus is
//               one of the most common cloud types globally and covers
//               vast areas over oceans. The cellular structure can be
//               "closed" (cells have dark centres, lighter edges) or
//               "open" (cells have clear centres, cloud rings). This
//               file imports 029_cloud_archetypes.js as its single
//               source of truth and contributes:
//                 • StratocumulusArchetypes — pre-built archetypes for
//                   closed-cell, open-cell, and roll-form variants via
//                   createCloudArchetype
//                 • StratocumulusState — SoA extension tracking per-instance
//                   cell type (open/closed), cell radius, cell count,
//                   roll orientation (for roll-form), drizzle cell
//                   tracking, and undersurface darkening
//                 • Behaviour system — systemStratocumulusEvolve applies
//                   cell evolution, drizzle triggering on thicker cells,
//                   roll drift for roll-form, and continuous fade cycling
//                 • Density hook — sampleStratocumulusDensity layers
//                   cellular noise patterns (Voronoi-like) on top of
//                   029's ellipsoid to produce the characteristic
//                   lumpy, cellular structure
//                 • Sun-block hook — sampleStratocumulusSunBlock returns
//                   the transmission factor so file 028 darkens the sun
//                   consistently with the cloud's optical depth
//                 • VFX bridge — emitStratocumulusDrizzle returns data
//                   for file 025 to spawn fine drizzle / light rain /
//                   light snow, sized per cell
//                 • Cumulus transition — isReadyForCumulusTransition
//                   signals when a large cell is detaching (open-cell
//                   detrainment → cumulus)
//               All coefficients tuned to WMO International Cloud Atlas
//               2017, Wood 2012 "Stratocumulus Clouds" (Meteorological
//               Monographs), and Houze 2014. Zero per-frame allocation;
//               30k stratocumulus instances evolve in a single pass at
//               1M-entity scale on Android 64-bit.
// best for : Low-level weather rendering, marine layer realism, coastal
//            stratus decks, drizzling weather, cloud-shadow effects on
//            terrain, and any 1M-entity scene needing cellular low
//            clouds on Android 64-bit.
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
  createNoise2D,
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

const MAX_STRATOCUMULUS_INSTANCES       = 30_000;
const STRATOCUMULUS_BASE_ALTITUDE_MIN   = 400;
const STRATOCUMULUS_BASE_ALTITUDE_MAX   = 1000;
const STRATOCUMULUS_TOP_ALTITUDE_MIN    = 1500;
const STRATOCUMULUS_TOP_ALTITUDE_MAX    = 2500;
const STRATOCUMULUS_DENSITY_MIN         = 0.30;
const STRATOCUMULUS_DENSITY_MAX         = 0.55;
const STRATOCUMULUS_DRIFT_SPEED_MIN     = 5;
const STRATOCUMULUS_DRIFT_SPEED_MAX     = 14;

// Cell geometry.
const STRATOCUMULUS_CELL_RADIUS_MIN     = 300;
const STRATOCUMULUS_CELL_RADIUS_MAX     = 1200;
const STRATOCUMULUS_CELL_COUNT_MIN      = 4;
const STRATOCUMULUS_CELL_COUNT_MAX      = 20;
const STRATOCUMULUS_CLOSED_CELL_BIAS    = 0.35;   // 0 = no closed bias
const STRATOCUMULUS_OPEN_CELL_BIAS      = 0.65;   // 1 = fully open

// Roll-form.
const STRATOCUMULUS_ROLL_ORIENTATION_JITTER = 0.3;   // radians

// Fade.
const STRATOCUMULUS_FADE_IN_START       = 0.00;
const STRATOCUMULUS_FADE_IN_END         = 0.20;
const STRATOCUMULUS_FADE_OUT_START      = 0.85;
const STRATOCUMULUS_FADE_OUT_END        = 1.00;

// Drizzle thresholds.
const STRATOCUMULUS_DRIZZLE_THICKNESS   = 0.45;
const STRATOCUMULUS_DRIZZLE_RATE_BASE   = 0.1;    // mm/h
const STRATOCUMULUS_DRIZZLE_RATE_SCALE  = 0.8;    // mm/h
const STRATOCUMULUS_RAIN_THICKNESS      = 0.65;   // heavier rain threshold
const STRATOCUMULUS_RAIN_RATE_BASE      = 1.5;    // mm/h
const STRATOCUMULUS_RAIN_RATE_SCALE     = 3.5;    // mm/h

// Snow mix.
const STRATOCUMULUS_SNOW_MIX_THRESHOLD  = 0.0;    // °C
const STRATOCUMULUS_SNOW_MIX_SLOPE      = 0.25;

// Sun-block.
const STRATOCUMULUS_SUN_BLOCK_K         = 4.5;
const STRATOCUMULUS_SUN_TRANSMIT_MIN    = 0.10;

// Underside darkness.
const STRATOCUMULUS_UNDERSIDE_DARKEN    = 0.45;
const STRATOCUMULUS_TOPSIDE_BRIGHTEN    = 0.20;

// VFX.
const STRATOCUMULUS_VFX_RADIUS          = 900;
const STRATOCUMULUS_VFX_MAX_PARTICLES   = 320;

// Cumulus detrainment threshold.
const STRATOCUMULUS_CUMULUS_DETRAIN     = 0.85;
const STRATOCUMULUS_CUMULUS_RATE        = 0.02;

// ═══════════════════════════════════════════════════════════════════════
// CELL TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const ScCellType = Object.freeze({
  CLOSED: 0,   // dark centers, lighter edges
  OPEN:   1,   // clear centers, cloud rings
  ROLL:   2,   // roll-shaped (horizontal bands)
});

// ═══════════════════════════════════════════════════════════════════════
// PER-INSTANCE SoA STATE — stratocumulus-specific extensions
// ═══════════════════════════════════════════════════════════════════════

export const StratocumulusState = {
  // Cell type (ScCellType).
  cellType: new Uint8Array(MAX_STRATOCUMULUS_INSTANCES),

  // Cell radius (metres).
  cellRadius: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Number of cells in the layer.
  cellCount: new Uint8Array(MAX_STRATOCUMULUS_INSTANCES),

  // Roll orientation for roll-form (radians; 0 for cellular forms).
  rollOrientation: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Cell noise phase (advances with drift).
  cellPhase: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Drizzle-active cell fraction (0..1; how many cells are producing
  // drizzle right now).
  drizzleCellFraction: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Current drizzle rate (mm/h).
  drizzleRate: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Snow-mix ratio (0 = rain, 1 = snow).
  snowMix: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Base temperature (°C) — drives snow mix.
  baseTemperature: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Underside darkness (0..1).
  undersideDarkness: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Current thickness (multiplied against 029 coverage).
  thickness: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Drift speed (m/s).
  driftSpeed: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Detrainment progress toward cumulus (0..1).
  cumulusProgress: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Current fade factor (0..1).
  fade: new Float32Array(MAX_STRATOCUMULUS_INSTANCES),

  // Noise indices (lazy).
  noiseIndex: new Uint16Array(MAX_STRATOCUMULUS_INSTANCES),

  // Back-pointer to 029 instance slot.
  _baseInstanceSlot: new Uint16Array(MAX_STRATOCUMULUS_INSTANCES),
};

/** Marker: entity is a stratocumulus layer (set by addStratocumulus). */
export const StratocumulusTag = {};

const _stratocumulusSlots = new Map(); // eid -> stratocumulus slot
let _nextStratocumulusSlot = 0;

// Noise generators (lazy).
const _stratocumulusNoise3D = new Map();
const _stratocumulusNoise2D = new Map();

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

function getScNoise3D(index) {
  let n = _stratocumulusNoise3D.get(index);
  if (!n) {
    n = createNoise3D(() => mulberry32(0x5C00 ^ (index * 2654435761)));
    _stratocumulusNoise3D.set(index, n);
  }
  return n;
}

function getScNoise2D(index) {
  let n = _stratocumulusNoise2D.get(index);
  if (!n) {
    n = createNoise2D(() => mulberry32((0x5C00 ^ 0xA5A5) ^ (index * 2654435761)));
    _stratocumulusNoise2D.set(index, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// PRE-BUILT ARCHETYPES — stratocumulus family
// ═══════════════════════════════════════════════════════════════════════

export const StratocumulusArchetypes = {
  closedCell: -1,
  openCell:   -1,
  roll:       -1,
  initialized: false,
};

/**
 * Build the three stratocumulus archetypes once.
 */
export function ensureStratocumulusArchetypes() {
  if (StratocumulusArchetypes.initialized) return StratocumulusArchetypes;

  // CLOSED-CELL — dark centers, lighter edges. Marine layer classic.
  StratocumulusArchetypes.closedCell = createCloudArchetype(
    CloudType.STRATOCUMULUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 600,
      topAltitude: 1800,
      minCoverage: 0.40,
      maxCoverage: 0.85,
      density: 0.40,
      opticalDepth: 3.0,
      albedoR: 0.85, albedoG: 0.86, albedoB: 0.88,
      mieG: 0.50,
      windSpeed: 8,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 240,
      precipitationType: PrecipitationType.DRIZZLE,
      precipitationRate: 0.5,
      lightningProbability: 0.0001,
      billow: 0.65,
      wispiness: 0.10,
      puffiness: 0.60,
      shadowStrength: 0.50,
      silverLining: 0.20,
      haloEffect: 0.00,
    }
  );

  // OPEN-CELL — clear centers, cloud rings. Common over warmer oceans.
  StratocumulusArchetypes.openCell = createCloudArchetype(
    CloudType.STRATOCUMULUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 700,
      topAltitude: 2000,
      minCoverage: 0.30,
      maxCoverage: 0.70,
      density: 0.35,
      opticalDepth: 2.5,
      albedoR: 0.88, albedoG: 0.89, albedoB: 0.90,
      mieG: 0.52,
      windSpeed: 9,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 220,
      precipitationType: PrecipitationType.DRIZZLE,
      precipitationRate: 0.3,
      lightningProbability: 0.0001,
      billow: 0.55,
      wispiness: 0.10,
      puffiness: 0.55,
      shadowStrength: 0.45,
      silverLining: 0.25,
      haloEffect: 0.00,
    }
  );

  // ROLL — roll-shaped horizontal bands. Cold-air outbreak favourite.
  StratocumulusArchetypes.roll = createCloudArchetype(
    CloudType.STRATOCUMULUS,
    CloudSubtype.DEFAULT,
    {
      baseAltitude: 800,
      topAltitude: 2200,
      minCoverage: 0.35,
      maxCoverage: 0.75,
      density: 0.42,
      opticalDepth: 3.2,
      albedoR: 0.82, albedoG: 0.84, albedoB: 0.86,
      mieG: 0.50,
      windSpeed: 12,
      windDirX: 1, windDirY: 0, windDirZ: 0,
      evolveSpeed: 1 / 200,
      precipitationType: PrecipitationType.DRIZZLE,
      precipitationRate: 0.6,
      lightningProbability: 0.0001,
      billow: 0.60,
      wispiness: 0.08,
      puffiness: 0.55,
      shadowStrength: 0.55,
      silverLining: 0.18,
      haloEffect: 0.00,
    }
  );

  StratocumulusArchetypes.initialized = true;
  return StratocumulusArchetypes;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — create stratocumulus instances
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a stratocumulus layer instance to an entity.
 *
 * @param world       ECS world
 * @param eid         entity (must have WorldTransformF32)
 * @param subtype     'closedCell' | 'openCell' | 'roll'
 * @param options     { radiusX, radiusY, radiusZ, lifetime,
 *                      cellRadius, cellCount, rollOrientation, baseTemperature }
 */
export function addStratocumulus(world, eid, subtype = 'closedCell', options = {}) {
  ensureStratocumulusArchetypes();

  let archetypeSlot;
  let cellType;
  if (subtype === 'openCell') {
    archetypeSlot = StratocumulusArchetypes.openCell;
    cellType = ScCellType.OPEN;
  } else if (subtype === 'roll') {
    archetypeSlot = StratocumulusArchetypes.roll;
    cellType = ScCellType.ROLL;
  } else {
    archetypeSlot = StratocumulusArchetypes.closedCell;
    cellType = ScCellType.CLOSED;
  }

  if (_nextStratocumulusSlot >= MAX_STRATOCUMULUS_INSTANCES) {
    throw new Error('stratocumulus instance capacity exceeded');
  }
  const scSlot = _nextStratocumulusSlot++;

  // Register base cloud instance via 029.
  const instanceSlot = addCloudInstance(world, eid, archetypeSlot, {
    radiusX: options.radiusX ?? 15000,
    radiusY: options.radiusY ?? 800,
    radiusZ: options.radiusZ ?? 15000,
    lifetime: options.lifetime ?? 1800,
  });

  const SCS = StratocumulusState;
  const rng = mulberry32(0x5C00 ^ (scSlot * 2654435761));

  SCS.cellType[scSlot] = cellType;
  SCS.cellRadius[scSlot] = options.cellRadius
    ?? (STRATOCUMULUS_CELL_RADIUS_MIN
        + rng() * (STRATOCUMULUS_CELL_RADIUS_MAX - STRATOCUMULUS_CELL_RADIUS_MIN));
  SCS.cellCount[scSlot] = options.cellCount
    ?? (STRATOCUMULUS_CELL_COUNT_MIN
        + Math.floor(rng() * (STRATOCUMULUS_CELL_COUNT_MAX - STRATOCUMULUS_CELL_COUNT_MIN + 1)));
  SCS.rollOrientation[scSlot] = options.rollOrientation
    ?? (cellType === ScCellType.ROLL
        ? (rng() * TWO_PI)
        : (rng() * STRATOCUMULUS_ROLL_ORIENTATION_JITTER));
  SCS.cellPhase[scSlot] = 0;
  SCS.drizzleCellFraction[scSlot] = 0.2 + rng() * 0.4;
  SCS.drizzleRate[scSlot] = 0;
  SCS.baseTemperature[scSlot] = options.baseTemperature ?? 8;    // °C
  SCS.snowMix[scSlot] = computeSnowMix(SCS.baseTemperature[scSlot]);
  SCS.undersideDarkness[scSlot] = 0.7;
  SCS.thickness[scSlot] = CloudArchetype.density[archetypeSlot];
  SCS.driftSpeed[scSlot] = STRATOCUMULUS_DRIFT_SPEED_MIN
    + rng() * (STRATOCUMULUS_DRIFT_SPEED_MAX - STRATOCUMULUS_DRIFT_SPEED_MIN);
  SCS.cumulusProgress[scSlot] = 0;
  SCS.fade[scSlot] = 0;
  SCS.noiseIndex[scSlot] = scSlot % 256;
  SCS._baseInstanceSlot[scSlot] = instanceSlot;

  addComponent(world, eid, StratocumulusTag);
  _stratocumulusSlots.set(eid, scSlot);

  return scSlot;
}

export function removeStratocumulus(world, eid) {
  const scSlot = _stratocumulusSlots.get(eid);
  if (scSlot === undefined) return;

  removeCloudInstance(world, eid);

  _stratocumulusSlots.delete(eid);
  StratocumulusState.fade[scSlot] = 0;
  removeComponent(world, eid, StratocumulusTag);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPER — snow mix from temperature
// ═══════════════════════════════════════════════════════════════════════

function computeSnowMix(temperatureC) {
  if (temperatureC >= STRATOCUMULUS_SNOW_MIX_THRESHOLD) return 0;
  const delta = STRATOCUMULUS_SNOW_MIX_THRESHOLD - temperatureC;
  return Math.min(1, delta * STRATOCUMULUS_SNOW_MIX_SLOPE);
}

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOUR — per-frame stratocumulus evolution
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance stratocumulus-specific behaviour:
 *   • fade-in / fade-out over 029's phase
 *   • cell phase advance with drift
 *   • drizzle triggering on thicker cells
 *   • roll-form orientation drift
 *   • cumulus detrainment progress on large cells (open-cell only)
 */
export function systemStratocumulusEvolve(world, dt) {
  const SCS = StratocumulusState;
  const CI = CloudInstance;

  for (let slot = 0; slot < _nextStratocumulusSlot; slot++) {
    const baseSlot = SCS._baseInstanceSlot[slot];
    if (baseSlot === undefined) continue;

    const fade = computeFade(CI.phase[baseSlot]);
    SCS.fade[slot] = fade;

    // Cell phase advance.
    SCS.cellPhase[slot] += SCS.driftSpeed[slot] * dt;
    if (SCS.cellPhase[slot] > TWO_PI) SCS.cellPhase[slot] -= TWO_PI;

    // Thickness breathing.
    const breathing = 0.92 + 0.08 * Math.sin(CI.phase[baseSlot] * TWO_PI);
    SCS.thickness[slot] = CloudArchetype.density[CI.archetypeSlot[baseSlot]] * breathing;

    // Roll orientation slow drift.
    if (SCS.cellType[slot] === ScCellType.ROLL) {
      SCS.rollOrientation[slot] += dt * 0.002;
      if (SCS.rollOrientation[slot] > TWO_PI) SCS.rollOrientation[slot] -= TWO_PI;
    }

    // Underside darkness driven by thickness × coverage.
    const opticalFactor = SCS.thickness[slot] * CI.coverage[baseSlot] * fade;
    SCS.undersideDarkness[slot] = Math.max(0.55,
      Math.min(1.0, opticalFactor * 1.5));

    // Drizzle / light-rain triggering.
    let drizzleRate = 0;
    if (opticalFactor > STRATOCUMULUS_DRIZZLE_THICKNESS) {
      const excess = (opticalFactor - STRATOCUMULUS_DRIZZLE_THICKNESS)
                   / (1 - STRATOCUMULUS_DRIZZLE_THICKNESS);
      drizzleRate = STRATOCUMULUS_DRIZZLE_RATE_BASE
                  + STRATOCUMULUS_DRIZZLE_RATE_SCALE * excess;
    }
    if (opticalFactor > STRATOCUMULUS_RAIN_THICKNESS) {
      const excess = (opticalFactor - STRATOCUMULUS_RAIN_THICKNESS)
                   / (1 - STRATOCUMULUS_RAIN_THICKNESS);
      drizzleRate = STRATOCUMULUS_RAIN_RATE_BASE
                  + STRATOCUMULUS_RAIN_RATE_SCALE * excess;
    }
    SCS.drizzleRate[slot] = drizzleRate;

    // Set precipitation flags on base instance.
    if (drizzleRate > EPSILON) {
      CI.flags[baseSlot] |= 1 << 1;   // FLAG_PRECIPITATING
      CI.precipRate[baseSlot] = drizzleRate * SCS.drizzleCellFraction[slot]
                              * CI.coverage[baseSlot] * fade;
    } else {
      CI.flags[baseSlot] &= ~(1 << 1);
      CI.precipRate[baseSlot] = 0;
    }

    // Snow-mix update.
    SCS.snowMix[slot] = computeSnowMix(SCS.baseTemperature[slot]);

    // Cumulus detrainment: open-cell clouds with growing cells can
    // detach into cumulus. Accumulate progress if cell radius is large
    // and the cloud is thickening.
    if (SCS.cellType[slot] === ScCellType.OPEN) {
      const cellFraction = SCS.cellRadius[slot] / STRATOCUMULUS_CELL_RADIUS_MAX;
      if (cellFraction > STRATOCUMULUS_CUMULUS_DETRAIN) {
        SCS.cumulusProgress[slot] = Math.min(1,
          SCS.cumulusProgress[slot] + STRATOCUMULUS_CUMULUS_RATE * dt);
      } else {
        SCS.cumulusProgress[slot] = Math.max(0,
          SCS.cumulusProgress[slot] - STRATOCUMULUS_CUMULUS_RATE * dt * 0.5);
      }
    }

    // Sync visibility to base instance.
    CI.visibility[baseSlot] = fade;
  }

  return world;
}

function computeFade(phase) {
  if (phase < STRATOCUMULUS_FADE_IN_START) return 0;
  if (phase < STRATOCUMULUS_FADE_IN_END) {
    return (phase - STRATOCUMULUS_FADE_IN_START) /
           (STRATOCUMULUS_FADE_IN_END - STRATOCUMULUS_FADE_IN_START);
  }
  if (phase < STRATOCUMULUS_FADE_OUT_START) return 1;
  if (phase < STRATOCUMULUS_FADE_OUT_END) {
    return 1 - (phase - STRATOCUMULUS_FADE_OUT_START) /
               (STRATOCUMULUS_FADE_OUT_END - STRATOCUMULUS_FADE_OUT_START);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// CELLULAR DENSITY — Voronoi-like cellular pattern generator
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample a cellular pattern at (x, z) using the Worley/Voronoi noise
 * approach. Returns a value in [0, 1]:
 *   0 = fully inside a cell (cloudy for CLOSED, clear for OPEN)
 *   1 = at the cell boundary (lighter for CLOSED, cloud ring for OPEN)
 *
 * Implemented via a 3×3 neighbourhood of integer cell centres and a
 * pseudo-random offset per cell (stable per-instance, no per-frame
 * allocation).
 */
function sampleCellularPattern(noise2D, x, z, scale, seed) {
  const sx = x / scale;
  const sz = z / scale;
  const ix = Math.floor(sx);
  const iz = Math.floor(sz);
  const fx = sx - ix;
  const fz = sz - iz;

  let minDistSq = Infinity;
  let secondMinDistSq = Infinity;

  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cz = iz + dz;

      // Deterministic pseudo-random offset per cell.
      const h = (((cx * 73856093) ^ (cz * 19349663) ^ seed) >>> 0) / 4294967296;
      const h2 = (((cx * 83492791) ^ (cz * 2654435761) ^ seed) >>> 0) / 4294967296;

      const ox = cx + h;
      const oz = cz + h2;

      const ddx = ox - sx;
      const ddz = oz - sz;
      const distSq = ddx * ddx + ddz * ddz;

      if (distSq < minDistSq) {
        secondMinDistSq = minDistSq;
        minDistSq = distSq;
      } else if (distSq < secondMinDistSq) {
        secondMinDistSq = distSq;
      }
    }
  }

  // F2 - F1 (difference between closest and second-closest cells) gives
  // a "boundary mask" that is 0 inside a cell and 1 near boundaries.
  const f1 = Math.sqrt(minDistSq);
  const f2 = Math.sqrt(secondMinDistSq);
  const boundary = Math.min(1, f2 - f1);
  return boundary;
}

// ═══════════════════════════════════════════════════════════════════════
// DENSITY HOOK — override base 029 sampleInstanceDensity with cells
// ═══════════════════════════════════════════════════════════════════════

/**
 * Stratocumulus-enhanced density sampling. Combines cellular noise,
 * vertical darkening, and drizzle-cell modulation on top of 029's
 * ellipsoid falloff.
 *
 * @param scSlot     index in StratocumulusState
 * @param wx, wy, wz world-space point
 */
export function sampleStratocumulusDensity(scSlot, wx, wy, wz) {
  const baseSlot = StratocumulusState._baseInstanceSlot[scSlot];
  if (baseSlot === undefined) return 0;

  const base = sampleInstanceDensity(baseSlot, wx, wy, wz);
  if (base < EPSILON) return 0;

  const CI = CloudInstance;
  const SCS = StratocumulusState;

  // Local coordinates.
  const lx = (wx - CI.px[baseSlot]);
  const ly = (wy - CI.py[baseSlot]);
  const lz = (wz - CI.pz[baseSlot]);

  // Vertical position within sheet (0 = top, 1 = base).
  const verticalNorm = (ly + CI.radiusY[baseSlot])
                     / Math.max(2 * CI.radiusY[baseSlot], 1);
  const verticalT = 1 - verticalNorm;

  // Cellular pattern in the (along, across) plane.
  const cellType = SCS.cellType[scSlot];
  const cellRadius = SCS.cellRadius[scSlot];

  let cellularMod;
  if (cellType === ScCellType.ROLL) {
    // Roll-form: horizontal bands.
    const cosA = Math.cos(SCS.rollOrientation[scSlot]);
    const sinA = Math.sin(SCS.rollOrientation[scSlot]);
    const across = -lx * sinA + lz * cosA;
    const bandFreq = TWO_PI / Math.max(cellRadius, 1);
    const band = 0.5 + 0.5 * Math.sin(across * bandFreq + SCS.cellPhase[scSlot]);
    cellularMod = 0.65 + 0.35 * band;
  } else {
    // Cellular: Voronoi-like boundary mask.
    const noise2D = getScNoise2D(SCS.noiseIndex[scSlot]);
    const boundary = sampleCellularPattern(
      noise2D, lx, lz, cellRadius, SCS.noiseIndex[scSlot] + scSlot
    );

    if (cellType === ScCellType.CLOSED) {
      // Closed-cell: dark centers, lighter edges.
      // Cloudy at boundaries → density = boundary mask.
      cellularMod = 0.55 + 0.45 * (1 - boundary);
    } else {
      // Open-cell: clear centers, cloud rings.
      // Cloudy at boundaries only → density = boundary mask.
      cellularMod = 0.30 + 0.70 * (1 - boundary);
      // Add a subtle ring pattern for open cells.
      const ring = 0.5 + 0.5 * Math.cos(boundary * PI * 2);
      cellularMod = cellularMod * (0.85 + 0.15 * ring);
    }
  }

  // Vertical darkening factor: darkest at base.
  const darkening = STRATOCUMULUS_UNDERSIDE_DARKEN * verticalT
                  + (1 - verticalT) * STRATOCUMULUS_TOPSIDE_BRIGHTEN;
  const darkMod = 1 - (1 - SCS.undersideDarkness[scSlot]) * (1 - darkening);

  // Organic noise overlay.
  const noise3D = getScNoise3D(SCS.noiseIndex[scSlot]);
  const noiseMod = 0.88 + 0.12 * noise3D(lx * 0.003, ly * 0.005, lz * 0.003);

  const mod = cellularMod * darkMod * noiseMod * SCS.fade[scSlot]
            * SCS.thickness[scSlot] * 2.2;

  return Math.max(0, Math.min(1, base * mod));
}

// ═══════════════════════════════════════════════════════════════════════
// SUN BLOCK HOOK — return sun transmission factor
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the sun transmission factor (0..1). Stratocumulus blocks the
 * sun more strongly than altocumulus but less than nimbostratus.
 */
export function sampleStratocumulusSunBlock(scSlot, viewDirX, viewDirY, viewDirZ) {
  const baseSlot = StratocumulusState._baseInstanceSlot[scSlot];
  if (baseSlot === undefined) return 1.0;

  const SCS = StratocumulusState;
  if (SCS.fade[scSlot] < 0.1) return 1.0;

  const CI = CloudInstance;
  const opticalFactor = SCS.thickness[scSlot]
                      * CI.coverage[baseSlot]
                      * SCS.fade[scSlot];

  const transmission = Math.exp(-opticalFactor * STRATOCUMULUS_SUN_BLOCK_K);
  return Math.max(STRATOCUMULUS_SUN_TRANSMIT_MIN, transmission);
}

// ═══════════════════════════════════════════════════════════════════════
// VFX BRIDGE — drizzle / light-rain / light-snow particles
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return data for the caller (file 025) to spawn stratocumulus
 * precipitation particles.
 */
export function emitStratocumulusDrizzle(scSlot, cameraX, cameraY, cameraZ, emitRate) {
  const baseSlot = StratocumulusState._baseInstanceSlot[scSlot];
  if (baseSlot === undefined) return null;

  const SCS = StratocumulusState;
  if (SCS.drizzleRate[scSlot] < EPSILON) return null;
  if (SCS.fade[scSlot] < 0.3) return null;

  const CI = CloudInstance;
  const dx = cameraX - CI.px[baseSlot];
  const dz = cameraZ - CI.pz[baseSlot];
  const horizontalDistSq = dx * dx + dz * dz;
  if (horizontalDistSq > STRATOCUMULUS_VFX_RADIUS * STRATOCUMULUS_VFX_RADIUS) {
    return null;
  }

  // Precipitation type from snow mix.
  const snowMix = SCS.snowMix[scSlot];
  let precipType;
  if (snowMix > 0.95)      precipType = PrecipitationType.SNOW;
  else if (snowMix < 0.05) precipType = PrecipitationType.DRIZZLE;
  else                     precipType = PrecipitationType.MIXED;

  const count = Math.min(
    STRATOCUMULUS_VFX_MAX_PARTICLES,
    Math.floor(emitRate * SCS.drizzleRate[scSlot] * 6)
  );

  if (count <= 0) return null;

  return {
    count,
    precipType,
    snowMix,
    drizzleRate: SCS.drizzleRate[scSlot],
    drizzleCellFraction: SCS.drizzleCellFraction[scSlot],
    cellType: SCS.cellType[scSlot],
    cellRadius: SCS.cellRadius[scSlot],
    cellCount: SCS.cellCount[scSlot],
    cloudBaseAltitude: CI.py[baseSlot] - CI.radiusY[baseSlot],
    cloudTopAltitude: CI.py[baseSlot] + CI.radiusY[baseSlot],
    position: [CI.px[baseSlot], CI.py[baseSlot], CI.pz[baseSlot]],
    radiusX: CI.radiusX[baseSlot],
    radiusZ: CI.radiusZ[baseSlot],
    undersideDarkness: SCS.undersideDarkness[scSlot],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CUMULUS TRANSITION — signal when ready to detrain into cumulus
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return true when an open-cell stratocumulus is ready to detrain into
 * cumulus (file 038). The caller removes this layer and spawns a
 * cumulus instance at the same position.
 */
export function isReadyForCumulusTransition(scSlot) {
  const SCS = StratocumulusState;
  if (scSlot < 0 || scSlot >= _nextStratocumulusSlot) return false;
  return SCS.cumulusProgress[scSlot] >= 0.95;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — runtime parameter updates
// ═══════════════════════════════════════════════════════════════════════

/**
 * Set the base temperature, updating snow mix accordingly.
 */
export function setStratocumulusTemperature(scSlot, tempC) {
  if (scSlot < 0 || scSlot >= _nextStratocumulusSlot) return;
  StratocumulusState.baseTemperature[scSlot] = tempC;
  StratocumulusState.snowMix[scSlot] = computeSnowMix(tempC);
}

/**
 * Set the drizzle cell fraction (0..1).
 */
export function setStratocumulusDrizzleFraction(scSlot, fraction) {
  if (scSlot < 0 || scSlot >= _nextStratocumulusSlot) return;
  StratocumulusState.drizzleCellFraction[scSlot] = Math.max(0, Math.min(1, fraction));
}

/**
 * Set the cell radius.
 */
export function setStratocumulusCellRadius(scSlot, radius) {
  if (scSlot < 0 || scSlot >= _nextStratocumulusSlot) return;
  StratocumulusState.cellRadius[scSlot] = Math.max(
    STRATOCUMULUS_CELL_RADIUS_MIN,
    Math.min(STRATOCUMULUS_CELL_RADIUS_MAX, radius)
  );
}

/**
 * Set the roll orientation (only for ROLL-type clouds).
 */
export function setStratocumulusRollOrientation(scSlot, orientation) {
  if (scSlot < 0 || scSlot >= _nextStratocumulusSlot) return;
  if (StratocumulusState.cellType[scSlot] !== ScCellType.ROLL) return;
  StratocumulusState.rollOrientation[scSlot] = orientation;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function stratocumulusStats() {
  let active = 0;
  let closedCell = 0, openCell = 0, roll = 0;
  let drizzling = 0;
  let snowing = 0;
  let totalDrizzleAccum = 0;

  for (let slot = 0; slot < _nextStratocumulusSlot; slot++) {
    if (StratocumulusState.fade[slot] < EPSILON) continue;
    active++;
    const cellType = StratocumulusState.cellType[slot];
    if (cellType === ScCellType.CLOSED) closedCell++;
    else if (cellType === ScCellType.OPEN) openCell++;
    else roll++;
    if (StratocumulusState.drizzleRate[slot] > EPSILON) drizzling++;
    if (StratocumulusState.snowMix[slot] > 0.5) snowing++;
    totalDrizzleAccum += StratocumulusState.drizzleRate[slot];
  }

  return {
    totalStratocumulus: _nextStratocumulusSlot,
    active,
    closedCell,
    openCell,
    roll,
    drizzling,
    snowing,
    totalDrizzleAccum,
    archetypesReady: StratocumulusArchetypes.initialized,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearStratocumulus() {
  _stratocumulusSlots.clear();
  _nextStratocumulusSlot = 0;
  _stratocumulusNoise3D.clear();
  _stratocumulusNoise2D.clear();
  StratocumulusState.fade.fill(0);
  StratocumulusState.drizzleRate.fill(0);
  StratocumulusState.cumulusProgress.fill(0);
}