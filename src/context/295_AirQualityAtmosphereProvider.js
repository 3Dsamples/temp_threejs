// file number : 295
// full path name : src/context/295_AirQualityAtmosphereProvider.js
// description : Air quality and atmospheric composition provider — clarity, haze, pollution, salt spray, volcanic ash, dust, and smoke — that all atmospheric shaders, materials, and lighting read to produce realistic sunsets, blue-sky variations, smoky forests, volcanic hazes, and coastal atmospheres. Fuses seven sources into one coherent air-quality field per chunk: (1) natural Rayleigh scattering from air molecules at altitude, temperature, and pressure; (2) humidity-driven Mie scattering (water-droplet aerosols) from 285_MoistureLevelProvider; (3) pollution (SO₂, NOₓ, PM₂.₅, PM₁₀) from nearby fire sources, volcanic vents, urban centres, and industrial zones; (4) salt spray from coastal and marine regions (spatial decay from water bodies); (5) volcanic ash plumes from active eruptions tracked through 282_Z04_NaturalFormationGradientProvider's thermal vents and 278_CausalContextProvider's IGNITE/IMPACT causal events; (6) dust and sand particles from arid regions during high-wind events (from 289_ClimateWindProvider); (7) smoke from forest fires and 316_EcologyResponseSystem's ignition events. Computes the effective Rayleigh and Mie coefficients (β_R, β_M), Henyey-Greenstein phase function asymmetry (g), Aerosol Optical Depth (AOD at 550 nm), Angstrom exponent α (0.5 for smoke → 2.0 for marine aerosol), Angstrom turbidity β, single-scattering albedo ω₀, and visibility distance (via the Koschmieder formula V = 3.912 / β_ext). Provides full IES-light-compatible intensity and colour parameters so atmospheric shaders can apply IES profiles to the sky-glow and to any haze emitters. Provides full PBR + anime material parameter sets for 10 air-quality presets — CLEAN_ALPINE, TROPICAL_CLEAR, TEMPERATE_HAZE, DESERT_DUSTY, COASTAL_SALTY, URBAN_SMOG, WILDFIRE_SMOKE, VOLCANIC_ASH, FOG_LADEN, POST_ERUPTION — each with base colour, extinction, tint, rim colour, and anime flatness that the atmosphere shader blends per-pixel. Emits a single coalesced AUDIO_LIGHT causal event when air quality crosses a threshold (clean → hazy, hazy → smoky, smoky → severe). Writes per-chunk summaries into frame.layers.spatial.airQuality and global aggregates into frame.layers.physical.airQualityProperties. All scratch objects are pooled; no allocation after the first frame.
// best for : Every consumer that needs atmospheric clarity state — the sky shader (Rayleigh/Mie coefficients), the atmosphere/fog shader (AOD, extinction), materials (tint, extinction), 293_LightingSunIntensityProvider (sun disk softening, reddening), 294_LightingTimeOfDayProvider (sunset colour saturation), sky/cloud shaders (cloud brightness modulated by aerosol), volumetric light beams (scattering albedo, asymmetry), and the camera exposure/tone-mapping system. Complements 287–289 climate providers and 293–294 lighting providers by providing the optical medium all of them shine through.
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
import { CarveGradientProvider, CARVE_SOURCE }              from './282_Z03_CarveGradientProvider.js';
import { NaturalFormationGradientProvider, FORMATION_TYPE } from './282_Z04_NaturalFormationGradientProvider.js';
import { RockGradientProvider, ROCK_CLASS }                 from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE }                from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE }      from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider, CONTINENTAL_TYPE }
                                                            from './282_Z09_ContinentalReliefGradientProvider.js';
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
import { LightingSunIntensityProvider, LIGHTING_STATE, IES_PROFILES }
                                                            from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider, TIME_OF_DAY_STATE }     from './294_LightingTimeOfDayProvider.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 1;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── air-quality presets ────────────────────────────────────────
const AIR_QUALITY_PRESET = Object.freeze({
  CLEAN_ALPINE:     0,
  TROPICAL_CLEAR:   1,
  TEMPERATE_HAZE:   2,
  DESERT_DUSTY:     3,
  COASTAL_SALTY:    4,
  URBAN_SMOG:       5,
  WILDFIRE_SMOKE:   6,
  VOLCANIC_ASH:     7,
  FOG_LADEN:        8,
  POST_ERUPTION:    9
});

const AIR_QUALITY_PRESET_NAMES = Object.freeze([
  'clean_alpine', 'tropical_clear', 'temperate_haze',
  'desert_dusty', 'coastal_salty', 'urban_smog',
  'wildfire_smoke', 'volcanic_ash', 'fog_laden', 'post_eruption'
]);

// ─── Rayleigh/Mie coefficients per preset (m⁻¹) ────────────────
// Beta values scale with atmospheric density and aerosol load.
// Clean air: Rayleigh dominates. Smoky air: Mie dominates.
const AIR_OPTICS = Object.freeze({
  [AIR_QUALITY_PRESET.CLEAN_ALPINE]: {
    betaR:       [5.8e-6, 13.5e-6, 33.1e-6],   // base Rayleigh
    betaM:       [2.0e-7, 2.0e-7, 2.0e-7],     // very low Mie
    mieG:        0.76,                          // forward scatter
    aod550:      0.03,                          // aerosol optical depth
    angstromExp: 1.3,                           // fine-particle exponent
    angstromTurb: 0.05,
    singleScatterAlbedo: 0.98
  },
  [AIR_QUALITY_PRESET.TROPICAL_CLEAR]: {
    betaR:       [5.8e-6, 13.5e-6, 33.1e-6],
    betaM:       [8.0e-7, 8.0e-7, 8.0e-7],
    mieG:        0.78,
    aod550:      0.08,
    angstromExp: 1.5,
    angstromTurb: 0.10,
    singleScatterAlbedo: 0.97
  },
  [AIR_QUALITY_PRESET.TEMPERATE_HAZE]: {
    betaR:       [5.8e-6, 13.5e-6, 33.1e-6],
    betaM:       [3.0e-6, 3.0e-6, 3.0e-6],
    mieG:        0.72,
    aod550:      0.20,
    angstromExp: 1.4,
    angstromTurb: 0.18,
    singleScatterAlbedo: 0.95
  },
  [AIR_QUALITY_PRESET.DESERT_DUSTY]: {
    betaR:       [6.5e-6, 14.5e-6, 34.5e-6],   // slightly higher
    betaM:       [8.0e-6, 7.0e-6, 6.0e-6],     // dust absorbs blue
    mieG:        0.65,
    aod550:      0.45,
    angstromExp: 0.4,                            // coarse particles
    angstromTurb: 0.35,
    singleScatterAlbedo: 0.92
  },
  [AIR_QUALITY_PRESET.COASTAL_SALTY]: {
    betaR:       [5.8e-6, 13.5e-6, 33.1e-6],
    betaM:       [2.5e-6, 2.5e-6, 2.5e-6],     // sea-salt aerosol
    mieG:        0.80,
    aod550:      0.15,
    angstromExp: 1.8,                            // fine marine aerosol
    angstromTurb: 0.12,
    singleScatterAlbedo: 0.99
  },
  [AIR_QUALITY_PRESET.URBAN_SMOG]: {
    betaR:       [6.0e-6, 13.8e-6, 33.5e-6],
    betaM:       [6.0e-6, 5.5e-6, 4.5e-6],     // absorbing aerosol
    mieG:        0.70,
    aod550:      0.40,
    angstromExp: 1.1,
    angstromTurb: 0.30,
    singleScatterAlbedo: 0.90
  },
  [AIR_QUALITY_PRESET.WILDFIRE_SMOKE]: {
    betaR:       [6.0e-6, 13.8e-6, 33.5e-6],
    betaM:       [1.2e-5, 9.0e-6, 7.0e-6],     // smoke absorbs blue
    mieG:        0.60,
    aod550:      1.20,
    angstromExp: 1.6,                            // fine smoke particles
    angstromTurb: 0.55,
    singleScatterAlbedo: 0.88
  },
  [AIR_QUALITY_PRESET.VOLCANIC_ASH]: {
    betaR:       [6.5e-6, 14.5e-6, 34.5e-6],
    betaM:       [1.6e-5, 1.2e-5, 8.0e-6],     // ash is coarse + absorbing
    mieG:        0.55,
    aod550:      2.50,
    angstromExp: 0.3,                            // very coarse particles
    angstromTurb: 0.80,
    singleScatterAlbedo: 0.80
  },
  [AIR_QUALITY_PRESET.FOG_LADEN]: {
    betaR:       [6.0e-6, 13.8e-6, 33.5e-6],
    betaM:       [2.0e-5, 2.0e-5, 2.0e-5],     // large water droplets
    mieG:        0.85,                           // strong forward scatter
    aod550:      3.00,
    angstromExp: 2.2,                            // fine water droplets
    angstromTurb: 0.90,
    singleScatterAlbedo: 1.00                    // fog is purely scattering
  },
  [AIR_QUALITY_PRESET.POST_ERUPTION]: {
    betaR:       [6.0e-6, 13.8e-6, 33.5e-6],
    betaM:       [1.0e-5, 8.0e-6, 6.0e-6],     // lingering sulfate aerosol
    mieG:        0.62,
    aod550:      0.80,
    angstromExp: 1.5,
    angstromTurb: 0.50,
    singleScatterAlbedo: 0.93
  }
});

// ─── full PBR + anime material params per preset ───────────────
const AIR_QUALITY_MATERIAL = Object.freeze({
  [AIR_QUALITY_PRESET.CLEAN_ALPINE]: {
    pbr: {
      baseColor:    [0.55, 0.75, 1.00],
      metalness:    0.00,
      roughness:    1.00,
      clearcoat:    0.00,
      transmission: 1.00,
      ior:          1.00,
      sheen:        0.00,
      anisotropy:   0.00,
      extinction:   [0.05, 0.05, 0.05]
    },
    anime: {
      baseColor:    [0.58, 0.78, 1.00],
      quantizeSteps: 2,
      rimPower:     1.3,
      rimColor:     [0.78, 0.88, 1.00]
    },
    tint:           0.00,
    hazeThickness:  0.10,
    skyGlow:        1.00,
    animeFlatness:  0.20,
    iesSkyFactor:   1.0
  },
  [AIR_QUALITY_PRESET.TROPICAL_CLEAR]: {
    pbr: { baseColor: [0.55, 0.80, 1.00], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 1.00, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [0.06, 0.06, 0.06] },
    anime: { baseColor: [0.58, 0.82, 1.00], quantizeSteps: 2, rimPower: 1.3, rimColor: [0.80, 0.92, 1.00] },
    tint:           0.05,
    hazeThickness:  0.15,
    skyGlow:        1.05,
    animeFlatness:  0.25,
    iesSkyFactor:   1.0
  },
  [AIR_QUALITY_PRESET.TEMPERATE_HAZE]: {
    pbr: { baseColor: [0.75, 0.82, 0.92], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.95, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [0.15, 0.15, 0.15] },
    anime: { baseColor: [0.78, 0.85, 0.95], quantizeSteps: 3, rimPower: 1.5, rimColor: [0.88, 0.92, 1.00] },
    tint:           0.15,
    hazeThickness:  0.35,
    skyGlow:        0.90,
    animeFlatness:  0.35,
    iesSkyFactor:   0.95
  },
  [AIR_QUALITY_PRESET.DESERT_DUSTY]: {
    pbr: { baseColor: [0.90, 0.75, 0.55], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.85, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [0.35, 0.30, 0.25] },
    anime: { baseColor: [0.92, 0.78, 0.58], quantizeSteps: 3, rimPower: 1.6, rimColor: [1.00, 0.88, 0.68] },
    tint:           0.40,
    hazeThickness:  0.55,
    skyGlow:        0.80,
    animeFlatness:  0.40,
    iesSkyFactor:   0.85
  },
  [AIR_QUALITY_PRESET.COASTAL_SALTY]: {
    pbr: { baseColor: [0.62, 0.80, 0.95], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.95, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [0.10, 0.10, 0.10] },
    anime: { baseColor: [0.65, 0.82, 0.98], quantizeSteps: 2, rimPower: 1.4, rimColor: [0.85, 0.95, 1.00] },
    tint:           0.10,
    hazeThickness:  0.25,
    skyGlow:        1.00,
    animeFlatness:  0.25,
    iesSkyFactor:   1.0
  },
  [AIR_QUALITY_PRESET.URBAN_SMOG]: {
    pbr: { baseColor: [0.75, 0.72, 0.65], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.80, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [0.25, 0.22, 0.20] },
    anime: { baseColor: [0.78, 0.75, 0.68], quantizeSteps: 3, rimPower: 1.8, rimColor: [0.88, 0.85, 0.78] },
    tint:           0.35,
    hazeThickness:  0.45,
    skyGlow:        0.75,
    animeFlatness:  0.45,
    iesSkyFactor:   0.80
  },
  [AIR_QUALITY_PRESET.WILDFIRE_SMOKE]: {
    pbr: { baseColor: [0.75, 0.55, 0.30], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.65, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [0.60, 0.50, 0.40] },
    anime: { baseColor: [0.78, 0.58, 0.34], quantizeSteps: 3, rimPower: 2.0, rimColor: [0.95, 0.72, 0.42] },
    tint:           0.65,
    hazeThickness:  0.75,
    skyGlow:        0.55,
    animeFlatness:  0.55,
    iesSkyFactor:   0.65
  },
  [AIR_QUALITY_PRESET.VOLCANIC_ASH]: {
    pbr: { baseColor: [0.55, 0.45, 0.35], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.50, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [0.90, 0.75, 0.60] },
    anime: { baseColor: [0.58, 0.48, 0.38], quantizeSteps: 3, rimPower: 2.2, rimColor: [0.75, 0.60, 0.48] },
    tint:           0.75,
    hazeThickness:  0.90,
    skyGlow:        0.40,
    animeFlatness:  0.65,
    iesSkyFactor:   0.50
  },
  [AIR_QUALITY_PRESET.FOG_LADEN]: {
    pbr: { baseColor: [0.85, 0.88, 0.92], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 1.00, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [1.20, 1.20, 1.20] },
    anime: { baseColor: [0.88, 0.90, 0.94], quantizeSteps: 2, rimPower: 1.2, rimColor: [0.95, 0.97, 1.00] },
    tint:           0.30,
    hazeThickness:  1.00,
    skyGlow:        0.50,
    animeFlatness:  0.30,
    iesSkyFactor:   0.60
  },
  [AIR_QUALITY_PRESET.POST_ERUPTION]: {
    pbr: { baseColor: [0.72, 0.62, 0.52], metalness: 0.00, roughness: 1.00, clearcoat: 0.00, transmission: 0.70, ior: 1.00, sheen: 0.00, anisotropy: 0.00, extinction: [0.45, 0.38, 0.32] },
    anime: { baseColor: [0.75, 0.65, 0.55], quantizeSteps: 3, rimPower: 1.9, rimColor: [0.90, 0.75, 0.62] },
    tint:           0.55,
    hazeThickness:  0.65,
    skyGlow:        0.65,
    animeFlatness:  0.50,
    iesSkyFactor:   0.75
  }
});

// ─── air-quality state codes ───────────────────────────────────
const AIR_QUALITY_STATE = Object.freeze({
  PRISTINE:    0,   // AOD < 0.05
  CLEAR:       1,   // 0.05 – 0.15
  LIGHT_HAZE:  2,   // 0.15 – 0.30
  MODERATE:    3,   // 0.30 – 0.60
  HEAVY:       4,   // 0.60 – 1.20
  SEVERE:      5    // > 1.20
});

const AIR_QUALITY_STATE_NAMES = Object.freeze([
  'pristine', 'clear', 'light_haze', 'moderate', 'heavy', 'severe'
]);

const AIR_QUALITY_THRESHOLDS = Object.freeze([0.05, 0.15, 0.30, 0.60, 1.20]);

// ─── pollution species (per-chunk concentration in µg/m³) ─────
const POLLUTION_SPECIES = Object.freeze({
  SO2:    0,
  NOx:    1,
  PM25:   2,
  PM10:   3,
  O3:     4,
  VOC:    5
});

const POLLUTION_SPECIES_NAMES = Object.freeze([
  'so2', 'nox', 'pm25', 'pm10', 'o3', 'voc'
]);

// ─── atmospheric constants ─────────────────────────────────────
const ATMOSPHERE_CONSTANTS = Object.freeze({
  // Koschmieder coefficient for visibility.
  koschmiederK:          3.912,

  // Altitude scale height for aerosols (m).
  aerosolScaleHeight:    1200.0,

  // Height above which aerosols are sparse.
  aerosolTopHeight:      8000.0,

  // Marine salt-spray decay distance from water (m).
  saltSprayDecay:        15000.0,

  // Urban pollution plume decay (m).
  urbanPlumeDecay:       30000.0,

  // Volcanic plume decay (m).
  volcanicPlumeDecay:    50000.0,

  // Wildfire smoke plume decay (m).
  wildfireSmokeDecay:    40000.0,

  // Precipitation scavenging: mm/hr of rain reduces AOD by this fraction.
  rainScavengeRate:      0.15,

  // Wind disperal factor: high wind reduces local AOD.
  windDispersalRate:     0.02,

  // Threshold for AOD changes triggering causal events.
  aodChangeThreshold:    0.15
});

// ─── air-quality defaults ──────────────────────────────────────
const AIR_QUALITY_DEFAULTS = Object.freeze({
  worldSeed:              0xA1R9UA11D & 0xFFFFFFFF,
  cellSize:               128.0,
  chunkSize:              1000,
  maxCellsPerChunk:       32,
  maxChunksPerFrame:      8,
  enableVolcanicAsh:      true,
  enableWildfireSmoke:    true,
  enableCoastalSpray:     true,
  enableUrbanPollution:   true,
  enableIES:              true,
  transitionCooldown:     5.0,
  pmTrackingEnabled:      true
});

class AirQualityAtmosphereProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.defaults = { ...AIR_QUALITY_DEFAULTS, ...(options.defaults || {}) };
    this.defaults.worldSeed = this.defaults.worldSeed | 0;
    this.optics = { ...AIR_OPTICS, ...(options.optics || {}) };
    this.material = { ...AIR_QUALITY_MATERIAL, ...(options.material || {}) };
    this.constants = { ...ATMOSPHERE_CONSTANTS, ...(options.constants || {}) };
    this.thresholds = [...AIR_QUALITY_THRESHOLDS];

    // ── scratch (pooled) ────────────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVecD = new Vec3();
    this._tmpColorA = new Vec3();
    this._tmpColorB = new Vec3();
    this._tmpMatA = new Mat4();
    this._tmpSphere = new Sphere();

    // ── per-chunk air-quality state ────────────────────────
    const chunkCap = options.maxTrackedChunks ?? 256;
    this._chunkCap = chunkCap;
    this._chunkKeys = new Map();
    this._chunkSlot = 0;
    this._chunkUsed = 0;

    this._chunkCX = new Int32Array(chunkCap);
    this._chunkCZ = new Int32Array(chunkCap);
    this._chunkState = new Uint8Array(chunkCap);

    // Per-chunk optics.
    this._chunkPreset                  = new Uint8Array(chunkCap);
    this._chunkAirQualityState         = new Uint8Array(chunkCap);
    this._chunkBetaRR                  = new Float32Array(chunkCap);
    this._chunkBetaRG                  = new Float32Array(chunkCap);
    this._chunkBetaRB                  = new Float32Array(chunkCap);
    this._chunkBetaMR                  = new Float32Array(chunkCap);
    this._chunkBetaMG                  = new Float32Array(chunkCap);
    this._chunkBetaMB                  = new Float32Array(chunkCap);
    this._chunkMieG                    = new Float32Array(chunkCap);
    this._chunkAod550                  = new Float32Array(chunkCap);
    this._chunkAngstromExp             = new Float32Array(chunkCap);
    this._chunkAngstromTurb            = new Float32Array(chunkCap);
    this._chunkSingleScatterAlbedo     = new Float32Array(chunkCap);
    this._chunkVisibility              = new Float32Array(chunkCap);   // m
    this._chunkExtinction              = new Float32Array(chunkCap);   // 1/m

    // Pollution species (µg/m³).
    this._chunkSO2                     = new Float32Array(chunkCap);
    this._chunkNOx                     = new Float32Array(chunkCap);
    this._chunkPM25                    = new Float32Array(chunkCap);
    this._chunkPM10                    = new Float32Array(chunkCap);
    this._chunkO3                      = new Float32Array(chunkCap);
    this._chunkVOC                     = new Float32Array(chunkCap);

    // Salt spray, ash, smoke — component contributions.
    this._chunkSaltSpray               = new Float32Array(chunkCap);
    this._chunkVolcanicAsh             = new Float32Array(chunkCap);
    this._chunkSmoke                   = new Float32Array(chunkCap);
    this._chunkDust                    = new Float32Array(chunkCap);

    // IES application factors.
    this._chunkIesSkyFactor            = new Float32Array(chunkCap);
    this._chunkIesHazeFactor           = new Float32Array(chunkCap);

    // Per-cell data.
    const cellCap = this.defaults.maxCellsPerChunk;
    this._chunkCellCount = new Uint16Array(chunkCap);
    this._chunkCellX = new Array(chunkCap).fill(null);
    this._chunkCellY = new Array(chunkCap).fill(null);
    this._chunkCellZ = new Array(chunkCap).fill(null);
    this._chunkCellAod = new Array(chunkCap).fill(null);
    this._chunkCellState = new Array(chunkCap).fill(null);   // Uint8Array
    this._chunkCellPreset = new Array(chunkCap).fill(null);  // Uint8Array
    this._chunkCellExtinction = new Array(chunkCap).fill(null);
    this._chunkCellVisibility = new Array(chunkCap).fill(null);

    // Free lists.
    this._cellPool = { x: [], y: [], z: [], aod: [], extinction: [], visibility: [] };
    this._stateArrayPool = [];
    this._presetArrayPool = [];

    // ── per-frame global aggregate ─────────────────────────
    this._globalAirQuality = {
      avgAod550: 0.10,
      avgExtinction: 0.05,
      avgVisibility: 10000,
      avgBetaR: [5.8e-6, 13.5e-6, 33.1e-6],
      avgBetaM: [2.0e-7, 2.0e-7, 2.0e-7],
      avgMieG: 0.76,
      avgSingleScatterAlbedo: 0.98,
      avgAngstromExp: 1.4,
      avgAngstromTurb: 0.10,
      dominantPreset: 0,
      airQualityState: 1,
      airQualityStateName: 'clear',
      pollutionIndex: 0,
      dominantPollutionSpecies: 0,
      pollutionSO2: 0,
      pollutionNOx: 0,
      pollutionPM25: 0,
      pollutionPM10: 0,
      pollutionO3: 0,
      pollutionVOC: 0,
      saltSprayAvg: 0,
      volcanicAshAvg: 0,
      smokeAvg: 0,
      dustAvg: 0,
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
      pristineCells: 0,
      clearCells: 0,
      lightHazeCells: 0,
      moderateCells: 0,
      heavyCells: 0,
      severeCells: 0,
      pollutionEvents: 0,
      volcanicAshCells: 0,
      wildfireSmokeCells: 0,
      saltSprayCells: 0,
      dustCells: 0,
      aodChanges: 0,
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
    this._bathymetry = options.bathymetry || null;
    this._rocks = options.rocks || null;
    this._continental = options.continental || null;
    this._formations = options.formations || null;
    this._temporal = options.temporal || null;
    this._sunIntensity = options.sunIntensity || null;
    this._dispatcher = options.dispatcher || null;

    // ── reusable material output ───────────────────────────
    this._blendedParams = {
      pbr: { baseColor: [0,0,0], metalness: 0, roughness: 0, clearcoat: 0, transmission: 0, ior: 1.33, sheen: 0, anisotropy: 0, extinction: [0,0,0] },
      anime: { baseColor: [0,0,0], quantizeSteps: 3, rimPower: 2, rimColor: [0,0,0] },
      tint: 0,
      hazeThickness: 0,
      skyGlow: 1,
      animeFlatness: 0,
      iesSkyFactor: 1
    };

    // ── previous state per chunk (for transitions) ─────────
    this._chunkLastState = new Uint8Array(chunkCap);
    this._chunkLastTransitionTime = new Float64Array(chunkCap);
    this._chunkLastAod = new Float32Array(chunkCap);
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
  attachBathymetry(b) { this._bathymetry = b; return this; }
  attachRocks(r) { this._rocks = r; return this; }
  attachContinental(c) { this._continental = c; return this; }
  attachFormations(f) { this._formations = f; return this; }
  attachTemporal(t) { this._temporal = t; return this; }
  attachSunIntensity(s) { this._sunIntensity = s; return this; }
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
  // ─── pollution source detection ─────────────────────────
  // ══════════════════════════════════════════════════════════
  _detectVolcanicAsh(wx, wz, frame) {
    if (!this.defaults.enableVolcanicAsh) return 0;
    if (!this._formations) return 0;

    // Check if a vent is nearby.
    const formations = this._formations._placedChunks;
    if (!formations) return 0;

    // Check causal signals for volcanic eruption.
    let ashIntensity = 0;
    const causal = frame.layers.causal;
    if (causal && causal.derivedSignals) {
      const ds = causal.derivedSignals;
      for (let i = 0; i < ds.count; i++) {
        if (ds.types[i] === DERIVED_SIGNAL.LIGHT_FLICKER &&
            ds.forces[i] > 100) {
          // Hot impact = volcanic eruption nearby.
          const px = ds.positions[i * 3];
          const pz = ds.positions[i * 3 + 2];
          const dx = wx - px;
          const dz = wz - pz;
          const dist2 = dx * dx + dz * dz;
          const decay = Math.exp(-Math.sqrt(dist2) / this.constants.volcanicPlumeDecay);
          ashIntensity += ds.forces[i] * decay * 0.001 * ds.decays[i];
        }
      }
    }

    return Math.min(1, ashIntensity);
  }

  _detectWildfireSmoke(wx, wz, frame) {
    if (!this.defaults.enableWildfireSmoke) return 0;

    let smokeIntensity = 0;
    const causal = frame.layers.causal;
    if (causal && causal.derivedSignals) {
      const ds = causal.derivedSignals;
      for (let i = 0; i < ds.count; i++) {
        if (ds.types[i] === DERIVED_SIGNAL.IGNITE_CANDIDATE) {
          const px = ds.positions[i * 3];
          const pz = ds.positions[i * 3 + 2];
          const dx = wx - px;
          const dz = wz - pz;
          const dist2 = dx * dx + dz * dz;
          const decay = Math.exp(-Math.sqrt(dist2) / this.constants.wildfireSmokeDecay);
          smokeIntensity += ds.forces[i] * decay * 0.0005 * ds.decays[i];
        }
      }
    }
    return Math.min(1, smokeIntensity);
  }

  _detectSaltSpray(wx, wz) {
    if (!this.defaults.enableCoastalSpray) return 0;
    if (!this._bathymetry) return 0;

    // Distance to nearest water.
    const water = this._bathymetry.getWaterAt(wx, wz);
    if (!water) {
      // Sample nearby to find water.
      const step = 1000;
      const dirs = [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
      for (const [dx, dz] of dirs) {
        for (let d = step; d <= this.constants.saltSprayDecay; d += step) {
          const wx2 = wx + dx * d;
          const wz2 = wz + dz * d;
          const w = this._bathymetry.getWaterAt(wx2, wz2);
          if (w && w.waterCoverage > 0.1) {
            // Salt spray decays from the coast.
            return Math.exp(-d / this.constants.saltSprayDecay);
          }
        }
      }
      return 0;
    }
    // On water: full salt spray.
    return Math.max(0, water.waterCoverage);
  }

  _detectUrbanPollution(wx, wz, frame) {
    if (!this.defaults.enableUrbanPollution) return 0;

    // Urban pollution: proxy from forest density + rock outcrops + other
    // high-human-activity indicators. Full implementation would query
    // an urban-zones provider.
    let pollution = 0;

    // Baseline urban pollution from high density of certain features.
    const physical = frame.layers.physical;
    const forestBiomass = physical?.forestBiomass ?? 0;
    // High biomass + high temperature = fire risk = pollution.
    if (forestBiomass > 20) {
      pollution += 0.15;
    }

    return pollution;
  }

  _computeDust(wx, wz, frame) {
    const wind = frame.layers.physical?.wind;
    const windSpeed = Math.sqrt(
      (wind?.[0] ?? 0) ** 2 + (wind?.[2] ?? 0) ** 2
    );
    if (windSpeed < 8) return 0;

    // Dust only in arid regions.
    const moisture = frame.layers.physical?.soilMoisture ?? 0.5;
    if (moisture > 0.35) return 0;

    // Dust scales with wind above threshold, capped.
    return Math.min(1, (windSpeed - 8) / 20) * (1 - moisture / 0.35);
  }

  // ══════════════════════════════════════════════════════════
  // ─── preset classification ──────────────────────────────
  // ══════════════════════════════════════════════════════════
  _classifyPreset(ash, smoke, salt, dust, smog, moisture, temperature, elevation) {
    if (ash > 0.4) return AIR_QUALITY_PRESET.VOLCANIC_ASH;
    if (smoke > 0.3) return AIR_QUALITY_PRESET.WILDFIRE_SMOKE;
    if (dust > 0.3) return AIR_QUALITY_PRESET.DESERT_DUSTY;
    if (smog > 0.3) return AIR_QUALITY_PRESET.URBAN_SMOG;
    if (moisture > 0.85) return AIR_QUALITY_PRESET.FOG_LADEN;
    if (salt > 0.3) return AIR_QUALITY_PRESET.COASTAL_SALTY;
    if (elevation > 2000) return AIR_QUALITY_PRESET.CLEAN_ALPINE;
    if (temperature > 22 && moisture > 0.5) return AIR_QUALITY_PRESET.TROPICAL_CLEAR;
    return AIR_QUALITY_PRESET.TEMPERATE_HAZE;
  }

  _classifyAirQualityState(aod) {
    const t = this.thresholds;
    if (aod < t[0]) return AIR_QUALITY_STATE.PRISTINE;
    if (aod < t[1]) return AIR_QUALITY_STATE.CLEAR;
    if (aod < t[2]) return AIR_QUALITY_STATE.LIGHT_HAZE;
    if (aod < t[3]) return AIR_QUALITY_STATE.MODERATE;
    if (aod < t[4]) return AIR_QUALITY_STATE.HEAVY;
    return AIR_QUALITY_STATE.SEVERE;
  }

  // ══════════════════════════════════════════════════════════
  // ─── extinction coefficient (Koschmieder) ───────────────
  // ══════════════════════════════════════════════════════════
  // β_ext = β_R + β_M  (per channel), and visibility via
  // V = 3.912 / β_ext.
  _computeExtinctionAndVisibility(betaR, betaM, outExtinction, outVisibility) {
    const extR = betaR[0] + betaM[0];
    const extG = betaR[1] + betaM[1];
    const extB = betaR[2] + betaM[2];
    outExtinction[0] = extR;
    outExtinction[1] = extG;
    outExtinction[2] = extB;

    // Visibility is derived from the green channel.
    outVisibility[0] = this.constants.koschmiederK / Math.max(1e-8, extG);
    return outVisibility[0];
  }

  // ══════════════════════════════════════════════════════════
  // ─── precipitation scavenging ───────────────────────────
  // ══════════════════════════════════════════════════════════
  _applyScavenging(betaM, precipitationIntensity) {
    if (precipitationIntensity <= 0) return betaM;
    const scavenge = 1 - Math.min(0.8,
      precipitationIntensity * this.constants.rainScavengeRate);
    return [
      betaM[0] * scavenge,
      betaM[1] * scavenge,
      betaM[2] * scavenge
    ];
  }

  // ══════════════════════════════════════════════════════════
  // ─── wind dispersal ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _applyWindDispersal(betaM, windSpeed) {
    if (windSpeed <= 0) return betaM;
    const dispersal = 1 - Math.min(0.5,
      windSpeed * this.constants.windDispersalRate);
    return [
      betaM[0] * dispersal,
      betaM[1] * dispersal,
      betaM[2] * dispersal
    ];
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
      this._chunkCellAod[slot] = this._acquireCell('aod');
      this._chunkCellState[slot] = this._acquireState();
      this._chunkCellPreset[slot] = this._acquirePresetArray();
      this._chunkCellExtinction[slot] = new Float32Array(this.defaults.maxCellsPerChunk * 3);
      this._chunkCellVisibility[slot] = this._acquireCell('visibility');
    }

    const cpx = this._chunkCellX[slot];
    const cpy = this._chunkCellY[slot];
    const cpz = this._chunkCellZ[slot];
    const cpAod = this._chunkCellAod[slot];
    const cpState = this._chunkCellState[slot];
    const cpPreset = this._chunkCellPreset[slot];
    const cpExt = this._chunkCellExtinction[slot];
    const cpVis = this._chunkCellVisibility[slot];

    let placed = 0;

    // ── Global context ──────────────────────────────────────
    const physical = frame.layers.physical;
    const ambientTemp = physical?.ambientTemperature ?? 15;
    const moisture = physical?.relativeHumidity ?? 0.5;
    const windSpeed = physical?.windSpeed ?? 0;
    const precipIntensity = physical?.precipitationIntensity ?? 0;

    // ── Aggregates ──────────────────────────────────────────
    let sumAod = 0, sumVis = 0;
    let sumExtR = 0, sumExtG = 0, sumExtB = 0;
    let sumBetaRR = 0, sumBetaRG = 0, sumBetaRB = 0;
    let sumBetaMR = 0, sumBetaMG = 0, sumBetaMB = 0;
    let sumMieG = 0, sumSSA = 0, sumAE = 0, sumAT = 0;
    let sumSO2 = 0, sumNOx = 0, sumPM25 = 0, sumPM10 = 0, sumO3 = 0, sumVOC = 0;
    let sumSalt = 0, sumAsh = 0, sumSmoke = 0, sumDust = 0;

    const presetCount = new Uint16Array(AIR_QUALITY_PRESET_NAMES.length);
    const stateCount = new Uint16Array(AIR_QUALITY_STATE_NAMES.length);

    // ── Sample each cell ────────────────────────────────────
    for (let j = 0; j < cellsPerSide && placed < this.defaults.maxCellsPerChunk; j++) {
      for (let i = 0; i < cellsPerSide && placed < this.defaults.maxCellsPerChunk; i++) {
        const wx = cx * chunkSize + (i + 0.5) * cellSize;
        const wz = cz * chunkSize + (j + 0.5) * cellSize;
        const altitude = this._getHeight(wx, wz);

        // ── Pollution sources ──────────────────────────────
        const ash = this._detectVolcanicAsh(wx, wz, frame);
        const smoke = this._detectWildfireSmoke(wx, wz, frame);
        const salt = this._detectSaltSpray(wx, wz);
        const dust = this._computeDust(wx, wz, frame);
        const smog = this._detectUrbanPollution(wx, wz, frame);

        // ── Base optical coefficients by preset ────────────
        const preset = this._classifyPreset(
          ash, smoke, salt, dust, smog, moisture, ambientTemp, altitude
        );
        const optics = AIR_OPTICS[preset] || AIR_OPTICS[AIR_QUALITY_PRESET.CLEAN_ALPINE];

        let betaR = [...optics.betaR];
        let betaM = [...optics.betaM];
        const mieG = optics.mieG;
        let aod = optics.aod550;
        const angstromExp = optics.angstromExp;
        const angstromTurb = optics.angstromTurb;
        const ssa = optics.singleScatterAlbedo;

        // ── Boost coefficients from local sources ─────────
        if (ash > 0) {
          const ashBoost = ash * 8e-6;
          betaM[0] += ashBoost * 1.4;
          betaM[1] += ashBoost * 1.0;
          betaM[2] += ashBoost * 0.7;
          aod += ash * 2.5;
        }
        if (smoke > 0) {
          const smokeBoost = smoke * 6e-6;
          betaM[0] += smokeBoost * 1.5;
          betaM[1] += smokeBoost * 1.1;
          betaM[2] += smokeBoost * 0.8;
          aod += smoke * 1.2;
        }
        if (salt > 0) {
          const saltBoost = salt * 2e-6;
          betaM[0] += saltBoost;
          betaM[1] += saltBoost;
          betaM[2] += saltBoost;
          aod += salt * 0.15;
        }
        if (dust > 0) {
          const dustBoost = dust * 8e-6;
          betaM[0] += dustBoost * 1.2;
          betaM[1] += dustBoost * 1.0;
          betaM[2] += dustBoost * 0.6;
          aod += dust * 0.5;
        }
        if (smog > 0) {
          const smogBoost = smog * 4e-6;
          betaM[0] += smogBoost;
          betaM[1] += smogBoost * 0.9;
          betaM[2] += smogBoost * 0.8;
          aod += smog * 0.3;
        }

        // ── Altitude attenuation of aerosol ────────────────
        const altitudeFactor = Math.exp(-altitude / this.constants.aerosolScaleHeight);
        for (let c = 0; c < 3; c++) betaM[c] *= (0.2 + altitudeFactor * 0.8);

        // ── Precipitation scavenging ───────────────────────
        betaM = this._applyScavenging(betaM, precipIntensity);

        // ── Wind dispersal ─────────────────────────────────
        betaM = this._applyWindDispersal(betaM, windSpeed);

        // ── Extinction and visibility ──────────────────────
        const extinction = [0, 0, 0];
        const visibility = [0];
        this._computeExtinctionAndVisibility(betaR, betaM, extinction, visibility);

        // ── Air-quality state ──────────────────────────────
        const state = this._classifyAirQualityState(aod);

        // ── Pollution species (approximate from source contributions) ──
        const so2 = (ash * 200 + smoke * 100 + smog * 80) + 5;
        const nox = (smoke * 150 + smog * 120) + 10;
        const pm25 = (ash * 500 + smoke * 400 + smog * 150 + dust * 100) + 5;
        const pm10 = (ash * 800 + smoke * 300 + dust * 300 + salt * 100) + 10;
        const o3 = (smog * 80 + ash * 20) + 30;
        const voc = (smoke * 300 + smog * 100) + 20;

        // ── Store cell ─────────────────────────────────────
        cpx[placed] = wx;
        cpy[placed] = altitude;
        cpz[placed] = wz;
        cpAod[placed] = aod;
        cpState[placed] = state;
        cpPreset[placed] = preset;
        const co = placed * 3;
        cpExt[co]     = extinction[0];
        cpExt[co + 1] = extinction[1];
        cpExt[co + 2] = extinction[2];
        cpVis[placed] = visibility[0];
        placed++;

        // ── Aggregates ─────────────────────────────────────
        sumAod += aod;
        sumVis += visibility[0];
        sumExtR += extinction[0];
        sumExtG += extinction[1];
        sumExtB += extinction[2];
        sumBetaRR += betaR[0];
        sumBetaRG += betaR[1];
        sumBetaRB += betaR[2];
        sumBetaMR += betaM[0];
        sumBetaMG += betaM[1];
        sumBetaMB += betaM[2];
        sumMieG += mieG;
        sumSSA += ssa;
        sumAE += angstromExp;
        sumAT += angstromTurb;
        sumSO2 += so2;
        sumNOx += nox;
        sumPM25 += pm25;
        sumPM10 += pm10;
        sumO3 += o3;
        sumVOC += voc;
        sumSalt += salt;
        sumAsh += ash;
        sumSmoke += smoke;
        sumDust += dust;
        presetCount[preset]++;
        stateCount[state]++;

        // ── Per-state stats ────────────────────────────────
        switch (state) {
          case AIR_QUALITY_STATE.PRISTINE:    this._stats.pristineCells++; break;
          case AIR_QUALITY_STATE.CLEAR:       this._stats.clearCells++; break;
          case AIR_QUALITY_STATE.LIGHT_HAZE:  this._stats.lightHazeCells++; break;
          case AIR_QUALITY_STATE.MODERATE:    this._stats.moderateCells++; break;
          case AIR_QUALITY_STATE.HEAVY:       this._stats.heavyCells++; break;
          case AIR_QUALITY_STATE.SEVERE:      this._stats.severeCells++; break;
        }
        if (ash > 0.2) this._stats.volcanicAshCells++;
        if (smoke > 0.2) this._stats.wildfireSmokeCells++;
        if (salt > 0.2) this._stats.saltSprayCells++;
        if (dust > 0.2) this._stats.dustCells++;

        this._stats.cellsSampled++;
      }
    }

    this._chunkCellCount[slot] = placed;

    // ── Store chunk summary ────────────────────────────────
    const inv = placed > 0 ? 1 / placed : 0;
    this._chunkAod550[slot] = sumAod * inv;
    this._chunkVisibility[slot] = sumVis * inv;
    this._chunkExtinction[slot] = sumExtG * inv;
    this._chunkBetaRR[slot] = sumBetaRR * inv;
    this._chunkBetaRG[slot] = sumBetaRG * inv;
    this._chunkBetaRB[slot] = sumBetaRB * inv;
    this._chunkBetaMR[slot] = sumBetaMR * inv;
    this._chunkBetaMG[slot] = sumBetaMG * inv;
    this._chunkBetaMB[slot] = sumBetaMB * inv;
    this._chunkMieG[slot] = sumMieG * inv;
    this._chunkSingleScatterAlbedo[slot] = sumSSA * inv;
    this._chunkAngstromExp[slot] = sumAE * inv;
    this._chunkAngstromTurb[slot] = sumAT * inv;
    this._chunkSO2[slot] = sumSO2 * inv;
    this._chunkNOx[slot] = sumNOx * inv;
    this._chunkPM25[slot] = sumPM25 * inv;
    this._chunkPM10[slot] = sumPM10 * inv;
    this._chunkO3[slot] = sumO3 * inv;
    this._chunkVOC[slot] = sumVOC * inv;
    this._chunkSaltSpray[slot] = sumSalt * inv;
    this._chunkVolcanicAsh[slot] = sumAsh * inv;
    this._chunkSmoke[slot] = sumSmoke * inv;
    this._chunkDust[slot] = sumDust * inv;

    // ── Dominant preset and state ──────────────────────────
    let domPreset = 0, maxPresetCount = 0;
    for (let p = 0; p < presetCount.length; p++) {
      if (presetCount[p] > maxPresetCount) { maxPresetCount = presetCount[p]; domPreset = p; }
    }
    this._chunkPreset[slot] = domPreset;

    let domState = 0, maxStateCount = 0;
    for (let s = 0; s < stateCount.length; s++) {
      if (stateCount[s] > maxStateCount) { maxStateCount = stateCount[s]; domState = s; }
    }
    this._chunkAirQualityState[slot] = domState;

    // ── IES application factors ────────────────────────────
    // If an IES profile is active on the sun, allow it to modulate
    // haze brightness.
    let iesSkyFactor = 1.0;
    let iesHazeFactor = 1.0;
    if (this.defaults.enableIES && IES_PROFILES.size > 0) {
      const profile = IES_PROFILES.values().next().value;
      if (profile && profile.map) {
        iesSkyFactor = 1.0 + (this._chunkAod550[slot] * 0.5);
        iesHazeFactor = 1.0 + (this._chunkAod550[slot] * 1.5);
      }
    }
    this._chunkIesSkyFactor[slot] = iesSkyFactor;
    this._chunkIesHazeFactor[slot] = iesHazeFactor;

    this._stats.chunksProcessed++;

    // ── AOD change event ───────────────────────────────────
    const previousAod = this._chunkLastAod[slot];
    if (previousAod > 0 && Math.abs(this._chunkAod550[slot] - previousAod) > this.constants.aodChangeThreshold) {
      this._stats.aodChanges++;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, 20, 6.0,
          {
            kind: 'air_quality_change',
            chunkX: cx, chunkZ: cz,
            fromAod: previousAod,
            toAod: this._chunkAod550[slot],
            dominantPreset: AIR_QUALITY_PRESET_NAMES[domPreset],
            state: AIR_QUALITY_STATE_NAMES[domState],
            visibility: this._chunkVisibility[slot]
          }
        );
        this._stats.mutationEventsEmitted++;
      }
    }
    this._chunkLastAod[slot] = this._chunkAod550[slot];

    // ── State transition event ─────────────────────────────
    const previousState = this._chunkLastState[slot];
    if (previousState !== 0 && previousState !== domState &&
        now - this._chunkLastTransitionTime[slot] > this.defaults.transitionCooldown) {
      this._chunkLastTransitionTime[slot] = now;

      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.AUDIO_LIGHT,
          [(cx + 0.5) * chunkSize, 0, (cz + 0.5) * chunkSize],
          -1, 30, 5.0,
          {
            kind: 'air_quality_state_transition',
            chunkX: cx, chunkZ: cz,
            fromState: previousState,
            toState: domState,
            fromStateName: AIR_QUALITY_STATE_NAMES[previousState],
            toStateName: AIR_QUALITY_STATE_NAMES[domState],
            aod: this._chunkAod550[slot],
            visibility: this._chunkVisibility[slot]
          }
        );
      }
    }
    this._chunkLastState[slot] = domState;

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
    this._chunkLastAod[slot] = 0;
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
      this._cellPool.aod.push(this._chunkCellAod[slot]);
      this._cellPool.extinction.push(this._chunkCellExtinction[slot]);
      this._cellPool.visibility.push(this._chunkCellVisibility[slot]);
      this._stateArrayPool.push(this._chunkCellState[slot]);
      this._presetArrayPool.push(this._chunkCellPreset[slot]);
    }
    this._chunkCellX[slot] = null;
    this._chunkCellY[slot] = null;
    this._chunkCellZ[slot] = null;
    this._chunkCellAod[slot] = null;
    this._chunkCellState[slot] = null;
    this._chunkCellPreset[slot] = null;
    this._chunkCellExtinction[slot] = null;
    this._chunkCellVisibility[slot] = null;
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

  _acquirePresetArray() {
    if (this._presetArrayPool.length > 0) {
      const arr = this._presetArrayPool.pop();
      arr.fill(0);
      return arr;
    }
    return new Uint8Array(this.defaults.maxCellsPerChunk);
  }

  // ══════════════════════════════════════════════════════════
  // ─── public queries ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getAirQualityAt(wx, wz) {
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot < 0 || this._chunkState[slot] === 0) return null;

    return {
      preset: this._chunkPreset[slot],
      presetName: AIR_QUALITY_PRESET_NAMES[this._chunkPreset[slot]],
      airQualityState: this._chunkAirQualityState[slot],
      airQualityStateName: AIR_QUALITY_STATE_NAMES[this._chunkAirQualityState[slot]],
      betaR: [this._chunkBetaRR[slot], this._chunkBetaRG[slot], this._chunkBetaRB[slot]],
      betaM: [this._chunkBetaMR[slot], this._chunkBetaMG[slot], this._chunkBetaMB[slot]],
      mieG: this._chunkMieG[slot],
      aod550: this._chunkAod550[slot],
      angstromExp: this._chunkAngstromExp[slot],
      angstromTurb: this._chunkAngstromTurb[slot],
      singleScatterAlbedo: this._chunkSingleScatterAlbedo[slot],
      visibility: this._chunkVisibility[slot],
      extinction: this._chunkExtinction[slot],
      so2: this._chunkSO2[slot],
      nox: this._chunkNOx[slot],
      pm25: this._chunkPM25[slot],
      pm10: this._chunkPM10[slot],
      o3: this._chunkO3[slot],
      voc: this._chunkVOC[slot],
      saltSpray: this._chunkSaltSpray[slot],
      volcanicAsh: this._chunkVolcanicAsh[slot],
      smoke: this._chunkSmoke[slot],
      dust: this._chunkDust[slot],
      iesSkyFactor: this._chunkIesSkyFactor[slot],
      iesHazeFactor: this._chunkIesHazeFactor[slot],
      cellCount: this._chunkCellCount[slot],
      cells: {
        x: this._chunkCellX[slot],
        y: this._chunkCellY[slot],
        z: this._chunkCellZ[slot],
        aod: this._chunkCellAod[slot],
        state: this._chunkCellState[slot],
        preset: this._chunkCellPreset[slot],
        extinction: this._chunkCellExtinction[slot],
        visibility: this._chunkCellVisibility[slot]
      }
    };
  }

  // ── sample AOD at any world position ──────────────────────
  sampleAodAt(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkAod550[slot];
    }
    return 0.10;
  }

  // ── sample extinction at any world position ───────────────
  sampleExtinctionAt(wx, wz, frame, outExtinction) {
    if (!frame) frame = this._frameRef;
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      outExtinction[0] = this._chunkBetaRR[slot] + this._chunkBetaMR[slot];
      outExtinction[1] = this._chunkBetaRG[slot] + this._chunkBetaMG[slot];
      outExtinction[2] = this._chunkBetaRB[slot] + this._chunkBetaMB[slot];
      return outExtinction;
    }
    outExtinction[0] = 5.8e-6 + 2e-7;
    outExtinction[1] = 13.5e-6 + 2e-7;
    outExtinction[2] = 33.1e-6 + 2e-7;
    return outExtinction;
  }

  // ── sample IES scaling factor ─────────────────────────────
  sampleIesSkyFactor(wx, wz, frame) {
    if (!frame) frame = this._frameRef;
    const cx = Math.floor(wx / this.defaults.chunkSize);
    const cz = Math.floor(wz / this.defaults.chunkSize);
    const slot = this._getChunkSlot(cx, cz);
    if (slot >= 0 && this._chunkState[slot] === 1) {
      return this._chunkIesSkyFactor[slot];
    }
    return 1.0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── material parameter dispatch ────────────────────────
  // ══════════════════════════════════════════════════════════
  getAirQualityMaterialParams(preset) {
    return AIR_QUALITY_MATERIAL[preset] || AIR_QUALITY_MATERIAL[AIR_QUALITY_PRESET.CLEAN_ALPINE];
  }

  blendAirQualityMaterial(preset, aod, extinction, out) {
    const src = AIR_QUALITY_MATERIAL[preset] || AIR_QUALITY_MATERIAL[AIR_QUALITY_PRESET.CLEAN_ALPINE];
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
    o.pbr.extinction[0] = extinction[0] ?? src.pbr.extinction[0];
    o.pbr.extinction[1] = extinction[1] ?? src.pbr.extinction[1];
    o.pbr.extinction[2] = extinction[2] ?? src.pbr.extinction[2];

    o.anime.baseColor[0] = src.anime.baseColor[0];
    o.anime.baseColor[1] = src.anime.baseColor[1];
    o.anime.baseColor[2] = src.anime.baseColor[2];
    o.anime.quantizeSteps = src.anime.quantizeSteps;
    o.anime.rimPower = src.anime.rimPower;
    o.anime.rimColor[0] = src.anime.rimColor[0];
    o.anime.rimColor[1] = src.anime.rimColor[1];
    o.anime.rimColor[2] = src.anime.rimColor[2];

    o.tint = src.tint * Math.min(2, aod / 0.2);
    o.hazeThickness = src.hazeThickness * Math.min(2, aod / 0.2);
    o.skyGlow = src.skyGlow;
    o.animeFlatness = src.animeFlatness;
    o.iesSkyFactor = src.iesSkyFactor;

    return o;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.airQuality) {
      spatial.airQuality = {
        chunkCount: 0,
        chunkCX: new Int32Array(this._chunkCap),
        chunkCZ: new Int32Array(this._chunkCap),
        chunkSlots: new Int32Array(this._chunkCap),
        preset: this._chunkPreset,
        airQualityState: this._chunkAirQualityState,
        betaRR: this._chunkBetaRR,
        betaRG: this._chunkBetaRG,
        betaRB: this._chunkBetaRB,
        betaMR: this._chunkBetaMR,
        betaMG: this._chunkBetaMG,
        betaMB: this._chunkBetaMB,
        mieG: this._chunkMieG,
        aod550: this._chunkAod550,
        angstromExp: this._chunkAngstromExp,
        angstromTurb: this._chunkAngstromTurb,
        singleScatterAlbedo: this._chunkSingleScatterAlbedo,
        visibility: this._chunkVisibility,
        extinction: this._chunkExtinction,
        so2: this._chunkSO2,
        nox: this._chunkNOx,
        pm25: this._chunkPM25,
        pm10: this._chunkPM10,
        o3: this._chunkO3,
        voc: this._chunkVOC,
        saltSpray: this._chunkSaltSpray,
        volcanicAsh: this._chunkVolcanicAsh,
        smoke: this._chunkSmoke,
        dust: this._chunkDust,
        iesSkyFactor: this._chunkIesSkyFactor,
        iesHazeFactor: this._chunkIesHazeFactor,
        cells: {
          count: this._chunkCellCount,
          x: this._chunkCellX,
          y: this._chunkCellY,
          z: this._chunkCellZ,
          aod: this._chunkCellAod,
          state: this._chunkCellState,
          preset: this._chunkCellPreset,
          extinction: this._chunkCellExtinction,
          visibility: this._chunkCellVisibility
        },
        materialParams: AIR_QUALITY_MATERIAL,
        presetNames: AIR_QUALITY_PRESET_NAMES,
        stateNames: AIR_QUALITY_STATE_NAMES,
        optics: AIR_OPTICS
      };
    }

    const a = spatial.airQuality;
    a.chunkCount = 0;
    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      if (a.chunkCount >= this._chunkCap) break;
      a.chunkCX[a.chunkCount] = this._chunkCX[i];
      a.chunkCZ[a.chunkCount] = this._chunkCZ[i];
      a.chunkSlots[a.chunkCount] = i;
      a.chunkCount++;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    let sumAod = 0, sumExt = 0, sumVis = 0;
    let sumBetaRR = 0, sumBetaRG = 0, sumBetaRB = 0;
    let sumBetaMR = 0, sumBetaMG = 0, sumBetaMB = 0;
    let sumMieG = 0, sumSSA = 0, sumAE = 0, sumAT = 0;
    let sumSO2 = 0, sumNOx = 0, sumPM25 = 0, sumPM10 = 0, sumO3 = 0, sumVOC = 0;
    let sumSalt = 0, sumAsh = 0, sumSmoke = 0, sumDust = 0;
    let chunksWithAir = 0;

    const presetCount = new Uint16Array(AIR_QUALITY_PRESET_NAMES.length);
    const stateCount = new Uint16Array(AIR_QUALITY_STATE_NAMES.length);

    for (let i = 0; i < this._chunkCap; i++) {
      if (this._chunkState[i] === 0) continue;
      chunksWithAir++;
      sumAod += this._chunkAod550[i];
      sumExt += this._chunkExtinction[i];
      sumVis += this._chunkVisibility[i];
      sumBetaRR += this._chunkBetaRR[i];
      sumBetaRG += this._chunkBetaRG[i];
      sumBetaRB += this._chunkBetaRB[i];
      sumBetaMR += this._chunkBetaMR[i];
      sumBetaMG += this._chunkBetaMG[i];
      sumBetaMB += this._chunkBetaMB[i];
      sumMieG += this._chunkMieG[i];
      sumSSA += this._chunkSingleScatterAlbedo[i];
      sumAE += this._chunkAngstromExp[i];
      sumAT += this._chunkAngstromTurb[i];
      sumSO2 += this._chunkSO2[i];
      sumNOx += this._chunkNOx[i];
      sumPM25 += this._chunkPM25[i];
      sumPM10 += this._chunkPM10[i];
      sumO3 += this._chunkO3[i];
      sumVOC += this._chunkVOC[i];
      sumSalt += this._chunkSaltSpray[i];
      sumAsh += this._chunkVolcanicAsh[i];
      sumSmoke += this._chunkSmoke[i];
      sumDust += this._chunkDust[i];
      presetCount[this._chunkPreset[i]]++;
      stateCount[this._chunkAirQualityState[i]]++;
    }

    const ga = this._globalAirQuality;
    const inv = chunksWithAir > 0 ? 1 / chunksWithAir : 0;
    ga.avgAod550 = sumAod * inv;
    ga.avgExtinction = sumExt * inv;
    ga.avgVisibility = sumVis * inv;
    ga.avgBetaR = [sumBetaRR * inv, sumBetaRG * inv, sumBetaRB * inv];
    ga.avgBetaM = [sumBetaMR * inv, sumBetaMG * inv, sumBetaMB * inv];
    ga.avgMieG = sumMieG * inv || 0.76;
    ga.avgSingleScatterAlbedo = sumSSA * inv || 0.98;
    ga.avgAngstromExp = sumAE * inv || 1.4;
    ga.avgAngstromTurb = sumAT * inv || 0.10;
    ga.pollutionSO2 = sumSO2 * inv;
    ga.pollutionNOx = sumNOx * inv;
    ga.pollutionPM25 = sumPM25 * inv;
    ga.pollutionPM10 = sumPM10 * inv;
    ga.pollutionO3 = sumO3 * inv;
    ga.pollutionVOC = sumVOC * inv;
    ga.saltSprayAvg = sumSalt * inv;
    ga.volcanicAshAvg = sumAsh * inv;
    ga.smokeAvg = sumSmoke * inv;
    ga.dustAvg = sumDust * inv;

    // Composite pollution index (0..100).
    ga.pollutionIndex = Math.min(100,
      (ga.pollutionPM25 * 0.3 + ga.pollutionPM10 * 0.2 +
       ga.pollutionNOx * 0.15 + ga.pollutionSO2 * 0.15 +
       ga.pollutionO3 * 0.1 + ga.pollutionVOC * 0.1) / 5
    );

    // Dominant pollution species.
    const pollutionArray = [
      ga.pollutionSO2, ga.pollutionNOx, ga.pollutionPM25,
      ga.pollutionPM10, ga.pollutionO3, ga.pollutionVOC
    ];
    let dominantPollution = 0;
    let maxPollution = 0;
    for (let p = 0; p < pollutionArray.length; p++) {
      if (pollutionArray[p] > maxPollution) {
        maxPollution = pollutionArray[p];
        dominantPollution = p;
      }
    }
    ga.dominantPollutionSpecies = dominantPollution;

    // Dominant preset.
    let domPreset = 0;
    let maxPresetCount = 0;
    for (let p = 0; p < presetCount.length; p++) {
      if (presetCount[p] > maxPresetCount) {
        maxPresetCount = presetCount[p];
        domPreset = p;
      }
    }
    ga.dominantPreset = domPreset;

    // Dominant state.
    let domState = 0;
    let maxStateCount = 0;
    for (let s = 0; s < stateCount.length; s++) {
      if (stateCount[s] > maxStateCount) {
        maxStateCount = stateCount[s];
        domState = s;
      }
    }
    ga.airQualityState = domState;
    ga.airQualityStateName = AIR_QUALITY_STATE_NAMES[domState];

    ga.iesActive = this.defaults.enableIES && IES_PROFILES.size > 0;

    if (!physical.airQualityProperties) physical.airQualityProperties = {};
    Object.assign(physical.airQualityProperties, ga);

    // Material-facing aggregates.
    physical.aerosolOpticalDepth = ga.avgAod550;
    physical.atmosphericExtinction = ga.avgExtinction;
    physical.atmosphericVisibility = ga.avgVisibility;
    physical.rayleighCoefficients = ga.avgBetaR;
    physical.mieCoefficients = ga.avgBetaM;
    physical.mieAsymmetry = ga.avgMieG;
    physical.singleScatterAlbedo = ga.avgSingleScatterAlbedo;
    physical.angstromExponent = ga.avgAngstromExp;
    physical.angstromTurbidity = ga.avgAngstromTurb;
    physical.airQualityState = domState;
    physical.airQualityStateName = AIR_QUALITY_STATE_NAMES[domState];
    physical.airQualityPreset = domPreset;
    physical.airQualityPresetName = AIR_QUALITY_PRESET_NAMES[domPreset];
    physical.pollutionIndex = ga.pollutionIndex;
    physical.pollutionSO2 = ga.pollutionSO2;
    physical.pollutionNOx = ga.pollutionNOx;
    physical.pollutionPM25 = ga.pollutionPM25;
    physical.pollutionPM10 = ga.pollutionPM10;
    physical.pollutionO3 = ga.pollutionO3;
    physical.pollutionVOC = ga.pollutionVOC;
    physical.saltSprayAvg = ga.saltSprayAvg;
    physical.volcanicAshAvg = ga.volcanicAshAvg;
    physical.smokeAvg = ga.smokeAvg;
    physical.dustAvg = ga.dustAvg;
    physical.atmosphericIESActive = ga.iesActive;

    if (!physical.airQualityStateWeights) {
      physical.airQualityStateWeights = new Float32Array(AIR_QUALITY_STATE_NAMES.length);
    }
    if (chunksWithAir > 0) {
      for (let s = 0; s < stateCount.length; s++) {
        physical.airQualityStateWeights[s] = stateCount[s] / chunksWithAir;
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

  setCellSize(size) {
    if (size > 0) this.defaults.cellSize = size;
    return this;
  }

  setMaxChunksPerFrame(count) {
    if (count > 0) this.defaults.maxChunksPerFrame = count;
    return this;
  }

  setOptics(params) {
    for (const k of Object.keys(this.optics)) {
      if (params[k] !== undefined) this.optics[k] = params[k];
    }
    return this;
  }

  setAtmosphereConstants(params) {
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

  // ══════════════════════════════════════════════════════════
  // ─── diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getGlobalAirQuality() { return { ...this._globalAirQuality }; }

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
    this._bathymetry = null;
    this._rocks = null;
    this._continental = null;
    this._formations = null;
    this._temporal = null;
    this._sunIntensity = null;
    this._dispatcher = null;
    this._frameRef = null;
    this._clearAllChunks();
    for (const key of Object.keys(this._cellPool)) {
      this._cellPool[key].length = 0;
    }
    this._stateArrayPool.length = 0;
    this._presetArrayPool.length = 0;
  }
}

export {
  AirQualityAtmosphereProvider,
  AIR_QUALITY_PRESET,
  AIR_QUALITY_PRESET_NAMES,
  AIR_QUALITY_STATE,
  AIR_QUALITY_STATE_NAMES,
  AIR_QUALITY_THRESHOLDS,
  AIR_OPTICS,
  AIR_QUALITY_MATERIAL,
  POLLUTION_SPECIES,
  POLLUTION_SPECIES_NAMES,
  ATMOSPHERE_CONSTANTS,
  AIR_QUALITY_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};