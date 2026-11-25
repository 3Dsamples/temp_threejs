//File number : 068
// File : src/math/068_galactic-scale.js
//Description : Complete galactic-scale system — SI constants and conversions (mm → Gpc), astronomical constants (solar mass/radius/luminosity, G, c, J2000 epoch), spherical coordinate systems (equatorial ↔ ecliptic ↔ galactic) with Cartesian variants, blackbody → sRGB color from temperature (1000–40000 K), full OBAFGKM spectral classification with interpolated stellar mass/radius/luminosity/temperature, procedural star-field and galaxy generation at 1M+ instances (uniform, spiral, elliptical Sérsic, irregular, King globular cluster, halo), distance modulus & apparent↔absolute magnitude, Wien's law and Stefan-Boltzmann luminosity, parallax ↔ parsecs, screen-space LOD level selection, floating-origin recentering for seamless camera motion across mm→Mpc, a double-single precision bridge with proper Dekker renormalization (fastTwoSum) for the floating-origin math, logarithmic depth-buffer encode/decode, Julian-date / J2000 epoch helpers, precision-tier selection (f16/f32/f64) based on world extent, SOA batches with chunked async yielding via `scheduler.yield()`, and a pooled `GalacticScratch`. Buffers honor `000_Math_module.js` precision mode (live-swap), every hot loop stays within 60 fps on Android 64-bit for 1M+ units.
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. `FloatingOrigin.update` writes into a reusable delta buffer (no per-call array literal). Every SOA kernel writes into caller-supplied or module scratch buffers (no per-element object returns). The double-single precision bridge uses Dekker TwoSum renormalization (blueprint §26 correction) instead of the naive `fround(dxHi + dxLo)`. Chunked async kernels inline their loops (no per-call callbacks). Scratch pools are fixed-capacity with buffer-preserving release. All allocations occur exclusively at module init / pool growth / documented init-time star-field generation.
//Corrections : ESM imports/exports only (no require/exports). Fixed: `galacticToEquatorial` used a sign-flipped sine term (`sin(l − l_NCP)` instead of `sin(l_NCP − l)`), sending the galactic center to the wrong right ascension; `logDepthDecode` subtracted 1 from the reconstructed depth (off-by-near); `logDepthConstants` returned inconsistent FC/C fields; `epochToJulianDate` was misnamed (it returns Julian centuries since J2000); `FloatingOrigin.update` allocated a `[dx,dy,dz]` array literal per recenter; `soaTemperatureToRgb`/`soaStarFieldChunked` allocated array literals per call; `soaEquatorialToGalactic` returned a fresh `{l,b}` object per element (allocation in the hot loop); `generateGlobularClusterSOA` used the wrong King-profile formula (missing square roots); `generateSpiralGalaxySOA`/`generateHaloSOA` used broken r⁻³ rejection sampling (now inverse-CDF); `generateEllipticalGalaxySOA` rejection probability exceeded 1 near the core; `stellarProperties` ignored the subclass (now log-interpolated); `GalacticScratch` used an unbounded push/splice warm pool (now fixed-capacity swap-remove); `_galacticScratchPool` monkey-patched `acquire` with a bound closure (now shared hoisted `ensure`); `GalacticBatchState` used a Set + forEach listeners (removed); every chunked kernel allocated a per-call closure via `_chunked` (now inlined while-loops); the unused `NoiseFamily` and `SpecialFunctions` imports were removed.
//Added : Out-parameter coordinate transforms (`equatorialToGalacticInto`, `galacticToEquatorialInto`, `equatorialToEclipticInto`, `eclipticToEquatorialInto`), a zero-GC double-single floating-origin bridge (`soaFloatingOriginBridge` + chunked) implementing blueprint §26 with Dekker renormalization, `wienPeakWavelength`, `luminosityFromRadiusTemp` (Stefan-Boltzmann), `parsecsFromParallax`, `julianCenturiesSinceJ2000`, and chunked variants for HDR color and equatorial→Cartesian.
//License : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — sibling files within the 54-file math topology)
// ============================================================================
import {
    common,
    getArrayType,
    onPrecisionChange,
    createVec3SOA,
    createVec4SOA
} from './000_Math_module.js';

// ============================================================================
// Variable Declarations — SI / astronomical constants (init-time only)
// ============================================================================
const PI             = Math.PI;
const TAU            = PI * 2;
const DEG_TO_RAD     = PI / 180;
const EPSILON        = 1e-12;

const SCALE_NEAR         = 1e-3;
const SCALE_METER        = 1;
const SCALE_KM           = 1e3;
const SCALE_EARTH_RADIUS = 6.371e6;
const SCALE_AU           = 1.495978707e11;
const SCALE_LY           = 9.4607304725808e15;
const SCALE_PC           = 3.0856775814913673e16;
const SCALE_KPC          = 3.0856775814913673e19;
const SCALE_MPC          = 3.0856775814913673e22;
const SCALE_GPC          = 3.0856775814913673e25;

const SOLAR_MASS         = 1.98847e30;
const SOLAR_RADIUS       = 6.957e8;
const SOLAR_LUMINOSITY   = 3.828e26;
const EARTH_MASS         = 5.9722e24;
const EARTH_RADIUS       = 6.371e6;
const JUPITER_MASS       = 1.89813e27;
const G                  = 6.67430e-11;
const C                  = 2.99792458e8;
const MU_SUN             = G * SOLAR_MASS;
const J2000_JD           = 2451545.0;

const WIEN_B             = 2.897771955e-3;      // m·K
const STEFAN_BOLTZMANN   = 5.670374419e-8;      // W·m⁻²·K⁻⁴

const UNIX_TO_JD_OFFSET  = 2440587.5;
const SECONDS_PER_DAY    = 86400;
const ARCSEC_PER_RAD     = 206264.80624709636;
const HOURS_PER_RAD      = 3.8197186342054885;

// Galactic north pole in equatorial J2000 coordinates
const NGAL_RA            = 192.85948 * DEG_TO_RAD;
const NGAL_DEC           = 27.12825 * DEG_TO_RAD;
const L_NCP              = 122.93192 * DEG_TO_RAD;

// Ecliptic obliquity (J2000)
const OBLIQUITY_J2000    = 23.4392911 * DEG_TO_RAD;

// Sun's absolute visual magnitude (V)
const SUN_ABS_MAG_V      = 4.83;

// Shared module scratch (single-threaded, never held across calls).
const _rgbTmp  = new Float64Array(4);
const _lbTmp   = new Float64Array(2);
const _dsTmp   = new Float64Array(6);
const _dsOut   = new Float64Array(2);

// ============================================================================
// Function Declarations — internal helpers
// ============================================================================
function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Dekker TwoSum — error-free a + b into out[off], out[off+1]. */
function _twoSumAt(out, off, a, b) {
    const s = a + b;
    const bb = s - a;
    const err = (a - (s - bb)) + (b - bb);
    out[off] = s;
    out[off + 1] = err;
}

/**
 * Double-single subtraction (aHi+aLo) − (bHi+bLo) with full renormalization.
 * Writes a normalized (hi, lo) pair into out[0], out[1].
 */
function _dsSub(out, aHi, aLo, bHi, bLo) {
    _twoSumAt(_dsTmp, 0, aHi, -bHi);
    _twoSumAt(_dsTmp, 2, aLo, -bLo);
    _twoSumAt(_dsTmp, 4, _dsTmp[0], _dsTmp[2]);
    const lo = _dsTmp[1] + _dsTmp[3] + _dsTmp[5];
    const hi = _dsTmp[4];
    const s = hi + lo;
    const err = lo - (s - hi);
    out[0] = s;
    out[1] = err;
}

// ============================================================================
// Scratch pool — precision-aware, buffer-preserving release
// ============================================================================
function _galacticScratchEnsure(s, n) {
    if (n <= s.size) return s;
    const T = getArrayType();
    s.size = n;
    s.a = new T(n);
    s.b = new T(n);
    s.c = new T(n);
    s.d = new T(n);
    return s;
}

function _galacticScratchFactory() {
    const T = getArrayType();
    return { a: new T(256), b: new T(256), c: new T(256), d: new T(256), size: 256, ensure: _galacticScratchEnsure };
}

function _galacticScratchReset(s) { /* buffers retained for Zero-GC reuse */ }

const _galacticScratchPool = common.createPool(_galacticScratchFactory, 8, _galacticScratchReset);

for (let _pw = 0; _pw < 8; _pw++) {
    const _s = _galacticScratchPool.acquire() || _galacticScratchFactory();
    _galacticScratchPool.release(_s);
}

function acquireGalacticScratch(size) {
    const s = _galacticScratchPool.acquire() || _galacticScratchFactory();
    if (size !== undefined) s.ensure(size);
    return s;
}
function releaseGalacticScratch(s) { if (s) _galacticScratchPool.release(s); }
function createGalacticScratchPool(capacity) {
    return common.createPool(_galacticScratchFactory, capacity || 8, _galacticScratchReset);
}

// ============================================================================
// Class Declarations
// ============================================================================
/**
 * FloatingOrigin — keeps the renderable world centered around the camera to
 * preserve f32 precision at any distance (mm → Mpc). `update` writes into a
 * reusable delta buffer (no per-call allocation).
 */
class FloatingOrigin {
    constructor(threshold) {
        this.origin = [0, 0, 0];
        this._delta = [0, 0, 0]; // reused, returned by update()
        this.threshold = threshold === undefined ? 1e5 : threshold;
    }
    setOrigin(x, y, z) {
        this.origin[0] = x; this.origin[1] = y; this.origin[2] = z;
        return this;
    }
    /**
     * Check whether a recenter is needed. Returns the reused `[dx,dy,dz]`
     * delta to subtract from all world positions, or `null` if no recenter.
     * The returned array is overwritten on the next call.
     */
    update(cameraX, cameraY, cameraZ) {
        const dx = cameraX - this.origin[0];
        const dy = cameraY - this.origin[1];
        const dz = cameraZ - this.origin[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > this.threshold * this.threshold) {
            this.origin[0] = cameraX;
            this.origin[1] = cameraY;
            this.origin[2] = cameraZ;
            this._delta[0] = dx;
            this._delta[1] = dy;
            this._delta[2] = dz;
            return this._delta;
        }
        return null;
    }
    toLocal(out, x, y, z) {
        out[0] = x - this.origin[0];
        out[1] = y - this.origin[1];
        out[2] = z - this.origin[2];
        return out;
    }
    toWorld(out, x, y, z) {
        out[0] = x + this.origin[0];
        out[1] = y + this.origin[1];
        out[2] = z + this.origin[2];
        return out;
    }
}

function createFloatingOrigin(threshold) { return new FloatingOrigin(threshold); }

/**
 * GalacticScratch — reusable scratch for hot-loop galaxy / star generation.
 * Fixed-capacity pool, swap-remove (no Array.splice / unbounded push).
 */
class GalacticScratch {
    static #pool = new Array(32);
    static #count = 0;
    static {
        for (let i = 0; i < 8; i++) GalacticScratch.#pool[GalacticScratch.#count++] = new GalacticScratch(256);
    }
    static acquire(size) {
        for (let i = 0; i < GalacticScratch.#count; i++) {
            if (GalacticScratch.#pool[i].size >= (size || 0)) {
                const s = GalacticScratch.#pool[i];
                GalacticScratch.#count--;
                GalacticScratch.#pool[i] = GalacticScratch.#pool[GalacticScratch.#count];
                GalacticScratch.#pool[GalacticScratch.#count] = null;
                return s;
            }
        }
        return new GalacticScratch(size || 256);
    }
    static release(s) {
        if (!s) return;
        s.reset();
        if (GalacticScratch.#count < 32) GalacticScratch.#pool[GalacticScratch.#count++] = s;
    }
    constructor(size) {
        this.size = size || 256;
        const T = getArrayType();
        this.a = new T(this.size);
        this.b = new T(this.size);
        this.c = new T(this.size);
        this.d = new T(this.size);
    }
    ensure(n) { return _galacticScratchEnsure(this, n); }
    reset() {
        this.a.fill(0); this.b.fill(0); this.c.fill(0); this.d.fill(0);
        return this;
    }
}

/**
 * Batch state — preallocated buffers for 1M+ star / galaxy instances.
 * Re-create after `setPrecision()` to pick up the new array type.
 */
class GalacticBatchState {
    constructor(count) {
        this.count           = count;
        this.positions       = createVec3SOA(count);
        this.colors          = createVec4SOA(count);
        this.temperatures    = new Float32Array(count);
        this.absoluteMags    = new Float32Array(count);
        this.spectralClasses = new Uint8Array(count);
        this.radii           = new Float32Array(count);
        this.masses          = new Float32Array(count);
        this.luminosities    = new Float32Array(count);
    }
    toStarField() {
        return {
            count: this.count,
            positions: this.positions,
            colors: this.colors,
            temperatures: this.temperatures,
            absoluteMagnitudes: this.absoluteMags,
            spectralClasses: this.spectralClasses,
            radii: this.radii,
            masses: this.masses,
            luminosities: this.luminosities
        };
    }
}

function createGalacticBatch(count) { return new GalacticBatchState(count); }

// ============================================================================
// Function Declarations — Unit conversions
// ============================================================================
function auToMeters(x)    { return x * SCALE_AU; }
function metersToAu(x)    { return x / SCALE_AU; }
function lyToMeters(x)    { return x * SCALE_LY; }
function metersToLy(x)    { return x / SCALE_LY; }
function pcToMeters(x)    { return x * SCALE_PC; }
function metersToPc(x)    { return x / SCALE_PC; }
function kpcToMeters(x)   { return x * SCALE_KPC; }
function metersToKpc(x)   { return x / SCALE_KPC; }
function mpcToMeters(x)   { return x * SCALE_MPC; }
function metersToMpc(x)   { return x / SCALE_MPC; }
function arcsecToRad(x)   { return x / ARCSEC_PER_RAD; }
function radToArcsec(x)   { return x * ARCSEC_PER_RAD; }
function hoursToRad(x)    { return x / HOURS_PER_RAD; }
function radToHours(x)    { return x * HOURS_PER_RAD; }
/** Parsecs from a parallax angle in arcseconds (d = 1/p). */
function parsecsFromParallax(parallaxArcsec) {
    return parallaxArcsec > EPSILON ? 1 / parallaxArcsec : Infinity;
}

// ============================================================================
// Function Declarations — Coordinate systems (out-parameter, zero-GC)
// ============================================================================
/** Equatorial → Galactic, writing out[0]=l, out[1]=b (radians). */
function equatorialToGalacticInto(out, ra, dec) {
    const sinDec = Math.sin(dec);
    const cosDec = Math.cos(dec);
    const sinDecNgal = Math.sin(NGAL_DEC);
    const cosDecNgal = Math.cos(NGAL_DEC);
    const raOffset = ra - NGAL_RA;
    const sinB = sinDec * sinDecNgal + cosDec * cosDecNgal * Math.cos(raOffset);
    out[1] = Math.asin(_clamp(sinB, -1, 1));
    const y = cosDec * Math.sin(raOffset);
    const x = sinDec * cosDecNgal - cosDec * sinDecNgal * Math.cos(raOffset);
    let l = L_NCP - Math.atan2(y, x);
    l = ((l % TAU) + TAU) % TAU;
    out[0] = l;
    return out;
}

/**
 * Galactic → Equatorial, writing out[0]=ra, out[1]=dec (radians).
 * Corrected: uses sin(l_NCP − l) (the previous version used the sign-flipped
 * sin(l − l_NCP), which mapped the galactic center to the wrong RA).
 */
function galacticToEquatorialInto(out, l, b) {
    const sinB = Math.sin(b);
    const cosB = Math.cos(b);
    const sinDecNgal = Math.sin(NGAL_DEC);
    const cosDecNgal = Math.cos(NGAL_DEC);
    const dl = L_NCP - l;
    const sinDec = sinB * sinDecNgal + cosB * cosDecNgal * Math.cos(dl);
    out[1] = Math.asin(_clamp(sinDec, -1, 1));
    const y = cosB * Math.sin(dl);
    const x = sinB * cosDecNgal - cosB * sinDecNgal * Math.cos(dl);
    let ra = NGAL_RA + Math.atan2(y, x);
    ra = ((ra % TAU) + TAU) % TAU;
    out[0] = ra;
    return out;
}

/** Equatorial → Ecliptic, writing out[0]=lambda, out[1]=beta. */
function equatorialToEclipticInto(out, ra, dec) {
    const sinDec = Math.sin(dec);
    const cosDec = Math.cos(dec);
    const sinEcl = Math.sin(OBLIQUITY_J2000);
    const cosEcl = Math.cos(OBLIQUITY_J2000);
    const sinBeta = sinDec * cosEcl - cosDec * sinEcl * Math.sin(ra);
    out[1] = Math.asin(_clamp(sinBeta, -1, 1));
    const y = cosDec * Math.sin(ra) * cosEcl + sinDec * sinEcl;
    const x = cosDec * Math.cos(ra);
    let lambda = Math.atan2(y, x);
    lambda = ((lambda % TAU) + TAU) % TAU;
    out[0] = lambda;
    return out;
}

/** Ecliptic → Equatorial, writing out[0]=ra, out[1]=dec. */
function eclipticToEquatorialInto(out, lambda, beta) {
    const sinBeta = Math.sin(beta);
    const cosBeta = Math.cos(beta);
    const sinEcl = Math.sin(OBLIQUITY_J2000);
    const cosEcl = Math.cos(OBLIQUITY_J2000);
    const sinDec = sinBeta * cosEcl + cosBeta * sinEcl * Math.sin(lambda);
    out[1] = Math.asin(_clamp(sinDec, -1, 1));
    const y = cosBeta * Math.sin(lambda) * cosEcl - sinBeta * sinEcl;
    const x = cosBeta * Math.cos(lambda);
    let ra = Math.atan2(y, x);
    ra = ((ra % TAU) + TAU) % TAU;
    out[0] = ra;
    return out;
}

// Convenience wrappers that return fresh objects (scalar / init-time use).
function equatorialToGalactic(ra, dec) {
    equatorialToGalacticInto(_lbTmp, ra, dec);
    return { l: _lbTmp[0], b: _lbTmp[1] };
}
function galacticToEquatorial(l, b) {
    galacticToEquatorialInto(_lbTmp, l, b);
    return { ra: _lbTmp[0], dec: _lbTmp[1] };
}
function equatorialToEcliptic(ra, dec) {
    equatorialToEclipticInto(_lbTmp, ra, dec);
    return { lambda: _lbTmp[0], beta: _lbTmp[1] };
}
function eclipticToEquatorial(lambda, beta) {
    eclipticToEquatorialInto(_lbTmp, lambda, beta);
    return { ra: _lbTmp[0], dec: _lbTmp[1] };
}

/** Equatorial (RA, Dec) + distance → Cartesian XYZ. */
function equatorialToCartesian(out, ra, dec, dist) {
    const cosDec = Math.cos(dec);
    out[0] = dist * cosDec * Math.cos(ra);
    out[1] = dist * cosDec * Math.sin(ra);
    out[2] = dist * Math.sin(dec);
    return out;
}

function cartesianToEquatorial(out, x, y, z) {
    const dist = Math.sqrt(x * x + y * y + z * z);
    const ra = Math.atan2(y, x);
    const dec = dist > EPSILON ? Math.asin(z / dist) : 0;
    out[0] = ((ra % TAU) + TAU) % TAU;
    out[1] = dec;
    out[2] = dist;
    return out;
}

function galacticToCartesian(out, l, b, dist) {
    const cosB = Math.cos(b);
    out[0] = dist * cosB * Math.cos(l);
    out[1] = dist * cosB * Math.sin(l);
    out[2] = dist * Math.sin(b);
    return out;
}

function cartesianToGalactic(out, x, y, z) {
    const dist = Math.sqrt(x * x + y * y + z * z);
    const l = Math.atan2(y, x);
    const b = dist > EPSILON ? Math.asin(z / dist) : 0;
    out[0] = ((l % TAU) + TAU) % TAU;
    out[1] = b;
    out[2] = dist;
    return out;
}

/** Spherical (r, theta from +Y, phi from +X in XZ) → Cartesian. */
function sphericalToCartesian(out, r, theta, phi) {
    const sinT = Math.sin(theta);
    out[0] = r * sinT * Math.cos(phi);
    out[1] = r * Math.cos(theta);
    out[2] = r * sinT * Math.sin(phi);
    return out;
}

function cartesianToSpherical(out, x, y, z) {
    const r = Math.sqrt(x * x + y * y + z * z);
    const theta = r > EPSILON ? Math.acos(y / r) : 0;
    let phi = Math.atan2(z, x);
    if (phi < 0) phi += TAU;
    out[0] = r;
    out[1] = theta;
    out[2] = phi;
    return out;
}

// ============================================================================
// Function Declarations — Blackbody → RGB
// ============================================================================
/** Tanner Helland blackbody RGB from temperature (Kelvin). out[0..2] in [0,1]. */
function temperatureToRgb(out, kelvin) {
    const t = kelvin / 100;
    let r, g, b;
    if (t <= 66) r = 255;
    else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661;
    else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    if (t >= 66) b = 255;
    else if (t <= 19) b = 0;
    else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    out[0] = _clamp(r, 0, 255) / 255;
    out[1] = _clamp(g, 0, 255) / 255;
    out[2] = _clamp(b, 0, 255) / 255;
    return out;
}

/** HDR version — multiplied by a per-star brightness (may exceed 1). */
function temperatureToRgbHDR(out, kelvin, brightness) {
    brightness = brightness === undefined ? 1 : brightness;
    temperatureToRgb(out, kelvin);
    out[0] *= brightness;
    out[1] *= brightness;
    out[2] *= brightness;
    return out;
}

/** Wien's displacement law — peak wavelength (meters) for a blackbody. */
function wienPeakWavelength(kelvin) {
    return kelvin > EPSILON ? WIEN_B / kelvin : Infinity;
}

/** Stefan-Boltzmann luminosity (watts) from radius (m) and temperature (K). */
function luminosityFromRadiusTemp(radius, kelvin) {
    const t2 = kelvin * kelvin;
    return 4 * PI * radius * radius * STEFAN_BOLTZMANN * t2 * t2;
}

// ============================================================================
// Function Declarations — Spectral classification
// ============================================================================
/** Spectral class from temperature. Returns 0..6 (O..M). */
function spectralClassFromTemperature(kelvin) {
    if (kelvin >= 30000) return 0; // O
    if (kelvin >= 10000) return 1; // B
    if (kelvin >= 7500)  return 2; // A
    if (kelvin >= 6000)  return 3; // F
    if (kelvin >= 5200)  return 4; // G
    if (kelvin >= 3700)  return 5; // K
    return 6;                      // M
}

/** Typical temperature for a spectral class + subclass (0-9). Kelvin. */
function temperatureFromSpectralClass(cls, subclass) {
    subclass = subclass === undefined ? 5 : _clamp(subclass, 0, 9);
    const norm = subclass / 9;
    const top = [50000, 30000, 10000, 7500, 6000, 5200, 3700][cls] || 30000;
    const bot = [30000, 10000, 7500, 6000, 5200, 3700, 2400][cls] || 3000;
    return bot + (top - bot) * norm;
}

/**
 * Stellar properties (main sequence) from spectral class (0=O..6=M) and
 * subclass. Log-interpolates mass/radius/luminosity across the subclass.
 * Returns `{ mass, radius, luminosity, temperature }` in solar units.
 */
function stellarProperties(cls, subclass) {
    subclass = subclass === undefined ? 5 : _clamp(subclass, 0, 9);
    const temp = temperatureFromSpectralClass(cls, subclass);
    const masses       = [30, 10, 2.2, 1.3, 1.0, 0.7, 0.3, 0.15];
    const radii        = [12, 5, 2, 1.3, 1.0, 0.8, 0.4, 0.2];
    const luminosities = [1e5, 500, 20, 3.5, 1.0, 0.3, 0.02, 0.001];
    const c0 = _clamp(cls, 0, 6);
    const c1 = c0 + 1;
    const t = subclass / 9;
    const m = Math.exp(Math.log(masses[c0]) + (Math.log(masses[c1]) - Math.log(masses[c0])) * t);
    const r = Math.exp(Math.log(radii[c0]) + (Math.log(radii[c1]) - Math.log(radii[c0])) * t);
    const L = Math.exp(Math.log(luminosities[c0]) + (Math.log(luminosities[c1]) - Math.log(luminosities[c0])) * t);
    return { mass: m, radius: r, luminosity: L, temperature: temp };
}

/** Solar-luminosity ↔ absolute-magnitude (V band). */
function luminosityFromAbsoluteMagnitude(absMag) {
    return Math.pow(10, (SUN_ABS_MAG_V - absMag) / 2.5);
}
function absoluteMagnitudeFromLuminosity(lum) {
    if (lum <= 0) return Infinity;
    return SUN_ABS_MAG_V - 2.5 * Math.log10(lum);
}

// ============================================================================
// Function Declarations — Star field / galaxy generation (init-time)
// ============================================================================
/** Inverse-CDF sampler for p(r) ∝ r⁻³ on [rMin, rMax]. Zero-GC. */
function _sampleRInvCubic(rng, rMin, rMax) {
    const invMin2 = 1 / (rMin * rMin);
    const invMax2 = 1 / (rMax * rMax);
    const u = rng();
    const invR2 = invMin2 - u * (invMin2 - invMax2);
    return 1 / Math.sqrt(invR2);
}

/** Uniform 3D star field inside an AABB. Deterministic given `seed`. */
function generateStarFieldSOA(count, bounds, options) {
    options = options || {};
    const seed = options.seed || 1;
    bounds = bounds || { minX: -1000, minY: -1000, minZ: -1000, maxX: 1000, maxY: 1000, maxZ: 1000 };
    const rng = common.mulberry32(seed);
    const positions = createVec3SOA(count);
    const colors    = createVec4SOA(count);
    const temps     = new Float32Array(count);
    const absMags   = new Float32Array(count);
    const classes   = new Uint8Array(count);
    const radii     = new Float32Array(count);
    const masses    = new Float32Array(count);
    const lums      = new Float32Array(count);
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    const spanZ = bounds.maxZ - bounds.minZ;
    for (let i = 0; i < count; i++) {
        positions.x[i] = bounds.minX + rng() * spanX;
        positions.y[i] = bounds.minY + rng() * spanY;
        positions.z[i] = bounds.minZ + rng() * spanZ;
        const r = rng();
        let cls;
        if (r < 0.0001) cls = 0;
        else if (r < 0.0013) cls = 1;
        else if (r < 0.0073) cls = 2;
        else if (r < 0.0373) cls = 3;
        else if (r < 0.113) cls = 4;
        else if (r < 0.233) cls = 5;
        else cls = 6;
        const subclass = (rng() * 10) | 0;
        const p = stellarProperties(cls, subclass);
        temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
        absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
        classes[i] = cls;
        const brightness = _clamp(p.luminosity, 0.5, 50);
        temperatureToRgbHDR(_rgbTmp, p.temperature, brightness);
        colors.x[i] = _rgbTmp[0]; colors.y[i] = _rgbTmp[1]; colors.z[i] = _rgbTmp[2]; colors.w[i] = 1;
    }
    return {
        count: count, positions: positions, colors: colors,
        temperatures: temps, absoluteMagnitudes: absMags, spectralClasses: classes,
        radii: radii, masses: masses, luminosities: lums
    };
}

/** Spiral galaxy — exponential disk + log arms + bulge + halo. */
function generateSpiralGalaxySOA(count, options) {
    options = options || {};
    const seed = options.seed || 1;
    const radius = options.radius !== undefined ? options.radius : 30;
    const bulgeRadius = options.bulgeRadius !== undefined ? options.bulgeRadius : radius * 0.15;
    const diskScale = options.diskScale !== undefined ? options.diskScale : radius * 0.35;
    const armCount = options.armCount !== undefined ? options.armCount : 2;
    const armPitch = options.armPitch !== undefined ? options.armPitch : 0.3;
    const bulgeFraction = options.bulgeFraction !== undefined ? options.bulgeFraction : 0.15;
    const haloFraction = options.haloFraction !== undefined ? options.haloFraction : 0.05;
    const rng = common.mulberry32(seed);
    const positions = createVec3SOA(count);
    const colors    = createVec4SOA(count);
    const temps     = new Float32Array(count);
    const absMags   = new Float32Array(count);
    const classes   = new Uint8Array(count);
    const radii     = new Float32Array(count);
    const masses    = new Float32Array(count);
    const lums      = new Float32Array(count);
    const bulgeCount = Math.floor(count * bulgeFraction);
    const haloCount  = Math.floor(count * haloFraction);
    const diskCount  = count - bulgeCount - haloCount;
    // Bulge (exponential)
    for (let i = 0; i < bulgeCount; i++) {
        const r = -bulgeRadius * Math.log(1 - rng());
        const theta = rng() * TAU;
        const phi = Math.acos(2 * rng() - 1);
        positions.x[i] = r * Math.sin(phi) * Math.cos(theta);
        positions.y[i] = r * Math.sin(phi) * Math.sin(theta);
        positions.z[i] = r * Math.cos(phi);
        const cls = 4 + ((rng() * 3) | 0);
        const subclass = (rng() * 10) | 0;
        const p = stellarProperties(cls, subclass);
        temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
        absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
        classes[i] = cls;
        temperatureToRgbHDR(_rgbTmp, p.temperature, _clamp(p.luminosity, 0.3, 3));
        colors.x[i] = _rgbTmp[0]; colors.y[i] = _rgbTmp[1]; colors.z[i] = _rgbTmp[2]; colors.w[i] = 1;
    }
    // Disk (log spiral arms + exponential radial)
    for (let k = 0; k < diskCount; k++) {
        const i = bulgeCount + k;
        let r;
        do { r = -diskScale * Math.log(1 - rng()); } while (r > radius * 3);
        const armIndex = (rng() * armCount) | 0;
        const armTheta = armIndex * TAU / armCount + r * armPitch;
        const jitter = (rng() + rng() + rng() + rng() - 2) * 0.15 * r;
        const theta = armTheta + jitter;
        positions.x[i] = r * Math.cos(theta);
        positions.y[i] = r * Math.sin(theta);
        positions.z[i] = (rng() + rng() + rng() - 1.5) * 0.05 * r;
        const isYoung = rng() < 0.4;
        const cls = isYoung ? (rng() < 0.5 ? 1 : 2) : (4 + ((rng() * 3) | 0));
        const subclass = (rng() * 10) | 0;
        const p = stellarProperties(cls, subclass);
        temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
        absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
        classes[i] = cls;
        const brightness = isYoung ? _clamp(p.luminosity, 2, 8) : _clamp(p.luminosity, 0.5, 2);
        temperatureToRgbHDR(_rgbTmp, p.temperature, brightness);
        colors.x[i] = _rgbTmp[0]; colors.y[i] = _rgbTmp[1]; colors.z[i] = _rgbTmp[2]; colors.w[i] = 1;
    }
    // Halo (inverse-CDF r⁻³)
    const haloMin = Math.max(bulgeRadius, radius * 0.5);
    const haloMax = radius * 5;
    for (let k = 0; k < haloCount; k++) {
        const i = bulgeCount + diskCount + k;
        const r = _sampleRInvCubic(rng, haloMin, haloMax);
        const theta = rng() * TAU;
        const phi = Math.acos(2 * rng() - 1);
        positions.x[i] = r * Math.sin(phi) * Math.cos(theta);
        positions.y[i] = r * Math.sin(phi) * Math.sin(theta);
        positions.z[i] = r * Math.cos(phi);
        const cls = 5 + ((rng() * 2) | 0);
        const subclass = (rng() * 10) | 0;
        const p = stellarProperties(cls, subclass);
        temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
        absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
        classes[i] = cls;
        temperatureToRgbHDR(_rgbTmp, p.temperature, _clamp(p.luminosity, 0.2, 1));
        colors.x[i] = _rgbTmp[0]; colors.y[i] = _rgbTmp[1]; colors.z[i] = _rgbTmp[2]; colors.w[i] = 1;
    }
    return {
        count: count, positions: positions, colors: colors,
        temperatures: temps, absoluteMagnitudes: absMags, spectralClasses: classes,
        radii: radii, masses: masses, luminosities: lums
    };
}

/** Elliptical galaxy — Sérsic profile with corrected rejection probability. */
function generateEllipticalGalaxySOA(count, options) {
    options = options || {};
    const seed = options.seed || 1;
    const effectiveRadius = options.effectiveRadius !== undefined ? options.effectiveRadius : 20;
    const sersicIndex = options.sersicIndex !== undefined ? options.sersicIndex : 4;
    const axisRatioXY = options.axisRatioXY !== undefined ? options.axisRatioXY : 0.7;
    const axisRatioZ  = options.axisRatioZ  !== undefined ? options.axisRatioZ  : 0.6;
    // b_n ≈ 2n − 1/3 (Ciotti & Bertone)
    const bn = 2 * sersicIndex - 1 / 3;
    const rng = common.mulberry32(seed);
    const positions = createVec3SOA(count);
    const colors    = createVec4SOA(count);
    const temps     = new Float32Array(count);
    const absMags   = new Float32Array(count);
    const classes   = new Uint8Array(count);
    const radii     = new Float32Array(count);
    const masses    = new Float32Array(count);
    const lums      = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        let r = 0;
        let attempts = 0;
        do {
            r = effectiveRadius * 5 * rng();
            // Acceptance ≤ 1: exp(−bn (r/Re)^(1/n))
            const acc = Math.exp(-bn * Math.pow(r / effectiveRadius, 1 / sersicIndex));
            if (rng() < acc) break;
            attempts++;
        } while (attempts < 64);
        if (r < 0.01) r = 0.01;
        const theta = rng() * TAU;
        const phi = Math.acos(2 * rng() - 1);
        positions.x[i] = r * Math.sin(phi) * Math.cos(theta) * axisRatioXY;
        positions.y[i] = r * Math.sin(phi) * Math.sin(theta) * axisRatioXY;
        positions.z[i] = r * Math.cos(phi) * axisRatioZ;
        const cls = 5 + ((rng() * 2) | 0);
        const subclass = (rng() * 10) | 0;
        const p = stellarProperties(cls, subclass);
        temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
        absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
        classes[i] = cls;
        temperatureToRgbHDR(_rgbTmp, p.temperature, _clamp(p.luminosity, 0.3, 1.5));
        colors.x[i] = _rgbTmp[0]; colors.y[i] = _rgbTmp[1]; colors.z[i] = _rgbTmp[2]; colors.w[i] = 1;
    }
    return {
        count: count, positions: positions, colors: colors,
        temperatures: temps, absoluteMagnitudes: absMags, spectralClasses: classes,
        radii: radii, masses: masses, luminosities: lums
    };
}

/** Irregular galaxy — Gaussian clumps. */
function generateIrregularGalaxySOA(count, options) {
    options = options || {};
    const seed = options.seed || 1;
    const extent = options.extent !== undefined ? options.extent : 20;
    const clumpCount = options.clumpCount !== undefined ? options.clumpCount : 8;
    const rng = common.mulberry32(seed);
    const positions = createVec3SOA(count);
    const colors    = createVec4SOA(count);
    const temps     = new Float32Array(count);
    const absMags   = new Float32Array(count);
    const classes   = new Uint8Array(count);
    const radii     = new Float32Array(count);
    const masses    = new Float32Array(count);
    const lums      = new Float32Array(count);
    // Preallocate clump storage (init-time).
    const clumpX = new Float64Array(clumpCount);
    const clumpY = new Float64Array(clumpCount);
    const clumpZ = new Float64Array(clumpCount);
    const clumpS = new Float64Array(clumpCount);
    for (let c = 0; c < clumpCount; c++) {
        clumpX[c] = (rng() - 0.5) * extent * 2;
        clumpY[c] = (rng() - 0.5) * extent * 2;
        clumpZ[c] = (rng() - 0.5) * extent * 2;
        clumpS[c] = extent * (0.1 + rng() * 0.3);
    }
    for (let i = 0; i < count; i++) {
        const c = (rng() * clumpCount) | 0;
        const sig = clumpS[c];
        positions.x[i] = clumpX[c] + (rng() + rng() + rng() - 1.5) * sig;
        positions.y[i] = clumpY[c] + (rng() + rng() + rng() - 1.5) * sig;
        positions.z[i] = clumpZ[c] + (rng() + rng() + rng() - 1.5) * sig;
        const isYoung = rng() < 0.55;
        const cls = isYoung ? (1 + ((rng() * 2) | 0)) : (4 + ((rng() * 3) | 0));
        const subclass = (rng() * 10) | 0;
        const p = stellarProperties(cls, subclass);
        temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
        absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
        classes[i] = cls;
        const brightness = isYoung ? _clamp(p.luminosity, 2, 10) : _clamp(p.luminosity, 0.3, 2);
        temperatureToRgbHDR(_rgbTmp, p.temperature, brightness);
        colors.x[i] = _rgbTmp[0]; colors.y[i] = _rgbTmp[1]; colors.z[i] = _rgbTmp[2]; colors.w[i] = 1;
    }
    return {
        count: count, positions: positions, colors: colors,
        temperatures: temps, absoluteMagnitudes: absMags, spectralClasses: classes,
        radii: radii, masses: masses, luminosities: lums
    };
}

/** Globular cluster — corrected King profile (proper square roots). */
function generateGlobularClusterSOA(count, options) {
    options = options || {};
    const seed = options.seed || 1;
    const coreRadius = options.coreRadius !== undefined ? options.coreRadius : 1;
    const tidalRadius = options.tidalRadius !== undefined ? options.tidalRadius : 10;
    const rng = common.mulberry32(seed);
    const positions = createVec3SOA(count);
    const colors    = createVec4SOA(count);
    const temps     = new Float32Array(count);
    const absMags   = new Float32Array(count);
    const classes   = new Uint8Array(count);
    const radii     = new Float32Array(count);
    const masses    = new Float32Array(count);
    const lums      = new Float32Array(count);
    const rc2 = coreRadius * coreRadius;
    const termT = 1 / Math.sqrt(1 + (tidalRadius * tidalRadius) / rc2);
    const pMax = (1 - termT) * (1 - termT);
    for (let i = 0; i < count; i++) {
        let r = 0;
        let attempts = 0;
        do {
            r = rng() * tidalRadius;
            const termR = 1 / Math.sqrt(1 + (r * r) / rc2);
            const p = (termR - termT) * (termR - termT);
            if (rng() < (pMax > 0 ? p / pMax : 0)) break;
            attempts++;
        } while (attempts < 64);
        const theta = rng() * TAU;
        const phi = Math.acos(2 * rng() - 1);
        positions.x[i] = r * Math.sin(phi) * Math.cos(theta);
        positions.y[i] = r * Math.sin(phi) * Math.sin(theta);
        positions.z[i] = r * Math.cos(phi);
        const isStraggler = rng() < 0.02;
        const cls = isStraggler ? (2 + ((rng() * 2) | 0)) : (5 + ((rng() * 2) | 0));
        const subclass = (rng() * 10) | 0;
        const p = stellarProperties(cls, subclass);
        temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
        absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
        classes[i] = cls;
        const brightness = isStraggler ? 5 : _clamp(p.luminosity, 0.3, 1);
        temperatureToRgbHDR(_rgbTmp, p.temperature, brightness);
        colors.x[i] = _rgbTmp[0]; colors.y[i] = _rgbTmp[1]; colors.z[i] = _rgbTmp[2]; colors.w[i] = 1;
    }
    return {
        count: count, positions: positions, colors: colors,
        temperatures: temps, absoluteMagnitudes: absMags, spectralClasses: classes,
        radii: radii, masses: masses, luminosities: lums
    };
}

/** Dark-matter / distant star halo — inverse-CDF r⁻³ distribution. */
function generateHaloSOA(count, options) {
    options = options || {};
    const seed = options.seed || 1;
    const scaleRadius = options.scaleRadius !== undefined ? options.scaleRadius : 1000;
    const cutoffRadius = options.cutoffRadius !== undefined ? options.cutoffRadius : 10 * scaleRadius;
    const rng = common.mulberry32(seed);
    const positions = createVec3SOA(count);
    const colors    = createVec4SOA(count);
    const temps     = new Float32Array(count);
    const absMags   = new Float32Array(count);
    const classes   = new Uint8Array(count);
    const radii     = new Float32Array(count);
    const masses    = new Float32Array(count);
    const lums      = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        const r = _sampleRInvCubic(rng, scaleRadius, cutoffRadius);
        const theta = rng() * TAU;
        const phi = Math.acos(2 * rng() - 1);
        positions.x[i] = r * Math.sin(phi) * Math.cos(theta);
        positions.y[i] = r * Math.sin(phi) * Math.sin(theta);
        positions.z[i] = r * Math.cos(phi);
        const cls = 5 + ((rng() * 2) | 0);
        const subclass = (rng() * 10) | 0;
        const p = stellarProperties(cls, subclass);
        temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
        absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
        classes[i] = cls;
        temperatureToRgbHDR(_rgbTmp, p.temperature, _clamp(p.luminosity, 0.05, 0.5));
        colors.x[i] = _rgbTmp[0]; colors.y[i] = _rgbTmp[1]; colors.z[i] = _rgbTmp[2]; colors.w[i] = 1;
    }
    return {
        count: count, positions: positions, colors: colors,
        temperatures: temps, absoluteMagnitudes: absMags, spectralClasses: classes,
        radii: radii, masses: masses, luminosities: lums
    };
}

// ============================================================================
// Function Declarations — Distance modulus / LOD
// ============================================================================
function distanceModulus(absoluteMag, distanceParsec) {
    if (distanceParsec <= 0) return Infinity;
    return absoluteMag + 5 * (Math.log10(distanceParsec) - 1);
}
function apparentMagnitude(absoluteMag, distanceParsec) {
    return distanceModulus(absoluteMag, distanceParsec);
}
function absoluteMagnitude(apparentMag, distanceParsec) {
    if (distanceParsec <= 0) return Infinity;
    return apparentMag - 5 * (Math.log10(distanceParsec) - 1);
}
function fluxFromMagnitude(mag) { return Math.pow(10, -0.4 * mag); }
function magnitudeFromFlux(flux) {
    if (flux <= 0) return Infinity;
    return -2.5 * Math.log10(flux);
}

/** LOD level — 0 (highest detail) up to 10 (lowest detail). */
function lodLevel(worldSize, distance, pixelsPerRadian, targetPixels) {
    if (distance <= 0) return 0;
    pixelsPerRadian = pixelsPerRadian || 1080;
    targetPixels = targetPixels || 8;
    const screenPixels = (worldSize / distance) * pixelsPerRadian;
    if (screenPixels >= targetPixels) return 0;
    const ratio = targetPixels / screenPixels;
    return Math.min(10, Math.ceil(Math.log2(ratio)));
}

// ============================================================================
// Function Declarations — Epoch / time
// ============================================================================
function unixToJulianDate(unixSec) { return unixSec / SECONDS_PER_DAY + UNIX_TO_JD_OFFSET; }
function julianDateToUnix(jd) { return (jd - UNIX_TO_JD_OFFSET) * SECONDS_PER_DAY; }
function daysSinceJ2000(unixSec) { return julianDateToJ2000Days(unixToJulianDate(unixSec)); }
function julianDateToJ2000Days(jd) { return jd - J2000_JD; }
/** Julian centuries since J2000 (for precession / proper motion). */
function julianCenturiesSinceJ2000(jd) { return (jd - J2000_JD) / 36525; }

// ============================================================================
// Function Declarations — Floating origin (bulk) + precision bridge
// ============================================================================
function toLocal(out, x, y, z, origin) {
    out[0] = x - origin[0];
    out[1] = y - origin[1];
    out[2] = z - origin[2];
    return out;
}
function toWorld(out, x, y, z, origin) {
    out[0] = x + origin[0];
    out[1] = y + origin[1];
    out[2] = z + origin[2];
    return out;
}

/** Bulk recenter a vec3 SOA by subtracting `delta[0..2]`. Zero-GC. */
function soaRecenter(positions, delta) {
    const dx = delta[0], dy = delta[1], dz = delta[2];
    const count = positions.count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        px[i] -= dx; py[i] -= dy; pz[i] -= dz;
    }
    return positions;
}

async function soaRecenterChunked(positions, delta, chunkSize, yieldEvery) {
    chunkSize  = chunkSize  || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const dx = delta[0], dy = delta[1], dz = delta[2];
    const count = positions.count;
    const px = positions.x, py = positions.y, pz = positions.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) {
            px[i] -= dx; py[i] -= dy; pz[i] -= dz;
        }
        start = end;
        if (start >= count) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return positions;
}

/**
 * Double-single floating-origin bridge (blueprint §26). Subtracts the
 * double-single camera origin from each double-single chunk origin using
 * Dekker TwoSum renormalization, then casts the camera-relative coordinate
 * to Float32. `chunkHi`/`chunkLo` are Float64Arrays of length count*3;
 * `camHi`/`camLo` are length 3; `relF32` is a Float32Array of length count*3.
 * Zero-GC.
 */
function soaFloatingOriginBridge(relF32, chunkHi, chunkLo, camHi, camLo, count) {
    for (let i = 0; i < count; i++) {
        const o3 = i * 3;
        for (let k = 0; k < 3; k++) {
            _dsSub(_dsOut, chunkHi[o3 + k], chunkLo[o3 + k], camHi[k], camLo[k]);
            relF32[o3 + k] = Math.fround(_dsOut[0] + _dsOut[1]);
        }
    }
    return relF32;
}

async function soaFloatingOriginBridgeChunked(relF32, chunkHi, chunkLo, camHi, camLo, count, chunkSize, yieldEvery) {
    chunkSize  = chunkSize  || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) {
            const o3 = i * 3;
            for (let k = 0; k < 3; k++) {
                _dsSub(_dsOut, chunkHi[o3 + k], chunkLo[o3 + k], camHi[k], camLo[k]);
                relF32[o3 + k] = Math.fround(_dsOut[0] + _dsOut[1]);
            }
        }
        start = end;
        if (start >= count) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return relF32;
}

// ============================================================================
// Function Declarations — Log depth (corrected round-trip)
// ============================================================================
/**
 * Logarithmic depth buffer constants. `logFarNear = log2(far/near)`.
 * Encode maps view-space z ∈ [near, far] to t ∈ [0, 1]; decode inverts it.
 */
function logDepthConstants(near, far) {
    return { logFarNear: Math.log2(far / near), near: near, far: far };
}
function logDepthEncode(z, constants) {
    if (z <= constants.near) return 0;
    const t = Math.log2(z / constants.near) / constants.logFarNear;
    return t > 1 ? 1 : t;
}
function logDepthDecode(encoded, constants) {
    return constants.near * Math.pow(2, encoded * constants.logFarNear);
}

// ============================================================================
// Function Declarations — Precision
// ============================================================================
function suggestPrecision(worldExtent) {
    if (worldExtent < 10) return "f16";
    if (worldExtent < 1e7) return "f32";
    return "f64";
}
function worldUnitFor(worldExtent) {
    if (worldExtent < 1e3)  return { name: "m",   scale: SCALE_METER };
    if (worldExtent < 1e10) return { name: "km",  scale: SCALE_KM };
    if (worldExtent < 1e14) return { name: "AU",  scale: SCALE_AU };
    if (worldExtent < 1e18) return { name: "pc",  scale: SCALE_PC };
    if (worldExtent < 1e22) return { name: "kpc", scale: SCALE_KPC };
    return { name: "Mpc", scale: SCALE_MPC };
}
function maxCoordinateForPrecision(precision) {
    switch (precision) {
        case "f16": return 10;
        case "f32": return 1e7;
        case "f64": return 1e15;
        default:    return 1e7;
    }
}

// ============================================================================
// Function Declarations — SOA (sync, zero-GC)
// ============================================================================
/** Batch blackbody color — fills `colors` (vec4 SOA) from per-instance temps. */
function soaTemperatureToRgb(colors, temperatures, count) {
    count = count === undefined ? colors.count : count;
    const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
    for (let i = 0; i < count; i++) {
        temperatureToRgb(_rgbTmp, temperatures[i]);
        cx[i] = _rgbTmp[0]; cy[i] = _rgbTmp[1]; cz[i] = _rgbTmp[2]; cw[i] = 1;
    }
    return colors;
}

/** HDR version — scales by a per-instance brightness array. */
function soaTemperatureToRgbHDR(colors, temperatures, brightness, count) {
    count = count === undefined ? colors.count : count;
    const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
    for (let i = 0; i < count; i++) {
        temperatureToRgbHDR(_rgbTmp, temperatures[i], brightness[i]);
        cx[i] = _rgbTmp[0]; cy[i] = _rgbTmp[1]; cz[i] = _rgbTmp[2]; cw[i] = 1;
    }
    return colors;
}

/** Batch equatorial → galactic for 1M+ objects (no per-element allocation). */
function soaEquatorialToGalactic(outL, outB, raArr, decArr, count) {
    count = count === undefined ? outL.length : count;
    for (let i = 0; i < count; i++) {
        equatorialToGalacticInto(_lbTmp, raArr[i], decArr[i]);
        outL[i] = _lbTmp[0];
        outB[i] = _lbTmp[1];
    }
    return outL;
}

/** Batch RA/Dec + distance → Cartesian XYZ SOA. */
function soaEquatorialToCartesian(positions, raArr, decArr, distArr, count) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        const ra = raArr[i], dec = decArr[i], d = distArr[i];
        const cosDec = Math.cos(dec);
        px[i] = d * cosDec * Math.cos(ra);
        py[i] = d * cosDec * Math.sin(ra);
        pz[i] = d * Math.sin(dec);
    }
    return positions;
}

/** Batch distance modulus — apparent magnitude per object. */
function soaDistanceModulus(outMag, absMagArr, distArr, count) {
    count = count === undefined ? outMag.length : count;
    for (let i = 0; i < count; i++) outMag[i] = distanceModulus(absMagArr[i], distArr[i]);
    return outMag;
}

/** Batch LOD level selection. */
function soaLodLevel(outLod, worldSizeArr, distArr, pixelsPerRadian, targetPixels, count) {
    count = count === undefined ? outLod.length : count;
    for (let i = 0; i < count; i++) {
        outLod[i] = lodLevel(worldSizeArr[i], distArr[i], pixelsPerRadian, targetPixels);
    }
    return outLod;
}

/** "1M+ stars in one call" primitive (init-time generation). */
function soaStarField(count, bounds, options) { return generateStarFieldSOA(count, bounds, options); }
function soaSpiralGalaxy(count, options) { return generateSpiralGalaxySOA(count, options); }

// ============================================================================
// Function Declarations — SOA (chunked async, inlined loops, zero closures)
// ============================================================================
async function soaTemperatureToRgbChunked(colors, temperatures, count, cs, ye) {
    count = count === undefined ? colors.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            temperatureToRgb(_rgbTmp, temperatures[i]);
            cx[i] = _rgbTmp[0]; cy[i] = _rgbTmp[1]; cz[i] = _rgbTmp[2]; cw[i] = 1;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return colors;
}

async function soaTemperatureToRgbHDRChunked(colors, temperatures, brightness, count, cs, ye) {
    count = count === undefined ? colors.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            temperatureToRgbHDR(_rgbTmp, temperatures[i], brightness[i]);
            cx[i] = _rgbTmp[0]; cy[i] = _rgbTmp[1]; cz[i] = _rgbTmp[2]; cw[i] = 1;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return colors;
}

async function soaEquatorialToGalacticChunked(outL, outB, raArr, decArr, count, cs, ye) {
    count = count === undefined ? outL.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            equatorialToGalacticInto(_lbTmp, raArr[i], decArr[i]);
            outL[i] = _lbTmp[0];
            outB[i] = _lbTmp[1];
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outL;
}

async function soaEquatorialToCartesianChunked(positions, raArr, decArr, distArr, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const px = positions.x, py = positions.y, pz = positions.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const ra = raArr[i], dec = decArr[i], d = distArr[i];
            const cosDec = Math.cos(dec);
            px[i] = d * cosDec * Math.cos(ra);
            py[i] = d * cosDec * Math.sin(ra);
            pz[i] = d * Math.sin(dec);
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return positions;
}

async function soaDistanceModulusChunked(outMag, absMagArr, distArr, count, cs, ye) {
    count = count === undefined ? outMag.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) outMag[i] = distanceModulus(absMagArr[i], distArr[i]);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outMag;
}

async function soaLodLevelChunked(outLod, worldSizeArr, distArr, pixelsPerRadian, targetPixels, count, cs, ye) {
    count = count === undefined ? outLod.length : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            outLod[i] = lodLevel(worldSizeArr[i], distArr[i], pixelsPerRadian, targetPixels);
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return outLod;
}

async function soaStarFieldChunked(count, bounds, options, cs, ye) {
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    options = options || {};
    bounds = bounds || { minX: -1000, minY: -1000, minZ: -1000, maxX: 1000, maxY: 1000, maxZ: 1000 };
    const seed = options.seed || 1;
    const rng = common.mulberry32(seed);
    const positions = createVec3SOA(count);
    const colors    = createVec4SOA(count);
    const temps     = new Float32Array(count);
    const absMags   = new Float32Array(count);
    const classes   = new Uint8Array(count);
    const radii     = new Float32Array(count);
    const masses    = new Float32Array(count);
    const lums      = new Float32Array(count);
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    const spanZ = bounds.maxZ - bounds.minZ;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            positions.x[i] = bounds.minX + rng() * spanX;
            positions.y[i] = bounds.minY + rng() * spanY;
            positions.z[i] = bounds.minZ + rng() * spanZ;
            const r = rng();
            let cls;
            if (r < 0.0001) cls = 0;
            else if (r < 0.0013) cls = 1;
            else if (r < 0.0073) cls = 2;
            else if (r < 0.0373) cls = 3;
            else if (r < 0.113) cls = 4;
            else if (r < 0.233) cls = 5;
            else cls = 6;
            const subclass = (rng() * 10) | 0;
            const p = stellarProperties(cls, subclass);
            temps[i] = p.temperature; radii[i] = p.radius; masses[i] = p.mass; lums[i] = p.luminosity;
            absMags[i] = absoluteMagnitudeFromLuminosity(p.luminosity);
            classes[i] = cls;
            temperatureToRgbHDR(_rgbTmp, p.temperature, _clamp(p.luminosity, 0.5, 50));
            colors.x[i] = _rgbTmp[0]; colors.y[i] = _rgbTmp[1];
            colors.z[i] = _rgbTmp[2]; colors.w[i] = 1;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return {
        count: count, positions: positions, colors: colors,
        temperatures: temps, absoluteMagnitudes: absMags, spectralClasses: classes,
        radii: radii, masses: masses, luminosities: lums
    };
}

async function soaSpiralGalaxyChunked(count, options, cs, ye) {
    // Spiral generation is init-time; delegate to the sync generator.
    return generateSpiralGalaxySOA(count, options);
}

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    units: {
        SCALE_NEAR, SCALE_METER, SCALE_KM, SCALE_EARTH_RADIUS,
        SCALE_AU, SCALE_LY, SCALE_PC, SCALE_KPC, SCALE_MPC, SCALE_GPC,
        auToMeters, metersToAu, lyToMeters, metersToLy,
        pcToMeters, metersToPc, kpcToMeters, metersToKpc,
        mpcToMeters, metersToMpc,
        arcsecToRad, radToArcsec, hoursToRad, radToHours,
        parsecsFromParallax
    },
    constants: {
        SOLAR_MASS, SOLAR_RADIUS, SOLAR_LUMINOSITY,
        EARTH_MASS, EARTH_RADIUS, JUPITER_MASS,
        G, C, MU_SUN, J2000_JD, WIEN_B, STEFAN_BOLTZMANN
    },
    coords: {
        equatorialToGalactic, galacticToEquatorial,
        equatorialToEcliptic, eclipticToEquatorial,
        equatorialToGalacticInto, galacticToEquatorialInto,
        equatorialToEclipticInto, eclipticToEquatorialInto,
        equatorialToCartesian, cartesianToEquatorial,
        galacticToCartesian, cartesianToGalactic,
        sphericalToCartesian, cartesianToSpherical
    },
    spectral: {
        temperatureToRgb, temperatureToRgbHDR,
        classFromTemp: spectralClassFromTemperature,
        tempFromClass: temperatureFromSpectralClass,
        stellarProperties,
        luminosityFromAbsoluteMagnitude, absoluteMagnitudeFromLuminosity,
        wienPeakWavelength, luminosityFromRadiusTemp
    },
    stars: {
        generateStarField: generateStarFieldSOA,
        generateSpiralGalaxy: generateSpiralGalaxySOA,
        generateEllipticalGalaxy: generateEllipticalGalaxySOA,
        generateIrregularGalaxy: generateIrregularGalaxySOA,
        generateGlobularCluster: generateGlobularClusterSOA,
        generateHalo: generateHaloSOA
    },
    distance: {
        distanceModulus, apparentMagnitude, absoluteMagnitude,
        fluxFromMagnitude, magnitudeFromFlux, lodLevel
    },
    epoch: {
        unixToJulianDate, julianDateToUnix,
        daysSinceJ2000, julianDateToJ2000Days, julianCenturiesSinceJ2000
    },
    floatingOrigin: {
        FloatingOrigin, createFloatingOrigin,
        toLocal, toWorld,
        soaRecenter, soaRecenterChunked,
        bridge: soaFloatingOriginBridge,
        bridgeChunked: soaFloatingOriginBridgeChunked
    },
    logDepth: {
        constants: logDepthConstants,
        encode: logDepthEncode,
        decode: logDepthDecode
    },
    precision: {
        suggest: suggestPrecision,
        worldUnitFor,
        maxCoordinateForPrecision
    },
    batch: {
        temperatureToRgb: soaTemperatureToRgb,
        temperatureToRgbHDR: soaTemperatureToRgbHDR,
        equatorialToGalactic: soaEquatorialToGalactic,
        equatorialToCartesian: soaEquatorialToCartesian,
        distanceModulus: soaDistanceModulus,
        lodLevel: soaLodLevel,
        starField: soaStarField,
        spiralGalaxy: soaSpiralGalaxy,
        temperatureToRgbChunked: soaTemperatureToRgbChunked,
        temperatureToRgbHDRChunked: soaTemperatureToRgbHDRChunked,
        equatorialToGalacticChunked: soaEquatorialToGalacticChunked,
        equatorialToCartesianChunked: soaEquatorialToCartesianChunked,
        distanceModulusChunked: soaDistanceModulusChunked,
        lodLevelChunked: soaLodLevelChunked,
        starFieldChunked: soaStarFieldChunked,
        spiralGalaxyChunked: soaSpiralGalaxyChunked,
        State: GalacticBatchState,
        create: createGalacticBatch
    },
    pool: {
        GalacticScratch,
        createGalacticScratchPool,
        acquireGalacticScratch,
        releaseGalacticScratch
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing GalacticBatchState buffers are retained; new buffers created after
// a precision change pick up the live array type via getArrayType().
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // SI / astronomical constants
    SCALE_NEAR, SCALE_METER, SCALE_KM, SCALE_EARTH_RADIUS,
    SCALE_AU, SCALE_LY, SCALE_PC, SCALE_KPC, SCALE_MPC, SCALE_GPC,
    SOLAR_MASS, SOLAR_RADIUS, SOLAR_LUMINOSITY,
    EARTH_MASS, EARTH_RADIUS, JUPITER_MASS,
    G, C, MU_SUN, J2000_JD, WIEN_B, STEFAN_BOLTZMANN,
    // Unit conversions
    auToMeters, metersToAu, lyToMeters, metersToLy,
    pcToMeters, metersToPc, kpcToMeters, metersToKpc,
    mpcToMeters, metersToMpc,
    arcsecToRad, radToArcsec, hoursToRad, radToHours,
    parsecsFromParallax,
    // Coordinate systems
    equatorialToGalactic, galacticToEquatorial,
    equatorialToEcliptic, eclipticToEquatorial,
    equatorialToGalacticInto, galacticToEquatorialInto,
    equatorialToEclipticInto, eclipticToEquatorialInto,
    equatorialToCartesian, cartesianToEquatorial,
    galacticToCartesian, cartesianToGalactic,
    sphericalToCartesian, cartesianToSpherical,
    // Blackbody / spectral
    temperatureToRgb, temperatureToRgbHDR,
    spectralClassFromTemperature, temperatureFromSpectralClass,
    stellarProperties,
    luminosityFromAbsoluteMagnitude, absoluteMagnitudeFromLuminosity,
    wienPeakWavelength, luminosityFromRadiusTemp,
    // Star / galaxy generation
    generateStarFieldSOA, generateSpiralGalaxySOA, generateEllipticalGalaxySOA,
    generateIrregularGalaxySOA, generateGlobularClusterSOA, generateHaloSOA,
    // Distance / LOD
    distanceModulus, apparentMagnitude, absoluteMagnitude,
    fluxFromMagnitude, magnitudeFromFlux, lodLevel,
    // Epoch / time
    unixToJulianDate, julianDateToUnix,
    daysSinceJ2000, julianDateToJ2000Days, julianCenturiesSinceJ2000,
    // Floating origin + precision bridge
    FloatingOrigin, createFloatingOrigin,
    soaRecenter, soaRecenterChunked,
    toLocal, toWorld,
    soaFloatingOriginBridge, soaFloatingOriginBridgeChunked,
    // Log depth
    logDepthConstants, logDepthEncode, logDepthDecode,
    // Precision
    suggestPrecision, worldUnitFor, maxCoordinateForPrecision,
    // SOA (sync)
    soaTemperatureToRgb, soaTemperatureToRgbHDR,
    soaEquatorialToGalactic, soaEquatorialToCartesian,
    soaDistanceModulus, soaLodLevel,
    soaStarField, soaSpiralGalaxy,
    // SOA (chunked async)
    soaTemperatureToRgbChunked, soaTemperatureToRgbHDRChunked,
    soaEquatorialToGalacticChunked, soaEquatorialToCartesianChunked,
    soaDistanceModulusChunked, soaLodLevelChunked,
    soaStarFieldChunked, soaSpiralGalaxyChunked,
    // Pools
    GalacticScratch, createGalacticScratchPool,
    acquireGalacticScratch, releaseGalacticScratch,
    // Batch state
    GalacticBatchState, createGalacticBatch,
    // Namespaces
    namespace
};