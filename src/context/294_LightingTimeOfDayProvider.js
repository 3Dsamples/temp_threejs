// file number : 294
// full path name : src/context/294_LightingTimeOfDayProvider.js
// description : Lighting time-of-day provider — the driving source for sun and moon positions, sky colour, sun colour, twilight bands, and shadow-cascade activation across the living world. Computes the actual astronomical position of the sun and moon from time-of-day, day-of-year, latitude, and axial tilt using the standard solar-position algorithm (declination δ from axial tilt and day-of-year, hour angle H from time-of-day, altitude sin(a) = sin(φ)·sin(δ) + cos(φ)·cos(δ)·cos(H), azimuth from the altitude solution). Produces five distinct twilight bands — DAY, CIVIL_TWILIGHT (−6° to 0°), NAUTICAL_TWILIGHT (−12° to −6°), ASTRONOMICAL_TWILIGHT (−18° to −12°), and NIGHT (< −18°) — plus the moon with its phase (0 = new, 0.5 = full) and its own altitude/azimuth. Provides a full 24-hour cyclic sky-colour gradient with a physically-motivated palette: warm golden hour at sunrise/sunset, pale blue midday, orange-pink twilight, deep navy night, and the characteristic purple-blue of the blue hour. Drives `physical.sunAltitudeDeg`, `physical.sunAzimuthDeg`, `physical.moonAltitudeDeg`, `physical.moonAzimuthDeg`, and `physical.sunIntensity` that 293_LightingSunIntensityProvider and the sky/atmosphere shaders consume. Manages the shadow-cascade activation curve (shadow levels 0–4) that lengthens shadows at dawn and dusk and switches them off at night, plus the per-chunk sky-tint and colour-temperature stream. Provides full PBR + anime material parameter sets for seven distinct time-of-day states — DAWN, SUNRISE, MORNING, MIDDAY, AFTERNOON, SUNSET, DUSK, NIGHT — each with base colour, exposure modifier, shadow intensity, anime rim colour, and specular response, all as live scalars the shader reads. Emits a single coalesced AUDIO_LIGHT causal event when the day-phase crosses a major boundary (sunrise, noon, sunset, midnight, moonrise, moonset). Writes per-chunk summaries into frame.layers.spatial.timeOfDay and global aggregates into frame.layers.physical.timeOfDayProperties. All scratch objects are pooled; no allocation after the first frame.
// best for : Every lighting, sky, and atmospheric consumer — 293_LightingSunIntensityProvider (consumes sun/moon positions), the sky and atmosphere shaders (consume sky tint), shadow-cascade managers (consume shadow activation), materials (consume colour temperature), and fauna/flora (consume day-phase for behaviour). This is the temporal root of the entire lighting pipeline.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision,
  ColorManagement, ColorSpace,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  BufferAttribute, Uniform, UniformsGroup
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep, CURVE_KIND }                           from './268_ExtrasCurveUtils.js';
import { TemporalContextProvider, WEATHER, WEATHER_NAMES, WEATHER_SEVERITY }
                                                            from './276_TemporalContextProvider.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';
import { TerrainProvider, BIOME_HINT }                      from './280_TerrainProvider.js';
import { ElevationProvider, ELEVATION_BAND, ATMOSPHERE }    from './281_ElevationProvider.js';
import { SlopeGradientProvider, SLOPE_BAND }                from './282_SlopeGradientProvider.js';
import { ReliefGradientProvider, RELIEF_CLASS }             from './282_Z01_ReliefGradientProvider.js';
import { CliffsGradientProvider, CLIFF_CLASS }              from './282_Z02_CliffsGradientProvider.js';
import { CarveGradientProvider, CARVE_SOURCE }              from './282_Z03_CarveGradientProvider.js';
import { RockGradientProvider, ROCK_CLASS }                 from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE }                from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE }      from './282_Z08_GrassAndFlowresGradientProvider.js';
import { BathymetryProvider, BATHY_ZONE }                   from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE }            from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE }            from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE }               from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider, CLIMATE_ZONE }         from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE }
                                                            from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider, WIND_STATE }                  from './289_ClimateWindProvider.js';
import { SoilCompositionProvider, SOIL_TEXTURE_CLASS }      from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider }                            from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider, SOIL_VISUAL_ARCHETYPE }  from './292_SoilColorTextureProvider.js';
import { LightingSunIntensityProvider, LIGHTING_STATE, LIGHTING_STATE_NAMES, LIGHTING_MATERIAL }
                                                            from './293_LightingSunIntensityProvider.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 1;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── time-of-day state codes ────────────────────────────────────
const TIME_OF_DAY_STATE = Object.freeze({
  NIGHT:                  0,
  ASTRONOMICAL_TWILIGHT:  1,
  NAUTICAL_TWILIGHT:      2,
  CIVIL_TWILIGHT:         3,
  BLUE_HOUR:              4,
  SUNRISE:                5,
  MORNING:                6,
  MIDDAY:                 7,
  AFTERNOON:              8,
  SUNSET:                 9,
  DUSK:                   10
});

const TIME_OF_DAY_STATE_NAMES = Object.freeze([
  'night', 'astronomical_twilight', 'nautical_twilight',
  'civil_twilight', 'blue_hour', 'sunrise', 'morning',
  'midday', 'afternoon', 'sunset', 'dusk'
]);

// ─── sun altitude boundaries for twilight bands (°) ────────────
const TWILIGHT_BANDS = Object.freeze({
  dayHigh:              15.0,   // sun well above horizon
  dayLow:                0.0,   // sun at horizon
  civilTwilightLow:     -6.0,
  nauticalTwilightLow: -12.0,
  astronomicalTwilightLow: -18.0,
  nightUpper:          -18.0
});

// ─── sky-colour gradient keyframes ─────────────────────────────
// Each entry: [altitudeDegrees, [R, G, B]]
// Physical sky colour at various sun altitudes (linear RGB).
const SKY_COLOR_KEYFRAMES = Object.freeze([
  [-90, [0.008, 0.010, 0.025]],  // deep night
  [-18, [0.015, 0.022, 0.055]],  // astronomical twilight
  [-12, [0.030, 0.045, 0.100]],  // nautical twilight
  [ -6, [0.080, 0.100, 0.180]],  // civil twilight
  [  0, [0.400, 0.220, 0.180]],  // sunrise/sunset
  [  6, [0.550, 0.450, 0.350]],  // golden hour
  [ 15, [0.350, 0.550, 0.850]],  // morning/afternoon
  [ 30, [0.280, 0.520, 0.950]],  // mid-morning
  [ 60, [0.220, 0.480, 1.000]],  // midday zenith
  [ 90, [0.200, 0.450, 1.000]]   // sun directly overhead
]);

// ─── sun colour gradient keyframes ────────────────────────────
// Distinct from sky — this is the direct sun disc colour.
const SUN_COLOR_KEYFRAMES = Object.freeze([
  [-18, [0.300, 0.220, 0.150]],
  [  0, [1.000, 0.450, 0.100]],
  [  6, [1.000, 0.620, 0.250]],
  [ 15, [1.000, 0.850, 0.620]],
  [ 30, [1.000, 0.950, 0.850]],
  [ 60, [1.000, 1.000, 0.970]],
  [ 90, [1.000, 1.000, 1.000]]
]);

// ─── moon colour ──────────────────────────────────────────────
const MOON_COLOR = Object.freeze([0.650, 0.720, 0.880]);
const MOON_REFLECTED_SUN_IRRADIANCE = 0.0066;   // W/m²

// ─── shadow cascade activation curve ──────────────────────────
// Shadows fade on at dawn, peak at midday, fade off at dusk,
// and are replaced by moon shadows at night.
const SHADOW_ACTIVATION = Object.freeze({
  // Sun altitude (°) → shadow intensity (0..1)
  sunKeyframes: [
    [-18, 0.00],
    [-6,  0.05],
    [ 0,  0.30],
    [ 6,  0.60],
    [15,  0.85],
    [30,  1.00],
    [60,  1.00],
    [90,  1.00]
  ],
  // Moon shadow fraction relative to sun at night.
  moonShadowFraction: 0.15,

  // Maximum shadow cascade level.
  maxCascadeLevel: 4
});

// ─── time-of-day material parameter presets (PBR + anime) ─────
const TIME_OF_DAY_MATERIAL = Object.freeze({
  [TIME_OF_DAY_STATE.DAWN]: {
    pbr: {
      baseColor:       [0.85, 0.72, 0.62],
      metalness:       0.00,
      roughness:       1.00,
      clearcoat:       0.00,
      transmission:    0.00,
      ior:             1.50,
      sheen:           0.10,
      anisotropy:      0.00,
      specularTint:    [0.90, 0.75, 0.60]
    },
    anime: {
      baseColor:       [0.88, 0.75, 0.65],
      quantizeSteps:   3,
      rimPower:        2.2,
      rimColor:        [0.95, 0.80, 0.65]
    },
    exposure:           1.10,
    colorTemperature:   3800,
    shadowIntensity:    0.30,
    skySaturation:      1.15,
    animeFlatness:      0.35
  },
  [TIME_OF_DAY_STATE.SUNRISE]: {
    pbr: { baseColor: [1.00, 0.85, 0.68], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.10, anisotropy: 0.00, specularTint: [1.00, 0.82, 0.60] },
    anime: { baseColor: [1.00, 0.88, 0.72], quantizeSteps: 3, rimPower: 2.1, rimColor: [1.00, 0.85, 0.62] },
    exposure:           1.05,
    colorTemperature:   4200,
    shadowIntensity:    0.45,
    skySaturation:      1.20,
    animeFlatness:      0.30
  },
  [TIME_OF_DAY_STATE.MORNING]: {
    pbr: { baseColor: [1.00, 0.97, 0.92], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.00, anisotropy: 0.00, specularTint: [1.00, 0.95, 0.88] },
    anime: { baseColor: [1.00, 0.98, 0.94], quantizeSteps: 3, rimPower: 2.0, rimColor: [1.00, 0.95, 0.85] },
    exposure:           1.00,
    colorTemperature:   5400,
    shadowIntensity:    0.75,
    skySaturation:      1.00,
    animeFlatness:      0.20
  },
  [TIME_OF_DAY_STATE.MIDDAY]: {
    pbr: { baseColor: [1.00, 1.00, 1.00], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.00, anisotropy: 0.00, specularTint: [1.00, 1.00, 1.00] },
    anime: { baseColor: [1.00, 1.00, 1.00], quantizeSteps: 3, rimPower: 2.0, rimColor: [1.00, 1.00, 0.98] },
    exposure:           1.00,
    colorTemperature:   5600,
    shadowIntensity:    0.90,
    skySaturation:      1.00,
    animeFlatness:      0.15
  },
  [TIME_OF_DAY_STATE.AFTERNOON]: {
    pbr: { baseColor: [1.00, 0.96, 0.90], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.00, anisotropy: 0.00, specularTint: [1.00, 0.94, 0.85] },
    anime: { baseColor: [1.00, 0.97, 0.92], quantizeSteps: 3, rimPower: 2.0, rimColor: [1.00, 0.94, 0.82] },
    exposure:           1.00,
    colorTemperature:   5400,
    shadowIntensity:    0.80,
    skySaturation:      1.00,
    animeFlatness:      0.20
  },
  [TIME_OF_DAY_STATE.SUNSET]: {
    pbr: { baseColor: [1.00, 0.78, 0.58], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.10, anisotropy: 0.00, specularTint: [1.00, 0.72, 0.50] },
    anime: { baseColor: [1.00, 0.80, 0.60], quantizeSteps: 3, rimPower: 2.1, rimColor: [1.00, 0.75, 0.55] },
    exposure:           1.10,
    colorTemperature:   3600,
    shadowIntensity:    0.45,
    skySaturation:      1.25,
    animeFlatness:      0.30
  },
  [TIME_OF_DAY_STATE.DUSK]: {
    pbr: { baseColor: [0.72, 0.62, 0.72], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.08, anisotropy: 0.00, specularTint: [0.78, 0.65, 0.75] },
    anime: { baseColor: [0.75, 0.65, 0.75], quantizeSteps: 3, rimPower: 2.3, rimColor: [0.85, 0.70, 0.85] },
    exposure:           1.20,
    colorTemperature:   5500,
    shadowIntensity:    0.20,
    skySaturation:      1.30,
    animeFlatness:      0.40
  },
  [TIME_OF_DAY_STATE.NIGHT]: {
    pbr: { baseColor: [0.14, 0.18, 0.30], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.00, anisotropy: 0.00, specularTint: [0.20, 0.24, 0.38] },
    anime: { baseColor: [0.16, 0.20, 0.32], quantizeSteps: 3, rimPower: 1.9, rimColor: [0.22, 0.30, 0.48] },
    exposure:           1.50,
    colorTemperature:   9000,
    shadowIntensity:    0.15,
    skySaturation:      0.85,
    animeFlatness:      0.55
  }
});

// ─── time-of-day defaults ────────────────────────────────────────
const TIME_OF_DAY_DEFAULTS = Object.freeze({
  worldSeed:              0x70D111C0D & 0xFFFFFFFF,
  cellSize:               128.0,
  chunkSize:              1000,
  maxCellsPerChunk:       32,
  maxChunksPerFrame:      8,
  dayLengthSeconds:       86400,          // 24 real hours
  worldLatitude:          45.0,           // degrees
  worldAxialTilt:         23.44,          // degrees
  moonCycleDays:          29.53,
  enableMoon:             true,
  enableTwilightBands:    true,
  enableShadowCascade:    true,
  transitionCooldown:     5.0
});

class LightingTimeOfDayProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...TIME_OF_DAY_DEFAULTS, ...(options.defaults || {}) };
    this.defaults.worldSeed = this.defaults.worldSeed | 0;
    this.twilight = { ...TWILIGHT_BANDS, ...(options.twilight || {}) };
    this.shadowActivation = { ...SHADOW_ACTIVATION, ...(options.shadowActivation || {}) };

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColorA = new Vec3();
    this._tmpColorB = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();

    // ── per-chunk time-of-day state ────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk summary.
    this._chunkTimeOfDayState     = new Uint8Array(chunkCap);
    this._chunkDayPhase           = new Float32Array(chunkCap);    // 0..1
    this._chunkSunAltitudeDeg     = new Float32Array(chunkCap);
    this._chunkSunAzimuthDeg      = new Float32Array(chunkCap);
    this._chunkMoonAltitudeDeg    = new Float32Array(chunkCap);
    this._chunkMoonAzimuthDeg     = new Float32Array(chunkCap);
    this._chunkMoonPhase          = new Float32Array(chunkCap);    // 0..1
    this._chunkSkyColorR          = new Float32Array(chunkCap);
    this._chunkSkyColorG          = new Float32Array(chunkCap);
    this._chunkSkyColorB          = new Float32Array(chunkCap);
    this._chunkSunColorR          = new Float32Array(chunkCap);
    this._chunkSunColorG          = new Float32Array(chunkCap);
    this._chunkSunColorB          = new Float32Array(chunkCap);
    this._chunkMoonColorR         = new Float32Array(chunkCap);
    this._chunkMoonColorG         = new Float32Array(chunkCap);
    this._chunkMoonColorB         = new Float32Array(chunkCap);
    this._chunkShadowIntensity    = new Float32Array(chunkCap);   // 0..1
    this._chunkShadowCascadeLevel = new Uint8Array(chunkCap);     // 0..4
    this._chunkExposure           = new Float32Array(chunkCap);
    this._chunkColorTemperature   = new Float32Array(chunkCap);
    this._chunkSkySaturation      = new Float32Array(chunkCap);
    this._chunkAnimeFlatness      = new Float32Array(chunkCap);

    // Per-cell data.
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellState = new Array(chunkCap).fill(null);   // Uint8Array
    this._chunkCellSunAlt = new Array(chunkCap).fill(null);
    this._chunkCellSkyColor = new Array(chunkCap).fill(null);
    this._chunkCellShadowInt = new Array(chunkCap).fill(null);

    // Free lists.
    this._cellPool = { x: [], y: [], z: [], sunAlt: [], skyColor: [], shadowInt: [] };
    this._stateArrayPool = [];

    // ── per-frame global aggregate ─────────────────────────
    this._globalTimeOfDay = {
      dayPhase: 0.5,
      timeOfDayState: TIME_OF_DAY_STATE.MIDDAY,
      sunAltitudeDeg: 45,
      sunAzimuthDeg: 180,
      moonAltitudeDeg: -20,
      moonAzimuthDeg: 0,
      moonPhase: 0.5,
      skyColor: [0.30, 0.50, 0.95],
      sunColor: [1.00, 1.00, 1.00],
      moonColor: MOON_COLOR.slice(),
      shadowIntensity: 0.9,
      shadowCascadeLevel: 3,
      exposure: 1.0,
      colorTemperature: 5600,
      skySaturation: 1.0,
      animeFlatness: 0.15
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ─────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      nightCells: 0,
      twilightCells: 0,
      blueHourCells: 0,
      sunriseCells: 0,
      morningCells: 0,
      middayCells: 0,
      afternoonCells: 0,
      sunsetCells: 0,
      duskCells: 0,
      dayPhaseTransitions: 0,
      shadowCascadeChanges: 0,
      mutationEventsEmitted: 0
    };

    // ── collaborators ─────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._moisture = options.moisture || null;
    this._temperature = options.temperature || null;
    this._precipitation = options.precipitation || null;
    this._wind = options.wind || null;
    this._temporal = options.temporal || null;
    this._sunIntensity = options.sunIntensity || null;
    this._dispatcher = options.dispatcher || null;

    // ── reusable material output ───────────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0, specularTint: [0,0,0] },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      exposure: 1.0,
      colorTemperature: 5600,
      shadowIntensity: 0.9,
      skySaturation: 1.0,
      animeFlatness: 0.15
    };

    // ── previous state per chunk (for transitions) ─────────
    this._chunkLastState = new Uint8Array(chunkCap);
    this._chunkLastTransitionTime = new Float64Array(chunkCap);
    this._chunkLastCascadeLevel = new Uint8Array(chunkCap);

    // ── last day-phase boundary crossed (for events) ───────
    this._lastBoundary = -1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachMoisture(m) { this._moisture = m; return this; }
  attachTemperature(t) { this._temperature = t; return this; }
  attachPrecipitation(p) { this._precipitation = p; return this; }
  attachWind(w) { this._wind = w; return this; }
  attachTemporal(t) { this._temporal = t; return this; }
  attachSunIntensity(s) { this._sunIntensity = s; return this; }
  attachDispatcher(d) { this._dispatcher = d; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── height lookup ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _getHeight(wx, wz, lod = 0) {
    if (this._elevation) return this._elevation.getElevation(wx, wz, lod);
    if (this._terrain) return this._terrain.getHeight(wx, wz, lod);
    return 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── sun position (astronomical) ────────────────────────
  // ══════════════════════════════════════════════════════════
  // Given day-of-year and hour-of-day, compute the sun's altitude
  // and azimuth for a given latitude and axial tilt.
  _computeSunPosition(dayOfYear, hourOfDay, latitudeDeg) {
    // Solar declination δ from day-of-year.
    const declinationDeg = -this.defaults.worldAxialTilt *
      Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));

    // Hour angle H (degrees) from hour-of-day.
    // At solar noon (12h) H = 0; ±180° from there.
    const hourAngleDeg = (hourOfDay - 12) * 15;

    // Convert to radians.
    const latRad = latitudeDeg * Math.PI / 180;
    const decRad = declinationDeg * Math.PI / 180;
    const haRad = hourAngleDeg * Math.PI / 180;

    // Solar altitude: sin(a) = sin(φ)·sin(δ) + cos(φ)·cos(δ)·cos(H)
    const sinAlt = Math.sin(latRad) * Math.sin(decRad) +
                   Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
    const altitudeRad = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
    const altitudeDeg = altitudeRad * 180 / Math.PI;

    // Solar azimuth: from the hour angle and declination.
    const cosAzNumerator = Math.sin(decRad) - Math.sin(altitudeRad) * Math.sin(latRad);
    const cosAzDenominator = Math.cos(altitudeRad) * Math.cos(latRad);
    let azimuthRad;
    if (Math.abs(cosAzDenominator) < 1e-8) {
      azimuthRad = Math.PI * (hourAngleDeg < 0 ? -1 : 1);
    } else {
      const cosAz = cosAzNumerator / cosAzDenominator;
      azimuthRad = Math.acos(Math.max(-1, Math.min(1, cosAz)));
      if (hourAngleDeg > 0) azimuthRad = 2 * Math.PI - azimuthRad;
    }
    const azimuthDeg = azimuthRad * 180 / Math.PI;

    return {
      altitudeDeg,
      azimuthDeg,
      declinationDeg
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── moon position ──────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // The moon's position lags the sun by its phase (roughly opposite
  // at full moon, aligned at new moon).
  _computeMoonPosition(dayPhase, moonCyclePhase, latitudeDeg, dayOfYear) {
    // The moon's "hour-of-day" is offset by 12 hours per full phase.
    const moonHourOfDay = (dayPhase * 24 + moonCyclePhase * 24 + 12) % 24;
    const pos = this._computeSunPosition(dayOfYear, moonHourOfDay, latitudeDeg);

    // Moon's orbital plane is tilted ~5° to the ecliptic.
    // Approximate: apply a small altitude shift based on lunar node.
    const nodeShift = 5.0 * Math.sin(2 * Math.PI * moonCyclePhase);
    return {
      altitudeDeg: pos.altitudeDeg + nodeShift,
      azimuthDeg: pos.azimuthDeg
    };
  }

  // ══════════════════════════════════════════════════════════
  // ─── time-of-day state classification ───────────────────
  // ══════════════════════════════════════════════════════════
  _classifyTimeOfDay(sunAltitudeDeg, dayPhase) {
    if (sunAltitudeDeg < this.twilight.astronomicalTwilightLow) {
      return TIME_OF_DAY_STATE.NIGHT;
    }
    if (sunAltitudeDeg < this.twilight.nauticalTwilightLow) {
      return TIME_OF_DAY_STATE.ASTRONOMICAL_TWILIGHT;
    }
    if (sunAltitudeDeg < this.twilight.civilTwilightLow) {
      return TIME_OF_DAY_STATE.NAUTICAL_TWILIGHT;
    }
    if (sunAltitudeDeg < this.twilight.dayLow) {
      return TIME_OF_DAY_STATE.CIVIL_TWILIGHT;
    }
    if (sunAltitudeDeg < 3) {
      // Very low sun: sunrise or sunset depending on dayPhase.
      return dayPhase < 0.5 ? TIME_OF_DAY_STATE.SUNRISE : TIME_OF_DAY_STATE.SUNSET;
    }
    if (sunAltitudeDeg < 8) {
      // Low sun: blue hour or golden hour depending on dayPhase.
      return dayPhase < 0.5 ? TIME_OF_DAY_STATE.BLUE_HOUR : TIME_OF_DAY_STATE.DUSK;
    }
    // Well above horizon: day.
    if (dayPhase < 0.30) return TIME_OF_DAY_STATE.MORNING;
    if (dayPhase < 0.62) return TIME_OF_DAY_STATE.MIDDAY;
    return TIME_OF_DAY_STATE.AFTERNOON;
  }

  // ══════════════════════════════════════════════════════════
  // ─── sky and sun colour gradient ────────────────────────
  // ══════════════════════════════════════════════════════════
  _interpolateKeyframes(keyframes, x, outColor) {
    if (x <= keyframes[0][0]) {
      const c = keyframes[0][1];
      outColor[0] = c[0]; outColor[1] = c[1]; outColor[2] = c[2];
      return outColor;
    }
    if (x >= keyframes[keyframes.length - 1][0]) {
      const c = keyframes[keyframes.length - 1][1];
      outColor[0] = c[0]; outColor[1] = c[1]; outColor[2] = c[2];
      return outColor;
    }
    for (let i = 0; i < keyframes.length - 1; i++) {
      if (x >= keyframes[i][0] && x <= keyframes[i + 1][0]) {
        const t = (x - keyframes[i][0]) / (keyframes[i + 1][0] - keyframes[i][0]);
        const a = keyframes[i][1];
        const b = keyframes[i + 1][1];
        outColor[0] = a[0] * (1 - t) + b[0] * t;
        outColor[1] = a[1] * (1 - t) + b[1] * t;
        outColor[2] = a[2] * (1 - t) + b[2] * t;
        return outColor;
      }
    }
    outColor[0] = 0.5; outColor[1] = 0.5; outColor[2] = 0.5;
    return outColor;
  }

  _computeSkyColor(sunAltitudeDeg, outColor) {
    return this._interpolateKeyframes(SKY_COLOR_KEYFRAMES, sunAltitudeDeg, outColor);
  }

  _computeSunColor(sunAltitudeDeg, outColor) {
    return this._interpolateKeyframes(SUN_COLOR_KEYFRAMES, sunAltitudeDeg, outColor);
  }

  // ══════════════════════════════════════════════════════════
  // ─── shadow cascade activation ──────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeShadowIntensity(sunAltitudeDeg, moonAltitudeDeg, moonPhase) {
    // Sun shadow intensity from keyframes.
    const sunShadow = this._interpolateKeyframes(
      this.shadowActivation.sunKeyframes,
      sunAltitudeDeg,
      this._tmpVecD
    );
    let intensity = sunShadow[0];   // reuse R channel as the scalar

    // Add moon shadow at night.
    if (sunAltitudeDeg < 0 && moonAltitudeDeg > 0) {
      const moonLit = Math.min(1, moonAltitudeDeg / 30) *
                      Math.abs(moonPhase - 0.5) * 2;
      intensity += moonLit * this.shadowActivation.moonShadowFraction;
    }

    return Math.max(0, Math.min(1, intensity));
  }

  _computeShadowCascadeLevel(shadowIntensity) {
    if (shadowIntensity < 0.10) return 0;
    if (shadowIntensity < 0.35) return 1;
    if (shadowIntensity < 0.60) return 2;
    if (shadowIntensity < 0.85) return 3;
    return this.shadowActivation.maxCascadeLevel;
  }

  // ══════════════════════════════════════════════════════════
  // ─── chunk sampling ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _sampleChunk(cx, cz, frame, now) {
    const chunkSize = this.defaults.chunkSize;
    const cellSize = this.defaults.cellSize;
    const cellsPerSide = Math.max(1, Math.floor(chunkSize / cellSize));

    let slot = this._getChunkSlot(cx, cz);
    if (slot < 0) slot = this._allocChunkSlot(cx, cz);

    if (!this._chunkCellX[slot]) {
      this._chunkCellX[slot] = this._acquireCell('x');
      this._chunkCellY[slot] = this._acquireCell('y');
      this._chunkCellZ[slot] = this._acquireCell('z');
      this._chunkCellState[slot] = this._acquireState();
      this._chunkCellSunAlt[slot] = this._acquireCell('sunAlt');
      this._chunkCellSkyColor[slot] = new Float32Array(this.defaults.maxCellsPerChunk * 3);
      this._chunkCellShadowInt[slot] = this._acquireCell('shadowInt');
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpState = this._chunkCellState[slot];
    const cpSunAlt = this._chunkCellSunAlt[slot];
    const cpSkyC = this._chunkCellSkyColor[slot];
    const cpShadowI = this._chunkCellShadowInt[slot];

    let placed = 0;

    // ── Global inputs ───────────────────────────────────────
    const worldTime = this._temporal ? this._temporal.elapsedWorldSeconds : now;
    const dayLength = this.defaults.dayLengthSeconds;
    const dayPhase = ((worldTime % dayLength) + dayLength) % dayLength / dayLength;
    const dayOfYear = Math.floor((worldTime / dayLength) % 365);
    const hourOfDay = dayPhase * 24;
    const moonCyclePhase = ((worldTime / (dayLength * this.defaults.moonCycleDays)) % 1 + 1) % 1;

    // Latitude varies with world Z (assume standard world convention).
    const centreZ = cz * chunkSize + chunkSize * 0.5;
    const worldSpan = 1_000_000;
    const latitude = (centreZ / worldSpan) * 180 - 90;
    const clampedLat = Math.max(-85, Math.min(85, latitude));

    // ── Sun and moon positions (chunk centre) ──────────────
    const sunPos = this._computeSunPosition(dayOfYear, hourOfDay, clampedLat);
    const moonPos = this._computeMoonPosition(dayPhase, moonCyclePhase, clampedLat, dayOfYear);

    // ── Sun/sky colours at chunk centre ────────────────────
    const sunColor = this._computeSunColor(sunPos.altitudeDeg, this._tmpColorA);
    const skyColor = this._computeSkyColor(sunPos.altitudeDeg, this._tmpColorB);

    // ── Shadow intensity at chunk centre ───────────────────
    const shadowIntensity = this._computeShadowIntensity(
      sunPos.altitudeDeg, moonPos.altitudeDeg, moonCyclePhase
    );
    const cascadeLevel = this._computeShadowCascadeLevel(shadowIntensity);

    // ── Time-of-day state ──────────────────────────────────
    const state = this._classifyTimeOfDay(sunPos.altitudeDeg, dayPhase);

    // ── Aggregates ──────────────────────────────────────────
    let sumSunAlt = 0, sumSkyR = 0, sumSkyG = 0, sumSkyB = 0, sumShadow = 0;
    const stateCount = new Uint16Array(TIME_OF_DAY_STATE_NAMES.length);

    for (let j = 0; j < cellsPerSide && placed < this.defaults.maxCellsPerChunk; j++) {
      for (let i = 0; i < cellsPerSide && placed < this.defaults.maxCellsPerChunk; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;

        // Local latitude for accuracy.
        const localLatRaw = (wz / worldSpan) * 180 - 90;
        const localLat = Math.max(-85, Math.min(85, localLatRaw));

        // Local sun position (if latitude varies).
        const localSun = (Math.abs(localLat - clampedLat) < 0.5)
          ? sunPos
          : this._computeSunPosition(dayOfYear, hourOfDay, localLat);

        // Local sun colour and sky colour.
        const localSunC = this._computeSunColor(localSun.altitudeDeg, this._tmpColorA);
        const localSkyC = this._computeSkyColor(localSun.altitudeDeg, this._tmpColorB);

        // Local shadow intensity.
        const localShadow = this._computeShadowIntensity(
          localSun.altitudeDeg, moonPos.altitudeDeg, moonCyclePhase
        );

        // Local state.
        const localState = this._classifyTimeOfDay(localSun.altitudeDeg, dayPhase);

        // Store.
        cpx[placed] = wx;
        cpy[placed] = this._getHeight(wx, wz);
        cpz[placed] = wz;
        cpState[placed] = localState;
        cpSunAlt[placed] = localSun.altitudeDeg;
        cpShadowI[placed] = localShadow;
        const co = placed * 3;
        cpSkyC[co]     = localSkyC.x;
        cpSkyC[co + 1] = localSkyC.y;
        cpSkyC[co + 2] = localSkyC.z;
        placed++;

        // Aggregate.
        sumSunAlt += localSun.altitudeDeg;
        sumSkyR += localSkyC.x;
        sumSkyG += localSkyC.y;
        sumSkyB += localSkyC.z;
        sumShadow += localShadow;
        stateCount[localState]++;

        // Per-state stats.
        switch (localState) {
          case TIME_OF_DAY_STATE.NIGHT:                  this._stats.nightCells++; break;
          case TIME_OF_DAY_STATE.ASTRONOMICAL_TWILIGHT:
          case TIME_OF_DAY_STATE.NAUTICAL_TWILIGHT:
          case TIME_OF_DAY_STATE.CIVIL_TWILIGHT:         this._stats.twilightCells++; break;
          case TIME_OF_DAY_STATE.BLUE_HOUR:              this._stats.blueHourCells++; break;
          case TIME_OF_DAY_STATE.SUNRISE:                this._stats.sunriseCells++; break;
          case TIME_OF_DAY_STATE.MORNING:                this._stats.morningCells++; break;
          case TIME_OF_DAY_STATE.MIDDAY:                 this._stats.middayCells++; break;
          case TIME_OF_DAY_STATE.AFTERNOON:              this._stats.afternoonCells++; break;
          case TIME_OF_DAY_STATE.SUNSET:                 this._stats.sunsetCells++; break;
          case TIME_OF_DAY_STATE.DUSK:                   this._stats.duskCells++; break;
        }
        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // ── Store chunk summary ────────────────────────────────
    const inv = placed > 0 ? 1 / placed : 0;
    this._chunkDayPhase[slot] = dayPhase;
    this._chunkSunAltitudeDeg[slot] = sumSunAlt * inv;
    this._chunkSunAzimuthDeg[slot] = sunPos.azimuthDeg;
    this._chunkMoonAltitudeDeg[slot] = moonPos.altitudeDeg;
    this._chunkMoonAzimuthDeg[slot] = moonPos.azimuthDeg;
    this._chunkMoonPhase[slot] = moonCyclePhase;
    this._chunkSkyColorR[slot] = sumSkyR * inv;
    this._chunkSkyColorG[slot] = sumSkyG * inv;
    this._chunkSkyColorB[slot] = sumSkyB * inv;
    this._chunkSunColorR[slot] = sunColor.x;
    this._chunkSunColorG[slot] = sunColor.y;
    this._chunkSunColorB[slot] = sunColor.z;
    this._chunkMoonColorR[slot] = MOON_COLOR[0] * (sunPos.altitudeDeg < 0 ? 1 : 0);
    this._chunkMoonColorG[slot] = MOON_COLOR[1] * (sunPos.altitudeDeg < 0 ? 1 : 0);
    this._chunkMoonColorB[slot] = MOON_COLOR[2] * (sunPos.altitudeDeg < 0 ? 1 : 0);
    this._chunkShadowIntensity[slot] = sumShadow * inv;
    this._chunkShadowCascadeLevel[slot] = cascadeLevel;
    this._chunkTimeOfDayState[slot] = state;

    // Material params for this state.
    const mat = TIME_OF_DAY_MATERIAL[state];
    if (mat) {
      this._chunkExposure[slot] = mat.exposure;
      this._chunkColorTemperature[slot] = mat.colorTemperature;
      this._chunkSkySaturation[slot] = mat.skySaturation;
      this._chunkAnimeFlatness[slot] = mat.animeFlatness;
    }

    this._stats.chunksProcessed++;

    // ── State transition event ─────────────────────────────
    const previousState = this._chunkLastState[slot];
    if (previousState !== 0 && previousState !== state &&
        now - this._chunkLastTransitionTime[slot] > this.defaults.transitionCooldown) {
      this._chunkLastTransitionTime[slot] = now;
      this._stats.dayPhaseTransitions++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, 50, 4.0,
          {
            kind: 'time_of_day_transition',
            chunkX: cx, chunkZ: cz,
            fromState: previousState,
            toState: state,
            fromStateName: TIME_OF_DAY_STATE_NAMES[previousState],
            toStateName: TIME_OF_DAY_STATE_NAMES[state],
            dayPhase,
            sunAltitude: sunPos.altitudeDeg,
            sunAzimuth: sunPos.azimuthDeg,
            moonPhase: moonCyclePhase
          }
        );
        this._stats.mutationEventsEmitted++;
      }
    }
    this._chunkLastState[slot] = state;

    // ── Cascade level transition event ─────────────────────
    const previousCascade = this._chunkLastCascadeLevel[slot];
    if (previousCascade !== cascadeLevel) {
      this._chunkLastCascadeLevel[slot] = cascadeLevel;
      this._stats.shadowCascadeChanges++;

      if (this._dispatcher && cascadeLevel >= 2) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, 15, 3.0,
          {
            kind: 'shadow_cascade_change',
            chunkX: cx, chunkZ: cz,
            fromLevel: previousCascade,
            toLevel: cascadeLevel,
            shadowIntensity: sumShadow * inv,
            sunAltitude: sunPos.altitudeDeg
          }
        );
      }
    }

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
    this._chunkLastState[slot] = 0;
    this._chunkLastTransitionTime[slot] = 0;
    this._chunkLastCascadeLevel[slot] = 0;
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
      this._cellPool.sunAlt.push(this._chunkCellSunAlt[slot]);
      this._cellPool.skyColor.push(this._chunkCellSkyColor[slot]);
      this._cellPool.shadowInt.push(this._chunkCellShadowInt[slot]);
      this._stateArrayPool.push(this._chunkCellState[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellState[slot] = null;
    this._chunkCellSunAlt[slot] = null;
    this._chunkCellSkyColor[slot] = null;
    this._chunkCellShadowInt[slot] = null;
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

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getTimeOfDayAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      timeOfDayState: this._chunkTimeOfDayState[slot],
      timeOfDayStateName: TIME_OF_DAY_STATE_NAMES[this._chunkTimeOfDayState[slot]],
      dayPhase: this._chunkDayPhase[slot],
      sunAltitudeDeg: this._chunkSunAltitudeDeg[slot],
      sunAzimuthDeg: this._chunkSunAzimuthDeg[slot],
      moonAltitudeDeg: this._chunkMoonAltitudeDeg[slot],
      moonAzimuthDeg: this._chunkMoonAzimuthDeg[slot],
      moonPhase: this._chunkMoonPhase[slot],
      skyColor: [this._chunkSkyColorR[slot], this._chunkSkyColorG[slot], this._chunkSkyColorB[slot]],
      sunColor: [this._chunkSunColorR[slot], this._chunkSunColorG[slot], this._chunkSunColorB[slot]],
      moonColor: [this._chunkMoonColorR[slot], this._chunkMoonColorG[slot], this._chunkMoonColorB[slot]],
      shadowIntensity: this._chunkShadowIntensity[slot],
      shadowCascadeLevel: this._chunkShadowCascadeLevel[slot],
      exposure: this._chunkExposure[slot],
      colorTemperature: this._chunkColorTemperature[slot],
      skySaturation: this._chunkSkySaturation[slot],
      animeFlatness: this._chunkAnimeFlatness[slot],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        state: this._chunkCellState[slot],
        sunAlt: this._chunkCellSunAlt[slot],
        skyColor: this._chunkCellSkyColor[slot],
        shadowInt: this._chunkCellShadowInt[slot]
      }
    };
  }

  // ── sample sun altitude and azimuth at any position ─────
  sampleSunPositionAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    if (!frame) {
      return { altitudeDeg: 45, azimuthDeg: 180 };
    }

    const worldTime = this._temporal ? this._temporal.elapsedWorldSeconds : performance.now() / 1000;
    const dayLength = this.defaults.dayLengthSeconds;
    const dayPhase = ((worldTime % dayLength) + dayLength) % dayLength / dayLength;
    const dayOfYear = Math.floor((worldTime / dayLength) % 365);
    const hourOfDay = dayPhase * 24;

    const worldSpan = 1_000_000;
    const latitude = Math.max(-85, Math.min(85, (wz / worldSpan) * 180 - 90));

    return this._computeSunPosition(dayOfYear, hourOfDay, latitude);
  }

  // ── sample shadow cascade level at any position ─────────
  sampleShadowCascadeAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    if (!frame) return 3;

    const sunPos = this.sampleSunPositionAt(wx, wz, frame);
    const worldTime = this._temporal ? this._temporal.elapsedWorldSeconds : performance.now() / 1000;
    const dayLength = this.defaults.dayLengthSeconds;
    const moonCyclePhase = ((worldTime / (dayLength * this.defaults.moonCycleDays)) % 1 + 1) % 1;
    const moonPos = this._computeMoonPosition(
      ((worldTime % dayLength) + dayLength) % dayLength / dayLength,
      moonCyclePhase,
      Math.max(-85, Math.min(85, (wz / 1_000_000) * 180 - 90)),
      Math.floor((worldTime / dayLength) % 365)
    );
    const intensity = this._computeShadowIntensity(sunPos.altitudeDeg, moonPos.altitudeDeg, moonCyclePhase);
    return this._computeShadowCascadeLevel(intensity);
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getTimeOfDayMaterialParams(state) {
    return TIME_OF_DAY_MATERIAL[state] || TIME_OF_DAY_MATERIAL[TIME_OF_DAY_STATE.MIDDAY];
  }

  blendTimeOfDayMaterial(state, shadowIntensity, sunColor, out) {
    const src = TIME_OF_DAY_MATERIAL[state] || TIME_OF_DAY_MATERIAL[TIME_OF_DAY_STATE.MIDDAY];
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
    o.pbr.specularTint[0] = src.pbr.specularTint[0];
    o.pbr.specularTint[1] = src.pbr.specularTint[1];
    o.pbr.specularTint[2] = src.pbr.specularTint[2];

    o.anime.baseColor[0] = src.anime.baseColor[0];
    o.anime.baseColor[1] = src.anime.baseColor[1];
    o.anime.baseColor[2] = src.anime.baseColor[2];
    o.anime.quantizeSteps = src.anime.quantizeSteps;
    o.anime.rimPower = src.anime.rimPower;
    o.anime.rimColor[0] = src.anime.rimColor[0];
    o.anime.rimColor[1] = src.anime.rimColor[1];
    o.anime.rimColor[2] = src.anime.rimColor[2];

    o.exposure = src.exposure;
    o.colorTemperature = src.colorTemperature;
    o.shadowIntensity = src.shadowIntensity * shadowIntensity;
    o.skySaturation = src.skySaturation;
    o.animeFlatness = src.animeFlatness;

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.timeOfDay) {
      spatial.timeOfDay = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        state: this._chunkTimeOfDayState,
        dayPhase: this._chunkDayPhase,
        sunAltitudeDeg: this._chunkSunAltitudeDeg,
        sunAzimuthDeg: this._chunkSunAzimuthDeg,
        moonAltitudeDeg: this._chunkMoonAltitudeDeg,
        moonAzimuthDeg: this._chunkMoonAzimuthDeg,
        moonPhase: this._chunkMoonPhase,
        skyColorR: this._chunkSkyColorR,
        skyColorG: this._chunkSkyColorG,
        skyColorB: this._chunkSkyColorB,
        sunColorR: this._chunkSunColorR,
        sunColorG: this._chunkSunColorG,
        sunColorB: this._chunkSunColorB,
        moonColorR: this._chunkMoonColorR,
        moonColorG: this._chunkMoonColorG,
        moonColorB: this._chunkMoonColorB,
        shadowIntensity: this._chunkShadowIntensity,
        shadowCascadeLevel: this._chunkShadowCascadeLevel,
        exposure: this._chunkExposure,
        colorTemperature: this._chunkColorTemperature,
        skySaturation: this._chunkSkySaturation,
        animeFlatness: this._chunkAnimeFlatness,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          state: this._chunkCellState,
          sunAlt: this._chunkCellSunAlt,
          skyColor: this._chunkCellSkyColor,
          shadowInt: this._chunkCellShadowInt
        },
        materialParams: TIME_OF_DAY_MATERIAL,
        stateNames: TIME_OF_DAY_STATE_NAMES
      };
    }

    const t = spatial.timeOfDay;
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

    let sumSunAlt = 0, sumSunAz = 0, sumMoonAlt = 0, sumMoonAz = 0, sumMoonPhase = 0;
    let sumSkyR = 0, sumSkyG = 0, sumSkyB = 0;
    let sumSunR = 0, sumSunG = 0, sumSunB = 0;
    let sumShadow = 0, sumExposure = 0, sumColorTemp = 0;
    let sumSkySat = 0, sumAnime = 0;
    let sumCascadeLevel = 0;
    let chunksWithTimeOfDay = 0;
    const stateCount = new Uint16Array(TIME_OF_DAY_STATE_NAMES.length);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      chunksWithTimeOfDay++;
      sumSunAlt += this._chunkSunAltitudeDeg[i];
      sumSunAz += this._chunkSunAzimuthDeg[i];
      sumMoonAlt += this._chunkMoonAltitudeDeg[i];
      sumMoonAz += this._chunkMoonAzimuthDeg[i];
      sumMoonPhase += this._chunkMoonPhase[i];
      sumSkyR += this._chunkSkyColorR[i];
      sumSkyG += this._chunkSkyColorG[i];
      sumSkyB += this._chunkSkyColorB[i];
      sumSunR += this._chunkSunColorR[i];
      sumSunG += this._chunkSunColorG[i];
      sumSunB += this._chunkSunColorB[i];
      sumShadow += this._chunkShadowIntensity[i];
      sumCascadeLevel += this._chunkShadowCascadeLevel[i];
      sumExposure += this._chunkExposure[i];
      sumColorTemp += this._chunkColorTemperature[i];
      sumSkySat += this._chunkSkySaturation[i];
      sumAnime += this._chunkAnimeFlatness[i];
      stateCount[this._chunkTimeOfDayState[i]]++;
    }

    const gt = this._globalTimeOfDay;
    const inv = chunksWithTimeOfDay > 0 ? 1 / chunksWithTimeOfDay : 0;
    gt.sunAltitudeDeg = sumSunAlt * inv;
    gt.sunAzimuthDeg = sumSunAz * inv;
    gt.moonAltitudeDeg = sumMoonAlt * inv;
    gt.moonAzimuthDeg = sumMoonAz * inv;
    gt.moonPhase = sumMoonPhase * inv;
    gt.skyColor[0] = sumSkyR * inv;
    gt.skyColor[1] = sumSkyG * inv;
    gt.skyColor[2] = sumSkyB * inv;
    gt.sunColor[0] = sumSunR * inv;
    gt.sunColor[1] = sumSunG * inv;
    gt.sunColor[2] = sumSunB * inv;
    gt.shadowIntensity = sumShadow * inv;
    gt.shadowCascadeLevel = Math.round(sumCascadeLevel * inv);
    gt.exposure = sumExposure * inv || 1.0;
    gt.colorTemperature = sumColorTemp * inv || 5600;
    gt.skySaturation = sumSkySat * inv || 1.0;
    gt.animeFlatness = sumAnime * inv || 0.15;

    // Day phase from temporal provider (chunk-invariant).
    if (this._temporal) {
      const t = this._temporal;
      const dayLength = this.defaults.dayLengthSeconds;
      const worldTime = t.elapsedWorldSeconds || 0;
      gt.dayPhase = ((worldTime % dayLength) + dayLength) % dayLength / dayLength;
    }

    // Dominant state.
    let dominantState = 0;
    let maxCount = 0;
    for (let s = 0; s < stateCount.length; s++) {
      if (stateCount[s] > maxCount) { maxCount = stateCount[s]; dominantState = s; }
    }
    gt.timeOfDayState = dominantState;

    if (!physical.timeOfDayProperties) physical.timeOfDayProperties = {};
    Object.assign(physical.timeOfDayProperties, gt);

    // Material-facing aggregates.
    physical.sunAltitudeDeg = gt.sunAltitudeDeg;
    physical.sunAzimuthDeg = gt.sunAzimuthDeg;
    physical.moonAltitudeDeg = gt.moonAltitudeDeg;
    physical.moonAzimuthDeg = gt.moonAzimuthDeg;
    physical.moonPhase = gt.moonPhase;
    physical.skyColorTimeOfDay = gt.skyColor;
    physical.sunColorTimeOfDay = gt.sunColor;
    physical.moonColorTimeOfDay = gt.moonColor;
    physical.shadowIntensityTimeOfDay = gt.shadowIntensity;
    physical.shadowCascadeLevel = gt.shadowCascadeLevel;
    physical.exposureTimeOfDay = gt.exposure;
    physical.colorTemperatureTimeOfDay = gt.colorTemperature;
    physical.skySaturation = gt.skySaturation;
    physical.animeFlatness = gt.animeFlatness;
    physical.timeOfDayState = dominantState;
    physical.timeOfDayStateName = TIME_OF_DAY_STATE_NAMES[dominantState];
    physical.dayPhase = gt.dayPhase;

    if (!physical.timeOfDayStateWeights) {
      physical.timeOfDayStateWeights = new Float32Array(TIME_OF_DAY_STATE_NAMES.length);
    }
    if (chunksWithTimeOfDay > 0) {
      for (let s = 0; s < stateCount.length; s++) {
        physical.timeOfDayStateWeights[s] = stateCount[s] / chunksWithTimeOfDay;
      }
    }

    // Also update the physical layer's sunAltitudeDeg so 293 can
    // consume it without circular dependency.
    physical.sunAltitudeDeg = gt.sunAltitudeDeg;
    physical.sunAzimuthDeg = gt.sunAzimuthDeg;
    physical.moonAltitudeDeg = gt.moonAltitudeDeg;
    physical.moonAzimuthDeg = gt.moonAzimuthDeg;
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
      this._sampleChunk(cx, cz, frame, now);
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

  setDayLength(seconds) {
    if (seconds > 0) this.defaults.dayLengthSeconds = seconds;
    return this;
  }

  setWorldLatitude(degrees) {
    this.defaults.worldLatitude = Math.max(-85, Math.min(85, degrees));
    return this;
  }

  setWorldAxialTilt(degrees) {
    this.defaults.worldAxialTilt = Math.max(0, Math.min(45, degrees));
    return this;
  }

  setMoonCycleDays(days) {
    if (days > 0) this.defaults.moonCycleDays = days;
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
  getGlobalTimeOfDay() { return { ...this._globalTimeOfDay }; }

  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  dispose() {
    this._terrain = null;
    this._elevation = null;
    this._moisture = null;
    this._temperature = null;
    this._precipitation = null;
    this._wind = null;
    this._temporal = null;
    this._sunIntensity = null;
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
  LightingTimeOfDayProvider,
  TIME_OF_DAY_STATE,
  TIME_OF_DAY_STATE_NAMES,
  TWILIGHT_BANDS,
  SKY_COLOR_KEYFRAMES,
  SUN_COLOR_KEYFRAMES,
  SHADOW_ACTIVATION,
  TIME_OF_DAY_MATERIAL,
  TIME_OF_DAY_DEFAULTS,
  MOON_COLOR,
  MOON_REFLECTED_SUN_IRRADIANCE,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};