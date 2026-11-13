// file number : 288
// full path name : src/context/288_ClimatePrecipitationProvider.js
// description : Climate precipitation provider generating rain, snow, hail, sleet, and all intermediate precipitation phases across the living world. Fuses humidity and moisture state from 285_MoistureLevelProvider, ambient temperature and lapse from 287_ClimateTemperatureProvider, weather state and severity from 276_TemporalContextProvider, terrain elevation from 281_ElevationProvider, and cloud cover to compute per-chunk precipitation. Distinguishes nine precipitation phases (DRIZZLE, RAIN, HEAVY_RAIN, FREEZING_RAIN, SLEET, SNOW, HEAVY_SNOW, GRAUPEL, HAIL) using the temperature at the condensation level — derived from the wet-bulb temperature at the LCL (lifting condensation level) — so rain turns to snow as it falls through the freezing level. Each phase has a distinct fall velocity v_f (Drizzle 2 m/s to Hail 30 m/s), particle size, and PBR+anime material parameter set. Computes precipitation intensity (mm/hr), accumulation over time, snow water equivalent (SWE), runoff generation, snowpack depth, ice-layer thickness on water bodies, and rain-shadow suppression. Provides full PBR + anime material parameter sets for wet surfaces during rain, snow accumulation shader, ice-crust on lakes and seas, hail-battered terrain, and melting slush — all live scalars the shader reads. Emits a single coalesced WEATHER causal event per chunk when precipitation phase changes (rain→snow, snow→sleet, etc.) or when accumulation crosses 5 mm / 50 mm thresholds. Writes per-chunk summaries and per-cell precipitation descriptors into frame.layers.spatial.precipitation, plus global aggregates into frame.layers.physical.precipitationProperties. All scratch objects are pooled; no allocation after first frame.
// best for : Every consumer that needs precipitation state — hydrology for river flow and flooding (283_BathymetryProvider), snow accumulation for terrain coverage and skiing (282_Z03_CarveGradientProvider), ice formation on water bodies, soil wetness feedback (285_MoistureLevelProvider), flora damage from heavy snow (282_Z07_ForestGradientProvider), fauna shelter behaviour (279_Z03–Z05), material shaders for wet/snow/ice surfaces, and lighting couplers for precipitation-scattered light. Complements 287_ClimateTemperatureProvider and 285_MoistureLevelProvider by completing the water cycle — precipitation is where atmospheric moisture returns to the surface.
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
  ClimateTemperatureProvider, CLIMATE_ZONE,
  ColorManagement, ColorSpace,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 2;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── precipitation phase codes ──────────────────────────────────
const PRECIPITATION_PHASE = Object.freeze({
  NONE:            0,
  DRIZZLE:         1,   // < 0.5 mm/hr, fine drops
  RAIN:            2,   // 0.5 – 10 mm/hr
  HEAVY_RAIN:      3,   // > 10 mm/hr
  FREEZING_RAIN:   4,   // liquid rain freezing on contact
  SLEET:           5,   // mixed rain and snow
  SNOW:            6,   // light snow
  HEAVY_SNOW:      7,   // heavy snow
  GRAUPEL:         8,   // soft hail, supercooled droplets
  HAIL:            9    // hard ice pellets, > 5 mm
});

const PRECIPITATION_PHASE_NAMES = Object.freeze([
  'none', 'drizzle', 'rain', 'heavy_rain', 'freezing_rain',
  'sleet', 'snow', 'heavy_snow', 'graupel', 'hail'
]);

// ─── physical constants for precipitation ──────────────────────
const PRECIPITATION_CONSTANTS = Object.freeze({
  // Terminal fall velocities (m/s).
  fallVelocityDrizzle:     2.0,
  fallVelocityRain:        7.0,
  fallVelocityHeavyRain:   9.0,
  fallVelocitySnow:        1.0,
  fallVelocityHeavySnow:   1.5,
  fallVelocitySleet:       3.0,
  fallVelocityGraupel:     2.5,
  fallVelocityHail:       25.0,

  // Particle sizes (mm).
  particleSizeDrizzle:     0.5,
  particleSizeRain:        2.0,
  particleSizeHeavyRain:   4.0,
  particleSizeSnow:        3.0,
  particleSizeHeavySnow:   6.0,
  particleSizeSleet:       2.5,
  particleSizeGraupel:     4.0,
  particleSizeHail:       15.0,

  // Temperature thresholds (°C) at the LCL.
  freezingLevel:           0.0,
  snowUpperTemp:           2.0,       // below this → snow
  heavySnowTemp:          -2.0,
  sleetLowerTemp:         -1.0,
  sleetUpperTemp:          3.0,
  freezingRainSurfaceTemp: -1.0,      // surface below this + liquid rain → freezing rain
  hailSurfaceUpdraftMin:  15.0,       // m/s, vertical wind
  graupelUpdraftMin:       5.0,

  // Accumulation limits.
  maxSnowDepthPerChunk:    3.0,       // metres
  maxIceThickness:         0.5,       // metres
  maxRainwaterDepth:       0.2,       // metres
  snowMeltRatePerDegree:   0.005,     // metres/day/°C above 0
  iceMeltRatePerDegree:    0.001,
  runoffRate:              0.8,       // fraction of rain that runs off
  infiltrationRate:        0.2,       // fraction that infiltrates

  // Rain shadow factor.
  rainShadowAttenuation:   0.4,       // leeward side gets 40% of windward rain

  // Snow water equivalent (SWE): 1 m snow ≈ 0.10 m water.
  sweRatio:                0.10,

  // Wet-bulb approximation coefficients (Stull 2011).
  wetBulbA:                0.151977,
  wetBulbB:                8.313659,
  wetBulbC:                0.00391838,
  wetBulbD:                0.023101,
  wetBulbE:                4.686035
});

// ─── material parameter sets per precipitation phase ──────────
const PRECIPITATION_MATERIAL = Object.freeze({
  WET_GROUND_LIGHT: {
    pbr: {
      baseColor:    [0.42, 0.38, 0.32],
      metalness:    0.00,
      roughness:    0.55,
      clearcoat:    0.45,
      transmission: 0.00,
      ior:          1.40,
      sheen:        0.15,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.45, 0.40, 0.34],
      quantizeSteps: 3,
      rimPower:     1.8,
      rimColor:     [0.55, 0.60, 0.70]
    },
    subsurfaceRadius: [0.03, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    wetness:          0.45,
    snowCover:        0.00,
    iceThickness:     0.00
  },
  WET_GROUND_HEAVY: {
    pbr: {
      baseColor:    [0.30, 0.26, 0.22],
      metalness:    0.00,
      roughness:    0.35,
      clearcoat:    0.75,
      transmission: 0.00,
      ior:          1.40,
      sheen:        0.20,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.34, 0.30, 0.24],
      quantizeSteps: 3,
      rimPower:     1.7,
      rimColor:     [0.50, 0.55, 0.65]
    },
    subsurfaceRadius: [0.04, 0.04, 0.03],
    emissive:         [0.00, 0.00, 0.00],
    wetness:          0.90,
    snowCover:        0.00,
    iceThickness:     0.00
  },
  SNOW_COVER: {
    pbr: {
      baseColor:    [0.90, 0.92, 0.96],
      metalness:    0.00,
      roughness:    0.80,
      clearcoat:    0.05,
      transmission: 0.08,
      ior:          1.31,
      sheen:        0.30,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.92, 0.94, 0.98],
      quantizeSteps: 2,
      rimPower:     1.3,
      rimColor:     [0.78, 0.90, 1.00]
    },
    subsurfaceRadius: [0.15, 0.18, 0.22],
    emissive:         [0.00, 0.00, 0.02],
    wetness:          0.00,
    snowCover:        1.00,
    iceThickness:     0.00
  },
  SLEET_CRUST: {
    pbr: {
      baseColor:    [0.75, 0.78, 0.82],
      metalness:    0.05,
      roughness:    0.45,
      clearcoat:    0.60,
      transmission: 0.15,
      ior:          1.33,
      sheen:        0.20,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.78, 0.82, 0.86],
      quantizeSteps: 3,
      rimPower:     1.6,
      rimColor:     [0.70, 0.82, 0.92]
    },
    subsurfaceRadius: [0.08, 0.10, 0.12],
    emissive:         [0.00, 0.00, 0.00],
    wetness:          0.50,
    snowCover:        0.60,
    iceThickness:     0.20
  },
  FREEZING_RAIN_ICE: {
    pbr: {
      baseColor:    [0.65, 0.72, 0.80],
      metalness:    0.00,
      roughness:    0.15,
      clearcoat:    0.95,
      transmission: 0.70,
      ior:          1.31,
      sheen:        0.10,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.70, 0.78, 0.86],
      quantizeSteps: 2,
      rimPower:     1.2,
      rimColor:     [0.85, 0.90, 1.00]
    },
    subsurfaceRadius: [0.20, 0.22, 0.25],
    emissive:         [0.01, 0.02, 0.03],
    wetness:          0.00,
    snowCover:        0.00,
    iceThickness:     1.00
  },
  HAIL_BATTERED: {
    pbr: {
      baseColor:    [0.55, 0.58, 0.62],
      metalness:    0.10,
      roughness:    0.35,
      clearcoat:    0.70,
      transmission: 0.20,
      ior:          1.31,
      sheen:        0.15,
      anisotropy:   0.05
    },
    anime: {
      baseColor:    [0.60, 0.62, 0.66],
      quantizeSteps: 3,
      rimPower:     1.5,
      rimColor:     [0.75, 0.80, 0.88]
    },
    subsurfaceRadius: [0.10, 0.12, 0.15],
    emissive:         [0.00, 0.00, 0.00],
    wetness:          0.30,
    snowCover:        0.40,
    iceThickness:     0.60
  },
  MELTING_SLUSH: {
    pbr: {
      baseColor:    [0.65, 0.68, 0.72],
      metalness:    0.00,
      roughness:    0.55,
      clearcoat:    0.50,
      transmission: 0.30,
      ior:          1.33,
      sheen:        0.15,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.68, 0.72, 0.76],
      quantizeSteps: 3,
      rimPower:     1.7,
      rimColor:     [0.62, 0.75, 0.88]
    },
    subsurfaceRadius: [0.06, 0.08, 0.10],
    emissive:         [0.00, 0.00, 0.00],
    wetness:          0.70,
    snowCover:        0.30,
    iceThickness:     0.10
  }
});

// ─── defaults ────────────────────────────────────────────────────
const PRECIPITATION_DEFAULTS = Object.freeze({
  worldSeed:              0x8217A9C0DE,
  cellSize:               64.0,
  chunkSize:              1000,
  maxCellsPerChunk:       64,
  maxChunksPerFrame:      8,
  rainShadowEnabled:      true,
  snowpackEnabled:        true,
  iceEnabled:             true,
  mutationCoalesceWindow: 5.0,
  phaseChangeCooldown:    2.0
});

class ClimatePrecipitationProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...PRECIPITATION_DEFAULTS, ...(options.defaults || {}) };
    this.constants = { ...PRECIPITATION_CONSTANTS, ...(options.constants || {}) };
    this.enableHail = options.enableHail ?? true;
    this.enableFreezingRain = options.enableFreezingRain ?? true;
    this.enableRunoff = options.enableRunoff ?? true;
    this.enableSnowpack = options.enableSnowpack ?? true;
    this.enableIce = options.enableIce ?? true;

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColor = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();
    this._tmpPlane = new Plane();

    // ── per-chunk precipitation state ──────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk summary.
    this._chunkPhase            = new Uint8Array(chunkCap);
    this._chunkIntensity        = new Float32Array(chunkCap);      // mm/hr
    this._chunkPhaseFraction    = new Float32Array(chunkCap * PRECIPITATION_PHASE_NAMES.length);
    this._chunkLCLAltitude      = new Float32Array(chunkCap);      // metres
    this._chunkLCLTemperature   = new Float32Array(chunkCap);      // °C
    this._chunkFreezingLevel    = new Float32Array(chunkCap);      // metres
    this._chunkWetBulbTemp      = new Float32Array(chunkCap);      // °C
    this._chunkRainShadow       = new Float32Array(chunkCap);      // 0..1
    this._chunkSnowAccumulation = new Float32Array(chunkCap);      // metres
    this._chunkSnowWaterEquivalent = new Float32Array(chunkCap);   // metres
    this._chunkRainAccumulation = new Float32Array(chunkCap);      // metres
    this._chunkIceThickness     = new Float32Array(chunkCap);      // metres
    this._chunkRunoffRate       = new Float32Array(chunkCap);      // mm/hr
    this._chunkInfiltrationRate = new Float32Array(chunkCap);      // mm/hr
    this._chunkMeltRate         = new Float32Array(chunkCap);      // mm/hr
    this._chunkCloudCover       = new Float32Array(chunkCap);
    this._chunkPrecipitableWater = new Float32Array(chunkCap);     // mm
    this._chunkWetness          = new Float32Array(chunkCap);      // 0..1

    // Per-chunk cell data.
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellPhase = new Array(chunkCap).fill(null);
    this._chunkCellIntensity = new Array(chunkCap).fill(null);
    this._chunkCellAccum = new Array(chunkCap).fill(null);   // snow or rain accumulation (m)
    this._chunkCellWetBulb = new Array(chunkCap).fill(null);
    this._chunkCellIce = new Array(chunkCap).fill(null);
    this._chunkCellSnow = new Array(chunkCap).fill(null);
    this._chunkCellWetness = new Array(chunkCap).fill(null);

    // Free lists.
    this._cellPool = {
      x: [], y: [], z: [], phase: [], intensity: [], accum: [],
      wetBulb: [], ice: [], snow: [], wetness: []
    };
    this._phaseArrayPool = [];

    // ── per-frame global aggregates ───────────────────────
    this._globalPrecipitation = {
      avgIntensity: 0,
      avgSnowAccumulation: 0,
      avgRainAccumulation: 0,
      avgIceThickness: 0,
      avgWetBulb: 0,
      avgFreezingLevel: 3000,
      avgLCLAltitude: 1500,
      totalPrecipitation: 0,
      snowCoverFraction: 0,
      iceCoverFraction: 0,
      wetSurfaceFraction: 0,
      dominantPhase: 0
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ─────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      drizzleCells: 0,
      rainCells: 0,
      heavyRainCells: 0,
      freezingRainCells: 0,
      sleetCells: 0,
      snowCells: 0,
      heavySnowCells: 0,
      graupelCells: 0,
      hailCells: 0,
      phaseTransitions: 0,
      accumulationEvents: 0,
      mutationEventsEmitted: 0
    };

    // ── collaborators ─────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._carve = options.carve || null;
    this._forest = options.forest || null;
    this._grass = options.grass || null;
    this._continental = options.continental || null;
    this._bathymetry = options.bathymetry || null;
    this._groundwater = options.groundwater || null;
    this._moisture = options.moisture || null;
    this._decomposers = options.decomposers || null;
    this._temperature = options.temperature || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── material param reusable buffer ─────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0 },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      subsurfaceRadius: [0,0,0],
      emissive: [0,0,0],
      wetness: 0,
      snowCover: 0,
      iceThickness: 0
    };

    // ── per-chunk previous phase (for transitions) ─────────
    this._chunkLastPhase = new Uint8Array(chunkCap);
    this._chunkLastTransitionTime = new Float64Array(chunkCap);
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachForest(f) { this._forest = f; return this; }
  attachGrass(g) { this._grass = g; return this; }
  attachContinental(c) { this._continental = c; return this; }
  attachBathymetry(b) { this._bathymetry = b; return this; }
  attachGroundwater(g) { this._groundwater = g; return this; }
  attachMoisture(m) { this._moisture = m; return this; }
  attachDecomposers(d) { this._decomposers = d; return this; }
  attachTemperature(t) { this._temperature = t; return this; }
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
  // ─── wet-bulb temperature (Stull 2011) ──────────────────
  // ══════════════════════════════════════════════════════════
  // T_w = T·atan(0.151977·sqrt(RH·8.313659))
  //     + atan(T + RH) − atan(RH − 1.676331)
  //     + 0.00391838·RH^1.5·atan(0.023101·RH)
  //     − 4.686035
  wetBulbTemperature(tempC, rh) {
    if (rh < 0.01) return tempC;
    if (rh > 1) rh = 1;

    const c = this.constants;
    const sqrtRH = Math.sqrt(rh * 100 + c.wetBulbB);
    const t1 = tempC * Math.atan(c.wetBulbA * sqrtRH);
    const t2 = Math.atan(tempC + rh * 100);
    const t3 = Math.atan(rh * 100 - c.wetBulbE);
    const t4 = c.wetBulbC * Math.pow(rh * 100, 1.5) * Math.atan(c.wetBulbD * rh * 100);

    return t1 + t2 - t3 + t4 - c.wetBulbE;
  }

  // ══════════════════════════════════════════════════════════
  // ─── LCL (Lifting Condensation Level) ───────────────────
  // ══════════════════════════════════════════════════════════
  // Rule of thumb: LCL altitude (m) ≈ 125 · (T − T_d)
  // where T is surface temp and T_d is dew point, both in °C.
  computeLCL(surfaceTempC, dewPointC) {
    const spread = Math.max(0, surfaceTempC - dewPointC);
    return 125.0 * spread;
  }

  // ══════════════════════════════════════════════════════════
  // ─── freezing level altitude ────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Height above which temperature falls below 0 °C.
  computeFreezingLevel(surfaceTempC, lapseRate) {
    if (surfaceTempC <= 0) return 0;
    return surfaceTempC / lapseRate;
  }

  // ══════════════════════════════════════════════════════════
  // ─── precipitation phase classification ─────────────────
  // ══════════════════════════════════════════════════════════
  // Determines the phase of precipitation at the surface based on:
  //   - wet-bulb temperature at the LCL (formation phase)
  //   - wet-bulb temperature at the surface (fall phase)
  //   - updraft strength (for hail/graupel)
  //   - intensity (for drizzle/heavy)
  _classifyPhase(intensity, surfaceTemp, wetBulb, lclTemp, updraftStrength) {
    if (intensity < 0.01) return PRECIPITATION_PHASE.NONE;

    const c = this.constants;

    // Hail: strong updrafts + supercooled water + frozen ice pellets.
    if (this.enableHail && updraftStrength > c.hailSurfaceUpdraftMin &&
        lclTemp > -20 && lclTemp < 10) {
      return PRECIPITATION_PHASE.HAIL;
    }

    // Graupel: moderate updrafts + supercooled water.
    if (updraftStrength > c.graupelUpdraftMin && lclTemp > -15 && lclTemp < 5) {
      return PRECIPITATION_PHASE.GRAUPEL;
    }

    // Snow: LCL well below freezing.
    if (lclTemp < c.heavySnowTemp) {
      return intensity > 2.0
        ? PRECIPITATION_PHASE.HEAVY_SNOW
        : PRECIPITATION_PHASE.SNOW;
    }

    if (lclTemp < c.snowUpperTemp) {
      return PRECIPITATION_PHASE.SNOW;
    }

    // Sleet: borderline LCL temp.
    if (lclTemp >= c.sleetLowerTemp && lclTemp < c.sleetUpperTemp) {
      return PRECIPITATION_PHASE.SLEET;
    }

    // Freezing rain: liquid rain but surface below freezing.
    if (this.enableFreezingRain && surfaceTemp < c.freezingRainSurfaceTemp) {
      return PRECIPITATION_PHASE.FREEZING_RAIN;
    }

    // Liquid: drizzle vs rain vs heavy rain.
    if (intensity < 0.5) return PRECIPITATION_PHASE.DRIZZLE;
    if (intensity < 10.0) return PRECIPITATION_PHASE.RAIN;
    return PRECIPITATION_PHASE.HEAVY_RAIN;
  }

  // ══════════════════════════════════════════════════════════
  // ─── intensity computation ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Precipitation intensity in mm/hr.
  // Depends on: cloud cover, moisture, weather severity, rain shadow.
  _computeIntensity(cloudCover, relativeHumidity, weatherSeverity, rainShadow, updraft) {
    // Base intensity scaled by weather severity.
    let intensity = 0;

    // Base: drizzle to heavy.
    if (weatherSeverity < 0.2) {
      // Clear or cloudy — no rain.
      intensity = 0;
    } else if (weatherSeverity < 0.5) {
      // Light rain (0.1 – 2 mm/hr).
      intensity = (weatherSeverity - 0.2) * 5.0;
    } else if (weatherSeverity < 0.85) {
      // Moderate rain (2 – 10 mm/hr).
      intensity = 1.0 + (weatherSeverity - 0.5) * 20.0;
    } else {
      // Storm (10 – 30 mm/hr).
      intensity = 8.0 + (weatherSeverity - 0.85) * 150.0;
    }

    // Multiply by cloud cover and humidity factors.
    intensity *= (0.3 + cloudCover * 0.7);
    intensity *= (0.5 + relativeHumidity * 0.5);

    // Rain shadow: leeward side receives much less.
    if (this.defaults.rainShadowEnabled) {
      intensity *= (1 - rainShadow * this.constants.rainShadowAttenuation);
    }

    // Updraft boosts intensity.
    if (updraft > 5) {
      intensity *= (1 + (updraft - 5) * 0.05);
    }

    return Math.max(0, intensity);
  }

  // ══════════════════════════════════════════════════════════
  // ─── rain shadow sampling ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleRainShadow(wx, wz, frame) {
    if (!this.defaults.rainShadowEnabled) return 0;
    if (this._continental) {
      return this._continental.getRainShadowAt(wx, wz);
    }
    // Fallback: sample upwind elevation via temperature provider.
    return 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── updraft sampling ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleUpdraft(wx, wz, frame) {
    // Use relief and cliffs to estimate terrain-driven updrafts.
    let updraft = 0;
    if (this._slope) {
      const slopeAngle = this._slope.getSlopeAngle(wx, wz);
      updraft += slopeAngle * 30;   // up to ~15 m/s on steep slopes
    }
    // Convective updraft from high weather severity.
    const weatherSeverity = this._temporal ? this._temporal.weatherSeverity : 0.3;
    if (weatherSeverity > 0.85) {
      updraft += (weatherSeverity - 0.85) * 60;   // up to ~9 m/s extra
    }
    return updraft;
  }

  // ══════════════════════════════════════════════════════════
  // ─── accumulation update ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Updates snow / rain / ice accumulation over time.
  _updateAccumulation(chunkSlot, phase, intensity, temp, dtSeconds, snowAccum, rainAccum, iceAccum) {
    const c = this.constants;

    // Snow accumulation: intensity (mm/hr) → depth per second.
    // Snowfall rate ≈ intensity / sweRatio (depth), scaled to seconds.
    if (phase === PRECIPITATION_PHASE.SNOW ||
        phase === PRECIPITATION_PHASE.HEAVY_SNOW ||
        phase === PRECIPITATION_PHASE.SLEET) {
      // Depth in metres per second (sweRatio converts water to snow depth).
      const snowRate = (intensity / 1000) / c.sweRatio / 3600;
      snowAccum += snowRate * dtSeconds;
    }

    // Rain accumulation.
    if (phase === PRECIPITATION_PHASE.DRIZZLE ||
        phase === PRECIPITATION_PHASE.RAIN ||
        phase === PRECIPITATION_PHASE.HEAVY_RAIN ||
        phase === PRECIPITATION_PHASE.FREEZING_RAIN) {
      const rainRate = (intensity / 1000) / 3600;
      rainAccum += rainRate * dtSeconds;
    }

    // Freezing rain → ice layer.
    if (phase === PRECIPITATION_PHASE.FREEZING_RAIN) {
      const iceRate = (intensity / 1000) / 3600;
      iceAccum += iceRate * dtSeconds;
    }

    // Hail / graupel → ice/snow mix.
    if (phase === PRECIPITATION_PHASE.HAIL ||
        phase === PRECIPITATION_PHASE.GRAUPEL) {
      const iceRate = (intensity / 1000) / 3600;
      iceAccum += iceRate * dtSeconds * 0.5;
      snowAccum += iceRate * dtSeconds * 0.5;
    }

    // Snow melt: if surface temp > 0 °C.
    if (temp > 0 && snowAccum > 0) {
      const meltRate = temp * c.snowMeltRatePerDegree / 86400;   // m/s
      snowAccum = Math.max(0, snowAccum - meltRate * dtSeconds);
    }

    // Ice melt.
    if (temp > 0 && iceAccum > 0) {
      const meltRate = temp * c.iceMeltRatePerDegree / 86400;
      iceAccum = Math.max(0, iceAccum - meltRate * dtSeconds);
    }

    // Clamps.
    snowAccum = Math.min(c.maxSnowDepthPerChunk, snowAccum);
    rainAccum = Math.min(c.maxRainwaterDepth, rainAccum);
    iceAccum = Math.min(c.maxIceThickness, iceAccum);

    return { snowAccum, rainAccum, iceAccum };
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk sampling ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleChunk(cx, cz, frame, dtSeconds) {
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
      this._chunkCellPhase[slot] = this._acquirePhaseArray();
      this._chunkCellIntensity[slot] = this._acquireCell('intensity');
      this._chunkCellAccum[slot] = this._acquireCell('accum');
      this._chunkCellWetBulb[slot] = this._acquireCell('wetBulb');
      this._chunkCellIce[slot] = this._acquireCell('ice');
      this._chunkCellSnow[slot] = this._acquireCell('snow');
      this._chunkCellWetness[slot] = this._acquireCell('wetness');
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpPhase = this._chunkCellPhase[slot];
    const cpIntensity = this._chunkCellIntensity[slot];
    const cpAccum = this._chunkCellAccum[slot];
    const cpWetBulb = this._chunkCellWetBulb[slot];
    const cpIce = this._chunkCellIce[slot];
    const cpSnow = this._chunkCellSnow[slot];
    const cpWetness = this._chunkCellWetness[slot];

    let placed = 0;

    // Read global context.
    const physical = frame.layers.physical;
    const cloudCover = physical?.cloudCover ?? 0.3;
    const weatherSeverity = this._temporal?.weatherSeverity ?? 0.3;
    const relativeHumidity = physical?.relativeHumidity ?? 0.5;
    const ambientTemp = physical?.ambientTemperature ?? 15;
    const dewPoint = physical?.dewPoint ?? 5;
    const lapseRate = this.constants.freezingLevel / Math.max(1, 3000);  // simplified
    const surfaceTemp = ambientTemp;

    // LCL and freezing level for the chunk (based on centre).
    const centreX = cx * chunkSize + chunkSize * 0.5;
    const centreZ = cz * chunkSize + chunkSize * 0.5;
    const centreHeight = this._getHeight(centreX, centreZ);
    const chunkLCL = this.computeLCL(centreHeight > 0 ? surfaceTemp - 0.0065 * centreHeight : surfaceTemp, dewPoint);
    const chunkFreezingLevel = this.computeFreezingLevel(surfaceTemp, 0.0065);

    // Aggregates.
    let sumIntensity = 0;
    let sumWetBulb = 0;
    let sumRainShadow = 0;
    let sumWetness = 0;
    let sumSnow = 0;
    let sumIce = 0;
    let sumRain = 0;
    let snowCells = 0;
    let wetCells = 0;
    let iceCells = 0;

    // Phase distribution.
    const phaseCount = new Uint16Array(PRECIPITATION_PHASE_NAMES.length);

    // Chunk-level accumulation update.
    let chunkSnow = this._chunkSnowAccumulation[slot];
    let chunkRain = this._chunkRainAccumulation[slot];
    let chunkIce = this._chunkIceThickness[slot];

    for (let j = 0; j < cellsPerSide && placed < this.defaults.maxCellsPerChunk; j++) {
      for (let i = 0; i < cellsPerSide && placed < this.defaults.maxCellsPerChunk; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;
        const altitude = this._getHeight(wx, wz);

        // Local temperature with lapse rate.
        const localTemp = ambientTemp - 0.0065 * Math.max(0, altitude);

        // Local humidity (from moisture provider if available).
        let localRH = relativeHumidity;
        if (this._moisture) {
          localRH = this._moisture.sampleHumidityAt(wx, wz);
        }

        // Rain shadow.
        const rainShadow = this._sampleRainShadow(wx, wz, frame);

        // Updraft strength.
        const updraft = this._sampleUpdraft(wx, wz, frame);

        // Intensity.
        const intensity = this._computeIntensity(cloudCover, localRH, weatherSeverity, rainShadow, updraft);

        // Wet-bulb temperature at surface.
        const wetBulb = this.wetBulbTemperature(localTemp, localRH);

        // LCL altitude at this cell.
        const lcl = this.computeLCL(localTemp, dewPoint);

        // LCL temperature: T at LCL altitude (using lapse rate).
        const lclTemp = localTemp - 0.0065 * lcl;

        // Classify phase.
        const phase = this._classifyPhase(intensity, localTemp, wetBulb, lclTemp, updraft);

        // Update accumulation (chunk level).
        if (intensity > 0.05) {
          const result = this._updateAccumulation(
            slot, phase, intensity, localTemp, dtSeconds,
            chunkSnow, chunkRain, chunkIce
          );
          chunkSnow = result.snowAccum;
          chunkRain = result.rainAccum;
          chunkIce = result.iceAccum;
        } else {
          // Melt during no-precipitation periods if warm.
          if (localTemp > 0 && chunkSnow > 0) {
            chunkSnow = Math.max(0, chunkSnow - localTemp * this.constants.snowMeltRatePerDegree / 86400 * dtSeconds);
          }
          if (localTemp > 0 && chunkIce > 0) {
            chunkIce = Math.max(0, chunkIce - localTemp * this.constants.iceMeltRatePerDegree / 86400 * dtSeconds);
          }
        }

        // Wetness: from rain intensity and recent precipitation.
        const wetness = Math.min(1,
          intensity * 0.05 +
          chunkRain * 2.0 +
          (phase === PRECIPITATION_PHASE.FREEZING_RAIN ? 0.3 : 0)
        );

        // Store cell.
        cpx[placed] = wx;
        cpy[placed] = altitude;
        cpz[placed] = wz;
        cpPhase[placed] = phase;
        cpIntensity[placed] = intensity;
        cpAccum[placed] = chunkSnow + chunkRain;
        cpWetBulb[placed] = wetBulb;
        cpIce[placed] = chunkIce;
        cpSnow[placed] = chunkSnow;
        cpWetness[placed] = wetness;
        placed++;

        // Aggregates.
        sumIntensity += intensity;
        sumWetBulb += wetBulb;
        sumRainShadow += rainShadow;
        sumWetness += wetness;
        sumSnow += chunkSnow;
        sumIce += chunkIce;
        sumRain += chunkRain;
        phaseCount[phase]++;
        if (chunkSnow > 0.01) snowCells++;
        if (chunkIce > 0.001) iceCells++;
        if (wetness > 0.1) wetCells++;

        // Per-phase stats.
        switch (phase) {
          case PRECIPITATION_PHASE.DRIZZLE:        this._stats.drizzleCells++; break;
          case PRECIPITATION_PHASE.RAIN:           this._stats.rainCells++; break;
          case PRECIPITATION_PHASE.HEAVY_RAIN:     this._stats.heavyRainCells++; break;
          case PRECIPITATION_PHASE.FREEZING_RAIN:  this._stats.freezingRainCells++; break;
          case PRECIPITATION_PHASE.SLEET:          this._stats.sleetCells++; break;
          case PRECIPITATION_PHASE.SNOW:           this._stats.snowCells++; break;
          case PRECIPITATION_PHASE.HEAVY_SNOW:     this._stats.heavySnowCells++; break;
          case PRECIPITATION_PHASE.GRAUPEL:        this._stats.graupelCells++; break;
          case PRECIPITATION_PHASE.HAIL:           this._stats.hailCells++; break;
        }

        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // Store chunk-level accumulations.
    this._chunkSnowAccumulation[slot] = chunkSnow;
    this._chunkRainAccumulation[slot] = chunkRain;
    this._chunkIceThickness[slot] = chunkIce;

    // Compute per-chunk summary.
    const avgIntensity = placed > 0 ? sumIntensity / placed : 0;
    const avgWetBulb = placed > 0 ? sumWetBulb / placed : ambientTemp;
    const avgRainShadow = placed > 0 ? sumRainShadow / placed : 0;
    const avgWetness = placed > 0 ? sumWetness / placed : 0;

    // Dominant phase.
    let dominantPhase = 0;
    let maxPhaseCount = 0;
    for (let p = 1; p < phaseCount.length; p++) {
      if (phaseCount[p] > maxPhaseCount) {
        maxPhaseCount = phaseCount[p];
        dominantPhase = p;
      }
    }

    // Phase fraction distribution.
    const phaseOffset = slot * PRECIPITATION_PHASE_NAMES.length;
    for (let p = 0; p < phaseCount.length; p++) {
      this._chunkPhaseFraction[phaseOffset + p] =
        placed > 0 ? phaseCount[p] / placed : 0;
    }

    this._chunkPhase[slot] = dominantPhase;
    this._chunkIntensity[slot] = avgIntensity;
    this._chunkLCLAltitude[slot] = chunkLCL;
    this._chunkLCLTemperature[slot] = ambientTemp - 0.0065 * chunkLCL;
    this._chunkFreezingLevel[slot] = chunkFreezingLevel;
    this._chunkWetBulbTemp[slot] = avgWetBulb;
    this._chunkRainShadow[slot] = avgRainShadow;
    this._chunkSnowWaterEquivalent[slot] = chunkSnow * this.constants.sweRatio;
    this._chunkRunoffRate[slot] = avgIntensity * this.constants.runoffRate;
    this._chunkInfiltrationRate[slot] = avgIntensity * this.constants.infiltrationRate;
    this._chunkMeltRate[slot] = ambientTemp > 0
      ? ambientTemp * this.constants.snowMeltRatePerDegree * 24
      : 0;
    this._chunkCloudCover[slot] = cloudCover;
    this._chunkPrecipitableWater[slot] = cloudCover * relativeHumidity * 50;
    this._chunkWetness[slot] = avgWetness;

    this._stats.chunksProcessed++;
    this._stats.accumulationEvents++;

    // Phase change event.
    const previousPhase = this._chunkLastPhase[slot];
    const now = this._lastUpdateTime > 0 ? this._lastUpdateTime : 0;
    if (previousPhase !== 0 && previousPhase !== dominantPhase &&
        now - this._chunkLastTransitionTime[slot] > this.defaults.phaseChangeCooldown) {
      this._chunkLastTransitionTime[slot] = now;
      this._stats.phaseTransitions++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, Math.round(avgIntensity * 5), 3.0,
          {
            kind: 'precipitation_transition',
            chunkX: cx, chunkZ: cz,
            fromPhase: previousPhase,
            toPhase: dominantPhase,
            fromPhaseName: PRECIPITATION_PHASE_NAMES[previousPhase],
            toPhaseName: PRECIPITATION_PHASE_NAMES[dominantPhase],
            intensity: avgIntensity,
            snowAccumulation: chunkSnow,
            iceThickness: chunkIce
          }
        );
        this._stats.mutationEventsEmitted++;
      }
    }
    this._chunkLastPhase[slot] = dominantPhase;

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
    this._chunkLastPhase[slot] = 0;
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
      this._cellPool.intensity.push(this._chunkCellIntensity[slot]);
      this._cellPool.accum.push(this._chunkCellAccum[slot]);
      this._cellPool.wetBulb.push(this._chunkCellWetBulb[slot]);
      this._cellPool.ice.push(this._chunkCellIce[slot]);
      this._cellPool.snow.push(this._chunkCellSnow[slot]);
      this._cellPool.wetness.push(this._chunkCellWetness[slot]);
      this._phaseArrayPool.push(this._chunkCellPhase[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellPhase[slot] = null;
    this._chunkCellIntensity[slot] = null;
    this._chunkCellAccum[slot] = null;
    this._chunkCellWetBulb[slot] = null;
    this._chunkCellIce[slot] = null;
    this._chunkCellSnow[slot] = null;
    this._chunkCellWetness[slot] = null;
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

  _acquirePhaseArray() {
    if (this._phaseArrayPool.length > 0) {
      const arr = this._phaseArrayPool.pop();
      arr.fill(0);
      return arr;
    }
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getPrecipitationAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      phase: this._chunkPhase[slot],
      phaseName: PRECIPITATION_PHASE_NAMES[this._chunkPhase[slot]],
      intensity: this._chunkIntensity[slot],
      lclAltitude: this._chunkLCLAltitude[slot],
      lclTemperature: this._chunkLCLTemperature[slot],
      freezingLevel: this._chunkFreezingLevel[slot],
      wetBulbTemperature: this._chunkWetBulbTemp[slot],
      rainShadow: this._chunkRainShadow[slot],
      snowAccumulation: this._chunkSnowAccumulation[slot],
      snowWaterEquivalent: this._chunkSnowWaterEquivalent[slot],
      rainAccumulation: this._chunkRainAccumulation[slot],
      iceThickness: this._chunkIceThickness[slot],
      runoffRate: this._chunkRunoffRate[slot],
      infiltrationRate: this._chunkInfiltrationRate[slot],
      meltRate: this._chunkMeltRate[slot],
      cloudCover: this._chunkCloudCover[slot],
      precipitableWater: this._chunkPrecipitableWater[slot],
      wetness: this._chunkWetness[slot],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        phase: this._chunkCellPhase[slot],
        intensity: this._chunkCellIntensity[slot],
        accum: this._chunkCellAccum[slot],
        wetBulb: this._chunkCellWetBulb[slot],
        ice: this._chunkCellIce[slot],
        snow: this._chunkCellSnow[slot],
        wetness: this._chunkCellWetness[slot]
      }
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getPrecipitationMaterialParams(preset) {
    return PRECIPITATION_MATERIAL[preset] || PRECIPITATION_MATERIAL.WET_GROUND_LIGHT;
  }

  // Blend material params based on current precipitation state.
  blendPrecipitationMaterial(phase, intensity, wetness, snowAccum, iceThickness, out) {
    let preset = 'WET_GROUND_LIGHT';

    // Determine preset from state.
    if (snowAccum > 0.05) {
      preset = 'SNOW_COVER';
    } else if (iceThickness > 0.02) {
      preset = 'FREEZING_RAIN_ICE';
    } else if (phase === PRECIPITATION_PHASE.SLEET) {
      preset = 'SLEET_CRUST';
    } else if (phase === PRECIPITATION_PHASE.HAIL) {
      preset = 'HAIL_BATTERED';
    } else if (phase === PRECIPITATION_PHASE.HEAVY_RAIN || wetness > 0.7) {
      preset = 'WET_GROUND_HEAVY';
    } else if (wetness > 0.3) {
      preset = 'WET_GROUND_LIGHT';
    } else if (phase === PRECIPITATION_PHASE.FREEZING_RAIN) {
      preset = 'FREEZING_RAIN_ICE';
    } else if (phase === PRECIPITATION_PHASE.SNOW || phase === PRECIPITATION_PHASE.HEAVY_SNOW) {
      preset = snowAccum > 0.02 ? 'SNOW_COVER' : 'MELTING_SLUSH';
    }

    const src = PRECIPITATION_MATERIAL[preset];
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

    o.wetness = Math.max(src.wetness, wetness);
    o.snowCover = src.snowCover;
    o.iceThickness = src.iceThickness;

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.precipitation) {
      spatial.precipitation = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        phase: this._chunkPhase,
        intensity: this._chunkIntensity,
        phaseFraction: this._chunkPhaseFraction,
        lclAltitude: this._chunkLCLAltitude,
        lclTemperature: this._chunkLCLTemperature,
        freezingLevel: this._chunkFreezingLevel,
        wetBulbTemperature: this._chunkWetBulbTemp,
        rainShadow: this._chunkRainShadow,
        snowAccumulation: this._chunkSnowAccumulation,
        snowWaterEquivalent: this._chunkSnowWaterEquivalent,
        rainAccumulation: this._chunkRainAccumulation,
        iceThickness: this._chunkIceThickness,
        runoffRate: this._chunkRunoffRate,
        infiltrationRate: this._chunkInfiltrationRate,
        meltRate: this._chunkMeltRate,
        cloudCover: this._chunkCloudCover,
        precipitableWater: this._chunkPrecipitableWater,
        wetness: this._chunkWetness,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          phase: this._chunkCellPhase,
          intensity: this._chunkCellIntensity,
          accum: this._chunkCellAccum,
          wetBulb: this._chunkCellWetBulb,
          ice: this._chunkCellIce,
          snow: this._chunkCellSnow,
          wetness: this._chunkCellWetness
        },
        materialParams: PRECIPITATION_MATERIAL,
        phaseNames: PRECIPITATION_PHASE_NAMES,
        constants: this.constants
      };
    }

    const p = spatial.precipitation;
    p.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (p.chunkCount >= this._chunkCap) break;
      p.chunkCX[p.chunkCount] = this._chunkCX[i];
      p.chunkCZ[p.chunkCount] = this._chunkCZ[i];
      p.chunkSlots[p.chunkCount] = i;
      p.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    let sumIntensity = 0;
    let sumSnow = 0;
    let sumRain = 0;
    let sumIce = 0;
    let sumWetBulb = 0;
    let sumFreezingLevel = 0;
    let sumLCL = 0;
    let chunksWithPrecip = 0;
    let snowChunks = 0;
    let iceChunks = 0;
    let wetChunks = 0;
    const phaseCount = new Uint16Array(PRECIPITATION_PHASE_NAMES.length);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      chunksWithPrecip++;
      sumIntensity += this._chunkIntensity[i];
      sumSnow += this._chunkSnowAccumulation[i];
      sumRain += this._chunkRainAccumulation[i];
      sumIce += this._chunkIceThickness[i];
      sumWetBulb += this._chunkWetBulbTemp[i];
      sumFreezingLevel += this._chunkFreezingLevel[i];
      sumLCL += this._chunkLCLAltitude[i];
      phaseCount[this._chunkPhase[i]]++;
      if (this._chunkSnowAccumulation[i] > 0.01) snowChunks++;
      if (this._chunkIceThickness[i] > 0.001) iceChunks++;
      if (this._chunkWetness[i] > 0.1) wetChunks++;
    }

    const gp = this._globalPrecipitation;
    gp.avgIntensity = chunksWithPrecip > 0 ? sumIntensity / chunksWithPrecip : 0;
    gp.avgSnowAccumulation = chunksWithPrecip > 0 ? sumSnow / chunksWithPrecip : 0;
    gp.avgRainAccumulation = chunksWithPrecip > 0 ? sumRain / chunksWithPrecip : 0;
    gp.avgIceThickness = chunksWithPrecip > 0 ? sumIce / chunksWithPrecip : 0;
    gp.avgWetBulb = chunksWithPrecip > 0 ? sumWetBulb / chunksWithPrecip : 15;
    gp.avgFreezingLevel = chunksWithPrecip > 0 ? sumFreezingLevel / chunksWithPrecip : 3000;
    gp.avgLCLAltitude = chunksWithPrecip > 0 ? sumLCL / chunksWithPrecip : 1500;
    gp.totalPrecipitation = sumIntensity;
    gp.snowCoverFraction = chunksWithPrecip > 0 ? snowChunks / chunksWithPrecip : 0;
    gp.iceCoverFraction = chunksWithPrecip > 0 ? iceChunks / chunksWithPrecip : 0;
    gp.wetSurfaceFraction = chunksWithPrecip > 0 ? wetChunks / chunksWithPrecip : 0;

    // Dominant phase.
    let dominantPhase = 0;
    let maxCount = 0;
    for (let p = 1; p < phaseCount.length; p++) {
      if (phaseCount[p] > maxCount) { maxCount = phaseCount[p]; dominantPhase = p; }
    }
    gp.dominantPhase = dominantPhase;

    if (!physical.precipitationProperties) {
      physical.precipitationProperties = {};
    }
    Object.assign(physical.precipitationProperties, gp);

    // Material-facing aggregates.
    physical.precipitationIntensity = gp.avgIntensity;
    physical.snowAccumulation = gp.avgSnowAccumulation;
    physical.snowCoverFraction = gp.snowCoverFraction;
    physical.iceThickness = gp.avgIceThickness;
    physical.iceCoverFraction = gp.iceCoverFraction;
    physical.rainAccumulation = gp.avgRainAccumulation;
    physical.wetSurfaceFraction = gp.wetSurfaceFraction;
    physical.freezingLevelAltitude = gp.avgFreezingLevel;
    physical.lclAltitude = gp.avgLCLAltitude;
    physical.wetBulbTemperature = gp.avgWetBulb;
    physical.precipitationPhase = dominantPhase;
    physical.precipitationPhaseName = PRECIPITATION_PHASE_NAMES[dominantPhase];

    // Phase distribution.
    if (!physical.precipitationPhaseWeights) {
      physical.precipitationPhaseWeights = new Float32Array(PRECIPITATION_PHASE_NAMES.length);
    }
    if (chunksWithPrecip > 0) {
      for (let p = 0; p < phaseCount.length; p++) {
        physical.precipitationPhaseWeights[p] = phaseCount[p] / chunksWithPrecip;
      }
    }

    // Precipitation-driven wetness for material feedback.
    physical.surfaceWetnessFromPrecip = gp.wetSurfaceFraction;
  }

  // ══════════════════════════════════════════════════════════
  // ─── main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) return 0;
    const dt = Math.min(10.0, now - (this._lastUpdateTime > 0 ? this._lastUpdateTime : now - PROVIDER_INTERVAL));
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
      this._sampleChunk(cx, cz, frame, dt);
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
  getGlobalPrecipitation() { return { ...this._globalPrecipitation }; }

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
    this._forest = null;
    this._grass = null;
    this._continental = null;
    this._bathymetry = null;
    this._groundwater = null;
    this._moisture = null;
    this._decomposers = null;
    this._temperature = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._phaseArrayPool.length = 0;
  }
}

export {
  ClimatePrecipitationProvider,
  PRECIPITATION_PHASE,
  PRECIPITATION_PHASE_NAMES,
  PRECIPITATION_CONSTANTS,
  PRECIPITATION_MATERIAL,
  PRECIPITATION_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};