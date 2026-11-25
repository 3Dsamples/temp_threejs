// File number : 003
// File : src/math/003_vec3.js
// Description : 3D vector math (glMatrix API) + SOA bulk layout, pooling, chunked
//               parallelism, 3D procedural noise (value/gradient/fBm/Worley),
//               spherical harmonics, 3D animation curves (bezier, hermite,
//               catmull-rom), natural IK primitives (spring, FABRIK step, CCD
//               step, look-at), and 3D orbital mechanics (Kepler with
//               inclination, vis-viva, Hohmann, position/velocity).
// Best for : 3d graphics core — procedural generation (terrain heightmaps,
//            volumetric clouds, planet surfaces, asteroid fields, star
//            clusters), rendering (lighting, normals, reflections, camera
//            basis, view-space transforms, instanced 1M+ particles/asteroids),
//            color (RGB packed, HDR exposure, chromatic adaptation), animation
//            (3D motion paths, hermite/catmull-rom splines), natural IK motion
//            (FABRIK 3D chains, CCD solvers, spring follow, look-at heads),
//            orbital (planet orbits with inclination, satellites, Hohmann
//            transfers, star/asteroid drift), seamless small-to-galactic scale
//            (floating-origin relative transforms, log-depth friendly
//            positions).
// License : MIT
//
// NOTE: Rewritten as a self-contained native ES module (no Vite / no Vue / no
//       client build) so it loads directly in the browser alongside Three.js
//       r185. The previous CommonJS build is removed. All features, functions
//       and exports of the original are preserved.

// ============================================================================
// 0. SELF-CONTAINED FOUNDATION (replaces require("./001_common.js"))
// ============================================================================
const EPSILON = 0.000001;
const ARRAY_TYPE = (typeof Float32Array !== "undefined") ? Float32Array : Array;
const RANDOM = Math.random;
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;

function roundScalar(value) {
	return Math.round(value);
}

function yieldToMain() {
	return new Promise(function (resolve) {
		if (typeof setTimeout === "function") { setTimeout(resolve, 0); }
		else { resolve(); }
	});
}

// Deterministic 3D spatial hash returning [0,1]
function hash3(x, y, z) {
	var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2246822519)) | 0;
	h = (h ^ (h >>> 13)) | 0;
	h = Math.imul(h, 1274126177) | 0;
	h = (h ^ (h >>> 16)) >>> 0;
	return h / 4294967295;
}

// Newton-Raphson Kepler solver: E - e*sin(E) = M
function keplerSolve(M, e) {
	var E = M;
	for (var i = 0; i < 8; i++) {
		E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
	}
	return E;
}

function createPool(factory, capacity, reset) {
	capacity = capacity || 256;
	var items = [];
	for (var i = 0; i < capacity; i++) { items.push(factory()); }
	return {
		acquire: function () {
			return items.length > 0 ? items.pop() : factory();
		},
		release: function (v) {
			if (reset) { reset(v); }
			if (items.length < capacity) { items.push(v); }
		}
	};
}

function createSOA(count, components, Type) {
	Type = Type || ARRAY_TYPE;
	var bytes = Type.BYTES_PER_ELEMENT || 4;
	var buffer = new ArrayBuffer(count * components * bytes);
	var arrays = [];
	for (var c = 0; c < components; c++) {
		arrays.push(new Type(buffer, c * count * bytes, count));
	}
	return { arrays: arrays, buffer: buffer, count: count, components: components };
}

function soaZeroBase(out) {
	for (var c = 0; c < out.arrays.length; c++) { out.arrays[c].fill(0); }
	return out;
}

function soaFillBase(out, v) {
	for (var c = 0; c < out.arrays.length; c++) { out.arrays[c].fill(v[c]); }
	return out;
}

// ============================================================================
// 1. FLAT API (glMatrix compatible)
// ============================================================================
function create() {
	var out = new ARRAY_TYPE(3);
	if (ARRAY_TYPE !== Float32Array) { out[0] = 0; out[1] = 0; out[2] = 0; }
	return out;
}

function clone(a) {
	var out = new ARRAY_TYPE(3);
	out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
	return out;
}

function length(a) {
	var x = a[0], y = a[1], z = a[2];
	return Math.sqrt(x * x + y * y + z * z);
}

function fromValues(x, y, z) {
	var out = new ARRAY_TYPE(3);
	out[0] = x; out[1] = y; out[2] = z;
	return out;
}

function copy(out, a) {
	out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
	return out;
}

function set(out, x, y, z) {
	out[0] = x; out[1] = y; out[2] = z;
	return out;
}

function add(out, a, b) {
	out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
	return out;
}

function subtract(out, a, b) {
	out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
	return out;
}

function multiply(out, a, b) {
	out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; out[2] = a[2] * b[2];
	return out;
}

function divide(out, a, b) {
	out[0] = a[0] / b[0]; out[1] = a[1] / b[1]; out[2] = a[2] / b[2];
	return out;
}

function ceil(out, a) {
	out[0] = Math.ceil(a[0]); out[1] = Math.ceil(a[1]); out[2] = Math.ceil(a[2]);
	return out;
}

function floor(out, a) {
	out[0] = Math.floor(a[0]); out[1] = Math.floor(a[1]); out[2] = Math.floor(a[2]);
	return out;
}

function min(out, a, b) {
	out[0] = Math.min(a[0], b[0]); out[1] = Math.min(a[1], b[1]); out[2] = Math.min(a[2], b[2]);
	return out;
}

function max(out, a, b) {
	out[0] = Math.max(a[0], b[0]); out[1] = Math.max(a[1], b[1]); out[2] = Math.max(a[2], b[2]);
	return out;
}

function round(out, a) {
	out[0] = roundScalar(a[0]); out[1] = roundScalar(a[1]); out[2] = roundScalar(a[2]);
	return out;
}

function scale(out, a, b) {
	out[0] = a[0] * b; out[1] = a[1] * b; out[2] = a[2] * b;
	return out;
}

function scaleAndAdd(out, a, b, s) {
	out[0] = a[0] + b[0] * s;
	out[1] = a[1] + b[1] * s;
	out[2] = a[2] + b[2] * s;
	return out;
}

function distance(a, b) {
	var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2];
	return Math.sqrt(x * x + y * y + z * z);
}

function squaredDistance(a, b) {
	var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2];
	return x * x + y * y + z * z;
}

function squaredLength(a) {
	var x = a[0], y = a[1], z = a[2];
	return x * x + y * y + z * z;
}

function negate(out, a) {
	out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2];
	return out;
}

function inverse(out, a) {
	out[0] = 1.0 / a[0]; out[1] = 1.0 / a[1]; out[2] = 1.0 / a[2];
	return out;
}

function normalize(out, a) {
	var x = a[0], y = a[1], z = a[2];
	var len = x * x + y * y + z * z;
	if (len > 0) { len = 1 / Math.sqrt(len); }
	out[0] = a[0] * len;
	out[1] = a[1] * len;
	out[2] = a[2] * len;
	return out;
}

function dot(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(out, a, b) {
	var ax = a[0], ay = a[1], az = a[2];
	var bx = b[0], by = b[1], bz = b[2];
	out[0] = ay * bz - az * by;
	out[1] = az * bx - ax * bz;
	out[2] = ax * by - ay * bx;
	return out;
}

function lerp(out, a, b, t) {
	var ax = a[0], ay = a[1], az = a[2];
	out[0] = ax + t * (b[0] - ax);
	out[1] = ay + t * (b[1] - ay);
	out[2] = az + t * (b[2] - az);
	return out;
}

function slerp(out, a, b, t) {
	var cosine = dot(a, b);
	if (cosine > 1) { cosine = 1; }
	if (cosine < -1) { cosine = -1; }
	var angle = Math.acos(cosine);
	var sinTotal = Math.sin(angle);
	var ratioA = Math.sin((1 - t) * angle) / sinTotal;
	var ratioB = Math.sin(t * angle) / sinTotal;
	out[0] = ratioA * a[0] + ratioB * b[0];
	out[1] = ratioA * a[1] + ratioB * b[1];
	out[2] = ratioA * a[2] + ratioB * b[2];
	return out;
}

function hermite(out, a, b, c, d, t) {
	var factorTimes2 = t * t;
	var factor1 = factorTimes2 * (2 * t - 3) + 1;
	var factor2 = factorTimes2 * (t - 2) + t;
	var factor3 = factorTimes2 * (t - 1);
	var factor4 = factorTimes2 * (3 - 2 * t);
	out[0] = a[0] * factor1 + b[0] * factor2 + c[0] * factor3 + d[0] * factor4;
	out[1] = a[1] * factor1 + b[1] * factor2 + c[1] * factor3 + d[1] * factor4;
	out[2] = a[2] * factor1 + b[2] * factor2 + c[2] * factor3 + d[2] * factor4;
	return out;
}

function bezier(out, a, b, c, d, t) {
	var inverseFactor = 1 - t;
	var inverseFactorTimesTwo = inverseFactor * inverseFactor;
	var factorTimes2 = t * t;
	var factor1 = inverseFactorTimesTwo * inverseFactor;
	var factor2 = 3 * t * inverseFactorTimesTwo;
	var factor3 = 3 * factorTimes2 * inverseFactor;
	var factor4 = factorTimes2 * t;
	out[0] = a[0] * factor1 + b[0] * factor2 + c[0] * factor3 + d[0] * factor4;
	out[1] = a[1] * factor1 + b[1] * factor2 + c[1] * factor3 + d[1] * factor4;
	out[2] = a[2] * factor1 + b[2] * factor2 + c[2] * factor3 + d[2] * factor4;
	return out;
}

function random(out, scaleValue) {
	scaleValue = scaleValue === undefined ? 1.0 : scaleValue;
	var r = RANDOM() * 2.0 * Math.PI;
	var z = RANDOM() * 2.0 - 1.0;
	var zScale = Math.sqrt(1.0 - z * z) * scaleValue;
	out[0] = Math.cos(r) * zScale;
	out[1] = Math.sin(r) * zScale;
	out[2] = z * scaleValue;
	return out;
}

function transformMat4(out, a, m) {
	var x = a[0], y = a[1], z = a[2];
	var w = m[3] * x + m[7] * y + m[11] * z + m[15];
	w = w || 1.0;
	out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
	out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
	out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
	return out;
}

function transformMat3(out, a, m) {
	var x = a[0], y = a[1], z = a[2];
	out[0] = x * m[0] + y * m[3] + z * m[6];
	out[1] = x * m[1] + y * m[4] + z * m[7];
	out[2] = x * m[2] + y * m[5] + z * m[8];
	return out;
}

function transformQuat(out, a, q) {
	var qx = q[0], qy = q[1], qz = q[2], qw = q[3];
	var vx = a[0], vy = a[1], vz = a[2];
	var tx = qy * vz - qz * vy;
	var ty = qz * vx - qx * vz;
	var tz = qx * vy - qy * vx;
	tx = tx + tx; ty = ty + ty; tz = tz + tz;
	out[0] = vx + qw * tx + qy * tz - qz * ty;
	out[1] = vy + qw * ty + qz * tx - qx * tz;
	out[2] = vz + qw * tz + qx * ty - qy * tx;
	return out;
}

function rotateX(out, a, b, rad) {
	var p0 = a[0] - b[0], p1 = a[1] - b[1], p2 = a[2] - b[2];
	var s = Math.sin(rad), c = Math.cos(rad);
	var r1 = p1 * c - p2 * s;
	var r2 = p1 * s + p2 * c;
	out[0] = p0 + b[0];
	out[1] = r1 + b[1];
	out[2] = r2 + b[2];
	return out;
}

function rotateY(out, a, b, rad) {
	var p0 = a[0] - b[0], p1 = a[1] - b[1], p2 = a[2] - b[2];
	var s = Math.sin(rad), c = Math.cos(rad);
	var r0 = p2 * s + p0 * c;
	var r2 = p2 * c - p0 * s;
	out[0] = r0 + b[0];
	out[1] = p1 + b[1];
	out[2] = r2 + b[2];
	return out;
}

function rotateZ(out, a, b, rad) {
	var p0 = a[0] - b[0], p1 = a[1] - b[1], p2 = a[2] - b[2];
	var s = Math.sin(rad), c = Math.cos(rad);
	var r0 = p0 * c - p1 * s;
	var r1 = p0 * s + p1 * c;
	out[0] = r0 + b[0];
	out[1] = r1 + b[1];
	out[2] = p2 + b[2];
	return out;
}

function angle(a, b) {
	var mag = Math.sqrt(squaredLength(a) * squaredLength(b));
	var cosine = mag && dot(a, b) / mag;
	return Math.acos(Math.min(Math.max(cosine, -1), 1));
}

function zero(out) {
	out[0] = 0.0; out[1] = 0.0; out[2] = 0.0;
	return out;
}

function str(a) {
	return "vec3(" + a[0] + ", " + a[1] + ", " + a[2] + ")";
}

function exactEquals(a, b) {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function equals(a, b) {
	var a0 = a[0], a1 = a[1], a2 = a[2];
	var b0 = b[0], b1 = b[1], b2 = b[2];
	return Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
		Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
		Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2));
}

// ============================================================================
// 2. ALIASES (glMatrix)
// ============================================================================
const sub = subtract;
const mul = multiply;
const div = divide;
const dist = distance;
const sqrDist = squaredDistance;
const len = length;
const sqrLen = squaredLength;

const forEach = (function () {
	var vec = create();
	return function (a, stride, offset, count, fn, arg) {
		var i, l;
		if (!stride) { stride = 3; }
		if (!offset) { offset = 0; }
		if (count) { l = Math.min(count * stride + offset, a.length); }
		else { l = a.length; }
		for (i = offset; i < l; i += stride) {
			vec[0] = a[i]; vec[1] = a[i + 1]; vec[2] = a[i + 2];
			fn(vec, vec, arg);
			a[i] = vec[0]; a[i + 1] = vec[1]; a[i + 2] = vec[2];
		}
		return a;
	};
})();

// ============================================================================
// 3. POOL
// ============================================================================
function createVec3Pool(capacity) {
	return createPool(function () {
		var v = new ARRAY_TYPE(3);
		v[0] = 0; v[1] = 0; v[2] = 0;
		return v;
	}, capacity, function (v) {
		v[0] = 0; v[1] = 0; v[2] = 0;
	});
}

let _defaultPool = null;
function getDefaultPool() {
	if (_defaultPool === null) { _defaultPool = createVec3Pool(); }
	return _defaultPool;
}
function acquire() { return getDefaultPool().acquire(); }
function release(v) { getDefaultPool().release(v); }

// ============================================================================
// 4. STRUCTURE OF ARRAYS (SOA) -- 1M+ vec3 at real time
// ============================================================================
function createVec3SOA(count, Type) {
	var soa = createSOA(count, 3, Type);
	return {
		x: soa.arrays[0], y: soa.arrays[1], z: soa.arrays[2],
		arrays: soa.arrays, buffer: soa.buffer, count: soa.count, components: 3
	};
}

function soaZero(out) { soaZeroBase(out); return out; }
function soaFill(out, v) { soaFillBase(out, v); return out; }

function soaGet(out, soa, i) {
	out[0] = soa.x[i]; out[1] = soa.y[i]; out[2] = soa.z[i];
	return out;
}

function soaSet(soa, i, v) {
	soa.x[i] = v[0]; soa.y[i] = v[1]; soa.z[i] = v[2];
	return soa;
}

function soaToFlat(out, soa, offset) {
	offset = offset || 0;
	var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z;
	for (var i = 0, o = offset; i < n; i++, o += 3) {
		out[o] = xs[i]; out[o + 1] = ys[i]; out[o + 2] = zs[i];
	}
	return out;
}

function soaFromFlat(soa, flat, offset) {
	offset = offset || 0;
	var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z;
	for (var i = 0, o = offset; i < n; i++, o += 3) {
		xs[i] = flat[o]; ys[i] = flat[o + 1]; zs[i] = flat[o + 2];
	}
	return soa;
}

function soaCopy(out, a) {
	out.x.set(a.x); out.y.set(a.y); out.z.set(a.z);
	return out;
}

// ---- SOA binary ops --------------------------------------------------------
function soaAdd(out, a, b) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] + bx[i]; oy[i] = ay[i] + by[i]; oz[i] = az[i] + bz[i];
	}
	return out;
}

function soaSub(out, a, b) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] - bx[i]; oy[i] = ay[i] - by[i]; oz[i] = az[i] - bz[i];
	}
	return out;
}

function soaMul(out, a, b) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] * bx[i]; oy[i] = ay[i] * by[i]; oz[i] = az[i] * bz[i];
	}
	return out;
}

function soaDiv(out, a, b) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] / bx[i]; oy[i] = ay[i] / by[i]; oz[i] = az[i] / bz[i];
	}
	return out;
}

function soaScale(out, a, s) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] * s; oy[i] = ay[i] * s; oz[i] = az[i] * s;
	}
	return out;
}

function soaScaleAndAdd(out, a, b, s) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] + bx[i] * s;
		oy[i] = ay[i] + by[i] * s;
		oz[i] = az[i] + bz[i] * s;
	}
	return out;
}

function soaLerp(out, a, b, t) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var axv = ax[i], ayv = ay[i], azv = az[i];
		ox[i] = axv + t * (bx[i] - axv);
		oy[i] = ayv + t * (by[i] - ayv);
		oz[i] = azv + t * (bz[i] - azv);
	}
	return out;
}

function soaNegate(out, a) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = -ax[i]; oy[i] = -ay[i]; oz[i] = -az[i];
	}
	return out;
}

function soaInverse(out, a) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = 1.0 / ax[i]; oy[i] = 1.0 / ay[i]; oz[i] = 1.0 / az[i];
	}
	return out;
}

function soaNormalize(out, a) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var x = ax[i], y = ay[i], z = az[i];
		var l = x * x + y * y + z * z;
		if (l > 0) { l = 1 / Math.sqrt(l); }
		ox[i] = x * l; oy[i] = y * l; oz[i] = z * l;
	}
	return out;
}

function soaMin(out, a, b) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] < bx[i] ? ax[i] : bx[i];
		oy[i] = ay[i] < by[i] ? ay[i] : by[i];
		oz[i] = az[i] < bz[i] ? az[i] : bz[i];
	}
	return out;
}

function soaMax(out, a, b) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] > bx[i] ? ax[i] : bx[i];
		oy[i] = ay[i] > by[i] ? ay[i] : by[i];
		oz[i] = az[i] > bz[i] ? az[i] : bz[i];
	}
	return out;
}

function soaCross(out, a, b) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var axv = ax[i], ayv = ay[i], azv = az[i];
		var bxv = bx[i], byv = by[i], bzv = bz[i];
		ox[i] = ayv * bzv - azv * byv;
		oy[i] = azv * bxv - axv * bzv;
		oz[i] = axv * byv - ayv * bxv;
	}
	return out;
}

function soaDot(a, b) {
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	var n = a.count, s = 0;
	for (var i = 0; i < n; i++) { s += ax[i] * bx[i] + ay[i] * by[i] + az[i] * bz[i]; }
	return s;
}

function soaTransformMat4(out, a, m) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var n = out.count;
	var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
	var m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
	var m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
	var m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];
	for (var i = 0; i < n; i++) {
		var x = ax[i], y = ay[i], z = az[i];
		var w = m3 * x + m7 * y + m11 * z + m15;
		w = w || 1.0;
		ox[i] = (m0 * x + m4 * y + m8 * z + m12) / w;
		oy[i] = (m1 * x + m5 * y + m9 * z + m13) / w;
		oz[i] = (m2 * x + m6 * y + m10 * z + m14) / w;
	}
	return out;
}

function soaTransformMat3(out, a, m) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var n = out.count;
	var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
	for (var i = 0; i < n; i++) {
		var x = ax[i], y = ay[i], z = az[i];
		ox[i] = x * m0 + y * m3 + z * m6;
		oy[i] = x * m1 + y * m4 + z * m7;
		oz[i] = x * m2 + y * m5 + z * m8;
	}
	return out;
}

function soaAABB(out, a) {
	var ax = a.x, ay = a.y, az = a.z, n = a.count;
	var minX = Infinity, minY = Infinity, minZ = Infinity;
	var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
	for (var i = 0; i < n; i++) {
		var x = ax[i], y = ay[i], z = az[i];
		if (x < minX) { minX = x; } if (x > maxX) { maxX = x; }
		if (y < minY) { minY = y; } if (y > maxY) { maxY = y; }
		if (z < minZ) { minZ = z; } if (z > maxZ) { maxZ = z; }
	}
	out.minX = minX; out.minY = minY; out.minZ = minZ;
	out.maxX = maxX; out.maxY = maxY; out.maxZ = maxZ;
	return out;
}

function soaMinComponent(a) {
	var ax = a.x, ay = a.y, az = a.z, n = a.count, m = Infinity;
	for (var i = 0; i < n; i++) {
		if (ax[i] < m) { m = ax[i]; }
		if (ay[i] < m) { m = ay[i]; }
		if (az[i] < m) { m = az[i]; }
	}
	return m;
}

function soaMaxComponent(a) {
	var ax = a.x, ay = a.y, az = a.z, n = a.count, m = -Infinity;
	for (var i = 0; i < n; i++) {
		if (ax[i] > m) { m = ax[i]; }
		if (ay[i] > m) { m = ay[i]; }
		if (az[i] > m) { m = az[i]; }
	}
	return m;
}

// ---- Chunked async SOA ops (mobile-safe, no UI freeze at 1M+) -------------
// NOTE: These use closures for async loading/generation phases only.
// They are never invoked synchronously during Simulation or Render phases.
async function _chunked3(out, perElem, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var n = out.count, c = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) { perElem(i); }
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
	return out;
}

function soaAddChunked(out, a, b, chunkSize, yieldEvery) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	return _chunked3(out, function (i) {
		ox[i] = ax[i] + bx[i]; oy[i] = ay[i] + by[i]; oz[i] = az[i] + bz[i];
	}, chunkSize, yieldEvery);
}

function soaSubChunked(out, a, b, chunkSize, yieldEvery) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	return _chunked3(out, function (i) {
		ox[i] = ax[i] - bx[i]; oy[i] = ay[i] - by[i]; oz[i] = az[i] - bz[i];
	}, chunkSize, yieldEvery);
}

function soaScaleChunked(out, a, s, chunkSize, yieldEvery) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	return _chunked3(out, function (i) {
		ox[i] = ax[i] * s; oy[i] = ay[i] * s; oz[i] = az[i] * s;
	}, chunkSize, yieldEvery);
}

function soaLerpChunked(out, a, b, t, chunkSize, yieldEvery) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	return _chunked3(out, function (i) {
		var axv = ax[i], ayv = ay[i], azv = az[i];
		ox[i] = axv + t * (bx[i] - axv);
		oy[i] = ayv + t * (by[i] - ayv);
		oz[i] = azv + t * (bz[i] - azv);
	}, chunkSize, yieldEvery);
}

function soaNormalizeChunked(out, a, chunkSize, yieldEvery) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	return _chunked3(out, function (i) {
		var x = ax[i], y = ay[i], z = az[i];
		var l = x * x + y * y + z * z;
		if (l > 0) { l = 1 / Math.sqrt(l); }
		ox[i] = x * l; oy[i] = y * l; oz[i] = z * l;
	}, chunkSize, yieldEvery);
}

async function soaDotChunked(a, b, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	var n = a.count, sum = 0, c = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		var local = 0;
		for (var i = start; i < end; i++) { local += ax[i] * bx[i] + ay[i] * by[i] + az[i] * bz[i]; }
		sum += local;
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
	return sum;
}

function soaCrossChunked(out, a, b, chunkSize, yieldEvery) {
	var ox = out.x, oy = out.y, oz = out.z;
	var ax = a.x, ay = a.y, az = a.z;
	var bx = b.x, by = b.y, bz = b.z;
	return _chunked3(out, function (i) {
		var axv = ax[i], ayv = ay[i], azv = az[i];
		var bxv = bx[i], byv = by[i], bzv = bz[i];
		ox[i] = ayv * bzv - azv * byv;
		oy[i] = azv * bxv - axv * bzv;
		oz[i] = axv * byv - ayv * bxv;
	}, chunkSize, yieldEvery);
}

async function soaForEachChunked(out, a, callback, chunkSize, yieldEvery) {
	return _chunked3(out, function (i) { callback(i, a, out); }, chunkSize, yieldEvery);
}

// ============================================================================
// 5. PROCEDURAL 3D NOISE
// ============================================================================
// 3D value noise. Deterministic, fast. Returns [0,1].
function valueNoise3D(x, y, z) {
	var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
	var xf = x - xi, yf = y - yi, zf = z - zi;
	var u = xf * xf * (3 - 2 * xf);
	var v = yf * yf * (3 - 2 * yf);
	var w = zf * zf * (3 - 2 * zf);
	var a = hash3(xi, yi, zi);
	var b = hash3(xi + 1, yi, zi);
	var c = hash3(xi, yi + 1, zi);
	var d = hash3(xi + 1, yi + 1, zi);
	var e = hash3(xi, yi, zi + 1);
	var f = hash3(xi + 1, yi, zi + 1);
	var g = hash3(xi, yi + 1, zi + 1);
	var h = hash3(xi + 1, yi + 1, zi + 1);
	var x00 = a + (b - a) * u;
	var x10 = c + (d - c) * u;
	var x01 = e + (f - e) * u;
	var x11 = g + (h - g) * u;
	var y0 = x00 + (x10 - x00) * v;
	var y1 = x01 + (x11 - x01) * v;
	return y0 + (y1 - y0) * w;
}

// Hoisted corner dot helper to eliminate per-invocation closure allocation.
function _cornerDot(ix, iy, iz, dx, dy, dz) {
	var th = hash3(ix, iy, iz) * 6.28318530718;
	var ph = hash3(ix + 7, iy + 13, iz + 23) * 6.28318530718;
	var gx = Math.cos(th) * Math.cos(ph);
	var gy = Math.sin(th) * Math.cos(ph);
	var gz = Math.sin(ph);
	return dx * gx + dy * gy + dz * gz;
}

// 3D gradient noise. Range approximately [-1,1].
function gradientNoise3D(x, y, z) {
	var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
	var xf = x - xi, yf = y - yi, zf = z - zi;
	var u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
	var v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
	var w = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
	var a = _cornerDot(xi, yi, zi, xf, yf, zf);
	var b = _cornerDot(xi + 1, yi, zi, xf - 1, yf, zf);
	var c = _cornerDot(xi, yi + 1, zi, xf, yf - 1, zf);
	var d = _cornerDot(xi + 1, yi + 1, zi, xf - 1, yf - 1, zf);
	var e = _cornerDot(xi, yi, zi + 1, xf, yf, zf - 1);
	var f = _cornerDot(xi + 1, yi, zi + 1, xf - 1, yf, zf - 1);
	var g = _cornerDot(xi, yi + 1, zi + 1, xf, yf - 1, zf - 1);
	var h = _cornerDot(xi + 1, yi + 1, zi + 1, xf - 1, yf - 1, zf - 1);
	var x00 = a + (b - a) * u;
	var x10 = c + (d - c) * u;
	var x01 = e + (f - e) * u;
	var x11 = g + (h - g) * u;
	var y0 = x00 + (x10 - x00) * v;
	var y1 = x01 + (x11 - x01) * v;
	return y0 + (y1 - y0) * w;
}

// 3D fBm (fractal Brownian motion). Returns [0,1].
function fbm3D(x, y, z, octaves, lacunarity, gain) {
	octaves = octaves || 4;
	lacunarity = lacunarity || 2.0;
	gain = gain || 0.5;
	var sum = 0, amp = 1, freq = 1, norm = 0;
	for (var i = 0; i < octaves; i++) {
		sum += amp * gradientNoise3D(x * freq, y * freq, z * freq);
		norm += amp;
		freq *= lacunarity;
		amp *= gain;
	}
	return 0.5 + 0.5 * (sum / norm);
}

// 3D Voronoi / Worley. out[0] = distance to nearest feature point,
// out[1] = nearest cell id.
function voronoi3D(out, x, y, z) {
	var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
	var minD = Infinity, id = 0;
	for (var k = -1; k <= 1; k++) {
		for (var j = -1; j <= 1; j++) {
			for (var i = -1; i <= 1; i++) {
				var cx = xi + i, cy = yi + j, cz = zi + k;
				var fx = cx + hash3(cx, cy, cz);
				var fy = cy + hash3(cy, cz, cx);
				var fz = cz + hash3(cz, cx, cy);
				var dx = x - fx, dy = y - fy, dz = z - fz;
				var d = dx * dx + dy * dy + dz * dz;
				if (d < minD) {
					minD = d;
					id = ((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) >>> 0;
				}
			}
		}
	}
	out[0] = Math.sqrt(minD);
	out[1] = id;
	return out;
}

// Fill a vec3 SOA with 3D noise. Direct conditional branches keep the hot
// loop allocation-free.
function soaFillNoise3D(soa, scale, octaves, kind) {
	scale = scale || 1;
	octaves = octaves || 4;
	kind = kind || "fbm";
	var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z;
	var isValue = kind === "value";
	var isGradient = kind === "gradient";
	for (var i = 0; i < n; i++) {
		var x = xs[i] * scale, y = ys[i] * scale, z = zs[i] * scale;
		if (isValue) {
			xs[i] = valueNoise3D(x, y, z);
			ys[i] = valueNoise3D(x + 100, y + 100, z + 100);
			zs[i] = valueNoise3D(x + 200, y + 200, z + 200);
		} else if (isGradient) {
			xs[i] = gradientNoise3D(x, y, z);
			ys[i] = gradientNoise3D(x + 100, y + 100, z + 100);
			zs[i] = gradientNoise3D(x + 200, y + 200, z + 200);
		} else {
			xs[i] = fbm3D(x, y, z, octaves);
			ys[i] = fbm3D(x + 100, y + 100, z + 100, octaves);
			zs[i] = fbm3D(x + 200, y + 200, z + 200, octaves);
		}
	}
	return soa;
}

async function soaFillNoise3DChunked(soa, scale, octaves, kind, chunkSize, yieldEvery) {
	scale = scale || 1;
	octaves = octaves || 4;
	kind = kind || "fbm";
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z, c = 0;
	var isValue = kind === "value";
	var isGradient = kind === "gradient";
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) {
			var x = xs[i] * scale, y = ys[i] * scale, z = zs[i] * scale;
			if (isValue) {
				xs[i] = valueNoise3D(x, y, z);
				ys[i] = valueNoise3D(x + 100, y + 100, z + 100);
				zs[i] = valueNoise3D(x + 200, y + 200, z + 200);
			} else if (isGradient) {
				xs[i] = gradientNoise3D(x, y, z);
				ys[i] = gradientNoise3D(x + 100, y + 100, z + 100);
				zs[i] = gradientNoise3D(x + 200, y + 200, z + 200);
			} else {
				xs[i] = fbm3D(x, y, z, octaves);
				ys[i] = fbm3D(x + 100, y + 100, z + 100, octaves);
				zs[i] = fbm3D(x + 200, y + 200, z + 200, octaves);
			}
		}
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
	return soa;
}

// ============================================================================
// 5b. SPHERICAL HARMONICS (real SH, bands 0..2)
// ============================================================================
// Evaluate the 9 real spherical-harmonic basis functions (L0..L2) for a
// unit direction. Writes into out[0..8].
function shBasis(out, d) {
	var x = d[0], y = d[1], z = d[2];
	out[0] = 0.2820947917738781;
	out[1] = -0.4886025119029199 * y;
	out[2] = 0.4886025119029199 * z;
	out[3] = -0.4886025119029199 * x;
	out[4] = 1.0925484305920792 * x * y;
	out[5] = -1.0925484305920792 * y * z;
	out[6] = 0.31539156525252005 * (3 * z * z - 1);
	out[7] = -1.0925484305920792 * x * z;
	out[8] = 0.5462742152960396 * (x * x - y * y);
	return out;
}

// Reconstruct a signal from 9 SH coefficients along a direction.
function shEvaluate(coefficients, d) {
	var basis = [0, 0, 0, 0, 0, 0, 0, 0, 0];
	shBasis(basis, d);
	var sum = 0;
	for (var i = 0; i < 9; i++) { sum += coefficients[i] * basis[i]; }
	return sum;
}

// Project a directional light into 9 SH coefficients (scaled by energy).
function shProjectDirectional(out, dir, energy) {
	var basis = [0, 0, 0, 0, 0, 0, 0, 0, 0];
	shBasis(basis, dir);
	for (var i = 0; i < 9; i++) { out[i] = basis[i] * energy; }
	return out;
}

// ============================================================================
// 6. ANIMATION CURVES (3D)
// ============================================================================
function quadraticBezier(out, a, b, c, t) {
	var t2 = t * t, mt = 1 - t, mt2 = mt * mt;
	out[0] = mt2 * a[0] + 2 * mt * t * b[0] + t2 * c[0];
	out[1] = mt2 * a[1] + 2 * mt * t * b[1] + t2 * c[1];
	out[2] = mt2 * a[2] + 2 * mt * t * b[2] + t2 * c[2];
	return out;
}

function cubicBezier(out, a, b, c, d, t) {
	var mt = 1 - t, mt2 = mt * mt, t2 = t * t;
	var mt3 = mt2 * mt, t3 = t2 * t;
	out[0] = mt3 * a[0] + 3 * mt2 * t * b[0] + 3 * mt * t2 * c[0] + t3 * d[0];
	out[1] = mt3 * a[1] + 3 * mt2 * t * b[1] + 3 * mt * t2 * c[1] + t3 * d[1];
	out[2] = mt3 * a[2] + 3 * mt2 * t * b[2] + 3 * mt * t2 * c[2] + t3 * d[2];
	return out;
}

function catmullRom(out, p0, p1, p2, p3, t) {
	var t2 = t * t, t3 = t2 * t;
	out[0] = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
	out[1] = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
	out[2] = 0.5 * ((2 * p1[2]) + (-p0[2] + p2[2]) * t + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3);
	return out;
}

// ============================================================================
// 7. NATURAL MOTION / IK PRIMITIVES
// ============================================================================
// Frame-rate independent critically-damped spring for vec3.
// Writes result to out[0..2], updates vel[0..2] in place.
function springDamp3(out, current, target, vel, smoothTime, dt, maxSpeed) {
	if (smoothTime < 0.0001) { smoothTime = 0.0001; }
	if (maxSpeed === undefined) { maxSpeed = Infinity; }
	var omega = 2 / smoothTime;
	var x = omega * dt;
	var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
	var maxChange = maxSpeed * smoothTime;
	for (var i = 0; i < 3; i++) {
		var c = current[i];
		var t = target[i];
		var change = c - t;
		var originalTarget = t;
		if (change > maxChange) { change = maxChange; }
		else if (change < -maxChange) { change = -maxChange; }
		t = c - change;
		var temp = (vel[i] + omega * change) * dt;
		vel[i] = (vel[i] - omega * temp) * exp;
		var output = t + (change + temp) * exp;
		if ((originalTarget - c > 0) === (output > originalTarget)) {
			output = originalTarget;
			vel[i] = (output - originalTarget) / dt;
		}
		out[i] = output;
	}
	return out;
}

const smoothDamp3 = springDamp3;

// One FABRIK iteration step for a 3D chain.
// pos is flat [x0,y0,z0, x1,y1,z1, ...], lens is bone lengths (n-1).
// target is the desired end-effector. Returns the distance error.
function fabrikStep3(pos, lens, target, tolerance) {
	var n = lens.length + 1;
	var lastIdx = (n - 1) * 3;
	var dx = target[0] - pos[lastIdx];
	var dy = target[1] - pos[lastIdx + 1];
	var dz = target[2] - pos[lastIdx + 2];
	var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
	if (dist < tolerance) { return 0; }

	// Save ROOT position (index 0), not the end-effector.
	var rootX = pos[0], rootY = pos[1], rootZ = pos[2];

	// 1. Forward Reaching (Target to Root)
	pos[lastIdx] = target[0];
	pos[lastIdx + 1] = target[1];
	pos[lastIdx + 2] = target[2];
	for (var i = n - 2; i >= 0; i--) {
		var idx = i * 3;
		var nextIdx = idx + 3;
		var nx = pos[nextIdx], ny = pos[nextIdx + 1], nz = pos[nextIdx + 2];
		var cx = pos[idx], cy = pos[idx + 1], cz = pos[idx + 2];
		var ddx = nx - cx, ddy = ny - cy, ddz = nz - cz;
		var d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) || 1e-9;
		var r = lens[i] / d;
		pos[idx] = nx - ddx * r;
		pos[idx + 1] = ny - ddy * r;
		pos[idx + 2] = nz - ddz * r;
	}

	// 2. Backward Reaching (Root to Target)
	pos[0] = rootX; pos[1] = rootY; pos[2] = rootZ;
	for (var j = 1; j < n; j++) {
		var jIdx = j * 3;
		var prevIdx = (j - 1) * 3;
		var px = pos[jIdx], py = pos[jIdx + 1], pz = pos[jIdx + 2];
		var qx = pos[prevIdx], qy = pos[prevIdx + 1], qz = pos[prevIdx + 2];
		var ex = px - qx, ey = py - qy, ez = pz - qz;
		var el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9;
		var rr = lens[j - 1] / el;
		pos[jIdx] = qx + ex * rr;
		pos[jIdx + 1] = qy + ey * rr;
		pos[jIdx + 2] = qz + ez * rr;
	}

	// Return new distance error
	var dfx = pos[lastIdx] - target[0];
	var dfy = pos[lastIdx + 1] - target[1];
	var dfz = pos[lastIdx + 2] - target[2];
	return Math.sqrt(dfx * dfx + dfy * dfy + dfz * dfz);
}

// Cyclic Coordinate Descent -- one pass over the chain (end to base).
// pos is flat, target is the end-effector. Returns squared error.
function ccdStep3(pos, target, iterations) {
	iterations = iterations || 1;
	var n = (pos.length / 3) | 0;
	for (var k = 0; k < iterations; k++) {
		for (var i = n - 2; i >= 0; i--) {
			var px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
			var ex = target[0] - px, ey = target[1] - py, ez = target[2] - pz;
			var efx = pos[(n - 1) * 3] - px;
			var efy = pos[(n - 1) * 3 + 1] - py;
			var efz = pos[(n - 1) * 3 + 2] - pz;
			var eLen = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9;
			var fLen = Math.sqrt(efx * efx + efy * efy + efz * efz) || 1e-9;
			ex /= eLen; ey /= eLen; ez /= eLen;
			efx /= fLen; efy /= fLen; efz /= fLen;
			var c = ex * efx + ey * efy + ez * efz;
			if (c > 0.9999) { continue; }
			var ang = Math.acos(Math.min(1, Math.max(-1, c)));
			var ax = efy * ez - efz * ey;
			var ay = efz * ex - efx * ez;
			var az = efx * ey - efy * ex;
			var alen = Math.sqrt(ax * ax + ay * ay + az * az);
			if (alen < 1e-9) { continue; }
			ax /= alen; ay /= alen; az /= alen;
			var s = Math.sin(ang), co = Math.cos(ang), ic = 1 - co;
			for (var j = i + 1; j < n; j++) {
				var rx = pos[j * 3] - px, ry = pos[j * 3 + 1] - py, rz = pos[j * 3 + 2] - pz;
				var dotp = ax * rx + ay * ry + az * rz;
				var crx = ay * rz - az * ry;
				var cry = az * rx - ax * rz;
				var crz = ax * ry - ay * rx;
				pos[j * 3] = px + rx * co + crx * s + ax * dotp * ic;
				pos[j * 3 + 1] = py + ry * co + cry * s + ay * dotp * ic;
				pos[j * 3 + 2] = pz + rz * co + crz * s + az * dotp * ic;
			}
		}
	}
	var dx = pos[(n - 1) * 3] - target[0];
	var dy = pos[(n - 1) * 3 + 1] - target[1];
	var dz = pos[(n - 1) * 3 + 2] - target[2];
	return dx * dx + dy * dy + dz * dz;
}

// Build a right-handed orthonormal basis from forward direction + up.
function lookAtBasis(right, up, forward, eye, target, upHint) {
	var fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
	var fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1e-9;
	fx /= fl; fy /= fl; fz /= fl;
	forward[0] = fx; forward[1] = fy; forward[2] = fz;
	var ux = upHint[0], uy = upHint[1], uz = upHint[2];
	var rx = fy * uz - fz * uy;
	var ry = fz * ux - fx * uz;
	var rz = fx * uy - fy * ux;
	var rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-9;
	rx /= rl; ry /= rl; rz /= rl;
	right[0] = rx; right[1] = ry; right[2] = rz;
	var nx = ry * fz - rz * fy;
	var ny = rz * fx - rx * fz;
	var nz = rx * fy - ry * fx;
	var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1e-9;
	up[0] = nx / nl; up[1] = ny / nl; up[2] = nz / nl;
	return forward;
}

// ============================================================================
// 8. COLOR (vec3 as RGB)
// ============================================================================
function acesToneMap(out, r, g, b) {
	var a = 2.51, c = 0.03, d = 2.43, e = 0.59, f = 0.14;
	out[0] = (r * (a * r + c)) / (r * (d * r + e) + f);
	out[1] = (g * (a * g + c)) / (g * (d * g + e) + f);
	out[2] = (b * (a * b + c)) / (b * (d * b + e) + f);
	return out;
}

function reinhardToneMap(out, r, g, b) {
	out[0] = r / (1 + r);
	out[1] = g / (1 + g);
	out[2] = b / (1 + b);
	return out;
}

function packRGB(r, g, b) {
	return ((b * 255) & 0xff) << 16 | ((g * 255) & 0xff) << 8 | ((r * 255) & 0xff);
}

function unpackRGB(out, packed) {
	out[0] = (packed & 0xff) / 255;
	out[1] = ((packed >> 8) & 0xff) / 255;
	out[2] = ((packed >> 16) & 0xff) / 255;
	return out;
}

function packVec3RGB(v) {
	return packRGB(v[0], v[1], v[2]);
}

// ============================================================================
// 9. ORBITAL (3D — with inclination, node, argument of periapsis)
// ============================================================================
function keplerOrbit3D(out, a, e, M, i, Omega, omega) {
	var E = keplerSolve(M, e);
	var xp = a * (Math.cos(E) - e);
	var yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
	var cw = Math.cos(omega), sw = Math.sin(omega);
	var x1 = xp * cw - yp * sw;
	var y1 = xp * sw + yp * cw;
	var ci = Math.cos(i), si = Math.sin(i);
	var x2 = x1;
	var y2 = y1 * ci;
	var z2 = y1 * si;
	var cO = Math.cos(Omega), sO = Math.sin(Omega);
	out[0] = x2 * cO - y2 * sO;
	out[1] = x2 * sO + y2 * cO;
	out[2] = z2;
	return out;
}

function keplerOrbitVelocity3D(out, a, e, M, i, Omega, omega, mu) {
	var E = keplerSolve(M, e);
	var cosE = Math.cos(E), sinE = Math.sin(E);
	var denom = 1 - e * cosE;
	var n = Math.sqrt(mu / (a * a * a));
	var dEdt = n / denom;
	var vxp = -a * sinE * dEdt;
	var vyp = a * Math.sqrt(1 - e * e) * cosE * dEdt;
	var cw = Math.cos(omega), sw = Math.sin(omega);
	var x1 = vxp * cw - vyp * sw;
	var y1 = vxp * sw + vyp * cw;
	var ci = Math.cos(i), si = Math.sin(i);
	var x2 = x1;
	var y2 = y1 * ci;
	var z2 = y1 * si;
	var cO = Math.cos(Omega), sO = Math.sin(Omega);
	out[0] = x2 * cO - y2 * sO;
	out[1] = x2 * sO + y2 * cO;
	out[2] = z2;
	return out;
}

function orbitalSpeed3D(mu, r, a) {
	return Math.sqrt(mu * (2 / r - 1 / a));
}

function hohmannTransfer(out, mu, r1, r2) {
	var v1 = Math.sqrt(mu / r1);
	var v2 = Math.sqrt(mu / r2);
	var aT = (r1 + r2) * 0.5;
	var vT1 = Math.sqrt(mu * (2 / r1 - 1 / aT));
	var vT2 = Math.sqrt(mu * (2 / r2 - 1 / aT));
	out[0] = Math.abs(vT1 - v1);
	out[1] = Math.abs(v2 - vT2);
	return out;
}

function sphereOfInfluence(a, mPlanet, mStar) {
	return a * Math.pow(mPlanet / mStar, 0.4);
}

// ============================================================================
// 10. SCALE / FLOATING ORIGIN
// ============================================================================
function toRelative(out, pos, origin) {
	out[0] = pos[0] - origin[0];
	out[1] = pos[1] - origin[1];
	out[2] = pos[2] - origin[2];
	return out;
}

function toAbsolute(out, rel, origin) {
	out[0] = rel[0] + origin[0];
	out[1] = rel[1] + origin[1];
	out[2] = rel[2] + origin[2];
	return out;
}

function soaToRelative(out, a, ox, oy, oz) {
	var oX = out.x, oY = out.y, oZ = out.z;
	var aX = a.x, aY = a.y, aZ = a.z, n = a.count;
	for (var i = 0; i < n; i++) {
		oX[i] = aX[i] - ox;
		oY[i] = aY[i] - oy;
		oZ[i] = aZ[i] - oz;
	}
	return out;
}

// ============================================================================
// 11. EXPORTS
// ============================================================================
export {
	// foundation constants
	EPSILON, ARRAY_TYPE, RANDOM, CHUNK_SIZE, CHUNK_YIELD_EVERY,
	// flat API
	create, clone, length, fromValues, copy, set, add, subtract, multiply,
	divide, ceil, floor, min, max, round, scale, scaleAndAdd, distance,
	squaredDistance, squaredLength, negate, inverse, normalize, dot, cross,
	lerp, slerp, hermite, bezier, random, transformMat4, transformMat3,
	transformQuat, rotateX, rotateY, rotateZ, angle, zero, str, exactEquals,
	equals,
	// aliases
	sub, mul, div, dist, sqrDist, len, sqrLen, forEach,
	// pool
	createVec3Pool, acquire, release,
	// SOA
	createVec3SOA, soaZero, soaFill, soaGet, soaSet, soaToFlat, soaFromFlat,
	soaCopy, soaAdd, soaSub, soaMul, soaDiv, soaScale, soaScaleAndAdd, soaLerp,
	soaNegate, soaInverse, soaNormalize, soaMin, soaMax, soaCross, soaDot,
	soaTransformMat4, soaTransformMat3, soaAABB, soaMinComponent, soaMaxComponent,
	// chunked async (mobile-safe)
	soaAddChunked, soaSubChunked, soaScaleChunked, soaLerpChunked,
	soaNormalizeChunked, soaDotChunked, soaCrossChunked, soaForEachChunked,
	// procedural
	valueNoise3D, gradientNoise3D, fbm3D, voronoi3D, soaFillNoise3D,
	soaFillNoise3DChunked,
	// spherical harmonics
	shBasis, shEvaluate, shProjectDirectional,
	// animation
	quadraticBezier, cubicBezier, catmullRom,
	// IK / natural motion
	springDamp3, smoothDamp3, fabrikStep3, ccdStep3, lookAtBasis,
	// color
	acesToneMap, reinhardToneMap, packRGB, unpackRGB, packVec3RGB,
	// orbital
	keplerOrbit3D, keplerOrbitVelocity3D, orbitalSpeed3D, hohmannTransfer,
	sphereOfInfluence,
	// scale / floating origin
	toRelative, toAbsolute, soaToRelative
};

export default {
	create, clone, length, fromValues, copy, set, add, subtract, multiply,
	divide, ceil, floor, min, max, round, scale, scaleAndAdd, distance,
	squaredDistance, squaredLength, negate, inverse, normalize, dot, cross,
	lerp, slerp, hermite, bezier, random, transformMat4, transformMat3,
	transformQuat, rotateX, rotateY, rotateZ, angle, zero, str, exactEquals,
	equals,
	sub, mul, div, dist, sqrDist, len, sqrLen, forEach,
	createVec3Pool, acquire, release,
	createVec3SOA, soaZero, soaFill, soaGet, soaSet, soaToFlat, soaFromFlat,
	soaCopy, soaAdd, soaSub, soaMul, soaDiv, soaScale, soaScaleAndAdd, soaLerp,
	soaNegate, soaInverse, soaNormalize, soaMin, soaMax, soaCross, soaDot,
	soaTransformMat4, soaTransformMat3, soaAABB, soaMinComponent, soaMaxComponent,
	soaAddChunked, soaSubChunked, soaScaleChunked, soaLerpChunked,
	soaNormalizeChunked, soaDotChunked, soaCrossChunked, soaForEachChunked,
	valueNoise3D, gradientNoise3D, fbm3D, voronoi3D, soaFillNoise3D,
	soaFillNoise3DChunked,
	shBasis, shEvaluate, shProjectDirectional,
	quadraticBezier, cubicBezier, catmullRom,
	springDamp3, smoothDamp3, fabrikStep3, ccdStep3, lookAtBasis,
	acesToneMap, reinhardToneMap, packRGB, unpackRGB, packVec3RGB,
	keplerOrbit3D, keplerOrbitVelocity3D, orbitalSpeed3D, hohmannTransfer,
	sphereOfInfluence,
	toRelative, toAbsolute, soaToRelative
};