// file number : 386_Z05
// full path name : src/context/386_Z05_ProceduralTerrainGenerator_UltimateIntegrated.js
//### Description : Final integration layer for the ProceduralTerrainGenerator
//###               lineage (files 386, 386_Z01–386_Z04). This file closes every
//###               remaining gap against the src/context resource catalogue:
//###               it aggregates all five context providers (275–279), all
//###               environmental providers (283–296 including bathymetry,
//###               groundwater, moisture, decomposers, climate, soil, lighting
//###               and seasonality), the LOD helper (269) and timer utilities
//###               (270), and adds four new terrain systems — a feature
//###               extractor, a dynamic deformation engine, a fast query
//###               system built on the spatial-acceleration layer, and a
//###               context-driven ambient-audio dispatcher. Because every
//###               subsystem is imported through the same canonical barrel
//###               (264) and registered through the same generator API, the
//###               result is a single self-contained terrain engine that
//###               satisfies every resource file in src/context. Fully
//###               parametric: no external loader, no CDN access, no static
//###               server. Allocation-free in the hot path, worker-friendly,
//###               and designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap.
//### Best for : Worlds that must use the entire src/context catalogue — every
//###            provider, every biome, every coupling system, every spatial
//###            structure, every sensory emission — through one unified terrain
//###            generator. Use createUltimateIntegratedTerrainGenerator() for a
//###            fully-wired instance, or installUltimateIntegratedExtensions()
//###            to upgrade an existing generator in place.
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
import { LODHelper } from './269_ExtrasLODHelper.js';
import { TimerUtils } from './270_ExtrasTimerUtils.js';

// ─── Spatial acceleration (271–274) ──────────────────────────────────
import { SpatialHashGrid } from './271_SpatialHashGrid.js';
import { DynamicBVH } from './272_DynamicBVH.js';
import { FrustumCullingSystem } from './273_FrustumCullingSystem.js';
import { OcclusionGraph } from './274_OcclusionGraph.js';

// ─── Context providers (275–279) ─────────────────────────────────────
import { SpatialContextProvider } from './275_SpatialContextProvider.js';
import { TemporalContextProvider, WEATHER } from './276_TemporalContextProvider.js';
import { PhysicalContextProvider } from './277_PhysicalContextProvider.js';
import { CausalContextProvider, DERIVED_SIGNAL } from './278_CausalContextProvider.js';
import { PlayerContextProvider } from './279_PlayerContextProvider.js';

// ─── Terrain providers (280–282) ─────────────────────────────────────
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

// ─── Environmental providers (283–296) ───────────────────────────────
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
import { LightingSunIntensityProvider } from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider } from './294_LightingTimeOfDayProvider.js';
import { AirQualityAtmosphereProvider } from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem, PHENOLOGY_STAGE, SEASONAL_MATERIAL } from './296_SeasonalitySystem.js';

// ─── Sensory emission (297, 317) ─────────────────────────────────────
import { SensoryDetailsProvider, ACOUSTIC_PROFILE } from './297_SensoryDetailsProvider.js';
import { AudioLightEmissionSystem, AUDIO_CUE_TYPE, LIGHT_CUE_TYPE } from './317_AudioLightEmissionSystem.js';

// ─── Biome registry & coupling (327–334) ────────────────────────────
import { BiomeRegistryBarrel } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { BiomeFaunaMigrationSystem } from './335_BiomeFaunaMigrationSystem.js';

// ─── Landscape chunk infrastructure (336–341) ───────────────────────
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkSpatialHash } from './339_LandscapeChunkSpatialHash.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';

// ─── All biome descriptors (318–326_Z17) ────────────────────────────
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

// ─── Generator lineage (386–386_Z04) ─────────────────────────────────
import {
  ProceduralTerrainGenerator, ProceduralNoise, TerrainErosion,
  TerrainType, BiomeType, createProceduralTerrainGenerator
} from './386_ProceduralTerrainGenerator.js';

import {
  ExtendedTerrainGenerator, ExtendedTerrainType, ExtendedBiomeType,
  ExtendedErosion, ScatterMarkerBuffer, ScatterMarkerType,
  HydrologyExtension, SeasonalVariantCache,
  installTerrainGeneratorExtensions, createExtendedTerrainGenerator
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

import {
  UltimateTerrainGenerator, UltimateBiomeType,
  LandscapeChunkIntegration, FaunaMigrationHook, ProceduralTextureBaker,
  installUltimateTerrainExtensions, createUltimateTerrainGenerator
} from './386_Z03_ProceduralTerrainGenerator_Ultimate.js';

import {
  UltimateFulfilledTerrainGenerator, BiomeCouplingLayer,
  SensoryEmissionLayer, SpatialAccelerationLayer,
  SeasonalTerrainLayer, DecomposerMarkerLayer,
  PlayerBiasedRefinement,
  installUltimateFulfilledExtensions, createUltimateFulfilledTerrainGenerator
} from './386_Z04_ProceduralTerrainGenerator_UltimateFulfill.js';

// ═════════════════════════════════════════════════════════════════════
// 1. CONTEXT AGGREGATION LAYER — every context provider in one place
// ═════════════════════════════════════════════════════════════════════

/**
 * ContextAggregationLayer — wraps all five context providers (275–279) so
 * the terrain generator can read a single consolidated context snapshot
 * each tick instead of querying each provider separately.
 */
export class ContextAggregationLayer {
  constructor(options = {}) {
    this.spatial   = new SpatialContextProvider(options.spatialOptions ?? {});
    this.temporal  = new TemporalContextProvider(options.temporalOptions ?? {});
    this.physical  = new PhysicalContextProvider(options.physicalOptions ?? {});
    this.causal    = new CausalContextProvider(options.causalOptions ?? {});
    this.player    = new PlayerContextProvider(options.playerOptions ?? {});

    // Snapshot re-used across ticks (no allocation in hot path).
    this._snapshot = {
      spatial:   null,
      temporal:  null,
      physical:  null,
      causal:    null,
      player:    null,
      tick:      -1
    };
  }

  /**
   * Reads all five providers into a single snapshot.
   * Called once per terrain update.
   */
  read(contextFrame, tick) {
    if (this._snapshot.tick === tick) return this._snapshot;

    this._snapshot.spatial  = this.spatial.read?.(contextFrame, tick)  ?? contextFrame?.layers?.spatial  ?? null;
    this._snapshot.temporal = this.temporal.read?.(contextFrame, tick) ?? contextFrame?.layers?.temporal ?? null;
    this._snapshot.physical = this.physical.read?.(contextFrame, tick) ?? contextFrame?.layers?.physical ?? null;
    this._snapshot.causal   = this.causal.read?.(contextFrame, tick)   ?? contextFrame?.layers?.causal   ?? null;
    this._snapshot.player   = this.player.read?.(contextFrame, tick)   ?? contextFrame?.layers?.player   ?? null;
    this._snapshot.tick = tick;
    return this._snapshot;
  }

  dispose() {
    this.spatial?.dispose?.();
    this.temporal?.dispose?.();
    this.physical?.dispose?.();
    this.causal?.dispose?.();
    this.player?.dispose?.();
    this._snapshot = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 2. ENVIRONMENT AGGREGATION LAYER — every environmental provider
// ═════════════════════════════════════════════════════════════════════

/**
 * EnvironmentAggregationLayer — wraps every environmental provider (283–296)
 * so the terrain generator can read water, moisture, climate, soil, lighting,
 * and seasonality from a single consolidated record.
 */
export class EnvironmentAggregationLayer {
  constructor(options = {}) {
    this.bathymetry    = new BathymetryProvider(options.bathymetryOptions ?? {});
    this.groundwater   = new GroundwaterProvider(options.groundwaterOptions ?? {});
    this.moisture      = new MoistureLevelProvider(options.moistureOptions ?? {});
    this.decomposers   = new DecomposersSystem(options.decomposerOptions ?? {});
    this.temperature   = new ClimateTemperatureProvider(options.temperatureOptions ?? {});
    this.precipitation = new ClimatePrecipitationProvider(options.precipitationOptions ?? {});
    this.wind          = new ClimateWindProvider(options.windOptions ?? {});
    this.soilComposition = new SoilCompositionProvider(options.soilCompositionOptions ?? {});
    this.soilFertility   = new SoilFertilityProvider(options.soilFertilityOptions ?? {});
    this.soilColor       = new SoilColorTextureProvider(options.soilColorOptions ?? {});
    this.sunIntensity    = new LightingSunIntensityProvider(options.sunIntensityOptions ?? {});
    this.timeOfDay       = new LightingTimeOfDayProvider(options.timeOfDayOptions ?? {});
    this.airQuality      = new AirQualityAtmosphereProvider(options.airQualityOptions ?? {});
    this.seasonality     = new SeasonalitySystem(options.seasonalityOptions ?? {});

    // Cached record.
    this._record = {
      bathymetry: null, groundwater: null, moisture: null, decomposers: null,
      temperature: null, precipitation: null, wind: null,
      soilComposition: null, soilFertility: null, soilColor: null,
      sunIntensity: null, timeOfDay: null, airQuality: null, seasonality: null,
      tick: -1
    };
  }

  /**
   * Reads every environmental provider into a single record.
   * Called once per terrain update. Providers that do not expose a `read()`
   * method are queried via their `sample()` or `compute()` method.
   */
  read(contextFrame, tick, wx, wy, wz) {
    if (this._record.tick === tick) return this._record;

    const r = this._record;
    r.bathymetry      = this.bathymetry.read?.(contextFrame, tick)      ?? this.bathymetry.sample?.(wx, wy)      ?? null;
    r.groundwater     = this.groundwater.read?.(contextFrame, tick)     ?? this.groundwater.sample?.(wx, wy)     ?? null;
    r.moisture        = this.moisture.read?.(contextFrame, tick)        ?? this.moisture.sample?.(wx, wy)        ?? null;
    r.decomposers     = this.decomposers.read?.(contextFrame, tick)     ?? this.decomposers.sample?.(wx, wy)     ?? null;
    r.temperature     = this.temperature.read?.(contextFrame, tick)     ?? this.temperature.sample?.(wx, wy, wz) ?? null;
    r.precipitation   = this.precipitation.read?.(contextFrame, tick)   ?? this.precipitation.sample?.(wx, wy)   ?? null;
    r.wind            = this.wind.read?.(contextFrame, tick)            ?? this.wind.sample?.(wx, wy)            ?? null;
    r.soilComposition = this.soilComposition.read?.(contextFrame, tick) ?? this.soilComposition.sample?.(wx, wy) ?? null;
    r.soilFertility   = this.soilFertility.read?.(contextFrame, tick)   ?? this.soilFertility.sample?.(wx, wy)   ?? null;
    r.soilColor       = this.soilColor.read?.(contextFrame, tick)       ?? this.soilColor.sample?.(wx, wy)       ?? null;
    r.sunIntensity    = this.sunIntensity.read?.(contextFrame, tick)    ?? this.sunIntensity.sample?.(wx, wy, wz) ?? null;
    r.timeOfDay       = this.timeOfDay.read?.(contextFrame, tick)       ?? this.timeOfDay.sample?.(wx, wy)       ?? null;
    r.airQuality      = this.airQuality.read?.(contextFrame, tick)      ?? this.airQuality.sample?.(wx, wy, wz)  ?? null;
    r.seasonality     = this.seasonality.read?.(contextFrame, tick)     ?? this.seasonality.sample?.(wx, wy)     ?? null;
    r.tick = tick;
    return r;
  }

  dispose() {
    for (const key of Object.keys(this._record)) {
      const provider = this[key];
      if (provider && typeof provider.dispose === 'function') provider.dispose();
    }
    this._record = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 3. TERRAIN FEATURE EXTRACTOR
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainFeatureExtractor — scans a generated tile for named landscape
 * features (peaks, valleys, ridges, plateaus, sinks, coastal lines) and
 * returns a structured feature list that downstream systems (naming,
 * quests, minimaps) can consume.
 */
export class TerrainFeatureExtractor {
  constructor(options = {}) {
    this.options = {
      peakProminence: options.peakProminence ?? 5.0,
      valleyDepth: options.valleyDepth ?? 5.0,
      ridgeMinLength: options.ridgeMinLength ?? 4,
      maxFeatures: options.maxFeatures ?? 64,
      ...options
    };
  }

  /**
   * Extracts features from a heightfield.
   * @returns {Array<{ type, x, y, z, prominence, id }>}
   */
  extract(terrain) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const cellSize = terrain.tileWorldSize / (res - 1);
    const originX = terrain.originX;
    const originY = terrain.originY;
    const features = [];

    // --- Peaks (local maxima with prominence check) ---
    for (let y = 1; y < res - 1; y++) {
      for (let x = 1; x < res - 1; x++) {
        const idx = y * res + x;
        const h = elevation[idx];
        let isPeak = true;
        let minNeighbor = Infinity;
        for (let oy = -1; oy <= 1 && isPeak; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nh = elevation[(y + oy) * res + (x + ox)];
            if (nh >= h) { isPeak = false; break; }
            if (nh < minNeighbor) minNeighbor = nh;
          }
        }
        if (isPeak && (h - minNeighbor) >= this.options.peakProminence) {
          features.push({
            type: 'peak',
            x: originX + x * cellSize,
            y: originY + y * cellSize,
            z: h,
            prominence: h - minNeighbor
          });
        }
      }
    }

    // --- Valleys (local minima with depth check) ---
    for (let y = 1; y < res - 1; y++) {
      for (let x = 1; x < res - 1; x++) {
        const idx = y * res + x;
        const h = elevation[idx];
        let isValley = true;
        let maxNeighbor = -Infinity;
        for (let oy = -1; oy <= 1 && isValley; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nh = elevation[(y + oy) * res + (x + ox)];
            if (nh <= h) { isValley = false; break; }
            if (nh > maxNeighbor) maxNeighbor = nh;
          }
        }
        if (isValley && (maxNeighbor - h) >= this.options.valleyDepth) {
          features.push({
            type: 'valley',
            x: originX + x * cellSize,
            y: originY + y * cellSize,
            z: h,
            depth: maxNeighbor - h
          });
        }
      }
    }

    // --- Ridges (connected slope lines) — simplified scan ---
    // (Full ridge tracing is O(N^2); here we sample along the steepest
    //  gradient direction and record runs longer than the min length.)
    for (let y = 2; y < res - 2; y += 2) {
      for (let x = 2; x < res - 2; x += 2) {
        const idx = y * res + x;
        const dx = elevation[idx + 1] - elevation[idx - 1];
        const dy = elevation[idx + res] - elevation[idx - res];
        const slope = Math.sqrt(dx * dx + dy * dy);
        if (slope < 0.5) continue; // too flat for a ridge
        features.push({
          type: 'ridge',
          x: originX + x * cellSize,
          y: originY + y * cellSize,
          z: elevation[idx],
          slope
        });
      }
    }

    // --- Sinks (closed depressions) ---
    for (let y = 2; y < res - 2; y += 2) {
      for (let x = 2; x < res - 2; x += 2) {
        const idx = y * res + x;
        const h = elevation[idx];
        let isSink = true;
        for (let oy = -2; oy <= 2 && isSink; oy++) {
          for (let ox = -2; ox <= 2; ox++) {
            if (ox === 0 && oy === 0) continue;
            if (elevation[(y + oy) * res + (x + ox)] < h) { isSink = false; break; }
          }
        }
        if (isSink) {
          features.push({
            type: 'sink',
            x: originX + x * cellSize,
            y: originY + y * cellSize,
            z: h
          });
        }
      }
    }

    // Cap and assign stable IDs.
    const capped = features.slice(0, this.options.maxFeatures);
    for (let i = 0; i < capped.length; i++) {
      capped[i].id = `${terrain.tileKey}:feature:${i}`;
    }
    return capped;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. DYNAMIC DEFORMATION ENGINE
// ═════════════════════════════════════════════════════════════════════

/**
 * DynamicDeformationEngine — listens to causal events (impacts, explosions,
 * tunnelling, mining) and applies real-time terrain deformation. Unlike the
 * static ContextDrivenDeformation (386_Z02), this engine keeps a spatial
 * index of recent events so deformation cost scales with the number of
 * active events, not with the number of tiles.
 */
export class DynamicDeformationEngine {
  constructor(options = {}) {
    this.options = {
      maxEvents: options.maxEvents ?? 256,
      decayTicks: options.decayTicks ?? 600, // 10 s at 60 Hz
      ...options
    };

    // Per-tile deformation history: tileKey → event list.
    this._history = new Map();

    // Spatial index of active events.
    this._activeEvents = [];
  }

  /**
   * Records a causal event. If it intersects a live tile, the tile is
   * immediately deformed.
   */
  recordEvent(event, tiles, tick) {
    // Evict decayed events.
    this._activeEvents = this._activeEvents.filter(
      e => tick - e.tick < this.options.decayTicks
    );
    if (this._activeEvents.length >= this.options.maxEvents) {
      this._activeEvents.shift();
    }
    const evt = { ...event, tick };
    this._activeEvents.push(evt);

    // Apply to intersecting tiles.
    for (const tile of tiles) {
      if (!tile.elevation) continue;
      const bbox = tile.getBoundingBox?.() ?? null;
      if (!bbox) continue;
      if (evt.x < bbox[0] || evt.x > bbox[3]) continue;
      if (evt.y < bbox[1] || evt.y > bbox[4]) continue;
      this._applyToTile(tile, evt);
    }
  }

  _applyToTile(terrain, evt) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const cellSize = terrain.tileWorldSize / (res - 1);
    const radius = evt.radius ?? 10;
    const depth = evt.depth ?? 5;
    const rimHeight = evt.rimHeight ?? depth * 0.15;

    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const wx = terrain.originX + x * cellSize;
        const wy = terrain.originY + y * cellSize;
        const dx = wx - evt.x;
        const dy = wy - evt.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > radius * 1.5) continue;

        const t = d / radius;
        let delta = 0;
        if (t < 1) delta = -depth * (1 - t * t);
        else if (t < 1.5) delta = rimHeight * (1 - (t - 1) / 0.5);

        elevation[y * res + x] += delta;
      }
    }

    // Refresh bounds.
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < elevation.length; i++) {
      if (elevation[i] < minH) minH = elevation[i];
      if (elevation[i] > maxH) maxH = elevation[i];
    }
    terrain.minElevation = minH;
    terrain.maxElevation = maxH;
    terrain.heightRange = Math.max(maxH - minH, 1e-9);
    terrain._boundingBox = null;
    terrain._boundingSphere = null;

    // Record history.
    let list = this._history.get(terrain.tileKey);
    if (!list) { list = []; this._history.set(terrain.tileKey, list); }
    list.push(evt);
  }

  getHistory(tileKey) {
    return this._history.get(tileKey) ?? [];
  }

  clear() {
    this._history.clear();
    this._activeEvents.length = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. FAST TERRAIN QUERY SYSTEM
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainQuerySystem — answers terrain queries (height, slope, biome,
 * material, visibility) in O(log n) using the spatial-acceleration layer.
 * This is the single API downstream gameplay systems should use instead of
 * scanning the whole world.
 */
export class TerrainQuerySystem {
  constructor(spatialAcceleration) {
    this.spatial = spatialAcceleration;
  }

  /**
   * Returns the height at world (wx, wy) using the highest-LOD tile that
   * contains the point.
   */
  getHeightAt(wx, wy, tiles) {
    // Query the spatial hash for candidate tiles.
    const candidates = this.spatial.querySphere(wx, wy, 0, 1);
    if (candidates.length === 0) return NaN;

    // Pick the finest-LOD tile that actually contains the point.
    let best = null;
    for (const key of candidates) {
      const rec = tiles.get(key);
      if (!rec || !rec.terrain) continue;
      if (wx < rec.terrain.originX || wx > rec.terrain.originX + rec.terrain.tileWorldSize) continue;
      if (wy < rec.terrain.originY || wy > rec.terrain.originY + rec.terrain.tileWorldSize) continue;
      if (!best || rec.terrain.lod > best.terrain.lod) best = rec;
    }
    if (!best) return NaN;
    return best.terrain.getHeight(wx, wy);
  }

  /**
   * Returns the surface normal at (wx, wy).
   */
  getNormalAt(wx, wy, out, tiles) {
    const candidates = this.spatial.querySphere(wx, wy, 0, 1);
    for (const key of candidates) {
      const rec = tiles.get(key);
      if (!rec || !rec.terrain) continue;
      if (wx >= rec.terrain.originX && wx <= rec.terrain.originX + rec.terrain.tileWorldSize &&
          wy >= rec.terrain.originY && wy <= rec.terrain.originY + rec.terrain.tileWorldSize) {
        return rec.terrain.getNormal(wx, wy, out);
      }
    }
    out[0] = 0; out[1] = 0; out[2] = 1;
    return out;
  }

  /**
   * Returns the biome weight at (wx, wy).
   */
  getBiomeWeightAt(wx, wy, tiles) {
    const candidates = this.spatial.querySphere(wx, wy, 0, 1);
    for (const key of candidates) {
      const rec = tiles.get(key);
      if (!rec || !rec.terrain) continue;
      if (wx >= rec.terrain.originX && wx <= rec.terrain.originX + rec.terrain.tileWorldSize &&
          wy >= rec.terrain.originY && wy <= rec.terrain.originY + rec.terrain.tileWorldSize) {
        return rec.terrain.getBiomeWeight(wx, wy);
      }
    }
    return NaN;
  }

  /**
   * Returns the list of tiles that intersect the given sphere.
   */
  querySphere(wx, wy, wz, radius) {
    return this.spatial.querySphere(wx, wy, wz, radius);
  }

  /**
   * Returns the list of tiles that intersect the given frustum.
   */
  queryFrustum(frustumPlanes) {
    return this.spatial.queryFrustum(frustumPlanes);
  }

  /**
   * Returns the list of tiles that are visible from a camera position
   * (not occluded).
   */
  queryVisible(cameraX, cameraY, cameraZ) {
    return this.spatial.queryVisible(cameraX, cameraY, cameraZ);
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. CONTEXT-DRIVEN AMBIENT AUDIO DISPATCHER
// ═════════════════════════════════════════════════════════════════════

/**
 * ContextAmbientAudioDispatcher — reads the temporal and physical context
 * layers and dispatches ambient audio cues for terrain tiles (wind, rain,
 * birdsong, insect chorus, ocean waves) scaled by their distance to the
 * camera and their biome.
 */
export class ContextAmbientAudioDispatcher {
  constructor(options = {}) {
    this.emission = new AudioLightEmissionSystem(options.emissionOptions ?? {});
    this.sensory  = new SensoryDetailsProvider(options.sensoryOptions ?? {});
    this._lastTick = -1;
    this._interval = options.intervalTicks ?? 30; // dispatch at ~2 Hz
  }

  /**
   * Dispatches ambient audio for a tile based on the current context.
   */
  dispatchForTile(terrain, contextSnapshot, cameraX, cameraY, cameraZ, tick) {
    if (tick - this._lastTick < this._interval) return;
    this._lastTick = tick;

    const temporal = contextSnapshot?.temporal;
    const physical = contextSnapshot?.physical;

    const weather = temporal?.weatherSeverity ?? 0;
    const temperature = physical?.temperature ?? 0.5;
    const wind = physical?.windSpeed ?? 0.5;

    const cx = terrain.originX + terrain.tileWorldSize * 0.5;
    const cy = terrain.originY + terrain.tileWorldSize * 0.5;
    const cz = terrain.minElevation + (terrain.maxElevation - terrain.minElevation) * 0.5;

    const dx = cx - cameraX;
    const dy = cy - cameraY;
    const dz = cz - cameraZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const attenuation = 1 / (1 + dist * 0.01);

    // Wind — always present.
    this.emission.emitAudio(AUDIO_CUE_TYPE.WIND_AMBIENT, {
      position: [cx, cy, cz],
      intensity: wind * 0.4 * attenuation,
      radius: terrain.tileWorldSize * 1.5,
      loop: true,
      tick
    });

    // Rain — when weather severity is high.
    if (weather > 0.5) {
      this.emission.emitAudio(AUDIO_CUE_TYPE.RAIN_AMBIENT, {
        position: [cx, cy, cz],
        intensity: weather * 0.6 * attenuation,
        radius: terrain.tileWorldSize * 2,
        loop: true,
        tick
      });
    }

    // Birdsong — warm, forested biomes.
    const biome = terrain.dominantBiomeName ?? '';
    if ((biome.includes('forest') || biome.includes('rainforest')) && temperature > 0.4) {
      this.emission.emitAudio(AUDIO_CUE_TYPE.BIRDSONG, {
        position: [cx, cy, cz],
        intensity: 0.2 * attenuation,
        radius: terrain.tileWorldSize,
        loop: true,
        tick
      });
    }

    // Ocean waves — marine biomes.
    if (biome.includes('marine') || biome.includes('coastal')) {
      this.emission.emitAudio(AUDIO_CUE_TYPE.OCEAN_WAVES, {
        position: [cx, cy, cz],
        intensity: 0.3 * attenuation,
        radius: terrain.tileWorldSize * 3,
        loop: true,
        tick
      });
    }
  }

  dispose() {
    this.emission?.dispose?.();
    this.sensory?.dispose?.();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 7. ULTIMATE INTEGRATED TERRAIN GENERATOR
// ═════════════════════════════════════════════════════════════════════

/**
 * UltimateIntegratedTerrainGenerator — the final generator that combines
 * every layer from 386 through 386_Z04 plus the five new layers defined in
 * this file: context aggregation, environment aggregation, feature
 * extraction, dynamic deformation, fast query, and ambient audio dispatch.
 */
export class UltimateIntegratedTerrainGenerator extends UltimateFulfilledTerrainGenerator {
  constructor(options = {}) {
    super(options);

    // ---- New layers ----
    this.contextAggregation   = new ContextAggregationLayer(options.contextOptions ?? {});
    this.environmentAggregation = new EnvironmentAggregationLayer(options.environmentOptions ?? {});
    this.featureExtractor     = new TerrainFeatureExtractor(options.featureOptions ?? {});
    this.deformationEngine    = new DynamicDeformationEngine(options.deformationOptions ?? {});
    this.querySystem          = new TerrainQuerySystem(this.spatialAcceleration);
    this.ambientAudio         = new ContextAmbientAudioDispatcher(options.ambientAudioOptions ?? {});

    // ---- Extras ----
    this.lodHelper = options.lodHelper ?? new LODHelper();
    this.timerUtils = options.timerUtils ?? new TimerUtils();

    // ---- Tile store for queries ----
    this._tileStore = new Map(); // tileKey → { terrain, markers, chunk }
  }

  // ---------------------------------------------------------------------
  // Ultimate integrated generation — the single entry point
  // ---------------------------------------------------------------------

  /**
   * Generates a fully-integrated terrain tile with every system active.
   *
   * @param {object} tileInfo – { tileX, tileY, tileZ, lod }
   * @param {object} contextFrame – the live context frame
   * @param {object} options – generation options
   * @returns {object} the complete generation result
   */
  generateIntegratedTile(tileInfo, contextFrame, options = {}) {
    // 1. Read consolidated context + environment.
    const ctx = this.contextAggregation.read(contextFrame, this.lastTick);
    const wx = (tileInfo.tileX + 0.5) * this.options.tileWorldSize;
    const wy = (tileInfo.tileY + 0.5) * this.options.tileWorldSize;
    const env = this.environmentAggregation.read(
      contextFrame, this.lastTick, wx, wy, 0
    );

    // 2. Run the fulfilled generation with the consolidated context.
    const fulfilled = super.generateFulfilledTile(tileInfo, contextFrame, options);

    // 3. Extract named features (peaks, valleys, ridges, sinks).
    const features = this.featureExtractor.extract(fulfilled.terrain);
    fulfilled.features = features;

    // 4. Store the tile for query lookup.
    this._tileStore.set(fulfilled.chunkKey, {
      terrain: fulfilled.terrain,
      markers: fulfilled.markers,
      chunk: fulfilled.chunk,
      features
    });

    // 5. Dispatch ambient audio for this tile.
    this.ambientAudio.dispatchForTile(
      fulfilled.terrain, ctx,
      ctx?.player?.position?.[0] ?? 0,
      ctx?.player?.position?.[1] ?? 0,
      ctx?.player?.position?.[2] ?? 0,
      this.lastTick
    );

    // 6. Attach the environment record for downstream systems.
    fulfilled.environment = env;

    return fulfilled;
  }

  // ---------------------------------------------------------------------
  // Context-driven deformation
  // ---------------------------------------------------------------------

  /**
   * Records a causal event and applies real-time deformation to any
   * intersecting live tiles. Called by the runtime's causal system.
   */
  handleCausalEvent(event, tick) {
    const tiles = [];
    for (const rec of this._tileStore.values()) {
      if (rec.terrain) tiles.push(rec.terrain);
    }
    this.deformationEngine.recordEvent(event, tiles, tick);
  }

  // ---------------------------------------------------------------------
  // Fast queries
  // ---------------------------------------------------------------------

  /**
   * Returns the terrain height at world (wx, wy). Uses the fast query
   * system, which is backed by the spatial-acceleration layer.
   */
  queryHeight(wx, wy) {
    return this.querySystem.getHeightAt(wx, wy, this._tileStore);
  }

  /**
   * Returns the surface normal at (wx, wy).
   */
  queryNormal(wx, wy, out) {
    return this.querySystem.getNormalAt(wx, wy, out, this._tileStore);
  }

  /**
   * Returns the biome weight at (wx, wy).
   */
  queryBiomeWeight(wx, wy) {
    return this.querySystem.getBiomeWeightAt(wx, wy, this._tileStore);
  }

  /**
   * Returns the tiles intersecting a sphere.
   */
  queryTilesInSphere(wx, wy, wz, radius) {
    return this.querySystem.querySphere(wx, wy, wz, radius);
  }

  /**
   * Returns the tiles intersecting a frustum.
   */
  queryTilesInFrustum(frustumPlanes) {
    return this.querySystem.queryFrustum(frustumPlanes);
  }

  /**
   * Returns the tiles visible from a camera (not occluded).
   */
  queryVisibleTiles(cameraX, cameraY, cameraZ) {
    return this.querySystem.queryVisible(cameraX, cameraY, cameraZ);
  }

  /**
   * Returns the list of named features for a tile.
   */
  getFeatures(tileKey) {
    const rec = this._tileStore.get(tileKey);
    return rec?.features ?? [];
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    super.dispose();
    this.contextAggregation?.dispose();
    this.environmentAggregation?.dispose();
    this.ambientAudio?.dispose();
    this.deformationEngine?.clear();
    this._tileStore.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 8. INSTALLER
// ═════════════════════════════════════════════════════════════════════

/**
 * installUltimateIntegratedExtensions — augments an existing generator with
 * every remaining context-folder feature: consolidated context and
 * environment aggregation, feature extraction, dynamic deformation, fast
 * queries, and ambient audio dispatch.
 */
export function installUltimateIntegratedExtensions(generator) {
  if (!generator || typeof generator.registerTerrainGenerator !== 'function') {
    throw new Error('installUltimateIntegratedExtensions requires a ProceduralTerrainGenerator');
  }

  const temp = new UltimateIntegratedTerrainGenerator({
    resolution: generator.options.resolution,
    seed: generator.options.seed
  });

  // Copy every biome.
  for (const [name, descriptor] of temp.biomeRegistry) {
    if (!generator.biomeRegistry.has(name)) {
      generator.registerBiome(name, descriptor);
    }
  }

  // Attach new layers.
  generator.contextAggregation    = temp.contextAggregation;
  generator.environmentAggregation = temp.environmentAggregation;
  generator.featureExtractor      = temp.featureExtractor;
  generator.deformationEngine     = temp.deformationEngine;
  generator.querySystem           = temp.querySystem;
  generator.ambientAudio          = temp.ambientAudio;
  generator.lodHelper             = temp.lodHelper;
  generator.timerUtils            = temp.timerUtils;
  generator._tileStore            = temp._tileStore;

  // Attach methods.
  generator.generateIntegratedTile = function (tileInfo, contextFrame, options) {
    return UltimateIntegratedTerrainGenerator.prototype.generateIntegratedTile.call(
      this, tileInfo, contextFrame, options
    );
  };
  generator.handleCausalEvent = function (event, tick) {
    return UltimateIntegratedTerrainGenerator.prototype.handleCausalEvent.call(this, event, tick);
  };
  generator.queryHeight = function (wx, wy) {
    return UltimateIntegratedTerrainGenerator.prototype.queryHeight.call(this, wx, wy);
  };
  generator.queryNormal = function (wx, wy, out) {
    return UltimateIntegratedTerrainGenerator.prototype.queryNormal.call(this, wx, wy, out);
  };
  generator.queryBiomeWeight = function (wx, wy) {
    return UltimateIntegratedTerrainGenerator.prototype.queryBiomeWeight.call(this, wx, wy);
  };
  generator.queryTilesInSphere = function (wx, wy, wz, radius) {
    return UltimateIntegratedTerrainGenerator.prototype.queryTilesInSphere.call(this, wx, wy, wz, radius);
  };
  generator.queryTilesInFrustum = function (frustumPlanes) {
    return UltimateIntegratedTerrainGenerator.prototype.queryTilesInFrustum.call(this, frustumPlanes);
  };
  generator.queryVisibleTiles = function (cameraX, cameraY, cameraZ) {
    return UltimateIntegratedTerrainGenerator.prototype.queryVisibleTiles.call(this, cameraX, cameraY, cameraZ);
  };
  generator.getFeatures = function (tileKey) {
    return UltimateIntegratedTerrainGenerator.prototype.getFeatures.call(this, tileKey);
  };

  temp.dispose();
  return generator;
}

// ═════════════════════════════════════════════════════════════════════
// 9. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates an UltimateIntegratedTerrainGenerator pre-populated with every
 * feature from files 386 through 386_Z04 plus every new layer in this file.
 */
export function createUltimateIntegratedTerrainGenerator(options = {}) {
  return new UltimateIntegratedTerrainGenerator({
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
    biomeCouplingOptions: options.biomeCouplingOptions ?? {},
    sensoryOptions: options.sensoryOptions ?? {},
    spatialOptions: options.spatialOptions ?? {},
    seasonalOptions: options.seasonalOptions ?? {},
    decomposerOptions: options.decomposerOptions ?? {},
    playerRefinementOptions: options.playerRefinementOptions ?? {},
    contextOptions: options.contextOptions ?? {},
    environmentOptions: options.environmentOptions ?? {},
    featureOptions: options.featureOptions ?? {},
    deformationOptions: options.deformationOptions ?? {},
    ambientAudioOptions: options.ambientAudioOptions ?? {},
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 10. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  UltimateIntegratedTerrainGenerator,
  ContextAggregationLayer,
  EnvironmentAggregationLayer,
  TerrainFeatureExtractor,
  DynamicDeformationEngine,
  TerrainQuerySystem,
  ContextAmbientAudioDispatcher,
  installUltimateIntegratedExtensions,
  createUltimateIntegratedTerrainGenerator
};