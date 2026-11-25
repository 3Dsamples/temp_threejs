// File number : 005-demo
// File : 005_mat2_demo.js
// Description : 20-example real-time showcase for src/math/005_mat2.js (with
//               002_vec2 / 003_vec3 / 004_vec4 support). Three.js r185 scene,
//               native ES modules (no Vite / no Vue / no client build).
//               EVERY vector / matrix computation uses the provided glMatrix-
//               compatible modules -- Three.js built-in Vector/Matrix classes
//               are never used for math, only raw numbers are handed to the
//               renderer. All animated examples run CONTINUOUS CYCLE motion.
//
// CORRECTIONS APPLIED (all 20 examples preserved):
//   1. AMOUNT slider (base instance count) + MULTIPLIER slider (x1..x4) added.
//      Effective count = CN(base) = base * (amountBase / 2048) * amountMult.
//   2. Every mode count literal now flows through CN() and grid dimensions are
//      derived from the live count (no more hard-coded 32/64/72/80 divisors).
//   3. Global controls separated from per-mode controls (ui.modeBox) so
//      switching examples no longer destroys the amount / speed sliders.
//   4. DOM classes + data attributes now match 004_mat2_demo.css exactly
//      (.mat2-demo-panel[data-mode], .mat2-amount-group[data-mult],
//       .mat2-amount-head, .mat2-mult-badge, .mat2-amount-row, .mat2-mult-row,
//       .mat2-mult-slider, .mat2-mult-ticks, .mat2-demo-value).
//   5. Amount rows avoid inline "grid-template-columns" so the stylesheet's
//      generic row selector cannot override the amount-group layout.
//   6. setMode() is defensive; disposeGroup() de-duplicates shared resources.
//   7. Heavy benchmark / orbit / star counts are clamped for mobile safety.
// License : MIT

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as Vec2 from "./math/002_vec2.js";
import * as Vec3 from "./math/003_vec3.js";
import * as Vec4 from "./math/004_vec4.js";
import * as Mat2 from "./math/005_mat2.js";

const HOST = globalThis.__MAT2_DEMO_HOST__ || {};
const container = HOST.container || document.body;
const TAU = Math.PI * 2;

const params = {
	speed: 1.0,
	mode: "rotField",
	amountBase: 2048,
	amountMult: 1
};

const state = { time: 0, frame: 0, infoTimer: 0, ready: false };

// Effective instance count for any base amount.
function CN(base) {
	return Math.max(8, Math.round(base * (params.amountBase / 2048) * params.amountMult));
}

// Grid helpers derived from the live count (never hard-coded).
function gridCols(n, aspect) {
	return Math.max(2, Math.round(Math.sqrt(n * (aspect || 1))));
}
function gridRows(n, cols) {
	return Math.max(1, Math.ceil(n / cols));
}
function gridDiv(rows) {
	return (rows - 1) || 1;
}

let renderer, scene, camera, controls, clock;
let modeGroup = null, modeHandle = null;
const ui = {
	panel: null, select: null, globalBox: null, modeBox: null,
	status: null, info: null, amountGroup: null, amountBadge: null, api: null
};

const T2a = Vec2.create();
const M2a = Mat2.create(), M2b = Mat2.create(), M2c = Mat2.create();
const D4 = new Float32Array(4);

function fract(x) { return x - Math.floor(x); }
function tri(x) { const f = fract(x); return f < 0.5 ? f * 2 : 2 - f * 2; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function ramp(n, col, j) {
	const t = clamp01(n);
	col[j] = 0.12 + 0.88 * t * t;
	col[j + 1] = 0.22 + 0.72 * t;
	col[j + 2] = 1.0 - 0.72 * t;
}

function hsl(h, s, l, col, j) {
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const f = function (t) {
		t = fract(t);
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	col[j] = f(h + 1 / 3); col[j + 1] = f(h); col[j + 2] = f(h - 1 / 3);
}

function makePoints(n, size, additive) {
	const geo = new THREE.BufferGeometry();
	const pos = new Float32Array(n * 3);
	const col = new Float32Array(n * 3);
	const pa = new THREE.BufferAttribute(pos, 3); pa.setUsage(THREE.DynamicDrawUsage);
	const ca = new THREE.BufferAttribute(col, 3); ca.setUsage(THREE.DynamicDrawUsage);
	geo.setAttribute("position", pa); geo.setAttribute("color", ca);
	const mat = new THREE.PointsMaterial({
		size: size, vertexColors: true, transparent: true, opacity: 0.95,
		depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
	});
	const points = new THREE.Points(geo, mat);
	points.frustumCulled = false;
	return { geo, mat, points, pos, col, n };
}

function makeLines(nSeg, additive) {
	const geo = new THREE.BufferGeometry();
	const pos = new Float32Array(nSeg * 6);
	const col = new Float32Array(nSeg * 6);
	const pa = new THREE.BufferAttribute(pos, 3); pa.setUsage(THREE.DynamicDrawUsage);
	const ca = new THREE.BufferAttribute(col, 3); ca.setUsage(THREE.DynamicDrawUsage);
	geo.setAttribute("position", pa); geo.setAttribute("color", ca);
	const mat = new THREE.LineBasicMaterial({
		vertexColors: true, transparent: true, opacity: 0.95,
		depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
	});
	const line = new THREE.LineSegments(geo, mat);
	line.frustumCulled = false;
	return { geo, mat, line, pos, col, nSeg };
}

function flushP(h) { h.geo.attributes.position.needsUpdate = true; h.geo.attributes.color.needsUpdate = true; }
function flushL(h) { h.geo.attributes.position.needsUpdate = true; h.geo.attributes.color.needsUpdate = true; }

function disposeGroup(g) {
	const seenGeo = new Set();
	const seenMat = new Set();
	g.traverse(function (o) {
		if (o.geometry && !seenGeo.has(o.geometry)) {
			seenGeo.add(o.geometry);
			o.geometry.dispose();
		}
		if (o.material) {
			const list = Array.isArray(o.material) ? o.material : [o.material];
			for (let i = 0; i < list.length; i++) {
				if (list[i] && !seenMat.has(list[i])) {
					seenMat.add(list[i]);
					list[i].dispose();
				}
			}
		}
	});
	g.clear();
}

// ============================================================================
// 20 EXAMPLES
// ============================================================================
const MODES = {};

// 01 -- SOA rotation field (soaFillFromRotations + soaTransformVec2)
MODES.rotField = function (group) {
	const N = CN(2048);
	const COLS = gridCols(N, 16 / 9);
	const ROWS = gridRows(N, COLS);
	const L = 0.34;
	const hp = makeLines(N, true);
	const cx = new Float32Array(N), cy = new Float32Array(N);
	const angles = new Float32Array(N);
	const localA = Vec2.createVec2SOA(N), localB = Vec2.createVec2SOA(N);
	const outA = Vec2.createVec2SOA(N), outB = Vec2.createVec2SOA(N);
	const rotSOA = Mat2.createMat2SOA(N);
	for (let i = 0; i < N; i++) {
		cx[i] = ((i % COLS) / (COLS - 1)) * 16 - 8;
		cy[i] = (Math.floor(i / COLS) / gridDiv(ROWS)) * 9 - 4.5;
		localA.x[i] = -L; localA.y[i] = 0;
		localB.x[i] = L; localB.y[i] = 0;
	}
	group.add(hp.line);
	return {
		count: N,
		update: function (dt, t) {
			for (let i = 0; i < N; i++) angles[i] = t * 0.6 + Math.sin(t * 0.8 + i * 0.013) * 1.4;
			Mat2.soaFillFromRotations(rotSOA, angles);
			Mat2.soaTransformVec2(outA.x, outA.y, rotSOA, localA);
			Mat2.soaTransformVec2(outB.x, outB.y, rotSOA, localB);
			for (let i = 0; i < N; i++) {
				const j = i * 6;
				hp.pos[j] = cx[i] + outA.x[i]; hp.pos[j + 1] = cy[i] + outA.y[i]; hp.pos[j + 2] = 0;
				hp.pos[j + 3] = cx[i] + outB.x[i]; hp.pos[j + 4] = cy[i] + outB.y[i]; hp.pos[j + 5] = 0;
				ramp(fract(angles[i] / TAU), hp.col, j);
				hp.col[j + 3] = hp.col[j]; hp.col[j + 4] = hp.col[j + 1]; hp.col[j + 5] = hp.col[j + 2];
			}
			flushL(hp);
		},
		info: function () {
			return "soaFillFromRotations + soaTransformVec2\n" + N + " instances, continuous spin cycle";
		}
	};
};

// 02 -- anisotropic compose (soaFillAnisoFromVoronoi + soaMultiply)
MODES.aniso = function (group) {
	const N = CN(1024);
	const SIDE = gridCols(N, 1);
	const ROWS = gridRows(N, SIDE);
	const L = 0.42;
	const hp = makeLines(N * 2, true);
	const cent = Vec2.createVec2SOA(N);
	const l1 = Vec2.createVec2SOA(N), l2 = Vec2.createVec2SOA(N);
	const l3 = Vec2.createVec2SOA(N), l4 = Vec2.createVec2SOA(N);
	const o1 = Vec2.createVec2SOA(N), o2 = Vec2.createVec2SOA(N);
	const o3 = Vec2.createVec2SOA(N), o4 = Vec2.createVec2SOA(N);
	const rotSOA = Mat2.createMat2SOA(N), vorSOA = Mat2.createMat2SOA(N);
	const tmpSOA = Mat2.createMat2SOA(N), outSOA = Mat2.createMat2SOA(N);
	const angles = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		cent.x[i] = ((i % SIDE) / (SIDE - 1)) * 14 - 7;
		cent.y[i] = (Math.floor(i / SIDE) / gridDiv(ROWS)) * 14 - 7;
		l1.x[i] = -L; l1.y[i] = 0; l2.x[i] = L; l2.y[i] = 0;
		l3.x[i] = 0; l3.y[i] = -L; l4.x[i] = 0; l4.y[i] = L;
	}
	Mat2.soaFillAnisoFromVoronoi(vorSOA, cent, 0.35);
	group.add(hp.line);
	return {
		count: N,
		update: function (dt, t) {
			const s = 1 + 0.55 * Math.sin(t * 0.9);
			for (let i = 0; i < N; i++) angles[i] = t * 0.35 + i * 0.0021;
			Mat2.soaFillFromRotations(rotSOA, angles);
			Mat2.soaMultiplyScalar(tmpSOA, vorSOA, s);
			Mat2.soaMultiply(outSOA, rotSOA, tmpSOA);
			Mat2.soaTransformVec2(o1.x, o1.y, outSOA, l1);
			Mat2.soaTransformVec2(o2.x, o2.y, outSOA, l2);
			Mat2.soaTransformVec2(o3.x, o3.y, outSOA, l3);
			Mat2.soaTransformVec2(o4.x, o4.y, outSOA, l4);
			for (let i = 0; i < N; i++) {
				const j = i * 12;
				hp.pos[j] = cent.x[i] + o1.x[i]; hp.pos[j + 1] = cent.y[i] + o1.y[i]; hp.pos[j + 2] = 0;
				hp.pos[j + 3] = cent.x[i] + o2.x[i]; hp.pos[j + 4] = cent.y[i] + o2.y[i]; hp.pos[j + 5] = 0;
				hp.pos[j + 6] = cent.x[i] + o3.x[i]; hp.pos[j + 7] = cent.y[i] + o3.y[i]; hp.pos[j + 8] = 0;
				hp.pos[j + 9] = cent.x[i] + o4.x[i]; hp.pos[j + 10] = cent.y[i] + o4.y[i]; hp.pos[j + 11] = 0;
				ramp(clamp01((s - 0.45) / 1.1), hp.col, j);
				for (let k = 3; k < 12; k += 3) {
					hp.col[j + k] = hp.col[j]; hp.col[j + k + 1] = hp.col[j + 1]; hp.col[j + k + 2] = hp.col[j + 2];
				}
			}
			flushL(hp);
		},
		info: function () {
			return "voronoi aniso scale x rotation (soaMultiply)\n" + N + " crosses, scale breathes: 1+0.55*sin(t)";
		}
	};
};

// 03 -- determinant heat map (soaDeterminant + soaCountSingular)
MODES.detHeat = function (group) {
	const N = CN(4096);
	const SIDE = gridCols(N, 1);
	const ROWS = gridRows(N, SIDE);
	const hp = makePoints(N, 0.07, true);
	const rotSOA = Mat2.createMat2SOA(N), sclSOA = Mat2.createMat2SOA(N), mSOA = Mat2.createMat2SOA(N);
	const det = new Float32Array(N);
	const angles = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		const j = i * 3;
		hp.pos[j] = ((i % SIDE) / (SIDE - 1)) * 14 - 7;
		hp.pos[j + 1] = (Math.floor(i / SIDE) / gridDiv(ROWS)) * 14 - 7;
		hp.pos[j + 2] = 0;
		angles[i] = Vec2.valueNoise2D(hp.pos[j] * 0.2, hp.pos[j + 1] * 0.2) * TAU;
	}
	Mat2.soaFillFromRotations(rotSOA, angles);
	let singular = 0;
	group.add(hp.points);
	return {
		count: N,
		update: function (dt, t) {
			const sx = 0.2 + 1.2 * Math.sin(t * 0.7);
			const sy = 0.2 + 1.2 * Math.cos(t * 0.7);
			Mat2.soaFill(sclSOA, sx, 0, 0, sy);
			Mat2.soaMultiply(mSOA, rotSOA, sclSOA);
			Mat2.soaDeterminant(det, mSOA);
			for (let i = 0; i < N; i++) {
				const j = i * 3;
				hp.pos[j + 2] = det[i] * 0.6;
				const v = clamp01((det[i] + 2) / 4);
				hp.col[j] = 1 - v; hp.col[j + 1] = v; hp.col[j + 2] = 0.25 + 0.5 * (1 - Math.abs(det[i]) / 2);
			}
			if ((state.frame & 31) === 0) singular = Mat2.soaCountSingular(mSOA);
			flushP(hp);
		},
		info: function () {
			return "soaDeterminant heat map (red = neg det)\n" + N + " matrices, singular = " + singular;
		}
	};
};

// 04 -- shear cycle (fromShear)
MODES.shear = function (group) {
	const N = CN(4096);
	const SIDE = gridCols(N, 1);
	const ROWS = gridRows(N, SIDE);
	const hp = makePoints(N, 0.06, true);
	const bx = new Float32Array(N), by = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		bx[i] = ((i % SIDE) / (SIDE - 1)) * 10 - 5;
		by[i] = (Math.floor(i / SIDE) / gridDiv(ROWS)) * 10 - 5;
	}
	group.add(hp.points);
	return {
		count: N,
		update: function (dt, t) {
			const kx = 0.65 * Math.sin(t * 0.8), ky = 0.4 * Math.sin(t * 0.53 + 1);
			Mat2.fromShear(M2a, kx, ky);
			const m0 = M2a[0], m1 = M2a[1], m2 = M2a[2], m3 = M2a[3];
			for (let i = 0; i < N; i++) {
				const j = i * 3;
				hp.pos[j] = m0 * bx[i] + m2 * by[i];
				hp.pos[j + 1] = m1 * bx[i] + m3 * by[i];
				hp.pos[j + 2] = 0;
				ramp(clamp01((kx + 0.65) / 1.3), hp.col, j);
			}
			flushP(hp);
		},
		info: function () {
			return "fromShear(kx,ky) on " + N + " pts\nkx,ky oscillate (continuous cycle)";
		}
	};
};

// 05 -- reflection states (fromReflection)
MODES.reflect = function (group) {
	const N = CN(512);
	const base = makePoints(N, 0.09, false);
	const mov = makePoints(N, 0.09, true);
	const bx = new Float32Array(N), by = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		const u = i / N;
		if (u < 0.4) { bx[i] = -1; by[i] = (u / 0.4) * 4 - 2; }
		else if (u < 0.7) { bx[i] = ((u - 0.4) / 0.3) * 2 - 1; by[i] = 2; }
		else { bx[i] = ((u - 0.7) / 0.3) * 1.4 - 1; by[i] = 0.4; }
		const j = i * 3;
		base.pos[j] = bx[i] - 3.4; base.pos[j + 1] = by[i]; base.pos[j + 2] = 0;
		base.col[j] = 0.35; base.col[j + 1] = 0.4; base.col[j + 2] = 0.45;
	}
	flushP(base);
	group.add(base.points); group.add(mov.points);
	return {
		count: N,
		update: function (dt, t) {
			const fx = Math.sin(t * 0.9) > 0, fy = Math.sin(t * 0.45) > 0;
			Mat2.fromReflection(M2a, fx, fy);
			const hue = fract(t * 0.1);
			for (let i = 0; i < N; i++) {
				const j = i * 3;
				mov.pos[j] = M2a[0] * bx[i] + M2a[2] * by[i] + 3.4;
				mov.pos[j + 1] = M2a[1] * bx[i] + M2a[3] * by[i];
				mov.pos[j + 2] = 0;
				hsl(hue, 0.8, 0.6, mov.col, j);
			}
			flushP(mov);
			this._fx = fx; this._fy = fy;
		},
		info: function () {
			return "fromReflection cycles 4 mirror states\nflipX=" + this._fx + " flipY=" + this._fy + " | " + N + " pts";
		}
	};
};

// 06 -- aspect fit breathing (fromAspectFit / fromViewport)
MODES.aspect = function (group) {
	const N = CN(1024);
	const SIDE = gridCols(N, 1);
	const ROWS = gridRows(N, SIDE);
	const hp = makePoints(N, 0.07, true);
	const frame = makeLines(4, false);
	const bx = new Float32Array(N), by = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		bx[i] = ((i % SIDE) / (SIDE - 1)) * 2 - 1;
		by[i] = (Math.floor(i / SIDE) / gridDiv(ROWS)) * 2 - 1;
	}
	group.add(hp.points); group.add(frame.line);
	return {
		count: N,
		update: function (dt, t) {
			const srcW = 16 + 7 * Math.sin(t * 0.7), srcH = 9;
			Mat2.fromAspectFit(M2a, srcW, srcH, 10, 10);
			for (let i = 0; i < N; i++) {
				const j = i * 3;
				hp.pos[j] = M2a[0] * bx[i] + M2a[2] * by[i];
				hp.pos[j + 1] = M2a[1] * bx[i] + M2a[3] * by[i];
				hp.pos[j + 2] = 0;
				ramp(0.5 + 0.5 * Math.sin(t + i * 0.01), hp.col, j);
			}
			const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
			for (let k = 0; k < 4; k++) {
				const a = c[k], b = c[(k + 1) % 4], j = k * 6;
				frame.pos[j] = M2a[0] * a[0] + M2a[2] * a[1]; frame.pos[j + 1] = M2a[1] * a[0] + M2a[3] * a[1]; frame.pos[j + 2] = 0;
				frame.pos[j + 3] = M2a[0] * b[0] + M2a[2] * b[1]; frame.pos[j + 4] = M2a[1] * b[0] + M2a[3] * b[1]; frame.pos[j + 5] = 0;
				frame.col[j] = frame.col[j + 3] = 0.9; frame.col[j + 1] = frame.col[j + 4] = 0.75; frame.col[j + 2] = frame.col[j + 5] = 0.2;
			}
			flushP(hp); flushL(frame);
			this._sx = M2a[0]; this._sy = M2a[3];
		},
		info: function () {
			return "fromAspectFit(src breathing -> 10x10)\nsx=" + (this._sx || 0).toFixed(3) + " sy=" + (this._sy || 0).toFixed(3) + " | " + N + " pts";
		}
	};
};

// 07 -- chroma hue rotation (fromChromaRotation + soaHueRotateChroma)
MODES.chroma = function (group) {
	const N = CN(4096);
	const SIDE = gridCols(N, 1);
	const ROWS = gridRows(N, SIDE);
	const hp = makePoints(N, 0.08, false);
	const inY = new Float32Array(N), inCb = new Float32Array(N), inCr = new Float32Array(N);
	const oY = new Float32Array(N), oCb = new Float32Array(N), oCr = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		const j = i * 3;
		const u = (i % SIDE) / (SIDE - 1);
		const v = Math.floor(i / SIDE) / gridDiv(ROWS);
		hp.pos[j] = u * 12 - 6; hp.pos[j + 1] = v * 12 - 6; hp.pos[j + 2] = 0;
		inY[i] = 0.35 + 0.5 * v;
		inCb[i] = Math.sin(u * TAU) * 0.4;
		inCr[i] = Math.cos(v * TAU) * 0.4;
	}
	group.add(hp.points);
	return {
		count: N,
		update: function (dt, t) {
			Mat2.soaHueRotateChroma(oCb, oCr, oY, inCb, inCr, inY, t * 0.6);
			for (let i = 0; i < N; i++) {
				const j = i * 3, Y = oY[i], cb = oCb[i], cr = oCr[i];
				hp.col[j] = clamp01(Y + 1.402 * cr);
				hp.col[j + 1] = clamp01(Y - 0.344136 * cb - 0.714136 * cr);
				hp.col[j + 2] = clamp01(Y + 1.772 * cb);
			}
			flushP(hp);
		},
		info: function () {
			return "soaHueRotateChroma (luma preserved)\n" + N + " colors, hue = t*0.6 rad (continuous)";
		}
	};
};

// 08 -- blendRotation vs linear blend
MODES.blend = function (group) {
	const N = CN(512);
	const a1 = makePoints(N, 0.07, true), a2 = makePoints(N, 0.07, true);
	const bx = new Float32Array(N), by = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		const u = i / N * TAU;
		const r = 2 + 0.6 * Math.sin(u * 5);
		bx[i] = Math.cos(u) * r; by[i] = Math.sin(u) * r;
	}
	Mat2.compose(M2a, 0.25, 1.5, 0.8, 0.35);
	Mat2.compose(M2b, 2.0, 0.8, 1.6, -0.45);
	group.add(a1.points); group.add(a2.points);
	return {
		count: N,
		update: function (dt, t) {
			const k = tri(t * 0.22);
			Mat2.blendRotation(M2c, M2a, M2b, k);
			for (let i = 0; i < N; i++) {
				const j = i * 3;
				a1.pos[j] = M2c[0] * bx[i] + M2c[2] * by[i];
				a1.pos[j + 1] = M2c[1] * bx[i] + M2c[3] * by[i];
				a1.pos[j + 2] = 0;
				ramp(k, a1.col, j);
			}
			Mat2.blend(M2c, M2a, M2b, k);
			for (let i = 0; i < N; i++) {
				const j = i * 3;
				a2.pos[j] = M2c[0] * bx[i] + M2c[2] * by[i];
				a2.pos[j + 1] = M2c[1] * bx[i] + M2c[3] * by[i];
				a2.pos[j + 2] = 0.05;
				a2.col[j] = 0.9; a2.col[j + 1] = 0.3; a2.col[j + 2] = 0.8;
			}
			flushP(a1); flushP(a2);
			this._k = k;
		},
		info: function () {
			return "cyan = blendRotation, magenta = linear blend\nt=" + (this._k || 0).toFixed(2) + " | " + N + " pts each";
		}
	};
};

// 09 -- decompose / compose round trip
MODES.decomp = function (group) {
	const N = CN(1024);
	const a1 = makePoints(N, 0.06, true), a2 = makePoints(N, 0.06, true);
	const bx = new Float32Array(N), by = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		const u = fract(i / N * 7), v = Math.floor(i / N * 7) / 6;
		bx[i] = (u * 2 - 1) * (1 - v * 0.5); by[i] = (v * 2 - 1);
	}
	group.add(a1.points); group.add(a2.points);
	return {
		count: N,
		update: function (dt, t) {
			Mat2.compose(M2a, t * 0.4, 1 + 0.5 * Math.sin(t), 1 + 0.5 * Math.cos(t * 0.7), 0.45 * Math.sin(t * 0.5));
			Mat2.decompose(D4, M2a);
			Mat2.compose(M2b, D4[0], D4[1], D4[2], D4[3]);
			for (let i = 0; i < N; i++) {
				const j = i * 3;
				a1.pos[j] = M2a[0] * bx[i] + M2a[2] * by[i]; a1.pos[j + 1] = M2a[1] * bx[i] + M2a[3] * by[i]; a1.pos[j + 2] = 0;
				a2.pos[j] = M2b[0] * bx[i] + M2b[2] * by[i]; a2.pos[j + 1] = M2b[1] * bx[i] + M2b[3] * by[i]; a2.pos[j + 2] = 0.04;
				ramp(0.75, a1.col, j);
				a2.col[j] = 1; a2.col[j + 1] = 0.25; a2.col[j + 2] = 0.7;
			}
			flushP(a1); flushP(a2);
		},
		info: function () {
			return "compose -> decompose -> compose (" + N + " pts)\nangle=" + D4[0].toFixed(2) + " sx=" + D4[1].toFixed(2) +
				" sy=" + D4[2].toFixed(2) + " shear=" + D4[3].toFixed(2);
		}
	};
};

// 10 -- 2D orbital tangent frames (keplerOrbit2D + fromOrbitalTangent)
MODES.orbit2 = function (group) {
	const NB = Math.max(4, Math.min(240, CN(40)));
	const SEG = 72;
	const orbits = makeLines(NB * SEG, false);
	const bodies = makePoints(NB, 0.16, true);
	const tang = makeLines(NB, true);
	const A = new Float32Array(NB), E = new Float32Array(NB), PH = new Float32Array(NB), SP = new Float32Array(NB);
	for (let b = 0; b < NB; b++) {
		A[b] = 2 + (b / NB) * 6;
		E[b] = 0.1 + 0.5 * fract(Math.sin(b * 12.9898) * 43758.5453);
		PH[b] = fract(b * 0.618) * TAU;
		SP[b] = 1.2 / Math.pow(A[b], 1.5);
		for (let s = 0; s < SEG; s++) {
			Vec2.keplerOrbit2D(T2a, A[b], E[b], (s / SEG) * TAU);
			const x0 = T2a[0], y0 = T2a[1];
			Vec2.keplerOrbit2D(T2a, A[b], E[b], ((s + 1) / SEG) * TAU);
			const j = (b * SEG + s) * 6;
			orbits.pos[j] = x0; orbits.pos[j + 1] = y0; orbits.pos[j + 2] = 0;
			orbits.pos[j + 3] = T2a[0]; orbits.pos[j + 4] = T2a[1]; orbits.pos[j + 5] = 0;
			hsl(b / NB, 0.7, 0.45, orbits.col, j);
			orbits.col[j + 3] = orbits.col[j]; orbits.col[j + 4] = orbits.col[j + 1]; orbits.col[j + 5] = orbits.col[j + 2];
		}
	}
	flushL(orbits);
	group.add(orbits.line); group.add(bodies.points); group.add(tang.line);
	return {
		count: NB,
		update: function (dt, t) {
			for (let b = 0; b < NB; b++) {
				const M = PH[b] + t * SP[b] * 4;
				Vec2.keplerOrbit2D(T2a, A[b], E[b], M);
				const px = T2a[0], py = T2a[1];
				Vec2.keplerOrbit2D(T2a, A[b], E[b], M + 0.04);
				Mat2.fromOrbitalTangent(M2a, T2a[0] - px, T2a[1] - py);
				const j = b * 3;
				bodies.pos[j] = px; bodies.pos[j + 1] = py; bodies.pos[j + 2] = 0;
				hsl(b / NB, 0.9, 0.65, bodies.col, j);
				const k = b * 6, L = 0.7;
				tang.pos[k] = px - M2a[0] * L; tang.pos[k + 1] = py - M2a[1] * L; tang.pos[k + 2] = 0;
				tang.pos[k + 3] = px + M2a[0] * L; tang.pos[k + 4] = py + M2a[1] * L; tang.pos[k + 5] = 0;
				tang.col[k] = tang.col[k + 3] = 1; tang.col[k + 1] = tang.col[k + 4] = 1; tang.col[k + 2] = tang.col[k + 5] = 1;
			}
			flushP(bodies); flushL(tang);
		},
		info: function () {
			return "keplerOrbit2D + fromOrbitalTangent\n" + NB + " bodies, tangent frames follow velocity";
		}
	};
};

// 11 -- 2D two-bone IK (fromTwoBoneChain)
MODES.ik2 = function (group) {
	const bones = makeLines(2, true);
	const dirs = makeLines(2, false);
	const target = makePoints(1, 0.3, true);
	const L1 = 3.2, L2 = 2.7;
	group.add(bones.line); group.add(dirs.line); group.add(target.points);
	return {
		count: 2,
		update: function (dt, t) {
			const tx = Math.cos(t * 0.7) * 4.4, ty = Math.sin(t * 0.7) * 4.4;
			const raw = Math.sqrt(tx * tx + ty * ty) || 1;
			const d = Math.min(Math.max(raw, Math.abs(L1 - L2) + 1e-3), L1 + L2 - 1e-3);
			const base = Math.atan2(ty, tx);
			const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
			const a1 = base - Math.acos(Math.min(1, Math.max(-1, cosA)));
			const jx = Math.cos(a1) * L1, jy = Math.sin(a1) * L1;
			const ex = (tx / raw) * d, ey = (ty / raw) * d;
			Mat2.fromTwoBoneChain(M2a, M2b, 0, 0, jx, jy, ex, ey);
			bones.pos[0] = 0; bones.pos[1] = 0; bones.pos[2] = 0;
			bones.pos[3] = jx; bones.pos[4] = jy; bones.pos[5] = 0;
			bones.pos[6] = jx; bones.pos[7] = jy; bones.pos[8] = 0;
			bones.pos[9] = ex; bones.pos[10] = ey; bones.pos[11] = 0;
			for (let k = 0; k < 12; k += 3) {
				bones.col[k] = 0.3; bones.col[k + 1] = 0.9; bones.col[k + 2] = 0.7;
			}
			dirs.pos[0] = jx; dirs.pos[1] = jy; dirs.pos[2] = 0;
			dirs.pos[3] = jx + M2a[0]; dirs.pos[4] = jy + M2a[1]; dirs.pos[5] = 0;
			dirs.pos[6] = ex; dirs.pos[7] = ey; dirs.pos[8] = 0;
			dirs.pos[9] = ex + M2b[0]; dirs.pos[10] = ey + M2b[1]; dirs.pos[11] = 0;
			for (let k = 0; k < 12; k += 3) {
				dirs.col[k] = 1; dirs.col[k + 1] = 0.8; dirs.col[k + 2] = 0.2;
			}
			target.pos[0] = tx; target.pos[1] = ty; target.pos[2] = 0;
			target.col[0] = 1; target.col[1] = 0.3; target.col[2] = 0.4;
			flushL(bones); flushL(dirs); flushP(target);
		},
		info: function () {
			return "fromTwoBoneChain: bone x-axes (yellow)\ntrack a circular target (continuous cycle)";
		}
	};
};

// 12 -- vec2 spring follow (springDamp2)
MODES.spring2 = function (group) {
	const cur = Vec2.create(), vel = Vec2.create(), tgt = Vec2.create();
	const marker = makePoints(1, 0.3, true);
	const tmark = makePoints(1, 0.18, false);
	const TN = 220;
	const trail = makeLines(TN - 1, true);
	const hist = new Float32Array(TN * 2);
	let head = 0;
	group.add(marker.points); group.add(tmark.points); group.add(trail.line);
	return {
		count: 1,
		update: function (dt, t) {
			Vec2.set(tgt, 4.4 * Math.sin(t * 0.9), 3.2 * Math.sin(t * 1.31 + 1.2));
			Vec2.springDamp2(cur, cur, tgt, vel, 0.28, dt, 24);
			marker.pos[0] = cur[0]; marker.pos[1] = cur[1]; marker.pos[2] = 0;
			marker.col[0] = 0.3; marker.col[1] = 0.95; marker.col[2] = 0.7;
			tmark.pos[0] = tgt[0]; tmark.pos[1] = tgt[1]; tmark.pos[2] = 0;
			tmark.col[0] = 0.95; tmark.col[1] = 0.6; tmark.col[2] = 0.2;
			hist[head * 2] = cur[0]; hist[head * 2 + 1] = cur[1];
			head = (head + 1) % TN;
			for (let k = 0; k < TN - 1; k++) {
				const s0 = (head + k) % TN, s1 = (head + k + 1) % TN, j = k * 6;
				trail.pos[j] = hist[s0 * 2]; trail.pos[j + 1] = hist[s0 * 2 + 1]; trail.pos[j + 2] = 0;
				trail.pos[j + 3] = hist[s1 * 2]; trail.pos[j + 4] = hist[s1 * 2 + 1]; trail.pos[j + 5] = 0;
				const f = k / TN;
				trail.col[j] = trail.col[j + 3] = 0.2 + f * 0.4;
				trail.col[j + 1] = trail.col[j + 4] = 0.6 + f * 0.3;
				trail.col[j + 2] = trail.col[j + 5] = 0.9;
			}
			flushP(marker); flushP(tmark); flushL(trail);
		},
		info: function () {
			return "springDamp2 chasing Lissajous target\nvel = " + Vec2.str(vel);
		}
	};
};

// 13 -- vec2 flow field advection (fbm2D)
MODES.flow2 = function (group) {
	const N = CN(4096);
	const hp = makePoints(N, 0.05, true);
	const pos = Vec2.createVec2SOA(N);
	for (let i = 0; i < N; i++) {
		pos.x[i] = (Math.random() * 2 - 1) * 8;
		pos.y[i] = (Math.random() * 2 - 1) * 8;
	}
	group.add(hp.points);
	return {
		count: N,
		update: function (dt, t) {
			const ox = Math.sin(t * 0.3) * 2.5, oy = Math.cos(t * 0.23) * 2.5;
			for (let i = 0; i < N; i++) {
				const n = Vec2.fbm2D(pos.x[i] * 0.12 + ox, pos.y[i] * 0.12 + oy, 2);
				const a = n * TAU * 2;
				pos.x[i] += Math.cos(a) * dt * 2.2;
				pos.y[i] += Math.sin(a) * dt * 2.2;
				if (pos.x[i] > 8) pos.x[i] -= 16; else if (pos.x[i] < -8) pos.x[i] += 16;
				if (pos.y[i] > 8) pos.y[i] -= 16; else if (pos.y[i] < -8) pos.y[i] += 16;
				const j = i * 3;
				hp.pos[j] = pos.x[i]; hp.pos[j + 1] = pos.y[i]; hp.pos[j + 2] = 0;
				ramp(n, hp.col, j);
			}
			flushP(hp);
		},
		info: function () {
			return "fbm2D flow advection, field drifts on a cycle\n" + N + " particles wrapping in-box";
		}
	};
};

// 14 -- voronoi2D breathing cells
MODES.voronoi2 = function (group) {
	const N = CN(6400);
	const SIDE = gridCols(N, 1);
	const ROWS = gridRows(N, SIDE);
	const hp = makePoints(N, 0.06, false);
	const bx = new Float32Array(N), by = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		bx[i] = ((i % SIDE) / (SIDE - 1)) * 12 - 6;
		by[i] = (Math.floor(i / SIDE) / gridDiv(ROWS)) * 12 - 6;
		const j = i * 3;
		hp.pos[j] = bx[i]; hp.pos[j + 1] = by[i]; hp.pos[j + 2] = 0;
	}
	group.add(hp.points);
	return {
		count: N,
		update: function (dt, t) {
			const wx = 0.9 * Math.sin(t * 0.5), wy = 0.9 * Math.cos(t * 0.5);
			for (let i = 0; i < N; i++) {
				Vec2.voronoi2D(T2a, bx[i] * 0.35 + wx, by[i] * 0.35 + wy);
				const j = i * 3;
				const edge = clamp01(T2a[0] * 3.2);
				hsl((T2a[1] % 64) / 64, 0.75, 0.18 + edge * 0.45, hp.col, j);
			}
			flushP(hp);
		},
		info: function () {
			return "voronoi2D cells, features orbit on a cycle\n" + N + " samples = cell id + edge distance";
		}
	};
};

// 15 -- vec3 breathing shell (fbm3D + rotateY)
MODES.shell3 = function (group) {
	const N = CN(4096);
	const hp = makePoints(N, 0.06, true);
	const bx = new Float32Array(N * 3);
	for (let i = 0; i < N; i++) {
		Vec3.random(T2a, 1);
		const r = 3.6 + Math.random() * 1.2;
		bx[i * 3] = T2a[0] * r; bx[i * 3 + 1] = T2a[1] * r; bx[i * 3 + 2] = T2a[2] * r;
	}
	const v3 = Vec3.create();
	const origin = Vec3.create();
	group.add(hp.points);
	return {
		count: N,
		update: function (dt, t) {
			const a = t * 0.3, b = 1 + 0.14 * Math.sin(t * 1.7);
			const ox = Math.sin(t * 0.4), oz = Math.cos(t * 0.33);
			for (let i = 0; i < N; i++) {
				const x = bx[i * 3] * b, y = bx[i * 3 + 1] * b, z = bx[i * 3 + 2] * b;
				const n = Vec3.fbm3D(x * 0.25 + ox, y * 0.25, z * 0.25 + oz, 2);
				const k = 1 + (n - 0.5) * 0.5;
				Vec3.set(v3, x * k, y * k, z * k);
				Vec3.rotateY(v3, v3, origin, a);
				const j = i * 3;
				hp.pos[j] = v3[0]; hp.pos[j + 1] = v3[1]; hp.pos[j + 2] = v3[2];
				ramp(n, hp.col, j);
			}
			flushP(hp);
		},
		info: function () {
			return "vec3 fbm3D displacement + rotateY spin\n" + N + " pts, breathing = 1+0.14*sin(t)";
		}
	};
};

// 16 -- vec4 plasma (fbm4D, w = cyclic time)
MODES.plasma4 = function (group) {
	const N = CN(5184);
	const SIDE = gridCols(N, 1);
	const ROWS = gridRows(N, SIDE);
	const hp = makePoints(N, 0.07, true);
	const bx = new Float32Array(N), by = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		bx[i] = ((i % SIDE) / (SIDE - 1)) * 14 - 7;
		by[i] = (Math.floor(i / SIDE) / gridDiv(ROWS)) * 14 - 7;
	}
	group.add(hp.points);
	return {
		count: N,
		update: function (dt, t) {
			const w = Math.sin(t * 0.6) * 1.6;
			for (let i = 0; i < N; i++) {
				const v = Vec4.fbm4D(bx[i] * 0.22, by[i] * 0.22, 0.35, w, 3);
				const j = i * 3;
				hp.pos[j] = bx[i]; hp.pos[j + 1] = by[i]; hp.pos[j + 2] = (v - 0.5) * 3.2;
				hsl(0.55 + v * 0.35, 0.85, 0.15 + v * 0.55, hp.col, j);
			}
			flushP(hp);
		},
		info: function () {
			return "fbm4D plasma, w = sin(t)*1.6 (cycle)\n" + N + " samples/frame on CPU";
		}
	};
};

// 17 -- homogeneous divide wave (perspectiveDivide + projectLerp)
MODES.homog = function (group) {
	const N = CN(512);
	const hp = makePoints(N, 0.09, true);
	const marker = makePoints(1, 0.3, true);
	const cx = new Float32Array(N), cy = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		const u = (i / N) * TAU;
		cx[i] = Math.cos(u) * (1 + 0.35 * Math.sin(u * 5));
		cy[i] = Math.sin(u) * (1 + 0.35 * Math.sin(u * 5));
	}
	const clipA = Vec4.fromValues(-0.85, -0.85, 0, 1);
	const clipB = Vec4.fromValues(0.85, 0.85, 0, 1);
	const v4a = Vec4.create(), v4b = Vec4.create();
	group.add(hp.points); group.add(marker.points);
	return {
		count: N,
		update: function (dt, t) {
			for (let i = 0; i < N; i++) {
				const w = 1 + 0.85 * Math.sin(t * 1.2 + i * 0.06);
				Vec4.set(v4a, cx[i], cy[i], 0, w);
				Vec4.perspectiveDivide(v4b, v4a);
				const j = i * 3;
				hp.pos[j] = v4b[0] * 5.5; hp.pos[j + 1] = v4b[1] * 5.5; hp.pos[j + 2] = (w - 1) * 1.4;
				ramp(clamp01((w - 0.15) / 1.7), hp.col, j);
			}
			Vec4.set(clipB, 0.85, 0.85, 0, 1 + 0.9 * Math.sin(t * 0.8));
			Vec4.projectLerp(v4a, clipA, clipB, tri(t * 0.2));
			Vec4.perspectiveDivide(v4b, v4a);
			marker.pos[0] = v4b[0] * 5.5; marker.pos[1] = v4b[1] * 5.5; marker.pos[2] = (v4a[3] - 1) * 1.4;
			marker.col[0] = 1; marker.col[1] = 0.85; marker.col[2] = 0.3;
			flushP(hp); flushP(marker);
		},
		info: function () {
			return "perspectiveDivide: w-wave ring (" + N + " pts)\nmarker = projectLerp ping-pong in clip space";
		}
	};
};

// 18 -- quat-as-vec4 spin (quatFromAxisAngle + transformQuat)
MODES.quatSpin = function (group) {
	const N = CN(1024);
	const hp = makePoints(N, 0.07, true);
	const bx = new Float32Array(N * 4);
	for (let i = 0; i < N; i++) {
		const u = (i / N) * TAU * 3, v = (i / N) * TAU;
		const r = 3.4 + Math.sin(u * 0.7) * 1.1;
		bx[i * 4] = Math.cos(u) * r;
		bx[i * 4 + 1] = Math.sin(v * 5) * 1.2 + Math.sin(u) * r * 0.3;
		bx[i * 4 + 2] = Math.sin(u) * r;
		bx[i * 4 + 3] = 1;
	}
	const axis = Vec3.create(), q = Vec4.create(), p = Vec4.create();
	group.add(hp.points);
	return {
		count: N,
		update: function (dt, t) {
			Vec3.set(axis, Math.sin(t * 0.4), Math.cos(t * 0.3), 0.55);
			Vec3.normalize(axis, axis);
			Vec4.quatFromAxisAngle(q, axis, t * 0.9);
			for (let i = 0; i < N; i++) {
				Vec4.set(p, bx[i * 4], bx[i * 4 + 1], bx[i * 4 + 2], bx[i * 4 + 3]);
				Vec4.transformQuat(p, p, q);
				const j = i * 3;
				hp.pos[j] = p[0]; hp.pos[j + 1] = p[1]; hp.pos[j + 2] = p[2];
				ramp(fract(i / N + t * 0.05), hp.col, j);
			}
			flushP(hp);
		},
		info: function () {
			return "vec4 quat: precessing axis + continuous spin\ntransformQuat on " + N + " homogeneous pts";
		}
	};
};

// 19 -- pool churn + chunked async benchmark (soaMultiplyChunked)
MODES.poolBench = function (group) {
	const S = Math.max(16, Math.min(2048, CN(256)));
	const BENCH = Math.max(1024, Math.min(524288, CN(262144)));
	const star = makeLines(S * 2, true);
	let big = null, benchMs = -1, running = false;
	group.add(star.line);
	return {
		count: S,
		ui: function (api) {
			api.addButton("Run soaMultiplyChunked " + BENCH, function () {
				if (running) { return; }
				running = true;
				if (!big) {
					big = {
						a: Mat2.createMat2SOA(BENCH),
						b: Mat2.createMat2SOA(BENCH),
						o: Mat2.createMat2SOA(BENCH)
					};
					Mat2.soaFillFromRotations(big.a, fillArr(BENCH, 0));
					Mat2.soaFillFromRotations(big.b, fillArr(BENCH, 7));
				}
				setStatus("chunked multiply running (" + BENCH + ")...");
				const t0 = performance.now();
				Mat2.soaMultiplyChunked(big.o, big.a, big.b, 65536, 4).then(function () {
					benchMs = performance.now() - t0;
					running = false;
					setStatus("chunked multiply done in " + benchMs.toFixed(1) + " ms (UI never froze)");
				});
			});
		},
		update: function (dt, t) {
			for (let s = 0; s < S; s++) {
				const m = Mat2.acquire();
				const m2 = Mat2.acquire();
				Mat2.fromRotation(m, t * 0.8 + (s / S) * TAU);
				Mat2.fromRotation(m2, -t * 1.3 + (s / S) * TAU);
				Mat2.transpose(m2, m2);
				const j = s * 12, L = 4.6;
				star.pos[j] = m[0] * L; star.pos[j + 1] = m[1] * L; star.pos[j + 2] = 0;
				star.pos[j + 3] = -m[0] * L; star.pos[j + 4] = -m[1] * L; star.pos[j + 5] = 0;
				star.pos[j + 6] = m2[0] * L * 0.6; star.pos[j + 7] = m2[1] * L * 0.6; star.pos[j + 8] = 0;
				star.pos[j + 9] = -m2[0] * L * 0.6; star.pos[j + 10] = -m2[1] * L * 0.6; star.pos[j + 11] = 0;
				ramp(s / S, star.col, j);
				for (let k = 3; k < 12; k += 3) {
					star.col[j + k] = star.col[j]; star.col[j + k + 1] = star.col[j + 1]; star.col[j + k + 2] = star.col[j + 2];
				}
				Mat2.release(m); Mat2.release(m2);
			}
			flushL(star);
		},
		info: function () {
			return "mat2 pool acquire/release: " + (S * 2) + "/frame\nbench: " +
				(benchMs < 0 ? "not run" : benchMs.toFixed(1) + " ms for " + BENCH + " mat2 mults");
		}
	};
};

function fillArr(n, seed) {
	const a = new Float32Array(n);
	const s = seed || 0;
	for (let i = 0; i < n; i++) a[i] = Vec2.valueNoise2D(i * 0.01 + s, s * 3.3) * TAU;
	return a;
}

// 20 -- floating origin vs float32 naive (soaToRelative + fromWorldBounds)
MODES.floatOrigin = function (group) {
	const N = CN(4096);
	const C = 100000;
	const good = makePoints(N, 0.05, true);
	const bad = makePoints(N, 0.05, true);
	const wx = new Float64Array(N), wy = new Float64Array(N), wz = new Float64Array(N);
	const wf = new Float32Array(N * 3);
	const v3 = Vec3.create();
	for (let i = 0; i < N; i++) {
		Vec3.random(v3, 1);
		wx[i] = C + v3[0] * 6; wy[i] = v3[1] * 6; wz[i] = v3[2] * 6;
		wf[i * 3] = wx[i]; wf[i * 3 + 1] = wy[i]; wf[i * 3 + 2] = wz[i];
		ramp(clamp01((v3[1] + 1) * 0.5), good.col, i * 3);
	}
	let simulate = true, maxErr = 0;
	group.add(good.points); group.add(bad.points);
	return {
		count: N,
		ui: function (api) {
			api.addCheckbox("Show float32-naive ghost", simulate, function (v) {
				simulate = v;
				bad.points.visible = v;
			});
		},
		update: function (dt, t) {
			const ox = C + Math.cos(t * 0.4) * 30;
			const oy = Math.sin(t * 0.3) * 12;
			const oz = Math.sin(t * 0.4) * 30;
			const fox = Math.fround(ox), foy = Math.fround(oy), foz = Math.fround(oz);
			const k = 1 / 8;
			maxErr = 0;
			for (let i = 0; i < N; i++) {
				const j = i * 3;
				const rx = (wx[i] - ox) * k, ry = (wy[i] - oy) * k, rz = (wz[i] - oz) * k;
				good.pos[j] = rx; good.pos[j + 1] = ry; good.pos[j + 2] = rz;
				if (simulate) {
					const gx = (wf[j] - fox) * k, gy = (wf[j + 1] - foy) * k, gz = (wf[j + 2] - foz) * k;
					bad.pos[j] = gx; bad.pos[j + 1] = gy; bad.pos[j + 2] = gz;
					bad.col[j] = 1; bad.col[j + 1] = 0.25; bad.col[j + 2] = 0.25;
					const e = Math.abs(gx - rx);
					if (e > maxErr) maxErr = e;
				}
			}
			flushP(good);
			if (simulate) flushP(bad);
		},
		info: function () {
			return "origin orbits x=1e5 (cycle), " + N + " pts\nfloat32-naive max error = " + maxErr.toFixed(4);
		}
	};
};

const MODE_KEYS = Object.keys(MODES);
const MODE_LABELS = {
	rotField: "01 SOA rotation field", aniso: "02 Voronoi aniso compose", detHeat: "03 Determinant heat",
	shear: "04 Shear cycle", reflect: "05 Reflection states", aspect: "06 Aspect fit breathing",
	chroma: "07 Chroma hue rotate", blend: "08 blendRotation vs lerp", decomp: "09 Decompose roundtrip",
	orbit2: "10 Orbital tangent frames", ik2: "11 Two-bone IK", spring2: "12 vec2 spring follow",
	flow2: "13 Flow field advection", voronoi2: "14 Voronoi cells", shell3: "15 vec3 breathing shell",
	plasma4: "16 vec4 4D plasma", homog: "17 Homogeneous divide", quatSpin: "18 quat-as-vec4 spin",
	poolBench: "19 Pool + chunked bench", floatOrigin: "20 Floating origin"
};

// ============================================================================
// UI
// ============================================================================
function setStatus(msg) { if (ui.status) ui.status.textContent = msg; }

function makeSlider(parent, label, min, max, step, value, onChange) {
	const row = document.createElement("div");
	row.style.cssText = "display:grid;grid-template-columns:100px 1fr 48px;gap:6px;align-items:center;margin:5px 0;";
	const lab = document.createElement("span");
	lab.textContent = label; lab.style.opacity = "0.85";
	const inp = document.createElement("input");
	inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
	inp.style.cssText = "width:100%;accent-color:#35c8ff;";
	const val = document.createElement("span");
	val.className = "mat2-demo-value";
	val.textContent = (+value).toFixed(step >= 1 ? 0 : 2);
	val.style.cssText = "text-align:right;font-family:ui-monospace,monospace;font-size:11px;";
	inp.addEventListener("input", function () {
		const v = +inp.value;
		val.textContent = v.toFixed(step >= 1 ? 0 : 2);
		onChange(v);
	});
	row.append(lab, inp, val);
	parent.appendChild(row);
	return inp;
}

// AMOUNT + MULTIPLIER group (matches 004_mat2_demo.css contract).
// NOTE: no inline "grid-template-columns" here, so the stylesheet's generic
// row selector cannot override the amount-group layout.
function buildAmountGroup() {
	const group = document.createElement("div");
	group.className = "mat2-amount-group";
	group.setAttribute("data-mult", String(params.amountMult));
	group.style.cssText = "margin:4px 0 12px;padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);";

	const head = document.createElement("div");
	head.className = "mat2-amount-head";
	head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;";
	const title = document.createElement("span");
	title.textContent = "Instance amount";
	const badge = document.createElement("span");
	badge.className = "mat2-mult-badge";
	head.append(title, badge);

	const rowA = document.createElement("div");
	rowA.className = "mat2-amount-row";
	rowA.style.cssText = "display:flex;gap:8px;align-items:center;margin:6px 0;";
	const labA = document.createElement("span");
	labA.textContent = "Amount";
	const inpA = document.createElement("input");
	inpA.type = "range"; inpA.min = "256"; inpA.max = "8192"; inpA.step = "256";
	inpA.value = String(params.amountBase);
	inpA.style.cssText = "flex:1;min-width:0;accent-color:#35c8ff;";
	const valA = document.createElement("span");
	valA.className = "mat2-demo-value";
	rowA.append(labA, inpA, valA);

	const rowM = document.createElement("div");
	rowM.className = "mat2-mult-row";
	rowM.style.cssText = "display:flex;gap:8px;align-items:center;margin:6px 0;";
	const labM = document.createElement("span");
	labM.textContent = "Multiply x";
	const inpM = document.createElement("input");
	inpM.type = "range"; inpM.min = "1"; inpM.max = "4"; inpM.step = "1";
	inpM.value = String(params.amountMult);
	inpM.className = "mat2-mult-slider";
	inpM.style.cssText = "flex:1;min-width:0;accent-color:#35c8ff;";
	const valM = document.createElement("span");
	valM.className = "mat2-demo-value";
	rowM.append(labM, inpM, valM);

	const ticks = document.createElement("div");
	ticks.className = "mat2-mult-ticks";
	ticks.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);margin-top:2px;font-size:9px;text-align:center;opacity:0.7;";
	for (let n = 1; n <= 4; n++) {
		const s = document.createElement("span");
		s.textContent = "x" + n;
		ticks.appendChild(s);
	}

	group.append(head, rowA, rowM, ticks);

	function refresh() {
		valA.textContent = String(params.amountBase);
		valM.textContent = "x" + params.amountMult;
		badge.textContent = "N = " + CN(2048);
		group.setAttribute("data-mult", String(params.amountMult));
	}

	inpA.addEventListener("input", function () {
		params.amountBase = parseInt(inpA.value, 10);
		refresh();
		if (state.ready) setMode(params.mode);
	});

	inpM.addEventListener("input", function () {
		params.amountMult = parseInt(inpM.value, 10);
		refresh();
		if (state.ready) setMode(params.mode);
	});

	refresh();
	ui.amountGroup = group;
	ui.amountBadge = badge;
	return group;
}

function createUI() {
	const panel = document.createElement("div");
	panel.className = "mat2-demo-panel";
	panel.setAttribute("data-mode", params.mode);
	panel.style.cssText = "position:fixed;top:12px;right:12px;z-index:1000;width:340px;max-height:calc(100vh - 24px);overflow:auto;padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,0.12);background:rgba(8,11,16,0.7);color:#dfe8f2;font:12px/1.45 system-ui,sans-serif;backdrop-filter:blur(10px);";

	const title = document.createElement("div");
	title.textContent = "04_mat2_demo.js - 20 examples";
	title.style.cssText = "font-weight:700;font-size:13px;margin-bottom:8px;";

	const select = document.createElement("select");
	select.style.cssText = "width:100%;margin-bottom:8px;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.35);color:#dfe8f2;";
	MODE_KEYS.forEach(function (k) {
		const o = document.createElement("option");
		o.value = k; o.textContent = MODE_LABELS[k];
		select.appendChild(o);
	});
	select.addEventListener("change", function () { setMode(select.value); });

	const globalBox = document.createElement("div");
	const modeBox = document.createElement("div");

	const status = document.createElement("div");
	status.style.cssText = "margin-top:8px;min-height:16px;color:#8ea2b8;font-family:ui-monospace,monospace;font-size:11px;";

	const info = document.createElement("pre");
	info.style.cssText = "margin:8px 0 0;padding:8px;border-radius:8px;background:rgba(255,255,255,0.05);color:#9fe8b5;font-family:ui-monospace,monospace;font-size:11px;white-space:pre-wrap;min-height:44px;";

	panel.append(title, select, globalBox, modeBox, status, info);
	container.appendChild(panel);

	ui.panel = panel; ui.select = select; ui.globalBox = globalBox;
	ui.modeBox = modeBox; ui.status = status; ui.info = info;

	ui.api = {
		addSlider: function (label, min, max, step, value, onChange) {
			return makeSlider(ui.modeBox, label, min, max, step, value, onChange);
		},
		addCheckbox: function (label, value, onChange) {
			const row = document.createElement("label");
			row.style.cssText = "display:flex;gap:8px;align-items:center;margin:6px 0;cursor:pointer;";
			const inp = document.createElement("input");
			inp.type = "checkbox"; inp.checked = !!value;
			inp.style.accentColor = "#35c8ff";
			inp.addEventListener("change", function () { onChange(inp.checked); });
			const lab = document.createElement("span");
			lab.textContent = label; lab.style.opacity = "0.85";
			row.append(inp, lab);
			ui.modeBox.appendChild(row);
			return inp;
		},
		addButton: function (label, onClick) {
			const b = document.createElement("button");
			b.textContent = label;
			b.style.cssText = "width:100%;margin:6px 0;padding:7px 10px;border-radius:8px;border:1px solid rgba(53,200,255,0.3);background:rgba(53,200,255,0.1);color:#d8f5ff;cursor:pointer;font:inherit;";
			b.addEventListener("click", function () {
				try { onClick(); } catch (err) { console.error(err); setStatus("Error: " + err.message); }
			});
			ui.modeBox.appendChild(b);
			return b;
		}
	};

	// Global controls survive example switches.
	makeSlider(globalBox, "Time speed", 0, 3, 0.01, params.speed, function (v) { params.speed = v; });
	globalBox.appendChild(buildAmountGroup());
}

function setMode(key) {
	if (typeof MODES[key] !== "function") key = MODE_KEYS[0];
	params.mode = key;

	if (modeGroup) { disposeGroup(modeGroup); scene.remove(modeGroup); }
	modeGroup = new THREE.Group();
	scene.add(modeGroup);

	ui.modeBox.innerHTML = "";
	modeHandle = MODES[key](modeGroup);
	if (typeof modeHandle.ui === "function") modeHandle.ui(ui.api);

	ui.select.value = key;
	ui.panel.setAttribute("data-mode", key);
	setStatus("Mode: " + MODE_LABELS[key] + " | N x" + params.amountMult);
}

// ============================================================================
// BOOT
// ============================================================================
function getCanvas() {
	if (HOST.canvas) return HOST.canvas;
	let c = document.getElementById("mat2-demo-canvas");
	if (!c) {
		c = document.createElement("canvas");
		c.id = "mat2-demo-canvas";
		c.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block;touch-action:none;";
		container.appendChild(c);
	}
	return c;
}
function getWidth() { return container.clientWidth || window.innerWidth || 1; }
function getHeight() { return container.clientHeight || window.innerHeight || 1; }

function init() {
	renderer = new THREE.WebGLRenderer({ canvas: getCanvas(), antialias: true, powerPreference: "high-performance" });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setSize(getWidth(), getHeight());
	renderer.outputColorSpace = THREE.SRGBColorSpace;

	scene = new THREE.Scene();
	scene.background = new THREE.Color(0x070b10);
	scene.fog = new THREE.Fog(0x070b10, 40, 120);

	camera = new THREE.PerspectiveCamera(55, getWidth() / getHeight(), 0.1, 500);
	camera.position.set(0, 4, 17);

	controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.06;

	scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x080b10, 1.1));
	const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
	sun.position.set(8, 12, 6);
	scene.add(sun);
	const grid = new THREE.GridHelper(30, 30, 0x2b3948, 0x151c25);
	grid.material.transparent = true; grid.material.opacity = 0.3;
	scene.add(grid);

	clock = new THREE.Clock();
	createUI();
	setMode(params.mode);
	state.ready = true;

	window.addEventListener("resize", function () {
		camera.aspect = getWidth() / getHeight();
		camera.updateProjectionMatrix();
		renderer.setSize(getWidth(), getHeight());
	});

	animate();
	globalThis.__MAT2_DEMO__ = {
		params: params, state: state, setMode: setMode, CN: CN,
		Mat2: Mat2, Vec2: Vec2, Vec3: Vec3, Vec4: Vec4
	};
}

function animate() {
	requestAnimationFrame(animate);
	const dt = Math.min(clock.getDelta(), 0.05);
	state.time += dt * params.speed;
	state.frame++;
	controls.update();
	if (modeHandle) modeHandle.update(dt, state.time);
	state.infoTimer += dt;
	if (state.infoTimer > 0.25) {
		state.infoTimer = 0;
		ui.info.textContent = modeHandle && modeHandle.info ? modeHandle.info() : "";
	}
	renderer.render(scene, camera);
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init);
} else {
	init();
}