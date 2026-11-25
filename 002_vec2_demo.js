// File number : 002
// File : 002_vec2_demo.js
// Description : Native browser demo host for 002_vec2.js.
//               No Vite, no Vue, no build tooling, no top-level await.
//               Maintains flat API, pool, SOA, chunked async, procedural noise,
//               animation, spring, orbital, and debug/test features.
// License : MIT

(function () {
	"use strict";

	var globalScope = typeof globalThis !== "undefined" ? globalThis : window;

	if (globalScope.__VEC2_DEMO_LOADED__) {
		return;
	}

	globalScope.__VEC2_DEMO_LOADED__ = true;

	function logInfo(message) {
		console.info("[002_vec2_demo] " + message);
	}

	function logError(message, error) {
		if (error !== undefined) {
			console.error("[002_vec2_demo] " + message, error);
		} else {
			console.error("[002_vec2_demo] " + message);
		}
	}

	function now() {
		if (typeof performance !== "undefined" && typeof performance.now === "function") {
			return performance.now();
		}
		return Date.now();
	}

	function tryGlobalMath() {
		if (globalScope.__VEC2_MATH__ && typeof globalScope.__VEC2_MATH__.create === "function") {
			return globalScope.__VEC2_MATH__;
		}
		if (globalScope.vec2 && typeof globalScope.vec2.create === "function") {
			return globalScope.vec2;
		}
		if (globalScope.Vec2 && typeof globalScope.Vec2.create === "function") {
			return globalScope.Vec2;
		}
		return null;
	}

	function resolveVec2(moduleRef) {
		if (!moduleRef) {
			return null;
		}

		if (typeof moduleRef.create === "function" && typeof moduleRef.createVec2SOA === "function") {
			return moduleRef;
		}

		if (moduleRef.default && typeof moduleRef.default.create === "function") {
			return moduleRef.default;
		}

		if (moduleRef.vec2 && typeof moduleRef.vec2.create === "function") {
			return moduleRef.vec2;
		}

		if (moduleRef.Vec2 && typeof moduleRef.Vec2.create === "function") {
			return moduleRef.Vec2;
		}

		return moduleRef;
	}

	function boot() {
		var existing = tryGlobalMath();

		if (existing) {
			startDemo(existing);
			return;
		}

		try {
			import("./math/002_vec2.js")
				.then(function (moduleRef) {
					var math = resolveVec2(moduleRef);

					if (!math || typeof math.create !== "function") {
						throw new Error("002_vec2.js did not expose a valid vec2 API.");
					}

					globalScope.__VEC2_MATH__ = math;
					startDemo(math);
				})
				.catch(function (error) {
					logError("Failed to load ./math/002_vec2.js", error);
				});
		} catch (error) {
			logError("Dynamic import is unavailable in this environment.", error);
		}
	}

	function startDemo(Vec2) {
		if (globalScope.__VEC2_DEMO_ACTIVE__) {
			return;
		}

		globalScope.__VEC2_DEMO_ACTIVE__ = true;

		var canvas = getCanvas();

		if (!canvas) {
			logError("Could not find or create a canvas element.");
			return;
		}

		var ctx = canvas.getContext("2d", {
			alpha: false,
			desynchronized: true
		});

		if (!ctx) {
			logError("Could not acquire 2D canvas context.");
			return;
		}

		var TAU = Math.PI * 2;
		var MODE_COUNT = 5;
		var MODE_NAMES = [
			"Vector Field",
			"Flow Particles",
			"Voronoi / Noise",
			"Curves + Spring",
			"Orbital 2D"
		];

		var tests = {
			total: 0,
			passed: 0,
			failed: 0,
			async: 0
		};

		var state = {
			width: 1,
			height: 1,
			dpr: 1,
			time: 0,
			last: now(),
			frame: 0,
			fps: 60,
			mode: 0,
			modeTime: 0,
			running: true,
			frameErrors: 0,
			particleCount: 0,
			pointer: Vec2.create(),
			pointerTarget: Vec2.create(),
			springPos: Vec2.create(),
			springVel: Vec2.create(),
			positions: null,
			velocities: null,
			c0: Vec2.create(),
			c1: Vec2.create(),
			c2: Vec2.create(),
			c3: Vec2.create(),
			orbits: null
		};

		var tmpA = Vec2.create();
		var tmpB = Vec2.create();
		var tmpC = Vec2.create();
		var tmpD = Vec2.create();
		var tmpP = Vec2.create();
		var tmpQ = Vec2.create();
		var tmpVoronoi = [0, 0];
		var crossOut = [0, 0, 0];

		function getCanvas() {
			var host = globalScope.__VEC2_DEMO_HOST__;

			if (host && host.canvas) {
				return host.canvas;
			}

			var byId = document.getElementById("vec2-canvas");

			if (byId) {
				return byId;
			}

			var container = document.getElementById("app") || document.body;
			var created = document.createElement("canvas");

			created.id = "vec2-canvas";
			created.className = "vec2-canvas";
			created.style.position = "absolute";
			created.style.left = "0";
			created.style.top = "0";
			created.style.width = "100%";
			created.style.height = "100%";
			created.style.display = "block";
			created.style.touchAction = "none";
			created.style.outline = "none";

			container.appendChild(created);

			return created;
		}

		function clamp(value, minValue, maxValue) {
			return value < minValue ? minValue : value > maxValue ? maxValue : value;
		}

		function approx(a, b, epsilon) {
			epsilon = epsilon === undefined ? 1e-5 : epsilon;
			return isFinite(a) && isFinite(b) && Math.abs(a - b) <= epsilon;
		}

		function has(name) {
			return typeof Vec2[name] === "function";
		}

		function assert(name, condition) {
			tests.total++;

			if (condition) {
				tests.passed++;
			} else {
				tests.failed++;
				console.error("[002_vec2_demo][TEST] " + name + " failed");
			}
		}

		function resize() {
			var rect = canvas.getBoundingClientRect();
			var width = Math.max(1, Math.floor(rect.width || window.innerWidth || 1));
			var height = Math.max(1, Math.floor(rect.height || window.innerHeight || 1));
			var dpr = Math.min(2, window.devicePixelRatio || 1);

			state.width = width;
			state.height = height;
			state.dpr = dpr;

			canvas.width = Math.floor(width * dpr);
			canvas.height = Math.floor(height * dpr);

			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		}

		function chooseParticleCount() {
			var cores = navigator.hardwareConcurrency || 4;
			var memory = navigator.deviceMemory || 4;
			var count = 80000;

			if (cores <= 4 || memory <= 4) {
				count = 80000;
			}

			if (cores >= 8 && memory >= 8) {
				count = 80000;
			}

			if (window.devicePixelRatio > 2.5) {
				count = Math.floor(count * 0.7);
			}

			return count;
		}

		function initParticles() {
			if (!has("createVec2SOA")) {
				state.positions = null;
				state.velocities = null;
				state.particleCount = 0;
				return;
			}

			state.particleCount = chooseParticleCount();
			state.positions = Vec2.createVec2SOA(state.particleCount);
			state.velocities = Vec2.createVec2SOA(state.particleCount);

			for (var i = 0; i < state.particleCount; i++) {
				state.positions.x[i] = Math.random() * state.width;
				state.positions.y[i] = Math.random() * state.height;
				state.velocities.x[i] = 0;
				state.velocities.y[i] = 0;
			}
		}

		function initOrbits() {
			state.orbits = [
				{ a: 0.28, e: 0.06, speed: 0.65, phase: 0.2, color: "rgba(53,200,255,0.9)" },
				{ a: 0.42, e: 0.18, speed: 0.42, phase: 1.4, color: "rgba(124,255,178,0.9)" },
				{ a: 0.58, e: 0.32, speed: 0.28, phase: 2.7, color: "rgba(255,179,71,0.9)" },
				{ a: 0.74, e: 0.46, speed: 0.19, phase: 4.1, color: "rgba(255,93,115,0.9)" }
			];
		}

		function bindEvents() {
			window.addEventListener("resize", resize, false);

			canvas.addEventListener("pointermove", onPointerEvent, false);
			canvas.addEventListener("pointerdown", onPointerDown, false);

			window.addEventListener("keydown", onKeyDown, false);
		}

		function onPointerEvent(event) {
			var rect = canvas.getBoundingClientRect();
			var x = event.clientX - rect.left;
			var y = event.clientY - rect.top;

			if (x >= 0 && y >= 0 && x <= state.width && y <= state.height) {
				Vec2.set(state.pointerTarget, x, y);
			}
		}

		function onPointerDown(event) {
			onPointerEvent(event);
			nextMode();
		}

		function onKeyDown(event) {
			if (event.key === " " || event.key === "Enter") {
				nextMode();
				event.preventDefault();
			}
		}

		function nextMode() {
			state.mode = (state.mode + 1) % MODE_COUNT;
			state.modeTime = 0;
		}

		function safeFbm(x, y, octaves) {
			try {
				if (has("fbm2D")) {
					var value = Vec2.fbm2D(x, y, octaves);
					if (isFinite(value)) {
						return value;
					}
				}

				if (has("gradientNoise2D")) {
					var gradient = Vec2.gradientNoise2D(x, y);
					if (isFinite(gradient)) {
						return 0.5 + 0.5 * gradient;
					}
				}

				if (has("valueNoise2D")) {
					var noise = Vec2.valueNoise2D(x, y);
					if (isFinite(noise)) {
						return noise;
					}
				}
			} catch (error) {
				// Ignore and use deterministic fallback.
			}

			return 0.5 + 0.5 * Math.sin(x * 1.7 + y * 2.3);
		}

		function safeVoronoi(out, x, y) {
			try {
				if (has("voronoi2D")) {
					Vec2.voronoi2D(out, x, y);
					if (isFinite(out[0]) && isFinite(out[1])) {
						return;
					}
				}
			} catch (error) {
				// Ignore and use deterministic fallback.
			}

			out[0] = Math.abs(Math.sin(x * 12.9898 + y * 78.233));
			out[1] = Math.floor(Math.abs(x * 100 + y * 100));
		}

		function testFlat() {
			assert(
				"flat API present",
				has("create") && has("fromValues") && has("copy") && has("set") &&
				has("add") && has("subtract") && has("multiply") && has("divide") &&
				has("scale") && has("normalize") && has("dot") && has("cross") &&
				has("length") && has("distance") && has("lerp") && has("rotate") &&
				has("transformMat2d") && has("equals")
			);

			if (!has("create")) {
				return;
			}

			var a = Vec2.create();
			var b = Vec2.fromValues(3, 4);

			assert("create returns zero", a[0] === 0 && a[1] === 0);
			assert("fromValues works", b[0] === 3 && b[1] === 4);
			assert("length works", approx(Vec2.length(b), 5));

			Vec2.set(a, 1, 2);
			assert("set works", a[0] === 1 && a[1] === 2);

			Vec2.add(tmpA, b, b);
			assert("add works", tmpA[0] === 6 && tmpA[1] === 8);

			Vec2.subtract(tmpA, b, Vec2.fromValues(1, 1));
			assert("subtract works", tmpA[0] === 2 && tmpA[1] === 3);

			Vec2.multiply(tmpA, b, Vec2.fromValues(2, 3));
			assert("multiply works", tmpA[0] === 6 && tmpA[1] === 12);

			Vec2.divide(tmpA, b, Vec2.fromValues(3, 2));
			assert("divide works", approx(tmpA[0], 1) && approx(tmpA[1], 2));

			Vec2.scale(tmpA, b, 2);
			assert("scale works", tmpA[0] === 6 && tmpA[1] === 8);

			Vec2.normalize(tmpA, b);
			assert("normalize works", approx(Vec2.length(tmpA), 1, 1e-4));

			assert("dot works", approx(Vec2.dot(Vec2.fromValues(1, 2), Vec2.fromValues(3, 4)), 11));

			if (has("cross")) {
				Vec2.cross(crossOut, Vec2.fromValues(1, 0), Vec2.fromValues(0, 1));
				assert("cross works", approx(crossOut[2], 1));
			}

			Vec2.lerp(tmpA, Vec2.fromValues(0, 0), Vec2.fromValues(10, 20), 0.25);
			assert("lerp works", approx(tmpA[0], 2.5) && approx(tmpA[1], 5));

			Vec2.rotate(tmpA, Vec2.fromValues(1, 0), Vec2.fromValues(0, 0), Math.PI * 0.5);
			assert("rotate works", approx(tmpA[0], 0, 1e-6) && approx(tmpA[1], 1, 1e-6));

			Vec2.transformMat2d(tmpA, Vec2.fromValues(1, 1), [1, 0, 0, 1, 10, 20]);
			assert("transformMat2d works", approx(tmpA[0], 11) && approx(tmpA[1], 21));

			assert(
				"equals works",
				Vec2.equals(Vec2.fromValues(1, 1), Vec2.fromValues(1 + 1e-7, 1 - 1e-7))
			);

			assert(
				"aliases present",
				has("len") && has("sub") && has("mul") && has("div") &&
				has("dist") && has("sqrDist") && has("sqrLen") && has("forEach")
			);

			if (has("forEach")) {
				var array = new Float32Array([1, 2, 3, 4]);
				var sum = 0;

				Vec2.forEach(array, 2, 0, 2, function (v) {
					sum += v[0] + v[1];
				}, null);

				assert("forEach works", approx(sum, 10));
			}
		}

		function testPool() {
			assert("pool API present", has("createVec2Pool") || (has("acquire") && has("release")));

			if (has("createVec2Pool")) {
				var pool = Vec2.createVec2Pool(4);
				var item = pool.acquire();

				item[0] = 5;
				item[1] = 6;

				pool.release(item);

				var recycled = pool.acquire();

				assert("pool recycles vectors", recycled === item || (recycled[0] === 0 && recycled[1] === 0));
			}

			if (has("acquire") && has("release")) {
				var globalItem = Vec2.acquire();
				Vec2.release(globalItem);
				assert("global pool acquire/release works", true);
			}
		}

		function fillSOA(soa, x, y) {
			if (has("soaFill")) {
				Vec2.soaFill(soa, [x, y]);
			} else {
				soa.x.fill(x);
				soa.y.fill(y);
			}
		}

		function testSOA() {
			assert("SOA API present", has("createVec2SOA") && has("soaAdd") && has("soaAABB"));

			if (!has("createVec2SOA")) {
				return;
			}

			var count = 16;
			var a = Vec2.createVec2SOA(count);
			var b = Vec2.createVec2SOA(count);
			var out = Vec2.createVec2SOA(count);
			var box = {};

			fillSOA(a, 2, 3);
			fillSOA(b, 4, 5);

			assert("SOA fill works", a.x[0] === 2 && a.y[0] === 3);

			if (has("soaGet")) {
				Vec2.soaGet(tmpA, a, 4);
				assert("soaGet works", tmpA[0] === 2 && tmpA[1] === 3);
			}

			if (has("soaSet")) {
				Vec2.soaSet(a, 5, [7, 8]);
				assert("soaSet works", a.x[5] === 7 && a.y[5] === 8);
			}

			Vec2.soaAdd(out, a, b);
			assert("soaAdd works", out.x[0] === 6 && out.y[0] === 8);

			if (has("soaScale")) {
				Vec2.soaScale(out, a, 3);
				assert("soaScale works", out.x[0] === 6 && out.y[0] === 9);
			}

			if (has("soaNormalize")) {
				Vec2.soaNormalize(out, a);
				var len = Math.sqrt(out.x[0] * out.x[0] + out.y[0] * out.y[0]);
				assert("soaNormalize works", approx(len, 1, 1e-4));
			}

			if (has("soaDot")) {
				var dotSum = Vec2.soaDot(a, b);
				assert("soaDot works", isFinite(dotSum) && dotSum > 0);
			}

			if (has("soaAABB")) {
				Vec2.soaAABB(box, a);
				assert(
					"soaAABB works",
					isFinite(box.minX) && isFinite(box.minY) &&
					isFinite(box.maxX) && isFinite(box.maxY)
				);
			}

			if (has("soaTransformMat2d")) {
				Vec2.soaTransformMat2d(out, a, [1, 0, 0, 1, 1, 2]);
				assert("soaTransformMat2d works", approx(out.x[0], 3) && approx(out.y[0], 5));
			}
		}

		function testProcedural() {
			assert(
				"procedural API present",
				has("valueNoise2D") && has("gradientNoise2D") && has("fbm2D") && has("voronoi2D")
			);

			if (has("valueNoise2D")) {
				assert("valueNoise2D finite", isFinite(Vec2.valueNoise2D(1.23, 4.56)));
			}

			if (has("gradientNoise2D")) {
				assert("gradientNoise2D finite", isFinite(Vec2.gradientNoise2D(1.23, 4.56)));
			}

			if (has("fbm2D")) {
				var fbm = Vec2.fbm2D(0.123, 0.456, 4);
				assert("fbm2D finite", isFinite(fbm));
			}

			if (has("voronoi2D")) {
				var voronoiOut = [0, 0];
				Vec2.voronoi2D(voronoiOut, 0.5, 0.5);
				assert("voronoi2D finite", isFinite(voronoiOut[0]) && voronoiOut[0] >= 0);
			}

			if (has("soaFillNoise2D")) {
				var soa = Vec2.createVec2SOA(64);
				Vec2.soaFillNoise2D(soa, 0.05, 2, "fbm");
				assert("soaFillNoise2D finite", isFinite(soa.x[0]) && isFinite(soa.y[0]));
			}
		}

		function testAnimation() {
			assert(
				"animation API present",
				has("quadraticBezier") && has("cubicBezier") && has("catmullRom") && has("springDamp2")
			);

			if (has("quadraticBezier")) {
				Vec2.quadraticBezier(tmpA, Vec2.fromValues(0, 0), Vec2.fromValues(5, 5), Vec2.fromValues(10, 0), 0);
				assert("quadraticBezier t=0", approx(tmpA[0], 0) && approx(tmpA[1], 0));

				Vec2.quadraticBezier(tmpA, Vec2.fromValues(0, 0), Vec2.fromValues(5, 5), Vec2.fromValues(10, 0), 1);
				assert("quadraticBezier t=1", approx(tmpA[0], 10) && approx(tmpA[1], 0));
			}

			if (has("cubicBezier")) {
				Vec2.cubicBezier(
					tmpA,
					Vec2.fromValues(0, 0),
					Vec2.fromValues(1, 2),
					Vec2.fromValues(3, 4),
					Vec2.fromValues(10, 10),
					1
				);
				assert("cubicBezier t=1", approx(tmpA[0], 10) && approx(tmpA[1], 10));
			}

			if (has("catmullRom")) {
				Vec2.catmullRom(
					tmpA,
					Vec2.fromValues(-1, -1),
					Vec2.fromValues(0, 0),
					Vec2.fromValues(1, 1),
					Vec2.fromValues(2, 2),
					0
				);
				assert("catmullRom t=0", approx(tmpA[0], 0) && approx(tmpA[1], 0));
			}

			if (has("springDamp2")) {
				var current = Vec2.fromValues(0, 0);
				var target = Vec2.fromValues(10, 5);
				var velocity = Vec2.fromValues(0, 0);
				var out = Vec2.create();

				Vec2.springDamp2(out, current, target, velocity, 0.2, 1 / 60, 10000);

				assert("springDamp2 moves toward target", out[0] > 0 && out[1] > 0);
			}
		}

		function testOrbital() {
			assert(
				"orbital API present",
				has("polarToCartesian") && has("cartesianToPolar") &&
				has("ellipsePoint") && has("keplerOrbit2D") && has("orbitalSpeed2D")
			);

			if (has("polarToCartesian")) {
				Vec2.polarToCartesian(tmpA, 1, 0);
				assert("polarToCartesian works", approx(tmpA[0], 1) && approx(tmpA[1], 0));
			}

			if (has("cartesianToPolar")) {
				Vec2.cartesianToPolar(tmpB, 1, 0);
				assert("cartesianToPolar works", approx(tmpB[0], 1) && approx(tmpB[1], 0));
			}

			if (has("ellipsePoint")) {
				Vec2.ellipsePoint(tmpA, 0, 0, 2, 1, 0);
				assert("ellipsePoint works", approx(tmpA[0], 2) && approx(tmpA[1], 0));
			}

			if (has("keplerOrbit2D")) {
				Vec2.keplerOrbit2D(tmpA, 1, 0.25, 0);
				assert("keplerOrbit2D finite", isFinite(tmpA[0]) && isFinite(tmpA[1]));
			}

			if (has("orbitalSpeed2D")) {
				var speed = Vec2.orbitalSpeed2D(1, 1, 1);
				assert("orbitalSpeed2D finite", isFinite(speed) && speed >= 0);
			}
		}

		function runAsyncTests() {
			assert(
				"chunked async API present",
				has("soaAddChunked") && has("soaScaleChunked") &&
				has("soaNormalizeChunked") && has("soaDotChunked") &&
				has("soaFillNoise2DChunked")
			);

			if (!has("soaAddChunked")) {
				return;
			}

			tests.async++;

			var count = 4096;
			var a = Vec2.createVec2SOA(count);
			var b = Vec2.createVec2SOA(count);
			var out = Vec2.createVec2SOA(count);

			for (var i = 0; i < count; i++) {
				a.x[i] = i % 7;
				a.y[i] = i % 5;
				b.x[i] = 1;
				b.y[i] = 2;
			}

			Promise.resolve()
				.then(function () {
					return Vec2.soaAddChunked(out, a, b, 1024, 2);
				})
				.then(function () {
					assert(
						"soaAddChunked works",
						approx(out.x[10], a.x[10] + b.x[10]) &&
						approx(out.y[10], a.y[10] + b.y[10])
					);

					return Vec2.soaScaleChunked(out, a, 2, 1024, 2);
				})
				.then(function () {
					assert("soaScaleChunked works", approx(out.x[10], a.x[10] * 2));

					return Vec2.soaNormalizeChunked(out, a, 1024, 2);
				})
				.then(function () {
					var len = Math.sqrt(out.x[3] * out.x[3] + out.y[3] * out.y[3]);
					assert("soaNormalizeChunked works", approx(len, 1, 1e-4));

					return Vec2.soaDotChunked(a, b, 1024, 2);
				})
				.then(function (dotSum) {
					assert("soaDotChunked works", isFinite(dotSum));

					return Vec2.soaFillNoise2DChunked(out, 0.01, 2, "fbm", 1024, 2);
				})
				.then(function () {
					assert("soaFillNoise2DChunked works", isFinite(out.x[0]) && isFinite(out.y[0]));
					tests.async--;
					logInfo("Async SOA tests complete.");
				})
				.catch(function (error) {
					tests.async--;
					logError("Async SOA test failed.", error);
				});
		}

		function runTests() {
			logInfo("Running feature tests.");

			try {
				testFlat();
				testPool();
				testSOA();
				testProcedural();
				testAnimation();
				testOrbital();
				runAsyncTests();

				logInfo(
					"Sync tests complete. Passed " + tests.passed + "/" + tests.total +
					", failed " + tests.failed + ", async pending " + tests.async + "."
				);
			} catch (error) {
				logError("Test runner failed.", error);
			}
		}

		function clear() {
			ctx.fillStyle = "#060a0f";
			ctx.fillRect(0, 0, state.width, state.height);
		}

		function drawVectorField(dt) {
			var spacing = 42;
			var cols = Math.ceil(state.width / spacing);
			var rows = Math.ceil(state.height / spacing);

			ctx.lineWidth = 1;

			for (var row = 0; row < rows; row++) {
				for (var col = 0; col < cols; col++) {
					var px = col * spacing + spacing * 0.5;
					var py = row * spacing + spacing * 0.5;

					var noise = safeFbm(
						px * 0.006 + state.time * 0.08,
						py * 0.006 - state.time * 0.05,
						2
					);

					var angle = noise * Math.PI * 4;

					var dxPointer = state.pointer[0] - px;
					var dyPointer = state.pointer[1] - py;
					var dist = Math.sqrt(dxPointer * dxPointer + dyPointer * dyPointer);
					var influence = clamp(1 - dist / 240, 0, 1);

					if (influence > 0) {
						var pointerAngle = Math.atan2(dyPointer, dxPointer);
						angle = angle * (1 - influence) + pointerAngle * influence;
					}

					var lineLength = 6 + 10 * influence + 4 * Math.sin(state.time * 2 + noise * 6);
					var dx = Math.cos(angle) * lineLength;
					var dy = Math.sin(angle) * lineLength;

					var hue = Math.floor(190 + noise * 80);

					ctx.strokeStyle = "hsla(" + hue + ", 90%, 60%, 0.75)";
					ctx.beginPath();
					ctx.moveTo(px - dx * 0.5, py - dy * 0.5);
					ctx.lineTo(px + dx * 0.5, py + dy * 0.5);
					ctx.stroke();
				}
			}
		}

		function drawFlowParticles(dt) {
			if (!state.positions || !state.velocities) {
				ctx.fillStyle = "#ff5d73";
				ctx.font = "14px monospace";
				ctx.fillText("SOA particle buffers unavailable.", 16, state.height * 0.5);
				return;
			}

			var positions = state.positions;
			var velocities = state.velocities;
			var count = positions.count;
			var speed = 36;

			ctx.fillStyle = "rgba(53,200,255,0.55)";

			for (var i = 0; i < count; i++) {
				var x = positions.x[i];
				var y = positions.y[i];

				var angle = safeFbm(
					x * 0.0035 + state.time * 0.02,
					y * 0.0035,
					3
				) * Math.PI * 6;

				var dx = state.pointer[0] - x;
				var dy = state.pointer[1] - y;
				var distSq = dx * dx + dy * dy;

				if (distSq < 25600 && distSq > 1) {
					var pointerAngle = Math.atan2(dy, dx);
					angle = pointerAngle * 0.35 + angle * 0.65;
				}

				velocities.x[i] = Math.cos(angle) * speed;
				velocities.y[i] = Math.sin(angle) * speed;

				x += velocities.x[i] * dt;
				y += velocities.y[i] * dt;

				if (x < 0) {
					x += state.width;
				} else if (x > state.width) {
					x -= state.width;
				}

				if (y < 0) {
					y += state.height;
				} else if (y > state.height) {
					y -= state.height;
				}

				positions.x[i] = x;
				positions.y[i] = y;

				ctx.fillRect(x, y, 1.25, 1.25);
			}
		}

		function drawVoronoiNoise() {
			var cell = 18;
			var scale = 0.016;

			for (var y = 0; y < state.height; y += cell) {
				for (var x = 0; x < state.width; x += cell) {
					var sx = (x + cell * 0.5) * scale;
					var sy = (y + cell * 0.5) * scale + state.time * 0.02;

					safeVoronoi(tmpVoronoi, sx, sy);

					var d = clamp(tmpVoronoi[0], 0, 1);
					var id = tmpVoronoi[1] || 0;

					var r = Math.floor(18 + 72 * d + (id % 47));
					var g = Math.floor(30 + 130 * d);
					var b = Math.floor(55 + 170 * (1 - d));

					ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
					ctx.fillRect(x, y, cell, cell);
				}
			}

			safeVoronoi(tmpVoronoi, state.pointer[0] * scale, state.pointer[1] * scale + state.time * 0.02);

			ctx.strokeStyle = "rgba(255,255,255,0.35)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.arc(state.pointer[0], state.pointer[1], 14 + tmpVoronoi[0] * 22, 0, TAU);
			ctx.stroke();
		}

		function drawCurve(evaluate, segments) {
			ctx.beginPath();

			for (var i = 0; i <= segments; i++) {
				var t = i / segments;

				evaluate(t, tmpP);

				if (i === 0) {
					ctx.moveTo(tmpP[0], tmpP[1]);
				} else {
					ctx.lineTo(tmpP[0], tmpP[1]);
				}
			}

			ctx.stroke();
		}

		function drawCurvesAndSpring(dt) {
			var w = state.width;
			var h = state.height;

			if (has("quadraticBezier")) {
				Vec2.set(state.c0, w * 0.10, h * 0.78);
				Vec2.set(state.c1, state.pointer[0], state.pointer[1]);
				Vec2.set(state.c2, w * 0.90, h * 0.78);

				ctx.strokeStyle = "rgba(74,222,128,0.85)";
				ctx.lineWidth = 2;

				drawCurve(function (t, out) {
					Vec2.quadraticBezier(out, state.c0, state.c1, state.c2, t);
				}, 48);
			}

			if (has("cubicBezier")) {
				Vec2.set(state.c0, w * 0.12, h * 0.58);
				Vec2.set(state.c1, w * 0.32 + Math.sin(state.time * 0.8) * 42, h * 0.22);
				Vec2.set(state.c2, w * 0.62, h * 0.22 + Math.cos(state.time * 0.9) * 36);
				Vec2.set(state.c3, w * 0.88, h * 0.58);

				ctx.strokeStyle = "rgba(53,200,255,0.9)";
				ctx.lineWidth = 2;

				drawCurve(function (t, out) {
					Vec2.cubicBezier(out, state.c0, state.c1, state.c2, state.c3, t);
				}, 64);
			}

			if (has("catmullRom")) {
				Vec2.set(state.c0, w * 0.08, h * 0.38);
				Vec2.set(state.c1, w * 0.34, h * 0.62);
				Vec2.set(state.c2, w * 0.60, h * 0.34);
				Vec2.set(state.c3, w * 0.88, h * 0.52);

				ctx.strokeStyle = "rgba(255,179,71,0.9)";
				ctx.lineWidth = 2;

				drawCurve(function (t, out) {
					Vec2.catmullRom(out, state.c0, state.c1, state.c2, state.c3, t);
				}, 64);
			}

			var anchorX = w * 0.5;
			var anchorY = h * 0.14;

			if (has("springDamp2")) {
				Vec2.springDamp2(
					state.springPos,
					state.springPos,
					state.pointerTarget,
					state.springVel,
					0.16,
					dt,
					8000
				);
			} else {
				Vec2.lerp(state.springPos, state.pointerTarget, 0.12);
				Vec2.set(state.springVel, 0, 0);
			}

			ctx.strokeStyle = "rgba(255,255,255,0.4)";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(anchorX, anchorY);
			ctx.lineTo(state.springPos[0], state.springPos[1]);
			ctx.stroke();

			ctx.fillStyle = "rgba(255,93,115,0.95)";
			ctx.beginPath();
			ctx.arc(anchorX, anchorY, 4, 0, TAU);
			ctx.fill();

			ctx.fillStyle = "rgba(53,200,255,0.95)";
			ctx.beginPath();
			ctx.arc(state.springPos[0], state.springPos[1], 7, 0, TAU);
			ctx.fill();
		}

		function drawOrbital(dt) {
			var cx = state.width * 0.5;
			var cy = state.height * 0.52;
			var base = Math.min(state.width, state.height) * 0.42;

			ctx.fillStyle = "rgba(255,179,71,0.95)";
			ctx.beginPath();
			ctx.arc(cx, cy, 8, 0, TAU);
			ctx.fill();

			for (var i = 0; i < state.orbits.length; i++) {
				var orbit = state.orbits[i];
				var semiMajor = base * orbit.a;

				ctx.strokeStyle = orbit.color;
				ctx.lineWidth = 1;
				ctx.beginPath();

				if (has("keplerOrbit2D")) {
					for (var sample = 0; sample <= 96; sample++) {
						var M = sample / 96 * TAU;

						Vec2.keplerOrbit2D(tmpP, semiMajor, orbit.e, M);

						var pathX = cx + tmpP[0];
						var pathY = cy + tmpP[1];

						if (sample === 0) {
							ctx.moveTo(pathX, pathY);
						} else {
							ctx.lineTo(pathX, pathY);
						}
					}
				} else {
					ctx.arc(cx, cy, semiMajor, 0, TAU);
				}

				ctx.stroke();

				var bodyM = state.time * orbit.speed + orbit.phase;

				if (has("keplerOrbit2D")) {
					Vec2.keplerOrbit2D(tmpP, semiMajor, orbit.e, bodyM);
				} else {
					Vec2.set(tmpP, Math.cos(bodyM) * semiMajor, Math.sin(bodyM) * semiMajor);
				}

				var bodyX = cx + tmpP[0];
				var bodyY = cy + tmpP[1];

				if (has("keplerOrbit2D")) {
					Vec2.keplerOrbit2D(tmpQ, semiMajor, orbit.e, bodyM + 0.03);
					Vec2.subtract(tmpB, tmpQ, tmpP);

					if (Vec2.length(tmpB) > 1e-5) {
						Vec2.normalize(tmpB, tmpB);

						ctx.strokeStyle = "rgba(255,255,255,0.35)";
						ctx.beginPath();
						ctx.moveTo(bodyX, bodyY);
						ctx.lineTo(bodyX + tmpB[0] * 22, bodyY + tmpB[1] * 22);
						ctx.stroke();
					}
				}

				ctx.fillStyle = orbit.color;
				ctx.beginPath();
				ctx.arc(bodyX, bodyY, 4, 0, TAU);
				ctx.fill();
			}
		}

		function drawHUD() {
			var lines = [
				"002 vec2 demo",
				"mode " + state.mode + " : " + MODE_NAMES[state.mode],
				"fps " + (isFinite(state.fps) ? state.fps.toFixed(0) : "0"),
				"tests " + tests.passed + "/" + tests.total + " failed " + tests.failed + " async " + tests.async,
				"particles " + state.particleCount,
				"click / space : next mode"
			];

			var lineHeight = 16;
			var padding = 8;
			var boxWidth = 270;
			var boxHeight = lines.length * lineHeight + padding * 2;

			ctx.fillStyle = "rgba(8,10,14,0.72)";
			ctx.fillRect(8, 8, boxWidth, boxHeight);

			ctx.strokeStyle = "rgba(255,255,255,0.08)";
			ctx.lineWidth = 1;
			ctx.strokeRect(8.5, 8.5, boxWidth, boxHeight);

			ctx.font = "12px monospace";
			ctx.textBaseline = "top";

			for (var i = 0; i < lines.length; i++) {
				if (i === 0) {
					ctx.fillStyle = "#35c8ff";
				} else if (i === 3) {
					ctx.fillStyle = tests.failed > 0 ? "#ff5d73" : "#4ade80";
				} else {
					ctx.fillStyle = "#c8d4e0";
				}

				ctx.fillText(lines[i], 8 + padding, 8 + padding + i * lineHeight);
			}
		}

		function frame(timestamp) {
			if (!state.running) {
				return;
			}

			requestAnimationFrame(frame);

			try {
				if (typeof timestamp !== "number") {
					timestamp = now();
				}

				var dt = (timestamp - state.last) / 1000;

				state.last = timestamp;

				if (!isFinite(dt) || dt <= 0 || dt > 0.1) {
					dt = 0.016;
				}

				state.time += dt;
				state.modeTime += dt;
				state.frame++;

				state.fps = state.fps * 0.9 + (1 / dt) * 0.1;

				Vec2.lerp(state.pointer, state.pointerTarget, 0.18);

				if (state.modeTime > 14) {
					nextMode();
				}

				clear();

				if (state.mode === 0) {
					drawVectorField(dt);
				} else if (state.mode === 1) {
					drawFlowParticles(dt);
				} else if (state.mode === 2) {
					drawVoronoiNoise();
				} else if (state.mode === 3) {
					drawCurvesAndSpring(dt);
				} else if (state.mode === 4) {
					drawOrbital(dt);
				}

				drawHUD();
			} catch (error) {
				state.frameErrors++;

				if (state.frameErrors <= 3) {
					logError("Frame error.", error);
				}

				if (state.frameErrors > 60) {
					state.running = false;
				}
			}
		}

		function init() {
			resize();

			Vec2.set(state.pointer, state.width * 0.5, state.height * 0.55);
			Vec2.copy(state.pointerTarget, state.pointer);

			Vec2.set(state.springPos, state.width * 0.5, state.height * 0.25);
			Vec2.set(state.springVel, 0, 0);

			initParticles();
			initOrbits();
			bindEvents();
			runTests();

			globalScope.__VEC2_DEMO__ = {
				state: state,
				tests: tests,
				nextMode: nextMode
			};

			logInfo("Demo started.");

			requestAnimationFrame(frame);
		}

		try {
			init();
		} catch (error) {
			logError("Initialization failed.", error);
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", boot);
	} else {
		boot();
	}
})();