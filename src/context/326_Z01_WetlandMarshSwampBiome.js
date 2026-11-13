// file number : 326_Z01
// full path name : src/context/326_Z01_WetlandMarshSwampBiome.js
// description : Wetland / marsh / swamp biome descriptor — the first of five
// additional biome presets that extend the base nine (318–326). Wetlands are
// defined by saturated soils or standing water for at least part of the year,
// anaerobic (waterlogged) substrate conditions, hydrophytic vegetation, and a
// fauna dominated by amphibians, waterfowl, and aquatic insects. This preset
// covers freshwater and brackish marshes, swamps, fens, and bogs, and is
// distinct from 324_AquaticFreshwaterBiome because it describes a vegetated
// land–water transition zone (not an open water body), with peat accumulation,
// methane cycling, and a characteristic wetland scent. Provides the same eleven
// interlocking descriptor blocks as the base nine biomes, with full PBR + anime
// parameters for wet mud, peat, marsh grass, cattail, duckweed, cypress, and
// mangrove, plus a methane-emission-driven atmospheric haze term. The
// descriptor allocates nothing after construction and is consumed by the biome
// registry, blend field, material bridge, hydrology coupling, fauna migration
// system, chunk descriptor, and the full material/lighting/sensory pipeline.
//#
// best for : Every consumer that needs a wetland, marsh, swamp, fen, or bog
// biome preset — biome registry barrel (327), biome blend field (328), biome
// blend system (329), cross-biome ecotone (330), biome material bridge (331),
// biome climate coupling (332), biome soil coupling (333), biome hydrology
// coupling (334), biome fauna migration (335), landscape chunk descriptor
// (336), and the whole material/lighting/sensory pipeline. Together with the
// other extended biome files this completes the planet-scale living-biome
// palette, and the wetland preset is the one that must remain seamless from
// the open water of 324 through the marsh margin into dry upland.
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
const BIOME_ID = 10;
const BIOME_NAME = 'wetland_marsh_swamp';
const BIOME_DISPLAY_NAME = 'Wetland / Marsh / Swamp';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── WETLAND CHARACTERISTIC PARAMETERS ──────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Wetlands occur across all climate zones; this block describes the local
// microclimate of the waterlogged ground rather than the regional climate.
const CLIMATE = Object.freeze({
  // Temperature (°C) — moderated by standing water
  temperatureMin: -10.0,
  temperatureMax: 35.0,
  temperatureMean: 16.0,
  temperatureDailySwing: 8.0,
  temperatureFrostFree: false,
  // Humidity (0..1) — very high due to evapotranspiration and standing water
  humidityMin: 0.65,
  humidityMax: 1.00,
  humidityMean: 0.88,
  // Precipitation (mm/hr mean) — wetlands depend on external water input
  precipitationMean: 2.5,
  precipitationMax: 30.0,
  precipitationStormProb: 0.15,
  precipitationAnnualMm: 1000.0,
  // Seasons — spring flood pulse is the dominant seasonal signal
  seasonalityAmplitude: 0.55,
  drySeasonLengthDays: 30,
  wetSeasonPeakDay: 90,
  snowSeasonDays: 30,
  growingSeasonDays: 200,
  // Wind — light, sheltered by vegetation
  windMeanSpeed: 1.8,
  windMaxSpeed: 15.0,
  windPredominantDirDeg: 270,
  // Weather state probabilities (0..1)
  weatherProbClear: 0.30,
  weatherProbCloudy: 0.35,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.03,
  weatherProbFog: 0.02,
  // Atmospheric
  pressureMeanKPa: 101.3,
  pressureSwingKPa: 2.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Wetlands occupy flat, low-lying ground with poor drainage. Peat
// accumulation raises the surface over time (ombrotrophic bog growth).
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND,
  elevationMinM: 0.0,
  elevationMaxM: 500.0,
  slopeMeanDeg: 0.3,
  slopeMaxDeg: 3.0,
  roughness: 0.40,                  // hummocky, hollow-and-hummock microrelief
  valleyDepth: 0.05,
  valleyDensity: 0.20,
  plateauBias: 0.90,                // nearly flat
  groundwaterTableDepthM: -0.2,     // at or above the surface
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.45,
  biomeHint: BIOME_HINT.WETLAND,
  // Peat accumulation: bog surface rises at ~1 mm/yr and can reach 10 m
  peatAccumulationMmPerYear: 1.0,
  maxPeatDepthM: 10.0
});

// ─── Soil ──────────────────────────────────────────────────────
// Wetland soils are hydric: saturated, anaerobic, organic-rich (peat or muck),
// and often highly acidic due to organic acid accumulation.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.PEAT,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.PEAT_BROWN,
  // Primary fractions (0..1) — organic-dominated
  sand: 0.05,
  silt: 0.15,
  clay: 0.10,
  organicMatter: 0.65,              // peat-forming
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry
  pH: 4.0,                          // acidic from organic acids
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.15,
  // Physics
  porosity: 0.75,                  // highly porous, spongy
  bulkDensityGcm3: 0.20,            // very low density (peat)
  waterHoldingCapacity: 0.90,
  hydraulicConductivityMmHr: 0.05,
  cohesionKPa: 1.0,
  plasticityIndex: 30.0,
  // Colour (linear RGB) — dark brown-black
  baseAlbedo: [0.08, 0.06, 0.04],
  organicDarkening: 0.85,
  ironOxideRedness: 0.05,
  calciumPale: 0.05,
  // Erosion
  usleKFactor: 0.05,                // protected by vegetation and flatness
  windErodibility: 0.05,
  // ─── Anaerobic parameters ──────────────────────────────────
  // Saturated soils have a redox potential (Eh) of -100 to -300 mV,
  // favouring methanogenesis over aerobic decomposition.
  redoxPotentialMv: -200.0,
  methaneEmissionMgM2PerDay: 50.0,
  // ─── Peat chemistry ────────────────────────────────────────
  carbonContentPercent: 50.0,       // typical peat carbon fraction
  nitrogenContentPercent: 1.5,
  humicAcidConcentration: 0.60
});

// ─── Vegetation ─────────────────────────────────────────────────
// Wetland vegetation is hydrophytic: adapted to saturated soils and low
// oxygen. Zones from open water to upland: submerged → floating → emergent →
// meadow → swamp forest.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.WILLOW]: 0.35,
    [TREE_TYPE.CYPRESS]: 0.30,    // bald cypress, swamp cypress
    [TREE_TYPE.MANGROVE]: 0.20,   // brackish only
    [TREE_TYPE.BIRCH]: 0.15       // bog birch at margins
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.MARSH_REED]: 0.60, // Phragmites, cattail, bulrush
    [GRASS_TYPE.FERN]: 0.20,       // royal fern, cinnamon fern
    [GRASS_TYPE.MEADOW_GRASS]: 0.15,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.05
  }),
  verticalLayers: 4,                // submerged, floating, emergent, meadow
  emergentDensity: 0.55,            // cattail and reed dominate
  canopyDensity: 0.20,              // swamp forest in places
  understoryDensity: 0.25,
  groundCoverDensity: 0.40,         // moss, duckweed, sedge
  epiphyteDensity: 0.10,
  lianaDensity: 0.05,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 200,             // fire is rare in freshwater wetlands
  rootDepthM: 0.5,                  // shallow, above the water table
  canopyRadiusM: 3.5,
  trunkHeightM: 10.0,
  leafLitterDepthM: 0.15,           // thick peat accumulation
  bloomWindowDays: 120,
  // Poisson-disc targets per hectare
  treeDensityPerHa: 150,
  shrubDensityPerHa: 400,
  groundCoverDensityPerHa: 12000
});

// ─── Fauna ──────────────────────────────────────────────────────
// Wetland fauna is exceptionally diverse per unit area: amphibians, waterfowl,
// wading birds, aquatic insects, and semi-aquatic mammals.
const FAUNA = Object.freeze({
  densityWeight: 0.75,
  habitatLayers: Object.freeze({
    surface: 0.30,                  // water surface for waterfowl, frogs
    vegetation: 0.30,               // reeds, sedge, cattail for nesting
    belowWater: 0.20,               // fish, aquatic invertebrates
    benthic: 0.10,                  // bottom-dwelling invertebrates
    aerial: 0.10                    // dragonflies, swallows, raptors
  }),
  dielActivity: 0.35,               // dawn/dusk chorus dominates
  migrationCorridorWeight: 0.85,    // major stopover for migratory birds
  predatorPreyBalance: 0.60,
  nectarAvailability: 0.10,
  pollenAvailability: 0.10,
  // Characteristic guild weights
  amphibianWeight: 0.25,
  waterfowlWeight: 0.25,
  aquaticInsectWeight: 0.25,
  wadingBirdWeight: 0.10,
  semiAquaticMammalWeight: 0.10,
  fishWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for wetland surfaces: peat, wet mud, marsh
// grass, cattail, duckweed, cypress, and mangrove.
const MATERIALS = Object.freeze({
  // ─── Peat / muck ────────────────────────────────────────────
  peat: Object.freeze({
    albedo: [0.08, 0.06, 0.04],
    roughness: 0.92,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.30,             // dried peat is flammable
    hardness: 0.05,
    brittleness: 0.95
  }),
  // ─── Wet mud / hydric soil ──────────────────────────────────
  wetMud: Object.freeze({
    albedo: [0.10, 0.09, 0.07],
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.05,
    brittleness: 0.90
  }),
  // ─── Marsh grass / reed ─────────────────────────────────────
  marshReed: Object.freeze({
    albedo: [0.22, 0.25, 0.12],
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.75,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.60,
    hardness: 0.20,
    brittleness: 0.70
  }),
  // ─── Cattail ───────────────────────────────────────────────
  cattail: Object.freeze({
    albedo: [0.18, 0.20, 0.10],
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.70,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.65,
    hardness: 0.20,
    brittleness: 0.70
  }),
  // ─── Duckweed / floating vegetation ────────────────────────
  duckweed: Object.freeze({
    albedo: [0.15, 0.28, 0.10],
    roughness: 0.72,
    metalness: 0.0,
    transmission: 0.10,
    subsurface: 0.10,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.30,
    hardness: 0.05,
    brittleness: 0.95
  }),
  // ─── Cypress / mangrove bark ───────────────────────────────
  swampBark: Object.freeze({
    albedo: [0.15, 0.11, 0.08],
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.85,
    animeFlatness: 0.35,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.45,
    hardness: 0.65,
    brittleness: 0.40
  }),
  // ─── Standing water (shallow) ──────────────────────────────
  marshWater: Object.freeze({
    albedo: [0.08, 0.12, 0.10],     // greenish from algae and tannins
    roughness: 0.10,
    metalness: 0.0,
    transmission: 0.70,
    ior: 1.333,
    fresnelF0: 0.02,
    subsurface: 0.20,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.WATER,
    flammability: 0.0,
    hardness: 0.0,
    brittleness: 1.0,
    // ─── Beer–Lambert absorption for tannin-stained water ──
    attenuationKd: Object.freeze({
      red: 0.90,                    // tannins absorb strongly in red
      green: 0.55,
      blue: 0.30
    })
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Wetland lighting is shaped by atmospheric haze (methane, water vapour),
// the green-filtered light of the vegetation canopy, and high albedo from
// standing water.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.30,            // moderate from emergent vegetation
  sunDiffuseFraction: 0.55,         // humid air and haze increase diffuse
  sunIntensityScale: 0.85,
  colourCast: [0.90, 0.98, 0.92],   // green-shifted from vegetation
  atmosphericScatterBoost: 1.30,    // humid haze
  bioluminescentEmission: 0.10,     // fireflies and bioluminescent fungi
  dappledLightFrequency: 0.30,
  dappledLightAmplitude: 0.25,
  shadowSoftnessNear: 0.5,
  shadowSoftnessMid: 0.7,
  shadowSoftnessFar: 0.85,
  shadowCascadeScale: 0.9,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.020,            // wetland mist and methane haze
  skyTint: [0.85, 0.92, 0.90],
  // ─── Methane haze term (drives local fog enhancement) ──
  methaneHazeDensityPerMg: 0.0001,
  // ─── Water-column attenuation (tannin-stained) ──────────
  attenuationKd: Object.freeze({
    red: 0.90,
    green: 0.55,
    blue: 0.30
  })
});

// ─── Water ──────────────────────────────────────────────────────
// Wetland hydrology is characterised by shallow, slow-moving or standing
// water, high water table, and seasonal flood pulses.
const WATER = Object.freeze({
  surfaceWaterPresence: 0.60,       // much of the biome is inundated
  riverineNetworkDensity: 0.30,     // slow channels and creeks
  canopyDrip: 0.20,
  groundwaterTableDepthM: -0.2,     // at or above the surface
  freshwaterSpringPresence: 0.10,
  waterTableDepthM: -0.2,
  bogCoverage: 0.50,
  lakeCoverage: 0.10,               // ponds and oxbows
  riverWidthMeanM: 3.0,
  waterTemperatureC: 16.0,
  iceCoverMonths: 2,
  shorelineMaterial: 'wetMud',
  // ─── Hydrological parameters ───────────────────────────
  // Water residence time (days) — long for bogs, short for tidal wetlands
  waterResidenceDays: 180.0,
  // Seasonal flood pulse amplitude (metres above the dry-season water level)
  floodPulseAmplitudeM: 1.2,
  // ─── Water quality ─────────────────────────────────────
  tanninConcentrationMgL: 30.0,
  dissolvedOrganicCarbonMgL: 20.0,
  dissolvedOxygenMgL: 3.0,          // low, especially in peat
  methaneSaturationPercent: 80.0
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.45,               // amphibian chorus, bird calls dominate
    geological: 0.00,
    water: 0.25,                    // water flow, lapping
    wind: 0.10,                     // muted by vegetation
    vegetation: 0.20,               // reed rustle
    mechanical: 0.00
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.10,
    earthy: 0.25,
    aquatic: 0.20,
    woodland: 0.05,
    smoke: 0.00,
    animal: 0.05,
    decay: 0.15,                    // anaerobic decay
    sulfur: 0.10,                   // hydrogen sulfide and methane
    sea: 0.00,                      // freshwater; coastal variants set sea
    clean: 0.10
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: 16.0,
    humidity: 0.88,
    windPressurePa: 1.0,
    precipitationType: 'rain',
    groundHardness: 0.02           // soft, saturated, spongy
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Wetland phenology is driven by the spring flood pulse, summer growth, and
// autumn senescence. Winter is dormancy under ice or dry frost.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 150,
    autumnColourShiftDays: 25,
    leafDropDurationDays: 20,
    bloomWindowDays: 100,
    sporeBoostWetSeason: 0.30,
    fungalBoostWetSeason: 0.25
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      marshReed: { albedo: [0.26, 0.30, 0.14], roughness: 0.75 },
      wetMud: { albedo: [0.12, 0.10, 0.08], wetnessResponse: 1.0 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      marshReed: { albedo: [0.22, 0.25, 0.12], roughness: 0.78 },
      cattail: { albedo: [0.18, 0.20, 0.10], roughness: 0.80 },
      duckweed: { albedo: [0.15, 0.28, 0.10], roughness: 0.72 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      marshReed: { albedo: [0.35, 0.28, 0.12], roughness: 0.80 },  // straw-brown
      cattail: { albedo: [0.28, 0.22, 0.10], roughness: 0.82 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      marshReed: { albedo: [0.30, 0.26, 0.15], roughness: 0.82 },
      marshWater: { albedo: [0.65, 0.72, 0.78], roughness: 0.12, transmission: 0.40 },
      peat: { albedo: [0.10, 0.08, 0.06], wetnessResponse: 0.20 }
    })
  }),
  snowAccumulationRateMmHr: 1.0,
  snowMeltRateMmHr: 2.0,
  snowAlbedoSeasonal: 0.85
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  // Noise scales (world units) for wetland microrelief and vegetation mosaic
  macroWaterNoiseScale: 200.0,      // bog pools and channels
  midWaterNoiseScale: 40.0,         // hummock-and-hollow pattern
  microWaterNoiseScale: 5.0,        // duckweed and mud detail
  reedPatternNoiseScale: 25.0,      // reed patchiness
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units)
  lodHighDistance: 800.0,
  lodMidDistance: 4000.0,
  lodLowDistance: 20000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 0,
  maxErosionEventsPerTick: 1,       // low erosion, mostly organic accumulation
  maxGrowthEventsPerTick: 4,
  // ─── Peat growth parameters ────────────────────────────────
  peatGrowthMmPerYear: 1.0,
  methaneBubbleEmissionRate: 0.05  // bubbles per square metre per second
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Wetland suitability is dominated by water-table proximity: the water table
// must be at or near the surface for most of the year. Slope (flatness),
// humidity, and substrate organic content provide supporting weights.
// 328_BiomeBlendField uses this to decide how much of the wetland biome
// applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the wetland suitability at a world position and environmental state.
 * All inputs are expected to come from the context frame or from provider
 * summaries. The function allocates nothing after module initialisation.
 *
 * @param {object} env - Environmental sample.
 * @param {number} env.temperatureC - Air temperature in °C.
 * @param {number} env.humidity - Relative humidity 0..1.
 * @param {number} env.elevationM - Elevation in metres.
 * @param {number} env.slopeDeg - Slope angle in degrees.
 * @param {number} env.soilSand - Sand fraction 0..1.
 * @param {number} env.soilSilt - Silt fraction 0..1.
 * @param {number} env.soilClay - Clay fraction 0..1.
 * @param {number} env.waterTableDepthM - Depth to water table in metres.
 * @param {number} [env.noise] - Optional simplex noise sample for patchiness.
 * @returns {number} Suitability weight in [0, 1].
 */
function getSuitability(env) {
  // ─── Temperature: wetlands span a wide range but avoid extremes ─────
  const tempScore = smoothstep(-10.0, 5.0, env.temperatureC) * (1.0 - smoothstep(30.0, 42.0, env.temperatureC));

  // ─── Humidity: very humid from evapotranspiration ────────────────────
  const humidityScore = smoothstep(0.65, 0.90, env.humidity);

  // ─── Elevation: lowland only — wetlands do not form at altitude ──────
  const elevScore = 1.0 - smoothstep(200.0, 600.0, env.elevationM);

  // ─── Slope: wetlands require flat ground ─────────────────────────────
  const slopeScore = 1.0 - smoothstep(0.5, 4.0, env.slopeDeg);

  // ─── Substrate: silt and clay seal the basin; sand drains ────────────
  const textureScore =
    0.40 * smoothstep(0.15, 0.35, env.soilSilt) +
    0.35 * smoothstep(0.10, 0.30, env.soilClay) +
    0.25 * (1.0 - smoothstep(0.30, 0.60, env.soilSand));

  // ─── Water table: at or above the surface is the dominant signal ─────
  // waterTableDepthM can be negative (water above surface); clamp at 0.
  const waterScore = 1.0 - smoothstep(-0.5, 1.0, Math.max(0.0, env.waterTableDepthM));

  // ─── Patchiness: hummock-and-hollow microrelief breaks the field ─────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  // Water and slope dominate: wetlands need saturation and flatness.
  const raw =
    0.10 * tempScore +
    0.10 * humidityScore +
    0.08 * elevScore +
    0.20 * slopeScore +
    0.15 * textureScore +
    0.37 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const WetlandMarshSwampBiome = Object.freeze({
  // Identity
  id: BIOME_ID,
  bit: BIOME_BIT,
  name: BIOME_NAME,
  displayName: BIOME_DISPLAY_NAME,

  // Eleven descriptor blocks
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

  // Suitability
  getSuitability,

  // Registration hook — 327_BiomeRegistryBarrel calls this at construction.
  register(registry) {
    if (registry && typeof registry.registerBiome === 'function') {
      registry.registerBiome(BIOME_ID, BIOME_NAME, this);
    }
  }
});

export default WetlandMarshSwampBiome;