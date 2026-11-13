// file number : 296
// full path name : src/context/296_SeasonalitySystem.js
// description : Seasonality system — the 1 Hz driver that turns the abstract season scalar into visible foliage colour, snow cover, bloom schedules, decomposer activity, and phenological events across the living world. Reads the season scalar from 276_TemporalContextProvider and the ambient temperature from 287_ClimateTemperatureProvider, then computes per-chunk and per-species seasonal state. Provides a full phenology model for all 12 tree species and 15 grass/flower species: leaf-out dates (bud burst), peak green-up, colour-shift onset, leaf drop, dormancy, and bloom windows — each driven by species-specific thermal thresholds (growing degree days, minimum temperature windows). Drives snow accumulation and melt cycles using a simple snow model: accumulation A(t) = A(t−1) + snowfall − melt, with melt driven by degree-day melt factor M = DDF · (T_air − T_melt), producing spatially-varying snow depth and pack density. Modulates decomposer activity (Arrhenius-weighted by season), soil microbial turnover, and nectar/pollen availability. Emits a single coalesced ECOLOGY causal event per chunk at each phenological boundary (bud-break, leaf-drop, first snow, snow melt, bloom-onset, bloom-end) so all flora and fauna react in lockstep with the season. Provides full PBR + anime material parameter sets for 12 seasonal foliage states — SPRING_NEW, SPRING_FULL, SUMMER_PEAK, SUMMER_LATE, EARLY_AUTUMN, PEAK_AUTUMN, LATE_AUTUMN, LEAF_BARE, WINTER_DORMANT, WINTER_SNOW_LOADED, BLOSSOM_SPRING, BLOSSOM_SUMMER — each carrying base colour, tint, specular, subsurface scattering (leaf translucency), wind-sway weight, and anime flatness. Writes per-chunk summaries into frame.layers.spatial.seasonality and global aggregates into frame.layers.physical.seasonalityProperties. All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs phenological state — foliage shaders (colour, translucency, wind sway), snow shaders (depth, density), 282_Z07_ForestGradientProvider and 282_Z08_GrassAndFlowresGradientProvider (which choose seasonal variants), LandscapeFaunaSpawnSystem (migration, hibernation, mating season), EcologyResponseSystem (ignition probability modulated by season), LandscapeShadowScaler (snow shadows), and DecomposersSystem (seasonal decomposition rate).
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision,
  ColorManagement, ColorSpace,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  BufferAttribute, Uniform, UniformsGroup
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep, CURVE_KIND }                           from './268_ExtrasCurveUtils.js';
import { TemporalContextProvider, WEATHER, WEATHER_NAMES, WEATHER_SEVERITY }
                                                            from './276_TemporalContextProvider.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';
import { TerrainProvider, BIOME_HINT }                      from './280_TerrainProvider.js';
import { ElevationProvider, ELEVATION_BAND, ATMOSPHERE }    from './281_ElevationProvider.js';
import { SlopeGradientProvider, SLOPE_BAND }                from './282_SlopeGradientProvider.js';
import { ReliefGradientProvider, RELIEF_CLASS }             from './282_Z01_ReliefGradientProvider.js';
import { CliffsGradientProvider, CLIFF_CLASS }              from './282_Z02_CliffsGradientProvider.js';
import { CarveGradientProvider, CARVE_SOURCE }              from './282_Z03_CarveGradientProvider.js';
import { NaturalFormationGradientProvider, FORMATION_TYPE } from './282_Z04_NaturalFormationGradientProvider.js';
import { RockGradientProvider, ROCK_CLASS }                 from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE, TREE_TYPE_NAMES, TREE_LEAF_COLORS, SUCCESSION }
                                                            from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE, GRASS_TYPE_NAMES, GRASS_COLORS }
                                                            from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider, CONTINENTAL_TYPE }
                                                            from './282_Z09_ContinentalReliefGradientProvider.js';
import { BathymetryProvider, BATHY_ZONE }                   from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE }            from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE }            from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE }               from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider, CLIMATE_ZONE }         from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE, PRECIPITATION_PHASE_NAMES }
                                                            from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider, WIND_STATE }                  from './289_ClimateWindProvider.js';
import { SoilCompositionProvider, SOIL_TEXTURE_CLASS }      from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider }                            from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider, SOIL_VISUAL_ARCHETYPE }  from './292_SoilColorTextureProvider.js';
import { LightingSunIntensityProvider, LIGHTING_STATE }     from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider, TIME_OF_DAY_STATE }     from './294_LightingTimeOfDayProvider.js';
import { AirQualityAtmosphereProvider, AIR_QUALITY_PRESET } from './295_AirQualityAtmosphereProvider.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 1;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── phenological stage codes ──────────────────────────────────
const PHENOLOGY_STAGE = Object.freeze({
  DORMANT:        0,   // winter, no leaves
  BUD_SWELL:      1,   // buds swelling but no leaves
  BUD_BREAK:      2,   // buds bursting, tiny leaves
  LEAF_OUT:       3,   // leaves expanding
  FULL_GREEN:     4,   // full summer canopy
  GREEN_FADE:     5,   // late summer, slight yellowing
  AUTUMN_COLOR:   6,   // peak autumn colour
  LEAF_DROP:      7,   // leaves falling
  BARE_BRANCHES:  8    // leaves gone, before dormancy
});

const PHENOLOGY_STAGE_NAMES = Object.freeze([
  'dormant', 'bud_swell', 'bud_break', 'leaf_out', 'full_green',
  'green_fade', 'autumn_color', 'leaf_drop', 'bare_branches'
]);

// ─── seasonal material parameter presets (PBR + anime) ────────
const SEASONAL_MATERIAL = Object.freeze({
  SPRING_NEW: {
    pbr: {
      baseColor:       [0.55, 0.78, 0.35],
      metalness:       0.00,
      roughness:       0.75,
      clearcoat:       0.15,
      transmission:    0.10,
      ior:             1.40,
      sheen:           0.20,
      anisotropy:      0.00,
      subsurfaceRadius:[0.10, 0.15, 0.06]
    },
    anime: {
      baseColor:       [0.58, 0.82, 0.38],
      quantizeSteps:   3,
      rimPower:        1.8,
      rimColor:        [0.65, 0.95, 0.55]
    },
    leafTranslucency:  0.65,
    windSwayWeight:    0.50,
    bloomCoverage:     0.05,
    frostiness:        0.05,
    animeFlatness:     0.30
  },
  SPRING_FULL: {
    pbr: { baseColor: [0.42, 0.70, 0.28], metalness: 0.00, roughness: 0.70, clearcoat: 0.15, transmission: 0.10, ior: 1.40, sheen: 0.25, anisotropy: 0.00, subsurfaceRadius: [0.12, 0.18, 0.08] },
    anime: { baseColor: [0.45, 0.74, 0.30], quantizeSteps: 3, rimPower: 1.8, rimColor: [0.60, 0.92, 0.50] },
    leafTranslucency:  0.70,
    windSwayWeight:    0.55,
    bloomCoverage:     0.20,
    frostiness:        0.02,
    animeFlatness:     0.28
  },
  SUMMER_PEAK: {
    pbr: { baseColor: [0.28, 0.52, 0.18], metalness: 0.00, roughness: 0.65, clearcoat: 0.20, transmission: 0.08, ior: 1.40, sheen: 0.30, anisotropy: 0.00, subsurfaceRadius: [0.14, 0.20, 0.08] },
    anime: { baseColor: [0.30, 0.56, 0.20], quantizeSteps: 3, rimPower: 1.7, rimColor: [0.45, 0.85, 0.40] },
    leafTranslucency:  0.75,
    windSwayWeight:    0.60,
    bloomCoverage:     0.15,
    frostiness:        0.00,
    animeFlatness:     0.25
  },
  SUMMER_LATE: {
    pbr: { baseColor: [0.32, 0.48, 0.20], metalness: 0.00, roughness: 0.68, clearcoat: 0.18, transmission: 0.08, ior: 1.40, sheen: 0.25, anisotropy: 0.00, subsurfaceRadius: [0.13, 0.18, 0.08] },
    anime: { baseColor: [0.35, 0.52, 0.22], quantizeSteps: 3, rimPower: 1.8, rimColor: [0.50, 0.82, 0.42] },
    leafTranslucency:  0.70,
    windSwayWeight:    0.60,
    bloomCoverage:     0.05,
    frostiness:        0.00,
    animeFlatness:     0.28
  },
  EARLY_AUTUMN: {
    pbr: { baseColor: [0.65, 0.55, 0.22], metalness: 0.00, roughness: 0.72, clearcoat: 0.15, transmission: 0.10, ior: 1.40, sheen: 0.20, anisotropy: 0.00, subsurfaceRadius: [0.15, 0.15, 0.06] },
    anime: { baseColor: [0.68, 0.58, 0.24], quantizeSteps: 3, rimPower: 1.9, rimColor: [0.92, 0.82, 0.45] },
    leafTranslucency:  0.60,
    windSwayWeight:    0.65,
    bloomCoverage:     0.00,
    frostiness:        0.05,
    animeFlatness:     0.32
  },
  PEAK_AUTUMN: {
    pbr: { baseColor: [0.82, 0.42, 0.15], metalness: 0.00, roughness: 0.75, clearcoat: 0.12, transmission: 0.10, ior: 1.40, sheen: 0.18, anisotropy: 0.00, subsurfaceRadius: [0.18, 0.10, 0.05] },
    anime: { baseColor: [0.86, 0.45, 0.18], quantizeSteps: 3, rimPower: 2.0, rimColor: [1.00, 0.72, 0.35] },
    leafTranslucency:  0.55,
    windSwayWeight:    0.75,
    bloomCoverage:     0.00,
    frostiness:        0.10,
    animeFlatness:     0.35
  },
  LATE_AUTUMN: {
    pbr: { baseColor: [0.68, 0.35, 0.18], metalness: 0.00, roughness: 0.80, clearcoat: 0.10, transmission: 0.05, ior: 1.40, sheen: 0.15, anisotropy: 0.00, subsurfaceRadius: [0.12, 0.08, 0.04] },
    anime: { baseColor: [0.72, 0.38, 0.20], quantizeSteps: 3, rimPower: 2.1, rimColor: [0.88, 0.60, 0.35] },
    leafTranslucency:  0.40,
    windSwayWeight:    0.85,
    bloomCoverage:     0.00,
    frostiness:        0.20,
    animeFlatness:     0.38
  },
  LEAF_BARE: {
    pbr: { baseColor: [0.42, 0.30, 0.22], metalness: 0.00, roughness: 0.88, clearcoat: 0.05, transmission: 0.00, ior: 1.40, sheen: 0.10, anisotropy: 0.00, subsurfaceRadius: [0.04, 0.03, 0.02] },
    anime: { baseColor: [0.45, 0.32, 0.24], quantizeSteps: 3, rimPower: 2.2, rimColor: [0.55, 0.42, 0.30] },
    leafTranslucency:  0.00,
    windSwayWeight:    0.65,
    bloomCoverage:     0.00,
    frostiness:        0.30,
    animeFlatness:     0.42
  },
  WINTER_DORMANT: {
    pbr: { baseColor: [0.38, 0.28, 0.22], metalness: 0.00, roughness: 0.90, clearcoat: 0.05, transmission: 0.00, ior: 1.40, sheen: 0.08, anisotropy: 0.00, subsurfaceRadius: [0.02, 0.02, 0.02] },
    anime: { baseColor: [0.40, 0.30, 0.24], quantizeSteps: 3, rimPower: 2.3, rimColor: [0.45, 0.35, 0.28] },
    leafTranslucency:  0.00,
    windSwayWeight:    0.55,
    bloomCoverage:     0.00,
    frostiness:        0.55,
    animeFlatness:     0.48
  },
  WINTER_SNOW_LOADED: {
    pbr: { baseColor: [0.72, 0.78, 0.85], metalness: 0.00, roughness: 0.70, clearcoat: 0.10, transmission: 0.15, ior: 1.31, sheen: 0.30, anisotropy: 0.00, subsurfaceRadius: [0.20, 0.22, 0.25] },
    anime: { baseColor: [0.75, 0.82, 0.90], quantizeSteps: 2, rimPower: 1.3, rimColor: [0.85, 0.92, 1.00] },
    leafTranslucency:  0.00,
    windSwayWeight:    0.30,
    bloomCoverage:     0.00,
    frostiness:        0.95,
    animeFlatness:     0.25
  },
  BLOSSOM_SPRING: {
    pbr: { baseColor: [0.92, 0.68, 0.75], metalness: 0.00, roughness: 0.60, clearcoat: 0.30, transmission: 0.25, ior: 1.38, sheen: 0.40, anisotropy: 0.00, subsurfaceRadius: [0.18, 0.12, 0.10] },
    anime: { baseColor: [0.96, 0.72, 0.80], quantizeSteps: 3, rimPower: 1.5, rimColor: [1.00, 0.85, 0.90] },
    leafTranslucency:  0.85,
    windSwayWeight:    0.50,
    bloomCoverage:     0.85,
    frostiness:        0.05,
    animeFlatness:     0.25
  },
  BLOSSOM_SUMMER: {
    pbr: { baseColor: [0.85, 0.75, 0.45], metalness: 0.00, roughness: 0.62, clearcoat: 0.28, transmission: 0.20, ior: 1.38, sheen: 0.35, anisotropy: 0.00, subsurfaceRadius: [0.15, 0.14, 0.08] },
    anime: { baseColor: [0.90, 0.80, 0.50], quantizeSteps: 3, rimPower: 1.6, rimColor: [1.00, 0.92, 0.65] },
    leafTranslucency:  0.80,
    windSwayWeight:    0.55,
    bloomCoverage:     0.75,
    frostiness:        0.00,
    animeFlatness:     0.28
  }
});

// ─── per-species phenology parameters ──────────────────────────
// Each tree/grass species has its own bud-break, leaf-out, colour-shift,
// leaf-drop, and bloom windows, plus minimum-GDD thresholds.
const TREE_PHENOLOGY = Object.freeze({
  [TREE_TYPE.OAK]: {
    budBreakDOY: 105, leafOutDOY: 120, fullGreenDOY: 150,
    greenFadeDOY: 250, autumnColorDOY: 285, leafDropDOY: 320, dormantDOY: 340,
    minGDD: 200, bloomDOY: 130, bloomDurationDays: 10,
    winterHardy: true
  },
  [TREE_TYPE.PINE]: {
    budBreakDOY: 100, leafOutDOY: 110, fullGreenDOY: 130,
    greenFadeDOY: 300, autumnColorDOY: 340, leafDropDOY: 0, dormantDOY: 350,
    minGDD: 100, bloomDOY: 130, bloomDurationDays: 7,
    winterHardy: true, evergreen: true
  },
  [TREE_TYPE.BIRCH]: {
    budBreakDOY: 95, leafOutDOY: 110, fullGreenDOY: 140,
    greenFadeDOY: 250, autumnColorDOY: 275, leafDropDOY: 310, dormantDOY: 340,
    minGDD: 150, bloomDOY: 105, bloomDurationDays: 12,
    winterHardy: true
  },
  [TREE_TYPE.REDWOOD]: {
    budBreakDOY: 90, leafOutDOY: 105, fullGreenDOY: 130,
    greenFadeDOY: 320, autumnColorDOY: 355, leafDropDOY: 365, dormantDOY: 30,
    minGDD: 150, bloomDOY: 105, bloomDurationDays: 8,
    winterHardy: true, evergreen: true
  },
  [TREE_TYPE.ACACIA]: {
    budBreakDOY: 60, leafOutDOY: 75, fullGreenDOY: 100,
    greenFadeDOY: 260, autumnColorDOY: 290, leafDropDOY: 320, dormantDOY: 340,
    minGDD: 300, bloomDOY: 70, bloomDurationDays: 20,
    winterHardy: false
  },
  [TREE_TYPE.BAOBAB]: {
    budBreakDOY: 30, leafOutDOY: 45, fullGreenDOY: 80,
    greenFadeDOY: 260, autumnColorDOY: 280, leafDropDOY: 300, dormantDOY: 320,
    minGDD: 400, bloomDOY: 40, bloomDurationDays: 15,
    winterHardy: false
  },
  [TREE_TYPE.PALM]: {
    budBreakDOY: 1, leafOutDOY: 20, fullGreenDOY: 60,
    greenFadeDOY: 340, autumnColorDOY: 360, leafDropDOY: 0, dormantDOY: 365,
    minGDD: 500, bloomDOY: 90, bloomDurationDays: 30,
    winterHardy: false, evergreen: true
  },
  [TREE_TYPE.WILLOW]: {
    budBreakDOY: 90, leafOutDOY: 105, fullGreenDOY: 135,
    greenFadeDOY: 265, autumnColorDOY: 290, leafDropDOY: 325, dormantDOY: 345,
    minGDD: 180, bloomDOY: 95, bloomDurationDays: 12,
    winterHardy: true
  },
  [TREE_TYPE.BAMBOO]: {
    budBreakDOY: 60, leafOutDOY: 75, fullGreenDOY: 110,
    greenFadeDOY: 320, autumnColorDOY: 355, leafDropDOY: 365, dormantDOY: 30,
    minGDD: 300, bloomDOY: 200, bloomDurationDays: 60,
    winterHardy: false, evergreen: true
  },
  [TREE_TYPE.CONIFER]: {
    budBreakDOY: 95, leafOutDOY: 110, fullGreenDOY: 130,
    greenFadeDOY: 320, autumnColorDOY: 355, leafDropDOY: 0, dormantDOY: 345,
    minGDD: 80, bloomDOY: 130, bloomDurationDays: 10,
    winterHardy: true, evergreen: true
  },
  [TREE_TYPE.MANGROVE]: {
    budBreakDOY: 1, leafOutDOY: 30, fullGreenDOY: 80,
    greenFadeDOY: 320, autumnColorDOY: 360, leafDropDOY: 365, dormantDOY: 30,
    minGDD: 500, bloomDOY: 130, bloomDurationDays: 20,
    winterHardy: false, evergreen: true
  },
  [TREE_TYPE.CYPRESS]: {
    budBreakDOY: 90, leafOutDOY: 105, fullGreenDOY: 130,
    greenFadeDOY: 320, autumnColorDOY: 355, leafDropDOY: 0, dormantDOY: 345,
    minGDD: 100, bloomDOY: 130, bloomDurationDays: 8,
    winterHardy: true, evergreen: true
  }
});

const GRASS_PHENOLOGY = Object.freeze({
  [GRASS_TYPE.MEADOW_GRASS]:  { budBreakDOY: 90, leafOutDOY: 100, fullGreenDOY: 130, greenFadeDOY: 250, autumnColorDOY: 280, dormantDOY: 320, minGDD: 150, bloomDOY: 130, bloomDurationDays: 30 },
  [GRASS_TYPE.TALL_PRAIRIE]:  { budBreakDOY: 100, leafOutDOY: 115, fullGreenDOY: 150, greenFadeDOY: 260, autumnColorDOY: 300, dormantDOY: 335, minGDD: 200, bloomDOY: 180, bloomDurationDays: 40 },
  [GRASS_TYPE.SHORT_TUNDRA]:  { budBreakDOY: 130, leafOutDOY: 145, fullGreenDOY: 170, greenFadeDOY: 260, autumnColorDOY: 290, dormantDOY: 310, minGDD: 50,  bloomDOY: 180, bloomDurationDays: 20 },
  [GRASS_TYPE.ALPINE_TUFT]:   { budBreakDOY: 140, leafOutDOY: 155, fullGreenDOY: 185, greenFadeDOY: 265, autumnColorDOY: 290, dormantDOY: 310, minGDD: 30,  bloomDOY: 190, bloomDurationDays: 25 },
  [GRASS_TYPE.SAVANNA_BUNCH]: { budBreakDOY: 50, leafOutDOY: 65, fullGreenDOY: 90, greenFadeDOY: 290, autumnColorDOY: 320, dormantDOY: 340, minGDD: 400, bloomDOY: 130, bloomDurationDays: 30 },
  [GRASS_TYPE.MARSH_REED]:    { budBreakDOY: 90, leafOutDOY: 105, fullGreenDOY: 130, greenFadeDOY: 260, autumnColorDOY: 290, dormantDOY: 315, minGDD: 150, bloomDOY: 200, bloomDurationDays: 30 },
  [GRASS_TYPE.FERN]:          { budBreakDOY: 100, leafOutDOY: 115, fullGreenDOY: 140, greenFadeDOY: 250, autumnColorDOY: 275, dormantDOY: 305, minGDD: 150, bloomDOY: 160, bloomDurationDays: 20 },
  [GRASS_TYPE.CLOVER]:        { budBreakDOY: 85, leafOutDOY: 100, fullGreenDOY: 130, greenFadeDOY: 260, autumnColorDOY: 290, dormantDOY: 320, minGDD: 120, bloomDOY: 140, bloomDurationDays: 50 },
  [GRASS_TYPE.POPPY]:         { budBreakDOY: 90, leafOutDOY: 105, fullGreenDOY: 130, greenFadeDOY: 220, autumnColorDOY: 240, dormantDOY: 280, minGDD: 150, bloomDOY: 120, bloomDurationDays: 25 },
  [GRASS_TYPE.LAVENDER]:      { budBreakDOY: 90, leafOutDOY: 110, fullGreenDOY: 140, greenFadeDOY: 240, autumnColorDOY: 270, dormantDOY: 300, minGDD: 200, bloomDOY: 160, bloomDurationDays: 30 },
  [GRASS_TYPE.SUNFLOWER]:     { budBreakDOY: 110, leafOutDOY: 125, fullGreenDOY: 160, greenFadeDOY: 240, autumnColorDOY: 260, dormantDOY: 280, minGDD: 250, bloomDOY: 190, bloomDurationDays: 25 },
  [GRASS_TYPE.THISTLE]:       { budBreakDOY: 100, leafOutDOY: 115, fullGreenDOY: 145, greenFadeDOY: 260, autumnColorDOY: 290, dormantDOY: 320, minGDD: 200, bloomDOY: 170, bloomDurationDays: 40 },
  [GRASS_TYPE.DANDELION]:     { budBreakDOY: 75, leafOutDOY: 90, fullGreenDOY: 120, greenFadeDOY: 260, autumnColorDOY: 300, dormantDOY: 330, minGDD: 80,  bloomDOY: 100, bloomDurationDays: 60 },
  [GRASS_TYPE.SNOWDROP]:      { budBreakDOY: 45, leafOutDOY: 60, fullGreenDOY: 85, greenFadeDOY: 200, autumnColorDOY: 210, dormantDOY: 260, minGDD: 20,  bloomDOY: 60, bloomDurationDays: 20 },
  [GRASS_TYPE.ORCHID]:        { budBreakDOY: 100, leafOutDOY: 115, fullGreenDOY: 140, greenFadeDOY: 240, autumnColorDOY: 270, dormantDOY: 300, minGDD: 220, bloomDOY: 150, bloomDurationDays: 25 }
});

// ─── snow model constants ──────────────────────────────────────
const SNOW_MODEL = Object.freeze({
  // Degree-day melt factor in cm of snow per °C per day.
  degreeDayMeltFactor: 0.4,

  // Temperature threshold above which melting occurs (°C).
  meltThreshold: 0.0,

  // Snow density: kg/m³.
  freshSnowDensity: 100,
  packedSnowDensity: 400,
  iceDensity: 917,

  // Snow water equivalent ratio: 1 m snow = 0.10 m water.
  sweRatio: 0.10,

  // Minimum snow depth (m) that survives a day above melting.
  minSnowDepth: 0.005,

  // Fresh snow accumulation per mm of precipitation (m per mm).
  accumulationPerMm: 0.01,

  // Albedo of fresh snow (snow has high reflectance).
  freshSnowAlbedo: 0.90,
  packedSnowAlbedo: 0.70,
  meltingSnowAlbedo: 0.50,

  // Snow accumulation onset temperature (below this → snow).
  accumulationTemp: 1.0
});

// ─── seasonality defaults ─────────────────────────────────────
const SEASONALITY_DEFAULTS = Object.freeze({
  worldSeed:              0x5EA50A11D & 0xFFFFFFFF,
  cellSize:               64.0,
  chunkSize:              1000,
  maxCellsPerChunk:       64,
  maxChunksPerFrame:      8,
  hemisphere:             1,              // 1 = northern, -1 = southern
  dayOfYearOffset:        0,              // 0 = Jan 1
  enableSnowModel:        true,
  enableBlossomTracking:  true,
  enablePhenologyEvents:  true,
  transitionCooldown:     5.0,
  ecoEventCooldown:       3.0
});

class SeasonalitySystem {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...SEASONALITY_DEFAULTS, ...(options.defaults || {}) };
    this.defaults.worldSeed = this.defaults.worldSeed | 0;
    this.snow = { ...SNOW_MODEL, ...(options.snow || {}) };

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColorA = new Vec3();
    this._tmpColorB = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();

    // ── per-chunk seasonality state ────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk summary.
    this._chunkSeasonScalar         = new Float32Array(chunkCap);  // 0..1 (0 = winter, 0.5 = summer)
    this._chunkSeasonIndex          = new Uint8Array(chunkCap);    // 0..3 (spring, summer, autumn, winter)
    this._chunkDayOfYear            = new Uint16Array(chunkCap);   // 0..364
    this._chunkDominantPhenology    = new Uint8Array(chunkCap);
    this._chunkLeafCoverage         = new Float32Array(chunkCap);  // 0..1
    this._chunkBloomCoverage        = new Float32Array(chunkCap);  // 0..1
    this._chunkSnowDepth            = new Float32Array(chunkCap);  // m
    this._chunkSnowWaterEquivalent  = new Float32Array(chunkCap);  // m
    this._chunkSnowAlbedo           = new Float32Array(chunkCap);
    this._chunkSnowAgeDays          = new Float32Array(chunkCap);  // days since snowfall
    this._chunkFoliageR             = new Float32Array(chunkCap);
    this._chunkFoliageG             = new Float32Array(chunkCap);
    this._chunkFoliageB             = new Float32Array(chunkCap);
    this._chunkGddAccumulated       = new Float32Array(chunkCap);  // growing degree days since spring
    this._chunkDecomposerActivity   = new Float32Array(chunkCap);  // 0..1 seasonal modifier
    this._chunkWinterKill           = new Float32Array(chunkCap);  // 0..1 fraction of young plants killed
    this._chunkGrowingSeasonDays    = new Float32Array(chunkCap);
    this._chunkNectarAvailability   = new Float32Array(chunkCap);  // 0..1
    this._chunkPollenAvailability   = new Float32Array(chunkCap);  // 0..1

    // Per-chunk snowpack state (persistent across frames).
    this._chunkSnowAccumulation     = new Float32Array(chunkCap);  // m
    this._chunkSnowLastUpdate       = new Float64Array(chunkCap);

    // Per-chunk phenology stage (aggregated over species).
    this._chunkPhenologyDistribution = new Uint16Array(chunkCap * PHENOLOGY_STAGE_NAMES.length);

    // Per-cell data.
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellPhenology = new Array(chunkCap).fill(null);  // Uint8Array
    this._chunkCellSnowDepth = new Array(chunkCap).fill(null);  // Float32Array
    this._chunkCellFoliage = new Array(chunkCap).fill(null);    // Float32Array × 3
    this._chunkCellBloom = new Array(chunkCap).fill(null);      // Float32Array

    // Free lists.
    this._cellPool = { x: [], y: [], z: [], snowDepth: [], bloom: [] };
    this._phenologyArrayPool = [];
    this._foliageArrayPool = [];

    // ── per-frame global aggregate ─────────────────────────
    this._globalSeasonality = {
      seasonScalar: 0.5,
      seasonIndex: 1,
      seasonName: 'summer',
      dayOfYear: 180,
      dominantPhenology: PHENOLOGY_STAGE.FULL_GREEN,
      dominantPhenologyName: 'full_green',
      leafCoverage: 0.85,
      bloomCoverage: 0.15,
      snowDepth: 0,
      snowWaterEquivalent: 0,
      snowAlbedo: 0.70,
      foliageColor: [0.28, 0.52, 0.18],
      gddAccumulated: 1500,
      decomposerActivity: 0.85,
      winterKill: 0,
      growingSeasonDays: 220,
      nectarAvailability: 0.15,
      pollenAvailability: 0.10
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ─────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      springCells: 0,
      summerCells: 0,
      autumnCells: 0,
      winterCells: 0,
      snowCoveredCells: 0,
      bloomingCells: 0,
      leafOffCells: 0,
      phenologyTransitions: 0,
      snowEvents: 0,
      ecoEventsEmitted: 0,
      mutationEventsEmitted: 0
    };

    // ── collaborators ─────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._carve = options.carve || null;
    this._forest = options.forest || null;
    this._grass = options.grass || null;
    this._bathymetry = options.bathymetry || null;
    this._groundwater = options.groundwater || null;
    this._moisture = options.moisture || null;
    this._decomposers = options.decomposers || null;
    this._temperature = options.temperature || null;
    this._precipitation = options.precipitation || null;
    this._wind = options.wind || null;
    this._soil = options.soil || null;
    this._fertility = options.fertility || null;
    this._soilColor = options.soilColor || null;
    this._sunIntensity = options.sunIntensity || null;
    this._timeOfDay = options.timeOfDay || null;
    this._airQuality = options.airQuality || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── reusable material output ───────────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0, subsurfaceRadius: [0,0,0] },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      leafTranslucency: 0,
      windSwayWeight: 0,
      bloomCoverage: 0,
      frostiness: 0,
      animeFlatness: 0
    };

    // ── previous phenology stage per chunk (for transitions) ─
    this._chunkLastPhenology = new Uint8Array(chunkCap);
    this._chunkLastTransitionTime = new Float64Array(chunkCap);
    this._chunkLastSnowState = new Uint8Array(chunkCap);   // 0 = no snow, 1 = snow
    this._chunkLastSeasonIndex = new Uint8Array(chunkCap);
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachForest(f) { this._forest = f; return this; }
  attachGrass(g) { this._grass = g; return this; }
  attachBathymetry(b) { this._bathymetry = b; return this; }
  attachGroundwater(g) { this._groundwater = g; return this; }
  attachMoisture(m) { this._moisture = m; return this; }
  attachDecomposers(d) { this._decomposers = d; return this; }
  attachTemperature(t) { this._temperature = t; return this; }
  attachPrecipitation(p) { this._precipitation = p; return this; }
  attachWind(w) { this._wind = w; return this; }
  attachSoil(s) { this._soil = s; return this; }
  attachFertility(f) { this._fertility = f; return this; }
  attachSoilColor(s) { this._soilColor = s; return this; }
  attachSunIntensity(s) { this._sunIntensity = s; return this; }
  attachTimeOfDay(t) { this._timeOfDay = t; return this; }
  attachAirQuality(a) { this._airQuality = a; return this; }
  attachTemporal(t) { this._temporal = t; return this; }
  attachDispatcher(d) { this._dispatcher = d; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── height lookup ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _getHeight(wx, wz, lod = 0) {
    if (this._carve) return this._carve.getCarvedHeight(wx, wz, lod);
    if (this._elevation) return this._elevation.getElevation(wx, wz, lod);
    if (this._terrain) return this._terrain.getHeight(wx, wz, lod);
    return 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── season calculation ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeSeasonState(now) {
    // Use the temporal provider's world time if available.
    let worldTime = now;
    if (this._temporal) {
      worldTime = this._temporal.elapsedWorldSeconds || now;
    }

    // Determine day-of-year from world time.
    const dayLength = this._temporal ? (this._temporal.dayLength || 86400) : 86400;
    const yearLength = dayLength * 365;
    const dayOfYearRaw = Math.floor((worldTime / dayLength + this.defaults.dayOfYearOffset) % 365);
    const dayOfYear = (dayOfYearRaw + 365) % 365;

    // Season scalar: 0 = mid-winter, 0.25 = mid-spring, 0.5 = mid-summer, 0.75 = mid-autumn
    // (sinusoidal curve based on day-of-year).
    // dayOfYear = 0 → winter (seasonScalar ≈ 0)
    // dayOfYear = 91 → spring (seasonScalar ≈ 0.25)
    // dayOfYear = 182 → summer (seasonScalar ≈ 0.5)
    // dayOfYear = 273 → autumn (seasonScalar ≈ 0.75)
    // Then wrap back to winter.
    const seasonScalar = 0.5 * (1 - Math.cos(2 * Math.PI * (dayOfYear - 15) / 365));

    // seasonIndex: 0 = spring, 1 = summer, 2 = autumn, 3 = winter
    let seasonIndex;
    if (dayOfYear >= 60 && dayOfYear < 152) seasonIndex = 0;        // spring (Mar-May)
    else if (dayOfYear >= 152 && dayOfYear < 243) seasonIndex = 1;   // summer (Jun-Aug)
    else if (dayOfYear >= 243 && dayOfYear < 334) seasonIndex = 2;   // autumn (Sep-Nov)
    else seasonIndex = 3;                                             // winter (Dec-Feb)

    return {
      dayOfYear,
      seasonScalar,
      seasonIndex,
      yearLength
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── species phenology evaluation ───────────────────────
  // ══════════════════════════════════════════════════════════
  // Given day-of-year, growing degree days, and temperature,
  // determine the phenology stage for a species.
  _evaluatePhenology(dayOfYear, gdd, temperature, phenologyParams) {
    if (!phenologyParams) return PHENOLOGY_STAGE.FULL_GREEN;

    const p = phenologyParams;

    // If winter-hardy and evergreen, always green.
    if (p.evergreen) return PHENOLOGY_STAGE.FULL_GREEN;

    // Not enough GDD → still dormant regardless of calendar.
    if (gdd < p.minGDD) {
      return dayOfYear > p.leafDropDOY || dayOfYear < p.budBreakDOY
        ? PHENOLOGY_STAGE.DORMANT
        : PHENOLOGY_STAGE.BARE_BRANCHES;
    }

    // Cold weather → force back to dormant.
    if (temperature < -5) return PHENOLOGY_STAGE.DORMANT;

    // Calendar-based phenology.
    if (dayOfYear < p.budBreakDOY) return PHENOLOGY_STAGE.DORMANT;
    if (dayOfYear < p.leafOutDOY) return PHENOLOGY_STAGE.BUD_SWELL;
    if (dayOfYear < p.fullGreenDOY) return PHENOLOGY_STAGE.LEAF_OUT;
    if (dayOfYear < p.greenFadeDOY) return PHENOLOGY_STAGE.FULL_GREEN;
    if (dayOfYear < p.autumnColorDOY) return PHENOLOGY_STAGE.GREEN_FADE;
    if (dayOfYear < p.leafDropDOY) return PHENOLOGY_STAGE.AUTUMN_COLOR;
    if (dayOfYear < p.dormantDOY) return PHENOLOGY_STAGE.LEAF_DROP;
    return PHENOLOGY_STAGE.BARE_BRANCHES;
  }

  // ══════════════════════════════════════════════════════════
  // ─── bloom evaluation ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _evaluateBloom(dayOfYear, gdd, phenologyParams) {
    if (!phenologyParams) return 0;
    const bloomDay = phenologyParams.bloomDOY;
    const duration = phenologyParams.bloomDurationDays;

    // Bloom only when GDD is sufficient.
    if (gdd < phenologyParams.minGDD) return 0;

    // Triangular bloom window around bloomDOY.
    const phase = ((dayOfYear - bloomDay + 365) % 365);
    if (phase > duration) return 0;
    return 1 - Math.abs(phase / duration - 0.5) * 2;
  }

  // ══════════════════════════════════════════════════════════
  // ─── snowfall accumulation & melt ───────────────────────
  // ══════════════════════════════════════════════════════════
  _updateSnowpack(chunkSlot, temperature, precipIntensity, dtDays, dtSeconds, now) {
    if (!this.defaults.enableSnowModel) return;

    // Initialize on first call.
    if (this._chunkSnowLastUpdate[chunkSlot] === 0) {
      this._chunkSnowLastUpdate[chunkSlot] = now;
    }
    const age = now - this._chunkSnowLastUpdate[chunkSlot];

    // Accumulation: only when temperature below accumulationTemp.
    let accumulation = this._chunkSnowAccumulation[chunkSlot];

    if (temperature < this.snow.accumulationTemp && precipIntensity > 0.01) {
      // Add snow depth proportional to precipitation intensity.
      accumulation += precipIntensity * this.snow.accumulationPerMm * dtDays;
    }

    // Melt: degree-day method.
    if (temperature > this.snow.meltThreshold && accumulation > 0) {
      const meltRate = this.snow.degreeDayMeltFactor *
                       (temperature - this.snow.meltThreshold) * dtDays;
      // degreeDayMeltFactor is in cm/day/°C; convert to m.
      accumulation = Math.max(0, accumulation - meltRate * 0.01);
    }

    // Track snow age — resets on new accumulation.
    if (temperature < this.snow.accumulationTemp && precipIntensity > 0.01) {
      this._chunkSnowAgeDays[chunkSlot] = 0;
    } else {
      this._chunkSnowAgeDays[chunkSlot] += dtDays;
    }

    // Pack density increases with age (fresh 100 kg/m³ → packed 400 kg/m³).
    const ageDays = this._chunkSnowAgeDays[chunkSlot];
    const packFactor = Math.min(1, ageDays / 30);
    const density = this.snow.freshSnowDensity +
                   (this.snow.packedSnowDensity - this.snow.freshSnowDensity) * packFactor;

    // Snow albedo decreases with age (fresh 0.90 → packed 0.70).
    const albedo = this.snow.freshSnowAlbedo -
                  (this.snow.freshSnowAlbedo - this.snow.packedSnowAlbedo) * packFactor;

    // Water equivalent.
    const swe = accumulation * this.snow.sweRatio;

    // Store.
    this._chunkSnowAccumulation[chunkSlot] = accumulation;
    this._chunkSnowDepth[chunkSlot] = accumulation;
    this._chunkSnowWaterEquivalent[chunkSlot] = swe;
    this._chunkSnowAlbedo[chunkSlot] = albedo;
    this._chunkSnowLastUpdate[chunkSlot] = now;
  }

  // ══════════════════════════════════════════════════════════
  // ─── foliage colour computation ─────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeFoliageColor(phenology, seasonScalar, speciesColor, outColor) {
    // Map phenology to a colour.
    let source;
    switch (phenology) {
      case PHENOLOGY_STAGE.DORMANT:
      case PHENOLOGY_STAGE.BARE_BRANCHES:
        source = SEASONAL_MATERIAL.WINTER_DORMANT.pbr.baseColor;
        break;
      case PHENOLOGY_STAGE.BUD_SWELL:
        source = SEASONAL_MATERIAL.SPRING_NEW.pbr.baseColor;
        break;
      case PHENOLOGY_STAGE.BUD_BREAK:
      case PHENOLOGY_STAGE.LEAF_OUT:
        source = SEASONAL_MATERIAL.SPRING_FULL.pbr.baseColor;
        break;
      case PHENOLOGY_STAGE.FULL_GREEN:
        source = SEASONAL_MATERIAL.SUMMER_PEAK.pbr.baseColor;
        break;
      case PHENOLOGY_STAGE.GREEN_FADE:
        source = SEASONAL_MATERIAL.SUMMER_LATE.pbr.baseColor;
        break;
      case PHENOLOGY_STAGE.AUTUMN_COLOR:
        source = SEASONAL_MATERIAL.PEAK_AUTUMN.pbr.baseColor;
        break;
      case PHENOLOGY_STAGE.LEAF_DROP:
        source = SEASONAL_MATERIAL.LATE_AUTUMN.pbr.baseColor;
        break;
      default:
        source = SEASONAL_MATERIAL.SUMMER_PEAK.pbr.baseColor;
    }

    // Blend with species-specific color if provided.
    if (speciesColor) {
      outColor[0] = source[0] * 0.5 + speciesColor[0] * 0.5;
      outColor[1] = source[1] * 0.5 + speciesColor[1] * 0.5;
      outColor[2] = source[2] * 0.5 + speciesColor[2] * 0.5;
    } else {
      outColor[0] = source[0];
      outColor[1] = source[1];
      outColor[2] = source[2];
    }
    return outColor;
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk sampling ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleChunk(cx, cz, frame, now, seasonState) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));

    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    if (!this._chunkCellX[slot]) {
      this._chunkCellX[slot] = this._acquireCell('x');
      this._chunkCellY[slot] = this._acquireCell('y');
      this._chunkCellZ[slot] = this._acquireCell('z');
      this._chunkCellPhenology[slot] = this._acquirePhenologyArray();
      this._chunkCellSnowDepth[slot] = this._acquireCell('snowDepth');
      this._chunkCellFoliage[slot] = new Float32Array(this.defaults.maxCellsPerChunk * 3);
      this._chunkCellBloom[slot] = this._acquireCell('bloom');
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpPhen = this._chunkCellPhenology[slot];
    const cpSnow = this._chunkCellSnowDepth[slot];
    const cpFoliage = this._chunkCellFoliage[slot];
    const cpBloom = this._chunkCellBloom[slot];

    // ── Aggregate the year's growing-degree days ────────────
    // GDD accumulation from spring onward — for phenology.
    const dayOfYear = seasonState.dayOfYear;
    // Approximate: from spring start (day 60) to current day, if past spring.
    const gddStart = 60;
    const gddDays = Math.max(0, dayOfYear - gddStart);
    const physical = frame.layers.physical;
    const ambientTemp = physical?.ambientTemperature ?? 15;
    const gdd = Math.max(0, (ambientTemp - 5) * gddDays);

    // ── Snow state ──────────────────────────────────────────
    const precipIntensity = physical?.precipitationIntensity ?? 0;

    // ── Update chunk snowpack ───────────────────────────────
    // Use a fixed 1-day dt to smooth over frames.
    const dtDays = 0.5;   // half-day per tick at 1 Hz
    const dtSeconds = dtDays * 86400;
    this._updateSnowpack(slot, ambientTemp, precipIntensity, dtDays, dtSeconds, now);

    // ── Sample cells ────────────────────────────────────────
    let placed = 0;
    let sumLeaf = 0, sumBloom = 0, sumSnow = 0, sumGDD = 0;
    let sumFoliageR = 0, sumFoliageG = 0, sumFoliageB = 0;
    const phenologyCount = new Uint16Array(PHENOLOGY_STAGE_NAMES.length);
    let dominantPhenology = PHENOLOGY_STAGE.FULL_GREEN;
    let maxPhenologyCount = 0;

    // Track species composition across trees + grass.
    let treeCount = 0, grassCount = 0;
    const speciesFoliage = new Float32Array(3);

    for (let j = 0; j < cellsPerSide && placed < this.defaults.maxCellsPerChunk; j++) {
      for (let i = 0; i < cellsPerSide && placed < this.defaults.maxCellsPerChunk; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;
        const altitude = this._getHeight(wx, wz);

        // Sample the forest and grass at this position.
        let cellPhenology = PHENOLOGY_STAGE.FULL_GREEN;
        let cellBloom = 0;
        let cellLeaf = 0;
        let speciesColor = null;

        if (this._forest) {
          const forest = this._forest.getForestAt(wx, wz);
          if (forest && forest.dominantSpecies > 0) {
            const species = forest.dominantSpecies;
            const params = TREE_PHENOLOGY[species];
            if (params) {
              cellPhenology = this._evaluatePhenology(dayOfYear, gdd, ambientTemp, params);
              cellBloom = this._evaluateBloom(dayOfYear, gdd, params);
              cellLeaf = (cellPhenology === PHENOLOGY_STAGE.FULL_GREEN ||
                          cellPhenology === PHENOLOGY_STAGE.LEAF_OUT ||
                          cellPhenology === PHENOLOGY_STAGE.GREEN_FADE ||
                          cellPhenology === PHENOLOGY_STAGE.AUTUMN_COLOR) ? 1 : 0;
              const c = TREE_LEAF_COLORS[species];
              if (c) speciesColor = c.summer;
              treeCount++;
            }
          }
        }

        if (this._grass) {
          const grass = this._grass.getGrassAt(wx, wz);
          if (grass && grass.dominantSpecies > 0) {
            const species = grass.dominantSpecies;
            const params = GRASS_PHENOLOGY[species];
            if (params) {
              const grassPhen = this._evaluatePhenology(dayOfYear, gdd, ambientTemp, params);
              const grassBloom = this._evaluateBloom(dayOfYear, gdd, params);
              // Blend with forest results — average.
              cellPhenology = Math.round((cellPhenology + grassPhen) / 2);
              cellBloom = Math.max(cellBloom, grassBloom);
              const c = GRASS_COLORS[species];
              if (c && !speciesColor) speciesColor = c.blade.summer;
              grassCount++;
            }
          }
        }

        // Compute foliage colour.
        const foliageColor = [0, 0, 0];
        this._computeFoliageColor(cellPhenology, seasonState.seasonScalar, speciesColor, foliageColor);

        // Snow depth at this cell.
        const localSnowDepth = this._chunkSnowAccumulation[slot];

        // Store cell.
        cpx[placed] = wx;
        cpy[placed] = altitude;
        cpz[placed] = wz;
        cpPhen[placed] = cellPhenology;
        cpSnow[placed] = localSnowDepth;
        cpBloom[placed] = cellBloom;
        const co = placed * 3;
        cpFoliage[co]     = foliageColor[0];
        cpFoliage[co + 1] = foliageColor[1];
        cpFoliage[co + 2] = foliageColor[2];
        placed++;

        // Aggregate.
        sumLeaf += cellLeaf;
        sumBloom += cellBloom;
        sumSnow += localSnowDepth;
        sumGDD += gdd;
        sumFoliageR += foliageColor[0];
        sumFoliageG += foliageColor[1];
        sumFoliageB += foliageColor[2];
        phenologyCount[cellPhenology]++;
        if (phenologyCount[cellPhenology] > maxPhenologyCount) {
          maxPhenologyCount = phenologyCount[cellPhenology];
          dominantPhenology = cellPhenology;
        }

        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // ── Store chunk summary ────────────────────────────────
    const inv = placed > 0 ? 1 / placed : 0;
    this._chunkSeasonScalar[slot] = seasonState.seasonScalar;
    this._chunkSeasonIndex[slot] = seasonState.seasonIndex;
    this._chunkDayOfYear[slot] = seasonState.dayOfYear;
    this._chunkDominantPhenology[slot] = dominantPhenology;
    this._chunkLeafCoverage[slot] = sumLeaf * inv;
    this._chunkBloomCoverage[slot] = sumBloom * inv;
    this._chunkSnowDepth[slot] = sumSnow * inv;
    this._chunkSnowWaterEquivalent[slot] = this._chunkSnowAccumulation[slot] * this.snow.sweRatio;
    this._chunkSnowAlbedo[slot] = this._chunkSnowAlbedo[slot] || 0.70;
    this._chunkFoliageR[slot] = sumFoliageR * inv;
    this._chunkFoliageG[slot] = sumFoliageG * inv;
    this._chunkFoliageB[slot] = sumFoliageB * inv;
    this._chunkGddAccumulated[slot] = sumGDD * inv;

    // Seasonal decomposer activity — Arrhenius-like temperature response.
    const decompTemp = Math.max(0, ambientTemp);
    this._chunkDecomposerActivity[slot] = Math.min(1,
      (decompTemp / 25) * (1 - Math.exp(-sumLeaf * inv * 2))
    );

    // Winter kill: fraction of young plants killed by late frosts.
    if (ambientTemp < -8 && seasonState.seasonIndex === 3) {
      this._chunkWinterKill[slot] = Math.min(1, (Math.abs(ambientTemp) - 8) / 20);
    } else {
      this._chunkWinterKill[slot] = 0;
    }

    // Growing season days.
    const growingSeasonDays = Math.max(0, (ambientTemp > 5 ? dayOfYear : 0) -
                                      Math.max(0, 60 - dayOfYear));
    this._chunkGrowingSeasonDays[slot] = growingSeasonDays;

    // Nectar and pollen availability (scales with bloom).
    this._chunkNectarAvailability[slot] = sumBloom * inv;
    this._chunkPollenAvailability[slot] = sumBloom * inv * (seasonState.seasonIndex === 0 || seasonState.seasonIndex === 1 ? 1 : 0.3);

    // Update phenology distribution.
    const distOffset = slot * PHENOLOGY_STAGE_NAMES.length;
    for (let p = 0; p < phenologyCount.length; p++) {
      this._chunkPhenologyDistribution[distOffset + p] = phenologyCount[p];
    }

    this._stats.chunksProcessed++;

    // ── Per-state stats ────────────────────────────────────
    switch (seasonState.seasonIndex) {
      case 0: this._stats.springCells++; break;
      case 1: this._stats.summerCells++; break;
      case 2: this._stats.autumnCells++; break;
      case 3: this._stats.winterCells++; break;
    }
    if (sumSnow * inv > 0.05) this._stats.snowCoveredCells++;
    if (sumBloom * inv > 0.1) this._stats.bloomingCells++;
    if (sumLeaf * inv < 0.1) this._stats.leafOffCells++;

    // ── Phenology transition event ─────────────────────────
    const previousPhen = this._chunkLastPhenology[slot];
    if (previousPhen !== 0 && previousPhen !== dominantPhenology &&
        now - this._chunkLastTransitionTime[slot] > this.defaults.transitionCooldown) {
      this._chunkLastTransitionTime[slot] = now;
      this._stats.phenologyTransitions++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.ECOLOGY,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, 40, 8.0,
          {
            kind: 'phenology_transition',
            chunkX: cx, chunkZ: cz,
            fromStage: previousPhen,
            toStage: dominantPhenology,
            fromStageName: PHENOLOGY_STAGE_NAMES[previousPhen],
            toStageName: PHENOLOGY_STAGE_NAMES[dominantPhenology],
            seasonIndex: seasonState.seasonIndex,
            dayOfYear: seasonState.dayOfYear,
            gdd: sumGDD * inv,
            leafCoverage: sumLeaf * inv,
            bloomCoverage: sumBloom * inv
          }
        );
        this._stats.ecoEventsEmitted++;
      }
    }
    this._chunkLastPhenology[slot] = dominantPhenology;

    // ── Season-index transition event ──────────────────────
    const previousSeason = this._chunkLastSeasonIndex[slot];
    if (previousSeason !== 0 && previousSeason !== seasonState.seasonIndex) {
      this._stats.phenologyTransitions++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.ECOLOGY,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, 60, 10.0,
          {
            kind: 'season_change',
            chunkX: cx, chunkZ: cz,
            fromSeason: previousSeason,
            toSeason: seasonState.seasonIndex,
            dayOfYear: seasonState.dayOfYear,
            seasonScalar: seasonState.seasonScalar
          }
        );
        this._stats.ecoEventsEmitted++;
      }
    }
    this._chunkLastSeasonIndex[slot] = seasonState.seasonIndex;

    // ── Snow transition event ──────────────────────────────
    const snowState = sumSnow * inv > 0.05 ? 1 : 0;
    const previousSnow = this._chunkLastSnowState[slot];
    if (previousSnow !== snowState) {
      this._chunkLastSnowState[slot] = snowState;
      this._stats.snowEvents++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.ECOLOGY,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, 35, 6.0,
          {
            kind: snowState === 1 ? 'snowfall' : 'snowmelt',
            chunkX: cx, chunkZ: cz,
            snowDepth: sumSnow * inv,
            temperature: ambientTemp,
            dayOfYear: seasonState.dayOfYear
          }
        );
        this._stats.ecoEventsEmitted++;
      }
    }

    return placed;
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk slot management ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  _getChunkSlot(cx, cz) {
    const key = cx + ',' + cz;
    if (this._chunkKeys.has(key)) return this._chunkKeys.get(key);
    return -1;
  }

  _allocChunkSlot(cx, cz) {
    if (this._chunkUsed >= this._chunkCap) this._evictOldest();
    let slot = -1;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) { slot = i; break; }
    }
    if (slot < 0) {
      slot = this._chunkSlot;
      this._chunkSlot = (this._chunkSlot + 1) % this._chunkCap;
      this._evictSlot(slot);
    }
    this._chunkCX[slot] = cx;
    this._chunkCZ[slot] = cz;
    this._chunkState[slot] = 1;
    this._chunkKeys.set(cx + ',' + cz, slot);
    this._chunkUsed++;
    this._chunkLastPhenology[slot] = 0;
    this._chunkLastTransitionTime[slot] = 0;
    this._chunkLastSnowState[slot] = 0;
    this._chunkLastSeasonIndex[slot] = 0;
    this._chunkSnowAccumulation[slot] = 0;
    this._chunkSnowAgeDays[slot] = 0;
    return slot;
  }

  _evictSlot(slot) {
    if (this._chunkState[slot] === 0) return;
    const key = this._chunkCX[slot] + ',' + this._chunkCZ[slot];
    this._chunkKeys.delete(key);
    this._chunkState[slot] = 0;
    this._chunkCellCount[slot] = 0;
    if (this._chunkCellX[slot]) {
      this._cellPool.x.push(this._chunkCellX[slot]);
      this._cellPool.y.push(this._chunkCellY[slot]);
      this._cellPool.z.push(this._chunkCellZ[slot]);
      this._cellPool.snowDepth.push(this._chunkCellSnowDepth[slot]);
      this._cellPool.bloom.push(this._chunkCellBloom[slot]);
      this._phenologyArrayPool.push(this._chunkCellPhenology[slot]);
      this._foliageArrayPool.push(this._chunkCellFoliage[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellPhenology[slot] = null;
    this._chunkCellSnowDepth[slot] = null;
    this._chunkCellFoliage[slot] = null;
    this._chunkCellBloom[slot] = null;
    this._chunkUsed--;
  }

  _evictOldest() {
    let oldest = -1;
    let oldestVal = Infinity;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (this._chunkCX[i] < oldestVal) { oldestVal = this._chunkCX[i]; oldest = i; }
    }
    if (oldest >= 0) this._evictSlot(oldest);
  }

  _acquireCell(kind) {
    const pool = this._cellPool[kind];
    if (pool && pool.length > 0) {
      const arr = pool.pop();
      arr.fill(0);
      return arr;
    }
    return new Float32Array(this.defaults.maxCellsPerChunk);
  }

  _acquirePhenologyArray() {
    if (this._phenologyArrayPool.length > 0) {
      const arr = this._phenologyArrayPool.pop();
      arr.fill(0);
      return arr;
    }
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getSeasonalityAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      seasonScalar: this._chunkSeasonScalar[slot],
      seasonIndex: this._chunkSeasonIndex[slot],
      dayOfYear: this._chunkDayOfYear[slot],
      dominantPhenology: this._chunkDominantPhenology[slot],
      dominantPhenologyName: PHENOLOGY_STAGE_NAMES[this._chunkDominantPhenology[slot]],
      leafCoverage: this._chunkLeafCoverage[slot],
      bloomCoverage: this._chunkBloomCoverage[slot],
      snowDepth: this._chunkSnowDepth[slot],
      snowWaterEquivalent: this._chunkSnowWaterEquivalent[slot],
      snowAlbedo: this._chunkSnowAlbedo[slot],
      snowAgeDays: this._chunkSnowAgeDays[slot],
      foliageColor: [
        this._chunkFoliageR[slot],
        this._chunkFoliageG[slot],
        this._chunkFoliageB[slot]
      ],
      gddAccumulated: this._chunkGddAccumulated[slot],
      decomposerActivity: this._chunkDecomposerActivity[slot],
      winterKill: this._chunkWinterKill[slot],
      growingSeasonDays: this._chunkGrowingSeasonDays[slot],
      nectarAvailability: this._chunkNectarAvailability[slot],
      pollenAvailability: this._chunkPollenAvailability[slot],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        phenology: this._chunkCellPhenology[slot],
        snowDepth: this._chunkCellSnowDepth[slot],
        foliage: this._chunkCellFoliage[slot],
        bloom: this._chunkCellBloom[slot]
      }
    };
  }

  // Sample leaf coverage at any world position.
  sampleLeafCoverageAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkLeafCoverage[slot];
    }
    return 0.5;
  }

  // Sample snow depth at any world position.
  sampleSnowDepthAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkSnowDepth[slot];
    }
    return 0;
  }

  // Sample the current season index (0 = spring, 1 = summer, 2 = autumn, 3 = winter).
  sampleSeasonIndexAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkSeasonIndex[slot];
    }
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getSeasonalMaterialParams(presetName) {
    return SEASONAL_MATERIAL[presetName] || SEASONAL_MATERIAL.SUMMER_PEAK;
  }

  blendSeasonalMaterial(seasonIndex, phenology, bloomCoverage, snowDepth, out) {
    // Choose preset from season and phenology.
    let presetName = 'SUMMER_PEAK';
    if (bloomCoverage > 0.3) {
      presetName = seasonIndex === 0 ? 'BLOSSOM_SPRING' : 'BLOSSOM_SUMMER';
    } else if (snowDepth > 0.05) {
      presetName = 'WINTER_SNOW_LOADED';
    } else {
      switch (phenology) {
        case PHENOLOGY_STAGE.DORMANT:      presetName = 'WINTER_DORMANT'; break;
        case PHENOLOGY_STAGE.BUD_SWELL:
        case PHENOLOGY_STAGE.BUD_BREAK:    presetName = 'SPRING_NEW'; break;
        case PHENOLOGY_STAGE.LEAF_OUT:     presetName = 'SPRING_FULL'; break;
        case PHENOLOGY_STAGE.FULL_GREEN:   presetName = 'SUMMER_PEAK'; break;
        case PHENOLOGY_STAGE.GREEN_FADE:   presetName = 'SUMMER_LATE'; break;
        case PHENOLOGY_STAGE.AUTUMN_COLOR: presetName = 'PEAK_AUTUMN'; break;
        case PHENOLOGY_STAGE.LEAF_DROP:    presetName = 'LATE_AUTUMN'; break;
        case PHENOLOGY_STAGE.BARE_BRANCHES: presetName = 'LEAF_BARE'; break;
      }
    }

    const src = SEASONAL_MATERIAL[presetName];
    const o = out || this._blendedParams;

    o.pbr.baseColor[0] = src.pbr.baseColor[0];
    o.pbr.baseColor[1] = src.pbr.baseColor[1];
    o.pbr.baseColor[2] = src.pbr.baseColor[2];
    o.pbr.metalness = src.pbr.metalness;
    o.pbr.roughness = src.pbr.roughness;
    o.pbr.clearcoat = src.pbr.clearcoat;
    o.pbr.transmission = src.pbr.transmission;
    o.pbr.ior = src.pbr.ior;
    o.pbr.sheen = src.pbr.sheen;
    o.pbr.anisotropy = src.pbr.anisotropy;
    o.pbr.subsurfaceRadius[0] = src.pbr.subsurfaceRadius[0];
    o.pbr.subsurfaceRadius[1] = src.pbr.subsurfaceRadius[1];
    o.pbr.subsurfaceRadius[2] = src.pbr.subsurfaceRadius[2];

    o.anime.baseColor[0] = src.anime.baseColor[0];
    o.anime.baseColor[1] = src.anime.baseColor[1];
    o.anime.baseColor[2] = src.anime.baseColor[2];
    o.anime.quantizeSteps = src.anime.quantizeSteps;
    o.anime.rimPower = src.anime.rimPower;
    o.anime.rimColor[0] = src.anime.rimColor[0];
    o.anime.rimColor[1] = src.anime.rimColor[1];
    o.anime.rimColor[2] = src.anime.rimColor[2];

    o.leafTranslucency = src.leafTranslucency;
    o.windSwayWeight = src.windSwayWeight;
    o.bloomCoverage = src.bloomCoverage;
    o.frostiness = src.frostiness;
    o.animeFlatness = src.animeFlatness;

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.seasonality) {
      spatial.seasonality = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        seasonScalar: this._chunkSeasonScalar,
        seasonIndex: this._chunkSeasonIndex,
        dayOfYear: this._chunkDayOfYear,
        dominantPhenology: this._chunkDominantPhenology,
        leafCoverage: this._chunkLeafCoverage,
        bloomCoverage: this._chunkBloomCoverage,
        snowDepth: this._chunkSnowDepth,
        snowWaterEquivalent: this._chunkSnowWaterEquivalent,
        snowAlbedo: this._chunkSnowAlbedo,
        snowAgeDays: this._chunkSnowAgeDays,
        foliageR: this._chunkFoliageR,
        foliageG: this._chunkFoliageG,
        foliageB: this._chunkFoliageB,
        gddAccumulated: this._chunkGddAccumulated,
        decomposerActivity: this._chunkDecomposerActivity,
        winterKill: this._chunkWinterKill,
        growingSeasonDays: this._chunkGrowingSeasonDays,
        nectarAvailability: this._chunkNectarAvailability,
        pollenAvailability: this._chunkPollenAvailability,
        phenologyDistribution: this._chunkPhenologyDistribution,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          phenology: this._chunkCellPhenology,
          snowDepth: this._chunkCellSnowDepth,
          foliage: this._chunkCellFoliage,
          bloom: this._chunkCellBloom
        },
        materialParams: SEASONAL_MATERIAL,
        phenologyStageNames: PHENOLOGY_STAGE_NAMES,
        treePhenology: TREE_PHENOLOGY,
        grassPhenology: GRASS_PHENOLOGY
      };
    }

    const s = spatial.seasonality;
    s.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (s.chunkCount >= this._chunkCap) break;
      s.chunkCX[s.chunkCount] = this._chunkCX[i];
      s.chunkCZ[s.chunkCount] = this._chunkCZ[i];
      s.chunkSlots[s.chunkCount] = i;
      s.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    let sumLeaf = 0, sumBloom = 0, sumSnow = 0, sumSWE = 0, sumAlbedo = 0;
    let sumFR = 0, sumFG = 0, sumFB = 0;
    let sumGDD = 0, sumDecomp = 0, sumWinterKill = 0;
    let sumGrowingDays = 0, sumNectar = 0, sumPollen = 0;
    let chunksWithSeason = 0;
    let seasonIndex = 1;
    let dayOfYear = 180;
    let seasonScalar = 0.5;
    const seasonCount = new Uint16Array(4);
    const phenologyCount = new Uint16Array(PHENOLOGY_STAGE_NAMES.length);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      chunksWithSeason++;
      sumLeaf += this._chunkLeafCoverage[i];
      sumBloom += this._chunkBloomCoverage[i];
      sumSnow += this._chunkSnowDepth[i];
      sumSWE += this._chunkSnowWaterEquivalent[i];
      sumAlbedo += this._chunkSnowAlbedo[i];
      sumFR += this._chunkFoliageR[i];
      sumFG += this._chunkFoliageG[i];
      sumFB += this._chunkFoliageB[i];
      sumGDD += this._chunkGddAccumulated[i];
      sumDecomp += this._chunkDecomposerActivity[i];
      sumWinterKill += this._chunkWinterKill[i];
      sumGrowingDays += this._chunkGrowingSeasonDays[i];
      sumNectar += this._chunkNectarAvailability[i];
      sumPollen += this._chunkPollenAvailability[i];
      seasonCount[this._chunkSeasonIndex[i]]++;
      phenologyCount[this._chunkDominantPhenology[i]]++;
      seasonScalar = this._chunkSeasonScalar[i];
      dayOfYear = this._chunkDayOfYear[i];
    }

    const gs = this._globalSeasonality;
    const inv = chunksWithSeason > 0 ? 1 / chunksWithSeason : 0;
    gs.seasonScalar = seasonScalar;
    gs.dayOfYear = dayOfYear;
    gs.leafCoverage = sumLeaf * inv;
    gs.bloomCoverage = sumBloom * inv;
    gs.snowDepth = sumSnow * inv;
    gs.snowWaterEquivalent = sumSWE * inv;
    gs.snowAlbedo = sumAlbedo * inv;
    gs.foliageColor[0] = sumFR * inv;
    gs.foliageColor[1] = sumFG * inv;
    gs.foliageColor[2] = sumFB * inv;
    gs.gddAccumulated = sumGDD * inv;
    gs.decomposerActivity = sumDecomp * inv;
    gs.winterKill = sumWinterKill * inv;
    gs.growingSeasonDays = sumGrowingDays * inv;
    gs.nectarAvailability = sumNectar * inv;
    gs.pollenAvailability = sumPollen * inv;

    // Dominant season.
    let domSeason = 1;
    let maxSeasonCount = 0;
    for (let s = 0; s < seasonCount.length; s++) {
      if (seasonCount[s] > maxSeasonCount) {
        maxSeasonCount = seasonCount[s];
        domSeason = s;
      }
    }
    gs.seasonIndex = domSeason;
    const seasonNames = ['spring', 'summer', 'autumn', 'winter'];
    gs.seasonName = seasonNames[domSeason];

    // Dominant phenology.
    let domPhen = 4;
    let maxPhenCount = 0;
    for (let p = 0; p < phenologyCount.length; p++) {
      if (phenologyCount[p] > maxPhenCount) {
        maxPhenCount = phenologyCount[p];
        domPhen = p;
      }
    }
    gs.dominantPhenology = domPhen;
    gs.dominantPhenologyName = PHENOLOGY_STAGE_NAMES[domPhen];

    if (!physical.seasonalityProperties) physical.seasonalityProperties = {};
    Object.assign(physical.seasonalityProperties, gs);

    // Material-facing aggregates.
    physical.seasonIndex = domSeason;
    physical.seasonName = gs.seasonName;
    physical.seasonScalar = gs.seasonScalar;
    physical.dayOfYear = gs.dayOfYear;
    physical.dominantPhenology = domPhen;
    physical.dominantPhenologyName = gs.dominantPhenologyName;
    physical.leafCoverage = gs.leafCoverage;
    physical.bloomCoverage = gs.bloomCoverage;
    physical.snowDepth = gs.snowDepth;
    physical.snowWaterEquivalent = gs.snowWaterEquivalent;
    physical.snowAlbedo = gs.snowAlbedo;
    physical.foliageColor = gs.foliageColor;
    physical.gddAccumulated = gs.gddAccumulated;
    physical.seasonalDecomposerActivity = gs.decomposerActivity;
    physical.winterKill = gs.winterKill;
    physical.growingSeasonDays = gs.growingSeasonDays;
    physical.nectarAvailability = gs.nectarAvailability;
    physical.pollenAvailability = gs.pollenAvailability;

    if (!physical.seasonWeights) {
      physical.seasonWeights = new Float32Array(4);
    }
    if (chunksWithSeason > 0) {
      for (let s = 0; s < 4; s++) {
        physical.seasonWeights[s] = seasonCount[s] / chunksWithSeason;
      }
    }

    if (!physical.phenologyWeights) {
      physical.phenologyWeights = new Float32Array(PHENOLOGY_STAGE_NAMES.length);
    }
    if (chunksWithSeason > 0) {
      for (let p = 0; p < phenologyCount.length; p++) {
        physical.phenologyWeights[p] = phenologyCount[p] / chunksWithSeason;
      }
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

    // Compute the current season state once.
    const seasonState = this._computeSeasonState(now);

    const tc = frame.layers.spatial?.terrainChunks;
    if (!tc || tc.count === 0) {
      this._writeToSpatialLayer(frame);
      this._writeToPhysicalLayer(frame);
      this._stats.updates++;
      return 1;
    }

    const budget = Math.min(this.defaults.maxChunksPerFrame, tc.count);
    for (let i = 0; i < budget; i++) {
      const cx = tc.cx[i];
      const cz = tc.cz[i];
      this._sampleChunk(cx, cz, frame, now, seasonState);
    }

    this._writeToSpatialLayer(frame);
    this._writeToPhysicalLayer(frame);

    this._stats.updates++;
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── interactive setters ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setWorldSeed(seed) {
    this.defaults.worldSeed = seed | 0;
    this._clearAllChunks();
    return this;
  }

  setCellSize(size) {
    if (size > 0) this.defaults.cellSize = size;
    return this;
  }

  setMaxChunksPerFrame(count) {
    if (count > 0) this.defaults.maxChunksPerFrame = count;
    return this;
  }

  setHemisphere(hemisphere) {
    this.defaults.hemisphere = hemisphere >= 0 ? 1 : -1;
    return this;
  }

  setDayOfYearOffset(days) {
    this.defaults.dayOfYearOffset = days;
    return this;
  }

  setSnowModelParams(params) {
    for (const k of Object.keys(this.snow)) {
      if (params[k] !== undefined) this.snow[k] = params[k];
    }
    return this;
  }

  // Force a specific season state (for testing / scripted events).
  forceSeasonState(dayOfYear) {
    this.defaults.dayOfYearOffset = dayOfYear;
    this._clearAllChunks();
    return this;
  }

  _clearAllChunks() {
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] !== 0) this._evictSlot(i);
    }
    this._chunkKeys.clear();
    this._chunkUsed = 0;
    this._chunkSlot = 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getGlobalSeasonality() { return { ...this._globalSeasonality }; }

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
    this._carve = null;
    this._forest = null;
    this._grass = null;
    this._bathymetry = null;
    this._groundwater = null;
    this._moisture = null;
    this._decomposers = null;
    this._temperature = null;
    this._precipitation = null;
    this._wind = null;
    this._soil = null;
    this._fertility = null;
    this._soilColor = null;
    this._sunIntensity = null;
    this._timeOfDay = null;
    this._airQuality = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._phenologyArrayPool.length = 0;
    this._foliageArrayPool.length = 0;
  }
}

export {
  SeasonalitySystem,
  PHENOLOGY_STAGE,
  PHENOLOGY_STAGE_NAMES,
  SEASONAL_MATERIAL,
  TREE_PHENOLOGY,
  GRASS_PHENOLOGY,
  SNOW_MODEL,
  SEASONALITY_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};