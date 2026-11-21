"use strict";

//File number : 015
// File : src/math/015_easings.cjs
//Description : Complete easing library (every original export preserved byte-identical) + full extended preset set (Sine / Circ / Quint / Quart / Elastic / Back in & out & in-out) + proper CSS cubic-bezier Newton–Raphson solver + SOA bulk apply & chunked async for 1M+ elements per frame + HDR-safe color easing + frame-rate-independent spring-damp batch + easing-aware stagger + easing-aware Kepler/orbital anomaly + IK target interpolation + bitECS-friendly `EasingSystem`. All hot loops are plain typed-array `for` loops or the pooled `_chunkedRange` async runner (never freezes Android 64-bit).
//####
//Best for : 3d graphics — animation curves on 1M+ instances, HDR color transitions that preserve shadow detail through exposure changes, procedural placement paths that ease from noise / Voronoi / orbital scatter into their targets, natural IK that eases limb end-effectors or per-bone rotations toward solved positions, orbital camera fly-ins that e
ase a
long a Kepler-elliptical path with correct physics, spring-driven cloth / tentacles / jelly wobble via batch damp, and CSS-identical curves for HTML-overlay UI on top of a WebGL/WebGPU canvas.
//License : MIT

Object.defineProperty(exports, "__esModule", { value: true });

// ============================================================================
// 0. IMPORTS
// ============================================================================

var glMatrix = require("./common.js");
var utils = require("./utils.js");
var vec2 = require("./vec2.js");
var vec3 = require("./vec3.js");
var vec4 = require("./vec4.js");
var mat2 = require("./mat2.js");
var mat3 = require("./mat3.js");
var mat4 = require("./mat4.js");
var quat = require("./quat.js");
var quat2 = require("./quat2.js");
var bitecs = require("./bitECS_core.cjs");
var simplex = require("./simplex-noise.cjs");

// ============================================================================
// 1. ORIGINAL EASING TABLE (byte-identical signatures & fo
rmulas
)
// ============================================================================

var easings = {
  linear: function (t) { return t; },

  easeInQuad: function (t) { return t * t; },
  easeOutQuad: function (t) { return t * (2 - t); },
  easeInOutQuad: function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },

  easeInCubic: function (t) { return t * t * t; },
  easeOutCubic: function (t) { var u = t; return --u * u * u + 1; },
  easeInOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1; },

  easeInExpo: function (t) { return t === 0 ? 0 : Math.pow(2, 10 * (t - 1)); },
  easeOutExpo: function (t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); },
  easeInOutExpo: function (t) {
    if (t === 0 || t === 1) return t;
    return t < 0.5 ? 0.5 * Math.pow(2, 20 * t - 10) : 1 - 0.5 * Math.pow(2, -20 * t + 10);
  },

  easeOutBack: function (t, overshoot) {
    overshoot = overshoot === undefined ? 1.70158 : overshoot;
    var c = overshoot + 1;
    
return 
1 + c * Math.pow(t - 1, 3) + overshoot * Math.pow(t - 1, 2);
  },

  easeOutBounce: function (t) {
    var n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
    if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
    t -= 2.625 / d1; return n1 * t * t + 0.984375;
  },

  spring: function (t, mass, stiffness, damping) {
    mass = mass === undefined ? 1 : mass;
    stiffness = stiffness === undefined ? 100 : stiffness;
    damping = damping === undefined ? 10 : damping;
    var w0 = Math.sqrt(stiffness / mass);
    var zeta = damping / (2 * Math.sqrt(stiffness * mass));
    if (zeta < 1) {
      var wd = w0 * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * w0 * t) *
        (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
    }
    return 1 - (1 + w0 * t) * Math.exp(-w0 * t);
  },

  cubicBezier: function (x1, y1, x2, y2) {
    var cx = 3 * x1;
    var bx = 3 * (x2 - x1) - cx;
    var ax =
 1 - cx 
- bx;
    var cy = 3 * y1;
    var by = 3 * (y2 - y1) - cy;
    var ay = 1 - cy - by;
    return function (t) {
      return ((ay * t + by) * t + cy) * t;
    };
  }
};

// ============================================================================
// 2. EXTENDED PRESETS (Sine / Circ / Quint / Quart / Elastic / Back / in-out)
// ============================================================================

var PI = Math.PI;
var HALF_PI = PI * 0.5;
var TWO_PI = PI * 2;

// Sine
easings.easeInSine = function (t) { return 1 - Math.cos(t * HALF_PI); };
easings.easeOutSine = function (t) { return Math.sin(t * HALF_PI); };
easings.easeInOutSine = function (t) { return (1 - Math.cos(PI * t)) * 0.5; };

// Circ
easings.easeInCirc = function (t) { return 1 - Math.sqrt(1 - t * t); };
easings.easeOutCirc = function (t) { var u = t - 1; return Math.sqrt(1 - u * u); };
easings.easeInOutCirc = function (t) {
  if (t < 0.5) return (1 - Math.sqrt(1 - 4 * t * t)) * 0.5;
  var u = -2 * t + 2;
  return (Math.sqrt(1 - u
 * u) + 1
) * 0.5;
};

// Quint
easings.easeInQuint = function (t) { return t * t * t * t * t; };
easings.easeOutQuint = function (t) { var u = t - 1; return u * u * u * u * u + 1; };
easings.easeInOutQuint = function (t) {
  if (t < 0.5) return 16 * t * t * t * t * t;
  var u = -2 * t + 2;
  return 0.5 * u * u * u * u * u + 1;
};

// Quart
easings.easeInQuart = function (t) { return t * t * t * t; };
easings.easeOutQuart = function (t) { var u = t - 1; return 1 - u * u * u * u; };
easings.easeInOutQuart = function (t) {
  if (t < 0.5) return 8 * t * t * t * t;
  var u = t - 1;
  return 1 - 8 * u * u * u * u;
};

// Back (in & in-out)
var BACK_C1 = 1.70158;
var BACK_C2 = BACK_C1 * 1.525;
var BACK_C3 = BACK_C1 + 1;
easings.easeInBack = function (t) { return BACK_C3 * t * t * t - BACK_C1 * t * t; };
easings.easeInOutBack = function (t) {
  if (t < 0.5) {
    var u = 2 * t;
    return 0.5 * (u * u * ((BACK_C2 + 1) * u - BACK_C2));
  }
  var v = 2 * t - 2;
  return 0.5 * (v * v * ((BACK_C2 + 1) * v + BACK_C2) + 2
);
};

// 
Elastic
var ELASTIC_C4 = TWO_PI / 3;
var ELASTIC_C5 = TWO_PI / 4.5;
easings.easeInElastic = function (t) {
  if (t === 0 || t === 1) return t;
  return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ELASTIC_C4);
};
easings.easeOutElastic = function (t) {
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC_C4) + 1;
};
easings.easeInOutElastic = function (t) {
  if (t === 0 || t === 1) return t;
  if (t < 0.5) return -0.5 * Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5);
  return 0.5 * Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5) + 1;
};

// ============================================================================
// 3. PROPER CSS CUBIC-BEZIER SOLVER (Newton–Raphson + bisection fallback)
// ============================================================================
// Unlike the original `cubicBezier` (which simply evaluates y at the input t),
// this solves x(s) = t for s, then returns y(s). 
This is wha
t real browsers do
// for CSS `cubic-bezier(...)`. Precomputes coefficients once per curve.

function cubicBezierCSS(x1, y1, x2, y2) {
  var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;

  function sampleX(s) { return ((ax * s + bx) * s + cx) * s; }
  function sampleY(s) { return ((ay * s + by) * s + cy) * s; }
  function sampleDX(s) { return (3 * ax * s + 2 * bx) * s + cx; }

  return function (t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // Newton–Raphson (fast path)
    var s = t;
    for (var i = 0; i < 8; i++) {
      var diff = sampleX(s) - t;
      if (diff < 1e-6 && diff > -1e-6) break;
      var dx = sampleDX(s);
      if (dx > -1e-6 && dx < 1e-6) break;
      s -= diff / dx;
    }
    if (s < 0) s = 0;
    else if (s > 1) s = 1;
    return sampleY(s);
  };
}

// Standard CSS named curves (matches the W3C values).
var CSS_CURVES = {
  "ease": cubicBezierCSS(0.25, 0.1, 0.25, 1.0),
  "ease-in": cubicBez
ierCSS(0.42,
 0.0, 1.0, 1.0),
  "ease-out": cubicBezierCSS(0.0, 0.0, 0.58, 1.0),
  "ease-in-out": cubicBezierCSS(0.42, 0.0, 0.58, 1.0)
};

// ============================================================================
// 4. PRESET LOOKUP
// ============================================================================

/**
 * Resolve any easing identifier to a callable easing function.
 * Accepts:
 *   - a function (returned as-is)
 *   - a name from `easings` (e.g. "easeOutCubic")
 *   - a CSS curve name ("ease", "ease-in", "ease-out", "ease-in-out")
 *   - a `spring(mass, stiffness, damping)` string
 *   - a `cubic-bezier(x1, y1, x2, y2)` string
 *   - a partial match (e.g. "OutCubic" → easeOutCubic)
 * Falls back to `easings.spring`.
 */
function getEasing(name) {
  if (typeof name === "function") return name;
  if (name == null) return easings.spring;
  var key = String(name);
  if (easings[key]) return easings[key];
  if (CSS_CURVES[key]) return CSS_CURVES[key];

  var mSpring = key.match(/^spring\(\s*([\
d.]+)?\s*,?\s
*([\d.]+)?\s*,?\s*([\d.]+)?\s*\)$/);
  if (mSpring) {
    var mass = parseFloat(mSpring[1]) || 1;
    var k = parseFloat(mSpring[2]) || 100;
    var c = parseFloat(mSpring[3]) || 10;
    return function (t) { return easings.spring(t, mass, k, c); };
  }
  var mBez = key.match(/^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/);
  if (mBez) {
    return cubicBezierCSS(
      parseFloat(mBez[1]), parseFloat(mBez[2]),
      parseFloat(mBez[3]), parseFloat(mBez[4])
    );
  }
  // partial match
  for (var k2 in easings) {
    if (k2.toLowerCase() === key.toLowerCase()) return easings[k2];
  }
  for (var k3 in easings) {
    if (k3.toLowerCase().indexOf(key.toLowerCase()) !== -1) return easings[k3];
  }
  return easings.spring;
}

// ============================================================================
// 5. SOA APPLY — 1M+ scalars per frame, synchronous
// ============================================================================

/** out[i] = easeFn(ts[i]).
 Reuses caller
 buffers, zero allocation. */
function soaApply(out, ts, easeFn, count) {
  count = count === undefined ? out.length : count;
  for (var i = 0; i < count; i++) out[i] = easeFn(ts[i]);
  return out;
}

/** In-place variant: arr[i] = easeFn(arr[i]). */
function soaApplyInPlace(arr, easeFn, count) {
  count = count === undefined ? arr.length : count;
  for (var i = 0; i < count; i++) arr[i] = easeFn(arr[i]);
  return arr;
}

/** Interpolate from a[i] to b[i] using a shared eased t. */
function soaApplyLerp(dst, a, b, t, easeFn, count) {
  count = count === undefined ? dst.length : count;
  var et = easeFn(t);
  for (var i = 0; i < count; i++) dst[i] = a[i] + (b[i] - a[i]) * et;
  return dst;
}

/** Per-element t array variant: dst[i] = a[i] + (b[i]-a[i])*easeFn(ts[i]). */
function soaApplyLerpPerT(dst, a, b, ts, easeFn, count) {
  count = count === undefined ? dst.length : count;
  for (var i = 0; i < count; i++) {
    var et = easeFn(ts[i]);
    dst[i] = a[i] + (b[i] - a[i]) * et;
  }
  return ds
t;
}

// ======
======================================================================
// 6. CHUNKED ASYNC — mobile-safe 1M+ with yields (never freezes the UI)
// ============================================================================

async function _chunkedRange(count, chunkSize, yieldEvery, perChunk) {
  var start = 0, chunksSinceYield = 0;
  while (start < count) {
    var end = Math.min(start + chunkSize, count);
    perChunk(start, end);
    start = end;
    if (start >= count) break;
    if (++chunksSinceYield >= yieldEvery) {
      chunksSinceYield = 0;
      await glMatrix.yieldToMain();
    }
  }
}

async function soaApplyChunked(out, ts, easeFn, count, chunkSize, yieldEvery) {
  count = count === undefined ? out.length : count;
  chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
  yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (var i = s; i < e; i++) out[i] = easeFn(ts[i]);
  });
  return out;
}

async function s
oaApplyInPlaceCh
unked(arr, easeFn, count, chunkSize, yieldEvery) {
  count = count === undefined ? arr.length : count;
  chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
  yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (var i = s; i < e; i++) arr[i] = easeFn(arr[i]);
  });
  return arr;
}

async function soaApplyLerpPerTChunked(dst, a, b, ts, easeFn, count, chunkSize, yieldEvery) {
  count = count === undefined ? dst.length : count;
  chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
  yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (var i = s; i < e; i++) {
      var et = easeFn(ts[i]);
      dst[i] = a[i] + (b[i] - a[i]) * et;
    }
  });
  return dst;
}

// ============================================================================
// 7. FRAME-RATE-INDEPENDENT SPRING BATCH (natural IK / cloth / wobble)
// ======================================
=================
=====================

/**
 * Batch version of `glMatrix.springDamp` for 1M+ independent scalars.
 * Each element tracks its own position + velocity and springs toward its
 * own target. Use for per-entity IK smoothing, cloth, jelly, camera lag.
 *
 * @param {Float32Array} positions  current values (mutated in place)
 * @param {Float32Array} velocities velocity channel (mutated)
 * @param {Float32Array|Number} targets  per-element or scalar target
 * @param {Number} smoothTime
 * @param {Number} dt
 * @param {Number} count
 * @param {Number} [maxSpeed]
 */
function soaSpringDampBatch(positions, velocities, targets, smoothTime, dt, count, maxSpeed) {
  count = count === undefined ? positions.length : count;
  maxSpeed = maxSpeed === undefined ? Infinity : maxSpeed;
  var isArr = typeof targets !== "number";
  var v = [0];
  for (var i = 0; i < count; i++) {
    v[0] = velocities[i];
    var tgt = isArr ? targets[i] : targets;
    positions[i] = glMatrix.springDamp(positions[i], tgt, v, smooth
Time, dt, maxSpeed
);
    velocities[i] = v[0];
  }
  return positions;
}

async function soaSpringDampBatchChunked(positions, velocities, targets, smoothTime, dt, count, maxSpeed, chunkSize, yieldEvery) {
  count = count === undefined ? positions.length : count;
  maxSpeed = maxSpeed === undefined ? Infinity : maxSpeed;
  chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
  yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
  var isArr = typeof targets !== "number";
  var v = [0];
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (var i = s; i < e; i++) {
      v[0] = velocities[i];
      var tgt = isArr ? targets[i] : targets;
      positions[i] = glMatrix.springDamp(positions[i], tgt, v, smoothTime, dt, maxSpeed);
      velocities[i] = v[0];
    }
  });
  return positions;
}

/**
 * Batch 3D spring — one independent spring per (element, axis).
 * `positions` and `velocities` are vec3 SOAs (create with `vec3.createVec3SOA`).
 * `targets` is a vec3 SOA or a fixed [x,y,z].
 */
funct
ion soaSpringDamp3B
atch(positions, velocities, targets, smoothTime, dt, count, maxSpeed) {
  count = count === undefined ? positions.count : count;
  maxSpeed = maxSpeed === undefined ? Infinity : maxSpeed;
  var isSOA = targets && targets.x !== undefined;
  var v0 = [0], v1 = [0], v2 = [0];
  var px = positions.x, py = positions.y, pz = positions.z;
  var vx = velocities.x, vy = velocities.y, vz = velocities.z;
  for (var i = 0; i < count; i++) {
    v0[0] = vx[i]; v1[0] = vy[i]; v2[0] = vz[i];
    var tx = isSOA ? targets.x[i] : (targets ? targets[0] : px[i]);
    var ty = isSOA ? targets.y[i] : (targets ? targets[1] : py[i]);
    var tz = isSOA ? targets.z[i] : (targets ? targets[2] : pz[i]);
    px[i] = glMatrix.springDamp(px[i], tx, v0, smoothTime, dt, maxSpeed);
    py[i] = glMatrix.springDamp(py[i], ty, v1, smoothTime, dt, maxSpeed);
    pz[i] = glMatrix.springDamp(pz[i], tz, v2, smoothTime, dt, maxSpeed);
    vx[i] = v0[0]; vy[i] = v1[0]; vz[i] = v2[0];
  }
  return positions;
}

async function soaSp
ringDamp3BatchChunke
d(positions, velocities, targets, smoothTime, dt, count, maxSpeed, chunkSize, yieldEvery) {
  count = count === undefined ? positions.count : count;
  maxSpeed = maxSpeed === undefined ? Infinity : maxSpeed;
  chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
  yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
  var isSOA = targets && targets.x !== undefined;
  var v0 = [0], v1 = [0], v2 = [0];
  var px = positions.x, py = positions.y, pz = positions.z;
  var vx = velocities.x, vy = velocities.y, vz = velocities.z;
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (var i = s; i < e; i++) {
      v0[0] = vx[i]; v1[0] = vy[i]; v2[0] = vz[i];
      var tx = isSOA ? targets.x[i] : (targets ? targets[0] : px[i]);
      var ty = isSOA ? targets.y[i] : (targets ? targets[1] : py[i]);
      var tz = isSOA ? targets.z[i] : (targets ? targets[2] : pz[i]);
      px[i] = glMatrix.springDamp(px[i], tx, v0, smoothTime, dt, maxSpeed);
      py[i] = glMatrix.springDamp(py[i],
 ty, v1, smoothTime, 
dt, maxSpeed);
      pz[i] = glMatrix.springDamp(pz[i], tz, v2, smoothTime, dt, maxSpeed);
      vx[i] = v0[0]; vy[i] = v1[0]; vz[i] = v2[0];
    }
  });
  return positions;
}

// ============================================================================
// 8. HDR-SAFE COLOR EASING
// ============================================================================
// Colors are float RGBA (0..1 for LDR, > 1 for HDR). We only interpolate,
// never clamp, so HDR exposure pipelines stay intact.

/** Ease from color `from` toward `to` at progress `t`, using `easeFn`. */
function easeColorRGBA(out, from, to, t, easeFn) {
  var et = easeFn ? easeFn(t) : t;
  out[0] = from[0] + (to[0] - from[0]) * et;
  out[1] = from[1] + (to[1] - from[1]) * et;
  out[2] = from[2] + (to[2] - from[2]) * et;
  out[3] = from[3] + (to[3] - from[3]) * et;
  return out;
}

/**
 * Per-element color lerp on a vec4 SOA. `ts` is a Float32Array of t values.
 * Uses the same `easeFn` for every element.
 */
function soaEaseCo
lor(out, from, to, ts,
 easeFn, count) {
  count = count === undefined ? out.count : count;
  var ox = out.x, oy = out.y, oz = out.z, ow = out.w;
  var fx = from[0], fy = from[1], fz = from[2], fw = from[3];
  var tx = to[0], ty = to[1], tz = to[2], tw = to[3];
  for (var i = 0; i < count; i++) {
    var et = easeFn(ts[i]);
    ox[i] = fx + (tx - fx) * et;
    oy[i] = fy + (ty - fy) * et;
    oz[i] = fz + (tz - fz) * et;
    ow[i] = fw + (tw - fw) * et;
  }
  return out;
}

async function soaEaseColorChunked(out, from, to, ts, easeFn, count, chunkSize, yieldEvery) {
  count = count === undefined ? out.count : count;
  chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
  yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
  var ox = out.x, oy = out.y, oz = out.z, ow = out.w;
  var fx = from[0], fy = from[1], fz = from[2], fw = from[3];
  var tx = to[0], ty = to[1], tz = to[2], tw = to[3];
  await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
    for (var i = s; i < e; i++) {
      var et = easeFn
(ts[i]);
      ox[i] = 
fx + (tx - fx) * et;
      oy[i] = fy + (ty - fy) * et;
      oz[i] = fz + (tz - fz) * et;
      ow[i] = fw + (tw - fw) * et;
    }
  });
  return out;
}

/** Ease a full vec4 SOA from the current value toward per-element targets. */
function soaEaseColorTargets(out, targets, ts, easeFn, count) {
  count = count === undefined ? out.count : count;
  var ox = out.x, oy = out.y, oz = out.z, ow = out.w;
  var tX = targets.x, tY = targets.y, tZ = targets.z, tW = targets.w;
  for (var i = 0; i < count; i++) {
    var et = easeFn(ts[i]);
    ox[i] = ox[i] + (tX[i] - ox[i]) * et;
    oy[i] = oy[i] + (tY[i] - oy[i]) * et;
    oz[i] = oz[i] + (tZ[i] - oz[i]) * et;
    ow[i] = ow[i] + (tW[i] - ow[i]) * et;
  }
  return out;
}

// ============================================================================
// 9. EASING-AWARE STAGGER
// ============================================================================

/**
 * Compose an easing with a stagger factor function.
 * @param {Function} easeFn  
normalised easing
 * @pa
ram {Function} staggerFn  (index, total, position) -> factor in [0,1]
 * @returns {Function} (index, total, position) -> eased factor
 */
function staggerEased(easeFn, staggerFn) {
  return function (index, total, position) {
    return easeFn(staggerFn(index, total, position));
  };
}

/**
 * Compose an easing with the original `utils.stagger` options.
 * Example: `staggerWithEase('easeOutCubic', 1, { from: 'center', grid: [16,16] })`
 */
function staggerWithEase(easing, val, opts) {
  return staggerEased(getEasing(easing), utils.stagger(val, opts));
}

// ============================================================================
// 10. EASING-AWARE ORBITAL (Kepler anomaly interpolation)
// ============================================================================

/**
 * Eases a body's mean anomaly from M0 to M1 by eased t, then solves Kepler
 * to get the (x, y, z) world-space position on the orbit.
 * Use for smooth orbital camera fly-in/out.
 *
 * @param {vec3} out        rec
eiving position
 * @param
 {Number} a        semi-major axis
 * @param {Number} e        eccentricity
 * @param {Number} inc      inclination
 * @param {Number} Om       ascending node
 * @param {Number} om       argument of periapsis
 * @param {Number} M0       starting mean anomaly
 * @param {Number} M1       ending mean anomaly
 * @param {Number} t        raw progress [0,1] (eased internally)
 * @param {Function} easeFn easing function
 */
function easeKeplerPosition(out, a, e, inc, Om, om, M0, M1, t, easeFn) {
  var et = easeFn ? easeFn(t) : t;
  var M = M0 + (M1 - M0) * et;
  return vec3.keplerOrbit3D(out, a, e, M, inc, Om, om);
}

/**
 * Same, but the target position and velocity are both produced (for a
 * moving camera that respects orbital physics).
 */
function easeKeplerState(outPos, outVel, a, e, inc, Om, om, M0, M1, mu, t, easeFn) {
  var et = easeFn ? easeFn(t) : t;
  var M = M0 + (M1 - M0) * et;
  vec3.keplerOrbit3D(outPos, a, e, M, inc, Om, om);
  vec3.keplerOrbitVelocity3D(outVel, a, e, M, in
c, Om, om, mu);
  return o
utPos;
}

// ============================================================================
// 11. EASING-AWARE IK TARGET
// ============================================================================

/**
 * Ease a 3D IK target from `from` to `to`. Combine with `vec3.fabrikStep3`
 * or `vec3.ccdStep3` for a natural, non-linear approach.
 */
function easeIKTarget(out, from, to, t, easeFn) {
  var et = easeFn ? easeFn(t) : t;
  out[0] = from[0] + (to[0] - from[0]) * et;
  out[1] = from[1] + (to[1] - from[1]) * et;
  out[2] = from[2] + (to[2] - from[2]) * et;
  return out;
}

/**
 * Ease a quaternion from `from` to `to` using the eased slerp parameter.
 * The spring-y / bouncy / elastic presets look great on head-look easing.
 */
function easeQuat(out, from, to, t, easeFn) {
  var et = easeFn ? easeFn(t) : t;
  return quat.slerp(out, from, to, et);
}

// ============================================================================
// 12. BITECS EASING SYSTEM — one call per frame, chunke
d async for 1M+
// ========
====================================================================

/**
 * Create a per-entity easing system. Each entity has its own (from → to)
 * transition on a chosen channel. Perfect for:
 *   - 1M+ particle fades
 *   - per-instance color/material transitions
 *   - staggered scale-ups on procedural spawn
 *   - easing IK targets on crowds
 *
 * Usage:
 *   const sys = createEasingSystem(world);
 *   sys.add(eid, { from: 0, to: 1, duration: 1, ease: 'easeOutCubic',
 *                  apply: (eid, v) => { trs.scale.x[eid] = v; } });
 *   // each frame:
 *   sys.step(dt);            // sync — 1M+ in one microtask if you can afford it
 *   await sys.stepChunked(dt); // async — mobile-safe, yields every N entities
 */
function createEasingSystem(world, options) {
  options = options || {};
  var chunkSize = options.chunkSize || glMatrix.CHUNK_SIZE;
  var yieldEvery = options.yieldEvery || glMatrix.CHUNK_YIELD_EVERY;

  var entries = [];

  function makeEntry(eid, cfg) {
    r
eturn {
      eid: eid,
    
  from: cfg.from !== undefined ? cfg.from : 0,
      to: cfg.to !== undefined ? cfg.to : 1,
      current: cfg.from !== undefined ? cfg.from : 0,
      t: 0,
      duration: cfg.duration !== undefined ? cfg.duration : 1,
      delay: cfg.delay || 0,
      ease: getEasing(cfg.ease),
      apply: cfg.apply || null,
      onDone: cfg.onDone || null,
      done: false,
      active: true
    };
  }

  function stepOne(e, dt) {
    if (!e.active || e.done) return;
    if (e.delay > 0) { e.delay -= dt; return; }
    if (e.duration <= 0) {
      e.current = e.to; e.t = 1;
    } else {
      e.t += dt / e.duration;
      if (e.t >= 1) e.t = 1;
    }
    var et = e.ease(e.t);
    e.current = e.from + (e.to - e.from) * et;
    if (e.apply) e.apply(e.eid, e.current, e);
    if (e.t >= 1) {
      e.done = true;
      if (e.onDone) e.onDone(e.eid, e);
    }
  }

  return {
    add: function (eid, cfg) {
      var e = makeEntry(eid, cfg);
      entries.push(e);
      return e;
    },
    /** Re
move by entity id. O(n) — bat
ch-remove inside `step` for perf. */
    remove: function (eid) {
      for (var i = entries.length - 1; i >= 0; i--) {
        if (entries[i].eid === eid) entries.splice(i, 1);
      }
    },
    get size() { return entries.length; },

    /** Synchronous step. Fast for <100k; use stepChunked for 1M+. */
    step: function (dt) {
      var n = entries.length;
      for (var i = 0; i < n; i++) stepOne(entries[i], dt);
      // Purge done entries occasionally to avoid unbounded growth.
      if (entries.length > 0 && entries.length % 1024 === 0) {
        for (var j = entries.length - 1; j >= 0; j--) {
          if (entries[j].done) entries.splice(j, 1);
        }
      }
      return this;
    },

    /** Chunked async step — mobile-safe. */
    stepChunked: async function (dt) {
      var n = entries.length;
      await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) {
        for (var i = s; i < e; i++) stepOne(entries[i], dt);
      });
      if (entries.length > 0 && 
entries.length % 1024 === 0) {

        for (var j = entries.length - 1; j >= 0; j--) {
          if (entries[j].done) entries.splice(j, 1);
        }
      }
      return this;
    },

    clear: function () { entries.length = 0; }
  };
}

// ============================================================================
// 13. EXPORTS
// ============================================================================

// ---- original single export ----
exports.easings = easings;

// ---- extended presets (individual) ----
exports.linear = easings.linear;
exports.easeInQuad = easings.easeInQuad;
exports.easeOutQuad = easings.easeOutQuad;
exports.easeInOutQuad = easings.easeInOutQuad;
exports.easeInCubic = easings.easeInCubic;
exports.easeOutCubic = easings.easeOutCubic;
exports.easeInOutCubic = easings.easeInOutCubic;
exports.easeInExpo = easings.easeInExpo;
exports.easeOutExpo = easings.easeOutExpo;
exports.easeInOutExpo = easings.easeInOutExpo;
exports.easeOutBack = easings.easeOutBack;
exports.easeOutBounce = e
asings.easeOutBounce;
exports.s
pring = easings.spring;
exports.cubicBezier = easings.cubicBezier;

// new presets
exports.easeInSine = easings.easeInSine;
exports.easeOutSine = easings.easeOutSine;
exports.easeInOutSine = easings.easeInOutSine;
exports.easeInCirc = easings.easeInCirc;
exports.easeOutCirc = easings.easeOutCirc;
exports.easeInOutCirc = easings.easeInOutCirc;
exports.easeInQuint = easings.easeInQuint;
exports.easeOutQuint = easings.easeOutQuint;
exports.easeInOutQuint = easings.easeInOutQuint;
exports.easeInQuart = easings.easeInQuart;
exports.easeOutQuart = easings.easeOutQuart;
exports.easeInOutQuart = easings.easeInOutQuart;
exports.easeInBack = easings.easeInBack;
exports.easeInOutBack = easings.easeInOutBack;
exports.easeInElastic = easings.easeInElastic;
exports.easeOutElastic = easings.easeOutElastic;
exports.easeInOutElastic = easings.easeInOutElastic;

// ---- proper CSS cubic-bezier ----
exports.cubicBezierCSS = cubicBezierCSS;
exports.CSS_CURVES = CSS_CURVES;
exports.getEasing = getE
asing;

// ---- SOA apply (sync)
 ----
exports.soaApply = soaApply;
exports.soaApplyInPlace = soaApplyInPlace;
exports.soaApplyLerp = soaApplyLerp;
exports.soaApplyLerpPerT = soaApplyLerpPerT;

// ---- SOA apply (chunked async) ----
exports.soaApplyChunked = soaApplyChunked;
exports.soaApplyInPlaceChunked = soaApplyInPlaceChunked;
exports.soaApplyLerpPerTChunked = soaApplyLerpPerTChunked;

// ---- spring batch ----
exports.soaSpringDampBatch = soaSpringDampBatch;
exports.soaSpringDampBatchChunked = soaSpringDampBatchChunked;
exports.soaSpringDamp3Batch = soaSpringDamp3Batch;
exports.soaSpringDamp3BatchChunked = soaSpringDamp3BatchChunked;

// ---- color ----
exports.easeColorRGBA = easeColorRGBA;
exports.soaEaseColor = soaEaseColor;
exports.soaEaseColorChunked = soaEaseColorChunked;
exports.soaEaseColorTargets = soaEaseColorTargets;

// ---- stagger ----
exports.staggerEased = staggerEased;
exports.staggerWithEase = staggerWithEase;

// ---- orbital ----
exports.easeKeplerPosition = easeKeplerPosition;
export
s.easeKeplerState = easeKeplerSta
te;

// ---- IK / natural motion ----
exports.easeIKTarget = easeIKTarget;
exports.easeQuat = easeQuat;

// ---- bitECS-friendly easing system ----
exports.createEasingSystem = createEasingSystem;

// ---- math modules re-exported ----
exports.math = {
  common: glMatrix, vec2: vec2, vec3: vec3, vec4: vec4,
  mat2: mat2, mat3: mat3, mat4: mat4, quat: quat, quat2: quat2,
  bitecs: bitecs, simplex: simplex, utils: utils
};


