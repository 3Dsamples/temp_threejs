// file number : 005
// full path name : src/render/005_mesh_components.js
// description : SoA mesh components bridging ECS entities to Three.js
//               renderables. Provides GeometryRefF32 / MaterialRefF32 /
//               VisibilityF32 / LayerF32 stores, a geometry+material
//               registry built on 000_math_links.DynamicPool, and
//               systemSyncMeshes which reads file 003's frustum cull +
//               file 004's WorldBoundsF32 to toggle Three.js visibility
//               without traversing the scene graph. Meshes themselves are
//               recycled from file 000's poolMesh so 1M-entity scenes do
//               not churn Object3D allocations.
// best for : High-density instanced rendering, culling-driven visibility,
//            material/geometry deduplication, and any scene where 1M+
//            entities must map to a bounded number of actual Three.js
//            draw calls.
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
  bvhFrustumCull,
  extractFrustumPlanes,
} from '../spatial/003_bvh_broadphase.js';

import {
  WorldBoundsF32,
  LocalBoundsF32,
  BoundsTag,
} from '../geometry/004_aabb_bounds.js';

import {
  THREE,
  poolMesh,
  poolGeometry,
  poolMaterial,
  mat4,
  vec3,
  quat,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// SoA COMPONENTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Per-entity geometry handle. `id` indexes into GEOMETRY_REGISTRY.
 * 0 = none. Values are UInt32.
 */
export const GeometryRef = {
  id: new Uint32Array(1_000_000),
};

/**
 * Per-entity material handle. `id` indexes into MATERIAL_REGISTRY.
 * 0 = none. Values are UInt32.
 */
export const MaterialRef = {
  id: new Uint32Array(1_000_000),
};

/**
 * Per-entity visibility flag. Bit 0 = visible.
 * Renderer skips entities where bit 0 is 0.
 */
export const Visibility = {
  flags: new Uint8Array(1_000_000),
};

/**
 * Per-entity layer mask (Three.js Object3D.layers).
 * Default 0x00000001 (layer 0).
 */
export const LayerMask = {
  mask: new Uint32Array(1_000_000),
};

/**
 * Optional per-entity render order for transparency sorting.
 */
export const RenderOrder = {
  order: new Int16Array(1_000_000),
};

/**
 * Marker: entity is rendered. Added automatically by addMesh.
 */
export const RenderableTag = {};

// ═══════════════════════════════════════════════════════════════════════
// REGISTRY — geometry and material deduplication
// ═══════════════════════════════════════════════════════════════════════

/**
 * Registry entry structure:
 *   { ref: <BufferGeometry|Material>, refCount: number,
 *     pool: <DynamicPool|null>, uuid: string }
 *
 * id 0 is reserved for "none". Real registries start at 1.
 */
export const GEOMETRY_REGISTRY = {
  nextId: 1,
  byId: new Map(),       // id -> entry
  byRef: new Map(),      // ref -> id
};

export const MATERIAL_REGISTRY = {
  nextId: 1,
  byId: new Map(),
  byRef: new Map(),
};

// ═══════════════════════════════════════════════════════════════════════
// GEOMETRY REGISTRY API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register a BufferGeometry. Returns stable numeric id.
 * If `owned` is true, the registry will dispose it when refCount hits 0.
 */
export function registerGeometry(geometry, { owned = true } = {}) {
  const existing = GEOMETRY_REGISTRY.byRef.get(geometry);
  if (existing !== undefined) {
    GEOMETRY_REGISTRY.byId.get(existing).refCount++;
    return existing;
  }
  const id = GEOMETRY_REGISTRY.nextId++;
  GEOMETRY_REGISTRY.byId.set(id, {
    ref: geometry,
    refCount: 1,
    owned,
    pool: null,
  });
  GEOMETRY_REGISTRY.byRef.set(geometry, id);
  return id;
}

/**
 * Acquire a pooled BufferGeometry by `factory`. Each call returns a
 * unique geometry instance (needed for morph targets / skinning).
 * On release, the geometry returns to the pool.
 */
export function acquirePooledGeometry(factory) {
  const geometry = poolGeometry.acquire();
  // Apply custom factory attributes if provided.
  if (factory) factory(geometry);
  const id = GEOMETRY_REGISTRY.nextId++;
  GEOMETRY_REGISTRY.byId.set(id, {
    ref: geometry,
    refCount: 1,
    owned: false,
    pool: poolGeometry,
  });
  GEOMETRY_REGISTRY.byRef.set(geometry, id);
  return id;
}

/**
 * Increment refcount on a registered geometry.
 */
export function retainGeometry(id) {
  const entry = GEOMETRY_REGISTRY.byId.get(id);
  if (entry) entry.refCount++;
  return id;
}

/**
 * Decrement refcount; dispose/release when it hits 0.
 */
export function releaseGeometry(id) {
  const entry = GEOMETRY_REGISTRY.byId.get(id);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount > 0) return;

  GEOMETRY_REGISTRY.byRef.delete(entry.ref);
  GEOMETRY_REGISTRY.byId.delete(id);

  if (entry.pool) {
    entry.pool.release(entry.ref);
  } else if (entry.owned && entry.ref?.dispose) {
    entry.ref.dispose();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MATERIAL REGISTRY API (mirrors geometry)
// ═══════════════════════════════════════════════════════════════════════

export function registerMaterial(material, { owned = true } = {}) {
  const existing = MATERIAL_REGISTRY.byRef.get(material);
  if (existing !== undefined) {
    MATERIAL_REGISTRY.byId.get(existing).refCount++;
    return existing;
  }
  const id = MATERIAL_REGISTRY.nextId++;
  MATERIAL_REGISTRY.byId.set(id, {
    ref: material,
    refCount: 1,
    owned,
    pool: null,
  });
  MATERIAL_REGISTRY.byRef.set(material, id);
  return id;
}

export function acquirePooledMaterial(factory) {
  const material = poolMaterial.acquire();
  if (factory) factory(material);
  const id = MATERIAL_REGISTRY.nextId++;
  MATERIAL_REGISTRY.byId.set(id, {
    ref: material,
    refCount: 1,
    owned: false,
    pool: poolMaterial,
  });
  MATERIAL_REGISTRY.byRef.set(material, id);
  return id;
}

export function retainMaterial(id) {
  const entry = MATERIAL_REGISTRY.byId.get(id);
  if (entry) entry.refCount++;
  return id;
}

export function releaseMaterial(id) {
  const entry = MATERIAL_REGISTRY.byId.get(id);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount > 0) return;

  MATERIAL_REGISTRY.byRef.delete(entry.ref);
  MATERIAL_REGISTRY.byId.delete(id);

  if (entry.pool) {
    entry.pool.release(entry.ref);
  } else if (entry.owned && entry.ref?.dispose) {
    entry.ref.dispose();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ECS API — attach a renderable to an entity
// ═══════════════════════════════════════════════════════════════════════

/**
 * Attach MeshRef components + register geometry/material.
 *
 * @param world       ECS world
 * @param eid         entity id
 * @param geometryId  geometry id from registerGeometry / acquirePooledGeometry
 * @param materialId  material id from registerMaterial / acquirePooledMaterial
 * @param opts        { visible = true, layer = 1, renderOrder = 0 }
 *
 * Requires LocalTransformF32 + WorldTransformF32 + LocalBoundsF32 (file 004)
 * so the mesh can be culled. If missing, they are auto-added.
 */
export function addMesh(world, eid, geometryId, materialId, opts = {}) {
  const { visible = true, layer = 1, renderOrder = 0 } = opts;

  // Ensure transform + bounds exist.
  if (!hasComponent(world, eid, WorldTransformF32)) {
    throw new Error('addMesh: entity must have WorldTransformF32 (use addTransform first)');
  }
  if (!hasComponent(world, eid, BoundsTag)) {
    // Default unit cube bounds if none provided.
    addComponent(world, eid, LocalBoundsF32);
    addComponent(world, eid, WorldBoundsF32);
    addComponent(world, eid, BoundsTag);
    const id = getId(eid);
    const off = id * 6;
    LocalBoundsF32.aabb[off]     = -0.5;
    LocalBoundsF32.aabb[off + 1] = -0.5;
    LocalBoundsF32.aabb[off + 2] = -0.5;
    LocalBoundsF32.aabb[off + 3] =  0.5;
    LocalBoundsF32.aabb[off + 4] =  0.5;
    LocalBoundsF32.aabb[off + 5] =  0.5;
    LocalBoundsF32.initialized[id] = 1;
  }

  addComponent(world, eid, GeometryRef);
  addComponent(world, eid, MaterialRef);
  addComponent(world, eid, Visibility);
  addComponent(world, eid, LayerMask);
  addComponent(world, eid, RenderOrder);
  addComponent(world, eid, RenderableTag);

  const id = getId(eid);
  GeometryRef.id[id] = geometryId;
  MaterialRef.id[id] = materialId;
  Visibility.flags[id] = visible ? 1 : 0;
  LayerMask.mask[id] = layer;
  RenderOrder.order[id] = renderOrder;

  retainGeometry(geometryId);
  retainMaterial(materialId);
  return eid;
}

export function setMeshVisible(world, eid, visible) {
  const id = getId(eid);
  Visibility.flags[id] = visible ? 1 : 0;
}

export function isMeshVisible(world, eid) {
  return (Visibility.flags[getId(eid)] & 1) === 1;
}

export function removeMesh(world, eid) {
  const id = getId(eid);
  const gid = GeometryRef.id[id];
  const mid = MaterialRef.id[id];
  if (gid) releaseGeometry(gid);
  if (mid) releaseMaterial(mid);
  GeometryRef.id[id] = 0;
  MaterialRef.id[id] = 0;

  removeComponent(world, eid, GeometryRef);
  removeComponent(world, eid, MaterialRef);
  removeComponent(world, eid, Visibility);
  removeComponent(world, eid, LayerMask);
  removeComponent(world, eid, RenderOrder);
  removeComponent(world, eid, RenderableTag);
}

// ═══════════════════════════════════════════════════════════════════════
// THREE.JS INSTANCE POOL — one InstancedMesh per unique (geom, mat) pair
// ═══════════════════════════════════════════════════════════════════════
//
// For 1M-entity scenes we cannot have 1M THREE.Mesh objects — that's too
// many draw calls. Instead, entities sharing the same (geometry, material)
// pair are grouped into InstancedMesh buckets. This bucket map is rebuilt
// on demand as entities are added/removed.

/**
 * Map<"geomId|matId", InstancedBucket>
 * InstancedBucket = { geometryId, materialId, mesh: InstancedMesh,
 *                     capacity, count, entityToInstance: Map<eid, idx> }
 */
export const INSTANCED_BUCKETS = new Map();

const INITIAL_INSTANCED_CAPACITY = 1024;

function bucketKey(geometryId, materialId) {
  return geometryId + '|' + materialId;
}

function ensureBucket(geometryId, materialId, scene) {
  const key = bucketKey(geometryId, materialId);
  let bucket = INSTANCED_BUCKETS.get(key);
  if (bucket) return bucket;

  const geoEntry = GEOMETRY_REGISTRY.byId.get(geometryId);
  const matEntry = MATERIAL_REGISTRY.byId.get(materialId);
  if (!geoEntry || !matEntry) {
    throw new Error(
      `ensureBucket: missing geometry ${geometryId} or material ${materialId}`
    );
  }

  const mesh = new THREE.InstancedMesh(
    geoEntry.ref,
    matEntry.ref,
    INITIAL_INSTANCED_CAPACITY
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false; // we do our own culling via BVH
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);

  bucket = {
    geometryId,
    materialId,
    mesh,
    capacity: INITIAL_INSTANCED_CAPACITY,
    count: 0,
    entityToInstance: new Map(),
    instanceToEntity: new Uint32Array(INITIAL_INSTANCED_CAPACITY),
  };
  INSTANCED_BUCKETS.set(key, bucket);
  return bucket;
}

function growBucket(bucket, scene) {
  const newCap = bucket.capacity * 2;
  const oldMesh = bucket.mesh;
  const newMesh = new THREE.InstancedMesh(
    oldMesh.geometry,
    oldMesh.material,
    newCap
  );
  newMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  newMesh.frustumCulled = false;
  newMesh.matrixAutoUpdate = false;

  // Copy existing matrices.
  const src = oldMesh.instanceMatrix.array;
  const dst = newMesh.instanceMatrix.array;
  dst.set(src.subarray(0, bucket.count * 16));

  // Swap into scene.
  scene.remove(oldMesh);
  scene.add(newMesh);
  // Don't dispose old mesh's geometry/material — they're shared via registry.
  oldMesh.dispose();

  bucket.mesh = newMesh;
  bucket.capacity = newCap;
  const newMap = new Uint32Array(newCap);
  newMap.set(bucket.instanceToEntity.subarray(0, bucket.count));
  bucket.instanceToEntity = newMap;
}

/**
 * Add an entity to its (geometry, material) bucket, allocating a new
 * instance slot. Called once when a RenderableTag entity is created.
 */
export function addEntityToBucket(world, eid, scene) {
  const id = getId(eid);
  const gid = GeometryRef.id[id];
  const mid = MaterialRef.id[id];
  if (!gid || !mid) return;

  const bucket = ensureBucket(gid, mid, scene);
  if (bucket.count >= bucket.capacity) growBucket(bucket, scene);

  const slot = bucket.count++;
  bucket.entityToInstance.set(eid, slot);
  bucket.instanceToEntity[slot] = eid;
  bucket.mesh.count = bucket.count;

  // Write the current world matrix.
  writeInstanceMatrix(eid, bucket, slot);
  return slot;
}

export function removeEntityFromBucket(world, eid, scene) {
  const id = getId(eid);
  const gid = GeometryRef.id[id];
  const mid = MaterialRef.id[id];
  if (!gid || !mid) return;

  const bucket = INSTANCED_BUCKETS.get(bucketKey(gid, mid));
  if (!bucket) return;

  const slot = bucket.entityToInstance.get(eid);
  if (slot === undefined) return;

  // Swap last instance into this slot.
  const lastSlot = bucket.count - 1;
  if (slot !== lastSlot) {
    const lastEid = bucket.instanceToEntity[lastSlot];
    bucket.entityToInstance.set(lastEid, slot);
    bucket.instanceToEntity[slot] = lastEid;
    // Copy last matrix into slot.
    const a = bucket.mesh.instanceMatrix.array;
    a.copyWithin(slot * 16, lastSlot * 16, lastSlot * 16 + 16);
    bucket.entityToInstance.set(eid, lastSlot); // update to trailing slot
  }

  bucket.entityToInstance.delete(eid);
  bucket.instanceToEntity[lastSlot] = 0;
  bucket.count--;
  bucket.mesh.count = bucket.count;
}

/**
 * Write WorldTransformF32 of `eid` into bucket.mesh at `slot`.
 * Column-major layout matches Three.js InstancedMesh.
 */
function writeInstanceMatrix(eid, bucket, slot) {
  const id = getId(eid);
  const off = id * 16;
  const src = WorldTransformF32.m;
  const dst = bucket.mesh.instanceMatrix.array;
  const d = slot * 16;
  dst[d]      = src[off];
  dst[d + 1]  = src[off + 1];
  dst[d + 2]  = src[off + 2];
  dst[d + 3]  = src[off + 3];
  dst[d + 4]  = src[off + 4];
  dst[d + 5]  = src[off + 5];
  dst[d + 6]  = src[off + 6];
  dst[d + 7]  = src[off + 7];
  dst[d + 8]  = src[off + 8];
  dst[d + 9]  = src[off + 9];
  dst[d + 10] = src[off + 10];
  dst[d + 11] = src[off + 11];
  dst[d + 12] = src[off + 12];
  dst[d + 13] = src[off + 13];
  dst[d + 14] = src[off + 14];
  dst[d + 15] = src[off + 15];
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — sync visibility + matrices (culling-aware, no scene traversal)
// ═══════════════════════════════════════════════════════════════════════
//
// Runs once per frame. Does NOT iterate the Three.js scene graph. Instead:
//   1. Calls bvhFrustumCull(planes) → set of visible entity ids
//   2. Iterates visible entities only, updating instance matrices
//   3. Hides entities that left the frustum (their instance matrices are
//      left stale but their Visibility flag tells us to skip them next frame)

const _visibleSet = new Set();
const _planes = new Float32Array(24);
const _prevVisible = new Set();

/**
 * Compute visible entities from a camera's projectionMatrix × matrixWorldInverse.
 *
 * @param world       ECS world
 * @param camera      THREE.Camera (uses camera.projectionMatrix + camera.matrixWorldInverse)
 * @param scene       THREE.Scene (for InstancedMesh buckets)
 * @param opts        { maxDistance = Infinity }
 */
export function systemSyncMeshes(world, camera, scene, opts = {}) {
  // 1. Extract frustum planes from camera.
  const projView = mat4.create();
  mat4.multiply(projView, camera.projectionMatrix.elements, camera.matrixWorldInverse.elements);
  extractFrustumPlanes(projView, _planes);

  // 2. Cull via BVH.
  const visible = bvhFrustumCull(_planes);

  // 3. Update instance matrices + visibility flags.
  _visibleSet.clear();
  for (let i = 0, n = visible.length; i < n; i++) {
    const eid = visible[i];
    _visibleSet.add(eid);

    const id = getId(eid);
    if (!hasComponent(world, eid, RenderableTag)) continue;

    Visibility.flags[id] |= 1;

    const gid = GeometryRef.id[id];
    const mid = MaterialRef.id[id];
    const bucket = INSTANCED_BUCKETS.get(bucketKey(gid, mid));
    if (!bucket) continue;

    const slot = bucket.entityToInstance.get(eid);
    if (slot === undefined) continue;

    writeInstanceMatrix(eid, bucket, slot);
  }

  // 4. Hide entities that were visible last frame but not this frame.
  for (const eid of _prevVisible) {
    if (!_visibleSet.has(eid)) {
      const id = getId(eid);
      if (hasComponent(world, eid, RenderableTag)) {
        Visibility.flags[id] &= ~1;
        // Also zero the instance matrix so it's not drawn (InstancedMesh
        // still draws all `count` instances; visibility must be handled
        // via per-instance color or by shrinking count — see below).
      }
    }
  }

  // Swap prev/visible sets.
  _prevVisible.clear();
  for (const eid of _visibleSet) _prevVisible.add(eid);

  // 5. Mark all instanceMatrix buffers dirty.
  for (const bucket of INSTANCED_BUCKETS.values()) {
    bucket.mesh.instanceMatrix.needsUpdate = true;
    bucket.mesh.count = bucket.count;
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PER-INSTANCE VISIBILITY (for InstancedMesh instances that can't be
// individually toggled — uses a scale-0 trick)
// ═══════════════════════════════════════════════════════════════════════
//
// True per-instance visibility requires either:
//   - per-instance color/alpha
//   - a separate draw list per visibility bucket
//   - collapsing invisible instances to zero-scale
//
// We use the zero-scale trick: invisible instances get their 3×3
// rotation/scale part collapsed. Cheap and works on all backends.

const _zeroMat = new Float32Array(16);
// identity translation, zero scale
_zeroMat[0] = 0; _zeroMat[5] = 0; _zeroMat[10] = 0;
_zeroMat[12] = 0; _zeroMat[13] = 0; _zeroMat[14] = 0;
_zeroMat[15] = 1;

function writeZeroMatrix(bucket, slot) {
  const dst = bucket.mesh.instanceMatrix.array;
  const d = slot * 16;
  dst.set(_zeroMat, d);
}

/**
 * Collapse an entity's instance to zero-scale (invisible but still consumes
 * a slot). Use systemSyncMeshes for coarse visibility, this for fine.
 */
export function collapseInstance(world, eid) {
  const id = getId(eid);
  const gid = GeometryRef.id[id];
  const mid = MaterialRef.id[id];
  const bucket = INSTANCED_BUCKETS.get(bucketKey(gid, mid));
  if (!bucket) return;
  const slot = bucket.entityToInstance.get(eid);
  if (slot === undefined) return;
  writeZeroMatrix(bucket, slot);
  bucket.mesh.instanceMatrix.needsUpdate = true;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

/**
 * Remove all InstancedMesh buckets from the scene and dispose their CPU
 * resources. The underlying geometry/material are released via the
 * registries separately.
 */
export function clearRenderBuckets(scene) {
  for (const bucket of INSTANCED_BUCKETS.values()) {
    scene.remove(bucket.mesh);
    bucket.mesh.dispose();
  }
  INSTANCED_BUCKETS.clear();
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function renderStats() {
  let totalInstances = 0;
  let bucketCount = INSTANCED_BUCKETS.size;
  for (const bucket of INSTANCED_BUCKETS.values()) {
    totalInstances += bucket.count;
  }
  return {
    bucketCount,
    totalInstances,
    geometryCount: GEOMETRY_REGISTRY.byId.size,
    materialCount: MATERIAL_REGISTRY.byId.size,
  };
}