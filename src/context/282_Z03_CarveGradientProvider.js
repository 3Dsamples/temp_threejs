// file number : 282_Z03
// full path name : src/context/282_Z03_CarveGradientProvider.js
// description : Active terrain carving provider that applies real-time erosion, weathering, and impact deltas to a base heightfield on top of the immutable surface defined by 280_TerrainProvider, 281_ElevationProvider, and 282_SlopeGradientProvider. Maintains per-chunk carve-delta buffers (flat SoA Float32Arrays) that persist across frames, coalescing repeated carve events on the same cell so a fireball hitting a forest produces one causal mutation event instead of fifty (blueprint step 16). Supports five carve sources: hydraulic erosion (water flow), aeolian erosion (wind), cryogenic weathering (frost/thaw), thermal collapse (slope above repose), and direct impact (crater / blast). Each source has a physics-motivated rate law: E_h = k_h · |∇h|^α · humidity · Q_flow (hydraulic), E_w = k_w · |wind|^β · (1 − vegetation) · sin(θ) (wind), E_f = k_f · (T_freeze − T)/ΔT · wetness (frost), E_t = k_t · max(0, tanθ − tanθ_repose) (thermal), E_i = F·cosθ / (ρ·A) (impact). Exposes carveDelta(x, z, amount) so any external system or causal event can stamp a crater, and carveMaterialBand(x, z, band) so freshly-carved cells take on the material band of the underlying rock/soil (bare soil, fresh rock, wet mud, volcanic, etc.). Materials consume this through frame.layers.physical.carveBandWeights so shaders blend smoothly from vegetated to freshly exposed terrain over a configurable recovery tau. Emits MUTATION causal events only when cumulative delta exceeds a threshold and coalesced per cell, and the persistence system reads the delta buffer to store the modified surface in world memory. All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs a terrain surface that visibly evolves in real time — water carving riverbeds on river flow, wind eroding dunes and ridges, frost cracking rock on cold nights, thermal collapse after earthquakes, and impact craters from physical events. Feeds LandscapeErosionSimulator, LandscapeWaterFlowSystem, LandscapeWindErosionSystem, LandscapeChunkMutationReplay, LandscapeChunkPersistence, and the material system.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision,
  ContextFrame, CoreClock, CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES,
  TemporalContextProvider, WEATHER,
  CausalContextProvider, DERIVED_SIGNAL,
  PhysicalContextProvider, PHYSICS_ENGINE,
  CoreLayers, LAYER, LAYER_MASKS,
  smoothstep,
  TerrainProvider, BIOME_HINT,
  ElevationProvider, ELEVATION_BAND,
  SlopeGradientProvider, SLOPE_BAND, SLOPE_BAND_THRESHOLDS,
  ReliefGradientProvider, RELIEF_CLASS,
  CliffsGradientProvider, CLIFF_CLASS, CLIFF_MATERIAL_BAND
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 4;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── carve sources ───────────────────────────────────────────────
const CARVE_SOURCE = Object.freeze({
  NONE:      0,
  HYDRAULIC: 1,    // water flow
  AEOLIAN:   2,    // wind
  FROST:     3,    // ice / freeze-thaw
  THERMAL:   4,    // slope collapse above repose
  IMPACT:    5,    // blast / crater
  BIOTIC:    6,    // roots, burrowing, trampling
  VOLCANIC:  7     // lava flow, ash deposit
});

const CARVE_SOURCE_NAMES = Object.freeze([
  'none', 'hydraulic', 'aeolian', 'frost', 'thermal',
  'impact', 'biotic', 'volcanic'
]);

// ─── carve material bands ────────────────────────────────────────
// Freshly carved terrain belongs to a different material band than
// undisturbed terrain, and materials read this to blend their shader.
const CARVE_MATERIAL_BAND = Object.freeze({
  VEGETATED:    0,   // undisturbed, covered by plants / soil
  BARE_SOIL:    1,   // recently exposed by erosion
  FRESH_ROCK:   2,   // newly exposed bedrock from a cliff collapse
  WET_MUD:      3,   // after a hydraulic event
  FRESH_SCREE:  4,   // after a rockfall
  VOLCANIC:     5,   // fresh lava / ash
  FROZEN:       6,   // frozen ground after frost
  BURNT:        7    // after fire (will become vegetated again)
});

const CARVE_MATERIAL_COLORS = Object.freeze({
  [CARVE_MATERIAL_BAND.VEGETATED]:  [0.42, 0.62, 0.28],
  [CARVE_MATERIAL_BAND.BARE_SOIL]:  [0.55, 0.42, 0.28],
  [CARVE_MATERIAL_BAND.FRESH_ROCK]: [0.48, 0.44, 0.40],
  [CARVE_MATERIAL_BAND.WET_MUD]:    [0.32, 0.28, 0.22],
  [CARVE_MATERIAL_BAND.FRESH_SCREE]:[0.52, 0.48, 0.44],
  [CARVE_MATERIAL_BAND.VOLCANIC]:   [0.20, 0.16, 0.14],
  [CARVE_MATERIAL_BAND.FROZEN]:     [0.78, 0.82, 0.90],
  [CARVE_MATERIAL_BAND.BURNT]:      [0.14, 0.12, 0.10]
});

// ─── carve defaults (rate laws) ─────────────────────────────────
const CARVE_DEFAULTS = Object.freeze({
  // hydraulic: E_h = k_h · |∇h|^α · humidity · Q_flow
  hydraulicK:         0.02,
  hydraulicAlpha:     1.5,
  hydraulicMaxDelta:  2.0,        // metres per frame cap

  // aeolian: E_w = k_w · |wind|^β · (1 − vegetation) · sin(θ)
  aeolianK:           0.005,
  aeolianBeta:        1.8,
  aeolianMaxDelta:    0.3,

  // frost: E_f = k_f · (T_freeze − T)/ΔT · wetness
  frostK:             0.01,
  frostTFreeze:       273.15,      // K
  frostDeltaT:        20.0,        // K (below which frost stops)
  frostMaxDelta:      0.1,

  // thermal: E_t = k_t · max(0, tanθ − tanθ_repose)
  thermalK:           0.03,
  thermalReposeTan:   Math.tan(35 * Math.PI / 180),
  thermalMaxDelta:    1.5,

  // impact: E_i = F·cosθ / (ρ·A)
  impactRadius:       8.0,         // metres (default crater radius)
  impactDepthFactor:  0.3,         // crater depth = impactRadius · factor
  impactRimFactor:    0.15,        // rim height = impactRadius · factor
  impactMaxForce:     1.0e6,       // force cap

  // biotic: E_b = k_b · soilFertility · (1 − vegetation)  (slow churn)
  bioticK:            0.001,
  bioticMaxDelta:     0.05,

  // volcanic: E_v = k_v · lavaFlow · coolingRate
  volcanicK:          0.15,
  volcanicMaxDelta:   4.0,

  // recovery: τ_veg = seconds to re-vegetate a carved cell
  recoveryTau:        600.0,       // 10 minutes sim-time

  // mutation event coalescing
  mutationThreshold:  0.05,        // metres of cumulative delta to emit
  mutationCoalesceWindow: 2.0,     // seconds

  // memory budget
  maxDirtyChunksPerFrame: 32,
  maxCarveCellsPerChunk:  1024,    // 32×32 grid per chunk
  chunkSize:              1000     // metres (matches terrain)
});

class CarveGradientProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...CARVE_DEFAULTS, ...(options.defaults || {}) };
    this.enableRecovery = options.enableRecovery ?? true;
    this.enablePersistence = options.enablePersistence ?? true;

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpMatA = new Mat4();

    // ── chunk carve-delta storage ────────────────────────────
    // Each active chunk holds a Float32Array of per-cell deltas.
    const maxChunks = options.maxActiveChunks ?? 512;
    this._chunkCapacity = maxChunks;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(maxChunks);
    this._chunkCZ = new Int32Array(maxChunks);
    this._chunkState = new Uint8Array(maxChunks);
    this._chunkDeltas = new Array(maxChunks).fill(null);
    this._chunkBands = new Array(maxChunks).fill(null);
    this._chunkBandRecovery = new Array(maxChunks).fill(null);   // time since band set
    this._chunkMutation = new Array(maxChunks).fill(null);       // cumulative delta per cell
    this._chunkLastMutation = new Float64Array(maxChunks);
    this._chunkDirty = new Uint8Array(maxChunks);
    this._chunkDirtyCells = new Array(maxChunks).fill(null);
    this._chunkDirtyCount = new Uint32Array(maxChunks);

    // ── pooled arrays ──────────────────────────────────────
    this._deltaPool = [];
    this._deltaPoolIndex = 0;
    this._bandPool = [];
    this._bandPoolIndex = 0;
    this._recoveryPool = [];
    this._recoveryPoolIndex = 0;
    this._mutationPool = [];
    this._mutationPoolIndex = 0;

    // ── pending impact queue (for external triggers) ───────
    this._impactQueue = [];
    this._impactQueueCapacity = options.impactQueueCapacity ?? 64;

    // ── per-frame statistics ───────────────────────────────
    this._stats = {
      updates: 0,
      chunksTouched: 0,
      cellsCarved: 0,
      impactsQueued: 0,
      impactsApplied: 0,
      mutationEventsEmitted: 0,
      mutationEventsCoalesced: 0,
      recoveryCells: 0,
      persistenceWrites: 0,
      hydraulicEvents: 0,
      aeolianEvents: 0,
      frostEvents: 0,
      thermalEvents: 0,
      impactEvents: 0,
      bioticEvents: 0,
      volcanicEvents: 0
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── optional collaborator references ────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._relief = options.relief || null;
    this._cliffs = options.cliffs || null;
    this._temporal = options.temporal || null;
    this._physical = options.physical || null;
    this._dispatcher = options.dispatcher || null;

    // ── material-facing output arrays ──────────────────────
    this._carveBandWeights = new Float32Array(8);   // one per CARVE_MATERIAL_BAND
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachRelief(r) { this._relief = r; return this; }
  attachCliffs(c) { this._cliffs = c; return this; }
  attachTemporal(t) { this._temporal = t; return this; }
  attachPhysical(p) { this._physical = p; return this; }
  attachDispatcher(d) { this._dispatcher = d; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── height lookup (base + delta) ───────────────────────
  // ══════════════════════════════════════════════════════════
  // Base height comes from the terrain stack; delta comes from the
  // carve buffers; final height = base + delta.
  _getBaseHeight(wx, wz, lod = 0) {
    if (this._elevation) return this._elevation.getElevation(wx, wz, lod);
    if (this._terrain) return this._terrain.getHeight(wx, wz, lod);
    const tc = this._frameRef?.layers?.spatial?.terrainChunks;
    if (!tc || tc.count === 0) return 0;
    return this._interpolateBaseFromChunks(tc, wx, wz);
  }

  _interpolateBaseFromChunks(tc, wx, wz) {
    const chunkSize = this.defaults.chunkSize;
    const cx = Math.floor(wx / chunkSize);
    const cz = Math.floor(wz / chunkSize);
    let wSum = 0, hSum = 0;
    for (let i = 0; i < tc.count; i++) {
      const dcx = tc.cx[i] - cx;
      const dcz = tc.cz[i] - cz;
      const d2 = dcx * dcx + dcz * dcz + 1e-6;
      if (d2 > 4) continue;
      const w = 1.0 / d2;
      const avg = (tc.minY[i] + tc.maxY[i]) * 0.5;
      hSum += avg * w;
      wSum += w;
    }
    return wSum > 0 ? hSum / wSum : 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── carve delta accessors ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _getChunkSlot(cx, cz) {
    const key = cx + ',' + cz;
    if (this._chunkKeys.has(key)) return this._chunkKeys.get(key);
    return -1;
  }

  _allocChunkSlot(cx, cz) {
    if (this._chunkUsed >= this._chunkCapacity) {
      this._evictOldest();
    }
    let slot = -1;
    for (let i = 0; i < this._chunkCapacity; i++) {
      if (this._chunkState[i] === 0) { slot = i; break; }
    }
    if (slot < 0) {
      slot = this._chunkSlot;
      this._chunkSlot = (this._chunkSlot + 1) % this._chunkCapacity;
      this._evictSlot(slot);
    }

    const cells = this.defaults.maxCarveCellsPerChunk;
    this._chunkCX[slot] = cx;
    this._chunkCZ[slot] = cz;
    this._chunkState[slot] = 1;
    this._chunkDeltas[slot] = this._acquireDeltaArray(cells);
    this._chunkBands[slot] = this._acquireBandArray(cells);
    this._chunkBandRecovery[slot] = this._acquireRecoveryArray(cells);
    this._chunkMutation[slot] = this._acquireMutationArray(cells);
    this._chunkDirtyCells[slot] = new Int32Array(cells);
    this._chunkDirtyCount[slot] = 0;
    this._chunkLastMutation[slot] = 0;
    this._chunkDirty[slot] = 0;

    this._chunkKeys.set(cx + ',' + cz, slot);
    this._chunkUsed++;
    return slot;
  }

  _evictSlot(slot) {
    if (this._chunkState[slot] === 0) return;
    const key = this._chunkCX[slot] + ',' + this._chunkCZ[slot];
    this._chunkKeys.delete(key);
    this._chunkState[slot] = 0;
    this._chunkDeltas[slot] = null;
    this._chunkBands[slot] = null;
    this._chunkBandRecovery[slot] = null;
    this._chunkMutation[slot] = null;
    this._chunkDirtyCells[slot] = null;
    this._chunkDirtyCount[slot] = 0;
    this._chunkUsed--;
  }

  _evictOldest() {
    let oldest = -1;
    let oldestTime = Infinity;
    for (let i = 0; i < this._chunkCapacity; i++) {
      if (this._chunkState[i] === 0) continue;
      if (this._chunkLastMutation[i] < oldestTime) {
        oldestTime = this._chunkLastMutation[i];
        oldest = i;
      }
    }
    if (oldest >= 0) this._evictSlot(oldest);
  }

  _acquireDeltaArray(size) {
    const idx = this._deltaPoolIndex;
    if (idx < this._deltaPool.length) {
      const arr = this._deltaPool[idx];
      this._deltaPoolIndex++;
      if (arr.length === size) {
        arr.fill(0);
        return arr;
      }
    }
    const arr = new Float32Array(size);
    this._deltaPool.push(arr);
    this._deltaPoolIndex++;
    return arr;
  }

  _acquireBandArray(size) {
    const idx = this._bandPoolIndex;
    if (idx < this._bandPool.length) {
      const arr = this._bandPool[idx];
      this._bandPoolIndex++;
      if (arr.length === size) {
        arr.fill(CARVE_MATERIAL_BAND.VEGETATED);
        return arr;
      }
    }
    const arr = new Uint8Array(size);
    arr.fill(CARVE_MATERIAL_BAND.VEGETATED);
    this._bandPool.push(arr);
    this._bandPoolIndex++;
    return arr;
  }

  _acquireRecoveryArray(size) {
    const idx = this._recoveryPoolIndex;
    if (idx < this._recoveryPool.length) {
      const arr = this._recoveryPool[idx];
      this._recoveryPoolIndex++;
      if (arr.length === size) {
        arr.fill(0);
        return arr;
      }
    }
    const arr = new Float32Array(size);
    this._recoveryPool.push(arr);
    this._recoveryPoolIndex++;
    return arr;
  }

  _acquireMutationArray(size) {
    const idx = this._mutationPoolIndex;
    if (idx < this._mutationPool.length) {
      const arr = this._mutationPool[idx];
      this._mutationPoolIndex++;
      if (arr.length === size) {
        arr.fill(0);
        return arr;
      }
    }
    const arr = new Float32Array(size);
    this._mutationPool.push(arr);
    this._mutationPoolIndex++;
    return arr;
  }

  _releaseAllPools() {
    this._deltaPoolIndex = 0;
    this._bandPoolIndex = 0;
    this._recoveryPoolIndex = 0;
    this._mutationPoolIndex = 0;
  }

  _cellIndex(wx, wz, cx, cz) {
    const size = Math.sqrt(this.defaults.maxCarveCellsPerChunk);
    const lx = (wx - cx * this.defaults.chunkSize) / this.defaults.chunkSize;
    const lz = (wz - cz * this.defaults.chunkSize) / this.defaults.chunkSize;
    const i = Math.max(0, Math.min(size - 1, Math.floor(lx * size)));
    const j = Math.max(0, Math.min(size - 1, Math.floor(lz * size)));
    return j * size + i;
  }

  // ── public: query cumulative delta at a world position ──
  getCarveDelta(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0) return 0;
    const deltas = this._chunkDeltas[slot];
    if (!deltas) return 0;
    return deltas[this._cellIndex(wx, wz, cx, cz)];
  }

  // ── public: query full carved height (base + delta) ─────
  getCarvedHeight(wx, wz, lod = 0) {
    return this._getBaseHeight(wx, wz, lod) + this.getCarveDelta(wx, wz);
  }

  // ── public: get material band at a world position ───────
  getCarveMaterialBand(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0) return CARVE_MATERIAL_BAND.VEGETATED;
    const bands = this._chunkBands[slot];
    if (!bands) return CARVE_MATERIAL_BAND.VEGETATED;
    return bands[this._cellIndex(wx, wz, cx, cz)];
  }

  // ══════════════════════════════════════════════════════════
  // ─── public API: external carve operations ──────────────
  // ══════════════════════════════════════════════════════════
  // Stamp a carve delta at a world position with a given radius
  // (falls off smoothly toward the edge).
  carveDelta(wx, wz, amount, radius = 1.0, source = CARVE_SOURCE.IMPACT) {
    this._applyCarveStamp(wx, wz, amount, radius, source);
    return this;
  }

  // Set the material band for cells within a radius.
  carveMaterialBand(wx, wz, band, radius = 1.0) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    const chunkSize = this.defaults.chunkSize;
    const bands = this._chunkBands[slot];
    const recovery = this._chunkBandRecovery[slot];
    const size = Math.sqrt(this.defaults.maxCarveCellsPerChunk);
    const cellSize = chunkSize / size;

    const minX = wx - radius;
    const maxX = wx + radius;
    const minZ = wz - radius;
    const maxZ = wz + radius;

    const i0 = Math.max(0, Math.floor((minX - cx * chunkSize) / cellSize));
    const i1 = Math.min(size - 1, Math.floor((maxX - cx * chunkSize) / cellSize));
    const j0 = Math.max(0, Math.floor((minZ - cz * chunkSize) / cellSize));
    const j1 = Math.min(size - 1, Math.floor((maxZ - cz * chunkSize) / cellSize));

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * size + i;
        const wxCell = cx * chunkSize + (i + 0.5) * cellSize;
        const wzCell = cz * chunkSize + (j + 0.5) * cellSize;
        const dx = wxCell - wx;
        const dz = wzCell - wz;
        const d2 = dx * dx + dz * dz;
        if (d2 <= radius * radius) {
          bands[idx] = band;
          recovery[idx] = 0;
        }
      }
    }
    this._chunkLastMutation[slot] = performance.now() / 1000;
    this._chunkDirty[slot] = 1;
    return this;
  }

  // Queue an impact for the next update (used by causal events).
  queueImpact(wx, wz, force, radius = -1, source = CARVE_SOURCE.IMPACT) {
    if (this._impactQueue.length >= this._impactQueueCapacity) {
      this._impactQueue.shift();
    }
    this._impactQueue.push({ wx, wz, force, radius, source });
    this._stats.impactsQueued++;
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── carve stamp (single cell + falloff region) ─────────
  // ══════════════════════════════════════════════════════════
  _applyCarveStamp(wx, wz, amount, radius, source) {
    if (Math.abs(amount) < 1e-5) return;

    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    const chunkSize = this.defaults.chunkSize;
    const deltas = this._chunkDeltas[slot];
    const bands = this._chunkBands[slot];
    const recovery = this._chunkBandRecovery[slot];
    const mutations = this._chunkMutation[slot];
    const size = Math.sqrt(this.defaults.maxCarveCellsPerChunk);
    const cellSize = chunkSize / size;

    const minX = wx - radius;
    const maxX = wx + radius;
    const minZ = wz - radius;
    const maxZ = wz + radius;

    const i0 = Math.max(0, Math.floor((minX - cx * chunkSize) / cellSize));
    const i1 = Math.min(size - 1, Math.floor((maxX - cx * chunkSize) / cellSize));
    const j0 = Math.max(0, Math.floor((minZ - cz * chunkSize) / cellSize));
    const j1 = Math.min(size - 1, Math.floor((maxZ - cz * chunkSize) / cellSize));

    const now = performance.now() / 1000;
    let cellsChanged = 0;

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * size + i;
        const wxCell = cx * chunkSize + (i + 0.5) * cellSize;
        const wzCell = cz * chunkSize + (j + 0.5) * cellSize;
        const dx = wxCell - wx;
        const dz = wzCell - wz;
        const d2 = dx * dx + dz * dz;
        if (d2 > radius * radius) continue;

        // Smooth falloff: amount · (1 − d²/r²)²
        const t = 1 - d2 / (radius * radius);
        const falloff = t * t;
        const delta = amount * falloff;

        deltas[idx] += delta;
        mutations[idx] += Math.abs(delta);
        cellsChanged++;

        // Update material band based on source.
        if (source === CARVE_SOURCE.HYDRAULIC) {
          bands[idx] = CARVE_MATERIAL_BAND.WET_MUD;
          recovery[idx] = 0;
        } else if (source === CARVE_SOURCE.VOLCANIC) {
          bands[idx] = CARVE_MATERIAL_BAND.VOLCANIC;
          recovery[idx] = 0;
        } else if (source === CARVE_SOURCE.FROST) {
          bands[idx] = CARVE_MATERIAL_BAND.FROZEN;
          recovery[idx] = 0;
        } else if (source === CARVE_SOURCE.IMPACT) {
          // Crater: fresh rock / bare soil at the centre, scree at edges.
          bands[idx] = falloff > 0.5
            ? CARVE_MATERIAL_BAND.FRESH_ROCK
            : CARVE_MATERIAL_BAND.FRESH_SCREE;
          recovery[idx] = 0;
        } else if (source === CARVE_SOURCE.THERMAL) {
          bands[idx] = CARVE_MATERIAL_BAND.FRESH_SCREE;
          recovery[idx] = 0;
        } else if (source === CARVE_SOURCE.AEOLIAN) {
          bands[idx] = CARVE_MATERIAL_BAND.BARE_SOIL;
          recovery[idx] = 0;
        } else if (source === CARVE_SOURCE.BIOTIC) {
          bands[idx] = CARVE_MATERIAL_BAND.BARE_SOIL;
          recovery[idx] = 0;
        }

        // Mark as dirty for mutation-event coalescing.
        if (this._chunkDirtyCount[slot] < this._chunkDirtyCells[slot].length) {
          this._chunkDirtyCells[slot][this._chunkDirtyCount[slot]++] = idx;
        }
      }
    }

    if (cellsChanged > 0) {
      this._chunkLastMutation[slot] = now;
      this._chunkDirty[slot] = 1;
      this._stats.cellsCarved += cellsChanged;
    }
    return cellsChanged;
  }

  // ══════════════════════════════════════════════════════════
  // ─── erosion rate laws (physics) ────────────────────────
  // ══════════════════════════════════════════════════════════
  // Hydraulic: E_h = k_h · |∇h|^α · humidity · Q_flow
  computeHydraulicErosion(dt, gradient, humidity, flow) {
    const d = this.defaults;
    const mag = Math.sqrt(gradient.x * gradient.x + gradient.z * gradient.z);
    const rate = d.hydraulicK * Math.pow(mag, d.hydraulicAlpha) * humidity * flow;
    return Math.min(d.hydraulicMaxDelta, rate * dt);
  }

  // Aeolian: E_w = k_w · |wind|^β · (1 − vegetation) · sin(θ)
  computeAeolianErosion(dt, windSpeed, vegetation, slopeAngle) {
    const d = this.defaults;
    const rate = d.aeolianK *
      Math.pow(windSpeed, d.aeolianBeta) *
      (1 - vegetation) *
      Math.sin(slopeAngle);
    return Math.min(d.aeolianMaxDelta, rate * dt);
  }

  // Frost: E_f = k_f · (T_freeze − T)/ΔT · wetness
  computeFrostErosion(dt, temperatureK, wetness) {
    const d = this.defaults;
    const below = Math.max(0, d.frostTFreeze - temperatureK);
    const rate = d.frostK * (below / d.frostDeltaT) * wetness;
    return Math.min(d.frostMaxDelta, rate * dt);
  }

  // Thermal: E_t = k_t · max(0, tanθ − tanθ_repose)
  computeThermalErosion(dt, slopeAngle) {
    const d = this.defaults;
    const tan = Math.tan(slopeAngle);
    const excess = Math.max(0, tan - d.thermalReposeTan);
    const rate = d.thermalK * excess;
    return Math.min(d.thermalMaxDelta, rate * dt);
  }

  // Impact crater: E_i = F·cosθ / (ρ·A)
  computeImpactCarve(force, radius) {
    const d = this.defaults;
    const f = Math.min(force, d.impactMaxForce);
    const depth = radius * d.impactDepthFactor * Math.min(1, f / 50000);
    const rim = radius * d.impactRimFactor * Math.min(1, f / 50000);
    return { depth, rim, radius };
  }

  // Biotic: E_b = k_b · fertility · (1 − vegetation)
  computeBioticErosion(dt, fertility, vegetation) {
    const d = this.defaults;
    const rate = d.bioticK * fertility * (1 - vegetation);
    return Math.min(d.bioticMaxDelta, rate * dt);
  }

  // Volcanic: E_v = k_v · lavaFlow · coolingRate
  computeVolcanicCarve(dt, lavaFlow, coolingRate) {
    const d = this.defaults;
    const rate = d.volcanicK * lavaFlow * coolingRate;
    return Math.min(d.volcanicMaxDelta, rate * dt);
  }

  // ══════════════════════════════════════════════════════════
  // ─── per-frame erosion pass ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _applyErosionPass(frame, dt, now) {
    const physical = frame.layers.physical;
    if (!physical) return;

    const humidity = physical.humidity ?? 0.5;
    const temperatureK = (physical.ambientTemperature ?? 20) + 273.15;
    const wetness = physical.materialWetness?.[0] ?? physical.wetness ?? 0;
    const windSpeed = physical.windSpeed ?? 0;
    const windX = physical.wind?.[0] ?? 0;
    const windZ = physical.wind?.[2] ?? 0;

    const spatial = frame.layers.spatial;
    if (!spatial || !spatial.terrainChunks) return;

    const tc = spatial.terrainChunks;
    const count = Math.min(tc.count, this.defaults.maxDirtyChunksPerFrame);
    const chunkSize = this.defaults.chunkSize;

    // Sample a small grid per chunk and apply erosion at each cell.
    for (let ci = 0; ci < count; ci++) {
      const cx = tc.cx[ci];
      const cz = tc.cz[ci];

      const gridN = 4;
      const step = chunkSize / gridN;

      for (let gj = 0; gj < gridN; gj++) {
        for (let gi = 0; gi < gridN; gi++) {
          const wx = cx * chunkSize + (gi + 0.5) * step;
          const wz = cz * chunkSize + (gj + 0.5) * step;

          // Query the base height and gradient.
          const hL = this._getBaseHeight(wx - step * 0.1, wz);
          const hR = this._getBaseHeight(wx + step * 0.1, wz);
          const hD = this._getBaseHeight(wx, wz - step * 0.1);
          const hU = this._getBaseHeight(wx, wz + step * 0.1);
          const dhdx = (hR - hL) / (step * 0.2);
          const dhdz = (hU - hD) / (step * 0.2);
          const gradMag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
          const slopeAngle = Math.atan(gradMag);

          // Compute per-source erosion rates.
          const slope = this._slope;
          const flow = slope
            ? slope.getWaterFlowBias(wx, wz, tc.flowHint?.[ci] ?? 1.0)
            : gradMag;
          const vegetation = this._estimateVegetation(wx, wz, tc.biomeHint?.[ci]);
          const fertility = physical.soilStability ?? 1.0;

          const eHydraulic = this.computeHydraulicErosion(dt, { x: dhdx, z: dhdz }, humidity, flow);
          const eAeolian = this.computeAeolianErosion(dt, windSpeed, vegetation, slopeAngle);
          const eFrost = this.computeFrostErosion(dt, temperatureK, wetness);
          const eThermal = this.computeThermalErosion(dt, slopeAngle);
          const eBiotic = this.computeBioticErosion(dt, fertility, vegetation);

          // Combine erosion (they are all positive, meaning removal).
          const erosion = eHydraulic + eAeolian + eFrost + eThermal + eBiotic;
          if (erosion > 1e-5) {
            this._applyCarveStamp(
              wx, wz, -erosion, step * 0.5,
              eHydraulic > eAeolian ? CARVE_SOURCE.HYDRAULIC : CARVE_SOURCE.AEOLIAN
            );
            if (eHydraulic > 1e-4) this._stats.hydraulicEvents++;
            if (eAeolian > 1e-4) this._stats.aeolianEvents++;
            if (eFrost > 1e-4) this._stats.frostEvents++;
            if (eThermal > 1e-4) this._stats.thermalEvents++;
            if (eBiotic > 1e-4) this._stats.bioticEvents++;
          }
        }
      }
    }
  }

  _estimateVegetation(wx, wz, biomeHint) {
    // Approximate vegetation cover from biome hint.
    // Consumed by the erosion rate laws.
    switch (biomeHint) {
      case BIOME_HINT.TROPICAL:   return 0.9;
      case BIOME_HINT.TEMPERATE:  return 0.7;
      case BIOME_HINT.TAIGA:      return 0.6;
      case BIOME_HINT.GRASSLAND:  return 0.5;
      case BIOME_HINT.DESERT:     return 0.1;
      case BIOME_HINT.TUNDRA:     return 0.2;
      case BIOME_HINT.FRESHWATER: return 0.4;
      case BIOME_HINT.MARINE:     return 0.0;
      case BIOME_HINT.ALPINE:     return 0.1;
      default:                     return 0.3;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── impact queue processing ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _processImpactQueue(dt) {
    while (this._impactQueue.length > 0) {
      const imp = this._impactQueue.shift();
      const radius = imp.radius > 0 ? imp.radius : this.defaults.impactRadius;
      const carve = this.computeImpactCarve(imp.force, radius);

      // Apply a cone-shaped crater (negative delta at centre, positive rim).
      this._applyImpactCrater(imp.wx, imp.wz, carve.depth, carve.rim, radius, imp.source);
      this._stats.impactsApplied++;
      this._stats.impactEvents++;

      // Emit causal event.
      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.MUTATION,
          [imp.wx, 0, imp.wz],
          -1, imp.force, 1.0,
          { kind: 'terrain_carve', source: imp.source, depth: carve.depth, radius }
        );
        this._stats.mutationEventsEmitted++;
      }
    }
  }

  _applyImpactCrater(wx, wz, depth, rim, radius, source) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    const chunkSize = this.defaults.chunkSize;
    const deltas = this._chunkDeltas[slot];
    const bands = this._chunkBands[slot];
    const recovery = this._chunkBandRecovery[slot];
    const mutations = this._chunkMutation[slot];
    const size = Math.sqrt(this.defaults.maxCarveCellsPerChunk);
    const cellSize = chunkSize / size;

    const minX = wx - radius * 1.2;
    const maxX = wx + radius * 1.2;
    const minZ = wz - radius * 1.2;
    const maxZ = wz + radius * 1.2;

    const i0 = Math.max(0, Math.floor((minX - cx * chunkSize) / cellSize));
    const i1 = Math.min(size - 1, Math.floor((maxX - cx * chunkSize) / cellSize));
    const j0 = Math.max(0, Math.floor((minZ - cz * chunkSize) / cellSize));
    const j1 = Math.min(size - 1, Math.floor((maxZ - cz * chunkSize) / cellSize));

    const now = performance.now() / 1000;

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * size + i;
        const wxCell = cx * chunkSize + (i + 0.5) * cellSize;
        const wzCell = cz * chunkSize + (j + 0.5) * cellSize;
        const dx = wxCell - wx;
        const dz = wzCell - wz;
        const d = Math.sqrt(dx * dx + dz * dz) / radius;
        if (d > 1.2) continue;

        // Crater shape: -depth in the bowl (d < 1), +rim at 1..1.2.
        let delta;
        if (d < 1) {
          // Cosine bowl.
          delta = -depth * (0.5 + 0.5 * Math.cos(d * Math.PI));
        } else {
          // Raised rim.
          delta = rim * (0.5 + 0.5 * Math.cos((d - 1) / 0.2 * Math.PI + Math.PI));
        }

        deltas[idx] += delta;
        mutations[idx] += Math.abs(delta);

        if (d < 0.8) {
          bands[idx] = CARVE_MATERIAL_BAND.FRESH_ROCK;
        } else if (d < 1.0) {
          bands[idx] = CARVE_MATERIAL_BAND.FRESH_SCREE;
        } else {
          bands[idx] = CARVE_MATERIAL_BAND.BARE_SOIL;
        }
        recovery[idx] = 0;

        // Mark dirty cell.
        if (this._chunkDirtyCount[slot] < this._chunkDirtyCells[slot].length) {
          this._chunkDirtyCells[slot][this._chunkDirtyCount[slot]++] = idx;
        }
      }
    }

    this._chunkLastMutation[slot] = now;
    this._chunkDirty[slot] = 1;
    this._stats.cellsCarved += (i1 - i0 + 1) * (j1 - j0 + 1);
  }

  // ══════════════════════════════════════════════════════════
  // ─── material band recovery (re-vegetation) ─────────────
  // ══════════════════════════════════════════════════════════
  _applyRecovery(dt) {
    if (!this.enableRecovery) return;
    const tau = this.defaults.recoveryTau;

    for (let slot = 0; slot < this._chunkCapacity; slot++) {
      if (this._chunkState[slot] === 0) continue;
      const bands = this._chunkBands[slot];
      const recovery = this._chunkBandRecovery[slot];
      if (!bands || !recovery) continue;

      const cells = this.defaults.maxCarveCellsPerChunk;
      for (let i = 0; i < cells; i++) {
        if (bands[i] === CARVE_MATERIAL_BAND.VEGETATED) continue;
        recovery[i] += dt;
        if (recovery[i] >= tau) {
          bands[i] = CARVE_MATERIAL_BAND.VEGETATED;
          recovery[i] = 0;
          this._stats.recoveryCells++;
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── mutation event coalescing ──────────────────────────
  // ══════════════════════════════════════════════════════════
  // Emit MUTATION causal events for cells whose cumulative mutation
  // exceeds the threshold, then reset that cell's mutation counter.
  _emitMutationEvents(now) {
    if (!this._dispatcher) return;

    const threshold = this.defaults.mutationThreshold;
    const window = this.defaults.mutationCoalesceWindow;

    for (let slot = 0; slot < this._chunkCapacity; slot++) {
      if (this._chunkState[slot] === 0) continue;
      if (this._chunkDirty[slot] === 0) continue;
      if (now - this._chunkLastMutation[slot] < window) continue;

      const mutations = this._chunkMutation[slot];
      const deltas = this._chunkDeltas[slot];
      if (!mutations || !deltas) continue;

      const cells = this.defaults.maxCarveCellsPerChunk;
      const size = Math.sqrt(cells);
      const chunkSize = this.defaults.chunkSize;
      const cellSize = chunkSize / size;
      const cx = this._chunkCX[slot];
      const cz = this._chunkCZ[slot];

      let emitted = 0;
      for (let i = 0; i < cells; i++) {
        if (mutations[i] < threshold) continue;

        // Cell position.
        const cellI = i % size;
        const cellJ = (i / size) | 0;
        const wx = cx * chunkSize + (cellI + 0.5) * cellSize;
        const wz = cz * chunkSize + (cellJ + 0.5) * cellSize;
        const delta = deltas[i];

        // Emit coalesced mutation event.
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.MUTATION,
          [wx, 0, wz],
          -1, mutations[i], 1.0,
          { kind: 'terrain_mutation', delta, cellIndex: i, chunkX: cx, chunkZ: cz }
        );
        emitted++;
        mutations[i] = 0;   // reset for next coalesce window
      }

      if (emitted > 0) {
        this._stats.mutationEventsEmitted += emitted;
        this._chunkDirty[slot] = 0;
        this._chunkDirtyCount[slot] = 0;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── persistence handoff ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writePersistence(frame) {
    if (!this.enablePersistence) return;
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    // Provide a compact list of all chunks with non-zero deltas
    // for the persistence system to store.
    if (!spatial.carvePersistence) {
      spatial.carvePersistence = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCapacity),
        chunkCZ: new Int32Array(this._chunkCapacity),
        deltas: new Array(this._chunkCapacity).fill(null),
        bands: new Array(this._chunkCapacity).fill(null)
      };
    }
    const cp = spatial.carvePersistence;
    cp.chunkCount = 0;

    for (let slot = 0; slot < this._chunkCapacity; slot++) {
      if (this._chunkState[slot] === 0) continue;
      const deltas = this._chunkDeltas[slot];
      if (!deltas) continue;

      // Check for any non-zero delta.
      let hasDelta = false;
      const cells = this.defaults.maxCarveCellsPerChunk;
      for (let i = 0; i < cells; i++) {
        if (Math.abs(deltas[i]) > 1e-4) { hasDelta = true; break; }
      }
      if (!hasDelta) continue;

      if (cp.chunkCount < this._chunkCapacity) {
        cp.chunkCX[cp.chunkCount] = this._chunkCX[slot];
        cp.chunkCZ[cp.chunkCount] = this._chunkCZ[slot];
        cp.deltas[cp.chunkCount] = deltas;
        cp.bands[cp.chunkCount] = this._chunkBands[slot];
        cp.chunkCount++;
        this._stats.persistenceWrites++;
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── material-facing aggregate weights ─────────────────
  // ══════════════════════════════════════════════════════════
  _updateMaterialAggregates(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    this._carveBandWeights.fill(0);
    let totalCells = 0;

    for (let slot = 0; slot < this._chunkCapacity; slot++) {
      if (this._chunkState[slot] === 0) continue;
      const bands = this._chunkBands[slot];
      if (!bands) continue;
      const cells = this.defaults.maxCarveCellsPerChunk;
      for (let i = 0; i < cells; i++) {
        this._carveBandWeights[bands[i]]++;
        totalCells++;
      }
    }

    if (totalCells > 0) {
      for (let b = 0; b < 8; b++) {
        this._carveBandWeights[b] /= totalCells;
      }
    }

    physical.carveBandWeights = this._carveBandWeights;
    // Expose the aggregate "freshness" for materials to react.
    physical.carveFreshness =
      this._carveBandWeights[CARVE_MATERIAL_BAND.BARE_SOIL] +
      this._carveBandWeights[CARVE_MATERIAL_BAND.FRESH_ROCK] +
      this._carveBandWeights[CARVE_MATERIAL_BAND.FRESH_SCREE] +
      this._carveBandWeights[CARVE_MATERIAL_BAND.WET_MUD];
  }

  // ══════════════════════════════════════════════════════════
  // ─── main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) return 0;
    const dt = Math.min(0.1, now - (this._lastUpdateTime > 0 ? this._lastUpdateTime : now - 1 / 60));
    this._lastUpdateTime = now;
    this._frameRef = frame;

    // 1. Process impact queue (craters, external carve requests).
    this._processImpactQueue(dt);

    // 2. Run the per-frame erosion pass.
    this._applyErosionPass(frame, dt, now);

    // 3. Recovery (re-vegetation over time).
    this._applyRecovery(dt);

    // 4. Coalesce and emit mutation events.
    this._emitMutationEvents(now);

    // 5. Persistence handoff.
    this._writePersistence(frame);

    // 6. Material/lighting aggregates.
    this._updateMaterialAggregates(frame);

    // 7. Write spatial-layer sub-slice for direct consumers.
    this._writeToSpatialLayer(frame);

    this._releaseAllPools();
    this._stats.updates++;
    return 1;
  }

  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.carve) {
      spatial.carve = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCapacity),
        chunkCZ: new Int32Array(this._chunkCapacity),
        deltas: new Array(this._chunkCapacity).fill(null),
        bands: new Array(this._chunkCapacity).fill(null),
        bandColors: CARVE_MATERIAL_COLORS
      };
    }
    const c = spatial.carve;
    c.chunkCount = 0;

    for (let slot = 0; slot < this._chunkCapacity; slot++) {
      if (this._chunkState[slot] === 0) continue;
      if (c.chunkCount >= this._chunkCapacity) break;
      c.chunkCX[c.chunkCount] = this._chunkCX[slot];
      c.chunkCZ[c.chunkCount] = this._chunkCZ[slot];
      c.deltas[c.chunkCount] = this._chunkDeltas[slot];
      c.bands[c.chunkCount] = this._chunkBands[slot];
      c.chunkCount++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── interactive setters ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setDefaults(params) {
    for (const k of Object.keys(this.defaults)) {
      if (params[k] !== undefined) this.defaults[k] = params[k];
    }
    return this;
  }

  setRecoveryTau(tau) {
    if (tau > 0) this.defaults.recoveryTau = tau;
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  dispose() {
    this._terrain = null;
    this._elevation = null;
    this._slope = null;
    this._relief = null;
    this._cliffs = null;
    this._temporal = null;
    this._physical = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._chunkKeys.clear();
    this._chunkUsed = 0;
    for (let i = 0; i < this._chunkCapacity; i++) {
      this._chunkState[i] = 0;
      this._chunkDeltas[i] = null;
      this._chunkBands[i] = null;
      this._chunkBandRecovery[i] = null;
      this._chunkMutation[i] = null;
      this._chunkDirtyCells[i] = null;
      this._chunkDirtyCount[i] = 0;
    }
    this._deltaPool.length = 0;
    this._bandPool.length = 0;
    this._recoveryPool.length = 0;
    this._mutationPool.length = 0;
    this._impactQueue.length = 0;
    this._carveBandWeights.fill(0);
  }
}

export {
  CarveGradientProvider,
  CARVE_SOURCE,
  CARVE_SOURCE_NAMES,
  CARVE_MATERIAL_BAND,
  CARVE_MATERIAL_COLORS,
  CARVE_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};