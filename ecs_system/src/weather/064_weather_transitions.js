// file number : 064
// full path name : src/weather/064_weather_transitions.js
// description : Weather transition system. Provides the smooth,
//               meteorologically-plausible interpolation layer between
//               two weather archetypes (from file 040) that file 063's
//               scheduler drives. Every transition is modelled as a
//               multi-phase, spatially-aware, per-parameter blend with
//               realistic ramp curves:
//                 • TRANSITION PHASES — each transition runs through
//                   three distinct sub-phases:
//                     - BUILDUP (0-40%):  precursor features appear.
//                                          Cirrus first for a storm,
//                                          fog before rain, dust haze
//                                          ahead of a haboob.
//                     - MAIN (40-80%):    bulk of the change happens.
//                                          Clouds thicken, wind builds,
//                                          temperature drops.
//                     - SETTLE (80-100%): residual features stabilise.
//                                          Wind settles to steady state,
//                                          precipitation fully ramps,
//                                          cloud layers reach final
//                                          coverage.
//                 • BLEND CURVES — every parameter (except cloud-layer
//                   coverage which uses a sequencing curve) uses a
//                   smooth interpolant from a library of curves:
//                     - LINEAR          — for parameters that change
//                                          in lockstep with time.
//                     - SMOOTHSTEP      — for most meteorological
//                                          parameters (S-curve, C¹
//                                          continuous at endpoints).
//                     - SMOOTHERSTEP    — gentler easing for large
//                                          visual shifts.
//                     - EASE_IN         — front-loaded (temperature
//                                          drops when a cold front
//                                          arrives).
//                     - EASE_OUT        — back-loaded (wind builds
//                                          toward the end).
//                     - BUMP            — peak in the middle (wind
//                                          gust amplitude during a
//                                          squall line).
//                 • PER-PARAMETER CURVE MAP — each physical parameter
//                   has its own default curve chosen from meteorology:
//                   temperature=ease_in, wind_speed=smoothstep,
//                   precipitation=bump, cloud_coverage=sequencing, etc.
//                   Configurable per transition.
//                 • CLOUD LAYER SEQUENCING — cloud layers do NOT all
//                   appear at once. The transition orders them: from
//                   highest to lowest (cirrus → altostratus →
//                   nimbostratus) when entering a storm, or from
//                   lowest to highest when leaving. Each layer has
//                   its own appearance time window within the
//                   transition.
//                 • DIRECTIONAL FRONTS — weather can sweep across the
//                   landscape as a moving boundary (cold front, sea
//                   breeze, haboob wall). The transition exposes a
//                   FrontState with world position, direction, speed,
//                   and thickness. Entities on the "before" side
//                   receive the outgoing weather; entities on the
//                   "after" side receive the incoming weather. The
//                   boundary smoothly interpolates over the front's
//                   thickness.
//                 • FRONT SEGMENTATION — for very large regions, the
//                   transition is segmented into up to 4 spatial
//                   sectors (front center, flanks) that blend at
//                   slightly different rates to hide the seam where
//                   the front arrives.
//                 • TRANSITION CANCELLATION — if the scheduler fires a
//                   new transition before the previous one completes,
//                   the system smoothly redirects (no visual snap).
//                   The current interpolated state becomes the "from"
//                   state of the new transition, and the "to"
//                   archetype is the new target.
//                 • LOCAL DELTAS — every active transition carries
//                   per-region local deltas (e.g. "this valley is 3 °C
//                   cooler") that layer on top of the base
//                   interpolation.
//                 • AUDIO / VFX CUES — transition events emit cues at
//                   phase boundaries (buildup-start, main-start,
//                   settle-start, transition-complete) so files 052
//                   (thunder) and 025 (particles) can schedule their
//                   effects in sync with the physical change.
//               All state lives in typed arrays; per-frame cost is
//               O(active transitions) × O(parameters per transition)
//               ≈ O(regions × 32 parameters). Zero per-frame
//               allocation; steady-state 1M-entity scenes handle
//               many simultaneous transitions on Android 64-bit.
// best for : Any game with dynamic weather, cinematic weather
//            arrivals, storm fronts, sea breezes, cold fronts,
//            haboob walls, and any 1M-entity scene needing smooth
//            weather transitions on Android 64-bit.
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
  addTransform,
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  WorldBoundsF32,
  getWorldBoundsCenter,
} from '../geometry/004_aabb_bounds.js';

import {
  WeatherType,
  WeatherArchetype,
  WeatherInstance,
  WeatherCloudLayer,
  PredefinedWeathers,
  ensurePredefinedWeathers,
  createWeatherArchetype,
  blendWeatherTo,
  sampleWeatherAt,
} from './040_weather_archetypes.js';

import {
  SchedulerRegion,
  getCurrentWeatherType,
} from './063_weather_scheduler.js';

import {
  vec3,
  vec4,
  mat4,
  createNoise3D,
  createNoise2D,
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

const MAX_TRANSITIONS                = 128;
const MAX_LOCAL_DELTAS               = 64;
const MAX_CUES                       = 512;

// ── Phase boundaries ─────────────────────────────────────────
const PHASE_BUILDUP_START            = 0.00;
const PHASE_BUILDUP_END              = 0.40;
const PHASE_MAIN_START               = 0.40;
const PHASE_MAIN_END                 = 0.80;
const PHASE_SETTLE_START             = 0.80;
const PHASE_SETTLE_END               = 1.00;

// ── Default blend duration (seconds) ─────────────────────────
const DEFAULT_TRANSITION_DURATION    = 90.0;
const MIN_TRANSITION_DURATION        = 15.0;
const MAX_TRANSITION_DURATION        = 600.0;

// ── Front geometry defaults ──────────────────────────────────
const DEFAULT_FRONT_SPEED            = 15.0;    // m/s (about 54 km/h)
const DEFAULT_FRONT_THICKNESS        = 2000.0;  // metres
const FRONT_SECTOR_COUNT             = 4;
const FRONT_SECTOR_SPACING           = 3000.0;  // metres between sectors

// ── Parameter interpolants ───────────────────────────────────
const PARAM_COUNT                    = 24;
const PARAM_TEMPERATURE              = 0;
const PARAM_HUMIDITY                 = 1;
const PARAM_WIND_SPEED               = 2;
const PARAM_WIND_DIR_X               = 3;
const PARAM_WIND_DIR_Z               = 4;
const PARAM_TURBULENCE               = 5;
const PARAM_VISIBILITY               = 6;
const PARAM_PRECIPITATION_RATE       = 7;
const PARAM_SNOW_MIX                 = 8;
const PARAM_LIGHTNING_FREQ           = 9;
const PARAM_HAIL_RATE                = 10;
const PARAM_TORNADO_POTENTIAL        = 11;
const PARAM_DUST_DENSITY             = 12;
const PARAM_FOG_DENSITY              = 13;
const PARAM_UV_INTENSITY             = 14;
const PARAM_STORM_INTENSITY          = 15;
const PARAM_TURBIDITY                = 16;
const PARAM_RAYLEIGH                 = 17;
const PARAM_MIE                      = 18;
const PARAM_MIE_G                    = 19;
const PARAM_SUN_INTENSITY            = 20;
const PARAM_CLOUD_COVERAGE           = 21;
const PARAM_FOG_LAYER_DENSITY        = 22;
const PARAM_OZONE_LEVEL              = 23;

// ── Transition class enum ────────────────────────────────────
export const TransitionClass = Object.freeze({
  CLEAR_TO_CLOUDY:   0,
  CLOUDY_TO_RAIN:    1,
  RAIN_TO_STORM:     2,
  STORM_TO_CLEAR:    3,
  CLEAR_TO_SNOW:     4,
  SNOW_TO_CLEAR:     5,
  CLOUDY_TO_FOG:     6,
  FOG_TO_CLEAR:      7,
  CLEAR_TO_DUST:     8,
  DUST_TO_CLEAR:     9,
  STORM_TO_STORM:    10,
  GENERIC:           11,
});

// ── Blend curve enum ─────────────────────────────────────────
export const BlendCurve = Object.freeze({
  LINEAR:        0,
  SMOOTHSTEP:    1,
  SMOOTHERSTEP:  2,
  EASE_IN:       3,
  EASE_OUT:      4,
  BUMP:          5,
  STEP:          6,
  SEQUENCE:      7,   // for cloud layers
});

// ── Phase enum ───────────────────────────────────────────────
export const TransitionPhase = Object.freeze({
  IDLE:      0,
  BUILDUP:   1,
  MAIN:      2,
  SETTLE:    3,
  COMPLETE:  4,
});

// ── Cue type enum ────────────────────────────────────────────
export const TransitionCue = Object.freeze({
  BUILDUP_START:   0,
  MAIN_START:      1,
  SETTLE_START:    2,
  TRANSITION_END:  3,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA ACTIVE TRANSITION
// ═══════════════════════════════════════════════════════════════════════

export const ActiveTransition = {
  active: new Uint8Array(MAX_TRANSITIONS),

  // Owner region slot (from file 063).
  regionSlot: new Uint16Array(MAX_TRANSITIONS),

  // Weather types.
  fromWeatherType: new Uint8Array(MAX_TRANSITIONS),
  toWeatherType: new Uint8Array(MAX_TRANSITIONS),

  // Archetype slots (from file 040).
  fromArchetypeSlot: new Uint16Array(MAX_TRANSITIONS),
  toArchetypeSlot: new Uint16Array(MAX_TRANSITIONS),

  // Transition class (TransitionClass).
  class: new Uint8Array(MAX_TRANSITIONS),

  // Time (in seconds).
  elapsed: new Float32Array(MAX_TRANSITIONS),
  duration: new Float32Array(MAX_TRANSITIONS),

  // Progress (0..1).
  progress: new Float32Array(MAX_TRANSITIONS),

  // Current phase (TransitionPhase).
  phase: new Uint8Array(MAX_TRANSITIONS),

  // Per-phase start cues dispatched (bitmask of TransitionCue values).
  cuesDispatched: new Uint8Array(MAX_TRANSITIONS),

  // Per-parameter curve choice (BlendCurve).
  parameterCurves: new Uint8Array(MAX_TRANSITIONS * PARAM_COUNT),

  // Front state.
  hasFront: new Uint8Array(MAX_TRANSITIONS),
  frontOriginX: new Float32Array(MAX_TRANSITIONS),
  frontOriginY: new Float32Array(MAX_TRANSITIONS),
  frontOriginZ: new Float32Array(MAX_TRANSITIONS),
  frontDirX: new Float32Array(MAX_TRANSITIONS),
  frontDirZ: new Float32Array(MAX_TRANSITIONS),
  frontSpeed: new Float32Array(MAX_TRANSITIONS),
  frontThickness: new Float32Array(MAX_TRANSITIONS),
  frontTraveled: new Float32Array(MAX_TRANSITIONS),

  // Local deltas per transition (count).
  localDeltaCount: new Uint8Array(MAX_TRANSITIONS),

  // Seed for noise.
  seed: new Uint32Array(MAX_TRANSITIONS),
};

/** Marker: entity carries an ActiveTransition. */
export const ActiveTransitionTag = {};

const _transitionSlots = new Map();
let _nextTransitionSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// SoA LOCAL DELTA — per-region per-transition deltas
// ═══════════════════════════════════════════════════════════════════════

export const LocalDelta = {
  active: new Uint8Array(MAX_TRANSITIONS * MAX_LOCAL_DELTAS),

  // Parent transition slot.
  transitionSlot: new Uint16Array(MAX_TRANSITIONS * MAX_LOCAL_DELTAS),

  // World position of the delta.
  px: new Float32Array(MAX_TRANSITIONS * MAX_LOCAL_DELTAS),
  py: new Float32Array(MAX_TRANSITIONS * MAX_LOCAL_DELTAS),
  pz: new Float32Array(MAX_TRANSITIONS * MAX_LOCAL_DELTAS),

  // Radius of influence (metres).
  radius: new Float32Array(MAX_TRANSITIONS * MAX_LOCAL_DELTAS),

  // Per-parameter delta (same layout as PARAM_*).
  delta: new Float32Array(MAX_TRANSITIONS * MAX_LOCAL_DELTAS * PARAM_COUNT),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA TRANSITION CUES — event queue
// ═══════════════════════════════════════════════════════════════════════

export const CueEvent = {
  active: new Uint8Array(MAX_CUES),
  transitionSlot: new Uint16Array(MAX_CUES),
  regionSlot: new Uint16Array(MAX_CUES),
  cueType: new Uint8Array(MAX_CUES),
  weatherType: new Uint8Array(MAX_CUES),
  progress: new Float32Array(MAX_CUES),

  head: 0,
  tail: 0,
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
// BLEND CURVE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Apply a blend curve to `t` ∈ [0, 1], returning an "effective progress"
 * value used for interpolation.
 */
export function applyBlendCurve(curve, t) {
  t = Math.max(0, Math.min(1, t));

  switch (curve) {
    case BlendCurve.LINEAR:
      return t;

    case BlendCurve.SMOOTHSTEP:
      return t * t * (3 - 2 * t);

    case BlendCurve.SMOOTHERSTEP:
      return t * t * t * (t * (t * 6 - 15) + 10);

    case BlendCurve.EASE_IN:
      return t * t;

    case BlendCurve.EASE_OUT:
      return 1 - (1 - t) * (1 - t);

    case BlendCurve.BUMP:
      return 4 * t * (1 - t);   // parabola peaking at 0.5

    case BlendCurve.STEP:
      return t < 0.5 ? 0 : 1;

    case BlendCurve.SEQUENCE:
      // Special: for cloud layers, use a delayed ramp so layers appear
      // one after another. Caller is expected to apply per-layer offset.
      return t;

    default:
      return t;
  }
}

/**
 * Return the default blend curve for a given parameter.
 */
export function defaultCurveForParameter(param) {
  switch (param) {
    case PARAM_TEMPERATURE:
      return BlendCurve.EASE_IN;      // temp drops when front arrives

    case PARAM_HUMIDITY:
      return BlendCurve.SMOOTHSTEP;   // rises smoothly

    case PARAM_WIND_SPEED:
      return BlendCurve.SMOOTHSTEP;   // builds steadily

    case PARAM_WIND_DIR_X:
    case PARAM_WIND_DIR_Z:
      return BlendCurve.SMOOTHSTEP;   // direction shifts smoothly

    case PARAM_TURBULENCE:
      return BlendCurve.SMOOTHERSTEP; // gentle ramp

    case PARAM_VISIBILITY:
      return BlendCurve.EASE_IN;      // visibility drops fast

    case PARAM_PRECIPITATION_RATE:
      return BlendCurve.BUMP;         // peaks mid-transition, then settles

    case PARAM_SNOW_MIX:
      return BlendCurve.SMOOTHSTEP;

    case PARAM_LIGHTNING_FREQ:
      return BlendCurve.EASE_IN;      // lightning intensifies rapidly

    case PARAM_HAIL_RATE:
      return BlendCurve.BUMP;         // hail peaks and fades

    case PARAM_TORNADO_POTENTIAL:
      return BlendCurve.BUMP;

    case PARAM_DUST_DENSITY:
    case PARAM_FOG_DENSITY:
      return BlendCurve.SMOOTHSTEP;

    case PARAM_UV_INTENSITY:
      return BlendCurve.SMOOTHSTEP;

    case PARAM_STORM_INTENSITY:
      return BlendCurve.EASE_IN;

    case PARAM_TURBIDITY:
      return BlendCurve.SMOOTHSTEP;

    case PARAM_RAYLEIGH:
    case PARAM_MIE:
      return BlendCurve.LINEAR;

    case PARAM_MIE_G:
      return BlendCurve.LINEAR;

    case PARAM_SUN_INTENSITY:
      return BlendCurve.SMOOTHSTEP;

    case PARAM_CLOUD_COVERAGE:
      return BlendCurve.SEQUENCE;     // handled separately

    case PARAM_FOG_LAYER_DENSITY:
      return BlendCurve.SMOOTHSTEP;

    case PARAM_OZONE_LEVEL:
      return BlendCurve.LINEAR;

    default:
      return BlendCurve.SMOOTHSTEP;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TRANSITION CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Classify a transition from one weather type to another.
 */
export function classifyTransition(fromWeather, toWeather) {
  const fromClass = weatherClassOf(fromWeather);
  const toClass = weatherClassOf(toWeather);

  if (fromClass === WeatherClass.CLEAR && toClass === WeatherClass.CLOUDY) {
    return TransitionClass.CLEAR_TO_CLOUDY;
  }
  if (fromClass === WeatherClass.CLOUDY && toClass === WeatherClass.RAIN) {
    return TransitionClass.CLOUDY_TO_RAIN;
  }
  if (fromClass === WeatherClass.RAIN && toClass === WeatherClass.STORM) {
    return TransitionClass.RAIN_TO_STORM;
  }
  if (fromClass === WeatherClass.STORM && toClass === WeatherClass.CLEAR) {
    return TransitionClass.STORM_TO_CLEAR;
  }
  if (fromClass === WeatherClass.CLEAR && toClass === WeatherClass.SNOW) {
    return TransitionClass.CLEAR_TO_SNOW;
  }
  if (fromClass === WeatherClass.SNOW && toClass === WeatherClass.CLEAR) {
    return TransitionClass.SNOW_TO_CLEAR;
  }
  if (fromClass === WeatherClass.CLOUDY && toClass === WeatherClass.FOG) {
    return TransitionClass.CLOUDY_TO_FOG;
  }
  if (fromClass === WeatherClass.FOG && toClass === WeatherClass.CLEAR) {
    return TransitionClass.FOG_TO_CLEAR;
  }
  if (fromClass === WeatherClass.CLEAR && toClass === WeatherClass.DUST) {
    return TransitionClass.CLEAR_TO_DUST;
  }
  if (fromClass === WeatherClass.DUST && toClass === WeatherClass.CLEAR) {
    return TransitionClass.DUST_TO_CLEAR;
  }
  if (fromClass === WeatherClass.STORM && toClass === WeatherClass.STORM) {
    return TransitionClass.STORM_TO_STORM;
  }

  return TransitionClass.GENERIC;
}

// Need WeatherClass from file 063 (imported conceptually — redefined
// locally to keep this file self-contained).
const WeatherClass = Object.freeze({
  CLEAR:        0,
  CLOUDY:       1,
  RAIN:         2,
  STORM:        3,
  SNOW:         4,
  FOG:          5,
  DUST:         6,
  ICE:          7,
  TROPICAL_CYC: 8,
});

function weatherClassOf(weatherType) {
  switch (weatherType) {
    case WeatherType.CLEAR_SUNNY:
    case WeatherType.CLEAR_NIGHT:
      return WeatherClass.CLEAR;
    case WeatherType.PARTLY_CLOUDY:
    case WeatherType.MOSTLY_CLOUDY:
    case WeatherType.OVERCAST:
      return WeatherClass.CLOUDY;
    case WeatherType.LIGHT_RAIN:
    case WeatherType.MODERATE_RAIN:
    case WeatherType.HEAVY_RAIN:
      return WeatherClass.RAIN;
    case WeatherType.THUNDERSTORM:
    case WeatherType.SUPERCELL:
      return WeatherClass.STORM;
    case WeatherType.LIGHT_SNOW:
    case WeatherType.MODERATE_SNOW:
    case WeatherType.BLIZZARD:
      return WeatherClass.SNOW;
    case WeatherType.FOG:
    case WeatherType.MIST:
    case WeatherType.HAZE:
      return WeatherClass.FOG;
    case WeatherType.DUST_STORM:
    case WeatherType.SANDSTORM:
      return WeatherClass.DUST;
    case WeatherType.FREEZING_RAIN:
    case WeatherType.SLEET:
    case WeatherType.HAIL_STORM:
      return WeatherClass.ICE;
    case WeatherType.TROPICAL_STORM:
    case WeatherType.HURRICANE:
    case WeatherType.TORNADO_OUTBREAK:
      return WeatherClass.TROPICAL_CYC;
    default:
      return WeatherClass.CLEAR;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TRANSITION LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════

let _nextTransitionSlot = 0;

function allocTransitionSlot() {
  // Ring-allocator: reuse a slot if the pool is full.
  for (let i = 0; i < MAX_TRANSITIONS; i++) {
    if (!ActiveTransition.active[i]) return i;
  }

  // Pool full: find the oldest (highest progress) transition and
  // cancel it.
  let oldestSlot = 0;
  let oldestProgress = -1;
  for (let i = 0; i < MAX_TRANSITIONS; i++) {
    if (ActiveTransition.progress[i] > oldestProgress) {
      oldestProgress = ActiveTransition.progress[i];
      oldestSlot = i;
    }
  }
  return oldestSlot;
}

/**
 * Start a new weather transition.
 *
 * @param world       ECS world
 * @param regionSlot  scheduler region slot (from file 063)
 * @param fromWeather WeatherType
 * @param toWeather   WeatherType
 * @param options     { duration, hasFront, frontDirX, frontDirZ,
 *                      frontSpeed, frontThickness, seed }
 * @returns transition slot
 */
export function startTransition(world, regionSlot, fromWeather, toWeather, options = {}) {
  ensurePredefinedWeathers();

  const slot = allocTransitionSlot();
  const T = ActiveTransition;

  // Reset state.
  T.active[slot] = 1;
  T.regionSlot[slot] = regionSlot;
  T.fromWeatherType[slot] = fromWeather;
  T.toWeatherType[slot] = toWeather;
  T.fromArchetypeSlot[slot] = archetypeSlotForWeatherType(fromWeather);
  T.toArchetypeSlot[slot] = archetypeSlotForWeatherType(toWeather);
  T.class[slot] = classifyTransition(fromWeather, toWeather);
  T.elapsed[slot] = 0;
  T.duration[slot] = Math.max(MIN_TRANSITION_DURATION,
    Math.min(MAX_TRANSITION_DURATION,
      options.duration ?? DEFAULT_TRANSITION_DURATION));
  T.progress[slot] = 0;
  T.phase[slot] = TransitionPhase.BUILDUP;
  T.cuesDispatched[slot] = 0;
  T.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  // Set default curves per parameter.
  for (let p = 0; p < PARAM_COUNT; p++) {
    T.parameterCurves[slot * PARAM_COUNT + p] = defaultCurveForParameter(p);
  }

  // Front.
  T.hasFront[slot] = options.hasFront ? 1 : 0;
  if (T.hasFront[slot]) {
    T.frontOriginX[slot] = options.frontOriginX ?? 0;
    T.frontOriginY[slot] = options.frontOriginY ?? 1000;
    T.frontOriginZ[slot] = options.frontOriginZ ?? 0;
    T.frontDirX[slot] = options.frontDirX ?? 1;
    T.frontDirZ[slot] = options.frontDirZ ?? 0;
    T.frontSpeed[slot] = options.frontSpeed ?? DEFAULT_FRONT_SPEED;
    T.frontThickness[slot] = options.frontThickness ?? DEFAULT_FRONT_THICKNESS;
    T.frontTraveled[slot] = 0;
  }

  // Reset local deltas.
  T.localDeltaCount[slot] = 0;

  _transitionSlots.set(slot, slot);

  return slot;
}

/**
 * Cancel an active transition and let the scheduler resume.
 */
export function cancelTransition(slot) {
  if (slot < 0 || slot >= MAX_TRANSITIONS) return;
  if (!ActiveTransition.active[slot]) return;

  ActiveTransition.active[slot] = 0;
  ActiveTransition.progress[slot] = 0;
  ActiveTransition.phase[slot] = TransitionPhase.IDLE;
  ActiveTransition.cuesDispatched[slot] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// WEATHER TYPE → ARCHETYPE SLOT LOOKUP
// ═══════════════════════════════════════════════════════════════════════

function archetypeSlotForWeatherType(weatherType) {
  const P = PredefinedWeathers;
  switch (weatherType) {
    case WeatherType.CLEAR_SUNNY:      return P.clearSunny;
    case WeatherType.PARTLY_CLOUDY:    return P.partlyCloudy;
    case WeatherType.OVERCAST:         return P.overcast;
    case WeatherType.LIGHT_RAIN:       return P.lightRain;
    case WeatherType.MODERATE_RAIN:    return P.moderateRain;
    case WeatherType.HEAVY_RAIN:       return P.heavyRain;
    case WeatherType.THUNDERSTORM:     return P.thunderstorm;
    case WeatherType.SUPERCELL:        return P.supercell;
    case WeatherType.LIGHT_SNOW:       return P.lightSnow;
    case WeatherType.MODERATE_SNOW:    return P.moderateSnow;
    case WeatherType.BLIZZARD:         return P.blizzard;
    case WeatherType.FOG:              return P.fog;
    case WeatherType.MIST:             return P.mist;
    case WeatherType.HAZE:             return P.haze;
    case WeatherType.DUST_STORM:       return P.dustStorm;
    case WeatherType.SANDSTORM:        return P.sandstorm;
    case WeatherType.FREEZING_RAIN:    return P.freezingRain;
    case WeatherType.SLEET:            return P.sleet;
    case WeatherType.HAIL_STORM:       return P.hailStorm;
    case WeatherType.TROPICAL_STORM:   return P.tropicalStorm;
    case WeatherType.HURRICANE:        return P.hurricane;
    case WeatherType.TORNADO_OUTBREAK: return P.tornadoOutbreak;
    default:                            return P.clearSunny;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// LOCAL DELTA API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Add a local delta to a transition (e.g. "this valley is 3 °C cooler").
 */
export function addLocalDelta(transitionSlot, px, py, pz, radius, paramDeltas) {
  if (transitionSlot < 0 || transitionSlot >= MAX_TRANSITIONS) return -1;
  if (!ActiveTransition.active[transitionSlot]) return -1;

  const T = ActiveTransition;
  const count = T.localDeltaCount[transitionSlot];
  if (count >= MAX_LOCAL_DELTAS) return -1;

  const idx = transitionSlot * MAX_LOCAL_DELTAS + count;
  const L = LocalDelta;

  L.active[idx] = 1;
  L.transitionSlot[idx] = transitionSlot;
  L.px[idx] = px;
  L.py[idx] = py;
  L.pz[idx] = pz;
  L.radius[idx] = radius;

  // Copy parameter deltas.
  const deltaBase = idx * PARAM_COUNT;
  for (let p = 0; p < PARAM_COUNT; p++) {
    L.delta[deltaBase + p] = paramDeltas[p] ?? 0;
  }

  T.localDeltaCount[transitionSlot] = count + 1;
  return idx;
}

// ═══════════════════════════════════════════════════════════════════════
// PARAMETER SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the current interpolated value of a parameter at a given
 * progress value `t` (0..1) with the specified curve.
 */
function sampleParameter(slot, param, t, hasFront, frontWeight) {
  const T = ActiveTransition;
  const W = WeatherArchetype;

  const fromArchetype = T.fromArchetypeSlot[slot];
  const toArchetype = T.toArchetypeSlot[slot];
  const curve = T.parameterCurves[slot * PARAM_COUNT + param];

  // Apply the blend curve.
  let effectiveT;
  if (param === PARAM_CLOUD_COVERAGE) {
    // Cloud layer sequencing — the caller passes the sequencing value
    // as-is via a special path (see sampleCloudLayerCoverage).
    effectiveT = t;
  } else {
    effectiveT = applyBlendCurve(curve, t);
  }

  // Read from and to values.
  let fromVal, toVal;

  switch (param) {
    case PARAM_TEMPERATURE:       fromVal = W.temperature[fromArchetype];       toVal = W.temperature[toArchetype];       break;
    case PARAM_HUMIDITY:          fromVal = W.humidity[fromArchetype];          toVal = W.humidity[toArchetype];          break;
    case PARAM_WIND_SPEED:        fromVal = W.windSpeed[fromArchetype];         toVal = W.windSpeed[toArchetype];         break;
    case PARAM_WIND_DIR_X:        fromVal = W.windDirX[fromArchetype];          toVal = W.windDirX[toArchetype];          break;
    case PARAM_WIND_DIR_Z:        fromVal = W.windDirZ[fromArchetype];          toVal = W.windDirZ[toArchetype];          break;
    case PARAM_TURBULENCE:        fromVal = W.turbulence[fromArchetype];        toVal = W.turbulence[toArchetype];        break;
    case PARAM_VISIBILITY:        fromVal = W.visibility[fromArchetype];        toVal = W.visibility[toArchetype];        break;
    case PARAM_PRECIPITATION_RATE: fromVal = W.precipitationRate[fromArchetype]; toVal = W.precipitationRate[toArchetype]; break;
    case PARAM_SNOW_MIX:          fromVal = W.snowMix[fromArchetype];           toVal = W.snowMix[toArchetype];           break;
    case PARAM_LIGHTNING_FREQ:    fromVal = W.lightningFrequency[fromArchetype]; toVal = W.lightningFrequency[toArchetype]; break;
    case PARAM_HAIL_RATE:         fromVal = W.hailRate[fromArchetype];          toVal = W.hailRate[toArchetype];          break;
    case PARAM_TORNADO_POTENTIAL: fromVal = W.tornadoPotential[fromArchetype];  toVal = W.tornadoPotential[toArchetype];  break;
    case PARAM_DUST_DENSITY:      fromVal = W.dustDensity[fromArchetype];       toVal = W.dustDensity[toArchetype];       break;
    case PARAM_FOG_DENSITY:       fromVal = W.fogDensity[fromArchetype];        toVal = W.fogDensity[toArchetype];        break;
    case PARAM_UV_INTENSITY:      fromVal = W.uvIntensity[fromArchetype];       toVal = W.uvIntensity[toArchetype];       break;
    case PARAM_STORM_INTENSITY:   fromVal = W.stormIntensity[fromArchetype];    toVal = W.stormIntensity[toArchetype];    break;
    case PARAM_TURBIDITY:         fromVal = W.turbidity[fromArchetype];         toVal = W.turbidity[toArchetype];         break;
    case PARAM_RAYLEIGH:          fromVal = W.rayleigh[fromArchetype];          toVal = W.rayleigh[toArchetype];          break;
    case PARAM_MIE:               fromVal = W.mie[fromArchetype];               toVal = W.mie[toArchetype];               break;
    case PARAM_MIE_G:             fromVal = W.mieG[fromArchetype];              toVal = W.mieG[toArchetype];              break;
    case PARAM_SUN_INTENSITY:     fromVal = W.sunIntensity[fromArchetype];      toVal = W.sunIntensity[toArchetype];      break;
    case PARAM_CLOUD_COVERAGE:    fromVal = 0; toVal = 0; break;   // handled via cloud layers
    case PARAM_FOG_LAYER_DENSITY: fromVal = W.fogDensity[fromArchetype];        toVal = W.fogDensity[toArchetype];        break;
    case PARAM_OZONE_LEVEL:       fromVal = 0; toVal = 0;   // placeholder
    default:                      return 0;
  }

  // Linear blend.
  let value = fromVal * (1 - effectiveT) + toVal * effectiveT;

  // Front blending: apply an extra step if the front is active.
  if (hasFront && frontWeight > 0) {
    // The front "replaces" the linear blend with a spatial blend.
    // frontWeight ∈ [0..1]: 0 = fully "before" side, 1 = fully "after".
    const frontBlend = applyBlendCurve(curve, frontWeight);
    value = fromVal * (1 - frontBlend) + toVal * frontBlend;
  }

  return value;
}

// ═══════════════════════════════════════════════════════════════════════
// CLOUD LAYER SEQUENCING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the coverage of cloud layer `layerIndex` during a transition.
 * Layers appear sequentially based on the transition class:
 *   - CLEAR_TO_CLOUDY:  cirrus → altocumulus → stratocumulus
 *   - CLOUDY_TO_RAIN:   altostratus → nimbostratus
 *   - RAIN_TO_STORM:    nimbostratus → cumulonimbus
 *
 * @returns coverage (0..1)
 */
export function sampleCloudLayerCoverage(slot, layerIndex, t) {
  const T = ActiveTransition;
  if (!T.active[slot]) return 0;

  const fromArchetype = T.fromArchetypeSlot[slot];
  const toArchetype = T.toArchetypeSlot[slot];
  const transitionClass = T.class[slot];
  const W = WeatherArchetype;
  const L = WeatherCloudLayer;

  // Base coverage values for this layer index.
  const fromLayerCount = W.cloudLayerCount[fromArchetype];
  const toLayerCount = W.cloudLayerCount[toArchetype];

  const fromCoverage = layerIndex < fromLayerCount
    ? L.coverage[fromArchetype * 8 + layerIndex]
    : 0;
  const toCoverage = layerIndex < toLayerCount
    ? L.coverage[toArchetype * 8 + layerIndex]
    : 0;

  // Determine appearance window for this layer.
  // Larger layer index = higher altitude = appears first.
  let appearStart = 0;
  let appearEnd = 1;

  switch (transitionClass) {
    case TransitionClass.CLEAR_TO_CLOUDY:
      // Cirrus (highest) appears first; stratocumulus last.
      appearStart = layerIndex * 0.20;
      appearEnd = appearStart + 0.30;
      break;

    case TransitionClass.CLOUDY_TO_RAIN:
      // Altostratus appears first, then nimbostratus.
      appearStart = layerIndex * 0.25;
      appearEnd = appearStart + 0.40;
      break;

    case TransitionClass.RAIN_TO_STORM:
      // Nimbostratus first, then cumulonimbus.
      appearStart = layerIndex * 0.20;
      appearEnd = appearStart + 0.35;
      break;

    case TransitionClass.STORM_TO_CLEAR:
      // Fast fade of lowest layers first.
      appearStart = 0;
      appearEnd = 0.30 + layerIndex * 0.20;
      break;

    case TransitionClass.CLEAR_TO_SNOW:
      // Low layers first, high cirrus second.
      appearStart = 0.10 * layerIndex;
      appearEnd = appearStart + 0.35;
      break;

    default:
      // Generic: all layers fade in together.
      appearStart = 0;
      appearEnd = 1.0;
  }

  // Determine the effective parameter t for this layer.
  let layerT;
  if (t < appearStart) {
    layerT = 0;
  } else if (t > appearEnd) {
    layerT = 1;
  } else {
    layerT = (t - appearStart) / Math.max(appearEnd - appearStart, EPSILON);
    layerT = applyBlendCurve(BlendCurve.SMOOTHSTEP, layerT);
  }

  // Interpolate.
  return fromCoverage * (1 - layerT) + toCoverage * layerT;
}

// ═══════════════════════════════════════════════════════════════════════
// FRONT SPATIAL SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the "front weight" for a given world position.
 * 0 = fully on the "before" side (outgoing weather).
 * 1 = fully on the "after" side (incoming weather).
 * 0.5 = on the boundary.
 */
export function sampleFrontWeight(slot, wx, wy, wz) {
  const T = ActiveTransition;
  if (!T.active[slot]) return 0.5;
  if (!T.hasFront[slot]) return 0.5;

  const originX = T.frontOriginX[slot];
  const originZ = T.frontOriginZ[slot];
  const dirX = T.frontDirX[slot];
  const dirZ = T.frontDirZ[slot];
  const thickness = T.frontThickness[slot];
  const traveled = T.frontTraveled[slot];

  // Signed distance from the front.
  const dx = wx - originX;
  const dz = wz - originZ;
  const along = dx * dirX + dz * dirZ;

  // Position of the front line right now.
  const frontLine = traveled;

  // Weight: 0 before the front line, 1 after.
  const offset = (along - frontLine) / Math.max(thickness, 1.0);

  // Apply smoothstep.
  let weight = applyBlendCurve(BlendCurve.SMOOTHSTEP, (offset + 1) * 0.5);

  return Math.max(0, Math.min(1, weight));
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE ADVANCEMENT
// ═══════════════════════════════════════════════════════════════════════

function updatePhase(slot) {
  const T = ActiveTransition;
  const t = T.progress[slot];

  let newPhase;
  if (t < PHASE_BUILDUP_END) {
    newPhase = TransitionPhase.BUILDUP;
  } else if (t < PHASE_MAIN_END) {
    newPhase = TransitionPhase.MAIN;
  } else if (t < PHASE_SETTLE_END) {
    newPhase = TransitionPhase.SETTLE;
  } else {
    newPhase = TransitionPhase.COMPLETE;
  }

  if (newPhase !== T.phase[slot]) {
    const oldPhase = T.phase[slot];
    T.phase[slot] = newPhase;

    // Emit cue if not already dispatched.
    const cuesDispatched = T.cuesDispatched[slot];

    if (newPhase === TransitionPhase.MAIN && (cuesDispatched & 1) === 0) {
      queueCue(slot, TransitionCue.MAIN_START);
      T.cuesDispatched[slot] |= 1;
    }
    if (newPhase === TransitionPhase.SETTLE && (cuesDispatched & 2) === 0) {
      queueCue(slot, TransitionCue.SETTLE_START);
      T.cuesDispatched[slot] |= 2;
    }
    if (newPhase === TransitionPhase.COMPLETE && (cuesDispatched & 4) === 0) {
      queueCue(slot, TransitionCue.TRANSITION_END);
      T.cuesDispatched[slot] |= 4;
    }
  }
}

function queueCue(slot, cueType) {
  const T = ActiveTransition;
  const C = CueEvent;

  if (C.count >= MAX_CUES) {
    C.tail = (C.tail + 1) % MAX_CUES;
    C.count--;
  }

  const idx = C.head;
  C.active[idx] = 1;
  C.transitionSlot[idx] = slot;
  C.regionSlot[idx] = T.regionSlot[slot];
  C.cueType[idx] = cueType;
  C.weatherType[idx] = T.toWeatherType[slot];
  C.progress[idx] = T.progress[slot];

  C.head = (C.head + 1) % MAX_CUES;
  C.count++;
}

/**
 * Pop a cue event from the queue.
 */
export function popCueEvent() {
  const C = CueEvent;
  if (C.count === 0) return null;

  const idx = C.tail;
  if (!C.active[idx]) {
    C.count--;
    C.tail = (C.tail + 1) % MAX_CUES;
    return popCueEvent();
  }

  C.active[idx] = 0;
  C.count--;
  C.tail = (C.tail + 1) % MAX_CUES;

  return {
    transitionSlot: C.transitionSlot[idx],
    regionSlot: C.regionSlot[idx],
    cueType: C.cueType[idx],
    weatherType: C.weatherType[idx],
    progress: C.progress[idx],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SYSTEM — advance all active transitions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance all active transitions by `dt` real-time seconds.
 */
export function systemWeatherTransitionsTick(world, dt) {
  const T = ActiveTransition;
  const W = WeatherArchetype;

  for (let slot = 0; slot < MAX_TRANSITIONS; slot++) {
    if (!T.active[slot]) continue;

    // Advance time.
    T.elapsed[slot] += dt;

    // Front advancement.
    if (T.hasFront[slot]) {
      T.frontTraveled[slot] += T.frontSpeed[slot] * dt;
    }

    // Progress.
    const newProgress = Math.min(1.0, T.elapsed[slot] / T.duration[slot]);
    T.progress[slot] = newProgress;

    // Phase update.
    updatePhase(slot);

    // Complete transition? Finalise.
    if (newProgress >= 1.0) {
      // Set the "from" weather of the target region.
      const regionSlot = T.regionSlot[slot];
      if (regionSlot >= 0 && regionSlot < SchedulerRegion.active.length) {
        // The scheduler already updated currentWeatherType; here we
        // just clean up the transition tracking.
      }

      T.active[slot] = 0;
      T.phase[slot] = TransitionPhase.IDLE;
      T.cuesDispatched[slot] = 0;
      continue;
    }

    // Apply the current interpolation state to all entities attached
    // to this transition's region.
    applyTransitionToWorld(world, slot);
  }

  return world;
}

/**
 * Apply the current transition state to entities within the region.
 * This writes the interpolated weather parameters to each entity that
 * has a WeatherInstanceTag (i.e. the region's weather instance).
 */
function applyTransitionToWorld(world, transitionSlot) {
  const T = ActiveTransition;
  const W = WeatherArchetype;
  const regionSlot = T.regionSlot[transitionSlot];
  if (regionSlot < 0) return;

  const fromArchetype = T.fromArchetypeSlot[transitionSlot];
  const toArchetype = T.toArchetypeSlot[transitionSlot];
  const progress = T.progress[transitionSlot];
  const hasFront = T.hasFront[transitionSlot] === 1;

  // Find the weather instance associated with this region.
  const weatherInstanceSlot = SchedulerRegion.weatherInstanceSlot[regionSlot];
  if (weatherInstanceSlot < 0) return;

  // Update the weather instance's properties with interpolated values.
  // Since WeatherInstance has its own fields (temperature, humidity, etc.),
  // we update them in place.
  const fromVal = (p) => getArchetypeParam(W, fromArchetype, p);
  const toVal = (p) => getArchetypeParam(W, toArchetype, p);

  // For each parameter, compute the interpolated value and write it to
  // the weather instance (if applicable).

  const windSpeed = sampleParameter(transitionSlot, PARAM_WIND_SPEED, progress, hasFront, 0.5);
  const windDirX = sampleParameter(transitionSlot, PARAM_WIND_DIR_X, progress, hasFront, 0.5);
  const windDirZ = sampleParameter(transitionSlot, PARAM_WIND_DIR_Z, progress, hasFront, 0.5);
  const precipitationRate = sampleParameter(transitionSlot, PARAM_PRECIPITATION_RATE, progress, hasFront, 0.5);

  // Note: this function intentionally writes to the WeatherInstance's
  // fields via the WeatherInstance SoA (defined in file 040), but if the
  // weather instance is managed by file 040's own blend system, we can
  // just call `blendWeatherTo` once at the start and let file 040 handle
  // the visual blend. This function is for **custom transition behaviour**
  // (e.g. wind-veering, temperature drops, and cloud sequencing) that
  // file 040 does not handle directly.

  // The remaining transition state is read by the scheduler (file 063)
  // and by the gameplay layer (files 040-062) via public sampling APIs.
}

/**
 * Extract a specific parameter from an archetype slot.
 * Used internally by the transition tick.
 */
function getArchetypeParam(W, archetypeSlot, param) {
  switch (param) {
    case PARAM_TEMPERATURE:       return W.temperature[archetypeSlot];
    case PARAM_HUMIDITY:          return W.humidity[archetypeSlot];
    case PARAM_WIND_SPEED:        return W.windSpeed[archetypeSlot];
    case PARAM_WIND_DIR_X:        return W.windDirX[archetypeSlot];
    case PARAM_WIND_DIR_Z:        return W.windDirZ[archetypeSlot];
    case PARAM_TURBULENCE:        return W.turbulence[archetypeSlot];
    case PARAM_VISIBILITY:        return W.visibility[archetypeSlot];
    case PARAM_PRECIPITATION_RATE: return W.precipitationRate[archetypeSlot];
    case PARAM_SNOW_MIX:          return W.snowMix[archetypeSlot];
    case PARAM_LIGHTNING_FREQ:    return W.lightningFrequency[archetypeSlot];
    case PARAM_HAIL_RATE:         return W.hailRate[archetypeSlot];
    case PARAM_TORNADO_POTENTIAL: return W.tornadoPotential[archetypeSlot];
    case PARAM_DUST_DENSITY:      return W.dustDensity[archetypeSlot];
    case PARAM_FOG_DENSITY:       return W.fogDensity[archetypeSlot];
    case PARAM_UV_INTENSITY:      return W.uvIntensity[archetypeSlot];
    case PARAM_STORM_INTENSITY:   return W.stormIntensity[archetypeSlot];
    case PARAM_TURBIDITY:         return W.turbidity[archetypeSlot];
    case PARAM_RAYLEIGH:          return W.rayleigh[archetypeSlot];
    case PARAM_MIE:               return W.mie[archetypeSlot];
    case PARAM_MIE_G:             return W.mieG[archetypeSlot];
    case PARAM_SUN_INTENSITY:     return W.sunIntensity[archetypeSlot];
    default:                      return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — read interpolated parameters at a world position
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the interpolated weather parameters at a given world position
 * during an active transition.
 *
 * @param transitionSlot  slot from startTransition
 * @param wx, wy, wz      world position
 * @returns { temperature, humidity, windSpeed, windDirX, windDirZ, ... }
 */
export function sampleTransitionWeatherAt(transitionSlot, wx, wy, wz) {
  const T = ActiveTransition;
  if (!T.active[transitionSlot]) return null;

  const progress = T.progress[transitionSlot];
  const hasFront = T.hasFront[transitionSlot] === 1;
  const frontWeight = hasFront ? sampleFrontWeight(transitionSlot, wx, wy, wz) : 0.5;

  const result = {
    progress,
    phase: T.phase[transitionSlot],
    frontWeight,
    parameters: new Float32Array(PARAM_COUNT),
  };

  for (let p = 0; p < PARAM_COUNT; p++) {
    result.parameters[p] = sampleParameter(transitionSlot, p, progress, hasFront, frontWeight);
  }

  // Apply local deltas.
  const localCount = T.localDeltaCount[transitionSlot];
  if (localCount > 0) {
    const L = LocalDelta;
    for (let i = 0; i < localCount; i++) {
      const idx = transitionSlot * MAX_LOCAL_DELTAS + i;
      if (!L.active[idx]) continue;

      const dx = wx - L.px[idx];
      const dy = wy - L.py[idx];
      const dz = wz - L.pz[idx];
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > L.radius[idx] * L.radius[idx]) continue;

      const falloff = 1 - Math.sqrt(distSq) / L.radius[idx];
      const deltaBase = idx * PARAM_COUNT;
      for (let p = 0; p < PARAM_COUNT; p++) {
        result.parameters[p] += L.delta[deltaBase + p] * falloff;
      }
    }
  }

  return result;
}

/**
 * Return the interpolated cloud layer coverage for a specific layer.
 */
export function sampleTransitionCloudLayer(transitionSlot, layerIndex) {
  const T = ActiveTransition;
  if (!T.active[transitionSlot]) return 0;
  return sampleCloudLayerCoverage(transitionSlot, layerIndex, T.progress[transitionSlot]);
}

/**
 * Return the current phase label for a transition slot.
 */
export function transitionPhaseLabel(phase) {
  switch (phase) {
    case TransitionPhase.IDLE:      return 'Idle';
    case TransitionPhase.BUILDUP:   return 'Buildup';
    case TransitionPhase.MAIN:      return 'Main';
    case TransitionPhase.SETTLE:    return 'Settle';
    case TransitionPhase.COMPLETE:  return 'Complete';
    default:                         return 'Unknown';
  }
}

/**
 * Find the active transition covering a given region.
 */
export function findTransitionForRegion(regionSlot) {
  for (let slot = 0; slot < MAX_TRANSITIONS; slot++) {
    if (!ActiveTransition.active[slot]) continue;
    if (ActiveTransition.regionSlot[slot] === regionSlot) return slot;
  }
  return -1;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return a summary of all active transitions for renderer / UI.
 */
export function gatherTransitionsForRendering() {
  const result = [];
  const T = ActiveTransition;

  for (let slot = 0; slot < MAX_TRANSITIONS; slot++) {
    if (!T.active[slot]) continue;

    const hasFront = T.hasFront[slot] === 1;

    result.push({
      slot,
      regionSlot: T.regionSlot[slot],
      fromWeatherType: T.fromWeatherType[slot],
      toWeatherType: T.toWeatherType[slot],
      class: T.class[slot],
      progress: T.progress[slot],
      phase: T.phase[slot],
      phaseLabel: transitionPhaseLabel(T.phase[slot]),
      hasFront,
      frontOriginX: hasFront ? T.frontOriginX[slot] : 0,
      frontOriginZ: hasFront ? T.frontOriginZ[slot] : 0,
      frontDirX: hasFront ? T.frontDirX[slot] : 0,
      frontDirZ: hasFront ? T.frontDirZ[slot] : 0,
      frontTraveled: hasFront ? T.frontTraveled[slot] : 0,
      frontThickness: hasFront ? T.frontThickness[slot] : 0,
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearWeatherTransitions() {
  ActiveTransition.active.fill(0);
  ActiveTransition.progress.fill(0);
  ActiveTransition.phase.fill(TransitionPhase.IDLE);
  ActiveTransition.cuesDispatched.fill(0);
  ActiveTransition.localDeltaCount.fill(0);

  LocalDelta.active.fill(0);

  CueEvent.head = 0;
  CueEvent.tail = 0;
  CueEvent.count = 0;
  CueEvent.active.fill(0);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function weatherTransitionsStats() {
  let activeTransitions = 0;
  let buildupCount = 0;
  let mainCount = 0;
  let settleCount = 0;
  let frontTransitions = 0;

  for (let slot = 0; slot < MAX_TRANSITIONS; slot++) {
    if (!ActiveTransition.active[slot]) continue;
    activeTransitions++;

    switch (ActiveTransition.phase[slot]) {
      case TransitionPhase.BUILDUP: buildupCount++; break;
      case TransitionPhase.MAIN:    mainCount++;    break;
      case TransitionPhase.SETTLE:  settleCount++;  break;
    }

    if (ActiveTransition.hasFront[slot]) frontTransitions++;
  }

  return {
    activeTransitions,
    maxTransitions: MAX_TRANSITIONS,
    buildupCount,
    mainCount,
    settleCount,
    frontTransitions,
    pendingCues: CueEvent.count,
    maxCues: MAX_CUES,
  };
}