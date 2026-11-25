// File number : 007
// File : src/math/007_mat4.js
// Description : 4x4 matrix (full glMatrix API) + complete SOA bulk layout (1M+
//               matrices), zero-GC pool, chunked parallelism, per-instance TRS
//               fill (position/rotation/scale from spatial noise), batch vertex
//               transform (skinned mesh / instancing), orbital-element to world
//               matrix builders, IK joint world matrices, camera look-at /
//               targetTo / frustum / perspective / ortho builders, and
//               floating-origin-safe world-to-view and world-to-NDC math. All
//               hot paths avoid per-element allocation.
// Best for : 3d graphics -- procedural generation (per-instance TRS on 1M+
//            asteroids/particles/trees from noise, orbital-element-driven
//            transforms, galaxy cluster seeds), rendering (instanced draw of
//            1M+ meshes, batched MVP transforms, camera, projectors, shadow
//            cascade setup, depth reconstruction), color (post-process quad
//            matrices, tone-map screen quads), animation (TRS decompose/compose
//            + slerp, per-instance keyframe blending at 60 fps), natural IK
//            motion (joint local-to-world by parent matrix, root motion, foot
//            planting to world, aiming), orbital (planet world matrices from
//            full Keplerian elements for 1M+ bodies, satellite meshes, ring
//            debris), seamless small-to-galactic scale (floating-origin world
//            matrices, world-region-to-NDC transforms, log-depth
//            reconstruction). All SOA ops are Float32Array-backed and work
//            identically from mm to Mpc.
// License : MIT
//
// NOTE: Rewritten as a self-contained native ES module (no Vite / no Vue / no
//       client build) so it loads directly in the browser alongside Three.js
//       r185. The previous CommonJS build is removed. All features, functions
//       and exports of the original are preserved, with allocation bugs fixed.

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

// ============================================================================
// MODULE-LEVEL TEMPORARIES (zero-GC flat API)
// ============================================================================
var _tmpMat4 = new Float32Array(16);
var _posA = new Float32Array(3);
var _posB = new Float32Array(3);
var _posOut = new Float32Array(3);
var _scaleA = new Float32Array(3);
var _scaleB = new Float32Array(3);
var _scaleOut = new Float32Array(3);
var _quatA = new Float32Array(4);
var _quatB = new Float32Array(4);
var _quatOut = new Float32Array(4);
var _vec3Tmp = new Float32Array(3);

// ============================================================================
// 1. FLAT API (glMatrix compatible, column-major)
// ============================================================================
/**
4x4 Matrix -- column-major (glMatrix convention).
Post-multiplied: out = multiply(out, a, b) applies b first, then a.
*/
function create() {
	var out = new ARRAY_TYPE(16);
	if (ARRAY_TYPE !== Float32Array) {
		out[1] = 0; out[2] = 0; out[3] = 0;
		out[4] = 0; out[6] = 0; out[7] = 0;
		out[8] = 0; out[9] = 0; out[11] = 0;
		out[12] = 0; out[13] = 0; out[14] = 0;
	}
	out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1;
	return out;
}

function clone(a) {
	var out = new ARRAY_TYPE(16);
	for (var i = 0; i < 16; i++) { out[i] = a[i]; }
	return out;
}

function copy(out, a) {
	out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
	out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
	out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
	out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
	return out;
}

function fromValues(m00, m01, m02, m03, m10, m11, m12, m13, m20, m21, m22, m23, m30, m31, m32, m33) {
	var out = new ARRAY_TYPE(16);
	out[0] = m00; out[1] = m01; out[2] = m02; out[3] = m03;
	out[4] = m10; out[5] = m11; out[6] = m12; out[7] = m13;
	out[8] = m20; out[9] = m21; out[10] = m22; out[11] = m23;
	out[12] = m30; out[13] = m31; out[14] = m32; out[15] = m33;
	return out;
}

function set(out, m00, m01, m02, m03, m10, m11, m12, m13, m20, m21, m22, m23, m30, m31, m32, m33) {
	out[0] = m00; out[1] = m01; out[2] = m02; out[3] = m03;
	out[4] = m10; out[5] = m11; out[6] = m12; out[7] = m13;
	out[8] = m20; out[9] = m21; out[10] = m22; out[11] = m23;
	out[12] = m30; out[13] = m31; out[14] = m32; out[15] = m33;
	return out;
}

function identity(out) {
	out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
	out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
	out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
	out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
	return out;
}

function transpose(out, a) {
	if (out === a) {
		var a01 = a[1], a02 = a[2], a03 = a[3];
		var a12 = a[6], a13 = a[7], a23 = a[11];
		out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
		out[4] = a01; out[6] = a[9]; out[7] = a[13];
		out[8] = a02; out[9] = a12; out[11] = a[14];
		out[12] = a03; out[13] = a13; out[14] = a23;
	} else {
		out[0] = a[0]; out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
		out[4] = a[1]; out[5] = a[5]; out[6] = a[9]; out[7] = a[13];
		out[8] = a[2]; out[9] = a[6]; out[10] = a[10]; out[11] = a[14];
		out[12] = a[3]; out[13] = a[7]; out[14] = a[11]; out[15] = a[15];
	}
	return out;
}

function invert(out, a) {
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
	out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
	out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
	out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
	out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
	out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
	out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
	out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
	out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
	out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
	out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
	out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
	out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
	out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
	out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
	out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
	return out;
}

function adjoint(out, a) {
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

	out[0] = a11 * b11 - a12 * b10 + a13 * b09;
	out[1] = a02 * b10 - a01 * b11 - a03 * b09;
	out[2] = a31 * b05 - a32 * b04 + a33 * b03;
	out[3] = a22 * b04 - a21 * b05 - a23 * b03;
	out[4] = a12 * b08 - a10 * b11 - a13 * b07;
	out[5] = a00 * b11 - a02 * b08 + a03 * b07;
	out[6] = a32 * b02 - a30 * b05 - a33 * b01;
	out[7] = a20 * b05 - a22 * b02 + a23 * b01;
	out[8] = a10 * b10 - a11 * b08 + a13 * b06;
	out[9] = a01 * b08 - a00 * b10 - a03 * b06;
	out[10] = a30 * b04 - a31 * b02 + a33 * b00;
	out[11] = a21 * b02 - a20 * b04 - a23 * b00;
	out[12] = a11 * b07 - a10 * b09 - a12 * b06;
	out[13] = a00 * b09 - a01 * b07 + a02 * b06;
	out[14] = a31 * b01 - a30 * b03 - a32 * b00;
	out[15] = a20 * b03 - a21 * b01 + a22 * b00;
	return out;
}

function determinant(a) {
	var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
	var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
	var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
	var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

	var b0 = a00 * a11 - a01 * a10;
	var b1 = a00 * a12 - a02 * a10;
	var b2 = a01 * a12 - a02 * a11;
	var b3 = a20 * a31 - a21 * a30;
	var b4 = a20 * a32 - a22 * a30;
	var b5 = a21 * a32 - a22 * a31;
	var b6 = a00 * b5 - a01 * b4 + a02 * b3;
	var b7 = a10 * b5 - a11 * b4 + a12 * b3;
	var b8 = a20 * b2 - a21 * b1 + a22 * b0;
	var b9 = a30 * b2 - a31 * b1 + a32 * b0;

	return a13 * b6 - a03 * b7 + a33 * b8 - a23 * b9;
}

function multiply(out, a, b) {
	var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
	var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
	var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
	var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

	var b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
	out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
	out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
	out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
	out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

	b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
	out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
	out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
	out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
	out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

	b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
	out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
	out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
	out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
	out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

	b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
	out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
	out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
	out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
	out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
	return out;
}

function translate(out, a, v) {
	var x = v[0], y = v[1], z = v[2];
	if (a === out) {
		out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
		out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
		out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
		out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
	} else {
		var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
		var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
		var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
		out[0] = a00; out[1] = a01; out[2] = a02; out[3] = a03;
		out[4] = a10; out[5] = a11; out[6] = a12; out[7] = a13;
		out[8] = a20; out[9] = a21; out[10] = a22; out[11] = a23;
		out[12] = a00 * x + a10 * y + a20 * z + a[12];
		out[13] = a01 * x + a11 * y + a21 * z + a[13];
		out[14] = a02 * x + a12 * y + a22 * z + a[14];
		out[15] = a03 * x + a13 * y + a23 * z + a[15];
	}
	return out;
}

function scale(out, a, v) {
	var x = v[0], y = v[1], z = v[2];
	out[0] = a[0] * x; out[1] = a[1] * x; out[2] = a[2] * x; out[3] = a[3] * x;
	out[4] = a[4] * y; out[5] = a[5] * y; out[6] = a[6] * y; out[7] = a[7] * y;
	out[8] = a[8] * z; out[9] = a[9] * z; out[10] = a[10] * z; out[11] = a[11] * z;
	out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
	return out;
}

function rotate(out, a, rad, axis) {
	var x = axis[0], y = axis[1], z = axis[2];
	var len = Math.sqrt(x * x + y * y + z * z);
	if (len < EPSILON) { return null; }
	len = 1 / len;
	x *= len; y *= len; z *= len;

	var s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;

	var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
	var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
	var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];

	var b00 = x * x * t + c,     b01 = y * x * t + z * s, b02 = z * x * t - y * s;
	var b10 = x * y * t - z * s, b11 = y * y * t + c,     b12 = z * y * t + x * s;
	var b20 = x * z * t + y * s, b21 = y * z * t - x * s, b22 = z * z * t + c;

	out[0] = a00 * b00 + a10 * b01 + a20 * b02;
	out[1] = a01 * b00 + a11 * b01 + a21 * b02;
	out[2] = a02 * b00 + a12 * b01 + a22 * b02;
	out[3] = a03 * b00 + a13 * b01 + a23 * b02;
	out[4] = a00 * b10 + a10 * b11 + a20 * b12;
	out[5] = a01 * b10 + a11 * b11 + a21 * b12;
	out[6] = a02 * b10 + a12 * b11 + a22 * b12;
	out[7] = a03 * b10 + a13 * b11 + a23 * b12;
	out[8] = a00 * b20 + a10 * b21 + a20 * b22;
	out[9] = a01 * b20 + a11 * b21 + a21 * b22;
	out[10] = a02 * b20 + a12 * b21 + a22 * b22;
	out[11] = a03 * b20 + a13 * b21 + a23 * b22;

	if (a !== out) {
		out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
	}
	return out;
}

function rotateX(out, a, rad) {
	var s = Math.sin(rad), c = Math.cos(rad);
	var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
	var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];

	if (a !== out) {
		out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
		out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
	}

	out[4] = a10 * c + a20 * s; out[5] = a11 * c + a21 * s;
	out[6] = a12 * c + a22 * s; out[7] = a13 * c + a23 * s;
	out[8] = a20 * c - a10 * s; out[9] = a21 * c - a11 * s;
	out[10] = a22 * c - a12 * s; out[11] = a23 * c - a13 * s;
	return out;
}

function rotateY(out, a, rad) {
	var s = Math.sin(rad), c = Math.cos(rad);
	var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
	var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];

	if (a !== out) {
		out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
		out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
	}

	out[0] = a00 * c - a20 * s; out[1] = a01 * c - a21 * s;
	out[2] = a02 * c - a22 * s; out[3] = a03 * c - a23 * s;
	out[8] = a00 * s + a20 * c; out[9] = a01 * s + a21 * c;
	out[10] = a02 * s + a22 * c; out[11] = a03 * s + a23 * c;
	return out;
}

function rotateZ(out, a, rad) {
	var s = Math.sin(rad), c = Math.cos(rad);
	var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
	var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];

	if (a !== out) {
		out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
		out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
	}

	out[0] = a00 * c + a10 * s; out[1] = a01 * c + a11 * s;
	out[2] = a02 * c + a12 * s; out[3] = a03 * c + a13 * s;
	out[4] = a10 * c - a00 * s; out[5] = a11 * c - a01 * s;
	out[6] = a12 * c - a02 * s; out[7] = a13 * c - a03 * s;
	return out;
}

function fromTranslation(out, v) {
	out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
	out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
	out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
	out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; out[15] = 1;
	return out;
}

function fromScaling(out, v) {
	out[0] = v[0]; out[1] = 0; out[2] = 0; out[3] = 0;
	out[4] = 0; out[5] = v[1]; out[6] = 0; out[7] = 0;
	out[8] = 0; out[9] = 0; out[10] = v[2]; out[11] = 0;
	out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
	return out;
}

function fromRotation(out, rad, axis) {
	var x = axis[0], y = axis[1], z = axis[2];
	var len = Math.sqrt(x * x + y * y + z * z);
	if (len < EPSILON) { return null; }
	len = 1 / len;
	x *= len; y *= len; z *= len;

	var s = Math.sin(rad), c = Math.cos(rad), t = 1 - c;

	out[0] = x * x * t + c;     out[1] = y * x * t + z * s; out[2] = z * x * t - y * s; out[3] = 0;
	out[4] = x * y * t - z * s; out[5] = y * y * t + c;     out[6] = z * y * t + x * s; out[7] = 0;
	out[8] = x * z * t + y * s; out[9] = y * z * t - x * s; out[10] = z * z * t + c;    out[11] = 0;
	out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
	return out;
}

function fromXRotation(out, rad) {
	var s = Math.sin(rad), c = Math.cos(rad);
	out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
	out[4] = 0; out[5] = c; out[6] = s; out[7] = 0;
	out[8] = 0; out[9] = -s; out[10] = c; out[11] = 0;
	out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
	return out;
}

function fromYRotation(out, rad) {
	var s = Math.sin(rad), c = Math.cos(rad);
	out[0] = c; out[1] = 0; out[2] = -s; out[3] = 0;
	out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
	out[8] = s; out[9] = 0; out[10] = c; out[11] = 0;
	out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
	return out;
}

function fromZRotation(out, rad) {
	var s = Math.sin(rad), c = Math.cos(rad);
	out[0] = c; out[1] = s; out[2] = 0; out[3] = 0;
	out[4] = -s; out[5] = c; out[6] = 0; out[7] = 0;
	out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
	out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
	return out;
}

function fromRotationTranslation(out, q, v) {
	var x = q[0], y = q[1], z = q[2], w = q[3];
	var x2 = x + x, y2 = y + y, z2 = z + z;
	var xx = x * x2, xy = x * y2, xz = x * z2;
	var yy = y * y2, yz = y * z2, zz = z * z2;
	var wx = w * x2, wy = w * y2, wz = w * z2;

	out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
	out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
	out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
	out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; out[15] = 1;
	return out;
}

// Uses module-level temporary (zero per-call allocation).
function fromQuat2(out, a) {
	var bx = -a[0], by = -a[1], bz = -a[2], bw = a[3];
	var ax = a[4], ay = a[5], az = a[6], aw = a[7];
	var magnitude = bx * bx + by * by + bz * bz + bw * bw;
	var tx, ty, tz;

	if (magnitude > 0) {
		var inv2m = 2 / magnitude;
		tx = (ax * bw + aw * bx + ay * bz - az * by) * inv2m;
		ty = (ay * bw + aw * by + az * bx - ax * bz) * inv2m;
		tz = (az * bw + aw * bz + ax * by - ay * bx) * inv2m;
	} else {
		tx = (ax * bw + aw * bx + ay * bz - az * by) * 2;
		ty = (ay * bw + aw * by + az * bx - ax * bz) * 2;
		tz = (az * bw + aw * bz + ax * by - ay * bx) * 2;
	}

	_vec3Tmp[0] = tx; _vec3Tmp[1] = ty; _vec3Tmp[2] = tz;
	return fromRotationTranslation(out, a, _vec3Tmp);
}

function getTranslation(out, mat) {
	out[0] = mat[12]; out[1] = mat[13]; out[2] = mat[14];
	return out;
}

function getScaling(out, mat) {
	var m11 = mat[0], m12 = mat[1], m13 = mat[2];
	var m21 = mat[4], m22 = mat[5], m23 = mat[6];
	var m31 = mat[8], m32 = mat[9], m33 = mat[10];
	out[0] = Math.sqrt(m11 * m11 + m12 * m12 + m13 * m13);
	out[1] = Math.sqrt(m21 * m21 + m22 * m22 + m23 * m23);
	out[2] = Math.sqrt(m31 * m31 + m32 * m32 + m33 * m33);
	return out;
}

// Uses module-level temporary to avoid per-call allocation.
function getRotation(out, mat) {
	getScaling(_vec3Tmp, mat);

	var is1 = 1 / (_vec3Tmp[0] || 1);
	var is2 = 1 / (_vec3Tmp[1] || 1);
	var is3 = 1 / (_vec3Tmp[2] || 1);

	var sm11 = mat[0] * is1, sm12 = mat[1] * is2, sm13 = mat[2] * is3;
	var sm21 = mat[4] * is1, sm22 = mat[5] * is2, sm23 = mat[6] * is3;
	var sm31 = mat[8] * is1, sm32 = mat[9] * is2, sm33 = mat[10] * is3;

	var trace = sm11 + sm22 + sm33;
	var S = 0;

	if (trace > 0) {
		S = Math.sqrt(trace + 1.0) * 2;
		out[3] = 0.25 * S;
		out[0] = (sm23 - sm32) / S;
		out[1] = (sm31 - sm13) / S;
		out[2] = (sm12 - sm21) / S;
	} else if (sm11 > sm22 && sm11 > sm33) {
		S = Math.sqrt(1.0 + sm11 - sm22 - sm33) * 2;
		out[3] = (sm23 - sm32) / S;
		out[0] = 0.25 * S;
		out[1] = (sm12 + sm21) / S;
		out[2] = (sm31 + sm13) / S;
	} else if (sm22 > sm33) {
		S = Math.sqrt(1.0 + sm22 - sm11 - sm33) * 2;
		out[3] = (sm31 - sm13) / S;
		out[0] = (sm12 + sm21) / S;
		out[1] = 0.25 * S;
		out[2] = (sm23 + sm32) / S;
	} else {
		S = Math.sqrt(1.0 + sm33 - sm11 - sm22) * 2;
		out[3] = (sm12 - sm21) / S;
		out[0] = (sm31 + sm13) / S;
		out[1] = (sm23 + sm32) / S;
		out[2] = 0.25 * S;
	}
	return out;
}

// Decompose mat into rotation quaternion, translation, scale.
function decompose(outRotation, outTranslation, outScale, mat) {
	getTranslation(outTranslation, mat);
	getScaling(outScale, mat);
	getRotation(outRotation, mat);
	return outRotation;
}

// Supports both scalar scale and vec3 array scale (zero-GC hot paths).
function fromRotationTranslationScale(out, q, v, s) {
	var x = q[0], y = q[1], z = q[2], w = q[3];
	var x2 = x + x, y2 = y + y, z2 = z + z;
	var xx = x * x2, xy = x * y2, xz = x * z2;
	var yy = y * y2, yz = y * z2, zz = z * z2;
	var wx = w * x2, wy = w * y2, wz = w * z2;

	var sx = (typeof s === "number") ? s : s[0];
	var sy = (typeof s === "number") ? s : s[1];
	var sz = (typeof s === "number") ? s : s[2];

	out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
	out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
	out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
	out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; out[15] = 1;
	return out;
}

function fromRotationTranslationScaleOrigin(out, q, v, s, o) {
	var x = q[0], y = q[1], z = q[2], w = q[3];
	var x2 = x + x, y2 = y + y, z2 = z + z;
	var xx = x * x2, xy = x * y2, xz = x * z2;
	var yy = y * y2, yz = y * z2, zz = z * z2;
	var wx = w * x2, wy = w * y2, wz = w * z2;

	var sx = s[0], sy = s[1], sz = s[2];
	var ox = o[0], oy = o[1], oz = o[2];

	var out0 = (1 - (yy + zz)) * sx, out1 = (xy + wz) * sx, out2 = (xz - wy) * sx;
	var out4 = (xy - wz) * sy, out5 = (1 - (xx + zz)) * sy, out6 = (yz + wx) * sy;
	var out8 = (xz + wy) * sz, out9 = (yz - wx) * sz, out10 = (1 - (xx + yy)) * sz;

	out[0] = out0; out[1] = out1; out[2] = out2; out[3] = 0;
	out[4] = out4; out[5] = out5; out[6] = out6; out[7] = 0;
	out[8] = out8; out[9] = out9; out[10] = out10; out[11] = 0;
	out[12] = v[0] + ox - (out0 * ox + out4 * oy + out8 * oz);
	out[13] = v[1] + oy - (out1 * ox + out5 * oy + out9 * oz);
	out[14] = v[2] + oz - (out2 * ox + out6 * oy + out10 * oz);
	out[15] = 1;
	return out;
}

function fromQuat(out, q) {
	var x = q[0], y = q[1], z = q[2], w = q[3];
	var x2 = x + x, y2 = y + y, z2 = z + z;
	var xx = x * x2, yx = y * x2, yy = y * y2;
	var zx = z * x2, zy = z * y2, zz = z * z2;
	var wx = w * x2, wy = w * y2, wz = w * z2;

	out[0] = 1 - yy - zz; out[1] = yx + wz; out[2] = zx - wy; out[3] = 0;
	out[4] = yx - wz; out[5] = 1 - xx - zz; out[6] = zy + wx; out[7] = 0;
	out[8] = zx + wy; out[9] = zy - wx; out[10] = 1 - xx - yy; out[11] = 0;
	out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
	return out;
}

function frustum(out, left, right, bottom, top, near, far) {
	var rl = 1 / (right - left);
	var tb = 1 / (top - bottom);
	var nf = 1 / (near - far);
	out[0] = near * 2 * rl; out[1] = 0; out[2] = 0; out[3] = 0;
	out[4] = 0; out[5] = near * 2 * tb; out[6] = 0; out[7] = 0;
	out[8] = (right + left) * rl; out[9] = (top + bottom) * tb; out[10] = (far + near) * nf; out[11] = -1;
	out[12] = 0; out[13] = 0; out[14] = far * near * 2 * nf; out[15] = 0;
	return out;
}

function perspectiveNO(out, fovy, aspect, near, far) {
	var f = 1.0 / Math.tan(fovy / 2);
	out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
	out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
	out[8] = 0; out[9] = 0; out[11] = -1;
	out[12] = 0; out[13] = 0; out[15] = 0;

	if (far != null && far !== Infinity) {
		var nf = 1 / (near - far);
		out[10] = (far + near) * nf;
		out[14] = 2 * far * near * nf;
	} else {
		out[10] = -1;
		out[14] = -2 * near;
	}
	return out;
}

const perspective = perspectiveNO;

function perspectiveZO(out, fovy, aspect, near, far) {
	var f = 1.0 / Math.tan(fovy / 2);
	out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
	out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
	out[8] = 0; out[9] = 0; out[11] = -1;
	out[12] = 0; out[13] = 0; out[15] = 0;

	if (far != null && far !== Infinity) {
		var nf = 1 / (near - far);
		out[10] = far * nf;
		out[14] = far * near * nf;
	} else {
		out[10] = -1;
		out[14] = -near;
	}
	return out;
}

function perspectiveFromFieldOfView(out, fov, near, far) {
	var upTan = Math.tan(fov.upDegrees * Math.PI / 180.0);
	var downTan = Math.tan(fov.downDegrees * Math.PI / 180.0);
	var leftTan = Math.tan(fov.leftDegrees * Math.PI / 180.0);
	var rightTan = Math.tan(fov.rightDegrees * Math.PI / 180.0);
	var xScale = 2.0 / (leftTan + rightTan);
	var yScale = 2.0 / (upTan + downTan);

	out[0] = xScale; out[1] = 0.0; out[2] = 0.0; out[3] = 0.0;
	out[4] = 0.0; out[5] = yScale; out[6] = 0.0; out[7] = 0.0;
	out[8] = -((leftTan - rightTan) * xScale * 0.5);
	out[9] = (upTan - downTan) * yScale * 0.5;
	out[10] = far / (near - far); out[11] = -1.0;
	out[12] = 0.0; out[13] = 0.0; out[14] = far * near / (near - far); out[15] = 0.0;
	return out;
}

function orthoNO(out, left, right, bottom, top, near, far) {
	var lr = 1 / (left - right);
	var bt = 1 / (bottom - top);
	var nf = 1 / (near - far);
	out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0;
	out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0;
	out[8] = 0; out[9] = 0; out[10] = 2 * nf; out[11] = 0;
	out[12] = (left + right) * lr; out[13] = (top + bottom) * bt; out[14] = (far + near) * nf; out[15] = 1;
	return out;
}

const ortho = orthoNO;

function orthoZO(out, left, right, bottom, top, near, far) {
	var lr = 1 / (left - right);
	var bt = 1 / (bottom - top);
	var nf = 1 / (near - far);
	out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0;
	out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0;
	out[8] = 0; out[9] = 0; out[10] = nf; out[11] = 0;
	out[12] = (left + right) * lr; out[13] = (top + bottom) * bt; out[14] = near * nf; out[15] = 1;
	return out;
}

function lookAt(out, eye, center, up) {
	var x0, x1, x2, y0, y1, y2, z0, z1, z2, len;
	var eyex = eye[0], eyey = eye[1], eyez = eye[2];
	var upx = up[0], upy = up[1], upz = up[2];
	var centerx = center[0], centery = center[1], centerz = center[2];

	if (Math.abs(eyex - centerx) < EPSILON &&
		Math.abs(eyey - centery) < EPSILON &&
		Math.abs(eyez - centerz) < EPSILON) {
		return identity(out);
	}

	z0 = eyex - centerx; z1 = eyey - centery; z2 = eyez - centerz;
	len = 1 / Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
	z0 *= len; z1 *= len; z2 *= len;

	x0 = upy * z2 - upz * z1; x1 = upz * z0 - upx * z2; x2 = upx * z1 - upy * z0;
	len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
	if (!len) { x0 = 0; x1 = 0; x2 = 0; }
	else { len = 1 / len; x0 *= len; x1 *= len; x2 *= len; }

	y0 = z1 * x2 - z2 * x1; y1 = z2 * x0 - z0 * x2; y2 = z0 * x1 - z1 * x0;
	len = Math.sqrt(y0 * y0 + y1 * y1 + y2 * y2);
	if (!len) { y0 = 0; y1 = 0; y2 = 0; }
	else { len = 1 / len; y0 *= len; y1 *= len; y2 *= len; }

	out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
	out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
	out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
	out[12] = -(x0 * eyex + x1 * eyey + x2 * eyez);
	out[13] = -(y0 * eyex + y1 * eyey + y2 * eyez);
	out[14] = -(z0 * eyex + z1 * eyey + z2 * eyez);
	out[15] = 1;
	return out;
}

function targetTo(out, eye, target, up) {
	var eyex = eye[0], eyey = eye[1], eyez = eye[2];
	var upx = up[0], upy = up[1], upz = up[2];

	var z0 = eyex - target[0], z1 = eyey - target[1], z2 = eyez - target[2];
	var len = z0 * z0 + z1 * z1 + z2 * z2;
	if (len > 0) {
		len = 1 / Math.sqrt(len);
		z0 *= len; z1 *= len; z2 *= len;
	}

	var x0 = upy * z2 - upz * z1;
	var x1 = upz * z0 - upx * z2;
	var x2 = upx * z1 - upy * z0;
	len = x0 * x0 + x1 * x1 + x2 * x2;
	if (len > 0) {
		len = 1 / Math.sqrt(len);
		x0 *= len; x1 *= len; x2 *= len;
	}

	out[0] = x0; out[1] = x1; out[2] = x2; out[3] = 0;
	out[4] = z1 * x2 - z2 * x1; out[5] = z2 * x0 - z0 * x2; out[6] = z0 * x1 - z1 * x0; out[7] = 0;
	out[8] = z0; out[9] = z1; out[10] = z2; out[11] = 0;
	out[12] = eyex; out[13] = eyey; out[14] = eyez; out[15] = 1;
	return out;
}

function str(a) {
	return "mat4(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ", " +
		a[4] + ", " + a[5] + ", " + a[6] + ", " + a[7] + ", " +
		a[8] + ", " + a[9] + ", " + a[10] + ", " + a[11] + ", " +
		a[12] + ", " + a[13] + ", " + a[14] + ", " + a[15] + ")";
}

function frob(a) {
	var s = 0;
	for (var i = 0; i < 16; i++) { s += a[i] * a[i]; }
	return Math.sqrt(s);
}

function add(out, a, b) {
	for (var i = 0; i < 16; i++) { out[i] = a[i] + b[i]; }
	return out;
}

function subtract(out, a, b) {
	for (var i = 0; i < 16; i++) { out[i] = a[i] - b[i]; }
	return out;
}

function multiplyScalar(out, a, b) {
	for (var i = 0; i < 16; i++) { out[i] = a[i] * b; }
	return out;
}

function multiplyScalarAndAdd(out, a, b, s) {
	for (var i = 0; i < 16; i++) { out[i] = a[i] + b[i] * s; }
	return out;
}

function exactEquals(a, b) {
	for (var i = 0; i < 16; i++) {
		if (a[i] !== b[i]) { return false; }
	}
	return true;
}

function equals(a, b) {
	for (var i = 0; i < 16; i++) {
		if (Math.abs(a[i] - b[i]) > EPSILON * Math.max(1.0, Math.abs(a[i]), Math.abs(b[i]))) {
			return false;
		}
	}
	return true;
}

const mul = multiply;
const sub = subtract;

// ============================================================================
// 2. POOL
// ============================================================================
function createMat4Pool(capacity) {
	return createPool(function () {
		var m = new ARRAY_TYPE(16);
		m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
		return m;
	}, capacity, function (m) {
		m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 0;
		m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
		m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
		m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
	});
}

let _defaultPool = null;
function getDefaultPool() {
	if (_defaultPool === null) { _defaultPool = createMat4Pool(); }
	return _defaultPool;
}
function acquire() { return getDefaultPool().acquire(); }
function release(m) { getDefaultPool().release(m); }

// ============================================================================
// 3. STRUCTURE OF ARRAYS (SOA) -- 1M+ mat4 at real time
// ============================================================================
function createMat4SOA(count, Type) {
	var soa = createSOA(count, 16, Type);
	return {
		arrays: soa.arrays, buffer: soa.buffer, count: soa.count, components: 16
	};
}

function soaIdentity(out) {
	var A = out.arrays;
	for (var k = 0; k < 16; k++) {
		A[k].fill((k === 0 || k === 5 || k === 10 || k === 15) ? 1 : 0);
	}
	return out;
}

function soaZero(out) {
	for (var k = 0; k < 16; k++) { out.arrays[k].fill(0); }
	return out;
}

function soaCopy(out, a) {
	for (var k = 0; k < 16; k++) { out.arrays[k].set(a.arrays[k]); }
	return out;
}

function soaGet(out, soa, i) {
	for (var k = 0; k < 16; k++) { out[k] = soa.arrays[k][i]; }
	return out;
}

function soaSet(soa, i, m) {
	for (var k = 0; k < 16; k++) { soa.arrays[k][i] = m[k]; }
	return soa;
}

function soaToFlat(out, soa, offset) {
	offset = offset || 0;
	var n = soa.count, A = soa.arrays;
	for (var i = 0, o = offset; i < n; i++, o += 16) {
		for (var k = 0; k < 16; k++) { out[o + k] = A[k][i]; }
	}
	return out;
}

function soaFromFlat(soa, flat, offset) {
	offset = offset || 0;
	var n = soa.count, A = soa.arrays;
	for (var i = 0, o = offset; i < n; i++, o += 16) {
		for (var k = 0; k < 16; k++) { A[k][i] = flat[o + k]; }
	}
	return soa;
}

// ---- Core SOA ops ----------------------------------------------------------
function soaMultiply(out, a, b) {
	var A = a.arrays, B = b.arrays, O = out.arrays;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var a00 = A[0][i], a01 = A[1][i], a02 = A[2][i], a03 = A[3][i];
		var a10 = A[4][i], a11 = A[5][i], a12 = A[6][i], a13 = A[7][i];
		var a20 = A[8][i], a21 = A[9][i], a22 = A[10][i], a23 = A[11][i];
		var a30 = A[12][i], a31 = A[13][i], a32 = A[14][i], a33 = A[15][i];
		for (var c = 0; c < 4; c++) {
			var b0 = B[c * 4][i], b1 = B[c * 4 + 1][i], b2 = B[c * 4 + 2][i], b3 = B[c * 4 + 3][i];
			O[c * 4][i] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
			O[c * 4 + 1][i] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
			O[c * 4 + 2][i] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
			O[c * 4 + 3][i] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
		}
	}
	return out;
}

async function soaMultiplyChunked(out, a, b, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var A = a.arrays, B = b.arrays, O = out.arrays;
	var n = out.count, cc = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) {
			var a00 = A[0][i], a01 = A[1][i], a02 = A[2][i], a03 = A[3][i];
			var a10 = A[4][i], a11 = A[5][i], a12 = A[6][i], a13 = A[7][i];
			var a20 = A[8][i], a21 = A[9][i], a22 = A[10][i], a23 = A[11][i];
			var a30 = A[12][i], a31 = A[13][i], a32 = A[14][i], a33 = A[15][i];
			for (var c = 0; c < 4; c++) {
				var b0 = B[c * 4][i], b1 = B[c * 4 + 1][i], b2 = B[c * 4 + 2][i], b3 = B[c * 4 + 3][i];
				O[c * 4][i] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
				O[c * 4 + 1][i] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
				O[c * 4 + 2][i] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
				O[c * 4 + 3][i] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
			}
		}
		if (++cc >= yieldEvery) { cc = 0; await yieldToMain(); }
	}
	return out;
}

function soaInvert(out, a) {
	var A = a.arrays, O = out.arrays;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var a00 = A[0][i], a01 = A[1][i], a02 = A[2][i], a03 = A[3][i];
		var a10 = A[4][i], a11 = A[5][i], a12 = A[6][i], a13 = A[7][i];
		var a20 = A[8][i], a21 = A[9][i], a22 = A[10][i], a23 = A[11][i];
		var a30 = A[12][i], a31 = A[13][i], a32 = A[14][i], a33 = A[15][i];

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
		var inv = det ? 1.0 / det : 0;

		O[0][i] = (a11 * b11 - a12 * b10 + a13 * b09) * inv;
		O[1][i] = (a02 * b10 - a01 * b11 - a03 * b09) * inv;
		O[2][i] = (a31 * b05 - a32 * b04 + a33 * b03) * inv;
		O[3][i] = (a22 * b04 - a21 * b05 - a23 * b03) * inv;
		O[4][i] = (a12 * b08 - a10 * b11 - a13 * b07) * inv;
		O[5][i] = (a00 * b11 - a02 * b08 + a03 * b07) * inv;
		O[6][i] = (a32 * b02 - a30 * b05 - a33 * b01) * inv;
		O[7][i] = (a20 * b05 - a22 * b02 + a23 * b01) * inv;
		O[8][i] = (a10 * b10 - a11 * b08 + a13 * b06) * inv;
		O[9][i] = (a01 * b08 - a00 * b10 - a03 * b06) * inv;
		O[10][i] = (a30 * b04 - a31 * b02 + a33 * b00) * inv;
		O[11][i] = (a21 * b02 - a20 * b04 - a23 * b00) * inv;
		O[12][i] = (a11 * b07 - a10 * b09 - a12 * b06) * inv;
		O[13][i] = (a00 * b09 - a01 * b07 + a02 * b06) * inv;
		O[14][i] = (a31 * b01 - a30 * b03 - a32 * b00) * inv;
		O[15][i] = (a20 * b03 - a21 * b01 + a22 * b00) * inv;
	}
	return out;
}

async function soaInvertChunked(out, a, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var A = a.arrays, O = out.arrays;
	var n = out.count, cc = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) {
			var a00 = A[0][i], a01 = A[1][i], a02 = A[2][i], a03 = A[3][i];
			var a10 = A[4][i], a11 = A[5][i], a12 = A[6][i], a13 = A[7][i];
			var a20 = A[8][i], a21 = A[9][i], a22 = A[10][i], a23 = A[11][i];
			var a30 = A[12][i], a31 = A[13][i], a32 = A[14][i], a33 = A[15][i];

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
			var inv = det ? 1.0 / det : 0;

			O[0][i] = (a11 * b11 - a12 * b10 + a13 * b09) * inv;
			O[1][i] = (a02 * b10 - a01 * b11 - a03 * b09) * inv;
			O[2][i] = (a31 * b05 - a32 * b04 + a33 * b03) * inv;
			O[3][i] = (a22 * b04 - a21 * b05 - a23 * b03) * inv;
			O[4][i] = (a12 * b08 - a10 * b11 - a13 * b07) * inv;
			O[5][i] = (a00 * b11 - a02 * b08 + a03 * b07) * inv;
			O[6][i] = (a32 * b02 - a30 * b05 - a33 * b01) * inv;
			O[7][i] = (a20 * b05 - a22 * b02 + a23 * b01) * inv;
			O[8][i] = (a10 * b10 - a11 * b08 + a13 * b06) * inv;
			O[9][i] = (a01 * b08 - a00 * b10 - a03 * b06) * inv;
			O[10][i] = (a30 * b04 - a31 * b02 + a33 * b00) * inv;
			O[11][i] = (a21 * b02 - a20 * b04 - a23 * b00) * inv;
			O[12][i] = (a11 * b07 - a10 * b09 - a12 * b06) * inv;
			O[13][i] = (a00 * b09 - a01 * b07 + a02 * b06) * inv;
			O[14][i] = (a31 * b01 - a30 * b03 - a32 * b00) * inv;
			O[15][i] = (a20 * b03 - a21 * b01 + a22 * b00) * inv;
		}
		if (++cc >= yieldEvery) { cc = 0; await yieldToMain(); }
	}
	return out;
}

function soaTransformPoint(outPos, matrices, inPos) {
	var M = matrices.arrays;
	var ox = outPos.x, oy = outPos.y, oz = outPos.z;
	var ix = inPos.x, iy = inPos.y, iz = inPos.z;
	var n = matrices.count;
	for (var i = 0; i < n; i++) {
		var x = ix[i], y = iy[i], z = iz[i];
		ox[i] = M[0][i] * x + M[4][i] * y + M[8][i] * z + M[12][i];
		oy[i] = M[1][i] * x + M[5][i] * y + M[9][i] * z + M[13][i];
		oz[i] = M[2][i] * x + M[6][i] * y + M[10][i] * z + M[14][i];
	}
	return outPos;
}

function soaTransformPointPerspective(outPos, matrices, inPos) {
	var M = matrices.arrays;
	var ox = outPos.x, oy = outPos.y, oz = outPos.z;
	var ix = inPos.x, iy = inPos.y, iz = inPos.z;
	var n = matrices.count;
	for (var i = 0; i < n; i++) {
		var x = ix[i], y = iy[i], z = iz[i];
		var w = M[3][i] * x + M[7][i] * y + M[11][i] * z + M[15][i];
		w = w || 1.0;
		ox[i] = (M[0][i] * x + M[4][i] * y + M[8][i] * z + M[12][i]) / w;
		oy[i] = (M[1][i] * x + M[5][i] * y + M[9][i] * z + M[13][i]) / w;
		oz[i] = (M[2][i] * x + M[6][i] * y + M[10][i] * z + M[14][i]) / w;
	}
	return outPos;
}

async function soaTransformPointChunked(outPos, matrices, inPos, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var M = matrices.arrays;
	var ox = outPos.x, oy = outPos.y, oz = outPos.z;
	var ix = inPos.x, iy = inPos.y, iz = inPos.z;
	var n = matrices.count, cc = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) {
			var x = ix[i], y = iy[i], z = iz[i];
			ox[i] = M[0][i] * x + M[4][i] * y + M[8][i] * z + M[12][i];
			oy[i] = M[1][i] * x + M[5][i] * y + M[9][i] * z + M[13][i];
			oz[i] = M[2][i] * x + M[6][i] * y + M[10][i] * z + M[14][i];
		}
		if (++cc >= yieldEvery) { cc = 0; await yieldToMain(); }
	}
	return outPos;
}

function soaComposeTRS(out, positions, rotations, scales) {
	var O = out.arrays;
	var px = positions.x, py = positions.y, pz = positions.z;
	var qx = rotations.x, qy = rotations.y, qz = rotations.z, qw = rotations.w;
	var sx = scales.x, sy = scales.y, sz = scales.z;
	var n = out.count;
	for (var i = 0; i < n; i++) {
		var x = qx[i], y = qy[i], z = qz[i], w = qw[i];
		var x2 = x + x, y2 = y + y, z2 = z + z;
		var xx = x * x2, xy = x * y2, xz = x * z2;
		var yy = y * y2, yz = y * z2, zz = z * z2;
		var wx = w * x2, wy = w * y2, wz = w * z2;
		var Sx = sx[i], Sy = sy[i], Sz = sz[i];

		O[0][i] = (1 - (yy + zz)) * Sx; O[1][i] = (xy + wz) * Sx; O[2][i] = (xz - wy) * Sx; O[3][i] = 0;
		O[4][i] = (xy - wz) * Sy; O[5][i] = (1 - (xx + zz)) * Sy; O[6][i] = (yz + wx) * Sy; O[7][i] = 0;
		O[8][i] = (xz + wy) * Sz; O[9][i] = (yz - wx) * Sz; O[10][i] = (1 - (xx + yy)) * Sz; O[11][i] = 0;
		O[12][i] = px[i]; O[13][i] = py[i]; O[14][i] = pz[i]; O[15][i] = 1;
	}
	return out;
}

async function soaComposeTRSChunked(out, positions, rotations, scales, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var O = out.arrays;
	var px = positions.x, py = positions.y, pz = positions.z;
	var qx = rotations.x, qy = rotations.y, qz = rotations.z, qw = rotations.w;
	var sx = scales.x, sy = scales.y, sz = scales.z;
	var n = out.count, cc = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) {
			var x = qx[i], y = qy[i], z = qz[i], w = qw[i];
			var x2 = x + x, y2 = y + y, z2 = z + z;
			var xx = x * x2, xy = x * y2, xz = x * z2;
			var yy = y * y2, yz = y * z2, zz = z * z2;
			var wx = w * x2, wy = w * y2, wz = w * z2;
			var Sx = sx[i], Sy = sy[i], Sz = sz[i];

			O[0][i] = (1 - (yy + zz)) * Sx; O[1][i] = (xy + wz) * Sx; O[2][i] = (xz - wy) * Sx; O[3][i] = 0;
			O[4][i] = (xy - wz) * Sy; O[5][i] = (1 - (xx + zz)) * Sy; O[6][i] = (yz + wx) * Sy; O[7][i] = 0;
			O[8][i] = (xz + wy) * Sz; O[9][i] = (yz - wx) * Sz; O[10][i] = (1 - (xx + yy)) * Sz; O[11][i] = 0;
			O[12][i] = px[i]; O[13][i] = py[i]; O[14][i] = pz[i]; O[15][i] = 1;
		}
		if (++cc >= yieldEvery) { cc = 0; await yieldToMain(); }
	}
	return out;
}

function soaDecompose(outPos, outRot, outScale, mats) {
	var M = mats.arrays;
	var ox = outPos.x, oy = outPos.y, oz = outPos.z;
	var qx = outRot.x, qy = outRot.y, qz = outRot.z, qw = outRot.w;
	var sx = outScale.x, sy = outScale.y, sz = outScale.z;
	var n = mats.count;

	for (var i = 0; i < n; i++) {
		ox[i] = M[12][i]; oy[i] = M[13][i]; oz[i] = M[14][i];

		var m11 = M[0][i], m12 = M[1][i], m13 = M[2][i];
		var m21 = M[4][i], m22 = M[5][i], m23 = M[6][i];
		var m31 = M[8][i], m32 = M[9][i], m33 = M[10][i];

		var sX = Math.sqrt(m11 * m11 + m12 * m12 + m13 * m13) || 1;
		var sY = Math.sqrt(m21 * m21 + m22 * m22 + m23 * m23) || 1;
		var sZ = Math.sqrt(m31 * m31 + m32 * m32 + m33 * m33) || 1;
		sx[i] = sX; sy[i] = sY; sz[i] = sZ;

		var isx = 1 / sX, isy = 1 / sY, isz = 1 / sZ;
		var r00 = m11 * isx, r01 = m12 * isx, r02 = m13 * isx;
		var r10 = m21 * isy, r11 = m22 * isy, r12 = m23 * isy;
		var r20 = m31 * isz, r21 = m32 * isz, r22 = m33 * isz;

		var trace = r00 + r11 + r22;
		var S;

		if (trace > 0) {
			S = Math.sqrt(trace + 1.0) * 2;
			qw[i] = 0.25 * S;
			qx[i] = (r12 - r21) / S;
			qy[i] = (r20 - r02) / S;
			qz[i] = (r01 - r10) / S;
		} else if (r00 > r11 && r00 > r22) {
			S = Math.sqrt(1.0 + r00 - r11 - r22) * 2;
			qw[i] = (r12 - r21) / S;
			qx[i] = 0.25 * S;
			qy[i] = (r01 + r10) / S;
			qz[i] = (r20 + r02) / S;
		} else if (r11 > r22) {
			S = Math.sqrt(1.0 + r11 - r00 - r22) * 2;
			qw[i] = (r20 - r02) / S;
			qx[i] = (r01 + r10) / S;
			qy[i] = 0.25 * S;
			qz[i] = (r12 + r21) / S;
		} else {
			S = Math.sqrt(1.0 + r22 - r00 - r11) * 2;
			qw[i] = (r01 - r10) / S;
			qx[i] = (r20 + r02) / S;
			qy[i] = (r12 + r21) / S;
			qz[i] = 0.25 * S;
		}
	}
	return outPos;
}

const soaFromKeyframeTRS = soaComposeTRS;

// ============================================================================
// 4. PROCEDURAL -- per-instance transforms from spatial noise
// ============================================================================
function soaFillTRSFromNoise(out, positions, noiseScale, minS, maxS) {
	noiseScale = noiseScale || 1;
	minS = minS === undefined ? 0.75 : minS;
	maxS = maxS === undefined ? 1.25 : maxS;

	var O = out.arrays;
	var px = positions.x, py = positions.y, pz = positions.z;
	var n = out.count;
	var span = maxS - minS;

	for (var i = 0; i < n; i++) {
		var wx = px[i], wy = py[i], wz = pz[i];
		var gx = Math.floor(wx * noiseScale);
		var gy = Math.floor(wy * noiseScale);
		var gz = Math.floor(wz * noiseScale);

		var u1 = hash3(gx, gy, gz);
		var u2 = hash3(gx + 17, gy + 23, gz + 5);
		var u3 = hash3(gx + 3, gy + 11, gz + 29);
		var u4 = hash3(gx + 41, gy + 7, gz + 13);

		var s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
		var qx = s1 * Math.sin(2 * Math.PI * u2);
		var qy = s1 * Math.cos(2 * Math.PI * u2);
		var qz = s2 * Math.sin(2 * Math.PI * u3);
		var qw = s2 * Math.cos(2 * Math.PI * u3);
		var S = minS + u4 * span;

		var x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
		var xx = qx * x2, xy = qx * y2, xz = qx * z2;
		var yy = qy * y2, yz = qy * z2, zz = qz * z2;
		var wx2 = qw * x2, wy2 = qw * y2, wz2 = qw * z2;

		O[0][i] = (1 - (yy + zz)) * S; O[1][i] = (xy + wz2) * S; O[2][i] = (xz - wy2) * S; O[3][i] = 0;
		O[4][i] = (xy - wz2) * S; O[5][i] = (1 - (xx + zz)) * S; O[6][i] = (yz + wx2) * S; O[7][i] = 0;
		O[8][i] = (xz + wy2) * S; O[9][i] = (yz - wx2) * S; O[10][i] = (1 - (xx + yy)) * S; O[11][i] = 0;
		O[12][i] = wx; O[13][i] = wy; O[14][i] = wz; O[15][i] = 1;
	}
	return out;
}

async function soaFillTRSFromNoiseChunked(out, positions, noiseScale, minS, maxS, chunkSize, yieldEvery) {
	noiseScale = noiseScale || 1;
	minS = minS === undefined ? 0.75 : minS;
	maxS = maxS === undefined ? 1.25 : maxS;
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;

	var O = out.arrays;
	var px = positions.x, py = positions.y, pz = positions.z;
	var n = out.count, cc = 0;
	var span = maxS - minS;

	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) {
			var wx = px[i], wy = py[i], wz = pz[i];
			var gx = Math.floor(wx * noiseScale);
			var gy = Math.floor(wy * noiseScale);
			var gz = Math.floor(wz * noiseScale);

			var u1 = hash3(gx, gy, gz);
			var u2 = hash3(gx + 17, gy + 23, gz + 5);
			var u3 = hash3(gx + 3, gy + 11, gz + 29);
			var u4 = hash3(gx + 41, gy + 7, gz + 13);

			var s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
			var qx = s1 * Math.sin(2 * Math.PI * u2);
			var qy = s1 * Math.cos(2 * Math.PI * u2);
			var qz = s2 * Math.sin(2 * Math.PI * u3);
			var qw = s2 * Math.cos(2 * Math.PI * u3);
			var S = minS + u4 * span;

			var x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
			var xx = qx * x2, xy = qx * y2, xz = qx * z2;
			var yy = qy * y2, yz = qy * z2, zz = qz * z2;
			var wx2 = qw * x2, wy2 = qw * y2, wz2 = qw * z2;

			O[0][i] = (1 - (yy + zz)) * S; O[1][i] = (xy + wz2) * S; O[2][i] = (xz - wy2) * S; O[3][i] = 0;
			O[4][i] = (xy - wz2) * S; O[5][i] = (1 - (xx + zz)) * S; O[6][i] = (yz + wx2) * S; O[7][i] = 0;
			O[8][i] = (xz + wy2) * S; O[9][i] = (yz - wx2) * S; O[10][i] = (1 - (xx + yy)) * S; O[11][i] = 0;
			O[12][i] = wx; O[13][i] = wy; O[14][i] = wz; O[15][i] = 1;
		}
		if (++cc >= yieldEvery) { cc = 0; await yieldToMain(); }
	}
	return out;
}

// ============================================================================
// 5. RENDERING / CAMERA / PROJECTION
// ============================================================================
function worldToView(out, cameraWorld) {
	return invert(out, cameraWorld);
}

function viewToWorld(out, view) {
	return invert(out, view);
}

function fromCamera(out, eye, center, up) {
	return lookAt(out, eye, center, up);
}

function fromPerspectiveFov(out, fovY, aspect, near, far) {
	return perspectiveNO(out, fovY, aspect, near, far);
}

function fromOrthoBounds(out, minX, maxX, minY, maxY, near, far) {
	return orthoNO(out, minX, maxX, minY, maxY, near, far);
}

function translateCameraInPlace(out, world, dx, dy, dz) {
	if (out !== world) { copy(out, world); }
	out[12] += dx; out[13] += dy; out[14] += dz;
	return out;
}

function fromMat3Translation(out, m3, v) {
	out[0] = m3[0]; out[1] = m3[1]; out[2] = m3[2]; out[3] = 0;
	out[4] = m3[3]; out[5] = m3[4]; out[6] = m3[5]; out[7] = 0;
	out[8] = m3[6]; out[9] = m3[7]; out[10] = m3[8]; out[11] = 0;
	out[12] = v[0]; out[13] = v[1]; out[14] = v[2]; out[15] = 1;
	return out;
}

// ============================================================================
// 6. ANIMATION -- TRS interpolation and blending
// ============================================================================
// Frame-rate independent critically-damped spring on the translation row.
// Writes into out (copy of current), updates vel[0..2] in place.
function springDampTranslation(out, current, target, vel, smoothTime, dt, maxSpeed) {
	copy(out, current);
	if (smoothTime < 0.0001) { smoothTime = 0.0001; }
	if (maxSpeed === undefined) { maxSpeed = Infinity; }

	var omega = 2 / smoothTime;
	var x = omega * dt;
	var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
	var maxChange = maxSpeed * smoothTime;

	for (var i = 0; i < 3; i++) {
		var c = current[12 + i];
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
		out[12 + i] = output;
	}
	return out;
}

// Blend two TRS matrices: quaternion slerp (shortest arc) + lerp position/scale.
// Uses dedicated module temporaries (zero per-call allocation, no overwrite bug).
function blendTRS(out, a, b, t) {
	decompose(_quatA, _posA, _scaleA, a);
	decompose(_quatB, _posB, _scaleB, b);

	var ax = _quatA[0], ay = _quatA[1], az = _quatA[2], aw = _quatA[3];
	var bx = _quatB[0], by = _quatB[1], bz = _quatB[2], bw = _quatB[3];

	var cosom = ax * bx + ay * by + az * bz + aw * bw;
	if (cosom < 0) {
		bx = -bx; by = -by; bz = -bz; bw = -bw;
		cosom = -cosom;
	}

	var s0, s1;
	if (1 - cosom > EPSILON) {
		var omega = Math.acos(cosom);
		var sinom = Math.sin(omega);
		s0 = Math.sin((1 - t) * omega) / sinom;
		s1 = Math.sin(t * omega) / sinom;
	} else {
		s0 = 1 - t;
		s1 = t;
	}

	_quatOut[0] = s0 * ax + s1 * bx;
	_quatOut[1] = s0 * ay + s1 * by;
	_quatOut[2] = s0 * az + s1 * bz;
	_quatOut[3] = s0 * aw + s1 * bw;

	_posOut[0] = _posA[0] + t * (_posB[0] - _posA[0]);
	_posOut[1] = _posA[1] + t * (_posB[1] - _posA[1]);
	_posOut[2] = _posA[2] + t * (_posB[2] - _posA[2]);

	_scaleOut[0] = _scaleA[0] + t * (_scaleB[0] - _scaleA[0]);
	_scaleOut[1] = _scaleA[1] + t * (_scaleB[1] - _scaleA[1]);
	_scaleOut[2] = _scaleA[2] + t * (_scaleB[2] - _scaleA[2]);

	return fromRotationTranslationScale(out, _quatOut, _posOut, _scaleOut);
}

// ============================================================================
// 7. IK / NATURAL MOTION
// ============================================================================
// out = parent * local(TRS). Uses module temporaries (zero allocation).
function fromJointTransform(out, parent, localPos, localRot, localScl) {
	var s = localScl;
	if (!s) {
		_vec3Tmp[0] = 1; _vec3Tmp[1] = 1; _vec3Tmp[2] = 1;
		s = _vec3Tmp;
	}
	fromRotationTranslationScale(_tmpMat4, localRot, localPos, s);
	return multiply(out, parent, _tmpMat4);
}

// Batched: out[i] = parent * localTRS[i]. parent is a single flat mat4.
function soaFromJointTransform(out, parent, localPos, localRot, localScale) {
	var O = out.arrays;
	var px = localPos.x, py = localPos.y, pz = localPos.z;
	var qx = localRot.x, qy = localRot.y, qz = localRot.z, qw = localRot.w;
	var hasScale = localScale != null;
	var sx = hasScale ? localScale.x : null;
	var sy = hasScale ? localScale.y : null;
	var sz = hasScale ? localScale.z : null;

	var P = parent;
	var n = out.count;

	for (var i = 0; i < n; i++) {
		var x = qx[i], y = qy[i], z = qz[i], w = qw[i];
		var x2 = x + x, y2 = y + y, z2 = z + z;
		var xx = x * x2, xy = x * y2, xz = x * z2;
		var yy = y * y2, yz = y * z2, zz = z * z2;
		var wx = w * x2, wy = w * y2, wz = w * z2;

		var Sx = hasScale ? sx[i] : 1;
		var Sy = hasScale ? sy[i] : 1;
		var Sz = hasScale ? sz[i] : 1;

		// Local TRS columns (column-major).
		var l00 = (1 - (yy + zz)) * Sx, l01 = (xy + wz) * Sx, l02 = (xz - wy) * Sx;
		var l10 = (xy - wz) * Sy, l11 = (1 - (xx + zz)) * Sy, l12 = (yz + wx) * Sy;
		var l20 = (xz + wy) * Sz, l21 = (yz - wx) * Sz, l22 = (1 - (xx + yy)) * Sz;
		var l30 = px[i], l31 = py[i], l32 = pz[i];

		// out = parent * local (per column).
		O[0][i] = P[0] * l00 + P[4] * l01 + P[8] * l02;
		O[1][i] = P[1] * l00 + P[5] * l01 + P[9] * l02;
		O[2][i] = P[2] * l00 + P[6] * l01 + P[10] * l02;
		O[3][i] = P[3] * l00 + P[7] * l01 + P[11] * l02;

		O[4][i] = P[0] * l10 + P[4] * l11 + P[8] * l12;
		O[5][i] = P[1] * l10 + P[5] * l11 + P[9] * l12;
		O[6][i] = P[2] * l10 + P[6] * l11 + P[10] * l12;
		O[7][i] = P[3] * l10 + P[7] * l11 + P[11] * l12;

		O[8][i] = P[0] * l20 + P[4] * l21 + P[8] * l22;
		O[9][i] = P[1] * l20 + P[5] * l21 + P[9] * l22;
		O[10][i] = P[2] * l20 + P[6] * l21 + P[10] * l22;
		O[11][i] = P[3] * l20 + P[7] * l21 + P[11] * l22;

		O[12][i] = P[0] * l30 + P[4] * l31 + P[8] * l32 + P[12];
		O[13][i] = P[1] * l30 + P[5] * l31 + P[9] * l32 + P[13];
		O[14][i] = P[2] * l30 + P[6] * l31 + P[10] * l32 + P[14];
		O[15][i] = P[3] * l30 + P[7] * l31 + P[11] * l32 + P[15];
	}
	return out;
}

// ============================================================================
// 8. ORBITAL -- world matrices from orbital elements
// ============================================================================
function fromOrbitalElements(out, a, e, M, inc, Om, om) {
	var E = keplerSolve(M, e);
	var xp = a * (Math.cos(E) - e);
	var yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

	var cw = Math.cos(om), sw = Math.sin(om);
	var ci = Math.cos(inc), si = Math.sin(inc);
	var cO = Math.cos(Om), sO = Math.sin(Om);

	var r00 = cO * cw - sO * sw * ci;
	var r01 = -cO * sw - sO * cw * ci;
	var r02 = sO * si;
	var r10 = sO * cw + cO * sw * ci;
	var r11 = -sO * sw + cO * cw * ci;
	var r12 = -cO * si;
	var r20 = sw * si;
	var r21 = cw * si;
	var r22 = ci;

	out[0] = r00; out[1] = r10; out[2] = r20; out[3] = 0;
	out[4] = r01; out[5] = r11; out[6] = r21; out[7] = 0;
	out[8] = r02; out[9] = r12; out[10] = r22; out[11] = 0;
	out[12] = r00 * xp + r01 * yp;
	out[13] = r10 * xp + r11 * yp;
	out[14] = r20 * xp + r21 * yp;
	out[15] = 1;
	return out;
}

function soaFromOrbitalElements(out, semiMajorAxes, eccentricities, meanAnomalies, inclinations, ascendingNodes, argPeriapses) {
	var O = out.arrays;
	var n = out.count;

	for (var i = 0; i < n; i++) {
		var a = semiMajorAxes[i], e = eccentricities[i], M = meanAnomalies[i];
		var inc = inclinations[i], Om = ascendingNodes[i], om = argPeriapses[i];

		var E = keplerSolve(M, e);
		var xp = a * (Math.cos(E) - e);
		var yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

		var cw = Math.cos(om), sw = Math.sin(om);
		var ci = Math.cos(inc), si = Math.sin(inc);
		var cO = Math.cos(Om), sO = Math.sin(Om);

		var r00 = cO * cw - sO * sw * ci;
		var r01 = -cO * sw - sO * cw * ci;
		var r02 = sO * si;
		var r10 = sO * cw + cO * sw * ci;
		var r11 = -sO * sw + cO * cw * ci;
		var r12 = -cO * si;
		var r20 = sw * si;
		var r21 = cw * si;
		var r22 = ci;

		O[0][i] = r00; O[1][i] = r10; O[2][i] = r20; O[3][i] = 0;
		O[4][i] = r01; O[5][i] = r11; O[6][i] = r21; O[7][i] = 0;
		O[8][i] = r02; O[9][i] = r12; O[10][i] = r22; O[11][i] = 0;
		O[12][i] = r00 * xp + r01 * yp;
		O[13][i] = r10 * xp + r11 * yp;
		O[14][i] = r20 * xp + r21 * yp;
		O[15][i] = 1;
	}
	return out;
}

async function soaFromOrbitalElementsChunked(out, semiMajorAxes, eccentricities, meanAnomalies, inclinations, ascendingNodes, argPeriapses, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var O = out.arrays;
	var n = out.count, cc = 0;

	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) {
			var a = semiMajorAxes[i], e = eccentricities[i], M = meanAnomalies[i];
			var inc = inclinations[i], Om = ascendingNodes[i], om = argPeriapses[i];

			var E = keplerSolve(M, e);
			var xp = a * (Math.cos(E) - e);
			var yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

			var cw = Math.cos(om), sw = Math.sin(om);
			var ci = Math.cos(inc), si = Math.sin(inc);
			var cO = Math.cos(Om), sO = Math.sin(Om);

			var r00 = cO * cw - sO * sw * ci;
			var r01 = -cO * sw - sO * cw * ci;
			var r02 = sO * si;
			var r10 = sO * cw + cO * sw * ci;
			var r11 = -sO * sw + cO * cw * ci;
			var r12 = -cO * si;
			var r20 = sw * si;
			var r21 = cw * si;
			var r22 = ci;

			O[0][i] = r00; O[1][i] = r10; O[2][i] = r20; O[3][i] = 0;
			O[4][i] = r01; O[5][i] = r11; O[6][i] = r21; O[7][i] = 0;
			O[8][i] = r02; O[9][i] = r12; O[10][i] = r22; O[11][i] = 0;
			O[12][i] = r00 * xp + r01 * yp;
			O[13][i] = r10 * xp + r11 * yp;
			O[14][i] = r20 * xp + r21 * yp;
			O[15][i] = 1;
		}
		if (++cc >= yieldEvery) { cc = 0; await yieldToMain(); }
	}
	return out;
}

// ============================================================================
// 9. SCALE / FLOATING ORIGIN
// ============================================================================
function subtractTranslation(out, m, origin) {
	copy(out, m);
	out[12] -= origin[0];
	out[13] -= origin[1];
	out[14] -= origin[2];
	return out;
}

function soaToRelative(out, a, originX, originY, originZ) {
	var A = a.arrays, O = out.arrays;
	var n = out.count;
	for (var k = 0; k < 16; k++) { O[k].set(A[k]); }
	var o12 = O[12], o13 = O[13], o14 = O[14];
	for (var i = 0; i < n; i++) {
		o12[i] -= originX;
		o13[i] -= originY;
		o14[i] -= originZ;
	}
	return out;
}

function fromWorldBoundsNDC(out, minX, minY, minZ, maxX, maxY, maxZ) {
	var w = (maxX - minX) || 1;
	var h = (maxY - minY) || 1;
	var d = (maxZ - minZ) || 1;
	out[0] = 2 / w; out[1] = 0; out[2] = 0; out[3] = 0;
	out[4] = 0; out[5] = 2 / h; out[6] = 0; out[7] = 0;
	out[8] = 0; out[9] = 0; out[10] = -2 / d; out[11] = 0;
	out[12] = -(maxX + minX) / w;
	out[13] = -(maxY + minY) / h;
	out[14] = -(maxZ + minZ) / d;
	out[15] = 1;
	return out;
}

// ============================================================================
// 10. CHUNKED ASYNC FOR-EACH
// ============================================================================
async function soaForEachChunked(out, a, callback, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var n = out.count, cc = 0;
	for (var start = 0; start < n; start += chunkSize) {
		var end = Math.min(start + chunkSize, n);
		for (var i = start; i < end; i++) { callback(i, a, out); }
		if (++cc >= yieldEvery) { cc = 0; await yieldToMain(); }
	}
	return out;
}

// ============================================================================
// 11. EXPORTS
// ============================================================================
export {
	// foundation constants
	EPSILON, ARRAY_TYPE, CHUNK_SIZE, CHUNK_YIELD_EVERY,
	// flat API
	create, clone, copy, fromValues, set, identity, transpose, invert, adjoint,
	determinant, multiply, translate, scale, rotate, rotateX, rotateY, rotateZ,
	fromTranslation, fromScaling, fromRotation, fromXRotation, fromYRotation,
	fromZRotation, fromRotationTranslation, fromQuat2, getTranslation, getScaling,
	getRotation, decompose, fromRotationTranslationScale,
	fromRotationTranslationScaleOrigin, fromQuat, frustum, perspective,
	perspectiveNO, perspectiveZO, perspectiveFromFieldOfView, ortho, orthoNO,
	orthoZO, lookAt, targetTo, str, frob, add, subtract, multiplyScalar,
	multiplyScalarAndAdd, exactEquals, equals,
	// aliases
	mul, sub,
	// pool
	createMat4Pool, acquire, release,
	// SOA
	createMat4SOA, soaIdentity, soaZero, soaCopy, soaGet, soaSet, soaToFlat,
	soaFromFlat, soaMultiply, soaInvert, soaTransformPoint,
	soaTransformPointPerspective, soaComposeTRS, soaDecompose, soaFromKeyframeTRS,
	// chunked async
	soaMultiplyChunked, soaInvertChunked, soaTransformPointChunked,
	soaComposeTRSChunked, soaForEachChunked,
	// procedural
	soaFillTRSFromNoise, soaFillTRSFromNoiseChunked,
	// rendering / camera / projection
	worldToView, viewToWorld, fromCamera, fromPerspectiveFov, fromOrthoBounds,
	translateCameraInPlace, fromMat3Translation,
	// animation
	springDampTranslation, blendTRS,
	// IK / natural motion
	fromJointTransform, soaFromJointTransform,
	// orbital
	fromOrbitalElements, soaFromOrbitalElements, soaFromOrbitalElementsChunked,
	// scale / floating origin
	subtractTranslation, soaToRelative, fromWorldBoundsNDC
};

export default {
	create, clone, copy, fromValues, set, identity, transpose, invert, adjoint,
	determinant, multiply, translate, scale, rotate, rotateX, rotateY, rotateZ,
	fromTranslation, fromScaling, fromRotation, fromXRotation, fromYRotation,
	fromZRotation, fromRotationTranslation, fromQuat2, getTranslation, getScaling,
	getRotation, decompose, fromRotationTranslationScale,
	fromRotationTranslationScaleOrigin, fromQuat, frustum, perspective,
	perspectiveNO, perspectiveZO, perspectiveFromFieldOfView, ortho, orthoNO,
	orthoZO, lookAt, targetTo, str, frob, add, subtract, multiplyScalar,
	multiplyScalarAndAdd, exactEquals, equals,
	mul, sub,
	createMat4Pool, acquire, release,
	createMat4SOA, soaIdentity, soaZero, soaCopy, soaGet, soaSet, soaToFlat,
	soaFromFlat, soaMultiply, soaInvert, soaTransformPoint,
	soaTransformPointPerspective, soaComposeTRS, soaDecompose, soaFromKeyframeTRS,
	soaMultiplyChunked, soaInvertChunked, soaTransformPointChunked,
	soaComposeTRSChunked, soaForEachChunked,
	soaFillTRSFromNoise, soaFillTRSFromNoiseChunked,
	worldToView, viewToWorld, fromCamera, fromPerspectiveFov, fromOrthoBounds,
	translateCameraInPlace, fromMat3Translation,
	springDampTranslation, blendTRS,
	fromJointTransform, soaFromJointTransform,
	fromOrbitalElements, soaFromOrbitalElements, soaFromOrbitalElementsChunked,
	subtractTranslation, soaToRelative, fromWorldBoundsNDC
};