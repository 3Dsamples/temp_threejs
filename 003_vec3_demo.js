// File number : 003-demo
// File : src/math/003_vec3_demo.js
// Description : Three.js r185 demo for src/math/003_vec3.js.
//               Imports the complete vec3 math module and shows many practical
//               uses in a live 3D scene: SOA particle fields, procedural noise,
//               flat vector operations, animation curves, IK chains, spring
//               damping, orbital mechanics, spherical harmonics, tone mapping,
//               floating-origin recentering, and chunked async processing.
// License : MIT
//
// CORRECTION: bootstrap moved to the END of the module so every builder /
//             updater / enterFn assignment runs before setMode() is called.
//             setMode() is now defensive (typeof checks) so a missing builder
//             can never throw "builders[name] is not a function".
//             The UI panel now carries the .vec3-demo-panel class so the
//             external 003_vec3_demo.css responsive rules apply on mobile.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as Vec3 from "./math/003_vec3.js";

const host = globalThis.__VEC3_DEMO_HOST__ || {};
const container = host.container || document.body;

const MODES = [
	"particles",
	"vectors",
	"curves",
	"ik",
	"spring",
	"orbital",
	"sh"
];

const MODE_LABELS = {
	particles: "SOA / Procedural Particles",
	vectors: "Flat Vector Math",
	curves: "Animation Curves",
	ik: "IK FABRIK / CCD",
	spring: "Spring Damping",
	orbital: "Orbital Mechanics",
	sh: "Spherical Harmonics"
};

const params = {
	mode: "particles",
	particleCount: 50000,
	pointSize: 0.06,
	noiseScale: 0.08,
	octaves: 4,
	noiseKind: "fbm",
	colorMode: "fbm",
	animateParticles: true,

	vectorA: { x: 2.0, y: 1.0, z: 0.0 },
	vectorB: { x: -1.0, y: 1.6, z: 1.2 },

	curveType: "catmullRom",
	curveT: 0.35,
	showCurveControls: true,

	ikMethod: "fabrik",
	ikBones: 8,
	ikLength: 1.0,
	ikIterations: 10,
	ikTolerance: 0.01,
	ikAutoTarget: true,
	ikTargetX: 3.0,
	ikTargetY: 3.0,
	ikTargetZ: 0.0,

	springSmoothTime: 0.18,
	springMaxSpeed: 25,
	springAutoTarget: true,
	springTargetX: 3,
	springTargetY: 1,
	springTargetZ: 0,

	orbitalA: 6,
	orbitalE: 0.35,
	orbitalM0: 0,
	orbitalInc: 0.35,
	orbitalOm: 0.6,
	orbitalom: 1.2,
	orbitalSpeed: 0.8,
	orbitalMu: 1,
	orbitalShowVelocity: true,
	hohmannR2: 10,

	shAzimuth: 0.7,
	shElevation: 0.65,
	shEnergy: 2.2,
	shExposure: 1.0,
	shColorR: 1.0,
	shColorG: 0.9,
	shColorB: 0.72
};

const state = {
	time: 0,
	busy: false
};

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let clock = null;

const groups = {};
const builders = {};
const updaters = {};
const enterFns = {};

const ui = {
	panel: null,
	dynamic: null,
	status: null,
	info: null,
	modeSelect: null
};

let particles = null;
let vectors = null;
let curves = null;
let ik = null;
let spring = null;
let orbital = null;
let sh = null;

const _tmpVecA = Vec3.create();
const _tmpVecB = Vec3.create();
const _tmpVecC = Vec3.create();
const _tmpVecD = Vec3.create();
const _tmpColor = Vec3.create();
const _tmpVoronoi = Vec3.create();
const _threeVec = new THREE.Vector3();
const _threeVec2 = new THREE.Vector3();
const _threeMat4 = new THREE.Matrix4();

// ============================================================================
// BOOT
// ============================================================================
function init() {
	createRenderer();
	createScene();
	createUI();
	buildModeGroups();
	ensureVectors();
	ensureCurves();
	ensureIK();
	ensureSpring();
	ensureOrbital();
	ensureSH();
	setMode(params.mode);
	animate();
	window.addEventListener("resize", onResize);
	globalThis.__VEC3_DEMO__ = { params, state, setMode, Vec3 };
}

function createRenderer() {
	const canvas = host.canvas || getOrCreateCanvas();

	renderer = new THREE.WebGLRenderer({
		canvas: canvas,
		antialias: true,
		powerPreference: "high-performance"
	});

	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setSize(getWidth(), getHeight());
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.0;

	clock = new THREE.Clock();
}

function getOrCreateCanvas() {
	let canvas = document.getElementById("vec3-demo-canvas");

	if (!canvas) {
		canvas = document.createElement("canvas");
		canvas.id = "vec3-demo-canvas";
		canvas.style.position = "absolute";
		canvas.style.left = "0";
		canvas.style.top = "0";
		canvas.style.width = "100%";
		canvas.style.height = "100%";
		canvas.style.display = "block";
		canvas.style.touchAction = "none";
		container.appendChild(canvas);
	}

	return canvas;
}

function createScene() {
	scene = new THREE.Scene();
	scene.background = new THREE.Color(0x070b10);
	scene.fog = new THREE.Fog(0x070b10, 30, 110);

	camera = new THREE.PerspectiveCamera(55, getWidth() / getHeight(), 0.1, 500);
	camera.position.set(10, 8, 14);

	controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.06;
	controls.target.set(0, 1, 0);

	const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x080b10, 1.1);
	hemi.position.set(0, 20, 0);
	scene.add(hemi);

	const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
	sun.position.set(8, 12, 6);
	scene.add(sun);

	const grid = new THREE.GridHelper(36, 36, 0x2b3948, 0x151c25);
	grid.material.transparent = true;
	grid.material.opacity = 0.32;
	scene.add(grid);

	const axes = new THREE.AxesHelper(3);
	axes.position.set(0, 0.001, 0);
	scene.add(axes);
}

function buildModeGroups() {
	for (let i = 0; i < MODES.length; i++) {
		const key = MODES[i];
		const group = new THREE.Group();
		group.name = key;
		group.visible = false;
		scene.add(group);
		groups[key] = group;
	}
}

function getWidth() {
	return container.clientWidth || window.innerWidth || 1;
}

function getHeight() {
	return container.clientHeight || window.innerHeight || 1;
}

function onResize() {
	const w = getWidth();
	const h = getHeight();

	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	renderer.setSize(w, h);
}

function animate() {
	requestAnimationFrame(animate);

	const dt = Math.min(clock.getDelta(), 0.05);
	state.time += dt;

	controls.update();

	const updater = updaters[params.mode];

	if (typeof updater === "function") {
		updater(dt);
	}

	renderer.render(scene, camera);
}

// CORRECTION: defensive lookups -- a missing builder can no longer throw.
function setMode(name) {
	if (MODES.indexOf(name) === -1) {
		name = "particles";
	}

	params.mode = name;

	for (let i = 0; i < MODES.length; i++) {
		const key = MODES[i];
		groups[key].visible = key === name;
	}

	if (ui.modeSelect) {
		ui.modeSelect.value = name;
	}

	clearDynamicUI();

	if (typeof builders[name] === "function") {
		builders[name]();
	}

	if (typeof enterFns[name] === "function") {
		enterFns[name]();
	}

	setInfo(MODE_LABELS[name] + " ready.");
}

// ============================================================================
// UI
// ============================================================================
function createUI() {
	const panel = document.createElement("div");
	panel.classList.add("vec3-demo-panel");

	panel.style.cssText = [
		"position:fixed",
		"top:12px",
		"right:12px",
		"z-index:1000",
		"width:360px",
		"max-height:calc(100vh - 24px)",
		"overflow:auto",
		"padding:12px",
		"border-radius:14px",
		"border:1px solid rgba(255,255,255,0.12)",
		"background:rgba(8,11,16,0.84)",
		"color:#dfe8f2",
		"font:12px/1.45 system-ui, sans-serif",
		"backdrop-filter:blur(10px)",
		"box-shadow:0 12px 36px rgba(0,0,0,0.35)"
	].join(";");

	const title = document.createElement("div");
	title.textContent = "003_vec3_demo.js";
	title.style.fontWeight = "700";
	title.style.fontSize = "14px";
	title.style.marginBottom = "8px";

	const modeLabel = document.createElement("div");
	modeLabel.textContent = "Example mode";
	modeLabel.style.opacity = "0.75";
	modeLabel.style.marginBottom = "4px";

	const modeSelect = document.createElement("select");
	modeSelect.style.cssText = "width:100%;margin-bottom:10px;";

	for (let i = 0; i < MODES.length; i++) {
		const key = MODES[i];
		const option = document.createElement("option");
		option.value = key;
		option.textContent = MODE_LABELS[key];
		modeSelect.appendChild(option);
	}

	modeSelect.value = params.mode;
	modeSelect.addEventListener("change", function () {
		setMode(modeSelect.value);
	});

	const dynamic = document.createElement("div");

	const status = document.createElement("div");
	status.style.marginTop = "10px";
	status.style.minHeight = "16px";
	status.style.color = "#8ea2b8";

	const info = document.createElement("pre");
	info.style.cssText = [
		"margin:10px 0 0",
		"padding:8px",
		"border-radius:8px",
		"background:rgba(255,255,255,0.05)",
		"white-space:pre-wrap",
		"word-break:break-word",
		"color:#9fe8b5",
		"min-height:34px"
	].join(";");

	panel.appendChild(title);
	panel.appendChild(modeLabel);
	panel.appendChild(modeSelect);
	panel.appendChild(dynamic);
	panel.appendChild(status);
	panel.appendChild(info);

	container.appendChild(panel);

	ui.panel = panel;
	ui.dynamic = dynamic;
	ui.status = status;
	ui.info = info;
	ui.modeSelect = modeSelect;
}

function clearDynamicUI() {
	if (ui.dynamic) {
		ui.dynamic.innerHTML = "";
	}
}

function setBusy(message) {
	state.busy = true;
	ui.status.textContent = message || "Working...";
}

function clearBusy() {
	state.busy = false;
	ui.status.textContent = "";
}

function setInfo(text) {
	ui.info.textContent = text;
}

function addSection(title) {
	const div = document.createElement("div");
	div.textContent = title;
	div.style.cssText = "margin:10px 0 6px;font-weight:700;color:#7cc4ff;";
	ui.dynamic.appendChild(div);
}

function addSlider(label, min, max, step, value, onChange) {
	const row = document.createElement("div");
	row.style.cssText = "display:grid;grid-template-columns:110px 1fr 52px;gap:6px;align-items:center;margin:5px 0;";

	const lab = document.createElement("span");
	lab.textContent = label;
	lab.style.opacity = "0.85";

	const input = document.createElement("input");
	input.type = "range";
	input.min = String(min);
	input.max = String(max);
	input.step = String(step);
	input.value = String(value);

	const val = document.createElement("span");
	val.style.textAlign = "right";
	val.style.fontVariantNumeric = "tabular-nums";
	val.textContent = formatNumber(value, step);

	input.addEventListener("input", function () {
		const x = parseFloat(input.value);
		val.textContent = formatNumber(x, step);
		onChange(x);
	});

	row.appendChild(lab);
	row.appendChild(input);
	row.appendChild(val);
	ui.dynamic.appendChild(row);

	return input;
}

function addSelect(label, options, value, onChange) {
	const row = document.createElement("div");
	row.style.cssText = "display:grid;grid-template-columns:110px 1fr;gap:6px;align-items:center;margin:5px 0;";

	const lab = document.createElement("span");
	lab.textContent = label;
	lab.style.opacity = "0.85";

	const select = document.createElement("select");
	select.style.width = "100%";

	for (let i = 0; i < options.length; i++) {
		const option = document.createElement("option");
		option.value = String(options[i]);
		option.textContent = String(options[i]);
		select.appendChild(option);
	}

	select.value = String(value);
	select.addEventListener("change", function () {
		onChange(select.value);
	});

	row.appendChild(lab);
	row.appendChild(select);
	ui.dynamic.appendChild(row);

	return select;
}

function addButton(label, onClick) {
	const button = document.createElement("button");
	button.textContent = label;
	button.style.cssText = [
		"width:100%",
		"margin:6px 0",
		"padding:7px 10px",
		"border:1px solid rgba(124,196,255,0.28)",
		"border-radius:8px",
		"background:rgba(53,200,255,0.10)",
		"color:#d8f5ff",
		"cursor:pointer"
	].join(";");

	button.addEventListener("click", function () {
		try {
			onClick();
		} catch (err) {
			console.error(err);
			setInfo("Error: " + err.message);
			clearBusy();
		}
	});

	ui.dynamic.appendChild(button);
	return button;
}

function addCheckbox(label, value, onChange) {
	const row = document.createElement("label");
	row.style.cssText = "display:flex;gap:8px;align-items:center;margin:6px 0;cursor:pointer;";

	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = !!value;
	input.addEventListener("change", function () {
		onChange(input.checked);
	});

	const lab = document.createElement("span");
	lab.textContent = label;
	lab.style.opacity = "0.85";

	row.appendChild(input);
	row.appendChild(lab);
	ui.dynamic.appendChild(row);

	return input;
}

function formatNumber(value, step) {
	if (step >= 1) {
		return String(Math.round(value));
	}

	if (step >= 0.1) {
		return value.toFixed(1);
	}

	if (step >= 0.01) {
		return value.toFixed(2);
	}

	return value.toFixed(3);
}

function yieldToMain() {
	return new Promise(function (resolve) {
		setTimeout(resolve, 0);
	});
}

async function rangesChunked(count, rangeFn, chunkSize, yieldEvery) {
	chunkSize = chunkSize || 65536;
	yieldEvery = yieldEvery || 8;

	let cycles = 0;

	for (let start = 0; start < count; start += chunkSize) {
		const end = Math.min(start + chunkSize, count);
		rangeFn(start, end);
		cycles++;

		if (cycles >= yieldEvery && end < count) {
			cycles = 0;
			await yieldToMain();
		}
	}
}

function clamp01(x) {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

function runAsync(promise, busyMessage) {
	setBusy(busyMessage);

	promise.then(function () {
		clearBusy();
	}).catch(function (err) {
		console.error(err);
		clearBusy();
		setInfo("Async error: " + err.message);
	});
}

// ============================================================================
// MODE 1 -- SOA / PROCEDURAL PARTICLES
// ============================================================================
builders.particles = function () {
	addSection("Particle SOA");

	addSelect("Count", ["10000", "50000", "100000", "250000", "500000", "1000000"], String(params.particleCount), function (value) {
		params.particleCount = parseInt(value, 10);
		runAsync(rebuildParticles(), "Rebuilding " + params.particleCount + " particles...");
	});

	addSlider("Point size", 0.01, 0.25, 0.001, params.pointSize, function (value) {
		params.pointSize = value;

		if (particles && particles.material) {
			particles.material.size = value;
		}
	});

	addSlider("Noise scale", 0.001, 0.75, 0.001, params.noiseScale, function (value) {
		params.noiseScale = value;
	});

	addSlider("Octaves", 1, 8, 1, params.octaves, function (value) {
		params.octaves = value;
	});

	addSelect("Noise kind", ["fbm", "gradient", "value"], params.noiseKind, function (value) {
		params.noiseKind = value;
	});

	addSelect("Color mode", ["fbm", "voronoi", "height"], params.colorMode, function (value) {
		params.colorMode = value;
	});

	addCheckbox("Auto rotate", params.animateParticles, function (value) {
		params.animateParticles = value;
	});

	addSection("SOA operations");

	addButton("Random sphere positions", function () {
		runAsync(fillParticlesRandomSphere(particles), "Filling random sphere positions...");
	});

	addButton("Noise fill positions (chunked)", function () {
		runAsync(fillParticlesFromNoise(particles), "Running soaFillNoise3DChunked...");
	});

	addButton("Normalize + scale positions", function () {
		runAsync(normalizeAndScaleParticles(particles, 9), "Running soaNormalizeChunked + soaScaleChunked...");
	});

	addButton("Colorize by field (chunked)", function () {
		runAsync(colorizeParticles(particles), "Colorizing particles...");
	});

	addButton("Apply mat4 rotation Y 15 deg", function () {
		runAsync(rotateParticlesWithMat4(particles), "Running soaTransformMat4...");
	});

	addButton("Recenter to floating origin", function () {
		runAsync(recenterParticles(particles), "Recentering with soaToRelative...");
	});

	addButton("Compute AABB", function () {
		computeParticleAABB(particles);
	});
};

enterFns.particles = function () {
	if (!particles || particles.count !== params.particleCount) {
		runAsync(rebuildParticles(), "Building particle system...");
	}
};

updaters.particles = function (dt) {
	if (!particles || !particles.points) {
		return;
	}

	if (params.animateParticles) {
		particles.points.rotation.y += dt * 0.05;
	}
};

async function rebuildParticles() {
	const count = params.particleCount;

	disposeParticles();

	particles = {
		count: count,
		pos: Vec3.createVec3SOA(count),
		col: Vec3.createVec3SOA(count),
		flatPos: new Float32Array(count * 3),
		flatCol: new Float32Array(count * 3),
		geometry: null,
		material: null,
		points: null
	};

	setBusy("Filling random positions...");
	await fillParticlesRandomSphere(particles, true);

	setBusy("Colorizing...");
	await colorizeParticles(particles, true);

	setBusy("Syncing GPU buffers...");
	await syncParticleBuffers(particles);

	createParticleRenderObjects(particles);
	clearBusy();
	setInfo("Built " + count + " particles.\nUse buttons to run SOA operations.");
}

function disposeParticles() {
	if (!particles) {
		return;
	}

	if (particles.points) {
		groups.particles.remove(particles.points);
	}

	if (particles.geometry) {
		particles.geometry.dispose();
	}

	if (particles.material) {
		particles.material.dispose();
	}

	particles = null;
}

async function fillParticlesRandomSphere(p, skipSync) {
	if (!p) {
		return;
	}

	const tmp = Vec3.create();

	await rangesChunked(p.count, function (start, end) {
		for (let i = start; i < end; i++) {
			const radius = 2 + Math.random() * 9;
			Vec3.random(tmp, radius);

			p.pos.x[i] = tmp[0];
			p.pos.y[i] = tmp[1] * 0.55;
			p.pos.z[i] = tmp[2];
		}
	});

	if (!skipSync) {
		await syncParticleBuffers(p);
	}
}

async function fillParticlesFromNoise(p) {
	if (!p) {
		return;
	}

	await Vec3.soaFillNoise3DChunked(p.pos, params.noiseScale, params.octaves, params.noiseKind, 65536, 8);

	await rangesChunked(p.count, function (start, end) {
		for (let i = start; i < end; i++) {
			p.pos.x[i] = (p.pos.x[i] - 0.5) * 22;
			p.pos.y[i] = (p.pos.y[i] - 0.5) * 14;
			p.pos.z[i] = (p.pos.z[i] - 0.5) * 22;
		}
	});

	await colorizeParticles(p, true);
	await syncParticleBuffers(p);
	setInfo("soaFillNoise3DChunked wrote noise into position SOA.");
}

async function normalizeAndScaleParticles(p, radius) {
	if (!p) {
		return;
	}

	await Vec3.soaNormalizeChunked(p.pos, p.pos, 65536, 8);
	await Vec3.soaScaleChunked(p.pos, p.pos, radius || 9, 65536, 8);
	await syncParticleBuffers(p);
	setInfo("soaNormalizeChunked + soaScaleChunked mapped points to a sphere shell.");
}

async function rotateParticlesWithMat4(p) {
	if (!p) {
		return;
	}

	_threeMat4.identity();
	_threeMat4.makeRotationY(Math.PI / 12);

	Vec3.soaTransformMat4(p.pos, p.pos, _threeMat4.elements);

	await syncParticleBuffers(p);
	setInfo("soaTransformMat4 rotated the entire position SOA.");
}

async function recenterParticles(p) {
	if (!p) {
		return;
	}

	const box = {};
	Vec3.soaAABB(box, p.pos);

	const cx = (box.minX + box.maxX) * 0.5;
	const cy = (box.minY + box.maxY) * 0.5;
	const cz = (box.minZ + box.maxZ) * 0.5;

	Vec3.soaToRelative(p.pos, p.pos, cx, cy, cz);
	await syncParticleBuffers(p);

	setInfo(
		"Floating origin recenter:\n" +
		"old center = " + cx.toFixed(3) + ", " + cy.toFixed(3) + ", " + cz.toFixed(3) + "\n" +
		"soaToRelative subtracted origin from all positions."
	);
}

function computeParticleAABB(p) {
	if (!p) {
		return;
	}

	const box = {};
	Vec3.soaAABB(box, p.pos);

	const minComp = Vec3.soaMinComponent(p.pos);
	const maxComp = Vec3.soaMaxComponent(p.pos);

	setInfo(
		"soaAABB:\n" +
		"min = " + box.minX.toFixed(3) + ", " + box.minY.toFixed(3) + ", " + box.minZ.toFixed(3) + "\n" +
		"max = " + box.maxX.toFixed(3) + ", " + box.maxY.toFixed(3) + ", " + box.maxZ.toFixed(3) + "\n" +
		"soaMinComponent = " + minComp.toFixed(3) + "\n" +
		"soaMaxComponent = " + maxComp.toFixed(3)
	);
}

async function colorizeParticles(p, skipSync) {
	if (!p) {
		return;
	}

	const scale = params.noiseScale * 2.2;

	await rangesChunked(p.count, function (start, end) {
		for (let i = start; i < end; i++) {
			const x = p.pos.x[i];
			const y = p.pos.y[i];
			const z = p.pos.z[i];

			let n = 0.5;

			if (params.colorMode === "voronoi") {
				Vec3.voronoi3D(_tmpVoronoi, x * scale, y * scale, z * scale);
				n = clamp01(_tmpVoronoi[0] * 1.6);
			} else if (params.colorMode === "height") {
				n = clamp01((y + 10) / 20);
			} else {
				n = Vec3.fbm3D(x * scale, y * scale, z * scale, params.octaves);
			}

			const r = 0.10 + 0.90 * n;
			const g = 0.18 + 0.55 * n;
			const b = 0.60 + 0.40 * (1 - n);

			Vec3.acesToneMap(_tmpColor, r, g, b);

			p.col.x[i] = clamp01(_tmpColor[0]);
			p.col.y[i] = clamp01(_tmpColor[1]);
			p.col.z[i] = clamp01(_tmpColor[2]);
		}
	});

	if (!skipSync) {
		await syncParticleBuffers(p);
	}
}

async function syncParticleBuffers(p) {
	if (!p) {
		return;
	}

	await rangesChunked(p.count, function (start, end) {
		for (let i = start; i < end; i++) {
			const j = i * 3;

			p.flatPos[j] = p.pos.x[i];
			p.flatPos[j + 1] = p.pos.y[i];
			p.flatPos[j + 2] = p.pos.z[i];

			p.flatCol[j] = p.col.x[i];
			p.flatCol[j + 1] = p.col.y[i];
			p.flatCol[j + 2] = p.col.z[i];
		}
	});

	if (p.geometry) {
		p.geometry.attributes.position.needsUpdate = true;
		p.geometry.attributes.color.needsUpdate = true;
	}
}

function createParticleRenderObjects(p) {
	if (!p) {
		return;
	}

	p.geometry = new THREE.BufferGeometry();

	const posAttr = new THREE.BufferAttribute(p.flatPos, 3);
	posAttr.setUsage(THREE.DynamicDrawUsage);

	const colAttr = new THREE.BufferAttribute(p.flatCol, 3);
	colAttr.setUsage(THREE.DynamicDrawUsage);

	p.geometry.setAttribute("position", posAttr);
	p.geometry.setAttribute("color", colAttr);

	p.material = new THREE.PointsMaterial({
		size: params.pointSize,
		vertexColors: true,
		sizeAttenuation: true,
		transparent: true,
		opacity: 0.92,
		depthWrite: false,
		blending: THREE.AdditiveBlending
	});

	p.points = new THREE.Points(p.geometry, p.material);
	p.points.frustumCulled = false;

	groups.particles.add(p.points);
}

// ============================================================================
// MODE 2 -- FLAT VECTOR MATH
// ============================================================================
builders.vectors = function () {
	addSection("Vector A");
	addVectorSliders("A", params.vectorA, updateVectors);

	addSection("Vector B");
	addVectorSliders("B", params.vectorB, updateVectors);

	addSection("Operations");

	addButton("Rotate A around Y by 15 deg", function () {
		Vec3.set(vectors.a, params.vectorA.x, params.vectorA.y, params.vectorA.z);
		Vec3.rotateY(vectors.a, vectors.a, [0, 0, 0], Math.PI / 12);
		params.vectorA.x = vectors.a[0];
		params.vectorA.y = vectors.a[1];
		params.vectorA.z = vectors.a[2];
		clearDynamicUI();
		builders.vectors();
		updateVectors();
	});

	addButton("Rotate B around X by -10 deg", function () {
		Vec3.set(vectors.b, params.vectorB.x, params.vectorB.y, params.vectorB.z);
		Vec3.rotateX(vectors.b, vectors.b, [0, 0, 0], -Math.PI / 18);
		params.vectorB.x = vectors.b[0];
		params.vectorB.y = vectors.b[1];
		params.vectorB.z = vectors.b[2];
		clearDynamicUI();
		builders.vectors();
		updateVectors();
	});

	addButton("Normalize A", function () {
		Vec3.set(vectors.a, params.vectorA.x, params.vectorA.y, params.vectorA.z);
		Vec3.normalize(vectors.a, vectors.a);
		params.vectorA.x = vectors.a[0];
		params.vectorA.y = vectors.a[1];
		params.vectorA.z = vectors.a[2];
		clearDynamicUI();
		builders.vectors();
		updateVectors();
	});

	updateVectors();
};

enterFns.vectors = function () {
	updateVectors();
};

updaters.vectors = function () {};

function ensureVectors() {
	if (vectors) {
		return;
	}

	vectors = {
		a: Vec3.create(),
		b: Vec3.create(),
		add: Vec3.create(),
		sub: Vec3.create(),
		cross: Vec3.create(),
		norm: Vec3.create(),
		arrows: {}
	};

	vectors.arrows.a = makeArrow(0xff5d73);
	vectors.arrows.b = makeArrow(0x35c8ff);
	vectors.arrows.add = makeArrow(0x4ade80);
	vectors.arrows.sub = makeArrow(0xffb347);
	vectors.arrows.cross = makeArrow(0xb48cff);
	vectors.arrows.norm = makeArrow(0xe8f0f8);

	const keys = Object.keys(vectors.arrows);

	for (let i = 0; i < keys.length; i++) {
		groups.vectors.add(vectors.arrows[keys[i]]);
	}

	updateVectors();
}

function makeArrow(color) {
	const arrow = new THREE.ArrowHelper(
		new THREE.Vector3(1, 0, 0),
		new THREE.Vector3(0, 0, 0),
		1,
		color,
		0.35,
		0.18
	);

	arrow.visible = false;
	return arrow;
}

function addVectorSliders(prefix, target, onChange) {
	addSlider(prefix + ".x", -6, 6, 0.05, target.x, function (value) {
		target.x = value;
		onChange();
	});

	addSlider(prefix + ".y", -6, 6, 0.05, target.y, function (value) {
		target.y = value;
		onChange();
	});

	addSlider(prefix + ".z", -6, 6, 0.05, target.z, function (value) {
		target.z = value;
		onChange();
	});
}

function setArrowFromVec3(arrow, origin, value, scale) {
	const len = Vec3.length(value) * (scale || 1);

	if (len < 0.0001) {
		arrow.visible = false;
		return;
	}

	arrow.visible = true;
	arrow.position.set(origin[0], origin[1], origin[2]);

	_threeVec.set(value[0], value[1], value[2]).normalize();
	arrow.setDirection(_threeVec);
	arrow.setLength(Math.max(0.001, len), Math.min(0.45, len * 0.22), Math.min(0.22, len * 0.11));
}

function updateVectors() {
	if (!vectors) {
		return;
	}

	Vec3.set(vectors.a, params.vectorA.x, params.vectorA.y, params.vectorA.z);
	Vec3.set(vectors.b, params.vectorB.x, params.vectorB.y, params.vectorB.z);

	Vec3.add(vectors.add, vectors.a, vectors.b);
	Vec3.subtract(vectors.sub, vectors.a, vectors.b);
	Vec3.cross(vectors.cross, vectors.a, vectors.b);
	Vec3.normalize(vectors.norm, vectors.cross);

	const origin = [0, 0, 0];

	setArrowFromVec3(vectors.arrows.a, origin, vectors.a, 1);
	setArrowFromVec3(vectors.arrows.b, origin, vectors.b, 1);
	setArrowFromVec3(vectors.arrows.add, origin, vectors.add, 1);
	setArrowFromVec3(vectors.arrows.sub, origin, vectors.sub, 1);
	setArrowFromVec3(vectors.arrows.cross, origin, vectors.cross, 1);
	setArrowFromVec3(vectors.arrows.norm, origin, vectors.norm, 2.5);

	const d = Vec3.dot(vectors.a, vectors.b);
	const ang = Vec3.angle(vectors.a, vectors.b);
	const lenA = Vec3.length(vectors.a);
	const lenB = Vec3.length(vectors.b);
	const lenCross = Vec3.length(vectors.cross);

	setInfo(
		"red A, blue B, green A+B, orange A-B,\n" +
		"purple AxB, white normalize(AxB)\n\n" +
		"dot(A,B) = " + d.toFixed(4) + "\n" +
		"angle = " + THREE.MathUtils.radToDeg(ang).toFixed(2) + " deg\n" +
		"length(A) = " + lenA.toFixed(3) + "\n" +
		"length(B) = " + lenB.toFixed(3) + "\n" +
		"length(cross) = " + lenCross.toFixed(3)
	);
}

// ============================================================================
// MODE 3 -- ANIMATION CURVES
// ============================================================================
builders.curves = function () {
	addSection("Curve");

	addSelect("Type", ["quadraticBezier", "cubicBezier", "catmullRom", "hermite"], params.curveType, function (value) {
		params.curveType = value;
		updateCurve();
	});

	addSlider("t marker", 0, 1, 0.001, params.curveT, function (value) {
		params.curveT = value;
		updateCurve();
	});

	addCheckbox("Show controls", params.showCurveControls, function (value) {
		params.showCurveControls = value;

		if (curves) {
			curves.controls.visible = value;
		}
	});

	addButton("Randomize control points", function () {
		randomizeCurveControls();
		updateCurve();
	});

	updateCurve();
};

enterFns.curves = function () {
	updateCurve();
};

updaters.curves = function () {};

function ensureCurves() {
	if (curves) {
		return;
	}

	const lineGeometry = new THREE.BufferGeometry();
	const linePositions = new Float32Array(201 * 3);
	lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));

	const lineMaterial = new THREE.LineBasicMaterial({ color: 0x35c8ff });
	const line = new THREE.Line(lineGeometry, lineMaterial);
	line.frustumCulled = false;

	const controlsGeometry = new THREE.BufferGeometry();
	const controlPositions = new Float32Array(4 * 3);
	controlsGeometry.setAttribute("position", new THREE.BufferAttribute(controlPositions, 3));

	const controlsMaterial = new THREE.PointsMaterial({
		color: 0xffb347,
		size: 0.18,
		sizeAttenuation: true
	});

	const controls = new THREE.Points(controlsGeometry, controlsMaterial);
	controls.frustumCulled = false;

	const marker = new THREE.Mesh(
		new THREE.SphereGeometry(0.12, 20, 14),
		new THREE.MeshStandardMaterial({
			color: 0x4ade80,
			roughness: 0.25,
			metalness: 0.1,
			emissive: 0x0c3318
		})
	);

	curves = {
		points: [Vec3.create(), Vec3.create(), Vec3.create(), Vec3.create()],
		line: line,
		controls: controls,
		marker: marker
	};

	randomizeCurveControls();

	groups.curves.add(line);
	groups.curves.add(controls);
	groups.curves.add(marker);
}

function randomizeCurveControls() {
	if (!curves) {
		return;
	}

	for (let i = 0; i < 4; i++) {
		Vec3.random(_tmpVecA, 3.5 + i * 0.4);
		_tmpVecA[1] += (i - 1.5) * 0.9;
		Vec3.copy(curves.points[i], _tmpVecA);
	}

	updateCurve();
}

function updateCurve() {
	if (!curves) {
		return;
	}

	const samples = 200;
	const positions = curves.line.geometry.attributes.position.array;
	const p0 = curves.points[0];
	const p1 = curves.points[1];
	const p2 = curves.points[2];
	const p3 = curves.points[3];

	for (let i = 0; i <= samples; i++) {
		const t = i / samples;
		const j = i * 3;

		if (params.curveType === "quadraticBezier") {
			Vec3.quadraticBezier(_tmpVecA, p0, p1, p2, t);
		} else if (params.curveType === "cubicBezier") {
			Vec3.cubicBezier(_tmpVecA, p0, p1, p2, p3, t);
		} else if (params.curveType === "hermite") {
			Vec3.hermite(_tmpVecA, p0, p1, p2, p3, t);
		} else {
			Vec3.catmullRom(_tmpVecA, p0, p1, p2, p3, t);
		}

		positions[j] = _tmpVecA[0];
		positions[j + 1] = _tmpVecA[1];
		positions[j + 2] = _tmpVecA[2];
	}

	curves.line.geometry.attributes.position.needsUpdate = true;
	curves.line.geometry.setDrawRange(0, samples + 1);

	const controlPositions = curves.controls.geometry.attributes.position.array;

	for (let i = 0; i < 4; i++) {
		const j = i * 3;
		controlPositions[j] = curves.points[i][0];
		controlPositions[j + 1] = curves.points[i][1];
		controlPositions[j + 2] = curves.points[i][2];
	}

	curves.controls.geometry.attributes.position.needsUpdate = true;
	curves.controls.visible = params.showCurveControls;

	if (params.curveType === "quadraticBezier") {
		Vec3.quadraticBezier(_tmpVecB, p0, p1, p2, params.curveT);
	} else if (params.curveType === "cubicBezier") {
		Vec3.cubicBezier(_tmpVecB, p0, p1, p2, p3, params.curveT);
	} else if (params.curveType === "hermite") {
		Vec3.hermite(_tmpVecB, p0, p1, p2, p3, params.curveT);
	} else {
		Vec3.catmullRom(_tmpVecB, p0, p1, p2, p3, params.curveT);
	}

	curves.marker.position.fromArray(_tmpVecB);

	setInfo(
		"Curve: " + params.curveType + "\n" +
		"t = " + params.curveT.toFixed(3) + "\n" +
		"marker = " + Vec3.str(_tmpVecB)
	);
}

// ============================================================================
// MODE 4 -- IK FABRIK / CCD
// ============================================================================
builders.ik = function () {
	addSection("IK chain");

	addSelect("Method", ["fabrik", "ccd"], params.ikMethod, function (value) {
		params.ikMethod = value;
	});

	addSlider("Bones", 2, 18, 1, params.ikBones, function (value) {
		params.ikBones = Math.round(value);
		resetIK();
	});

	addSlider("Bone length", 0.25, 2.5, 0.01, params.ikLength, function (value) {
		params.ikLength = value;
		resetIK();
	});

	addSlider("Iterations", 1, 40, 1, params.ikIterations, function (value) {
		params.ikIterations = Math.round(value);
	});

	addSlider("Tolerance", 0.001, 0.2, 0.001, params.ikTolerance, function (value) {
		params.ikTolerance = value;
	});

	addCheckbox("Auto target", params.ikAutoTarget, function (value) {
		params.ikAutoTarget = value;
	});

	addSection("Manual target");

	addSlider("Target X", -10, 10, 0.05, params.ikTargetX, function (value) {
		params.ikTargetX = value;
	});

	addSlider("Target Y", -10, 10, 0.05, params.ikTargetY, function (value) {
		params.ikTargetY = value;
	});

	addSlider("Target Z", -10, 10, 0.05, params.ikTargetZ, function (value) {
		params.ikTargetZ = value;
	});

	addButton("Reset chain", function () {
		resetIK();
	});

	resetIK();
};

enterFns.ik = function () {
	resetIK();
};

updaters.ik = function (dt) {
	updateIK(dt);
};

function ensureIK() {
	if (ik) {
		return;
	}

	ik = {
		pos: null,
		lens: null,
		target: Vec3.fromValues(3, 3, 0),
		line: null,
		points: null,
		targetMesh: null,
		builtBones: -1,
		builtLength: -1
	};

	const targetMesh = new THREE.Mesh(
		new THREE.SphereGeometry(0.18, 22, 16),
		new THREE.MeshStandardMaterial({
			color: 0xff5d73,
			emissive: 0x441018,
			roughness: 0.3,
			metalness: 0.1
		})
	);

	ik.targetMesh = targetMesh;
	groups.ik.add(targetMesh);

	resetIK();
}

function resetIK() {
	if (!ik) {
		return;
	}

	const bones = Math.max(2, Math.round(params.ikBones));
	const len = Math.max(0.01, params.ikLength);

	ik.pos = new Float32Array(bones * 3);
	ik.lens = new Float32Array(bones - 1);
	ik.builtBones = bones;
	ik.builtLength = len;

	const rootY = -(bones - 1) * len * 0.5;

	for (let i = 0; i < bones; i++) {
		ik.pos[i * 3] = 0;
		ik.pos[i * 3 + 1] = rootY + i * len;
		ik.pos[i * 3 + 2] = 0;
	}

	for (let i = 0; i < bones - 1; i++) {
		ik.lens[i] = len;
	}

	rebuildIKRenderObjects();
	updateIKRender();
}

function rebuildIKRenderObjects() {
	if (!ik) {
		return;
	}

	if (ik.line) {
		groups.ik.remove(ik.line);
		groups.ik.remove(ik.points);
		ik.line.geometry.dispose();
		ik.line.material.dispose();
		ik.points.material.dispose();
		ik.line = null;
		ik.points = null;
	}

	const geometry = new THREE.BufferGeometry();
	const attr = new THREE.BufferAttribute(ik.pos, 3);
	attr.setUsage(THREE.DynamicDrawUsage);
	geometry.setAttribute("position", attr);

	const lineMaterial = new THREE.LineBasicMaterial({ color: 0x7cc4ff });
	const pointsMaterial = new THREE.PointsMaterial({
		color: 0xe8f0f8,
		size: 0.12,
		sizeAttenuation: true
	});

	ik.line = new THREE.Line(geometry, lineMaterial);
	ik.points = new THREE.Points(geometry, pointsMaterial);

	ik.line.frustumCulled = false;
	ik.points.frustumCulled = false;

	groups.ik.add(ik.line);
	groups.ik.add(ik.points);
}

function updateIK(dt) {
	if (!ik || !ik.pos || !ik.lens) {
		return;
	}

	if (params.ikAutoTarget) {
		const t = state.time;
		ik.target[0] = Math.sin(t * 0.7) * 4.5;
		ik.target[1] = 2.2 + Math.cos(t * 1.1) * 2.0;
		ik.target[2] = Math.sin(t * 0.43) * 3.0;
	} else {
		Vec3.set(ik.target, params.ikTargetX, params.ikTargetY, params.ikTargetZ);
	}

	if (params.ikMethod === "fabrik") {
		for (let i = 0; i < params.ikIterations; i++) {
			const err = Vec3.fabrikStep3(ik.pos, ik.lens, ik.target, params.ikTolerance);

			if (err < params.ikTolerance) {
				break;
			}
		}
	} else {
		Vec3.ccdStep3(ik.pos, ik.target, params.ikIterations);
	}

	updateIKRender();
}

function updateIKRender() {
	if (!ik || !ik.line) {
		return;
	}

	ik.line.geometry.attributes.position.needsUpdate = true;
	ik.points.geometry.attributes.position.needsUpdate = true;
	ik.targetMesh.position.fromArray(ik.target);

	const last = (ik.pos.length / 3) - 1;
	_tmpVecA[0] = ik.pos[last * 3];
	_tmpVecA[1] = ik.pos[last * 3 + 1];
	_tmpVecA[2] = ik.pos[last * 3 + 2];

	const err = Vec3.distance(_tmpVecA, ik.target);

	setInfo(
		"method = " + params.ikMethod + "\n" +
		"bones = " + params.ikBones + "\n" +
		"iterations = " + params.ikIterations + "\n" +
		"end effector error = " + err.toFixed(4)
	);
}

// ============================================================================
// MODE 5 -- SPRING DAMPING
// ============================================================================
builders.spring = function () {
	addSection("Spring follow");

	addSlider("Smooth time", 0.02, 1.0, 0.01, params.springSmoothTime, function (value) {
		params.springSmoothTime = value;
	});

	addSlider("Max speed", 1, 100, 1, params.springMaxSpeed, function (value) {
		params.springMaxSpeed = value;
	});

	addCheckbox("Auto target", params.springAutoTarget, function (value) {
		params.springAutoTarget = value;
	});

	addSection("Manual target");

	addSlider("Target X", -10, 10, 0.05, params.springTargetX, function (value) {
		params.springTargetX = value;
	});

	addSlider("Target Y", -10, 10, 0.05, params.springTargetY, function (value) {
		params.springTargetY = value;
	});

	addSlider("Target Z", -10, 10, 0.05, params.springTargetZ, function (value) {
		params.springTargetZ = value;
	});

	addButton("Reset spring", function () {
		resetSpring();
	});
};

enterFns.spring = function () {
	resetSpring();
};

updaters.spring = function (dt) {
	updateSpring(dt);
};

function ensureSpring() {
	if (spring) {
		return;
	}

	const follower = new THREE.Mesh(
		new THREE.BoxGeometry(0.45, 0.45, 0.45),
		new THREE.MeshStandardMaterial({
			color: 0x35c8ff,
			roughness: 0.22,
			metalness: 0.25,
			emissive: 0x06222e
		})
	);

	const targetMesh = new THREE.Mesh(
		new THREE.SphereGeometry(0.18, 22, 16),
		new THREE.MeshStandardMaterial({
			color: 0xffb347,
			roughness: 0.3,
			metalness: 0.05,
			emissive: 0x332005
		})
	);

	const lineGeometry = new THREE.BufferGeometry();
	const linePositions = new Float32Array(6);
	lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));

	const line = new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({
		color: 0x8ea2b8,
		transparent: true,
		opacity: 0.65
	}));

	spring = {
		current: Vec3.fromValues(0, 0, 0),
		target: Vec3.fromValues(3, 1, 0),
		velocity: Vec3.create(),
		follower: follower,
		targetMesh: targetMesh,
		line: line
	};

	groups.spring.add(follower);
	groups.spring.add(targetMesh);
	groups.spring.add(line);

	resetSpring();
}

function resetSpring() {
	if (!spring) {
		return;
	}

	Vec3.set(spring.current, 0, 0, 0);
	Vec3.set(spring.velocity, 0, 0, 0);
	Vec3.set(spring.target, params.springTargetX, params.springTargetY, params.springTargetZ);

	spring.follower.position.fromArray(spring.current);
	spring.targetMesh.position.fromArray(spring.target);
	updateSpringLine();
}

function updateSpring(dt) {
	if (!spring) {
		return;
	}

	if (params.springAutoTarget) {
		const t = state.time;
		spring.target[0] = Math.sin(t * 1.1) * 4.0;
		spring.target[1] = 1.5 + Math.sin(t * 1.7) * 2.0;
		spring.target[2] = Math.cos(t * 0.8) * 3.0;
	} else {
		Vec3.set(spring.target, params.springTargetX, params.springTargetY, params.springTargetZ);
	}

	Vec3.springDamp3(
		spring.current,
		spring.current,
		spring.target,
		spring.velocity,
		params.springSmoothTime,
		dt,
		params.springMaxSpeed
	);

	spring.follower.position.fromArray(spring.current);
	spring.targetMesh.position.fromArray(spring.target);
	updateSpringLine();

	setInfo(
		"springDamp3:\n" +
		"pos = " + Vec3.str(spring.current) + "\n" +
		"vel = " + Vec3.str(spring.velocity)
	);
}

function updateSpringLine() {
	if (!spring) {
		return;
	}

	const positions = spring.line.geometry.attributes.position.array;

	positions[0] = spring.current[0];
	positions[1] = spring.current[1];
	positions[2] = spring.current[2];
	positions[3] = spring.target[0];
	positions[4] = spring.target[1];
	positions[5] = spring.target[2];

	spring.line.geometry.attributes.position.needsUpdate = true;
}

// ============================================================================
// MODE 6 -- ORBITAL MECHANICS
// ============================================================================
builders.orbital = function () {
	addSection("Kepler orbit");

	addSlider("Semi-major a", 1, 16, 0.05, params.orbitalA, function (value) {
		params.orbitalA = value;
		updateOrbitLine();
	});

	addSlider("Eccentricity e", 0, 0.9, 0.005, params.orbitalE, function (value) {
		params.orbitalE = value;
		updateOrbitLine();
	});

	addSlider("Inclination", 0, Math.PI, 0.01, params.orbitalInc, function (value) {
		params.orbitalInc = value;
		updateOrbitLine();
	});

	addSlider("Asc node Om", 0, Math.PI * 2, 0.01, params.orbitalOm, function (value) {
		params.orbitalOm = value;
		updateOrbitLine();
	});

	addSlider("Arg peri om", 0, Math.PI * 2, 0.01, params.orbitalom, function (value) {
		params.orbitalom = value;
		updateOrbitLine();
	});

	addSlider("Time speed", -4, 4, 0.01, params.orbitalSpeed, function (value) {
		params.orbitalSpeed = value;
	});

	addCheckbox("Show velocity", params.orbitalShowVelocity, function (value) {
		params.orbitalShowVelocity = value;

		if (orbital && orbital.velocityArrow) {
			orbital.velocityArrow.visible = value;
		}
	});

	addSection("Hohmann transfer");

	addSlider("Target radius", 1, 30, 0.1, params.hohmannR2, function (value) {
		params.hohmannR2 = value;
	});

	addButton("Compute Hohmann delta-v", function () {
		computeHohmann();
	});

	updateOrbitLine();
};

enterFns.orbital = function () {
	updateOrbitLine();
};

updaters.orbital = function (dt) {
	updateOrbital(dt);
};

function ensureOrbital() {
	if (orbital) {
		return;
	}

	const center = new THREE.Mesh(
		new THREE.SphereGeometry(0.55, 32, 24),
		new THREE.MeshStandardMaterial({
			color: 0xffb347,
			emissive: 0x552f00,
			roughness: 0.4,
			metalness: 0.05
		})
	);

	const orbitGeometry = new THREE.BufferGeometry();
	const orbitPositions = new Float32Array(513 * 3);
	orbitGeometry.setAttribute("position", new THREE.BufferAttribute(orbitPositions, 3));

	const orbitLine = new THREE.Line(orbitGeometry, new THREE.LineBasicMaterial({
		color: 0x35c8ff,
		transparent: true,
		opacity: 0.75
	}));

	const body = new THREE.Mesh(
		new THREE.SphereGeometry(0.22, 26, 18),
		new THREE.MeshStandardMaterial({
			color: 0x7cc4ff,
			roughness: 0.28,
			metalness: 0.18,
			emissive: 0x07202e
		})
	);

	const velocityArrow = new THREE.ArrowHelper(
		new THREE.Vector3(1, 0, 0),
		new THREE.Vector3(),
		1,
		0x4ade80,
		0.35,
		0.18
	);

	orbital = {
		center: center,
		orbitLine: orbitLine,
		body: body,
		velocityArrow: velocityArrow,
		pos: Vec3.create(),
		vel: Vec3.create(),
		hohmann: Vec3.create()
	};

	orbitLine.frustumCulled = false;

	groups.orbital.add(center);
	groups.orbital.add(orbitLine);
	groups.orbital.add(body);
	groups.orbital.add(velocityArrow);

	updateOrbitLine();
}

function updateOrbitLine() {
	if (!orbital) {
		return;
	}

	const samples = 512;
	const positions = orbital.orbitLine.geometry.attributes.position.array;

	for (let i = 0; i <= samples; i++) {
		const M = (i / samples) * Math.PI * 2;
		const j = i * 3;

		Vec3.keplerOrbit3D(
			_tmpVecA,
			params.orbitalA,
			params.orbitalE,
			M,
			params.orbitalInc,
			params.orbitalOm,
			params.orbitalom
		);

		positions[j] = _tmpVecA[0];
		positions[j + 1] = _tmpVecA[2];
		positions[j + 2] = -_tmpVecA[1];
	}

	orbital.orbitLine.geometry.attributes.position.needsUpdate = true;
	orbital.orbitLine.geometry.setDrawRange(0, samples + 1);
}

function updateOrbital(dt) {
	if (!orbital) {
		return;
	}

	const a = params.orbitalA;
	const e = params.orbitalE;
	const mu = params.orbitalMu;
	const n = Math.sqrt(mu / (a * a * a));
	const M = params.orbitalM0 + state.time * params.orbitalSpeed * n;

	Vec3.keplerOrbit3D(
		orbital.pos,
		a,
		e,
		M,
		params.orbitalInc,
		params.orbitalOm,
		params.orbitalom
	);

	orbital.body.position.set(orbital.pos[0], orbital.pos[2], -orbital.pos[1]);

	Vec3.keplerOrbitVelocity3D(
		orbital.vel,
		a,
		e,
		M,
		params.orbitalInc,
		params.orbitalOm,
		params.orbitalom,
		mu
	);

	const speedNow = Vec3.length(orbital.vel);
	const r = Vec3.length(orbital.pos);
	const visViva = Vec3.orbitalSpeed3D(mu, r, a);

	if (params.orbitalShowVelocity && speedNow > 0.0001) {
		orbital.velocityArrow.visible = true;
		orbital.velocityArrow.position.copy(orbital.body.position);

		_threeVec.set(orbital.vel[0], orbital.vel[2], -orbital.vel[1]).normalize();
		orbital.velocityArrow.setDirection(_threeVec);
		orbital.velocityArrow.setLength(Math.min(3.5, speedNow * 1.2), 0.35, 0.18);
	} else {
		orbital.velocityArrow.visible = false;
	}

	setInfo(
		"M = " + (M % (Math.PI * 2)).toFixed(3) + " rad\n" +
		"r = " + r.toFixed(3) + "\n" +
		"velocity from derivative = " + speedNow.toFixed(4) + "\n" +
		"vis-viva speed = " + visViva.toFixed(4)
	);
}

function computeHohmann() {
	if (!orbital) {
		return;
	}

	Vec3.hohmannTransfer(orbital.hohmann, params.orbitalMu, params.orbitalA, params.hohmannR2);

	setInfo(
		"Hohmann transfer:\n" +
		"r1 = " + params.orbitalA.toFixed(3) + "\n" +
		"r2 = " + params.hohmannR2.toFixed(3) + "\n" +
		"delta-v burn 1 = " + orbital.hohmann[0].toFixed(5) + "\n" +
		"delta-v burn 2 = " + orbital.hohmann[1].toFixed(5) + "\n" +
		"total delta-v = " + (orbital.hohmann[0] + orbital.hohmann[1]).toFixed(5)
	);
}

// ============================================================================
// MODE 7 -- SPHERICAL HARMONICS
// ============================================================================
builders.sh = function () {
	addSection("Directional SH light");

	addSlider("Azimuth", 0, Math.PI * 2, 0.01, params.shAzimuth, function (value) {
		params.shAzimuth = value;
		updateSH();
	});

	addSlider("Elevation", -Math.PI * 0.49, Math.PI * 0.49, 0.01, params.shElevation, function (value) {
		params.shElevation = value;
		updateSH();
	});

	addSlider("Energy", 0, 8, 0.05, params.shEnergy, function (value) {
		params.shEnergy = value;
		updateSH();
	});

	addSlider("Exposure", 0.1, 4, 0.05, params.shExposure, function (value) {
		params.shExposure = value;
		updateSH();
	});

	addSection("Light color");

	addSlider("R", 0, 1, 0.01, params.shColorR, function (value) {
		params.shColorR = value;
		updateSH();
	});

	addSlider("G", 0, 1, 0.01, params.shColorG, function (value) {
		params.shColorG = value;
		updateSH();
	});

	addSlider("B", 0, 1, 0.01, params.shColorB, function (value) {
		params.shColorB = value;
		updateSH();
	});

	updateSH();
};

enterFns.sh = function () {
	updateSH();
};

updaters.sh = function () {};

function ensureSH() {
	if (sh) {
		return;
	}

	const geometry = new THREE.SphereGeometry(3.2, 96, 64);
	const count = geometry.attributes.position.count;

	geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 3), 3));

	const material = new THREE.MeshBasicMaterial({
		vertexColors: true,
		toneMapped: false
	});

	const mesh = new THREE.Mesh(geometry, material);

	sh = {
		mesh: mesh,
		coeff: new Float32Array(9),
		basis: new Float32Array(9),
		dir: Vec3.create(),
		normal: Vec3.create()
	};

	groups.sh.add(mesh);
	updateSH();
}

function updateSH() {
	if (!sh) {
		return;
	}

	if (typeof Vec3.shProjectDirectional !== "function" || typeof Vec3.shBasis !== "function") {
		setInfo("SH functions are not exported by the loaded 003_vec3.js module.");
		return;
	}

	const az = params.shAzimuth;
	const el = params.shElevation;

	Vec3.set(
		sh.dir,
		Math.cos(el) * Math.cos(az),
		Math.sin(el),
		Math.cos(el) * Math.sin(az)
	);

	Vec3.shProjectDirectional(sh.coeff, sh.dir, params.shEnergy);

	const geometry = sh.mesh.geometry;
	const normals = geometry.attributes.normal.array;
	const colors = geometry.attributes.color.array;
	const count = geometry.attributes.position.count;

	for (let i = 0; i < count; i++) {
		const j = i * 3;

		Vec3.set(sh.normal, normals[j], normals[j + 1], normals[j + 2]);
		Vec3.shBasis(sh.basis, sh.normal);

		let value = 0;

		for (let k = 0; k < 9; k++) {
			value += sh.coeff[k] * sh.basis[k];
		}

		value = Math.max(0, value) * params.shExposure;

		const r = value * params.shColorR;
		const g = value * params.shColorG;
		const b = value * params.shColorB;

		Vec3.acesToneMap(_tmpColor, r, g, b);

		colors[j] = clamp01(_tmpColor[0]);
		colors[j + 1] = clamp01(_tmpColor[1]);
		colors[j + 2] = clamp01(_tmpColor[2]);
	}

	geometry.attributes.color.needsUpdate = true;

	sh.mesh.rotation.y = state.time * 0.05;

	setInfo(
		"shProjectDirectional -> 9 SH coefficients\n" +
		"shBasis per vertex -> irradiance reconstruction\n" +
		"light dir = " + Vec3.str(sh.dir)
	);
}

// ============================================================================
// BOOTSTRAP -- runs AFTER every builder / updater / enterFn assignment above.
// This fixes "builders[name] is not a function".
// ============================================================================
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init);
} else {
	init();
}