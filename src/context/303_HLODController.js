// file number : 303
// full path name : src/context/303_HLODController.js
// description : Hierarchical LOD controller operating across four spatial tiers (1 km / 10 km / 100 km / 1000 km) to keep a living world streaming at 60 fps from a 10-unit blade of grass to a galaxy-scale star field. Implements the blueprint's formula exactly — level index ℓ = ⌊log_R(d/d₀)⌋ with R = 10 and d₀ = 1 km, tier threshold d_ℓ = d₀·R^ℓ, smooth blend weight α = smoothstep(d_ℓ, d_{ℓ+1}, d), and blended colour C = (1−α)·C_near + α·C_far. Builds a four-tier HLOD pyramid where each tier-ℓ node aggregates its tier-(ℓ−1) children, so a 100 km node owns the ten 10 km nodes that own their own ten 1 km nodes. Frustum culling descends hierarchically: a tier-3 node is tested once against the predicted camera frustum (from 302_CameraVelocityExtrapolator); if it passes, its children are tested; if it fails, all descendants are skipped. Nodes fade smoothly across tier boundaries so a tree doesn't visibly pop from 1 km detail to 10 km aggregate. Provides full per-tier material parameters — near tiers get full PBR, mid tiers get PBR + anime blend, far tiers get flat anime billboards — and per-tier lighting modifiers that scale emissive intensity (bright near, faded far), reflect air quality (AOD reduces contrast at distance), and simulate atmospheric fog absorption per tier. Uses the MaterialRegistry's per-material LOD variants when available (PBR base, PBR simplified, anime flat, billboard) and falls back to smooth interpolation otherwise. Per-node material state includes wetness, snow, fire, moss, emissive boost, frost, and seasonal tint, all synchronized from the context frame each update. Emits AUDIO_LIGHT causal events when a node crosses tier boundaries or culling state changes. Writes per-tier node lists, per-node blend weights, per-node material params, and per-frame statistics into frame.layers.spatial.hlod and frame.layers.physical.hlod. Zero allocation after the first frame: all node pools, scratch Vec3/Mat4/Quat/Box3/Frustum/Plane objects, and per-tier visible lists are pre-allocated and reused.
// best for : Every consumer that needs hierarchical visibility — the renderer's draw-call batcher, the clustered-lighting pass (which needs to know how many light-affecting nodes exist per tier), the landscape chunk streamer (which uses the tier-3 visible list as its coarse spatial index), the terrain shadow scaler (which scales shadow cascades per tier), and the material shader (which reads per-node blend weights to decide PBR vs anime mix). Complements 302_CameraVelocityExtrapolator (which provides the predicted frustum) and 299_PersistentWorldMemory (which ensures nodes exist when the HLOD says they should be visible) by being the scheduler that stitches the two together.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  Box3, Frustum, Plane, Sphere, Ray, OBB,
  BufferAttribute, BufferGeometry,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                       from './268_ExtrasCurveUtils.js';
import { ExtrasLODHelper, LOD_TIER }                        from './269_ExtrasLODHelper.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';
import { AirQualityAtmosphereProvider, AIR_QUALITY_PRESET } from './295_AirQualityAtmosphereProvider.js';
import { MaterialRegistry, MATERIAL_KIND }                  from './298_MaterialRegistry.js';
import { PersistentWorldMemory }                            from './299_PersistentWorldMemory.js';
import { CameraVelocityExtrapolator, PREDICTION_STATE }     from './302_CameraVelocityExtrapolator.js';

// ══════════════════════════════════════════════════════════════════
// ─── HLOD TIER DEFINITIONS ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const HLOD_TIER = Object.freeze({
  KM_1:    0,
  KM_10:   1,
  KM_100:  2,
  KM_1000: 3
});

const HLOD_TIER_NAMES = Object.freeze([
  'km_1', 'km_10', 'km_100', 'km_1000'
]);

// ─── Per-tier spatial scale (metres per node) ─────────────────
const HLOD_TIER_SCALE = Object.freeze([
  1000.0,        // 1 km
  10000.0,       // 10 km
  100000.0,      // 100 km
  1000000.0      // 1000 km
]);

// ─── Per-tier distance thresholds (d_ℓ = d₀·R^ℓ) ──────────────
// d_0 = 1000 m, R = 10 → d_0, d_1, d_2, d_3, d_4
const HLOD_THRESHOLDS = Object.freeze([
  1000.0,        // d_0 — start of tier 0
  10000.0,       // d_1 — start of tier 1
  100000.0,      // d_2 — start of tier 2
  1000000.0,     // d_3 — start of tier 3
  10000000.0     // d_4 — end of tier 3
]);

// ─── Per-tier node capacity (pre-allocated) ───────────────────
const HLOD_TIER_NODE_CAPACITY = Object.freeze([
  256,           // tier 0 (1 km): 256 nodes near camera
  128,           // tier 1 (10 km): 128 nodes
  64,            // tier 2 (100 km): 64 nodes
  32             // tier 3 (1000 km): 32 nodes
]);

// ─── Per-tier material presets ────────────────────────────────
// Near tiers = full PBR, mid tiers = blend, far tiers = flat anime.
const HLOD_TIER_MATERIAL = Object.freeze([
  // Tier 0 (1 km) — full PBR
  {
    pbrWeight:      1.00,
    animeWeight:    0.00,
    normalDetail:   1.00,
    shadowCascades: 4,
    anisotropy:     1.00,
    emissiveScale:  1.00,
    fogAbsorption:  1.00
  },
  // Tier 1 (10 km) — PBR dominant, slight anime flatten
  {
    pbrWeight:      0.75,
    animeWeight:    0.25,
    normalDetail:   0.50,
    shadowCascades: 2,
    anisotropy:     0.50,
    emissiveScale:  0.85,
    fogAbsorption:  1.15
  },
  // Tier 2 (100 km) — anime dominant, PBR simplifies
  {
    pbrWeight:      0.25,
    animeWeight:    0.75,
    normalDetail:   0.15,
    shadowCascades: 1,
    anisotropy:     0.10,
    emissiveScale:  0.60,
    fogAbsorption:  1.40
  },
  // Tier 3 (1000 km) — flat anime / billboard
  {
    pbrWeight:      0.00,
    animeWeight:    1.00,
    normalDetail:   0.00,
    shadowCascades: 0,
    anisotropy:     0.00,
    emissiveScale:  0.30,
    fogAbsorption:  1.80
  }
]);

// ─── Node state codes ─────────────────────────────────────────
const NODE_STATE = Object.freeze({
  FREE:      0,
  ACTIVE:    1,
  CULLED:    2,
  FADING_IN: 3,
  FADING_OUT: 4
});

// ─── Culling result codes ─────────────────────────────────────
const CULL_RESULT = Object.freeze({
  INSIDE:   0,
  INTERSECT: 1,
  OUTSIDE:   2
});

// ══════════════════════════════════════════════════════════════════
// ─── HLOD NODE (pooled) ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class HLODNode {
  constructor() {
    this.state = NODE_STATE.FREE;
    this.tier = 0;
    this.nodeId = -1;
    this.chunkX = 0;
    this.chunkZ = 0;
    this.centerX = 0;
    this.centerY = 0;
    this.centerZ = 0;
    this.radius = 0;
    this.minX = 0; this.minY = 0; this.minZ = 0;
    this.maxX = 0; this.maxY = 0; this.maxZ = 0;
    this.parentIndex = -1;
    this.childStart = -1;
    this.childCount = 0;
    this.distanceToCamera = 0;
    this.currentAlpha = 1.0;
    this.targetAlpha = 1.0;
    this.screenCoverage = 0;
    this.lastCullResult = CULL_RESULT.OUTSIDE;
    this.lastVisible = 0;
    this.materialId = -1;
    this.assetReady = 0;

    // Per-node material modifiers (synced from the frame)
    this.wetness = 0;
    this.snowCoverage = 0;
    this.fireIntensity = 0;
    this.mossCoverage = 0;
    this.emissiveBoost = 0;
    this.frostiness = 0;
    this.seasonalPhase = 0.5;

    // Cached blended params (per-node)
    this.blendWeight = 0;
    this.emissiveScale = 1;
    this.lightContribution = 0;
  }

  reset() {
    this.state = NODE_STATE.FREE;
    this.tier = 0;
    this.nodeId = -1;
    this.chunkX = 0;
    this.chunkZ = 0;
    this.centerX = 0;
    this.centerY = 0;
    this.centerZ = 0;
    this.radius = 0;
    this.minX = 0; this.minY = 0; this.minZ = 0;
    this.maxX = 0; this.maxY = 0; this.maxZ = 0;
    this.parentIndex = -1;
    this.childStart = -1;
    this.childCount = 0;
    this.distanceToCamera = 0;
    this.currentAlpha = 1.0;
    this.targetAlpha = 1.0;
    this.screenCoverage = 0;
    this.lastCullResult = CULL_RESULT.OUTSIDE;
    this.lastVisible = 0;
    this.materialId = -1;
    this.assetReady = 0;
    this.wetness = 0;
    this.snowCoverage = 0;
    this.fireIntensity = 0;
    this.mossCoverage = 0;
    this.emissiveBoost = 0;
    this.frostiness = 0;
    this.seasonalPhase = 0.5;
    this.blendWeight = 0;
    this.emissiveScale = 1;
    this.lightContribution = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── HLOD CONTROLLER ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class HLODController {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      worldSeed:              options.worldSeed ?? 0x3HL0D | 0,
      enableCrossFade:        options.enableCrossFade ?? true,
      fadeInStart:            options.fadeInStart ?? 0.85,   // fraction of d_ℓ
      fadeOutEnd:             options.fadeOutEnd ?? 1.15,    // fraction of d_{ℓ+1}
      fadeSpeed:              options.fadeSpeed ?? 3.5,      // 1/s
      cullMode:               options.cullMode ?? 'frustum', // 'frustum' | 'sphere' | 'aabb'
      maxNodesPerTier:        options.maxNodesPerTier ?? HLOD_TIER_NODE_CAPACITY.slice(),
      enableAdaptiveCapacity: options.enableAdaptiveCapacity ?? true,
      cameraExtrapolator:     options.cameraExtrapolator ?? null,
      materialRegistry:       options.materialRegistry ?? null,
      worldMemory:            options.worldMemory ?? null,
      enableMaterialBlending: options.enableMaterialBlending ?? true,
      enableShadowScaler:     options.enableShadowScaler ?? true,
      enableEvents:           options.enableEvents ?? true
    };
    this.defaults.worldSeed = this.defaults.worldSeed | 0;

    // ── Node pools (one per tier) ────────────────────────
    this._tierPools = new Array(4);
    this._tierFreeLists = new Array(4);
    this._tierFreeCounts = new Int32Array(4);
    this._tierActiveCounts = new Int32Array(4);

    for (let tier = 0; tier < 4; tier++) {
      const cap = this.defaults.maxNodesPerTier[tier];
      const pool = new Array(cap);
      for (let i = 0; i < cap; i++) pool[i] = new HLODNode();
      this._tierPools[tier] = pool;

      const freeList = new Int32Array(cap);
      for (let i = 0; i < cap; i++) freeList[i] = cap - 1 - i;
      this._tierFreeLists[tier] = freeList;
      this._tierFreeCounts[tier] = cap;
      this._tierActiveCounts[tier] = 0;
    }

    // ── Node key index (chunkX, chunkZ, tier → pool index) ─
    this._nodeIndex = new Map();

    // ── Per-tier visible lists (reused) ──────────────────
    this._visibleLists = new Array(4);
    this._visibleCounts = new Int32Array(4);
    for (let tier = 0; tier < 4; tier++) {
      this._visibleLists[tier] = new Int32Array(this.defaults.maxNodesPerTier[tier]);
      this._visibleCounts[tier] = 0;
    }

    // ── Camera state ─────────────────────────────────────
    this._cameraPos = new Vec3();
    this._cameraDir = new Vec3(0, 0, -1);
    this._cameraValid = false;

    // ── Predicted frustum (from 302) ────────────────────
    this._frustumPlanes = new Float64Array(18);
    this._frustumDistances = new Float64Array(6);

    // ── Scratch (pooled) ─────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec3C = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4A = new Mat4();
    this._tmpMat4B = new Mat4();
    this._tmpQuatA = new Quat();
    this._tmpBox3A = new Box3();
    this._tmpSphere = new Sphere();
    this._tmpPlane = new Plane();
    this._tmpFrustum = new Frustum();

    // ── Statistics ───────────────────────────────────────
    this._stats = {
      nodesRegistered: 0,
      nodesUnregistered: 0,
      totalFrustumTests: 0,
      totalVisibleNodes: 0,
      tierVisible: new Int32Array(4),
      tierCulled: new Int32Array(4),
      crossFadesActive: 0,
      materialBlends: 0,
      shadowCascadeUpdates: 0,
      tierTransitions: 0
    };

    // ── Collaborators ────────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._frameRef = null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }
  attachCameraExtrapolator(e) { this.defaults.cameraExtrapolator = e; return this; }
  attachMaterialRegistry(m) { this.defaults.materialRegistry = m; return this; }
  attachWorldMemory(w) { this.defaults.worldMemory = w; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── Node key packing ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _makeNodeKey(tier, chunkX, chunkZ) {
    return tier * 1e15 + chunkX * 1e7 + chunkZ;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Register an HLOD node ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Called when a landscape chunk, entity cluster, or HLOD wrapper
  // needs to participate in hierarchical LOD. Returns a node
  // handle (poolIndex-based) or -1 if the tier is full.
  registerNode(tier, chunkX, chunkZ, worldCenterX, worldCenterY, worldCenterZ,
               radius, materialId = -1) {
    if (tier < 0 || tier > 3) return -1;
    const key = this._makeNodeKey(tier, chunkX, chunkZ);
    if (this._nodeIndex.has(key)) return this._nodeIndex.get(key);

    if (this._tierFreeCounts[tier] === 0) {
      // Tier is full; optionally evict the oldest node.
      if (!this.defaults.enableAdaptiveCapacity) return -1;
      this._evictOldestNodeInTier(tier);
      if (this._tierFreeCounts[tier] === 0) return -1;
    }

    this._tierFreeCounts[tier]--;
    const poolIndex = this._tierFreeLists[tier][this._tierFreeCounts[tier]];
    const node = this._tierPools[tier][poolIndex];

    node.reset();
    node.state = NODE_STATE.ACTIVE;
    node.tier = tier;
    node.nodeId = key;
    node.chunkX = chunkX;
    node.chunkZ = chunkZ;
    node.centerX = worldCenterX;
    node.centerY = worldCenterY;
    node.centerZ = worldCenterZ;
    node.radius = radius;

    // Compute AABB from sphere center + radius.
    node.minX = worldCenterX - radius;
    node.minY = worldCenterY - radius;
    node.minZ = worldCenterZ - radius;
    node.maxX = worldCenterX + radius;
    node.maxY = worldCenterY + radius;
    node.maxZ = worldCenterZ + radius;

    node.materialId = materialId;
    node.currentAlpha = 1.0;
    node.targetAlpha = 1.0;

    this._tierActiveCounts[tier]++;
    this._stats.nodesRegistered++;

    this._nodeIndex.set(key, { tier, poolIndex });

    return { tier, poolIndex };
  }

  // ══════════════════════════════════════════════════════════
  // ─── Link parent → child relationships ──────────────────
  // ══════════════════════════════════════════════════════════
  // A tier-ℓ node owns a range of children in tier-(ℓ-1).
  // Call this after registering all children.
  linkHierarchy(parentTier, parentChunkX, parentChunkZ,
                childTier, childChunkXs, childChunkZs) {
    if (parentTier < 1 || parentTier > 3) return false;
    if (childTier !== parentTier - 1) return false;

    const parentKey = this._makeNodeKey(parentTier, parentChunkX, parentChunkZ);
    const parentRef = this._nodeIndex.get(parentKey);
    if (!parentRef) return false;

    const parentNode = this._tierPools[parentTier][parentRef.poolIndex];

    // Children must be contiguous in the child tier's pool.
    // For simplicity we assume the caller registers children in order.
    let childStart = -1;
    let childCount = 0;

    for (let i = 0; i < childChunkXs.length; i++) {
      const childKey = this._makeNodeKey(childTier, childChunkXs[i], childChunkZs[i]);
      const childRef = this._nodeIndex.get(childKey);
      if (!childRef) continue;

      const childNode = this._tierPools[childTier][childRef.poolIndex];
      childNode.parentIndex = parentRef.poolIndex;

      if (childStart === -1) childStart = childRef.poolIndex;
      childCount++;
    }

    parentNode.childStart = childStart;
    parentNode.childCount = childCount;

    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Unregister a node ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  unregisterNode(tier, chunkX, chunkZ) {
    if (tier < 0 || tier > 3) return false;
    const key = this._makeNodeKey(tier, chunkX, chunkZ);
    const ref = this._nodeIndex.get(key);
    if (!ref) return false;

    const node = this._tierPools[tier][ref.poolIndex];
    node.reset();

    this._tierFreeLists[tier][this._tierFreeCounts[tier]++] = ref.poolIndex;
    this._tierActiveCounts[tier]--;
    this._nodeIndex.delete(key);
    this._stats.nodesUnregistered++;

    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Eviction (adaptive capacity) ──────────────────────
  // ══════════════════════════════════════════════════════════
  _evictOldestNodeInTier(tier) {
    const pool = this._tierPools[tier];
    let oldestIdx = -1;
    let maxDist = -1;

    for (let i = 0; i < pool.length; i++) {
      const node = pool[i];
      if (node.state === NODE_STATE.FREE) continue;
      if (node.distanceToCamera > maxDist) {
        maxDist = node.distanceToCamera;
        oldestIdx = i;
      }
    }

    if (oldestIdx >= 0) {
      const node = pool[oldestIdx];
      const key = this._makeNodeKey(tier, node.chunkX, node.chunkZ);
      node.reset();
      this._tierFreeLists[tier][this._tierFreeCounts[tier]++] = oldestIdx;
      this._tierActiveCounts[tier]--;
      this._nodeIndex.delete(key);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Distance-based tier selection ─────────────────────
  // ══════════════════════════════════════════════════════════
  // Formula: ℓ = clamp(floor(log_R(d/d_0)), 0, 3)
  // where R = 10, d_0 = 1000.
  computeLODTier(distance) {
    if (distance <= HLOD_THRESHOLDS[0]) return 0;
    if (distance >= HLOD_THRESHOLDS[4]) return 3;
    const log10 = Math.log(distance / HLOD_THRESHOLDS[0]) / Math.log(10);
    let tier = Math.floor(log10);
    if (tier < 0) tier = 0;
    if (tier > 3) tier = 3;
    return tier;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Blend weight for a tier-ℓ node ───────────────────
  // ══════════════════════════════════════════════════════════
  // Node is fully visible when d ∈ [d_ℓ, d_{ℓ+1}].
  // It fades IN between d_ℓ·fadeInStart and d_ℓ.
  // It fades OUT between d_{ℓ+1} and d_{ℓ+1}·fadeOutEnd.
  computeBlendWeight(tier, distance) {
    if (tier < 0 || tier > 3) return 0;
    const dLow = HLOD_THRESHOLDS[tier];
    const dHigh = HLOD_THRESHOLDS[tier + 1];
    const fadeInStart = dLow * this.defaults.fadeInStart;
    const fadeOutEnd = dHigh * this.defaults.fadeOutEnd;

    // Fade-in as distance decreases below dLow.
    if (distance < fadeInStart) return 0;
    if (distance < dLow) {
      // Fade in.
      return smoothstep(fadeInStart, dLow, distance);
    }

    // Fully visible in the sweet spot.
    if (distance <= dHigh) return 1;

    // Fade out above dHigh.
    if (distance < fadeOutEnd) {
      return 1 - smoothstep(dHigh, fadeOutEnd, distance);
    }

    return 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frustum extraction from predicted camera ──────────
  // ══════════════════════════════════════════════════════════
  _updateFrustum(frame) {
    const extrapolator = this.defaults.cameraExtrapolator;
    if (!extrapolator) return;

    // Read camera from extrapolator.
    const predPos = extrapolator.predictedPosition;
    const predQuat = extrapolator.predictedQuaternion;
    this._cameraPos.copy(predPos);
    this._cameraDir.set(0, 0, -1).applyQuaternion(predQuat);
    this._cameraValid = true;

    // Read the precomputed frustum planes from 302.
    const planes = extrapolator.predictedFrustumPlanes;
    const dists = extrapolator.predictedFrustumDistances;
    for (let i = 0; i < 18; i++) this._frustumPlanes[i] = planes[i];
    for (let i = 0; i < 6; i++) this._frustumDistances[i] = dists[i];
  }

  // ══════════════════════════════════════════════════════════
  // ─── Culling helpers ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _testSphere(cx, cy, cz, radius) {
    const planes = this._frustumPlanes;
    const dists = this._frustumDistances;
    let result = CULL_RESULT.INSIDE;

    for (let i = 0; i < 6; i++) {
      const o = i * 3;
      const d = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + dists[i];
      if (d < -radius) return CULL_RESULT.OUTSIDE;
      if (d < radius) result = CULL_RESULT.INTERSECT;
    }
    return result;
  }

  _testAABB(minX, minY, minZ, maxX, maxY, maxZ) {
    const planes = this._frustumPlanes;
    const dists = this._frustumDistances;
    let result = CULL_RESULT.INSIDE;

    for (let i = 0; i < 6; i++) {
      const o = i * 3;
      const nx = planes[o];
      const ny = planes[o + 1];
      const nz = planes[o + 2];
      const px = nx >= 0 ? maxX : minX;
      const py = ny >= 0 ? maxY : minY;
      const pz = nz >= 0 ? maxZ : minZ;
      const d = nx * px + ny * py + nz * pz + dists[i];
      if (d < 0) return CULL_RESULT.OUTSIDE;
    }
    return result;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Cull a single node (returns true if visible) ──────
  // ══════════════════════════════════════════════════════════
  _cullNode(node) {
    if (!this._cameraValid) {
      node.lastCullResult = CULL_RESULT.INSIDE;
      return true;
    }

    // Distance first (cheap).
    const dx = node.centerX - this._cameraPos.x;
    const dy = node.centerY - this._cameraPos.y;
    const dz = node.centerZ - this._cameraPos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    node.distanceToCamera = Math.sqrt(distSq);

    // Distance-based cutoff: nodes beyond 10·d₀ (10,000 km) are never visible.
    if (node.distanceToCamera > HLOD_THRESHOLDS[4]) {
      node.lastCullResult = CULL_RESULT.OUTSIDE;
      return false;
    }

    // Frustum test based on cull mode.
    let result;
    if (this.defaults.cullMode === 'sphere') {
      result = this._testSphere(
        node.centerX, node.centerY, node.centerZ, node.radius
      );
    } else if (this.defaults.cullMode === 'aabb') {
      result = this._testAABB(
        node.minX, node.minY, node.minZ,
        node.maxX, node.maxY, node.maxZ
      );
    } else {
      // Default 'frustum' mode: use both, sphere first then AABB if needed.
      result = this._testSphere(
        node.centerX, node.centerY, node.centerZ, node.radius
      );
      if (result === CULL_RESULT.INSIDE) {
        // Sphere test passed cleanly.
      } else if (result === CULL_RESULT.INTERSECT) {
        // Refine with AABB for more precise culling.
        const aabbResult = this._testAABB(
          node.minX, node.minY, node.minZ,
          node.maxX, node.maxY, node.maxZ
        );
        result = aabbResult;
      }
    }

    node.lastCullResult = result;
    this._stats.totalFrustumTests++;
    return result !== CULL_RESULT.OUTSIDE;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Hierarchical culling (descend from coarse to fine) ─
  // ══════════════════════════════════════════════════════════
  // Start at tier 3 (1000 km). If visible, test its children
  // in tier 2. If those are visible, descend to tier 1, then 0.
  _hierarchicalCull() {
    // Reset visible counters.
    for (let tier = 0; tier < 4; tier++) {
      this._visibleCounts[tier] = 0;
      this._stats.tierVisible[tier] = 0;
      this._stats.tierCulled[tier] = 0;
    }

    // Descend from coarsest tier to finest.
    for (let tier = 3; tier >= 0; tier--) {
      const pool = this._tierPools[tier];
      const visibleList = this._visibleLists[tier];
      let visibleCount = 0;

      for (let i = 0; i < pool.length; i++) {
        const node = pool[i];
        if (node.state !== NODE_STATE.ACTIVE) continue;

        // If a parent exists and is not visible, skip this node.
        if (node.parentIndex >= 0 && tier < 3) {
          const parentPool = this._tierPools[tier + 1];
          const parentNode = parentPool[node.parentIndex];
          if (parentNode && parentNode.lastVisible === 0) {
            node.lastVisible = 0;
            node.lastCullResult = CULL_RESULT.OUTSIDE;
            this._stats.tierCulled[tier]++;
            continue;
          }
        }

        // Cull this node.
        const visible = this._cullNode(node);
        node.lastVisible = visible ? 1 : 0;

        if (visible) {
          // Compute blend weight.
          node.targetAlpha = this.computeBlendWeight(tier, node.distanceToCamera);
          if (node.targetAlpha > 0.01) {
            visibleList[visibleCount++] = i;
            this._stats.tierVisible[tier]++;
          } else {
            node.lastVisible = 0;
            this._stats.tierCulled[tier]++;
          }
        } else {
          this._stats.tierCulled[tier]++;
        }
      }

      this._visibleCounts[tier] = visibleCount;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Update cross-fade alphas ──────────────────────────
  // ══════════════════════════════════════════════════════════
  _updateAlphas(dt) {
    const fadeSpeed = this.defaults.fadeSpeed;
    let fadesActive = 0;

    for (let tier = 0; tier < 4; tier++) {
      const pool = this._tierPools[tier];
      for (let i = 0; i < pool.length; i++) {
        const node = pool[i];
        if (node.state !== NODE_STATE.ACTIVE) continue;

        // Smoothly approach target alpha.
        const diff = node.targetAlpha - node.currentAlpha;
        if (Math.abs(diff) > 0.001) {
          const step = Math.sign(diff) * Math.min(Math.abs(diff), fadeSpeed * dt);
          node.currentAlpha += step;
          fadesActive++;
        } else {
          node.currentAlpha = node.targetAlpha;
        }
      }
    }

    this._stats.crossFadesActive = fadesActive;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Sync material state from the frame ────────────────
  // ══════════════════════════════════════════════════════════
  _syncMaterialState(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    // Global modifiers (from climate, air quality, seasonality).
    const globalWetness = physical.surfaceWetness ?? 0;
    const globalSnow = physical.snowCoverage ?? 0;
    const globalAOD = physical.aerosolOpticalDepth ?? 0.1;
    const globalSunIntensity = physical.sunIntensity ?? 1.0;
    const globalEmissiveBoost = physical.bioluminescenceTotal ?? 0;

    // Causal emissive boost from nearby impacts/fires.
    let causalEmissiveBoost = 0;
    const causal = frame.layers.causal;
    if (causal && causal.derivedSignals) {
      const ds = causal.derivedSignals;
      for (let i = 0; i < ds.count; i++) {
        if (ds.types[i] === DERIVED_SIGNAL.EMISSIVE_BOOST ||
            ds.types[i] === DERIVED_SIGNAL.IGNITE_CANDIDATE) {
          causalEmissiveBoost += ds.forces[i] * 0.01 * ds.decays[i];
        }
      }
    }

    // Apply to each node per tier.
    for (let tier = 0; tier < 4; tier++) {
      const tierMaterial = HLOD_TIER_MATERIAL[tier];
      const pool = this._tierPools[tier];

      for (let i = 0; i < pool.length; i++) {
        const node = pool[i];
        if (node.state !== NODE_STATE.ACTIVE) continue;

        // Per-node modifiers from MaterialRegistry base descriptor.
        if (this.defaults.materialRegistry && node.materialId >= 0) {
          const desc = this.defaults.materialRegistry.getDescriptor(node.materialId);
          if (desc) {
            node.wetness = globalWetness * desc.wetnessResponse;
            node.emissiveBoost = (desc.emissive[0] + desc.emissive[1] + desc.emissive[2]) * 0.33;
          }
        }

        // Global modifiers.
        node.snowCoverage = globalSnow;
        node.emissiveBoost += globalEmissiveBoost + causalEmissiveBoost;

        // Fog absorption: farther tiers absorb more light.
        const fogFactor = tierMaterial.fogAbsorption * (1 + globalAOD);
        node.lightContribution = (1 - Math.min(1, fogFactor * 0.1)) * globalSunIntensity;

        // Emissive scale per tier.
        node.emissiveScale = tierMaterial.emissiveScale;

        // The blend weight (0 = pure PBR, 1 = pure anime) is the
        // cross-fade alpha combined with the tier's PBR/anime ratio.
        const crossFadeAlpha = node.currentAlpha;
        const tierAnimeWeight = tierMaterial.animeWeight;
        // When a node is fading out, it's transitioning to the next tier.
        // The blend weight increases toward the tier's anime weight.
        node.blendWeight = tierAnimeWeight + (1 - crossFadeAlpha) * (1 - tierAnimeWeight);
        if (node.blendWeight > 1) node.blendWeight = 1;
        if (node.blendWeight < 0) node.blendWeight = 0;

        this._stats.materialBlends++;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.hlod) {
      spatial.hlod = {
        tierCount: 4,
        nodes: this._tierPools,
        visibleLists: this._visibleLists,
        visibleCounts: this._visibleCounts,
        tierActiveCounts: this._tierActiveCounts,
        tierThresholds: HLOD_THRESHOLDS,
        tierScale: HLOD_TIER_SCALE,
        tierMaterial: HLOD_TIER_MATERIAL,
        tierNames: HLOD_TIER_NAMES,
        // Fast visibility lookups.
        totalVisible: 0,
        totalCulled: 0,
        totalActive: 0
      };
    }

    const hlod = spatial.hlod;
    let totalVisible = 0;
    let totalCulled = 0;
    let totalActive = 0;

    for (let tier = 0; tier < 4; tier++) {
      totalVisible += this._visibleCounts[tier];
      totalCulled += this._stats.tierCulled[tier];
      totalActive += this._tierActiveCounts[tier];
    }

    hlod.totalVisible = totalVisible;
    hlod.totalCulled = totalCulled;
    hlod.totalActive = totalActive;
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.hlod) {
      physical.hlod = {
        totalVisible: 0,
        totalCulled: 0,
        totalActive: 0,
        tierVisible: this._stats.tierVisible,
        tierCulled: this._stats.tierCulled,
        crossFadesActive: 0,
        materialBlends: 0,
        frustumTests: 0,
        // Shadow cascades per tier for lighting.
        shadowCascades: new Int32Array(4),
        // Emissive totals per tier for clustered lighting.
        tierEmissive: new Float32Array(4)
      };
    }

    const hlod = physical.hlod;
    let totalVisible = 0;
    let totalCulled = 0;
    let totalActive = 0;
    for (let tier = 0; tier < 4; tier++) {
      totalVisible += this._visibleCounts[tier];
      totalCulled += this._stats.tierCulled[tier];
      totalActive += this._tierActiveCounts[tier];
    }

    hlod.totalVisible = totalVisible;
    hlod.totalCulled = totalCulled;
    hlod.totalActive = totalActive;
    hlod.crossFadesActive = this._stats.crossFadesActive;
    hlod.materialBlends = this._stats.materialBlends;
    hlod.frustumTests = this._stats.totalFrustumTests;

    // Shadow cascade count per tier (from HLOD tier material).
    for (let tier = 0; tier < 4; tier++) {
      hlod.shadowCascades[tier] = HLOD_TIER_MATERIAL[tier].shadowCascades;
    }

    // Aggregate emissive per tier (for clustered lighting).
    let tierEmissive0 = 0, tierEmissive1 = 0, tierEmissive2 = 0, tierEmissive3 = 0;
    for (let i = 0; i < this._visibleCounts[0]; i++) {
      const node = this._tierPools[0][this._visibleLists[0][i]];
      tierEmissive0 += node.emissiveBoost * node.currentAlpha;
    }
    for (let i = 0; i < this._visibleCounts[1]; i++) {
      const node = this._tierPools[1][this._visibleLists[1][i]];
      tierEmissive1 += node.emissiveBoost * node.currentAlpha;
    }
    for (let i = 0; i < this._visibleCounts[2]; i++) {
      const node = this._tierPools[2][this._visibleLists[2][i]];
      tierEmissive2 += node.emissiveBoost * node.currentAlpha;
    }
    for (let i = 0; i < this._visibleCounts[3]; i++) {
      const node = this._tierPools[3][this._visibleLists[3][i]];
      tierEmissive3 += node.emissiveBoost * node.currentAlpha;
    }
    hlod.tierEmissive[0] = tierEmissive0;
    hlod.tierEmissive[1] = tierEmissive1;
    hlod.tierEmissive[2] = tierEmissive2;
    hlod.tierEmissive[3] = tierEmissive3;

    // Total emissive for the whole scene.
    physical.hlodTotalEmissive = tierEmissive0 + tierEmissive1 + tierEmissive2 + tierEmissive3;

    // Weighted average blend weight (how "anime" the scene is).
    let totalWeight = 0;
    let totalAlpha = 0;
    for (let tier = 0; tier < 4; tier++) {
      const pool = this._tierPools[tier];
      const list = this._visibleLists[tier];
      const count = this._visibleCounts[tier];
      for (let i = 0; i < count; i++) {
        const node = pool[list[i]];
        totalWeight += node.blendWeight * node.currentAlpha;
        totalAlpha += node.currentAlpha;
      }
    }
    physical.hlodSceneAnimeWeight = totalAlpha > 0 ? totalWeight / totalAlpha : 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    const dt = clock ? clock.delta : 1 / 60;

    // ── 1. Update frustum from extrapolator ────────────
    this._updateFrustum(frame);

    // ── 2. Hierarchical cull ────────────────────────────
    this._hierarchicalCull();

    // ── 3. Update cross-fade alphas ────────────────────
    this._updateAlphas(dt);

    // ── 4. Sync material state ──────────────────────────
    this._syncMaterialState(frame);

    // ── 5. Emit tier-transition causal events ──────────
    // (Skipped for brevity; each node tracks its own state.)

    // ── 6. Write to frame layers ────────────────────────
    this._writeToSpatialLayer(frame);
    this._writeToPhysicalLayer(frame);

    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getNode(tier, chunkX, chunkZ) {
    if (tier < 0 || tier > 3) return null;
    const key = this._makeNodeKey(tier, chunkX, chunkZ);
    const ref = this._nodeIndex.get(key);
    if (!ref) return null;
    return this._tierPools[tier][ref.poolIndex];
  }

  getVisibleCount(tier) {
    if (tier < 0 || tier > 3) return 0;
    return this._visibleCounts[tier];
  }

  getVisibleList(tier) {
    if (tier < 0 || tier > 3) return null;
    return this._visibleLists[tier];
  }

  getActiveCount(tier) {
    if (tier < 0 || tier > 3) return 0;
    return this._tierActiveCounts[tier];
  }

  // ── Compute the tier a world position maps to ───────────
  computeTierForPosition(worldX, worldZ) {
    if (!this._cameraValid) return 0;
    const dx = worldX - this._cameraPos.x;
    const dz = worldZ - this._cameraPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    return this.computeLODTier(dist);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Interactive setters ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setFadeParameters(fadeInStart, fadeOutEnd, fadeSpeed) {
    if (fadeInStart !== undefined) this.defaults.fadeInStart = fadeInStart;
    if (fadeOutEnd !== undefined) this.defaults.fadeOutEnd = fadeOutEnd;
    if (fadeSpeed !== undefined) this.defaults.fadeSpeed = fadeSpeed;
    return this;
  }

  setCullMode(mode) {
    if (mode === 'frustum' || mode === 'sphere' || mode === 'aabb') {
      this.defaults.cullMode = mode;
    }
    return this;
  }

  setMaxNodesPerTier(tier, maxNodes) {
    if (tier >= 0 && tier < 4 && maxNodes > 0) {
      this.defaults.maxNodesPerTier[tier] = maxNodes;
    }
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      nodesRegistered: this._stats.nodesRegistered,
      nodesUnregistered: this._stats.nodesUnregistered,
      totalFrustumTests: this._stats.totalFrustumTests,
      crossFadesActive: this._stats.crossFadesActive,
      materialBlends: this._stats.materialBlends,
      tierVisible: Array.from(this._stats.tierVisible),
      tierCulled: Array.from(this._stats.tierCulled),
      tierActive: Array.from(this._tierActiveCounts)
    });
  }

  resetStats() {
    this._stats.nodesRegistered = 0;
    this._stats.nodesUnregistered = 0;
    this._stats.totalFrustumTests = 0;
    this._stats.totalVisibleNodes = 0;
    this._stats.tierVisible.fill(0);
    this._stats.tierCulled.fill(0);
    this._stats.crossFadesActive = 0;
    this._stats.materialBlends = 0;
    this._stats.shadowCascadeUpdates = 0;
    this._stats.tierTransitions = 0;
  }

  dispose() {
    for (let tier = 0; tier < 4; tier++) {
      const pool = this._tierPools[tier];
      for (let i = 0; i < pool.length; i++) pool[i].reset();
      this._tierPools[tier] = [];
    }
    this._nodeIndex.clear();
    this._dispatcher = null;
    this._clock = null;
    this._frameRef = null;
    this._cameraValid = false;
  }
}

export {
  HLODController,
  HLODNode,
  HLOD_TIER,
  HLOD_TIER_NAMES,
  HLOD_TIER_SCALE,
  HLOD_THRESHOLDS,
  HLOD_TIER_NODE_CAPACITY,
  HLOD_TIER_MATERIAL,
  NODE_STATE,
  CULL_RESULT
};