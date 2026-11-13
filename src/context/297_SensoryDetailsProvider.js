// file number : 297
// full path name : src/context/297_SensoryDetailsProvider.js
// description : Sensory details provider — the bridge between the physical world simulated by every provider upstream and the human senses of sight-adjacent audio, smell, and tactile feel. Fuses data from 282_Z06 (rock acoustic profiles), 282_Z07 (tree species + leaf rustle), 282_Z08 (grass sway + insect habitat), 282_Z09 (continental scale), 283 (water flow acoustic + spray), 284 (spring gurgle + groundwater smell), 285 (humidity + dew tactile), 286 (decomposer decay smell + fungal spore), 287–289 (temperature, precipitation, wind — for wind howl, rain patter, snow hush), 290–292 (soil tactile + damp-earth smell), 293–295 (lighting + air quality), and 296 (seasonal scent of bloom/leaf-fall) into 12 sensory dimensions per chunk: acoustic (biological / geological / water / wind / vegetation / mechanical), olfactory (floral / earthy / aquatic / woodland / smoke / animal / decay / sulfur / sea / clean), and tactile (temperature, humidity, wind pressure, precipitation, ground hardness). Each dimension produces a per-chunk sensory descriptor with intensity (0..1), dominant cue ID, secondary cue IDs, decay time, and per-cell proximity weighting. Fuses acoustic profiles from materials (each material class has an acousticSignature: leaf rustle, water gurgle, rock echo, soil thud, metal clank, flesh squelch) into a spatially-aware acoustic signature per chunk using inverse-distance-weighted blending from the nearest 8 material sources. Provides a full PBR + anime material parameter set for 10 sensory archetypes (SILENT_DEEP_FOREST, BREEZY_MEADOW, ROARING_WATERFALL, STORMY_COAST, VOLCANIC_FUMAROLE, DEEP_CAVE, ARID_WASTELAND, TROPICAL_JUNGLE, SUBALPINE_WOODLAND, DECAYING_SWAMP) — each with ambient colour tint, particle density (pollen/dust/spores/mist/spray), and anime flatness — that the visual shader reads to add atmospheric motes and tint. Emits a single coalesced AUDIO_LIGHT causal event per chunk when the dominant acoustic or olfactory cue changes (e.g. bird song → wolf howl, floral → decay). Writes per-chunk summaries into frame.layers.spatial.sensory and per-entity exposure into frame.layers.physical.sensoryState. All scratch objects are pooled; no allocation after the first frame.
// best for : Audio engine (ambient sound beds, trigger sound events, spatial mix), particle systems (pollen motes, dust, fungal spores, mist), material shaders (subtle atmospheric tint, particle density), player HUD (stress/tension via smell of predator, warmth via temperature), fauna behaviour (predator/prey scent detection), and any AI that needs to know "what does this place feel, smell, and sound like". Complements every prior provider — this is the final layer that turns simulation into experience.
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
import { CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND }
                                                            from './282_Z03_CarveGradientProvider.js';
import { NaturalFormationGradientProvider, FORMATION_TYPE } from './282_Z04_NaturalFormationGradientProvider.js';
import { RockGradientProvider, ROCK_CLASS, ROCK_CLASS_NAMES, ROCK_PROPERTIES }
                                                            from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE, TREE_TYPE_NAMES, SUCCESSION }
                                                            from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE, GRASS_TYPE_NAMES }
                                                            from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider, CONTINENTAL_TYPE }
                                                            from './282_Z09_ContinentalReliefGradientProvider.js';
import { BathymetryProvider, BATHY_ZONE, SEABED_CLASS, SEABED_CLASS_NAMES }
                                                            from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE, GROUNDWATER_TYPE_NAMES }
                                                            from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE }            from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE, DECOMPOSER_TYPE_NAMES }
                                                            from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider, CLIMATE_ZONE }         from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE, PRECIPITATION_PHASE_NAMES }
                                                            from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider, WIND_STATE, WIND_STATE_NAMES } from './289_ClimateWindProvider.js';
import { SoilCompositionProvider, SOIL_TEXTURE_CLASS }      from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider, FERTILITY_CLASS }           from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider, SOIL_VISUAL_ARCHETYPE }  from './292_SoilColorTextureProvider.js';
import { LightingSunIntensityProvider, LIGHTING_STATE }     from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider, TIME_OF_DAY_STATE }     from './294_LightingTimeOfDayProvider.js';
import { AirQualityAtmosphereProvider, AIR_QUALITY_PRESET } from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem, PHENOLOGY_STAGE, PHENOLOGY_STAGE_NAMES }
                                                            from './296_SeasonalitySystem.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 2;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── acoustic cue codes ────────────────────────────────────────
const ACOUSTIC_CUE = Object.freeze({
  SILENCE:          0,
  BIRD_SONG:        1,
  INSECT_BUZZ:      2,
  ANIMAL_CALL:      3,
  WOLF_HOWL:        4,
  FROG_CROAK:       5,
  CRICKET_CHIRP:    6,
  LEAF_RUSTLE:      7,
  GRASS_SWISH:      8,
  BRANCH_CREAK:     9,
  BAMBOO_CLATTER:  10,
  WATER_TRICKLE:   11,
  RIVER_FLOW:      12,
  WATERFALL_ROAR:  13,
  OCEAN_WAVES:     14,
  WET_STONE_DRIP:  15,
  RAIN_PATTER:     16,
  THUNDER:         17,
  WIND_BREEZE:     18,
  WIND_HOWL:       19,
  STORM_GUST:      20,
  ROCK_FALL:       21,
  AVALANCHE:       22,
  GEYSER_ERUPTION: 23,
  VOLCANIC_RUMBLE: 24,
  FIRE_CRACKLE:    25,
  SNOW_HUSH:       26,
  ICE_CRACK:       27,
  FOLIAGE_SILENCE: 28,
  MACHINE_HUM:     29
});

const ACOUSTIC_CUE_NAMES = Object.freeze([
  'silence', 'bird_song', 'insect_buzz', 'animal_call', 'wolf_howl',
  'frog_croak', 'cricket_chirp', 'leaf_rustle', 'grass_swish',
  'branch_creak', 'bamboo_clatter', 'water_trickle', 'river_flow',
  'waterfall_roar', 'ocean_waves', 'wet_stone_drip', 'rain_patter',
  'thunder', 'wind_breeze', 'wind_howl', 'storm_gust', 'rock_fall',
  'avalanche', 'geyser_eruption', 'volcanic_rumble', 'fire_crackle',
  'snow_hush', 'ice_crack', 'foliage_silence', 'machine_hum'
]);

// ─── olfactory cue codes ───────────────────────────────────────
const OLFACTORY_CUE = Object.freeze({
  NEUTRAL:      0,
  FLORAL:       1,
  POLLEN:       2,
  NECTAR:       3,
  WET_EARTH:    4,
  HUMUS:        5,
  SOIL:         6,
  PINE_RESIN:   7,
  LEAF_LITTER:  8,
  DECAYING_WOOD:9,
  MOSS:        10,
  FERN_GREEN:  11,
  FRESH_WATER: 12,
  SALT_SPRAY:  13,
  MARINE:      14,
  SMOKE:       15,
  SULFUR:      16,
  HOT_SPRING:  17,
  ANIMAL_MUSK: 18,
  PREDATOR:    19,
  ROTTING:     20,
  FUNGAL:      21,
  BLOOD:       22,
  OZONE:       23,
  ALPINE_CLEAN:24,
  STORM_AIR:   25,
  CAMPFIRE:    26
});

const OLFACTORY_CUE_NAMES = Object.freeze([
  'neutral', 'floral', 'pollen', 'nectar', 'wet_earth', 'humus',
  'soil', 'pine_resin', 'leaf_litter', 'decaying_wood', 'moss',
  'fern_green', 'fresh_water', 'salt_spray', 'marine', 'smoke',
  'sulfur', 'hot_spring', 'animal_musk', 'predator', 'rotting',
  'fungal', 'blood', 'ozone', 'alpine_clean', 'storm_air', 'campfire'
]);

// ─── sensory archetypes ────────────────────────────────────────
const SENSORY_ARCHETYPE = Object.freeze({
  SILENT_DEEP_FOREST:  0,
  BREEZY_MEADOW:       1,
  ROARING_WATERFALL:   2,
  STORMY_COAST:        3,
  VOLCANIC_FUMAROLE:   4,
  DEEP_CAVE:           5,
  ARID_WASTELAND:      6,
  TROPICAL_JUNGLE:     7,
  SUBALPINE_WOODLAND:  8,
  DECAYING_SWAMP:      9
});

const SENSORY_ARCHETYPE_NAMES = Object.freeze([
  'silent_deep_forest', 'breezy_meadow', 'roaring_waterfall',
  'stormy_coast', 'volcanic_fumarole', 'deep_cave',
  'arid_wasteland', 'tropical_jungle', 'subalpine_woodland',
  'decaying_swamp'
]);

// ─── sensory archetype material presets (PBR + anime) ─────────
// Drives atmospheric tint and particle emission per archetype.
const SENSORY_MATERIAL = Object.freeze({
  [SENSORY_ARCHETYPE.SILENT_DEEP_FOREST]: {
    pbr: {
      baseColor:       [0.20, 0.30, 0.15],
      metalness:       0.00,
      roughness:       1.00,
      clearcoat:       0.00,
      transmission:    0.30,
      ior:             1.00,
      sheen:           0.00,
      anisotropy:      0.00,
      extinction:      [0.10, 0.10, 0.10]
    },
    anime: {
      baseColor:       [0.22, 0.32, 0.17],
      quantizeSteps:   3,
      rimPower:        2.0,
      rimColor:        [0.35, 0.50, 0.28]
    },
    particleDensity:   0.15,
    particleKind:      'pollen',
    ambientTint:       [0.35, 0.45, 0.30],
    animeFlatness:     0.35
  },
  [SENSORY_ARCHETYPE.BREEZY_MEADOW]: {
    pbr: { baseColor: [0.55, 0.70, 0.45], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.15, ior: 1.00, sheen: 0.10, anisotropy: 0.00, extinction: [0.05, 0.05, 0.05] },
    anime: { baseColor: [0.58, 0.72, 0.48], quantizeSteps: 3, rimPower: 1.8, rimColor: [0.72, 0.88, 0.55] },
    particleDensity:   0.35,
    particleKind:      'pollen',
    ambientTint:       [0.75, 0.82, 0.65],
    animeFlatness:     0.28
  },
  [SENSORY_ARCHETYPE.ROARING_WATERFALL]: {
    pbr: { baseColor: [0.55, 0.72, 0.85], metalness: 0.00, roughness: 0.60, clearcoat: 0.50, transmission: 0.60, ior: 1.33, sheen: 0.20, anisotropy: 0.00, extinction: [0.15, 0.15, 0.15] },
    anime: { baseColor: [0.58, 0.75, 0.88], quantizeSteps: 3, rimPower: 1.5, rimColor: [0.82, 0.92, 1.00] },
    particleDensity:   0.85,
    particleKind:      'spray',
    ambientTint:       [0.80, 0.88, 0.95],
    animeFlatness:     0.30
  },
  [SENSORY_ARCHETYPE.STORMY_COAST]: {
    pbr: { baseColor: [0.45, 0.55, 0.62], metalness: 0.00, roughness: 0.85, clearcoat: 0.30, transmission: 0.35, ior: 1.10, sheen: 0.10, anisotropy: 0.00, extinction: [0.20, 0.20, 0.20] },
    anime: { baseColor: [0.48, 0.58, 0.65], quantizeSteps: 3, rimPower: 1.9, rimColor: [0.65, 0.75, 0.82] },
    particleDensity:   0.75,
    particleKind:      'spray',
    ambientTint:       [0.55, 0.62, 0.70],
    animeFlatness:     0.42
  },
  [SENSORY_ARCHETYPE.VOLCANIC_FUMAROLE]: {
    pbr: { baseColor: [0.55, 0.35, 0.25], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.45, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [0.35, 0.25, 0.20] },
    anime: { baseColor: [0.58, 0.38, 0.28], quantizeSteps: 3, rimPower: 1.6, rimColor: [0.95, 0.65, 0.45] },
    particleDensity:   0.60,
    particleKind:      'ash',
    ambientTint:       [0.65, 0.50, 0.40],
    animeFlatness:     0.50
  },
  [SENSORY_ARCHETYPE.DEEP_CAVE]: {
    pbr: { baseColor: [0.10, 0.12, 0.15], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.05, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [0.50, 0.50, 0.50] },
    anime: { baseColor: [0.12, 0.14, 0.18], quantizeSteps: 3, rimPower: 2.2, rimColor: [0.20, 0.24, 0.30] },
    particleDensity:   0.20,
    particleKind:      'mist',
    ambientTint:       [0.18, 0.20, 0.25],
    animeFlatness:     0.55
  },
  [SENSORY_ARCHETYPE.ARID_WASTELAND]: {
    pbr: { baseColor: [0.85, 0.72, 0.55], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.20, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [0.30, 0.28, 0.25] },
    anime: { baseColor: [0.88, 0.75, 0.58], quantizeSteps: 3, rimPower: 2.0, rimColor: [1.00, 0.90, 0.72] },
    particleDensity:   0.55,
    particleKind:      'dust',
    ambientTint:       [0.92, 0.82, 0.65],
    animeFlatness:     0.38
  },
  [SENSORY_ARCHETYPE.TROPICAL_JUNGLE]: {
    pbr: { baseColor: [0.20, 0.42, 0.18], metalness: 0.00, roughness: 0.85, clearcoat: 0.20, transmission: 0.25, ior: 1.05, sheen: 0.15, anisotropy: 0.00, extinction: [0.15, 0.18, 0.10] },
    anime: { baseColor: [0.22, 0.45, 0.20], quantizeSteps: 3, rimPower: 1.8, rimColor: [0.50, 0.85, 0.40] },
    particleDensity:   0.45,
    particleKind:      'spore',
    ambientTint:       [0.35, 0.55, 0.30],
    animeFlatness:     0.32
  },
  [SENSORY_ARCHETYPE.SUBALPINE_WOODLAND]: {
    pbr: { baseColor: [0.35, 0.45, 0.28], metalness: 0.00, roughness: 0.90, clearcoat: 0.10, transmission: 0.20, ior: 1.00, sheen: 0.10, anisotropy: 0.00, extinction: [0.08, 0.10, 0.08] },
    anime: { baseColor: [0.38, 0.48, 0.30], quantizeSteps: 3, rimPower: 1.9, rimColor: [0.55, 0.68, 0.42] },
    particleDensity:   0.20,
    particleKind:      'pollen',
    ambientTint:       [0.55, 0.65, 0.50],
    animeFlatness:     0.32
  },
  [SENSORY_ARCHETYPE.DECAYING_SWAMP]: {
    pbr: { baseColor: [0.25, 0.28, 0.20], metalness: 0.00, roughness: 1.00, clearcoat: 0.05, transmission: 0.20, ior: 1.02, sheen: 0.05, anisotropy: 0.00, extinction: [0.25, 0.25, 0.22] },
    anime: { baseColor: [0.28, 0.30, 0.22], quantizeSteps: 3, rimPower: 2.1, rimColor: [0.42, 0.48, 0.35] },
    particleDensity:   0.30,
    particleKind:      'spore',
    ambientTint:       [0.32, 0.35, 0.28],
    animeFlatness:     0.45
  }
});

// ─── material acoustic profiles ────────────────────────────────
// Each material class has a distinctive sound character.
// Weights: [leaves, water, wood, rock, soil, metal, flesh, wind]
const ACOUSTIC_PROFILE = Object.freeze({
  FOLIAGE_DENSE:   [0.80, 0.05, 0.10, 0.02, 0.00, 0.00, 0.00, 0.03],
  GRASS_OPEN:      [0.70, 0.05, 0.05, 0.02, 0.15, 0.00, 0.00, 0.03],
  BARE_ROCK:       [0.02, 0.05, 0.05, 0.80, 0.05, 0.00, 0.00, 0.03],
  GRAVEL_SOIL:     [0.10, 0.05, 0.05, 0.30, 0.45, 0.00, 0.00, 0.05],
  SAND_DUNE:       [0.05, 0.05, 0.02, 0.10, 0.75, 0.00, 0.00, 0.03],
  WATER_SURFACE:   [0.05, 0.75, 0.05, 0.10, 0.02, 0.00, 0.00, 0.03],
  WATERFALL:       [0.05, 0.85, 0.02, 0.05, 0.00, 0.00, 0.00, 0.03],
  SNOW_PACK:       [0.05, 0.20, 0.05, 0.10, 0.55, 0.00, 0.00, 0.05],
  ICE_SHEET:       [0.02, 0.15, 0.02, 0.15, 0.02, 0.60, 0.00, 0.04],
  WET_STONE:       [0.03, 0.40, 0.02, 0.50, 0.00, 0.03, 0.00, 0.02],
  WOOD_DENSE:      [0.40, 0.05, 0.50, 0.03, 0.00, 0.00, 0.00, 0.02],
  PEAT_DAMP:       [0.20, 0.30, 0.15, 0.05, 0.28, 0.00, 0.00, 0.02],
  METAL_MACHINE:   [0.02, 0.02, 0.02, 0.05, 0.00, 0.85, 0.02, 0.02],
  ANIMAL_PRESENT:  [0.10, 0.03, 0.05, 0.03, 0.10, 0.00, 0.65, 0.04]
});

// ─── sensory archetype classification thresholds ──────────────
const SENSORY_THRESHOLDS = Object.freeze({
  forestDensityThreshold:    0.4,
  grassDensityThreshold:     0.3,
  waterCoverageThreshold:    0.3,
  waterfallDepthThreshold:   3.0,
  coastalWaterFraction:      0.5,
  volcanicPresenceThreshold: 0.2,
  caveDarknessThreshold:     0.15,
  aridMoistureThreshold:     0.2,
  tropicalTemperature:       22.0,
  tropicalMoisture:          0.6,
  swampMoisture:             0.75,
  swampDecompThreshold:      0.3
});

// ─── sensory defaults ─────────────────────────────────────────
const SENSORY_DEFAULTS = Object.freeze({
  worldSeed:              0x5E5E0A11D & 0xFFFFFFFF,
  cellSize:               32.0,
  chunkSize:              1000,
  maxCellsPerChunk:       64,
  maxChunksPerFrame:      8,
  enableAcoustic:         true,
  enableOlfactory:        true,
  enableTactile:          true,
  enableParticles:        true,
  transitionCooldown:     4.0,
  audioSpatialRadius:     100.0
});

class SensoryDetailsProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...SENSORY_DEFAULTS, ...(options.defaults || {}) };
    this.defaults.worldSeed = this.defaults.worldSeed | 0;
    this.thresholds = { ...SENSORY_THRESHOLDS, ...(options.thresholds || {}) };
    this.material = { ...SENSORY_MATERIAL, ...(options.material || {}) };
    this.acousticProfiles = { ...ACOUSTIC_PROFILE, ...(options.acousticProfiles || {}) };

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColorA = new Vec3();
    this._tmpColorB = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();

    // ── per-chunk sensory state ────────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Sensory archetype.
    this._chunkArchetype            = new Uint8Array(chunkCap);

    // Acoustic descriptors (primary + secondary cues).
    this._chunkPrimaryAcoustic      = new Uint8Array(chunkCap);
    this._chunkSecondaryAcoustic    = new Uint8Array(chunkCap);
    this._chunkAcousticIntensity    = new Float32Array(chunkCap);   // 0..1

    // Olfactory descriptors.
    this._chunkPrimaryOlfactory     = new Uint8Array(chunkCap);
    this._chunkSecondaryOlfactory   = new Uint8Array(chunkCap);
    this._chunkOlfactoryIntensity   = new Float32Array(chunkCap);

    // Tactile descriptors.
    this._chunkTemperatureFeel      = new Float32Array(chunkCap);   // -1..1 (cold..hot)
    this._chunkHumidityFeel         = new Float32Array(chunkCap);   // 0..1
    this._chunkWindPressureFeel     = new Float32Array(chunkCap);   // 0..1
    this._chunkPrecipitationFeel    = new Float32Array(chunkCap);   // 0..1
    this._chunkGroundHardness       = new Float32Array(chunkCap);   // 0..1 (soft..hard)
    this._chunkVegetationTouchFeel  = new Float32Array(chunkCap);   // 0..1

    // Material acoustic signature (8-channel weight vector).
    this._chunkAcousticSignature    = new Float32Array(chunkCap * 8);

    // Atmospheric particle system parameters.
    this._chunkParticleDensity      = new Float32Array(chunkCap);
    this._chunkParticleKind         = new Uint8Array(chunkCap);    // 0=pollen, 1=dust, 2=spore, 3=mist, 4=spray, 5=ash
    this._chunkParticleColorR       = new Float32Array(chunkCap);
    this._chunkParticleColorG       = new Float32Array(chunkCap);
    this._chunkParticleColorB       = new Float32Array(chunkCap);

    // Ambient tint that shaders can use.
    this._chunkAmbientTintR         = new Float32Array(chunkCap);
    this._chunkAmbientTintG         = new Float32Array(chunkCap);
    this._chunkAmbientTintB         = new Float32Array(chunkCap);

    // Per-cell data.
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellAcoustic = new Array(chunkCap).fill(null);      // Uint8Array
    this._chunkCellOlfactory = new Array(chunkCap).fill(null);     // Uint8Array
    this._chunkCellAcousticInt = new Array(chunkCap).fill(null);   // Float32Array
    this._chunkCellOlfactoryInt = new Array(chunkCap).fill(null);  // Float32Array
    this._chunkCellParticleInt = new Array(chunkCap).fill(null);   // Float32Array

    // Free lists.
    this._cellPool = {
      x: [], y: [], z: [], acousticInt: [], olfactoryInt: [], particleInt: []
    };
    this._acousticArrayPool = [];
    this._olfactoryArrayPool = [];

    // ── per-frame global aggregate ─────────────────────────
    this._globalSensory = {
      dominantArchetype: 0,
      dominantArchetypeName: 'silent_deep_forest',
      primaryAcoustic: 0,
      primaryAcousticName: 'silence',
      secondaryAcoustic: 0,
      acousticIntensity: 0,
      primaryOlfactory: 0,
      primaryOlfactoryName: 'neutral',
      secondaryOlfactory: 0,
      olfactoryIntensity: 0,
      avgTemperatureFeel: 0,
      avgHumidityFeel: 0.5,
      avgWindPressureFeel: 0.3,
      avgPrecipitationFeel: 0,
      avgGroundHardness: 0.5,
      avgVegetationTouch: 0.3,
      avgParticleDensity: 0,
      dominantParticleKind: 0,
      avgAmbientTint: [0.5, 0.5, 0.5],
      acousticSignature: [0.2, 0.1, 0.1, 0.2, 0.2, 0.05, 0.02, 0.1]
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ─────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      forestCells: 0,
      meadowCells: 0,
      waterfallCells: 0,
      coastCells: 0,
      volcanicCells: 0,
      caveCells: 0,
      aridCells: 0,
      jungleCells: 0,
      alpineCells: 0,
      swampCells: 0,
      acousticChanges: 0,
      olfactoryChanges: 0,
      particlesActiveCells: 0,
      audioLightEventsEmitted: 0
    };

    // ── collaborators ─────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._carve = options.carve || null;
    this._relief = options.relief || null;
    this._cliffs = options.cliffs || null;
    this._formations = options.formations || null;
    this._rocks = options.rocks || null;
    this._forest = options.forest || null;
    this._grass = options.grass || null;
    this._continental = options.continental || null;
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
    this._seasonality = options.seasonality || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── reusable material output ───────────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0, extinction: [0,0,0] },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      particleDensity: 0,
      particleKind: 'none',
      ambientTint: [0,0,0],
      animeFlatness: 0
    };

    // ── previous cues per chunk (for transitions) ─────────
    this._chunkLastAcoustic = new Uint8Array(chunkCap);
    this._chunkLastOlfactory = new Uint8Array(chunkCap);
    this._chunkLastTransitionTime = new Float64Array(chunkCap);
    this._chunkLastParticle = new Uint8Array(chunkCap);
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachRelief(r) { this._relief = r; return this; }
  attachCliffs(c) { this._cliffs = c; return this; }
  attachFormations(f) { this._formations = f; return this; }
  attachRocks(r) { this._rocks = r; return this; }
  attachForest(f) { this._forest = f; return this; }
  attachGrass(g) { this._grass = g; return this; }
  attachContinental(c) { this._continental = c; return this; }
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
  attachSeasonality(s) { this._seasonality = s; return this; }
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
  // ─── sensory archetype classification ───────────────────
  // ══════════════════════════════════════════════════════════
  _classifySensoryArchetype(wx, wz, frame) {
    const physical = frame.layers.physical;

    // Gather context.
    const forest = this._forest ? this._forest.getForestAt(wx, wz) : null;
    const forestCanopy = forest ? forest.canopyDensity : 0;

    const grass = this._grass ? this._grass.getGrassAt(wx, wz) : null;
    const grassCoverage = grass ? grass.coverage : 0;

    const water = this._bathymetry ? this._bathymetry.getWaterAt(wx, wz) : null;
    const waterCoverage = water ? water.waterCoverage : 0;
    const waterDepth = water ? water.maxDepth : 0;

    const decomp = this._decomposers ? this._decomposers.getDecomposersAt(wx, wz) : null;
    const decompActivity = decomp ? decomp.decompRate : 0;

    const ambientTemp = physical?.ambientTemperature ?? 15;
    const humidity = physical?.relativeHumidity ?? 0.5;
    const soilMoisture = physical?.soilMoisture ?? 0.5;
    const airAod = this._airQuality ? this._airQuality.sampleAodAt(wx, wz, frame) : 0.1;
    const elevation = this._getHeight(wx, wz);

    // Volcanic: high sulfur/ash nearby.
    const volcanicAsh = physical?.volcanicAshAvg ?? 0;
    if (volcanicAsh > this.thresholds.volcanicPresenceThreshold) {
      return SENSORY_ARCHETYPE.VOLCANIC_FUMAROLE;
    }

    // Deep cave: interior with low light.
    const interiorness = this._continental ? this._continental.getInteriornessAt(wx, wz) : 0;
    const sunIntensity = physical?.sunIntensity ?? 0.7;
    if (interiorness > 0.8 && sunIntensity < 0.1 && elevation > 500) {
      return SENSORY_ARCHETYPE.DEEP_CAVE;
    }

    // Waterfall: water at significant depth with high slope nearby.
    if (waterDepth > this.thresholds.waterfallDepthThreshold) {
      const slopeAngle = this._slope ? this._slope.getSlopeAngle(wx, wz) : 0;
      if (slopeAngle > 0.4) return SENSORY_ARCHETYPE.ROARING_WATERFALL;
    }

    // Stormy coast: near marine water.
    if (this._bathymetry) {
      const bathymetry = water;
      if (bathymetry && bathymetry.dominantZone === BATHY_ZONE.SURFACE) {
        if (bathymetry.waterCoverage > this.thresholds.coastalWaterFraction) {
          return SENSORY_ARCHETYPE.STORMY_COAST;
        }
      }
    }

    // Decaying swamp: high moisture, high decomp, low elevation.
    if (soilMoisture > this.thresholds.swampMoisture &&
        decompActivity > this.thresholds.swampDecompThreshold &&
        elevation < 300) {
      return SENSORY_ARCHETYPE.DECAYING_SWAMP;
    }

    // Tropical jungle: warm, moist, dense forest.
    if (ambientTemp > this.thresholds.tropicalTemperature &&
        humidity > this.thresholds.tropicalMoisture &&
        forestCanopy > this.thresholds.forestDensityThreshold) {
      return SENSORY_ARCHETYPE.TROPICAL_JUNGLE;
    }

    // Silent deep forest: high forest cover, moderate everything.
    if (forestCanopy > this.thresholds.forestDensityThreshold) {
      if (elevation > 1500) return SENSORY_ARCHETYPE.SUBALPINE_WOODLAND;
      return SENSORY_ARCHETYPE.SILENT_DEEP_FOREST;
    }

    // Arid wasteland: low moisture, high AOD.
    if (soilMoisture < this.thresholds.aridMoistureThreshold && airAod > 0.2) {
      return SENSORY_ARCHETYPE.ARID_WASTELAND;
    }

    // Breezy meadow: open grass, no forest.
    if (grassCoverage > this.thresholds.grassDensityThreshold) {
      return SENSORY_ARCHETYPE.BREEZY_MEADOW;
    }

    // Default: meadow.
    return SENSORY_ARCHETYPE.BREEZY_MEADOW;
  }

  // ══════════════════════════════════════════════════════════
  // ─── acoustic cue computation ───────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeAcousticCues(archetype, wx, wz, frame, seasonState) {
    const physical = frame.layers.physical;
    const windSpeed = physical?.windSpeed ?? 0;
    const precipPhase = this._precipitation ? physical?.precipitationPhase : -1;
    const precipIntensity = physical?.precipitationIntensity ?? 0;
    const cloudCover = physical?.cloudCover ?? 0.3;
    const isNight = physical?.sunAltitude ?? 0.7 < 0;

    let primary = ACOUSTIC_CUE.SILENCE;
    let secondary = ACOUSTIC_CUE.SILENCE;
    let intensity = 0.2;

    // Base acoustics per archetype.
    switch (archetype) {
      case SENSORY_ARCHETYPE.SILENT_DEEP_FOREST:
        primary = isNight ? ACOUSTIC_CUE.INSECT_BUZZ : ACOUSTIC_CUE.BIRD_SONG;
        secondary = ACOUSTIC_CUE.LEAF_RUSTLE;
        intensity = 0.35;
        break;
      case SENSORY_ARCHETYPE.BREEZY_MEADOW:
        primary = ACOUSTIC_CUE.WIND_BREEZE;
        secondary = ACOUSTIC_CUE.GRASS_SWISH;
        intensity = 0.45;
        break;
      case SENSORY_ARCHETYPE.ROARING_WATERFALL:
        primary = ACOUSTIC_CUE.WATERFALL_ROAR;
        secondary = ACOUSTIC_CUE.WET_STONE_DRIP;
        intensity = 0.85;
        break;
      case SENSORY_ARCHETYPE.STORMY_COAST:
        primary = ACOUSTIC_CUE.OCEAN_WAVES;
        secondary = ACOUSTIC_CUE.STORM_GUST;
        intensity = 0.75;
        break;
      case SENSORY_ARCHETYPE.VOLCANIC_FUMAROLE:
        primary = ACOUSTIC_CUE.VOLCANIC_RUMBLE;
        secondary = ACOUSTIC_CUE.GEYSER_ERUPTION;
        intensity = 0.65;
        break;
      case SENSORY_ARCHETYPE.DEEP_CAVE:
        primary = ACOUSTIC_CUE.WET_STONE_DRIP;
        secondary = ACOUSTIC_CUE.FOLIAGE_SILENCE;
        intensity = 0.15;
        break;
      case SENSORY_ARCHETYPE.ARID_WASTELAND:
        primary = ACOUSTIC_CUE.WIND_HOWL;
        secondary = ACOUSTIC_CUE.FOLIAGE_SILENCE;
        intensity = 0.40;
        break;
      case SENSORY_ARCHETYPE.TROPICAL_JUNGLE:
        primary = ACOUSTIC_CUE.INSECT_BUZZ;
        secondary = ACOUSTIC_CUE.BIRD_SONG;
        intensity = 0.70;
        break;
      case SENSORY_ARCHETYPE.SUBALPINE_WOODLAND:
        primary = ACOUSTIC_CUE.WIND_BREEZE;
        secondary = ACOUSTIC_CUE.LEAF_RUSTLE;
        intensity = 0.40;
        break;
      case SENSORY_ARCHETYPE.DECAYING_SWAMP:
        primary = ACOUSTIC_CUE.FROG_CROAK;
        secondary = ACOUSTIC_CUE.INSECT_BUZZ;
        intensity = 0.55;
        break;
    }

    // Override by precipitation phase.
    if (precipIntensity > 0.1) {
      if (precipPhase === PRECIPITATION_PHASE.SNOW ||
          precipPhase === PRECIPITATION_PHASE.HEAVY_SNOW) {
        primary = ACOUSTIC_CUE.SNOW_HUSH;
        intensity = 0.25;
      } else if (precipPhase === PRECIPITATION_PHASE.RAIN ||
                 precipPhase === PRECIPITATION_PHASE.HEAVY_RAIN) {
        primary = ACOUSTIC_CUE.RAIN_PATTER;
        intensity = Math.min(1, precipIntensity * 0.3);
      } else if (precipPhase === PRECIPITATION_PHASE.STORM) {
        primary = ACOUSTIC_CUE.THUNDER;
        intensity = 0.9;
      }
    }

    // Wind override at high speed.
    if (windSpeed > 15) {
      primary = ACOUSTIC_CUE.STORM_GUST;
      intensity = Math.min(1, windSpeed / 30);
    } else if (windSpeed > 8 && intensity < 0.5) {
      primary = ACOUSTIC_CUE.WIND_HOWL;
      intensity = Math.min(0.7, windSpeed / 20);
    }

    return { primary, secondary, intensity };
  }

  // ══════════════════════════════════════════════════════════
  // ─── olfactory cue computation ──────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeOlfactoryCues(archetype, wx, wz, frame, seasonState) {
    const physical = frame.layers.physical;
    const moisture = physical?.relativeHumidity ?? 0.5;
    const soilMoisture = physical?.soilMoisture ?? 0.5;
    const recentRain = physical?.precipitationIntensity ?? 0;
    const airAod = this._airQuality ? this._airQuality.sampleAodAt(wx, wz, frame) : 0.1;
    const decomp = this._decomposers ? this._decomposers.getDecomposersAt(wx, wz) : null;
    const decompActivity = decomp ? decomp.decompRate : 0;
    const bloomCoverage = this._seasonality ?
      (this._seasonality.sampleLeafCoverageAt(wx, wz, frame) || 0) : 0;
    const season = seasonState.seasonIndex;

    let primary = OLFACTORY_CUE.NEUTRAL;
    let secondary = OLFACTORY_CUE.NEUTRAL;
    let intensity = 0.2;

    switch (archetype) {
      case SENSORY_ARCHETYPE.SILENT_DEEP_FOREST:
        primary = season === 3 ? OLFACTORY_CUE.LEAF_LITTER : OLFACTORY_CUE.FERN_GREEN;
        secondary = OLFACTORY_CUE.PINE_RESIN;
        intensity = 0.55;
        break;
      case SENSORY_ARCHETYPE.BREEZY_MEADOW:
        primary = season === 0 || season === 1 ? OLFACTORY_CUE.POLLEN : OLFACTORY_CUE.SOIL;
        secondary = OLFACTORY_CUE.FLORAL;
        intensity = 0.40;
        break;
      case SENSORY_ARCHETYPE.ROARING_WATERFALL:
        primary = OLFACTORY_CUE.FRESH_WATER;
        secondary = OLFACTORY_CUE.MOSS;
        intensity = 0.65;
        break;
      case SENSORY_ARCHETYPE.STORMY_COAST:
        primary = OLFACTORY_CUE.SALT_SPRAY;
        secondary = OLFACTORY_CUE.STORM_AIR;
        intensity = 0.75;
        break;
      case SENSORY_ARCHETYPE.VOLCANIC_FUMAROLE:
        primary = OLFACTORY_CUE.SULFUR;
        secondary = OLFACTORY_CUE.SMOKE;
        intensity = 0.85;
        break;
      case SENSORY_ARCHETYPE.DEEP_CAVE:
        primary = OLFACTORY_CUE.WET_EARTH;
        secondary = OLFACTORY_CUE.MOSS;
        intensity = 0.30;
        break;
      case SENSORY_ARCHETYPE.ARID_WASTELAND:
        primary = OLFACTORY_CUE.SOIL;
        secondary = OLFACTORY_CUE.NEUTRAL;
        intensity = 0.25;
        break;
      case SENSORY_ARCHETYPE.TROPICAL_JUNGLE:
        primary = OLFACTORY_CUE.FLORAL;
        secondary = OLFACTORY_CUE.HUMUS;
        intensity = 0.80;
        break;
      case SENSORY_ARCHETYPE.SUBALPINE_WOODLAND:
        primary = OLFACTORY_CUE.PINE_RESIN;
        secondary = OLFACTORY_CUE.ALPINE_CLEAN;
        intensity = 0.50;
        break;
      case SENSORY_ARCHETYPE.DECAYING_SWAMP:
        primary = OLFACTORY_CUE.ROTTING;
        secondary = OLFACTORY_CUE.FUNGAL;
        intensity = 0.75;
        break;
    }

    // Recent rain: petrichor — wet earth becomes dominant.
    if (recentRain > 0.3) {
      secondary = primary;
      primary = OLFACTORY_CUE.WET_EARTH;
      intensity = Math.min(1, intensity + 0.3);
    }

    // High decomp: rotting smell overrides.
    if (decompActivity > 0.5 && primary !== OLFACTORY_CUE.SULFUR) {
      primary = OLFACTORY_CUE.FUNGAL;
      secondary = OLFACTORY_CUE.HUMUS;
      intensity = Math.max(intensity, 0.55);
    }

    // Smoke from wildfire ash.
    const smokeAvg = physical?.smokeAvg ?? 0;
    if (smokeAvg > 0.2) {
      primary = OLFACTORY_CUE.SMOKE;
      intensity = Math.min(1, 0.7 + smokeAvg * 0.3);
    }

    // Bloom season in spring/summer boosts floral.
    if ((season === 0 || season === 1) && bloomCoverage > 0.3) {
      primary = OLFACTORY_CUE.FLORAL;
      secondary = OLFACTORY_CUE.NECTAR;
      intensity = Math.max(intensity, 0.65);
    }

    return { primary, secondary, intensity };
  }

  // ══════════════════════════════════════════════════════════
  // ─── tactile cue computation ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeTactileCues(wx, wz, frame) {
    const physical = frame.layers.physical;
    const ambientTemp = physical?.ambientTemperature ?? 15;
    const humidity = physical?.relativeHumidity ?? 0.5;
    const windSpeed = physical?.windSpeed ?? 0;
    const precipIntensity = physical?.precipitationIntensity ?? 0;

    // Temperature feel: -1 cold, 0 neutral, 1 hot (relative to human comfort ~20°C).
    const tempFeel = Math.max(-1, Math.min(1, (ambientTemp - 20) / 30));

    // Humidity feel: already 0..1.
    const humidityFeel = humidity;

    // Wind pressure feel: normalized wind speed.
    const windPressureFeel = Math.min(1, windSpeed / 25);

    // Precipitation feel: intensity.
    const precipitationFeel = Math.min(1, precipIntensity / 20);

    // Ground hardness: from soil/rock context.
    let groundHardness = 0.5;
    if (this._rocks) {
      const rocks = this._rocks.getPlacementsAt(wx, wz);
      if (rocks && rocks.count > 0) groundHardness = 0.85;
    } else if (this._soil) {
      const soil = this._soil.getSoilAt(wx, wz);
      if (soil) {
        // Sandy/gravelly = hard, loamy = soft.
        if (soil.textureClass <= SOIL_TEXTURE_CLASS.SANDY_LOAM) groundHardness = 0.75;
        else if (soil.textureClass >= SOIL_TEXTURE_CLASS.CLAY_LOAM) groundHardness = 0.55;
        else groundHardness = 0.40;
      }
    }

    // Vegetation touch feel: from grass/forest coverage.
    let vegetationTouch = 0;
    if (this._grass) {
      const grass = this._grass.getGrassAt(wx, wz);
      if (grass) vegetationTouch += grass.coverage * 0.7;
    }
    if (this._forest) {
      const forest = this._forest.getForestAt(wx, wz);
      if (forest) vegetationTouch += forest.canopyDensity * 0.3;
    }
    vegetationTouch = Math.min(1, vegetationTouch);

    return {
      temperatureFeel: tempFeel,
      humidityFeel,
      windPressureFeel,
      precipitationFeel,
      groundHardness,
      vegetationTouch
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── acoustic signature from materials ──────────────────
  // ══════════════════════════════════════════════════════════
  _computeAcousticSignature(wx, wz, frame, outSig) {
    for (let i = 0; i < 8; i++) outSig[i] = 0;

    const forest = this._forest ? this._forest.getForestAt(wx, wz) : null;
    const grass = this._grass ? this._grass.getGrassAt(wx, wz) : null;
    const rocks = this._rocks ? this._rocks.getPlacementsAt(wx, wz) : null;
    const water = this._bathymetry ? this._bathymetry.getWaterAt(wx, wz) : null;
    const soil = this._soil ? this._soil.getSoilAt(wx, wz) : null;

    // Foliage.
    if (forest && forest.canopyDensity > 0.2) {
      const profile = this.acousticProfiles.FOLIAGE_DENSE;
      const w = forest.canopyDensity;
      for (let i = 0; i < 8; i++) outSig[i] += profile[i] * w;
    }

    // Grass.
    if (grass && grass.coverage > 0.2) {
      const profile = this.acousticProfiles.GRASS_OPEN;
      const w = grass.coverage;
      for (let i = 0; i < 8; i++) outSig[i] += profile[i] * w;
    }

    // Rock.
    if (rocks && rocks.count > 0) {
      const profile = this.acousticProfiles.BARE_ROCK;
      for (let i = 0; i < 8; i++) outSig[i] += profile[i] * 0.8;
    }

    // Soil.
    if (soil) {
      let profile;
      if (soil.textureClass === SOIL_TEXTURE_CLASS.SAND) profile = this.acousticProfiles.SAND_DUNE;
      else if (soil.textureClass <= SOIL_TEXTURE_CLASS.SANDY_LOAM) profile = this.acousticProfiles.GRAVEL_SOIL;
      else profile = this.acousticProfiles.GRAVEL_SOIL;
      for (let i = 0; i < 8; i++) outSig[i] += profile[i] * 0.4;
    }

    // Water.
    if (water && water.waterCoverage > 0.2) {
      const profile = water.waterCoverage > 0.8
        ? this.acousticProfiles.WATERFALL
        : this.acousticProfiles.WATER_SURFACE;
      for (let i = 0; i < 8; i++) outSig[i] += profile[i] * water.waterCoverage;
    }

    // Normalize.
    let total = 0;
    for (let i = 0; i < 8; i++) total += outSig[i];
    if (total > 0.01) {
      for (let i = 0; i < 8; i++) outSig[i] /= total;
    } else {
      // Default: quiet wind.
      outSig[7] = 0.8;
      outSig[3] = 0.2;
    }
    return outSig;
  }

  // ══════════════════════════════════════════════════════════
  // ─── particle kind classification ──────────────────────
  // ══════════════════════════════════════════════════════════
  _classifyParticleKind(archetype, wx, wz, frame) {
    const physical = frame.layers.physical;
    const windSpeed = physical?.windSpeed ?? 0;
    const moisture = physical?.relativeHumidity ?? 0.5;
    const fogDensity = physical?.fogDensity ?? 0;
    const ashAvg = physical?.volcanicAshAvg ?? 0;

    if (ashAvg > 0.2) return 5;   // ash
    if (fogDensity > 0.1) return 3;   // mist
    if (windSpeed > 8 && moisture < 0.3) return 1;   // dust
    switch (archetype) {
      case SENSORY_ARCHETYPE.ROARING_WATERFALL:
      case SENSORY_ARCHETYPE.STORMY_COAST:
        return 4;   // spray
      case SENSORY_ARCHETYPE.TROPICAL_JUNGLE:
      case SENSORY_ARCHETYPE.DECAYING_SWAMP:
        return 2;   // spore
      case SENSORY_ARCHETYPE.BREEZY_MEADOW:
      case SENSORY_ARCHETYPE.SILENT_DEEP_FOREST:
        return 0;   // pollen
      case SENSORY_ARCHETYPE.SUBALPINE_WOODLAND:
        return 0;   // pollen
      case SENSORY_ARCHETYPE.ARID_WASTELAND:
        return 1;   // dust
      default:
        return 0;
    }
  }

  _particleColorForKind(kind, outColor) {
    switch (kind) {
      case 0: outColor[0] = 0.95; outColor[1] = 0.88; outColor[2] = 0.45; break;   // pollen: yellow
      case 1: outColor[0] = 0.80; outColor[1] = 0.70; outColor[2] = 0.55; break;   // dust: tan
      case 2: outColor[0] = 0.55; outColor[1] = 0.75; outColor[2] = 0.55; break;   // spore: green-grey
      case 3: outColor[0] = 0.88; outColor[1] = 0.90; outColor[2] = 0.95; break;   // mist: white
      case 4: outColor[0] = 0.75; outColor[1] = 0.85; outColor[2] = 0.95; break;   // spray: bluish white
      case 5: outColor[0] = 0.60; outColor[1] = 0.50; outColor[2] = 0.45; break;   // ash: grey-brown
      default: outColor[0] = 0.8; outColor[1] = 0.8; outColor[2] = 0.8;
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
      this._chunkCellAcoustic[slot] = this._acquireAcousticArray();
      this._chunkCellOlfactory[slot] = this._acquireOlfactoryArray();
      this._chunkCellAcousticInt[slot] = this._acquireCell('acousticInt');
      this._chunkCellOlfactoryInt[slot] = this._acquireCell('olfactoryInt');
      this._chunkCellParticleInt[slot] = this._acquireCell('particleInt');
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpAcou = this._chunkCellAcoustic[slot];
    const cpOlfa = this._chunkCellOlfactory[slot];
    const cpAcouInt = this._chunkCellAcousticInt[slot];
    const cpOlfaInt = this._chunkCellOlfactoryInt[slot];
    const cpPartInt = this._chunkCellParticleInt[slot];

    // ── Aggregates ──────────────────────────────────────────
    let sumAcouInt = 0, sumOlfaInt = 0, sumPartInt = 0;
    let sumTempFeel = 0, sumHumidFeel = 0, sumWindFeel = 0, sumPrecipFeel = 0;
    let sumGroundHardness = 0, sumVegetationTouch = 0;
    const acousticCount = new Uint16Array(ACOUSTIC_CUE_NAMES.length);
    const olfactoryCount = new Uint16Array(OLFACTORY_CUE_NAMES.length);
    const archetypeCount = new Uint16Array(SENSORY_ARCHETYPE_NAMES.length);
    const sigSum = new Float32Array(8);

    let placed = 0;
    const particleColorScratch = this._tmpColorA;

    // ── Sample each cell ────────────────────────────────────
    for (let j = 0; j < cellsPerSide && placed < this.defaults.maxCellsPerChunk; j++) {
      for (let i = 0; i < cellsPerSide && placed < this.defaults.maxCellsPerChunk; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;
        const altitude = this._getHeight(wx, wz);

        // Classify sensory archetype at this cell.
        const archetype = this._classifySensoryArchetype(wx, wz, frame);

        // Compute cues.
        const acou = this._computeAcousticCues(archetype, wx, wz, frame, seasonState);
        const olfa = this._computeOlfactoryCues(archetype, wx, wz, frame, seasonState);
        const tact = this._computeTactileCues(wx, wz, frame);

        // Acoustic signature from materials.
        const sig = this._computeAcousticSignature(wx, wz, frame, this._tmpVecA);

        // Particle kind and density.
        const particleKind = this._classifyParticleKind(archetype, wx, wz, frame);
        const mat = SENSORY_MATERIAL[archetype];
        const particleDensity = mat ? mat.particleDensity : 0.15;

        // Store cell.
        cpx[placed] = wx;
        cpy[placed] = altitude;
        cpz[placed] = wz;
        cpAcou[placed] = acou.primary;
        cpOlfa[placed] = olfa.primary;
        cpAcouInt[placed] = acou.intensity;
        cpOlfaInt[placed] = olfa.intensity;
        cpPartInt[placed] = particleDensity;
        placed++;

        // Aggregate.
        sumAcouInt += acou.intensity;
        sumOlfaInt += olfa.intensity;
        sumPartInt += particleDensity;
        sumTempFeel += tact.temperatureFeel;
        sumHumidFeel += tact.humidityFeel;
        sumWindFeel += tact.windPressureFeel;
        sumPrecipFeel += tact.precipitationFeel;
        sumGroundHardness += tact.groundHardness;
        sumVegetationTouch += tact.vegetationTouch;
        acousticCount[acou.primary]++;
        olfactoryCount[olfa.primary]++;
        archetypeCount[archetype]++;
        for (let k = 0; k < 8; k++) sigSum[k] += sig[k];

        if (particleDensity > 0.1) this._stats.particlesActiveCells++;
        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // ── Dominant archetype ──────────────────────────────────
    let domArchetype = 0;
    let maxArchetypeCount = 0;
    for (let a = 0; a < archetypeCount.length; a++) {
      if (archetypeCount[a] > maxArchetypeCount) {
        maxArchetypeCount = archetypeCount[a];
        domArchetype = a;
      }
    }
    this._chunkArchetype[slot] = domArchetype;

    // ── Dominant acoustic/olfactory cues ───────────────────
    let domAcou = 0, maxAcouCount = 0;
    for (let a = 0; a < acousticCount.length; a++) {
      if (acousticCount[a] > maxAcouCount) { maxAcouCount = acousticCount[a]; domAcou = a; }
    }
    let secondAcou = 0, secondAcouCount = 0;
    for (let a = 0; a < acousticCount.length; a++) {
      if (a !== domAcou && acousticCount[a] > secondAcouCount) {
        secondAcouCount = acousticCount[a];
        secondAcou = a;
      }
    }

    let domOlfa = 0, maxOlfaCount = 0;
    for (let o = 0; o < olfactoryCount.length; o++) {
      if (olfactoryCount[o] > maxOlfaCount) { maxOlfaCount = olfactoryCount[o]; domOlfa = o; }
    }
    let secondOlfa = 0, secondOlfaCount = 0;
    for (let o = 0; o < olfactoryCount.length; o++) {
      if (o !== domOlfa && olfactoryCount[o] > secondOlfaCount) {
        secondOlfaCount = olfactoryCount[o];
        secondOlfa = o;
      }
    }

    this._chunkPrimaryAcoustic[slot] = domAcou;
    this._chunkSecondaryAcoustic[slot] = secondAcou;
    this._chunkAcousticIntensity[slot] = placed > 0 ? sumAcouInt / placed : 0;
    this._chunkPrimaryOlfactory[slot] = domOlfa;
    this._chunkSecondaryOlfactory[slot] = secondOlfa;
    this._chunkOlfactoryIntensity[slot] = placed > 0 ? sumOlfaInt / placed : 0;

    // ── Tactile summary ────────────────────────────────────
    const inv = placed > 0 ? 1 / placed : 0;
    this._chunkTemperatureFeel[slot] = sumTempFeel * inv;
    this._chunkHumidityFeel[slot] = sumHumidFeel * inv;
    this._chunkWindPressureFeel[slot] = sumWindFeel * inv;
    this._chunkPrecipitationFeel[slot] = sumPrecipFeel * inv;
    this._chunkGroundHardness[slot] = sumGroundHardness * inv;
    this._chunkVegetationTouchFeel[slot] = sumVegetationTouch * inv;

    // ── Acoustic signature (normalized) ────────────────────
    const sigOffset = slot * 8;
    let sigTotal = 0;
    for (let k = 0; k < 8; k++) sigTotal += sigSum[k];
    if (sigTotal > 0.01) {
      for (let k = 0; k < 8; k++) {
        this._chunkAcousticSignature[sigOffset + k] = sigSum[k] / sigTotal;
      }
    } else {
      for (let k = 0; k < 8; k++) {
        this._chunkAcousticSignature[sigOffset + k] = (k === 7 ? 0.8 : 0.03);
      }
    }

    // ── Particle and material params ──────────────────────
    const mat = SENSORY_MATERIAL[domArchetype];
    if (mat) {
      this._chunkParticleDensity[slot] = mat.particleDensity;
      this._chunkParticleKind[slot] = this._classifyParticleKind(domArchetype, cx * chunkSize + chunkSize * 0.5, cz * chunkSize + chunkSize * 0.5, frame);
      const pColor = this._particleColorForKind(this._chunkParticleKind[slot], particleColorScratch);
      this._chunkParticleColorR[slot] = pColor[0];
      this._chunkParticleColorG[slot] = pColor[1];
      this._chunkParticleColorB[slot] = pColor[2];
      this._chunkAmbientTintR[slot] = mat.ambientTint[0];
      this._chunkAmbientTintG[slot] = mat.ambientTint[1];
      this._chunkAmbientTintB[slot] = mat.ambientTint[2];
    }

    this._stats.chunksProcessed++;

    // ── Per-archetype stats ────────────────────────────────
    switch (domArchetype) {
      case SENSORY_ARCHETYPE.SILENT_DEEP_FOREST: this._stats.forestCells++; break;
      case SENSORY_ARCHETYPE.BREEZY_MEADOW:      this._stats.meadowCells++; break;
      case SENSORY_ARCHETYPE.ROARING_WATERFALL:  this._stats.waterfallCells++; break;
      case SENSORY_ARCHETYPE.STORMY_COAST:       this._stats.coastCells++; break;
      case SENSORY_ARCHETYPE.VOLCANIC_FUMAROLE:  this._stats.volcanicCells++; break;
      case SENSORY_ARCHETYPE.DEEP_CAVE:          this._stats.caveCells++; break;
      case SENSORY_ARCHETYPE.ARID_WASTELAND:     this._stats.aridCells++; break;
      case SENSORY_ARCHETYPE.TROPICAL_JUNGLE:    this._stats.jungleCells++; break;
      case SENSORY_ARCHETYPE.SUBALPINE_WOODLAND: this._stats.alpineCells++; break;
      case SENSORY_ARCHETYPE.DECAYING_SWAMP:     this._stats.swampCells++; break;
    }

    // ── Cue transition events ──────────────────────────────
    const previousAcou = this._chunkLastAcoustic[slot];
    const previousOlfa = this._chunkLastOlfactory[slot];
    const previousParticle = this._chunkLastParticle[slot];
    if (now - this._chunkLastTransitionTime[slot] > this.defaults.transitionCooldown) {
      if (previousAcou !== 0 && previousAcou !== domAcou) {
        this._chunkLastTransitionTime[slot] = now;
        this._stats.acousticChanges++;
        if (this._dispatcher) {
          this._dispatcher.queueCausalEvent(
            EVENT_TYPE.AUDIO_LIGHT,
            [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
            -1, 25, 3.0,
            {
              kind: 'acoustic_shift',
              chunkX: cx, chunkZ: cz,
              fromCue: previousAcou,
              toCue: domAcou,
              fromCueName: ACOUSTIC_CUE_NAMES[previousAcou],
              toCueName: ACOUSTIC_CUE_NAMES[domAcou],
              intensity: this._chunkAcousticIntensity[slot],
              archetype: SENSORY_ARCHETYPE_NAMES[domArchetype]
            }
          );
          this._stats.audioLightEventsEmitted++;
        }
      }
      if (previousOlfa !== 0 && previousOlfa !== domOlfa) {
        this._chunkLastTransitionTime[slot] = now;
        this._stats.olfactoryChanges++;
        if (this._dispatcher) {
          this._dispatcher.queueCausalEvent(
            EVENT_TYPE.AUDIO_LIGHT,
            [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
            -1, 20, 3.0,
            {
              kind: 'olfactory_shift',
              chunkX: cx, chunkZ: cz,
              fromCue: previousOlfa,
              toCue: domOlfa,
              fromCueName: OLFACTORY_CUE_NAMES[previousOlfa],
              toCueName: OLFACTORY_CUE_NAMES[domOlfa],
              intensity: this._chunkOlfactoryIntensity[slot]
            }
          );
        }
      }
    }
    this._chunkLastAcoustic[slot] = domAcou;
    this._chunkLastOlfactory[slot] = domOlfa;
    this._chunkLastParticle[slot] = this._chunkParticleKind[slot];

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
    this._chunkLastAcoustic[slot] = 0;
    this._chunkLastOlfactory[slot] = 0;
    this._chunkLastTransitionTime[slot] = 0;
    this._chunkLastParticle[slot] = 0;
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
      this._cellPool.acousticInt.push(this._chunkCellAcousticInt[slot]);
      this._cellPool.olfactoryInt.push(this._chunkCellOlfactoryInt[slot]);
      this._cellPool.particleInt.push(this._chunkCellParticleInt[slot]);
      this._acousticArrayPool.push(this._chunkCellAcoustic[slot]);
      this._olfactoryArrayPool.push(this._chunkCellOlfactory[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellAcoustic[slot] = null;
    this._chunkCellOlfactory[slot] = null;
    this._chunkCellAcousticInt[slot] = null;
    this._chunkCellOlfactoryInt[slot] = null;
    this._chunkCellParticleInt[slot] = null;
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

  _acquireAcousticArray() {
    if (this._acousticArrayPool.length > 0) {
      const arr = this._acousticArrayPool.pop();
      arr.fill(0);
      return arr;
    }
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  _acquireOlfactoryArray() {
    if (this._olfactoryArrayPool.length > 0) {
      const arr = this._olfactoryArrayPool.pop();
      arr.fill(0);
      return arr;
    }
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getSensoryAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    const sigOffset = slot * 8;
    return {
      archetype: this._chunkArchetype[slot],
      archetypeName: SENSORY_ARCHETYPE_NAMES[this._chunkArchetype[slot]],
      primaryAcoustic: this._chunkPrimaryAcoustic[slot],
      primaryAcousticName: ACOUSTIC_CUE_NAMES[this._chunkPrimaryAcoustic[slot]],
      secondaryAcoustic: this._chunkSecondaryAcoustic[slot],
      secondaryAcousticName: ACOUSTIC_CUE_NAMES[this._chunkSecondaryAcoustic[slot]],
      acousticIntensity: this._chunkAcousticIntensity[slot],
      primaryOlfactory: this._chunkPrimaryOlfactory[slot],
      primaryOlfactoryName: OLFACTORY_CUE_NAMES[this._chunkPrimaryOlfactory[slot]],
      secondaryOlfactory: this._chunkSecondaryOlfactory[slot],
      secondaryOlfactoryName: OLFACTORY_CUE_NAMES[this._chunkSecondaryOlfactory[slot]],
      olfactoryIntensity: this._chunkOlfactoryIntensity[slot],
      temperatureFeel: this._chunkTemperatureFeel[slot],
      humidityFeel: this._chunkHumidityFeel[slot],
      windPressureFeel: this._chunkWindPressureFeel[slot],
      precipitationFeel: this._chunkPrecipitationFeel[slot],
      groundHardness: this._chunkGroundHardness[slot],
      vegetationTouch: this._chunkVegetationTouchFeel[slot],
      acousticSignature: [
        this._chunkAcousticSignature[sigOffset],
        this._chunkAcousticSignature[sigOffset + 1],
        this._chunkAcousticSignature[sigOffset + 2],
        this._chunkAcousticSignature[sigOffset + 3],
        this._chunkAcousticSignature[sigOffset + 4],
        this._chunkAcousticSignature[sigOffset + 5],
        this._chunkAcousticSignature[sigOffset + 6],
        this._chunkAcousticSignature[sigOffset + 7]
      ],
      particleDensity: this._chunkParticleDensity[slot],
      particleKind: this._chunkParticleKind[slot],
      particleColor: [
        this._chunkParticleColorR[slot],
        this._chunkParticleColorG[slot],
        this._chunkParticleColorB[slot]
      ],
      ambientTint: [
        this._chunkAmbientTintR[slot],
        this._chunkAmbientTintG[slot],
        this._chunkAmbientTintB[slot]
      ],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        acoustic: this._chunkCellAcoustic[slot],
        olfactory: this._chunkCellOlfactory[slot],
        acousticIntensity: this._chunkCellAcousticInt[slot],
        olfactoryIntensity: this._chunkCellOlfactoryInt[slot],
        particleIntensity: this._chunkCellParticleInt[slot]
      }
    };
  }

  // Sample acoustic cue at any world position.
  sampleAcousticCueAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkPrimaryAcoustic[slot];
    }
    return 0;
  }

  // Sample olfactory cue at any world position.
  sampleOlfactoryCueAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkPrimaryOlfactory[slot];
    }
    return 0;
  }

  // Sample particle density at any world position.
  sampleParticleDensityAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkParticleDensity[slot];
    }
    return 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getSensoryMaterialParams(archetype) {
    return SENSORY_MATERIAL[archetype] || SENSORY_MATERIAL[SENSORY_ARCHETYPE.SILENT_DEEP_FOREST];
  }

  blendSensoryMaterial(archetype, particleDensity, out) {
    const src = SENSORY_MATERIAL[archetype] || SENSORY_MATERIAL[SENSORY_ARCHETYPE.SILENT_DEEP_FOREST];
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
    o.pbr.extinction[0] = src.pbr.extinction[0];
    o.pbr.extinction[1] = src.pbr.extinction[1];
    o.pbr.extinction[2] = src.pbr.extinction[2];

    o.anime.baseColor[0] = src.anime.baseColor[0];
    o.anime.baseColor[1] = src.anime.baseColor[1];
    o.anime.baseColor[2] = src.anime.baseColor[2];
    o.anime.quantizeSteps = src.anime.quantizeSteps;
    o.anime.rimPower = src.anime.rimPower;
    o.anime.rimColor[0] = src.anime.rimColor[0];
    o.anime.rimColor[1] = src.anime.rimColor[1];
    o.anime.rimColor[2] = src.anime.rimColor[2];

    o.particleDensity = src.particleDensity * particleDensity;
    o.particleKind = src.particleKind;
    o.ambientTint[0] = src.ambientTint[0];
    o.ambientTint[1] = src.ambientTint[1];
    o.ambientTint[2] = src.ambientTint[2];
    o.animeFlatness = src.animeFlatness;

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.sensory) {
      spatial.sensory = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        archetype: this._chunkArchetype,
        primaryAcoustic: this._chunkPrimaryAcoustic,
        secondaryAcoustic: this._chunkSecondaryAcoustic,
        acousticIntensity: this._chunkAcousticIntensity,
        primaryOlfactory: this._chunkPrimaryOlfactory,
        secondaryOlfactory: this._chunkSecondaryOlfactory,
        olfactoryIntensity: this._chunkOlfactoryIntensity,
        temperatureFeel: this._chunkTemperatureFeel,
        humidityFeel: this._chunkHumidityFeel,
        windPressureFeel: this._chunkWindPressureFeel,
        precipitationFeel: this._chunkPrecipitationFeel,
        groundHardness: this._chunkGroundHardness,
        vegetationTouch: this._chunkVegetationTouchFeel,
        acousticSignature: this._chunkAcousticSignature,
        particleDensity: this._chunkParticleDensity,
        particleKind: this._chunkParticleKind,
        particleColorR: this._chunkParticleColorR,
        particleColorG: this._chunkParticleColorG,
        particleColorB: this._chunkParticleColorB,
        ambientTintR: this._chunkAmbientTintR,
        ambientTintG: this._chunkAmbientTintG,
        ambientTintB: this._chunkAmbientTintB,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          acoustic: this._chunkCellAcoustic,
          olfactory: this._chunkCellOlfactory,
          acousticIntensity: this._chunkCellAcousticInt,
          olfactoryIntensity: this._chunkCellOlfactoryInt,
          particleIntensity: this._chunkCellParticleInt
        },
        materialParams: SENSORY_MATERIAL,
        archetypeNames: SENSORY_ARCHETYPE_NAMES,
        acousticCueNames: ACOUSTIC_CUE_NAMES,
        olfactoryCueNames: OLFACTORY_CUE_NAMES
      };
    }

    const s = spatial.sensory;
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

    let sumAcouInt = 0, sumOlfaInt = 0, sumPartInt = 0;
    let sumTemp = 0, sumHumid = 0, sumWind = 0, sumPrecip = 0;
    let sumHardness = 0, sumVegTouch = 0;
    let sumTintR = 0, sumTintG = 0, sumTintB = 0;
    let chunksWithSensory = 0;
    const acousticCount = new Uint16Array(ACOUSTIC_CUE_NAMES.length);
    const olfactoryCount = new Uint16Array(OLFACTORY_CUE_NAMES.length);
    const archetypeCount = new Uint16Array(SENSORY_ARCHETYPE_NAMES.length);
    const particleKindCount = new Uint8Array(6);
    const sigAvg = new Float32Array(8);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      chunksWithSensory++;
      sumAcouInt += this._chunkAcousticIntensity[i];
      sumOlfaInt += this._chunkOlfactoryIntensity[i];
      sumPartInt += this._chunkParticleDensity[i];
      sumTemp += this._chunkTemperatureFeel[i];
      sumHumid += this._chunkHumidityFeel[i];
      sumWind += this._chunkWindPressureFeel[i];
      sumPrecip += this._chunkPrecipitationFeel[i];
      sumHardness += this._chunkGroundHardness[i];
      sumVegTouch += this._chunkVegetationTouchFeel[i];
      sumTintR += this._chunkAmbientTintR[i];
      sumTintG += this._chunkAmbientTintG[i];
      sumTintB += this._chunkAmbientTintB[i];
      acousticCount[this._chunkPrimaryAcoustic[i]]++;
      olfactoryCount[this._chunkPrimaryOlfactory[i]]++;
      archetypeCount[this._chunkArchetype[i]]++;
      particleKindCount[this._chunkParticleKind[i]]++;
      const sigOffset = i * 8;
      for (let k = 0; k < 8; k++) sigAvg[k] += this._chunkAcousticSignature[sigOffset + k];
    }

    const gs = this._globalSensory;
    const inv = chunksWithSensory > 0 ? 1 / chunksWithSensory : 0;
    gs.acousticIntensity = sumAcouInt * inv;
    gs.olfactoryIntensity = sumOlfaInt * inv;
    gs.avgParticleDensity = sumPartInt * inv;
    gs.avgTemperatureFeel = sumTemp * inv;
    gs.avgHumidityFeel = sumHumid * inv;
    gs.avgWindPressureFeel = sumWind * inv;
    gs.avgPrecipitationFeel = sumPrecip * inv;
    gs.avgGroundHardness = sumHardness * inv;
    gs.avgVegetationTouch = sumVegTouch * inv;
    gs.avgAmbientTint[0] = sumTintR * inv;
    gs.avgAmbientTint[1] = sumTintG * inv;
    gs.avgAmbientTint[2] = sumTintB * inv;

    for (let k = 0; k < 8; k++) sigAvg[k] *= inv;
    gs.acousticSignature = [
      sigAvg[0], sigAvg[1], sigAvg[2], sigAvg[3],
      sigAvg[4], sigAvg[5], sigAvg[6], sigAvg[7]
    ];

    // Dominant acoustic/olfactory/archetype.
    let domAcou = 0, maxAcou = 0;
    for (let a = 0; a < acousticCount.length; a++) {
      if (acousticCount[a] > maxAcou) { maxAcou = acousticCount[a]; domAcou = a; }
    }
    gs.primaryAcoustic = domAcou;
    gs.primaryAcousticName = ACOUSTIC_CUE_NAMES[domAcou];

    let domOlfa = 0, maxOlfa = 0;
    for (let o = 0; o < olfactoryCount.length; o++) {
      if (olfactoryCount[o] > maxOlfa) { maxOlfa = olfactoryCount[o]; domOlfa = o; }
    }
    gs.primaryOlfactory = domOlfa;
    gs.primaryOlfactoryName = OLFACTORY_CUE_NAMES[domOlfa];

    let domArch = 0, maxArch = 0;
    for (let a = 0; a < archetypeCount.length; a++) {
      if (archetypeCount[a] > maxArch) { maxArch = archetypeCount[a]; domArch = a; }
    }
    gs.dominantArchetype = domArch;
    gs.dominantArchetypeName = SENSORY_ARCHETYPE_NAMES[domArch];

    let domParticle = 0, maxParticle = 0;
    for (let p = 0; p < particleKindCount.length; p++) {
      if (particleKindCount[p] > maxParticle) { maxParticle = particleKindCount[p]; domParticle = p; }
    }
    gs.dominantParticleKind = domParticle;

    if (!physical.sensoryState) physical.sensoryState = {};
    Object.assign(physical.sensoryState, gs);

    // Material-facing aggregates.
    physical.sensoryAcousticCue = domAcou;
    physical.sensoryAcousticCueName = ACOUSTIC_CUE_NAMES[domAcou];
    physical.sensoryAcousticIntensity = gs.acousticIntensity;
    physical.sensoryOlfactoryCue = domOlfa;
    physical.sensoryOlfactoryCueName = OLFACTORY_CUE_NAMES[domOlfa];
    physical.sensoryOlfactoryIntensity = gs.olfactoryIntensity;
    physical.sensoryArchetype = domArch;
    physical.sensoryArchetypeName = SENSORY_ARCHETYPE_NAMES[domArch];
    physical.sensoryTemperatureFeel = gs.avgTemperatureFeel;
    physical.sensoryHumidityFeel = gs.avgHumidityFeel;
    physical.sensoryWindPressureFeel = gs.avgWindPressureFeel;
    physical.sensoryPrecipitationFeel = gs.avgPrecipitationFeel;
    physical.sensoryGroundHardness = gs.avgGroundHardness;
    physical.sensoryVegetationTouch = gs.avgVegetationTouch;
    physical.sensoryParticleDensity = gs.avgParticleDensity;
    physical.sensoryParticleKind = domParticle;
    physical.sensoryAmbientTint = gs.avgAmbientTint;
    physical.sensoryAcousticSignature = gs.acousticSignature;

    // Behavioural hooks for fauna AI.
    const predatorPresence = physical?.predatorPresence ?? 0;
    physical.faunaPredatorScent = predatorPresence * gs.olfactoryIntensity;
    physical.faunaAudioDanger = gs.acousticIntensity * (domAcou === ACOUSTIC_CUE.WOLF_HOWL ? 1 : 0.2);

    // Audio spatial anchor: player-relevant fields.
    physical.audioAmbientCue = domAcou;
    physical.audioAmbientCueName = ACOUSTIC_CUE_NAMES[domAcou];
    physical.audioAmbientIntensity = gs.acousticIntensity;
    physical.audioAmbientRadius = this.defaults.audioSpatialRadius;
    physical.audioAmbientSignature = gs.acousticSignature;

    if (!physical.sensoryAcousticWeights) {
      physical.sensoryAcousticWeights = new Float32Array(ACOUSTIC_CUE_NAMES.length);
    }
    if (chunksWithSensory > 0) {
      for (let a = 0; a < acousticCount.length; a++) {
        physical.sensoryAcousticWeights[a] = acousticCount[a] / chunksWithSensory;
      }
    }
    if (!physical.sensoryOlfactoryWeights) {
      physical.sensoryOlfactoryWeights = new Float32Array(OLFACTORY_CUE_NAMES.length);
    }
    if (chunksWithSensory > 0) {
      for (let o = 0; o < olfactoryCount.length; o++) {
        physical.sensoryOlfactoryWeights[o] = olfactoryCount[o] / chunksWithSensory;
      }
    }
    if (!physical.sensoryArchetypeWeights) {
      physical.sensoryArchetypeWeights = new Float32Array(SENSORY_ARCHETYPE_NAMES.length);
    }
    if (chunksWithSensory > 0) {
      for (let a = 0; a < archetypeCount.length; a++) {
        physical.sensoryArchetypeWeights[a] = archetypeCount[a] / chunksWithSensory;
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

    // Determine season state from seasonality provider or temporal provider.
    let seasonState = { seasonIndex: 1, seasonScalar: 0.5 };
    if (this._seasonality) {
      const s = this._seasonality.getGlobalSeasonality ? this._seasonality.getGlobalSeasonality() : null;
      if (s) seasonState = { seasonIndex: s.seasonIndex, seasonScalar: s.seasonScalar };
    } else if (this._temporal) {
      const scalar = this._temporal.seasonScalar || 0.5;
      seasonState = {
        seasonIndex: Math.floor(scalar * 4) % 4,
        seasonScalar: scalar
      };
    }

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

  setAcousticProfile(name, profile) {
    this.acousticProfiles[name] = profile;
    return this;
  }

  setSensoryMaterial(archetype, material) {
    this.material[archetype] = material;
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
  getGlobalSensory() { return { ...this._globalSensory }; }

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
    this._relief = null;
    this._cliffs = null;
    this._formations = null;
    this._rocks = null;
    this._forest = null;
    this._grass = null;
    this._continental = null;
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
    this._seasonality = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._acousticArrayPool.length = 0;
    this._olfactoryArrayPool.length = 0;
  }
}

export {
  SensoryDetailsProvider,
  ACOUSTIC_CUE,
  ACOUSTIC_CUE_NAMES,
  OLFACTORY_CUE,
  OLFACTORY_CUE_NAMES,
  SENSORY_ARCHETYPE,
  SENSORY_ARCHETYPE_NAMES,
  SENSORY_MATERIAL,
  ACOUSTIC_PROFILE,
  SENSORY_THRESHOLDS,
  SENSORY_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};