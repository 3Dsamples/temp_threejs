// file number : 011
// full path name : src/prefab/011_prefab_system.js
// description : flecs-compatible prefab and entity template system.
//               Implements IsA (created here since file 001 exports only
//               Wildcard), Prefab / PrefabInstance markers, prefab component
//               inheritance cascade through nested prefabs and IsA chains,
//               per-instance component overrides, batch instantiation of 1M+
//               instances in a single tight loop, and SoA data copiers so
//               prefab-defined transforms / geometry / materials are
//               inherited correctly (bitflags alone are not enough).
//
//               FLOAT PRECISION AUDIT (all numeric literals verified):
//                 EPSILON_SQ    = 1e-16   (squared-magnitude zero check;
//                                          just above Float64 noise, far
//                                          below Float32 resolution)
//                 EPSILON       = 1e-8    (linear magnitude zero check)
//                 EPSILON_HIGH  = 1e-12   (quaternion / matrix guards)
//                 R2_ALPHA_1    = 0.7548776662466927  (1/ρ, plastic constant
//                                          ρ ≈ 1.32471795724474602596)
//                 R2_ALPHA_2    = 0.5698402909980532  (1/ρ²)
//                 R2_ALPHA_3    = 0.4301597090019467  (1/ρ³)
//               These three constants form the R2 3D low-discrepancy
//               sequence — used for deterministic jitter in batch
//               instantiation, matching PBRT-v4 sampler philosophy.
//               No literal like 0.0166… — physics / animation files use
//               the exact fraction `1 / 60`.
//
// best for : Scene authoring (one "tree" prefab → 10,000 scattered instances),
//            NPC / weapon / prop archetypes, vegetation scattering, particle
//            emitters, UI element templates, and any scene that repeats a
//            small number of shapes across a huge number of entities on
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
  createRelation,
  Pair,
  Wildcard,
  addEntity,
  removeEntity,
} from '../ecs/001_ecs_core.js';

import {
  WorldTransformF32,
  LocalTransformF32,
  ChildOf,
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  WorldBoundsF32,
  LocalBoundsF32,
} from '../geometry/004_aabb_bounds.js';

import {
  GeometryRef,
  MaterialRef,
  Visibility,
  LayerMask,
  RenderOrder,
  BoundsTag,
} from '../render/005_mesh_components.js';

// ═══════════════════════════════════════════════════════════════════════
// NUMERIC CONSTANTS — verified float literals
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ   = 1e-16;
const EPSILON      = 1e-8;
const EPSILON_HIGH = 1e-12;

// R2 low-discrepancy sequence alphas (1/ρ, 1/ρ², 1/ρ³),
// ρ = plastic constant ≈ 1.32471795724474602596090885…
const R2_ALPHA_1 = 0.7548776662466927;
const R2_ALPHA_2 = 0.5698402909980532;
const R2_ALPHA_3 = 0.4301597090019467;

// ═══════════════════════════════════════════════════════════════════════
// IsA RELATION — created here (file 001 exports Wildcard but not IsA)
// ═══════════════════════════════════════════════════════════════════════

/**
 * IsA(source) — "this entity inherits source's components". Unlike ChildOf
 * (parent owns child in scene graph), IsA means source is a *template*.
 * Both relations can coexist on the same entity.
 */
export const IsA = createRelation();

/** Marker: entity is a prefab template (never rendered directly). */
export const Prefab = {};

/** Marker: entity was created from a prefab. */
export const PrefabInstance = {};

// ═══════════════════════════════════════════════════════════════════════
// PREFAB DATA — template definition
// ═══════════════════════════════════════════════════════════════════════

/**
 * componentsByPrefab: prefabEid → array of componentRef (SoA store objects
 * or tag objects). Order is preserved but not semantically meaningful.
 */
export const PrefabData = {
  componentsByPrefab: new Map(),
  childPrefabsByPrefab: new Map(),
};

/** Per-instance override tracker. */
export const PrefabOverrides = {
  overridesByInstance: new Map(), // instanceEid → Set<componentRef>
};

// ═══════════════════════════════════════════════════════════════════════
// SoA DATA COPIERS — bitflags alone are not enough
// ═══════════════════════════════════════════════════════════════════════
//
// When a prefab carries a component like LocalTransformF32, `addComponent`
// only sets the bitflag. The actual SoA values (px, py, …) must be copied
// explicitly. Each registered component can provide a copier function:
//   (srcId: number, dstId: number) => void
//
// Built-in copiers are registered below for the components this file knows
// about. Users can register copiers for custom components via
// registerPrefabDataCopier().

export const PREFAB_DATA_COPIERS = new Map();

export function registerPrefabDataCopier(component, copierFn) {
  PREFAB_DATA_COPIERS.set(component, copierFn);
}

function registerBuiltInCopiers() {
  registerPrefabDataCopier(LocalTransformF32, (srcId, dstId) => {
    const L = LocalTransformF32;
    L.px[dstId] = L.px[srcId];
    L.py[dstId] = L.py[srcId];
    L.pz[dstId] = L.pz[srcId];
    L.qx[dstId] = L.qx[srcId];
    L.qy[dstId] = L.qy[srcId];
    L.qz[dstId] = L.qz[srcId];
    L.qw[dstId] = L.qw[srcId];
    L.sx[dstId] = L.sx[srcId];
    L.sy[dstId] = L.sy[srcId];
    L.sz[dstId] = L.sz[srcId];
  });

  registerPrefabDataCopier(WorldTransformF32, (srcId, dstId) => {
    const src = WorldTransformF32.m;
    const dst = WorldTransformF32.m;
    const sOff = srcId * 16;
    const dOff = dstId * 16;
    for (let i = 0; i < 16; i++) dst[dOff + i] = src[sOff + i];
  });

  registerPrefabDataCopier(LocalBoundsF32, (srcId, dstId) => {
    const B = LocalBoundsF32.aabb;
    const sOff = srcId * 6;
    const dOff = dstId * 6;
    for (let i = 0; i < 6; i++) B[dOff + i] = B[sOff + i];
    LocalBoundsF32.initialized[dstId] = LocalBoundsF32.initialized[srcId];
  });

  registerPrefabDataCopier(WorldBoundsF32, (srcId, dstId) => {
    const B = WorldBoundsF32.aabb;
    const sOff = srcId * 6;
    const dOff = dstId * 6;
    for (let i = 0; i < 6; i++) B[dOff + i] = B[sOff + i];
  });

  registerPrefabDataCopier(GeometryRef, (srcId, dstId) => {
    GeometryRef.id[dstId] = GeometryRef.id[srcId];
  });

  registerPrefabDataCopier(MaterialRef, (srcId, dstId) => {
    MaterialRef.id[dstId] = MaterialRef.id[srcId];
  });

  registerPrefabDataCopier(Visibility, (srcId, dstId) => {
    Visibility.flags[dstId] = Visibility.flags[srcId];
  });

  registerPrefabDataCopier(LayerMask, (srcId, dstId) => {
    LayerMask.mask[dstId] = LayerMask.mask[srcId];
  });

  registerPrefabDataCopier(RenderOrder, (srcId, dstId) => {
    RenderOrder.order[dstId] = RenderOrder.order[srcId];
  });
}

registerBuiltInCopiers();

// ═══════════════════════════════════════════════════════════════════════
// PREFAB CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a prefab entity and register the given components.
 * The prefab itself is a live entity marked with `Prefab`; it participates
 * in queries but is skipped by rendering (files 005 / 006 check the tag).
 */
export function createPrefab(world, ...components) {
  const eid = addEntity(world);
  addComponent(world, eid, Prefab);

  const list = [];
  for (const comp of components) {
    if (!hasComponent(world, eid, comp)) {
      addComponent(world, eid, comp);
    }
    if (!list.includes(comp)) list.push(comp);
  }
  PrefabData.componentsByPrefab.set(eid, list);
  return eid;
}

/**
 * Add another component to an existing prefab. New components will be
 * propagated to instances on the next systemPropagatePrefabs() pass,
 * unless the instance has an override for that component.
 */
export function addPrefabComponent(world, prefabEid, component) {
  if (!hasComponent(world, prefabEid, Prefab)) {
    throw new Error('addPrefabComponent: entity is not a prefab');
  }
  if (component === Prefab) return false; // do not propagate the marker
  if (hasComponent(world, prefabEid, component)) return false;

  addComponent(world, prefabEid, component);
  const list = PrefabData.componentsByPrefab.get(prefabEid) ?? [];
  if (!list.includes(component)) list.push(component);
  PrefabData.componentsByPrefab.set(prefabEid, list);
  return true;
}

export function removePrefabComponent(world, prefabEid, component) {
  if (component === Prefab) return;
  if (hasComponent(world, prefabEid, component)) {
    removeComponent(world, prefabEid, component);
  }
  const list = PrefabData.componentsByPrefab.get(prefabEid);
  if (list) {
    const idx = list.indexOf(component);
    if (idx !== -1) list.splice(idx, 1);
  }
}

/**
 * Nest a prefab inside another (prefab inheritance chain).
 * Inner prefab's components propagate transitively to instances.
 */
export function addChildPrefab(world, parentPrefabEid, childPrefabEid) {
  if (!hasComponent(world, parentPrefabEid, Prefab)) {
    throw new Error('addChildPrefab: parent is not a prefab');
  }
  if (!hasComponent(world, childPrefabEid, Prefab)) {
    throw new Error('addChildPrefab: child is not a prefab');
  }
  const list = PrefabData.childPrefabsByPrefab.get(parentPrefabEid) ?? [];
  if (!list.includes(childPrefabEid)) list.push(childPrefabEid);
  PrefabData.childPrefabsByPrefab.set(parentPrefabEid, list);
}

// ═══════════════════════════════════════════════════════════════════════
// IsA INSPECTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return entity IDs that `eid` inherits from via IsA.
 * Uses file 001's relation symbols without importing them by name.
 */
export function getIsATargets(world, eid) {
  const comps = world[$internal].entityComponents.get(eid);
  if (!comps) return [];
  const relationSymbol = Symbol.for('bitecs_max_relation');
  const targetSymbol   = Symbol.for('bitecs_max_pairTarget');
  const targets = [];
  for (const comp of comps) {
    if (comp && comp[relationSymbol] === IsA) {
      const t = comp[targetSymbol];
      if (t !== Wildcard) targets.push(t);
    }
  }
  return targets;
}

// ═══════════════════════════════════════════════════════════════════════
// COMPONENT COLLECTION (transitive through nested prefabs + IsA)
// ═══════════════════════════════════════════════════════════════════════

function collectAllComponents(world, prefabEid, out, visited) {
  if (visited.has(prefabEid)) return;
  visited.add(prefabEid);

  const list = PrefabData.componentsByPrefab.get(prefabEid) ?? [];
  for (const comp of list) {
    if (comp === Prefab) continue;
    if (!out.includes(comp)) out.push(comp);
  }

  const children = PrefabData.childPrefabsByPrefab.get(prefabEid) ?? [];
  for (const child of children) collectAllComponents(world, child, out, visited);

  const parents = getIsATargets(world, prefabEid);
  for (const parent of parents) collectAllComponents(world, parent, out, visited);
}

// ═══════════════════════════════════════════════════════════════════════
// INSTANTIATION — single
// ═══════════════════════════════════════════════════════════════════════

/**
 * Instantiate a prefab.
 * @returns new entity id
 */
export function instantiatePrefab(world, prefabEid, opts = {}) {
  if (!hasComponent(world, prefabEid, Prefab)) {
    throw new Error('instantiatePrefab: entity is not a prefab');
  }

  const eid = addEntity(world);
  addComponent(world, eid, Pair(IsA, prefabEid));
  addComponent(world, eid, PrefabInstance);

  const components = [];
  collectAllComponents(world, prefabEid, components, new Set());

  const srcId = getId(prefabEid);
  const dstId = getId(eid);

  for (const comp of components) {
    if (!hasComponent(world, eid, comp)) addComponent(world, eid, comp);
    const copier = PREFAB_DATA_COPIERS.get(comp);
    if (copier) copier(srcId, dstId);
  }

  if (opts.parentEid) {
    addComponent(world, eid, Pair(ChildOf, opts.parentEid));
  }

  if (hasComponent(world, eid, LocalTransformF32)) {
    const id = getId(eid);
    const L = LocalTransformF32;
    if (opts.px !== undefined) L.px[id] = opts.px;
    if (opts.py !== undefined) L.py[id] = opts.py;
    if (opts.pz !== undefined) L.pz[id] = opts.pz;
    if (opts.qx !== undefined) L.qx[id] = opts.qx;
    if (opts.qy !== undefined) L.qy[id] = opts.qy;
    if (opts.qz !== undefined) L.qz[id] = opts.qz;
    if (opts.qw !== undefined) L.qw[id] = opts.qw;
    markDirty(eid);
  }

  return eid;
}

// ═══════════════════════════════════════════════════════════════════════
// INSTANTIATION — batch (hot path for 1M entities)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Instantiate `count` copies of a prefab in a single tight loop.
 * Uses R2 3D low-discrepancy jitter for deterministic, evenly-spread
 * positions when `spread` is provided.
 *
 * @returns Uint32Array of new entity ids
 */
export function batchInstantiate(world, prefabEid, count, opts = {}) {
  if (!hasComponent(world, prefabEid, Prefab)) {
    throw new Error('batchInstantiate: entity is not a prefab');
  }

  const components = [];
  collectAllComponents(world, prefabEid, components, new Set());

  const hasTransform = components.includes(LocalTransformF32);
  const hasWorldTransform = components.includes(WorldTransformF32);
  const hasLocalBounds = components.includes(LocalBoundsF32);
  const hasWorldBounds = components.includes(WorldBoundsF32);
  const hasGeometry = components.includes(GeometryRef);
  const hasMaterial = components.includes(MaterialRef);
  const hasVisibility = components.includes(Visibility);
  const hasLayer = components.includes(LayerMask);
  const hasRenderOrder = components.includes(RenderOrder);

  const srcId = getId(prefabEid);
  const baseX = opts.px ?? 0;
  const baseY = opts.py ?? 0;
  const baseZ = opts.pz ?? 0;
  const spreadX = opts.spread ? opts.spread[0] : 0;
  const spreadY = opts.spread ? opts.spread[1] : 0;
  const spreadZ = opts.spread ? opts.spread[2] : 0;

  const eids = new Uint32Array(count);

  for (let i = 0; i < count; i++) {
    const eid = addEntity(world);
    eids[i] = eid;

    addComponent(world, eid, Pair(IsA, prefabEid));
    addComponent(world, eid, PrefabInstance);

    for (const comp of components) {
      if (!hasComponent(world, eid, comp)) addComponent(world, eid, comp);
    }

    const dstId = getId(eid);

    // Fast-path SoA copies — inline, no Map lookups.
    if (hasTransform) {
      const L = LocalTransformF32;
      const jX = spreadX > 0 ? (((i + 1) * R2_ALPHA_1) % 1 - 0.5) * spreadX : 0;
      const jY = spreadY > 0 ? (((i + 1) * R2_ALPHA_2) % 1 - 0.5) * spreadY : 0;
      const jZ = spreadZ > 0 ? (((i + 1) * R2_ALPHA_3) % 1 - 0.5) * spreadZ : 0;
      L.px[dstId] = baseX + jX;
      L.py[dstId] = baseY + jY;
      L.pz[dstId] = baseZ + jZ;
      L.qx[dstId] = opts.qx ?? L.qx[srcId];
      L.qy[dstId] = opts.qy ?? L.qy[srcId];
      L.qz[dstId] = opts.qz ?? L.qz[srcId];
      L.qw[dstId] = opts.qw ?? L.qw[srcId];
      L.sx[dstId] = L.sx[srcId];
      L.sy[dstId] = L.sy[srcId];
      L.sz[dstId] = L.sz[srcId];
      markDirty(eid);
    }
    if (hasWorldTransform) {
      const src = WorldTransformF32.m;
      const dst = WorldTransformF32.m;
      const sOff = srcId * 16;
      const dOff = dstId * 16;
      for (let k = 0; k < 16; k++) dst[dOff + k] = src[sOff + k];
    }
    if (hasLocalBounds) {
      const B = LocalBoundsF32.aabb;
      const sOff = srcId * 6;
      const dOff = dstId * 6;
      for (let k = 0; k < 6; k++) B[dOff + k] = B[sOff + k];
      LocalBoundsF32.initialized[dstId] = LocalBoundsF32.initialized[srcId];
    }
    if (hasWorldBounds) {
      const B = WorldBoundsF32.aabb;
      const sOff = srcId * 6;
      const dOff = dstId * 6;
      for (let k = 0; k < 6; k++) B[dOff + k] = B[sOff + k];
    }
    if (hasGeometry) GeometryRef.id[dstId] = GeometryRef.id[srcId];
    if (hasMaterial) MaterialRef.id[dstId] = MaterialRef.id[srcId];
    if (hasVisibility) Visibility.flags[dstId] = Visibility.flags[srcId];
    if (hasLayer) LayerMask.mask[dstId] = LayerMask.mask[srcId];
    if (hasRenderOrder) RenderOrder.order[dstId] = RenderOrder.order[srcId];
  }

  return eids;
}

// ═══════════════════════════════════════════════════════════════════════
// OVERRIDES
// ═══════════════════════════════════════════════════════════════════════

export function overrideComponent(world, instanceEid, component) {
  let overrides = PrefabOverrides.overridesByInstance.get(instanceEid);
  if (!overrides) {
    overrides = new Set();
    PrefabOverrides.overridesByInstance.set(instanceEid, overrides);
  }
  overrides.add(component);
}

export function isComponentOverridden(world, instanceEid, component) {
  const overrides = PrefabOverrides.overridesByInstance.get(instanceEid);
  return overrides ? overrides.has(component) : false;
}

export function clearOverride(world, instanceEid, component) {
  const overrides = PrefabOverrides.overridesByInstance.get(instanceEid);
  if (overrides) overrides.delete(component);
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — propagate prefab component additions to live instances
// ═══════════════════════════════════════════════════════════════════════

export function systemPropagatePrefabs(world) {
  const prefabs = query(world, [Prefab]);
  if (prefabs.length === 0) return world;

  const instances = query(world, [PrefabInstance]);
  const instancesByPrefab = new Map();
  for (const instEid of instances) {
    const parents = getIsATargets(world, instEid);
    for (const p of parents) {
      if (!instancesByPrefab.has(p)) instancesByPrefab.set(p, []);
      instancesByPrefab.get(p).push(instEid);
    }
  }

  for (const prefabEid of prefabs) {
    const children = instancesByPrefab.get(prefabEid);
    if (!children) continue;

    const compList = PrefabData.componentsByPrefab.get(prefabEid) ?? [];
    const srcId = getId(prefabEid);

    for (const instEid of children) {
      const dstId = getId(instEid);
      for (const comp of compList) {
        if (comp === Prefab) continue;
        if (isComponentOverridden(world, instEid, comp)) continue;
        if (hasComponent(world, instEid, comp)) continue;
        addComponent(world, instEid, comp);
        const copier = PREFAB_DATA_COPIERS.get(comp);
        if (copier) copier(srcId, dstId);
      }
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// DESTRUCTION
// ═══════════════════════════════════════════════════════════════════════

export function destroyPrefab(world, prefabEid, { cascade = false } = {}) {
  if (!hasComponent(world, prefabEid, Prefab)) return;

  if (cascade) {
    const instances = query(world, [PrefabInstance]);
    for (const instEid of instances) {
      const parents = getIsATargets(world, instEid);
      if (parents.includes(prefabEid)) {
        destroyInstance(world, instEid);
      }
    }
  }

  PrefabData.componentsByPrefab.delete(prefabEid);
  PrefabData.childPrefabsByPrefab.delete(prefabEid);

  removeComponent(world, prefabEid, Prefab);
  removeEntity(world, prefabEid);
}

export function destroyInstance(world, instEid) {
  if (!hasComponent(world, instEid, PrefabInstance)) return;

  const parents = getIsATargets(world, instEid);
  for (const p of parents) {
    removeComponent(world, instEid, Pair(IsA, p));
  }
  PrefabOverrides.overridesByInstance.delete(instEid);
  removeEntity(world, instEid);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function prefabStats(world) {
  const prefabs = query(world, [Prefab]);
  const instances = query(world, [PrefabInstance]);
  let totalComponents = 0;
  for (const list of PrefabData.componentsByPrefab.values()) {
    totalComponents += list.length;
  }
  return {
    prefabCount: prefabs.length,
    instanceCount: instances.length,
    totalPrefabComponents: totalComponents,
    copierCount: PREFAB_DATA_COPIERS.size,
  };
}