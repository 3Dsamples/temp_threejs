//File number : 055
// File : src/math/055_special-functions.js
//Description : Complete special-functions library — Gamma family (Γ, lnΓ, digamma, polygamma, factorial, binomial, Pochhammer, Beta, lnBeta), incomplete gamma (P, Q), error functions (erf, erfc, erfinv, erfcinv, scaled erfcx), incomplete beta (regularized I_x), Bessel functions (J0, J1, Jn, Y0, Y1, Yn, I0, I1, K0, K1), Airy functions (Ai, Bi), orthogonal polynomials (Legendre P_n, associated P_l^m, Hermite, Laguerre, Chebyshev T_n/U_n), Riemann zeta, Lambert W (W₀, W₋₁), Fresnel integrals (S, C), Dawson function, elliptic integrals (complete K/E, incomplete F/E), Gaussian soft-falloff helpers, real spherical harmonics (SH) basis order 0–9, and softmax/logsumexp stabilizing primitives. 
// Zero-GC Compliance: Strictly adheres to the Enhanced Zero-GC ECS Engine mandate. All hot-loop SOA operations utilize pre-allocated scratch pools (SpecialScratch) to eliminate dynamic Float64Array allocations. Chunked async variants inline their execution loops to completely eradicate closure allocations during frame execution.
//License : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules)
// ============================================================================
import { common, vec3, getArrayType, onPrecisionChange } from './000_Math_module.js';
import * as Approximation from './054_approximation.js';
import * as Stability from './036_numerical-stability.js';

// ============================================================================
// Global Declarations
// ============================================================================
const PI           = Math.PI;
const TAU          = PI * 2;
const SQRT_PI      = Math.sqrt(PI);
const SQRT_2PI     = Math.sqrt(TAU);
const SQRT_2_OVER_PI = Math.sqrt(2 / PI);
const EULER_GAMMA  = 0.5772156649015329;
const LN_2PI       = Math.log(TAU);
const LN_SQRT_2PI  = 0.5 * LN_2PI;
const EPSILON      = 1e-15;
const MAX_ITER     = 200;

// Lanczos coefficients (g=7, n=9) — used by gamma and lgamma
const LANCZOS_G = 7;
const LANCZOS_C = new Float64Array([
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7
]);

// Abramowitz & Stegun 7.1.28 — fast erf via rational approximation (5×5)
const ERF_A = new Float64Array([
    0.0705230784, 0.0422820123, 0.0092705272, 0.0001520143, 0.0002765672, 0.0000430638
]);

// erfinv initial guess polynomial (Giles) — first-order
const ERFINV_A = 0.147;
const ERFINV_B = 2 / (PI * ERFINV_A) + Math.log(1 - ERFINV_A * ERFINV_A) / 2;
const ERFINV_C = Math.log(1 - ERFINV_A * ERFINV_A) / ERFINV_A;

// Softmax working buffer for logsumexp — kept as small fixed array
const _softmaxBuf = new Float64Array(64);

// Pools
const _specialScratchPool = common.createPool(
    function () {
        return {
            a: null, b: null, c: null, d: null, size: 0,
            _ensureAttached: false
        };
    },
    8,
    function (s) { s.a = null; s.b = null; s.c = null; s.d = null; s.size = 0; }
);

// Attach `ensure` to acquired scratch
(function warmSpecialScratch() {
    const pool = _specialScratchPool;
    const orig = pool.acquire.bind(pool);
    pool.acquire = function () {
        const s = orig();
        if (!s._ensureAttached) {
            s._ensureAttached = true;
            s.ensure = function (n) {
                if (n <= this.size) return this;
                this.size = n;
                const T = getArrayType();
                this.a = new T(n);
                this.b = new T(n);
                this.c = new T(n);
                this.d = new T(n);
                return this;
            };
        }
        return s;
    };
})();

// ============================================================================
// Function Declarations — Gamma family
// ============================================================================
function gamma(x) {
    if (x === 1 || x === 2) return 1;
    if (Number.isInteger(x) && x <= 0) return Infinity; // pole
    if (x < 0.5) {
        return PI / (Math.sin(PI * x) * gamma(1 - x));
    }
    x -= 1;
    let sum = LANCZOS_C[0];
    for (let i = 1; i < 9; i++) sum += LANCZOS_C[i] / (x + i);
    const t = x + LANCZOS_G + 0.5;
    return SQRT_2PI * Math.pow(t, x + 0.5) * Math.exp(-t) * sum;
}

function lgamma(x) {
    if (x <= 0 && Number.isInteger(x)) return Infinity;
    if (x < 0.5) {
        const sinPix = Math.sin(PI * x);
        return Math.log(PI / Math.abs(sinPix)) - lgamma(1 - x);
    }
    x -= 1;
    let sum = LANCZOS_C[0];
    for (let i = 1; i < 9; i++) sum += LANCZOS_C[i] / (x + i);
    const t = x + LANCZOS_G + 0.5;
    return LN_SQRT_2PI + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}

function digamma(x) {
    let result = 0;
    if (x < 0) {
        return digamma(1 - x) - PI / Math.tan(PI * x);
    }
    while (x < 8) {
        result -= 1 / x;
        x += 1;
    }
    const invX = 1 / x;
    const inv2 = invX * invX;
    result += Math.log(x) - 0.5 * invX
        - inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 * (1 / 252 - inv2 / 240)));
    return result;
}

function polygamma(n, x) {
    if (n === 0) return digamma(x);
    let result = 0;
    while (x < 8) {
        result += Math.pow(-1, n + 1) * factNonNeg(n) / Math.pow(x, n + 1);
        x += 1;
    }
    const invX = 1 / x;
    result += Math.pow(-1, n + 1) *
        (factNonNeg(n - 1) / Math.pow(x, n) + n * factNonNeg(n - 1) / (2 * Math.pow(x, n + 1)) +
        BernoulliTerm(n, invX));
    return result;
}

function BernoulliTerm(n, invX) {
    return (1 / 6) * n * (n + 1) / (2 * Math.pow(invX, -(n + 2)) ? Math.pow(1 / invX, n + 2) : 1);
}

function factNonNeg(n) {
    let f = 1;
    for (let i = 2; i <= n; i++) f *= i;
    return f;
}

function factorial(n) {
    if (n < 0 || !Number.isInteger(n)) return gamma(n + 1);
    if (n < 20) {
        let f = 1;
        for (let i = 2; i <= n; i++) f *= i;
        return f;
    }
    return gamma(n + 1);
}

function binom(n, k) {
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;
    if (n < 30) {
        let res = 1;
        for (let i = 1; i <= Math.min(k, n - k); i++) {
            res *= (n - Math.min(k, n - k) + i) / i;
        }
        return res;
    }
    return Math.round(Math.exp(lnBinom(n, k)));
}

function lnBinom(n, k) {
    if (k < 0 || k > n) return -Infinity;
    return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

function pochhammer(x, n) {
    if (n === 0) return 1;
    let result = 1;
    for (let i = 0; i < n; i++) result *= x + i;
    return result;
}

function beta(a, b) {
    return Math.exp(lnBeta(a, b));
}

function lnBeta(a, b) {
    return lgamma(a) + lgamma(b) - lgamma(a + b);
}

function invGamma(y) {
    if (y <= 0) return NaN;
    let x = y < 1 ? 1 : Math.log(y) + Math.log(Math.log(y) + 1);
    for (let i = 0; i < 20; i++) {
        const lny = lgamma(x);
        const diff = Math.exp(lny) - y;
        const dg = digamma(x);
        const step = diff / (Math.exp(lny) * dg);
        x -= step;
        if (Math.abs(step) < 1e-10 * Math.abs(x)) break;
    }
    return x;
}

// ============================================================================
// Function Declarations — Incomplete gamma
// ============================================================================
function incompleteGammaP(a, x) {
    if (x < 0 || a <= 0) return NaN;
    if (x === 0) return 0;
    if (x < a + 1) return _incompleteGammaSeries(a, x);
    return 1 - _incompleteGammaCF(a, x);
}

function incompleteGammaQ(a, x) {
    return 1 - incompleteGammaP(a, x);
}

function _incompleteGammaSeries(a, x) {
    let sum = 1 / a;
    let term = sum;
    let n = a;
    for (let i = 0; i < MAX_ITER; i++) {
        n += 1;
        term *= x / n;
        sum += term;
        if (Math.abs(term) < Math.abs(sum) * EPSILON) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
}

function _incompleteGammaCF(a, x) {
    const tiny = 1e-300;
    let b = x + 1 - a;
    let c = 1 / tiny;
    let d = 1 / b;
    let h = d;
    for (let i = 1; i < MAX_ITER; i++) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b;
        if (Math.abs(d) < tiny) d = tiny;
        c = b + an / c;
        if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        const delta = d * c;
        h *= delta;
        if (Math.abs(delta - 1) < EPSILON) break;
    }
    return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

// ============================================================================
// Function Declarations — Error functions
// ============================================================================
function erf(x) {
    if (x === 0) return 0;
    const ax = Math.abs(x);
    if (ax < 3) {
        const t = 1 / (1 + 0.3275911 * ax);
        const poly = t * (0.254829592 +
            t * (-0.284496736 +
            t * (1.421413741 +
            t * (-1.453152027 +
            t * 1.061405429))));
        const e = 1 - poly * Math.exp(-ax * ax);
        return x < 0 ? -e : e;
    }
    return x < 0 ? -1 : 1;
}

function erfc(x) {
    if (x >= 0) return 1 - erf(x);
    return 2 - erfc(-x);
}

function erfcx(x) {
    if (x >= 0 && x < 25) {
        return Math.exp(x * x) * erfc(x);
    }
    if (x >= 25) {
        const x2 = x * x;
        const inv = 1 / (x * SQRT_PI);
        const term = 1 - 1 / (2 * x2) + 3 / (4 * x2 * x2);
        return inv * term;
    }
    return Infinity; 
}

function erfinv(y) {
    if (y <= -1) return -Infinity;
    if (y >= 1) return Infinity;
    if (y === 0) return 0;
    const ay = Math.abs(y);
    let x;
    if (ay < 0.85) {
        x = y * (1 + y * y * (0.886226925 + y * y * (0.232013666 + y * y * 0.124837048)));
    } else {
        const ln1my2 = Math.log(1 - ay * ay);
        x = Math.sign(y) * Math.sqrt(Math.sqrt(ln1my2 * ln1my2 * 0.5 - (5 / 12) * ln1my2 + 1) -
            (1 / 2) * ln1my2 - 1);
    }
    const twoOverSqrtPi = 2 / SQRT_PI;
    for (let i = 0; i < 8; i++) {
        const err = erf(x) - y;
        const der = twoOverSqrtPi * Math.exp(-x * x);
        const step = err / der;
        x -= step;
        if (Math.abs(step) < 1e-12 * Math.abs(x)) break;
    }
    return x;
}

function erfcinv(y) {
    return -erfinv(y - 1);
}

// ============================================================================
// Function Declarations — Incomplete beta
// ============================================================================
function incompleteBeta(x, a, b) {
    if (x < 0 || x > 1) return NaN;
    if (x === 0) return 0;
    if (x === 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) {
        return bt * _betaCF(x, a, b) / a;
    }
    return 1 - bt * _betaCF(1 - x, b, a) / b;
}

function _betaCF(x, a, b) {
    const tiny = 1e-300;
    let qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAX_ITER; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
        c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
        c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < EPSILON) break;
    }
    return h;
}

function invIncompleteBeta(y, a, b) {
    if (y <= 0) return 0;
    if (y >= 1) return 1;
    let lo = 0, hi = 1, x = 0.5;
    for (let i = 0; i < 50; i++) {
        const val = incompleteBeta(x, a, b);
        if (val < y) lo = x; else hi = x;
        const pdf = Math.exp(
            lgamma(a + b) - lgamma(a) - lgamma(b) +
            (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x)
        );
        const step = pdf > 1e-15 ? (val - y) / pdf : 0;
        x -= step;
        if (x <= lo || x >= hi) x = 0.5 * (lo + hi);
        if (Math.abs(val - y) < 1e-10) break;
    }
    return x;
}

// ============================================================================
// Function Declarations — Bessel functions
// ============================================================================
function besselJ0(x) {
    const ax = Math.abs(x);
    if (ax < 8) {
        const y = x * x;
        const ans1 = 57568490574.0 + y * (-13362590354.0 + y * (651619640.7 +
            y * (-11214424.18 + y * (77392.33017 + y * (-184.9052456)))));
        const ans2 = 57568490411.0 + y * (1029532985.0 + y * (9494680.718 +
            y * (59272.64853 + y * (267.8532712 + y * 1.0))));
        return ans1 / ans2;
    }
    const z = 8 / ax;
    const y = z * z;
    const xx = ax - 0.785398164;
    const ans1 = 1 + y * (-0.1098628627e-2 + y * (0.2734510407e-4 +
        y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
    const ans2 = -0.1562499995e-1 + y * (0.1430488765e-3 +
        y * (-0.6911147651e-5 + y * (0.7621095161e-6 - y * 0.934935152e-7)));
    return Math.sqrt(0.636619772 / ax) *
        (Math.cos(xx) * ans1 - z * Math.sin(xx) * ans2);
}

function besselJ1(x) {
    const ax = Math.abs(x);
    let result;
    if (ax < 8) {
        const y = x * x;
        const ans1 = x * (72362614232.0 + y * (-7895059235.0 + y * (242396853.1 +
            y * (-2972611.439 + y * (15704.48260 + y * (-30.16036606))))));
        const ans2 = 144725228442.0 + y * (2300535178.0 + y * (18583304.74 +
            y * (99447.43394 + y * (376.9991397 + y * 1.0))));
        result = ans1 / ans2;
    } else {
        const z = 8 / ax;
        const y = z * z;
        const xx = ax - 2.356194491;
        const ans1 = 1 + y * (0.183105e-2 + y * (-0.3516396496e-4 +
            y * (0.2457520174e-5 + y * (-0.240337019e-6))));
        const ans2 = 0.04687499995 + y * (-0.2002690873e-3 +
            y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
        result = Math.sqrt(0.636619772 / ax) *
            (Math.cos(xx) * ans1 - z * Math.sin(xx) * ans2);
        if (x < 0) result = -result;
    }
    return result;
}

function besselJn(n, x) {
    if (n === 0) return besselJ0(x);
    if (n === 1) return besselJ1(x);
    if (n < 0) {
        n = -n;
        if (n % 2 === 1) return -besselJn(n, x);
        return besselJn(n, x);
    }
    let j0 = besselJ0(x), j1 = besselJ1(x);
    let jn = j1;
    for (let k = 1; k < n; k++) {
        jn = (2 * k / x) * j1 - j0;
        j0 = j1;
        j1 = jn;
    }
    return jn;
}

function besselY0(x) {
    if (x <= 0) return NaN;
    if (x < 8) {
        const y = x * x;
        const ans1 = -2957821389.0 + y * (7062834065.0 + y * (-512359803.6 +
            y * (10879881.29 + y * (-86327.92757 + y * 228.4622733))));
        const ans2 = 40076544269.0 + y * (745249964.8 + y * (7189466.438 +
            y * (47447.26470 + y * (226.1030244 + y * 1.0))));
        return ans1 / ans2 + 0.636619772 * besselJ0(x) * Math.log(x);
    }
    const z = 8 / x;
    const y = z * z;
    const xx = x - 0.785398164;
    const ans1 = 1 + y * (-0.1098628627e-2 + y * (0.2734510407e-4 +
        y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
    const ans2 = -0.1562499995e-1 + y * (0.1430488765e-3 +
        y * (-0.6911147651e-5 + y * (0.7621095161e-6 + y * (-0.934935152e-7))));
    return Math.sqrt(0.636619772 / x) *
        (Math.sin(xx) * ans1 + z * Math.cos(xx) * ans2);
}

function besselY1(x) {
    if (x <= 0) return NaN;
    if (x < 8) {
        const y = x * x;
        const ans1 = x * (-4.900604943e13 + y * (1.275274390e13 + y * (-5.153438139e11 +
            y * (7.349264551e9 + y * (-4.237922726e7 + y * 8.511937935e4)))));
        const ans2 = 2.499580570e14 + y * (4.244419664e12 + y * (3.733650367e10 +
            y * (2.245904002e8 + y * (1.020426050e6 + y * (3.549632885e3 + y)))));
        return ans1 / ans2 + 0.636619772 * (besselJ1(x) * Math.log(x) - 1 / x);
    }
    const z = 8 / x;
    const y = z * z;
    const xx = x - 2.356194491;
    const ans1 = 1 + y * (0.183105e-2 + y * (-0.3516396496e-4 +
        y * (0.2457520174e-5 + y * (-0.240337019e-6))));
    const ans2 = 0.04687499995 + y * (-0.2002690873e-3 +
        y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * (0.105787412e-6))));
    return Math.sqrt(0.636619772 / x) *
        (Math.sin(xx) * ans1 + z * Math.cos(xx) * ans2);
}

function besselYn(n, x) {
    if (n === 0) return besselY0(x);
    if (n === 1) return besselY1(x);
    let y0 = besselY0(x), y1 = besselY1(x);
    let yn = y1;
    for (let k = 1; k < n; k++) {
        yn = (2 * k / x) * y1 - y0;
        y0 = y1;
        y1 = yn;
    }
    return yn;
}

function besselI0(x) {
    const ax = Math.abs(x);
    if (ax < 3.75) {
        const y = (x / 3.75) * (x / 3.75);
        return 1.0 + y * (3.5156229 + y * (3.0899424 + y * (1.2067492 +
            y * (0.2659732 + y * (0.360768e-1 + y * 0.45813e-2)))));
    }
    const y = 3.75 / ax;
    return (Math.exp(ax) / Math.sqrt(ax)) *
        (0.39894228 + y * (0.1328592e-1 + y * (0.225319e-2 +
        y * (-0.157565e-2 + y * (0.916281e-2 + y * (-0.2057706e-1 +
        y * (0.2635537e-1 + y * (-0.1647633e-1 + y * 0.392377e-2))))))));
}

function besselI1(x) {
    const ax = Math.abs(x);
    let result;
    if (ax < 3.75) {
        const y = (x / 3.75) * (x / 3.75);
        result = ax * (0.5 + y * (0.87890594 + y * (0.51498869 +
            y * (0.15084934 + y * (0.2658733e-1 + y * (0.301532e-2 + y * 0.32411e-3))))));
    } else {
        const y = 3.75 / ax;
        result = 0.2282967e-1 + y * (-0.2895312e-1 + y * (0.1787654e-1 - y * 0.420059e-2));
        result = 0.39894228 + y * (-0.3988024e-1 + y * (-0.362018e-2 +
            y * (0.163801e-2 + y * (-0.1031555e-1 + y * result))));
        result *= (Math.exp(ax) / Math.sqrt(ax));
    }
    return x < 0 ? -result : result;
}

function besselK0(x) {
    if (x <= 0) return NaN;
    if (x <= 2) {
        const y = x * x / 4;
        return (-Math.log(x / 2) * besselI0(x)) +
            (-0.57721566 + y * (0.42278420 + y * (0.23069756 +
            y * (0.3488590e-1 + y * (0.262698e-2 + y * (0.10750e-3 + y * 0.74e-5))))));
    }
    const y = 2 / x;
    return (Math.exp(-x) / Math.sqrt(x)) *
        (1.25331414 + y * (-0.7832358e-1 + y * (0.2189568e-1 +
        y * (-0.1062446e-1 + y * (0.587872e-2 + y * (-0.251540e-2 + y * 0.53208e-3))))));
}

function besselK1(x) {
    if (x <= 0) return NaN;
    if (x <= 2) {
        const y = x * x / 4;
        return (Math.log(x / 2) * besselI1(x)) +
            (1 / x) * (1 + y * (0.15443144 + y * (-0.67278579 +
            y * (-0.18156897 + y * (-0.1919402e-1 + y * (-0.110404e-2 + y * (-0.4686e-4)))))));
    }
    const y = 2 / x;
    return (Math.exp(-x) / Math.sqrt(x)) *
        (1.25331414 + y * (0.23498619 + y * (-0.3655620e-1 +
        y * (0.1504268e-1 + y * (-0.780353e-2 + y * (0.325614e-2 + y * (-0.68245e-3)))))));
}

// ============================================================================
// Function Declarations — Airy
// ============================================================================
function airyAi(x) {
    if (Math.abs(x) < 2.5) {
        let sum1 = 1, term1 = 1;
        let sum2 = x, term2 = x;
        for (let n = 1; n < 50; n++) {
            term1 *= x * x * x / ((3 * n - 2) * (3 * n));
            term2 *= x * x * x / ((3 * n - 1) * (3 * n));
            sum1 += term1;
            sum2 += term2;
            if (Math.abs(term1) + Math.abs(term2) < EPSILON) break;
        }
        return 0.355028053887817 * sum1 - 0.258819403792807 * sum2;
    }
    const zeta = (2 / 3) * Math.pow(Math.abs(x), 1.5);
    if (x > 0) {
        const inv = 1 / (2 * Math.sqrt(Math.PI) * Math.pow(x, 0.25));
        return inv * Math.exp(-zeta) * (1 - 5 / (72 * zeta));
    }
    const inv = 1 / (Math.sqrt(Math.PI) * Math.pow(-x, 0.25));
    return inv * Math.sin(zeta + Math.PI / 4) * (1 + 5 / (72 * zeta));
}

function airyBi(x) {
    if (Math.abs(x) < 2.5) {
        let sum1 = 1, term1 = 1;
        let sum2 = x, term2 = x;
        for (let n = 1; n < 50; n++) {
            term1 *= x * x * x / ((3 * n - 2) * (3 * n));
            term2 *= x * x * x / ((3 * n - 1) * (3 * n));
            sum1 += term1;
            sum2 += term2;
            if (Math.abs(term1) + Math.abs(term2) < EPSILON) break;
        }
        return 0.614926627446000 * sum1 + 0.448288357353826 * sum2;
    }
    const zeta = (2 / 3) * Math.pow(Math.abs(x), 1.5);
    if (x > 0) {
        const inv = 1 / (Math.sqrt(Math.PI) * Math.pow(x, 0.25));
        return inv * Math.exp(zeta) * (1 + 5 / (72 * zeta));
    }
    const inv = 1 / (Math.sqrt(Math.PI) * Math.pow(-x, 0.25));
    return inv * Math.cos(zeta + Math.PI / 4) * (1 - 5 / (72 * zeta));
}

// ============================================================================
// Function Declarations — Orthogonal polynomials
// ============================================================================
function legendreP(n, x) {
    if (n === 0) return 1;
    if (n === 1) return x;
    let p0 = 1, p1 = x;
    for (let k = 2; k <= n; k++) {
        const pk = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = pk;
    }
    return p1;
}

function legendreAssoc(l, m, x) {
    if (m < 0 || m > l) return 0;
    const somx2 = Math.sqrt((1 - x) * (1 + x));
    let pmm = 1;
    let fact = 1;
    for (let i = 1; i <= m; i++) {
        pmm *= -fact * somx2;
        fact += 2;
    }
    if (l === m) return pmm;
    let pmmp1 = x * (2 * m + 1) * pmm;
    if (l === m + 1) return pmmp1;
    let pll = 0;
    for (let ll = m + 2; ll <= l; ll++) {
        pll = ((2 * ll - 1) * x * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
        pmm = pmmp1;
        pmmp1 = pll;
    }
    return pll;
}

function hermiteH(n, x) {
    if (n === 0) return 1;
    if (n === 1) return 2 * x;
    let h0 = 1, h1 = 2 * x;
    for (let k = 2; k <= n; k++) {
        const hk = 2 * x * h1 - 2 * (k - 1) * h0;
        h0 = h1;
        h1 = hk;
    }
    return h1;
}

function laguerreL(n, x) {
    if (n === 0) return 1;
    if (n === 1) return 1 - x;
    let l0 = 1, l1 = 1 - x;
    for (let k = 2; k <= n; k++) {
        const lk = ((2 * k - 1 - x) * l1 - (k - 1) * l0) / k;
        l0 = l1;
        l1 = lk;
    }
    return l1;
}

function chebyshevT(n, x) {
    if (n === 0) return 1;
    if (n === 1) return x;
    let t0 = 1, t1 = x;
    for (let k = 2; k <= n; k++) {
        const tk = 2 * x * t1 - t0;
        t0 = t1;
        t1 = tk;
    }
    return t1;
}

function chebyshevU(n, x) {
    if (n === 0) return 1;
    if (n === 1) return 2 * x;
    let u0 = 1, u1 = 2 * x;
    for (let k = 2; k <= n; k++) {
        const uk = 2 * x * u1 - u0;
        u0 = u1;
        u1 = uk;
    }
    return u1;
}

// ============================================================================
// Function Declarations — Zeta
// ============================================================================
function riemannZeta(s) {
    if (s === 1) return Infinity;
    if (s === 0) return -0.5;
    if (s < 0) {
        return Math.pow(2, s) * Math.pow(PI, s - 1) * Math.sin(PI * s / 2) * gamma(1 - s) * riemannZeta(1 - s);
    }
    const N = 15;
    let sum = 0;
    for (let k = 1; k < N; k++) sum += Math.pow(k, -s);
    sum += Math.pow(N, 1 - s) / (s - 1);
    sum += 0.5 * Math.pow(N, -s);
    sum += s * Math.pow(N, -s - 1) / 12;
    sum -= s * (s + 1) * (s + 2) * Math.pow(N, -s - 3) / 720;
    sum += s * (s + 1) * (s + 2) * (s + 3) * (s + 4) * Math.pow(N, -s - 5) / 30240;
    return sum;
}

function hurwitzZeta(s, a) {
    if (a < 0.001) a = 0.001; 
    const N = 20;
    let sum = 0;
    for (let k = 0; k < N; k++) sum += Math.pow(a + k, -s);
    sum += Math.pow(a + N, 1 - s) / (s - 1);
    sum += 0.5 * Math.pow(a + N, -s);
    sum += s * Math.pow(a + N, -s - 1) / 12;
    return sum;
}

// ============================================================================
// Function Declarations — Lambert W
// ============================================================================
function lambertW0(x) {
    if (x < -1 / Math.E) return NaN;
    if (x === 0) return 0;
    if (x === -1 / Math.E) return -1;
    if (x > 3) {
        const lnx = Math.log(x);
        const lnlnx = Math.log(lnx);
        let w = lnx - lnlnx;
        for (let i = 0; i < 15; i++) {
            const ew = Math.exp(w);
            const f = w * ew - x;
            const wn = w - f / (ew * (w + 1) - (w + 2) * f / (2 * w + 2));
            if (Math.abs(wn - w) < 1e-12) break;
            w = wn;
        }
        return w;
    }
    let w = x < 1 ? x - x * x + 1.5 * x * x * x : Math.log(x + 1);
    for (let i = 0; i < 20; i++) {
        const ew = Math.exp(w);
        const f = w * ew - x;
        const fp = ew * (1 + w);
        const wn = w - f / fp;
        if (Math.abs(wn - w) < 1e-12) break;
        w = wn;
    }
    return w;
}

function lambertWm1(x) {
    if (x >= 0 || x < -1 / Math.E) return NaN;
    if (x === -1 / Math.E) return -1;
    let w;
    if (x < -0.3) {
        w = -1;
        for (let i = 0; i < 20; i++) {
            const ew = Math.exp(w);
            const f = w * ew - x;
            const fp = ew * (1 + w);
            const wn = w - f / fp;
            if (Math.abs(wn - w) < 1e-12) break;
            w = wn;
        }
    } else {
        const p = Math.sqrt(2 * (Math.E * x + 1));
        w = -1 + p - (1 / 3) * p * p;
        for (let i = 0; i < 20; i++) {
            const ew = Math.exp(w);
            const f = w * ew - x;
            const fp = ew * (1 + w);
            const wn = w - f / fp;
            if (Math.abs(wn - w) < 1e-12) break;
            w = wn;
        }
    }
    return w;
}

// ============================================================================
// Function Declarations — Fresnel integrals
// ============================================================================
function fresnelS(x) {
    if (Math.abs(x) < 3) {
        let sum = 0, term;
        let sign = 1;
        for (let k = 0; k < 30; k++) {
            const k2 = 2 * k + 1;
            const k4 = 4 * k + 3;
            const piFactor = Math.pow(PI / 2, k2);
            const xFactor = Math.pow(x, k4);
            const fact = factNonNeg(k2);
            sum += sign * piFactor * xFactor / (fact * k4);
            sign = -sign;
        }
        return sum;
    }
    const s = Math.sign(x);
    const ax = Math.abs(x);
    const p = PI * ax * ax / 2;
    return s * (0.5 - Math.cos(p) / (PI * ax) - Math.sin(p) / (PI * PI * ax * ax));
}

function fresnelC(x) {
    if (Math.abs(x) < 3) {
        let sum = 0;
        let sign = 1;
        for (let k = 0; k < 30; k++) {
            const k2 = 2 * k;
            const k4 = 4 * k + 1;
            const piFactor = Math.pow(PI / 2, k2);
            const xFactor = Math.pow(x, k4);
            const fact = factNonNeg(k2);
            sum += sign * piFactor * xFactor / (fact * k4);
            sign = -sign;
        }
        return sum;
    }
    const s = Math.sign(x);
    const ax = Math.abs(x);
    const p = PI * ax * ax / 2;
    return s * (0.5 + Math.sin(p) / (PI * ax) - Math.cos(p) / (PI * PI * ax * ax));
}

// ============================================================================
// Function Declarations — Dawson
// ============================================================================
function dawson(x) {
    const ax = Math.abs(x);
    if (ax < 2.5) {
        let sum = x, term = x, x2 = x * x;
        for (let n = 1; n < 30; n++) {
            term *= -2 * x2 / (2 * n + 1);
            sum += term;
            if (Math.abs(term) < Math.abs(sum) * EPSILON) break;
        }
        return sum;
    }
    const x2 = ax * ax;
    let d = 0.5 / ax;
    d += 0.25 / (ax * x2);
    d += 0.375 / (ax * x2 * x2);
    return x > 0 ? d : -d;
}

// ============================================================================
// Function Declarations — Elliptic integrals
// ============================================================================
function ellipticK(m) {
    if (m >= 1) return Infinity;
    let a = 1, b = Math.sqrt(1 - m);
    for (let i = 0; i < 30; i++) {
        const an = 0.5 * (a + b);
        const bn = Math.sqrt(a * b);
        if (Math.abs(an - bn) < 1e-15) break;
        a = an;
        b = bn;
    }
    return PI / (2 * a);
}

function ellipticE(m) {
    if (m >= 1) return 1;
    let a = 1, b = Math.sqrt(1 - m);
    let sum = 0.5 * m;
    let c = 0;
    for (let i = 0; i < 30; i++) {
        const an = 0.5 * (a + b);
        const bn = Math.sqrt(a * b);
        const cn = 0.5 * (a - b);
        sum += 0.5 * Math.pow(2, i) * cn * cn;
        if (Math.abs(an - bn) < 1e-15) break;
        a = an;
        b = bn;
    }
    return PI / (2 * a) * (1 - sum);
}

function ellipticF(phi, m) {
    if (m >= 1) return Infinity;
    const n = 15;
    let s = 0;
    let sinPhi = Math.sin(phi);
    for (let k = 0; k < n; k++) {
        const binom = binom(2 * k, k);
        s += (binom / Math.pow(2, 2 * k)) * Math.pow(sinPhi, 2 * k + 1) * Math.pow(m, k);
        sinPhi *= Math.sin(phi) * Math.sin(phi);
    }
    return s;
}

function ellipticEInc(phi, m) {
    if (m >= 1) return phi;
    let s = 0;
    const n = 15;
    let sinPhi = Math.sin(phi);
    for (let k = 0; k < n; k++) {
        const binom = binom(2 * k, k);
        s += (binom / Math.pow(2, 2 * k)) * Math.pow(sinPhi, 2 * k + 1) * Math.pow(m, k) / (1 - 2 * k);
    }
    return s;
}

// ============================================================================
// Function Declarations — Spherical harmonics
// ============================================================================
function realSH(order, theta, phi, out) {
    out = out || new Float64Array((order + 1) * (order + 1));
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    for (let l = 0; l <= order; l++) {
        for (let m = -l; m <= l; m++) {
            const absM = Math.abs(m);
            const N = shNormalization(l, absM);
            const P = legendreAssoc(l, absM, cosTheta);
            const cosMPhi = Math.cos(absM * phi);
            const sinMPhi = Math.sin(absM * phi);
            let value;
            if (m === 0) value = N * P;
            else if (m > 0) value = Math.SQRT2 * N * P * cosMPhi;
            else value = Math.SQRT2 * N * P * sinMPhi;
            out[l * l + l + m] = value;
        }
    }
    return out;
}

function shNormalization(l, m) {
    return Math.sqrt((2 * l + 1) / (4 * PI) * (factNonNeg(l - m) / factNonNeg(l + m)));
}

function sphericalHarmonic(l, m, theta, phi) {
    const absM = Math.abs(m);
    const N = shNormalization(l, absM);
    const P = legendreAssoc(l, absM, Math.cos(theta));
    if (m > 0) return Math.SQRT2 * N * P * Math.cos(absM * phi);
    if (m < 0) return Math.SQRT2 * N * P * Math.sin(absM * phi);
    return N * P;
}

// ============================================================================
// Function Declarations — Softmax / logsumexp
// ============================================================================
function log1pExp(x) {
    if (x > 0) return x + Math.log1p(Math.exp(-x));
    return Math.log1p(Math.exp(x));
}

function logsumexp(arr, n) {
    n = n === undefined ? arr.length : n;
    if (n === 0) return -Infinity;
    let max = arr[0];
    for (let i = 1; i < n; i++) if (arr[i] > max) max = arr[i];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.exp(arr[i] - max);
    return max + Math.log(sum);
}

function softmax(out, arr, n) {
    n = n === undefined ? arr.length : n;
    if (n === 0) return out;
    let max = arr[0];
    for (let i = 1; i < n; i++) if (arr[i] > max) max = arr[i];
    let sum = 0;
    for (let i = 0; i < n; i++) {
        out[i] = Math.exp(arr[i] - max);
        sum += out[i];
    }
    if (sum > 0) for (let i = 0; i < n; i++) out[i] /= sum;
    return out;
}

// ============================================================================
// Function Declarations — Gaussian helpers
// ============================================================================
function gaussianFalloff(d, sigma) {
    return Math.exp(-(d * d) / (2 * sigma * sigma));
}

function gaussianBump(x, c, sigma) {
    const d = x - c;
    return Math.exp(-(d * d) / (2 * sigma * sigma));
}

function normalCDF(x) {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normalQuantile(p) {
    return Math.SQRT2 * erfinv(2 * p - 1);
}

// ============================================================================
// Function Declarations — SOA (sync)
// ============================================================================
function soaErf(out, xs, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = erf(xs[i]);
    return out;
}

function soaErfc(out, xs, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = erfc(xs[i]);
    return out;
}

function soaGamma(out, xs, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = gamma(xs[i]);
    return out;
}

function soaLgamma(out, xs, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = lgamma(xs[i]);
    return out;
}

function soaBinom(out, ns, ks, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = binom(ns[i], ks[i]);
    return out;
}

function soaLegendreP(out, n, xs, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = legendreP(n, xs[i]);
    return out;
}

// Zero-GC compliant: Uses pooled scratch buffer to avoid dynamic array allocations
function soaRealSH(out, order, thetas, phis, count) {
    count = count === undefined ? thetas.length : count;
    const nCoeff = (order + 1) * (order + 1);
    const scratch = acquireSpecialScratch(nCoeff);
    const tmp = scratch.a;
    for (let i = 0; i < count; i++) {
        realSH(order, thetas[i], phis[i], tmp);
        const offset = i * nCoeff;
        for (let c = 0; c < nCoeff; c++) out[offset + c] = tmp[c];
    }
    releaseSpecialScratch(scratch);
    return out;
}

function soaRealSHBasis(outBasis, l, m, directions, count) {
    count = count === undefined ? directions.count : count;
    const x = directions.x, y = directions.y, z = directions.z;
    for (let i = 0; i < count; i++) {
        const theta = Math.acos(Math.max(-1, Math.min(1, y[i])));
        const phi = Math.atan2(z[i], x[i]);
        outBasis[i] = sphericalHarmonic(l, m, theta, phi);
    }
    return outBasis;
}

function soaGaussianFalloff(out, distances, sigma, count) {
    count = count === undefined ? out.length : count;
    const twoSigma2 = 2 * sigma * sigma;
    for (let i = 0; i < count; i++) {
        const d = distances[i];
        out[i] = Math.exp(-(d * d) / twoSigma2);
    }
    return out;
}

function soaNormalPDF(out, xs, mu, sigma, count) {
    count = count === undefined ? out.length : count;
    const c = 1 / (sigma * SQRT_2PI);
    const inv2 = 1 / (2 * sigma * sigma);
    for (let i = 0; i < count; i++) {
        const d = xs[i] - mu;
        out[i] = c * Math.exp(-(d * d) * inv2);
    }
    return out;
}

function soaSoftmax(out, xs, count) {
    count = count === undefined ? out.length : count;
    let max = xs[0];
    for (let i = 1; i < count; i++) if (xs[i] > max) max = xs[i];
    let sum = 0;
    for (let i = 0; i < count; i++) {
        out[i] = Math.exp(xs[i] - max);
        sum += out[i];
    }
    if (sum > 0) for (let i = 0; i < count; i++) out[i] /= sum;
    return out;
}

function soaLogsumexp(xs, count) {
    count = count === undefined ? xs.length : count;
    if (count === 0) return -Infinity;
    let max = xs[0];
    for (let i = 1; i < count; i++) if (xs[i] > max) max = xs[i];
    let sum = 0;
    for (let i = 0; i < count; i++) sum += Math.exp(xs[i] - max);
    return max + Math.log(sum);
}

function soaBesselJ0(out, xs, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = besselJ0(xs[i]);
    return out;
}

function soaEllipticK(out, ms, count) {
    count = count === undefined ? out.length : count;
    for (let i = 0; i < count; i++) out[i] = ellipticK(ms[i]);
    return out;
}

/**
 * Normalizes an array of Gamma-distributed draws into a Dirichlet distribution.
 * Essential for procedural scatter weights and asteroid field generation.
 */
function soaDirichletNormalize(out, k, count) {
    count = count === undefined ? out.length / k : count;
    for (let i = 0; i < count; i++) {
        let sum = 0;
        const offset = i * k;
        for (let j = 0; j < k; j++) sum += out[offset + j];
        const invSum = 1 / sum;
        for (let j = 0; j < k; j++) out[offset + j] *= invSum;
    }
    return out;
}

// ============================================================================
// Function Declarations — SOA (chunked async)
// Note: Inlined execution loops to completely eliminate closure allocations
// and strictly adhere to the Zero-GC mandate during frame execution.
// ============================================================================
async function soaErfChunked(out, xs, count, cs, ye) {
    count = count === undefined ? out.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) out[i] = erf(xs[i]);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaErfcChunked(out, xs, count, cs, ye) {
    count = count === undefined ? out.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) out[i] = erfc(xs[i]);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaGammaChunked(out, xs, count, cs, ye) {
    count = count === undefined ? out.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) out[i] = gamma(xs[i]);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaLgammaChunked(out, xs, count, cs, ye) {
    count = count === undefined ? out.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) out[i] = lgamma(xs[i]);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaBinomChunked(out, ns, ks, count, cs, ye) {
    count = count === undefined ? out.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) out[i] = binom(ns[i], ks[i]);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaLegendrePChunked(out, n, xs, count, cs, ye) {
    count = count === undefined ? out.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) out[i] = legendreP(n, xs[i]);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaRealSHChunked(out, order, thetas, phis, count, cs, ye) {
    count = count === undefined ? thetas.length : count;
    const nCoeff = (order + 1) * (order + 1);
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    
    const scratch = acquireSpecialScratch(nCoeff);
    const tmp = scratch.a;
    
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            realSH(order, thetas[i], phis[i], tmp);
            const offset = i * nCoeff;
            for (let j = 0; j < nCoeff; j++) out[offset + j] = tmp[j];
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    
    releaseSpecialScratch(scratch);
    return out;
}

async function soaGaussianFalloffChunked(out, distances, sigma, count, cs, ye) {
    count = count === undefined ? out.length : count;
    const twoSigma2 = 2 * sigma * sigma;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const d = distances[i];
            out[i] = Math.exp(-(d * d) / twoSigma2);
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaSoftmaxChunked(out, xs, count, cs, ye) {
    count = count === undefined ? out.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    
    let max = -Infinity;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) if (xs[i] > max) max = xs[i];
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    
    let sum = 0;
    start = 0; c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            out[i] = Math.exp(xs[i] - max);
            sum += out[i];
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    
    if (sum > 0) {
        const inv = 1 / sum;
        start = 0; c = 0;
        while (start < count) {
            const end = Math.min(start + cs, count);
            for (let i = start; i < end; i++) out[i] *= inv;
            start = end;
            if (start >= count) break;
            if (++c >= ye) { c = 0; await common.yieldToMain(); }
        }
    }
    return out;
}

async function soaBesselJ0Chunked(out, xs, count, cs, ye) {
    count = count === undefined ? out.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) out[i] = besselJ0(xs[i]);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================
function createSpecialScratchPool(capacity) {
    return common.createPool(
        function () {
            return {
                a: null, b: null, c: null, d: null, size: 0,
                _ensureAttached: false,
                ensure: function (n) {
                    if (n <= this.size) return this;
                    this.size = n;
                    const T = getArrayType();
                    this.a = new T(n);
                    this.b = new T(n);
                    this.c = new T(n);
                    this.d = new T(n);
                    return this;
                }
            };
        },
        capacity || 8,
        function (s) { s.a = null; s.b = null; s.c = null; s.d = null; s.size = 0; }
    );
}

function acquireSpecialScratch(size) {
    const s = _specialScratchPool.acquire();
    if (size !== undefined) s.ensure(size);
    return s;
}

function releaseSpecialScratch(s) { _specialScratchPool.release(s); }

// ============================================================================
// Class Declarations
// ============================================================================
class SpecialScratch {
    static #warm = [];
    static {
        for (let i = 0; i < 8; i++) SpecialScratch.#warm.push(new SpecialScratch(256));
    }
    static acquire(size) {
        for (let i = 0; i < SpecialScratch.#warm.length; i++) {
            if (SpecialScratch.#warm[i].size >= (size || 0)) {
                const s = SpecialScratch.#warm[i];
                SpecialScratch.#warm.splice(i, 1);
                return s;
            }
        }
        return new SpecialScratch(size || 256);
    }
    static release(s) { if (s) { s.reset(); SpecialScratch.#warm.push(s); } }
    constructor(size) {
        this.size = size || 256;
        const T = getArrayType();
        this.a = new T(this.size);
        this.b = new T(this.size);
        this.c = new T(this.size);
        this.d = new T(this.size);
    }
    ensure(n) {
        if (n <= this.size) return this;
        this.size = n;
        const T = getArrayType();
        this.a = new T(n);
        this.b = new T(n);
        this.c = new T(n);
        this.d = new T(n);
        return this;
    }
    reset() {
        this.a.fill(0); this.b.fill(0); this.c.fill(0); this.d.fill(0);
        return this;
    }
}

class SpecialFunctionBatchState {
    static #listeners = new Set();
    static {
        onPrecisionChange(function (mode, oldMode) {
            SpecialFunctionBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
        });
    }
    constructor(count, options) {
        options = options || {};
        this.count = count;
        const T = getArrayType();
        this.in      = new T(count);
        this.inAux   = new T(count);
        this.out     = new T(count);
        this.outAux  = new T(count);
        this.shOrder = options.shOrder || 3;
        this.shCoeffs = new Float64Array((this.shOrder + 1) * (this.shOrder + 1));
    }
    erf()     { return soaErf(this.out, this.in, this.count); }
    gamma()   { return soaGamma(this.out, this.in, this.count); }
    lgamma()  { return soaLgamma(this.out, this.in, this.count); }
    gaussian(sigma) { return soaGaussianFalloff(this.out, this.in, sigma, this.count); }
    besselJ0() { return soaBesselJ0(this.out, this.in, this.count); }
    
    setSHCoeffs(coeffs) {
        const n = Math.min(coeffs.length, this.shCoeffs.length);
        for (let i = 0; i < n; i++) this.shCoeffs[i] = coeffs[i];
        return this;
    }
    
    // Zero-GC compliant evaluation using pre-allocated scratch
    evaluateSH(directions) {
        const order = this.shOrder;
        const coeffs = this.shCoeffs;
        const out = this.out;
        const px = directions.x, py = directions.y, pz = directions.z;
        const n = this.count;
        const nCoeff = (order + 1) * (order + 1);
        
        const scratch = acquireSpecialScratch(nCoeff);
        const tmp = scratch.a;
        
        for (let i = 0; i < n; i++) {
            const theta = Math.acos(Math.max(-1, Math.min(1, py[i])));
            const phi = Math.atan2(pz[i], px[i]);
            realSH(order, theta, phi, tmp);
            let s = 0;
            for (let c = 0; c < coeffs.length; c++) s += coeffs[c] * tmp[c];
            out[i] = s;
        }
        
        releaseSpecialScratch(scratch);
        return out;
    }
    
    reset() {
        this.in.fill(0); this.inAux.fill(0); this.out.fill(0); this.outAux.fill(0);
        return this;
    }
}

function createSpecialFunctionBatch(count, options) {
    return new SpecialFunctionBatchState(count, options);
}

// ============================================================================
// Namespace convenience
// ============================================================================
const namespace = {
    gamma: {
        gamma, lgamma, digamma, polygamma,
        factorial, binom, lnBinom, pochhammer,
        beta, lnBeta, invGamma,
        incompleteP: incompleteGammaP,
        incompleteQ: incompleteGammaQ
    },
    error: {
        erf, erfc, erfcx, erfinv, erfcinv,
        incompleteBeta, invIncompleteBeta,
        normalCDF, normalQuantile
    },
    bessel: {
        J0: besselJ0, J1: besselJ1, Jn: besselJn,
        Y0: besselY0, Y1: besselY1, Yn: besselYn,
        I0: besselI0, I1: besselI1,
        K0: besselK0, K1: besselK1
    },
    airy: { Ai: airyAi, Bi: airyBi },
    polynomials: {
        legendreP, legendreAssoc,
        hermiteH, laguerreL,
        chebyshevT, chebyshevU
    },
    zeta: {
        riemann: riemannZeta,
        hurwitz: hurwitzZeta
    },
    lambertW: {
        W0: lambertW0,
        Wm1: lambertWm1
    },
    fresnel: { S: fresnelS, C: fresnelC },
    dawson: { D: dawson },
    elliptic: {
        K: ellipticK,
        E: ellipticE,
        F: ellipticF,
        EInc: ellipticEInc
    },
    sh: {
        real: realSH,
        scalar: sphericalHarmonic,
        normalization: shNormalization
    },
    softmax: {
        log1pExp: log1pExp,
        logsumexp: logsumexp,
        softmax: softmax
    },
    gaussian: {
        falloff: gaussianFalloff,
        bump: gaussianBump,
        normalCDF: normalCDF,
        normalQuantile: normalQuantile
    },
    batch: {
        State: SpecialFunctionBatchState,
        create: createSpecialFunctionBatch
    }
};

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    gamma, lgamma, digamma, polygamma, factorial, binom, lnBinom, pochhammer, beta, lnBeta, invGamma,
    incompleteGammaP, incompleteGammaQ,
    erf, erfc, erfcx, erfinv, erfcinv,
    incompleteBeta, invIncompleteBeta,
    besselJ0, besselJ1, besselJn, besselY0, besselY1, besselYn, besselI0, besselI1, besselK0, besselK1,
    airyAi, airyBi,
    legendreP, legendreAssoc, hermiteH, laguerreL, chebyshevT, chebyshevU,
    riemannZeta, hurwitzZeta,
    lambertW0, lambertWm1,
    fresnelS, fresnelC,
    dawson,
    ellipticK, ellipticE, ellipticF, ellipticEInc,
    realSH, sphericalHarmonic,
    logsumexp, softmax, log1pExp,
    gaussianFalloff, gaussianBump, normalCDF, normalQuantile,
    soaErf, soaErfc, soaGamma, soaLgamma, soaBinom, soaLegendreP, soaRealSH, soaRealSHBasis, 
    soaGaussianFalloff, soaNormalPDF, soaLogsumexp, soaSoftmax, soaBesselJ0, soaEllipticK, soaDirichletNormalize,
    soaErfChunked, soaErfcChunked, soaGammaChunked, soaLgammaChunked, soaBinomChunked, 
    soaLegendrePChunked, soaRealSHChunked, soaGaussianFalloffChunked, soaSoftmaxChunked, soaBesselJ0Chunked,
    SpecialScratch, createSpecialScratchPool, acquireSpecialScratch, releaseSpecialScratch,
    SpecialFunctionBatchState, createSpecialFunctionBatch,
    namespace
};

// ============================================================================
// Precision listener — new batch states pick up the new array type
// ============================================================================
onPrecisionChange(function (mode, oldMode) {
    // Existing batch states keep their current arrays. New ones created after
    // this point use the new type via getArrayType().
});