// File number : 010
// File : src/math/010_bitECS_core.js
// Description : Full bitECS core (all original exports preserved) + glMatrix-math-powered
//               SOA systems for 1M+ entity worlds. Adds: SOA-backed components (TRS, RGBA,
//               velocity, quats, matrices), zero-GC SOA pools, chunked non-blocking entity
//               iteration (iterChunked / queryChunked / soaStepChunked), spatial grid +
//               typed-array buckets for 1M+ culling and procedural placement, instance-batch
//               renderer, procedural spawners (noise scatter, star/asteroid fields,
//               planets-from-orbit), per-entity animation with spring damping, natural IK
//               system (FABRIK + CCD), orbital system (Kepler integration for 1M+ bodies),
//               color system (hue/saturation/tone-map on 1M+ entities), and floating-origin
//               world for seamless mm to Mpc camera transitions.
// Best for : 3d graphics with bitECS -- procedural generation (1M+ asteroid/tree/particle
//            instanced fields from spatial noise, planetary surfaces, galaxy seeding),
//            rendering (per-instance TRS + normal-mapped batching, or per-entity draw with
//            1M+ entity culling via spatial grid), color (per-entity HDR, hue rotation,
//            tone-mapping of 1M+ instances at 60 fps), animation (spring-damped
//            position/rotation per entity), natural IK motion (FABRIK/CCD chains driven by
//            per-entity targets), orbital (Kepler-integrated moons/asteroids/satellites in
//            the same world as everything else), seamless small-to-galactic scale
//            (floating-origin recentering so Float32 positions remain precise from a forest
//            to a galaxy).
// License : MIT
//
// NOTE: Rewritten as a self-contained native ES module (no Vite / no Vue / no client build)
//       so it loads directly in the browser alongside Three.js r185. The previous CommonJS
//       build is removed. All features, functions and exports of the original are preserved.

// ============================================================================
// 0. MATH IMPORTS (all previously produced glMatrix-compatible ES modules)
// ============================================================================
import * as vec2 from "./002_vec2.js";
import * as vec3 from "./003_vec3.js";
import * as vec4 from "./004_vec4.js";
import * as mat2 from "./005_mat2.js";
import * as mat3 from "./006_mat3.js";
import * as mat4 from "./007_mat4.js";
import * as quat from "./008_quat.js";
import * as quat2 from "./009_quat2.js";

// ============================================================================
// 0b. FOUNDATION HELPERS (inlined, replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;

function yieldToMain() {
	return new Promise(function (resolve) {
		if (typeof setTimeout === "function") { setTimeout(resolve, 0); }
		else { resolve(); }
	});
}

// Deterministic 3D spatial hash returning [0,1]
function hash3(x, y, z) {
	var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2246822519)) | 0;
	h = (h ^ (h >>> 13)) | 0;
	h = Math.imul(h, 1274126177) | 0;
	h = (h ^ (h >>> 16)) >>> 0;
	return h / 4294967295;
}

// Deterministic seeded PRNG returning [0,1)
function mulberry32(seed) {
	var a = seed | 0;
	return function () {
		a |= 0;
		a = (a + 0x6D2B79F5) | 0;
		var t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function createPool(factory, capacity, reset) {
	capacity = capacity || 256;
	var items = [];
	for (var i = 0; i < capacity; i++) { items.push(factory()); }
	return {
		acquire: function () {
			return items.length > 0 ? items.pop() : factory();
		},
		release: function (v) {
			if (reset) { reset(v); }
			if (items.length < capacity) { items.push(v); }
		}
	};
}

// ============================================================================
// 1. INTERNAL UTILITIES (preserved from bitECS)
// ============================================================================
var defineHiddenProperty = function (obj, key, value) {
	return Object.defineProperty(obj, key, {
		value: value, enumerable: false, writable: true, configurable: true
	});
};

// ---- EntityIndex -----------------------------------------------------------
var getId = function (index, id) { return id & index.entityMask; };
var getVersion = function (index, id) { return id >>> index.versionShift & (1 << index.versionBits) - 1; };
var incrementVersion = function (index, id) {
	var currentVersion = getVersion(index, id);
	var newVersion = currentVersion + 1 & (1 << index.versionBits) - 1;
	return id & index.entityMask | newVersion << index.versionShift;
};
var withVersioning = function (versionBits) { return { versioning: true, versionBits: versionBits }; };
var createEntityIndex = function (options) {
	var config = options ? (typeof options === "function" ? options() : options) : { versioning: false, versionBits: 8 };
	var versionBits = config.versionBits != null ? config.versionBits : 8;
	var versioning = config.versioning != null ? config.versioning : false;
	var entityBits = 32 - versionBits;
	var entityMask = (1 << entityBits) - 1;
	var versionShift = entityBits;
	var versionMask = (1 << versionBits) - 1 << versionShift;
	return {
		aliveCount: 0, dense: [], sparse: [], maxId: 0,
		versioning: versioning, versionBits: versionBits,
		entityMask: entityMask, versionShift: versionShift, versionMask: versionMask
	};
};
var addEntityId = function (index) {
	if (index.aliveCount < index.dense.length) {
		var recycledId = index.dense[index.aliveCount];
		index.sparse[recycledId] = index.aliveCount;
		index.aliveCount++;
		return recycledId;
	}
	var id = ++index.maxId;
	index.dense.push(id);
	index.sparse[id] = index.aliveCount;
	index.aliveCount++;
	return id;
};
var removeEntityId = function (index, id) {
	var denseIndex = index.sparse[id];
	if (denseIndex === void 0 || denseIndex >= index.aliveCount) return;
	var lastIndex = index.aliveCount - 1;
	var lastId = index.dense[lastIndex];
	index.sparse[lastId] = denseIndex;
	index.dense[denseIndex] = lastId;
	index.sparse[id] = lastIndex;
	index.dense[lastIndex] = id;
	if (index.versioning) {
		var newId = incrementVersion(index, id);
		index.dense[lastIndex] = newId;
	}
	index.aliveCount--;
};
var isEntityIdAlive = function (index, id) {
	var entityId = getId(index, id);
	var denseIndex = index.sparse[entityId];
	return denseIndex !== void 0 && denseIndex < index.aliveCount && index.dense[denseIndex] === id;
};

// ---- World -----------------------------------------------------------------
var $internal = Symbol.for("bitecs_internal");
var createBaseWorld = function (context, entityIndex) {
	return defineHiddenProperty(context || {}, $internal, {
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
		hierarchyActiveRelations: new Set(),
		hierarchyQueryCache: new Map()
	});
};
function createWorld() {
	var entityIndex, context;
	for (var i = 0; i < arguments.length; i++) {
		var arg = arguments[i];
		if (typeof arg === "object" && "dense" in arg && "sparse" in arg && "aliveCount" in arg) entityIndex = arg;
		else if (typeof arg === "object") context = arg;
	}
	return createBaseWorld(context, entityIndex);
}
var resetWorld = function (world) {
	var ctx = world[$internal];
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
	ctx.hierarchyQueryCache = new Map();
	return world;
};
var deleteWorld = function (world) { delete world[$internal]; };
var getWorldComponents = function (world) { return Array.from(world[$internal].componentMap.keys()); };
var getAllEntities = function (world) { return Array.from(world[$internal].entityComponents.keys()); };

// ---- SparseSet -------------------------------------------------------------
var createSparseSet = function () {
	var dense = [], sparse = [];
	var has = function (val) { return dense[sparse[val]] === val; };
	var add = function (val) {
		if (has(val)) return;
		sparse[val] = dense.push(val) - 1;
	};
	var remove = function (val) {
		if (!has(val)) return;
		var index = sparse[val];
		var swapped = dense.pop();
		if (swapped !== val) {
			dense[index] = swapped;
			sparse[swapped] = index;
		}
	};
	var reset = function () { dense.length = 0; sparse.length = 0; };
	var sort = function (compareFn) {
		dense.sort(compareFn);
		for (var i = 0; i < dense.length; i++) sparse[dense[i]] = i;
	};
	return { add: add, remove: remove, has: has, sparse: sparse, dense: dense, reset: reset, sort: sort };
};
var SharedArrayBufferOrArrayBuffer = typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : ArrayBuffer;
var createUint32SparseSet = function (initialCapacity) {
	initialCapacity = initialCapacity || 1000;
	var sparse = [];
	var length = 0;
	var dense = new Uint32Array(new SharedArrayBufferOrArrayBuffer(initialCapacity * 4));
	var has = function (val) { return val < sparse.length && sparse[val] < length && dense[sparse[val]] === val; };
	var add = function (val) {
		if (has(val)) return;
		if (length >= dense.length) {
			var newDense = new Uint32Array(new SharedArrayBufferOrArrayBuffer(dense.length * 2 * 4));
			newDense.set(dense);
			dense = newDense;
		}
		dense[length] = val;
		sparse[val] = length;
		length++;
	};
	var remove = function (val) {
		if (!has(val)) return;
		length--;
		var index = sparse[val];
		var swapped = dense[length];
		dense[index] = swapped;
		sparse[swapped] = index;
	};
	var reset = function () { length = 0; sparse.length = 0; };
	var sort = function (compareFn) {
		var temp = Array.from(dense.subarray(0, length));
		temp.sort(compareFn);
		for (var i = 0; i < temp.length; i++) dense[i] = temp[i];
		for (var j = 0; j < length; j++) sparse[dense[j]] = j;
	};
	return {
		add: add, remove: remove, has: has, sparse: sparse,
		get dense() { return new Uint32Array(dense.buffer, 0, length); },
		reset: reset, sort: sort
	};
};

// ---- Observer --------------------------------------------------------------
var createObservable = function () {
	var observers = new Set();
	var subscribe = function (observer) {
		observers.add(observer);
		return function () { observers.delete(observer); };
	};
	var notify = function (entity) {
		var args = Array.prototype.slice.call(arguments, 1);
		return Array.from(observers).reduce(function (acc, listener) {
			var result = listener.apply(null, [entity].concat(args));
			return result && typeof result === "object" ? Object.assign({}, acc, result) : acc;
		}, {});
	};
	return { subscribe: subscribe, notify: notify };
};

// ---- Relation --------------------------------------------------------------
var $relation = Symbol.for("bitecs-relation");
var $pairTarget = Symbol.for("bitecs-pairTarget");
var $isPairComponent = Symbol.for("bitecs-isPairComponent");
var $relationData = Symbol.for("bitecs-relationData");
var createBaseRelation = function () {
	var data = { pairsMap: new Map(), initStore: undefined, exclusiveRelation: false, autoRemoveSubject: false, onTargetRemoved: undefined };
	var relation = function (target) {
		if (target === void 0) throw Error("Relation target is undefined");
		var normalizedTarget = target === "*" ? Wildcard : target;
		if (!data.pairsMap.has(normalizedTarget)) {
			var component = data.initStore ? data.initStore(target) : {};
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
var withStore = function (createStore) {
	return function (relation) {
		relation[$relationData].initStore = createStore; return relation;
	};
};
var makeExclusive = function (relation) { relation[$relationData].exclusiveRelation = true; return relation; };
var withAutoRemoveSubject = function (relation) { relation[$relationData].autoRemoveSubject = true; return relation; };
var withOnTargetRemoved = function (onRemove) {
	return function (relation) {
		relation[$relationData].onTargetRemoved = onRemove; return relation;
	};
};
var Pair = function (relation, target) {
	if (relation === void 0) throw Error("Relation is undefined");
	return relation(target);
};
var getRelationTargets = function (world, eid, relation) {
	var components = getEntityComponents(world, eid);
	var targets = [];
	for (var i = 0; i < components.length; i++) {
		var c = components[i];
		if (c[$relation] === relation && c[$pairTarget] !== Wildcard && !isRelation(c[$pairTarget])) targets.push(c[$pairTarget]);
	}
	return targets;
};
function createRelation() {
	if (arguments.length === 1 && typeof arguments[0] === "object") {
		var opts = arguments[0];
		var modifiers = [
			opts.store && withStore(opts.store),
			opts.exclusive && makeExclusive,
			opts.autoRemoveSubject && withAutoRemoveSubject,
			opts.onTargetRemoved && withOnTargetRemoved(opts.onTargetRemoved)
		].filter(Boolean);
		return modifiers.reduce(function (acc, m) { return m(acc); }, createBaseRelation());
	}
	var mods = Array.prototype.slice.call(arguments);
	return mods.reduce(function (acc, m) { return m(acc); }, createBaseRelation());
}
var $wildcard = Symbol.for("bitecs-wildcard");
function createWildcardRelation() {
	var relation = createBaseRelation();
	Object.defineProperty(relation, $wildcard, { value: true, enumerable: false, writable: false, configurable: false });
	return relation;
}
function getWildcard() {
	var GLOBAL_WILDCARD = Symbol.for("bitecs-global-wildcard");
	if (!globalThis[GLOBAL_WILDCARD]) globalThis[GLOBAL_WILDCARD] = createWildcardRelation();
	return globalThis[GLOBAL_WILDCARD];
}
var Wildcard = getWildcard();
function getIsA() {
	var GLOBAL_ISA = Symbol.for("bitecs-global-isa");
	if (!globalThis[GLOBAL_ISA]) globalThis[GLOBAL_ISA] = createBaseRelation();
	return globalThis[GLOBAL_ISA];
}
var IsA = getIsA();
function isWildcard(relation) {
	if (!relation) return false;
	return Object.getOwnPropertySymbols(relation).includes($wildcard);
}
function isRelation(component) {
	if (!component) return false;
	return Object.getOwnPropertySymbols(component).includes($relationData);
}

// ---- Hierarchy -------------------------------------------------------------
var MAX_HIERARCHY_DEPTH = 64;
var INVALID_DEPTH = 4294967295;
var DEFAULT_BUFFER_GROWTH = 1024;
function growDepthsArray(hierarchyData, entity) {
	var depths = hierarchyData.depths;
	if (entity < depths.length) return depths;
	var newSize = Math.max(entity + 1, depths.length * 2, depths.length + DEFAULT_BUFFER_GROWTH);
	var newDepths = new Uint32Array(newSize);
	newDepths.fill(INVALID_DEPTH);
	newDepths.set(depths);
	hierarchyData.depths = newDepths;
	return newDepths;
}
function updateDepthCache(hierarchyData, entity, newDepth, oldDepth) {
	var depthToEntities = hierarchyData.depthToEntities;
	if (oldDepth !== void 0 && oldDepth !== INVALID_DEPTH) {
		var oldSet = depthToEntities.get(oldDepth);
		if (oldSet) {
			oldSet.remove(entity);
			if (oldSet.dense.length === 0) depthToEntities.delete(oldDepth);
		}
	}
	if (newDepth !== INVALID_DEPTH) {
		if (!depthToEntities.has(newDepth)) depthToEntities.set(newDepth, createUint32SparseSet());
		depthToEntities.get(newDepth).add(entity);
	}
}
function updateMaxDepth(hierarchyData, depth) {
	if (depth > hierarchyData.maxDepth) hierarchyData.maxDepth = depth;
}
function setEntityDepth(hierarchyData, entity, newDepth, oldDepth) {
	hierarchyData.depths[entity] = newDepth;
	updateDepthCache(hierarchyData, entity, newDepth, oldDepth);
	updateMaxDepth(hierarchyData, newDepth);
}
function invalidateQueryCache(world, relation) {
	world[$internal].hierarchyQueryCache.delete(relation);
}
function getHierarchyData(world, relation) {
	var ctx = world[$internal];
	if (!ctx.hierarchyActiveRelations.has(relation)) {
		ctx.hierarchyActiveRelations.add(relation);
		ensureDepthTracking(world, relation);
		populateExistingDepths(world, relation);
	}
	return ctx.hierarchyData.get(relation);
}
function populateExistingDepths(world, relation) {
	var entitiesWithRelation = query(world, [Pair(relation, Wildcard)]);
	var list = entitiesWithRelation.dense || entitiesWithRelation;
	for (var i = 0; i < list.length; i++) getEntityDepth(world, relation, list[i]);
	var processedTargets = new Set();
	for (var j = 0; j < list.length; j++) {
		var entity = list[j];
		var targets = getRelationTargets(world, entity, relation);
		for (var k = 0; k < targets.length; k++) {
			if (!processedTargets.has(targets[k])) {
				processedTargets.add(targets[k]);
				getEntityDepth(world, relation, targets[k]);
			}
		}
	}
}
function ensureDepthTracking(world, relation) {
	var ctx = world[$internal];
	if (!ctx.hierarchyData.has(relation)) {
		var initialSize = Math.max(DEFAULT_BUFFER_GROWTH, ctx.entityIndex.dense.length * 2);
		var depthArray = new Uint32Array(initialSize);
		depthArray.fill(INVALID_DEPTH);
		ctx.hierarchyData.set(relation, {
			depths: depthArray, dirty: createSparseSet(), depthToEntities: new Map(), maxDepth: 0
		});
	}
}
function calculateEntityDepth(world, relation, entity, visited) {
	visited = visited || new Set();
	if (visited.has(entity)) return 0;
	visited.add(entity);
	var targets = getRelationTargets(world, entity, relation);
	if (targets.length === 0) return 0;
	if (targets.length === 1) return getEntityDepthWithVisited(world, relation, targets[0], visited) + 1;
	var minDepth = Infinity;
	for (var i = 0; i < targets.length; i++) {
		var depth = getEntityDepthWithVisited(world, relation, targets[i], visited);
		if (depth < minDepth) { minDepth = depth; if (minDepth === 0) break; }
	}
	return minDepth === Infinity ? 0 : minDepth + 1;
}
function getEntityDepthWithVisited(world, relation, entity, visited) {
	var ctx = world[$internal];
	ensureDepthTracking(world, relation);
	var hierarchyData = ctx.hierarchyData.get(relation);
	var depths = growDepthsArray(hierarchyData, entity);
	if (depths[entity] === INVALID_DEPTH) {
		var depth = calculateEntityDepth(world, relation, entity, visited);
		setEntityDepth(hierarchyData, entity, depth);
		return depth;
	}
	return depths[entity];
}
function getEntityDepth(world, relation, entity) {
	return getEntityDepthWithVisited(world, relation, entity, new Set());
}
function markChildrenDirty(world, relation, parent, dirty, visited) {
	visited = visited || createSparseSet();
	if (visited.has(parent)) return;
	visited.add(parent);
	var children = query(world, [relation(parent)]);
	var list = children.dense || children;
	for (var i = 0; i < list.length; i++) {
		dirty.add(list[i]);
		markChildrenDirty(world, relation, list[i], dirty, visited);
	}
}
function updateHierarchyDepth(world, relation, entity, parent, updating) {
	updating = updating || new Set();
	var ctx = world[$internal];
	if (!ctx.hierarchyActiveRelations.has(relation)) return;
	ensureDepthTracking(world, relation);
	var hierarchyData = ctx.hierarchyData.get(relation);
	if (updating.has(entity)) { hierarchyData.dirty.add(entity); return; }
	updating.add(entity);
	var depths = hierarchyData.depths, dirty = hierarchyData.dirty;
	var newDepth = parent !== void 0 ? getEntityDepth(world, relation, parent) + 1 : 0;
	if (newDepth > MAX_HIERARCHY_DEPTH) return;
	var oldDepth = depths[entity];
	setEntityDepth(hierarchyData, entity, newDepth, oldDepth === INVALID_DEPTH ? void 0 : oldDepth);
	if (oldDepth !== newDepth) {
		markChildrenDirty(world, relation, entity, dirty, createSparseSet());
		invalidateQueryCache(world, relation);
	}
}
function invalidateHierarchyDepth(world, relation, entity) {
	var ctx = world[$internal];
	if (!ctx.hierarchyActiveRelations.has(relation)) return;
	var hierarchyData = ctx.hierarchyData.get(relation);
	var depths = growDepthsArray(hierarchyData, entity);
	invalidateSubtree(world, relation, entity, depths, createSparseSet());
	invalidateQueryCache(world, relation);
}
function invalidateSubtree(world, relation, entity, depths, visited) {
	if (visited.has(entity)) return;
	visited.add(entity);
	var ctx = world[$internal];
	var hierarchyData = ctx.hierarchyData.get(relation);
	if (entity < depths.length) {
		var oldDepth = depths[entity];
		if (oldDepth !== INVALID_DEPTH) {
			hierarchyData.depths[entity] = INVALID_DEPTH;
			updateDepthCache(hierarchyData, entity, INVALID_DEPTH, oldDepth);
		}
	}
	var children = query(world, [relation(entity)]);
	var list = children.dense || children;
	for (var i = 0; i < list.length; i++) invalidateSubtree(world, relation, list[i], depths, visited);
}
function flushDirtyDepths(world, relation) {
	var ctx = world[$internal];
	var hierarchyData = ctx.hierarchyData.get(relation);
	if (!hierarchyData) return;
	var dirty = hierarchyData.dirty, depths = hierarchyData.depths;
	if (dirty.dense.length === 0) return;
	for (var i = 0; i < dirty.dense.length; i++) {
		var entity = dirty.dense[i];
		if (depths[entity] === INVALID_DEPTH) {
			var newDepth = calculateEntityDepth(world, relation, entity);
			setEntityDepth(hierarchyData, entity, newDepth);
		}
	}
	dirty.reset();
}
function queryHierarchy(world, relation, components, options) {
	options = options || {};
	var ctx = world[$internal];
	getHierarchyData(world, relation);
	var queryKey = queryHash(world, [relation].concat(components));
	var cached = ctx.hierarchyQueryCache.get(relation);
	if (cached && cached.hash === queryKey) return cached.result;
	flushDirtyDepths(world, relation);
	queryInternal(world, components, options);
	var queryObj = ctx.queriesHashMap.get(queryHash(world, components));
	var hierarchyData = ctx.hierarchyData.get(relation);
	var depths = hierarchyData.depths;
	queryObj.sort(function (a, b) {
		var depthA = depths[a] != null ? depths[a] : INVALID_DEPTH;
		var depthB = depths[b] != null ? depths[b] : INVALID_DEPTH;
		return depthA !== depthB ? depthA - depthB : a - b;
	});
	ctx.hierarchyQueryCache.set(relation, { hash: queryKey, result: queryObj.dense });
	return queryObj.dense;
}
function queryHierarchyDepth(world, relation, depth, options) {
	options = options || {};
	var hierarchyData = getHierarchyData(world, relation);
	flushDirtyDepths(world, relation);
	var entitiesAtDepth = hierarchyData.depthToEntities.get(depth);
	if (entitiesAtDepth) return entitiesAtDepth.dense;
	return options.buffered ? new Uint32Array(0) : [];
}
function getHierarchyDepth(world, entity, relation) {
	getHierarchyData(world, relation);
	return getEntityDepthWithVisited(world, relation, entity, new Set());
}
function getMaxHierarchyDepth(world, relation) {
	var hierarchyData = getHierarchyData(world, relation);
	return hierarchyData.maxDepth;
}

// ---- Query -----------------------------------------------------------------
var $opType = Symbol.for("bitecs-opType");
var $opTerms = Symbol.for("bitecs-opTerms");
var createOp = function (type) {
	return function () {
		return { [$opType]: type, [$opTerms]: Array.prototype.slice.call(arguments) };
	};
};
var Or = createOp("Or");
var And = createOp("And");
var Not = createOp("Not");
var Any = Or;
var All = And;
var None = Not;
var $hierarchyType = Symbol.for("bitecs-hierarchyType");
var $hierarchyRel = Symbol.for("bitecs-hierarchyRel");
var $hierarchyDepth = Symbol.for("bitecs-hierarchyDepth");
var Hierarchy = function (relation, depth) {
	return { [$hierarchyType]: "Hierarchy", [$hierarchyRel]: relation, [$hierarchyDepth]: depth };
};
var Cascade = Hierarchy;
var $modifierType = Symbol.for("bitecs-modifierType");
var asBuffer = { [$modifierType]: "buffer" };
var isNested = { [$modifierType]: "nested" };
var noCommit = isNested;
var createHook = function (type) {
	return function () {
		return { [$opType]: type, [$opTerms]: Array.prototype.slice.call(arguments) };
	};
};
var onAdd = createHook("add");
var onRemove = createHook("remove");
var onSet = function (component) { return { [$opType]: "set", [$opTerms]: [component] }; };
var onGet = function (component) { return { [$opType]: "get", [$opTerms]: [component] }; };
function observe(world, hook, callback) {
	var ctx = world[$internal];
	var type = hook[$opType];
	var components = hook[$opTerms];
	if (type === "add" || type === "remove") {
		var queryData = ctx.queriesHashMap.get(queryHash(world, components)) || registerQuery(world, components);
		return queryData[type === "add" ? "addObservable" : "removeObservable"].subscribe(callback);
	}
	if (type === "set" || type === "get") {
		if (components.length !== 1) throw new Error("Set and Get hooks can only observe a single component");
		var componentData = ctx.componentMap.get(components[0]) || registerComponent(world, components[0]);
		return componentData[type === "set" ? "setObservable" : "getObservable"].subscribe(callback);
	}
	throw new Error("Invalid hook type: " + type);
}
var queryHash = function (world, terms) {
	var ctx = world[$internal];
	var getComponentId = function (component) {
		if (!ctx.componentMap.has(component)) registerComponent(world, component);
		return ctx.componentMap.get(component).id;
	};
	var termToString = function (term) {
		if ($opType in term) return term[$opType].toLowerCase() + "(" + term[$opTerms].map(termToString).sort().join(",") + ")";
		return getComponentId(term).toString();
	};
	return terms.map(termToString).sort().join("-");
};
var registerQuery = function (world, terms, options) {
	options = options || {};
	var ctx = world[$internal];
	var hash = queryHash(world, terms);
	var queryComponents = [];
	var collect = function (term) {
		if ($opType in term) term[$opTerms].forEach(collect);
		else {
			if (!ctx.componentMap.has(term)) registerComponent(world, term);
			queryComponents.push(term);
		}
	};
	terms.forEach(collect);
	var components = [], notComponents = [], orComponents = [];
	var addToArray = function (arr, comps) {
		comps.forEach(function (comp) {
			if (!ctx.componentMap.has(comp)) registerComponent(world, comp);
			arr.push(comp);
		});
	};
	terms.forEach(function (term) {
		if ($opType in term) {
			var type = term[$opType], comps = term[$opTerms];
			if (type === "Not") addToArray(notComponents, comps);
			else if (type === "Or") addToArray(orComponents, comps);
			else if (type === "And") addToArray(components, comps);
			else throw new Error("Nested combinator " + type + " not supported yet");
		} else {
			if (!ctx.componentMap.has(term)) registerComponent(world, term);
			components.push(term);
		}
	});
	var allComponentsData = queryComponents.map(function (c) { return ctx.componentMap.get(c); });
	var generations = Array.from(new Set(allComponentsData.map(function (c) { return c.generationId; })));
	var reduceBitflags = function (a, c) { a[c.generationId] = (a[c.generationId] || 0) | c.bitflag; return a; };
	var masks = components.map(function (c) { return ctx.componentMap.get(c); }).reduce(reduceBitflags, {});
	var notMasks = notComponents.map(function (c) { return ctx.componentMap.get(c); }).reduce(reduceBitflags, {});
	var orMasks = orComponents.map(function (c) { return ctx.componentMap.get(c); }).reduce(reduceBitflags, {});
	var hasMasks = allComponentsData.reduce(reduceBitflags, {});
	var query2 = Object.assign(options.buffered ? createUint32SparseSet() : createSparseSet(), {
		allComponents: queryComponents, orComponents: orComponents, notComponents: notComponents,
		masks: masks, notMasks: notMasks, orMasks: orMasks, hasMasks: hasMasks,
		generations: generations, toRemove: createSparseSet(),
		addObservable: createObservable(), removeObservable: createObservable(), queues: {}
	});
	ctx.queries.add(query2);
	ctx.queriesHashMap.set(hash, query2);
	allComponentsData.forEach(function (c) { c.queries.add(query2); });
	if (notComponents.length) ctx.notQueries.add(query2);
	var entityIndex = ctx.entityIndex;
	for (var i = 0; i < entityIndex.aliveCount; i++) {
		var eid = entityIndex.dense[i];
		if (hasComponent(world, eid, Prefab)) continue;
		if (queryCheckEntity(world, query2, eid)) queryAddEntity(query2, eid);
	}
	return query2;
};
function queryInternal(world, terms, options) {
	options = options || {};
	var ctx = world[$internal];
	var hash = queryHash(world, terms);
	var queryData = ctx.queriesHashMap.get(hash);
	if (!queryData) queryData = registerQuery(world, terms, options);
	else if (options.buffered && !("buffer" in queryData.dense)) queryData = registerQuery(world, terms, { buffered: true });
	return queryData.dense;
}
function query(world, terms) {
	var modifiers = Array.prototype.slice.call(arguments, 2);
	var hierarchyTerm = null, regularTerms = [];
	for (var i = 0; i < terms.length; i++) {
		if (terms[i] && typeof terms[i] === "object" && $hierarchyType in terms[i]) hierarchyTerm = terms[i];
		else regularTerms.push(terms[i]);
	}
	var buffered = false, commit = true;
	var hasModifiers = modifiers.some(function (m) { return m && typeof m === "object" && $modifierType in m; });
	for (var j = 0; j < modifiers.length; j++) {
		var modifier = modifiers[j];
		if (hasModifiers && modifier && typeof modifier === "object" && $modifierType in modifier) {
			if (modifier[$modifierType] === "buffer") buffered = true;
			if (modifier[$modifierType] === "nested") commit = false;
		} else if (!hasModifiers) {
			if (modifier.buffered !== void 0) buffered = modifier.buffered;
			if (modifier.commit !== void 0) commit = modifier.commit;
		}
	}
	if (hierarchyTerm) {
		var relation = hierarchyTerm[$hierarchyRel];
		var depth = hierarchyTerm[$hierarchyDepth];
		return depth !== void 0 ? queryHierarchyDepth(world, relation, depth, { buffered: buffered }) : queryHierarchy(world, relation, regularTerms, { buffered: buffered });
	}
	if (commit) commitRemovals(world);
	return queryInternal(world, regularTerms, { buffered: buffered });
}
function queryCheckEntity(world, query2, eid) {
	var ctx = world[$internal];
	var masks = query2.masks, notMasks = query2.notMasks, orMasks = query2.orMasks, generations = query2.generations;
	var hasOrMatch = Object.keys(orMasks).length === 0;
	for (var i = 0; i < generations.length; i++) {
		var generationId = generations[i];
		var qMask = masks[generationId];
		var qNotMask = notMasks[generationId];
		var qOrMask = orMasks[generationId];
		var eMask = ctx.entityMasks[generationId][eid];
		if (qNotMask && (eMask & qNotMask) !== 0) return false;
		if (qMask && (eMask & qMask) !== qMask) return false;
		if (qOrMask && (eMask & qOrMask) !== 0) hasOrMatch = true;
	}
	return hasOrMatch;
}
var queryAddEntity = function (query2, eid) {
	if (query2.toRemove.has(eid)) {
		query2.toRemove.remove(eid);
		query2.addObservable.notify(eid);
		return;
	}
	if (query2.has(eid)) return;
	query2.add(eid);
	query2.addObservable.notify(eid);
};
var queryCommitRemovals = function (query2) {
	for (var i = 0; i < query2.toRemove.dense.length; i++) query2.remove(query2.toRemove.dense[i]);
	query2.toRemove.reset();
};
var commitRemovals = function (world) {
	var ctx = world[$internal];
	if (!ctx.dirtyQueries.size) return;
	ctx.dirtyQueries.forEach(queryCommitRemovals);
	ctx.dirtyQueries.clear();
};
var queryRemoveEntity = function (world, query2, eid) {
	var ctx = world[$internal];
	if (!query2.has(eid) || query2.toRemove.has(eid)) return;
	query2.toRemove.add(eid);
	ctx.dirtyQueries.add(query2);
	query2.removeObservable.notify(eid);
};
var removeQuery = function (world, terms) {
	var ctx = world[$internal];
	var hash = queryHash(world, terms);
	var query2 = ctx.queriesHashMap.get(hash);
	if (query2) {
		ctx.queries.delete(query2);
		ctx.queriesHashMap.delete(hash);
	}
};

// ---- Component -------------------------------------------------------------
var registerComponent = function (world, component) {
	if (!component) throw new Error("bitECS - Cannot register null or undefined component");
	var ctx = world[$internal];
	var queries = new Set();
	var data = {
		id: ctx.componentCount++, generationId: ctx.entityMasks.length - 1, bitflag: ctx.bitflag,
		ref: component, queries: queries, setObservable: createObservable(), getObservable: createObservable()
	};
	ctx.componentMap.set(component, data);
	ctx.bitflag <<= 1;
	if (ctx.bitflag >= 2 ** 31) { ctx.bitflag = 1; ctx.entityMasks.push([]); }
	return data;
};
var registerComponents = function (world, components) {
	components.forEach(function (c) { registerComponent(world, c); });
};
var hasComponent = function (world, eid, component) {
	var ctx = world[$internal];
	var registeredComponent = ctx.componentMap.get(component);
	if (!registeredComponent) return false;
	var generationId = registeredComponent.generationId, bitflag = registeredComponent.bitflag;
	var mask = ctx.entityMasks[generationId][eid];
	return (mask & bitflag) === bitflag;
};
var getComponent = function (world, eid, component) {
	var ctx = world[$internal];
	var componentData = ctx.componentMap.get(component);
	if (!componentData || !hasComponent(world, eid, component)) return void 0;
	return componentData.getObservable.notify(eid);
};
var set = function (component, data) { return { component: component, data: data }; };
var recursivelyInherit = function (ctx, world, baseEid, inheritedEid, visited) {
	visited = visited || new Set();
	if (visited.has(inheritedEid)) return;
	visited.add(inheritedEid);
	addComponent(world, baseEid, IsA(inheritedEid));
	var components = getEntityComponents(world, inheritedEid);
	for (var i = 0; i < components.length; i++) {
		var component = components[i];
		if (component === Prefab) continue;
		if (!hasComponent(world, baseEid, component)) {
			addComponent(world, baseEid, component);
			var componentData = ctx.componentMap.get(component);
			if (componentData && componentData.setObservable) {
				var data = getComponent(world, inheritedEid, component);
				componentData.setObservable.notify(baseEid, data);
			}
		}
	}
	var parents = getRelationTargets(world, inheritedEid, IsA);
	for (var j = 0; j < parents.length; j++) recursivelyInherit(ctx, world, baseEid, parents[j], visited);
};
var setComponent = function (world, eid, component, data) { addComponent(world, eid, set(component, data)); };
var addComponent = function (world, eid, componentOrSet) {
	if (!entityExists(world, eid)) throw new Error("Cannot add component - entity " + eid + " does not exist in the world.");
	var ctx = world[$internal];
	var component = "component" in componentOrSet ? componentOrSet.component : componentOrSet;
	var data = "data" in componentOrSet ? componentOrSet.data : void 0;
	if (!ctx.componentMap.has(component)) registerComponent(world, component);
	var componentData = ctx.componentMap.get(component);
	if (hasComponent(world, eid, component)) {
		if (data !== void 0) componentData.setObservable.notify(eid, data);
		return false;
	}
	var generationId = componentData.generationId, bitflag = componentData.bitflag, queries = componentData.queries;
	ctx.entityMasks[generationId][eid] |= bitflag;
	if (!hasComponent(world, eid, Prefab)) {
		queries.forEach(function (queryData) {
			if (queryCheckEntity(world, queryData, eid)) queryAddEntity(queryData, eid);
			else queryRemoveEntity(world, queryData, eid);
		});
	}
	ctx.entityComponents.get(eid).add(component);
	if (data !== void 0) componentData.setObservable.notify(eid, data);
	if (component[$isPairComponent]) {
		var relation = component[$relation];
		var target = component[$pairTarget];
		addComponents(world, eid, Pair(relation, Wildcard), Pair(Wildcard, target));
		if (typeof target === "number") {
			addComponents(world, target, Pair(Wildcard, eid), Pair(Wildcard, relation));
			ctx.entitiesWithRelations.add(target);
			ctx.entitiesWithRelations.add(eid);
		}
		ctx.entitiesWithRelations.add(target);
		var relationData = relation[$relationData];
		if (relationData.exclusiveRelation === true && target !== Wildcard) {
			var oldTarget = getRelationTargets(world, eid, relation)[0];
			if (oldTarget !== void 0 && oldTarget !== null && oldTarget !== target) removeComponent(world, eid, relation(oldTarget));
		}
		if (relation === IsA) {
			var inheritedTargets = getRelationTargets(world, eid, IsA);
			for (var i = 0; i < inheritedTargets.length; i++) recursivelyInherit(ctx, world, eid, inheritedTargets[i]);
		}
		updateHierarchyDepth(world, relation, eid, typeof target === "number" ? target : void 0);
	}
	return true;
};
function addComponents(world, eid) {
	var args = Array.prototype.slice.call(arguments, 2);
	var components = Array.isArray(args[0]) ? args[0] : args;
	components.forEach(function (c) { addComponent(world, eid, c); });
}
var removeComponent = function (world, eid) {
	var ctx = world[$internal];
	if (!entityExists(world, eid)) throw new Error("Cannot remove component - entity " + eid + " does not exist in the world.");
	var components = Array.prototype.slice.call(arguments, 2);
	components.forEach(function (component) {
		if (!hasComponent(world, eid, component)) return;
		var componentNode = ctx.componentMap.get(component);
		var generationId = componentNode.generationId, bitflag = componentNode.bitflag, queries = componentNode.queries;
		ctx.entityMasks[generationId][eid] &= ~bitflag;
		queries.forEach(function (queryData) {
			queryData.toRemove.remove(eid);
			if (queryCheckEntity(world, queryData, eid)) queryAddEntity(queryData, eid);
			else queryRemoveEntity(world, queryData, eid);
		});
		ctx.entityComponents.get(eid).delete(component);
		if (component[$isPairComponent]) {
			var target = component[$pairTarget];
			var relation = component[$relation];
			invalidateHierarchyDepth(world, relation, eid);
			removeComponent(world, eid, Pair(Wildcard, target));
			if (typeof target === "number" && entityExists(world, target)) {
				removeComponent(world, target, Pair(Wildcard, eid));
				removeComponent(world, target, Pair(Wildcard, relation));
			}
			var otherTargets = getRelationTargets(world, eid, relation);
			if (otherTargets.length === 0) removeComponent(world, eid, Pair(relation, Wildcard));
		}
	});
};
var removeComponents = removeComponent;

// ---- Entity ---------------------------------------------------------------
var Prefab = {};
var addPrefab = function (world) {
	var eid = addEntity(world);
	addComponent(world, eid, Prefab);
	return eid;
};
function addEntity(world) {
	var components = Array.prototype.slice.call(arguments, 1);
	var ctx = world[$internal];
	var eid = addEntityId(ctx.entityIndex);
	ctx.notQueries.forEach(function (q) {
		if (queryCheckEntity(world, q, eid)) queryAddEntity(q, eid);
	});
	ctx.entityComponents.set(eid, new Set());
	if (components.length > 0) addComponents(world, eid, components);
	return eid;
}
var removeEntity = function (world, eid) {
	var ctx = world[$internal];
	if (!isEntityIdAlive(ctx.entityIndex, eid)) return;
	var removalQueue = [eid];
	var processedEntities = new Set();
	while (removalQueue.length > 0) {
		var currentEid = removalQueue.shift();
		if (processedEntities.has(currentEid)) continue;
		processedEntities.add(currentEid);
		var componentRemovalQueue = [];
		if (ctx.entitiesWithRelations.has(currentEid)) {
			var subjects = query(world, [Wildcard(currentEid)], noCommit);
			var subjectList = subjects.dense || subjects;
			for (var s = 0; s < subjectList.length; s++) {
				var subject = subjectList[s];
				if (!entityExists(world, subject)) continue;
				for (var component of ctx.entityComponents.get(subject)) {
					if (!component[$isPairComponent]) continue;
					var relation = component[$relation];
					var relationData = relation[$relationData];
					componentRemovalQueue.push(function () { return removeComponent(world, subject, Pair(Wildcard, currentEid)); });
					if (component[$pairTarget] === currentEid) {
						componentRemovalQueue.push(function () { return removeComponent(world, subject, component); });
						if (relationData.autoRemoveSubject) removalQueue.push(subject);
						if (relationData.onTargetRemoved) componentRemovalQueue.push(function () { return relationData.onTargetRemoved(world, subject, currentEid); });
					}
				}
			}
			ctx.entitiesWithRelations.delete(currentEid);
		}
		for (var k = 0; k < componentRemovalQueue.length; k++) componentRemovalQueue[k]();
		for (var m = 0; m < removalQueue.length; m++) removeEntity(world, removalQueue[m]);
		for (var query2 of ctx.queries) queryRemoveEntity(world, query2, currentEid);
		removeEntityId(ctx.entityIndex, currentEid);
		ctx.entityComponents.delete(currentEid);
		for (var i = 0; i < ctx.entityMasks.length; i++) ctx.entityMasks[i][currentEid] = 0;
	}
};
var getEntityComponents = function (world, eid) {
	var ctx = world[$internal];
	if (eid === void 0) throw new Error("getEntityComponents: entity id is undefined.");
	if (!isEntityIdAlive(ctx.entityIndex, eid)) throw new Error("getEntityComponents: entity " + eid + " does not exist in the world.");
	return Array.from(ctx.entityComponents.get(eid));
};
var entityExists = function (world, eid) { return isEntityIdAlive(world[$internal].entityIndex, eid); };

// ---- Utilities -------------------------------------------------------------
var pipe = function () {
	var fns = Array.prototype.slice.call(arguments);
	return function () {
		var args = Array.prototype.slice.call(arguments);
		return fns.reduce(function (result, fn) { return [fn.apply(null, result)]; }, args)[0];
	};
};
var soa = function (spec) { return spec; };
function aos(spec) {
	var base = [];
	return spec ? Object.assign(base, spec) : base;
}

// ============================================================================
// 2. MATH-SOA POOL (zero-GC reuse for transform/color/velocity/quat SOAs)
// ============================================================================
var _soaPools = new Map();
function soaPoolGet(kind, count) {
	var pool = _soaPools.get(kind);
	if (!pool) {
		pool = createPool(
			function () { return { soa: null, count: 0, kind: kind }; },
			4,
			function (h) {
				if (h.soa && h.soa.arrays) {
					for (var i = 0; i < h.soa.arrays.length; i++) h.soa.arrays[i].fill(0);
				}
			}
		);
		_soaPools.set(kind, pool);
	}
	var handle = pool.acquire();
	handle.count = count;
	handle.soa = kind === "vec3" ? vec3.createVec3SOA(count)
		: kind === "vec4" ? vec4.createVec4SOA(count)
		: kind === "quat" ? quat.createQuatSOA(count)
		: kind === "mat4" ? mat4.createMat4SOA(count)
		: kind === "quat2" ? quat2.createQuat2SOA(count)
		: null;
	return handle;
}
function soaPoolRelease(handle) {
	var pool = _soaPools.get(handle.kind);
	if (pool) { handle.soa = null; handle.count = 0; pool.release(handle); }
}

// ============================================================================
// 3. TRS COMPONENT (SOA-backed)
// ============================================================================
function createTransformSOA(count) {
	return {
		position: vec3.createVec3SOA(count),
		rotation: quat.createQuatSOA(count),
		scale: vec3.createVec3SOA(count)
	};
}
function createVelocitySOA(count) { return vec3.createVec3SOA(count); }
function createColorSOA(count) { return vec4.createVec4SOA(count); }
function createMatrixSOA(count) { return mat4.createMat4SOA(count); }
// Composes 1M+ TRS to mat4 SOA in one call.
function composeTransformSOA(outMat, trs) {
	return mat4.soaComposeTRS(outMat, trs.position, trs.rotation, trs.scale);
}
async function composeTransformSOAChunked(outMat, trs, chunkSize, yieldEvery) {
	return mat4.soaComposeTRSChunked(outMat, trs.position, trs.rotation, trs.scale, chunkSize, yieldEvery);
}

// ============================================================================
// 4. PARALLELISM -- chunked iteration that never freezes the UI thread
// ============================================================================
async function iterChunked(entities, callback, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var n = entities.length || entities.count || 0;
	var c = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) callback(entities[i], i);
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
}
async function queryChunked(world, terms, callback, chunkSize, yieldEvery) {
	var result = query(world, terms);
	var entities = result.dense || result;
	return iterChunked(entities, callback, chunkSize, yieldEvery);
}
async function soaStepChunked(soa, stepFn, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var n = soa.count;
	var c = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) stepFn(i, soa);
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
}

// ============================================================================
// 5. SPATIAL GRID (typed-array linked-list buckets, zero-GC)
// ============================================================================
function createSpatialGrid(cellSize, options) {
	options = options || {};
	var maxEntities = options.maxEntities || 1000000;
	var gridDim = options.gridDim || 256;
	var totalCells = gridDim * gridDim * gridDim;
	var bucketHead = new Int32Array(totalCells);
	var entityNext = new Int32Array(maxEntities);
	var entityCell = new Int32Array(maxEntities);
	bucketHead.fill(-1);
	entityNext.fill(-1);
	entityCell.fill(-1);
	var invCell = 1 / (cellSize || 1);
	var queryResultBuffer = new Uint32Array(options.queryCapacity || 4096);
	var queryResultCount = 0;
	function cellIndex(x, y, z) {
		var cx = (Math.floor(x * invCell) & (gridDim - 1));
		var cy = (Math.floor(y * invCell) & (gridDim - 1));
		var cz = (Math.floor(z * invCell) & (gridDim - 1));
		return (cz * gridDim + cy) * gridDim + cx;
	}
	return {
		cellSize: cellSize,
		gridDim: gridDim,
		insert: function (eid, x, y, z) {
			var idx = cellIndex(x, y, z);
			entityNext[eid] = bucketHead[idx];
			bucketHead[idx] = eid;
			entityCell[eid] = idx;
		},
		insertMany: function (ids, positions) {
			var px = positions.x, py = positions.y, pz = positions.z;
			var n = positions.count;
			for (var i = 0; i < n; i++) {
				var eid = ids[i];
				var idx = cellIndex(px[i], py[i], pz[i]);
				entityNext[eid] = bucketHead[idx];
				bucketHead[idx] = eid;
				entityCell[eid] = idx;
			}
		},
		remove: function (eid) {
			var idx = entityCell[eid];
			if (idx === -1) return;
			if (bucketHead[idx] === eid) {
				bucketHead[idx] = entityNext[eid];
			} else {
				var prev = bucketHead[idx];
				while (prev !== -1 && entityNext[prev] !== eid) prev = entityNext[prev];
				if (prev !== -1) entityNext[prev] = entityNext[eid];
			}
			entityNext[eid] = -1;
			entityCell[eid] = -1;
		},
		clear: function () {
			bucketHead.fill(-1);
			entityNext.fill(-1);
			entityCell.fill(-1);
		},
		get entityCount() { return maxEntities; },
		querySphere: function (x, y, z, radius) {
			queryResultCount = 0;
			var r = Math.ceil(radius * invCell);
			var cx = Math.floor(x * invCell);
			var cy = Math.floor(y * invCell);
			var cz = Math.floor(z * invCell);
			for (var dx = -r; dx <= r; dx++) {
				for (var dy = -r; dy <= r; dy++) {
					for (var dz = -r; dz <= r; dz++) {
						var gx = (cx + dx) & (gridDim - 1);
						var gy = (cy + dy) & (gridDim - 1);
						var gz = (cz + dz) & (gridDim - 1);
						var idx = (gz * gridDim + gy) * gridDim + gx;
						var current = bucketHead[idx];
						while (current !== -1) {
							if (queryResultCount < queryResultBuffer.length) {
								queryResultBuffer[queryResultCount++] = current;
							}
							current = entityNext[current];
						}
					}
				}
			}
			return queryResultCount;
		},
		getQueryResults: function () { return queryResultBuffer; },
		getQueryCount: function () { return queryResultCount; },
		queryCell: function (x, y, z, callback) {
			var idx = cellIndex(x, y, z);
			var current = bucketHead[idx];
			while (current !== -1) {
				callback(current);
				current = entityNext[current];
			}
		}
	};
}

// ============================================================================
// 6. INSTANCE BATCH (works with or without GPU instancing)
// ============================================================================
function composeOneTRS(outMatSOA, trs, srcIndex, dstIndex) {
	var M = outMatSOA.arrays;
	var px = trs.position.x[srcIndex], py = trs.position.y[srcIndex], pz = trs.position.z[srcIndex];
	var qx = trs.rotation.x[srcIndex], qy = trs.rotation.y[srcIndex], qz = trs.rotation.z[srcIndex], qw = trs.rotation.w[srcIndex];
	var Sx = trs.scale.x[srcIndex], Sy = trs.scale.y[srcIndex], Sz = trs.scale.z[srcIndex];
	var x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
	var xx = qx * x2, xy = qx * y2, xz = qx * z2;
	var yy = qy * y2, yz = qy * z2, zz = qz * z2;
	var wx = qw * x2, wy = qw * y2, wz = qw * z2;
	M[0][dstIndex] = (1 - (yy + zz)) * Sx; M[1][dstIndex] = (xy + wz) * Sx; M[2][dstIndex] = (xz - wy) * Sx; M[3][dstIndex] = 0;
	M[4][dstIndex] = (xy - wz) * Sy; M[5][dstIndex] = (1 - (xx + zz)) * Sy; M[6][dstIndex] = (yz + wx) * Sy; M[7][dstIndex] = 0;
	M[8][dstIndex] = (xz + wy) * Sz; M[9][dstIndex] = (yz - wx) * Sz; M[10][dstIndex] = (1 - (xx + yy)) * Sz; M[11][dstIndex] = 0;
	M[12][dstIndex] = px; M[13][dstIndex] = py; M[14][dstIndex] = pz; M[15][dstIndex] = 1;
}
function createInstanceBatch(options) {
	options = options || {};
	var maxSize = options.maxSize || 100000;
	var meshId = options.meshId || 0;
	var materialId = options.materialId || 0;
	var transforms = mat4.createMat4SOA(maxSize);
	var colors = vec4.createVec4SOA(maxSize);
	var entities = new Uint32Array(maxSize);
	var count = 0;
	var _flatBuffer = new Float32Array(maxSize * 16);
	return {
		meshId: meshId,
		materialId: materialId,
		transforms: transforms,
		colors: colors,
		entities: entities,
		get count() { return count; },
		addFromTRS: function (eid, trs, index, color) {
			if (count >= maxSize) return false;
			composeOneTRS(transforms, trs, index || 0, count);
			if (color) vec4.soaSet(colors, count, color);
			entities[count++] = eid;
			return true;
		},
		addManyFromTRS: function (eids, trs, indices) {
			var n = eids.length;
			for (var i = 0; i < n; i++) {
				if (count >= maxSize) return count;
				var idx = indices ? indices[i] : i;
				composeOneTRS(transforms, trs, idx, count);
				entities[count++] = eids[i];
			}
			return count;
		},
		clear: function () { count = 0; },
		getInstanceMatrixBuffer: function () {
			mat4.soaToFlat(_flatBuffer, transforms, 0);
			return _flatBuffer.subarray(0, count * 16);
		}
	};
}

// ============================================================================
// 7. PROCEDURAL SPAWNERS
// ============================================================================
function scatterEntities(world, count, options) {
	options = options || {};
	var bounds = options.bounds || { x: [-100, 100], y: [-100, 100], z: [-100, 100] };
	var seed = options.seed || 1;
	var noiseScale = options.noiseScale || 0.05;
	var spawn = options.spawn || function (w) { return addEntity(w); };
	var rng = mulberry32(seed);
	var entities = new Uint32Array(count);
	var positions = vec3.createVec3SOA(count);
	var rotations = quat.createQuatSOA(count);
	var scales = vec3.createVec3SOA(count);
	for (var i = 0; i < count; i++) {
		var x = bounds.x[0] + rng() * (bounds.x[1] - bounds.x[0]);
		var y = bounds.y[0] + rng() * (bounds.y[1] - bounds.y[0]);
		var z = bounds.z[0] + rng() * (bounds.z[1] - bounds.z[0]);
		positions.x[i] = x; positions.y[i] = y; positions.z[i] = z;
		var u1 = hash3(Math.floor(x * noiseScale), Math.floor(y * noiseScale), Math.floor(z * noiseScale));
		var u2 = hash3(Math.floor(x * noiseScale) + 17, Math.floor(y * noiseScale) + 23, Math.floor(z * noiseScale) + 5);
		var u3 = hash3(Math.floor(x * noiseScale) + 3, Math.floor(y * noiseScale) + 11, Math.floor(z * noiseScale) + 29);
		var s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
		rotations.x[i] = s1 * Math.sin(2 * Math.PI * u2);
		rotations.y[i] = s1 * Math.cos(2 * Math.PI * u2);
		rotations.z[i] = s2 * Math.sin(2 * Math.PI * u3);
		rotations.w[i] = s2 * Math.cos(2 * Math.PI * u3);
		var s = 0.5 + u1 * 1.5;
		scales.x[i] = s; scales.y[i] = s; scales.z[i] = s;
		entities[i] = spawn(world);
	}
	return { entities: entities, position: positions, rotation: rotations, scale: scales };
}
async function scatterEntitiesChunked(world, count, options) {
	options = options || {};
	var bounds = options.bounds || { x: [-100, 100], y: [-100, 100], z: [-100, 100] };
	var seed = options.seed || 1;
	var noiseScale = options.noiseScale || 0.05;
	var spawn = options.spawn || function (w) { return addEntity(w); };
	var chunkSize = options.chunkSize || CHUNK_SIZE;
	var yieldEvery = options.yieldEvery || CHUNK_YIELD_EVERY;
	var rng = mulberry32(seed);
	var entities = new Uint32Array(count);
	var positions = vec3.createVec3SOA(count);
	var rotations = quat.createQuatSOA(count);
	var scales = vec3.createVec3SOA(count);
	var cc = 0;
	for (var start = 0; start < count; start += chunkSize) {
		var end = Math.min(start + chunkSize, count);
		for (var i = start; i < end; i++) {
			var x = bounds.x[0] + rng() * (bounds.x[1] - bounds.x[0]);
			var y = bounds.y[0] + rng() * (bounds.y[1] - bounds.y[0]);
			var z = bounds.z[0] + rng() * (bounds.z[1] - bounds.z[0]);
			positions.x[i] = x; positions.y[i] = y; positions.z[i] = z;
			var u1 = hash3(Math.floor(x * noiseScale), Math.floor(y * noiseScale), Math.floor(z * noiseScale));
			var u2 = hash3(Math.floor(x * noiseScale) + 17, Math.floor(y * noiseScale) + 23, Math.floor(z * noiseScale) + 5);
			var u3 = hash3(Math.floor(x * noiseScale) + 3, Math.floor(y * noiseScale) + 11, Math.floor(z * noiseScale) + 29);
			var s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
			rotations.x[i] = s1 * Math.sin(2 * Math.PI * u2);
			rotations.y[i] = s1 * Math.cos(2 * Math.PI * u2);
			rotations.z[i] = s2 * Math.sin(2 * Math.PI * u3);
			rotations.w[i] = s2 * Math.cos(2 * Math.PI * u3);
			var s = 0.5 + u1 * 1.5;
			scales.x[i] = s; scales.y[i] = s; scales.z[i] = s;
			entities[i] = spawn(world);
		}
		if (++cc >= yieldEvery) { cc = 0; await yieldToMain(); }
	}
	return { entities: entities, position: positions, rotation: rotations, scale: scales };
}
function spawnOrbitalBodies(world, count, options) {
	options = options || {};
	var aMin = options.aMin || 1, aMax = options.aMax || 10;
	var eMin = options.eMin || 0, eMax = options.eMax || 0.5;
	var incMax = options.incMax || Math.PI * 0.25;
	var rng = mulberry32(options.seed || 1);
	var entities = new Uint32Array(count);
	var elements = {
		a: new Float32Array(count),
		e: new Float32Array(count),
		M: new Float32Array(count),
		inc: new Float32Array(count),
		Om: new Float32Array(count),
		om: new Float32Array(count)
	};
	var spawn = options.spawn || function (w) { return addEntity(w); };
	for (var i = 0; i < count; i++) {
		elements.a[i] = aMin + rng() * (aMax - aMin);
		elements.e[i] = eMin + rng() * (eMax - eMin);
		elements.M[i] = rng() * Math.PI * 2;
		elements.inc[i] = rng() * incMax;
		elements.Om[i] = rng() * Math.PI * 2;
		elements.om[i] = rng() * Math.PI * 2;
		entities[i] = spawn(world);
	}
	return { entities: entities, elements: elements };
}

// ============================================================================
// 8. ANIMATION SYSTEM (zero-GC spring damping over SOA)
// ============================================================================
function createAnimationSystem(options) {
	options = options || {};
	var maxEntries = options.maxEntries || 10000;
	var velocityPool = new Float32Array(maxEntries * 7);
	var smoothTimes = new Float32Array(maxEntries);
	var maxSpeeds = new Float32Array(maxEntries);
	var entryEids = new Int32Array(maxEntries);
	var entryCount = 0;
	// Frame-rate-independent critically-damped spring for one scalar component.
	function springComponent(c, t, v, omega, exp, dt, maxChange) {
		var change = c - t;
		var originalTarget = t;
		if (change > maxChange) change = maxChange;
		else if (change < -maxChange) change = -maxChange;
		t = c - change;
		var temp = (v + omega * change) * dt;
		var newV = (v - omega * temp) * exp;
		var output = t + (change + temp) * exp;
		if ((originalTarget - c > 0) === (output > originalTarget)) {
			output = originalTarget;
			newV = (output - originalTarget) / dt;
		}
		return { value: output, vel: newV };
	}
	return {
		add: function (eid, opts) {
			if (entryCount >= maxEntries) return -1;
			var idx = entryCount++;
			entryEids[idx] = eid;
			smoothTimes[idx] = opts.smoothTime != null ? opts.smoothTime : 0.15;
			maxSpeeds[idx] = opts.maxSpeed != null ? opts.maxSpeed : Infinity;
			var vOff = idx * 7;
			for (var j = 0; j < 7; j++) velocityPool[vOff + j] = 0;
			return idx;
		},
		step: function (dt, trs, targets) {
			if (!trs || !targets) return;
			var n = Math.min(trs.position.count, maxEntries);
			var px = trs.position.x, py = trs.position.y, pz = trs.position.z;
			var tx = targets.position.x, ty = targets.position.y, tz = targets.position.z;
			var qx = trs.rotation.x, qy = trs.rotation.y, qz = trs.rotation.z, qw = trs.rotation.w;
			var tqx = targets.rotation.x, tqy = targets.rotation.y, tqz = targets.rotation.z, tqw = targets.rotation.w;
			for (var i = 0; i < n; i++) {
				var vOff = i * 7;
				var st = i < entryCount ? smoothTimes[i] : 0.15;
				var ms = i < entryCount ? maxSpeeds[i] : Infinity;
				if (st < 0.0001) st = 0.0001;
				var omega = 2 / st;
				var x = omega * dt;
				var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
				var maxChange = ms * st;
				// Position spring (3 components).
				var rx = springComponent(px[i], tx[i], velocityPool[vOff], omega, exp, dt, maxChange);
				velocityPool[vOff] = rx.vel; px[i] = rx.value;
				var ry = springComponent(py[i], ty[i], velocityPool[vOff + 1], omega, exp, dt, maxChange);
				velocityPool[vOff + 1] = ry.vel; py[i] = ry.value;
				var rz = springComponent(pz[i], tz[i], velocityPool[vOff + 2], omega, exp, dt, maxChange);
				velocityPool[vOff + 2] = rz.vel; pz[i] = rz.value;
				// Quaternion spring (4 components, shortest-arc + renormalize).
				var d = qx[i] * tqx[i] + qy[i] * tqy[i] + qz[i] * tqz[i] + qw[i] * tqw[i];
				var sgn = d < 0 ? -1 : 1;
				var s0 = springComponent(qx[i], tqx[i] * sgn, velocityPool[vOff + 3], omega, exp, dt, maxChange);
				velocityPool[vOff + 3] = s0.vel;
				var s1 = springComponent(qy[i], tqy[i] * sgn, velocityPool[vOff + 4], omega, exp, dt, maxChange);
				velocityPool[vOff + 4] = s1.vel;
				var s2 = springComponent(qz[i], tqz[i] * sgn, velocityPool[vOff + 5], omega, exp, dt, maxChange);
				velocityPool[vOff + 5] = s2.vel;
				var s3 = springComponent(qw[i], tqw[i] * sgn, velocityPool[vOff + 6], omega, exp, dt, maxChange);
				velocityPool[vOff + 6] = s3.vel;
				var l = Math.sqrt(s0.value * s0.value + s1.value * s1.value + s2.value * s2.value + s3.value * s3.value);
				if (l > 0) {
					var inv = 1 / l;
					qx[i] = s0.value * inv; qy[i] = s1.value * inv; qz[i] = s2.value * inv; qw[i] = s3.value * inv;
				} else {
					qx[i] = 0; qy[i] = 0; qz[i] = 0; qw[i] = 1;
				}
			}
		},
		get count() { return entryCount; }
	};
}

// ============================================================================
// 9. NATURAL IK MOTION -- FABRIK & CCD systems (zero-GC chain pools)
// ============================================================================
function createIKSystem(options) {
	options = options || {};
	var maxChains = options.maxChains || 1000;
	var maxBones = options.maxBones || 16;
	var chainPosPool = new Float32Array(maxChains * maxBones * 3);
	var chainLensPool = new Float32Array(maxChains * (maxBones - 1));
	var chainTargetPool = new Float32Array(maxChains * 3);
	var chainBoneCounts = new Int32Array(maxChains);
	var chainIterations = new Int32Array(maxChains);
	var chainTolerances = new Float32Array(maxChains);
	var chainMethods = new Uint8Array(maxChains);
	var chainCount = 0;
	return {
		addChain: function (opts) {
			if (chainCount >= maxChains) return -1;
			var idx = chainCount++;
			var boneCount = opts.boneCount || 8;
			chainBoneCounts[idx] = boneCount;
			chainIterations[idx] = opts.iterations || 10;
			chainTolerances[idx] = opts.tolerance || 0.001;
			chainMethods[idx] = opts.method === "ccd" ? 1 : 0;
			var posOff = idx * maxBones * 3;
			if (opts.pos) {
				for (var i = 0; i < boneCount * 3; i++) chainPosPool[posOff + i] = opts.pos[i];
			}
			var lensOff = idx * (maxBones - 1);
			if (opts.lens) {
				for (var j = 0; j < boneCount - 1; j++) chainLensPool[lensOff + j] = opts.lens[j];
			}
			var tgtOff = idx * 3;
			if (opts.target) {
				chainTargetPool[tgtOff] = opts.target[0];
				chainTargetPool[tgtOff + 1] = opts.target[1];
				chainTargetPool[tgtOff + 2] = opts.target[2];
			}
			return idx;
		},
		setTarget: function (chainIdx, x, y, z) {
			var tgtOff = chainIdx * 3;
			chainTargetPool[tgtOff] = x;
			chainTargetPool[tgtOff + 1] = y;
			chainTargetPool[tgtOff + 2] = z;
		},
		step: function () {
			for (var i = 0; i < chainCount; i++) {
				var boneCount = chainBoneCounts[i];
				var posOff = i * maxBones * 3;
				var lensOff = i * (maxBones - 1);
				var tgtOff = i * 3;
				var pos = chainPosPool.subarray(posOff, posOff + boneCount * 3);
				var lens = chainLensPool.subarray(lensOff, lensOff + boneCount - 1);
				var target = chainTargetPool.subarray(tgtOff, tgtOff + 3);
				var iters = chainIterations[i];
				var tol = chainTolerances[i];
				if (chainMethods[i] === 0) {
					for (var j = 0; j < iters; j++) {
						var err = vec3.fabrikStep3(pos, lens, target, tol);
						if (err < tol * tol) break;
					}
				} else {
					vec3.ccdStep3(pos, target, iters);
				}
			}
		},
		getChainPositions: function (chainIdx) {
			var boneCount = chainBoneCounts[chainIdx];
			var posOff = chainIdx * maxBones * 3;
			return chainPosPool.subarray(posOff, posOff + boneCount * 3);
		},
		get count() { return chainCount; }
	};
}

// ============================================================================
// 10. ORBITAL SYSTEM -- Kepler integration for 1M+ bodies
// ============================================================================
function createOrbitalSystem(options) {
	options = options || {};
	var bodies = { entities: null, elements: null, times: null };
	var timeScale = options.timeScale || 1;
	var mu = options.mu || 1;
	var _tmpPos = new Float32Array(3);
	return {
		setBodies: function (result, preallocatedTimes) {
			bodies.entities = result.entities;
			bodies.elements = result.elements;
			bodies.times = preallocatedTimes || new Float32Array(result.entities.length);
		},
		step: function (dt, outPos) {
			if (!bodies.entities) return;
			var n = bodies.entities.length;
			var el = bodies.elements, tm = bodies.times;
			var ox = outPos.x, oy = outPos.y, oz = outPos.z;
			for (var i = 0; i < n; i++) {
				tm[i] += dt * timeScale;
				var a = el.a[i], e = el.e[i];
				var M = el.M[i] + tm[i] * Math.sqrt(mu / (a * a * a));
				vec3.keplerOrbit3D(_tmpPos, a, e, M, el.inc[i], el.Om[i], el.om[i]);
				ox[i] = _tmpPos[0]; oy[i] = _tmpPos[1]; oz[i] = _tmpPos[2];
			}
		},
		get count() { return bodies.entities ? bodies.entities.length : 0; }
	};
}

// ============================================================================
// 11. COLOR SYSTEM (zero-GC grading over 1M+ entities)
// ============================================================================
var _tmpColorMat3 = new Float32Array(9);
function createColorSystem() {
	return {
		toLinear: function (colors) { return vec4.soaSrgbToLinear(colors); },
		toSrgb: function (colors) { return vec4.soaLinearToSrgb(colors); },
		expose: function (colors, exposure) { return vec4.soaExpose(colors, exposure); },
		hueRotate: function (out, colors, rad) {
			mat3.fromHueRotation(_tmpColorMat3, rad);
			return mat3.soaApplyColorMatrix(out, colors, _tmpColorMat3);
		},
		saturate: function (out, colors, s) {
			mat3.fromSaturation(_tmpColorMat3, s);
			return mat3.soaApplyColorMatrix(out, colors, _tmpColorMat3);
		},
		acesToneMap: function (colors) {
			var x = colors.x, y = colors.y, z = colors.z, n = colors.count;
			for (var i = 0; i < n; i++) {
				var r = x[i], g = y[i], b = z[i];
				x[i] = (r * (2.51 * r + 0.03)) / (r * (2.43 * r + 0.59) + 0.14);
				y[i] = (g * (2.51 * g + 0.03)) / (g * (2.43 * g + 0.59) + 0.14);
				z[i] = (b * (2.51 * b + 0.03)) / (b * (2.43 * b + 0.59) + 0.14);
			}
			return colors;
		}
	};
}

// ============================================================================
// 12. FLOATING ORIGIN -- seamless mm to Mpc
// ============================================================================
function createFloatingOrigin(options) {
	options = options || {};
	var threshold = options.threshold || 1000;
	var origin = [0, 0, 0];
	return {
		origin: origin,
		recenter: function (cameraPos, trs) {
			var dx = cameraPos[0] - origin[0];
			var dy = cameraPos[1] - origin[1];
			var dz = cameraPos[2] - origin[2];
			var distSq = dx * dx + dy * dy + dz * dz;
			if (distSq < threshold * threshold) return false;
			origin[0] = cameraPos[0];
			origin[1] = cameraPos[1];
			origin[2] = cameraPos[2];
			if (trs && trs.position) {
				var px = trs.position.x, py = trs.position.y, pz = trs.position.z;
				var n = trs.position.count;
				for (var i = 0; i < n; i++) { px[i] -= origin[0]; py[i] -= origin[1]; pz[i] -= origin[2]; }
			}
			return true;
		}
	};
}

// ============================================================================
// 13. EXPORTS -- every original bitECS export + all new systems
// ============================================================================
export {
	// internal / constants
	$internal, All, And, Any, Cascade, Hierarchy, IsA, None, Not, Or, Pair, Prefab, Wildcard,
	// component / entity
	addComponent, addComponents, addEntity, addPrefab, removeComponent, removeComponents,
	removeEntity, entityExists, getAllEntities, getComponent, getEntityComponents,
	getWorldComponents, hasComponent, set, setComponent, registerComponent, registerComponents,
	// world / entity index
	createEntityIndex, createWorld, deleteWorld, resetWorld, getId, getVersion, withVersioning,
	// queries / observers / hierarchy
	asBuffer, commitRemovals, getHierarchyDepth, getMaxHierarchyDepth, isNested, noCommit,
	observe, onAdd, onGet, onRemove, onSet, query, registerQuery, removeQuery,
	// relations
	createRelation, getRelationTargets, isRelation, isWildcard, makeExclusive,
	withAutoRemoveSubject, withOnTargetRemoved, withStore,
	// layout utilities
	aos, pipe, soa,
	// math (all previously produced modules)
	vec2, vec3, vec4, mat2, mat3, mat4, quat, quat2,
	// SOA pools
	soaPoolGet, soaPoolRelease, createTransformSOA, createVelocitySOA, createColorSOA,
	createMatrixSOA, composeTransformSOA, composeTransformSOAChunked,
	// parallelism
	iterChunked, queryChunked, soaStepChunked,
	// spatial
	createSpatialGrid,
	// rendering
	createInstanceBatch,
	// procedural
	scatterEntities, scatterEntitiesChunked, spawnOrbitalBodies,
	// systems
	createAnimationSystem, createIKSystem, createOrbitalSystem, createColorSystem,
	createFloatingOrigin
};

export default {
	$internal, All, And, Any, Cascade, Hierarchy, IsA, None, Not, Or, Pair, Prefab, Wildcard,
	addComponent, addComponents, addEntity, addPrefab, removeComponent, removeComponents,
	removeEntity, entityExists, getAllEntities, getComponent, getEntityComponents,
	getWorldComponents, hasComponent, set, setComponent, registerComponent, registerComponents,
	createEntityIndex, createWorld, deleteWorld, resetWorld, getId, getVersion, withVersioning,
	asBuffer, commitRemovals, getHierarchyDepth, getMaxHierarchyDepth, isNested, noCommit,
	observe, onAdd, onGet, onRemove, onSet, query, registerQuery, removeQuery,
	createRelation, getRelationTargets, isRelation, isWildcard, makeExclusive,
	withAutoRemoveSubject, withOnTargetRemoved, withStore,
	aos, pipe, soa,
	math: { common: { CHUNK_SIZE, CHUNK_YIELD_EVERY, yieldToMain, hash3, mulberry32, createPool }, vec2, vec3, vec4, mat2, mat3, mat4, quat, quat2 },
	soaPoolGet, soaPoolRelease, createTransformSOA, createVelocitySOA, createColorSOA,
	createMatrixSOA, composeTransformSOA, composeTransformSOAChunked,
	iterChunked, queryChunked, soaStepChunked,
	createSpatialGrid,
	createInstanceBatch,
	scatterEntities, scatterEntitiesChunked, spawnOrbitalBodies,
	createAnimationSystem, createIKSystem, createOrbitalSystem, createColorSystem,
	createFloatingOrigin
};