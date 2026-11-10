// file number : 006
// full path name : src/render/006_render_pipeline.js
// description : Render pipeline layer inspired by PBRT-v4 integrator/film
//               architecture. Provides RenderPassF32 components (OPAQUE,
//               TRANSPARENT, SHADOW, DEPTH_PREPASS, DEFERRED_GEO,
//               DEFERRED_LIGHT, POST), a SoA camera registry supporting both
//               perspective and orthographic projections, a dynamic LOD
//               component set (LODGroupF32, LODStateF32) with a
//               frame-budget-driven systemSelectLOD that reads file 004's
//               WorldBoundsF32 for accurate distance and writes file 005's
//               GeometryRef in place, and a RenderTarget pool for allocating
//               offscreen buffers without GC churn. Enables smooth small-to-
//               galactic-scale transitions on Android 64-bit.
// best for : Multi-pass rendering, distance-based LOD selection for 1M+
//            entities, frame-budget-aware quality scaling, deferred and
//            forward renderers, shadow map allocation, and any scene that
//            must smoothly transition from close-up to planetary/galactic
//            scale on mobile.
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
  getWorldBoundsCenter,
} from '../geometry/004_aabb_bounds.js';

import {
  GeometryRef,
  MaterialRef,
  Visibility,
  RenderableTag,
  GEOMETRY_REGISTRY,
  MATERIAL_REGISTRY,
  retainGeometry,
  releaseGeometry,
  INSTANCED_BUCKETS,
} from './005_mesh_components.js';

import {
  THREE,
  vec3,
  mat4,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// PASS TYPES — bit flags, one entity can belong to several passes
// ═══════════════════════════════════════════════════════════════════════

export const PassType = Object.freeze({
  OPAQUE:         1 << 0,
  TRANSPARENT:    1 << 1,
  SHADOW_CASTER:  1 << 2,
  DEPTH_PREPASS:  1 << 3,
  DEFERRED_GEO:   1 << 4,
  DEFERRED_LIGHT: 1 << 5,
  POST_PROCESS:   1 << 6,
});

export const PassOrder = Object.freeze([
  PassType.SHADOW_CASTER,
  PassType.DEPTH_PREPASS,
  PassType.DEFERRED_GEO,
  PassType.DEFERRED_LIGHT,
  PassType.OPAQUE,
  PassType.TRANSPARENT,
  PassType.POST_PROCESS,
]);

// ═══════════════════════════════════════════════════════════════════════
// SoA COMPONENTS
// ═══════════════════════════════════════════════════════════════════════

/** Per-entity pass membership bitmask. */
export const RenderPass = {
  mask: new Uint32Array(1_000_000),
};

/** Optional per-entity material preset (affects which pass gets it). */
export const MaterialClass = {
  classId: new Uint8Array(1_000_000), // 0=default, 1=transparent, 2=emissive, 3=unlit
};

/** Depth bias in world units (for z-fighting control). */
export const DepthBias = {
  bias: new Float32Array(1_000_000),
};

// ═══════════════════════════════════════════════════════════════════════
// CAMERA COMPONENTS — SoA, supports both perspective and orthographic
// ═══════════════════════════════════════════════════════════════════════

/**
 * Per-camera SoA state. Cameras are also entities (add CameraTag).
 * Layout matches PBRT-v4 Camera: transform, projection, film.
 */
export const CameraF32 = {
  // World position of camera.
  px: new Float32Array(64),
  py: new Float32Array(64),
  pz: new Float32Array(64),

  // View matrix (world → camera), column-major.
  view: new Float32Array(64 * 16),

  // Projection matrix (camera → clip), column-major.
  proj: new Float32Array(64 * 16),

  // Cached proj × view.
  projView: new Float32Array(64 * 16),

  // Projection parameters.
  fov: new Float32Array(64),           // radians, perspective
  aspect: new Float32Array(64),
  near: new Float32Array(64),
  far: new Float32Array(64),
  orthoSize: new Float32Array(64),     // half-height for orthographic

  // Projection mode: 0 = perspective, 1 = orthographic.
  mode: new Uint8Array(64),

  // Cached frustum planes (6 × 4 floats per camera).
  frustum: new Float32Array(64 * 24),

  // Whether projView has changed since last frame.
  dirty: new Uint8Array(64),
};

/** Marker: entity is a camera. */
export const CameraTag = {};

/** Active camera (0 or -1). */
export let ACTIVE_CAMERA_SLOT = -1;
export function setActiveCameraSlot(slot) { ACTIVE_CAMERA_SLOT = slot; }
export function getActiveCameraSlot() { return ACTIVE_CAMERA_SLOT; }

// ═══════════════════════════════════════════════════════════════════════
// RENDER TARGET POOL (PBRT-v4 Film equivalent)
// ═══════════════════════════════════════════════════════════════════════

/**
 * RenderTarget descriptors. Shared across many entities that need
 * offscreen rendering (e.g. shadow maps, reflection probes, minimap).
 */
export const RENDER_TARGETS = new Map(); // id -> { rt, refCount, w, h, fmt }

let _nextRenderTargetId = 1;

export function acquireRenderTarget({ width, height, format = THREE.RGBAFormat, type = THREE.UnsignedByteType, depth = true }) {
  // Look for existing target with matching size/format.
  for (const [id, entry] of RENDER_TARGETS) {
    if (entry.w === width && entry.h === height && entry.fmt === format && entry.depth === depth) {
      entry.refCount++;
      return id;
    }
  }
  const rt = new THREE.WebGLRenderTarget(width, height, {
    format,
    type,
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  const id = _nextRenderTargetId++;
  RENDER_TARGETS.set(id, { rt, refCount: 1, w: width, h: height, fmt: format, depth });
  return id;
}

export function releaseRenderTarget(id) {
  const entry = RENDER_TARGETS.get(id);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount > 0) return;
  entry.rt.dispose();
  RENDER_TARGETS.delete(id);
}

export function clearRenderTargets() {
  for (const entry of RENDER_TARGETS.values()) entry.rt.dispose();
  RENDER_TARGETS.clear();
}

// ═══════════════════════════════════════════════════════════════════════
// LOD COMPONENTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * LOD group: per-entity array of up to 4 geometry IDs with distances.
 * The right level is chosen by systemSelectLOD based on camera distance
 * to the entity's WorldBoundsF32 center.
 *
 * Level 0 = closest, level N = farthest (usually a billboard).
 */
export const LODGroupF32 = {
  // 4 levels × (geometryId) — 0 means no geometry for that level.
  geoId: new Uint32Array(4 * 1_000_000),

  // 4 levels × (distance threshold in world units, 0 = unused).
  dist: new Float32Array(4 * 1_000_000),

  // Number of active levels (1..4).
  levelCount: new Uint8Array(1_000_000),
};

/**
 * LOD runtime state: which level was selected last frame, current distance.
 */
export const LODStateF32 = {
  currentLevel: new Uint8Array(1_000_000),
  distance: new Float32Array(1_000_000),
  // Screen-space size approximation (for future LOD bias).
  screenSize: new Float32Array(1_000_000),
};

/**
 * LOD bias multiplier per entity (context-aware). Larger = prefer higher LOD.
 * Set by systemAdaptiveLOD based on GPU pressure.
 */
export const LODBiasF32 = {
  bias: new Float32Array(1_000_000),
};

/** Marker: entity participates in LOD selection. */
export const LODTag = {};

// ═══════════════════════════════════════════════════════════════════════
// LOD API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Attach LOD groups to an entity.
 *
 * @param levels  array of { geometryId, distance } — MUST be sorted
 *                ascending by distance. Level 0 = nearest.
 */
export function addLODGroup(world, eid, levels) {
  if (levels.length === 0 || levels.length > 4) {
    throw new Error('addLODGroup: levels must be 1..4 entries');
  }
  addComponent(world, eid, LODGroupF32);
  addComponent(world, eid, LODStateF32);
  addComponent(world, eid, LODBiasF32);
  addComponent(world, eid, LODTag);

  const id = getId(eid);
  const base = id * 4;

  for (let i = 0; i < 4; i++) {
    if (i < levels.length) {
      LODGroupF32.geoId[base + i] = levels[i].geometryId;
      LODGroupF32.dist[base + i] = levels[i].distance;
    } else {
      LODGroupF32.geoId[base + i] = 0;
      LODGroupF32.dist[base + i] = 0;
    }
  }
  LODGroupF32.levelCount[id] = levels.length;
  LODStateF32.currentLevel[id] = 0;
  LODBiasF32.bias[id] = 1.0;
  return eid;
}

export function setLODBias(world, eid, bias) {
  LODBiasF32.bias[getId(eid)] = bias;
}

// ═══════════════════════════════════════════════════════════════════════
// CAMERA API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a perspective camera entity.
 * `transformEid` must already have WorldTransformF32 (file 002) so the
 * camera transform tracks the entity.
 */
export function addPerspectiveCamera(world, eid, {
  fov = Math.PI / 3,
  aspect = 16 / 9,
  near = 0.1,
  far = 1000,
  slot = -1,
} = {}) {
  addComponent(world, eid, CameraTag);
  // Camera components don't need per-entity bitflags — they use SoA slots.
  // Slot 0 is reserved for the default camera; user picks slot >= 0.
  const s = slot >= 0 ? slot : findFreeCameraSlot();
  CameraF32.mode[s] = 0;
  CameraF32.fov[s] = fov;
  CameraF32.aspect[s] = aspect;
  CameraF32.near[s] = near;
  CameraF32.far[s] = far;
  CameraF32.orthoSize[s] = 0;
  CameraF32.dirty[s] = 1;
  // Store slot in the entity's bitmask data via a small registry.
  _cameraSlotByEid.set(eid, s);
  return s;
}

export function addOrthographicCamera(world, eid, {
  orthoSize = 10,
  aspect = 16 / 9,
  near = 0.1,
  far = 1000,
  slot = -1,
} = {}) {
  addComponent(world, eid, CameraTag);
  const s = slot >= 0 ? slot : findFreeCameraSlot();
  CameraF32.mode[s] = 1;
  CameraF32.orthoSize[s] = orthoSize;
  CameraF32.aspect[s] = aspect;
  CameraF32.near[s] = near;
  CameraF32.far[s] = far;
  CameraF32.dirty[s] = 1;
  _cameraSlotByEid.set(eid, s);
  return s;
}

const _cameraSlotByEid = new Map();

function findFreeCameraSlot() {
  const used = new Set(_cameraSlotByEid.values());
  for (let i = 0; i < 64; i++) if (!used.has(i)) return i;
  throw new Error('camera slot limit (64) reached');
}

export function getCameraSlot(world, eid) {
  return _cameraSlotByEid.get(eid);
}

/**
 * Recompute projView from camera parameters + WorldTransformF32.
 * Called by systemUpdateCameras for each dirty camera.
 */
export function updateCameraProjection(world, eid) {
  const s = _cameraSlotByEid.get(eid);
  if (s === undefined) return;

  const id = getId(eid);
  const M = WorldTransformF32.m;
  const off = id * 16;

  // Extract camera position.
  CameraF32.px[s] = M[off + 12];
  CameraF32.py[s] = M[off + 13];
  CameraF32.pz[s] = M[off + 14];

  // Extract view matrix = inverse(worldTransform).
  // We avoid full mat4.invert by using the fact that camera world transform
  // is orthonormal in the rotation part. For simplicity in this layer,
  // we use Three.js Matrix4.invert via a temporary.
  const tmpMat = mat4.create();
  // Copy world matrix into tmpMat.
  for (let i = 0; i < 16; i++) tmpMat[i] = M[off + i];
  mat4.invert(tmpMat, tmpMat);

  // Store view matrix.
  const viewOff = s * 16;
  for (let i = 0; i < 16; i++) CameraF32.view[viewOff + i] = tmpMat[i];

  // Build projection.
  const proj = CameraF32.proj;
  if (CameraF32.mode[s] === 0) {
    // Perspective.
    const fov = CameraF32.fov[s];
    const aspect = CameraF32.aspect[s];
    const near = CameraF32.near[s];
    const far = CameraF32.far[s];
    const f = 1 / Math.tan(fov * 0.5);
    proj[viewOff + 0]  = f / aspect;
    proj[viewOff + 1]  = 0;
    proj[viewOff + 2]  = 0;
    proj[viewOff + 3]  = 0;
    proj[viewOff + 4]  = 0;
    proj[viewOff + 5]  = f;
    proj[viewOff + 6]  = 0;
    proj[viewOff + 7]  = 0;
    proj[viewOff + 8]  = 0;
    proj[viewOff + 9]  = 0;
    proj[viewOff + 10] = (far + near) / (near - far);
    proj[viewOff + 11] = -1;
    proj[viewOff + 12] = 0;
    proj[viewOff + 13] = 0;
    proj[viewOff + 14] = (2 * far * near) / (near - far);
    proj[viewOff + 15] = 0;
  } else {
    // Orthographic.
    const h = CameraF32.orthoSize[s];
    const w = h * CameraF32.aspect[s];
    const near = CameraF32.near[s];
    const far = CameraF32.far[s];
    proj[viewOff + 0]  = 1 / w;
    proj[viewOff + 5]  = 1 / h;
    proj[viewOff + 10] = -2 / (far - near);
    proj[viewOff + 14] = -(far + near) / (far - near);
    proj[viewOff + 15] = 1;
  }

  // projView = proj * view.
  const pv = CameraF32.projView;
  const view = CameraF32.view;
  // Simple 4x4 multiply (column-major).
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      pv[viewOff + j * 4 + i] =
        proj[viewOff + 0 * 4 + i] * view[viewOff + j * 4 + 0] +
        proj[viewOff + 1 * 4 + i] * view[viewOff + j * 4 + 1] +
        proj[viewOff + 2 * 4 + i] * view[viewOff + j * 4 + 2] +
        proj[viewOff + 3 * 4 + i] * view[viewOff + j * 4 + 3];
    }
  }

  CameraF32.dirty[s] = 0;
}

export function systemUpdateCameras(world) {
  for (const [eid, slot] of _cameraSlotByEid) {
    if (!entityExists(world, eid)) continue;
    if (CameraF32.dirty[slot]) {
      updateCameraProjection(world, eid);
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — LOD SELECTION (context-aware, frame-budget driven)
// ═══════════════════════════════════════════════════════════════════════
//
// Runs once per frame. Computes squared distance from camera to each
// entity's WorldBoundsF32 center, selects the highest-detail geometry
// whose distance threshold is met (and whose bias-adjusted distance
// still fits), and updates GeometryRef.
//
// `biasScale` is a global multiplier from systemAdaptiveQuality: at low
// FPS, biasScale > 1 (prefer cheaper LODs); at high FPS, biasScale < 1
// (prefer higher quality).

const _center = vec3.create();
const _camPos = vec3.create();

/**
 * @param world        ECS world
 * @param cameraSlot   slot id from addPerspectiveCamera/addOrthographicCamera
 * @param biasScale    global LOD bias multiplier (1 = default)
 * @param opts         { maxLODSwaps = Infinity } throttle swaps per frame
 */
export function systemSelectLOD(world, cameraSlot, biasScale = 1, opts = {}) {
  const maxSwaps = opts.maxLODSwaps ?? Infinity;

  const camX = CameraF32.px[cameraSlot];
  const camY = CameraF32.py[cameraSlot];
  const camZ = CameraF32.pz[cameraSlot];
  _camPos[0] = camX; _camPos[1] = camY; _camPos[2] = camZ;

  const eids = query(world, [LODTag, WorldBoundsF32]);
  let swaps = 0;

  for (let i = 0, n = eids.length; i < n; i++) {
    const eid = eids[i];
    const id = getId(eid);
    const base = id * 4;

    // Distance to bounds center — use squared distance to avoid sqrt.
    getWorldBoundsCenter(eid, _center);
    const dx = _center[0] - camX;
    const dy = _center[1] - camY;
    const dz = _center[2] - camZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    const dist = Math.sqrt(distSq);
    LODStateF32.distance[id] = dist;

    // Apply per-entity bias and global scale.
    const effectiveDist = dist / (LODBiasF32.bias[id] * biasScale);

    // Walk levels from furthest to nearest; pick the first whose threshold
    // is greater than effectiveDist. Level 0 is the highest-detail fallback.
    const levelCount = LODGroupF32.levelCount[id];
    let selected = 0;
    for (let l = levelCount - 1; l >= 1; l--) {
      if (effectiveDist >= LODGroupF32.dist[base + l]) {
        selected = l;
        break;
      }
    }

    const prevLevel = LODStateF32.currentLevel[id];
    if (selected === prevLevel) continue;
    if (swaps >= maxSwaps) break;

    // Swap geometry in GeometryRef, retain new, release old.
    const newGeoId = LODGroupF32.geoId[base + selected];
    const oldGeoId = GeometryRef.id[id];
    if (newGeoId === oldGeoId) {
      LODStateF32.currentLevel[id] = selected;
      continue;
    }

    if (newGeoId) retainGeometry(newGeoId);
    if (oldGeoId) releaseGeometry(oldGeoId);

    GeometryRef.id[id] = newGeoId;
    LODStateF32.currentLevel[id] = selected;
    swaps++;
  }

  return { swaps };
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — ADAPTIVE QUALITY (context-aware LOD bias from frame budget)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Global LOD bias multiplier, adjusted based on target vs actual FPS.
 * At sustained low FPS, biasScale grows above 1 → distant entities
 * switch to cheaper LODs. At high FPS, it shrinks toward 1 → detail
 * returns. The multiplier is smoothed to avoid oscillation.
 */
export const QUALITY_STATE = {
  targetFPS: 60,
  actualFPS: 60,
  biasScale: 1.0,
  minBias: 0.5,
  maxBias: 4.0,
  smoothing: 0.1,
};

export function systemAdaptiveQuality(dt) {
  const actual = 1 / Math.max(dt, 1e-6);
  QUALITY_STATE.actualFPS = actual * QUALITY_STATE.smoothing +
                            QUALITY_STATE.actualFPS * (1 - QUALITY_STATE.smoothing);

  const ratio = QUALITY_STATE.actualFPS / QUALITY_STATE.targetFPS;
  let target;
  if (ratio < 0.9) {
    // Below target: increase bias (prefer cheaper LODs).
    target = 1 + (1 - ratio) * 2;
  } else if (ratio > 1.1) {
    // Above target: reduce bias (prefer detail).
    target = 1 - (ratio - 1) * 0.5;
  } else {
    target = QUALITY_STATE.biasScale;
  }
  target = Math.max(QUALITY_STATE.minBias, Math.min(QUALITY_STATE.maxBias, target));
  QUALITY_STATE.biasScale +=
    (target - QUALITY_STATE.biasScale) * QUALITY_STATE.smoothing;
  return QUALITY_STATE;
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — PASS SORTING (PBRT-v4 integrator dispatch)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sort entities into render passes:
 *   - OPAQUE:            front-to-back for early-z
 *   - TRANSPARENT:       back-to-front for alpha blending
 *   - SHADOW_CASTER:     any order, but only objects flagged as casters
 *   - DEPTH_PREPASS:     front-to-back
 *   - DEFERRED_GEO:      front-to-back
 *   - DEFERRED_LIGHT:    light entities (handled separately)
 *   - POST_PROCESS:      screen-space entities
 *
 * Returns a per-pass array of entity IDs, ready for the renderer to iterate.
 * Sorting is stable; only the TRANSPARENT list is fully sorted (back-to-front).
 */
export function systemSortRenderPasses(world, cameraSlot) {
  const camX = CameraF32.px[cameraSlot];
  const camY = CameraF32.py[cameraSlot];
  const camZ = CameraF32.pz[cameraSlot];

  const result = {
    [PassType.OPAQUE]: [],
    [PassType.TRANSPARENT]: [],
    [PassType.SHADOW_CASTER]: [],
    [PassType.DEPTH_PREPASS]: [],
    [PassType.DEFERRED_GEO]: [],
    [PassType.DEFERRED_LIGHT]: [],
    [PassType.POST_PROCESS]: [],
  };

  const eids = query(world, [RenderableTag, RenderPass]);
  const distByEid = new Float32Array(eids.length);

  for (let i = 0, n = eids.length; i < n; i++) {
    const eid = eids[i];
    const id = getId(eid);
    const mask = RenderPass.mask[id];
    if (!mask) continue;

    // Skip entities not visible this frame (file 005 set bit 0).
    if ((Visibility.flags[id] & 1) === 0) continue;

    getWorldBoundsCenter(eid, _center);
    const dx = _center[0] - camX;
    const dy = _center[1] - camY;
    const dz = _center[2] - camZ;
    distByEid[i] = dx * dx + dy * dy + dz * dz;

    for (const pass of PassOrder) {
      if (mask & pass) result[pass].push(eid);
    }
  }

  // Sort OPAQUE / DEPTH_PREPASS / DEFERRED_GEO front-to-back.
  const sortFrontToBack = (a, b) => {
    const ia = eids.indexOf(a); // O(n) — replace with map for production
    const ib = eids.indexOf(b);
    return distByEid[ia] - distByEid[ib];
  };

  // For real 1M-scale, build a Map<eid, dist> once and use it.
  const distMap = new Map();
  for (let i = 0, n = eids.length; i < n; i++) {
    distMap.set(eids[i], distByEid[i]);
  }

  const frontToBack = (a, b) => (distMap.get(a) ?? Infinity) - (distMap.get(b) ?? Infinity);
  const backToFront = (a, b) => (distMap.get(b) ?? Infinity) - (distMap.get(a) ?? Infinity);

  result[PassType.OPAQUE].sort(frontToBack);
  result[PassType.TRANSPARENT].sort(backToFront);
  result[PassType.SHADOW_CASTER].sort(frontToBack);
  result[PassType.DEPTH_PREPASS].sort(frontToBack);
  result[PassType.DEFERRED_GEO].sort(frontToBack);

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// ECS INTEGRATION HELPERS
// ═══════════════════════════════════════════════════════════════════════

export function addRenderPass(world, eid, passMask) {
  addComponent(world, eid, RenderPass);
  const id = getId(eid);
  RenderPass.mask[id] |= passMask;
}

export function removeRenderPass(world, eid, passMask) {
  const id = getId(eid);
  RenderPass.mask[id] &= ~passMask;
}

export function setRenderPassMask(world, eid, mask) {
  const id = getId(eid);
  RenderPass.mask[id] = mask;
}

export function getRenderPassMask(world, eid) {
  return RenderPass.mask[getId(eid)];
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function pipelineStats() {
  let opaque = 0, transparent = 0, shadow = 0, lodCount = 0;
  const ctx = null; // not used here
  // Approximate counts from RenderPass mask.
  // (Full stats available via systemSortRenderPasses output.)
  return {
    renderTargetCount: RENDER_TARGETS.size,
    cameraCount: _cameraSlotByEid.size,
    activeCameraSlot: ACTIVE_CAMERA_SLOT,
    qualityBias: QUALITY_STATE.biasScale,
    actualFPS: QUALITY_STATE.actualFPS,
  };
}