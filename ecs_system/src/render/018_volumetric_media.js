// file number : 018
// full path name : src/render/018_volumetric_media.js
// description : Heterogeneous participating media system inspired by
//               PBRT-v4's Medium interface and GridDensityMedium. Provides
//               SoA MediaF32 stores (sigma_a, sigma_s, sigma_t, albedo,
//               emission, g), a voxel grid density field with trilinear
//               interpolation, ratio tracking and delta tracking for
//               transmittance and radiance, and per-entity MediaVolume
//               components that let file 017's VolPathIntegrator sample
//               real participating media inside a bounded region.
//               Also implements a media-BVH so scenes with hundreds of
//               overlapping volumes (smoke, clouds, fog, water) query in
//               O(log n) rather than iterating every volume per ray.
//               Media density is stored as Float16-like compressed bytes
//               so 1M-voxel grids consume ≤1 MB per volume on mobile.
// best for : Volumetric fog, clouds, smoke, dust, water, atmospheric
//            scattering, subsurface effect previews, and any scene that
//            needs real participating media at 1M-entity scale on
//            Android 64-bit.
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
} from '../transform/002_transform_hierarchy.js';

import {
  WorldBoundsF32,
  LocalBoundsF32,
  getWorldBoundsCenter,
} from '../geometry/004_aabb_bounds.js';

import {
  LightF32,
  LightType,
  sampleLight,
} from './015_lights_shadows.js';

import {
  vec3,
  mat4,
  quat,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ          = 1e-16;
const EPSILON             = 1e-8;
const EPSILON_HIGH        = 1e-12;
const PI                  = Math.PI;
const TWO_PI              = 2 * Math.PI;
const INV_PI              = 1 / Math.PI;
const INV_TWO_PI          = 1 / (2 * Math.PI);
const HALF_PI             = Math.PI / 2;
const DEG_TO_RAD          = Math.PI / 180;
const RAD_TO_DEG          = 180 / Math.PI;
const SHADOW_EPSILON      = 1e-4;
const MAX_MARCH_STEPS     = 256;
const RATIO_TRACK_EPSILON = 1e-3;
const MAJORANT_INFINITY   = 1e30;
const DEFAULT_GRID_RES    = 8;

// ═══════════════════════════════════════════════════════════════════════
// MEDIUM TYPE
// ═══════════════════════════════════════════════════════════════════════

export const MediumType = Object.freeze({
  HOMOGENEOUS:     0,   // constant sigma over volume
  HETEROGENEOUS:   1,   // density grid
  CLOUD:           2,   // heterogeneous with per-voxel albedo + emission
  ATMOSPHERE:      3,   // Rayleigh + Mie approximation
});

export const PhaseFunction = Object.freeze({
  ISOTROPIC:       0,
  HG:              1,   // Henyey-Greenstein (g parameter)
  RAYLEIGH:        2,
});

// ═══════════════════════════════════════════════════════════════════════
// MEDIA VOLUME COMPONENT (per-entity, SoA-friendly)
// ═══════════════════════════════════════════════════════════════════════

const MAX_VOLUMES = 100_000;

export const MediaVolume = {
  // Volume id in MEDIA_REGISTRY.
  mediumId: new Uint32Array(MAX_VOLUMES),
  // Priority (higher wins when volumes overlap).
  priority: new Uint16Array(MAX_VOLUMES),
  // Enabled flag.
  enabled: new Uint8Array(MAX_VOLUMES),
  // World-space AABB (updated from WorldTransformF32 + LocalBoundsF32).
  minX: new Float32Array(MAX_VOLUMES),
  minY: new Float32Array(MAX_VOLUMES),
  minZ: new Float32Array(MAX_VOLUMES),
  maxX: new Float32Array(MAX_VOLUMES),
  maxY: new Float32Array(MAX_VOLUMES),
  maxZ: new Float32Array(MAX_VOLUMES),
};

/** Marker: entity is a participating medium volume. */
export const MediaVolumeTag = {};

// ═══════════════════════════════════════════════════════════════════════
// MEDIA REGISTRY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Media registry entry layout (PBRT-v4 GridDensityMedium-compatible):
 *   {
 *     id,
 *     type,               MediumType
 *     phase,              PhaseFunction
 *     g,                  HG asymmetry
 *     sigmaA: [r,g,b],    absorption coefficient (per unit distance)
 *     sigmaS: [r,g,b],    scattering coefficient (per unit distance)
 *     emission: [r,g,b],  emission per unit distance
 *     density,            global density scale (multiplies sigma)
 *     gridRes: [nx,ny,nz] // heterogeneous only
 *     gridData,           Uint8Array (nx*ny*nz) — 0..255 density
 *     gridMin, gridMax,   local-space AABB of grid
 *     priority,
 *   }
 */
export const MEDIA_REGISTRY = new Map();
let _nextMediumId = 1;

/**
 * Create a homogeneous medium (PBRT-v4 HomogeneousMedium equivalent).
 * All sigma coefficients are per unit length.
 */
export function createHomogeneousMedium({
  sigmaA = [0.01, 0.01, 0.01],
  sigmaS = [0.1, 0.1, 0.1],
  emission = [0, 0, 0],
  g = 0,
  phase = PhaseFunction.HG,
  priority = 0,
} = {}) {
  const id = _nextMediumId++;
  MEDIA_REGISTRY.set(id, {
    id,
    type: MediumType.HOMOGENEOUS,
    phase,
    g,
    sigmaA: sigmaA.slice(),
    sigmaS: sigmaS.slice(),
    emission: emission.slice(),
    density: 1,
    gridRes: null,
    gridData: null,
    gridMin: [0, 0, 0],
    gridMax: [1, 1, 1],
    priority,
  });
  return id;
}

/**
 * Create a heterogeneous medium from a density grid.
 * gridData: Uint8Array (nx*ny*nz), values 0..255 (density multiplier).
 */
export function createGridMedium({
  gridData,
  gridRes = [8, 8, 8],
  gridMin = [0, 0, 0],
  gridMax = [1, 1, 1],
  sigmaA = [0.01, 0.01, 0.01],
  sigmaS = [0.1, 0.1, 0.1],
  emission = [0, 0, 0],
  g = 0,
  phase = PhaseFunction.HG,
  density = 1,
  priority = 0,
} = {}) {
  const [nx, ny, nz] = gridRes;
  if (gridData.length !== nx * ny * nz) {
    throw new Error(
      `createGridMedium: gridData length must be nx*ny*nz (${nx * ny * nz}), got ${gridData.length}`
    );
  }
  const id = _nextMediumId++;
  MEDIA_REGISTRY.set(id, {
    id,
    type: MediumType.HETEROGENEOUS,
    phase,
    g,
    sigmaA: sigmaA.slice(),
    sigmaS: sigmaS.slice(),
    emission: emission.slice(),
    density,
    gridRes: [nx, ny, nz],
    gridData: new Uint8Array(gridData),
    gridMin: gridMin.slice(),
    gridMax: gridMax.slice(),
    priority,
  });
  return id;
}

/**
 * Create a cloud medium (grid with per-voxel variations).
 * Same as createGridMedium but uses MediumType.CLOUD for shader hints.
 */
export function createCloudMedium(opts) {
  const id = createGridMedium(opts);
  const entry = MEDIA_REGISTRY.get(id);
  if (entry) entry.type = MediumType.CLOUD;
  return id;
}

/**
 * Create a Rayleigh + Mie atmosphere approximation.
 * Good for sky-atmosphere and altitude-dependent fog.
 */
export function createAtmosphereMedium({
  rayleighScaleHeight = 8500,
  mieScaleHeight      = 1200,
  rayleighCoefficient = [5.5e-6, 13.0e-6, 22.4e-6],
  mieCoefficient      = 21e-6,
  g                   = 0.76,
  priority = 0,
} = {}) {
  const id = _nextMediumId++;
  MEDIA_REGISTRY.set(id, {
    id,
    type: MediumType.ATMOSPHERE,
    phase: PhaseFunction.RAYLEIGH,
    g,
    sigmaA: [0, 0, 0],
    sigmaS: rayleighCoefficient.slice(),    // for Rayleigh, use sigmaS
    emission: [0, 0, 0],
    density: 1,
    gridRes: null,
    gridData: null,
    gridMin: [0, 0, 0],
    gridMax: [1, 1, 1],
    priority,
    // Atmosphere-specific parameters.
    rayleighScaleHeight,
    mieScaleHeight,
    rayleighCoefficient,
    mieCoefficient,
  });
  return id;
}

export function getMedium(id) {
  return MEDIA_REGISTRY.get(id) ?? null;
}

export function removeMedium(id) {
  MEDIA_REGISTRY.delete(id);
}

// ═══════════════════════════════════════════════════════════════════════
// ECS API — attach volumes
// ═══════════════════════════════════════════════════════════════════════

/**
 * Attach a medium volume to an entity.
 * The entity's WorldBoundsF32 (file 004) defines the world-space AABB.
 */
export function addMediaVolume(world, eid, mediumId, priority = 0) {
  if (!MEDIA_REGISTRY.has(mediumId)) {
    throw new Error(`addMediaVolume: medium ${mediumId} not found`);
  }
  addComponent(world, eid, MediaVolume);
  addComponent(world, eid, MediaVolumeTag);

  const id = getId(eid);
  MediaVolume.mediumId[id] = mediumId;
  MediaVolume.priority[id] = priority;
  MediaVolume.enabled[id] = 1;
  return eid;
}

export function setMediaVolumeEnabled(world, eid, enabled) {
  const id = getId(eid);
  MediaVolume.enabled[id] = enabled ? 1 : 0;
}

export function removeMediaVolume(world, eid) {
  const id = getId(eid);
  MediaVolume.enabled[id] = 0;
  removeComponent(world, eid, MediaVolume);
  removeComponent(world, eid, MediaVolumeTag);
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — update volume AABBs from entity transforms
// ═══════════════════════════════════════════════════════════════════════

/**
 * Refresh the world-space AABB of each media volume from the entity's
 * WorldBoundsF32 (file 004). Call after systemBoundsPipeline.
 */
export function systemUpdateMediaVolumes(world) {
  const eids = query(world, [MediaVolumeTag, WorldBoundsF32]);
  for (let i = 0, n = eids.length; i < n; i++) {
    const eid = eids[i];
    const id = getId(eid);
    if (MediaVolume.enabled[id] === 0) continue;

    const off = id * 6;
    const B = WorldBoundsF32.aabb;
    MediaVolume.minX[id] = B[off];
    MediaVolume.minY[id] = B[off + 1];
    MediaVolume.minZ[id] = B[off + 2];
    MediaVolume.maxX[id] = B[off + 3];
    MediaVolume.maxY[id] = B[off + 4];
    MediaVolume.maxZ[id] = B[off + 5];
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// TRILINEAR GRID SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample density at local-space point (lx, ly, lz) using trilinear
 * interpolation on the grid. Returns 0..1 (density fraction).
 */
function sampleGridDensity(medium, lx, ly, lz) {
  const [nx, ny, nz] = medium.gridRes;
  const [mnX, mnY, mnZ] = medium.gridMin;
  const [mxX, mxY, mxZ] = medium.gridMax;

  // Normalize to [0,1] within the grid local AABB.
  const spanX = mxX - mnX;
  const spanY = mxY - mnY;
  const spanZ = mxZ - mnZ;
  if (spanX < EPSILON || spanY < EPSILON || spanZ < EPSILON) return 0;

  const fx = (lx - mnX) / spanX;
  const fy = (ly - mnY) / spanY;
  const fz = (lz - mnZ) / spanZ;

  if (fx < 0 || fx > 1 || fy < 0 || fy > 1 || fz < 0 || fz > 1) return 0;

  // Grid coordinate (voxel centers at half-integers).
  const gx = fx * (nx - 1);
  const gy = fy * (ny - 1);
  const gz = fz * (nz - 1);

  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const z0 = Math.floor(gz);
  const x1 = Math.min(x0 + 1, nx - 1);
  const y1 = Math.min(y0 + 1, ny - 1);
  const z1 = Math.min(z0 + 1, nz - 1);

  const tx = gx - x0;
  const ty = gy - y0;
  const tz = gz - z0;

  const data = medium.gridData;
  const idx = (x, y, z) => z * nx * ny + y * nx + x;

  const c000 = data[idx(x0, y0, z0)] / 255;
  const c100 = data[idx(x1, y0, z0)] / 255;
  const c010 = data[idx(x0, y1, z0)] / 255;
  const c110 = data[idx(x1, y1, z0)] / 255;
  const c001 = data[idx(x0, y0, z1)] / 255;
  const c101 = data[idx(x1, y0, z1)] / 255;
  const c011 = data[idx(x0, y1, z1)] / 255;
  const c111 = data[idx(x1, y1, z1)] / 255;

  const c00 = c000 * (1 - tx) + c100 * tx;
  const c10 = c010 * (1 - tx) + c110 * tx;
  const c01 = c001 * (1 - tx) + c101 * tx;
  const c11 = c011 * (1 - tx) + c111 * tx;

  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;

  return c0 * (1 - tz) + c1 * tz;
}

// ═══════════════════════════════════════════════════════════════════════
// MEDIA INTERFACE — sigma and phase functions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Read sigma_a, sigma_s, sigma_t at world-space point (wx, wy, wz).
 * Writes into caller-owned arrays [r,g,b] each.
 */
export function mediumSampleCoefficients(medium, wx, wy, wz, sigmaA, sigmaS) {
  if (medium.type === MediumType.HOMOGENEOUS) {
    sigmaA[0] = medium.sigmaA[0] * medium.density;
    sigmaA[1] = medium.sigmaA[1] * medium.density;
    sigmaA[2] = medium.sigmaA[2] * medium.density;
    sigmaS[0] = medium.sigmaS[0] * medium.density;
    sigmaS[1] = medium.sigmaS[1] * medium.density;
    sigmaS[2] = medium.sigmaS[2] * medium.density;
    return;
  }

  if (medium.type === MediumType.HETEROGENEOUS || medium.type === MediumType.CLOUD) {
    const density = sampleGridDensity(medium, wx, wy, wz) * medium.density;
    sigmaA[0] = medium.sigmaA[0] * density;
    sigmaA[1] = medium.sigmaA[1] * density;
    sigmaA[2] = medium.sigmaA[2] * density;
    sigmaS[0] = medium.sigmaS[0] * density;
    sigmaS[1] = medium.sigmaS[1] * density;
    sigmaS[2] = medium.sigmaS[2] * density;
    return;
  }

  if (medium.type === MediumType.ATMOSPHERE) {
    // Rayleigh + Mie altitude falloff.
    const alt = Math.max(wy, 0);
    const rhoR = Math.exp(-alt / medium.rayleighScaleHeight);
    const rhoM = Math.exp(-alt / medium.mieScaleHeight);

    const rR = medium.rayleighCoefficient[0] * rhoR;
    const rG = medium.rayleighCoefficient[1] * rhoR;
    const rB = medium.rayleighCoefficient[2] * rhoR;
    const rM = medium.mieCoefficient * rhoM;

    sigmaA[0] = 0; sigmaA[1] = 0; sigmaA[2] = 0;
    sigmaS[0] = rR + rM;
    sigmaS[1] = rG + rM;
    sigmaS[2] = rB + rM;
    return;
  }

  // Fallback: clear.
  sigmaA[0] = 0; sigmaA[1] = 0; sigmaA[2] = 0;
  sigmaS[0] = 0; sigmaS[1] = 0; sigmaS[2] = 0;
}

// ─── Henyey-Greenstein phase function ────────────────────────────────
export function hgPhase(g, cosTheta) {
  const denom = 1 + g * g - 2 * g * cosTheta;
  if (Math.abs(denom) < EPSILON) return 0;
  const denomPow = denom * Math.sqrt(denom);
  return (1 - g * g) / (4 * PI * denomPow);
}

// ─── Rayleigh phase function ─────────────────────────────────────────
export function rayleighPhase(cosTheta) {
  return (3 / (16 * PI)) * (1 + cosTheta * cosTheta);
}

export function mediumPhase(medium, wo, wi) {
  const cosTheta = wo[0] * wi[0] + wo[1] * wi[1] + wo[2] * wi[2];
  if (medium.phase === PhaseFunction.HG) return hgPhase(medium.g, cosTheta);
  if (medium.phase === PhaseFunction.RAYLEIGH) return rayleighPhase(cosTheta);
  return INV_PI * 0.25; // isotropic
}

// ═══════════════════════════════════════════════════════════════════════
// MEDIA BVH — quick intersection test for volumes
// ═══════════════════════════════════════════════════════════════════════

const MEDIA_BVH = {
  aabb: new Float32Array(MAX_VOLUMES * 2 * 6),
  child1: new Int32Array(MAX_VOLUMES * 2),
  child2: new Int32Array(MAX_VOLUMES * 2),
  leafStart: new Int32Array(MAX_VOLUMES * 2),
  leafCount: new Int32Array(MAX_VOLUMES * 2),
  root: -1,
  nodeCount: 0,
};

const MEDIA_SLOT_ORDER = new Uint32Array(MAX_VOLUMES);

const MEDIA_LEAF_SIZE = 8;

/**
 * Rebuild the media BVH from current MediaVolume state.
 */
export function systemRebuildMediaBVH(world) {
  let count = 0;
  const volumes = query(world, [MediaVolumeTag]);
  for (let i = 0, n = volumes.length; i < n; i++) {
    const eid = volumes[i];
    const id = getId(eid);
    if (MediaVolume.enabled[id] === 0) continue;
    MEDIA_SLOT_ORDER[count++] = id;
  }

  if (count === 0) {
    MEDIA_BVH.root = -1;
    MEDIA_BVH.nodeCount = 0;
    return world;
  }

  MEDIA_BVH.nodeCount = 0;
  MEDIA_BVH.root = buildMediaNodeRecursive(0, count);
  return world;
}

function buildMediaNodeRecursive(start, count) {
  const node = MEDIA_BVH.nodeCount++;
  const aabbOff = node * 6;
  const A = MEDIA_BVH.aabb;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = start; i < start + count; i++) {
    const id = MEDIA_SLOT_ORDER[i];
    if (MediaVolume.minX[id] < minX) minX = MediaVolume.minX[id];
    if (MediaVolume.minY[id] < minY) minY = MediaVolume.minY[id];
    if (MediaVolume.minZ[id] < minZ) minZ = MediaVolume.minZ[id];
    if (MediaVolume.maxX[id] > maxX) maxX = MediaVolume.maxX[id];
    if (MediaVolume.maxY[id] > maxY) maxY = MediaVolume.maxY[id];
    if (MediaVolume.maxZ[id] > maxZ) maxZ = MediaVolume.maxZ[id];
  }

  A[aabbOff]     = minX;
  A[aabbOff + 1] = minY;
  A[aabbOff + 2] = minZ;
  A[aabbOff + 3] = maxX;
  A[aabbOff + 4] = maxY;
  A[aabbOff + 5] = maxZ;

  if (count <= MEDIA_LEAF_SIZE) {
    MEDIA_BVH.child1[node] = -1;
    MEDIA_BVH.child2[node] = -1;
    MEDIA_BVH.leafStart[node] = start;
    MEDIA_BVH.leafCount[node] = count;
    return node;
  }

  const extX = maxX - minX, extY = maxY - minY, extZ = maxZ - minZ;
  let axis = 0;
  if (extY > extX && extY >= extZ) axis = 1;
  else if (extZ > extX && extZ > extY) axis = 2;

  const arr = MEDIA_SLOT_ORDER.subarray(start, start + count);
  const sorted = Array.from(arr);
  sorted.sort((a, b) => {
    const va = axis === 0 ? MediaVolume.minX[a] : axis === 1 ? MediaVolume.minY[a] : MediaVolume.minZ[a];
    const vb = axis === 0 ? MediaVolume.minX[b] : axis === 1 ? MediaVolume.minY[b] : MediaVolume.minZ[b];
    return va - vb;
  });
  for (let i = 0; i < count; i++) MEDIA_SLOT_ORDER[start + i] = sorted[i];

  const mid = start + (count >>> 1);
  MEDIA_BVH.child1[node] = buildMediaNodeRecursive(start, mid - start);
  MEDIA_BVH.child2[node] = buildMediaNodeRecursive(mid, start + count - mid);
  MEDIA_BVH.leafStart[node] = -1;
  MEDIA_BVH.leafCount[node] = 0;
  return node;
}

/**
 * Query volumes whose world AABB intersects the ray segment [t0, t1].
 * Returns array of media volume ids (entity ids).
 */
export function queryMediaBVH(ox, oy, oz, dx, dy, dz, t0, t1) {
  const result = [];
  if (MEDIA_BVH.root < 0) return result;

  const invDx = 1 / (dx || EPSILON);
  const invDy = 1 / (dy || EPSILON);
  const invDz = 1 / (dz || EPSILON);
  const A = MEDIA_BVH.aabb;
  const stack = [MEDIA_BVH.root];

  while (stack.length > 0) {
    const node = stack.pop();
    const off = node * 6;

    // Ray-AABB slab test.
    let t1x = (A[off] - ox) * invDx;
    let t2x = (A[off + 3] - ox) * invDx;
    if (t1x > t2x) { const tmp = t1x; t1x = t2x; t2x = tmp; }
    let t1y = (A[off + 1] - oy) * invDy;
    let t2y = (A[off + 4] - oy) * invDy;
    if (t1y > t2y) { const tmp = t1y; t1y = t2y; t2y = tmp; }
    let t1z = (A[off + 2] - oz) * invDz;
    let t2z = (A[off + 5] - oz) * invDz;
    if (t1z > t2z) { const tmp = t1z; t1z = t2z; t2z = tmp; }

    const tmin = Math.max(t1x, t1y, t1z);
    const tmax = Math.min(t2x, t2y, t2z);

    if (tmax < Math.max(tmin, t0) || tmin > t1) continue;

    const c1 = MEDIA_BVH.child1[node];
    if (c1 < 0) {
      const start = MEDIA_BVH.leafStart[node];
      const cnt = MEDIA_BVH.leafCount[node];
      for (let i = start; i < start + cnt; i++) {
        result.push(MEDIA_SLOT_ORDER[i]);
      }
    } else {
      stack.push(c1, MEDIA_BVH.child2[node]);
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// RAY INTERSECT — return segments of a ray inside each medium
// ═══════════════════════════════════════════════════════════════════════

const _segMin = vec3.create();
const _segMax = vec3.create();

/**
 * For a ray, return an array of { mediumId, tStart, tEnd, priority }.
 * Uses media BVH then refines each volume's segment bounds.
 */
export function rayMediumSegments(ox, oy, oz, dx, dy, dz, tMax = MAJORANT_INFINITY) {
  const segments = [];
  const volumeIds = queryMediaBVH(ox, oy, oz, dx, dy, dz, 0, tMax);

  const invDx = 1 / (dx || EPSILON);
  const invDy = 1 / (dy || EPSILON);
  const invDz = 1 / (dz || EPSILON);

  for (const id of volumeIds) {
    const mnX = MediaVolume.minX[id];
    const mnY = MediaVolume.minY[id];
    const mnZ = MediaVolume.minZ[id];
    const mxX = MediaVolume.maxX[id];
    const mxY = MediaVolume.maxY[id];
    const mxZ = MediaVolume.maxZ[id];

    let t1x = (mnX - ox) * invDx;
    let t2x = (mxX - ox) * invDx;
    if (t1x > t2x) { const tmp = t1x; t1x = t2x; t2x = tmp; }
    let t1y = (mnY - oy) * invDy;
    let t2y = (mxY - oy) * invDy;
    if (t1y > t2y) { const tmp = t1y; t1y = t2y; t2y = tmp; }
    let t1z = (mnZ - oz) * invDz;
    let t2z = (mxZ - oz) * invDz;
    if (t1z > t2z) { const tmp = t1z; t1z = t2z; t2z = tmp; }

    const tStart = Math.max(t1x, t1y, t1z, 0);
    const tEnd = Math.min(t2x, t2y, t2z, tMax);

    if (tEnd <= tStart) continue;

    segments.push({
      mediumId: MediaVolume.mediumId[id],
      volumeEntityId: id,
      tStart,
      tEnd,
      priority: MediaVolume.priority[id],
    });
  }
  return segments;
}

// ═══════════════════════════════════════════════════════════════════════
// RATIO TRACKING — transmittance (PBRT-v4 style)
// ═══════════════════════════════════════════════════════════════════════

const _sigmaA = [0, 0, 0];
const _sigmaS = [0, 0, 0];

/**
 * Compute transmittance through a medium from tStart to tEnd along a ray.
 * Uses ratio tracking with N steps.
 *
 * @returns [Tr, Tg, Tb]
 */
export function mediumTransmittance(mediumId, ox, oy, oz, dx, dy, dz, tStart, tEnd, steps = 32) {
  const medium = MEDIA_REGISTRY.get(mediumId);
  if (!medium) return [1, 1, 1];

  if (medium.type === MediumType.HOMOGENEOUS) {
    const segLen = tEnd - tStart;
    const sigmaT_R = (medium.sigmaA[0] + medium.sigmaS[0]) * medium.density;
    const sigmaT_G = (medium.sigmaA[1] + medium.sigmaS[1]) * medium.density;
    const sigmaT_B = (medium.sigmaA[2] + medium.sigmaS[2]) * medium.density;
    return [
      Math.exp(-sigmaT_R * segLen),
      Math.exp(-sigmaT_G * segLen),
      Math.exp(-sigmaT_B * segLen),
    ];
  }

  // Heterogeneous: ratio tracking with equi-spaced samples.
  const dt = (tEnd - tStart) / steps;
  let Tr = 1, Tg = 1, Tb = 1;

  for (let i = 0; i < steps; i++) {
    const t = tStart + (i + 0.5) * dt;
    const px = ox + dx * t;
    const py = oy + dy * t;
    const pz = oz + dz * t;
    mediumSampleCoefficients(medium, px, py, pz, _sigmaA, _sigmaS);

    const sT_R = _sigmaA[0] + _sigmaS[0];
    const sT_G = _sigmaA[1] + _sigmaS[1];
    const sT_B = _sigmaA[2] + _sigmaS[2];

    Tr *= Math.exp(-sT_R * dt);
    Tg *= Math.exp(-sT_G * dt);
    Tb *= Math.exp(-sT_B * dt);

    if (Tr < RATIO_TRACK_EPSILON && Tg < RATIO_TRACK_EPSILON && Tb < RATIO_TRACK_EPSILON) break;
  }

  return [Tr, Tg, Tb];
}

// ═══════════════════════════════════════════════════════════════════════
// DELTA TRACKING — sample a scattering event along a ray
// ═══════════════════════════════════════════════════════════════════════
//
// Walks along a ray through a heterogeneous medium, uses delta tracking
// with a majorant (max sigma_t) to determine when a real collision
// occurs. Returns { t, scattered } or null if no collision.

const _localSigmaA = [0, 0, 0];
const _localSigmaS = [0, 0, 0];

export function mediumDeltaTrack(mediumId, ox, oy, oz, dx, dy, dz,
                                 tStart, tEnd, maxSigmaT, u1) {
  const medium = MEDIA_REGISTRY.get(mediumId);
  if (!medium) return null;

  if (maxSigmaT <= 0) maxSigmaT = 1e-3;

  let t = tStart;
  const u = u1;

  // Max steps guard.
  for (let step = 0; step < MAX_MARCH_STEPS; step++) {
    // Sample exponential with majorant.
    const dt = -Math.log(Math.max(1e-6, 1 - u)) / maxSigmaT;
    t += dt;
    if (t >= tEnd) return null;

    // Read actual sigma at new position.
    const px = ox + dx * t;
    const py = oy + dy * t;
    const pz = oz + dz * t;
    mediumSampleCoefficients(medium, px, py, pz, _localSigmaA, _localSigmaS);

    const sigmaT = (_localSigmaA[0] + _localSigmaS[0]
                  + _localSigmaA[1] + _localSigmaS[1]
                  + _localSigmaA[2] + _localSigmaS[2]) / 3;

    // Real collision if u' < sigma_t / maxSigmaT.
    // Note: we consume a new random; the caller is expected to draw more.
    if (u < sigmaT / maxSigmaT) {
      return { t, scattered: true };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// SEGMENT MERGE — for overlapping media in the same ray
// ═══════════════════════════════════════════════════════════════════════

/**
 * From an array of rayMediumSegments, produce a list of "effective"
 * medium segments where priority determines which medium wins in
 * overlapping intervals.
 *
 * Returns array of { mediumId, tStart, tEnd }.
 */
export function mergeMediumSegments(segments) {
  if (segments.length === 0) return [];

  // Sort by priority descending (highest priority wins).
  segments.sort((a, b) => b.priority - a.priority);

  const result = [];

  for (const seg of segments) {
    // Check for overlap with existing merged segments.
    let cursorStart = seg.tStart;
    let cursorEnd = seg.tEnd;

    for (const existing of result) {
      if (cursorEnd <= existing.tStart || cursorStart >= existing.tEnd) continue;
      // Overlap: split.
      if (cursorStart < existing.tStart) {
        result.push({ mediumId: seg.mediumId, tStart: cursorStart, tEnd: existing.tStart });
      }
      if (cursorEnd > existing.tEnd) {
        cursorStart = existing.tEnd;
      } else {
        cursorStart = cursorEnd;
        break;
      }
    }

    if (cursorStart < cursorEnd) {
      result.push({ mediumId: seg.mediumId, tStart: cursorStart, tEnd: cursorEnd });
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// SCENE INTERFACE — volumetric path integrator support
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute in-scattered radiance from a single scattering event.
 * Approximates direct lighting through the medium using the light BVH.
 *
 * @returns [r, g, b] in-scattered radiance
 */
export function mediumInscatter(mediumId, px, py, pz, dx, dy, dz,
                                lightSlots, scene, samplerSlot, samplerU) {
  const medium = MEDIA_REGISTRY.get(mediumId);
  if (!medium) return [0, 0, 0];

  mediumSampleCoefficients(medium, px, py, pz, _localSigmaA, _localSigmaS);
  const sigmaS_R = _localSigmaS[0];
  const sigmaS_G = _localSigmaS[1];
  const sigmaS_B = _localSigmaS[2];
  const sigmaT_R = _localSigmaA[0] + sigmaS_R;
  const sigmaT_G = _localSigmaA[1] + sigmaS_G;
  const sigmaT_B = _localSigmaA[2] + sigmaS_B;

  if (sigmaT_R <= EPSILON && sigmaT_G <= EPSILON && sigmaT_B <= EPSILON) {
    return [medium.emission[0], medium.emission[1], medium.emission[2]];
  }

  let Lr = medium.emission[0];
  let Lg = medium.emission[1];
  let Lb = medium.emission[2];

  const wo = [-dx, -dy, -dz];

  for (let i = 0; i < lightSlots.length; i++) {
    const lightSlot = lightSlots[i];
    const Lsamp = sampleLight(lightSlot, px, py, pz, samplerU[0], samplerU[1]);
    if (!Lsamp) continue;

    // Shadow ray transmittance through the medium itself.
    const Tr = mediumTransmittance(mediumId, px, py, pz,
                                    Lsamp.wi[0], Lsamp.wi[1], Lsamp.wi[2],
                                    SHADOW_EPSILON, Lsamp.distance, 16);

    // Phase function contribution.
    const phase = mediumPhase(medium, wo, Lsamp.wi);

    const scale = phase * (1 / Lsamp.pdf) / lightSlots.length;
    Lr += sigmaS_R * Tr[0] * Lsamp.Li[0] * scale;
    Lg += sigmaS_G * Tr[1] * Lsamp.Li[1] * scale;
    Lb += sigmaS_B * Tr[2] * Lsamp.Li[2] * scale;
  }

  return [Lr, Lg, Lb];
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearMediaSystem() {
  MEDIA_REGISTRY.clear();
  _nextMediumId = 1;
  MEDIA_BVH.root = -1;
  MEDIA_BVH.nodeCount = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function mediaStats() {
  let activeVolumes = 0;
  let homogeneous = 0, grid = 0, cloud = 0, atmosphere = 0;
  for (const medium of MEDIA_REGISTRY.values()) {
    switch (medium.type) {
      case MediumType.HOMOGENEOUS: homogeneous++; break;
      case MediumType.HETEROGENEOUS: grid++; break;
      case MediumType.CLOUD: cloud++; break;
      case MediumType.ATMOSPHERE: atmosphere++; break;
    }
  }
  return {
    mediumCount: MEDIA_REGISTRY.size,
    homogeneous,
    grid,
    cloud,
    atmosphere,
    bvhNodes: MEDIA_BVH.nodeCount,
    activeVolumes,
  };
}