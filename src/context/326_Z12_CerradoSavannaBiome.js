// file number : 326_Z12
// full path name : src/context/326_Z12_CerradoSavannaBiome.js
// description : Cerrado savanna biome descriptor — the third of four additional
// grassland biome presets with a strong flowering-forb component. This preset
// covers the tropical savanna of central Brazil, the most biodiverse savanna on
// Earth and a global biodiversity hotspot. The defining drivers are a tropical
// wet–dry climate with a 4–7 month dry season, annual rainfall of 1,200–1,600
// mm in 65 % of the region, mean annual temperatures of 22–27 °C, and a
// vegetation gradient from pure grassland (campo limpo) through shrub savanna
// (campo sujo) to closed woodland (cerrado denso). Soils are predominantly
// highly weathered oxisols and ultisols: acidic (pH 4.0–5.5), dystrophic
// (nutrient-poor), with high aluminium saturation and high phosphorus-fixation
// capacity. Trees are fire-adapted with thick corky bark and tortuous
// branches, and the ground layer is dominated by C4 grasses and a
// exceptionally rich forb flora — over 400 species are known to flower after
// fire, most of them Asteraceae and Fabaceae. Provides the same eleven
// interlocking descriptor blocks as the base biomes, with full PBR + anime
// parameters for cerrado sensu stricto canopy, campo limpo grass, corky bark,
// tortuous branches, post-fire flowering forbs, dystrophic oxisol, and the
// distinctive dry-season haze and fire-scarred landscape. The descriptor
// allocates nothing after construction and is consumed by the biome registry,
// blend field, material bridge, climate/soil/hydrology couplings, fauna
// migration system, chunk descriptor, and the full material/lighting/sensory
// pipeline.
//#
// best for : Every consumer that needs a Cerrado, Brazilian savanna, tropical
// savanna, or campo biome preset — biome registry barrel (327), biome blend
// field (328), biome blend system (329), cross-biome ecotone (330), biome
// material bridge (331), biome climate coupling (332), biome soil coupling
// (333), biome hydrology coupling (334), biome fauna migration (335), landscape
// chunk descriptor (336), and the whole material/lighting/sensory pipeline.
// Together with the other grassland biome files this completes the planet-scale
// living-biome palette, and the Cerrado preset is the one that must remain
// seamless from the open campo limpo through the cerrado sensu stricto into the
// cerradão woodland, and from the dry-season fire mosaic into the wet-season
// green flush.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ───────
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

// ══════════════════════════════════════════════════════════════════
// ─── BIOME IDENTITY ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const BIOME_ID = 21;
const BIOME_NAME = 'cerrado_savanna';
const BIOME_DISPLAY_NAME = 'Cerrado Savanna';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── CERRADO CHARACTERISTIC PARAMETERS ──────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Tropical wet–dry (Köppen Aw): a stark contrast between a wet summer and a
// dry winter. Annual rainfall is 1,200–1,600 mm in 65 % of the region
// (overall range 600–2,200 mm). The dry season lasts 4–7 months
// in 88 % of the area, and 5–6 months in 67 % of the area. Mean annual
// temperature is 22 °C in the south and 27 °C in the north.
const CLIMATE = Object.freeze({
  // Temperature (°C) — tropical, warm year-round
  temperatureMin: 10.0,             // cool nights in the dry season
  temperatureMax: 38.0,             // hot late dry season
  temperatureMean: 24.5,            // 22–27 °C across the region
  temperatureDailySwing: 14.0,      // strong diurnal swing in the dry season
  temperatureFrostFree: true,       // frost is absent or extremely rare
  // Humidity (0..1) — strongly bimodal
  humidityMin: 0.20,                // very dry late dry season
  humidityMax: 0.85,
  humidityMean: 0.50,
  // Precipitation (mm/hr mean) — 1,200–1,600 mm annually in 65 % of the area
  precipitationMean: 2.0,
  precipitationMax: 45.0,           // intense convective storms
  precipitationStormProb: 0.20,
  precipitationAnnualMm: 1400.0,    // mid-range of the 1,200–1,600 mm band
  // Seasons — the wet–dry contrast is the defining cycle
  seasonalityAmplitude: 0.75,
  drySeasonLengthDays: 150,         // 5 months of dry season (May–September)
  wetSeasonPeakDay: 330,            // summer wet season (December–March)
  snowSeasonDays: 0,
  growingSeasonDays: 210,           // wet-season growing window
  // Wind — moderate, with dry-season gusts
  windMeanSpeed: 3.0,
  windMaxSpeed: 30.0,
  windPredominantDirDeg: 90,        // easterly trade winds
  // Weather state probabilities (0..1)
  weatherProbClear: 0.45,           // clear dry-season skies
  weatherProbCloudy: 0.20,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.00,
  weatherProbFog: 0.05,            // dry-season morning mist
  // Atmospheric
  pressureMeanKPa: 101.2,
  pressureSwingKPa: 2.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// The Cerrado occupies plateaus of crystalline or sedimentary blocks,
// broken by an extensive network of peripheral or interplateau depressions.
// Slopes are generally gentle (less than 3 %), and relief is low to moderate.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND_TO_PLATEAU,
  elevationMinM: 300.0,
  elevationMaxM: 1200.0,
  slopeMeanDeg: 2.0,                // generally less than 3 %
  slopeMaxDeg: 15.0,
  roughness: 0.35,
  valleyDepth: 0.25,
  valleyDensity: 0.40,
  plateauBias: 0.70,
  groundwaterTableDepthM: 10.0,      // deep, well-drained
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.35,
  biomeHint: BIOME_HINT.SAVANNA
});

// ─── Soil ──────────────────────────────────────────────────────
// Cerrado soils are predominantly highly weathered oxisols and ultisols
// (with some entisols). They are acidic (pH 4.0–5.5), dystrophic
// (nutrient-poor), with low natural availability of N, P, K, Ca, Mg, Zn, B,
// and Cu. They have high aluminium saturation and high phosphorus-fixation
// capacity due to kaolinite and Fe/Al oxides. Despite these constraints,
// native Cerrado plants are aluminium-tolerant or aluminium-accumulating.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.CLAY_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.RED_LATERITE,
  // Primary fractions (0..1) — clay-rich, deeply weathered oxisol
  sand: 0.30,
  silt: 0.15,
  clay: 0.50,                       // high clay content (kaolinite + Fe/Al oxides)
  organicMatter: 0.03,              // low organic matter
  gravel: 0.02,
  rockFragment: 0.00,
  // Chemistry — acidic, dystrophic, Al-toxic
  pH: 4.8,                          // 4.0–5.5
  fertilityClass: FERTILITY_CLASS.BARREN,
  fertilityIndex: 0.10,
  // Physics
  porosity: 0.45,
  bulkDensityGcm3: 1.10,            // well-drained, aggregate-stable
  waterHoldingCapacity: 0.20,
  hydraulicConductivityMmHr: 10.0,  // good drainage
  cohesionKPa: 6.0,
  plasticityIndex: 18.0,
  // Colour (linear RGB) — deep red-yellow lateritic
  baseAlbedo: [0.32, 0.14, 0.06],
  organicDarkening: 0.20,
  ironOxideRedness: 0.70,
  calciumPale: 0.00,
  // Erosion
  usleKFactor: 0.20,                // gentle slopes, stable aggregates
  windErodibility: 0.30,
  // ─── Oxisol-specific parameters ───────────────────────────
  aluminiumSaturationPercent: 60.0,  // high Al saturation
  phosphorusFixationCapacity: 0.80,  // very high P fixation
  availablePhosphorusMgKg: 1.5,      // extremely low available P
  cationExchangeCapacityCmolPerKg: 4.0, // low CEC
  baseSaturationPercent: 15.0,       // dystrophic
  drainageClass: 'well'
});

// ─── Vegetation ─────────────────────────────────────────────────
// The Cerrado is a vegetation gradient, not a single formation. It ranges
// from pure grassland (campo limpo: no trees, 5.5 Mg ha⁻¹ aboveground
// biomass) through shrub savanna (campo sujo) and open woodland (cerrado
// aberto) to closed woodland (cerrado denso: 1,000 trees ha⁻¹, 29.4 Mg ha⁻¹
// aboveground biomass). The tree layer is fire-adapted: thick corky
// bark and tortuous branches are the defining architectural traits. The
// ground layer is dominated by C4 grasses, and the forb flora is exceptionally
// rich — over 400 species flower after fire, mostly Asteraceae and
// Fabaceae.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.OAK]: 0.30,        // substitute for typical cerrado tree genera
    [TREE_TYPE.ACACIA]: 0.25,
    [TREE_TYPE.BAOBAB]: 0.15,     // substitute for thick-trunked species
    [TREE_TYPE.PINE]: 0.10,
    [TREE_TYPE.PALM]: 0.10,       // palm species in wetter pockets
    [TREE_TYPE.WILLOW]: 0.10      // riparian corridors
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.SAVANNA_BUNCH]: 0.45, // C4 bunchgrasses dominate
    [GRASS_TYPE.TALL_PRAIRIE]: 0.25,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.20,
    [GRASS_TYPE.THISTLE]: 0.10        // Asteraceae forbs
  }),
  verticalLayers: 2,                // tree layer + grass/forb layer
  emergentDensity: 0.00,
  canopyDensity: 0.25,              // open canopy (cerrado sensu stricto)
  understoryDensity: 0.30,          // shrubs and small trees
  groundCoverDensity: 0.75,         // continuous grass layer
  epiphyteDensity: 0.05,
  lianaDensity: 0.05,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 3,               // fire every 1–5 years is characteristic
  fireIntensity: 'high',            // grass-fueled surface fires
  rootDepthM: 4.0,                  // deep roots to reach the water table
  canopyRadiusM: 2.5,
  trunkHeightM: 6.0,
  leafLitterDepthM: 0.03,
  bloomWindowDays: 90,
  // Poisson-disc targets per hectare — calibrated from the cerrado denso literature
  treeDensityPerHa: 400,            // range 0–1,000 trees ha⁻¹ across the gradient
  shrubDensityPerHa: 800,
  groundCoverDensityPerHa: 60000,
  // ─── Fire-adaptive traits ──────────────────────────────────
  corkyBarkFraction: 0.70,          // thick, suberized bark
  tortuousBranchFraction: 0.65,     // twisted, contorted branches
  resproutingFraction: 0.75,        // most woody plants resprout after fire
  // ─── Post-fire flowering ───────────────────────────────────
  postFireFloweringSpecies: 400,    // >400 species flower after fire
  asteraceaeFraction: 0.30,         // dominant forb family
  fabaceaeFraction: 0.25,           // second most important forb family
  forbRichness: 0.45,               // ~45 % of species are forbs
  // ─── Vegetation gradient (physiognomic fractions) ──────────
  campoLimpoFraction: 0.15,         // pure grassland
  campoSujoFraction: 0.20,          // shrub savanna
  cerradoAbertoFraction: 0.30,      // open woodland
  cerradoDensoFraction: 0.20,       // closed woodland
  cerradaoFraction: 0.15            // tall closed woodland (forest-like)
});

// ─── Fauna ──────────────────────────────────────────────────────
// Cerrado fauna is highly diverse and includes many endemic species. The
// mosaic of grasslands, savannas, and woodlands supports a broad guild
// structure: large herbivores (tapir, deer, anteater), large predators
// (jaguar, maned wolf), small mammals, birds (rheas, seriemas, parrots),
// reptiles, and a rich insect fauna.
const FAUNA = Object.freeze({
  densityWeight: 0.60,
  habitatLayers: Object.freeze({
    ground: 0.45,                   // grassland and savanna species
    understory: 0.25,               // shrub and small-tree layer
    canopy: 0.20,                   // woodland species
    aerial: 0.10
  }),
  dielActivity: 0.35,               // crepuscular and nocturnal due to heat
  migrationCorridorWeight: 0.50,
  predatorPreyBalance: 0.50,
  nectarAvailability: 0.20,         // post-fire flowering forbs
  pollenAvailability: 0.20,
  // Characteristic guild weights
  largeHerbivoreWeight: 0.20,       // tapir, deer, anteater
  largePredatorWeight: 0.10,        // jaguar, maned wolf
  smallMammalWeight: 0.30,
  birdWeight: 0.25,                 // rheas, seriemas, parrots
  insectWeight: 0.10,
  reptileWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for Cerrado surfaces: cerrado sensu stricto
// canopy, campo limpo grass, corky bark, tortuous branches, post-fire
// flowering forbs, dystrophic oxisol, and the distinctive dry-season haze
// and fire-scarred landscape.
const MATERIALS = Object.freeze({
  // ─── Cerrado tree canopy ────────────────────────────────────
  cerradoCanopy: Object.freeze({
    albedo: [0.10, 0.16, 0.06],     // dark, sclerophyllous green
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.22,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.70,
    hardness: 0.35,
    brittleness: 0.55
  }),
  // ─── Corky bark (fire-adapted) ──────────────────────────────
  corkyBark: Object.freeze({
    albedo: [0.20, 0.14, 0.08],     // grey-brown, corky
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.15,
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.35,             // thick corky bark is fire-resistant
    hardness: 0.70,
    brittleness: 0.35
  }),
  // ─── Campo limpo grass (C4 bunchgrass) ──────────────────────
  campoLimpoGrass: Object.freeze({
    albedo: [0.28, 0.26, 0.12],     // dry-season straw
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.03,
    emissive: 0.0,
    wetnessResponse: 0.25,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.95,             // extremely flammable in the dry season
    hardness: 0.10,
    brittleness: 0.85
  }),
  // ─── Post-fire flowering forb (Asteraceae / Fabaceae) ───────
  postFireForb: Object.freeze({
    albedo: [0.22, 0.20, 0.10],     // green with floral accent
    roughness: 0.75,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.40,
    animeFlatness: 0.18,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.60,
    hardness: 0.10,
    brittleness: 0.85
  }),
  // ─── Dystrophic oxisol ──────────────────────────────────────
  dystrophicOxisol: Object.freeze({
    albedo: [0.32, 0.14, 0.06],     // deep red-yellow lateritic
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.30,
    animeFlatness: 0.48,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.05,
    hardness: 0.30,
    brittleness: 0.65
  }),
  // ─── Fire-scarred ground / charcoal ─────────────────────────
  charcoal: Object.freeze({
    albedo: [0.04, 0.03, 0.02],     // near-black
    roughness: 0.95,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.60,
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.05,
    brittleness: 0.95
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Cerrado lighting is dominated by intense tropical sun, a dry-season hazy
// atmosphere from fire smoke and dust, and the open canopy that allows
// substantial light to reach the ground layer.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.25,            // open canopy
  sunDiffuseFraction: 0.30,         // direct sun dominates
  sunIntensityScale: 1.30,          // intense tropical sun
  colourCast: [1.00, 0.96, 0.85],   // warm, slightly golden
  atmosphericScatterBoost: 0.85,    // dry air, but smoke haze in the dry season
  bioluminescentEmission: 0.00,
  dappledLightFrequency: 0.10,
  dappledLightAmplitude: 0.15,
  shadowSoftnessNear: 0.3,
  shadowSoftnessMid: 0.5,
  shadowSoftnessFar: 0.7,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.015,            // dry-season smoke and dust haze
  skyTint: [0.95, 0.90, 0.75],      // pale golden-blue
  // ─── Dry-season haze ──────────────────────────────────────
  hazeOpticalDepth: 0.30,
  hazeColor: [0.95, 0.88, 0.70]
});

// ─── Water ──────────────────────────────────────────────────────
// Water is scarce during the dry season. Streams are seasonal and often
// intermittent; groundwater is deep. The Cerrado is a key water source for
// major South American river basins, but this is a deep-storage function
// rather than a surface-water signal.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.05,       // ephemeral streams and rare springs
  riverineNetworkDensity: 0.10,
  canopyDrip: 0.05,
  groundwaterTableDepthM: 10.0,
  freshwaterSpringPresence: 0.05,
  waterTableDepthM: 10.0,
  bogCoverage: 0.00,                // veredas (palm swamps) are local
  lakeCoverage: 0.00,
  riverWidthMeanM: 2.0,
  waterTemperatureC: 22.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'dystrophicOxisol',
  seasonalFlowMonths: 5,
  intermittentFlow: true
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.25,               // birds, insects (seasonal)
    geological: 0.05,               // dry-season cracking
    water: 0.05,                    // rare streams
    wind: 0.35,                     // wind through grass and scrub
    vegetation: 0.25,               // grass and leaf rustle
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.15,                   // post-fire flowering
    earthy: 0.25,                   // red soil
    aquatic: 0.00,
    woodland: 0.10,
    smoke: 0.30,                    // fire smoke is defining
    animal: 0.05,
    decay: 0.05,
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.10
  }),
  tactile: Object.freeze({
    temperatureC: 26.0,
    humidity: 0.45,
    windPressurePa: 4.0,
    precipitationType: 'rain',
    groundHardness: 0.60
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Cerrado phenology is driven by the wet–dry cycle: a wet-season green flush
// with rapid grass growth and tree leaf-out, a dry-season curing to straw,
// and fire-stimulated flowering of forbs after the first rains or after fire.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: -10,         // flush with the first rains
    fullGreenDurationDays: 150,
    autumnColourShiftDays: 30,      // dry-season curing
    leafDropDurationDays: 15,
    bloomWindowDays: 90,
    sporeBoostWetSeason: 0.30,
    fungalBoostWetSeason: 0.25,
    postFireBloomDelayDays: 15,     // forbs flower ~15 days after fire
    postFireBloomPeakDays: 30       // peak at ~30 days post-fire
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      cerradoCanopy: { albedo: [0.12, 0.20, 0.06], roughness: 0.76 },
      campoLimpoGrass: { albedo: [0.18, 0.26, 0.08], roughness: 0.82 },
      dystrophicOxisol: { albedo: [0.32, 0.14, 0.06], wetnessResponse: 0.45 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      cerradoCanopy: { albedo: [0.10, 0.16, 0.06], roughness: 0.78 },
      campoLimpoGrass: { albedo: [0.16, 0.24, 0.08], roughness: 0.84 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      campoLimpoGrass: { albedo: [0.30, 0.26, 0.12], roughness: 0.86 },
      corkyBark: { albedo: [0.22, 0.16, 0.10], roughness: 0.92 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      cerradoCanopy: { albedo: [0.18, 0.14, 0.08], roughness: 0.82 },
      campoLimpoGrass: { albedo: [0.35, 0.30, 0.15], roughness: 0.88 },
      charcoal: { albedo: [0.04, 0.03, 0.02], roughness: 0.95 }
    })
  }),
  snowAccumulationRateMmHr: 0.0,
  snowMeltRateMmHr: 0.0,
  snowAlbedoSeasonal: 0.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroCanopyNoiseScale: 120.0,     // vegetation gradient bands
  midCanopyNoiseScale: 30.0,        // tree clump and gap mosaic
  microCanopyNoiseScale: 5.0,       // grass and forb detail
  fireScarNoiseScale: 40.0,         // burn-pattern variation
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  lodHighDistance: 1000.0,
  lodMidDistance: 5000.0,
  lodLowDistance: 25000.0,
  maxFireEventsPerTick: 3,          // fire is frequent
  maxErosionEventsPerTick: 1,
  maxGrowthEventsPerTick: 3,
  // ─── Fire spread parameters ────────────────────────────────
  fireSpreadRateMPerMin: 25.0,     // grass fires spread quickly
  fireReturnIntervalYears: 3.0,
  postFireFloweringDelayDays: 15.0
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Cerrado suitability is driven by tropical temperature (22–27 °C mean),
// a pronounced dry season, moderate annual rainfall (1,200–1,600 mm),
// highly weathered dystrophic oxisol soil with high aluminium saturation,
// gentle slopes, and low-to-mid elevation. 328_BiomeBlendField uses this to
// decide how much of the Cerrado biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Temperature: tropical, warm year-round ─────────────────────────
  const tempScore = smoothstep(15.0, 22.0, env.temperatureC) * (1.0 - smoothstep(32.0, 40.0, env.temperatureC));

  // ─── Humidity: strongly bimodal; dry season is defining ──────────
  const humidityScore = smoothstep(0.25, 0.45, env.humidity) * (1.0 - smoothstep(0.75, 0.90, env.humidity));

  // ─── Elevation: lowland to plateau ────────────────────────────────
  const elevScore = smoothstep(200.0, 400.0, env.elevationM) * (1.0 - smoothstep(1000.0, 1500.0, env.elevationM));

  // ─── Slope: gentle; steep slopes become forest or rock ─────────────
  const slopeScore = smoothstep(0.0, 1.0, env.slopeDeg) * (1.0 - smoothstep(10.0, 25.0, env.slopeDeg));

  // ─── Soil texture: clay-rich oxisol is typical ─────────────────────
  const textureScore =
    0.50 * smoothstep(0.35, 0.55, env.soilClay) +
    0.30 * smoothstep(0.15, 0.35, env.soilSand) +
    0.20 * (1.0 - smoothstep(0.10, 0.25, env.soilSilt));

  // ─── Water table: deep, well-drained ──────────────────────────────
  const waterScore = smoothstep(5.0, 10.0, env.waterTableDepthM);

  // ─── Patchiness: fire and vegetation gradient create a mosaic ─────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.25 * tempScore +
    0.25 * humidityScore +
    0.12 * elevScore +
    0.10 * slopeScore +
    0.18 * textureScore +
    0.10 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const CerradoSavannaBiome = Object.freeze({
  id: BIOME_ID,
  bit: BIOME_BIT,
  name: BIOME_NAME,
  displayName: BIOME_DISPLAY_NAME,
  climate: CLIMATE,
  terrain: TERRAIN,
  soil: SOIL,
  vegetation: VEGETATION,
  fauna: FAUNA,
  materials: MATERIALS,
  lighting: LIGHTING,
  water: WATER,
  sensory: SENSORY,
  seasonality: SEASONALITY,
  procedural: PROCEDURAL,
  getSuitability,
  register(registry) {
    if (registry && typeof registry.registerBiome === 'function') {
      registry.registerBiome(BIOME_ID, BIOME_NAME, this);
    }
  }
});

export default CerradoSavannaBiome;