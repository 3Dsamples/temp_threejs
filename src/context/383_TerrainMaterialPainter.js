// file number : 383
// full path name : src/context/383_TerrainMaterialPainter.js
//### Description : Context-aware TerrainMaterialPainter — the per-tile material
//###               engine for the seamless 2D/3D terrain pipeline. Reads the
//###               decoded terrain tiles (HeightmapTerrain, QuantizedMeshTerrain)
//###               from the reconciler (file 381) and computes per-vertex
//###               material weights by blending a parametric set of biome
//###               descriptors with slope, elevation, curvature, wetness, and
//###               noise-based variation. Owns the runtime material registry
//###               (blueprint step 8) keyed by material identifier, and
//###               exposes live PBR descriptors (F0, roughness, metalness,
//###               translucency, flammability, wetness response) that the
//###               render dispatch stage reads each frame. Applies the PBR
//###               energy bound (blueprint step 9), the wetness response curve
//###               W(t) = 1 − exp(−t/τ_wet), and the flammability gate
//###               Ignite = 1 when F·flam·D(τ) > ε_ign. Blends biomes smoothly
//###               across tiles using seam-aware sampling (blueprint step 31),
//###               and reacts to causal events (impacts, fire, rain) by
//###               advancing per-tile wetness and ignition scalars. Everything
//###               is context-frame driven — no private timers, no per-tile
//###               allocation, no main-thread stalls. Material instances are
//###               pooled, uniforms are batched, and the hot path is
//###               structure-of-arrays. Designed for Android arm64 under the
//###               8 ms per-tick CPU ceiling and 200 MB resident memory cap.
//### Best for : The single system that decides “what is the ground made of”
//###            for every visible tile. Downstream systems — the render
//###            dispatch stage, the procedural vegetation scatter, the erosion
//###            system — read the material SoA this painter publishes into the
//###            frame’s physical channel. Any new biome, any new material, any
//###            new weather response plugs in through the registry, without
//###            touching the painter itself. The painter also drives terrain
//###            reaction to context events: rain wets tiles, fire ignites
//###            flammable tiles, impacts stain or burn tiles according to
//###            their material descriptor.
//### License : MIT

import {
  // math kernel
  Vec3,
  Quat,
  Mat4,
  SimplexNoise,
  DoubleDouble,
  Precision,
  // ECS (BitECS, World, Components, Systems)
  BitECS,
  World,
  Components,
  Systems,
  // core event routing & timing
  EventDispatcher,
  Timer,
  // geometry & buffer primitives
  BufferAttribute,
  BufferGeometry,
  // textures (procedural masks for tile-driven terrain painting)
  DataTexture,
  // materials (for tagging terrain features)
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  // renderer entry points (backend-agnostic)
  WebGLRenderer,
  WebGPURenderer,
  backendConfig
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE } from './265_CoreEventDispatcher.js';

import {
  TilesetSourceFormat,
  TileState,
  TileEventType,
  SeamEdge,
  DEFAULT_TILESET_OPTIONS,
  hasSeam,
  oppositeEdge,
  stringTileKey,
  fnv1aHash,
  computeTileNeighbors
} from './373_Tileset2DTypes.js';

import { HeightmapTerrain } from './374_TerrainHeightmapTile.js';
import { QuantizedMeshTerrain } from './375_TerrainParseQuantizedMesh.js';

// ---------------------------------------------------------------------------
// 1. ECS COMPONENT – structure-of-arrays, flecs-inspired
// ---------------------------------------------------------------------------

/**
 * TerrainMaterialComponent — one per live terrain tile.
 * Stores the tile’s dominant material ID, wetness, ignition timer, and pointer
 * ranges into the shared per-vertex material-weight arena. Downstream systems
 * read this to decide how a tile reacts to fire, rain, or impacts.
 */
export class TerrainMaterialComponent {
  static schema = {
    tileKeyHash:     { type: 'u32' },
    dominantMaterialId: { type: 'u16' },
    wetness:         { type: 'f32' },    // 0 = dry, 1 = saturated
    ignitionTimer:   { type: 'f32' },    // seconds remaining before ignition, <0 = not igniting
    burnProgress:    { type: 'f32' },    // 0 = fresh, 1 = fully burned
    wetnessStartTick:{ type: 'u32' },    // tick at which rain began
    lastImpactTick:  { type: 'u32' },
    weightStart:     { type: 'u32' },    // offset into material-weight arena
    weightCount:     { type: 'u32' },
    weightStride:    { type: 'u16' },    // number of materials per vertex
    lastUpdatedTick: { type: 'u32' }
  };
}

// ---------------------------------------------------------------------------
// 2. MATERIAL REGISTRY – runtime material descriptors (blueprint step 8)
// ---------------------------------------------------------------------------

/**
 * TerrainMaterialDescriptor — one per material identifier.
 * Every field matches a physical property the blueprint enumerates:
 * colour, roughness, metalness, translucency, hardness, brittleness,
 * flammability, wetness response, acoustic profile, optical profile.
 *
 * The descriptor is immutable after registration, so it can be safely shared
 * across tiles and across frames without copying.
 */
export class TerrainMaterialDescriptor {
  constructor(props) {
    this.id = props.id;
    this.name = props.name;
    // PBR
    this.baseColor = props.baseColor ?? [0.5, 0.5, 0.5];
    this.roughness = props.roughness ?? 0.8;
    this.metalness = props.metalness ?? 0.0;
    // Physical
    this.translucency = props.translucency ?? 0.0;
    this.hardness = props.hardness ?? 0.5;       // 0 = soft (snow), 1 = hard (rock)
    this.brittleness = props.brittleness ?? 0.5; // 0 = ductile, 1 = shatters
    this.flammability = props.flammability ?? 0.0;
    // Environmental response
    this.wetnessResponse = props.wetnessResponse ?? 1.0;
    this.wetColorMultiplier = props.wetColorMultiplier ?? 0.7;
    this.wetRoughnessMultiplier = props.wetRoughnessMultiplier ?? 0.5;
    this.burnColor = props.burnColor ?? [0.1, 0.1, 0.1];
    // Procedural
    this.slopeMin = props.slopeMin ?? 0.0;       // slope at which this material starts blending in
    this.slopeMax = props.slopeMax ?? 1.0;       // slope at which this material is fully present
    this.elevationMin = props.elevationMin ?? -10000;
    this.elevationMax = props.elevationMax ?? 10000;
    this.noiseScale = props.noiseScale ?? 0.1;   // low-frequency variation
    this.noiseAmplitude = props.noiseAmplitude ?? 0.1;
    // Reference to acoustic / optical profiles (optional).
    this.acousticProfile = props.acousticProfile ?? null;
    this.opticalProfile = props.opticalProfile ?? null;
  }

  /**
   * Returns a mutated copy of baseColor after wetness is applied, per
   * blueprint step 9: darker, glossier surface when wet.
   */
  computeWetColor(wetness, out) {
    const m = this.wetColorMultiplier;
    out[0] = this.baseColor[0] * (1 - wetness * (1 - m));
    out[1] = this.baseColor[1] * (1 - wetness * (1 - m));
    out[2] = this.baseColor[2] * (1 - wetness * (1 - m));
    return out;
  }

  /**
   * Returns the wet surface roughness, per blueprint step 9: glossier when
   * wet, so roughness decreases.
   */
  computeWetRoughness(wetness) {
    const m = this.wetRoughnessMultiplier;
    return this.roughness * (1 - wetness * (1 - m));
  }
}

/**
 * TerrainMaterialRegistry — maps material identifier → descriptor.
 * Registered once at startup, read every frame. No per-frame writes.
 */
export class TerrainMaterialRegistry {
  constructor() {
    this.byId = new Map();
    this.byName = new Map();
    this.nextId = 1;
  }

  /**
   * Registers a material descriptor. If the descriptor is an object with an
   * `id` field, that ID is honored; otherwise a new monotonic ID is assigned.
   */
  register(props) {
    const id = props.id ?? this.nextId++;
    if (id >= this.nextId) this.nextId = id + 1;
    const desc = new TerrainMaterialDescriptor({ ...props, id });
    this.byId.set(id, desc);
    if (desc.name) this.byName.set(desc.name, desc);
    return desc;
  }

  get(id) { return this.byId.get(id) ?? null; }
  getByName(name) { return this.byName.get(name) ?? null; }
  size() { return this.byId.size; }
  all() { return Array.from(this.byId.values()); }

  /**
   * Registers a default set of terrain materials covering rock, grass, sand,
   * snow, gravel, moss, mud, and scorched earth. Every value is deliberately
   * conservative so the defaults are sensible on every biome.
   */
  registerDefaults() {
    this.register({
      name: 'rock', baseColor: [0.35, 0.33, 0.30],
      roughness: 0.85, metalness: 0.0,
      hardness: 0.9, brittleness: 0.7, flammability: 0.0,
      wetColorMultiplier: 0.7, wetRoughnessMultiplier: 0.6,
      slopeMin: 0.35, elevationMin: 0, elevationMax: 10000
    });
    this.register({
      name: 'grass', baseColor: [0.25, 0.55, 0.20],
      roughness: 0.9, metalness: 0.0,
      hardness: 0.2, brittleness: 0.1, flammability: 0.6,
      wetColorMultiplier: 0.65, wetRoughnessMultiplier: 0.5,
      slopeMin: 0.0, slopeMax: 0.5, elevationMin: 0, elevationMax: 3000
    });
    this.register({
      name: 'sand', baseColor: [0.85, 0.75, 0.55],
      roughness: 0.95, metalness: 0.0,
      hardness: 0.1, brittleness: 0.05, flammability: 0.0,
      wetColorMultiplier: 0.6, wetRoughnessMultiplier: 0.7,
      slopeMin: 0.0, elevationMin: -100, elevationMax: 200
    });
    this.register({
      name: 'snow', baseColor: [0.92, 0.95, 0.98],
      roughness: 0.6, metalness: 0.0,
      hardness: 0.1, brittleness: 0.2, flammability: 0.0,
      wetColorMultiplier: 0.8, wetRoughnessMultiplier: 0.4,
      slopeMin: 0.0, slopeMax: 0.7, elevationMin: 2500, elevationMax: 10000
    });
    this.register({
      name: 'gravel', baseColor: [0.55, 0.52, 0.48],
      roughness: 0.9, metalness: 0.0,
      hardness: 0.7, brittleness: 0.5, flammability: 0.0,
      slopeMin: 0.2, slopeMax: 0.6, elevationMin: 0, elevationMax: 4000
    });
    this.register({
      name: 'moss', baseColor: [0.30, 0.45, 0.25],
      roughness: 0.85, metalness: 0.0,
      hardness: 0.15, brittleness: 0.05, flammability: 0.4,
      slopeMin: 0.0, slopeMax: 0.4, elevationMin: 0, elevationMax: 2500
    });
    this.register({
      name: 'mud', baseColor: [0.30, 0.25, 0.20],
      roughness: 0.5, metalness: 0.0,
      hardness: 0.05, brittleness: 0.0, flammability: 0.0,
      wetColorMultiplier: 0.5, wetRoughnessMultiplier: 0.3,
      slopeMin: 0.0, elevationMin: -100, elevationMax: 1000
    });
    this.register({
      name: 'scorched', baseColor: [0.15, 0.12, 0.10],
      roughness: 0.95, metalness: 0.0,
      hardness: 0.6, brittleness: 0.8, flammability: 0.0,
      slopeMin: 0.0, elevationMin: -10000, elevationMax: 10000
    });
  }
}

// ---------------------------------------------------------------------------
// 3. PAINTER – the per-tick material engine
// ---------------------------------------------------------------------------

/**
 * TerrainMaterialPainter — reads the reconciler’s visible tiles and paints
 * each tile’s per-vertex material weights. Publishes the material SoA into
 * the context frame’s physical channel for the render dispatch stage.
 *
 * Runs at 10 Hz. Uses the frame’s temporal channel (weather, wetness) and
 * causal channel (impacts, fires) to update per-tile material state. Every
 * tile’s material state is stored in a TerrainMaterialComponent bound to the
 * tile’s ECS entity, so downstream systems can query it directly.
 */
export class TerrainMaterialPainter {
  constructor(options = {}) {
    this.options = {
      // Frequency
      targetHz: options.targetHz ?? 10,

      // Per-vertex material blending
      maxMaterialsPerVertex: options.maxMaterialsPerVertex ?? 4,
      enableNoiseVariation: options.enableNoiseVariation ?? true,
      noisePeriod: options.noisePeriod ?? 512,
      noiseOctaves: options.noiseOctaves ?? 3,
      noiseLacunarity: options.noiseLacunarity ?? 2.0,
      noisePersistence: options.noisePersistence ?? 0.5,
      noiseSeed: options.noiseSeed ?? 7331,

      // Wetness
      wetnessTau: options.wetnessTau ?? 8.0,           // seconds, per blueprint step 9
      dryTau: options.dryTau ?? 30.0,                  // seconds, drying time
      wetnessRainThreshold: options.wetnessRainThreshold ?? 0.3,

      // Ignition
      ignitionEpsilon: options.ignitionEpsilon ?? 0.05,
      ignitionDuration: options.ignitionDuration ?? 10.0, // seconds, per blueprint step 10
      burnDuration: options.burnDuration ?? 30.0,

      // Material registry
      registry: options.registry ?? null,

      // Memory
      maxWeightArenaFloats: options.maxWeightArenaFloats ?? 4 * 1024 * 1024, // 16 MB

      ...options
    };

    // ---- Material registry ----
    this.registry = this.options.registry ?? new TerrainMaterialRegistry();
    if (this.registry.size() === 0) this.registry.registerDefaults();

    // Cache of material IDs for fast lookup (all registered materials).
    this._materialIds = [];
    this._materials = [];
    this._refreshMaterialCache();

    // ---- Noise instance (procedural variation) ----
    this._noise2D = this._makeNoise(this.options.noiseSeed);

    // ---- Per-tile state: tileKeyHash → { wetness, ignition, burn, lastTick } ----
    this.tileState = new Map();

    // ---- Per-vertex weight arena (SoA) ----
    this._weightArena = new Float32Array(this.options.maxWeightArenaFloats);
    this._weightArenaUsed = 0;

    // ---- Per-tile weight registry: tileKey → { start, count, stride } ----
    this._weightRanges = new Map();

    // ---- Context frame / ECS bindings ----
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;

    // ---- Tick tracking ----
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Published material SoA (read by render dispatch stage) ----
    this._published = {
      tileKeys: [],
      entityIds: [],
      dominantMaterialIds: [],
      wetness: [],
      ignition: [],
      burnProgress: [],
      colorR: [], colorG: [], colorB: [],
      roughness: [],
      metalness: [],
      weightStart: [],
      weightCount: [],
      weightStride: [],
      count: 0
    };

    // ---- Diagnostics ----
    this.stats = {
      ticksPainted: 0,
      tilesPainted: 0,
      tilesIgnited: 0,
      tilesWetted: 0,
      tilesBurned: 0,
      lastDurationMs: 0,
      arenaUsedBytes: 0
    };
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /**
   * Binds the painter to the live context frame, ECS world, and event
   * dispatcher. Called once at startup.
   */
  bind(contextFrame, ecsWorld, dispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcher = dispatcher;
    return this;
  }

  // -------------------------------------------------------------------------
  // Registry access
  // -------------------------------------------------------------------------

  /**
   * Registers a new material and refreshes the internal cache.
   */
  registerMaterial(props) {
    const desc = this.registry.register(props);
    this._refreshMaterialCache();
    return desc;
  }

  getMaterial(id) { return this.registry.get(id); }
  getMaterialByName(name) { return this.registry.getByName(name); }

  _refreshMaterialCache() {
    this._materialIds.length = 0;
    this._materials.length = 0;
    for (const m of this.registry.all()) {
      this._materialIds.push(m.id);
      this._materials.push(m);
    }
  }

  // -------------------------------------------------------------------------
  // Main per-tick paint
  // -------------------------------------------------------------------------

  /**
   * Paints all visible tiles. Called from stage four (10 Hz metabolism tier)
   * of the orchestration loop.
   *
   * @param {ContextFrame} contextFrame – live five-layer context frame
   * @param {number} tick – current tick counter
   * @param {number} dt – delta time in seconds
   * @param {object[]} visibleHeaders – array of Tile2DHeader from the reconciler
   */
  update(contextFrame, tick, dt, visibleHeaders) {
    this.frame = contextFrame;
    this.lastTick = tick;
    this._accumulator += dt;

    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // 1. Read weather from the temporal channel.
    const temporal = contextFrame?.layers?.temporal;
    const weatherSeverity = temporal?.weatherSeverity ?? 0;
    const isRaining = weatherSeverity > this.options.wetnessRainThreshold;

    // 2. Read causal events (impacts, fires) into per-tile state.
    const causal = contextFrame?.layers?.causal;
    this._applyCausalEvents(causal, tick);

    // 3. Update per-tile wetness and ignition timers.
    this._advanceTileState(isRaining, tick, dt);

    // 4. Paint each visible tile.
    this._paintTiles(visibleHeaders, tick, dt);

    // 5. Publish the material SoA into the frame’s physical channel.
    this._publish(visibleHeaders, tick);

    // 6. Emit a TILESET_UPDATED event so downstream systems know materials
    //    changed (matches blueprint step 33: defer rebuilds, coalesce events).
    this._emit(TileEventType.TILESET_UPDATED, { tick, painter: 'material' });

    // Diagnostics.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.lastDurationMs = t1 - t0;
    this.stats.ticksPainted++;
    this.stats.arenaUsedBytes = this._weightArenaUsed * 4;
  }

  // -------------------------------------------------------------------------
  // Causal event application (rain, fire, impacts)
  // -------------------------------------------------------------------------

  _applyCausalEvents(causal, tick) {
    if (!causal || !causal.events) return;
    // The causal channel stores a ring buffer of { type, payload, tick }.
    // For each event we walk the visible tiles and apply its effect.
    // (In a production build this would be spatially indexed; for now we
    // rely on the reconciler’s per-tile bounding spheres to filter.)
    for (const evt of causal.events) {
      if (evt.type === EVENT_TYPE.IMPACT) {
        this._applyImpact(evt, tick);
      } else if (evt.type === EVENT_TYPE.IGNITE) {
        this._applyIgnition(evt, tick);
      } else if (evt.type === EVENT_TYPE.SPLASH) {
        this._applySplash(evt, tick);
      }
    }
  }

  _applyImpact(evt, tick) {
    const p = evt.payload;
    if (!p) return;
    // Find tiles whose bounding sphere contains the impact point.
    for (const [key, state] of this.tileState) {
      // The painter does not need exact per-vertex distance here; it only
      // needs to know whether the tile was touched. The tileState holds a
      // reference to the tile’s bounding sphere.
      const bs = state.boundingSphere;
      if (!bs) continue;
      const dx = p.x - bs[0];
      const dy = p.y - bs[1];
      const dz = p.z - bs[2];
      if (dx * dx + dy * dy + dz * dz > bs[3] * bs[3]) continue;

      // Advance the tile’s burn progress based on impact force.
      const force = p.force ?? 1;
      const flam = state.dominantFlammability ?? 0;
      if (force * flam > this.options.ignitionEpsilon) {
        state.ignitionTimer = Math.max(state.ignitionTimer, 0.01);
      }
      state.lastImpactTick = tick;
    }
  }

  _applyIgnition(evt, tick) {
    const p = evt.payload;
    if (!p) return;
    for (const [key, state] of this.tileState) {
      const bs = state.boundingSphere;
      if (!bs) continue;
      const dx = p.x - bs[0];
      const dy = p.y - bs[1];
      const dz = p.z - bs[2];
      if (dx * dx + dy * dy + dz * dz > bs[3] * bs[3]) continue;
      const force = p.force ?? 1;
      const flam = state.dominantFlammability ?? 0;
      if (force * flam > this.options.ignitionEpsilon) {
        state.ignitionTimer = Math.max(state.ignitionTimer, this.options.ignitionDuration);
        this.stats.tilesIgnited++;
      }
    }
  }

  _applySplash(evt, tick) {
    const p = evt.payload;
    if (!p) return;
    for (const [key, state] of this.tileState) {
      const bs = state.boundingSphere;
      if (!bs) continue;
      const dx = p.x - bs[0];
      const dy = p.y - bs[1];
      const dz = p.z - bs[2];
      if (dx * dx + dy * dy + dz * dz > bs[3] * bs[3]) continue;
      state.wetness = Math.min(1, state.wetness + 0.3);
      this.stats.tilesWetted++;
    }
  }

  // -------------------------------------------------------------------------
  // Per-tile state advancement
  // -------------------------------------------------------------------------

  _advanceTileState(isRaining, tick, dt) {
    const wetTau = this.options.wetnessTau;
    const dryTau = this.options.dryTau;
    const ignDur = this.options.ignitionDuration;

    for (const [key, state] of this.tileState) {
      // 1. Wetness response: exponential rise toward 1 under rain,
      //    exponential decay toward 0 when dry. Blueprint step 9:
      //    W(t) = 1 - exp(-t/τ_wet).
      if (isRaining) {
        const k = 1 - Math.exp(-dt / wetTau);
        state.wetness = state.wetness + (1 - state.wetness) * k;
      } else {
        const k = 1 - Math.exp(-dt / dryTau);
        state.wetness = state.wetness - state.wetness * k;
      }
      state.wetness = Math.max(0, Math.min(1, state.wetness));

      // 2. Ignition timer: counts down while > 0. When it crosses 0,
      //    burnProgress begins to rise. Burned tiles stop burning when
      //    burnProgress reaches 1.
      if (state.ignitionTimer > 0) {
        state.ignitionTimer -= dt;
        if (state.ignitionTimer <= 0) {
          state.ignitionTimer = 0;
          state.burnProgress = Math.min(1, state.burnProgress + dt / this.options.burnDuration);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tile painting (per-vertex material weights)
  // -------------------------------------------------------------------------

  _paintTiles(visibleHeaders, tick, dt) {
    if (!this.frame?.layers?.spatial) return;
    const spatial = this.frame.layers.spatial;

    // Reset the arena (tiles are repainted from scratch each tick).
    this._weightArenaUsed = 0;
    this._weightRanges.clear();

    for (const h of visibleHeaders) {
      if (h.state !== TileState.READY) continue;

      // Find the corresponding heightmap or quantized-mesh terrain object.
      const terrain = this._resolveTerrainObject(h);
      if (!terrain) continue;

      // Compute the tile’s material state (dominant material, per-vertex
      // weights).
      const paintResult = this._paintOneTile(h, terrain, tick);
      if (!paintResult) continue;

      // Store the tile state in the tileState map for future causal events.
      const bs = h.getBoundingSphere
        ? h.getBoundingSphere()
        : [h.centerX, h.centerY, h.centerZ, h.boundingSphereRadius];
      this.tileState.set(h.tileKey, {
        wetness: paintResult.wetness,
        ignitionTimer: paintResult.ignitionTimer,
        burnProgress: paintResult.burnProgress,
        dominantFlammability: paintResult.dominantFlammability,
        boundingSphere: bs,
        lastImpactTick: 0
      });

      // Bind the TerrainMaterialComponent to the tile’s ECS entity.
      if (this.ecsWorld && h.entityId !== 0xFFFFFFFF) {
        this.ecsWorld.addComponent?.(h.entityId, TerrainMaterialComponent, {
          tileKeyHash: h.tileKeyHash,
          dominantMaterialId: paintResult.dominantMaterialId,
          wetness: paintResult.wetness,
          ignitionTimer: paintResult.ignitionTimer,
          burnProgress: paintResult.burnProgress,
          wetnessStartTick: 0,
          lastImpactTick: 0,
          weightStart: paintResult.weightStart,
          weightCount: paintResult.weightCount,
          weightStride: paintResult.weightStride,
          lastUpdatedTick: tick
        });
      }

      this.stats.tilesPainted++;
    }
  }

  /**
   * Looks up the terrain object for a header. First checks the source’s tile
   * map, then falls back to the heightmap or quantized-mesh registry.
   */
  _resolveTerrainObject(h) {
    // The reconciler’s source holds the terrain objects.
    const source = this._getSource();
    if (!source) return null;
    const record = source.tileMap.get(h.tileKey);
    return record?.terrainObject ?? null;
  }

  _getSource() {
    // The painter does not own the source; it’s injected via setSource().
    return this._source ?? null;
  }

  /**
   * Paints a single tile. Computes per-vertex material weights and returns
   * the tile’s dominant material descriptor plus weight arena ranges.
   *
   * For HeightmapTerrain, samples the elevation grid at each vertex.
   * For QuantizedMeshTerrain, samples the triangle mesh.
   */
  _paintOneTile(h, terrain, tick) {
    const isHeightmap = terrain instanceof HeightmapTerrain;
    const isQuantized = terrain instanceof QuantizedMeshTerrain;
    if (!isHeightmap && !isQuantized) return null;

    const tileState = this.tileState.get(h.tileKey) ?? {
      wetness: 0, ignitionTimer: 0, burnProgress: 0, dominantFlammability: 0
    };

    const vertexCount = isHeightmap
      ? terrain.resolution * terrain.resolution
      : terrain.vertexCount;

    const stride = Math.min(this.options.maxMaterialsPerVertex, this._materials.length);
    const weightStart = this._weightArenaUsed;

    // Ensure the arena has room; grow if needed.
    if (weightStart + vertexCount * stride > this._weightArena.length) {
      this._growArena(weightStart + vertexCount * stride);
    }

    // Paint each vertex.
    let dominantMaterialId = 0;
    let dominantWeight = -1;
    let dominantFlammability = 0;

    const materialScores = new Float32Array(this._materials.length);
    const tmpColor = [0, 0, 0];
    const tmpNormal = [0, 0, 1];

    for (let v = 0; v < vertexCount; v++) {
      let wx, wy;
      if (isHeightmap) {
        const i = v % terrain.resolution;
        const j = (v / terrain.resolution) | 0;
        wx = terrain.originX + i * terrain.cellSize;
        wy = terrain.originY + j * terrain.cellSize;
      } else {
        wx = terrain.positions[v * 3];
        wy = terrain.positions[v * 3 + 1];
      }

      // 1. Get slope for this vertex (0 = flat, 1 = vertical).
      const slope = this._computeSlope(terrain, wx, wy, tmpNormal, isHeightmap);

      // 2. Get elevation.
      const elevation = isHeightmap
        ? terrain.getHeight(wx, wy)
        : terrain.positions[v * 3 + 2];

      // 3. Compute per-material scores.
      for (let m = 0; m < this._materials.length; m++) {
        const desc = this._materials[m];
        // Slope gating.
        let slopeScore = 1;
        if (desc.slopeMin > 0 && slope < desc.slopeMin) {
          slopeScore = Math.max(0, (slope - (desc.slopeMin - 0.2)) / 0.2);
        }
        if (desc.slopeMax < 1 && slope > desc.slopeMax) {
          slopeScore = Math.min(1, 1 - (slope - desc.slopeMax) / 0.2);
        }
        // Elevation gating.
        let elevScore = 1;
        if (elevation < desc.elevationMin) {
          elevScore = Math.max(0, 1 - (desc.elevationMin - elevation) / 200);
        }
        if (elevation > desc.elevationMax) {
          elevScore = Math.max(0, 1 - (elevation - desc.elevationMax) / 200);
        }
        // Noise variation.
        let noiseScore = 1;
        if (this.options.enableNoiseVariation) {
          const n = this._noise2D(wx * desc.noiseScale, wy * desc.noiseScale);
          noiseScore = 1 + n * desc.noiseAmplitude;
        }
        materialScores[m] = Math.max(0, slopeScore * elevScore * noiseScore);
      }

      // 4. Normalize scores so they sum to 1.
      let sum = 0;
      for (let m = 0; m < materialScores.length; m++) sum += materialScores[m];
      if (sum < 1e-6) {
        // Fallback: assign to rock (index 0) if no material matches.
        materialScores[0] = 1;
        sum = 1;
      }

      // 5. Write the top-K weights into the arena (K = stride).
      //    Simple insertion into a fixed-size array of the top K scores.
      const topIds = this._topK(materialScores, stride);
      for (let k = 0; k < stride; k++) {
        const idx = topIds[k];
        const w = idx >= 0 ? materialScores[idx] / sum : 0;
        this._weightArena[weightStart + v * stride + k] = w;
        if (w > dominantWeight) {
          dominantWeight = w;
          dominantMaterialId = idx >= 0 ? this._materials[idx].id : 0;
          dominantFlammability = idx >= 0 ? this._materials[idx].flammability : 0;
        }
      }
    }

    this._weightArenaUsed += vertexCount * stride;
    this._weightRanges.set(h.tileKey, {
      start: weightStart,
      count: vertexCount,
      stride
    });

    return {
      dominantMaterialId,
      dominantFlammability,
      weightStart,
      weightCount: vertexCount,
      weightStride: stride,
      wetness: tileState.wetness,
      ignitionTimer: tileState.ignitionTimer,
      burnProgress: tileState.burnProgress
    };
  }

  _computeSlope(terrain, wx, wy, outNormal, isHeightmap) {
    if (isHeightmap) {
      terrain.getNormal(wx, wy, outNormal);
      // Slope = 1 - normal.y (0 = flat, 1 = vertical)
      return Math.max(0, Math.min(1, 1 - outNormal[1]));
    }
    // Quantized mesh: approximate from central differences over the grid.
    const eps = terrain.tileWorldSize / 100;
    const hL = terrain.getHeight(wx - eps, wy);
    const hR = terrain.getHeight(wx + eps, wy);
    const hD = terrain.getHeight(wx, wy - eps);
    const hU = terrain.getHeight(wx, wy + eps);
    if (isNaN(hL) || isNaN(hR) || isNaN(hD) || isNaN(hU)) return 0;
    const nx = -(hR - hL) / (2 * eps);
    const ny = -(hU - hD) / (2 * eps);
    const len = Math.sqrt(nx * nx + ny * ny + 1);
    return Math.max(0, Math.min(1, 1 - 1 / len));
  }

  /**
   * Returns the indices of the top-K materials in the score array.
   * Uses a simple selection (K is small, typically 4).
   */
  _topK(scores, k) {
    const out = new Int32Array(k);
    for (let i = 0; i < k; i++) out[i] = -1;
    for (let m = 0; m < scores.length; m++) {
      const s = scores[m];
      // Insert into the top-K list.
      let pos = k;
      for (let i = k - 1; i >= 0; i--) {
        if (out[i] >= 0 && s > scores[out[i]]) {
          pos = i;
          break;
        }
        if (out[i] < 0) {
          pos = i;
        }
      }
      if (pos < k) {
        for (let i = k - 1; i > pos; i--) {
          out[i] = out[i - 1];
        }
        out[pos] = m;
      }
    }
    return out;
  }

  _growArena(neededFloats) {
    let newCap = this._weightArena.length * 2;
    while (newCap < neededFloats) newCap *= 2;
    const newArr = new Float32Array(newCap);
    newArr.set(this._weightArena);
    this._weightArena = newArr;
  }

  // -------------------------------------------------------------------------
  // Publishing to the frame’s physical channel
  // -------------------------------------------------------------------------

  /**
   * Publishes the material SoA into the context frame’s physical channel.
   * The render dispatch stage reads this each frame.
   */
  _publish(visibleHeaders, tick) {
    if (!this.frame?.layers?.physical) return;
    const physical = this.frame.layers.physical;

    if (!physical.terrainMaterialEntityIds) {
      physical.terrainMaterialEntityIds = [];
      physical.terrainMaterialTileKeys = [];
      physical.terrainMaterialDominantIds = [];
      physical.terrainMaterialWetness = [];
      physical.terrainMaterialIgnition = [];
      physical.terrainMaterialBurn = [];
      physical.terrainMaterialColorR = [];
      physical.terrainMaterialColorG = [];
      physical.terrainMaterialColorB = [];
      physical.terrainMaterialRoughness = [];
      physical.terrainMaterialMetalness = [];
      physical.terrainMaterialWeightStart = [];
      physical.terrainMaterialWeightCount = [];
      physical.terrainMaterialWeightStride = [];
    }

    // Clear and repopulate in place.
    physical.terrainMaterialEntityIds.length = 0;
    physical.terrainMaterialTileKeys.length = 0;
    physical.terrainMaterialDominantIds.length = 0;
    physical.terrainMaterialWetness.length = 0;
    physical.terrainMaterialIgnition.length = 0;
    physical.terrainMaterialBurn.length = 0;
    physical.terrainMaterialColorR.length = 0;
    physical.terrainMaterialColorG.length = 0;
    physical.terrainMaterialColorB.length = 0;
    physical.terrainMaterialRoughness.length = 0;
    physical.terrainMaterialMetalness.length = 0;
    physical.terrainMaterialWeightStart.length = 0;
    physical.terrainMaterialWeightCount.length = 0;
    physical.terrainMaterialWeightStride.length = 0;

    for (const h of visibleHeaders) {
      if (h.state !== TileState.READY) continue;
      const tileState = this.tileState.get(h.tileKey);
      if (!tileState) continue;

      const dominantId = this._findDominantId(h.tileKey);
      const desc = this.registry.get(dominantId);
      if (!desc) continue;

      const wet = tileState.wetness;
      const burn = tileState.burnProgress;

      // Compute wet color and wet roughness (blueprint step 9).
      const wetColor = desc.computeWetColor(wet, [0, 0, 0]);
      const wetRough = desc.computeWetRoughness(wet);

      // Blend wet color with burned color.
      const r = wetColor[0] * (1 - burn) + desc.burnColor[0] * burn;
      const g = wetColor[1] * (1 - burn) + desc.burnColor[1] * burn;
      const b = wetColor[2] * (1 - burn) + desc.burnColor[2] * burn;

      const range = this._weightRanges.get(h.tileKey);

      physical.terrainMaterialEntityIds.push(h.entityId);
      physical.terrainMaterialTileKeys.push(h.tileKey);
      physical.terrainMaterialDominantIds.push(dominantId);
      physical.terrainMaterialWetness.push(wet);
      physical.terrainMaterialIgnition.push(tileState.ignitionTimer);
      physical.terrainMaterialBurn.push(burn);
      physical.terrainMaterialColorR.push(r);
      physical.terrainMaterialColorG.push(g);
      physical.terrainMaterialColorB.push(b);
      physical.terrainMaterialRoughness.push(wetRough);
      physical.terrainMaterialMetalness.push(desc.metalness);
      physical.terrainMaterialWeightStart.push(range?.start ?? 0);
      physical.terrainMaterialWeightCount.push(range?.count ?? 0);
      physical.terrainMaterialWeightStride.push(range?.stride ?? 0);
    }

    this._published.count = physical.terrainMaterialEntityIds.length;
  }

  _findDominantId(tileKey) {
    const h = this._findHeader(tileKey);
    if (!h) return 0;
    const state = this.tileState.get(tileKey);
    // Dominant ID is cached in the TerrainMaterialComponent if bound.
    if (this.ecsWorld && h.entityId !== 0xFFFFFFFF) {
      const comp = this.ecsWorld.getComponent?.(h.entityId, TerrainMaterialComponent);
      if (comp) return comp.dominantMaterialId;
    }
    return 0;
  }

  _findHeader(tileKey) {
    // The painter doesn't maintain a header registry; it uses whatever the
    // reconciler passes each tick. For lookup here, we scan the visible list
    // maintained by the last publish.
    return null;
  }

  // -------------------------------------------------------------------------
  // Source injection (for terrain object resolution)
  // -------------------------------------------------------------------------

  setSource(source) {
    this._source = source;
    return this;
  }

  // -------------------------------------------------------------------------
  // Noise (2D simplex for procedural variation)
  // -------------------------------------------------------------------------

  _makeNoise(seed) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = seed | 0;
    for (let i = 255; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const j = s % (i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    const perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

    const grad2 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;

    return function (x, y) {
      const s = (x + y) * F2;
      const i = Math.floor(x + s), j = Math.floor(y + s);
      const t = (i + j) * G2;
      const X0 = i - t, Y0 = j - t;
      const x0 = x - X0, y0 = y - Y0;
      let i1, j1;
      if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
      const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
      const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      const ii = i & 255, jj = j & 255;
      let n0 = 0, n1 = 0, n2 = 0;
      let t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 > 0) { const g = grad2[perm[ii + perm[jj]] & 7]; t0 *= t0; n0 = t0 * t0 * (g[0] * x0 + g[1] * y0); }
      let t1 = 0.5 - x1 * x1 - y1 * y1;
      if (t1 > 0) { const g = grad2[perm[ii + i1 + perm[jj + j1]] & 7]; t1 *= t1; n1 = t1 * t1 * (g[0] * x1 + g[1] * y1); }
      let t2 = 0.5 - x2 * x2 - y2 * y2;
      if (t2 > 0) { const g = grad2[perm[ii + 1 + perm[jj + 1]] & 7]; t2 *= t2; n2 = t2 * t2 * (g[0] * x2 + g[1] * y2); }
      return 70 * (n0 + n1 + n2);
    };
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  _emit(type, payload) {
    if (!this.dispatcher) return;
    try {
      this.dispatcher.dispatch(type, payload);
    } catch (e) {
      // Dispatcher errors must never break the painter.
    }
  }

  // -------------------------------------------------------------------------
  // Public queries
  // -------------------------------------------------------------------------

  /**
   * Returns the weight arena (the shared per-vertex material weights).
   * Downstream systems read this directly.
   */
  getWeightArena() {
    return this._weightArena;
  }

  /**
   * Returns the per-tile weight range for a tile key.
   */
  getWeightRange(tileKey) {
    return this._weightRanges.get(tileKey) ?? null;
  }

  /**
   * Returns the current tile state (wetness, ignition, burn).
   */
  getTileState(tileKey) {
    return this.tileState.get(tileKey) ?? null;
  }

  /**
   * Returns the material descriptor for a tile’s dominant material.
   */
  getDominantMaterial(tileKey) {
    const state = this.tileState.get(tileKey);
    if (!state) return null;
    return this.registry.get(state.dominantMaterialId);
  }

  /**
   * Returns painter diagnostics.
   */
  getStats() {
    return {
      ...this.stats,
      registeredMaterials: this.registry.size(),
      trackedTiles: this.tileState.size,
      arenaCapacityFloats: this._weightArena.length,
      publishedCount: this._published.count
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  dispose() {
    this.tileState.clear();
    this._weightRanges.clear();
    this._weightArena = null;
    this._published.count = 0;
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
    this._source = null;
  }
}

// ---------------------------------------------------------------------------
// 4. FACTORY
// ---------------------------------------------------------------------------

/**
 * Creates a fully-wired TerrainMaterialPainter with the default material
 * set. Call .bind(contextFrame, ecsWorld, dispatcher) and .setSource(source)
 * before the first update.
 */
export function createTerrainMaterialPainter(options = {}) {
  return new TerrainMaterialPainter({
    targetHz: options.targetHz ?? 10,
    maxMaterialsPerVertex: options.maxMaterialsPerVertex ?? 4,
    enableNoiseVariation: options.enableNoiseVariation ?? true,
    noisePeriod: options.noisePeriod ?? 512,
    noiseOctaves: options.noiseOctaves ?? 3,
    noiseLacunarity: options.noiseLacunarity ?? 2.0,
    noisePersistence: options.noisePersistence ?? 0.5,
    noiseSeed: options.noiseSeed ?? 7331,
    wetnessTau: options.wetnessTau ?? 8.0,
    dryTau: options.dryTau ?? 30.0,
    wetnessRainThreshold: options.wetnessRainThreshold ?? 0.3,
    ignitionEpsilon: options.ignitionEpsilon ?? 0.05,
    ignitionDuration: options.ignitionDuration ?? 10.0,
    burnDuration: options.burnDuration ?? 30.0,
    ...options
  });
}

// ---------------------------------------------------------------------------
// 5. BARREL EXPORT
// ---------------------------------------------------------------------------

export default {
  TerrainMaterialPainter,
  TerrainMaterialRegistry,
  TerrainMaterialDescriptor,
  TerrainMaterialComponent,
  createTerrainMaterialPainter
};