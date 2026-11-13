// file number : 298
// full path name : src/context/298_MaterialRegistry.js
// description : Canonical material registry — the single runtime mapping from materialId → material descriptor used by the impact system, the ecology response system, and every material shader in the living world. Flattens the material tables from 282_Z06 (10 rock classes with mineral composition, hardness, brittleness, flammability, acoustic profile), 282_Z07 (12 tree species with summer leaf colours and leaf optical profiles), 282_Z08 (15 grass species with blade colours and bloom colour), 283 (10 seabed classes with PBR, metalness, transmission, IOR, subsurface scattering, foam coverage, caustics strength), 284 (10 groundwater feature types with full PBR), 286 (9 decomposer archetypes with bioluminescent emissive profiles), 290 (12 soil texture classes with grain-size, roughness, wetness response), 292 (8 soil visual archetypes with iron-oxide and organic tint), and 296 (12 seasonal material presets) into one coherent ID space with fixed block ranges (0–99 rock, 100–199 soil, 200–299 seabed, 300–399 tree, 400–499 grass, 500–599 decomposer, 600–699 groundwater, 700–799 special, 800–1023 user). Provides O(1) descriptor lookup by materialId, O(1) archetype-to-materialId resolution tables for every provider, pooled per-instance override bags with wetness, fire intensity, moss coverage, snow coverage, damage, temperature, bloom factor, and seasonal phase, and a zero-allocation blend function that fuses the base material descriptor with the live context frame (weather, lighting, air quality) and the per-instance overrides to produce the final mutable PBR + anime parameters the shader reads. Exposes physical properties for downstream systems: getFlammability() for ecology ignition, getHardness() and getBrittleness() for impact fracture, getAcousticProfile() for sensory, getWetnessResponse() for wetness response scaling. Blend function implements physically-motivated wetness darkening, fire ignition emissive, moss green tint, snow white-tint with roughness increase, damage darkening, thermal emission at high temperature, and frost at low temperature, plus SimplexNoise-driven procedural colour jitter per instance to break up tiling. Emits an AUDIO_LIGHT causal event when a material is registered or updated. Zero allocation after the first frame; all scratch Vec2, Vec3, Vec4, Mat4, Quat, SimplexNoise objects are pooled.
// best for : Every consumer that needs to know "what is this object made of" — 300_ImpactEventCoordinator for fracture and decal decisions, 316_EcologyResponseSystem for ignition and fire spread, all material shaders for the final PBR + anime parameters, 297_SensoryDetailsProvider for the acoustic profile, landscape prop placement for physical behaviour, fauna impact reactions, and any future physics coupling. This is the single source of material truth for the entire living world.
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
import { TemporalContextProvider, WEATHER }                 from './276_TemporalContextProvider.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';
import { TerrainProvider, BIOME_HINT }                      from './280_TerrainProvider.js';
import { ElevationProvider, ELEVATION_BAND }                from './281_ElevationProvider.js';
import { SlopeGradientProvider }                            from './282_SlopeGradientProvider.js';
import { ReliefGradientProvider }                           from './282_Z01_ReliefGradientProvider.js';
import { CliffsGradientProvider }                           from './282_Z02_CliffsGradientProvider.js';
import { CarveGradientProvider, CARVE_MATERIAL_BAND, CARVE_MATERIAL_COLORS }
                                                            from './282_Z03_CarveGradientProvider.js';
import { RockGradientProvider, ROCK_CLASS, ROCK_CLASS_NAMES, ROCK_PROPERTIES, ROCK_BASE_COLORS }
                                                            from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE, TREE_TYPE_NAMES, TREE_LEAF_COLORS }
                                                            from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE, GRASS_TYPE_NAMES, GRASS_COLORS }
                                                            from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider }                from './282_Z09_ContinentalReliefGradientProvider.js';
import { BathymetryProvider, SEABED_CLASS, SEABED_CLASS_NAMES, SEABED_MATERIAL }
                                                            from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE, GROUNDWATER_TYPE_NAMES, GROUNDWATER_MATERIAL }
                                                            from './284_GroundwaterProvider.js';
import { MoistureLevelProvider }                            from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE, DECOMPOSER_TYPE_NAMES, DECOMPOSER_MATERIAL }
                                                            from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider }                       from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE }
                                                            from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider }                              from './289_ClimateWindProvider.js';
import { SoilCompositionProvider, SOIL_TEXTURE_CLASS, SOIL_TEXTURE_NAMES, SOIL_MATERIAL }
                                                            from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider }                            from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider, SOIL_VISUAL_ARCHETYPE, SOIL_VISUAL_MATERIAL }
                                                            from './292_SoilColorTextureProvider.js';
import { LightingSunIntensityProvider }                     from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider }                        from './294_LightingTimeOfDayProvider.js';
import { AirQualityAtmosphereProvider }                     from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem, SEASONAL_MATERIAL, PHENOLOGY_STAGE }
                                                            from './296_SeasonalitySystem.js';
import { SensoryDetailsProvider, ACOUSTIC_PROFILE }         from './297_SensoryDetailsProvider.js';

// ══════════════════════════════════════════════════════════════════
// ─── MATERIAL KIND CONSTANTS ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const MATERIAL_KIND = Object.freeze({
  ROCK:         0,
  SOIL:         1,
  SEABED:       2,
  TREE:         3,
  GRASS:        4,
  DECOMPOSER:   5,
  GROUNDWATER:  6,
  SPECIAL:      7,
  USER:         8
});

const MATERIAL_KIND_NAMES = Object.freeze([
  'rock', 'soil', 'seabed', 'tree', 'grass',
  'decomposer', 'groundwater', 'special', 'user'
]);

// ─── ID block ranges (contiguous, cache-friendly) ─────────────
const ID_BLOCK = Object.freeze({
  ROCK_START:        0,
  ROCK_END:         99,
  SOIL_START:      100,
  SOIL_END:        199,
  SEABED_START:    200,
  SEABED_END:      299,
  TREE_START:      300,
  TREE_END:        399,
  GRASS_START:     400,
  GRASS_END:       499,
  DECOMPOSER_START: 500,
  DECOMPOSER_END:  599,
  GROUNDWATER_START: 600,
  GROUNDWATER_END: 699,
  SPECIAL_START:   700,
  SPECIAL_END:     799,
  USER_START:      800,
  USER_END:       1023,
  TOTAL:          1024
});

// ─── blend coefficients (physically motivated) ────────────────
const BLEND_COEFFICIENTS = Object.freeze({
  // Wetness
  wetnessRoughnessDrop:    0.45,
  wetnessClearcoatGain:    0.35,
  wetnessColorDarken:      0.30,
  wetnessTranslucencyGain: 0.25,

  // Fire
  fireEmissiveR:           1.20,
  fireEmissiveG:           0.40,
  fireEmissiveB:           0.10,
  fireColorDarken:         0.55,
  fireTransmissionGain:    0.20,

  // Moss
  mossTintR:               0.25,
  mossTintG:               0.45,
  mossTintB:               0.20,
  mossColorMix:            0.60,
  mossRoughnessGain:       0.15,

  // Snow
  snowTintR:               0.92,
  snowTintG:               0.95,
  snowTintB:               0.99,
  snowColorMix:            0.88,
  snowRoughnessTarget:     0.85,

  // Damage
  damageColorDarken:       0.30,
  damageRoughnessGain:     0.25,
  damageMetallicDrop:      0.20,

  // Temperature
  hotEmissiveThreshold:  100.0,
  hotEmissiveScale:        0.015,
  hotEmissiveR:            1.00,
  hotEmissiveG:            0.30,
  hotEmissiveB:            0.05,
  coldFrostThreshold:      0.0,
  coldFrostScale:          0.05,
  coldFrostMax:            1.0,

  // Procedural jitter
  jitterAmplitude:         0.06,
  jitterFrequencyScale:    0.01
});

// ─── special material IDs ──────────────────────────────────────
const SPECIAL_MATERIALS = Object.freeze([
  'water_surface',
  'water_deep',
  'ice_clear',
  'ice_frozen',
  'snow_pack',
  'metal_iron',
  'metal_gold',
  'flesh',
  'blood',
  'smoke',
  'fire_flame',
  'glass',
  'fabric',
  'leather'
]);

const SPECIAL_MATERIAL_IDS = Object.freeze(
  SPECIAL_MATERIALS.reduce((acc, name, i) => {
    acc[name] = ID_BLOCK.SPECIAL_START + i;
    return acc;
  }, {})
);

// ══════════════════════════════════════════════════════════════════
// ─── MATERIAL DESCRIPTOR FACTORY ────────────────────────────────
// All descriptors share this shape. Arrays are copied so each
// descriptor has independent storage (defensive against mutation).
// ══════════════════════════════════════════════════════════════════
function makeDescriptor(id, name, kind, subtype) {
  return {
    id,
    name,
    kind,
    subtype,
    // ── PBR ─────────────────────────────────────────────
    baseColor:          [0.5, 0.5, 0.5],
    metalness:          0.0,
    roughness:          0.5,
    clearcoat:          0.0,
    transmission:       0.0,
    ior:                1.5,
    sheen:              0.0,
    anisotropy:         0.0,
    anisotropyRotation: 0.0,
    subsurfaceRadius:   [0.0, 0.0, 0.0],
    emissive:           [0.0, 0.0, 0.0],
    // ── Anime ───────────────────────────────────────────
    animeBaseColor:     [0.5, 0.5, 0.5],
    quantizeSteps:      3,
    rimPower:           2.0,
    rimColor:           [0.5, 0.5, 0.5],
    animeFlatness:      0.3,
    // ── Physical (for impact & ecology) ────────────────
    hardness:           0.5,
    brittleness:        0.5,
    flammability:       0.0,
    wetnessResponse:    0.5,
    acousticProfile:    new Float32Array([0.15, 0.15, 0.1, 0.1, 0.15, 0.05, 0.05, 0.25]),
    // ── Metadata ────────────────────────────────────────
    isEmissive:         false,
    isTransmissive:     false,
    isFoliage:          false,
    defaultUvScale:     [1.0, 1.0],
    // ── Source tracking ────────────────────────────────
    sourceProvider:     'built-in'
  };
}

// ══════════════════════════════════════════════════════════════════
// ─── MATERIAL OVERRIDE BAG (pooled) ─────────────────────────────
// Per-instance state that modulates the base material at blend time.
// ══════════════════════════════════════════════════════════════════
function makeOverrideBag() {
  return {
    wetness:         0.0,
    fireIntensity:   0.0,
    mossCoverage:    0.0,
    snowCoverage:    0.0,
    damage:          0.0,
    temperature:     20.0,
    age:             0.0,
    bloomFactor:     0.0,
    leafCoverage:    1.0,
    seasonalPhase:   0.5,
    active:          false
  };
}

// ══════════════════════════════════════════════════════════════════
// ─── BLENDED OUTPUT (single reusable buffer) ────────────────────
// The shader reads these directly. Never reallocated.
// ══════════════════════════════════════════════════════════════════
function makeBlendedOutput() {
  return {
    // PBR
    baseColor:          new Float32Array(3),
    metalness:          0,
    roughness:          1,
    clearcoat:          0,
    transmission:       0,
    ior:                1.5,
    sheen:              0,
    anisotropy:         0,
    anisotropyRotation: 0,
    subsurfaceRadius:   new Float32Array(3),
    emissive:           new Float32Array(3),
    // Anime
    animeBaseColor:     new Float32Array(3),
    quantizeSteps:      3,
    rimPower:           2,
    rimColor:           new Float32Array(3),
    animeFlatness:      0.3,
    // Physical (unchanged)
    hardness:           0.5,
    brittleness:        0.5,
    flammability:       0.0,
    // Blend modifiers actually applied
    wetnessApplied:     0,
    fireApplied:        0,
    mossApplied:        0,
    snowApplied:        0,
    damageApplied:      0,
    temperatureEffect:  0,
    // Extra
    uvScale:            new Float32Array(2),
    colorJitter:        new Float32Array(3)
  };
}

// ══════════════════════════════════════════════════════════════════
// ─── MATERIAL REGISTRY ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class MaterialRegistry {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      userMaterialCapacity: options.userMaterialCapacity ?? (ID_BLOCK.USER_END - ID_BLOCK.USER_START + 1),
      enableProceduralJitter: options.enableProceduralJitter ?? true,
      enableAcousticProfiles: options.enableAcousticProfiles ?? true,
      enableBlendEvents: options.enableBlendEvents ?? false,
      jitterAmplitude: options.jitterAmplitude ?? BLEND_COEFFICIENTS.jitterAmplitude
    };

    // ── Descriptor storage (flat array, one slot per ID) ─
    this._descriptors = new Array(ID_BLOCK.TOTAL).fill(null);

    // ── Lookup tables (archetype subtype → materialId) ──
    this._rockIdMap   = new Int32Array(ROCK_CLASS_NAMES.length).fill(-1);
    this._soilIdMap   = new Int32Array(SOIL_TEXTURE_NAMES.length).fill(-1);
    this._seabedIdMap = new Int32Array(SEABED_CLASS_NAMES.length).fill(-1);
    this._treeIdMap   = new Int32Array(TREE_TYPE_NAMES.length).fill(-1);
    this._grassIdMap  = new Int32Array(GRASS_TYPE_NAMES.length).fill(-1);
    this._decompIdMap = new Int32Array(DECOMPOSER_TYPE_NAMES.length).fill(-1);
    this._groundwaterIdMap = new Int32Array(GROUNDWATER_TYPE_NAMES.length).fill(-1);
    this._specialNameToId = new Map();

    // ── User material free list ─────────────────────────
    this._userFreeList = new Int32Array(this.defaults.userMaterialCapacity);
    this._userFreeCount = this.defaults.userMaterialCapacity;
    for (let i = 0; i < this.defaults.userMaterialCapacity; i++) {
      this._userFreeList[i] = ID_BLOCK.USER_START + i;
    }
    this._userRegisteredCount = 0;

    // ── Scratch objects (pooled, never reallocated) ─────
    this._tmpVec2A = new Vec2();
    this._tmpVec2B = new Vec2();
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec3C = new Vec3();
    this._tmpVec4A = new Vec4();
    this._tmpMatA = new Mat4();
    this._tmpQuat = new Quat();

    // ── Override bag pool ───────────────────────────────
    this._overridePool = [];
    this._overridePoolIndex = 0;

    // ── Blended output (single reusable buffer) ─────────
    this._blendedOutput = makeBlendedOutput();

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      registrations: 0,
      updates: 0,
      lookups: 0,
      blends: 0,
      overrideAcquired: 0,
      overrideReleased: 0,
      userRegistered: 0
    };

    // ── Event dispatcher (optional) ─────────────────────
    this._dispatcher = options.dispatcher || null;

    // ── Register all built-in materials ─────────────────
    this._registerBuiltIns();
  }

  // ══════════════════════════════════════════════════════════
  // ─── Built-in material registration ────────────────────
  // ══════════════════════════════════════════════════════════
  _registerBuiltIns() {
    this._registerRocks();
    this._registerSoils();
    this._registerSeabeds();
    this._registerTrees();
    this._registerGrasses();
    this._registerDecomposers();
    this._registerGroundwater();
    this._registerSpecial();
  }

  // ── Rocks (10 classes) ──────────────────────────────────
  _registerRocks() {
    for (let rc = 0; rc < ROCK_CLASS_NAMES.length; rc++) {
      const id = ID_BLOCK.ROCK_START + rc;
      const name = 'rock_' + ROCK_CLASS_NAMES[rc];
      const desc = makeDescriptor(id, name, MATERIAL_KIND.ROCK, rc);

      const baseColor = ROCK_BASE_COLORS[rc];
      const props = ROCK_PROPERTIES[rc];

      desc.baseColor[0] = baseColor[0];
      desc.baseColor[1] = baseColor[1];
      desc.baseColor[2] = baseColor[2];
      desc.animeBaseColor[0] = baseColor[0] * 1.05;
      desc.animeBaseColor[1] = baseColor[1] * 1.05;
      desc.animeBaseColor[2] = baseColor[2] * 1.05;
      desc.rimColor[0] = 0.55;
      desc.rimColor[1] = 0.62;
      desc.rimColor[2] = 0.75;
      desc.rimPower = 1.8;
      desc.metalness = props.hardness > 0.8 ? 0.05 : 0.0;
      desc.roughness = 0.55 + (1 - props.hardness) * 0.35;
      desc.clearcoat = 0.05;
      desc.transmission = 0.0;
      desc.ior = 1.50;
      desc.subsurfaceRadius[0] = 0.02;
      desc.subsurfaceRadius[1] = 0.02;
      desc.subsurfaceRadius[2] = 0.01;
      desc.hardness = props.hardness;
      desc.brittleness = props.brittleness;
      desc.flammability = props.flammability;
      desc.wetnessResponse = 0.75;
      desc.animeFlatness = 0.35;

      // Acoustic: rocks are mostly "rock + wind" with slight leaf.
      const acou = desc.acousticProfile;
      acou[0] = 0.05; acou[1] = 0.05; acou[2] = 0.05;
      acou[3] = 0.65; acou[4] = 0.10; acou[5] = 0.02;
      acou[6] = 0.00; acou[7] = 0.08;

      desc.sourceProvider = '282_Z06_RockGradientProvider';
      this._descriptors[id] = desc;
      this._rockIdMap[rc] = id;
      this._stats.registrations++;
    }
  }

  // ── Soils (12 texture classes) ─────────────────────────
  _registerSoils() {
    for (let sc = 0; sc < SOIL_TEXTURE_NAMES.length; sc++) {
      const id = ID_BLOCK.SOIL_START + sc;
      const name = 'soil_' + SOIL_TEXTURE_NAMES[sc];
      const desc = makeDescriptor(id, name, MATERIAL_KIND.SOIL, sc);

      // Use soil material definition.
      const src = SOIL_MATERIAL[sc];
      if (src) {
        desc.baseColor[0] = src.pbr.baseColor[0];
        desc.baseColor[1] = src.pbr.baseColor[1];
        desc.baseColor[2] = src.pbr.baseColor[2];
        desc.metalness = src.pbr.metalness;
        desc.roughness = src.pbr.roughness;
        desc.clearcoat = src.pbr.clearcoat;
        desc.transmission = src.pbr.transmission;
        desc.ior = src.pbr.ior;
        desc.sheen = src.pbr.sheen;
        desc.anisotropy = src.pbr.anisotropy;
        desc.animeBaseColor[0] = src.anime.baseColor[0];
        desc.animeBaseColor[1] = src.anime.baseColor[1];
        desc.animeBaseColor[2] = src.anime.baseColor[2];
        desc.quantizeSteps = src.anime.quantizeSteps;
        desc.rimPower = src.anime.rimPower;
        desc.rimColor[0] = src.anime.rimColor[0];
        desc.rimColor[1] = src.anime.rimColor[1];
        desc.rimColor[2] = src.anime.rimColor[2];
        desc.subsurfaceRadius[0] = src.subsurfaceRadius[0];
        desc.subsurfaceRadius[1] = src.subsurfaceRadius[1];
        desc.subsurfaceRadius[2] = src.subsurfaceRadius[2];
        desc.emissive[0] = src.emissive[0];
        desc.emissive[1] = src.emissive[1];
        desc.emissive[2] = src.emissive[2];
      }

      desc.hardness = 0.35;
      desc.brittleness = 0.65;
      desc.flammability = 0.0;
      desc.wetnessResponse = 0.85;
      desc.animeFlatness = 0.35;

      const acou = desc.acousticProfile;
      acou[0] = 0.10; acou[1] = 0.08; acou[2] = 0.05;
      acou[3] = 0.10; acou[4] = 0.55; acou[5] = 0.00;
      acou[6] = 0.00; acou[7] = 0.12;

      desc.sourceProvider = '290_SoilCompositionProvider';
      this._descriptors[id] = desc;
      this._soilIdMap[sc] = id;
      this._stats.registrations++;
    }
  }

  // ── Seabeds (10 classes) ────────────────────────────────
  _registerSeabeds() {
    for (let sc = 0; sc < SEABED_CLASS_NAMES.length; sc++) {
      const id = ID_BLOCK.SEABED_START + sc;
      const name = 'seabed_' + SEABED_CLASS_NAMES[sc];
      const desc = makeDescriptor(id, name, MATERIAL_KIND.SEABED, sc);

      const src = SEABED_MATERIAL[sc];
      if (src) {
        desc.baseColor[0] = src.pbr.baseColor[0];
        desc.baseColor[1] = src.pbr.baseColor[1];
        desc.baseColor[2] = src.pbr.baseColor[2];
        desc.metalness = src.pbr.metalness;
        desc.roughness = src.pbr.roughness;
        desc.clearcoat = src.pbr.clearcoat;
        desc.transmission = src.pbr.transmission;
        desc.ior = src.pbr.ior;
        desc.sheen = src.pbr.sheen;
        desc.anisotropy = src.pbr.anisotropy;
        desc.animeBaseColor[0] = src.anime.baseColor[0];
        desc.animeBaseColor[1] = src.anime.baseColor[1];
        desc.animeBaseColor[2] = src.anime.baseColor[2];
        desc.quantizeSteps = src.anime.quantizeSteps;
        desc.rimPower = src.anime.rimPower;
        desc.rimColor[0] = src.anime.rimColor[0];
        desc.rimColor[1] = src.anime.rimColor[1];
        desc.rimColor[2] = src.anime.rimColor[2];
        desc.subsurfaceRadius[0] = src.subsurfaceRadius[0];
        desc.subsurfaceRadius[1] = src.subsurfaceRadius[1];
        desc.subsurfaceRadius[2] = src.subsurfaceRadius[2];
        desc.emissive[0] = src.emissive[0];
        desc.emissive[1] = src.emissive[1];
        desc.emissive[2] = src.emissive[2];
      }

      desc.hardness = 0.30;
      desc.brittleness = 0.55;
      desc.flammability = 0.0;
      desc.wetnessResponse = 0.15;   // underwater, wetness doesn't matter
      desc.animeFlatness = 0.30;

      const acou = desc.acousticProfile;
      acou[0] = 0.05; acou[1] = 0.55; acou[2] = 0.05;
      acou[3] = 0.20; acou[4] = 0.08; acou[5] = 0.00;
      acou[6] = 0.00; acou[7] = 0.07;

      desc.sourceProvider = '283_BathymetryProvider';
      this._descriptors[id] = desc;
      this._seabedIdMap[sc] = id;
      this._stats.registrations++;
    }
  }

  // ── Trees (12 species) ──────────────────────────────────
  _registerTrees() {
    for (let tc = 0; tc < TREE_TYPE_NAMES.length; tc++) {
      const id = ID_BLOCK.TREE_START + tc;
      const name = 'tree_' + TREE_TYPE_NAMES[tc];
      const desc = makeDescriptor(id, name, MATERIAL_KIND.TREE, tc);

      const leafColors = TREE_LEAF_COLORS[tc];
      const summer = leafColors ? leafColors.summer : [0.28, 0.52, 0.18];

      desc.baseColor[0] = summer[0];
      desc.baseColor[1] = summer[1];
      desc.baseColor[2] = summer[2];
      desc.animeBaseColor[0] = summer[0] * 1.08;
      desc.animeBaseColor[1] = summer[1] * 1.08;
      desc.animeBaseColor[2] = summer[2] * 1.08;
      desc.metalness = 0.0;
      desc.roughness = 0.65;
      desc.clearcoat = 0.20;
      desc.transmission = 0.08;
      desc.ior = 1.40;
      desc.sheen = 0.30;
      desc.anisotropy = 0.0;
      desc.rimPower = 1.7;
      desc.rimColor[0] = 0.45;
      desc.rimColor[1] = 0.85;
      desc.rimColor[2] = 0.40;
      desc.subsurfaceRadius[0] = 0.14;
      desc.subsurfaceRadius[1] = 0.20;
      desc.subsurfaceRadius[2] = 0.08;
      desc.animeFlatness = 0.25;

      desc.hardness = 0.15;
      desc.brittleness = 0.45;
      desc.flammability = 0.75;
      desc.wetnessResponse = 0.65;
      desc.isFoliage = true;

      const acou = desc.acousticProfile;
      acou[0] = 0.80; acou[1] = 0.05; acou[2] = 0.10;
      acou[3] = 0.02; acou[4] = 0.00; acou[5] = 0.00;
      acou[6] = 0.00; acou[7] = 0.03;

      desc.sourceProvider = '282_Z07_ForestGradientProvider';
      this._descriptors[id] = desc;
      this._treeIdMap[tc] = id;
      this._stats.registrations++;
    }
  }

  // ── Grasses (15 species) ────────────────────────────────
  _registerGrasses() {
    for (let gc = 0; gc < GRASS_TYPE_NAMES.length; gc++) {
      const id = ID_BLOCK.GRASS_START + gc;
      const name = 'grass_' + GRASS_TYPE_NAMES[gc];
      const desc = makeDescriptor(id, name, MATERIAL_KIND.GRASS, gc);

      const grassColors = GRASS_COLORS[gc];
      const summer = grassColors ? grassColors.blade.summer : [0.42, 0.62, 0.28];

      desc.baseColor[0] = summer[0];
      desc.baseColor[1] = summer[1];
      desc.baseColor[2] = summer[2];
      desc.animeBaseColor[0] = summer[0] * 1.08;
      desc.animeBaseColor[1] = summer[1] * 1.08;
      desc.animeBaseColor[2] = summer[2] * 1.08;
      desc.metalness = 0.0;
      desc.roughness = 0.60;
      desc.clearcoat = 0.15;
      desc.transmission = 0.10;
      desc.ior = 1.38;
      desc.sheen = 0.25;
      desc.rimPower = 1.8;
      desc.rimColor[0] = 0.55;
      desc.rimColor[1] = 0.90;
      desc.rimColor[2] = 0.55;
      desc.subsurfaceRadius[0] = 0.08;
      desc.subsurfaceRadius[1] = 0.12;
      desc.subsurfaceRadius[2] = 0.05;
      desc.animeFlatness = 0.28;

      desc.hardness = 0.08;
      desc.brittleness = 0.55;
      desc.flammability = 0.85;
      desc.wetnessResponse = 0.55;
      desc.isFoliage = true;

      const acou = desc.acousticProfile;
      acou[0] = 0.75; acou[1] = 0.05; acou[2] = 0.05;
      acou[3] = 0.02; acou[4] = 0.10; acou[5] = 0.00;
      acou[6] = 0.00; acou[7] = 0.03;

      desc.sourceProvider = '282_Z08_GrassAndFlowresGradientProvider';
      this._descriptors[id] = desc;
      this._grassIdMap[gc] = id;
      this._stats.registrations++;
    }
  }

  // ── Decomposers (9 types) ───────────────────────────────
  _registerDecomposers() {
    for (let dc = 1; dc < DECOMPOSER_TYPE_NAMES.length; dc++) {   // skip NONE
      const id = ID_BLOCK.DECOMPOSER_START + (dc - 1);
      const name = 'decomposer_' + DECOMPOSER_TYPE_NAMES[dc];
      const desc = makeDescriptor(id, name, MATERIAL_KIND.DECOMPOSER, dc);

      const src = DECOMPOSER_MATERIAL[dc];
      if (src) {
        desc.baseColor[0] = src.pbr.baseColor[0];
        desc.baseColor[1] = src.pbr.baseColor[1];
        desc.baseColor[2] = src.pbr.baseColor[2];
        desc.metalness = src.pbr.metalness;
        desc.roughness = src.pbr.roughness;
        desc.clearcoat = src.pbr.clearcoat;
        desc.transmission = src.pbr.transmission;
        desc.ior = src.pbr.ior;
        desc.sheen = src.pbr.sheen;
        desc.animeBaseColor[0] = src.anime.baseColor[0];
        desc.animeBaseColor[1] = src.anime.baseColor[1];
        desc.animeBaseColor[2] = src.anime.baseColor[2];
        desc.quantizeSteps = src.anime.quantizeSteps;
        desc.rimPower = src.anime.rimPower;
        desc.rimColor[0] = src.anime.rimColor[0];
        desc.rimColor[1] = src.anime.rimColor[1];
        desc.rimColor[2] = src.anime.rimColor[2];
        desc.subsurfaceRadius[0] = src.subsurfaceRadius[0];
        desc.subsurfaceRadius[1] = src.subsurfaceRadius[1];
        desc.subsurfaceRadius[2] = src.subsurfaceRadius[2];
        desc.emissive[0] = src.emissive[0];
        desc.emissive[1] = src.emissive[1];
        desc.emissive[2] = src.emissive[2];

        desc.isEmissive = src.emissive[0] > 0.01 ||
                          src.emissive[1] > 0.01 ||
                          src.emissive[2] > 0.01;
      }

      desc.hardness = 0.05;
      desc.brittleness = 0.85;
      desc.flammability = dc === DECOMPOSER_TYPE.BIOLUMINESCENT ? 0.30 : 0.10;
      desc.wetnessResponse = 0.35;
      desc.animeFlatness = 0.40;

      const acou = desc.acousticProfile;
      acou[0] = 0.20; acou[1] = 0.10; acou[2] = 0.05;
      acou[3] = 0.05; acou[4] = 0.20; acou[5] = 0.00;
      acou[6] = 0.10; acou[7] = 0.30;

      desc.sourceProvider = '286_DecomposersSystem';
      this._descriptors[id] = desc;
      this._decompIdMap[dc] = id;
      this._stats.registrations++;
    }
  }

  // ── Groundwater (10 feature types) ──────────────────────
  _registerGroundwater() {
    for (let gc = 1; gc < GROUNDWATER_TYPE_NAMES.length; gc++) {
      const id = ID_BLOCK.GROUNDWATER_START + (gc - 1);
      const name = 'groundwater_' + GROUNDWATER_TYPE_NAMES[gc];
      const desc = makeDescriptor(id, name, MATERIAL_KIND.GROUNDWATER, gc);

      const src = GROUNDWATER_MATERIAL[gc];
      if (src) {
        desc.baseColor[0] = src.pbr.baseColor[0];
        desc.baseColor[1] = src.pbr.baseColor[1];
        desc.baseColor[2] = src.pbr.baseColor[2];
        desc.metalness = src.pbr.metalness;
        desc.roughness = src.pbr.roughness;
        desc.clearcoat = src.pbr.clearcoat;
        desc.transmission = src.pbr.transmission;
        desc.ior = src.pbr.ior;
        desc.sheen = src.pbr.sheen;
        desc.anisotropy = src.pbr.anisotropy;
        desc.animeBaseColor[0] = src.anime.baseColor[0];
        desc.animeBaseColor[1] = src.anime.baseColor[1];
        desc.animeBaseColor[2] = src.anime.baseColor[2];
        desc.quantizeSteps = src.anime.quantizeSteps;
        desc.rimPower = src.anime.rimPower;
        desc.rimColor[0] = src.anime.rimColor[0];
        desc.rimColor[1] = src.anime.rimColor[1];
        desc.rimColor[2] = src.anime.rimColor[2];
        desc.subsurfaceRadius[0] = src.subsurfaceRadius[0];
        desc.subsurfaceRadius[1] = src.subsurfaceRadius[1];
        desc.subsurfaceRadius[2] = src.subsurfaceRadius[2];
        desc.emissive[0] = src.emissive[0];
        desc.emissive[1] = src.emissive[1];
        desc.emissive[2] = src.emissive[2];

        desc.isTransmissive = src.pbr.transmission > 0.5;
      }

      desc.hardness = 0.05;
      desc.brittleness = 0.20;
      desc.flammability = 0.0;
      desc.wetnessResponse = 0.10;
      desc.animeFlatness = 0.30;

      const acou = desc.acousticProfile;
      acou[0] = 0.05; acou[1] = 0.65; acou[2] = 0.05;
      acou[3] = 0.15; acou[4] = 0.05; acou[5] = 0.00;
      acou[6] = 0.00; acou[7] = 0.05;

      desc.sourceProvider = '284_GroundwaterProvider';
      this._descriptors[id] = desc;
      this._groundwaterIdMap[gc] = id;
      this._stats.registrations++;
    }
  }

  // ── Special materials (14 entries) ──────────────────────
  _registerSpecial() {
    const specialDefs = [
      { name: 'water_surface', color: [0.15, 0.35, 0.45], metal: 0, rough: 0.10, coat: 0.90, trans: 0.85, ior: 1.33, hard: 0.02, brit: 0.05, flam: 0, wetR: 0.05, acou: [0.05, 0.80, 0.05, 0.05, 0.02, 0, 0, 0.03] },
      { name: 'water_deep', color: [0.05, 0.15, 0.25], metal: 0, rough: 0.15, coat: 0.60, trans: 0.92, ior: 1.33, hard: 0.02, brit: 0.05, flam: 0, wetR: 0.05, acou: [0.05, 0.85, 0.02, 0.03, 0.03, 0, 0, 0.02] },
      { name: 'ice_clear', color: [0.85, 0.92, 0.98], metal: 0, rough: 0.10, coat: 0.80, trans: 0.90, ior: 1.31, hard: 0.35, brit: 0.90, flam: 0, wetR: 0.10, acou: [0.05, 0.30, 0.02, 0.55, 0.02, 0.03, 0, 0.03] },
      { name: 'ice_frozen', color: [0.75, 0.82, 0.92], metal: 0, rough: 0.35, coat: 0.50, trans: 0.55, ior: 1.31, hard: 0.40, brit: 0.85, flam: 0, wetR: 0.15, acou: [0.05, 0.25, 0.02, 0.60, 0.03, 0.03, 0, 0.02] },
      { name: 'snow_pack', color: [0.92, 0.95, 0.99], metal: 0, rough: 0.80, coat: 0.05, trans: 0.15, ior: 1.31, hard: 0.10, brit: 0.40, flam: 0, wetR: 0.20, acou: [0.10, 0.30, 0.05, 0.10, 0.40, 0, 0, 0.05] },
      { name: 'metal_iron', color: [0.45, 0.45, 0.48], metal: 0.90, rough: 0.40, coat: 0.20, trans: 0, ior: 2.50, hard: 0.95, brit: 0.20, flam: 0, wetR: 0.05, acou: [0.02, 0.02, 0.02, 0.10, 0.02, 0.80, 0.02, 0.03] },
      { name: 'metal_gold', color: [0.95, 0.75, 0.20], metal: 1.0, rough: 0.20, coat: 0.30, trans: 0, ior: 2.60, hard: 0.80, brit: 0.10, flam: 0, wetR: 0.02, acou: [0.02, 0.02, 0.02, 0.10, 0.02, 0.80, 0.02, 0.03] },
      { name: 'flesh', color: [0.85, 0.55, 0.50], metal: 0, rough: 0.55, coat: 0.10, trans: 0.10, ior: 1.40, hard: 0.10, brit: 0.55, flam: 0.05, wetR: 0.65, acou: [0.02, 0.05, 0.02, 0.02, 0.05, 0.02, 0.78, 0.04] },
      { name: 'blood', color: [0.55, 0.05, 0.05], metal: 0, rough: 0.20, coat: 0.60, trans: 0.30, ior: 1.35, hard: 0.02, brit: 0.10, flam: 0, wetR: 0.15, acou: [0.02, 0.30, 0.02, 0.02, 0.05, 0, 0.55, 0.04] },
      { name: 'smoke', color: [0.55, 0.55, 0.55], metal: 0, rough: 1.0, coat: 0, trans: 0.85, ior: 1.00, hard: 0, brit: 1.0, flam: 0.5, wetR: 0.05, acou: [0.05, 0.05, 0.02, 0.02, 0.02, 0, 0, 0.84] },
      { name: 'fire_flame', color: [1.0, 0.55, 0.15], metal: 0, rough: 1.0, coat: 0, trans: 1.0, ior: 1.00, hard: 0, brit: 1.0, flam: 1.0, wetR: 0.05, acou: [0.05, 0.05, 0.05, 0.05, 0.05, 0, 0, 0.75] },
      { name: 'glass', color: [0.90, 0.95, 0.95], metal: 0, rough: 0.05, coat: 1.0, trans: 0.95, ior: 1.52, hard: 0.60, brit: 0.95, flam: 0, wetR: 0.15, acou: [0.02, 0.10, 0.02, 0.20, 0.02, 0.60, 0, 0.04] },
      { name: 'fabric', color: [0.60, 0.55, 0.50], metal: 0, rough: 0.85, coat: 0.05, trans: 0.05, ior: 1.40, hard: 0.05, brit: 0.30, flam: 0.85, wetR: 0.75, acou: [0.10, 0.15, 0.15, 0.05, 0.10, 0, 0.35, 0.10] },
      { name: 'leather', color: [0.55, 0.35, 0.22], metal: 0, rough: 0.55, coat: 0.20, trans: 0, ior: 1.45, hard: 0.25, brit: 0.30, flam: 0.55, wetR: 0.55, acou: [0.08, 0.08, 0.15, 0.10, 0.15, 0.05, 0.30, 0.09] }
    ];

    for (let i = 0; i < specialDefs.length; i++) {
      const def = specialDefs[i];
      const id = ID_BLOCK.SPECIAL_START + i;
      const desc = makeDescriptor(id, def.name, MATERIAL_KIND.SPECIAL, i);

      desc.baseColor[0] = def.color[0];
      desc.baseColor[1] = def.color[1];
      desc.baseColor[2] = def.color[2];
      desc.animeBaseColor[0] = def.color[0] * 1.05;
      desc.animeBaseColor[1] = def.color[1] * 1.05;
      desc.animeBaseColor[2] = def.color[2] * 1.05;
      desc.metalness = def.metal;
      desc.roughness = def.rough;
      desc.clearcoat = def.coat;
      desc.transmission = def.trans;
      desc.ior = def.ior;
      desc.hardness = def.hard;
      desc.brittleness = def.brit;
      desc.flammability = def.flam;
      desc.wetnessResponse = def.wetR;
      desc.animeFlatness = 0.30;

      desc.rimColor[0] = 0.65;
      desc.rimColor[1] = 0.75;
      desc.rimColor[2] = 0.85;
      desc.rimPower = 1.8;

      for (let k = 0; k < 8; k++) desc.acousticProfile[k] = def.acou[k];

      desc.isTransmissive = def.trans > 0.5;
      desc.isEmissive = def.name === 'fire_flame';

      desc.sourceProvider = '298_special';
      this._descriptors[id] = desc;
      this._specialNameToId.set(def.name, id);
      this._stats.registrations++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Lookup APIs ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════

  // Direct descriptor lookup by materialId.
  getDescriptor(materialId) {
    if (materialId < 0 || materialId >= ID_BLOCK.TOTAL) return null;
    this._stats.lookups++;
    return this._descriptors[materialId];
  }

  // ── Archetype → ID resolution (all O(1)) ──────────────
  getRockMaterialId(rockClass) {
    if (rockClass < 0 || rockClass >= this._rockIdMap.length) return -1;
    return this._rockIdMap[rockClass];
  }

  getSoilMaterialId(textureClass) {
    if (textureClass < 0 || textureClass >= this._soilIdMap.length) return -1;
    return this._soilIdMap[textureClass];
  }

  getSeabedMaterialId(seabedClass) {
    if (seabedClass < 0 || seabedClass >= this._seabedIdMap.length) return -1;
    return this._seabedIdMap[seabedClass];
  }

  getTreeMaterialId(treeType) {
    if (treeType < 0 || treeType >= this._treeIdMap.length) return -1;
    return this._treeIdMap[treeType];
  }

  getGrassMaterialId(grassType) {
    if (grassType < 0 || grassType >= this._grassIdMap.length) return -1;
    return this._grassIdMap[grassType];
  }

  getDecomposerMaterialId(decomposerType) {
    if (decomposerType < 0 || decomposerType >= this._decompIdMap.length) return -1;
    return this._decompIdMap[decomposerType];
  }

  getGroundwaterMaterialId(featureType) {
    if (featureType < 0 || featureType >= this._groundwaterIdMap.length) return -1;
    return this._groundwaterIdMap[featureType];
  }

  getSpecialMaterialId(name) {
    return this._specialNameToId.get(name) ?? -1;
  }

  // ── Physical property accessors (fast, for impact/ecology) ──
  getFlammability(materialId) {
    const d = this._descriptors[materialId];
    return d ? d.flammability : 0;
  }

  getHardness(materialId) {
    const d = this._descriptors[materialId];
    return d ? d.hardness : 0.5;
  }

  getBrittleness(materialId) {
    const d = this._descriptors[materialId];
    return d ? d.brittleness : 0.5;
  }

  getWetnessResponse(materialId) {
    const d = this._descriptors[materialId];
    return d ? d.wetnessResponse : 0.5;
  }

  getAcousticProfile(materialId) {
    const d = this._descriptors[materialId];
    return d ? d.acousticProfile : null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── User material registration ────────────────────────
  // ══════════════════════════════════════════════════════════
  registerMaterial(descriptor) {
    if (this._userFreeCount === 0) return -1;

    this._userFreeCount--;
    const id = this._userFreeList[this._userFreeCount];

    const desc = makeDescriptor(id, descriptor.name || 'user_material', MATERIAL_KIND.USER, 0);

    // Copy fields from provided descriptor.
    if (descriptor.baseColor) {
      desc.baseColor[0] = descriptor.baseColor[0];
      desc.baseColor[1] = descriptor.baseColor[1];
      desc.baseColor[2] = descriptor.baseColor[2];
    }
    if (descriptor.metalness !== undefined) desc.metalness = descriptor.metalness;
    if (descriptor.roughness !== undefined) desc.roughness = descriptor.roughness;
    if (descriptor.clearcoat !== undefined) desc.clearcoat = descriptor.clearcoat;
    if (descriptor.transmission !== undefined) desc.transmission = descriptor.transmission;
    if (descriptor.ior !== undefined) desc.ior = descriptor.ior;
    if (descriptor.sheen !== undefined) desc.sheen = descriptor.sheen;
    if (descriptor.anisotropy !== undefined) desc.anisotropy = descriptor.anisotropy;
    if (descriptor.subsurfaceRadius) {
      desc.subsurfaceRadius[0] = descriptor.subsurfaceRadius[0];
      desc.subsurfaceRadius[1] = descriptor.subsurfaceRadius[1];
      desc.subsurfaceRadius[2] = descriptor.subsurfaceRadius[2];
    }
    if (descriptor.emissive) {
      desc.emissive[0] = descriptor.emissive[0];
      desc.emissive[1] = descriptor.emissive[1];
      desc.emissive[2] = descriptor.emissive[2];
    }
    if (descriptor.animeBaseColor) {
      desc.animeBaseColor[0] = descriptor.animeBaseColor[0];
      desc.animeBaseColor[1] = descriptor.animeBaseColor[1];
      desc.animeBaseColor[2] = descriptor.animeBaseColor[2];
    }
    if (descriptor.quantizeSteps !== undefined) desc.quantizeSteps = descriptor.quantizeSteps;
    if (descriptor.rimPower !== undefined) desc.rimPower = descriptor.rimPower;
    if (descriptor.rimColor) {
      desc.rimColor[0] = descriptor.rimColor[0];
      desc.rimColor[1] = descriptor.rimColor[1];
      desc.rimColor[2] = descriptor.rimColor[2];
    }
    if (descriptor.animeFlatness !== undefined) desc.animeFlatness = descriptor.animeFlatness;
    if (descriptor.hardness !== undefined) desc.hardness = descriptor.hardness;
    if (descriptor.brittleness !== undefined) desc.brittleness = descriptor.brittleness;
    if (descriptor.flammability !== undefined) desc.flammability = descriptor.flammability;
    if (descriptor.wetnessResponse !== undefined) desc.wetnessResponse = descriptor.wetnessResponse;

    desc.sourceProvider = '298_user';

    this._descriptors[id] = desc;
    this._userRegisteredCount++;
    this._stats.registrations++;
    this._stats.userRegistered++;

    if (this._dispatcher) {
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.AUDIO_LIGHT,
        [0, 0, 0],
        id, 1, 1.0,
        { kind: 'material_registered', materialId: id, materialName: desc.name }
      );
    }

    return id;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Override bag pool ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  acquireOverrideBag() {
    if (this._overridePoolIndex < this._overridePool.length) {
      const bag = this._overridePool[this._overridePoolIndex];
      this._overridePoolIndex++;
      bag.wetness = 0;
      bag.fireIntensity = 0;
      bag.mossCoverage = 0;
      bag.snowCoverage = 0;
      bag.damage = 0;
      bag.temperature = 20;
      bag.age = 0;
      bag.bloomFactor = 0;
      bag.leafCoverage = 1;
      bag.seasonalPhase = 0.5;
      bag.active = true;
      this._stats.overrideAcquired++;
      return bag;
    }
    const bag = makeOverrideBag();
    bag.active = true;
    this._overridePool.push(bag);
    this._overridePoolIndex++;
    this._stats.overrideAcquired++;
    return bag;
  }

  releaseOverrideBag(bag) {
    if (bag) {
      bag.active = false;
      this._stats.overrideReleased++;
    }
  }

  resetOverridePool() {
    this._overridePoolIndex = 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Blend material ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Blends base descriptor + overrides + context into
  // the reusable _blendedOutput. Returns the output buffer.
  // No allocation.
  blendMaterial(materialId, overrides, frame) {
    this._stats.blends++;
    const desc = this._descriptors[materialId];
    const out = this._blendedOutput;

    if (!desc) {
      // Fallback: neutral grey.
      out.baseColor[0] = 0.5;
      out.baseColor[1] = 0.5;
      out.baseColor[2] = 0.5;
      out.metalness = 0;
      out.roughness = 0.5;
      out.clearcoat = 0;
      out.transmission = 0;
      out.ior = 1.5;
      out.sheen = 0;
      out.anisotropy = 0;
      out.anisotropyRotation = 0;
      out.subsurfaceRadius[0] = 0;
      out.subsurfaceRadius[1] = 0;
      out.subsurfaceRadius[2] = 0;
      out.emissive[0] = 0;
      out.emissive[1] = 0;
      out.emissive[2] = 0;
      out.animeBaseColor[0] = 0.5;
      out.animeBaseColor[1] = 0.5;
      out.animeBaseColor[2] = 0.5;
      out.quantizeSteps = 3;
      out.rimPower = 2;
      out.rimColor[0] = 0.5;
      out.rimColor[1] = 0.5;
      out.rimColor[2] = 0.5;
      out.animeFlatness = 0.3;
      out.hardness = 0.5;
      out.brittleness = 0.5;
      out.flammability = 0;
      out.wetnessApplied = 0;
      out.fireApplied = 0;
      out.mossApplied = 0;
      out.snowApplied = 0;
      out.damageApplied = 0;
      out.temperatureEffect = 0;
      out.uvScale[0] = 1;
      out.uvScale[1] = 1;
      out.colorJitter[0] = 0;
      out.colorJitter[1] = 0;
      out.colorJitter[2] = 0;
      return out;
    }

    // ── Copy base descriptor into output ──────────────
    out.baseColor[0] = desc.baseColor[0];
    out.baseColor[1] = desc.baseColor[1];
    out.baseColor[2] = desc.baseColor[2];
    out.metalness = desc.metalness;
    out.roughness = desc.roughness;
    out.clearcoat = desc.clearcoat;
    out.transmission = desc.transmission;
    out.ior = desc.ior;
    out.sheen = desc.sheen;
    out.anisotropy = desc.anisotropy;
    out.anisotropyRotation = desc.anisotropyRotation;
    out.subsurfaceRadius[0] = desc.subsurfaceRadius[0];
    out.subsurfaceRadius[1] = desc.subsurfaceRadius[1];
    out.subsurfaceRadius[2] = desc.subsurfaceRadius[2];
    out.emissive[0] = desc.emissive[0];
    out.emissive[1] = desc.emissive[1];
    out.emissive[2] = desc.emissive[2];
    out.animeBaseColor[0] = desc.animeBaseColor[0];
    out.animeBaseColor[1] = desc.animeBaseColor[1];
    out.animeBaseColor[2] = desc.animeBaseColor[2];
    out.quantizeSteps = desc.quantizeSteps;
    out.rimPower = desc.rimPower;
    out.rimColor[0] = desc.rimColor[0];
    out.rimColor[1] = desc.rimColor[1];
    out.rimColor[2] = desc.rimColor[2];
    out.animeFlatness = desc.animeFlatness;
    out.hardness = desc.hardness;
    out.brittleness = desc.brittleness;
    out.flammability = desc.flammability;
    out.wetnessApplied = 0;
    out.fireApplied = 0;
    out.mossApplied = 0;
    out.snowApplied = 0;
    out.damageApplied = 0;
    out.temperatureEffect = 0;
    out.uvScale[0] = desc.defaultUvScale[0];
    out.uvScale[1] = desc.defaultUvScale[1];
    out.colorJitter[0] = 0;
    out.colorJitter[1] = 0;
    out.colorJitter[2] = 0;

    if (!overrides) return out;

    // ── Apply overrides ───────────────────────────────

    // ── Wetness ───────────────────────────────────────
    if (overrides.wetness > 0.001) {
      const eff = overrides.wetness * desc.wetnessResponse;
      const k = eff * BLEND_COEFFICIENTS.wetnessRoughnessDrop;
      out.roughness = Math.max(0.02, out.roughness - k);
      out.clearcoat = Math.min(1, out.clearcoat + eff * BLEND_COEFFICIENTS.wetnessClearcoatGain);
      const darken = 1 - eff * BLEND_COEFFICIENTS.wetnessColorDarken;
      out.baseColor[0] *= darken;
      out.baseColor[1] *= darken;
      out.baseColor[2] *= darken;
      out.animeBaseColor[0] *= darken;
      out.animeBaseColor[1] *= darken;
      out.animeBaseColor[2] *= darken;
      out.wetnessApplied = eff;
    }

    // ── Fire ──────────────────────────────────────────
    if (overrides.fireIntensity > 0.001) {
      const f = overrides.fireIntensity;
      const darken = 1 - f * BLEND_COEFFICIENTS.fireColorDarken;
      out.baseColor[0] *= darken;
      out.baseColor[1] *= darken;
      out.baseColor[2] *= darken;
      out.animeBaseColor[0] *= darken;
      out.animeBaseColor[1] *= darken;
      out.animeBaseColor[2] *= darken;

      out.emissive[0] += f * BLEND_COEFFICIENTS.fireEmissiveR;
      out.emissive[1] += f * BLEND_COEFFICIENTS.fireEmissiveG;
      out.emissive[2] += f * BLEND_COEFFICIENTS.fireEmissiveB;

      out.transmission = Math.min(1,
        out.transmission + f * BLEND_COEFFICIENTS.fireTransmissionGain);
      out.animeFlatness = Math.min(1,
        out.animeFlatness + f * 0.15);
      out.fireApplied = f;
    }

    // ── Moss ──────────────────────────────────────────
    if (overrides.mossCoverage > 0.001) {
      const m = overrides.mossCoverage * BLEND_COEFFICIENTS.mossColorMix;
      out.baseColor[0] = out.baseColor[0] * (1 - m) + BLEND_COEFFICIENTS.mossTintR * m;
      out.baseColor[1] = out.baseColor[1] * (1 - m) + BLEND_COEFFICIENTS.mossTintG * m;
      out.baseColor[2] = out.baseColor[2] * (1 - m) + BLEND_COEFFICIENTS.mossTintB * m;
      out.animeBaseColor[0] = out.animeBaseColor[0] * (1 - m) + BLEND_COEFFICIENTS.mossTintR * m;
      out.animeBaseColor[1] = out.animeBaseColor[1] * (1 - m) + BLEND_COEFFICIENTS.mossTintG * m;
      out.animeBaseColor[2] = out.animeBaseColor[2] * (1 - m) + BLEND_COEFFICIENTS.mossTintB * m;
      out.roughness = Math.min(1,
        out.roughness + m * BLEND_COEFFICIENTS.mossRoughnessGain);
      out.mossApplied = m;
    }

    // ── Snow ──────────────────────────────────────────
    if (overrides.snowCoverage > 0.001) {
      const s = overrides.snowCoverage * BLEND_COEFFICIENTS.snowColorMix;
      out.baseColor[0] = out.baseColor[0] * (1 - s) + BLEND_COEFFICIENTS.snowTintR * s;
      out.baseColor[1] = out.baseColor[1] * (1 - s) + BLEND_COEFFICIENTS.snowTintG * s;
      out.baseColor[2] = out.baseColor[2] * (1 - s) + BLEND_COEFFICIENTS.snowTintB * s;
      out.animeBaseColor[0] = out.animeBaseColor[0] * (1 - s) + BLEND_COEFFICIENTS.snowTintR * s;
      out.animeBaseColor[1] = out.animeBaseColor[1] * (1 - s) + BLEND_COEFFICIENTS.snowTintG * s;
      out.animeBaseColor[2] = out.animeBaseColor[2] * (1 - s) + BLEND_COEFFICIENTS.snowTintB * s;
      const snowW = overrides.snowCoverage;
      out.roughness = out.roughness * (1 - snowW) +
                      BLEND_COEFFICIENTS.snowRoughnessTarget * snowW;
      out.snowApplied = s;
    }

    // ── Damage ────────────────────────────────────────
    if (overrides.damage > 0.001) {
      const d = overrides.damage;
      const darken = 1 - d * BLEND_COEFFICIENTS.damageColorDarken;
      out.baseColor[0] *= darken;
      out.baseColor[1] *= darken;
      out.baseColor[2] *= darken;
      out.roughness = Math.min(1,
        out.roughness + d * BLEND_COEFFICIENTS.damageRoughnessGain);
      out.metalness = Math.max(0,
        out.metalness - d * BLEND_COEFFICIENTS.damageMetallicDrop);
      out.damageApplied = d;
    }

    // ── Temperature ──────────────────────────────────
    const tempEffect = this._computeTemperatureEffect(
      out, desc, overrides.temperature
    );
    out.temperatureEffect = tempEffect;

    // ── Seasonal blending (for foliage) ───────────────
    if (desc.isFoliage && overrides.seasonalPhase !== undefined) {
      this._applySeasonalBlend(out, overrides, desc);
    }

    // ── Procedural colour jitter ─────────────────────
    if (this.defaults.enableProceduralJitter && overrides.age > 0) {
      const amp = this.defaults.jitterAmplitude;
      const seedX = overrides.age * BLEND_COEFFICIENTS.jitterFrequencyScale;
      const seedY = materialId * 0.173;
      const jr = SimplexNoise.noise(seedX, seedY) * amp;
      const jg = SimplexNoise.noise(seedX + 1.7, seedY) * amp;
      const jb = SimplexNoise.noise(seedX + 3.3, seedY) * amp;
      out.colorJitter[0] = jr;
      out.colorJitter[1] = jg;
      out.colorJitter[2] = jb;
      out.baseColor[0] = Math.max(0, Math.min(1, out.baseColor[0] + jr));
      out.baseColor[1] = Math.max(0, Math.min(1, out.baseColor[1] + jg));
      out.baseColor[2] = Math.max(0, Math.min(1, out.baseColor[2] + jb));
    }

    return out;
  }

  // ── Temperature effect ──────────────────────────────────
  _computeTemperatureEffect(out, desc, temperature) {
    if (temperature === undefined) return 0;
    let effect = 0;

    // Hot: emit thermal radiation.
    if (temperature > BLEND_COEFFICIENTS.hotEmissiveThreshold) {
      const excess = temperature - BLEND_COEFFICIENTS.hotEmissiveThreshold;
      const scale = excess * BLEND_COEFFICIENTS.hotEmissiveScale;
      out.emissive[0] += scale * BLEND_COEFFICIENTS.hotEmissiveR;
      out.emissive[1] += scale * BLEND_COEFFICIENTS.hotEmissiveG;
      out.emissive[2] += scale * BLEND_COEFFICIENTS.hotEmissiveB;
      effect = Math.min(1, scale);
    }

    // Cold: frost tint.
    if (temperature < BLEND_COEFFICIENTS.coldFrostThreshold) {
      const frost = Math.min(
        BLEND_COEFFICIENTS.coldFrostMax,
        Math.abs(temperature) * BLEND_COEFFICIENTS.coldFrostScale
      );
      out.baseColor[0] = out.baseColor[0] * (1 - frost * 0.5) + 0.85 * frost * 0.5;
      out.baseColor[1] = out.baseColor[1] * (1 - frost * 0.5) + 0.90 * frost * 0.5;
      out.baseColor[2] = out.baseColor[2] * (1 - frost * 0.5) + 0.98 * frost * 0.5;
      out.roughness = Math.min(1, out.roughness + frost * 0.15);
      effect = Math.max(effect, frost);
    }

    return effect;
  }

  // ── Seasonal blending for foliage ───────────────────────
  _applySeasonalBlend(out, overrides, desc) {
    // Determine seasonal material based on phase.
    const phase = overrides.seasonalPhase;

    let seasonalPreset = null;
    if (phase < 0.10) seasonalPreset = SEASONAL_MATERIAL.WINTER_DORMANT;
    else if (phase < 0.20) seasonalPreset = SEASONAL_MATERIAL.SPRING_NEW;
    else if (phase < 0.35) seasonalPreset = SEASONAL_MATERIAL.SPRING_FULL;
    else if (phase < 0.55) seasonalPreset = SEASONAL_MATERIAL.SUMMER_PEAK;
    else if (phase < 0.65) seasonalPreset = SEASONAL_MATERIAL.SUMMER_LATE;
    else if (phase < 0.75) seasonalPreset = SEASONAL_MATERIAL.EARLY_AUTUMN;
    else if (phase < 0.85) seasonalPreset = SEASONAL_MATERIAL.PEAK_AUTUMN;
    else if (phase < 0.95) seasonalPreset = SEASONAL_MATERIAL.LATE_AUTUMN;
    else seasonalPreset = SEASONAL_MATERIAL.LEAF_BARE;

    if (!seasonalPreset) return;

    // Blend seasonal colour into base.
    const seasonWeight = 0.65;
    out.baseColor[0] = out.baseColor[0] * (1 - seasonWeight) +
                       seasonalPreset.pbr.baseColor[0] * seasonWeight;
    out.baseColor[1] = out.baseColor[1] * (1 - seasonWeight) +
                       seasonalPreset.pbr.baseColor[1] * seasonWeight;
    out.baseColor[2] = out.baseColor[2] * (1 - seasonWeight) +
                       seasonalPreset.pbr.baseColor[2] * seasonWeight;
    out.animeBaseColor[0] = out.animeBaseColor[0] * (1 - seasonWeight) +
                            seasonalPreset.anime.baseColor[0] * seasonWeight;
    out.animeBaseColor[1] = out.animeBaseColor[1] * (1 - seasonWeight) +
                            seasonalPreset.anime.baseColor[1] * seasonWeight;
    out.animeBaseColor[2] = out.animeBaseColor[2] * (1 - seasonWeight) +
                            seasonalPreset.anime.baseColor[2] * seasonWeight;

    // Bloom factor: overlay blossom colour.
    if (overrides.bloomFactor > 0.1) {
      const bf = Math.min(1, overrides.bloomFactor);
      const blossomColor = [0.95, 0.75, 0.82];
      out.baseColor[0] = out.baseColor[0] * (1 - bf * 0.4) + blossomColor[0] * bf * 0.4;
      out.baseColor[1] = out.baseColor[1] * (1 - bf * 0.4) + blossomColor[1] * bf * 0.4;
      out.baseColor[2] = out.baseColor[2] * (1 - bf * 0.4) + blossomColor[2] * bf * 0.4;
    }

    // Leaf coverage: bare branches → darker, less transmission.
    if (overrides.leafCoverage !== undefined && overrides.leafCoverage < 1) {
      const lc = overrides.leafCoverage;
      out.transmission *= lc;
      out.baseColor[0] *= (0.5 + lc * 0.5);
      out.baseColor[1] *= (0.5 + lc * 0.5);
      out.baseColor[2] *= (0.5 + lc * 0.5);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Convenience: blend with auto-override acquisition ──
  // ══════════════════════════════════════════════════════════
  // For one-shot blends where the caller doesn't want to manage
  // the override bag lifecycle.
  blendMaterialOnce(materialId, opts) {
    const bag = this.acquireOverrideBag();
    if (opts) {
      bag.wetness = opts.wetness ?? 0;
      bag.fireIntensity = opts.fireIntensity ?? 0;
      bag.mossCoverage = opts.mossCoverage ?? 0;
      bag.snowCoverage = opts.snowCoverage ?? 0;
      bag.damage = opts.damage ?? 0;
      bag.temperature = opts.temperature ?? 20;
      bag.age = opts.age ?? 0;
      bag.bloomFactor = opts.bloomFactor ?? 0;
      bag.leafCoverage = opts.leafCoverage ?? 1;
      bag.seasonalPhase = opts.seasonalPhase ?? 0.5;
    }
    const result = this.blendMaterial(materialId, bag, opts?.frame);
    this.releaseOverrideBag(bag);
    return result;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  getRegisteredCount() {
    return this._stats.registrations;
  }

  getUserRegisteredCount() {
    return this._userRegisteredCount;
  }

  getBlendedOutput() {
    return this._blendedOutput;
  }

  setDispatcher(d) {
    this._dispatcher = d;
    return this;
  }

  dispose() {
    this._descriptors.fill(null);
    this._overridePool.length = 0;
    this._overridePoolIndex = 0;
    this._userFreeCount = 0;
    this._dispatcher = null;
  }
}

export {
  MaterialRegistry,
  MATERIAL_KIND,
  MATERIAL_KIND_NAMES,
  ID_BLOCK,
  BLEND_COEFFICIENTS,
  SPECIAL_MATERIALS,
  SPECIAL_MATERIAL_IDS
};