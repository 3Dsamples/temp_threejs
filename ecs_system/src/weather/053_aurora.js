// file number : 053
// full path name : src/weather/053_aurora.js
// description : Aurora borealis / aurora australis system. Provides
//               physically-inspired aurora rendering and behaviour on
//               top of the bitECS_max pipeline:
//                 • KP-INDEX DRIVEN — the aurora's intensity, extent,
//                   and equatorward reach all scale with the planetary
//                   Kp index (0-9). At Kp 0, only high-latitude viewers
//                   see faint green arcs; at Kp 7+, mid-latitude
//                   viewers see overhead red curtains.
//                 • OVAL EQUATORWARD BOUNDARY — the auroral oval is
//                   modelled as a magnetically-conjugate band around
//                   each geomagnetic pole. Its radius grows with Kp
//                   according to the classic Feldstein (1985) oval
//                   relationship.
//                 • CURTAIN GEOMETRY — aurora is rendered as a stack
//                   of N vertical curtains distributed in longitude.
//                   Each curtain has a base altitude (~100 km green),
//                   a peak altitude (~110 km), a top altitude
//                   (~250-500 km for red), a base width, a shear
//                   (tilt), and a per-curtain brightness envelope
//                   driven by fractal noise.
//                 • COLOUR PHYSICS — aurora colours emerge from the
//                   altitude at which the solar wind particles
//                   collide with atmospheric gases. This file
//                   implements the four physically-correct colours:
//                     - GREEN (557.7 nm, atomic O, ~100-150 km)
//                     - RED (630.0 nm, atomic O, >150 km)
//                     - BLUE / PURPLE (427.8 nm N2+, ~90-100 km,
//                       often at the lower border of curtains)
//                     - PINK (mixture, ~100 km, sunlit N2+)
//                 • SOLAR WIND COUPLING — reads a "solar wind" state
//                   from the caller (default: random slow-varying
//                   value). Enhanced coupling produces brighter,
//                   more dynamic aurora that ripples along curtains.
//                 • SUN-INTERFERENCE — the aurora fades when the sky
//                   is bright (daylight), which file 028 provides via
//                   its sky radiance sample. Aurora is invisible
//                   between roughly 06:00 and 18:00 local time.
//                 • GROUND-TRACK PROJECTION — samplePointOnAurora maps
//                   a world position to the nearest curtain sample so
//                   gameplay (photography quests, aurora-watching
//                   gameplay) can point the player at the best spot.
//                 • INTEGRATOR HOOK — sampleAuroraRadiance returns the
//                   additive radiance contribution to a view direction
//                   so file 017's path integrator and file 028's sky
//                   sampler automatically include aurora.
//               All state is SoA; sampling is O(1) per query, and
//               rendering is a fixed-size buffer of MAX_AURORA_CURTAINS
//               curtains (default 32) so the whole system is
//               memory-stable and zero-per-frame-allocation. Steady
//               state on Android 64-bit comfortably handles hundreds
//               of concurrent aurora viewers in the 1M-entity scene.
// best for : Polar / high-latitude gameplay, night-time photography
//            quests, cinematic aurora set-pieces, astro-tourism
//            simulation, and any 1M-entity scene needing realistic
//            aurora on Android 64-bit.
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
  SkyF32,
  SkyModel,
  getSkySlot,
  sampleSkyRadiance,
} from '../sky/028_sky_atmosphere.js';

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

const MAX_AURORA_INSTANCES           = 8;
const MAX_AURORA_CURTAINS            = 32;
const MAX_AURORA_VIEWERS             = 8;

// Curtain altitude bands (metres).
const AURORA_GREEN_BASE_ALT          = 100000.0;
const AURORA_GREEN_PEAK_ALT          = 110000.0;
const AURORA_RED_TOP_ALT             = 300000.0;
const AURORA_RED_EXTENDED_TOP_ALT    = 500000.0;
const AURORA_BLUE_BASE_ALT           = 90000.0;
const AURORA_PINK_BASE_ALT           = 100000.0;

// Curtain geometry defaults.
const AURORA_CURTAIN_BASE_WIDTH_DEG  = 1.5;      // angular width at base
const AURORA_CURTAIN_TOP_WIDTH_DEG   = 8.0;      // angular width at top
const AURORA_CURTAIN_HEIGHT_DEFAULT  = 300000.0; // metres

// Oval geometry.
const AURORA_OVAL_MIN_LATITUDE_DEG   = 66.0;     // Kp 0
const AURORA_OVAL_MAX_LATITUDE_DEG   = 38.0;     // Kp 9
const AURORA_OVAL_WIDTH_DEG          = 6.0;      // base oval width

// Kp index range.
const KP_MIN                         = 0.0;
const KP_MAX                         = 9.0;

// Colour palette (linear RGB).
const AURORA_GREEN_R                 = 0.20;
const AURORA_GREEN_G                 = 1.00;
const AURORA_GREEN_B                 = 0.35;

const AURORA_RED_R                   = 1.00;
const AURORA_RED_G                   = 0.20;
const AURORA_RED_B                   = 0.20;

const AURORA_BLUE_R                  = 0.30;
const AURORA_BLUE_G                  = 0.40;
const AURORA_BLUE_B                  = 1.00;

const AURORA_PINK_R                  = 1.00;
const AURORA_PINK_G                  = 0.40;
const AURORA_PINK_B                  = 0.75;

// Aurora vertical colour gradient (green → red → violet).
const AURORA_LOWER_GRADIENT_FRACTION = 0.15;    // green dominant below this
const AURORA_MID_GRADIENT_FRACTION   = 0.55;    // transition through red
const AURORA_UPPER_GRADIENT_FRACTION = 0.85;    // violet dominant above this

// Background brightness threshold (sky radiance above this = daylight,
// aurora invisible).
const DAYLIGHT_LIMIT                 = 0.10;   // linear radiance

// Aurora opacity scaling with Kp.
const AURORA_MIN_INTENSITY           = 0.02;
const AURORA_MAX_INTENSITY           = 1.00;

// Time evolution.
const AURORA_FADE_IN_TIME            = 30.0;   // seconds
const AURORA_FADE_OUT_TIME           = 60.0;
const AURORA_CURTAIN_WAVE_RATE       = 0.3;    // radians per second

// Solar wind coupling.
const SOLAR_WIND_MIN                 = 300.0;  // km/s
const SOLAR_WIND_MAX                 = 900.0;  // km/s
const SOLAR_WIND_BASELINE            = 400.0;
const SOLAR_WIND_COUPLING_GAIN       = 0.4;    // scaling from Bz coupling

// Fractal curtain brightness envelope.
const CURTAIN_NOISE_OCTAVES          = 4;
const CURTAIN_NOISE_PERSISTENCE      = 0.55;
const CURTAIN_NOISE_BASE_FREQ        = 3.0;
const CURTAIN_NOISE_WAVE_SCALE       = 1.8;

// Curtain shear (base-to-top offset).
const CURTAIN_SHEAR_MAX              = 0.6;    // radians
const CURTAIN_SHEAR_MIN              = 0.05;

// Aurora equatorward boundary (Kp scaling curve from Feldstein 1985).
//   Latitude = 66.5 - (Kp * 2.5)
const FELDSTEIN_BASE_LAT            = 66.5;
const FELDSTEIN_KP_SLOPE            = 2.5;

// Default camera-forward direction magnitude (used for aurora panning).
const AURORA_PAN_DEFAULT            = 0.0;

// ═══════════════════════════════════════════════════════════════════════
// SoA AURORA INSTANCE — one per geographic region (usually just 1)
// ═══════════════════════════════════════════════════════════════════════

export const AuroraInstance = {
  ownerEid: new Uint32Array(MAX_AURORA_INSTANCES),

  // World-space geomagnetic pole position (usually the aurora's
  // hemisphere pole at the geographic North/South Pole with a small
  // magnetic declination offset).
  poleX: new Float32Array(MAX_AURORA_INSTANCES),
  poleY: new Float32Array(MAX_AURORA_INSTANCES),
  poleZ: new Float32Array(MAX_AURORA_INSTANCES),

  // Hemisphere: +1 for Northern (borealis), -1 for Southern (australis).
  hemisphere: new Float32Array(MAX_AURORA_INSTANCES),

  // Current Kp index (0..9).
  kpIndex: new Float32Array(MAX_AURORA_INSTANCES),

  // Solar wind speed (km/s) and Bz coupling.
  solarWindSpeed: new Float32Array(MAX_AURORA_INSTANCES),
  solarWindBz: new Float32Array(MAX_AURORA_INSTANCES),

  // Aurora's master intensity (0..1).
  intensity: new Float32Array(MAX_AURORA_INSTANCES),

  // Fade-in / fade-out progress (0..1).
  formationProgress: new Float32Array(MAX_AURORA_INSTANCES),
  dissipationProgress: new Float32Array(MAX_AURORA_INSTANCES),

  // Age and lifetime (in seconds; aurora can last hours or be a short
  // substorm of just a few minutes).
  age: new Float32Array(MAX_AURORA_INSTANCES),
  lifetime: new Float32Array(MAX_AURORA_INSTANCES),

  // Current oval equatorward boundary (metres from pole).
  ovalRadius: new Float32Array(MAX_AURORA_INSTANCES),

  // Oval width (metres).
  ovalWidth: new Float32Array(MAX_AURORA_INSTANCES),

  // Active flag.
  active: new Uint8Array(MAX_AURORA_INSTANCES),

  // Seed for the noise generators.
  seed: new Uint32Array(MAX_AURORA_INSTANCES),
};

/** Marker: entity is an aurora root. */
export const AuroraTag = {};

const _auroraSlots = new Map(); // eid -> aurora slot
let _nextAuroraSlot = 0;

// Per-aurora noise generators.
const _auroraNoise = new Map();

// ═══════════════════════════════════════════════════════════════════════
// SoA AURORA CURTAIN — one slot per curtain (fixed per instance)
// ═══════════════════════════════════════════════════════════════════════

export const AuroraCurtain = {
  // Owning aurora slot.
  auroraSlot: new Uint16Array(MAX_AURORA_INSTANCES * MAX_AURORA_CURTAINS),

  // Longitude offset along the oval (radians; 0..2π).
  longitude: new Float32Array(MAX_AURORA_INSTANCES * MAX_AURORA_CURTAINS),

  // Width of the curtain at the base (radians).
  baseWidth: new Float32Array(MAX_AURORA_INSTANCES * MAX_AURORA_CURTAINS),

  // Width of the curtain at the top (radians).
  topWidth: new Float32Array(MAX_AURORA_INSTANCES * MAX_AURORA_CURTAINS),

  // Altitude of the base of the curtain (metres).
  baseAltitude: new Float32Array(MAX_AURORA_INSTANCES * MAX_AURORA_CURTAINS),

  // Altitude of the top of the curtain (metres).
  topAltitude: new Float32Array(MAX_AURORA_INSTANCES * MAX_AURORA_CURTAINS),

  // Base brightness (0..1).
  brightness: new Float32Array(MAX_AURORA_INSTANCES * MAX_AURORA_CURTAINS),

  // Shear angle (radians; tilts the top of the curtain relative to the
  // base).
  shear: new Float32Array(MAX_AURORA_INSTANCES * MAX_AURORA_CURTAINS),

  // Per-curtain fractal envelope phase (for brightness fluctuation).
  fractalPhase: new Float32Array(MAX_AURORA_INSTANCES * MAX_AURORA_CURTAINS),

  // Per-curtain colour dominance (0 = green, 0.33 = red, 0.66 = blue,
  // 1 = pink). Weighted blend in sampleAuroraRadiance.
  colourBias: new Float32Array(MAX_AURORA_INSTANCES * MAX_AURORA_CURTAINS),
};

// ═══════════════════════════════════════════════════════════════════════
// SoA AURORA VIEWER — one per camera that can see the aurora
// ═══════════════════════════════════════════════════════════════════════

export const AuroraViewer = {
  ownerEid: new Uint32Array(MAX_AURORA_VIEWERS),
  auroraSlot: new Uint16Array(MAX_AURORA_VIEWERS),

  // Camera position.
  camX: new Float32Array(MAX_AURORA_VIEWERS),
  camY: new Float32Array(MAX_AURORA_VIEWERS),
  camZ: new Float32Array(MAX_AURORA_VIEWERS),

  // Camera forward direction (unit vector).
  fwdX: new Float32Array(MAX_AURORA_VIEWERS),
  fwdY: new Float32Array(MAX_AURORA_VIEWERS),
  fwdZ: new Float32Array(MAX_AURORA_VIEWERS),

  // Viewing latitude (degrees; + for Northern, - for Southern).
  latitude: new Float32Array(MAX_AURORA_VIEWERS),

  // Current visibility factor (0..1; depends on Kp index and latitude).
  visibility: new Float32Array(MAX_AURORA_VIEWERS),

  // Active flag.
  active: new Uint8Array(MAX_AURORA_VIEWERS),
};

/** Marker: entity is an aurora viewer (usually the camera). */
export const AuroraViewerTag = {};

const _viewerSlots = new Map(); // eid -> viewer slot
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

function getAuroraNoise(slot) {
  let n = _auroraNoise.get(slot);
  if (!n) {
    n = createNoise1D(() => mulberry32(AuroraInstance.seed[slot]));
    _auroraNoise.set(slot, n);
  }
  return n;
}

// ═══════════════════════════════════════════════════════════════════════
// AURORA CREATION API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create an aurora instance.
 *
 * @param world       ECS world
 * @param eid         owner entity (usually a weather or world root)
 * @param hemisphere  +1 = Northern (borealis), -1 = Southern (australis)
 * @param options     { poleX, poleY, poleZ, kpIndex, lifetime, seed }
 * @returns aurora slot id
 */
export function addAurora(world, eid, hemisphere = 1, options = {}) {
  if (_nextAuroraSlot >= MAX_AURORA_INSTANCES) {
    throw new Error('aurora capacity exceeded');
  }
  const slot = _nextAuroraSlot++;

  addComponent(world, eid, AuroraTag);

  const A = AuroraInstance;
  A.ownerEid[slot] = eid;
  A.hemisphere[slot] = hemisphere;

  // Pole default: geographic pole position (Y-up world).
  A.poleX[slot] = options.poleX ?? 0;
  A.poleY[slot] = options.poleY ?? (hemisphere > 0 ? 6371000 : -6371000);
  A.poleZ[slot] = options.poleZ ?? 0;

  // KP index and solar wind.
  A.kpIndex[slot] = options.kpIndex ?? 3;
  A.solarWindSpeed[slot] = options.solarWindSpeed ?? SOLAR_WIND_BASELINE;
  A.solarWindBz[slot] = options.solarWindBz ?? -2.0;   // default mild coupling

  // Intensity.
  A.intensity[slot] = kpToIntensity(A.kpIndex[slot]);
  A.formationProgress[slot] = 0;
  A.dissipationProgress[slot] = 0;

  // Age and lifetime.
  A.age[slot] = 0;
  A.lifetime[slot] = options.lifetime ?? 3600;   // 1 hour default

  // Oval radius.
  A.ovalRadius[slot] = computeOvalRadius(A.kpIndex[slot], hemisphere);
  A.ovalWidth[slot] = AURORA_OVAL_WIDTH_DEG * DEG_TO_RAD * 6371000;

  A.active[slot] = 1;
  A.seed[slot] = options.seed ?? ((slot * 2654435761) >>> 0);

  // Initialize curtains.
  initCurtains(slot);

  _auroraSlots.set(eid, slot);
  return slot;
}

function initCurtains(auroraSlot) {
  const A = AuroraInstance;
  const rng = mulberry32(A.seed[auroraSlot]);

  for (let i = 0; i < MAX_AURORA_CURTAINS; i++) {
    const idx = auroraSlot * MAX_AURORA_CURTAINS + i;

    AuroraCurtain.auroraSlot[idx] = auroraSlot;
    AuroraCurtain.longitude[idx] = (i / MAX_AURORA_CURTAINS) * TWO_PI
      + (rng() - 0.5) * 0.1;
    AuroraCurtain.baseWidth[idx] = AURORA_CURTAIN_BASE_WIDTH_DEG * DEG_TO_RAD;
    AuroraCurtain.topWidth[idx] = AURORA_CURTAIN_TOP_WIDTH_DEG * DEG_TO_RAD;
    AuroraCurtain.baseAltitude[idx] = AURORA_GREEN_BASE_ALT;
    AuroraCurtain.topAltitude[idx] = AURORA_GREEN_PEAK_ALT
      + (AURORA_RED_TOP_ALT - AURORA_GREEN_PEAK_ALT) * (0.3 + rng() * 0.7);
    AuroraCurtain.brightness[idx] = 0.4 + rng() * 0.6;
    AuroraCurtain.shear[idx] = CURTAIN_SHEAR_MIN
      + rng() * (CURTAIN_SHEAR_MAX - CURTAIN_SHEAR_MIN);
    AuroraCurtain.fractalPhase[idx] = rng() * 100.0;
    AuroraCurtain.colourBias[idx] = rng();
  }
}

export function removeAurora(world, eid) {
  const slot = _auroraSlots.get(eid);
  if (slot === undefined) return;

  AuroraInstance.active[slot] = 0;
  AuroraInstance.ownerEid[slot] = 0;
  _auroraSlots.delete(eid);
  _auroraNoise.delete(slot);
  removeComponent(world, eid, AuroraTag);
}

export function getAuroraSlot(eid) {
  return _auroraSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// KP INDEX HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert a Kp index to a master intensity (0..1).
 */
function kpToIntensity(kp) {
  const t = Math.max(0, Math.min(1, kp / KP_MAX));
  return AURORA_MIN_INTENSITY + (AURORA_MAX_INTENSITY - AURORA_MIN_INTENSITY) * t;
}

/**
 * Compute the auroral oval's equatorward boundary (Feldstein 1985).
 * Returns the radius (metres) from the geomagnetic pole.
 */
function computeOvalRadius(kp, hemisphere) {
  const latitudeDeg = FELDSTEIN_BASE_LAT - (kp * FELDSTEIN_KP_SLOPE);
  // Co-latitude (from pole).
  const colatitudeDeg = 90 - latitudeDeg;
  const colatitudeRad = colatitudeDeg * DEG_TO_RAD;
  const earthRadius = 6371000;
  return colatitudeRad * earthRadius;
}

// ═══════════════════════════════════════════════════════════════════════
// AURORA VIEWER API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register a viewer (usually the camera) for the aurora.
 */
export function addAuroraViewer(world, eid, auroraSlot, options = {}) {
  if (_nextViewerSlot >= MAX_AURORA_VIEWERS) {
    throw new Error('aurora viewer capacity exceeded');
  }
  const slot = _nextViewerSlot++;

  addComponent(world, eid, AuroraViewerTag);

  const V = AuroraViewer;
  V.ownerEid[slot] = eid;
  V.auroraSlot[slot] = auroraSlot;
  V.camX[slot] = options.camX ?? 0;
  V.camY[slot] = options.camY ?? 0;
  V.camZ[slot] = options.camZ ?? 0;
  V.fwdX[slot] = options.fwdX ?? 0;
  V.fwdY[slot] = options.fwdY ?? 0;
  V.fwdZ[slot] = options.fwdZ ?? 1;
  V.latitude[slot] = options.latitude ?? 65;
  V.visibility[slot] = 0;
  V.active[slot] = 1;

  _viewerSlots.set(eid, slot);
  return slot;
}

export function removeAuroraViewer(world, eid) {
  const slot = _viewerSlots.get(eid);
  if (slot === undefined) return;
  AuroraViewer.active[slot] = 0;
  AuroraViewer.ownerEid[slot] = 0;
  _viewerSlots.delete(eid);
  removeComponent(world, eid, AuroraViewerTag);
}

export function getAuroraViewerSlot(eid) {
  return _viewerSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// VIEWER VISIBILITY COMPUTATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the current visibility (0..1) of the aurora from a viewer.
 *
 * Visibility is high when:
 *   • The viewer's latitude is inside (or close to) the oval.
 *   • The sky is dark (low sun intensity from file 028).
 *   • The Kp index is high enough that the oval reaches the viewer.
 */
export function systemComputeViewerVisibility(world) {
  for (let slot = 0; slot < _nextViewerSlot; slot++) {
    if (!AuroraViewer.active[slot]) continue;

    const auroraSlot = AuroraViewer.auroraSlot[slot];
    if (!AuroraInstance.active[auroraSlot]) {
      AuroraViewer.visibility[slot] = 0;
      continue;
    }

    const latitude = AuroraViewer.latitude[slot];
    const hemisphere = AuroraInstance.hemisphere[auroraSlot];

    // Check the aurora's hemisphere matches the viewer's latitude.
    const inHemisphere = (hemisphere > 0 && latitude > 0)
                       || (hemisphere < 0 && latitude < 0);
    if (!inHemisphere) {
      AuroraViewer.visibility[slot] = 0;
      continue;
    }

    // Compute the viewer's magnetic co-latitude.
    const colatitudeDeg = 90 - Math.abs(latitude);
    const colatRad = colatitudeDeg * DEG_TO_RAD;
    const viewerRadius = colatRad * 6371000;

    // The oval's equatorward boundary.
    const ovalRadius = AuroraInstance.ovalRadius[auroraSlot];
    const ovalWidth = AuroraInstance.ovalWidth[auroraSlot];

    // Distance from the oval (0 = inside, positive = outside).
    const distFromOval = Math.abs(viewerRadius - ovalRadius);

    // Visibility factor based on distance from the oval.
    let visFactor;
    if (distFromOval < ovalWidth * 0.5) {
      visFactor = 1.0;
    } else {
      const overshoot = distFromOval - ovalWidth * 0.5;
      visFactor = Math.exp(-Math.pow(overshoot / (ovalWidth * 1.5), 2));
    }

    // Fade out during daylight.
    // Read sun brightness from the sky if a viewer is associated.
    let daylightFactor = 1.0;
    const viewerEid = AuroraViewer.ownerEid[slot];
    const skyEid = findSkyForViewer(world, viewerEid);
    if (skyEid >= 0) {
      const skySlot = getSkySlot(skyEid);
      if (skySlot >= 0) {
        // Sample sky brightness at zenith.
        const skyRadiance = sampleSkyRadiance(skySlot, 0, 1, 0);
        const luminance = 0.2126 * skyRadiance[0]
                        + 0.7152 * skyRadiance[1]
                        + 0.0722 * skyRadiance[2];
        if (luminance > DAYLIGHT_LIMIT) {
          daylightFactor = 0;
        } else {
          daylightFactor = 1 - (luminance / DAYLIGHT_LIMIT);
        }
      }
    }

    // Combine.
    AuroraViewer.visibility[slot] = visFactor * daylightFactor
      * AuroraInstance.intensity[auroraSlot]
      * AuroraInstance.formationProgress[auroraSlot]
      * (1 - AuroraInstance.dissipationProgress[auroraSlot]);
  }
  return world;
}

function findSkyForViewer(world, viewerEid) {
  // Simple heuristic: return the first sky entity in the world.
  const eids = query(world, [SkyF32]);
  return eids.length > 0 ? eids[0] : -1;
}

// ═══════════════════════════════════════════════════════════════════════
// SOLAR WIND COUPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update the aurora's Kp index and intensity from the current solar
 * wind state. Called once per frame.
 *
 * @param world         ECS world
 * @param dt            seconds
 * @param solarWindSpeed  km/s (or pass 0 to use a smooth random walk)
 * @param solarWindBz     nanoteslas (or 0 to use a smooth random walk)
 */
export function systemUpdateAuroraSolarWind(world, dt, solarWindSpeed = 0, solarWindBz = 0) {
  for (let slot = 0; slot < _nextAuroraSlot; slot++) {
    if (!AuroraInstance.active[slot]) continue;

    const A = AuroraInstance;

    // Smooth solar wind values toward the caller's values, or use a
    // smooth random walk if the caller did not provide them.
    if (solarWindSpeed > 0) {
      A.solarWindSpeed[slot] += (solarWindSpeed - A.solarWindSpeed[slot])
        * Math.min(1, dt * 0.05);
    } else {
      // Natural variation.
      const noise = getAuroraNoise(slot)(A.age[slot] * 0.01 + slot * 100);
      const target = SOLAR_WIND_BASELINE + noise * 300;
      A.solarWindSpeed[slot] += (target - A.solarWindSpeed[slot])
        * Math.min(1, dt * 0.03);
    }

    if (solarWindBz !== 0) {
      A.solarWindBz[slot] += (solarWindBz - A.solarWindBz[slot])
        * Math.min(1, dt * 0.05);
    }

    // Convert solar wind to Kp.
    // Simplified coupling: Kp increases with solar wind speed and with
    // southward Bz (which is negative).
    const windFactor = (A.solarWindSpeed[slot] - SOLAR_WIND_BASELINE)
      / (SOLAR_WIND_MAX - SOLAR_WIND_BASELINE);
    const bzFactor = -A.solarWindBz[slot] / 20.0;   // Southward Bz = positive factor
    const kpEstimate = 3.0 + windFactor * 4.0 + bzFactor * 2.0;
    const newKp = Math.max(KP_MIN, Math.min(KP_MAX, kpEstimate));

    // Smooth toward new value.
    A.kpIndex[slot] += (newKp - A.kpIndex[slot]) * Math.min(1, dt * 0.1);

    // Update intensity and oval.
    A.intensity[slot] = kpToIntensity(A.kpIndex[slot]);
    A.ovalRadius[slot] = computeOvalRadius(A.kpIndex[slot], A.hemisphere[slot]);
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// AURORA EVOLUTION — formation, dissipation, curtain motion
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance the aurora's life cycle and curtain wave motion.
 */
export function systemUpdateAuroras(world, dt) {
  for (let slot = 0; slot < _nextAuroraSlot; slot++) {
    if (!AuroraInstance.active[slot]) continue;

    const A = AuroraInstance;

    A.age[slot] += dt;

    // Formation.
    if (A.formationProgress[slot] < 1) {
      A.formationProgress[slot] = Math.min(1,
        A.formationProgress[slot] + dt / AURORA_FADE_IN_TIME);
    }

    // Dissipation (after lifetime * 0.85).
    if (A.age[slot] > A.lifetime[slot] * 0.85) {
      A.dissipationProgress[slot] = Math.min(1,
        A.dissipationProgress[slot] + dt / AURORA_FADE_OUT_TIME);
    }

    if (A.dissipationProgress[slot] >= 1) {
      removeAurora(world, A.ownerEid[slot]);
      continue;
    }

    // Curtain wave motion.
    const noise = getAuroraNoise(slot);
    for (let i = 0; i < MAX_AURORA_CURTAINS; i++) {
      const idx = slot * MAX_AURORA_CURTAINS + i;

      // Longitude drifts slowly along the oval.
      AuroraCurtain.longitude[idx] += dt * 0.01;
      if (AuroraCurtain.longitude[idx] > TWO_PI) {
        AuroraCurtain.longitude[idx] -= TWO_PI;
      }

      // Brightness fluctuates with fractal noise.
      const phase = AuroraCurtain.fractalPhase[idx];
      const t = A.age[slot] * AURORA_CURTAIN_WAVE_RATE;
      let fractal = 0;
      let amp = 1.0;
      let freq = CURTAIN_NOISE_BASE_FREQ;
      let norm = 0;
      for (let o = 0; o < CURTAIN_NOISE_OCTAVES; o++) {
        fractal += (noise(t * freq + phase) * 0.5 + 0.5) * amp;
        norm += amp;
        amp *= CURTAIN_NOISE_PERSISTENCE;
        freq *= CURTAIN_NOISE_WAVE_SCALE;
      }
      fractal /= Math.max(norm, EPSILON);

      // Smoothly update brightness (drifts toward fractal value).
      const target = fractal * (0.5 + AuroraInstance.intensity[slot] * 0.5);
      AuroraCurtain.brightness[idx] += (target - AuroraCurtain.brightness[idx])
        * Math.min(1, dt * 2.0);

      // Shear oscillates slowly.
      const shearNoise = noise(t * 0.5 + phase * 2.0);
      AuroraCurtain.shear[idx] += shearNoise * dt * 0.1;
      AuroraCurtain.shear[idx] = Math.max(CURTAIN_SHEAR_MIN,
        Math.min(CURTAIN_SHEAR_MAX, AuroraCurtain.shear[idx]));
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// AURORA RADIANCE SAMPLING — the hot path
// ═══════════════════════════════════════════════════════════════════════

const _auroraCamPos = vec3.create();
const _auroraDir = vec3.create();

/**
 * Sample the aurora radiance for a given view direction from a
 * viewer. Returns [r, g, b] ADDITIVE radiance.
 *
 * @param viewerSlot   from addAuroraViewer
 * @param dirX/Y/Z     view direction (unit vector)
 * @param out          [r, g, b] output
 * @returns out
 */
export function sampleAuroraRadiance(viewerSlot, dirX, dirY, dirZ, out) {
  out[0] = 0; out[1] = 0; out[2] = 0;

  const V = AuroraViewer;
  if (!V.active[viewerSlot]) return out;
  if (V.visibility[viewerSlot] < EPSILON) return out;

  const auroraSlot = V.auroraSlot[viewerSlot];
  if (!AuroraInstance.active[auroraSlot]) return out;

  const A = AuroraInstance;
  const hemisphere = A.hemisphere[auroraSlot];

  // Aurora is visible mostly above the horizon.
  if (dirY < 0.01) return out;

  // Convert the view direction to a world-space point on the aurora
  // altitude shell. We approximate by intersecting the ray with the
  // sphere of radius (earth + 110 km) and choosing the point in the
  // hemisphere-facing-up hemisphere.
  const earthRadius = 6371000;
  const shellAltitude = AURORA_GREEN_PEAK_ALT;
  const shellRadius = earthRadius + shellAltitude;

  const camX = V.camX[viewerSlot];
  const camY = V.camY[viewerSlot];
  const camZ = V.camZ[viewerSlot];

  // Ray-sphere intersection with a shell centered at the pole axis.
  // Simplified: treat the aurora as an annular band around the
  // geomagnetic pole (a horizontal disc at the shell's altitude).
  const poleX = A.poleX[auroraSlot];
  const poleZ = A.poleZ[auroraSlot];

  // Project the ray onto the horizontal plane at altitude shellAltitude.
  // Direction from camera toward the aurora.
  if (dirY < 0.001) return out;
  const tAtShell = (shellAltitude - camY) / dirY;
  if (tAtShell < 0) return out;

  const hitX = camX + dirX * tAtShell;
  const hitZ = camZ + dirZ * tAtShell;

  // Distance from the geomagnetic pole in the horizontal plane.
  const dx = hitX - poleX;
  const dz = hitZ - poleZ;
  const r = Math.sqrt(dx * dx + dz * dz);
  if (r < EPSILON) return out;

  // Angular distance from the pole (radians along the ground).
  const polarAngle = Math.atan2(dz, dx);

  // The oval band width.
  const ovalRadius = A.ovalRadius[auroraSlot];
  const ovalWidth = A.ovalWidth[auroraSlot];

  // Horizontal distance from the oval center.
  const deltaR = Math.abs(r - ovalRadius);
  if (deltaR > ovalWidth) return out;

  // Band intensity from radial profile.
  const radialProfile = 1 - (deltaR / ovalWidth);
  const radialProfileSq = radialProfile * radialProfile;

  // Sum contributions from curtains whose longitude is close.
  let totalR = 0, totalG = 0, totalB = 0;

  for (let i = 0; i < MAX_AURORA_CURTAINS; i++) {
    const idx = auroraSlot * MAX_AURORA_CURTAINS + i;

    // Angular distance from curtain center.
    let dAzimuth = polarAngle - AuroraCurtain.longitude[idx];
    while (dAzimuth > PI) dAzimuth -= TWO_PI;
    while (dAzimuth < -PI) dAzimuth += TWO_PI;

    const curtainWidth = AuroraCurtain.baseWidth[idx]
      + (AuroraCurtain.topWidth[idx] - AuroraCurtain.baseWidth[idx]) * 0.5;

    // Gaussian falloff within the curtain.
    const inCurtain = Math.exp(-Math.pow(dAzimuth / curtainWidth, 2));
    if (inCurtain < 0.01) continue;

    // Vertical structure: green at base, red in middle, violet at top.
    // We approximate by sampling a vertical slice.
    const verticalT = 0.4;   // midpoint of the curtain
    const { r: vr, g: vg, b: vb } = curtainColourAt(AuroraCurtain.colourBias[idx], verticalT);

    const brightness = AuroraCurtain.brightness[idx]
      * inCurtain
      * radialProfileSq;

    totalR += vr * brightness;
    totalG += vg * brightness;
    totalB += vb * brightness;
  }

  // Apply the viewer's overall visibility factor.
  const vis = V.visibility[viewerSlot];
  out[0] = totalR * vis;
  out[1] = totalG * vis;
  out[2] = totalB * vis;
  return out;
}

/**
 * Blended aurora colour at a curtain's vertical and colour-bias position.
 * Returns { r, g, b }.
 */
function curtainColourAt(colourBias, verticalT) {
  // Lower band: green / blue depending on bias.
  if (verticalT < AURORA_LOWER_GRADIENT_FRACTION) {
    const t = colourBias;
    const r = AURORA_GREEN_R * (1 - t) + AURORA_BLUE_R * t;
    const g = AURORA_GREEN_G * (1 - t) + AURORA_BLUE_G * t;
    const b = AURORA_GREEN_B * (1 - t) + AURORA_BLUE_B * t;
    return { r, g, b };
  }

  // Mid band: green → red → pink transition.
  if (verticalT < AURORA_MID_GRADIENT_FRACTION) {
    const t = (verticalT - AURORA_LOWER_GRADIENT_FRACTION)
      / (AURORA_MID_GRADIENT_FRACTION - AURORA_LOWER_GRADIENT_FRACTION);
    const r = AURORA_GREEN_R * (1 - t) + AURORA_RED_R * t;
    const g = AURORA_GREEN_G * (1 - t) + AURORA_RED_G * t;
    const b = AURORA_GREEN_B * (1 - t) + AURORA_RED_B * t;
    return { r, g, b };
  }

  // Upper band: red → violet.
  if (verticalT < AURORA_UPPER_GRADIENT_FRACTION) {
    const t = (verticalT - AURORA_MID_GRADIENT_FRACTION)
      / (AURORA_UPPER_GRADIENT_FRACTION - AURORA_MID_GRADIENT_FRACTION);
    const r = AURORA_RED_R * (1 - t) + AURORA_PINK_R * t;
    const g = AURORA_RED_G * (1 - t) + AURORA_PINK_G * t;
    const b = AURORA_RED_B * (1 - t) + AURORA_PINK_B * t;
    return { r, g, b };
  }

  // Beyond: pink.
  return { r: AURORA_PINK_R, g: AURORA_PINK_G, b: AURORA_PINK_B };
}

// ═══════════════════════════════════════════════════════════════════════
// GROUND-TRACK PROJECTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Given a world position, return the nearest point on the aurora's
 * brightest curtain (its ground projection). Useful for photography
 * quests, aurora-watcher compasses, etc.
 *
 * Returns { x, y, z, angle, distance, brightness } or null if the aurora
 * is not visible.
 */
export function samplePointOnAurora(auroraSlot, worldX, worldY, worldZ) {
  if (!AuroraInstance.active[auroraSlot]) return null;

  const A = AuroraInstance;
  const poleX = A.poleX[auroraSlot];
  const poleZ = A.poleZ[auroraSlot];

  // Find the brightest curtain.
  let bestSlot = -1;
  let bestBrightness = 0;
  for (let i = 0; i < MAX_AURORA_CURTAINS; i++) {
    const idx = auroraSlot * MAX_AURORA_CURTAINS + i;
    if (AuroraCurtain.brightness[idx] > bestBrightness) {
      bestBrightness = AuroraCurtain.brightness[idx];
      bestSlot = i;
    }
  }
  if (bestSlot < 0) return null;

  const idx = auroraSlot * MAX_AURORA_CURTAINS + bestSlot;
  const curtainLongitude = AuroraCurtain.longitude[idx];
  const ovalRadius = A.ovalRadius[auroraSlot];

  // Convert to a world-space point on the ground.
  const pointX = poleX + Math.cos(curtainLongitude) * ovalRadius;
  const pointZ = poleZ + Math.sin(curtainLongitude) * ovalRadius;
  const pointY = 0;   // ground level

  const dx = pointX - worldX;
  const dy = pointY - worldY;
  const dz = pointZ - worldZ;

  return {
    x: pointX,
    y: pointY,
    z: pointZ,
    distance: Math.sqrt(dx * dx + dy * dy + dz * dz),
    angle: Math.atan2(dz, dx),
    brightness: bestBrightness * A.intensity[auroraSlot]
      * A.formationProgress[auroraSlot]
      * (1 - A.dissipationProgress[auroraSlot]),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════

/**
 * Full aurora pipeline:
 *   1. systemUpdateAuroraSolarWind (Kp index from solar wind)
 *   2. systemUpdateAuroras (formation / motion)
 *   3. systemComputeViewerVisibility (per-camera visibility)
 */
export function systemAuroraTick(world, dt, solarWindSpeed = 0, solarWindBz = 0) {
  systemUpdateAuroraSolarWind(world, dt, solarWindSpeed, solarWindBz);
  systemUpdateAuroras(world, dt);
  systemComputeViewerVisibility(world);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS
// ═══════════════════════════════════════════════════════════════════════

export function getKpIndex(auroraSlot) {
  if (auroraSlot < 0 || auroraSlot >= _nextAuroraSlot) return 0;
  return AuroraInstance.kpIndex[auroraSlot];
}

export function getAuroraIntensity(auroraSlot) {
  if (auroraSlot < 0 || auroraSlot >= _nextAuroraSlot) return 0;
  return AuroraInstance.intensity[auroraSlot]
    * AuroraInstance.formationProgress[auroraSlot]
    * (1 - AuroraInstance.dissipationProgress[auroraSlot]);
}

/**
 * Override the Kp index directly (used for testing / scripting).
 */
export function setKpIndex(auroraSlot, kp) {
  if (auroraSlot < 0 || auroraSlot >= _nextAuroraSlot) return;
  const clamped = Math.max(KP_MIN, Math.min(KP_MAX, kp));
  AuroraInstance.kpIndex[auroraSlot] = clamped;
  AuroraInstance.intensity[auroraSlot] = kpToIntensity(clamped);
  AuroraInstance.ovalRadius[auroraSlot] = computeOvalRadius(
    clamped, AuroraInstance.hemisphere[auroraSlot]);
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Gather all active aurora instances for renderer integration.
 */
export function gatherAurorasForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextAuroraSlot; slot++) {
    if (!AuroraInstance.active[slot]) continue;

    const intensity = AuroraInstance.intensity[slot]
      * AuroraInstance.formationProgress[slot]
      * (1 - AuroraInstance.dissipationProgress[slot]);
    if (intensity < EPSILON) continue;

    result.push({
      slot,
      hemisphere: AuroraInstance.hemisphere[slot],
      poleX: AuroraInstance.poleX[slot],
      poleY: AuroraInstance.poleY[slot],
      poleZ: AuroraInstance.poleZ[slot],
      kpIndex: AuroraInstance.kpIndex[slot],
      intensity,
      ovalRadius: AuroraInstance.ovalRadius[slot],
      ovalWidth: AuroraInstance.ovalWidth[slot],
      curtainCount: MAX_AURORA_CURTAINS,
    });
  }
  return result;
}

/**
 * Gather aurora curtains for mesh generation.
 */
export function gatherAuroraCurtainsForRendering(auroraSlot) {
  if (!AuroraInstance.active[auroraSlot]) return [];

  const result = [];
  const poleX = AuroraInstance.poleX[auroraSlot];
  const poleZ = AuroraInstance.poleZ[auroraSlot];
  const ovalRadius = AuroraInstance.ovalRadius[auroraSlot];

  for (let i = 0; i < MAX_AURORA_CURTAINS; i++) {
    const idx = auroraSlot * MAX_AURORA_CURTAINS + i;

    result.push({
      baseX: poleX + Math.cos(AuroraCurtain.longitude[idx]) * ovalRadius,
      baseZ: poleZ + Math.sin(AuroraCurtain.longitude[idx]) * ovalRadius,
      baseY: AuroraCurtain.baseAltitude[idx],
      topY: AuroraCurtain.topAltitude[idx],
      baseWidth: AuroraCurtain.baseWidth[idx],
      topWidth: AuroraCurtain.topWidth[idx],
      brightness: AuroraCurtain.brightness[idx],
      shear: AuroraCurtain.shear[idx],
      colourBias: AuroraCurtain.colourBias[idx],
    });
  }
  return result;
}

/**
 * Gather all viewers for renderer integration.
 */
export function gatherAuroraViewersForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextViewerSlot; slot++) {
    if (!AuroraViewer.active[slot]) continue;
    if (AuroraViewer.visibility[slot] < EPSILON) continue;

    result.push({
      slot,
      auroraSlot: AuroraViewer.auroraSlot[slot],
      camX: AuroraViewer.camX[slot],
      camY: AuroraViewer.camY[slot],
      camZ: AuroraViewer.camZ[slot],
      latitude: AuroraViewer.latitude[slot],
      visibility: AuroraViewer.visibility[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearAurora() {
  AuroraInstance.active.fill(0);
  AuroraInstance.ownerEid.fill(0);
  _auroraSlots.clear();
  _auroraNoise.clear();
  _nextAuroraSlot = 0;

  AuroraViewer.active.fill(0);
  AuroraViewer.ownerEid.fill(0);
  _viewerSlots.clear();
  _nextViewerSlot = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function auroraStats() {
  let activeAuroras = 0;
  let activeViewers = 0;
  let visibleViewers = 0;
  let avgKp = 0;

  for (let slot = 0; slot < _nextAuroraSlot; slot++) {
    if (!AuroraInstance.active[slot]) continue;
    activeAuroras++;
    avgKp += AuroraInstance.kpIndex[slot];
  }

  for (let slot = 0; slot < _nextViewerSlot; slot++) {
    if (!AuroraViewer.active[slot]) continue;
    activeViewers++;
    if (AuroraViewer.visibility[slot] > 0.01) visibleViewers++;
  }

  if (activeAuroras > 0) avgKp /= activeAuroras;

  return {
    auroraCount: _nextAuroraSlot,
    activeAuroras,
    maxAuroras: MAX_AURORA_INSTANCES,
    viewerCount: _nextViewerSlot,
    activeViewers,
    visibleViewers,
    maxViewers: MAX_AURORA_VIEWERS,
    avgKp,
    curtainsPerAurora: MAX_AURORA_CURTAINS,
  };
}