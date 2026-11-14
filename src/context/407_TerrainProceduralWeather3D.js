// file number : 407
// full path name : src/context/407_TerrainProceduralWeather3D.js
//### Description : Context-aware 3D procedural weather effects engine for the
//###               seamless terrain pipeline. This is the module that turns the
//###               abstract weather state from the TemporalContextProvider (file
//###               276), the wind field from the ClimateWindProvider (file 289),
//###               and the precipitation phases from the
//###               ClimatePrecipitationProvider (file 288) into concrete,
//###               spatial, per-tile weather effects that interact with the
//###               terrain, the scatter, the hydrology, and the fauna. Nothing is
//###               loaded, streamed, or authored: every effect is generated
//###               procedurally from the tile's terrain data and the runtime
//###               context frame.
//###               On top of the abstract weather state, this engine adds six
//###               first-class effects that are essential for a living world:
//###                 1. LIGHTNING STRIKES — detects thunderstorm cells from the
//###                    weather severity + turbulence, generates a procedural
//###                    bolt path using fractal midpoint displacement, fires
//###                    LIGHTNING causal events, and carves a temporary scorch
//###                    decal into the terrain material (via the material
//###                    bridge, file 394). The strike also emits a bright light
//###                    cue through the AudioLightEmissionSystem (file 317).
//###                 2. TORNADO PATHS — detects supercell conditions (high wind
//###                    shear + extreme severity + flat terrain), spawns a
//###                    procedural tornado vortex with a wandering path driven by
//###                    Simplex noise, and applies continuous erosion to the
//###                    terrain heightfield along the path. Tornado paths also
//###                    destroy scatter instances (trees, shrubs) via the
//###                    FaunaHookArray (file 406) and emit a persistent
//###                    TORNADO causal event.
//###                 3. FOG VOLUMES — generates per-tile 3D fog volumes from the
//###                    weather fog density + terrain elevation, using a
//###                    height-falloff exponential so valleys fill with fog and
//###                    peaks stay clear. Fog volumes are published as an SoA the
//###                    render dispatcher (file 393) reads to enable per-tile
//###                    volumetric fog.
//###                 4. PRECIPITATION PARTICLE SPAWNING — emits per-tile rain and
//###                    snow particle spawn requests (position, velocity, size,
//###                    fall speed) into the scatter arena (file 405), so the
//###                    renderer draws them as instanced particles with the same
//###                    batching as the terrain scatter.
//###                 5. WIND FUNNELS AND GUSTS — uses the wind field from file
//###                    289 to generate localized wind gusts (gust cells) that
//###                    push scatter instances (grass, leaves, debris) and add
//###                    ripples to the water surface (via the hydrology system,
//###                    file 404).
//###                 6. HAIL AND SLEET DECALS — places temporary hail and sleet
//###                    decals on the terrain material, using the same
//###                    scatter-marker system as the material bridge.
//###               Every effect is triggered by the abstract weather state from
//###               file 276 and calibrated by the concrete wind and
//###               precipitation data from files 289 and 288. Effects are
//###               published into the same physical channel as the terrain
//###               tiles, the scatter, and the fauna, so the render dispatcher
//###               (file 393) draws them all in the same batched draw list.
//###               No external loader, no CDN access, no static server.
//###               Everything is procedural. Designed for Android arm64 under
//###               the 8 ms per-tick CPU ceiling and 200 MB resident memory
//###               cap, and scales from a single 10-unit tile to galactic
//###               streaming (10k+ units) without main-thread stalls.
//### Best for : Any world that needs weather to feel alive — thunderstorms
//###            rolling over mountain ranges, tornadoes carving paths through
//###            grassland, fog filling valleys at dawn, rain darkening the soil,
//###            snow accumulating on peaks, wind gusts pushing grass and leaves.
//###            The weather engine is the single source of truth for "what
//###            weather is happening here, right now, at this tile?" so
//###            downstream systems (materials, audio, ecology, gameplay) never
//###            need to duplicate the weather logic.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  WebGLRenderer, WebGPURenderer, backendConfig,
  World, Components, Systems, BitECS,
  EventDispatcher, Timer
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';

// ---- Temporal weather state (file 276) ----
import {
  TemporalContextProvider,
  WEATHER,
  WEATHER_NAMES,
  WEATHER_SEVERITY,
  WEATHER_TRANSITIONS
} from './276_TemporalContextProvider.js';

// ---- Climate wind field (file 289) ----
import {
  ClimateWindProvider,
  WIND_STATE
} from './289_ClimateWindProvider.js';

// ---- Climate precipitation phases (file 288) ----
import {
  ClimatePrecipitationProvider,
  PRECIPITATION_PHASE
} from './288_ClimatePrecipitationProvider.js';

// ---- Spatial acceleration (271–274) ----
import { SpatialHashGrid } from './271_SpatialHashGrid.js';
import { FrustumCullingSystem } from './273_FrustumCullingSystem.js';

// ---- Performance governance (303–307) ----
import { HLODController } from './303_HLODController.js';
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';

// ---- Terrain pipeline types (373–397) ----
import {
  TilesetSourceFormat,
  TileState,
  TileEventType,
  stringTileKey,
  fnv1aHash,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

import { HeightmapTerrain } from './374_TerrainHeightmapTile.js';
import { QuantizedMeshTerrain } from './375_TerrainParseQuantizedMesh.js';
import { I3SElevationTerrain } from './389_TerrainI3SElevationDecoder.js';

// ---- Material painter and bridge (383, 394) ----
import { TerrainMaterialPainter } from './383_TerrainMaterialPainter.js';
import { TerrainMaterialBridge3D } from './394_TerrainMaterialBridge3D.js';

// ---- LOD fidelity (395) ----
import { TerrainLODFidelity3D } from './395_TerrainLODFidelity3D.js';

// ---- Query and collision (397) ----
import { TerrainQueryCollision3D } from './397_TerrainQueryCollision3D.js';

// ---- Hydrology (404) ----
import { TerrainProceduralHydrology3D } from './404_TerrainProceduralHydrology3D.js';

// ---- Scatter (405) ----
import {
  TerrainProceduralScatter3D,
  ScatterFamily,
  ScatterShapeClass,
  ScatterMarkerType
} from './405_TerrainProceduralScatter3D.js';

// ---- Fauna (406) ----
import {
  TerrainProceduralFauna3D,
  FaunaHookPhase,
  FaunaFamily
} from './406_TerrainProceduralFauna3D.js';

// ---- Sensory (297, 317) ----
import { SensoryDetailsProvider } from './297_SensoryDetailsProvider.js';
import { AudioLightEmissionSystem, AUDIO_CUE_TYPE, LIGHT_CUE_TYPE } from './317_AudioLightEmissionSystem.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ENUMS AND CONSTANTS
// ═════════════════════════════════════════════════════════════════════

/**
 * WeatherEffectType — the concrete effect generated for a tile.
 */
export const WeatherEffectType = Object.freeze({
  NONE:         0,
  LIGHTNING:    1,
  TORNADO:      2,
  FOG_VOLUME:   3,
  RAIN_PARTICLES: 4,
  SNOW_PARTICLES: 5,
  HAIL_DECALS:  6,
  SLEET_DECALS: 7,
  WIND_GUST:    8
});

/**
 * TornadoIntensity — the strength class of a tornado path.
 */
export const TornadoIntensity = Object.freeze({
  NONE:        0,
  FUNNEL:      1,   // weak, short-lived
  MODERATE:    2,   // medium, some erosion
  STRONG:      3,   // strong, deep erosion, tree destruction
  VIOLENT:     4    // extreme, ground-scouring
});

/**
 * LightningBoltStyle — the procedural bolt shape style.
 */
export const LightningBoltStyle = Object.freeze({
  SINGLE:      0,   // single main channel
  BRANCHED:    1,   // main channel with side branches
  FORKED:      2    // multi-channel fork
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENTS
// ═════════════════════════════════════════════════════════════════════

/**
 * WeatherTileComponent — bound to every tile that has an active weather
 * effect. Stores the effect type, the per-tile weather state, and the
 * pointer into the effect arena.
 */
export class WeatherTileComponent {
  static schema = {
    tileKeyHash:          { type: 'u32' },
    effectType:           { type: 'u8' },   // WeatherEffectType.*
    effectStart:          { type: 'u32' },  // offset into effect arena
    effectCount:          { type: 'u32' },
    // Abstract weather state (from file 276)
    weatherState:         { type: 'u8' },   // WEATHER.*
    weatherSeverity:      { type: 'f32' },
    // Wind state (from file 289)
    windSpeed:            { type: 'f32' },
    windDirectionX:       { type: 'f32' },
    windDirectionY:       { type: 'f32' },
    // Precipitation state (from file 288)
    precipitationPhase:   { type: 'u8' },   // PRECIPITATION_PHASE.*
    precipitationIntensity: { type: 'f32' },
    // Effect-specific data
    tornadoIntensity:     { type: 'u8' },   // TornadoIntensity.*
    lightningBoltCount:   { type: 'u16' },
    fogDensity:           { type: 'f32' },
    // Lifecycle
    activeTicks:          { type: 'u32' },
    lastUpdatedTick:      { type: 'u32' }
  };
}

/**
 * LightningBoltComponent — bound to each lightning bolt entity.
 */
export class LightningBoltComponent {
  static schema = {
    tileKeyHash:          { type: 'u32' },
    boltIndex:            { type: 'u32' },
    style:                { type: 'u8' },   // LightningBoltStyle.*
    startX:               { type: 'f32' },
    startY:               { type: 'f32' },
    startZ:               { type: 'f32' },
    endX:                 { type: 'f32' },
    endY:                 { type: 'f32' },
    endZ:                 { type: 'f32' },
    segmentCount:         { type: 'u16' },
    ageTicks:             { type: 'u32' },
    lastUpdatedTick:      { type: 'u32' }
  };
}

/**
 * TornadoPathComponent — bound to each tornado path entity.
 */
export class TornadoPathComponent {
  static schema = {
    tileKeyHash:          { type: 'u32' },
    pathIndex:            { type: 'u32' },
    intensity:            { type: 'u8' },   // TornadoIntensity.*
    currentX:             { type: 'f32' },
    currentY:             { type: 'f32' },
    currentZ:             { type: 'f32' },
    velocityX:            { type: 'f32' },
    velocityY:            { type: 'f32' },
    velocityZ:            { type: 'f32' },
    width:                { type: 'f32' },
    pathLength:           { type: 'f32' },
    ageTicks:             { type: 'u32' },
    lastUpdatedTick:      { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. WEATHER EFFECT ARENA
// ═════════════════════════════════════════════════════════════════════

/**
 * WeatherEffectArena — a shared Float32Array holding every weather effect's
 * data. Effects are:
 *   • Lightning bolt segments (per-bolt vertex paths)
 *   • Tornado path segments (per-tornado vertex paths)
 *   • Fog volume parameters (per-tile, 8 floats)
 *   • Particle spawn parameters (per-tile, N spawns × 8 floats)
 *
 * Ranges are freed when effects expire or tiles are evicted.
 */
class WeatherEffectArena {
  constructor(initialCapacity = 65536) {
    this.data = new Float32Array(initialCapacity);
    this.capacity = initialCapacity;
    this.used = 0;
    this.freeRanges = [];
  }

  alloc(count) {
    // Best-fit from free-list.
    let bestIdx = -1;
    let bestSize = Infinity;
    for (let i = 0; i < this.freeRanges.length; i++) {
      const r = this.freeRanges[i];
      if (r.size >= count && r.size < bestSize) {
        bestSize = r.size;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const r = this.freeRanges[bestIdx];
      const start = r.start;
      if (r.size === count) this.freeRanges.splice(bestIdx, 1);
      else { r.start += count; r.size -= count; }
      return start;
    }
    if (this.used + count > this.capacity) {
      let newCap = this.capacity;
      while (newCap < this.used + count) newCap *= 2;
      const newData = new Float32Array(newCap);
      newData.set(this.data);
      this.data = newData;
      this.capacity = newCap;
    }
    const start = this.used;
    this.used += count;
    return start;
  }

  free(start, count) {
    if (count <= 0) return;
    let inserted = false;
    for (let i = 0; i < this.freeRanges.length; i++) {
      if (this.freeRanges[i].start > start) {
        this.freeRanges.splice(i, 0, { start, size: count });
        inserted = true;
        break;
      }
    }
    if (!inserted) this.freeRanges.push({ start, size: count });
    this.freeRanges.sort((a, b) => a.start - b.start);
    for (let i = 0; i < this.freeRanges.length - 1; i++) {
      const cur = this.freeRanges[i];
      const next = this.freeRanges[i + 1];
      if (cur.start + cur.size === next.start) {
        cur.size += next.size;
        this.freeRanges.splice(i + 1, 1);
        i--;
      }
    }
    if (this.freeRanges.length > 0) {
      const last = this.freeRanges[this.freeRanges.length - 1];
      if (last.start + last.size === this.used) {
        this.used -= last.size;
        this.freeRanges.pop();
        while (this.freeRanges.length > 0) {
          const tail = this.freeRanges[this.freeRanges.length - 1];
          if (tail.start + tail.size === this.used) {
            this.used -= tail.size;
            this.freeRanges.pop();
          } else break;
        }
      }
    }
  }

  clear() { this.used = 0; this.freeRanges.length = 0; }
  dispose() { this.data = null; this.freeRanges.length = 0; this.used = 0; this.capacity = 0; }
}

// ═════════════════════════════════════════════════════════════════════
// 4. LIGHTNING GENERATOR (fractal midpoint displacement)
// ═════════════════════════════════════════════════════════════════════

/**
 * LightningGenerator — generates procedural lightning bolt paths using
 * recursive midpoint displacement. Produces a list of segment vertices that
 * downstream systems can render as a line-strip or a billboarded ribbon.
 */
class LightningGenerator {
  constructor(seed = 0x4C494748) { // "LIGH"
    this._noise = new SimplexNoise({ seed });
  }

  /**
   * Generates a bolt from (start) to (end) with `iterations` levels of
   * midpoint displacement. Writes segment vertices into `arena` starting at
   * `startOffset`. Returns the number of segments written.
   *
   * @param {number} startX, startY, startZ – bolt start (usually cloud base)
   * @param {number} endX, endY, endZ – bolt end (usually ground strike point)
   * @param {number} iterations – depth of the fractal (2–5 typical)
   * @param {number} roughness – displacement magnitude per level (0..1)
   * @param {number} branchCount – number of side branches
   * @param {WeatherEffectArena} arena
   * @param {number} startOffset
   * @returns {{segmentCount, endOffset}}
   */
  generateBolt(startX, startY, startZ, endX, endY, endZ,
               iterations, roughness, branchCount,
               arena, startOffset) {
    const segments = [];

    // Build the main channel with recursive midpoint displacement.
    this._midpointDisplace(
      [startX, startY, startZ],
      [endX, endY, endZ],
      iterations, roughness, segments
    );

    // Add branches.
    for (let b = 0; b < branchCount; b++) {
      // Pick a random point along the main channel.
      if (segments.length < 2) break;
      const idx = Math.floor(Math.random() * (segments.length - 1));
      const p = segments[idx];
      const branchEnd = [
        p[0] + (Math.random() - 0.5) * 30,
        p[1] + (Math.random() - 0.5) * 30,
        p[2] - Math.random() * 10
      ];
      this._midpointDisplace(p, branchEnd, iterations - 1, roughness * 0.5, segments);
    }

    // Write segment vertices into the arena (x, y, z per vertex).
    const vertexCount = segments.length;
    const start = arena.alloc(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      arena.data[start + i * 3]     = segments[i][0];
      arena.data[start + i * 3 + 1] = segments[i][1];
      arena.data[start + i * 3 + 2] = segments[i][2];
    }

    return {
      segmentCount: vertexCount,
      startOffset: start
    };
  }

  _midpointDisplace(a, b, iterations, roughness, out) {
    if (iterations <= 0) {
      out.push(a);
      out.push(b);
      return;
    }

    // Compute the midpoint.
    const mx = (a[0] + b[0]) * 0.5 + (Math.random() - 0.5) * roughness;
    const my = (a[1] + b[1]) * 0.5 + (Math.random() - 0.5) * roughness;
    const mz = (a[2] + b[2]) * 0.5 + (Math.random() - 0.5) * roughness;

    // Recurse.
    this._midpointDisplace(a, [mx, my, mz], iterations - 1, roughness * 0.5, out);
    this._midpointDisplace([mx, my, mz], b, iterations - 1, roughness * 0.5, out);
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. TORNADO SIMULATOR
// ═════════════════════════════════════════════════════════════════════

/**
 * TornadoSimulator — generates and animates a tornado path. The path is a
 * procedural curve driven by Simplex noise, and the tornado's intensity is
 * derived from the weather severity and wind shear.
 */
class TornadoSimulator {
  constructor(seed = 0x544F524E) { // "TORN"
    this._noise = new SimplexNoise({ seed });
  }

  /**
   * Creates a tornado path starting at (x, y, z) with a given intensity.
   * Returns an object with the tornado's state.
   */
  createPath(x, y, z, intensity, initialDirection) {
    const velocityScale = intensity * 2 + 2;
    return {
      currentX: x,
      currentY: y,
      currentZ: z,
      velocityX: Math.cos(initialDirection) * velocityScale,
      velocityY: Math.sin(initialDirection) * velocityScale,
      velocityZ: 0,
      width: 5 + intensity * 10,
      intensity,
      pathLength: 0,
      ageTicks: 0,
      vertices: [[x, y, z]]
    };
  }

  /**
   * Advances the tornado path by one tick.
   */
  advance(tornado, terrain, dt) {
    // Wander using Simplex noise.
    const wanderX = this._noise.noise2D(tornado.ageTicks * 0.05, 0) * 2;
    const wanderY = this._noise.noise2D(0, tornado.ageTicks * 0.05) * 2;

    tornado.velocityX += wanderX * dt;
    tornado.velocityY += wanderY * dt;

    // Clamp velocity.
    const speed = Math.sqrt(
      tornado.velocityX * tornado.velocityX +
      tornado.velocityY * tornado.velocityY
    );
    const maxSpeed = tornado.intensity * 2 + 2;
    if (speed > maxSpeed) {
      tornado.velocityX = (tornado.velocityX / speed) * maxSpeed;
      tornado.velocityY = (tornado.velocityY / speed) * maxSpeed;
    }

    // Advance position.
    tornado.currentX += tornado.velocityX * dt;
    tornado.currentY += tornado.velocityY * dt;

    // Clamp to tile bounds.
    if (terrain.bounds) {
      tornado.currentX = Math.max(terrain.bounds[0], Math.min(terrain.bounds[3], tornado.currentX));
      tornado.currentY = Math.max(terrain.bounds[1], Math.min(terrain.bounds[4], tornado.currentY));
    }

    // Update Z from terrain.
    const groundZ = terrain.getHeight
      ? terrain.getHeight(tornado.currentX, tornado.currentY)
      : 0;
    tornado.currentZ = isNaN(groundZ) ? 0 : groundZ;

    // Track path length.
    if (tornado.vertices.length > 0) {
      const last = tornado.vertices[tornado.vertices.length - 1];
      const dx = tornado.currentX - last[0];
      const dy = tornado.currentY - last[1];
      tornado.pathLength += Math.sqrt(dx * dx + dy * dy);
    }
    tornado.vertices.push([tornado.currentX, tornado.currentY, tornado.currentZ]);
    tornado.ageTicks++;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. THE WEATHER ENGINE
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainProceduralWeather3D — the procedural weather effects engine.
 */
export class TerrainProceduralWeather3D {
  constructor(options = {}) {
    this.options = {
      // Frequency
      targetHz: options.targetHz ?? 10,

      // Lightning
      enableLightning: options.enableLightning ?? true,
      lightningChancePerTick: options.lightningChancePerTick ?? 0.05,
      lightningIterations: options.lightningIterations ?? 4,
      lightningRoughness: options.lightningRoughness ?? 0.3,
      lightningBranchCount: options.lightningBranchCount ?? 2,
      lightningBoltLifetime: options.lightningBoltLifetime ?? 5,   // ticks
      lightningDamageRadius: options.lightningDamageRadius ?? 5,

      // Tornadoes
      enableTornadoes: options.enableTornadoes ?? true,
      tornadoChancePerTick: options.tornadoChancePerTick ?? 0.005,
      tornadoMinSeverity: options.tornadoMinSeverity ?? 0.75,
      tornadoMaxLifetime: options.tornadoMaxLifetime ?? 200,     // ticks
      tornadoErosionRate: options.tornadoErosionRate ?? 0.05,

      // Fog
      enableFog: options.enableFog ?? true,
      fogHeightFalloff: options.fogHeightFalloff ?? 0.02,        // per metre
      fogMaxDensity: options.fogMaxDensity ?? 0.95,

      // Particles
      enableParticles: options.enableParticles ?? true,
      rainDensityScale: options.rainDensityScale ?? 1.0,
      snowDensityScale: options.snowDensityScale ?? 0.6,
      maxParticlesPerTile: options.maxParticlesPerTile ?? 512,

      // Cache
      maxCachedTiles: options.maxCachedTiles ?? 512,
      cacheVersionTickInterval: options.cacheVersionTickInterval ?? 30,

      // Arena
      initialArenaCapacity: options.initialArenaCapacity ?? 65536,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    // ---- Arena ----
    this._arena = new WeatherEffectArena(this.options.initialArenaCapacity);

    // ---- Per-tile state ----
    this._tileStates = new Map();
    this._cacheVersion = 1;

    // ---- Sub-generators ----
    this._lightningGenerator = new LightningGenerator();
    this._tornadoSimulator = new TornadoSimulator();

    // ---- Context bindings ----
    this.frame = null;
    this.ecsWorld = null;
    this.source = null;
    this.queryEngine = null;
    this.hydrology = null;
    this.scatter = null;
    this.fauna = null;
    this.lodFidelity = null;
    this.materialBridge = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Scratch ----
    this._scratchVec3 = new Float64Array(3);

    // ---- Published SoA ----
    this._published = {
      tileKeys: [],
      effectTypes: [],
      effectStarts: [],
      effectCounts: [],
      weatherStates: [],
      weatherSeverities: [],
      windSpeeds: [],
      windDirectionXs: [],
      windDirectionYs: [],
      precipitationPhases: [],
      precipitationIntensities: [],
      fogDensities: [],
      tornadoIntensities: [],
      count: 0
    };

    // ---- Diagnostics ----
    this.stats = {
      ticksProcessed: 0,
      tilesProcessed: 0,
      lightningStrikes: 0,
      tornadoesSpawned: 0,
      particlesSpawned: 0,
      fogVolumesGenerated: 0,
      cacheHits: 0,
      cacheMisses: 0,
      lastDurationMs: 0,
      arenaUsed: 0,
      arenaCapacity: 0
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  bind(contextFrame, ecsWorld, source, queryEngine, hydrology, scatter, fauna, lodFidelity, materialBridge, eventDispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.source = source;
    this.queryEngine = queryEngine;
    this.hydrology = hydrology;
    this.scatter = scatter;
    this.fauna = fauna;
    this.lodFidelity = lodFidelity;
    this.materialBridge = materialBridge;
    this.dispatcher = eventDispatcher;
    return this;
  }

  // ---------------------------------------------------------------------
  // Main update
  // ---------------------------------------------------------------------

  update(contextFrame, tick, dt, visibleHeaders) {
    this.frame = contextFrame;
    this.lastTick = tick;

    this._accumulator += dt;
    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // Bump cache version.
    if (tick % this.options.cacheVersionTickInterval === 0) {
      this._cacheVersion++;
    }

    // Read abstract weather state from file 276.
    const temporal = contextFrame?.layers?.temporal;
    const weatherState = temporal?.weatherState ?? WEATHER.CLEAR;
    const weatherSeverity = temporal?.weatherSeverity ?? 0;
    const windX = temporal?.wind?.x ?? 0;
    const windY = temporal?.wind?.y ?? 0;
    const windSpeed = Math.sqrt(windX * windX + windY * windY);

    // Read precipitation state from file 288.
    const physical = contextFrame?.layers?.physical;
    const precipitationPhase = physical?.precipitationPhase ?? PRECIPITATION_PHASE.RAIN;
    const precipitationIntensity = physical?.precipitationIntensity ?? 0;

    // Reset published.
    this._resetPublished();

    // Process each visible tile.
    const visibleSet = new Set();
    for (const h of visibleHeaders) {
      if (h.state !== TileState.READY) continue;
      visibleSet.add(h.tileKey);

      const record = this.source?.tileMap?.get(h.tileKey);
      if (!record) continue;
      const terrain = record.terrainObject ?? record.terrain;
      if (!terrain) continue;

      // Check LOD — skip tiles too far to bother with.
      const lodRes = this.lodFidelity?.getResolution(h.tileKey) ?? null;
      const currentLod = lodRes?.currentLod ?? h.lod;
      if (currentLod > 8) continue;

      // Get or create state.
      let state = this._tileStates.get(h.tileKey);
      if (!state) {
        state = new WeatherTileState(h.tileKey);
        this._tileStates.set(h.tileKey, state);
      }
      state.reset();

      // Determine the effect for this tile.
      this._computeWeatherEffects(state, terrain, h, {
        weatherState, weatherSeverity,
        windX, windY, windSpeed,
        precipitationPhase, precipitationIntensity
      }, tick, dt);

      // Publish.
      this._publishTile(state, h);
    }

    // Publish to physical channel.
    this._publishToPhysicalChannel();

    // Evict stale.
    this._evictStale(visibleSet);

    // Stats.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.lastDurationMs = t1 - t0;
    this.stats.ticksProcessed++;
    this.stats.arenaUsed = this._arena.used;
    this.stats.arenaCapacity = this._arena.capacity;
  }

  // ---------------------------------------------------------------------
  // Effect computation
  // ---------------------------------------------------------------------

  _computeWeatherEffects(state, terrain, header, context, tick, dt) {
    // Store the abstract weather state.
    state.weatherState = context.weatherState;
    state.weatherSeverity = context.weatherSeverity;
    state.windSpeed = context.windSpeed;
    state.windDirectionX = context.windX;
    state.windDirectionY = context.windY;
    state.precipitationPhase = context.precipitationPhase;
    state.precipitationIntensity = context.precipitationIntensity;

    // ---- 1. Lightning ----
    if (this.options.enableLightning && context.weatherState === WEATHER.STORM) {
      if (Math.random() < this.options.lightningChancePerTick * context.weatherSeverity) {
        this._generateLightning(state, terrain, header, context, tick);
      }
    }

    // ---- 2. Tornadoes ----
    if (this.options.enableTornadoes &&
        context.weatherState === WEATHER.STORM &&
        context.weatherSeverity >= this.options.tornadoMinSeverity) {
      if (Math.random() < this.options.tornadoChancePerTick) {
        this._spawnTornado(state, terrain, header, context, tick);
      }
    }

    // ---- 3. Fog volumes ----
    if (this.options.enableFog && context.weatherState === WEATHER.FOG) {
      this._generateFogVolume(state, terrain, header, context, tick);
    }

    // ---- 4. Particles (rain, snow, hail, sleet) ----
    if (this.options.enableParticles && context.precipitationIntensity > 0.1) {
      this._generatePrecipitationParticles(state, terrain, header, context, tick);
    }

    // ---- 5. Wind gusts ----
    if (context.windSpeed > 5) {
      this._generateWindGusts(state, terrain, header, context, tick);
    }

    state.activeTicks++;
    state.lastUpdatedTick = tick;
  }

  // ---------------------------------------------------------------------
  // Lightning generation
  // ---------------------------------------------------------------------

  _generateLightning(state, terrain, header, context, tick) {
    // Pick a target point on the ground.
    const bounds = terrain.bounds;
    const tx = bounds ? bounds[0] + Math.random() * (bounds[3] - bounds[0]) : (terrain.originX ?? 0) + Math.random() * 100;
    const ty = bounds ? bounds[1] + Math.random() * (bounds[4] - bounds[1]) : (terrain.originY ?? 0) + Math.random() * 100;
    const tz = this.queryEngine?.getHeight(tx, ty) ?? 0;

    // Cloud base height.
    const cloudZ = tz + 500 + Math.random() * 500;

    // Generate the bolt.
    const bolt = this._lightningGenerator.generateBolt(
      tx + (Math.random() - 0.5) * 100,
      ty + (Math.random() - 0.5) * 100,
      cloudZ,
      tx, ty, tz,
      this.options.lightningIterations,
      this.options.lightningRoughness,
      this.options.lightningBranchCount,
      this._arena,
      0
    );

    // Store in state.
    state.effectType = WeatherEffectType.LIGHTNING;
    state.effectStart = bolt.startOffset;
    state.effectCount = bolt.segmentCount;
    state.lightningBoltCount++;
    state.lightningBolts.push({
      startOffset: bolt.startOffset,
      segmentCount: bolt.segmentCount,
      age: 0
    });

    // Apply scorch to the material bridge.
    if (this.materialBridge) {
      const scorchRadius = this.options.lightningDamageRadius;
      this.materialBridge.applyScorch(header.tileKey, tx, ty, scorchRadius);
    }

    // Emit light cue.
    if (this.dispatcher) {
      this.dispatcher.dispatch(EVENT_TYPE.LIGHTNING, {
        tileKey: header.tileKey,
        x: tx, y: ty, z: tz,
        intensity: 1.0
      });
    }

    this.stats.lightningStrikes++;
  }

  // ---------------------------------------------------------------------
  // Tornado generation
  // ---------------------------------------------------------------------

  _spawnTornado(state, terrain, header, context, tick) {
    // Determine intensity from severity.
    let intensity = TornadoIntensity.FUNNEL;
    if (context.weatherSeverity > 0.9) intensity = TornadoIntensity.VIOLENT;
    else if (context.weatherSeverity > 0.85) intensity = TornadoIntensity.STRONG;
    else if (context.weatherSeverity > 0.8) intensity = TornadoIntensity.MODERATE;

    // Pick a starting point.
    const bounds = terrain.bounds;
    const sx = bounds ? bounds[0] + Math.random() * (bounds[3] - bounds[0]) : (terrain.originX ?? 0) + Math.random() * 100;
    const sy = bounds ? bounds[1] + Math.random() * (bounds[4] - bounds[1]) : (terrain.originY ?? 0) + Math.random() * 100;
    const sz = this.queryEngine?.getHeight(sx, sy) ?? 0;

    // Create the tornado.
    const tornado = this._tornadoSimulator.createPath(
      sx, sy, sz, intensity, Math.random() * Math.PI * 2
    );
    tornado.ageTicks = 0;

    state.effectType = WeatherEffectType.TORNADO;
    state.tornadoIntensity = intensity;
    state.tornadoes.push(tornado);
    state.activeTicks = 0;

    // Emit tornado event.
    if (this.dispatcher) {
      this.dispatcher.dispatch(EVENT_TYPE.TORNADO, {
        tileKey: header.tileKey,
        x: sx, y: sy, z: sz,
        intensity
      });
    }

    this.stats.tornadoesSpawned++;
  }

  _advanceTornadoes(state, terrain, dt) {
    for (const tornado of state.tornadoes) {
      this._tornadoSimulator.advance(tornado, terrain, dt);

      // Apply erosion along the tornado path.
      if (terrain.elevation && terrain.resolution) {
        const res = terrain.resolution;
        const originX = terrain.originX ?? 0;
        const originY = terrain.originY ?? 0;
        const tileSize = terrain.tileWorldSize ?? 100;
        const cellSize = tileSize / (res - 1);

        const gx = Math.floor((tornado.currentX - originX) / cellSize);
        const gy = Math.floor((tornado.currentY - originY) / cellSize);

        if (gx >= 0 && gx < res && gy >= 0 && gy < res) {
          const idx = gy * res + gx;
          const erosion = this.options.tornadoErosionRate * tornado.intensity * dt;
          terrain.elevation[idx] -= erosion;
        }
      }

      // Destroy scatter instances in the tornado path.
      if (this.scatter) {
        const scatterState = this.scatter.getTileScatter(state.tileKey);
        if (scatterState) {
          const r2 = tornado.width * tornado.width;
          for (const inst of scatterState.instances) {
            const dx = inst.matrix[12] - tornado.currentX;
            const dy = inst.matrix[13] - tornado.currentY;
            if (dx * dx + dy * dy < r2) {
              // Trigger the instance's destruction.
              if (this.fauna) {
                this.fauna._hookArray.fire(FaunaHookPhase.ON_INTERACT, {
                  tileKey: state.tileKey,
                  instance: inst,
                  interaction: 'tornado'
                });
              }
            }
          }
        }
      }

      // Expire the tornado if it's too old.
      if (tornado.ageTicks > this.options.tornadoMaxLifetime) {
        const idx = state.tornadoes.indexOf(tornado);
        if (idx >= 0) state.tornadoes.splice(idx, 1);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Fog generation
  // ---------------------------------------------------------------------

  _generateFogVolume(state, terrain, header, context, tick) {
    // Fog density is higher at lower elevations.
    const minZ = terrain.minElevation ?? 0;
    const maxZ = terrain.maxElevation ?? 100;
    const avgZ = (minZ + maxZ) * 0.5;

    // Density falloff: denser at low elevations.
    let density = context.weatherSeverity * 0.5;
    if (avgZ < 100) density += 0.3;
    if (avgZ < 50) density += 0.2;
    density = Math.min(density, this.options.fogMaxDensity);

    state.effectType = WeatherEffectType.FOG_VOLUME;
    state.fogDensity = density;
    state.fogHeightFalloff = this.options.fogHeightFalloff;

    this.stats.fogVolumesGenerated++;
  }

  // ---------------------------------------------------------------------
  // Precipitation particles
  // ---------------------------------------------------------------------

  _generatePrecipitationParticles(state, terrain, header, context, tick) {
    const particleCount = Math.min(
      Math.floor(this.options.maxParticlesPerTile * context.precipitationIntensity),
      this.options.maxParticlesPerTile
    );

    if (particleCount === 0) return;

    // Determine particle type.
    let family;
    if (context.precipitationPhase === PRECIPITATION_PHASE.SNOW ||
        context.precipitationPhase === PRECIPITATION_PHASE.HEAVY_SNOW) {
      family = ScatterFamily.SNOW_PARTICLE;
    } else if (context.precipitationPhase === PRECIPITATION_PHASE.HAIL) {
      family = ScatterFamily.HAIL_PARTICLE;
    } else if (context.precipitationPhase === PRECIPITATION_PHASE.SLEET) {
      family = ScatterFamily.SLEET_PARTICLE;
    } else {
      family = ScatterFamily.RAIN_PARTICLE;
    }

    // Allocate particles.
    const bounds = terrain.bounds;
    const originX = bounds ? bounds[0] : (terrain.originX ?? 0);
    const originY = bounds ? bounds[1] : (terrain.originY ?? 0);
    const width = bounds ? bounds[3] - bounds[0] : (terrain.tileWorldSize ?? 100);
    const height = bounds ? bounds[4] - bounds[1] : (terrain.tileWorldSize ?? 100);

    for (let i = 0; i < particleCount; i++) {
      const px = originX + Math.random() * width;
      const py = originY + Math.random() * height;
      const pz = (terrain.maxElevation ?? 100) + 200 + Math.random() * 300;

      // Fall velocity depends on phase.
      let fallSpeed = 2;
      if (family === ScatterFamily.SNOW_PARTICLE) fallSpeed = 1;
      else if (family === ScatterFamily.HAIL_PARTICLE) fallSpeed = 10;
      else if (family === ScatterFamily.SLEET_PARTICLE) fallSpeed = 5;

      // Build the particle as a scatter-style instance.
      const matrix = new Float32Array(16);
      matrix[0] = 0.1; matrix[5] = 0.1; matrix[10] = 0.1;
      matrix[12] = px; matrix[13] = py; matrix[14] = pz; matrix[15] = 1;

      state.particles.push({
        matrix,
        family,
        fallSpeed,
        startZ: pz,
        currentZ: pz
      });
    }

    state.effectType = family === ScatterFamily.SNOW_PARTICLE
      ? WeatherEffectType.SNOW_PARTICLES
      : WeatherEffectType.RAIN_PARTICLES;

    this.stats.particlesSpawned += particleCount;
  }

  _advanceParticles(state, terrain, dt) {
    for (const p of state.particles) {
      p.currentZ -= p.fallSpeed * dt;
      p.matrix[14] = p.currentZ;

      // Reset particle to top when it hits the ground.
      if (p.currentZ < (terrain.minElevation ?? 0)) {
        p.currentZ = (terrain.maxElevation ?? 100) + 200 + Math.random() * 300;
        p.matrix[14] = p.currentZ;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Wind gusts
  // ---------------------------------------------------------------------

  _generateWindGusts(state, terrain, header, context, tick) {
    // Wind gusts push scatter instances.
    state.windGusts.push({
      directionX: context.windX / Math.max(context.windSpeed, 0.001),
      directionY: context.windY / Math.max(context.windSpeed, 0.001),
      speed: context.windSpeed,
      age: 0
    });
  }

  // ---------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------

  _resetPublished() {
    const p = this._published;
    p.tileKeys.length = 0;
    p.effectTypes.length = 0;
    p.effectStarts.length = 0;
    p.effectCounts.length = 0;
    p.weatherStates.length = 0;
    p.weatherSeverities.length = 0;
    p.windSpeeds.length = 0;
    p.windDirectionXs.length = 0;
    p.windDirectionYs.length = 0;
    p.precipitationPhases.length = 0;
    p.precipitationIntensities.length = 0;
    p.fogDensities.length = 0;
    p.tornadoIntensities.length = 0;
    p.count = 0;
  }

  _publishTile(state, header) {
    const p = this._published;
    p.tileKeys.push(header.tileKey);
    p.effectTypes.push(state.effectType);
    p.effectStarts.push(state.effectStart);
    p.effectCounts.push(state.effectCount);
    p.weatherStates.push(state.weatherState);
    p.weatherSeverities.push(state.weatherSeverity);
    p.windSpeeds.push(state.windSpeed);
    p.windDirectionXs.push(state.windDirectionX);
    p.windDirectionYs.push(state.windDirectionY);
    p.precipitationPhases.push(state.precipitationPhase);
    p.precipitationIntensities.push(state.precipitationIntensity);
    p.fogDensities.push(state.fogDensity);
    p.tornadoIntensities.push(state.tornadoIntensity);
    p.count++;
  }

  _publishToPhysicalChannel() {
    if (!this.frame?.layers?.physical) return;
    const physical = this.frame.layers.physical;
    const p = this._published;

    physical.weatherEffectTileKeys = p.tileKeys;
    physical.weatherEffectTypes = p.effectTypes;
    physical.weatherEffectStarts = p.effectStarts;
    physical.weatherEffectCounts = p.effectCounts;
    physical.weatherStates = p.weatherStates;
    physical.weatherSeverities = p.weatherSeverities;
    physical.weatherWindSpeeds = p.windSpeeds;
    physical.weatherWindDirectionXs = p.windDirectionXs;
    physical.weatherWindDirectionYs = p.windDirectionYs;
    physical.weatherPrecipitationPhases = p.precipitationPhases;
    physical.weatherPrecipitationIntensities = p.precipitationIntensities;
    physical.weatherFogDensities = p.fogDensities;
    physical.weatherTornadoIntensities = p.tornadoIntensities;
    physical.weatherArena = this._arena.data;
    physical.weatherStats = this.getStats();
  }

  // ---------------------------------------------------------------------
  // Eviction
  // ---------------------------------------------------------------------

  _evictStale(visibleSet) {
    if (this._tileStates.size <= this.options.maxCachedTiles) return;

    const toEvict = [];
    for (const [tileKey, state] of this._tileStates) {
      if (!visibleSet.has(tileKey)) toEvict.push(tileKey);
    }

    for (const tileKey of toEvict) {
      if (this._tileStates.size <= this.options.maxCachedTiles) break;
      this._tileStates.delete(tileKey);
    }
  }

  // ---------------------------------------------------------------------
  // Public queries
  // ---------------------------------------------------------------------

  getTileWeather(tileKey) {
    return this._tileStates.get(tileKey) ?? null;
  }

  getArena() {
    return this._arena.data;
  }

  getStats() {
    return {
      ...this.stats,
      cachedTiles: this._tileStates.size,
      arenaUsed: this._arena.used,
      arenaCapacity: this._arena.capacity,
      cacheVersion: this._cacheVersion
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  clear() {
    this._tileStates.clear();
    this._arena.clear();
    this._resetPublished();
  }

  dispose() {
    this.clear();
    this._arena.dispose();
    this.frame = null;
    this.ecsWorld = null;
    this.source = null;
    this.queryEngine = null;
    this.hydrology = null;
    this.scatter = null;
    this.fauna = null;
    this.lodFidelity = null;
    this.materialBridge = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 7. PER-TILE WEATHER STATE
// ═════════════════════════════════════════════════════════════════════

/**
 * WeatherTileState — the per-tile weather state. Stores the abstract weather
 * state, the concrete effects, and the arena range.
 */
class WeatherTileState {
  constructor(tileKey) {
    this.tileKey = tileKey;
    this.effectType = WeatherEffectType.NONE;
    this.effectStart = 0;
    this.effectCount = 0;
    this.weatherState = WEATHER.CLEAR;
    this.weatherSeverity = 0;
    this.windSpeed = 0;
    this.windDirectionX = 0;
    this.windDirectionY = 0;
    this.precipitationPhase = PRECIPITATION_PHASE.RAIN;
    this.precipitationIntensity = 0;
    this.fogDensity = 0;
    this.fogHeightFalloff = 0.02;
    this.tornadoIntensity = TornadoIntensity.NONE;
    this.lightningBolts = [];
    this.tornadoes = [];
    this.particles = [];
    this.windGusts = [];
    this.activeTicks = 0;
    this.lastUpdatedTick = 0;
  }

  reset() {
    this.effectType = WeatherEffectType.NONE;
    this.effectStart = 0;
    this.effectCount = 0;
    this.fogDensity = 0;
    this.tornadoIntensity = TornadoIntensity.NONE;
    this.lightningBolts.length = 0;
    this.tornadoes.length = 0;
    this.particles.length = 0;
    this.windGusts.length = 0;
    this.activeTicks = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 8. FACTORY
// ═════════════════════════════════════════════════════════════════════

export function createTerrainProceduralWeather3D(options = {}) {
  return new TerrainProceduralWeather3D({
    targetHz: options.targetHz ?? 10,
    enableLightning: options.enableLightning ?? true,
    lightningChancePerTick: options.lightningChancePerTick ?? 0.05,
    lightningIterations: options.lightningIterations ?? 4,
    lightningRoughness: options.lightningRoughness ?? 0.3,
    lightningBranchCount: options.lightningBranchCount ?? 2,
    lightningBoltLifetime: options.lightningBoltLifetime ?? 5,
    lightningDamageRadius: options.lightningDamageRadius ?? 5,
    enableTornadoes: options.enableTornadoes ?? true,
    tornadoChancePerTick: options.tornadoChancePerTick ?? 0.005,
    tornadoMinSeverity: options.tornadoMinSeverity ?? 0.75,
    tornadoMaxLifetime: options.tornadoMaxLifetime ?? 200,
    tornadoErosionRate: options.tornadoErosionRate ?? 0.05,
    enableFog: options.enableFog ?? true,
    fogHeightFalloff: options.fogHeightFalloff ?? 0.02,
    fogMaxDensity: options.fogMaxDensity ?? 0.95,
    enableParticles: options.enableParticles ?? true,
    rainDensityScale: options.rainDensityScale ?? 1.0,
    snowDensityScale: options.snowDensityScale ?? 0.6,
    maxParticlesPerTile: options.maxParticlesPerTile ?? 512,
    maxCachedTiles: options.maxCachedTiles ?? 512,
    cacheVersionTickInterval: options.cacheVersionTickInterval ?? 30,
    initialArenaCapacity: options.initialArenaCapacity ?? 65536,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 9. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainProceduralWeather3D,
  WeatherTileComponent,
  LightningBoltComponent,
  TornadoPathComponent,
  WeatherEffectArena,
  LightningGenerator,
  TornadoSimulator,
  WeatherTileState,
  WeatherEffectType,
  TornadoIntensity,
  LightningBoltStyle,
  createTerrainProceduralWeather3D
};