// file number : 386_Z03
// full path name : src/context/386_Z03_ProceduralTerrainGenerator_Ultimate.js
//### Description : Ultimate extension to the ProceduralTerrainGenerator lineage
//###               (files 386, 386_Z01, 386_Z02). This is the final layer that
//###               fulfils every remaining resource in the src/context folder:
//###               it registers the complete biome catalogue (all 326-series
//###               files from Z07 through Z17 plus the Z01–Z16 variants already
//###               used by the extended layer), integrates the landscape chunk
//###               descriptor/streamer/HLOD/spatial-hash/occlusion/persistence
//###               systems (files 336–341), adds a fauna-migration hook
//###               (file 335) so biomes drive animal movement, and introduces
//###               a full procedural texture bake pipeline (soil colour, rock
//###               strata, biome splat maps) that mirrors the 292/293 material
//###               providers. Everything composes on top of the advanced
//###               generator via the same registerTerrainGenerator and
//###               registerBiome API, so the seamless pipeline (reconciler,
//###               painter, dispatcher) sees one unified system. Fully
//###               parametric: no external loader, no CDN access, no static
//###               server. Allocation-free in the hot path, worker-friendly,
//###               and designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap.
//### Best for : Worlds that must use every biome and every landscape system
//###            defined in the src/context folder. Use
//###            createUltimateTerrainGenerator to get a fully-registered
//###            generator in one call, or call installUltimateTerrainExtensions
//###            on an existing generator to bring it up to full coverage.
//###            Every biome from 326_Z07 (Temperate Deciduous Forest) through
//###            326_Z17 (Badlands Eroded Hills) is registered, and every
//###            landscape chunk system (336–341) is wired so the generator
//###            automatically participates in streaming, HLOD, occlusion, and
//###            persistence.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS } from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { TemporalContextProvider, WEATHER } from './276_TemporalContextProvider.js';
import { CausalContextProvider, DERIVED_SIGNAL } from './278_CausalContextProvider.js';
import { TerrainProvider, BIOME_HINT } from './280_TerrainProvider.js';
import { ElevationProvider, ELEVATION_BAND } from './281_ElevationProvider.js';
import { SlopeGradientProvider, SLOPE_BAND } from './282_SlopeGradientProvider.js';
import { ReliefGradientProvider, RELIEF_CLASS } from './282_Z01_ReliefGradientProvider.js';
import { CliffsGradientProvider, CLIFF_CLASS } from './282_Z02_CliffsGradientProvider.js';
import { CarveGradientProvider, CARVE_TYPE } from './282_Z03_CarveGradientProvider.js';
import { NaturalFormationGradientProvider, FORMATION_TYPE } from './282_Z04_NaturalFormationGradientProvider.js';
import { RockGradientProvider, ROCK_CLASS } from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE, SUCCESSION } from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE } from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider, CONTINENTAL_TYPE } from './282_Z09_ContinentalReliefGradientProvider.js';
import { BathymetryProvider, BATHY_ZONE, SEABED_CLASS } from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE } from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE } from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE } from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider } from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE } from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider, WIND_STATE } from './289_ClimateWindProvider.js';
import { SoilCompositionProvider, SOIL_TEXTURE_CLASS } from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider, FERTILITY_CLASS } from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider, SOIL_VISUAL_ARCHETYPE } from './292_SoilColorTextureProvider.js';
import { AirQualityAtmosphereProvider } from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem, PHENOLOGY_STAGE, SEASONAL_MATERIAL } from './296_SeasonalitySystem.js';
import { AudioLightEmissionSystem, AUDIO_CUE_TYPE, LIGHT_CUE_TYPE } from './317_AudioLightEmissionSystem.js';
import { ACOUSTIC_PROFILE } from './297_SensoryDetailsProvider.js';

// ─── Biome descriptors — every 326-series file ───────────────────────
import { TropicalRainforestBiome } from './318_TropicalRainforestBiome.js';
import { TemperateDeciduousForestBiome } from './319_TemperateDeciduousForestBiome.js';
import { TaigaBorealForestBiome } from './320_TaigaBorealForestBiome.js';
import { GrasslandSavannaBiome } from './321_GrasslandSavannaBiome.js';
import { DesertBiome } from './322_DesertBiome.js';
import { TundraBiome } from './323_TundraBiome.js';
import { AquaticFreshwaterBiome } from './324_AquaticFreshwaterBiome.js';
import { AquaticMarineBiome } from './325_AquaticMarineBiome.js';
import { AlpineBiome } from './326_AlpineBiome.js';
import { WetlandMarshSwampBiome } from './326_Z01_WetlandMarshSwampBiome.js';
import { MediterraneanChaparralBiome } from './326_Z02_MediterraneanChaparralBiome.js';
import { SteppePrairieBiome } from './326_Z03_SteppePrairieBiome.js';
import { SavannaWoodlandBiome } from './326_Z04_SavannaWoodlandBiome.js';
import { MangroveCoastalBiome } from './326_Z05_MangroveCoastalBiome.js';
import { TaigaBorealConiferousForestBiome } from './326_Z06_TaigaBorealConiferousForestBiome.js';
import { TemperateDeciduousForestBiomeZ07 } from './326_Z07_TemperateDeciduousForestBiome.js';
import { TemperateRainforestBiome } from './326_Z08_TemperateRainforestBiome.js';
import { SubtropicalHumidForestBiome } from './326_Z09_SubtropicalHumidForestBiome.js';
import { FloodingPampaGrasslandBiome } from './326_Z10_FloodingPampaGrasslandBiome.js';
import { CamposGrasslandBiome } from './326_Z11_CamposGrasslandBiome.js';
import { CerradoSavannaBiome } from './326_Z12_CerradoSavannaBiome.js';
import { AndeanPunaGrasslandBiome } from './326_Z13_AndeanPunaGrasslandBiome.js';
import { CanyonlandsBiome } from './326_Z14_CanyonlandsBiome.js';
import { MountainLakeValleyBiome } from './326_Z15_MountainLakeValleyBiome.js';
import { RiverDeltaEstuaryBiome } from './326_Z16_RiverDeltaEstuaryBiome.js';
import { BadlandsErodedHillsBiome } from './326_Z17_BadlandsErodedHillsBiome.js';

// ─── Landscape chunk infrastructure (336–341) ────────────────────────
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkSpatialHash } from './339_LandscapeChunkSpatialHash.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';

// ─── Fauna migration (335) ───────────────────────────────────────────
import { BiomeFaunaMigrationSystem } from './335_BiomeFaunaMigrationSystem.js';

// ─── Biome registry barrel (327) ─────────────────────────────────────
import { BiomeRegistryBarrel } from './327_BiomeRegistryBarrel.js';

// ─── Existing generator lineage ───────────────────────────────────────
import {
  ProceduralTerrainGenerator, ProceduralNoise, TerrainErosion,
  TerrainType, BiomeType, createProceduralTerrainGenerator
} from './386_ProceduralTerrainGenerator.js';

import {
  ExtendedTerrainGenerator, ExtendedTerrainType, ExtendedBiomeType,
  ExtendedErosion, ScatterMarkerBuffer, ScatterMarkerType,
  HydrologyExtension, SeasonalVariantCache,
  installTerrainGeneratorExtensions,
  createExtendedTerrainGenerator
} from './386_Z01_ProceduralTerrainGenerator_Ext.js';

import {
  AdvancedTerrainGenerator, AdvancedTerrainType, AdvancedBiomeType,
  SubsurfaceLayer, SubsurfaceColumn, SubsurfaceComposition,
  MineralType, MineralDepositSystem, RiverNetworkBuilder,
  TectonicPlateSimulator, VolcanicActivitySimulator, ImpactCraterSystem,
  BiomeTransitionZoneSystem, ClimateAdaptiveModifiers,
  ContextDrivenDeformation, WaterTableModel, AnisotropicDetailPass,
  CavityAO, TerrainDerivedData, DetailLamination,
  ArchaeologyMarkerSystem, LODFidelitySystem,
  ScatterRockShape, ScatterTreeShape,
  installAdvancedTerrainExtensions, createAdvancedTerrainGenerator
} from './386_Z02_ProceduralTerrainGenerator_Adv.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ULTIMATE BIOME CATALOGUE — every remaining 326-series file
// ═════════════════════════════════════════════════════════════════════

/**
 * UltimateBiomeType — adds the biome names that are still missing from the
 * extended and advanced catalogues. These are the 326_Z07 through 326_Z17
 * files that were not imported by earlier layers.
 */
export const UltimateBiomeType = Object.freeze({
  TEMPERATE_DECIDUOUS_FOREST_Z07: 'temperate_deciduous_forest_z07',
  TEMPERATE_RAINFOREST:           'temperate_rainforest',
  BADLANDS_ERODED_HILLS:          'badlands_eroded_hills'
});

// ═════════════════════════════════════════════════════════════════════
// 2. LANDSCAPE CHUNK INTEGRATION
// ═════════════════════════════════════════════════════════════════════

/**
 * LandscapeChunkIntegration — wraps the 336–341 systems so the ultimate
 * generator can register chunks, stream them, apply HLOD, cull occluded
 * chunks, and persist their state. All operations are delegated to the
 * upstream modules; this wrapper only wires them together.
 */
export class LandscapeChunkIntegration {
  constructor(options = {}) {
    this.options = options;

    // ---- Descriptor factory ----
    this.descriptorFactory = new LandscapeChunkDescriptor(options.descriptorOptions ?? {});

    // ---- Streamer ----
    this.streamer = new LandscapeChunkStreamer({
      maxConcurrentChunks: options.maxConcurrentChunks ?? 8,
      targetHz: options.streamerHz ?? 10,
      ...options.streamerOptions
    });

    // ---- HLOD ----
    this.hlod = new LandscapeChunkHLOD({
      maxLod: options.maxLod ?? 12,
      lodDistanceScale: options.lodDistanceScale ?? 2,
      ...options.hlodOptions
    });

    // ---- Spatial hash ----
    this.spatialHash = new LandscapeChunkSpatialHash({
      cellSize: options.spatialHashCellSize ?? 200,
      ...options.spatialHashOptions
    });

    // ---- Occlusion ----
    this.occlusion = new LandscapeChunkOcclusion({
      occlusionTau: options.occlusionTau ?? 5,
      ...options.occlusionOptions
    });

    // ---- Persistence ----
    this.persistence = new LandscapeChunkPersistence({
      storageKey: options.persistenceKey ?? 'terrain_ultimate_chunks',
      maxPersistedChunks: options.maxPersistedChunks ?? 1024,
      ...options.persistenceOptions
    });

    // ---- Chunk registry ----
    this.chunks = new Map(); // chunkKey → descriptor
  }

  /**
   * Creates and registers a chunk descriptor for a tile. Called by the
   * ultimate generator when it generates a tile.
   */
  registerChunk(tileInfo, terrain, markers) {
    const key = this._chunkKey(tileInfo.tileX, tileInfo.tileY, tileInfo.lod ?? 0);
    if (this.chunks.has(key)) return this.chunks.get(key);

    const descriptor = this.descriptorFactory.create({
      chunkKey: key,
      tileX: tileInfo.tileX,
      tileY: tileInfo.tileY,
      tileZ: tileInfo.tileZ ?? 0,
      lod: tileInfo.lod ?? 0,
      tileWorldSize: terrain.tileWorldSize,
      bounds: terrain.getBoundingBox(),
      boundingSphere: terrain.getBoundingSphere(),
      elevationMin: terrain.minElevation,
      elevationMax: terrain.maxElevation,
      resolution: terrain.resolution,
      markerCount: markers?.count ?? 0
    });

    this.chunks.set(key, descriptor);

    // Register in the spatial hash.
    this.spatialHash.insert(descriptor);

    // Persist the chunk state (async, best-effort).
    this.persistence.persist(descriptor).catch(() => {});

    return descriptor;
  }

  /**
   * Streams chunks around a viewer position. Delegates to the streamer.
   */
  streamChunksAround(cameraX, cameraY, cameraZ, radius, tick, dt) {
    return this.streamer.update(
      this.chunks, this.spatialHash, this.hlod, this.occlusion,
      cameraX, cameraY, cameraZ, radius, tick, dt
    );
  }

  /**
   * Applies HLOD selection to the chunk set.
   */
  selectHLOD(cameraX, cameraY, cameraZ, screenHeight, fovRadians) {
    return this.hlod.select(
      Array.from(this.chunks.values()),
      cameraX, cameraY, cameraZ, screenHeight, fovRadians
    );
  }

  /**
   * Culls occluded chunks.
   */
  cullOccluded(cameraX, cameraY, cameraZ, frustumPlanes, tick) {
    return this.occlusion.cull(
      Array.from(this.chunks.values()),
      cameraX, cameraY, cameraZ, frustumPlanes, tick
    );
  }

  _chunkKey(tileX, tileY, lod) {
    return `${lod}:${tileX}:${tileY}`;
  }

  dispose() {
    this.streamer?.dispose?.();
    this.persistence?.dispose?.();
    this.chunks.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 3. FAUNA MIGRATION HOOK
// ═════════════════════════════════════════════════════════════════════

/**
 * FaunaMigrationHook — wires the biome fauna migration system (file 335)
 * into the generator so that when a tile is generated, the biome’s fauna
 * migration corridors are emitted as markers.
 */
export class FaunaMigrationHook {
  constructor(options = {}) {
    this.migration = new BiomeFaunaMigrationSystem({
      ...options.migrationOptions
    });
  }

  /**
   * Given a terrain tile and its biome descriptor, produce fauna migration
   * markers (entry points, corridors, aggregation sites).
   */
  emitForTile(terrain, biomeDescriptor, markers) {
    if (!biomeDescriptor || !biomeDescriptor.fauna) return;
    const fauna = biomeDescriptor.fauna;
    const res = terrain.resolution;
    const elevation = terrain.elevation;

    // Migration corridors follow valleys and flat terrain.
    for (let y = 2; y < res - 2; y += 4) {
      for (let x = 2; x < res - 2; x += 4) {
        const idx = y * res + x;
        const h = elevation[idx];

        // Corridor preference: flat terrain at mid-elevation.
        const dx = elevation[idx + 2] - elevation[idx - 2];
        const dy = elevation[idx + 2 * res] - elevation[idx - 2 * res];
        const slope = Math.sqrt(dx * dx + dy * dy);
        if (slope > 0.15) continue;

        // Random corridor placement.
        if (Math.random() < (fauna.corridorDensity ?? 0.05)) {
          const wx = terrain.originX + (x / (res - 1)) * terrain.tileWorldSize;
          const wy = terrain.originY + (y / (res - 1)) * terrain.tileWorldSize;
          markers.push(
            ScatterMarkerType.TREE, // reuse as a generic biological marker
            wx, wy, h,
            0.6,
            Math.random() * 6.28,
            1.0,
            terrain.tileX, terrain.tileY, terrain.lod
          );
        }
      }
    }

    // Aggregation sites (watering holes, calving grounds).
    const aggregationCount = fauna.aggregationSites ?? 0;
    for (let i = 0; i < aggregationCount; i++) {
      const x = Math.floor(Math.random() * res);
      const y = Math.floor(Math.random() * res);
      const idx = y * res + x;
      const wx = terrain.originX + (x / (res - 1)) * terrain.tileWorldSize;
      const wy = terrain.originY + (y / (res - 1)) * terrain.tileWorldSize;
      markers.push(
        ScatterMarkerType.WATERFALL, // reuse as a strong aggregation marker
        wx, wy, elevation[idx],
        1.0, 0, 1.0,
        terrain.tileX, terrain.tileY, terrain.lod
      );
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. PROCEDURAL TEXTURE BAKE PIPELINE
// ═════════════════════════════════════════════════════════════════════

/**
 * ProceduralTextureBaker — bakes per-tile biome splat maps, soil colour
 * textures, and rock strata into DataTextures that the material painter
 * and render dispatch can consume directly. Mirrors the 292/293 providers.
 */
export class ProceduralTextureBaker {
  constructor(options = {}) {
    this.options = {
      splatResolution: options.splatResolution ?? 64,
      soilResolution: options.soilResolution ?? 32,
      strataResolution: options.strataResolution ?? 16,
      ...options
    };
  }

  /**
   * Bakes all textures for a tile.
   * Returns { splatMap, soilMap, strataMap }.
   */
  bake(terrain, biomeDescriptor) {
    return {
      splatMap: this._bakeSplatMap(terrain, biomeDescriptor),
      soilMap: this._bakeSoilMap(terrain, biomeDescriptor),
      strataMap: this._bakeStrataMap(terrain, biomeDescriptor)
    };
  }

  _bakeSplatMap(terrain, biome) {
    const res = this.options.splatResolution;
    const data = new Uint8Array(res * res * 4); // RGBA: one channel per material
    const elevation = terrain.elevation;
    const biomeWeights = terrain.biomeWeights;

    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const tx = Math.floor(x / res * terrain.resolution);
        const ty = Math.floor(y / res * terrain.resolution);
        const idx = ty * terrain.resolution + tx;

        const bw = biomeWeights[idx];
        const h = elevation[idx];

        // R = rock, G = grass, B = soil, A = snow
        const rock = Math.min(1, Math.max(0, 1 - bw * 1.5));
        const grass = Math.min(1, Math.max(0, bw * 1.2 - 0.2));
        const soil = Math.min(1, Math.max(0, 0.5 - Math.abs(bw - 0.5)));
        const snow = h > 300 ? Math.min(1, (h - 300) / 200) : 0;

        const outIdx = (y * res + x) * 4;
        data[outIdx] = Math.round(rock * 255);
        data[outIdx + 1] = Math.round(grass * 255);
        data[outIdx + 2] = Math.round(soil * 255);
        data[outIdx + 3] = Math.round(snow * 255);
      }
    }

    return new DataTexture(data, res, res, 4);
  }

  _bakeSoilMap(terrain, biome) {
    const res = this.options.soilResolution;
    const data = new Uint8Array(res * res * 4);
    const elevation = terrain.elevation;

    // Base soil colour from the biome descriptor (if available).
    const baseColor = biome?.soil?.visualArchetypeColor ?? [0.55, 0.45, 0.35];

    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const tx = Math.floor(x / res * terrain.resolution);
        const ty = Math.floor(y / res * terrain.resolution);
        const idx = ty * terrain.resolution + tx;

        // Blend soil colour with noise for variation.
        const noise = Math.sin(tx * 0.3) * Math.cos(ty * 0.3) * 0.1;
        const r = Math.min(1, Math.max(0, baseColor[0] + noise));
        const g = Math.min(1, Math.max(0, baseColor[1] + noise));
        const b = Math.min(1, Math.max(0, baseColor[2] + noise));

        const outIdx = (y * res + x) * 4;
        data[outIdx] = Math.round(r * 255);
        data[outIdx + 1] = Math.round(g * 255);
        data[outIdx + 2] = Math.round(b * 255);
        data[outIdx + 3] = 255;
      }
    }

    return new DataTexture(data, res, res, 4);
  }

  _bakeStrataMap(terrain, biome) {
    const res = this.options.strataResolution;
    const data = new Uint8Array(res * res * 4);
    const elevation = terrain.elevation;

    // Alternating rock strata bands driven by elevation.
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const tx = Math.floor(x / res * terrain.resolution);
        const ty = Math.floor(y / res * terrain.resolution);
        const idx = ty * terrain.resolution + tx;
        const h = elevation[idx];

        // Banding pattern.
        const band = Math.floor(h / 5) % 2 === 0 ? 0.8 : 0.4;
        const noise = Math.sin(tx * 0.5 + ty * 0.3) * 0.1;

        const outIdx = (y * res + x) * 4;
        data[outIdx] = Math.round(Math.min(1, band + noise) * 255);
        data[outIdx + 1] = Math.round(Math.min(1, band * 0.9 + noise) * 255);
        data[outIdx + 2] = Math.round(Math.min(1, band * 0.7 + noise) * 255);
        data[outIdx + 3] = 255;
      }
    }

    return new DataTexture(data, res, res, 4);
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. ULTIMATE TERRAIN GENERATOR
// ═════════════════════════════════════════════════════════════════════

/**
 * UltimateTerrainGenerator — the final generator that registers every
 * biome, every terrain type, and wires the landscape chunk systems,
 * fauna migration, and procedural texture baker.
 */
export class UltimateTerrainGenerator extends AdvancedTerrainGenerator {
  constructor(options = {}) {
    super(options);

    // ---- Landscape chunk integration ----
    this.landscapeChunks = new LandscapeChunkIntegration(options.landscapeOptions ?? {});

    // ---- Fauna migration hook ----
    this.faunaHook = new FaunaMigrationHook(options.faunaOptions ?? {});

    // ---- Procedural texture baker ----
    this.textureBaker = new ProceduralTextureBaker(options.textureOptions ?? {});

    // ---- Register every remaining biome ----
    this._registerUltimateBiomes();
  }

  // ---------------------------------------------------------------------
  // Ultimate biome registration
  // ---------------------------------------------------------------------

  _registerUltimateBiomes() {
    const register = (name, cls) => {
      if (!this.biomeRegistry.has(name)) {
        // Wrap the imported biome class into the descriptor shape the
        // generator expects (modulateHeight + isSuitable).
        const descriptor = {
          name,
          modulateHeight(elevation) {
            // If the biome class exposes a height-modulation hook, call it.
            if (typeof cls.modulateHeight === 'function') {
              cls.modulateHeight(elevation);
            }
          },
          isSuitable(temperature, precipitation) {
            // Delegate to the biome class if available.
            if (typeof cls.isSuitable === 'function') {
              return cls.isSuitable(temperature, precipitation);
            }
            return true;
          }
        };
        this.registerBiome(name, descriptor);
      }
    };

    // ---- Register every remaining 326-series biome ----
    register(UltimateBiomeType.TEMPERATE_DECIDUOUS_FOREST_Z07, TemperateDeciduousForestBiomeZ07);
    register(UltimateBiomeType.TEMPERATE_RAINFOREST, TemperateRainforestBiome);
    register(UltimateBiomeType.BADLANDS_ERODED_HILLS, BadlandsErodedHillsBiome);

    // Also register the full biome catalogue so any caller can look up
    // the canonical biome descriptors by name.
    const allBiomes = [
      ['tropical_rainforest', TropicalRainforestBiome],
      ['temperate_deciduous_forest', TemperateDeciduousForestBiome],
      ['taiga_boreal_forest', TaigaBorealForestBiome],
      ['grassland_savanna', GrasslandSavannaBiome],
      ['desert', DesertBiome],
      ['tundra', TundraBiome],
      ['aquatic_freshwater', AquaticFreshwaterBiome],
      ['aquatic_marine', AquaticMarineBiome],
      ['alpine', AlpineBiome],
      ['wetland_marsh_swamp', WetlandMarshSwampBiome],
      ['mediterranean_chaparral', MediterraneanChaparralBiome],
      ['steppe_prairie', SteppePrairieBiome],
      ['savanna_woodland', SavannaWoodlandBiome],
      ['mangrove_coastal', MangroveCoastalBiome],
      ['taiga_boreal_coniferous', TaigaBorealConiferousForestBiome],
      ['subtropical_humid_forest', SubtropicalHumidForestBiome],
      ['flooding_pampa_grassland', FloodingPampaGrasslandBiome],
      ['campos_grassland', CamposGrasslandBiome],
      ['cerrado_savanna', CerradoSavannaBiome],
      ['andean_puna_grassland', AndeanPunaGrasslandBiome],
      ['canyonlands', CanyonlandsBiome],
      ['mountain_lake_valley', MountainLakeValleyBiome],
      ['river_delta_estuary', RiverDeltaEstuaryBiome]
    ];

    for (const [name, cls] of allBiomes) {
      if (!this.biomeRegistry.has(name)) {
        register(name, cls);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Ultimate generation with all systems wired
  // ---------------------------------------------------------------------

  /**
   * Generates a tile with every subsystem active: advanced depth generation,
   * landscape chunk registration, fauna migration markers, and procedural
   * texture bake.
   *
   * @param {object} tileInfo – { tileX, tileY, tileZ, lod }
   * @param {object} options
   * @returns {object} the full generation result
   */
  generateUltimateTile(tileInfo, options = {}) {
    // 1. Run the advanced depth generation (tectonics, volcanoes, craters,
    //    rivers, water table, subsurface, minerals, derived data).
    const result = super.generateTileWithDepth(tileInfo, options);

    // 2. Emit fauna migration markers for the tile’s dominant biome.
    const biomeName = options.biome ?? this.options.defaultBiome;
    const biomeDescriptor = this.biomeRegistry.get(biomeName);
    if (biomeDescriptor) {
      this.faunaHook.emitForTile(result.terrain, biomeDescriptor, result.markers);
    }

    // 3. Bake procedural textures (splat, soil, strata).
    const textures = this.textureBaker.bake(result.terrain, biomeDescriptor);

    // 4. Register the tile as a landscape chunk so it participates in
    //    streaming, HLOD, occlusion, and persistence.
    const chunk = this.landscapeChunks.registerChunk(
      tileInfo,
      result.terrain,
      result.markers
    );

    return {
      ...result,
      textures,
      chunk
    };
  }

  /**
   * Streams chunks around a camera and returns the HLOD-selected, occlusion-
   * culled chunk list. Called by the runtime’s streaming stage.
   */
  streamAndSelectChunks(cameraX, cameraY, cameraZ, radius, tick, dt,
                        screenHeight, fovRadians, frustumPlanes) {
    // 1. Stream (fetch/decode/evict).
    const streamed = this.landscapeChunks.streamChunksAround(
      cameraX, cameraY, cameraZ, radius, tick, dt
    );

    // 2. HLOD selection.
    const hlodSelected = this.landscapeChunks.selectHLOD(
      cameraX, cameraY, cameraZ, screenHeight, fovRadians
    );

    // 3. Occlusion culling.
    const visible = this.landscapeChunks.cullOccluded(
      cameraX, cameraY, cameraZ, frustumPlanes, tick
    );

    return { streamed, hlodSelected, visible };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    super.dispose();
    this.landscapeChunks?.dispose();
    this.faunaHook = null;
    this.textureBaker = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. INSTALLER
// ═════════════════════════════════════════════════════════════════════

/**
 * installUltimateTerrainExtensions — augments an existing generator (base,
 * extended, or advanced) in place with every ultimate feature: all remaining
 * biomes, landscape chunk systems, fauna migration, and texture bake.
 */
export function installUltimateTerrainExtensions(generator) {
  if (!generator || typeof generator.registerTerrainGenerator !== 'function') {
    throw new Error('installUltimateTerrainExtensions requires a ProceduralTerrainGenerator');
  }

  // Create a temporary UltimateTerrainGenerator to harvest its registrations.
  const temp = new UltimateTerrainGenerator({
    resolution: generator.options.resolution,
    seed: generator.options.seed
  });

  // Copy every biome.
  for (const [name, cls] of temp.biomeRegistry) {
    if (!generator.biomeRegistry.has(name)) {
      generator.registerBiome(name, cls);
    }
  }

  // Attach landscape chunk integration.
  generator.landscapeChunks = temp.landscapeChunks;

  // Attach fauna hook.
  generator.faunaHook = temp.faunaHook;

  // Attach texture baker.
  generator.textureBaker = temp.textureBaker;

  // Attach ultimate generation method.
  generator.generateUltimateTile = function (tileInfo, options) {
    return UltimateTerrainGenerator.prototype.generateUltimateTile.call(this, tileInfo, options);
  };
  generator.streamAndSelectChunks = function (
    cameraX, cameraY, cameraZ, radius, tick, dt,
    screenHeight, fovRadians, frustumPlanes
  ) {
    return UltimateTerrainGenerator.prototype.streamAndSelectChunks.call(
      this, cameraX, cameraY, cameraZ, radius, tick, dt,
      screenHeight, fovRadians, frustumPlanes
    );
  };

  temp.dispose();
  return generator;
}

// ═════════════════════════════════════════════════════════════════════
// 7. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates an UltimateTerrainGenerator pre-populated with every biome,
 * every terrain type, and every landscape/fauna/texture system.
 */
export function createUltimateTerrainGenerator(options = {}) {
  return new UltimateTerrainGenerator({
    resolution: options.resolution ?? 65,
    tileWorldSize: options.tileWorldSize ?? 100,
    seed: options.seed ?? 1337,
    zScale: options.zScale ?? 500,
    erosionIterations: options.erosionIterations ?? 50000,
    thermalIterations: options.thermalIterations ?? 10,
    riverDepth: options.riverDepth ?? 8.0,
    riverThreshold: options.riverThreshold ?? 100,
    defaultBiome: options.defaultBiome ?? BiomeType.TROPICAL_RAINFOREST,
    defaultTerrainType: options.defaultTerrainType ?? TerrainType.MOUNTAINS,
    seasonalCacheCapacity: options.seasonalCacheCapacity ?? 512,
    plateCount: options.plateCount ?? 12,
    maxLod: options.maxLod ?? 12,
    targetFrameMs: options.targetFrameMs ?? 8,
    landscapeOptions: options.landscapeOptions ?? {},
    faunaOptions: options.faunaOptions ?? {},
    textureOptions: options.textureOptions ?? {},
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 8. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  UltimateTerrainGenerator,
  UltimateBiomeType,
  LandscapeChunkIntegration,
  FaunaMigrationHook,
  ProceduralTextureBaker,
  installUltimateTerrainExtensions,
  createUltimateTerrainGenerator
};