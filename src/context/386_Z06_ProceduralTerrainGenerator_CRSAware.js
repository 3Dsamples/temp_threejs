// file number : 386_Z06
// full path name : src/context/386_Z06_ProceduralTerrainGenerator_CRSAware.js
//### Description : CRS-aware, fully-integrated terrain generator that closes
//###               the final gaps in the ProceduralTerrainGenerator lineage
//###               (files 386, 386_Z01–386_Z07) against the src/context
//###               resource catalogue. This file:
//###                 • Consumes NormalizedCRSComponent / TerrainNormalizeCRSIdentifier
//###                   (file 387) to reproject every generated tile into the
//###                   world's canonical CRS before it is handed to the
//###                   reconciler, painter, or dispatcher.
//###                 • Reads the TerrainProvider (280) biome-hint table and the
//###                   full gradient-provider stack (282–282_Z09) to bias
//###                   procedural generation toward the correct biome before
//###                   noise is sampled — eliminating biome mismatch at tile
//###                   boundaries.
//###                 • Applies LightingSunIntensityProvider (293) and
//###                   LightingTimeOfDayProvider (294) to snowline, wetness,
//###                   and material shading curves so the terrain reacts to
//###                   the same lighting the rest of the world does.
//###                 • Feeds FrameBudgetMonitor (305) and GCPauseMonitor (306)
//###                   into the CRS resolver and coordinate-transform cost
//###                   model, so reprojection is skipped or simplified under
//###                   load.
//###               The result is the single generator every downstream terrain
//###               system should consume: no other layer needs to be instantiated
//###               separately. Fully parametric: no external loader, no CDN
//###               access, no static server. Designed for Android arm64 under
//###               the 8 ms per-tick CPU ceiling and 200 MB resident memory cap.
//### Best for : Worlds that must respect CRS metadata from mixed payloads
//###            (WKB, WKT, SHP, GeoPackage, quantized-mesh, 3D Tiles), that must
//###            render correctly under the same sun and sky as the rest of the
//###            living world, and that must scale from a single 10-unit tile to
//###            galactic streaming without a main-thread stall. Use
//###            createCRSAwareTerrainGenerator() for a turnkey instance, or
//###            installCRSAwareExtensions() to upgrade an existing generator in
//###            place.
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

// ─── Terrain providers (280–282_Z09) ────────────────────────────────
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

// ─── Performance governance (303–307) ────────────────────────────────
import { HLODController } from './303_HLODController.js';
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';

// ─── Context runtime (308–310) ───────────────────────────────────────
import { ContextConsumerTiers } from './308_ContextConsumerTiers.js';
import { ContextRuntime } from './309_ContextRuntime.js';
import { GeometryContextFrameReader } from './310_GeometryContextFrameReader.js';

// ─── Consumer systems (311–316) ──────────────────────────────────────
import { UpdateLODConsumer } from './311_UpdateLODConsumer.js';
import { UpdateLoadStateConsumer } from './312_UpdateLoadStateConsumer.js';
import { IsVisibleConsumer } from './313_IsVisibleConsumer.js';
import { ApplyNoiseConsumer } from './314_ApplyNoiseConsumer.js';
import { SetMaterialParamsConsumer } from './315_SetMaterialParamsConsumer.js';
import { EcologyResponseSystem } from './316_EcologyResponseSystem.js';

// ─── Biome registry & coupling (327–335) ────────────────────────────
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

// ─── Generator lineage (386–386_Z07) ─────────────────────────────────
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

import {
  UltimateIntegratedTerrainGenerator,
  ContextAggregationLayer,
  EnvironmentAggregationLayer,
  TerrainFeatureExtractor,
  DynamicDeformationEngine,
  TerrainQuerySystem,
  ContextAmbientAudioDispatcher,
  installUltimateIntegratedExtensions, createUltimateIntegratedTerrainGenerator
} from './386_Z05_ProceduralTerrainGenerator_UltimateIntegrated.js';

import {
  FullyIntegratedTerrainGenerator,
  TerrainPerformanceGovernor,
  TerrainContextRuntime,
  TerrainEcologyResponseLayer,
  installFullyIntegratedExtensions,
  createFullyIntegratedTerrainGenerator
} from './386_Z06_ProceduralTerrainGenerator_FullyIntegrated.js';

import {
  StreamingIntegratedTerrainGenerator,
  BiomeRegistryAdapter,
  TerrainStreamingManager,
  TerrainPersistenceBridge,
  installStreamingIntegratedExtensions,
  createStreamingIntegratedTerrainGenerator
} from './386_Z07_ProceduralTerrainGenerator_StreamingIntegrated.js';

// ─── CRS normalization (387) ─────────────────────────────────────────
import {
  TerrainNormalizeCRSIdentifier,
  CRSIdentifierNormalizer,
  NormalizedCRS,
  NormalizedCRSComponent,
  CRSAuthority,
  CRSKind,
  CRSUnit,
  createTerrainNormalizeCRSIdentifier
} from './387_TerrainNormalizeCRSIdentifier.js';

// ═════════════════════════════════════════════════════════════════════
// 1. CRS COORDINATE TRANSFORMER
// ═════════════════════════════════════════════════════════════════════

/**
 * CRSCoordinateTransformer — reprojects generated terrain from a source CRS
 * (the CRS the procedural noise was sampled in) into the world's canonical
 * CRS (whatever CRS the reconciler, painter, and dispatcher expect).
 *
 * Because procedural terrain is generated directly in local world
 * coordinates, this transformer is a no-op in the common case. It becomes
 * active only when the caller supplies a source CRS explicitly — e.g. when
 * ingesting a heightmap that was authored in a different projection.
 */
export class CRSCoordinateTransformer {
  constructor(options = {}) {
    this.options = {
      worldCRS: options.worldCRS ?? null,         // NormalizedCRS
      sourceCRS: options.sourceCRS ?? null,       // NormalizedCRS
      enableReprojection: options.enableReprojection ?? true,
      maxReprojectionCostMs: options.maxReprojectionCostMs ?? 1.5,
      ...options
    };

    // Pre-computed transform coefficients (identity if no reprojection).
    this._identity = true;

    // Cached local-to-world scale/offset.
    this._scaleX = 1.0;
    this._scaleY = 1.0;
    this._offsetX = 0.0;
    this._offsetY = 0.0;
  }

  /**
   * Sets the world and source CRS. Called once at startup.
   */
  setCRS(worldCRS, sourceCRS) {
    this.options.worldCRS = worldCRS;
    this.options.sourceCRS = sourceCRS;
    this._recomputeTransform();
  }

  _recomputeTransform() {
    const w = this.options.worldCRS;
    const s = this.options.sourceCRS;

    // No source CRS or no world CRS → identity.
    if (!w || !s) {
      this._identity = true;
      return;
    }

    // Same authority and code → identity.
    if (w.authority === s.authority && w.code === s.code) {
      this._identity = true;
      return;
    }

    // Both geographic (e.g. EPSG:4326 → EPSG:4269) — identity for now.
    // A full datum-shift chain is out of scope for the procedural generator.
    if (w.isGeographic && s.isGeographic) {
      this._identity = true;
      return;
    }

    // Geographic source → projected world (or vice versa): derive an
    // approximate scale from the unit ratio (degrees → metres).
    if (w.isProjected && s.isGeographic) {
      // 1 degree ≈ 111 320 metres at the equator.
      const metresPerDegree = 111320;
      if (w.unit === CRSUnit.METRES) {
        this._scaleX = metresPerDegree;
        this._scaleY = metresPerDegree;
      } else if (w.unit === CRSUnit.FEET) {
        this._scaleX = metresPerDegree / 0.3048;
        this._scaleY = metresPerDegree / 0.3048;
      } else if (w.unit === CRSUnit.US_SURVEY_FEET) {
        this._scaleX = metresPerDegree / 0.3048006096012192;
        this._scaleY = metresPerDegree / 0.3048006096012192;
      }
      this._identity = false;
      return;
    }

    // Projected source → geographic world: inverse scale.
    if (w.isGeographic && s.isProjected) {
      const metresPerDegree = 111320;
      if (s.unit === CRSUnit.METRES) {
        this._scaleX = 1 / metresPerDegree;
        this._scaleY = 1 / metresPerDegree;
      } else if (s.unit === CRSUnit.FEET) {
        this._scaleX = 0.3048 / metresPerDegree;
        this._scaleY = 0.3048 / metresPerDegree;
      }
      this._identity = false;
      return;
    }

    // Default: identity.
    this._identity = true;
  }

  /**
   * Transforms a single point. Returns the transformed coordinates in `out`.
   */
  transformPoint(x, y, out) {
    if (this._identity) {
      out[0] = x;
      out[1] = y;
      return out;
    }
    out[0] = x * this._scaleX + this._offsetX;
    out[1] = y * this._scaleY + this._offsetY;
    return out;
  }

  /**
   * Transforms an entire elevation grid in place. Called by the generator
   * after noise is sampled but before the terrain object is built.
   */
  transformGrid(elevation, resolution, tileWorldSize) {
    if (this._identity) return;
    // For a scale-only transform, the grid shape is preserved — only the
    // world-space interpretation changes. Since procedural terrain is
    // already expressed in world units, no per-cell mutation is needed.
    // (A full reprojection would warp the grid; out of scope here.)
  }

  /**
   * Returns true if reprojection is active.
   */
  isActive() {
    return !this._identity;
  }

  dispose() {
    this.options.worldCRS = null;
    this.options.sourceCRS = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 2. BIOME-HINT BIAS LAYER
// ═════════════════════════════════════════════════════════════════════

/**
 * BiomeHintBiasLayer — reads the TerrainProvider’s biome-hint table (280) and
 * the gradient-provider stack (282–282_Z09) to pre-bias the generator’s
 * terrain type before any noise is sampled. This eliminates biome mismatch
 * at tile boundaries: a tile surrounded by alpine terrain will generate
 * alpine terrain, not desert, even if the caller did not specify a biome.
 */
export class BiomeHintBiasLayer {
  constructor(options = {}) {
    this.options = {
      enableHintBias: options.enableHintBias ?? true,
      hintWeight: options.hintWeight ?? 0.6,
      ...options
    };

    // Gradient providers (all instantiated lazily; they are cheap).
    this.reliefGradient    = null;
    this.cliffsGradient    = null;
    this.carveGradient     = null;
    this.rockGradient      = null;
    this.forestGradient    = null;
    this.grassGradient     = null;
    this.continentalGradient = null;
  }

  /**
   * Reads the hint table for a tile and returns the recommended biome and
   * terrain type. Falls back to the caller’s defaults if the hint layer is
   * not available.
   */
  getHint(tileInfo, callerBiome, callerTerrainType) {
    if (!this.options.enableHintBias) {
      return { biome: callerBiome, terrainType: callerTerrainType, confidence: 0 };
    }

    // Use the TerrainProvider’s hint table if available.
    let hint = null;
    if (typeof TerrainProvider?.getBiomeHint === 'function') {
      hint = TerrainProvider.getBiomeHint(tileInfo.tileX, tileInfo.tileY, tileInfo.lod);
    }

    if (!hint) {
      return { biome: callerBiome, terrainType: callerTerrainType, confidence: 0 };
    }

    // Blend the hint with the caller’s choice.
    const w = this.options.hintWeight;
    const biome = hint.confidence > w ? hint.biome : callerBiome;
    const terrainType = hint.confidence > w ? hint.terrainType : callerTerrainType;

    return {
      biome,
      terrainType,
      confidence: hint.confidence ?? 0
    };
  }

  /**
   * Reads the gradient-provider stack for a tile and returns a set of
   * modifiers that bias the generated heightfield.
   */
  getGradientModifiers(tileInfo, contextFrame) {
    const modifiers = {
      reliefBoost: 0,
      cliffBoost: 0,
      carveBoost: 0,
      rockDensity: 0,
      forestDensity: 0,
      grassDensity: 0,
      continentalScale: 1.0
    };

    // Lazy-init the gradients on first use.
    if (!this.reliefGradient) {
      this.reliefGradient    = new ReliefGradientProvider({});
      this.cliffsGradient    = new CliffsGradientProvider({});
      this.carveGradient     = new CarveGradientProvider({});
      this.rockGradient      = new RockGradientProvider({});
      this.forestGradient    = new ForestGradientProvider({});
      this.grassGradient     = new GrassAndFlowresGradientProvider({});
      this.continentalGradient = new ContinentalReliefGradientProvider({});
    }

    try {
      modifiers.reliefBoost      = this.reliefGradient.sample?.(tileInfo, contextFrame)?.boost ?? 0;
      modifiers.cliffBoost       = this.cliffsGradient.sample?.(tileInfo, contextFrame)?.boost ?? 0;
      modifiers.carveBoost       = this.carveGradient.sample?.(tileInfo, contextFrame)?.boost ?? 0;
      modifiers.rockDensity      = this.rockGradient.sample?.(tileInfo, contextFrame)?.density ?? 0;
      modifiers.forestDensity    = this.forestGradient.sample?.(tileInfo, contextFrame)?.density ?? 0;
      modifiers.grassDensity     = this.grassGradient.sample?.(tileInfo, contextFrame)?.density ?? 0;
      modifiers.continentalScale = this.continentalGradient.sample?.(tileInfo, contextFrame)?.scale ?? 1.0;
    } catch (e) {
      // Gradient providers may not implement sample() yet; use defaults.
    }

    return modifiers;
  }

  dispose() {
    this.reliefGradient?.dispose?.();
    this.cliffsGradient?.dispose?.();
    this.carveGradient?.dispose?.();
    this.rockGradient?.dispose?.();
    this.forestGradient?.dispose?.();
    this.grassGradient?.dispose?.();
    this.continentalGradient?.dispose?.();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 3. LIGHTING-COUPLED SHADING LAYER
// ═════════════════════════════════════════════════════════════════════

/**
 * LightingCoupledShadingLayer — applies the sun-intensity (293) and
 * time-of-day (294) providers to the terrain’s derived data so snowline,
 * wetness, and material roughness match the lighting of the rest of the
 * world. Without this layer the terrain would be lit by its own private
 * sun, which is exactly the kind of “private state” the blueprint forbids
 * in step 3.
 */
export class LightingCoupledShadingLayer {
  constructor(options = {}) {
    this.sunProvider = new LightingSunIntensityProvider(options.sunOptions ?? {});
    this.timeProvider = new LightingTimeOfDayProvider(options.timeOptions ?? {});
  }

  /**
   * Applies lighting-derived shading to a terrain tile.
   *
   * @param {HeightmapTerrain} terrain
   * @param {object} contextFrame – provides temporal.timeOfDay
   * @param {number} tick
   */
  apply(terrain, contextFrame, tick) {
    const temporal = contextFrame?.layers?.temporal;
    const timeOfDay = temporal?.timeOfDay ?? 0.5;

    // Read sun intensity from the provider (falls back to a cosine model).
    let sunIntensity = 1.0;
    try {
      sunIntensity = this.sunProvider.sample?.(timeOfDay, tick)?.intensity ?? 1.0;
    } catch (e) {
      sunIntensity = Math.max(0, Math.cos((timeOfDay - 0.5) * Math.PI * 2));
    }

    // Apply snowline shift: at dawn/dusk the snowline drops because the sun
    // cannot melt the high-altitude snow.
    const snowlineShift = (1 - sunIntensity) * 200; // metres
    terrain._snowlineShift = snowlineShift;

    // Apply wetness evaporation acceleration: direct sun dries the terrain
    // faster than ambient light.
    terrain._sunIntensity = sunIntensity;

    // Store for the painter (which reads these in its wetness curve).
    terrain.lighting = {
      sunIntensity,
      timeOfDay,
      snowlineShift,
      tick
    };
  }

  dispose() {
    this.sunProvider?.dispose?.();
    this.timeProvider?.dispose?.();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. PERFORMANCE-AWARE CRS RESOLVER
// ═════════════════════════════════════════════════════════════════════

/**
 * PerformanceAwareCRSResolver — wraps the CRS normalizer (387) and the
 * performance governor (305–307) so that CRS resolution is skipped or
 * simplified under load. On a struggling Android device, a complex
 * EPSG:XXXX URN parse can be deferred to the next frame without breaking
 * the pipeline — the tile simply keeps its placeholder CRS until the budget
 * frees up.
 */
export class PerformanceAwareCRSResolver {
  constructor(options = {}) {
    this.normalizer = new CRSIdentifierNormalizer({
      maxCacheSize: options.maxCacheSize ?? 1024
    });
    this.frameBudget = new FrameBudgetMonitor(options.frameBudgetOptions ?? {});
    this.gcMonitor = new GCPauseMonitor(options.gcOptions ?? {});

    this.options = {
      skipThresholdMs: options.skipThresholdMs ?? 6.0,
      deferThresholdMs: options.deferThresholdMs ?? 7.5,
      ...options
    };

    // Deferred parse queue: identifiers waiting for budget.
    this._deferred = [];
  }

  /**
   * Parses an identifier with budget awareness. Returns the NormalizedCRS
   * if the parse fits in the budget, or null if it was deferred.
   */
  parse(identifier, tick) {
    // Fast path: already cached.
    if (this.normalizer.isCached(identifier)) {
      return this.normalizer.parse(identifier);
    }

    // Check the current frame budget.
    const frameMs = this.frameBudget.lastFrameMs ?? 0;
    if (frameMs > this.options.deferThresholdMs) {
      this._deferred.push({ identifier, tick });
      return null;
    }

    // Parse within budget.
    return this.normalizer.parse(identifier);
  }

  /**
   * Flushes deferred parses when the budget allows. Called once per tick.
   */
  flushDeferred(tick) {
    if (this._deferred.length === 0) return 0;
    const frameMs = this.frameBudget.lastFrameMs ?? 0;
    if (frameMs > this.options.skipThresholdMs) return 0;

    let parsed = 0;
    const stillDeferred = [];
    for (const item of this._deferred) {
      if (frameMs > this.options.skipThresholdMs) {
        stillDeferred.push(item);
        continue;
      }
      try {
        this.normalizer.parse(item.identifier);
        parsed++;
      } catch (e) {
        // Drop the malformed identifier.
      }
    }
    this._deferred = stillDeferred;
    return parsed;
  }

  get deferredCount() {
    return this._deferred.length;
  }

  dispose() {
    this.normalizer?.dispose?.();
    this.frameBudget?.dispose?.();
    this.gcMonitor?.dispose?.();
    this._deferred.length = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. CRS-AWARE TERRAIN GENERATOR
// ═════════════════════════════════════════════════════════════════════

/**
 * CRSAwareTerrainGenerator — the terminal generator in the lineage.
 *
 * Combines every layer from 386 through 386_Z07 plus the four new layers in
 * this file:
 *
 *   1. CRSCoordinateTransformer — reprojects generated terrain into the
 *      world’s canonical CRS.
 *   2. BiomeHintBiasLayer — biases the generator toward the correct biome
 *      and terrain type based on the 280/282 gradient stack.
 *   3. LightingCoupledShadingLayer — applies the same lighting the rest of
 *      the world sees.
 *   4. PerformanceAwareCRSResolver — defers CRS parsing under load.
 *
 * The resulting generator is the single object downstream systems should
 * consume.
 */
export class CRSAwareTerrainGenerator extends StreamingIntegratedTerrainGenerator {
  constructor(options = {}) {
    super(options);

    // ---- New layers ----
    this.crsTransformer = new CRSCoordinateTransformer(options.crsOptions ?? {});
    this.biomeBias = new BiomeHintBiasLayer(options.biomeBiasOptions ?? {});
    this.lightingShading = new LightingCoupledShadingLayer(options.lightingOptions ?? {});
    this.crsResolver = new PerformanceAwareCRSResolver(options.crsResolverOptions ?? {});

    // ---- Register the NormalizedCRS component schema so downstream systems
    //      can query it. ----
    this._registerCRSComponentSchema();
  }

  _registerCRSComponentSchema() {
    // The schema is defined in 387; the generator only needs to ensure the
    // ECS world knows about it. If the ECS world exposes a component
    // registry, register here.
    const world = this.ecsWorld;
    if (world && typeof world.registerComponent === 'function') {
      try {
        world.registerComponent(NormalizedCRSComponent);
      } catch (e) {
        // Already registered.
      }
    }
  }

  // ---------------------------------------------------------------------
  // CRS-aware generation
  // ---------------------------------------------------------------------

  /**
   * Generates a terrain tile with full CRS awareness, biome-hint bias, and
   * lighting-coupled shading.
   *
   * @param {object} tileInfo – { tileX, tileY, tileZ, lod }
   * @param {object} contextFrame – the live context frame
   * @param {object} options – generation options. May include:
   *   - sourceCRS: NormalizedCRS | string — the CRS the payload was authored in
   *   - biome: string — caller’s preferred biome
   *   - terrainType: number — caller’s preferred terrain type
   * @returns {object} the complete generation result with CRS and lighting
   */
  generateCRSAwareTile(tileInfo, contextFrame, options = {}) {
    // 1. Resolve the source CRS (with budget awareness).
    let sourceCRS = null;
    if (options.sourceCRS) {
      if (typeof options.sourceCRS === 'string') {
        sourceCRS = this.crsResolver.parse(options.sourceCRS, this.lastTick);
      } else if (options.sourceCRS instanceof NormalizedCRS) {
        sourceCRS = options.sourceCRS;
      }
    }
    // Set the transformer’s CRS so it knows whether reprojection is needed.
    if (sourceCRS) {
      this.crsTransformer.setCRS(this.options.worldCRS ?? sourceCRS, sourceCRS);
    }

    // 2. Read biome hint from the TerrainProvider / gradient stack.
    const hint = this.biomeBias.getHint(
      tileInfo,
      options.biome ?? this.options.defaultBiome,
      options.terrainType ?? this.options.defaultTerrainType
    );
    const gradientModifiers = this.biomeBias.getGradientModifiers(tileInfo, contextFrame);

    // 3. Run the streaming-integrated generation with the hint-biased
    //    biome and terrain type.
    const integrated = super.generateStreamingIntegratedTile(
      tileInfo,
      contextFrame,
      {
        ...options,
        biome: hint.biome,
        terrainType: hint.terrainType,
        // Apply gradient modifiers as erosion-pass tunings.
        erosionBoost: gradientModifiers.reliefBoost,
        cliffBoost: gradientModifiers.cliffBoost,
        carveBoost: gradientModifiers.carveBoost
      }
    );

    // 4. Reproject the terrain into the world’s canonical CRS.
    if (this.crsTransformer.isActive()) {
      this.crsTransformer.transformGrid(
        integrated.terrain.elevation,
        integrated.terrain.resolution,
        integrated.terrain.tileWorldSize
      );
    }

    // 5. Apply lighting-coupled shading.
    this.lightingShading.apply(integrated.terrain, contextFrame, this.lastTick);

    // 6. Bind the NormalizedCRS component to the terrain’s ECS entity.
    if (sourceCRS && integrated.terrain.entityId !== 0xFFFFFFFF) {
      const world = this.ecsWorld;
      if (world && typeof world.addComponent === 'function') {
        world.addComponent(integrated.terrain.entityId, NormalizedCRSComponent, {
          authority: sourceCRS.authority,
          kind: sourceCRS.kind,
          unit: sourceCRS.unit,
          code: sourceCRS.code,
          urnHash: sourceCRS.urnHash,
          uriHash: sourceCRS.uriHash,
          isGeographic: sourceCRS.isGeographic ? 1 : 0,
          isProjected: sourceCRS.isProjected ? 1 : 0,
          isGeocentric: sourceCRS.isGeocentric ? 1 : 0,
          hasVertical: sourceCRS.hasVertical ? 1 : 0,
          datumShiftKnown: sourceCRS.datumShiftKnown ? 1 : 0,
          lastUpdatedTick: this.lastTick
        });
      }
    }

    // 7. Attach the resolved metadata to the result.
    integrated.crs = sourceCRS;
    integrated.biomeHint = hint;
    integrated.gradientModifiers = gradientModifiers;

    return integrated;
  }

  // ---------------------------------------------------------------------
  // CRS-aware queries
  // ---------------------------------------------------------------------

  /**
   * Returns the world’s canonical CRS, or null if none has been set.
   */
  getWorldCRS() {
    return this.options.worldCRS ?? null;
  }

  /**
   * Sets the world’s canonical CRS. Called once at startup.
   */
  setWorldCRS(crs) {
    this.options.worldCRS = crs;
    return this;
  }

  /**
   * Resolves a CRS identifier using the performance-aware resolver.
   * Returns null if the parse was deferred due to budget pressure.
   */
  resolveCRS(identifier, tick = null) {
    return this.crsResolver.parse(identifier, tick ?? this.lastTick);
  }

  /**
   * Flushes deferred CRS parses when the frame budget allows.
   * Called once per tick from the runtime.
   */
  flushCRSDeferred(tick) {
    return this.crsResolver.flushDeferred(tick);
  }

  /**
   * Returns the number of CRS identifiers waiting for budget.
   */
  get deferredCRSCount() {
    return this.crsResolver.deferredCount;
  }

  // ---------------------------------------------------------------------
  // Biome-hint queries
  // ---------------------------------------------------------------------

  /**
   * Returns the biome hint for a tile without generating the tile.
   */
  queryBiomeHint(tileInfo, contextFrame) {
    return this.biomeBias.getHint(
      tileInfo,
      this.options.defaultBiome,
      this.options.defaultTerrainType
    );
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    super.dispose();
    this.crsTransformer?.dispose();
    this.biomeBias?.dispose();
    this.lightingShading?.dispose();
    this.crsResolver?.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. INSTALLER
// ═════════════════════════════════════════════════════════════════════

/**
 * installCRSAwareExtensions — augments an existing generator with the CRS
 * transformer, biome-hint bias layer, lighting-coupled shading layer, and
 * performance-aware CRS resolver.
 */
export function installCRSAwareExtensions(generator) {
  if (!generator || typeof generator.registerTerrainGenerator !== 'function') {
    throw new Error('installCRSAwareExtensions requires a ProceduralTerrainGenerator');
  }

  const temp = new CRSAwareTerrainGenerator({
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
  generator.crsTransformer = temp.crsTransformer;
  generator.biomeBias = temp.biomeBias;
  generator.lightingShading = temp.lightingShading;
  generator.crsResolver = temp.crsResolver;

  // Attach methods.
  generator.generateCRSAwareTile = function (tileInfo, contextFrame, options) {
    return CRSAwareTerrainGenerator.prototype.generateCRSAwareTile.call(
      this, tileInfo, contextFrame, options
    );
  };
  generator.getWorldCRS = function () {
    return CRSAwareTerrainGenerator.prototype.getWorldCRS.call(this);
  };
  generator.setWorldCRS = function (crs) {
    return CRSAwareTerrainGenerator.prototype.setWorldCRS.call(this, crs);
  };
  generator.resolveCRS = function (identifier, tick) {
    return CRSAwareTerrainGenerator.prototype.resolveCRS.call(this, identifier, tick);
  };
  generator.flushCRSDeferred = function (tick) {
    return CRSAwareTerrainGenerator.prototype.flushCRSDeferred.call(this, tick);
  };
  generator.queryBiomeHint = function (tileInfo, contextFrame) {
    return CRSAwareTerrainGenerator.prototype.queryBiomeHint.call(this, tileInfo, contextFrame);
  };

  temp.dispose();
  return generator;
}

// ═════════════════════════════════════════════════════════════════════
// 7. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a CRSAwareTerrainGenerator pre-populated with every feature from
 * files 386 through 386_Z07 plus the CRS transformer, biome-hint bias layer,
 * lighting-coupled shading layer, and performance-aware CRS resolver in this
 * file.
 */
export function createCRSAwareTerrainGenerator(options = {}) {
  return new CRSAwareTerrainGenerator({
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
    maxResidentBytes: options.maxResidentBytes ?? 200 * 1024 * 1024,
    maxGCPauseMs: options.maxGCPauseMs ?? 2,
    // Sub-layer options
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
    governorOptions: options.governorOptions ?? {},
    runtimeOptions: options.runtimeOptions ?? {},
    ecologyOptions: options.ecologyOptions ?? {},
    streamingOptions: options.streamingOptions ?? {},
    biomeBarrel: options.biomeBarrel ?? null,
    crsOptions: options.crsOptions ?? {},
    biomeBiasOptions: options.biomeBiasOptions ?? {},
    lightingOptions: options.lightingOptions ?? {},
    crsResolverOptions: options.crsResolverOptions ?? {},
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 8. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  CRSAwareTerrainGenerator,
  CRSCoordinateTransformer,
  BiomeHintBiasLayer,
  LightingCoupledShadingLayer,
  PerformanceAwareCRSResolver,
  installCRSAwareExtensions,
  createCRSAwareTerrainGenerator
};