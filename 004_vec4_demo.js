// File number : 004-demo
// File : 04_vec4_demo.js
// Description : Full real-time showcase (10 examples) for src/math/004_vec4.js.
//               Every animated example runs a CONTINUOUS CYCLE (orbit / loop /
//               ping-pong / breathing) so motion never stops. Uses Three.js
//               r185 + native ES modules (no Vite / no Vue / no client build).
// License : MIT

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as Vec4 from "./math/004_vec4.js";

const HOST = globalThis.__VEC4_DEMO_HOST__ || {};
const container = HOST.container || document.body;

const MODE_KEYS = [
	"noise4d",
	"homogeneous",
	"quatOrbit",
	"quatSpring",
	"spring4d",
	"curve4d",
	"nlerp",
	"colorPipe",
	"batchMat4",
	"floatOrigin"
];

const MODE_LABELS = {
	noise4d: "01 - 4D Noise Cloud (fbm/value, w=time)",
	homogeneous: "02 - Homogeneous Divide (clip space)",
	quatOrbit: "03 - Quat Axis-Angle Orbit (transformQuat)",
	quatSpring: "04 - Quaternion Spring (quatSpringDamp)",
	spring4d: "05 - 4D Spring Lissajous (springDamp4)",
	curve4d: "06 - 4D Curve Loop (catmull/bezier/hermite)",
	nlerp: "07 - Nlerp Ping-Pong Blend",
	colorPipe: "08 - Color Pipeline (sRGB/expose/premul)",
	batchMat4: "09 - Batch SOA mat4 Transform",
	floatOrigin: "10 - Floating Origin (soaToRelative)"
};

const params = {
	noiseScale: 0.35, noiseAmp: 1.6, noiseSpeed: 0.6, noiseSize: 0.06, noiseRotate: true,
	homAmp: 0.85, homFreq: 3.0, homSpeed: 1.2,
	orbitSpeed: 0.8, orbitPrec: 0.5,
	qsSmooth: 0.25, qsMaxSpeed: 30, qsSpeed: 1.0,
	sp4Smooth: 0.30, sp4Amp: 3.0, sp4Speed: 1.0,
	cvSpeed: 0.12, cvType: "catmullRom",
	nlSpeed: 0.35,
	cpAmp: 1.4, cpSpeed: 0.8, cpPremul: false,
	bmSpeed: 0.5, bmTilt: 0.45,
	foRadius: 60, foSpeed: 0.5, foSimulate: false
};

const state = { time: 0, frame: 0, infoTimer: 0, mode: MODE_KEYS[0] };

let renderer = null, scene = null, camera = null, controls = null, clock = null;
let modeGroup = null, modeHandle = null;

const ui = { panel: null, dynamic: null, info: null, status: null, select: null };

const T1 = Vec4.create();
const T2 = Vec4.create();
const T3 = Vec4.create();
const Q1 = Vec4.create();
const Q2 = Vec4.create();
const Q3 = Vec4.create();

function fract(x) { return x - Math.floor(x); }
function tri(x) { const f = fract(x); return f < 0.5 ? f * 2 : 2 - f * 2; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function ramp(n, col, j) {
	const t = clamp01(n);
	col[j] = 0.15 + 0.85 * t * t;
	col[j + 1] = 0.25 + 0.75 * t;
	col[j + 2] = 1.0 - 0.75 * t;
}

function dynPoints(count, size, additive) {
	const geometry = new THREE.BufferGeometry();
	const pos = new Float32Array(count * 3);
	const col = new Float32Array(count * 3);
	const pa = new THREE.BufferAttribute(pos, 3); pa.setUsage(THREE.DynamicDrawUsage);
	const ca = new THREE.BufferAttribute(col, 3); ca.setUsage(THREE.DynamicDrawUsage);
	geometry.setAttribute("position", pa);
	geometry.setAttribute("color", ca);
	const material = new THREE.PointsMaterial({
		size: size, vertexColors: true, transparent: true, opacity: 0.95,
		depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
	});
	const points = new THREE.Points(geometry, material);
	points.frustumCulled = false;
	return { geometry, material, points, pos, col, count };
}

function disposeGroup(group) {
	group.traverse(function (obj) {
		if (obj.geometry) obj.geometry.dispose();
		if (obj.material) {
			if (Array.isArray(obj.material)) obj.material.forEach(function (m) { m.dispose(); });
			else obj.material.dispose();
		}
	});
	group.clear();
}

// ============================================================================
// MODE 01 -- 4D NOISE CLOUD (continuous breathing cycle via w = sin(t))
// ============================================================================
function createNoise4dMode(group) {
	const N = 120000;
	const soa = Vec4.createVec4SOA(N);
	const bx = new Float32Array(N), by = new Float32Array(N), bz = new Float32Array(N);
	const dx = new Float32Array(N), dy = new Float32Array(N), dz = new Float32Array(N);
	const ph = new Float32Array(N);

	for (let i = 0; i < N; i++) {
		Vec4.random(T1, 6);
		bx[i] = T1[0]; by[i] = T1[1] * 0.6; bz[i] = T1[2];
		const l = Math.sqrt(bx[i] * bx[i] + by[i] * by[i] + bz[i] * bz[i]) || 1;
		dx[i] = bx[i] / l; dy[i] = by[i] / l; dz[i] = bz[i] / l;
		ph[i] = (i / N) * Math.PI * 2;
		soa.x[i] = bx[i]; soa.y[i] = by[i]; soa.z[i] = bz[i]; soa.w[i] = ph[i];
	}

	const hp = dynPoints(N, params.noiseSize, true);
	group.add(hp.points);

	return {
		buildUI: function (api) {
			api.addSlider("Noise scale", 0.05, 1.2, 0.01, params.noiseScale, function (v) { params.noiseScale = v; });
			api.addSlider("Amplitude", 0, 4, 0.05, params.noiseAmp, function (v) { params.noiseAmp = v; });
			api.addSlider("Cycle speed", 0.05, 3, 0.01, params.noiseSpeed, function (v) { params.noiseSpeed = v; });
			api.addSlider("Point size", 0.01, 0.2, 0.005, params.noiseSize, function (v) { params.noiseSize = v; hp.material.size = v; });
			api.addCheckbox("Auto rotate", params.noiseRotate, function (v) { params.noiseRotate = v; });
		},
		update: function (dt, t) {
			const wBase = Math.sin(t * params.noiseSpeed) * 1.7;
			const f = params.noiseScale, amp = params.noiseAmp;
			for (let i = 0; i < N; i++) {
				const n = Vec4.valueNoise4D(bx[i] * f, by[i] * f, bz[i] * f, wBase + Math.sin(ph[i] + t * params.noiseSpeed) * 0.35);
				const d = (n - 0.5) * 2 * amp;
				const j = i * 3;
				hp.pos[j] = bx[i] + dx[i] * d;
				hp.pos[j + 1] = by[i] + dy[i] * d;
				hp.pos[j + 2] = bz[i] + dz[i] * d;
				ramp(n, hp.col, j);
			}
			hp.geometry.attributes.position.needsUpdate = true;
			hp.geometry.attributes.color.needsUpdate = true;
			if (params.noiseRotate) hp.points.rotation.y += dt * 0.08;
		},
		getInfo: function () {
			return "valueNoise4D(x,y,z,w) with w = sin(t)*1.7\ncontinuous breathing cycle\npoints = " + N;
		}
	};
}

// ============================================================================
// MODE 02 -- HOMOGENEOUS DIVIDE (w oscillates => cyclic perspective warp)
// ============================================================================
function createHomogeneousMode(group) {
	const G = 64, N = G * G;
	const hp = dynPoints(N, 0.07, true);
	const gx = new Float32Array(N), gy = new Float32Array(N);
	for (let y = 0; y < G; y++) {
		for (let x = 0; x < G; x++) {
			const i = y * G + x;
			gx[i] = (x / (G - 1)) * 2 - 1;
			gy[i] = (y / (G - 1)) * 2 - 1;
		}
	}
	group.add(hp.points);

	const marker = new THREE.Mesh(
		new THREE.SphereGeometry(0.12, 20, 14),
		new THREE.MeshBasicMaterial({ color: 0xffb347 })
	);
	group.add(marker);

	const clipA = Vec4.fromValues(-0.85, -0.85, 0, 1);

	return {
		buildUI: function (api) {
			api.addSlider("w amplitude", 0, 0.95, 0.01, params.homAmp, function (v) { params.homAmp = v; });
			api.addSlider("w frequency", 0.5, 8, 0.1, params.homFreq, function (v) { params.homFreq = v; });
			api.addSlider("Cycle speed", 0.1, 4, 0.05, params.homSpeed, function (v) { params.homSpeed = v; });
		},
		update: function (dt, t) {
			const R = 7;
			for (let i = 0; i < N; i++) {
				const w = 1 + params.homAmp * Math.sin(t * params.homSpeed + (gx[i] + gy[i] * 0.7) * params.homFreq);
				Vec4.set(T1, gx[i], gy[i], 0, w);
				Vec4.perspectiveDivide(T2, T1);
				const j = i * 3;
				hp.pos[j] = T2[0] * R;
				hp.pos[j + 1] = T2[1] * R;
				hp.pos[j + 2] = (w - 1) * 1.5;
				ramp(clamp01((w - (1 - params.homAmp)) / (2 * params.homAmp || 1)), hp.col, j);
			}
			hp.geometry.attributes.position.needsUpdate = true;
			hp.geometry.attributes.color.needsUpdate = true;

			Vec4.set(T3, 0.85, 0.85, 0, 1 + 0.9 * Math.sin(t * params.homSpeed));
			Vec4.projectLerp(T1, clipA, T3, tri(t * 0.25));
			Vec4.perspectiveDivide(T2, T1);
			marker.position.set(T2[0] * R, T2[1] * R, (T1[3] - 1) * 1.5);
		},
		getInfo: function () {
			return "perspectiveDivide + projectLerp\nw = 1 + A*sin(t + k)  (continuous cycle)\nmarker = projective lerp ping-pong";
		}
	};
}

// ============================================================================
// MODE 03 -- QUAT AXIS-ANGLE ORBIT (continuous spin + precessing axis)
// ============================================================================
function createQuatOrbitMode(group) {
	const N = 2048;
	const hp = dynPoints(N, 0.08, true);
	const bx = new Float32Array(N * 3);
	for (let i = 0; i < N; i++) {
		const u = (i / N) * Math.PI * 2 * 3;
		const v = (i / N) * Math.PI * 2;
		const r = 4 + Math.sin(u * 0.7) * 1.2;
		bx[i * 3] = Math.cos(u) * r;
		bx[i * 3 + 1] = Math.sin(v * 5) * 1.4 + Math.sin(u) * r * 0.35;
		bx[i * 3 + 2] = Math.sin(u) * r;
		const j = i * 3;
		ramp(fract(i / N), hp.col, j);
	}
	group.add(hp.points);

	return {
		buildUI: function (api) {
			api.addSlider("Spin speed", 0, 3, 0.02, params.orbitSpeed, function (v) { params.orbitSpeed = v; });
			api.addSlider("Axis precession", 0, 2, 0.01, params.orbitPrec, function (v) { params.orbitPrec = v; });
		},
		update: function (dt, t) {
			const p = params.orbitPrec;
			Vec4.set(T1, Math.sin(t * p), Math.cos(t * p * 0.8), 0.55, 0);
			Vec4.normalize(T1, T1);
			Vec4.quatFromAxisAngle(Q1, T1, t * params.orbitSpeed);
			for (let i = 0; i < N; i++) {
				const j = i * 3;
				Vec4.set(T2, bx[j], bx[j + 1], bx[j + 2], 1);
				Vec4.transformQuat(T2, T2, Q1);
				hp.pos[j] = T2[0]; hp.pos[j + 1] = T2[1]; hp.pos[j + 2] = T2[2];
			}
			hp.geometry.attributes.position.needsUpdate = true;
		},
		getInfo: function () {
			return "quatFromAxisAngle + transformQuat\naxis precesses (cycle), angle = t*speed\nw component preserved (=1)";
		}
	};
}

// ============================================================================
// MODE 04 -- QUATERNION SPRING chasing a cyclic target
// ============================================================================
function createQuatSpringMode(group) {
	const geo = new THREE.BoxGeometry(2.2, 0.7, 1.2);
	const mat = new THREE.MeshStandardMaterial({ color: 0x35c8ff, roughness: 0.3, metalness: 0.3, emissive: 0x06222e });
	const box = new THREE.Mesh(geo, mat);
	const ghost = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff5d73, wireframe: true }));
	group.add(box); group.add(ghost);

	const q = Vec4.create();
	const vel = Vec4.create();
	Vec4.quatIdentity(q);

	return {
		buildUI: function (api) {
			api.addSlider("Smooth time", 0.02, 1.2, 0.01, params.qsSmooth, function (v) { params.qsSmooth = v; });
			api.addSlider("Max speed", 1, 100, 1, params.qsMaxSpeed, function (v) { params.qsMaxSpeed = v; });
			api.addSlider("Target speed", 0.1, 3, 0.02, params.qsSpeed, function (v) { params.qsSpeed = v; });
		},
		update: function (dt, t) {
			Vec4.set(T1, Math.sin(t * 0.3), 1, Math.cos(t * 0.3), 0);
			Vec4.normalize(T1, T1);
			Vec4.quatFromAxisAngle(Q2, T1, Math.sin(t * params.qsSpeed) * Math.PI * 0.9);
			Vec4.quatSpringDamp(q, q, Q2, vel, params.qsSmooth, dt, params.qsMaxSpeed);
			box.quaternion.set(q[0], q[1], q[2], q[3]);
			ghost.quaternion.set(Q2[0], Q2[1], Q2[2], Q2[3]);
			this._dot = Vec4.dot(q, Q2);
		},
		getInfo: function () {
			return "quatSpringDamp (critically damped)\ntarget angle = sin(t)*0.9 PI (cycle)\ndot(q,target) = " + (this._dot || 1).toFixed(4);
		}
	};
}

// ============================================================================
// MODE 05 -- 4D SPRING LISSAJOUS (continuous periodic target)
// ============================================================================
function createSpring4dMode(group) {
	const marker = new THREE.Mesh(
		new THREE.SphereGeometry(0.22, 24, 16),
		new THREE.MeshStandardMaterial({ color: 0x7cffb2, roughness: 0.25, metalness: 0.2, emissive: 0x0c3318 })
	);
	group.add(marker);

	const TN = 240;
	const tGeo = new THREE.BufferGeometry();
	const tPos = new Float32Array(TN * 3);
	tGeo.setAttribute("position", new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage));
	const trail = new THREE.Line(tGeo, new THREE.LineBasicMaterial({ color: 0x8ea2b8, transparent: true, opacity: 0.6 }));
	trail.frustumCulled = false;
	group.add(trail);

	const cur = Vec4.create();
	const vel = Vec4.create();
	const tgt = Vec4.create();
	let head = 0;

	return {
		buildUI: function (api) {
			api.addSlider("Smooth time", 0.02, 1.5, 0.01, params.sp4Smooth, function (v) { params.sp4Smooth = v; });
			api.addSlider("Amplitude", 1, 6, 0.1, params.sp4Amp, function (v) { params.sp4Amp = v; });
			api.addSlider("Cycle speed", 0.1, 3, 0.02, params.sp4Speed, function (v) { params.sp4Speed = v; });
		},
		update: function (dt, t) {
			const s = t * params.sp4Speed, A = params.sp4Amp;
			Vec4.set(tgt,
				A * Math.sin(1.0 * s),
				A * Math.sin(0.7 * s + 1.3),
				A * Math.sin(1.3 * s + 2.1),
				2.0 * Math.sin(0.5 * s + 0.7));
			Vec4.springDamp4(cur, cur, tgt, vel, params.sp4Smooth, dt, Infinity);
			marker.position.set(cur[0], cur[1], cur[2]);
			const wN = clamp01((cur[3] + 2) / 4);
			marker.material.emissive.setRGB(wN * 0.4, 0.2 + wN * 0.4, 0.3 - wN * 0.2);
			marker.scale.setScalar(0.7 + wN * 0.8);

			tPos[head * 3] = cur[0]; tPos[head * 3 + 1] = cur[1]; tPos[head * 3 + 2] = cur[2];
			head = (head + 1) % TN;
			for (let k = 0; k < TN; k++) {
				const src = (head + k) % TN;
				tGeo.attributes.position.array[k * 3] = tPos[src * 3];
				tGeo.attributes.position.array[k * 3 + 1] = tPos[src * 3 + 1];
				tGeo.attributes.position.array[k * 3 + 2] = tPos[src * 3 + 2];
			}
			tGeo.attributes.position.needsUpdate = true;
		},
		getInfo: function () {
			return "springDamp4 on a 4D Lissajous target\nw drives scale + emissive (cycle)\nvec4 = " + Vec4.str(cur);
		}
	};
}

// ============================================================================
// MODE 06 -- 4D CURVE LOOP (marker cycles forever along the loop)
// ============================================================================
function createCurve4dMode(group) {
	const P = [
		Vec4.fromValues(4.5, 0.5, 0, 1.5),
		Vec4.fromValues(0, 3.5, 2.5, -1),
		Vec4.fromValues(-4.5, -0.5, -1, 2),
		Vec4.fromValues(0, -3.5, 2, 0.5)
	];
	const SEG = 640, LN = SEG * 4;
	const lGeo = new THREE.BufferGeometry();
	const lPos = new Float32Array(LN * 3);
	const lCol = new Float32Array(LN * 3);
	for (let s = 0; s < 4; s++) {
		const p0 = P[(s + 3) % 4], p1 = P[s], p2 = P[(s + 1) % 4], p3 = P[(s + 2) % 4];
		for (let k = 0; k < SEG; k++) {
			const u = k / SEG;
			Vec4.catmullRom(T1, p0, p1, p2, p3, u);
			const i = s * SEG + k, j = i * 3;
			lPos[j] = T1[0]; lPos[j + 1] = T1[1]; lPos[j + 2] = T1[2];
			ramp(clamp01((T1[3] + 1.5) / 3.5), lCol, j);
		}
	}
	lGeo.setAttribute("position", new THREE.BufferAttribute(lPos, 3));
	lGeo.setAttribute("color", new THREE.BufferAttribute(lCol, 3));
	const loop = new THREE.LineLoop(lGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
	loop.frustumCulled = false;
	group.add(loop);

	const marker = new THREE.Mesh(
		new THREE.SphereGeometry(0.16, 20, 14),
		new THREE.MeshBasicMaterial({ color: 0xeaffff })
	);
	group.add(marker);

	return {
		buildUI: function (api) {
			api.addSlider("Loop speed", 0.01, 0.6, 0.005, params.cvSpeed, function (v) { params.cvSpeed = v; });
			api.addSelect("Evaluator", ["catmullRom", "cubicBezier", "hermite"], params.cvType, function (v) { params.cvType = v; });
		},
		update: function (dt, t) {
			const u = fract(t * params.cvSpeed);
			if (params.cvType === "catmullRom") {
				const fu = u * 4, s = Math.floor(fu) % 4, lu = fu - Math.floor(fu);
				Vec4.catmullRom(T1, P[(s + 3) % 4], P[s], P[(s + 1) % 4], P[(s + 2) % 4], lu);
			} else if (params.cvType === "cubicBezier") {
				Vec4.cubicBezier(T1, P[0], P[1], P[2], P[3], tri(u));
			} else {
				Vec4.hermite(T1, P[0], P[1], P[2], P[3], tri(u));
			}
			marker.position.set(T1[0], T1[1], T1[2]);
			marker.material.color.setRGB(clamp01(0.5 + T1[3] * 0.3), clamp01(0.8 - T1[3] * 0.15), clamp01(0.6 - T1[3] * 0.2));
		},
		getInfo: function () {
			return "closed 4D catmull-rom loop (line)\nmarker cycles u = fract(t*speed)\nw mapped to color";
		}
	};
}

// ============================================================================
// MODE 07 -- NLERP PING-PONG between two quaternions
// ============================================================================
function createNlerpMode(group) {
	const geo = new THREE.ConeGeometry(1.1, 2.6, 24);
	const mkA = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff5d73, wireframe: true }));
	const mkB = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x35c8ff, wireframe: true }));
	const mkM = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x7cffb2, roughness: 0.3, metalness: 0.25, emissive: 0x0c3318 }));
	mkA.position.x = -3.4; mkB.position.x = 3.4;
	group.add(mkA); group.add(mkB); group.add(mkM);

	Vec4.quatFromAxisAngle(Q1, Vec4.fromValues(1, 0, 0, 0), Math.PI * 0.55);
	Vec4.quatFromAxisAngle(Q2, Vec4.fromValues(0, 0.6, 1, 0), Math.PI * 0.8);
	mkA.quaternion.set(Q1[0], Q1[1], Q1[2], Q1[3]);
	mkB.quaternion.set(Q2[0], Q2[1], Q2[2], Q2[3]);

	const q = Vec4.create();

	return {
		buildUI: function (api) {
			api.addSlider("Ping-pong speed", 0.05, 2, 0.01, params.nlSpeed, function (v) { params.nlSpeed = v; });
		},
		update: function (dt, t) {
			const k = tri(t * params.nlSpeed);
			Vec4.nlerp(q, Q1, Q2, k);
			mkM.quaternion.set(q[0], q[1], q[2], q[3]);
			this._k = k;
		},
		getInfo: function () {
			return "nlerp(qA,qB,tri(t)) normalized lerp\ncontinuous ping-pong cycle\nt = " + (this._k || 0).toFixed(3);
		}
	};
}

// ============================================================================
// MODE 08 -- COLOR PIPELINE on a vec4 SOA (cyclic exposure breathing)
// ============================================================================
function createColorPipeMode(group) {
	const G = 96, N = G * G;
	const base = Vec4.createVec4SOA(N);
	const work = Vec4.createVec4SOA(N);
	for (let y = 0; y < G; y++) {
		for (let x = 0; x < G; x++) {
			const i = y * G + x;
			const u = x / (G - 1), v = y / (G - 1);
			base.x[i] = clamp01(0.2 + u * 0.9);
			base.y[i] = clamp01(0.15 + v * 0.7);
			base.z[i] = clamp01(0.9 - u * 0.5 + v * 0.2);
			base.w[i] = ((x + y) & 1) ? 1.0 : 0.55;
		}
	}
	const hp = dynPoints(N, 0.09, false);
	for (let i = 0; i < N; i++) {
		const j = i * 3;
		hp.pos[j] = ((i % G) / (G - 1)) * 12 - 6;
		hp.pos[j + 1] = (Math.floor(i / G) / (G - 1)) * 12 - 6;
		hp.pos[j + 2] = 0;
	}
	group.add(hp.points);

	return {
		buildUI: function (api) {
			api.addSlider("Exposure amp", 0, 4, 0.05, params.cpAmp, function (v) { params.cpAmp = v; });
			api.addSlider("Cycle speed", 0.05, 3, 0.02, params.cpSpeed, function (v) { params.cpSpeed = v; });
			api.addCheckbox("Premultiply alpha", params.cpPremul, function (v) { params.cpPremul = v; });
		},
		update: function (dt, t) {
			Vec4.soaCopy(work, base);
			Vec4.soaSrgbToLinear(work);
			Vec4.soaExpose(work, 1 + params.cpAmp * (0.5 + 0.5 * Math.sin(t * params.cpSpeed)));
			Vec4.soaLinearToSrgb(work);
			for (let i = 0; i < N; i++) {
				const j = i * 3;
				if (params.cpPremul) {
					Vec4.set(T1, work.x[i], work.y[i], work.z[i], work.w[i]);
					Vec4.premultiplyAlpha(T1, T1);
					hp.col[j] = clamp01(T1[0]); hp.col[j + 1] = clamp01(T1[1]); hp.col[j + 2] = clamp01(T1[2]);
				} else {
					hp.col[j] = clamp01(work.x[i]); hp.col[j + 1] = clamp01(work.y[i]); hp.col[j + 2] = clamp01(work.z[i]);
				}
			}
			hp.geometry.attributes.color.needsUpdate = true;
			hp.material.opacity = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * params.cpSpeed));
		},
		getInfo: function () {
			return "srgbToLinear -> expose(1+A*sin t) -> linearToSrgb\noptional premultiplyAlpha (checker alpha)\nSOA points = " + N;
		}
	};
}

// ============================================================================
// MODE 09 -- BATCH SOA mat4 TRANSFORM (continuous rotation cycle)
// ============================================================================
function createBatchMat4Mode(group) {
	const N = 300000;
	const baseSOA = Vec4.createVec4SOA(N);
	const outSOA = Vec4.createVec4SOA(N);
	const hp = dynPoints(N, 0.05, true);
	for (let i = 0; i < N; i++) {
		const r = 2 + Math.pow(i / N, 0.6) * 7;
		const a = (i * 2.399963229728653);
		const y = (Math.sin(i * 12.9898) * 0.5) * (1.6 - r * 0.12);
		baseSOA.x[i] = Math.cos(a) * r;
		baseSOA.y[i] = y;
		baseSOA.z[i] = Math.sin(a) * r;
		baseSOA.w[i] = 1;
		ramp(clamp01(r / 9), hp.col, i * 3);
	}
	group.add(hp.points);

	const m4 = new THREE.Matrix4();
	const tiltAxis = new THREE.Vector3(1, 0, 0.35).normalize();

	return {
		buildUI: function (api) {
			api.addSlider("Spin speed", 0, 2.5, 0.02, params.bmSpeed, function (v) { params.bmSpeed = v; });
			api.addSlider("Tilt", 0, 1.2, 0.01, params.bmTilt, function (v) { params.bmTilt = v; });
			api.addButton("Async chunked transform (100k)", function () {
				const big = Vec4.createVec4SOA(100000);
				Vec4.soaCopy(big, baseSOA);
				const tmp = Vec4.createVec4SOA(100000);
				const t0 = performance.now();
				Vec4.soaTransformMat4Chunked(tmp, big, m4.elements, 65536, 8).then(function () {
					const ms = performance.now() - t0;
					setStatus("soaTransformMat4Chunked 100k in " + ms.toFixed(1) + " ms (yielded)");
				});
			});
		},
		update: function (dt, t) {
			m4.makeRotationAxis(tiltAxis, Math.sin(t * 0.4) * params.bmTilt);
			m4.premultiply(new THREE.Matrix4().makeRotationY(t * params.bmSpeed));
			Vec4.soaTransformMat4(outSOA, baseSOA, m4.elements);
			const ox = outSOA.x, oy = outSOA.y, oz = outSOA.z;
			for (let i = 0; i < N; i++) {
				const j = i * 3;
				hp.pos[j] = ox[i]; hp.pos[j + 1] = oy[i]; hp.pos[j + 2] = oz[i];
			}
			hp.geometry.attributes.position.needsUpdate = true;
		},
		getInfo: function () {
			return "soaTransformMat4 on " + N + " vec4 per frame\nrotation angle = t*speed (continuous cycle)\nchunked async button = mobile-safe path";
		}
	};
}

// ============================================================================
// MODE 10 -- FLOATING ORIGIN (origin orbits a far center; cyclic recentering)
// ============================================================================
function createFloatOriginMode(group) {
	const N = 20000;
	const CX = 1000000;
	const wx = new Float64Array(N), wy = new Float64Array(N), wz = new Float64Array(N);
	const wxF = new Float32Array(N), wyF = new Float32Array(N), wzF = new Float32Array(N);
	const rel = Vec4.createVec4SOA(N);
	const hp = dynPoints(N, 0.06, true);

	for (let i = 0; i < N; i++) {
		Vec4.random(T1, 7);
		wx[i] = CX + T1[0]; wy[i] = T1[1] * 0.5; wz[i] = T1[2];
		wxF[i] = wx[i]; wyF[i] = wy[i]; wzF[i] = wz[i];
		ramp(clamp01((T1[1] + 7) / 14), hp.col, i * 3);
	}
	group.add(hp.points);

	const origin = [CX, 0, 0];
	let maxErr = 0;

	return {
		buildUI: function (api) {
			api.addSlider("Orbit radius", 5, 200, 1, params.foRadius, function (v) { params.foRadius = v; });
			api.addSlider("Cycle speed", 0.05, 2, 0.01, params.foSpeed, function (v) { params.foSpeed = v; });
			api.addCheckbox("Simulate float32 absolute", params.foSimulate, function (v) { params.foSimulate = v; });
		},
		update: function (dt, t) {
			origin[0] = CX + Math.cos(t * params.foSpeed) * params.foRadius;
			origin[1] = Math.sin(t * params.foSpeed * 0.7) * params.foRadius * 0.35;
			origin[2] = Math.sin(t * params.foSpeed) * params.foRadius;

			if (params.foSimulate) {
				const fx = Math.fround(origin[0]), fy = Math.fround(origin[1]), fz = Math.fround(origin[2]);
				for (let i = 0; i < N; i++) {
					const j = i * 3;
					hp.pos[j] = Math.fround(wxF[i]) - fx;
					hp.pos[j + 1] = Math.fround(wyF[i]) - fy;
					hp.pos[j + 2] = Math.fround(wzF[i]) - fz;
				}
			} else {
				Vec4.soaToRelative(rel, rel, 0, 0, 0);
				for (let i = 0; i < N; i++) {
					rel.x[i] = wx[i] - origin[0];
					rel.y[i] = wy[i] - origin[1];
					rel.z[i] = wz[i] - origin[2];
					rel.w[i] = 1;
					const j = i * 3;
					hp.pos[j] = rel.x[i]; hp.pos[j + 1] = rel.y[i]; hp.pos[j + 2] = rel.z[i];
				}
			}
			hp.geometry.attributes.position.needsUpdate = true;

			if ((state.frame & 31) === 0) {
				maxErr = 0;
				for (let i = 0; i < N; i += 37) {
					const e = Math.abs((Math.fround(wxF[i]) - Math.fround(origin[0])) - (wx[i] - origin[0]));
					if (e > maxErr) maxErr = e;
				}
			}
		},
		getInfo: function () {
			return "origin orbits center x=1e6 (cycle)\nrelative cloud stays crisp (Float64 math)\nfloat32-absolute max error = " + maxErr.toFixed(4);
		}
	};
}

const MODE_FACTORIES = {
	noise4d: createNoise4dMode,
	homogeneous: createHomogeneousMode,
	quatOrbit: createQuatOrbitMode,
	quatSpring: createQuatSpringMode,
	spring4d: createSpring4dMode,
	curve4d: createCurve4dMode,
	nlerp: createNlerpMode,
	colorPipe: createColorPipeMode,
	batchMat4: createBatchMat4Mode,
	floatOrigin: createFloatOriginMode
};

// ============================================================================
// UI
// ============================================================================
function createUI() {
	const panel = document.createElement("div");
	panel.className = "vec4-demo-panel";
	panel.style.cssText = "position:fixed;top:12px;right:12px;z-index:1000;width:350px;max-height:calc(100vh - 24px);overflow:auto;padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,0.12);background:rgba(8,11,16,0.72);color:#dfe8f2;font:12px/1.45 system-ui,sans-serif;backdrop-filter:blur(10px);";

	const title = document.createElement("div");
	title.textContent = "04_vec4_demo.js - 10 real-time examples";
	title.style.cssText = "font-weight:700;font-size:13px;margin-bottom:8px;";

	const select = document.createElement("select");
	select.style.cssText = "width:100%;margin-bottom:10px;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.35);color:#dfe8f2;";
	MODE_KEYS.forEach(function (k) {
		const o = document.createElement("option");
		o.value = k; o.textContent = MODE_LABELS[k];
		select.appendChild(o);
	});
	select.addEventListener("change", function () { setMode(select.value); });

	const dynamic = document.createElement("div");
	const status = document.createElement("div");
	status.style.cssText = "margin-top:8px;min-height:16px;color:#8ea2b8;font-family:ui-monospace,monospace;font-size:11px;";
	const info = document.createElement("pre");
	info.style.cssText = "margin:8px 0 0;padding:8px;border-radius:8px;background:rgba(255,255,255,0.05);color:#9fe8b5;font-family:ui-monospace,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;min-height:40px;";

	panel.appendChild(title);
	panel.appendChild(select);
	panel.appendChild(dynamic);
	panel.appendChild(status);
	panel.appendChild(info);
	container.appendChild(panel);

	ui.panel = panel; ui.select = select; ui.dynamic = dynamic; ui.status = status; ui.info = info;
}

function setStatus(msg) { ui.status.textContent = msg; }

const uiAPI = {
	addSection: function (label) {
		const d = document.createElement("div");
		d.textContent = label;
		d.style.cssText = "margin:10px 0 6px;font-weight:700;color:#7cc4ff;text-transform:uppercase;font-size:10px;letter-spacing:0.08em;";
		ui.dynamic.appendChild(d);
	},
	addSlider: function (label, min, max, step, value, onChange) {
		const row = document.createElement("div");
		row.style.cssText = "display:grid;grid-template-columns:104px 1fr 50px;gap:6px;align-items:center;margin:5px 0;";
		const lab = document.createElement("span"); lab.textContent = label; lab.style.opacity = "0.85";
		const inp = document.createElement("input");
		inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
		inp.style.cssText = "width:100%;accent-color:#35c8ff;";
		const val = document.createElement("span");
		val.textContent = (+value).toFixed(2);
		val.style.cssText = "text-align:right;font-family:ui-monospace,monospace;font-size:11px;";
		inp.addEventListener("input", function () { val.textContent = (+inp.value).toFixed(2); onChange(+inp.value); });
		row.appendChild(lab); row.appendChild(inp); row.appendChild(val);
		ui.dynamic.appendChild(row);
	},
	addSelect: function (label, options, value, onChange) {
		const row = document.createElement("div");
		row.style.cssText = "display:grid;grid-template-columns:104px 1fr;gap:6px;align-items:center;margin:5px 0;";
		const lab = document.createElement("span"); lab.textContent = label; lab.style.opacity = "0.85";
		const sel = document.createElement("select");
		sel.style.cssText = "width:100%;padding:4px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.35);color:#dfe8f2;";
		options.forEach(function (o) {
			const op = document.createElement("option"); op.value = o; op.textContent = o; sel.appendChild(op);
		});
		sel.value = value;
		sel.addEventListener("change", function () { onChange(sel.value); });
		row.appendChild(lab); row.appendChild(sel);
		ui.dynamic.appendChild(row);
	},
	addCheckbox: function (label, value, onChange) {
		const row = document.createElement("label");
		row.style.cssText = "display:flex;gap:8px;align-items:center;margin:6px 0;cursor:pointer;";
		const inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = !!value;
		inp.style.accentColor = "#35c8ff";
		inp.addEventListener("change", function () { onChange(inp.checked); });
		const lab = document.createElement("span"); lab.textContent = label; lab.style.opacity = "0.85";
		row.appendChild(inp); row.appendChild(lab);
		ui.dynamic.appendChild(row);
	},
	addButton: function (label, onClick) {
		const b = document.createElement("button");
		b.textContent = label;
		b.style.cssText = "width:100%;margin:6px 0;padding:7px 10px;border-radius:8px;border:1px solid rgba(53,200,255,0.3);background:rgba(53,200,255,0.1);color:#d8f5ff;cursor:pointer;font:inherit;";
		b.addEventListener("click", onClick);
		ui.dynamic.appendChild(b);
	}
};

function setMode(key) {
	if (MODE_KEYS.indexOf(key) === -1) key = MODE_KEYS[0];
	state.mode = key;
	if (modeHandle && modeHandle.dispose) modeHandle.dispose();
	if (modeGroup) { disposeGroup(modeGroup); scene.remove(modeGroup); }
	modeGroup = new THREE.Group();
	scene.add(modeGroup);
	modeHandle = MODE_FACTORIES[key](modeGroup);
	ui.dynamic.innerHTML = "";
	uiAPI.addSection(MODE_LABELS[key]);
	modeHandle.buildUI(uiAPI);
	ui.select.value = key;
	setStatus("Mode: " + MODE_LABELS[key]);
}

// ============================================================================
// BOOT
// ============================================================================
function getCanvas() {
	if (HOST.canvas) return HOST.canvas;
	let c = document.getElementById("vec4-demo-canvas");
	if (!c) {
		c = document.createElement("canvas");
		c.id = "vec4-demo-canvas";
		c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;";
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

	camera = new THREE.PerspectiveCamera(55, getWidth() / getHeight(), 0.1, 600);
	camera.position.set(9, 7, 14);

	controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.06;

	scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x080b10, 1.1));
	const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
	sun.position.set(8, 12, 6);
	scene.add(sun);

	const grid = new THREE.GridHelper(30, 30, 0x2b3948, 0x151c25);
	grid.material.transparent = true;
	grid.material.opacity = 0.3;
	scene.add(grid);

	clock = new THREE.Clock();
	createUI();
	setMode(state.mode);

	window.addEventListener("resize", function () {
		camera.aspect = getWidth() / getHeight();
		camera.updateProjectionMatrix();
		renderer.setSize(getWidth(), getHeight());
	});

	animate();
	globalThis.__VEC4_DEMO__ = { params: params, state: state, Vec4: Vec4, setMode: setMode };
}

function animate() {
	requestAnimationFrame(animate);
	const dt = Math.min(clock.getDelta(), 0.05);
	state.time += dt;
	state.frame++;
	controls.update();
	if (modeHandle) modeHandle.update(dt, state.time);
	state.infoTimer += dt;
	if (state.infoTimer > 0.25) {
		state.infoTimer = 0;
		ui.info.textContent = modeHandle && modeHandle.getInfo ? modeHandle.getInfo() : "";
	}
	renderer.render(scene, camera);
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init);
} else {
	init();
}