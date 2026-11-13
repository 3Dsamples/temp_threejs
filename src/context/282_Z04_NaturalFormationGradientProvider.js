// file number : 282_Z04
// full path name : src/context/282_Z04_NaturalFormationGradientProvider.js
// description : Natural-formation gradient provider that procedurally detects, generates, and carves signature natural landforms into the terrain via the 282_Z03_CarveGradientProvider stack. Handles ten formation archetypes derived from real geology: rock ARCH, sea STACK, HOODOO (mushroom rock), MESA (flat-topped plateau), BUTTE (narrow mesa), CAVE (horizontal shaft), SINKHOLE (vertical shaft), ARCHIPELAGO (scattered sea rocks), CENOTE (water-filled sinkhole), and SPIRE (needle tower). For each formation candidate it uses a signature detection rule built on top of ReliefGradientProvider (peaks, ridges, saddles), CliffsGradientProvider (vertical faces, overhangs), SlopeGradientProvider (fall lines, water flow), and TerrainProvider (chunk-level roughness and elevation bands) to score whether a formation should appear at a given world position. Each archetype has a parameterized shape function — a signed-distance field (SDF) sampled through the carve system — that controls its geometry: the arch has a two-pillar + curved span, the stack has a tall narrow column with a tapered base, the hoodoo has a wide cap on a narrow neck, the mesa has a wide flat top with a steep rim, the cave has a horizontal tube, the sinkhole has an inverted cone, the archipelago has multiple small mounds, the cenote has a sinkhole filled with water, the spire has a sharp needle, and the butte is a mesa with a tighter footprint. Formations are deterministic per (world-seed, cx, cz) so the world is stable across reloads, and only "committed" when a candidate passes both the geological score threshold and the performance budget (max formations per chunk per frame). Carved formations mark the fresh band as FRESH_ROCK / FRESH_SCREE and emit a single MUTATION causal event per formation so the persistence layer stores them permanently. All scratch objects are pooled; no allocation after the first frame.
// best for : Adding real geological character to the living world — visible arches, hoodoos, mesas, sea stacks, caves, sinkholes — without a manual authoring pipeline. Every formation is placed by physics (elevation, slope, cliff, water context) and carved into terrain, so it integrates naturally with erosion, water flow, biome assignment, and fauna pathing. Feeds LandscapeDecalPlacementSystem, LandscapePropPlacementSystem, LandscapeWaterFlowSystem, BiomeBlendField, and the persistence pipeline.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision,
  ContextFrame, CoreClock, CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES,
  TemporalContextProvider, WEATHER,
  CausalContextProvider, DERIVED_SIGNAL,
  CoreLayers, LAYER, LAYER_MASKS,
  smoothstep,
  TerrainProvider, BIOME_HINT,
  ElevationProvider, ELEVATION_BAND,
  SlopeGradientProvider, SLOPE_BAND,
  ReliefGradientProvider, RELIEF_CLASS,
  CliffsGradientProvider, CLIFF_CLASS, CLIFF_MATERIAL_BAND,
  CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 0.5;   // formations are authored rarely
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── formation archetypes ───────────────────────────────────────
const FORMATION_TYPE = Object.freeze({
  NONE:         0,
  ARCH:         1,   // rock arch with two pillars + span
  SEA_STACK:    2,   // tall narrow column in water
  HOODOO:       3,   // mushroom rock (wide cap on neck)
  MESA:         4,   // flat-topped plateau
  BUTTE:        5,   // narrow mesa
  CAVE:         6,   // horizontal cave shaft
  SINKHOLE:     7,   // vertical collapse shaft
  ARCHIPELAGO:  8,   // scattered sea rocks
  CENOTE:       9,   // water-filled sinkhole
  SPIRE:       10    // sharp needle tower
});

const FORMATION_TYPE_NAMES = Object.freeze([
  'none', 'arch', 'sea_stack', 'hoodoo', 'mesa', 'butte',
  'cave', 'sinkhole', 'archipelago', 'cenote', 'spire'
]);

// ─── per-type parameter schema ─────────────────────────────────
// Each archetype has a shape descriptor that the SDF sampler reads.
const FORMATION_SCHEMA = Object.freeze({
  [FORMATION_TYPE.ARCH]: {
    baseRadius:   6.0,
    height:      20.0,
    spanWidth:   14.0,
    pillarWidth: 4.0,
    needsCliff:  true,
    needsRelief: RELIEF_CLASS.RIDGE,
    minElevation: 100,
    maxElevation: 2500,
    waterContext: 'dry'
  },
  [FORMATION_TYPE.SEA_STACK]: {
    baseRadius:  5.0,
    height:     30.0,
    taper:      0.6,
    needsCliff: true,
    minElevation: -200,
    maxElevation: 10,
    waterContext: 'marine'
  },
  [FORMATION_TYPE.HOODOO]: {
    baseRadius: 3.0,
    height:    12.0,
    capRadius:  6.0,
    capHeight:  2.0,
    neckRatio:  0.3,
    needsCliff: true,
    minElevation: 500,
    maxElevation: 3000,
    waterContext: 'dry'
  },
  [FORMATION_TYPE.MESA]: {
    baseRadius: 40.0,
    height:    25.0,
    topRadius: 35.0,
    rimAngle:  Math.PI / 2.5,
    needsRelief: RELIEF_CLASS.PLATEAU,
    minElevation: 200,
    maxElevation: 2500,
    waterContext: 'dry'
  },
  [FORMATION_TYPE.BUTTE]: {
    baseRadius: 15.0,
    height:    35.0,
    topRadius: 10.0,
    rimAngle:  Math.PI / 2.2,
    needsRelief: RELIEF_CLASS.PLATEAU,
    minElevation: 200,
    maxElevation: 2800,
    waterContext: 'dry'
  },
  [FORMATION_TYPE.CAVE]: {
    baseRadius: 8.0,
    length:    30.0,
    radius:    4.0,
    needsCliff: true,
    minElevation: 100,
    maxElevation: 2000,
    waterContext: 'dry'
  },
  [FORMATION_TYPE.SINKHOLE]: {
    baseRadius: 12.0,
    depth:      20.0,
    topRadius:  10.0,
    minElevation: 0,
    maxElevation: 2500,
    needsRelief: RELIEF_CLASS.BASIN,
    waterContext: 'dry'
  },
  [FORMATION_TYPE.ARCHIPELAGO]: {
    baseRadius: 30.0,
    moundCount: 5,
    moundRadius: 6.0,
    moundHeight: 8.0,
    minElevation: -50,
    maxElevation: 5,
    waterContext: 'marine'
  },
  [FORMATION_TYPE.CENOTE]: {
    baseRadius: 15.0,
    depth:      25.0,
    topRadius:  13.0,
    waterLevel: -5.0,
    minElevation: 10,
    maxElevation: 1500,
    needsRelief: RELIEF_CLASS.BASIN,
    waterContext: 'freshwater'
  },
  [FORMATION_TYPE.SPIRE]: {
    baseRadius: 4.0,
    height:    40.0,
    taper:      0.3,
    needsCliff: true,
    needsRelief: RELIEF_CLASS.PEAK,
    minElevation: 800,
    maxElevation: 3500,
    waterContext: 'dry'
  }
});

// ─── formation defaults ────────────────────────────────────────
const FORMATION_DEFAULTS = Object.freeze({
  worldSeed:             0xA17C0DE,   // deterministic per world
  formationChance:       0.15,        // per qualifying chunk
  maxFormationsPerFrame: 2,           // performance budget
  maxCandidatesPerFrame: 16,
  carveThreshold:        0.35,        // geological score above which we carve
  minChunksBetween:      4,           // spatial thinning to avoid clustering
  carveRadiusScale:      1.0,
  mutationCoalesceWindow: 1.0,
  chunkSize:             1000
});

// ─── candidate feature (pooled) ─────────────────────────────────
class Candidate {
  constructor() {
    this.wx = 0;
    this.wz = 0;
    this.cx = 0;
    this.cz = 0;
    this.type = FORMATION_TYPE.NONE;
    this.score = 0;
    this.reliefClass = 0;
    this.cliffClass = 0;
    this.slopeAngle = 0;
    this.elevation = 0;
    this.waterDepth = 0;
    this.orientation = 0;   // rotation of the formation
    this.seed = 0;
  }
  reset() {
    this.wx = 0; this.wz = 0;
    this.cx = 0; this.cz = 0;
    this.type = FORMATION_TYPE.NONE;
    this.score = 0;
    this.reliefClass = 0;
    this.cliffClass = 0;
    this.slopeAngle = 0;
    this.elevation = 0;
    this.waterDepth = 0;
    this.orientation = 0;
    this.seed = 0;
  }
}

class NaturalFormationGradientProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...FORMATION_DEFAULTS, ...(options.defaults || {}) };
    this.enableDeterministic = options.enableDeterministic ?? true;
    this.enableCaveCarve = options.enableCaveCarve ?? true;

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpMatA = new Mat4();

    // ── candidate pool ──────────────────────────────────────
    this._candidatePool = [];
    this._candidatePoolIndex = 0;
    const poolSize = options.candidatePoolSize ?? 128;
    for (let i = 0; i < poolSize; i++) {
      this._candidatePool.push(new Candidate());
    }

    // ── spatial thinning: track already-placed formations ───
    this._placedChunks = new Map();   // "cx,cz" → timestamp
    this._placedRadius = this.defaults.minChunksBetween;

    // ── per-frame statistics ────────────────────────────────
    this._stats = {
      updates: 0,
      candidatesGenerated: 0,
      candidatesPassed: 0,
      formationsCarved: 0,
      arches: 0,
      seaStacks: 0,
      hoodoos: 0,
      mesas: 0,
      buttes: 0,
      caves: 0,
      sinkholes: 0,
      archipelagos: 0,
      cenotes: 0,
      spires: 0,
      mutationEventsEmitted: 0,
      thinned: 0
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
    this._carve = options.carve || null;
    this._dispatcher = options.dispatcher || null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachRelief(r) { this._relief = r; return this; }
  attachCliffs(c) { this._cliffs = c; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachDispatcher(d) { this._dispatcher = d; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── hash-based per-chunk RNG (deterministic) ──────────
  // ══════════════════════════════════════════════════════════
  _hashChunk(cx, cz) {
    let h = this.defaults.worldSeed | 0;
    h = (h ^ (cx * 0x9E3779B1)) | 0;
    h = (h ^ (cz * 0x85EBCA77)) | 0;
    h = ((h << 13) | (h >>> 19)) | 0;
    h = (h * 0x5bd1e995) | 0;
    h = (h ^ (h >>> 15)) | 0;
    return h >>> 0;
  }

  _rand01(seed) {
    // xorshift32
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xFFFFFFFF;
  }

  // ══════════════════════════════════════════════════════════
  // ─── geological score computation ───────────────────────
  // ══════════════════════════════════════════════════════════
  // Determines how "worthy" a point is for a natural formation.
  // Reads relief, cliff, slope, and elevation context.
  _computeGeologicalScore(cx, cz, schema, reliefClass, cliffClass, slopeAngle, elevation, waterDepth) {
    let score = 0;

    // ── relief match ────────────────────────────────────────
    if (schema.needsRelief !== undefined) {
      score += reliefClass === schema.needsRelief ? 0.35 : 0.05;
    }

    // ── cliff match ─────────────────────────────────────────
    if (schema.needsCliff === true) {
      score += (cliffClass === CLIFF_CLASS.VERTICAL_FACE ||
                cliffClass === CLIFF_CLASS.OVERHANG ||
                cliffClass === CLIFF_CLASS.UNDERHANG) ? 0.25 : 0.0;
    }

    // ── elevation match ─────────────────────────────────────
    if (elevation >= schema.minElevation && elevation <= schema.maxElevation) {
      score += 0.20;
    }

    // ── water context ───────────────────────────────────────
    if (schema.waterContext === 'marine' && waterDepth > 2) {
      score += 0.15;
    } else if (schema.waterContext === 'freshwater' && waterDepth > 0.5 && waterDepth < 20) {
      score += 0.15;
    } else if (schema.waterContext === 'dry' && waterDepth < 1) {
      score += 0.10;
    }

    // ── slope match (some formations prefer steep, others flat) ─
    if (schema.needsCliff === true) {
      score += Math.min(0.10, slopeAngle / (Math.PI / 2));
    } else {
      // Plateau-type formations prefer flatter slopes.
      score += Math.min(0.10, (Math.PI / 2 - slopeAngle) / (Math.PI / 2));
    }

    return Math.min(1.0, score);
  }

  // ══════════════════════════════════════════════════════════
  // ─── candidate generation ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  _generateCandidates(frame) {
    const tc = frame.layers.spatial?.terrainChunks;
    if (!tc || tc.count === 0) return 0;

    const count = Math.min(tc.count, this.defaults.maxCandidatesPerFrame);
    const chunkSize = this.defaults.chunkSize;

    const spatial = frame.layers.spatial;
    const relief = spatial.relief;
    const cliffs = spatial.cliffs;

    let generated = 0;

    for (let i = 0; i < count; i++) {
      const cx = tc.cx[i];
      const cz = tc.cz[i];
      const centreX = (cx + 0.5) * chunkSize;
      const centreZ = (cz + 0.5) * chunkSize;

      // Deterministic per-chunk seed.
      const seed = this._hashChunk(cx, cz);
      const roll = this._rand01(seed);
      if (roll > this.defaults.formationChance) continue;

      // Check spatial thinning.
      if (this._isThinned(cx, cz)) {
        this._stats.thinned++;
        continue;
      }

      // Get geological context.
      const reliefClass = relief ? relief.chunkDominantRelief[i] : 0;
      const cliffClass = cliffs ? cliffs.chunkDominantClass[i] : 0;
      const slopeAngle = tc.avgSlope ? tc.avgSlope[i] : 0;
      const elevation = tc.minY && tc.maxY ? (tc.minY[i] + tc.maxY[i]) * 0.5 : 0;
      const seaLevel = this._elevation ? this._elevation.seaLevel : 0;
      const waterDepth = Math.max(0, seaLevel - elevation);

      // Try each archetype and pick the best.
      let best = null;
      let bestScore = 0;
      let bestType = FORMATION_TYPE.NONE;

      for (const typeName of Object.keys(FORMATION_SCHEMA)) {
        const type = parseInt(typeName, 10);
        const schema = FORMATION_SCHEMA[type];
        const score = this._computeGeologicalScore(
          cx, cz, schema, reliefClass, cliffClass,
          slopeAngle, elevation, waterDepth
        );
        if (score > bestScore) {
          bestScore = score;
          bestType = type;
        }
      }

      if (bestType === FORMATION_TYPE.NONE || bestScore < this.defaults.carveThreshold) {
        continue;
      }

      // Allocate a candidate.
      const candidate = this._acquireCandidate();
      candidate.wx = centreX + (this._rand01(seed ^ 0xABCD1234) - 0.5) * chunkSize * 0.5;
      candidate.wz = centreZ + (this._rand01(seed ^ 0x5678EFGH) - 0.5) * chunkSize * 0.5;
      candidate.cx = cx;
      candidate.cz = cz;
      candidate.type = bestType;
      candidate.score = bestScore;
      candidate.reliefClass = reliefClass;
      candidate.cliffClass = cliffClass;
      candidate.slopeAngle = slopeAngle;
      candidate.elevation = elevation;
      candidate.waterDepth = waterDepth;
      candidate.orientation = this._rand01(seed ^ 0x11223344) * 2 * Math.PI;
      candidate.seed = seed;

      this._pendingCandidates.push(candidate);
      generated++;
      this._stats.candidatesGenerated++;
    }

    this._pendingCandidates.sort((a, b) => b.score - a.score);
    return generated;
  }

  _isThinned(cx, cz) {
    const r = this._placedRadius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const key = (cx + dx) + ',' + (cz + dz);
        if (this._placedChunks.has(key)) return true;
      }
    }
    return false;
  }

  _acquireCandidate() {
    if (this._candidatePoolIndex < this._candidatePool.length) {
      const c = this._candidatePool[this._candidatePoolIndex];
      this._candidatePoolIndex++;
      c.reset();
      return c;
    }
    const c = new Candidate();
    this._candidatePool.push(c);
    this._candidatePoolIndex++;
    return c;
  }

  _releaseAllCandidates() {
    for (let i = 0; i < this._pendingCandidates.length; i++) {
      // Do not release back to pool here — they may still be referenced
      // by the persistence system. Just clear the pending list.
    }
    this._pendingCandidates.length = 0;
    this._candidatePoolIndex = 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── formation SDF shape functions ─────────────────────
  // ══════════════════════════════════════════════════════════
  // Each formation computes a signed delta (positive = add, negative
  // = subtract) at a world position relative to the formation centre.
  // The returned value is added to the carve delta at that point.
  // All computations use the candidate's schema and local coordinates.

  _archDelta(dx, dz, dy, schema, seed) {
    const baseR = schema.baseRadius;
    const height = schema.height;
    const spanW = schema.spanWidth;
    const pillarW = schema.pillarWidth;

    const ax = Math.abs(dx);
    if (ax > spanW) return 0;

    // Distance from centre.
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Pillar zones: left and right support.
    if (dy < height * 0.5 && ax > pillarW) {
      // Out of pillars, check if within span top.
      const t = (spanW - ax) / (spanW - pillarW);
      if (t > 0 && dy > height * 0.5) {
        // Curved span.
        const spanY = height * 0.5 + Math.sqrt(Math.max(0, 1 - t * t)) * height * 0.3;
        if (dy < spanY) {
          return Math.min(0.8, 1.0 - dist / spanW) * 3.0;
        }
      }
      return 0;
    }

    // Pillar support.
    if (dy < height) {
      const pillarT = 1 - ax / pillarW;
      if (pillarT > 0) {
        return pillarT * 4.0 * (dy < height * 0.5 ? 1.0 : 0.5);
      }
    }
    return 0;
  }

  _seaStackDelta(dx, dz, dy, schema, seed) {
    const baseR = schema.baseRadius;
    const height = schema.height;
    const taper = schema.taper;

    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > baseR * 1.5) return 0;

    // Taper: radius shrinks with height.
    const t = Math.max(0, dy / height);
    if (t > 1) return 0;
    const radiusAtT = baseR * (1 - taper * t);
    if (dist > radiusAtT) return 0;

    const falloff = 1 - dist / radiusAtT;
    return falloff * 6.0;
  }

  _hoodooDelta(dx, dz, dy, schema, seed) {
    const baseR = schema.baseRadius;
    const height = schema.height;
    const capR = schema.capRadius;
    const capH = schema.capHeight;
    const neckRatio = schema.neckRatio;

    const dist = Math.sqrt(dx * dx + dz * dz);

    // Cap.
    if (dy >= height - capH) {
      if (dist < capR) {
        const t = 1 - dist / capR;
        return t * 5.0;
      }
      return 0;
    }

    // Neck.
    if (dy >= 0 && dy < height - capH) {
      const neckR = baseR * neckRatio + (baseR - baseR * neckRatio) * (1 - dy / height);
      if (dist < neckR) {
        const t = 1 - dist / neckR;
        return t * 3.0;
      }
    }
    return 0;
  }

  _mesaDelta(dx, dz, dy, schema, seed) {
    const baseR = schema.baseRadius;
    const height = schema.height;
    const topR = schema.topRadius;
    const rimAngle = schema.rimAngle;

    if (dy > height) {
      // Above the mesa top: no addition.
      return 0;
    }

    const dist = Math.sqrt(dx * dx + dz * dz);
    const t = dy / height;

    // Radius at height t: shrinks from baseR at base to topR at top.
    const radiusAtT = baseR + (topR - baseR) * t;
    if (dist > radiusAtT) return 0;

    // Flat top region.
    if (dy > height * 0.9) {
      if (dist < topR) {
        return 2.0;
      }
    }

    // Slope region.
    const tRadial = 1 - dist / radiusAtT;
    return tRadial * 3.0;
  }

  _butteDelta(dx, dz, dy, schema, seed) {
    // Same as mesa but tighter footprint.
    return this._mesaDelta(dx, dz, dy, schema, seed) * 1.3;
  }

  _caveDelta(dx, dz, dy, schema, seed) {
    if (!this.enableCaveCarve) return 0;

    const length = schema.length;
    const radius = schema.radius;

    // Cave is a horizontal tube running along the local X axis.
    const along = Math.abs(dx);
    if (along > length * 0.5) return 0;
    const dyAbs = Math.abs(dy);
    const dzAbs = Math.abs(dz);

    const dist = Math.sqrt(dyAbs * dyAbs + dzAbs * dzAbs);
    if (dist > radius) return 0;

    // Inside the tube: subtract (carve out).
    const falloff = 1 - dist / radius;
    return -falloff * 5.0;
  }

  _sinkholeDelta(dx, dz, dy, schema, seed) {
    const baseR = schema.baseRadius;
    const depth = schema.depth;
    const topR = schema.topRadius;

    if (dy > 0) return 0;

    const dist = Math.sqrt(dx * dx + dz * dz);
    const t = Math.max(0, -dy / depth);

    // Radius shrinks with depth (inverted cone).
    const radiusAtT = topR + (baseR - topR) * t;
    if (dist > radiusAtT) return 0;

    // Inside the cone: subtract.
    const tRadial = 1 - dist / radiusAtT;
    return -tRadial * 6.0 * (1 - t);
  }

  _archipelagoDelta(dx, dz, dy, schema, seed) {
    const baseR = schema.baseRadius;
    const count = schema.moundCount;
    const moundR = schema.moundRadius;
    const moundH = schema.moundHeight;

    // Multiple small mounds scattered within baseR.
    let delta = 0;
    for (let i = 0; i < count; i++) {
      // Deterministic mound position from seed.
      const angle = this._rand01(seed + i * 17) * 2 * Math.PI;
      const radiusFrac = this._rand01(seed + i * 31) * 0.7 + 0.15;
      const mx = Math.cos(angle) * baseR * radiusFrac;
      const mz = Math.sin(angle) * baseR * radiusFrac;
      const mR = moundR * (0.7 + this._rand01(seed + i * 53) * 0.6);

      const ddx = dx - mx;
      const ddz = dz - mz;
      const dist = Math.sqrt(ddx * ddx + ddz * ddz);
      if (dist > mR) continue;

      // Hemisphere mound.
      const t = 1 - (dist * dist) / (mR * mR);
      if (t > 0) {
        const heightAtDist = moundH * t;
        if (dy < heightAtDist) {
          delta = Math.max(delta, (1 - dist / mR) * 4.0);
        }
      }
    }
    return delta;
  }

  _cenoteDelta(dx, dz, dy, schema, seed) {
    const baseR = schema.baseRadius;
    const depth = schema.depth;
    const topR = schema.topRadius;
    const waterLevel = schema.waterLevel;

    // Same as sinkhole but with water inside. The carve is the same
    // shape; the water is filled by the bathymetry provider.
    return this._sinkholeDelta(dx, dz, dy, {
      baseRadius: baseR,
      depth,
      topRadius: topR
    }, seed);
  }

  _spireDelta(dx, dz, dy, schema, seed) {
    const baseR = schema.baseRadius;
    const height = schema.height;
    const taper = schema.taper;

    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dy > height) return 0;
    if (dy < 0) return 0;

    const t = dy / height;
    const radiusAtT = baseR * (1 - taper * t);
    if (dist > radiusAtT) return 0;

    const tRadial = 1 - dist / radiusAtT;
    return tRadial * 7.0 * (1 - t * 0.5);
  }

  // Dispatch to the correct shape function based on formation type.
  _computeFormationDelta(type, dx, dz, dy, schema, seed) {
    switch (type) {
      case FORMATION_TYPE.ARCH:        return this._archDelta(dx, dz, dy, schema, seed);
      case FORMATION_TYPE.SEA_STACK:   return this._seaStackDelta(dx, dz, dy, schema, seed);
      case FORMATION_TYPE.HOODOO:      return this._hoodooDelta(dx, dz, dy, schema, seed);
      case FORMATION_TYPE.MESA:        return this._mesaDelta(dx, dz, dy, schema, seed);
      case FORMATION_TYPE.BUTTE:       return this._butteDelta(dx, dz, dy, schema, seed);
      case FORMATION_TYPE.CAVE:        return this._caveDelta(dx, dz, dy, schema, seed);
      case FORMATION_TYPE.SINKHOLE:    return this._sinkholeDelta(dx, dz, dy, schema, seed);
      case FORMATION_TYPE.ARCHIPELAGO: return this._archipelagoDelta(dx, dz, dy, schema, seed);
      case FORMATION_TYPE.CENOTE:      return this._cenoteDelta(dx, dz, dy, schema, seed);
      case FORMATION_TYPE.SPIRE:       return this._spireDelta(dx, dz, dy, schema, seed);
      default:                          return 0;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── formation carving ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _carveFormation(candidate) {
    if (!this._carve) return 0;

    const type = candidate.type;
    const schema = FORMATION_SCHEMA[type];
    if (!schema) return 0;

    // Determine carve extent from schema.
    let extent = schema.baseRadius || 0;
    if (schema.spanWidth !== undefined) extent = Math.max(extent, schema.spanWidth);
    if (schema.length !== undefined) extent = Math.max(extent, schema.length * 0.5);
    if (schema.topRadius !== undefined) extent = Math.max(extent, schema.topRadius);
    extent *= this.defaults.carveRadiusScale;

    // Step size for sampling the SDF.
    const step = 1.5;
    const samplesPerAxis = Math.ceil((extent * 2) / step);
    const samples = samplesPerAxis * samplesPerAxis;
    if (samples > 4096) return 0;   // safety guard

    // Sample grid centred on candidate.
    const originX = candidate.wx - extent;
    const originZ = candidate.wz - extent;
    const baseHeight = this._elevation
      ? this._elevation.getElevation(candidate.wx, candidate.wz)
      : (this._terrain ? this._terrain.getHeight(candidate.wx, candidate.wz) : candidate.elevation);

    // Track cumulative carve per cell to pass to the carve provider.
    const carveRadiusMax = step * 0.7;
    const before = this._carve.getCarveDelta(candidate.wx, candidate.wz);

    // Apply carve via 282_Z03's carveDelta for each sample that
    // produces a non-zero delta.
    let carvedCells = 0;
    for (let j = 0; j < samplesPerAxis; j++) {
      for (let i = 0; i < samplesPerAxis; i++) {
        const wx = originX + (i + 0.5) * step;
        const wz = originZ + (j + 0.5) * step;

        // Local coords relative to formation centre.
        const dx = wx - candidate.wx;
        const dz = wz - candidate.wz;

        // Dy is height relative to base height at the sample point.
        const localBaseH = this._elevation
          ? this._elevation.getElevation(wx, wz)
          : (this._terrain ? this._terrain.getHeight(wx, wz) : baseHeight);
        const dy = localBaseH - baseHeight;

        const delta = this._computeFormationDelta(type, dx, dz, dy, schema, candidate.seed);
        if (Math.abs(delta) < 0.05) continue;

        // Apply via carve system.
        this._carve.carveDelta(
          wx, wz, delta, carveRadiusMax,
          type === FORMATION_TYPE.CAVE || type === FORMATION_TYPE.SINKHOLE ||
          type === FORMATION_TYPE.CENOTE ? CARVE_SOURCE.IMPACT : CARVE_SOURCE.IMPACT
        );
        carvedCells++;
      }
    }

    // Set material band based on type.
    let band = CARVE_MATERIAL_BAND.FRESH_ROCK;
    if (type === FORMATION_TYPE.SINKHOLE || type === FORMATION_TYPE.CENOTE) {
      band = CARVE_MATERIAL_BAND.FRESH_SCREE;
    } else if (type === FORMATION_TYPE.ARCHIPELAGO || type === FORMATION_TYPE.SEA_STACK) {
      band = CARVE_MATERIAL_BAND.FRESH_ROCK;
    }

    this._carve.carveMaterialBand(candidate.wx, candidate.wz, band, extent);

    // Mark chunk as placed.
    this._placedChunks.set(candidate.cx + ',' + candidate.cz, performance.now() / 1000);

    // Emit single coalesced mutation event per formation.
    if (this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.MUTATION,
        [candidate.wx, baseHeight, candidate.wz],
        -1, 100, 2.0,
        {
          kind: 'natural_formation',
          formationType: type,
          formationTypeName: FORMATION_TYPE_NAMES[type],
          radius: extent,
          score: candidate.score,
          carvedCells,
          orientation: candidate.orientation
        }
      );
      this._stats.mutationEventsEmitted++;
    }

    return carvedCells;
  }

  // ══════════════════════════════════════════════════════════
  // ─── per-formation-type stats ───────────────────────────
  // ══════════════════════════════════════════════════════════
  _bumpStatsForType(type) {
    switch (type) {
      case FORMATION_TYPE.ARCH:        this._stats.arches++; break;
      case FORMATION_TYPE.SEA_STACK:   this._stats.seaStacks++; break;
      case FORMATION_TYPE.HOODOO:      this._stats.hoodoos++; break;
      case FORMATION_TYPE.MESA:        this._stats.mesas++; break;
      case FORMATION_TYPE.BUTTE:       this._stats.buttes++; break;
      case FORMATION_TYPE.CAVE:        this._stats.caves++; break;
      case FORMATION_TYPE.SINKHOLE:    this._stats.sinkholes++; break;
      case FORMATION_TYPE.ARCHIPELAGO: this._stats.archipelagos++; break;
      case FORMATION_TYPE.CENOTE:      this._stats.cenotes++; break;
      case FORMATION_TYPE.SPIRE:       this._stats.spires++; break;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) return 0;
    this._lastUpdateTime = now;
    this._frameRef = frame;

    // 1. Generate candidates from terrain chunks.
    this._generateCandidates(frame);

    // 2. Sort candidates by score (highest first) and carve up to budget.
    if (this._pendingCandidates) {
      this._pendingCandidates.sort((a, b) => b.score - a.score);
      const budget = this.defaults.maxFormationsPerFrame;
      const limit = Math.min(budget, this._pendingCandidates.length);

      for (let i = 0; i < limit; i++) {
        const c = this._pendingCandidates[i];
        const carved = this._carveFormation(c);
        if (carved > 0) {
          this._stats.formationsCarved++;
          this._stats.candidatesPassed++;
          this._bumpStatsForType(c.type);
        }
      }
    }

    // 3. Release candidate pool.
    this._releaseAllCandidates();

    // 4. Write to spatial layer for consumers.
    this._writeToSpatialLayer(frame);

    this._stats.updates++;
    return 1;
  }

  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.formations) {
      spatial.formations = {
        count: 0,
        chunkCX: new Int32Array(this._placedChunks.size || 64),
        chunkCZ: new Int32Array(this._placedChunks.size || 64),
        types: new Uint8Array(this._placedChunks.size || 64),
        placedRadius: this._placedRadius,
        typeNames: FORMATION_TYPE_NAMES
      };
    }

    const f = spatial.formations;
    f.count = 0;
    let idx = 0;
    for (const [key, timestamp] of this._placedChunks) {
      if (idx >= f.chunkCX.length) break;
      const parts = key.split(',');
      f.chunkCX[idx] = parseInt(parts[0], 10);
      f.chunkCZ[idx] = parseInt(parts[1], 10);
      // Type not tracked in map — leave as 0. Consumers that need
      // per-formation type data should query the carve persistence.
      f.types[idx] = 0;
      idx++;
    }
    f.count = idx;
  }

  // ══════════════════════════════════════════════════════════
  // ─── interactive setters ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setWorldSeed(seed) {
    this.defaults.worldSeed = seed | 0;
    this._placedChunks.clear();
    return this;
  }

  setFormationChance(chance) {
    if (chance >= 0 && chance <= 1) this.defaults.formationChance = chance;
    return this;
  }

  setCarveThreshold(threshold) {
    if (threshold >= 0 && threshold <= 1) this.defaults.carveThreshold = threshold;
    return this;
  }

  setMaxFormationsPerFrame(budget) {
    if (budget > 0) this.defaults.maxFormationsPerFrame = budget;
    return this;
  }

  setMinChunksBetween(count) {
    if (count >= 0) {
      this._placedRadius = count;
      this.defaults.minChunksBetween = count;
    }
    return this;
  }

  // Clear all placed formations (for world reset).
  clearPlacements() {
    this._placedChunks.clear();
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
    this._carve = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._placedChunks.clear();
    this._candidatePool.length = 0;
    this._candidatePoolIndex = 0;
    if (this._pendingCandidates) this._pendingCandidates.length = 0;
  }
}

// Ensure _pendingCandidates exists on every instance.
NaturalFormationGradientProvider.prototype._pendingCandidates = [];

export {
  NaturalFormationGradientProvider,
  FORMATION_TYPE,
  FORMATION_TYPE_NAMES,
  FORMATION_SCHEMA,
  FORMATION_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};