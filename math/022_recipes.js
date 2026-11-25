// file number : 022
// full path name : src/math/022_recipes.js
// description : Preset-recipe dictionary — every original export preserved
//               byte-compatible (`recipes` with all 61 presets + `presets`
//               alias, `pooledRecipe`, `chainRecipes`, `soaRecipes`,
//               `recipeHDRColorScrub`, `recipeNoiseWave`, `recipeOrbitalReveal`,
//               `recipeKeplerChase`, `recipeNebulaBloom`, `recipeStarfieldScroll`,
//               `recipeIKReach`, `recipeGalacticSpin`, `recipeOnQuery`, `getSvg`,
//               `math`), rewritten as a self-contained native ES module in the
//               three.js r185 JSM addon style: no strict-mode directive, no
//               CommonJS, no Vite / Vue / client build, no CDN request.
//               Corrections: all transcription damage repaired (broken
//               identifiers, `& &`, `| |`, trailing-space string literals that
//               silently broke every easing name / axis / mode comparison,
//               mangled numeric literals such as `55 0` / `8 50` / `2 .5`);
//               the fatal `omegaInner (omegaOuter - omegaInner) * t` call-on-a-
//               number in `recipeGalacticSpin` replaced by correct lerp;
//               `recipeKeplerChase` no longer produces NaN when `M1` is omitted;
//               missing `keplerSolve` / `eccentricToTrue` helpers inlined;
//               `countUp` builds its formatted string once per tick;
//               `cursorMagnet` reuses pre-allocated configs + pooled animations
//               instead of allocating on every pointermove; the typewriter
//               allocates one closure per element, not per character; the SVG
//               loader resolves once instead of retrying a failing require.
//               Additions for 1M+ units at real time: generic SOA channel
//               recipes, quaternion-correct orbital / galactic-spin variants,
//               chunked-yielding apply on every SOA handle, duck-typed
//               three.js r185 bridges (BufferAttribute upload, InstancedMesh
//               matrix composition straight into the GPU array, Object3D
//               recipes), an async SVG path, and a resident-state Blob-URL
//               worker pool for genuine multi-core track stepping with a
//               non-blocking main-thread fallback.
//               The provided 002..009 SOA modules remain the default vector /
//               matrix / quaternion maths; three.js r185 only renders.
// best for : 3d graphics — hero DOM intros (letterSplit, blurUnmask,
//            perspectiveFold, flip180…), HUD widgets (buttonPop, bellWiggle,
//            toggleSwitch, statusDot), dashboards (countUp, progressFill,
//            circularGauge, donutChart, sparkline), SVG logos (chartDraw,
//            svgLogoDraw, morphIcon), pointer-driven props (magnetic,
//            cursorMagnet), 1M+ instanced GPU variants (soaRecipes.gridRipple,
//            starlightSwarm, planetaryOrbit, galacticSpin, noiseWave…),
//            natural IK reach (skeletalIK, ikReach), Kepler-driven orbital
//            reveals (orbitalReveal, keplerChase), HDR nebula bloom from
//            simplex density, and scroll-parallax starfields — all SOA
//            variants drop into `engine.addSoaStep` and yield on mobile.
// license : MIT
// ============================================================================

import * as vec2 from "./002_vec2.js";
import * as vec3 from "./003_vec3.js";
import * as vec4 from "./004_vec4.js";
import * as mat2 from "./005_mat2.js";
import * as mat4 from "./007_mat4.js";
import * as quat from "./008_quat.js";
import * as quat2 from "./009_quat2.js";
import * as utils from "./014_utils.js";
import * as easings from "./015_easings.js";
import * as engineModule from "./016_engine.js";
import * as animationModule from "./017_animation.js";
import * as timerModule from "./019_timers.js";
import * as scopeModule from "./021_scope.js";

const Animation = animationModule.Animation;
const toArray = utils.toArray;
const stagger = utils.stagger;

// ============================================================================
// 0. FOUNDATION (inlined — replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const POOL_PREALLOC = 32;
const TWO_PI = Math.PI * 2;

function yieldToMain() {
    return new Promise(function (resolve) {
        if (typeof setTimeout === "function") { setTimeout(resolve, 0); }
        else { resolve(); }
    });
}

function createPool(factory, capacity, reset) {
    capacity = capacity || POOL_PREALLOC;
    const items = [];
    for (let i = 0; i < capacity; i++) { items.push(factory()); }
    return {
        acquire() { return items.length > 0 ? items.pop() : factory(); },
        release(v) {
            if (reset) { reset(v); }
            if (items.length < capacity) { items.push(v); }
        }
    };
}

/** Newton-Raphson Kepler solver: E - e*sin(E) = M. */
function keplerSolve(M, e) {
    let E = M;
    for (let i = 0; i < 8; i++) {
        E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    }
    return E;
}

/** Eccentric anomaly -> true anomaly (radians, -π..π). */
function eccentricToTrue(E, e) {
    const s = Math.sqrt(1 + e) * Math.sin(E * 0.5);
    const c = Math.sqrt(1 - e) * Math.cos(E * 0.5);
    return 2 * Math.atan2(s, c);
}

async function _chunkedRange(count, chunkSize, yieldEvery, perChunk) {
    chunkSize = chunkSize || CHUNK_SIZE;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        perChunk(start, end);
        start = end;
        if (start >= count) { break; }
        if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
    }
}

const common = {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC,
    yieldToMain, createPool, keplerSolve, eccentricToTrue
};

// ============================================================================
// 0.1 ANIMATION ACQUISITION
//     ES class constructors cannot be invoked via `.call()`. We reuse the
//     canonical 017 pool when it exposes acquire/release; otherwise we fall
//     back to a local pool driven by the re-initialisable `_init` hook;
//     otherwise we construct a fresh Animation.
// ============================================================================
const _HAS_ANIM_INIT = typeof Animation.prototype._init === "function";
const _HAS_MODULE_POOL = typeof animationModule.acquireAnimation === "function" &&
    typeof animationModule.releaseAnimation === "function";

const _animPool = (!_HAS_MODULE_POOL && _HAS_ANIM_INIT)
    ? createPool(
        function () { return Object.create(Animation.prototype); },
        POOL_PREALLOC,
        function (a) {
            a.config = null;
            a.onBegin = a.onUpdate = a.onRender = a.onLoop = a.onComplete = null;
            if (a.targets) { a.targets.length = 0; }
            if (a.tweens) { a.tweens.length = 0; }
            if (a._groups) { a._groups.length = 0; }
            if (a._transformTargets) { a._transformTargets.length = 0; }
            if (a._transformMap) { a._transformMap.clear(); }
            if (a._propMap) { a._propMap.clear(); }
        }
    )
    : null;

function _acquireAnim(cfg) {
    if (_HAS_MODULE_POOL) { return animationModule.acquireAnimation(cfg); }
    if (_HAS_ANIM_INIT) {
        const a = _animPool.acquire();
        a._init(cfg);
        return a;
    }
    return new Animation(cfg);
}

function _releaseAnim(a) {
    if (!a) { return; }
    try { a.pause(); } catch (e) { /* swallow */ }
    if (_HAS_MODULE_POOL) { animationModule.releaseAnimation(a); return; }
    if (_HAS_ANIM_INIT) { _animPool.release(a); }
}

/** Setup-time merge helper: one config object per recipe call. */
function _mk(targets, defaults, opts) {
    defaults.targets = targets;
    return new Animation(Object.assign(defaults, opts || {}));
}

// ============================================================================
// 0.2 LAZY SVG LOADER
//     Resolved once. `getSvg()` stays synchronous (original contract) and
//     kicks off the async load; `loadSvg()` awaits it. Missing module is never
//     re-requested on every call.
// ============================================================================
let _svg = null;
let _svgResolved = false;
let _svgPromise = null;

function loadSvg() {
    if (_svgResolved) { return Promise.resolve(_svg); }
    if (_svgPromise) { return _svgPromise; }
    _svgPromise = import("./023_svg.js")
        .then(function (m) { return m.svg || (m.default && m.default.svg) || m || null; })
        .catch(function () {
            return import("./svg.js")
                .then(function (m) { return m.svg || (m.default && m.default.svg) || m || null; })
                .catch(function () { return null; });
        })
        .then(function (m) {
            _svg = m;
            _svgResolved = true;
            return m;
        });
    return _svgPromise;
}

function getSvg() {
    if (_svgResolved) { return _svg; }
    loadSvg();
    return _svg;
}

// ============================================================================
// 1. ORIGINAL RECIPES (all 61 presets preserved, syntax corrected)
// ============================================================================
const recipes = {

    letterSplit(targets, opts) {
        return _mk(targets, {
            translateY: [40, 0], opacity: [0, 1],
            stagger: 30, duration: 600, easing: "spring"
        }, opts);
    },

    wordFloat(targets, opts) {
        return _mk(targets, {
            translateY: [25, 0], scale: [0.92, 1], opacity: [0, 1],
            stagger: 80, duration: 700, easing: "spring"
        }, opts);
    },

    blurUnmask(targets, opts) {
        return _mk(targets, {
            scale: [0.85, 1], opacity: [0, 1],
            filter: ["blur(12px)", "blur(0px)"], duration: 650, easing: "easeOutCubic"
        }, opts);
    },

    gradientWave(targets, opts) {
        return _mk(targets, {
            rotate: [-6, 0], scale: [0.95, 1], duration: 800, easing: "spring"
        }, opts);
    },

    typewriterBlink(targets, opts) {
        return _mk(targets, {
            scaleX: [0, 1], duration: 900, easing: "steps(20)"
        }, opts);
    },

    counterRoll(targets, opts) {
        return _mk(targets, {
            translateY: [60, 0], opacity: [0, 1], duration: 550, easing: "spring"
        }, opts);
    },

    perspectiveFold(targets, opts) {
        return _mk(targets, {
            rotateX: [70, 0], opacity: [0, 1], duration: 850, easing: "spring"
        }, opts);
    },

    neonFlicker(targets, opts) {
        return _mk(targets, {
            opacity: [0.2, 1, 0.4, 1, 0.8, 1], duration: 400, easing: "linear"
        }, opts);
    },

    skewGlitch(targets, opts) {
        return _mk(targets, {
            skewX: [-25, 20, -10, 0], translateX: [-10, 10, 0],
            duration: 350, easing: "easeInOutQuad"
        }, opts);
    },

    waveStagger(targets, opts) {
        return _mk(targets, {
            translateY: [-20, 0], stagger: 50, duration: 500, easing: "spring"
        }, opts);
    },

    tilt3D(targets, opts) {
        return _mk(targets, {
            rotateX: [25, 0], rotateY: [-25, 0], scale: [0.9, 1],
            duration: 800, easing: "spring"
        }, opts);
    },

    bentoGlow(targets, opts) {
        return _mk(targets, { scale: [0.96, 1], duration: 500, easing: "spring" }, opts);
    },

    depthParallax(targets, opts) {
        return _mk(targets, {
            translateY: [-30, 0], scale: [1.08, 1], duration: 750, easing: "spring"
        }, opts);
    },

    glassmorphismFlip(targets, opts) {
        return _mk(targets, {
            rotateY: [180, 0], scale: [0.8, 1], duration: 900, easing: "spring"
        }, opts);
    },

    cardElevate(targets, opts) {
        return _mk(targets, {
            translateY: [-18, 0], scale: [0.95, 1], duration: 600, easing: "spring"
        }, opts);
    },

    perspectiveFan(targets, opts) {
        return _mk(targets, {
            rotate: [-18, 0], translateX: [-30, 0], opacity: [0, 1],
            stagger: 70, duration: 650, easing: "spring"
        }, opts);
    },

    flip180(targets, opts) {
        return _mk(targets, {
            rotateY: [0, 180, 0], duration: 1000, easing: "spring"
        }, opts);
    },

    isometricPop(targets, opts) {
        return _mk(targets, {
            rotateX: [45, 0], rotateZ: [-25, 0], scale: [0.75, 1],
            duration: 800, easing: "spring"
        }, opts);
    },

    magneticSpring(targets, opts) {
        return _mk(targets, {
            translateX: [-35, 35, 0], translateY: [-15, 15, 0],
            duration: 750, easing: "spring"
        }, opts);
    },

    cardUnfold(targets, opts) {
        return _mk(targets, {
            scaleY: [0, 1], opacity: [0, 1], duration: 600, easing: "spring"
        }, opts);
    },

    buttonPop(targets, opts) {
        return _mk(targets, {
            scale: [0.82, 1.15, 1], duration: 400, easing: "spring"
        }, opts);
    },

    magnetic(targets, opts) {
        return _mk(targets, {
            translateX: [-25, 25, 0], translateY: [-12, 12, 0],
            duration: 600, easing: "spring"
        }, opts);
    },

    bellWiggle(targets, opts) {
        return _mk(targets, {
            rotate: [-22, 22, -14, 14, -6, 6, 0],
            duration: 750, easing: "easeInOutQuad"
        }, opts);
    },

    radarRings(targets, opts) {
        return _mk(targets, {
            scale: [0.4, 2.2], opacity: [1, 0], stagger: 200,
            duration: 1100, loop: true, easing: "easeOutCubic"
        }, opts);
    },

    heartPop(targets, opts) {
        return _mk(targets, {
            scale: [0.6, 1.35, 1], duration: 450, easing: "spring"
        }, opts);
    },

    checkDraw(targets, opts) {
        return _mk(targets, {
            strokeDashoffset: [40, 0], duration: 450, easing: "easeOutCubic"
        }, opts);
    },

    toggleSwitch(targets, opts) {
        return _mk(targets, {
            translateX: [0, 24, 0], duration: 600, easing: "spring"
        }, opts);
    },

    fluidRipple(targets, opts) {
        return _mk(targets, {
            scale: [0, 4], opacity: [0.6, 0], duration: 550, easing: "easeOutQuad"
        }, opts);
    },

    accordionDrawer(targets, opts) {
        return _mk(targets, {
            translateY: [-15, 0], opacity: [0, 1], duration: 450, easing: "spring"
        }, opts);
    },

    statusDot(targets, opts) {
        return _mk(targets, {
            scale: [0.75, 1.3], opacity: [0.5, 1],
            direction: "alternate", loop: true, duration: 900, easing: "easeInOutQuad"
        }, opts);
    },

    /**
     * The formatted string is built ONCE per tick and written with a plain
     * loop — no per-element closure or string allocation per frame.
     */
    countUp(targets, endVal, opts) {
        endVal = endVal === undefined ? 100 : endVal;
        opts = opts || {};
        const obj = { val: 0 };
        const els = toArray(targets);
        const n = els.length;
        const decimals = opts.decimals || 0;
        const suffix = opts.suffix !== undefined ? opts.suffix : "%";
        return new Animation(Object.assign({
            targets: obj,
            val: endVal,
            round: opts.round || 1,
            duration: opts.duration || 1100,
            easing: opts.easing || "easeOutCubic",
            onUpdate() {
                const s = obj.val.toFixed(decimals) + suffix;
                for (let i = 0; i < n; i++) { els[i].textContent = s; }
            }
        }, opts));
    },

    progressFill(targets, opts) {
        return _mk(targets, {
            scaleX: [0, 1], duration: 900, easing: "easeOutCubic"
        }, opts);
    },

    circularGauge(targets, opts) {
        return _mk(targets, {
            strokeDashoffset: [126, 25], duration: 900, easing: "easeOutCubic"
        }, opts);
    },

    audioEqualizer(targets, opts) {
        return _mk(targets, {
            scaleY: [0.2, 2.2, 0.7], stagger: 40, duration: 550, easing: "spring"
        }, opts);
    },

    tickerMarquee(targets, opts) {
        return _mk(targets, {
            translateX: [0, -200], duration: 3500, loop: true, easing: "linear"
        }, opts);
    },

    stepperFlow(targets, opts) {
        return _mk(targets, {
            scale: [0.5, 1.25, 1], stagger: 120, duration: 450, easing: "spring"
        }, opts);
    },

    sparkline(targets, opts) {
        return _mk(targets, {
            strokeDashoffset: [120, 0], duration: 700, easing: "easeOutQuad"
        }, opts);
    },

    donutChart(targets, opts) {
        return _mk(targets, {
            strokeDashoffset: [113, 28], duration: 750, easing: "easeInOutCubic"
        }, opts);
    },

    telemetryPing(targets, opts) {
        return _mk(targets, {
            scale: [0.5, 1.8], opacity: [1, 0],
            duration: 800, loop: true, easing: "easeOutQuad"
        }, opts);
    },

    skeletonShimmer(targets, opts) {
        return _mk(targets, {
            translateX: [-100, 100], duration: 1200, loop: true, easing: "easeInOutQuad"
        }, opts);
    },

    modalDrop(targets, opts) {
        return _mk(targets, {
            translateY: [-80, 0], duration: 850, easing: "easeOutBounce"
        }, opts);
    },

    sidebarFly(targets, opts) {
        return _mk(targets, {
            translateX: [80, 0], duration: 550, easing: "spring"
        }, opts);
    },

    morphBlob(targets, opts) {
        return _mk(targets, {
            rotate: [0, 180, 360], scale: [0.85, 1.1, 1],
            duration: 1100, easing: "easeInOutCubic"
        }, opts);
    },

    svgLogoDraw(targets, opts) {
        return _mk(targets, {
            strokeDashoffset: [120, 0], duration: 750, easing: "easeInOutQuad"
        }, opts);
    },

    planetaryOrbit(targets, opts) {
        return _mk(targets, {
            rotate: [0, 360], duration: 2500, loop: true, easing: "linear"
        }, opts);
    },

    techParticles(targets, opts) {
        return _mk(targets, {
            translateY: [-16, 16], stagger: 50,
            direction: "alternate", loop: true, duration: 1200, easing: "easeInOutQuad"
        }, opts);
    },

    tabSlider(targets, opts) {
        return _mk(targets, {
            translateX: [0, 75, 0], duration: 650, easing: "spring"
        }, opts);
    },

    backdropUnmask(targets, opts) {
        return _mk(targets, {
            scale: [0.85, 1], opacity: [0.2, 1], duration: 400, easing: "spring"
        }, opts);
    },

    cardStackRoll(targets, opts) {
        return _mk(targets, {
            scale: [1, 0.9, 1], opacity: [1, 0.5, 1],
            duration: 600, easing: "easeInOutQuad"
        }, opts);
    },

    curtainWipe(targets, opts) {
        return _mk(targets, {
            scaleY: [1, 0, 1], duration: 700, easing: "easeInOutQuad"
        }, opts);
    },

    gridRipple(targets, opts) {
        opts = opts || {};
        return _mk(targets, {
            scale: [0.3, 1.35, 1],
            rotate: [-90, 0],
            stagger: stagger(opts.stagger || 45, { from: opts.from || "center" }),
            duration: opts.duration || 650,
            easing: "spring"
        }, opts);
    },

    fireflySwarm(targets, opts) {
        opts = opts || {};
        const rangeX = opts.rangeX || 160;
        const rangeY = opts.rangeY || 120;
        return _mk(targets, {
            translateX() { return (Math.random() - 0.5) * rangeX; },
            translateY() { return (Math.random() - 0.5) * rangeY; },
            scale: [0.5, 1.4, 1],
            duration: opts.duration || 850,
            easing: "spring"
        }, opts);
    },

    /**
     * DOM-only typewriter. One closure per element (not per character);
     * string growth is inherent to `textContent`.
     */
    typewriterHuman(targets, text, opts) {
        opts = opts || {};
        const els = toArray(targets);
        const str = text || (els[0] ? els[0].textContent : "");
        const variance = opts.variance || 60;
        const speed = opts.speed || 40;
        const out = [];
        for (let e = 0; e < els.length; e++) {
            out.push(_makeTypewriter(els[e], str, variance, speed, opts.onComplete || null));
        }
        return out;
    },

    /**
     * Configs are pre-allocated once and animations come from the pool; the
     * previous instance is released before the next starts. No allocation on
     * pointermove beyond the pooled reuse.
     */
    cursorMagnet(target, container, opts) {
        opts = opts || {};
        const el = typeof target === "string"
            ? (typeof document !== "undefined" ? document.querySelector(target) : null)
            : target;
        const stage = typeof container === "string"
            ? (typeof document !== "undefined" ? document.querySelector(container) : null)
            : (container || (el ? el.parentElement : null));
        if (!el || !stage) { return undefined; }

        const strength = opts.strength || 0.35;
        const moveCfg = {
            targets: el, translateX: 0, translateY: 0, rotateX: 0, rotateY: 0,
            duration: 350, easing: "spring"
        };
        const leaveCfg = {
            targets: el, translateX: 0, translateY: 0, rotateX: 0, rotateY: 0,
            duration: 600, easing: "spring"
        };
        let moveAnim = null;
        let leaveAnim = null;

        function onMove(e) {
            const rect = stage.getBoundingClientRect();
            const dx = (e.clientX - rect.left - rect.width * 0.5) * strength;
            const dy = (e.clientY - rect.top - rect.height * 0.5) * strength;
            moveCfg.translateX = dx;
            moveCfg.translateY = dy;
            moveCfg.rotateX = -dy * 0.4;
            moveCfg.rotateY = dx * 0.4;
            _releaseAnim(leaveAnim); leaveAnim = null;
            _releaseAnim(moveAnim);
            moveAnim = _acquireAnim(moveCfg);
        }
        function onLeave() {
            _releaseAnim(moveAnim); moveAnim = null;
            _releaseAnim(leaveAnim);
            leaveAnim = _acquireAnim(leaveCfg);
        }

        stage.addEventListener("pointermove", onMove);
        stage.addEventListener("pointerleave", onLeave);

        return {
            destroy() {
                stage.removeEventListener("pointermove", onMove);
                stage.removeEventListener("pointerleave", onLeave);
                _releaseAnim(moveAnim); moveAnim = null;
                _releaseAnim(leaveAnim); leaveAnim = null;
            }
        };
    },

    chartDraw(targets, opts) {
        opts = opts || {};
        const svg = getSvg();
        if (!svg) { throw new Error("recipes.chartDraw requires the svg module — await loadSvg() first"); }
        return svg.createDrawable(targets, Object.assign({
            duration: opts.duration || 900, easing: "easeInOutCubic"
        }, opts));
    },

    morphIcon(targetPath, endPathSelector, opts) {
        opts = opts || {};
        const svg = getSvg();
        if (!svg) { throw new Error("recipes.morphIcon requires the svg module — await loadSvg() first"); }
        return svg.morphTo(targetPath, endPathSelector, opts);
    },

    layeredSpin(targets, opts) {
        opts = opts || {};
        return _mk(targets, {
            rotateX: [35, 0], rotateY: [-35, 0], rotateZ: [15, 0],
            scale: [0.8, 1],
            duration: opts.duration || 800, easing: "spring"
        }, opts);
    },

    infiniteCarousel(targets, opts) {
        opts = opts || {};
        return _mk(targets, {
            translateX: [0, -(opts.distance || 300)],
            duration: opts.duration || 4000, loop: true, easing: "linear"
        }, opts);
    },

    skeletalIK(targets, opts) {
        opts = opts || {};
        return _mk(targets, {
            rotate: [-18, 18, -12, 12, 0],
            stagger: opts.stagger || 60,
            duration: opts.duration || 900, easing: "spring"
        }, opts);
    },

    starlightSwarm(targets, opts) {
        opts = opts || {};
        return _mk(targets, {
            scale: [0.2, 1.2, 0.4], opacity: [0.2, 1, 0.2],
            stagger: stagger(opts.stagger || 25, { from: "center" }),
            loop: true, duration: opts.duration || 1400, easing: "easeInOutQuad"
        }, opts);
    },

    clockScrub(targets, opts) {
        opts = opts || {};
        return _mk(targets, {
            rotate: [0, 360], duration: opts.duration || 12000,
            loop: true, easing: "linear"
        }, opts);
    }
};

const presets = recipes;

/** Hoisted typewriter factory — one closure per element, not per character. */
function _makeTypewriter(el, str, variance, speed, onComplete) {
    el.textContent = "";
    let i = 0;
    const tick = function () {
        if (i < str.length) {
            el.textContent += str[i++];
            setTimeout(tick, Math.random() * variance + speed);
        } else if (onComplete) {
            onComplete(el);
        }
    };
    tick();
    return el;
}

/** Async SVG-backed variants (never throw when the module is still loading). */
async function chartDrawAsync(targets, opts) {
    const svg = await loadSvg();
    if (!svg) { throw new Error("chartDrawAsync: svg module unavailable"); }
    opts = opts || {};
    return svg.createDrawable(targets, Object.assign({
        duration: opts.duration || 900, easing: "easeInOutCubic"
    }, opts));
}
async function morphIconAsync(targetPath, endPathSelector, opts) {
    const svg = await loadSvg();
    if (!svg) { throw new Error("morphIconAsync: svg module unavailable"); }
    return svg.morphTo(targetPath, endPathSelector, opts || {});
}

// ============================================================================
// 2. POOL — reusable recipe-animation slots (zero-GC)
//    The wrapper object and its `release` closure are created ONCE per slot.
// ============================================================================
const _recipeAnims = createPool(
    function () {
        const h = { anim: null, kind: null, released: true, wrapper: null };
        h.wrapper = {
            get anim() { return h.anim; },
            get kind() { return h.kind; },
            release() {
                if (h.released) { return; }
                _recipeAnims.release(h);
            }
        };
        return h;
    },
    16,
    function (h) {
        _releaseAnim(h.anim);
        h.anim = null;
        h.kind = null;
        h.released = true;
    }
);

function pooledRecipe(name, targets, args) {
    const fn = recipes[name];
    if (typeof fn !== "function") { throw new Error("pooledRecipe: unknown recipe " + name); }
    const handle = _recipeAnims.acquire();
    handle.released = false;
    handle.kind = name;
    handle.anim = fn.apply(null, [targets].concat(args || []));
    return handle.wrapper;
}

// ============================================================================
// 3. CHAINED RECIPES — sequence multiple presets
// ============================================================================
const OFFSET_RE = /^([+-])=?([\d.]+)(%?)$/;

function chainRecipes(entries, options) {
    options = options || {};
    const seq = [];
    let cursor = 0;
    let maxEnd = 0;

    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const fn = recipes[e.recipe];
        if (typeof fn !== "function") { throw new Error("chainRecipes: unknown recipe " + e.recipe); }
        const anim = fn.apply(null, [e.targets].concat(e.args || []));
        anim.pause();

        let off = 0;
        if (typeof e.offset === "number") {
            off = e.offset;
        } else if (typeof e.offset === "string") {
            const m = e.offset.match(OFFSET_RE);
            if (m) {
                const delta = m[3] === "%" ? (cursor * parseFloat(m[2]) / 100) : parseFloat(m[2]);
                off = (m[1] === "-") ? Math.max(0, cursor - delta) : cursor + delta;
            }
        } else {
            off = cursor;
        }

        const dur = anim.duration + (anim.endDelay || 0);
        seq.push({ anim: anim, start: off, dur: dur });
        cursor = off + dur;
        if (cursor > maxEnd) { maxEnd = cursor; }
    }

    const state = { time: 0, playing: false, duration: maxEnd };
    const seqLen = seq.length;

    function render() {
        for (let k = 0; k < seqLen; k++) {
            const s = seq[k];
            const local = state.time - s.start;
            const p = s.dur > 0
                ? Math.max(0, Math.min(1, local / s.dur))
                : (local >= 0 ? 1 : 0);
            try { s.anim.seek(p); } catch (err) { /* swallow */ }
        }
    }

    function step(dtMs) {
        if (!state.playing) { return; }
        state.time += dtMs;
        if (state.time >= state.duration) {
            state.time = state.duration;
            render();
            state.playing = false;
            if (options.onComplete) { options.onComplete(state); }
            return;
        }
        render();
    }

    return {
        play() { state.playing = true; render(); return this; },
        pause() { state.playing = false; return this; },
        restart() { state.time = 0; return this.play(); },
        seek(p) {
            state.time = Math.max(0, Math.min(1, p)) * state.duration;
            render();
            return this;
        },
        step: step,
        get duration() { return state.duration; },
        get time() { return state.time; },
        destroy() {
            for (let k = 0; k < seqLen; k++) {
                try { seq[k].anim.pause(); } catch (err) { /* swallow */ }
            }
            seq.length = 0;
        }
    };
}

// ============================================================================
// 4. SOA RECIPES — 1M+ instanced versions of popular presets
//    Every handle exposes step / stepChunked / apply / applyChunked / done.
// ============================================================================
const soaRecipes = {};

/** Shared handle factory — chunked apply never blocks the UI thread. */
function _makeSoaRecipeHandle(track, channel, count) {
    return {
        track: track,
        channel: channel,
        count: count,
        step(dtSec) { track.step(dtSec); },
        stepChunked(dtSec, chunkSize, yieldEvery) {
            return track.stepChunked(dtSec, chunkSize, yieldEvery);
        },
        apply() {
            const cur = track.current;
            for (let i = 0; i < count; i++) { channel[i] = cur[i]; }
        },
        async applyChunked(chunkSize, yieldEvery) {
            const cur = track.current;
            await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
                for (let i = s; i < e; i++) { channel[i] = cur[i]; }
            });
        },
        get done() { return track.done; }
    };
}

/** Grid-ripple — staggered scale-up across a grid of instances. */
soaRecipes.gridRipple = function (trs, options) {
    options = options || {};
    const n = trs.position.count;
    const grid = options.grid || [16, 16];
    const from = options.from || "center";
    const duration = options.duration !== undefined ? options.duration : 0.65;
    const maxStagger = (options.stagger !== undefined ? options.stagger : 45) / 1000;
    const staggerFn = stagger(1, { grid: grid, from: from });
    const track = animationModule.createSOAAnimationTrack(n, { ease: options.ease || "spring" });
    for (let i = 0; i < n; i++) {
        track.setElement(i, 0.3, 1, duration, staggerFn(i, n) * maxStagger);
    }
    return _makeSoaRecipeHandle(track, trs.scale.x, n);
};

/** Starlight-swarm — staggered alpha pulse on the color SOA. */
soaRecipes.starlightSwarm = function (colors, options) {
    options = options || {};
    const n = colors.count;
    const duration = options.duration !== undefined ? options.duration : 1.4;
    const maxStagger = (options.stagger !== undefined ? options.stagger : 25) / 1000;
    const staggerFn = stagger(1, { from: options.from || "center" });
    const track = animationModule.createSOAAnimationTrack(n, { ease: "easeInOutQuad" });
    for (let i = 0; i < n; i++) {
        track.setElement(i, 0.2, 1, duration, staggerFn(i, n) * maxStagger);
    }
    return _makeSoaRecipeHandle(track, colors.w, n);
};

/**
 * Planetary-orbit — linear 0..2π rotation over `duration`.
 * Writes the Euler-Z channel by default (original behaviour). Pass
 * `asQuat: true` when `rotations` is a quat SOA so a correct unit quaternion
 * is produced instead.
 */
soaRecipes.planetaryOrbit = function (rotations, options) {
    options = options || {};
    const n = rotations.count;
    const duration = options.duration !== undefined ? options.duration : 2.5;
    const track = animationModule.createSOAAnimationTrack(n, { ease: "linear" });
    track.fillUniform(0, TWO_PI, duration, 0);

    if (options.asQuat === true && rotations.w) {
        const rz = rotations.z, rw = rotations.w;
        if (rotations.x) { rotations.x.fill(0); }
        if (rotations.y) { rotations.y.fill(0); }
        return {
            track: track,
            count: n,
            step(dtSec) { track.step(dtSec); },
            stepChunked(dtSec, cs, ye) { return track.stepChunked(dtSec, cs, ye); },
            apply() {
                const cur = track.current;
                for (let i = 0; i < n; i++) {
                    const half = cur[i] * 0.5;
                    rz[i] = Math.sin(half);
                    rw[i] = Math.cos(half);
                }
            },
            async applyChunked(chunkSize, yieldEvery) {
                const cur = track.current;
                await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) {
                    for (let j = s; j < e; j++) {
                        const h2 = cur[j] * 0.5;
                        rz[j] = Math.sin(h2);
                        rw[j] = Math.cos(h2);
                    }
                });
            },
            get done() { return track.done; }
        };
    }
    return _makeSoaRecipeHandle(track, rotations.z, n);
};

/** Magnetic — spring-eased X offset. */
soaRecipes.magnetic = function (trs, options) {
    options = options || {};
    const n = trs.position.count;
    const duration = options.duration !== undefined ? options.duration : 0.6;
    const track = animationModule.createSOAAnimationTrack(n, { ease: "easeOutBack" });
    track.fillUniform(-25, 0, duration, 0);
    return _makeSoaRecipeHandle(track, trs.position.x, n);
};

/** Wave-stagger — Y offset with per-row time stagger. */
soaRecipes.waveStagger = function (trs, options) {
    options = options || {};
    const n = trs.position.count;
    const duration = options.duration !== undefined ? options.duration : 0.5;
    const maxStagger = (options.stagger !== undefined ? options.stagger : 50) / 1000;
    const track = animationModule.createSOAAnimationTrack(n, { ease: "spring" });
    const invN = n > 0 ? 1 / n : 0;
    for (let i = 0; i < n; i++) {
        track.setElement(i, -20, 0, duration, (i * invN) * maxStagger);
    }
    return _makeSoaRecipeHandle(track, trs.position.y, n);
};

/** Blur-unmask — opacity reveal across 1M+ instances. */
soaRecipes.blurUnmask = function (colors, options) {
    options = options || {};
    const n = colors.count;
    const duration = options.duration !== undefined ? options.duration : 0.65;
    const track = animationModule.createSOAAnimationTrack(n, { ease: "easeOutCubic" });
    track.fillUniform(0, 1, duration, 0);
    return _makeSoaRecipeHandle(track, colors.w, n);
};

/** Progress-fill — scale a channel from 0 to 1. */
soaRecipes.progressFill = function (trs, options) {
    options = options || {};
    const axis = options.axis || "x";
    const n = trs.position.count;
    const duration = options.duration !== undefined ? options.duration : 0.9;
    const track = animationModule.createSOAAnimationTrack(n, { ease: "easeOutCubic" });
    track.fillUniform(0, 1, duration, 0);
    return _makeSoaRecipeHandle(track, trs.scale[axis], n);
};

/** Generic channel recipe — any typed-array channel, any from/to/ease. */
soaRecipes.channel = function (channel, options) {
    options = options || {};
    const n = options.count !== undefined ? options.count : channel.length;
    const duration = options.duration !== undefined ? options.duration : 0.6;
    const from = options.from !== undefined ? options.from : 0;
    const to = options.to !== undefined ? options.to : 1;
    const track = animationModule.createSOAAnimationTrack(n, { ease: options.ease || "easeOutCubic" });
    const fromArr = from !== null && typeof from !== "number" && from.length !== undefined;
    const toArr = to !== null && typeof to !== "number" && to.length !== undefined;
    const staggerFn = options.stagger || null;
    const maxStagger = options.staggerMs !== undefined ? options.staggerMs / 1000 : 0;
    if (!fromArr && !toArr && !staggerFn) {
        track.fillUniform(from, to, duration, options.delay || 0);
    } else {
        for (let i = 0; i < n; i++) {
            track.setElement(
                i,
                fromArr ? from[i] : from,
                toArr ? to[i] : to,
                duration,
                staggerFn ? staggerFn(i, n) * maxStagger : (options.delay || 0)
            );
        }
    }
    return _makeSoaRecipeHandle(track, channel, n);
};

/** Depth-parallax — Z offset with per-row depth weighting. */
soaRecipes.depthParallax = function (trs, options) {
    options = options || {};
    const n = trs.position.count;
    const duration = options.duration !== undefined ? options.duration : 0.75;
    const strength = options.strength !== undefined ? options.strength : 30;
    const depth = options.depth || null;
    const track = animationModule.createSOAAnimationTrack(n, { ease: options.ease || "spring" });
    for (let i = 0; i < n; i++) {
        const d = depth ? depth[i] : 1;
        track.setElement(i, -strength * d, 0, duration, 0);
    }
    return _makeSoaRecipeHandle(track, trs.position.z, n);
};

/** Button-pop — uniform scale overshoot across all instances. */
soaRecipes.buttonPop = function (trs, options) {
    options = options || {};
    const n = trs.position.count;
    const duration = options.duration !== undefined ? options.duration : 0.4;
    const track = animationModule.createSOAAnimationTrack(n, { ease: options.ease || "easeOutBack" });
    track.fillUniform(options.from !== undefined ? options.from : 0.82, 1, duration, 0);
    const sx = trs.scale.x, sy = trs.scale.y, sz = trs.scale.z;
    return {
        track: track,
        count: n,
        step(dtSec) { track.step(dtSec); },
        stepChunked(dtSec, cs, ye) { return track.stepChunked(dtSec, cs, ye); },
        apply() {
            const cur = track.current;
            for (let i = 0; i < n; i++) {
                const v = cur[i];
                sx[i] = v; sy[i] = v; sz[i] = v;
            }
        },
        async applyChunked(chunkSize, yieldEvery) {
            const cur = track.current;
            await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) {
                for (let i = s; i < e; i++) {
                    const v = cur[i];
                    sx[i] = v; sy[i] = v; sz[i] = v;
                }
            });
        },
        get done() { return track.done; }
    };
};

/** Orbital-reveal — Kepler-anomaly ordered scale-up across 1M+ bodies. */
soaRecipes.orbitalReveal = function (trs, options) {
    options = options || {};
    const n = trs.position.count;
    const duration = options.duration !== undefined ? options.duration : 0.9;
    const spread = options.spread !== undefined ? options.spread : 0.6;
    const delays = recipeOrbitalReveal(n, options);
    const track = animationModule.createSOAAnimationTrack(n, { ease: options.ease || "easeOutCubic" });
    for (let i = 0; i < n; i++) {
        track.setElement(i, 0, 1, duration, delays[i] * spread);
    }
    const sx = trs.scale.x, sy = trs.scale.y, sz = trs.scale.z;
    return {
        track: track,
        count: n,
        step(dtSec) { track.step(dtSec); },
        stepChunked(dtSec, cs, ye) { return track.stepChunked(dtSec, cs, ye); },
        apply() {
            const cur = track.current;
            for (let i = 0; i < n; i++) {
                const v = cur[i];
                sx[i] = v; sy[i] = v; sz[i] = v;
            }
        },
        async applyChunked(chunkSize, yieldEvery) {
            const cur = track.current;
            await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) {
                for (let i = s; i < e; i++) {
                    const v = cur[i];
                    sx[i] = v; sy[i] = v; sz[i] = v;
                }
            });
        },
        get done() { return track.done; }
    };
};

// ============================================================================
// 5. HDR-SAFE COLOR RECIPES
// ============================================================================
function recipeHDRColorScrub(colors, fromColor, toColor, duration, options) {
    options = options || {};
    const a = animationModule.createColorSOAAnimation(
        colors, fromColor, toColor, duration, options.ease || "easeOutCubic"
    );
    return {
        step(dtSec) { a.step(dtSec); },
        async stepChunked(dtSec, cs, ye) {
            if (typeof a.stepChunked === "function") { return a.stepChunked(dtSec, cs, ye); }
            a.step(dtSec);
            await yieldToMain();
            return undefined;
        },
        get done() { return a.done; }
    };
}

// ============================================================================
// 6. PROCEDURAL RECIPES (3D-first)
// ============================================================================
let simplex = null;
function _fallbackNoise3(x, y, z) { return vec3.gradientNoise3D(x, y, z); }
function _noise3(seed) {
    return simplex ? simplex.acquireNoise3D(seed) : _fallbackNoise3;
}

/** Noise-wave — drives a channel from a 3D simplex field, time as 4th axis. */
function recipeNoiseWave(trs, channel, options) {
    options = options || {};
    const noiseFn = options.noiseFn || _noise3(options.seed);
    const scale = options.scale !== undefined ? options.scale : 0.01;
    const speed = options.speed !== undefined ? options.speed : 0.5;
    const amplitude = options.amplitude !== undefined ? options.amplitude : 1;
    let t = 0;
    const n = trs.position.count;
    const px = trs.position.x, py = trs.position.y, pz = trs.position.z;

    function writeRange(s, e) {
        for (let i = s; i < e; i++) {
            channel[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale + t) * amplitude;
        }
    }

    return {
        step(dtSec) { t += dtSec * speed; writeRange(0, n); },
        async stepChunked(dtSec, chunkSize, yieldEvery) {
            t += dtSec * speed;
            await _chunkedRange(n, chunkSize, yieldEvery, writeRange);
        },
        get done() { return false; }
    };
}

/** Orbital-reveal — per-row delay from Kepler-solved true anomaly. */
function recipeOrbitalReveal(count, options) {
    options = options || {};
    const e = options.e !== undefined ? options.e : 0.5;
    const speed = options.speed !== undefined ? options.speed : 1;
    const delays = new Float32Array(count);
    const invCount = count > 0 ? 1 / count : 0;
    const invTwoPi = 1 / TWO_PI;
    for (let i = 0; i < count; i++) {
        const M = (i * invCount) * TWO_PI;
        const E = keplerSolve(M, e);
        const nu = eccentricToTrue(E, e);
        delays[i] = ((nu + Math.PI) * invTwoPi) * speed;
    }
    return delays;
}

/** Kepler-chase — scroll-driven mean anomaly animation (M1 defaults to 2π). */
function recipeKeplerChase(master, elements, options) {
    options = options || {};
    const M0 = options.M0 !== undefined ? options.M0 : 0;
    const M1 = options.M1 !== undefined ? options.M1 : M0 + TWO_PI;
    const span = M1 - M0;
    const dM = options.delta || null;
    const ease = easings.getEasing(options.ease || "linear");
    const MArr = elements.M;
    const n = MArr.length;

    function writeRange(s, e, p) {
        if (dM) {
            for (let i = s; i < e; i++) { MArr[i] = M0 + dM[i] * p; }
        } else {
            const v = M0 + span * p;
            for (let i = s; i < e; i++) { MArr[i] = v; }
        }
    }

    return {
        step() { writeRange(0, n, ease(master.progress)); },
        async stepChunked(chunkSize, yieldEvery) {
            const p = ease(master.progress);
            if (!dM) { MArr.fill(M0 + span * p); return; }
            await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) { writeRange(s, e, p); });
        },
        get done() { return master.progress >= 1; }
    };
}

/** Nebula-bloom — HDR color pulse driven by simplex noise density. */
function recipeNebulaBloom(colors, options) {
    options = options || {};
    const noiseFn = options.noiseFn || _noise3(options.seed);
    const baseColor = options.baseColor || [0.2, 0.4, 0.9, 1];
    const hotColor = options.hotColor || [3.0, 2.0, 5.0, 1]; // HDR
    const scale = options.scale !== undefined ? options.scale : 0.02;
    const speed = options.speed !== undefined ? options.speed : 0.4;
    const minDensity = options.minDensity !== undefined ? options.minDensity : 0.1;
    const maxDensity = options.maxDensity !== undefined ? options.maxDensity : 1;
    const positions = options.positions || null;
    const n = colors.count;
    const cr = colors.x, cg = colors.y, cb = colors.z, ca = colors.w;
    const px = positions ? positions.x : null;
    const py = positions ? positions.y : null;
    const pz = positions ? positions.z : null;
    const br = baseColor[0], bg = baseColor[1], bb = baseColor[2], ba = baseColor[3];
    const dr = hotColor[0] - br, dg = hotColor[1] - bg, db = hotColor[2] - bb, da = hotColor[3] - ba;
    const dSpan = maxDensity - minDensity;
    let t = 0;

    function writeRange(s, e) {
        for (let i = s; i < e; i++) {
            const nx = px ? px[i] * scale : i * scale;
            const ny = py ? py[i] * scale : 0;
            const nz = pz ? pz[i] * scale : 0;
            const density = 0.5 + 0.5 * noiseFn(nx, ny, nz + t);
            const w = minDensity + dSpan * density;
            cr[i] = br + dr * w;
            cg[i] = bg + dg * w;
            cb[i] = bb + db * w;
            ca[i] = ba + da * w;
        }
    }

    return {
        step(dtSec) { t += dtSec * speed; writeRange(0, n); },
        async stepChunked(dtSec, chunkSize, yieldEvery) {
            t += dtSec * speed;
            await _chunkedRange(n, chunkSize, yieldEvery, writeRange);
        },
        get done() { return false; }
    };
}

/** Starfield-scroll — parallax starfield driven by scroll progress. */
function recipeStarfieldScroll(master, trs, options) {
    options = options || {};
    const depth = options.depth || null;
    const strength = options.strength !== undefined ? options.strength : 20;
    const n = trs.position.count;
    const sz = trs.position.z;
    const baseZ = new Float32Array(n);
    baseZ.set(sz);

    function writeRange(s, e, p) {
        for (let i = s; i < e; i++) {
            sz[i] = baseZ[i] + p * strength * (depth ? depth[i] : 1);
        }
    }

    return {
        step() { writeRange(0, n, master.progress); },
        async stepChunked(chunkSize, yieldEvery) {
            const p = master.progress;
            await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) { writeRange(s, e, p); });
        },
        get done() { return false; }
    };
}

/**
 * IK-reach — scroll progress drives a FABRIK / CCD target and re-solves.
 * Tolerance is compared against the solver's returned DISTANCE error.
 */
function recipeIKReach(master, chain, fromTarget, toTarget, options) {
    options = options || {};
    const ease = easings.getEasing(options.ease || "easeInOutCubic");
    const iterations = options.iterations || 10;
    const tolerance = options.tolerance !== undefined ? options.tolerance : 0.001;
    const useCCD = options.method === "ccd";
    const fx = fromTarget[0], fy = fromTarget[1], fz = fromTarget[2];
    const dx = toTarget[0] - fx, dy = toTarget[1] - fy, dz = toTarget[2] - fz;
    const hasSetter = chain && typeof chain.setTarget === "function";
    const chainIndex = chain && chain.index !== undefined ? chain.index : 0;

    return {
        step() {
            const et = ease(master.progress);
            const tx = fx + dx * et, ty = fy + dy * et, tz = fz + dz * et;
            if (hasSetter) { chain.setTarget(chainIndex, tx, ty, tz); }
            if (chain && chain.target) {
                chain.target[0] = tx; chain.target[1] = ty; chain.target[2] = tz;
            }
            if (!chain || !chain.pos) { return; }
            if (useCCD) {
                vec3.ccdStep3(chain.pos, chain.target, iterations);
            } else {
                for (let it = 0; it < iterations; it++) {
                    if (vec3.fabrikStep3(chain.pos, chain.lens, chain.target, tolerance) < tolerance) { break; }
                }
            }
        },
        get done() { return master.progress >= 1; }
    };
}

/**
 * Galactic-spin — differential rotation: inner instances rotate faster than
 * outer ones. Correct lerp of angular velocity; axis resolved once.
 */
function recipeGalacticSpin(rotations, positions, options) {
    options = options || {};
    const omegaInner = options.omegaInner !== undefined ? options.omegaInner : 1.0;
    const omegaOuter = options.omegaOuter !== undefined ? options.omegaOuter : 0.25;
    const radius = options.radius !== undefined ? options.radius : 100;
    const axis = options.axis || "z";
    const n = rotations.count;
    const px = positions.x, py = positions.y;
    const rx = rotations.x, ry = rotations.y, rz = rotations.z, rw = rotations.w;
    const angles = new Float32Array(n);
    const invRadius = radius > 0 ? 1 / radius : 0;
    const omegaSpan = omegaOuter - omegaInner;
    const mode = axis === "z" ? 0 : axis === "y" ? 1 : 2;

    function writeRange(s, e, dtSec) {
        for (let i = s; i < e; i++) {
            const x = px[i], y = py[i];
            const r = Math.sqrt(x * x + y * y);
            let t = r * invRadius;
            if (t > 1) { t = 1; }
            const omega = omegaInner + omegaSpan * t;
            angles[i] += omega * dtSec;
            const half = angles[i] * 0.5;
            const c = Math.cos(half);
            const sn = Math.sin(half);
            if (mode === 0) { rx[i] = 0; ry[i] = 0; rz[i] = sn; rw[i] = c; }
            else if (mode === 1) { rx[i] = 0; ry[i] = sn; rz[i] = 0; rw[i] = c; }
            else { rx[i] = sn; ry[i] = 0; rz[i] = 0; rw[i] = c; }
        }
    }

    return {
        step(dtSec) { writeRange(0, n, dtSec); },
        async stepChunked(dtSec, chunkSize, yieldEvery) {
            await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) { writeRange(s, e, dtSec); });
        },
        get done() { return false; }
    };
}

// ============================================================================
// 7. BITECS QUERY RECIPE — SOA path first, object fallback second
// ============================================================================
function recipeOnQuery(queryResult, name, args, options) {
    options = options || {};
    const soaFn = soaRecipes[name];
    const soaBuffer = options.trs || options.colors || options.rotations || options.channel;

    if (typeof soaFn === "function" && soaBuffer) {
        return soaFn.apply(null, [soaBuffer].concat(args || []));
    }

    const fn = recipes[name];
    if (typeof fn === "function") {
        const list = (queryResult && queryResult.dense) ? queryResult.dense : queryResult;
        const len = list ? list.length : 0;
        const objs = new Array(len);
        for (let i = 0; i < len; i++) {
            objs[i] = options.objectBuilder ? options.objectBuilder(list[i]) : { value: 0 };
        }
        return fn.apply(null, [objs].concat(args || []));
    }

    if (typeof soaFn === "function") {
        return soaFn.apply(null, [soaBuffer].concat(args || []));
    }
    throw new Error("recipeOnQuery: unknown recipe " + name);
}

// ============================================================================
// 8. THREE.JS r185 INTEROP (duck-typed — no three import, no CDN, no build)
// ============================================================================
/** Upload a SOA handle's current channel into a three.js BufferAttribute. */
function attachRecipeToAttribute(handle, attribute, count) {
    const n = count !== undefined ? count : Math.min(handle.count || 0, attribute.count);
    function upload() {
        const cur = handle.track ? handle.track.current : handle.channel;
        if (!cur) { return attribute; }
        attribute.array.set(cur.subarray(0, n));
        attribute.needsUpdate = true;
        return attribute;
    }
    return {
        handle: handle,
        attribute: attribute,
        upload: upload,
        step(dtSec) { handle.step(dtSec); if (handle.apply) { handle.apply(); } return upload(); },
        async stepChunked(dtSec, cs, ye) {
            if (handle.stepChunked) { await handle.stepChunked(dtSec, cs, ye); }
            else { handle.step(dtSec); }
            if (handle.applyChunked) { await handle.applyChunked(cs, ye); }
            else if (handle.apply) { handle.apply(); }
            return upload();
        },
        get done() { return handle.done; }
    };
}

/**
 * Drive a three.js r185 InstancedMesh from a SOA recipe handle. The TRS is
 * composed into a mat4 SOA and written straight into
 * `mesh.instanceMatrix.array` — no intermediate buffer, no per-instance
 * Object3D, no per-frame allocation.
 */
function attachRecipeToInstancedMesh(handle, mesh, trs, options) {
    options = options || {};
    const n = options.count !== undefined ? options.count : trs.position.count;
    const matrices = options.matrices || mat4.createMat4SOA(n);
    const view = { arrays: matrices.arrays, count: n };
    const recomputeBounds = options.recomputeBounds === true;

    function upload() {
        const attr = mesh.instanceMatrix;
        if (!attr || !attr.array) { return matrices; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 16) | 0;
        view.count = Math.min(n, capacity);
        mat4.soaComposeTRS(matrices, trs.position, trs.rotation, trs.scale);
        mat4.soaToFlat(attr.array, view, 0);
        attr.needsUpdate = true;
        if (mesh.count !== view.count) { mesh.count = view.count; }
        if (recomputeBounds && typeof mesh.computeBoundingSphere === "function") {
            mesh.computeBoundingSphere();
        }
        return matrices;
    }

    async function uploadChunked(chunkSize, yieldEvery) {
        await mat4.soaComposeTRSChunked(
            matrices, trs.position, trs.rotation, trs.scale, chunkSize, yieldEvery
        );
        const attr = mesh.instanceMatrix;
        if (!attr || !attr.array) { return matrices; }
        const capacity = attr.count !== undefined ? attr.count : (attr.array.length / 16) | 0;
        view.count = Math.min(n, capacity);
        mat4.soaToFlat(attr.array, view, 0);
        attr.needsUpdate = true;
        if (mesh.count !== view.count) { mesh.count = view.count; }
        return matrices;
    }

    return {
        handle: handle,
        matrices: matrices,
        upload: upload,
        uploadChunked: uploadChunked,
        step(dtSec) {
            handle.step(dtSec);
            if (handle.apply) { handle.apply(); }
            return upload();
        },
        async stepChunked(dtSec, cs, ye) {
            if (handle.stepChunked) { await handle.stepChunked(dtSec, cs, ye); }
            else { handle.step(dtSec); }
            if (handle.applyChunked) { await handle.applyChunked(cs, ye); }
            else if (handle.apply) { handle.apply(); }
            return uploadChunked(cs, ye);
        },
        get done() { return handle.done; }
    };
}

/**
 * Run a DOM-style recipe against a three.js Object3D channel. Numeric
 * properties on `position` / `rotation` / `scale` are animated directly by the
 * Animation class (object-property path), so no DOM is required.
 */
function recipeThreeObject(name, object3D, opts) {
    opts = opts || {};
    const channel = opts.channel || "position";
    const target = object3D ? object3D[channel] : null;
    if (!target) { throw new Error("recipeThreeObject: object3D." + channel + " missing"); }
    const fn = recipes[name];
    if (typeof fn !== "function") { throw new Error("recipeThreeObject: unknown recipe " + name); }
    const cfg = Object.assign({}, opts);
    delete cfg.channel;
    const anim = fn(target, cfg);
    if (anim && typeof anim === "object" && object3D) {
        const prev = anim.onUpdate;
        anim.onUpdate = function (a) {
            if (typeof object3D.updateMatrix === "function") { object3D.updateMatrix(); }
            if (prev) { prev(a); }
        };
    }
    return anim;
}

// ============================================================================
// 9. WORKER POOL — resident-state multi-core track stepping (Blob URL)
// ============================================================================
const _recipeWorkerSource = "(" + function () {
    const resident = new Map();

    self.onmessage = function (e) {
        const d = e.data;
        if (d.op === "attach") {
            resident.set(d.trackId, {
                from: d.from, to: d.to, durations: d.durations, lut: d.lut
            });
            self.postMessage({ id: d.id, ok: true });
            return;
        }
        if (d.op === "detach") {
            resident.delete(d.trackId);
            self.postMessage({ id: d.id, ok: true });
            return;
        }

        const st = resident.get(d.trackId);
        const cur = d.current, ts = d.ts, del = d.delays, fin = d.finished;
        const n = d.n, dt = d.dt;
        const from = st.from, to = st.to, dur = st.durations, lut = st.lut;
        const lutN = lut ? lut.length - 1 : 0;
        let doneCount = 0;

        for (let i = 0; i < n; i++) {
            if (fin[i]) { doneCount++; continue; }
            if (del[i] > 0) { del[i] -= dt; if (del[i] > 0) { continue; } }
            const dd = dur[i];
            let t;
            if (dd <= 0) { t = 1; }
            else { t = ts[i] + dt / dd; if (t > 1) { t = 1; } }
            ts[i] = t;
            let et;
            if (lut) {
                if (t <= 0) { et = lut[0]; }
                else if (t >= 1) { et = lut[lutN]; }
                else { const x = t * lutN, k = x | 0; et = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
            } else { et = t; }
            cur[i] = from[i] + (to[i] - from[i]) * et;
            if (t >= 1) { fin[i] = 1; doneCount++; }
        }

        self.postMessage({
            id: d.id, current: cur, ts: ts, delays: del, finished: fin, done: doneCount === n
        }, [cur.buffer, ts.buffer, del.buffer, fin.buffer]);
    };
}.toString() + ")();";

/**
 * Optional multi-core executor for SOA recipe tracks. Immutable channels are
 * attached once and stay resident in the worker; only mutable channels are
 * transferred each step (zero copy). Tracks with JS callbacks, or hosts
 * without Workers / Blob URLs, fall back to `track.stepChunked` so a call
 * never blocks the UI and never throws.
 */
class RecipeWorkerPool {
    constructor(size) {
        this._workers = [];
        this._idle = [];
        this._queue = [];
        this._pending = new Map();
        this._nextId = 1;
        this._url = null;
        this._disposed = false;
        this._attached = new WeakMap();

        const want = size || Math.min(4, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2);
        try {
            if (typeof Worker === "undefined" || typeof Blob === "undefined" ||
                typeof URL === "undefined" || !URL.createObjectURL) {
                throw new Error("workers unavailable");
            }
            this._url = URL.createObjectURL(new Blob([_recipeWorkerSource], { type: "text/javascript" }));
            for (let i = 0; i < want; i++) {
                const w = new Worker(this._url);
                w.onmessage = (e) => {
                    const job = this._pending.get(e.data.id);
                    if (job) { this._pending.delete(e.data.id); job.resolve(e.data); }
                    this._idle.push(w);
                    this._dispatch();
                };
                w.onerror = () => { this._idle.push(w); this._dispatch(); };
                this._workers.push(w);
                this._idle.push(w);
            }
        } catch (e) {
            this._workers.length = 0;
            this._idle.length = 0;
            if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
        }
    }

    get size() { return this._workers.length; }
    get isParallel() { return this._workers.length > 0; }

    _dispatch() {
        while (this._queue.length > 0 && this._idle.length > 0) {
            const job = this._queue.shift();
            const w = this._idle.pop();
            this._pending.set(job.msg.id, job);
            w.postMessage(job.msg, job.transfer || []);
        }
    }

    _post(msg, transfer) {
        return new Promise((resolve, reject) => {
            this._queue.push({ msg, transfer, resolve, reject });
            this._dispatch();
        });
    }

    async attach(track) {
        if (this._disposed || this._workers.length === 0) { return false; }
        if (typeof track.useLUT === "function" && !track._lut) { track.useLUT(1024); }
        const id = this._nextId++;
        await this._post({
            id: this._nextId++, op: "attach", trackId: id,
            from: track.from.slice(), to: track.to.slice(),
            durations: track.durations.slice(),
            lut: track._lut ? track._lut.slice() : null
        }, []);
        this._attached.set(track, id);
        return true;
    }

    async step(track, dtSec, chunkSize, yieldEvery) {
        if (this._disposed) { throw new Error("RecipeWorkerPool disposed"); }
        const id = this._attached.get(track);
        if (this._workers.length === 0 || id === undefined || track.onElementDone) {
            return track.stepChunked(dtSec, chunkSize, yieldEvery);
        }
        const res = await this._post({
            id: this._nextId++, op: "step", trackId: id, n: track.count, dt: dtSec,
            current: track.current, ts: track.ts,
            delays: track.delays, finished: track.finished
        }, [track.current.buffer, track.ts.buffer, track.delays.buffer, track.finished.buffer]);

        track.current = res.current;
        track.ts = res.ts;
        track.delays = res.delays;
        track.finished = res.finished;
        track.done = res.done;
        return track;
    }

    /** Step + apply a SOA recipe handle off-thread. */
    async stepHandle(handle, dtSec, chunkSize, yieldEvery) {
        if (handle.track && this._workers.length > 0) {
            if (!this._attached.has(handle.track)) { await this.attach(handle.track); }
            await this.step(handle.track, dtSec, chunkSize, yieldEvery);
        } else if (handle.stepChunked) {
            await handle.stepChunked(dtSec, chunkSize, yieldEvery);
        } else {
            handle.step(dtSec);
        }
        if (handle.applyChunked) { await handle.applyChunked(chunkSize, yieldEvery); }
        else if (handle.apply) { handle.apply(); }
        return handle;
    }

    async detach(track) {
        const id = this._attached.get(track);
        if (id === undefined || this._workers.length === 0) { return false; }
        this._attached.delete(track);
        await this._post({ id: this._nextId++, op: "detach", trackId: id }, []);
        return true;
    }

    dispose() {
        this._disposed = true;
        for (let i = 0; i < this._workers.length; i++) { this._workers[i].terminate(); }
        this._workers.length = 0;
        this._idle.length = 0;
        for (const job of this._pending.values()) { job.reject(new Error("RecipeWorkerPool disposed")); }
        this._pending.clear();
        for (let i = 0; i < this._queue.length; i++) { this._queue[i].reject(new Error("RecipeWorkerPool disposed")); }
        this._queue.length = 0;
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }
}

function createRecipeWorkerPool(size) { return new RecipeWorkerPool(size); }

// ============================================================================
// 10. MATH NAMESPACE — the provided SOA stack stays the default maths
// ============================================================================
const math = {
    common: common,
    utils: utils,
    easings: easings,
    animation: animationModule,
    engine: engineModule,
    scope: scopeModule,
    timer: timerModule,
    vec2: vec2, vec3: vec3, vec4: vec4,
    mat2: mat2, mat3: null, mat4: mat4,
    quat: quat, quat2: quat2,
    bitecs: null, simplex: null,
    recipes: null
};

/** Optional modules load dynamically; a failure never breaks this module. */
const mathReady = Promise.allSettled([
    import("./006_mat3.js").then(function (m) { math.mat3 = m; }),
    import("./010_bitECS_core.js").then(function (m) { math.bitecs = m; }),
    import("./013_simplex.js").then(function (m) { simplex = m; math.simplex = m; })
]);

math.recipes = { recipes, presets, soaRecipes, pooledRecipe, chainRecipes, recipeOnQuery };

// Warm the lazy SVG resolution so `getSvg()` is usually ready by first use.
loadSvg();

// ============================================================================
// 11. EXPORTS — every original export preserved + the 1M-scale parallel layer
// ============================================================================
export {
    // foundation
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC,
    // original dictionary
    recipes, presets,
    // pool
    pooledRecipe,
    // chain
    chainRecipes,
    // SOA
    soaRecipes,
    // HDR color
    recipeHDRColorScrub,
    // procedural recipes
    recipeNoiseWave,
    recipeOrbitalReveal,
    recipeKeplerChase,
    recipeNebulaBloom,
    recipeStarfieldScroll,
    recipeIKReach,
    recipeGalacticSpin,
    // bitECS
    recipeOnQuery,
    // lazy loaders / helpers
    getSvg, loadSvg, chartDrawAsync, morphIconAsync,
    // three.js r185 interop
    attachRecipeToAttribute, attachRecipeToInstancedMesh, recipeThreeObject,
    // parallelism
    RecipeWorkerPool, createRecipeWorkerPool,
    // namespace
    math, mathReady
};

export default {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC,
    recipes, presets,
    pooledRecipe,
    chainRecipes,
    soaRecipes,
    recipeHDRColorScrub,
    recipeNoiseWave,
    recipeOrbitalReveal,
    recipeKeplerChase,
    recipeNebulaBloom,
    recipeStarfieldScroll,
    recipeIKReach,
    recipeGalacticSpin,
    recipeOnQuery,
    getSvg, loadSvg, chartDrawAsync, morphIconAsync,
    attachRecipeToAttribute, attachRecipeToInstancedMesh, recipeThreeObject,
    RecipeWorkerPool, createRecipeWorkerPool,
    math, mathReady
};

// Continue with next file: src/math/023_svg.js (SVG path utilities — drawable
// stroke reveal, path morphing with resampled point correspondence, SOA path
// sampling for 1M+ instanced glyph/particle placement along curves, and
// three.js r185 BufferGeometry bridging)?