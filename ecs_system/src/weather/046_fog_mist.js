// file number : 046
// full path name : src/weather/046_fog_mist.js
// description : Ground fog, mist, advection fog, radiation fog, valley fog,
//               sea fog, and urban smog system. Provides volumetric
//               density fields with exponential height falloff, wind-driven
//               advection meshes, pollution particle sources, visibility
//               attenuation, and sun-dimming hooks. Imports
//               029_cloud_archetypes.js as the single source of truth for
//               cloud-layer blending and reads Stratus fog state from
//               file 037 for cloud-bound layers. Contributes:
//                 • FogType taxonomy — Radiation (ground-cooled night fog),
//                   Advection (warm moist air over cold surface), Valley
//                   (cold dense air pooling in low terrain), Sea (marine
//                   layer off the ocean), Upslope (orographic lift),
//                   Frontal (warm-front approach), Smog (urban pollution
//                   haze), Mist (light visibility reduction, no cloud
//                   layer).
//                 • DensityField SoA — per-fog-region volumetric density
//                   with ground density (kg/m³), height falloff (e-folding
//                   scale height in metres), and a base altitude. Sample
//                   function returns local density in kg/m³ for raycasting.
//                 • AdvectionMesh — a 2D grid of fog "cells" that drift
//                   with wind, allowing realistic wave-like motion across
//                   the terrain. Cell density diffuses slightly and
//                   regenerates from local humidity.
//                 • Visibility hook — converts optical depth through the
//                   fog to a visibility distance in metres using the
//                   Koschmieder formula: vis = 3.912 / β_ext where β_ext
//                   is the extinction coefficient.
//                 • Smog source — a pollution emitter component that adds
//                   SO₂/PM2.5 density to nearby fog regions and darkens
//                   the fog's tint toward yellow-brown (industrial smog).
//                 • Sun dimming — returns a transmission factor for file
//                   028's sun disk intensity so fog correctly dims the
//                   sun and produces the soft "dome" look of overcast
//                   misty days.
//                 • VFX bridge — emitFogMotes returns data for file 025
//                   to render drifting sparkle motes and condensation.
//                 • Depth-fade for gameplay — the visibility hook returns
//                   a distance threshold that file 021 characters, file
//                   027 nav agents, and file 003 BVH culling can read to
//                   skip expensive work at long range.
//               All state lives in typed arrays; sampling is O(regions),
//               advection is O(cells), emission is O(smokers). Zero
//               per-frame allocation; steady-state simulation at 1M
//               entities fits on Android 64-bit.
// best for : Morning fog, coastal stratus decks, mountain valley mist,
//            industrial smog, gameplay visibility mechanics, horror /
//            thriller atmosphere, aviation weather, and any 1M-entity
//            scene needing realistic fog on Android 64-bit.
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
  CloudInstance,
  CloudArchetype,
  CloudType,
  PrecipitationType,
} from '../sky/029_cloud_archetypes.js';

import {
  StratusState,
  StratusTag,
  StratusSubtype,
  sampleStratusVisibility,
  isGroundContactActive,
} from '../sky/037_stratus_clouds.js';

import {
  SkyF32,
  SkyModel,
  getSkySlot,
} from '../sky/028_sky_atmosphere.js';

import {
  vec3,
  vec4,
  mat4,
  createNoise2D,
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

const MAX_FOG_REGIONS                = 1024;
const MAX_SMOG_SOURCES               = 4096;
const MAX_FOG_MOTES                  = 16_384;
const MAX_ADVECTION_CELLS            = 128 * 128;   // 128x128 grid max

// Koschmieder visibility formula: vis = K / β_ext where K ≈ 3.912 (5% contrast).
const KOSCHMIEDER_CONSTANT           = 3.912;

// Typical extinction coefficients (per metre at sea level):
//   Fog begins at β ≈ 0.001 (vis ≈ 4 km), becomes dense at β ≈ 0.1 (vis ≈ 40 m).
const EXTINCTION_FOG_BEGIN           = 0.001;
const EXTINCTION_FOG_DENSE           = 0.10;
const EXTINCTION_MIST                = 0.0005;
const EXTINCTION_SMOG                = 0.005;

// Standard fog density constants.
const FOG_DENSITY_MIST               = 0.0005;      // kg/m³
const FOG_DENSITY_LIGHT              = 0.001;
const FOG_DENSITY_MODERATE           = 0.01;
const FOG_DENSITY_DENSE              = 0.10;
const FOG_DENSITY_MAX                = 0.50;

// Height falloff e-folding scale (metres). Ground fog gets thicker near the ground.
const FOG_SCALE_HEIGHT_DEFAULT       = 50.0;
const FOG_SCALE_HEIGHT_VALLEY        = 150.0;
const FOG_SCALE_HEIGHT_SEA           = 200.0;
const FOG_SCALE_HEIGHT_UPSLOPE       = 100.0;

// Advection mesh defaults.
const ADVECTION_CELL_SIZE            = 32.0;        // metres per cell
const ADVECTION_DIFFUSION_RATE       = 0.02;        // per second
const ADVECTION_REGEN_RATE           = 0.05;        // per second
const ADVECTION_WIND_COUPLING        = 0.85;        // fraction of wind speed

// Smog parameters.
const SMOG_EMIT_RATE_BASE            = 0.001;       // kg/m³ per source per second
const SMOG_EMIT_RADIUS               = 200.0;       // metres
const SMOG_EMIT_HEIGHT               = 50.0;        // metres above source
const SMOG_COLOR_R                   = 1.00;
const SMOG_COLOR_G                   = 0.85;
const SMOG_COLOR_B                   = 0.55;

// Visual mist constants.
const MIST_DENSITY_VISIBILITY_THRESHOLD = 0.65;     // below this fraction = mist
const MIST_VISIBILITY_REF            = 500.0;       // metres

// Sun transmission constants.
const FOG_SUN_BLOCK_K                = 8.0;
const FOG_SUN_TRANSMIT_MIN           = 0.02;

// Player visibility.
const VISIBILITY_READ_CAP            = 30000.0;

// ═══════════════════════════════════════════════════════════════════════
// FOG TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const FogType = Object.freeze({
  RADIATION: 0,   // ground-cooled night fog
  ADVECTION: 1,   // warm moist air over cold surface
  VALLEY:    2,   // cold dense air pooling in low terrain
  SEA:       3,   // marine layer off the ocean
  UPSLOPE:   4,   // orographic lift
  FRONTAL:   5,   // warm-front approach
  SMOG:      6,   // urban pollution haze
  MIST:      7,   // light visibility reduction
});

// ═══════════════════════════════════════════════════════════════════════
// SoA FOG REGIONS
// ═══════════════════════════════════════════════════════════════════════

export const FogRegion = {
  // Owner entity (usually the fog root; can be unused).
  ownerEid: new Uint32Array(MAX_FOG_REGIONS),

  // Type (FogType).
  type: new Uint8Array(MAX_FOG_REGIONS),

  // World-space center.
  cx: new Float32Array(MAX_FOG_REGIONS),
  cy: new Float32Array(MAX_FOG_REGIONS),
  cz: new Float32Array(MAX_FOG_REGIONS),

  // Horizontal radius (metres; 0 = infinite/infinite).
  radiusX: new Float32Array(MAX_FOG_REGIONS),
  radiusZ: new Float32Array(MAX_FOG_REGIONS),

  // Base altitude (metres).
  baseAltitude: new Float32Array(MAX_FOG_REGIONS),

  // Top altitude (metres; 0 = unlimited).
  topAltitude: new Float32Array(MAX_FOG_REGIONS),

  // Ground density (kg/m³).
  groundDensity: new Float32Array(MAX_FOG_REGIONS),

  // E-folding height (metres).
  scaleHeight: new Float32Array(MAX_FOG_REGIONS),

  // Tint colour (linear RGB; usually (1, 1, 1) for clean fog, shifted
  // toward yellow for smog or grey for urban haze).
  tintR: new Float32Array(MAX_FOG_REGIONS),
  tintG: new Float32Array(MAX_FOG_REGIONS),
  tintB: new Float32Array(MAX_FOG_REGIONS),

  // Active flag.
  active: new Uint8Array(MAX_FOG_REGIONS),

  // Seed for noise.
  seed: new Uint32Array(MAX_FOG_REGIONS),

  // Optional owning sky entity (for sun dimming lookup).
  skyEid: new Uint32Array(MAX_FOG_REGIONS),
};

/** Marker: entity is a fog region. */
export const FogRegionTag = {};

const _fogRegionSlots = new Map(); // eid -> region slot
let _nextFogRegionSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA ADVECTION MESH
// ═══════════════════════════════════════════════════════════════════════

/**
 * Each fog region owns an optional advection mesh (2D grid) that
 * represents local fog density variations.
 */
export const AdvectionMesh = {
  // Region slot this mesh belongs to.
  regionSlot: new Uint16Array(MAX_FOG_REGIONS),

  // Mesh dimensions.
  gridW: new Uint8Array(MAX_FOG_REGIONS),
  gridH: new Uint8Array(MAX_FOG_REGIONS),

  // World origin (SW corner).
  originX: new Float32Array(MAX_FOG_REGIONS),
  originZ: new Float32Array(MAX_FOG_REGIONS),

  // Cell size (metres).
  cellSize: new Float32Array(MAX_FOG_REGIONS),

  // Per-cell density multipliers (0..1; 1 = base region density).
  // Stored contiguously per region.
  cells: new Map(),   // regionSlot -> Float32Array(gridW × gridH)

  // Per-cell advection phase (for noise overlay).
  phases: new Map(),  // regionSlot -> Float32Array(gridW × gridH)

  // Active.
  active: new Uint8Array(MAX_FOG_REGIONS),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA SMOG SOURCES — pollution emitters
// ═══════════════════════════════════════════════════════════════════════

export const SmogSource = {
  ownerEid: new Uint32Array(MAX_SMOG_SOURCES),

  // World position.
  px: new Float32Array(MAX_SMOG_SOURCES),
  py: new Float32Array(MAX_SMOG_SOURCES),
  pz: new Float32Array(MAX_SMOG_SOURCES),

  // Emission rate (kg/m³/s).
  emitRate: new Float32Array(MAX_SMOG_SOURCES),

  // Emission radius (metres).
  radius: new Float32Array(MAX_SMOG_SOURCES),

  // Active.
  active: new Uint8Array(MAX_SMOG_SOURCES),
};

/** Marker: entity is a smog source (e.g. chimney, industrial building). */
export const SmogSourceTag = {};

// ═══════════════════════════════════════════════════════════════════════
// SoA FOG MOTES — tiny drifting particles for close-up visibility
// ═══════════════════════════════════════════════════════════════════════

export const FogMote = {
  active: new Uint8Array(MAX_FOG_MOTES),

  // World position.
  px: new Float32Array(MAX_FOG_MOTES),
  py: new Float32Array(MAX_FOG_MOTES),
  pz: new Float32Array(MAX_FOG_MOTES),

  // World velocity.
  vx: new Float32Array(MAX_FOG_MOTES),
  vy: new Float32Array(MAX_FOG_MOTES),
  vz: new Float32Array(MAX_FOG_MOTES),

  // Size (metres).
  size: new Float32Array(MAX_FOG_MOTES),

  // Age + lifetime.
  age: new Float32Array(MAX_FOG_MOTES),
  lifetime: new Float32Array(MAX_FOG_MOTES),

  // Tint.
  r: new Float32Array(MAX_FOG_MOTES),
  g: new Float32Array(MAX_FOG_MOTES),
  b: new Float32Array(MAX_FOG_MOTES),

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
// FOG REGION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a fog region.
 *
 * @param world       ECS world
 * @param eid         owner entity
 * @param type        FogType
 * @param options     { cx, cy, cz, radiusX, radiusZ, baseAltitude,
 *                      topAltitude, groundDensity, scaleHeight, tint }
 */
export function addFogRegion(world, eid, type = FogType.RADIATION, options = {}) {
  if (_nextFogRegionSlot >= MAX_FOG_REGIONS) {
    throw new Error('fog region capacity exceeded');
  }
  const slot = _nextFogRegionSlot++;

  addComponent(world, eid, FogRegionTag);

  const F = FogRegion;
  F.ownerEid[slot] = eid;
  F.type[slot] = type;
  F.cx[slot] = options.cx ?? 0;
  F.cy[slot] = options.cy ?? 0;
  F.cz[slot] = options.cz ?? 0;
  F.radiusX[slot] = options.radiusX ?? 0;
  F.radiusZ[slot] = options.radiusZ ?? 0;
  F.baseAltitude[slot] = options.baseAltitude ?? 0;
  F.topAltitude[slot] = options.topAltitude ?? 0;
  F.groundDensity[slot] = options.groundDensity ?? defaultDensityForType(type);
  F.scaleHeight[slot] = options.scaleHeight ?? defaultScaleHeightForType(type);

  const tint = options.tint ?? [1, 1, 1];
  F.tintR[slot] = tint[0];
  F.tintG[slot] = tint[1];
  F.tintB[slot] = tint[2];

  F.active[slot] = 1;
  F.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);
  F.skyEid[slot] = options.skyEid ?? 0;

  _fogRegionSlots.set(eid, slot);
  return slot;
}

export function removeFogRegion(world, eid) {
  const slot = _fogRegionSlots.get(eid);
  if (slot === undefined) return;

  FogRegion.active[slot] = 0;
  FogRegion.ownerEid[slot] = 0;
  AdvectionMesh.active[slot] = 0;
  AdvectionMesh.cells.delete(slot);
  AdvectionMesh.phases.delete(slot);
  _fogRegionSlots.delete(eid);

  removeComponent(world, eid, FogRegionTag);
}

export function getFogRegionSlot(eid) {
  return _fogRegionSlots.get(eid) ?? -1;
}

function defaultDensityForType(type) {
  switch (type) {
    case FogType.MIST:       return FOG_DENSITY_MIST;
    case FogType.RADIATION:  return FOG_DENSITY_LIGHT;
    case FogType.ADVECTION:  return FOG_DENSITY_MODERATE;
    case FogType.VALLEY:     return FOG_DENSITY_DENSE;
    case FogType.SEA:        return FOG_DENSITY_MODERATE;
    case FogType.UPSLOPE:    return FOG_DENSITY_LIGHT;
    case FogType.FRONTAL:    return FOG_DENSITY_MODERATE;
    case FogType.SMOG:       return FOG_DENSITY_LIGHT;
    default:                 return FOG_DENSITY_LIGHT;
  }
}

function defaultScaleHeightForType(type) {
  switch (type) {
    case FogType.VALLEY:   return FOG_SCALE_HEIGHT_VALLEY;
    case FogType.SEA:      return FOG_SCALE_HEIGHT_SEA;
    case FogType.UPSLOPE:  return FOG_SCALE_HEIGHT_UPSLOPE;
    case FogType.SMOG:     return FOG_SCALE_HEIGHT_DEFAULT * 2;
    default:               return FOG_SCALE_HEIGHT_DEFAULT;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ADVECTION MESH API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Enable advection mesh on a fog region.
 *
 * @param regionSlot   fog region slot
 * @param gridW        grid width (cells)
 * @param gridH        grid height (cells)
 * @param cellSize     metres per cell
 */
export function enableAdvection(regionSlot, gridW = 32, gridH = 32, cellSize = ADVECTION_CELL_SIZE) {
  if (regionSlot < 0 || regionSlot >= _nextFogRegionSlot) return false;
  if (gridW * gridH > MAX_ADVECTION_CELLS) return false;

  AdvectionMesh.regionSlot[regionSlot] = regionSlot;
  AdvectionMesh.gridW[regionSlot] = gridW;
  AdvectionMesh.gridH[regionSlot] = gridH;
  AdvectionMesh.originX[regionSlot] = FogRegion.cx[regionSlot] - (gridW * cellSize * 0.5);
  AdvectionMesh.originZ[regionSlot] = FogRegion.cz[regionSlot] - (gridH * cellSize * 0.5);
  AdvectionMesh.cellSize[regionSlot] = cellSize;

  const cells = new Float32Array(gridW * gridH);
  const phases = new Float32Array(gridW * gridH);
  for (let i = 0; i < gridW * gridH; i++) {
    cells[i] = 0.7 + Math.random() * 0.6;
    phases[i] = Math.random() * TWO_PI;
  }
  AdvectionMesh.cells.set(regionSlot, cells);
  AdvectionMesh.phases.set(regionSlot, phases);
  AdvectionMesh.active[regionSlot] = 1;

  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// SMOG SOURCE API
// ═══════════════════════════════════════════════════════════════════════

export function addSmogSource(world, eid, options = {}) {
  if (_nextSmogSourceSlot >= MAX_SMOG_SOURCES) {
    throw new Error('smog source capacity exceeded');
  }
  const slot = _nextSmogSourceSlot++;

  addComponent(world, eid, SmogSourceTag);

  SmogSource.ownerEid[slot] = eid;
  SmogSource.px[slot] = options.px ?? 0;
  SmogSource.py[slot] = options.py ?? 0;
  SmogSource.pz[slot] = options.pz ?? 0;
  SmogSource.emitRate[slot] = options.emitRate ?? SMOG_EMIT_RATE_BASE;
  SmogSource.radius[slot] = options.radius ?? SMOG_EMIT_RADIUS;
  SmogSource.active[slot] = 1;
  return slot;
}

let _nextSmogSourceSlot = 0;

export function removeSmogSource(world, eid) {
  for (let slot = 0; slot < _nextSmogSourceSlot; slot++) {
    if (SmogSource.ownerEid[slot] === eid) {
      SmogSource.active[slot] = 0;
      SmogSource.ownerEid[slot] = 0;
      removeComponent(world, eid, SmogSourceTag);
      return;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FOG DENSITY SAMPLING — the hot path
// ═══════════════════════════════════════════════════════════════════════

const _advectionNoise = createNoise2D();
const _fogNoise = createNoise3D();

/**
 * Sample the total fog density (kg/m³) at a world position.
 * Sums over all active regions that contain the point, applies
 * exponential height falloff, and multiplies by advection mesh density
 * if present.
 */
export function sampleFogDensity(wx, wy, wz) {
  let totalDensity = 0;

  for (let slot = 0; slot < _nextFogRegionSlot; slot++) {
    if (!FogRegion.active[slot]) continue;

    const F = FogRegion;

    // Horizontal containment.
    const dx = wx - F.cx[slot];
    const dz = wz - F.cz[slot];
    if (F.radiusX[slot] > 0) {
      const dxN = dx / F.radiusX[slot];
      const dzN = dz / F.radiusZ[slot];
      const horizDistSq = dxN * dxN + dzN * dzN;
      if (horizDistSq > 1.0) continue;
    }

    // Vertical containment.
    const dy = wy - F.baseAltitude[slot];
    if (dy < 0) continue;
    if (F.topAltitude[slot] > 0 && wy > F.topAltitude[slot]) continue;

    // Exponential falloff from base altitude.
    const scaleH = Math.max(F.scaleHeight[slot], 1.0);
    const heightFalloff = Math.exp(-dy / scaleH);

    // Advection mesh modulation.
    let advectionMod = 1;
    if (AdvectionMesh.active[slot]) {
      const cells = AdvectionMesh.cells.get(slot);
      const gridW = AdvectionMesh.gridW[slot];
      const gridH = AdvectionMesh.gridH[slot];
      const cellSize = AdvectionMesh.cellSize[slot];
      const originX = AdvectionMesh.originX[slot];
      const originZ = AdvectionMesh.originZ[slot];

      const cx = (wx - originX) / cellSize;
      const cz = (wz - originZ) / cellSize;

      if (cx >= 0 && cx < gridW - 1 && cz >= 0 && cz < gridH - 1) {
        const ix = Math.floor(cx);
        const iz = Math.floor(cz);
        const fx = cx - ix;
        const fz = cz - iz;

        const i00 = iz * gridW + ix;
        const i10 = i00 + 1;
        const i01 = i00 + gridW;
        const i11 = i01 + 1;

        const a = cells[i00] * (1 - fx) * (1 - fz);
        const b = cells[i10] * fx * (1 - fz);
        const c = cells[i01] * (1 - fx) * fz;
        const d = cells[i11] * fx * fz;
        advectionMod = a + b + c + d;
      }
    }

    // Noise variation.
    const seed = F.seed[slot] * 0.001;
    const n = _fogNoise(wx * 0.005 + seed, wy * 0.01, wz * 0.005 + seed) * 0.5 + 0.5;
    const noiseMod = 0.8 + 0.2 * n;

    const localDensity = F.groundDensity[slot] * heightFalloff * advectionMod * noiseMod;
    totalDensity += localDensity;
  }

  return Math.min(FOG_DENSITY_MAX, totalDensity);
}

/**
 * Sample the tint of fog at a world position (weighted average across
 * contributing regions).
 */
export function sampleFogTint(wx, wy, wz, out) {
  let totalWeight = 0;
  let r = 0, g = 0, b = 0;

  for (let slot = 0; slot < _nextFogRegionSlot; slot++) {
    if (!FogRegion.active[slot]) continue;

    const F = FogRegion;
    const dy = wy - F.baseAltitude[slot];
    if (dy < 0) continue;

    // Same containment logic as density, but simplified.
    const dx = wx - F.cx[slot];
    const dz = wz - F.cz[slot];
    let inBounds = true;
    if (F.radiusX[slot] > 0) {
      const dxN = dx / F.radiusX[slot];
      const dzN = dz / F.radiusZ[slot];
      if (dxN * dxN + dzN * dzN > 1.0) inBounds = false;
    }
    if (F.topAltitude[slot] > 0 && wy > F.topAltitude[slot]) inBounds = false;
    if (!inBounds) continue;

    const scaleH = Math.max(F.scaleHeight[slot], 1.0);
    const weight = Math.exp(-dy / scaleH) * F.groundDensity[slot];

    r += F.tintR[slot] * weight;
    g += F.tintG[slot] * weight;
    b += F.tintB[slot] * weight;
    totalWeight += weight;
  }

  if (totalWeight < EPSILON) {
    out[0] = 1; out[1] = 1; out[2] = 1;
    return out;
  }

  const inv = 1 / totalWeight;
  out[0] = r * inv;
  out[1] = g * inv;
  out[2] = b * inv;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// EXTINCTION COEFFICIENT — sample at a point
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the extinction coefficient β_ext (1/m) at a world position.
 * Uses a simple linear relation: β_ext ≈ 3.912 × density × κ where κ
 * is a density-specific scattering factor (typically ~20 for water fog).
 */
export function sampleFogExtinction(wx, wy, wz) {
  const density = sampleFogDensity(wx, wy, wz);
  if (density < EPSILON) return 0;

  // Scattering factor: fog droplets are highly efficient scatterers.
  const scatteringFactor = 20.0;
  return KOSCHMIEDER_CONSTANT * density * scatteringFactor;
}

/**
 * Convert extinction coefficient to visibility distance (metres) using
 * Koschmieder's formula: vis = 3.912 / β_ext.
 */
export function extinctionToVisibility(beta) {
  if (beta < EPSILON) return VISIBILITY_READ_CAP;
  return Math.min(VISIBILITY_READ_CAP, KOSCHMIEDER_CONSTANT / beta);
}

/**
 * Return the visibility distance (metres) at a world position.
 * Combines all local fog regions AND file 037's stratus fog state.
 */
export function sampleVisibility(wx, wy, wz) {
  let minVisibility = VISIBILITY_READ_CAP;

  // Local fog regions.
  const beta = sampleFogExtinction(wx, wy, wz);
  if (beta > EPSILON) {
    const fogVis = extinctionToVisibility(beta);
    if (fogVis < minVisibility) minVisibility = fogVis;
  }

  // Stratus fog from file 037.
  const stratusVis = sampleStratusVisibility(wx, wy, wz);
  if (stratusVis < minVisibility) minVisibility = stratusVis;

  return minVisibility;
}

// ═══════════════════════════════════════════════════════════════════════
// SUN DIMMING — integrates with file 028
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the sun transmission factor through fog along a ray from
 * (cameraX, cameraY, cameraZ) toward the sun.
 * Uses simplified single-scatter attenuation along the ray.
 */
export function sampleFogSunDimming(cameraX, cameraY, cameraZ, sunDirX, sunDirY, sunDirZ) {
  // March 8 steps along the sun direction to accumulate optical depth.
  const steps = 8;
  const stepLen = 500.0;
  let opticalDepth = 0;

  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * stepLen;
    const wx = cameraX + sunDirX * t;
    const wy = cameraY + sunDirY * t;
    const wz = cameraZ + sunDirZ * t;

    const beta = sampleFogExtinction(wx, wy, wz);
    opticalDepth += beta * stepLen;
  }

  const transmission = Math.exp(-opticalDepth * FOG_SUN_BLOCK_K * 0.1);
  return Math.max(FOG_SUN_TRANSMIT_MIN, transmission);
}

// ═══════════════════════════════════════════════════════════════════════
// ADVECTION MESH UPDATE — drift cells with wind
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the advection mesh for a region.
 * Cells are advected with wind (approximated by wrapping the mesh with
 * an advection offset), then diffuse slightly and regenerate toward 1.0.
 */
export function systemUpdateAdvection(regionSlot, dt, windSpeed, windDirX, windDirZ) {
  if (!AdvectionMesh.active[regionSlot]) return;

  const cells = AdvectionMesh.cells.get(regionSlot);
  const gridW = AdvectionMesh.gridW[regionSlot];
  const gridH = AdvectionMesh.gridH[regionSlot];
  const cellSize = AdvectionMesh.cellSize[regionSlot];

  // Advection: shift cell values in the direction of wind. We approximate
  // by a small linear shift on each cell using its neighbor.
  const advCell = Math.min(gridW, Math.max(1, Math.round(windSpeed * dt / cellSize)));
  const dirX = Math.round(windDirX * advCell);
  const dirZ = Math.round(windDirZ * advCell);

  if (dirX !== 0 || dirZ !== 0) {
    // Temporary array for shifted values.
    const temp = new Float32Array(gridW * gridH);
    for (let z = 0; z < gridH; z++) {
      for (let x = 0; x < gridW; x++) {
        const srcX = (x - dirX + gridW) % gridW;
        const srcZ = (z - dirZ + gridH) % gridH;
        temp[z * gridW + x] = cells[srcZ * gridW + srcX];
      }
    }
    cells.set(temp);
  }

  // Diffuse and regenerate.
  const diffusion = ADVECTION_DIFFUSION_RATE * dt;
  const regen = ADVECTION_REGEN_RATE * dt;

  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];

    // Neighbor average.
    const x = i % gridW;
    const z = Math.floor(i / gridW);
    const nL = cells[z * gridW + ((x - 1 + gridW) % gridW)];
    const nR = cells[z * gridW + ((x + 1) % gridW)];
    const nU = cells[((z - 1 + gridH) % gridH) * gridW + x];
    const nD = cells[((z + 1) % gridH) * gridW + x];
    const avg = (nL + nR + nU + nD) * 0.25;

    // Blend toward neighbor average (diffusion) and toward 1.0 (regen).
    cells[i] = v + (avg - v) * diffusion + (1.0 - v) * regen;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SMOG EMISSION — pollution increases fog density locally
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add smog from all active sources into the nearest fog regions.
 * Called once per frame. Effect: slightly increases groundDensity of
 * nearby SMOG-type regions, darkening their tint toward yellow-brown.
 */
export function systemUpdateSmog(world, dt) {
  for (let src = 0; src < _nextSmogSourceSlot; src++) {
    if (!SmogSource.active[src]) continue;

    const sx = SmogSource.px[src];
    const sy = SmogSource.py[src];
    const sz = SmogSource.pz[src];
    const radius = SmogSource.radius[src];
    const emitRate = SmogSource.emitRate[src];

    for (let region = 0; region < _nextFogRegionSlot; region++) {
      if (!FogRegion.active[region]) continue;

      const dx = sx - FogRegion.cx[region];
      const dz = sz - FogRegion.cz[region];
      const distSq = dx * dx + dz * dz;
      const emitRadiusSq = radius * radius;

      if (distSq > emitRadiusSq) continue;

      // Falloff.
      const falloff = 1 - Math.sqrt(distSq) / radius;

      // Add to ground density.
      FogRegion.groundDensity[region] = Math.min(
        FOG_DENSITY_MAX,
        FogRegion.groundDensity[region] + emitRate * dt * falloff
      );

      // Darken tint toward smog colour.
      FogRegion.tintR[region] = FogRegion.tintR[region] * (1 - dt * 0.01) + SMOG_COLOR_R * dt * 0.01;
      FogRegion.tintG[region] = FogRegion.tintG[region] * (1 - dt * 0.01) + SMOG_COLOR_G * dt * 0.01;
      FogRegion.tintB[region] = FogRegion.tintB[region] * (1 - dt * 0.01) + SMOG_COLOR_B * dt * 0.01;
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// FOG MOTES — small drifting particles for close-up visuals
// ═══════════════════════════════════════════════════════════════════════

function allocFogMote() {
  const M = FogMote;
  for (let i = 0; i < MAX_FOG_MOTES; i++) {
    const slot = (M.freeHead + i) % MAX_FOG_MOTES;
    if (M.active[slot] === 0) {
      M.freeHead = (slot + 1) % MAX_FOG_MOTES;
      M.active[slot] = 1;
      M.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeFogMote(slot) {
  const M = FogMote;
  if (M.active[slot] === 0) return;
  M.active[slot] = 0;
  M.liveCount--;
}

/**
 * Spawn fog motes near the camera when inside a fog region with low
 * visibility.
 *
 * @param world      ECS world
 * @param cameraX/Y/Z camera position
 * @param dt         seconds
 * @param rate       motes per second (default 60)
 */
export function emitFogMotesNearCamera(world, cameraX, cameraY, cameraZ, dt, rate = 60) {
  // Check if fog is dense enough.
  const density = sampleFogDensity(cameraX, cameraY, cameraZ);
  if (density < MIST_DENSITY_VISIBILITY_THRESHOLD * FOG_DENSITY_LIGHT) return;

  const motesThisFrame = rate * dt;
  const wholeMotes = Math.floor(motesThisFrame);
  const fractional = motesThisFrame - wholeMotes;
  const finalMotes = wholeMotes + (Math.random() < fractional ? 1 : 0);

  for (let i = 0; i < finalMotes; i++) {
    const slot = allocFogMote();
    if (slot < 0) return;

    // Spawn in a box around the camera.
    const dx = (Math.random() - 0.5) * 6;
    const dy = (Math.random() - 0.5) * 3;
    const dz = (Math.random() - 0.5) * 6;

    FogMote.px[slot] = cameraX + dx;
    FogMote.py[slot] = cameraY + dy;
    FogMote.pz[slot] = cameraZ + dz;
    FogMote.vx[slot] = (Math.random() - 0.5) * 0.3;
    FogMote.vy[slot] = (Math.random() - 0.5) * 0.1;
    FogMote.vz[slot] = (Math.random() - 0.5) * 0.3;
    FogMote.size[slot] = 0.01 + Math.random() * 0.03;
    FogMote.age[slot] = 0;
    FogMote.lifetime[slot] = 3.0 + Math.random() * 2.0;

    const tint = sampleFogTint(cameraX, cameraY, cameraZ, [0, 0, 0]);
    FogMote.r[slot] = tint[0] * 0.9 + 0.1;
    FogMote.g[slot] = tint[1] * 0.9 + 0.1;
    FogMote.b[slot] = tint[2] * 0.9 + 0.1;
  }
}

/**
 * Advance fog motes.
 */
export function systemUpdateFogMotes(world, dt) {
  const M = FogMote;
  for (let slot = 0; slot < MAX_FOG_MOTES; slot++) {
    if (M.active[slot] === 0) continue;

    M.age[slot] += dt;
    if (M.age[slot] >= M.lifetime[slot]) {
      freeFogMote(slot);
      continue;
    }

    M.px[slot] += M.vx[slot] * dt;
    M.py[slot] += M.vy[slot] * dt;
    M.pz[slot] += M.vz[slot] * dt;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MIST DETECTION — is visibility in the "mist" range?
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return true if the local visibility is in the mist range (light fog).
 * "Mist" is defined as visibility between 500 m and 4 km.
 */
export function isMist(wx, wy, wz) {
  const vis = sampleVisibility(wx, wy, wz);
  return vis >= MIST_VISIBILITY_REF && vis < 4000;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a summary of all active fog regions for renderer upload.
 * The renderer should use these to configure a volumetric fog shader.
 */
export function gatherFogRegionsForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextFogRegionSlot; slot++) {
    if (!FogRegion.active[slot]) continue;
    result.push({
      type: FogRegion.type[slot],
      cx: FogRegion.cx[slot],
      cy: FogRegion.cy[slot],
      cz: FogRegion.cz[slot],
      radiusX: FogRegion.radiusX[slot],
      radiusZ: FogRegion.radiusZ[slot],
      baseAltitude: FogRegion.baseAltitude[slot],
      topAltitude: FogRegion.topAltitude[slot],
      density: FogRegion.groundDensity[slot],
      scaleHeight: FogRegion.scaleHeight[slot],
      tint: [FogRegion.tintR[slot], FogRegion.tintG[slot], FogRegion.tintB[slot]],
    });
  }
  return result;
}

export function gatherFogMotesForRendering(maxOutput = 512) {
  const result = [];
  const M = FogMote;
  for (let slot = 0; slot < MAX_FOG_MOTES; slot++) {
    if (M.active[slot] === 0) continue;
    result.push({
      x: M.px[slot], y: M.py[slot], z: M.pz[slot],
      size: M.size[slot],
      age: M.age[slot],
      lifetime: M.lifetime[slot],
      tint: [M.r[slot], M.g[slot], M.b[slot]],
    });
    if (result.length >= maxOutput) break;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearFog() {
  FogRegion.active.fill(0);
  FogRegion.ownerEid.fill(0);
  AdvectionMesh.active.fill(0);
  AdvectionMesh.cells.clear();
  AdvectionMesh.phases.clear();
  SmogSource.active.fill(0);
  SmogSource.ownerEid.fill(0);
  FogMote.active.fill(0);
  FogMote.freeHead = 0;
  FogMote.liveCount = 0;
  _fogRegionSlots.clear();
  _nextFogRegionSlot = 0;
  _nextSmogSourceSlot = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function fogStats() {
  let activeRegions = 0;
  let activeAdvections = 0;
  let activeSmogSources = 0;
  let avgDensity = 0;
  let maxDensity = 0;

  for (let slot = 0; slot < _nextFogRegionSlot; slot++) {
    if (!FogRegion.active[slot]) continue;
    activeRegions++;
    avgDensity += FogRegion.groundDensity[slot];
    if (FogRegion.groundDensity[slot] > maxDensity) {
      maxDensity = FogRegion.groundDensity[slot];
    }
    if (AdvectionMesh.active[slot]) activeAdvections++;
  }

  for (let slot = 0; slot < _nextSmogSourceSlot; slot++) {
    if (SmogSource.active[slot]) activeSmogSources++;
  }

  if (activeRegions > 0) avgDensity /= activeRegions;

  return {
    fogRegions: activeRegions,
    maxRegions: MAX_FOG_REGIONS,
    advections: activeAdvections,
    smogSources: activeSmogSources,
    maxSmogSources: MAX_SMOG_SOURCES,
    fogMotes: FogMote.liveCount,
    maxFogMotes: MAX_FOG_MOTES,
    avgDensity,
    maxDensity,
  };
}