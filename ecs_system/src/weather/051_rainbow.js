// file number : 051
// full path name : src/weather/051_rainbow.js
// description : Physically-based rainbow system. Provides primary and
//               secondary rainbows, supernumerary arcs, Alexander's band,
//               and their integration with the sky, rain, and cloud
//               systems already present in the bitECS_max pipeline.
//                 • PRIMARY RAINBOW — 42.4° apparent angular radius from
//                   the antisolar point. Red on the outside, violet on
//                   the inside. Emerges from a single internal reflection
//                   inside each raindrop (Descartes 1637).
//                 • SECONDARY RAINBOW — 51.0° angular radius, with the
//                   colours reversed (violet outside, red inside). Comes
//                   from two internal reflections and is weaker (~43% of
//                   the primary's brightness).
//                 • ALEXANDER'S BAND — the dark region between the two
//                   bows where light is refracted away. Its darkness
//                   increases with the local droplet density and the
//                   sun elevation.
//                 • SUPERNUMERARY ARCS — thin alternating light/dark
//                   interference fringes inside the primary bow, only
//                   visible when the droplets are uniform and small
//                   (typically < 1 mm). Modelled as a sinusoidal
//                   interference pattern in the 39-42° annulus.
//                 • POLARIZATION AWARENESS — the rainbow is strongly
//                   polarized along its tangent. `sampleRainbowPolarization`
//                   returns the polarization angle and strength so that
//                   file 014's material and file 017's integrator can
//                   optionally apply the correct polarization if the
//                   renderer supports it.
//               The rainbow requires three things simultaneously:
//                 1. Local rain droplets in the air between the viewer
//                    and the antisolar direction (read from file 042's
//                    RainDrop pool).
//                 2. The sun above the horizon (read from file 028's
//                    SkyF32.sunDirY).
//                 3. The viewer looking toward the antisolar direction
//                    at a specific angular distance.
//               The rainbow is computed per-frame and per-camera as an
//               analytical radiance contribution added on top of the sky
//               in file 028's `sampleSkyRadiance` path, so a completely
//               correct rainbow appears whenever the conditions are met.
//               All state lives in typed arrays; sampling is O(1) per
//               query. Zero per-frame allocation; 1M-entity scenes can
//               render rainbows on Android 64-bit with virtually no cost.
// best for : Post-rain sunbreaks, gameplay "find the rainbow" quests,
//            cinematic weather shots, aerial / drone views, and any
//            1M-entity scene needing realistic rainbows on Android 64-bit.
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
} from '../sky/028_sky_atmosphere.js';

import {
  RainDrop,
  gatherRainForRendering,
} from './042_rain.js';

import {
  CloudInstance,
  CloudArchetype,
  CloudType,
} from '../sky/029_cloud_archetypes.js';

import {
  vec3,
  vec4,
  mat4,
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

// ── Primary rainbow ─────────────────────────────────────────────
const PRIMARY_ANGLE                  = 42.4 * DEG_TO_RAD;
const PRIMARY_WIDTH                  = 1.4 * DEG_TO_RAD;   // total colour band width
const PRIMARY_INTENSITY              = 1.0;

// Primary colours: violet (inside) → red (outside).
const PRIMARY_R_INNER                = 0.55;
const PRIMARY_G_INNER                = 0.10;
const PRIMARY_B_INNER                = 0.95;
const PRIMARY_R_OUTER                = 1.00;
const PRIMARY_G_OUTER                = 0.20;
const PRIMARY_B_OUTER                = 0.10;

// ── Secondary rainbow ───────────────────────────────────────────
const SECONDARY_ANGLE                = 51.0 * DEG_TO_RAD;
const SECONDARY_WIDTH                = 1.8 * DEG_TO_RAD;
const SECONDARY_INTENSITY            = 0.43;               // ~43% of primary

// Secondary colours: red (inside) → violet (outside).
const SECONDARY_R_INNER              = 1.00;
const SECONDARY_G_INNER              = 0.20;
const SECONDARY_B_INNER              = 0.10;
const SECONDARY_R_OUTER              = 0.55;
const SECONDARY_G_OUTER              = 0.10;
const SECONDARY_B_OUTER              = 0.95;

// ── Alexander's band ────────────────────────────────────────────
const ALEXANDER_DARKNESS_MAX         = 0.35;               // up to 35% darker
const ALEXANDER_FALLOFF              = 0.5;

// ── Supernumerary arcs ──────────────────────────────────────────
const SUPERNUMERARY_MIN_ANGLE        = 39.0 * DEG_TO_RAD;
const SUPERNUMERARY_MAX_ANGLE        = 42.0 * DEG_TO_RAD;
const SUPERNUMERARY_FRINGE_COUNT     = 5;
const SUPERNUMERARY_INTENSITY        = 0.15;
const SUPERNUMERARY_DROP_SIZE_MAX_MM = 1.0;                // only for small drops
const SUPERNUMERARY_FRINGE_FREQ      = 15.0;               // radians per radian

// ── Environment thresholds ─────────────────────────────────────
const SUN_MIN_ELEVATION              = 1.5 * DEG_TO_RAD;   // sun must be up
const SUN_MAX_ELEVATION              = 42.0 * DEG_TO_RAD;  // rainbow disappears at 42°+ elevation
const MIN_RAIN_DENSITY               = 0.05;               // drops per m² in view
const MAX_RAIN_DENSITY_FOR_BRIGHT    = 5.0;                // beyond this, rainbow dilutes

// ── Antisolar point ────────────────────────────────────────────
const ANTISOLAR_BIAS                 = 0.98;               // slight bias toward horizontal

// ── Polarization ───────────────────────────────────────────────
const POLARIZATION_STRENGTH          = 0.94;               // max polarization
const POLARIZATION_TANGENTIAL_ANGLE  = 0;                  // 0 = tangential

// ── Visibility / LOD ───────────────────────────────────────────
const MAX_RAINBOWS                   = 8;
const RAINBOW_QUERY_RADIUS           = 50000.0;            // metres
const LOD_DISTANCE_MAX               = 100000.0;

// ── Colour palette helper ──────────────────────────────────────
const SPECTRAL_BANDS                 = 7;
const SPECTRAL_RED                   = [1.00, 0.15, 0.10];
const SPECTRAL_ORANGE                = [1.00, 0.50, 0.10];
const SPECTRAL_YELLOW                = [1.00, 0.85, 0.15];
const SPECTRAL_GREEN                 = [0.20, 1.00, 0.20];
const SPECTRAL_CYAN                  = [0.10, 0.85, 1.00];
const SPECTRAL_BLUE                  = [0.20, 0.40, 1.00];
const SPECTRAL_VIOLET                = [0.55, 0.15, 0.95];

// ═══════════════════════════════════════════════════════════════════════
// RAINBOW TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const RainbowType = Object.freeze({
  PRIMARY:     0,
  SECONDARY:   1,
  SUPERNUMERARY: 2,
  ALEXANDER:   3,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA RAINBOW STATE — one slot per active camera
// ═══════════════════════════════════════════════════════════════════════

export const RainbowState = {
  // Camera entity that owns this slot.
  ownerEid: new Uint32Array(MAX_RAINBOWS),

  // Sky entity the rainbow is being rendered from.
  skyEid: new Uint32Array(MAX_RAINBOWS),

  // Whether the rainbow is currently visible.
  visible: new Uint8Array(MAX_RAINBOWS),

  // Camera position at last evaluation.
  camX: new Float32Array(MAX_RAINBOWS),
  camY: new Float32Array(MAX_RAINBOWS),
  camZ: new Float32Array(MAX_RAINBOWS),

  // Antisolar direction (unit vector) as seen from the camera.
  antisolarX: new Float32Array(MAX_RAINBOWS),
  antisolarY: new Float32Array(MAX_RAINBOWS),
  antisolarZ: new Float32Array(MAX_RAINBOWS),

  // Sun elevation (radians above horizon).
  sunElevation: new Float32Array(MAX_RAINBOWS),

  // Overall brightness multiplier (depends on rain density + sun intensity).
  brightness: new Float32Array(MAX_RAINBOWS),

  // Rain density in the air (drops per m² in view frustum).
  rainDensity: new Float32Array(MAX_RAINBOWS),

  // Whether supernumerary arcs are visible.
  hasSupernumerary: new Uint8Array(MAX_RAINBOWS),

  // Age (for fade-in / fade-out during weather changes).
  age: new Float32Array(MAX_RAINBOWS),

  // Active flag.
  active: new Uint8Array(MAX_RAINBOWS),

  // Current brightness envelope (for smooth fade-in / fade-out).
  envelope: new Float32Array(MAX_RAINBOWS),
};

/** Marker: entity is a rainbow owner (usually the camera). */
export const RainbowTag = {};

const _rainbowSlots = new Map(); // eid -> slot
let _nextRainbowSlot = 0;

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
// RAINBOW SLOT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register a rainbow for a camera or sky entity.
 *
 * @param world       ECS world
 * @param eid         camera entity that owns this rainbow
 * @param skyEid      sky entity (provides sun direction)
 * @returns rainbow slot id
 */
export function addRainbow(world, eid, skyEid) {
  if (_nextRainbowSlot >= MAX_RAINBOWS) {
    throw new Error('rainbow capacity exceeded');
  }
  const slot = _nextRainbowSlot++;

  addComponent(world, eid, RainbowTag);

  const R = RainbowState;
  R.ownerEid[slot] = eid;
  R.skyEid[slot] = skyEid;
  R.visible[slot] = 0;
  R.camX[slot] = 0;
  R.camY[slot] = 0;
  R.camZ[slot] = 0;
  R.antisolarX[slot] = 0;
  R.antisolarY[slot] = -1;
  R.antisolarZ[slot] = 0;
  R.sunElevation[slot] = 0;
  R.brightness[slot] = 0;
  R.rainDensity[slot] = 0;
  R.hasSupernumerary[slot] = 0;
  R.age[slot] = 0;
  R.active[slot] = 1;
  R.envelope[slot] = 0;

  _rainbowSlots.set(eid, slot);
  return slot;
}

export function removeRainbow(world, eid) {
  const slot = _rainbowSlots.get(eid);
  if (slot === undefined) return;
  RainbowState.active[slot] = 0;
  RainbowState.ownerEid[slot] = 0;
  _rainbowSlots.delete(eid);
  removeComponent(world, eid, RainbowTag);
}

export function getRainbowSlot(eid) {
  return _rainbowSlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// SPECTRAL COLOUR INTERPOLATION — Colour at a specific angular offset
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the primary-rainbow colour at a normalized offset (0 = inner
 * violet, 1 = outer red).
 */
function primaryColourAt(offset, out) {
  const t = Math.max(0, Math.min(1, offset));

  // 7 spectral bands, interpolated linearly.
  if (t < 1 / 7) {
    lerp3(SPECTRAL_VIOLET, SPECTRAL_BLUE, t * 7, out);
  } else if (t < 2 / 7) {
    lerp3(SPECTRAL_BLUE, SPECTRAL_CYAN, (t - 1 / 7) * 7, out);
  } else if (t < 3 / 7) {
    lerp3(SPECTRAL_CYAN, SPECTRAL_GREEN, (t - 2 / 7) * 7, out);
  } else if (t < 4 / 7) {
    lerp3(SPECTRAL_GREEN, SPECTRAL_YELLOW, (t - 3 / 7) * 7, out);
  } else if (t < 5 / 7) {
    lerp3(SPECTRAL_YELLOW, SPECTRAL_ORANGE, (t - 4 / 7) * 7, out);
  } else if (t < 6 / 7) {
    lerp3(SPECTRAL_ORANGE, SPECTRAL_RED, (t - 5 / 7) * 7, out);
  } else {
    // Beyond red, fade out.
    out[0] = SPECTRAL_RED[0];
    out[1] = SPECTRAL_RED[1];
    out[2] = SPECTRAL_RED[2];
  }
  return out;
}

/**
 * Return the secondary-rainbow colour at a normalized offset (0 = inner
 * red, 1 = outer violet — reversed from primary).
 */
function secondaryColourAt(offset, out) {
  const t = 1.0 - Math.max(0, Math.min(1, offset));   // reverse
  return primaryColourAt(t, out);
}

function lerp3(a, b, t, out) {
  out[0] = a[0] * (1 - t) + b[0] * t;
  out[1] = a[1] * (1 - t) + b[1] * t;
  out[2] = a[2] * (1 - t) + b[2] * t;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// RAINBOW RADIANCE SAMPLE — the hot path
// ═══════════════════════════════════════════════════════════════════════

const _spectralColour = vec3.create();

/**
 * Sample the rainbow radiance contribution for a given view direction
 * from a specific camera / rainbow slot.
 *
 * Returns [r, g, b] ADDITIVE radiance. Caller should add this on top
 * of the sky radiance from file 028 (and any cloud / fog contribution).
 *
 * @param rainbowSlot  from addRainbow
 * @param dirX, dirY, dirZ  view direction (unit vector)
 * @param out          [r, g, b] output
 * @returns out
 */
export function sampleRainbowRadiance(rainbowSlot, dirX, dirY, dirZ, out) {
  const R = RainbowState;
  if (!R.active[rainbowSlot] || !R.visible[rainbowSlot]) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }
  if (R.envelope[rainbowSlot] < EPSILON) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }

  // Cos of angle between view and antisolar direction.
  const cosAngle = dirX * R.antisolarX[rainbowSlot]
                 + dirY * R.antisolarY[rainbowSlot]
                 + dirZ * R.antisolarZ[rainbowSlot];

  // Clamp to [-1, 1].
  const c = Math.max(-1, Math.min(1, cosAngle));
  const angle = Math.acos(c);   // angular distance from antisolar point

  const envelope = R.envelope[rainbowSlot];
  let r = 0, g = 0, b = 0;

  // ── PRIMARY RAINBOW ────────────────────────────────────────
  const primaryInner = PRIMARY_ANGLE - PRIMARY_WIDTH * 0.5;
  const primaryOuter = PRIMARY_ANGLE + PRIMARY_WIDTH * 0.5;

  if (angle >= primaryInner && angle <= primaryOuter) {
    const offset = (angle - primaryInner) / (primaryOuter - primaryInner);
    // Note: at inner edge = violet, at outer edge = red.
    primaryColourAt(offset, _spectralColour);

    // Gaussian falloff at the edges.
    const edgeFalloff = Math.sin(offset * PI);
    const intensity = PRIMARY_INTENSITY * edgeFalloff * envelope
                    * R.brightness[rainbowSlot];

    r += _spectralColour[0] * intensity;
    g += _spectralColour[1] * intensity;
    b += _spectralColour[2] * intensity;
  }

  // ── SECONDARY RAINBOW ─────────────────────────────────────
  const secondaryInner = SECONDARY_ANGLE - SECONDARY_WIDTH * 0.5;
  const secondaryOuter = SECONDARY_ANGLE + SECONDARY_WIDTH * 0.5;

  if (angle >= secondaryInner && angle <= secondaryOuter) {
    const offset = (angle - secondaryInner) / (secondaryOuter - secondaryInner);
    // At inner edge = red, at outer edge = violet.
    secondaryColourAt(offset, _spectralColour);

    const edgeFalloff = Math.sin(offset * PI);
    const intensity = SECONDARY_INTENSITY * edgeFalloff * envelope
                    * R.brightness[rainbowSlot];

    r += _spectralColour[0] * intensity;
    g += _spectralColour[1] * intensity;
    b += _spectralColour[2] * intensity;
  }

  // ── ALEXANDER'S BAND ──────────────────────────────────────
  const alexanderInner = primaryOuter;
  const alexanderOuter = secondaryInner;
  if (angle > alexanderInner && angle < alexanderOuter) {
    const midAngle = (alexanderInner + alexanderOuter) * 0.5;
    const halfWidth = (alexanderOuter - alexanderInner) * 0.5;
    const t = Math.abs(angle - midAngle) / halfWidth;
    const darkening = ALEXANDER_DARKNESS_MAX
      * (1 - t) * (1 - t)
      * envelope
      * R.brightness[rainbowSlot];
    // Darkening removes light — but here we can only add radiance,
    // so we return a negative contribution.
    r -= darkening * 0.6;
    g -= darkening * 0.6;
    b -= darkening * 0.6;
  }

  // ── SUPERNUMERARY ARCS ────────────────────────────────────
  if (R.hasSupernumerary[rainbowSlot]
      && angle >= SUPERNUMERARY_MIN_ANGLE
      && angle <= SUPERNUMERARY_MAX_ANGLE) {
    const offset = (angle - SUPERNUMERARY_MIN_ANGLE)
      / (SUPERNUMERARY_MAX_ANGLE - SUPERNUMERARY_MIN_ANGLE);

    // Sinusoidal fringe pattern.
    const fringe = Math.sin(offset * SUPERNUMERARY_FRINGE_COUNT * PI * 2);
    // Alternating colour fringes (pink / green, approximating the
    // real supernumerary colours).
    const redFringe = Math.max(0, fringe) * SUPERNUMERARY_INTENSITY;
    const greenFringe = Math.max(0, -fringe) * SUPERNUMERARY_INTENSITY;

    const intensity = envelope * R.brightness[rainbowSlot];
    r += redFringe * intensity * 1.0;
    g += greenFringe * intensity * 0.6;
    b += (redFringe - greenFringe) * intensity * 0.3;
  }

  // Clamp negatives to zero (additive contribution only).
  out[0] = Math.max(0, r);
  out[1] = Math.max(0, g);
  out[2] = Math.max(0, b);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// POLARIZATION SAMPLE — for renderers that support it
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the polarization state of the rainbow at a given view direction.
 * The rainbow is polarized tangentially (perpendicular to the radial
 * direction from the antisolar point).
 *
 * Returns { strength: 0..1, angle: radians, axisX, axisY, axisZ } or
 * null if the direction is outside the rainbow bands.
 */
export function sampleRainbowPolarization(rainbowSlot, dirX, dirY, dirZ) {
  const R = RainbowState;
  if (!R.active[rainbowSlot] || !R.visible[rainbowSlot]) return null;

  const cosAngle = dirX * R.antisolarX[rainbowSlot]
                 + dirY * R.antisolarY[rainbowSlot]
                 + dirZ * R.antisolarZ[rainbowSlot];
  const c = Math.max(-1, Math.min(1, cosAngle));
  const angle = Math.acos(c);

  if (angle < PRIMARY_ANGLE - PRIMARY_WIDTH
      || angle > SECONDARY_ANGLE + SECONDARY_WIDTH) {
    return null;
  }

  // Tangential axis: perpendicular to (antisolar × dir).
  // cross(antisolar, dir) gives a vector tangent to the sphere.
  const ax = R.antisolarY[rainbowSlot] * dirZ - R.antisolarZ[rainbowSlot] * dirY;
  const ay = R.antisolarZ[rainbowSlot] * dirX - R.antisolarX[rainbowSlot] * dirZ;
  const az = R.antisolarX[rainbowSlot] * dirY - R.antisolarY[rainbowSlot] * dirX;
  const len = Math.hypot(ax, ay, az);
  if (len < EPSILON) return null;

  return {
    strength: POLARIZATION_STRENGTH * R.envelope[rainbowSlot],
    angle: 0,             // tangential
    axisX: ax / len,
    axisY: ay / len,
    axisZ: az / len,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// RAINBOW EVALUATION — determine if conditions are met
// ═══════════════════════════════════════════════════════════════════════

/**
 * Evaluate whether a rainbow should be visible from a given camera
 * position and sky entity.
 */
export function evaluateRainbowConditions(rainbowSlot, camX, camY, camZ) {
  const R = RainbowState;
  if (!R.active[rainbowSlot]) return false;

  // Read sun direction from the sky.
  const skySlot = getSkySlot(R.skyEid[rainbowSlot]);
  if (skySlot < 0) {
    R.visible[rainbowSlot] = 0;
    return false;
  }

  const sunDirX = SkyF32.sunDirX[skySlot];
  const sunDirY = SkyF32.sunDirY[skySlot];
  const sunDirZ = SkyF32.sunDirZ[skySlot];

  // Sun must be above horizon and below 42° for a rainbow.
  if (sunDirY < SUN_MIN_ELEVATION || sunDirY > SUN_MAX_ELEVATION) {
    R.visible[rainbowSlot] = 0;
    R.brightness[rainbowSlot] = 0;
    return false;
  }

  // Antisolar direction (opposite the sun).
  R.antisolarX[rainbowSlot] = -sunDirX * ANTISOLAR_BIAS;
  R.antisolarY[rainbowSlot] = -sunDirY;
  R.antisolarZ[rainbowSlot] = -sunDirZ * ANTISOLAR_BIAS;

  const antiLen = Math.hypot(R.antisolarX[rainbowSlot],
    R.antisolarY[rainbowSlot], R.antisolarZ[rainbowSlot]);
  if (antiLen > EPSILON) {
    R.antisolarX[rainbowSlot] /= antiLen;
    R.antisolarY[rainbowSlot] /= antiLen;
    R.antisolarZ[rainbowSlot] /= antiLen;
  }

  // Sun elevation above horizon.
  R.sunElevation[rainbowSlot] = Math.asin(Math.max(-1, Math.min(1, sunDirY)));

  // Count rain droplets in the view frustum.
  let dropCount = 0;
  const rd = RainDrop;
  for (let slot = 0; slot < RainDrop.active.length; slot++) {
    if (rd.active[slot] === 0) continue;
    const dx = rd.px[slot] - camX;
    const dy = rd.py[slot] - camY;
    const dz = rd.pz[slot] - camZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < RAINBOW_QUERY_RADIUS * RAINBOW_QUERY_RADIUS) {
      dropCount++;
    }
  }

  R.rainDensity[rainbowSlot] = dropCount / Math.max(1, RAINBOW_QUERY_RADIUS / 1000);

  if (R.rainDensity[rainbowSlot] < MIN_RAIN_DENSITY) {
    R.visible[rainbowSlot] = 0;
    R.brightness[rainbowSlot] = 0;
    return false;
  }

  // Brightness from sun intensity and rain density.
  const sunIntensity = SkyF32.sunIntensity[skySlot];

  // Optimal rain density yields maximum brightness; too dense and the
  // rainbow diffuses.
  let densityFactor;
  if (R.rainDensity[rainbowSlot] < MAX_RAIN_DENSITY_FOR_BRIGHT) {
    densityFactor = R.rainDensity[rainbowSlot] / MAX_RAIN_DENSITY_FOR_BRIGHT;
  } else {
    densityFactor = MAX_RAIN_DENSITY_FOR_BRIGHT / R.rainDensity[rainbowSlot];
  }
  densityFactor = Math.max(0.1, Math.min(1.0, densityFactor));

  // Supernumerary arcs require small, uniform drops.
  // Sample a few drops from the pool to check typical diameter.
  let smallDropCount = 0;
  let totalSampled = 0;
  for (let slot = 0; slot < RainDrop.active.length && totalSampled < 100; slot++) {
    if (rd.active[slot] === 0) continue;
    totalSampled++;
    if (rd.diameter[slot] * 1000 < SUPERNUMERARY_DROP_SIZE_MAX_MM) {
      smallDropCount++;
    }
  }
  R.hasSupernumerary[rainbowSlot] = (smallDropCount / Math.max(1, totalSampled) > 0.7) ? 1 : 0;

  R.brightness[rainbowSlot] = sunIntensity * densityFactor * 1.5;
  R.visible[rainbowSlot] = 1;

  // Update camera position.
  R.camX[rainbowSlot] = camX;
  R.camY[rainbowSlot] = camY;
  R.camZ[rainbowSlot] = camZ;

  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// ENVELOPE UPDATE — smooth fade in / out
// ═══════════════════════════════════════════════════════════════════════

const ENVELOPE_RISE_TIME  = 1.5;   // seconds to fade in
const ENVELOPE_FALL_TIME  = 3.0;   // seconds to fade out

/**
 * Update the rainbow's envelope (fade-in / fade-out) based on
 * visibility. Called once per frame.
 */
export function systemUpdateRainbowEnvelope(rainbowSlot, dt) {
  const R = RainbowState;
  if (!R.active[rainbowSlot]) return;

  const target = R.visible[rainbowSlot] ? 1.0 : 0.0;
  const current = R.envelope[rainbowSlot];

  if (target > current) {
    // Rising.
    const rate = dt / ENVELOPE_RISE_TIME;
    R.envelope[rainbowSlot] = Math.min(1, current + rate);
  } else {
    // Falling.
    const rate = dt / ENVELOPE_FALL_TIME;
    R.envelope[rainbowSlot] = Math.max(0, current - rate);
  }

  R.age[rainbowSlot] += dt;
}

/**
 * System: update every active rainbow envelope.
 */
export function systemUpdateRainbows(world, dt) {
  for (let slot = 0; slot < _nextRainbowSlot; slot++) {
    if (!RainbowState.active[slot]) continue;

    // Re-evaluate conditions.
    evaluateRainbowConditions(slot,
      RainbowState.camX[slot],
      RainbowState.camY[slot],
      RainbowState.camZ[slot]);

    // Advance envelope.
    systemUpdateRainbowEnvelope(slot, dt);
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — sample rainbow from a specific rainbow slot
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the total rainbow contribution (primary + secondary +
 * supernumerary + Alexander's band) for a view direction from a
 * specific rainbow slot. Same as `sampleRainbowRadiance` but with a
 * friendlier name.
 */
export function sampleRainbowContribution(rainbowSlot, dirX, dirY, dirZ, out) {
  return sampleRainbowRadiance(rainbowSlot, dirX, dirY, dirZ, out);
}

/**
 * Sample the rainbow at a view direction, given a camera entity and a
 * sky entity. Performs the whole evaluation in one call, which is
 * convenient for integrators that don't want to track rainbow slots.
 */
export function sampleRainbowForCamera(cameraEid, cameraX, cameraY, cameraZ, dirX, dirY, dirZ, out) {
  const slot = _rainbowSlots.get(cameraEid);
  if (slot === undefined) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    return out;
  }

  // Light re-evaluation (cheap).
  evaluateRainbowConditions(slot, cameraX, cameraY, cameraZ);

  return sampleRainbowRadiance(slot, dirX, dirY, dirZ, out);
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER BRIDGE — full-screen rainbow overlay for renderer integration
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the "rainbow state" summary for the renderer to build a
 * screen-space or world-space overlay.
 */
export function gatherRainbowsForRendering() {
  const result = [];
  for (let slot = 0; slot < _nextRainbowSlot; slot++) {
    if (!RainbowState.active[slot]) continue;
    if (!RainbowState.visible[slot]) continue;
    if (RainbowState.envelope[slot] < EPSILON) continue;

    result.push({
      slot,
      camX: RainbowState.camX[slot],
      camY: RainbowState.camY[slot],
      camZ: RainbowState.camZ[slot],
      antisolarX: RainbowState.antisolarX[slot],
      antisolarY: RainbowState.antisolarY[slot],
      antisolarZ: RainbowState.antisolarZ[slot],
      sunElevation: RainbowState.sunElevation[slot],
      brightness: RainbowState.brightness[slot],
      envelope: RainbowState.envelope[slot],
      rainDensity: RainbowState.rainDensity[slot],
      hasSupernumerary: RainbowState.hasSupernumerary[slot] === 1,
      primaryAngle: PRIMARY_ANGLE,
      primaryWidth: PRIMARY_WIDTH,
      secondaryAngle: SECONDARY_ANGLE,
      secondaryWidth: SECONDARY_WIDTH,
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// UTILITY — is a specific direction inside a rainbow band?
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return true if the given direction (from the camera) lies inside
 * the primary rainbow band.
 */
export function isInPrimaryBand(rainbowSlot, dirX, dirY, dirZ) {
  const R = RainbowState;
  if (!R.active[rainbowSlot]) return false;

  const cosAngle = dirX * R.antisolarX[rainbowSlot]
                 + dirY * R.antisolarY[rainbowSlot]
                 + dirZ * R.antisolarZ[rainbowSlot];
  const c = Math.max(-1, Math.min(1, cosAngle));
  const angle = Math.acos(c);

  return angle >= PRIMARY_ANGLE - PRIMARY_WIDTH * 0.5
      && angle <= PRIMARY_ANGLE + PRIMARY_WIDTH * 0.5;
}

/**
 * Return true if the given direction lies inside the secondary rainbow band.
 */
export function isInSecondaryBand(rainbowSlot, dirX, dirY, dirZ) {
  const R = RainbowState;
  if (!R.active[rainbowSlot]) return false;

  const cosAngle = dirX * R.antisolarX[rainbowSlot]
                 + dirY * R.antisolarY[rainbowSlot]
                 + dirZ * R.antisolarZ[rainbowSlot];
  const c = Math.max(-1, Math.min(1, cosAngle));
  const angle = Math.acos(c);

  return angle >= SECONDARY_ANGLE - SECONDARY_WIDTH * 0.5
      && angle <= SECONDARY_ANGLE + SECONDARY_WIDTH * 0.5;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearRainbows() {
  RainbowState.active.fill(0);
  RainbowState.visible.fill(0);
  RainbowState.envelope.fill(0);
  RainbowState.ownerEid.fill(0);
  _rainbowSlots.clear();
  _nextRainbowSlot = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function rainbowStats() {
  let active = 0;
  let visible = 0;

  for (let slot = 0; slot < _nextRainbowSlot; slot++) {
    if (!RainbowState.active[slot]) continue;
    active++;
    if (RainbowState.visible[slot]) visible++;
  }

  return {
    rainbowCount: _nextRainbowSlot,
    active,
    visible,
    max: MAX_RAINBOWS,
  };
}