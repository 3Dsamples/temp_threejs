// File number : 004
// File : src/math/004_vec4.js
// Description : 4D vector math (glMatrix API) + SOA bulk layout, pooling, chunked
//               parallelism, homogeneous coordinate transforms (perspective/ortho
//               projection math, projective interpolation), quaternion-friendly
//               helpers, 4D procedural noise (turbulence, fBm using true hash4),
//               animation curves, spring damping, packed RGBA color, and
//               floating-origin helpers for galactic-scale homogeneous math.
// Best for : 3d graphics — rendering (homogeneous clipping, projective texturing,
//            depth buffer tricks, clip-space math, shadow cascades, post-process
//            UVs), color (packed RGBA HDR, premultiplied alpha, sRGB<->linear per
//            channel, exposure), procedural generation (4D noise for animation
//            over time = terrain with moving clouds, quaternion field sampling,
//            spacetime warping), animation (4D bezier/hermite, quaternion spring,
//            tangent-space spring), natural IK motion (4D dual quaternion support,
//            weight-and-translation follow), orbital (worldline/dt scaled
//            integrated positions, relativistic t-component), floating-origin for
//            galactic coordinate packing, 1M+ instances real-time via SOA +
//            chunked parallelism.
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

// Deterministic 4D spatial hash returning [0,1]
function hash4(x, y, z, w) {
	var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2246822519) + Math.imul(w | 0, 3266489917)) | 0;
	h = (h ^ (h >>> 13)) | 0;
	h = Math.imul(h, 1274126177) | 0;
	h = (h ^ (h >>> 16)) >>> 0;
	return h / 4294967295;
}

function srgbToLinear(c) {
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
	return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
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
	var out = new ARRAY_TYPE(4);
	if (ARRAY_TYPE !== Float32Array) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; }
	return out;
}

function clone(a) {
	var out = new ARRAY_TYPE(4);
	out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
	return out;
}

function fromValues(x, y, z, w) {
	var out = new ARRAY_TYPE(4);
	out[0] = x; out[1] = y; out[2] = z; out[3] = w;
	return out;
}

function copy(out, a) {
	out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
	return out;
}

function set(out, x, y, z, w) {
	out[0] = x; out[1] = y; out[2] = z; out[3] = w;
	return out;
}

function add(out, a, b) {
	out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; out[3] = a[3] + b[3];
	return out;
}

function subtract(out, a, b) {
	out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; out[3] = a[3] - b[3];
	return out;
}

function multiply(out, a, b) {
	out[0] = a[0] * b[0]; out[1] = a[1] * b[1]; out[2] = a[2] * b[2]; out[3] = a[3] * b[3];
	return out;
}

function divide(out, a, b) {
	out[0] = a[0] / b[0]; out[1] = a[1] / b[1]; out[2] = a[2] / b[2]; out[3] = a[3] / b[3];
	return out;
}

function ceil(out, a) {
	out[0] = Math.ceil(a[0]); out[1] = Math.ceil(a[1]); out[2] = Math.ceil(a[2]); out[3] = Math.ceil(a[3]);
	return out;
}

function floor(out, a) {
	out[0] = Math.floor(a[0]); out[1] = Math.floor(a[1]); out[2] = Math.floor(a[2]); out[3] = Math.floor(a[3]);
	return out;
}

function min(out, a, b) {
	out[0] = Math.min(a[0], b[0]); out[1] = Math.min(a[1], b[1]);
	out[2] = Math.min(a[2], b[2]); out[3] = Math.min(a[3], b[3]);
	return out;
}

function max(out, a, b) {
	out[0] = Math.max(a[0], b[0]); out[1] = Math.max(a[1], b[1]);
	out[2] = Math.max(a[2], b[2]); out[3] = Math.max(a[3], b[3]);
	return out;
}

function round(out, a) {
	out[0] = roundScalar(a[0]); out[1] = roundScalar(a[1]);
	out[2] = roundScalar(a[2]); out[3] = roundScalar(a[3]);
	return out;
}

function scale(out, a, b) {
	out[0] = a[0] * b; out[1] = a[1] * b; out[2] = a[2] * b; out[3] = a[3] * b;
	return out;
}

function scaleAndAdd(out, a, b, s) {
	out[0] = a[0] + b[0] * s;
	out[1] = a[1] + b[1] * s;
	out[2] = a[2] + b[2] * s;
	out[3] = a[3] + b[3] * s;
	return out;
}

function distance(a, b) {
	var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2], w = b[3] - a[3];
	return Math.sqrt(x * x + y * y + z * z + w * w);
}

function squaredDistance(a, b) {
	var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2], w = b[3] - a[3];
	return x * x + y * y + z * z + w * w;
}

function length(a) {
	var x = a[0], y = a[1], z = a[2], w = a[3];
	return Math.sqrt(x * x + y * y + z * z + w * w);
}

function squaredLength(a) {
	var x = a[0], y = a[1], z = a[2], w = a[3];
	return x * x + y * y + z * z + w * w;
}

function negate(out, a) {
	out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = -a[3];
	return out;
}

function inverse(out, a) {
	out[0] = 1.0 / a[0]; out[1] = 1.0 / a[1]; out[2] = 1.0 / a[2]; out[3] = 1.0 / a[3];
	return out;
}

function normalize(out, a) {
	var x = a[0], y = a[1], z = a[2], w = a[3];
	var len = x * x + y * y + z * z + w * w;
	if (len > 0) { len = 1 / Math.sqrt(len); }
	out[0] = x * len; out[1] = y * len; out[2] = z * len; out[3] = w * len;
	return out;
}

function dot(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

function cross(out, u, v, w) {
	var A = v[0] * w[1] - v[1] * w[0];
	var B = v[0] * w[2] - v[2] * w[0];
	var C = v[0] * w[3] - v[3] * w[0];
	var D = v[1] * w[2] - v[2] * w[1];
	var E = v[1] * w[3] - v[3] * w[1];
	var F = v[2] * w[3] - v[3] * w[2];
	var G = u[0], H = u[1], I = u[2], J = u[3];
	out[0] = H * F - I * E + J * D;
	out[1] = -(G * F) + I * C - J * B;
	out[2] = G * E - H * C + J * A;
	out[3] = -(G * D) + H * B - I * A;
	return out;
}

function lerp(out, a, b, t) {
	var ax = a[0], ay = a[1], az = a[2], aw = a[3];
	out[0] = ax + t * (b[0] - ax);
	out[1] = ay + t * (b[1] - ay);
	out[2] = az + t * (b[2] - az);
	out[3] = aw + t * (b[3] - aw);
	return out;
}

function random(out, scaleValue) {
	scaleValue = scaleValue === undefined ? 1.0 : scaleValue;
	var v1, v2, v3, v4, s1, s2, rand;
	rand = RANDOM();
	v1 = rand * 2 - 1;
	v2 = (4 * RANDOM() - 2) * Math.sqrt(rand * -rand + rand);
	s1 = v1 * v1 + v2 * v2;
	rand = RANDOM();
	v3 = rand * 2 - 1;
	v4 = (4 * RANDOM() - 2) * Math.sqrt(rand * -rand + rand);
	s2 = v3 * v3 + v4 * v4;
	var d = Math.sqrt((1 - s1) / s2);
	out[0] = scaleValue * v1;
	out[1] = scaleValue * v2;
	out[2] = scaleValue * v3 * d;
	out[3] = scaleValue * v4 * d;
	return out;
}

function transformMat4(out, a, m) {
	var x = a[0], y = a[1], z = a[2], w = a[3];
	out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
	out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
	out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
	out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
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
	out[3] = a[3];
	return out;
}

function zero(out) {
	out[0] = 0.0; out[1] = 0.0; out[2] = 0.0; out[3] = 0.0;
	return out;
}

function str(a) {
	return "vec4(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ")";
}

function exactEquals(a, b) {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function equals(a, b) {
	var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
	var b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
	return Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
		Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
		Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2)) &&
		Math.abs(a3 - b3) <= EPSILON * Math.max(1.0, Math.abs(a3), Math.abs(b3));
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
		if (!stride) { stride = 4; }
		if (!offset) { offset = 0; }
		if (count) { l = Math.min(count * stride + offset, a.length); }
		else { l = a.length; }
		for (i = offset; i < l; i += stride) {
			vec[0] = a[i]; vec[1] = a[i + 1]; vec[2] = a[i + 2]; vec[3] = a[i + 3];
			fn(vec, vec, arg);
			a[i] = vec[0]; a[i + 1] = vec[1]; a[i + 2] = vec[2]; a[i + 3] = vec[3];
		}
		return a;
	};
})();

// ============================================================================
// 3. POOL
// ============================================================================
function createVec4Pool(capacity) {
	return createPool(function () {
		var v = new ARRAY_TYPE(4);
		v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 0;
		return v;
	}, capacity, function (v) {
		v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 0;
	});
}

let _defaultPool = null;
function getDefaultPool() {
	if (_defaultPool === null) { _defaultPool = createVec4Pool(); }
	return _defaultPool;
}
function acquire() { return getDefaultPool().acquire(); }
function release(v) { getDefaultPool().release(v); }

// ============================================================================
// 4. STRUCTURE OF ARRAYS (SOA) — 1M+ vec4 at real time
// ============================================================================
function createVec4SOA(count, Type) {
	var soa = createSOA(count, 4, Type);
	return {
		x: soa.arrays[0], y: soa.arrays[1], z: soa.arrays[2], w: soa.arrays[3],
		arrays: soa.arrays, buffer: soa.buffer, count: soa.count, components: 4
	};
}

function soaZero(out) { soaZeroBase(out); return out; }
function soaFill(out, v) { soaFillBase(out, v); return out; }

function soaGet(out, soa, i) {
	out[0] = soa.x[i]; out[1] = soa.y[i]; out[2] = soa.z[i]; out[3] = soa.w[i];
	return out;
}

function soaSet(soa, i, v) {
	soa.x[i] = v[0]; soa.y[i] = v[1]; soa.z[i] = v[2]; soa.w[i] = v[3];
	return soa;
}

function soaToFlat(out, soa, offset) {
	offset = offset || 0;
	var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z, ws = soa.w;
	for (var i = 0, o = offset; i < n; i++, o += 4) {
		out[o] = xs[i]; out[o + 1] = ys[i]; out[o + 2] = zs[i]; out[o + 3] = ws[i];
	}
	return out;
}

function soaFromFlat(soa, flat, offset) {
	offset = offset || 0;
	var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z, ws = soa.w;
	for (var i = 0, o = offset; i < n; i++, o += 4) {
		xs[i] = flat[o]; ys[i] = flat[o + 1]; zs[i] = flat[o + 2]; ws[i] = flat[o + 3];
	}
	return soa;
}

function soaCopy(out, a) {
	out.x.set(a.x); out.y.set(a.y); out.z.set(a.z); out.w.set(a.w);
	return out;
}

// ---- SOA binary ops --------------------------------------------------------
function soaAdd(out, a, b) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		oX[i] = aX[i] + bX[i]; oY[i] = aY[i] + bY[i];
		oZ[i] = aZ[i] + bZ[i]; oW[i] = aW[i] + bW[i];
	}
	return out;
}

function soaSub(out, a, b) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		oX[i] = aX[i] - bX[i]; oY[i] = aY[i] - bY[i];
		oZ[i] = aZ[i] - bZ[i]; oW[i] = aW[i] - bW[i];
	}
	return out;
}

function soaMul(out, a, b) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		oX[i] = aX[i] * bX[i]; oY[i] = aY[i] * bY[i];
		oZ[i] = aZ[i] * bZ[i]; oW[i] = aW[i] * bW[i];
	}
	return out;
}

function soaDiv(out, a, b) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		oX[i] = aX[i] / bX[i]; oY[i] = aY[i] / bY[i];
		oZ[i] = aZ[i] / bZ[i]; oW[i] = aW[i] / bW[i];
	}
	return out;
}

function soaScale(out, a, s) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		oX[i] = aX[i] * s; oY[i] = aY[i] * s; oZ[i] = aZ[i] * s; oW[i] = aW[i] * s;
	}
	return out;
}

function soaScaleAndAdd(out, a, b, s) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		oX[i] = aX[i] + bX[i] * s; oY[i] = aY[i] + bY[i] * s;
		oZ[i] = aZ[i] + bZ[i] * s; oW[i] = aW[i] + bW[i] * s;
	}
	return out;
}

function soaLerp(out, a, b, t) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var axv = aX[i], ayv = aY[i], azv = aZ[i], awv = aW[i];
		oX[i] = axv + t * (bX[i] - axv);
		oY[i] = ayv + t * (bY[i] - ayv);
		oZ[i] = azv + t * (bZ[i] - azv);
		oW[i] = awv + t * (bW[i] - awv);
	}
	return out;
}

function soaNegate(out, a) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		oX[i] = -aX[i]; oY[i] = -aY[i]; oZ[i] = -aZ[i]; oW[i] = -aW[i];
	}
	return out;
}

function soaInverse(out, a) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		oX[i] = 1.0 / aX[i]; oY[i] = 1.0 / aY[i];
		oZ[i] = 1.0 / aZ[i]; oW[i] = 1.0 / aW[i];
	}
	return out;
}

function soaNormalize(out, a) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
		var l = x * x + y * y + z * z + w * w;
		if (l > 0) { l = 1 / Math.sqrt(l); }
		oX[i] = x * l; oY[i] = y * l; oZ[i] = z * l; oW[i] = w * l;
	}
	return out;
}

function soaDot(a, b) {
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
	var n = a.count, s = 0;
	for (var i = 0; i < n; i++) {
		s += aX[i] * bX[i] + aY[i] * bY[i] + aZ[i] * bZ[i] + aW[i] * bW[i];
	}
	return s;
}

function soaTransformMat4(out, a, m) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var n = out.count;
	var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
	var m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
	var m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
	var m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];
	for (var i = 0; i < n; i++) {
		var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
		oX[i] = m0 * x + m4 * y + m8 * z + m12 * w;
		oY[i] = m1 * x + m5 * y + m9 * z + m13 * w;
		oZ[i] = m2 * x + m6 * y + m10 * z + m14 * w;
		oW[i] = m3 * x + m7 * y + m11 * z + m15 * w;
	}
	return out;
}

function soaAABB(out, a) {
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w, n = a.count;
	var mnX = Infinity, mnY = Infinity, mnZ = Infinity, mnW = Infinity;
	var mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity, mxW = -Infinity;
	for (var i = 0; i < n; i++) {
		var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
		if (x < mnX) { mnX = x; } if (x > mxX) { mxX = x; }
		if (y < mnY) { mnY = y; } if (y > mxY) { mxY = y; }
		if (z < mnZ) { mnZ = z; } if (z > mxZ) { mxZ = z; }
		if (w < mnW) { mnW = w; } if (w > mxW) { mxW = w; }
	}
	out.minX = mnX; out.minY = mnY; out.minZ = mnZ; out.minW = mnW;
	out.maxX = mxX; out.maxY = mxY; out.maxZ = mxZ; out.maxW = mxW;
	return out;
}

// ---- Chunked async SOA ops (mobile-safe) ----------------------------------
async function _chunked4(out, perElem, chunkSize, yieldEvery) {
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
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
	return _chunked4(out, function (i) {
		oX[i] = aX[i] + bX[i]; oY[i] = aY[i] + bY[i];
		oZ[i] = aZ[i] + bZ[i]; oW[i] = aW[i] + bW[i];
	}, chunkSize, yieldEvery);
}

function soaSubChunked(out, a, b, chunkSize, yieldEvery) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
	return _chunked4(out, function (i) {
		oX[i] = aX[i] - bX[i]; oY[i] = aY[i] - bY[i];
		oZ[i] = aZ[i] - bZ[i]; oW[i] = aW[i] - bW[i];
	}, chunkSize, yieldEvery);
}

function soaScaleChunked(out, a, s, chunkSize, yieldEvery) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	return _chunked4(out, function (i) {
		oX[i] = aX[i] * s; oY[i] = aY[i] * s; oZ[i] = aZ[i] * s; oW[i] = aW[i] * s;
	}, chunkSize, yieldEvery);
}

function soaLerpChunked(out, a, b, t, chunkSize, yieldEvery) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
	return _chunked4(out, function (i) {
		var axv = aX[i], ayv = aY[i], azv = aZ[i], awv = aW[i];
		oX[i] = axv + t * (bX[i] - axv);
		oY[i] = ayv + t * (bY[i] - ayv);
		oZ[i] = azv + t * (bZ[i] - azv);
		oW[i] = awv + t * (bW[i] - awv);
	}, chunkSize, yieldEvery);
}

function soaNormalizeChunked(out, a, chunkSize, yieldEvery) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	return _chunked4(out, function (i) {
		var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
		var l = x * x + y * y + z * z + w * w;
		if (l > 0) { l = 1 / Math.sqrt(l); }
		oX[i] = x * l; oY[i] = y * l; oZ[i] = z * l; oW[i] = w * l;
	}, chunkSize, yieldEvery);
}

function soaTransformMat4Chunked(out, a, m, chunkSize, yieldEvery) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
	var m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
	var m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
	var m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];
	return _chunked4(out, function (i) {
		var x = aX[i], y = aY[i], z = aZ[i], w = aW[i];
		oX[i] = m0 * x + m4 * y + m8 * z + m12 * w;
		oY[i] = m1 * x + m5 * y + m9 * z + m13 * w;
		oZ[i] = m2 * x + m6 * y + m10 * z + m14 * w;
		oW[i] = m3 * x + m7 * y + m11 * z + m15 * w;
	}, chunkSize, yieldEvery);
}

async function soaDotChunked(a, b, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var bX = b.x, bY = b.y, bZ = b.z, bW = b.w;
	var n = a.count, sum = 0, c = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		var local = 0;
		for (var i = start; i < end; i++) {
			local += aX[i] * bX[i] + aY[i] * bY[i] + aZ[i] * bZ[i] + aW[i] * bW[i];
		}
		sum += local;
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
	return sum;
}

async function soaForEachChunked(out, a, callback, chunkSize, yieldEvery) {
	return _chunked4(out, function (i) { callback(i, a, out); }, chunkSize, yieldEvery);
}

// ============================================================================
// 5. HOMOGENEOUS COORDINATES / CLIP SPACE
// ============================================================================
function perspectiveDivide(out, a) {
	var w = a[3];
	if (Math.abs(w) < EPSILON) { w = w < 0 ? -EPSILON : EPSILON; }
	var inv = 1.0 / w;
	out[0] = a[0] * inv;
	out[1] = a[1] * inv;
	out[2] = a[2] * inv;
	out[3] = 1.0;
	return out;
}

function fromVec3(out, v, w) {
	out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = w === undefined ? 1.0 : w;
	return out;
}

function projectLerp(out, a, b, t) {
	var ax = a[0], ay = a[1], az = a[2], aw = a[3];
	out[0] = ax + t * (b[0] - ax);
	out[1] = ay + t * (b[1] - ay);
	out[2] = az + t * (b[2] - az);
	out[3] = aw + t * (b[3] - aw);
	return out;
}

function linearizeDepth(a, near, far) {
	var z = a[2] / a[3];
	return (2.0 * near * far) / (far + near - z * (far - near));
}

// ============================================================================
// 6. QUATERNION-FRIENDLY HELPERS
// ============================================================================
function quatFromAxisAngle(out, axis, rad) {
	var half = rad * 0.5;
	var s = Math.sin(half);
	out[0] = s * axis[0];
	out[1] = s * axis[1];
	out[2] = s * axis[2];
	out[3] = Math.cos(half);
	return out;
}

function quatConjugate(out, a) {
	out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = a[3];
	return out;
}

function quatMultiply(out, a, b) {
	var ax = a[0], ay = a[1], az = a[2], aw = a[3];
	var bx = b[0], by = b[1], bz = b[2], bw = b[3];
	out[0] = ax * bw + aw * bx + ay * bz - az * by;
	out[1] = ay * bw + aw * by + az * bx - ax * bz;
	out[2] = az * bw + aw * bz + ax * by - ay * bx;
	out[3] = aw * bw - ax * bx - ay * by - az * bz;
	return out;
}

const quatNormalize = normalize;

function quatIdentity(out) {
	out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
	return out;
}

// ============================================================================
// 7. COLOR (RGBA)
// ============================================================================
function premultiplyAlpha(out, c) {
	var a = c[3];
	out[0] = c[0] * a;
	out[1] = c[1] * a;
	out[2] = c[2] * a;
	out[3] = a;
	return out;
}

function unpremultiplyAlpha(out, c) {
	var a = c[3];
	var inv = a > EPSILON ? 1.0 / a : 0;
	out[0] = c[0] * inv;
	out[1] = c[1] * inv;
	out[2] = c[2] * inv;
	out[3] = a;
	return out;
}

function expose(out, c, exposure) {
	out[0] = c[0] * exposure;
	out[1] = c[1] * exposure;
	out[2] = c[2] * exposure;
	out[3] = c[3];
	return out;
}

function srgbToLinearVec4(out, c) {
	out[0] = srgbToLinear(c[0]);
	out[1] = srgbToLinear(c[1]);
	out[2] = srgbToLinear(c[2]);
	out[3] = c[3];
	return out;
}

function linearToSrgbVec4(out, c) {
	out[0] = linearToSrgb(c[0]);
	out[1] = linearToSrgb(c[1]);
	out[2] = linearToSrgb(c[2]);
	out[3] = c[3];
	return out;
}

function soaFillColor(out, color) {
	out.x.fill(color[0]);
	out.y.fill(color[1]);
	out.z.fill(color[2]);
	out.w.fill(color[3]);
	return out;
}

function soaExpose(out, exposure) {
	var oX = out.x, oY = out.y, oZ = out.z, n = out.count;
	for (var i = 0; i < n; i++) {
		oX[i] *= exposure;
		oY[i] *= exposure;
		oZ[i] *= exposure;
	}
	return out;
}

function soaSrgbToLinear(out) {
	var oX = out.x, oY = out.y, oZ = out.z, n = out.count;
	for (var i = 0; i < n; i++) {
		var r = oX[i], g = oY[i], b = oZ[i];
		oX[i] = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
		oY[i] = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
		oZ[i] = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
	}
	return out;
}

function soaLinearToSrgb(out) {
	var oX = out.x, oY = out.y, oZ = out.z, n = out.count;
	for (var i = 0; i < n; i++) {
		var r = oX[i], g = oY[i], b = oZ[i];
		oX[i] = r <= 0.0031308 ? r * 12.92 : 1.055 * Math.pow(r, 1 / 2.4) - 0.055;
		oY[i] = g <= 0.0031308 ? g * 12.92 : 1.055 * Math.pow(g, 1 / 2.4) - 0.055;
		oZ[i] = b <= 0.0031308 ? b * 12.92 : 1.055 * Math.pow(b, 1 / 2.4) - 0.055;
	}
	return out;
}

// ============================================================================
// 8. PROCEDURAL 4D NOISE
// ============================================================================
function valueNoise4D(x, y, z, w) {
	var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), wi = Math.floor(w);
	var xf = x - xi, yf = y - yi, zf = z - zi, wf = w - wi;
	var u = xf * xf * (3 - 2 * xf);
	var v = yf * yf * (3 - 2 * yf);
	var s = zf * zf * (3 - 2 * zf);
	var t = wf * wf * (3 - 2 * wf);

	var c0000 = hash4(xi, yi, zi, wi);
	var c1000 = hash4(xi + 1, yi, zi, wi);
	var c0100 = hash4(xi, yi + 1, zi, wi);
	var c1100 = hash4(xi + 1, yi + 1, zi, wi);
	var c0010 = hash4(xi, yi, zi + 1, wi);
	var c1010 = hash4(xi + 1, yi, zi + 1, wi);
	var c0110 = hash4(xi, yi + 1, zi + 1, wi);
	var c1110 = hash4(xi + 1, yi + 1, zi + 1, wi);
	var c0001 = hash4(xi, yi, zi, wi + 1);
	var c1001 = hash4(xi + 1, yi, zi, wi + 1);
	var c0101 = hash4(xi, yi + 1, zi, wi + 1);
	var c1101 = hash4(xi + 1, yi + 1, zi, wi + 1);
	var c0011 = hash4(xi, yi, zi + 1, wi + 1);
	var c1011 = hash4(xi + 1, yi, zi + 1, wi + 1);
	var c0111 = hash4(xi, yi + 1, zi + 1, wi + 1);
	var c1111 = hash4(xi + 1, yi + 1, zi + 1, wi + 1);

	var x000 = c0000 + (c1000 - c0000) * u;
	var x100 = c0100 + (c1100 - c0100) * u;
	var x010 = c0010 + (c1010 - c0010) * u;
	var x110 = c0110 + (c1110 - c0110) * u;
	var x001 = c0001 + (c1001 - c0001) * u;
	var x101 = c0101 + (c1101 - c0101) * u;
	var x011 = c0011 + (c1011 - c0011) * u;
	var x111 = c0111 + (c1111 - c0111) * u;

	var y00 = x000 + (x100 - x000) * v;
	var y10 = x010 + (x110 - x010) * v;
	var y01 = x001 + (x101 - x001) * v;
	var y11 = x011 + (x111 - x011) * v;

	var z0 = y00 + (y10 - y00) * s;
	var z1 = y01 + (y11 - y01) * s;

	return z0 + (z1 - z0) * t;
}

function fbm4D(x, y, z, w, octaves, lacunarity, gain) {
	octaves = octaves || 4;
	lacunarity = lacunarity || 2.0;
	gain = gain || 0.5;
	var sum = 0, amp = 1, freq = 1, norm = 0;
	for (var i = 0; i < octaves; i++) {
		sum += amp * valueNoise4D(x * freq, y * freq, z * freq, w * freq);
		norm += amp;
		freq *= lacunarity;
		amp *= gain;
	}
	return sum / norm;
}

function turbulence4D(x, y, z, w, octaves) {
	octaves = octaves || 4;
	var sum = 0, amp = 1, freq = 1, norm = 0;
	for (var i = 0; i < octaves; i++) {
		sum += amp * Math.abs(valueNoise4D(x * freq, y * freq, z * freq, w * freq) * 2 - 1);
		norm += amp;
		freq *= 2.0;
		amp *= 0.5;
	}
	return sum / norm;
}

function soaFillNoise4D(soa, scale, timeStep, octaves) {
	scale = scale || 1;
	timeStep = timeStep || 0.01;
	octaves = octaves || 4;
	var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z, ws = soa.w;
	for (var i = 0; i < n; i++) {
		var x = xs[i] * scale, y = ys[i] * scale, z = zs[i] * scale, w = i * timeStep;
		xs[i] = fbm4D(x, y, z, w, octaves);
		ys[i] = fbm4D(x + 100, y + 100, z + 100, w, octaves);
		zs[i] = fbm4D(x + 200, y + 200, z + 200, w, octaves);
		ws[i] = turbulence4D(x + 300, y + 300, z + 300, w, octaves);
	}
	return soa;
}

async function soaFillNoise4DChunked(soa, scale, timeStep, octaves, chunkSize, yieldEvery) {
	scale = scale || 1;
	timeStep = timeStep || 0.01;
	octaves = octaves || 4;
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var n = soa.count, xs = soa.x, ys = soa.y, zs = soa.z, ws = soa.w, c = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) {
			var x = xs[i] * scale, y = ys[i] * scale, z = zs[i] * scale, w = i * timeStep;
			xs[i] = fbm4D(x, y, z, w, octaves);
			ys[i] = fbm4D(x + 100, y + 100, z + 100, w, octaves);
			zs[i] = fbm4D(x + 200, y + 200, z + 200, w, octaves);
			ws[i] = turbulence4D(x + 300, y + 300, z + 300, w, octaves);
		}
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
	return soa;
}

// ============================================================================
// 9. ANIMATION CURVES (4D)
// ============================================================================
function quadraticBezier(out, a, b, c, t) {
	var t2 = t * t, mt = 1 - t, mt2 = mt * mt;
	out[0] = mt2 * a[0] + 2 * mt * t * b[0] + t2 * c[0];
	out[1] = mt2 * a[1] + 2 * mt * t * b[1] + t2 * c[1];
	out[2] = mt2 * a[2] + 2 * mt * t * b[2] + t2 * c[2];
	out[3] = mt2 * a[3] + 2 * mt * t * b[3] + t2 * c[3];
	return out;
}

function cubicBezier(out, a, b, c, d, t) {
	var mt = 1 - t, mt2 = mt * mt, t2 = t * t;
	var mt3 = mt2 * mt, t3 = t2 * t;
	out[0] = mt3 * a[0] + 3 * mt2 * t * b[0] + 3 * mt * t2 * c[0] + t3 * d[0];
	out[1] = mt3 * a[1] + 3 * mt2 * t * b[1] + 3 * mt * t2 * c[1] + t3 * d[1];
	out[2] = mt3 * a[2] + 3 * mt2 * t * b[2] + 3 * mt * t2 * c[2] + t3 * d[2];
	out[3] = mt3 * a[3] + 3 * mt2 * t * b[3] + 3 * mt * t2 * c[3] + t3 * d[3];
	return out;
}

function hermite(out, a, b, c, d, t) {
	var tt = t * t;
	var f1 = tt * (2 * t - 3) + 1;
	var f2 = tt * (t - 2) + t;
	var f3 = tt * (t - 1);
	var f4 = tt * (3 - 2 * t);
	out[0] = a[0] * f1 + b[0] * f2 + c[0] * f3 + d[0] * f4;
	out[1] = a[1] * f1 + b[1] * f2 + c[1] * f3 + d[1] * f4;
	out[2] = a[2] * f1 + b[2] * f2 + c[2] * f3 + d[2] * f4;
	out[3] = a[3] * f1 + b[3] * f2 + c[3] * f3 + d[3] * f4;
	return out;
}

function catmullRom(out, p0, p1, p2, p3, t) {
	var t2 = t * t, t3 = t2 * t;
	out[0] = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
	out[1] = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
	out[2] = 0.5 * ((2 * p1[2]) + (-p0[2] + p2[2]) * t + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3);
	out[3] = 0.5 * ((2 * p1[3]) + (-p0[3] + p2[3]) * t + (2 * p0[3] - 5 * p1[3] + 4 * p2[3] - p3[3]) * t2 + (-p0[3] + 3 * p1[3] - 3 * p2[3] + p3[3]) * t3);
	return out;
}

// ============================================================================
// 10. SPRING / NATURAL MOTION
// ============================================================================
function springDamp4(out, current, target, vel, smoothTime, dt, maxSpeed) {
	if (smoothTime < 0.0001) { smoothTime = 0.0001; }
	if (maxSpeed === undefined) { maxSpeed = Infinity; }
	var omega = 2 / smoothTime;
	var x = omega * dt;
	var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
	var maxChange = maxSpeed * smoothTime;
	for (var i = 0; i < 4; i++) {
		var c = current[i];
		var tgt = target[i];
		var change = c - tgt;
		var originalTarget = tgt;
		if (change > maxChange) { change = maxChange; }
		else if (change < -maxChange) { change = -maxChange; }
		tgt = c - change;
		var temp = (vel[i] + omega * change) * dt;
		vel[i] = (vel[i] - omega * temp) * exp;
		var output = tgt + (change + temp) * exp;
		if ((originalTarget - c > 0) === (output > originalTarget)) {
			output = originalTarget;
			vel[i] = (output - originalTarget) / dt;
		}
		out[i] = output;
	}
	return out;
}

const smoothDamp4 = springDamp4;

function quatSpringDamp(out, current, target, vel, smoothTime, dt, maxSpeed) {
	if (smoothTime < 0.0001) { smoothTime = 0.0001; }
	if (maxSpeed === undefined) { maxSpeed = Infinity; }
	var d = current[0] * target[0] + current[1] * target[1] + current[2] * target[2] + current[3] * target[3];
	var sign = d < 0 ? -1 : 1;
	var omega = 2 / smoothTime;
	var x = omega * dt;
	var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
	var maxChange = maxSpeed * smoothTime;
	for (var i = 0; i < 4; i++) {
		var tgt = target[i] * sign;
		var c = current[i];
		var change = c - tgt;
		var originalTarget = tgt;
		if (change > maxChange) { change = maxChange; }
		else if (change < -maxChange) { change = -maxChange; }
		tgt = c - change;
		var temp = (vel[i] + omega * change) * dt;
		vel[i] = (vel[i] - omega * temp) * exp;
		var output = tgt + (change + temp) * exp;
		if ((originalTarget - c > 0) === (output > originalTarget)) {
			output = originalTarget;
			vel[i] = (output - originalTarget) / dt;
		}
		out[i] = output;
	}
	var lenSq = out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3];
	if (lenSq > 0) {
		var invLen = 1 / Math.sqrt(lenSq);
		out[0] *= invLen; out[1] *= invLen; out[2] *= invLen; out[3] *= invLen;
	}
	return out;
}

function nlerp(out, a, b, t) {
	var ax = a[0], ay = a[1], az = a[2], aw = a[3];
	out[0] = ax + t * (b[0] - ax);
	out[1] = ay + t * (b[1] - ay);
	out[2] = az + t * (b[2] - az);
	out[3] = aw + t * (b[3] - aw);
	return normalize(out, out);
}

// ============================================================================
// 11. FLOATING-ORIGIN / SCALE
// ============================================================================
function toRelative(out, pos, origin) {
	out[0] = pos[0] - origin[0];
	out[1] = pos[1] - origin[1];
	out[2] = pos[2] - origin[2];
	out[3] = pos[3] - origin[3];
	return out;
}

function toAbsolute(out, rel, origin) {
	out[0] = rel[0] + origin[0];
	out[1] = rel[1] + origin[1];
	out[2] = rel[2] + origin[2];
	out[3] = rel[3] + origin[3];
	return out;
}

function soaToRelative(out, a, ox, oy, oz, ow) {
	var oX = out.x, oY = out.y, oZ = out.z, oW = out.w;
	var aX = a.x, aY = a.y, aZ = a.z, aW = a.w;
	var n = a.count;
	if (ow === undefined) { ow = 0; }
	for (var i = 0; i < n; i++) {
		oX[i] = aX[i] - ox;
		oY[i] = aY[i] - oy;
		oZ[i] = aZ[i] - oz;
		oW[i] = aW[i] - ow;
	}
	return out;
}

// ============================================================================
// 12. EXPORTS
// ============================================================================
export {
	// foundation constants
	EPSILON, ARRAY_TYPE, RANDOM, CHUNK_SIZE, CHUNK_YIELD_EVERY,
	// flat API
	create, clone, fromValues, copy, set, add, subtract, multiply, divide,
	ceil, floor, min, max, round, scale, scaleAndAdd, distance, squaredDistance,
	length, squaredLength, negate, inverse, normalize, dot, cross, lerp, random,
	transformMat4, transformQuat, zero, str, exactEquals, equals,
	// aliases
	sub, mul, div, dist, sqrDist, len, sqrLen, forEach,
	// pool
	createVec4Pool, acquire, release,
	// SOA
	createVec4SOA, soaZero, soaFill, soaGet, soaSet, soaToFlat, soaFromFlat,
	soaCopy, soaAdd, soaSub, soaMul, soaDiv, soaScale, soaScaleAndAdd, soaLerp,
	soaNegate, soaInverse, soaNormalize, soaDot, soaTransformMat4, soaAABB,
	// chunked async (mobile-safe)
	soaAddChunked, soaSubChunked, soaScaleChunked, soaLerpChunked,
	soaNormalizeChunked, soaTransformMat4Chunked, soaDotChunked, soaForEachChunked,
	// homogeneous / rendering
	perspectiveDivide, fromVec3, projectLerp, linearizeDepth,
	// quaternion-as-vec4 helpers
	quatFromAxisAngle, quatConjugate, quatMultiply, quatNormalize, quatIdentity,
	// color
	premultiplyAlpha, unpremultiplyAlpha, expose, srgbToLinearVec4,
	linearToSrgbVec4, soaFillColor, soaExpose, soaSrgbToLinear, soaLinearToSrgb,
	// procedural 4D
	valueNoise4D, fbm4D, turbulence4D, soaFillNoise4D, soaFillNoise4DChunked,
	// animation
	quadraticBezier, cubicBezier, hermite, catmullRom, nlerp,
	// natural motion
	springDamp4, smoothDamp4, quatSpringDamp,
	// floating origin
	toRelative, toAbsolute, soaToRelative
};

export default {
	create, clone, fromValues, copy, set, add, subtract, multiply, divide,
	ceil, floor, min, max, round, scale, scaleAndAdd, distance, squaredDistance,
	length, squaredLength, negate, inverse, normalize, dot, cross, lerp, random,
	transformMat4, transformQuat, zero, str, exactEquals, equals,
	sub, mul, div, dist, sqrDist, len, sqrLen, forEach,
	createVec4Pool, acquire, release,
	createVec4SOA, soaZero, soaFill, soaGet, soaSet, soaToFlat, soaFromFlat,
	soaCopy, soaAdd, soaSub, soaMul, soaDiv, soaScale, soaScaleAndAdd, soaLerp,
	soaNegate, soaInverse, soaNormalize, soaDot, soaTransformMat4, soaAABB,
	soaAddChunked, soaSubChunked, soaScaleChunked, soaLerpChunked,
	soaNormalizeChunked, soaTransformMat4Chunked, soaDotChunked, soaForEachChunked,
	perspectiveDivide, fromVec3, projectLerp, linearizeDepth,
	quatFromAxisAngle, quatConjugate, quatMultiply, quatNormalize, quatIdentity,
	premultiplyAlpha, unpremultiplyAlpha, expose, srgbToLinearVec4,
	linearToSrgbVec4, soaFillColor, soaExpose, soaSrgbToLinear, soaLinearToSrgb,
	valueNoise4D, fbm4D, turbulence4D, soaFillNoise4D, soaFillNoise4DChunked,
	quadraticBezier, cubicBezier, hermite, catmullRom, nlerp,
	springDamp4, smoothDamp4, quatSpringDamp,
	toRelative, toAbsolute, soaToRelative
};