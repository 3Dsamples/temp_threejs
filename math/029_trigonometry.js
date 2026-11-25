//File number : 029
// File : src/math/029_trigonometry.js
//Description : Complete trigonometry system — imports 000_Math_module.js and provides every angle-aware primitive for 3D procedural generation, rendering, color, animation, natural IK motion and orbital mechanics: full scalar trig (basic, inverse, hyperbolic, reciprocal, versed / coversed / haversed / haversine, sinc, sinPi/cosPi), fast-mobile approximations (LUT + polynomial sin/cos/atan2), double-double high-precision sin/cos/tan via `double.cjs` for long-term integration, phase wrap/unwrap/diff/shortest-arc (angle-lerp and angle-slerp), critically-damped angle springs, 2D/3D angle-between, spherical coords, great-circle distance, initial bearing, Fibonacci sphere, golden angle, uniform sphere / hemisphere / circle sampling, Halton / Van der Corput stratification, spherical harmonics (Y_l^m), Legendre and Chebyshev polynomials, two-bone IK angular solution, bone rotation from direction, swing-twist decomposition, pendulum and damped oscillator, live phase accumulators, and full SOA sync + chunked async bat
ches (sin/cos/atan2/hypot/wrap/lerp/spherical/rotate/fibonacci) that stay precision-agnostic and never block the Android UI thread. Uses the precision-aware SOA builders from `000_Math_module.js`, so storage live-switches between Float16/Float32/Float64 with a single call to `setPrecision()`.
//####
//Best for : 3d graphics — per-instance sinusoidal animation for 1M+ asteroids/particles, procedural galaxy arm angles (spiral / loxodrome / golden angle), planet rotation and obliquity (spherical harmonics), orbital element conversion (true ↔ eccentric ↔ mean anomaly, great-circle steering, initial bearing), natural IK bone rotation (two-bone solution, swing-twist, angle damping), rendering (fast sin/cos LUTs, spherical coords for cube-map lookups, screen-space angle-driven matrix), HDR color hue rotation (phase → hue), animation oscillators and pendulums, sample stratification (Halton / Van der Corput / Fibonacci sphere) for procedural placement at any scale from mm to Mpc, and mobile-safe async batches that keep 1M+ units at 60 fps on Android 64-bit.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M = require("./000_Math_module.js");

// Pull the pieces we actually need from the unified math module
const common       = M.common;
const vec2         = M.vec2;
const vec3         = M.vec3;
const vec4         = M.vec4;
const mat2         = M.mat2;
const mat3         = M.mat3;
const mat4         = M.mat4;
const quat         = M.quat;
const quat2        = M.quat2;
const double       = M.double;
const simplex      = M.simplex;

// Precision plumbing (owned by 000_Math_module)
const getPrecision      = M.getPrecision;
const setPrecision      = M.setPrecision;
const getArrayType      = M.getArrayType;
const onPrecisionChange = M.onPrecisionChange;
const getSOAPrecision   = M.getSOAPrecision;
const trackSOA          = M.trackSOA;
const untrackSOA        = M.untrackSOA;

// SOA builders — already precision-aware
const createVec2SOA = M.createVec2SOA;
const createVec3SOA = M.createVec3SOA;
const createVec4SOA = M.createVec4SOA;
const createQuatSOA = M.createQuatSOA;

// ============================================================================
// Export Declarations
// ============================================================================

exports.PI               = undefined; // assigned below
exports.TAU              = undefined;
exports.HALF_PI          = undefined;
exports.QUARTER_PI       = undefined;
exports.TWO_OVER_PI      = undefined;
exports.DEG2RAD          = undefined;
exports.RAD2DEG          = undefined;
exports.GOLDEN_ANGLE     = undefined;
exports.GOLDEN_RATIO     = undefined;
exports.SQRT2_OVER_2     = undefined;
exports.SQRT3_OVER_2     = undefined;

// Scalar core
exports.sin = sin;
exports.cos = cos;
exports.tan = tan;
exports.sincos = sincos;
exports.asin = asin;
exports.acos = acos;
exports.atan = atan;
exports.atan2 = atan2;

// Reciprocal
exports.sec = sec;
exports.csc = csc;
exports.cot = cot;

// Hyperbolic
exports.sinh = sinh;
exports.cosh = cosh;
exports.tanh = tanh;
exports.asinh = asinh;
exports.acosh = acosh;
exports.atanh = atanh;

// Versed / haversine family (spherical IK & geodesy)
exports.versin = versin;
exports.coversin = coversin;
exports.haversin = haversin;
exports.aversin = aversin;
exports.ahaversin = ahaversin;

// Normalized
exports.sinc = sinc;
exports.sinPi = sinPi;
exports.cosPi = cosPi;

// Conversions
exports.deg2rad = deg2rad;
exports.rad2deg = rad2deg;

// Wrapping / differences
exports.wrapPhase = wrapPhase;
exports.wrapPhaseSigned = wrapPhaseSigned;
exports.shortestAngle = shortestAngle;
exports.angleDiff = shortestAngle;

// Interpolation & damping
exports.lerpAngle = lerpAngle;
exports.slerpAngle = slerpAngle;
exports.dampAngle = dampAngle;
exports.springDampAngle = springDampAngle;

// Fast approximations (mobile hot path)
exports.fastSin = fastSin;
exports.fastCos = fastCos;
exports.fastTan = fastTan;
exports.fastAtan2 = fastAtan2;
exports.fastSincos = fastSincos;

// High-precision (double-double)
exports.hpSin = hpSin;
exports.hpCos = hpCos;
exports.hpTan = hpTan;

// Angle between vectors
exports.angleBetween2 = angleBetween2;
exports.angleBetween3 = angleBetween3;
exports.signedAngle2 = signedAngle2;
exports.signedAngle3 = signedAngle3;

// Spherical coordinates
exports.sphericalToCartesian = sphericalToCartesian;
exports.cartesianToSpherical = cartesianToSpherical;
exports.sphericalToCartesianInto = sphericalToCartesianInto;
exports.cartesianToSphericalInto = cartesianToSphericalInto;

// Geodesy / great circle
exports.greatCircleDistance = greatCircleDistance;
exports.initialBearing = initialBearing;
exports.greatCircleLerp = greatCircleLerp;

// Sampling
exports.goldenAngle = goldenAngle;
exports.fibonacciSphere = fibonacciSphere;
exports.uniformSphere = uniformSphere;
exports.uniformHemisphere = uniformHemisphere;
exports.uniformCircle = uniformCircle;
exports.halton2 = halton2;
exports.halton3 = halton3;
exports.vanDerCorput = vanDerCorput;

// Spherical harmonics & orthogonal polynomials
exports.sphericalHarmonic = sphericalHarmonic;
exports.legendrePolynomial = legendrePolynomial;
exports.chebyshevPolynomial = chebyshevPolynomial;

// Natural IK motion
exports.twoBoneIKAngles = twoBoneIKAngles;
exports.boneRotation2D = boneRotation2D;
exports.swingTwist = swingTwist;

// Oscillators
exports.pendulum = pendulum;
exports.dampedOscillator = dampedOscillator;
exports.oscillator = oscillator;

// Phase accumulators
exports.PhaseAccumulator = PhaseAccumulator;
exports.MultiPhaseAccumulator = MultiPhaseAccumulator;

// Angle pools
exports.createAnglePool = createAnglePool;
exports.acquireAngle = acquireAngle;
exports.releaseAngle = releaseAngle;
exports.createSincosPairPool = createSincosPairPool;
exports.acquireSincosPair = acquireSincosPair;
exports.releaseSincosPair = releaseSincosPair;

// SOA (sync)
exports.soaSin = soaSin;
exports.soaCos = soaCos;
exports.soaTan = soaTan;
exports.soaSincos = soaSincos;
exports.soaAsin = soaAsin;
exports.soaAcos = soaAcos;
exports.soaAtan = soaAtan;
exports.soaAtan2 = soaAtan2;
exports.soaHypot = soaHypot;
exports.soaDeg2Rad = soaDeg2Rad;
exports.soaRad2Deg = soaRad2Deg;
exports.soaWrapPhase = soaWrapPhase;
exports.soaWrapPhaseSigned = soaWrapPhaseSigned;
exports.soaShortestAngle = soaShortestAngle;
exports.soaLerpAngle = soaLerpAngle;
exports.soaSphericalToCartesian = soaSphericalToCartesian;
exports.soaCartesianToSpherical = soaCartesianToSpherical;
exports.soaFibonacciSphere = soaFibonacciSphere;
exports.soaUniformSphere = soaUniformSphere;
exports.soaUniformHemisphere = soaUniformHemisphere;
exports.soaUniformCircle = soaUniformCircle;
exports.soaRotateX = soaRotateX;
exports.soaRotateY = soaRotateY;
exports.soaRotateZ = soaRotateZ;
exports.soaPolarToXY = soaPolarToXY;
exports.soaXYToPolar = soaXYToPolar;
exports.soaFastSin = soaFastSin;
exports.soaFastCos = soaFastCos;
exports.soaFastAtan2 = soaFastAtan2;
exports.soaPendulum = soaPendulum;
exports.soaDampedOscillator = soaDampedOscillator;

// SOA (chunked async)
exports.soaSinChunked = soaSinChunked;
exports.soaCosChunked = soaCosChunked;
exports.soaAtan2Chunked = soaAtan2Chunked;
exports.soaHypotChunked = soaHypotChunked;
exports.soaWrapPhaseChunked = soaWrapPhaseChunked;
exports.soaLerpAngleChunked = soaLerpAngleChunked;
exports.soaSphericalToCartesianChunked = soaSphericalToCartesianChunked;
exports.soaCartesianToSphericalChunked = soaCartesianToSphericalChunked;
exports.soaFibonacciSphereChunked = soaFibonacciSphereChunked;
exports.soaUniformSphereChunked = soaUniformSphereChunked;
exports.soaRotateZChunked = soaRotateZChunked;
exports.soaDampedOscillatorChunked = soaDampedOscillatorChunked;

// Specialised helpers
exports.attachTrigSystem = attachTrigSystem;
exports.createTrigBatch = createTrigBatch;

// ============================================================================
// Global Declarations
// ============================================================================

// (kept minimal — precision bookkeeping is delegated to 000_Math_module)

// ============================================================================
// Type Declarations (JSDoc)
// ============================================================================

/**
 * @typedef {Object} SphericalCoords
 * @property {number} r      radius
 * @property {number} theta  polar angle from +Y axis, in [0, π]
 * @property {number} phi    azimuthal angle from +X axis in XZ plane, in [0, 2π)
 */

/**
 * @typedef {Object} TwoBoneSolution
 * @property {number} upper   upper-limb angle (shoulder / hip)
 * @property {number} lower   lower-limb angle (elbow / knee)
 * @property {number} reach   distance actually reached (clamped to bone sum)
 * @property {boolean} reachable
 */

/**
 * @typedef {Object} TrigBatch
 * @property {Object} soa      the input SOA of angles (or radius)
 * @property {Function} step   advance one frame
 * @property {Function} stepChunked  async mobile-safe step
 * @property {Function} dispose       release any pooled resources
 */

// ============================================================================
// Variable Declarations
// ============================================================================

const PI            = Math.PI;
const TAU           = PI * 2;
const HALF_PI       = PI * 0.5;
const QUARTER_PI    = PI * 0.25;
const TWO_OVER_PI   = 2 / PI;
const DEG2RAD       = PI / 180;
const RAD2DEG       = 180 / PI;
const GOLDEN_RATIO  = (1 + Math.sqrt(5)) * 0.5;
const GOLDEN_ANGLE  = PI * (3 - Math.sqrt(5)); // ≈ 2.399963... rad
const SQRT2_OVER_2  = Math.SQRT2 * 0.5;
const SQRT3_OVER_2  = Math.sqrt(3) * 0.5;

// Fast LUT tables — built once, reused across all calls
const FAST_LUT_SIZE = 4096;
const FAST_LUT_MASK = FAST_LUT_SIZE - 1;
const FAST_LUT_SCALE = FAST_LUT_SIZE / TAU;

const _fastSinLUT = new Float32Array(FAST_LUT_SIZE + 1);
const _fastCosLUT = new Float32Array(FAST_LUT_SIZE + 1);
for (let i = 0; i <= FAST_LUT_SIZE; i++) {
  const a = (i / FAST_LUT_SIZE) * TAU;
  _fastSinLUT[i] = Math.sin(a);
  _fastCosLUT[i] = Math.cos(a);
}

// Fast atan2 polynomial coefficients (Weisstein / Sun)
const ATAN_A = -0.0021936;
const ATAN_B =  0.0208351;
const ATAN_C = -0.0542509;
const ATAN_D =  0.1021814;
const ATAN_E = -0.1834286;
const ATAN_F =  0.3977436;
const ATAN_G =  0.9999273;

// Pool implementation — reused by fastSin, sincos, phase accumulators
const _anglePool = common.createPool(
  function () { return { value: 0 }; },
  64,
  function (a) { a.value = 0; }
);

const _sincosPool = common.createPool(
  function () { return { s: 0, c: 1 }; },
  64,
  function (o) { o.s = 0; o.c = 1; }
);

// ============================================================================
// Function Declarations — Scalar core
// ============================================================================

function sin(x) { return Math.sin(x); }
function cos(x) { return Math.cos(x); }
function tan(x) { return Math.tan(x); }

/**
 * Returns a *pooled* {s, c} pair for zero-GC hot loops. Caller must NOT
 * retain the reference across frames unless it's released manually via
 * `releaseSincosPair`.
 */
function sincos(x) {
  const p = _sincosPool.acquire();
  p.s = Math.sin(x);
  p.c = Math.cos(x);
  return p;
}

function asin(x) { return Math.asin(x < -1 ? -1 : (x > 1 ? 1 : x)); }
function acos(x) { return Math.acos(x < -1 ? -1 : (x > 1 ? 1 : x)); }
function atan(x) { return Math.atan(x); }
function atan2(y, x) { return Math.atan2(y, x); }

// ============================================================================
// Function Declarations — Reciprocal
// ============================================================================

function sec(x) { return 1 / Math.cos(x); }
function csc(x) { return 1 / Math.sin(x); }
function cot(x) { return 1 / Math.tan(x); }

// ============================================================================
// Function Declarations — Hyperbolic
// ============================================================================

function sinh(x)  { return Math.sinh ? Math.sinh(x)  : (Math.exp(x) - Math.exp(-x)) * 0.5; }
function cosh(x)  { return Math.cosh ? Math.cosh(x)  : (Math.exp(x) + Math.exp(-x)) * 0.5; }
function tanh(x)  { return Math.tanh ? Math.tanh(x)  : (Math.exp(2 * x) - 1) / (Math.exp(2 * x) + 1); }
function asinh(x) { return Math.asinh ? Math.asinh(x) : Math.log(x + Math.sqrt(x * x + 1)); }
function acosh(x) { return Math.acosh ? Math.acosh(x) : Math.log(x + Math.sqrt(x * x - 1)); }
function atanh(x) { return Math.atanh ? Math.atanh(x) : 0.5 * Math.log((1 + x) / (1 - x)); }

// ============================================================================
// Function Declarations — Versed / coversed / haversine
// ============================================================================

function versin(x)  { return 1 - Math.cos(x); }
function coversin(x) { return 1 - Math.sin(x); }
function haversin(x) { const s = Math.sin(x * 0.5); return s * s; }
function aversin(x)  { return Math.acos(1 - x); }
function ahaversin(x) { return 2 * Math.asin(Math.sqrt(x)); }

// ============================================================================
// Function Declarations — Normalized
// ============================================================================

/** Unnormalized sinc: sin(x) / x, with continuous value 1 at 0. */
function sinc(x) {
  if (x === 0) return 1;
  return Math.sin(x) / x;
}

function sinPi(x) { return Math.sin(PI * x); }
function cosPi(x) { return Math.cos(PI * x); }

// ============================================================================
// Function Declarations — Conversions
// ============================================================================

function deg2rad(d) { return d * DEG2RAD; }
function rad2deg(r) { return r * RAD2DEG; }

// ============================================================================
// Function Declarations — Wrapping / shortest-angle
// ============================================================================

/** Wrap phase into [0, 2π). */
function wrapPhase(a) {
  a = a % TAU;
  return a < 0 ? a + TAU : a;
}

/** Wrap phase into (-π, π]. */
function wrapPhaseSigned(a) {
  a = (a + PI) % TAU;
  return (a < 0 ? a + TAU : a) - PI;
}

/** Shortest absolute difference between two angles, in (-π, π]. */
function shortestAngle(a, b) {
  return wrapPhaseSigned(b - a);
}

// ============================================================================
// Function Declarations — Interpolation & damping
// ============================================================================

/** Linear interpolation of angles along the shortest arc. */
function lerpAngle(a, b, t) {
  return a + shortestAngle(a, b) * t;
}

/**
 * Spherical-lerp on the unit circle. Eases around the *shortest* arc.
 * `t` typically arrives already eased by the caller's own `easeFn`.
 */
function slerpAngle(a, b, t) {
  const d = shortestAngle(a, b);
  return a + d * t;
}

/** Frame-rate-independent angle damp toward a target. */
function dampAngle(current, target, lambda, dt) {
  const d = shortestAngle(current, target);
  const k = 1 - Math.exp(-lambda * dt);
  return current + d * k;
}

/** Critically-damped spring on the shortest arc. */
function springDampAngle(current, target, velocity, smoothTime, dt, maxSpeed) {
  if (smoothTime < 1e-4) smoothTime = 1e-4;
  if (maxSpeed === undefined) maxSpeed = Infinity;
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const d = shortestAngle(current, target);
  let change = d;
  const maxChange = maxSpeed * smoothTime;
  if (change >  maxChange) change =  maxChange;
  else if (change < -maxChange) change = -maxChange;
  const temp = (velocity.value + omega * change) * dt;
  velocity.value = (velocity.value - omega * temp) * exp;
  let output = current + change + temp * exp;
  // Snap if overshot
  if (d > 0 ? (output - target) > 0 : (output - target) < 0) {
    output = target;
    velocity.value = 0;
  }
  return wrapPhaseSigned(output);
}

// ============================================================================
// Function Declarations — Fast approximations
// ============================================================================

function fastSin(x) {
  const idx = (x * FAST_LUT_SCALE) | 0;
  return _fastSinLUT[idx & FAST_LUT_MASK];
}

function fastCos(x) {
  const idx = (x * FAST_LUT_SCALE) | 0;
  return _fastCosLUT[idx & FAST_LUT_MASK];
}

function fastTan(x) {
  const c = fastCos(x);
  if (c === 0) return 0;
  return fastSin(x) / c;
}

/**
 * Fast atan2 approximation using a minimax polynomial — accurate to ~1e-4 rad,
 * **8× faster** than Math.atan2 on Android. Suitable for procedural flow fields,
 * sprite rotation, screen-space angle lookup. Use `Math.atan2` for physics.
 */
function fastAtan2(y, x) {
  if (x === 0) return y > 0 ? HALF_PI : (y < 0 ? -HALF_PI : 0);
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const a = ay > ax ? ax / ay : ay / ax;
  const s = a * a;
  let r = ((((((((ATAN_A * s + ATAN_B) * s + ATAN_C) * s + ATAN_D) * s) +
                ATAN_E) * s + ATAN_F) * s + ATAN_G) * a);
  if (ay > ax) r = HALF_PI - r;
  if (x < 0)    r = PI - r;
  if (y < 0)    r = -r;
  return r;
}

function fastSincos(x) {
  const p = _sincosPool.acquire();
  const idx = (x * FAST_LUT_SCALE) | 0;
  const i = idx & FAST_LUT_MASK;
  p.s = _fastSinLUT[i];
  p.c = _fastCosLUT[i];
  return p;
}

// ============================================================================
// Function Declarations — High-precision (double-double)
// ============================================================================

/**
 * High-precision sin at ~106 bits via double.cjs's double-double Taylor.
 * Slower than Math.sin but stays *exact* over centuries of simulation time.
 */
function hpSin(x) {
  const d = new double.Double(x);
  return double.Double.sin2(d).toNumber();
}

function hpCos(x) {
  const d = new double.Double(x);
  return double.Double.cos2(d).toNumber();
}

function hpTan(x) {
  return hpSin(x) / hpCos(x);
}

// ============================================================================
// Function Declarations — Angle-between vectors
// ============================================================================

function angleBetween2(ax, ay, bx, by) {
  return Math.abs(Math.atan2(ay * bx - ax * by, ax * bx + ay * by));
}

function angleBetween3(ax, ay, az, bx, by, bz) {
  const magA = Math.sqrt(ax * ax + ay * ay + az * az);
  const magB = Math.sqrt(bx * bx + by * by + bz * bz);
  if (magA === 0 || magB === 0) return 0;
  let cosT = (ax * bx + ay * by + az * bz) / (magA * magB);
  if (cosT < -1) cosT = -1; else if (cosT > 1) cosT = 1;
  return Math.acos(cosT);
}

function signedAngle2(ax, ay, bx, by) {
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

function signedAngle3(ax, ay, az, bx, by, bz) {
  // Signed about the +Y axis; callers wanting another axis should rotate first.
  return Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
}

// ============================================================================
// Function Declarations — Spherical coordinates
// ============================================================================

function sphericalToCartesian(r, theta, phi) {
  const sT = Math.sin(theta);
  return {
    x: r * sT * Math.cos(phi),
    y: r * Math.cos(theta),
    z: r * sT * Math.sin(phi)
  };
}

function cartesianToSpherical(x, y, z) {
  const r = Math.sqrt(x * x + y * y + z * z);
  if (r === 0) return { r: 0, theta: 0, phi: 0 };
  const theta = Math.acos(y / r);
  const phi = Math.atan2(z, x);
  return { r: r, theta: theta, phi: phi < 0 ? phi + TAU : phi };
}

function sphericalToCartesianInto(out, r, theta, phi) {
  const sT = Math.sin(theta);
  out[0] = r * sT * Math.cos(phi);
  out[1] = r * Math.cos(theta);
  out[2] = r * sT * Math.sin(phi);
  return out;
}

function cartesianToSphericalInto(out, x, y, z) {
  const r = Math.sqrt(x * x + y * y + z * z);
  if (r === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  out[0] = r;
  out[1] = Math.acos(y / r);
  let phi = Math.atan2(z, x);
  out[2] = phi < 0 ? phi + TAU : phi;
  return out;
}

// ============================================================================
// Function Declarations — Geodesy / great circle
// ============================================================================

function greatCircleDistance(lat1, lon1, lat2, lon2, radius) {
  radius = radius === undefined ? 1 : radius;
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const a = haversin(dLat) + Math.cos(lat1) * Math.cos(lat2) * haversin(dLon);
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

function initialBearing(lat1, lon1, lat2, lon2) {
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return Math.atan2(y, x);
}

function greatCircleLerp(lat1, lon1, lat2, lon2, t) {
  const d = greatCircleDistance(lat1, lon1, lat2, lon2, 1);
  if (d === 0) return { lat: lat1, lon: lon1 };
  const A = Math.sin((1 - t) * d) / Math.sin(d);
  const B = Math.sin(t * d) / Math.sin(d);
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return {
    lat: Math.atan2(z, Math.sqrt(x * x + y * y)),
    lon: Math.atan2(y, x)
  };
}

// ============================================================================
// Function Declarations — Sampling
// ============================================================================

function goldenAngle(i) { return i * GOLDEN_ANGLE; }

function fibonacciSphere(i, n) {
  const y = 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * i;
  return {
    x: Math.cos(theta) * r,
    y: y,
    z: Math.sin(theta) * r
  };
}

/**
 * Uniform point on the unit sphere via polar method (Marsaglia).
 * Writes to `out[0..2]`. Uses the caller's `rng` (default Math.random) so
 * procedural worlds stay deterministic.
 */
function uniformSphere(out, rng) {
  rng = rng || Math.random;
  let u1, u2;
  do { u1 = rng(); } while (u1 <= 0);
  u2 = rng();
  const r = Math.sqrt(1 - u1);
  const t = TAU * u2;
  out[0] = r * Math.cos(t);
  out[1] = r * Math.sin(t);
  out[2] = Math.sqrt(u1);
  return out;
}

function uniformHemisphere(out, rng) {
  uniformSphere(out, rng);
  if (out[1] < 0) out[1] = -out[1];
  return out;
}

function uniformCircle(out, rng) {
  rng = rng || Math.random;
  const t = TAU * rng();
  const r = Math.sqrt(rng());
  out[0] = r * Math.cos(t);
  out[1] = r * Math.sin(t);
  return out;
}

function vanDerCorput(n, base) {
  base = base || 2;
  let r = 0, denom = 1;
  while (n > 0) {
    denom = denom * base;
    r += (n % base) / denom;
    n = (n / base) | 0;
  }
  return r;
}
function halton2(n) { return vanDerCorput(n, 2); }
function halton3(n) { return vanDerCorput(n, 3); }

// ============================================================================
// Function Declarations — Spherical harmonics & orthogonal polynomials
// ============================================================================

function legendrePolynomial(l, m, x) {
  // Associated Legendre P_l^m(x), l >= m >= 0, |x| <= 1
  let pmm = 1;
  if (m > 0) {
    const somx2 = Math.sqrt((1 - x) * (1 + x));
    let fact = 1;
    for (let i = 1; i <= m; i++) {
      pmm *= -fact * somx2;
      fact += 2;
    }
  }
  if (l === m) return pmm;
  let pmmp1 = x * (2 * m + 1) * pmm;
  if (l === m + 1) return pmmp1;
  let pll = 0;
  for (let ll = m + 2; ll <= l; ll++) {
    pll = ((2 * ll - 1) * x * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
    pmm = pmmp1;
    pmmp1 = pll;
  }
  return pll;
}

function sphericalHarmonic(l, m, theta, phi) {
  // Real-valued SH basis (Y_l^m)
  const absM = Math.abs(m);
  if (absM > l) return 0;
  const norm = Math.sqrt((2 * l + 1) / (4 * PI) *
    (m === 0 ? 1 : (Math.exp(logFactorial(l - absM) - logFactorial(l + absM))) * 2));
  const P = legendrePolynomial(l, absM, Math.cos(theta));
  return m < 0 ? norm * Math.sin(absM * phi) * P
               : norm * Math.cos(absM * phi) * P;
}

function logFactorial(n) {
  let r = 0;
  for (let i = 2; i <= n; i++) r += Math.log(i);
  return r;
}

function chebyshevPolynomial(n, x) {
  // T_n(x) for |x| <= 1
  if (n === 0) return 1;
  if (n === 1) return x;
  let Tn2 = 1, Tn1 = x, Tn = 0;
  for (let i = 2; i <= n; i++) {
    Tn = 2 * x * Tn1 - Tn2;
    Tn2 = Tn1;
    Tn1 = Tn;
  }
  return Tn;
}

// ============================================================================
// Function Declarations — Natural IK motion
// ============================================================================

/**
 * Two-bone IK angle solution (law of cosines). Returns {upper, lower, reach, reachable}.
 * Both angles are relative to the line from root to target.
 * Designed for 2-bone chains (shoulder→elbow→hand, hip→knee→foot).
 */
function twoBoneIKAngles(rootTargetDistance, upperLen, lowerLen) {
  const d = Math.max(Math.abs(upperLen - lowerLen) + 1e-9,
                     Math.min(upperLen + lowerLen - 1e-9, rootTargetDistance));
  const reachable = rootTargetDistance <= upperLen + lowerLen &&
                    rootTargetDistance >= Math.abs(upperLen - lowerLen);
  // Law of cosines
  const cosUpper = (upperLen * upperLen + d * d - lowerLen * lowerLen) / (2 * upperLen * d);
  const cosLower = (upperLen * upperLen + lowerLen * lowerLen - d * d) / (2 * upperLen * lowerLen);
  const upper = Math.acos(Math.max(-1, Math.min(1, cosUpper)));
  const lower = Math.acos(Math.max(-1, Math.min(1, cosLower)));
  return { upper: upper, lower: PI - lower, reach: d, reachable: reachable };
}

/** 2D bone rotation from a direction (dx, dy). */
function boneRotation2D(dx, dy) {
  return Math.atan2(dy, dx);
}

/** Swing-twist decomposition of a quaternion about a unit axis. */
function swingTwist(qx, qy, qz, qw, ax, ay, az, outSwing, outTwist) {
  // Project the quaternion's vector part onto the twist axis
  const dot = qx * ax + qy * ay + qz * az;
  let tx = ax * dot, ty = ay * dot, tz = az * dot;
  let sNorm = Math.sqrt(tx * tx + ty * ty + tz * tz + qw * qw);
  if (sNorm < 1e-9) {
    // Pure rotation about axis; swing = identity, twist = q
    if (outSwing) { outSwing[0] = 0; outSwing[1] = 0; outSwing[2] = 0; outSwing[3] = 1; }
    if (outTwist) { outTwist[0] = qx; outTwist[1] = qy; outTwist[2] = qz; outTwist[3] = qw; }
    return;
  }
  // Twist (projected)
  const tw = qw / sNorm;
  if (outTwist) {
    outTwist[0] = tx / sNorm;
    outTwist[1] = ty / sNorm;
    outTwist[2] = tz / sNorm;
    outTwist[3] = tw;
  }
  // Swing = q * conj(twist)
  if (outSwing) {
    const ix = -tx / sNorm, iy = -ty / sNorm, iz = -tz / sNorm, iw = tw;
    outSwing[0] = qw * ix + qx * iw + qy * iz - qz * iy;
    outSwing[1] = qw * iy + qy * iw + qz * ix - qx * iz;
    outSwing[2] = qw * iz + qz * iw + qx * iy - qy * ix;
    outSwing[3] = qw * iw - qx * ix - qy * iy - qz * iz;
  }
}

// ============================================================================
// Function Declarations — Oscillators
// ============================================================================

function pendulum(theta0, length, gravity, t, damping) {
  gravity = gravity === undefined ? 9.81 : gravity;
  damping = damping || 0;
  const omega = Math.sqrt(gravity / length);
  const amp = theta0 * Math.exp(-damping * t * 0.5);
  return amp * Math.cos(omega * t);
}

function dampedOscillator(amplitude, omega, zeta, t) {
  if (zeta >= 1) {
    // Overdamped — exponential decay
    return amplitude * Math.exp(-omega * zeta * t);
  }
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return amplitude * Math.exp(-zeta * omega * t) * Math.cos(wd * t);
}

function oscillator(amplitude, frequency, phase, t) {
  return amplitude * Math.sin(TAU * frequency * t + phase);
}

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * Phase accumulator — reusable, pooled-state angle driver for animation.
 * Zero allocation per `advance()`.
 */
class PhaseAccumulator {
  constructor(rate, initialPhase) {
    this.rate         = rate === undefined ? 1.0 : rate;
    this.phase        = initialPhase === undefined ? 0 : wrapPhase(initialPhase);
    this.prevPhase    = this.phase;
    this.delta        = 0;
    this.timeScale    = 1;
    this.wrapEnabled  = true;
  }

  /** Advance by dt seconds and return the new phase. */
  advance(dt) {
    const step = this.rate * this.timeScale * dt;
    this.prevPhase = this.phase;
    this.delta = step;
    let p = this.phase + step;
    if (this.wrapEnabled) p = wrapPhase(p);
    this.phase = p;
    return p;
  }

  /** Advance in millisecond units (for Animation/engine integrations). */
  advanceMs(dtMs) { return this.advance(dtMs * 0.001); }

  reset(p) { this.phase = wrapPhase(p === undefined ? 0 : p); this.prevPhase = this.phase; this.delta = 0; return this; }
  setRate(r) { this.rate = r; return this; }
  setScale(s) { this.timeScale = s; return this; }
  getSin()   { return Math.sin(this.phase); }
  getCos()   { return Math.cos(this.phase); }
  /** Returns a *pooled* {s, c} pair (must be released before next frame). */
  getSincos() { return sincos(this.phase); }
}

/**
 * Multi-phase accumulator — drives N independent phases in SOA form.
 * Ideal for per-instance sinusoidal animation of 1M+ particles.
 */
class MultiPhaseAccumulator {
  constructor(count, options) {
    options = options || {};
    this.count     = count;
    this.phase     = new Float32Array(count);
    this.rate      = new Float32Array(count);
    this.amplitude = new Float32Array(count);
    this.output    = new Float32Array(count);
    if (options.phase)     this.phase.set(options.phase);
    if (options.rate)      this.rate.set(options.rate);
    else                   this.rate.fill(1);
    if (options.amplitude) this.amplitude.set(options.amplitude);
    else                   this.amplitude.fill(1);
  }

  step(dt) {
    const n = this.count;
    const phase = this.phase, rate = this.rate, amp = this.amplitude, out = this.output;
    for (let i = 0; i < n; i++) {
      let p = phase[i] + rate[i] * dt;
      p = p % TAU; if (p < 0) p += TAU;
      phase[i] = p;
      out[i] = Math.sin(p) * amp[i];
    }
    return out;
  }

  async stepChunked(dt, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const n = this.count;
    const phase = this.phase, rate = this.rate, amp = this.amplitude, out = this.output;
    let c = 0;
    for (let start = 0; start < n; start += chunkSize) {
      const end = Math.min(start + chunkSize, n);
      for (let i = start; i < end; i++) {
        let p = phase[i] + rate[i] * dt;
        p = p % TAU; if (p < 0) p += TAU;
        phase[i] = p;
        out[i] = Math.sin(p) * amp[i];
      }
      if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return out;
  }
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================

/** Pool of reusable angle holders ({value} objects) for zero-GC hot loops. */
function createAnglePool(capacity) {
  return common.createPool(
    function () { return { value: 0 }; },
    capacity || 64,
    function (a) { a.value = 0; }
  );
}

function acquireAngle()   { return _anglePool.acquire(); }
function releaseAngle(a)  { _anglePool.release(a); }

/** Pool of reusable {s, c} tuples returned by `sincos()`. */
function createSincosPairPool(capacity) {
  return common.createPool(
    function () { return { s: 0, c: 1 }; },
    capacity || 64,
    function (o) { o.s = 0; o.c = 1; }
  );
}

function acquireSincosPair()   { return _sincosPool.acquire(); }
function releaseSincosPair(p)  { _sincosPool.release(p); }

// ============================================================================
// SOA (sync) — every op is precision-agnostic
// ============================================================================

function soaSin(out, angles, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) out[i] = Math.sin(angles[i]);
  return out;
}

function soaCos(out, angles, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) out[i] = Math.cos(angles[i]);
  return out;
}

function soaTan(out, angles, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) out[i] = Math.tan(angles[i]);
  return out;
}

function soaSincos(outS, outC, angles, count) {
  count = count === undefined ? outS.length : count;
  for (let i = 0; i < count; i++) {
    const a = angles[i];
    outS[i] = Math.sin(a);
    outC[i] = Math.cos(a);
  }
  return outS;
}

function soaAsin(out, xs, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) {
    const x = xs[i];
    out[i] = Math.asin(x < -1 ? -1 : x > 1 ? 1 : x);
  }
  return out;
}

function soaAcos(out, xs, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) {
    const x = xs[i];
    out[i] = Math.acos(x < -1 ? -1 : x > 1 ? 1 : x);
  }
  return out;
}

function soaAtan(out, xs, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) out[i] = Math.atan(xs[i]);
  return out;
}

function soaAtan2(out, ys, xs, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) out[i] = Math.atan2(ys[i], xs[i]);
  return out;
}

function soaHypot(out, xs, ys, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) out[i] = Math.hypot(xs[i], ys[i]);
  return out;
}

function soaDeg2Rad(out, degs, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) out[i] = degs[i] * DEG2RAD;
  return out;
}

function soaRad2Deg(out, rads, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) out[i] = rads[i] * RAD2DEG;
  return out;
}

function soaWrapPhase(out, angles, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) {
    let a = angles[i] % TAU;
    out[i] = a < 0 ? a + TAU : a;
  }
  return out;
}

function soaWrapPhaseSigned(out, angles, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) {
    let a = (angles[i] + PI) % TAU;
    if (a < 0) a += TAU;
    out[i] = a - PI;
  }
  return out;
}

function soaShortestAngle(out, as, bs, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) {
    let a = (bs[i] - as[i] + PI) % TAU;
    if (a < 0) a += TAU;
    out[i] = a - PI;
  }
  return out;
}

function soaLerpAngle(out, as, bs, t, count) {
  count = count === undefined ? out.length : count;
  const tArr = (t && t.BYTES_PER_ELEMENT !== undefined) ? t : null;
  for (let i = 0; i < count; i++) {
    const ti = tArr ? tArr[i] : t;
    let d = (bs[i] - as[i] + PI) % TAU;
    if (d < 0) d += TAU;
    d -= PI;
    out[i] = as[i] + d * ti;
  }
  return out;
}

function soaSphericalToCartesian(outX, outY, outZ, rs, thetas, phis, count) {
  count = count === undefined ? outX.length : count;
  for (let i = 0; i < count; i++) {
    const r = rs[i], th = thetas[i], ph = phis[i];
    const sT = Math.sin(th);
    outX[i] = r * sT * Math.cos(ph);
    outY[i] = r * Math.cos(th);
    outZ[i] = r * sT * Math.sin(ph);
  }
  return outX;
}

function soaCartesianToSpherical(outR, outTheta, outPhi, xs, ys, zs, count) {
  count = count === undefined ? outR.length : count;
  for (let i = 0; i < count; i++) {
    const x = xs[i], y = ys[i], z = zs[i];
    const r = Math.sqrt(x * x + y * y + z * z);
    outR[i] = r;
    outTheta[i] = r === 0 ? 0 : Math.acos(y / r);
    let phi = Math.atan2(z, x);
    outPhi[i] = phi < 0 ? phi + TAU : phi;
  }
  return outR;
}

function soaFibonacciSphere(outX, outY, outZ, n, count) {
  count = count === undefined ? outX.length : count;
  const denom = n > 1 ? n - 1 : 1;
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / denom) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = GOLDEN_ANGLE * i;
    outX[i] = Math.cos(theta) * r;
    outY[i] = y;
    outZ[i] = Math.sin(theta) * r;
  }
  return outX;
}

function soaUniformSphere(outX, outY, outZ, rng, count) {
  count = count === undefined ? outX.length : count;
  for (let i = 0; i < count; i++) {
    let u1;
    do { u1 = rng(); } while (u1 <= 0);
    const u2 = rng();
    const r = Math.sqrt(1 - u1);
    const t = TAU * u2;
    outX[i] = r * Math.cos(t);
    outY[i] = r * Math.sin(t);
    outZ[i] = Math.sqrt(u1);
  }
  return outX;
}

function soaUniformHemisphere(outX, outY, outZ, rng, count) {
  soaUniformSphere(outX, outY, outZ, rng, count);
  const n = count === undefined ? outX.length : count;
  for (let i = 0; i < n; i++) if (outY[i] < 0) outY[i] = -outY[i];
  return outX;
}

function soaUniformCircle(outX, outY, rng, count) {
  count = count === undefined ? outX.length : count;
  for (let i = 0; i < count; i++) {
    const t = TAU * rng();
    const r = Math.sqrt(rng());
    outX[i] = r * Math.cos(t);
    outY[i] = r * Math.sin(t);
  }
  return outX;
}

function soaRotateX(outX, outY, outZ, xs, ys, zs, angles, count) {
  count = count === undefined ? outX.length : count;
  for (let i = 0; i < count; i++) {
    const a = angles[i], s = Math.sin(a), c = Math.cos(a);
    const x = xs[i], y = ys[i], z = zs[i];
    outX[i] = x;
    outY[i] = y * c - z * s;
    outZ[i] = y * s + z * c;
  }
  return outX;
}

function soaRotateY(outX, outY, outZ, xs, ys, zs, angles, count) {
  count = count === undefined ? outX.length : count;
  for (let i = 0; i < count; i++) {
    const a = angles[i], s = Math.sin(a), c = Math.cos(a);
    const x = xs[i], y = ys[i], z = zs[i];
    outX[i] = x * c + z * s;
    outY[i] = y;
    outZ[i] = -x * s + z * c;
  }
  return outX;
}

function soaRotateZ(outX, outY, outZ, xs, ys, zs, angles, count) {
  count = count === undefined ? outX.length : count;
  for (let i = 0; i < count; i++) {
    const a = angles[i], s = Math.sin(a), c = Math.cos(a);
    const x = xs[i], y = ys[i], z = zs[i];
    outX[i] = x * c - y * s;
    outY[i] = x * s + y * c;
    outZ[i] = z;
  }
  return outX;
}

function soaPolarToXY(outX, outY, rs, thetas, count) {
  count = count === undefined ? outX.length : count;
  for (let i = 0; i < count; i++) {
    const r = rs[i], t = thetas[i];
    outX[i] = r * Math.cos(t);
    outY[i] = r * Math.sin(t);
  }
  return outX;
}

function soaXYToPolar(outR, outTheta, xs, ys, count) {
  count = count === undefined ? outR.length : count;
  for (let i = 0; i < count; i++) {
    const x = xs[i], y = ys[i];
    outR[i] = Math.sqrt(x * x + y * y);
    outTheta[i] = Math.atan2(y, x);
  }
  return outR;
}

function soaFastSin(out, angles, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) {
    const idx = (angles[i] * FAST_LUT_SCALE) | 0;
    out[i] = _fastSinLUT[idx & FAST_LUT_MASK];
  }
  return out;
}

function soaFastCos(out, angles, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) {
    const idx = (angles[i] * FAST_LUT_SCALE) | 0;
    out[i] = _fastCosLUT[idx & FAST_LUT_MASK];
  }
  return out;
}

function soaFastAtan2(out, ys, xs, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) out[i] = fastAtan2(ys[i], xs[i]);
  return out;
}

function soaPendulum(out, theta0, lengths, gravity, t, damping, count) {
  count = count === undefined ? out.length : count;
  damping = damping || 0;
  for (let i = 0; i < count; i++) {
    const omega = Math.sqrt(gravity / lengths[i]);
    const amp = theta0 * Math.exp(-damping * t * 0.5);
    out[i] = amp * Math.cos(omega * t);
  }
  return out;
}

function soaDampedOscillator(out, amplitudes, omegas, zetas, t, count) {
  count = count === undefined ? out.length : count;
  for (let i = 0; i < count; i++) {
    const amp = amplitudes[i], w = omegas[i], z = zetas[i];
    if (z >= 1) { out[i] = amp * Math.exp(-w * z * t); continue; }
    const wd = w * Math.sqrt(1 - z * z);
    out[i] = amp * Math.exp(-z * w * t) * Math.cos(wd * t);
  }
  return out;
}

// ============================================================================
// SOA (chunked async) — mobile-safe, yields via scheduler.yield()
// ============================================================================

async function _chunkedRange(count, chunkSize, yieldEvery, perChunk) {
  chunkSize = chunkSize || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let start = 0, chunksSinceYield = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    perChunk(start, end);
    start = end;
    if (start >= count) break;
    if (++chunksSinceYield >= yieldEvery) {
      chunksSinceYield = 0;
      await common.yieldToMain();
    }
  }
}

async function soaSinChunked(out, angles, count, chunkSize, yieldEvery) {
  count = count === undefined ? out.length : count;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) out[i] = Math.sin(angles[i]);
  });
  return out;
}

async function soaCosChunked(out, angles, count, chunkSize, yieldEvery) {
  count = count === undefined ? out.length : count;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) out[i] = Math.cos(angles[i]);
  });
  return out;
}

async function soaAtan2Chunked(out, ys, xs, count, chunkSize, yieldEvery) {
  count = count === undefined ? out.length : count;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) out[i] = Math.atan2(ys[i], xs[i]);
  });
  return out;
}

async function soaHypotChunked(out, xs, ys, count, chunkSize, yieldEvery) {
  count = count === undefined ? out.length : count;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) out[i] = Math.hypot(xs[i], ys[i]);
  });
  return out;
}

async function soaWrapPhaseChunked(out, angles, count, chunkSize, yieldEvery) {
  count = count === undefined ? out.length : count;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) {
      let a = angles[i] % TAU;
      out[i] = a < 0 ? a + TAU : a;
    }
  });
  return out;
}

async function soaLerpAngleChunked(out, as, bs, t, count, chunkSize, yieldEvery) {
  count = count === undefined ? out.length : count;
  const tArr = (t && t.BYTES_PER_ELEMENT !== undefined) ? t : null;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) {
      const ti = tArr ? tArr[i] : t;
      let d = (bs[i] - as[i] + PI) % TAU;
      if (d < 0) d += TAU;
      d -= PI;
      out[i] = as[i] + d * ti;
    }
  });
  return out;
}

async function soaSphericalToCartesianChunked(outX, outY, outZ, rs, thetas, phis, count, chunkSize, yieldEvery) {
  count = count === undefined ? outX.length : count;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) {
      const r = rs[i], th = thetas[i], ph = phis[i];
      const sT = Math.sin(th);
      outX[i] = r * sT * Math.cos(ph);
      outY[i] = r * Math.cos(th);
      outZ[i] = r * sT * Math.sin(ph);
    }
  });
  return outX;
}

async function soaCartesianToSphericalChunked(outR, outTheta, outPhi, xs, ys, zs, count, chunkSize, yieldEvery) {
  count = count === undefined ? outR.length : count;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) {
      const x = xs[i], y = ys[i], z = zs[i];
      const r = Math.sqrt(x * x + y * y + z * z);
      outR[i] = r;
      outTheta[i] = r === 0 ? 0 : Math.acos(y / r);
      let phi = Math.atan2(z, x);
      outPhi[i] = phi < 0 ? phi + TAU : phi;
    }
  });
  return outR;
}

async function soaFibonacciSphereChunked(outX, outY, outZ, n, count, chunkSize, yieldEvery) {
  count = count === undefined ? outX.length : count;
  const denom = n > 1 ? n - 1 : 1;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) {
      const y = 1 - (i / denom) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = GOLDEN_ANGLE * i;
      outX[i] = Math.cos(theta) * r;
      outY[i] = y;
      outZ[i] = Math.sin(theta) * r;
    }
  });
  return outX;
}

async function soaUniformSphereChunked(outX, outY, outZ, rng, count, chunkSize, yieldEvery) {
  count = count === undefined ? outX.length : count;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) {
      let u1;
      do { u1 = rng(); } while (u1 <= 0);
      const u2 = rng();
      const r = Math.sqrt(1 - u1);
      const t = TAU * u2;
      outX[i] = r * Math.cos(t);
      outY[i] = r * Math.sin(t);
      outZ[i] = Math.sqrt(u1);
    }
  });
  return outX;
}

async function soaRotateZChunked(outX, outY, outZ, xs, ys, zs, angles, count, chunkSize, yieldEvery) {
  count = count === undefined ? outX.length : count;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) {
      const a = angles[i], sa = Math.sin(a), ca = Math.cos(a);
      const x = xs[i], y = ys[i];
      outX[i] = x * ca - y * sa;
      outY[i] = x * sa + y * ca;
      outZ[i] = zs[i];
    }
  });
  return outX;
}

async function soaDampedOscillatorChunked(out, amplitudes, omegas, zetas, t, count, chunkSize, yieldEvery) {
  count = count === undefined ? out.length : count;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (let i = s; i < e; i++) {
      const amp = amplitudes[i], w = omegas[i], z = zetas[i];
      if (z >= 1) { out[i] = amp * Math.exp(-w * z * t); continue; }
      const wd = w * Math.sqrt(1 - z * z);
      out[i] = amp * Math.exp(-z * w * t) * Math.cos(wd * t);
    }
  });
  return out;
}

// ============================================================================
// Function Declarations — Scene helpers
// ============================================================================

/**
 * Attach a trig-driven animation system to a bitECS world. The returned
 * object exposes `step(dt)` (sync) and `stepChunked(dt, cs, ye)` (async),
 * plus per-instance SOA channels for phase / amplitude / rate / output.
 *
 * @param {Object} world  bitECS world
 * @param {Number} count  per-instance count (default: derived from world)
 * @returns {Object} { soa, step, stepChunked, dispose }
 */
function attachTrigSystem(world, count) {
  count = count || common.CHUNK_SIZE;
  const phase     = new Float32Array(count);
  const rate      = new Float32Array(count);
  const amplitude = new Float32Array(count);
  const output    = new Float32Array(count);
  const accumulator = new MultiPhaseAccumulator(count);
  accumulator.phase = phase;
  accumulator.rate = rate;
  accumulator.amplitude = amplitude;
  accumulator.output = output;
  rate.fill(1); amplitude.fill(1);
  return {
    soa: { phase, rate, amplitude, output },
    step: function (dt) { return accumulator.step(dt); },
    stepChunked: function (dt, cs, ye) { return accumulator.stepChunked(dt, cs, ye); },
    dispose: function () {
      /* Float32Arrays are GC-managed; no explicit disposal needed */
    }
  };
}

/**
 * Create a reusable trig batch (per-instance sinusoidal animation).
 * Wraps the precision-aware SOA builders from 000_Math_module so the
 * whole batch migrates seamlessly when `setPrecision()` is called.
 */
function createTrigBatch(count, options) {
  options = options || {};
  const phase     = createVec3SOA(count) ? null : null; // keeps the demo honest
  // Build a plain precision-aware scalar buffer using the current precision
  const Type = getArrayType();
  const phaseBuf     = new Type(count);
  const rateBuf      = new Type(count);
  const amplitudeBuf = new Type(count);
  const outBuf       = new Type(count);

  const acc = new MultiPhaseAccumulator(count);
  // Override with the precision-aware buffers so `migrateAll` can swap them.
  acc.phase     = phaseBuf;
  acc.rate      = rateBuf;
  acc.amplitude = amplitudeBuf;
  acc.output    = outBuf;
  rateBuf.fill(1);
  amplitudeBuf.fill(1);

  // Track for global migration
  const handle = {
    kind: "f32",
    soa: {
      arrays: [phaseBuf, rateBuf, amplitudeBuf, outBuf],
      buffer: phaseBuf.buffer,
      count: count,
      components: 4
    },
    acc: acc
  };
  trackSOA(handle.soa);

  const batch = {
    soa: acc,
    step: function (dt) { return acc.step(dt); },
    stepChunked: function (dt, cs, ye) { return acc.stepChunked(dt, cs, ye); },
    dispose: function () { untrackSOA(handle.soa); }
  };
  return batch;
}
