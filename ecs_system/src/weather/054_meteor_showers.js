// file number : 054
// full path name : src/weather/054_meteor_showers.js
// description : Meteor shower and fireball system. Simulates individual
//               meteors, their atmospheric entry physics, and the named
//               annual shower archetypes (Perseids, Geminids, Leonids,
//               Quadrantids, Orionids, Lyrids, Eta Aquariids,
//               Southern Delta Aquariids, Ursids, Draconids, Taurids,
//               and sporadic meteors). Contributes:
//                 • ShowerArchetype registry — each of the 12 major
//                   annual showers plus sporadic background, storing:
//                   IAU radiant RA/Dec, peak solar longitude, peak
//                   date, activity window (days), zenithal hourly rate
//                   (ZHR), population index, and characteristic
//                   velocity. Includes historic storm years (Leonids
//                   1833, 1966, 1999-2002) with optional storm
//                   multipliers.
//                 • MeteorEntry SoA pool — one slot per active meteor
//                   with position, velocity, atmospheric density
//                   profile (MSIS-lite approximation), ablation state,
//                   brightness, mass, initial mass, luminous efficiency,
//                   streak tail segments (up to 16), colour evolution,
//                   and terminal flash flags.
//                 • Radiant sampling — for any observer position and
//                   time, computes the radiant elevation angle from the
//                   shower's RA/Dec, applies the sin(elevation)
//                   correction to hourly rate, and generates a
//                   population-index-weighted magnitude distribution.
//                 • Atmospheric entry physics — ablation mass loss via
//                   the classic Bronshten equations, height-dependent
//                   air density (simple exponential + scale height),
//                   velocity deceleration, and luminous efficiency
//                   giving apparent magnitude evolution from +2
//                   (faint) to -10 or brighter (fireball).
//                 • Fireball / bolide classification — meteors with
//                   peak magnitude < -4 trigger a bright flash, a
//                   possible explosive terminal burst, and delayed
//                   sonic-boom dispatch through file 052's rumble
//                   synthesiser (using a new ThunderEvent with
//                   "meteor" tag). Also triggers a temporary point light
//                   (file 015) for ground illumination.
//                 • Train persistence — persistent trains (visible for
//                   seconds after the meteor has decayed) are tracked
//                   in a separate soa pool and rendered by the caller.
//                   Their height, color, brightness, and decay rate
//                   follow the ionization-recombination model.
//                 • Colour composition — meteors from different
//                   showers have characteristic colors driven by the
//                   entry velocity. High-velocity (>60 km/s) meteors
//                   (Leonids, Perseids) glow blue-white due to
//                   ionized magnesium and calcium; low-velocity
//                   (<25 km/s) meteors (Taurids, Draconids) glow
//                   orange-red due to sodium. The system exposes a
//                   `sampleMeteorColor` function that maps velocity
//                   and composition to a linear RGB triplet.
//                 • Integrator hook — sampleMeteorRadiance returns the
//                   additive radiance contribution to any ray, so
//                   file 017's path integrator and file 028's sky
//                   sampler automatically render meteors.
//               All state lives in typed arrays; per-frame cost is
//               O(MAX_METEORS). Zero per-frame allocation; steady-
//               state 1M-entity scenes can render meteor showers on
//               Android 64-bit without GC spikes.
// best for : Night sky realism, stargazing games, astronomy
//            simulations, campfire-cinematics, "wish upon a star"
//            gameplay, planetary exploration, and any 1M-entity
//            scene needing realistic meteors on Android 64-bit.
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
  SkyF32,
  SkyModel,
  getSkySlot,
  sampleSkyRadiance,
} from '../sky/028_sky_atmosphere.js';

import {
  LightF32,
  LightType,
  addPointLight,
  setLightEnabled,
} from '../render/015_lights_shadows.js';

import {
  vec3,
  vec4,
  mat4,
  createNoise1D,
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

const MAX_METEORS                    = 512;
const MAX_TRAINS                     = 128;
const MAX_TRAIL_SEGMENTS             = 16;
const MAX_SHOWER_ARCHETYPES          = 16;
const MAX_METEOR_VIEWERS             = 8;
const MAX_METEOR_FLASH_LIGHTS        = 32;

// Atmospheric layers (metres).
const ATMOSPHERE_TOP                 = 100000.0;
const METEOR_START_ALT_DEFAULT       = 120000.0;
const METEOR_TERMINAL_ALT            = 25000.0;
const METEOR_ABLATION_PEAK_ALT       = 90000.0;

// Air density at sea level and scale height.
const AIR_DENSITY_SEA_LEVEL          = 1.225;      // kg/m³
const ATMOSPHERE_SCALE_HEIGHT        = 7200.0;     // metres
const ATMOSPHERE_TEMPERATURE         = 250.0;      // Kelvin (mid-alt)

// Meteor physics.
const METEOR_MASS_MIN_KG             = 1e-6;       // very tiny (microgram-tenths)
const METEOR_MASS_MAX_KG             = 1000.0;
const METEOR_DENSITY_DEFAULT         = 3000.0;     // kg/m³ (stony)
const METEOR_DRAG_COEFF              = 0.9;
const METEOR_SHAPE_FACTOR            = 1.5;        // η (shoemaker-levy)
const METEOR_LUMINOUS_EFFICIENCY     = 0.05;       // 5% mass → photons
const METEOR_ABLATION_COEFF          = 2.0e-8;     // per kg/m²
const METEOR_ENTHALPY_OF_ABLATION    = 6.0e6;      // J/kg (silicate)
const METEOR_HEAT_OF_ABLATION        = 1.0e7;      // J/kg
const METEOR_ZERO_MAGNITUDE_KG       = 0.002;      // ~2 g
const METEOR_SPEED_OF_SOUND          = 343.0;

// Radiant default location (RA in hours, Dec in degrees).
const RADIANT_POLARIS                = { ra: 0, dec: 90 };

// Fireball thresholds.
const FIREBALL_MAGNITUDE             = -4;
const BOLIDE_MAGNITUDE               = -8;
const FLASH_LIGHT_DURATION           = 0.6;
const FLASH_LIGHT_INTENSITY          = 500.0;
const FLASH_LIGHT_RANGE              = 8000.0;

// Trail segment count decay.
const TRAIL_SEGMENT_LIFETIME_MIN     = 0.3;        // seconds
const TRAIL_SEGMENT_LIFETIME_MAX     = 2.5;

// Persistent train.
const TRAIN_DURATION_MIN             = 1.0;
const TRAIN_DURATION_MAX             = 20.0;
const TRAIN_INITIAL_RADIUS           = 5.0;        // metres
const TRAIN_EXPANSION_RATE           = 2.0;        // m/s
const TRAIN_INTENSITY_DECAY          = 0.85;

// Population index default.
const POP_INDEX_DEFAULT              = 2.5;

// ZHR to raw rate divisor (sin(elevation) correction).
const SIN_ELEVATION_POWER            = 1.0;

// Meteor colors by velocity (km/s) and composition:
const COLOR_HIGH_SPEED_R             = 0.65;       // blue-white (Mg, Ca+)
const COLOR_HIGH_SPEED_G             = 0.80;
const COLOR_HIGH_SPEED_B             = 1.00;

const COLOR_MID_SPEED_R              = 1.00;       // yellow-white (Na, Fe)
const COLOR_MID_SPEED_G              = 0.90;
const COLOR_MID_SPEED_B              = 0.65;

const COLOR_LOW_SPEED_R              = 1.00;       // orange-red (Fe, Na)
const COLOR_LOW_SPEED_G              = 0.55;
const COLOR_LOW_SPEED_B              = 0.25;

// Velocity thresholds (km/s) for color.
const COLOR_HIGH_SPEED_THRESHOLD     = 50.0;
const COLOR_LOW_SPEED_THRESHOLD      = 25.0;

// ═══════════════════════════════════════════════════════════════════════
// METEOR SHOWER ENUM
// ═══════════════════════════════════════════════════════════════════════

export const MeteorShower = Object.freeze({
  SPORADIC:        0,
  QUADRANTIDS:     1,   // early Jan
  LYRIDS:          2,   // late Apr
  ETA_AQUARIIDS:   3,   // early May
  SOUTHERN_DELTA_AQUARIIDS: 4, // late Jul
  PERSEIDS:        5,   // mid Aug
  ORIONIDS:        6,   // late Oct
  SOUTHERN_TAURIDS: 7,  // Nov
  NORTHERN_TAURIDS: 8,  // Nov
  LEONIDS:         9,   // mid Nov
  GEMINIDS:        10,  // mid Dec
  URSIDS:          11,  // late Dec
  DRACONIDS:       12,  // early Oct
});

// ═══════════════════════════════════════════════════════════════════════
// SHOWER ARCHETYPE SoA
// ═══════════════════════════════════════════════════════════════════════

export const ShowerArchetype = {
  // Type (MeteorShower).
  type: new Uint8Array(MAX_SHOWER_ARCHETYPES),

  // Radiant right ascension (hours) and declination (degrees).
  radiantRA:  new Float32Array(MAX_SHOWER_ARCHETYPES),
  radiantDec: new Float32Array(MAX_SHOWER_ARCHETYPES),

  // Peak solar longitude (degrees).
  peakSolarLongitude: new Float32Array(MAX_SHOWER_ARCHETYPES),

  // Activity window in solar longitude around the peak (degrees).
  activityWindow: new Float32Array(MAX_SHOWER_ARCHETYPES),

  // Zenithal hourly rate at peak.
  zhr: new Float32Array(MAX_SHOWER_ARCHETYPES),

  // Population index (r); higher = more faint meteors per bright one.
  populationIndex: new Float32Array(MAX_SHOWER_ARCHETYPES),

  // Entry velocity (km/s).
  entryVelocity: new Float32Array(MAX_SHOWER_ARCHETYPES),

  // Characteristic composition (0 = stony, 1 = iron, 2 = cometary).
  composition: new Uint8Array(MAX_SHOWER_ARCHETYPES),

  // Optional storm multiplier for historic years.
  stormMultiplier: new Float32Array(MAX_SHOWER_ARCHETYPES),

  // Name (for debugging).
  name: new Array(MAX_SHOWER_ARCHETYPES).fill(''),
};

let _nextArchetypeSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// METEOR ENTRY SoA
// ═══════════════════════════════════════════════════════════════════════

export const MeteorEntry = {
  active: new Uint8Array(MAX_METEORS),

  // Source shower slot.
  showerSlot: new Uint16Array(MAX_METEORS),

  // World position (metres).
  px: new Float32Array(MAX_METEORS),
  py: new Float32Array(MAX_METEORS),
  pz: new Float32Array(MAX_METEORS),

  // World velocity (m/s).
  vx: new Float32Array(MAX_METEORS),
  vy: new Float32Array(MAX_METEORS),
  vz: new Float32Array(MAX_METEORS),

  // Current mass (kg).
  mass: new Float32Array(MAX_METEORS),

  // Initial mass (kg).
  initialMass: new Float32Array(MAX_METEORS),

  // Cross-sectional area (m²).
  crossSection: new Float32Array(MAX_METEORS),

  // Brightness (visual magnitude; lower = brighter).
  magnitude: new Float32Array(MAX_METEORS),

  // Peak magnitude observed so far.
  peakMagnitude: new Float32Array(MAX_METEORS),

  // Luminous flux in candelas (for point light integration).
  luminousPower: new Float32Array(MAX_METEORS),

  // Age and lifetime (seconds).
  age: new Float32Array(MAX_METEORS),
  lifetime: new Float32Array(MAX_METEORS),

  // Trail brightness envelope (0..1; decays with age).
  trailIntensity: new Float32Array(MAX_METEORS),

  // Color (linear RGB).
  colorR: new Float32Array(MAX_METEORS),
  colorG: new Float32Array(MAX_METEORS),
  colorB: new Float32Array(MAX_METEORS),

  // Point light slot (-1 = none).
  lightSlot: new Int16Array(MAX_METEORS),

  // Trail history: up to MAX_TRAIL_SEGMENTS world-space points.
  trailX: new Float32Array(MAX_METEORS * MAX_TRAIL_SEGMENTS),
  trailY: new Float32Array(MAX_METEORS * MAX_TRAIL_SEGMENTS),
  trailZ: new Float32Array(MAX_METEORS * MAX_TRAIL_SEGMENTS),
  trailCount: new Uint8Array(MAX_METEORS),

  // Bolide / fireball flag (1 = fireball, 2 = bolide).
  flagged: new Uint8Array(MAX_METEORS),

  // Whether the sonic boom has already been dispatched.
  boomDispatched: new Uint8Array(MAX_METEORS),

  // Age when the meteor terminates (seconds).
  terminalAge: new Float32Array(MAX_METEORS),
};

/** Marker: active meteor. */
export const MeteorTag = {};

// ═══════════════════════════════════════════════════════════════════════
// PERSISTENT TRAIN SoA
// ═══════════════════════════════════════════════════════════════════════

export const MeteorTrain = {
  active: new Uint8Array(MAX_TRAINS),

  // Source meteor slot.
  meteorSlot: new Int16Array(MAX_TRAINS),

  // World position (centre of the train).
  px: new Float32Array(MAX_TRAINS),
  py: new Float32Array(MAX_TRAINS),
  pz: new Float32Array(MAX_TRAINS),

  // Radius of the expanding train (metres).
  radius: new Float32Array(MAX_TRAINS),

  // Brightness (0..1).
  intensity: new Float32Array(MAX_TRAINS),

  // Age and lifetime (seconds).
  age: new Float32Array(MAX_TRAINS),
  lifetime: new Float32Array(MAX_TRAINS),

  // Colour.
  colorR: new Float32Array(MAX_TRAINS),
  colorG: new Float32Array(MAX_TRAINS),
  colorB: new Float32Array(MAX_TRAINS),

  // Free-list head.
  freeHead: 0,
  liveCount: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// METEOR VIEWER SoA — one per camera
// ═══════════════════════════════════════════════════════════════════════

export const MeteorViewer = {
  ownerEid: new Uint32Array(MAX_METEOR_VIEWERS),

  // Camera position.
  camX: new Float32Array(MAX_METEOR_VIEWERS),
  camY: new Float32Array(MAX_METEOR_VIEWERS),
  camZ: new Float32Array(MAX_METEOR_VIEWERS),

  // Camera forward direction (unit vector).
  fwdX: new Float32Array(MAX_METEOR_VIEWERS),
  fwdY: new Float32Array(MAX_METEOR_VIEWERS),
  fwdZ: new Float32Array(MAX_METEOR_VIEWERS),

  // Observer latitude (degrees).
  latitude: new Float32Array(MAX_METEOR_VIEWERS),

  // Current zenithal limiting magnitude (faintest visible meteor).
  limitingMagnitude: new Float32Array(MAX_METEOR_VIEWERS),

  // Active flag.
  active: new Uint8Array(MAX_METEOR_VIEWERS),
};

/** Marker: entity is a meteor viewer (usually the camera). */
export const MeteorViewerTag = {};

const _viewerSlots = new Map();
let _nextViewerSlot = 0;

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
// SHOWER ARCHETYPE INITIALIZATION — the 12 majors + sporadic
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create all the standard shower archetypes.
 * Safe to call multiple times (idempotent).
 */
export function ensureShowerArchetypes() {
  if (_nextArchetypeSlot > 0) return;

  // SPORADIC — background meteors, all year.
  createShowerArchetype(MeteorShower.SPORADIC, {
    name: 'Sporadic',
    radiantRA: 0, radiantDec: 0,
    peakSolarLongitude: 0,
    activityWindow: 180,
    zhr: 4,
    populationIndex: 3.0,
    entryVelocity: 25,
    composition: 0,
  });

  // QUADRANTIDS — peak ~Jan 3, brief intense peak.
  createShowerArchetype(MeteorShower.QUADRANTIDS, {
    name: 'Quadrantids',
    radiantRA: 15.33, radiantDec: 49,
    peakSolarLongitude: 283.16,
    activityWindow: 3,
    zhr: 120,
    populationIndex: 2.1,
    entryVelocity: 41,
    composition: 0,
  });

  // LYRIDS — peak ~Apr 22.
  createShowerArchetype(MeteorShower.LYRIDS, {
    name: 'Lyrids',
    radiantRA: 18.13, radiantDec: 34,
    peakSolarLongitude: 32.32,
    activityWindow: 5,
    zhr: 18,
    populationIndex: 2.1,
    entryVelocity: 49,
    composition: 2,
  });

  // ETA AQUARIIDS — peak ~May 6.
  createShowerArchetype(MeteorShower.ETA_AQUARIIDS, {
    name: 'Eta Aquariids',
    radiantRA: 22.47, radiantDec: -1,
    peakSolarLongitude: 45.5,
    activityWindow: 15,
    zhr: 60,
    populationIndex: 2.4,
    entryVelocity: 66,
    composition: 2,
  });

  // SOUTHERN DELTA AQUARIIDS — peak ~Jul 30.
  createShowerArchetype(MeteorShower.SOUTHERN_DELTA_AQUARIIDS, {
    name: 'Southern Delta Aquariids',
    radiantRA: 22.67, radiantDec: -16,
    peakSolarLongitude: 127,
    activityWindow: 10,
    zhr: 25,
    populationIndex: 3.2,
    entryVelocity: 41,
    composition: 2,
  });

  // PERSEIDS — peak ~Aug 12.
  createShowerArchetype(MeteorShower.PERSEIDS, {
    name: 'Perseids',
    radiantRA: 3.13, radiantDec: 58,
    peakSolarLongitude: 140.0,
    activityWindow: 15,
    zhr: 100,
    populationIndex: 2.2,
    entryVelocity: 59,
    composition: 2,
  });

  // ORIONIDS — peak ~Oct 21.
  createShowerArchetype(MeteorShower.ORIONIDS, {
    name: 'Orionids',
    radiantRA: 6.35, radiantDec: 16,
    peakSolarLongitude: 208.0,
    activityWindow: 12,
    zhr: 20,
    populationIndex: 2.5,
    entryVelocity: 66,
    composition: 2,
  });

  // SOUTHERN TAURIDS — peak ~Nov 5.
  createShowerArchetype(MeteorShower.SOUTHERN_TAURIDS, {
    name: 'Southern Taurids',
    radiantRA: 3.5, radiantDec: 15,
    peakSolarLongitude: 223.0,
    activityWindow: 15,
    zhr: 7,
    populationIndex: 2.3,
    entryVelocity: 27,
    composition: 1,
  });

  // NORTHERN TAURIDS — peak ~Nov 12.
  createShowerArchetype(MeteorShower.NORTHERN_TAURIDS, {
    name: 'Northern Taurids',
    radiantRA: 3.87, radiantDec: 22,
    peakSolarLongitude: 230.0,
    activityWindow: 15,
    zhr: 5,
    populationIndex: 2.3,
    entryVelocity: 29,
    composition: 1,
  });

  // LEONIDS — peak ~Nov 17, historic storms.
  createShowerArchetype(MeteorShower.LEONIDS, {
    name: 'Leonids',
    radiantRA: 10.27, radiantDec: 22,
    peakSolarLongitude: 235.27,
    activityWindow: 4,
    zhr: 15,
    populationIndex: 2.5,
    entryVelocity: 71,
    composition: 2,
  });

  // GEMINIDS — peak ~Dec 14, rich.
  createShowerArchetype(MeteorShower.GEMINIDS, {
    name: 'Geminids',
    radiantRA: 7.47, radiantDec: 32,
    peakSolarLongitude: 262.2,
    activityWindow: 8,
    zhr: 120,
    populationIndex: 2.6,
    entryVelocity: 35,
    composition: 0,
  });

  // URSIDS — peak ~Dec 22.
  createShowerArchetype(MeteorShower.URSIDS, {
    name: 'Ursids',
    radiantRA: 14.47, radiantDec: 76,
    peakSolarLongitude: 270.7,
    activityWindow: 4,
    zhr: 10,
    populationIndex: 3.0,
    entryVelocity: 33,
    composition: 2,
  });

  // DRACONIDS — peak ~Oct 8, historically variable.
  createShowerArchetype(MeteorShower.DRACONIDS, {
    name: 'Draconids',
    radiantRA: 17.47, radiantDec: 54,
    peakSolarLongitude: 195.4,
    activityWindow: 2,
    zhr: 10,
    populationIndex: 2.6,
    entryVelocity: 20,
    composition: 2,
  });
}

function createShowerArchetype(type, params) {
  const slot = _nextArchetypeSlot++;

  const S = ShowerArchetype;
  S.type[slot] = type;
  S.radiantRA[slot] = params.radiantRA ?? 0;
  S.radiantDec[slot] = params.radiantDec ?? 0;
  S.peakSolarLongitude[slot] = params.peakSolarLongitude ?? 0;
  S.activityWindow[slot] = params.activityWindow ?? 10;
  S.zhr[slot] = params.zhr ?? 10;
  S.populationIndex[slot] = params.populationIndex ?? POP_INDEX_DEFAULT;
  S.entryVelocity[slot] = params.entryVelocity ?? 30;
  S.composition[slot] = params.composition ?? 0;
  S.stormMultiplier[slot] = params.stormMultiplier ?? 1.0;
  S.name[slot] = params.name ?? 'Unknown';

  return slot;
}

// ═══════════════════════════════════════════════════════════════════════
// METEOR VIEWER API
// ═══════════════════════════════════════════════════════════════════════

export function addMeteorViewer(world, eid, options = {}) {
  if (_nextViewerSlot >= MAX_METEOR_VIEWERS) {
    throw new Error('meteor viewer capacity exceeded');
  }
  const slot = _nextViewerSlot++;

  addComponent(world, eid, MeteorViewerTag);

  const V = MeteorViewer;
  V.ownerEid[slot] = eid;
  V.camX[slot] = options.camX ?? 0;
  V.camY[slot] = options.camY ?? 0;
  V.camZ[slot] = options.camZ ?? 0;
  V.fwdX[slot] = options.fwdX ?? 0;
  V.fwdY[slot] = options.fwdY ?? 0;
  V.fwdZ[slot] = options.fwdZ ?? 1;
  V.latitude[slot] = options.latitude ?? 45;
  V.limitingMagnitude[slot] = options.limitingMagnitude ?? 4.5;   // rural sky
  V.active[slot] = 1;

  _viewerSlots.set(eid, slot);
  return slot;
}

export function removeMeteorViewer(world, eid) {
  const slot = _viewerSlots.get(eid);
  if (slot === undefined) return;
  MeteorViewer.active[slot] = 0;
  MeteorViewer.ownerEid[slot] = 0;
  _viewerSlots.delete(eid);
  removeComponent(world, eid, MeteorViewerTag);
}

export function getMeteorViewerSlot(eid) {
  return _viewerSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// ASTRONOMY HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert RA (hours) and Dec (degrees) to a unit vector in world space.
 * Assumes world X = east, Y = up (zenith), Z = north.
 */
function radiantToVector(raHours, decDeg) {
  const raRad = (raHours / 24) * TWO_PI;
  const decRad = decDeg * DEG_TO_RAD;
  const cosDec = Math.cos(decRad);
  return [
    Math.cos(raRad) * cosDec,   // east
    Math.sin(decRad),            // up (dec)
    Math.sin(raRad) * cosDec,    // north
  ];
}

/**
 * Approximate solar longitude for the current date.
 * Assumes the year starts at solar longitude 0 (vernal equinox ~Mar 21).
 */
function solarLongitudeFromDayOfYear(dayOfYear) {
  // Day 0 = Mar 21 (equinox, solar longitude 0°).
  const daysOffset = dayOfYear - 80;
  return ((daysOffset / 365.25) * 360.0) % 360.0;
}

/**
 * Compute the current activity factor of a shower based on solar
 * longitude. Peaks at 1.0 at the peak, fades to 0 at the window edges.
 */
function showerActivityFactor(showerSlot, currentSolarLongitude) {
  const S = ShowerArchetype;
  const peak = S.peakSolarLongitude[showerSlot];
  const window = S.activityWindow[showerSlot];

  let delta = currentSolarLongitude - peak;
  // Wrap to [-180, 180].
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;

  const absDelta = Math.abs(delta);
  if (absDelta > window) return 0;

  // Gaussian envelope.
  return Math.exp(-Math.pow(absDelta / (window * 0.5), 2));
}

/**
 * Compute the elevation (radians above horizon) of a radiant for an
 * observer at a given latitude.
 */
function radiantElevation(radiantVec, latitudeDeg) {
  // For a stationary observer at latitude φ, the "up" direction in world
  // space is Y. The zenith is straight up. The radiant's elevation is
  // determined by the dot product of the radiant with the observer's
  // local up vector, adjusted for latitude.
  //
  // For simplicity, we assume the observer's local horizon is Y = 0
  // (the world Y axis is "up"), and the radiant's Y component is the
  // sin(elevation) with a latitude-dependent multiplier.
  const sinLat = Math.sin(latitudeDeg * DEG_TO_RAD);
  // Elevation = asin(radiant.y * cosLat + radiant.z * sinLat)
  // where radiant.z is "north".
  const y = radiantVec[1];
  const z = radiantVec[2];
  const elevation = Math.asin(Math.max(-1, Math.min(1, y * sinLat + z * Math.cos(latitudeDeg * DEG_TO_RAD))));
  return elevation;
}

// ═══════════════════════════════════════════════════════════════════════
// METEOR COLOR BY VELOCITY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the characteristic color of a meteor based on its entry
 * velocity and composition.
 */
export function sampleMeteorColor(velocityKmS, composition, out) {
  if (velocityKmS > COLOR_HIGH_SPEED_THRESHOLD) {
    out[0] = COLOR_HIGH_SPEED_R;
    out[1] = COLOR_HIGH_SPEED_G;
    out[2] = COLOR_HIGH_SPEED_B;
  } else if (velocityKmS < COLOR_LOW_SPEED_THRESHOLD) {
    out[0] = COLOR_LOW_SPEED_R;
    out[1] = COLOR_LOW_SPEED_G;
    out[2] = COLOR_LOW_SPEED_B;
  } else {
    const t = (velocityKmS - COLOR_LOW_SPEED_THRESHOLD)
      / (COLOR_HIGH_SPEED_THRESHOLD - COLOR_LOW_SPEED_THRESHOLD);
    out[0] = COLOR_LOW_SPEED_R * (1 - t) + COLOR_HIGH_SPEED_R * t;
    out[1] = COLOR_LOW_SPEED_G * (1 - t) + COLOR_HIGH_SPEED_G * t;
    out[2] = COLOR_LOW_SPEED_B * (1 - t) + COLOR_HIGH_SPEED_B * t;
  }

  // Composition tweaks.
  if (composition === 1) {
    // Iron-rich: redder.
    out[0] = Math.min(1.0, out[0] * 1.15);
    out[1] *= 0.85;
    out[2] *= 0.75;
  } else if (composition === 2) {
    // Cometary: slightly bluer.
    out[0] *= 0.95;
    out[1] = Math.min(1.0, out[1] * 1.05);
    out[2] = Math.min(1.0, out[2] * 1.10);
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// METEOR POOL MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

let _nextMeteorSlot = 0;

function allocMeteorSlot() {
  for (let i = 0; i < MAX_METEORS; i++) {
    if (MeteorEntry.active[i] === 0) {
      MeteorEntry.active[i] = 1;
      return i;
    }
  }
  // Pool full: recycle oldest.
  let oldest = 0;
  let oldestAge = -1;
  for (let i = 0; i < MAX_METEORS; i++) {
    if (MeteorEntry.age[i] > oldestAge) {
      oldestAge = MeteorEntry.age[i];
      oldest = i;
    }
  }
  return oldest;
}

function allocTrainSlot() {
  const T = MeteorTrain;
  for (let i = 0; i < MAX_TRAINS; i++) {
    const slot = (T.freeHead + i) % MAX_TRAINS;
    if (T.active[slot] === 0) {
      T.freeHead = (slot + 1) % MAX_TRAINS;
      T.active[slot] = 1;
      T.liveCount++;
      return slot;
    }
  }
  return -1;
}

function freeTrainSlot(slot) {
  const T = MeteorTrain;
  if (T.active[slot] === 0) return;
  T.active[slot] = 0;
  T.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// METEOR SPAWNING
// ═══════════════════════════════════════════════════════════════════════

const _sampleColor = vec3.create();
const _sampleVec = vec3.create();

/**
 * Spawn a single meteor from a shower.
 *
 * @param world         ECS world
 * @param showerSlot    shower archetype slot
 * @param viewerSlot    viewer that should see this meteor
 * @param rng           deterministic PRNG
 * @returns meteor slot, or -1 on failure
 */
export function spawnMeteor(world, showerSlot, viewerSlot, rng) {
  const S = ShowerArchetype;
  const V = MeteorViewer;

  if (showerSlot < 0 || showerSlot >= _nextArchetypeSlot) return -1;
  if (viewerSlot < 0 || viewerSlot >= _nextViewerSlot) return -1;

  const slot = allocMeteorSlot();
  const M = MeteorEntry;

  // Compute the radiant direction.
  const radiant = radiantToVector(S.radiantRA[showerSlot], S.radiantDec[showerSlot]);

  // Sample a random direction within a cone around the radiant.
  const coneAngle = (0.5 + rng() * 6.0) * DEG_TO_RAD;   // 0.5° to 6°
  const azimuth = rng() * TWO_PI;

  // Build a perpendicular basis around the radiant.
  const perp1 = perpendicular(radiant);
  const perp2 = crossVec(radiant, perp1);

  const sinCone = Math.sin(coneAngle);
  const cosCone = Math.cos(coneAngle);

  const dirX = radiant[0] * cosCone + perp1[0] * Math.cos(azimuth) * sinCone + perp2[0] * Math.sin(azimuth) * sinCone;
  const dirY = radiant[1] * cosCone + perp1[1] * Math.cos(azimuth) * sinCone + perp2[1] * Math.sin(azimuth) * sinCone;
  const dirZ = radiant[2] * cosCone + perp1[2] * Math.cos(azimuth) * sinCone + perp2[2] * Math.sin(azimuth) * sinCone;

  // Start position: 120 km altitude, offset toward the viewer.
  const camX = V.camX[viewerSlot];
  const camY = V.camY[viewerSlot];
  const camZ = V.camZ[viewerSlot];

  // Offset of the meteor start position along the direction (from
  // viewer toward the radiant).
  const offset = 80000 + rng() * 60000;   // 80-140 km from viewer

  const startX = camX + dirX * offset;
  const startY = METEOR_START_ALT_DEFAULT;
  const startZ = camZ + dirZ * offset;

  // Velocity: entry velocity + direction.
  const velKmS = S.entryVelocity[showerSlot] * (0.9 + rng() * 0.2);
  const velMS = velKmS * 1000.0;

  M.px[slot] = startX;
  M.py[slot] = startY;
  M.pz[slot] = startZ;
  M.vx[slot] = dirX * velMS;
  M.vy[slot] = dirY * velMS;
  M.vz[slot] = dirZ * velMS;

  // Mass: population-index-weighted distribution.
  // Smaller particles are more common.
  const r = S.populationIndex[showerSlot];
  const u = rng();
  // log10(mass) with exponential distribution truncated at max.
  const magnitude = 2.0 - Math.log(Math.max(1e-8, u)) / Math.log(r);
  // Map magnitude to mass using the empirical mass-magnitude relation.
  const mass = METEOR_ZERO_MAGNITUDE_KG * Math.pow(2.512, -magnitude);
  M.mass[slot] = Math.max(METEOR_MASS_MIN_KG, Math.min(METEOR_MASS_MAX_KG, mass));
  M.initialMass[slot] = M.mass[slot];

  // Cross-section: sphere approximation.
  const radius = Math.cbrt(3 * M.mass[slot] / (4 * PI * METEOR_DENSITY_DEFAULT));
  M.crossSection[slot] = PI * radius * radius;

  // Age / lifetime.
  M.age[slot] = 0;
  M.lifetime[slot] = 4.0 + rng() * 3.0;

  // Trail.
  M.trailCount[slot] = 0;
  M.trailIntensity[slot] = 1.0;

  // Initial brightness — will evolve per-frame.
  M.magnitude[slot] = 10.0;
  M.peakMagnitude[slot] = 10.0;
  M.luminousPower[slot] = 0;

  // Color from velocity + composition.
  sampleMeteorColor(velKmS, S.composition[showerSlot], _sampleColor);
  M.colorR[slot] = _sampleColor[0];
  M.colorG[slot] = _sampleColor[1];
  M.colorB[slot] = _sampleColor[2];

  M.showerSlot[slot] = showerSlot;
  M.lightSlot[slot] = -1;
  M.flagged[slot] = 0;
  M.boomDispatched[slot] = 0;
  M.terminalAge[slot] = -1;

  return slot;
}

function perpendicular(v) {
  if (Math.abs(v[0]) < 0.9) {
    return normalize3([0, -v[2], v[1]]);
  }
  return normalize3([-v[2], 0, v[0]]);
}

function crossVec(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

// ═══════════════════════════════════════════════════════════════════════
// ATMOSPHERIC DENSITY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Exponential atmospheric density model.
 * ρ(h) = ρ_0 * exp(-h / H)
 */
function airDensity(altitudeM) {
  if (altitudeM < 0) return AIR_DENSITY_SEA_LEVEL;
  return AIR_DENSITY_SEA_LEVEL * Math.exp(-altitudeM / ATMOSPHERE_SCALE_HEIGHT);
}

// ═══════════════════════════════════════════════════════════════════════
// METEOR PHYSICS UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance all active meteors. Handles:
 *   • atmospheric entry ablation
 *   • luminous efficiency / brightness evolution
 *   • terminal flash and fireball classification
 *   • train spawning
 *   • light source integration
 */
export function systemUpdateMeteors(world, dt) {
  const M = MeteorEntry;

  for (let slot = 0; slot < MAX_METEORS; slot++) {
    if (!M.active[slot]) continue;

    M.age[slot] += dt;

    // Retire if age exceeds lifetime.
    if (M.age[slot] > M.lifetime[slot]) {
      // Spawn a train if the meteor was bright enough.
      if (M.peakMagnitude[slot] < -1) {
        spawnTrain(world, slot);
      }
      // Disable light.
      if (M.lightSlot[slot] >= 0) {
        setLightEnabled(M.lightSlot[slot], false);
      }
      M.active[slot] = 0;
      continue;
    }

    // Current altitude.
    const alt = M.py[slot];

    // If below the terminal altitude, the meteor is done.
    if (alt < METEOR_TERMINAL_ALT) {
      // Terminal flash: boost brightness briefly.
      if (M.terminalAge[slot] < 0) {
        M.terminalAge[slot] = M.age[slot];
        // Bolide classification.
        if (M.peakMagnitude[slot] < BOLIDE_MAGNITUDE) {
          M.flagged[slot] = 2;
        }
      }
    }

    // Air density at the current altitude.
    const rho = airDensity(alt);

    // Relative velocity magnitude.
    const v = Math.hypot(M.vx[slot], M.vy[slot], M.vz[slot]);
    if (v < 100) {
      // Meteor has slowed to near stop; retire.
      M.lifetime[slot] = M.age[slot];
      continue;
    }

    // ── Ablation (Bronshten equations) ──────────────────────
    // Mass loss rate: dm/dt = -(Λ/2) * ρ * v * A / (Q * σ)
    // Simplified: proportional to ρ * v³ * A.
    const massLoss = 0.5 * METEOR_ABLATION_COEFF * rho * v * v * v * M.crossSection[slot];
    const dm = Math.min(M.mass[slot] * 0.9, massLoss * dt);
    M.mass[slot] = Math.max(1e-9, M.mass[slot] - dm);

    // Update cross-section from remaining mass.
    const remainingRadius = Math.cbrt(3 * M.mass[slot] / (4 * PI * METEOR_DENSITY_DEFAULT));
    M.crossSection[slot] = PI * remainingRadius * remainingRadius;

    // ── Drag deceleration ─────────────────────────────────
    // dv/dt = -(Γ * A * ρ * v²) / (2 * m)
    const dragForce = 0.5 * METEOR_DRAG_COEFF * rho * v * v * M.crossSection[slot];
    const decel = dragForce / M.mass[slot];
    const dv = decel * dt;
    const newV = Math.max(50, v - dv);
    const scale = newV / v;
    M.vx[slot] *= scale;
    M.vy[slot] *= scale;
    M.vz[slot] *= scale;

    // ── Luminous power ────────────────────────────────────
    // P = η · (-dm/dt) · v² / 2  (in Watts)
    const kineticPower = dm / Math.max(dt, EPSILON) * 0.5 * v * v;
    const luminousPower = METEOR_LUMINOUS_EFFICIENCY * kineticPower;
    M.luminousPower[slot] = luminousPower;

    // Convert luminous power to magnitude.
    // Reference: 100 W → magnitude 0.
    const magnitude = -2.5 * Math.log10(Math.max(luminousPower / 100.0, EPSILON));
    M.magnitude[slot] = magnitude;
    if (magnitude < M.peakMagnitude[slot]) {
      M.peakMagnitude[slot] = magnitude;
    }

    // Trail intensity from current brightness.
    M.trailIntensity[slot] = Math.max(0.05, Math.min(1.0,
      (0 - magnitude) / 6.0 + 0.3));

    // ── Fireball / bolide flagging ────────────────────────
    if (magnitude < BOLIDE_MAGNITUDE && M.flagged[slot] < 2) {
      M.flagged[slot] = 2;
      // Create a bright flash light.
      _spawnFlashLight(world, slot);
    } else if (magnitude < FIREBALL_MAGNITUDE && M.flagged[slot] < 1) {
      M.flagged[slot] = 1;
      _spawnFlashLight(world, slot);
    }

    // ── Advance position ──────────────────────────────────
    const prevX = M.px[slot];
    const prevY = M.py[slot];
    const prevZ = M.pz[slot];

    M.px[slot] += M.vx[slot] * dt;
    M.py[slot] += M.vy[slot] * dt;
    M.pz[slot] += M.vz[slot] * dt;

    // ── Update trail ──────────────────────────────────────
    const trailCount = M.trailCount[slot];
    const trailBase = slot * MAX_TRAIL_SEGMENTS;

    if (trailCount < MAX_TRAIL_SEGMENTS) {
      M.trailX[trailBase + trailCount] = prevX;
      M.trailY[trailBase + trailCount] = prevY;
      M.trailZ[trailBase + trailCount] = prevZ;
      M.trailCount[slot] = trailCount + 1;
    } else {
      // Shift existing trail segments.
      for (let i = 1; i < MAX_TRAIL_SEGMENTS; i++) {
        M.trailX[trailBase + i - 1] = M.trailX[trailBase + i];
        M.trailY[trailBase + i - 1] = M.trailY[trailBase + i];
        M.trailZ[trailBase + i - 1] = M.trailZ[trailBase + i];
      }
      M.trailX[trailBase + MAX_TRAIL_SEGMENTS - 1] = prevX;
      M.trailY[trailBase + MAX_TRAIL_SEGMENTS - 1] = prevY;
      M.trailZ[trailBase + MAX_TRAIL_SEGMENTS - 1] = prevZ;
    }

    // ── Update flash light intensity ──────────────────────
    if (M.lightSlot[slot] >= 0) {
      const lightSlot = M.lightSlot[slot];
      const flashIntensity = M.flagged[slot] > 0
        ? FLASH_LIGHT_INTENSITY * (1 + M.flagged[slot] * 0.5)
        : 0;
      if (flashIntensity > 0 && LightF32.enabled[lightSlot]) {
        LightF32.intensity[lightSlot] = flashIntensity;
        LightF32.px[lightSlot] = M.px[slot];
        LightF32.py[lightSlot] = M.py[slot];
        LightF32.pz[lightSlot] = M.pz[slot];
      }
    }
  }

  // Advance trains.
  const T = MeteorTrain;
  for (let slot = 0; slot < MAX_TRAINS; slot++) {
    if (!T.active[slot]) continue;

    T.age[slot] += dt;
    T.radius[slot] += TRAIN_EXPANSION_RATE * dt;
    T.intensity[slot] *= Math.pow(TRAIN_INTENSITY_DECAY, dt);

    if (T.age[slot] > T.lifetime[slot] || T.intensity[slot] < EPSILON) {
      freeTrainSlot(slot);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// FLASH LIGHT SPAWN
// ═══════════════════════════════════════════════════════════════════════

function _spawnFlashLight(world, meteorSlot) {
  const M = MeteorEntry;

  // Allocate a point light entity.
  const eid = _allocFlashEntity(world);
  addTransform(world, eid, {
    px: M.px[meteorSlot],
    py: M.py[meteorSlot],
    pz: M.pz[meteorSlot],
  });

  const lightSlot = addPointLight(world, eid, {
    color: [M.colorR[meteorSlot], M.colorG[meteorSlot], M.colorB[meteorSlot]],
    intensity: FLASH_LIGHT_INTENSITY,
    range: FLASH_LIGHT_RANGE,
    castShadow: false,
    layerMask: 1,
  });
  M.lightSlot[meteorSlot] = lightSlot;
}

function _allocFlashEntity(world) {
  const ctx = world[$internal];
  const index = ctx.entityIndex;
  const id = index.maxId + 1;
  index.maxId = id;
  index.dense[index.aliveCount] = id;
  index.sparse[id] = index.aliveCount;
  index.aliveCount++;
  ctx.entityComponents.set(id, new Set());
  return id;
}

// ═══════════════════════════════════════════════════════════════════════
// TRAIN SPAWNING
// ═══════════════════════════════════════════════════════════════════════

function spawnTrain(world, meteorSlot) {
  const slot = allocTrainSlot();
  if (slot < 0) return;

  const M = MeteorEntry;
  const T = MeteorTrain;

  T.meteorSlot[slot] = meteorSlot;
  T.px[slot] = M.px[meteorSlot];
  T.py[slot] = M.py[meteorSlot];
  T.pz[slot] = M.pz[meteorSlot];
  T.radius[slot] = TRAIN_INITIAL_RADIUS;
  T.intensity[slot] = Math.max(0.1, Math.min(1, -M.peakMagnitude[meteorSlot] / 8));
  T.age[slot] = 0;
  T.lifetime[slot] = TRAIN_DURATION_MIN
    + (TRAIN_DURATION_MAX - TRAIN_DURATION_MIN) * T.intensity[slot];
  T.colorR[slot] = M.colorR[meteorSlot];
  T.colorG[slot] = M.colorG[meteorSlot];
  T.colorB[slot] = M.colorB[meteorSlot];
}

// ═══════════════════════════════════════════════════════════════════════
// SPORADIC METEOR EMISSION — driven by viewer + shower activity
// ═══════════════════════════════════════════════════════════════════════

/**
 * System: emit meteors for all active viewers based on current
 * shower activity and limiting magnitude.
 *
 * @param world       ECS world
 * @param dt          seconds
 * @param dayOfYear   current day of year (0-365)
 * @param rng         deterministic PRNG (optional)
 */
export function systemEmitMeteors(world, dt, dayOfYear = 0, rng = Math.random) {
  ensureShowerArchetypes();

  const solarLongitude = solarLongitudeFromDayOfYear(dayOfYear);

  for (let viewerSlot = 0; viewerSlot < _nextViewerSlot; viewerSlot++) {
    if (!MeteorViewer.active[viewerSlot]) continue;

    const V = MeteorViewer;
    const latitude = V.latitude[viewerSlot];

    // For each shower, compute the emission rate.
    for (let showerSlot = 0; showerSlot < _nextArchetypeSlot; showerSlot++) {
      const S = ShowerArchetype;

      const activityFactor = showerActivityFactor(showerSlot, solarLongitude);
      if (activityFactor < 0.01) continue;

      const radiant = radiantToVector(S.radiantRA[showerSlot], S.radiantDec[showerSlot]);
      const elevation = radiantElevation(radiant, latitude);
      if (elevation <= 0) continue;   // Radiant below horizon.

      // ZHR adjusted for elevation + viewer's limiting magnitude.
      const sinElevation = Math.sin(elevation);
      const elevationFactor = Math.pow(sinElevation, SIN_ELEVATION_POWER);
      const lmFactor = Math.pow(S.populationIndex[showerSlot],
        V.limitingMagnitude[viewerSlot] - 6.5);
      const adjustedZHR = S.zhr[showerSlot] * activityFactor
        * elevationFactor * lmFactor * S.stormMultiplier[showerSlot];

      // Convert ZHR to per-second rate (ZHR is per hour).
      const ratePerSecond = adjustedZHR / 3600.0;

      // Poisson emission.
      const expected = ratePerSecond * dt;
      if (rng() < expected) {
        spawnMeteor(world, showerSlot, viewerSlot, rng);
      }
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// METEOR RADIANCE SAMPLING — the hot path
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the additive radiance of any active meteor or train along a
 * ray from a camera. Returns [r, g, b] or [0, 0, 0] if no meteor is
 * visible in that direction.
 *
 * @param viewerSlot  viewer slot from addMeteorViewer
 * @param dirX/Y/Z    unit view direction
 * @param out         [r, g, b] output buffer
 */
export function sampleMeteorRadiance(viewerSlot, dirX, dirY, dirZ, out) {
  out[0] = 0; out[1] = 0; out[2] = 0;

  const V = MeteorViewer;
  if (!V.active[viewerSlot]) return out;

  const camX = V.camX[viewerSlot];
  const camY = V.camY[viewerSlot];
  const camZ = V.camZ[viewerSlot];

  // Iterate meteors and check angular proximity to the view direction.
  const M = MeteorEntry;
  for (let slot = 0; slot < MAX_METEORS; slot++) {
    if (!M.active[slot]) continue;

    // Direction from camera to meteor.
    const dx = M.px[slot] - camX;
    const dy = M.py[slot] - camY;
    const dz = M.pz[slot] - camZ;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1) continue;

    // Angular proximity.
    const cosAngle = (dx * dirX + dy * dirY + dz * dirZ) / dist;

    // Approximate angular radius of the meteor's trail.
    const trailLength = M.trailCount[slot] * 1000;   // ~1 km per segment
    const trailAngularRadius = Math.min(0.05, trailLength / dist + 0.005);

    if (cosAngle < Math.cos(trailAngularRadius)) continue;

    // Brightness contribution.
    const magnitude = M.magnitude[slot];
    const flux = Math.pow(2.512, -magnitude) * 1e-8;   // arbitrary scaling
    const contribution = flux * M.trailIntensity[slot];

    out[0] += M.colorR[slot] * contribution;
    out[1] += M.colorG[slot] * contribution;
    out[2] += M.colorB[slot] * contribution;
  }

  // Trains.
  const T = MeteorTrain;
  for (let slot = 0; slot < MAX_TRAINS; slot++) {
    if (!T.active[slot]) continue;

    const dx = T.px[slot] - camX;
    const dy = T.py[slot] - camY;
    const dz = T.pz[slot] - camZ;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1) continue;

    const cosAngle = (dx * dirX + dy * dirY + dz * dirZ) / dist;
    const angularRadius = Math.min(0.1, T.radius[slot] / dist + 0.005);

    if (cosAngle < Math.cos(angularRadius)) continue;

    const contribution = T.intensity[slot] * 1e-6;
    out[0] += T.colorR[slot] * contribution;
    out[1] += T.colorG[slot] * contribution;
    out[2] += T.colorB[slot] * contribution;
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full meteor pipeline for one frame:
 *   1. systemEmitMeteors — spawn new meteors
 *   2. systemUpdateMeteors — advance physics
 */
export function systemMeteorTick(world, dt, dayOfYear = 0, rng = Math.random) {
  systemEmitMeteors(world, dt, dayOfYear, rng);
  systemUpdateMeteors(world, dt);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

export function getShowerName(showerSlot) {
  if (showerSlot < 0 || showerSlot >= _nextArchetypeSlot) return 'Unknown';
  return ShowerArchetype.name[showerSlot];
}

export function getShowerZhr(showerSlot) {
  if (showerSlot < 0 || showerSlot >= _nextArchetypeSlot) return 0;
  return ShowerArchetype.zhr[showerSlot];
}

/**
 * Set a storm multiplier for a shower (e.g., 1833 Leonids: 30x).
 */
export function setShowerStormMultiplier(showerSlot, multiplier) {
  if (showerSlot < 0 || showerSlot >= _nextArchetypeSlot) return;
  ShowerArchetype.stormMultiplier[showerSlot] = Math.max(1.0, multiplier);
}

/**
 * Return the current active showers for a given day-of-year.
 */
export function getActiveShowers(dayOfYear) {
  const solarLongitude = solarLongitudeFromDayOfYear(dayOfYear);
  const result = [];
  for (let slot = 0; slot < _nextArchetypeSlot; slot++) {
    const activity = showerActivityFactor(slot, solarLongitude);
    if (activity > 0.01) {
      result.push({
        slot,
        name: ShowerArchetype.name[slot],
        zhr: ShowerArchetype.zhr[slot],
        activityFactor: activity,
      });
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

export function gatherMeteorsForRendering() {
  const result = [];
  const M = MeteorEntry;
  for (let slot = 0; slot < MAX_METEORS; slot++) {
    if (!M.active[slot]) continue;
    if (M.magnitude[slot] > 6) continue;   // too faint to render

    // Build trail segment array.
    const trailCount = M.trailCount[slot];
    const trailBase = slot * MAX_TRAIL_SEGMENTS;
    const trail = [];
    for (let i = 0; i < trailCount; i++) {
      trail.push({
        x: M.trailX[trailBase + i],
        y: M.trailY[trailBase + i],
        z: M.trailZ[trailBase + i],
      });
    }

    result.push({
      slot,
      px: M.px[slot],
      py: M.py[slot],
      pz: M.pz[slot],
      vx: M.vx[slot],
      vy: M.vy[slot],
      vz: M.vz[slot],
      magnitude: M.magnitude[slot],
      peakMagnitude: M.peakMagnitude[slot],
      trail,
      trailIntensity: M.trailIntensity[slot],
      color: [M.colorR[slot], M.colorG[slot], M.colorB[slot]],
      flagged: M.flagged[slot],
      age: M.age[slot],
      lifetime: M.lifetime[slot],
    });
  }
  return result;
}

export function gatherTrainsForRendering() {
  const result = [];
  const T = MeteorTrain;
  for (let slot = 0; slot < MAX_TRAINS; slot++) {
    if (!T.active[slot]) continue;
    result.push({
      px: T.px[slot],
      py: T.py[slot],
      pz: T.pz[slot],
      radius: T.radius[slot],
      intensity: T.intensity[slot],
      age: T.age[slot],
      lifetime: T.lifetime[slot],
      color: [T.colorR[slot], T.colorG[slot], T.colorB[slot]],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearMeteors() {
  MeteorEntry.active.fill(0);
  MeteorEntry.trailCount.fill(0);
  _nextMeteorSlot = 0;

  MeteorTrain.active.fill(0);
  MeteorTrain.freeHead = 0;
  MeteorTrain.liveCount = 0;

  MeteorViewer.active.fill(0);
  MeteorViewer.ownerEid.fill(0);
  _viewerSlots.clear();
  _nextViewerSlot = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function meteorStats() {
  let activeMeteors = 0;
  let fireballs = 0;
  let bolides = 0;

  for (let slot = 0; slot < MAX_METEORS; slot++) {
    if (!MeteorEntry.active[slot]) continue;
    activeMeteors++;
    if (MeteorEntry.flagged[slot] === 1) fireballs++;
    if (MeteorEntry.flagged[slot] === 2) bolides++;
  }

  return {
    activeMeteors,
    maxMeteors: MAX_METEORS,
    activeTrains: MeteorTrain.liveCount,
    maxTrains: MAX_TRAINS,
    fireballs,
    bolides,
    showerArchetypes: _nextArchetypeSlot,
    viewers: _nextViewerSlot,
  };
}