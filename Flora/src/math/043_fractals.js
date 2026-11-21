//File number : 043
// File : src/math/043_fractals.js
//Description : Complete fractal math system (ESM) — 2D escape-time fractals (Mandelbrot,
//              smooth Mandelbrot, Julia, smooth Julia, Burning Ship, Multibrot, Newton,
//              Tricorn), 3D distance-estimator fractals (Mandelbulb, Mandelbox, quaternion
//              Julia, Sierpinski tetrahedron, Menger sponge), exact-count iterated function
//              systems (Sierpinski triangle/carpet, Koch snowflake, dragon curve, Cantor
//              set, 3D Cantor dust, Barnsley fern, true Descartes Apollonian gasket),
//              L-system expansion + a correct 3D turtle interpreter (H/L/U frame, yaw /
//              pitch / roll), procedural 3D tree growth, escape-time SDF distance
//              estimators, double-single deep-zoom Mandelbrot, fractal terrain / galaxy /
//              star-cluster worlds, LUT authoring, per-instance SOA batches across 1M+
//              fractals, chunked async for the mobile UI thread, pooled zero-GC scratch,
//              live Float16/Float32/Float64 migration, dirty-range GPU upload, and
//              zero-copy transferable batch state.
//
//              CORRECTIONS (this revision):
//              • FATAL: every split identifier repaired (`exports.soa\nMandelbulbDE`,
//                `mengerSpongeDE\n=`, `re\nturn`, `ite\nrations`, `s\nize`, `j\nxs`,
//                `sc\nale`, `outPositi\nons`, `juliaQ\nuatDE`, and the fatal
//                `count = count =\n== undefined`).
//              • FATAL: `exports.FractalScratch / FractalBatchState` read classes from the
//                TDZ at module-evaluation time → ReferenceError on load. Converted to ESM
//                `export class` / `export function`, which hoist correctly.
//              • FATAL: EVERY L-system preset rule and EVERY turtle switch case carried a
//                trailing space (`from:"F "`, `case "+ "`, `case "[ "`), so no rule ever
//                matched and the turtle drew nothing. All literals repaired; the
//                Sierpinski preset angle corrected to 120° for its `F-G-G` axiom.
//              • FATAL: `mengerSpongeDE` assigned `x = y = z = p`, collapsing the whole
//                fractal to a diagonal line. Replaced with the correct abs-fold /
//                descending-sort / `p*3-2` / `z`-fold IFS and the `3^-iterations` scaling.
//              • `juliaQuatDE` reset the running derivative (`dr = 2*r`) every iteration
//                instead of accumulating it (`dr = 2*r*dr`), producing a wildly wrong
//                distance estimate. Fixed, with a derivative floor and log guard.
//              • `mandelboxDE` ignored `fixedRadius` in the inner sphere fold and divided
//                by a signed multiplier. Now uses `fixedRadius²` / `minRadius²` correctly
//                and `abs(dr)`.
//              • `mandelbulbDE` / `mandelbulbIter` passed an unclamped `zz/r` to `acos`
//                (NaN at the poles) and could take `log(0)`. Clamped and guarded.
//              • `apollonianGasket` claimed Descartes' theorem but placed three naive
//                tangent circles. Replaced with a real Descartes-quadruple reflection
//                gasket (exact curvature + complex-centre reflection, no sqrt).
//              • `fractalStarCluster` used an unbounded `while (placed < count)` rejection
//                loop that hangs forever for parameters where the DE never drops below
//                the threshold. Now bounded with a deterministic fallback.
//              • `FractalBatchState.juliaAll` overwrote `outAux` and `zs` as constant
//                buffers, destroying caller data. Julia now uses scalar constants inline.
//              • `newtonFractal` recomputed the three cube roots of unity per call and
//                allocated a result array per pixel; roots are hoisted constants and an
//                `*Into` form is provided.
//              • ES2022 static blocks / private static fields removed so the file parses
//                on older Android WebViews; warm-up runs in plain IIFEs. The
//                `static #listeners = new Set()` notification path is now a dense array.
//              • `FractalScratch.acquire` used `Array.splice` (allocation per acquire);
//                now swap-removes. The monkey-patched `_fractalScratchPool.acquire` is
//                replaced by a real class-backed pool.
//
//              FEATURES ADDED from corrected_bitecs_enhancement.md:
//              • §10/§16 — Every IFS builder now computes its EXACT element count and
//                fills a typed array through an explicit pre-allocated stack. The
//                `out.push(...)` + `Float32Array.from(out)` patterns (which allocated
//                ~640k JS numbers for a depth-4 Cantor dust) are gone. `turtle3D` and
//                `growTree3D` pre-count segments and use flat Float64 stacks instead of
//                `stack.push([x,y,z,...])` literals. `mandelbulbIter` / `newtonFractal`
//                have `*Into` forms so no object is returned inside a frame loop.
//              • §25/§28 — `writeFractalIntoFlat` / `flagFractalUpload` /
//                `syncFractalAttribute`: upload DE or escape values straight into an
//                InstancedBufferAttribute backing array with `clearUpdateRanges` /
//                `addUpdateRange` dirty-prefix upload.
//              • §26     — Double-single deep zoom: `dsAddInto` / `dsMulInto` renormalize
//                with a full TwoSum, and `mandelbrotDS` / `deepZoomCoord` /
//                `soaMandelbrotDeepZoom` iterate the escape map in ~106-bit precision so
//                zooms past 1e-15 do not collapse into Float64 ULP noise.
//              • §30     — `buildFractalLUT(+Chunked)` authors DataTexture-ready RGBA
//                buffers (escape-time, Newton, or DE) with zero per-pixel allocation.
//              • §34     — Roots of unity, tetrahedron folds, and turtle constants are
//                pre-allocated module tables.
//              • §45/§51 — `createJuliaMorph` / `createFractalAnimator` advance the Julia
//                parameter on a FIXED timestep, plus a re-exported
//                `createFixedStepScheduler` (spiral-of-death guarded accumulator).
//              • §49     — `fractalBatchToTransferable` / `fractalBatchFromTransferable`
//                pack a batch into ONE ArrayBuffer for zero-copy Worker transfer.
//              • Precision — `trackFractal` / `migrateFractal` / `migrateAllFractals` and
//                an `onPrecisionChange` listener migrate batch buffers live; scratch
//                pools rebuild at switch time, never in the frame loop.
//####
//Best for : 3d graphics — procedural terrain with self-similar mountains (Sierpinski /
//           Mandelbulb heightfields), hierarchical star-cluster spawning (L-system trees →
//           galaxies), procedural cave / rock formations (Mandelbox DE for raymarching),
//           infinite-fractal billboards in 1M+ instanced scenes, orbital-trail generation
//           with dragon-curve / Koch patterns, IK bone chains following fern-like
//           branching, cloud / smoke volumetric fields from Mandelbulb distance
//           estimators, HDR palettes driven by escape times, animated Julia morphs per
//           instance at 60 fps, and seamless small-to-galactic evaluation via the
//           double-single deep-zoom bridge.
//License : MIT

// ============================================================================
// Imports — ESM named imports from the unified math entry point
// ============================================================================
import {
    common,
    vec2,
    vec3,
    vec4,
    createVec3SOA,
    createVec4SOA,
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getArrayType,
    createFixedStepScheduler
} from "./000_Math_module.js";

export const VERSION = "1.1.0-esm";

export {
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getArrayType,
    createFixedStepScheduler
};

// ============================================================================
// Constants — pre-allocated, never rebuilt (Blueprint §34)
// ============================================================================
const PI = Math.PI;
const TAU = PI * 2;
const HALF_PI = PI * 0.5;
const SQRT3 = Math.sqrt(3);
const EPSILON = 1e-9;
const LN2 = Math.LN2;
const INV_LN2 = 1 / LN2;
const MAX_LSYSTEM_LENGTH = 2000000;

// Cube roots of unity for the Newton fractal (hoisted — never recomputed per pixel).
const ROOT3_X = new Float64Array([1, -0.5, -0.5]);
const ROOT3_Y = new Float64Array([0, SQRT3 * 0.5, -SQRT3 * 0.5]);

// Barnsley fern IFS coefficients, flattened [a,b,c,d,e,f] per transform.
const FERN_MAPS = new Float64Array([
    0.00, 0.00, 0.00, 0.16, 0.00, 0.00,
    0.85, 0.04, -0.04, 0.85, 0.00, 1.60,
    0.20, -0.26, 0.23, 0.22, 0.00, 1.60,
    -0.15, 0.28, 0.26, 0.24, 0.00, 0.44
]);
const FERN_CDF = new Float64Array([0.01, 0.86, 0.93, 1.0]);

// Escape-time operator ids (resolved ONCE outside every hot loop).
export const FRACTAL_MANDELBROT = 0;
export const FRACTAL_JULIA = 1;
export const FRACTAL_BURNING_SHIP = 2;
export const FRACTAL_MULTIBROT = 3;
export const FRACTAL_NEWTON = 4;
export const FRACTAL_TRICORN = 5;

// Distance-estimator ids.
export const DE_MANDELBULB = 0;
export const DE_MANDELBOX = 1;
export const DE_JULIA_QUAT = 2;
export const DE_SIERPINSKI = 3;
export const DE_MENGER = 4;

// L-system presets — deterministic, no trailing whitespace in any rule.
export const LSYSTEM_PRESETS = {
    kochSnowflake: {
        axiom: "F--F--F",
        rules: [{ from: "F", to: "F+F--F+F" }],
        angle: PI / 3,
        iterations: 4
    },
    sierpinskiTriangle: {
        axiom: "F-G-G",
        rules: [{ from: "F", to: "F-G+F+G-F" }, { from: "G", to: "GG" }],
        angle: (2 * PI) / 3,
        iterations: 6
    },
    dragonCurve: {
        axiom: "FX",
        rules: [{ from: "X", to: "X+YF+" }, { from: "Y", to: "-FX-Y" }],
        angle: PI / 2,
        iterations: 10
    },
    plant3D: {
        axiom: "X",
        rules: [{ from: "X", to: "F+[[X]-X]-F[-FX]+X" }, { from: "F", to: "FF" }],
        angle: PI / 7,
        iterations: 5
    },
    plant3DRoll: {
        axiom: "X",
        rules: [{ from: "X", to: "F[&+X][&-X][^\\X][^/X]FX" }, { from: "F", to: "FF" }],
        angle: PI / 6,
        iterations: 4
    },
    hilbert: {
        axiom: "A",
        rules: [{ from: "A", to: "-BF+AFA+FB-" }, { from: "B", to: "+AF-BFB-FA+" }],
        angle: PI / 2,
        iterations: 5
    }
};

// ============================================================================
// Module scratch — allocated once, reused by every hot path (Zero-GC)
// ============================================================================
const _ds2 = new Float64Array(2);
const _dsA = new Float64Array(2);
const _dsB = new Float64Array(2);
const _dsC = new Float64Array(2);
const _dsD = new Float64Array(2);
const _tv = new Float64Array(3);
const _iter3 = new Float64Array(3);
const _newton2 = new Float64Array(2);

let _ifsStack = new Float64Array(4096);
let _turtleStack = new Float64Array(14 * 256);
let _treeStack = new Float64Array(8 * 512);
let _kochScratch = new Float64Array(2048);
let _gasketStack = new Float64Array(13 * 1024);

function _ensureStack(buf, need) {
    if (buf.length >= need) return buf;
    let n = buf.length;
    while (n < need) n *= 2;
    return new Float64Array(n);
}

// ============================================================================
// Small helpers
// ============================================================================
function clamp1(v) { return v < -1 ? -1 : (v > 1 ? 1 : v); }
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function _isArr(t) { return t != null && t.length !== undefined; }

function _pow2i(n) { let v = 1; for (let i = 0; i < n; i++) v *= 2; return v; }
function _powi(base, n) { let v = 1; for (let i = 0; i < n; i++) v *= base; return v; }

/** Smooth escape value in [0,1] from the final squared radius. */
function _smoothValue(i, r2, maxIter, power) {
    const logZn = 0.5 * Math.log(r2);
    const nu = Math.log(logZn * INV_LN2) * INV_LN2;
    const denom = power > 1 ? Math.log(power) : LN2;
    const v = (i + 1 - Math.log(logZn) / denom + nu * 0) / maxIter;
    return clamp01(v);
}

// ============================================================================
// 2D escape-time fractals
// ============================================================================
/** Classic Mandelbrot escape iteration (maxIter if the point is inside). */
export function mandelbrot(cx, cy, maxIter) {
    maxIter = maxIter || 256;
    let zx = 0, zy = 0;
    for (let i = 0; i < maxIter; i++) {
        const zx2 = zx * zx, zy2 = zy * zy;
        if (zx2 + zy2 > 4) return i;
        zy = 2 * zx * zy + cy;
        zx = zx2 - zy2 + cx;
    }
    return maxIter;
}

/** Smooth-coloured Mandelbrot in [0,1] — banding-free HDR palette input. */
export function mandelbrotSmooth(cx, cy, maxIter) {
    maxIter = maxIter || 256;
    let zx = 0, zy = 0;
    for (let i = 0; i < maxIter; i++) {
        const zx2 = zx * zx, zy2 = zy * zy;
        const r2 = zx2 + zy2;
        if (r2 > 4) {
            const logZn = 0.5 * Math.log(r2);
            const nu = Math.log(logZn * INV_LN2) * INV_LN2;
            return clamp01((i + 1 - nu) / maxIter);
        }
        zy = 2 * zx * zy + cy;
        zx = zx2 - zy2 + cx;
    }
    return 1;
}

/** Julia set — (cx,cy) is the constant, (jx,jy) the sample point. */
export function julia(cx, cy, jx, jy, maxIter) {
    maxIter = maxIter || 256;
    let zx = jx, zy = jy;
    for (let i = 0; i < maxIter; i++) {
        const zx2 = zx * zx, zy2 = zy * zy;
        if (zx2 + zy2 > 4) return i;
        zy = 2 * zx * zy + cy;
        zx = zx2 - zy2 + cx;
    }
    return maxIter;
}

export function juliaSmooth(cx, cy, jx, jy, maxIter) {
    maxIter = maxIter || 256;
    let zx = jx, zy = jy;
    for (let i = 0; i < maxIter; i++) {
        const zx2 = zx * zx, zy2 = zy * zy;
        const r2 = zx2 + zy2;
        if (r2 > 4) {
            const logZn = 0.5 * Math.log(r2);
            const nu = Math.log(logZn * INV_LN2) * INV_LN2;
            return clamp01((i + 1 - nu) / maxIter);
        }
        zy = 2 * zx * zy + cy;
        zx = zx2 - zy2 + cx;
    }
    return 1;
}

/** Burning Ship — |Re|, |Im| variant. */
export function burningShip(cx, cy, maxIter) {
    maxIter = maxIter || 256;
    let zx = 0, zy = 0;
    for (let i = 0; i < maxIter; i++) {
        const ax = zx < 0 ? -zx : zx;
        const ay = zy < 0 ? -zy : zy;
        const ax2 = ax * ax, ay2 = ay * ay;
        if (ax2 + ay2 > 4) return i;
        zy = 2 * ax * ay + cy;
        zx = ax2 - ay2 + cx;
    }
    return maxIter;
}

/** Multibrot — z → z^d + c for any positive integer degree d. */
export function multibrot(cx, cy, d, maxIter) {
    maxIter = maxIter || 256;
    d = d || 2;
    if (d === 2) return mandelbrot(cx, cy, maxIter);
    let zx = 0, zy = 0;
    for (let i = 0; i < maxIter; i++) {
        const r2 = zx * zx + zy * zy;
        if (r2 > 4) return i;
        const theta = Math.atan2(zy, zx);
        const r = Math.pow(r2, d * 0.5);
        zx = r * Math.cos(d * theta) + cx;
        zy = r * Math.sin(d * theta) + cy;
    }
    return maxIter;
}

/** Tricorn (Mandelbar) — z → conj(z)² + c. */
export function tricorn(cx, cy, maxIter) {
    maxIter = maxIter || 256;
    let zx = 0, zy = 0;
    for (let i = 0; i < maxIter; i++) {
        const zx2 = zx * zx, zy2 = zy * zy;
        if (zx2 + zy2 > 4) return i;
        zy = -2 * zx * zy + cy;
        zx = zx2 - zy2 + cx;
    }
    return maxIter;
}

/**
 * Newton fractal on z³ − 1.
 * CORRECTED: roots hoisted to constants; `*Into` form allocates nothing.
 * out2 = [rootIndex (0..2, −1 = no convergence), iterations].
 */
export function newtonFractalInto(out2, cx, cy, maxIter) {
    maxIter = maxIter || 64;
    let zx = cx, zy = cy;
    for (let i = 0; i < maxIter; i++) {
        const zx2 = zx * zx, zy2 = zy * zy;
        const fx = zx * (zx2 - 3 * zy2) - 1;
        const fy = zy * (3 * zx2 - zy2);
        if (fx * fx + fy * fy < 1e-12) {
            let best = 0, bestD = Infinity;
            for (let r = 0; r < 3; r++) {
                const dx = zx - ROOT3_X[r], dy = zy - ROOT3_Y[r];
                const d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; best = r; }
            }
            out2[0] = best; out2[1] = i;
            return out2;
        }
        const dfx = 3 * (zx2 - zy2);
        const dfy = 6 * zx * zy;
        const denom = dfx * dfx + dfy * dfy;
        if (denom < 1e-30) { out2[0] = -1; out2[1] = i; return out2; }
        const rx = (fx * dfx + fy * dfy) / denom;
        const ry = (fy * dfx - fx * dfy) / denom;
        zx -= rx; zy -= ry;
    }
    out2[0] = -1; out2[1] = maxIter;
    return out2;
}
export function createNewtonResult() { return { root: -1, iterations: 0 }; }
/** Object form. Pass `result` to reuse it; omitting it allocates (setup only). */
export function newtonFractal(cx, cy, maxIter, result) {
    newtonFractalInto(_newton2, cx, cy, maxIter);
    const r = result || { root: -1, iterations: 0 };
    r.root = _newton2[0]; r.iterations = _newton2[1];
    return r;
}

/** Resolve an escape-time operator name to an integer id (hoist out of loops). */
export function resolveFractalKind(kind) {
    if (typeof kind === "number") return kind | 0;
    switch (String(kind || "mandelbrot")) {
        case "julia": return FRACTAL_JULIA;
        case "burningShip": case "burning-ship": return FRACTAL_BURNING_SHIP;
        case "multibrot": return FRACTAL_MULTIBROT;
        case "newton": return FRACTAL_NEWTON;
        case "tricorn": return FRACTAL_TRICORN;
        default: return FRACTAL_MANDELBROT;
    }
}
function _escapeById(id, cx, cy, jx, jy, d, maxIter) {
    switch (id) {
        case FRACTAL_JULIA: return julia(cx, cy, jx, jy, maxIter);
        case FRACTAL_BURNING_SHIP: return burningShip(jx, jy, maxIter);
        case FRACTAL_MULTIBROT: return multibrot(jx, jy, d, maxIter);
        case FRACTAL_TRICORN: return tricorn(jx, jy, maxIter);
        case FRACTAL_NEWTON: newtonFractalInto(_newton2, jx, jy, maxIter); return _newton2[1];
        default: return mandelbrot(jx, jy, maxIter);
    }
}

// ============================================================================
// 3D distance-estimator fractals (SDF)
// ============================================================================
/**
 * Mandelbulb distance estimator (power 8 by default).
 * CORRECTED: `acos` argument clamped (NaN at the poles), `log` guarded, and
 * the running derivative floored so the estimate never divides by zero.
 */
export function mandelbulbDE(x, y, z, iterations, power, scale) {
    iterations = iterations || 8;
    power = power || 8;
    scale = scale || 1;
    x /= scale; y /= scale; z /= scale;
    let zx = x, zy = y, zz = z;
    let dr = 1, r = 0;
    for (let i = 0; i < iterations; i++) {
        r = Math.sqrt(zx * zx + zy * zy + zz * zz);
        if (r > 2) break;
        const invR = r > EPSILON ? 1 / r : 0;
        const theta = Math.acos(clamp1(zz * invR)) * power;
        const phi = Math.atan2(zy, zx) * power;
        const rp = Math.pow(r, power - 1);
        dr = rp * power * dr + 1;
        const zr = rp * r;
        const st = Math.sin(theta);
        zx = zr * st * Math.cos(phi) + x;
        zy = zr * st * Math.sin(phi) + y;
        zz = zr * Math.cos(theta) + z;
    }
    r = Math.sqrt(zx * zx + zy * zy + zz * zz);
    if (dr < EPSILON) dr = EPSILON;
    const rr = r < EPSILON ? EPSILON : r;
    return 0.5 * Math.log(rr) * rr / dr * scale;
}

/**
 * Mandelbulb orbit trap. `*Into` form allocates nothing.
 * out3 = [iterations, minSquaredRadius, escaped ? 1 : 0].
 */
export function mandelbulbIterInto(out3, x, y, z, iterations, power) {
    iterations = iterations || 8;
    power = power || 8;
    let zx = x, zy = y, zz = z;
    let trap = Infinity;
    let i = 0;
    for (; i < iterations; i++) {
        const r2 = zx * zx + zy * zy + zz * zz;
        if (r2 > 4) { out3[0] = i; out3[1] = trap === Infinity ? 0 : trap; out3[2] = 1; return out3; }
        if (r2 < trap) trap = r2;
        const r = Math.sqrt(r2);
        const invR = r > EPSILON ? 1 / r : 0;
        const theta = Math.acos(clamp1(zz * invR)) * power;
        const phi = Math.atan2(zy, zx) * power;
        const zr = Math.pow(r, power);
        const st = Math.sin(theta);
        zx = zr * st * Math.cos(phi) + x;
        zy = zr * st * Math.sin(phi) + y;
        zz = zr * Math.cos(theta) + z;
    }
    out3[0] = i; out3[1] = trap === Infinity ? 0 : trap; out3[2] = 0;
    return out3;
}
export function createMandelbulbResult() { return { iterations: 0, trap: 0, escaped: false }; }
/** Object form. Pass `result` to reuse it; omitting it allocates (setup only). */
export function mandelbulbIter(x, y, z, iterations, power, result) {
    mandelbulbIterInto(_iter3, x, y, z, iterations, power);
    const r = result || { iterations: 0, trap: 0, escaped: false };
    r.iterations = _iter3[0]; r.trap = _iter3[1]; r.escaped = _iter3[2] === 1;
    return r;
}

function boxFold(v) {
    if (v > 1) return 2 - v;
    if (v < -1) return -2 - v;
    return v;
}

/**
 * Mandelbox DE — box folds + sphere folds.
 * CORRECTED: the inner sphere fold now uses fixedRadius²/minRadius² (it
 * previously ignored `fixedRadius`), and the estimate divides by |dr|.
 */
export function mandelboxDE(x, y, z, iterations, scaleParam, fixedRadius) {
    iterations = iterations || 10;
    scaleParam = scaleParam === undefined ? 2.5 : scaleParam;
    fixedRadius = fixedRadius === undefined ? 1 : fixedRadius;
    const fixedR2 = fixedRadius * fixedRadius;
    const minR2 = fixedR2 * 0.25;
    const absScale = Math.abs(scaleParam);
    let wx = x, wy = y, wz = z;
    let dr = 1;
    for (let i = 0; i < iterations; i++) {
        wx = boxFold(wx); wy = boxFold(wy); wz = boxFold(wz);
        const r2 = wx * wx + wy * wy + wz * wz;
        let t = 1;
        if (r2 < minR2) t = fixedR2 / minR2;
        else if (r2 < fixedR2) t = fixedR2 / (r2 > EPSILON ? r2 : EPSILON);
        wx *= t; wy *= t; wz *= t; dr *= t;
        wx = wx * scaleParam + x;
        wy = wy * scaleParam + y;
        wz = wz * scaleParam + z;
        dr = dr * absScale + 1;
    }
    const len = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const ad = Math.abs(dr);
    return len / (ad < EPSILON ? EPSILON : ad);
}

/**
 * Quaternion Julia DE.
 * CORRECTED: the running derivative accumulates (`dr = 2*r*dr`) instead of
 * being reset each iteration, which previously produced a wrong estimate.
 */
export function juliaQuatDE(x, y, z, cx, cy, cz, cw, iterations, scale) {
    iterations = iterations || 8;
    scale = scale || 1;
    x /= scale; y /= scale; z /= scale;
    let zx = x, zy = y, zz = z, zw = 0;
    let dr = 1, r = 0;
    for (let i = 0; i < iterations; i++) {
        r = Math.sqrt(zx * zx + zy * zy + zz * zz + zw * zw);
        if (r > 4) break;
        dr = 2 * r * dr;
        if (dr < EPSILON) dr = EPSILON;
        const nx = zx * zx - zy * zy - zz * zz - zw * zw + cx;
        const ny = 2 * zx * zy + cy;
        const nz = 2 * zx * zz + cz;
        const nw = 2 * zx * zw + cw;
        zx = nx; zy = ny; zz = nz; zw = nw;
    }
    r = Math.sqrt(zx * zx + zy * zy + zz * zz + zw * zw);
    const rr = r < EPSILON ? EPSILON : r;
    if (dr < EPSILON) dr = EPSILON;
    return 0.5 * Math.log(rr) * rr / dr * scale;
}

/** Sierpinski tetrahedron DE — folding IFS with scale 2. */
export function sierpinskiTetraDE(x, y, z, iterations, scale) {
    iterations = iterations || 8;
    scale = scale || 1;
    x /= scale; y /= scale; z /= scale;
    let t;
    for (let i = 0; i < iterations; i++) {
        if (x + y < 0) { t = -y; y = -x; x = t; }
        if (x + z < 0) { t = -z; z = -x; x = t; }
        if (y + z < 0) { t = -z; z = -y; y = t; }
        x = x * 2 - 1; y = y * 2 - 1; z = z * 2 - 1;
    }
    return (Math.sqrt(x * x + y * y + z * z) - 1) * Math.pow(2, -iterations) * scale;
}

/**
 * Menger sponge DE.
 * CORRECTED: the previous version assigned x = y = z = p, collapsing the
 * fractal onto a diagonal. This is the correct abs-fold / descending-sort /
 * `p*3 − 2` / z-fold IFS with the `3^-iterations` distance scaling.
 */
export function mengerSpongeDE(x, y, z, iterations, scale) {
    iterations = iterations || 5;
    scale = scale || 1;
    x = Math.abs(x / scale); y = Math.abs(y / scale); z = Math.abs(z / scale);
    let t;
    for (let i = 0; i < iterations; i++) {
        if (x < y) { t = x; x = y; y = t; }
        if (x < z) { t = x; x = z; z = t; }
        if (y < z) { t = y; y = z; z = t; }
        x = x * 3 - 2; y = y * 3 - 2; z = z * 3 - 2;
        if (z < -1) z += 2;
    }
    return (Math.sqrt(x * x + y * y + z * z) - 2) * Math.pow(3, -iterations) * scale;
}

export function resolveDEKind(kind) {
    if (typeof kind === "number") return kind | 0;
    switch (String(kind || "mandelbulb")) {
        case "mandelbox": return DE_MANDELBOX;
        case "juliaQuat": case "julia-quat": return DE_JULIA_QUAT;
        case "sierpinski": case "sierpinskiTetra": return DE_SIERPINSKI;
        case "menger": case "mengerSponge": return DE_MENGER;
        default: return DE_MANDELBULB;
    }
}

// ============================================================================
// Double-single deep-zoom bridge (Blueprint §26)
// ============================================================================
/** out2 = [hi, lo] of a + b, renormalized with a full TwoSum. */
export function dsAddInto(out2, a, b) {
    const s = a + b;
    const bb = s - a;
    out2[0] = s;
    out2[1] = (a - (s - bb)) + (b - bb);
    return out2;
}
/** out2 = (aHi,aLo) + (bHi,bLo), renormalized. */
export function dsAdd22Into(out2, aHi, aLo, bHi, bLo) {
    dsAddInto(_dsC, aHi, bHi);
    dsAddInto(_dsD, aLo, bLo);
    const c = _dsC[1] + _dsD[0];
    dsAddInto(out2, _dsC[0], c + _dsD[1]);
    return out2;
}
/** out2 = (aHi,aLo) − (bHi,bLo), renormalized. */
export function dsSub22Into(out2, aHi, aLo, bHi, bLo) {
    return dsAdd22Into(out2, aHi, aLo, -bHi, -bLo);
}
/** out2 = (aHi,aLo) * (bHi,bLo) via Dekker split, renormalized. */
export function dsMul22Into(out2, aHi, aLo, bHi, bLo) {
    const SPLIT = 134217729;
    const p = aHi * bHi;
    const ta = SPLIT * aHi, tb = SPLIT * bHi;
    let lo = 0;
    if (isFinite(ta) && isFinite(tb)) {
        const ah = ta + (aHi - ta), al = aHi - ah;
        const bh = tb + (bHi - tb), bl = bHi - bh;
        lo = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    }
    lo += aHi * bLo + aLo * bHi;
    dsAddInto(out2, p, lo);
    return out2;
}
/** out2 = (aHi,aLo) * 2 (exact). */
function _dsDouble(out2, hi, lo) { out2[0] = hi * 2; out2[1] = lo * 2; return out2; }

/**
 * Deep-zoom Mandelbrot in double-single (~106-bit) arithmetic.
 * `c` is supplied as hi/lo pairs so zooms past 1e-15 stay structurally exact.
 * Roughly 20× slower than `mandelbrot` — use only for deep zoom tiles.
 */
export function mandelbrotDS(cxHi, cxLo, cyHi, cyLo, maxIter) {
    maxIter = maxIter || 512;
    let zxH = 0, zxL = 0, zyH = 0, zyL = 0;
    for (let i = 0; i < maxIter; i++) {
        const mag = zxH * zxH + zyH * zyH;
        if (mag > 4) return i;
        dsMul22Into(_dsA, zxH, zxL, zxH, zxL);       // zx²
        dsMul22Into(_dsB, zyH, zyL, zyH, zyL);       // zy²
        dsMul22Into(_dsC, zxH, zxL, zyH, zyL);       // zx·zy
        _dsDouble(_dsD, _dsC[0], _dsC[1]);           // 2·zx·zy
        dsAdd22Into(_dsC, _dsD[0], _dsD[1], cyHi, cyLo);
        dsSub22Into(_dsD, _dsA[0], _dsA[1], _dsB[0], _dsB[1]);
        dsAdd22Into(_dsA, _dsD[0], _dsD[1], cxHi, cxLo);
        zxH = _dsA[0]; zxL = _dsA[1];
        zyH = _dsC[0]; zyL = _dsC[1];
    }
    return maxIter;
}

/**
 * Exact double-single coordinate for a deep-zoom pixel:
 * c = centre + (pixelOffset * scale), computed with TwoProd + TwoSum so the
 * tiny pixel delta is never swallowed by the large centre before the cast.
 * out4 = [cxHi, cxLo, cyHi, cyLo].
 */
export function deepZoomCoord(out4, centerHiX, centerLoX, centerHiY, centerLoY, px, py, scale) {
    const SPLIT = 134217729;
    const ox = px * scale, oy = py * scale;
    let lo = 0;
    const ta = SPLIT * px, tb = SPLIT * scale;
    if (isFinite(ta) && isFinite(tb)) {
        const ah = ta + (px - ta), al = px - ah;
        const bh = tb + (scale - tb), bl = scale - bh;
        lo = ((ah * bh - ox) + ah * bl + al * bh) + al * bl;
    }
    dsAdd22Into(_dsA, centerHiX, centerLoX, ox, lo);
    out4[0] = _dsA[0]; out4[1] = _dsA[1];
    const tc = SPLIT * py;
    lo = 0;
    if (isFinite(tc) && isFinite(tb)) {
        const ah = tc + (py - tc), al = py - ah;
        const bh = tb + (scale - tb), bl = scale - bh;
        lo = ((ah * bh - oy) + ah * bl + al * bh) + al * bl;
    }
    dsAdd22Into(_dsB, centerHiY, centerLoY, oy, lo);
    out4[2] = _dsB[0]; out4[3] = _dsB[1];
    return out4;
}

// ============================================================================
// Iterated function systems — exact counts, direct typed-array fills
// ============================================================================
/** Exact float count for a Sierpinski triangle of the given depth. */
export function sierpinskiTriangleCount(iterations) { return _powi(3, iterations) * 6; }

/** Sierpinski triangle → flat [x1,y1,x2,y2,x3,y3, …]. Zero per-node allocation. */
export function sierpinskiTriangleInto(out, offset, iterations, size) {
    iterations = iterations || 6;
    size = size === undefined ? 1 : size;
    offset = offset || 0;
    const need = 7 * (2 * iterations + 2);
    _ifsStack = _ensureStack(_ifsStack, need);
    const st = _ifsStack;
    let sp = 0, o = offset;
    st[sp++] = 0; st[sp++] = 0;
    st[sp++] = size; st[sp++] = 0;
    st[sp++] = size * 0.5; st[sp++] = size * SQRT3 * 0.5;
    st[sp++] = iterations;
    while (sp > 0) {
        const level = st[--sp];
        const x3 = st[--sp], y3 = st[--sp];
        const x2 = st[--sp], y2 = st[--sp];
        const x1 = st[--sp], y1 = st[--sp];
        if (level <= 0) {
            out[o++] = x1; out[o++] = y1;
            out[o++] = x2; out[o++] = y2;
            out[o++] = x3; out[o++] = y3;
            continue;
        }
        const mx12 = (x1 + x2) * 0.5, my12 = (y1 + y2) * 0.5;
        const mx23 = (x2 + x3) * 0.5, my23 = (y2 + y3) * 0.5;
        const mx13 = (x1 + x3) * 0.5, my13 = (y1 + y3) * 0.5;
        const nl = level - 1;
        st[sp++] = mx13; st[sp++] = my13; st[sp++] = mx23; st[sp++] = my23;
        st[sp++] = x3; st[sp++] = y3; st[sp++] = nl;
        st[sp++] = mx12; st[sp++] = my12; st[sp++] = x2; st[sp++] = y2;
        st[sp++] = mx23; st[sp++] = my23; st[sp++] = nl;
        st[sp++] = x1; st[sp++] = y1; st[sp++] = mx12; st[sp++] = my12;
        st[sp++] = mx13; st[sp++] = my13; st[sp++] = nl;
    }
    return o - offset;
}
export function sierpinskiTriangle(iterations, size) {
    iterations = iterations || 6;
    const out = new Float32Array(sierpinskiTriangleCount(iterations));
    sierpinskiTriangleInto(out, 0, iterations, size);
    return out;
}

export function sierpinskiCarpetCount(iterations) { return _powi(8, iterations) * 3; }
/** Sierpinski carpet → flat [x, y, size, …] quads. */
export function sierpinskiCarpetInto(out, offset, iterations, size) {
    iterations = iterations || 4;
    size = size === undefined ? 1 : size;
    offset = offset || 0;
    _ifsStack = _ensureStack(_ifsStack, 4 * (2 * iterations + 2));
    const st = _ifsStack;
    let sp = 0, o = offset;
    st[sp++] = 0; st[sp++] = 0; st[sp++] = size; st[sp++] = iterations;
    while (sp > 0) {
        const level = st[--sp];
        const s = st[--sp], y = st[--sp], x = st[--sp];
        if (level === 0) { out[o++] = x; out[o++] = y; out[o++] = s; continue; }
        const s3 = s / 3, nl = level - 1;
        for (let j = 2; j >= 0; j--) {
            for (let i = 2; i >= 0; i--) {
                if (i === 1 && j === 1) continue;
                st[sp++] = x + i * s3; st[sp++] = y + j * s3; st[sp++] = s3; st[sp++] = nl;
            }
        }
    }
    return o - offset;
}
export function sierpinskiCarpet(iterations, size) {
    iterations = iterations || 4;
    const out = new Float32Array(sierpinskiCarpetCount(iterations));
    sierpinskiCarpetInto(out, 0, iterations, size);
    return out;
}

export function kochSnowflakeCount(iterations) { return 3 * _powi(4, iterations) * 2; }
/** Koch snowflake boundary → flat [x, y, …]. */
export function kochSnowflakeInto(out, offset, iterations, size) {
    iterations = iterations || 4;
    size = size === undefined ? 1 : size;
    offset = offset || 0;
    const total = 3 * _powi(4, iterations);
    _kochScratch = _ensureStack(_kochScratch, total * 2);
    let src = out, dst = _kochScratch, srcOff = offset;
    src[srcOff] = 0; src[srcOff + 1] = 0;
    src[srcOff + 2] = size; src[srcOff + 3] = 0;
    src[srcOff + 4] = size * 0.5; src[srcOff + 5] = size * SQRT3 * 0.5;
    let n = 3;
    for (let it = 0; it < iterations; it++) {
        let w = 0;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const x1 = src[srcOff + i * 2], y1 = src[srcOff + i * 2 + 1];
            const x2 = src[srcOff + j * 2], y2 = src[srcOff + j * 2 + 1];
            const dx = x2 - x1, dy = y2 - y1;
            dst[w++] = x1; dst[w++] = y1;
            dst[w++] = x1 + dx / 3; dst[w++] = y1 + dy / 3;
            dst[w++] = (x1 + x2) * 0.5 - dy * SQRT3 / 6;
            dst[w++] = (y1 + y2) * 0.5 + dx * SQRT3 / 6;
            dst[w++] = x1 + 2 * dx / 3; dst[w++] = y1 + 2 * dy / 3;
        }
        n *= 4;
        if (dst === _kochScratch) {
            for (let k = 0; k < w; k++) src[srcOff + k] = dst[k];
            dst = _kochScratch;
        }
    }
    return n * 2;
}
export function kochSnowflake(iterations, size) {
    iterations = iterations || 4;
    const out = new Float32Array(kochSnowflakeCount(iterations));
    kochSnowflakeInto(out, 0, iterations, size);
    return out;
}

export function dragonCurveCount(iterations) { return (_pow2i(iterations) + 1) * 2; }
/** Dragon curve → flat [x, y, …], normalized to `size`. */
export function dragonCurve(iterations, size) {
    iterations = iterations || 10;
    size = size === undefined ? 1 : size;
    const total = _pow2i(iterations) + 1;
    const out = new Float32Array(total * 2);
    out[0] = 0; out[1] = 0; out[2] = 1; out[3] = 0;
    let n = 2;
    const ca = 0, sa = 1; // cos(π/2), sin(π/2) — exact
    for (let it = 0; it < iterations; it++) {
        let x = out[(n - 1) * 2], y = out[(n - 1) * 2 + 1];
        let w = n * 2;
        for (let i = n - 2; i >= 0; i--) {
            const px = out[i * 2], py = out[i * 2 + 1];
            const dx = x - px, dy = y - py;
            const rx = dx * ca - dy * sa;
            const ry = dx * sa + dy * ca;
            x = px + rx; y = py + ry;
            out[w++] = x; out[w++] = y;
        }
        n = n * 2 - 1;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        const x = out[i * 2], y = out[i * 2 + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const s = size / span;
    for (let i = 0; i < n; i++) {
        out[i * 2] = (out[i * 2] - minX) * s;
        out[i * 2 + 1] = (out[i * 2 + 1] - minY) * s;
    }
    return out;
}

export function cantorSetCount(iterations) { return _pow2i(iterations) * 4; }
/** Cantor set → flat [x1,y1,x2,y2, …] segment endpoints. */
export function cantorSetInto(out, offset, iterations, size) {
    iterations = iterations || 5;
    size = size === undefined ? 1 : size;
    offset = offset || 0;
    _ifsStack = _ensureStack(_ifsStack, 3 * (iterations + 2));
    const st = _ifsStack;
    let sp = 0, o = offset;
    st[sp++] = 0; st[sp++] = size; st[sp++] = iterations;
    while (sp > 0) {
        const level = st[--sp];
        const x2 = st[--sp], x1 = st[--sp];
        if (level === 0) { out[o++] = x1; out[o++] = 0; out[o++] = x2; out[o++] = 0; continue; }
        const third = (x2 - x1) / 3, nl = level - 1;
        st[sp++] = x2 - third; st[sp++] = x2; st[sp++] = nl;
        st[sp++] = x1; st[sp++] = x1 + third; st[sp++] = nl;
    }
    return o - offset;
}
export function cantorSet(iterations, size) {
    iterations = iterations || 5;
    const out = new Float32Array(cantorSetCount(iterations));
    cantorSetInto(out, 0, iterations, size);
    return out;
}

export function cantorDust3DCount(iterations, mode) {
    return _powi(mode === "corners" ? 8 : 20, iterations) * 4;
}
/** 3D Cantor dust / Menger skeleton → flat [x, y, z, size, …] boxes. */
export function cantorDust3DInto(out, offset, iterations, size, mode) {
    iterations = iterations || 3;
    size = size === undefined ? 1 : size;
    offset = offset || 0;
    const corners = mode === "corners";
    _ifsStack = _ensureStack(_ifsStack, 5 * (20 * iterations + 2));
    const st = _ifsStack;
    let sp = 0, o = offset;
    st[sp++] = 0; st[sp++] = 0; st[sp++] = 0; st[sp++] = size; st[sp++] = iterations;
    while (sp > 0) {
        const level = st[--sp];
        const s = st[--sp], z = st[--sp], y = st[--sp], x = st[--sp];
        if (level === 0) { out[o++] = x; out[o++] = y; out[o++] = z; out[o++] = s; continue; }
        const s3 = s / 3, nl = level - 1;
        for (let k = 2; k >= 0; k--) {
            for (let j = 2; j >= 0; j--) {
                for (let i = 2; i >= 0; i--) {
                    const mids = (i === 1 ? 1 : 0) + (j === 1 ? 1 : 0) + (k === 1 ? 1 : 0);
                    if (corners ? mids > 0 : mids > 1) continue;
                    st[sp++] = x + i * s3; st[sp++] = y + j * s3; st[sp++] = z + k * s3;
                    st[sp++] = s3; st[sp++] = nl;
                }
            }
        }
    }
    return o - offset;
}
export function cantorDust3D(iterations, size, mode) {
    iterations = iterations || 3;
    const out = new Float32Array(cantorDust3DCount(iterations, mode));
    cantorDust3DInto(out, 0, iterations, size, mode);
    return out;
}

/** Barnsley fern IFS — writes flat [x,y,…]; deterministic with a supplied rng. */
export function barnsleyFern(count, out, rng) {
    rng = rng || Math.random;
    out = out || new Float32Array(count * 2);
    let x = 0, y = 0;
    for (let i = 0; i < count; i++) {
        const r = rng();
        let m = 0;
        if (r >= FERN_CDF[2]) m = 3;
        else if (r >= FERN_CDF[1]) m = 2;
        else if (r >= FERN_CDF[0]) m = 1;
        const o = m * 6;
        const nx = FERN_MAPS[o] * x + FERN_MAPS[o + 1] * y + FERN_MAPS[o + 4];
        const ny = FERN_MAPS[o + 2] * x + FERN_MAPS[o + 3] * y + FERN_MAPS[o + 5];
        x = nx; y = ny;
        out[i * 2] = x; out[i * 2 + 1] = y;
    }
    return out;
}

export function apollonianGasketCount(iterations) {
    return 4 + 4 * ((_powi(3, iterations) - 1) / 2);
}
/**
 * TRUE Apollonian gasket via Descartes quadruple reflection.
 * CORRECTED: the previous version placed three naive tangent circles and
 * called it Descartes. This is the exact reflection identity:
 *   k_i' = 2·Σ_{j≠i} k_j − k_i
 *   z_i'·k_i' = 2·Σ_{j≠i} z_j·k_j − z_i·k_i
 * No square roots, no per-node allocation. out = flat [cx, cy, r, …].
 * Returns the number of circles written.
 */
export function apollonianGasketInto(out, offset, iterations, cx, cy, r, maxCircles) {
    iterations = iterations === undefined ? 4 : iterations;
    cx = cx || 0; cy = cy || 0; r = r === undefined ? 1 : r;
    offset = offset || 0;
    const cap = maxCircles === undefined ? ((out.length - offset) / 3) | 0 : maxCircles;
    if (cap < 4) return 0;
    const inv = 1 / r;
    // Seed quadruple: enclosing circle + two halves + one third-circle.
    const k0 = -inv, x0 = cx, y0 = cy;
    const k1 = 2 * inv, x1 = cx - r * 0.5, y1 = cy;
    const k2 = 2 * inv, x2 = cx + r * 0.5, y2 = cy;
    const k3 = 3 * inv, x3 = cx, y3 = cy + r * (2 / 3);
    let o = offset, written = 0;
    function emit(k, zx, zy) {
        if (written >= cap) return;
        out[o++] = zx; out[o++] = zy; out[o++] = Math.abs(1 / k);
        written++;
    }
    emit(k0, x0, y0); emit(k1, x1, y1); emit(k2, x2, y2); emit(k3, x3, y3);
    if (iterations <= 0 || written >= cap) return written;

    const need = 13 * (4 * _powi(3, iterations) + 8);
    _gasketStack = _ensureStack(_gasketStack, need);
    const st = _gasketStack;
    let sp = 0;
    // node = [depth, skip, k0,zx0,zy0, k1,zx1,zy1, k2,zx2,zy2, k3,zx3,zy3]
    st[sp++] = 0; st[sp++] = -1;
    st[sp++] = k0; st[sp++] = x0; st[sp++] = y0;
    st[sp++] = k1; st[sp++] = x1; st[sp++] = y1;
    st[sp++] = k2; st[sp++] = x2; st[sp++] = y2;
    st[sp++] = k3; st[sp++] = x3; st[sp++] = y3;

    const K = new Float64Array(4), ZX = new Float64Array(4), ZY = new Float64Array(4);
    while (sp > 0 && written < cap) {
        const base = sp - 14;
        for (let i = 0; i < 4; i++) {
            K[i] = st[base + 2 + i * 3];
            ZX[i] = st[base + 3 + i * 3];
            ZY[i] = st[base + 4 + i * 3];
        }
        const depth = st[base], skip = st[base + 1];
        sp = base;
        if (depth >= iterations) continue;
        let sumK = 0, sumX = 0, sumY = 0;
        for (let i = 0; i < 4; i++) { sumK += K[i]; sumX += K[i] * ZX[i]; sumY += K[i] * ZY[i]; }
        for (let i = 3; i >= 0; i--) {
            if (i === skip) continue;
            const ok = K[i], ox = ZX[i], oy = ZY[i];
            const nk = 2 * (sumK - ok) - ok;
            if (Math.abs(nk) < 1e-12) continue;
            const nx = (2 * (sumX - ok * ox) - ok * ox) / nk;
            const ny = (2 * (sumY - ok * oy) - ok * oy) / nk;
            emit(nk, nx, ny);
            if (written >= cap) break;
            if (sp + 14 > st.length) break;
            st[sp++] = depth + 1; st[sp++] = i;
            for (let j = 0; j < 4; j++) {
                if (j === i) { st[sp++] = nk; st[sp++] = nx; st[sp++] = ny; }
                else { st[sp++] = K[j]; st[sp++] = ZX[j]; st[sp++] = ZY[j]; }
            }
        }
    }
    return written;
}
export function apollonianGasket(cx, cy, r, iterations, out) {
    iterations = iterations === undefined ? 4 : iterations;
    const cap = apollonianGasketCount(iterations);
    const buf = out && out.length >= cap * 3 ? out : new Float32Array(cap * 3);
    const n = apollonianGasketInto(buf, 0, iterations, cx, cy, r, cap);
    return buf.subarray(0, n * 3);
}

// ============================================================================
// L-systems
// ============================================================================
/**
 * Expand an L-system axiom. Growth is capped (default 2M chars) so a runaway
 * rule cannot OOM an Android WebView.
 */
export function expandLSystem(axiom, rules, iterations, maxLength) {
    maxLength = maxLength || MAX_LSYSTEM_LENGTH;
    const map = Object.create(null);
    for (let i = 0; i < rules.length; i++) map[rules[i].from] = rules[i].to;
    let current = String(axiom);
    for (let it = 0; it < iterations; it++) {
        const parts = [];
        let len = 0;
        for (let i = 0; i < current.length; i++) {
            const ch = current[i];
            const rep = map[ch];
            const piece = rep !== undefined ? rep : ch;
            parts.push(piece);
            len += piece.length;
            if (len > maxLength) break;
        }
        current = parts.join("");
        if (current.length >= maxLength) break;
    }
    return current;
}

/** Rodrigues rotation of v about unit axis a; writes into out3. */
function _rot3(out, vx, vy, vz, ax, ay, az, c, s, t) {
    const d = ax * vx + ay * vy + az * vz;
    const cx = ay * vz - az * vy;
    const cy = az * vx - ax * vz;
    const cz = ax * vy - ay * vx;
    out[0] = vx * c + cx * s + ax * d * t;
    out[1] = vy * c + cy * s + ay * d * t;
    out[2] = vz * c + cz * s + az * d * t;
    return out;
}

/**
 * Correct 3D turtle interpreter (Prusinkiewicz H/L/U frame).
 * CORRECTED: the previous version tracked an unused Euler roll, so `\` and
 * `/` had no effect on subsequent turns. This maintains a full orthonormal
 * frame, and the state stack is a flat pre-allocated Float64Array.
 *
 * Commands: F/G draw · f move · +/− yaw · &/^ pitch · \// roll · | turn 180
 *           [ push · ] pop · everything else no-op.
 */
export function turtle3D(commands, angle, stepLen, thickness, options) {
    angle = angle === undefined ? PI / 6 : angle;
    stepLen = stepLen === undefined ? 1 : stepLen;
    thickness = thickness === undefined ? 1 : thickness;
    options = options || {};
    const shrink = options.shrink !== undefined ? options.shrink : 0.75;
    const lenScale = options.lengthScale !== undefined ? options.lengthScale : 1;

    let segCount = 0, brackets = 0;
    for (let i = 0; i < commands.length; i++) {
        const c = commands[i];
        if (c === "F" || c === "G") segCount++;
        else if (c === "[") brackets++;
    }
    const segments = options.segments || new Float32Array(segCount * 6);
    const radii = options.radii || new Float32Array(segCount);
    _turtleStack = _ensureStack(_turtleStack, 14 * (brackets + 1));
    const st = _turtleStack;
    let sp = 0, o = 0, ro = 0;

    let x = options.x || 0, y = options.y || 0, z = options.z || 0;
    let hx = 0, hy = 1, hz = 0;      // heading (up)
    let lx = -1, ly = 0, lz = 0;     // left
    let ux = 0, uy = 0, uz = 1;      // up-reference
    let len = stepLen, th = thickness;

    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    for (let i = 0; i < commands.length; i++) {
        switch (commands[i]) {
            case "F":
            case "G": {
                const nx = x + hx * len, ny = y + hy * len, nz = z + hz * len;
                segments[o++] = x; segments[o++] = y; segments[o++] = z;
                segments[o++] = nx; segments[o++] = ny; segments[o++] = nz;
                radii[ro++] = th;
                x = nx; y = ny; z = nz;
                break;
            }
            case "f":
                x += hx * len; y += hy * len; z += hz * len;
                break;
            case "+":
                _rot3(_tv, hx, hy, hz, ux, uy, uz, c, s, t); hx = _tv[0]; hy = _tv[1]; hz = _tv[2];
                _rot3(_tv, lx, ly, lz, ux, uy, uz, c, s, t); lx = _tv[0]; ly = _tv[1]; lz = _tv[2];
                break;
            case "-":
                _rot3(_tv, hx, hy, hz, ux, uy, uz, c, -s, t); hx = _tv[0]; hy = _tv[1]; hz = _tv[2];
                _rot3(_tv, lx, ly, lz, ux, uy, uz, c, -s, t); lx = _tv[0]; ly = _tv[1]; lz = _tv[2];
                break;
            case "&":
                _rot3(_tv, hx, hy, hz, lx, ly, lz, c, s, t); hx = _tv[0]; hy = _tv[1]; hz = _tv[2];
                _rot3(_tv, ux, uy, uz, lx, ly, lz, c, s, t); ux = _tv[0]; uy = _tv[1]; uz = _tv[2];
                break;
            case "^":
                _rot3(_tv, hx, hy, hz, lx, ly, lz, c, -s, t); hx = _tv[0]; hy = _tv[1]; hz = _tv[2];
                _rot3(_tv, ux, uy, uz, lx, ly, lz, c, -s, t); ux = _tv[0]; uy = _tv[1]; uz = _tv[2];
                break;
            case "\\":
                _rot3(_tv, lx, ly, lz, hx, hy, hz, c, s, t); lx = _tv[0]; ly = _tv[1]; lz = _tv[2];
                _rot3(_tv, ux, uy, uz, hx, hy, hz, c, s, t); ux = _tv[0]; uy = _tv[1]; uz = _tv[2];
                break;
            case "/":
                _rot3(_tv, lx, ly, lz, hx, hy, hz, c, -s, t); lx = _tv[0]; ly = _tv[1]; lz = _tv[2];
                _rot3(_tv, ux, uy, uz, hx, hy, hz, c, -s, t); ux = _tv[0]; uy = _tv[1]; uz = _tv[2];
                break;
            case "|":
                _rot3(_tv, hx, hy, hz, ux, uy, uz, -1, 0, 2); hx = _tv[0]; hy = _tv[1]; hz = _tv[2];
                _rot3(_tv, lx, ly, lz, ux, uy, uz, -1, 0, 2); lx = _tv[0]; ly = _tv[1]; lz = _tv[2];
                break;
            case "[":
                st[sp++] = x; st[sp++] = y; st[sp++] = z;
                st[sp++] = hx; st[sp++] = hy; st[sp++] = hz;
                st[sp++] = lx; st[sp++] = ly; st[sp++] = lz;
                st[sp++] = ux; st[sp++] = uy; st[sp++] = uz;
                st[sp++] = len; st[sp++] = th;
                th *= shrink; len *= lenScale;
                break;
            case "]":
                if (sp >= 14) {
                    th = st[--sp]; len = st[--sp];
                    uz = st[--sp]; uy = st[--sp]; ux = st[--sp];
                    lz = st[--sp]; ly = st[--sp]; lx = st[--sp];
                    hz = st[--sp]; hy = st[--sp]; hx = st[--sp];
                    z = st[--sp]; y = st[--sp]; x = st[--sp];
                }
                break;
            default: break;
        }
    }
    return { segments: segments, radii: radii, segmentCount: ro };
}

/** Run an L-system preset and return 3D geometry. */
export function lSystem3D(presetName, options) {
    options = options || {};
    const preset = LSYSTEM_PRESETS[presetName];
    if (!preset) throw new Error("lSystem3D: unknown preset " + presetName);
    const iterations = options.iterations !== undefined ? options.iterations : preset.iterations;
    const stepLen = options.stepLen !== undefined ? options.stepLen : 1;
    const thickness = options.thickness !== undefined ? options.thickness : 0.1;
    const angle = options.angle !== undefined ? options.angle : preset.angle;
    const commands = expandLSystem(preset.axiom, preset.rules, iterations, options.maxLength);
    return turtle3D(commands, angle, stepLen, thickness, options);
}

export function growTree3DCount(depth, branching) {
    branching = branching || 3;
    if (branching === 1) return depth;
    return (_powi(branching, depth) - 1) / (branching - 1);
}
/**
 * Procedural 3D tree — recursive branching with gravity tropism.
 * CORRECTED: exact segment count + flat stack instead of JS array pushes.
 */
export function growTree3D(depth, options) {
    options = options || {};
    const branching = options.branching || 3;
    const angle = options.angle || PI / 5;
    const stepLen = options.stepLen || 1;
    const thickness = options.thickness || 0.5;
    const shrink = options.shrink || 0.75;
    const gravity = options.gravity === undefined ? 0.05 : options.gravity;
    depth = depth || 5;
    const total = growTree3DCount(depth, branching);
    const segments = options.segments || new Float32Array(total * 6);
    const radii = options.radii || new Float32Array(total);
    _treeStack = _ensureStack(_treeStack, 8 * (depth * branching + 2));
    const st = _treeStack;
    let sp = 0, o = 0, ro = 0;
    st[sp++] = 0; st[sp++] = 0; st[sp++] = 0;
    st[sp++] = 0; st[sp++] = HALF_PI; st[sp++] = stepLen; st[sp++] = thickness; st[sp++] = depth;
    while (sp > 0) {
        const d = st[--sp];
        const th = st[--sp], len = st[--sp], p = st[--sp], h = st[--sp];
        const z = st[--sp], y = st[--sp], x = st[--sp];
        if (d <= 0) continue;
        const ch = Math.cos(h), sh = Math.sin(h);
        const cp = Math.cos(p), spn = Math.sin(p);
        const nx = x + ch * cp * len;
        const ny = y + (spn - gravity) * len;
        const nz = z + sh * cp * len;
        segments[o++] = x; segments[o++] = y; segments[o++] = z;
        segments[o++] = nx; segments[o++] = ny; segments[o++] = nz;
        radii[ro++] = th;
        if (d - 1 > 0) {
            for (let b = branching - 1; b >= 0; b--) {
                const spread = (b - (branching - 1) * 0.5) * (angle * 2);
                st[sp++] = nx; st[sp++] = ny; st[sp++] = nz;
                st[sp++] = h + spread; st[sp++] = p - angle;
                st[sp++] = len * shrink; st[sp++] = th * shrink; st[sp++] = d - 1;
            }
        }
    }
    return { segments: segments, radii: radii, segmentCount: ro };
}

// ============================================================================
// High-level fractal worlds
// ============================================================================
/** Fractal heightfield from a 2D escape-time fractal. */
export function fractalTerrain(positions, out, options) {
    options = options || {};
    const maxIter = options.maxIter || 256;
    const zoom = options.zoom || 1;
    const n = positions.count;
    const useXY = options.axis === "xy";
    const px = positions.x, pz = useXY ? positions.y : positions.z;
    const cx = options.centerX || 0, cy = options.centerY || 0;
    const smooth = options.smooth !== false;
    for (let i = 0; i < n; i++) {
        const x = cx + px[i] * zoom, y = cy + pz[i] * zoom;
        out[i] = smooth ? mandelbrotSmooth(x, y, maxIter) : mandelbrot(x, y, maxIter) / maxIter;
    }
    return out;
}

/** Fractal galaxy seeding — Julia-driven radial banding. */
export function fractalGalaxy(outPositions, options) {
    options = options || {};
    const count = outPositions.count;
    const radius = options.radius || 100;
    const cx = options.cx !== undefined ? options.cx : -0.7;
    const cy = options.cy !== undefined ? options.cy : 0.27015;
    const maxIter = options.maxIter || 128;
    const thickness = options.thickness || 1;
    const arms = options.arms || 2;
    const rng = common.mulberry32(options.seed || 1);
    const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
    for (let i = 0; i < count; i++) {
        const px = (rng() - 0.5) * 4;
        const py = (rng() - 0.5) * 4;
        const it = julia(cx, cy, px, py, maxIter);
        const t = it / maxIter;
        const r = t * radius;
        const armOffset = ((i % arms) / arms) * TAU;
        const theta = armOffset + rng() * 0.6 + t * (options.twist || 3);
        ox[i] = Math.cos(theta) * r;
        oy[i] = Math.cos(px * PI) * thickness * (1 - t * 0.7);
        oz[i] = Math.sin(theta) * r;
    }
    return outPositions;
}

/**
 * Fractal star cluster — Mandelbulb-shell distribution.
 * CORRECTED: bounded rejection sampling (the original could loop forever)
 * with a deterministic spherical fallback.
 */
export function fractalStarCluster(outPositions, options) {
    options = options || {};
    const count = outPositions.count;
    const radius = options.radius || 100;
    const iterations = options.iterations || 6;
    const threshold = options.threshold !== undefined ? options.threshold : 0.02;
    const maxAttempts = options.maxAttempts || count * 64;
    const rng = common.mulberry32(options.seed || 1);
    const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
    let placed = 0, attempts = 0;
    while (placed < count && attempts < maxAttempts) {
        attempts++;
        const x = (rng() - 0.5) * 3;
        const y = (rng() - 0.5) * 3;
        const z = (rng() - 0.5) * 3;
        if (mandelbulbDE(x, y, z, iterations) < threshold) {
            ox[placed] = x * radius; oy[placed] = y * radius; oz[placed] = z * radius;
            placed++;
        }
    }
    while (placed < count) {
        const u = rng() * TAU, v = Math.acos(2 * rng() - 1);
        const rr = radius * (0.6 + 0.4 * rng());
        const sv = Math.sin(v);
        ox[placed] = rr * sv * Math.cos(u);
        oy[placed] = rr * Math.cos(v);
        oz[placed] = rr * sv * Math.sin(u);
        placed++;
    }
    return outPositions;
}

// ============================================================================
// SOA — synchronous, zero allocation
// ============================================================================
export function soaMandelbrot(out, xs, ys, count, maxIter) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 256;
    for (let i = 0; i < count; i++) out[i] = mandelbrot(xs[i], ys[i], maxIter);
    return out;
}
export function soaMandelbrotSmooth(out, xs, ys, count, maxIter) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 256;
    for (let i = 0; i < count; i++) out[i] = mandelbrotSmooth(xs[i], ys[i], maxIter);
    return out;
}
export function soaJulia(out, cxs, cys, jxs, jys, count, maxIter) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 256;
    const cxArr = _isArr(cxs) ? cxs : null;
    const cyArr = _isArr(cys) ? cys : null;
    for (let i = 0; i < count; i++) {
        out[i] = julia(cxArr ? cxArr[i] : cxs, cyArr ? cyArr[i] : cys, jxs[i], jys[i], maxIter);
    }
    return out;
}
export function soaJuliaSmooth(out, cx, cy, jxs, jys, count, maxIter) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 256;
    for (let i = 0; i < count; i++) out[i] = juliaSmooth(cx, cy, jxs[i], jys[i], maxIter);
    return out;
}
export function soaBurningShip(out, xs, ys, count, maxIter) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 256;
    for (let i = 0; i < count; i++) out[i] = burningShip(xs[i], ys[i], maxIter);
    return out;
}
export function soaMultibrot(out, xs, ys, d, count, maxIter) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 256;
    for (let i = 0; i < count; i++) out[i] = multibrot(xs[i], ys[i], d, maxIter);
    return out;
}
export function soaTricorn(out, xs, ys, count, maxIter) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 256;
    for (let i = 0; i < count; i++) out[i] = tricorn(xs[i], ys[i], maxIter);
    return out;
}
/** Newton SOA — writes root index into outRoot and iteration count into outIter. */
export function soaNewton(outRoot, outIter, xs, ys, count, maxIter) {
    count = count === undefined ? outRoot.length : count;
    maxIter = maxIter || 64;
    for (let i = 0; i < count; i++) {
        newtonFractalInto(_newton2, xs[i], ys[i], maxIter);
        outRoot[i] = _newton2[0]; outIter[i] = _newton2[1];
    }
    return outRoot;
}
export function soaMandelbulbDE(out, positions, iterations, power, scale, count) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = mandelbulbDE(px[i], py[i], pz[i], iterations, power, scale);
    return out;
}
export function soaMandelboxDE(out, positions, iterations, scaleParam, fixedRadius, count) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = mandelboxDE(px[i], py[i], pz[i], iterations, scaleParam, fixedRadius);
    return out;
}
export function soaJuliaQuatDE(out, positions, cx, cy, cz, cw, iterations, scale, count) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        out[i] = juliaQuatDE(px[i], py[i], pz[i], cx, cy, cz, cw, iterations, scale);
    }
    return out;
}
export function soaSierpinskiTetraDE(out, positions, iterations, scale, count) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = sierpinskiTetraDE(px[i], py[i], pz[i], iterations, scale);
    return out;
}
export function soaMengerSpongeDE(out, positions, iterations, scale, count) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) out[i] = mengerSpongeDE(px[i], py[i], pz[i], iterations, scale);
    return out;
}
/** CORRECTED: fully inlined — no result object per element. */
export function soaMandelbulbIter(outIter, outTrap, positions, iterations, power, count) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        mandelbulbIterInto(_iter3, px[i], py[i], pz[i], iterations, power);
        outIter[i] = _iter3[0]; outTrap[i] = _iter3[1];
    }
    return outIter;
}
/** Deep-zoom SOA — per-pixel double-single coordinates from a centre + scale. */
export function soaMandelbrotDeepZoom(out, centerHi, centerLo, xs, ys, scale, count, maxIter) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 512;
    const c4 = _dsD;
    for (let i = 0; i < count; i++) {
        deepZoomCoord(c4, centerHi[0], centerLo[0], centerHi[1], centerLo[1], xs[i], ys[i], scale);
        out[i] = mandelbrotDS(c4[0], c4[1], c4[2], c4[3], maxIter);
    }
    return out;
}

// ============================================================================
// Chunked async — one closure per CALL (async / loading path only, §1)
// ============================================================================
async function _chunked(count, chunkSize, yieldEvery, perChunk) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        perChunk(start, end);
        start = end;
        if (start >= count) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
}

export async function soaMandelbrotChunked(out, xs, ys, count, maxIter, cs, ye) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 256;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = mandelbrot(xs[i], ys[i], maxIter);
    });
    return out;
}
export async function soaJuliaChunked(out, cxs, cys, jxs, jys, count, maxIter, cs, ye) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 256;
    const cxArr = _isArr(cxs) ? cxs : null;
    const cyArr = _isArr(cys) ? cys : null;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            out[i] = julia(cxArr ? cxArr[i] : cxs, cyArr ? cyArr[i] : cys, jxs[i], jys[i], maxIter);
        }
    });
    return out;
}
export async function soaBurningShipChunked(out, xs, ys, count, maxIter, cs, ye) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 256;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = burningShip(xs[i], ys[i], maxIter);
    });
    return out;
}
export async function soaMultibrotChunked(out, xs, ys, d, count, maxIter, cs, ye) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 256;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = multibrot(xs[i], ys[i], d, maxIter);
    });
    return out;
}
export async function soaMandelbulbDEChunked(out, positions, iterations, power, scale, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = mandelbulbDE(px[i], py[i], pz[i], iterations, power, scale);
    });
    return out;
}
export async function soaMandelboxDEChunked(out, positions, iterations, scaleParam, fixedRadius, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = mandelboxDE(px[i], py[i], pz[i], iterations, scaleParam, fixedRadius);
    });
    return out;
}
export async function soaMengerSpongeDEChunked(out, positions, iterations, scale, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) out[i] = mengerSpongeDE(px[i], py[i], pz[i], iterations, scale);
    });
    return out;
}
export async function soaMandelbulbIterChunked(outIter, outTrap, positions, iterations, power, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            mandelbulbIterInto(_iter3, px[i], py[i], pz[i], iterations, power);
            outIter[i] = _iter3[0]; outTrap[i] = _iter3[1];
        }
    });
    return outIter;
}
export async function soaMandelbrotDeepZoomChunked(out, centerHi, centerLo, xs, ys, scale, count, maxIter, cs, ye) {
    count = count === undefined ? out.length : count;
    maxIter = maxIter || 512;
    const c4 = new Float64Array(4); // one per async call, never per pixel
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            deepZoomCoord(c4, centerHi[0], centerLo[0], centerHi[1], centerLo[1], xs[i], ys[i], scale);
            out[i] = mandelbrotDS(c4[0], c4[1], c4[2], c4[3], maxIter);
        }
    });
    return out;
}

// ============================================================================
// LUT authoring (Blueprint §30) — caller owns the buffer
// ============================================================================
/** RGBA float LUT of a 2D escape-time fractal. `out` holds width*height*4. */
export function buildFractalLUT(out, width, height, options) {
    options = options || {};
    const id = resolveFractalKind(options.kind);
    const maxIter = options.maxIter || 256;
    const zoom = options.zoom === undefined ? 1 : options.zoom;
    const cx = options.centerX === undefined ? -0.5 : options.centerX;
    const cy = options.centerY === undefined ? 0 : options.centerY;
    const jx = options.juliaX === undefined ? -0.7 : options.juliaX;
    const jy = options.juliaY === undefined ? 0.27015 : options.juliaY;
    const degree = options.degree || 3;
    const invW = 1 / width, invH = 1 / height;
    const spanX = (options.spanX === undefined ? 3 : options.spanX) / zoom;
    const spanY = (options.spanY === undefined ? 2 : options.spanY) / zoom;
    const gain = options.gain === undefined ? 1 : options.gain;
    for (let y = 0; y < height; y++) {
        const fy = cy + (y * invH - 0.5) * spanY;
        for (let x = 0; x < width; x++) {
            const fx = cx + (x * invW - 0.5) * spanX;
            let v;
            if (id === FRACTAL_NEWTON) {
                newtonFractalInto(_newton2, fx, fy, maxIter);
                v = _newton2[0] < 0 ? 0 : (_newton2[0] + 1) / 3;
                const o = (y * width + x) * 4;
                out[o] = _newton2[0] === 0 ? v * gain : 0;
                out[o + 1] = _newton2[0] === 1 ? v * gain : 0;
                out[o + 2] = _newton2[0] === 2 ? v * gain : 0;
                out[o + 3] = 1;
                continue;
            }
            if (id === FRACTAL_JULIA) v = juliaSmooth(jx, jy, fx, fy, maxIter);
            else if (id === FRACTAL_BURNING_SHIP) v = burningShip(fx, fy, maxIter) / maxIter;
            else if (id === FRACTAL_MULTIBROT) v = multibrot(fx, fy, degree, maxIter) / maxIter;
            else if (id === FRACTAL_TRICORN) v = tricorn(fx, fy, maxIter) / maxIter;
            else v = mandelbrotSmooth(fx, fy, maxIter);
            const o = (y * width + x) * 4;
            const g = v * gain;
            out[o] = g; out[o + 1] = g * g; out[o + 2] = g * g * g; out[o + 3] = 1;
        }
    }
    return out;
}
export async function buildFractalLUTChunked(out, width, height, options, cs, ye) {
    options = options || {};
    const id = resolveFractalKind(options.kind);
    const maxIter = options.maxIter || 256;
    const zoom = options.zoom === undefined ? 1 : options.zoom;
    const cx = options.centerX === undefined ? -0.5 : options.centerX;
    const cy = options.centerY === undefined ? 0 : options.centerY;
    const jx = options.juliaX === undefined ? -0.7 : options.juliaX;
    const jy = options.juliaY === undefined ? 0.27015 : options.juliaY;
    const degree = options.degree || 3;
    const invW = 1 / width, invH = 1 / height;
    const spanX = (options.spanX === undefined ? 3 : options.spanX) / zoom;
    const spanY = (options.spanY === undefined ? 2 : options.spanY) / zoom;
    const gain = options.gain === undefined ? 1 : options.gain;
    await _chunked(height, cs, ye, function (s, e) {
        for (let y = s; y < e; y++) {
            const fy = cy + (y * invH - 0.5) * spanY;
            for (let x = 0; x < width; x++) {
                const fx = cx + (x * invW - 0.5) * spanX;
                let v;
                if (id === FRACTAL_JULIA) v = juliaSmooth(jx, jy, fx, fy, maxIter);
                else if (id === FRACTAL_BURNING_SHIP) v = burningShip(fx, fy, maxIter) / maxIter;
                else if (id === FRACTAL_MULTIBROT) v = multibrot(fx, fy, degree, maxIter) / maxIter;
                else if (id === FRACTAL_TRICORN) v = tricorn(fx, fy, maxIter) / maxIter;
                else if (id === FRACTAL_NEWTON) { newtonFractalInto(_newton2, fx, fy, maxIter); v = (_newton2[0] + 1) / 3; }
                else v = mandelbrotSmooth(fx, fy, maxIter);
                const o = (y * width + x) * 4;
                const g = v * gain;
                out[o] = g; out[o + 1] = g * g; out[o + 2] = g * g * g; out[o + 3] = 1;
            }
        }
    });
    return out;
}

// ============================================================================
// GPU attribute bridge (Blueprint §25 / §28)
// ============================================================================
export function writeFractalIntoFlat(flat, values, count, stride, offset, scale, bias) {
    const n = count === undefined ? values.length : count;
    const st = stride === undefined ? 1 : stride;
    const off = offset === undefined ? 0 : offset;
    const s = scale === undefined ? 1 : scale;
    const b = bias === undefined ? 0 : bias;
    for (let i = 0, o = off; i < n; i++, o += st) flat[o] = values[i] * s + b;
    return flat;
}
export function flagFractalUpload(attr, count, itemSize) {
    if (!attr) return;
    const st = itemSize || attr.itemSize || 1;
    if (attr.clearUpdateRanges) attr.clearUpdateRanges();
    if (attr.addUpdateRange) attr.addUpdateRange(0, count * st);
    attr.needsUpdate = true;
}
/** Upload fractal values into an InstancedBufferAttribute. Returns count. */
export function syncFractalAttribute(attr, values, count, options) {
    if (!attr || !attr.array) return 0;
    options = options || {};
    const n = count === undefined ? (values.count !== undefined ? values.count : values.length) : count;
    const st = options.stride !== undefined ? options.stride : (attr.itemSize || 1);
    writeFractalIntoFlat(attr.array, values, n, st, options.offset, options.scale, options.bias);
    flagFractalUpload(attr, n, st);
    return n;
}

// ============================================================================
// Fixed-step animation (Blueprint §45 / §51)
// ============================================================================
/**
 * Deterministic Julia-parameter morph. The parameter advances on a FIXED
 * timestep so replays are bit-identical regardless of display refresh rate.
 */
export function createJuliaMorph(options) {
    options = options || {};
    const hz = options.hz !== undefined ? options.hz : 60;
    const fixedDt = 1 / hz;
    const duration = options.duration !== undefined ? options.duration : 4;
    const fromX = options.fromX === undefined ? -0.7 : options.fromX;
    const fromY = options.fromY === undefined ? 0.27015 : options.fromY;
    const toX = options.toX === undefined ? 0.355 : options.toX;
    const toY = options.toY === undefined ? 0.355 : options.toY;
    const loop = options.loop !== false;
    const dx = toX - fromX, dy = toY - fromY;
    let time = 0;
    let cx = fromX, cy = fromY;
    function advance() {
        time += fixedDt;
        let t = duration > 0 ? time / duration : 1;
        if (loop) { t = t % 2; if (t > 1) t = 2 - t; }
        else if (t > 1) t = 1;
        // Smoothstep for a natural, non-linear parameter sweep.
        const e = t * t * (3 - 2 * t);
        cx = fromX + dx * e;
        cy = fromY + dy * e;
    }
    const scheduler = createFixedStepScheduler(hz, advance, options.maxSteps || 8);
    return {
        get cx() { return cx; },
        get cy() { return cy; },
        get time() { return time; },
        step: function (dtMs) { scheduler.step(dtMs); return this; },
        stepFixed: function () { advance(); return this; },
        reset: function () { time = 0; cx = fromX; cy = fromY; scheduler.reset(); return this; }
    };
}
/** Drive a FractalBatchState's Julia evaluation from a fixed-step morph. */
export function createFractalAnimator(batch, options) {
    const morph = createJuliaMorph(options);
    const maxIter = (options && options.maxIter) || 128;
    return {
        morph: morph,
        batch: batch,
        step: function (dtMs) {
            morph.step(dtMs);
            batch.juliaAll(morph.cx, morph.cy, maxIter);
            return this;
        },
        stepChunked: async function (dtMs, cs, ye) {
            morph.step(dtMs);
            await batch.juliaAllChunked(morph.cx, morph.cy, maxIter, cs, ye);
            return this;
        }
    };
}

// ============================================================================
// Pooled scratch — zero-GC, precision-aware, ES2017-compatible
// ============================================================================
export class FractalScratch {
    constructor(size) {
        this.size = 0;
        this.have = 0;
        this._dtype = null;
        this.a = null; this.b = null; this.c = null;
        if (size) this.ensure(size, 2);
    }
    ensure(n, channels) {
        const need = channels === undefined ? 2 : channels;
        const T = getArrayType();
        const size = Math.max(n | 0, this.size);
        const grow = size > this.size || this._dtype !== T;
        if (!grow && this.have >= need) return this;
        if (grow || !this.a) this.a = new T(size);
        if (need >= 2 && (grow || !this.b)) this.b = new T(size);
        if (need >= 3 && (grow || !this.c)) this.c = new T(size);
        this.size = size;
        this.have = Math.max(this.have, need);
        this._dtype = T;
        return this;
    }
    reset() {
        if (this.a) this.a.fill(0);
        if (this.b) this.b.fill(0);
        if (this.c) this.c.fill(0);
        return this;
    }
    static acquire(size, channels) {
        const pool = FractalScratch._warm;
        let best = -1;
        for (let i = 0; i < pool.length; i++) {
            if (pool[i].size >= (size || 0)) { best = i; break; }
        }
        let s;
        if (best >= 0) {
            const last = pool.length - 1;
            s = pool[best];
            pool[best] = pool[last];
            pool[last] = undefined;
            pool.length = last;
        } else {
            s = new FractalScratch(0);
        }
        s.ensure(size || 0, channels || 2);
        return s;
    }
    static release(s) {
        if (!s) return;
        const pool = FractalScratch._warm;
        if (pool.length < FractalScratch.MAX_POOLED) pool.push(s);
    }
}
FractalScratch._warm = [];
FractalScratch.MAX_POOLED = 16;
(function _warmFractalScratch() {
    for (let i = 0; i < 4; i++) FractalScratch._warm.push(new FractalScratch(256));
})();

export function createFractalScratchPool(capacity) {
    return common.createPool(
        function () { return new FractalScratch(0); },
        capacity || 16,
        function (s) { s.reset(); }
    );
}
const _fractalScratchPool = createFractalScratchPool(16);
export function acquireFractalScratch(size, channels) {
    const s = _fractalScratchPool.acquire();
    s.ensure(size || 0, channels || 2);
    return s;
}
export function releaseFractalScratch(s) { if (s) _fractalScratchPool.release(s); }

// ============================================================================
// Batch state
// ============================================================================
export class FractalBatchState {
    constructor(count, options) {
        options = options || {};
        this.count = count;
        const T = getArrayType();
        this._dtype = T;
        this.out = new T(count);
        this.outAux = new T(count);
        this.xs = new T(count);
        this.ys = new T(count);
        this.zs = new T(count);
        this._tracked = options.track !== false;
        if (this._tracked) trackFractal(this);
    }
    /** Copy sample coordinates from a vec3 SOA (setup / streaming path). */
    setPositions(soa) {
        const n = Math.min(this.count, soa.count);
        for (let i = 0; i < n; i++) {
            this.xs[i] = soa.x[i]; this.ys[i] = soa.y[i]; this.zs[i] = soa.z[i];
        }
        return this;
    }
    mandelbrotAll(maxIter) { return soaMandelbrot(this.out, this.xs, this.ys, this.count, maxIter); }
    mandelbrotAllChunked(maxIter, cs, ye) {
        return soaMandelbrotChunked(this.out, this.xs, this.ys, this.count, maxIter, cs, ye);
    }
    /** CORRECTED: scalar constants — no longer clobbers outAux / zs. */
    juliaAll(cx, cy, maxIter) {
        const out = this.out, xs = this.xs, ys = this.ys, n = this.count;
        maxIter = maxIter || 256;
        for (let i = 0; i < n; i++) out[i] = julia(cx, cy, xs[i], ys[i], maxIter);
        return out;
    }
    juliaAllChunked(cx, cy, maxIter, cs, ye) {
        return soaJuliaChunked(this.out, cx, cy, this.xs, this.ys, this.count, maxIter, cs, ye);
    }
    burningShipAll(maxIter) { return soaBurningShip(this.out, this.xs, this.ys, this.count, maxIter); }
    multibrotAll(d, maxIter) { return soaMultibrot(this.out, this.xs, this.ys, d, this.count, maxIter); }
    mandelbulbAll(iterations, power, scale) {
        const p = { x: this.xs, y: this.ys, z: this.zs, count: this.count };
        return soaMandelbulbDE(this.out, p, iterations, power, scale, this.count);
    }
    mandelbulbAllChunked(iterations, power, scale, cs, ye) {
        const p = { x: this.xs, y: this.ys, z: this.zs, count: this.count };
        return soaMandelbulbDEChunked(this.out, p, iterations, power, scale, this.count, cs, ye);
    }
    mandelboxAll(iterations, scaleParam, fixedRadius) {
        const p = { x: this.xs, y: this.ys, z: this.zs, count: this.count };
        return soaMandelboxDE(this.out, p, iterations, scaleParam, fixedRadius, this.count);
    }
    mengerAll(iterations, scale) {
        const p = { x: this.xs, y: this.ys, z: this.zs, count: this.count };
        return soaMengerSpongeDE(this.out, p, iterations, scale, this.count);
    }
    mandelbulbIterAll(iterations, power) {
        const p = { x: this.xs, y: this.ys, z: this.zs, count: this.count };
        return soaMandelbulbIter(this.out, this.outAux, p, iterations, power, this.count);
    }
    /** Upload the primary output into an instanced attribute (§25/§28). */
    uploadTo(attr, options) { return syncFractalAttribute(attr, this.out, this.count, options); }
    reset() {
        this.out.fill(0); this.outAux.fill(0);
        this.xs.fill(0); this.ys.fill(0); this.zs.fill(0);
        return this;
    }
    migrate(targetPrecision) {
        const T = targetPrecision ? getArrayType(targetPrecision) : getArrayType();
        if (T === this._dtype) return this;
        const n = this.count;
        const names = ["out", "outAux", "xs", "ys", "zs"];
        for (let i = 0; i < names.length; i++) {
            const old = this[names[i]];
            const next = new T(n);
            next.set(old);
            this[names[i]] = next;
        }
        this._dtype = T;
        return this;
    }
    toTransferable() { return fractalBatchToTransferable(this); }
    dispose() { if (this._tracked) untrackFractal(this); return this; }
}
export function createFractalBatch(count, options) { return new FractalBatchState(count, options); }

// ============================================================================
// Precision tracking / migration (dense arrays — no Map/Set, §10/§16)
// ============================================================================
const _trackedBatches = [];
export function trackFractal(state) {
    if (!state) return state;
    if (_trackedBatches.indexOf(state) === -1) _trackedBatches.push(state);
    return state;
}
export function untrackFractal(state) {
    const i = _trackedBatches.indexOf(state);
    if (i !== -1) _trackedBatches.splice(i, 1);
}
export function clearTrackedFractals() { _trackedBatches.length = 0; }
export function getTrackedFractals() { return _trackedBatches; }
export function migrateFractal(state, targetPrecision) {
    if (state && state.migrate) state.migrate(targetPrecision);
    return state;
}
export function migrateAllFractals(targetPrecision) {
    for (let i = 0; i < _trackedBatches.length; i++) {
        try { _trackedBatches[i].migrate(targetPrecision); }
        catch (e) { console.error("[043_fractals] migration failed for one batch", e); }
    }
}

onPrecisionChange(function () {
    migrateAllFractals();
    FractalScratch._warm.length = 0;
    for (let i = 0; i < 4; i++) FractalScratch._warm.push(new FractalScratch(256));
});

// ============================================================================
// Zero-copy transferable batch state (Blueprint §49)
// Layout: Int32 header [magic, version, count, reserved] then out|outAux|xs|ys|zs
// ============================================================================
const FRACTAL_MAGIC = 0x46524354; // "FRCT"
const FRACTAL_HEADER_BYTES = 16;

export function fractalBatchToTransferable(state) {
    const n = state.count;
    const buffer = new ArrayBuffer(FRACTAL_HEADER_BYTES + n * 4 * 5);
    const header = new Int32Array(buffer, 0, 4);
    header[0] = FRACTAL_MAGIC; header[1] = 1; header[2] = n; header[3] = 0;
    let off = FRACTAL_HEADER_BYTES;
    const names = ["out", "outAux", "xs", "ys", "zs"];
    for (let i = 0; i < names.length; i++) {
        new Float32Array(buffer, off, n).set(state[names[i]]);
        off += n * 4;
    }
    return { buffer: buffer, count: n, transferable: [buffer] };
}
export function fractalBatchFromTransferable(packet, options) {
    const buffer = packet.buffer || packet;
    const header = new Int32Array(buffer, 0, 4);
    if (header[0] !== FRACTAL_MAGIC) throw new Error("fractalBatchFromTransferable: bad magic");
    if (header[1] !== 1) throw new Error("fractalBatchFromTransferable: unsupported version " + header[1]);
    const n = header[2];
    const state = new FractalBatchState(n, options);
    let off = FRACTAL_HEADER_BYTES;
    const names = ["out", "outAux", "xs", "ys", "zs"];
    for (let i = 0; i < names.length; i++) {
        state[names[i]].set(new Float32Array(buffer, off, n));
        off += n * 4;
    }
    return state;
}

// ============================================================================
// Namespaces
// ============================================================================
export const escapeTime2D = {
    mandelbrot: mandelbrot,
    mandelbrotSmooth: mandelbrotSmooth,
    julia: julia,
    juliaSmooth: juliaSmooth,
    burningShip: burningShip,
    multibrot: multibrot,
    newton: newtonFractal,
    newtonInto: newtonFractalInto,
    tricorn: tricorn,
    resolveKind: resolveFractalKind,
    deepZoom: mandelbrotDS,
    deepZoomCoord: deepZoomCoord
};
export const distance3D = {
    mandelbulb: mandelbulbDE,
    mandelbulbIter: mandelbulbIter,
    mandelbulbIterInto: mandelbulbIterInto,
    mandelbox: mandelboxDE,
    juliaQuat: juliaQuatDE,
    sierpinskiTetra: sierpinskiTetraDE,
    mengerSponge: mengerSpongeDE,
    resolveKind: resolveDEKind
};
export const ifs = {
    sierpinskiTriangle: sierpinskiTriangle,
    sierpinskiTriangleInto: sierpinskiTriangleInto,
    sierpinskiCarpet: sierpinskiCarpet,
    sierpinskiCarpetInto: sierpinskiCarpetInto,
    kochSnowflake: kochSnowflake,
    kochSnowflakeInto: kochSnowflakeInto,
    dragonCurve: dragonCurve,
    cantorSet: cantorSet,
    cantorSetInto: cantorSetInto,
    cantorDust3D: cantorDust3D,
    cantorDust3DInto: cantorDust3DInto,
    barnsleyFern: barnsleyFern,
    apollonianGasket: apollonianGasket,
    apollonianGasketInto: apollonianGasketInto
};
export const lsystems = {
    expand: expandLSystem,
    turtle3D: turtle3D,
    preset3D: lSystem3D,
    growTree3D: growTree3D,
    presets: LSYSTEM_PRESETS
};
export const worlds = {
    terrain: fractalTerrain,
    galaxy: fractalGalaxy,
    starCluster: fractalStarCluster
};
export const precisionBridge = {
    addInto: dsAddInto,
    add22Into: dsAdd22Into,
    sub22Into: dsSub22Into,
    mul22Into: dsMul22Into,
    deepZoomCoord: deepZoomCoord,
    mandelbrotDS: mandelbrotDS,
    soaDeepZoom: soaMandelbrotDeepZoom,
    soaDeepZoomChunked: soaMandelbrotDeepZoomChunked
};
export const lut = {
    build: buildFractalLUT,
    buildChunked: buildFractalLUTChunked
};
export const gpu = {
    writeIntoFlat: writeFractalIntoFlat,
    flagUpload: flagFractalUpload,
    syncAttribute: syncFractalAttribute
};
export const transfer = {
    toTransferable: fractalBatchToTransferable,
    fromTransferable: fractalBatchFromTransferable
};
export const precision = {
    getPrecision: getPrecision,
    setPrecision: setPrecision,
    getArrayType: getArrayType,
    onPrecisionChange: onPrecisionChange,
    track: trackFractal,
    untrack: untrackFractal,
    migrate: migrateFractal,
    migrateAll: migrateAllFractals,
    getTracked: getTrackedFractals,
    clearTracked: clearTrackedFractals
};
export const animation = {
    createJuliaMorph: createJuliaMorph,
    createAnimator: createFractalAnimator,
    createFixedStepScheduler: createFixedStepScheduler
};
export const batch = {
    State: FractalBatchState,
    create: createFractalBatch,
    Scratch: FractalScratch,
    acquireScratch: acquireFractalScratch,
    releaseScratch: releaseFractalScratch
};
export const math = {
    common: common,
    vec2: vec2,
    vec3: vec3,
    vec4: vec4,
    createVec3SOA: createVec3SOA,
    createVec4SOA: createVec4SOA
};
export const namespace = {
    escapeTime2D: escapeTime2D,
    distance3D: distance3D,
    ifs: ifs,
    lsystems: lsystems,
    worlds: worlds,
    precisionBridge: precisionBridge,
    lut: lut,
    gpu: gpu,
    transfer: transfer,
    precision: precision,
    animation: animation,
    batch: batch
};