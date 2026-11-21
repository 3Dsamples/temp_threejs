// File : src/math/082_vector-bloom-point.js
//description : Zero-GC SOA point/vector foundation for the Vector-Bloom procedural flora
//              engine — pooled scalar point ops, parallel-array point buffers, polar and
//              spherical construction for radial flower symmetry, 2D/3D rotation, quadratic/
//              cubic Bézier, Catmull-Rom and Hermite evaluation, radial replication for
//              petal/whorl instancing, and an OPEN width-profile registry so new petals,
//              sepals, leaves, grasses, needles and bracts can be registered at runtime
//              without touching the core. Every hot loop is allocation-free and every
//              long loop has a chunked async twin yielding via scheduler.yield().
//best for : 3d graphics — 1M+ instanced petal/leaf/grass control-point generation, radial
//           whorl and phyllotaxis placement, JSON-driven flower outline sampling, SVG/Canvas/
//           WebGL vertex emission, procedural meadow and foliage fields, LOD outline
//           decimation, deterministic per-instance jitter, and mobile-safe chunked async
//           flora generation on Android 64-bit at 60/120 fps.
//license : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — core math subsystem)
// ============================================================================
import {
    common,
    getArrayType,
    onPrecisionChange,
    createVec3SOA,
    trackSOA,
    untrackSOA
} from './000_Math_module.js';

// ============================================================================
// Global Declarations — constants
// ============================================================================
const PI      = Math.PI;
const TAU     = PI * 2;
const HALF_PI = PI * 0.5;
const EPSILON = 1e-12;

// Golden angle — phyllotaxis (leaf/seed spiral) placement.
const GOLDEN_ANGLE = PI * (3 - Math.sqrt(5));

// Profile kinds.
const PROFILE_CLOSED = 0;   // mirrored outline (petal, leaf, sepal)
const PROFILE_BLADE  = 1;   // single-sided blade (grass, needle)

// ============================================================================
// Variable Declarations — module scratch (init-time only)
// ============================================================================
const _p0 = new Float64Array(3);
const _p1 = new Float64Array(3);
const _p2 = new Float64Array(3);
const _p3 = new Float64Array(3);
const _pw = new Float64Array(3);   // profile writer scratch

// ============================================================================
// Function Declarations — internal hoisted helpers (closure-free)
// ============================================================================
function _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Deterministic 3D integer hash → [0,1). Used for per-instance jitter. */
function _hash01(x, y, z) {
    let h = (Math.imul(x | 0, 0x1B873593) ^ 0x9E3779B9) >>> 0;
    h = (Math.imul(h ^ (h >>> 16), 0x85EBCA6B) + Math.imul(y | 0, 0xCC9E2D51)) >>> 0;
    h = (Math.imul(h ^ (h >>> 13), 0xC2B2AE35) + Math.imul(z | 0, 0x85EBCA77)) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}

// ============================================================================
// Scratch pool — shared hoisted ensure, buffer-preserving release
// ============================================================================
function _pointScratchEnsure(s, n) {
    if (n <= s.size) return s;
    const T = getArrayType();
    s.size = n;
    s.a = new T(n * 3);
    s.b = new T(n * 3);
    s.c = new T(n * 3);
    return s;
}

function _pointScratchFactory() {
    const T = getArrayType();
    return {
        a: new T(768), b: new T(768), c: new T(768),
        size: 256, ensure: _pointScratchEnsure
    };
}

function _pointScratchReset(s) { /* buffers retained for Zero-GC reuse */ }

const _pointScratchPool = common.createPool(_pointScratchFactory, 8, _pointScratchReset);

for (let _pw0 = 0; _pw0 < 8; _pw0++) {
    const _s = _pointScratchPool.acquire() || _pointScratchFactory();
    _pointScratchPool.release(_s);
}

function acquirePointScratch(size) {
    const s = _pointScratchPool.acquire() || _pointScratchFactory();
    if (size !== undefined) s.ensure(size);
    return s;
}

function releasePointScratch(s) { if (s) _pointScratchPool.release(s); }

function createPointScratchPool(capacity) {
    return common.createPool(_pointScratchFactory, capacity || 8, _pointScratchReset);
}

// ============================================================================
// Class Declarations — PointSOA (parallel-array point buffer)
// ============================================================================
/**
 * PointSOA — Structure-of-Arrays point storage. `x`, `y`, `z` are parallel
 * precision-aware typed arrays. `arrays` + `components` are exposed so the
 * core `migrateSOAInPlace` can live-swap f16/f32/f64 without rebuilding.
 */
class PointSOA {
    constructor(count, Type) {
        const T = Type || getArrayType();
        this.capacity   = count || 0;
        this.count      = count || 0;
        this.components = 3;
        this.x = new T(this.capacity);
        this.y = new T(this.capacity);
        this.z = new T(this.capacity);
        this.arrays = [this.x, this.y, this.z];
    }
    set(i, x, y, z) {
        this.x[i] = x; this.y[i] = y; this.z[i] = z === undefined ? 0 : z;
        return this;
    }
    /** Grow-only resize. Existing values are preserved. */
    resize(n) {
        if (n <= this.capacity) { this.count = n; return this; }
        const T = this.x.constructor;
        const nx = new T(n); nx.set(this.x);
        const ny = new T(n); ny.set(this.y);
        const nz = new T(n); nz.set(this.z);
        this.x = nx; this.y = ny; this.z = nz;
        this.arrays[0] = nx; this.arrays[1] = ny; this.arrays[2] = nz;
        this.capacity = n;
        this.count = n;
        return this;
    }
    fill(x, y, z) {
        this.x.fill(x); this.y.fill(y); this.z.fill(z === undefined ? 0 : z);
        return this;
    }
    track()   { trackSOA(this); return this; }
    untrack() { untrackSOA(this); return this; }
}

function createPointSOA(count, Type) { return new PointSOA(count, Type); }

/** Wrap an existing vec3 SOA as a PointSOA view (no copy). */
function pointSOAFromVec3(vec3soa) {
    const p = new PointSOA(0);
    p.capacity = vec3soa.count;
    p.count    = vec3soa.count;
    p.x = vec3soa.x; p.y = vec3soa.y; p.z = vec3soa.z;
    p.arrays[0] = p.x; p.arrays[1] = p.y; p.arrays[2] = p.z;
    return p;
}

// ============================================================================
// Class Declarations — PointScratch (fixed-capacity, swap-remove)
// ============================================================================
class PointScratch {
    static #pool = new Array(32);
    static #count = 0;
    static {
        for (let i = 0; i < 8; i++) PointScratch.#pool[PointScratch.#count++] = new PointScratch(256);
    }
    static acquire(size) {
        for (let i = 0; i < PointScratch.#count; i++) {
            if (PointScratch.#pool[i].size >= (size || 0)) {
                const s = PointScratch.#pool[i];
                PointScratch.#count--;
                PointScratch.#pool[i] = PointScratch.#pool[PointScratch.#count];
                PointScratch.#pool[PointScratch.#count] = null;
                return s;
            }
        }
        return new PointScratch(size || 256);
    }
    static release(s) {
        if (!s) return;
        s.reset();
        if (PointScratch.#count < 32) PointScratch.#pool[PointScratch.#count++] = s;
    }
    constructor(size) {
        this.size = size || 256;
        const T = getArrayType();
        this.a = new T(this.size * 3);
        this.b = new T(this.size * 3);
        this.c = new T(this.size * 3);
    }
    ensure(n) { return _pointScratchEnsure(this, n); }
    reset() { this.a.fill(0); this.b.fill(0); this.c.fill(0); return this; }
}

// ============================================================================
// Function Declarations — scalar point ops (out-parameter, Zero-GC)
// ============================================================================
function setPoint(out, x, y, z) {
    out[0] = x; out[1] = y; out[2] = z === undefined ? 0 : z;
    return out;
}

function copyPoint(out, a) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
    return out;
}

function addPoint(out, a, b) {
    out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
    return out;
}

function subPoint(out, a, b) {
    out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
    return out;
}

function scalePoint(out, a, s) {
    out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
    return out;
}

function scalePoint3(out, a, sx, sy, sz) {
    out[0] = a[0] * sx; out[1] = a[1] * sy; out[2] = a[2] * sz;
    return out;
}

function lerpPoint(out, a, b, t) {
    const u = 1 - t;
    out[0] = a[0] * u + b[0] * t;
    out[1] = a[1] * u + b[1] * t;
    out[2] = a[2] * u + b[2] * t;
    return out;
}

function distanceSqPoint(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    return dx * dx + dy * dy + dz * dz;
}

function distancePoint(a, b) { return Math.sqrt(distanceSqPoint(a, b)); }

function lengthSqPoint(a) { return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]; }

function lengthPoint(a) { return Math.sqrt(lengthSqPoint(a)); }

function dotPoint(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function crossPoint(out, a, b) {
    const ax = a[0], ay = a[1], az = a[2];
    const bx = b[0], by = b[1], bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
}

function normalizePoint(out, a) {
    const l = lengthPoint(a);
    const inv = l > EPSILON ? 1 / l : 0;
    out[0] = a[0] * inv; out[1] = a[1] * inv; out[2] = a[2] * inv;
    return out;
}

/** Rotate about +Z (2D rotation in the XY plane). */
function rotatePoint2D(out, a, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const x = a[0], y = a[1];
    out[0] = x * c - y * s;
    out[1] = x * s + y * c;
    out[2] = a[2];
    return out;
}

/** Rodrigues rotation about an arbitrary unit axis (3D). */
function rotatePointAxisAngle(out, a, ax, ay, az, angle) {
    const l = Math.sqrt(ax * ax + ay * ay + az * az);
    if (l < EPSILON) { return copyPoint(out, a); }
    const inv = 1 / l;
    const ux = ax * inv, uy = ay * inv, uz = az * inv;
    const c = Math.cos(angle), s = Math.sin(angle), k = 1 - c;
    const x = a[0], y = a[1], z = a[2];
    const d = ux * x + uy * y + uz * z;
    const cx = uy * z - uz * y, cy = uz * x - ux * z, cz = ux * y - uy * x;
    out[0] = x * c + cx * s + ux * d * k;
    out[1] = y * c + cy * s + uy * d * k;
    out[2] = z * c + cz * s + uz * d * k;
    return out;
}

/** Polar (r, θ) in the XY plane → Cartesian. */
function polarToPoint(out, r, theta, z) {
    out[0] = r * Math.cos(theta);
    out[1] = r * Math.sin(theta);
    out[2] = z === undefined ? 0 : z;
    return out;
}

/** Cartesian → polar. Writes out[0]=r, out[1]=θ, out[2]=z. */
function pointToPolar(out, a) {
    out[0] = Math.sqrt(a[0] * a[0] + a[1] * a[1]);
    out[1] = Math.atan2(a[1], a[0]);
    out[2] = a[2];
    return out;
}

/** Spherical (r, inclination from +Y, azimuth in XZ) → Cartesian. */
function sphericalToPoint(out, r, inclination, azimuth) {
    const si = Math.sin(inclination);
    out[0] = r * si * Math.cos(azimuth);
    out[1] = r * Math.cos(inclination);
    out[2] = r * si * Math.sin(azimuth);
    return out;
}

// ============================================================================
// Function Declarations — curve evaluation (out-parameter, Zero-GC)
// ============================================================================
function quadraticBezierPoint(out, p0, p1, p2, t) {
    const u = 1 - t, uu = u * u, tt = t * t, ut = 2 * u * t;
    out[0] = uu * p0[0] + ut * p1[0] + tt * p2[0];
    out[1] = uu * p0[1] + ut * p1[1] + tt * p2[1];
    out[2] = uu * p0[2] + ut * p1[2] + tt * p2[2];
    return out;
}

function cubicBezierPoint(out, p0, p1, p2, p3, t) {
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    out[0] = b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0];
    out[1] = b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1];
    out[2] = b0 * p0[2] + b1 * p1[2] + b2 * p2[2] + b3 * p3[2];
    return out;
}

/** Uniform Catmull-Rom spline segment between p1 and p2. */
function catmullRomPoint(out, p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    const q0 = -0.5 * t3 + t2 - 0.5 * t;
    const q1 =  1.5 * t3 - 2.5 * t2 + 1;
    const q2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
    const q3 =  0.5 * t3 - 0.5 * t2;
    out[0] = q0 * p0[0] + q1 * p1[0] + q2 * p2[0] + q3 * p3[0];
    out[1] = q0 * p0[1] + q1 * p1[1] + q2 * p2[1] + q3 * p3[1];
    out[2] = q0 * p0[2] + q1 * p1[2] + q2 * p2[2] + q3 * p3[2];
    return out;
}

function hermitePoint(out, p0, m0, p1, m1, t) {
    const t2 = t * t, t3 = t2 * t;
    const h00 =  2 * t3 - 3 * t2 + 1;
    const h10 =      t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 =      t3 -     t2;
    out[0] = h00 * p0[0] + h10 * m0[0] + h01 * p1[0] + h11 * m1[0];
    out[1] = h00 * p0[1] + h10 * m0[1] + h01 * p1[1] + h11 * m1[1];
    out[2] = h00 * p0[2] + h10 * m0[2] + h01 * p1[2] + h11 * m1[2];
    return out;
}

// ============================================================================
// Profile registry — OPEN, extensible (no Map / Set)
// ----------------------------------------------------------------------------
// A profile is a width function: fn(u, out) where u ∈ [0,1] runs base → tip.
//   out[0] = halfWidth at u
//   out[1] = height   at u   (default u; override for notched / bent shapes)
//   out[2] = depth    at u   (default 0; override for curled blades)
// Closed outlines mirror the width; blades use one side. Register new petals,
// leaves, grasses, bracts or needles at runtime with registerPointProfile().
// ============================================================================
const _profileRegistry = Object.create(null);
const _profileNames = [];
const _profileKinds = [];

function registerPointProfile(name, fn, kind) {
    if (_profileRegistry[name] === undefined) {
        _profileNames.push(name);
        _profileKinds.push(kind === PROFILE_BLADE ? PROFILE_BLADE : PROFILE_CLOSED);
    } else {
        const idx = _profileNames.indexOf(name);
        _profileKinds[idx] = kind === PROFILE_BLADE ? PROFILE_BLADE : PROFILE_CLOSED;
    }
    _profileRegistry[name] = fn;
    return fn;
}

function getPointProfile(nameOrFn) {
    if (typeof nameOrFn === "function") return nameOrFn;
    const f = _profileRegistry[String(nameOrFn || "petal-ovate")];
    if (f === undefined) return _profileRegistry["petal-ovate"];
    return f;
}

function hasPointProfile(name) { return _profileRegistry[name] !== undefined; }

/** Frozen-at-init name list (do not mutate). */
function listPointProfiles() { return _profileNames; }

function pointProfileKind(name) {
    const i = _profileNames.indexOf(name);
    return i < 0 ? PROFILE_CLOSED : _profileKinds[i];
}

// ---- Built-in width profiles (init-time registration) ----------------------
// Each writes halfWidth / height / depth into a 3-slot scratch. No allocation.

registerPointProfile("petal-ovate", function (u, out) {
    const s = Math.sin(PI * Math.pow(u, 0.72));
    out[0] = 0.5 * s * (1 - 0.28 * u);
    out[1] = u;
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("petal-obovate", function (u, out) {
    const s = Math.sin(PI * Math.pow(u, 1.45));
    out[0] = 0.5 * s;
    out[1] = u;
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("petal-obcordate", function (u, out) {
    const s = Math.sin(PI * Math.pow(u, 1.3));
    out[0] = 0.5 * s;
    // Heart-shaped notch at the tip.
    out[1] = u - 0.10 * Math.pow(_clamp01((u - 0.86) / 0.14), 2);
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("petal-spatulate", function (u, out) {
    const narrow = 0.16 * Math.sin(PI * Math.min(1, u / 0.62));
    const head   = 0.5 * Math.sin(PI * _clamp01((u - 0.55) / 0.45));
    out[0] = Math.max(narrow, head);
    out[1] = u;
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("leaf-lanceolate", function (u, out) {
    out[0] = 0.30 * Math.sin(PI * Math.pow(u, 0.85)) * (1 - 0.35 * u);
    out[1] = u;
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("leaf-elliptic", function (u, out) {
    out[0] = 0.42 * Math.sin(PI * u);
    out[1] = u;
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("leaf-cordate", function (u, out) {
    const body = 0.52 * Math.sin(PI * Math.pow(u, 0.62));
    const lobe = 0.20 * Math.sin(PI * _clamp01(u / 0.18));
    out[0] = Math.max(body, lobe);
    out[1] = u - 0.06 * (1 - _clamp01(u / 0.12));
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("leaf-deltoid", function (u, out) {
    out[0] = 0.55 * (1 - u) * Math.pow(Math.sin(PI * Math.min(1, u / 0.9)), 0.35);
    out[1] = u;
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("leaf-serrate", function (u, out) {
    const base = 0.40 * Math.sin(PI * Math.pow(u, 0.8));
    const teeth = 1 + 0.10 * Math.sin(u * 46);
    out[0] = base * teeth;
    out[1] = u;
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("leaf-lobed", function (u, out) {
    const base = 0.44 * Math.sin(PI * Math.pow(u, 0.75));
    const lobes = 1 + 0.26 * Math.sin(u * 5 * PI);
    out[0] = base * lobes;
    out[1] = u;
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("sepal-linear", function (u, out) {
    out[0] = 0.16 * Math.sin(PI * Math.pow(u, 0.6)) * (1 - 0.5 * u);
    out[1] = u;
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("bract-acute", function (u, out) {
    out[0] = 0.24 * Math.pow(1 - u, 0.7) * Math.sin(PI * Math.min(1, u / 0.95));
    out[1] = u;
    out[2] = 0;
}, PROFILE_CLOSED);

registerPointProfile("grass-blade", function (u, out) {
    out[0] = 0.055 * Math.sin(PI * Math.pow(u, 0.55)) * (1 - 0.75 * u);
    out[1] = u;
    // Gentle wind-ward curl in depth.
    out[2] = 0.10 * u * u;
}, PROFILE_BLADE);

registerPointProfile("grass-fescue", function (u, out) {
    out[0] = 0.022 * (1 - u) * Math.pow(Math.sin(PI * Math.min(1, u / 0.98)), 0.4);
    out[1] = u;
    out[2] = 0.18 * u * u;
}, PROFILE_BLADE);

registerPointProfile("grass-sedge", function (u, out) {
    out[0] = 0.040 * Math.sin(PI * Math.pow(u, 0.45)) * (1 - 0.85 * u);
    out[1] = u;
    out[2] = 0.05 * Math.sin(u * PI);
}, PROFILE_BLADE);

registerPointProfile("needle-pine", function (u, out) {
    out[0] = 0.014 * Math.sin(PI * Math.pow(u, 0.35)) * (1 - 0.9 * u);
    out[1] = u;
    out[2] = 0;
}, PROFILE_BLADE);

registerPointProfile("stamen-filament", function (u, out) {
    out[0] = 0.018 * (1 - 0.55 * u);
    out[1] = u;
    out[2] = 0.04 * u * u;
}, PROFILE_BLADE);

registerPointProfile("unit-circle", function (u, out) {
    const a = u * TAU;
    out[0] = 0.5 * Math.cos(a);
    out[1] = 0.5 + 0.5 * Math.sin(a);
    out[2] = 0;
}, PROFILE_CLOSED);

// ============================================================================
// Function Declarations — profile sampling (Zero-GC)
// ============================================================================
/**
 * Sample a closed, mirrored outline into a PointSOA.
 * Writes 2 × segments points: right side base→tip, then left side tip→base.
 * Returns the number of points written.
 */
function sampleProfileOutline(outPoints, profile, segments, scaleX, scaleY, offset) {
    const fn = getPointProfile(profile);
    const sx = scaleX === undefined ? 1 : scaleX;
    const sy = scaleY === undefined ? 1 : scaleY;
    const base = offset === undefined ? 0 : offset;
    const seg = segments < 2 ? 2 : segments;
    const need = base + seg * 2;
    if (outPoints.capacity < need) outPoints.resize(need);
    const ox = outPoints.x, oy = outPoints.y, oz = outPoints.z;
    const inv = 1 / (seg - 1);
    for (let i = 0; i < seg; i++) {
        const u = i * inv;
        fn(u, _pw);
        const o = base + i;
        ox[o] = _pw[0] * sx;
        oy[o] = _pw[1] * sy;
        oz[o] = _pw[2] * sy;
    }
    for (let i = 0; i < seg; i++) {
        const u = 1 - i * inv;
        fn(u, _pw);
        const o = base + seg + i;
        ox[o] = -_pw[0] * sx;
        oy[o] =  _pw[1] * sy;
        oz[o] =  _pw[2] * sy;
    }
    outPoints.count = need > outPoints.count ? need : outPoints.count;
    return seg * 2;
}

/**
 * Sample a single-sided blade (grass / needle / filament) into a PointSOA.
 * Writes `segments` points along the centreline-offset edge.
 */
function sampleProfileBlade(outPoints, profile, segments, scaleX, scaleY, offset) {
    const fn = getPointProfile(profile);
    const sx = scaleX === undefined ? 1 : scaleX;
    const sy = scaleY === undefined ? 1 : scaleY;
    const base = offset === undefined ? 0 : offset;
    const seg = segments < 2 ? 2 : segments;
    const need = base + seg;
    if (outPoints.capacity < need) outPoints.resize(need);
    const ox = outPoints.x, oy = outPoints.y, oz = outPoints.z;
    const inv = 1 / (seg - 1);
    for (let i = 0; i < seg; i++) {
        fn(i * inv, _pw);
        const o = base + i;
        ox[o] = _pw[0] * sx;
        oy[o] = _pw[1] * sy;
        oz[o] = _pw[2] * sy;
    }
    outPoints.count = need > outPoints.count ? need : outPoints.count;
    return seg;
}

// ============================================================================
// Function Declarations — SOA (sync, Zero-GC)
// ============================================================================
function soaPointSet(out, x, y, z, count) {
    const n = count === undefined ? out.count : count;
    out.x.fill(x, 0, n); out.y.fill(y, 0, n); out.z.fill(z === undefined ? 0 : z, 0, n);
    return out;
}

function soaPointCopy(out, src, count) {
    const n = count === undefined ? src.count : count;
    if (out.capacity < n) out.resize(n);
    const ox = out.x, oy = out.y, oz = out.z;
    const ix = src.x, iy = src.y, iz = src.z;
    for (let i = 0; i < n; i++) { ox[i] = ix[i]; oy[i] = iy[i]; oz[i] = iz[i]; }
    out.count = n;
    return out;
}

function soaPointLerp(out, a, b, t, count) {
    const n = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    const isArr = t && t.BYTES_PER_ELEMENT !== undefined;
    const u = isArr ? 0 : 1 - t;
    for (let i = 0; i < n; i++) {
        const ti = isArr ? t[i] : t;
        const ui = isArr ? 1 - ti : u;
        ox[i] = ax[i] * ui + bx[i] * ti;
        oy[i] = ay[i] * ui + by[i] * ti;
        oz[i] = az[i] * ui + bz[i] * ti;
    }
    return out;
}

function soaPointTranslate(out, dx, dy, dz, count) {
    const n = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const zz = dz === undefined ? 0 : dz;
    for (let i = 0; i < n; i++) { ox[i] += dx; oy[i] += dy; oz[i] += zz; }
    return out;
}

function soaPointScale(out, sx, sy, sz, count) {
    const n = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const isArr = sx && sx.BYTES_PER_ELEMENT !== undefined;
    for (let i = 0; i < n; i++) {
        if (isArr) { ox[i] *= sx[i]; oy[i] *= sy[i]; oz[i] *= sz[i]; }
        else { ox[i] *= sx; oy[i] *= sy; oz[i] *= sz; }
    }
    return out;
}

function soaPointRotate2D(out, angle, count) {
    const n = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y;
    const isArr = angle && angle.BYTES_PER_ELEMENT !== undefined;
    let c, s;
    if (!isArr) { c = Math.cos(angle); s = Math.sin(angle); }
    for (let i = 0; i < n; i++) {
        if (isArr) { c = Math.cos(angle[i]); s = Math.sin(angle[i]); }
        const x = ox[i], y = oy[i];
        ox[i] = x * c - y * s;
        oy[i] = x * s + y * c;
    }
    return out;
}

function soaPointRotateAxisAngle(out, ax, ay, az, angle, count) {
    const n = count === undefined ? out.count : count;
    const l = Math.sqrt(ax * ax + ay * ay + az * az);
    if (l < EPSILON) return out;
    const inv = 1 / l;
    const ux = ax * inv, uy = ay * inv, uz = az * inv;
    const c = Math.cos(angle), s = Math.sin(angle), k = 1 - c;
    const ox = out.x, oy = out.y, oz = out.z;
    for (let i = 0; i < n; i++) {
        const x = ox[i], y = oy[i], z = oz[i];
        const d = ux * x + uy * y + uz * z;
        const cx = uy * z - uz * y, cy = uz * x - ux * z, cz = ux * y - uy * x;
        ox[i] = x * c + cx * s + ux * d * k;
        oy[i] = y * c + cy * s + uy * d * k;
        oz[i] = z * c + cz * s + uz * d * k;
    }
    return out;
}

function soaPointMirrorX(out, count) {
    const n = count === undefined ? out.count : count;
    const ox = out.x;
    for (let i = 0; i < n; i++) ox[i] = -ox[i];
    return out;
}

function soaPointNormalize(out, count) {
    const n = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    for (let i = 0; i < n; i++) {
        const x = ox[i], y = oy[i], z = oz[i];
        const l = Math.sqrt(x * x + y * y + z * z);
        const inv = l > EPSILON ? 1 / l : 0;
        ox[i] = x * inv; oy[i] = y * inv; oz[i] = z * inv;
    }
    return out;
}

/** Deterministic per-point jitter — no RNG state, stable across frames. */
function soaPointJitter(out, amount, seed, count) {
    const n = count === undefined ? out.count : count;
    const sd = seed === undefined ? 0 : seed | 0;
    const ox = out.x, oy = out.y, oz = out.z;
    for (let i = 0; i < n; i++) {
        ox[i] += (_hash01(i, sd, 0x11) * 2 - 1) * amount;
        oy[i] += (_hash01(i, sd, 0x22) * 2 - 1) * amount;
        oz[i] += (_hash01(i, sd, 0x33) * 2 - 1) * amount;
    }
    return out;
}

/** Fill a PointSOA from polar coordinates (radial whorl scaffolding). */
function soaPointFromPolar(out, radii, thetas, zs, count) {
    const n = count === undefined ? out.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const zArr = zs && zs.BYTES_PER_ELEMENT !== undefined;
    for (let i = 0; i < n; i++) {
        const r = radii[i], a = thetas[i];
        ox[i] = r * Math.cos(a);
        oy[i] = r * Math.sin(a);
        oz[i] = zArr ? zs[i] : (zs === undefined ? 0 : zs);
    }
    return out;
}

/**
 * Radial replication — the core floral operation. Copies a source outline
 * `copies` times around the origin, each rotated by 2π/copies and pushed out
 * by `radius`. Writes into `out` at `copies × srcCount` stride. Zero-GC.
 */
function soaPointReplicateRadial(out, src, srcCount, copies, radius, phase, twist) {
    const need = copies * srcCount;
    if (out.capacity < need) out.resize(need);
    const ox = out.x, oy = out.y, oz = out.z;
    const ix = src.x, iy = src.y, iz = src.z;
    const ph = phase === undefined ? 0 : phase;
    const tw = twist === undefined ? 0 : twist;
    const step = TAU / copies;
    for (let c = 0; c < copies; c++) {
        const a = ph + c * step;
        const ca = Math.cos(a), sa = Math.sin(a);
        const ct = Math.cos(tw * c), st = Math.sin(tw * c);
        const base = c * srcCount;
        const px = radius * ca, py = radius * sa;
        for (let i = 0; i < srcCount; i++) {
            const x = ix[i], y = iy[i];
            const o = base + i;
            ox[o] = x * ca - y * sa + px;
            oy[o] = x * sa + y * ca + py;
            oz[o] = iz[i] * ct;
        }
    }
    out.count = need;
    return need;
}

/**
 * Phyllotaxis replication — golden-angle spiral placement for leaves, seeds
 * and florets. Radius grows as sqrt(index) for even area coverage.
 */
function soaPointReplicatePhyllotaxis(out, src, srcCount, copies, spread, scaleFalloff) {
    const need = copies * srcCount;
    if (out.capacity < need) out.resize(need);
    const ox = out.x, oy = out.y, oz = out.z;
    const ix = src.x, iy = src.y, iz = src.z;
    const sf = scaleFalloff === undefined ? 0 : scaleFalloff;
    for (let c = 0; c < copies; c++) {
        const a = c * GOLDEN_ANGLE;
        const r = spread * Math.sqrt(c + 0.5);
        const k = 1 - sf * (c / (copies > 1 ? copies - 1 : 1));
        const ca = Math.cos(a), sa = Math.sin(a);
        const base = c * srcCount;
        const px = r * ca, py = r * sa;
        for (let i = 0; i < srcCount; i++) {
            const x = ix[i] * k, y = iy[i] * k;
            const o = base + i;
            ox[o] = x * ca - y * sa + px;
            oy[o] = x * sa + y * ca + py;
            oz[o] = iz[i] * k;
        }
    }
    out.count = need;
    return need;
}

/** Batch closed-outline sampling — `count` independent outlines, fixed stride. */
function soaSampleProfileOutlines(out, profile, count, segments, scaleX, scaleY) {
    const fn = getPointProfile(profile);
    const seg = segments < 2 ? 2 : segments;
    const stride = seg * 2;
    const need = count * stride;
    if (out.capacity < need) out.resize(need);
    const ox = out.x, oy = out.y, oz = out.z;
    const sx = scaleX && scaleX.BYTES_PER_ELEMENT !== undefined ? null : (scaleX === undefined ? 1 : scaleX);
    const sy = scaleY && scaleY.BYTES_PER_ELEMENT !== undefined ? null : (scaleY === undefined ? 1 : scaleY);
    const sxArr = scaleX && scaleX.BYTES_PER_ELEMENT !== undefined ? scaleX : null;
    const syArr = scaleY && scaleY.BYTES_PER_ELEMENT !== undefined ? scaleY : null;
    const inv = 1 / (seg - 1);
    for (let c = 0; c < count; c++) {
        const kx = sxArr ? sxArr[c] : sx;
        const ky = syArr ? syArr[c] : sy;
        const base = c * stride;
        for (let i = 0; i < seg; i++) {
            fn(i * inv, _pw);
            const o = base + i;
            ox[o] = _pw[0] * kx; oy[o] = _pw[1] * ky; oz[o] = _pw[2] * ky;
        }
        for (let i = 0; i < seg; i++) {
            fn(1 - i * inv, _pw);
            const o = base + seg + i;
            ox[o] = -_pw[0] * kx; oy[o] = _pw[1] * ky; oz[o] = _pw[2] * ky;
        }
    }
    out.count = need;
    return need;
}

/** Batch cubic Bézier sampling — one curve per instance, fixed stride. */
function soaSampleCubicBezier(out, p0, p1, p2, p3, count, segments) {
    const seg = segments < 2 ? 2 : segments;
    const need = count * seg;
    if (out.capacity < need) out.resize(need);
    const ox = out.x, oy = out.y, oz = out.z;
    const a0 = p0.x, a1 = p0.y, a2 = p0.z;
    const b0 = p1.x, b1 = p1.y, b2 = p1.z;
    const c0 = p2.x, c1 = p2.y, c2 = p2.z;
    const d0 = p3.x, d1 = p3.y, d2 = p3.z;
    const inv = 1 / (seg - 1);
    for (let c = 0; c < count; c++) {
        const base = c * seg;
        const x0 = a0[c], y0 = a1[c], z0 = a2[c];
        const x1 = b0[c], y1 = b1[c], z1 = b2[c];
        const x2 = c0[c], y2 = c1[c], z2 = c2[c];
        const x3 = d0[c], y3 = d1[c], z3 = d2[c];
        for (let i = 0; i < seg; i++) {
            const t = i * inv, u = 1 - t;
            const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
            const o = base + i;
            ox[o] = w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3;
            oy[o] = w0 * y0 + w1 * y1 + w2 * y2 + w3 * y3;
            oz[o] = w0 * z0 + w1 * z1 + w2 * z2 + w3 * z3;
        }
    }
    out.count = need;
    return need;
}

/** Uniform Catmull-Rom resample of an existing PointSOA polyline. */
function soaResampleCatmullRom(out, src, srcCount, segmentsPerSpan, closed) {
    if (srcCount < 2) return soaPointCopy(out, src, srcCount);
    const spans = closed ? srcCount : srcCount - 1;
    const seg = segmentsPerSpan < 1 ? 1 : segmentsPerSpan;
    const need = spans * seg;
    if (out.capacity < need) out.resize(need);
    const ox = out.x, oy = out.y, oz = out.z;
    const ix = src.x, iy = src.y, iz = src.z;
    const last = srcCount - 1;
    const inv = 1 / seg;
    for (let s = 0; s < spans; s++) {
        const i0 = closed ? (s - 1 + srcCount) % srcCount : (s > 0 ? s - 1 : 0);
        const i1 = s;
        const i2 = closed ? (s + 1) % srcCount : (s < last ? s + 1 : last);
        const i3 = closed ? (s + 2) % srcCount : (s + 1 < last ? s + 2 : last);
        const x0 = ix[i0], y0 = iy[i0], z0 = iz[i0];
        const x1 = ix[i1], y1 = iy[i1], z1 = iz[i1];
        const x2 = ix[i2], y2 = iy[i2], z2 = iz[i2];
        const x3 = ix[i3], y3 = iy[i3], z3 = iz[i3];
        const base = s * seg;
        for (let i = 0; i < seg; i++) {
            const t = i * inv, t2 = t * t, t3 = t2 * t;
            const q0 = -0.5 * t3 + t2 - 0.5 * t;
            const q1 =  1.5 * t3 - 2.5 * t2 + 1;
            const q2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
            const q3 =  0.5 * t3 - 0.5 * t2;
            const o = base + i;
            ox[o] = q0 * x0 + q1 * x1 + q2 * x2 + q3 * x3;
            oy[o] = q0 * y0 + q1 * y1 + q2 * y2 + q3 * y3;
            oz[o] = q0 * z0 + q1 * z1 + q2 * z2 + q3 * z3;
        }
    }
    out.count = need;
    return need;
}

/** Axis-aligned bounds of a PointSOA. Writes out[0..5] = min/max XYZ. */
function soaPointBounds(out, src, count) {
    const n = count === undefined ? src.count : count;
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    const ix = src.x, iy = src.y, iz = src.z;
    for (let i = 0; i < n; i++) {
        const x = ix[i], y = iy[i], z = iz[i];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    if (n === 0) { mnx = mny = mnz = 0; mxx = mxy = mxz = 0; }
    out[0] = mnx; out[1] = mny; out[2] = mnz;
    out[3] = mxx; out[4] = mxy; out[5] = mxz;
    return out;
}

// ============================================================================
// Function Declarations — SOA (chunked async, inlined loops, zero closures)
// ============================================================================
async function soaPointLerpChunked(out, a, b, t, count, cs, ye) {
    const n = count === undefined ? out.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const ox = out.x, oy = out.y, oz = out.z;
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    const isArr = t && t.BYTES_PER_ELEMENT !== undefined;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const ti = isArr ? t[i] : t;
            const ui = 1 - ti;
            ox[i] = ax[i] * ui + bx[i] * ti;
            oy[i] = ay[i] * ui + by[i] * ti;
            oz[i] = az[i] * ui + bz[i] * ti;
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaPointRotate2DChunked(out, angle, count, cs, ye) {
    const n = count === undefined ? out.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const ox = out.x, oy = out.y;
    const isArr = angle && angle.BYTES_PER_ELEMENT !== undefined;
    let cc = 0, ss = 0;
    if (!isArr) { cc = Math.cos(angle); ss = Math.sin(angle); }
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            const co = isArr ? Math.cos(angle[i]) : cc;
            const si = isArr ? Math.sin(angle[i]) : ss;
            const x = ox[i], y = oy[i];
            ox[i] = x * co - y * si;
            oy[i] = x * si + y * co;
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaPointJitterChunked(out, amount, seed, count, cs, ye) {
    const n = count === undefined ? out.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const sd = seed === undefined ? 0 : seed | 0;
    const ox = out.x, oy = out.y, oz = out.z;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + cs, n);
        for (let i = start; i < end; i++) {
            ox[i] += (_hash01(i, sd, 0x11) * 2 - 1) * amount;
            oy[i] += (_hash01(i, sd, 0x22) * 2 - 1) * amount;
            oz[i] += (_hash01(i, sd, 0x33) * 2 - 1) * amount;
        }
        start = end;
        if (start >= n) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaSampleProfileOutlinesChunked(out, profile, count, segments, scaleX, scaleY, cs, ye) {
    const fn = getPointProfile(profile);
    const seg = segments < 2 ? 2 : segments;
    const stride = seg * 2;
    const need = count * stride;
    if (out.capacity < need) out.resize(need);
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const ox = out.x, oy = out.y, oz = out.z;
    const sxArr = scaleX && scaleX.BYTES_PER_ELEMENT !== undefined ? scaleX : null;
    const syArr = scaleY && scaleY.BYTES_PER_ELEMENT !== undefined ? scaleY : null;
    const sx = sxArr ? 1 : (scaleX === undefined ? 1 : scaleX);
    const sy = syArr ? 1 : (scaleY === undefined ? 1 : scaleY);
    const inv = 1 / (seg - 1);
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let ci = start; ci < end; ci++) {
            const kx = sxArr ? sxArr[ci] : sx;
            const ky = syArr ? syArr[ci] : sy;
            const base = ci * stride;
            for (let i = 0; i < seg; i++) {
                fn(i * inv, _pw);
                const o = base + i;
                ox[o] = _pw[0] * kx; oy[o] = _pw[1] * ky; oz[o] = _pw[2] * ky;
            }
            for (let i = 0; i < seg; i++) {
                fn(1 - i * inv, _pw);
                const o = base + seg + i;
                ox[o] = -_pw[0] * kx; oy[o] = _pw[1] * ky; oz[o] = _pw[2] * ky;
            }
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    out.count = need;
    return need;
}

async function soaPointReplicateRadialChunked(out, src, srcCount, copies, radius, phase, twist, cs, ye) {
    const need = copies * srcCount;
    if (out.capacity < need) out.resize(need);
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const ox = out.x, oy = out.y, oz = out.z;
    const ix = src.x, iy = src.y, iz = src.z;
    const ph = phase === undefined ? 0 : phase;
    const tw = twist === undefined ? 0 : twist;
    const step = TAU / copies;
    let start = 0, c = 0;
    while (start < copies) {
        const end = Math.min(start + cs, copies);
        for (let ci = start; ci < end; ci++) {
            const a = ph + ci * step;
            const ca = Math.cos(a), sa = Math.sin(a);
            const ct = Math.cos(tw * ci);
            const base = ci * srcCount;
            const px = radius * ca, py = radius * sa;
            for (let i = 0; i < srcCount; i++) {
                const x = ix[i], y = iy[i];
                const o = base + i;
                ox[o] = x * ca - y * sa + px;
                oy[o] = x * sa + y * ca + py;
                oz[o] = iz[i] * ct;
            }
        }
        start = end;
        if (start >= copies) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    out.count = need;
    return need;
}

// ============================================================================
// Class Declarations — PointBatchState
// ============================================================================
/**
 * PointBatchState — reusable per-frame point pipeline state for 1M+ control
 * points. Holds a source outline, a working buffer, an output buffer and a
 * bounds scratch. Re-create after setPrecision() to pick up the new type.
 */
class PointBatchState {
    constructor(count, options) {
        options = options || {};
        this.count    = count;
        this.segments = options.segments || 24;
        this.src      = new PointSOA(this.segments * 2);
        this.work     = new PointSOA(count);
        this.out      = new PointSOA(count);
        this.bounds   = new Float64Array(6);
        this.profile  = options.profile || "petal-ovate";
    }
    loadProfile(profile, scaleX, scaleY) {
        this.profile = profile === undefined ? this.profile : profile;
        sampleProfileOutline(this.src, this.profile, this.segments, scaleX, scaleY, 0);
        return this;
    }
    radial(copies, radius, phase, twist) {
        return soaPointReplicateRadial(this.out, this.src, this.segments * 2, copies, radius, phase, twist);
    }
    phyllotaxis(copies, spread, falloff) {
        return soaPointReplicatePhyllotaxis(this.out, this.src, this.segments * 2, copies, spread, falloff);
    }
    jitter(amount, seed) { return soaPointJitter(this.out, amount, seed, this.out.count); }
    getBounds() { return soaPointBounds(this.bounds, this.out, this.out.count); }
    async radialChunked(copies, radius, phase, twist, cs, ye) {
        return soaPointReplicateRadialChunked(this.out, this.src, this.segments * 2, copies, radius, phase, twist, cs, ye);
    }
    reset() { this.src.fill(0, 0, 0); this.work.fill(0, 0, 0); this.out.fill(0, 0, 0); return this; }
}

function createPointBatch(count, options) { return new PointBatchState(count, options); }

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    core: {
        PointSOA, PointScratch, PointBatchState,
        createPointSOA, createPointBatch, pointSOAFromVec3
    },
    scalar: {
        set: setPoint, copy: copyPoint, add: addPoint, sub: subPoint,
        scale: scalePoint, scale3: scalePoint3, lerp: lerpPoint,
        distance: distancePoint, distanceSq: distanceSqPoint,
        length: lengthPoint, lengthSq: lengthSqPoint,
        dot: dotPoint, cross: crossPoint, normalize: normalizePoint,
        rotate2D: rotatePoint2D, rotateAxisAngle: rotatePointAxisAngle,
        polar: polarToPoint, toPolar: pointToPolar, spherical: sphericalToPoint
    },
    curves: {
        quadratic: quadraticBezierPoint,
        cubic: cubicBezierPoint,
        catmullRom: catmullRomPoint,
        hermite: hermitePoint
    },
    profiles: {
        register: registerPointProfile,
        get: getPointProfile,
        has: hasPointProfile,
        list: listPointProfiles,
        kind: pointProfileKind,
        sampleOutline: sampleProfileOutline,
        sampleBlade: sampleProfileBlade,
        CLOSED: PROFILE_CLOSED,
        BLADE: PROFILE_BLADE
    },
    batch: {
        set: soaPointSet, copy: soaPointCopy, lerp: soaPointLerp,
        translate: soaPointTranslate, scale: soaPointScale,
        rotate2D: soaPointRotate2D, rotateAxisAngle: soaPointRotateAxisAngle,
        mirrorX: soaPointMirrorX, normalize: soaPointNormalize,
        jitter: soaPointJitter, fromPolar: soaPointFromPolar,
        replicateRadial: soaPointReplicateRadial,
        replicatePhyllotaxis: soaPointReplicatePhyllotaxis,
        sampleOutlines: soaSampleProfileOutlines,
        sampleCubicBezier: soaSampleCubicBezier,
        resampleCatmullRom: soaResampleCatmullRom,
        bounds: soaPointBounds,
        lerpChunked: soaPointLerpChunked,
        rotate2DChunked: soaPointRotate2DChunked,
        jitterChunked: soaPointJitterChunked,
        sampleOutlinesChunked: soaSampleProfileOutlinesChunked,
        replicateRadialChunked: soaPointReplicateRadialChunked
    },
    pool: {
        PointScratch, createPointScratchPool,
        acquirePointScratch, releasePointScratch
    },
    constants: { PI, TAU, HALF_PI, EPSILON, GOLDEN_ANGLE }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing buffers are retained (Zero-GC); new PointSOA / scratch allocations
// pick up the live array type via getArrayType().
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Core
    PointSOA, PointScratch, PointBatchState,
    createPointSOA, createPointBatch, pointSOAFromVec3,
    // Constants
    PI, TAU, HALF_PI, EPSILON, GOLDEN_ANGLE,
    PROFILE_CLOSED, PROFILE_BLADE,
    // Scalar ops
    setPoint, copyPoint, addPoint, subPoint, scalePoint, scalePoint3, lerpPoint,
    distancePoint, distanceSqPoint, lengthPoint, lengthSqPoint,
    dotPoint, crossPoint, normalizePoint,
    rotatePoint2D, rotatePointAxisAngle,
    polarToPoint, pointToPolar, sphericalToPoint,
    // Curves
    quadraticBezierPoint, cubicBezierPoint, catmullRomPoint, hermitePoint,
    // Profile registry (extensible)
    registerPointProfile, getPointProfile, hasPointProfile,
    listPointProfiles, pointProfileKind,
    sampleProfileOutline, sampleProfileBlade,
    // SOA (sync)
    soaPointSet, soaPointCopy, soaPointLerp, soaPointTranslate, soaPointScale,
    soaPointRotate2D, soaPointRotateAxisAngle, soaPointMirrorX, soaPointNormalize,
    soaPointJitter, soaPointFromPolar,
    soaPointReplicateRadial, soaPointReplicatePhyllotaxis,
    soaSampleProfileOutlines, soaSampleCubicBezier, soaResampleCatmullRom,
    soaPointBounds,
    // SOA (chunked async)
    soaPointLerpChunked, soaPointRotate2DChunked, soaPointJitterChunked,
    soaSampleProfileOutlinesChunked, soaPointReplicateRadialChunked,
    // Pools
    createPointScratchPool, acquirePointScratch, releasePointScratch,
    // Namespace
    namespace
};

// ============================================================================
// ▶ NEXT FILE: 083_vector-bloom-path.js
//   (SOA path-command ring buffer, SVG/Canvas/WebGL emitters, petal / leaf /
//    grass / sepal path builders, morph + LOD decimation, shape registry.)
//   Reply "continue" to generate it.
// ============================================================================