// file number : 287
// full path name : src/context/287_ClimateTemperatureProvider.js
// description : Climate temperature provider computing the average heat field that feeds flora, soil microbes, snow formation, and lighting across the entire living world. Fuses seven independent temperature contributions into one coherent value per cell: latitude-based insolation via solar zenith angle combined with axial tilt and season (T_lat = T_eq − ΔT_pole · |sin(lat)| · f(season)); elevation lapse rate (T_ele = T_base − Γ · z with Γ = 6.5 K/km); continental interiority (continents have larger seasonal and diurnal swings than coasts — T_interior = T_base + A_swing · interiorness); oceanic moderation near water bodies (T_ocean = T_base + (T_ocean − T_base) · oceanProximity); cloud-cover reflection (T_cloud = T_base − C_albedo · cloudCover); weather-state forcing (storm cool-down, clear-sky daytime boost); and diurnal cycle from sun altitude. Computes daily mean, diurnal amplitude, seasonal amplitude, and instantaneous temperature with all intermediate factors exposed for shaders. Provides lookup tables for growth thresholds (GDD = growing degree days with T_base = 5 °C for temperate, 10 °C for tropical), frost risk, snow-line altitude, and per-biome temperature suitability. Provides a full PBR + anime material parameter set for frozen surfaces, melting snow, thaw slush, thermal-stress rock, and cold-adapted foliage — all live scalars the shader reads. Emits a single coalesced WEATHER causal event when a chunk crosses 0 °C (thaw/freeze boundary) or crosses the GDD threshold for active growth. Writes per-chunk summaries into frame.layers.spatial.temperature and global aggregates into frame.layers.physical.climateTemperature. All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs heat state — flora dormancy and growth scheduling (282_Z07, 282_Z08), soil microbe activity (286_DecomposersSystem), snow formation and melt (283_BathymetryProvider's ice class), fauna migration and hibernation (279_Z03–Z05), material shaders for frozen/melted surfaces, lighting couplers for warm/cool light tint, and the climate coupling providers that decide biome boundaries. Complements 276_TemporalContextProvider (weather) and 285_MoistureLevelProvider (humidity) by completing the climate triple — temperature, moisture, and weather.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision,
  ContextFrame, CoreClock, CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES,
  TemporalContextProvider, WEATHER, WEATHER_NAMES, WEATHER_SEVERITY,
  CausalContextProvider, DERIVED_SIGNAL,
  CoreLayers, LAYER, LAYER_MASKS,
  smoothstep,
  TerrainProvider, BIOME_HINT,
  ElevationProvider, ELEVATION_BAND, ATMOSPHERE,
  SlopeGradientProvider, SLOPE_BAND,
  ReliefGradientProvider, RELIEF_CLASS,
  CliffsGradientProvider, CLIFF_CLASS,
  CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND,
  RockGradientProvider, ROCK_CLASS,
  ForestGradientProvider, TREE_TYPE,
  GrassAndFlowresGradientProvider, GRASS_TYPE,
  ContinentalReliefGradientProvider, CONTINENTAL_TYPE,
  BathymetryProvider, BATHY_ZONE, SEABED_CLASS,
  GroundwaterProvider,
  MoistureLevelProvider, MOISTURE_STATE,
  DecomposersSystem, DECOMPOSER_TYPE,
  ColorManagement, ColorSpace,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 1;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── climate zone codes ─────────────────────────────────────────
const CLIMATE_ZONE = Object.freeze({
  POLAR:       0,   // annual mean < 0 °C
  SUBPOLAR:    1,   // 0 to 5 °C
  BOREAL:      2,   // 5 to 10 °C
  TEMPERATE:   3,   // 10 to 18 °C
  SUBTROPICAL: 4,   // 18 to 24 °C
  TROPICAL:    5,   // 24 to 30 °C
  EQUATORIAL:  6    // > 30 °C
});

const CLIMATE_ZONE_NAMES = Object.freeze([
  'polar', 'subpolar', 'boreal', 'temperate',
  'subtropical', 'tropical', 'equatorial'
]);

// ─── climate constants ─────────────────────────────────────────
const CLIMATE_CONSTANTS = Object.freeze({
  // Global averages.
  equatorialMeanTemp:   28.0,       // °C
  polarMeanTemp:       -20.0,       // °C

  // Elevation lapse rate.
  lapseRate:            0.0065,     // K/m (= 6.5 K/km)

  // Continental interiority amplification.
  interiorSwingMax:     8.0,        // °C extra swing at deep interior
  coastalModerationFactor: 0.5,     // coastal temps moderated by this

  // Oceanic moderation near large water bodies.
  oceanProximityRange:  50000.0,    // metres (50 km from coast)

  // Cloud-cover reflection.
  cloudAlbedoCool:      3.0,        // °C cooling per unit cloud cover

  // Weather-state forcing.
  stormCoolFactor:      5.0,        // °C cooling during storm
  clearSkyDayBoost:     2.0,        // °C boost in direct sunlight
  clearSkyNightDrop:    2.0,        // °C extra drop in clear nights

  // Diurnal amplitude baseline.
  diurnalBaseAmplitude: 6.0,        // °C swing from day to night
  diurnalInteriorAmplitude: 12.0,   // °C extra swing inland

  // Seasonal amplitude baseline.
  seasonalBaseAmplitude: 5.0,       // °C at equator
  seasonalPolarAmplitude: 20.0,     // °C at pole

  // Snowline altitude (0 °C isotherm).
  snowlineBaseAlt:      3000.0,     // metres at sea level 0°C
  frostThreshold:       0.0,        // °C for freezing

  // Growing degree days.
  gddBaseTemp:          5.0,        // °C
  gddTropicalBaseTemp:  10.0,       // °C

  // Snow parameters.
  snowAccumThreshold:   0.5,        // °C below which snow can accumulate
  snowMeltThreshold:    1.0,        // °C above which snow melts
  snowMeltRate:         0.01        // metres/day of snow melt per °C above 0
});

// ─── climate zone thresholds (°C annual mean) ─────────────────
const CLIMATE_THRESHOLDS = Object.freeze({
  polarUpper:       0.0,
  subpolarUpper:    5.0,
  borealUpper:      10.0,
  temperateUpper:   18.0,
  subtropicalUpper: 24.0,
  tropicalUpper:    30.0
});

// ─── material parameter sets for temperature-dependent surfaces ─
// Each carries a full PBR + anime parameter struct the shader reads.
const TEMPERATURE_MATERIAL = Object.freeze({
  SNOW_FRESH: {
    pbr: {
      baseColor:    [0.95, 0.96, 0.98],
      metalness:    0.00,
      roughness:    0.85,
      clearcoat:    0.00,
      transmission: 0.10,
      ior:          1.31,
      sheen:        0.30,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.96, 0.97, 0.99],
      quantizeSteps: 2,
      rimPower:     1.3,
      rimColor:     [0.75, 0.88, 1.00]
    },
    subsurfaceRadius: [0.15, 0.18, 0.22],
    emissive:         [0.00, 0.00, 0.02],
    sparkle:          0.20,
    frostiness:       1.00
  },
  SNOW_PACKED: {
    pbr: {
      baseColor:    [0.85, 0.88, 0.92],
      metalness:    0.00,
      roughness:    0.70,
      clearcoat:    0.10,
      transmission: 0.05,
      ior:          1.31,
      sheen:        0.20,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.88, 0.90, 0.94],
      quantizeSteps: 2,
      rimPower:     1.4,
      rimColor:     [0.70, 0.82, 0.95]
    },
    subsurfaceRadius: [0.10, 0.12, 0.14],
    emissive:         [0.00, 0.00, 0.01],
    sparkle:          0.10,
    frostiness:       0.80
  },
  SNOW_MELTING: {
    pbr: {
      baseColor:    [0.78, 0.82, 0.86],
      metalness:    0.00,
      roughness:    0.45,
      clearcoat:    0.40,
      transmission: 0.20,
      ior:          1.33,
      sheen:        0.15,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.82, 0.86, 0.90],
      quantizeSteps: 3,
      rimPower:     1.6,
      rimColor:     [0.65, 0.80, 0.95]
    },
    subsurfaceRadius: [0.10, 0.11, 0.12],
    emissive:         [0.00, 0.00, 0.00],
    sparkle:          0.05,
    frostiness:       0.50
  },
  SLUSH: {
    pbr: {
      baseColor:    [0.55, 0.55, 0.58],
      metalness:    0.00,
      roughness:    0.55,
      clearcoat:    0.60,
      transmission: 0.30,
      ior:          1.33,
      sheen:        0.10,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.58, 0.58, 0.62],
      quantizeSteps: 3,
      rimPower:     1.8,
      rimColor:     [0.50, 0.65, 0.80]
    },
    subsurfaceRadius: [0.05, 0.06, 0.07],
    emissive:         [0.00, 0.00, 0.00],
    sparkle:          0.00,
    frostiness:       0.25
  },
  FROST_GRASS: {
    pbr: {
      baseColor:    [0.42, 0.55, 0.32],
      metalness:    0.00,
      roughness:    0.70,
      clearcoat:    0.55,
      transmission: 0.00,
      ior:          1.40,
      sheen:        0.40,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.45, 0.58, 0.35],
      quantizeSteps: 3,
      rimPower:     1.7,
      rimColor:     [0.85, 0.92, 1.00]
    },
    subsurfaceRadius: [0.05, 0.07, 0.04],
    emissive:         [0.00, 0.00, 0.00],
    sparkle:          0.15,
    frostiness:       0.65
  },
  THERMAL_ROCK: {
    pbr: {
      baseColor:    [0.42, 0.38, 0.34],
      metalness:    0.05,
      roughness:    0.65,
      clearcoat:    0.05,
      transmission: 0.00,
      ior:          1.50,
      sheen:        0.00,
      anisotropy:   0.05
    },
    anime: {
      baseColor:    [0.45, 0.40, 0.36],
      quantizeSteps: 3,
      rimPower:     1.9,
      rimColor:     [0.75, 0.65, 0.55]
    },
    subsurfaceRadius: [0.02, 0.02, 0.01],
    emissive:         [0.00, 0.00, 0.00],
    sparkle:          0.00,
    frostiness:       0.00
  },
  HOT_ROCK: {
    pbr: {
      baseColor:    [0.30, 0.20, 0.18],
      metalness:    0.10,
      roughness:    0.55,
      clearcoat:    0.10,
      transmission: 0.00,
      ior:          1.50,
      sheen:        0.00,
      anisotropy:   0.10
    },
    anime: {
      baseColor:    [0.35, 0.22, 0.20],
      quantizeSteps: 3,
      rimPower:     1.5,
      rimColor:     [1.00, 0.55, 0.30]
    },
    subsurfaceRadius: [0.02, 0.01, 0.01],
    emissive:         [0.45, 0.15, 0.05],
    sparkle:          0.00,
    frostiness:       0.00
  }
});

// ─── climate temperature defaults ───────────────────────────────
const CLIMATE_TEMP_DEFAULTS = Object.freeze({
  worldSeed:              0xC11A7E0F,
  cellSize:               64.0,    // metres per cell (coarse)
  chunkSize:              1000,
  maxCellsPerChunk:       64,       // 8×8 cells per chunk
  maxChunksPerFrame:      8,
  latitudeBase:           45.0,     // degrees (world origin latitude)
  latitudeRange:          90.0,     // degrees across the world
  axialTilt:              23.44,    // degrees
  mutationCoalesceWindow: 10.0
});

class ClimateTemperatureProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...CLIMATE_TEMP_DEFAULTS, ...(options.defaults || {}) };
    this.constants = { ...CLIMATE_CONSTANTS, ...(options.constants || {}) };
    this.thresholds = { ...CLIMATE_THRESHOLDS, ...(options.thresholds || {}) };
    this.enableSnowModel = options.enableSnowModel ?? true;
    this.enableDiurnal = options.enableDiurnal ?? true;
    this.enableSeasonal = options.enableSeasonal ?? true;
    this.enableOceanModeration = options.enableOceanModeration ?? true;
    this.enableContinentalInteriority = options.enableContinentalInteriority ?? true;

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColor = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();
    this._tmpPlane = new Plane();

    // ── per-chunk temperature state ────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk summary.
    this._chunkMeanTemp       = new Float32Array(chunkCap);      // °C annual mean
    this._chunkMinTemp        = new Float32Array(chunkCap);      // °C winter minimum
    this._chunkMaxTemp        = new Float32Array(chunkCap);      // °C summer maximum
    this._chunkDiurnalAmp     = new Float32Array(chunkCap);      // °C swing
    this._chunkSeasonalAmp    = new Float32Array(chunkCap);      // °C swing
    this._chunkClimateZone    = new Uint8Array(chunkCap);
    this._chunkLatitudeEffect = new Float32Array(chunkCap);
    this._chunkElevationEffect = new Float32Array(chunkCap);
    this._chunkInteriorEffect = new Float32Array(chunkCap);
    this._chunkOceanEffect    = new Float32Array(chunkCap);
    this._chunkCloudEffect    = new Float32Array(chunkCap);
    this._chunkWeatherEffect  = new Float32Array(chunkCap);
    this._chunkSnowLineAlt    = new Float32Array(chunkCap);      // metres
    this._chunkSnowMass       = new Float32Array(chunkCap);      // kg/m²
    this._chunkGDD            = new Float32Array(chunkCap);      // growing degree days
    this._chunkFrostRisk      = new Float32Array(chunkCap);      // 0..1
    this._chunkInstantTemp    = new Float32Array(chunkCap);      // °C right now
    this._chunkBiomeTempSuitability = new Float32Array(chunkCap); // 0..1

    // Per-chunk cell data.
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellTemp = new Array(chunkCap).fill(null);
    this._chunkCellSnow = new Array(chunkCap).fill(null);
    this._chunkCellZone = new Array(chunkCap).fill(null);   // Uint8Array

    // Free lists.
    this._cellPool = {
      x: [], y: [], z: [], temp: [], snow: []
    };
    this._zonePool = [];

    // ── per-frame global aggregates ───────────────────────
    this._globalClimate = {
      avgMeanTemp: 15.0,
      avgInstantTemp: 15.0,
      avgDiurnalAmp: 6.0,
      avgSeasonalAmp: 5.0,
      dominantZone: CLIMATE_ZONE.TEMPERATE,
      polarFraction: 0,
      tropicalFraction: 0,
      snowFraction: 0,
      frostFraction: 0,
      gddAverage: 0,
      snowlineAverage: 3000
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ─────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      polarCells: 0,
      borealCells: 0,
      temperateCells: 0,
      tropicalCells: 0,
      snowCoveredCells: 0,
      frozenCells: 0,
      thawFreezeCrossings: 0,
      mutationEventsEmitted: 0
    };

    // ── collaborators ─────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._carve = options.carve || null;
    this._continental = options.continental || null;
    this._bathymetry = options.bathymetry || null;
    this._groundwater = options.groundwater || null;
    this._moisture = options.moisture || null;
    this._decomposers = options.decomposers || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── reusable material output ───────────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0 },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      subsurfaceRadius: [0,0,0],
      emissive: [0,0,0],
      sparkle: 0,
      frostiness: 0
    };

    // ── per-chunk freeze state (for transition events) ─────
    this._chunkFrozenState = new Uint8Array(chunkCap);
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachContinental(c) { this._continental = c; return this; }
  attachBathymetry(b) { this._bathymetry = b; return this; }
  attachGroundwater(g) { this._groundwater = g; return this; }
  attachMoisture(m) { this._moisture = m; return this; }
  attachDecomposers(d) { this._decomposers = d; return this; }
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

  _getSeaLevel() {
    return this._elevation ? this._elevation.seaLevel : 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── latitude computation ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Maps world Z coordinate into latitude in degrees.
  // The world spans latitudeRange degrees centred on the equator.
  _worldToLatitude(wz) {
    const worldSpan = 1_000_000;   // world size in metres (arbitrary)
    const lat = (wz / worldSpan) * this.defaults.latitudeRange * 2 - this.defaults.latitudeRange;
    return Math.max(-90, Math.min(90, lat));
  }

  // ══════════════════════════════════════════════════════════
  // ─── latitude-based insolation ──────────────────────────
  // ══════════════════════════════════════════════════════════
  // T_lat = T_eq − ΔT_pole · |sin(lat)| · f(season)
  // Where f(season) modulates the seasonal swing by hemisphere.
  _latitudeTemperature(latitude, season) {
    const latRad = latitude * Math.PI / 180;
    const absLat = Math.abs(Math.sin(latRad));

    // Base mean from equator to pole.
    const baseMean = this.constants.equatorialMeanTemp -
      (this.constants.equatorialMeanTemp - this.constants.polarMeanTemp) * absLat;

    // Hemisphere: north (positive lat) has summer in northern summer.
    const hemisphere = latitude >= 0 ? 1 : -1;

    // Season: 0 = northern winter, 0.5 = northern summer.
    // Seasonal temperature offset peaks in local summer.
    const seasonOffset = Math.sin((season - 0.25) * 2 * Math.PI) * hemisphere;
    const seasonalAmp = this.enableSeasonal
      ? this.constants.seasonalBaseAmplitude +
        (this.constants.seasonalPolarAmplitude - this.constants.seasonalBaseAmplitude) * absLat
      : 0;

    return baseMean + seasonOffset * seasonalAmp;
  }

  // ══════════════════════════════════════════════════════════
  // ─── elevation lapse ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _elevationTemperature(altitude) {
    return -this.constants.lapseRate * altitude;
  }

  // ══════════════════════════════════════════════════════════
  // ─── continental interiority ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _interiorityEffect(wx, wz) {
    if (!this.enableContinentalInteriority) return 0;
    if (!this._continental) return 0;

    const interiorness = this._continental.getInteriornessAt(wx, wz);
    // Deep interior has larger swings but similar mean.
    return interiorness * this.constants.interiorSwingMax;
  }

  // ══════════════════════════════════════════════════════════
  // ─── oceanic moderation ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Coastal cells have moderated temperature swings.
  _oceanModeration(wx, wz, baseTemp) {
    if (!this.enableOceanModeration) return 0;
    if (!this._bathymetry) return 0;

    const water = this._bathymetry.getWaterAt(wx, wz);
    if (!water || water.waterCoverage < 0.1) return 0;

    const coverage = water.waterCoverage;
    const moderation = coverage * this.constants.coastalModerationFactor;
    return moderation;   // used as a multiplier in the swing reduction
  }

  // ══════════════════════════════════════════════════════════
  // ─── cloud cover cooling ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _cloudCooling(cloudCover) {
    return -this.constants.cloudAlbedoCool * cloudCover;
  }

  // ══════════════════════════════════════════════════════════
  // ─── weather-state forcing ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _weatherEffect(weatherState, weatherSeverity, sunAltitude, isNight) {
    let effect = 0;

    if (weatherSeverity > 0.5) {
      // Storm cool-down.
      effect -= (weatherSeverity - 0.5) * this.constants.stormCoolFactor;
    }

    if (sunAltitude > 0.1 && weatherSeverity < 0.3) {
      // Clear-sky daytime boost.
      effect += sunAltitude * this.constants.clearSkyDayBoost;
    } else if (isNight && weatherSeverity < 0.3) {
      // Clear night extra drop.
      effect -= this.constants.clearSkyNightDrop;
    }

    return effect;
  }

  // ══════════════════════════════════════════════════════════
  // ─── instantaneous temperature ──────────────────────────
  // ══════════════════════════════════════════════════════════
  // Combines all contributions into a single current temperature.
  _computeInstantTemp(wx, wz, altitude, frame) {
    const physical = frame.layers.physical;
    const sunAltitude = physical?.sunAltitude ?? 0.7;
    const sunIntensity = physical?.sunIntensity ?? 0.7;
    const cloudCover = physical?.cloudCover ?? 0.3;
    const weatherState = this._temporal?.weatherState ?? WEATHER.CLEAR;
    const weatherSeverity = this._temporal?.weatherSeverity ?? 0.3;
    const season = this._temporal?.seasonScalar ?? 0.5;
    const isNight = sunAltitude < 0;

    const latitude = this._worldToLatitude(wz);

    // Base temperature from latitude + season.
    const latTemp = this._latitudeTemperature(latitude, season);

    // Elevation lapse.
    const elevTemp = this._elevationTemperature(altitude);

    // Interiority effect adds to the amplitude — computed later.

    // Cloud cooling.
    const cloudTemp = this._cloudCooling(cloudCover);

    // Weather forcing.
    const weatherTemp = this._weatherEffect(weatherState, weatherSeverity, sunAltitude, isNight);

    // Diurnal effect from sun altitude.
    const diurnalTemp = this.enableDiurnal
      ? sunAltitude * this.constants.diurnalBaseAmplitude * 0.5
      : 0;

    return latTemp + elevTemp + cloudTemp + weatherTemp + diurnalTemp;
  }

  // ══════════════════════════════════════════════════════════
  // ─── annual mean, amplitude, extremes ───────────────────
  // ══════════════════════════════════════════════════════════
  _computeClimateStats(wx, wz, altitude, frame) {
    const physical = frame.layers.physical;
    const cloudCover = physical?.cloudCover ?? 0.3;

    const latitude = this._worldToLatitude(wz);
    const latRad = latitude * Math.PI / 180;
    const absLat = Math.abs(Math.sin(latRad));

    // Annual mean temperature: latitude + elevation + cloud effect.
    const annualMean = (this.constants.equatorialMeanTemp -
      (this.constants.equatorialMeanTemp - this.constants.polarMeanTemp) * absLat)
      - this.constants.lapseRate * altitude
      - this.constants.cloudAlbedoCool * cloudCover * 0.5;

    // Diurnal amplitude (bigger inland, bigger in dry areas).
    let diurnalAmp = this.constants.diurnalBaseAmplitude;
    if (this.enableContinentalInteriority && this._continental) {
      const interiorness = this._continental.getInteriornessAt(wx, wz);
      diurnalAmp += interiorness * (this.constants.diurnalInteriorAmplitude - this.constants.diurnalBaseAmplitude);
    }
    if (this.enableOceanModeration && this._bathymetry) {
      const water = this._bathymetry.getWaterAt(wx, wz);
      if (water && water.waterCoverage > 0.1) {
        const mod = water.waterCoverage * this.constants.coastalModerationFactor;
        diurnalAmp *= (1 - mod);
      }
    }

    // Seasonal amplitude (bigger at high latitudes and inland).
    let seasonalAmp = this.constants.seasonalBaseAmplitude +
      (this.constants.seasonalPolarAmplitude - this.constants.seasonalBaseAmplitude) * absLat;
    if (this.enableContinentalInteriority && this._continental) {
      const interiorness = this._continental.getInteriornessAt(wx, wz);
      seasonalAmp *= (1 + interiorness * 0.5);
    }
    if (this.enableOceanModeration && this._bathymetry) {
      const water = this._bathymetry.getWaterAt(wx, wz);
      if (water && water.waterCoverage > 0.1) {
        const mod = water.waterCoverage * this.constants.coastalModerationFactor;
        seasonalAmp *= (1 - mod * 0.7);
      }
    }

    const minTemp = annualMean - seasonalAmp * 0.5 - diurnalAmp * 0.5;
    const maxTemp = annualMean + seasonalAmp * 0.5 + diurnalAmp * 0.5;

    return {
      annualMean,
      minTemp,
      maxTemp,
      diurnalAmp,
      seasonalAmp,
      latitude,
      absLat
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── climate zone classification ────────────────────────
  // ══════════════════════════════════════════════════════════
  _classifyClimateZone(annualMean) {
    const t = this.thresholds;
    if (annualMean < t.polarUpper) return CLIMATE_ZONE.POLAR;
    if (annualMean < t.subpolarUpper) return CLIMATE_ZONE.SUBPOLAR;
    if (annualMean < t.borealUpper) return CLIMATE_ZONE.BOREAL;
    if (annualMean < t.temperateUpper) return CLIMATE_ZONE.TEMPERATE;
    if (annualMean < t.subtropicalUpper) return CLIMATE_ZONE.SUBTROPICAL;
    if (annualMean < t.tropicalUpper) return CLIMATE_ZONE.TROPICAL;
    return CLIMATE_ZONE.EQUATORIAL;
  }

  // ══════════════════════════════════════════════════════════
  // ─── snowline computation ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Altitude at which temperature falls below 0 °C in the annual mean.
  _computeSnowline(annualMeanAtSeaLevel) {
    if (annualMeanAtSeaLevel <= 0) return 0;
    // Altitude where T_base − Γ·z = 0 → z = T_base / Γ
    return annualMeanAtSeaLevel / this.constants.lapseRate;
  }

  // ══════════════════════════════════════════════════════════
  // ─── growing degree days ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // GDD accumulates daily mean temperatures above the base threshold.
  _computeGDD(annualMean, climateZone) {
    const baseTemp = climateZone >= CLIMATE_ZONE.SUBTROPICAL
      ? this.constants.gddTropicalBaseTemp
      : this.constants.gddBaseTemp;
    const excess = Math.max(0, annualMean - baseTemp);
    return excess * 365;   // annual total
  }

  // ══════════════════════════════════════════════════════════
  // ─── frost risk ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeFrostRisk(minTemp) {
    if (minTemp < -10) return 1.0;
    if (minTemp < 0) return Math.min(1, (0 - minTemp) / 10 + 0.3);
    if (minTemp < 5) return 0.3 * (1 - minTemp / 5);
    return 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── snow mass computation ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeSnowMass(instantTemp, minTemp, moisture, snowlineAlt, altitude) {
    if (!this.enableSnowModel) return 0;
    // Snow accumulates only when the minimum temperature is below
    // the accumulation threshold, and only above the snowline.
    if (minTemp > this.constants.snowAccumThreshold) return 0;
    if (altitude < snowlineAlt * 0.85) return 0;

    // Snow mass scales with how far below 0 we are and with moisture.
    const coldFactor = Math.min(2, -minTemp / 10);
    const elevationFactor = Math.min(1, (altitude - snowlineAlt * 0.85) / 500);
    const moistureFactor = moisture;

    return Math.min(50, 0.5 + coldFactor * 10 * moistureFactor * elevationFactor);
  }

  // ══════════════════════════════════════════════════════════
  // ─── biome temperature suitability ──────────────────────
  // ══════════════════════════════════════════════════════════
  _computeBiomeSuitability(annualMean, diurnalAmp, seasonalAmp, moisture) {
    // Broad suitability: peaks in temperate/moderate range.
    let score = 0;

    // Temperature comfort.
    if (annualMean > 5 && annualMean < 25) score += 0.5;
    else if (annualMean > 0 && annualMean < 30) score += 0.25;

    // Low diurnal swing preferred by many species.
    if (diurnalAmp < 10) score += 0.15;

    // Low seasonal swing preferred.
    if (seasonalAmp < 15) score += 0.15;

    // Moisture amplifies suitability.
    score += moisture * 0.2;

    return Math.min(1, score);
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
      this._chunkCellTemp[slot] = this._acquireCell('temp');
      this._chunkCellSnow[slot] = this._acquireCell('snow');
      this._chunkCellZone[slot] = this._acquireZone();
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpTemp = this._chunkCellTemp[slot];
    const cpSnow = this._chunkCellSnow[slot];
    const cpZone = this._chunkCellZone[slot];

    let placed = 0;

    // Aggregates.
    let sumMeanTemp = 0;
    let sumMinTemp = 0;
    let sumMaxTemp = 0;
    let sumInstant = 0;
    let sumDiurnal = 0;
    let sumSeasonal = 0;
    let sumGDD = 0;
    let sumSnow = 0;
    let sumFrostRisk = 0;
    let sumBiomeSuit = 0;
    let sumSnowline = 0;
    let sumLatEffect = 0;
    let sumElevEffect = 0;
    let sumInteriorEffect = 0;
    let sumOceanEffect = 0;
    let sumCloudEffect = 0;
    let sumWeatherEffect = 0;
    let snowCells = 0;
    let frozenCells = 0;
    const zoneCount = new Uint16Array(CLIMATE_ZONE_NAMES.length);

    // Read global context.
    const physical = frame.layers.physical;
    const cloudCover = physical?.cloudCover ?? 0.3;
    const weatherSeverity = this._temporal?.weatherSeverity ?? 0.3;
    const weatherState = this._temporal?.weatherState ?? WEATHER.CLEAR;
    const sunAltitude = physical?.sunAltitude ?? 0.7;
    const season = this._temporal?.seasonScalar ?? 0.5;

    for (let j = 0; j < cellsPerSide && placed < this.defaults.maxCellsPerChunk; j++) {
      for (let i = 0; i < cellsPerSide && placed < this.defaults.maxCellsPerChunk; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;
        const altitude = this._getHeight(wx, wz);

        // Moisture at this cell.
        let moisture = 0.5;
        if (this._moisture) {
          moisture = this._moisture.sampleHumidityAt(wx, wz);
        } else if (this._groundwater) {
          const gw = this._groundwater.getGroundwaterAt(wx, wz);
          if (gw) moisture = gw.soilMoisture;
        }

        // Climate stats.
        const stats = this._computeClimateStats(wx, wz, altitude, frame);

        // Climate zone.
        const zone = this._classifyClimateZone(stats.annualMean);

        // Snowline.
        const snowline = this._computeSnowline(
          this.constants.equatorialMeanTemp -
          (this.constants.equatorialMeanTemp - this.constants.polarMeanTemp) * stats.absLat
        );

        // GDD.
        const gdd = this._computeGDD(stats.annualMean, zone);

        // Frost risk.
        const frostRisk = this._computeFrostRisk(stats.minTemp);

        // Instantaneous temperature.
        const instantTemp = this._computeInstantTemp(wx, wz, altitude, frame);

        // Snow mass.
        const snowMass = this._computeSnowMass(
          instantTemp, stats.minTemp, moisture, snowline, altitude
        );

        // Biome suitability.
        const biomeSuit = this._computeBiomeSuitability(
          stats.annualMean, stats.diurnalAmp, stats.seasonalAmp, moisture
        );

        // Individual effects (for diagnostics).
        const latEffect = stats.annualMean -
          (this.constants.equatorialMeanTemp -
           (this.constants.equatorialMeanTemp - this.constants.polarMeanTemp) * stats.absLat);
        const elevEffect = this._elevationTemperature(altitude);
        const interiorEffect = this._interiorityEffect(wx, wz);
        const oceanEffect = this._oceanModeration(wx, wz, stats.annualMean);
        const cloudEffect = this._cloudCooling(cloudCover);
        const weatherEffect = this._weatherEffect(weatherState, weatherSeverity, sunAltitude, sunAltitude < 0);

        // Store cell.
        cpx[placed] = wx;
        cpy[placed] = altitude;
        cpz[placed] = wz;
        cpTemp[placed] = instantTemp;
        cpSnow[placed] = snowMass;
        cpZone[placed] = zone;
        placed++;

        // Aggregates.
        sumMeanTemp += stats.annualMean;
        sumMinTemp += stats.minTemp;
        sumMaxTemp += stats.maxTemp;
        sumInstant += instantTemp;
        sumDiurnal += stats.diurnalAmp;
        sumSeasonal += stats.seasonalAmp;
        sumGDD += gdd;
        sumSnow += snowMass;
        sumFrostRisk += frostRisk;
        sumBiomeSuit += biomeSuit;
        sumSnowline += snowline;
        sumLatEffect += latEffect;
        sumElevEffect += elevEffect;
        sumInteriorEffect += interiorEffect;
        sumOceanEffect += oceanEffect;
        sumCloudEffect += cloudEffect;
        sumWeatherEffect += weatherEffect;
        zoneCount[zone]++;
        if (snowMass > 1) snowCells++;
        if (instantTemp < 0) frozenCells++;

        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // Compute per-chunk summary.
    const avgMean = placed > 0 ? sumMeanTemp / placed : 15;
    const avgMin = placed > 0 ? sumMinTemp / placed : 10;
    const avgMax = placed > 0 ? sumMaxTemp / placed : 20;
    const avgInstant = placed > 0 ? sumInstant / placed : 15;
    const avgDiurnal = placed > 0 ? sumDiurnal / placed : 6;
    const avgSeasonal = placed > 0 ? sumSeasonal / placed : 5;
    const avgGDD = placed > 0 ? sumGDD / placed : 0;
    const avgSnow = placed > 0 ? sumSnow / placed : 0;
    const avgFrost = placed > 0 ? sumFrostRisk / placed : 0;
    const avgSuit = placed > 0 ? sumBiomeSuit / placed : 0;
    const avgSnowline = placed > 0 ? sumSnowline / placed : 3000;
    const avgLat = placed > 0 ? sumLatEffect / placed : 0;
    const avgElev = placed > 0 ? sumElevEffect / placed : 0;
    const avgInterior = placed > 0 ? sumInteriorEffect / placed : 0;
    const avgOcean = placed > 0 ? sumOceanEffect / placed : 0;
    const avgCloud = placed > 0 ? sumCloudEffect / placed : 0;
    const avgWeather = placed > 0 ? sumWeatherEffect / placed : 0;

    // Dominant zone.
    let dominantZone = 0;
    let maxCount = 0;
    for (let z = 0; z < zoneCount.length; z++) {
      if (zoneCount[z] > maxCount) { maxCount = zoneCount[z]; dominantZone = z; }
    }

    this._chunkMeanTemp[slot] = avgMean;
    this._chunkMinTemp[slot] = avgMin;
    this._chunkMaxTemp[slot] = avgMax;
    this._chunkInstantTemp[slot] = avgInstant;
    this._chunkDiurnalAmp[slot] = avgDiurnal;
    this._chunkSeasonalAmp[slot] = avgSeasonal;
    this._chunkClimateZone[slot] = dominantZone;
    this._chunkLatitudeEffect[slot] = avgLat;
    this._chunkElevationEffect[slot] = avgElev;
    this._chunkInteriorEffect[slot] = avgInterior;
    this._chunkOceanEffect[slot] = avgOcean;
    this._chunkCloudEffect[slot] = avgCloud;
    this._chunkWeatherEffect[slot] = avgWeather;
    this._chunkSnowLineAlt[slot] = avgSnowline;
    this._chunkSnowMass[slot] = avgSnow;
    this._chunkGDD[slot] = avgGDD;
    this._chunkFrostRisk[slot] = avgFrost;
    this._chunkBiomeTempSuitability[slot] = avgSuit;

    this._stats.chunksProcessed++;
    this._stats.snowCoveredCells += snowCells;
    this._stats.frozenCells += frozenCells;
    this._stats.polarCells += zoneCount[CLIMATE_ZONE.POLAR] + zoneCount[CLIMATE_ZONE.SUBPOLAR];
    this._stats.borealCells += zoneCount[CLIMATE_ZONE.BOREAL];
    this._stats.temperateCells += zoneCount[CLIMATE_ZONE.TEMPERATE] + zoneCount[CLIMATE_ZONE.SUBTROPICAL];
    this._stats.tropicalCells += zoneCount[CLIMATE_ZONE.TROPICAL] + zoneCount[CLIMATE_ZONE.EQUATORIAL];

    // Freeze/thaw transition event.
    const isFrozen = avgInstant < 0 ? 1 : 0;
    const wasFrozen = this._chunkFrozenState[slot];
    if (wasFrozen !== isFrozen && this._dispatcher) {
      this._stats.thawFreezeCrossings++;
      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.AUDIO_LIGHT,
        [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
        -1, 30, 5.0,
        {
          kind: 'thaw_freeze',
          chunkX: cx, chunkZ: cz,
          frozen: isFrozen === 1,
          instantTemp: avgInstant,
          meanTemp: avgMean,
          snowMass: avgSnow
        }
      );
      this._stats.mutationEventsEmitted++;
    }
    this._chunkFrozenState[slot] = isFrozen;

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
    this._chunkFrozenState[slot] = 0;
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
      this._cellPool.temp.push(this._chunkCellTemp[slot]);
      this._cellPool.snow.push(this._chunkCellSnow[slot]);
      this._zonePool.push(this._chunkCellZone[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellTemp[slot] = null;
    this._chunkCellSnow[slot] = null;
    this._chunkCellZone[slot] = null;
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

  _acquireZone() {
    if (this._zonePool.length > 0) {
      const arr = this._zonePool.pop();
      arr.fill(0);
      return arr;
    }
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getTemperatureAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      annualMean: this._chunkMeanTemp[slot],
      winterMin: this._chunkMinTemp[slot],
      summerMax: this._chunkMaxTemp[slot],
      instant: this._chunkInstantTemp[slot],
      diurnalAmp: this._chunkDiurnalAmp[slot],
      seasonalAmp: this._chunkSeasonalAmp[slot],
      climateZone: this._chunkClimateZone[slot],
      climateZoneName: CLIMATE_ZONE_NAMES[this._chunkClimateZone[slot]],
      latitudeEffect: this._chunkLatitudeEffect[slot],
      elevationEffect: this._chunkElevationEffect[slot],
      interiorEffect: this._chunkInteriorEffect[slot],
      oceanEffect: this._chunkOceanEffect[slot],
      cloudEffect: this._chunkCloudEffect[slot],
      weatherEffect: this._chunkWeatherEffect[slot],
      snowlineAltitude: this._chunkSnowLineAlt[slot],
      snowMass: this._chunkSnowMass[slot],
      gdd: this._chunkGDD[slot],
      frostRisk: this._chunkFrostRisk[slot],
      biomeSuitability: this._chunkBiomeTempSuitability[slot],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        temp: this._chunkCellTemp[slot],
        snow: this._chunkCellSnow[slot],
        zone: this._chunkCellZone[slot]
      }
    };
  }

  // Fast sample: instantaneous temperature at a point.
  sampleTemperatureAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    if (!frame) return this._globalClimate.avgInstantTemp;
    const altitude = this._getHeight(wx, wz);
    return this._computeInstantTemp(wx, wz, altitude, frame);
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getTemperatureMaterialParams(preset) {
    return TEMPERATURE_MATERIAL[preset] || TEMPERATURE_MATERIAL.THERMAL_ROCK;
  }

  // Blend material params based on temperature.
  blendTemperatureMaterial(temperature, moisture, out) {
    let preset = 'THERMAL_ROCK';
    if (temperature < -5) preset = 'SNOW_FRESH';
    else if (temperature < 0) preset = 'SNOW_PACKED';
    else if (temperature < 3) preset = 'SNOW_MELTING';
    else if (temperature < 8) preset = 'SLUSH';
    else if (temperature > 50) preset = 'HOT_ROCK';

    const src = TEMPERATURE_MATERIAL[preset];
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

    o.sparkle = src.sparkle;
    o.frostiness = src.frostiness * (1 - moisture * 0.3);

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.temperature) {
      spatial.temperature = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        meanTemp: this._chunkMeanTemp,
        winterMin: this._chunkMinTemp,
        summerMax: this._chunkMaxTemp,
        instantTemp: this._chunkInstantTemp,
        diurnalAmp: this._chunkDiurnalAmp,
        seasonalAmp: this._chunkSeasonalAmp,
        climateZone: this._chunkClimateZone,
        latitudeEffect: this._chunkLatitudeEffect,
        elevationEffect: this._chunkElevationEffect,
        interiorEffect: this._chunkInteriorEffect,
        oceanEffect: this._chunkOceanEffect,
        cloudEffect: this._chunkCloudEffect,
        weatherEffect: this._chunkWeatherEffect,
        snowlineAltitude: this._chunkSnowLineAlt,
        snowMass: this._chunkSnowMass,
        gdd: this._chunkGDD,
        frostRisk: this._chunkFrostRisk,
        biomeSuitability: this._chunkBiomeTempSuitability,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          temp: this._chunkCellTemp,
          snow: this._chunkCellSnow,
          zone: this._chunkCellZone
        },
        materialParams: TEMPERATURE_MATERIAL,
        zoneNames: CLIMATE_ZONE_NAMES,
        thresholds: this.thresholds
      };
    }

    const t = spatial.temperature;
    t.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (t.chunkCount >= this._chunkCap) break;
      t.chunkCX[t.chunkCount] = this._chunkCX[i];
      t.chunkCZ[t.chunkCount] = this._chunkCZ[i];
      t.chunkSlots[t.chunkCount] = i;
      t.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    let sumMean = 0, sumInstant = 0, sumDiurnal = 0, sumSeasonal = 0;
    let sumGDD = 0, sumSnow = 0, sumFrost = 0, sumSnowline = 0;
    let chunksWithTemp = 0;
    let polarChunks = 0, tropicalChunks = 0, snowChunks = 0, frostChunks = 0;
    const zoneCount = new Uint16Array(CLIMATE_ZONE_NAMES.length);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      chunksWithTemp++;
      sumMean += this._chunkMeanTemp[i];
      sumInstant += this._chunkInstantTemp[i];
      sumDiurnal += this._chunkDiurnalAmp[i];
      sumSeasonal += this._chunkSeasonalAmp[i];
      sumGDD += this._chunkGDD[i];
      sumSnow += this._chunkSnowMass[i];
      sumFrost += this._chunkFrostRisk[i];
      sumSnowline += this._chunkSnowLineAlt[i];
      zoneCount[this._chunkClimateZone[i]]++;
      if (this._chunkClimateZone[i] <= CLIMATE_ZONE.SUBPOLAR) polarChunks++;
      if (this._chunkClimateZone[i] >= CLIMATE_ZONE.TROPICAL) tropicalChunks++;
      if (this._chunkSnowMass[i] > 5) snowChunks++;
      if (this._chunkFrostRisk[i] > 0.5) frostChunks++;
    }

    const gc = this._globalClimate;
    gc.avgMeanTemp = chunksWithTemp > 0 ? sumMean / chunksWithTemp : 15;
    gc.avgInstantTemp = chunksWithTemp > 0 ? sumInstant / chunksWithTemp : 15;
    gc.avgDiurnalAmp = chunksWithTemp > 0 ? sumDiurnal / chunksWithTemp : 6;
    gc.avgSeasonalAmp = chunksWithTemp > 0 ? sumSeasonal / chunksWithTemp : 5;
    gc.gddAverage = chunksWithTemp > 0 ? sumGDD / chunksWithTemp : 0;
    gc.snowFraction = chunksWithTemp > 0 ? snowChunks / chunksWithTemp : 0;
    gc.frostFraction = chunksWithTemp > 0 ? frostChunks / chunksWithTemp : 0;
    gc.polarFraction = chunksWithTemp > 0 ? polarChunks / chunksWithTemp : 0;
    gc.tropicalFraction = chunksWithTemp > 0 ? tropicalChunks / chunksWithTemp : 0;
    gc.snowlineAverage = chunksWithTemp > 0 ? sumSnowline / chunksWithTemp : 3000;

    // Dominant zone.
    let dominantZone = 0;
    let maxCount = 0;
    for (let z = 0; z < zoneCount.length; z++) {
      if (zoneCount[z] > maxCount) { maxCount = zoneCount[z]; dominantZone = z; }
    }
    gc.dominantZone = dominantZone;

    if (!physical.climateTemperature) {
      physical.climateTemperature = {};
    }
    Object.assign(physical.climateTemperature, gc);

    // Material-facing aggregates.
    physical.ambientTemperature = gc.avgInstantTemp;
    physical.meanTemperature = gc.avgMeanTemp;
    physical.diurnalAmplitude = gc.avgDiurnalAmp;
    physical.seasonalAmplitude = gc.avgSeasonalAmp;
    physical.growingDegreeDays = gc.gddAverage;
    physical.snowlineAltitude = gc.snowlineAverage;
    physical.snowCoverage = gc.snowFraction;
    physical.frostCoverage = gc.frostFraction;
    physical.climateZone = dominantZone;
    physical.climateZoneName = CLIMATE_ZONE_NAMES[dominantZone];

    // Zone distribution for materials.
    if (!physical.climateZoneWeights) {
      physical.climateZoneWeights = new Float32Array(CLIMATE_ZONE_NAMES.length);
    }
    if (chunksWithTemp > 0) {
      for (let z = 0; z < zoneCount.length; z++) {
        physical.climateZoneWeights[z] = zoneCount[z] / chunksWithTemp;
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
      const slot = this._getChunkSlot(cx, cz);
      if (slot >= 0 && this._chunkCellCount[slot] > 0) continue;
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

  setConstants(params) {
    for (const k of Object.keys(this.constants)) {
      if (params[k] !== undefined) this.constants[k] = params[k];
    }
    return this;
  }

  setThresholds(params) {
    for (const k of Object.keys(this.thresholds)) {
      if (params[k] !== undefined) this.thresholds[k] = params[k];
    }
    return this;
  }

  setLatitudeConfig(config) {
    if (config.latitudeBase !== undefined) this.defaults.latitudeBase = config.latitudeBase;
    if (config.latitudeRange !== undefined) this.defaults.latitudeRange = config.latitudeRange;
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
  getGlobalClimate() { return { ...this._globalClimate }; }

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
    this._continental = null;
    this._bathymetry = null;
    this._groundwater = null;
    this._moisture = null;
    this._decomposers = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._zonePool.length = 0;
  }
}

export {
  ClimateTemperatureProvider,
  CLIMATE_ZONE,
  CLIMATE_ZONE_NAMES,
  CLIMATE_CONSTANTS,
  CLIMATE_THRESHOLDS,
  TEMPERATURE_MATERIAL,
  CLIMATE_TEMP_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};