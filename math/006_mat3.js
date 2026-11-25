// File number : 006
// File : src/math/006_mat3.js
// Description : 3x3 matrix (glMatrix API) + full SOA bulk layout (1M+ matrices), zero-GC pool, chunked parallelism, TBN / normal-matrix builders for instanced rendering, per-instance rotation fields from spatial hash, quaternion-to-matrix batch, color-grading matrices (saturation / grayscale / channel-mix / hue), animation decompose+compose+slerp, IK orientation matrices (look-at, direction+up, per-bone), and 3D orbital inclination / ecliptic-to-orbital frames.
// Best for : 3d graphics -- procedural generation (per-instance TBN from noise, random orientation fields, normal matrices from noise-driven transforms on 1M+ asteroids/particles/foliage), rendering (instanced normal matrices, TBN for 1M+ tangent-space normal-mapped instances, screen-to-NDC matrices, per-instance reflection/basis matrices, camera basis), color (saturation, grayscale/luma, channel-mix, hue-rotation as 3x3 grading matrices -- 1M+ pixels per frame), animation (decompose to rotation+scale, recompose from curves, matrix slerp, per-instance quaternion-to-matrix at 60 fps), natural IK motion (orientation matrices per bone from forward+up, hips/spine bends, foot planting, look-at frames), orbital (inclination matrices, ecliptic-to-orbital, periapsis frames, per-planet orientation for 1M+ orbital bodies), seamless small-to-galactic scale (world-to-NDC region matrices, uniform scale spanning mm-to-Mpc). All hot paths avoid per-element allocation.
// License : MIT

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

function hash3(x, y, z) {
	var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2246822519)) | 0;
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
// 1. FLAT API (glMatrix compatible)
// ============================================================================
function create() {
	var out = new ARRAY_TYPE(9);
	if (ARRAY_TYPE !== Float32Array) {
		out[1] = 0; out[2] = 0; out[3] = 0; out[5] = 0; out[6] = 0; out[7] = 0;
	}
	out[0] = 1; out[4] = 1; out[8] = 1;
	return out;
}

function fromMat4(out, a) {
	out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
	out[3] = a[4]; out[4] = a[5]; out[5] = a[6];
	out[6] = a[8]; out[7] = a[9]; out[8] = a[10];
	return out;
}

function clone(a) {
	var out = new ARRAY_TYPE(9);
	out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
	out[3] = a[3]; out[4] = a[4]; out[5] = a[5];
	out[6] = a[6]; out[7] = a[7]; out[8] = a[8];
	return out;
}

function copy(out, a) {
	out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
	out[3] = a[3]; out[4] = a[4]; out[5] = a[5];
	out[6] = a[6]; out[7] = a[7]; out[8] = a[8];
	return out;
}

function fromValues(m00, m01, m02, m10, m11, m12, m20, m21, m22) {
	var out = new ARRAY_TYPE(9);
	out[0] = m00; out[1] = m01; out[2] = m02;
	out[3] = m10; out[4] = m11; out[5] = m12;
	out[6] = m20; out[7] = m21; out[8] = m22;
	return out;
}

function set(out, m00, m01, m02, m10, m11, m12, m20, m21, m22) {
	out[0] = m00; out[1] = m01; out[2] = m02;
	out[3] = m10; out[4] = m11; out[5] = m12;
	out[6] = m20; out[7] = m21; out[8] = m22;
	return out;
}

function identity(out) {
	out[0] = 1; out[1] = 0; out[2] = 0;
	out[3] = 0; out[4] = 1; out[5] = 0;
	out[6] = 0; out[7] = 0; out[8] = 1;
	return out;
}

function transpose(out, a) {
	if (out === a) {
		var a01 = a[1], a02 = a[2], a12 = a[5];
		out[1] = a[3]; out[2] = a[6]; out[3] = a01; out[5] = a[7]; out[6] = a02; out[7] = a12;
	} else {
		out[0] = a[0]; out[1] = a[3]; out[2] = a[6];
		out[3] = a[1]; out[4] = a[4]; out[5] = a[7];
		out[6] = a[2]; out[7] = a[5]; out[8] = a[8];
	}
	return out;
}

function invert(out, a) {
	var a00 = a[0], a01 = a[1], a02 = a[2];
	var a10 = a[3], a11 = a[4], a12 = a[5];
	var a20 = a[6], a21 = a[7], a22 = a[8];
	var b01 = a22 * a11 - a12 * a21;
	var b11 = -a22 * a10 + a12 * a20;
	var b21 = a21 * a10 - a11 * a20;
	var det = a00 * b01 + a01 * b11 + a02 * b21;
	if (!det) { return null; }
	det = 1.0 / det;
	out[0] = b01 * det;
	out[1] = (-a22 * a01 + a02 * a21) * det;
	out[2] = (a12 * a01 - a02 * a11) * det;
	out[3] = b11 * det;
	out[4] = (a22 * a00 - a02 * a20) * det;
	out[5] = (-a12 * a00 + a02 * a10) * det;
	out[6] = b21 * det;
	out[7] = (-a21 * a00 + a01 * a20) * det;
	out[8] = (a11 * a00 - a01 * a10) * det;
	return out;
}

function adjoint(out, a) {
	var a00 = a[0], a01 = a[1], a02 = a[2];
	var a10 = a[3], a11 = a[4], a12 = a[5];
	var a20 = a[6], a21 = a[7], a22 = a[8];
	out[0] = a11 * a22 - a12 * a21;
	out[1] = a02 * a21 - a01 * a22;
	out[2] = a01 * a12 - a02 * a11;
	out[3] = a12 * a20 - a10 * a22;
	out[4] = a00 * a22 - a02 * a20;
	out[5] = a02 * a10 - a00 * a12;
	out[6] = a10 * a21 - a11 * a20;
	out[7] = a01 * a20 - a00 * a21;
	out[8] = a00 * a11 - a01 * a10;
	return out;
}

function determinant(a) {
	var a00 = a[0], a01 = a[1], a02 = a[2];
	var a10 = a[3], a11 = a[4], a12 = a[5];
	var a20 = a[6], a21 = a[7], a22 = a[8];
	return a00 * (a22 * a11 - a12 * a21) + a01 * (-a22 * a10 + a12 * a20) + a02 * (a21 * a10 - a11 * a20);
}

function multiply(out, a, b) {
	var a00 = a[0], a01 = a[1], a02 = a[2];
	var a10 = a[3], a11 = a[4], a12 = a[5];
	var a20 = a[6], a21 = a[7], a22 = a[8];
	var b00 = b[0], b01 = b[1], b02 = b[2];
	var b10 = b[3], b11 = b[4], b12 = b[5];
	var b20 = b[6], b21 = b[7], b22 = b[8];
	out[0] = b00 * a00 + b01 * a10 + b02 * a20;
	out[1] = b00 * a01 + b01 * a11 + b02 * a21;
	out[2] = b00 * a02 + b01 * a12 + b02 * a22;
	out[3] = b10 * a00 + b11 * a10 + b12 * a20;
	out[4] = b10 * a01 + b11 * a11 + b12 * a21;
	out[5] = b10 * a02 + b11 * a12 + b12 * a22;
	out[6] = b20 * a00 + b21 * a10 + b22 * a20;
	out[7] = b20 * a01 + b21 * a11 + b22 * a21;
	out[8] = b20 * a02 + b21 * a12 + b22 * a22;
	return out;
}

function translate(out, a, v) {
	var a00 = a[0], a01 = a[1], a02 = a[2];
	var a10 = a[3], a11 = a[4], a12 = a[5];
	var a20 = a[6], a21 = a[7], a22 = a[8];
	var x = v[0], y = v[1];
	out[0] = a00; out[1] = a01; out[2] = a02;
	out[3] = a10; out[4] = a11; out[5] = a12;
	out[6] = x * a00 + y * a10 + a20;
	out[7] = x * a01 + y * a11 + a21;
	out[8] = x * a02 + y * a12 + a22;
	return out;
}

function rotate(out, a, rad) {
	var a00 = a[0], a01 = a[1], a02 = a[2];
	var a10 = a[3], a11 = a[4], a12 = a[5];
	var a20 = a[6], a21 = a[7], a22 = a[8];
	var s = Math.sin(rad), c = Math.cos(rad);
	out[0] = c * a00 + s * a10;
	out[1] = c * a01 + s * a11;
	out[2] = c * a02 + s * a12;
	out[3] = c * a10 - s * a00;
	out[4] = c * a11 - s * a01;
	out[5] = c * a12 - s * a02;
	out[6] = a20; out[7] = a21; out[8] = a22;
	return out;
}

function scale(out, a, v) {
	var x = v[0], y = v[1];
	out[0] = x * a[0]; out[1] = x * a[1]; out[2] = x * a[2];
	out[3] = y * a[3]; out[4] = y * a[4]; out[5] = y * a[5];
	out[6] = a[6]; out[7] = a[7]; out[8] = a[8];
	return out;
}

function fromTranslation(out, v) {
	out[0] = 1; out[1] = 0; out[2] = 0;
	out[3] = 0; out[4] = 1; out[5] = 0;
	out[6] = v[0]; out[7] = v[1]; out[8] = 1;
	return out;
}

function fromRotation(out, rad) {
	var s = Math.sin(rad), c = Math.cos(rad);
	out[0] = c; out[1] = s; out[2] = 0;
	out[3] = -s; out[4] = c; out[5] = 0;
	out[6] = 0; out[7] = 0; out[8] = 1;
	return out;
}

function fromScaling(out, v) {
	out[0] = v[0]; out[1] = 0; out[2] = 0;
	out[3] = 0; out[4] = v[1]; out[5] = 0;
	out[6] = 0; out[7] = 0; out[8] = 1;
	return out;
}

function fromMat2d(out, a) {
	out[0] = a[0]; out[1] = a[1]; out[2] = 0;
	out[3] = a[2]; out[4] = a[3]; out[5] = 0;
	out[6] = a[4]; out[7] = a[5]; out[8] = 1;
	return out;
}

function fromQuat(out, q) {
	var x = q[0], y = q[1], z = q[2], w = q[3];
	var x2 = x + x, y2 = y + y, z2 = z + z;
	var xx = x * x2, yx = y * x2, yy = y * y2;
	var zx = z * x2, zy = z * y2, zz = z * z2;
	var wx = w * x2, wy = w * y2, wz = w * z2;
	out[0] = 1 - yy - zz;
	out[3] = yx - wz;
	out[6] = zx + wy;
	out[1] = yx + wz;
	out[4] = 1 - xx - zz;
	out[7] = zy - wx;
	out[2] = zx - wy;
	out[5] = zy + wx;
	out[8] = 1 - xx - yy;
	return out;
}

function normalFromMat4(out, a) {
	var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
	var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
	var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
	var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
	var b00 = a00 * a11 - a01 * a10;
	var b01 = a00 * a12 - a02 * a10;
	var b02 = a00 * a13 - a03 * a10;
	var b03 = a01 * a12 - a02 * a11;
	var b04 = a01 * a13 - a03 * a11;
	var b05 = a02 * a13 - a03 * a12;
	var b06 = a20 * a31 - a21 * a30;
	var b07 = a20 * a32 - a22 * a30;
	var b08 = a20 * a33 - a23 * a30;
	var b09 = a21 * a32 - a22 * a31;
	var b10 = a21 * a33 - a23 * a31;
	var b11 = a22 * a33 - a23 * a32;
	var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	if (!det) { return null; }
	det = 1.0 / det;
	out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
	out[1] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
	out[2] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
	out[3] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
	out[4] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
	out[5] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
	out[6] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
	out[7] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
	out[8] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
	return out;
}

function projection(out, width, height) {
	out[0] = 2 / width; out[1] = 0; out[2] = 0;
	out[3] = 0; out[4] = -2 / height; out[5] = 0;
	out[6] = -1; out[7] = 1; out[8] = 1;
	return out;
}

function str(a) {
	return "mat3(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ", " + a[4] + ", " + a[5] + ", " + a[6] + ", " + a[7] + ", " + a[8] + ")";
}

function frob(a) {
	return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3] + a[4] * a[4] + a[5] * a[5] + a[6] * a[6] + a[7] * a[7] + a[8] * a[8]);
}

function add(out, a, b) {
	out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
	out[3] = a[3] + b[3]; out[4] = a[4] + b[4]; out[5] = a[5] + b[5];
	out[6] = a[6] + b[6]; out[7] = a[7] + b[7]; out[8] = a[8] + b[8];
	return out;
}

function subtract(out, a, b) {
	out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
	out[3] = a[3] - b[3]; out[4] = a[4] - b[4]; out[5] = a[5] - b[5];
	out[6] = a[6] - b[6]; out[7] = a[7] - b[7]; out[8] = a[8] - b[8];
	return out;
}

function multiplyScalar(out, a, b) {
	out[0] = a[0] * b; out[1] = a[1] * b; out[2] = a[2] * b;
	out[3] = a[3] * b; out[4] = a[4] * b; out[5] = a[5] * b;
	out[6] = a[6] * b; out[7] = a[7] * b; out[8] = a[8] * b;
	return out;
}

function multiplyScalarAndAdd(out, a, b, s) {
	out[0] = a[0] + b[0] * s; out[1] = a[1] + b[1] * s; out[2] = a[2] + b[2] * s;
	out[3] = a[3] + b[3] * s; out[4] = a[4] + b[4] * s; out[5] = a[5] + b[5] * s;
	out[6] = a[6] + b[6] * s; out[7] = a[7] + b[7] * s; out[8] = a[8] + b[8] * s;
	return out;
}

function exactEquals(a, b) {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] &&
		a[3] === b[3] && a[4] === b[4] && a[5] === b[5] &&
		a[6] === b[6] && a[7] === b[7] && a[8] === b[8];
}

function equals(a, b) {
	var a0 = a[0], a1 = a[1], a2 = a[2];
	var a3 = a[3], a4 = a[4], a5 = a[5];
	var a6 = a[6], a7 = a[7], a8 = a[8];
	var b0 = b[0], b1 = b[1], b2 = b[2];
	var b3 = b[3], b4 = b[4], b5 = b[5];
	var b6 = b[6], b7 = b[7], b8 = b[8];
	return Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
		Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) &&
		Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2)) &&
		Math.abs(a3 - b3) <= EPSILON * Math.max(1.0, Math.abs(a3), Math.abs(b3)) &&
		Math.abs(a4 - b4) <= EPSILON * Math.max(1.0, Math.abs(a4), Math.abs(b4)) &&
		Math.abs(a5 - b5) <= EPSILON * Math.max(1.0, Math.abs(a5), Math.abs(b5)) &&
		Math.abs(a6 - b6) <= EPSILON * Math.max(1.0, Math.abs(a6), Math.abs(b6)) &&
		Math.abs(a7 - b7) <= EPSILON * Math.max(1.0, Math.abs(a7), Math.abs(b7)) &&
		Math.abs(a8 - b8) <= EPSILON * Math.max(1.0, Math.abs(a8), Math.abs(b8));
}

const mul = multiply;
const sub = subtract;

// ============================================================================
// 2. POOL
// ============================================================================
function createMat3Pool(capacity) {
	return createPool(function () {
		var m = new ARRAY_TYPE(9);
		m[0] = 1; m[1] = 0; m[2] = 0;
		m[3] = 0; m[4] = 1; m[5] = 0;
		m[6] = 0; m[7] = 0; m[8] = 1;
		return m;
	}, capacity, function (m) {
		m[0] = 1; m[1] = 0; m[2] = 0;
		m[3] = 0; m[4] = 1; m[5] = 0;
		m[6] = 0; m[7] = 0; m[8] = 1;
	});
}

let _defaultPool = null;
function getDefaultPool() {
	if (_defaultPool === null) { _defaultPool = createMat3Pool(); }
	return _defaultPool;
}
function acquire() { return getDefaultPool().acquire(); }
function release(m) { getDefaultPool().release(m); }

// ============================================================================
// 3. STRUCTURE OF ARRAYS (SOA)
// ============================================================================
function createMat3SOA(count, Type) {
	var soa = createSOA(count, 9, Type);
	return {
		m00: soa.arrays[0], m01: soa.arrays[1], m02: soa.arrays[2],
		m10: soa.arrays[3], m11: soa.arrays[4], m12: soa.arrays[5],
		m20: soa.arrays[6], m21: soa.arrays[7], m22: soa.arrays[8],
		arrays: soa.arrays, buffer: soa.buffer, count: soa.count, components: 9
	};
}

function soaIdentity(out) {
	out.m00.fill(1); out.m01.fill(0); out.m02.fill(0);
	out.m10.fill(0); out.m11.fill(1); out.m12.fill(0);
	out.m20.fill(0); out.m21.fill(0); out.m22.fill(1);
	return out;
}

function soaZero(out) {
	for (var i = 0; i < 9; i++) { out.arrays[i].fill(0); }
	return out;
}

function soaFill(out, m00v, m01v, m02v, m10v, m11v, m12v, m20v, m21v, m22v) {
	out.m00.fill(m00v); out.m01.fill(m01v); out.m02.fill(m02v);
	out.m10.fill(m10v); out.m11.fill(m11v); out.m12.fill(m12v);
	out.m20.fill(m20v); out.m21.fill(m21v); out.m22.fill(m22v);
	return out;
}

function soaGet(out, soa, i) {
	out[0] = soa.m00[i]; out[1] = soa.m01[i]; out[2] = soa.m02[i];
	out[3] = soa.m10[i]; out[4] = soa.m11[i]; out[5] = soa.m12[i];
	out[6] = soa.m20[i]; out[7] = soa.m21[i]; out[8] = soa.m22[i];
	return out;
}

function soaSet(soa, i, m) {
	soa.m00[i] = m[0]; soa.m01[i] = m[1]; soa.m02[i] = m[2];
	soa.m10[i] = m[3]; soa.m11[i] = m[4]; soa.m12[i] = m[5];
	soa.m20[i] = m[6]; soa.m21[i] = m[7]; soa.m22[i] = m[8];
	return soa;
}

function soaCopy(out, a) {
	for (var i = 0; i < 9; i++) { out.arrays[i].set(a.arrays[i]); }
	return out;
}

function soaToFlat(out, soa, offset) {
	offset = offset || 0;
	var n = soa.count;
	var A = soa.arrays;
	for (var i = 0, o = offset; i < n; i++, o += 9) {
		for (var k = 0; k < 9; k++) { out[o + k] = A[k][i]; }
	}
	return out;
}

function soaFromFlat(soa, flat, offset) {
	offset = offset || 0;
	var n = soa.count;
	var A = soa.arrays;
	for (var i = 0, o = offset; i < n; i++, o += 9) {
		for (var k = 0; k < 9; k++) { A[k][i] = flat[o + k]; }
	}
	return soa;
}

// ---- Binary ops -----------------------------------------------------------
function soaMultiply(out, a, b) {
	var o00 = out.m00, o01 = out.m01, o02 = out.m02;
	var o10 = out.m10, o11 = out.m11, o12 = out.m12;
	var o20 = out.m20, o21 = out.m21, o22 = out.m22;
	var a00 = a.m00, a01 = a.m01, a02 = a.m02;
	var a10 = a.m10, a11 = a.m11, a12 = a.m12;
	var a20 = a.m20, a21 = a.m21, a22 = a.m22;
	var b00 = b.m00, b01 = b.m01, b02 = b.m02;
	var b10 = b.m10, b11 = b.m11, b12 = b.m12;
	var b20 = b.m20, b21 = b.m21, b22 = b.m22;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var _b00 = b00[i], _b01 = b01[i], _b02 = b02[i];
		var _b10 = b10[i], _b11 = b11[i], _b12 = b12[i];
		var _b20 = b20[i], _b21 = b21[i], _b22 = b22[i];
		var _a00 = a00[i], _a01 = a01[i], _a02 = a02[i];
		var _a10 = a10[i], _a11 = a11[i], _a12 = a12[i];
		var _a20 = a20[i], _a21 = a21[i], _a22 = a22[i];
		o00[i] = _b00 * _a00 + _b01 * _a10 + _b02 * _a20;
		o01[i] = _b00 * _a01 + _b01 * _a11 + _b02 * _a21;
		o02[i] = _b00 * _a02 + _b01 * _a12 + _b02 * _a22;
		o10[i] = _b10 * _a00 + _b11 * _a10 + _b12 * _a20;
		o11[i] = _b10 * _a01 + _b11 * _a11 + _b12 * _a21;
		o12[i] = _b10 * _a02 + _b11 * _a12 + _b12 * _a22;
		o20[i] = _b20 * _a00 + _b21 * _a10 + _b22 * _a20;
		o21[i] = _b20 * _a01 + _b21 * _a11 + _b22 * _a21;
		o22[i] = _b20 * _a02 + _b21 * _a12 + _b22 * _a22;
	}
	return out;
}

function soaAdd(out, a, b) {
	for (var k = 0; k < 9; k++) {
		var o = out.arrays[k], x = a.arrays[k], y = b.arrays[k], n = out.count;
		for (var i = 0; i < n; i++) { o[i] = x[i] + y[i]; }
	}
	return out;
}

function soaSub(out, a, b) {
	for (var k = 0; k < 9; k++) {
		var o = out.arrays[k], x = a.arrays[k], y = b.arrays[k], n = out.count;
		for (var i = 0; i < n; i++) { o[i] = x[i] - y[i]; }
	}
	return out;
}

function soaMultiplyScalar(out, a, s) {
	for (var k = 0; k < 9; k++) {
		var o = out.arrays[k], x = a.arrays[k], n = out.count;
		for (var i = 0; i < n; i++) { o[i] = x[i] * s; }
	}
	return out;
}

function soaTranspose(out, a) {
	var o00 = out.m00, o01 = out.m01, o02 = out.m02;
	var o10 = out.m10, o11 = out.m11, o12 = out.m12;
	var o20 = out.m20, o21 = out.m21, o22 = out.m22;
	var a00 = a.m00, a01 = a.m01, a02 = a.m02;
	var a10 = a.m10, a11 = a.m11, a12 = a.m12;
	var a20 = a.m20, a21 = a.m21, a22 = a.m22;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		o00[i] = a00[i]; o01[i] = a10[i]; o02[i] = a20[i];
		o10[i] = a01[i]; o11[i] = a11[i]; o12[i] = a21[i];
		o20[i] = a02[i]; o21[i] = a12[i]; o22[i] = a22[i];
	}
	return out;
}

function soaInvert(out, a) {
	var o00 = out.m00, o01 = out.m01, o02 = out.m02;
	var o10 = out.m10, o11 = out.m11, o12 = out.m12;
	var o20 = out.m20, o21 = out.m21, o22 = out.m22;
	var a00 = a.m00, a01 = a.m01, a02 = a.m02;
	var a10 = a.m10, a11 = a.m11, a12 = a.m12;
	var a20 = a.m20, a21 = a.m21, a22 = a.m22;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var _a00 = a00[i], _a01 = a01[i], _a02 = a02[i];
		var _a10 = a10[i], _a11 = a11[i], _a12 = a12[i];
		var _a20 = a20[i], _a21 = a21[i], _a22 = a22[i];
		var b01 = _a22 * _a11 - _a12 * _a21;
		var b11 = -_a22 * _a10 + _a12 * _a20;
		var b21 = _a21 * _a10 - _a11 * _a20;
		var det = _a00 * b01 + _a01 * b11 + _a02 * b21;
		var inv = det ? 1.0 / det : 0;
		o00[i] = b01 * inv;
		o01[i] = (-_a22 * _a01 + _a02 * _a21) * inv;
		o02[i] = (_a12 * _a01 - _a02 * _a11) * inv;
		o10[i] = b11 * inv;
		o11[i] = (_a22 * _a00 - _a02 * _a20) * inv;
		o12[i] = (-_a12 * _a00 + _a02 * _a10) * inv;
		o20[i] = b21 * inv;
		o21[i] = (-_a21 * _a00 + _a01 * _a20) * inv;
		o22[i] = (_a11 * _a00 - _a01 * _a10) * inv;
	}
	return out;
}

function soaDeterminant(out, a) {
	var a00 = a.m00, a01 = a.m01, a02 = a.m02;
	var a10 = a.m10, a11 = a.m11, a12 = a.m12;
	var a20 = a.m20, a21 = a.m21, a22 = a.m22;
	var n = a.count;
	for (var i = 0; i < n; i++) {
		out[i] = a00[i] * (a22[i] * a11[i] - a12[i] * a21[i])
			+ a01[i] * (-a22[i] * a10[i] + a12[i] * a20[i])
			+ a02[i] * (a21[i] * a10[i] - a11[i] * a20[i]);
	}
	return out;
}

function soaTransformVec3(outX, outY, outZ, matrices, inVec) {
	var m00 = matrices.m00, m01 = matrices.m01, m02 = matrices.m02;
	var m10 = matrices.m10, m11 = matrices.m11, m12 = matrices.m12;
	var m20 = matrices.m20, m21 = matrices.m21, m22 = matrices.m22;
	var vx = inVec.x, vy = inVec.y, vz = inVec.z;
	var n = matrices.count;
	for (var i = 0; i < n; i++) {
		var x = vx[i], y = vy[i], z = vz[i];
		outX[i] = m00[i] * x + m10[i] * y + m20[i] * z;
		outY[i] = m01[i] * x + m11[i] * y + m21[i] * z;
		outZ[i] = m02[i] * x + m12[i] * y + m22[i] * z;
	}
	return outX;
}

// ============================================================================
// 4. TBN BUILDER (huge for instanced normal-mapped rendering)
// ============================================================================
function buildTBN(out, normal, tangent, handedness) {
	var nx = normal[0], ny = normal[1], nz = normal[2];
	var tx = tangent[0], ty = tangent[1], tz = tangent[2];
	var d = tx * nx + ty * ny + tz * nz;
	tx -= d * nx; ty -= d * ny; tz -= d * nz;
	var l = Math.sqrt(tx * tx + ty * ty + tz * tz);
	if (l < EPSILON) {
		if (Math.abs(nx) < Math.abs(nz)) {
			tx = ny; ty = -nz; tz = 0;
		} else {
			tx = 0; ty = nz; tz = -ny;
		}
		l = Math.sqrt(tx * tx + ty * ty + tz * tz);
		if (l < EPSILON) { tx = 1; ty = 0; tz = 0; l = 1; }
	}
	var invL = 1.0 / l;
	tx *= invL; ty *= invL; tz *= invL;
	var bx = ny * tz - nz * ty;
	var by = nz * tx - nx * tz;
	var bz = nx * ty - ny * tx;
	if (handedness < 0) { bx = -bx; by = -by; bz = -bz; }
	out[0] = tx; out[1] = ty; out[2] = tz;
	out[3] = bx; out[4] = by; out[5] = bz;
	out[6] = nx; out[7] = ny; out[8] = nz;
	return out;
}

function soaBuildTBN(out, normals, tangents, handedness) {
	var o00 = out.m00, o01 = out.m01, o02 = out.m02;
	var o10 = out.m10, o11 = out.m11, o12 = out.m12;
	var o20 = out.m20, o21 = out.m21, o22 = out.m22;
	var nxA = normals.x, nyA = normals.y, nzA = normals.z;
	var txA = tangents.x, tyA = tangents.y, tzA = tangents.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var nx = nxA[i], ny = nyA[i], nz = nzA[i];
		var tx = txA[i], ty = tyA[i], tz = tzA[i];
		var d = tx * nx + ty * ny + tz * nz;
		tx -= d * nx; ty -= d * ny; tz -= d * nz;
		var l = Math.sqrt(tx * tx + ty * ty + tz * tz);
		if (l < EPSILON) {
			if (Math.abs(nx) < 0.99) { tx = 0; ty = -nz; tz = ny; }
			else { tx = 1; ty = 0; tz = 0; }
			l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
		}
		var invL = 1.0 / l;
		tx *= invL; ty *= invL; tz *= invL;
		var bx = ny * tz - nz * ty;
		var by = nz * tx - nx * tz;
		var bz = nx * ty - ny * tx;
		if (handedness && handedness[i] < 0) { bx = -bx; by = -by; bz = -bz; }
		o00[i] = tx; o01[i] = ty; o02[i] = tz;
		o10[i] = bx; o11[i] = by; o12[i] = bz;
		o20[i] = nx; o21[i] = ny; o22[i] = nz;
	}
	return out;
}

async function soaBuildTBNChunked(out, normals, tangents, handedness, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var o00 = out.m00, o01 = out.m01, o02 = out.m02;
	var o10 = out.m10, o11 = out.m11, o12 = out.m12;
	var o20 = out.m20, o21 = out.m21, o22 = out.m22;
	var nxA = normals.x, nyA = normals.y, nzA = normals.z;
	var txA = tangents.x, tyA = tangents.y, tzA = tangents.z;
	var n = out.count, c = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) {
			var nx = nxA[i], ny = nyA[i], nz = nzA[i];
			var tx = txA[i], ty = tyA[i], tz = tzA[i];
			var d = tx * nx + ty * ny + tz * nz;
			tx -= d * nx; ty -= d * ny; tz -= d * nz;
			var l = Math.sqrt(tx * tx + ty * ty + tz * tz);
			if (l < EPSILON) {
				if (Math.abs(nx) < 0.99) { tx = 0; ty = -nz; tz = ny; }
				else { tx = 1; ty = 0; tz = 0; }
				l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
			}
			var invL = 1.0 / l;
			tx *= invL; ty *= invL; tz *= invL;
			var bx = ny * tz - nz * ty;
			var by = nz * tx - nx * tz;
			var bz = nx * ty - ny * tx;
			if (handedness && handedness[i] < 0) { bx = -bx; by = -by; bz = -bz; }
			o00[i] = tx; o01[i] = ty; o02[i] = tz;
			o10[i] = bx; o11[i] = by; o12[i] = bz;
			o20[i] = nx; o21[i] = ny; o22[i] = nz;
		}
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
	return out;
}

// ============================================================================
// 5. PROCEDURAL ORIENTATION FIELDS
// ============================================================================
function soaFillFromNoise(out, positions, scale) {
	scale = scale || 1;
	var o00 = out.m00, o01 = out.m01, o02 = out.m02;
	var o10 = out.m10, o11 = out.m11, o12 = out.m12;
	var o20 = out.m20, o21 = out.m21, o22 = out.m22;
	var px = positions.x, py = positions.y, pz = positions.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var x = Math.floor(px[i] * scale);
		var y = Math.floor(py[i] * scale);
		var z = Math.floor(pz[i] * scale);
		var u1 = hash3(x, y, z);
		var u2 = hash3(x + 17, y + 23, z + 5);
		var u3 = hash3(x + 3, y + 11, z + 29);
		var s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
		var qx = s1 * Math.sin(2 * Math.PI * u2);
		var qy = s1 * Math.cos(2 * Math.PI * u2);
		var qz = s2 * Math.sin(2 * Math.PI * u3);
		var qw = s2 * Math.cos(2 * Math.PI * u3);
		var x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
		var xx = qx * x2, yx = qy * x2, yy = qy * y2;
		var zx = qz * x2, zy = qz * y2, zz = qz * z2;
		var wx = qw * x2, wy = qw * y2, wz = qw * z2;
		o00[i] = 1 - yy - zz; o10[i] = yx - wz; o20[i] = zx + wy;
		o01[i] = yx + wz;     o11[i] = 1 - xx - zz; o21[i] = zy - wx;
		o02[i] = zx - wy;     o12[i] = zy + wx;     o22[i] = 1 - xx - yy;
	}
	return out;
}

async function soaFillFromNoiseChunked(out, positions, scale, chunkSize, yieldEvery) {
	scale = scale || 1;
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var o00 = out.m00, o01 = out.m01, o02 = out.m02;
	var o10 = out.m10, o11 = out.m11, o12 = out.m12;
	var o20 = out.m20, o21 = out.m21, o22 = out.m22;
	var px = positions.x, py = positions.y, pz = positions.z;
	var n = out.count, c = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) {
			var x = Math.floor(px[i] * scale);
			var y = Math.floor(py[i] * scale);
			var z = Math.floor(pz[i] * scale);
			var u1 = hash3(x, y, z);
			var u2 = hash3(x + 17, y + 23, z + 5);
			var u3 = hash3(x + 3, y + 11, z + 29);
			var s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
			var qx = s1 * Math.sin(2 * Math.PI * u2);
			var qy = s1 * Math.cos(2 * Math.PI * u2);
			var qz = s2 * Math.sin(2 * Math.PI * u3);
			var qw = s2 * Math.cos(2 * Math.PI * u3);
			var x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
			var xx = qx * x2, yx = qy * x2, yy = qy * y2;
			var zx = qz * x2, zy = qz * y2, zz = qz * z2;
			var wx = qw * x2, wy = qw * y2, wz = qw * z2;
			o00[i] = 1 - yy - zz; o10[i] = yx - wz; o20[i] = zx + wy;
			o01[i] = yx + wz;     o11[i] = 1 - xx - zz; o21[i] = zy - wx;
			o02[i] = zx - wy;     o12[i] = zy + wx;     o22[i] = 1 - xx - yy;
		}
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
	return out;
}

function soaFromQuatSOA(out, quats) {
	var o00 = out.m00, o01 = out.m01, o02 = out.m02;
	var o10 = out.m10, o11 = out.m11, o12 = out.m12;
	var o20 = out.m20, o21 = out.m21, o22 = out.m22;
	var qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var x = qx[i], y = qy[i], z = qz[i], w = qw[i];
		var x2 = x + x, y2 = y + y, z2 = z + z;
		var xx = x * x2, yx = y * x2, yy = y * y2;
		var zx = z * x2, zy = z * y2, zz = z * z2;
		var wx = w * x2, wy = w * y2, wz = w * z2;
		o00[i] = 1 - yy - zz; o10[i] = yx - wz; o20[i] = zx + wy;
		o01[i] = yx + wz;     o11[i] = 1 - xx - zz; o21[i] = zy - wx;
		o02[i] = zx - wy;     o12[i] = zy + wx;     o22[i] = 1 - xx - yy;
	}
	return out;
}

async function soaFromQuatSOAChunked(out, quats, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var o00 = out.m00, o01 = out.m01, o02 = out.m02;
	var o10 = out.m10, o11 = out.m11, o12 = out.m12;
	var o20 = out.m20, o21 = out.m21, o22 = out.m22;
	var qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
	var n = out.count, c = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) {
			var x = qx[i], y = qy[i], z = qz[i], w = qw[i];
			var x2 = x + x, y2 = y + y, z2 = z + z;
			var xx = x * x2, yx = y * x2, yy = y * y2;
			var zx = z * x2, zy = z * y2, zz = z * z2;
			var wx = w * x2, wy = w * y2, wz = w * z2;
			o00[i] = 1 - yy - zz; o10[i] = yx - wz; o20[i] = zx + wy;
			o01[i] = yx + wz;     o11[i] = 1 - xx - zz; o21[i] = zy - wx;
			o02[i] = zx - wy;     o12[i] = zy + wx;     o22[i] = 1 - xx - yy;
		}
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
	return out;
}

// ============================================================================
// 6. CHUNKED ASYNC OPS
// ============================================================================
async function _chunkedM3(out, perElem, chunkSize, yieldEvery) {
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
	return _chunkedM3(out, function (i) {
		var b00 = b.m00[i], b01 = b.m01[i], b02 = b.m02[i];
		var b10 = b.m10[i], b11 = b.m11[i], b12 = b.m12[i];
		var b20 = b.m20[i], b21 = b.m21[i], b22 = b.m22[i];
		var a00 = a.m00[i], a01 = a.m01[i], a02 = a.m02[i];
		var a10 = a.m10[i], a11 = a.m11[i], a12 = a.m12[i];
		var a20 = a.m20[i], a21 = a.m21[i], a22 = a.m22[i];
		out.m00[i] = b00 * a00 + b01 * a10 + b02 * a20;
		out.m01[i] = b00 * a01 + b01 * a11 + b02 * a21;
		out.m02[i] = b00 * a02 + b01 * a12 + b02 * a22;
		out.m10[i] = b10 * a00 + b11 * a10 + b12 * a20;
		out.m11[i] = b10 * a01 + b11 * a11 + b12 * a21;
		out.m12[i] = b10 * a02 + b11 * a12 + b12 * a22;
		out.m20[i] = b20 * a00 + b21 * a10 + b22 * a20;
		out.m21[i] = b20 * a01 + b21 * a11 + b22 * a21;
		out.m22[i] = b20 * a02 + b21 * a12 + b22 * a22;
	}, chunkSize, yieldEvery);
}

function soaInvertChunked(out, a, chunkSize, yieldEvery) {
	return _chunkedM3(out, function (i) {
		var a00 = a.m00[i], a01 = a.m01[i], a02 = a.m02[i];
		var a10 = a.m10[i], a11 = a.m11[i], a12 = a.m12[i];
		var a20 = a.m20[i], a21 = a.m21[i], a22 = a.m22[i];
		var b01 = a22 * a11 - a12 * a21;
		var b11 = -a22 * a10 + a12 * a20;
		var b21 = a21 * a10 - a11 * a20;
		var det = a00 * b01 + a01 * b11 + a02 * b21;
		var inv = det ? 1.0 / det : 0;
		out.m00[i] = b01 * inv;
		out.m01[i] = (-a22 * a01 + a02 * a21) * inv;
		out.m02[i] = (a12 * a01 - a02 * a11) * inv;
		out.m10[i] = b11 * inv;
		out.m11[i] = (a22 * a00 - a02 * a20) * inv;
		out.m12[i] = (-a12 * a00 + a02 * a10) * inv;
		out.m20[i] = b21 * inv;
		out.m21[i] = (-a21 * a00 + a01 * a20) * inv;
		out.m22[i] = (a11 * a00 - a01 * a10) * inv;
	}, chunkSize, yieldEvery);
}

function soaTransformVec3Chunked(outX, outY, outZ, matrices, inVec, chunkSize, yieldEvery) {
	return _chunkedM3(matrices, function (i) {
		var x = inVec.x[i], y = inVec.y[i], z = inVec.z[i];
		outX[i] = matrices.m00[i] * x + matrices.m10[i] * y + matrices.m20[i] * z;
		outY[i] = matrices.m01[i] * x + matrices.m11[i] * y + matrices.m21[i] * z;
		outZ[i] = matrices.m02[i] * x + matrices.m12[i] * y + matrices.m22[i] * z;
	}, chunkSize, yieldEvery);
}

async function soaForEachChunked(out, a, callback, chunkSize, yieldEvery) {
	return _chunkedM3(out, function (i) { callback(i, a, out); }, chunkSize, yieldEvery);
}

// ============================================================================
// 7. ANIMATION
// ============================================================================
function decompose(out, m) {
	var m00 = m[0], m01 = m[1], m02 = m[2];
	var m10 = m[3], m11 = m[4], m12 = m[5];
	var m20 = m[6], m21 = m[7], m22 = m[8];
	var sx = Math.sqrt(m00 * m00 + m01 * m01 + m02 * m02);
	var sy = Math.sqrt(m10 * m10 + m11 * m11 + m12 * m12);
	var sz = Math.sqrt(m20 * m20 + m21 * m21 + m22 * m22);
	out[0] = sx; out[1] = sy; out[2] = sz;
	var isx = sx > 0 ? 1 / sx : 0;
	var isy = sy > 0 ? 1 / sy : 0;
	var isz = sz > 0 ? 1 / sz : 0;
	var r00 = m00 * isx, r01 = m01 * isx, r02 = m02 * isx;
	var r10 = m10 * isy, r11 = m11 * isy, r12 = m12 * isy;
	var r20 = m20 * isz, r21 = m21 * isz, r22 = m22 * isz;
	var trace = r00 + r11 + r22;
	var S, qx, qy, qz, qw;
	if (trace > 0) {
		S = Math.sqrt(trace + 1.0) * 2;
		qw = 0.25 * S;
		qx = (r12 - r21) / S;
		qy = (r20 - r02) / S;
		qz = (r01 - r10) / S;
	} else if (r00 > r11 && r00 > r22) {
		S = Math.sqrt(1.0 + r00 - r11 - r22) * 2;
		qw = (r12 - r21) / S;
		qx = 0.25 * S;
		qy = (r01 + r10) / S;
		qz = (r20 + r02) / S;
	} else if (r11 > r22) {
		S = Math.sqrt(1.0 + r11 - r00 - r22) * 2;
		qw = (r20 - r02) / S;
		qx = (r01 + r10) / S;
		qy = 0.25 * S;
		qz = (r12 + r21) / S;
	} else {
		S = Math.sqrt(1.0 + r22 - r00 - r11) * 2;
		qw = (r01 - r10) / S;
		qx = (r20 + r02) / S;
		qy = (r12 + r21) / S;
		qz = 0.25 * S;
	}
	out[3] = qx; out[4] = qy; out[5] = qz; out[6] = qw;
	return out;
}

function compose(out, sx, sy, sz, qx, qy, qz, qw) {
	var x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
	var xx = qx * x2, yx = qy * x2, yy = qy * y2;
	var zx = qz * x2, zy = qz * y2, zz = qz * z2;
	var wx = qw * x2, wy = qw * y2, wz = qw * z2;
	out[0] = (1 - yy - zz) * sx;
	out[1] = (yx + wz) * sx;
	out[2] = (zx - wy) * sx;
	out[3] = (yx - wz) * sy;
	out[4] = (1 - xx - zz) * sy;
	out[5] = (zy + wx) * sy;
	out[6] = (zx + wy) * sz;
	out[7] = (zy - wx) * sz;
	out[8] = (1 - xx - yy) * sz;
	return out;
}

function blend(out, a, b, t) {
	for (var i = 0; i < 9; i++) { out[i] = a[i] + t * (b[i] - a[i]); }
	return out;
}

function blendRotation(out, a, b, t) {
	var a00 = a[0], a01 = a[1], a02 = a[2];
	var a10 = a[3], a11 = a[4], a12 = a[5];
	var a20 = a[6], a21 = a[7], a22 = a[8];
	var asx = Math.sqrt(a00 * a00 + a01 * a01 + a02 * a02);
	var asy = Math.sqrt(a10 * a10 + a11 * a11 + a12 * a12);
	var asz = Math.sqrt(a20 * a20 + a21 * a21 + a22 * a22);
	var aisx = asx > 0 ? 1 / asx : 0, aisy = asy > 0 ? 1 / asy : 0, aisz = asz > 0 ? 1 / asz : 0;
	var ar00 = a00 * aisx, ar01 = a01 * aisx, ar02 = a02 * aisx;
	var ar10 = a10 * aisy, ar11 = a11 * aisy, ar12 = a12 * aisy;
	var ar20 = a20 * aisz, ar21 = a21 * aisz, ar22 = a22 * aisz;
	var aTrace = ar00 + ar11 + ar22;
	var aqx, aqy, aqz, aqw, aS;
	if (aTrace > 0) {
		aS = Math.sqrt(aTrace + 1.0) * 2; aqw = 0.25 * aS;
		aqx = (ar12 - ar21) / aS; aqy = (ar20 - ar02) / aS; aqz = (ar01 - ar10) / aS;
	} else if (ar00 > ar11 && ar00 > ar22) {
		aS = Math.sqrt(1.0 + ar00 - ar11 - ar22) * 2; aqw = (ar12 - ar21) / aS;
		aqx = 0.25 * aS; aqy = (ar01 + ar10) / aS; aqz = (ar20 + ar02) / aS;
	} else if (ar11 > ar22) {
		aS = Math.sqrt(1.0 + ar11 - ar00 - ar22) * 2; aqw = (ar20 - ar02) / aS;
		aqx = (ar01 + ar10) / aS; aqy = 0.25 * aS; aqz = (ar12 + ar21) / aS;
	} else {
		aS = Math.sqrt(1.0 + ar22 - ar00 - ar11) * 2; aqw = (ar01 - ar10) / aS;
		aqx = (ar20 + ar02) / aS; aqy = (ar12 + ar21) / aS; aqz = 0.25 * aS;
	}
	var b00 = b[0], b01 = b[1], b02 = b[2];
	var b10 = b[3], b11 = b[4], b12 = b[5];
	var b20 = b[6], b21 = b[7], b22 = b[8];
	var bsx = Math.sqrt(b00 * b00 + b01 * b01 + b02 * b02);
	var bsy = Math.sqrt(b10 * b10 + b11 * b11 + b12 * b12);
	var bsz = Math.sqrt(b20 * b20 + b21 * b21 + b22 * b22);
	var bisx = bsx > 0 ? 1 / bsx : 0, bisy = bsy > 0 ? 1 / bsy : 0, bisz = bsz > 0 ? 1 / bsz : 0;
	var br00 = b00 * bisx, br01 = b01 * bisx, br02 = b02 * bisx;
	var br10 = b10 * bisy, br11 = b11 * bisy, br12 = b12 * bisy;
	var br20 = b20 * bisz, br21 = b21 * bisz, br22 = b22 * bisz;
	var bTrace = br00 + br11 + br22;
	var bqx, bqy, bqz, bqw, bS;
	if (bTrace > 0) {
		bS = Math.sqrt(bTrace + 1.0) * 2; bqw = 0.25 * bS;
		bqx = (br12 - br21) / bS; bqy = (br20 - br02) / bS; bqz = (br01 - br10) / bS;
	} else if (br00 > br11 && br00 > br22) {
		bS = Math.sqrt(1.0 + br00 - br11 - br22) * 2; bqw = (br12 - br21) / bS;
		bqx = 0.25 * bS; bqy = (br01 + br10) / bS; bqz = (br20 + br02) / bS;
	} else if (br11 > br22) {
		bS = Math.sqrt(1.0 + br11 - br00 - br22) * 2; bqw = (br20 - br02) / bS;
		bqx = (br01 + br10) / bS; bqy = 0.25 * bS; bqz = (br12 + br21) / bS;
	} else {
		bS = Math.sqrt(1.0 + br22 - br00 - br11) * 2; bqw = (br01 - br10) / bS;
		bqx = (br20 + br02) / bS; bqy = (br12 + br21) / bS; bqz = 0.25 * bS;
	}
	var cosom = aqx * bqx + aqy * bqy + aqz * bqz + aqw * bqw;
	if (cosom < 0) { bqx = -bqx; bqy = -bqy; bqz = -bqz; bqw = -bqw; cosom = -cosom; }
	var s0, s1;
	if (1 - cosom > EPSILON) {
		var omega = Math.acos(cosom);
		var sinom = Math.sin(omega);
		s0 = Math.sin((1 - t) * omega) / sinom;
		s1 = Math.sin(t * omega) / sinom;
	} else {
		s0 = 1 - t; s1 = t;
	}
	var qx = s0 * aqx + s1 * bqx;
	var qy = s0 * aqy + s1 * bqy;
	var qz = s0 * aqz + s1 * bqz;
	var qw = s0 * aqw + s1 * bqw;
	var sx = asx + t * (bsx - asx);
	var sy = asy + t * (bsy - asy);
	var sz = asz + t * (bsz - asz);
	return compose(out, sx, sy, sz, qx, qy, qz, qw);
}

// ============================================================================
// 8. IK / NATURAL MOTION
// ============================================================================
function fromLookAt(out, fx, fy, fz, ux, uy, uz) {
	var len = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1e-9;
	fx /= len; fy /= len; fz /= len;
	var bx = -fx, by = -fy, bz = -fz;
	var rx = uy * bz - uz * by;
	var ry = uz * bx - ux * bz;
	var rz = ux * by - uy * bx;
	var rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
	if (rlen < EPSILON) {
		rx = 1; ry = 0; rz = 0;
		if (Math.abs(fx) > 0.9) { rx = 0; ry = 1; rz = 0; }
	} else {
		var inv = 1 / rlen;
		rx *= inv; ry *= inv; rz *= inv;
	}
	var upx = by * rz - bz * ry;
	var upy = bz * rx - bx * rz;
	var upz = bx * ry - by * rx;
	out[0] = rx; out[1] = ry; out[2] = rz;
	out[3] = upx; out[4] = upy; out[5] = upz;
	out[6] = bx; out[7] = by; out[8] = bz;
	return out;
}

function fromAxes(out, xAxis, yAxis, zAxis) {
	out[0] = xAxis[0]; out[1] = xAxis[1]; out[2] = xAxis[2];
	out[3] = yAxis[0]; out[4] = yAxis[1]; out[5] = yAxis[2];
	out[6] = zAxis[0]; out[7] = zAxis[1]; out[8] = zAxis[2];
	return out;
}

function fromBoneDirection(out, dx, dy, dz, ux, uy, uz) {
	return fromLookAt(out, dx, dy, dz, ux, uy, uz);
}

// ============================================================================
// 9. ORBITAL
// ============================================================================
function fromInclination(out, inclination, ascendingNode) {
	var ci = Math.cos(inclination), si = Math.sin(inclination);
	var cO = Math.cos(ascendingNode), sO = Math.sin(ascendingNode);
	out[0] = cO;       out[1] = sO;       out[2] = 0;
	out[3] = -sO * ci; out[4] = cO * ci;  out[5] = si;
	out[6] = sO * si;  out[7] = -cO * si; out[8] = ci;
	return out;
}

function fromOrbitalFrame(out, inclination, ascendingNode, argPeriapsis) {
	var cw = Math.cos(argPeriapsis), sw = Math.sin(argPeriapsis);
	var ci = Math.cos(inclination), si = Math.sin(inclination);
	var cO = Math.cos(ascendingNode), sO = Math.sin(ascendingNode);
	var r00 = cO * cw - sO * sw * ci;
	var r01 = -cO * sw - sO * cw * ci;
	var r02 = sO * si;
	var r10 = sO * cw + cO * sw * ci;
	var r11 = -sO * sw + cO * cw * ci;
	var r12 = -cO * si;
	var r20 = sw * si;
	var r21 = cw * si;
	var r22 = ci;
	out[0] = r00; out[1] = r10; out[2] = r20;
	out[3] = r01; out[4] = r11; out[5] = r21;
	out[6] = r02; out[7] = r12; out[8] = r22;
	return out;
}

function soaFillFromOrbitalFrame(out, inclinations, ascendingNodes, argPeriapses) {
	var o00 = out.m00, o01 = out.m01, o02 = out.m02;
	var o10 = out.m10, o11 = out.m11, o12 = out.m12;
	var o20 = out.m20, o21 = out.m21, o22 = out.m22;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var cw = Math.cos(argPeriapses[i]), sw = Math.sin(argPeriapses[i]);
		var ci = Math.cos(inclinations[i]), si = Math.sin(inclinations[i]);
		var cO = Math.cos(ascendingNodes[i]), sO = Math.sin(ascendingNodes[i]);
		var r00 = cO * cw - sO * sw * ci;
		var r01 = -cO * sw - sO * cw * ci;
		var r02 = sO * si;
		var r10 = sO * cw + cO * sw * ci;
		var r11 = -sO * sw + cO * cw * ci;
		var r12 = -cO * si;
		var r20 = sw * si;
		var r21 = cw * si;
		var r22 = ci;
		o00[i] = r00; o01[i] = r10; o02[i] = r20;
		o10[i] = r01; o11[i] = r11; o12[i] = r21;
		o20[i] = r02; o21[i] = r12; o22[i] = r22;
	}
	return out;
}

// ============================================================================
// 10. COLOR GRADING MATRICES
// ============================================================================
const LUMA_R709 = 0.2126;
const LUMA_G709 = 0.7152;
const LUMA_B709 = 0.0722;

function fromGrayscale(out, lr, lg, lb) {
	lr = lr === undefined ? LUMA_R709 : lr;
	lg = lg === undefined ? LUMA_G709 : lg;
	lb = lb === undefined ? LUMA_B709 : lb;
	out[0] = lr; out[1] = lg; out[2] = lb;
	out[3] = lr; out[4] = lg; out[5] = lb;
	out[6] = lr; out[7] = lg; out[8] = lb;
	return out;
}

function fromSaturation(out, s) {
	var lr = LUMA_R709, lg = LUMA_G709, lb = LUMA_B709;
	var inv = 1 - s;
	out[0] = lr * inv + s; out[1] = lg * inv;     out[2] = lb * inv;
	out[3] = lr * inv;     out[4] = lg * inv + s; out[5] = lb * inv;
	out[6] = lr * inv;     out[7] = lg * inv;     out[8] = lb * inv + s;
	return out;
}

function fromChannelMix(out, rr, rg, rb, gr, gg, gb, br, bg, bb) {
	out[0] = rr; out[1] = rg; out[2] = rb;
	out[3] = gr; out[4] = gg; out[5] = gb;
	out[6] = br; out[7] = bg; out[8] = bb;
	return out;
}

function fromHueRotation(out, rad) {
	var cosA = Math.cos(rad), sinA = Math.sin(rad);
	var yr = 0.299, yg = 0.587, yb = 0.114;
	var ir = 0.596, ig = -0.274, ib = -0.322;
	var qr = 0.211, qg = -0.523, qb = 0.312;
	var nir = cosA * ir - sinA * qr;
	var nig = cosA * ig - sinA * qg;
	var nib = cosA * ib - sinA * qb;
	var nqr = sinA * ir + cosA * qr;
	var nqg = sinA * ig + cosA * qg;
	var nqb = sinA * ib + cosA * qb;
	out[0] = yr + 0.956 * nir + 0.621 * nqr;
	out[1] = yg + 0.956 * nig + 0.621 * nqg;
	out[2] = yb + 0.956 * nib + 0.621 * nqb;
	out[3] = yr - 0.272 * nir - 0.647 * nqr;
	out[4] = yg - 0.272 * nig - 0.647 * nqg;
	out[5] = yb - 0.272 * nib - 0.647 * nqb;
	out[6] = yr - 1.106 * nir + 1.703 * nqr;
	out[7] = yg - 1.106 * nig + 1.703 * nqg;
	out[8] = yb - 1.106 * nib + 1.703 * nqb;
	return out;
}

function soaApplyColorMatrix(out, colors, matrix) {
	var ox = out.x, oy = out.y, oz = out.z;
	var cx = colors.x, cy = colors.y, cz = colors.z;
	var m0 = matrix[0], m1 = matrix[1], m2 = matrix[2];
	var m3 = matrix[3], m4 = matrix[4], m5 = matrix[5];
	var m6 = matrix[6], m7 = matrix[7], m8 = matrix[8];
	var n = colors.count;
	for (var i = 0; i < n; i++) {
		var r = cx[i], g = cy[i], b = cz[i];
		ox[i] = m0 * r + m1 * g + m2 * b;
		oy[i] = m3 * r + m4 * g + m5 * b;
		oz[i] = m6 * r + m7 * g + m8 * b;
	}
	return out;
}

// ============================================================================
// 11. RENDERING (screen-space / reflection / world-to-NDC)
// ============================================================================
function fromScreenToNDC(out, x, y, w, h, viewW, viewH) {
	var sx = 2 * w / viewW;
	var sy = -2 * h / viewH;
	var tx = 2 * x / viewW - 1 + w / viewW;
	var ty = 1 - 2 * y / viewH - h / viewH;
	out[0] = sx; out[1] = 0; out[2] = 0;
	out[3] = 0; out[4] = sy; out[5] = 0;
	out[6] = tx; out[7] = ty; out[8] = 1;
	return out;
}

function fromUniformScale(out, s) {
	out[0] = s; out[1] = 0; out[2] = 0;
	out[3] = 0; out[4] = s; out[5] = 0;
	out[6] = 0; out[7] = 0; out[8] = s;
	return out;
}

function fromScale3(out, sx, sy, sz) {
	out[0] = sx; out[1] = 0; out[2] = 0;
	out[3] = 0; out[4] = sy; out[5] = 0;
	out[6] = 0; out[7] = 0; out[8] = sz;
	return out;
}

function fromWorldBounds(out, minX, minY, minZ, maxX, maxY, maxZ) {
	var w = maxX - minX || 1;
	var h = maxY - minY || 1;
	var d = maxZ - minZ || 1;
	out[0] = 2 / w; out[1] = 0; out[2] = 0;
	out[3] = 0; out[4] = 2 / h; out[5] = 0;
	out[6] = 0; out[7] = 0; out[8] = 2 / d;
	return out;
}

function fromReflection(out, flipX, flipY, flipZ) {
	out[0] = flipX ? -1 : 1; out[1] = 0; out[2] = 0;
	out[3] = 0; out[4] = flipY ? -1 : 1; out[5] = 0;
	out[6] = 0; out[7] = 0; out[8] = flipZ ? -1 : 1;
	return out;
}

function fromRotationX(out, rad) {
	var s = Math.sin(rad), c = Math.cos(rad);
	out[0] = 1; out[1] = 0; out[2] = 0;
	out[3] = 0; out[4] = c; out[5] = s;
	out[6] = 0; out[7] = -s; out[8] = c;
	return out;
}

function fromRotationY(out, rad) {
	var s = Math.sin(rad), c = Math.cos(rad);
	out[0] = c; out[1] = 0; out[2] = -s;
	out[3] = 0; out[4] = 1; out[5] = 0;
	out[6] = s; out[7] = 0; out[8] = c;
	return out;
}

function fromRotationZ(out, rad) {
	var s = Math.sin(rad), c = Math.cos(rad);
	out[0] = c; out[1] = s; out[2] = 0;
	out[3] = -s; out[4] = c; out[5] = 0;
	out[6] = 0; out[7] = 0; out[8] = 1;
	return out;
}

// ============================================================================
// 12. EXPORTS
// ============================================================================
export {
	// foundation constants
	EPSILON, ARRAY_TYPE, CHUNK_SIZE, CHUNK_YIELD_EVERY,
	// flat API
	create, fromMat4, clone, copy, fromValues, set, identity, transpose, invert,
	adjoint, determinant, multiply, translate, rotate, scale, fromTranslation,
	fromRotation, fromScaling, fromMat2d, fromQuat, normalFromMat4, projection,
	str, frob, add, subtract, multiplyScalar, multiplyScalarAndAdd,
	exactEquals, equals,
	// aliases
	mul, sub,
	// pool
	createMat3Pool, acquire, release,
	// SOA
	createMat3SOA, soaIdentity, soaZero, soaFill, soaGet, soaSet, soaCopy,
	soaToFlat, soaFromFlat, soaMultiply, soaAdd, soaSub, soaMultiplyScalar,
	soaTranspose, soaInvert, soaDeterminant, soaTransformVec3,
	// chunked async
	soaMultiplyChunked, soaInvertChunked, soaTransformVec3Chunked, soaForEachChunked,
	// TBN
	buildTBN, soaBuildTBN, soaBuildTBNChunked,
	// procedural
	soaFillFromNoise, soaFillFromNoiseChunked, soaFromQuatSOA, soaFromQuatSOAChunked,
	// animation
	decompose, compose, blend, blendRotation,
	// IK / natural motion
	fromLookAt, fromAxes, fromBoneDirection,
	// orbital
	fromInclination, fromOrbitalFrame, soaFillFromOrbitalFrame,
	// color
	LUMA_R709, LUMA_G709, LUMA_B709,
	fromGrayscale, fromSaturation, fromChannelMix, fromHueRotation, soaApplyColorMatrix,
	// rendering / scale
	fromScreenToNDC, fromUniformScale, fromScale3, fromWorldBounds,
	fromReflection, fromRotationX, fromRotationY, fromRotationZ
};

export default {
	create, fromMat4, clone, copy, fromValues, set, identity, transpose, invert,
	adjoint, determinant, multiply, translate, rotate, scale, fromTranslation,
	fromRotation, fromScaling, fromMat2d, fromQuat, normalFromMat4, projection,
	str, frob, add, subtract, multiplyScalar, multiplyScalarAndAdd,
	exactEquals, equals,
	mul, sub,
	createMat3Pool, acquire, release,
	createMat3SOA, soaIdentity, soaZero, soaFill, soaGet, soaSet, soaCopy,
	soaToFlat, soaFromFlat, soaMultiply, soaAdd, soaSub, soaMultiplyScalar,
	soaTranspose, soaInvert, soaDeterminant, soaTransformVec3,
	soaMultiplyChunked, soaInvertChunked, soaTransformVec3Chunked, soaForEachChunked,
	buildTBN, soaBuildTBN, soaBuildTBNChunked,
	soaFillFromNoise, soaFillFromNoiseChunked, soaFromQuatSOA, soaFromQuatSOAChunked,
	decompose, compose, blend, blendRotation,
	fromLookAt, fromAxes, fromBoneDirection,
	fromInclination, fromOrbitalFrame, soaFillFromOrbitalFrame,
	LUMA_R709, LUMA_G709, LUMA_B709,
	fromGrayscale, fromSaturation, fromChannelMix, fromHueRotation, soaApplyColorMatrix,
	fromScreenToNDC, fromUniformScale, fromScale3, fromWorldBounds,
	fromReflection, fromRotationX, fromRotationY, fromRotationZ
};