// file number : 326_Z16
// full path name : src/context/326_Z16_RiverDeltaEstuaryBiome.js
// description : River delta / estuary biome descriptor — the third of four
// arbitrary landscape biomes that combine rock, valley, canyon, hill, lake,
// river, and vegetation features. This preset covers the low-lying transitional
// zone where a river meets a standing body of water — the Mississippi and
// Niger deltas, the Ganges-Brahmaputra, the Mekong, the Danube, the Nile, and
// the tidal estuaries of the Scheldt, the Thames, and the Elbe. The defining
// drivers are mixed freshwater–saltwater chemistry (brackish salinity from 0
// to 35 PSU), fine-grained sediment deposition, tidal influence, a low-relief
// lobe-and-channel morphology, and a productivity gradient from freshwater
// marsh to salt marsh to mangrove or seagrass fringe. Sediment supply is the
// master variable: deltas grow where sediment delivery exceeds subsidence and
// wave/tidal removal, and retreat where it does not. Estuaries are the
// converse — drowned river valleys where tidal mixing dominates. Both share
// the brackish-water salinity gradient and the extreme biological productivity
// that makes them among the most valuable ecosystems on Earth. Provides the
// same eleven interlocking descriptor blocks as the base biomes, with full
// PBR + anime parameters for turbid brackish water, fluid mud, freshwater
// marsh reed, salt marsh cordgrass, mangrove fringe, and the muddy, faecal-
// pellet-rich tidal flats exposed at low tide. The descriptor allocates
// nothing after construction and is consumed by the biome registry, blend
// field, material bridge, climate/soil/hydrology couplings, fauna migration
// system, chunk descriptor, and the full material/lighting/sensory pipeline.
//#
// best for : Every consumer that needs a river delta, estuary, tidal marsh,
// brackish lagoon, or deltaic wetland biome preset — biome registry barrel
// (327), biome blend field (328), biome blend system (329), cross-biome ecotone
// (330), biome material bridge (331), biome climate coupling (332), biome soil
// coupling (333), biome hydrology coupling (334), biome fauna migration (335),
// landscape chunk descriptor (336), and the whole material/lighting/sensory
// pipeline. This preset is designed to remain seamless from the freshwater
// marsh at the river mouth through the brackish central basin to the salt
// marsh and mangrove fringe, and to blend smoothly with the surrounding
// freshwater wetland and marine biomes.
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
import { CarveGradientProvider, CARVE_TYPE } from './282_Z03_CarveGradientProvider.js';
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
const BIOME_ID = 25;
const BIOME_NAME = 'river_delta_estuary';
const BIOME_DISPLAY_NAME = 'River Delta / Estuary';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── RIVER DELTA / ESTUARY CHARACTERISTIC PARAMETERS ────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Deltas and estuaries occur across all latitudes, from the Arctic Mackenzie
// Delta to the tropical Ganges-Brahmaputra. This block describes a temperate
// to subtropical representative case, where the river discharge and tidal
// mixing dominate over direct precipitation.
const CLIMATE = Object.freeze({
  // Temperature (°C) — moderated by the water body
  temperatureMin: -5.0,
  temperatureMax: 35.0,
  temperatureMean: 18.0,
  temperatureDailySwing: 8.0,
  temperatureFrostFree: false,
  // Humidity (0..1) — high, from water and marsh evapotranspiration
  humidityMin: 0.60,
  humidityMax: 1.00,
  humidityMean: 0.85,
  // Precipitation (mm/hr mean) — river input dominates, not local rain
  precipitationMean: 2.0,
  precipitationMax: 30.0,
  precipitationStormProb: 0.15,
  precipitationAnnualMm: 1000.0,
  // Seasons — river flood pulse, not precipitation cycle, is the main driver
  seasonalityAmplitude: 0.50,
  drySeasonLengthDays: 60,
  wetSeasonPeakDay: 120,
  snowSeasonDays: 30,
  growingSeasonDays: 240,
  // Wind — moderate, with coastal influence
  windMeanSpeed: 3.0,
  windMaxSpeed: 35.0,               // storm surge winds
  windPredominantDirDeg: 90,
  // Weather state probabilities (0..1)
  weatherProbClear: 0.30,
  weatherProbCloudy: 0.35,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.00,
  weatherProbFog: 0.05,
  // Atmospheric
  pressureMeanKPa: 101.2,
  pressureSwingKPa: 2.5
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Deltas are extremely low-relief depositional lobes with distributary
// channel networks. Estuaries are drowned river valleys with a funnel shape
// and tidal sand bars. Both are near sea level and shaped by water.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.DELTAIC_LOWLAND,
  elevationMinM: -5.0,              // subtidal channels and basins
  elevationMaxM: 10.0,              // delta plain and levees
  slopeMeanDeg: 0.1,
  slopeMaxDeg: 3.0,
  roughness: 0.25,                  // smooth depositional surface
  valleyDepth: 0.05,
  valleyDensity: 0.50,              // dense distributary network
  plateauBias: 0.85,
  groundwaterTableDepthM: -0.2,     // at or above the surface
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.30,
  biomeHint: BIOME_HINT.DELTA,
  // ─── Delta geometry ────────────────────────────────────────
  deltaLobeCount: 5,
  distributaryChannelCount: 12,
  channelWidthRangeM: 50.0,
  channelDepthRangeM: 5.0,
  // ─── Sediment and subsidence ───────────────────────────────
  sedimentAccretionMmPerYear: 5.0,
  subsidenceMmPerYear: 3.0,
  netElevationChangeMmPerYear: 2.0  // positive = accreting
});

// ─── Soil ──────────────────────────────────────────────────────
// Deltaic soils are fine-grained, organic-rich, and highly stratified: layers
// of mud, silt, and peat laid down by successive floods and tidal cycles.
// Salinity varies from freshwater at the upstream end to fully marine at the
// mouth. The substrates are anaerobic and sulphidic.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SILTY_CLAY,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.PEAT_BROWN,
  // Primary fractions (0..1) — very fine-grained
  sand: 0.10,
  silt: 0.50,
  clay: 0.30,
  organicMatter: 0.10,
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry
  pH: 6.8,
  fertilityClass: FERTILITY_CLASS.RICH, // delta soils are extremely fertile
  fertilityIndex: 0.80,
  // Physics
  porosity: 0.65,
  bulkDensityGcm3: 0.95,
  waterHoldingCapacity: 0.75,
  hydraulicConductivityMmHr: 0.1,
  cohesionKPa: 1.5,                 // soft, unstable mud
  plasticityIndex: 30.0,
  // Colour (linear RGB) — brown to grey-brown
  baseAlbedo: [0.16, 0.13, 0.10],
  organicDarkening: 0.55,
  ironOxideRedness: 0.20,
  calciumPale: 0.15,
  // Erosion
  usleKFactor: 0.05,
  windErodibility: 0.00,
  // ─── Anaerobic parameters ─────────────────────────────────
  redoxPotentialMv: -180.0,
  sulfideConcentrationMm: 1.5,
  // ─── Salinity gradient ────────────────────────────────────
  porewaterSalinityPsu: 15.0,       // mean; ranges 0–35 PSU
  salinityGradient: 'strong',       // freshwater to marine
  drainageClass: 'very_poor'
});

// ─── Vegetation ─────────────────────────────────────────────────
// Delta and estuary vegetation is zoned by salinity, which itself is zoned by
// distance from the river mouth and by tidal elevation. The gradient runs:
// freshwater marsh (reed, cattail, bulrush) → brackish marsh (mixed reed and
// cordgrass) → salt marsh (cordgrass, saltwort) → mangrove fringe in the
// tropics.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.MANGROVE]: 0.60,   // tropical and subtropical fringe
    [TREE_TYPE.WILLOW]: 0.25,     // freshwater riparian
    [TREE_TYPE.CYPRESS]: 0.10,    // swamp and floodplain
    [TREE_TYPE.PALM]: 0.05        // tropical delta
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.MARSH_REED]: 0.45,  // reed, cattail, bulrush
    [GRASS_TYPE.MEADOW_GRASS]: 0.30, // salt marsh cordgrass
    [GRASS_TYPE.FERN]: 0.15,         // brackish understorey
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.10
  }),
  verticalLayers: 4,                // freshwater → brackish → salt → mangrove
  emergentDensity: 0.55,
  canopyDensity: 0.15,              // mangrove and willow canopy
  understoryDensity: 0.25,
  groundCoverDensity: 0.45,
  epiphyteDensity: 0.10,
  lianaDensity: 0.05,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 200,             // fire is rare in wetland
  rootDepthM: 0.8,
  canopyRadiusM: 3.5,
  trunkHeightM: 8.0,
  leafLitterDepthM: 0.10,
  bloomWindowDays: 120,
  // Poisson-disc targets per hectare
  treeDensityPerHa: 200,
  shrubDensityPerHa: 400,
  groundCoverDensityPerHa: 15000,
  // ─── Salinity zonation fractions ───────────────────────────
  freshwaterMarshFraction: 0.30,
  brackishMarshFraction: 0.25,
  saltMarshFraction: 0.25,
  mangroveFringeFraction: 0.20,
  // ─── Sediment trapping ─────────────────────────────────────
  sedimentTrappingRateGPerM2PerYear: 500.0
});

// ─── Fauna ──────────────────────────────────────────────────────
// Delta and estuary fauna is exceptionally productive: the mix of fresh and
// salt water creates a nursery habitat for coastal fisheries, and the marsh
// mosaic supports immense numbers of migratory birds.
const FAUNA = Object.freeze({
  densityWeight: 0.90,
  habitatLayers: Object.freeze({
    water: 0.35,                    // fish, shellfish, dolphins
    marsh: 0.30,                    // waterfowl, waders, mammals
    mudflat: 0.20,                  // invertebrates, shorebirds
    aerial: 0.15
  }),
  dielActivity: 0.35,               // tidal rather than diel rhythms dominate
  migrationCorridorWeight: 0.95,    // major stopover for migratory birds
  predatorPreyBalance: 0.55,
  nectarAvailability: 0.05,
  pollenAvailability: 0.05,
  // Characteristic guild weights
  fishNurseryWeight: 0.30,
  shellfishWeight: 0.20,
  waterfowlWeight: 0.20,
  shorebirdWeight: 0.15,
  semiAquaticMammalWeight: 0.10,
  benthicInvertebrateWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for delta and estuary surfaces: turbid brackish
// water, fluid mud, freshwater marsh reed, salt marsh cordgrass, mangrove
// fringe, and the muddy, faecal-pellet-rich tidal flats exposed at low tide.
const MATERIALS = Object.freeze({
  // ─── Brackish estuary water ─────────────────────────────────
  brackishEstuaryWater: Object.freeze({
    albedo: [0.12, 0.14, 0.10],     // greenish-brown, turbid
    roughness: 0.12,
    metalness: 0.0,
    transmission: 0.55,
    ior: 1.335,
    fresnelF0: 0.02,
    subsurface: 0.15,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.WATER,
    flammability: 0.0,
    hardness: 0.0,
    brittleness: 1.0,
    attenuationKd: Object.freeze({
      red: 1.10,
      green: 0.65,
      blue: 0.40
    }),
    // ─── Suspended sediment ────────────────────────────────
    suspendedSedimentMgL: 100.0,
    turbidityNTU: 30.0
  }),
  // ─── Fluid mud / tidal flat ────────────────────────────────
  fluidMud: Object.freeze({
    albedo: [0.14, 0.12, 0.10],
    roughness: 0.70,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.02,
    brittleness: 0.98,
    // ─── Faecal pellet texture ─────────────────────────────
    pelletDensityPerM2: 2000.0,
    bioturbationDepthCm: 15.0
  }),
  // ─── Freshwater marsh reed ──────────────────────────────────
  freshwaterReed: Object.freeze({
    albedo: [0.22, 0.26, 0.10],
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.80,
    animeFlatness: 0.22,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.60,
    hardness: 0.18,
    brittleness: 0.72
  }),
  // ─── Salt marsh cordgrass ──────────────────────────────────
  saltMarshCordgrass: Object.freeze({
    albedo: [0.20, 0.24, 0.14],     // grey-green, salt-adapted
    roughness: 0.82,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.03,
    emissive: 0.0,
    wetnessResponse: 0.75,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.55,
    hardness: 0.15,
    brittleness: 0.78
  }),
  // ─── Mangrove fringe ────────────────────────────────────────
  mangroveFringe: Object.freeze({
    albedo: [0.08, 0.14, 0.06],     // deep green
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.08,
    emissive: 0.0,
    wetnessResponse: 0.90,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.30,
    hardness: 0.30,
    brittleness: 0.65
  }),
  // ─── Willow / cypress bark ──────────────────────────────────
  deltaBark: Object.freeze({
    albedo: [0.16, 0.12, 0.09],
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.70,
    animeFlatness: 0.35,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.45,
    hardness: 0.65,
    brittleness: 0.40
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Delta and estuary lighting is shaped by the high humidity, the frequent
// haze and mist, the strong water reflections, and the low sun angles over
// extensive flat terrain. Fog and mist are frequent, especially at dawn.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.15,            // sparse canopy
  sunDiffuseFraction: 0.55,         // humid haze
  sunIntensityScale: 1.00,
  colourCast: [0.98, 0.98, 0.90],   // warm, humid light
  atmosphericScatterBoost: 1.30,    // high humidity and haze
  bioluminescentEmission: 0.02,     // fireflies and bioluminescent plankton
  dappledLightFrequency: 0.15,
  dappledLightAmplitude: 0.20,
  shadowSoftnessNear: 0.5,
  shadowSoftnessMid: 0.7,
  shadowSoftnessFar: 0.85,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.025,            // frequent coastal mist
  skyTint: [0.85, 0.90, 0.92],
  // ─── Water reflection / bounce ────────────────────────────
  waterReflectionStrength: 0.30,
  // ─── Tidal flat specular sheen ────────────────────────────
  wetMudSpecularBoost: 0.40
});

// ─── Water ──────────────────────────────────────────────────────
// Water is the defining element: the river discharge, tidal mixing, and
// salinity gradient all act together to shape the biome. Salinity ranges
// from freshwater at the upstream end to marine at the mouth; turbidity is
// high and the water is well-mixed vertically in the tidal reaches.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.60,
  riverineNetworkDensity: 0.60,     // dense distributary network
  canopyDrip: 0.10,
  groundwaterTableDepthM: -0.2,
  freshwaterSpringPresence: 0.10,
  waterTableDepthM: -0.2,
  bogCoverage: 0.15,
  lakeCoverage: 0.05,               // shallow lagoons
  riverWidthMeanM: 200.0,           // major distributary channels
  waterTemperatureC: 18.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'fluidMud',
  // ─── Tidal parameters ─────────────────────────────────────
  tidalRangeM: 2.5,                 // mesotidal
  tidalPeriodHours: 12.42,
  inundationFrequencyPerDay: 1.5,
  inundationDurationFraction: 0.45,
  // ─── Salinity gradient ────────────────────────────────────
  salinityUpstreamPsu: 0.5,         // nearly fresh at the river mouth
  salinityMouthPsu: 32.0,           // near-marine at the coastal end
  salinityGradientLengthKm: 30.0,
  wellMixed: true,
  // ─── Sediment and turbidity ───────────────────────────────
  suspendedSedimentMgL: 100.0,
  turbidityNTU: 30.0,
  secchiDepthM: 0.8,
  cdomAbsorption: 0.80,
  // ─── River discharge ─────────────────────────────────────
  riverDischargeM3s: 2000.0,
  floodPulseAmplitudeM: 2.0,
  floodSeasonPeakDay: 120,
  // ─── Tidal currents ──────────────────────────────────────
  tidalCurrentMs: 0.8,
  // ─── Storm surge ─────────────────────────────────────────
  stormSurgeHeightM: 3.0,
  stormSurgeReturnPeriodYears: 20.0
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  acoustic: Object.freeze({
    biological: 0.35,               // birds, frogs, insects
    geological: 0.00,
    water: 0.35,                    // tidal flow, waves
    wind: 0.15,
    vegetation: 0.15,
    mechanical: 0.00
  }),
  olfactory: Object.freeze({
    floral: 0.05,
    earthy: 0.25,                   // mud and sediment
    aquatic: 0.30,                  // brackish and saline water
    woodland: 0.05,
    smoke: 0.00,
    animal: 0.10,
    decay: 0.15,                    // anaerobic decomposition
    sulfur: 0.10,                   // hydrogen sulfide from sulphidic mud
    sea: 0.05,
    clean: 0.00
  }),
  tactile: Object.freeze({
    temperatureC: 18.0,
    humidity: 0.85,
    windPressurePa: 3.0,
    precipitationType: 'rain',
    groundHardness: 0.02           // soft, saturated mud
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Delta and estuary phenology is driven by the river flood pulse and the
// tidal cycle rather than by temperature. The spring flood is the defining
// seasonal event: it delivers sediment, nutrients, and freshwater to the
// delta plain, and triggers the marsh growth flush.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 200,
    autumnColourShiftDays: 25,
    leafDropDurationDays: 20,
    bloomWindowDays: 120,
    sporeBoostWetSeason: 0.30,
    fungalBoostWetSeason: 0.20
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      freshwaterReed: { albedo: [0.24, 0.30, 0.12], roughness: 0.76 },
      saltMarshCordgrass: { albedo: [0.22, 0.28, 0.14], roughness: 0.80 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      freshwaterReed: { albedo: [0.22, 0.26, 0.10], roughness: 0.78 },
      mangroveFringe: { albedo: [0.08, 0.14, 0.06], roughness: 0.78 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      freshwaterReed: { albedo: [0.32, 0.28, 0.12], roughness: 0.82 },
      saltMarshCordgrass: { albedo: [0.28, 0.24, 0.12], roughness: 0.84 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      freshwaterReed: { albedo: [0.30, 0.26, 0.18], roughness: 0.84 },
      deltaBark: { albedo: [0.18, 0.14, 0.10], roughness: 0.90 },
      fluidMud: { albedo: [0.16, 0.14, 0.12], wetnessResponse: 1.0 }
    })
  }),
  snowAccumulationRateMmHr: 0.0,
  snowMeltRateMmHr: 0.0,
  snowAlbedoSeasonal: 0.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  macroChannelNoiseScale: 500.0,    // distributary network
  midChannelNoiseScale: 80.0,       // channel and levee detail
  microMudNoiseScale: 10.0,         // mud cracks and pellet detail
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  lodHighDistance: 1500.0,          // long sightlines over flat terrain
  lodMidDistance: 6000.0,
  lodLowDistance: 30000.0,
  maxFireEventsPerTick: 0,
  maxErosionEventsPerTick: 2,       // channel migration, bank erosion
  maxGrowthEventsPerTick: 4,
  // ─── Channel migration ────────────────────────────────────
  channelMigrationRateMPerYear: 5.0,
  // ─── Sediment accretion ───────────────────────────────────
  marshAccretionMmPerYear: 5.0,
  // ─── Tidal creek evolution ────────────────────────────────
  tidalCreekGrowthRateMPerYear: 1.0
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// River delta / estuary suitability is driven by near-sea-level elevation,
// shallow water table, extreme flatness, fine-grained sediment, tidal
// influence, and a significant river discharge. 328_BiomeBlendField uses this
// to decide how much of the delta/estuary biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

function getSuitability(env) {
  // ─── Elevation: near sea level is mandatory ─────────────────────────
  const elevScore =
    smoothstep(-8.0, 0.0, env.elevationM) *
    (1.0 - smoothstep(5.0, 15.0, env.elevationM));

  // ─── Temperature: broad tolerance, avoids extremes ─────────────────
  const tempScore = smoothstep(-5.0, 5.0, env.temperatureC) * (1.0 - smoothstep(32.0, 42.0, env.temperatureC));

  // ─── Humidity: high from water and marsh evapotranspiration ───────
  const humidityScore = smoothstep(0.60, 0.80, env.humidity);

  // ─── Slope: extremely flat is the defining trait ─────────────────
  const slopeScore = 1.0 - smoothstep(0.1, 2.0, env.slopeDeg);

  // ─── Substrate: fine-grained silt-clay is mandatory ──────────────
  const textureScore =
    0.45 * smoothstep(0.35, 0.55, env.soilSilt) +
    0.40 * smoothstep(0.20, 0.40, env.soilClay) +
    0.15 * (1.0 - smoothstep(0.10, 0.30, env.soilSand));

  // ─── Water table: at or above the surface ────────────────────────
  const waterScore = 1.0 - smoothstep(-0.5, 1.5, Math.max(0.0, env.waterTableDepthM));

  // ─── River proximity (proxy via reliefRangeM if available) ───────
  const riverScore = env.riverDischargeM3s !== undefined
    ? smoothstep(10.0, 500.0, env.riverDischargeM3s)
    : 0.5;

  // ─── Patchiness ────────────────────────────────────────────────────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.20 * elevScore +
    0.10 * tempScore +
    0.10 * humidityScore +
    0.20 * slopeScore +
    0.15 * textureScore +
    0.20 * waterScore +
    0.05 * riverScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const RiverDeltaEstuaryBiome = Object.freeze({
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

export default RiverDeltaEstuaryBiome;