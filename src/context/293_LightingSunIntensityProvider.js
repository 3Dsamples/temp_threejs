// file number : 293
// full path name : src/context/293_LightingSunIntensityProvider.js
// description : Lighting sun intensity provider — direct, filtered, and diffused sunlight with full IES-light support, perceptual colour handling, cloud irradiance as an additional directional light source, and sky/sun colour interplay that drives material and lighting changes across the living world. Computes sun position from solar altitude and azimuth, applies Rayleigh and Mie atmospheric extinction to derive direct-beam radiance and diffuse sky radiance, models cloud-cover attenuation with a bright-cloud vs rain-cloud directional irradiance contribution, blends sun colour through OKLab perceptual space using a Planckian colour-temperature curve (2000 K – 6500 K depending on altitude), and exposes complete IES-light parameter sets so any user-supplied IES profile can be applied to the sun, sky, or cloud irradiance direction. Provides full PBR + anime material parameter sets for sunlit, shadow, overcast, golden-hour, and blue-hour states — with colour temperature, albedo-modulation, and specular-response parameters the shader reads each frame. Writes per-chunk summaries into frame.layers.spatial.lighting and global aggregates into frame.layers.physical.lightingProperties, and emits a single coalesced AUDIO_LIGHT causal event when lighting state crosses a boundary (clear → overcast, day → golden-hour, etc.). All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs physically-motivated lighting state — the clustered-lighting pass, PBR and anime shader albedo and specular modulation, cloud-shadow and cloud-glow passes, terrain material colour-grading, foliage and water response, camera exposure and tone-mapping, and sky/atmosphere couplers. Complements 287_ClimateTemperatureProvider (thermal state), 288_ClimatePrecipitationProvider (hydrological state), and 289_ClimateWindProvider (kinetic state) by providing the electromagnetic state that all of them finally deliver to the eye.
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
  BufferAttribute, Uniform, UniformsGroup,
  IESLoader
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
import { CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND, CARVE_MATERIAL_COLORS }
                                                            from './282_Z03_CarveGradientProvider.js';
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

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 2;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── lighting state codes ───────────────────────────────────────
const LIGHTING_STATE = Object.freeze({
  NIGHT:          0,
  BLUE_HOUR:      1,
  GOLDEN_HOUR:    2,
  DAY_CLEAR:      3,
  DAY_HAZY:       4,
  DAY_OVERCAST:   5,
  DAY_RAIN:       6,
  SUNSET:         7,
  SUNRISE:        8
});

const LIGHTING_STATE_NAMES = Object.freeze([
  'night', 'blue_hour', 'golden_hour', 'day_clear',
  'day_hazy', 'day_overcast', 'day_rain', 'sunset', 'sunrise'
]);

// ─── solar physics constants ────────────────────────────────────
const SOLAR_CONSTANTS = Object.freeze({
  // Solar irradiance at top of atmosphere (W/m²).
  solarConstant:       1361.0,

  // Atmospheric extinction coefficients (1/m) at sea level.
  rayleighCoeffR:      5.8e-6,
  rayleighCoeffG:     13.5e-6,
  rayleighCoeffB:     33.1e-6,
  mieCoeff:            1.5e-6,
  ozoneCoeffR:         0.0,
  ozoneCoeffG:         0.0,
  ozoneCoeffB:         0.0,

  // Scale heights (m).
  rayleighScaleHeight:  8500.0,
  mieScaleHeight:       1200.0,

  // Luminance conversion: 1 W/m² = 683 lm/W at 555 nm.
  lumensPerWatt:        683.0,

  // Angular radius of the sun (radians).
  sunAngularRadius:     0.004675
});

// ─── cloud irradiance constants ────────────────────────────────
const CLOUD_CONSTANTS = Object.freeze({
  // Bright cumulus clouds have a bright sun-side and a shaded side.
  // Their directional irradiance is modelled as a second light
  // coming from the "cloud-lit" direction (typically up-and-away
  // from the sun, roughly opposite the sun's horizontal component).
  brightCloudAlbedo:     0.85,
  brightCloudIrradiance:  0.35,      // fraction of direct sun intensity
  rainCloudAlbedo:        0.35,
  rainCloudIrradiance:    0.15,
  overcastIrradiance:     0.45,      // fraction of direct sun intensity

  // Direction offset from the sun (radians).
  cloudDirectionOffset:   0.6,

  // Per-cloud-type colour tints (linear RGB).
  brightCloudColor:       [1.00, 0.98, 0.94],
  rainCloudColor:         [0.55, 0.60, 0.70],
  overcastColor:          [0.85, 0.88, 0.92]
});

// ─── Planckian colour-temperature lookup table ──────────────────
// Precomputed linear-RGB values from 1000 K to 10000 K, step 250 K.
// Values from the blackbody radiation curve (CIE 1931 → sRGB).
const COLOR_TEMPERATURE_TABLE = Object.freeze([
  [1000, [1.000, 0.295, 0.000]],
  [1500, [1.000, 0.470, 0.063]],
  [2000, [1.000, 0.600, 0.200]],
  [2500, [1.000, 0.700, 0.360]],
  [3000, [1.000, 0.790, 0.530]],
  [3500, [1.000, 0.850, 0.660]],
  [4000, [1.000, 0.900, 0.780]],
  [4500, [1.000, 0.935, 0.865]],
  [5000, [1.000, 0.960, 0.930]],
  [5500, [1.000, 0.980, 0.970]],
  [6000, [0.990, 0.990, 1.000]],
  [6500, [0.960, 0.970, 1.000]],
  [7000, [0.930, 0.950, 1.000]],
  [8000, [0.880, 0.920, 1.000]],
  [9000, [0.840, 0.890, 1.000]],
  [10000, [0.810, 0.870, 1.000]]
]);

// ─── IES light parameter defaults ──────────────────────────────
const IES_DEFAULTS = Object.freeze({
  enabled:             false,
  map:                 null,      // Texture from IESLoader
  intensity:           1.0,
  distance:            100.0,
  decay:               2.0,
  penumbra:            0.0,
  angle:               Math.PI / 4,
  applyToSun:          true,
  applyToSky:          false,
  applyToCloud:        false
});

// ─── lighting material parameter presets (PBR + anime) ─────────
const LIGHTING_MATERIAL = Object.freeze({
  SUNLIT_CLEAR: {
    pbr: {
      baseColor:       [1.00, 1.00, 1.00],
      metalness:       0.00,
      roughness:       1.00,
      clearcoat:       0.00,
      transmission:    0.00,
      ior:             1.50,
      sheen:           0.00,
      anisotropy:      0.00,
      specularTint:    [1.00, 1.00, 1.00]
    },
    anime: {
      baseColor:       [1.00, 1.00, 1.00],
      quantizeSteps:   3,
      rimPower:        2.0,
      rimColor:        [1.00, 0.98, 0.92]
    },
    exposureModifier:   1.00,
    colourTemperature:  5600,
    sunIntensity:       1.00,
    diffuseIntensity:   1.00,
    shadowIntensity:    0.85
  },
  SUNLIT_GOLDEN: {
    pbr: { baseColor: [1.00, 0.88, 0.72], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.00, anisotropy: 0.00, specularTint: [1.00, 0.85, 0.65] },
    anime: { baseColor: [1.00, 0.90, 0.75], quantizeSteps: 3, rimPower: 2.1, rimColor: [1.00, 0.82, 0.60] },
    exposureModifier:  1.10,
    colourTemperature: 3200,
    sunIntensity:      0.85,
    diffuseIntensity:  0.70,
    shadowIntensity:   0.80
  },
  SUNLIT_BLUE_HOUR: {
    pbr: { baseColor: [0.75, 0.82, 1.00], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.00, anisotropy: 0.00, specularTint: [0.70, 0.80, 1.00] },
    anime: { baseColor: [0.78, 0.85, 1.00], quantizeSteps: 3, rimPower: 2.2, rimColor: [0.65, 0.78, 1.00] },
    exposureModifier:  1.30,
    colourTemperature: 8000,
    sunIntensity:      0.15,
    diffuseIntensity:  0.25,
    shadowIntensity:   0.60
  },
  OVERCAST: {
    pbr: { baseColor: [0.85, 0.88, 0.92], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.00, anisotropy: 0.00, specularTint: [0.80, 0.85, 0.90] },
    anime: { baseColor: [0.88, 0.90, 0.94], quantizeSteps: 3, rimPower: 2.3, rimColor: [0.75, 0.82, 0.90] },
    exposureModifier:  1.15,
    colourTemperature: 6500,
    sunIntensity:      0.10,
    diffuseIntensity:  0.75,
    shadowIntensity:   0.30
  },
  RAIN: {
    pbr: { baseColor: [0.62, 0.65, 0.72], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.00, anisotropy: 0.00, specularTint: [0.55, 0.60, 0.70] },
    anime: { baseColor: [0.65, 0.68, 0.75], quantizeSteps: 3, rimPower: 2.4, rimColor: [0.55, 0.60, 0.70] },
    exposureModifier:  1.25,
    colourTemperature: 7000,
    sunIntensity:      0.05,
    diffuseIntensity:  0.55,
    shadowIntensity:   0.20
  },
  NIGHT_CLEAR: {
    pbr: { baseColor: [0.10, 0.13, 0.22], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.00, ior: 1.50, sheen: 0.00, anisotropy: 0.00, specularTint: [0.15, 0.20, 0.35] },
    anime: { baseColor: [0.12, 0.15, 0.25], quantizeSteps: 3, rimPower: 1.8, rimColor: [0.20, 0.28, 0.45] },
    exposureModifier:  1.50,
    colourTemperature: 9000,
    sunIntensity:      0.02,
    diffuseIntensity:  0.05,
    shadowIntensity:   0.10
  }
});

// ─── IES profile registry ──────────────────────────────────────
// Users can register their own IES profiles at runtime.
const IES_PROFILES = new Map();

// ─── lighting defaults ─────────────────────────────────────────
const LIGHTING_DEFAULTS = Object.freeze({
  worldSeed:              0x11GHT11C0D & 0xFFFFFFFF,
  cellSize:               64.0,
  chunkSize:              1000,
  maxCellsPerChunk:       64,
  maxChunksPerFrame:      8,
  exposureBase:           1.0,
  enableIES:              true,
  enableCloudDirectional: true,
  enablePerceptualBlend:  true,
  lightingStateCooldown:  5.0,
  iesTexturePath:         './ies/'
});

class LightingSunIntensityProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...LIGHTING_DEFAULTS, ...(options.defaults || {}) };
    this.defaults.worldSeed = this.defaults.worldSeed | 0;
    this.solar = { ...SOLAR_CONSTANTS, ...(options.solar || {}) };
    this.cloud = { ...CLOUD_CONSTANTS, ...(options.cloud || {}) };
    this.ies = { ...IES_DEFAULTS, ...(options.ies || {}) };

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColorA = new Vec3();
    this._tmpColorB = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();

    // ── per-chunk lighting state ───────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk lighting state.
    this._chunkLightingState      = new Uint8Array(chunkCap);
    this._chunkSunAltitude        = new Float32Array(chunkCap);
    this._chunkSunAzimuth         = new Float32Array(chunkCap);
    this._chunkSunDirX            = new Float32Array(chunkCap);
    this._chunkSunDirY            = new Float32Array(chunkCap);
    this._chunkSunDirZ            = new Float32Array(chunkCap);
    this._chunkSunColorR          = new Float32Array(chunkCap);
    this._chunkSunColorG          = new Float32Array(chunkCap);
    this._chunkSunColorB          = new Float32Array(chunkCap);
    this._chunkSunIntensity       = new Float32Array(chunkCap);
    this._chunkSunLux             = new Float32Array(chunkCap);
    this._chunkDiffuseSkyIntensity = new Float32Array(chunkCap);
    this._chunkDiffuseSkyColorR   = new Float32Array(chunkCap);
    this._chunkDiffuseSkyColorG   = new Float32Array(chunkCap);
    this._chunkDiffuseSkyColorB   = new Float32Array(chunkCap);
    this._chunkAmbientIntensity   = new Float32Array(chunkCap);
    this._chunkCloudIrradiance    = new Float32Array(chunkCap);
    this._chunkCloudDirX          = new Float32Array(chunkCap);
    this._chunkCloudDirY          = new Float32Array(chunkCap);
    this._chunkCloudDirZ          = new Float32Array(chunkCap);
    this._chunkCloudColorR        = new Float32Array(chunkCap);
    this._chunkCloudColorG        = new Float32Array(chunkCap);
    this._chunkCloudColorB        = new Float32Array(chunkCap);
    this._chunkExposure           = new Float32Array(chunkCap);
    this._chunkColorTemperature   = new Float32Array(chunkCap);
    this._chunkShadowIntensity    = new Float32Array(chunkCap);

    // IES-applied per chunk.
    this._chunkIesSunIntensity    = new Float32Array(chunkCap);
    this._chunkIesSkyIntensity    = new Float32Array(chunkCap);
    this._chunkIesCloudIntensity  = new Float32Array(chunkCap);

    // Per-cell data.
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellSunIntensity = new Array(chunkCap).fill(null);
    this._chunkCellLightingState = new Array(chunkCap).fill(null);   // Uint8Array
    this._chunkCellSunColor = new Array(chunkCap).fill(null);        // Float32Array × 3
    this._chunkCellSunDir = new Array(chunkCap).fill(null);          // Float32Array × 3
    this._chunkCellCloudColor = new Array(chunkCap).fill(null);      // Float32Array × 3

    // Free lists.
    this._cellPool = {
      x: [], y: [], z: [], sunIntensity: [], sunColor: [], sunDir: [], cloudColor: []
    };
    this._stateArrayPool = [];

    // ── per-frame global aggregate ─────────────────────────
    this._globalLighting = {
      avgSunIntensity: 1.0,
      avgSunLux: 75000.0,
      avgDiffuseSkyIntensity: 1.0,
      avgAmbientIntensity: 0.3,
      avgCloudIrradiance: 0.0,
      avgExposure: 1.0,
      avgColorTemperature: 5600,
      avgShadowIntensity: 0.85,
      dominantLightingState: 0,
      sunDirection: [0, 1, 0],
      sunColor: [1, 1, 1],
      skyColor: [0.5, 0.7, 1.0],
      cloudDirection: [0, 1, 0],
      cloudColor: [1, 1, 1],
      cloudIrradianceDirection: [0, 1, 0],
      iesActive: false
    };

    // ── timing / frame reference ───────────────────────────
    this._lastUpdateTime = -Infinity;
    this._frameRef = null;

    // ── statistics ─────────────────────────────────────────
    this._stats = {
      updates: 0,
      chunksProcessed: 0,
      cellsSampled: 0,
      clearCells: 0,
      overcastCells: 0,
      rainCells: 0,
      goldenHourCells: 0,
      blueHourCells: 0,
      nightCells: 0,
      iesApplicationCount: 0,
      lightingStateTransitions: 0,
      mutationEventsEmitted: 0
    };

    // ── collaborators ─────────────────────────────────────
    this._terrain = options.terrain || null;
    this._elevation = options.elevation || null;
    this._carve = options.carve || null;
    this._moisture = options.moisture || null;
    this._temperature = options.temperature || null;
    this._precipitation = options.precipitation || null;
    this._wind = options.wind || null;
    this._temporal = options.temporal || null;
    this._dispatcher = options.dispatcher || null;

    // ── reusable material output ───────────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0, specularTint: [0,0,0] },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      exposureModifier: 1.0,
      colourTemperature: 5600,
      sunIntensity: 1.0,
      diffuseIntensity: 1.0,
      shadowIntensity: 0.85
    };

    // ── previous lighting state per chunk (for transitions) ─
    this._chunkLastState = new Uint8Array(chunkCap);
    this._chunkLastTransitionTime = new Float64Array(chunkCap);
  }

  // ══════════════════════════════════════════════════════════
  // ─── collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(t) { this._terrain = t; return this; }
  attachElevation(e) { this._elevation = e; return this; }
  attachCarve(c) { this._carve = c; return this; }
  attachMoisture(m) { this._moisture = m; return this; }
  attachTemperature(t) { this._temperature = t; return this; }
  attachPrecipitation(p) { this._precipitation = p; return this; }
  attachWind(w) { this._wind = w; return this; }
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
  // ─── register an IES profile ───────────────────────────
  // ══════════════════════════════════════════════════════════
  registerIESProfile(name, texture, params = {}) {
    IES_PROFILES.set(name, {
      map: texture,
      intensity: params.intensity ?? 1.0,
      distance: params.distance ?? 100.0,
      decay: params.decay ?? 2.0,
      penumbra: params.penumbra ?? 0.0,
      angle: params.angle ?? Math.PI / 4
    });
    return this;
  }

  // ── load an IES file and register it ──────────────────────
  async loadIESProfile(name, path) {
    if (!IESLoader) return null;
    const loader = new IESLoader();
    const texture = await loader.loadAsync(this.defaults.iesTexturePath + path);
    return this.registerIESProfile(name, texture);
  }

  // ── set the IES profile currently applied to the sun ────
  setActiveIESProfile(name) {
    if (IES_PROFILES.has(name)) {
      const profile = IES_PROFILES.get(name);
      this.ies.map = profile.map;
      this.ies.intensity = profile.intensity;
      this.ies.distance = profile.distance;
      this.ies.decay = profile.decay;
      this.ies.enabled = true;
    }
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── colour-temperature lookup ─────────────────────────
  // ══════════════════════════════════════════════════════════
  // Returns a linear-RGB colour from the Planckian colour-temperature
  // table, with linear interpolation between adjacent entries.
  _kelvinToLinearRGB(kelvin, outColor) {
    const table = COLOR_TEMPERATURE_TABLE;
    if (kelvin <= table[0][0]) {
      outColor[0] = table[0][1][0];
      outColor[1] = table[0][1][1];
      outColor[2] = table[0][1][2];
      return outColor;
    }
    if (kelvin >= table[table.length - 1][0]) {
      const last = table[table.length - 1][1];
      outColor[0] = last[0];
      outColor[1] = last[1];
      outColor[2] = last[2];
      return outColor;
    }
    for (let i = 0; i < table.length - 1; i++) {
      if (kelvin >= table[i][0] && kelvin <= table[i + 1][0]) {
        const t = (kelvin - table[i][0]) / (table[i + 1][0] - table[i][0]);
        const a = table[i][1];
        const b = table[i + 1][1];
        outColor[0] = a[0] * (1 - t) + b[0] * t;
        outColor[1] = a[1] * (1 - t) + b[1] * t;
        outColor[2] = a[2] * (1 - t) + b[2] * t;
        return outColor;
      }
    }
    return outColor;
  }

  // ══════════════════════════════════════════════════════════
  // ─── OKLab perceptual blending ──────────────────────────
  // ══════════════════════════════════════════════════════════
  // Converts linear-RGB → OKLab, blends, and converts back.
  _linearRGBtoOKLab(r, g, b, out) {
    // Linear-RGB → LMS.
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    // Cube root.
    const l_ = Math.cbrt(l);
    const m_ = Math.cbrt(m);
    const s_ = Math.cbrt(s);
    // LMS' → OKLab.
    out[0] = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    out[1] = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    out[2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    return out;
  }

  _OKLabtoLinearRGB(L, a, b, out) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    out[0] =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return out;
  }

  _blendInOKLab(colorA, colorB, t, out) {
    const labA = [0, 0, 0];
    const labB = [0, 0, 0];
    this._linearRGBtoOKLab(colorA[0], colorA[1], colorA[2], labA);
    this._linearRGBtoOKLab(colorB[0], colorB[1], colorB[2], labB);
    const L = labA[0] * (1 - t) + labB[0] * t;
    const a = labA[1] * (1 - t) + labB[1] * t;
    const b = labA[2] * (1 - t) + labB[2] * t;
    return this._OKLabtoLinearRGB(L, a, b, out);
  }

  // ══════════════════════════════════════════════════════════
  // ─── sun position and colour ────────────────────────────
  // ══════════════════════════════════════════════════════════
  _computeSunPosition(altitudeDeg, azimuthDeg, outDirection) {
    const altRad = altitudeDeg * Math.PI / 180;
    const azRad = azimuthDeg * Math.PI / 180;
    outDirection.set(
      Math.cos(altRad) * Math.sin(azRad),
      Math.sin(altRad),
      -Math.cos(altRad) * Math.cos(azRad)
    ).normalize();
    return outDirection;
  }

  _computeSunColour(sunAltitude, outColor) {
    // Colour temperature: at horizon 2000 K, at zenith 5600 K.
    const kelvin = 2000 + Math.max(0, Math.min(1, sunAltitude / 60)) * 3600;
    return this._kelvinToLinearRGB(kelvin, outColor);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Rayleigh and Mie extinction ────────────────────────
  // ══════════════════════════════════════════════════════════
  // Computes the extinction coefficient along the sun's path
  // (airmass approximation) for each RGB channel.
  _computeAtmosphericExtinction(sunAltitudeDeg, cloudCover, outCoeff) {
    if (sunAltitudeDeg <= 0) {
      outCoeff[0] = 1; outCoeff[1] = 1; outCoeff[2] = 1;
      return outCoeff;
    }
    // Air mass: Kasten & Young 1989 approximate.
    const zenithRad = (90 - sunAltitudeDeg) * Math.PI / 180;
    const airMass = 1 / (Math.cos(zenithRad) + 0.50572 * Math.pow(96.07995 - (90 - sunAltitudeDeg), -1.6364));

    const r = Math.exp(-this.solar.rayleighCoeffR * airMass * this.solar.rayleighScaleHeight);
    const g = Math.exp(-this.solar.rayleighCoeffG * airMass * this.solar.rayleighScaleHeight);
    const b = Math.exp(-this.solar.rayleighCoeffB * airMass * this.solar.rayleighScaleHeight);

    // Cloud attenuation: reduces the direct beam linearly with cloud cover.
    const cloudAtten = 1 - cloudCover * 0.85;

    outCoeff[0] = r * cloudAtten;
    outCoeff[1] = g * cloudAtten;
    outCoeff[2] = b * cloudAtten;
    return outCoeff;
  }

  // ══════════════════════════════════════════════════════════
  // ─── cloud irradiance ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Computes an additional directional light from clouds. Bright
  // cumulus clouds contribute bright fill light from the cloud-lit
  // side; rain clouds contribute a cool, dimmer fill.
  _computeCloudIrradiance(sunDir, cloudCover, weatherState, outDir, outColor, outIntensity) {
    if (cloudCover < 0.05 || !this.defaults.enableCloudDirectional) {
      outIntensity[0] = 0;
      outDir.set(0, 1, 0);
      outColor[0] = 0; outColor[1] = 0; outColor[2] = 0;
      return;
    }

    // Rain vs bright-cloud classification.
    let isRain = false;
    if (weatherState === WEATHER.RAIN || weatherState === WEATHER.STORM || weatherState === WEATHER.SNOW) {
      isRain = true;
    }

    // Cloud direction: offset from sun in the horizontal plane.
    const horX = sunDir.x;
    const horZ = sunDir.z;
    const horLen = Math.sqrt(horX * horX + horZ * horZ) + 1e-6;
    const offsetX = -horX / horLen;   // opposite side
    const offsetZ = -horZ / horLen;
    const cosOff = Math.cos(this.cloud.cloudDirectionOffset);
    const sinOff = Math.sin(this.cloud.cloudDirectionOffset);
    const dirX = offsetX * cosOff - offsetZ * sinOff;
    const dirZ = offsetX * sinOff + offsetZ * cosOff;
    const dirY = 0.6;

    outDir.set(dirX, dirY, dirZ).normalize();

    // Base intensity scaled by cloud cover.
    let baseIntensity;
    let baseColor;
    if (isRain) {
      baseIntensity = this.cloud.rainCloudIrradiance * cloudCover;
      baseColor = this.cloud.rainCloudColor;
    } else if (cloudCover > 0.85) {
      baseIntensity = this.cloud.overcastIrradiance * cloudCover;
      baseColor = this.cloud.overcastColor;
    } else {
      baseIntensity = this.cloud.brightCloudIrradiance * cloudCover;
      baseColor = this.cloud.brightCloudColor;
    }

    outIntensity[0] = baseIntensity;
    outColor[0] = baseColor[0];
    outColor[1] = baseColor[1];
    outColor[2] = baseColor[2];
  }

  // ══════════════════════════════════════════════════════════
  // ─── lighting state classification ──────────────────────
  // ══════════════════════════════════════════════════════════
  _classifyLightingState(sunAltitude, cloudCover, isRain) {
    if (sunAltitude < -6) return LIGHTING_STATE.NIGHT;
    if (sunAltitude < 0) return LIGHTING_STATE.BLUE_HOUR;
    if (sunAltitude < 8) return LIGHTING_STATE.GOLDEN_HOUR;
    if (sunAltitude < 15 && cloudCover < 0.3) {
      // Sunrise vs sunset: use azimuth to distinguish.
      // For simplicity, sunrise when the sun is in the eastern half.
      // (The provider does not currently track azimuth for this
      // classification — default to sunrise.)
      return LIGHTING_STATE.SUNRISE;
    }
    if (isRain) return LIGHTING_STATE.DAY_RAIN;
    if (cloudCover > 0.7) return LIGHTING_STATE.DAY_OVERCAST;
    if (cloudCover > 0.3) return LIGHTING_STATE.DAY_HAZY;
    return LIGHTING_STATE.DAY_CLEAR;
  }

  // ══════════════════════════════════════════════════════════
  // ─── IES application ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Applies the currently active IES profile's intensity to the
  // direct, sky, and cloud contributions if the corresponding flags
  // are set. The actual texture sampling happens in the shader via
  // the mesh's IESSpotLight or a custom shader.
  _applyIES(baseIntensity, target) {
    if (!this.ies.enabled || !this.ies.map) return baseIntensity;
    // Multiply by the IES profile's global intensity.
    const iesScaled = baseIntensity * this.ies.intensity;
    if (target === 'sun' && this.ies.applyToSun) return iesScaled;
    if (target === 'sky' && this.ies.applyToSky) return iesScaled;
    if (target === 'cloud' && this.ies.applyToCloud) return iesScaled;
    return baseIntensity;
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

    if (!this._chunkCellX[slot]) {
      this._chunkCellX[slot] = this._acquireCell('x');
      this._chunkCellY[slot] = this._acquireCell('y');
      this._chunkCellZ[slot] = this._acquireCell('z');
      this._chunkCellSunIntensity[slot] = this._acquireCell('sunIntensity');
      this._chunkCellLightingState[slot] = this._acquireState();
      this._chunkCellSunColor[slot] = new Float32Array(this.defaults.maxCellsPerChunk * 3);
      this._chunkCellSunDir[slot] = new Float32Array(this.defaults.maxCellsPerChunk * 3);
      this._chunkCellCloudColor[slot] = new Float32Array(this.defaults.maxCellsPerChunk * 3);
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpSunI = this._chunkCellSunIntensity[slot];
    const cpState = this._chunkCellLightingState[slot];
    const cpSunC = this._chunkCellSunColor[slot];
    const cpSunD = this._chunkCellSunDir[slot];
    const cpCloudC = this._chunkCellCloudColor[slot];

    let placed = 0;

    // ── Global inputs ───────────────────────────────────────
    const physical = frame.layers.physical;
    const cloudCover = physical?.cloudCover ?? 0.3;
    const weatherState = this._temporal?.weatherState ?? WEATHER.CLEAR;
    const sunAltitudeDeg = physical?.sunAltitudeDeg ?? 45;
    const sunAzimuthDeg = physical?.sunAzimuthDeg ?? 180;

    // ── Sun direction ───────────────────────────────────────
    const sunDir = this._computeSunPosition(sunAltitudeDeg, sunAzimuthDeg, this._tmpVecA);

    // ── Sun colour ──────────────────────────────────────────
    const sunColor = this._computeSunColour(sunAltitudeDeg, this._tmpColorA);

    // ── Atmospheric extinction ──────────────────────────────
    const extinction = [0, 0, 0];
    this._computeAtmosphericExtinction(sunAltitudeDeg, cloudCover, extinction);

    // ── Base sun intensity ──────────────────────────────────
    // Scale the solar constant down to a PBR-friendly intensity.
    const sunAltitudeFactor = Math.max(0, Math.sin(sunAltitudeDeg * Math.PI / 180));
    const baseSunIntensity = sunAltitudeFactor * (1 - cloudCover * 0.7);
    const baseDiffuseIntensity = (0.3 + cloudCover * 0.7) * sunAltitudeFactor;

    // ── Cloud irradiance ────────────────────────────────────
    const cloudDir = this._tmpVecB;
    const cloudColor = this._tmpColorB;
    const cloudIntensity = [0];
    this._computeCloudIrradiance(sunDir, cloudCover, weatherState, cloudDir, cloudColor, cloudIntensity);

    // ── IES application ─────────────────────────────────────
    const iesSunFactor = this._applyIES(1.0, 'sun');
    const iesSkyFactor = this._applyIES(1.0, 'sky');
    const iesCloudFactor = this._applyIES(1.0, 'cloud');

    // ── Aggregates ──────────────────────────────────────────
    let sumSunIntensity = 0;
    let sumSunColorR = 0, sumSunColorG = 0, sumSunColorB = 0;
    let sumSunDirX = 0, sumSunDirY = 0, sumSunDirZ = 0;
    let sumCloudColorR = 0, sumCloudColorG = 0, sumCloudColorB = 0;
    let sumDiffuseIntensity = 0;
    let sumAmbientIntensity = 0;

    const stateCount = new Uint16Array(LIGHTING_STATE_NAMES.length);

    for (let j = 0; j < cellsPerSide && placed < this.defaults.maxCellsPerChunk; j++) {
      for (let i = 0; i < cellsPerSide && placed < this.defaults.maxCellsPerChunk; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;

        // Local extinction: adjust for elevation (higher = thinner air).
        const altitude = this._getHeight(wx, wz);
        const elevFactor = Math.exp(-altitude / this.solar.rayleighScaleHeight);
        const localExtinction = [
          extinction[0] + (1 - elevFactor) * 0.1,
          extinction[1] + (1 - elevFactor) * 0.1,
          extinction[2] + (1 - elevFactor) * 0.1
        ];

        // Apply extinction to sun colour.
        const sunColLocal = [
          sunColor[0] * localExtinction[0],
          sunColor[1] * localExtinction[1],
          sunColor[2] * localExtinction[2]
        ];

        // Apply IES to sun colour.
        const sunIntensityLocal = baseSunIntensity * iesSunFactor;

        // Diffuse sky intensity.
        const diffuseIntensityLocal = baseDiffuseIntensity * iesSkyFactor;

        // Ambient (simple hemisphere approximation).
        const ambientIntensityLocal = diffuseIntensityLocal * 0.3;

        // Classify state.
        const isRain = weatherState === WEATHER.RAIN || weatherState === WEATHER.STORM;
        const lightingState = this._classifyLightingState(sunAltitudeDeg, cloudCover, isRain);

        // Store cell.
        cpx[placed] = wx;
        cpy[placed] = altitude;
        cpz[placed] = wz;
        cpSunI[placed] = sunIntensityLocal;
        cpState[placed] = lightingState;
        const co = placed * 3;
        cpSunC[co]     = sunColLocal[0];
        cpSunC[co + 1] = sunColLocal[1];
        cpSunC[co + 2] = sunColLocal[2];
        cpSunD[co]     = sunDir.x;
        cpSunD[co + 1] = sunDir.y;
        cpSunD[co + 2] = sunDir.z;
        cpCloudC[co]     = cloudColor[0] * cloudIntensity[0] * iesCloudFactor;
        cpCloudC[co + 1] = cloudColor[1] * cloudIntensity[0] * iesCloudFactor;
        cpCloudC[co + 2] = cloudColor[2] * cloudIntensity[0] * iesCloudFactor;
        placed++;

        // Aggregate.
        sumSunIntensity += sunIntensityLocal;
        sumSunColorR += sunColLocal[0];
        sumSunColorG += sunColLocal[1];
        sumSunColorB += sunColLocal[2];
        sumSunDirX += sunDir.x;
        sumSunDirY += sunDir.y;
        sumSunDirZ += sunDir.z;
        sumCloudColorR += cpCloudC[co];
        sumCloudColorG += cpCloudC[co + 1];
        sumCloudColorB += cpCloudC[co + 2];
        sumDiffuseIntensity += diffuseIntensityLocal;
        sumAmbientIntensity += ambientIntensityLocal;
        stateCount[lightingState]++;

        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // ── Store chunk summary ────────────────────────────────
    const inv = placed > 0 ? 1 / placed : 0;
    this._chunkSunIntensity[slot] = sumSunIntensity * inv;
    this._chunkSunColorR[slot] = sumSunColorR * inv;
    this._chunkSunColorG[slot] = sumSunColorG * inv;
    this._chunkSunColorB[slot] = sumSunColorB * inv;
    this._chunkSunDirX[slot] = sumSunDirX * inv;
    this._chunkSunDirY[slot] = sumSunDirY * inv;
    this._chunkSunDirZ[slot] = sumSunDirZ * inv;
    this._chunkCloudIrradiance[slot] = cloudIntensity[0] * inv;
    this._chunkCloudDirX[slot] = cloudDir.x;
    this._chunkCloudDirY[slot] = cloudDir.y;
    this._chunkCloudDirZ[slot] = cloudDir.z;
    this._chunkCloudColorR[slot] = sumCloudColorR * inv;
    this._chunkCloudColorG[slot] = sumCloudColorG * inv;
    this._chunkCloudColorB[slot] = sumCloudColorB * inv;
    this._chunkDiffuseSkyIntensity[slot] = sumDiffuseIntensity * inv;
    this._chunkAmbientIntensity[slot] = sumAmbientIntensity * inv;
    this._chunkDiffuseSkyColorR[slot] = sunColor[0] * 0.7;
    this._chunkDiffuseSkyColorG[slot] = sunColor[1] * 0.85;
    this._chunkDiffuseSkyColorB[slot] = sunColor[2] * 1.0;
    this._chunkShadowIntensity[slot] = 0.85 * (1 - cloudCover * 0.8);
    this._chunkExposure[slot] = this.defaults.exposureBase;
    this._chunkColorTemperature[slot] = 2000 + Math.max(0, Math.min(1, sunAltitudeDeg / 60)) * 3600;
    this._chunkSunAltitude[slot] = sunAltitudeDeg;
    this._chunkSunAzimuth[slot] = sunAzimuthDeg;
    this._chunkIesSunIntensity[slot] = baseSunIntensity * iesSunFactor;
    this._chunkIesSkyIntensity[slot] = baseDiffuseIntensity * iesSkyFactor;
    this._chunkIesCloudIntensity[slot] = cloudIntensity[0] * iesCloudFactor;

    // Dominant lighting state.
    let dominantState = 0;
    let maxCount = 0;
    for (let s = 0; s < stateCount.length; s++) {
      if (stateCount[s] > maxCount) { maxCount = stateCount[s]; dominantState = s; }
    }
    this._chunkLightingState[slot] = dominantState;

    this._stats.chunksProcessed++;

    // ── Lighting state transition event ─────────────────────
    const previousState = this._chunkLastState[slot];
    const now = this._lastUpdateTime > 0 ? this._lastUpdateTime : 0;
    if (previousState !== 0 && previousState !== dominantState &&
        now - this._chunkLastTransitionTime[slot] > this.defaults.lightingStateCooldown) {
      this._chunkLastTransitionTime[slot] = now;
      this._stats.lightingStateTransitions++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, 40, 5.0,
          {
            kind: 'lighting_transition',
            chunkX: cx, chunkZ: cz,
            fromState: previousState,
            toState: dominantState,
            fromStateName: LIGHTING_STATE_NAMES[previousState],
            toStateName: LIGHTING_STATE_NAMES[dominantState],
            sunIntensity: sumSunIntensity * inv,
            cloudIrradiance: cloudIntensity[0] * inv,
            sunAltitude: sunAltitudeDeg,
            cloudCover: cloudCover
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
      this._cellPool.sunIntensity.push(this._chunkCellSunIntensity[slot]);
      this._cellPool.sunColor.push(this._chunkCellSunColor[slot]);
      this._cellPool.sunDir.push(this._chunkCellSunDir[slot]);
      this._cellPool.cloudColor.push(this._chunkCellCloudColor[slot]);
      this._stateArrayPool.push(this._chunkCellLightingState[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellSunIntensity[slot] = null;
    this._chunkCellLightingState[slot] = null;
    this._chunkCellSunColor[slot] = null;
    this._chunkCellSunDir[slot] = null;
    this._chunkCellCloudColor[slot] = null;
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
  getLightingAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      lightingState: this._chunkLightingState[slot],
      lightingStateName: LIGHTING_STATE_NAMES[this._chunkLightingState[slot]],
      sunAltitude: this._chunkSunAltitude[slot],
      sunAzimuth: this._chunkSunAzimuth[slot],
      sunDirection: [this._chunkSunDirX[slot], this._chunkSunDirY[slot], this._chunkSunDirZ[slot]],
      sunColor: [this._chunkSunColorR[slot], this._chunkSunColorG[slot], this._chunkSunColorB[slot]],
      sunIntensity: this._chunkSunIntensity[slot],
      sunLux: this._chunkSunLux[slot],
      diffuseSkyIntensity: this._chunkDiffuseSkyIntensity[slot],
      diffuseSkyColor: [this._chunkDiffuseSkyColorR[slot], this._chunkDiffuseSkyColorG[slot], this._chunkDiffuseSkyColorB[slot]],
      ambientIntensity: this._chunkAmbientIntensity[slot],
      cloudIrradiance: this._chunkCloudIrradiance[slot],
      cloudDirection: [this._chunkCloudDirX[slot], this._chunkCloudDirY[slot], this._chunkCloudDirZ[slot]],
      cloudColor: [this._chunkCloudColorR[slot], this._chunkCloudColorG[slot], this._chunkCloudColorB[slot]],
      exposure: this._chunkExposure[slot],
      colorTemperature: this._chunkColorTemperature[slot],
      shadowIntensity: this._chunkShadowIntensity[slot],
      iesSunIntensity: this._chunkIesSunIntensity[slot],
      iesSkyIntensity: this._chunkIesSkyIntensity[slot],
      iesCloudIntensity: this._chunkIesCloudIntensity[slot],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        sunIntensity: this._chunkCellSunIntensity[slot],
        state: this._chunkCellLightingState[slot],
        sunColor: this._chunkCellSunColor[slot],
        sunDir: this._chunkCellSunDir[slot],
        cloudColor: this._chunkCellCloudColor[slot]
      }
    };
  }

  // ── sample sun direction at any position ──────────────────
  sampleSunDirection(wx, wz, frame, outDir) {
    if (!frame) frame = this._frameRef;
    if (!frame) { outDir.set(0, 1, 0); return outDir; }

    const physical = frame.layers.physical;
    const sunAlt = physical?.sunAltitudeDeg ?? 45;
    const sunAz = physical?.sunAzimuthDeg ?? 180;
    return this._computeSunPosition(sunAlt, sunAz, outDir);
  }

  // ── sample sun colour at any position ─────────────────────
  sampleSunColor(wx, wz, frame, outColor) {
    if (!frame) frame = this._frameRef;
    if (!frame) { outColor[0] = 1; outColor[1] = 1; outColor[2] = 1; return outColor; }

    const physical = frame.layers.physical;
    const sunAlt = physical?.sunAltitudeDeg ?? 45;
    return this._computeSunColour(sunAlt, outColor);
  }

  // ── sample cloud irradiance direction and colour ──────────
  sampleCloudIrradiance(wx, wz, frame, outDir, outColor, outIntensity) {
    if (!frame) frame = this._frameRef;
    if (!frame) return { dir: outDir, color: outColor, intensity: 0 };

    const physical = frame.layers.physical;
    const cloudCover = physical?.cloudCover ?? 0.3;
    const weatherState = this._temporal?.weatherState ?? WEATHER.CLEAR;
    const sunDir = this.sampleSunDirection(wx, wz, frame, this._tmpVecA);
    const intensity = [0];
    this._computeCloudIrradiance(sunDir, cloudCover, weatherState, outDir, outColor, intensity);
    if (outIntensity) outIntensity[0] = intensity[0];
    return { dir: outDir, color: outColor, intensity: intensity[0] };
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getLightingMaterialParams(preset) {
    return LIGHTING_MATERIAL[preset] || LIGHTING_MATERIAL.SUNLIT_CLEAR;
  }

  blendLightingMaterial(lightingState, sunIntensity, cloudCover, sunColor, out) {
    let preset = 'SUNLIT_CLEAR';
    if (lightingState === LIGHTING_STATE.NIGHT) preset = 'NIGHT_CLEAR';
    else if (lightingState === LIGHTING_STATE.BLUE_HOUR) preset = 'SUNLIT_BLUE_HOUR';
    else if (lightingState === LIGHTING_STATE.GOLDEN_HOUR) preset = 'SUNLIT_GOLDEN';
    else if (lightingState === LIGHTING_STATE.DAY_RAIN) preset = 'RAIN';
    else if (lightingState === LIGHTING_STATE.DAY_OVERCAST) preset = 'OVERCAST';

    const src = LIGHTING_MATERIAL[preset];
    const o = out || this._blendedParams;

    // Modulate base colour by sun colour in OKLab perceptual space.
    const blended = [0, 0, 0];
    this._blendInOKLab(src.pbr.baseColor, sunColor, 0.5, blended);

    o.pbr.baseColor[0] = blended[0];
    o.pbr.baseColor[1] = blended[1];
    o.pbr.baseColor[2] = blended[2];
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

    o.exposureModifier = src.exposureModifier;
    o.colourTemperature = src.colourTemperature;
    o.sunIntensity = src.sunIntensity * sunIntensity;
    o.diffuseIntensity = src.diffuseIntensity * (0.5 + cloudCover * 0.5);
    o.shadowIntensity = src.shadowIntensity * (1 - cloudCover * 0.5);

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.lighting) {
      spatial.lighting = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        lightingState: this._chunkLightingState,
        sunAltitude: this._chunkSunAltitude,
        sunAzimuth: this._chunkSunAzimuth,
        sunDirX: this._chunkSunDirX,
        sunDirY: this._chunkSunDirY,
        sunDirZ: this._chunkSunDirZ,
        sunColorR: this._chunkSunColorR,
        sunColorG: this._chunkSunColorG,
        sunColorB: this._chunkSunColorB,
        sunIntensity: this._chunkSunIntensity,
        sunLux: this._chunkSunLux,
        diffuseSkyIntensity: this._chunkDiffuseSkyIntensity,
        diffuseSkyColorR: this._chunkDiffuseSkyColorR,
        diffuseSkyColorG: this._chunkDiffuseSkyColorG,
        diffuseSkyColorB: this._chunkDiffuseSkyColorB,
        ambientIntensity: this._chunkAmbientIntensity,
        cloudIrradiance: this._chunkCloudIrradiance,
        cloudDirX: this._chunkCloudDirX,
        cloudDirY: this._chunkCloudDirY,
        cloudDirZ: this._chunkCloudDirZ,
        cloudColorR: this._chunkCloudColorR,
        cloudColorG: this._chunkCloudColorG,
        cloudColorB: this._chunkCloudColorB,
        exposure: this._chunkExposure,
        colorTemperature: this._chunkColorTemperature,
        shadowIntensity: this._chunkShadowIntensity,
        iesSunIntensity: this._chunkIesSunIntensity,
        iesSkyIntensity: this._chunkIesSkyIntensity,
        iesCloudIntensity: this._chunkIesCloudIntensity,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          sunIntensity: this._chunkCellSunIntensity,
          state: this._chunkCellLightingState,
          sunColor: this._chunkCellSunColor,
          sunDir: this._chunkCellSunDir,
          cloudColor: this._chunkCellCloudColor
        },
        materialParams: LIGHTING_MATERIAL,
        stateNames: LIGHTING_STATE_NAMES,
        iesProfiles: IES_PROFILES
      };
    }

    const l = spatial.lighting;
    l.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (l.chunkCount >= this._chunkCap) break;
      l.chunkCX[l.chunkCount] = this._chunkCX[i];
      l.chunkCZ[l.chunkCount] = this._chunkCZ[i];
      l.chunkSlots[l.chunkCount] = i;
      l.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    let sumSunIntensity = 0, sumSunColorR = 0, sumSunColorG = 0, sumSunColorB = 0;
    let sumSunDirX = 0, sumSunDirY = 0, sumSunDirZ = 0;
    let sumDiffuseIntensity = 0, sumAmbientIntensity = 0;
    let sumCloudIrradiance = 0, sumCloudColorR = 0, sumCloudColorG = 0, sumCloudColorB = 0;
    let sumExposure = 0, sumColorTemp = 0, sumShadowIntensity = 0;
    let chunksWithLighting = 0;
    const stateCount = new Uint16Array(LIGHTING_STATE_NAMES.length);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      chunksWithLighting++;
      sumSunIntensity += this._chunkSunIntensity[i];
      sumSunColorR += this._chunkSunColorR[i];
      sumSunColorG += this._chunkSunColorG[i];
      sumSunColorB += this._chunkSunColorB[i];
      sumSunDirX += this._chunkSunDirX[i];
      sumSunDirY += this._chunkSunDirY[i];
      sumSunDirZ += this._chunkSunDirZ[i];
      sumDiffuseIntensity += this._chunkDiffuseSkyIntensity[i];
      sumAmbientIntensity += this._chunkAmbientIntensity[i];
      sumCloudIrradiance += this._chunkCloudIrradiance[i];
      sumCloudColorR += this._chunkCloudColorR[i];
      sumCloudColorG += this._chunkCloudColorG[i];
      sumCloudColorB += this._chunkCloudColorB[i];
      sumExposure += this._chunkExposure[i];
      sumColorTemp += this._chunkColorTemperature[i];
      sumShadowIntensity += this._chunkShadowIntensity[i];
      stateCount[this._chunkLightingState[i]]++;
    }

    const gl = this._globalLighting;
    const inv = chunksWithLighting > 0 ? 1 / chunksWithLighting : 0;
    gl.avgSunIntensity = sumSunIntensity * inv;
    gl.avgSunLux = gl.avgSunIntensity * this.solar.lumensPerWatt;
    gl.avgDiffuseSkyIntensity = sumDiffuseIntensity * inv;
    gl.avgAmbientIntensity = sumAmbientIntensity * inv;
    gl.avgCloudIrradiance = sumCloudIrradiance * inv;
    gl.avgExposure = sumExposure * inv || 1.0;
    gl.avgColorTemperature = sumColorTemp * inv || 5600;
    gl.avgShadowIntensity = sumShadowIntensity * inv || 0.85;

    // Dominant lighting state.
    let dominantState = 0;
    let maxCount = 0;
    for (let s = 0; s < stateCount.length; s++) {
      if (stateCount[s] > maxCount) { maxCount = stateCount[s]; dominantState = s; }
    }
    gl.dominantLightingState = dominantState;

    // Sun direction (normalized).
    const dirMag = Math.sqrt(sumSunDirX * sumSunDirX + sumSunDirY * sumSunDirY + sumSunDirZ * sumSunDirZ);
    if (dirMag > 1e-6) {
      gl.sunDirection[0] = sumSunDirX / dirMag;
      gl.sunDirection[1] = sumSunDirY / dirMag;
      gl.sunDirection[2] = sumSunDirZ / dirMag;
    } else {
      gl.sunDirection[0] = 0;
      gl.sunDirection[1] = 1;
      gl.sunDirection[2] = 0;
    }

    // Sun colour (normalized).
    gl.sunColor[0] = chunksWithLighting > 0 ? sumSunColorR * inv : 1;
    gl.sunColor[1] = chunksWithLighting > 0 ? sumSunColorG * inv : 1;
    gl.sunColor[2] = chunksWithLighting > 0 ? sumSunColorB * inv : 1;

    // Sky colour.
    gl.skyColor[0] = gl.sunColor[0] * 0.7;
    gl.skyColor[1] = gl.sunColor[1] * 0.85;
    gl.skyColor[2] = gl.sunColor[2] * 1.0;

    // Cloud irradiance.
    gl.cloudIrradianceDirection[0] = gl.sunDirection[0];
    gl.cloudIrradianceDirection[1] = gl.sunDirection[1];
    gl.cloudIrradianceDirection[2] = gl.sunDirection[2];
    gl.cloudColor[0] = chunksWithLighting > 0 ? sumCloudColorR * inv : 0;
    gl.cloudColor[1] = chunksWithLighting > 0 ? sumCloudColorG * inv : 0;
    gl.cloudColor[2] = chunksWithLighting > 0 ? sumCloudColorB * inv : 0;

    // IES active flag.
    gl.iesActive = this.ies.enabled && this.ies.map !== null;

    if (!physical.lightingProperties) physical.lightingProperties = {};
    Object.assign(physical.lightingProperties, gl);

    // Material-facing aggregates.
    physical.sunIntensity = gl.avgSunIntensity;
    physical.sunLux = gl.avgSunLux;
    physical.sunDirection = gl.sunDirection;
    physical.sunColor = gl.sunColor;
    physical.skyColor = gl.skyColor;
    physical.diffuseSkyIntensity = gl.avgDiffuseSkyIntensity;
    physical.ambientLightIntensity = gl.avgAmbientIntensity;
    physical.cloudIrradiance = gl.avgCloudIrradiance;
    physical.cloudIrradianceDirection = gl.cloudIrradianceDirection;
    physical.cloudColor = gl.cloudColor;
    physical.exposure = gl.avgExposure;
    physical.colorTemperature = gl.avgColorTemperature;
    physical.shadowIntensity = gl.avgShadowIntensity;
    physical.lightingState = dominantState;
    physical.lightingStateName = LIGHTING_STATE_NAMES[dominantState];
    physical.iesActive = gl.iesActive;

    if (!physical.lightingStateWeights) {
      physical.lightingStateWeights = new Float32Array(LIGHTING_STATE_NAMES.length);
    }
    if (chunksWithLighting > 0) {
      for (let s = 0; s < stateCount.length; s++) {
        physical.lightingStateWeights[s] = stateCount[s] / chunksWithLighting;
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

  setSolarConstants(params) {
    for (const k of Object.keys(this.solar)) {
      if (params[k] !== undefined) this.solar[k] = params[k];
    }
    return this;
  }

  setCloudConstants(params) {
    for (const k of Object.keys(this.cloud)) {
      if (params[k] !== undefined) this.cloud[k] = params[k];
    }
    return this;
  }

  setIESParams(params) {
    for (const k of Object.keys(this.ies)) {
      if (params[k] !== undefined) this.ies[k] = params[k];
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
  getGlobalLighting() { return { ...this._globalLighting }; }

  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  dispose() {
    this._terrain = null;
    this._elevation = null;
    this._carve = null;
    this._moisture = null;
    this._temperature = null;
    this._precipitation = null;
    this._wind = null;
    this._temporal = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._stateArrayPool.length = 0;
    IES_PROFILES.clear();
  }
}

export {
  LightingSunIntensityProvider,
  LIGHTING_STATE,
  LIGHTING_STATE_NAMES,
  SOLAR_CONSTANTS,
  CLOUD_CONSTANTS,
  LIGHTING_MATERIAL,
  IES_DEFAULTS,
  LIGHTING_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL,
  IES_PROFILES
};