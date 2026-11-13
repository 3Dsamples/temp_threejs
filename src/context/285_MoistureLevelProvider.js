// file number : 285
// full path name : src/context/285_MoistureLevelProvider.js
// description : Moisture level provider fusing groundwater, bathymetry, precipitation, vegetation, wind, and temperature into a coherent humidity / fog / mist / dew field for the living world. Builds on 276_TemporalContextProvider (weather + season), 281_ElevationProvider (temperature falloff), 282_SlopeGradientProvider (drainage), 282_Z07_ForestGradientProvider (transpiration), 282_Z08_GrassAndFlowresGradientProvider (ground cover evaporation), 283_BathymetryProvider (water surface evaporation), and 284_GroundwaterProvider (soil moisture + springs) to compute per-chunk and per-entity moisture state. For each sample it computes: relative humidity RH(x,z) = e(x,z) / e_s(T) where e is actual vapour pressure (from groundwater + evapotranspiration + water surfaces) and e_s(T) is the Magnus-formula saturation vapour pressure e_s = 6.112·exp(17.67·T / (T + 243.5)) (T in °C, e_s in hPa); dew point T_d = (243.5 · ln(e/6.112)) / (17.67 − ln(e/6.112)); fog density ρ_fog = A · exp(−(z − z_base) / H_fog) when RH > RH_crit; mist density from the same formula at lower amplitude; and orographic moisture enhancement from wind + slope. Provides a full PBR + anime material parameter set for wet surfaces (water film, wet rock, wet foliage, wet soil), for fog and mist scattering (Rayleigh coefficients for clear-air, Mie coefficients for fog), and for cloud cover. Emits a single coalesced WEATHER causal event when a chunk transitions across a humidity or fog threshold (dry → humid, humid → fog, fog → clear). Writes per-chunk summaries into frame.layers.spatial.moisture and per-entity descriptors plus global aggregates into frame.layers.physical.moistureProperties. All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs moisture state — the material shader for wet-surface blending, the atmosphere shader for fog and scattering, the lighting coupler for cloud-shadow attenuation, the flora sway system for leaf wetness (heavier when wet), the fauna spawner for humidity preference, biome assignment for tropical/marsh detection, and the sky coupler for cloud coverage. Complements 283_BathymetryProvider (surface water) and 284_GroundwaterProvider (subsurface water) by completing the water cycle's atmospheric leg.
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
  SlopeGradientProvider, SLOPE_BAND, SLOPE_BAND_THRESHOLDS,
  ReliefGradientProvider, RELIEF_CLASS,
  CliffsGradientProvider, CLIFF_CLASS,
  CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND,
  RockGradientProvider, ROCK_TYPE, ROCK_CLASS,
  ForestGradientProvider, TREE_TYPE, SUCCESSION,
  GrassAndFlowresGradientProvider, GRASS_TYPE,
  ContinentalReliefGradientProvider, CONTINENTAL_TYPE,
  BathymetryProvider, BATHY_ZONE, SEABED_CLASS, SEABED_MATERIAL,
  GroundwaterProvider, GROUNDWATER_TYPE, GROUNDWATER_MATERIAL, WET_SOIL_MATERIAL,
  ColorManagement, ColorSpace,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 2;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── fog/mist state codes ───────────────────────────────────────
const MOISTURE_STATE = Object.freeze({
  ARID:        0,   // RH < 25%
  DRY:         1,   // 25% ≤ RH < 45%
  COMFORTABLE: 2,   // 45% ≤ RH < 65%
  HUMID:       3,   // 65% ≤ RH < 85%
  VERY_HUMID:  4,   // 85% ≤ RH < 95%
  SATURATED:   5,   // RH ≥ 95%
  FOG:         6,   // condensed water visible as fog
  MIST:        7    // condensed water visible as mist
});

const MOISTURE_STATE_NAMES = Object.freeze([
  'arid', 'dry', 'comfortable', 'humid', 'very_humid',
  'saturated', 'fog', 'mist'
]);

// ─── constants for atmospheric physics ─────────────────────────
const ATMOSPHERE_CONSTANTS = Object.freeze({
  // Magnus formula for saturation vapour pressure over water.
  magnusA: 6.112,       // hPa
  magnusB: 17.67,       // dimensionless
  magnusC: 243.5,       // °C

  // Fog base altitudes relative to local ground.
  fogBaseMin:       0.0,    // metres
  fogBaseMax:      50.0,    // metres
  fogScaleHeight:  30.0,    // metres (fog fades above this)
  mistScaleHeight: 60.0,
  fogDensityMax:    1.0,
  mistDensityMax:   0.4,

  // Fog formation thresholds.
  fogRHThreshold:    0.92,  // fog when RH > 92%
  mistRHThreshold:   0.85,  // mist when RH > 85%

  // Rayleigh and Mie scattering coefficients for clear air (per metre).
  rayleighR:   5.8e-6,
  rayleighG:  13.5e-6,
  rayleighB:  33.1e-6,
  mieBase:     1.5e-6,
  mieFog:      8.0e-4,      // dense fog

  // Evapotranspiration rates (mm/day at 25 °C, scaled by biome).
  etForest:       3.0,
  etGrass:        2.0,
  etWater:        4.0,      // open water
  etBare:         0.3,
  etDesert:       0.1,

  // Dew formation threshold (RH above this and temp below dew point).
  dewRHThreshold: 0.90,
  dewMinDeposition: 0.001
});

// ─── moisture material parameter sets (PBR + anime) ────────────
// Applied to surfaces in the living world to blend wetness into
// their shader. All sets carry the same full parameter struct.
const MOISTURE_MATERIAL = Object.freeze({
  WET_ROCK: {
    pbr: {
      baseColor:    [0.32, 0.30, 0.28],
      metalness:    0.02,
      roughness:    0.35,
      clearcoat:    0.65,
      transmission: 0.00,
      ior:          1.45,
      sheen:        0.05,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.35, 0.33, 0.30],
      quantizeSteps: 3,
      rimPower:     1.6,
      rimColor:     [0.55, 0.80, 0.95]
    },
    subsurfaceRadius: [0.02, 0.02, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    waterFilm:        0.75,
    dewCoverage:      0.30,
    causticsStrength: 0.25
  },
  WET_FOLIAGE: {
    pbr: {
      baseColor:    [0.28, 0.50, 0.22],
      metalness:    0.00,
      roughness:    0.50,
      clearcoat:    0.45,
      transmission: 0.05,
      ior:          1.40,
      sheen:        0.25,
      anisotropy:   0.05
    },
    anime: {
      baseColor:    [0.32, 0.55, 0.25],
      quantizeSteps: 3,
      rimPower:     1.8,
      rimColor:     [0.55, 0.90, 0.55]
    },
    subsurfaceRadius: [0.10, 0.15, 0.06],
    emissive:         [0.00, 0.00, 0.00],
    waterFilm:        0.55,
    dewCoverage:      0.45,
    causticsStrength: 0.30
  },
  WET_SOIL_DEEP: {
    pbr: {
      baseColor:    [0.20, 0.15, 0.10],
      metalness:    0.00,
      roughness:    0.70,
      clearcoat:    0.30,
      transmission: 0.00,
      ior:          1.40,
      sheen:        0.15,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.22, 0.17, 0.12],
      quantizeSteps: 3,
      rimPower:     1.9,
      rimColor:     [0.40, 0.50, 0.40]
    },
    subsurfaceRadius: [0.04, 0.03, 0.02],
    emissive:         [0.00, 0.00, 0.00],
    waterFilm:        0.40,
    dewCoverage:      0.10,
    causticsStrength: 0.15
  },
  FOG_PARTICLE: {
    pbr: {
      baseColor:    [0.85, 0.88, 0.92],
      metalness:    0.00,
      roughness:    1.00,
      clearcoat:    0.00,
      transmission: 1.00,
      ior:          1.00,
      sheen:        0.00,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.88, 0.90, 0.94],
      quantizeSteps: 2,
      rimPower:     1.2,
      rimColor:     [0.95, 0.95, 1.00]
    },
    subsurfaceRadius: [0.20, 0.20, 0.20],
    emissive:         [0.02, 0.03, 0.04],
    waterFilm:        0.00,
    dewCoverage:      0.00,
    causticsStrength: 0.00
  },
  MIST_PARTICLE: {
    pbr: {
      baseColor:    [0.90, 0.92, 0.94],
      metalness:    0.00,
      roughness:    1.00,
      clearcoat:    0.00,
      transmission: 0.90,
      ior:          1.00,
      sheen:        0.00,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.92, 0.94, 0.96],
      quantizeSteps: 2,
      rimPower:     1.3,
      rimColor:     [0.95, 0.97, 1.00]
    },
    subsurfaceRadius: [0.15, 0.15, 0.15],
    emissive:         [0.01, 0.02, 0.03],
    waterFilm:        0.00,
    dewCoverage:      0.00,
    causticsStrength: 0.00
  },
  DRY_DUST: {
    pbr: {
      baseColor:    [0.72, 0.62, 0.48],
      metalness:    0.00,
      roughness:    0.92,
      clearcoat:    0.00,
      transmission: 0.00,
      ior:          1.50,
      sheen:        0.10,
      anisotropy:   0.00
    },
    anime: {
      baseColor:    [0.75, 0.65, 0.50],
      quantizeSteps: 3,
      rimPower:     2.2,
      rimColor:     [0.90, 0.85, 0.75]
    },
    subsurfaceRadius: [0.00, 0.00, 0.00],
    emissive:         [0.00, 0.00, 0.00],
    waterFilm:        0.00,
    dewCoverage:      0.00,
    causticsStrength: 0.10
  }
});

// ─── defaults ────────────────────────────────────────────────────
const MOISTURE_DEFAULTS = Object.freeze({
  worldSeed:              0xW3ATHE22C0DE & 0xFFFFFFFF,
  cellSize:               8.0,
  chunkSize:              1000,
  maxCellsPerChunk:       256,
  maxChunksPerFrame:      8,
  baseHumidity:           0.50,
  oceanEvaporationBoost:  0.15,
  forestTranspirationBoost: 0.10,
  fogBaseAltitudeOffset:  10.0,
  fogScaleHeightMultiplier: 1.0,
  windMoistureAdvectionDistance: 2000.0,
  mutationCoalesceWindow: 5.0,
  weatherTransitionCooldown: 3.0
});

class MoistureLevelProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...MOISTURE_DEFAULTS, ...(options.defaults || {}) };
    this.atmosphere = { ...ATMOSPHERE_CONSTANTS, ...(options.atmosphere || {}) };
    this.enableFog = options.enableFog ?? true;
    this.enableMist = options.enableMist ?? true;
    this.enableDew = options.enableDew ?? true;
    this.enableTranspiration = options.enableTranspiration ?? true;
    this.enableAdvection = options.enableAdvection ?? true;

    // ── scratch (pooled, never reallocated) ─────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColor = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();
    this._tmpPlane = new Plane();

    // ── per-chunk moisture state ──────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk summary.
    this._chunkRelHumidity       = new Float32Array(chunkCap);
    this._chunkDewPoint          = new Float32Array(chunkCap);
    this._chunkVapourPressure    = new Float32Array(chunkCap);
    this._chunkMoistureState     = new Uint8Array(chunkCap);
    this._chunkFogDensity        = new Float32Array(chunkCap);
    this._chunkMistDensity       = new Float32Array(chunkCap);
    this._chunkFogBaseAltitude   = new Float32Array(chunkCap);
    this._chunkCloudCover        = new Float32Array(chunkCap);
    this._chunkEvapotranspiration = new Float32Array(chunkCap);
    this._chunkSurfaceWetness    = new Float32Array(chunkCap);
    this._chunkDewCoverage       = new Float32Array(chunkCap);
    this._chunkRayleighR         = new Float32Array(chunkCap);
    this._chunkRayleighG         = new Float32Array(chunkCap);
    this._chunkRayleighB         = new Float32Array(chunkCap);
    this._chunkMieScattering     = new Float32Array(chunkCap);

    // Per-chunk cell data (fog / mist particles).
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellRH = new Array(chunkCap).fill(null);
    this._chunkCellDew = new Array(chunkCap).fill(null);
    this._chunkCellFogDensity = new Array(chunkCap).fill(null);
    this._chunkCellMistDensity = new Array(chunkCap).fill(null);
    this._chunkCellState = new Array(chunkCap).fill(null);       // Uint8Array

    // Free lists.
    this._cellPool = {
      x: [], y: [], z: [], rh: [], dew: [], fog: [], mist: []
    };
    this._statePool = [];

    // ── per-frame global moisture aggregate ───────────────
    this._globalMoisture = {
      avgRelativeHumidity: 0.5,
      avgDewPoint: 10.0,
      avgFogDensity: 0.0,
      avgMistDensity: 0.0,
      avgCloudCover: 0.3,
      avgSurfaceWetness: 0.0,
      avgEvapotranspiration: 0.0,
      fogFraction: 0.0,
      mistFraction: 0.0,
      aridFraction: 0.0,
      humidFraction: 0.0,
      rayleighR: ATMOSPHERE_CONSTANTS.rayleighR,
      rayleighG: ATMOSPHERE_CONSTANTS.rayleighG,
      rayleighB: ATMOSPHERE_CONSTANTS.rayleighB,
      mieScattering: ATMOSPHERE_CONSTANTS.mieBase,
      skyMoistureMultiplier: 1.0
    };

    // ── timing / frame reference ──────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ─────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      fogCells: 0,
      mistCells: 0,
      humidCells: 0,
      aridCells: 0,
      saturatedCells: 0,
      weatherTransitions: 0,
      mutationEventsEmitted: 0,
      advectionComputes: 0,
      dewComputes: 0
    };

    // ── collaborators ─────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._relief = options.relief || null;
    this._cliffs = options.cliffs || null;
    this._carve = options.carve || null;
    this._rocks = options.rocks || null;
    this._forest = options.forest || null;
    this._grass = options.grass || null;
    this._continental = options.continental || null;
    this._bathymetry = options.bathymetry || null;
    this._groundwater = options.groundwater || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── material param reusable buffers ───────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0 },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      subsurfaceRadius: [0,0,0],
      emissive: [0,0,0],
      waterFilm: 0,
      dewCoverage: 0,
      causticsStrength: 0
    };

    // ── per-chunk previous state (for transitions) ────────
    this._chunkLastState = new Uint8Array(chunkCap);
    this._chunkLastTransitionTime = new Float64Array(chunkCap);
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachRelief(r) { this._relief = r; return this; }
  attachCliffs(c) { this._cliffs = c; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachRocks(r) { this._rocks = r; return this; }
  attachForest(f) { this._forest = f; return this; }
  attachGrass(g) { this._grass = g; return this; }
  attachContinental(c) { this._continental = c; return this; }
  attachBathymetry(b) { this._bathymetry = b; return this; }
  attachGroundwater(g) { this._groundwater = g; return this; }
  attachTemporal(t) { this._temporal = t; return this; }
  attachDispatcher(d) { this._dispatcher = d; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── height and sea-level lookup ────────────────────────
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
  // ─── Magnus formula: saturation vapour pressure ─────────
  // ══════════════════════════════════════════════════════════
  // e_s(T) = 6.112 · exp(17.67·T / (T + 243.5))   (T in °C, e_s in hPa)
  saturationVapourPressure(tempC) {
    const { magnusA, magnusB, magnusC } = this.atmosphere;
    return magnusA * Math.exp((magnusB * tempC) / (tempC + magnusC));
  }

  // Dew point from vapour pressure (Magnus inverse):
  // T_d = (243.5 · ln(e / 6.112)) / (17.67 − ln(e / 6.112))
  dewPointFromVapour(e_hPa) {
    const { magnusA, magnusB, magnusC } = this.atmosphere;
    if (e_hPa <= magnusA) return -243.5;
    const ln = Math.log(e_hPa / magnusA);
    return (magnusC * ln) / (magnusB - ln);
  }

  // ══════════════════════════════════════════════════════════
  // ─── vapour pressure sources ────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Base atmospheric vapour pressure from weather + temperature.
  _baseVapourPressure(tempC, weatherSeverity, humidityBase) {
    const e_s = this.saturationVapourPressure(tempC);
    // Base humidity from temporal provider (or fallback).
    return e_s * humidityBase;
  }

  // Evapotranspiration contribution (forest + grass).
  _evapotranspiration(wx, wz, tempC, frame) {
    if (!this.enableTranspiration) return 0;

    let et = 0;

    // Forest transpiration.
    if (this._forest) {
      const forest = this._forest.getForestAt(wx, wz);
      if (forest) {
        const canopy = forest.canopyDensity;
        const forestBoost = this.defaults.forestTranspirationBoost;
        et += ATMOSPHERE_CONSTANTS.etForest * canopy * forestBoost * (tempC / 25);
      }
    }

    // Grass / ground cover evaporation.
    if (this._grass) {
      const grass = this._grass.getGrassAt(wx, wz);
      if (grass) {
        const coverage = grass.coverage;
        et += ATMOSPHERE_CONSTANTS.etGrass * coverage * 0.05 * (tempC / 25);
      }
    }

    // Bare ground (minimal).
    if (et < 0.01) {
      et = ATMOSPHERE_CONSTANTS.etBare * 0.01;
    }

    return et;
  }

  // Water-surface evaporation (open water, ocean, lakes).
  _waterEvaporation(wx, wz, tempC, frame) {
    if (!this._bathymetry) return 0;
    const water = this._bathymetry.getWaterAt(wx, wz);
    if (!water || water.waterCoverage < 0.1) return 0;

    // Ocean evaporation boost is stronger than freshwater.
    const coverage = water.waterCoverage;
    const boost = water.dominantZone <= BATHY_ZONE.SURFACE
      ? this.defaults.oceanEvaporationBoost * 2
      : this.defaults.oceanEvaporationBoost;
    return ATMOSPHERE_CONSTANTS.etWater * coverage * boost * (tempC / 25);
  }

  // Groundwater contribution (soil moisture + springs).
  _groundwaterVapour(wx, wz) {
    if (!this._groundwater) return 0;
    const gw = this._groundwater.getGroundwaterAt(wx, wz);
    if (!gw) return 0;

    // Soil moisture drives evaporation from soil.
    const soilMoist = gw.soilMoisture;
    // Springs add direct vapour near emergence points.
    const springBoost = gw.springCount > 0 ? 0.05 : 0;

    return soilMoist * 0.05 + springBoost;
  }

  // Wind advection: how much moisture the air is bringing from upwind.
  _windAdvection(wx, wz, frame) {
    if (!this.enableAdvection) return 1.0;

    const physical = frame.layers.physical;
    const wind = physical?.wind;
    if (!wind || (wind[0] === 0 && wind[2] === 0)) return 1.0;

    // Sample upwind humidity (simplified: assume uniform base humidity).
    // In a full implementation, we'd query the upwind chunk's state.
    const dist = this.defaults.windMoistureAdvectionDistance;
    const upwindX = wx - wind[0] * dist / Math.max(0.1, Math.hypot(wind[0], wind[2]));
    const upwindZ = wz - wind[2] * dist / Math.max(0.1, Math.hypot(wind[0], wind[2]));

    // Simple heuristic: onshore winds (from ocean) bring moisture.
    const seaLevel = this._getSeaLevel();
    const upwindElev = this._getHeight(upwindX, upwindZ);
    const isOceanUpwind = upwindElev < seaLevel;

    // Onshore wind adds moisture, offshore subtracts.
    return isOceanUpwind ? 1.15 : 0.95;
  }

  // ══════════════════════════════════════════════════════════
  // ─── fog and mist density ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeFogDensity(altitude, fogBaseAltitude, rh) {
    if (rh < this.atmosphere.fogRHThreshold) return 0;
    if (altitude < fogBaseAltitude) return 0;

    // Fog fades exponentially above its base.
    const relative = (altitude - fogBaseAltitude) / this.atmosphere.fogScaleHeight;
    const fade = Math.exp(-relative);
    // Intensity scaled by how far above the RH threshold.
    const intensity = Math.min(1, (rh - this.atmosphere.fogRHThreshold) /
      (1 - this.atmosphere.fogRHThreshold));

    return Math.min(this.atmosphere.fogDensityMax, fade * intensity);
  }

  _computeMistDensity(altitude, mistBaseAltitude, rh) {
    if (!this.enableMist) return 0;
    if (rh < this.atmosphere.mistRHThreshold) return 0;
    if (altitude < mistBaseAltitude) return 0;

    const relative = (altitude - mistBaseAltitude) / this.atmosphere.mistScaleHeight;
    const fade = Math.exp(-relative);
    const intensity = Math.min(1, (rh - this.atmosphere.mistRHThreshold) /
      (this.atmosphere.fogRHThreshold - this.atmosphere.mistRHThreshold));

    return Math.min(this.atmosphere.mistDensityMax, fade * intensity);
  }

  // ══════════════════════════════════════════════════════════
  // ─── cloud cover ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeCloudCover(rh, weatherSeverity, tempC) {
    // Cloud cover rises with humidity and weather severity.
    const base = Math.max(0, (rh - 0.5) * 2);
    const weatherContrib = weatherSeverity * 0.9;

    // Combine: cloud cover = max of base + weather, capped at 1.
    return Math.min(1, base * 0.5 + weatherContrib);
  }

  // ══════════════════════════════════════════════════════════
  // ─── dew formation ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeDewCoverage(rh, tempC, dewPointC, altitude, sunAltitude) {
    if (!this.enableDew) return 0;
    // Dew forms at night when air is saturated.
    if (rh < this.atmosphere.dewRHThreshold) return 0;
    if (tempC > dewPointC + 0.5) return 0;

    // Only at night (sun below horizon).
    if (sunAltitude > 0.1) return 0;

    // Coverage scales with how close temp is to dew point.
    const closeness = Math.max(0, 1 - (tempC - dewPointC) / 3);
    // Low elevations get more dew (fog + ground contact).
    const elevFactor = altitude < 500 ? 1.0 : 0.5;

    return closeness * elevFactor;
  }

  // ══════════════════════════════════════════════════════════
  // ─── moisture state classification ──────────────────────
  // ══════════════════════════════════════════════════════════
  _classifyMoistureState(rh, fogDensity, mistDensity) {
    if (fogDensity > 0.1) return MOISTURE_STATE.FOG;
    if (mistDensity > 0.1) return MOISTURE_STATE.MIST;
    if (rh < 0.25) return MOISTURE_STATE.ARID;
    if (rh < 0.45) return MOISTURE_STATE.DRY;
    if (rh < 0.65) return MOISTURE_STATE.COMFORTABLE;
    if (rh < 0.85) return MOISTURE_STATE.HUMID;
    if (rh < 0.95) return MOISTURE_STATE.VERY_HUMID;
    return MOISTURE_STATE.SATURATED;
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk sampling ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleChunk(cx, cz, frame) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));

    const spatial = frame.layers.spatial;
    const physical = frame.layers.physical;

    // Read temporal context.
    const weatherSeverity = this._temporal ? this._temporal.weatherSeverity : 0.3;
    const season = this._temporal ? this._temporal.seasonScalar : 0.5;
    const ambientTemp = physical?.ambientTemperature ?? 15;
    const baseHumidity = physical?.humidity ?? 0.5;
    const sunAltitude = physical?.sunAltitude ?? 0.7;

    // Base vapour pressure.
    const eBase = this._baseVapourPressure(ambientTemp, weatherSeverity, baseHumidity);

    // Advection multiplier.
    const advection = this._windAdvection(
      cx * chunkSize + chunkSize * 0.5,
      cz * chunkSize + chunkSize * 0.5,
      frame
    );

    // Get chunk slot.
    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    // Allocate cell arrays.
    if (!this._chunkCellX[slot]) {
      this._chunkCellX[slot] = this._acquireCell('x');
      this._chunkCellY[slot] = this._acquireCell('y');
      this._chunkCellZ[slot] = this._acquireCell('z');
      this._chunkCellRH[slot] = this._acquireCell('rh');
      this._chunkCellDew[slot] = this._acquireCell('dew');
      this._chunkCellFogDensity[slot] = this._acquireCell('fog');
      this._chunkCellMistDensity[slot] = this._acquireCell('mist');
      this._chunkCellState[slot] = this._acquireState();
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpRH = this._chunkCellRH[slot];
    const cpDew = this._chunkCellDew[slot];
    const cpFog = this._chunkCellFogDensity[slot];
    const cpMist = this._chunkCellMistDensity[slot];
    const cpState = this._chunkCellState[slot];

    const maxCells = this.defaults.maxCellsPerChunk;
    let placed = 0;
    let fogCells = 0;
    let mistCells = 0;
    let humidCells = 0;
    let aridCells = 0;
    let saturatedCells = 0;

    // Aggregates.
    let sumRH = 0;
    let sumDew = 0;
    let sumFogDensity = 0;
    let sumMistDensity = 0;
    let sumCloudCover = 0;
    let sumSurfaceWetness = 0;
    let sumDewCoverage = 0;
    let sumET = 0;
    let sumRayleighR = 0;
    let sumRayleighG = 0;
    let sumRayleighB = 0;
    let sumMie = 0;
    let fogBaseMin = Infinity;
    let fogBaseMax = -Infinity;

    for (let j = 0; j < cellsPerSide && placed < maxCells; j++) {
      for (let i = 0; i < cellsPerSide && placed < maxCells; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;
        const altitude = this._getHeight(wx, wz);

        // Temperature at this altitude (falloff with elevation).
        const localTemp = ambientTemp - 0.0065 * Math.max(0, altitude);
        const e_s = this.saturationVapourPressure(localTemp);

        // Vapour pressure sources.
        const eBaseLocal = this._baseVapourPressure(localTemp, weatherSeverity, baseHumidity);
        const eWater = this._waterEvaporation(wx, wz, localTemp, frame);
        const eET = this._evapotranspiration(wx, wz, localTemp, frame);
        const eGW = this._groundwaterVapour(wx, wz);

        // Actual vapour pressure.
        const eActual = (eBaseLocal + eWater * 0.5 + eET * 0.3 + eGW * 0.4) * advection;

        // Relative humidity: RH = e / e_s, capped at 1.05 for supersaturation.
        const rh = Math.min(1.05, Math.max(0.05, eActual / e_s));

        // Dew point.
        const dewPoint = this.dewPointFromVapour(eActual);

        // Fog / mist density (based on altitude above local ground).
        const localGroundHeight = altitude - (altitude - this._getHeight(wx, wz));
        const fogBase = this.defaults.fogBaseAltitudeOffset + 0;   // base is at ground level + offset
        const mistBase = fogBase + 20;

        const fogDensity = this.enableFog
          ? this._computeFogDensity(altitude, fogBase, rh) : 0;
        const mistDensity = this._computeMistDensity(altitude, mistBase, rh);

        // Cloud cover (at cloud base, well above).
        const cloudCover = this._computeCloudCover(rh, weatherSeverity, localTemp);

        // Surface wetness (from moisture landing on surface).
        const surfaceWetness = Math.min(1, rh * 0.5 + fogDensity * 0.3);

        // Dew coverage.
        const dewCoverage = this._computeDewCoverage(rh, localTemp, dewPoint, altitude, sunAltitude);

        // Total evapotranspiration.
        const etTotal = eWater + eET + eGW;

        // State classification.
        const state = this._classifyMoistureState(rh, fogDensity, mistDensity);

        // Scattering coefficients (Rayleigh and Mie).
        // Rayleigh ∝ 1/λ⁴ — wavelength-specific.
        const fogFactor = Math.min(1, fogDensity * 3);
        const cloudFactor = cloudCover;
        const rRayleigh = ATMOSPHERE_CONSTANTS.rayleighR * (1 + fogFactor * 0.5);
        const gRayleigh = ATMOSPHERE_CONSTANTS.rayleighG * (1 + fogFactor * 0.5);
        const bRayleigh = ATMOSPHERE_CONSTANTS.rayleighB * (1 + fogFactor * 0.5);
        const mie = ATMOSPHERE_CONSTANTS.mieBase + fogFactor * ATMOSPHERE_CONSTANTS.mieFog;

        // Store per-cell.
        cpx[placed] = wx;
        cpy[placed] = altitude;
        cpz[placed] = wz;
        cpRH[placed] = rh;
        cpDew[placed] = dewPoint;
        cpFog[placed] = fogDensity;
        cpMist[placed] = mistDensity;
        cpState[placed] = state;
        placed++;

        // Aggregates.
        sumRH += rh;
        sumDew += dewPoint;
        sumFogDensity += fogDensity;
        sumMistDensity += mistDensity;
        sumCloudCover += cloudCover;
        sumSurfaceWetness += surfaceWetness;
        sumDewCoverage += dewCoverage;
        sumET += etTotal;
        sumRayleighR += rRayleigh;
        sumRayleighG += gRayleigh;
        sumRayleighB += bRayleigh;
        sumMie += mie;
        if (fogDensity > 0.1) { fogCells++; if (altitude < fogBaseMin) fogBaseMin = altitude; if (altitude > fogBaseMax) fogBaseMax = altitude; }
        if (mistDensity > 0.1) mistCells++;
        if (rh > 0.85) humidCells++;
        if (rh < 0.25) aridCells++;
        if (rh >= 0.95) saturatedCells++;

        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // Compute per-chunk summary.
    const avgRH = placed > 0 ? sumRH / placed : 0.5;
    const avgDew = placed > 0 ? sumDew / placed : 10;
    const avgFog = placed > 0 ? sumFogDensity / placed : 0;
    const avgMist = placed > 0 ? sumMistDensity / placed : 0;
    const avgCloud = placed > 0 ? sumCloudCover / placed : 0;
    const avgWetness = placed > 0 ? sumSurfaceWetness / placed : 0;
    const avgDewCoverage = placed > 0 ? sumDewCoverage / placed : 0;
    const avgET = placed > 0 ? sumET / placed : 0;
    const avgRayleighR = placed > 0 ? sumRayleighR / placed : ATMOSPHERE_CONSTANTS.rayleighR;
    const avgRayleighG = placed > 0 ? sumRayleighG / placed : ATMOSPHERE_CONSTANTS.rayleighG;
    const avgRayleighB = placed > 0 ? sumRayleighB / placed : ATMOSPHERE_CONSTANTS.rayleighB;
    const avgMie = placed > 0 ? sumMie / placed : ATMOSPHERE_CONSTANTS.mieBase;

    const dominantState = this._classifyMoistureState(avgRH, avgFog, avgMist);

    this._chunkRelHumidity[slot] = avgRH;
    this._chunkDewPoint[slot] = avgDew;
    this._chunkVapourPressure[slot] = eBase * (1 + advection * 0.1);
    this._chunkMoistureState[slot] = dominantState;
    this._chunkFogDensity[slot] = avgFog;
    this._chunkMistDensity[slot] = avgMist;
    this._chunkFogBaseAltitude[slot] = fogBaseMin !== Infinity ? fogBaseMin : 0;
    this._chunkCloudCover[slot] = avgCloud;
    this._chunkEvapotranspiration[slot] = avgET;
    this._chunkSurfaceWetness[slot] = avgWetness;
    this._chunkDewCoverage[slot] = avgDewCoverage;
    this._chunkRayleighR[slot] = avgRayleighR;
    this._chunkRayleighG[slot] = avgRayleighG;
    this._chunkRayleighB[slot] = avgRayleighB;
    this._chunkMieScattering[slot] = avgMie;

    this._stats.chunksProcessed++;
    this._stats.fogCells += fogCells;
    this._stats.mistCells += mistCells;
    this._stats.humidCells += humidCells;
    this._stats.aridCells += aridCells;
    this._stats.saturatedCells += saturatedCells;

    // Transition detection: emit causal event if state changed.
    const now = this._lastUpdateTime > 0 ? this._lastUpdateTime : 0;
    const previousState = this._chunkLastState[slot];
    if (previousState !== 0 && previousState !== dominantState &&
        now - this._chunkLastTransitionTime[slot] > this.defaults.weatherTransitionCooldown) {
      this._chunkLastTransitionTime[slot] = now;
      this._stats.weatherTransitions++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, Math.round(avgRH * 50), 3.0,
          {
            kind: 'moisture_transition',
            chunkX: cx, chunkZ: cz,
            from: previousState,
            to: dominantState,
            fromName: MOISTURE_STATE_NAMES[previousState],
            toName: MOISTURE_STATE_NAMES[dominantState],
            fogDensity: avgFog,
            rh: avgRH
          }
        );
        this._stats.mutationEventsEmitted++;
      }
    }
    this._chunkLastState[slot] = dominantState;

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
    if (this._chunkUsed >= this._chunkCap) {
      this._evictOldest();
    }
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
    this._chunkLastState[slot] = 0;
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
      this._cellPool.rh.push(this._chunkCellRH[slot]);
      this._cellPool.dew.push(this._chunkCellDew[slot]);
      this._cellPool.fog.push(this._chunkCellFogDensity[slot]);
      this._cellPool.mist.push(this._chunkCellMistDensity[slot]);
      this._statePool.push(this._chunkCellState[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellRH[slot] = null;
    this._chunkCellDew[slot] = null;
    this._chunkCellFogDensity[slot] = null;
    this._chunkCellMistDensity[slot] = null;
    this._chunkCellState[slot] = null;
    this._chunkUsed--;
  }

  _evictOldest() {
    let oldest = -1;
    let oldestVal = Infinity;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (this._chunkCX[i] < oldestVal) {
        oldestVal = this._chunkCX[i];
        oldest = i;
      }
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

  _acquireState() {
    if (this._statePool.length > 0) {
      const arr = this._statePool.pop();
      arr.fill(0);
      return arr;
    }
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getMoistureAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      relativeHumidity: this._chunkRelHumidity[slot],
      dewPoint: this._chunkDewPoint[slot],
      vapourPressure: this._chunkVapourPressure[slot],
      moistureState: this._chunkMoistureState[slot],
      moistureStateName: MOISTURE_STATE_NAMES[this._chunkMoistureState[slot]],
      fogDensity: this._chunkFogDensity[slot],
      mistDensity: this._chunkMistDensity[slot],
      fogBaseAltitude: this._chunkFogBaseAltitude[slot],
      cloudCover: this._chunkCloudCover[slot],
      evapotranspiration: this._chunkEvapotranspiration[slot],
      surfaceWetness: this._chunkSurfaceWetness[slot],
      dewCoverage: this._chunkDewCoverage[slot],
      rayleighR: this._chunkRayleighR[slot],
      rayleighG: this._chunkRayleighG[slot],
      rayleighB: this._chunkRayleighB[slot],
      mieScattering: this._chunkMieScattering[slot],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        rh: this._chunkCellRH[slot],
        dew: this._chunkCellDew[slot],
        fog: this._chunkCellFogDensity[slot],
        mist: this._chunkCellMistDensity[slot],
        state: this._chunkCellState[slot]
      }
    };
  }

  // Sample humidity at a point by bilinear interpolation across cells.
  sampleHumidityAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return this._globalMoisture.avgRelativeHumidity;

    // Find nearest cell.
    const cellSize = this.defaults.cellSize;
    const localX = (wx - cx * this.defaults.chunkSize) / cellSize;
    const localZ = (wz - cz * this.defaults.chunkSize) / cellSize;
    const cellIdx = Math.floor(localZ) * Math.floor(this.defaults.chunkSize / cellSize) + Math.floor(localX);

    const count = this._chunkCellCount[slot];
    if (cellIdx >= count) return this._chunkRelHumidity[slot];
    const rh = this._chunkCellRH[slot];
    return rh ? rh[cellIdx] : this._chunkRelHumidity[slot];
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getMoistureMaterialParams(preset) {
    return MOISTURE_MATERIAL[preset] || MOISTURE_MATERIAL.WET_ROCK;
  }

  // Blend wet-surface material params based on state and wetness.
  blendWetSurfaceMaterial(surfaceClass, wetness, out) {
    let preset = 'WET_ROCK';
    if (surfaceClass === 'foliage' || surfaceClass === 'grass') preset = 'WET_FOLIAGE';
    else if (surfaceClass === 'soil') preset = 'WET_SOIL_DEEP';
    else if (surfaceClass === 'fog') preset = 'FOG_PARTICLE';
    else if (surfaceClass === 'mist') preset = 'MIST_PARTICLE';
    else if (surfaceClass === 'dust') preset = 'DRY_DUST';

    const src = MOISTURE_MATERIAL[preset];
    const o = out || this._blendedParams;

    o.pbr.baseColor[0] = src.pbr.baseColor[0];
    o.pbr.baseColor[1] = src.pbr.baseColor[1];
    o.pbr.baseColor[2] = src.pbr.baseColor[2];
    o.pbr.metalness = src.pbr.metalness;
    o.pbr.roughness = src.pbr.roughness * (1 - wetness * 0.5);
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

    o.waterFilm = src.waterFilm * wetness;
    o.dewCoverage = src.dewCoverage * wetness;
    o.causticsStrength = src.causticsStrength;

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.moisture) {
      spatial.moisture = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        relativeHumidity: this._chunkRelHumidity,
        dewPoint: this._chunkDewPoint,
        vapourPressure: this._chunkVapourPressure,
        moistureState: this._chunkMoistureState,
        fogDensity: this._chunkFogDensity,
        mistDensity: this._chunkMistDensity,
        fogBaseAltitude: this._chunkFogBaseAltitude,
        cloudCover: this._chunkCloudCover,
        evapotranspiration: this._chunkEvapotranspiration,
        surfaceWetness: this._chunkSurfaceWetness,
        dewCoverage: this._chunkDewCoverage,
        rayleighR: this._chunkRayleighR,
        rayleighG: this._chunkRayleighG,
        rayleighB: this._chunkRayleighB,
        mieScattering: this._chunkMieScattering,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          rh: this._chunkCellRH,
          dew: this._chunkCellDew,
          fog: this._chunkCellFogDensity,
          mist: this._chunkCellMistDensity,
          state: this._chunkCellState
        },
        materialParams: MOISTURE_MATERIAL,
        stateNames: MOISTURE_STATE_NAMES
      };
    }

    const m = spatial.moisture;
    m.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (m.chunkCount >= this._chunkCap) break;
      m.chunkCX[m.chunkCount] = this._chunkCX[i];
      m.chunkCZ[m.chunkCount] = this._chunkCZ[i];
      m.chunkSlots[m.chunkCount] = i;
      m.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    let sumRH = 0, sumDew = 0, sumFog = 0, sumMist = 0, sumCloud = 0;
    let sumWetness = 0, sumET = 0;
    let sumRayleighR = 0, sumRayleighG = 0, sumRayleighB = 0, sumMie = 0;
    let chunksWithMoisture = 0;
    let fogChunks = 0, mistChunks = 0, aridChunks = 0, humidChunks = 0;

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      sumRH += this._chunkRelHumidity[i];
      sumDew += this._chunkDewPoint[i];
      sumFog += this._chunkFogDensity[i];
      sumMist += this._chunkMistDensity[i];
      sumCloud += this._chunkCloudCover[i];
      sumWetness += this._chunkSurfaceWetness[i];
      sumET += this._chunkEvapotranspiration[i];
      sumRayleighR += this._chunkRayleighR[i];
      sumRayleighG += this._chunkRayleighG[i];
      sumRayleighB += this._chunkRayleighB[i];
      sumMie += this._chunkMieScattering[i];
      chunksWithMoisture++;

      if (this._chunkFogDensity[i] > 0.1) fogChunks++;
      if (this._chunkMistDensity[i] > 0.1) mistChunks++;
      if (this._chunkMoistureState[i] === MOISTURE_STATE.ARID) aridChunks++;
      if (this._chunkMoistureState[i] === MOISTURE_STATE.HUMID ||
          this._chunkMoistureState[i] === MOISTURE_STATE.VERY_HUMID) humidChunks++;
    }

    const gm = this._globalMoisture;
    gm.avgRelativeHumidity = chunksWithMoisture > 0 ? sumRH / chunksWithMoisture : 0.5;
    gm.avgDewPoint = chunksWithMoisture > 0 ? sumDew / chunksWithMoisture : 10;
    gm.avgFogDensity = chunksWithMoisture > 0 ? sumFog / chunksWithMoisture : 0;
    gm.avgMistDensity = chunksWithMoisture > 0 ? sumMist / chunksWithMoisture : 0;
    gm.avgCloudCover = chunksWithMoisture > 0 ? sumCloud / chunksWithMoisture : 0.3;
    gm.avgSurfaceWetness = chunksWithMoisture > 0 ? sumWetness / chunksWithMoisture : 0;
    gm.avgEvapotranspiration = chunksWithMoisture > 0 ? sumET / chunksWithMoisture : 0;
    gm.fogFraction = chunksWithMoisture > 0 ? fogChunks / chunksWithMoisture : 0;
    gm.mistFraction = chunksWithMoisture > 0 ? mistChunks / chunksWithMoisture : 0;
    gm.aridFraction = chunksWithMoisture > 0 ? aridChunks / chunksWithMoisture : 0;
    gm.humidFraction = chunksWithMoisture > 0 ? humidChunks / chunksWithMoisture : 0;
    gm.rayleighR = chunksWithMoisture > 0 ? sumRayleighR / chunksWithMoisture : ATMOSPHERE_CONSTANTS.rayleighR;
    gm.rayleighG = chunksWithMoisture > 0 ? sumRayleighG / chunksWithMoisture : ATMOSPHERE_CONSTANTS.rayleighG;
    gm.rayleighB = chunksWithMoisture > 0 ? sumRayleighB / chunksWithMoisture : ATMOSPHERE_CONSTANTS.rayleighB;
    gm.mieScattering = chunksWithMoisture > 0 ? sumMie / chunksWithMoisture : ATMOSPHERE_CONSTANTS.mieBase;

    // Sky moisture multiplier for materials.
    gm.skyMoistureMultiplier = 1.0 + gm.avgCloudCover * 0.3 - (1 - gm.avgRelativeHumidity) * 0.2;

    if (!physical.moistureProperties) {
      physical.moistureProperties = {};
    }
    Object.assign(physical.moistureProperties, gm);

    // Material-facing aggregates.
    physical.relativeHumidity = gm.avgRelativeHumidity;
    physical.dewPoint = gm.avgDewPoint;
    physical.fogDensity = gm.avgFogDensity;
    physical.mistDensity = gm.avgMistDensity;
    physical.cloudCover = gm.avgCloudCover;
    physical.surfaceWetness = gm.avgSurfaceWetness;
    physical.dewCoverage = chunksWithMoisture > 0 ? this._chunkDewCoverage[0] : 0;
    physical.evapotranspiration = gm.avgEvapotranspiration;
    physical.atmosphericRayleigh = [gm.rayleighR, gm.rayleighG, gm.rayleighB];
    physical.atmosphericMie = gm.mieScattering;

    // Fog color for atmospheric shader.
    physical.fogColor = [0.85, 0.88, 0.92];
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

  setAtmosphere(params) {
    for (const k of Object.keys(this.atmosphere)) {
      if (params[k] !== undefined) this.atmosphere[k] = params[k];
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
  getGlobalMoisture() { return { ...this._globalMoisture }; }

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
    this._relief = null;
    this._cliffs = null;
    this._carve = null;
    this._rocks = null;
    this._forest = null;
    this._grass = null;
    this._continental = null;
    this._bathymetry = null;
    this._groundwater = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._statePool.length = 0;
  }
}

export {
  MoistureLevelProvider,
  MOISTURE_STATE,
  MOISTURE_STATE_NAMES,
  MOISTURE_MATERIAL,
  ATMOSPHERE_CONSTANTS,
  MOISTURE_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};