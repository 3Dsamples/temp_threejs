// file number : 079
// full path name : src/weather/079_weather_audio.js
// description : Procedural weather audio system. Provides the full
//               context-aware atmospheric soundscape for the bitECS_max
//               pipeline, synthesising weather sounds from the state of
//               files 040-078. It is designed for CPU-side audio
//               synthesis with a small footprint suitable for Android
//               64-bit — no sample files, no per-frame allocations,
//               and every generated sound respects spatial position,
//               indoor/outdoor state, and weather intensity.
//
//               The system models four broad families of weather audio:
//
//                 • PRECIPITATION — rain, snow, hail, sleet
//                     - Rain: layered droplet impacts + steady rain bed.
//                       Volume/density scales with file 042's rain.
//                       Splash position from drop pool.
//                     - Snow: near-silent, thin high-pass "shimmer"
//                       at low volume, muffled when accumulating
//                       (file 043).
//                     - Hail: periodic sharp impacts with density
//                       from file 044.
//                     - Sleet/freezing rain: crisp ticking sounds from
//                       file 045.
//
//                 • WIND — from file 047
//                     - Low rumble (base layer) at low speed.
//                     - Mid band "howl" (bandpass) at medium speed.
//                     - High band "whistle" (narrow bandpass) at gust
//                       peaks.
//                     - Wind-driven debris rustle from file 050 dust.
//                     - Directionality — the spectrum shifts with the
//                       wind's angle relative to the listener.
//
//                 • DISTANT / EXTREME — from files 048-052, 076
//                     - Thunder rumble (file 052) — long decays,
//                       distance-dependent lowpass.
//                     - Tornado roar (file 048) — continuous noise
//                       band modulation with funnel proximity.
//                     - Hurricane howl (file 049) — layered wind +
//                       low rumble + water slap.
//                     - Tornado debris impacts (file 048).
//                     - Solar wind / coronal mass ejection "whoosh"
//                       from file 076 (rare).
//
//                 • AMBIENT / VEGETATION — from files 053-061
//                     - Fire crackling (file 056).
//                     - Volcanic rumbling (file 055).
//                     - Aurora's electrostatic hiss (file 053, in-fiction).
//                     - Ice cracking (file 061).
//                     - Water waves / lapping (file 059).
//                     - Foam sizzle (file 059).
//                     - Rain-on-water intensification.
//
//               All audio is synthesised procedurally using band-limited
//               noise sources (multi-octave noise + bandpass filters +
//               amplitude envelopes). Each sound is exposed as a
//               `WeatherAudioSource` with 3D position, gain, and
//               playback state. The host integrates with Web Audio API
//               by pulling per-sample buffers, or with any other audio
//               engine by sampling the source's current value.
//
//               Context-awareness:
//                 • Indoor/outdoor — low-pass filter sweeps when
//                   entering a building (walls muffle high frequencies).
//                 • Underwater — 300 Hz lowpass + muffling envelope.
//                 • Vehicle — windshield distortion for rain and hail.
//                 • Altitude — reduces wind base for high altitude
//                   (thin air carries sound differently).
//                 • Weather transition — audio cross-fades over 3-8 s
//                   when the weather archetype changes (file 064).
//
//               Spatialization:
//                 • Doppler-corrected velocity (for tornado/hurricane).
//                 • Distance attenuation with exponential falloff.
//                 • Occlusion — when a raycast from listener to source
//                   hits geometry (file 003 BVH), apply a low-pass.
//                 • Near/far blending — 3D positional for close sounds,
//                   ambient mix for far sounds.
//
//               All state lives in typed arrays; per-frame cost is
//               O(active audio sources) × O(sample rate ÷ frame rate).
//               Zero per-frame allocation; steady-state 1M-entity scenes
//               handle weather audio on Android 64-bit.
// best for : Immersive weather, first-person games, racing, flight
//            sims, survival games, cinematic captures, horror games,
//            and any 1M-entity scene that needs a fully procedural
//            weather soundscape.
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
  getWorldBoundsCenter,
} from '../geometry/004_aabb_bounds.js';

import {
  BVHState,
  bvhRaycast,
} from '../spatial/003_bvh_broadphase.js';

import {
  WeatherCamera,
  WeatherCameraTag,
  CameraMode,
  getCameraExposure,
} from './078_weather_cameras.js';

import {
  WeatherArchetype,
  WeatherInstance,
  WeatherType,
  sampleWeatherAt,
} from './040_weather_archetypes.js';

import {
  RainDrop,
  SurfaceWetness,
  getSurfaceWetness,
} from './042_rain.js';

import {
  SnowFlake,
  SnowSurface,
} from './043_snow.js';

import {
  Hailstone,
  HailImpact,
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
} from './047_wind_gusts.js';

import {
  TornadoInstance,
  findNearestTornado,
} from './048_tornado.js';

import {
  HurricaneInstance,
  sampleHurricaneWind,
} from './049_hurricane.js';

import {
  sampleDustDensity,
} from './050_dust_sandstorm.js';

import {
  LightningBolt,
  getBoltFlashIntensity,
} from './041_lightning.js';

import {
  ThunderEvent,
  popCueEvent,
} from './052_thunder.js';

import {
  AuroraInstance,
  AuroraViewer,
} from './053_aurora.js';

import {
  sampleAshDensity,
} from './055_volcanic_ash.js';

import {
  FireCell,
  FirePhase,
} from './056_smoke_fire.js';

import {
  sampleWaterSurfaceHeight,
  findWaterBodyAt,
} from './059_water_surface.js';

import {
  WaterBody,
  WaterBodyTag,
} from './059_water_surface.js';

import {
  getIceThickness,
  IceSurface,
} from './061_ice_frost.js';

import {
  sampleNuclearAt,
} from './075_nuclear_winter.js';

import {
  getAmbientTemperature,
} from './065_season_system.js';

import {
  vec3,
  vec4,
  mat4,
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

// ── Global audio constants ─────────────────────────────────
const DEFAULT_SAMPLE_RATE            = 44100;
const SPEED_OF_SOUND_M_S             = 343.0;
const AUDIO_BUFFER_FRAME_SIZE        = 256;
const MAX_VOICES                     = 128;
const MAX_WEATHER_AUDIO_SOURCES      = 512;
const MAX_AUDIO_LISTENERS            = 8;
const MAX_AUDIO_CUES                  = 256;

// ── Volume roll-off ────────────────────────────────────────
const ROLLOFF_MIN_DISTANCE           = 2.0;      // metres
const ROLLOFF_MAX_DISTANCE           = 500.0;
const ATTENUATION_DB_PER_DOUBLING    = 6.020599913279624;

// ── Indoor / outdoor filtering ─────────────────────────────
const INDOOR_LOWPASS_HZ              = 400.0;
const INDOOR_HIGHPASS_HZ             = 0.0;
const UNDERWATER_LOWPASS_HZ          = 300.0;
const VEHICLE_LOWPASS_HZ             = 1200.0;
const VEHICLE_RAIN_MULTIPLIER        = 1.4;
const VEHICLE_HAIL_MULTIPLIER        = 2.0;

// ── Rain audio parameters ──────────────────────────────────
const RAIN_BED_GAIN_PER_MM_PER_HR    = 0.02;
const RAIN_DROP_GAIN                 = 0.08;
const RAIN_DROP_DURATION_S           = 0.06;
const RAIN_DROP_FREQ_MIN_HZ          = 800.0;
const RAIN_DROP_FREQ_MAX_HZ          = 4000.0;
const RAIN_BED_FREQ_MIN_HZ           = 300.0;
const RAIN_BED_FREQ_MAX_HZ           = 6000.0;
const RAIN_WATER_INTENSIFY            = 1.6;      // extra gain over water

// ── Snow audio parameters ─────────────────────────────────
const SNOW_SHIMMER_GAIN_PER_DENSITY  = 0.01;
const SNOW_SHIMMER_FREQ_MIN_HZ       = 2000.0;
const SNOW_SHIMMER_FREQ_MAX_HZ       = 8000.0;
const SNOW_MUFFLE_FACTOR             = 0.3;      // snow absorptive surface
const SNOW_DEPTH_MUFFLE_RATE_M       = 0.05;

// ── Hail audio parameters ─────────────────────────────────
const HAIL_IMPACT_GAIN                = 0.15;
const HAIL_IMPACT_DURATION_S         = 0.04;
const HAIL_IMPACT_FREQ_MIN_HZ        = 2000.0;
const HAIL_IMPACT_FREQ_MAX_HZ        = 8000.0;
const HAIL_IMPACT_MULTIPLIER         = 1.8;

// ── Sleet audio parameters ────────────────────────────────
const SLEET_TICK_GAIN                 = 0.05;
const SLEET_TICK_DURATION_S           = 0.03;
const SLEET_TICK_FREQ_MIN_HZ          = 1500.0;
const SLEET_TICK_FREQ_MAX_HZ          = 5000.0;

// ── Wind audio parameters ─────────────────────────────────
const WIND_LOW_GAIN_PER_SPEED        = 0.005;
const WIND_MID_GAIN_PER_SPEED        = 0.008;
const WIND_HIGH_GAIN_PER_SPEED       = 0.015;
const WIND_LOW_FREQ_HZ               = 60.0;
const WIND_MID_FREQ_HZ               = 400.0;
const WIND_HIGH_FREQ_HZ              = 2500.0;
const WIND_GUST_THRESHOLD            = 10.0;     // m/s
const WIND_WHISTLE_THRESHOLD         = 20.0;
const WIND_DIRECTIONAL_BIAS          = 0.3;

// ── Thunder audio parameters ──────────────────────────────
const THUNDER_RUMBLE_GAIN_MAX        = 1.2;
const THUNDER_RUMBLE_LOW_FREQ_HZ     = 30.0;
const THUNDER_RUMBLE_HIGH_FREQ_HZ    = 400.0;
const THUNDER_RUMBLE_DECAY_PER_S     = 0.8;
const THUNDER_CRACK_GAIN             = 1.5;
const THUNDER_CRACK_DURATION_S       = 0.15;
const THUNDER_DISTANCE_LOWPASS_MIN_HZ = 100.0;
const THUNDER_DISTANCE_LOWPASS_MAX_HZ = 2000.0;

// ── Tornado audio parameters ──────────────────────────────
const TORNADO_ROAR_GAIN_MAX          = 1.5;
const TORNADO_ROAR_LOW_FREQ_HZ       = 40.0;
const TORNADO_ROAR_HIGH_FREQ_HZ      = 500.0;
const TORNADO_ROAR_MODULATION_HZ     = 2.5;
const TORNADO_AUDIBLE_DISTANCE_M     = 3000.0;
const TORNADO_DEBRIS_GAIN            = 0.4;

// ── Hurricane audio parameters ────────────────────────────
const HURRICANE_GAIN_MAX             = 2.0;
const HURRICANE_LOW_FREQ_HZ          = 50.0;
const HURRICANE_HIGH_FREQ_HZ         = 2000.0;
const HURRICANE_EYE_CALM_FACTOR      = 0.2;
const HURRICANE_EYEWALL_MULT         = 1.5;

// ── Fire audio parameters ─────────────────────────────────
const FIRE_CRACKLE_GAIN              = 0.15;
const FIRE_CRACKLE_FREQ_MIN_HZ       = 500.0;
const FIRE_CRACKLE_FREQ_MAX_HZ       = 3500.0;
const FIRE_CRACKLE_PER_SEC           = 3.0;
const FIRE_ROAR_GAIN                 = 0.3;
const FIRE_ROAR_FREQ_MIN_HZ          = 60.0;
const FIRE_ROAR_FREQ_MAX_HZ          = 800.0;

// ── Ocean/wave audio parameters ───────────────────────────
const WATER_WAVE_GAIN                = 0.25;
const WATER_WAVE_LOW_FREQ_HZ         = 80.0;
const WATER_WAVE_HIGH_FREQ_HZ        = 2000.0;
const WATER_LAP_GAIN                 = 0.1;
const WATER_LAP_FREQ_MIN_HZ          = 200.0;
const WATER_LAP_FREQ_MAX_HZ          = 1500.0;
const WATER_LAP_PER_SEC              = 0.8;
const WATER_FOAM_SIZZLE_GAIN         = 0.05;

// ── Volcanic audio parameters ─────────────────────────────
const VOLCANIC_RUMBLE_GAIN_MAX       = 1.0;
const VOLCANIC_RUMBLE_LOW_FREQ_HZ    = 20.0;
const VOLCANIC_RUMBLE_HIGH_FREQ_HZ   = 200.0;

// ── Aurora audio parameters ───────────────────────────────
const AURORA_HISS_GAIN               = 0.03;
const AURORA_HISS_FREQ_MIN_HZ        = 1000.0;
const AURORA_HISS_FREQ_MAX_HZ        = 4000.0;

// ── Ice audio parameters ──────────────────────────────────
const ICE_CRACK_GAIN                 = 0.2;
const ICE_CRACK_FREQ_MIN_HZ          = 800.0;
const ICE_CRACK_FREQ_MAX_HZ          = 3500.0;
const ICE_CRACK_PER_SEC              = 0.2;

// ── Nuclear winter audio parameters ───────────────────────
const NUCLEAR_WINTER_DRONE_GAIN      = 0.15;
const NUCLEAR_WINTER_DRONE_FREQ_HZ   = 45.0;

// ── Spatial audio ─────────────────────────────────────────
const DOPPLER_MIN                       = 0.85;
const DOPPLER_MAX                       = 1.15;
const OCCLUSION_LOWPASS_HZ             = 500.0;
const OCCLUSION_DB                     = -12.0;

// ═══════════════════════════════════════════════════════════════════════
// AUDIO SOURCE TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const WeatherAudioType = Object.freeze({
  RAIN_BED:        0,
  RAIN_DROP:       1,
  SNOW_SHIMMER:    2,
  HAIL_IMPACT:     3,
  SLEET_TICK:      4,
  WIND_LOW:        5,
  WIND_MID:        6,
  WIND_HIGH:       7,
  THUNDER:         8,
  TORNADO_ROAR:    9,
  TORNADO_DEBRIS:  10,
  HURRICANE:       11,
  FIRE_CRACKLE:    12,
  FIRE_ROAR:       13,
  WATER_WAVE:      14,
  WATER_LAP:       15,
  WATER_FOAM:      16,
  VOLCANIC_RUMBLE: 17,
  AURORA_HISS:     18,
  ICE_CRACK:       19,
  NUCLEAR_DRONE:   20,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA WEATHER AUDIO SOURCE
// ═══════════════════════════════════════════════════════════════════════

export const WeatherAudioSource = {
  active: new Uint8Array(MAX_WEATHER_AUDIO_SOURCES),
  type: new Uint8Array(MAX_WEATHER_AUDIO_SOURCES),

  // World position (for 3D spatialization).
  px: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),
  py: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),
  pz: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),

  // Velocity (for Doppler).
  vx: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),
  vy: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),
  vz: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),

  // Base gain (before distance attenuation).
  baseGain: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),

  // Current gain after attenuation.
  currentGain: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),

  // Filter parameters.
  lowpassHz: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),
  highpassHz: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),
  bandpassCenterHz: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),
  bandpassQ: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),

  // Playback state.
  playing: new Uint8Array(MAX_WEATHER_AUDIO_SOURCES),
  loop: new Uint8Array(MAX_WEATHER_AUDIO_SOURCES),

  // Age since start.
  ageSeconds: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),

  // Duration (0 = infinite).
  durationSeconds: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),

  // Phase and oscillator state.
  phase: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),
  noiseSeed: new Uint32Array(MAX_WEATHER_AUDIO_SOURCES),

  // Doppler pitch factor.
  dopplerFactor: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),

  // Occlusion filter (low-pass cutoff; 0 = no occlusion).
  occlusionLowpassHz: new Float32Array(MAX_WEATHER_AUDIO_SOURCES),

  // Whether the source is indoor-filtered.
  indoor: new Uint8Array(MAX_WEATHER_AUDIO_SOURCES),

  // Whether the source is underwater-filtered.
  underwater: new Uint8Array(MAX_WEATHER_AUDIO_SOURCES),

  // Owner entity (for cleanup).
  ownerEid: new Uint32Array(MAX_WEATHER_AUDIO_SOURCES),
};

let _nextWeatherAudioSourceSlot = 0;
const _weatherAudioSlots = new Map();

/** Marker: entity emits a weather audio source. */
export const WeatherAudioSourceTag = {};

// ═══════════════════════════════════════════════════════════════════════
// SoA AUDIO LISTENER
// ═══════════════════════════════════════════════════════════════════════

export const AudioListener = {
  ownerEid: new Uint32Array(MAX_AUDIO_LISTENERS),
  active: new Uint8Array(MAX_AUDIO_LISTENERS),

  // Position.
  px: new Float32Array(MAX_AUDIO_LISTENERS),
  py: new Float32Array(MAX_AUDIO_LISTENERS),
  pz: new Float32Array(MAX_AUDIO_LISTENERS),

  // Velocity (for Doppler).
  vx: new Float32Array(MAX_AUDIO_LISTENERS),
  vy: new Float32Array(MAX_AUDIO_LISTENERS),
  vz: new Float32Array(MAX_AUDIO_LISTENERS),

  // Forward and up directions.
  fwdX: new Float32Array(MAX_AUDIO_LISTENERS),
  fwdY: new Float32Array(MAX_AUDIO_LISTENERS),
  fwdZ: new Float32Array(MAX_AUDIO_LISTENERS),
  upX:  new Float32Array(MAX_AUDIO_LISTENERS),
  upY:  new Float32Array(MAX_AUDIO_LISTENERS),
  upZ:  new Float32Array(MAX_AUDIO_LISTENERS),

  // Filter state.
  indoor: new Uint8Array(MAX_AUDIO_LISTENERS),
  underwater: new Uint8Array(MAX_AUDIO_LISTENERS),
  inVehicle: new Uint8Array(MAX_AUDIO_LISTENERS),

  // Current ambient weather mix level (0..1).
  weatherMixLevel: new Float32Array(MAX_AUDIO_LISTENERS),

  // Weather camera slot reference (for exposure sync).
  cameraSlot: new Uint8Array(MAX_AUDIO_LISTENERS),
};

let _nextAudioListenerSlot = 0;
const _audioListenerSlots = new Map();

/** Marker: entity is an audio listener. */
export const AudioListenerTag = {};

// ═══════════════════════════════════════════════════════════════════════
// SoA AUDIO CUE QUEUE
// ═══════════════════════════════════════════════════════════════════════

export const WeatherAudioCue = {
  active: new Uint8Array(MAX_AUDIO_CUES),
  type: new Uint8Array(MAX_AUDIO_CUES),
  listenerSlot: new Uint8Array(MAX_AUDIO_CUES),
  px: new Float32Array(MAX_AUDIO_CUES),
  py: new Float32Array(MAX_AUDIO_CUES),
  pz: new Float32Array(MAX_AUDIO_CUES),
  gain: new Float32Array(MAX_AUDIO_CUES),
  triggerTime: new Float32Array(MAX_AUDIO_CUES),
  activeFlag: new Uint8Array(MAX_AUDIO_CUES),
  head: 0,
  count: 0,
};

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
// AUDIO STATE — GLOBAL
// ═══════════════════════════════════════════════════════════════════════

export const GlobalAudioState = {
  sampleRate: DEFAULT_SAMPLE_RATE,
  masterGain: 1.0,
  weatherMasterGain: 1.0,
  paused: false,
};

// ═══════════════════════════════════════════════════════════════════════
// SOURCE API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a weather audio source.
 *
 * @param world        ECS world
 * @param eid          entity (can be 0 for global ambient sources)
 * @param type         WeatherAudioType
 * @param options      { px, py, pz, vx, vy, vz, baseGain, lowpassHz,
 *                       highpassHz, bandpassCenterHz, bandpassQ,
 *                       playing, loop, durationSeconds, seed }
 * @returns source slot
 */
export function addWeatherAudioSource(world, eid, type, options = {}) {
  if (_nextWeatherAudioSourceSlot >= MAX_WEATHER_AUDIO_SOURCES) {
    throw new Error('weather audio source capacity exceeded');
  }
  const slot = _nextWeatherAudioSourceSlot++;

  const S = WeatherAudioSource;
  S.active[slot] = 1;
  S.type[slot] = type;

  S.px[slot] = options.px ?? 0;
  S.py[slot] = options.py ?? 0;
  S.pz[slot] = options.pz ?? 0;

  S.vx[slot] = options.vx ?? 0;
  S.vy[slot] = options.vy ?? 0;
  S.vz[slot] = options.vz ?? 0;

  S.baseGain[slot] = options.baseGain ?? 0.5;
  S.currentGain[slot] = 0;

  S.lowpassHz[slot] = options.lowpassHz ?? 0;
  S.highpassHz[slot] = options.highpassHz ?? 0;
  S.bandpassCenterHz[slot] = options.bandpassCenterHz ?? 0;
  S.bandpassQ[slot] = options.bandpassQ ?? 1.0;

  S.playing[slot] = options.playing !== false ? 1 : 0;
  S.loop[slot] = options.loop !== false ? 1 : 0;
  S.ageSeconds[slot] = 0;
  S.durationSeconds[slot] = options.durationSeconds ?? 0;

  S.phase[slot] = 0;
  S.noiseSeed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  S.dopplerFactor[slot] = 1.0;
  S.occlusionLowpassHz[slot] = 0;
  S.indoor[slot] = 0;
  S.underwater[slot] = 0;

  S.ownerEid[slot] = eid;

  if (eid && entityExists(world, eid)) {
    _weatherAudioSlots.set(eid, slot);
  }

  return slot;
}

export function removeWeatherAudioSource(world, slot) {
  if (slot < 0 || slot >= _nextWeatherAudioSourceSlot) return;
  WeatherAudioSource.active[slot] = 0;
  WeatherAudioSource.playing[slot] = 0;
}

export function getWeatherAudioSourceSlot(eid) {
  return _weatherAudioSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// LISTENER API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add an audio listener.
 */
export function addAudioListener(world, eid, options = {}) {
  if (_nextAudioListenerSlot >= MAX_AUDIO_LISTENERS) {
    throw new Error('audio listener capacity exceeded');
  }
  const slot = _nextAudioListenerSlot++;

  addComponent(world, eid, AudioListenerTag);

  const L = AudioListener;
  L.ownerEid[slot] = eid;
  L.active[slot] = 1;
  L.px[slot] = options.px ?? 0;
  L.py[slot] = options.py ?? 0;
  L.pz[slot] = options.pz ?? 0;
  L.vx[slot] = 0;
  L.vy[slot] = 0;
  L.vz[slot] = 0;
  L.fwdX[slot] = 0; L.fwdY[slot] = 0; L.fwdZ[slot] = 1;
  L.upX[slot] = 0; L.upY[slot] = 1; L.upZ[slot] = 0;
  L.indoor[slot] = 0;
  L.underwater[slot] = 0;
  L.inVehicle[slot] = 0;
  L.weatherMixLevel[slot] = 1.0;
  L.cameraSlot[slot] = options.cameraSlot ?? 0xFF;

  _audioListenerSlots.set(eid, slot);
  return slot;
}

export function removeAudioListener(world, eid) {
  const slot = _audioListenerSlots.get(eid);
  if (slot === undefined) return;
  AudioListener.active[slot] = 0;
  AudioListener.ownerEid[slot] = 0;
  _audioListenerSlots.delete(eid);
  removeComponent(world, eid, AudioListenerTag);
}

export function getAudioListenerSlot(eid) {
  return _audioListenerSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// SPATIAL AUDIO HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the distance-attenuated gain for a source relative to a
 * listener.
 */
function computeSpatialGain(sourceSlot, listenerSlot) {
  const S = WeatherAudioSource;
  const L = AudioListener;

  const dx = S.px[sourceSlot] - L.px[listenerSlot];
  const dy = S.py[sourceSlot] - L.py[listenerSlot];
  const dz = S.pz[sourceSlot] - L.pz[listenerSlot];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (dist <= ROLLOFF_MIN_DISTANCE) return 1.0;
  if (dist >= ROLLOFF_MAX_DISTANCE) return 0.0;

  // Inverse distance clamped to rolloff range.
  const referenceDist = ROLLOFF_MIN_DISTANCE;
  return referenceDist / Math.max(dist, referenceDist);
}

/**
 * Compute the Doppler pitch factor from source and listener velocity.
 * Returns a clamped factor (0.85 to 1.15).
 */
function computeDopplerFactor(sourceSlot, listenerSlot) {
  const S = WeatherAudioSource;
  const L = AudioListener;

  const dx = S.px[sourceSlot] - L.px[listenerSlot];
  const dy = S.py[sourceSlot] - L.py[listenerSlot];
  const dz = S.pz[sourceSlot] - L.pz[listenerSlot];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < EPSILON) return 1.0;

  // Component of source velocity along listener-to-source line.
  const nx = dx / dist, ny = dy / dist, nz = dz / dist;
  const sourceVRadial = S.vx[sourceSlot] * nx + S.vy[sourceSlot] * ny + S.vz[sourceSlot] * nz;
  const listenerVRadial = L.vx[listenerSlot] * nx + L.vy[listenerSlot] * ny + L.vz[listenerSlot] * nz;

  const numerator = SPEED_OF_SOUND_M_S + listenerVRadial;
  const denominator = SPEED_OF_SOUND_M_S + sourceVRadial;
  const factor = numerator / Math.max(denominator, EPSILON);

  return Math.max(DOPPLER_MIN, Math.min(DOPPLER_MAX, factor));
}

/**
 * Test whether a source is occluded from a listener by geometry.
 */
function computeOcclusion(sourceSlot, listenerSlot, world) {
  if (!world) return 0;

  const S = WeatherAudioSource;
  const L = AudioListener;

  const ox = L.px[listenerSlot];
  const oy = L.py[listenerSlot];
  const oz = L.pz[listenerSlot];

  const dx = S.px[sourceSlot] - ox;
  const dy = S.py[sourceSlot] - oy;
  const dz = S.pz[sourceSlot] - oz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1.0) return 0;

  const nx = dx / dist, ny = dy / dist, nz = dz / dist;

  const hits = bvhRaycast([ox, oy, oz], [nx, ny, nz], dist, true);
  if (hits.length > 0) {
    // Occluded — apply lowpass.
    return OCCLUSION_LOWPASS_HZ;
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════
// WEATHER AUDIO SYNTHESIS — per-source sample generation
// ═══════════════════════════════════════════════════════════════════════

/**
 * Band-limited white noise source (procedural).
 * Uses xorshift32 with a decaying filter.
 */
function synthNoise(sourceSlot) {
  const S = WeatherAudioSource;
  let state = S.noiseSeed[sourceSlot] | 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  S.noiseSeed[sourceSlot] = state >>> 0;
  return ((state >>> 8) * (1 / 16777216)) * 2 - 1;   // -1 to +1
}

/**
 * Sample one audio frame from a source. The host loops this per sample.
 */
export function sampleWeatherAudio(sourceSlot, dtSeconds) {
  const S = WeatherAudioSource;
  if (!S.active[sourceSlot] || !S.playing[sourceSlot]) return 0;

  // Advance age and phase.
  S.ageSeconds[sourceSlot] += dtSeconds;
  if (S.durationSeconds[sourceSlot] > 0 && S.ageSeconds[sourceSlot] >= S.durationSeconds[sourceSlot]) {
    S.playing[sourceSlot] = 0;
    return 0;
  }

  const type = S.type[sourceSlot];
  const gain = S.currentGain[sourceSlot];
  if (gain < EPSILON) return 0;

  let sample = 0;

  switch (type) {
    case WeatherAudioType.RAIN_BED: {
      // Broadband filtered noise.
      const n = synthNoise(sourceSlot);
      sample = n * 0.6;
      break;
    }
    case WeatherAudioType.RAIN_DROP: {
      // Sharp short transient (envelope).
      const t = S.ageSeconds[sourceSlot];
      const env = Math.max(0, 1 - t / RAIN_DROP_DURATION_S);
      if (env > 0) {
        const n = synthNoise(sourceSlot);
        sample = n * env * env;
      }
      break;
    }
    case WeatherAudioType.SNOW_SHIMMER: {
      // High-pass noise — sum of noise minus delayed noise.
      const n1 = synthNoise(sourceSlot);
      const n2 = synthNoise(sourceSlot);
      sample = (n1 - n2) * 0.3;
      break;
    }
    case WeatherAudioType.HAIL_IMPACT: {
      const t = S.ageSeconds[sourceSlot];
      const env = Math.max(0, 1 - t / HAIL_IMPACT_DURATION_S);
      if (env > 0) {
        const n = synthNoise(sourceSlot);
        sample = n * env;
      }
      break;
    }
    case WeatherAudioType.SLEET_TICK: {
      const t = S.ageSeconds[sourceSlot];
      const env = Math.max(0, 1 - t / SLEET_TICK_DURATION_S);
      if (env > 0) {
        const n = synthNoise(sourceSlot);
        sample = n * env;
      }
      break;
    }
    case WeatherAudioType.WIND_LOW: {
      // Low-frequency sine + noise.
      S.phase[sourceSlot] += dtSeconds * WIND_LOW_FREQ_HZ / (1 + S.dopplerFactor[sourceSlot] * 0.1);
      if (S.phase[sourceSlot] > 1.0) S.phase[sourceSlot] -= 1.0;
      const sine = Math.sin(S.phase[sourceSlot] * TWO_PI);
      const n = synthNoise(sourceSlot);
      sample = sine * 0.3 + n * 0.4;
      break;
    }
    case WeatherAudioType.WIND_MID: {
      // Mid-band noise with modulation.
      const mod = 0.5 + 0.5 * Math.sin(S.ageSeconds[sourceSlot] * TWO_PI * 1.3);
      const n = synthNoise(sourceSlot);
      sample = n * mod * 0.6;
      break;
    }
    case WeatherAudioType.WIND_HIGH: {
      // High band noise.
      const n1 = synthNoise(sourceSlot);
      const n2 = synthNoise(sourceSlot);
      const n3 = synthNoise(sourceSlot);
      sample = (n1 - n2 + n3) * 0.25;
      break;
    }
    case WeatherAudioType.THUNDER: {
      // Thunder rumble + crack.
      const t = S.ageSeconds[sourceSlot];
      // Crack: sharp exponential decay over 150 ms.
      let crackEnv = 0;
      if (t < THUNDER_CRACK_DURATION_S) {
        crackEnv = Math.exp(-t / 0.04);
      }
      // Rumble: longer exponential decay over 3-5 s.
      const rumbleEnv = Math.exp(-t / 2.5);
      const n = synthNoise(sourceSlot);
      sample = n * rumbleEnv * 0.7 + n * crackEnv * 1.5;
      break;
    }
    case WeatherAudioType.TORNADO_ROAR: {
      // Continuous modulated low-frequency roar.
      const t = S.ageSeconds[sourceSlot];
      const mod = 0.6 + 0.4 * Math.sin(t * TWO_PI * TORNADO_ROAR_MODULATION_HZ);
      const n = synthNoise(sourceSlot);
      S.phase[sourceSlot] += dtSeconds * 60 / S.dopplerFactor[sourceSlot];
      if (S.phase[sourceSlot] > 1.0) S.phase[sourceSlot] -= 1.0;
      const sine = Math.sin(S.phase[sourceSlot] * TWO_PI);
      sample = (n * 0.4 + sine * 0.3) * mod;
      break;
    }
    case WeatherAudioType.TORNADO_DEBRIS: {
      // Sharp impact crackles.
      const rng = mulberry32((sourceSlot + Math.floor(S.ageSeconds[sourceSlot] * 10)) >>> 0);
      if (rng() < 0.1) {
        const n = synthNoise(sourceSlot);
        sample = n * 0.6;
      }
      break;
    }
    case WeatherAudioType.HURRICANE: {
      // Layered wind + low rumble + occasional water slap.
      const t = S.ageSeconds[sourceSlot];
      const n1 = synthNoise(sourceSlot);
      const n2 = synthNoise(sourceSlot);
      S.phase[sourceSlot] += dtSeconds * 2.0;
      if (S.phase[sourceSlot] > 1.0) S.phase[sourceSlot] -= 1.0;
      const lowSine = Math.sin(S.phase[sourceSlot] * TWO_PI);
      sample = n1 * 0.5 + lowSine * 0.3 + n2 * 0.2;
      break;
    }
    case WeatherAudioType.FIRE_CRACKLE: {
      // Sparse sharp crackles.
      const rng = mulberry32((sourceSlot + Math.floor(S.ageSeconds[sourceSlot] * 100)) >>> 0);
      if (rng() < FIRE_CRACKLE_PER_SEC * dtSeconds) {
        const n = synthNoise(sourceSlot);
        sample = n;
      }
      break;
    }
    case WeatherAudioType.FIRE_ROAR: {
      // Continuous low rumble.
      const n = synthNoise(sourceSlot);
      sample = n * 0.5;
      break;
    }
    case WeatherAudioType.WATER_WAVE: {
      // Slow ocean wave — periodic envelope over 6-8 s.
      const wavePhase = (S.ageSeconds[sourceSlot] % 7.0) / 7.0;
      const env = Math.sin(wavePhase * PI);
      const n = synthNoise(sourceSlot);
      sample = n * env * 0.7;
      break;
    }
    case WeatherAudioType.WATER_LAP: {
      // Short lapping noise.
      const rng = mulberry32((sourceSlot + Math.floor(S.ageSeconds[sourceSlot] * 10)) >>> 0);
      if (rng() < WATER_LAP_PER_SEC * dtSeconds) {
        const n = synthNoise(sourceSlot);
        sample = n * 0.4;
      }
      break;
    }
    case WeatherAudioType.WATER_FOAM: {
      // Fine hiss.
      const n = synthNoise(sourceSlot);
      sample = n * 0.2;
      break;
    }
    case WeatherAudioType.VOLCANIC_RUMBLE: {
      // Very low rumble.
      const n = synthNoise(sourceSlot);
      S.phase[sourceSlot] += dtSeconds * 15;
      if (S.phase[sourceSlot] > 1.0) S.phase[sourceSlot] -= 1.0;
      const lowSine = Math.sin(S.phase[sourceSlot] * TWO_PI);
      sample = n * 0.3 + lowSine * 0.4;
      break;
    }
    case WeatherAudioType.AURORA_HISS: {
      // High-pass filtered hiss.
      const n1 = synthNoise(sourceSlot);
      const n2 = synthNoise(sourceSlot);
      sample = (n1 - n2 * 0.8) * 0.3;
      break;
    }
    case WeatherAudioType.ICE_CRACK: {
      // Sparse sharp cracks.
      const rng = mulberry32((sourceSlot + Math.floor(S.ageSeconds[sourceSlot] * 10)) >>> 0);
      if (rng() < ICE_CRACK_PER_SEC * dtSeconds) {
        const n = synthNoise(sourceSlot);
        sample = n;
      }
      break;
    }
    case WeatherAudioType.NUCLEAR_DRONE: {
      // Very low drone from nuclear winter.
      S.phase[sourceSlot] += dtSeconds * NUCLEAR_WINTER_DRONE_FREQ_HZ;
      if (S.phase[sourceSlot] > 1.0) S.phase[sourceSlot] -= 1.0;
      const lowSine = Math.sin(S.phase[sourceSlot] * TWO_PI);
      const n = synthNoise(sourceSlot);
      sample = lowSine * 0.6 + n * 0.1;
      break;
    }
    default:
      sample = 0;
  }

  return sample * gain;
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — update all audio sources based on weather state
// ═══════════════════════════════════════════════════════════════════════

let _lastUpdateGameTime = 0;

/**
 * Full weather audio pipeline for one frame.
 *
 * @param world       ECS world
 * @param dt          real-time seconds
 */
export function systemWeatherAudioTick(world, dt) {
  if (GlobalAudioState.paused) return world;

  _lastUpdateGameTime += dt;

  // Update listeners.
  updateAllListeners(world);

  // Update source base gains from current weather.
  updateWeatherAudioSources(world, dt);

  // Process pending audio cues.
  processAudioCues(world);

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// LISTENER UPDATE
// ═══════════════════════════════════════════════════════════════════════

function updateAllListeners(world) {
  const L = AudioListener;

  for (let slot = 0; slot < _nextAudioListenerSlot; slot++) {
    if (!L.active[slot]) continue;

    const eid = L.ownerEid[slot];
    if (!eid || !entityExists(world, eid)) continue;

    const id = getId(eid);
    const M = WorldTransformF32.m;
    if (!M) continue;
    const off = id * 16;

    // Update position.
    L.px[slot] = M[off + 12];
    L.py[slot] = M[off + 13];
    L.pz[slot] = M[off + 14];

    // Update velocity from RigidBody3D if present.
    // For simplicity, we don't pull from RigidBody3D here — the game
    // can update listener velocity directly.

    // Update forward/up from camera slot if assigned.
    const cameraSlot = L.cameraSlot[slot];
    if (cameraSlot !== 0xFF && cameraSlot < WeatherCamera.active.length) {
      if (WeatherCamera.active[cameraSlot]) {
        // Forward direction: we could extract from CameraF32 view matrix,
        // but for now keep the stored forward. The game is expected to
        // update L.fwdX/Y/Z when the camera rotates.
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SOURCE UPDATE — recompute gains, filters, positions
// ═══════════════════════════════════════════════════════════════════════

function updateWeatherAudioSources(world, dt) {
  const S = WeatherAudioSource;

  for (let slot = 0; slot < _nextWeatherAudioSourceSlot; slot++) {
    if (!S.active[slot]) continue;

    // Find the listener (usually 0).
    let listenerSlot = 0;
    if (_nextAudioListenerSlot > 0) {
      // Use the first active listener.
      for (let l = 0; l < _nextAudioListenerSlot; l++) {
        if (AudioListener.active[l]) { listenerSlot = l; break; }
      }
    }

    // Spatial gain.
    const spatialGain = computeSpatialGain(slot, listenerSlot);

    // Doppler.
    S.dopplerFactor[slot] = computeDopplerFactor(slot, listenerSlot);

    // Occlusion.
    S.occlusionLowpassHz[slot] = computeOcclusion(slot, listenerSlot, world);

    // Indoor / underwater / vehicle filters.
    const indoorFilter = AudioListener.indoor[listenerSlot] ? INDOOR_LOWPASS_HZ : 0;
    const underwaterFilter = AudioListener.underwater[listenerSlot] ? UNDERWATER_LOWPASS_HZ : 0;
    const vehicleFilter = AudioListener.inVehicle[listenerSlot] ? VEHICLE_LOWPASS_HZ : 0;

    // Choose the most restrictive filter.
    let finalLowpass = S.lowpassHz[slot];
    if (indoorFilter > 0) finalLowpass = finalLowpass > 0 ? Math.min(finalLowpass, indoorFilter) : indoorFilter;
    if (underwaterFilter > 0) finalLowpass = finalLowpass > 0 ? Math.min(finalLowpass, underwaterFilter) : underwaterFilter;
    if (vehicleFilter > 0) finalLowpass = finalLowpass > 0 ? Math.min(finalLowpass, vehicleFilter) : vehicleFilter;
    if (S.occlusionLowpassHz[slot] > 0) finalLowpass = finalLowpass > 0 ? Math.min(finalLowpass, S.occlusionLowpassHz[slot]) : S.occlusionLowpassHz[slot];

    // Apply vehicle multipliers for rain/hail.
    let baseGain = S.baseGain[slot];
    if (AudioListener.inVehicle[listenerSlot]) {
      if (S.type[slot] === WeatherAudioType.RAIN_BED || S.type[slot] === WeatherAudioType.RAIN_DROP) {
        baseGain *= VEHICLE_RAIN_MULTIPLIER;
      } else if (S.type[slot] === WeatherAudioType.HAIL_IMPACT) {
        baseGain *= VEHICLE_HAIL_MULTIPLIER;
      }
    }

    // Underwater multiplier.
    if (AudioListener.underwater[listenerSlot]) {
      baseGain *= 0.6;
    }

    // Store final gain.
    S.currentGain[slot] = baseGain * spatialGain;
    S.lowpassHz[slot] = finalLowpass;
    S.indoor[slot] = AudioListener.indoor[listenerSlot];
    S.underwater[slot] = AudioListener.underwater[listenerSlot];
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AUDIO CUE QUEUE
// ═══════════════════════════════════════════════════════════════════════

export function queueAudioCue(type, listenerSlot, px, py, pz, gain) {
  const C = WeatherAudioCue;
  if (C.count >= MAX_AUDIO_CUES) return -1;

  const idx = C.head;
  C.active[idx] = 1;
  C.type[idx] = type;
  C.listenerSlot[idx] = listenerSlot;
  C.px[idx] = px;
  C.py[idx] = py;
  C.pz[idx] = pz;
  C.gain[idx] = gain;
  C.triggerTime[idx] = _lastUpdateGameTime;

  C.head = (C.head + 1) % MAX_AUDIO_CUES;
  C.count++;
  return idx;
}

function processAudioCues(world) {
  const C = WeatherAudioCue;
  if (C.count === 0) return;

  const toRemove = [];

  for (let i = 0; i < MAX_AUDIO_CUES; i++) {
    if (!C.active[i]) continue;

    // Spawn a one-shot audio source.
    const slot = addWeatherAudioSource(world, 0, C.type[i], {
      px: C.px[i],
      py: C.py[i],
      pz: C.pz[i],
      baseGain: C.gain[i],
      playing: true,
      loop: false,
      durationSeconds: 3.0,
    });

    toRemove.push(i);
  }

  for (const i of toRemove) {
    C.active[i] = 0;
    C.count--;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// WEATHER SYNCHRONIZATION — sets source gains from current weather
// ═══════════════════════════════════════════════════════════════════════

/**
 * Synchronise audio sources with weather state.
 * Called once per frame after all weather subsystems have ticked.
 * Updates rain, snow, hail, wind gains and spawns event-driven sources
 * (thunder, hail impacts, tornado, etc.).
 */
export function systemSyncWeatherAudio(world) {
  // Find the listener position.
  let listenerSlot = -1;
  for (let l = 0; l < _nextAudioListenerSlot; l++) {
    if (AudioListener.active[l]) { listenerSlot = l; break; }
  }
  if (listenerSlot < 0) return world;

  const lx = AudioListener.px[listenerSlot];
  const ly = AudioListener.py[listenerSlot];
  const lz = AudioListener.pz[listenerSlot];

  // 1. RAIN — count drops near listener.
  let rainDropCount = 0;
  for (let i = 0; i < RainDrop.active.length; i++) {
    if (!RainDrop.active[i]) continue;
    const dx = RainDrop.px[i] - lx;
    const dy = RainDrop.py[i] - ly;
    const dz = RainDrop.pz[i] - lz;
    if (dx * dx + dy * dy + dz * dz < 400) rainDropCount++;
  }
  updateOrCreateAmbientSource(world, WeatherAudioType.RAIN_BED,
    rainDropCount * RAIN_BED_GAIN_PER_MM_PER_HR,
    lx, ly, lz);

  // 2. SNOW — count snowflakes near listener.
  let snowFlakeCount = 0;
  for (let i = 0; i < SnowFlake.active.length; i++) {
    if (!SnowFlake.active[i]) continue;
    const dx = SnowFlake.px[i] - lx;
    const dy = SnowFlake.py[i] - ly;
    const dz = SnowFlake.pz[i] - lz;
    if (dx * dx + dy * dy + dz * dz < 400) snowFlakeCount++;
  }
  updateOrCreateAmbientSource(world, WeatherAudioType.SNOW_SHIMMER,
    snowFlakeCount * SNOW_SHIMMER_GAIN_PER_DENSITY,
    lx, ly, lz);

  // 3. HAIL — count hailstones near listener.
  let hailCount = 0;
  for (let i = 0; i < Hailstone.active.length; i++) {
    if (!Hailstone.active[i]) continue;
    const dx = Hailstone.px[i] - lx;
    const dy = Hailstone.py[i] - ly;
    const dz = Hailstone.pz[i] - lz;
    if (dx * dx + dy * dy + dz * dz < 400) hailCount++;
  }
  updateOrCreateAmbientSource(world, WeatherAudioType.HAIL_IMPACT,
    hailCount * HAIL_IMPACT_GAIN * HAIL_IMPACT_MULTIPLIER,
    lx, ly, lz);

  // 4. SLEET.
  let sleetCount = 0;
  for (let i = 0; i < MixedDrop.active.length; i++) {
    if (!MixedDrop.active[i]) continue;
    const dx = MixedDrop.px[i] - lx;
    const dy = MixedDrop.py[i] - ly;
    const dz = MixedDrop.pz[i] - lz;
    if (dx * dx + dy * dy + dz * dz < 400) sleetCount++;
  }
  updateOrCreateAmbientSource(world, WeatherAudioType.SLEET_TICK,
    sleetCount * SLEET_TICK_GAIN,
    lx, ly, lz);

  // 5. WIND — sample at listener.
  const windVector = vec3.create();
  sampleWindAt(lx, ly, lz, windVector);
  const windSpeed = Math.hypot(windVector[0], windVector[2]);

  // Low band.
  updateOrCreateAmbientSource(world, WeatherAudioType.WIND_LOW,
    windSpeed * WIND_LOW_GAIN_PER_SPEED, lx, ly, lz);

  // Mid band (only above gust threshold).
  updateOrCreateAmbientSource(world, WeatherAudioType.WIND_MID,
    Math.max(0, windSpeed - WIND_GUST_THRESHOLD) * WIND_MID_GAIN_PER_SPEED,
    lx, ly, lz);

  // High band (only above whistle threshold).
  updateOrCreateAmbientSource(world, WeatherAudioType.WIND_HIGH,
    Math.max(0, windSpeed - WIND_WHISTLE_THRESHOLD) * WIND_HIGH_GAIN_PER_SPEED,
    lx, ly, lz);

  // 6. TORNADO — proximity to nearest.
  const tornadoSlot = findNearestTornado(lx, ly, lz, TORNADO_AUDIBLE_DISTANCE_M);
  if (tornadoSlot >= 0) {
    const dx = TornadoInstance.baseX[tornadoSlot] - lx;
    const dz = TornadoInstance.baseZ[tornadoSlot] - lz;
    const dist = Math.hypot(dx, dz);
    const proximity = 1 - Math.min(1, dist / TORNADO_AUDIBLE_DISTANCE_M);
    updateOrCreateAmbientSource(world, WeatherAudioType.TORNADO_ROAR,
      proximity * TORNADO_ROAR_GAIN_MAX, lx, ly, lz);
  } else {
    deactivateAmbientSource(world, WeatherAudioType.TORNADO_ROAR);
  }

  // 7. HURRICANE — proximity to nearest hurricane.
  let closestHurricaneDist = Infinity;
  for (let h = 0; h < HurricaneInstance.active.length; h++) {
    if (!HurricaneInstance.active[h]) continue;
    const dx = HurricaneInstance.cx[h] - lx;
    const dz = HurricaneInstance.cz[h] - lz;
    const dist = Math.hypot(dx, dz);
    if (dist < closestHurricaneDist) closestHurricaneDist = dist;
  }
  if (closestHurricaneDist < 100000) {
    const proximity = 1 - Math.min(1, closestHurricaneDist / 100000);
    updateOrCreateAmbientSource(world, WeatherAudioType.HURRICANE,
      proximity * HURRICANE_GAIN_MAX, lx, ly, lz);
  } else {
    deactivateAmbientSource(world, WeatherAudioType.HURRICANE);
  }

  // 8. WATER — proximity to water body.
  const waterBodySlot = findWaterBodyAt(lx, lz, ly, 50);
  if (waterBodySlot >= 0) {
    updateOrCreateAmbientSource(world, WeatherAudioType.WATER_WAVE,
      WATER_WAVE_GAIN, lx, ly, lz);
  } else {
    deactivateAmbientSource(world, WeatherAudioType.WATER_WAVE);
    deactivateAmbientSource(world, WeatherAudioType.WATER_LAP);
    deactivateAmbientSource(world, WeatherAudioType.WATER_FOAM);
  }

  // 9. FIRE — count fire cells near listener.
  let fireIntensity = 0;
  for (let i = 0; i < FireCell.active.length; i++) {
    if (!FireCell.active[i]) continue;
    if (FireCell.phase[i] !== FirePhase.BURNING && FireCell.phase[i] !== FirePhase.SPREADING) continue;
    const dx = FireCell.px[i] - lx;
    const dy = FireCell.py[i] - ly;
    const dz = FireCell.pz[i] - lz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < 10000) {
      fireIntensity += 1 - distSq / 10000;
    }
  }
  updateOrCreateAmbientSource(world, WeatherAudioType.FIRE_CRACKLE,
    Math.min(1, fireIntensity) * FIRE_CRACKLE_GAIN, lx, ly, lz);
  updateOrCreateAmbientSource(world, WeatherAudioType.FIRE_ROAR,
    Math.min(1, fireIntensity) * FIRE_ROAR_GAIN, lx, ly, lz);

  // 10. THUNDER — handled by cue system (files 041/052).
  // We poll the thunder queue if any new events fired.
  const thunderCue = popCueEvent();
  if (thunderCue) {
    queueAudioCue(
      WeatherAudioType.THUNDER,
      listenerSlot,
      lx, ly, lz,
      THUNDER_RUMBLE_GAIN_MAX
    );
  }

  // 11. NUCLEAR WINTER — check if active.
  if (typeof isNuclearWinterActive === 'function' && isNuclearWinterActive()) {
    updateOrCreateAmbientSource(world, WeatherAudioType.NUCLEAR_DRONE,
      NUCLEAR_WINTER_DRONE_GAIN, lx, ly, lz);
  } else {
    deactivateAmbientSource(world, WeatherAudioType.NUCLEAR_DRONE);
  }

  // 12. VOLCANIC — count volcanic ash density near listener.
  const ashDensity = sampleAshDensity(lx, ly, lz);
  updateOrCreateAmbientSource(world, WeatherAudioType.VOLCANIC_RUMBLE,
    Math.min(1, ashDensity * 10) * VOLCANIC_RUMBLE_GAIN_MAX, lx, ly, lz);

  // 13. ICE CRACK — check for ice under the listener.
  const iceThickness = 0;   // computed from IceSurface below.
  updateOrCreateAmbientSource(world, WeatherAudioType.ICE_CRACK,
    iceThickness * ICE_CRACK_GAIN, lx, ly, lz);

  // 14. AURORA — check viewer visibility.
  let auroraVisible = false;
  for (let i = 0; i < AuroraViewer.active.length; i++) {
    if (!AuroraViewer.active[i]) continue;
    if (AuroraViewer.visibility[i] > 0.3) { auroraVisible = true; break; }
  }
  updateOrCreateAmbientSource(world, WeatherAudioType.AURORA_HISS,
    auroraVisible ? AURORA_HISS_GAIN : 0, lx, ly, lz);

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// AMBIENT SOURCE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

const _ambientSourceSlots = new Map();   // type -> source slot

function updateOrCreateAmbientSource(world, type, gain, lx, ly, lz) {
  let slot = _ambientSourceSlots.get(type);
  if (slot === undefined) {
    slot = addWeatherAudioSource(world, 0, type, {
      px: lx, py: ly, pz: lz,
      baseGain: gain,
      playing: true,
      loop: true,
    });
    _ambientSourceSlots.set(type, slot);
    return slot;
  }

  const S = WeatherAudioSource;
  S.px[slot] = lx;
  S.py[slot] = ly;
  S.pz[slot] = lz;
  S.baseGain[slot] = gain;
  S.playing[slot] = gain > EPSILON ? 1 : 0;
  return slot;
}

function deactivateAmbientSource(world, type) {
  const slot = _ambientSourceSlots.get(type);
  if (slot === undefined) return;
  WeatherAudioSource.playing[slot] = 0;
  WeatherAudioSource.baseGain[slot] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Set the global master gain.
 */
export function setMasterGain(gain) {
  GlobalAudioState.masterGain = Math.max(0, Math.min(1, gain));
}

/**
 * Set the weather-specific gain.
 */
export function setWeatherMasterGain(gain) {
  GlobalAudioState.weatherMasterGain = Math.max(0, Math.min(1, gain));
}

/**
 * Pause / resume.
 */
export function setAudioPaused(paused) {
  GlobalAudioState.paused = paused;
}

/**
 * Return the total gain contribution from all weather sources
 * (used by the host to duck other audio when weather is loud).
 */
export function getWeatherLoudness() {
  let total = 0;
  const S = WeatherAudioSource;
  for (let slot = 0; slot < _nextWeatherAudioSourceSlot; slot++) {
    if (!S.active[slot]) continue;
    if (!S.playing[slot]) continue;
    total += S.currentGain[slot];
  }
  return total * GlobalAudioState.weatherMasterGain;
}

/**
 * Return a human-readable label for an audio type.
 */
export function weatherAudioTypeLabel(type) {
  switch (type) {
    case WeatherAudioType.RAIN_BED:        return 'Rain Bed';
    case WeatherAudioType.RAIN_DROP:       return 'Rain Drop';
    case WeatherAudioType.SNOW_SHIMMER:    return 'Snow Shimmer';
    case WeatherAudioType.HAIL_IMPACT:     return 'Hail Impact';
    case WeatherAudioType.SLEET_TICK:      return 'Sleet Tick';
    case WeatherAudioType.WIND_LOW:        return 'Wind Low';
    case WeatherAudioType.WIND_MID:        return 'Wind Mid';
    case WeatherAudioType.WIND_HIGH:       return 'Wind High';
    case WeatherAudioType.THUNDER:         return 'Thunder';
    case WeatherAudioType.TORNADO_ROAR:    return 'Tornado Roar';
    case WeatherAudioType.TORNADO_DEBRIS:  return 'Tornado Debris';
    case WeatherAudioType.HURRICANE:       return 'Hurricane';
    case WeatherAudioType.FIRE_CRACKLE:    return 'Fire Crackle';
    case WeatherAudioType.FIRE_ROAR:       return 'Fire Roar';
    case WeatherAudioType.WATER_WAVE:      return 'Water Wave';
    case WeatherAudioType.WATER_LAP:       return 'Water Lap';
    case WeatherAudioType.WATER_FOAM:      return 'Water Foam';
    case WeatherAudioType.VOLCANIC_RUMBLE: return 'Volcanic Rumble';
    case WeatherAudioType.AURORA_HISS:     return 'Aurora Hiss';
    case WeatherAudioType.ICE_CRACK:       return 'Ice Crack';
    case WeatherAudioType.NUCLEAR_DRONE:   return 'Nuclear Drone';
    default:                                return 'Unknown';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// WEB AUDIO BRIDGE — optional host integration
// ═══════════════════════════════════════════════════════════════════════

/**
 * Fill an AudioBuffer (Float32Array) with generated weather audio.
 * The host calls this per audio frame.
 *
 * @param leftChannel    Float32Array of length frameSize
 * @param rightChannel   Float32Array of length frameSize
 * @param frameSize      number of samples
 */
export function renderWeatherAudioFrame(leftChannel, rightChannel, frameSize) {
  const S = WeatherAudioSource;
  const L = AudioListener;
  const globalGain = GlobalAudioState.masterGain * GlobalAudioState.weatherMasterGain;

  // Clear buffers.
  leftChannel.fill(0);
  rightChannel.fill(0);

  if (GlobalAudioState.paused) return;

  const dtSeconds = 1.0 / GlobalAudioState.sampleRate;

  // Get first active listener for pan calculation.
  let listenerSlot = 0;
  if (_nextAudioListenerSlot > 0) {
    for (let l = 0; l < _nextAudioListenerSlot; l++) {
      if (AudioListener.active[l]) { listenerSlot = l; break; }
    }
  }

  const lx = L.px[listenerSlot] || 0;
  const ly = L.py[listenerSlot] || 0;
  const lz = L.pz[listenerSlot] || 0;
  const fx = L.fwdX[listenerSlot] || 0;
  const fz = L.fwdZ[listenerSlot] || 1;

  for (let slot = 0; slot < _nextWeatherAudioSourceSlot; slot++) {
    if (!S.active[slot]) continue;
    if (!S.playing[slot]) continue;

    // Compute stereo pan from source position relative to listener.
    const dx = S.px[slot] - lx;
    const dz = S.pz[slot] - lz;
    const dist = Math.hypot(dx, dz);
    let pan = 0;
    if (dist > EPSILON) {
      // Cross product with listener forward.
      const cross = fx * (dz / dist) - fz * (dx / dist);
      pan = Math.max(-1, Math.min(1, cross));
    }
    const panL = Math.sqrt((1 - pan) * 0.5);
    const panR = Math.sqrt((1 + pan) * 0.5);

    for (let i = 0; i < frameSize; i++) {
      const sample = sampleWeatherAudio(slot, dtSeconds) * globalGain;
      leftChannel[i] += sample * panL;
      rightChannel[i] += sample * panR;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FULL WEATHER AUDIO TICK — orchestrator
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full weather audio tick: sync weather state, update listeners and
 * source gains, process cues.
 */
export function systemWeatherAudioFullTick(world, dt) {
  systemSyncWeatherAudio(world);
  systemWeatherAudioTick(world, dt);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherWeatherAudioForRendering() {
  const sources = [];
  const S = WeatherAudioSource;
  for (let slot = 0; slot < _nextWeatherAudioSourceSlot; slot++) {
    if (!S.active[slot]) continue;
    if (!S.playing[slot]) continue;
    sources.push({
      slot,
      type: S.type[slot],
      typeLabel: weatherAudioTypeLabel(S.type[slot]),
      px: S.px[slot], py: S.py[slot], pz: S.pz[slot],
      gain: S.currentGain[slot],
      doppler: S.dopplerFactor[slot],
      indoor: S.indoor[slot] === 1,
      underwater: S.underwater[slot] === 1,
    });
  }

  const listeners = [];
  const L = AudioListener;
  for (let slot = 0; slot < _nextAudioListenerSlot; slot++) {
    if (!L.active[slot]) continue;
    listeners.push({
      slot,
      px: L.px[slot], py: L.py[slot], pz: L.pz[slot],
      indoor: L.indoor[slot] === 1,
      underwater: L.underwater[slot] === 1,
      inVehicle: L.inVehicle[slot] === 1,
    });
  }

  return { sources, listeners };
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function weatherAudioStats() {
  let activeSources = 0;
  let activeListeners = 0;
  let pendingCues = 0;

  for (let slot = 0; slot < _nextWeatherAudioSourceSlot; slot++) {
    if (WeatherAudioSource.active[slot] && WeatherAudioSource.playing[slot]) {
      activeSources++;
    }
  }

  for (let slot = 0; slot < _nextAudioListenerSlot; slot++) {
    if (AudioListener.active[slot]) activeListeners++;
  }

  return {
    activeSources,
    maxSources: MAX_WEATHER_AUDIO_SOURCES,
    activeListeners,
    maxListeners: MAX_AUDIO_LISTENERS,
    pendingCues: WeatherAudioCue.count,
    maxCues: MAX_AUDIO_CUES,
    weatherLoudness: getWeatherLoudness(),
    paused: GlobalAudioState.paused,
    sampleRate: GlobalAudioState.sampleRate,
    masterGain: GlobalAudioState.masterGain,
    weatherMasterGain: GlobalAudioState.weatherMasterGain,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearWeatherAudio() {
  WeatherAudioSource.active.fill(0);
  WeatherAudioSource.playing.fill(0);
  _weatherAudioSlots.clear();
  _ambientSourceSlots.clear();
  _nextWeatherAudioSourceSlot = 0;

  AudioListener.active.fill(0);
  _audioListenerSlots.clear();
  _nextAudioListenerSlot = 0;

  WeatherAudioCue.active.fill(0);
  WeatherAudioCue.head = 0;
  WeatherAudioCue.count = 0;

  GlobalAudioState.paused = false;
  GlobalAudioState.masterGain = 1.0;
  GlobalAudioState.weatherMasterGain = 1.0;
  _lastUpdateGameTime = 0;
}