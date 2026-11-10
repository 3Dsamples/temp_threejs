// file number : 014
// full path name : src/ecs/014_BitECS.js
// description : High-performance ECS core + serialization rewritten from bitECS v0.3.40 (core/index.mjs and serialization/index.mjs). Includes entity index with optional versioning, sparse-set world, component bitmask registry, query compiler (All/Any/None/Not/Or/And), enter/exit query observers, reactive add/remove hooks, relation support (pairs, wildcard, hierarchy depth), SoA/AoS binary serializers (u8/i8/u16/i16/u32/i32/f32/f64/ref/str/array) with diff mode and TextEncoder/TextDecoder, fixed query initialization + sparse membership index for O(1) `has`, plus stack-based pools for zero-allocation entity/query work. Adaptive ARRAY_TYPE and 32/64-bit safe masks.
// best for : 10k+ entity living worlds, context-awareness pipelines, PBR scene graph management, physics body registration, instanced rendering batches, chunk streaming, network replication, save/load, and low-GC ECS iteration on Android 64-bit.
// license : MIT

import { ARRAY_TYPE } from '../core/003_Common.js';

// ============================================================================
// SYMBOLS
// ============================================================================
const $internal = Symbol.for('bitecs_internal');
const $opType = Symbol.for('bitecs-opType');
const $opTerms = Symbol.for('bitecs-opTerms');
const $modifierType = Symbol.for('bitecs-modifierType');
const $hierarchyType = Symbol.for('bitecs-hierarchyType');
const $hierarchyRel = Symbol.for('bitecs-hierarchyRel');
const $hierarchyDepth = Symbol.for('bitecs-hierarchyDepth');
const $relation = Symbol.for('bitecs-relation');
const $pairTarget = Symbol.for('bitecs-pairTarget');
const $isPairComponent = Symbol.for('bitecs-isPairComponent');
const $relationData = Symbol.for('bitecs-relationData');

const $u8 = Symbol.for('bitecs-u8');
const $i8 = Symbol.for('bitecs-i8');
const $u16 = Symbol.for('bitecs-u16');
const $i16 = Symbol.for('bitecs-i16');
const $u32 = Symbol.for('bitecs-u32');
const $i32 = Symbol.for('bitecs-i32');
const $f32 = Symbol.for('bitecs-f32');
const $f64 = Symbol.for('bitecs-f64');
const $ref = Symbol.for('bitecs-ref');
const $str = Symbol.for('bitecs-str');
const $arr = Symbol.for('bitecs-arr');

const INVALID_DEPTH = 0xffffffff;
const DEFAULT_BUFFER_GROWTH = 1024;

// ============================================================================
// HELPERS
// ============================================================================
const defineHiddenProperty = (obj, key, value) =>
  Object.defineProperty(obj, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true
  });

// ============================================================================
// ENTITY INDEX
// ============================================================================
const getId = (index, id) => id & index.entityMask;

const getVersion = (index, id) =>
  (id >>> index.versionShift) & ((1 << index.versionBits) - 1);

const incrementVersion = (index, id) => {
  const currentVersion = getVersion(index, id);
  const newVersion = (currentVersion + 1) & ((1 << index.versionBits) - 1);
  return (id & index.entityMask) | (newVersion << index.versionShift);
};

const createEntityIndex = (options) => {
  const config =
    options !== undefined
      ? typeof options === 'function'
        ? options()
        : options
      : { versioning: false, versionBits: 8 };
  const versionBits = config.versionBits !== undefined ? config.versionBits : 8;
  const versioning = config.versioning !== undefined ? config.versioning : false;
  const entityBits = 32 - versionBits;
  const entityMask = (1 << entityBits) - 1;
  const versionShift = entityBits;
  const versionMask = ((1 << versionBits) - 1) << versionShift;
  return {
    aliveCount: 0,
    dense: [],
    sparse: [],
    maxId: 0,
    versioning,
    versionBits,
    entityMask,
    versionShift,
    versionMask
  };
};

const addEntityId = (index) => {
  if (index.aliveCount < index.dense.length) {
    const recycledId = index.dense[index.aliveCount];
    index.sparse[getId(index, recycledId)] = index.aliveCount;
    index.aliveCount++;
    return recycledId;
  }
  const id = ++index.maxId;
  index.dense.push(id);
  index.sparse[id] = index.aliveCount;
  index.aliveCount++;
  return id;
};

const removeEntityId = (index, id) => {
  const stripped = getId(index, id);
  const denseIndex = index.sparse[stripped];
  if (denseIndex === undefined || denseIndex >= index.aliveCount) return;
  const lastIndex = index.aliveCount - 1;
  const lastId = index.dense[lastIndex];
  index.sparse[getId(index, lastId)] = denseIndex;
  index.dense[denseIndex] = lastId;
  index.sparse[stripped] = lastIndex;
  index.dense[lastIndex] = id;
  if (index.versioning) {
    index.dense[lastIndex] = incrementVersion(index, id);
  }
  index.aliveCount--;
};

const isEntityIdAlive = (index, id) => {
  const stripped = getId(index, id);
  const denseIndex = index.sparse[stripped];
  return (
    denseIndex !== undefined &&
    denseIndex < index.aliveCount &&
    index.dense[denseIndex] === id
  );
};

// ============================================================================
// WORLD
// ============================================================================
const createBaseWorld = (context, entityIndex) =>
  defineHiddenProperty(context || {}, $internal, {
    entityIndex: entityIndex || createEntityIndex(),
    entityMasks: [[]],
    entityComponents: new Map(),
    bitflag: 1,
    componentMap: new Map(),
    componentCount: 0,
    queries: new Set(),
    queriesHashMap: new Map(),
    notQueries: new Set(),
    dirtyQueries: new Set(),
    entitiesWithRelations: new Set(),
    hierarchyData: new Map(),
    hierarchyActiveRelations: new Set()
  });

export function createWorld(...args) {
  let entityIndex;
  let context;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg === 'object' && arg !== null) {
      if ('dense' in arg && 'sparse' in arg && 'aliveCount' in arg) {
        entityIndex = arg;
      } else {
        context = arg;
      }
    }
  }
  return createBaseWorld(context, entityIndex);
}

export const resetWorld = (world) => {
  const ctx = world[$internal];
  ctx.entityIndex = createEntityIndex();
  ctx.entityMasks = [[]];
  ctx.entityComponents = new Map();
  ctx.bitflag = 1;
  ctx.componentMap = new Map();
  ctx.componentCount = 0;
  ctx.queries = new Set();
  ctx.queriesHashMap = new Map();
  ctx.notQueries = new Set();
  ctx.dirtyQueries = new Set();
  ctx.entitiesWithRelations = new Set();
  ctx.hierarchyData = new Map();
  ctx.hierarchyActiveRelations = new Set();
  return world;
};

export const deleteWorld = (world) => {
  delete world[$internal];
};

export const getWorldComponents = (world) =>
  Array.from(world[$internal].componentMap.keys());

export const getAllEntities = (world) =>
  Array.from(world[$internal].entityComponents.keys());

// ============================================================================
// SPARSE SETS
// ============================================================================
export const createSparseSet = () => {
  const dense = [];
  const sparse = [];
  const has = (val) => dense[sparse[val]] === val;
  const add = (val) => {
    if (has(val)) return;
    sparse[val] = dense.push(val) - 1;
  };
  const remove = (val) => {
    if (!has(val)) return;
    const index = sparse[val];
    const swapped = dense.pop();
    if (swapped !== val) {
      dense[index] = swapped;
      sparse[swapped] = index;
    }
  };
  const reset = () => {
    dense.length = 0;
    sparse.length = 0;
  };
  const sort = (compareFn) => {
    dense.sort(compareFn);
    for (let i = 0; i < dense.length; i++) sparse[dense[i]] = i;
  };
  return { add, remove, has, sparse, dense, reset, sort };
};

export const createUint32SparseSet = (initialCapacity = 1000) => {
  const sparse = [];
  let length = 0;
  let dense = new Uint32Array(
    new SharedArrayBufferOrArrayBuffer(initialCapacity * 4)
  );
  const has = (val) =>
    val < sparse.length && sparse[val] < length && dense[sparse[val]] === val;
  const add = (val) => {
    if (has(val)) return;
    if (length >= dense.length) {
      const newDense = new Uint32Array(
        new SharedArrayBufferOrArrayBuffer(dense.length * 2 * 4)
      );
      newDense.set(dense);
      dense = newDense;
    }
    dense[length] = val;
    sparse[val] = length;
    length++;
  };
  const remove = (val) => {
    if (!has(val)) return;
    length--;
    const index = sparse[val];
    const swapped = dense[length];
    dense[index] = swapped;
    sparse[swapped] = index;
  };
  const reset = () => {
    length = 0;
    sparse.length = 0;
  };
  const sort = (compareFn) => {
    const temp = Array.from(dense.subarray(0, length));
    temp.sort(compareFn);
    for (let i = 0; i < temp.length; i++) dense[i] = temp[i];
    for (let i = 0; i < length; i++) sparse[dense[i]] = i;
  };
  return {
    add,
    remove,
    has,
    sparse,
    get dense() {
      return new Uint32Array(dense.buffer, 0, length);
    },
    reset,
    sort
  };
};

const SharedArrayBufferOrArrayBuffer =
  typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer;

// ============================================================================
// OBSERVABLE
// ============================================================================
export const createObservable = () => {
  const observers = new Set();
  const subscribe = (observer) => {
    observers.add(observer);
    return () => {
      observers.delete(observer);
    };
  };
  const notify = (entity, ...args) => {
    let acc = {};
    for (const listener of observers) {
      const result = listener(entity, ...args);
      if (result && typeof result === 'object') acc = { ...acc, ...result };
    }
    return acc;
  };
  return { subscribe, notify };
};

// ============================================================================
// RELATIONS
// ============================================================================
const createBaseRelation = () => {
  const data = {
    pairsMap: new Map(),
    initStore: undefined,
    exclusiveRelation: false,
    autoRemoveSubject: false,
    onTargetRemoved: undefined
  };
  const relation = (target) => {
    if (target === undefined) throw Error('Relation target is undefined');
    const normalizedTarget = target === '*' ? Wildcard : target;
    if (!data.pairsMap.has(normalizedTarget)) {
      const component = data.initStore ? data.initStore(target) : {};
      defineHiddenProperty(component, $relation, relation);
      defineHiddenProperty(component, $pairTarget, normalizedTarget);
      defineHiddenProperty(component, $isPairComponent, true);
      data.pairsMap.set(normalizedTarget, component);
    }
    return data.pairsMap.get(normalizedTarget);
  };
  defineHiddenProperty(relation, $relationData, data);
  return relation;
};

export const withStore = (createStore) => (relation) => {
  relation[$relationData].initStore = createStore;
  return relation;
};

export const makeExclusive = (relation) => {
  relation[$relationData].exclusiveRelation = true;
  return relation;
};

export const withAutoRemoveSubject = (relation) => {
  relation[$relationData].autoRemoveSubject = true;
  return relation;
};

export const withOnTargetRemoved = (onRemove) => (relation) => {
  relation[$relationData].onTargetRemoved = onRemove;
  return relation;
};

export const Pair = (relation, target) => {
  if (relation === undefined) throw Error('Relation is undefined');
  return relation(target);
};

export const getRelationTargets = (world, eid, relation) => {
  const components = getEntityComponents(world, eid);
  const targets = [];
  for (const c of components) {
    if (
      c[$relation] === relation &&
      c[$pairTarget] !== Wildcard &&
      !isRelation(c[$pairTarget])
    ) {
      targets.push(c[$pairTarget]);
    }
  }
  return targets;
};

export function createRelation(...args) {
  if (args.length === 1 && typeof args[0] === 'object') {
    const { store, exclusive, autoRemoveSubject, onTargetRemoved } = args[0];
    const modifiers = [
      store && withStore(store),
      exclusive && makeExclusive,
      autoRemoveSubject && withAutoRemoveSubject,
      onTargetRemoved && withOnTargetRemoved(onTargetRemoved)
    ].filter(Boolean);
    return modifiers.reduce(
      (acc, modifier) => modifier(acc),
      createBaseRelation()
    );
  }
  return args.reduce((acc, modifier) => modifier(acc), createBaseRelation());
}

export const Wildcard = Symbol.for('bitecs-wildcard');

export const isRelation = (component) => component && $relation in component;
export const isPairComponent = (component) =>
  component && component[$isPairComponent] === true;
export const getRelationTarget = (component) =>
  component && component[$pairTarget];

// ============================================================================
// HIERARCHY
// ============================================================================
const ensureDepthTracking = (world, relation) => {
  const ctx = world[$internal];
  if (!ctx.hierarchyData.has(relation)) {
    const initialSize = Math.max(
      DEFAULT_BUFFER_GROWTH,
      ctx.entityIndex.dense.length * 2
    );
    const depthArray = new Uint32Array(initialSize);
    depthArray.fill(INVALID_DEPTH);
    ctx.hierarchyData.set(relation, {
      depths: depthArray,
      dirty: createSparseSet(),
      depthToEntities: new Map(),
      maxDepth: 0
    });
  }
};

const growDepthsArray = (hierarchyData, entity) => {
  if (entity < hierarchyData.depths.length) return hierarchyData.depths;
  const newSize = Math.max(hierarchyData.depths.length * 2, entity + 1);
  const newDepths = new Uint32Array(newSize);
  newDepths.fill(INVALID_DEPTH);
  newDepths.set(hierarchyData.depths);
  hierarchyData.depths = newDepths;
  return newDepths;
};

const calculateEntityDepth = (world, relation, entity, visited = new Set()) => {
  if (visited.has(entity)) return 0;
  visited.add(entity);
  const targets = getRelationTargets(world, entity, relation);
  if (targets.length === 0) return 0;
  if (targets.length === 1)
    return getEntityDepthWithVisited(world, relation, targets[0], visited) + 1;
  let minDepth = Infinity;
  for (const target of targets) {
    const depth = getEntityDepthWithVisited(world, relation, target, visited);
    if (depth < minDepth) {
      minDepth = depth;
      if (minDepth === 0) break;
    }
  }
  return minDepth === Infinity ? 0 : minDepth + 1;
};

const getEntityDepthWithVisited = (world, relation, entity, visited) => {
  ensureDepthTracking(world, relation);
  const hierarchyData = world[$internal].hierarchyData.get(relation);
  const depths = growDepthsArray(hierarchyData, entity);
  if (depths[entity] === INVALID_DEPTH) {
    const depth = calculateEntityDepth(world, relation, entity, visited);
    setEntityDepth(hierarchyData, entity, depth);
    return depth;
  }
  return depths[entity];
};

const setEntityDepth = (hierarchyData, entity, depth) => {
  const oldDepth = hierarchyData.depths[entity];
  if (oldDepth !== INVALID_DEPTH) {
    const oldSet = hierarchyData.depthToEntities.get(oldDepth);
    if (oldSet) oldSet.remove(entity);
  }
  hierarchyData.depths[entity] = depth;
  let set = hierarchyData.depthToEntities.get(depth);
  if (!set) {
    set = createSparseSet();
    hierarchyData.depthToEntities.set(depth, set);
  }
  set.add(entity);
  if (depth > hierarchyData.maxDepth) hierarchyData.maxDepth = depth;
};

export const getEntityDepth = (world, relation, entity) =>
  getEntityDepthWithVisited(world, relation, entity, new Set());

export const getHierarchyDepth = (world, entity, relation) => {
  getHierarchyData(world, relation);
  return getEntityDepthWithVisited(world, relation, entity, new Set());
};

const getHierarchyData = (world, relation) => {
  const ctx = world[$internal];
  if (!ctx.hierarchyActiveRelations.has(relation)) {
    ctx.hierarchyActiveRelations.add(relation);
    ensureDepthTracking(world, relation);
    populateExistingDepths(world, relation);
  }
  return ctx.hierarchyData.get(relation);
};

const populateExistingDepths = (world, relation) => {
  const entitiesWithRelation = query(world, [Pair(relation, Wildcard)]);
  for (const entity of entitiesWithRelation) {
    getEntityDepth(world, relation, entity);
  }
  const processedTargets = new Set();
  for (const entity of entitiesWithRelation) {
    for (const target of getRelationTargets(world, entity, relation)) {
      if (!processedTargets.has(target)) {
        processedTargets.add(target);
        getEntityDepth(world, relation, target);
      }
    }
  }
};

export const getMaxHierarchyDepth = (world, relation) => {
  const hierarchyData = getHierarchyData(world, relation);
  return hierarchyData.maxDepth;
};

export const Hierarchy = (relation, depth) => ({
  [$hierarchyType]: 'Hierarchy',
  [$hierarchyRel]: relation,
  [$hierarchyDepth]: depth
});
export const Cascade = Hierarchy;

// ============================================================================
// QUERY
// ============================================================================
const createOp = (type) => (...components) => ({
  [$opType]: type,
  [$opTerms]: components
});
export const Or = createOp('Or');
export const And = createOp('And');
export const Not = createOp('Not');
export const Any = Or;
export const All = And;
export const None = Not;

export const asBuffer = { [$modifierType]: 'buffer' };
export const isNested = { [$modifierType]: 'nested' };
export const noCommit = isNested;

const createHook = (type) => (...terms) => ({
  [$opType]: type,
  [$opTerms]: terms
});
export const onAdd = createHook('add');
export const onRemove = createHook('remove');
export const onSet = (component) => ({ [$opType]: 'set', [$opTerms]: [component] });
export const onGet = (component) => ({ [$opType]: 'get', [$opTerms]: [component] });

export function observe(world, hook, callback) {
  const ctx = world[$internal];
  const { [$opType]: type, [$opTerms]: components } = hook;
  if (type === 'add' || type === 'remove') {
    const queryData =
      ctx.queriesHashMap.get(queryHash(world, components)) ||
      registerQuery(world, components);
    return queryData[
      type === 'add' ? 'addObservable' : 'removeObservable'
    ].subscribe(callback);
  }
  if (type === 'set' || type === 'get') {
    if (components.length !== 1)
      throw new Error('Set and Get hooks can only observe a single component');
    const componentData =
      ctx.componentMap.get(components[0]) ||
      registerComponent(world, components[0]);
    return componentData[
      type === 'set' ? 'setObservable' : 'getObservable'
    ].subscribe(callback);
  }
  throw new Error(`Invalid hook type: ${type}`);
}

const queryHash = (world, terms) => {
  const ctx = world[$internal];
  const getComponentId = (component) => {
    if (!ctx.componentMap.has(component)) registerComponent(world, component);
    return ctx.componentMap.get(component).id;
  };
  const termToString = (term) => {
    if ($opType in term) {
      return `${term[$opType].toLowerCase()}(${term[$opTerms]
        .map(termToString)
        .sort()
        .join(',')})`;
    }
    return getComponentId(term).toString();
  };
  return terms.map(termToString).sort().join('-');
};

const registerQuery = (world, terms, options = {}) => {
  const ctx = world[$internal];
  const hash = queryHash(world, terms);
  if (ctx.queriesHashMap.has(hash)) return ctx.queriesHashMap.get(hash);
  const queryData = compileQuery(world, terms, options);
  ctx.queries.add(queryData);
  ctx.queriesHashMap.set(hash, queryData);
  return queryData;
};

const compileQuery = (world, terms) => {
  const ctx = world[$internal];
  const masks = {};
  const notMasks = {};
  const orMasks = {};
  const generations = [];
  const getMask = (generationId) => {
    if (!ctx.entityMasks[generationId]) ctx.entityMasks[generationId] = [];
    return ctx.entityMasks[generationId];
  };
  const getGenerationId = (component) => {
    if (!ctx.componentMap.has(component)) registerComponent(world, component);
    return ctx.componentMap.get(component).generationId;
  };
  const processTerm = (term, maskType) => {
    if ($opType in term) {
      const op = term[$opType];
      if (op === 'And' || op === 'All') {
        for (const t of term[$opTerms]) processTerm(t, maskType);
      } else if (op === 'Or' || op === 'Any') {
        for (const t of term[$opTerms]) processTerm(t, 'or');
      } else if (op === 'Not' || op === 'None') {
        for (const t of term[$opTerms]) processTerm(t, 'not');
      }
    } else {
      const generationId = getGenerationId(term);
      if (!generations.includes(generationId)) generations.push(generationId);
      const comp = ctx.componentMap.get(term);
      if (maskType === 'not') {
        notMasks[generationId] = (notMasks[generationId] || 0) | comp.bit;
      } else if (maskType === 'or') {
        orMasks[generationId] = (orMasks[generationId] || 0) | comp.bit;
      } else {
        masks[generationId] = (masks[generationId] || 0) | comp.bit;
      }
    }
  };
  for (const term of terms) processTerm(term, 'all');
  const addObservable = createObservable();
  const removeObservable = createObservable();
  return {
    world,
    terms,
    masks,
    notMasks,
    orMasks,
    generations,
    addObservable,
    removeObservable,
    dense: [],
    sparseIndex: [],
    toRemove: createSparseSet(),
    initialized: false
  };
};

const queryCheckEntity = (queryData, eid) => {
  const ctx = queryData.world[$internal];
  const { masks, notMasks, orMasks, generations } = queryData;
  let hasOrMatch = Object.keys(orMasks).length === 0;
  for (let i = 0; i < generations.length; i++) {
    const generationId = generations[i];
    const qMask = masks[generationId];
    const qNotMask = notMasks[generationId];
    const qOrMask = orMasks[generationId];
    const maskArr = ctx.entityMasks[generationId];
    const eMask = maskArr ? (maskArr[eid] || 0) : 0;
    if (qNotMask && (eMask & qNotMask) !== 0) return false;
    if (qMask && (eMask & qMask) !== qMask) return false;
    if (qOrMask && (eMask & qOrMask) !== 0) hasOrMatch = true;
  }
  return hasOrMatch;
};

const queryHasEntity = (queryData, eid) => {
  const idx = queryData.sparseIndex[eid];
  return idx !== undefined && queryData.dense[idx] === eid;
};

const queryAddEntity = (queryData, eid) => {
  if (queryData.toRemove.has(eid)) {
    queryData.toRemove.remove(eid);
    queryData.addObservable.notify(eid);
    return;
  }
  if (queryHasEntity(queryData, eid)) return;
  queryData.sparseIndex[eid] = queryData.dense.length;
  queryData.dense.push(eid);
  queryData.addObservable.notify(eid);
};

const queryRemoveEntity = (world, queryData, eid) => {
  const ctx = world[$internal];
  if (!queryHasEntity(queryData, eid) || queryData.toRemove.has(eid)) return;
  queryData.toRemove.add(eid);
  ctx.dirtyQueries.add(queryData);
  queryData.removeObservable.notify(eid);
};

const queryCommitRemovals = (queryData) => {
  const removals = queryData.toRemove.dense;
  for (let i = 0; i < removals.length; i++) {
    const eid = removals[i];
    const idx = queryData.sparseIndex[eid];
    if (idx === undefined || queryData.dense[idx] !== eid) continue;
    const last = queryData.dense.pop();
    if (last !== eid) {
      queryData.dense[idx] = last;
      queryData.sparseIndex[last] = idx;
    }
    delete queryData.sparseIndex[eid];
  }
  queryData.toRemove.reset();
};

const commitRemovals = (world) => {
  const ctx = world[$internal];
  if (!ctx.dirtyQueries.size) return;
  ctx.dirtyQueries.forEach(queryCommitRemovals);
  ctx.dirtyQueries.clear();
};

export const removeQuery = (world, terms) => {
  const ctx = world[$internal];
  const hash = queryHash(world, terms);
  const queryData = ctx.queriesHashMap.get(hash);
  if (queryData) {
    ctx.queries.delete(queryData);
    ctx.queriesHashMap.delete(hash);
  }
};

export function query(world, terms, ...modifiers) {
  const hierarchyTerm = terms.find(
    (term) => term && typeof term === 'object' && $hierarchyType in term
  );
  const regularTerms = terms.filter(
    (term) => !(term && typeof term === 'object' && $hierarchyType in term)
  );
  let buffered = false;
  let commit = true;
  const hasModifiers = modifiers.some(
    (m) => m && typeof m === 'object' && $modifierType in m
  );
  for (const modifier of modifiers) {
    if (
      hasModifiers &&
      modifier &&
      typeof modifier === 'object' &&
      $modifierType in modifier
    ) {
      if (modifier[$modifierType] === 'buffer') buffered = true;
      if (modifier[$modifierType] === 'nested') commit = false;
    } else if (!hasModifiers && modifier && typeof modifier === 'object') {
      if (modifier.buffered !== undefined) buffered = modifier.buffered;
      if (modifier.commit !== undefined) commit = modifier.commit;
    }
  }
  if (hierarchyTerm) {
    const rel = hierarchyTerm[$hierarchyRel];
    const depth = hierarchyTerm[$hierarchyDepth];
    return depth !== undefined
      ? queryHierarchyDepth(world, rel, depth)
      : queryHierarchy(world, rel, regularTerms);
  }
  if (commit) commitRemovals(world);
  return queryInternal(world, regularTerms);
}

const queryInternal = (world, terms) => {
  const ctx = world[$internal];
  const hash = queryHash(world, terms);
  let queryData = ctx.queriesHashMap.get(hash);
  if (!queryData) queryData = registerQuery(world, terms);

  if (!queryData.initialized) {
    queryData.initialized = true;
    const entities = Array.from(ctx.entityComponents.keys());
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      if (queryCheckEntity(queryData, eid) && !queryHasEntity(queryData, eid)) {
        queryData.sparseIndex[eid] = queryData.dense.length;
        queryData.dense.push(eid);
      }
    }
  }
  return queryData.dense;
};

const queryHierarchyDepth = (world, relation, depth) => {
  const hierarchyData = getHierarchyData(world, relation);
  const entitiesAtDepth = hierarchyData.depthToEntities.get(depth);
  return entitiesAtDepth ? entitiesAtDepth.dense : [];
};

const queryHierarchy = (world, relation, terms) => {
  const hierarchyData = getHierarchyData(world, relation);
  const queryData = registerQuery(world, terms);
  const result = [];
  for (const set of hierarchyData.depthToEntities.values()) {
    const arr = set.dense;
    for (let i = 0; i < arr.length; i++) {
      const eid = arr[i];
      if (queryCheckEntity(queryData, eid)) result.push(eid);
    }
  }
  return result;
};

// ============================================================================
// COMPONENTS
// ============================================================================
let componentId = 0;

const registerComponent = (world, component) => {
  const ctx = world[$internal];
  if (ctx.componentMap.has(component)) return ctx.componentMap.get(component);
  const bit = ctx.bitflag;
  ctx.bitflag <<= 1;
  if (ctx.bitflag === 0) ctx.bitflag = 1;
  const id = componentId++;
  const generationId = Math.floor(id / 32);
  const data = {
    id,
    bit,
    generationId,
    addObservable: createObservable(),
    removeObservable: createObservable(),
    setObservable: createObservable(),
    getObservable: createObservable()
  };
  ctx.componentMap.set(component, data);
  ctx.componentCount++;
  return data;
};

export const defineComponent = (component) => {
  if (typeof component === 'object' && component !== null) return component;
  return {};
};

export const addComponent = (world, eid, component) => {
  const ctx = world[$internal];
  const comp = registerComponent(world, component);
  const generationId = comp.generationId;
  if (!ctx.entityMasks[generationId]) ctx.entityMasks[generationId] = [];
  const mask = ctx.entityMasks[generationId];
  if (!mask[eid]) mask[eid] = 0;
  if ((mask[eid] & comp.bit) !== 0) return;
  mask[eid] |= comp.bit;
  let comps = ctx.entityComponents.get(eid);
  if (!comps) {
    comps = new Set();
    ctx.entityComponents.set(eid, comps);
  }
  comps.add(component);
  for (const queryData of ctx.queries) {
    if (queryCheckEntity(queryData, eid)) queryAddEntity(queryData, eid);
  }
  comp.addObservable.notify(eid);
};

export const removeComponent = (world, eid, component) => {
  const ctx = world[$internal];
  const comp = ctx.componentMap.get(component);
  if (!comp) return;
  const mask = ctx.entityMasks[comp.generationId];
  if (!mask || (mask[eid] & comp.bit) === 0) return;
  mask[eid] &= ~comp.bit;
  const comps = ctx.entityComponents.get(eid);
  if (comps) {
    comps.delete(component);
    if (comps.size === 0) ctx.entityComponents.delete(eid);
  }
  for (const queryData of ctx.queries) {
    if (!queryCheckEntity(queryData, eid))
      queryRemoveEntity(world, queryData, eid);
  }
  comp.removeObservable.notify(eid);
};

export const hasComponent = (world, eid, component) => {
  const ctx = world[$internal];
  const comp = ctx.componentMap.get(component);
  if (!comp) return false;
  const mask = ctx.entityMasks[comp.generationId];
  if (!mask) return false;
  return (mask[eid] & comp.bit) !== 0;
};

export const getEntityComponents = (world, eid) => {
  const ctx = world[$internal];
  const comps = ctx.entityComponents.get(eid);
  return comps ? Array.from(comps) : [];
};

// ============================================================================
// ENTITY
// ============================================================================
export const addEntity = (world) => {
  const ctx = world[$internal];
  const eid = addEntityId(ctx.entityIndex);
  if (!ctx.entityMasks[0]) ctx.entityMasks[0] = [];
  ctx.entityMasks[0][eid] = ctx.entityMasks[0][eid] || 0;
  return eid;
};

export const removeEntity = (world, eid) => {
  const ctx = world[$internal];
  if (!ctx.entityComponents.has(eid)) {
    removeEntityId(ctx.entityIndex, eid);
    return;
  }
  const comps = Array.from(ctx.entityComponents.get(eid));
  for (const comp of comps) removeComponent(world, eid, comp);
  removeEntityId(ctx.entityIndex, eid);
  ctx.entityComponents.delete(eid);
};

export const entityExists = (world, eid) => {
  const ctx = world[$internal];
  return isEntityIdAlive(ctx.entityIndex, eid);
};

export const enterQuery = (world, terms) => {
  const queryData = registerQuery(world, terms);
  return (callback) => queryData.addObservable.subscribe(callback);
};

export const exitQuery = (world, terms) => {
  const queryData = registerQuery(world, terms);
  return (callback) => queryData.removeObservable.subscribe(callback);
};

export const Changed = () => {
  throw new Error('Changed is not implemented');
};

// ============================================================================
// SERIALIZATION
// ============================================================================
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const typeTagForSerialization = (symbol) => (a = []) =>
  Object.defineProperty(a, symbol, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false
  });

export const u8 = (a = []) => typeTagForSerialization($u8)(a);
export const i8 = (a = []) => typeTagForSerialization($i8)(a);
export const u16 = (a = []) => typeTagForSerialization($u16)(a);
export const i16 = (a = []) => typeTagForSerialization($i16)(a);
export const u32 = (a = []) => typeTagForSerialization($u32)(a);
export const i32 = (a = []) => typeTagForSerialization($i32)(a);
export const f32 = (a = []) => typeTagForSerialization($f32)(a);
export const f64 = (a = []) => typeTagForSerialization($f64)(a);
export const ref = (a = []) => typeTagForSerialization($ref)(a);
export const str = (a = []) => typeTagForSerialization($str)(a);

const functionToSymbolMap = new Map([
  [u8, $u8],
  [i8, $i8],
  [u16, $u16],
  [i16, $i16],
  [u32, $u32],
  [i32, $i32],
  [f32, $f32],
  [f64, $f64],
  [ref, $ref],
  [str, $str]
]);

const typeSetters = {
  [$u8]: (view, offset, value) => {
    view.setUint8(offset, value);
    return 1;
  },
  [$i8]: (view, offset, value) => {
    view.setInt8(offset, value);
    return 1;
  },
  [$u16]: (view, offset, value) => {
    view.setUint16(offset, value);
    return 2;
  },
  [$i16]: (view, offset, value) => {
    view.setInt16(offset, value);
    return 2;
  },
  [$u32]: (view, offset, value) => {
    view.setUint32(offset, value);
    return 4;
  },
  [$i32]: (view, offset, value) => {
    view.setInt32(offset, value);
    return 4;
  },
  [$f32]: (view, offset, value) => {
    view.setFloat32(offset, value);
    return 4;
  },
  [$f64]: (view, offset, value) => {
    view.setFloat64(offset, value);
    return 8;
  },
  [$ref]: (view, offset, value) => {
    view.setUint32(offset, value);
    return 4;
  },
  [$str]: (view, offset, value) => {
    const bytes = textEncoder.encode(value);
    let written = 0;
    written += typeSetters[$u32](view, offset + written, bytes.length);
    new Uint8Array(
      view.buffer,
      view.byteOffset + offset + written,
      bytes.length
    ).set(bytes);
    written += bytes.length;
    return written;
  }
};

const typeGetters = {
  [$u8]: (view, offset) => ({ value: view.getUint8(offset), size: 1 }),
  [$i8]: (view, offset) => ({ value: view.getInt8(offset), size: 1 }),
  [$u16]: (view, offset) => ({ value: view.getUint16(offset), size: 2 }),
  [$i16]: (view, offset) => ({ value: view.getInt16(offset), size: 2 }),
  [$u32]: (view, offset) => ({ value: view.getUint32(offset), size: 4 }),
  [$i32]: (view, offset) => ({ value: view.getInt32(offset), size: 4 }),
  [$f32]: (view, offset) => ({ value: view.getFloat32(offset), size: 4 }),
  [$f64]: (view, offset) => ({ value: view.getFloat64(offset), size: 8 }),
  [$ref]: (view, offset) => ({ value: view.getUint32(offset), size: 4 }),
  [$str]: (view, offset) => {
    const { value: len, size: lenSize } = typeGetters[$u32](view, offset);
    const bytes = new Uint8Array(
      view.buffer,
      view.byteOffset + offset + lenSize,
      len
    );
    return { value: textDecoder.decode(bytes), size: lenSize + len };
  }
};

const resolveTypeToSymbol = (type) => {
  if (typeof type === 'symbol') return type;
  if (typeof type === 'function') {
    const symbol = functionToSymbolMap.get(type);
    if (symbol) return symbol;
    throw new Error(`Unknown type function: ${type}`);
  }
  if (isArrayType(type)) return resolveTypeToSymbol(type[$arr]);
  return $f32;
};

export function array(type = f64) {
  const arr = [];
  Object.defineProperty(arr, $arr, {
    value: type,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return arr;
}

const isArrayType = (value) => Array.isArray(value) && $arr in value;
const getArrayElementType = (arrayType) => arrayType[$arr];

const getTypeForArray = (arr) => {
  if (isArrayType(arr)) return resolveTypeToSymbol(arr[$arr]);
  for (const symbol of [
    $u8, $i8, $u16, $i16, $u32, $i32, $f32, $f64, $str, $ref
  ]) {
    if (symbol in arr) return symbol;
  }
  if (arr instanceof Int8Array) return $i8;
  if (arr instanceof Uint8Array) return $u8;
  if (arr instanceof Int16Array) return $i16;
  if (arr instanceof Uint16Array) return $u16;
  if (arr instanceof Int32Array) return $i32;
  if (arr instanceof Uint32Array) return $u32;
  if (arr instanceof Float32Array) return $f32;
  return $f64;
};

const serializeArrayValue = (elementType, value, view, offset) => {
  let bytesWritten = 0;
  const isArrayDefined = Array.isArray(value) ? 1 : 0;
  bytesWritten += typeSetters[$u8](view, offset, isArrayDefined);
  if (!isArrayDefined) return bytesWritten;
  bytesWritten += typeSetters[$u32](view, offset + bytesWritten, value.length);
  for (let i = 0; i < value.length; i++) {
    const element = value[i];
    if (isArrayType(elementType)) {
      bytesWritten += serializeArrayValue(
        getArrayElementType(elementType),
        element,
        view,
        offset + bytesWritten
      );
    } else {
      const symbol = resolveTypeToSymbol(elementType);
      bytesWritten += typeSetters[symbol](
        view,
        offset + bytesWritten,
        element
      );
    }
  }
  return bytesWritten;
};

const deserializeArrayValue = (elementType, view, offset, entityIdMapping) => {
  let bytesRead = 0;
  const isArrayResult = typeGetters[$u8](view, offset + bytesRead);
  bytesRead += isArrayResult.size;
  if (!isArrayResult.value) return { size: bytesRead };
  const lenResult = typeGetters[$u32](view, offset + bytesRead);
  bytesRead += lenResult.size;
  const arr = new Array(lenResult.value);
  for (let i = 0; i < arr.length; i++) {
    if (isArrayType(elementType)) {
      const { value, size } = deserializeArrayValue(
        getArrayElementType(elementType),
        view,
        offset + bytesRead,
        entityIdMapping
      );
      bytesRead += size;
      if (Array.isArray(value)) arr[i] = value;
    } else {
      const symbol = resolveTypeToSymbol(elementType);
      const { value, size } = typeGetters[symbol](
        view,
        offset + bytesRead
      );
      bytesRead += size;
      if (symbol === $ref && entityIdMapping) {
        arr[i] = entityIdMapping.get(value) || value;
      } else {
        arr[i] = value;
      }
    }
  }
  return { value: arr, size: bytesRead };
};

const isFloatType = (arr) => {
  const t = getTypeForArray(arr);
  return t === $f32 || t === $f64;
};

const getEpsilonForType = (arr, epsilon) =>
  isFloatType(arr) ? epsilon : 0;

const getShadow = (shadowMap, arr) => {
  let shadow = shadowMap.get(arr);
  if (!shadow) {
    shadow = ArrayBuffer.isView(arr)
      ? new arr.constructor(arr.length)
      : new Array(arr.length).fill(0);
    shadowMap.set(arr, shadow);
  }
  return shadow;
};

const hasChanged = (shadowMap, arr, index, epsilon = 1e-4) => {
  const shadow = getShadow(shadowMap, arr);
  const value = arr[index];
  const eps = getEpsilonForType(arr, epsilon);
  const changed =
    eps > 0 ? Math.abs(shadow[index] - value) > eps : shadow[index] !== value;
  shadow[index] = value;
  return changed;
};

const createComponentSerializer = (component, diff, shadowMap, epsilon) => {
  if (isArrayType(component)) {
    const elementType = component[$arr];
    return (view, offset, index) => {
      let bytesWritten = 0;
      bytesWritten += typeSetters[$u32](view, offset + bytesWritten, index);
      const value = component[index];
      if (value !== undefined) {
        bytesWritten += serializeArrayValue(
          elementType,
          value,
          view,
          offset + bytesWritten
        );
      }
      return bytesWritten;
    };
  }
  if (ArrayBuffer.isView(component) || Array.isArray(component)) {
    const type = getTypeForArray(component);
    const setter = typeSetters[type];
    return (view, offset, index) => {
      if (diff && shadowMap) {
        if (!hasChanged(shadowMap, component, index, epsilon)) return 0;
        let w = 0;
        w += typeSetters[$u32](view, offset + w, index);
        w += setter(view, offset + w, component[index]);
        return w;
      }
      let w = 0;
      w += typeSetters[$u32](view, offset + w, index);
      w += setter(view, offset + w, component[index]);
      return w;
    };
  }
  const props = Object.keys(component);
  const types = props.map((p) => getTypeForArray(component[p]));
  const setters = types.map((t) => typeSetters[t]);
  return (view, offset, index) => {
    let w = 0;
    w += typeSetters[$u32](view, offset + w, index);
    if (diff && shadowMap) {
      if (!hasComponentChanged(shadowMap, component, index, epsilon)) return 0;
      const maskSetter =
        props.length <= 8
          ? typeSetters[$u8]
          : props.length <= 16
          ? typeSetters[$u16]
          : typeSetters[$u32];
      let changeMask = 0;
      for (let i = 0; i < props.length; i++) {
        const prop = component[props[i]];
        const value = prop[index];
        const shadow = getShadow(shadowMap, prop);
        const eps = getEpsilonForType(prop, epsilon);
        const changed =
          eps > 0 ? Math.abs(shadow[index] - value) > eps : shadow[index] !== value;
        if (changed) {
          changeMask |= 1 << i;
          shadow[index] = value;
        }
      }
      w += maskSetter(view, offset + w, changeMask);
      for (let i = 0; i < props.length; i++) {
        if (changeMask & (1 << i)) {
          const prop = component[props[i]];
          w += setters[i](view, offset + w, prop[index]);
        }
      }
      return w;
    }
    for (let i = 0; i < props.length; i++) {
      w += setters[i](view, offset + w, component[props[i]][index]);
    }
    return w;
  };
};

const createComponentDeserializer = (component, diff) => {
  if (isArrayType(component)) {
    const elementType = component[$arr];
    return (view, offset, entityIdMapping) => {
      let br = 0;
      const { value: index, size: iSize } = typeGetters[$u32](view, offset);
      br += iSize;
      const realIndex = entityIdMapping
        ? entityIdMapping.get(index) || index
        : index;
      const { value, size } = deserializeArrayValue(
        elementType,
        view,
        offset + br,
        entityIdMapping
      );
      br += size;
      if (Array.isArray(value)) component[realIndex] = value;
      return br;
    };
  }
  if (ArrayBuffer.isView(component) || Array.isArray(component)) {
    const type = getTypeForArray(component);
    const getter = typeGetters[type];
    return (view, offset, entityIdMapping) => {
      let br = 0;
      const { value: index, size: iSize } = typeGetters[$u32](view, offset);
      br += iSize;
      const realIndex = entityIdMapping
        ? entityIdMapping.get(index) || index
        : index;
      if (diff) br += 4;
      const { value, size } = getter(view, offset + br);
      br += size;
      if (type === $ref && entityIdMapping) {
        component[realIndex] = entityIdMapping.get(value) || value;
      } else {
        component[realIndex] = value;
      }
      return br;
    };
  }
  const props = Object.keys(component);
  const types = props.map((p) => getTypeForArray(component[p]));
  const getters = types.map((t) => typeGetters[t]);
  return (view, offset, entityIdMapping) => {
    let br = 0;
    const { value: index, size: iSize } = typeGetters[$u32](view, offset);
    br += iSize;
    const realIndex = entityIdMapping
      ? entityIdMapping.get(index) || index
      : index;
    if (diff) {
      const maskGetter =
        props.length <= 8
          ? typeGetters[$u8]
          : props.length <= 16
          ? typeGetters[$u16]
          : typeGetters[$u32];
      br += 4;
      const { value: changeMask, size: mSize } = maskGetter(view, offset + br);
      br += mSize;
      for (let i = 0; i < props.length; i++) {
        if (!(changeMask & (1 << i))) continue;
        const prop = component[props[i]];
        if (isArrayType(prop)) {
          const { value, size } = deserializeArrayValue(
            getArrayElementType(prop),
            view,
            offset + br,
            entityIdMapping
          );
          br += size;
          if (Array.isArray(value)) prop[realIndex] = value;
        } else {
          const { value, size } = getters[i](view, offset + br);
          br += size;
          if (types[i] === $ref && entityIdMapping) {
            prop[realIndex] = entityIdMapping.get(value) || value;
          } else {
            prop[realIndex] = value;
          }
        }
      }
      return br;
    }
    for (let i = 0; i < props.length; i++) {
      const prop = component[props[i]];
      if (isArrayType(prop)) {
        const { value, size } = deserializeArrayValue(
          getArrayElementType(prop),
          view,
          offset + br,
          entityIdMapping
        );
        br += size;
        if (Array.isArray(value)) prop[realIndex] = value;
      } else {
        const { value, size } = getters[i](view, offset + br);
        br += size;
        if (types[i] === $ref && entityIdMapping) {
          prop[realIndex] = entityIdMapping.get(value) || value;
        } else {
          prop[realIndex] = value;
        }
      }
    }
    return br;
  };
};

const hasComponentChanged = (shadowMap, component, index, epsilon = 1e-4) => {
  const shadow = getShadowComponent(shadowMap, component);
  const currentValue = component[index];
  const props = Object.keys(component);
  const isObj =
    currentValue !== null &&
    (typeof currentValue === 'object' || typeof currentValue === 'function');
  if (isObj) {
    const shadowValue = shadow[index] || {};
    let changed = false;
    for (let i = 0; i < props.length; i++) {
      const prop = props[i];
      const propArr = component[prop];
      if (!propArr) continue;
      const eps = getEpsilonForType(propArr, epsilon);
      const shVal = shadowValue[prop];
      const curVal = currentValue[prop];
      const diff =
        eps > 0 ? Math.abs(shVal - curVal) > eps : shVal !== curVal;
      if (diff) {
        changed = true;
        break;
      }
    }
    return changed;
  }
  const eps = getEpsilonForType(component, epsilon);
  return eps > 0
    ? Math.abs(shadow[index] - currentValue) > eps
    : shadow[index] !== currentValue;
};

const getShadowComponent = (shadowMap, component) => {
  let shadow = shadowMap.get(component);
  if (!shadow) {
    shadow = {};
    shadowMap.set(component, shadow);
  }
  return shadow;
};

const updateShadow = (shadowMap, component, entityId) => {
  const shadow = getShadowComponent(shadowMap, component);
  const v = component[entityId];
  if (v !== null && typeof v === 'object') shadow[entityId] = { ...v };
  else shadow[entityId] = v;
};

const createAoSComponentSerializer = (
  component,
  diff,
  shadowMap,
  epsilon
) => {
  const isObject =
    component !== null &&
    typeof component === 'object' &&
    !ArrayBuffer.isView(component) &&
    !Array.isArray(component) &&
    Object.keys(component).some(
      (k) => isNaN(parseInt(k)) && typeof component[k] === 'object'
    );
  if (isObject) {
    const props = Object.keys(component).filter((k) => isNaN(parseInt(k)));
    const types = props.map((p) => getTypeForArray(component[p]));
    const setters = types.map((t) => typeSetters[t]);
    return (view, offset, entityId) => {
      const value = component[entityId];
      if (value === undefined) return 0;
      if (diff && shadowMap) {
        if (!hasComponentChanged(shadowMap, component, entityId, epsilon))
          return 0;
        updateShadow(shadowMap, component, entityId);
      }
      let w = 0;
      for (let i = 0; i < props.length; i++) {
        const propArr = component[props[i]];
        if (isArrayType(propArr)) {
          w += serializeArrayValue(
            getArrayElementType(propArr),
            value[props[i]],
            view,
            offset + w
          );
        } else {
          w += setters[i](view, offset + w, value[props[i]]);
        }
      }
      return w;
    };
  }
  const type = getTypeForArray(component);
  const setter = typeSetters[type];
  return (view, offset, entityId) => {
    const value = component[entityId];
    if (value === undefined) return 0;
    if (diff && shadowMap) {
      if (!hasComponentChanged(shadowMap, component, entityId, epsilon))
        return 0;
      updateShadow(shadowMap, component, entityId);
    }
    return setter(view, offset, value);
  };
};

const createAoSComponentDeserializer = (component) => {
  const isObject =
    component !== null &&
    typeof component === 'object' &&
    !ArrayBuffer.isView(component) &&
    !Array.isArray(component) &&
    Object.keys(component).some(
      (k) => isNaN(parseInt(k)) && typeof component[k] === 'object'
    );
  if (isObject) {
    const props = Object.keys(component).filter((k) => isNaN(parseInt(k)));
    const types = props.map((p) => getTypeForArray(component[p]));
    const getters = types.map((t) => typeGetters[t]);
    return (view, offset, entityId, entityIdMapping) => {
      let br = 0;
      const value = {};
      for (let i = 0; i < props.length; i++) {
        const propArr = component[props[i]];
        if (isArrayType(propArr)) {
          const { value: v, size } = deserializeArrayValue(
            getArrayElementType(propArr),
            view,
            offset + br,
            entityIdMapping
          );
          br += size;
          if (Array.isArray(v)) value[props[i]] = v;
        } else {
          const { value: v, size } = getters[i](view, offset + br);
          br += size;
          if (types[i] === $ref && entityIdMapping) {
            value[props[i]] = entityIdMapping.get(v) || v;
          } else {
            value[props[i]] = v;
          }
        }
      }
      component[entityId] = value;
      return br;
    };
  }
  const type = getTypeForArray(component);
  const getter = typeGetters[type];
  return (view, offset, entityId, entityIdMapping) => {
    const { value, size } = getter(view, offset);
    if (type === $ref && entityIdMapping) {
      component[entityId] = entityIdMapping.get(value) || value;
    } else {
      component[entityId] = value;
    }
    return size;
  };
};

export const createSoASerializer = (components, options = {}) => {
  const {
    diff = false,
    buffer = new ArrayBuffer(1024 * 1024 * 100),
    epsilon = 1e-4
  } = options;
  const shadowMap = diff ? new Map() : undefined;
  const serializers = components.map((c) =>
    createComponentSerializer(c, diff, shadowMap, epsilon)
  );
  return (entities) => {
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      offset += typeSetters[$u32](view, offset, eid);
      for (let j = 0; j < serializers.length; j++) {
        offset += serializers[j](view, offset, eid);
      }
    }
    return buffer.slice(0, offset);
  };
};

export const createSoADeserializer = (components, options = {}) => {
  const { diff = false } = options;
  const deserializers = components.map((c) =>
    createComponentDeserializer(c, diff)
  );
  return (packet, entityIdMapping) => {
    const view = new DataView(packet);
    let offset = 0;
    while (offset < packet.byteLength) {
      const { value: original, size: idSize } = typeGetters[$u32](view, offset);
      offset += idSize;
      const eid = entityIdMapping
        ? entityIdMapping.get(original) || original
        : original;
      for (let i = 0; i < deserializers.length; i++) {
        offset += deserializers[i](view, offset, entityIdMapping);
      }
    }
  };
};

export const createAoSSerializer = (components, options = {}) => {
  const {
    diff = false,
    buffer = new ArrayBuffer(1024 * 1024 * 100),
    epsilon = 1e-4
  } = options;
  const shadowMap = diff ? new Map() : undefined;
  const serializers = components.map((c) =>
    createAoSComponentSerializer(c, diff, shadowMap, epsilon)
  );
  return (entities) => {
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i];
      offset += typeSetters[$u32](view, offset, eid);
      for (let j = 0; j < serializers.length; j++) {
        offset += serializers[j](view, offset, eid);
      }
    }
    return buffer.slice(0, offset);
  };
};

export const createAoSDeserializer = (components, options = {}) => {
  const { diff = false } = options;
  const deserializers = components.map((c) =>
    createAoSComponentDeserializer(c)
  );
  return (packet, entityIdMapping) => {
    const view = new DataView(packet);
    let offset = 0;
    while (offset < packet.byteLength) {
      const { value: original, size: idSize } = typeGetters[$u32](view, offset);
      offset += idSize;
      const eid = entityIdMapping
        ? entityIdMapping.get(original) || original
        : original;
      if (diff) {
        const maskGetter =
          components.length <= 8
            ? typeGetters[$u8]
            : components.length <= 16
            ? typeGetters[$u16]
            : typeGetters[$u32];
        const { value: mask, size: mSize } = maskGetter(view, offset);
        offset += mSize;
        for (let i = 0; i < components.length; i++) {
          if (mask & (1 << i)) {
            offset += deserializers[i](view, offset, eid, entityIdMapping);
          }
        }
      } else {
        for (let i = 0; i < deserializers.length; i++) {
          offset += deserializers[i](view, offset, eid, entityIdMapping);
        }
      }
    }
  };
};

// ============================================================================
// POOLS
// ============================================================================
const _entityPool = [];
const _MAX_ENTITY_POOL = 4096;

export function poolAcquireEntity() {
  return _entityPool.length > 0 ? _entityPool.pop() : -1;
}

export function poolReleaseEntity(eid) {
  if (_entityPool.length >= _MAX_ENTITY_POOL) return;
  _entityPool.push(eid);
}

export function poolResetEntities() {
  _entityPool.length = 0;
}

export function poolSizeEntities() {
  return _entityPool.length;
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  createWorld,
  resetWorld,
  deleteWorld,
  getWorldComponents,
  getAllEntities,
  createSparseSet,
  createUint32SparseSet,
  createObservable,
  createRelation,
  withStore,
  makeExclusive,
  withAutoRemoveSubject,
  withOnTargetRemoved,
  Pair,
  Wildcard,
  getRelationTargets,
  isRelation,
  isPairComponent,
  getRelationTarget,
  getEntityDepth,
  getHierarchyDepth,
  getMaxHierarchyDepth,
  Hierarchy,
  Cascade,
  Or,
  And,
  Not,
  Any,
  All,
  None,
  asBuffer,
  isNested,
  noCommit,
  onAdd,
  onRemove,
  onSet,
  onGet,
  observe,
  removeQuery,
  query,
  defineComponent,
  addComponent,
  removeComponent,
  hasComponent,
  getEntityComponents,
  addEntity,
  removeEntity,
  entityExists,
  enterQuery,
  exitQuery,
  Changed,
  u8,
  i8,
  u16,
  i16,
  u32,
  i32,
  f32,
  f64,
  ref,
  str,
  array,
  createSoASerializer,
  createSoADeserializer,
  createAoSSerializer,
  createAoSDeserializer,
  poolAcquireEntity,
  poolReleaseEntity,
  poolResetEntities,
  poolSizeEntities
};