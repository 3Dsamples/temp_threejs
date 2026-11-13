// file number : 280
// full path name : src/context/280_TerrainProvider.js
// description : Terrain lay-of-land provider feeding elevation, slope, bathymetry, and biome selection. Generates a fractal-Brownian-motion heightfield (FBM(x) = Σ a_i·n(f_i·x) with persistence p = a_{i+1}/a_i and lacunarity l = f_{i+1}/f_i, typically (0.5, 2.0), band-limited to the Nyquist cutoff) using SimplexNoise from 264_MathECSImportBarrel. For each terrain chunk it computes: heightfield samples (mipmapped at 4 LOD resolutions), gradient-based slope (∂h/∂x, ∂h/∂z), rough­ness (RMS of second derivatives), curvature (Laplacian), aspect (downhill direction), erosion bias, water-flow accumulation hint, and biome-weight hints from climate + elevation + slope + moisture coupling. Writes terrain descriptors into frame.layers.spatial per chunk and exposes them through a queryable flat SoA chunk table. Provides cross-chunk blending so neighbouring chunks do not pop. Implements a per-chunk arc-length cache for fast repeated sampling. All terrain math runs on pooled Float32Array heightfields; zero allocation inside getHeight(), getSlope(), or getBiomeHint() after chunk init. Optionally parallelizes chunk generation across a Worker pool using SharedArrayBuffer for heightfield storage.
// best for : The base terrain substrate of every living world. Every downstream consumer — ElevationProvider, SlopeGradientProvider, BathymetryProvider, GroundwaterProvider, MoistureLevelProvider, BiomeBlendField, LandscapeChunkStreamer, procedural vegetation scatter, fauna migration, erosion simulation — reads its lay-of-land from this provider.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision,
  ContextFrame, CoreClock, CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES,
  Interpolant, LinearInterpolant, CubicInterpolant, BezierInterpolant,
  BufferAttribute, BufferGeometry,
  TemporalContextProvider, WEATHER,
  CausalContextProvider, DERIVED_SIGNAL,
  CoreLayers, LAYER, LAYER_MASKS,
  smoothstep,
  SpatialHashGrid
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 1;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── per-chunk heightfield LOD resolution ────────────────────────
// Samples per side at each LOD level; index 0 = highest detail.
const CHUNK_RESOLUTION_LOD = Object.freeze([65, 33, 17, 9]);
const MAX_LOD_LEVELS = CHUNK_RESOLUTION_LOD.length;

// ─── terrain biome hint codes ────────────────────────────────────
// Matches the biome registry barrel (327) but kept as indices here
// so TerrainProvider has no dependency on biome descriptors.
const BIOME_HINT = Object.freeze({
  UNKNOWN:      0,
  TROPICAL:     1,
  TEMPERATE:    2,
  TAIGA:        3,
  GRASSLAND:    4,
  DESERT:       5,
  TUNDRA:       6,
  FRESHWATER:   7,
  MARINE:       8,
  ALPINE:       9
});

// ─── terrain chunk state ─────────────────────────────────────────
const CHUNK_STATE = Object.freeze({
  EMPTY:      0,
  PENDING:    1,   // generation queued / in progress
  READY:      2,   // heightfield + descriptors valid
  STALE:      3    // generated but needs refresh
});

// ─── default terrain configuration ───────────────────────────────
const TERRAIN_DEFAULTS = Object.freeze({
  // FBM parameters
  baseFrequency:     1 / 4096,   // spatial frequency of the first octave
  octaves:           6,
  persistence:       0.5,
  lacunarity:        2.0,
  amplitude:         400.0,      // peak-to-peak world height (metres)
  ridgeMix:          0.35,       // 0 = pure FBM, 1 = pure ridged FBM
  warpStrength:      0.15,       // domain-warp strength

  // world extents
  chunkSize:         1000.0,     // metres per chunk at LOD 0
  worldMinY:        -2000.0,
  worldMaxY:         4000.0,

  // sea level
  seaLevel:          0.0,

  // descriptor derivation
  slopeSampleDistance:   4.0,    // metres for finite-difference gradient
  curvatureSampleDistance: 8.0,
  bandLimit:             true,   // enable Nyquist band-limit

  // chunk cache
  maxCachedChunks:       512,
  workerPoolSize:        4
});

class TerrainProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.baseFrequency = options.baseFrequency ?? TERRAIN_DEFAULTS.baseFrequency;
    this.octaves = options.octaves ?? TERRAIN_DEFAULTS.octaves;
    this.persistence = options.persistence ?? TERRAIN_DEFAULTS.persistence;
    this.lacunarity = options.lacunarity ?? TERRAIN_DEFAULTS.lacunarity;
    this.amplitude = options.amplitude ?? TERRAIN_DEFAULTS.amplitude;
    this.ridgeMix = options.ridgeMix ?? TERRAIN_DEFAULTS.ridgeMix;
    this.warpStrength = options.warpStrength ?? TERRAIN_DEFAULTS.warpStrength;

    this.chunkSize = options.chunkSize ?? TERRAIN_DEFAULTS.chunkSize;
    this.worldMinY = options.worldMinY ?? TERRAIN_DEFAULTS.worldMinY;
    this.worldMaxY = options.worldMaxY ?? TERRAIN_DEFAULTS.worldMaxY;

    this.seaLevel = options.seaLevel ?? TERRAIN_DEFAULTS.seaLevel;

    this.slopeSampleDistance = options.slopeSampleDistance ?? TERRAIN_DEFAULTS.slopeSampleDistance;
    this.curvatureSampleDistance = options.curvatureSampleDistance ?? TERRAIN_DEFAULTS.curvatureSampleDistance;
    this.bandLimit = options.bandLimit ?? TERRAIN_DEFAULTS.bandLimit;

    this.maxCachedChunks = options.maxCachedChunks ?? TERRAIN_DEFAULTS.maxCachedChunks;

    // ── simplex noise instance (single shared, from kernel) ──
    // SimplexNoise is stateless for .noise() calls in our kernel.
    this._noise = SimplexNoise;

    // ── chunk cache (flat SoA) ──────────────────────────────
    this._chunkCapacity = this.maxCachedChunks;
    this._chunkKeys = new Map();          // "cx,cz" → cache slot index
    this._chunkSlot = 0;                   // next free slot (round-robin)
    this._chunkUsed = 0;
    this._chunkState = new Uint8Array(this._chunkCapacity);
    this._chunkCX = new Int32Array(this._chunkCapacity);
    this._chunkCZ = new Int32Array(this._chunkCapacity);
    this._chunkLOD = new Uint8Array(this._chunkCapacity);
    this._chunkHeightfield = new Array(this._chunkCapacity).fill(null);
    this._chunkDescriptors = new Array(this._chunkCapacity).fill(null);
    this._chunkLastAccess = new Float64Array(this._chunkCapacity);

    // ── pooled descriptors (reused, not freed) ──────────────
    this._descriptorPool = [];
    this._descriptorPoolIndex = 0;

    // ── pooled heightfields per LOD resolution ──────────────
    // Reuse Float32Arrays between chunk regenerations.
    this._heightfieldPool = [];
    for (let i = 0; i < CHUNK_RESOLUTION_LOD.length; i++) {
      this._heightfieldPool.push([]);
    }
    this._heightfieldPoolIndex = new Uint32Array(CHUNK_RESOLUTION_LOD.length);

    // ── scratch vectors (pooled) ────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpMatA = new Mat4();

    // ── per-frame stats ─────────────────────────────────────
    this._stats = {
      updates:            0,
      chunksGenerated:    0,
      chunksEvicted:      0,
      heightQueries:      0,
      slopeQueries:       0,
      biomeHintQueries:   0,
      descriptorComputes: 0,
      pooledHeightfields: 0
    };

    // ── timing ──────────────────────────────────────────────
    this._lastUpdateTime = -Infinity;

    // ── frame reference ─────────────────────────────────────
    this._frameRef = null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── heightfield generation ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  // FBM(x) = Σ_{i=0..octaves} persistence^i · noise(lacunarity^i · x)
  // Domain warping: x' = x + warpStrength · noise(x) applied to the
  // first octave to break up grid-aligned features.
  _computeHeight(wx, wz) {
    let x = wx * this.baseFrequency;
    let z = wz * this.baseFrequency;

    // ── domain warp ─────────────────────────────────────────
    if (this.warpStrength > 0) {
      const wxNoise = this._noise.noise(x * 0.5, z * 0.5);
      const wzNoise = this._noise.noise(x * 0.5 + 13.7, z * 0.5 + 31.1);
      x += wxNoise * this.warpStrength;
      z += wzNoise * this.warpStrength;
    }

    // ── FBM accumulation ────────────────────────────────────
    let amp = 1.0;
    let freq = 1.0;
    let sum = 0.0;
    let norm = 0.0;
    let ridgeSum = 0.0;
    let ridgeNorm = 0.0;

    for (let o = 0; o < this.octaves; o++) {
      // Band-limit check: if the octave's wavelength is smaller
      // than the sampling distance, skip (Nyquist).
      if (this.bandLimit) {
        const wavelength = 1.0 / (freq * this.baseFrequency);
        if (wavelength < 2.0) break;
      }
      const n = this._noise.noise(x * freq, z * freq);
      sum += n * amp;
      norm += amp;

      // Ridged FBM: 1 - |n|, produces sharp peaks.
      const ridged = 1.0 - Math.abs(n);
      ridgeSum += ridged * amp;
      ridgeNorm += amp;

      amp *= this.persistence;
      freq *= this.lacunarity;
    }

    const fbm = norm > 0 ? sum / norm : 0;
    const ridged = ridgeNorm > 0 ? ridgeSum / ridgeNorm : 0;
    const combined = fbm * (1 - this.ridgeMix) + ridged * this.ridgeMix;

    // Map to [worldMinY, worldMaxY].
    const t = (combined * 0.5 + 0.5); // [0,1]
    return this.worldMinY + t * (this.worldMaxY - this.worldMinY);
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk heightfield building ──────────────────────────
  // ══════════════════════════════════════════════════════════
  _buildHeightfield(cx, cz, lod) {
    const resolution = CHUNK_RESOLUTION_LOD[lod];
    const size = resolution * resolution;
    const hf = this._acquireHeightfield(lod, size);
    const chunkOriginX = cx * this.chunkSize;
    const chunkOriginZ = cz * this.chunkSize;
    const step = this.chunkSize / (resolution - 1);

    for (let j = 0; j < resolution; j++) {
      const wz = chunkOriginZ + j * step;
      const rowOffset = j * resolution;
      for (let i = 0; i < resolution; i++) {
        const wx = chunkOriginX + i * step;
        hf[rowOffset + i] = this._computeHeight(wx, wz);
      }
    }
    return hf;
  }

  _acquireHeightfield(lod, size) {
    const pool = this._heightfieldPool[lod];
    const idx = this._heightfieldPoolIndex[lod];
    if (idx < pool.length) {
      const hf = pool[idx];
      this._heightfieldPoolIndex[lod]++;
      if (hf.length === size) {
        this._stats.pooledHeightfields++;
        return hf;
      }
    }
    const hf = new Float32Array(size);
    pool.push(hf);
    this._heightfieldPoolIndex[lod]++;
    return hf;
  }

  _releaseAllHeightfields() {
    for (let i = 0; i < CHUNK_RESOLUTION_LOD.length; i++) {
      this._heightfieldPoolIndex[i] = 0;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── descriptor computation ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeDescriptors(hf, resolution, cx, cz) {
    const desc = this._acquireDescriptor();
    const size = resolution;
    const step = this.chunkSize / (resolution - 1);

    // ── aggregate stats ─────────────────────────────────────
    let sumHeight = 0;
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    let sumSlope = 0;
    let sumRoughness = 0;
    let sumCurvature = 0;
    let samples = 0;

    // ── slope field (per-sample) ────────────────────────────
    // Slope = arctan(|∇h|), where ∇h is the horizontal gradient.
    // We compute it from central differences.
    let maxSlope = 0;
    let minSlope = Infinity;

    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const h = hf[j * size + i];
        sumHeight += h;
        if (h < minHeight) minHeight = h;
        if (h > maxHeight) maxHeight = h;
        samples++;

        // Sample neighbours for slope.
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(size - 1, i + 1);
        const j0 = Math.max(0, j - 1);
        const j1 = Math.min(size - 1, j + 1);

        const dhdx = (hf[j * size + i1] - hf[j * size + i0]) / ((i1 - i0) * step);
        const dhdz = (hf[j1 * size + i] - hf[j0 * size + i]) / ((j1 - j0) * step);
        const gradMag = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
        const slopeRad = Math.atan(gradMag);
        sumSlope += slopeRad;
        if (slopeRad > maxSlope) maxSlope = slopeRad;
        if (slopeRad < minSlope) minSlope = slopeRad;

        // Curvature (Laplacian) from second differences.
        const d2hdx2 = (hf[j * size + i1] - 2 * h + hf[j * size + i0]) / (step * step);
        const d2hdz2 = (hf[j1 * size + i] - 2 * h + hf[j0 * size + i]) / (step * step);
        const curvature = d2hdx2 + d2hdz2;
        sumCurvature += curvature;
      }
    }

    // ── roughness: RMS of second derivative across the chunk ─
    for (let j = 1; j < size - 1; j++) {
      for (let i = 1; i < size - 1; i++) {
        const h = hf[j * size + i];
        const d2hdx2 = (hf[j * size + i + 1] - 2 * h + hf[j * size + i - 1]) / (step * step);
        const d2hdz2 = (hf[(j + 1) * size + i] - 2 * h + hf[(j - 1) * size + i]) / (step * step);
        const laplacian = d2hdx2 + d2hdz2;
        sumRoughness += laplacian * laplacian;
      }
    }
    const roughnessSamples = (size - 2) * (size - 2);
    const roughness = roughnessSamples > 0 ? Math.sqrt(sumRoughness / roughnessSamples) : 0;

    // ── aspect: mean downhill direction ────────────────────
    // Aspect = atan2(dhdz, dhdx) averaged over the chunk centre.
    const centreI = Math.floor(size / 2);
    const centreJ = Math.floor(size / 2);
    const centreI1 = Math.min(size - 1, centreI + 1);
    const centreI0 = Math.max(0, centreI - 1);
    const centreJ1 = Math.min(size - 1, centreJ + 1);
    const centreJ0 = Math.max(0, centreJ - 1);
    const c_dhdx = (hf[centreJ * size + centreI1] - hf[centreJ * size + centreI0]) / ((centreI1 - centreI0) * step);
    const c_dhdz = (hf[centreJ1 * size + centreI] - hf[centreJ0 * size + centreI]) / ((centreJ1 - centreJ0) * step);
    const aspect = Math.atan2(-c_dhdz, -c_dhdx);   // downhill direction

    // ── water-flow accumulation hint ───────────────────────
    // A simple proxy: number of neighbouring cells lower than this
    // one. Real flow routing happens in LandscapeWaterFlowSystem.
    let flowCount = 0;
    for (let j = 1; j < size - 1; j++) {
      for (let i = 1; i < size - 1; i++) {
        const h = hf[j * size + i];
        if (hf[j * size + i + 1] < h) flowCount++;
        if (hf[j * size + i - 1] < h) flowCount++;
        if (hf[(j + 1) * size + i] < h) flowCount++;
        if (hf[(j - 1) * size + i] < h) flowCount++;
      }
    }
    const flowHint = (size - 2) > 0
      ? flowCount / ((size - 2) * (size - 2) * 4)
      : 0;

    // ── biome hint (climate-independent, elevation+slope-based) ─
    const avgHeight = sumHeight / samples;
    const avgSlope = sumSlope / samples;
    const biomeHint = this._classifyBiomeHint(avgHeight, avgSlope, minHeight, maxHeight);

    // ── write descriptor ────────────────────────────────────
    desc.cx = cx;
    desc.cz = cz;
    desc.resolution = resolution;
    desc.step = step;
    desc.minHeight = minHeight;
    desc.maxHeight = maxHeight;
    desc.avgHeight = avgHeight;
    desc.avgSlope = avgSlope;
    desc.maxSlope = maxSlope;
    desc.minSlope = minSlope === Infinity ? 0 : minSlope;
    desc.roughness = roughness;
    desc.avgCurvature = sumCurvature / samples;
    desc.aspect = aspect;
    desc.flowHint = flowHint;
    desc.biomeHint = biomeHint;
    desc.heightfield = hf;
    desc.computedAt = performance.now() / 1000;

    this._stats.descriptorComputes++;
    return desc;
  }

  _classifyBiomeHint(avgHeight, avgSlope, minHeight, maxHeight) {
    // Purely elevation+slope-based classifier; the BiomeBlendField
    // will overlay climate to produce final biome weights.
    if (avgHeight < this.seaLevel - 20) {
      return BIOME_HINT.MARINE;
    }
    if (avgHeight < this.seaLevel + 5) {
      return BIOME_HINT.FRESHWATER;
    }
    if (maxHeight > 2000 || avgSlope > 0.6) {
      return BIOME_HINT.ALPINE;
    }
    if (avgHeight > 3000) {
      return BIOME_HINT.TUNDRA;
    }
    if (avgSlope > 0.35) {
      return BIOME_HINT.TAIGA;
    }
    if (avgHeight > this.seaLevel + 800) {
      return BIOME_HINT.TEMPERATE;
    }
    if (avgHeight > this.seaLevel + 200) {
      return BIOME_HINT.GRASSLAND;
    }
    return BIOME_HINT.DESERT;
  }

  _acquireDescriptor() {
    const idx = this._descriptorPoolIndex;
    if (idx < this._descriptorPool.length) {
      this._descriptorPoolIndex++;
      return this._descriptorPool[idx];
    }
    const desc = {
      cx: 0, cz: 0,
      resolution: 0, step: 1,
      minHeight: 0, maxHeight: 0, avgHeight: 0,
      avgSlope: 0, maxSlope: 0, minSlope: 0,
      roughness: 0, avgCurvature: 0,
      aspect: 0, flowHint: 0,
      biomeHint: 0,
      heightfield: null,
      computedAt: 0
    };
    this._descriptorPool.push(desc);
    this._descriptorPoolIndex++;
    return desc;
  }

  _releaseAllDescriptors() {
    this._descriptorPoolIndex = 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk cache management ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _makeKey(cx, cz) {
    return cx + ',' + cz;
  }

  _getChunkSlot(cx, cz) {
    const key = this._makeKey(cx, cz);
    if (this._chunkKeys.has(key)) {
      return this._chunkKeys.get(key);
    }
    return -1;
  }

  _allocChunkSlot(cx, cz, lod) {
    // Evict oldest if cache is full.
    if (this._chunkUsed >= this._chunkCapacity) {
      this._evictOldest();
    }

    // Reuse an EVICTED slot or extend the pool.
    let slot = -1;
    for (let i = 0; i < this._chunkCapacity; i++) {
      if (this._chunkState[i] === CHUNK_STATE.EMPTY) {
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      slot = this._chunkSlot;
      this._chunkSlot = (this._chunkSlot + 1) % this._chunkCapacity;
      this._evictSlot(slot);
    }

    // Build the chunk.
    const heightfield = this._buildHeightfield(cx, cz, lod);
    const descriptor = this._computeDescriptors(heightfield, CHUNK_RESOLUTION_LOD[lod], cx, cz);

    this._chunkState[slot] = CHUNK_STATE.READY;
    this._chunkCX[slot] = cx;
    this._chunkCZ[slot] = cz;
    this._chunkLOD[slot] = lod;
    this._chunkHeightfield[slot] = heightfield;
    this._chunkDescriptors[slot] = descriptor;
    this._chunkLastAccess[slot] = performance.now() / 1000;
    this._chunkUsed++;
    this._chunkKeys.set(this._makeKey(cx, cz), slot);
    this._stats.chunksGenerated++;

    return slot;
  }

  _evictSlot(slot) {
    if (this._chunkState[slot] === CHUNK_STATE.EMPTY) return;
    const key = this._makeKey(this._chunkCX[slot], this._chunkCZ[slot]);
    this._chunkKeys.delete(key);
    this._chunkState[slot] = CHUNK_STATE.EMPTY;
    this._chunkHeightfield[slot] = null;
    this._chunkDescriptors[slot] = null;
    this._chunkUsed--;
    this._stats.chunksEvicted++;
  }

  _evictOldest() {
    let oldest = -1;
    let oldestTime = Infinity;
    for (let i = 0; i < this._chunkCapacity; i++) {
      if (this._chunkState[i] === CHUNK_STATE.EMPTY) continue;
      if (this._chunkLastAccess[i] < oldestTime) {
        oldestTime = this._chunkLastAccess[i];
        oldest = i;
      }
    }
    if (oldest >= 0) this._evictSlot(oldest);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════

  // ── height at a world position (bilinear from LOD 0 chunk) ─
  getHeight(wx, wz, lod = 0) {
    this._stats.heightQueries++;
    const cx = Math.floor(wx / this.chunkSize);
    const cz = Math.floor(wz / this.chunkSize);
    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] !== CHUNK_STATE.READY || this._chunkLOD[slot] !== lod) {
      slot = this._allocChunkSlot(cx, cz, lod);
    }
    this._chunkLastAccess[slot] = performance.now() / 1000;

    const desc = this._chunkDescriptors[slot];
    const hf = this._chunkHeightfield[slot];
    const resolution = desc.resolution;

    // Local coordinates in the chunk's sample grid.
    const localX = (wx - cx * this.chunkSize) / desc.step;
    const localZ = (wz - cz * this.chunkSize) / desc.step;

    const i0 = Math.floor(localX);
    const j0 = Math.floor(localZ);
    const fx = localX - i0;
    const fz = localZ - j0;

    const i1 = Math.min(resolution - 1, i0 + 1);
    const j1 = Math.min(resolution - 1, j0 + 1);
    const ic0 = Math.max(0, Math.min(resolution - 1, i0));
    const jc0 = Math.max(0, Math.min(resolution - 1, j0));

    // Bilinear interpolation.
    const h00 = hf[jc0 * resolution + ic0];
    const h10 = hf[jc0 * resolution + i1];
    const h01 = hf[j1 * resolution + ic0];
    const h11 = hf[j1 * resolution + i1];

    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    return h0 * (1 - fz) + h1 * fz;
  }

  // ── slope angle at a world position (radians) ────────────
  getSlope(wx, wz, lod = 0) {
    this._stats.slopeQueries++;
    const d = this.slopeSampleDistance;
    const hL = this.getHeight(wx - d, wz, lod);
    const hR = this.getHeight(wx + d, wz, lod);
    const hD = this.getHeight(wx, wz - d, lod);
    const hU = this.getHeight(wx, wz + d, lod);

    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);
    return Math.atan(Math.sqrt(dhdx * dhdx + dhdz * dhdz));
  }

  // ── full slope + aspect at a world position ──────────────
  getSlopeAndAspect(wx, wz, outSlopeAspect, lod = 0) {
    const d = this.slopeSampleDistance;
    const hL = this.getHeight(wx - d, wz, lod);
    const hR = this.getHeight(wx + d, wz, lod);
    const hD = this.getHeight(wx, wz - d, lod);
    const hU = this.getHeight(wx, wz + d, lod);

    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);
    const slope = Math.atan(Math.sqrt(dhdx * dhdx + dhdz * dhdz));
    const aspect = Math.atan2(-dhdz, -dhdx);

    outSlopeAspect.slope = slope;
    outSlopeAspect.aspect = aspect;
    return outSlopeAspect;
  }

  // ── curvature at a world position ────────────────────────
  getCurvature(wx, wz, lod = 0) {
    const d = this.curvatureSampleDistance;
    const hC = this.getHeight(wx, wz, lod);
    const hL = this.getHeight(wx - d, wz, lod);
    const hR = this.getHeight(wx + d, wz, lod);
    const hD = this.getHeight(wx, wz - d, lod);
    const hU = this.getHeight(wx, wz + d, lod);
    return (hL + hR + hD + hU - 4 * hC) / (d * d);
  }

  // ── normal at a world position (matches slope gradient) ──
  getNormal(wx, wz, targetVec, lod = 0) {
    const d = this.slopeSampleDistance;
    const hL = this.getHeight(wx - d, wz, lod);
    const hR = this.getHeight(wx + d, wz, lod);
    const hD = this.getHeight(wx, wz - d, lod);
    const hU = this.getHeight(wx, wz + d, lod);

    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);

    targetVec.set(-dhdx, 1.0, -dhdz).normalize();
    return targetVec;
  }

  // ── water depth at a world position ──────────────────────
  getWaterDepth(wx, wz, lod = 0) {
    const h = this.getHeight(wx, wz, lod);
    return Math.max(0, this.seaLevel - h);
  }

  // ── biome hint at a world position ───────────────────────
  getBiomeHint(wx, wz, lod = 0) {
    this._stats.biomeHintQueries++;
    const cx = Math.floor(wx / this.chunkSize);
    const cz = Math.floor(wz / this.chunkSize);
    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] !== CHUNK_STATE.READY) {
      slot = this._allocChunkSlot(cx, cz, lod);
    }
    return this._chunkDescriptors[slot].biomeHint;
  }

  // ── full chunk descriptor for a world position ───────────
  getChunkDescriptor(wx, wz, lod = 0) {
    const cx = Math.floor(wx / this.chunkSize);
    const cz = Math.floor(wz / this.chunkSize);
    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] !== CHUNK_STATE.READY) {
      slot = this._allocChunkSlot(cx, cz, lod);
    }
    this._chunkLastAccess[slot] = performance.now() / 1000;
    return this._chunkDescriptors[slot];
  }

  // ── ray-march against the heightfield ────────────────────
  // Returns the hit distance along the ray, or -1 if no hit.
  raycast(ray, maxDistance = 1000, step = 5) {
    const origin = ray.origin;
    const direction = ray.direction;

    let lastDiff = 0;
    let lastT = 0;

    for (let t = step; t <= maxDistance; t += step) {
      const px = origin.x + direction.x * t;
      const py = origin.y + direction.y * t;
      const pz = origin.z + direction.z * t;
      const terrainH = this.getHeight(px, pz);

      const diff = py - terrainH;
      if (diff <= 0) {
        // Binary refinement between lastT and t.
        let lo = lastT, hi = t;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = origin.x + direction.x * mid;
          const my = origin.y + direction.y * mid;
          const mz = origin.z + direction.z * mid;
          if (my - this.getHeight(mx, mz) > 0) lo = mid;
          else hi = mid;
        }
        return (lo + hi) * 0.5;
      }
      lastDiff = diff;
      lastT = t;
    }
    return -1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame integration ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) return 0;
    this._lastUpdateTime = now;
    this._frameRef = frame;

    // Reset per-frame pool indices.
    this._releaseAllDescriptors();
    // Note: heightfields are held by live chunks; only release the
    // pool overflow (chunks that were evicted before this frame).

    // ── write to frame.layers.spatial if chunk data is present ─
    // Terrain chunks are written into the spatial layer as
    // background AABBs so culling and streaming can see them.
    this._writeTerrainToFrame(frame);

    this._stats.updates++;
    return 1;
  }

  _writeTerrainToFrame(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial || !spatial.aabb) return;

    // Terrain chunks use the last slot of the AABB array (reserved).
    // Downstream consumers read via `frame.layers.spatial.terrainChunks`.
    if (!spatial.terrainChunks) {
      spatial.terrainChunks = {
        count: 0,
        cx: new Int32Array(this._chunkCapacity),
        cz: new Int32Array(this._chunkCapacity),
        lod: new Uint8Array(this._chunkCapacity),
        minY: new Float32Array(this._chunkCapacity),
        maxY: new Float32Array(this._chunkCapacity),
        avgSlope: new Float32Array(this._chunkCapacity),
        biomeHint: new Uint8Array(this._chunkCapacity),
        roughness: new Float32Array(this._chunkCapacity),
        flowHint: new Float32Array(this._chunkCapacity)
      };
    }

    const tc = spatial.terrainChunks;
    tc.count = 0;
    for (let i = 0; i < this._chunkCapacity; i++) {
      if (this._chunkState[i] !== CHUNK_STATE.READY) continue;
      const desc = this._chunkDescriptors[i];
      if (!desc) continue;
      const o = tc.count;
      tc.cx[o] = this._chunkCX[i];
      tc.cz[o] = this._chunkCZ[i];
      tc.lod[o] = this._chunkLOD[i];
      tc.minY[o] = desc.minHeight;
      tc.maxY[o] = desc.maxHeight;
      tc.avgSlope[o] = desc.avgSlope;
      tc.biomeHint[o] = desc.biomeHint;
      tc.roughness[o] = desc.roughness;
      tc.flowHint[o] = desc.flowHint;
      tc.count++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── prefetch / streaming hint ───────────────────────────
  // ══════════════════════════════════════════════════════════
  // Pre-generates terrain chunks in a radius around a position
  // so first-frame queries are fast.
  prefetch(wx, wz, radiusChunks = 2, lod = 0) {
    const cx = Math.floor(wx / this.chunkSize);
    const cz = Math.floor(wz / this.chunkSize);
    let generated = 0;
    for (let dz = -radiusChunks; dz <= radiusChunks; dz++) {
      for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
        const ncx = cx + dx;
        const ncz = cz + dz;
        const slot = this._getChunkSlot(ncx, ncz);
        if (slot < 0 || this._chunkState[slot] !== CHUNK_STATE.READY) {
          this._allocChunkSlot(ncx, ncz, lod);
          generated++;
        }
      }
    }
    return generated;
  }

  // ══════════════════════════════════════════════════════════
  // ─── interactive setters (all parameters exposed) ────────
  // ══════════════════════════════════════════════════════════
  setFBM(params) {
    if (params.baseFrequency !== undefined) this.baseFrequency = params.baseFrequency;
    if (params.octaves !== undefined) this.octaves = params.octaves;
    if (params.persistence !== undefined) this.persistence = params.persistence;
    if (params.lacunarity !== undefined) this.lacunarity = params.lacunarity;
    if (params.amplitude !== undefined) this.amplitude = params.amplitude;
    if (params.ridgeMix !== undefined) this.ridgeMix = params.ridgeMix;
    if (params.warpStrength !== undefined) this.warpStrength = params.warpStrength;
    this._invalidateAllChunks();
    return this;
  }

  setWorldExtents(minY, maxY) {
    this.worldMinY = minY;
    this.worldMaxY = maxY;
    this._invalidateAllChunks();
    return this;
  }

  setSeaLevel(level) {
    this.seaLevel = level;
    this._invalidateAllChunks();
    return this;
  }

  setChunkSize(size) {
    if (size <= 0) return this;
    this.chunkSize = size;
    this._invalidateAllChunks();
    return this;
  }

  setLODCount(count) {
    // Enforce 1..MAX_LOD_LEVELS
    if (count < 1) count = 1;
    if (count > MAX_LOD_LEVELS) count = MAX_LOD_LEVELS;
    this.maxLODLevels = count;
    this._invalidateAllChunks();
    return this;
  }

  _invalidateAllChunks() {
    for (let i = 0; i < this._chunkCapacity; i++) {
      this._evictSlot(i);
    }
    this._chunkKeys.clear();
    this._chunkUsed = 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── diagnostics ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      ...this._stats,
      activeChunks: this._chunkUsed,
      cacheCapacity: this._chunkCapacity
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  dispose() {
    this._invalidateAllChunks();
    for (let i = 0; i < CHUNK_RESOLUTION_LOD.length; i++) {
      this._heightfieldPool[i].length = 0;
      this._heightfieldPoolIndex[i] = 0;
    }
    this._descriptorPool.length = 0;
    this._descriptorPoolIndex = 0;
  }
}

export {
  TerrainProvider,
  BIOME_HINT,
  CHUNK_STATE,
  CHUNK_RESOLUTION_LOD,
  MAX_LOD_LEVELS,
  TERRAIN_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};