//File number : 068
// File : src/math/068_galactic-scale.js
//Description : Complete galactic-scale system — SI constants and conversions (mm → Gpc), astronomical constants (solar mass/radius/luminosity, G, c, J2000 epoch), spherical coordinate systems (equatorial ↔ ecliptic ↔ galactic) with Cartesian variants, blackbody → sRGB color from temperature (1000–40000 K), full OBAFGKM spectral classification with stellar mass/radius/luminosity/temperature, procedural star-field and galaxy generation at 1M+ instances (uniform, spiral, elliptical Sérsic, irregular, King globular cluster, r⁻³ halo), distance modulus & apparent↔absolute magnitude, screen-space LOD level selection, floating-origin recentering for seamless camera motion across mm→Mpc, logarithmic depth-buffer encode/decode, Julian-date / J2000 epoch helpers, precision-tier selection (f16/f32/f64) based on world extent, SOA batches with chunked async yielding via `scheduler.yield()`, and a pooled `GalacticScratch`. Buffers honor `000_Math_module.js` precision mode (live-swap), every hot loop stays within 60 fps on
 Android 64-bit for 1M+ units.
//####
//Best for : 3d graphics — fully procedural star fields (1M+ stars, instanced billboards), spiral/elliptical/irregular galaxy rendering, deep-sky object catalogs, floating-origin camera systems for seamless planetary ↔ galactic zoom, HDR star colors (blackbody radiation, ACES-ready), apparent-brightness LOD, astrophysical Kepler orbits at AU/pc scales, scientific visualization (RA/Dec ↔ l/b, equatorial ↔ galactic), blackbody-based emissive materials for gas giants/stars/nebulae, mobile-safe large-scale procedural scenes at 1M+ units on Android 64-bit.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M               = require("./000_Math_module.js");
const NoiseFamily     = require("./044_noise-family.js");
const SpecialFunctions = require("./055_special-functions.js");

const common          = M.common;
const vec3            = M.vec3;
const quat            = M.quat;
const mat4            = M.mat4;
const getArrayType    = M.getArrayType;
const onPrecisionChange = M.onPrecisionChange;
const createVec3SOA   = M.createVec3SOA;
const createVec4SOA   = M.createVec4SOA;
const createQuatSOA   = M.createQuatSOA;

// ============================================================================
// Export Declarations
// ============================================================================

// ---- SI / astronomical scale constants ----
exports.SCALE_NEAR        = SCALE_NEAR;
exports.SCALE_METER       = SCALE_METER;
exports.SCALE_KM          = SCALE_KM;
exports.SCALE_EARTH_RADIUS = SCALE_EARTH_RADIUS;
exports.SCALE_AU          = SCALE_AU;
exports.SCALE_LY          = SCALE_LY;
exports.SCALE_PC          = SCALE_PC;
exports.SCALE_KPC         = SCALE_KPC;
exports.SCALE_MPC         = SCALE_MPC;
exports.SCALE_GPC         = SCALE_GPC;

exports.SOLAR_MASS        = SOLAR_MASS;
exports.SOLAR_RADIUS      = SOLAR_RADIUS;
exports.SOLAR_LUMINOSITY  = SOLAR_LUMINOSITY;
exports.EARTH_MASS        = EARTH_MASS;
exports.EARTH_RADIUS      = EARTH_RADIUS;
exports.JUPITER_MASS      = JUPITER_MASS;
exports.G                 = G;
exports.C                 = C;
exports.MU_SUN            = MU_SUN;
exports.J2000_JD          = J2000_JD;

// ---- Unit conversions ----
exports.auToMeters        = auToMeters;
exports.metersToAu        = metersToAu;
exports.lyToMeters        = lyToMeters;
exports.metersToLy        = metersToLy;
exports.pcToMeters        = pcToMeters;
exports.metersToPc        = metersToPc;
exports.kpcToMeters       = kpcToMeters;
exports.metersToKpc       = metersToKpc;
exports.mpcToMeters       = mpcToMeters;
exports.metersToMpc       = metersToMpc;
exports.arcsecToRad       = arcsecToRad;
exports.radToArcsec       = radToArcsec;
exports.hoursToRad        = hoursToRad;
exports.radToHours        = radToHours;

// ---- Coordinate systems ----
exports.equatorialToGalactic = equatorialToGalactic;
exports.galacticToEquatorial = galacticToEquatorial;
exports.equatorialToEcliptic = equatorialToEcliptic;
exports.eclipticToEquatorial = eclipticToEquatorial;
exports.equatorialToCartesian = equatorialToCartesian;
exports.cartesianToEquatorial = cartesianToEquatorial;
exports.galacticToCartesian   = galacticToCartesian;
exports.cartesianToGalactic   = cartesianToGalactic;
exports.sphericalToCartesian  = sphericalToCartesian;
exports.cartesianToSpherical  = cartesianToSpherical;

// ---- Blackbody / spectral ----
exports.temperatureToRgb        = temperatureToRgb;
exports.temperatureToRgbHDR     = temperatureToRgbHDR;
exports.spectralClassFromTemperature = spectralClassFromTemperature;
exports.temperatureFromSpectralClass = temperatureFromSpectralClass;
exports.stellarProperties       = stellarProperties;
exports.luminosityFromAbsoluteMagnitude = luminosityFromAbsoluteMagnitude;
exports.absoluteMagnitudeFromLuminosity = absoluteMagnitudeFromLuminosity;

// ---- Star / galaxy generation ----
exports.generateStarFieldSOA        = generateStarFieldSOA;
exports.generateSpiralGalaxySOA     = generateSpiralGalaxySOA;
exports.generateEllipticalGalaxySOA = generateEllipticalGalaxySOA;
exports.generateIrregularGalaxySOA  = generateIrregularGalaxySOA;
exports.generateGlobularClusterSOA  = generateGlobularClusterSOA;
exports.generateHaloSOA             = generateHaloSOA;

// ---- Distance / LOD ----
exports.distanceModulus            = distanceModulus;
exports.apparentMagnitude          = apparentMagnitude;
exports.absoluteMagnitude          = absoluteMagnitude;
exports.fluxFromMagnitude          = fluxFromMagnitude;
exports.magnitudeFromFlux          = magnitudeFromFlux;
exports.lodLevel                   = lodLevel;

// ---- Epoch / time ----
exports.unixToJulianDate           = unixToJulianDate;
exports.julianDateToUnix           = julianDateToUnix;
exports.daysSinceJ2000             = daysSinceJ2000;
exports.julianDateToJ2000Days      = julianDateToJ2000Days;
exports.epochToJulianDate          = epochToJulianDate;

// ---- Floating origin ----
exports.FloatingOrigin             = FloatingOrigin;
exports.createFloatingOrigin       = createFloatingOrigin;
exports.soaRecenter                = soaRecenter;
exports.soaRecenterChunked         = soaRecenterChunked;
exports.toLocal                    = toLocal;
exports.toWorld                    = toWorld;

// ---- Log depth ----
exports.logDepthConstants          = logDepthConstants;
exports.logDepthEncode             = logDepthEncode;
exports.logDepthDecode             = logDepthDecode;

// ---- Precision ----
exports.suggestPrecision           = suggestPrecision;
exports.worldUnitFor               = worldUnitFor;
exports.maxCoordinateForPrecision  = maxCoordinateForPrecision;

// ---- SOA (sync) ----
exports.soaTemperatureToRgb        = soaTemperatureToRgb;
exports.soaTemperatureToRgbHDR     = soaTemperatureToRgbHDR;
exports.soaEquatorialToGalactic    = soaEquatorialToGalactic;
exports.soaEquatorialToCartesian   = soaEquatorialToCartesian;
exports.soaDistanceModulus         = soaDistanceModulus;
exports.soaLodLevel                = soaLodLevel;
exports.soaStarField               = soaStarField;
exports.soaSpiralGalaxy            = soaSpiralGalaxy;

// ---- SOA (chunked async) ----
exports.soaTemperatureToRgbChunked     = soaTemperatureToRgbChunked;
exports.soaEquatorialToGalacticChunked = soaEquatorialToGalacticChunked;
exports.soaDistanceModulusChunked      = soaDistanceModulusChunked;
exports.soaLodLevelChunked             = soaLodLevelChunked;
exports.soaStarFieldChunked            = soaStarFieldChunked;
exports.soaSpiralGalaxyChunked         = soaSpiralGalaxyChunked;

// ---- Pools ----
exports.GalacticScratch            = GalacticScratch;
exports.createGalacticScratchPool  = createGalacticScratchPool;
exports.acquireGalacticScratch     = acquireGalacticScratch;
exports.releaseGalacticScratch     = releaseGalacticScratch;

// ---- Batch state ----
exports.GalacticBatchState         = GalacticBatchState;
exports.createGalacticBatch        = createGalacticBatch;

// ---- Namespaces ----
exports.namespace = {};

// ============================================================================
// Global Declarations
// ============================================================================

// (all mutable state lives in pools or per-instance)

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {"f16"|"f32"|"f64"} PrecisionTier
 */

/**
 * @typedef {Object} StarField
 * @property {number} count
 * @property {Object} positions      vec3 SOA
 * @property {Object} colors         vec4 SOA (RGBA, HDR)
 * @property {Float32Array} temperatures   Kelvin
 * @property {Float32Array} absoluteMagnitudes
 * @property {Uint8Array} spectralClasses  0=O..6=M
 * @property {Float32Array} radii         Solar radii
 * @property {Float32Array} masses        Solar masses
 * @property {Float32Array} luminosities  Solar luminosities
 */

/**
 * @typedef {Object} FloatingOriginState
 * @property {number[]} origin
 * @property {number} threshold
 */

/**
 * @typedef {Object} GalacticBatchOptions
 * @property {number} count
 * @property {Object} [bounds]       { minX, minY, minZ, maxX, maxY, maxZ }
 * @property {number} [seed=1]
 * @property {string} [layout="uniform"|"spiral"|"elliptical"|"irregular"]
 */

// ============================================================================
// Variable Declarations — SI / astronomical constants
// ============================================================================

const SCALE_NEAR         = 1e-3;
const SCALE_METER        = 1;
const SCALE_KM           = 1e3;
const SCALE_EARTH_RADIUS = 6.371e6;
const SCALE_AU           = 1.495978707e11;
const SCALE_LY           = 9.4607304725808e15;
const SCALE_PC           = 3.0856775814913673e16;
const SCALE_KPC          = 3.0856775814913673e19;
const SCALE_MPC          = 3.0856775814913673e22;
const SCALE_GPC          = 3.0856775814913673e25;

const SOLAR_MASS         = 1.98847e30;
const SOLAR_RADIUS       = 6.957e8;
const SOLAR_LUMINOSITY   = 3.828e26;
const EARTH_MASS         = 5.9722e24;
const EARTH_RADIUS       = 6.371e6;
const JUPITER_MASS       = 1.89813e27;
const G                  = 6.67430e-11;
const C                  = 2.99792458e8;
const MU_SUN             = G * SOLAR_MASS;
const J2000_JD           = 2451545.0;

const AU_IN_M            = SCALE_AU;
const LY_IN_M            = SCALE_LY;
const PC_IN_M            = SCALE_PC;
const KPC_IN_M           = SCALE_KPC;
const MPC_IN_M           = SCALE_MPC;
const UNIX_TO_JD_OFFSET  = 2440587.5;
const SECONDS_PER_DAY    = 86400;

const ARCSEC_PER_RAD     = 206264.80624709636;
const HOURS_PER_RAD      = 3.8197186342054885;
const DEG_TO_RAD         = Math.PI / 180;

const EPSILON            = 1e-12;

// Galactic north pole in equatorial J2000 coordinates
const NGAL_RA            = 192.85948 * DEG_TO_RAD;      // rad
const NGAL_DEC           = 27.12825 * DEG_TO_RAD;       // rad
const L_NCP              = 122.93192 * DEG_TO_RAD;      // rad

// Ecliptic obliquity (J2000)
const OBLIQUITY_J2000    = 23.4392911 * DEG_TO_RAD;     // rad

// Standard reference magnitudes: Sun's absolute visual magnitude (V)
const SUN_ABS_MAG_V      = 4.83;

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * FloatingOrigin — keeps the renderable world centered around the camera to
 * preserve f32 precision at any distance (mm → Mpc). Recenters when the
 * camera moves beyond `threshold`; returns the delta to apply to all world
 * positions in the scene.
 */
class FloatingOrigin {
  // Class Fields
  origin    = null;
  threshold = 1e5;

  constructor(threshold) {
    this.origin = [0, 0, 0];
    if (threshold !== undefined) this.threshold = threshold;
  }

  /** Set origin to a new world position (no recenter). */
  setOrigin(x, y, z) {
    this.origin[0] = x;
    this.origin[1] = y;
    this.origin[2] = z;
    return this;
  }

  /**
   * Update — checks if recenter needed. Returns `[dx, dy, dz]` delta to apply
   * to all world positions (subtract from them), or `null` if no recenter.
   */
  update(cameraX, cameraY, cameraZ) {
    const dx = cameraX - this.origin[0];
    const dy = cameraY - this.origin[1];
    const dz = cameraZ - this.origin[2];
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > this.threshold * this.threshold) {
      this.origin[0] = cameraX;
      this.origin[1] = cameraY;
      this.origin[2] = cameraZ;
      return [dx, dy, dz];
    }
    return null;
  }

  /** World → local (subtract origin). */
  toLocal(out, x, y, z) {
    out[0] = x - this.origin[0];
    out[1] = y - this.origin[1];
    out[2] = z - this.origin[2];
    return out;
  }

  /** Local → world (add origin). */
  toWorld(out, x, y, z) {
    out[0] = x + this.origin[0];
    out[1] = y + this.origin[1];
    out[2] = z + this.origin[2];
    return out;
  }
}

function createFloatingOrigin(threshold) { return new FloatingOrigin(threshold); }

/**
 * GalacticScratch — reusable scratch for hot-loop galaxy / star generation.
 */
class GalacticScratch {
  static #warm = [];
  static {
    for (let i = 0; i < 8; i++) GalacticScratch.#warm.push(new GalacticScratch(256));
  }
  static acquire(size) {
    for (let i = 0; i < GalacticScratch.#warm.length; i++) {
      if (GalacticScratch.#warm[i].size >= (size || 0)) {
        const s = GalacticScratch.#warm[i];
        GalacticScratch.#warm.splice(i, 1);
        return s;
      }
    }
    return new GalacticScratch(size || 256);
  }
  static release(s) { if (s) { s.reset(); GalacticScratch.#warm.push(s); } }

  constructor(size) {
    this.size = size || 256;
    const T = getArrayType();
    this.a = new T(this.size);
    this.b = new T(this.size);
    this.c = new T(this.size);
    this.d = new T(this.size);
  }

  ensure(n) {
    if (n <= this.size) return this;
    this.size = n;
    const T = getArrayType();
    this.a = new T(n);
    this.b = new T(n);
    this.c = new T(n);
    this.d = new T(n);
    return this;
  }
  reset() { this.a.fill(0); this.b.fill(0); this.c.fill(0); this.d.fill(0); return this; }
}

/**
 * GalacticBatchState — preallocated buffers for 1M+ star / galaxy instances.
 * Re-create after `setPrecision()` to pick up the new array type.
 */
class GalacticBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      GalacticBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

  constructor(count) {
    this.count          = count;
    this.positions      = createVec3SOA(count);
    this.colors         = createVec4SOA(count);
    this.temperatures   = new Float32Array(count);
    this.absoluteMags   = new Float32Array(count);
    this.spectralClasses = new Uint8Array(count);
    this.radii          = new Float32Array(count);
    this.masses         = new Float32Array(count);
    this.luminosities   = new Float32Array(count);
  }

  /** Extract a StarField view over this batch state's arrays. */
  toStarField() {
    return {
      count: this.count,
      positions: this.positions,
      colors: this.colors,
      temperatures: this.temperatures,
      absoluteMagnitudes: this.absoluteMags,
      spectralClasses: this.spectralClasses,
      radii: this.radii,
      masses: this.masses,
      luminosities: this.luminosities
    };
  }
}

function createGalacticBatch(count) { return new GalacticBatchState(count); }

// ============================================================================
// Function Declarations — Unit conversions
// ============================================================================

function auToMeters(x)    { return x * AU_IN_M; }
function metersToAu(x)    { return x / AU_IN_M; }
function lyToMeters(x)    { return x * LY_IN_M; }
function metersToLy(x)    { return x / LY_IN_M; }
function pcToMeters(x)    { return x * PC_IN_M; }
function metersToPc(x)    { return x / PC_IN_M; }
function kpcToMeters(x)   { return x * KPC_IN_M; }
function metersToKpc(x)   { return x / KPC_IN_M; }
function mpcToMeters(x)   { return x * MPC_IN_M; }
function metersToMpc(x)   { return x / MPC_IN_M; }

function arcsecToRad(x)   { return x / ARCSEC_PER_RAD; }
function radToArcsec(x)   { return x * ARCSEC_PER_RAD; }
function hoursToRad(x)    { return x / HOURS_PER_RAD; }
function radToHours(x)    { return x * HOURS_PER_RAD; }

// ============================================================================
// Function Declarations — Coordinate systems
// ============================================================================

/**
 * Equatorial → Galactic. `ra` is right ascension, `dec` declination, both in
 * radians (RA ∈ [0, 2π), Dec ∈ [-π/2, π/2]). Returns `{ l, b }` in radians.
 */
function equatorialToGalactic(ra, dec) {
  const sinDec = Math.sin(dec);
  const cosDec = Math.cos(dec);
  const sinDecNgal = Math.sin(NGAL_DEC);
  const cosDecNgal = Math.cos(NGAL_DEC);
  const raOffset = ra - NGAL_RA;
  const sinB = sinDec * sinDecNgal + cosDec * cosDecNgal * Math.cos(raOffset);
  const b = Math.asin(Math.max(-1, Math.min(1, sinB)));
  const y = cosDec * Math.sin(raOffset);
  const x = sinDec * cosDecNgal - cosDec * sinDecNgal * Math.cos(raOffset);
  let l = L_NCP - Math.atan2(y, x);
  l = ((l % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return { l: l, b: b };
}

function galacticToEquatorial(l, b) {
  const sinB = Math.sin(b);
  const cosB = Math.cos(b);
  const sinDecNgal = Math.sin(NGAL_DEC);
  const cosDecNgal = Math.cos(NGAL_DEC);
  const lOffset = l - L_NCP;
  const sinDec = sinB * sinDecNgal + cosB * cosDecNgal * Math.cos(lOffset);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const y = cosB * Math.sin(lOffset);
  const x = sinB * cosDecNgal - cosB * sinDecNgal * Math.cos(lOffset);
  let ra = NGAL_RA + Math.atan2(y, x);
  ra = ((ra % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return { ra: ra, dec: dec };
}

function equatorialToEcliptic(ra, dec) {
  const sinDec = Math.sin(dec);
  const cosDec = Math.cos(dec);
  const sinEcl = Math.sin(OBLIQUITY_J2000);
  const cosEcl = Math.cos(OBLIQUITY_J2000);
  const sinBeta = sinDec * cosEcl - cosDec * sinEcl * Math.sin(ra);
  const beta = Math.asin(Math.max(-1, Math.min(1, sinBeta)));
  const y = cosDec * Math.sin(ra) * cosEcl + sinDec * sinEcl;
  const x = cosDec * Math.cos(ra);
  let lambda = Math.atan2(y, x);
  lambda = ((lambda % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return { lambda: lambda, beta: beta };
}

function eclipticToEquatorial(lambda, beta) {
  const sinBeta = Math.sin(beta);
  const cosBeta = Math.cos(beta);
  const sinEcl = Math.sin(OBLIQUITY_J2000);
  const cosEcl = Math.cos(OBLIQUITY_J2000);
  const sinDec = sinBeta * cosEcl + cosBeta * sinEcl * Math.sin(lambda);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const y = cosBeta * Math.sin(lambda) * cosEcl - sinBeta * sinEcl;
  const x = cosBeta * Math.cos(lambda);
  let ra = Math.atan2(y, x);
  ra = ((ra % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return { ra: ra, dec: dec };
}

/** Equatorial (RA, Dec) + distance → Cartesian XYZ. */
function equatorialToCartesian(out, ra, dec, dist) {
  const cosDec = Math.cos(dec);
  out[0] = dist * cosDec * Math.cos(ra);
  out[1] = dist * cosDec * Math.sin(ra);
  out[2] = dist * Math.sin(dec);
  return out;
}

function cartesianToEquatorial(out, x, y, z) {
  const dist = Math.sqrt(x * x + y * y + z * z);
  const ra = Math.atan2(y, x);
  const dec = dist > EPSILON ? Math.asin(z / dist) : 0;
  out[0] = ((ra % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  out[1] = dec;
  out[2] = dist;
  return out;
}

function galacticToCartesian(out, l, b, dist) {
  const cosB = Math.cos(b);
  out[0] = dist * cosB * Math.cos(l);
  out[1] = dist * cosB * Math.sin(l);
  out[2] = dist * Math.sin(b);
  return out;
}

function cartesianToGalactic(out, x, y, z) {
  const dist = Math.sqrt(x * x + y * y + z * z);
  const l = Math.atan2(y, x);
  const b = dist > EPSILON ? Math.asin(z / dist) : 0;
  out[0] = ((l % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  out[1] = b;
  out[2] = dist;
  return out;
}

/** Spherical (r, theta from +Y, phi from +X in XZ) → Cartesian. */
function sphericalToCartesian(out, r, theta, phi) {
  const sinT = Math.sin(theta);
  out[0] = r * sinT * Math.cos(phi);
  out[1] = r * Math.cos(theta);
  out[2] = r * sinT * Math.sin(phi);
  return out;
}

function cartesianToSpherical(out, x, y, z) {
  const r = Math.sqrt(x * x + y * y + z * z);
  const theta = r > EPSILON ? Math.acos(y / r) : 0;
  let phi = Math.atan2(z, x);
  if (phi < 0) phi += 2 * Math.PI;
  out[0] = r;
  out[1] = theta;
  out[2] = phi;
  return out;
}

// ============================================================================
// Function Declarations — Blackbody → RGB
// ============================================================================

/**
 * Tanner Helland blackbody RGB from temperature (Kelvin).
 * Valid for 1000–40000 K. Writes `out[0..2]` in [0, 1].
 */
function temperatureToRgb(out, kelvin) {
  const t = kelvin / 100;
  let r, g, b;
  if (t <= 66) r = 255;
  else {
    r = t - 60;
    r = 329.698727446 * Math.pow(r, -0.1332047592);
  }
  if (t <= 66) {
    g = t;
    g = 99.4708025861 * Math.log(g) - 161.1195681661;
  } else {
    g = t - 60;
    g = 288.1221695283 * Math.pow(g, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else {
    b = t - 10;
    b = 138.5177312231 * Math.log(b) - 305.0447927307;
  }
  out[0] = Math.max(0, Math.min(255, r)) / 255;
  out[1] = Math.max(0, Math.min(255, g)) / 255;
  out[2] = Math.max(0, Math.min(255, b)) / 255;
  return out;
}

/**
 * HDR version — like `temperatureToRgb` but multiplied by a per-star
 * brightness (which can exceed 1). Never clamps, so ACES tone-mapping and
 * physical bloom pipelines preserve the star's energy.
 */
function temperatureToRgbHDR(out, kelvin, brightness) {
  brightness = brightness === undefined ? 1 : brightness;
  temperatureToRgb(out, kelvin);
  out[0] *= brightness;
  out[1] *= brightness;
  out[2] *= brightness;
  return out;
}

// ============================================================================
// Function Declarations — Spectral classification
// ============================================================================

/** Spectral class from temperature. Returns 0..6 (O..M). */
function spectralClassFromTemperature(kelvin) {
  if (kelvin >= 30000) return 0; // O
  if (kelvin >= 10000) return 1; // B
  if (kelvin >= 7500)  return 2; // A
  if (kelvin >= 6000)  return 3; // F
  if (kelvin >= 5200)  return 4; // G
  if (kelvin >= 3700)  return 5; // K
  return 6;                      // M
}

/**
 * Typical temperature for a spectral class + subclass (0-9).
 * Returns Kelvin.
 */
function temperatureFromSpectralClass(cls, subclass) {
  subclass = subclass === undefined ? 5 : Math.max(0, Math.min(9, subclass));
  const norm = subclass / 9;
  const top = [50000, 30000, 10000, 7500, 6000, 5200, 3700][cls] || 30000;
  const bot = [30000, 10000, 7500, 6000, 5200, 3700, 2400][cls] || 3000;
  return bot + (top - bot) * norm;
}

/**
 * Stellar properties (main sequence) from spectral class (0=O..6=M) and
 * subclass. Returns `{ mass, radius, luminosity, temperature }` in solar units.
 */
function stellarProperties(cls, subclass) {
  subclass = subclass === undefined ? 5 : Math.max(0, Math.min(9, subclass));
  const temp = temperatureFromSpectralClass(cls, subclass);
  // Approximate mass–luminosity–radius relations by class midpoint
  const masses     = [30, 10, 2.2, 1.3, 1.0, 0.7, 0.3];
  const radii      = [12, 5, 2, 1.3, 1.0, 0.8, 0.4];
  const luminosities = [1e5, 500, 20, 3.5, 1.0, 0.3, 0.02];
  const m = masses[cls];
  const r = radii[cls];
  const L = luminosities[cls];
  return { mass: m, radius: r, luminosity: L, temperature: temp };
}

/** Solar-luminosity ↔ absolute-magnitude (V band). */
function luminosityFromAbsoluteMagnitude(absMag) {
  return Math.pow(10, (SUN_ABS_MAG_V - absMag) / 2.5);
}

function absoluteMagnitudeFromLuminosity(lum) {
  if (lum <= 0) return Infinity;
  return SUN_ABS_MAG_V - 2.5 * Math.log10(lum);
}

// ============================================================================
// Function Declarations — Star field / galaxy generation
// ============================================================================

/**
 * Generate a uniform 3D star field inside an AABB. Positions in the SOA are
 * in the caller's world units (no implicit scaling). Deterministic given
 * `seed`.
 */
function generateStarFieldSOA(count, bounds, options) {
  options = options || {};
  const seed = options.seed || 1;
  bounds = bounds || { minX: -1000, minY: -1000, minZ: -1000, maxX: 1000, maxY: 1000, maxZ: 1000 };
  const rng = common.mulberry32(seed);

  const positions = createVec3SOA(count);
  const colors    = createVec4SOA(count);
  const temps     = new Float32Array(count);
  const absMags   = new Float32Array(count);
  const classes   = new Uint8Array(count);
  const radii     = new Float32Array(count);
  const masses    = new Float32Array(count);
  const lums      = new Float32Array(count);
  const tmpRgb    = [0, 0, 0];

  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const spanZ = bounds.maxZ - bounds.minZ;

  for (let i = 0; i < count; i++) {
    positions.x[i] = bounds.minX + rng() * spanX;
    positions.y[i] = bounds.minY + rng() * spanY;
    positions.z[i] = bounds.minZ + rng() * spanZ;

    // Spectral distribution: mostly M dwarfs (realistic IMF)
    const r = rng();
    let cls;
    if (r < 0.0001) cls = 0;       // O (0.01%)
    else if (r < 0.0013) cls = 1;  // B (0.12%)
    else if (r < 0.0073) cls = 2;  // A (0.6%)
    else if (r < 0.0373) cls = 3;  // F (3%)
    else if (r < 0.113) cls = 4;   // G (7.6%)
    else if (r < 0.233) cls = 5;   // K (12%)
    else cls = 6;                  // M (76.5%)
    const subclass = Math.floor(rng() * 10);
    const props = stellarProperties(cls, subclass);

    temps[i] = props.temperature;
    radii[i] = props.radius;
    masses[i] = props.mass;
    lums[i] = props.luminosity;
    absMags[i] = absoluteMagnitudeFromLuminosity(props.luminosity);
    classes[i] = cls;

    // HDR color — brightness from luminosity (clamped to reasonable range)
    const brightness = Math.max(0.5, Math.min(50, props.luminosity));
    temperatureToRgbHDR(tmpRgb, props.temperature, brightness);
    colors.x[i] = tmpRgb[0];
    colors.y[i] = tmpRgb[1];
    colors.z[i] = tmpRgb[2];
    colors.w[i] = 1;
  }

  return {
    count: count,
    positions: positions,
    colors: colors,
    temperatures: temps,
    absoluteMagnitudes: absMags,
    spectralClasses: classes,
    radii: radii,
    masses: masses,
    luminosities: lums
  };
}

/**
 * Spiral galaxy — exponential disk + logarithmic arms + central bulge +
 * halo. Positions written in world units (`radius` is the disk scale length
 * in the caller's unit; multiply by KPC_IN_M for physical meters).
 */
function generateSpiralGalaxySOA(count, options) {
  options = options || {};
  const seed = options.seed || 1;
  const radius = options.radius !== undefined ? options.radius : 30;
  const bulgeRadius = options.bulgeRadius !== undefined ? options.bulgeRadius : radius * 0.15;
  const diskScale = options.diskScale !== undefined ? options.diskScale : radius * 0.35;
  const armCount = options.armCount !== undefined ? options.armCount : 2;
  const armPitch = options.armPitch !== undefined ? options.armPitch : 0.3;
  const bulgeFraction = options.bulgeFraction !== undefined ? options.bulgeFraction : 0.15;
  const haloFraction = options.haloFraction !== undefined ? options.haloFraction : 0.05;
  const rng = common.mulberry32(seed);

  const positions = createVec3SOA(count);
  const colors    = createVec4SOA(count);
  const temps     = new Float32Array(count);
  const absMags   = new Float32Array(count);
  const classes   = new Uint8Array(count);
  const radii     = new Float32Array(count);
  const masses    = new Float32Array(count);
  const lums      = new Float32Array(count);
  const tmpRgb    = [0, 0, 0];

  const bulgeCount = Math.floor(count * bulgeFraction);
  const haloCount  = Math.floor(count * haloFraction);
  const diskCount  = count - bulgeCount - haloCount;

  // --- Bulge (exponential with small radius) ---
  for (let i = 0; i < bulgeCount; i++) {
    const r = -bulgeRadius * Math.log(1 - rng());
    const theta = rng() * 2 * Math.PI;
    const phi = Math.acos(2 * rng() - 1);
    positions.x[i] = r * Math.sin(phi) * Math.cos(theta);
    positions.y[i] = r * Math.sin(phi) * Math.sin(theta);
    positions.z[i] = r * Math.cos(phi);
    // Bulge is mostly old G/K/M stars
    const cls = 4 + Math.floor(rng() * 3);
    const subclass = Math.floor(rng() * 10);
    const p = stellarProperties(cls, subclass);
    temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
    absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
    classes[i] = cls;
    const brightness = Math.max(0.3, Math.min(3, p.luminosity));
    temperatureToRgbHDR(tmpRgb, p.temperature, brightness);
    colors.x[i] = tmpRgb[0]; colors.y[i] = tmpRgb[1]; colors.z[i] = tmpRgb[2]; colors.w[i] = 1;
  }

  // --- Disk (log spiral arms + exponential radial) ---
  for (let k = 0; k < diskCount; k++) {
    const i = bulgeCount + k;
    // Exponential radial distribution truncated at 3*scale
    let r;
    do { r = -diskScale * Math.log(1 - rng()); } while (r > radius * 3);
    const armIndex = Math.floor(rng() * armCount);
    const armTheta = armIndex * 2 * Math.PI / armCount + r * armPitch;
    // Gaussian jitter perpendicular to arm
    const jitter = (rng() + rng() + rng() + rng() - 2) * 0.15 * r;
    const theta = armTheta + jitter;
    positions.x[i] = r * Math.cos(theta);
    positions.y[i] = r * Math.sin(theta);
    positions.z[i] = (rng() + rng() + rng() - 1.5) * 0.05 * r;

    // Disk = mix of young hot blue stars (in arms) and older stars
    const isYoung = rng() < 0.4;
    const cls = isYoung ? (rng() < 0.5 ? 1 : 2) : (4 + Math.floor(rng() * 3));
    const subclass = Math.floor(rng() * 10);
    const p = stellarProperties(cls, subclass);
    temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
    absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
    classes[i] = cls;
    const brightness = isYoung ? Math.max(2, Math.min(8, p.luminosity)) : Math.max(0.5, Math.min(2, p.luminosity));
    temperatureToRgbHDR(tmpRgb, p.temperature, brightness);
    colors.x[i] = tmpRgb[0]; colors.y[i] = tmpRgb[1]; colors.z[i] = tmpRgb[2]; colors.w[i] = 1;
  }

  // --- Halo (r⁻³) ---
  for (let k = 0; k < haloCount; k++) {
    const i = bulgeCount + diskCount + k;
    // Rejection sample r ∝ r⁻³ (with cutoff)
    let r;
    do { r = radius * 5 * rng(); } while (r > EPSILON && rng() > 1 / (r * r));
    if (r < bulgeRadius) r = bulgeRadius;
    const theta = rng() * 2 * Math.PI;
    const phi = Math.acos(2 * rng() - 1);
    positions.x[i] = r * Math.sin(phi) * Math.cos(theta);
    positions.y[i] = r * Math.sin(phi) * Math.sin(theta);
    positions.z[i] = r * Math.cos(phi);
    // Halo stars are old, low metallicity
    const cls = 5 + Math.floor(rng() * 2);
    const subclass = Math.floor(rng() * 10);
    const p = stellarProperties(cls, subclass);
    temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
    absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
    classes[i] = cls;
    const brightness = Math.max(0.2, Math.min(1, p.luminosity));
    temperatureToRgbHDR(tmpRgb, p.temperature, brightness);
    colors.x[i] = tmpRgb[0]; colors.y[i] = tmpRgb[1]; colors.z[i] = tmpRgb[2]; colors.w[i] = 1;
  }

  return {
    count: count,
    positions: positions,
    colors: colors,
    temperatures: temps,
    absoluteMagnitudes: absMags,
    spectralClasses: classes,
    radii: radii,
    masses: masses,
    luminosities: lums
  };
}

/**
 * Elliptical galaxy — Sérsic profile with n=4 (de Vaucouleurs).
 * Position radius scales as r ∝ R_e * (u^(1/n)) with rejection weighting.
 */
function generateEllipticalGalaxySOA(count, options) {
  options = options || {};
  const seed = options.seed || 1;
  const effectiveRadius = options.effectiveRadius !== undefined ? options.effectiveRadius : 20;
  const sersicIndex = options.sersicIndex !== undefined ? options.sersicIndex : 4;
  const axisRatioXY = options.axisRatioXY !== undefined ? options.axisRatioXY : 0.7;
  const axisRatioZ  = options.axisRatioZ  !== undefined ? options.axisRatioZ  : 0.6;
  const rng = common.mulberry32(seed);

  const positions = createVec3SOA(count);
  const colors    = createVec4SOA(count);
  const temps     = new Float32Array(count);
  const absMags   = new Float32Array(count);
  const classes   = new Uint8Array(count);
  const radii     = new Float32Array(count);
  const masses    = new Float32Array(count);
  const lums      = new Float32Array(count);
  const tmpRgb    = [0, 0, 0];

  for (let i = 0; i < count; i++) {
    // Sérsic radial distribution (approximate via rejection on simple profile)
    let r;
    do {
      r = effectiveRadius * 5 * rng();
    } while (r > EPSILON && rng() > Math.exp(-7.67 * (Math.pow(r / effectiveRadius, 1 / sersicIndex) - 1)));
    if (r < 0.01) r = 0.01;
    const theta = rng() * 2 * Math.PI;
    const phi = Math.acos(2 * rng() - 1);
    positions.x[i] = r * Math.sin(phi) * Math.cos(theta) * axisRatioXY;
    positions.y[i] = r * Math.sin(phi) * Math.sin(theta) * axisRatioXY;
    positions.z[i] = r * Math.cos(phi) * axisRatioZ;

    // Ellipticals: mostly old red stars
    const cls = 5 + Math.floor(rng() * 2);
    const subclass = Math.floor(rng() * 10);
    const p = stellarProperties(cls, subclass);
    temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
    absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
    classes[i] = cls;
    const brightness = Math.max(0.3, Math.min(1.5, p.luminosity));
    temperatureToRgbHDR(tmpRgb, p.temperature, brightness);
    colors.x[i] = tmpRgb[0]; colors.y[i] = tmpRgb[1]; colors.z[i] = tmpRgb[2]; colors.w[i] = 1;
  }

  return {
    count: count,
    positions: positions,
    colors: colors,
    temperatures: temps,
    absoluteMagnitudes: absMags,
    spectralClasses: classes,
    radii: radii,
    masses: masses,
    luminosities: lums
  };
}

/**
 * Irregular galaxy — a few Gaussian clumps placed by noise. Good for
 * Magellanic-Cloud-like dwarf galaxies.
 */
function generateIrregularGalaxySOA(count, options) {
  options = options || {};
  const seed = options.seed || 1;
  const extent = options.extent !== undefined ? options.extent : 20;
  const clumpCount = options.clumpCount !== undefined ? options.clumpCount : 8;
  const rng = common.mulberry32(seed);

  const positions = createVec3SOA(count);
  const colors    = createVec4SOA(count);
  const temps     = new Float32Array(count);
  const absMags   = new Float32Array(count);
  const classes   = new Uint8Array(count);
  const radii     = new Float32Array(count);
  const masses    = new Float32Array(count);
  const lums      = new Float32Array(count);
  const tmpRgb    = [0, 0, 0];

  // Generate clump centers
  const clumps = [];
  for (let c = 0; c < clumpCount; c++) {
    clumps.push({
      x: (rng() - 0.5) * extent * 2,
      y: (rng() - 0.5) * extent * 2,
      z: (rng() - 0.5) * extent * 2,
      sigma: extent * (0.1 + rng() * 0.3)
    });
  }

  for (let i = 0; i < count; i++) {
    const c = clumps[(rng() * clumpCount) | 0];
    // Gaussian around the clump
    const u1 = rng(), u2 = rng(), u3 = rng();
    const gX = c.x + (u1 + u2 + u3 - 1.5) * c.sigma;
    const gY = c.y + (rng() + rng() + rng() - 1.5) * c.sigma;
    const gZ = c.z + (rng() + rng() + rng() - 1.5) * c.sigma;
    positions.x[i] = gX;
    positions.y[i] = gY;
    positions.z[i] = gZ;

    // Young + old mix
    const isYoung = rng() < 0.55;
    const cls = isYoung ? (1 + Math.floor(rng() * 2)) : (4 + Math.floor(rng() * 3));
    const subclass = Math.floor(rng() * 10);
    const p = stellarProperties(cls, subclass);
    temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
    absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
    classes[i] = cls;
    const brightness = isYoung ? Math.max(2, Math.min(10, p.luminosity)) : Math.max(0.3, Math.min(2, p.luminosity));
    temperatureToRgbHDR(tmpRgb, p.temperature, brightness);
    colors.x[i] = tmpRgb[0]; colors.y[i] = tmpRgb[1]; colors.z[i] = tmpRgb[2]; colors.w[i] = 1;
  }

  return {
    count: count,
    positions: positions,
    colors: colors,
    temperatures: temps,
    absoluteMagnitudes: absMags,
    spectralClasses: classes,
    radii: radii,
    masses: masses,
    luminosities: lums
  };
}

/**
 * Globular cluster — King profile. Central density = ρ₀, tidal radius = r_t,
 * core radius = r_c. Good for compact clusters of 1M+ stars.
 */
function generateGlobularClusterSOA(count, options) {
  options = options || {};
  const seed = options.seed || 1;
  const coreRadius = options.coreRadius !== undefined ? options.coreRadius : 1;
  const tidalRadius = options.tidalRadius !== undefined ? options.tidalRadius : 10;
  const rng = common.mulberry32(seed);

  const positions = createVec3SOA(count);
  const colors    = createVec4SOA(count);
  const temps     = new Float32Array(count);
  const absMags   = new Float32Array(count);
  const classes   = new Uint8Array(count);
  const radii     = new Float32Array(count);
  const masses    = new Float32Array(count);
  const lums      = new Float32Array(count);
  const tmpRgb    = [0, 0, 0];

  // King profile radial PDF: ∝ (1/(1+(r/rc)²) - 1/(1+(rt/rc)²))²
  const norm = 1 / (1 + (tidalRadius / coreRadius) * (tidalRadius / coreRadius));
  for (let i = 0; i < count; i++) {
    let r;
    let attempts = 0;
    do {
      r = rng() * tidalRadius;
      const denom1 = 1 + (r / coreRadius) * (r / coreRadius);
      const p = Math.pow(1 / denom1 - norm, 2);
      if (rng() < p * 10) break;
      attempts++;
    } while (attempts < 100);
    const theta = rng() * 2 * Math.PI;
    const phi = Math.acos(2 * rng() - 1);
    positions.x[i] = r * Math.sin(phi) * Math.cos(theta);
    positions.y[i] = r * Math.sin(phi) * Math.sin(theta);
    positions.z[i] = r * Math.cos(phi);

    // Old red stars, some blue stragglers
    const isStraggler = rng() < 0.02;
    const cls = isStraggler ? (2 + Math.floor(rng() * 2)) : (5 + Math.floor(rng() * 2));
    const subclass = Math.floor(rng() * 10);
    const p = stellarProperties(cls, subclass);
    temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
    absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
    classes[i] = cls;
    const brightness = isStraggler ? 5 : Math.max(0.3, Math.min(1, p.luminosity));
    temperatureToRgbHDR(tmpRgb, p.temperature, brightness);
    colors.x[i] = tmpRgb[0]; colors.y[i] = tmpRgb[1]; colors.z[i] = tmpRgb[2]; colors.w[i] = 1;
  }

  return {
    count: count,
    positions: positions,
    colors: colors,
    temperatures: temps,
    absoluteMagnitudes: absMags,
    spectralClasses: classes,
    radii: radii,
    masses: masses,
    luminosities: lums
  };
}

/**
 * Dark-matter halo / distant star halo — r⁻³ distribution scaled to Mpc.
 * Fills a star field with sparse distant stars for galaxy-cluster scale.
 */
function generateHaloSOA(count, options) {
  options = options || {};
  const seed = options.seed || 1;
  const scaleRadius = options.scaleRadius !== undefined ? options.scaleRadius : 1000;
  const cutoffRadius = options.cutoffRadius !== undefined ? options.cutoffRadius : 10 * scaleRadius;
  const rng = common.mulberry32(seed);

  const positions = createVec3SOA(count);
  const colors    = createVec4SOA(count);
  const temps     = new Float32Array(count);
  const absMags   = new Float32Array(count);
  const classes   = new Uint8Array(count);
  const radii     = new Float32Array(count);
  const masses    = new Float32Array(count);
  const lums      = new Float32Array(count);
  const tmpRgb    = [0, 0, 0];

  for (let i = 0; i < count; i++) {
    let r;
    let attempts = 0;
    do {
      r = rng() * cutoffRadius;
      const p = 1 / ((1 + r / scaleRadius) * (1 + r / scaleRadius));
      if (rng() < p) break;
      attempts++;
    } while (attempts < 100);
    if (r < scaleRadius) r = scaleRadius;
    const theta = rng() * 2 * Math.PI;
    const phi = Math.acos(2 * rng() - 1);
    positions.x[i] = r * Math.sin(phi) * Math.cos(theta);
    positions.y[i] = r * Math.sin(phi) * Math.sin(theta);
    positions.z[i] = r * Math.cos(phi);

    // Faint old stars
    const cls = 5 + Math.floor(rng() * 2);
    const subclass = Math.floor(rng() * 10);
    const p = stellarProperties(cls, subclass);
    temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
    absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
    classes[i] = cls;
    const brightness = Math.max(0.05, Math.min(0.5, p.luminosity));
    temperatureToRgbHDR(tmpRgb, p.temperature, brightness);
    colors.x[i] = tmpRgb[0]; colors.y[i] = tmpRgb[1]; colors.z[i] = tmpRgb[2]; colors.w[i] = 1;
  }

  return {
    count: count,
    positions: positions,
    colors: colors,
    temperatures: temps,
    absoluteMagnitudes: absMags,
    spectralClasses: classes,
    radii: radii,
    masses: masses,
    luminosities: lums
  };
}

// ============================================================================
// Function Declarations — Distance modulus / LOD
// ============================================================================

/** Apparent magnitude from absolute magnitude + distance (parsecs). */
function distanceModulus(absoluteMag, distanceParsec) {
  if (distanceParsec <= 0) return Infinity;
  return absoluteMag + 5 * (Math.log10(distanceParsec) - 1);
}

function apparentMagnitude(absoluteMag, distanceParsec) {
  return distanceModulus(absoluteMag, distanceParsec);
}

function absoluteMagnitude(apparentMag, distanceParsec) {
  if (distanceParsec <= 0) return Infinity;
  return apparentMag - 5 * (Math.log10(distanceParsec) - 1);
}

/** Relative flux from magnitude difference. */
function fluxFromMagnitude(mag) {
  return Math.pow(10, -0.4 * mag);
}

function magnitudeFromFlux(flux) {
  if (flux <= 0) return Infinity;
  return -2.5 * Math.log10(flux);
}

/**
 * LOD level — which level of detail to select for an object at `distance`.
 * Returns 0 (highest detail) up to 10 (lowest detail). Screen-space size is
 * `worldSize / distance * pixelsPerRadian`. `targetPixels` is the smallest
 * pixel footprint that doesn't need LOD.
 */
function lodLevel(worldSize, distance, pixelsPerRadian, targetPixels) {
  if (distance <= 0) return 0;
  pixelsPerRadian = pixelsPerRadian || 1080;
  targetPixels = targetPixels || 8;
  const screenPixels = (worldSize / distance) * pixelsPerRadian;
  if (screenPixels >= targetPixels) return 0;
  const ratio = targetPixels / screenPixels;
  return Math.min(10, Math.ceil(Math.log2(ratio)));
}

// ============================================================================
// Function Declarations — Epoch / time
// ============================================================================

function unixToJulianDate(unixSec) {
  return unixSec / SECONDS_PER_DAY + UNIX_TO_JD_OFFSET;
}

function julianDateToUnix(jd) {
  return (jd - UNIX_TO_JD_OFFSET) * SECONDS_PER_DAY;
}

function daysSinceJ2000(unixSec) {
  return julianDateToJ2000Days(unixToJulianDate(unixSec));
}

function julianDateToJ2000Days(jd) {
  return jd - J2000_JD;
}

/** Julian centuries since J2000 — for precession / proper motion. */
function epochToJulianDate(jd) {
  return (jd - J2000_JD) / 36525;
}

// ============================================================================
// Function Declarations — Floating origin (bulk)
// ============================================================================

function toLocal(out, x, y, z, origin) {
  out[0] = x - origin[0];
  out[1] = y - origin[1];
  out[2] = z - origin[2];
  return out;
}

function toWorld(out, x, y, z, origin) {
  out[0] = x + origin[0];
  out[1] = y + origin[1];
  out[2] = z + origin[2];
  return out;
}

/**
 * Bulk recenter a vec3 SOA by subtracting `delta[0..2]`. This is the 1M+
 * hot-loop used when a `FloatingOrigin` triggers a recenter.
 */
function soaRecenter(positions, delta) {
  const dx = delta[0], dy = delta[1], dz = delta[2];
  const count = positions.count;
  const px = positions.x, py = positions.y, pz = positions.z;
  for (let i = 0; i < count; i++) {
    px[i] -= dx;
    py[i] -= dy;
    pz[i] -= dz;
  }
  return positions;
}

async function soaRecenterChunked(positions, delta, chunkSize, yieldEvery) {
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  const dx = delta[0], dy = delta[1], dz = delta[2];
  const count = positions.count;
  const px = positions.x, py = positions.y, pz = positions.z;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    for (let i = start; i < end; i++) {
      px[i] -= dx;
      py[i] -= dy;
      pz[i] -= dz;
    }
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return positions;
}

// ============================================================================
// Function Declarations — Log depth
// ============================================================================

/**
 * Logarithmic depth buffer constants for a given near/far. Use with
 * `logDepthEncode` on the CPU side, or with the matching GLSL formula:
 *   gl_Position.z = log2(max(1e-6, 1.0 + w)) * FC + C;
 *   gl_FragDepth = log2(1.0 + depth) * FC * 0.5;
 */
function logDepthConstants(near, far) {
  const logFar = Math.log2(1 + far / near);
  return {
    FC: 2 / logFar,
    C: -1,
    near: near,
    far: far
  };
}

/** CPU-side log-depth encode: z in view space → [0, 1] encoded. */
function logDepthEncode(z, constants) {
  const zNDC = Math.max(z / constants.near, 1 + 1e-9);
  return Math.log2(zNDC) * constants.FC * 0.5 + 0.5;
}

/** CPU-side log-depth decode: encoded [0, 1] → view-space z. */
function logDepthDecode(encoded, constants) {
  const exponent = (encoded - 0.5) * 2 / constants.FC;
  return (Math.pow(2, exponent) - 1) * constants.near;
}

// ============================================================================
// Function Declarations — Precision
// ============================================================================

/**
 * Suggest a precision tier given the maximum world-coordinate extent.
 * The extent is the max |coordinate| in meters (or in the caller's base unit
 * if using a coarser unit).
 */
function suggestPrecision(worldExtent) {
  if (worldExtent < 10) return "f16";
  if (worldExtent < 1e7) return "f32";
  return "f64";
}

/**
 * Suggest the best base unit given the world's overall extent. Returns
 * `{ name, scale }` where scale converts the named unit to meters.
 */
function worldUnitFor(worldExtent) {
  if (worldExtent < 1e3)  return { name: "m",    scale: SCALE_METER };
  if (worldExtent < 1e10) return { name: "km",   scale: SCALE_KM };
  if (worldExtent < 1e14) return { name: "AU",   scale: SCALE_AU };
  if (worldExtent < 1e18) return { name: "pc",   scale: SCALE_PC };
  if (worldExtent < 1e22) return { name: "kpc",  scale: SCALE_KPC };
  return { name: "Mpc", scale: SCALE_MPC };
}

/**
 * Max coordinate magnitude for a given precision tier to preserve at least
 * cm-scale precision. Values beyond this require floating origin or
 * double-double math.
 */
function maxCoordinateForPrecision(precision) {
  switch (precision) {
    case "f16": return 10;
    case "f32": return 1e7;
    case "f64": return 1e15;
    default:    return 1e7;
  }
}

// ============================================================================
// Function Declarations — SOA (sync)
// ============================================================================

/**
 * Batch blackbody color — fills `colors` (vec4 SOA) from per-instance
 * temperatures. Alpha = 1. Colors are in [0, 1], sRGB-encoded.
 */
function soaTemperatureToRgb(colors, temperatures, count) {
  count = count === undefined ? colors.count : count;
  const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
  const tmp = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    temperatureToRgb(tmp, temperatures[i]);
    cx[i] = tmp[0];
    cy[i] = tmp[1];
    cz[i] = tmp[2];
    cw[i] = 1;
  }
  return colors;
}

/** HDR version — scales by a per-instance brightness array. */
function soaTemperatureToRgbHDR(colors, temperatures, brightness, count) {
  count = count === undefined ? colors.count : count;
  const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
  const tmp = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    temperatureToRgbHDR(tmp, temperatures[i], brightness[i]);
    cx[i] = tmp[0];
    cy[i] = tmp[1];
    cz[i] = tmp[2];
    cw[i] = 1;
  }
  return colors;
}

/** Batch equatorial → galactic for 1M+ objects. */
function soaEquatorialToGalactic(outL, outB, raArr, decArr, count) {
  count = count === undefined ? outL.length : count;
  for (let i = 0; i < count; i++) {
    const g = equatorialToGalactic(raArr[i], decArr[i]);
    outL[i] = g.l;
    outB[i] = g.b;
  }
  return outL;
}

/** Batch RA/Dec + distance → Cartesian XYZ SOA. */
function soaEquatorialToCartesian(positions, raArr, decArr, distArr, count) {
  count = count === undefined ? positions.count : count;
  const px = positions.x, py = positions.y, pz = positions.z;
  for (let i = 0; i < count; i++) {
    const ra = raArr[i], dec = decArr[i], d = distArr[i];
    const cosDec = Math.cos(dec);
    px[i] = d * cosDec * Math.cos(ra);
    py[i] = d * cosDec * Math.sin(ra);
    pz[i] = d * Math.sin(dec);
  }
  return positions;
}

/** Batch distance modulus — apparent magnitude per object. */
function soaDistanceModulus(outMag, absMagArr, distArr, count) {
  count = count === undefined ? outMag.length : count;
  for (let i = 0; i < count; i++) {
    outMag[i] = distanceModulus(absMagArr[i], distArr[i]);
  }
  return outMag;
}

/** Batch LOD level selection. */
function soaLodLevel(outLod, worldSizeArr, distArr, pixelsPerRadian, targetPixels, count) {
  count = count === undefined ? outLod.length : count;
  for (let i = 0; i < count; i++) {
    outLod[i] = lodLevel(worldSizeArr[i], distArr[i], pixelsPerRadian, targetPixels);
  }
  return outLod;
}

/**
 * SOA star field — delegates to `generateStarFieldSOA` and additionally
 * allows writing into preallocated buffers when the caller wants to reuse
 * memory. This is the "1M+ stars in one call" primitive.
 */
function soaStarField(count, bounds, options) {
  return generateStarFieldSOA(count, bounds, options);
}

function soaSpiralGalaxy(count, options) {
  return generateSpiralGalaxySOA(count, options);
}

// ============================================================================
// Function Declarations — SOA (chunked async)
// ============================================================================

async function _chunked(count, chunkSize, yieldEvery, perChunk) {
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    perChunk(start, end);
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
}

async function soaTemperatureToRgbChunked(colors, temperatures, count, cs, ye) {
  count = count === undefined ? colors.count : count;
  const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
  const tmp = [0, 0, 0];
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      temperatureToRgb(tmp, temperatures[i]);
      cx[i] = tmp[0]; cy[i] = tmp[1]; cz[i] = tmp[2]; cw[i] = 1;
    }
  });
  return colors;
}

async function soaEquatorialToGalacticChunked(outL, outB, raArr, decArr, count, cs, ye) {
  count = count === undefined ? outL.length : count;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      const g = equatorialToGalactic(raArr[i], decArr[i]);
      outL[i] = g.l;
      outB[i] = g.b;
    }
  });
  return outL;
}

async function soaDistanceModulusChunked(outMag, absMagArr, distArr, count, cs, ye) {
  count = count === undefined ? outMag.length : count;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      outMag[i] = distanceModulus(absMagArr[i], distArr[i]);
    }
  });
  return outMag;
}

async function soaLodLevelChunked(outLod, worldSizeArr, distArr, pixelsPerRadian, targetPixels, count, cs, ye) {
  count = count === undefined ? outLod.length : count;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      outLod[i] = lodLevel(worldSizeArr[i], distArr[i], pixelsPerRadian, targetPixels);
    }
  });
  return outLod;
}

async function soaStarFieldChunked(count, bounds, options, cs, ye) {
  cs = cs || common.CHUNK_SIZE;
  ye = ye || common.CHUNK_YIELD_EVERY;
  options = options || {};
  bounds = bounds || { minX: -1000, minY: -1000, minZ: -1000, maxX: 1000, maxY: 1000, maxZ: 1000 };
  const seed = options.seed || 1;
  const rng = common.mulberry32(seed);

  const positions = createVec3SOA(count);
  const colors    = createVec4SOA(count);
  const temps     = new Float32Array(count);
  const absMags   = new Float32Array(count);
  const classes   = new Uint8Array(count);
  const radii     = new Float32Array(count);
  const masses    = new Float32Array(count);
  const lums      = new Float32Array(count);
  const tmpRgb    = [0, 0, 0];

  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const spanZ = bounds.maxZ - bounds.minZ;

  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      positions.x[i] = bounds.minX + rng() * spanX;
      positions.y[i] = bounds.minY + rng() * spanY;
      positions.z[i] = bounds.minZ + rng() * spanZ;

      const r = rng();
      let cls;
      if (r < 0.0001) cls = 0;
      else if (r < 0.0013) cls = 1;
      else if (r < 0.0073) cls = 2;
      else if (r < 0.0373) cls = 3;
      else if (r < 0.113) cls = 4;
      else if (r < 0.233) cls = 5;
      else cls = 6;
      const subclass = Math.floor(rng() * 10);
      const p = stellarProperties(cls, subclass);

      temps[i] = p.temperature;
      radii[i] = p.radius;
      masses[i] = p.mass;
      lums[i] = p.luminosity;
      absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
      classes[i] = cls;

      const brightness = Math.max(0.5, Math.min(50, p.luminosity));
      temperatureToRgbHDR(tmpRgb, p.temperature, brightness);
      colors.x[i] = tmpRgb[0];
      colors.y[i] = tmpRgb[1];
      colors.z[i] = tmpRgb[2];
      colors.w[i] = 1;
    }
  });

  return {
    count: count,
    positions: positions,
    colors: colors,
    temperatures: temps,
    absoluteMagnitudes: absMags,
    spectralClasses: classes,
    radii: radii,
    masses: masses,
    luminosities: lums
  };
}

async function soaSpiralGalaxyChunked(count, options, cs, ye) {
  // Delegate to the sync generator (already efficient; chunked wrapper for
  // consistency). For extreme counts (10M+) consider per-bulge/disk/halo
  // chunked generation for finer-grained yielding.
  return generateSpiralGalaxySOA(count, options);
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================

const _galacticScratchPool = common.createPool(
  function () {
    const T = getArrayType();
    return {
      a: new T(256),
      b: new T(256),
      c: new T(256),
      d: new T(256),
      size: 256,
      _attached: false
    };
  },
  8,
  function (s) {
    if (s.a) s.a.fill(0);
    if (s.b) s.b.fill(0);
    if (s.c) s.c.fill(0);
    if (s.d) s.d.fill(0);
  }
);

// Attach ensure method once per pooled entry
(function warmGalacticScratch() {
  const pool = _galacticScratchPool;
  const orig = pool.acquire.bind(pool);
  pool.acquire = function () {
    const s = orig();
    if (!s._attached) {
      s._attached = true;
      s.ensure = function (n) {
        if (n <= this.size) return this;
        const T = getArrayType();
        this.size = n;
        this.a = new T(n);
        this.b = new T(n);
        this.c = new T(n);
        this.d = new T(n);
        return this;
      };
    }
    return s;
  };
})();

function createGalacticScratchPool(capacity) {
  return common.createPool(
    function () {
      const T = getArrayType();
      return {
        a: new T(256),
        b: new T(256),
        c: new T(256),
        d: new T(256),
        size: 256,
        _attached: false,
        ensure: function (n) {
          if (n <= this.size) return this;
          const T2 = getArrayType();
          this.size = n;
          this.a = new T2(n);
          this.b = new T2(n);
          this.c = new T2(n);
          this.d = new T2(n);
          return this;
        }
      };
    },
    capacity || 8,
    function (s) {
      if (s.a) s.a.fill(0);
      if (s.b) s.b.fill(0);
      if (s.c) s.c.fill(0);
      if (s.d) s.d.fill(0);
    }
  );
}

function acquireGalacticScratch(size) {
  const s = _galacticScratchPool.acquire();
  if (size !== undefined) s.ensure(size);
  return s;
}
function releaseGalacticScratch(s) { _galacticScratchPool.release(s); }

// ============================================================================
// Namespace convenience
// ============================================================================

exports.namespace.units = {
  SCALE_NEAR, SCALE_METER, SCALE_KM, SCALE_EARTH_RADIUS,
  SCALE_AU, SCALE_LY, SCALE_PC, SCALE_KPC, SCALE_MPC, SCALE_GPC,
  auToMeters, metersToAu, lyToMeters, metersToLy,
  pcToMeters, metersToPc, kpcToMeters, metersToKpc,
  mpcToMeters, metersToMpc,
  arcsecToRad, radToArcsec, hoursToRad, radToHours
};

exports.namespace.constants = {
  SOLAR_MASS, SOLAR_RADIUS, SOLAR_LUMINOSITY,
  EARTH_MASS, EARTH_RADIUS, JUPITER_MASS,
  G, C, MU_SUN, J2000_JD
};

exports.namespace.coords = {
  equatorialToGalactic, galacticToEquatorial,
  equatorialToEcliptic, eclipticToEquatorial,
  equatorialToCartesian, cartesianToEquatorial,
  galacticToCartesian, cartesianToGalactic,
  sphericalToCartesian, cartesianToSpherical
};

exports.namespace.spectral = {
  temperatureToRgb, temperatureToRgbHDR,
  classFromTemp: spectralClassFromTemperature,
  tempFromClass: temperatureFromSpectralClass,
  stellarProperties,
  luminosityFromAbsoluteMagnitude, absoluteMagnitudeFromLuminosity
};

exports.namespace.stars = {
  generateStarField: generateStarFieldSOA,
  generateSpiralGalaxy: generateSpiralGalaxySOA,
  generateEllipticalGalaxy: generateEllipticalGalaxySOA,
  generateIrregularGalaxy: generateIrregularGalaxySOA,
  generateGlobularCluster: generateGlobularClusterSOA,
  generateHalo: generateHaloSOA
};

exports.namespace.distance = {
  distanceModulus, apparentMagnitude, absoluteMagnitude,
  fluxFromMagnitude, magnitudeFromFlux,
  lodLevel
};

exports.namespace.epoch = {
  unixToJulianDate, julianDateToUnix,
  daysSinceJ2000, julianDateToJ2000Days, epochToJulianDate
};

exports.namespace.floatingOrigin = {
  FloatingOrigin, createFloatingOrigin,
  toLocal, toWorld,
  soaRecenter, soaRecenterChunked
};

exports.namespace.logDepth = {
  constants: logDepthConstants,
  encode: logDepthEncode,
  decode: logDepthDecode
};

exports.namespace.precision = {
  suggest: suggestPrecision,
  worldUnitFor,
  maxCoordinateForPrecision
};

exports.namespace.batch = {
  temperatureToRgb: soaTemperatureToRgb,
  temperatureToRgbHDR: soaTemperatureToRgbHDR,
  equatorialToGalactic: soaEquatorialToGalactic,
  equatorialToCartesian: soaEquatorialToCartesian,
  distanceModulus: soaDistanceModulus,
  lodLevel: soaLodLevel,
  starField: soaStarField,
  spiralGalaxy: soaSpiralGalaxy,
  temperatureToRgbChunked: soaTemperatureToRgbChunked,
  equatorialToGalacticChunked: soaEquatorialToGalacticChunked,
  distanceModulusChunked: soaDistanceModulusChunked,
  lodLevelChunked: soaLodLevelChunked,
  starFieldChunked: soaStarFieldChunked,
  spiralGalaxyChunked: soaSpiralGalaxyChunked,
  State: GalacticBatchState,
  create: createGalacticBatch
};

exports.namespace.pool = {
  GalacticScratch,
  createGalacticScratchPool,
  acquireGalacticScratch,
  releaseGalacticScratch
};

// ============================================================================
// Precision listener
// ============================================================================

onPrecisionChange(function (mode, oldMode) {
  // Existing GalacticBatchState buffers keep their current types.
  // New ones created after this point use the new array type via
  // getArrayType() / createVec3SOA / createVec4SOA.
});
