// file number : 325
// full path name : src/context/325_AquaticMarineBiome.js
// description : Marine aquatic biome descriptor — the eighth of the nine
// biome presets, tuned for oceans and seas across all latitudes. Marine systems
// are defined by salinity-driven density and freezing-point depression, a
// three-layer thermal structure (mixed layer / thermocline / deep zone), tidal
// forcing, and a depth-graded light field that follows the Jerlov optical water
// classification. This descriptor provides the same eleven interlocking blocks
// as 318–324, but every parameter is recalibrated for seawater's constraints:
// mean salinity ≈ 35 PSU, density ≈ 1025 kg/m³ at the surface, a freezing point
// depressed to ≈ −1.8 °C, and a light attenuation in clear open-ocean water
// that lets blue-green penetrate to ≈ 150–200 m while red is absorbed within the
// first 10–20 m. Materials and lighting expose full PBR + anime parameters for
// the ocean surface, including Fresnel F₀ ≈ 0.02 for the water–air interface
// (IOR 1.333), a Gerstner-wave spectrum with deep-water dispersion ω = √(g·k),
// Beer–Lambert attenuation per RGB channel, and a depth-graded colour ramp from
// turquoise shelf water through blue open-ocean to near-black abyssal water. The
// descriptor allocates nothing after construction and is consumed by the biome
// registry, blend field, material bridge, hydrology coupling, fauna spawner,
// chunk descriptor, and the full material/lighting/sensory pipeline.
// best for : Every consumer that needs a marine or oceanic biome preset — biome
// registry barrel (327), biome blend field (328), biome blend system (329),
// cross-biome ecotone (330), biome material bridge (331), biome climate coupling
// (332), biome soil coupling (333), biome hydrology coupling (334), biome fauna
// migration (335), landscape chunk descriptor (336), and the whole material/
// lighting/sensory pipeline. Together with the other eight biome files this
// completes the planet-scale living-biome palette, and the marine preset is the
// one that must remain seamless from coastal shallows out to abyssal plains and
// from the surface down to the trench floor.
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
const BIOME_ID = 8;
const BIOME_NAME = 'aquatic_marine';
const BIOME_DISPLAY_NAME = 'Aquatic / Marine';
const BIOME_BIT = 1 << BIOME_ID;

// ══════════════════════════════════════════════════════════════════
// ─── MARINE CHARACTERISTIC PARAMETERS ───────────────────────────
// ══════════════════════════════════════════════════════════════════
// ─── Climate ────────────────────────────────────────────────────
// Marine climate describes the water column's thermal environment across
// latitude, not a single air temperature. The three-layer structure (mixed
// layer, thermocline, deep zone) is the dominant vertical signal.
const CLIMATE = Object.freeze({
  // Sea-surface temperature (°C) — ranges from polar to tropical
  temperatureMin: -1.8,             // freezing point of seawater at 35 PSU
  temperatureMax: 32.0,
  temperatureMean: 17.0,
  temperatureDailySwing: 1.0,       // water moderates diurnal swing strongly
  temperatureFrostFree: false,      // sea ice forms at high latitudes
  // Humidity (0..1) — marine air is humid
  humidityMin: 0.60,
  humidityMax: 1.00,
  humidityMean: 0.82,
  // Precipitation (mm/hr mean) — input to the system, not a climate driver
  precipitationMean: 3.0,
  precipitationMax: 40.0,
  precipitationStormProb: 0.18,
  precipitationAnnualMm: 1000.0,
  // Seasons — thermal stratification cycle rather than a moisture cycle
  seasonalityAmplitude: 0.45,
  drySeasonLengthDays: 0,
  wetSeasonPeakDay: 0,
  snowSeasonDays: 0,               // sea ice, not snowfall, is the winter signal
  growingSeasonDays: 365,          // marine primary production is continuous
  // Wind — drives surface waves, upwelling, and Ekman transport
  windMeanSpeed: 6.5,
  windMaxSpeed: 45.0,              // storm-force gusts
  windPredominantDirDeg: 270,      // westerlies in mid-latitudes
  // Weather state probabilities (0..1)
  weatherProbClear: 0.30,
  weatherProbCloudy: 0.30,
  weatherProbRain: 0.20,
  weatherProbStorm: 0.15,
  weatherProbSnow: 0.00,
  weatherProbFog: 0.05,
  // Atmospheric
  pressureMeanKPa: 101.3,
  pressureSwingKPa: 3.0
});

// ─── Terrain Bias ────────────────────────────────────────────────
// Marine terrain is the seafloor: continental shelf, slope, rise, abyssal
// plain, and trench. Elevation is expressed as negative depth below sea level.
const TERRAIN = Object.freeze({
  elevationBand: ELEVATION_BAND.SUBMARINE,
  elevationMinM: -11000.0,          // Challenger Deep
  elevationMaxM: 0.0,               // sea surface
  slopeMeanDeg: 2.0,                // abyssal plains are nearly flat
  slopeMaxDeg: 60.0,                // continental slope and trench walls
  roughness: 0.35,                  // smooth abyssal plains vs. rugged ridges
  valleyDepth: 0.40,                // trenches and mid-ocean ridges
  valleyDensity: 0.30,
  plateauBias: 0.50,                // abyssal plains and continental shelves
  groundwaterTableDepthM: 0.0,      // saturated by definition
  permafrostDepthM: Infinity,
  terrainRoughnessHint: 0.30,
  biomeHint: BIOME_HINT.OCEAN
});

// ─── Soil ──────────────────────────────────────────────────────
// Marine "soil" is the benthic substrate: pelagic ooze, terrigenous mud,
// sand, gravel, and rock. Composition varies strongly with depth and
// distance from shore.
const SOIL = Object.freeze({
  textureClass: SOIL_TEXTURE_CLASS.SILT_LOAM,
  visualArchetype: SOIL_VISUAL_ARCHETYPE.PEAT_BROWN,
  // Primary fractions (0..1) — fine-grained pelagic sediment
  sand: 0.20,
  silt: 0.35,
  clay: 0.25,
  organicMatter: 0.10,              // marine snow and detritus
  gravel: 0.10,
  rockFragment: 0.00,
  // Chemistry
  pH: 7.8,                          // slightly alkaline seawater
  fertilityClass: FERTILITY_CLASS.POOR,
  fertilityIndex: 0.15,             // open ocean is nutrient-poor
  // Physics
  porosity: 0.60,
  bulkDensityGcm3: 1.30,
  waterHoldingCapacity: 0.70,       // fully saturated
  hydraulicConductivityMmHr: 0.1,
  cohesionKPa: 1.0,
  plasticityIndex: 25.0,
  // Colour (linear RGB) — brownish-grey ooze
  baseAlbedo: [0.18, 0.16, 0.14],
  organicDarkening: 0.30,
  ironOxideRedness: 0.10,
  calciumPale: 0.25,                // carbonate ooze
  // Erosion
  usleKFactor: 0.00,                // no rain erosion underwater
  windErodibility: 0.00
});

// ─── Vegetation ─────────────────────────────────────────────────
// Marine vegetation is restricted to the photic zone: seagrass meadows,
// kelp forests, and mangroves at the margin. The open ocean has no rooted
// vegetation; phytoplankton are handled by the ecology response system.
const VEGETATION = Object.freeze({
  treeTypeWeights: Object.freeze({
    [TREE_TYPE.MANGROVE]: 1.0      // coastal and brackish only
  }),
  grassTypeWeights: Object.freeze({
    [GRASS_TYPE.MARSH_REED]: 0.50, // salt marsh
    [GRASS_TYPE.MEADOW_GRASS]: 0.30, // seagrass analog
    [GRASS_TYPE.FERN]: 0.20
  }),
  verticalLayers: 3,                // canopy kelp > understory > seagrass
  emergentDensity: 0.05,
  canopyDensity: 0.15,              // kelp forests are patchy
  understoryDensity: 0.20,
  groundCoverDensity: 0.25,         // seagrass beds
  epiphyteDensity: 0.10,            // epiphytes on kelp and seagrass
  lianaDensity: 0.00,
  successionTarget: SUCCESSION.CLIMAX,
  fireRegimeYears: 0,               // fire is impossible underwater
  rootDepthM: 2.0,
  canopyRadiusM: 5.0,
  trunkHeightM: 15.0,               // kelp stipe length
  leafLitterDepthM: 0.05,
  bloomWindowDays: 180,
  // Poisson-disc targets per hectare — for photic-zone vegetation
  treeDensityPerHa: 20,             // mangroves at the margin
  shrubDensityPerHa: 100,
  groundCoverDensityPerHa: 5000    // seagrass density
});

// ─── Fauna ──────────────────────────────────────────────────────
// Marine fauna spans plankton, fish, marine mammals, seabirds, and benthic
// invertebrates. Biomass is highest in upwelling zones and coastal waters.
const FAUNA = Object.freeze({
  densityWeight: 0.80,              // high biomass in productive regions
  habitatLayers: Object.freeze({
    epipelagic: 0.40,               // 0–200 m, photic zone
    mesopelagic: 0.25,              // 200–1000 m, twilight zone
    bathypelagic: 0.15,             // 1000–4000 m, midnight zone
    benthic: 0.15,                  // seafloor
    coastal: 0.05                   // shelf and intertidal
  }),
  dielActivity: 0.40,               // diel vertical migration is a defining rhythm
  migrationCorridorWeight: 0.75,    // whales, tuna, sea turtles
  predatorPreyBalance: 0.60,
  nectarAvailability: 0.00,
  pollenAvailability: 0.00,
  // Characteristic guild weights
  planktonWeight: 0.35,
  fishWeight: 0.30,
  marineMammalWeight: 0.10,
  seabirdWeight: 0.10,
  benthicInvertebrateWeight: 0.15
});

// ─── Materials ──────────────────────────────────────────────────
// Full PBR + anime parameters for marine surfaces. The ocean surface is the
// defining material: Fresnel F₀ ≈ 0.02 for IOR 1.333, low roughness at
// grazing angles, depth-dependent Beer–Lambert absorption, and a Gerstner
// wave spectrum with deep-water dispersion. Sea ice, wet rock, and marine
// sediment complete the set.
const MATERIALS = Object.freeze({
  // ─── Ocean surface (open water) ─────────────────────────────
  oceanSurface: Object.freeze({
    albedo: [0.02, 0.06, 0.12],     // deep open-ocean blue
    roughness: 0.05,                 // very smooth at grazing angles
    metalness: 0.0,
    transmission: 0.90,              // mostly transparent
    ior: 1.333,                      // refractive index of seawater
    fresnelF0: 0.02,                 // Schlick F₀ for water–air interface[reference:0]
    subsurface: 0.25,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.08,
    acousticProfile: ACOUSTIC_PROFILE.WATER,
    flammability: 0.0,
    hardness: 0.0,
    brittleness: 1.0,
    // ─── Gerstner-wave spectrum ───────────────────────────────
    // Deep-water dispersion: ω = √(g·k), with g = 9.81 m/s².[reference:1]
    gerstnerWaves: Object.freeze({
      gravity: 9.81,
      // Eight-wave spectrum, each entry { amplitude, wavelength, steepness, directionDeg }
      spectrum: Object.freeze([
        Object.freeze({ amplitude: 1.20, wavelength: 180.0, steepness: 0.25, directionDeg: 270 }),
        Object.freeze({ amplitude: 0.70, wavelength: 110.0, steepness: 0.30, directionDeg: 265 }),
        Object.freeze({ amplitude: 0.40, wavelength: 65.0, steepness: 0.32, directionDeg: 278 }),
        Object.freeze({ amplitude: 0.22, wavelength: 38.0, steepness: 0.35, directionDeg: 260 }),
        Object.freeze({ amplitude: 0.12, wavelength: 22.0, steepness: 0.38, directionDeg: 285 }),
        Object.freeze({ amplitude: 0.06, wavelength: 12.0, steepness: 0.40, directionDeg: 255 }),
        Object.freeze({ amplitude: 0.03, wavelength: 7.0, steepness: 0.42, directionDeg: 292 }),
        Object.freeze({ amplitude: 0.015, wavelength: 4.0, steepness: 0.45, directionDeg: 248 })
      ]),
      // Wave fading: each wave is faded out once its wavelength falls below
      // the pixel footprint to prevent moiré at the horizon.
      footprintFade: true
    }),
    // ─── Beer–Lambert absorption (Jerlov Type I, clear open ocean) ─
    // I_z = I₀ · exp(−K_d · z); K_d in m⁻¹.
    // Clear ocean water: red is absorbed fastest (~0.05 m⁻¹ at 450 nm
    // is the minimum for blue-green, but red at 650 nm is ≈0.35 m⁻¹).
    // Approximate effective K_d per RGB channel for clear open ocean:
    attenuationKd: Object.freeze({
      red: 0.35,                    // absorbed within the first ~10–20 m
      green: 0.05,                  // penetrates to ~60–80 m
      blue: 0.025                   // penetrates deepest, to ~150–200 m
    }),
    // ─── Depth colour ramp ────────────────────────────────────
    shelfColor: [0.10, 0.35, 0.38],   // turquoise shelf water
    openColor: [0.02, 0.10, 0.28],    // blue open ocean
    abyssalColor: [0.01, 0.02, 0.06], // near-black abyssal water
    // ─── Foam ────────────────────────────────────────────────
    foamColor: [0.92, 0.95, 0.97],
    foamCoverage: 0.08,               // whitecap fraction at moderate wind
    foamRoughness: 0.60
  }),
  // ─── Sea ice ────────────────────────────────────────────────
  seaIce: Object.freeze({
    albedo: [0.85, 0.90, 0.95],
    roughness: 0.20,
    metalness: 0.0,
    transmission: 0.50,
    ior: 1.31,
    fresnelF0: 0.018,
    subsurface: 0.35,
    emissive: 0.0,
    wetnessResponse: 0.15,
    animeFlatness: 0.10,
    acousticProfile: ACOUSTIC_PROFILE.SOFT,
    flammability: 0.0,
    hardness: 0.50,
    brittleness: 0.55
  }),
  // ─── Wet rock (coastal) ─────────────────────────────────────
  wetRock: Object.freeze({
    albedo: [0.15, 0.16, 0.16],
    roughness: 0.70,                  // smoother than dry rock
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.45,
    acousticProfile: ACOUSTIC_PROFILE.ROCK,
    flammability: 0.0,
    hardness: 0.90,
    brittleness: 0.30
  }),
  // ─── Marine sediment (benthic ooze) ─────────────────────────
  marineSediment: Object.freeze({
    albedo: [0.22, 0.20, 0.17],
    roughness: 0.90,
    metalness: 0.0,
    transmission: 0.0,
    subsurface: 0.0,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.50,
    acousticProfile: ACOUSTIC_PROFILE.SOIL,
    flammability: 0.0,
    hardness: 0.05,
    brittleness: 0.95
  }),
  // ─── Seagrass / kelp ────────────────────────────────────────
  kelpFrond: Object.freeze({
    albedo: [0.12, 0.20, 0.10],
    roughness: 0.80,
    metalness: 0.0,
    transmission: 0.10,
    subsurface: 0.15,
    emissive: 0.0,
    wetnessResponse: 1.0,
    animeFlatness: 0.25,
    acousticProfile: ACOUSTIC_PROFILE.LEAVES,
    flammability: 0.0,
    hardness: 0.15,
    brittleness: 0.80
  })
});

// ─── Lighting ───────────────────────────────────────────────────
// Marine lighting is shaped by the water column: strong absorption of red,
// deep penetration of blue, caustics on shallow bottoms, and almost total
// darkness below the photic zone. The lighting block also carries the
// Jerlov optical water type used to select attenuation coefficients.
const LIGHTING = Object.freeze({
  canopyOcclusion: 0.00,            // no canopy over open water
  sunDiffuseFraction: 0.35,         // direct sun dominates on clear water
  sunIntensityScale: 1.10,
  colourCast: [0.85, 0.95, 1.00],   // cool blue-green cast
  atmosphericScatterBoost: 1.20,
  bioluminescentEmission: 0.15,     // dinoflagellates, jellyfish, deep-sea fauna
  dappledLightFrequency: 0.40,      // caustics on shallow bottoms
  dappledLightAmplitude: 0.45,
  shadowSoftnessNear: 0.3,
  shadowSoftnessMid: 0.5,
  shadowSoftnessFar: 0.7,
  shadowCascadeScale: 1.0,
  snowAlbedoBoost: 0.0,
  fogDensityBase: 0.006,           // marine haze
  skyTint: [0.80, 0.88, 0.98],
  // ─── Water-column light attenuation (Beer–Lambert) ─────────
  // Same K_d channels as the ocean surface material; the lighting provider
  // uses these to dim and colour-shift light with depth.[reference:2]
  attenuationKd: Object.freeze({
    red: 0.35,
    green: 0.05,
    blue: 0.025
  }),
  // ─── Photic zone boundaries ────────────────────────────────
  euphoticDepthM: 200.0,           // 1% of surface irradiance
  disphoticDepthM: 1000.0,         // twilight zone limit
  aphoticDepthM: 1000.0,           // midnight zone below this
  // ─── Caustics parameters ───────────────────────────────────
  causticIntensity: 0.45,
  causticScale: 0.35,
  causticSpeed: 0.55,
  // ─── Jerlov optical water type ─────────────────────────────
  // I = clearest open ocean; III = most turbid open ocean;
  // 1–9 = coastal water types.[reference:3]
  jerlovType: 'I'
});

// ─── Water ──────────────────────────────────────────────────────
// The marine water block describes the water body's physics: salinity,
// density, thermal structure, tides, and optical clarity. These parameters
// are the ones the hydrology coupling (334) and water-flow system (345)
// read to decide stratification, mixing, and ice formation.
const WATER = Object.freeze({
  // ─── Salinity and density ─────────────────────────────────
  // Mean open-ocean salinity ≈ 35 PSU; density at the surface ≈ 1025 kg/m³.
  salinityPsu: 35.0,               // practical salinity units[reference:4]
  densitySurfaceKgM3: 1025.0,       // typical surface seawater density
  densityDeepKgM3: 1028.0,          // cold, saline deep water
  freezingPointC: -1.8,             // depressed from 0 °C by salinity
  // ─── Temperature structure ────────────────────────────────
  // Three-layer thermal structure: mixed layer, thermocline, deep zone.
  mixedLayerDepthM: 50.0,           // wind-mixed surface layer
  thermoclineDepthM: 200.0,          // rapid temperature drop
  thermoclineThicknessM: 100.0,
  deepZoneTemperatureC: 4.0,         // cold deep water
  temperatureGradientCPerM: 0.10,    // across the thermocline
  // ─── Tides ────────────────────────────────────────────────
  // Semidiurnal M2 tide (12.42 h) is the dominant constituent.
  tidalRangeM: 1.2,                  // mean open-coast range
  tidalPeriodHours: 12.42,           // M2 constituent
  tidalCurrentMs: 0.3,               // mean tidal current
  // ─── Waves ────────────────────────────────────────────────
  significantWaveHeightM: 1.5,       // H_s for moderate sea state
  wavePeriodS: 8.0,                  // peak spectral period
  // ─── Optical clarity ──────────────────────────────────────
  // Jerlov Type I (clearest open ocean): Secchi depth ≈ 50–60 m.
  jerlovType: 'I',
  secchiDepthM: 55.0,                // clear open-ocean water
  turbidityNTU: 0.1,                 // very low open-ocean turbidity
  chlorophyllMgL: 0.1,              // oligotrophic open ocean
  cdomAbsorption: 0.02,              // low coloured dissolved organic matter
  // ─── Sea ice ──────────────────────────────────────────────
  iceCoverMonths: 0,                 // open ocean; polar override
  iceThicknessM: 0.0,
  // ─── Water colour ─────────────────────────────────────────
  baseColor: [0.02, 0.08, 0.20],    // open-ocean blue
  shallowColor: [0.10, 0.35, 0.38],  // turquoise shelf
  deepColor: [0.01, 0.02, 0.06]      // abyssal near-black
});

// ─── Sensory ────────────────────────────────────────────────────
const SENSORY = Object.freeze({
  // Acoustic signature (0..1 weights across 8 channels)
  acoustic: Object.freeze({
    biological: 0.15,               // whale song, fish, seabirds
    geological: 0.05,               // distant seafloor spreading
    water: 0.60,                    // waves, surf, spray
    wind: 0.15,                     // wind over water
    vegetation: 0.05,
    mechanical: 0.00
  }),
  // Olfactory signature
  olfactory: Object.freeze({
    floral: 0.00,
    earthy: 0.05,
    aquatic: 0.25,
    woodland: 0.00,
    smoke: 0.00,
    animal: 0.10,
    decay: 0.05,
    sulfur: 0.05,                   // dimethyl sulfide from plankton
    sea: 0.45,                      // salt spray and marine air
    clean: 0.05
  }),
  // Tactile profile
  tactile: Object.freeze({
    temperatureC: 17.0,
    humidity: 0.85,
    windPressurePa: 8.0,
    precipitationType: 'rain',
    groundHardness: 0.00           // water, not ground
  })
});

// ─── Seasonality ────────────────────────────────────────────────
// Marine phenology is driven by the thermal cycle and, at high latitudes, by
// the seasonal advance and retreat of sea ice. Primary production follows
// the spring bloom and autumn turnover.
const SEASONALITY = Object.freeze({
  phenologyOverrides: Object.freeze({
    budBreakDayOffset: 0,
    fullGreenDurationDays: 200,
    autumnColourShiftDays: 30,
    leafDropDurationDays: 20,
    bloomWindowDays: 120,
    sporeBoostWetSeason: 0.10,
    fungalBoostWetSeason: 0.05
  }),
  seasonalMaterialPalettes: Object.freeze({
    [SEASONAL_MATERIAL.SPRING_NEW_LEAF]: Object.freeze({
      oceanSurface: { albedo: [0.04, 0.14, 0.22], roughness: 0.06 },
      kelpFrond: { albedo: [0.14, 0.24, 0.12], roughness: 0.78 }
    }),
    [SEASONAL_MATERIAL.SUMMER_FULL_GREEN]: Object.freeze({
      oceanSurface: { albedo: [0.02, 0.06, 0.12], roughness: 0.05 },
      kelpFrond: { albedo: [0.12, 0.20, 0.10], roughness: 0.80 }
    }),
    [SEASONAL_MATERIAL.AUTUMN_PEAK]: Object.freeze({
      oceanSurface: { albedo: [0.03, 0.08, 0.16], roughness: 0.06 },
      kelpFrond: { albedo: [0.18, 0.18, 0.10], roughness: 0.82 }
    }),
    [SEASONAL_MATERIAL.WINTER_BARE_BRANCH]: Object.freeze({
      oceanSurface: { albedo: [0.05, 0.10, 0.18], roughness: 0.08 },
      seaIce: { albedo: [0.85, 0.90, 0.95], roughness: 0.20 }
    })
  }),
  snowAccumulationRateMmHr: 0.0,
  snowMeltRateMmHr: 0.0,
  snowAlbedoSeasonal: 0.0
});

// ─── Procedural ─────────────────────────────────────────────────
const PROCEDURAL = Object.freeze({
  // Noise scales (world units) for surface and benthic detail
  macroWaterNoiseScale: 500.0,      // large-scale swell and current patterns
  midWaterNoiseScale: 80.0,         // wave groups
  microWaterNoiseScale: 12.0,       // ripple and foam detail
  seafloorNoiseScale: 200.0,        // abyssal hill terrain
  // Poisson-disc density targets (per hectare) — mirrored from VEGETATION
  treeDensityPerHa: VEGETATION.treeDensityPerHa,
  shrubDensityPerHa: VEGETATION.shrubDensityPerHa,
  groundCoverDensityPerHa: VEGETATION.groundCoverDensityPerHa,
  // LOD scale thresholds (world units) — marine views extend to the horizon
  lodHighDistance: 2000.0,
  lodMidDistance: 10000.0,
  lodLowDistance: 50000.0,
  // Procedural event budgets
  maxFireEventsPerTick: 0,          // fire is impossible underwater
  maxErosionEventsPerTick: 2,       // wave and current erosion
  maxGrowthEventsPerTick: 3
});

// ══════════════════════════════════════════════════════════════════
// ─── SUITABILITY SCORING ────────────────────────────────────────
// Marine suitability is primarily driven by water-table depth (which for a
// marine biome means the seafloor is below sea level and saturated) and by
// the absence of a land surface. Temperature, humidity, slope, and substrate
// play supporting roles. 328_BiomeBlendField uses this to decide how much of
// the marine biome applies at any world point.
// ══════════════════════════════════════════════════════════════════
const _scratchVec3 = new Vec3();
const _scratchNoise = new SimplexNoise();

/**
 * Compute the marine suitability at a world position and environmental state.
 * All inputs are expected to come from the context frame or from provider
 * summaries. The function allocates nothing after module initialisation.
 *
 * @param {object} env - Environmental sample.
 * @param {number} env.temperatureC - Air/water temperature in °C.
 * @param {number} env.humidity - Relative humidity 0..1.
 * @param {number} env.elevationM - Elevation in metres (negative = below sea level).
 * @param {number} env.slopeDeg - Slope angle in degrees.
 * @param {number} env.soilSand - Sand fraction 0..1.
 * @param {number} env.soilSilt - Silt fraction 0..1.
 * @param {number} env.soilClay - Clay fraction 0..1.
 * @param {number} env.waterTableDepthM - Depth to water table in metres.
 * @param {number} [env.noise] - Optional simplex noise sample for patchiness.
 * @returns {number} Suitability weight in [0, 1].
 */
function getSuitability(env) {
  // ─── Elevation: marine is below sea level; the deeper, the stronger ───
  const depthScore = env.elevationM < 0.0
    ? smoothstep(0.0, -200.0, env.elevationM) * 0.7 + smoothstep(-200.0, -4000.0, env.elevationM) * 0.3
    : 0.0;

  // ─── Temperature: seawater ranges from polar to tropical ──────────────
  const tempScore = smoothstep(-2.0, 5.0, env.temperatureC) * (1.0 - smoothstep(28.0, 35.0, env.temperatureC));

  // ─── Humidity: marine air is humid ────────────────────────────────────
  const humidityScore = smoothstep(0.60, 0.85, env.humidity);

  // ─── Slope: continental slopes and trenches are valid marine terrain ──
  const slopeScore = 1.0 - smoothstep(45.0, 70.0, env.slopeDeg);

  // ─── Substrate: fine-grained sediment is typical of the deep seafloor ─
  const textureScore =
    0.40 * smoothstep(0.20, 0.45, env.soilSilt) +
    0.30 * smoothstep(0.15, 0.40, env.soilClay) +
    0.30 * (1.0 - smoothstep(0.30, 0.60, env.soilSand));

  // ─── Water table: at or below the surface is mandatory ────────────────
  const waterScore = 1.0 - smoothstep(0.0, 1.0, env.waterTableDepthM);

  // ─── Patchiness: break up the suitability field with low-frequency noise ─
  const patchiness = env.noise !== undefined ? (0.85 + 0.15 * env.noise) : 1.0;

  // ─── Weighted fusion ────────────────────────────────────────────────
  // Depth is the dominant term: marine only exists below sea level.
  const raw =
    0.45 * depthScore +
    0.15 * tempScore +
    0.10 * humidityScore +
    0.08 * slopeScore +
    0.10 * textureScore +
    0.12 * waterScore;

  return Math.max(0.0, Math.min(1.0, raw * patchiness));
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR EXPORT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const AquaticMarineBiome = Object.freeze({
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

export default AquaticMarineBiome;