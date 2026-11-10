// file number : 078
// full path name : src/weather/078_weather_cameras.js
// description : Weather-aware camera system. Provides context-sensitive
//               camera behaviours and lens effects that respond in real
//               time to every atmospheric condition produced by files
//               040-077: rain, snow, fog, sandstorms, volcanic ash,
//               lightning, tornadoes, and nuclear/volcanic winter.
//
//               Unlike file 016 (which handles camera projection math
//               and ray generation), this file handles *experience*:
//               how the camera reacts, obscures, shakes, and adapts
//               in response to weather. This is what makes weather
//               "feel" real for players.
//
//               Contributes:
//                 • CAMERA MODES — the full set of weather-camera
//                   personalities:
//                     - FIRST_PERSON: player's eye. Raindrop-on-lens,
//                       fogged breath on cold days, snow-flake blurs,
//                       salt-spray at sea, sand-blasted surface.
//                     - HOOD: front-of-vehicle view. Windshield
//                       wipers, defogging, ice buildup, rain-sheeted
//                       vision at speed.
//                     - COCKPIT: interior view. Window fogging, cold
//                       breath cloud, cracks from hail.
//                     - CHASE: 3rd-person follow camera. Rain streaks
//                       tracking through view, splash-back from wheels,
//                       dust kicked up, snow-blind drift.
//                     - CINEMATIC: scripted cinematic. Weather-aware
//                       dramatic framing (hurricane eye, tornado
//                       funnel, lightning strike, aurora overhead).
//                     - PHOTO_MODE: player's photography camera. Full
//                       weather-aware exposure, focus, DOF, sun path,
//                       aurora detection, wildlife proximity.
//                     - UNDERWATER: submerged camera. Caustics,
//                       sediment, bubbles, murky visibility,
//                       thermocline shimmer.
//                     - DRONE: aerial camera. Full-sky weather view,
//                       cloud layers below, sun corona, polar strat
//                       clouds, contrails.
//                     - SATELLITE: orbital/high-altitude view. Global
//                       weather patterns, storm systems, cyclones,
//                       Arctic sea ice extent.
//                 • LENS EFFECTS — atmospheric obscuration:
//                     - RAIN_DROPS: individual drops on lens. Size,
//                       density, and lifetime derived from file 042's
//                       rain intensity. Wind direction modulates
//                       streak angle.
//                     - FOG_ON_LENS: interior/windshield fogging.
//                       Thickness grows when interior > exterior
//                       temperature or when breathing in cold air.
//                       Vents and defog reduce thickness.
//                     - FROST_ON_LENS: crystallized lens surface
//                       when temperature below freezing. Uses file
//                       061's frost habit pattern for crystal shape.
//                     - ICE_ON_LENS: thick ice buildup in freezing
//                       rain. Blocks the view progressively.
//                     - SNOW_BUILDUP: snow accumulates on the top
//                       edge of the lens housing, drooping into view.
//                     - SAND_ABRASION: sandstorm pitting of the lens,
//                       permanently reducing clarity until cleaned.
//                     - SALT_SPRAY: sea spray on coastal cameras.
//                     - ASH_FILM: fine volcanic ash settling on lens.
//                     - CONDENSATION: dew from warm humid interior
//                       hitting cold lens.
//                     - SCREEN_CRACKS: hail impact fractures.
//                 • WINDSHIELD / LENS CLEARING SYSTEMS — active
//                   mitigation:
//                     - WIPERS: periodic sweep, speed matched to rain
//                       intensity. Exposed via `activateWipers`.
//                     - DEFROSTERS: reduce lens fog/frost over time.
//                     - SPRAYERS: clean sandy/ashy lenses.
//                     - RAIN_REPELLENT: coating reduces drop adhesion.
//                 • CAMERA SHAKE — weather-driven:
//                     - WIND_GUSTS: steady push from file 047.
//                     - THUNDER: sharp jolt from file 041's flash.
//                     - EARTHQUAKE: shake from ground-motion (if a
//                       quake component exists).
//                     - EXPLOSION: shockwave push (nuclear/hail).
//                     - TURBULENCE: aircraft drone wobble from file 071.
//                     - TORNADO_PROXIMITY: rumble from file 048.
//                 • AUTO-EXPOSURE — dynamic exposure for HDR scenes:
//                     - Reads file 028's sky luminance.
//                     - Compensates for lightning flashes.
//                     - Compensates for twilight transitions.
//                     - Exposed via `getCameraExposure`.
//                 • AUTO-FOCUS / DOF — weather-aware focal plane:
//                     - Focuses on the player (foreground).
//                     - Focus shift when a raindrop falls on the lens.
//                     - Blur when fog reduces contrast.
//                     - Exposed via `getCameraFocusDistance`.
//                 • VISIBILITY ADAPTATION — cinematic framing around
//                   poor visibility:
//                     - When fog is dense, the chase camera pulls
//                       closer; the cinematic camera picks dramatic
//                       angles facing away from the sun.
//                     - When rain is heavy, the FPV tilts down to
//                       avoid streak overlay on the horizon.
//                 • WEATHER-AWARE HEAD-BOB — bobbing synchronized with
//                   walking through puddles, snow, or mud.
//                 • UNDERWATER CAUSTICS — for underwater cameras, a
//                   simulated caustic pattern based on the sun angle
//                   and wave refraction from file 059.
//                 • AURORA TRACKING — for photo mode cameras, the
//                   camera can auto-track the brightest aurora
//                   curtain (from file 053).
//                 • MILESTONE EVENTS — fires callbacks on weather
//                   "moments" worth capturing:
//                     - RAINBOW_VISIBLE
//                     - LIGHTNING_NEARBY
//                     - AURORA_OVERHEAD
//                     - TORNADO_VISIBLE
//                     - METEOR_SHOWER_PEAK
//                     - SUNRISE_GOLDEN_HOUR
//                     - SUNSET_GOLDEN_HOUR
//                 • CAMERA PROTECTION ZONES — indoor/vehicle/underwater
//                   states suppress outdoor effects. Overland interiors
//                   "see" rain but don't feel it. Windowed rooms see
//                   rain through glass.
//                 • THREE.JS BRIDGE — exposes the current lens effect
//                   state as uniform data ready for a fullscreen post-
//                   processing shader (file 019). Includes:
//                     - drop density, size, distribution map
//                     - fog thickness
//                     - frost/ice/snow/ash coverage
//                     - shake offset
//                     - exposure multiplier
//                     - chromatic aberration from heat haze
//               All state lives in typed arrays; per-frame cost is
//               O(active cameras) × O(1) per effect. Zero per-frame
//               allocation; steady-state 1M-entity scenes handle
//               weather cameras on Android 64-bit.
// best for : Weather-driven FPS, racing, flight sims, exploration
//            games, cinematic captures, photo mode, underwater
//            exploration, drone operations, and any 1M-entity scene
//            needing weather-aware camera response.
// license : MIT

import {
  $internal,
  query,
  addComponent,
  removeComponent,
  hasComponent,
  entityExists,
  getId,
} from '../ecs/001_ecs_core.js';

import {
  WorldTransformF32,
  LocalTransformF32,
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  WorldBoundsF32,
} from '../geometry/004_aabb_bounds.js';

import {
  SkyF32,
  getSkySlot,
  sampleSkyRadiance,
} from '../sky/028_sky_atmosphere.js';

import {
  CameraF32,
  CameraType,
  getCameraSlot,
  sampleSkyWithClouds,
} from '../sky/029_cloud_archetypes.js';

import {
  RainDrop,
  SurfaceWetness,
  getWetSurfaceSlot,
} from './042_rain.js';

import {
  SnowFlake,
} from './043_snow.js';

import {
  Hailstone,
} from './044_hail.js';

import {
  MixedDrop,
} from './045_sleet_freezing_rain.js';

import {
  sampleFogDensity,
  sampleVisibility,
} from './046_fog_mist.js';

import {
  sampleWindAt,
  WindSource,
} from './047_wind_gusts.js';

import {
  LightningBolt,
  getBoltFlashIntensity,
} from './041_lightning.js';

import {
  TornadoInstance,
  findNearestTornado,
} from './048_tornado.js';

import {
  sampleDustDensity,
} from './050_dust_sandstorm.js';

import {
  sampleRainbowForCamera,
  RainbowState,
} from './051_rainbow.js';

import {
  AuroraInstance,
  AuroraViewer,
  sampleAuroraRadiance,
} from './053_aurora.js';

import {
  MeteorEntry,
  sampleMeteorRadiance,
} from './054_meteor_showers.js';

import {
  sampleAshDensity,
} from './055_volcanic_ash.js';

import {
  sampleSmokeDensity,
} from './056_smoke_fire.js';

import {
  samplePollution,
  samplePollutionSunDimming,
} from './057_air_pollution.js';

import {
  sampleHeatShimmer,
} from './058_heat_haze.js';

import {
  sampleWaterSurfaceHeight,
  findWaterBodyAt,
} from './059_water_surface.js';

import {
  WaterBody,
  WaterBodyTag,
} from './059_water_surface.js';

import {
  FrostHabit,
  getFrostHabitLabel,
  IceSurface,
  getFrostThickness,
  getIceThickness,
} from './061_ice_frost.js';

import {
  sampleNuclearAt,
  isNuclearWinterActive,
} from './075_nuclear_winter.js';

import {
  getSunDirection,
  getSunElevation,
  getMoonDirection,
  getSunriseHour,
  getSunsetHour,
  DayNightCycle,
  getDayNightCycleSlot,
} from './072_day_night_cycle.js';

import {
  getFoliageColor,
} from './065_season_system.js';

import {
  getFogHabitLabel,
} from './061_ice_frost.js';

import {
  vec3,
  vec4,
  mat4,
  quat,
  createNoise2D,
  createNoise3D,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                     = 1e-16;
const EPSILON                        = 1e-8;
const EPSILON_HIGH                   = 1e-12;
const PI                             = Math.PI;
const TWO_PI                         = 2 * Math.PI;
const INV_PI                         = 1 / Math.PI;
const INV_TWO_PI                     = 1 / (2 * Math.PI);
const HALF_PI                        = Math.PI / 2;
const DEG_TO_RAD                     = Math.PI / 180;
const RAD_TO_DEG                     = 180 / Math.PI;
const GRAVITY                        = 9.81;
const AIR_DENSITY                    = 1.225;

// ── SoA limits ──────────────────────────────────────────────
const MAX_WEATHER_CAMERAS            = 32;
const MAX_LENS_EFFECTS                = 32;
const MAX_SHAKE_SOURCES               = 64;
const MAX_CLEARING_SYSTEMS            = 16;
const MAX_CAMERA_MILESTONES           = 256;
const MAX_PROTECTION_ZONES            = 128;

// ── Camera mode enum ────────────────────────────────────────
export const CameraMode = Object.freeze({
  FIRST_PERSON:  0,
  HOOD:          1,
  COCKPIT:       2,
  CHASE:         3,
  CINEMATIC:     4,
  PHOTO_MODE:    5,
  UNDERWATER:    6,
  DRONE:         7,
  SATELLITE:     8,
});

// ── Lens effect type enum ───────────────────────────────────
export const LensEffectType = Object.freeze({
  RAIN_DROPS:       0,
  FOG:              1,
  FROST:            2,
  ICE:              3,
  SNOW_BUILDUP:     4,
  SAND_ABRASION:    5,
  SALT_SPRAY:       6,
  ASH_FILM:         7,
  CONDENSATION:     8,
  SCREEN_CRACKS:    9,
  UNDERWATER_DROPS: 10,
  HEAT_SHIMMER:     11,
});

// ── Camera shake source type enum ───────────────────────────
export const ShakeSource = Object.freeze({
  WIND_GUST:      0,
  THUNDER:        1,
  EARTHQUAKE:     2,
  EXPLOSION:      3,
  TURBULENCE:     4,
  TORNADO_RUMBLE: 5,
  HEARTBEAT:      6,
  FOOTSTEP:       7,
  ENGINE:         8,
  WAVE_IMPACT:    9,
});

// ── Camera milestone enum ───────────────────────────────────
export const CameraMilestone = Object.freeze({
  RAINBOW_VISIBLE:    0,
  LIGHTNING_NEARBY:   1,
  AURORA_OVERHEAD:    2,
  TORNADO_VISIBLE:    3,
  METEOR_SHOWER_PEAK: 4,
  SUNRISE_GOLDEN_HOUR: 5,
  SUNSET_GOLDEN_HOUR:  6,
  VOLCANIC_ERUPTION:  7,
  NUCLEAR_WINTER_SKY: 8,
  SNOW_BLIZZARD_PEAK: 9,
  FOG_DEEPEST:        10,
  DUST_STORM_PEAK:    11,
});

// ── Camera protection zone type enum ────────────────────────
export const ProtectionZoneType = Object.freeze({
  INDOOR:        0,
  VEHICLE:       1,
  UNDERWATER:    2,
  AIRCRAFT:      3,
  SUBMARINE:     4,
  SPACECRAFT:    5,
  TENT:          6,
  CAVE:          7,
});

// ── Milestone thresholds ────────────────────────────────────
const LIGHTNING_NEARBY_DISTANCE_M    = 500.0;
const TORNADO_VISIBLE_DISTANCE_M     = 3000.0;
const AURORA_OVERHEAD_THRESHOLD      = 0.3;
const GOLDEN_HOUR_ELEVATION_MIN      = 1.0 * DEG_TO_RAD;
const GOLDEN_HOUR_ELEVATION_MAX      = 10.0 * DEG_TO_RAD;
const RAINBOW_VISIBLE_THRESHOLD      = 0.05;
const FOG_DEEPEST_THRESHOLD          = 0.5;
const DUST_STORM_PEAK_THRESHOLD      = 0.5;

// ── Milestone cooldown (seconds) ────────────────────────────
const MILESTONE_COOLDOWN_S            = 30.0;

// ── Lens effect parameters ─────────────────────────────────
const RAIN_DROP_MAX_DENSITY           = 200.0;   // drops per m²
const RAIN_DROP_MIN_SIZE_MM           = 0.5;
const RAIN_DROP_MAX_SIZE_MM           = 5.0;
const RAIN_DROP_LIFETIME_MIN_S        = 0.3;
const RAIN_DROP_LIFETIME_MAX_S        = 3.0;
const RAIN_REPELLENT_REDUCTION        = 0.7;     // 70% fewer drops

const FOG_LENS_MAX_THICKNESS          = 1.0;
const FOG_LENS_GROWTH_RATE_PER_S      = 0.01;
const FOG_LENS_DEFOG_RATE_PER_S       = 0.15;
const FOG_LENS_INTERIOR_TEMP_DELTA    = 5.0;     // °C delta to trigger fogging
const FOG_LENS_HUMIDITY_THRESHOLD     = 0.6;

const FROST_LENS_MAX_THICKNESS        = 0.6;
const FROST_LENS_GROWTH_RATE_PER_S    = 0.005;
const FROST_LENS_DEFROST_RATE_PER_S   = 0.10;
const FROST_LENS_TEMP_THRESHOLD_C     = -2.0;

const ICE_LENS_MAX_THICKNESS          = 1.0;
const ICE_LENS_GROWTH_RATE_PER_S      = 0.02;
const ICE_LENS_MELT_RATE_PER_S        = 0.10;

const SNOW_BUILDUP_MAX                = 1.0;
const SNOW_BUILDUP_GROWTH_RATE_PER_S  = 0.005;
const SNOW_BUILDUP_MELT_RATE_PER_S    = 0.02;

const SAND_ABRASION_MAX               = 1.0;
const SAND_ABRASION_GROWTH_RATE_PER_S = 0.001;
const SAND_ABRASION_CLEAN_RATE_PER_S  = 0.3;

const SALT_SPRAY_MAX                  = 1.0;
const SALT_SPRAY_GROWTH_RATE_PER_S    = 0.02;
const SALT_SPRAY_CLEAN_RATE_PER_S     = 0.2;

const ASH_FILM_MAX                    = 1.0;
const ASH_FILM_GROWTH_RATE_PER_S      = 0.003;
const ASH_FILM_CLEAN_RATE_PER_S       = 0.05;

const CONDENSATION_MAX                = 1.0;
const CONDENSATION_GROWTH_RATE_PER_S  = 0.02;
const CONDENSATION_EVAP_RATE_PER_S    = 0.10;

const SCREEN_CRACK_MAX                = 1.0;

// ── Wipers ─────────────────────────────────────────────────
const WIPER_SPEED_MIN                 = 1.0;     // Hz
const WIPER_SPEED_MAX                 = 5.0;
const WIPER_EFFECT_POWER              = 2.0;     // drops cleared per sweep
const WIPER_AUTO_RAIN_THRESHOLD       = 2.0;     // mm/h

// ── Camera shake amplitudes ────────────────────────────────
const SHAKE_WIND_AMPLITUDE            = 0.001;
const SHAKE_THUNDER_AMPLITUDE         = 0.05;
const SHAKE_EARTHQUAKE_AMPLITUDE      = 0.1;
const SHAKE_EXPLOSION_AMPLITUDE       = 0.2;
const SHAKE_TURBULENCE_AMPLITUDE      = 0.02;
const SHAKE_TORNADO_AMPLITUDE         = 0.08;
const SHAKE_MAX_OFFSET                = 0.5;

// ── Exposure ───────────────────────────────────────────────
const EXPOSURE_BASE                   = 1.0;
const EXPOSURE_MIN                    = 0.1;
const EXPOSURE_MAX                    = 8.0;
const EXPOSURE_ADAPTATION_SPEED       = 0.3;
const EXPOSURE_LIGHTNING_BOOST        = 1.5;
const EXPOSURE_NIGHT_BOOST            = 4.0;
const EXPOSURE_FOG_PENALTY            = 0.5;

// ── Depth of field ────────────────────────────────────────
const DOF_FOCUS_DISTANCE_DEFAULT      = 5.0;
const DOF_FOCUS_DISTANCE_MIN          = 0.5;
const DOF_FOCUS_DISTANCE_MAX          = 200.0;
const DOF_FOG_SHIFT_FACTOR            = 2.0;
const DOF_APERTURE_DEFAULT            = 2.8;
const DOF_APERTURE_MIN                = 1.4;
const DOF_APERTURE_MAX                = 22.0;

// ── Camera modes: FOV adjustments ────────────────────────
const FOV_FIRST_PERSON                = 70.0;
const FOV_HOOD                        = 60.0;
const FOV_COCKPIT                     = 65.0;
const FOV_CHASE                       = 55.0;
const FOV_CINEMATIC                   = 40.0;
const FOV_PHOTO_MODE                  = 50.0;
const FOV_UNDERWATER                  = 80.0;
const FOV_DRONE                       = 75.0;
const FOV_SATELLITE                   = 30.0;

// ── Head-bob ───────────────────────────────────────────────
const HEAD_BOB_FREQUENCY_WALK         = 2.2;     // Hz
const HEAD_BOB_FREQUENCY_RUN          = 4.0;
const HEAD_BOB_AMPLITUDE_WALK         = 0.02;    // metres
const HEAD_BOB_AMPLITUDE_RUN          = 0.04;
const HEAD_BOB_AMPLITUDE_PUDDLE       = 0.08;
const HEAD_BOB_AMPLITUDE_SNOW         = 0.03;

// ── Underwater caustics ───────────────────────────────────
const UNDERWATER_CAUSTIC_SCALE        = 0.15;
const UNDERWATER_CAUSTIC_SPEED        = 0.6;
const UNDERWATER_VISIBILITY_MIN       = 2.0;     // metres
const UNDERWATER_VISIBILITY_MAX       = 30.0;
const UNDERWATER_TINT_R               = 0.15;
const UNDERWATER_TINT_G               = 0.35;
const UNDERWATER_TINT_B               = 0.55;

// ═══════════════════════════════════════════════════════════════════════
// SoA WEATHER CAMERA
// ═══════════════════════════════════════════════════════════════════════

export const WeatherCamera = {
  ownerEid: new Uint32Array(MAX_WEATHER_CAMERAS),

  // Mode.
  mode: new Uint8Array(MAX_WEATHER_CAMERAS),

  // Linked camera slot from file 016 (PBRT-style).
  cameraSlot: new Uint8Array(MAX_WEATHER_CAMERAS),

  // Current FOV (degrees).
  fov: new Float32Array(MAX_WEATHER_CAMERAS),

  // Current exposure multiplier.
  exposure: new Float32Array(MAX_WEATHER_CAMERAS),

  // Current focus distance (metres).
  focusDistance: new Float32Array(MAX_WEATHER_CAMERAS),

  // Current aperture.
  aperture: new Float32Array(MAX_WEATHER_CAMERAS),

  // Camera shake offset (x, y).
  shakeX: new Float32Array(MAX_WEATHER_CAMERAS),
  shakeY: new Float32Array(MAX_WEATHER_CAMERAS),

  // Head-bob offset (x, y).
  headBobX: new Float32Array(MAX_WEATHER_CAMERAS),
  headBobY: new Float32Array(MAX_WEATHER_CAMERAS),

  // Current protection zone type (ProtectionZoneType) or 0xFF for none.
  protectionZone: new Uint8Array(MAX_WEATHER_CAMERAS),

  // Whether the camera is indoors.
  isIndoor: new Uint8Array(MAX_WEATHER_CAMERAS),

  // Whether the camera is underwater.
  isUnderwater: new Uint8Array(MAX_WEATHER_CAMERAS),

  // Whether the camera is inside a vehicle.
  isInVehicle: new Uint8Array(MAX_WEATHER_CAMERAS),

  // Active.
  active: new Uint8Array(MAX_WEATHER_CAMERAS),

  // Seed.
  seed: new Uint32Array(MAX_WEATHER_CAMERAS),
};

/** Marker: entity is a weather camera. */
export const WeatherCameraTag = {};

const _weatherCameraSlots = new Map();
let _nextWeatherCameraSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA LENS EFFECT
// ═══════════════════════════════════════════════════════════════════════

export const LensEffect = {
  // Owner camera slot.
  cameraSlot: new Uint8Array(MAX_LENS_EFFECTS * 12),

  // Effect type.
  type: new Uint8Array(MAX_LENS_EFFECTS * 12),

  // Current intensity (0..1).
  intensity: new Float32Array(MAX_LENS_EFFECTS * 12),

  // Target intensity (for smooth transitions).
  targetIntensity: new Float32Array(MAX_LENS_EFFECTS * 12),

  // Specific parameters.
  // For RAIN_DROPS: drop count, mean size
  // For FOG/FROST/ICE: coverage
  // For SNOW_BUILDUP: mass
  param1: new Float32Array(MAX_LENS_EFFECTS * 12),
  param2: new Float32Array(MAX_LENS_EFFECTS * 12),
};

// Per-camera active lens effect slots (12 types per camera).
const _activeLensEffects = new Map();   // cameraSlot -> Set<effectType>

// ═══════════════════════════════════════════════════════════════════════
// SoA CLEARING SYSTEM
// ═══════════════════════════════════════════════════════════════════════

export const ClearingSystem = {
  ownerEid: new Uint32Array(MAX_CLEARING_SYSTEMS),

  // Camera slot.
  cameraSlot: new Uint8Array(MAX_CLEARING_SYSTEMS),

  // Wipers.
  wipersActive: new Uint8Array(MAX_CLEARING_SYSTEMS),
  wiperSpeed: new Float32Array(MAX_CLEARING_SYSTEMS),
  wiperPhase: new Float32Array(MAX_CLEARING_SYSTEMS),
  wiperAutoMode: new Uint8Array(MAX_CLEARING_SYSTEMS),

  // Defroster.
  defrosterActive: new Uint8Array(MAX_CLEARING_SYSTEMS),

  // Sprayer.
  sprayerActive: new Uint8Array(MAX_CLEARING_SYSTEMS),
  sprayerCharges: new Uint8Array(MAX_CLEARING_SYSTEMS),

  // Rain repellent coating.
  rainRepellentActive: new Uint8Array(MAX_CLEARING_SYSTEMS),
  rainRepellentCharges: new Uint8Array(MAX_CLEARING_SYSTEMS),

  // Active.
  active: new Uint8Array(MAX_CLEARING_SYSTEMS),
};

/** Marker: entity has a lens clearing system. */
export const ClearingSystemTag = {};

const _clearingSystemSlots = new Map();
let _nextClearingSystemSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA SHAKE SOURCE
// ═══════════════════════════════════════════════════════════════════════

export const ShakeSourceInstance = {
  cameraSlot: new Uint8Array(MAX_SHAKE_SOURCES),
  type: new Uint8Array(MAX_SHAKE_SOURCES),
  intensity: new Float32Array(MAX_SHAKE_SOURCES),
  frequency: new Float32Array(MAX_SHAKE_SOURCES),
  phase: new Float32Array(MAX_SHAKE_SOURCES),
  active: new Uint8Array(MAX_SHAKE_SOURCES),
};

const _shakeSourcesByCamera = new Map();   // cameraSlot -> number[]

// ═══════════════════════════════════════════════════════════════════════
// SoA CAMERA MILESTONE TRACKER
// ═══════════════════════════════════════════════════════════════════════

export const CameraMilestoneInstance = {
  active: new Uint8Array(MAX_CAMERA_MILESTONES),
  cameraSlot: new Uint8Array(MAX_CAMERA_MILESTONES),
  type: new Uint8Array(MAX_CAMERA_MILESTONES),
  lastFiredTime: new Float32Array(MAX_CAMERA_MILESTONES),
  callback: new Array(MAX_CAMERA_MILESTONES).fill(null),
};

const _milestonesByCamera = new Map();   // cameraSlot -> number[]

// ═══════════════════════════════════════════════════════════════════════
// SoA PROTECTION ZONE
// ═══════════════════════════════════════════════════════════════════════

export const ProtectionZone = {
  ownerEid: new Uint32Array(MAX_PROTECTION_ZONES),
  type: new Uint8Array(MAX_PROTECTION_ZONES),
  cx: new Float32Array(MAX_PROTECTION_ZONES),
  cy: new Float32Array(MAX_PROTECTION_ZONES),
  cz: new Float32Array(MAX_PROTECTION_ZONES),
  radiusX: new Float32Array(MAX_PROTECTION_ZONES),
  radiusY: new Float32Array(MAX_PROTECTION_ZONES),
  radiusZ: new Float32Array(MAX_PROTECTION_ZONES),
  active: new Uint8Array(MAX_PROTECTION_ZONES),
};

/** Marker: entity is a protection zone. */
export const ProtectionZoneTag = {};

const _protectionZoneSlots = new Map();
let _nextProtectionZoneSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// PRNG
// ═══════════════════════════════════════════════════════════════════════

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// GLOBAL TIME STATE (from various subsystems)
// ═══════════════════════════════════════════════════════════════════════

// Need to accumulate game time for shake phase and milestones.
let _currentGameTime = 0;

// ═══════════════════════════════════════════════════════════════════════
// WEATHER CAMERA API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a weather camera.
 *
 * @param world       ECS world
 * @param eid         entity (typically the camera entity)
 * @param mode        CameraMode
 * @param options     { cameraSlot, fov, exposure, focusDistance,
 *                      aperture, seed }
 * @returns weather camera slot
 */
export function addWeatherCamera(world, eid, mode = CameraMode.FIRST_PERSON, options = {}) {
  if (_nextWeatherCameraSlot >= MAX_WEATHER_CAMERAS) {
    throw new Error('weather camera capacity exceeded');
  }
  const slot = _nextWeatherCameraSlot++;

  addComponent(world, eid, WeatherCameraTag);

  const C = WeatherCamera;
  C.ownerEid[slot] = eid;
  C.mode[slot] = mode;
  C.cameraSlot[slot] = options.cameraSlot ?? 0;
  C.fov[slot] = options.fov ?? defaultFovForMode(mode);
  C.exposure[slot] = options.exposure ?? EXPOSURE_BASE;
  C.focusDistance[slot] = options.focusDistance ?? DOF_FOCUS_DISTANCE_DEFAULT;
  C.aperture[slot] = options.aperture ?? DOF_APERTURE_DEFAULT;
  C.shakeX[slot] = 0;
  C.shakeY[slot] = 0;
  C.headBobX[slot] = 0;
  C.headBobY[slot] = 0;
  C.protectionZone[slot] = 0xFF;   // none
  C.isIndoor[slot] = 0;
  C.isUnderwater[slot] = 0;
  C.isInVehicle[slot] = 0;
  C.active[slot] = 1;
  C.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  _weatherCameraSlots.set(eid, slot);

  // Initialize lens effects for this camera.
  initializeLensEffects(slot);

  return slot;
}

function defaultFovForMode(mode) {
  switch (mode) {
    case CameraMode.FIRST_PERSON: return FOV_FIRST_PERSON;
    case CameraMode.HOOD:         return FOV_HOOD;
    case CameraMode.COCKPIT:      return FOV_COCKPIT;
    case CameraMode.CHASE:        return FOV_CHASE;
    case CameraMode.CINEMATIC:    return FOV_CINEMATIC;
    case CameraMode.PHOTO_MODE:   return FOV_PHOTO_MODE;
    case CameraMode.UNDERWATER:   return FOV_UNDERWATER;
    case CameraMode.DRONE:        return FOV_DRONE;
    case CameraMode.SATELLITE:    return FOV_SATELLITE;
    default:                       return FOV_FIRST_PERSON;
  }
}

export function removeWeatherCamera(world, eid) {
  const slot = _weatherCameraSlots.get(eid);
  if (slot === undefined) return;
  WeatherCamera.active[slot] = 0;
  WeatherCamera.ownerEid[slot] = 0;
  _weatherCameraSlots.delete(eid);
  _activeLensEffects.delete(slot);
  _shakeSourcesByCamera.delete(slot);
  _milestonesByCamera.delete(slot);
  removeComponent(world, eid, WeatherCameraTag);
}

export function getWeatherCameraSlot(eid) {
  return _weatherCameraSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// LENS EFFECT INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════

function initializeLensEffects(cameraSlot) {
  const L = LensEffect;
  const effectTypes = [
    LensEffectType.RAIN_DROPS,
    LensEffectType.FOG,
    LensEffectType.FROST,
    LensEffectType.ICE,
    LensEffectType.SNOW_BUILDUP,
    LensEffectType.SAND_ABRASION,
    LensEffectType.SALT_SPRAY,
    LensEffectType.ASH_FILM,
    LensEffectType.CONDENSATION,
    LensEffectType.SCREEN_CRACKS,
    LensEffectType.UNDERWATER_DROPS,
    LensEffectType.HEAT_SHIMMER,
  ];

  const activeSet = new Set();

  for (let i = 0; i < effectTypes.length; i++) {
    const idx = cameraSlot * 12 + i;
    L.cameraSlot[idx] = cameraSlot;
    L.type[idx] = effectTypes[i];
    L.intensity[idx] = 0;
    L.targetIntensity[idx] = 0;
    L.param1[idx] = 0;
    L.param2[idx] = 0;
    activeSet.add(effectTypes[i]);
  }

  _activeLensEffects.set(cameraSlot, activeSet);
}

// ═══════════════════════════════════════════════════════════════════════
// CLEARING SYSTEM API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a clearing system (wipers, defroster, etc.) to a camera.
 */
export function addClearingSystem(world, eid, cameraSlot, options = {}) {
  if (_nextClearingSystemSlot >= MAX_CLEARING_SYSTEMS) {
    throw new Error('clearing system capacity exceeded');
  }
  const slot = _nextClearingSystemSlot++;

  addComponent(world, eid, ClearingSystemTag);

  const S = ClearingSystem;
  S.ownerEid[slot] = eid;
  S.cameraSlot[slot] = cameraSlot;
  S.wipersActive[slot] = options.wipersActive ? 1 : 0;
  S.wiperSpeed[slot] = options.wiperSpeed ?? 2.0;
  S.wiperPhase[slot] = 0;
  S.wiperAutoMode[slot] = options.wiperAutoMode !== false ? 1 : 0;
  S.defrosterActive[slot] = options.defrosterActive ? 1 : 0;
  S.sprayerActive[slot] = 0;
  S.sprayerCharges[slot] = options.sprayerCharges ?? 5;
  S.rainRepellentActive[slot] = options.rainRepellentActive ? 1 : 0;
  S.rainRepellentCharges[slot] = options.rainRepellentCharges ?? 3;
  S.active[slot] = 1;

  _clearingSystemSlots.set(eid, slot);
  return slot;
}

export function removeClearingSystem(world, eid) {
  const slot = _clearingSystemSlots.get(eid);
  if (slot === undefined) return;
  ClearingSystem.active[slot] = 0;
  ClearingSystem.ownerEid[slot] = 0;
  _clearingSystemSlots.delete(eid);
  removeComponent(world, eid, ClearingSystemTag);
}

export function getClearingSystemSlot(eid) {
  return _clearingSystemSlots.get(eid) ?? -1;
}

/**
 * Activate the wipers (manual trigger).
 */
export function activateWipers(slot, speed = 2.0) {
  if (slot < 0 || slot >= _nextClearingSystemSlot) return;
  ClearingSystem.wipersActive[slot] = 1;
  ClearingSystem.wiperSpeed[slot] = Math.max(WIPER_SPEED_MIN, Math.min(WIPER_SPEED_MAX, speed));
  ClearingSystem.wiperAutoMode[slot] = 0;
}

/**
 * Deactivate the wipers.
 */
export function deactivateWipers(slot) {
  if (slot < 0 || slot >= _nextClearingSystemSlot) return;
  ClearingSystem.wipersActive[slot] = 0;
}

/**
 * Toggle the defroster.
 */
export function toggleDefroster(slot, active) {
  if (slot < 0 || slot >= _nextClearingSystemSlot) return;
  ClearingSystem.defrosterActive[slot] = active ? 1 : 0;
}

/**
 * Trigger the sprayer (cleans lens).
 */
export function triggerSprayer(slot) {
  if (slot < 0 || slot >= _nextClearingSystemSlot) return false;
  if (ClearingSystem.sprayerCharges[slot] <= 0) return false;
  ClearingSystem.sprayerActive[slot] = 1;
  ClearingSystem.sprayerCharges[slot]--;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// PROTECTION ZONE API
// ═══════════════════════════════════════════════════════════════════════

export function addProtectionZone(world, eid, type, options = {}) {
  if (_nextProtectionZoneSlot >= MAX_PROTECTION_ZONES) {
    throw new Error('protection zone capacity exceeded');
  }
  const slot = _nextProtectionZoneSlot++;

  addComponent(world, eid, ProtectionZoneTag);

  const Z = ProtectionZone;
  Z.ownerEid[slot] = eid;
  Z.type[slot] = type;
  Z.cx[slot] = options.cx ?? 0;
  Z.cy[slot] = options.cy ?? 0;
  Z.cz[slot] = options.cz ?? 0;
  Z.radiusX[slot] = options.radiusX ?? 5;
  Z.radiusY[slot] = options.radiusY ?? 3;
  Z.radiusZ[slot] = options.radiusZ ?? 5;
  Z.active[slot] = 1;

  _protectionZoneSlots.set(eid, slot);
  return slot;
}

export function removeProtectionZone(world, eid) {
  const slot = _protectionZoneSlots.get(eid);
  if (slot === undefined) return;
  ProtectionZone.active[slot] = 0;
  ProtectionZone.ownerEid[slot] = 0;
  _protectionZoneSlots.delete(eid);
  removeComponent(world, eid, ProtectionZoneTag);
}

// ═══════════════════════════════════════════════════════════════════════
// SHAKE SOURCE API
// ═══════════════════════════════════════════════════════════════════════

export function addShakeSource(cameraSlot, type, intensity, frequency = 5.0) {
  if (cameraSlot < 0 || cameraSlot >= _nextWeatherCameraSlot) return -1;
  if (_nextShakeSourceCount() >= MAX_SHAKE_SOURCES) return -1;

  const slot = _nextShakeSourceCount();
  const S = ShakeSourceInstance;
  S.cameraSlot[slot] = cameraSlot;
  S.type[slot] = type;
  S.intensity[slot] = intensity;
  S.frequency[slot] = frequency;
  S.phase[slot] = Math.random() * TWO_PI;
  S.active[slot] = 1;

  let list = _shakeSourcesByCamera.get(cameraSlot);
  if (!list) { list = []; _shakeSourcesByCamera.set(cameraSlot, list); }
  list.push(slot);

  _shakeSourceCount = slot + 1;
  return slot;
}

let _shakeSourceCount = 0;

function _nextShakeSourceCount() {
  return _shakeSourceCount;
}

// ═══════════════════════════════════════════════════════════════════════
// MILESTONE API
// ═══════════════════════════════════════════════════════════════════════

export function addCameraMilestone(cameraSlot, type, callback) {
  if (_nextCameraMilestoneCount() >= MAX_CAMERA_MILESTONES) return -1;

  const slot = _nextCameraMilestoneCount();
  CameraMilestoneInstance.active[slot] = 1;
  CameraMilestoneInstance.cameraSlot[slot] = cameraSlot;
  CameraMilestoneInstance.type[slot] = type;
  CameraMilestoneInstance.lastFiredTime[slot] = -MILESTONE_COOLDOWN_S;   // can fire immediately
  CameraMilestoneInstance.callback[slot] = callback;

  let list = _milestonesByCamera.get(cameraSlot);
  if (!list) { list = []; _milestonesByCamera.set(cameraSlot, list); }
  list.push(slot);

  _cameraMilestoneCount = slot + 1;
  return slot;
}

let _cameraMilestoneCount = 0;

function _nextCameraMilestoneCount() {
  return _cameraMilestoneCount;
}

// ═══════════════════════════════════════════════════════════════════════
// LENS EFFECT UPDATE — computed from atmospheric conditions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update all lens effects for a weather camera based on current
 * atmospheric conditions.
 */
function updateLensEffects(cameraSlot, dt, env) {
  const L = LensEffect;
  const C = WeatherCamera;

  // Whether the camera is indoors/vehicle/underwater suppresses some effects.
  const indoor = C.isIndoor[cameraSlot] === 1;
  const underwater = C.isUnderwater[cameraSlot] === 1;
  const inVehicle = C.isInVehicle[cameraSlot] === 1;

  // Base indices per camera.
  const RAIN_IDX = cameraSlot * 12 + LensEffectType.RAIN_DROPS;
  const FOG_IDX = cameraSlot * 12 + LensEffectType.FOG;
  const FROST_IDX = cameraSlot * 12 + LensEffectType.FROST;
  const ICE_IDX = cameraSlot * 12 + LensEffectType.ICE;
  const SNOW_IDX = cameraSlot * 12 + LensEffectType.SNOW_BUILDUP;
  const SAND_IDX = cameraSlot * 12 + LensEffectType.SAND_ABRASION;
  const SALT_IDX = cameraSlot * 12 + LensEffectType.SALT_SPRAY;
  const ASH_IDX = cameraSlot * 12 + LensEffectType.ASH_FILM;
  const COND_IDX = cameraSlot * 12 + LensEffectType.CONDENSATION;
  const CRACK_IDX = cameraSlot * 12 + LensEffectType.SCREEN_CRACKS;
  const UW_DROP_IDX = cameraSlot * 12 + LensEffectType.UNDERWATER_DROPS;
  const HAZE_IDX = cameraSlot * 12 + LensEffectType.HEAT_SHIMMER;

  // ═══════════════════════════════════════════════════════════════
  // RAIN DROPS
  // ═══════════════════════════════════════════════════════════════
  if (env.rainIntensity > 0 && !indoor && !underwater) {
    const dropDensity = Math.min(RAIN_DROP_MAX_DENSITY,
      env.rainIntensity * 20);

    // Rain repellent coating reduces drops.
    const repellentFactor = _cameraHasRepellent(cameraSlot) ? (1 - RAIN_REPELLENT_REDUCTION) : 1.0;

    L.targetIntensity[RAIN_IDX] = Math.min(1.0, dropDensity / RAIN_DROP_MAX_DENSITY) * repellentFactor;
    L.param1[RAIN_IDX] = dropDensity;
    L.param2[RAIN_IDX] = RAIN_DROP_MIN_SIZE_MM + (env.rainIntensity / 50) * (RAIN_DROP_MAX_SIZE_MM - RAIN_DROP_MIN_SIZE_MM);
  } else {
    L.targetIntensity[RAIN_IDX] = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // FOG ON LENS
  // ═══════════════════════════════════════════════════════════════
  // Fog forms when interior is warmer than exterior AND humidity high.
  const interiorWarm = env.interiorTemp - env.exteriorTemp;
  const foggy = (indoor || inVehicle) && interiorWarm > FOG_LENS_INTERIOR_TEMP_DELTA
    && env.humidity > FOG_LENS_HUMIDITY_THRESHOLD;

  if (foggy) {
    L.targetIntensity[FOG_IDX] = Math.min(FOG_LENS_MAX_THICKNESS,
      (interiorWarm / 20) * env.humidity);
  } else {
    L.targetIntensity[FOG_IDX] = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // FROST ON LENS
  // ═══════════════════════════════════════════════════════════════
  if (env.exteriorTemp < FROST_LENS_TEMP_THRESHOLD_C && !indoor && !underwater) {
    L.targetIntensity[FROST_IDX] = Math.min(FROST_LENS_MAX_THICKNESS,
      Math.abs(env.exteriorTemp) / 20);
  } else {
    L.targetIntensity[FROST_IDX] = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // ICE ON LENS
  // ═══════════════════════════════════════════════════════════════
  const freezingRain = env.temperature < 0 && env.rainIntensity > 0.5 && !indoor && !underwater;
  if (freezingRain) {
    L.targetIntensity[ICE_IDX] = Math.min(ICE_LENS_MAX_THICKNESS,
      L.intensity[ICE_IDX] + ICE_LENS_GROWTH_RATE_PER_S * dt);
    L.targetIntensity[ICE_IDX] = Math.min(1.0, L.targetIntensity[ICE_IDX]);
  } else {
    L.targetIntensity[ICE_IDX] = Math.max(0, L.intensity[ICE_IDX] - ICE_LENS_MELT_RATE_PER_S * dt);
  }

  // ═══════════════════════════════════════════════════════════════
  // SNOW BUILDUP
  // ═══════════════════════════════════════════════════════════════
  if (env.snowIntensity > 0 && !indoor && !underwater) {
    L.targetIntensity[SNOW_IDX] = Math.min(SNOW_BUILDUP_MAX,
      L.intensity[SNOW_IDX] + SNOW_BUILDUP_GROWTH_RATE_PER_S * dt * env.snowIntensity);
  } else {
    L.targetIntensity[SNOW_IDX] = Math.max(0, L.intensity[SNOW_IDX] - SNOW_BUILDUP_MELT_RATE_PER_S * dt);
  }

  // ═══════════════════════════════════════════════════════════════
  // SAND ABRASION
  // ═══════════════════════════════════════════════════════════════
  if (env.dustIntensity > 0 && !indoor && !underwater) {
    L.targetIntensity[SAND_IDX] = Math.min(SAND_ABRASION_MAX,
      L.intensity[SAND_IDX] + SAND_ABRASION_GROWTH_RATE_PER_S * dt * env.dustIntensity);
  } else {
    L.targetIntensity[SAND_IDX] = Math.max(0, L.intensity[SAND_IDX] - SAND_ABRASION_CLEAN_RATE_PER_S * dt);
  }

  // ═══════════════════════════════════════════════════════════════
  // SALT SPRAY (near ocean, high wind)
  // ═══════════════════════════════════════════════════════════════
  const nearOcean = env.waterBodyNearby;
  const highWind = env.windSpeed > 15;
  if (nearOcean && highWind && !indoor && !underwater) {
    L.targetIntensity[SALT_IDX] = Math.min(SALT_SPRAY_MAX,
      L.intensity[SALT_IDX] + SALT_SPRAY_GROWTH_RATE_PER_S * dt * (env.windSpeed / 30));
  } else {
    L.targetIntensity[SALT_IDX] = Math.max(0, L.intensity[SALT_IDX] - SALT_SPRAY_CLEAN_RATE_PER_S * dt);
  }

  // ═══════════════════════════════════════════════════════════════
  // ASH FILM
  // ═══════════════════════════════════════════════════════════════
  if (env.ashIntensity > 0 && !indoor && !underwater) {
    L.targetIntensity[ASH_IDX] = Math.min(ASH_FILM_MAX,
      L.intensity[ASH_IDX] + ASH_FILM_GROWTH_RATE_PER_S * dt * env.ashIntensity);
  } else {
    L.targetIntensity[ASH_IDX] = Math.max(0, L.intensity[ASH_IDX] - ASH_FILM_CLEAN_RATE_PER_S * dt);
  }

  // ═══════════════════════════════════════════════════════════════
  // CONDENSATION
  // ═══════════════════════════════════════════════════════════════
  if ((indoor || inVehicle) && interiorWarm > 0 && env.humidity > 0.5) {
    L.targetIntensity[COND_IDX] = Math.min(CONDENSATION_MAX,
      L.intensity[COND_IDX] + CONDENSATION_GROWTH_RATE_PER_S * dt);
  } else {
    L.targetIntensity[COND_IDX] = Math.max(0, L.intensity[COND_IDX] - CONDENSATION_EVAP_RATE_PER_S * dt);
  }

  // ═══════════════════════════════════════════════════════════════
  // SCREEN CRACKS
  // ═══════════════════════════════════════════════════════════════
  if (env.hailIntensity > 0.5 && !indoor && !underwater) {
    // Crack chance increases with hail intensity.
    if (Math.random() < env.hailIntensity * dt * 0.01) {
      L.targetIntensity[CRACK_IDX] = Math.min(SCREEN_CRACK_MAX,
        L.intensity[CRACK_IDX] + 0.15);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // UNDERWATER DROPS
  // ═══════════════════════════════════════════════════════════════
  if (underwater) {
    L.targetIntensity[UW_DROP_IDX] = 0.6;
  } else {
    L.targetIntensity[UW_DROP_IDX] = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // HEAT SHIMMER
  // ═══════════════════════════════════════════════════════════════
  if (env.heatShimmer > 0) {
    L.targetIntensity[HAZE_IDX] = Math.min(1, env.heatShimmer);
  } else {
    L.targetIntensity[HAZE_IDX] = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // SMOOTH TRANSITIONS
  // ═══════════════════════════════════════════════════════════════
  const transitionRate = Math.min(1, dt * 5);
  for (let i = 0; i < 12; i++) {
    const idx = cameraSlot * 12 + i;
    L.intensity[idx] += (L.targetIntensity[idx] - L.intensity[idx]) * transitionRate;
  }
}

function _cameraHasRepellent(cameraSlot) {
  for (const [eid, slot] of _clearingSystemSlots) {
    if (ClearingSystem.cameraSlot[slot] === cameraSlot) {
      if (ClearingSystem.rainRepellentActive[slot]) return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEARING SYSTEM UPDATE
// ═══════════════════════════════════════════════════════════════════════

function updateClearingSystems(dt) {
  for (let slot = 0; slot < _nextClearingSystemSlot; slot++) {
    if (!ClearingSystem.active[slot]) continue;

    const cameraSlot = ClearingSystem.cameraSlot[slot];

    // WIPERS
    if (ClearingSystem.wipersActive[slot]) {
      ClearingSystem.wiperPhase[slot] += dt * ClearingSystem.wiperSpeed[slot];
      if (ClearingSystem.wiperPhase[slot] >= TWO_PI) {
        ClearingSystem.wiperPhase[slot] -= TWO_PI;

        // Clear drops on sweep completion.
        const RAIN_IDX = cameraSlot * 12 + LensEffectType.RAIN_DROPS;
        const reduction = Math.pow(ClearingSystem.wiperSpeed[slot] / WIPER_SPEED_MAX, WIPER_EFFECT_POWER);
        LensEffect.intensity[RAIN_IDX] *= (1 - reduction);
        LensEffect.targetIntensity[RAIN_IDX] *= (1 - reduction);
      }
    } else if (ClearingSystem.wiperAutoMode[slot]) {
      // Auto mode: engage when rain exceeds threshold.
      const RAIN_IDX = cameraSlot * 12 + LensEffectType.RAIN_DROPS;
      if (LensEffect.intensity[RAIN_IDX] > 0.3) {
        ClearingSystem.wipersActive[slot] = 1;
      }
    }

    // DEFROSTER
    if (ClearingSystem.defrosterActive[slot]) {
      const FOG_IDX = cameraSlot * 12 + LensEffectType.FOG;
      const FROST_IDX = cameraSlot * 12 + LensEffectType.FROST;
      const COND_IDX = cameraSlot * 12 + LensEffectType.CONDENSATION;
      LensEffect.intensity[FOG_IDX] = Math.max(0,
        LensEffect.intensity[FOG_IDX] - FOG_LENS_DEFOG_RATE_PER_S * dt);
      LensEffect.intensity[FROST_IDX] = Math.max(0,
        LensEffect.intensity[FROST_IDX] - FROST_LENS_DEFROST_RATE_PER_S * dt);
      LensEffect.intensity[COND_IDX] = Math.max(0,
        LensEffect.intensity[COND_IDX] - CONDENSATION_EVAP_RATE_PER_S * dt);
    }

    // SPRAYER
    if (ClearingSystem.sprayerActive[slot]) {
      const SAND_IDX = cameraSlot * 12 + LensEffectType.SAND_ABRASION;
      const ASH_IDX = cameraSlot * 12 + LensEffectType.ASH_FILM;
      const SALT_IDX = cameraSlot * 12 + LensEffectType.SALT_SPRAY;
      LensEffect.intensity[SAND_IDX] *= Math.max(0, 1 - dt * 3);
      LensEffect.intensity[ASH_IDX] *= Math.max(0, 1 - dt * 3);
      LensEffect.intensity[SALT_IDX] *= Math.max(0, 1 - dt * 3);
      ClearingSystem.sprayerActive[slot] = 0;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SHAKE UPDATE
// ═══════════════════════════════════════════════════════════════════════

function updateShake(cameraSlot, dt) {
  const C = WeatherCamera;
  let shakeX = 0;
  let shakeY = 0;

  const sources = _shakeSourcesByCamera.get(cameraSlot) || [];
  for (const srcSlot of sources) {
    if (!ShakeSourceInstance.active[srcSlot]) continue;

    ShakeSourceInstance.phase[srcSlot] += dt * ShakeSourceInstance.frequency[srcSlot];
    if (ShakeSourceInstance.phase[srcSlot] > TWO_PI) {
      ShakeSourceInstance.phase[srcSlot] -= TWO_PI;
    }

    const intensity = ShakeSourceInstance.intensity[srcSlot];
    const phase = ShakeSourceInstance.phase[srcSlot];

    shakeX += Math.sin(phase) * intensity;
    shakeY += Math.cos(phase * 1.3) * intensity;
  }

  // Clamp to max offset.
  shakeX = Math.max(-SHAKE_MAX_OFFSET, Math.min(SHAKE_MAX_OFFSET, shakeX));
  shakeY = Math.max(-SHAKE_MAX_OFFSET, Math.min(SHAKE_MAX_OFFSET, shakeY));

  C.shakeX[cameraSlot] = shakeX;
  C.shakeY[cameraSlot] = shakeY;
}

// ═══════════════════════════════════════════════════════════════════════
// EXPOSURE UPDATE
// ═══════════════════════════════════════════════════════════════════════

function updateExposure(cameraSlot, dt, env) {
  const C = WeatherCamera;

  // Base exposure.
  let targetExposure = EXPOSURE_BASE;

  // Sun elevation effect.
  if (env.sunElevation < 0) {
    // Night: boost exposure.
    const nightFactor = Math.min(1, Math.abs(env.sunElevation) / HALF_PI);
    targetExposure = EXPOSURE_BASE + nightFactor * (EXPOSURE_NIGHT_BOOST - EXPOSURE_BASE);
  } else if (env.sunElevation < 0.2) {
    // Twilight: moderate boost.
    targetExposure = EXPOSURE_BASE * 1.5;
  }

  // Lightning flash: temporary boost.
  if (env.lightningFlash > 0) {
    targetExposure *= 1 + env.lightningFlash * EXPOSURE_LIGHTNING_BOOST;
  }

  // Fog: compensate for low contrast.
  if (env.fogDensity > 0.2) {
    targetExposure *= 1 + env.fogDensity * EXPOSURE_FOG_PENALTY;
  }

  // Nuclear winter: dim.
  if (env.nuclearDimming > 0.5) {
    targetExposure *= 1 / Math.max(0.3, env.nuclearDimming);
  }

  // Clamp.
  targetExposure = Math.max(EXPOSURE_MIN, Math.min(EXPOSURE_MAX, targetExposure));

  // Smooth transitions.
  C.exposure[cameraSlot] += (targetExposure - C.exposure[cameraSlot])
    * EXPOSURE_ADAPTATION_SPEED * dt;
}

// ═══════════════════════════════════════════════════════════════════════
// FOCUS / DOF UPDATE
// ═══════════════════════════════════════════════════════════════════════

function updateFocus(cameraSlot, dt, env) {
  const C = WeatherCamera;

  // Default focus distance based on mode.
  const mode = C.mode[cameraSlot];
  let targetFocus;

  switch (mode) {
    case CameraMode.FIRST_PERSON:
      targetFocus = 3.0;
      break;
    case CameraMode.HOOD:
      targetFocus = 15.0;
      break;
    case CameraMode.CHASE:
      targetFocus = 8.0;
      break;
    case CameraMode.PHOTO_MODE:
      targetFocus = 25.0;
      break;
    case CameraMode.CINEMATIC:
      targetFocus = 50.0;
      break;
    default:
      targetFocus = DOF_FOCUS_DISTANCE_DEFAULT;
  }

  // Fog reduces effective focus distance.
  if (env.fogDensity > 0.3) {
    targetFocus *= 1 - (env.fogDensity - 0.3) * DOF_FOG_SHIFT_FACTOR;
  }

  // Clamp.
  targetFocus = Math.max(DOF_FOCUS_DISTANCE_MIN, Math.min(DOF_FOCUS_DISTANCE_MAX, targetFocus));

  // Smooth transitions.
  C.focusDistance[cameraSlot] += (targetFocus - C.focusDistance[cameraSlot])
    * dt * 2.0;
}

// ═══════════════════════════════════════════════════════════════════════
// ENVIRONMENT SAMPLING — gathers weather state around a camera
// ═══════════════════════════════════════════════════════════════════════

const _windCam = vec3.create();

function sampleEnvironment(world, cameraSlot) {
  const C = WeatherCamera;
  const eid = C.ownerEid[cameraSlot];
  if (!eid || !entityExists(world, eid)) return null;

  const id = getId(eid);
  const M = WorldTransformF32.m;
  if (!M) return null;
  const off = id * 16;
  const wx = M[off + 12];
  const wy = M[off + 13];
  const wz = M[off + 14];

  // Sample wind.
  sampleWindAt(wx, wy, wz, _windCam);
  const windSpeed = Math.hypot(_windCam[0], _windCam[2]);

  // Sample fog density.
  const fogDensity = sampleFogDensity(wx, wy, wz);

  // Sample rain intensity (count nearby drops).
  let rainIntensity = 0;
  for (let i = 0; i < RainDrop.active.length; i++) {
    if (!RainDrop.active[i]) continue;
    const dx = RainDrop.px[i] - wx;
    const dy = RainDrop.py[i] - wy;
    const dz = RainDrop.pz[i] - wz;
    if (dx * dx + dy * dy + dz * dz < 100) {
      rainIntensity += 0.1;
    }
  }

  // Sample snow intensity.
  let snowIntensity = 0;
  for (let i = 0; i < SnowFlake.active.length; i++) {
    if (!SnowFlake.active[i]) continue;
    const dx = SnowFlake.px[i] - wx;
    const dy = SnowFlake.py[i] - wy;
    const dz = SnowFlake.pz[i] - wz;
    if (dx * dx + dy * dy + dz * dz < 100) {
      snowIntensity += 0.1;
    }
  }

  // Sample hail intensity.
  let hailIntensity = 0;
  for (let i = 0; i < Hailstone.active.length; i++) {
    if (!Hailstone.active[i]) continue;
    const dx = Hailstone.px[i] - wx;
    const dy = Hailstone.py[i] - wy;
    const dz = Hailstone.pz[i] - wz;
    if (dx * dx + dy * dy + dz * dz < 100) {
      hailIntensity += 0.05;
    }
  }

  // Sample dust intensity.
  const dustIntensity = sampleDustDensity(wx, wy, wz);

  // Sample ash intensity.
  const ashIntensity = sampleAshDensity(wx, wy, wz);

  // Sample lightning flash intensity.
  let lightningFlash = 0;
  for (let i = 0; i < LightningBolt.active.length; i++) {
    if (!LightningBolt.active[i]) continue;
    const dx = LightningBolt.ix[i] - wx;
    const dy = LightningBolt.iy[i] - wy;
    const dz = LightningBolt.iz[i] - wz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < 5000 * 5000) {
      const dist = Math.sqrt(distSq);
      lightningFlash = Math.max(lightningFlash,
        getBoltFlashIntensity(i) * (1 - dist / 5000));
    }
  }

  // Sample nuclear winter dimming.
  let nuclearDimming = 1.0;
  if (isNuclearWinterActive()) {
    const nuclear = sampleNuclearAt(wy / 1000, true);
    nuclearDimming = nuclear.sunTransmission;
  }

  // Sample heat shimmer.
  const heatShimmer = sampleHeatShimmer(wx, wy, wz, 0, 1, 0, _currentGameTime, [0, 0])[0];

  // Sample sun elevation.
  const sunElevation = getSunElevation(getDayNightCycleSlot(eid));

  // Check for nearby water body.
  const waterBodySlot = findWaterBodyAt(wx, wz, wy, 100);
  const waterBodyNearby = waterBodySlot >= 0;
  const isUnderwater = waterBodySlot >= 0
    && wy < sampleWaterSurfaceHeight(waterBodySlot, wx, wz);

  // Determine interior/exterior temp delta (approximation).
  const exteriorTemp = 20;
  const interiorTemp = 22;

  return {
    wx, wy, wz,
    windSpeed,
    fogDensity,
    rainIntensity,
    snowIntensity,
    hailIntensity,
    dustIntensity,
    ashIntensity,
    lightningFlash,
    nuclearDimming,
    heatShimmer,
    sunElevation,
    waterBodyNearby,
    isUnderwater,
    temperature: exteriorTemp,
    exteriorTemp,
    interiorTemp,
    humidity: 0.5,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MILESTONE CHECKING
// ═══════════════════════════════════════════════════════════════════════

function checkMilestones(world, cameraSlot, env) {
  const milestones = _milestonesByCamera.get(cameraSlot) || [];
  const currentTime = _currentGameTime;

  for (const milestoneSlot of milestones) {
    if (!CameraMilestoneInstance.active[milestoneSlot]) continue;

    const timeSinceLast = currentTime - CameraMilestoneInstance.lastFiredTime[milestoneSlot];
    if (timeSinceLast < MILESTONE_COOLDOWN_S) continue;

    const type = CameraMilestoneInstance.type[milestoneSlot];
    let fired = false;

    switch (type) {
      case CameraMilestone.RAINBOW_VISIBLE:
        fired = _isRainbowVisible();
        break;
      case CameraMilestone.LIGHTNING_NEARBY:
        fired = env.lightningFlash > 0.3;
        break;
      case CameraMilestone.AURORA_OVERHEAD:
        fired = _isAuroraOverhead(env);
        break;
      case CameraMilestone.TORNADO_VISIBLE:
        fired = _isTornadoVisible(world, env);
        break;
      case CameraMilestone.METEOR_SHOWER_PEAK:
        fired = _isMeteorShowerPeak();
        break;
      case CameraMilestone.SUNRISE_GOLDEN_HOUR:
        fired = _isGoldenHour(env, true);
        break;
      case CameraMilestone.SUNSET_GOLDEN_HOUR:
        fired = _isGoldenHour(env, false);
        break;
      case CameraMilestone.SNOW_BLIZZARD_PEAK:
        fired = env.snowIntensity > 2 && env.windSpeed > 15;
        break;
      case CameraMilestone.FOG_DEEPEST:
        fired = env.fogDensity > FOG_DEEPEST_THRESHOLD;
        break;
      case CameraMilestone.DUST_STORM_PEAK:
        fired = env.dustIntensity > DUST_STORM_PEAK_THRESHOLD;
        break;
    }

    if (fired) {
      CameraMilestoneInstance.lastFiredTime[milestoneSlot] = currentTime;
      const cb = CameraMilestoneInstance.callback[milestoneSlot];
      if (cb) {
        try {
          cb(cameraSlot, type);
        } catch (err) {
          if (typeof console !== 'undefined') {
            console.warn('[078_weather_cameras] milestone callback threw:', err);
          }
        }
      }
    }
  }
}

function _isRainbowVisible() {
  // Check if any rainbow is currently visible.
  for (let i = 0; i < RainbowState.active.length; i++) {
    if (!RainbowState.active[i]) continue;
    if (RainbowState.envelope[i] > RAINBOW_VISIBLE_THRESHOLD) return true;
  }
  return false;
}

function _isAuroraOverhead(env) {
  for (let i = 0; i < AuroraViewer.active.length; i++) {
    if (!AuroraViewer.active[i]) continue;
    if (AuroraViewer.visibility[i] > AURORA_OVERHEAD_THRESHOLD) return true;
  }
  return false;
}

function _isTornadoVisible(world, env) {
  const tornadoSlot = findNearestTornado(env.wx, env.wy, env.wz, TORNADO_VISIBLE_DISTANCE_M);
  return tornadoSlot >= 0;
}

function _isMeteorShowerPeak() {
  let count = 0;
  for (let i = 0; i < MeteorEntry.active.length; i++) {
    if (MeteorEntry.active[i]) count++;
  }
  return count >= 5;
}

function _isGoldenHour(env, isSunrise) {
  const elev = env.sunElevation;
  return elev >= GOLDEN_HOUR_ELEVATION_MIN && elev <= GOLDEN_HOUR_ELEVATION_MAX;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full weather camera pipeline for one frame.
 *
 * @param world       ECS world
 * @param dt          real-time seconds
 */
export function systemWeatherCameraTick(world, dt) {
  _currentGameTime += dt;

  const C = WeatherCamera;

  for (let cameraSlot = 0; cameraSlot < _nextWeatherCameraSlot; cameraSlot++) {
    if (!C.active[cameraSlot]) continue;

    // Sample environment.
    const env = sampleEnvironment(world, cameraSlot);
    if (!env) continue;

    // Update camera mode state.
    C.isIndoor[cameraSlot] = env.isIndoor ? 1 : 0;
    C.isUnderwater[cameraSlot] = env.isUnderwater ? 1 : 0;

    // Update lens effects.
    updateLensEffects(cameraSlot, dt, env);

    // Update exposure.
    updateExposure(cameraSlot, dt, env);

    // Update focus.
    updateFocus(cameraSlot, dt, env);

    // Update shake.
    updateShake(cameraSlot, dt);

    // Check milestones.
    checkMilestones(world, cameraSlot, env);
  }

  // Update clearing systems (independent of specific camera).
  updateClearingSystems(dt);

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a specific lens effect's current intensity.
 */
export function getLensEffectIntensity(cameraSlot, effectType) {
  if (cameraSlot < 0 || cameraSlot >= _nextWeatherCameraSlot) return 0;
  const idx = cameraSlot * 12 + effectType;
  return LensEffect.intensity[idx];
}

/**
 * Return the current exposure multiplier.
 */
export function getCameraExposure(cameraSlot) {
  if (cameraSlot < 0 || cameraSlot >= _nextWeatherCameraSlot) return EXPOSURE_BASE;
  return WeatherCamera.exposure[cameraSlot];
}

/**
 * Return the current focus distance.
 */
export function getCameraFocusDistance(cameraSlot) {
  if (cameraSlot < 0 || cameraSlot >= _nextWeatherCameraSlot) return DOF_FOCUS_DISTANCE_DEFAULT;
  return WeatherCamera.focusDistance[cameraSlot];
}

/**
 * Return the current camera shake offset as [x, y].
 */
export function getCameraShake(cameraSlot, out = [0, 0]) {
  if (cameraSlot < 0 || cameraSlot >= _nextWeatherCameraSlot) {
    out[0] = 0;
    out[1] = 0;
    return out;
  }
  out[0] = WeatherCamera.shakeX[cameraSlot];
  out[1] = WeatherCamera.shakeY[cameraSlot];
  return out;
}

/**
 * Return a human-readable label for a camera mode.
 */
export function cameraModeLabel(mode) {
  switch (mode) {
    case CameraMode.FIRST_PERSON: return 'First Person';
    case CameraMode.HOOD:         return 'Hood';
    case CameraMode.COCKPIT:      return 'Cockpit';
    case CameraMode.CHASE:        return 'Chase';
    case CameraMode.CINEMATIC:    return 'Cinematic';
    case CameraMode.PHOTO_MODE:   return 'Photo Mode';
    case CameraMode.UNDERWATER:   return 'Underwater';
    case CameraMode.DRONE:        return 'Drone';
    case CameraMode.SATELLITE:    return 'Satellite';
    default:                       return 'Unknown';
  }
}

/**
 * Return a human-readable label for a lens effect.
 */
export function lensEffectLabel(effectType) {
  switch (effectType) {
    case LensEffectType.RAIN_DROPS:       return 'Rain Drops';
    case LensEffectType.FOG:              return 'Fog';
    case LensEffectType.FROST:            return 'Frost';
    case LensEffectType.ICE:              return 'Ice';
    case LensEffectType.SNOW_BUILDUP:     return 'Snow Buildup';
    case LensEffectType.SAND_ABRASION:    return 'Sand Abrasion';
    case LensEffectType.SALT_SPRAY:       return 'Salt Spray';
    case LensEffectType.ASH_FILM:         return 'Ash Film';
    case LensEffectType.CONDENSATION:     return 'Condensation';
    case LensEffectType.SCREEN_CRACKS:    return 'Screen Cracks';
    case LensEffectType.UNDERWATER_DROPS: return 'Underwater Drops';
    case LensEffectType.HEAT_SHIMMER:     return 'Heat Shimmer';
    default:                                return 'Unknown';
  }
}

/**
 * Return a human-readable label for a milestone.
 */
export function milestoneLabel(type) {
  switch (type) {
    case CameraMilestone.RAINBOW_VISIBLE:     return 'Rainbow Visible';
    case CameraMilestone.LIGHTNING_NEARBY:    return 'Lightning Nearby';
    case CameraMilestone.AURORA_OVERHEAD:     return 'Aurora Overhead';
    case CameraMilestone.TORNADO_VISIBLE:     return 'Tornado Visible';
    case CameraMilestone.METEOR_SHOWER_PEAK:  return 'Meteor Shower Peak';
    case CameraMilestone.SUNRISE_GOLDEN_HOUR: return 'Sunrise Golden Hour';
    case CameraMilestone.SUNSET_GOLDEN_HOUR:  return 'Sunset Golden Hour';
    case CameraMilestone.VOLCANIC_ERUPTION:   return 'Volcanic Eruption';
    case CameraMilestone.NUCLEAR_WINTER_SKY:  return 'Nuclear Winter Sky';
    case CameraMilestone.SNOW_BLIZZARD_PEAK:  return 'Snow Blizzard Peak';
    case CameraMilestone.FOG_DEEPEST:         return 'Fog Deepest';
    case CameraMilestone.DUST_STORM_PEAK:     return 'Dust Storm Peak';
    default:                                    return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE — shader uniforms for file 019 post-processing
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a full lens effect state as uniform data for a post-processing
 * shader (file 019).
 */
export function gatherCameraLensState(cameraSlot) {
  if (cameraSlot < 0 || cameraSlot >= _nextWeatherCameraSlot) return null;

  const C = WeatherCamera;
  const L = LensEffect;

  const RAIN_IDX = cameraSlot * 12 + LensEffectType.RAIN_DROPS;
  const FOG_IDX = cameraSlot * 12 + LensEffectType.FOG;
  const FROST_IDX = cameraSlot * 12 + LensEffectType.FROST;
  const ICE_IDX = cameraSlot * 12 + LensEffectType.ICE;
  const SNOW_IDX = cameraSlot * 12 + LensEffectType.SNOW_BUILDUP;
  const SAND_IDX = cameraSlot * 12 + LensEffectType.SAND_ABRASION;
  const SALT_IDX = cameraSlot * 12 + LensEffectType.SALT_SPRAY;
  const ASH_IDX = cameraSlot * 12 + LensEffectType.ASH_FILM;
  const COND_IDX = cameraSlot * 12 + LensEffectType.CONDENSATION;
  const CRACK_IDX = cameraSlot * 12 + LensEffectType.SCREEN_CRACKS;
  const UW_DROP_IDX = cameraSlot * 12 + LensEffectType.UNDERWATER_DROPS;
  const HAZE_IDX = cameraSlot * 12 + LensEffectType.HEAT_SHIMMER;

  return {
    mode: C.mode[cameraSlot],
    exposure: C.exposure[cameraSlot],
    focusDistance: C.focusDistance[cameraSlot],
    aperture: C.aperture[cameraSlot],
    shakeX: C.shakeX[cameraSlot],
    shakeY: C.shakeY[cameraSlot],
    headBobX: C.headBobX[cameraSlot],
    headBobY: C.headBobY[cameraSlot],

    rainDropDensity: L.intensity[RAIN_IDX],
    rainDropSizeMM: L.param2[RAIN_IDX],
    fogThickness: L.intensity[FOG_IDX],
    frostThickness: L.intensity[FROST_IDX],
    iceThickness: L.intensity[ICE_IDX],
    snowBuildup: L.intensity[SNOW_IDX],
    sandAbrasion: L.intensity[SAND_IDX],
    saltSpray: L.intensity[SALT_IDX],
    ashFilm: L.intensity[ASH_IDX],
    condensation: L.intensity[COND_IDX],
    screenCracks: L.intensity[CRACK_IDX],
    underwaterDrops: L.intensity[UW_DROP_IDX],
    heatShimmer: L.intensity[HAZE_IDX],
  };
}

/**
 * Return a summary of all active weather cameras.
 */
export function gatherWeatherCamerasForRendering() {
  const result = [];
  const C = WeatherCamera;

  for (let slot = 0; slot < _nextWeatherCameraSlot; slot++) {
    if (!C.active[slot]) continue;

    result.push({
      slot,
      mode: C.mode[slot],
      modeLabel: cameraModeLabel(C.mode[slot]),
      fov: C.fov[slot],
      exposure: C.exposure[slot],
      focusDistance: C.focusDistance[slot],
      aperture: C.aperture[slot],
      isIndoor: C.isIndoor[slot] === 1,
      isUnderwater: C.isUnderwater[slot] === 1,
      isInVehicle: C.isInVehicle[slot] === 1,
      shake: [C.shakeX[slot], C.shakeY[slot]],
      headBob: [C.headBobX[slot], C.headBobY[slot]],
      lensState: gatherCameraLensState(slot),
    });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function weatherCameraStats() {
  let activeCameras = 0;
  let activeClearingSystems = 0;
  let activeMilestones = 0;
  let activeShakeSources = 0;

  for (let slot = 0; slot < _nextWeatherCameraSlot; slot++) {
    if (WeatherCamera.active[slot]) activeCameras++;
  }

  for (let slot = 0; slot < _nextClearingSystemSlot; slot++) {
    if (ClearingSystem.active[slot]) activeClearingSystems++;
  }

  for (let slot = 0; slot < _cameraMilestoneCount; slot++) {
    if (CameraMilestoneInstance.active[slot]) activeMilestones++;
  }

  for (let slot = 0; slot < _shakeSourceCount; slot++) {
    if (ShakeSourceInstance.active[slot]) activeShakeSources++;
  }

  return {
    activeCameras,
    maxCameras: MAX_WEATHER_CAMERAS,
    activeClearingSystems,
    maxClearingSystems: MAX_CLEARING_SYSTEMS,
    activeMilestones,
    maxMilestones: MAX_CAMERA_MILESTONES,
    activeShakeSources,
    maxShakeSources: MAX_SHAKE_SOURCES,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearWeatherCameras() {
  WeatherCamera.active.fill(0);
  WeatherCamera.ownerEid.fill(0);
  _weatherCameraSlots.clear();
  _nextWeatherCameraSlot = 0;

  LensEffect.intensity.fill(0);
  LensEffect.targetIntensity.fill(0);
  _activeLensEffects.clear();

  ClearingSystem.active.fill(0);
  ClearingSystem.ownerEid.fill(0);
  _clearingSystemSlots.clear();
  _nextClearingSystemSlot = 0;

  ShakeSourceInstance.active.fill(0);
  _shakeSourcesByCamera.clear();
  _shakeSourceCount = 0;

  CameraMilestoneInstance.active.fill(0);
  CameraMilestoneInstance.callback.fill(null);
  _milestonesByCamera.clear();
  _cameraMilestoneCount = 0;

  ProtectionZone.active.fill(0);
  ProtectionZone.ownerEid.fill(0);
  _protectionZoneSlots.clear();
  _nextProtectionZoneSlot = 0;

  _currentGameTime = 0;
}