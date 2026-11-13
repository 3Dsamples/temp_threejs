// file number : 326_Z05
// full path name : src/context/326_Z05_MangroveCoastalBiome.js
// description : Mangrove / coastal wetland biome descriptor — the fifth and
// final of the additional biome presets. This preset covers tropical and
// subtropical intertidal forests, the halophytic (salt-tolerant) woody
// ecosystems that fringe sheltered coastlines, estuaries, and deltas between
// roughly 25° N and 25° S latitude. The defining drivers are tidal inundation
// (hydroperiod), saline to brackish porewater, anaerobic and sulphidic
// sediments, and a distinctive aerial-root architecture — pneumatophores,
// stilt roots, and knee roots — that lets the trees breathe and anchor in soft
// mud. Mangroves are among the most carbon-dense ecosystems on Earth and serve
// as critical nursery habitat for coastal fisheries. Provides the same eleven
// interlocking descriptor blocks as the base nine biomes, with full PBR + anime
// parameters for mangrove bark, pneumatophores, saline mud, brackish water,
// and the distinctive reddish tannin-stained water of mangrove creeks. The
// descriptor allocates nothing after construction and is consumed by the biome
// registry, blend field, material bridge, climate/soil/hydrology couplings,
// fauna migration system, chunk descriptor, and the full material/lighting/
// sensory pipeline.
//#
// best for : Every consumer that needs a mangrove, coastal wetland, or
// estuarine intertidal biome preset — biome registry barrel (327), biome blend
// field (328), biome blend system (329), cross-biome ecotone (330), biome
// material bridge (331), biome climate coupling (332), biome soil coupling
// (333), biome hydrology coupling (334), biome fauna migration (335), landscape
// chunk descriptor (336), and the whole material/lighting/sensory pipeline.
// Together with the other extended biome files this completes the planet-scale
// living-biome palette, and the mangrove preset is the one that must remain
// seamless from the open marine water of 325 through the intertidal mangrove
// fringe into the upland coastal forest.
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
const BIOME_ID = 14;
const BIOME_NAME = 'mangrove_coastal';
const BIOME_DISPLAY_NAME = 'Mangrove / Coastal';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── MANGROVE CHARACTERISTIC PARAMETERS ─────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Mangroves occupy the tropical and subtropical coastal belt where air
// temperature is the primary range-limiting factor[reference:0]. This block
// describes the local microclimate of the intertidal zone.
const CLIMATE = Object.freeze({
  // Temperature (°C) — tropical to subtropical coastal
  temperatureMin: 5.0,              // rare cold snap at latitudinal limits
  temperatureMax: 40.0,
  temperatureMean: 26.0,            // ≈ 28–32 °C water is optimal[reference:1]
  temperatureDailySwing: 8.0,       // moderated by the sea
  temperatureFrostFree: true,
  // Humidity (0..1) — high, coastal and humid
  humidityMin: 0.60,
  humidityMax: 1.00,
  humidityMean: 0.80,
  // Precipitation (mm/hr mean) — varies from arid to perhumid mangrove settings
  precipitationMean: 3.0,
  precipitationMax: 35.0,
  precipitationStormProb: 0.20,     // tropical storms and cyclones
  precipitationAnnualMm: 1500.0,    // subhumid to humid; arid mangroves override
  // Seasons — the tidal cycle is more important than the seasonal cycle
  seasonalityAmplitude: 0.35,
  drySeasonLengthDays: 60,
  wetSeasonPeakDay: 180,
  snowSeasonDays: 0,
  growingSeasonDays: 365,           // evergreen
  // Wind — moderate, but cyclone-exposed
  windMeanSpeed: 3.5,
  windMaxSpeed: 50.0,               // cyclone gusts
  windPredominantDirDeg: 90,        // trade-wind driven
  // Weather state probabilities (0..1)
  weatherProbClear: 0.35,
  weatherProbCloudy: 0.30,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.00,
  weatherProbFog: 0.05,
  // Atmospheric
  pressureMeanKPa: 101.3,
  pressureSwingKPa: 2.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Mangroves occupy the intertidal flat: very low relief, gentle seaward
// gradients, and a surface elevation that sits within the tidal frame.
// Accretion and erosion are continuous processes driven by tides and waves.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.INTERTIDAL,
  elevationMinM: -2.0,              // below mean sea level at the seaward fringe
  elevationMaxM: 3.0,               // highest spring-tide level at the landward fringe
  slopeMeanDeg: 0.2,                // nearly flat
  slopeMaxDeg: 2.0,
  roughness: 0.30,                  // hummocky from roots and crab burrows
  valleyDepth: 0.05,                // tidal creeks
  valleyDensity: 0.30,
  plateauBias: 0.90,
  groundwaterTableDepthM: -0.5,     // permanently saturated from tidal water
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.35,
  biomeHint: BIOME_HINT.MANGROVE,
  // ─── Intertidal elevation range ────────────────────────────
  // The vertical range over which mangroves can establish.
  tidalFrameMinM: -1.0,
  tidalFrameMaxM: 2.5
});

// ─── Soil ──────────────────────────────────────────────────────
// Mangrove soils are hydric, saline, anaerobic, and sulphidic. Below roughly
// 20 cm the sediment is anaerobic and sulphidic[reference:2]; redox potential
// can fall to −150 to −200 mV[reference:3], and sulphide concentrations can
// reach 0.5–6 mM in stressful settings. Porewater salinity
// varies widely, from a few PSU at freshwater-influenced sites to over 50 PSU
// in arid basin mangroves[reference:5].
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SILTY_CLAY,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.PEAT_BROWN,
  // Primary fractions (0..1) — fine-grained, organic-rich mud
  sand: 0.10,
  silt: 0.45,
  clay: 0.35,
  organicMatter: 0.10,
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry
  pH: 7.0,                          // neutral to slightly alkaline at the surface
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.25,
  // Physics
  porosity: 0.65,
  bulkDensityGcm3: 0.90,            // low, organic-rich, waterlogged
  waterHoldingCapacity: 0.80,       // saturated
  hydraulicConductivityMmHr: 0.05,  // very low
  cohesionKPa: 2.0,                 // soft, unstable mud
  plasticityIndex: 35.0,            // highly plastic
  // Colour (linear RGB) — dark grey-brown
  baseAlbedo: [0.12, 0.10, 0.08],
  organicDarkening: 0.50,
  ironOxideRedness: 0.10,
  calciumPale: 0.05,
  // Erosion
  usleKFactor: 0.05,                // protected by vegetation
  windErodibility: 0.00,            // always wet
  // ─── Anaerobic and sulphidic parameters ────────────────────
  redoxPotentialMv: -150.0,         // −150 to −200 mV[reference:6]
  sulfideConcentrationMm: 2.0,      // 0.5–6 mM range
  porewaterSalinityPsu: 30.0,       // wide range; 30 PSU is a representative mean
  // ─── Carbon storage ────────────────────────────────────────
  // Mangrove soils are among the most carbon-dense on Earth.
  soilCarbonStockMgPerHa: 400.0,    // "blue carbon" stock
  carbonAccretionRateGPerM2PerYear: 200.0
});

// ─── Vegetation ─────────────────────────────────────────────────
// Mangrove vegetation is a small set of halophytic tree genera that partition
// the intertidal zone by root type and salinity tolerance: Avicennia
// (pneumatophores) at the seaward and accreting fringe, Rhizophora (stilt
// roots) on eroding and creek-bank sites, and Bruguiera (knee roots) on more
// stable landward sites[reference:8]. Tree density can be very high; a mean
// of 4,700 living stems per hectare with a leaf area index near 4.95 has been
// reported for a South African estuary[reference:9], while some Okinawan stands
// reach 15,475 stems per hectare[reference:10].
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.MANGROVE]: 0.70,   // Rhizophora, Avicennia, Bruguiera complex
    [TREE_TYPE.PALM]: 0.15,       // Nypa palm in some Indo-Pacific settings
    [TREE_TYPE.CYPRESS]: 0.10,    // occasional landward freshwater influence
    [TREE_TYPE.WILLOW]: 0.05      // rare at the landward margin
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.MARSH_REED]: 0.70, // salt marsh at the landward fringe
    [GRASS_TYPE.MEADOW_GRASS]: 0.20,
    [GRASS_TYPE.FERN]: 0.10       // mangrove fern (Acrostichum)
  }),
  verticalLayers: 3,                // canopy, understorey, ground/root layer
  emergentDensity: 0.10,
  canopyDensity: 0.70,              // closed or semi-closed canopy
  understoryDensity: 0.30,
  groundCoverDensity: 0.40,         // pneumatophores and knee roots
  epiphyteDensity: 0.10,            // epiphytes on bark
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 0,               // fire is essentially absent in mangroves
  rootDepthM: 1.0,                  // shallow, but laterally extensive
  canopyRadiusM: 3.0,
  trunkHeightM: 6.0,                // 0.57–5.80 m reported for a South African stand[reference:11]
  leafLitterDepthM: 0.05,
  bloomWindowDays: 120,
  // Poisson-disc targets per hectare — calibrated from stem-density literature
  treeDensityPerHa: 2500,           // 1,005 to 15,475 stems/ha across sites
  shrubDensityPerHa: 200,
  groundCoverDensityPerHa: 4000,
  // ─── Aerial root architecture ─────────────────────────────
  // The three root types partition by elevation and substrate stability.
  pneumatophoreDensityPerM2: 80.0,  // pencil-shaped vertical roots
  stiltRootDensityPerM2: 5.0,       // arching prop roots
  kneeRootDensityPerM2: 3.0,        // looping knee roots
  // Aboveground pneumatophore biomass can exceed 1,500 g m⁻²[reference:12]
  pneumatophoreBiomassGPerM2: 1500.0,
  // Leaf area index from field studies: 3.96–5.70[reference:13]
  leafAreaIndex: 4.95
});

// ─── Fauna ──────────────────────────────────────────────────────
// Mangrove fauna is a distinctive mix of marine, terrestrial, and amphibious
// species: crabs (the dominant invertebrate grazers), mudskippers, mangrove
// snails, shrimp, juvenile fish (the nursery function), crocodiles, and
// coastal birds.
const FAUNA = Object.freeze({
  densityWeight: 0.85,              // high density of invertebrates and juveniles
  habitatLayers: Object.freeze({
    ground: 0.40,                   // crabs, snails, mudskippers
    rootZone: 0.30,                 // root-fouling fauna, juvenile fish
    canopy: 0.15,                   // birds, arboreal crabs
    aerial: 0.10,
    waterColumn: 0.05
  }),
  dielActivity: 0.35,               // tidal rather than diel rhythms dominate
  migrationCorridorWeight: 0.50,    // fish and bird migrations use mangrove nurseries
  predatorPreyBalance: 0.55,
  nectarAvailability: 0.05,
  pollenAvailability: 0.05,
  // Characteristic guild weights
  crabWeight: 0.30,                 // keystone ecosystem engineers
  fishNurseryWeight: 0.25,          // juvenile fish
  molluskWeight: 0.15,
  birdWeight: 0.15,
  amphibiousVertebrateWeight: 0.10, // mudskippers, crocodiles
  insectWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for mangrove surfaces: bark, pneumatophores,
// saline mud, brackish water, and the reddish tannin-stained water of
// mangrove creeks. Mangrove bark is typically grey-brown and moderately
// rough; pneumatophores are lighter, corky, and more porous.
const MATERIALS = Object.freeze({
  // ─── Mangrove bark (Rhizophora / Avicennia) ────────────────
  mangroveBark: Object.freeze({
    albedo: [0.18, 0.15, 0.12],     // grey-brown
    roughness: 0.88,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.70,           // frequently inundated
    animeFlatness: 0.35,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.45,             // moist bark is not highly flammable
    hardness: 0.65,
    brittleness: 0.40
  }),
  // ─── Pneumatophore (aerial root) ───────────────────────────
  pneumatophore: Object.freeze({
    albedo: [0.28, 0.24, 0.20],     // lighter, corky
    roughness: 0.82,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,                // porous, slightly translucent when wet
    emissive: 0.0,
    wetnessResponse: 0.90,
    animeFlatness: 0.30,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.30,
    hardness: 0.25,
    brittleness: 0.70
  }),
  // ─── Saline mud ─────────────────────────────────────────────
  salineMud: Object.freeze({
    albedo: [0.14, 0.12, 0.10],     // dark grey-brown
    roughness: 0.85,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 1.0,            // permanently saturated
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.05,
    brittleness: 0.95
  }),
  // ─── Brackish water (creek and pool) ────────────────────────
  brackishWater: Object.freeze({
    albedo: [0.10, 0.12, 0.08],     // greenish-brown from CDOM and algae
    roughness: 0.10,
    metalness: 0.0,
    transmission: 0.65,
    ior: 1.340,                      // slightly higher than freshwater due to salinity
    fresnelF0: 0.02,
    subsurface: 0.15,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.WATER,
    flammability: 0.0,
    hardness: 0.0,
    brittleness: 1.0,
    // ─── Beer–Lambert absorption (CDOM-dominated) ──────────
    // CDOM is the dominant light-attenuating component in mangrove waters;
    // attenuation rates range from 0.16 to 9.83 m⁻¹ with a mean of 1.73 m⁻¹
    // [reference:14].
    attenuationKd: Object.freeze({
      red: 1.20,                    // tannins and CDOM absorb strongly in red
      green: 0.60,
      blue: 0.35
    }),
    // ─── Tannin staining ──────────────────────────────────────
    tanninColor: [0.25, 0.15, 0.08] // reddish-brown
  }),
  // ─── Tannin-stained creek water ────────────────────────────
  tanninWater: Object.freeze({
    albedo: [0.18, 0.10, 0.05],     // reddish-brown
    roughness: 0.08,
    metalness: 0.0,
    transmission: 0.70,
    ior: 1.335,
    fresnelF0: 0.02,
    subsurface: 0.10,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.WATER,
    flammability: 0.0,
    hardness: 0.0,
    brittleness: 1.0,
    attenuationKd: Object.freeze({
      red: 1.50,                    // very strong red absorption
      green: 0.70,
      blue: 0.40
    })
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Mangrove lighting is shaped by the open canopy, the high humidity of the
// coastal atmosphere, and the strong light attenuation of the tannin-stained
// water below the canopy. The canopy itself is dense enough to create
// substantial shade on the forest floor.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.55,            // dense canopy blocks much of the light
  sunDiffuseFraction: 0.45,         // humid maritime atmosphere
  sunIntensityScale: 1.15,
  colourCast: [0.98, 0.96, 0.90],   // warm tropical light
  atmosphericScatterBoost: 1.15,
  bioluminescentEmission: 0.05,     // fireflies and bioluminescent plankton
  dappledLightFrequency: 0.30,
  dappledLightAmplitude: 0.25,
  shadowSoftnessNear: 0.4,
  shadowSoftnessMid: 0.6,
  shadowSoftnessFar: 0.8,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.012,            // coastal humidity and haze
  skyTint: [0.88, 0.92, 0.96],
  // ─── Water-column attenuation (CDOM-dominated) ──────────────
  // Same K_d channels as the brackish water material; the lighting provider
  // uses these to compute underwater irradiance.
  attenuationKd: Object.freeze({
    red: 1.20,
    green: 0.60,
    blue: 0.35
  }),
  // ─── Canopy gap fraction ──────────────────────────────────
  canopyGapFraction: 0.45
});

// ─── Water ──────────────────────────────────────────────────────
// Mangrove hydrology is tidal: the forest is flooded and drained by the tide,
// and the hydroperiod — the frequency and duration of inundation — is the
// master variable. Mangroves are inundated roughly 15–70 % of the time and
// 0.9–2 times per day[reference:15]. Porewater salinity ranges widely, from a
// few PSU at freshwater-influenced sites to over 50 PSU in arid basins
// [reference:16].
const WATER = Object.freeze({
  surfaceWaterPresence: 0.70,       // much of the forest is flooded at high tide
  riverineNetworkDensity: 0.40,     // tidal creeks are the circulatory system
  canopyDrip: 0.10,
  groundwaterTableDepthM: -0.5,     // at or above the surface
  freshwaterSpringPresence: 0.10,
  waterTableDepthM: -0.5,
  bogCoverage: 0.00,
  lakeCoverage: 0.05,               // mangrove lakes and lagoons
  riverWidthMeanM: 5.0,             // tidal creeks
  waterTemperatureC: 26.0,
  iceCoverMonths: 0,
  shorelineMaterial: 'salineMud',
  // ─── Tidal parameters ─────────────────────────────────────
  tidalRangeM: 2.0,                 // mesotidal; microtidal and macrotidal variants exist
  tidalPeriodHours: 12.42,          // semidiurnal M2 constituent
  inundationFrequencyPerDay: 1.5,   // 0.9–2 tides per day[reference:17]
  inundationDurationFraction: 0.40, // 15–70 % of the time[reference:18]
  // ─── Salinity ─────────────────────────────────────────────
  porewaterSalinityPsu: 30.0,       // wide range; 30 PSU is representative
  surfaceWaterSalinityPsu: 28.0,
  hypersalinityThresholdPsu: 50.0,  // arid basin mangroves can exceed this
  // ─── Water quality ────────────────────────────────────────
  turbidityNTU: 15.0,               // high turbidity is common and often needed
  cdomAbsorption: 1.20,             // strong CDOM absorption in the red
  dissolvedOxygenMgL: 4.0,          // low in stagnant creek water
  // ─── Light attenuation ────────────────────────────────────
  // Mean K_d in mangrove lakes: 1.73 m⁻¹[reference:20]
  meanAttenuationKdMPerM: 1.73,
  attenuationRangeMinMPerM: 0.16,
  attenuationRangeMaxMPerM: 9.83
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.35,               // crabs, insects, birds, frogs
    geological: 0.00,
    water: 0.30,                    // tidal flow, dripping
    wind: 0.15,                     // muted by canopy
    vegetation: 0.20,               // leaf rustle
    mechanical: 0.00
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.05,
    earthy: 0.20,
    aquatic: 0.25,                  // brackish and tannin-stained water
    woodland: 0.05,
    smoke: 0.00,
    animal: 0.10,
    decay: 0.15,                    // anaerobic decomposition
    sulfur: 0.15,                   // hydrogen sulfide from sulphidic mud
    sea: 0.05,
    clean: 0.00
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: 28.0,
    humidity: 0.85,
    windPressurePa: 2.0,
    precipitationType: 'rain',
    groundHardness: 0.03           // soft, waterlogged mud
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Mangroves are evergreen; the seasonal signal is much weaker than in
// temperate or dry-tropical biomes. Phenology is driven by rainfall and
// temperature rather than a pronounced dormant season.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 300,      // essentially evergreen
    autumnColourShiftDays: 15,
    leafDropDurationDays: 15,
    bloomWindowDays: 120,
    sporeBoostWetSeason: 0.30,
    fungalBoostWetSeason: 0.20
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      mangroveBark: { albedo: [0.18, 0.15, 0.12], roughness: 0.88 },
      salineMud: { albedo: [0.14, 0.12, 0.10], wetnessResponse: 1.0 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      mangroveBark: { albedo: [0.18, 0.15, 0.12], roughness: 0.88 },
      brackishWater: { albedo: [0.10, 0.12, 0.08], roughness: 0.10 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      mangroveBark: { albedo: [0.18, 0.15, 0.12], roughness: 0.88 },
      pneumatophore: { albedo: [0.28, 0.24, 0.20], roughness: 0.82 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      mangroveBark: { albedo: [0.18, 0.15, 0.12], roughness: 0.88 },
      tanninWater: { albedo: [0.18, 0.10, 0.05], roughness: 0.08 }
    })
  }),
  snowAccumulationRateMmHr: 0.0,
  snowMeltRateMmHr: 0.0,
  snowAlbedoSeasonal: 0.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  // Noise scales (world units) for root architecture and creek patterning
  macroCreekNoiseScale: 200.0,      // tidal creek network
  midRootNoiseScale: 30.0,          // root clump distribution
  microRootNoiseScale: 3.0,         // individual pneumatophore detail
  mudCrackNoiseScale: 10.0,         // desiccation crack patterns
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units)
  lodHighDistance: 600.0,           // dense root detail only up close
  lodMidDistance: 3000.0,
  lodLowDistance: 15000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 0,          // fire is essentially absent
  maxErosionEventsPerTick: 3,       // tidal creek migration and bank erosion
  maxGrowthEventsPerTick: 4,
  // ─── Tidal creek migration ─────────────────────────────────
  creekMigrationRateMPerYear: 2.0,
  // ─── Sediment accretion ────────────────────────────────────
  accretionRateMmPerYear: 5.0      // keeps pace with sea-level rise in healthy systems
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Mangrove suitability is dominated by tidal position (intertidal elevation),
// salinity, and warm temperatures. The forest requires a sheltered coastal
// setting with a soft substrate. 328_BiomeBlendField uses this to decide how
// much of the mangrove biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the mangrove suitability at a world position and environmental
 * state. All inputs are expected to come from the context frame or from
 * provider summaries. The function allocates nothing after module
 * initialisation.
 *
 * @param {object} env - Environmental sample.
 * @param {number} env.temperatureC - Air temperature in °C.
 * @param {number} env.humidity - Relative humidity 0..1.
 * @param {number} env.elevationM - Elevation in metres (relative to mean sea level).
 * @param {number} env.slopeDeg - Slope angle in degrees.
 * @param {number} env.soilSand - Sand fraction 0..1.
 * @param {number} env.soilSilt - Silt fraction 0..1.
 * @param {number} env.soilClay - Clay fraction 0..1.
 * @param {number} env.waterTableDepthM - Depth to water table in metres.
 * @param {number} [env.noise] - Optional simplex noise sample for patchiness.
 * @returns {number} Suitability weight in [0, 1].
 */
function getSuitability(env) {
  // ─── Temperature: warm, tropical to subtropical ─────────────────────
  const tempScore = smoothstep(10.0, 20.0, env.temperatureC) * (1.0 - smoothstep(35.0, 42.0, env.temperatureC));

  // ─── Humidity: coastal humidity is high ─────────────────────────────
  const humidityScore = smoothstep(0.60, 0.80, env.humidity);

  // ─── Elevation: intertidal position is the master variable ──────────
  // Mangroves occupy a narrow vertical band around mean sea level.
  const elevScore = smoothstep(-2.0, 0.0, env.elevationM) * (1.0 - smoothstep(1.5, 3.0, env.elevationM));

  // ─── Slope: the intertidal flat must be nearly flat ─────────────────
  const slopeScore = 1.0 - smoothstep(0.5, 3.0, env.slopeDeg);

  // ─── Substrate: fine-grained mud is required ───────────────────────
  const textureScore =
    0.45 * smoothstep(0.30, 0.50, env.soilSilt) +
    0.35 * smoothstep(0.20, 0.40, env.soilClay) +
    0.20 * (1.0 - smoothstep(0.20, 0.45, env.soilSand));

  // ─── Water table: permanently saturated from tidal water ────────────
  const waterScore = 1.0 - smoothstep(-0.5, 1.0, Math.max(0.0, env.waterTableDepthM));

  // ─── Patchiness: creek network and root zonation break the field ───
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  // Elevation and slope dominate: mangroves exist only in the intertidal frame.
  const raw =
    0.15 * tempScore +
    0.08 * humidityScore +
    0.30 * elevScore +
    0.15 * slopeScore +
    0.15 * textureScore +
    0.17 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const MangroveCoastalBiome = Object.freeze({
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

export default MangroveCoastalBiome;