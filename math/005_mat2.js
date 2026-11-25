// File number : 005
// File : src/math/005_mat2.js
// Description : 2x2 matrix (glMatrix API) + SOA bulk layout (1M+ matrices), pool,
//               chunked parallelism, procedural rotation fields, shear/reflection/
//               viewport/letterbox transforms, 2D facing/orientation for sprites
//               and IK, decomposition, and orbital 2D frame builders. Numerically
//               exact column-major layout (m00,m01,m10,m11) matching glMatrix.
// Best for : 3d graphics -- procedural generation (per-instance random rotation on
//            1M+ particle/sprite instances, per-particle anisotropy from noise,
//            tile warp fields), rendering (2D transforms for sprites, screen-space
//            decals, UV rotation, viewport-to-NDC mapping, letterbox fitting, shear,
//            reflection), color (hue-plane rotation for gradient/animation,
//            chroma-space transform), animation (linear and slerp matrix blending,
//            rotation curves, decomposition and recomposition), natural IK motion
//            (2-bone facing frames, orientation from direction for 2D limbs,
//            hip-shoulder lean, sprite look-at), orbital (tangential/normal frames
//            in the ecliptic plane, per-instance orbital orientation), seamless
//            small-to-galactic scale (unified per-instance rotation/scale for
//            asteroids, dust particles, planetary rings). All hot paths avoid
//            per-element allocation.
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
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;

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

// ============================================================================
// 1. FLAT API (glMatrix compatible, signatures preserved)
// ============================================================================
/**
2x2 Matrix
Storage (column-major):
out[0] = m00 (col 0, row 0)   out[2] = m10 (col 1, row 0)
out[1] = m01 (col 0, row 1)   out[3] = m11 (col 1, row 1)
Visual layout:
| m00  m10 |
| m01  m11 |
*/
function create() {
	var out = new ARRAY_TYPE(4);
	if (ARRAY_TYPE !== Float32Array) { out[1] = 0; out[2] = 0; }
	out[0] = 1;
	out[3] = 1;
	return out;
}

function clone(a) {
	var out = new ARRAY_TYPE(4);
	out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
	return out;
}

function copy(out, a) {
	out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
	return out;
}

function identity(out) {
	out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 1;
	return out;
}

function fromValues(m00, m01, m10, m11) {
	var out = new ARRAY_TYPE(4);
	out[0] = m00; out[1] = m01; out[2] = m10; out[3] = m11;
	return out;
}

function set(out, m00, m01, m10, m11) {
	out[0] = m00; out[1] = m01; out[2] = m10; out[3] = m11;
	return out;
}

function transpose(out, a) {
	if (out === a) {
		var a1 = a[1];
		out[1] = a[2];
		out[2] = a1;
	} else {
		out[0] = a[0]; out[1] = a[2]; out[2] = a[1]; out[3] = a[3];
	}
	return out;
}

function invert(out, a) {
	var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
	var det = a0 * a3 - a2 * a1;
	if (!det) { return null; }
	det = 1.0 / det;
	out[0] = a3 * det;
	out[1] = -a1 * det;
	out[2] = -a2 * det;
	out[3] = a0 * det;
	return out;
}

function adjoint(out, a) {
	var a0 = a[0];
	out[0] = a[3];
	out[1] = -a[1];
	out[2] = -a[2];
	out[3] = a0;
	return out;
}

function determinant(a) {
	return a[0] * a[3] - a[2] * a[1];
}

function multiply(out, a, b) {
	var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
	var b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
	out[0] = a0 * b0 + a2 * b1;
	out[1] = a1 * b0 + a3 * b1;
	out[2] = a0 * b2 + a2 * b3;
	out[3] = a1 * b2 + a3 * b3;
	return out;
}

function rotate(out, a, rad) {
	var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
	var s = Math.sin(rad);
	var c = Math.cos(rad);
	out[0] = a0 * c + a2 * s;
	out[1] = a1 * c + a3 * s;
	out[2] = a0 * -s + a2 * c;
	out[3] = a1 * -s + a3 * c;
	return out;
}

function scale(out, a, v) {
	var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
	var v0 = v[0], v1 = v[1];
	out[0] = a0 * v0;
	out[1] = a1 * v0;
	out[2] = a2 * v1;
	out[3] = a3 * v1;
	return out;
}

function fromRotation(out, rad) {
	var s = Math.sin(rad);
	var c = Math.cos(rad);
	out[0] = c;
	out[1] = s;
	out[2] = -s;
	out[3] = c;
	return out;
}

function fromScaling(out, v) {
	out[0] = v[0];
	out[1] = 0;
	out[2] = 0;
	out[3] = v[1];
	return out;
}

function str(a) {
	return "mat2(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ")";
}

function frob(a) {
	return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]);
}

function LDU(L, D, U, a) {
	L[2] = a[2] / a[0];
	U[0] = a[0];
	U[1] = a[1];
	U[3] = a[3] - L[2] * U[1];
	return [L, D, U];
}

function add(out, a, b) {
	out[0] = a[0] + b[0];
	out[1] = a[1] + b[1];
	out[2] = a[2] + b[2];
	out[3] = a[3] + b[3];
	return out;
}

function subtract(out, a, b) {
	out[0] = a[0] - b[0];
	out[1] = a[1] - b[1];
	out[2] = a[2] - b[2];
	out[3] = a[3] - b[3];
	return out;
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

function multiplyScalar(out, a, b) {
	out[0] = a[0] * b; out[1] = a[1] * b; out[2] = a[2] * b; out[3] = a[3] * b;
	return out;
}

function multiplyScalarAndAdd(out, a, b, s) {
	out[0] = a[0] + b[0] * s;
	out[1] = a[1] + b[1] * s;
	out[2] = a[2] + b[2] * s;
	out[3] = a[3] + b[3] * s;
	return out;
}

const mul = multiply;
const sub = subtract;

// ============================================================================
// 2. POOL
// ============================================================================
function createMat2Pool(capacity) {
	return createPool(function () {
		var m = new ARRAY_TYPE(4);
		m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 1;
		return m;
	}, capacity, function (m) {
		m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 1;
	});
}

let _defaultPool = null;
function getDefaultPool() {
	if (_defaultPool === null) { _defaultPool = createMat2Pool(); }
	return _defaultPool;
}
function acquire() { return getDefaultPool().acquire(); }
function release(m) { getDefaultPool().release(m); }

// ============================================================================
// 3. STRUCTURE OF ARRAYS (SOA) -- 1M+ mat2 instances at real time
// ============================================================================
function createMat2SOA(count, Type) {
	var soa = createSOA(count, 4, Type);
	return {
		m00: soa.arrays[0],
		m01: soa.arrays[1],
		m10: soa.arrays[2],
		m11: soa.arrays[3],
		arrays: soa.arrays,
		buffer: soa.buffer,
		count: soa.count,
		components: 4
	};
}

function soaZero(out) {
	out.m00.fill(0); out.m01.fill(0); out.m10.fill(0); out.m11.fill(0);
	return out;
}

function soaIdentity(out) {
	out.m00.fill(1); out.m01.fill(0); out.m10.fill(0); out.m11.fill(1);
	return out;
}

function soaFill(out, m00v, m01v, m10v, m11v) {
	out.m00.fill(m00v); out.m01.fill(m01v); out.m10.fill(m10v); out.m11.fill(m11v);
	return out;
}

function soaGet(out, soa, i) {
	out[0] = soa.m00[i]; out[1] = soa.m01[i]; out[2] = soa.m10[i]; out[3] = soa.m11[i];
	return out;
}

function soaSet(soa, i, m) {
	soa.m00[i] = m[0]; soa.m01[i] = m[1]; soa.m10[i] = m[2]; soa.m11[i] = m[3];
	return soa;
}

function soaCopy(out, a) {
	out.m00.set(a.m00); out.m01.set(a.m01); out.m10.set(a.m10); out.m11.set(a.m11);
	return out;
}

function soaToFlat(out, soa, offset) {
	offset = offset || 0;
	var n = soa.count;
	var m00 = soa.m00, m01 = soa.m01, m10 = soa.m10, m11 = soa.m11;
	for (var i = 0, o = offset; i < n; i++, o += 4) {
		out[o] = m00[i]; out[o + 1] = m01[i]; out[o + 2] = m10[i]; out[o + 3] = m11[i];
	}
	return out;
}

function soaFromFlat(soa, flat, offset) {
	offset = offset || 0;
	var n = soa.count;
	var m00 = soa.m00, m01 = soa.m01, m10 = soa.m10, m11 = soa.m11;
	for (var i = 0, o = offset; i < n; i++, o += 4) {
		m00[i] = flat[o]; m01[i] = flat[o + 1]; m10[i] = flat[o + 2]; m11[i] = flat[o + 3];
	}
	return soa;
}

// ---- Sync SOA ops ---------------------------------------------------------
function soaMultiply(out, a, b) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var a00 = a.m00, a01 = a.m01, a10 = a.m10, a11 = a.m11;
	var b00 = b.m00, b01 = b.m01, b10 = b.m10, b11 = b.m11;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		o00[i] = a00[i] * b00[i] + a10[i] * b01[i];
		o01[i] = a01[i] * b00[i] + a11[i] * b01[i];
		o10[i] = a00[i] * b10[i] + a10[i] * b11[i];
		o11[i] = a01[i] * b10[i] + a11[i] * b11[i];
	}
	return out;
}

function soaAdd(out, a, b) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var a00 = a.m00, a01 = a.m01, a10 = a.m10, a11 = a.m11;
	var b00 = b.m00, b01 = b.m01, b10 = b.m10, b11 = b.m11;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		o00[i] = a00[i] + b00[i]; o01[i] = a01[i] + b01[i];
		o10[i] = a10[i] + b10[i]; o11[i] = a11[i] + b11[i];
	}
	return out;
}

function soaSub(out, a, b) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var a00 = a.m00, a01 = a.m01, a10 = a.m10, a11 = a.m11;
	var b00 = b.m00, b01 = b.m01, b10 = b.m10, b11 = b.m11;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		o00[i] = a00[i] - b00[i]; o01[i] = a01[i] - b01[i];
		o10[i] = a10[i] - b10[i]; o11[i] = a11[i] - b11[i];
	}
	return out;
}

function soaMultiplyScalar(out, a, s) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var a00 = a.m00, a01 = a.m01, a10 = a.m10, a11 = a.m11;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		o00[i] = a00[i] * s; o01[i] = a01[i] * s;
		o10[i] = a10[i] * s; o11[i] = a11[i] * s;
	}
	return out;
}

function soaTranspose(out, a) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var a00 = a.m00, a01 = a.m01, a10 = a.m10, a11 = a.m11;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		o00[i] = a00[i]; o01[i] = a10[i]; o10[i] = a01[i]; o11[i] = a11[i];
	}
	return out;
}

function soaInvert(out, a) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var a00 = a.m00, a01 = a.m01, a10 = a.m10, a11 = a.m11;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var A = a00[i], B = a01[i], C = a10[i], D = a11[i];
		var det = A * D - C * B;
		var id = det ? 1.0 / det : 0;
		o00[i] = D * id; o01[i] = -B * id;
		o10[i] = -C * id; o11[i] = A * id;
	}
	return out;
}

// Accepts a pre-allocated output buffer to avoid per-call allocation.
// Writes determinants into out (a Float32Array of length >= a.count).
function soaDeterminant(out, a) {
	var a00 = a.m00, a01 = a.m01, a10 = a.m10, a11 = a.m11;
	var n = a.count;
	for (var i = 0; i < n; i++) {
		out[i] = a00[i] * a11[i] - a10[i] * a01[i];
	}
	return out;
}

// Returns how many matrices in a are singular (det near 0).
function soaCountSingular(a) {
	var a00 = a.m00, a01 = a.m01, a10 = a.m10, a11 = a.m11;
	var n = a.count, count = 0;
	for (var i = 0; i < n; i++) {
		var det = a00[i] * a11[i] - a10[i] * a01[i];
		if (Math.abs(det) < EPSILON) { count++; }
	}
	return count;
}

// Batch transform a vec2 SOA using a per-element mat2 SOA:
// outX[i] = m00*x[i] + m10*y[i]
// outY[i] = m01*x[i] + m11*y[i]
function soaTransformVec2(outX, outY, matrices, vec) {
	var m00 = matrices.m00, m01 = matrices.m01, m10 = matrices.m10, m11 = matrices.m11;
	var vx = vec.x, vy = vec.y;
	var n = matrices.count;
	for (var i = 0; i < n; i++) {
		var x = vx[i], y = vy[i];
		outX[i] = m00[i] * x + m10[i] * y;
		outY[i] = m01[i] * x + m11[i] * y;
	}
	return outX;
}

// Fill a mat2 SOA from a per-instance rotation field (radians array).
function soaFillFromRotations(out, angles) {
	var m00 = out.m00, m01 = out.m01, m10 = out.m10, m11 = out.m11;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var s = Math.sin(angles[i]);
		var c = Math.cos(angles[i]);
		m00[i] = c; m01[i] = s; m10[i] = -s; m11[i] = c;
	}
	return out;
}

// Multiply every matrix by anisotropic scale (sx, sy).
function soaScaleByVec2(out, a, sx, sy) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var a00 = a.m00, a01 = a.m01, a10 = a.m10, a11 = a.m11;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		o00[i] = a00[i] * sx;
		o01[i] = a01[i] * sx;
		o10[i] = a10[i] * sy;
		o11[i] = a11[i] * sy;
	}
	return out;
}

// ---- Chunked async SOA ops (mobile-safe) ----------------------------------
async function _chunkedM2(out, perElem, chunkSize, yieldEvery) {
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

function soaMultiplyChunked(out, a, b, chunkSize, yieldEvery) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var a00 = a.m00, a01 = a.m01, a10 = a.m10, a11 = a.m11;
	var b00 = b.m00, b01 = b.m01, b10 = b.m10, b11 = b.m11;
	return _chunkedM2(out, function (i) {
		o00[i] = a00[i] * b00[i] + a10[i] * b01[i];
		o01[i] = a01[i] * b00[i] + a11[i] * b01[i];
		o10[i] = a00[i] * b10[i] + a10[i] * b11[i];
		o11[i] = a01[i] * b10[i] + a11[i] * b11[i];
	}, chunkSize, yieldEvery);
}

function soaInvertChunked(out, a, chunkSize, yieldEvery) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var a00 = a.m00, a01 = a.m01, a10 = a.m10, a11 = a.m11;
	return _chunkedM2(out, function (i) {
		var A = a00[i], B = a01[i], C = a10[i], D = a11[i];
		var det = A * D - C * B;
		var id = det ? 1.0 / det : 0;
		o00[i] = D * id; o01[i] = -B * id;
		o10[i] = -C * id; o11[i] = A * id;
	}, chunkSize, yieldEvery);
}

function soaTransformVec2Chunked(outX, outY, matrices, vec, chunkSize, yieldEvery) {
	var m00 = matrices.m00, m01 = matrices.m01, m10 = matrices.m10, m11 = matrices.m11;
	var vx = vec.x, vy = vec.y;
	return _chunkedM2(matrices, function (i) {
		var x = vx[i], y = vy[i];
		outX[i] = m00[i] * x + m10[i] * y;
		outY[i] = m01[i] * x + m11[i] * y;
	}, chunkSize, yieldEvery);
}

function soaFillFromRotationsChunked(out, angles, chunkSize, yieldEvery) {
	var m00 = out.m00, m01 = out.m01, m10 = out.m10, m11 = out.m11;
	return _chunkedM2(out, function (i) {
		var s = Math.sin(angles[i]);
		var c = Math.cos(angles[i]);
		m00[i] = c; m01[i] = s; m10[i] = -s; m11[i] = c;
	}, chunkSize, yieldEvery);
}

async function soaForEachChunked(out, a, callback, chunkSize, yieldEvery) {
	return _chunkedM2(out, function (i) { callback(i, a, out); }, chunkSize, yieldEvery);
}

// ============================================================================
// 4. PROCEDURAL GENERATION
// ============================================================================
// Uses continuous 2D value noise instead of Math.floor-based discrete hashing
// to produce smooth rotation fields without discontinuities.
// Fill a mat2 SOA with per-instance rotation driven by 2D noise sampled
// at the instance position.
function soaFillRotationFromNoise(out, positions, scale, amplitude) {
	scale = scale || 1;
	amplitude = amplitude || (2 * Math.PI);
	var m00 = out.m00, m01 = out.m01, m10 = out.m10, m11 = out.m11;
	var px = positions.x, py = positions.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var noiseVal = hash2(px[i] * scale, py[i] * scale);
		var a = noiseVal * amplitude;
		var s = Math.sin(a);
		var c = Math.cos(a);
		m00[i] = c; m01[i] = s; m10[i] = -s; m11[i] = c;
	}
	return out;
}

function soaFillRotationFromNoiseChunked(out, positions, scale, amplitude, chunkSize, yieldEvery) {
	scale = scale || 1;
	amplitude = amplitude || (2 * Math.PI);
	var m00 = out.m00, m01 = out.m01, m10 = out.m10, m11 = out.m11;
	var px = positions.x, py = positions.y;
	return _chunkedM2(out, function (i) {
		var noiseVal = hash2(px[i] * scale, py[i] * scale);
		var a = noiseVal * amplitude;
		var s = Math.sin(a);
		var c = Math.cos(a);
		m00[i] = c; m01[i] = s; m10[i] = -s; m11[i] = c;
	}, chunkSize, yieldEvery);
}

// Fill a mat2 SOA with anisotropic scale from Voronoi distance.
function soaFillAnisoFromVoronoi(out, positions, scale) {
	scale = scale || 1;
	var m00 = out.m00, m01 = out.m01, m10 = out.m10, m11 = out.m11;
	var px = positions.x, py = positions.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var id = hash2(px[i] * scale, py[i] * scale);
		var sx = 1.0 - id * 0.5;
		var sy = 1.0 + id * 0.5;
		m00[i] = sx; m01[i] = 0; m10[i] = 0; m11[i] = sy;
	}
	return out;
}

// ============================================================================
// 5. RENDERING / SCREEN-SPACE
// ============================================================================
function fromShear(out, kx, ky) {
	out[0] = 1; out[1] = kx;
	out[2] = ky; out[3] = 1;
	return out;
}

function fromReflection(out, flipX, flipY) {
	out[0] = flipY ? -1 : 1; out[1] = 0;
	out[2] = 0; out[3] = flipX ? -1 : 1;
	return out;
}

function fromViewport(out, x, y, w, h, viewportW, viewportH) {
	var sx = 2 * w / viewportW;
	var sy = 2 * h / viewportH;
	out[0] = sx; out[1] = 0;
	out[2] = 0; out[3] = sy;
	return out;
}

function fromAspectFit(out, sourceW, sourceH, targetW, targetH) {
	var srcAspect = sourceW / sourceH;
	var tgtAspect = targetW / targetH;
	var sx, sy;
	if (srcAspect > tgtAspect) {
		sx = 1; sy = tgtAspect / srcAspect;
	} else {
		sx = srcAspect / tgtAspect; sy = 1;
	}
	out[0] = sx; out[1] = 0;
	out[2] = 0; out[3] = sy;
	return out;
}

// ============================================================================
// 6. COLOR (hue-space 2D rotation)
// ============================================================================
// Build a rotation in the Cb/Cr chroma plane (YCbCr).
function fromChromaRotation(out, rad) {
	return fromRotation(out, rad);
}

// Applies a hue rotation to a batch of YCbCr colors. Preserves luma exactly.
// Accepts 6 separate typed arrays (outCb, outCr, outY, inCb, inCr, inY).
function soaHueRotateChroma(outCb, outCr, outY, inCb, inCr, inY, rad) {
	var s = Math.sin(rad), c = Math.cos(rad);
	var n = inCb.length;
	for (var i = 0; i < n; i++) {
		var cb = inCb[i], cr = inCr[i];
		outCb[i] = cb * c - cr * s;
		outCr[i] = cb * s + cr * c;
		outY[i] = inY[i];
	}
	return outY;
}

// ============================================================================
// 7. ANIMATION
// ============================================================================
function blend(out, a, b, t) {
	out[0] = a[0] + t * (b[0] - a[0]);
	out[1] = a[1] + t * (b[1] - a[1]);
	out[2] = a[2] + t * (b[2] - a[2]);
	out[3] = a[3] + t * (b[3] - a[3]);
	return out;
}

function blendRotation(out, a, b, t) {
	var angleA = Math.atan2(a[1], a[0]);
	var angleB = Math.atan2(b[1], b[0]);
	var d = angleB - angleA;
	while (d > Math.PI) { d -= 2 * Math.PI; }
	while (d < -Math.PI) { d += 2 * Math.PI; }
	var angle = angleA + d * t;
	return fromRotation(out, angle);
}

function decompose(out, m) {
	var a = m[0], b = m[1], c = m[2], d = m[3];
	var sx = Math.sqrt(a * a + b * b);
	var angle = Math.atan2(b, a);
	var cos = Math.cos(-angle), sin = Math.sin(-angle);
	var c1 = c * cos - d * sin;
	var d1 = c * sin + d * cos;
	var sy = d1;
	var shear = c1;
	out[0] = angle; out[1] = sx; out[2] = sy; out[3] = shear;
	return out;
}

function compose(out, angle, sx, sy, shear) {
	var c = Math.cos(angle), s = Math.sin(angle);
	out[0] = c * sx;
	out[1] = s * sx;
	out[2] = c * shear - s * sy;
	out[3] = s * shear + c * sy;
	return out;
}

function soaCompose(out, angles, scalesX, scalesY, shears) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var c = Math.cos(angles[i]), s = Math.sin(angles[i]);
		var sx = scalesX[i], sy = scalesY[i], k = shears[i];
		o00[i] = c * sx;
		o01[i] = s * sx;
		o10[i] = c * k - s * sy;
		o11[i] = s * k + c * sy;
	}
	return out;
}

// ============================================================================
// 8. NATURAL IK MOTION
// ============================================================================
function fromDirection(out, dx, dy) {
	var len = Math.sqrt(dx * dx + dy * dy);
	if (len < EPSILON) {
		return identity(out);
	}
	var inv = 1.0 / len;
	var cx = dx * inv, cy = dy * inv;
	out[0] = cx; out[1] = cy;
	out[2] = -cy; out[3] = cx;
	return out;
}

function fromTwoBoneChain(outUpper, outLower, ax, ay, jx, jy, ex, ey) {
	fromDirection(outUpper, jx - ax, jy - ay);
	fromDirection(outLower, ex - jx, ey - jy);
	return outUpper;
}

// ============================================================================
// 9. ORBITAL (2D frame in ecliptic plane)
// ============================================================================
function fromOrbitalTangent(out, vx, vy) {
	return fromDirection(out, vx, vy);
}

function fromOrbitalFrame(out, rad) {
	var c = Math.cos(rad), s = Math.sin(rad);
	out[0] = c; out[1] = s;
	out[2] = -s; out[3] = c;
	return out;
}

function soaFillFromOrbitalTangent(out, velocities) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var vx = velocities.x, vy = velocities.y;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var x = vx[i], y = vy[i];
		var len = Math.sqrt(x * x + y * y);
		if (len < EPSILON) { o00[i] = 1; o01[i] = 0; o10[i] = 0; o11[i] = 1; continue; }
		var inv = 1.0 / len;
		var cx = x * inv, cy = y * inv;
		o00[i] = cx; o01[i] = cy; o10[i] = -cy; o11[i] = cx;
	}
	return out;
}

function soaFillFromOrbitalTangentChunked(out, velocities, chunkSize, yieldEvery) {
	var o00 = out.m00, o01 = out.m01, o10 = out.m10, o11 = out.m11;
	var vx = velocities.x, vy = velocities.y;
	return _chunkedM2(out, function (i) {
		var x = vx[i], y = vy[i];
		var len = Math.sqrt(x * x + y * y);
		if (len < EPSILON) { o00[i] = 1; o01[i] = 0; o10[i] = 0; o11[i] = 1; return; }
		var inv = 1.0 / len;
		var cx = x * inv, cy = y * inv;
		o00[i] = cx; o01[i] = cy; o10[i] = -cy; o11[i] = cx;
	}, chunkSize, yieldEvery);
}

// ============================================================================
// 10. SCALE HELPERS (small-to-galactic)
// ============================================================================
function fromUniformScale(out, s) {
	out[0] = s; out[1] = 0; out[2] = 0; out[3] = s;
	return out;
}

function fromAnisoScale(out, sx, sy) {
	out[0] = sx; out[1] = 0; out[2] = 0; out[3] = sy;
	return out;
}

function fromWorldBounds(out, minX, minY, maxX, maxY) {
	var w = maxX - minX;
	var h = maxY - minY;
	out[0] = 2 / (w || 1);
	out[1] = 0;
	out[2] = 0;
	out[3] = 2 / (h || 1);
	return out;
}

// ============================================================================
// 11. EXPORTS
// ============================================================================
export {
	// foundation constants
	EPSILON, ARRAY_TYPE, CHUNK_SIZE, CHUNK_YIELD_EVERY,
	// flat API
	create, clone, copy, identity, fromValues, set, transpose, invert, adjoint,
	determinant, multiply, rotate, scale, fromRotation, fromScaling, str, frob,
	LDU, add, subtract, exactEquals, equals, multiplyScalar, multiplyScalarAndAdd,
	// aliases
	mul, sub,
	// pool
	createMat2Pool, acquire, release,
	// SOA
	createMat2SOA, soaZero, soaIdentity, soaFill, soaGet, soaSet, soaCopy,
	soaToFlat, soaFromFlat, soaMultiply, soaAdd, soaSub, soaMultiplyScalar,
	soaTranspose, soaInvert, soaDeterminant, soaCountSingular, soaTransformVec2,
	soaFillFromRotations, soaScaleByVec2,
	// chunked async
	soaMultiplyChunked, soaInvertChunked, soaTransformVec2Chunked,
	soaFillFromRotationsChunked, soaForEachChunked,
	// procedural
	soaFillRotationFromNoise, soaFillRotationFromNoiseChunked,
	soaFillAnisoFromVoronoi,
	// rendering / screen-space
	fromShear, fromReflection, fromViewport, fromAspectFit,
	// color
	fromChromaRotation, soaHueRotateChroma,
	// animation
	blend, blendRotation, decompose, compose, soaCompose,
	// natural IK motion
	fromDirection, fromTwoBoneChain,
	// orbital
	fromOrbitalTangent, fromOrbitalFrame, soaFillFromOrbitalTangent,
	soaFillFromOrbitalTangentChunked,
	// scale
	fromUniformScale, fromAnisoScale, fromWorldBounds
};

export default {
	create, clone, copy, identity, fromValues, set, transpose, invert, adjoint,
	determinant, multiply, rotate, scale, fromRotation, fromScaling, str, frob,
	LDU, add, subtract, exactEquals, equals, multiplyScalar, multiplyScalarAndAdd,
	mul, sub,
	createMat2Pool, acquire, release,
	createMat2SOA, soaZero, soaIdentity, soaFill, soaGet, soaSet, soaCopy,
	soaToFlat, soaFromFlat, soaMultiply, soaAdd, soaSub, soaMultiplyScalar,
	soaTranspose, soaInvert, soaDeterminant, soaCountSingular, soaTransformVec2,
	soaFillFromRotations, soaScaleByVec2,
	soaMultiplyChunked, soaInvertChunked, soaTransformVec2Chunked,
	soaFillFromRotationsChunked, soaForEachChunked,
	soaFillRotationFromNoise, soaFillRotationFromNoiseChunked,
	soaFillAnisoFromVoronoi,
	fromShear, fromReflection, fromViewport, fromAspectFit,
	fromChromaRotation, soaHueRotateChroma,
	blend, blendRotation, decompose, compose, soaCompose,
	fromDirection, fromTwoBoneChain,
	fromOrbitalTangent, fromOrbitalFrame, soaFillFromOrbitalTangent,
	soaFillFromOrbitalTangentChunked,
	fromUniformScale, fromAnisoScale, fromWorldBounds
};