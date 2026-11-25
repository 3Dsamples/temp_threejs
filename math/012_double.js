// file number : 012
// full path name : src/math/012_double.js
// description : Double-double (~106-bit) arithmetic as a native ES module —
//               every class, static, prototype method and SOA op of the
//               original 012_double preserved, corrected and completed.
//               Replaces the default vector / matrix / quaternion math tier
//               for three.js r185 scenes that need centimetre precision from
//               millimetres to megaparsecs: error-free transformations
//               (Knuth twoSum, Dekker twoProd / oneSqr), the full Double class
//               (add/sub/mul/div/sqr/sqrt/inv/exp/ln/sinh/cosh/pow/sin/cos,
//               fromString / toExponential, comparisons, constants), zero-GC
//               pools, Float64-backed SOA for 1M+ double-doubles, tight
//               allocation-free SOA kernels, chunked yielding pipelines,
//               galactic-precision Kepler solvers (fast ~48-bit tier and exact
//               ~106-bit tier), 1M-body orbital integration, double-precision
//               spring damping and FABRIK, HDR ACES tone mapping, bitECS
//               high-precision world stores with floating-origin recentre,
//               double-precision vec3 SOA algebra, a batched double-world ->
//               float32-clip renderer bridge, duck-typed three.js r185
//               interop (Vector3 / Object3D / InstancedMesh / Matrix4), and an
//               optional Blob-URL worker pool for true multi-core SOA
//               arithmetic with a non-blocking main-thread fallback.
//               No "use strict" directive, no CommonJS, no Vite / Vue / build
//               step, no CDN request: loads directly in the browser next to
//               three.js r185 and the sibling 002..011 modules.
// best for : 3d graphics where one metre is noise — procedural galaxies,
//            1M+ body orbital simulation, megastructure IK / skinning,
//            HDR grading over 1e-6..1e+12, seamless Float32 <-> Double
//            precision tiers, and real-time instanced rendering on Android
//            mobile 64-bit without freezing the main thread.
// license : MIT
//
// topological hierarchy (dependencies first — this file is last):
//   src/math/002_vec2.js
//   src/math/003_vec3.js
//   src/math/004_vec4.js
//   src/math/005_mat2.js
//   src/math/006_mat3.js   (optional, dynamic — never blocks this module)
//   src/math/007_mat4.js
//   src/math/008_quat.js
//   src/math/009_quat2.js
//   src/math/010_bitECS_core.js (optional, dynamic; $internal symbol used directly)
//   src/math/012_double.js  <- THIS FILE
// ============================================================================

import * as vec2 from "./002_vec2.js";
import * as vec3 from "./003_vec3.js";
import * as vec4 from "./004_vec4.js";
import * as mat2 from "./005_mat2.js";
import * as mat4 from "./007_mat4.js";
import * as quat from "./008_quat.js";
import * as quat2 from "./009_quat2.js";

// ============================================================================
// 0. SELF-CONTAINED FOUNDATION (replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const $internal = Symbol.for("bitecs_internal");

function yieldToMain() {
    return new Promise(function (resolve) {
        if (typeof setTimeout === "function") { setTimeout(resolve, 0); }
        else { resolve(); }
    });
}

function createPool(factory, capacity, reset) {
    capacity = capacity || 256;
    var items = [];
    for (var i = 0; i < capacity; i++) { items.push(factory()); }
    return {
        acquire: function () { return items.length > 0 ? items.pop() : factory(); },
        release: function (v) {
            if (reset) { reset(v); }
            if (items.length < capacity) { items.push(v); }
        }
    };
}

function createSOA(count, components, Type) {
    Type = Type || Float64Array;
    var bytes = Type.BYTES_PER_ELEMENT || 8;
    var buffer = new ArrayBuffer(count * components * bytes);
    var arrays = [];
    for (var c = 0; c < components; c++) {
        arrays.push(new Type(buffer, c * count * bytes, count));
    }
    return { arrays: arrays, buffer: buffer, count: count, components: components };
}

function hash3(x, y, z) {
    var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2246822519)) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 1274126177) | 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967295;
}

function mulberry32(seed) {
    var a = seed | 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// module-level scratch (zero-GC hot paths)
var _tmpDoubleA = { hi: 0, lo: 0 };
var _tmpDoubleB = { hi: 0, lo: 0 };
var _tmpDoubleC = { hi: 0, lo: 0 };
var _tmpDoubleD = { hi: 0, lo: 0 };

// ============================================================================
// 1. ERROR-FREE TRANSFORMATIONS
// ============================================================================
var splitter = 134217729; // 2^27 + 1 (Dekker)

/** Knuth / Møller twoSum. Optional `out` avoids allocation on hot paths. */
function twoSum(a, b, out) {
    var s = a + b;
    var bb = s - a;
    var err = (a - (s - bb)) + (b - bb);
    out = out || {};
    out.hi = s; out.lo = err;
    return out;
}

/** Dekker twoProd. Optional `out` avoids allocation on hot paths. */
function twoProd(a, b, out) {
    var p = a * b;
    var t = splitter * a;
    var ah = t + (a - t), al = a - ah;
    t = splitter * b;
    var bh = t + (b - t), bl = b - bh;
    var err = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    out = out || {};
    out.hi = p; out.lo = err;
    return out;
}

/** Dekker oneSqr. Optional `out` avoids allocation on hot paths. */
function oneSqr(a, out) {
    var t = splitter * a;
    var ah = t + (a - t), al = a - ah;
    var p = a * a;
    var hl = al * ah;
    var err = ((ah * ah - p) + hl + hl) + al * al;
    out = out || {};
    out.hi = p; out.lo = err;
    return out;
}

// ============================================================================
// 2. DOUBLE-DOUBLE CLASS (every original static + instance member preserved)
// ============================================================================
class Double {
    constructor(obj) {
        if (obj instanceof Double) { this.hi = obj.hi; this.lo = obj.lo; }
        else if (typeof obj === "number") { this.hi = obj; this.lo = 0; }
        else if (typeof obj === "string") { var d = Double.fromString(obj); this.hi = d.hi; this.lo = d.lo; }
        else if (Array.isArray(obj)) { this.hi = obj[0] || 0; this.lo = obj[1] || 0; }
        else if (typeof obj === "object" && obj !== null) { this.hi = obj.hi || 0; this.lo = obj.lo || 0; }
        else { this.hi = 0; this.lo = 0; }
    }

    // ---- static constructors ----
    static create(hi, lo) { var d = new Double(); d.hi = hi === undefined ? 0 : hi; d.lo = lo === undefined ? 0 : lo; return d; }
    static clone(X) { var d = new Double(); d.hi = X.hi; d.lo = X.lo; return d; }
    static fromSum11(a, b) { return new Double(twoSum(a, b)); }
    static fromMul11(a, b) { return new Double(twoProd(a, b)); }
    static fromSqr1(a) { return new Double(oneSqr(a)); }

    static fromString(s) {
        var isPositive = (/^\s*-/.exec(s) === null);
        s = String(s).replace(/^\s*[+-]?/, "");
        if (/^NaN/.exec(s) !== null) { return Double.NaN; }
        if (/Infinity/.exec(s) !== null) { return isPositive ? Double.Infinity : Double.neg2(Double.Infinity); }
        var rex = /^([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE]([-+]?[0-9]+))?/.exec(s);
        if (!rex) { return Double.NaN; }
        var digits = rex[1].replace(".", "");
        var exp = (rex[2] !== undefined) ? parseInt(rex[2], 10) : 0;
        var dotId = rex[1].indexOf(".");
        if (dotId === -1) { dotId = digits.length; }
        if (exp + dotId - 1 < -300) { return isPositive ? Double.Zero : Double.neg2(Double.Zero); }
        if (exp + dotId - 1 > 300) { return isPositive ? Double.Infinity : Double.neg2(Double.Infinity); }
        var result = Double.Zero;
        for (var i = 0; i < digits.length; i += 15) {
            var nextDigs = digits.slice(i, i + 15);
            var shift = Double.pow2n(new Double(10), exp + dotId - i - nextDigs.length);
            Double.add22(result, Double.mul21(shift, parseInt(nextDigs, 10)));
        }
        return isPositive ? result : Double.neg2(result);
    }

    // ---- conversions ----
    toNumber() { return this.hi + this.lo; }

    toExponential(precision) {
        if (isNaN(this.hi)) { return "NaN"; }
        if (!isFinite(this.hi) || this.toNumber() === 0) { return this.hi.toExponential(precision); }
        var remainder = Double.clone(this);
        var str = remainder.hi.toExponential(precision).split("e");
        if (str[0].length > 16) { str[0] = str[0].slice(0, 16); }
        var result = str[0];
        var i = str[0].length - str[0].indexOf(".") - 1;
        if (str[0].indexOf(".") < 0) { i--; }
        Double.sub22(remainder, new Double(result + "e" + str[1]));
        if (remainder.hi < 0) { Double.mul21(remainder, -1); }
        if (precision !== undefined && precision > 33) { precision = 33; }
        while (true) {
            var nextPrecision;
            if (precision === undefined) {
                if (remainder.toNumber() <= 0) { break; }
            } else {
                if (i >= precision) { break; }
                if (remainder.toNumber() <= 0) { result += "0"; i++; continue; }
                nextPrecision = precision - i;
                if (nextPrecision > 14) { nextPrecision = 14; }
            }
            var next = Math.abs(remainder.hi).toExponential(nextPrecision).split("e");
            var nextDigs = next[0].replace(/\./g, "");
            var nextLength = nextDigs.length;
            if (nextLength > 15) { nextLength = 15; }
            if (precision === undefined) { if (nextLength + i > 33) { nextLength = 33 - i; } }
            else { if (nextLength + i > precision) { nextLength = precision - i; } }
            if (nextLength <= 0) { break; }
            nextDigs = nextDigs.slice(0, nextLength);
            result += nextDigs;
            i += nextLength;
            if (i >= 33) { break; }
            var sub = nextDigs[0] + "." + nextDigs.slice(1);
            Double.sub22(remainder, new Double(sub + "e" + next[1]));
            if (remainder.hi < 0) { Double.mul21(remainder, -1); }
        }
        return result + "e" + str[1];
    }

    toString() { return this.toExponential(); }

    // ---- Double + Double (in place, returns X) ----
    static add22(X, Y) {
        var ah = X.hi, al = X.lo, bh = Y.hi, bl = Y.lo;
        var sh = ah + bh, bv = sh - ah;
        var sl = (ah - (sh - bv)) + (bh - bv);
        var eh = al + bl, ev = eh - al;
        var el = (al - (eh - ev)) + (bl - ev);
        var c = sl + eh, vh = sh + c, vl = c - (vh - sh);
        c = vl + el;
        X.hi = vh + c; X.lo = c - (X.hi - vh);
        return X;
    }
    static sub22(X, Y) {
        var ah = X.hi, al = X.lo, bh = -Y.hi, bl = -Y.lo;
        var sh = ah + bh, bv = sh - ah;
        var sl = (ah - (sh - bv)) + (bh - bv);
        var eh = al + bl, ev = eh - al;
        var el = (al - (eh - ev)) + (bl - ev);
        var c = sl + eh, vh = sh + c, vl = c - (vh - sh);
        c = vl + el;
        X.hi = vh + c; X.lo = c - (X.hi - vh);
        return X;
    }
    static mul22(X, Y) {
        var ah = X.hi, al = X.lo, bh = Y.hi, bl = Y.lo;
        var t = splitter * ah;
        var ahh = t + (ah - t), ahl = ah - ahh;
        t = splitter * bh;
        var bhh = t + (bh - t), bhl = bh - bhh;
        var ph = ah * bh;
        var pl = ((ahh * bhh - ph) + ahh * bhl + ahl * bhh) + ahl * bhl;
        pl += ah * bl + al * bh;
        X.hi = ph + pl; X.lo = pl - (X.hi - ph);
        return X;
    }
    static div22(X, Y) {
        var xh = X.hi, xl = X.lo, yh = Y.hi, yl = Y.lo;
        var s = xh / yh;
        var t = splitter * s;
        var sh = t + (s - t), sl = s - sh;
        t = splitter * yh;
        var yhh = t + (yh - t), yhl = yh - yhh;
        var ph = s * yh;
        var pl = ((sh * yhh - ph) + sh * yhl + sl * yhh) + sl * yhl;
        var e = ((((xh - ph) - pl) + xl) - s * yl) / yh;
        X.hi = s + e; X.lo = e - (X.hi - s);
        return X;
    }

    // ---- Double x scalar ----
    static add21(X, f) {
        var ah = X.hi;
        var sh = ah + f, bv = sh - ah;
        var sl = (ah - (sh - bv)) + (f - bv);
        sl += X.lo;
        X.hi = sh + sl; X.lo = sl - (X.hi - sh);
        return X;
    }
    static sub21(X, f) { return Double.add21(X, -f); }
    static mul21(X, f) {
        var ah = X.hi, al = X.lo;
        var t = splitter * ah;
        var ahh = t + (ah - t), ahl = ah - ahh;
        t = splitter * f;
        var fh = t + (f - t), fl = f - fh;
        var ph = ah * f;
        var pl = ((ahh * fh - ph) + ahh * fl + ahl * fh) + ahl * fl;
        var cl = al * f + pl;
        X.hi = ph + cl; X.lo = cl - (X.hi - ph);
        return X;
    }
    static div21(X, f) {
        var xh = X.hi, xl = X.lo;
        var th = xh / f;
        var t = splitter * th;
        var thh = t + (th - t), thl = th - thh;
        t = splitter * f;
        var fh = t + (f - t), fl = f - fh;
        var ph = th * f;
        var pl = ((thh * fh - ph) + thh * fl + thl * fh) + thl * fl;
        var dh = xh - ph, db = dh - xh;
        var dl = (xh - (dh - db)) + (-ph - db);
        var tl = (dh + (dl + (xl - pl))) / f;
        X.hi = th + tl; X.lo = tl - (X.hi - th);
        return X;
    }

    // ---- unary ----
    static abs2(X) { if (X.hi < 0) { X.hi = -X.hi; X.lo = -X.lo; } return X; }
    static neg2(X) { X.hi = -X.hi; X.lo = -X.lo; return X; }
    static inv2(X) {
        var xh = X.hi, xl = X.lo;
        var s = 1 / xh;
        var t = splitter * s;
        var sh = t + (s - t), sl = s - sh;
        t = splitter * xh;
        var xhh = t + (xh - t), xhl = xh - xhh;
        var ph = s * xh;
        var pl = ((sh * xhh - ph) + sh * xhl + sl * xhh) + sl * xhl;
        var zl = (1 - ph - pl - s * xl) / xh;
        X.hi = s + zl; X.lo = zl - (X.hi - s);
        return X;
    }
    static sqr2(X) {
        var ah = X.hi, al = X.lo;
        var t = splitter * ah;
        var ahh = t + (ah - t), ahl = ah - ahh;
        var ph = ah * ah;
        var hl = ahl * ahh;
        var pl = ((ahh * ahh - ph) + hl + hl) + ahl * ahl;
        var c = ah * al;
        pl += c + c;
        X.hi = ph + pl; X.lo = pl - (X.hi - ph);
        return X;
    }
    static sqrt2(X) {
        if (X.hi === 0) { X.lo = 0; return X; }
        var xh = X.hi, xl = X.lo;
        var s = Math.sqrt(xh);
        var t = splitter * s;
        var sh = t + (s - t), sl = s - sh;
        var ph = s * s;
        var hl = sl * sh;
        var pl = ((sh * sh - ph) + hl + hl) + sl * sl;
        var e = (xh - ph - pl + xl) * 0.5 / s;
        X.hi = s + e; X.lo = e - (X.hi - s);
        return X;
    }

    // ---- comparisons ----
    static eq22(X, Y) { return X.hi === Y.hi && X.lo === Y.lo; }
    static ne22(X, Y) { return X.hi !== Y.hi || X.lo !== Y.lo; }
    static gt22(X, Y) { return X.hi > Y.hi || (X.hi === Y.hi && X.lo > Y.lo); }
    static lt22(X, Y) { return X.hi < Y.hi || (X.hi === Y.hi && X.lo < Y.lo); }
    static ge22(X, Y) { return X.hi > Y.hi || (X.hi === Y.hi && X.lo >= Y.lo); }
    static le22(X, Y) { return X.hi < Y.hi || (X.hi === Y.hi && X.lo <= Y.lo); }
    static eq21(X, f) { return X.hi === f && X.lo === 0; }
    static ne21(X, f) { return X.hi !== f || X.lo !== 0; }
    static gt21(X, f) { return X.hi > f || (X.hi === f && X.lo > 0); }
    static lt21(X, f) { return X.hi < f || (X.hi === f && X.lo < 0); }
    static ge21(X, f) { return X.hi > f || (X.hi === f && X.lo >= 0); }
    static le21(X, f) { return X.hi < f || (X.hi === f && X.lo <= 0); }

    // ---- constants ----
    static get One() { return Double.create(1, 0); }
    static get Zero() { return Double.create(0, 0); }
    static get Infinity() { return Double.create(Infinity, Infinity); }
    static get MinusInfinity() { return Double.create(-Infinity, -Infinity); }
    static get NaN() { return Double.create(NaN, NaN); }
    static get Pi() { return Double.create(3.141592653589793, 1.2246467991473532e-16); }
    static get X2Pi() { return Double.create(6.283185307179586, 2.4492935982947064e-16); }
    static get E() { return Double.create(2.718281828459045, 1.4456468917292502e-16); }
    static get Log2() { return Double.create(0.6931471805599453, 2.319046813846299e-17); }
    static get Phi() { return Double.create(1.618033988749895, -5.432115203682505e-17); }

    // ---- elementary functions ----
    static exp2(X) {
        if (Double.eq21(X, 0)) { return Double.One; }
        if (Double.eq21(X, 1)) { return Double.E; }
        var n = Math.floor(X.hi / Double.Log2.hi + 0.5);
        Double.sub22(X, Double.mul21(Double.Log2, n));
        var U = Double.One, V = Double.One;
        var padeCoef = [
            1, 272, 36720, 3255840, 211629600, 10666131840, 430200650880, 14135164243200,
            381649434566400, 8481098545920000, 154355993535744030, 2273242813890047700,
            26521166162050560000, 236650405753681870000, 1.5213240369879552e21,
            6.288139352883548e21, 1.2576278705767096e22
        ];
        for (var i = 0; i < padeCoef.length; i++) { Double.add21(Double.mul22(U, X), padeCoef[i]); }
        for (var j = 0; j < padeCoef.length; j++) { Double.add21(Double.mul22(V, X), padeCoef[j] * ((j % 2) ? -1 : 1)); }
        return Double.mul21pow2(Double.div22(U, V), n);
    }
    static ln2(X) {
        if (Double.le21(X, 0)) { return Double.MinusInfinity; }
        if (Double.eq21(X, 1)) { return Double.Zero; }
        var Z = new Double(Math.log(X.hi));
        Double.sub21(Double.add22(Double.mul22(X, Double.exp2(Double.neg2(Double.clone(Z)))), Z), 1);
        return X;
    }
    static sinh2(X) {
        var exp = Double.exp2(X);
        return Double.mul21pow2(Double.sub22(new Double(exp), Double.inv2(exp)), -1);
    }
    static cosh2(X) {
        var exp = Double.exp2(X);
        return Double.mul21pow2(Double.add22(new Double(exp), Double.inv2(exp)), -1);
    }
    static pow22(base, exp) { return Double.exp2(Double.mul22(Double.ln2(base), exp)); }
    static mul21pow2(X, n) {
        var c = Math.pow(2, n);
        X.hi *= c; X.lo *= c;
        return X;
    }
    static pow2n(X, n) {
        n = n | 0;
        if (n === 0) { return Double.One; }
        if (n === 1) { return X; }
        var isPositive = n > 0;
        if (!isPositive) { n = -n; }
        var i = 31 - Math.clz32(n | 1);
        var j = n - (1 << i);
        var X0 = Double.clone(X);
        while (i--) { Double.sqr2(X); }
        while (j--) { Double.mul22(X, X0); }
        return isPositive ? X : Double.inv2(X);
    }

    // ---- full-precision trig (~106-bit, range-reduced Taylor) ----
    static sin2(X) {
        var k = Math.round(X.hi / Double.X2Pi.hi);
        Double.sub22(X, Double.mul21(Double.X2Pi, k));
        if (Double.gt21(X, Double.Pi.hi)) { Double.sub22(X, Double.mul21(Double.Pi, 2)); }
        if (Double.lt21(X, -Double.Pi.hi)) { Double.add22(X, Double.mul21(Double.Pi, 2)); }
        var R2 = Double.sqr2(Double.clone(X));
        var term = Double.clone(X);
        var result = Double.clone(X);
        var fact = 1;
        for (var i = 1; i <= 22; i++) {
            Double.mul22(term, R2);
            fact = (2 * i) * (2 * i + 1);
            Double.mul21(term, -1 / fact);
            Double.add22(result, term);
            if (Math.abs(term.hi) < 1e-34) { break; }
        }
        X.hi = result.hi; X.lo = result.lo;
        return X;
    }
    static cos2(X) {
        var k = Math.round(X.hi / Double.X2Pi.hi);
        Double.sub22(X, Double.mul21(Double.X2Pi, k));
        if (Double.gt21(X, Double.Pi.hi)) { Double.sub22(X, Double.mul21(Double.Pi, 2)); }
        if (Double.lt21(X, -Double.Pi.hi)) { Double.add22(X, Double.mul21(Double.Pi, 2)); }
        var R2 = Double.sqr2(Double.clone(X));
        var term = Double.create(1, 0);
        var result = Double.create(1, 0);
        var fact = 1;
        for (var i = 1; i <= 22; i++) {
            Double.mul22(term, R2);
            fact = (2 * i - 1) * (2 * i);
            Double.mul21(term, -1 / fact);
            Double.add22(result, term);
            if (Math.abs(term.hi) < 1e-34) { break; }
        }
        X.hi = result.hi; X.lo = result.lo;
        return X;
    }

    // ---- instance methods ----
    add(other) { return Double.add22(Double.clone(this), new Double(other)); }
    sub(other) { return Double.sub22(Double.clone(this), new Double(other)); }
    mul(other) { return Double.mul22(Double.clone(this), new Double(other)); }
    div(other) { return Double.div22(Double.clone(this), new Double(other)); }
    eq(o) { var d = new Double(o); return Double.eq22(this, d); }
    ne(o) { var d = new Double(o); return Double.ne22(this, d); }
    gt(o) { var d = new Double(o); return Double.gt22(this, d); }
    lt(o) { var d = new Double(o); return Double.lt22(this, d); }
    ge(o) { var d = new Double(o); return Double.ge22(this, d); }
    le(o) { var d = new Double(o); return Double.le22(this, d); }
    abs() { return Double.abs2(Double.clone(this)); }
    neg() { return Double.neg2(Double.clone(this)); }
    inv() { return Double.inv2(Double.clone(this)); }
    sqr() { return Double.sqr2(Double.clone(this)); }
    sqrt() { return Double.sqrt2(Double.clone(this)); }
    exp() { return Double.exp2(Double.clone(this)); }
    ln() { return Double.ln2(Double.clone(this)); }
    sinh() { return Double.sinh2(Double.clone(this)); }
    cosh() { return Double.cosh2(Double.clone(this)); }
    sin() { return Double.sin2(Double.clone(this)); }
    cos() { return Double.cos2(Double.clone(this)); }
    pow(e) { return Double.pow22(Double.clone(this), new Double(e)); }
    pown(e) { return Double.pow2n(Double.clone(this), e); }
}

// ============================================================================
// 3. POOL (zero-GC Double reuse)
// ============================================================================
function createDoublePool(capacity) {
    return createPool(
        function () { var d = Object.create(Double.prototype); d.hi = 0; d.lo = 0; return d; },
        capacity || 256,
        function (d) { d.hi = 0; d.lo = 0; }
    );
}
var _defaultPool = null;
function getDefaultPool() { if (_defaultPool === null) { _defaultPool = createDoublePool(); } return _defaultPool; }
function acquire() { return getDefaultPool().acquire(); }
function release(d) { getDefaultPool().release(d); }

// ============================================================================
// 4. SOA — 1M+ double-doubles
// ============================================================================
function createDoubleSOA(count) {
    var soa = createSOA(count, 2, Float64Array);
    return { hi: soa.arrays[0], lo: soa.arrays[1], arrays: soa.arrays, buffer: soa.buffer, count: count, components: 2 };
}
function soaZero(out) { out.hi.fill(0); out.lo.fill(0); return out; }
function soaGet(out, soa, i) { out.hi = soa.hi[i]; out.lo = soa.lo[i]; return out; }
function soaSet(soa, i, d) { soa.hi[i] = d.hi; soa.lo[i] = d.lo; return soa; }
function soaCopy(out, a) { out.hi.set(a.hi); out.lo.set(a.lo); return out; }
function soaToFlat(out, soa) {
    var n = soa.count, hi = soa.hi, lo = soa.lo;
    for (var i = 0; i < n; i++) { out[i * 2] = hi[i]; out[i * 2 + 1] = lo[i]; }
    return out;
}
function soaFromFlat(soa, flat) {
    var n = soa.count, hi = soa.hi, lo = soa.lo;
    for (var i = 0; i < n; i++) { hi[i] = flat[i * 2]; lo[i] = flat[i * 2 + 1]; }
    return soa;
}
function soaFillScalar(out, hi, lo) { out.hi.fill(hi); out.lo.fill(lo === undefined ? 0 : lo); return out; }

/**
 * Promote Float32 data into a Double SOA.
 *  - typed array / Array source: element-wise promotion (hi = value, lo = 0)
 *  - vec3 SOA source {x,y,z}: original scalar-reduction semantics preserved
 *    (hi = x + y + z, lo = 0) for backwards compatibility.
 */
function soaFromFloat32(out, src) {
    var n = out.count, hi = out.hi, lo = out.lo;
    if (src && src.x && src.y && src.z) {
        var sx = src.x, sy = src.y, sz = src.z;
        for (var i = 0; i < n; i++) { hi[i] = sx[i] + sy[i] + sz[i]; lo[i] = 0; }
    } else {
        for (var j = 0; j < n; j++) { hi[j] = src[j]; lo[j] = 0; }
    }
    return out;
}

// ============================================================================
// 5. SOA BINARY OPS (inlined error-free transforms, zero allocation)
// ============================================================================
function soaAdd22(out, a, b) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, bHi = b.hi, bLo = b.lo, n = out.count;
    for (var i = 0; i < n; i++) {
        var ah = aHi[i], al = aLo[i], bh = bHi[i], bl = bLo[i];
        var sh = ah + bh, bv = sh - ah;
        var sl = (ah - (sh - bv)) + (bh - bv);
        var eh = al + bl, ev = eh - al;
        var el = (al - (eh - ev)) + (bl - ev);
        var c = sl + eh, vh = sh + c, vl = c - (vh - sh);
        c = vl + el;
        oHi[i] = vh + c; oLo[i] = c - (oHi[i] - vh);
    }
    return out;
}
function soaSub22(out, a, b) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, bHi = b.hi, bLo = b.lo, n = out.count;
    for (var i = 0; i < n; i++) {
        var ah = aHi[i], al = aLo[i], bh = -bHi[i], bl = -bLo[i];
        var sh = ah + bh, bv = sh - ah;
        var sl = (ah - (sh - bv)) + (bh - bv);
        var eh = al + bl, ev = eh - al;
        var el = (al - (eh - ev)) + (bl - ev);
        var c = sl + eh, vh = sh + c, vl = c - (vh - sh);
        c = vl + el;
        oHi[i] = vh + c; oLo[i] = c - (oHi[i] - vh);
    }
    return out;
}
function soaMul22(out, a, b) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, bHi = b.hi, bLo = b.lo, n = out.count;
    for (var i = 0; i < n; i++) {
        var ah = aHi[i], al = aLo[i], bh = bHi[i], bl = bLo[i];
        var t = splitter * ah;
        var ahh = t + (ah - t), ahl = ah - ahh;
        t = splitter * bh;
        var bhh = t + (bh - t), bhl = bh - bhh;
        var ph = ah * bh;
        var pl = ((ahh * bhh - ph) + ahh * bhl + ahl * bhh) + ahl * bhl;
        pl += ah * bl + al * bh;
        oHi[i] = ph + pl; oLo[i] = pl - (oHi[i] - ph);
    }
    return out;
}
function soaDiv22(out, a, b) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, bHi = b.hi, bLo = b.lo, n = out.count;
    for (var i = 0; i < n; i++) {
        var xh = aHi[i], xl = aLo[i], yh = bHi[i], yl = bLo[i];
        var s = xh / yh;
        var t = splitter * s;
        var sh = t + (s - t), sl = s - sh;
        t = splitter * yh;
        var yhh = t + (yh - t), yhl = yh - yhh;
        var ph = s * yh;
        var pl = ((sh * yhh - ph) + sh * yhl + sl * yhh) + sl * yhl;
        var e = ((((xh - ph) - pl) + xl) - s * yl) / yh;
        oHi[i] = s + e; oLo[i] = e - (oHi[i] - s);
    }
    return out;
}
function soaAdd21(out, a, f) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, n = out.count;
    for (var i = 0; i < n; i++) {
        var ah = aHi[i];
        var sh = ah + f, bv = sh - ah;
        var sl = (ah - (sh - bv)) + (f - bv);
        sl += aLo[i];
        oHi[i] = sh + sl; oLo[i] = sl - (oHi[i] - sh);
    }
    return out;
}
function soaSub21(out, a, f) { return soaAdd21(out, a, -f); }
function soaMul21(out, a, f) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, n = out.count;
    var t = splitter * f;
    var fh = t + (f - t), fl = f - fh;
    for (var i = 0; i < n; i++) {
        var ah = aHi[i], al = aLo[i];
        t = splitter * ah;
        var ahh = t + (ah - t), ahl = ah - ahh;
        var ph = ah * f;
        var pl = ((ahh * fh - ph) + ahh * fl + ahl * fh) + ahl * fl;
        var cl = al * f + pl;
        oHi[i] = ph + cl; oLo[i] = cl - (oHi[i] - ph);
    }
    return out;
}
function soaDiv21(out, a, f) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, n = out.count;
    var t = splitter * f;
    var fh = t + (f - t), fl = f - fh;
    for (var i = 0; i < n; i++) {
        var xh = aHi[i], xl = aLo[i];
        var th = xh / f;
        t = splitter * th;
        var thh = t + (th - t), thl = th - thh;
        var ph = th * f;
        var pl = ((thh * fh - ph) + thh * fl + thl * fh) + thl * fl;
        var dh = xh - ph, db = dh - xh;
        var dl = (xh - (dh - db)) + (-ph - db);
        var tl = (dh + (dl + (xl - pl))) / f;
        oHi[i] = th + tl; oLo[i] = tl - (oHi[i] - th);
    }
    return out;
}
function soaNeg2(out, a) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, n = out.count;
    for (var i = 0; i < n; i++) { oHi[i] = -aHi[i]; oLo[i] = -aLo[i]; }
    return out;
}
function soaAbs2(out, a) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, n = out.count;
    for (var i = 0; i < n; i++) {
        var sign = aHi[i] < 0 ? -1 : 1;
        oHi[i] = aHi[i] * sign; oLo[i] = aLo[i] * sign;
    }
    return out;
}
function soaInv2(out, a) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, n = out.count;
    for (var i = 0; i < n; i++) {
        var xh = aHi[i], xl = aLo[i];
        var s = 1 / xh;
        var t = splitter * s;
        var sh = t + (s - t), sl = s - sh;
        t = splitter * xh;
        var xhh = t + (xh - t), xhl = xh - xhh;
        var ph = s * xh;
        var pl = ((sh * xhh - ph) + sh * xhl + sl * xhh) + sl * xhl;
        var zl = (1 - ph - pl - s * xl) / xh;
        oHi[i] = s + zl; oLo[i] = zl - (oHi[i] - s);
    }
    return out;
}
function soaSqr2(out, a) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, n = out.count;
    for (var i = 0; i < n; i++) {
        var ah = aHi[i], al = aLo[i];
        var t = splitter * ah;
        var ahh = t + (ah - t), ahl = ah - ahh;
        var ph = ah * ah;
        var hl = ahl * ahh;
        var pl = ((ahh * ahh - ph) + hl + hl) + ahl * ahl;
        var c = ah * al;
        pl += c + c;
        oHi[i] = ph + pl; oLo[i] = pl - (oHi[i] - ph);
    }
    return out;
}
function soaSqrt2(out, a) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, n = out.count;
    for (var i = 0; i < n; i++) {
        var xh = aHi[i], xl = aLo[i];
        if (xh === 0) { oHi[i] = 0; oLo[i] = 0; continue; }
        var s = Math.sqrt(xh);
        var t = splitter * s;
        var sh = t + (s - t), sl = s - sh;
        var ph = s * s;
        var hl = sl * sh;
        var pl = ((sh * sh - ph) + hl + hl) + sl * sl;
        var e = (xh - ph - pl + xl) * 0.5 / s;
        oHi[i] = s + e; oLo[i] = e - (oHi[i] - s);
    }
    return out;
}

// ---- comparisons (write Uint8Array of 0/1) ---------------------------------
function soaCompare(outFlags, a, b, op) {
    var aHi = a.hi, aLo = a.lo, bHi = b.hi, bLo = b.lo, n = a.count;
    for (var i = 0; i < n; i++) {
        var ah = aHi[i], al = aLo[i], bh = bHi[i], bl = bLo[i];
        var v;
        switch (op) {
            case "eq": v = ah === bh && al === bl; break;
            case "ne": v = ah !== bh || al !== bl; break;
            case "gt": v = ah > bh || (ah === bh && al > bl); break;
            case "lt": v = ah < bh || (ah === bh && al < bl); break;
            case "ge": v = ah > bh || (ah === bh && al >= bl); break;
            case "le": v = ah < bh || (ah === bh && al <= bl); break;
            default: v = false;
        }
        outFlags[i] = v ? 1 : 0;
    }
    return outFlags;
}
function soaEq(a, b, out) { return soaCompare(out || new Uint8Array(a.count), a, b, "eq"); }
function soaNe(a, b, out) { return soaCompare(out || new Uint8Array(a.count), a, b, "ne"); }
function soaGt(a, b, out) { return soaCompare(out || new Uint8Array(a.count), a, b, "gt"); }
function soaLt(a, b, out) { return soaCompare(out || new Uint8Array(a.count), a, b, "lt"); }
function soaGe(a, b, out) { return soaCompare(out || new Uint8Array(a.count), a, b, "ge"); }
function soaLe(a, b, out) { return soaCompare(out || new Uint8Array(a.count), a, b, "le"); }

// ============================================================================
// 6. CHUNKED ASYNC (mobile-safe — 1M+ elements without UI freeze)
// ============================================================================
async function _chunked(out, perElem, chunkSize, yieldEvery) {
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
function soaAdd22Chunked(out, a, b, chunkSize, yieldEvery) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, bHi = b.hi, bLo = b.lo;
    return _chunked(out, function (i) {
        var ah = aHi[i], al = aLo[i], bh = bHi[i], bl = bLo[i];
        var sh = ah + bh, bv = sh - ah;
        var sl = (ah - (sh - bv)) + (bh - bv);
        var eh = al + bl, ev = eh - al;
        var el = (al - (eh - ev)) + (bl - ev);
        var c = sl + eh, vh = sh + c, vl = c - (vh - sh);
        c = vl + el;
        oHi[i] = vh + c; oLo[i] = c - (oHi[i] - vh);
    }, chunkSize, yieldEvery);
}
function soaMul22Chunked(out, a, b, chunkSize, yieldEvery) {
    var oHi = out.hi, oLo = out.lo, aHi = a.hi, aLo = a.lo, bHi = b.hi, bLo = b.lo;
    return _chunked(out, function (i) {
        var ah = aHi[i], al = aLo[i], bh = bHi[i], bl = bLo[i];
        var t = splitter * ah;
        var ahh = t + (ah - t), ahl = ah - ahh;
        t = splitter * bh;
        var bhh = t + (bh - t), bhl = bh - bhh;
        var ph = ah * bh;
        var pl = ((ahh * bhh - ph) + ahh * bhl + ahl * bhh) + ahl * bhl + ah * bl + al * bh;
        oHi[i] = ph + pl; oLo[i] = pl - (oHi[i] - ph);
    }, chunkSize, yieldEvery);
}
async function soaStepChunked(soa, stepFn, chunkSize, yieldEvery) {
    return _chunked(soa, function (i) { stepFn(i, soa); }, chunkSize, yieldEvery);
}
async function soaForEachChunked(out, a, callback, chunkSize, yieldEvery) {
    return _chunked(out, function (i) { callback(i, a, out); }, chunkSize, yieldEvery);
}

// ============================================================================
// 7. PROCEDURAL (deterministic high-precision noise)
// ============================================================================
function hash3_64(x, y, z) {
    var kx = Math.floor(x * 1048576) + 0;
    var ky = Math.floor(y * 1048576) + 0;
    var kz = Math.floor(z * 1048576) + 0;
    var h = Math.imul(kx | 0, 374761393) + Math.imul(ky | 0, 668265263) + Math.imul(kz | 0, 2147483647);
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return h / 4294967296;
}
/**
 * Value noise sampled from double-precision positions.
 * positions = { x: DoubleSOA, y: DoubleSOA, z: DoubleSOA }; the hi words drive
 * the lattice hash (lo words contribute < 1e-16 relative — below noise scale).
 * out = Float32Array / Float64Array of length positions.count.
 */
function valueNoise3D_64(out, positions, scale) {
    scale = scale || 1;
    var px = positions.x.hi, py = positions.y.hi, pz = positions.z.hi;
    var n = positions.x.count;
    for (var i = 0; i < n; i++) {
        var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
        var xf = x - xi, yf = y - yi, zf = z - zi;
        var u = xf * xf * (3 - 2 * xf);
        var v = yf * yf * (3 - 2 * yf);
        var w = zf * zf * (3 - 2 * zf);
        var a = hash3_64(xi, yi, zi), b = hash3_64(xi + 1, yi, zi);
        var c = hash3_64(xi, yi + 1, zi), d = hash3_64(xi + 1, yi + 1, zi);
        var e = hash3_64(xi, yi, zi + 1), f = hash3_64(xi + 1, yi, zi + 1);
        var g = hash3_64(xi, yi + 1, zi + 1), h = hash3_64(xi + 1, yi + 1, zi + 1);
        var x00 = a + (b - a) * u;
        var x10 = c + (d - c) * u;
        var x01 = e + (f - e) * u;
        var x11 = g + (h - g) * u;
        var y0 = x00 + (x10 - x00) * v;
        var y1 = x01 + (x11 - x01) * v;
        out[i] = y0 + (y1 - y0) * w;
    }
    return out;
}

// ============================================================================
// 8. ORBITAL — Kepler at ~48-bit (fast) and ~106-bit (exact) tiers
// ============================================================================
/** Fast tier: Newton on hi words. Returns a shared module temp (copy if kept). */
function keplerSolve2(M, e, maxIter) {
    maxIter = maxIter || 12;
    _tmpDoubleA.hi = M.hi; _tmpDoubleA.lo = M.lo;
    var eHi = e.hi;
    for (var i = 0; i < maxIter; i++) {
        var En = _tmpDoubleA.hi;
        var sinE = Math.sin(En);
        var f = En - eHi * sinE - M.hi;
        var fp = 1 - eHi * Math.cos(En);
        if (Math.abs(f) < 1e-14) { break; }
        Double.sub21(_tmpDoubleA, f / fp);
    }
    return _tmpDoubleA;
}
/** Exact tier: full Double Newton with sin2/cos2. Allocates; archival / replay. */
function keplerSolve2Exact(M, e, maxIter) {
    maxIter = maxIter || 15;
    var E = Double.clone(M);
    var eD = Double.clone(e);
    for (var i = 0; i < maxIter; i++) {
        var sinE = Double.sin2(Double.clone(E));
        var cosE = Double.cos2(Double.clone(E));
        var f = Double.clone(E);
        Double.sub22(f, Double.mul22(Double.clone(eD), sinE));
        Double.sub22(f, M);
        var fp = Double.create(1, 0);
        Double.sub22(fp, Double.mul22(Double.clone(eD), cosE));
        var delta = Double.div22(f, fp);
        Double.sub22(E, delta);
        if (Double.lt21(Double.abs2(Double.clone(delta)), 1e-30)) { break; }
    }
    return E;
}
function _integrateOrbitElement(i, dt, mu, el, outPos, outVel) {
    var ai = el.a[i], ei = el.e[i];
    var nMean = Math.sqrt(mu / (ai * ai * ai));
    _tmpDoubleB.hi = el.M[i] + dt * nMean; _tmpDoubleB.lo = 0;
    _tmpDoubleC.hi = ei; _tmpDoubleC.lo = 0;
    var E = keplerSolve2(_tmpDoubleB, _tmpDoubleC);
    var En = E.hi;
    var cosE = Math.cos(En), sinE = Math.sin(En);
    var xp = ai * (cosE - ei);
    var yp = ai * Math.sqrt(1 - ei * ei) * sinE;
    var cw = Math.cos(el.om[i]), sw = Math.sin(el.om[i]);
    var ci = Math.cos(el.inc[i]), si = Math.sin(el.inc[i]);
    var cO = Math.cos(el.Om[i]), sO = Math.sin(el.Om[i]);
    var x1 = xp * cw - yp * sw;
    var y1 = xp * sw + yp * cw;
    var y2 = y1 * ci;
    var z2 = y1 * si;
    outPos.x.hi[i] = x1 * cO - y2 * sO; outPos.x.lo[i] = 0;
    outPos.y.hi[i] = x1 * sO + y2 * cO; outPos.y.lo[i] = 0;
    outPos.z.hi[i] = z2; outPos.z.lo[i] = 0;
    if (outVel) {
        var dEdt = nMean / (1 - ei * cosE);
        var vxp = -ai * sinE * dEdt;
        var vyp = ai * Math.sqrt(1 - ei * ei) * cosE * dEdt;
        var vx1 = vxp * cw - vyp * sw;
        var vy1 = vxp * sw + vyp * cw;
        var vy2 = vy1 * ci;
        var vz2 = vy1 * si;
        outVel.x.hi[i] = vx1 * cO - vy2 * sO; outVel.x.lo[i] = 0;
        outVel.y.hi[i] = vx1 * sO + vy2 * cO; outVel.y.lo[i] = 0;
        outVel.z.hi[i] = vz2; outVel.z.lo[i] = 0;
    }
}
/** One Kepler step for 1M+ bodies (fast tier, zero allocation). */
function integrateOrbitSOA(dt, mu, elements, outPosXYZ, outVelXYZ) {
    var n = elements.a.length;
    for (var i = 0; i < n; i++) { _integrateOrbitElement(i, dt, mu, elements, outPosXYZ, outVelXYZ); }
    return outPosXYZ;
}
/** Chunked variant — never freezes the main thread at 1M bodies. */
async function integrateOrbitSOAChunked(dt, mu, elements, outPosXYZ, outVelXYZ, chunkSize, yieldEvery) {
    chunkSize = chunkSize || CHUNK_SIZE;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    var n = elements.a.length, c = 0;
    for (var start = 0; start < n; start += chunkSize) {
        var end = Math.min(start + chunkSize, n);
        for (var i = start; i < end; i++) { _integrateOrbitElement(i, dt, mu, elements, outPosXYZ, outVelXYZ); }
        if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
    }
    return outPosXYZ;
}

// ============================================================================
// 9. ANIMATION — spring damping at double precision
// ============================================================================
function springDamp2(current, target, velocity, smoothTime, dt, maxSpeed) {
    if (smoothTime < 0.0001) { smoothTime = 0.0001; }
    if (maxSpeed === undefined) { maxSpeed = Infinity; }
    var omega = 2 / smoothTime;
    var x = omega * dt;
    var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    var change = current - target;
    var originalTarget = target;
    var maxChange = maxSpeed * smoothTime;
    if (change > maxChange) { change = maxChange; }
    else if (change < -maxChange) { change = -maxChange; }
    target = current - change;
    var temp = (velocity[0] + omega * change) * dt;
    velocity[0] = (velocity[0] - omega * temp) * exp;
    var output = target + (change + temp) * exp;
    if ((originalTarget - current > 0) === (output > originalTarget)) {
        output = originalTarget;
        velocity[0] = (output - originalTarget) / dt;
    }
    return output;
}
function soaSpringDamp2(out, current, target, vel, smoothTime, dt, maxSpeed) {
    var oHi = out.hi, oLo = out.lo;
    var cHi = current.hi, tHi = target.hi, vArr = vel.hi;
    var n = out.count;
    if (smoothTime < 0.0001) { smoothTime = 0.0001; }
    if (maxSpeed === undefined) { maxSpeed = Infinity; }
    var omega = 2 / smoothTime;
    var x = omega * dt;
    var exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    var maxChange = maxSpeed * smoothTime;
    for (var i = 0; i < n; i++) {
        var c = cHi[i], t = tHi[i];
        var change = c - t;
        var originalTarget = t;
        if (change > maxChange) { change = maxChange; }
        else if (change < -maxChange) { change = -maxChange; }
        t = c - change;
        var temp = (vArr[i] + omega * change) * dt;
        vArr[i] = (vArr[i] - omega * temp) * exp;
        var output = t + (change + temp) * exp;
        if ((originalTarget - c > 0) === (output > originalTarget)) {
            output = originalTarget;
            vArr[i] = (output - originalTarget) / dt;
        }
        oHi[i] = output; oLo[i] = 0;
    }
    return out;
}

// ============================================================================
// 10. IK — FABRIK at double precision (root preserved, returns squared error)
// ============================================================================
function fabrikStep3_precise(pos, lens, target) {
    var n = lens.length + 1;
    var lastIdx = (n - 1) * 3;
    var rootX = pos[0], rootY = pos[1], rootZ = pos[2];
    pos[lastIdx] = target[0];
    pos[lastIdx + 1] = target[1];
    pos[lastIdx + 2] = target[2];
    for (var i = n - 2; i >= 0; i--) {
        var idx = i * 3, nextIdx = idx + 3;
        var dx = pos[idx] - pos[nextIdx];
        var dy = pos[idx + 1] - pos[nextIdx + 1];
        var dz = pos[idx + 2] - pos[nextIdx + 2];
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-15;
        var r = lens[i] / d;
        pos[idx] = pos[nextIdx] + dx * r;
        pos[idx + 1] = pos[nextIdx + 1] + dy * r;
        pos[idx + 2] = pos[nextIdx + 2] + dz * r;
    }
    pos[0] = rootX; pos[1] = rootY; pos[2] = rootZ;
    for (var j = 1; j < n; j++) {
        var jIdx = j * 3, prevIdx = jIdx - 3;
        var ex = pos[jIdx] - pos[prevIdx];
        var ey = pos[jIdx + 1] - pos[prevIdx + 1];
        var ez = pos[jIdx + 2] - pos[prevIdx + 2];
        var el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-15;
        var rr = lens[j - 1] / el;
        pos[jIdx] = pos[prevIdx] + ex * rr;
        pos[jIdx + 1] = pos[prevIdx + 1] + ey * rr;
        pos[jIdx + 2] = pos[prevIdx + 2] + ez * rr;
    }
    var dfx = pos[lastIdx] - target[0];
    var dfy = pos[lastIdx + 1] - target[1];
    var dfz = pos[lastIdx + 2] - target[2];
    return dfx * dfx + dfy * dfy + dfz * dfz;
}

// ============================================================================
// 11. RENDERING — double world -> float32 view / clip bridge
// ============================================================================
function mat4TransformVec3_precise(out, m, v) {
    var x = v[0], y = v[1], z = v[2];
    var w = m[3] * x + m[7] * y + m[11] * z + m[15];
    w = w || 1.0;
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
}
/**
 * Batched galactic-scale renderer bridge: subtract the floating origin in
 * double precision, then transform by a column-major float32 mat4 (three.js
 * r185 Matrix4.elements or 007_mat4 output). Writes interleaved float32.
 * stride 4 -> raw clip xyzw (GPU upload); stride 3 -> perspective-divided xyz.
 */
function soaMat4TransformDouble(out, m, pos, origin, stride, divide) {
    stride = stride || 4;
    var ox = origin ? origin[0] : 0, oy = origin ? origin[1] : 0, oz = origin ? origin[2] : 0;
    var xh = pos.x.hi, xl = pos.x.lo, yh = pos.y.hi, yl = pos.y.lo, zh = pos.z.hi, zl = pos.z.lo;
    var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
    var m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
    var m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
    var m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];
    var n = pos.x.count, o = 0;
    for (var i = 0; i < n; i++) {
        var rx = (xh[i] - ox) + xl[i];
        var ry = (yh[i] - oy) + yl[i];
        var rz = (zh[i] - oz) + zl[i];
        var cx = m0 * rx + m4 * ry + m8 * rz + m12;
        var cy = m1 * rx + m5 * ry + m9 * rz + m13;
        var cz = m2 * rx + m6 * ry + m10 * rz + m14;
        var cw = m3 * rx + m7 * ry + m11 * rz + m15;
        if (divide || stride === 3) {
            var inv = 1 / (cw || 1);
            out[o] = cx * inv; out[o + 1] = cy * inv; out[o + 2] = cz * inv;
            if (stride === 4) { out[o + 3] = 1; }
        } else {
            out[o] = cx; out[o + 1] = cy; out[o + 2] = cz; out[o + 3] = cw;
        }
        o += stride;
    }
    return out;
}

// ============================================================================
// 12. COLOR — HDR tone mapping at double precision
// ============================================================================
function acesToneMap1(x) {
    var a = 2.51, c = 0.03, d = 2.43, e = 0.59, f = 0.14;
    return (x * (a * x + c)) / (x * (d * x + e) + f);
}
function acesToneMapSOA(r, g, b) {
    var n = r.count;
    for (var i = 0; i < n; i++) {
        r.hi[i] = acesToneMap1(r.hi[i]);
        g.hi[i] = acesToneMap1(g.hi[i]);
        b.hi[i] = acesToneMap1(b.hi[i]);
        r.lo[i] = 0; g.lo[i] = 0; b.lo[i] = 0;
    }
    return r;
}

// ============================================================================
// 13. bitECS INTEGRATION — high-precision world positions + floating origin
// ============================================================================
function attachHighPrecisionPositions(world, initialCapacity) {
    initialCapacity = initialCapacity || 4096;
    var ctx = world[$internal];
    if (!ctx) { throw new Error("attachHighPrecisionPositions: world has no $internal"); }
    var cap = Math.max(ctx.entityIndex.maxId + 1, initialCapacity);
    var store = {
        x: createDoubleSOA(cap), y: createDoubleSOA(cap), z: createDoubleSOA(cap),
        capacity: cap, world: world, origin: [0, 0, 0]
    };
    ctx.highPrecisionPositions = store;
    return store;
}
function ensureCapacity(store, eid) {
    if (eid < store.capacity) { return; }
    var newCap = Math.max(store.capacity * 2, eid + 1);
    function growChannel(oldS) {
        var hi = new Float64Array(newCap); hi.set(oldS.hi);
        var lo = new Float64Array(newCap); lo.set(oldS.lo);
        return { hi: hi, lo: lo, count: newCap, arrays: [hi, lo], buffer: hi.buffer, components: 2 };
    }
    store.x = growChannel(store.x);
    store.y = growChannel(store.y);
    store.z = growChannel(store.z);
    store.capacity = newCap;
}
function setWorldPosition(store, eid, x, y, z) {
    ensureCapacity(store, eid);
    store.x.hi[eid] = x.hi !== undefined ? x.hi : x;
    store.x.lo[eid] = x.lo !== undefined ? x.lo : 0;
    store.y.hi[eid] = y.hi !== undefined ? y.hi : y;
    store.y.lo[eid] = y.lo !== undefined ? y.lo : 0;
    store.z.hi[eid] = z.hi !== undefined ? z.hi : z;
    store.z.lo[eid] = z.lo !== undefined ? z.lo : 0;
}
function getWorldPosition(store, eid, out) {
    out = out || [0, 0, 0];
    if (eid >= store.capacity) { out[0] = out[1] = out[2] = 0; return out; }
    out[0] = store.x.hi[eid] + store.x.lo[eid];
    out[1] = store.y.hi[eid] + store.y.lo[eid];
    out[2] = store.z.hi[eid] + store.z.lo[eid];
    return out;
}
function worldToFloat32(dst, store, eids, origin) {
    origin = origin || store.origin;
    var ox = origin[0], oy = origin[1], oz = origin[2];
    var n = eids.length, px = dst.x, py = dst.y, pz = dst.z;
    var sxh = store.x.hi, sxl = store.x.lo, syh = store.y.hi, syl = store.y.lo, szh = store.z.hi, szl = store.z.lo;
    for (var i = 0; i < n; i++) {
        var eid = eids[i];
        px[i] = (sxh[eid] - ox) + sxl[eid];
        py[i] = (syh[eid] - oy) + syl[eid];
        pz[i] = (szh[eid] - oz) + szl[eid];
    }
    return dst;
}
function float32ToWorld(store, src, eids, origin) {
    origin = origin || store.origin;
    var ox = origin[0], oy = origin[1], oz = origin[2];
    var n = eids.length, px = src.x, py = src.y, pz = src.z;
    for (var i = 0; i < n; i++) {
        var eid = eids[i];
        ensureCapacity(store, eid);
        store.x.hi[eid] = px[i] + ox; store.x.lo[eid] = 0;
        store.y.hi[eid] = py[i] + oy; store.y.lo[eid] = 0;
        store.z.hi[eid] = pz[i] + oz; store.z.lo[eid] = 0;
    }
}
function recenterWorld(store, origin) {
    var ox = origin[0], oy = origin[1], oz = origin[2];
    store.origin[0] += ox; store.origin[1] += oy; store.origin[2] += oz;
    var n = store.x.count;
    var sxh = store.x.hi, sxl = store.x.lo, syh = store.y.hi, syl = store.y.lo, szh = store.z.hi, szl = store.z.lo;
    for (var i = 0; i < n; i++) {
        var s = sxh[i] - ox, b = s + ox;
        sxl[i] += (sxh[i] - (s - b)) + (-ox - b); sxh[i] = s;
        s = syh[i] - oy; b = s + oy;
        syl[i] += (syh[i] - (s - b)) + (-oy - b); syh[i] = s;
        s = szh[i] - oz; b = s + oz;
        szl[i] += (szh[i] - (s - b)) + (-oz - b); szh[i] = s;
    }
}

// ============================================================================
// 14. DOUBLE-PRECISION VEC3 SOA (default-math replacement tier)
// ============================================================================
function createDoubleVec3SOA(count) {
    return { x: createDoubleSOA(count), y: createDoubleSOA(count), z: createDoubleSOA(count), count: count };
}
function soaVec3Add22(out, a, b) { soaAdd22(out.x, a.x, b.x); soaAdd22(out.y, a.y, b.y); soaAdd22(out.z, a.z, b.z); return out; }
function soaVec3Sub22(out, a, b) { soaSub22(out.x, a.x, b.x); soaSub22(out.y, a.y, b.y); soaSub22(out.z, a.z, b.z); return out; }
function soaVec3Scale21(out, a, s) { soaMul21(out.x, a.x, s); soaMul21(out.y, a.y, s); soaMul21(out.z, a.z, s); return out; }
/** out = a + t * (b - a). `out` must not alias a or b. */
function soaVec3Lerp21(out, a, b, t) {
    soaVec3Sub22(out, b, a);
    soaVec3Scale21(out, out, t);
    soaVec3Add22(out, out, a);
    return out;
}
function soaVec3Dot2(out, a, b) {
    var n = a.count, oH = out.hi, oL = out.lo;
    var axh = a.x.hi, axl = a.x.lo, ayh = a.y.hi, ayl = a.y.lo, azh = a.z.hi, azl = a.z.lo;
    var bxh = b.x.hi, bxl = b.x.lo, byh = b.y.hi, byl = b.y.lo, bzh = b.z.hi, bzl = b.z.lo;
    for (var i = 0; i < n; i++) {
        var ah = axh[i], al = axl[i], bh = bxh[i], bl = bxl[i];
        var t = splitter * ah; var a1 = t + (ah - t), a2 = ah - a1;
        t = splitter * bh; var b1 = t + (bh - t), b2 = bh - b1;
        var ph = ah * bh;
        var pl = ((a1 * b1 - ph) + a1 * b2 + a2 * b1) + a2 * b2 + ah * bl + al * bh;
        var sh = ph + pl, sv = sh - ph;
        var hi = sh, lo = pl - sv;
        ah = ayh[i]; al = ayl[i]; bh = byh[i]; bl = byl[i];
        t = splitter * ah; a1 = t + (ah - t); a2 = ah - a1;
        t = splitter * bh; b1 = t + (bh - t); b2 = bh - b1;
        ph = ah * bh;
        pl = ((a1 * b1 - ph) + a1 * b2 + a2 * b1) + a2 * b2 + ah * bl + al * bh;
        var eh = hi + ph, ev = eh - hi;
        var el = (hi - (eh - ev)) + (ph - ev);
        el += lo + pl;
        sh = eh + el; hi = sh; lo = el - (sh - eh);
        ah = azh[i]; al = azl[i]; bh = bzh[i]; bl = bzl[i];
        t = splitter * ah; a1 = t + (ah - t); a2 = ah - a1;
        t = splitter * bh; b1 = t + (bh - t); b2 = bh - b1;
        ph = ah * bh;
        pl = ((a1 * b1 - ph) + a1 * b2 + a2 * b1) + a2 * b2 + ah * bl + al * bh;
        eh = hi + ph; ev = eh - hi;
        el = (hi - (eh - ev)) + (ph - ev);
        el += lo + pl;
        sh = eh + el;
        oH[i] = sh; oL[i] = el - (sh - eh);
    }
    return out;
}
function soaVec3Length2(out, a) {
    soaVec3Dot2(out, a, a);
    soaSqrt2(out, out);
    return out;
}
function soaVec3Normalize2(out, a, scratch) {
    var len = scratch || createDoubleSOA(a.count);
    soaVec3Length2(len, a);
    soaDiv22(out.x, a.x, len);
    soaDiv22(out.y, a.y, len);
    soaDiv22(out.z, a.z, len);
    return out;
}
function soaVec3Cross2(out, a, b, scratchA, scratchB) {
    var sA = scratchA || createDoubleSOA(a.count);
    var sB = scratchB || createDoubleSOA(a.count);
    soaMul22(sA, a.y, b.z); soaMul22(sB, a.z, b.y); soaSub22(out.x, sA, sB);
    soaMul22(sA, a.z, b.x); soaMul22(sB, a.x, b.z); soaSub22(out.y, sA, sB);
    soaMul22(sA, a.x, b.y); soaMul22(sB, a.y, b.x); soaSub22(out.z, sA, sB);
    return out;
}

// ============================================================================
// 15. THREE.JS r185 INTEROP (duck-typed — no three import, no CDN, no build)
// ============================================================================
var _defaultPos = { x: 0, y: 0, z: 0 };
var _defaultQuat = { x: 0, y: 0, z: 0, w: 1 };
var _defaultScale = { x: 1, y: 1, z: 1 };

/** Write Double components (or numbers) into any three.js Vector3-like. */
function setVector3FromDouble(v, x, y, z) {
    v.set(
        x.hi !== undefined ? x.hi + x.lo : x,
        y.hi !== undefined ? y.hi + y.lo : y,
        z.hi !== undefined ? z.hi + z.lo : z
    );
    return v;
}
/** Set an Object3D's local position from the high-precision store, relative to origin. */
function applyStoreToObject3D(store, eid, origin, object) {
    var ox = origin ? origin[0] : store.origin[0];
    var oy = origin ? origin[1] : store.origin[1];
    var oz = origin ? origin[2] : store.origin[2];
    object.position.set(
        (store.x.hi[eid] - ox) + store.x.lo[eid],
        (store.y.hi[eid] - oy) + store.y.lo[eid],
        (store.z.hi[eid] - oz) + store.z.lo[eid]
    );
    return object;
}
/**
 * Fill a three.js r185 InstancedMesh from the double store (1M instances).
 * `matrix4` must be a reusable THREE.Matrix4; position/quaternion/scale are
 * optional reusable THREE objects (plain literals work — compose reads fields).
 */
function writeInstancedMatrices(mesh, store, eids, origin, matrix4, position, quaternion, scale) {
    var ox = origin ? origin[0] : store.origin[0];
    var oy = origin ? origin[1] : store.origin[1];
    var oz = origin ? origin[2] : store.origin[2];
    var p = position || _defaultPos, q = quaternion || _defaultQuat, s = scale || _defaultScale;
    var n = eids.length;
    for (var i = 0; i < n; i++) {
        var eid = eids[i];
        p.x = (store.x.hi[eid] - ox) + store.x.lo[eid];
        p.y = (store.y.hi[eid] - oy) + store.y.lo[eid];
        p.z = (store.z.hi[eid] - oz) + store.z.lo[eid];
        matrix4.compose(p, q, s);
        mesh.setMatrixAt(i, matrix4);
    }
    if (mesh.instanceMatrix) { mesh.instanceMatrix.needsUpdate = true; }
    mesh.count = n;
    return mesh;
}
/** Transform Double components by a three.js Matrix4.elements (column-major). */
function transformDoubleByMatrix4(out, elements, x, y, z) {
    var rx = x.hi !== undefined ? x.hi + x.lo : x;
    var ry = y.hi !== undefined ? y.hi + y.lo : y;
    var rz = z.hi !== undefined ? z.hi + z.lo : z;
    var w = elements[3] * rx + elements[7] * ry + elements[11] * rz + elements[15];
    w = w || 1;
    out[0] = (elements[0] * rx + elements[4] * ry + elements[8] * rz + elements[12]) / w;
    out[1] = (elements[1] * rx + elements[5] * ry + elements[9] * rz + elements[13]) / w;
    out[2] = (elements[2] * rx + elements[6] * ry + elements[10] * rz + elements[14]) / w;
    return out;
}

// ============================================================================
// 16. WORKER POOL — true multi-core SOA arithmetic (Blob URL, no server)
// ============================================================================
var _workerSource = "(" + function () {
    var SPLIT = 134217729;
    self.onmessage = function (e) {
        var d = e.data, n = d.n, op = d.op;
        var aH = d.aH, aL = d.aL, bH = d.bH, bL = d.bL, f = d.f;
        var oH = new Float64Array(n), oL = new Float64Array(n);
        for (var i = 0; i < n; i++) {
            var ah = aH[i], al = aL[i], bh = bH ? bH[i] : 0, bl = bL ? bL[i] : 0;
            var hi = 0, lo = 0, t, a1, a2, b1, b2, ph, pl, sh, bv, sl, eh, ev, el, c;
            if (op === "add22" || op === "sub22") {
                if (op === "sub22") { bh = -bh; bl = -bl; }
                sh = ah + bh; bv = sh - ah;
                sl = (ah - (sh - bv)) + (bh - bv);
                eh = al + bl; ev = eh - al;
                el = (al - (eh - ev)) + (bl - ev);
                c = sl + eh; var vh = sh + c; var vl = c - (vh - sh);
                c = vl + el;
                hi = vh + c; lo = c - (hi - vh);
            } else if (op === "mul22") {
                t = SPLIT * ah; a1 = t + (ah - t); a2 = ah - a1;
                t = SPLIT * bh; b1 = t + (bh - t); b2 = bh - b1;
                ph = ah * bh;
                pl = ((a1 * b1 - ph) + a1 * b2 + a2 * b1) + a2 * b2 + ah * bl + al * bh;
                hi = ph + pl; lo = pl - (hi - ph);
            } else if (op === "mul21") {
                t = SPLIT * ah; a1 = t + (ah - t); a2 = ah - a1;
                t = SPLIT * f; b1 = t + (f - t); b2 = f - b1;
                ph = ah * f;
                pl = ((a1 * b1 - ph) + a1 * b2 + a2 * b1) + a2 * b2 + al * f;
                hi = ph + pl; lo = pl - (hi - ph);
            } else if (op === "sqr2") {
                t = SPLIT * ah; a1 = t + (ah - t); a2 = ah - a1;
                ph = ah * ah; var hl = a2 * a1;
                pl = ((a1 * a1 - ph) + hl + hl) + a2 * a2 + 2 * ah * al;
                hi = ph + pl; lo = pl - (hi - ph);
            } else if (op === "sqrt2") {
                if (ah === 0) { hi = 0; lo = 0; }
                else {
                    var s = Math.sqrt(ah);
                    t = SPLIT * s; var s1 = t + (s - t), s2 = s - s1;
                    ph = s * s; var h2 = s2 * s1;
                    pl = ((s1 * s1 - ph) + h2 + h2) + s2 * s2;
                    var err = (ah - ph - pl + al) * 0.5 / s;
                    hi = s + err; lo = err - (hi - s);
                }
            } else if (op === "inv2") {
                var inv = 1 / ah;
                t = SPLIT * inv; a1 = t + (inv - t); a2 = inv - a1;
                t = SPLIT * ah; b1 = t + (ah - t); b2 = ah - b1;
                ph = inv * ah;
                pl = ((a1 * b1 - ph) + a1 * b2 + a2 * b1) + a2 * b2;
                var zl = (1 - ph - pl - inv * al) / ah;
                hi = inv + zl; lo = zl - (hi - inv);
            }
            oH[i] = hi; oL[i] = lo;
        }
        self.postMessage({ id: d.id, oH: oH, oL: oL }, [oH.buffer, oL.buffer]);
    };
}.toString() + ")();";

/**
 * Optional parallel executor. Returns null when Workers/Blob are unavailable;
 * `run` then resolves on the main thread via chunked yielding (never freezes).
 * op: "add22" | "sub22" | "mul22" | "mul21" | "sqr2" | "sqrt2" | "inv2".
 */
function createDoubleWorkerPool(size) {
    var workers = [], idle = [], queue = [], pending = new Map(), nextId = 1, url = null, disposed = false;
    size = size || Math.min(4, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2);
    try {
        if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) { throw new Error("no workers"); }
        url = URL.createObjectURL(new Blob([_workerSource], { type: "text/javascript" }));
        for (var i = 0; i < size; i++) {
            var w = new Worker(url);
            w.onmessage = function (e) {
                var job = pending.get(e.data.id);
                if (job) { pending.delete(e.data.id); job.resolve(e.data); }
                idle.push(this);
                _dispatch();
            };
            w.onerror = function () { idle.push(this); _dispatch(); };
            workers.push(w); idle.push(w);
        }
    } catch (e) {
        workers.length = 0; idle.length = 0;
        if (url) { URL.revokeObjectURL(url); url = null; }
    }
    function _dispatch() {
        while (queue.length > 0 && idle.length > 0) {
            var task = queue.shift();
            var w = idle.pop();
            pending.set(task.msg.id, task);
            w.postMessage(task.msg, task.transfer);
        }
    }
    function _runChunk(op, aH, aL, bH, bL, f, n) {
        return new Promise(function (resolve, reject) {
            var msg = { id: nextId++, op: op, n: n, aH: aH, aL: aL, bH: bH, bL: bL, f: f };
            var transfer = [aH.buffer, aL.buffer];
            if (bH) { transfer.push(bH.buffer); }
            if (bL) { transfer.push(bL.buffer); }
            queue.push({ msg: msg, transfer: transfer, resolve: resolve, reject: reject });
            _dispatch();
        });
    }
    async function _mainFallback(op, a, b, f, out) {
        var ops = { add22: soaAdd22, sub22: soaSub22, mul22: soaMul22, sqr2: soaSqr2, sqrt2: soaSqrt2, inv2: soaInv2 };
        if (op === "mul21") {
            await _chunked(out, function (i) {
                var ah = a.hi[i], al = a.lo[i];
                var t = splitter * ah; var a1 = t + (ah - t), a2 = ah - a1;
                t = splitter * f; var b1 = t + (f - t), b2 = f - b1;
                var ph = ah * f;
                var pl = ((a1 * b1 - ph) + a1 * b2 + a2 * b1) + a2 * b2 + al * f;
                out.hi[i] = ph + pl; out.lo[i] = pl - (out.hi[i] - ph);
            });
        } else {
            var fn = ops[op];
            await _chunked(out, function (i) {
                _tmpDoubleD.hi = a.hi[i]; _tmpDoubleD.lo = a.lo[i];
                if (op === "add22" || op === "sub22" || op === "mul22") {
                    _tmpDoubleC.hi = b.hi[i]; _tmpDoubleC.lo = b.lo[i];
                    if (op === "add22") { Double.add22(_tmpDoubleD, _tmpDoubleC); }
                    else if (op === "sub22") { Double.sub22(_tmpDoubleD, _tmpDoubleC); }
                    else { Double.mul22(_tmpDoubleD, _tmpDoubleC); }
                } else if (op === "sqr2") { Double.sqr2(_tmpDoubleD); }
                else if (op === "sqrt2") { Double.sqrt2(_tmpDoubleD); }
                else if (op === "inv2") { Double.inv2(_tmpDoubleD); }
                out.hi[i] = _tmpDoubleD.hi; out.lo[i] = _tmpDoubleD.lo;
            });
        }
        return out;
    }
    return {
        get size() { return workers.length; },
        /** Parallel op over Double SOAs; resolves to a fresh Double SOA result. */
        run: async function (op, a, b, f) {
            if (disposed) { throw new Error("pool disposed"); }
            var n = a.count;
            var out = createDoubleSOA(n);
            if (workers.length === 0) { return _mainFallback(op, a, b, f, out); }
            var W = workers.length, per = Math.ceil(n / W), jobs = [];
            for (var k = 0; k < W; k++) {
                var s = k * per, e = Math.min(s + per, n);
                if (s >= e) { break; }
                var len = e - s;
                var aH = a.hi.slice(s, e), aL = a.lo.slice(s, e);
                var bH = b ? b.hi.slice(s, e) : null, bL = b ? b.lo.slice(s, e) : null;
                jobs.push({ s: s, e: e, p: _runChunk(op, aH, aL, bH, bL, f, len) });
            }
            for (var j = 0; j < jobs.length; j++) {
                var r = await jobs[j].p;
                out.hi.set(r.oH, jobs[j].s);
                out.lo.set(r.oL, jobs[j].s);
            }
            return out;
        },
        dispose: function () {
            disposed = true;
            for (var i = 0; i < workers.length; i++) { workers[i].terminate(); }
            workers.length = 0; idle.length = 0; queue.length = 0; pending.clear();
            if (url) { URL.revokeObjectURL(url); url = null; }
        }
    };
}

// ============================================================================
// 17. MATH NAMESPACE — sibling modules as the default Float32 math tier
// ============================================================================
var math = {
    common: {
        CHUNK_SIZE: CHUNK_SIZE, CHUNK_YIELD_EVERY: CHUNK_YIELD_EVERY,
        yieldToMain: yieldToMain, createPool: createPool, createSOA: createSOA,
        hash3: hash3, mulberry32: mulberry32
    },
    vec2: vec2, vec3: vec3, vec4: vec4, mat2: mat2,
    mat3: null, mat4: mat4, quat: quat, quat2: quat2, bitecs: null,
    double: null
};
math.double = {
    Double: Double, createDoubleSOA: createDoubleSOA, createDoubleVec3SOA: createDoubleVec3SOA,
    keplerSolve2: keplerSolve2, keplerSolve2Exact: keplerSolve2Exact
};
/** Optional modules load dynamically; a failure never breaks this module. */
var mathReady = Promise.allSettled([
    import("./006_mat3.js").then(function (m) { math.mat3 = m; }),
    import("./010_bitECS_core.js").then(function (m) { math.bitecs = m; })
]);

// ============================================================================
// 18. EXPORTS — every original member preserved + precision-tier additions
// ============================================================================
export {
    // foundation
    CHUNK_SIZE, CHUNK_YIELD_EVERY, yieldToMain, splitter,
    // error-free transformations + class
    twoSum, twoProd, oneSqr, Double,
    // pool
    createDoublePool, acquire, release,
    // SOA basics
    createDoubleSOA, soaZero, soaGet, soaSet, soaCopy, soaToFlat, soaFromFlat,
    soaFillScalar, soaFromFloat32,
    // SOA binary ops
    soaAdd22, soaSub22, soaMul22, soaDiv22, soaAdd21, soaSub21, soaMul21, soaDiv21,
    soaNeg2, soaAbs2, soaInv2, soaSqr2, soaSqrt2,
    // SOA comparisons
    soaCompare, soaEq, soaNe, soaGt, soaLt, soaGe, soaLe,
    // chunked async
    soaAdd22Chunked, soaMul22Chunked, soaStepChunked, soaForEachChunked,
    // procedural
    hash3_64, valueNoise3D_64,
    // orbital
    keplerSolve2, keplerSolve2Exact, integrateOrbitSOA, integrateOrbitSOAChunked,
    // animation
    springDamp2, soaSpringDamp2,
    // IK
    fabrikStep3_precise,
    // rendering
    mat4TransformVec3_precise, soaMat4TransformDouble,
    // color
    acesToneMap1, acesToneMapSOA,
    // bitECS integration
    attachHighPrecisionPositions, ensureCapacity, setWorldPosition, getWorldPosition,
    worldToFloat32, float32ToWorld, recenterWorld,
    // double vec3 tier
    createDoubleVec3SOA, soaVec3Add22, soaVec3Sub22, soaVec3Scale21, soaVec3Lerp21,
    soaVec3Dot2, soaVec3Length2, soaVec3Normalize2, soaVec3Cross2,
    // three.js r185 interop
    setVector3FromDouble, applyStoreToObject3D, writeInstancedMatrices, transformDoubleByMatrix4,
    // parallelism
    createDoubleWorkerPool,
    // namespace
    math, mathReady
};

export default {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, yieldToMain, splitter,
    twoSum, twoProd, oneSqr, Double,
    createDoublePool, acquire, release,
    createDoubleSOA, soaZero, soaGet, soaSet, soaCopy, soaToFlat, soaFromFlat,
    soaFillScalar, soaFromFloat32,
    soaAdd22, soaSub22, soaMul22, soaDiv22, soaAdd21, soaSub21, soaMul21, soaDiv21,
    soaNeg2, soaAbs2, soaInv2, soaSqr2, soaSqrt2,
    soaCompare, soaEq, soaNe, soaGt, soaLt, soaGe, soaLe,
    soaAdd22Chunked, soaMul22Chunked, soaStepChunked, soaForEachChunked,
    hash3_64, valueNoise3D_64,
    keplerSolve2, keplerSolve2Exact, integrateOrbitSOA, integrateOrbitSOAChunked,
    springDamp2, soaSpringDamp2,
    fabrikStep3_precise,
    mat4TransformVec3_precise, soaMat4TransformDouble,
    acesToneMap1, acesToneMapSOA,
    attachHighPrecisionPositions, ensureCapacity, setWorldPosition, getWorldPosition,
    worldToFloat32, float32ToWorld, recenterWorld,
    createDoubleVec3SOA, soaVec3Add22, soaVec3Sub22, soaVec3Scale21, soaVec3Lerp21,
    soaVec3Dot2, soaVec3Length2, soaVec3Normalize2, soaVec3Cross2,
    setVector3FromDouble, applyStoreToObject3D, writeInstancedMatrices, transformDoubleByMatrix4,
    createDoubleWorkerPool,
    math, mathReady
};

