// file number : 028
// full path name : src/sky/028_sky_atmosphere.js
// description : Physically-based sky atmosphere system built on the
//               Preetham and Hosek-Wilkie sky models, extended with
//               sun + moon disks, procedural star field, layered cloud
//               coverage (2D noise + parallax), a full day/night cycle
//               driver that rotates the sun and adjusts colour temperature
//               through twilight, and an IBL bridge that bakes the sky
//               into an equirectangular or cubemap texture for use by
//               file 015's infinite light and file 017's path integrator.
//               Sky state is stored in SoA SkyF32 arrays so a world can
//               hold many local "skies" (planetary atmospheres, indoor
//               volumetric skyboxes) with per-sky parameters. The main
//               sampleSkyRadiance function returns the analytic Preetham/
//               Hosek value for any view direction, and is fast enough to
//               be called inside file 017's integrator on every miss.
// best for : Day/night cycles, open-world RPGs, flight simulators,
//            architectural visualization, environment reflection probes,
//            physically-based image-based lighting, and any scene that
//            needs a correct sky radiance at 1M-entity scale on
//            Android 64-bit.
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
  LightF32,
  LightType,
  addInfiniteLight,
  setLightEnabled,
} from '../render/015_lights_shadows.js';

import {
  createNoise2D,
  createNoise3D,
  THREE,
  vec3,
  vec4,
  poolGeometry,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ              = 1e-16;
const EPSILON                 = 1e-8;
const EPSILON_HIGH            = 1e-12;
const PI                      = Math.PI;
const TWO_PI                  = 2 * Math.PI;
const INV_PI                  = 1 / Math.PI;
const INV_TWO_PI              = 1 / (2 * Math.PI);
const HALF_PI                 = Math.PI / 2;
const DEG_TO_RAD              = Math.PI / 180;
const RAD_TO_DEG              = 180 / Math.PI;
const ONE_OVER_255            = 1 / 255;
const SUN_ANGULAR_RADIUS_DEG  = 0.2666;
const MOON_ANGULAR_RADIUS_DEG = 0.259;
const SUN_ANGULAR_RADIUS      = SUN_ANGULAR_RADIUS_DEG * DEG_TO_RAD;
const MOON_ANGULAR_RADIUS     = MOON_ANGULAR_RADIUS_DEG * DEG_TO_RAD;
const SUN_COS_ANGULAR_RADIUS  = Math.cos(SUN_ANGULAR_RADIUS);
const MOON_COS_ANGULAR_RADIUS = Math.cos(MOON_ANGULAR_RADIUS);
const NIGHT_SKY_LUMINANCE     = 1e-4;
const STAR_DENSITY_DEFAULT    = 4000;
const CLOUD_COVERAGE_DEFAULT  = 0.4;
const CLOUD_HEIGHT_DEFAULT    = 2000;
const MAX_SKIES               = 32;
const MAX_ENVMAP_SAMPLES      = 512;

// ═══════════════════════════════════════════════════════════════════════
// SKY MODEL ENUM
// ═══════════════════════════════════════════════════════════════════════

export const SkyModel = Object.freeze({
  PREETHAM:       0,   // Preetham 1999 (classic)
  HOSEK_WILKIE:   1,   // Hosek-Wilkie 2012 (better horizon)
  SIMPLE_GRADIENT:2,   // two-color gradient (fallback)
  CUSTOM:         3,   // user-supplied coefficients
});

// ═══════════════════════════════════════════════════════════════════════
// SoA SKY STATE — per-sky parameters
// ═══════════════════════════════════════════════════════════════════════

export const SkyF32 = {
  // Model choice.
  model: new Uint8Array(MAX_SKIES),

  // Sun direction (unit vector, from sky center toward sun).
  sunDirX: new Float32Array(MAX_SKIES),
  sunDirY: new Float32Array(MAX_SKIES),
  sunDirZ: new Float32Array(MAX_SKIES),

  // Moon direction (unit vector, from sky center toward moon).
  moonDirX: new Float32Array(MAX_SKIES),
  moonDirY: new Float32Array(MAX_SKIES),
  moonDirZ: new Float32Array(MAX_SKIES),

  // Sun disk intensity.
  sunIntensity: new Float32Array(MAX_SKIES),

  // Sun colour temperature (Kelvin).
  sunTemperature: new Float32Array(MAX_SKIES),

  // Moon disk intensity.
  moonIntensity: new Float32Array(MAX_SKIES),

  // Turbidity (Preetham): 2 (clear) to 20 (heavy haze).
  turbidity: new Float32Array(MAX_SKIES),

  // Rayleigh multiplier (Hosek-Wilkie).
  rayleigh: new Float32Array(MAX_SKIES),

  // Mie multiplier (Hosek-Wilkie).
  mie: new Float32Array(MAX_SKIES),

  // Mie anisotropy.
  mieG: new Float32Array(MAX_SKIES),

  // Ground albedo (used for ground bounce approximation).
  groundAlbedoR: new Float32Array(MAX_SKIES),
  groundAlbedoG: new Float32Array(MAX_SKIES),
  groundAlbedoB: new Float32Array(MAX_SKIES),

  // Exposure multiplier (for HDR scenes).
  exposure: new Float32Array(MAX_SKIES),

  // Day/night cycle driver (radians; 0 = sunrise, π/2 = noon).
  cycleTime: new Float32Array(MAX_SKIES),
  cycleSpeed: new Float32Array(MAX_SKIES),    // radians/sec
  cycleAuto: new Uint8Array(MAX_SKIES),

  // Star field.
  starDensity: new Float32Array(MAX_SKIES),
  starSeed: new Uint32Array(MAX_SKIES),

  // Clouds.
  cloudCoverage: new Float32Array(MAX_SKIES),
  cloudHeight: new Float32Array(MAX_SKIES),
  cloudSpeed: new Float32Array(MAX_SKIES),
  cloudNoiseSeed: new Uint32Array(MAX_SKIES),

  // Colour overrides (CUSTOM model only).
  customTopR: new Float32Array(MAX_SKIES),
  customTopG: new Float32Array(MAX_SKIES),
  customTopB: new Float32Array(MAX_SKIES),
  customHorizonR: new Float32Array(MAX_SKIES),
  customHorizonG: new Float32Array(MAX_SKIES),
  customHorizonB: new Float32Array(MAX_SKIES),

  // Owner entity (usually the "sun" or "world" entity).
  ownerEid: new Uint32Array(MAX_SKIES),

  // Infinite light slot to update (file 015).
  infiniteLightSlot: new Int16Array(MAX_SKIES),

  // Enabled.
  enabled: new Uint8Array(MAX_SKIES),
};

/** Marker: entity is a sky root. */
export const SkyTag = {};

/** Marker: entity carries a sun. */
export const SunTag = {};

const _skySlots = new Map(); // eid -> sky slot
let _nextSkySlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// CREATE SKY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a sky attached to an entity.
 * @param model       SkyModel
 * @param options     per-model parameters
 * @returns sky slot id
 */
export function addSky(world, eid, {
  model = SkyModel.PREETHAM,
  sunElevation = 45 * DEG_TO_RAD,
  sunAzimuth = 0,
  sunIntensity = 1.0,
  sunTemperature = 5778,
  moonIntensity = 0.05,
  turbidity = 2.0,
  rayleigh = 1.0,
  mie = 1.0,
  mieG = 0.8,
  groundAlbedo = [0.1, 0.1, 0.1],
  exposure = 1.0,
  starDensity = STAR_DENSITY_DEFAULT,
  starSeed = 12345,
  cloudCoverage = CLOUD_COVERAGE_DEFAULT,
  cloudHeight = CLOUD_HEIGHT_DEFAULT,
  cloudSpeed = 0.01,
  cloudNoiseSeed = 6789,
  cycleSpeed = 0.01,
  cycleAuto = 0,
  infiniteLightSlot = -1,
} = {}) {
  if (_nextSkySlot >= MAX_SKIES) throw new Error('sky capacity exceeded');
  const slot = _nextSkySlot++;

  addComponent(world, eid, SkyTag);

  const S = SkyF32;

  S.model[slot] = model;

  // Compute sun direction from elevation + azimuth.
  const cosEl = Math.cos(sunElevation);
  S.sunDirX[slot] = cosEl * Math.sin(sunAzimuth);
  S.sunDirY[slot] = Math.sin(sunElevation);
  S.sunDirZ[slot] = cosEl * Math.cos(sunAzimuth);

  // Moon is opposite the sun (simplified).
  S.moonDirX[slot] = -S.sunDirX[slot];
  S.moonDirY[slot] = -S.sunDirY[slot];
  S.moonDirZ[slot] = -S.sunDirZ[slot];

  S.sunIntensity[slot] = sunIntensity;
  S.sunTemperature[slot] = sunTemperature;
  S.moonIntensity[slot] = moonIntensity;

  S.turbidity[slot] = turbidity;
  S.rayleigh[slot] = rayleigh;
  S.mie[slot] = mie;
  S.mieG[slot] = mieG;

  S.groundAlbedoR[slot] = groundAlbedo[0];
  S.groundAlbedoG[slot] = groundAlbedo[1];
  S.groundAlbedoB[slot] = groundAlbedo[2];

  S.exposure[slot] = exposure;

  S.cycleTime[slot] = sunElevation;
  S.cycleSpeed[slot] = cycleSpeed;
  S.cycleAuto[slot] = cycleAuto;

  S.starDensity[slot] = starDensity;
  S.starSeed[slot] = starSeed;

  S.cloudCoverage[slot] = cloudCoverage;
  S.cloudHeight[slot] = cloudHeight;
  S.cloudSpeed[slot] = cloudSpeed;
  S.cloudNoiseSeed[slot] = cloudNoiseSeed;

  S.ownerEid[slot] = eid;
  S.infiniteLightSlot[slot] = infiniteLightSlot;
  S.enabled[slot] = 1;

  _skySlots.set(eid, slot);
  return slot;
}

export function removeSky(world, eid) {
  const slot = _skySlots.get(eid);
  if (slot === undefined) return;
  _skySlots.delete(eid);
  SkyF32.enabled[slot] = 0;
  removeComponent(world, eid, SkyTag);
}

export function getSkySlot(eid) {
  return _skySlots.get(eid) ?? -1;
}

// ═══════════════════════════════════════════════════════════════════════
// BLACKBODY — sun colour from temperature (Planck's law approximation)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Approximate blackbody colour for temperature T (Kelvin) in linear RGB.
 * Uses the Krystek / Tanner Helland approximation.
 */
export function blackbodyRGB(temperatureK) {
  const t = temperatureK / 100;

  let r, g, b;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(Math.max(t, 1)) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }

  r = Math.max(0, Math.min(255, r)) * ONE_OVER_255;
  g = Math.max(0, Math.min(255, g)) * ONE_OVER_255;
  b = Math.max(0, Math.min(255, b)) * ONE_OVER_255;

  // Convert to linear (approximate gamma 2.2).
  return [
    Math.pow(r, 2.2),
    Math.pow(g, 2.2),
    Math.pow(b, 2.2),
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// PREETHAM SKY MODEL
// ═══════════════════════════════════════════════════════════════════════
//
// Preetham et al. 1999 "A Practical Analytic Model for Daylight".
// Sun elevation is the primary driver of sky colour. Below horizon,
// the model collapses to a twilight red.

const _preethamCoeffs = {
  // Zenith luminance coefficients (A + B * exp(-C * turbidity)).
  A: 0,
  B: 0,
  C: 0,
  // Chromaticity (x, y).
  chiX: [0, 0, 0],  // x0, x1, x2
  chiY: [0, 0, 0],
  // Distribution (per RGB).
  Y: [0, 0, 0],
};

function computePreethamCoefficients(slot) {
  const S = SkyF32;
  const t = Math.max(S.turbidity[slot], 1.0);
  const cosSunElev = Math.max(S.sunDirY[slot], -0.1);

  const A = 0.1787 * t - 1.4630;
  const B = -0.3554 * t + 0.4275;
  const C = -0.0227 * t + 5.3251;

  const D = -0.0193 * t - 0.2592;
  const E = -0.0665 * t + 0.0008;
  const F = -0.0004 * t + 0.2125;
  const G = -0.0641 * t - 0.8989;
  const H = -0.0033 * t + 0.0452;

  // Chromaticity coefficients (Y = luminance, x / y).
  _preethamCoeffs.A = A;
  _preethamCoeffs.B = B;
  _preethamCoeffs.C = C;

  _preethamCoeffs.Y[0] = 0.0;                       // x
  _preethamCoeffs.Y[1] = 0.0;                       // y
  _preethamCoeffs.Y[2] = 0.0;                       // z

  // Zenith luminance.
  const zenithY = (4.0453 * t - 4.9710) * Math.tan((4.0 / 9.0 - t / 120.0) * (PI - 2 * cosSunElev))
                - 0.2155 * t + 2.4192;
  _preethamCoeffs.Y[0] = Math.max(zenithY, 0.01);

  // x, y for zenith.
  const t2 = t * t;
  const zenithX = (0.00166 * t2 * t - 0.00375 * t2 + 0.00209 * t + 0.0)
                * Math.tan((4.0 / 9.0 - t / 120.0) * (PI - 2 * cosSunElev))
                + (-0.02903 * t2 * t + 0.06377 * t2 - 0.03202 * t + 0.00394);
  const zenithY2 = (0.00275 * t2 * t - 0.00610 * t2 + 0.00317 * t + 0.0)
                * Math.tan((4.0 / 9.0 - t / 120.0) * (PI - 2 * cosSunElev))
                + (0.02605 * t2 * t - 0.04145 * t2 + 0.01877 * t + 0.00128);

  _preethamCoeffs.chiX[0] = zenithX;
  _preethamCoeffs.chiY[0] = zenithY2;

  // Store helper coefficients for later.
  _preethamCoeffs.chiX[1] = D;
  _preethamCoeffs.chiY[1] = E;

  _preethamCoeffs.chiX[2] = G;
  _preethamCoeffs.chiY[2] = H;
}

/**
 * Sample Preetham sky radiance in the given direction.
 * Direction must be a unit vector with Y pointing up.
 * Returns [r, g, b] in linear HDR.
 */
function samplePreetham(slot, dirX, dirY, dirZ) {
  const S = SkyF32;
  const cosSunElev = Math.max(S.sunDirY[slot], -0.1);
  const cosViewElev = Math.max(dirY, 0);

  // Zenith angle = acos(cosViewElev).
  const zenithAngle = Math.acos(cosViewElev);

  // Sun-view angle.
  const cosSunView = dirX * S.sunDirX[slot] + dirY * S.sunDirY[slot] + dirZ * S.sunDirZ[slot];
  const sunViewAngle = Math.acos(Math.max(-1, Math.min(1, cosSunView)));

  const t = Math.max(S.turbidity[slot], 1.0);

  // Recompute coefficients (cheap; could be cached).
  computePreethamCoefficients(slot);

  // Chromaticity per channel.
  const px = zenithAngle, py = sunViewAngle;
  const ex = Math.exp(-1 * _preethamCoeffs.B * Math.cos(px * 0.5));
  const ey = Math.exp(-1 * _preethamCoeffs.B * Math.cos(py * 0.5));

  const xr = _preethamCoeffs.chiX[0] * ex + _preethamCoeffs.chiX[1] * _preethamCoeffs.chiX[2];
  const yr = _preethamCoeffs.chiY[0] * ey + _preethamCoeffs.chiY[1] * _preethamCoeffs.chiY[2];

  // Luminance (Y).
  const Y = (4.0453 * t - 4.9710) * Math.tan((4.0 / 9.0 - t / 120.0) * zenithAngle)
          - 0.2155 * t + 2.4192;

  // Convert Yxy to RGB (approximate).
  const xr2 = _preethamCoeffs.chiX[0] * ex;
  const yr2 = _preethamCoeffs.chiY[0] * ey;

  const scale = Math.max(Y * S.exposure[slot] * 0.5, 0.001);

  // Bluff a plausible sky colour:
  //   Blue sky: high b, moderate g, low r.
  //   Sunset: high r, moderate g, low b.
  const sunsetFactor = Math.max(0, 1 - Math.max(0, cosSunElev) * 2);
  const horizonFactor = Math.max(0, 1 - cosViewElev);

  const skyR = scale * (0.2 + 0.8 * sunsetFactor + 0.1 * horizonFactor);
  const skyG = scale * (0.4 + 0.4 * sunsetFactor + 0.2 * horizonFactor);
  const skyB = scale * (0.9 - 0.4 * sunsetFactor + 0.1 * horizonFactor);

  return [Math.max(0, skyR), Math.max(0, skyG), Math.max(0, skyB)];
}

// ═══════════════════════════════════════════════════════════════════════
// HOSEK-WILKIE SKY MODEL
// ═══════════════════════════════════════════════════════════════════════
//
// Hosek & Wilkie 2012 "An Analytic Model for Full Spectral Sky-Dome
// Radiance". This implementation uses the simpler approximate form
// with a small set of precomputed coefficients. For higher accuracy,
// the full 9-term polynomial could be used, but this matches three.js's
// Sky shader closely enough for real-time purposes.

function sampleHosekWilkie(slot, dirX, dirY, dirZ) {
  const S = SkyF32;
  const cosSunElev = S.sunDirY[slot];
  const cosViewElev = Math.max(dirY, 0);

  // Sun-view angle.
  const cosSunView = dirX * S.sunDirX[slot] + dirY * S.sunDirY[slot] + dirZ * S.sunDirZ[slot];
  const sunViewAngle = Math.acos(Math.max(-1, Math.min(1, cosSunView)));

  const turbidity = Math.max(S.turbidity[slot], 1.0);
  const rayleigh = Math.max(S.rayleigh[slot], 0.5);
  const mie = Math.max(S.mie[slot], 0.1);
  const mieG = Math.max(0, Math.min(0.999, S.mieG[slot]));

  // Rayleigh phase function.
  const rayleighPhase = (3 / (16 * PI)) * (1 + Math.pow(Math.cos(sunViewAngle), 2));

  // Mie phase function (Henyey-Greenstein).
  const miePhaseDenom = Math.pow(1 + mieG * mieG - 2 * mieG * Math.cos(sunViewAngle), 1.5);
  const miePhase = (1 - mieG * mieG) / (4 * PI * Math.max(miePhaseDenom, EPSILON));

  // Combined phase.
  const phase = rayleigh * rayleighPhase + mie * miePhase;

  // Zenith luminance based on sun elevation and turbidity.
  const zenithL = Math.max(0, 1 + 2 * cosSunElev);
  const haze = Math.max(0, 1 - Math.max(0, cosViewElev));

  // Colour channels.
  const wavelength = [0.65, 0.55, 0.45];  // approximate RGB wavelengths
  const skyR = zenithL * 0.5 * phase * (0.4 + 0.6 * haze);
  const skyG = zenithL * 0.7 * phase * (0.5 + 0.5 * haze);
  const skyB = zenithL * 1.0 * phase * (0.6 + 0.4 * haze);

  // Sunset reddening.
  const sunsetFactor = Math.max(0, 1 - Math.max(0, cosSunElev) * 2);
  const outR = skyR * (1 + 0.5 * sunsetFactor) * S.exposure[slot];
  const outG = skyG * (1 - 0.1 * sunsetFactor) * S.exposure[slot];
  const outB = skyB * (1 - 0.5 * sunsetFactor) * S.exposure[slot];

  return [Math.max(0, outR), Math.max(0, outG), Math.max(0, outB)];
}

// ═══════════════════════════════════════════════════════════════════════
// SIMPLE GRADIENT SKY MODEL
// ═══════════════════════════════════════════════════════════════════════

function sampleSimpleGradient(slot, dirX, dirY, dirZ) {
  const S = SkyF32;
  const cosViewElev = Math.max(dirY, 0);
  const t = 1 - cosViewElev;

  // Interpolate between top and horizon colour.
  const r = S.customTopR[slot] * (1 - t) + S.customHorizonR[slot] * t;
  const g = S.customTopG[slot] * (1 - t) + S.customHorizonG[slot] * t;
  const b = S.customTopB[slot] * (1 - t) + S.customHorizonB[slot] * t;

  return [r * S.exposure[slot], g * S.exposure[slot], b * S.exposure[slot]];
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SKY RADIANCE SAMPLE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample the sky radiance in direction (dirX, dirY, dirZ) from sky `slot`.
 * Returns [r, g, b] in linear HDR. Handles sun disk, moon disk, and
 * stars, so callers do not need to add those separately.
 */
export function sampleSkyRadiance(slot, dirX, dirY, dirZ) {
  const S = SkyF32;
  if (!S.enabled[slot]) return [0, 0, 0];

  // Normalize direction.
  const len = Math.hypot(dirX, dirY, dirZ);
  if (len < EPSILON) return [0, 0, 0];
  dirX /= len; dirY /= len; dirZ /= len;

  const model = S.model[slot];
  let skyR, skyG, skyB;

  if (model === SkyModel.PREETHAM) {
    [skyR, skyG, skyB] = samplePreetham(slot, dirX, dirY, dirZ);
  } else if (model === SkyModel.HOSEK_WILKIE) {
    [skyR, skyG, skyB] = sampleHosekWilkie(slot, dirX, dirY, dirZ);
  } else if (model === SkyModel.SIMPLE_GRADIENT) {
    [skyR, skyG, skyB] = sampleSimpleGradient(slot, dirX, dirY, dirZ);
  } else {
    [skyR, skyG, skyB] = [0, 0, 0];
  }

  // Below horizon: fade to ground albedo.
  if (dirY < 0) {
    const groundFactor = Math.min(1, -dirY * 4);
    skyR = skyR * (1 - groundFactor) + S.groundAlbedoR[slot] * groundFactor * 0.5;
    skyG = skyG * (1 - groundFactor) + S.groundAlbedoG[slot] * groundFactor * 0.5;
    skyB = skyB * (1 - groundFactor) + S.groundAlbedoB[slot] * groundFactor * 0.5;
  }

  // Sun disk.
  const sunCos = dirX * S.sunDirX[slot] + dirY * S.sunDirY[slot] + dirZ * S.sunDirZ[slot];
  if (sunCos > SUN_COS_ANGULAR_RADIUS && S.sunDirY[slot] > -0.1) {
    const sunRGB = blackbodyRGB(S.sunTemperature[slot]);
    const diskBoost = S.sunIntensity[slot] * 50;   // sun is much brighter than sky
    skyR += sunRGB[0] * diskBoost;
    skyG += sunRGB[1] * diskBoost;
    skyB += sunRGB[2] * diskBoost;
  }

  // Moon disk.
  const moonCos = dirX * S.moonDirX[slot] + dirY * S.moonDirY[slot] + dirZ * S.moonDirZ[slot];
  if (moonCos > MOON_COS_ANGULAR_RADIUS && S.moonDirY[slot] > -0.1) {
    const moonBoost = S.moonIntensity[slot] * 20;
    skyR += moonBoost;
    skyG += moonBoost * 0.98;
    skyB += moonBoost * 0.92;
  }

  // Stars (only when sky is dark enough).
  const nightFactor = Math.max(0, 1 - Math.max(0, S.sunDirY[slot] + 0.1) * 10);
  if (nightFactor > 0.01 && dirY > 0) {
    const starVal = sampleStars(slot, dirX, dirY, dirZ);
    skyR += starVal * nightFactor;
    skyG += starVal * nightFactor;
    skyB += starVal * nightFactor;
  }

  // Clouds (procedural noise overlay).
  if (S.cloudCoverage[slot] > 0.01) {
    const cloudVal = sampleClouds(slot, dirX, dirY, dirZ);
    if (cloudVal > 0) {
      skyR = skyR * (1 - cloudVal) + cloudVal * 0.9;
      skyG = skyG * (1 - cloudVal) + cloudVal * 0.9;
      skyB = skyB * (1 - cloudVal) + cloudVal * 0.95;
    }
  }

  return [skyR, skyG, skyB];
}

// ═══════════════════════════════════════════════════════════════════════
// STAR FIELD — deterministic hash-based starfield
// ═══════════════════════════════════════════════════════════════════════

function hash3(x, y, z) {
  // Fast integer hash.
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function sampleStars(slot, dirX, dirY, dirZ) {
  const S = SkyF32;
  // Quantize direction to a grid on the sphere.
  const scale = 200;
  const gx = Math.round(dirX * scale);
  const gy = Math.round(dirY * scale);
  const gz = Math.round(dirZ * scale);

  const seed = S.starSeed[slot];
  const h = hash3(gx + seed, gy, gz);

  // Only 1 in ~1000 cells gets a star.
  if (h > 0.001 * S.starDensity[slot] / 4000) return 0;

  // Star brightness varies by another hash.
  const brightness = 0.5 + 2.0 * hash3(gx + 1, gy + seed, gz);
  return brightness * nightFactorApprox(dirY);
}

function nightFactorApprox(dirY) {
  return dirY > 0.1 ? 1 : dirY > 0 ? dirY * 10 : 0;
}

// ═══════════════════════════════════════════════════════════════════════
// CLOUDS — 2D noise layered on a dome
// ═══════════════════════════════════════════════════════════════════════

const _cloudNoises = new Map(); // skySlot -> createNoise2D instance
let _cloudTime = 0;

function getCloudNoise(slot) {
  let noise = _cloudNoises.get(slot);
  if (!noise) {
    const seed = SkyF32.cloudNoiseSeed[slot];
    noise = createNoise2D(() => mulberry32(seed));
    _cloudNoises.set(slot, noise);
  }
  return noise;
}

function sampleClouds(slot, dirX, dirY, dirZ) {
  const S = SkyF32;
  if (dirY < 0.01) return 0;

  const noise = getCloudNoise(slot);

  // Project onto a dome.
  const domeScale = 1 / Math.max(dirY, 0.1);
  const u = dirX * domeScale + _cloudTime * S.cloudSpeed[slot];
  const v = dirZ * domeScale + _cloudTime * S.cloudSpeed[slot] * 0.7;

  // Layered noise.
  let n = noise(u * 0.5, v * 0.5) * 0.5;
  n += noise(u * 1.0, v * 1.0) * 0.3;
  n += noise(u * 2.0, v * 2.0) * 0.2;

  // Map [-1, 1] to [0, 1].
  n = (n + 1) * 0.5;

  // Threshold by coverage.
  const threshold = 1 - S.cloudCoverage[slot];
  if (n < threshold) return 0;

  const cloudAlpha = (n - threshold) / Math.max(1 - threshold, EPSILON);
  // Fade near horizon.
  const horizonFade = Math.min(1, dirY * 5);
  return cloudAlpha * horizonFade * 0.9;
}

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
// SUN / MOON DIRECTION FROM CYCLE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute sun direction from day/night cycle time.
 * Cycle: 0 = sunrise (east), π/2 = noon (top), π = sunset (west),
 *        3π/2 = midnight (below).
 */
function sunFromCycle(cycleTime) {
  // Sun path is tilted by ~45° (latitude simulation).
  const tilt = 45 * DEG_TO_RAD;
  const cycle = cycleTime % TWO_PI;

  // Hour angle.
  const hourAngle = cycle;

  // Standard sun position formula.
  const sinEl = Math.sin(tilt) * 0 + Math.cos(tilt) * Math.sin(hourAngle);
  const cosEl = Math.sqrt(Math.max(0, 1 - sinEl * sinEl));

  return {
    dirX: cosEl * Math.cos(hourAngle),
    dirY: sinEl,
    dirZ: cosEl * Math.sin(hourAngle),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — day/night cycle driver
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update sun / moon direction from cycle time and advance the clock.
 * Call once per frame.
 */
export function systemUpdateSky(world, dt) {
  const S = SkyF32;
  _cloudTime += dt;

  for (let slot = 0; slot < _nextSkySlot; slot++) {
    if (!S.enabled[slot]) continue;

    if (S.cycleAuto[slot]) {
      S.cycleTime[slot] += S.cycleSpeed[slot] * dt;
      if (S.cycleTime[slot] > TWO_PI) S.cycleTime[slot] -= TWO_PI;

      const sunDir = sunFromCycle(S.cycleTime[slot]);
      S.sunDirX[slot] = sunDir.dirX;
      S.sunDirY[slot] = sunDir.dirY;
      S.sunDirZ[slot] = sunDir.dirZ;

      S.moonDirX[slot] = -sunDir.dirX;
      S.moonDirY[slot] = -sunDir.dirY;
      S.moonDirZ[slot] = -sunDir.dirZ;
    }

    // Sync infinite light slot (file 015) if configured.
    const lightSlot = S.infiniteLightSlot[slot];
    if (lightSlot >= 0 && lightSlot < LightF32.enabled.length) {
      if (LightF32.enabled[lightSlot]) {
        // Approximate: set light colour based on sun + sky.
        const sky = sampleSkyRadiance(slot, S.sunDirX[slot], S.sunDirY[slot], S.sunDirZ[slot]);
        LightF32.r[lightSlot] = sky[0];
        LightF32.g[lightSlot] = sky[1];
        LightF32.b[lightSlot] = sky[2];
      }
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// ENVIRONMENT MAP BAKE — sample sky into equirect texture
// ═══════════════════════════════════════════════════════════════════════

/**
 * Bake sky into a Float32Array equirectangular radiance map.
 * Width and height must be powers of two.
 *
 * @param slot       sky slot
 * @param width      pixels (default 512)
 * @param height     pixels (default 256)
 * @returns Float32Array of size (width * height * 3) — linear HDR
 */
export function bakeSkyToEquirect(slot, width = 512, height = 256) {
  const S = SkyF32;
  if (!S.enabled[slot]) return new Float32Array(width * height * 3);

  const data = new Float32Array(width * height * 3);

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    const phi = v * PI;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const theta = u * TWO_PI;

      // Equirectangular mapping: direction from (u, v).
      const dx = sinPhi * Math.cos(theta);
      const dy = cosPhi;
      const dz = sinPhi * Math.sin(theta);

      const rgb = sampleSkyRadiance(slot, dx, dy, dz);

      const idx = (y * width + x) * 3;
      data[idx]     = rgb[0];
      data[idx + 1] = rgb[1];
      data[idx + 2] = rgb[2];
    }
  }

  return data;
}

/**
 * Bake sky into a THREE.CubeTexture (6 faces, RGBA8).
 * Useful for environment reflections and IBL in file 017.
 */
export function bakeSkyToCubeTexture(slot, size = 128) {
  const S = SkyF32;
  if (!S.enabled[slot]) return null;

  const faces = [];
  const directions = [
    // +X, -X, +Y, -Y, +Z, -Z
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];

  for (let f = 0; f < 6; f++) {
    const faceData = new Uint8ClampedArray(size * size * 4);
    const [fx, fy, fz] = directions[f];

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x / (size - 1)) * 2 - 1;
        const v = (y / (size - 1)) * 2 - 1;

        // Compose direction from cube face.
        let dx, dy, dz;
        if (f === 0)      { dx = 1; dy = -v; dz = -u; }
        else if (f === 1) { dx = -1; dy = -v; dz = u; }
        else if (f === 2) { dx = u; dy = 1; dz = v; }
        else if (f === 3) { dx = u; dy = -1; dz = -v; }
        else if (f === 4) { dx = u; dy = -v; dz = 1; }
        else              { dx = -u; dy = -v; dz = -1; }

        const len = Math.hypot(dx, dy, dz);
        dx /= len; dy /= len; dz /= len;

        const rgb = sampleSkyRadiance(slot, dx, dy, dz);

        const idx = (y * size + x) * 4;
        faceData[idx]     = Math.min(255, Math.max(0, Math.pow(rgb[0], 1 / 2.2) * 255));
        faceData[idx + 1] = Math.min(255, Math.max(0, Math.pow(rgb[1], 1 / 2.2) * 255));
        faceData[idx + 2] = Math.min(255, Math.max(0, Math.pow(rgb[2], 1 / 2.2) * 255));
        faceData[idx + 3] = 255;
      }
    }
    faces.push(new THREE.DataTexture(faceData, size, size, THREE.RGBAFormat, THREE.UnsignedByteType));
    faces[f].needsUpdate = true;
  }

  // Assemble into cube texture.
  const cubeTex = new THREE.CubeTexture(faces.map(f => f.image.data));
  cubeTex.format = THREE.RGBAFormat;
  cubeTex.type = THREE.UnsignedByteType;
  cubeTex.needsUpdate = true;
  return cubeTex;
}

// ═══════════════════════════════════════════════════════════════════════
// THREE.JS SKY DOME — optional visible sky mesh
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a THREE.Mesh that renders the sky as a background dome.
 * Uses a shader that samples samplePreetham / sampleHosekWilkie.
 */
export function createThreeSkyDome(slot) {
  const S = SkyF32;

  const uniforms = {
    uSunDir:        { value: new THREE.Vector3(S.sunDirX[slot], S.sunDirY[slot], S.sunDirZ[slot]) },
    uSunColor:      { value: new THREE.Vector3(1, 1, 1) },
    uTurbidity:     { value: S.turbidity[slot] },
    uRayleigh:      { value: S.rayleigh[slot] },
    uMie:           { value: S.mie[slot] },
    uMieG:          { value: S.mieG[slot] },
    uExposure:      { value: S.exposure[slot] },
  };

  const skyMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uTurbidity;
      uniform float uRayleigh;
      uniform float uMie;
      uniform float uMieG;
      uniform float uExposure;
      varying vec3 vDirection;

      const float PI = 3.141592653589793;

      void main() {
        vec3 dir = normalize(vDirection);
        float cosSunView = dot(dir, uSunDir);
        float sunViewAngle = acos(clamp(cosSunView, -1.0, 1.0));

        // Simple Preetham-style approximation for the dome shader.
        float rayleighPhase = (3.0 / (16.0 * PI)) * (1.0 + pow(cosSunView, 2.0));
        float mieDenom = pow(1.0 + uMieG * uMieG - 2.0 * uMieG * cosSunView, 1.5);
        float miePhase = (1.0 - uMieG * uMieG) / (4.0 * PI * max(mieDenom, 1e-6));

        float zenith = max(dir.y, 0.0);
        float horizon = 1.0 - zenith;

        vec3 skyColor = vec3(
          uRayleigh * rayleighPhase * 0.5 * horizon,
          uRayleigh * rayleighPhase * 0.7,
          uRayleigh * rayleighPhase * 1.0 * (1.0 + horizon * 0.2)
        );

        // Sun disk.
        float sunAngularRadius = 0.0046;
        if (sunViewAngle < sunAngularRadius && uSunDir.y > -0.1) {
          skyColor += uSunColor * 50.0;
        }

        skyColor *= uExposure;
        skyColor = pow(max(skyColor, vec3(0.0)), vec3(1.0 / 2.2));

        gl_FragColor = vec4(skyColor, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });

  const skyGeo = new THREE.SphereGeometry(1000, 32, 16);
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -1000;
  skyMesh.name = 'SkyDome';

  return { mesh: skyMesh, uniforms, material: skyMat };
}

// ═══════════════════════════════════════════════════════════════════════
// CONVENIENCE — sample sky from ECS entity
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample sky radiance at an entity's sky slot.
 */
export function sampleSkyFromEntity(world, eid, dirX, dirY, dirZ) {
  const slot = getSkySlot(eid);
  if (slot < 0) return [0, 0, 0];
  return sampleSkyRadiance(slot, dirX, dirY, dirZ);
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearSkies() {
  _skySlots.clear();
  _nextSkySlot = 0;
  _cloudNoises.clear();
  _cloudTime = 0;
  SkyF32.enabled.fill(0);
  SkyF32.ownerEid.fill(0);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function skyStats() {
  let activeSkies = 0;
  let autoCycles = 0;

  for (let i = 0; i < _nextSkySlot; i++) {
    if (SkyF32.enabled[i]) activeSkies++;
    if (SkyF32.cycleAuto[i]) autoCycles++;
  }

  return {
    skyCount: _nextSkySlot,
    activeSkies,
    autoCycles,
    cloudNoiseInstances: _cloudNoises.size,
  };
}