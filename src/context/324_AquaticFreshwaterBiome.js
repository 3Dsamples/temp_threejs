// file number : 324
// full path name : src/context/324_AquaticFreshwaterBiome.js
// description : Aquatic freshwater biome descriptor — the seventh of the nine
// biome presets, tuned for rivers, lakes, ponds, and wetlands. Freshwater
// systems are defined by flow (lotic rivers vs. lentic lakes), depth-graded
// light attenuation (Beer–Lambert), thermal stratification (epilimnion /
// thermocline / hypolimnion), dissolved-oxygen profiles, and a riparian-to-
// submerged vegetation gradient. This descriptor provides the same eleven
// interlocking blocks as 318–323, but every parameter is recalibrated for
// freshwater's constraints: high specific heat (slow temperature change),
// density anomaly at 4 °C (ice floats), and an optical medium whose
// attenuation coefficient varies with dissolved organic matter and turbidity.
// Materials and lighting expose full PBR + anime parameters for water
// surfaces, wet substrates, and aquatic vegetation, including Gerstner-wave
// parameters, Fresnel F₀, and a depth-dependent colour ramp. The descriptor
// allocates nothing after construction and is consumed by the biome registry,
// blend field, material bridge, hydrology coupling, fauna spawner, chunk
// descriptor, and the full material/lighting/sensory pipeline.
// best for : Every consumer that needs a freshwater aquatic biome preset —
// biome registry barrel (327), biome blend field (328), biome blend system
// (329), cross-biome ecotone (330), biome material bridge (331), biome climate
// coupling (332), biome soil coupling (333), biome hydrology coupling (334),
// biome fauna migration (335), landscape chunk descriptor (336), and the whole
// material/lighting/sensory pipeline. Together with the other eight biome files
// this completes the planet-scale living-biome palette.
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
const BIOME_ID = 7;
const BIOME_NAME = 'aquatic_freshwater';
const BIOME_DISPLAY_NAME = 'Aquatic / Freshwater';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── FRESHWATER CHARACTERISTIC PARAMETERS ───────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Freshwater systems occur across all climate zones; this block describes
// the water body's own thermal environment rather than the air above it.
const CLIMATE = Object.freeze({
  // Water temperature (°C) — moderated by high specific heat
  temperatureMin: 0.0,              // ice-covered surface
  temperatureMax: 30.0,
  temperatureMean: 14.0,
  temperatureDailySwing: 2.0,       // water moderates diurnal swing
  temperatureFrostFree: false,      // surface freezes at 0 °C
  // Humidity (0..1) — water body raises local humidity
  humidityMin: 0.60,
  humidityMax: 1.00,
  humidityMean: 0.80,
  // Precipitation (mm/hr mean) — input to the system, not a climate driver
  precipitationMean: 2.0,
  precipitationMax: 30.0,
  precipitationStormProb: 0.15,
  precipitationAnnualMm: 900.0,
  // Seasons — thermal stratification cycle rather than moisture cycle
  seasonalityAmplitude: 0.50,
  drySeasonLengthDays: 0,
  wetSeasonPeakDay: 120,
  snowSeasonDays: 60,               // ice cover duration at temperate latitudes
  growingSeasonDays: 180,
  // Wind — drives surface waves and mixing
  windMeanSpeed: 3.0,
  windMaxSpeed: 25.0,
  windPredominantDirDeg: 270,       // westerly in temperate zones
  // Weather state probabilities (0..1) — inherited from surrounding biome
  weatherProbClear: 0.35,
  weatherProbCloudy: 0.30,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.10,
  weatherProbSnow: 0.05,
  weatherProbFog: 0.00,
  // Atmospheric
  pressureMeanKPa: 101.3,
  pressureSwingKPa: 2.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Freshwater bodies occupy depressions: lake basins, river valleys, and
// floodplains. Elevation range spans lowland to alpine.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.LOWLAND,
  elevationMinM: 0.0,
  elevationMaxM: 2000.0,
  slopeMeanDeg: 1.0,                // lake floors and river beds are gentle
  slopeMaxDeg: 15.0,
  roughness: 0.25,                  // smooth basins and beds
  valleyDepth: 0.50,                // defined valleys for rivers
  valleyDensity: 0.60,
  plateauBias: 0.40,
  groundwaterTableDepthM: 0.0,      // water body is the water table surface
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.20,
  biomeHint: BIOME_HINT.WATER
});

// ─── Soil ──────────────────────────────────────────────────────
// Freshwater substrates are saturated sediments: mud, silt, sand, and
// organic-rich lake beds. The soil here describes the benthic substrate.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SILT_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.PEAT_BROWN,
  // Primary fractions (0..1) — benthic sediment
  sand: 0.25,
  silt: 0.40,
  clay: 0.15,
  organicMatter: 0.20,              // high organic content in lake beds
  gravel: 0.00,
  rockFragment: 0.00,
  // Chemistry
  pH: 6.8,
  fertilityClass: FERTILITY_CLASS.MODERATE,
  fertilityIndex: 0.55,
  // Physics
  porosity: 0.55,
  bulkDensityGcm3: 1.05,
  waterHoldingCapacity: 0.60,       // fully saturated
  hydraulicConductivityMmHr: 0.2,
  cohesionKPa: 3.0,
  plasticityIndex: 20.0,
  // Colour (linear RGB) — dark organic-rich mud
  baseAlbedo: [0.12, 0.10, 0.08],
  organicDarkening: 0.70,
  ironOxideRedness: 0.05,
  calciumPale: 0.10,
  // Erosion
  usleKFactor: 0.10,                // submerged sediment is not rain-eroded
  windErodibility: 0.00
});

// ─── Vegetation ─────────────────────────────────────────────────
// Freshwater vegetation is zoned by depth and flow: riparian trees and reeds
// at the margin, emergent and floating-leaved plants in the shallows, and
// submerged macrophytes and algae in deeper water.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.WILLOW]: 0.45,     // riparian
    [TREE_TYPE.CYPRESS]: 0.25,    // floodplain and swamp
    [TREE_TYPE.MANGROVE]: 0.20,   // brackish margins
    [TREE_TYPE.OAK]: 0.10
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.MARSH_REED]: 0.65, // dominant emergent
    [GRASS_TYPE.MEADOW_GRASS]: 0.20,
    [GRASS_TYPE.FERN]: 0.10,
    [GRASS_TYPE.SHORT_PRAIRIE]: 0.05
  }),
  verticalLayers: 4,                // riparian > emergent > floating > submerged
  emergentDensity: 0.30,
  canopyDensity: 0.30,              // riparian canopy only
  understoryDensity: 0.20,
  groundCoverDensity: 0.15,         // submerged macrophyte cover
  epiphyteDensity: 0.10,            // periphyton on stems
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 200,             // fire is rare in wetlands
  rootDepthM: 1.0,
  canopyRadiusM: 4.0,
  trunkHeightM: 8.0,
  leafLitterDepthM: 0.05,
  bloomWindowDays: 120,             // extended growing season
  // Poisson-disc targets per hectare — for riparian and emergent zones
  treeDensityPerHa: 200,
  shrubDensityPerHa: 500,
  groundCoverDensityPerHa: 8000
});

// ─── Fauna ──────────────────────────────────────────────────────
// Freshwater fauna spans fish, amphibians, aquatic insects, waterfowl, and
// semi-aquatic mammals.
const FAUNA = Object.freeze({
  densityWeight: 0.70,              // high biomass per unit area
  habitatLayers: Object.freeze({
    benthic: 0.35,                  // bottom-dwelling invertebrates and fish
    waterColumn: 0.40,              // mid-water fish and plankton
    surface: 0.15,                  // waterfowl, amphibians at surface
    riparian: 0.10                  // semi-aquatic mammals and birds
  }),
  dielActivity: 0.45,               // mixed; many freshwater species are crepuscular
  migrationCorridorWeight: 0.70,    // strong (fish runs, waterfowl migration)
  predatorPreyBalance: 0.55,
  nectarAvailability: 0.05,
  pollenAvailability: 0.05,
  // Characteristic guild weights
  fishWeight: 0.40,
  amphibianWeight: 0.15,
  aquaticInvertebrateWeight: 0.25,
  waterfowlWeight: 0.15,
  semiAquaticMammalWeight: 0.05
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for freshwater surfaces. The water surface is
// the defining material: low roughness at grazing angles, Fresnel F₀ ≈ 0.02,
// depth-dependent colour absorption (Beer–Lambert), and Gerstner-wave vertex
// displacement parameters.
const MATERIALS = Object.freeze({
  // ─── Water surface (open water) ─────────────────────────────
  waterSurface: Object.freeze({
    albedo: [0.05, 0.12, 0.15],     // deep-water base colour
    roughness: 0.08,                 // smooth at grazing angles
    metalness: 0.0,
    transmission: 0.85,              // mostly transparent
    ior: 1.333,                      // refractive index of water
    fresnelF0: 0.02,                 // Schlick F₀ for water–air interface
    subsurface: 0.30,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.WATER,
    flammability: 0.0,
    hardness: 0.0,
    brittleness: 1.0,
    // ─── Gerstner-wave parameters ──────────────────────────────
    gerstnerWaves: Object.freeze({
      amplitude: 0.12,              // calm freshwater, not ocean swell
      wavelength: 6.0,
      steepness: 0.35,
      speed: 1.2,
      directionDeg: 270,
      // Deep-water dispersion: ω = √(g·k) with g = 9.81 m/s²
      gravity: 9.81
    }),
    // ─── Beer–Lambert absorption ──────────────────────────────
    // I_z = I₀ · exp(−K_d · z), K_d in m⁻¹
    attenuationKd: Object.freeze({
      red: 0.65,                    // red absorbed fastest
      green: 0.25,
      blue: 0.12                    // blue penetrates deepest
    }),
    // ─── Depth colour ramp ────────────────────────────────────
    shallowColor: [0.18, 0.35, 0.32],  // greenish-turquoise shallows
    deepColor: [0.02, 0.06, 0.12]      // dark blue depths
  }),
  // ─── Wet mud / benthic sediment ─────────────────────────────
  wetMud: Object.freeze({
    albedo: [0.10, 0.09, 0.07],
    roughness: 0.75,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 1.0,             // permanently saturated
    animeFlatness: 0.40,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.05,
    brittleness: 0.90
  }),
  // ─── Submerged macrophyte / algae ───────────────────────────
  submergedVegetation: Object.freeze({
    albedo: [0.08, 0.18, 0.10],
    roughness: 0.82,
    metalness: 0.0,
    transmission: 0.15,               // slight translucency
    subsurface: 0.20,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.0,
    hardness: 0.10,
    brittleness: 0.85
  }),
  // ─── Emergent reed / marsh grass ────────────────────────────
  emergentReed: Object.freeze({
    albedo: [0.25, 0.22, 0.10],
    roughness: 0.78,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.05,
    emissive: 0.0,
    wetnessResponse: 0.80,
    animeFlatness: 0.20,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.55,
    hardness: 0.25,
    brittleness: 0.65
  }),
  // ─── Riparian bark / willow / cypress ───────────────────────
  riparianBark: Object.freeze({
    albedo: [0.18, 0.14, 0.10],
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 0.60,
    animeFlatness: 0.35,
    acousticProfile: ACOUSTIC_PROFILE.WOOD,
    flammability: 0.50,
    hardness: 0.70,
    brittleness: 0.35
  }),
  // ─── Ice (seasonal) ────────────────────────────────────────
  ice: Object.freeze({
    albedo: [0.80, 0.88, 0.92],
    roughness: 0.15,
    metalness: 0.0,
    transmission: 0.60,
    ior: 1.31,
    fresnelF0: 0.018,
    subsurface: 0.40,
    emissive: 0.0,
    wetnessResponse: 0.20,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.SOFT,
    flammability: 0.0,
    hardness: 0.40,
    brittleness: 0.60
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Freshwater lighting is shaped by the water column: strong absorption of red,
// scattering of blue-green, specular sun glints, and depth-dependent dimming.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.10,            // minimal, except under riparian canopy
  sunDiffuseFraction: 0.40,         // sky + water scattering
  sunIntensityScale: 1.0,
  colourCast: [0.90, 0.96, 1.00],   // cool blue-green cast from water
  atmosphericScatterBoost: 1.10,
  bioluminescentEmission: 0.05,     // some freshwater plankton and fireflies
  dappledLightFrequency: 0.25,      // light caustics on the bottom
  dappledLightAmplitude: 0.30,
  shadowSoftnessNear: 0.4,
  shadowSoftnessMid: 0.6,
  shadowSoftnessFar: 0.8,
  shadowCascadeScale: 0.9,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.008,
  skyTint: [0.88, 0.94, 1.00],
  // ─── Water-column light attenuation (Beer–Lambert) ─────────
  // Same K_d channels as the water material; duplicated here so the lighting
  // provider can compute irradiance without reading the material registry.
  attenuationKd: Object.freeze({
    red: 0.65,
    green: 0.25,
    blue: 0.12
  }),
  // ─── Caustics parameters ───────────────────────────────────
  causticIntensity: 0.35,
  causticScale: 0.40,
  causticSpeed: 0.60
});

// ─── Water ──────────────────────────────────────────────────────
// This block describes the water body itself: morphometry, flow regime,
// thermal structure, dissolved oxygen, and optical properties.
const WATER = Object.freeze({
  // ─── Morphometry ───────────────────────────────────────────
  maxDepthM: 40.0,                  // mesotrophic lake
  meanDepthM: 8.0,
  surfaceAreaKm2: 2.0,
  shorelineLengthKm: 8.0,
  shorelineDevelopmentIndex: 1.6,   // moderately irregular
  // ─── Flow regime ───────────────────────────────────────────
  // lotic (flowing) or lentic (still)
  flowRegime: 'lentic',             // rivers override this to 'lotic'
  manningN: 0.035,                  // channel roughness for rivers
  bedSlope: 0.002,                  // m/m for rivers
  meanVelocityMs: 0.0,              // lakes are still; rivers set this
  dischargeM3s: 0.0,                // rivers only
  // ─── Thermal stratification ────────────────────────────────
  // Three layers: epilimnion (warm surface), metalimnion/thermocline
  // (rapid temperature drop), hypolimnion (cold bottom).
  stratificationPresent: true,
  epilimnionDepthM: 5.0,
  thermoclineDepthM: 8.0,
  thermoclineThicknessM: 2.0,
  hypolimnionDepthM: 12.0,
  temperatureGradientCPerM: 1.5,    // ≥ 1 °C/m defines the thermocline
  // ─── Dissolved oxygen ──────────────────────────────────────
  // Saturation: C_s = 14.652 − 0.41022·T + 0.007991·T² − 0.000077774·T³
  // for fresh water at 1 atm (Elmore & Hayes, 1960).
  doSaturationMgL: 9.0,             // at 15 °C
  doSurfaceMgL: 8.5,
  doHypolimnionMgL: 4.0,            // oxygen depleted below thermocline
  doAnoxiaThresholdMgL: 2.0,        // below this, anaerobic processes dominate
  // ─── Optical properties ────────────────────────────────────
  // K_d varies with dissolved organic matter (CDOM), chlorophyll, and turbidity.
  turbidityNTU: 5.0,
  cdomAbsorption: 0.3,              // colour dissolved organic matter
  chlorophyllMgL: 4.0,             // phytoplankton concentration
  secchiDepthM: 4.0,                // clarity index
  // ─── Seasonal ice ──────────────────────────────────────────
  iceCoverMonths: 2,
  iceThicknessM: 0.3,
  // ─── Water colour ──────────────────────────────────────────
  baseColor: [0.12, 0.20, 0.18],   // greenish-brown freshwater
  shallowColor: [0.18, 0.35, 0.32],
  deepColor: [0.02, 0.06, 0.12]
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.25,               // frogs, birds, insects
    geological: 0.00,
    water: 0.55,                    // flowing water, lapping waves dominate
    wind: 0.10,                     // wind-driven ripples
    vegetation: 0.10,               // reed rustle
    mechanical: 0.00
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.10,
    earthy: 0.20,
    aquatic: 0.40,                  // characteristic freshwater smell
    woodland: 0.05,
    smoke: 0.00,
    animal: 0.05,
    decay: 0.10,                    // anoxic sediments
    sulfur: 0.00,
    sea: 0.00,
    clean: 0.10
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: 14.0,
    humidity: 0.85,
    windPressurePa: 2.0,
    precipitationType: 'rain',
    groundHardness: 0.05           // soft, saturated sediment
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Freshwater phenology is driven by the thermal cycle: spring and autumn
// turnover (mixing), summer stratification, and winter ice cover.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 150,
    autumnColourShiftDays: 30,
    leafDropDurationDays: 20,
    bloomWindowDays: 100,
    sporeBoostWetSeason: 0.20,
    fungalBoostWetSeason: 0.15
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      emergentReed: { albedo: [0.28, 0.30, 0.12], roughness: 0.75 },
      waterSurface: { albedo: [0.08, 0.16, 0.18], roughness: 0.10 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      emergentReed: { albedo: [0.25, 0.22, 0.10], roughness: 0.78 },
      waterSurface: { albedo: [0.05, 0.12, 0.15], roughness: 0.08 },
      submergedVegetation: { albedo: [0.08, 0.18, 0.10], roughness: 0.82 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      emergentReed: { albedo: [0.35, 0.25, 0.10], roughness: 0.80 },
      waterSurface: { albedo: [0.06, 0.10, 0.12], roughness: 0.10 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      emergentReed: { albedo: [0.30, 0.28, 0.18], roughness: 0.82 },
      waterSurface: { albedo: [0.70, 0.78, 0.82], roughness: 0.12, transmission: 0.30 },
      ice: { albedo: [0.80, 0.88, 0.92], roughness: 0.15 }
    })
  }),
  snowAccumulationRateMmHr: 0.5,
  snowMeltRateMmHr: 2.0,
  snowAlbedoSeasonal: 0.85
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  // Noise scales (world units) for surface and benthic detail
  macroWaterNoiseScale: 200.0,      // large-scale surface patterns
  midWaterNoiseScale: 40.0,         // wave detail
  microWaterNoiseScale: 8.0,        // ripple and caustic scale
  shorelineNoiseScale: 30.0,        // shoreline irregularity
  benthicNoiseScale: 15.0,
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units) — water needs long view distances
  lodHighDistance: 1000.0,
  lodMidDistance: 5000.0,
  lodLowDistance: 25000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 0,
  maxErosionEventsPerTick: 2,       // shoreline erosion and sediment transport
  maxGrowthEventsPerTick: 4
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Freshwater suitability is primarily driven by water-table proximity, basin
// depth, and substrate saturation. Temperature and humidity play supporting
// roles. 328_BiomeBlendField uses this to decide how much of the freshwater
// biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the freshwater suitability at a world position and environmental
 * state. All inputs are expected to come from the context frame or from
 * provider summaries. The function allocates nothing after module
 * initialisation.
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
  // ─── Temperature: freshwater spans a wide range but is moderated by water ─
  const tempScore = smoothstep(0.0, 10.0, env.temperatureC) * (1.0 - smoothstep(28.0, 40.0, env.temperatureC));

  // ─── Humidity: water bodies raise local humidity ────────────────────────
  const humidityScore = smoothstep(0.50, 0.80, env.humidity);

  // ─── Elevation: lowland to mid-elevation; high alpine tarns are marginal ─
  const elevScore = smoothstep(0.0, 200.0, env.elevationM) * (1.0 - smoothstep(1800.0, 3000.0, env.elevationM));

  // ─── Slope: water occupies depressions; steep slopes drain ─────────────
  const slopeScore = 1.0 - smoothstep(2.0, 12.0, env.slopeDeg);

  // ─── Soil texture: silt and organic matter seal the basin ──────────────
  const textureScore =
    0.40 * smoothstep(0.25, 0.50, env.soilSilt) +
    0.30 * smoothstep(0.10, 0.30, env.soilClay) +
    0.30 * (1.0 - smoothstep(0.40, 0.70, env.soilSand));

  // ─── Water table: at or near the surface is the strongest signal ───────
  const waterScore = 1.0 - smoothstep(0.0, 1.5, env.waterTableDepthM);

  // ─── Patchiness: shoreline irregularity breaks the field ───────────────
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  const raw =
    0.15 * tempScore +
    0.10 * humidityScore +
    0.10 * elevScore +
    0.10 * slopeScore +
    0.15 * textureScore +
    0.40 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const AquaticFreshwaterBiome = Object.freeze({
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

export default AquaticFreshwaterBiome;