// file number : 289
// full path name : src/context/289_ClimateWindProvider.js
// description : Climate wind provider computing the three-dimensional wind velocity field across the entire living world. Fuses seven independent contributions into one coherent vector per cell: (1) global atmospheric circulation derived from the three-cell model (Hadley, Ferrel, Polar) using latitude-based wind belts — trade winds at the equator, westerlies at mid-latitudes, and polar easterlies at the poles; (2) the Coriolis deflection that turns winds rightward in the Northern Hemisphere and leftward in the Southern; (3) orographic lifting as wind hits terrain, producing upslope flow on the windward side and downslope Föhn-style flow on the leeward; (4) valley channelling that accelerates wind along valley axes and reduces it across ridges; (5) thermal circulations — sea breezes day-side and land breezes night-side from the ocean-land temperature contrast, plus mountain-valley breezes from diurnal heating; (6) weather-state forcing where storms add wind and clear skies dampen it; and (7) height-dependent boundary-layer effects that attenuate wind near the ground with a logarithmic profile. Computes wind speed, direction, gust factor, turbulence intensity, boundary-layer height, orographic lift, wind-sway weight per surface type, wave-generation coefficient, and wind-erosion rate. Provides full PBR + anime material parameter sets for wind-affected surfaces — blowing sand, drifting snow, wave-capped water, dust haze, wind-bent foliage — all live scalars the shader reads. Emits a single coalesced WEATHER causal event when a chunk crosses wind thresholds, plus MUTATION events at high wind erosion thresholds. Writes per-chunk summaries into frame.layers.spatial.wind and global aggregates into frame.layers.physical.windProperties. All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs wind state — flora sway and wind damage, water wave generation, wind erosion and dune migration, dust and fire spread, fauna wind sensing, rain shadow and orographic precipitation, sail physics for boats, and material shaders for blowing particles. Complements 287_ClimateTemperatureProvider and 288_ClimatePrecipitationProvider by completing the climate triple — temperature, precipitation, and wind.
// license : MIT

// ─── raw 3js primitives — these ARE exported by the 264 barrel ───
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision,
  ColorManagement, ColorSpace,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                   from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }   from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                  from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                    from './267_CoreClock.js';
import { smoothstep, CURVE_KIND }                          from './268_ExtrasCurveUtils.js';
import { TemporalContextProvider, WEATHER, WEATHER_NAMES, WEATHER_SEVERITY }
                                                           from './276_TemporalContextProvider.js';
import { CausalContextProvider, DERIVED_SIGNAL }           from './278_CausalContextProvider.js';
import { TerrainProvider, BIOME_HINT }                     from './280_TerrainProvider.js';
import { ElevationProvider, ELEVATION_BAND, ATMOSPHERE }   from './281_ElevationProvider.js';
import { SlopeGradientProvider, SLOPE_BAND, SLOPE_BAND_THRESHOLDS }
                                                           from './282_SlopeGradientProvider.js';
import { ReliefGradientProvider, RELIEF_CLASS }            from './282_Z01_ReliefGradientProvider.js';
import { CliffsGradientProvider, CLIFF_CLASS, CLIFF_MATERIAL_BAND }
                                                           from './282_Z02_CliffsGradientProvider.js';
import { CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND }
                                                           from './282_Z03_CarveGradientProvider.js';
import { RockGradientProvider, ROCK_TYPE, ROCK_CLASS, ROCK_CLASS_NAMES }
                                                           from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE, SUCCESSION }   from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE }     from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider, CONTINENTAL_TYPE }
                                                           from './282_Z09_ContinentalReliefGradientProvider.js';
import { BathymetryProvider, BATHY_ZONE, SEABED_CLASS }    from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE }           from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE }           from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE }              from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider, CLIMATE_ZONE }        from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE }
                                                           from './288_ClimatePrecipitationProvider.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 2;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── wind state codes ───────────────────────────────────────────
const WIND_STATE = Object.freeze({
  CALM:          0,
  LIGHT:         1,
  GENTLE:        2,
  MODERATE:      3,
  FRESH:         4,
  STRONG:        5,
  NEAR_GALE:     6,
  GALE:          7,
  STRONG_GALE:   8,
  STORM:         9,
  VIOLENT_STORM: 10,
  HURRICANE:     11
});

const WIND_STATE_NAMES = Object.freeze([
  'calm', 'light', 'gentle', 'moderate', 'fresh',
  'strong', 'near_gale', 'gale', 'strong_gale',
  'storm', 'violent_storm', 'hurricane'
]);

const WIND_STATE_THRESHOLDS = Object.freeze([
  0.0, 1.0, 3.0, 5.0, 8.0, 11.0, 14.0, 17.0, 21.0, 25.0, 32.0, 40.0
]);

// ─── physical constants for wind ───────────────────────────────
const WIND_CONSTANTS = Object.freeze({
  tradeWindSpeed:          8.0,
  westerliesSpeed:        10.0,
  polarEasterliesSpeed:    5.0,
  horseLatitudesSpeed:     2.0,

  coriolisMaxLat:         60.0,
  coriolisTurnRate:        0.15,

  orographicLiftFactor:    3.0,
  föhnWarming:             0.5,

  valleyChannelFactor:     1.5,
  ridgeBlockFactor:        0.3,

  seaBreezeSpeed:          5.0,
  landBreezeSpeed:         2.5,
  mountainBreezeSpeed:     3.0,
  valleyBreezeSpeed:       4.0,
  thermalTransitionCooldown: 3600,

  stormWindBoost:         20.0,
  clearSkyWindDamp:        0.7,

  groundWindAttenuation:   0.55,
  boundaryLayerHeight:   500.0,
  logProfileZ0:            0.1,

  gustFactorBase:          0.15,
  gustFactorStorm:         0.45,
  gustPeriodBase:         30.0,
  gustPeriodStorm:        10.0,
  turbulenceIntensityBase: 0.10,
  turbulenceIntensityStorm: 0.35,

  waveGenerationCoefficient: 0.02,
  waveMaxHeightFactor:     0.4,
  wavePeriodBaseFactor:    1.2,

  windErosionThreshold:    6.0,
  windErosionRateFactor:   0.001,
  windErosionCohesionFactor: 0.8,

  grassSwayThreshold:      2.0,
  foliageSwayThreshold:    4.0,
  treeSwayThreshold:       8.0,
  windDamageThreshold:    18.0,

  windChillFactor:         0.15
});

// ─── wind material parameter sets ──────────────────────────────
const WIND_MATERIAL = Object.freeze({
  BLOWING_SAND: {
    pbr: { baseColor: [0.78, 0.68, 0.50], metalness: 0.00, roughness: 0.85, clearcoat: 0.00, transmission: 0.00, ior: 1.55, sheen: 0.10, anisotropy: 0.00 },
    anime: { baseColor: [0.82, 0.72, 0.54], quantizeSteps: 3, rimPower: 2.0, rimColor: [0.92, 0.85, 0.70] },
    subsurfaceRadius: [0.01, 0.01, 0.01],
    emissive:         [0.00, 0.00, 0.00],
    particleOpacity:  0.45,
    particleDensity:  0.80
  },
  DRIFTING_SNOW: {
    pbr: { baseColor: [0.92, 0.94, 0.97], metalness: 0.00, roughness: 0.75, clearcoat: 0.10, transmission: 0.05, ior: 1.31, sheen: 0.35, anisotropy: 0.00 },
    anime: { baseColor: [0.94, 0.96, 0.99], quantizeSteps: 2, rimPower: 1.3, rimColor: [0.80, 0.92, 1.00] },
    subsurfaceRadius: [0.10, 0.12, 0.15],
    emissive:         [0.00, 0.00, 0.02],
    particleOpacity:  0.60,
    particleDensity:  0.90
  },
  DUST_HAZE: {
    pbr: { baseColor: [0.70, 0.62, 0.50], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.90, ior: 1.00, sheen: 0.00, anisotropy: 0.00 },
    anime: { baseColor: [0.74, 0.66, 0.54], quantizeSteps: 2, rimPower: 1.8, rimColor: [0.85, 0.78, 0.65] },
    subsurfaceRadius: [0.10, 0.10, 0.10],
    emissive:         [0.00, 0.00, 0.00],
    particleOpacity:  0.30,
    particleDensity:  0.70
  },
  WIND_BENT_FOLIAGE: {
    pbr: { baseColor: [0.35, 0.55, 0.25], metalness: 0.00, roughness: 0.60, clearcoat: 0.20, transmission: 0.05, ior: 1.40, sheen: 0.30, anisotropy: 0.10 },
    anime: { baseColor: [0.38, 0.58, 0.28], quantizeSteps: 3, rimPower: 1.7, rimColor: [0.55, 0.85, 0.50] },
    subsurfaceRadius: [0.08, 0.12, 0.05],
    emissive:         [0.00, 0.00, 0.00],
    particleOpacity:  0.00,
    particleDensity:  0.00
  },
  WAVE_CAPPED_WATER: {
    pbr: { baseColor: [0.15, 0.30, 0.42], metalness: 0.00, roughness: 0.15, clearcoat: 0.90, transmission: 0.85, ior: 1.33, sheen: 0.10, anisotropy: 0.00 },
    anime: { baseColor: [0.20, 0.38, 0.50], quantizeSteps: 3, rimPower: 1.4, rimColor: [0.65, 0.88, 1.00] },
    subsurfaceRadius: [0.20, 0.25, 0.30],
    emissive:         [0.00, 0.02, 0.03],
    particleOpacity:  0.85,
    particleDensity:  0.95
  }
});

// ─── defaults (fixed: valid 32-bit hex worldSeed) ──────────────
const WIND_DEFAULTS = Object.freeze({
  worldSeed:              0xA1D19C0D,
  cellSize:               64.0,
  chunkSize:              1000,
  maxCellsPerChunk:       64,
  maxChunksPerFrame:      8,
  latitudeRange:          90.0,
  windErosionEnabled:     true,
  waveGenerationEnabled:  true,
  floraSwayEnabled:       true,
  mutationCoalesceWindow: 5.0,
  windStateChangeCooldown: 2.0
});

class ClimateWindProvider {
  constructor(options = {}) {
    this.defaults = { ...WIND_DEFAULTS, ...(options.defaults || {}) };
    this.constants = { ...WIND_CONSTANTS, ...(options.constants || {}) };
    this.thresholds = [...WIND_STATE_THRESHOLDS];

    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColor = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();
    this._tmpRay = new Ray();
    this._tmpPlane = new Plane();

    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    this._chunkWindSpeed       = new Float32Array(chunkCap);
    this._chunkWindDirX        = new Float32Array(chunkCap);
    this._chunkWindDirZ        = new Float32Array(chunkCap);
    this._chunkWindVertical    = new Float32Array(chunkCap);
    this._chunkGustFactor      = new Float32Array(chunkCap);
    this._chunkGustSpeedMax    = new Float32Array(chunkCap);
    this._chunkTurbulenceIntensity = new Float32Array(chunkCap);
    this._chunkWindState       = new Uint8Array(chunkCap);
    this._chunkOrographicLift  = new Float32Array(chunkCap);
    this._chunkValleyChannel   = new Float32Array(chunkCap);
    this._chunkThermalComponent = new Float32Array(chunkCap);
    this._chunkCoriolisDeflection = new Float32Array(chunkCap);
    this._chunkBoundaryLayerHeight = new Float32Array(chunkCap);
    this._chunkGrassSwayWeight = new Float32Array(chunkCap);
    this._chunkFoliageSwayWeight = new Float32Array(chunkCap);
    this._chunkTreeSwayWeight  = new Float32Array(chunkCap);
    this._chunkWindErosion     = new Float32Array(chunkCap);
    this._chunkWaveHeight      = new Float32Array(chunkCap);
    this._chunkWavePeriod      = new Float32Array(chunkCap);
    this._chunkWindChill       = new Float32Array(chunkCap);
    this._chunkGlobalCirculation = new Float32Array(chunkCap);

    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellSpeed = new Array(chunkCap).fill(null);
    this._chunkCellDirX = new Array(chunkCap).fill(null);
    this._chunkCellDirZ = new Array(chunkCap).fill(null);
    this._chunkCellVertical = new Array(chunkCap).fill(null);
    this._chunkCellGust = new Array(chunkCap).fill(null);
    this._chunkCellState = new Array(chunkCap).fill(null);

    this._cellPool = { x: [], y: [], z: [], speed: [], dirX: [], dirZ: [], vertical: [], gust: [] };
    this._stateArrayPool = [];

    this._globalWind = {
      avgSpeed: 0,
      avgVertical: 0,
      avgGustFactor: 0,
      avgTurbulenceIntensity: 0,
      avgWindState: 0,
      dominantDirection: 0,
      calmFraction: 0,
      strongFraction: 0,
      galeFraction: 0,
      avgGrassSway: 0,
      avgFoliageSway: 0,
      avgTreeSway: 0,
      avgWaveHeight: 0,
      avgWindErosion: 0,
      avgWindChill: 15
    };

    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    this._stats = {
      updates: 0, chunksProcessed: 0, cellsSampled: 0,
      calmCells: 0, breezeCells: 0, strongCells: 0, galeCells: 0, stormCells: 0,
      windStateTransitions: 0, windErosionCells: 0, waveCells: 0,
      mutationEventsEmitted: 0
    };

    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._slope = options.slope || null;
    this._carve = options.carve || null;
    this._relief = options.relief || null;
    this._cliffs = options.cliffs || null;
    this._forest = options.forest || null;
    this._grass = options.grass || null;
    this._continental = options.continental || null;
    this._bathymetry = options.bathymetry || null;
    this._groundwater = options.groundwater || null;
    this._moisture = options.moisture || null;
    this._decomposers = options.decomposers || null;
    this._temperature = options.temperature || null;
    this._precipitation = options.precipitation || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0 },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      subsurfaceRadius: [0,0,0],
      emissive: [0,0,0],
      particleOpacity: 0,
      particleDensity: 0
    };

    this._chunkLastState = new Uint8Array(chunkCap);
    this._chunkLastTransitionTime = new Float64Array(chunkCap);

    this._globalWindBiasX = 0;
    this._globalWindBiasZ = 0;
  }

  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachSlope(s) { this._slope = s; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachRelief(r) { this._relief = r; return this; }
  attachCliffs(c) { this._cliffs = c; return this; }
  attachForest(f) { this._forest = f; return this; }
  attachGrass(g) { this._grass = g; return this; }
  attachContinental(c) { this._continental = c; return this; }
  attachBathymetry(b) { this._bathymetry = b; return this; }
  attachGroundwater(g) { this._groundwater = g; return this; }
  attachMoisture(m) { this._moisture = m; return this; }
  attachDecomposers(d) { this._decomposers = d; return this; }
  attachTemperature(t) { this._temperature = t; return this; }
  attachPrecipitation(p) { this._precipitation = p; return this; }
  attachTemporal(t) { this._temporal = t; return this; }
  attachDispatcher(d) { this._dispatcher = d; return this; }

  _getHeight(wx, wz, lod = 0) {
    if (this._carve) return this._carve.getCarvedHeight(wx, wz, lod);
    if (this._elevation) return this._elevation.getElevation(wx, wz, lod);
    if (this._terrain) return this._terrain.getHeight(wx, wz, lod);
    return 0;
  }

  _getSeaLevel() {
    return this._elevation ? this._elevation.seaLevel : 0;
  }

  _worldToLatitude(wz) {
    const worldSpan = 1_000_000;
    const lat = (wz / worldSpan) * this.defaults.latitudeRange * 2 - this.defaults.latitudeRange;
    return Math.max(-90, Math.min(90, lat));
  }

  _globalCirculationWind(latitude, outVec) {
    const absLat = Math.abs(latitude);
    const hemisphere = latitude >= 0 ? 1 : -1;

    let bearingFrom = 0;
    let speed = 0;

    if (absLat < 30) {
      bearingFrom = 90 + hemisphere * 20;
      speed = this.constants.tradeWindSpeed * Math.sin(absLat * Math.PI / 30);
    } else if (absLat < 60) {
      bearingFrom = 270 - hemisphere * 20;
      speed = this.constants.westerliesSpeed * Math.sin((absLat - 30) * Math.PI / 30);
    } else {
      bearingFrom = 90 + hemisphere * 15;
      speed = this.constants.polarEasterliesSpeed * Math.sin((absLat - 60) * Math.PI / 30);
    }

    const horseLatDamp = 1.0 - 0.7 * Math.exp(-Math.pow((absLat - 30) / 5, 2));

    const flowBearing = (bearingFrom + 180) * Math.PI / 180;
    outVec.set(Math.sin(flowBearing), 0, Math.cos(flowBearing));
    outVec.multiplyScalar(speed * horseLatDamp);

    return outVec;
  }

  _coriolisDeflection(latitude, speed) {
    if (Math.abs(latitude) < 5) return 0;
    const absLat = Math.abs(latitude);
    const hemisphere = latitude >= 0 ? 1 : -1;
    const coriolisMagnitude = Math.sin(absLat * Math.PI / 180) *
      Math.min(1, speed / this.constants.coriolisMaxLat);
    return hemisphere * coriolisMagnitude * this.constants.coriolisTurnRate;
  }

  _computeOrographicLift(wx, wz, windDirX, windDirZ) {
    const d = 100.0;
    const hL = this._getHeight(wx - d, wz);
    const hR = this._getHeight(wx + d, wz);
    const hD = this._getHeight(wx, wz - d);
    const hU = this._getHeight(wx, wz + d);

    const dhdx = (hR - hL) / (2 * d);
    const dhdz = (hU - hD) / (2 * d);
    const slopeAlongWind = dhdx * windDirX + dhdz * windDirZ;
    return slopeAlongWind * this.constants.orographicLiftFactor;
  }

  _valleyChannelling(wx, wz) {
    if (!this._relief) return 1.0;
    const relief = this._relief.classifyRelief ? this._relief.classifyRelief(wx, wz) : null;
    if (!relief) return 1.0;
    if (relief.reliefClass === RELIEF_CLASS.VALLEY || relief.reliefClass === RELIEF_CLASS.CHANNEL) {
      return this.constants.valleyChannelFactor;
    }
    if (relief.reliefClass === RELIEF_CLASS.RIDGE) return this.constants.ridgeBlockFactor;
    if (relief.reliefClass === RELIEF_CLASS.PEAK) return 1.3;
    return 1.0;
  }

  _thermalCirculation(wx, wz, sunAltitude) {
    let thermalSpeed = 0;
    let thermalDir = null;

    if (this._bathymetry) {
      const water = this._bathymetry.getWaterAt(wx, wz);
      if (water && water.waterCoverage > 0.05 && water.waterCoverage < 0.95) {
        const isDay = sunAltitude > 0;
        const speed = isDay ? this.constants.seaBreezeSpeed : this.constants.landBreezeSpeed;
        const dx = 200.0, dz = 0;
        const hOutX = this._getHeight(wx + dx, wz);
        const hOutZ = this._getHeight(wx, wz + dz);
        const seaLevel = this._getSeaLevel();
        let dirX = 0, dirZ = 0;
        if (hOutX < seaLevel) dirX = 1;
        else if (hOutZ < seaLevel) dirZ = 1;
        else {
          const hOutXm = this._getHeight(wx - dx, wz);
          const hOutZm = this._getHeight(wx, wz - dz);
          if (hOutXm < seaLevel) dirX = -1;
          else if (hOutZm < seaLevel) dirZ = -1;
        }
        if (dirX !== 0 || dirZ !== 0) {
          const sign = isDay ? -1 : 1;
          thermalSpeed = speed;
          thermalDir = { x: dirX * sign, z: dirZ * sign };
        }
      }
    }

    if (this._slope && !thermalDir) {
      const slopeAngle = this._slope.getSlopeAngle(wx, wz);
      if (slopeAngle > 0.1) {
        const isDay = sunAltitude > 0;
        thermalSpeed = isDay
          ? this.constants.valleyBreezeSpeed * Math.sin(slopeAngle)
          : this.constants.mountainBreezeSpeed * Math.sin(slopeAngle);
        if (this._slope.getAspect) {
          const aspect = this._slope.getAspect(wx, wz);
          const sign = isDay ? 1 : -1;
          thermalDir = { x: Math.cos(aspect) * sign, z: Math.sin(aspect) * sign };
        }
      }
    }

    return { speed: thermalSpeed, dir: thermalDir };
  }

  _weatherWindBoost(weatherSeverity) {
    if (weatherSeverity < 0.5) return -(0.5 - weatherSeverity) * 5.0;
    return (weatherSeverity - 0.5) * this.constants.stormWindBoost;
  }

  _boundaryLayerAttenuation(altitude, refSpeed) {
    const z0 = this.constants.logProfileZ0;
    const h = this.constants.boundaryLayerHeight;
    const groundAtten = this.constants.groundWindAttenuation;
    if (altitude < 2) return groundAtten * Math.max(0.1, altitude / 2);
    if (altitude >= h) return refSpeed;
    const lnRatio = Math.log(altitude / z0) / Math.log(h / z0);
    return refSpeed * (groundAtten + (1 - groundAtten) * lnRatio);
  }

  _gustFactor(weatherSeverity, terrainRoughness) {
    const base = this.constants.gustFactorBase;
    const storm = this.constants.gustFactorStorm;
    const stormMix = Math.min(1, Math.max(0, weatherSeverity));
    return base + (storm - base) * stormMix + terrainRoughness * 0.05;
  }

  _turbulenceIntensity(weatherSeverity, terrainRoughness) {
    const base = this.constants.turbulenceIntensityBase;
    const storm = this.constants.turbulenceIntensityStorm;
    const mix = Math.min(1, Math.max(0, weatherSeverity));
    return base + (storm - base) * mix + terrainRoughness * 0.03;
  }

  _terrainRoughness(wx, wz) {
    const d = 50.0;
    const hC = this._getHeight(wx, wz);
    const hL = this._getHeight(wx - d, wz);
    const hR = this._getHeight(wx + d, wz);
    const hD = this._getHeight(wx, wz - d);
    const hU = this._getHeight(wx, wz + d);
    const variation = Math.abs(hL - hC) + Math.abs(hR - hC) + Math.abs(hD - hC) + Math.abs(hU - hC);
    return Math.min(1, variation / (4 * d));
  }

  _classifyWindState(speed) {
    for (let i = this.thresholds.length - 1; i >= 0; i--) {
      if (speed >= this.thresholds[i]) return i;
    }
    return 0;
  }

  _computeSwayWeights(speed, grassPresent, foliagePresent) {
    let grassSway = 0;
    let foliageSway = 0;
    let treeSway = 0;
    if (grassPresent) {
      grassSway = Math.min(1, Math.max(0, (speed - this.constants.grassSwayThreshold) / 10));
    }
    if (foliagePresent) {
      foliageSway = Math.min(1, Math.max(0, (speed - this.constants.foliageSwayThreshold) / 15));
    }
    treeSway = Math.min(1, Math.max(0, (speed - this.constants.treeSwayThreshold) / 20));
    return { grassSway, foliageSway, treeSway };
  }

  _computeWindErosion(speed, cohesion) {
    if (speed < this.constants.windErosionThreshold) return 0;
    const excess = speed - this.constants.windErosionThreshold;
    return excess * (1 - cohesion * this.constants.windErosionCohesionFactor);
  }

  _computeWaveParameters(speed, waterDepth) {
    if (!this.defaults.waveGenerationEnabled) return { height: 0, period: 0 };
    if (waterDepth < 0.5) return { height: 0, period: 0 };
    const g = 9.81;
    let height = this.constants.waveGenerationCoefficient * (speed * speed) / g;
    height = Math.min(this.constants.waveMaxHeightFactor * speed, height);
    const period = this.constants.wavePeriodBaseFactor * Math.sqrt(Math.max(1, speed));
    return { height, period };
  }

  _computeWindChill(temp, speed) {
    if (speed < 4.8 || temp > 10) return temp;
    const vPow = Math.pow(speed * 3.6, 0.16);
    return 13.12 + 0.6215 * temp - 11.37 * vPow + 0.3965 * temp * vPow;
  }

  _sampleChunk(cx, cz, frame) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));

    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    if (!this._chunkCellX[slot]) {
      this._chunkCellX[slot] = this._acquireCell('x');
      this._chunkCellY[slot] = this._acquireCell('y');
      this._chunkCellZ[slot] = this._acquireCell('z');
      this._chunkCellSpeed[slot] = this._acquireCell('speed');
      this._chunkCellDirX[slot] = this._acquireCell('dirX');
      this._chunkCellDirZ[slot] = this._acquireCell('dirZ');
      this._chunkCellVertical[slot] = this._acquireCell('vertical');
      this._chunkCellGust[slot] = this._acquireCell('gust');
      this._chunkCellState[slot] = this._acquireState();
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpSpeed = this._chunkCellSpeed[slot];
    const cpDirX = this._chunkCellDirX[slot];
    const cpDirZ = this._chunkCellDirZ[slot];
    const cpVert = this._chunkCellVertical[slot];
    const cpGust = this._chunkCellGust[slot];
    const cpState = this._chunkCellState[slot];

    let placed = 0;

    const physical = frame.layers.physical;
    const weatherSeverity = this._temporal?.weatherSeverity ?? 0.3;
    const sunAltitude = physical?.sunAltitude ?? 0.7;
    const ambientTemp = physical?.ambientTemperature ?? 15;

    let sumSpeed = 0, sumDirX = 0, sumDirZ = 0, sumVert = 0, sumGust = 0;
    let sumGustFactor = 0, sumTurbulence = 0, sumOrographicLift = 0, sumValleyChannel = 0;
    let sumThermal = 0, sumCoriolis = 0;
    let sumSwayG = 0, sumSwayF = 0, sumSwayT = 0;
    let sumErosion = 0, sumWave = 0, sumWavePeriod = 0, sumWindChill = 0, sumGlobalCirc = 0;
    let windState = 0;
    const stateCount = new Uint16Array(WIND_STATE_NAMES.length);
    const seaLevel = this._getSeaLevel();

    for (let j = 0; j < cellsPerSide && placed < this.defaults.maxCellsPerChunk; j++) {
      for (let i = 0; i < cellsPerSide && placed < this.defaults.maxCellsPerChunk; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;
        const altitude = this._getHeight(wx, wz);

        const latitude = this._worldToLatitude(wz);

        const globalWind = this._globalCirculationWind(latitude, this._tmpVecA);
        const globalSpeed = globalWind.length();

        let dirX = 0, dirZ = 0;
        if (globalSpeed > 0.01) {
          dirX = globalWind.x / globalSpeed;
          dirZ = globalWind.z / globalSpeed;
        }

        const coriolis = this._coriolisDeflection(latitude, globalSpeed);
        const cosC = Math.cos(coriolis);
        const sinC = Math.sin(coriolis);
        const rotX = dirX * cosC - dirZ * sinC;
        const rotZ = dirX * sinC + dirZ * cosC;
        dirX = rotX;
        dirZ = rotZ;

        let speed = globalSpeed + this._weatherWindBoost(weatherSeverity);
        const roughness = this._terrainRoughness(wx, wz);
        speed *= (1 + roughness * 0.3);

        const valleyFactor = this._valleyChannelling(wx, wz);
        speed *= valleyFactor;

        const orographicLift = this._computeOrographicLift(wx, wz, dirX, dirZ);

        const thermal = this._thermalCirculation(wx, wz, sunAltitude);
        let thermalContribution = thermal.speed;
        if (thermal.dir) {
          const thermalWeight = Math.min(0.5, thermal.speed / Math.max(1, speed));
          dirX = dirX * (1 - thermalWeight) + thermal.dir.x * thermalWeight;
          dirZ = dirZ * (1 - thermalWeight) + thermal.dir.z * thermalWeight;
          const mag = Math.sqrt(dirX * dirX + dirZ * dirZ);
          if (mag > 1e-5) { dirX /= mag; dirZ /= mag; }
        }

        speed = this._boundaryLayerAttenuation(altitude, speed);
        if (speed < 0) speed = 0;

        const gustFactor = this._gustFactor(weatherSeverity, roughness);
        const gustSpeed = speed * (1 + gustFactor);

        const turbulence = this._turbulenceIntensity(weatherSeverity, roughness);

        const cellState = this._classifyWindState(gustSpeed);
        stateCount[cellState]++;
        windState = Math.max(windState, cellState);

        const grassPresent = this._grass ? !!this._grass.getGrassAt(wx, wz) : false;
        const foliagePresent = this._forest ? !!this._forest.getForestAt(wx, wz) : false;
        const sway = this._computeSwayWeights(speed, grassPresent, foliagePresent);

        const cohesion = 0.5;
        const erosion = this._computeWindErosion(speed, cohesion);

        let waveHeight = 0;
        let wavePeriod = 0;
        if (this._bathymetry && altitude < seaLevel) {
          const depth = seaLevel - altitude;
          if (depth > 0.5) {
            const waves = this._computeWaveParameters(speed, depth);
            waveHeight = waves.height;
            wavePeriod = waves.period;
          }
        }

        const windChill = this._computeWindChill(ambientTemp - 0.0065 * altitude, speed);

        cpx[placed] = wx;
        cpy[placed] = altitude;
        cpz[placed] = wz;
        cpSpeed[placed] = speed;
        cpDirX[placed] = dirX;
        cpDirZ[placed] = dirZ;
        cpVert[placed] = orographicLift;
        cpGust[placed] = gustSpeed;
        cpState[placed] = cellState;
        placed++;

        sumSpeed += speed;
        sumDirX += dirX * speed;
        sumDirZ += dirZ * speed;
        sumVert += orographicLift;
        sumGust += gustSpeed;
        sumGustFactor += gustFactor;
        sumTurbulence += turbulence;
        sumOrographicLift += orographicLift;
        sumValleyChannel += valleyFactor;
        sumThermal += thermalContribution;
        sumCoriolis += coriolis;
        sumSwayG += sway.grassSway;
        sumSwayF += sway.foliageSway;
        sumSwayT += sway.treeSway;
        sumErosion += erosion;
        sumWave += waveHeight;
        sumWavePeriod += wavePeriod;
        sumWindChill += windChill;
        sumGlobalCirc += globalSpeed;

        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    const avgSpeed = placed > 0 ? sumSpeed / placed : 0;
    const avgGust = placed > 0 ? sumGust / placed : 0;
    const avgDirX = placed > 0 && sumSpeed > 0 ? sumDirX / sumSpeed : 0;
    const avgDirZ = placed > 0 && sumSpeed > 0 ? sumDirZ / sumSpeed : 0;

    const dirMag = Math.sqrt(avgDirX * avgDirX + avgDirZ * avgDirZ);
    const normDirX = dirMag > 1e-5 ? avgDirX / dirMag : 0;
    const normDirZ = dirMag > 1e-5 ? avgDirZ / dirMag : 1;

    let dominantState = 0;
    let maxCount = 0;
    for (let s = 0; s < stateCount.length; s++) {
      if (stateCount[s] > maxCount) { maxCount = stateCount[s]; dominantState = s; }
    }

    this._chunkWindSpeed[slot] = avgSpeed;
    this._chunkWindDirX[slot] = normDirX;
    this._chunkWindDirZ[slot] = normDirZ;
    this._chunkWindVertical[slot] = placed > 0 ? sumVert / placed : 0;
    this._chunkGustFactor[slot] = placed > 0 ? sumGustFactor / placed : 0;
    this._chunkGustSpeedMax[slot] = avgGust;
    this._chunkTurbulenceIntensity[slot] = placed > 0 ? sumTurbulence / placed : 0.1;
    this._chunkWindState[slot] = dominantState;
    this._chunkOrographicLift[slot] = placed > 0 ? sumOrographicLift / placed : 0;
    this._chunkValleyChannel[slot] = placed > 0 ? sumValleyChannel / placed : 1.0;
    this._chunkThermalComponent[slot] = placed > 0 ? sumThermal / placed : 0;
    this._chunkCoriolisDeflection[slot] = placed > 0 ? sumCoriolis / placed : 0;
    this._chunkBoundaryLayerHeight[slot] = this.constants.boundaryLayerHeight;
    this._chunkGrassSwayWeight[slot] = placed > 0 ? sumSwayG / placed : 0;
    this._chunkFoliageSwayWeight[slot] = placed > 0 ? sumSwayF / placed : 0;
    this._chunkTreeSwayWeight[slot] = placed > 0 ? sumSwayT / placed : 0;
    this._chunkWindErosion[slot] = placed > 0 ? sumErosion / placed : 0;
    this._chunkWaveHeight[slot] = placed > 0 ? sumWave / placed : 0;
    this._chunkWavePeriod[slot] = placed > 0 ? sumWavePeriod / placed : 0;
    this._chunkWindChill[slot] = placed > 0 ? sumWindChill / placed : ambientTemp;
    this._chunkGlobalCirculation[slot] = placed > 0 ? sumGlobalCirc / placed : 0;

    this._stats.chunksProcessed++;

    const previousState = this._chunkLastState[slot];
    const now = this._lastUpdateTime > 0 ? this._lastUpdateTime : 0;
    if (previousState !== 0 && previousState !== dominantState &&
        now - this._chunkLastTransitionTime[slot] > this.defaults.windStateChangeCooldown) {
      this._chunkLastTransitionTime[slot] = now;
      this._stats.windStateTransitions++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, Math.round(avgSpeed * 5), 3.0,
          {
            kind: 'wind_transition',
            chunkX: cx, chunkZ: cz,
            fromState: previousState,
            toState: dominantState,
            fromStateName: WIND_STATE_NAMES[previousState],
            toStateName: WIND_STATE_NAMES[dominantState],
            speed: avgSpeed,
            gustSpeed: avgGust,
            direction: Math.atan2(normDirZ, normDirX)
          }
        );
        this._stats.mutationEventsEmitted++;
      }
    }
    this._chunkLastState[slot] = dominantState;

    switch (dominantState) {
      case WIND_STATE.CALM:
      case WIND_STATE.LIGHT:
        this._stats.calmCells += maxCount; break;
      case WIND_STATE.GENTLE:
      case WIND_STATE.MODERATE:
      case WIND_STATE.FRESH:
        this._stats.breezeCells += maxCount; break;
      case WIND_STATE.STRONG:
      case WIND_STATE.NEAR_GALE:
        this._stats.strongCells += maxCount; break;
      case WIND_STATE.GALE:
      case WIND_STATE.STRONG_GALE:
        this._stats.galeCells += maxCount; break;
      case WIND_STATE.STORM:
      case WIND_STATE.VIOLENT_STORM:
      case WIND_STATE.HURRICANE:
        this._stats.stormCells += maxCount; break;
    }

    if (this._chunkWindErosion[slot] > 0.1) this._stats.windErosionCells++;
    if (this._chunkWaveHeight[slot] > 0.5) this._stats.waveCells++;

    return placed;
  }

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
      this._cellPool.speed.push(this._chunkCellSpeed[slot]);
      this._cellPool.dirX.push(this._chunkCellDirX[slot]);
      this._cellPool.dirZ.push(this._chunkCellDirZ[slot]);
      this._cellPool.vertical.push(this._chunkCellVertical[slot]);
      this._cellPool.gust.push(this._chunkCellGust[slot]);
      this._stateArrayPool.push(this._chunkCellState[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellSpeed[slot] = null;
    this._chunkCellDirX[slot] = null;
    this._chunkCellDirZ[slot] = null;
    this._chunkCellVertical[slot] = null;
    this._chunkCellGust[slot] = null;
    this._chunkCellState[slot] = null;
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

  _acquireState() {
    if (this._stateArrayPool.length > 0) {
      const arr = this._stateArrayPool.pop();
      arr.fill(0);
      return arr;
    }
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  getWindAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      speed: this._chunkWindSpeed[slot],
      dirX: this._chunkWindDirX[slot],
      dirZ: this._chunkWindDirZ[slot],
      vertical: this._chunkWindVertical[slot],
      gustFactor: this._chunkGustFactor[slot],
      gustSpeedMax: this._chunkGustSpeedMax[slot],
      turbulenceIntensity: this._chunkTurbulenceIntensity[slot],
      windState: this._chunkWindState[slot],
      windStateName: WIND_STATE_NAMES[this._chunkWindState[slot]],
      orographicLift: this._chunkOrographicLift[slot],
      valleyChannel: this._chunkValleyChannel[slot],
      thermalComponent: this._chunkThermalComponent[slot],
      coriolisDeflection: this._chunkCoriolisDeflection[slot],
      boundaryLayerHeight: this._chunkBoundaryLayerHeight[slot],
      grassSwayWeight: this._chunkGrassSwayWeight[slot],
      foliageSwayWeight: this._chunkFoliageSwayWeight[slot],
      treeSwayWeight: this._chunkTreeSwayWeight[slot],
      windErosion: this._chunkWindErosion[slot],
      waveHeight: this._chunkWaveHeight[slot],
      wavePeriod: this._chunkWavePeriod[slot],
      windChill: this._chunkWindChill[slot],
      globalCirculation: this._chunkGlobalCirculation[slot],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        speed: this._chunkCellSpeed[slot],
        dirX: this._chunkCellDirX[slot],
        dirZ: this._chunkCellDirZ[slot],
        vertical: this._chunkCellVertical[slot],
        gust: this._chunkCellGust[slot],
        state: this._chunkCellState[slot]
      }
    };
  }

  sampleWindAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    if (!frame) return { speed: 0, dirX: 0, dirZ: 0, gust: 0 };

    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return {
        speed: this._chunkWindSpeed[slot],
        dirX: this._chunkWindDirX[slot],
        dirZ: this._chunkWindDirZ[slot],
        gust: this._chunkGustSpeedMax[slot]
      };
    }

    const latitude = this._worldToLatitude(wz);
    const altitude = this._getHeight(wx, wz);
    const globalWind = this._globalCirculationWind(latitude, this._tmpVecA);
    const weatherSeverity = this._temporal?.weatherSeverity ?? 0.3;
    let speed = globalWind.length() + this._weatherWindBoost(weatherSeverity);
    speed = Math.max(0, this._boundaryLayerAttenuation(altitude, speed));
    const mag = globalWind.length();
    return {
      speed,
      dirX: mag > 0.01 ? globalWind.x / mag : 0,
      dirZ: mag > 0.01 ? globalWind.z / mag : 1,
      gust: speed * 1.15
    };
  }

  getWindMaterialParams(preset) {
    return WIND_MATERIAL[preset] || WIND_MATERIAL.WIND_BENT_FOLIAGE;
  }

  blendWindMaterial(speed, moisture, hasWater, hasSnow, hasSand, out) {
    let preset = 'WIND_BENT_FOLIAGE';
    if (hasSand && speed > 5) preset = 'BLOWING_SAND';
    else if (hasSnow && speed > 4) preset = 'DRIFTING_SNOW';
    else if (hasWater && speed > 6) preset = 'WAVE_CAPPED_WATER';
    else if (moisture < 0.2 && speed > 6) preset = 'DUST_HAZE';

    const src = WIND_MATERIAL[preset];
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

    o.particleOpacity = src.particleOpacity * Math.min(1, speed / 20);
    o.particleDensity = src.particleDensity * Math.min(1, speed / 15);

    return o;
  }

  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.wind) {
      spatial.wind = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        speed: this._chunkWindSpeed,
        dirX: this._chunkWindDirX,
        dirZ: this._chunkWindDirZ,
        vertical: this._chunkWindVertical,
        gustFactor: this._chunkGustFactor,
        gustSpeedMax: this._chunkGustSpeedMax,
        turbulenceIntensity: this._chunkTurbulenceIntensity,
        windState: this._chunkWindState,
        orographicLift: this._chunkOrographicLift,
        valleyChannel: this._chunkValleyChannel,
        thermalComponent: this._chunkThermalComponent,
        coriolisDeflection: this._chunkCoriolisDeflection,
        boundaryLayerHeight: this._chunkBoundaryLayerHeight,
        grassSwayWeight: this._chunkGrassSwayWeight,
        foliageSwayWeight: this._chunkFoliageSwayWeight,
        treeSwayWeight: this._chunkTreeSwayWeight,
        windErosion: this._chunkWindErosion,
        waveHeight: this._chunkWaveHeight,
        wavePeriod: this._chunkWavePeriod,
        windChill: this._chunkWindChill,
        globalCirculation: this._chunkGlobalCirculation,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          speed: this._chunkCellSpeed,
          dirX: this._chunkCellDirX,
          dirZ: this._chunkCellDirZ,
          vertical: this._chunkCellVertical,
          gust: this._chunkCellGust,
          state: this._chunkCellState
        },
        materialParams: WIND_MATERIAL,
        stateNames: WIND_STATE_NAMES,
        thresholds: this.thresholds,
        constants: this.constants
      };
    }

    const w = spatial.wind;
    w.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (w.chunkCount >= this._chunkCap) break;
      w.chunkCX[w.chunkCount] = this._chunkCX[i];
      w.chunkCZ[w.chunkCount] = this._chunkCZ[i];
      w.chunkSlots[w.chunkCount] = i;
      w.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    let sumSpeed = 0, sumVert = 0, sumGustFactor = 0, sumTurbulence = 0;
    let sumSwayG = 0, sumSwayF = 0, sumSwayT = 0;
    let sumWave = 0, sumErosion = 0, sumWindChill = 0, sumDirX = 0, sumDirZ = 0;
    let chunksWithWind = 0;
    let calmChunks = 0, strongChunks = 0, galeChunks = 0;
    const stateCount = new Uint16Array(WIND_STATE_NAMES.length);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      chunksWithWind++;
      sumSpeed += this._chunkWindSpeed[i];
      sumVert += this._chunkWindVertical[i];
      sumGustFactor += this._chunkGustFactor[i];
      sumTurbulence += this._chunkTurbulenceIntensity[i];
      sumSwayG += this._chunkGrassSwayWeight[i];
      sumSwayF += this._chunkFoliageSwayWeight[i];
      sumSwayT += this._chunkTreeSwayWeight[i];
      sumWave += this._chunkWaveHeight[i];
      sumErosion += this._chunkWindErosion[i];
      sumWindChill += this._chunkWindChill[i];
      sumDirX += this._chunkWindDirX[i] * this._chunkWindSpeed[i];
      sumDirZ += this._chunkWindDirZ[i] * this._chunkWindSpeed[i];
      const ws = this._chunkWindState[i];
      stateCount[ws]++;
      if (ws <= WIND_STATE.LIGHT) calmChunks++;
      if (ws >= WIND_STATE.STRONG) strongChunks++;
      if (ws >= WIND_STATE.GALE) galeChunks++;
    }

    const gw = this._globalWind;
    gw.avgSpeed = chunksWithWind > 0 ? sumSpeed / chunksWithWind : 0;
    gw.avgVertical = chunksWithWind > 0 ? sumVert / chunksWithWind : 0;
    gw.avgGustFactor = chunksWithWind > 0 ? sumGustFactor / chunksWithWind : 0.15;
    gw.avgTurbulenceIntensity = chunksWithWind > 0 ? sumTurbulence / chunksWithWind : 0.1;
    gw.avgGrassSway = chunksWithWind > 0 ? sumSwayG / chunksWithWind : 0;
    gw.avgFoliageSway = chunksWithWind > 0 ? sumSwayF / chunksWithWind : 0;
    gw.avgTreeSway = chunksWithWind > 0 ? sumSwayT / chunksWithWind : 0;
    gw.avgWaveHeight = chunksWithWind > 0 ? sumWave / chunksWithWind : 0;
    gw.avgWindErosion = chunksWithWind > 0 ? sumErosion / chunksWithWind : 0;
    gw.avgWindChill = chunksWithWind > 0 ? sumWindChill / chunksWithWind : 15;
    gw.calmFraction = chunksWithWind > 0 ? calmChunks / chunksWithWind : 0;
    gw.strongFraction = chunksWithWind > 0 ? strongChunks / chunksWithWind : 0;
    gw.galeFraction = chunksWithWind > 0 ? galeChunks / chunksWithWind : 0;

    const dirMag = Math.sqrt(sumDirX * sumDirX + sumDirZ * sumDirZ);
    gw.dominantDirection = dirMag > 0.01 ? Math.atan2(sumDirZ, sumDirX) : 0;

    let dominantState = 0;
    let maxCount = 0;
    for (let s = 0; s < stateCount.length; s++) {
      if (stateCount[s] > maxCount) { maxCount = stateCount[s]; dominantState = s; }
    }
    gw.avgWindState = dominantState;

    if (!physical.windProperties) {
      physical.windProperties = {};
    }
    Object.assign(physical.windProperties, gw);

    physical.windSpeed = gw.avgSpeed;
    physical.windDirection = gw.dominantDirection;
    physical.windVector = physical.wind || [0, 0, 0];
    physical.windVector[0] = Math.cos(gw.dominantDirection) * gw.avgSpeed;
    physical.windVector[1] = gw.avgVertical;
    physical.windVector[2] = Math.sin(gw.dominantDirection) * gw.avgSpeed;
    physical.gustFactor = gw.avgGustFactor;
    physical.turbulenceIntensity = gw.avgTurbulenceIntensity;
    physical.windState = dominantState;
    physical.windStateName = WIND_STATE_NAMES[dominantState];
    physical.grassSwayWeight = gw.avgGrassSway;
    physical.foliageSwayWeight = gw.avgFoliageSway;
    physical.treeSwayWeight = gw.avgTreeSway;
    physical.waveHeight = gw.avgWaveHeight;
    physical.windErosionRate = gw.avgWindErosion;
    physical.windChillTemperature = gw.avgWindChill;

    let totalPeriod = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      totalPeriod += this._chunkWavePeriod[i];
    }
    physical.wavePeriod = chunksWithWind > 0 ? totalPeriod / chunksWithWind : 0;

    if (!physical.windStateWeights) {
      physical.windStateWeights = new Float32Array(WIND_STATE_NAMES.length);
    }
    if (chunksWithWind > 0) {
      for (let s = 0; s < stateCount.length; s++) {
        physical.windStateWeights[s] = stateCount[s] / chunksWithWind;
      }
    }
  }

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

  setThresholds(thresholds) {
    for (let i = 0; i < thresholds.length && i < this.thresholds.length; i++) {
      this.thresholds[i] = thresholds[i];
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

  getGlobalWind() { return { ...this._globalWind }; }

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
    this._relief = null;
    this._cliffs = null;
    this._forest = null;
    this._grass = null;
    this._continental = null;
    this._bathymetry = null;
    this._groundwater = null;
    this._moisture = null;
    this._decomposers = null;
    this._temperature = null;
    this._precipitation = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._stateArrayPool.length = 0;
  }
}

export {
  ClimateWindProvider,
  WIND_STATE,
  WIND_STATE_NAMES,
  WIND_STATE_THRESHOLDS,
  WIND_CONSTANTS,
  WIND_MATERIAL,
  WIND_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};