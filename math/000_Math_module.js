//File number : 000
// File : src/math/000_Math_module.js
//Description : Single unified math module. Imports EVERY numbered file (001 → 028) in creation
//              order using plain `.js` requires only, and re-exports them under one namespace with
//              real-time 16/32/64-bit precision switching (Float16Array when available, Float32Array,
//              Float64Array) for the entire SOA subsystem. Provides `setPrecision` / `getPrecision` /
//              `getArrayType` / `onPrecisionChange`, precision-wrapped SOA creators, live migration
//              (`migrateSOA` / `migrateSOAInPlace` / `migrateTransform` / `migrateScene` / `migrateAll`),
//              automatic SOA tracking, precision-aware `bootstrap()` / `bootstrapAsync()` scene
//              construction, unified namespaces (`math`, `ecs`, `world`, `anim`, `proc`, `hi`, `pool`,
//              `soa`, `render`, `color`, `ik`, `orbital`, `shape`, `chunked`), a complete module
//              registry (`modules` / `byNumber` / `getModule`), an auto-built `flat` passthrough of
//              every public export, and curated flat names for the whole library.
//####
//Best for : 3d graphics — one import for the whole engine; real-time hot-swap between f32
//           (memory-optimized, 1M+ mobile instances) and f64 (precision-safe to megaparsec scales)
//           without recreating worlds; interactive precision switching while zooming from a forest
//           into a galaxy cluster; Android 64-bit workloads that drop to f32 for batching and rise to
//           f64 for astronomical integration; procedural generation, orbital physics, natural IK, HDR
//           color, shape morphing, timelines, scroll/drag interaction, and bitECS serialization — all
//           zero-GC in the frame loop.
//License : MIT
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

// ============================================================================
// 0. LEGACY PATH ALIAS LAYER
// ----------------------------------------------------------------------------
// This file itself requires ONLY numbered `.js` files (see Section 1).
// Some sibling modules, however, still reference legacy unnumbered paths
// internally (e.g. 015_easings.js requires "./common.js", "./bitECS_core.cjs";
// 021_scope.js requires "./022_timeline.js"). Without a remap, requiring 015
// throws MODULE_NOT_FOUND and the whole library fails to load.
//
// The hook below is deliberately narrow:
//   • only relative "./<file>" requests (single path segment),
//   • only from parent modules located in THIS directory,
//   • only for the 28 known library basenames,
//   • never overwrites a file that already resolves.
// It is idempotent and installs itself at most once per process.
// ============================================================================
var MODULE_ALIASES = {
    "common": "001_common.js",
    "vec2": "002_vec2.js",
    "vec3": "003_vec3.js",
    "vec4": "004_vec4.js",
    "mat2": "005_mat2.js",
    "mat3": "006_mat3.js",
    "mat4": "007_mat4.js",
    "quat": "008_quat.js",
    "quat2": "009_quat2.js",
    "bitECS_core": "010_bitECS_core.js",
    "bitECS_serialization": "011_bitECS_serialization.js",
    "double": "012_double.js",
    "simplex-noise": "013_simplex-noise.js",
    "utils": "014_utils.js",
    "easings": "015_easings.js",
    "engine": "016_engine.js",
    "animation": "017_animation.js",
    "text": "018_text.js",
    "timer": "019_timer.js",
    "scroll": "020_scroll.js",
    "scope": "021_scope.js",
    "recipes": "022_recipes.js",
    "svg": "023_svg.js",
    "timeline": "024_timeline.js",
    "adapters": "025_adapters.js",
    "draggable": "026_draggable.js",
    "motion-engine": "027_motion-engine.js",
    "motion-engine-extended": "028_motion-engine-extended.js"
};

(function _installLegacyAliases() {
    var NodeModule;
    try { NodeModule = require("module"); } catch (e) { return; }
    if (!NodeModule || typeof NodeModule._resolveFilename !== "function") return;

    var FLAG = Symbol.for("studiomotion.math000.aliases");
    if (NodeModule[FLAG]) return;

    var here = String(__dirname).replace(/\\/g, "/");
    var original = NodeModule._resolveFilename;

    NodeModule._resolveFilename = function (request, parent, isMain, options) {
        if (typeof request === "string" &&
            request.charAt(0) === "." && request.charAt(1) === "/" &&
            request.indexOf("/", 2) === -1 &&
            parent && typeof parent.filename === "string") {

            var parentDir = parent.filename.replace(/\\/g, "/");
            parentDir = parentDir.slice(0, parentDir.lastIndexOf("/"));

            if (parentDir === here) {
                var file = request.slice(2);
                var key = file.replace(/\.(cjs|mjs|js)$/i, "").replace(/^\d{3}_/, "");
                var mapped = MODULE_ALIASES[key];
                if (mapped && mapped !== file) {
                    try { return original.call(this, "./" + mapped, parent, isMain, options); }
                    catch (e) { /* fall through to the original request */ }
                }
            }
        }
        return original.call(this, request, parent, isMain, options);
    };

    NodeModule[FLAG] = true;
})();

// ============================================================================
// 1. MODULE IMPORTS — 001 → 028, plain `.js` only, in creation order
// ============================================================================
const common       = require("./001_common.js");
const vec2         = require("./002_vec2.js");
const vec3         = require("./003_vec3.js");
const vec4         = require("./004_vec4.js");
const mat2         = require("./005_mat2.js");
const mat3         = require("./006_mat3.js");
const mat4         = require("./007_mat4.js");
const quat         = require("./008_quat.js");
const quat2        = require("./009_quat2.js");
const bitecs       = require("./010_bitECS_core.js");
const serialization = require("./011_bitECS_serialization.js");
const double       = require("./012_double.js");
const simplex      = require("./013_simplex-noise.js");
const utils        = require("./014_utils.js");
const easings      = require("./015_easings.js");
const engine       = require("./016_engine.js");
const animation    = require("./017_animation.js");
const textModule   = require("./018_text.js");
const timer        = require("./019_timer.js");
const scroll       = require("./020_scroll.js");
const scopeModule  = require("./021_scope.js");
const recipesModule = require("./022_recipes.js");
const svgModule    = require("./023_svg.js");
const timeline     = require("./024_timeline.js");
const adaptersModule = require("./025_adapters.js");
const draggableModule = require("./026_draggable.js");
const motionEngine = require("./027_motion-engine.js");
const motionExt    = require("./028_motion-engine-extended.js");

/** Backwards-compatible accessor (the timeline is now a hard dependency). */
function getTimeline() { return timeline; }

// ============================================================================
// 2. MODULE REGISTRY — easy access to every file
//   modules.common / modules["003"] / modules["003_vec3.js"]
//   byNumber[3]    / getModule("vec3") / getModule(3) / getModule("003_vec3")
// ============================================================================
const MODULE_LIST = [
    { num: 1,  id: "001", name: "common",               file: "001_common.js",               module: common },
    { num: 2,  id: "002", name: "vec2",                 file: "002_vec2.js",                 module: vec2 },
    { num: 3,  id: "003", name: "vec3",                 file: "003_vec3.js",                 module: vec3 },
    { num: 4,  id: "004", name: "vec4",                 file: "004_vec4.js",                 module: vec4 },
    { num: 5,  id: "005", name: "mat2",                 file: "005_mat2.js",                 module: mat2 },
    { num: 6,  id: "006", name: "mat3",                 file: "006_mat3.js",                 module: mat3 },
    { num: 7,  id: "007", name: "mat4",                 file: "007_mat4.js",                 module: mat4 },
    { num: 8,  id: "008", name: "quat",                 file: "008_quat.js",                 module: quat },
    { num: 9,  id: "009", name: "quat2",                file: "009_quat2.js",                module: quat2 },
    { num: 10, id: "010", name: "bitECS_core",          file: "010_bitECS_core.js",          module: bitecs },
    { num: 11, id: "011", name: "bitECS_serialization", file: "011_bitECS_serialization.js", module: serialization },
    { num: 12, id: "012", name: "double",               file: "012_double.js",               module: double },
    { num: 13, id: "013", name: "simplex",              file: "013_simplex-noise.js",        module: simplex },
    { num: 14, id: "014", name: "utils",                file: "014_utils.js",                module: utils },
    { num: 15, id: "015", name: "easings",              file: "015_easings.js",              module: easings },
    { num: 16, id: "016", name: "engine",               file: "016_engine.js",               module: engine },
    { num: 17, id: "017", name: "animation",            file: "017_animation.js",            module: animation },
    { num: 18, id: "018", name: "text",                 file: "018_text.js",                 module: textModule },
    { num: 19, id: "019", name: "timer",                file: "019_timer.js",                module: timer },
    { num: 20, id: "020", name: "scroll",               file: "020_scroll.js",               module: scroll },
    { num: 21, id: "021", name: "scope",                file: "021_scope.js",                module: scopeModule },
    { num: 22, id: "022", name: "recipes",              file: "022_recipes.js",              module: recipesModule },
    { num: 23, id: "023", name: "svg",                  file: "023_svg.js",                  module: svgModule },
    { num: 24, id: "024", name: "timeline",             file: "024_timeline.js",             module: timeline },
    { num: 25, id: "025", name: "adapters",             file: "025_adapters.js",             module: adaptersModule },
    { num: 26, id: "026", name: "draggable",            file: "026_draggable.js",            module: draggableModule },
    { num: 27, id: "027", name: "motionEngine",         file: "027_motion-engine.js",        module: motionEngine },
    { num: 28, id: "028", name: "motionExtended",       file: "028_motion-engine-extended.js", module: motionExt }
];

const modules = Object.create(null);
const byNumber = [null];
const MODULE_FILES = [];

for (let i = 0; i < MODULE_LIST.length; i++) {
    const e = MODULE_LIST[i];
    modules[e.name] = e.module;
    modules[e.id] = e.module;
    modules[e.file] = e.module;
    modules[e.file.replace(/\.js$/, "")] = e.module;
    byNumber[e.num] = e.module;
    MODULE_FILES.push(e.file);
}
// convenience aliases
modules.bitecs = bitecs;
modules.serialization = serialization;
modules.simplexNoise = simplex;
modules.textModule = textModule;
modules.scope = scopeModule;
modules.recipes = recipesModule;
modules.svg = svgModule;
modules.adapters = adaptersModule;
modules.draggable = draggableModule;
modules.motionExt = motionExt;
modules.StudioMotion = motionExt;

/** Resolve a module by number, id, basename, or namespace name. */
function getModule(key) {
    if (typeof key === "number") return byNumber[key] || null;
    if (typeof key !== "string") return null;
    if (modules[key]) return modules[key];
    const bare = key.replace(/\.js$/, "").replace(/^\d{3}_/, "");
    if (modules[bare]) return modules[bare];
    const n = parseInt(key, 10);
    return (n >= 1 && n <= 28) ? byNumber[n] : null;
}

// ============================================================================
// 3. COMPATIBILITY SHIMS
// Additive only — never overwrites an existing export.
// ============================================================================

/** 001 exports hash2/hash3 but not hash4, which 004_vec4 requires at runtime. */
function hash4(x, y, z, w) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) +
            Math.imul(z | 0, 2147483647) + Math.imul(w | 0, 1103515245);
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return h / 4294967296;
}
if (typeof common.hash4 !== "function") common.hash4 = hash4;

/** Zero-GC per-instance mat4 transpose (007 exports no SOA transpose). */
function soaTransposeMat4(out, a) {
    const O = out.arrays, A = a.arrays, n = out.count;
    for (let i = 0; i < n; i++) {
        const a01 = A[1][i], a02 = A[2][i], a03 = A[3][i];
        const a12 = A[6][i], a13 = A[7][i], a23 = A[11][i];
        O[0][i] = A[0][i]; O[1][i] = A[4][i]; O[2][i] = A[8][i];  O[3][i] = A[12][i];
        O[4][i] = a01;     O[5][i] = A[5][i]; O[6][i] = A[9][i];  O[7][i] = A[13][i];
        O[8][i] = a02;     O[9][i] = a12;     O[10][i] = A[10][i]; O[11][i] = A[14][i];
        O[12][i] = a03;    O[13][i] = a13;    O[14][i] = a23;      O[15][i] = A[15][i];
    }
    return out;
}
if (typeof mat4.soaTranspose !== "function") mat4.soaTranspose = soaTransposeMat4;

// fBm SOA fills — the vec modules expose `soaFillNoise*(…, kind)`, not `soaFillFBM*`.
function fillFBM2D(soa, scale, octaves) { return vec2.soaFillNoise2D(soa, scale, octaves, "fbm"); }
function fillFBM2DChunked(soa, scale, octaves, cs, ye) {
    return vec2.soaFillNoise2DChunked(soa, scale, octaves, "fbm", cs, ye);
}
function fillFBM3D(soa, scale, octaves) { return vec3.soaFillNoise3D(soa, scale, octaves, "fbm"); }
function fillFBM3DChunked(soa, scale, octaves, cs, ye) {
    return vec3.soaFillNoise3DChunked(soa, scale, octaves, "fbm", cs, ye);
}
function fillFBM4D(soa, scale, timeStep, octaves) { return vec4.soaFillNoise4D(soa, scale, timeStep, octaves); }
function fillFBM4DChunked(soa, scale, timeStep, octaves, cs, ye) {
    return vec4.soaFillNoise4DChunked(soa, scale, timeStep, octaves, cs, ye);
}

/**
 * CORRECTION: the previous wrapper forwarded RGB channels straight into the
 * Cb/Cr/luma slots of `mat2.soaHueRotateChroma`, which rotated the wrong plane
 * and destroyed luma. This is a correct, HDR-safe (unclamped), zero-GC
 * RGB → Y'CbCr → rotate → RGB batch. Alpha is preserved.
 */
function soaHueRotate(outColors, baseColors, angleRad) {
    const s = Math.sin(angleRad), c = Math.cos(angleRad);
    const ox = outColors.x, oy = outColors.y, oz = outColors.z;
    const ix = baseColors.x, iy = baseColors.y, iz = baseColors.z;
    const n = baseColors.count;
    for (let i = 0; i < n; i++) {
        const r = ix[i], g = iy[i], b = iz[i];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
        const cb2 = cb * c - cr * s;
        const cr2 = cb * s + cr * c;
        ox[i] = luma + 1.402 * cr2;
        oy[i] = luma - 0.344136 * cb2 - 0.714136 * cr2;
        oz[i] = luma + 1.772 * cb2;
    }
    return outColors;
}

// Safe pooled acquisition — ES6 class constructors cannot be invoked via `.call()`.
const _HAS_ANIM_INIT = !!(animation.Animation && typeof animation.Animation.prototype._init === "function");
const _HAS_TIMER_INIT = !!(timer.Timer && typeof timer.Timer.prototype._init === "function");
const _HAS_TL_INIT = !!(timeline.Timeline && typeof timeline.Timeline.prototype._init === "function");

function acquireAnimation(cfg) {
    if (_HAS_ANIM_INIT && animation.acquireAnimation) return animation.acquireAnimation(cfg);
    return new animation.Animation(cfg);
}
function releaseAnimation(a) {
    if (!a) return;
    try { a.pause(); } catch (e) { /* swallow */ }
    if (_HAS_ANIM_INIT && animation.releaseAnimation) animation.releaseAnimation(a);
}
function acquireTimer(cfg) {
    if (_HAS_TIMER_INIT && timer.acquireTimer) return timer.acquireTimer(cfg);
    return new timer.Timer(cfg);
}
function releaseTimer(t) {
    if (!t) return;
    try { t.pause(); } catch (e) { /* swallow */ }
    if (_HAS_TIMER_INIT && timer.releaseTimer) timer.releaseTimer(t);
}
function acquireTimeline(cfg) {
    if (_HAS_TL_INIT && timeline.acquireTimeline) return timeline.acquireTimeline(cfg);
    return new timeline.Timeline(cfg);
}
function releaseTimeline(tl) {
    if (!tl) return;
    try { tl.pause(); } catch (e) { /* swallow */ }
    if (_HAS_TL_INIT && timeline.releaseTimeline) timeline.releaseTimeline(tl);
}

// Plain factories (always allocate — use the pooled variants in hot paths).
function createAnimation(cfg) { return new animation.Animation(cfg); }
function createTimeline(cfg) { return new timeline.Timeline(cfg); }
function createTimer(cfg) { return new timer.Timer(cfg); }
function createEngine(options) { return new engine.Engine(options); }

// ============================================================================
// 4. PRECISION STATE
// Dense arrays only — no Set/Map in the tracking or notification path.
// Migration is a user action, never a frame-loop cost.
// ============================================================================
let _precisionMode = "f32";                 // "f16" | "f32" | "f64"
let _currentType = Float32Array;
const _precisionListeners = [];
const _trackedSOAs = [];
const _HAS_F16 = typeof Float16Array !== "undefined";

function _resolveType(precision) {
    const p = precision || _precisionMode;
    if (p === "f16") return _HAS_F16 ? Float16Array : Float32Array;
    if (p === "f64") return Float64Array;
    return Float32Array;
}

/**
 * Switch the whole math system's default SOA precision in real time.
 * @param {"f16"|"f32"|"f64"} mode
 * @param {Object}  [options]
 * @param {boolean} [options.migrate=true]      Migrate every tracked SOA in place.
 * @param {boolean} [options.includeFlat=false] Also change the flat-API ARRAY_TYPE.
 */
function setPrecision(mode, options) {
    options = options || {};
    if (mode !== "f16" && mode !== "f32" && mode !== "f64") {
        throw new Error("setPrecision: mode must be 'f16', 'f32', or 'f64'");
    }
    if (mode === "f16" && !_HAS_F16) {
        console.warn("[000_Math_module] Float16Array unavailable — falling back to f32");
        mode = "f32";
    }
    if (mode === _precisionMode) return _precisionMode;

    const oldMode = _precisionMode;
    _precisionMode = mode;
    _currentType = _resolveType(mode);

    if (options.includeFlat === true) common.setMatrixArrayType(_currentType);
    if (options.migrate !== false) migrateAll(mode);

    for (let i = 0; i < _precisionListeners.length; i++) {
        try { _precisionListeners[i](mode, oldMode); }
        catch (e) { console.error("[000_Math_module] precision listener error", e); }
    }
    return _precisionMode;
}

function getPrecision() { return _precisionMode; }
function getArrayType(precision) { return _resolveType(precision); }

function onPrecisionChange(cb) {
    if (typeof cb !== "function") return function () {};
    _precisionListeners.push(cb);
    return function () {
        const i = _precisionListeners.indexOf(cb);
        if (i !== -1) _precisionListeners.splice(i, 1);
    };
}

// ============================================================================
// 5. PRECISION-WRAPPED SOA CREATORS
// ============================================================================
function createVec2SOA(count, type)  { return vec2.createVec2SOA(count, type || _currentType); }
function createVec3SOA(count, type)  { return vec3.createVec3SOA(count, type || _currentType); }
function createVec4SOA(count, type)  { return vec4.createVec4SOA(count, type || _currentType); }
function createMat2SOA(count, type)  { return mat2.createMat2SOA(count, type || _currentType); }
function createMat3SOA(count, type)  { return mat3.createMat3SOA(count, type || _currentType); }
function createMat4SOA(count, type)  { return mat4.createMat4SOA(count, type || _currentType); }
function createQuatSOA(count, type)  { return quat.createQuatSOA(count, type || _currentType); }
function createQuat2SOA(count, type) { return quat2.createQuat2SOA(count, type || _currentType); }

// Double-double blocks are dtype-locked: the algorithm requires 53-bit words.
function createDoubleSOA(count) { return double.createDoubleSOA(count); }

function createTransform(count, type) {
    const t = {
        position: createVec3SOA(count, type),
        rotation: createQuatSOA(count, type),   // identity by default
        scale:    createVec3SOA(count, type)
    };
    t.scale.x.fill(1); t.scale.y.fill(1); t.scale.z.fill(1);
    return t;
}
function createColorSOA(count, type) {
    const c = createVec4SOA(count, type);
    c.x.fill(1); c.y.fill(1); c.z.fill(1); c.w.fill(1);   // opaque white
    return c;
}
function createVelocitySOA(count, type) { return createVec3SOA(count, type); }

// ============================================================================
// 6. MIGRATION
// Shape-aware channel rebinding: mat2 (m00,m01,m10,m11) must NOT be rebound as
// x/y/z/w, and double-double (hi/lo) must never change dtype.
// ============================================================================
function isDoubleSOA(soa) {
    return !!(soa && soa.hi !== undefined && soa.lo !== undefined);
}
function getSOAPrecision(soa) {
    if (!soa || !soa.arrays || soa.arrays.length === 0) return null;
    const ctor = soa.arrays[0].constructor;
    if (_HAS_F16 && ctor === Float16Array) return "f16";
    if (ctor === Float64Array) return "f64";
    if (ctor === Float32Array) return "f32";
    return null;
}
function _rebindChannels(out, arrays) {
    const n = arrays.length;
    if (out.hi !== undefined && out.lo !== undefined) {
        out.hi = arrays[0]; out.lo = arrays[1];
        return out;
    }
    if (out.m00 !== undefined) {
        if (n === 4) {                                   // mat2
            out.m00 = arrays[0]; out.m01 = arrays[1];
            out.m10 = arrays[2]; out.m11 = arrays[3];
        } else {                                         // mat3
            out.m00 = arrays[0]; out.m01 = arrays[1]; out.m02 = arrays[2];
            out.m10 = arrays[3]; out.m11 = arrays[4]; out.m12 = arrays[5];
            out.m20 = arrays[6]; out.m21 = arrays[7]; out.m22 = arrays[8];
        }
        return out;
    }
    if (out.x1 !== undefined) {                          // quat2
        out.x1 = arrays[0]; out.y1 = arrays[1]; out.z1 = arrays[2]; out.w1 = arrays[3];
        out.x2 = arrays[4]; out.y2 = arrays[5]; out.z2 = arrays[6]; out.w2 = arrays[7];
        return out;
    }
    if (out.x !== undefined) {                           // vec2 / vec3 / vec4 / quat
        out.x = arrays[0];
        if (n > 1) out.y = arrays[1];
        if (n > 2) out.z = arrays[2];
        if (n > 3) out.w = arrays[3];
        return out;
    }
    return out;                                          // mat4 — arrays only
}
function _allocMigrated(soa, TargetType) {
    const count = soa.count;
    const components = soa.components || soa.arrays.length;
    const bpe = TargetType.BYTES_PER_ELEMENT;
    const buffer = new ArrayBuffer(count * components * bpe);
    const arrays = new Array(components);
    for (let i = 0; i < components; i++) {
        const arr = new TargetType(buffer, i * count * bpe, count);
        arr.set(soa.arrays[i]);
        arrays[i] = arr;
    }
    return { arrays: arrays, buffer: buffer, count: count, components: components };
}

/** Return a NEW SOA object migrated to `targetPrecision`. */
function migrateSOA(soa, targetPrecision) {
    if (!soa || !soa.arrays) return soa;
    if (isDoubleSOA(soa)) return soa;
    const TargetType = _resolveType(targetPrecision);
    if (soa.arrays[0].constructor === TargetType) return soa;
    const built = _allocMigrated(soa, TargetType);
    const out = Object.assign({}, soa);
    out.arrays = built.arrays;
    out.buffer = built.buffer;
    out.count = built.count;
    out.components = built.components;
    return _rebindChannels(out, built.arrays);
}

/** Migrate IN PLACE. External references to the old channels become stale. */
function migrateSOAInPlace(soa, targetPrecision) {
    if (!soa || !soa.arrays) return soa;
    if (isDoubleSOA(soa)) return soa;
    const TargetType = _resolveType(targetPrecision);
    if (soa.arrays[0].constructor === TargetType) return soa;
    const built = _allocMigrated(soa, TargetType);
    soa.arrays = built.arrays;
    soa.buffer = built.buffer;
    soa.count = built.count;
    soa.components = built.components;
    return _rebindChannels(soa, built.arrays);
}
function migrateTransform(trs, targetPrecision) {
    if (!trs) return trs;
    migrateSOAInPlace(trs.position, targetPrecision);
    migrateSOAInPlace(trs.rotation, targetPrecision);
    migrateSOAInPlace(trs.scale, targetPrecision);
    return trs;
}
function migrateScene(scene, targetPrecision) {
    if (!scene) return scene;
    if (scene.trs) migrateTransform(scene.trs, targetPrecision);
    if (scene.colors) migrateSOAInPlace(scene.colors, targetPrecision);
    if (scene.matrices) migrateSOAInPlace(scene.matrices, targetPrecision);
    if (scene.velocities) migrateSOAInPlace(scene.velocities, targetPrecision);
    // scene.eids is Uint32Array — entity IDs are never precision-migrated.
    return scene;
}

// ============================================================================
// 7. TRACKING (automatic migration on precision change)
// ============================================================================
function trackSOA(soa) {
    if (!soa || isDoubleSOA(soa)) return soa;
    if (_trackedSOAs.indexOf(soa) === -1) _trackedSOAs.push(soa);
    return soa;
}
function untrackSOA(soa) {
    const i = _trackedSOAs.indexOf(soa);
    if (i !== -1) _trackedSOAs.splice(i, 1);
}
function trackTransform(trs) {
    if (!trs) return trs;
    trackSOA(trs.position); trackSOA(trs.rotation); trackSOA(trs.scale);
    return trs;
}
function untrackTransform(trs) {
    if (!trs) return trs;
    untrackSOA(trs.position); untrackSOA(trs.rotation); untrackSOA(trs.scale);
    return trs;
}
function trackScene(scene) {
    if (!scene) return scene;
    trackTransform(scene.trs);
    trackSOA(scene.colors); trackSOA(scene.matrices); trackSOA(scene.velocities);
    return scene;
}
function untrackScene(scene) {
    if (!scene) return scene;
    untrackTransform(scene.trs);
    untrackSOA(scene.colors); untrackSOA(scene.matrices); untrackSOA(scene.velocities);
    return scene;
}
function clearTrackedSOAs() { _trackedSOAs.length = 0; }
function getTrackedSOAs() { return _trackedSOAs; }
function getTrackedCount() { return _trackedSOAs.length; }
function migrateAll(targetPrecision) {
    const mode = targetPrecision || _precisionMode;
    for (let i = 0; i < _trackedSOAs.length; i++) {
        try { migrateSOAInPlace(_trackedSOAs[i], mode); }
        catch (e) { console.error("[000_Math_module] migrateAll failed for one SOA", e); }
    }
}

// ============================================================================
// 8. UNIFIED NAMESPACES
// ============================================================================
const math = {
    common, vec2, vec3, vec4, mat2, mat3, mat4, quat, quat2,
    double, simplex, utils, easings
};

const ecs = {
    core: bitecs,
    serialization,
    createWorld: bitecs.createWorld,
    resetWorld: bitecs.resetWorld,
    deleteWorld: bitecs.deleteWorld,
    addEntity: bitecs.addEntity,
    addPrefab: bitecs.addPrefab,
    removeEntity: bitecs.removeEntity,
    entityExists: bitecs.entityExists,
    addComponent: bitecs.addComponent,
    addComponents: bitecs.addComponents,
    removeComponent: bitecs.removeComponent,
    removeComponents: bitecs.removeComponents,
    hasComponent: bitecs.hasComponent,
    getComponent: bitecs.getComponent,
    setComponent: bitecs.setComponent,
    set: bitecs.set,
    query: bitecs.query,
    registerQuery: bitecs.registerQuery,
    removeQuery: bitecs.removeQuery,
    registerComponent: bitecs.registerComponent,
    registerComponents: bitecs.registerComponents,
    observe: bitecs.observe,
    onAdd: bitecs.onAdd,
    onRemove: bitecs.onRemove,
    onSet: bitecs.onSet,
    onGet: bitecs.onGet,
    commitRemovals: bitecs.commitRemovals,
    createRelation: bitecs.createRelation,
    getRelationTargets: bitecs.getRelationTargets,
    isRelation: bitecs.isRelation,
    isWildcard: bitecs.isWildcard,
    makeExclusive: bitecs.makeExclusive,
    withStore: bitecs.withStore,
    withAutoRemoveSubject: bitecs.withAutoRemoveSubject,
    withOnTargetRemoved: bitecs.withOnTargetRemoved,
    Pair: bitecs.Pair, Wildcard: bitecs.Wildcard, Prefab: bitecs.Prefab, IsA: bitecs.IsA,
    Or: bitecs.Or, And: bitecs.And, Not: bitecs.Not, Any: bitecs.Any, All: bitecs.All, None: bitecs.None,
    Hierarchy: bitecs.Hierarchy, Cascade: bitecs.Cascade,
    asBuffer: bitecs.asBuffer, noCommit: bitecs.noCommit, isNested: bitecs.isNested,
    getAllEntities: bitecs.getAllEntities,
    getEntityComponents: bitecs.getEntityComponents,
    getWorldComponents: bitecs.getWorldComponents,
    getHierarchyDepth: bitecs.getHierarchyDepth,
    getMaxHierarchyDepth: bitecs.getMaxHierarchyDepth,
    createEntityIndex: bitecs.createEntityIndex,
    withVersioning: bitecs.withVersioning,
    getId: bitecs.getId, getVersion: bitecs.getVersion,
    pipe: bitecs.pipe, aos: bitecs.aos, soa: bitecs.soa,
    // pools
    soaPoolGet: bitecs.soaPoolGet,
    soaPoolRelease: bitecs.soaPoolRelease,
    // systems
    createAnimationSystem: bitecs.createAnimationSystem,
    createIKSystem: bitecs.createIKSystem,
    createOrbitalSystem: bitecs.createOrbitalSystem,
    createColorSystem: bitecs.createColorSystem,
    createFloatingOrigin: bitecs.createFloatingOrigin,
    createSpatialGrid: bitecs.createSpatialGrid,
    createInstanceBatch: bitecs.createInstanceBatch,
    createTransformSOA: bitecs.createTransformSOA,
    createMatrixSOA: bitecs.createMatrixSOA,
    composeTransformSOA: bitecs.composeTransformSOA,
    composeTransformSOAChunked: bitecs.composeTransformSOAChunked,
    // procedural
    scatterEntities: bitecs.scatterEntities,
    scatterEntitiesChunked: bitecs.scatterEntitiesChunked,
    spawnOrbitalBodies: bitecs.spawnOrbitalBodies,
    // chunked
    iterChunked: bitecs.iterChunked,
    queryChunked: bitecs.queryChunked,
    soaStepChunked: bitecs.soaStepChunked,
    // serialization
    serializeScene: serialization.serializeScene,
    deserializeScene: serialization.deserializeScene,
    createSnapshot: serialization.createSnapshotSerializer,
    createRestore: serialization.createSnapshotDeserializer,
    createByteWriter: serialization.createByteWriter,
    createByteReader: serialization.createByteReader
};
const world = ecs;   // alias — `world` reads better for scene-level code

const anim = {
    engine, animation, timeline, timer, scroll,
    scope: scopeModule, text: textModule, svg: svgModule,
    recipes: recipesModule, adapters: adaptersModule, draggable: draggableModule,
    utils, easings,
    motionEngine, motionExtended: motionExt,
    Engine: engine.Engine,
    GlobalEngine: engine.GlobalEngine,
    Animation: animation.Animation,
    SOAAnimationTrack: animation.SOAAnimationTrack,
    Timeline: timeline.Timeline,
    Timer: timer.Timer,
    ScrollTriggerInstance: scroll.ScrollTriggerInstance,
    // 028 extended animation system
    GenericToAnyShape: motionExt.GenericToAnyShape,
    ShapePrimitive: motionExt.ShapePrimitive,
    ShapeSampler: motionExt.ShapeSampler,
    MorphTrack: motionExt.MorphTrack,
    SOAMorphGroup: motionExt.SOAMorphGroup,
    KeyframeTrack: motionExt.KeyframeTrack,
    AnimationStateMachine: motionExt.AnimationStateMachine,
    BlendTree: motionExt.BlendTree,
    FullAnimationSystem: motionExt.FullAnimationSystem
};

const proc = {
    simplex,
    createNoise2D: simplex.createNoise2D,
    createNoise3D: simplex.createNoise3D,
    createNoise4D: simplex.createNoise4D,
    acquireNoise2D: simplex.acquireNoise2D,
    acquireNoise3D: simplex.acquireNoise3D,
    acquireNoise4D: simplex.acquireNoise4D,
    createNoisePool: simplex.createNoisePool,
    buildPermutationTable: simplex.buildPermutationTable,
    createNoiseFieldSystem: simplex.createNoiseFieldSystem,
    // hashes / PRNG
    hash2: common.hash2, hash3: common.hash3, hash4: common.hash4,
    mulberry32: common.mulberry32, xorshift32: common.xorshift32, splitmix32: common.splitmix32,
    // scalar noise
    value2D: vec2.valueNoise2D, value3D: vec3.valueNoise3D, value4D: vec4.valueNoise4D,
    gradient2D: vec2.gradientNoise2D, gradient3D: vec3.gradientNoise3D,
    fbm2D: vec2.fbm2D, fbm3D: vec3.fbm3D, fbm4D: vec4.fbm4D,
    turbulence4D: vec4.turbulence4D,
    voronoi2D: vec2.voronoi2D, voronoi3D: vec3.voronoi3D,
    // SOA fills (in-place, vec-module semantics)
    fill2D: vec2.soaFillNoise2D,
    fill3D: vec3.soaFillNoise3D,
    fill4D: vec4.soaFillNoise4D,
    fillFBM2D: fillFBM2D,
    fillFBM3D: fillFBM3D,
    fillFBM4D: fillFBM4D,
    fill2DChunked: vec2.soaFillNoise2DChunked,
    fill3DChunked: vec3.soaFillNoise3DChunked,
    fill4DChunked: vec4.soaFillNoise4DChunked,
    fillFBM2DChunked: fillFBM2DChunked,
    fillFBM3DChunked: fillFBM3DChunked,
    fillFBM4DChunked: fillFBM4DChunked,
    // SOA fills (simplex-backed, out + noiseFn semantics)
    fillNoise2DSimplex: simplex.soaFillNoise2D,
    fillNoise3DSimplex: simplex.soaFillNoise3D,
    fillNoise4DSimplex: simplex.soaFillNoise4D,
    fillFBM2DSimplex: simplex.soaFillFBM2D,
    fillFBM3DSimplex: simplex.soaFillFBM3D,
    fillFBM4DSimplex: simplex.soaFillFBM4D,
    fillTurbulence3D: simplex.soaFillTurbulence3D,
    fillRidged3D: simplex.soaFillRidged3D,
    fillWarped3D: simplex.soaFillWarped3D,
    fillCurl3D: simplex.soaFillCurl3D,
    fillGradient3D: simplex.soaFillGradient3D,
    fillNoise3DSimplexChunked: simplex.soaFillNoise3DChunked,
    fillFBM3DSimplexChunked: simplex.soaFillFBM3DChunked,
    fillTurbulence3DChunked: simplex.soaFillTurbulence3DChunked,
    fillRidged3DChunked: simplex.soaFillRidged3DChunked,
    fillCurl3DChunked: simplex.soaFillCurl3DChunked,
    fillGradient3DChunked: simplex.soaFillGradient3DChunked,
    // placement
    scatter: bitecs.scatterEntities,
    scatterChunked: bitecs.scatterEntitiesChunked,
    scatterOrbital: bitecs.spawnOrbitalBodies,
    // double precision
    value3D_64: double.valueNoise3D_64,
    hash3_64: double.hash3_64
};

const render = {
    createBatch: bitecs.createInstanceBatch,
    composeTRS: mat4.soaComposeTRS,
    composeTRSChunked: mat4.soaComposeTRSChunked,
    composeTRSIntoFlat: _composeTRSIntoFlat,
    flagInstanceUpload: _flagInstanceUpload,
    transformPoint: mat4.soaTransformPoint,
    transformPointChunked: mat4.soaTransformPointChunked,
    transformPointPerspective: mat4.soaTransformPointPerspective,
    dqTransformPoint: quat2.soaTransformPoint,
    dqToMat4: quat2.soaToMat4,
    buildTBN: mat3.buildTBN,
    buildTBNSOA: mat3.soaBuildTBN,
    buildTBNSOAChunked: mat3.soaBuildTBNChunked,
    multiply: mat4.soaMultiply,
    multiplyChunked: mat4.soaMultiplyChunked,
    invert: mat4.soaInvert,
    invertChunked: mat4.soaInvertChunked,
    transpose: soaTransposeMat4,
    transposeMat3: mat3.soaTranspose,
    decompose: mat4.soaDecompose,
    perspective: mat4.perspectiveNO,
    perspectiveZO: mat4.perspectiveZO,
    ortho: mat4.orthoNO,
    orthoZO: mat4.orthoZO,
    frustum: mat4.frustum,
    lookAt: mat4.lookAt,
    targetTo: mat4.targetTo,
    normalFromMat4: mat3.normalFromMat4,
    fromWorldBoundsNDC: mat4.fromWorldBoundsNDC,
    aabb: vec3.soaAABB,
    fillFromNoise: mat3.soaFillFromNoise,
    fillFromNoiseChunked: mat3.soaFillFromNoiseChunked,
    fillRotationFromNoise: mat2.soaFillRotationFromNoise,
    fillTRSFromNoise: mat4.soaFillTRSFromNoise,
    fillTRSFromNoiseChunked: mat4.soaFillTRSFromNoiseChunked,
    toFlat: mat4.soaToFlat,
    fromJointTransform: mat4.fromJointTransform,
    soaFromJointTransform: mat4.soaFromJointTransform,
    instancedMesh: adaptersModule.animateInstancedMesh,
    threeSOA: adaptersModule.animateThreeSOA
};

const color = {
    srgb8ToLinear: utils.srgb8ToLinear,
    linearToSrgb8: utils.linearToSrgb8,
    srgbToLinear: common.srgbToLinear,
    linearToSrgb: common.linearToSrgb,
    hslToRgb: common.hslToRgb,
    rgbToHsl: common.rgbToHsl,
    hsvToRgb: common.hsvToRgb,
    rgbToHsv: common.rgbToHsv,
    hexToRgb: common.hexToRgb,
    rgbToHex: common.rgbToHex,
    expose: utils.exposeColor,
    reinhard: utils.reinhardColor,
    aces: utils.acesColor,
    acesToneMap: vec3.acesToneMap,
    reinhardToneMap: vec3.reinhardToneMap,
    acesToneMapSOA: double.acesToneMapSOA,
    pack: utils.packColorRGBA,
    unpack: utils.unpackColorRGBA,
    packRGBA: common.packRGBA,
    unpackRGBA: common.unpackRGBA,
    packVec3: vec3.packRGB,
    unpackVec3: vec3.unpackRGB,
    css: utils.cssColor,
    soaFill: vec4.soaFillColor,
    soaExpose: vec4.soaExpose,
    soaSrgbToLinear: vec4.soaSrgbToLinear,
    soaLinearToSrgb: vec4.soaLinearToSrgb,
    soaApplyMatrix: mat3.soaApplyColorMatrix,
    soaHueRotateChroma: mat2.soaHueRotateChroma,
    soaHueRotate: soaHueRotate,
    fromSaturation: mat3.fromSaturation,
    fromGrayscale: mat3.fromGrayscale,
    fromHueRotation: mat3.fromHueRotation,
    fromChannelMix: mat3.fromChannelMix,
    LUMA_R709: mat3.LUMA_R709,
    LUMA_G709: mat3.LUMA_G709,
    LUMA_B709: mat3.LUMA_B709
};

const ik = {
    fabrikStep: vec3.fabrikStep3,
    ccdStep: vec3.ccdStep3,
    lookAtBasis: vec3.lookAtBasis,
    fromJointTransform: mat4.fromJointTransform,
    soaFromJointTransform: mat4.soaFromJointTransform,
    fromBoneDirection: mat3.fromBoneDirection,
    lookAtQuat: quat.lookAt,
    springLookAt: quat.springLookAt,
    soaLookAtQuat: quat.soaLookAt,
    lookAtDQ: quat2.lookAtDQ,
    soaLookAtDQ: quat2.soaLookAtDQ,
    springDamp3: vec3.springDamp3,
    quatSpringDamp: quat.springDamp,
    dqSpringDamp: quat2.springDamp,
    createTargetAnimation: animation.createIKTargetAnimation,
    createIKSystem: bitecs.createIKSystem,
    attachDrag: draggableModule.attachIKDrag,
    scrollTarget: scroll.createIKScrollTarget,
    motionPath: svgModule.createIKMotionPath,
    recipeReach: recipesModule.recipeIKReach,
    fabrikPrecise: double.fabrikStep3_precise
};

const orbital = {
    keplerSolve: common.keplerSolve,
    eccentricToTrue: common.eccentricToTrue,
    meanToTrue: common.meanToTrue,
    keplerSolveDouble: double.keplerSolve2,
    keplerSolveDoubleExact: double.keplerSolve2Exact,
    orbit2D: vec2.keplerOrbit2D,
    orbit3D: vec3.keplerOrbit3D,
    velocity3D: vec3.keplerOrbitVelocity3D,
    speed2D: vec2.orbitalSpeed2D,
    speed3D: vec3.orbitalSpeed3D,
    hohmann: vec3.hohmannTransfer,
    sphereOfInfluence: vec3.sphereOfInfluence,
    createEpoch: timer.createOrbitalEpoch,
    createSystem: bitecs.createOrbitalSystem,
    spawnBodies: bitecs.spawnOrbitalBodies,
    integrateDouble: double.integrateOrbitSOA,
    fromInclination: quat.fromInclination,
    fromOrbitalElementsQuat: quat.fromOrbitalElements,
    soaFromOrbitalElementsQuat: quat.soaFromOrbitalElements,
    fromOrbitalElementsDQ: quat2.fromOrbitalElements,
    soaFromOrbitalElementsDQ: quat2.soaFromOrbitalElements,
    fromOrbitalElementsMat4: mat4.fromOrbitalElements,
    soaFromOrbitalElementsMat4: mat4.soaFromOrbitalElements,
    soaFromOrbitalElementsMat4Chunked: mat4.soaFromOrbitalElementsChunked,
    fromOrbitalFrameMat3: mat3.fromOrbitalFrame,
    soaFillFromOrbitalFrame: mat3.soaFillFromOrbitalFrame,
    fromVelocityTranslation: quat2.fromVelocityTranslation,
    soaFromVelocityTranslation: quat2.soaFromVelocityTranslation,
    soaFromVelocityTranslationChunked: quat2.soaFromVelocityTranslationChunked,
    attachDrag: draggableModule.attachOrbitalDrag,
    scroll: scroll.createOrbitalScroll,
    scrollOrder: scroll.createOrbitalScrollOrder,
    motionPath: svgModule.createKeplerMotionPath,
    recipeChase: recipesModule.recipeKeplerChase,
    recipeReveal: recipesModule.recipeOrbitalReveal,
    recipeGalacticSpin: recipesModule.recipeGalacticSpin
};

const hi = {
    Double: double.Double,
    createDoubleSOA: createDoubleSOA,
    twoSum: double.twoSum,
    twoProd: double.twoProd,
    oneSqr: double.oneSqr,
    splitter: double.splitter,
    fromFloat32: double.soaFromFloat32,
    add22: double.soaAdd22, sub22: double.soaSub22,
    mul22: double.soaMul22, div22: double.soaDiv22,
    add21: double.soaAdd21, sub21: double.soaSub21,
    mul21: double.soaMul21, div21: double.soaDiv21,
    sqr2: double.soaSqr2, sqrt2: double.soaSqrt2,
    inv2: double.soaInv2, abs2: double.soaAbs2, neg2: double.soaNeg2,
    eq: double.soaEq, ne: double.soaNe, gt: double.soaGt,
    lt: double.soaLt, ge: double.soaGe, le: double.soaLe,
    add22Chunked: double.soaAdd22Chunked,
    mul22Chunked: double.soaMul22Chunked,
    keplerSolve2: double.keplerSolve2,
    keplerSolve2Exact: double.keplerSolve2Exact,
    integrateOrbitSOA: double.integrateOrbitSOA,
    attachHighPrecisionPositions: double.attachHighPrecisionPositions,
    setWorldPosition: double.setWorldPosition,
    getWorldPosition: double.getWorldPosition,
    worldToFloat32: double.worldToFloat32,
    float32ToWorld: double.float32ToWorld,
    recenterWorld: double.recenterWorld,
    fabrikStep3_precise: double.fabrikStep3_precise,
    mat4TransformVec3_precise: double.mat4TransformVec3_precise,
    springDamp2: double.springDamp2,
    soaSpringDamp2: double.soaSpringDamp2,
    acesToneMap1: double.acesToneMap1,
    acesToneMapSOA: double.acesToneMapSOA
};

const shape = {
    GenericToAnyShape: motionExt.GenericToAnyShape,
    ShapePrimitive: motionExt.ShapePrimitive,
    ShapeSampler: motionExt.ShapeSampler,
    MorphTrack: motionExt.MorphTrack,
    SOAMorphGroup: motionExt.SOAMorphGroup,
    resolveShapeSource: motionExt.resolveShapeSource,
    buildShapePath: motionExt.buildShapePath,
    alignPointsByAngle: motionExt.alignPointsByAngle,
    samplePath: svgModule.samplePath,
    samplePathFlat: svgModule.samplePathFlat,
    samplePathAsync: svgModule.samplePathAsync,
    createMorphablePaths: svgModule.createMorphablePaths,
    pooledMorph: svgModule.pooledMorph,
    soaPathMorph: svgModule.createSOAPathMorph,
    soaMotionPath: svgModule.createSOAMotionPath,
    glyphPathAnimation: svgModule.createGlyphPathAnimation
};

const pool = {
    create: common.createPool,
    vec2:  { create: vec2.createVec2Pool,   acquire: vec2.acquire,  release: vec2.release },
    vec3:  { create: vec3.createVec3Pool,   acquire: vec3.acquire,  release: vec3.release },
    vec4:  { create: vec4.createVec4Pool,   acquire: vec4.acquire,  release: vec4.release },
    mat2:  { create: mat2.createMat2Pool,   acquire: mat2.acquire,  release: mat2.release },
    mat3:  { create: mat3.createMat3Pool,   acquire: mat3.acquire,  release: mat3.release },
    mat4:  { create: mat4.createMat4Pool,   acquire: mat4.acquire,  release: mat4.release },
    quat:  { create: quat.createQuatPool,   acquire: quat.acquire,  release: quat.release },
    quat2: { create: quat2.createQuat2Pool, acquire: quat2.acquire, release: quat2.release },
    double:{ create: double.createDoublePool, acquire: double.acquire, release: double.release },
    noise: {
        create: simplex.createNoisePool,
        acquire2D: simplex.acquireNoise2D,
        acquire3D: simplex.acquireNoise3D,
        acquire4D: simplex.acquireNoise4D
    },
    animation: { acquire: acquireAnimation, release: releaseAnimation },
    timer:     { acquire: acquireTimer,     release: releaseTimer },
    timeline:  { acquire: acquireTimeline,  release: releaseTimeline },
    decomp:    { acquire: utils.acquireDecomp, release: utils.releaseDecomp },
    scope:     { acquire: scopeModule.acquireScopedStudio, release: scopeModule.releaseScopedStudio },
    scroll:    { acquire: scroll.acquireScrollTrigger, release: scroll.releaseScrollTrigger },
    drag:      { acquire: draggableModule.acquireDraggable },
    svgMorph:  { acquire: svgModule.pooledMorph },
    recipe:    { acquire: recipesModule.pooledRecipe },
    ecsSOA:    { acquire: bitecs.soaPoolGet, release: bitecs.soaPoolRelease }
};

const soa = {
    vec2: createVec2SOA,
    vec3: createVec3SOA,
    vec4: createVec4SOA,
    mat2: createMat2SOA,
    mat3: createMat3SOA,
    mat4: createMat4SOA,
    quat: createQuatSOA,
    quat2: createQuat2SOA,
    double: createDoubleSOA,
    color: createColorSOA,
    velocity: createVelocitySOA,
    transform: createTransform
};

async function soaStepAsync(target, fn, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const n = target.count !== undefined ? target.count : target.length;
    let c = 0;
    for (let start = 0; start < n; start += chunkSize) {
        const end = Math.min(start + chunkSize, n);
        for (let i = start; i < end; i++) fn(i, target);
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return target;
}

const chunked = {
    yield: common.yieldToMain,
    forEach: common.forEachChunked,
    soaStep: soaStepAsync,
    soaForEach: common.soaChunkedForEach,
    workerPool: common.createWorkerPool,
    entities: utils.forEachEntityChunked,
    iterEntities: bitecs.iterChunked,
    queryEntities: bitecs.queryChunked,
    CHUNK_SIZE: common.CHUNK_SIZE,
    CHUNK_YIELD_EVERY: common.CHUNK_YIELD_EVERY,
    WORKER_COUNT: common.WORKER_COUNT
};

// ============================================================================
// 9. OVERRIDE THE BUNDLES' SOA BUILDERS WITH PRECISION-AWARE ONES
// `motionEngine.createScene` / `motionExt.createScene` and any consumer of
// `*.soa.*` automatically respects the current precision mode.
// ============================================================================
function _patchBundleSOA(bundle) {
    if (!bundle || !bundle.soa) return;
    bundle.soa.vec2 = createVec2SOA;
    bundle.soa.vec3 = createVec3SOA;
    bundle.soa.vec4 = createVec4SOA;
    bundle.soa.mat2 = createMat2SOA;
    bundle.soa.mat3 = createMat3SOA;
    bundle.soa.mat4 = createMat4SOA;
    bundle.soa.quat = createQuatSOA;
    bundle.soa.quat2 = createQuat2SOA;
    bundle.soa.double = createDoubleSOA;
    bundle.soa.color = createColorSOA;
    bundle.soa.transform = createTransform;
}
_patchBundleSOA(motionEngine);
_patchBundleSOA(motionExt);

// ============================================================================
// 10. PRECISION-AWARE SCENE BOOTSTRAP
//  • scatter reuses the pre-created entity IDs (never spawns a second set)
//  • colours default to opaque white
//  • uploadTo composes straight into the interleaved buffer in ONE pass with
//    dirty-range tracking
//  • dispose never destroys the shared GlobalEngine singleton
// ============================================================================
function _composeTRSIntoFlat(flat, trs, n, ox, oy, oz) {
    const px = trs.position.x, py = trs.position.y, pz = trs.position.z;
    const qx = trs.rotation.x, qy = trs.rotation.y, qz = trs.rotation.z, qw = trs.rotation.w;
    const sx = trs.scale.x, sy = trs.scale.y, sz = trs.scale.z;
    for (let i = 0, o = 0; i < n; i++, o += 16) {
        const x = qx[i], y = qy[i], z = qz[i], w = qw[i];
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2;
        const yy = y * y2, yz = y * z2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;
        const Sx = sx[i], Sy = sy[i], Sz = sz[i];
        flat[o]      = (1 - (yy + zz)) * Sx;
        flat[o + 1]  = (xy + wz) * Sx;
        flat[o + 2]  = (xz - wy) * Sx;
        flat[o + 3]  = 0;
        flat[o + 4]  = (xy - wz) * Sy;
        flat[o + 5]  = (1 - (xx + zz)) * Sy;
        flat[o + 6]  = (yz + wx) * Sy;
        flat[o + 7]  = 0;
        flat[o + 8]  = (xz + wy) * Sz;
        flat[o + 9]  = (yz - wx) * Sz;
        flat[o + 10] = (1 - (xx + yy)) * Sz;
        flat[o + 11] = 0;
        flat[o + 12] = px[i] - ox;
        flat[o + 13] = py[i] - oy;
        flat[o + 14] = pz[i] - oz;
        flat[o + 15] = 1;
    }
}
function _flagInstanceUpload(mesh, n) {
    const attr = mesh.instanceMatrix;
    if (!attr) return;
    if (mesh.count !== undefined) mesh.count = n;
    if (attr.clearUpdateRanges) attr.clearUpdateRanges();
    if (attr.addUpdateRange) attr.addUpdateRange(0, n * 16);
    attr.needsUpdate = true;
}

function _buildScene(config, w, eids, trs, colors, matrices, velocities) {
    const count = eids.length;
    const ownsEngine = !!config.engine;
    const engineRef = config.engine || engine.GlobalEngine;
    let origin = config.origin || null;
    const ownedSteps = [];

    const scene = {
        world: w,
        engine: engineRef,
        count: count,
        eids: eids,
        trs: trs,
        colors: colors,
        matrices: matrices,
        velocities: velocities,
        get precision() { return getSOAPrecision(trs.position); },
        compose: function () {
            return mat4.soaComposeTRS(matrices, trs.position, trs.rotation, trs.scale);
        },
        composeChunked: function (cs, ye) {
            return mat4.soaComposeTRSChunked(matrices, trs.position, trs.rotation, trs.scale, cs, ye);
        },
        /** Single-pass compose + dirty-range upload into a THREE.InstancedMesh. */
        uploadTo: function (mesh) {
            if (!mesh || !mesh.instanceMatrix || !mesh.instanceMatrix.array) return scene;
            const ox = origin ? origin[0] : 0;
            const oy = origin ? origin[1] : 0;
            const oz = origin ? origin[2] : 0;
            _composeTRSIntoFlat(mesh.instanceMatrix.array, trs, count, ox, oy, oz);
            _flagInstanceUpload(mesh, count);
            return scene;
        },
        setOrigin: function (x, y, z) {
            if (!origin) origin = new Float64Array(3);
            origin[0] = x; origin[1] = y; origin[2] = z;
            return scene;
        },
        getOrigin: function () { return origin; },
        /** Register a scene-owned SOA step (removed automatically on dispose). */
        addStep: function (fn, name) {
            const entry = engineRef.addSoaStep(fn, name);
            ownedSteps.push(entry);
            return entry;
        },
        removeStep: function (entry) {
            const i = ownedSteps.indexOf(entry);
            if (i !== -1) ownedSteps.splice(i, 1);
            engineRef.removeSoaStep(entry);
            return scene;
        },
        /** Manually drive the scene-owned steps (the RAF loop normally does it). */
        step: function (dtSec, nowMs) {
            for (let i = 0; i < ownedSteps.length; i++) {
                const e = ownedSteps[i];
                if (e.enabled !== false) e.fn(dtSec, nowMs);
            }
            return scene;
        },
        migrate: function (mode) { return migrateScene(scene, mode); },
        track: function () { return trackScene(scene); },
        untrack: function () { return untrackScene(scene); },
        dispose: function () {
            for (let i = 0; i < ownedSteps.length; i++) engineRef.removeSoaStep(ownedSteps[i]);
            ownedSteps.length = 0;
            untrackScene(scene);
            bitecs.deleteWorld(w);
            if (ownsEngine && engineRef.destroy) engineRef.destroy();
        }
    };
    return scene;
}

function _applyScatter(config, count, eids, trs, w) {
    if (!config.scatter) return;
    let spawnIdx = 0;
    const opts = {};
    for (const k in config.scatter) opts[k] = config.scatter[k];
    opts.spawn = function () { return eids[spawnIdx++]; };
    const res = bitecs.scatterEntities(w, count, opts);
    trs.position.x.set(res.position.x);
    trs.position.y.set(res.position.y);
    trs.position.z.set(res.position.z);
    trs.rotation.x.set(res.rotation.x);
    trs.rotation.y.set(res.rotation.y);
    trs.rotation.z.set(res.rotation.z);
    trs.rotation.w.set(res.rotation.w);
    trs.scale.x.set(res.scale.x);
    trs.scale.y.set(res.scale.y);
    trs.scale.z.set(res.scale.z);
}

/**
 * One-call scene bootstrap. Returns engine + world + TRS/colour/matrix/velocity
 * SOAs + entity IDs, all honouring the current precision mode.
 */
function bootstrap(config) {
    config = config || {};
    const count = config.count || 1024;
    const w = bitecs.createWorld();
    const trs = createTransform(count, config.type);
    const colors = createColorSOA(count, config.type);
    const matrices = createMat4SOA(count, config.type);
    const velocities = createVelocitySOA(count, config.type);
    const eids = new Uint32Array(count);
    for (let i = 0; i < count; i++) eids[i] = bitecs.addEntity(w);
    if (config.scatter) _applyScatter(config, count, eids, trs, w);
    const scene = _buildScene(config, w, eids, trs, colors, matrices, velocities);
    if (config.track !== false) trackScene(scene);
    return scene;
}

/** Chunked bootstrap — mobile-safe entity creation for 1M+ instances. */
async function bootstrapAsync(config) {
    config = config || {};
    const count = config.count || 1024;
    const chunkSize = config.chunkSize || common.CHUNK_SIZE;
    const yieldEvery = config.yieldEvery || common.CHUNK_YIELD_EVERY;
    const w = bitecs.createWorld();
    const trs = createTransform(count, config.type);
    const colors = createColorSOA(count, config.type);
    const matrices = createMat4SOA(count, config.type);
    const velocities = createVelocitySOA(count, config.type);
    const eids = new Uint32Array(count);
    let c = 0;
    for (let start = 0; start < count; start += chunkSize) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) eids[i] = bitecs.addEntity(w);
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    if (config.scatter) {
        _applyScatter(config, count, eids, trs, w);
        await common.yieldToMain();
    }
    const scene = _buildScene(config, w, eids, trs, colors, matrices, velocities);
    if (config.track !== false) trackScene(scene);
    return scene;
}

// ============================================================================
// 11. AUTO-BUILT FLAT PASSTHROUGH
// Every public export of every module, merged in creation order (first wins).
// Ambiguous names are reported in `flatConflicts` and must be read through a
// namespace (e.g. `vec3.soaAdd` vs `vec4.soaAdd`).
// ============================================================================
const _FLAT_SKIP = { math: 1, __esModule: 1, default: 1 };
const flat = Object.create(null);
const flatConflicts = Object.create(null);
for (let i = 0; i < MODULE_LIST.length; i++) {
    const entry = MODULE_LIST[i];
    const mod = entry.module;
    if (!mod) continue;
    const keys = Object.keys(mod);
    for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (_FLAT_SKIP[key]) continue;
        if (key in flat) {
            if (flat[key] !== mod[key]) {
                (flatConflicts[key] || (flatConflicts[key] = [])).push(entry.name);
            }
            continue;
        }
        flat[key] = mod[key];
    }
}

// ============================================================================
// 12. CURATED FLAT NAMES (disambiguated where modules share an identifier)
// ============================================================================
// ---- 001 common ----
const {
    EPSILON, RANDOM, ANGLE_ORDER,
    SCALE_NEAR, SCALE_EARTH, SCALE_SUN, SCALE_AU, SCALE_LY, SCALE_PC, SCALE_KPC, SCALE_MPC,
    CHUNK_SIZE, CHUNK_YIELD_EVERY, WORKER_COUNT, POOL_PREALLOC,
    PI, TWO_PI, HALF_PI, DEG2RAD, RAD2DEG,
    round, setMatrixArrayType, toRadian, toDegree, equals,
    clamp, clamp01, lerp, sign, fract, step, smoothstep, smootherstep, pow2, invSqrt, mod,
    fastTwoSum, twoSum, dsSub,
    createSOA, soaFill, soaZero, soaForEach, soaChunkedForEach,
    createPool, yieldToMain, forEachChunked, createWorkerPool,
    mulberry32, xorshift32, splitmix32, hash2, hash3,
    srgbToLinear, linearToSrgb, hslToRgb, rgbToHsl, hsvToRgb, rgbToHsv,
    packRGBA, unpackRGBA, hexToRgb, rgbToHex,
    damp, springDamp,
    logDepthConstants, logDepthLinearize, toRelative, toAbsolute,
    keplerSolve, eccentricToTrue, meanToTrue
} = common;

// ---- 014 utils ----
const {
    mapRange, random, randomInt, stagger, toArray, parseColor,
    calcRelativeValue, decomposeValue, interpolateDecomposed,
    acquireDecomp, releaseDecomp, decomposeInto,
    soaClamp, soaLerp, soaMapRange, soaRandom, soaEase,
    soaClampChunked, soaLerpChunked, soaMapRangeChunked,
    expLerp,
    srgb8ToLinear, linearToSrgb8, exposeColor, reinhardColor, acesColor,
    packColorRGBA, unpackColorRGBA, cssColor,
    staggerHash, staggerNoise, staggerKepler, staggerRadial, staggerVoronoi, staggerForEntities,
    forEachEntityChunked
} = utils;

// ---- 002 vec2 ----
const {
    valueNoise2D, gradientNoise2D, fbm2D, voronoi2D, keplerOrbit2D, orbitalSpeed2D,
    polarToCartesian, cartesianToPolar, ellipsePoint, springDamp2
} = vec2;
const soaFillNoise2D = vec2.soaFillNoise2D;
const soaFillNoise2DChunked = vec2.soaFillNoise2DChunked;
const quadraticBezier2 = vec2.quadraticBezier;
const cubicBezier2 = vec2.cubicBezier;
const catmullRom2 = vec2.catmullRom;

// ---- 003 vec3 ----
const {
    fabrikStep3, ccdStep3, lookAtBasis,
    valueNoise3D, gradientNoise3D, fbm3D, voronoi3D,
    acesToneMap, reinhardToneMap, packRGB, unpackRGB, packVec3RGB,
    keplerOrbit3D, keplerOrbitVelocity3D, orbitalSpeed3D, hohmannTransfer, sphereOfInfluence,
    springDamp3, hermite, bezier
} = vec3;
const soaFillNoise3D = vec3.soaFillNoise3D;
const soaFillNoise3DChunked = vec3.soaFillNoise3DChunked;
const quadraticBezier3 = vec3.quadraticBezier;
const cubicBezier3 = vec3.cubicBezier;
const catmullRom3 = vec3.catmullRom;

// ---- 004 vec4 ----
const {
    valueNoise4D, fbm4D, turbulence4D, perspectiveDivide, linearizeDepth,
    premultiplyAlpha, unpremultiplyAlpha, springDamp4,
    quatFromAxisAngle, quatConjugate, quatMultiply, quatIdentity,
    soaFillColor, soaExpose, soaSrgbToLinear, soaLinearToSrgb
} = vec4;
const soaFillNoise4D = vec4.soaFillNoise4D;
const soaFillNoise4DChunked = vec4.soaFillNoise4DChunked;
const vec4QuatSpringDamp = vec4.quatSpringDamp;
const quatNlerp = vec4.nlerp;
const quadraticBezier4 = vec4.quadraticBezier;
const cubicBezier4 = vec4.cubicBezier;
const catmullRom4 = vec4.catmullRom;
const hermite4 = vec4.hermite;

// ---- 005 mat2 ----
const {
    fromViewport, fromAspectFit, fromShear, fromChromaRotation,
    soaHueRotateChroma, soaFillFromRotations, soaFillRotationFromNoise,
    soaFillAnisoFromVoronoi, soaTransformVec2, fromTwoBoneChain, fromOrbitalTangent
} = mat2;
const mat2FromReflection = mat2.fromReflection;
const mat2FromUniformScale = mat2.fromUniformScale;
const mat2FromWorldBounds = mat2.fromWorldBounds;
const mat2FromDirection = mat2.fromDirection;
const fromOrbitalFrame2 = mat2.fromOrbitalFrame;
const mat2Decompose = mat2.decompose;
const mat2Compose = mat2.compose;
const mat2BlendRotation = mat2.blendRotation;

// ---- 006 mat3 ----
const {
    buildTBN, soaBuildTBN, soaBuildTBNChunked, normalFromMat4,
    fromSaturation, fromGrayscale, fromHueRotation, fromChannelMix,
    soaApplyColorMatrix, fromBoneDirection, fromLookAt, fromAxes,
    fromOrbitalFrame, soaFillFromOrbitalFrame, fromScreenToNDC, fromScale3,
    soaFromQuatSOA, soaFromQuatSOAChunked,
    LUMA_R709, LUMA_G709, LUMA_B709
} = mat3;
const mat3FromInclination = mat3.fromInclination;
const mat3FromReflection = mat3.fromReflection;
const mat3FromUniformScale = mat3.fromUniformScale;
const mat3FromWorldBounds = mat3.fromWorldBounds;
const mat3SoaTransformVec3 = mat3.soaTransformVec3;
const mat3Decompose = mat3.decompose;
const mat3Compose = mat3.compose;
const mat3BlendRotation = mat3.blendRotation;

// ---- 007 mat4 ----
const {
    soaComposeTRS, soaComposeTRSChunked,
    soaTransformPoint, soaTransformPointChunked, soaTransformPointPerspective,
    soaMultiply, soaMultiplyChunked, soaInvert, soaInvertChunked, soaDecompose,
    targetTo, frustum, perspectiveNO, perspectiveZO, orthoNO, orthoZO,
    perspectiveFromFieldOfView, getScaling, getRotation,
    fromWorldBoundsNDC, worldToView, viewToWorld, fromMat3Translation,
    fromJointTransform, soaFromJointTransform,
    blendTRS, springDampTranslation, subtractTranslation,
    soaFillTRSFromNoise, soaFillTRSFromNoiseChunked
} = mat4;
const mat4LookAt = mat4.lookAt;
const mat4GetTranslation = mat4.getTranslation;
const mat4Decompose = mat4.decompose;
const mat4SoaToFlat = mat4.soaToFlat;
const soaTranspose = soaTransposeMat4;
const mat4FromOrbitalElements = mat4.fromOrbitalElements;
const mat4SoaFromOrbitalElements = mat4.soaFromOrbitalElements;
const mat4SoaFromOrbitalElementsChunked = mat4.soaFromOrbitalElementsChunked;

// ---- 008 quat ----
const {
    springLookAt, soaLookAt, fromInclination, setAxisAngle, getAxisAngle,
    rotationTo, sqlerp, setAxes, soaFillFromVelocity, soaFillSpinFrom4DNoise,
    soaRotateVec3, soaSlerp, soaNlerp, soaFromEuler, soaFromAxisAngle,
    soaToMat3, soaFromMat3
} = quat;
const quatLookAt = quat.lookAt;
const quatSpringDamp = quat.springDamp;
const quatSoaSpringDamp = quat.soaSpringDamp;
const quatSoaFillFromNoise = quat.soaFillFromNoise;
const quatFromEuler = quat.fromEuler;
const quatFromOrbitalElements = quat.fromOrbitalElements;
const quatSoaFromOrbitalElements = quat.soaFromOrbitalElements;

// ---- 009 quat2 ----
const {
    lookAtDQ, soaLookAtDQ, fromVelocityTranslation,
    soaFromVelocityTranslation, soaFromVelocityTranslationChunked
} = quat2;
const dqFromOrbitalElements = quat2.fromOrbitalElements;
const dqSoaFromOrbitalElements = quat2.soaFromOrbitalElements;
const dqSoaGetTranslation = quat2.soaGetTranslation;
const dqSoaToMat4 = quat2.soaToMat4;
const dqSoaTransformPoint = quat2.soaTransformPoint;
const dqSoaRecenter = quat2.soaRecenter;
const dqRecenter = quat2.recenter;
const dqSpringDamp = quat2.springDamp;
const dqSoaSpringDamp = quat2.soaSpringDamp;
const dqFromRotationTranslation = quat2.fromRotationTranslation;
const dqSoaFromRotationTranslation = quat2.soaFromRotationTranslation;

// ---- 013 simplex ----
const {
    createNoise2D, createNoise3D, createNoise4D,
    acquireNoise2D, acquireNoise3D, acquireNoise4D, createNoisePool,
    buildPermutationTable, createNoiseFieldSystem,
    soaFillTurbulence3D, soaFillRidged3D, soaFillWarped3D, soaFillCurl3D, soaFillGradient3D,
    soaFillTurbulence3DChunked, soaFillRidged3DChunked,
    soaFillCurl3DChunked, soaFillGradient3DChunked
} = simplex;
const simplexFillNoise2D = simplex.soaFillNoise2D;
const simplexFillNoise3D = simplex.soaFillNoise3D;
const simplexFillNoise4D = simplex.soaFillNoise4D;
const simplexFillFBM2D = simplex.soaFillFBM2D;
const simplexFillFBM3D = simplex.soaFillFBM3D;
const simplexFillFBM4D = simplex.soaFillFBM4D;
const simplexFillNoise3DChunked = simplex.soaFillNoise3DChunked;
const simplexFillFBM3DChunked = simplex.soaFillFBM3DChunked;

// ---- 015 easings ----
const {
    getEasing, cubicBezier, cubicBezierCSS, CSS_CURVES, createEasingSystem,
    easeColorRGBA, soaEaseColor, soaEaseColorChunked, soaEaseColorTargets,
    easeKeplerPosition, easeKeplerState, easeIKTarget, easeQuat,
    staggerEased, staggerWithEase,
    soaSpringDampBatch, soaSpringDampBatchChunked,
    soaSpringDamp3Batch, soaSpringDamp3BatchChunked
} = easings;
const easingsMap = easings.easings;
const easeSpring = easings.spring;
const soaEaseApply = easings.soaApply;
const soaEaseApplyLerpPerT = easings.soaApplyLerpPerT;

// ---- 016 engine ----
const { Engine, GlobalEngine, makeBitECSSystem } = engine;

// ---- 017 animation ----
const {
    Animation, SOAAnimationTrack, createSOAAnimationTrack, getEasingFunction,
    animateVec3, animateVec4, animateQuat, animateColor, animateTRS,
    createECSChannelAnimation, createECSChannelAnimationStaggered,
    createIKTargetAnimation, createOrbitalMAnimation, createOrbitalAAnimation,
    createOrbitalEAnimation, createOrbitalIncAnimation,
    createColorSOAAnimation, createNoiseDrivenAnimation
} = animation;

// ---- 018 text ----
const {
    splitChars, splitWords, scramble, splitCharsAsync, splitWordsAsync, scrambleAsync,
    scramblePooled, createSOAScramble, createScrambleSystem,
    createNoiseReveal, createOrbitalReveal, createIKReveal, applyDelays,
    createScrambleColorSystem
} = textModule;
const textNamespace = textModule.text;

// ---- 019 timer ----
const { Timer, after, createTimerGroup, createFixedStepScheduler, createOrbitalEpoch, batchTick } = timer;

// ---- 020 scroll ----
const {
    ScrollTriggerInstance, onScroll, scrollTrigger,
    createParallax, createNoiseParallax, createSOAScrollGroup, createColorScrub,
    createOrbitalScrollOrder, createOrbitalScroll, createIKScrollTarget, attachTRSScroll
} = scroll;

// ---- 021 scope ----
const {
    animatable, acquireScopedStudio, releaseScopedStudio, attachedScope, asyncScope,
    scopeWorld, createScopeGroup, animatableVec3, animatableColor
} = scopeModule;
const scopeFn = scopeModule.scope;

// ---- 022 recipes ----
const {
    pooledRecipe, chainRecipes, soaRecipes, recipeHDRColorScrub,
    recipeNoiseWave, recipeOrbitalReveal, recipeKeplerChase, recipeNebulaBloom,
    recipeStarfieldScroll, recipeIKReach, recipeGalacticSpin, recipeOnQuery
} = recipesModule;
const recipesMap = recipesModule.recipes;

// ---- 023 svg ----
const {
    samplePath, samplePathFlat, samplePathFlatChunked, samplePathAsync,
    createMorphablePaths, pooledMorph, samplePathIntoSOA, samplePathIntoSOAChunked,
    createSOAPathMorph, createSOAMotionPath, createKeplerMotionPath,
    createIKMotionPath, createPathColorGradient, createGlyphPathAnimation, getHelperPath
} = svgModule;
const svgNamespace = svgModule.svg;

// ---- 024 timeline ----
const { Timeline, timelineFromConfigs, parallelTimelines } = timeline;

// ---- 025 adapters ----
const {
    waapi, animateThree, animateThreeChunked, animateThreeSOA, animateInstancedMesh,
    animateIKThree, animateOrbitalThree, soaCSSVars, soaCSSVarsChunked
} = adaptersModule;
const adaptersMap = adaptersModule.adapters;

// ---- 026 draggable ----
const {
    draggable, acquireDraggable, attachSOADraggable, attachIKDrag, attachOrbitalDrag,
    attachSOASnapGrid, attachHDRTrail, attachECSDrag
} = draggableModule;

// ---- 028 extended animation system ----
const {
    GenericToAnyShape, ShapePrimitive, ShapeSampler, MorphTrack, SOAMorphGroup,
    KeyframeTrack, AnimationStateMachine, BlendTree, FullAnimationSystem,
    resolveShapeSource, buildShapePath, alignPointsByAngle
} = motionExt;

// ---- 011 serialization ----
const {
    serializeScene, deserializeScene, createByteWriter, createByteReader,
    createSoASerializer, createSoADeserializer, createAoSSerializer, createAoSDeserializer,
    createSnapshotSerializer, createSnapshotDeserializer,
    createObserverSerializer, createObserverDeserializer,
    createTRSSOASerializer, createTRSSOADeserializer, createTRSSOASerializerChunked,
    createOrbitalSOASerializer, createOrbitalSOADeserializer, createOrbitalSOASerializerChunked,
    createColorSOASerializer, createColorSOADeserializer, createColorSOASerializerChunked,
    createIKChainSerializer, createIKChainDeserializer,
    createAnimationSerializer, createAnimationDeserializer,
    createAABBSerializer, createAABBDeserializer,
    createWorldPositionSerializer, createWorldPositionDeserializer,
    serializeSnapshotChunked
} = serialization;

// ---- 012 double ----
const {
    Double, keplerSolve2, keplerSolve2Exact, integrateOrbitSOA,
    attachHighPrecisionPositions, setWorldPosition, getWorldPosition,
    worldToFloat32, float32ToWorld, recenterWorld,
    fabrikStep3_precise, mat4TransformVec3_precise,
    hash3_64, valueNoise3D_64, acesToneMap1
} = double;
const acesToneMapSOA64 = double.acesToneMapSOA;
const springDamp2Scalar = double.springDamp2;

// ---- 010 bitECS ----
const {
    createWorld, resetWorld, deleteWorld, addEntity, addPrefab, removeEntity, entityExists,
    addComponent, addComponents, removeComponent, removeComponents,
    hasComponent, getComponent, setComponent,
    query, registerQuery, removeQuery, registerComponent, registerComponents,
    observe, onAdd, onRemove, onSet, onGet, commitRemovals,
    createRelation, getRelationTargets, isRelation, isWildcard,
    makeExclusive, withStore, withAutoRemoveSubject, withOnTargetRemoved,
    Pair, Wildcard, Prefab, IsA, Or, And, Not, Hierarchy, Cascade, asBuffer, noCommit,
    getAllEntities, getEntityComponents, getWorldComponents,
    getHierarchyDepth, getMaxHierarchyDepth, createEntityIndex, withVersioning, getId, getVersion,
    createAnimationSystem, createIKSystem, createOrbitalSystem, createColorSystem,
    createFloatingOrigin, createSpatialGrid, createInstanceBatch, createTransformSOA,
    scatterEntities, scatterEntitiesChunked, spawnOrbitalBodies,
    iterChunked, queryChunked, soaStepChunked
} = bitecs;

// ============================================================================
// 13. EXPORTS
// ============================================================================
const StudioMotion = motionExt;

module.exports = {
    VERSION: "3.1.0-js",

    // ---------------------------------------------------------------------
    // Module registry — easy access to every file (001 → 028)
    // ---------------------------------------------------------------------
    modules, byNumber, getModule, MODULE_FILES, MODULE_LIST,
    flat, flatConflicts,

    // ---------------------------------------------------------------------
    // Precision control
    // ---------------------------------------------------------------------
    setPrecision, getPrecision, getArrayType, onPrecisionChange,
    getSOAPrecision, isDoubleSOA,
    migrateSOA, migrateSOAInPlace, migrateTransform, migrateScene, migrateAll,
    trackSOA, untrackSOA, trackTransform, untrackTransform, trackScene, untrackScene,
    clearTrackedSOAs, getTrackedSOAs, getTrackedCount,

    // ---------------------------------------------------------------------
    // Precision-wrapped SOA creators
    // ---------------------------------------------------------------------
    createVec2SOA, createVec3SOA, createVec4SOA,
    createMat2SOA, createMat3SOA, createMat4SOA,
    createQuatSOA, createQuat2SOA, createDoubleSOA,
    createTransform, createColorSOA, createVelocitySOA,

    // ---------------------------------------------------------------------
    // Raw module namespaces (001 → 028)
    // ---------------------------------------------------------------------
    common, vec2, vec3, vec4, mat2, mat3, mat4, quat, quat2,
    bitecs, serialization, double, simplex,
    utils, easings, engine, animation, timer, scroll, timeline,
    textModule, scopeModule, recipesModule, svgModule, adaptersModule, draggableModule,
    motionEngine, motionExtended: motionExt,
    getTimeline,

    // ---------------------------------------------------------------------
    // Composite namespaces
    // ---------------------------------------------------------------------
    math, ecs, world, anim, proc, hi, pool, soa,
    render, color, ik, orbital, shape, chunked,

    // ---------------------------------------------------------------------
    // Entry points / factories
    // ---------------------------------------------------------------------
    StudioMotion,
    bootstrap, bootstrapAsync,
    createScene: motionExt.createScene,
    createAnimation, createTimeline, createTimer, createEngine,
    composeTRSIntoFlat: _composeTRSIntoFlat,
    flagInstanceUpload: _flagInstanceUpload,

    // ---------------------------------------------------------------------
    // Classes
    // ---------------------------------------------------------------------
    Engine, GlobalEngine,
    Animation, SOAAnimationTrack,
    Timeline, Timer, ScrollTriggerInstance,
    Double,
    GenericToAnyShape, ShapePrimitive, ShapeSampler, MorphTrack, SOAMorphGroup,
    KeyframeTrack, AnimationStateMachine, BlendTree, FullAnimationSystem,

    // ---------------------------------------------------------------------
    // Safe pooled acquisition
    // ---------------------------------------------------------------------
    acquireAnimation, releaseAnimation,
    acquireTimer, releaseTimer,
    acquireTimeline, releaseTimeline,
    acquireDecomp, releaseDecomp,
    acquireScopedStudio, releaseScopedStudio,
    acquireDraggable,
    pooledRecipe, pooledMorph,

    // ---------------------------------------------------------------------
    // 001 common — config / math / parallelism
    // ---------------------------------------------------------------------
    EPSILON, RANDOM, ANGLE_ORDER,
    get ARRAY_TYPE() { return common.ARRAY_TYPE; },
    SCALE_NEAR, SCALE_EARTH, SCALE_SUN, SCALE_AU, SCALE_LY, SCALE_PC, SCALE_KPC, SCALE_MPC,
    CHUNK_SIZE, CHUNK_YIELD_EVERY, WORKER_COUNT, POOL_PREALLOC,
    PI, TWO_PI, HALF_PI, DEG2RAD, RAD2DEG,
    round, setMatrixArrayType, toRadian, toDegree, equals,
    clamp, clamp01, lerp, sign, fract, step, smoothstep, smootherstep, pow2, invSqrt, mod,
    fastTwoSum, twoSum, dsSub,
    createSOA, soaFill, soaZero, soaForEach, soaChunkedForEach,
    createPool, yieldToMain, forEachChunked, createWorkerPool, soaStepAsync,
    mulberry32, xorshift32, splitmix32, hash2, hash3, hash4,
    damp, springDamp, springDamp2, springDamp3, springDamp4, springDamp2Scalar,
    logDepthConstants, logDepthLinearize, toRelative, toAbsolute,
    keplerSolve, eccentricToTrue, meanToTrue,

    // ---------------------------------------------------------------------
    // 014 utils
    // ---------------------------------------------------------------------
    mapRange, random, randomInt, stagger, toArray, parseColor,
    calcRelativeValue, decomposeValue, interpolateDecomposed, decomposeInto,
    soaClamp, soaLerp, soaMapRange, soaRandom, soaEase,
    soaClampChunked, soaLerpChunked, soaMapRangeChunked,
    expLerp,
    staggerHash, staggerNoise, staggerKepler, staggerRadial, staggerVoronoi, staggerForEntities,
    forEachEntityChunked,

    // ---------------------------------------------------------------------
    // Procedural noise
    // ---------------------------------------------------------------------
    createNoise2D, createNoise3D, createNoise4D,
    acquireNoise2D, acquireNoise3D, acquireNoise4D, createNoisePool,
    buildPermutationTable, createNoiseFieldSystem,
    valueNoise2D, valueNoise3D, valueNoise4D,
    gradientNoise2D, gradientNoise3D,
    fbm2D, fbm3D, fbm4D, turbulence4D,
    voronoi2D, voronoi3D,
    soaFillNoise2D, soaFillNoise3D, soaFillNoise4D,
    soaFillNoise2DChunked, soaFillNoise3DChunked, soaFillNoise4DChunked,
    soaFillFBM2D: fillFBM2D, soaFillFBM3D: fillFBM3D, soaFillFBM4D: fillFBM4D,
    soaFillFBM2DChunked: fillFBM2DChunked,
    soaFillFBM3DChunked: fillFBM3DChunked,
    soaFillFBM4DChunked: fillFBM4DChunked,
    simplexFillNoise2D, simplexFillNoise3D, simplexFillNoise4D,
    simplexFillFBM2D, simplexFillFBM3D, simplexFillFBM4D,
    simplexFillNoise3DChunked, simplexFillFBM3DChunked,
    soaFillTurbulence3D, soaFillRidged3D, soaFillWarped3D, soaFillCurl3D, soaFillGradient3D,
    soaFillTurbulence3DChunked, soaFillRidged3DChunked,
    soaFillCurl3DChunked, soaFillGradient3DChunked,
    hash3_64, valueNoise3D_64,

    // ---------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------
    soaComposeTRS, soaComposeTRSChunked,
    soaTransformPoint, soaTransformPointChunked, soaTransformPointPerspective,
    soaMultiply, soaMultiplyChunked, soaInvert, soaInvertChunked,
    soaTranspose, soaDecompose, mat4Decompose, mat4SoaToFlat,
    mat4LookAt, targetTo, frustum, perspectiveNO, perspectiveZO, orthoNO, orthoZO,
    perspectiveFromFieldOfView, mat4GetTranslation, getScaling, getRotation,
    fromWorldBoundsNDC, worldToView, viewToWorld, fromMat3Translation,
    buildTBN, soaBuildTBN, soaBuildTBNChunked, normalFromMat4,
    perspectiveDivide, linearizeDepth,
    fromViewport, fromAspectFit, fromShear,
    mat2FromReflection, mat3FromReflection,
    mat2FromUniformScale, mat3FromUniformScale,
    mat2FromWorldBounds, mat3FromWorldBounds, fromScreenToNDC, fromScale3,
    soaTransformVec2, mat3SoaTransformVec3, soaFillFromRotations,
    soaFillRotationFromNoise, soaFillAnisoFromVoronoi,
    soaFillTRSFromNoise, soaFillTRSFromNoiseChunked,
    createInstanceBatch,
    dqSoaToMat4, dqSoaTransformPoint, dqSoaGetTranslation,
    dqFromRotationTranslation, dqSoaFromRotationTranslation,

    // ---------------------------------------------------------------------
    // Color
    // ---------------------------------------------------------------------
    srgbToLinear, linearToSrgb, srgb8ToLinear, linearToSrgb8,
    hslToRgb, rgbToHsl, hsvToRgb, rgbToHsv, hexToRgb, rgbToHex,
    packRGBA, unpackRGBA, packRGB, unpackRGB, packVec3RGB,
    packColorRGBA, unpackColorRGBA, cssColor,
    exposeColor, reinhardColor, acesColor, acesToneMap, reinhardToneMap,
    acesToneMap1, acesToneMapSOA64,
    premultiplyAlpha, unpremultiplyAlpha,
    soaFillColor, soaExpose, soaSrgbToLinear, soaLinearToSrgb, soaApplyColorMatrix,
    soaHueRotateChroma, soaHueRotate,
    fromSaturation, fromGrayscale, fromHueRotation, fromChannelMix, fromChromaRotation,
    LUMA_R709, LUMA_G709, LUMA_B709,

    // ---------------------------------------------------------------------
    // IK / natural motion
    // ---------------------------------------------------------------------
    fabrikStep3, ccdStep3, lookAtBasis,
    fromJointTransform, soaFromJointTransform, fromBoneDirection, fromLookAt, fromAxes,
    mat2FromDirection, fromTwoBoneChain, fromOrbitalTangent,
    quatLookAt, springLookAt, soaLookAt, quatSpringDamp, vec4QuatSpringDamp,
    lookAtDQ, soaLookAtDQ, dqSpringDamp, dqSoaSpringDamp,
    setAxisAngle, getAxisAngle, rotationTo, sqlerp, setAxes, quatFromEuler, soaFromEuler,
    soaFromAxisAngle, soaToMat3, soaFromMat3, soaFromQuatSOA, soaFromQuatSOAChunked,
    soaRotateVec3, soaSlerp, soaNlerp, quatNlerp, quatFromAxisAngle, quatConjugate,
    quatMultiply, quatIdentity,
    quatSoaSpringDamp, quatSoaFillFromNoise, soaFillFromVelocity, soaFillSpinFrom4DNoise,
    createIKTargetAnimation, createIKSystem,
    fabrikStep3_precise, mat4TransformVec3_precise,
    mat2Decompose, mat2Compose, mat2BlendRotation,
    mat3Decompose, mat3Compose, mat3BlendRotation,

    // ---------------------------------------------------------------------
    // Curves
    // ---------------------------------------------------------------------
    hermite, bezier,
    quadraticBezier2, quadraticBezier3, quadraticBezier4,
    cubicBezier2, cubicBezier3, cubicBezier4,
    catmullRom2, catmullRom3, catmullRom4, hermite4,

    // ---------------------------------------------------------------------
    // Orbital
    // ---------------------------------------------------------------------
    keplerOrbit2D, keplerOrbit3D, keplerOrbitVelocity3D,
    orbitalSpeed2D, orbitalSpeed3D, hohmannTransfer, sphereOfInfluence,
    polarToCartesian, cartesianToPolar, ellipsePoint,
    fromInclination, mat3FromInclination, fromOrbitalFrame, fromOrbitalFrame2,
    soaFillFromOrbitalFrame,
    quatFromOrbitalElements, quatSoaFromOrbitalElements,
    dqFromOrbitalElements, dqSoaFromOrbitalElements,
    mat4FromOrbitalElements, mat4SoaFromOrbitalElements, mat4SoaFromOrbitalElementsChunked,
    fromVelocityTranslation, soaFromVelocityTranslation, soaFromVelocityTranslationChunked,
    createOrbitalEpoch, createOrbitalSystem, spawnOrbitalBodies,
    keplerSolve2, keplerSolve2Exact, integrateOrbitSOA,

    // ---------------------------------------------------------------------
    // Animation / easing
    // ---------------------------------------------------------------------
    getEasing, getEasingFunction, easingsMap, easeSpring,
    cubicBezier, cubicBezierCSS, CSS_CURVES, createEasingSystem,
    easeColorRGBA, soaEaseColor, soaEaseColorChunked, soaEaseColorTargets,
    easeKeplerPosition, easeKeplerState, easeIKTarget, easeQuat,
    staggerEased, staggerWithEase,
    soaEaseApply, soaEaseApplyLerpPerT,
    soaSpringDampBatch, soaSpringDampBatchChunked,
    soaSpringDamp3Batch, soaSpringDamp3BatchChunked,
    createSOAAnimationTrack,
    animateVec3, animateVec4, animateQuat, animateColor, animateTRS,
    blendTRS, springDampTranslation,
    createECSChannelAnimation, createECSChannelAnimationStaggered,
    createOrbitalMAnimation, createOrbitalAAnimation,
    createOrbitalEAnimation, createOrbitalIncAnimation,
    createColorSOAAnimation, createNoiseDrivenAnimation,
    createAnimationSystem, createColorSystem,

    // ---------------------------------------------------------------------
    // Timeline / timer
    // ---------------------------------------------------------------------
    timelineFromConfigs, parallelTimelines,
    after, createTimerGroup, createFixedStepScheduler, batchTick,

    // ---------------------------------------------------------------------
    // Text / SVG / shape morphing
    // ---------------------------------------------------------------------
    text: textNamespace, svg: svgNamespace,
    splitChars, splitWords, scramble, splitCharsAsync, splitWordsAsync, scrambleAsync,
    scramblePooled, createSOAScramble, createScrambleSystem,
    createNoiseReveal, createOrbitalReveal, createIKReveal, applyDelays,
    createScrambleColorSystem,
    samplePath, samplePathFlat, samplePathFlatChunked, samplePathAsync,
    createMorphablePaths, samplePathIntoSOA, samplePathIntoSOAChunked,
    createSOAPathMorph, createSOAMotionPath, createKeplerMotionPath,
    createIKMotionPath, createPathColorGradient, createGlyphPathAnimation, getHelperPath,
    resolveShapeSource, buildShapePath, alignPointsByAngle,

    // ---------------------------------------------------------------------
    // Recipes
    // ---------------------------------------------------------------------
    recipes: recipesMap, presets: recipesMap, soaRecipes,
    chainRecipes, recipeOnQuery, recipeHDRColorScrub,
    recipeNoiseWave, recipeOrbitalReveal, recipeKeplerChase, recipeNebulaBloom,
    recipeStarfieldScroll, recipeIKReach, recipeGalacticSpin,

    // ---------------------------------------------------------------------
    // Scroll / drag / scope / adapters
    // ---------------------------------------------------------------------
    onScroll, scrollTrigger,
    createParallax, createNoiseParallax, createSOAScrollGroup, createColorScrub,
    createOrbitalScrollOrder, createOrbitalScroll, createIKScrollTarget, attachTRSScroll,
    draggable, attachSOADraggable, attachIKDrag, attachOrbitalDrag,
    attachSOASnapGrid, attachHDRTrail, attachECSDrag,
    scope: scopeFn, animatable, animatableVec3, animatableColor,
    attachedScope, asyncScope, scopeWorld, createScopeGroup,
    waapi, animateThree, animateThreeChunked, animateThreeSOA, animateInstancedMesh,
    animateIKThree, animateOrbitalThree, soaCSSVars, soaCSSVarsChunked,
    adapters: adaptersMap, makeBitECSSystem,

    // ---------------------------------------------------------------------
    // bitECS core
    // ---------------------------------------------------------------------
    createWorld, resetWorld, deleteWorld,
    addEntity, addPrefab, removeEntity, entityExists,
    addComponent, addComponents, removeComponent, removeComponents,
    hasComponent, getComponent, setComponent,
    query, registerQuery, removeQuery, registerComponent, registerComponents,
    observe, onAdd, onRemove, onSet, onGet, commitRemovals,
    createRelation, getRelationTargets, isRelation, isWildcard,
    makeExclusive, withStore, withAutoRemoveSubject, withOnTargetRemoved,
    Pair, Wildcard, Prefab, IsA, Or, And, Not, Hierarchy, Cascade, asBuffer, noCommit,
    getAllEntities, getEntityComponents, getWorldComponents,
    getHierarchyDepth, getMaxHierarchyDepth, createEntityIndex, withVersioning, getId, getVersion,
    createFloatingOrigin, createSpatialGrid, createTransformSOA,
    scatterEntities, scatterEntitiesChunked,
    iterChunked, queryChunked, soaStepChunked,

    // ---------------------------------------------------------------------
    // Serialization
    // ---------------------------------------------------------------------
    serializeScene, deserializeScene, serializeSnapshotChunked,
    createByteWriter, createByteReader,
    createSoASerializer, createSoADeserializer,
    createAoSSerializer, createAoSDeserializer,
    createSnapshotSerializer, createSnapshotDeserializer,
    createObserverSerializer, createObserverDeserializer,
    createTRSSOASerializer, createTRSSOADeserializer, createTRSSOASerializerChunked,
    createOrbitalSOASerializer, createOrbitalSOADeserializer, createOrbitalSOASerializerChunked,
    createColorSOASerializer, createColorSOADeserializer, createColorSOASerializerChunked,
    createIKChainSerializer, createIKChainDeserializer,
    createAnimationSerializer, createAnimationDeserializer,
    createAABBSerializer, createAABBDeserializer,
    createWorldPositionSerializer, createWorldPositionDeserializer,

    // ---------------------------------------------------------------------
    // High precision (double-double) / floating origin
    // ---------------------------------------------------------------------
    attachHighPrecisionPositions, setWorldPosition, getWorldPosition,
    worldToFloat32, float32ToWorld, recenterWorld,
    dqRecenter, dqSoaRecenter, subtractTranslation
};