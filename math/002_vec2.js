// File number : 002
// File : src/math/002_vec2.js
// Description : 2D vector math (glMatrix API) + SOA bulk layout, pooling, chunked
//               parallelism, procedural 2D noise/Voronoi/fBm, animation curves
//               (bezier, catmull-rom, spring), and 2D orbital helpers.
// Best for : 3d graphics supporting 2D primitives -- procedural generation
//            (heightmaps, UV warp, Voronoi cells, fBm clouds), rendering
//            (sprite batching, screen-space decals, UV transforms), color
//            (2D gradients, LUT sampling), animation (bezier paths,
//            catmull-rom splines, spring follow), natural IK motion (2D
//            FABRIK chains, camera look-ahead, pendulum), orbital (polar
//            orbits, 2D ellipses, tangential motion), seamless small-to-
//            galactic scale (2D UV scratch, map coordinates). Real-time on
//            1M+ instances via SOA + chunked parallelism.
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

// Deterministic 2D spatial hash returning [0,1]
function hash2(x, y) {
	var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
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

	if (Type === Array) {
		var arrays = [];
		for (var c = 0; c < components; c++) {
			arrays.push(new Array(count).fill(0));
		}
		return { arrays: arrays, buffer: null, count: count, components: components };
	}

	var bytes = Type.BYTES_PER_ELEMENT || 4;
	var buffer = new ArrayBuffer(count * components * bytes);
	var arrays2 = [];
	for (var k = 0; k < components; k++) {
		arrays2.push(new Type(buffer, k * count * bytes, count));
	}
	return { arrays: arrays2, buffer: buffer, count: count, components: components };
}

function soaZeroBase(out) {
	for (var c = 0; c < out.arrays.length; c++) { out.arrays[c].fill(0); }
	return out;
}

function soaFillBase(out, v) {
	if (v === undefined) { return out; }

	if (typeof v === "number") {
		for (var c = 0; c < out.arrays.length; c++) { out.arrays[c].fill(v); }
	} else {
		for (var i = 0; i < out.arrays.length; i++) { out.arrays[i].fill(v[i]); }
	}
	return out;
}

// ============================================================================
// 1. FLAT API (glMatrix compatible, original signatures preserved)
// ============================================================================
/**
2 Dimensional Vector
@module vec2
*/
function create() {
	var out = new ARRAY_TYPE(2);
	if (ARRAY_TYPE !== Float32Array) {
		out[0] = 0;
		out[1] = 0;
	}
	return out;
}

function clone(a) {
	var out = new ARRAY_TYPE(2);
	out[0] = a[0];
	out[1] = a[1];
	return out;
}

function fromValues(x, y) {
	var out = new ARRAY_TYPE(2);
	out[0] = x;
	out[1] = y;
	return out;
}

function copy(out, a) {
	out[0] = a[0];
	out[1] = a[1];
	return out;
}

function set(out, x, y) {
	out[0] = x;
	out[1] = y;
	return out;
}

function add(out, a, b) {
	out[0] = a[0] + b[0];
	out[1] = a[1] + b[1];
	return out;
}

function subtract(out, a, b) {
	out[0] = a[0] - b[0];
	out[1] = a[1] - b[1];
	return out;
}

function multiply(out, a, b) {
	out[0] = a[0] * b[0];
	out[1] = a[1] * b[1];
	return out;
}

function divide(out, a, b) {
	out[0] = a[0] / b[0];
	out[1] = a[1] / b[1];
	return out;
}

function ceil(out, a) {
	out[0] = Math.ceil(a[0]);
	out[1] = Math.ceil(a[1]);
	return out;
}

function floor(out, a) {
	out[0] = Math.floor(a[0]);
	out[1] = Math.floor(a[1]);
	return out;
}

function min(out, a, b) {
	out[0] = Math.min(a[0], b[0]);
	out[1] = Math.min(a[1], b[1]);
	return out;
}

function max(out, a, b) {
	out[0] = Math.max(a[0], b[0]);
	out[1] = Math.max(a[1], b[1]);
	return out;
}

function round(out, a) {
	out[0] = roundScalar(a[0]);
	out[1] = roundScalar(a[1]);
	return out;
}

function scale(out, a, b) {
	out[0] = a[0] * b;
	out[1] = a[1] * b;
	return out;
}

function scaleAndAdd(out, a, b, scaleValue) {
	out[0] = a[0] + b[0] * scaleValue;
	out[1] = a[1] + b[1] * scaleValue;
	return out;
}

function distance(a, b) {
	var x = b[0] - a[0];
	var y = b[1] - a[1];
	return Math.sqrt(x * x + y * y);
}

function squaredDistance(a, b) {
	var x = b[0] - a[0];
	var y = b[1] - a[1];
	return x * x + y * y;
}

function length(a) {
	var x = a[0];
	var y = a[1];
	return Math.sqrt(x * x + y * y);
}

function squaredLength(a) {
	var x = a[0];
	var y = a[1];
	return x * x + y * y;
}

function negate(out, a) {
	out[0] = -a[0];
	out[1] = -a[1];
	return out;
}

function inverse(out, a) {
	out[0] = 1.0 / a[0];
	out[1] = 1.0 / a[1];
	return out;
}

function normalize(out, a) {
	var x = a[0];
	var y = a[1];
	var len = x * x + y * y;
	if (len > 0) { len = 1 / Math.sqrt(len); }
	out[0] = a[0] * len;
	out[1] = a[1] * len;
	return out;
}

function dot(a, b) {
	return a[0] * b[0] + a[1] * b[1];
}

function cross(out, a, b) {
	var z = a[0] * b[1] - a[1] * b[0];
	out[0] = 0;
	out[1] = 0;
	out[2] = z;
	return out;
}

function lerp(out, a, b, t) {
	var ax = a[0];
	var ay = a[1];
	out[0] = ax + t * (b[0] - ax);
	out[1] = ay + t * (b[1] - ay);
	return out;
}

function random(out, scaleValue) {
	scaleValue = scaleValue === undefined ? 1.0 : scaleValue;
	var r = RANDOM() * 2.0 * Math.PI;
	out[0] = Math.cos(r) * scaleValue;
	out[1] = Math.sin(r) * scaleValue;
	return out;
}

function transformMat2(out, a, m) {
	var x = a[0];
	var y = a[1];
	out[0] = m[0] * x + m[2] * y;
	out[1] = m[1] * x + m[3] * y;
	return out;
}

function transformMat2d(out, a, m) {
	var x = a[0];
	var y = a[1];
	out[0] = m[0] * x + m[2] * y + m[4];
	out[1] = m[1] * x + m[3] * y + m[5];
	return out;
}

function transformMat3(out, a, m) {
	var x = a[0];
	var y = a[1];
	out[0] = m[0] * x + m[3] * y + m[6];
	out[1] = m[1] * x + m[4] * y + m[7];
	return out;
}

function transformMat4(out, a, m) {
	var x = a[0];
	var y = a[1];
	out[0] = m[0] * x + m[4] * y + m[12];
	out[1] = m[1] * x + m[5] * y + m[13];
	return out;
}

function rotate(out, a, b, rad) {
	var p0 = a[0] - b[0];
	var p1 = a[1] - b[1];
	var sinC = Math.sin(rad);
	var cosC = Math.cos(rad);
	out[0] = p0 * cosC - p1 * sinC + b[0];
	out[1] = p0 * sinC + p1 * cosC + b[1];
	return out;
}

function angle(a, b) {
	var ax = a[0];
	var ay = a[1];
	var bx = b[0];
	var by = b[1];
	return Math.abs(Math.atan2(ay * bx - ax * by, ax * bx + ay * by));
}

function signedAngle(a, b) {
	var ax = a[0];
	var ay = a[1];
	var bx = b[0];
	var by = b[1];
	return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

function zero(out) {
	out[0] = 0.0;
	out[1] = 0.0;
	return out;
}

function str(a) {
	return "vec2(" + a[0] + ", " + a[1] + ")";
}

function exactEquals(a, b) {
	return a[0] === b[0] && a[1] === b[1];
}

function equals(a, b) {
	var a0 = a[0];
	var a1 = a[1];
	var b0 = b[0];
	var b1 = b[1];
	return Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
		Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1));
}

// ============================================================================
// 2. ALIASES (glMatrix)
// ============================================================================
const len = length;
const sub = subtract;
const mul = multiply;
const div = divide;
const dist = distance;
const sqrDist = squaredDistance;
const sqrLen = squaredLength;

const forEach = (function () {
	var vec = create();
	return function (a, stride, offset, count, fn, arg) {
		var i, l;
		if (!stride) { stride = 2; }
		if (!offset) { offset = 0; }
		if (count) { l = Math.min(count * stride + offset, a.length); }
		else { l = a.length; }

		for (i = offset; i < l; i += stride) {
			vec[0] = a[i];
			vec[1] = a[i + 1];
			fn(vec, vec, arg);
			a[i] = vec[0];
			a[i + 1] = vec[1];
		}
		return a;
	};
})();

// ============================================================================
// 3. POOL (zero-GC acquire / release for hot loops)
// ============================================================================
function createVec2Pool(capacity) {
	return createPool(function () {
		var v = new ARRAY_TYPE(2);
		v[0] = 0;
		v[1] = 0;
		return v;
	}, capacity, function (v) {
		v[0] = 0;
		v[1] = 0;
	});
}

var _defaultPool = null;

function getDefaultPool() {
	if (_defaultPool === null) { _defaultPool = createVec2Pool(); }
	return _defaultPool;
}

function acquire() {
	return getDefaultPool().acquire();
}

function release(v) {
	getDefaultPool().release(v);
}

// ============================================================================
// 4. STRUCTURE OF ARRAYS (SOA) -- 1M+ vec2 at real time
// ============================================================================
function createVec2SOA(count, Type) {
	var soa = createSOA(count, 2, Type);
	return {
		x: soa.arrays[0],
		y: soa.arrays[1],
		arrays: soa.arrays,
		buffer: soa.buffer,
		count: soa.count,
		components: 2
	};
}

function soaZero(out) {
	soaZeroBase(out);
	return out;
}

function soaFill(out, v) {
	soaFillBase(out, v);
	return out;
}

function soaGet(out, soa, i) {
	out[0] = soa.x[i];
	out[1] = soa.y[i];
	return out;
}

function soaSet(soa, i, v) {
	soa.x[i] = v[0];
	soa.y[i] = v[1];
	return soa;
}

function soaToFlat(out, soa, offset) {
	offset = offset || 0;
	var n = soa.count;
	var xs = soa.x;
	var ys = soa.y;
	for (var i = 0, o = offset; i < n; i++, o += 2) {
		out[o] = xs[i];
		out[o + 1] = ys[i];
	}
	return out;
}

function soaFromFlat(soa, flat, offset) {
	offset = offset || 0;
	var n = soa.count;
	var xs = soa.x;
	var ys = soa.y;
	for (var i = 0, o = offset; i < n; i++, o += 2) {
		xs[i] = flat[o];
		ys[i] = flat[o + 1];
	}
	return soa;
}

function soaCopy(out, a) {
	out.x.set(a.x);
	out.y.set(a.y);
	return out;
}

// ---- SOA binary ops --------------------------------------------------------
function soaAdd(out, a, b) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] + bx[i];
		oy[i] = ay[i] + by[i];
	}
	return out;
}

function soaSub(out, a, b) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] - bx[i];
		oy[i] = ay[i] - by[i];
	}
	return out;
}

function soaMul(out, a, b) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] * bx[i];
		oy[i] = ay[i] * by[i];
	}
	return out;
}

function soaDiv(out, a, b) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] / bx[i];
		oy[i] = ay[i] / by[i];
	}
	return out;
}

function soaScale(out, a, s) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] * s;
		oy[i] = ay[i] * s;
	}
	return out;
}

function soaScaleAndAdd(out, a, b, s) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] + bx[i] * s;
		oy[i] = ay[i] + by[i] * s;
	}
	return out;
}

function soaLerp(out, a, b, t) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var axv = ax[i];
		var ayv = ay[i];
		ox[i] = axv + t * (bx[i] - axv);
		oy[i] = ayv + t * (by[i] - ayv);
	}
	return out;
}

function soaNegate(out, a) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = -ax[i];
		oy[i] = -ay[i];
	}
	return out;
}

function soaInverse(out, a) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = 1.0 / ax[i];
		oy[i] = 1.0 / ay[i];
	}
	return out;
}

function soaNormalize(out, a) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var x = ax[i];
		var y = ay[i];
		var l = x * x + y * y;
		if (l > 0) { l = 1 / Math.sqrt(l); }
		ox[i] = x * l;
		oy[i] = y * l;
	}
	return out;
}

function soaMin(out, a, b) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] < bx[i] ? ax[i] : bx[i];
		oy[i] = ay[i] < by[i] ? ay[i] : by[i];
	}
	return out;
}

function soaMax(out, a, b) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		ox[i] = ax[i] > bx[i] ? ax[i] : bx[i];
		oy[i] = ay[i] > by[i] ? ay[i] : by[i];
	}
	return out;
}

function soaTransformMat2d(out, a, m) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var n = out.count;
	var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5];
	for (var i = 0; i < n; i++) {
		var x = ax[i];
		var y = ay[i];
		ox[i] = m0 * x + m2 * y + m4;
		oy[i] = m1 * x + m3 * y + m5;
	}
	return out;
}

// ---- SOA aggregates ---------------------------------------------------------
function soaDot(a, b) {
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;
	var n = a.count;
	var s = 0;
	for (var i = 0; i < n; i++) {
		s += ax[i] * bx[i] + ay[i] * by[i];
	}
	return s;
}

function soaMinComponent(a) {
	var ax = a.x, ay = a.y;
	var n = a.count;
	var m = Infinity;
	for (var i = 0; i < n; i++) {
		if (ax[i] < m) { m = ax[i]; }
		if (ay[i] < m) { m = ay[i]; }
	}
	return m;
}

function soaMaxComponent(a) {
	var ax = a.x, ay = a.y;
	var n = a.count;
	var m = -Infinity;
	for (var i = 0; i < n; i++) {
		if (ax[i] > m) { m = ax[i]; }
		if (ay[i] > m) { m = ay[i]; }
	}
	return m;
}

function soaAABB(out, a) {
	var ax = a.x, ay = a.y;
	var n = a.count;
	var minX = Infinity, minY = Infinity;
	var maxX = -Infinity, maxY = -Infinity;

	for (var i = 0; i < n; i++) {
		var x = ax[i];
		var y = ay[i];

		if (x < minX) { minX = x; }
		if (x > maxX) { maxX = x; }
		if (y < minY) { minY = y; }
		if (y > maxY) { maxY = y; }
	}

	out.minX = minX;
	out.minY = minY;
	out.maxX = maxX;
	out.maxY = maxY;
	return out;
}

// ---- SOA chunked async ops (mobile-safe, no UI freeze at 1M+) ---------------
async function _chunked2(out, perElem, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;

	var n = out.count;
	var c = 0;

	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) { perElem(i); }
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
	return out;
}

function soaAddChunked(out, a, b, chunkSize, yieldEvery) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;

	return _chunked2(out, function (i) {
		ox[i] = ax[i] + bx[i];
		oy[i] = ay[i] + by[i];
	}, chunkSize, yieldEvery);
}

function soaSubChunked(out, a, b, chunkSize, yieldEvery) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;

	return _chunked2(out, function (i) {
		ox[i] = ax[i] - bx[i];
		oy[i] = ay[i] - by[i];
	}, chunkSize, yieldEvery);
}

function soaScaleChunked(out, a, s, chunkSize, yieldEvery) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;

	return _chunked2(out, function (i) {
		ox[i] = ax[i] * s;
		oy[i] = ay[i] * s;
	}, chunkSize, yieldEvery);
}

function soaLerpChunked(out, a, b, t, chunkSize, yieldEvery) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;

	return _chunked2(out, function (i) {
		var axv = ax[i];
		var ayv = ay[i];
		ox[i] = axv + t * (bx[i] - axv);
		oy[i] = ayv + t * (by[i] - ayv);
	}, chunkSize, yieldEvery);
}

function soaNormalizeChunked(out, a, chunkSize, yieldEvery) {
	var ox = out.x, oy = out.y;
	var ax = a.x, ay = a.y;

	return _chunked2(out, function (i) {
		var x = ax[i];
		var y = ay[i];
		var l = x * x + y * y;
		if (l > 0) { l = 1 / Math.sqrt(l); }
		ox[i] = x * l;
		oy[i] = y * l;
	}, chunkSize, yieldEvery);
}

async function soaDotChunked(a, b, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;

	var ax = a.x, ay = a.y;
	var bx = b.x, by = b.y;
	var n = a.count;
	var sum = 0;
	var c = 0;

	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		var local = 0;

		for (var i = start; i < end; i++) {
			local += ax[i] * bx[i] + ay[i] * by[i];
		}

		sum += local;

		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}

	return sum;
}

async function soaForEachChunked(out, a, callback, chunkSize, yieldEvery) {
	return _chunked2(out, function (i) {
		callback(i, a, out);
	}, chunkSize, yieldEvery);
}

// ============================================================================
// 5. PROCEDURAL 2D GENERATION
// ============================================================================
const GRAD2_X = new Float32Array([
	1, -1, 0, 0,
	0.7071067811865476, -0.7071067811865476,
	0.7071067811865476, -0.7071067811865476
]);

const GRAD2_Y = new Float32Array([
	0, 0, 1, -1,
	0.7071067811865476, 0.7071067811865476,
	-0.7071067811865476, -0.7071067811865476
]);

function _gradDot(ix, iy, dx, dy) {
	var h = (hash2(ix, iy) * 8) | 0;
	var idx = h & 7;
	return GRAD2_X[idx] * dx + GRAD2_Y[idx] * dy;
}

function valueNoise2D(x, y) {
	var xi = Math.floor(x);
	var yi = Math.floor(y);
	var xf = x - xi;
	var yf = y - yi;

	var u = xf * xf * (3 - 2 * xf);
	var v = yf * yf * (3 - 2 * yf);

	var a = hash2(xi, yi);
	var b = hash2(xi + 1, yi);
	var c = hash2(xi, yi + 1);
	var d = hash2(xi + 1, yi + 1);

	var x1 = a + (b - a) * u;
	var x2 = c + (d - c) * u;
	return x1 + (x2 - x1) * v;
}

function gradientNoise2D(x, y) {
	var xi = Math.floor(x);
	var yi = Math.floor(y);
	var xf = x - xi;
	var yf = y - yi;

	var u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
	var v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

	var n00 = _gradDot(xi, yi, xf, yf);
	var n10 = _gradDot(xi + 1, yi, xf - 1, yf);
	var n01 = _gradDot(xi, yi + 1, xf, yf - 1);
	var n11 = _gradDot(xi + 1, yi + 1, xf - 1, yf - 1);

	var x1 = n00 + (n10 - n00) * u;
	var x2 = n01 + (n11 - n01) * u;
	return x1 + (x2 - x1) * v;
}

function fbm2D(x, y, octaves, lacunarity, gain) {
	octaves = octaves || 4;
	lacunarity = lacunarity || 2.0;
	gain = gain || 0.5;

	var sum = 0;
	var amp = 1;
	var freq = 1;
	var norm = 0;

	for (var i = 0; i < octaves; i++) {
		sum += amp * gradientNoise2D(x * freq, y * freq);
		norm += amp;
		freq *= lacunarity;
		amp *= gain;
	}

	return 0.5 + 0.5 * (sum / norm);
}

function voronoi2D(out, x, y) {
	var xi = Math.floor(x);
	var yi = Math.floor(y);
	var minD = Infinity;
	var id = 0;

	for (var j = -1; j <= 1; j++) {
		for (var i = -1; i <= 1; i++) {
			var cx = xi + i;
			var cy = yi + j;

			var fx = cx + hash2(cx, cy);
			var fy = cy + hash2(cy, cx);

			var dx = x - fx;
			var dy = y - fy;
			var d = dx * dx + dy * dy;

			if (d < minD) {
				minD = d;
				id = ((cx * 73856093) ^ (cy * 19349663)) >>> 0;
			}
		}
	}

	out[0] = Math.sqrt(minD);
	out[1] = id;
	return out;
}

function soaFillNoise2D(soa, scale, octaves, kind) {
	scale = scale || 1;
	octaves = octaves || 4;
	kind = kind || "fbm";

	var n = soa.count;
	var xs = soa.x;
	var ys = soa.y;

	var isValue = kind === "value";
	var isGradient = kind === "gradient";

	for (var i = 0; i < n; i++) {
		var x = xs[i] * scale;
		var y = ys[i] * scale;

		if (isValue) {
			xs[i] = valueNoise2D(x, y);
			ys[i] = valueNoise2D(x + 100, y + 100);
		} else if (isGradient) {
			xs[i] = gradientNoise2D(x, y);
			ys[i] = gradientNoise2D(x + 100, y + 100);
		} else {
			xs[i] = fbm2D(x, y, octaves);
			ys[i] = fbm2D(x + 100, y + 100, octaves);
		}
	}
	return soa;
}

async function soaFillNoise2DChunked(soa, scale, octaves, kind, chunkSize, yieldEvery) {
	scale = scale || 1;
	octaves = octaves || 4;
	kind = kind || "fbm";
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;

	var n = soa.count;
	var xs = soa.x;
	var ys = soa.y;
	var c = 0;

	var isValue = kind === "value";
	var isGradient = kind === "gradient";

	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);

		for (var i = start; i < end; i++) {
			var x = xs[i] * scale;
			var y = ys[i] * scale;

			if (isValue) {
				xs[i] = valueNoise2D(x, y);
				ys[i] = valueNoise2D(x + 100, y + 100);
			} else if (isGradient) {
				xs[i] = gradientNoise2D(x, y);
				ys[i] = gradientNoise2D(x + 100, y + 100);
			} else {
				xs[i] = fbm2D(x, y, octaves);
				ys[i] = fbm2D(x + 100, y + 100, octaves);
			}
		}

		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
	return soa;
}

// ============================================================================
// 6. ANIMATION & NATURAL MOTION
// ============================================================================
function quadraticBezier(out, a, b, c, t) {
	var t2 = t * t;
	var mt = 1 - t;
	var mt2 = mt * mt;

	out[0] = mt2 * a[0] + 2 * mt * t * b[0] + t2 * c[0];
	out[1] = mt2 * a[1] + 2 * mt * t * b[1] + t2 * c[1];
	return out;
}

function cubicBezier(out, a, b, c, d, t) {
	var mt = 1 - t;
	var mt2 = mt * mt;
	var t2 = t * t;
	var mt3 = mt2 * mt;
	var t3 = t2 * t;

	out[0] = mt3 * a[0] + 3 * mt2 * t * b[0] + 3 * mt * t2 * c[0] + t3 * d[0];
	out[1] = mt3 * a[1] + 3 * mt2 * t * b[1] + 3 * mt * t2 * c[1] + t3 * d[1];
	return out;
}

function catmullRom(out, p0, p1, p2, p3, t) {
	var t2 = t * t;
	var t3 = t2 * t;

	out[0] = 0.5 * (
		(2 * p1[0]) +
		(-p0[0] + p2[0]) * t +
		(2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
		(-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
	);

	out[1] = 0.5 * (
		(2 * p1[1]) +
		(-p0[1] + p2[1]) * t +
		(2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
		(-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
	);

	return out;
}

// Frame-rate independent critically-damped spring for vec2.
// Writes result to out[0..1], updates vel[0..1] in place.
function springDamp2(out, current, target, vel, smoothTime, dt, maxSpeed) {
	if (smoothTime < 0.0001) { smoothTime = 0.0001; }
	if (maxSpeed === undefined) { maxSpeed = Infinity; }

	var omega = 2 / smoothTime;
	var x = omega * dt;
	var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
	var maxChange = maxSpeed * smoothTime;

	for (var i = 0; i < 2; i++) {
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

const smoothDamp2 = springDamp2;

// ============================================================================
// 7. ORBITAL / POLAR
// ============================================================================
function polarToCartesian(out, r, theta) {
	out[0] = r * Math.cos(theta);
	out[1] = r * Math.sin(theta);
	return out;
}

function cartesianToPolar(out, x, y) {
	out[0] = Math.sqrt(x * x + y * y);
	out[1] = Math.atan2(y, x);
	return out;
}

function ellipsePoint(out, cx, cy, a, b, theta) {
	out[0] = cx + a * Math.cos(theta);
	out[1] = cy + b * Math.sin(theta);
	return out;
}

function keplerOrbit2D(out, a, e, M) {
	var E = keplerSolve(M, e);
	out[0] = a * (Math.cos(E) - e);
	out[1] = a * Math.sqrt(1 - e * e) * Math.sin(E);
	return out;
}

function orbitalSpeed2D(mu, r, a) {
	return Math.sqrt(mu * (2 / r - 1 / a));
}

// ============================================================================
// 8. EXPORTS
// ============================================================================
export {
	// foundation constants
	EPSILON, ARRAY_TYPE, RANDOM, CHUNK_SIZE, CHUNK_YIELD_EVERY,

	// flat API
	create, clone, fromValues, copy, set, add, subtract, multiply, divide,
	ceil, floor, min, max, round, scale, scaleAndAdd, distance, squaredDistance,
	length, squaredLength, negate, inverse, normalize, dot, cross, lerp, random,
	transformMat2, transformMat2d, transformMat3, transformMat4, rotate, angle,
	signedAngle, zero, str, exactEquals, equals,

	// aliases
	len, sub, mul, div, dist, sqrDist, sqrLen, forEach,

	// pool
	createVec2Pool, acquire, release,

	// SOA
	createVec2SOA, soaZero, soaFill, soaGet, soaSet, soaToFlat, soaFromFlat,
	soaCopy, soaAdd, soaSub, soaMul, soaDiv, soaScale, soaScaleAndAdd, soaLerp,
	soaNegate, soaInverse, soaNormalize, soaMin, soaMax, soaTransformMat2d,
	soaDot, soaMinComponent, soaMaxComponent, soaAABB,

	// chunked async (mobile-safe, non-blocking)
	soaAddChunked, soaSubChunked, soaScaleChunked, soaLerpChunked,
	soaNormalizeChunked, soaDotChunked, soaForEachChunked,

	// procedural
	valueNoise2D, gradientNoise2D, fbm2D, voronoi2D, soaFillNoise2D,
	soaFillNoise2DChunked,

	// animation
	quadraticBezier, cubicBezier, catmullRom, springDamp2, smoothDamp2,

	// orbital
	polarToCartesian, cartesianToPolar, ellipsePoint, keplerOrbit2D,
	orbitalSpeed2D
};

export default {
	EPSILON, ARRAY_TYPE, RANDOM, CHUNK_SIZE, CHUNK_YIELD_EVERY,

	create, clone, fromValues, copy, set, add, subtract, multiply, divide,
	ceil, floor, min, max, round, scale, scaleAndAdd, distance, squaredDistance,
	length, squaredLength, negate, inverse, normalize, dot, cross, lerp, random,
	transformMat2, transformMat2d, transformMat3, transformMat4, rotate, angle,
	signedAngle, zero, str, exactEquals, equals,

	len, sub, mul, div, dist, sqrDist, sqrLen, forEach,

	createVec2Pool, acquire, release,

	createVec2SOA, soaZero, soaFill, soaGet, soaSet, soaToFlat, soaFromFlat,
	soaCopy, soaAdd, soaSub, soaMul, soaDiv, soaScale, soaScaleAndAdd, soaLerp,
	soaNegate, soaInverse, soaNormalize, soaMin, soaMax, soaTransformMat2d,
	soaDot, soaMinComponent, soaMaxComponent, soaAABB,

	soaAddChunked, soaSubChunked, soaScaleChunked, soaLerpChunked,
	soaNormalizeChunked, soaDotChunked, soaForEachChunked,

	valueNoise2D, gradientNoise2D, fbm2D, voronoi2D, soaFillNoise2D,
	soaFillNoise2DChunked,

	quadraticBezier, cubicBezier, catmullRom, springDamp2, smoothDamp2,

	polarToCartesian, cartesianToPolar, ellipsePoint, keplerOrbit2D,
	orbitalSpeed2D
};

// Continue with next file: 003_vec3.js?