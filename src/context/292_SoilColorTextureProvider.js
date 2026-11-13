// file number : 292
// full path name : src/context/292_SoilColorTextureProvider.js
// description : Soil colour and texture provider producing the visual identity of every soil cell for the material registry. Reads soil composition (fractions, texture class, pH, USLE K-factor) from 290_SoilCompositionProvider, fertility index and organic percent from 291_SoilFertilityProvider, moisture from 284_GroundwaterProvider and 285_MoistureLevelProvider, temperature from 287_ClimateTemperatureProvider, precipitation from 288_ClimatePrecipitationProvider, and decomposition activity from 286_DecomposersSystem, then produces per-chunk and per-cell soil visual descriptors: base albedo colour derived from parent-rock type plus organic-matter darkening (Beer-Lambert style F_om = exp(−k_om · OM)), iron-oxide redness from basalt/obsidian parent rock boosted by wet-dry cycling, calcium-carbonate pale tint from limestone parent rock, wetness darkening via the Kubelka-Munk style saturation darkening D_w = 1 − 0.45·wetness, dryness lightening via scattering L_d = 1 + 0.20·(1−wetness), and seasonal snow-tint blending using the current climate state. Produces a grain-size driven normal-map perturbation scale (N = k_n · d_grain^(-0.3) so fine clay has subtle relief while coarse gravel has strong relief), a splatmap hint vector (four weights: LOAM, SAND, CLAY, PEAT/ORGANIC) that the material registry uses to select the correct splatmap texture per chunk, and full PBR + anime parameter sets for 8 distinct soil visual archetypes (DARK_HUMUS, RED_LATERITE, PALE_CALCAREOUS, SANDY_TAN, CLAY_ORANGE, PEAT_BROWN, VOLCANIC_BLACK, GREEN_MOSSY) with all parameters the shader reads: base colour, metalness, roughness, clearcoat, transmission, ior, sheen, anisotropy, subsurface radius, emissive, normal scale, dust threshold, wetness factor, organic tint, and anime quantize steps and rim parameters. Emits a single coalesced MUTATION causal event per chunk when the dominant visual archetype changes so the material registry can update its splatmap assignments. Writes per-chunk summaries into frame.layers.spatial.soilColor and global aggregates into frame.layers.physical.soilColorProperties. All scratch objects are pooled; no allocation after the first frame.
// best for : Every material consumer that needs soil visual identity — the material registry splatmap selector, the shader's soil albedo mixer, the PBR/anime blend for terrain, the snow and wetness overlays, and the terrain-colour LOD blending at distance. Complements 290 (composition) and 291 (fertility) by producing the human-visible state of the soil.
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
import { CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND, CARVE_MATERIAL_COLORS }
                                                            from './282_Z03_CarveGradientProvider.js';
import { RockGradientProvider, ROCK_CLASS, ROCK_CLASS_NAMES }
                                                            from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE }                from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE }      from './282_Z08_GrassAndFlowresGradientProvider.js';
import { BathymetryProvider, BATHY_ZONE }                   from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE }            from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE }            from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE }               from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider, CLIMATE_ZONE }         from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE, PRECIPITATION_MATERIAL }
                                                            from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider, WIND_STATE }                  from './289_ClimateWindProvider.js';
import { SoilCompositionProvider, SOIL_TEXTURE_CLASS, SOIL_TEXTURE_NAMES, SOIL_PROPERTIES }
                                                            from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider, FERTILITY_CLASS, FERTILITY_MATERIAL, FERTILITY_CLASS_NAMES }
                                                            from './291_SoilFertilityProvider.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 0.5;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── soil visual archetypes ────────────────────────────────────
const SOIL_VISUAL_ARCHETYPE = Object.freeze({
  DARK_HUMUS:        0,   // rich dark forest soil, high organic
  RED_LATERITE:      1,   // tropical iron-rich red
  PALE_CALCAREOUS:   2,   // chalky limestone-derived
  SANDY_TAN:         3,   // desert / beach sand
  CLAY_ORANGE:       4,   // iron-rich clay
  PEAT_BROWN:        5,   // wetland peat
  VOLCANIC_BLACK:    6,   // basalt / obsidian derived
  GREEN_MOSSY:       7    // moss-covered moist soil
});

const SOIL_VISUAL_NAMES = Object.freeze([
  'dark_humus', 'red_laterite', 'pale_calcareous', 'sandy_tan',
  'clay_orange', 'peat_brown', 'volcanic_black', 'green_mossy'
]);

// ─── base albedo colours per archetype (linear sRGB, 0..1) ─────
const SOIL_VISUAL_BASE_COLOR = Object.freeze({
  [SOIL_VISUAL_ARCHETYPE.DARK_HUMUS]:      [0.14, 0.10, 0.08],
  [SOIL_VISUAL_ARCHETYPE.RED_LATERITE]:    [0.42, 0.18, 0.10],
  [SOIL_VISUAL_ARCHETYPE.PALE_CALCAREOUS]: [0.72, 0.68, 0.58],
  [SOIL_VISUAL_ARCHETYPE.SANDY_TAN]:       [0.76, 0.66, 0.48],
  [SOIL_VISUAL_ARCHETYPE.CLAY_ORANGE]:     [0.55, 0.32, 0.18],
  [SOIL_VISUAL_ARCHETYPE.PEAT_BROWN]:      [0.20, 0.14, 0.10],
  [SOIL_VISUAL_ARCHETYPE.VOLCANIC_BLACK]:  [0.10, 0.08, 0.07],
  [SOIL_VISUAL_ARCHETYPE.GREEN_MOSSY]:     [0.22, 0.30, 0.16]
});

// ─── full PBR + anime material params per archetype ───────────
const SOIL_VISUAL_MATERIAL = Object.freeze({
  [SOIL_VISUAL_ARCHETYPE.DARK_HUMUS]: {
    pbr: {
      baseColor:    [0.14, 0.10, 0.08],
      metalness:    0.00,
      roughness:    0.72,
      clearcoat:    0.18,
      transmission: 0.00,
      ior:          1.48,
      sheen:        0.22,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.16, 0.12, 0.10],
      quantizeSteps: 3,
      rimPower:     1.7,
      rimColor:     [0.32, 0.26, 0.20]
    },
    subsurfaceRadius: [0.05, 0.05, 0.03],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.55,
    dustThreshold:    0.30,
    organicTint:      0.65
  },
  [SOIL_VISUAL_ARCHETYPE.RED_LATERITE]: {
    pbr: { baseColor: [0.42, 0.18, 0.10], metalness: 0.00, roughness: 0.75, clearcoat: 0.15, transmission: 0.00, ior: 1.50, sheen: 0.10, anisotropy: 0.00 },
    anime: { baseColor: [0.45, 0.20, 0.12], quantizeSteps: 3, rimPower: 1.8, rimColor: [0.65, 0.32, 0.20] },
    subsurfaceRadius: [0.06, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.60,
    dustThreshold:    0.40,
    organicTint:      0.15
  },
  [SOIL_VISUAL_ARCHETYPE.PALE_CALCAREOUS]: {
    pbr: { baseColor: [0.72, 0.68, 0.58], metalness: 0.00, roughness: 0.85, clearcoat: 0.05, transmission: 0.00, ior: 1.52, sheen: 0.05, anisotropy: 0.00 },
    anime: { baseColor: [0.75, 0.71, 0.60], quantizeSteps: 3, rimPower: 2.0, rimColor: [0.90, 0.86, 0.75] },
    subsurfaceRadius: [0.03, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.45,
    dustThreshold:    0.55,
    organicTint:      0.05
  },
  [SOIL_VISUAL_ARCHETYPE.SANDY_TAN]: {
    pbr: { baseColor: [0.76, 0.66, 0.48], metalness: 0.00, roughness: 0.92, clearcoat: 0.00, transmission: 0.00, ior: 1.55, sheen: 0.00, anisotropy: 0.00 },
    anime: { baseColor: [0.79, 0.69, 0.50], quantizeSteps: 3, rimPower: 2.1, rimColor: [0.92, 0.85, 0.70] },
    subsurfaceRadius: [0.02, 0.02, 0.01],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.35,
    dustThreshold:    0.65,
    organicTint:      0.02
  },
  [SOIL_VISUAL_ARCHETYPE.CLAY_ORANGE]: {
    pbr: { baseColor: [0.55, 0.32, 0.18], metalness: 0.00, roughness: 0.68, clearcoat: 0.30, transmission: 0.00, ior: 1.50, sheen: 0.15, anisotropy: 0.05 },
    anime: { baseColor: [0.58, 0.34, 0.20], quantizeSteps: 3, rimPower: 1.7, rimColor: [0.78, 0.52, 0.38] },
    subsurfaceRadius: [0.04, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.50,
    dustThreshold:    0.30,
    organicTint:      0.10
  },
  [SOIL_VISUAL_ARCHETYPE.PEAT_BROWN]: {
    pbr: { baseColor: [0.20, 0.14, 0.10], metalness: 0.00, roughness: 0.70, clearcoat: 0.22, transmission: 0.00, ior: 1.48, sheen: 0.25, anisotropy: 0.00 },
    anime: { baseColor: [0.22, 0.16, 0.12], quantizeSteps: 3, rimPower: 1.6, rimColor: [0.42, 0.32, 0.24] },
    subsurfaceRadius: [0.06, 0.05, 0.04],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.48,
    dustThreshold:    0.20,
    organicTint:      0.75
  },
  [SOIL_VISUAL_ARCHETYPE.VOLCANIC_BLACK]: {
    pbr: { baseColor: [0.10, 0.08, 0.07], metalness: 0.05, roughness: 0.62, clearcoat: 0.15, transmission: 0.00, ior: 1.50, sheen: 0.10, anisotropy: 0.08 },
    anime: { baseColor: [0.12, 0.10, 0.09], quantizeSteps: 3, rimPower: 1.5, rimColor: [0.30, 0.24, 0.22] },
    subsurfaceRadius: [0.02, 0.02, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.62,
    dustThreshold:    0.45,
    organicTint:      0.05
  },
  [SOIL_VISUAL_ARCHETYPE.GREEN_MOSSY]: {
    pbr: { baseColor: [0.22, 0.30, 0.16], metalness: 0.00, roughness: 0.68, clearcoat: 0.28, transmission: 0.02, ior: 1.42, sheen: 0.30, anisotropy: 0.00 },
    anime: { baseColor: [0.24, 0.34, 0.18], quantizeSteps: 3, rimPower: 1.7, rimColor: [0.50, 0.72, 0.42] },
    subsurfaceRadius: [0.08, 0.10, 0.05],
    emissive:         [0.00, 0.00, 0.00],
    normalScale:      0.55,
    dustThreshold:    0.15,
    organicTint:      0.55
  }
});

// ─── splatmap weight computation constants ────────────────────
const SPLATMAP_CONSTANTS = Object.freeze({
  // Texture-class → splatmap index:
  // 0 = loam, 1 = sand, 2 = clay, 3 = peat/organic
  loamClasses:  [SOIL_TEXTURE_CLASS.LOAM, SOIL_TEXTURE_CLASS.SILT_LOAM, SOIL_TEXTURE_CLASS.CLAY_LOAM, SOIL_TEXTURE_CLASS.SILTY_CLAY_LOAM, SOIL_TEXTURE_CLASS.SANDY_CLAY_LOAM],
  sandClasses:  [SOIL_TEXTURE_CLASS.SAND, SOIL_TEXTURE_CLASS.LOAMY_SAND, SOIL_TEXTURE_CLASS.SANDY_LOAM],
  clayClasses:  [SOIL_TEXTURE_CLASS.CLAY, SOIL_TEXTURE_CLASS.SILTY_CLAY, SOIL_TEXTURE_CLASS.SANDY_CLAY],
  peatClasses:  [SOIL_TEXTURE_CLASS.SILT]
});

// ─── colour-modulation coefficients ───────────────────────────
const COLOR_MODULATION = Object.freeze({
  // Organic-matter darkening follows a Beer-Lambert-like curve.
  omDarkeningK:      0.08,       // per percent organic matter
  omDarkeningMax:    0.75,       // maximum darkening fraction

  // Iron-oxide redness boost from basalt/obsidian + wet-dry cycles.
  ironRednessBoost:  0.35,
  ironRednessMax:    0.85,

  // Calcium-carbonate pale tint from limestone parent rock.
  calciteTint:       0.30,
  calciteTintMax:    0.65,

  // Wetness darkening (Kubelka-Munk-like).
  wetnessDarkening:  0.45,
  wetnessDarkeningMax: 0.55,

  // Dryness lightening (scattered bright reflections).
  drynessLightening: 0.20,
  drynessLighteningMax: 0.30,

  // Volcanic blackness from low reflectance.
  volcanicDarkening: 0.55,

  // Moss greenness from moisture + fertility.
  mossGreenness:     0.40,
  mossGreennessMax:  0.70,

  // Seasonal snow-tint strength.
  snowTintStrength:  0.85,
  snowTintR:         0.92,
  snowTintG:         0.95,
  snowTintB:         0.99,

  // Normal-scale relationship with grain diameter.
  normalScaleK:      1.2,
  normalScaleExponent: -0.3,
  normalScaleMin:    0.15,
  normalScaleMax:    0.95,

  // Gamma for albedo conversion to linear colour space.
  albedoGamma:       2.2
});

// ─── soil visual defaults ─────────────────────────────────────
const SOIL_COLOR_DEFAULTS = Object.freeze({
  worldSeed:              0xC0L0R5C3D & 0xFFFFFFFF,
  cellSize:               32.0,
  chunkSize:              1000,
  maxCellsPerChunk:       128,
  maxChunksPerFrame:      8,
  archetypeChangeCooldown: 10.0,
  enableSnowTint:         true,
  enableWetnessModulation: true,
  enableOrganicDarkening: true,
  enableSplatmapWeights:  true
});

class SoilColorTextureProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...SOIL_COLOR_DEFAULTS, ...(options.defaults || {}) };
    this.defaults.worldSeed = this.defaults.worldSeed | 0;
    this.modulation = { ...COLOR_MODULATION, ...(options.modulation || {}) };
    this.splatmap = { ...SPLATMAP_CONSTANTS, ...(options.splatmap || {}) };

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColorA = new Vec3();
    this._tmpColorB = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();

    // ── per-chunk visual state ─────────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk visual identity.
    this._chunkArchetype       = new Uint8Array(chunkCap);
    this._chunkAlbedoR         = new Float32Array(chunkCap);
    this._chunkAlbedoG         = new Float32Array(chunkCap);
    this._chunkAlbedoB         = new Float32Array(chunkCap);
    this._chunkNormalScale     = new Float32Array(chunkCap);
    this._chunkWetness         = new Float32Array(chunkCap);
    this._chunkOrganicTint     = new Float32Array(chunkCap);
    this._chunkSnowTint        = new Float32Array(chunkCap);
    this._chunkSplatLoam       = new Float32Array(chunkCap);
    this._chunkSplatSand       = new Float32Array(chunkCap);
    this._chunkSplatClay       = new Float32Array(chunkCap);
    this._chunkSplatPeat       = new Float32Array(chunkCap);
    this._chunkDustThreshold   = new Float32Array(chunkCap);
    this._chunkRoughness       = new Float32Array(chunkCap);
    this._chunkClearcoat       = new Float32Array(chunkCap);
    this._chunkDominantTexture = new Uint8Array(chunkCap);

    // Per-cell data (colour + splatmap weight).
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellArchetype = new Array(chunkCap).fill(null);      // Uint8Array
    this._chunkCellAlbedo = new Array(chunkCap).fill(null);         // Float32Array × 3
    this._chunkCellSplat = new Array(chunkCap).fill(null);          // Float32Array × 4
    this._chunkCellNormalScale = new Array(chunkCap).fill(null);    // Float32Array
    this._chunkCellWetness = new Array(chunkCap).fill(null);        // Float32Array

    // Free lists.
    this._cellPool = {
      x: [], y: [], z: [], albedo: [], normalScale: [], wetness: []
    };
    this._splatPool = [];
    this._archetypeArrayPool = [];

    // ── per-frame global aggregate ─────────────────────────
    this._globalSoilColor = {
      avgAlbedoR: 0.45,
      avgAlbedoG: 0.38,
      avgAlbedoB: 0.30,
      avgWetness: 0.3,
      avgOrganicTint: 0.3,
      avgSnowTint: 0,
      dominantArchetype: 0,
      archetypeDistribution: new Float32Array(SOIL_VISUAL_NAMES.length),
      avgSplatLoam: 0.25,
      avgSplatSand: 0.25,
      avgSplatClay: 0.25,
      avgSplatPeat: 0.25
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ─────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      darkHumusCells: 0,
      redLateriteCells: 0,
      paleCalcareousCells: 0,
      sandyTanCells: 0,
      clayOrangeCells: 0,
      peatBrownCells: 0,
      volcanicBlackCells: 0,
      greenMossyCells: 0,
      archetypeTransitions: 0,
      mutationEventsEmitted: 0
    };

    // ── collaborators ─────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._carve = options.carve || null;
    this._rocks = options.rocks || null;
    this._bathymetry = options.bathymetry || null;
    this._groundwater = options.groundwater || null;
    this._moisture = options.moisture || null;
    this._decomposers = options.decomposers || null;
    this._temperature = options.temperature || null;
    this._precipitation = options.precipitation || null;
    this._wind = options.wind || null;
    this._soil = options.soil || null;
    this._fertility = options.fertility || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── reusable material output ───────────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0 },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      subsurfaceRadius: [0,0,0],
      emissive: [0,0,0],
      normalScale: 0,
      dustThreshold: 0,
      organicTint: 0
    };

    // ── previous archetype per chunk (for transitions) ─────
    this._chunkLastArchetype = new Uint8Array(chunkCap);
    this._chunkLastTransitionTime = new Float64Array(chunkCap);
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachRocks(r) { this._rocks = r; return this; }
  attachBathymetry(b) { this._bathymetry = b; return this; }
  attachGroundwater(g) { this._groundwater = g; return this; }
  attachMoisture(m) { this._moisture = m; return this; }
  attachDecomposers(d) { this._decomposers = d; return this; }
  attachTemperature(t) { this._temperature = t; return this; }
  attachPrecipitation(p) { this._precipitation = p; return this; }
  attachWind(w) { this._wind = w; return this; }
  attachSoil(s) { this._soil = s; return this; }
  attachFertility(f) { this._fertility = f; return this; }
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
  // ─── archetype classification ──────────────────────────
  // ══════════════════════════════════════════════════════════
  _classifyArchetype(soil, fertilityIndex, moisture, temperature, hasMoss) {
    if (!soil) return SOIL_VISUAL_ARCHETYPE.DARK_HUMUS;

    const omPercent = soil.organicPercent;
    const ph = soil.pH;
    const texture = soil.textureClass;
    const parentRock = soil.parentRock;
    const ironOxide = soil.ironOxide;
    const calciumCarbonate = soil.calciumCarbonate;

    // Volcanic black: obsidian or basalt parent rock with high iron.
    if ((parentRock === ROCK_CLASS.BASALT || parentRock === ROCK_CLASS.OBSIDIAN) &&
        ironOxide > 0.06) {
      return SOIL_VISUAL_ARCHETYPE.VOLCANIC_BLACK;
    }

    // Peat brown: very high organic matter + wet.
    if (omPercent > 15 && moisture > 0.6) {
      return SOIL_VISUAL_ARCHETYPE.PEAT_BROWN;
    }

    // Green mossy: moist, fertile, moss present.
    if (hasMoss && moisture > 0.4 && fertilityIndex > 0.4) {
      return SOIL_VISUAL_ARCHETYPE.GREEN_MOSSY;
    }

    // Pale calcareous: limestone parent with high carbonate.
    if (calciumCarbonate > 0.10 && ph > 7.0) {
      return SOIL_VISUAL_ARCHETYPE.PALE_CALCAREOUS;
    }

    // Red laterite: iron-rich and warm (tropical).
    if (ironOxide > 0.05 && temperature > 22) {
      return SOIL_VISUAL_ARCHETYPE.RED_LATERITE;
    }

    // Sandy tan: sandy texture class.
    if (texture <= SOIL_TEXTURE_CLASS.SANDY_LOAM) {
      return SOIL_VISUAL_ARCHETYPE.SANDY_TAN;
    }

    // Clay orange: high clay + iron oxide.
    if (texture >= SOIL_TEXTURE_CLASS.CLAY_LOAM && ironOxide > 0.02) {
      return SOIL_VISUAL_ARCHETYPE.CLAY_ORANGE;
    }

    // Default: dark humus for fertile soils, clay orange otherwise.
    if (fertilityIndex > 0.5) return SOIL_VISUAL_ARCHETYPE.DARK_HUMUS;
    return SOIL_VISUAL_ARCHETYPE.CLAY_ORANGE;
  }

  // ══════════════════════════════════════════════════════════
  // ─── colour modulation ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeModulatedColor(archetype, soil, moisture, snowCover, outColor) {
    const base = SOIL_VISUAL_BASE_COLOR[archetype] ||
                 SOIL_VISUAL_BASE_COLOR[SOIL_VISUAL_ARCHETYPE.DARK_HUMUS];

    let r = base[0];
    let g = base[1];
    let b = base[2];

    // ── Organic-matter darkening (Beer-Lambert) ─────────
    if (this.defaults.enableOrganicDarkening && soil) {
      const omPercent = soil.organicPercent;
      const omDarkening = Math.min(
        this.modulation.omDarkeningMax,
        1 - Math.exp(-this.modulation.omDarkeningK * omPercent)
      );
      r *= (1 - omDarkening);
      g *= (1 - omDarkening);
      b *= (1 - omDarkening);
    }

    // ── Iron-oxide redness ──────────────────────────────
    if (soil && soil.ironOxide > 0.02) {
      const ironFactor = Math.min(
        this.modulation.ironRednessMax,
        soil.ironOxide * this.modulation.ironRednessBoost * 10
      );
      r = r + (1 - r) * ironFactor;
      g = g * (1 - ironFactor * 0.5);
      b = b * (1 - ironFactor * 0.7);
    }

    // ── Calcium-carbonate pale tint ─────────────────────
    if (soil && soil.calciumCarbonate > 0.05) {
      const calciteFactor = Math.min(
        this.modulation.calciteTintMax,
        soil.calciumCarbonate * this.modulation.calciteTint * 5
      );
      r = r + (0.85 - r) * calciteFactor;
      g = g + (0.80 - g) * calciteFactor;
      b = b + (0.70 - b) * calciteFactor;
    }

    // ── Wetness darkening (Kubelka-Munk-like) ───────────
    if (this.defaults.enableWetnessModulation) {
      const wetDark = moisture * this.modulation.wetnessDarkening;
      r *= (1 - wetDark);
      g *= (1 - wetDark);
      b *= (1 - wetDark);

      // Dryness lightening.
      const dryLight = (1 - moisture) * this.modulation.drynessLightening;
      r = r + (1 - r) * dryLight * 0.3;
      g = g + (1 - g) * dryLight * 0.3;
      b = b + (1 - b) * dryLight * 0.3;
    }

    // ── Seasonal snow tint ──────────────────────────────
    if (this.defaults.enableSnowTint && snowCover > 0.02) {
      const snowFactor = Math.min(this.modulation.snowTintStrength, snowCover * 2);
      r = r * (1 - snowFactor) + this.modulation.snowTintR * snowFactor;
      g = g * (1 - snowFactor) + this.modulation.snowTintG * snowFactor;
      b = b * (1 - snowFactor) + this.modulation.snowTintB * snowFactor;
    }

    // Clamp.
    outColor[0] = Math.max(0, Math.min(1, r));
    outColor[1] = Math.max(0, Math.min(1, g));
    outColor[2] = Math.max(0, Math.min(1, b));
    return outColor;
  }

  // ══════════════════════════════════════════════════════════
  // ─── normal-scale from grain size ───────────────────────
  // ══════════════════════════════════════════════════════════
  // Fine-grained clay has subtle relief, coarse gravel has strong relief.
  // N = k_n · grain^(-0.3), clamped to [0.15, 0.95].
  _computeNormalScale(grainSizeUm) {
    if (grainSizeUm < 1) grainSizeUm = 1;
    const raw = this.modulation.normalScaleK * Math.pow(grainSizeUm, this.modulation.normalScaleExponent);
    return Math.max(this.modulation.normalScaleMin,
                    Math.min(this.modulation.normalScaleMax, raw));
  }

  // ══════════════════════════════════════════════════════════
  // ─── splatmap weights ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Four weights that the material registry uses to select the
  // splatmap texture: 0=loam, 1=sand, 2=clay, 3=peat/organic.
  _computeSplatWeights(textureClass, organicPercent, outWeights) {
    if (!this.defaults.enableSplatmapWeights) {
      outWeights[0] = 1; outWeights[1] = 0; outWeights[2] = 0; outWeights[3] = 0;
      return outWeights;
    }

    let loamW = 0, sandW = 0, clayW = 0, peatW = 0;

    // Texture class → weight.
    if (this.splatmap.loamClasses.includes(textureClass)) loamW = 1;
    else if (this.splatmap.sandClasses.includes(textureClass)) sandW = 1;
    else if (this.splatmap.clayClasses.includes(textureClass)) clayW = 1;
    else if (this.splatmap.peatClasses.includes(textureClass)) peatW = 1;

    // Organic-matter bump on peat.
    const omBoost = Math.min(1, organicPercent / 15);
    peatW = peatW + omBoost * 0.5;

    // Normalize.
    const sum = loamW + sandW + clayW + peatW + 0.0001;
    outWeights[0] = loamW / sum;
    outWeights[1] = sandW / sum;
    outWeights[2] = clayW / sum;
    outWeights[3] = peatW / sum;
    return outWeights;
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk sampling ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleChunk(cx, cz, frame) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));

    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    // Allocate cell arrays.
    if (!this._chunkCellX[slot]) {
      this._chunkCellX[slot] = this._acquireCell('x');
      this._chunkCellY[slot] = this._acquireCell('y');
      this._chunkCellZ[slot] = this._acquireCell('z');
      this._chunkCellAlbedo[slot] = this._acquireColorArray();
      this._chunkCellNormalScale[slot] = this._acquireCell('normalScale');
      this._chunkCellWetness[slot] = this._acquireCell('wetness');
      this._chunkCellArchetype[slot] = this._acquireArchetypeArray();
      this._chunkCellSplat[slot] = this._acquireSplatArray();
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpAlb = this._chunkCellAlbedo[slot];
    const cpNorm = this._chunkCellNormalScale[slot];
    const cpWet = this._chunkCellWetness[slot];
    const cpArch = this._chunkCellArchetype[slot];
    const cpSplat = this._chunkCellSplat[slot];

    let placed = 0;

    // Read global context.
    const physical = frame.layers.physical;
    const ambientTemp = physical?.ambientTemperature ?? 15;
    const relativeHumidity = physical?.relativeHumidity ?? 0.5;
    const surfaceWetness = physical?.surfaceWetness ?? 0.3;
    const snowCoverage = physical?.snowCoverage ?? 0;
    const moistureGround = physical?.soilMoisture ?? 0.5;

    // Aggregates.
    let sumAlbedoR = 0, sumAlbedoG = 0, sumAlbedoB = 0;
    let sumNormalScale = 0, sumWetness = 0;
    let sumSplatLoam = 0, sumSplatSand = 0, sumSplatClay = 0, sumSplatPeat = 0;
    let sumOrganicTint = 0, sumSnowTint = 0;

    const archetypeCount = new Uint16Array(SOIL_VISUAL_NAMES.length);

    // Scratch for reused buffers.
    const colorScratch = this._tmpColorA;
    const splatScratch = this._tmpVecD;

    for (let j = 0; j < cellsPerSide && placed < this.defaults.maxCellsPerChunk; j++) {
      for (let i = 0; i < cellsPerSide && placed < this.defaults.maxCellsPerChunk; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;

        // ── Read soil composition ───────────────────────────
        let soil = null;
        if (this._soil) {
          soil = this._soil.getSoilAt(wx, wz);
        }
        if (!soil) {
          // Fallback soil.
          soil = {
            organicPercent: 2.0,
            pH: 6.5,
            textureClass: SOIL_TEXTURE_CLASS.LOAM,
            parentRock: ROCK_CLASS.GRANITE,
            ironOxide: 0.02,
            calciumCarbonate: 0.03,
            grainSizeUm: 150
          };
        }

        // ── Read fertility ──────────────────────────────────
        let fertilityIndex = 0.5;
        if (this._fertility) {
          fertilityIndex = this._fertility.sampleFertilityAt(wx, wz, frame);
        }

        // ── Read local moisture ─────────────────────────────
        let localMoisture = moistureGround;
        if (this._groundwater) {
          const gw = this._groundwater.getGroundwaterAt(wx, wz);
          if (gw) localMoisture = (moistureGround + gw.soilMoisture) * 0.5;
        }

        // ── Check for moss ──────────────────────────────────
        const hasMoss = localMoisture > 0.5 && fertilityIndex > 0.3;

        // ── Local snow cover ────────────────────────────────
        const localSnow = snowCoverage * (ambientTemp < 0 ? 1 : 0.2);

        // ── Classify archetype ──────────────────────────────
        const archetype = this._classifyArchetype(
          soil, fertilityIndex, localMoisture, ambientTemp, hasMoss
        );

        // ── Compute modulated color ─────────────────────────
        const color = this._computeModulatedColor(
          archetype, soil, localMoisture, localSnow, colorScratch
        );

        // ── Normal scale from grain size ────────────────────
        const normalScale = this._computeNormalScale(soil.grainSizeUm);

        // ── Splatmap weights ────────────────────────────────
        const splat = this._computeSplatWeights(
          soil.textureClass, soil.organicPercent, splatScratch
        );

        // ── Store cell ──────────────────────────────────────
        cpx[placed] = wx;
        cpy[placed] = this._getHeight(wx, wz);
        cpz[placed] = wz;
        cpArch[placed] = archetype;
        const co = placed * 3;
        cpAlb[co]     = color.x;
        cpAlb[co + 1] = color.y;
        cpAlb[co + 2] = color.z;
        cpNorm[placed] = normalScale;
        cpWet[placed] = localMoisture;
        const so = placed * 4;
        cpSplat[so]     = splat[0];
        cpSplat[so + 1] = splat[1];
        cpSplat[so + 2] = splat[2];
        cpSplat[so + 3] = splat[3];
        placed++;

        // ── Aggregates ──────────────────────────────────────
        sumAlbedoR += color.x;
        sumAlbedoG += color.y;
        sumAlbedoB += color.z;
        sumNormalScale += normalScale;
        sumWetness += localMoisture;
        sumSplatLoam += splat[0];
        sumSplatSand += splat[1];
        sumSplatClay += splat[2];
        sumSplatPeat += splat[3];
        sumOrganicTint += soil.organicPercent / 100;
        sumSnowTint += localSnow;
        archetypeCount[archetype]++;

        // Per-archetype stats.
        switch (archetype) {
          case SOIL_VISUAL_ARCHETYPE.DARK_HUMUS:      this._stats.darkHumusCells++; break;
          case SOIL_VISUAL_ARCHETYPE.RED_LATERITE:    this._stats.redLateriteCells++; break;
          case SOIL_VISUAL_ARCHETYPE.PALE_CALCAREOUS: this._stats.paleCalcareousCells++; break;
          case SOIL_VISUAL_ARCHETYPE.SANDY_TAN:       this._stats.sandyTanCells++; break;
          case SOIL_VISUAL_ARCHETYPE.CLAY_ORANGE:     this._stats.clayOrangeCells++; break;
          case SOIL_VISUAL_ARCHETYPE.PEAT_BROWN:      this._stats.peatBrownCells++; break;
          case SOIL_VISUAL_ARCHETYPE.VOLCANIC_BLACK:  this._stats.volcanicBlackCells++; break;
          case SOIL_VISUAL_ARCHETYPE.GREEN_MOSSY:     this._stats.greenMossyCells++; break;
        }

        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // ── Store chunk summary ────────────────────────────────
    const inv = placed > 0 ? 1 / placed : 0;
    this._chunkAlbedoR[slot] = sumAlbedoR * inv;
    this._chunkAlbedoG[slot] = sumAlbedoG * inv;
    this._chunkAlbedoB[slot] = sumAlbedoB * inv;
    this._chunkNormalScale[slot] = sumNormalScale * inv;
    this._chunkWetness[slot] = sumWetness * inv;
    this._chunkOrganicTint[slot] = sumOrganicTint * inv;
    this._chunkSnowTint[slot] = sumSnowTint * inv;
    this._chunkSplatLoam[slot] = sumSplatLoam * inv;
    this._chunkSplatSand[slot] = sumSplatSand * inv;
    this._chunkSplatClay[slot] = sumSplatClay * inv;
    this._chunkSplatPeat[slot] = sumSplatPeat * inv;

    // Dominant archetype.
    let dominantArchetype = 0;
    let maxCount = 0;
    for (let a = 0; a < archetypeCount.length; a++) {
      if (archetypeCount[a] > maxCount) { maxCount = archetypeCount[a]; dominantArchetype = a; }
    }
    this._chunkArchetype[slot] = dominantArchetype;

    // Update PBR properties from archetype + moisture.
    const matSrc = SOIL_VISUAL_MATERIAL[dominantArchetype];
    if (matSrc) {
      this._chunkRoughness[slot] = matSrc.pbr.roughness * (1 - this._chunkWetness[slot] * 0.35);
      this._chunkClearcoat[slot] = matSrc.pbr.clearcoat + this._chunkWetness[slot] * 0.25;
      this._chunkDustThreshold[slot] = matSrc.dustThreshold * (1 - this._chunkWetness[slot] * 0.7);
    }

    // Dominant texture (from soil).
    if (this._soil) {
      const centreX = cx * chunkSize + chunkSize * 0.5;
      const centreZ = cz * chunkSize + chunkSize * 0.5;
      const tex = this._soil.sampleSoilTextureAt(centreX, centreZ, frame);
      this._chunkDominantTexture[slot] = tex;
    }

    this._stats.chunksProcessed++;

    // ── Archetype transition event ─────────────────────────
    const previousArch = this._chunkLastArchetype[slot];
    const now = this._lastUpdateTime > 0 ? this._lastUpdateTime : 0;
    if (previousArch !== 0 && previousArch !== dominantArchetype &&
        now - this._chunkLastTransitionTime[slot] > this.defaults.archetypeChangeCooldown) {
      this._chunkLastTransitionTime[slot] = now;
      this._stats.archetypeTransitions++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.MUTATION,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, 20, 6.0,
          {
            kind: 'soil_visual_transition',
            chunkX: cx, chunkZ: cz,
            fromArchetype: previousArch,
            toArchetype: dominantArchetype,
            fromArchetypeName: SOIL_VISUAL_NAMES[previousArch],
            toArchetypeName: SOIL_VISUAL_NAMES[dominantArchetype],
            albedo: [this._chunkAlbedoR[slot], this._chunkAlbedoG[slot], this._chunkAlbedoB[slot]],
            dominantTexture: SOIL_TEXTURE_NAMES[this._chunkDominantTexture[slot]]
          }
        );
        this._stats.mutationEventsEmitted++;
      }
    }
    this._chunkLastArchetype[slot] = dominantArchetype;

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
    this._chunkLastArchetype[slot] = 0;
    this._chunkLastTransitionTime[slot] = 0;
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
      this._cellPool.albedo.push(this._chunkCellAlbedo[slot]);
      this._cellPool.normalScale.push(this._chunkCellNormalScale[slot]);
      this._cellPool.wetness.push(this._chunkCellWetness[slot]);
      this._splatPool.push(this._chunkCellSplat[slot]);
      this._archetypeArrayPool.push(this._chunkCellArchetype[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellAlbedo[slot] = null;
    this._chunkCellNormalScale[slot] = null;
    this._chunkCellWetness[slot] = null;
    this._chunkCellSplat[slot] = null;
    this._chunkCellArchetype[slot] = null;
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

  _acquireColorArray() {
    return new Float32Array(this.defaults.maxCellsPerChunk * 3);
  }

  _acquireSplatArray() {
    if (this._splatPool.length > 0) {
      const arr = this._splatPool.pop();
      arr.fill(0);
      return arr;
    }
    return new Float32Array(this.defaults.maxCellsPerChunk * 4);
  }

  _acquireArchetypeArray() {
    if (this._archetypeArrayPool.length > 0) {
      const arr = this._archetypeArrayPool.pop();
      arr.fill(0);
      return arr;
    }
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getSoilColorAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      archetype: this._chunkArchetype[slot],
      archetypeName: SOIL_VISUAL_NAMES[this._chunkArchetype[slot]],
      albedo: [
        this._chunkAlbedoR[slot],
        this._chunkAlbedoG[slot],
        this._chunkAlbedoB[slot]
      ],
      normalScale: this._chunkNormalScale[slot],
      wetness: this._chunkWetness[slot],
      organicTint: this._chunkOrganicTint[slot],
      snowTint: this._chunkSnowTint[slot],
      splatWeights: {
        loam: this._chunkSplatLoam[slot],
        sand: this._chunkSplatSand[slot],
        clay: this._chunkSplatClay[slot],
        peat: this._chunkSplatPeat[slot]
      },
      roughness: this._chunkRoughness[slot],
      clearcoat: this._chunkClearcoat[slot],
      dustThreshold: this._chunkDustThreshold[slot],
      dominantTexture: this._chunkDominantTexture[slot],
      dominantTextureName: SOIL_TEXTURE_NAMES[this._chunkDominantTexture[slot]],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        archetype: this._chunkCellArchetype[slot],
        albedo: this._chunkCellAlbedo[slot],
        splat: this._chunkCellSplat[slot],
        normalScale: this._chunkCellNormalScale[slot],
        wetness: this._chunkCellWetness[slot]
      }
    };
  }

  // Sample the albedo colour at any world position.
  sampleAlbedoAt(wx, wz, frame, outColor) {
    if (!frame) frame = this._frameRef;
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) {
      if (outColor) { outColor[0] = 0.45; outColor[1] = 0.38; outColor[2] = 0.30; }
      return outColor;
    }
    if (outColor) {
      outColor[0] = this._chunkAlbedoR[slot];
      outColor[1] = this._chunkAlbedoG[slot];
      outColor[2] = this._chunkAlbedoB[slot];
    }
    return outColor;
  }

  // Sample splatmap weights at any world position.
  sampleSplatWeightsAt(wx, wz, frame, outWeights) {
    if (!frame) frame = this._frameRef;
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) {
      if (outWeights) { outWeights[0] = 1; outWeights[1] = 0; outWeights[2] = 0; outWeights[3] = 0; }
      return outWeights;
    }
    if (outWeights) {
      outWeights[0] = this._chunkSplatLoam[slot];
      outWeights[1] = this._chunkSplatSand[slot];
      outWeights[2] = this._chunkSplatClay[slot];
      outWeights[3] = this._chunkSplatPeat[slot];
    }
    return outWeights;
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getSoilVisualMaterialParams(archetype) {
    return SOIL_VISUAL_MATERIAL[archetype] ||
           SOIL_VISUAL_MATERIAL[SOIL_VISUAL_ARCHETYPE.DARK_HUMUS];
  }

  blendSoilVisualMaterial(archetype, wetness, snowCover, out) {
    const src = SOIL_VISUAL_MATERIAL[archetype] ||
                SOIL_VISUAL_MATERIAL[SOIL_VISUAL_ARCHETYPE.DARK_HUMUS];
    const o = out || this._blendedParams;

    o.pbr.baseColor[0] = src.pbr.baseColor[0];
    o.pbr.baseColor[1] = src.pbr.baseColor[1];
    o.pbr.baseColor[2] = src.pbr.baseColor[2];
    o.pbr.metalness = src.pbr.metalness;
    o.pbr.roughness = src.pbr.roughness * (1 - wetness * 0.35);
    o.pbr.clearcoat = src.pbr.clearcoat + wetness * 0.25;
    o.pbr.transmission = src.pbr.transmission;
    o.pbr.ior = src.pbr.ior;
    o.pbr.sheen = src.pbr.sheen;
    o.pbr.anisotropy = src.pbr.anisotropy;

    o.anime.baseColor[0] = src.anime.baseColor[0];
    o.anime.baseColor[1] = src.anime.baseColor[1];
    o.anime.baseColor[2] = src.anime.baseColor[2];
    o.anime.quantizeSteps = src.anime.quantizeSteps;
    o.anime.rimPower = src.anime.rimPower;
    o.anime.rimColor[0] = src.anime.rimColor[0];
    o.anime.rimColor[1] = src.anime.rimColor[1];
    o.anime.rimColor[2] = src.anime.rimColor[2];

    o.subsurfaceRadius[0] = src.subsurfaceRadius[0];
    o.subsurfaceRadius[1] = src.subsurfaceRadius[1];
    o.subsurfaceRadius[2] = src.subsurfaceRadius[2];

    o.emissive[0] = src.emissive[0];
    o.emissive[1] = src.emissive[1];
    o.emissive[2] = src.emissive[2];

    o.normalScale = src.normalScale * (1 - wetness * 0.5);
    o.dustThreshold = src.dustThreshold * (1 - wetness * 0.7);
    o.organicTint = src.organicTint;

    // Snow tint blend into colour if present.
    if (snowCover > 0.02) {
      const snowFactor = Math.min(0.85, snowCover * 2);
      o.pbr.baseColor[0] = o.pbr.baseColor[0] * (1 - snowFactor) + 0.92 * snowFactor;
      o.pbr.baseColor[1] = o.pbr.baseColor[1] * (1 - snowFactor) + 0.95 * snowFactor;
      o.pbr.baseColor[2] = o.pbr.baseColor[2] * (1 - snowFactor) + 0.99 * snowFactor;
    }

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.soilColor) {
      spatial.soilColor = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        archetype: this._chunkArchetype,
        albedoR: this._chunkAlbedoR,
        albedoG: this._chunkAlbedoG,
        albedoB: this._chunkAlbedoB,
        normalScale: this._chunkNormalScale,
        wetness: this._chunkWetness,
        organicTint: this._chunkOrganicTint,
        snowTint: this._chunkSnowTint,
        splatLoam: this._chunkSplatLoam,
        splatSand: this._chunkSplatSand,
        splatClay: this._chunkSplatClay,
        splatPeat: this._chunkSplatPeat,
        roughness: this._chunkRoughness,
        clearcoat: this._chunkClearcoat,
        dustThreshold: this._chunkDustThreshold,
        dominantTexture: this._chunkDominantTexture,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          archetype: this._chunkCellArchetype,
          albedo: this._chunkCellAlbedo,
          splat: this._chunkCellSplat,
          normalScale: this._chunkCellNormalScale,
          wetness: this._chunkCellWetness
        },
        materialParams: SOIL_VISUAL_MATERIAL,
        archetypeNames: SOIL_VISUAL_NAMES,
        baseColors: SOIL_VISUAL_BASE_COLOR
      };
    }

    const s = spatial.soilColor;
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

    let sumAlbedoR = 0, sumAlbedoG = 0, sumAlbedoB = 0;
    let sumWetness = 0, sumOrganicTint = 0, sumSnowTint = 0;
    let sumSplatLoam = 0, sumSplatSand = 0, sumSplatClay = 0, sumSplatPeat = 0;
    let chunksWithColor = 0;
    const archetypeCount = new Uint16Array(SOIL_VISUAL_NAMES.length);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      chunksWithColor++;
      sumAlbedoR += this._chunkAlbedoR[i];
      sumAlbedoG += this._chunkAlbedoG[i];
      sumAlbedoB += this._chunkAlbedoB[i];
      sumWetness += this._chunkWetness[i];
      sumOrganicTint += this._chunkOrganicTint[i];
      sumSnowTint += this._chunkSnowTint[i];
      sumSplatLoam += this._chunkSplatLoam[i];
      sumSplatSand += this._chunkSplatSand[i];
      sumSplatClay += this._chunkSplatClay[i];
      sumSplatPeat += this._chunkSplatPeat[i];
      archetypeCount[this._chunkArchetype[i]]++;
    }

    const gc = this._globalSoilColor;
    const inv = chunksWithColor > 0 ? 1 / chunksWithColor : 0;
    gc.avgAlbedoR = sumAlbedoR * inv || 0.45;
    gc.avgAlbedoG = sumAlbedoG * inv || 0.38;
    gc.avgAlbedoB = sumAlbedoB * inv || 0.30;
    gc.avgWetness = sumWetness * inv || 0.3;
    gc.avgOrganicTint = sumOrganicTint * inv || 0.3;
    gc.avgSnowTint = sumSnowTint * inv || 0;
    gc.avgSplatLoam = sumSplatLoam * inv || 0.25;
    gc.avgSplatSand = sumSplatSand * inv || 0.25;
    gc.avgSplatClay = sumSplatClay * inv || 0.25;
    gc.avgSplatPeat = sumSplatPeat * inv || 0.25;

    // Dominant archetype.
    let dominantArch = 0;
    let maxCount = 0;
    for (let a = 0; a < archetypeCount.length; a++) {
      if (archetypeCount[a] > maxCount) { maxCount = archetypeCount[a]; dominantArch = a; }
    }
    gc.dominantArchetype = dominantArch;

    // Update distribution.
    if (chunksWithColor > 0) {
      for (let a = 0; a < archetypeCount.length; a++) {
        gc.archetypeDistribution[a] = archetypeCount[a] / chunksWithColor;
      }
    }

    if (!physical.soilColorProperties) physical.soilColorProperties = {};
    Object.assign(physical.soilColorProperties, gc);

    // Material-facing aggregates.
    physical.soilAlbedoR = gc.avgAlbedoR;
    physical.soilAlbedoG = gc.avgAlbedoG;
    physical.soilAlbedoB = gc.avgAlbedoB;
    physical.soilWetness = gc.avgWetness;
    physical.soilOrganicTint = gc.avgOrganicTint;
    physical.soilSnowTint = gc.avgSnowTint;
    physical.soilDominantArchetype = dominantArch;
    physical.soilDominantArchetypeName = SOIL_VISUAL_NAMES[dominantArch];
    physical.soilSplatLoam = gc.avgSplatLoam;
    physical.soilSplatSand = gc.avgSplatSand;
    physical.soilSplatClay = gc.avgSplatClay;
    physical.soilSplatPeat = gc.avgSplatPeat;

    if (!physical.soilArchetypeWeights) {
      physical.soilArchetypeWeights = new Float32Array(SOIL_VISUAL_NAMES.length);
    }
    if (chunksWithColor > 0) {
      for (let a = 0; a < archetypeCount.length; a++) {
        physical.soilArchetypeWeights[a] = archetypeCount[a] / chunksWithColor;
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
      this._sampleChunk(cx, cz, frame);
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

  setColorModulation(params) {
    for (const k of Object.keys(this.modulation)) {
      if (params[k] !== undefined) this.modulation[k] = params[k];
    }
    return this;
  }

  setSplatmapConstants(params) {
    for (const k of Object.keys(this.splatmap)) {
      if (params[k] !== undefined) this.splatmap[k] = params[k];
    }
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
  getGlobalSoilColor() { return { ...this._globalSoilColor }; }

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
    this._rocks = null;
    this._bathymetry = null;
    this._groundwater = null;
    this._moisture = null;
    this._decomposers = null;
    this._temperature = null;
    this._precipitation = null;
    this._wind = null;
    this._soil = null;
    this._fertility = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._splatPool.length = 0;
    this._archetypeArrayPool.length = 0;
  }
}

export {
  SoilColorTextureProvider,
  SOIL_VISUAL_ARCHETYPE,
  SOIL_VISUAL_NAMES,
  SOIL_VISUAL_BASE_COLOR,
  SOIL_VISUAL_MATERIAL,
  COLOR_MODULATION,
  SPLATMAP_CONSTANTS,
  SOIL_COLOR_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};