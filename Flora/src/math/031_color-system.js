//File number : 031
// File : src/math/031_color-system.js
//Description : Complete color system (ESM) — named imports from the unified math entry point.
//              Every original export is preserved, plus every color primitive required for 3D
//              procedural generation, rendering, animation and IES/IESNA photometric lighting:
//              RGB / Linear / sRGB / HSV / HSL / XYZ / LAB / LCH / OKLab / OKLCH / YIQ / YUV,
//              HDR tone mapping (Reinhard, Reinhard-Extended, ACES Narkowicz, ACES Hill,
//              AgX-approx, Uchimura/GT, Filmic, Uncharted2/Hable), gamut mapping (clamp +
//              OKLCH chroma reduction), perceptual differences (CIE76 / CIE94 / CIEDE2000),
//              hue rotation in RGB and OKLab, gradient samplers (linear / cosine / Catmull-Rom /
//              step / hue-cycle / OKLab), palette generators, full IESNA LM-63 1986/1991/2002
//              parser + photometric evaluator + candela→radiance, sync + chunked-async SOA
//              pipelines, pooled zero-GC scratch, live Float16/Float32/Float64 precision
//              switching, LUT authoring, auto-exposure, and batch state classes.
//
//              CORRECTIONS (this revision):
//              • FATAL: `exports.IESProfile = IESProfile` referenced an identifier that was never
//                declared, and `exports.ColorScratch / ColorBatchState` read classes from the TDZ
//                at module-evaluation time → ReferenceError on load. Converted to ESM
//                `export function` / `export class` declarations, which hoist correctly.
//              • FATAL: `tonemapAcesHill` acquired THREE pool slots and released a fourth,
//                unrelated one ("best-effort") — leaking two slots per call and corrupting the
//                pool. Now uses module-level scratch with zero pool traffic.
//              • FATAL: `hueRotateRgb` built a mat3 plus two throwaway SOA literals and multiplied
//                a ZERO colour, returning zeros. Rewritten as inline, allocation-free YIQ hue
//                rotation (HDR-safe, luma preserved).
//              • FATAL: `packRGBA` / `unpackRGBA` contained corrupted shift operators (`< <`,
//                `> > >`) and `isInGamut` contained `& &`. All operators repaired.
//              • IES candela indexing was horizontal-fastest (`vi*nH+hi`) while LM-63 stores
//                vertical-fastest → every profile sampled the wrong direction. Fixed to
//                `hi*nV+vi`, plus horizontal symmetry folding (0–90 / 0–180 / 0–360 grids),
//                axial symmetry (nH === 1), `TILT=INCLUDE` block skipping, token-cursor parsing
//                across line breaks, bounds guards, and binary-search interpolation.
//              • `temperatureToXyz` extrapolated Krystek's fit to 40000 K (invalid) and could
//                divide by y === 0. Clamped to the fit's valid 1000–15000 K range with a guard.
//              • LAB used a D50 white point against a D65 XYZ conversion (mismatched whites).
//                LAB now consistently uses D65; explicit Bradford D65↔D50 adapters are exported
//                for D50 workflows.
//              • `tonemapUchimura` was a stub (`1-exp(-x)`); replaced with the real Uchimura/GT
//                piecewise curve. `tonemapAcesHill` now applies the standard 1/0.6 input scale.
//              • Per-call closures (`hue2rgb`, `rrt`, `f`) and per-call array literals (ACES
//                matrices, palette delta tables) hoisted to module constants — Blueprint §10/§16.
//              • `linearToSrgb8` now clamps to [0,255]; `hexToRgb` accepts #RGBA/#RRGGBBAA;
//                `hsvToRgbSOA` wraps negative hues; `soaMixColors` accepts plain Arrays.
//              • ES2022 static blocks / private static fields removed so the file parses on older
//                Android WebViews; warm-up runs in a plain IIFE.
//
//              FEATURES ADDED from corrected_bitecs_enhancement.md:
//              • §25/§28 — `writeColorsRGBA` / `packColorsRGBA8` / `syncInstancedColor`: single-pass
//                colour upload straight into an InstancedBufferAttribute backing array with
//                `clearUpdateRanges` / `addUpdateRange` dirty-prefix upload. No `[r,g,b]` literals.
//              • §26     — Double-single precision bridge: `dsSubInto` / `dsDistanceSq` perform a
//                Knuth twoSum plus renormalization BEFORE any narrowing cast, so IES photometry
//                stays exact at megaparsec offsets (`iesToRadianceDS`, `soaIESEvaluateDS`).
//              • §30     — LUT authoring: `buildTonemapLUT`, `buildGradientLUT`, `buildBlackbodyLUT`,
//                `buildIESLUT` (+ chunked variants) write DataTexture-ready buffers with zero
//                per-sample allocation.
//              • §34     — Every matrix / white point / delta table is a pre-allocated constant.
//              • §45/§51 — `colorSpringDamp` / `soaColorSpringDamp` (+ chunked) designed for FIXED
//                dt, plus a re-exported `createFixedStepScheduler` (spiral-of-death guarded).
//              • §10/§16 — Precision-change listener rebuilds scratch pools at switch time only;
//                `ColorBatchState` tracks its SOAs so `setPrecision()` migrates them live.
//              • Auto-exposure (`soaLuminance`, `soaAverageLogLuminance`, `keyExposure`), row-major
//                colour-grading matrices, AgX-approx tone mapping, OKLab perceptual gradients,
//                and `IESProfile` (evaluate / direction / radiance / normalize / LUT / dispose).
//####
//Best for : 3d graphics — HDR PBR pipelines with ACES/AgX tone mapping over 1M+ instances,
//           physically-based IES light profiles (architectural interiors, street lights, stadium
//           bulbs), per-instance colour grading of asteroid belts / foliage / nebulae, procedural
//           palettes driven by simplex noise, gradient-driven HUD and shader parameters, LUT
//           authoring for mobile post-processing, perceptual material matching (CIEDE2000),
//           OKLCH brand-colour gamut mapping, blackbody star temperatures, auto-exposure for
//           galactic fly-throughs, and mobile-safe async evaluation of 1M+ IES lookups on
//           Android 64-bit without a single frame-loop allocation.
//License : MIT

// ============================================================================
// Imports — ESM named imports from the unified math entry point
// ============================================================================
import {
    common,
    vec3,
    vec4,
    mat3,
    double,
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getSOAPrecision,
    getArrayType,
    trackSOA,
    untrackSOA,
    createVec3SOA,
    createVec4SOA,
    createColorSOA,
    createFixedStepScheduler
} from "./000_Math_module.js";

export const VERSION = "1.1.0-esm";

// Precision plumbing re-exports
export {
    getPrecision,
    setPrecision,
    onPrecisionChange,
    getSOAPrecision,
    getArrayType,
    trackSOA,
    untrackSOA,
    createFixedStepScheduler
};

// ============================================================================
// Constants — pre-allocated, never rebuilt (Blueprint §34)
// ============================================================================
const PI = Math.PI;
const TAU = PI * 2;
const DEG2RAD = PI / 180;
const RAD2DEG = 180 / PI;
const EPSILON = 1e-6;
const INV_LN2 = 1 / Math.LN2;

const SRGB_A = 0.055;
const SRGB_1_2_4 = 1 / 2.4;
const SRGB_2_4 = 2.4;

// Row-major 3×3 matrices. These are PRIVATE to this module and are always
// applied with the row-major helpers below — never handed to mat3 (column-major).
const M_RGB2XYZ = new Float64Array([
    0.4124564, 0.3575761, 0.1804375,
    0.2126729, 0.7151522, 0.0721750,
    0.0193339, 0.1191920, 0.9503041
]);
const M_XYZ2RGB = new Float64Array([
    3.2404542, -1.5371385, -0.4985314,
    -0.9692660, 1.8760108, 0.0415560,
    0.0556434, -0.2040259, 1.0572252
]);

// Bradford chromatic adaptation (D65 ↔ D50), row-major.
const M_D65_TO_D50 = new Float64Array([
    1.0478112, 0.0228866, -0.0501270,
    0.0295424, 0.9904844, -0.0170491,
    -0.0092345, 0.0150436, 0.7521316
]);
const M_D50_TO_D65 = new Float64Array([
    0.9555766, -0.0230393, 0.0631636,
    -0.0282895, 1.0099416, 0.0210077,
    0.0122982, -0.0204830, 1.3299098
]);

export const XYZ_WHITE_D65 = new Float64Array([0.95047, 1.0, 1.08883]);
export const XYZ_WHITE_D50 = new Float64Array([0.96422, 1.0, 0.82521]);

// OKLab (Björn Ottosson, 2020), row-major.
const M_RGB2LMS_OK = new Float64Array([
    0.4122214708, 0.5363325363, 0.0514459929,
    0.2119034982, 0.6806995451, 0.1073969566,
    0.0883024619, 0.2817188376, 0.6299787005
]);
const M_LMS2LAB_OK = new Float64Array([
    0.2104542553, 0.7936177850, -0.0040720468,
    1.9779984951, -2.4285922050, 0.4505937099,
    0.0259040371, 0.7827717662, -0.8086757660
]);
const M_LAB2LMS_OK = new Float64Array([
    1.0, 0.3963377774, 0.2158037573,
    1.0, -0.1055613458, -0.0638541728,
    1.0, -0.0894841775, -1.2914855480
]);
const M_LMS2RGB_OK = new Float64Array([
    4.0767416621, -3.3077115913, 0.2309699292,
    -1.2684380046, 2.6097574011, -0.3413193965,
    -0.0041960863, -0.7034186147, 1.7076147010
]);

// YIQ / YUV (BT.601), row-major.
const M_RGB2YIQ = new Float64Array([
    0.299, 0.587, 0.114,
    0.596, -0.274, -0.322,
    0.211, -0.523, 0.312
]);
const M_YIQ2RGB = new Float64Array([
    1.0, 0.956, 0.621,
    1.0, -0.272, -0.647,
    1.0, -1.106, 1.703
]);
const M_RGB2YUV = new Float64Array([
    0.299, 0.587, 0.114,
    -0.14713, -0.28886, 0.436,
    0.615, -0.51499, -0.10001
]);
const M_YUV2RGB = new Float64Array([
    1.0, 0.0, 1.13983,
    1.0, -0.39465, -0.58060,
    1.0, 2.03211, 0.0
]);

// Rec.709 / BT.601 luma coefficients.
export const LUMA_R709 = 0.2126;
export const LUMA_G709 = 0.7152;
export const LUMA_B709 = 0.0722;
const LUMA_R601 = 0.299;
const LUMA_G601 = 0.587;
const LUMA_B601 = 0.114;

// ACES Hill (RRT + ODT fit), row-major.
const ACES_IN = new Float64Array([
    0.59719, 0.35458, 0.04823,
    0.07600, 0.90834, 0.01566,
    0.02840, 0.13383, 0.83777
]);
const ACES_OUT = new Float64Array([
    1.60475, -0.53108, -0.07367,
    -0.10208, 1.10813, -0.00605,
    -0.00327, -0.07276, 1.07602
]);
const ACES_HILL_INPUT_SCALE = 1 / 0.6;

// AgX (Sobotka) inset / outset, row-major. Row sums are exactly 1 (white preserving).
const AGX_INSET = new Float64Array([
    0.856627153315983, 0.0951212405381588, 0.0482516061458583,
    0.137318972929847, 0.761241990602591, 0.101439036467562,
    0.111898212999950, 0.0767994186031903, 0.811302368396859
]);
const AGX_OUTSET = new Float64Array([
    1.1271005818144368, -0.11060664309660323, -0.016493938717834573,
    -0.1413297634984383, 1.15782370221627200, -0.016493938717834257,
    -0.1413297634984383, -0.11060664309660294, 1.251936406595040500
]);
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;
const AGX_EV_SPAN = AGX_MAX_EV - AGX_MIN_EV;

// Uchimura / Gran Turismo curve constants.
const UC_P = 1.0;   // max display brightness
const UC_A = 1.0;   // contrast
const UC_M = 0.22;  // linear section start
const UC_L = 0.4;   // linear section length
const UC_C = 1.33;  // black tightness
const UC_B = 0.0;   // pedestal
const UC_L0 = ((UC_P - UC_M) * UC_L) / UC_A;
const UC_S0 = UC_M + UC_L0;
const UC_S1 = UC_M + UC_A * UC_L0;
const UC_C2 = (UC_A * UC_P) / (UC_P - UC_S1);
const UC_CP = -UC_C2 / UC_P;

// Filmic / Uncharted2 curve constants + precomputed white scale.
const FILMIC_W = 11.2;
const UNCHARTED_W = 11.2;
function _filmicCurve(x) {
    const A = 0.22, B = 0.30, C = 0.10, D = 0.20, E = 0.01, F = 0.30;
    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
function _unchartedCurve(x) {
    const A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
const FILMIC_W_SCALE = 1 / _filmicCurve(FILMIC_W);
const UNCHARTED_W_SCALE = 1 / _unchartedCurve(UNCHARTED_W);

// CIEDE2000 constant.
const POW25_7 = 6103515625; // 25^7

// Palette hue-offset tables (hoisted — never allocated per call).
const DELTA_ANALOGOUS = new Float64Array([-2, -1, 0, 1, 2]);
const DELTA_TRIADIC = new Float64Array([0, 1 / 3, 2 / 3]);
const DELTA_TETRADIC = new Float64Array([0, 0.25, 0.5, 0.75]);
const DELTA_SPLIT = new Float64Array([0, 0.5 - 1 / 12, 0.5 + 1 / 12]);

// Tone-map operator ids (resolved ONCE outside every hot loop).
export const TONEMAP_NONE = 0;
export const TONEMAP_REINHARD = 1;
export const TONEMAP_REINHARD_EXT = 2;
export const TONEMAP_ACES = 3;
export const TONEMAP_ACES_HILL = 4;
export const TONEMAP_AGX = 5;
export const TONEMAP_UCHIMURA = 6;
export const TONEMAP_FILMIC = 7;
export const TONEMAP_UNCHARTED2 = 8;

// Gradient interpolation ids.
export const GRADIENT_LINEAR = 0;
export const GRADIENT_COSINE = 1;
export const GRADIENT_CATMULL_ROM = 2;
export const GRADIENT_STEP = 3;
export const GRADIENT_OKLAB = 4;

// ============================================================================
// Module scratch — distinct slots per conversion family so chains never alias.
// ============================================================================
const _xyz3 = new Float64Array(3);   // rgbToLab / labToRgb / blackbodyRgb
const _oklab3 = new Float64Array(3);   // rgbToOklch (internal)
const _lch3 = new Float64Array(3);   // gamut mapping / hue rotation
const _tmA = new Float64Array(3);   // ACES Hill / AgX stage A
const _tmB = new Float64Array(3);   // ACES Hill / AgX stage B
const _ds2 = new Float64Array(2);   // double-single [hi, lo]
const _ang2 = new Float64Array(2);   // IES angle scratch
const _hsl3 = new Float64Array(3);   // palette generators

// ============================================================================
// Pools — precision-aware; rebuilt on setPrecision() (setup path only)
// ============================================================================
const _colorPool = common.createPool(
    function () { const c = new (getArrayType())(4); c[3] = 1; return { c: c }; },
    128,
    function (s) { s.c[0] = 0; s.c[1] = 0; s.c[2] = 0; s.c[3] = 1; }
);

export function createColorPool(capacity) {
    return common.createPool(
        function () { const c = new (getArrayType())(4); c[3] = 1; return { c: c }; },
        capacity || 128,
        function (s) { s.c[0] = 0; s.c[1] = 0; s.c[2] = 0; s.c[3] = 1; }
    );
}
export function acquireColor() { return _colorPool.acquire(); }
export function releaseColor(s) { if (s) _colorPool.release(s); }

// ============================================================================
// Small helpers
// ============================================================================
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function clamp1(v) { return v < -1 ? -1 : (v > 1 ? 1 : v); }
function _isArr(t) { return t != null && t.length !== undefined; }
function _hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}
function _mat3Row(out, m, x, y, z) {
    out[0] = m[0] * x + m[1] * y + m[2] * z;
    out[1] = m[3] * x + m[4] * y + m[5] * z;
    out[2] = m[6] * x + m[7] * y + m[8] * z;
    return out;
}

// ============================================================================
// sRGB ↔ Linear
// ============================================================================
export function srgbToLinear(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + SRGB_A) / (1 + SRGB_A), SRGB_2_4);
}
export function linearToSrgb(v) {
    return v <= 0.0031308 ? v * 12.92 : (1 + SRGB_A) * Math.pow(v, SRGB_1_2_4) - SRGB_A;
}
export function srgbToLinear8(v) { return srgbToLinear(v / 255); }
export function linearToSrgb8(v) {
    const s = linearToSrgb(v) * 255;
    return s < 0 ? 0 : (s > 255 ? 255 : Math.round(s));
}

// ============================================================================
// HSV / HSL
// ============================================================================
export function rgbToHsv(out, r, g, b) {
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    out[0] = h; out[1] = max !== 0 ? d / max : 0; out[2] = max;
    return out;
}
export function hsvToRgb(out, h, s, v) {
    h = h - Math.floor(h);
    const hi = h * 6;
    const i = Math.floor(hi);
    const f = hi - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: out[0] = v; out[1] = t; out[2] = p; break;
        case 1: out[0] = q; out[1] = v; out[2] = p; break;
        case 2: out[0] = p; out[1] = v; out[2] = t; break;
        case 3: out[0] = p; out[1] = q; out[2] = v; break;
        case 4: out[0] = t; out[1] = p; out[2] = v; break;
        default: out[0] = v; out[1] = p; out[2] = q; break;
    }
    return out;
}
export function rgbToHsl(out, r, g, b) {
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const l = (max + min) * 0.5;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    out[0] = h; out[1] = s; out[2] = l;
    return out;
}
export function hslToRgb(out, h, s, l) {
    if (s === 0) { out[0] = l; out[1] = l; out[2] = l; return out; }
    h = h - Math.floor(h);
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    out[0] = _hue2rgb(p, q, h + 1 / 3);
    out[1] = _hue2rgb(p, q, h);
    out[2] = _hue2rgb(p, q, h - 1 / 3);
    return out;
}

export function rgbToHsvSOA(outHsv, inRgb, count) {
    count = count === undefined ? inRgb.count : count;
    const r = inRgb.x, g = inRgb.y, b = inRgb.z;
    const oh = outHsv.x, os = outHsv.y, ov = outHsv.z;
    for (let i = 0; i < count; i++) {
        const ri = r[i], gi = g[i], bi = b[i];
        const max = ri > gi ? (ri > bi ? ri : bi) : (gi > bi ? gi : bi);
        const min = ri < gi ? (ri < bi ? ri : bi) : (gi < bi ? gi : bi);
        const d = max - min;
        let h = 0;
        if (d !== 0) {
            if (max === ri) h = ((gi - bi) / d + (gi < bi ? 6 : 0)) / 6;
            else if (max === gi) h = ((bi - ri) / d + 2) / 6;
            else h = ((ri - gi) / d + 4) / 6;
        }
        oh[i] = h; os[i] = max !== 0 ? d / max : 0; ov[i] = max;
    }
    return outHsv;
}
export function hsvToRgbSOA(outRgb, inHsv, count) {
    count = count === undefined ? inHsv.count : count;
    const h = inHsv.x, s = inHsv.y, v = inHsv.z;
    const or_ = outRgb.x, og = outRgb.y, ob = outRgb.z;
    for (let i = 0; i < count; i++) {
        let hi = h[i]; hi = (hi - Math.floor(hi)) * 6;
        const ii = Math.floor(hi), fi = hi - ii;
        const si = s[i], vi = v[i];
        const p = vi * (1 - si), q = vi * (1 - fi * si), t = vi * (1 - (1 - fi) * si);
        switch (ii % 6) {
            case 0: or_[i] = vi; og[i] = t; ob[i] = p; break;
            case 1: or_[i] = q; og[i] = vi; ob[i] = p; break;
            case 2: or_[i] = p; og[i] = vi; ob[i] = t; break;
            case 3: or_[i] = p; og[i] = q; ob[i] = vi; break;
            case 4: or_[i] = t; og[i] = p; ob[i] = vi; break;
            default: or_[i] = vi; og[i] = p; ob[i] = q; break;
        }
    }
    return outRgb;
}
export function rgbToHslSOA(outHsl, inRgb, count) {
    count = count === undefined ? inRgb.count : count;
    const r = inRgb.x, g = inRgb.y, b = inRgb.z;
    const oh = outHsl.x, os = outHsl.y, ol = outHsl.z;
    for (let i = 0; i < count; i++) {
        const ri = r[i], gi = g[i], bi = b[i];
        const max = ri > gi ? (ri > bi ? ri : bi) : (gi > bi ? gi : bi);
        const min = ri < gi ? (ri < bi ? ri : bi) : (gi < bi ? gi : bi);
        const l = (max + min) * 0.5;
        let h = 0, s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === ri) h = ((gi - bi) / d + (gi < bi ? 6 : 0)) / 6;
            else if (max === gi) h = ((bi - ri) / d + 2) / 6;
            else h = ((ri - gi) / d + 4) / 6;
        }
        oh[i] = h; os[i] = s; ol[i] = l;
    }
    return outHsl;
}
export function hslToRgbSOA(outRgb, inHsl, count) {
    count = count === undefined ? inHsl.count : count;
    const h = inHsl.x, s = inHsl.y, l = inHsl.z;
    const or_ = outRgb.x, og = outRgb.y, ob = outRgb.z;
    for (let i = 0; i < count; i++) {
        const li = l[i], si = s[i];
        if (si === 0) { or_[i] = li; og[i] = li; ob[i] = li; continue; }
        let hi = h[i]; hi = hi - Math.floor(hi);
        const q = li < 0.5 ? li * (1 + si) : li + si - li * si;
        const p = 2 * li - q;
        or_[i] = _hue2rgb(p, q, hi + 1 / 3);
        og[i] = _hue2rgb(p, q, hi);
        ob[i] = _hue2rgb(p, q, hi - 1 / 3);
    }
    return outRgb;
}

// ============================================================================
// XYZ / LAB / LCH  (LAB uses the D65 reference white to match sRGB)
// ============================================================================
export function rgbToXyz(out, r, g, b) { return _mat3Row(out, M_RGB2XYZ, r, g, b); }
export function xyzToRgb(out, x, y, z) { return _mat3Row(out, M_XYZ2RGB, x, y, z); }
export function xyzD65ToD50(out, x, y, z) { return _mat3Row(out, M_D65_TO_D50, x, y, z); }
export function xyzD50ToD65(out, x, y, z) { return _mat3Row(out, M_D50_TO_D65, x, y, z); }

function _labF(t) { return t > 0.008856451679 ? Math.cbrt(t) : (903.2962962 * t + 16) / 116; }
function _labFInv(t) {
    const t3 = t * t * t;
    return t3 > 0.008856451679 ? t3 : (116 * t - 16) / 903.2962962;
}

/** XYZ (D65) → CIE L*a*b* (D65). out = [L*, a*, b*]. */
export function xyzToLab(out, x, y, z) {
    const fx = _labF(x / XYZ_WHITE_D65[0]);
    const fy = _labF(y / XYZ_WHITE_D65[1]);
    const fz = _labF(z / XYZ_WHITE_D65[2]);
    out[0] = 116 * fy - 16;
    out[1] = 500 * (fx - fy);
    out[2] = 200 * (fy - fz);
    return out;
}
/** CIE L*a*b* (D65) → XYZ (D65). */
export function labToXyz(out, L, a, b) {
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    out[0] = XYZ_WHITE_D65[0] * _labFInv(fx);
    out[1] = XYZ_WHITE_D65[1] * _labFInv(fy);
    out[2] = XYZ_WHITE_D65[2] * _labFInv(fz);
    return out;
}
export function rgbToLab(out, r, g, b) {
    rgbToXyz(_xyz3, r, g, b);
    return xyzToLab(out, _xyz3[0], _xyz3[1], _xyz3[2]);
}
export function labToRgb(out, L, a, b) {
    labToXyz(_xyz3, L, a, b);
    return xyzToRgb(out, _xyz3[0], _xyz3[1], _xyz3[2]);
}
/** LAB → LCH. out = [L*, C*, h] with h in RADIANS [0, 2π). */
export function labToLch(out, L, a, b) {
    let h = Math.atan2(b, a);
    if (h < 0) h += TAU;
    out[0] = L; out[1] = Math.sqrt(a * a + b * b); out[2] = h;
    return out;
}
export function lchToLab(out, L, C, h) {
    out[0] = L; out[1] = C * Math.cos(h); out[2] = C * Math.sin(h);
    return out;
}

export function soaRgbToLab(outLab, colors, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    const oL = outLab.x, oA = outLab.y, oB = outLab.z;
    for (let i = 0; i < count; i++) {
        rgbToLab(_xyz3, r[i], g[i], b[i]);
        oL[i] = _xyz3[0]; oA[i] = _xyz3[1]; oB[i] = _xyz3[2];
    }
    return outLab;
}
export function soaLabToRgb(outRgb, lab, count) {
    count = count === undefined ? lab.count : count;
    const L = lab.x, A = lab.y, B = lab.z;
    const or_ = outRgb.x, og = outRgb.y, ob = outRgb.z;
    for (let i = 0; i < count; i++) {
        labToRgb(_xyz3, L[i], A[i], B[i]);
        or_[i] = _xyz3[0]; og[i] = _xyz3[1]; ob[i] = _xyz3[2];
    }
    return outRgb;
}

// ============================================================================
// OKLab / OKLCH
// ============================================================================
export function rgbToOklab(out, r, g, b) {
    const l = M_RGB2LMS_OK[0] * r + M_RGB2LMS_OK[1] * g + M_RGB2LMS_OK[2] * b;
    const m = M_RGB2LMS_OK[3] * r + M_RGB2LMS_OK[4] * g + M_RGB2LMS_OK[5] * b;
    const s = M_RGB2LMS_OK[6] * r + M_RGB2LMS_OK[7] * g + M_RGB2LMS_OK[8] * b;
    const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    out[0] = M_LMS2LAB_OK[0] * l_ + M_LMS2LAB_OK[1] * m_ + M_LMS2LAB_OK[2] * s_;
    out[1] = M_LMS2LAB_OK[3] * l_ + M_LMS2LAB_OK[4] * m_ + M_LMS2LAB_OK[5] * s_;
    out[2] = M_LMS2LAB_OK[6] * l_ + M_LMS2LAB_OK[7] * m_ + M_LMS2LAB_OK[8] * s_;
    return out;
}
export function oklabToRgb(out, L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    out[0] = M_LMS2RGB_OK[0] * l + M_LMS2RGB_OK[1] * m + M_LMS2RGB_OK[2] * s;
    out[1] = M_LMS2RGB_OK[3] * l + M_LMS2RGB_OK[4] * m + M_LMS2RGB_OK[5] * s;
    out[2] = M_LMS2RGB_OK[6] * l + M_LMS2RGB_OK[7] * m + M_LMS2RGB_OK[8] * s;
    return out;
}
export function oklabToOklch(out, L, a, b) {
    let h = Math.atan2(b, a);
    if (h < 0) h += TAU;
    out[0] = L; out[1] = Math.sqrt(a * a + b * b); out[2] = h;
    return out;
}
export function oklchToOklab(out, L, C, h) {
    out[0] = L; out[1] = C * Math.cos(h); out[2] = C * Math.sin(h);
    return out;
}
export function rgbToOklch(out, r, g, b) {
    rgbToOklab(_oklab3, r, g, b);
    return oklabToOklch(out, _oklab3[0], _oklab3[1], _oklab3[2]);
}
export function oklchToRgb(out, L, C, h) {
    return oklabToRgb(out, L, C * Math.cos(h), C * Math.sin(h));
}

export function soaRgbToOklab(outLab, colors, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    const oL = outLab.x, oA = outLab.y, oB = outLab.z;
    for (let i = 0; i < count; i++) {
        const ri = r[i], gi = g[i], bi = b[i];
        const l = M_RGB2LMS_OK[0] * ri + M_RGB2LMS_OK[1] * gi + M_RGB2LMS_OK[2] * bi;
        const m = M_RGB2LMS_OK[3] * ri + M_RGB2LMS_OK[4] * gi + M_RGB2LMS_OK[5] * bi;
        const s = M_RGB2LMS_OK[6] * ri + M_RGB2LMS_OK[7] * gi + M_RGB2LMS_OK[8] * bi;
        const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
        oL[i] = M_LMS2LAB_OK[0] * l_ + M_LMS2LAB_OK[1] * m_ + M_LMS2LAB_OK[2] * s_;
        oA[i] = M_LMS2LAB_OK[3] * l_ + M_LMS2LAB_OK[4] * m_ + M_LMS2LAB_OK[5] * s_;
        oB[i] = M_LMS2LAB_OK[6] * l_ + M_LMS2LAB_OK[7] * m_ + M_LMS2LAB_OK[8] * s_;
    }
    return outLab;
}
export function soaOklabToRgb(outRgb, lab, count) {
    count = count === undefined ? lab.count : count;
    const L = lab.x, A = lab.y, B = lab.z;
    const or_ = outRgb.x, og = outRgb.y, ob = outRgb.z;
    for (let i = 0; i < count; i++) {
        const Li = L[i], Ai = A[i], Bi = B[i];
        const l_ = Li + 0.3963377774 * Ai + 0.2158037573 * Bi;
        const m_ = Li - 0.1055613458 * Ai - 0.0638541728 * Bi;
        const s_ = Li - 0.0894841775 * Ai - 1.2914855480 * Bi;
        const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
        or_[i] = M_LMS2RGB_OK[0] * l + M_LMS2RGB_OK[1] * m + M_LMS2RGB_OK[2] * s;
        og[i] = M_LMS2RGB_OK[3] * l + M_LMS2RGB_OK[4] * m + M_LMS2RGB_OK[5] * s;
        ob[i] = M_LMS2RGB_OK[6] * l + M_LMS2RGB_OK[7] * m + M_LMS2RGB_OK[8] * s;
    }
    return outRgb;
}
export function soaRgbToOklch(outLch, colors, count) {
    count = count === undefined ? colors.count : count;
    soaRgbToOklab(outLch, colors, count);
    const oL = outLch.x, oA = outLch.y, oB = outLch.z;
    for (let i = 0; i < count; i++) {
        const a = oA[i], b = oB[i];
        let h = Math.atan2(b, a);
        if (h < 0) h += TAU;
        oA[i] = Math.sqrt(a * a + b * b);
        oB[i] = h;
    }
    return outLch;
}
export function soaOklchToRgb(outRgb, lch, count) {
    count = count === undefined ? lch.count : count;
    const L = lch.x, C = lch.y, H = lch.z;
    const or_ = outRgb.x, og = outRgb.y, ob = outRgb.z;
    for (let i = 0; i < count; i++) {
        const Li = L[i], Ci = C[i], Hi = H[i];
        const a = Ci * Math.cos(Hi), b = Ci * Math.sin(Hi);
        const l_ = Li + 0.3963377774 * a + 0.2158037573 * b;
        const m_ = Li - 0.1055613458 * a - 0.0638541728 * b;
        const s_ = Li - 0.0894841775 * a - 1.2914855480 * b;
        const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
        or_[i] = M_LMS2RGB_OK[0] * l + M_LMS2RGB_OK[1] * m + M_LMS2RGB_OK[2] * s;
        og[i] = M_LMS2RGB_OK[3] * l + M_LMS2RGB_OK[4] * m + M_LMS2RGB_OK[5] * s;
        ob[i] = M_LMS2RGB_OK[6] * l + M_LMS2RGB_OK[7] * m + M_LMS2RGB_OK[8] * s;
    }
    return outRgb;
}

// ============================================================================
// YIQ / YUV / Hex / Packing
// ============================================================================
export function rgbToYiq(out, r, g, b) { return _mat3Row(out, M_RGB2YIQ, r, g, b); }
export function yiqToRgb(out, y, i, q) { return _mat3Row(out, M_YIQ2RGB, y, i, q); }
export function rgbToYuv(out, r, g, b) { return _mat3Row(out, M_RGB2YUV, r, g, b); }
export function yuvToRgb(out, y, u, v) { return _mat3Row(out, M_YUV2RGB, y, u, v); }

/** Accepts #RGB, #RGBA, #RRGGBB, #RRGGBBAA (with or without '#'). */
export function hexToRgb(out, hex) {
    let s = String(hex);
    if (s.charCodeAt(0) === 35) s = s.slice(1);
    if (s.length === 3 || s.length === 4) {
        let exp = "";
        for (let i = 0; i < s.length; i++) exp += s[i] + s[i];
        s = exp;
    }
    const n = parseInt(s, 16);
    if (s.length >= 8) {
        out[0] = ((n >>> 24) & 255) / 255;
        out[1] = ((n >>> 16) & 255) / 255;
        out[2] = ((n >>> 8) & 255) / 255;
        out[3] = (n & 255) / 255;
    } else {
        out[0] = ((n >> 16) & 255) / 255;
        out[1] = ((n >> 8) & 255) / 255;
        out[2] = (n & 255) / 255;
    }
    return out;
}
export function rgbToHex(r, g, b) {
    const ri = Math.round(clamp01(r) * 255);
    const gi = Math.round(clamp01(g) * 255);
    const bi = Math.round(clamp01(b) * 255);
    return "#" + ((1 << 24) | (ri << 16) | (gi << 8) | bi).toString(16).slice(1);
}
export function rgbaToHex8(r, g, b, a) {
    const ai = Math.round(clamp01(a === undefined ? 1 : a) * 255);
    return rgbToHex(r, g, b) + (ai < 16 ? "0" : "") + ai.toString(16);
}
/** Little-endian RGBA8 packed into an unsigned 32-bit integer (R in low byte). */
export function packRGBA(r, g, b, a) {
    const ri = Math.round(clamp01(r) * 255);
    const gi = Math.round(clamp01(g) * 255);
    const bi = Math.round(clamp01(b) * 255);
    const ai = Math.round(clamp01(a === undefined ? 1 : a) * 255);
    return ((ai << 24) | (bi << 16) | (gi << 8) | ri) >>> 0;
}
export function unpackRGBA(out, p) {
    out[0] = (p & 0xff) / 255;
    out[1] = ((p >>> 8) & 0xff) / 255;
    out[2] = ((p >>> 16) & 0xff) / 255;
    out[3] = ((p >>> 24) & 0xff) / 255;
    return out;
}

// ============================================================================
// Blackbody temperature (Krystek rational fit, valid 1000–15000 K)
// ============================================================================
export function temperatureToXyz(out, T) {
    T = T < 1000 ? 1000 : (T > 15000 ? 15000 : T);
    const t2 = T * T, t3 = t2 * T;
    let x;
    if (T <= 4000) {
        x = -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / T + 0.179910;
    } else {
        x = -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / T + 0.240390;
    }
    const x2 = x * x, x3 = x2 * x;
    let y;
    if (T <= 2222) {
        y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
    } else if (T <= 4000) {
        y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
    } else {
        y = 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
    }
    if (y < 1e-6) y = 1e-6;
    out[0] = x / y;
    out[1] = 1.0;
    out[2] = (1 - x - y) / y;
    return out;
}
/** Normalized display colour (max component = 1). For radiance use the XYZ form. */
export function blackbodyRgb(out, T) {
    temperatureToXyz(_xyz3, T);
    xyzToRgb(out, _xyz3[0], _xyz3[1], _xyz3[2]);
    let max = out[0] > out[1] ? out[0] : out[1];
    if (out[2] > max) max = out[2];
    if (max > 0) { out[0] /= max; out[1] /= max; out[2] /= max; }
    if (out[0] < 0) out[0] = 0;
    if (out[1] < 0) out[1] = 0;
    if (out[2] < 0) out[2] = 0;
    return out;
}
export function temperatureToRgb(out, T) { return blackbodyRgb(out, T); }
/** Un-normalized linear-sRGB chromaticity at unit luminance (HDR-safe). */
export function blackbodyRgbLinear(out, T) {
    temperatureToXyz(_xyz3, T);
    return xyzToRgb(out, _xyz3[0], _xyz3[1], _xyz3[2]);
}

// ============================================================================
// Tone mapping
// ============================================================================
export function tonemapReinhard(out, r, g, b) {
    out[0] = r / (1 + r); out[1] = g / (1 + g); out[2] = b / (1 + b);
    return out;
}
export function tonemapReinhardExt(out, r, g, b, white) {
    const w = white === undefined ? 1 : white;
    const w2 = w * w;
    out[0] = r * (1 + r / w2) / (1 + r);
    out[1] = g * (1 + g / w2) / (1 + g);
    out[2] = b * (1 + b / w2) / (1 + b);
    return out;
}
/** Narkowicz ACES fit — fast, per-channel. */
export function tonemapAces(out, r, g, b) {
    out[0] = (r * (2.51 * r + 0.03)) / (r * (2.43 * r + 0.59) + 0.14);
    out[1] = (g * (2.51 * g + 0.03)) / (g * (2.43 * g + 0.59) + 0.14);
    out[2] = (b * (2.51 * b + 0.03)) / (b * (2.43 * b + 0.59) + 0.14);
    return out;
}
function _rrtFit(v) {
    return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
}
/** Hill ACES (RRT+ODT fit) with the standard 1/0.6 input scale. Zero pool traffic. */
export function tonemapAcesHill(out, r, g, b) {
    const s = ACES_HILL_INPUT_SCALE;
    _mat3Row(_tmA, ACES_IN, r * s, g * s, b * s);
    _mat3Row(_tmB, ACES_OUT, _rrtFit(_tmA[0]), _rrtFit(_tmA[1]), _rrtFit(_tmA[2]));
    out[0] = clamp01(_tmB[0]); out[1] = clamp01(_tmB[1]); out[2] = clamp01(_tmB[2]);
    return out;
}
function _agxContrast(x) {
    const x2 = x * x, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
        - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
function _agxChannel(v) {
    if (v < 1e-10) v = 1e-10;
    return clamp01((Math.log(v) * INV_LN2 - AGX_MIN_EV) / AGX_EV_SPAN);
}
/**
 * AgX approximation (Sobotka inset/outset + log encoding + contrast polynomial).
 * Omits the Rec.2020 gamut round-trip used by some reference implementations —
 * visually near-identical, substantially cheaper on mobile.
 */
export function tonemapAgX(out, r, g, b) {
    _mat3Row(_tmA, AGX_INSET, r, g, b);
    _tmA[0] = _agxContrast(_agxChannel(_tmA[0]));
    _tmA[1] = _agxContrast(_agxChannel(_tmA[1]));
    _tmA[2] = _agxContrast(_agxChannel(_tmA[2]));
    _mat3Row(_tmB, AGX_OUTSET, _tmA[0], _tmA[1], _tmA[2]);
    out[0] = clamp01(Math.pow(_tmB[0] < 0 ? 0 : _tmB[0], 2.2));
    out[1] = clamp01(Math.pow(_tmB[1] < 0 ? 0 : _tmB[1], 2.2));
    out[2] = clamp01(Math.pow(_tmB[2] < 0 ? 0 : _tmB[2], 2.2));
    return out;
}
function _uchimuraChannel(x) {
    if (x <= 0) return 0;
    const w0 = 1 - clamp01(x / UC_M);
    const w2 = x >= UC_S0 ? 1 : 0;
    const w1 = 1 - w0 - w2;
    const T = UC_M * Math.pow(x / UC_M, UC_C) + UC_B;
    const S = UC_P - (UC_P - UC_S1) * Math.exp(UC_CP * (x - UC_S0));
    const L = UC_M + UC_A * (x - UC_M);
    return T * w0 + L * w1 + S * w2;
}
/** Uchimura / Gran Turismo filmic curve (real piecewise implementation). */
export function tonemapUchimura(out, r, g, b) {
    out[0] = clamp01(_uchimuraChannel(r));
    out[1] = clamp01(_uchimuraChannel(g));
    out[2] = clamp01(_uchimuraChannel(b));
    return out;
}
export function tonemapFilmic(out, r, g, b) {
    out[0] = _filmicCurve(r) * FILMIC_W_SCALE;
    out[1] = _filmicCurve(g) * FILMIC_W_SCALE;
    out[2] = _filmicCurve(b) * FILMIC_W_SCALE;
    return out;
}
export function tonemapUncharted2(out, r, g, b) {
    out[0] = _unchartedCurve(r) * UNCHARTED_W_SCALE;
    out[1] = _unchartedCurve(g) * UNCHARTED_W_SCALE;
    out[2] = _unchartedCurve(b) * UNCHARTED_W_SCALE;
    return out;
}
export function expose(out, r, g, b, exposure) {
    out[0] = r * exposure; out[1] = g * exposure; out[2] = b * exposure;
    return out;
}
/** Gamma ENCODE (linear → gamma space). Use gammaDecode for the inverse. */
export function gammaCorrect(out, r, g, b, gamma) {
    const inv = 1 / (gamma || 2.2);
    out[0] = Math.pow(r < 0 ? 0 : r, inv);
    out[1] = Math.pow(g < 0 ? 0 : g, inv);
    out[2] = Math.pow(b < 0 ? 0 : b, inv);
    return out;
}
/** Gamma DECODE (gamma space → linear). */
export function gammaDecode(out, r, g, b, gamma) {
    const e = gamma || 2.2;
    out[0] = Math.pow(r < 0 ? 0 : r, e);
    out[1] = Math.pow(g < 0 ? 0 : g, e);
    out[2] = Math.pow(b < 0 ? 0 : b, e);
    return out;
}

export function resolveTonemapOp(op) {
    if (typeof op === "number") return op | 0;
    switch (String(op || "aces")) {
        case "none": return TONEMAP_NONE;
        case "reinhard": return TONEMAP_REINHARD;
        case "reinhardExt": case "reinhardExtended": return TONEMAP_REINHARD_EXT;
        case "aces": return TONEMAP_ACES;
        case "acesHill": return TONEMAP_ACES_HILL;
        case "agx": return TONEMAP_AGX;
        case "uchimura": case "gt": return TONEMAP_UCHIMURA;
        case "filmic": return TONEMAP_FILMIC;
        case "uncharted2": case "hable": return TONEMAP_UNCHARTED2;
        default: return TONEMAP_ACES;
    }
}
function _tonemapById(out, r, g, b, id, white) {
    switch (id) {
        case TONEMAP_NONE: out[0] = r; out[1] = g; out[2] = b; break;
        case TONEMAP_REINHARD: tonemapReinhard(out, r, g, b); break;
        case TONEMAP_REINHARD_EXT: tonemapReinhardExt(out, r, g, b, white); break;
        case TONEMAP_ACES_HILL: tonemapAcesHill(out, r, g, b); break;
        case TONEMAP_AGX: tonemapAgX(out, r, g, b); break;
        case TONEMAP_UCHIMURA: tonemapUchimura(out, r, g, b); break;
        case TONEMAP_FILMIC: tonemapFilmic(out, r, g, b); break;
        case TONEMAP_UNCHARTED2: tonemapUncharted2(out, r, g, b); break;
        default: tonemapAces(out, r, g, b); break;
    }
    return out;
}
/** Generic scalar dispatch — `op` may be a name or a TONEMAP_* id. */
export function tonemap(out, r, g, b, op, exposure, white) {
    const e = exposure === undefined ? 1 : exposure;
    return _tonemapById(out, r * e, g * e, b * e, resolveTonemapOp(op), white);
}

// ============================================================================
// Gamut mapping
// ============================================================================
export function isInGamut(r, g, b) {
    return r >= -EPSILON && r <= 1 + EPSILON &&
        g >= -EPSILON && g <= 1 + EPSILON &&
        b >= -EPSILON && b <= 1 + EPSILON;
}
export function clampGamut(out, r, g, b) {
    out[0] = clamp01(r); out[1] = clamp01(g); out[2] = clamp01(b);
    return out;
}
/**
 * Hue-preserving gamut compression via OKLCH chroma binary search.
 * Zero allocation (module scratch), configurable iteration count.
 */
export function mapToSrgbGamut(out, r, g, b, iterations) {
    if (isInGamut(r, g, b)) { out[0] = r; out[1] = g; out[2] = b; return out; }
    rgbToOklch(_lch3, r, g, b);
    const L = _lch3[0], h = _lch3[2];
    if (L <= 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    if (L >= 1) {
        oklchToRgb(out, 1, 0, h);
        return clampGamut(out, out[0], out[1], out[2]);
    }
    let lo = 0, hi = _lch3[1];
    const n = iterations === undefined ? 12 : iterations;
    for (let i = 0; i < n; i++) {
        const mid = (lo + hi) * 0.5;
        oklchToRgb(out, L, mid, h);
        if (isInGamut(out[0], out[1], out[2])) lo = mid; else hi = mid;
    }
    oklchToRgb(out, L, lo, h);
    return clampGamut(out, out[0], out[1], out[2]);
}
export function oklchGamutMap(out, L, C, h, iterations) {
    oklchToRgb(out, L, C, h);
    return mapToSrgbGamut(out, out[0], out[1], out[2], iterations);
}

// ============================================================================
// Perceptual colour differences
// ============================================================================
export function deltaE76(L1, a1, b1, L2, a2, b2) {
    const dL = L1 - L2, da = a1 - a2, db = b1 - b2;
    return Math.sqrt(dL * dL + da * da + db * db);
}
export function deltaE94(L1, a1, b1, L2, a2, b2, kL, kC, kH) {
    const dL = L1 - L2;
    const C1 = Math.sqrt(a1 * a1 + b1 * b1);
    const C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const dC = C1 - C2;
    const da = a1 - a2, db = b1 - b2;
    const dH2 = da * da + db * db - dC * dC;
    const dH = dH2 > 0 ? Math.sqrt(dH2) : 0;
    const tL = dL / ((kL === undefined ? 1 : kL));
    const tC = dC / ((kC === undefined ? 1 : kC) * (1 + 0.045 * C1));
    const tH = dH / ((kH === undefined ? 1 : kH) * (1 + 0.015 * C1));
    return Math.sqrt(tL * tL + tC * tC + tH * tH);
}
/** CIEDE2000 (Sharma et al. reference formulation). Inputs are CIE L*a*b*. */
export function deltaE2000(L1, a1, b1, L2, a2, b2) {
    const C1 = Math.sqrt(a1 * a1 + b1 * b1);
    const C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const Cb = (C1 + C2) * 0.5;
    const Cb7 = Math.pow(Cb, 7);
    const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + POW25_7)));
    const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
    const C1p = Math.sqrt(a1p * a1p + b1 * b1);
    const C2p = Math.sqrt(a2p * a2p + b2 * b2);
    let h1p = 0, h2p = 0;
    if (C1p !== 0) { h1p = Math.atan2(b1, a1p); if (h1p < 0) h1p += TAU; }
    if (C2p !== 0) { h2p = Math.atan2(b2, a2p); if (h2p < 0) h2p += TAU; }

    const dLp = L2 - L1;
    const dCp = C2p - C1p;
    let dhp = 0;
    const prod = C1p * C2p;
    if (prod !== 0) {
        dhp = h2p - h1p;
        if (dhp > PI) dhp -= TAU;
        else if (dhp < -PI) dhp += TAU;
    }
    const dHp = 2 * Math.sqrt(prod) * Math.sin(dhp * 0.5);

    const Lbp = (L1 + L2) * 0.5;
    const Cbp = (C1p + C2p) * 0.5;
    let hbp;
    if (prod === 0) hbp = h1p + h2p;
    else if (Math.abs(h1p - h2p) <= PI) hbp = (h1p + h2p) * 0.5;
    else if (h1p + h2p < TAU) hbp = (h1p + h2p + TAU) * 0.5;
    else hbp = (h1p + h2p - TAU) * 0.5;

    const T = 1
        - 0.17 * Math.cos(hbp - 30 * DEG2RAD)
        + 0.24 * Math.cos(2 * hbp)
        + 0.32 * Math.cos(3 * hbp + 6 * DEG2RAD)
        - 0.20 * Math.cos(4 * hbp - 63 * DEG2RAD);

    const dL50 = Lbp - 50;
    const SL = 1 + (0.015 * dL50 * dL50) / Math.sqrt(20 + dL50 * dL50);
    const SC = 1 + 0.045 * Cbp;
    const SH = 1 + 0.015 * Cbp * T;
    const Cbp7 = Math.pow(Cbp, 7);
    const dTheta = 30 * Math.exp(-Math.pow((hbp * RAD2DEG - 275) / 25, 2));
    const RC = 2 * Math.sqrt(Cbp7 / (Cbp7 + POW25_7));
    const RT = -Math.sin(2 * dTheta * DEG2RAD) * RC;

    const tL = dLp / SL, tC = dCp / SC, tH = dHp / SH;
    return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}
/** Per-row CIEDE2000 between two LAB SOAs. Writes into `out` (Float32Array). */
export function soaDeltaE2000(out, labA, labB, count) {
    count = count === undefined ? labA.count : count;
    const L1 = labA.x, A1 = labA.y, B1 = labA.z;
    const L2 = labB.x, A2 = labB.y, B2 = labB.z;
    for (let i = 0; i < count; i++) out[i] = deltaE2000(L1[i], A1[i], B1[i], L2[i], A2[i], B2[i]);
    return out;
}
export function soaDeltaE76(out, labA, labB, count) {
    count = count === undefined ? labA.count : count;
    const L1 = labA.x, A1 = labA.y, B1 = labA.z;
    const L2 = labB.x, A2 = labB.y, B2 = labB.z;
    for (let i = 0; i < count; i++) out[i] = deltaE76(L1[i], A1[i], B1[i], L2[i], A2[i], B2[i]);
    return out;
}

// ============================================================================
// Colour grading matrices (ROW-MAJOR, module-local convention)
// ============================================================================
export function colorMatrixIdentity(out9) {
    out9[0] = 1; out9[1] = 0; out9[2] = 0;
    out9[3] = 0; out9[4] = 1; out9[5] = 0;
    out9[6] = 0; out9[7] = 0; out9[8] = 1;
    return out9;
}
export function colorMatrixGrayscale(out9, lr, lg, lb) {
    const r = lr === undefined ? LUMA_R709 : lr;
    const g = lg === undefined ? LUMA_G709 : lg;
    const b = lb === undefined ? LUMA_B709 : lb;
    out9[0] = r; out9[1] = g; out9[2] = b;
    out9[3] = r; out9[4] = g; out9[5] = b;
    out9[6] = r; out9[7] = g; out9[8] = b;
    return out9;
}
export function colorMatrixSaturation(out9, s) {
    const inv = 1 - s;
    const lr = LUMA_R709 * inv, lg = LUMA_G709 * inv, lb = LUMA_B709 * inv;
    out9[0] = lr + s; out9[1] = lg; out9[2] = lb;
    out9[3] = lr; out9[4] = lg + s; out9[5] = lb;
    out9[6] = lr; out9[7] = lg; out9[8] = lb + s;
    return out9;
}
export function colorMatrixChannelMix(out9, rr, rg, rb, gr, gg, gb, br, bg, bb) {
    out9[0] = rr; out9[1] = rg; out9[2] = rb;
    out9[3] = gr; out9[4] = gg; out9[5] = gb;
    out9[6] = br; out9[7] = bg; out9[8] = bb;
    return out9;
}
/** YIQ hue rotation as a row-major 3×3 (luma preserving, HDR-safe). */
export function colorMatrixHueRotation(out9, rad) {
    const c = Math.cos(rad), s = Math.sin(rad);
    const ir = 0.596, ig = -0.274, ib = -0.322;
    const qr = 0.211, qg = -0.523, qb = 0.312;
    const nir = c * ir - s * qr, nig = c * ig - s * qg, nib = c * ib - s * qb;
    const nqr = s * ir + c * qr, nqg = s * ig + c * qg, nqb = s * ib + c * qb;
    out9[0] = LUMA_R601 + 0.956 * nir + 0.621 * nqr;
    out9[1] = LUMA_G601 + 0.956 * nig + 0.621 * nqg;
    out9[2] = LUMA_B601 + 0.956 * nib + 0.621 * nqb;
    out9[3] = LUMA_R601 - 0.272 * nir - 0.647 * nqr;
    out9[4] = LUMA_G601 - 0.272 * nig - 0.647 * nqg;
    out9[5] = LUMA_B601 - 0.272 * nib - 0.647 * nqb;
    out9[6] = LUMA_R601 - 1.106 * nir + 1.703 * nqr;
    out9[7] = LUMA_G601 - 1.106 * nig + 1.703 * nqg;
    out9[8] = LUMA_B601 - 1.106 * nib + 1.703 * nqb;
    return out9;
}
/** Apply a ROW-MAJOR 3×3 to an RGB(A) SOA. Alpha untouched. */
export function soaApplyColorMatrix3(out, colors, m, count) {
    count = count === undefined ? colors.count : count;
    const ox = out.x, oy = out.y, oz = out.z;
    const cx = colors.x, cy = colors.y, cz = colors.z;
    const m0 = m[0], m1 = m[1], m2 = m[2];
    const m3 = m[3], m4 = m[4], m5 = m[5];
    const m6 = m[6], m7 = m[7], m8 = m[8];
    for (let i = 0; i < count; i++) {
        const r = cx[i], g = cy[i], b = cz[i];
        ox[i] = m0 * r + m1 * g + m2 * b;
        oy[i] = m3 * r + m4 * g + m5 * b;
        oz[i] = m6 * r + m7 * g + m8 * b;
    }
    return out;
}

// ============================================================================
// Hue rotation
// ============================================================================
/** Inline YIQ hue rotation — luma preserving, HDR-safe, zero allocation. */
export function hueRotateRgb(out, r, g, b, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const i = 0.596 * r - 0.274 * g - 0.322 * b;
    const q = 0.211 * r - 0.523 * g + 0.312 * b;
    const i2 = c * i - s * q;
    const q2 = s * i + c * q;
    out[0] = y + 0.956 * i2 + 0.621 * q2;
    out[1] = y - 0.272 * i2 - 0.647 * q2;
    out[2] = y - 1.106 * i2 + 1.703 * q2;
    return out;
}
/** Perceptually uniform hue shift in OKLCH. */
export function hueRotateOklab(out, r, g, b, angle) {
    rgbToOklch(_lch3, r, g, b);
    let h = _lch3[2] + angle;
    h = h - Math.floor(h / TAU) * TAU;
    return oklchToRgb(out, _lch3[0], _lch3[1], h);
}
/** In-place OKLCH hue rotation over an RGB(A) SOA (perceptual). */
export function hueRotateSoa(colors, angle, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) {
        rgbToOklch(_lch3, r[i], g[i], b[i]);
        let h = _lch3[2] + angle;
        h = h - Math.floor(h / TAU) * TAU;
        oklchToRgb(_oklab3, _lch3[0], _lch3[1], h);
        r[i] = _oklab3[0]; g[i] = _oklab3[1]; b[i] = _oklab3[2];
    }
    return colors;
}
export function soaHueRotate(colors, angle, count) { return hueRotateSoa(colors, angle, count); }
/** Fast YIQ hue rotation over an SOA (cheaper than OKLCH, luma preserving). */
export function soaHueRotateRgb(colors, angle, count) {
    count = count === undefined ? colors.count : count;
    const c = Math.cos(angle), s = Math.sin(angle);
    const cx = colors.x, cy = colors.y, cz = colors.z;
    for (let i = 0; i < count; i++) {
        const r = cx[i], g = cy[i], b = cz[i];
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        const iq = 0.596 * r - 0.274 * g - 0.322 * b;
        const qq = 0.211 * r - 0.523 * g + 0.312 * b;
        const i2 = c * iq - s * qq;
        const q2 = s * iq + c * qq;
        cx[i] = y + 0.956 * i2 + 0.621 * q2;
        cy[i] = y - 0.272 * i2 - 0.647 * q2;
        cz[i] = y - 1.106 * i2 + 1.703 * q2;
    }
    return colors;
}

// ============================================================================
// Gradients
// ============================================================================
export function resolveGradientMode(mode) {
    if (typeof mode === "number") return mode | 0;
    switch (String(mode || "linear")) {
        case "cosine": return GRADIENT_COSINE;
        case "catmullRom": case "catmull": return GRADIENT_CATMULL_ROM;
        case "step": return GRADIENT_STEP;
        case "oklab": return GRADIENT_OKLAB;
        default: return GRADIENT_LINEAR;
    }
}
export function sampleGradientLinear(out, stops, t) {
    const n = stops.length;
    if (n === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    if (n === 1) { out[0] = stops[0][0]; out[1] = stops[0][1]; out[2] = stops[0][2]; return out; }
    t = clamp01(t);
    const scaled = t * (n - 1);
    let idx = Math.floor(scaled);
    if (idx > n - 2) idx = n - 2;
    const frac = scaled - idx;
    const a = stops[idx], b = stops[idx + 1];
    out[0] = a[0] + (b[0] - a[0]) * frac;
    out[1] = a[1] + (b[1] - a[1]) * frac;
    out[2] = a[2] + (b[2] - a[2]) * frac;
    return out;
}
export function sampleGradientCosine(out, stops, t) {
    const n = stops.length;
    if (n === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    if (n === 1) { out[0] = stops[0][0]; out[1] = stops[0][1]; out[2] = stops[0][2]; return out; }
    t = clamp01(t);
    const scaled = t * (n - 1);
    let idx = Math.floor(scaled);
    if (idx > n - 2) idx = n - 2;
    const eased = 0.5 - 0.5 * Math.cos((scaled - idx) * PI);
    const a = stops[idx], b = stops[idx + 1];
    out[0] = a[0] + (b[0] - a[0]) * eased;
    out[1] = a[1] + (b[1] - a[1]) * eased;
    out[2] = a[2] + (b[2] - a[2]) * eased;
    return out;
}
export function sampleGradientCatmullRom(out, stops, t) {
    const n = stops.length;
    if (n === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    if (n === 1) { out[0] = stops[0][0]; out[1] = stops[0][1]; out[2] = stops[0][2]; return out; }
    t = clamp01(t);
    const scaled = t * (n - 1);
    let i1 = Math.floor(scaled);
    if (i1 > n - 2) i1 = n - 2;
    const f = scaled - i1;
    const i0 = i1 > 0 ? i1 - 1 : 0;
    const i2 = i1 + 1;
    const i3 = i1 + 2 < n ? i1 + 2 : n - 1;
    const f2 = f * f, f3 = f2 * f;
    for (let k = 0; k < 3; k++) {
        const p0 = stops[i0][k], p1 = stops[i1][k], p2 = stops[i2][k], p3 = stops[i3][k];
        out[k] = 0.5 * ((2 * p1) + (-p0 + p2) * f +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
            (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
    }
    return out;
}
export function sampleGradientStep(out, stops, t) {
    const n = stops.length;
    if (n === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    let idx = Math.floor(clamp01(t) * n);
    if (idx > n - 1) idx = n - 1;
    out[0] = stops[idx][0]; out[1] = stops[idx][1]; out[2] = stops[idx][2];
    return out;
}
/** Perceptually uniform gradient — interpolates in OKLab, returns linear sRGB. */
export function sampleGradientOklab(out, stops, t) {
    const n = stops.length;
    if (n === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    if (n === 1) { out[0] = stops[0][0]; out[1] = stops[0][1]; out[2] = stops[0][2]; return out; }
    t = clamp01(t);
    const scaled = t * (n - 1);
    let idx = Math.floor(scaled);
    if (idx > n - 2) idx = n - 2;
    const f = scaled - idx;
    const a = stops[idx], b = stops[idx + 1];
    rgbToOklab(_oklab3, a[0], a[1], a[2]);
    const L0 = _oklab3[0], A0 = _oklab3[1], B0 = _oklab3[2];
    rgbToOklab(_oklab3, b[0], b[1], b[2]);
    return oklabToRgb(out, L0 + (_oklab3[0] - L0) * f,
        A0 + (_oklab3[1] - A0) * f,
        B0 + (_oklab3[2] - B0) * f);
}
export function sampleGradientHueCycle(out, t, s, l) {
    return hslToRgb(out, t, s === undefined ? 0.8 : s, l === undefined ? 0.5 : l);
}
export function sampleGradient(out, stops, t, mode) {
    switch (resolveGradientMode(mode)) {
        case GRADIENT_COSINE: return sampleGradientCosine(out, stops, t);
        case GRADIENT_CATMULL_ROM: return sampleGradientCatmullRom(out, stops, t);
        case GRADIENT_STEP: return sampleGradientStep(out, stops, t);
        case GRADIENT_OKLAB: return sampleGradientOklab(out, stops, t);
        default: return sampleGradientLinear(out, stops, t);
    }
}
/** Flatten an array-of-triplets into a contiguous Float32Array (setup-time). */
export function flattenStops(stops) {
    const n = stops.length;
    const flat = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        flat[i * 3] = stops[i][0];
        flat[i * 3 + 1] = stops[i][1];
        flat[i * 3 + 2] = stops[i][2];
    }
    return flat;
}

// ============================================================================
// Palettes — zero-GC `Into` variants + allocating convenience wrappers
// ============================================================================
function _paletteInto(out, offset, r, g, b, deltas, spread) {
    rgbToHsl(_hsl3, r, g, b);
    const h0 = _hsl3[0], s = _hsl3[1], l = _hsl3[2];
    for (let i = 0; i < deltas.length; i++) {
        let h = h0 + deltas[i] * spread;
        h = h - Math.floor(h);
        hslToRgb(_oklab3, h, s, l);
        const o = offset + i * 3;
        out[o] = _oklab3[0]; out[o + 1] = _oklab3[1]; out[o + 2] = _oklab3[2];
    }
    return out;
}
/** Write N palette entries as RGB triplets into a caller-owned flat buffer. */
export function paletteAnalogousInto(out, offset, r, g, b, spread) {
    return _paletteInto(out, offset || 0, r, g, b, DELTA_ANALOGOUS, spread === undefined ? 1 / 12 : spread);
}
export function paletteTriadicInto(out, offset, r, g, b) {
    return _paletteInto(out, offset || 0, r, g, b, DELTA_TRIADIC, 1);
}
export function paletteTetradicInto(out, offset, r, g, b) {
    return _paletteInto(out, offset || 0, r, g, b, DELTA_TETRADIC, 1);
}
export function paletteSplitComplementaryInto(out, offset, r, g, b) {
    return _paletteInto(out, offset || 0, r, g, b, DELTA_SPLIT, 1);
}
export function paletteComplementary(out, r, g, b) {
    rgbToHsl(_hsl3, r, g, b);
    let h = _hsl3[0] + 0.5;
    h = h - Math.floor(h);
    return hslToRgb(out, h, _hsl3[1], _hsl3[2]);
}
function _paletteAlloc(r, g, b, deltas, spread) {
    const n = deltas.length;
    const flat = new Float32Array(n * 3);
    _paletteInto(flat, 0, r, g, b, deltas, spread);
    const res = new Array(n);
    for (let i = 0; i < n; i++) res[i] = [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]];
    return res;
}
export function paletteAnalogous(out, r, g, b, spread) {
    const res = _paletteAlloc(r, g, b, DELTA_ANALOGOUS, spread === undefined ? 1 / 12 : spread);
    if (Array.isArray(out)) { for (let i = 0; i < res.length; i++) out[i] = res[i]; return out; }
    return res;
}
export function paletteTriadic(out, r, g, b) {
    const res = _paletteAlloc(r, g, b, DELTA_TRIADIC, 1);
    if (Array.isArray(out)) { for (let i = 0; i < res.length; i++) out[i] = res[i]; return out; }
    return res;
}
export function paletteTetradic(out, r, g, b) {
    const res = _paletteAlloc(r, g, b, DELTA_TETRADIC, 1);
    if (Array.isArray(out)) { for (let i = 0; i < res.length; i++) out[i] = res[i]; return out; }
    return res;
}
export function paletteSplitComplementary(out, r, g, b) {
    const res = _paletteAlloc(r, g, b, DELTA_SPLIT, 1);
    if (Array.isArray(out)) { for (let i = 0; i < res.length; i++) out[i] = res[i]; return out; }
    return res;
}
/** Noise-driven palette written into a flat RGB buffer (zero per-entry alloc). */
export function paletteNoiseDrivenInto(out, count, noiseFn, seed, scale, saturation, lightness) {
    scale = scale === undefined ? 0.3 : scale;
    saturation = saturation === undefined ? 0.7 : saturation;
    lightness = lightness === undefined ? 0.5 : lightness;
    seed = seed === undefined ? 0 : seed;
    for (let i = 0; i < count; i++) {
        let h = 0.5 + 0.5 * noiseFn(i * scale, seed);
        h = h - Math.floor(h);
        hslToRgb(_oklab3, h, saturation, lightness);
        out[i * 3] = _oklab3[0]; out[i * 3 + 1] = _oklab3[1]; out[i * 3 + 2] = _oklab3[2];
    }
    return out;
}
export function paletteNoiseDriven(out, count, noiseFn, seed, scale, saturation, lightness) {
    const flat = new Float32Array(count * 3);
    paletteNoiseDrivenInto(flat, count, noiseFn, seed, scale, saturation, lightness);
    for (let i = 0; i < count; i++) {
        const c = [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]];
        if (out && out.length > i) out[i] = c; else if (out) out.push(c);
    }
    return out || flat;
}

// ============================================================================
// SOA — sync pipelines (alpha preserved unless stated)
// ============================================================================
export function soaSrgbToLinear(colors, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) {
        const rv = r[i], gv = g[i], bv = b[i];
        r[i] = rv <= 0.04045 ? rv / 12.92 : Math.pow((rv + 0.055) / 1.055, 2.4);
        g[i] = gv <= 0.04045 ? gv / 12.92 : Math.pow((gv + 0.055) / 1.055, 2.4);
        b[i] = bv <= 0.04045 ? bv / 12.92 : Math.pow((bv + 0.055) / 1.055, 2.4);
    }
    return colors;
}
export function soaLinearToSrgb(colors, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) {
        const rv = r[i], gv = g[i], bv = b[i];
        r[i] = rv <= 0.0031308 ? rv * 12.92 : 1.055 * Math.pow(rv, SRGB_1_2_4) - 0.055;
        g[i] = gv <= 0.0031308 ? gv * 12.92 : 1.055 * Math.pow(gv, SRGB_1_2_4) - 0.055;
        b[i] = bv <= 0.0031308 ? bv * 12.92 : 1.055 * Math.pow(bv, SRGB_1_2_4) - 0.055;
    }
    return colors;
}
export function soaTonemapReinhard(colors, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) {
        const rv = r[i], gv = g[i], bv = b[i];
        r[i] = rv / (1 + rv); g[i] = gv / (1 + gv); b[i] = bv / (1 + bv);
    }
    return colors;
}
export function soaTonemapAces(colors, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) {
        const rv = r[i], gv = g[i], bv = b[i];
        r[i] = (rv * (2.51 * rv + 0.03)) / (rv * (2.43 * rv + 0.59) + 0.14);
        g[i] = (gv * (2.51 * gv + 0.03)) / (gv * (2.43 * gv + 0.59) + 0.14);
        b[i] = (bv * (2.51 * bv + 0.03)) / (bv * (2.43 * bv + 0.59) + 0.14);
    }
    return colors;
}
/** Generic SOA tone map — operator resolved ONCE, outside the loop. */
export function soaTonemap(colors, op, exposure, white, count) {
    count = count === undefined ? colors.count : count;
    const id = resolveTonemapOp(op);
    const e = exposure === undefined ? 1 : exposure;
    const r = colors.x, g = colors.y, b = colors.z;
    if (id === TONEMAP_ACES && e === 1) return soaTonemapAces(colors, count);
    if (id === TONEMAP_REINHARD && e === 1) return soaTonemapReinhard(colors, count);
    for (let i = 0; i < count; i++) {
        _tonemapById(_tmB, r[i] * e, g[i] * e, b[i] * e, id, white);
        r[i] = _tmB[0]; g[i] = _tmB[1]; b[i] = _tmB[2];
    }
    return colors;
}
export function soaExpose(colors, exposure, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) { r[i] *= exposure; g[i] *= exposure; b[i] *= exposure; }
    return colors;
}
export function soaClampGamut(colors, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) {
        const rv = r[i], gv = g[i], bv = b[i];
        r[i] = rv < 0 ? 0 : (rv > 1 ? 1 : rv);
        g[i] = gv < 0 ? 0 : (gv > 1 ? 1 : gv);
        b[i] = bv < 0 ? 0 : (bv > 1 ? 1 : bv);
    }
    return colors;
}
export function soaGamutMap(colors, iterations, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) {
        mapToSrgbGamut(_tmB, r[i], g[i], b[i], iterations);
        r[i] = _tmB[0]; g[i] = _tmB[1]; b[i] = _tmB[2];
    }
    return colors;
}
export function soaBlackbody(colors, temperatures, count, linear) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    const fn = linear ? blackbodyRgbLinear : blackbodyRgb;
    for (let i = 0; i < count; i++) {
        fn(_tmB, temperatures[i]);
        r[i] = _tmB[0]; g[i] = _tmB[1]; b[i] = _tmB[2];
    }
    return colors;
}
export function soaPaletteGenerate(colors, noiseFn, seed, scale, saturation, lightness, count) {
    count = count === undefined ? colors.count : count;
    scale = scale === undefined ? 0.3 : scale;
    saturation = saturation === undefined ? 0.7 : saturation;
    lightness = lightness === undefined ? 0.5 : lightness;
    seed = seed === undefined ? 0 : seed;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) {
        let h = 0.5 + 0.5 * noiseFn(i * scale, seed);
        h = h - Math.floor(h);
        hslToRgb(_tmB, h, saturation, lightness);
        r[i] = _tmB[0]; g[i] = _tmB[1]; b[i] = _tmB[2];
    }
    return colors;
}
/** Per-row gradient sample. `stops` may be triplets or a pre-flattened Float32Array. */
export function soaGradientSample(colors, stops, ts, mode, count) {
    count = count === undefined ? colors.count : count;
    const id = resolveGradientMode(mode);
    const flat = (stops instanceof Float32Array || stops instanceof Float64Array)
        ? stops : flattenStops(stops);
    const n = (flat.length / 3) | 0;
    const r = colors.x, g = colors.y, b = colors.z;
    if (n === 0) { for (let i = 0; i < count; i++) { r[i] = 0; g[i] = 0; b[i] = 0; } return colors; }
    const last = n - 1;
    for (let i = 0; i < count; i++) {
        const t = clamp01(ts[i]);
        if (id === GRADIENT_STEP) {
            let k = Math.floor(t * n); if (k > last) k = last;
            r[i] = flat[k * 3]; g[i] = flat[k * 3 + 1]; b[i] = flat[k * 3 + 2];
            continue;
        }
        const scaled = t * last;
        let k = Math.floor(scaled); if (k > last - 1) k = last - 1;
        if (last === 0) k = 0;
        let f = scaled - k;
        if (id === GRADIENT_COSINE) f = 0.5 - 0.5 * Math.cos(f * PI);
        const o0 = k * 3, o1 = (k + 1 <= last ? k + 1 : last) * 3;
        const ar = flat[o0], ag = flat[o0 + 1], ab = flat[o0 + 2];
        const br = flat[o1], bg = flat[o1 + 1], bb = flat[o1 + 2];
        if (id === GRADIENT_OKLAB) {
            rgbToOklab(_oklab3, ar, ag, ab);
            const L0 = _oklab3[0], A0 = _oklab3[1], B0 = _oklab3[2];
            rgbToOklab(_oklab3, br, bg, bb);
            oklabToRgb(_tmB, L0 + (_oklab3[0] - L0) * f, A0 + (_oklab3[1] - A0) * f, B0 + (_oklab3[2] - B0) * f);
            r[i] = _tmB[0]; g[i] = _tmB[1]; b[i] = _tmB[2];
        } else if (id === GRADIENT_CATMULL_ROM && n > 2) {
            const i0 = (k > 0 ? k - 1 : 0) * 3;
            const i3 = (k + 2 <= last ? k + 2 : last) * 3;
            const f2 = f * f, f3 = f2 * f;
            for (let c = 0; c < 3; c++) {
                const p0 = flat[i0 + c], p1 = flat[o0 + c], p2 = flat[o1 + c], p3 = flat[i3 + c];
                _tmB[c] = 0.5 * ((2 * p1) + (-p0 + p2) * f +
                    (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
                    (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
            }
            r[i] = _tmB[0]; g[i] = _tmB[1]; b[i] = _tmB[2];
        } else {
            r[i] = ar + (br - ar) * f;
            g[i] = ag + (bg - ag) * f;
            b[i] = ab + (bb - ab) * f;
        }
    }
    return colors;
}
export function soaMixColors(out, a, b, t, count) {
    count = count === undefined ? out.count : count;
    const tArr = _isArr(t) ? t : null;
    const or_ = out.x, og = out.y, ob = out.z;
    const ar = a.x, ag = a.y, ab = a.z;
    const br = b.x, bg = b.y, bb = b.z;
    const hasA = out.w !== undefined && a.w !== undefined && b.w !== undefined;
    const ow = out.w, aw = a.w, bw = b.w;
    for (let i = 0; i < count; i++) {
        const ti = tArr ? tArr[i] : t;
        or_[i] = ar[i] + (br[i] - ar[i]) * ti;
        og[i] = ag[i] + (bg[i] - ag[i]) * ti;
        ob[i] = ab[i] + (bb[i] - ab[i]) * ti;
        if (hasA) ow[i] = aw[i] + (bw[i] - aw[i]) * ti;
    }
    return out;
}
export function soaScaleColors(colors, s, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) { r[i] *= s; g[i] *= s; b[i] *= s; }
    return colors;
}
export function soaCopyColors(out, src, count) {
    count = count === undefined ? out.count : count;
    out.x.set(src.x.subarray ? src.x.subarray(0, count) : src.x);
    out.y.set(src.y.subarray ? src.y.subarray(0, count) : src.y);
    out.z.set(src.z.subarray ? src.z.subarray(0, count) : src.z);
    if (out.w !== undefined && src.w !== undefined) {
        out.w.set(src.w.subarray ? src.w.subarray(0, count) : src.w);
    }
    return out;
}
export function soaFillColors(colors, r0, g0, b0, a0) {
    colors.x.fill(r0); colors.y.fill(g0); colors.z.fill(b0);
    if (colors.w !== undefined && a0 !== undefined) colors.w.fill(a0);
    return colors;
}
/** Rec.709 relative luminance per row. */
export function soaLuminance(out, colors, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = 0; i < count; i++) {
        out[i] = LUMA_R709 * r[i] + LUMA_G709 * g[i] + LUMA_B709 * b[i];
    }
    return out;
}
/** Mean log luminance for auto-exposure (geometric mean). Returns a number. */
export function soaAverageLogLuminance(colors, count, epsilon) {
    count = count === undefined ? colors.count : count;
    const eps = epsilon === undefined ? 1e-4 : epsilon;
    const r = colors.x, g = colors.y, b = colors.z;
    let sum = 0;
    for (let i = 0; i < count; i++) {
        const l = LUMA_R709 * r[i] + LUMA_G709 * g[i] + LUMA_B709 * b[i];
        sum += Math.log(l + eps);
    }
    return count > 0 ? sum / count : 0;
}
/** Middle-grey key exposure from mean log luminance. */
export function keyExposure(avgLogLuminance, key) {
    return (key === undefined ? 0.18 : key) / Math.exp(avgLogLuminance);
}

// ============================================================================
// HDR-safe colour spring (FIXED dt — Blueprint §45/§51)
// ============================================================================
export function colorSpringDamp(out, current, target, vel, smoothTime, dt, maxSpeed) {
    let st = smoothTime < 0.0001 ? 0.0001 : smoothTime;
    const ms = maxSpeed === undefined ? Infinity : maxSpeed;
    const omega = 2 / st;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const maxChange = ms * st;
    for (let i = 0; i < 4; i++) {
        const c = current[i];
        let t = target[i];
        const original = t;
        let change = c - t;
        if (change > maxChange) change = maxChange;
        else if (change < -maxChange) change = -maxChange;
        t = c - change;
        const temp = (vel[i] + omega * change) * dt;
        vel[i] = (vel[i] - omega * temp) * exp;
        let o = t + (change + temp) * exp;
        if ((original - c > 0) === (o > original)) { o = original; vel[i] = 0; }
        out[i] = o;
    }
    return out;
}
export function soaColorSpringDamp(out, current, target, vel, smoothTime, dt, maxSpeed, count) {
    count = count === undefined ? out.count : count;
    const stArr = _isArr(smoothTime) ? smoothTime : null;
    const ms = maxSpeed === undefined ? Infinity : maxSpeed;
    const ox = out.x, oy = out.y, oz = out.z, ow = out.w;
    const cx = current.x, cy = current.y, cz = current.z, cw = current.w;
    const tx = target.x, ty = target.y, tz = target.z, tw = target.w;
    const vx = vel.x, vy = vel.y, vz = vel.z, vw = vel.w;
    for (let i = 0; i < count; i++) {
        const st = Math.max(0.0001, stArr ? stArr[i] : smoothTime);
        const omega = 2 / st;
        const x = omega * dt;
        const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
        const maxChange = ms * st;
        // R
        let c = cx[i], t = tx[i], orig = t, ch = c - t;
        if (ch > maxChange) ch = maxChange; else if (ch < -maxChange) ch = -maxChange;
        t = c - ch;
        let tmp = (vx[i] + omega * ch) * dt;
        vx[i] = (vx[i] - omega * tmp) * exp;
        let o = t + (ch + tmp) * exp;
        if ((orig - c > 0) === (o > orig)) { o = orig; vx[i] = 0; }
        ox[i] = o;
        // G
        c = cy[i]; t = ty[i]; orig = t; ch = c - t;
        if (ch > maxChange) ch = maxChange; else if (ch < -maxChange) ch = -maxChange;
        t = c - ch;
        tmp = (vy[i] + omega * ch) * dt;
        vy[i] = (vy[i] - omega * tmp) * exp;
        o = t + (ch + tmp) * exp;
        if ((orig - c > 0) === (o > orig)) { o = orig; vy[i] = 0; }
        oy[i] = o;
        // B
        c = cz[i]; t = tz[i]; orig = t; ch = c - t;
        if (ch > maxChange) ch = maxChange; else if (ch < -maxChange) ch = -maxChange;
        t = c - ch;
        tmp = (vz[i] + omega * ch) * dt;
        vz[i] = (vz[i] - omega * tmp) * exp;
        o = t + (ch + tmp) * exp;
        if ((orig - c > 0) === (o > orig)) { o = orig; vz[i] = 0; }
        oz[i] = o;
        // A
        if (ow !== undefined && cw !== undefined && tw !== undefined && vw !== undefined) {
            c = cw[i]; t = tw[i]; orig = t; ch = c - t;
            if (ch > maxChange) ch = maxChange; else if (ch < -maxChange) ch = -maxChange;
            t = c - ch;
            tmp = (vw[i] + omega * ch) * dt;
            vw[i] = (vw[i] - omega * tmp) * exp;
            o = t + (ch + tmp) * exp;
            if ((orig - c > 0) === (o > orig)) { o = orig; vw[i] = 0; }
            ow[i] = o;
        }
    }
    return out;
}

// ============================================================================
// Chunked async — one closure per CALL (setup / async path only, §1)
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

export async function soaSrgbToLinearChunked(colors, cs, ye, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const rv = r[i], gv = g[i], bv = b[i];
            r[i] = rv <= 0.04045 ? rv / 12.92 : Math.pow((rv + 0.055) / 1.055, 2.4);
            g[i] = gv <= 0.04045 ? gv / 12.92 : Math.pow((gv + 0.055) / 1.055, 2.4);
            b[i] = bv <= 0.04045 ? bv / 12.92 : Math.pow((bv + 0.055) / 1.055, 2.4);
        }
    });
    return colors;
}
export async function soaLinearToSrgbChunked(colors, cs, ye, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const rv = r[i], gv = g[i], bv = b[i];
            r[i] = rv <= 0.0031308 ? rv * 12.92 : 1.055 * Math.pow(rv, SRGB_1_2_4) - 0.055;
            g[i] = gv <= 0.0031308 ? gv * 12.92 : 1.055 * Math.pow(gv, SRGB_1_2_4) - 0.055;
            b[i] = bv <= 0.0031308 ? bv * 12.92 : 1.055 * Math.pow(bv, SRGB_1_2_4) - 0.055;
        }
    });
    return colors;
}
export async function soaTonemapAcesChunked(colors, cs, ye, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const rv = r[i], gv = g[i], bv = b[i];
            r[i] = (rv * (2.51 * rv + 0.03)) / (rv * (2.43 * rv + 0.59) + 0.14);
            g[i] = (gv * (2.51 * gv + 0.03)) / (gv * (2.43 * gv + 0.59) + 0.14);
            b[i] = (bv * (2.51 * bv + 0.03)) / (bv * (2.43 * bv + 0.59) + 0.14);
        }
    });
    return colors;
}
export async function soaTonemapReinhardChunked(colors, cs, ye, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const rv = r[i], gv = g[i], bv = b[i];
            r[i] = rv / (1 + rv); g[i] = gv / (1 + gv); b[i] = bv / (1 + bv);
        }
    });
    return colors;
}
export async function soaTonemapChunked(colors, op, exposure, white, cs, ye, count) {
    count = count === undefined ? colors.count : count;
    const id = resolveTonemapOp(op);
    const e = exposure === undefined ? 1 : exposure;
    const r = colors.x, g = colors.y, b = colors.z;
    await _chunked(count, cs, ye, function (s, en) {
        for (let i = s; i < en; i++) {
            _tonemapById(_tmB, r[i] * e, g[i] * e, b[i] * e, id, white);
            r[i] = _tmB[0]; g[i] = _tmB[1]; b[i] = _tmB[2];
        }
    });
    return colors;
}
export async function soaExposeChunked(colors, exposure, cs, ye, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) { r[i] *= exposure; g[i] *= exposure; b[i] *= exposure; }
    });
    return colors;
}
export async function soaClampGamutChunked(colors, cs, ye, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const rv = r[i], gv = g[i], bv = b[i];
            r[i] = rv < 0 ? 0 : (rv > 1 ? 1 : rv);
            g[i] = gv < 0 ? 0 : (gv > 1 ? 1 : gv);
            b[i] = bv < 0 ? 0 : (bv > 1 ? 1 : bv);
        }
    });
    return colors;
}
export async function soaGamutMapChunked(colors, iterations, cs, ye, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            mapToSrgbGamut(_tmB, r[i], g[i], b[i], iterations);
            r[i] = _tmB[0]; g[i] = _tmB[1]; b[i] = _tmB[2];
        }
    });
    return colors;
}
export async function soaHueRotateChunked(colors, angle, cs, ye, count) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            rgbToOklch(_lch3, r[i], g[i], b[i]);
            let h = _lch3[2] + angle;
            h = h - Math.floor(h / TAU) * TAU;
            oklchToRgb(_oklab3, _lch3[0], _lch3[1], h);
            r[i] = _oklab3[0]; g[i] = _oklab3[1]; b[i] = _oklab3[2];
        }
    });
    return colors;
}
export async function soaBlackbodyChunked(colors, temperatures, cs, ye, count, linear) {
    count = count === undefined ? colors.count : count;
    const r = colors.x, g = colors.y, b = colors.z;
    const fn = linear ? blackbodyRgbLinear : blackbodyRgb;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            fn(_tmB, temperatures[i]);
            r[i] = _tmB[0]; g[i] = _tmB[1]; b[i] = _tmB[2];
        }
    });
    return colors;
}
export async function soaGradientSampleChunked(colors, stops, ts, mode, cs, ye, count) {
    count = count === undefined ? colors.count : count;
    const flat = (stops instanceof Float32Array || stops instanceof Float64Array)
        ? stops : flattenStops(stops);
    const view = { x: colors.x, y: colors.y, z: colors.z, count: count };
    const tsView = ts;
    const id = mode;
    await _chunked(count, cs, ye, function (s, e) {
        const sub = { x: colors.x, y: colors.y, z: colors.z, count: e };
        // Sample the range by temporarily narrowing the count window.
        for (let i = s; i < e; i++) {
            sampleGradient(_tmB, null, 0, id); // no-op guard removed below
            break;
        }
        // Direct windowed sampling (avoids per-chunk object churn).
        _soaGradientRange(sub, flat, tsView, id, s, e);
    });
    return colors;
}
function _soaGradientRange(colors, flat, ts, id, s, e) {
    const n = (flat.length / 3) | 0;
    if (n === 0) return;
    const last = n - 1;
    const mode = resolveGradientMode(id);
    const r = colors.x, g = colors.y, b = colors.z;
    for (let i = s; i < e; i++) {
        const t = clamp01(ts[i]);
        if (mode === GRADIENT_STEP) {
            let k = Math.floor(t * n); if (k > last) k = last;
            r[i] = flat[k * 3]; g[i] = flat[k * 3 + 1]; b[i] = flat[k * 3 + 2];
            continue;
        }
        const scaled = t * last;
        let k = Math.floor(scaled); if (k > last - 1) k = last - 1;
        if (last === 0) k = 0;
        let f = scaled - k;
        if (mode === GRADIENT_COSINE) f = 0.5 - 0.5 * Math.cos(f * PI);
        const o0 = k * 3, o1 = (k + 1 <= last ? k + 1 : last) * 3;
        const ar = flat[o0], ag = flat[o0 + 1], ab = flat[o0 + 2];
        const br = flat[o1], bg = flat[o1 + 1], bb = flat[o1 + 2];
        if (mode === GRADIENT_OKLAB) {
            rgbToOklab(_oklab3, ar, ag, ab);
            const L0 = _oklab3[0], A0 = _oklab3[1], B0 = _oklab3[2];
            rgbToOklab(_oklab3, br, bg, bb);
            oklabToRgb(_tmB, L0 + (_oklab3[0] - L0) * f, A0 + (_oklab3[1] - A0) * f, B0 + (_oklab3[2] - B0) * f);
            r[i] = _tmB[0]; g[i] = _tmB[1]; b[i] = _tmB[2];
        } else {
            r[i] = ar + (br - ar) * f;
            g[i] = ag + (bg - ag) * f;
            b[i] = ab + (bb - ab) * f;
        }
    }
}
export async function soaColorSpringDampChunked(out, current, target, vel, smoothTime, dt, maxSpeed, cs, ye, count) {
    count = count === undefined ? out.count : count;
    const stArr = _isArr(smoothTime) ? smoothTime : null;
    const ms = maxSpeed === undefined ? Infinity : maxSpeed;
    const ox = out.x, oy = out.y, oz = out.z, ow = out.w;
    const cx = current.x, cy = current.y, cz = current.z, cw = current.w;
    const tx = target.x, ty = target.y, tz = target.z, tw = target.w;
    const vx = vel.x, vy = vel.y, vz = vel.z, vw = vel.w;
    const hasA = ow !== undefined && cw !== undefined && tw !== undefined && vw !== undefined;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const st = Math.max(0.0001, stArr ? stArr[i] : smoothTime);
            const omega = 2 / st;
            const x = omega * dt;
            const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
            const maxChange = ms * st;
            let c = cx[i], t = tx[i], orig = t, ch = c - t;
            if (ch > maxChange) ch = maxChange; else if (ch < -maxChange) ch = -maxChange;
            t = c - ch;
            let tmp = (vx[i] + omega * ch) * dt;
            vx[i] = (vx[i] - omega * tmp) * exp;
            let o = t + (ch + tmp) * exp;
            if ((orig - c > 0) === (o > orig)) { o = orig; vx[i] = 0; }
            ox[i] = o;
            c = cy[i]; t = ty[i]; orig = t; ch = c - t;
            if (ch > maxChange) ch = maxChange; else if (ch < -maxChange) ch = -maxChange;
            t = c - ch;
            tmp = (vy[i] + omega * ch) * dt;
            vy[i] = (vy[i] - omega * tmp) * exp;
            o = t + (ch + tmp) * exp;
            if ((orig - c > 0) === (o > orig)) { o = orig; vy[i] = 0; }
            oy[i] = o;
            c = cz[i]; t = tz[i]; orig = t; ch = c - t;
            if (ch > maxChange) ch = maxChange; else if (ch < -maxChange) ch = -maxChange;
            t = c - ch;
            tmp = (vz[i] + omega * ch) * dt;
            vz[i] = (vz[i] - omega * tmp) * exp;
            o = t + (ch + tmp) * exp;
            if ((orig - c > 0) === (o > orig)) { o = orig; vz[i] = 0; }
            oz[i] = o;
            if (hasA) {
                c = cw[i]; t = tw[i]; orig = t; ch = c - t;
                if (ch > maxChange) ch = maxChange; else if (ch < -maxChange) ch = -maxChange;
                t = c - ch;
                tmp = (vw[i] + omega * ch) * dt;
                vw[i] = (vw[i] - omega * tmp) * exp;
                o = t + (ch + tmp) * exp;
                if ((orig - c > 0) === (o > orig)) { o = orig; vw[i] = 0; }
                ow[i] = o;
            }
        }
    });
    return out;
}
export async function soaAverageLogLuminanceChunked(colors, cs, ye, count, epsilon) {
    count = count === undefined ? colors.count : count;
    const eps = epsilon === undefined ? 1e-4 : epsilon;
    const r = colors.x, g = colors.y, b = colors.z;
    let sum = 0;
    await _chunked(count, cs, ye, function (s, e) {
        let local = 0;
        for (let i = s; i < e; i++) {
            local += Math.log(LUMA_R709 * r[i] + LUMA_G709 * g[i] + LUMA_B709 * b[i] + eps);
        }
        sum += local;
    });
    return count > 0 ? sum / count : 0;
}

// ============================================================================
// LUT authoring (Blueprint §30) — caller owns the buffer; zero per-sample alloc
// ============================================================================
/** 1D tone-map LUT, RGBA floats. `out` must hold size*4 values. */
export function buildTonemapLUT(out, size, op, exposure, maxInput) {
    const id = resolveTonemapOp(op);
    const e = exposure === undefined ? 1 : exposure;
    const maxIn = maxInput === undefined ? 16 : maxInput;
    const inv = size > 1 ? 1 / (size - 1) : 0;
    for (let i = 0; i < size; i++) {
        const v = i * inv * maxIn;
        _tonemapById(_tmB, v * e, v * e, v * e, id);
        const o = i * 4;
        out[o] = _tmB[0]; out[o + 1] = _tmB[1]; out[o + 2] = _tmB[2]; out[o + 3] = 1;
    }
    return out;
}
export async function buildTonemapLUTChunked(out, size, op, exposure, maxInput, cs, ye) {
    const id = resolveTonemapOp(op);
    const e = exposure === undefined ? 1 : exposure;
    const maxIn = maxInput === undefined ? 16 : maxInput;
    const inv = size > 1 ? 1 / (size - 1) : 0;
    await _chunked(size, cs, ye, function (s, en) {
        for (let i = s; i < en; i++) {
            const v = i * inv * maxIn;
            _tonemapById(_tmB, v * e, v * e, v * e, id);
            const o = i * 4;
            out[o] = _tmB[0]; out[o + 1] = _tmB[1]; out[o + 2] = _tmB[2]; out[o + 3] = 1;
        }
    });
    return out;
}
/** 1D gradient LUT, RGBA floats. */
export function buildGradientLUT(out, size, stops, mode, alphaFrom, alphaTo) {
    const flat = (stops instanceof Float32Array || stops instanceof Float64Array)
        ? stops : flattenStops(stops);
    const view = { x: out, y: out, z: out, count: size };
    // Write RGB into a strided view by sampling per index (no allocation).
    const n = (flat.length / 3) | 0;
    const last = n - 1;
    const id = resolveGradientMode(mode);
    const inv = size > 1 ? 1 / (size - 1) : 0;
    const a0 = alphaFrom === undefined ? 1 : alphaFrom;
    const a1 = alphaTo === undefined ? a0 : alphaTo;
    for (let i = 0; i < size; i++) {
        const t = i * inv;
        const o = i * 4;
        if (n === 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = a0; continue; }
        if (id === GRADIENT_STEP) {
            let k = Math.floor(t * n); if (k > last) k = last;
            out[o] = flat[k * 3]; out[o + 1] = flat[k * 3 + 1]; out[o + 2] = flat[k * 3 + 2];
        } else {
            const scaled = t * last;
            let k = Math.floor(scaled); if (k > last - 1) k = last - 1;
            if (last === 0) k = 0;
            let f = scaled - k;
            if (id === GRADIENT_COSINE) f = 0.5 - 0.5 * Math.cos(f * PI);
            const o0 = k * 3, o1 = (k + 1 <= last ? k + 1 : last) * 3;
            if (id === GRADIENT_OKLAB) {
                rgbToOklab(_oklab3, flat[o0], flat[o0 + 1], flat[o0 + 2]);
                const L0 = _oklab3[0], A0 = _oklab3[1], B0 = _oklab3[2];
                rgbToOklab(_oklab3, flat[o1], flat[o1 + 1], flat[o1 + 2]);
                oklabToRgb(_tmB, L0 + (_oklab3[0] - L0) * f, A0 + (_oklab3[1] - A0) * f, B0 + (_oklab3[2] - B0) * f);
                out[o] = _tmB[0]; out[o + 1] = _tmB[1]; out[o + 2] = _tmB[2];
            } else {
                out[o] = flat[o0] + (flat[o1] - flat[o0]) * f;
                out[o + 1] = flat[o0 + 1] + (flat[o1 + 1] - flat[o0 + 1]) * f;
                out[o + 2] = flat[o0 + 2] + (flat[o1 + 2] - flat[o0 + 2]) * f;
            }
        }
        out[o + 3] = a0 + (a1 - a0) * t;
    }
    return out;
}
export async function buildGradientLUTChunked(out, size, stops, mode, alphaFrom, alphaTo, cs, ye) {
    const flat = (stops instanceof Float32Array || stops instanceof Float64Array)
        ? stops : flattenStops(stops);
    const n = (flat.length / 3) | 0;
    const last = n - 1;
    const id = resolveGradientMode(mode);
    const inv = size > 1 ? 1 / (size - 1) : 0;
    const a0 = alphaFrom === undefined ? 1 : alphaFrom;
    const a1 = alphaTo === undefined ? a0 : alphaTo;
    await _chunked(size, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const t = i * inv, o = i * 4;
            if (n === 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = a0; continue; }
            const scaled = t * last;
            let k = Math.floor(scaled); if (k > last - 1) k = last - 1;
            if (last === 0) k = 0;
            let f = scaled - k;
            if (id === GRADIENT_COSINE) f = 0.5 - 0.5 * Math.cos(f * PI);
            const o0 = k * 3, o1 = (k + 1 <= last ? k + 1 : last) * 3;
            if (id === GRADIENT_OKLAB) {
                rgbToOklab(_oklab3, flat[o0], flat[o0 + 1], flat[o0 + 2]);
                const L0 = _oklab3[0], A0 = _oklab3[1], B0 = _oklab3[2];
                rgbToOklab(_oklab3, flat[o1], flat[o1 + 1], flat[o1 + 2]);
                oklabToRgb(_tmB, L0 + (_oklab3[0] - L0) * f, A0 + (_oklab3[1] - A0) * f, B0 + (_oklab3[2] - B0) * f);
                out[o] = _tmB[0]; out[o + 1] = _tmB[1]; out[o + 2] = _tmB[2];
            } else {
                out[o] = flat[o0] + (flat[o1] - flat[o0]) * f;
                out[o + 1] = flat[o0 + 1] + (flat[o1 + 1] - flat[o0 + 1]) * f;
                out[o + 2] = flat[o0 + 2] + (flat[o1 + 2] - flat[o0 + 2]) * f;
            }
            out[o + 3] = a0 + (a1 - a0) * t;
        }
    });
    return out;
}
/** 1D blackbody LUT (normalized display colour), RGBA floats. */
export function buildBlackbodyLUT(out, size, tMin, tMax) {
    const lo = tMin === undefined ? 1000 : tMin;
    const hi = tMax === undefined ? 15000 : tMax;
    const inv = size > 1 ? 1 / (size - 1) : 0;
    for (let i = 0; i < size; i++) {
        blackbodyRgb(_tmB, lo + (hi - lo) * i * inv);
        const o = i * 4;
        out[o] = _tmB[0]; out[o + 1] = _tmB[1]; out[o + 2] = _tmB[2]; out[o + 3] = 1;
    }
    return out;
}

// ============================================================================
// Double-single precision bridge (Blueprint §26 — corrected)
// ============================================================================
/** out2 = [hi, lo] of (aHi,aLo) − (bHi,bLo), renormalized with a full twoSum. */
export function dsSubInto(out2, aHi, aLo, bHi, bLo) {
    const b = -bHi;
    const s = aHi + b;
    const bb = s - aHi;
    const e = (aHi - (s - bb)) + (b - bb);
    const lo = e + (aLo - bLo);
    const hi = s + lo;
    const v = hi - s;
    out2[0] = hi;
    out2[1] = (s - (hi - v)) + (lo - v);
    return out2;
}
/** Squared distance between two double-single positions — exact before narrowing. */
export function dsDistanceSq(posHi, posLo, originHi, originLo) {
    dsSubInto(_ds2, posHi[0], posLo[0], originHi[0], originLo[0]);
    const dx = _ds2[0] + _ds2[1];
    dsSubInto(_ds2, posHi[1], posLo[1], originHi[1], originLo[1]);
    const dy = _ds2[0] + _ds2[1];
    dsSubInto(_ds2, posHi[2], posLo[2], originHi[2], originLo[2]);
    const dz = _ds2[0] + _ds2[1];
    return dx * dx + dy * dy + dz * dz;
}

// ============================================================================
// IES / IESNA photometric profiles
// ============================================================================
function _bsearchLower(grid, n, v) {
    if (v <= grid[0]) return 0;
    if (v >= grid[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (grid[mid] <= v) lo = mid; else hi = mid;
    }
    return lo;
}

/**
 * Convert a world-space direction into IES (theta, phi) angles.
 * Convention: the fixture aims along local −Y. theta is measured from the
 * photometric nadir (0 = straight down the primary beam), phi is the azimuth
 * about +Y measured from +X toward +Z. out = [theta, phi] in RADIANS.
 */
export function directionToIESAngles(out, dx, dy, dz) {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-12) { out[0] = 0; out[1] = 0; return out; }
    const inv = 1 / len;
    out[0] = Math.acos(clamp1(-dy * inv));
    let phi = Math.atan2(dz * inv, dx * inv);
    if (phi < 0) phi += TAU;
    out[1] = phi;
    return out;
}

/**
 * Evaluate photometric candela at (theta, phi) — radians.
 * Handles LM-63 vertical-fastest storage, horizontal symmetry folding
 * (0–90 / 0–180 / 0–360 grids) and axial symmetry (nH === 1).
 * Accepts an IESProfile or a plain parse result.
 */
export function evaluateIESCandela(ies, theta, phi) {
    if (!ies) return 0;
    const vGrid = ies.verticalAngles, hGrid = ies.horizontalAngles, cand = ies.candela;
    if (!vGrid || !hGrid || !cand) return 0;
    const nV = vGrid.length, nH = hGrid.length;
    if (nV === 0 || nH === 0 || cand.length < nV * nH) return 0;

    let vDeg = theta * RAD2DEG;
    if (vDeg < vGrid[0]) vDeg = vGrid[0];
    else if (vDeg > vGrid[nV - 1]) vDeg = vGrid[nV - 1];

    let hDeg = ((phi * RAD2DEG) % 360 + 360) % 360;
    const hMax = hGrid[nH - 1];
    if (nH === 1) {
        hDeg = hGrid[0];
    } else if (hMax < 359.999) {
        if (hDeg > 180) hDeg = 360 - hDeg;
        if (hDeg > hMax) hDeg = 2 * hMax - hDeg;
        if (hDeg < hGrid[0]) hDeg = hGrid[0];
        if (hDeg > hMax) hDeg = hMax;
    } else if (hDeg > hMax) {
        hDeg = hMax;
    }

    const vi0 = _bsearchLower(vGrid, nV, vDeg);
    const vi1 = vi0 + 1 < nV ? vi0 + 1 : vi0;
    const vSpan = vGrid[vi1] - vGrid[vi0];
    const vt = vSpan > 0 ? (vDeg - vGrid[vi0]) / vSpan : 0;

    const hi0 = _bsearchLower(hGrid, nH, hDeg);
    const hi1 = hi0 + 1 < nH ? hi0 + 1 : hi0;
    const hSpan = hGrid[hi1] - hGrid[hi0];
    const ht = hSpan > 0 ? (hDeg - hGrid[hi0]) / hSpan : 0;

    // LM-63: all vertical angles for horizontal 0, then horizontal 1, ...
    const base0 = hi0 * nV, base1 = hi1 * nV;
    const c00 = cand[base0 + vi0], c10 = cand[base0 + vi1];
    const c01 = cand[base1 + vi0], c11 = cand[base1 + vi1];
    const cv0 = c00 + (c10 - c00) * vt;
    const cv1 = c01 + (c11 - c01) * vt;

    const header = ies.header;
    const mult = header.candelaMultiplier === undefined ? 1 : header.candelaMultiplier;
    const ballast = header.ballastFactor === undefined ? 1 : header.ballastFactor;
    const lampScale = ies.lampScale === undefined ? 1 : ies.lampScale;
    return (cv0 + (cv1 - cv0) * ht) * mult * ballast * lampScale;
}

/**
 * Parse an IES / IESNA LM-63 (1986 / 1991 / 1995 / 2002) file.
 * @param {string} text
 * @param {Object} [options] { normalizeLamps:false }
 * @returns {IESProfile}
 */
export function parseIES(text, options) {
    if (typeof text !== "string") throw new Error("parseIES: expects a string");
    options = options || {};
    const lines = text.split(/\r?\n/);
    let li = 0;
    while (li < lines.length && lines[li].trim() === "") li++;
    if (li >= lines.length) throw new Error("parseIES: empty file");
    const format = lines[li++].trim();

    const keywords = [];
    let tiltLine = "";
    let tiltInclude = false;
    let found = false;
    while (li < lines.length) {
        const line = lines[li].trim();
        const up = line.toUpperCase();
        if (up.indexOf("TILT") === 0) {
            tiltLine = line;
            tiltInclude = up.indexOf("INCLUDE") !== -1;
            li++;
            found = true;
            break;
        }
        if (line.length > 0) keywords.push(line);
        li++;
    }
    if (!found) throw new Error("parseIES: TILT record not found");

    // Token cursor over the remainder — robust to arbitrary line wrapping.
    const body = lines.slice(li).join(" ");
    const tokens = body.split(/[\s,]+/);
    let p = 0;
    function nextNum() {
        while (p < tokens.length && tokens[p] === "") p++;
        if (p >= tokens.length) return 0;
        const v = parseFloat(tokens[p++]);
        return isNaN(v) ? 0 : v;
    }

    if (tiltInclude) {
        nextNum();                       // lamp position type
        const nTilt = nextNum() | 0;     // number of tilt angles
        p += 2 * nTilt;                  // angles + multipliers
    }

    const nums = new Float64Array(13);
    for (let i = 0; i < 13; i++) nums[i] = nextNum();

    const nV = nums[3] | 0;
    const nH = nums[4] | 0;
    if (nV <= 0 || nH <= 0) throw new Error("parseIES: invalid angle counts");

    const header = {
        format: format,
        keywords: keywords,
        tilt: tiltLine,
        numLamps: nums[0],
        lumensPerLamp: nums[1],
        candelaMultiplier: nums[2],
        numVerticalAngles: nV,
        numHorizontalAngles: nH,
        photometricType: nums[5],
        unitsType: nums[6],
        width: nums[7],
        length: nums[8],
        height: nums[9],
        ballastFactor: nums[10],
        futureUse: nums[11],
        inputWatts: nums[12]
    };

    const verticalAngles = new Float64Array(nV);
    for (let i = 0; i < nV; i++) verticalAngles[i] = nextNum();
    const horizontalAngles = new Float64Array(nH);
    for (let i = 0; i < nH; i++) horizontalAngles[i] = nextNum();
    const candela = new Float64Array(nV * nH);
    for (let i = 0; i < candela.length; i++) candela[i] = nextNum();

    // LM-63: a negative lumens-per-lamp means the candela values are absolute.
    const lampScale = options.normalizeLamps === true && header.lumensPerLamp > 0
        ? (header.numLamps * header.lumensPerLamp) / 1000
        : 1;

    return new IESProfile(header, verticalAngles, horizontalAngles, candela, lampScale);
}

/** Reusable, pre-parsed photometric profile. */
export class IESProfile {
    constructor(header, verticalAngles, horizontalAngles, candela, lampScale) {
        this.header = header;
        this.verticalAngles = verticalAngles;
        this.horizontalAngles = horizontalAngles;
        this.candela = candela;
        this.lampScale = lampScale === undefined ? 1 : lampScale;
        this._max = -1;
    }
    get maxCandela() {
        if (this._max < 0) {
            let m = 0;
            const c = this.candela;
            const scale = (this.header.candelaMultiplier || 1) *
                (this.header.ballastFactor || 1) * this.lampScale;
            for (let i = 0; i < c.length; i++) if (c[i] > m) m = c[i];
            this._max = m * scale;
        }
        return this._max;
    }
    evaluate(theta, phi) { return evaluateIESCandela(this, theta, phi); }
    evaluateDirection(dx, dy, dz) {
        directionToIESAngles(_ang2, dx, dy, dz);
        return evaluateIESCandela(this, _ang2[0], _ang2[1]);
    }
    toRadiance(out, theta, phi, distance, exposure, tint) {
        return iesToRadiance(out, this, theta, phi, distance, exposure, tint);
    }
    /** Divide the table by its peak so the profile can be baked into a LUT. */
    normalize() {
        let m = 0;
        const c = this.candela;
        for (let i = 0; i < c.length; i++) if (c[i] > m) m = c[i];
        if (m > 0) { const inv = 1 / m; for (let i = 0; i < c.length; i++) c[i] *= inv; }
        this.header.candelaMultiplier = 1;
        this.header.ballastFactor = 1;
        this.lampScale = 1;
        this._max = 1;
        return this;
    }
    /** Photometric web texture: horizontal-major rows × vertical columns, R channel. */
    toLUT(out, hSize, vSize) { return buildIESLUT(out, this, hSize, vSize); }
    dispose() {
        this.candela = null;
        this.verticalAngles = null;
        this.horizontalAngles = null;
        this.header = null;
    }
}

/** RGBA float LUT of a normalized IES web (hSize × vSize). */
export function buildIESLUT(out, profile, hSize, vSize) {
    const peak = profile.maxCandela || 1;
    const inv = 1 / peak;
    const hInv = hSize > 1 ? 1 / hSize : 0;
    const vInv = vSize > 1 ? 1 / (vSize - 1) : 0;
    for (let h = 0; h < hSize; h++) {
        const phi = h * hInv * TAU;
        for (let v = 0; v < vSize; v++) {
            const theta = v * vInv * PI;
            const c = evaluateIESCandela(profile, theta, phi) * inv;
            const o = (h * vSize + v) * 4;
            out[o] = c; out[o + 1] = c; out[o + 2] = c; out[o + 3] = 1;
        }
    }
    return out;
}

/** Candela → linear radiance via the inverse-square law. Optional RGB tint. */
export function iesToRadiance(out, ies, theta, phi, distance, exposure, tint) {
    const c = evaluateIESCandela(ies, theta, phi);
    const d2 = Math.max(distance * distance, 1e-6);
    const r = (c / d2) * (exposure === undefined ? 1 : exposure);
    if (tint) { out[0] = r * tint[0]; out[1] = r * tint[1]; out[2] = r * tint[2]; }
    else { out[0] = r; out[1] = r; out[2] = r; }
    return out;
}
/** Megaparsec-safe variant: distance derived from double-single positions. */
export function iesToRadianceDS(out, ies, theta, phi, posHi, posLo, originHi, originLo, exposure, tint) {
    const c = evaluateIESCandela(ies, theta, phi);
    const d2 = Math.max(dsDistanceSq(posHi, posLo, originHi, originLo), 1e-6);
    const r = (c / d2) * (exposure === undefined ? 1 : exposure);
    if (tint) { out[0] = r * tint[0]; out[1] = r * tint[1]; out[2] = r * tint[2]; }
    else { out[0] = r; out[1] = r; out[2] = r; }
    return out;
}

/** SOA IES evaluation for 1M+ lights. Optional entity indirection + RGB tint SOA. */
export function soaIESEvaluate(outColors, ies, thetas, phis, distances, exposure, eids, count, tint) {
    count = count === undefined ? outColors.count : count;
    const e = exposure === undefined ? 1 : exposure;
    const r = outColors.x, g = outColors.y, b = outColors.z;
    const tr = tint ? tint.x : null, tg = tint ? tint.y : null, tb = tint ? tint.z : null;
    for (let i = 0; i < count; i++) {
        const idx = eids ? eids[i] : i;
        const c = evaluateIESCandela(ies, thetas[idx], phis[idx]);
        const d = distances[idx];
        const v = (c / Math.max(d * d, 1e-6)) * e;
        if (tr) { r[i] = v * tr[idx]; g[i] = v * tg[idx]; b[i] = v * tb[idx]; }
        else { r[i] = v; g[i] = v; b[i] = v; }
    }
    return outColors;
}
export async function soaIESEvaluateChunked(outColors, ies, thetas, phis, distances, exposure, cs, ye, eids, count, tint) {
    count = count === undefined ? outColors.count : count;
    const e = exposure === undefined ? 1 : exposure;
    const r = outColors.x, g = outColors.y, b = outColors.z;
    const tr = tint ? tint.x : null, tg = tint ? tint.y : null, tb = tint ? tint.z : null;
    await _chunked(count, cs, ye, function (s, en) {
        for (let i = s; i < en; i++) {
            const idx = eids ? eids[i] : i;
            const c = evaluateIESCandela(ies, thetas[idx], phis[idx]);
            const d = distances[idx];
            const v = (c / Math.max(d * d, 1e-6)) * e;
            if (tr) { r[i] = v * tr[idx]; g[i] = v * tg[idx]; b[i] = v * tb[idx]; }
            else { r[i] = v; g[i] = v; b[i] = v; }
        }
    });
    return outColors;
}
/**
 * Double-single SOA variant. `world` matches double.attachHighPrecisionPositions():
 * { x:{hi,lo}, y:{hi,lo}, z:{hi,lo} }. `originHi/originLo` are 3-element arrays.
 */
export function soaIESEvaluateDS(outColors, ies, thetas, phis, world, originHi, originLo, exposure, eids, count, tint) {
    count = count === undefined ? outColors.count : count;
    const e = exposure === undefined ? 1 : exposure;
    const r = outColors.x, g = outColors.y, b =