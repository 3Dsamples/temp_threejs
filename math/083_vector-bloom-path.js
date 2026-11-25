// File : src/math/083_vector-bloom-path.js
//description : Zero-GC SOA path layer for the Vector-Bloom procedural flora engine —
//              fixed-stride parallel-channel path storage (cmd + 9 coordinate channels),
//              allocation-free Canvas2D / WebGL / SVG emitters, an OPEN shape registry
//              (petals, sepals, leaves, grasses, stems, rings, polygons, stars, capsules)
//              built on 082's width-profile registry, JSON parameter normalisation with
//              alias tolerance for vector-bloom example files, path morphing, arc→cubic
//              flattening, Douglas-Peucker LOD simplification, bounds/length metrics and
//              chunked async variants. Every hot loop is closure-free and every long loop
//              has a yielding twin for Android 64-bit at 60/120 fps.
//best for : 3d graphics — 1M+ instanced petal/leaf/grass outline emission, JSON-driven
//           flower and foliage authoring, SVG export of procedural flora, Canvas2D
//           botanical illustration, WebGL triangle-fan fills and stroke ribbons for
//           foliage cards, LOD outline decimation for distant vegetation, petal-shape
//           morph targets for blooming animation, and grass-blade bend/curl deformation.
//license : MIT
// ============================================================================
// Directive Prologues
// ============================================================================

// ============================================================================
// Import (ES Modules — core math subsystem + point layer)
// ============================================================================
import {
    common,
    getArrayType,
    onPrecisionChange,
    trackSOA,
    untrackSOA
} from './000_Math_module.js';

import {
    PointSOA,
    createPointSOA,
    getPointProfile,
    hasPointProfile,
    listPointProfiles,
    sampleProfileOutline,
    sampleProfileBlade,
    soaPointCopy,
    soaPointTranslate,
    soaPointScale,
    soaPointRotate2D,
    soaPointMirrorX,
    soaPointBounds,
    TAU,
    HALF_PI,
    EPSILON
} from './082_vector-bloom-point.js';

// ============================================================================
// Global Declarations — command codes and constants
// ============================================================================
const CMD_MOVE  = 0;
const CMD_LINE  = 1;
const CMD_QUAD  = 2;
const CMD_CUBIC = 3;
const CMD_ARC   = 4;
const CMD_CLOSE = 5;

const FLAG_SUBPATH_START = 1;
const FLAG_LOD_KEEP      = 2;

const DEFAULT_SEGMENTS = 24;
const MAX_FLATTEN_STACK = 256;

// ============================================================================
// Variable Declarations — module scratch (init-time only)
// ============================================================================
const _arcScratch   = new Float64Array(8);   // cx, cy, rx, ry, rot, theta, dTheta, valid
const _flatScratch  = new Float64Array(3);
const _dpStack      = new Int32Array(MAX_FLATTEN_STACK);
const _svgChunks    = new Array(4096);       // reused serialisation buffer
let   _svgChunkLen  = 0;

// ============================================================================
// Function Declarations — internal hoisted helpers (closure-free)
// ============================================================================
function _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function _num(v, fallback) {
    return (typeof v === "number" && isFinite(v)) ? v : fallback;
}

/** First present numeric key from a list of aliases. */
function _pick(src, k0, k1, k2, k3, fallback) {
    if (src === null || src === undefined) return fallback;
    let v = src[k0];
    if (typeof v === "number" && isFinite(v)) return v;
    if (k1 !== undefined) { v = src[k1]; if (typeof v === "number" && isFinite(v)) return v; }
    if (k2 !== undefined) { v = src[k2]; if (typeof v === "number" && isFinite(v)) return v; }
    if (k3 !== undefined) { v = src[k3]; if (typeof v === "number" && isFinite(v)) return v; }
    return fallback;
}

function _pickStr(src, k0, k1, k2, fallback) {
    if (src === null || src === undefined) return fallback;
    let v = src[k0];
    if (typeof v === "string" && v.length > 0) return v;
    if (k1 !== undefined) { v = src[k1]; if (typeof v === "string" && v.length > 0) return v; }
    if (k2 !== undefined) { v = src[k2]; if (typeof v === "string" && v.length > 0) return v; }
    return fallback;
}

/**
 * SVG endpoint-arc → centre parameterisation. Writes into _arcScratch:
 * [0]=cx [1]=cy [2]=rx [3]=ry [4]=rot [5]=theta [6]=dTheta [7]=valid
 */
function _arcEndpointToCenter(x1, y1, rx, ry, rot, largeArc, sweep, x2, y2) {
    _arcScratch[7] = 0;
    if (rx === 0 || ry === 0) return _arcScratch;
    rx = Math.abs(rx); ry = Math.abs(ry);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const hx = (x1 - x2) * 0.5, hy = (y1 - y2) * 0.5;
    const x1p =  cr * hx + sr * hy;
    const y1p = -sr * hx + cr * hy;

    let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }

    const rx2 = rx * rx, ry2 = ry * ry;
    const x1p2 = x1p * x1p, y1p2 = y1p * y1p;
    let num = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2;
    let den = rx2 * y1p2 + ry2 * x1p2;
    if (den < 1e-20) return _arcScratch;
    let co = num / den;
    if (co < 0) co = 0;
    co = Math.sqrt(co);
    if ((largeArc ? 1 : 0) === (sweep ? 1 : 0)) co = -co;
    const cxp =  co * (rx * y1p) / ry;
    const cyp = -co * (ry * x1p) / rx;

    const cx = cr * cxp - sr * cyp + (x1 + x2) * 0.5;
    const cy = sr * cxp + cr * cyp + (y1 + y2) * 0.5;

    const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
    const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
    const theta = Math.atan2(uy, ux);
    let dTheta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    if (!sweep && dTheta > 0) dTheta -= TAU;
    if (sweep && dTheta < 0) dTheta += TAU;

    _arcScratch[0] = cx; _arcScratch[1] = cy;
    _arcScratch[2] = rx; _arcScratch[3] = ry;
    _arcScratch[4] = rot; _arcScratch[5] = theta;
    _arcScratch[6] = dTheta; _arcScratch[7] = 1;
    return _arcScratch;
}

// ============================================================================
// Class Declarations — PathSOA (fixed-stride parallel channels)
// ============================================================================
/**
 * PathSOA — one command per slot, nine parallel coordinate channels.
 *   MOVE / LINE : px,py,pz = endpoint
 *   QUAD        : c1 = control, px = endpoint
 *   CUBIC       : c1,c2 = controls, px = endpoint
 *   ARC         : c1x=rx c1y=ry c1z=rot, c2x=largeArc c2y=sweep, px=endpoint
 *   CLOSE       : no coordinates
 * `arrays` + `components` expose the buffer set for live precision migration.
 */
class PathSOA {
    constructor(capacity, Type) {
        const T = Type || getArrayType();
        this.capacity   = capacity || 64;
        this.count      = 0;
        this.components = 9;
        this.cmd   = new Uint8Array(this.capacity);
        this.flags = new Uint8Array(this.capacity);
        this.c1x = new T(this.capacity);
        this.c1y = new T(this.capacity);
        this.c1z = new T(this.capacity);
        this.c2x = new T(this.capacity);
        this.c2y = new T(this.capacity);
        this.c2z = new T(this.capacity);
        this.px  = new T(this.capacity);
        this.py  = new T(this.capacity);
        this.pz  = new T(this.capacity);
        this.arrays = [
            this.c1x, this.c1y, this.c1z,
            this.c2x, this.c2y, this.c2z,
            this.px,  this.py,  this.pz
        ];
        this._cursorX = 0; this._cursorY = 0; this._cursorZ = 0;
        this._startX  = 0; this._startY  = 0; this._startZ  = 0;
    }
    _ensure(n) {
        if (n <= this.capacity) return;
        let cap = this.capacity;
        while (cap < n) cap *= 2;
        this.resize(cap);
    }
    /** Grow-only resize; preserves existing commands and flags. */
    resize(n) {
        if (n <= this.capacity) return this;
        const T = this.c1x.constructor;
        const nc = new Uint8Array(n); nc.set(this.cmd);   this.cmd = nc;
        const nf = new Uint8Array(n); nf.set(this.flags); this.flags = nf;
        for (let i = 0; i < 9; i++) {
            const na = new T(n); na.set(this.arrays[i]); this.arrays[i] = na;
        }
        this.c1x = this.arrays[0]; this.c1y = this.arrays[1]; this.c1z = this.arrays[2];
        this.c2x = this.arrays[3]; this.c2y = this.arrays[4]; this.c2z = this.arrays[5];
        this.px  = this.arrays[6]; this.py  = this.arrays[7]; this.pz  = this.arrays[8];
        this.capacity = n;
        return this;
    }
    clear() {
        this.count = 0;
        this._cursorX = 0; this._cursorY = 0; this._cursorZ = 0;
        this._startX  = 0; this._startY  = 0; this._startZ  = 0;
        return this;
    }
    moveTo(x, y, z) {
        const i = this.count; this._ensure(i + 1);
        this.cmd[i] = CMD_MOVE; this.flags[i] = FLAG_SUBPATH_START | FLAG_LOD_KEEP;
        this.px[i] = x; this.py[i] = y; this.pz[i] = z === undefined ? 0 : z;
        this.count = i + 1;
        this._cursorX = x; this._cursorY = y; this._cursorZ = this.pz[i];
        this._startX = x;  this._startY = y; this._startZ = this.pz[i];
        return this;
    }
    lineTo(x, y, z) {
        const i = this.count; this._ensure(i + 1);
        this.cmd[i] = CMD_LINE; this.flags[i] = FLAG_LOD_KEEP;
        this.px[i] = x; this.py[i] = y; this.pz[i] = z === undefined ? 0 : z;
        this.count = i + 1;
        this._cursorX = x; this._cursorY = y; this._cursorZ = this.pz[i];
        return this;
    }
    quadTo(cx, cy, x, y, cz, z) {
        const i = this.count; this._ensure(i + 1);
        this.cmd[i] = CMD_QUAD; this.flags[i] = FLAG_LOD_KEEP;
        this.c1x[i] = cx; this.c1y[i] = cy; this.c1z[i] = cz === undefined ? 0 : cz;
        this.px[i] = x; this.py[i] = y; this.pz[i] = z === undefined ? 0 : z;
        this.count = i + 1;
        this._cursorX = x; this._cursorY = y; this._cursorZ = this.pz[i];
        return this;
    }
    cubicTo(c1x, c1y, c2x, c2y, x, y, c1z, c2z, z) {
        const i = this.count; this._ensure(i + 1);
        this.cmd[i] = CMD_CUBIC; this.flags[i] = FLAG_LOD_KEEP;
        this.c1x[i] = c1x; this.c1y[i] = c1y; this.c1z[i] = c1z === undefined ? 0 : c1z;
        this.c2x[i] = c2x; this.c2y[i] = c2y; this.c2z[i] = c2z === undefined ? 0 : c2z;
        this.px[i] = x; this.py[i] = y; this.pz[i] = z === undefined ? 0 : z;
        this.count = i + 1;
        this._cursorX = x; this._cursorY = y; this._cursorZ = this.pz[i];
        return this;
    }
    arcTo(rx, ry, rot, largeArc, sweep, x, y, z) {
        const i = this.count; this._ensure(i + 1);
        this.cmd[i] = CMD_ARC; this.flags[i] = FLAG_LOD_KEEP;
        this.c1x[i] = rx; this.c1y[i] = ry; this.c1z[i] = rot === undefined ? 0 : rot;
        this.c2x[i] = largeArc ? 1 : 0; this.c2y[i] = sweep ? 1 : 0; this.c2z[i] = 0;
        this.px[i] = x; this.py[i] = y; this.pz[i] = z === undefined ? 0 : z;
        this.count = i + 1;
        this._cursorX = x; this._cursorY = y; this._cursorZ = this.pz[i];
        return this;
    }
    close() {
        const i = this.count; this._ensure(i + 1);
        this.cmd[i] = CMD_CLOSE; this.flags[i] = FLAG_LOD_KEEP;
        this.count = i + 1;
        this._cursorX = this._startX; this._cursorY = this._startY; this._cursorZ = this._startZ;
        return this;
    }
    /** Append a polyline from a PointSOA (open or closed). */
    polyline(points, count, closed, offset) {
        const n = count === undefined ? points.count : count;
        const base = offset === undefined ? 0 : offset;
        if (n <= 0) return this;
        this.moveTo(points.x[base], points.y[base], points.z[base]);
        for (let i = 1; i < n; i++) {
            const o = base + i;
            this.lineTo(points.x[o], points.y[o], points.z[o]);
        }
        if (closed) this.close();
        return this;
    }
    track()   { trackSOA(this); return this; }
    untrack() { untrackSOA(this); return this; }
}

function createPath(capacity, Type) { return new PathSOA(capacity, Type); }

// ============================================================================
// Class Declarations — PathParams (JSON-normalised, reusable, zero-GC)
// ============================================================================
/**
 * PathParams — a fixed-shape parameter struct populated from vector-bloom
 * style JSON. Alias-tolerant so existing example files load unchanged.
 * Reuse one instance across many shapes to avoid per-shape allocation.
 */
class PathParams {
    constructor() { this.reset(); }
    reset() {
        this.shape = "petal";
        this.profile = "petal-ovate";
        this.count = 1;
        this.length = 1;
        this.width = 0.5;
        this.tipWidth = 0;
        this.baseWidth = 0;
        this.curl = 0;
        this.bend = 0;
        this.twist = 0;
        this.notch = 0;
        this.serration = 0;
        this.serrationFreq = 24;
        this.radius = 1;
        this.innerRadius = 0;
        this.startAngle = 0;
        this.endAngle = TAU;
        this.sweep = 1;
        this.segments = DEFAULT_SEGMENTS;
        this.sides = 6;
        this.offsetX = 0; this.offsetY = 0; this.offsetZ = 0;
        this.scaleX = 1; this.scaleY = 1; this.scaleZ = 1;
        this.rotation = 0;
        this.closed = true;
        this.reverse = false;
        this.mirror = false;
        return this;
    }
    /** Load from a JSON object (init / authoring time — never in a frame loop). */
    fromJSON(src) {
        this.reset();
        if (src === null || src === undefined) return this;
        this.shape   = _pickStr(src, "shape", "type", "kind", "petal");
        this.profile = _pickStr(src, "profile", "outline", "widthProfile", this.shape);
        if (!hasPointProfile(this.profile)) {
            this.profile = hasPointProfile(this.shape) ? this.shape : "petal-ovate";
        }
        this.count      = _pick(src, "count", "n", "copies", "petals", 1);
        this.length     = _pick(src, "length", "height", "size", "len", 1);
        this.width      = _pick(src, "width", "breadth", "w", 0.5);
        this.tipWidth   = _pick(src, "tipWidth", "apexWidth", undefined, undefined, 0);
        this.baseWidth  = _pick(src, "baseWidth", "clawWidth", undefined, undefined, 0);
        this.curl       = _pick(src, "curl", "cup", "curlZ", 0);
        this.bend       = _pick(src, "bend", "droop", "curve", 0);
        this.twist      = _pick(src, "twist", "roll", undefined, 0);
        this.notch      = _pick(src, "notch", "emargination", undefined, 0);
        this.serration  = _pick(src, "serration", "teeth", "toothDepth", 0);
        this.serrationFreq = _pick(src, "serrationFreq", "teethCount", undefined, undefined, 24);
        this.radius     = _pick(src, "radius", "r", "outerRadius", 1);
        this.innerRadius= _pick(src, "innerRadius", "r0", "hole", 0);
        this.startAngle = _pick(src, "startAngle", "a0", "from", 0);
        this.endAngle   = _pick(src, "endAngle", "a1", "to", TAU);
        this.sweep      = _pick(src, "sweep", "clockwise", undefined, 1);
        this.segments   = _pick(src, "segments", "resolution", "steps", DEFAULT_SEGMENTS) | 0;
        this.sides      = _pick(src, "sides", "points", "vertices", 6) | 0;
        this.offsetX    = _pick(src, "offsetX", "x", "dx", 0);
        this.offsetY    = _pick(src, "offsetY", "y", "dy", 0);
        this.offsetZ    = _pick(src, "offsetZ", "z", "dz", 0);
        this.scaleX     = _pick(src, "scaleX", "sx", undefined, 1);
        this.scaleY     = _pick(src, "scaleY", "sy", undefined, 1);
        this.scaleZ     = _pick(src, "scaleZ", "sz", undefined, 1);
        this.rotation   = _pick(src, "rotation", "angle", "rot", 0);
        const uni = _pick(src, "scale", "uniformScale", undefined, undefined, NaN);
        if (isFinite(uni)) { this.scaleX = uni; this.scaleY = uni; this.scaleZ = uni; }
        if (src.closed !== undefined) this.closed = !!src.closed;
        if (src.reverse !== undefined) this.reverse = !!src.reverse;
        if (src.mirror !== undefined) this.mirror = !!src.mirror;
        if (this.segments < 2) this.segments = 2;
        if (this.sides < 3) this.sides = 3;
        return this;
    }
}

function createPathParams() { return new PathParams(); }

// ============================================================================
// Shape registry — OPEN, extensible (plain object, no Map / Set)
// ============================================================================
const _shapeRegistry = Object.create(null);
const _shapeNames = [];

/**
 * Register a shape emitter. `fn(path, params, scratchPoints)` appends commands.
 * Add new leaves, grasses, bracts or florets at runtime without touching core.
 */
function registerPathShape(name, fn) {
    if (_shapeRegistry[name] === undefined) _shapeNames.push(name);
    _shapeRegistry[name] = fn;
    return fn;
}

function getPathShape(nameOrFn) {
    if (typeof nameOrFn === "function") return nameOrFn;
    const f = _shapeRegistry[String(nameOrFn || "petal")];
    return f === undefined ? _shapeRegistry["petal"] : f;
}

function hasPathShape(name) { return _shapeRegistry[name] !== undefined; }
function listPathShapes() { return _shapeNames; }

// ============================================================================
// Function Declarations — outline emission from width profiles
// ============================================================================
/**
 * Emit a mirrored closed outline driven by a 082 width profile, with
 * bend / curl / notch / serration deformation applied per sample.
 * Zero-GC: writes directly into path channels, no intermediate arrays.
 */
function emitProfileOutline(path, p) {
    const fn = getPointProfile(p.profile);
    const seg = p.segments < 2 ? 2 : p.segments;
    const inv = 1 / (seg - 1);
    const L = p.length * p.scaleY;
    const W = p.width * p.scaleX;
    const bend = p.bend, curl = p.curl, notch = p.notch;
    const serr = p.serration, serrF = p.serrationFreq;
    const ox = p.offsetX, oy = p.offsetY, oz = p.offsetZ;
    const cr = Math.cos(p.rotation), sr = Math.sin(p.rotation);
    const mir = p.mirror ? -1 : 1;

    // Right edge: base → tip.
    for (let i = 0; i < seg; i++) {
        const u = i * inv;
        fn(u, _flatScratch);
        let hw = _flatScratch[0] * W;
        let yy = _flatScratch[1] * L;
        let zz = _flatScratch[2] * L + curl * u * u * L;
        if (serr !== 0) hw *= 1 + serr * Math.sin(u * serrF);
        if (notch !== 0 && u > 0.86) {
            const k = (u - 0.86) / 0.14;
            yy -= notch * k * k * L;
        }
        const xx = hw * mir + bend * u * u * L;
        const rx = xx * cr - yy * sr + ox;
        const ry = xx * sr + yy * cr + oy;
        if (i === 0) path.moveTo(rx, ry, zz + oz);
        else path.lineTo(rx, ry, zz + oz);
    }
    // Left edge: tip → base.
    for (let i = 0; i < seg; i++) {
        const u = 1 - i * inv;
        fn(u, _flatScratch);
        let hw = _flatScratch[0] * W;
        let yy = _flatScratch[1] * L;
        let zz = _flatScratch[2] * L + curl * u * u * L;
        if (serr !== 0) hw *= 1 + serr * Math.sin(u * serrF);
        if (notch !== 0 && u > 0.86) {
            const k = (u - 0.86) / 0.14;
            yy -= notch * k * k * L;
        }
        const xx = -hw * mir + bend * u * u * L;
        const rx = xx * cr - yy * sr + ox;
        const ry = xx * sr + yy * cr + oy;
        path.lineTo(rx, ry, zz + oz);
    }
    if (p.closed) path.close();
    return path;
}

/** Emit a single-sided blade (grass / needle / filament) with bend and curl. */
function emitProfileBlade(path, p) {
    const fn = getPointProfile(p.profile);
    const seg = p.segments < 2 ? 2 : p.segments;
    const inv = 1 / (seg - 1);
    const L = p.length * p.scaleY;
    const W = p.width * p.scaleX;
    const bend = p.bend, curl = p.curl;
    const ox = p.offsetX, oy = p.offsetY, oz = p.offsetZ;
    const cr = Math.cos(p.rotation), sr = Math.sin(p.rotation);
    const mir = p.mirror ? -1 : 1;
    for (let i = 0; i < seg; i++) {
        const u = i * inv;
        fn(u, _flatScratch);
        const hw = _flatScratch[0] * W;
        const yy = _flatScratch[1] * L;
        const zz = _flatScratch[2] * L + curl * u * u * L;
        const xx = hw * mir + bend * u * u * L;
        const rx = xx * cr - yy * sr + ox;
        const ry = xx * sr + yy * cr + oy;
        if (i === 0) path.moveTo(rx, ry, zz + oz);
        else path.lineTo(rx, ry, zz + oz);
    }
    if (p.closed) path.close();
    return path;
}

// ============================================================================
// Built-in shape emitters (init-time registration)
// ============================================================================
registerPathShape("petal", emitProfileOutline);
registerPathShape("sepal", emitProfileOutline);
registerPathShape("bract", emitProfileOutline);
registerPathShape("leaf", emitProfileOutline);
registerPathShape("tepal", emitProfileOutline);
registerPathShape("floret", emitProfileOutline);
registerPathShape("grass", emitProfileBlade);
registerPathShape("blade", emitProfileBlade);
registerPathShape("needle", emitProfileBlade);
registerPathShape("filament", emitProfileBlade);
registerPathShape("stem", emitProfileBlade);
registerPathShape("tendril", emitProfileBlade);

/** Smooth closed petal via two cubic halves (fewer commands, SVG-friendly). */
registerPathShape("petal-smooth", function (path, p) {
    const L = p.length * p.scaleY;
    const W = p.width * p.scaleX;
    const ox = p.offsetX, oy = p.offsetY, oz = p.offsetZ;
    const cr = Math.cos(p.rotation), sr = Math.sin(p.rotation);
    const bend = p.bend * L;
    const curl = p.curl * L;
    const wide = 0.38;
    path.moveTo(ox, oy, oz);
    path.cubicTo(
        (W * 0.9) * cr - (L * 0.10) * sr + ox, (W * 0.9) * sr + (L * 0.10) * cr + oy,
        (W * wide * 2) * cr - (L * wide) * sr + ox + bend * 0.2,
        (W * wide * 2) * sr + (L * wide) * cr + oy,
        bend * cr - L * sr + ox, bend * sr + L * cr + oy,
        curl * 0.3, curl * 0.6, curl + oz
    );
    path.cubicTo(
        (-W * wide * 2) * cr - (L * wide) * sr + ox + bend * 0.2,
        (-W * wide * 2) * sr + (L * wide) * cr + oy,
        (-W * 0.9) * cr - (L * 0.10) * sr + ox, (-W * 0.9) * sr + (L * 0.10) * cr + oy,
        ox, oy, oz
    );
    path.close();
    return path;
});

/** Annulus / ring sector — petals whorl guides, pollen discs, UI dials. */
registerPathShape("ring", function (path, p) {
    const seg = p.segments < 8 ? 8 : p.segments;
    const r1 = p.radius * p.scaleX;
    const r0 = p.innerRadius * p.scaleX;
    const a0 = p.startAngle, a1 = p.endAngle;
    const ox = p.offsetX, oy = p.offsetY, oz = p.offsetZ;
    const step = (a1 - a0) / seg;
    for (let i = 0; i <= seg; i++) {
        const a = a0 + i * step;
        const x = Math.cos(a) * r1 + ox, y = Math.sin(a) * r1 + oy;
        if (i === 0) path.moveTo(x, y, oz); else path.lineTo(x, y, oz);
    }
    if (r0 > EPSILON) {
        for (let i = seg; i >= 0; i--) {
            const a = a0 + i * step;
            path.lineTo(Math.cos(a) * r0 + ox, Math.sin(a) * r0 + oy, oz);
        }
    }
    path.close();
    return path;
});

registerPathShape("disc", function (path, p) {
    const seg = p.segments < 8 ? 8 : p.segments;
    const r = p.radius * p.scaleX;
    const ox = p.offsetX, oy = p.offsetY, oz = p.offsetZ;
    const step = TAU / seg;
    for (let i = 0; i < seg; i++) {
        const a = i * step;
        const x = Math.cos(a) * r + ox, y = Math.sin(a) * r + oy;
        if (i === 0) path.moveTo(x, y, oz); else path.lineTo(x, y, oz);
    }
    path.close();
    return path;
});

registerPathShape("polygon", function (path, p) {
    const n = p.sides < 3 ? 3 : p.sides;
    const r = p.radius * p.scaleX;
    const ox = p.offsetX, oy = p.offsetY, oz = p.offsetZ;
    const step = TAU / n;
    const rot = p.rotation;
    for (let i = 0; i < n; i++) {
        const a = rot + i * step;
        const x = Math.cos(a) * r + ox, y = Math.sin(a) * r + oy;
        if (i === 0) path.moveTo(x, y, oz); else path.lineTo(x, y, oz);
    }
    path.close();
    return path;
});

registerPathShape("star", function (path, p) {
    const n = p.sides < 3 ? 3 : p.sides;
    const r1 = p.radius * p.scaleX;
    const r0 = p.innerRadius > 0 ? p.innerRadius * p.scaleX : r1 * 0.45;
    const ox = p.offsetX, oy = p.offsetY, oz = p.offsetZ;
    const step = TAU / (n * 2);
    const rot = p.rotation;
    for (let i = 0; i < n * 2; i++) {
        const a = rot + i * step;
        const r = (i & 1) === 0 ? r1 : r0;
        const x = Math.cos(a) * r + ox, y = Math.sin(a) * r + oy;
        if (i === 0) path.moveTo(x, y, oz); else path.lineTo(x, y, oz);
    }
    path.close();
    return path;
});

registerPathShape("capsule", function (path, p) {
    const L = p.length * p.scaleY;
    const W = p.width * p.scaleX;
    const ox = p.offsetX, oy = p.offsetY, oz = p.offsetZ;
    const hw = W * 0.5;
    path.moveTo(ox - hw, oy, oz);
    path.lineTo(ox - hw, oy + L, oz);
    path.arcTo(hw, hw, 0, 0, 1, ox + hw, oy + L, oz);
    path.lineTo(ox + hw, oy, oz);
    path.arcTo(hw, hw, 0, 0, 1, ox - hw, oy, oz);
    path.close();
    return path;
});

registerPathShape("teardrop", function (path, p) {
    const L = p.length * p.scaleY;
    const W = p.width * p.scaleX;
    const ox = p.offsetX, oy = p.offsetY, oz = p.offsetZ;
    path.moveTo(ox, oy, oz);
    path.cubicTo(ox + W, oy + L * 0.25, ox + W * 0.6, oy + L * 0.8, ox, oy + L, oz);
    path.cubicTo(ox - W * 0.6, oy + L * 0.8, ox - W, oy + L * 0.25, ox, oy, oz);
    path.close();
    return path;
});

registerPathShape("heart", function (path, p) {
    const L = p.length * p.scaleY;
    const W = p.width * p.scaleX;
    const ox = p.offsetX, oy = p.offsetY, oz = p.offsetZ;
    path.moveTo(ox, oy + L, oz);
    path.cubicTo(ox - W * 1.2, oy + L * 0.55, ox - W * 0.75, oy - L * 0.15, ox, oy + L * 0.22, oz);
    path.cubicTo(ox + W * 0.75, oy - L * 0.15, ox + W * 1.2, oy + L * 0.55, ox, oy + L, oz);
    path.close();
    return path;
});

/** Convenience aliases so JSON `"shape":"leaf-lanceolate"` resolves directly. */
(function _aliasProfileShapes() {
    const names = listPointProfiles();
    for (let i = 0; i < names.length; i++) {
        const n = names[i];
        if (hasPathShape(n)) continue;
        const isBlade = n.indexOf("grass") === 0 || n.indexOf("needle") === 0 || n.indexOf("stamen") === 0;
        registerPathShape(n, isBlade ? emitProfileBlade : emitProfileOutline);
    }
})();

// ============================================================================
// Function Declarations — shape construction entry points
// ============================================================================
/** Append a registered shape into `path` using a PathParams struct. */
function appendShape(path, params) {
    const fn = getPathShape(params.shape);
    fn(path, params, null);
    return path;
}

/** Build a fresh path from a PathParams struct. */
function buildShape(params, capacity) {
    const path = new PathSOA(capacity || 128);
    return appendShape(path, params);
}

/** Build directly from a JSON descriptor (authoring / load time). */
function buildShapeFromJSON(json, capacity, reusableParams) {
    const p = reusableParams || new PathParams();
    p.fromJSON(json);
    return buildShape(p, capacity);
}

/** Append `count` radially distributed copies of a shape (whorl / corolla). */
function appendWhorl(path, params, count, radius, phase) {
    const n = count === undefined ? params.count : count;
    if (n <= 0) return path;
    const r = radius === undefined ? 0 : radius;
    const ph = phase === undefined ? 0 : phase;
    const step = TAU / n;
    const baseOx = params.offsetX, baseOy = params.offsetY;
    const baseRot = params.rotation;
    for (let i = 0; i < n; i++) {
        const a = ph + i * step;
        params.rotation = baseRot + a;
        params.offsetX = baseOx + Math.cos(a) * r;
        params.offsetY = baseOy + Math.sin(a) * r;
        appendShape(path, params);
    }
    params.rotation = baseRot;
    params.offsetX = baseOx;
    params.offsetY = baseOy;
    return path;
}

// ============================================================================
// Function Declarations — path transforms (in-place, Zero-GC)
// ============================================================================
function pathTranslate(path, dx, dy, dz, count) {
    const n = count === undefined ? path.count : count;
    const zz = dz === undefined ? 0 : dz;
    for (let i = 0; i < n; i++) {
        const c = path.cmd[i];
        if (c === CMD_CLOSE) continue;
        path.px[i] += dx; path.py[i] += dy; path.pz[i] += zz;
        if (c === CMD_QUAD || c === CMD_CUBIC) {
            path.c1x[i] += dx; path.c1y[i] += dy; path.c1z[i] += zz;
        }
        if (c === CMD_CUBIC) {
            path.c2x[i] += dx; path.c2y[i] += dy; path.c2z[i] += zz;
        }
    }
    path._cursorX += dx; path._cursorY += dy; path._cursorZ += zz;
    path._startX  += dx; path._startY  += dy; path._startZ  += zz;
    return path;
}

function pathScale(path, sx, sy, sz, count) {
    const n = count === undefined ? path.count : count;
    const kx = sx, ky = sy === undefined ? sx : sy, kz = sz === undefined ? sx : sz;
    for (let i = 0; i < n; i++) {
        const c = path.cmd[i];
        if (c === CMD_CLOSE) continue;
        path.px[i] *= kx; path.py[i] *= ky; path.pz[i] *= kz;
        if (c === CMD_QUAD || c === CMD_CUBIC) {
            path.c1x[i] *= kx; path.c1y[i] *= ky; path.c1z[i] *= kz;
        }
        if (c === CMD_CUBIC) {
            path.c2x[i] *= kx; path.c2y[i] *= ky; path.c2z[i] *= kz;
        }
        if (c === CMD_ARC) { path.c1x[i] *= kx; path.c1y[i] *= ky; }
    }
    return path;
}

function pathRotate2D(path, angle, count) {
    const n = count === undefined ? path.count : count;
    const c = Math.cos(angle), s = Math.sin(angle);
    for (let i = 0; i < n; i++) {
        const k = path.cmd[i];
        if (k === CMD_CLOSE) continue;
        let x = path.px[i], y = path.py[i];
        path.px[i] = x * c - y * s; path.py[i] = x * s + y * c;
        if (k === CMD_QUAD || k === CMD_CUBIC) {
            x = path.c1x[i]; y = path.c1y[i];
            path.c1x[i] = x * c - y * s; path.c1y[i] = x * s + y * c;
        }
        if (k === CMD_CUBIC) {
            x = path.c2x[i]; y = path.c2y[i];
            path.c2x[i] = x * c - y * s; path.c2y[i] = x * s + y * c;
        }
        if (k === CMD_ARC) path.c1z[i] += angle;
    }
    return path;
}

function pathMirrorX(path, count) {
    const n = count === undefined ? path.count : count;
    for (let i = 0; i < n; i++) {
        const k = path.cmd[i];
        if (k === CMD_CLOSE) continue;
        path.px[i] = -path.px[i];
        if (k === CMD_QUAD || k === CMD_CUBIC) path.c1x[i] = -path.c1x[i];
        if (k === CMD_CUBIC) path.c2x[i] = -path.c2x[i];
        if (k === CMD_ARC) path.c2y[i] = path.c2y[i] === 0 ? 1 : 0;
    }
    return path;
}

function pathCopy(out, src, count) {
    const n = count === undefined ? src.count : count;
    out._ensure(n);
    for (let i = 0; i < n; i++) {
        out.cmd[i] = src.cmd[i];
        out.flags[i] = src.flags[i];
        for (let c = 0; c < 9; c++) out.arrays[c][i] = src.arrays[c][i];
    }
    out.count = n;
    out._cursorX = src._cursorX; out._cursorY = src._cursorY; out._cursorZ = src._cursorZ;
    out._startX  = src._startX;  out._startY  = src._startY;  out._startZ  = src._startZ;
    return out;
}

/** Reverse command order (winding flip) — keeps subpath semantics for simple paths. */
function pathReverse(out, src) {
    const n = src.count;
    out._ensure(n);
    // Flatten endpoints, then rebuild as a reversed polyline-preserving copy.
    let w = 0;
    for (let i = n - 1; i >= 0; i--) {
        const c = src.cmd[i];
        if (c === CMD_CLOSE) { out.cmd[w] = CMD_CLOSE; out.flags[w] = src.flags[i]; w++; continue; }
        out.cmd[w] = (i === n - 1) ? CMD_MOVE : CMD_LINE;
        out.flags[w] = src.flags[i];
        out.px[w] = src.px[i]; out.py[w] = src.py[i]; out.pz[w] = src.pz[i];
        w++;
    }
    out.count = w;
    return out;
}

// ============================================================================
// Function Declarations — metrics
// ============================================================================
/** Axis-aligned bounds over command endpoints and controls. out[0..5]. */
function pathBounds(out, path, count) {
    const n = count === undefined ? path.count : count;
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < n; i++) {
        const c = path.cmd[i];
        if (c === CMD_CLOSE) continue;
        const x = path.px[i], y = path.py[i], z = path.pz[i];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
        if (c === CMD_QUAD || c === CMD_CUBIC) {
            const ax = path.c1x[i], ay = path.c1y[i], az = path.c1z[i];
            if (ax < mnx) mnx = ax; if (ax > mxx) mxx = ax;
            if (ay < mny) mny = ay; if (ay > mxy) mxy = ay;
            if (az < mnz) mnz = az; if (az > mxz) mxz = az;
        }
        if (c === CMD_CUBIC) {
            const bx = path.c2x[i], by = path.c2y[i], bz = path.c2z[i];
            if (bx < mnx) mnx = bx; if (bx > mxx) mxx = bx;
            if (by < mny) mny = by; if (by > mxy) mxy = by;
            if (bz < mnz) mnz = bz; if (bz > mxz) mxz = bz;
        }
    }
    if (n === 0) { mnx = mny = mnz = 0; mxx = mxy = mxz = 0; }
    out[0] = mnx; out[1] = mny; out[2] = mnz;
    out[3] = mxx; out[4] = mxy; out[5] = mxz;
    return out;
}

/** Approximate arc length by flattening curves into `segments` chords each. */
function pathLength(path, segments, count) {
    const n = count === undefined ? path.count : count;
    const seg = segments === undefined ? 8 : (segments < 1 ? 1 : segments);
    const inv = 1 / seg;
    let total = 0;
    let cx = 0, cy = 0, cz = 0;
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < n; i++) {
        const c = path.cmd[i];
        const ex = path.px[i], ey = path.py[i], ez = path.pz[i];
        if (c === CMD_MOVE) { cx = ex; cy = ey; cz = ez; sx = ex; sy = ey; sz = ez; continue; }
        if (c === CMD_CLOSE) {
            const dx = sx - cx, dy = sy - cy, dz = sz - cz;
            total += Math.sqrt(dx * dx + dy * dy + dz * dz);
            cx = sx; cy = sy; cz = sz;
            continue;
        }
        if (c === CMD_LINE || c === CMD_ARC) {
            const dx = ex - cx, dy = ey - cy, dz = ez - cz;
            total += Math.sqrt(dx * dx + dy * dy + dz * dz);
        } else if (c === CMD_QUAD) {
            const ax = path.c1x[i], ay = path.c1y[i], az = path.c1z[i];
            let px0 = cx, py0 = cy, pz0 = cz;
            for (let k = 1; k <= seg; k++) {
                const t = k * inv, u = 1 - t;
                const w0 = u * u, w1 = 2 * u * t, w2 = t * t;
                const qx = w0 * cx + w1 * ax + w2 * ex;
                const qy = w0 * cy + w1 * ay + w2 * ey;
                const qz = w0 * cz + w1 * az + w2 * ez;
                const dx = qx - px0, dy = qy - py0, dz = qz - pz0;
                total += Math.sqrt(dx * dx + dy * dy + dz * dz);
                px0 = qx; py0 = qy; pz0 = qz;
            }
        } else if (c === CMD_CUBIC) {
            const ax = path.c1x[i], ay = path.c1y[i], az = path.c1z[i];
            const bx = path.c2x[i], by = path.c2y[i], bz = path.c2z[i];
            let px0 = cx, py0 = cy, pz0 = cz;
            for (let k = 1; k <= seg; k++) {
                const t = k * inv, u = 1 - t;
                const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
                const qx = w0 * cx + w1 * ax + w2 * bx + w3 * ex;
                const qy = w0 * cy + w1 * ay + w2 * by + w3 * ey;
                const qz = w0 * cz + w1 * az + w2 * bz + w3 * ez;
                const dx = qx - px0, dy = qy - py0, dz = qz - pz0;
                total += Math.sqrt(dx * dx + dy * dy + dz * dz);
                px0 = qx; py0 = qy; pz0 = qz;
            }
        }
        cx = ex; cy = ey; cz = ez;
    }
    return total;
}

// ============================================================================
// Function Declarations — flattening (curves → polyline, Zero-GC)
// ============================================================================
/**
 * Flatten a path into a PointSOA polyline. Curves are subdivided into
 * `segments` chords; arcs are converted via centre parameterisation.
 * Returns the number of points written.
 */
function flattenPath(outPoints, path, segments, count) {
    const n = count === undefined ? path.count : count;
    const seg = segments === undefined ? 12 : (segments < 1 ? 1 : segments);
    const inv = 1 / seg;
    let w = 0;
    let cx = 0, cy = 0, cz = 0;
    let sx = 0, sy = 0, sz = 0;
    outPoints._ensure ? outPoints._ensure(n * (seg + 1)) : outPoints.resize(n * (seg + 1));
    const ox = outPoints.x, oy = outPoints.y, oz = outPoints.z;
    for (let i = 0; i < n; i++) {
        const c = path.cmd[i];
        const ex = path.px[i], ey = path.py[i], ez = path.pz[i];
        if (c === CMD_MOVE) {
            ox[w] = ex; oy[w] = ey; oz[w] = ez; w++;
            cx = ex; cy = ey; cz = ez; sx = ex; sy = ey; sz = ez;
            continue;
        }
        if (c === CMD_CLOSE) {
            ox[w] = sx; oy[w] = sy; oz[w] = sz; w++;
            cx = sx; cy = sy; cz = sz;
            continue;
        }
        if (c === CMD_LINE) {
            ox[w] = ex; oy[w] = ey; oz[w] = ez; w++;
        } else if (c === CMD_QUAD) {
            const ax = path.c1x[i], ay = path.c1y[i], az = path.c1z[i];
            for (let k = 1; k <= seg; k++) {
                const t = k * inv, u = 1 - t;
                const w0 = u * u, w1 = 2 * u * t, w2 = t * t;
                ox[w] = w0 * cx + w1 * ax + w2 * ex;
                oy[w] = w0 * cy + w1 * ay + w2 * ey;
                oz[w] = w0 * cz + w1 * az + w2 * ez;
                w++;
            }
        } else if (c === CMD_CUBIC) {
            const ax = path.c1x[i], ay = path.c1y[i], az = path.c1z[i];
            const bx = path.c2x[i], by = path.c2y[i], bz = path.c2z[i];
            for (let k = 1; k <= seg; k++) {
                const t = k * inv, u = 1 - t;
                const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
                ox[w] = w0 * cx + w1 * ax + w2 * bx + w3 * ex;
                oy[w] = w0 * cy + w1 * ay + w2 * by + w3 * ey;
                oz[w] = w0 * cz + w1 * az + w2 * bz + w3 * ez;
                w++;
            }
        } else if (c === CMD_ARC) {
            _arcEndpointToCenter(cx, cy, path.c1x[i], path.c1y[i], path.c1z[i],
                                 path.c2x[i] !== 0, path.c2y[i] !== 0, ex, ey);
            if (_arcScratch[7] === 0) {
                ox[w] = ex; oy[w] = ey; oz[w] = ez; w++;
            } else {
                const acx = _arcScratch[0], acy = _arcScratch[1];
                const arx = _arcScratch[2], ary = _arcScratch[3];
                const rot = _arcScratch[4], th = _arcScratch[5], dth = _arcScratch[6];
                const acr = Math.cos(rot), asr = Math.sin(rot);
                for (let k = 1; k <= seg; k++) {
                    const a = th + dth * (k * inv);
                    const lx = Math.cos(a) * arx, ly = Math.sin(a) * ary;
                    ox[w] = acr * lx - asr * ly + acx;
                    oy[w] = asr * lx + acr * ly + acy;
                    oz[w] = cz + (ez - cz) * (k * inv);
                    w++;
                }
            }
        }
        cx = ex; cy = ey; cz = ez;
    }
    outPoints.count = w;
    return w;
}

// ============================================================================
// Function Declarations — LOD (decimation + Douglas-Peucker, Zero-GC)
// ============================================================================
/** Keep every `stride`-th command; MOVE/CLOSE always preserved. */
function decimatePath(out, src, stride, count) {
    const n = count === undefined ? src.count : count;
    const st = stride < 1 ? 1 : stride | 0;
    out._ensure(n);
    let w = 0;
    let kept = 0;
    for (let i = 0; i < n; i++) {
        const c = src.cmd[i];
        const keep = (c === CMD_MOVE || c === CMD_CLOSE) || (kept % st === 0) || (i === n - 1);
        kept++;
        if (!keep) continue;
        out.cmd[w] = src.cmd[i];
        out.flags[w] = src.flags[i];
        for (let k = 0; k < 9; k++) out.arrays[k][w] = src.arrays[k][i];
        w++;
    }
    out.count = w;
    return w;
}

/** Perpendicular distance from point `p` to segment a→b (2D, XY plane). */
function _perpDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-20) {
        const ex = px - ax, ey = py - ay;
        return Math.sqrt(ex * ex + ey * ey);
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = _clamp01(t);
    const qx = ax + dx * t - px, qy = ay + dy * t - py;
    return Math.sqrt(qx * qx + qy * qy);
}

/**
 * Douglas-Peucker simplification over flattened endpoints.
 * Iterative, preallocated stack — no recursion, no allocation.
 */
function simplifyPath(out, src, tolerance, count) {
    const n = count === undefined ? src.count : count;
    if (n <= 2) return pathCopy(out, src, n).count;
    out._ensure(n);
    const keep = _dpKeepScratch(n);
    for (let i = 0; i < n; i++) keep[i] = 0;
    keep[0] = 1; keep[n - 1] = 1;
    let sp = 0;
    _dpStack[sp++] = 0; _dpStack[sp++] = n - 1;
    while (sp > 1) {
        const hi = _dpStack[--sp];
        const lo = _dpStack[--sp];
        if (hi <= lo + 1) continue;
        const ax = src.px[lo], ay = src.py[lo];
        const bx = src.px[hi], by = src.py[hi];
        let worst = -1, worstD = -1;
        for (let i = lo + 1; i < hi; i++) {
            const d = _perpDist(src.px[i], src.py[i], ax, ay, bx, by);
            if (d > worstD) { worstD = d; worst = i; }
        }
        if (worstD > tolerance && worst > 0) {
            keep[worst] = 1;
            if (sp + 4 < MAX_FLATTEN_STACK) {
                _dpStack[sp++] = lo; _dpStack[sp++] = worst;
                _dpStack[sp++] = worst; _dpStack[sp++] = hi;
            }
        }
    }
    let w = 0;
    for (let i = 0; i < n; i++) {
        if (!keep[i] && src.cmd[i] !== CMD_MOVE && src.cmd[i] !== CMD_CLOSE) continue;
        out.cmd[w] = src.cmd[i];
        out.flags[w] = src.flags[i] | FLAG_LOD_KEEP;
        for (let k = 0; k < 9; k++) out.arrays[k][w] = src.arrays[k][i];
        w++;
    }
    out.count = w;
    return w;
}

let _dpKeep = null, _dpKeepCap = 0;
function _dpKeepScratch(n) {
    if (n > _dpKeepCap) { _dpKeep = new Uint8Array(n); _dpKeepCap = n; }
    return _dpKeep;
}

// ============================================================================
// Function Declarations — morphing
// ============================================================================
/**
 * Morph between two structurally compatible paths (same command sequence).
 * Returns 1 on success, 0 if the command streams differ (caller should
 * resample both to a common command count first).
 */
function morphPaths(out, a, b, t, count) {
    const n = count === undefined ? Math.min(a.count, b.count) : count;
    out._ensure(n);
    const u = 1 - t;
    for (let i = 0; i < n; i++) {
        if (a.cmd[i] !== b.cmd[i]) { out.count = i; return 0; }
        out.cmd[i] = a.cmd[i];
        out.flags[i] = a.flags[i];
        for (let k = 0; k < 9; k++) {
            out.arrays[k][i] = a.arrays[k][i] * u + b.arrays[k][i] * t;
        }
    }
    out.count = n;
    return 1;
}

/** Resample any path to exactly `targetCount` LINE commands (morph-ready). */
function resamplePath(out, src, targetCount, segments) {
    const pts = _resampleScratchPoints();
    const written = flattenPath(pts, src, segments === undefined ? 12 : segments);
    if (written < 2 || targetCount < 2) return pathCopy(out, src).count;
    out._ensure(targetCount + 1);
    out.clear();
    // Cumulative chord lengths for arc-length-uniform resampling.
    const cum = _resampleScratchCum(written);
    cum[0] = 0;
    for (let i = 1; i < written; i++) {
        const dx = pts.x[i] - pts.x[i - 1];
        const dy = pts.y[i] - pts.y[i - 1];
        const dz = pts.z[i] - pts.z[i - 1];
        cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const total = cum[written - 1];
    const inv = total > EPSILON ? 1 / total : 0;
    let seg = 0;
    for (let i = 0; i < targetCount; i++) {
        const target = (i / (targetCount - 1)) * total;
        while (seg < written - 2 && cum[seg + 1] < target) seg++;
        const span = cum[seg + 1] - cum[seg];
        const f = span > EPSILON ? (target - cum[seg]) / span : 0;
        const x = pts.x[seg] + (pts.x[seg + 1] - pts.x[seg]) * f;
        const y = pts.y[seg] + (pts.y[seg + 1] - pts.y[seg]) * f;
        const z = pts.z[seg] + (pts.z[seg + 1] - pts.z[seg]) * f;
        if (i === 0) out.moveTo(x, y, z); else out.lineTo(x, y, z);
    }
    out.close();
    return out.count;
}

let _rsPoints = null, _rsCum = null, _rsCumCap = 0;
function _resampleScratchPoints() {
    if (_rsPoints === null) _rsPoints = createPointSOA(1024);
    return _rsPoints;
}
function _resampleScratchCum(n) {
    if (n > _rsCumCap) { _rsCum = new Float64Array(n); _rsCumCap = n; }
    return _rsCum;
}

// ============================================================================
// Function Declarations — emitters (Canvas2D / WebGL / SVG)
// ============================================================================
/** Replay a path into a Canvas2D context. Zero allocation. */
function pathToCanvas2D(path, ctx, count) {
    const n = count === undefined ? path.count : count;
    ctx.beginPath();
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
        const c = path.cmd[i];
        if (c === CMD_MOVE) {
            cx = path.px[i]; cy = path.py[i];
            ctx.moveTo(cx, cy);
        } else if (c === CMD_LINE) {
            cx = path.px[i]; cy = path.py[i];
            ctx.lineTo(cx, cy);
        } else if (c === CMD_QUAD) {
            ctx.quadraticCurveTo(path.c1x[i], path.c1y[i], path.px[i], path.py[i]);
            cx = path.px[i]; cy = path.py[i];
        } else if (c === CMD_CUBIC) {
            ctx.bezierCurveTo(path.c1x[i], path.c1y[i], path.c2x[i], path.c2y[i], path.px[i], path.py[i]);
            cx = path.px[i]; cy = path.py[i];
        } else if (c === CMD_ARC) {
            _arcEndpointToCenter(cx, cy, path.c1x[i], path.c1y[i], path.c1z[i],
                                 path.c2x[i] !== 0, path.c2y[i] !== 0, path.px[i], path.py[i]);
            if (_arcScratch[7] !== 0 && ctx.ellipse) {
                ctx.ellipse(_arcScratch[0], _arcScratch[1], _arcScratch[2], _arcScratch[3],
                            _arcScratch[4], _arcScratch[5], _arcScratch[5] + _arcScratch[6],
                            _arcScratch[6] < 0);
            } else {
                ctx.lineTo(path.px[i], path.py[i]);
            }
            cx = path.px[i]; cy = path.py[i];
        } else if (c === CMD_CLOSE) {
            ctx.closePath();
        }
    }
    return n;
}

/**
 * Triangle-fan fill into an interleaved GPU vertex buffer (xyz per vertex).
 * Returns the vertex count written. Zero allocation.
 */
function pathToFillVertices(outVerts, path, segments, count) {
    const pts = _resampleScratchPoints();
    const n = flattenPath(pts, path, segments === undefined ? 12 : segments, count);
    if (n < 3) return 0;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += pts.x[i]; cy += pts.y[i]; cz += pts.z[i]; }
    const inv = 1 / n;
    cx *= inv; cy *= inv; cz *= inv;
    let w = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        outVerts[w++] = cx; outVerts[w++] = cy; outVerts[w++] = cz;
        outVerts[w++] = pts.x[i]; outVerts[w++] = pts.y[i]; outVerts[w++] = pts.z[i];
        outVerts[w++] = pts.x[j]; outVerts[w++] = pts.y[j]; outVerts[w++] = pts.z[j];
    }
    return w / 3;
}

/** Strict-SOA fill output — separate x/y/z channels instead of interleaved. */
function pathToFillVerticesSOA(outX, outY, outZ, path, segments, count) {
    const pts = _resampleScratchPoints();
    const n = flattenPath(pts, path, segments === undefined ? 12 : segments, count);
    if (n < 3) return 0;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += pts.x[i]; cy += pts.y[i]; cz += pts.z[i]; }
    const inv = 1 / n;
    cx *= inv; cy *= inv; cz *= inv;
    let w = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        outX[w] = cx;        outY[w] = cy;        outZ[w] = cz;        w++;
        outX[w] = pts.x[i];  outY[w] = pts.y[i];  outZ[w] = pts.z[i];  w++;
        outX[w] = pts.x[j];  outY[w] = pts.y[j];  outZ[w] = pts.z[j];  w++;
    }
    return w;
}

/** Camera-facing stroke ribbon (two triangles per segment) for foliage outlines. */
function pathToStrokeRibbon(outVerts, path, width, segments, count) {
    const pts = _resampleScratchPoints();
    const n = flattenPath(pts, path, segments === undefined ? 12 : segments, count);
    if (n < 2) return 0;
    const hw = width * 0.5;
    let w = 0;
    for (let i = 0; i < n - 1; i++) {
        let tx = pts.x[i + 1] - pts.x[i];
        let ty = pts.y[i + 1] - pts.y[i];
        const tl = Math.sqrt(tx * tx + ty * ty) || 1;
        tx /= tl; ty /= tl;
        const nx = -ty * hw, ny = tx * hw;
        const ax = pts.x[i] - nx,     ay = pts.y[i] - ny,     az = pts.z[i];
        const bx = pts.x[i] + nx,     by = pts.y[i] + ny,     bz = pts.z[i];
        const cx2 = pts.x[i + 1] - nx, cy2 = pts.y[i + 1] - ny, cz2 = pts.z[i + 1];
        const dx2 = pts.x[i + 1] + nx, dy2 = pts.y[i + 1] + ny, dz2 = pts.z[i + 1];
        outVerts[w++] = ax;  outVerts[w++] = ay;  outVerts[w++] = az;
        outVerts[w++] = bx;  outVerts[w++] = by;  outVerts[w++] = bz;
        outVerts[w++] = cx2; outVerts[w++] = cy2; outVerts[w++] = cz2;
        outVerts[w++] = cx2; outVerts[w++] = cy2; outVerts[w++] = cz2;
        outVerts[w++] = bx;  outVerts[w++] = by;  outVerts[w++] = bz;
        outVerts[w++] = dx2; outVerts[w++] = dy2; outVerts[w++] = dz2;
    }
    return w / 3;
}

/**
 * SVG serialisation. Uses a module-level reused chunk array and a single
 * join — string creation happens only at this serialisation boundary, never
 * inside a per-instance frame loop. Prefer Canvas2D / WebGL emitters at runtime.
 */
function pathToSVG(path, precision, count) {
    const n = count === undefined ? path.count : count;
    const p = precision === undefined ? 3 : precision;
    const f = Math.pow(10, p);
    _svgChunkLen = 0;
    for (let i = 0; i < n; i++) {
        if (_svgChunkLen >= _svgChunks.length) break;
        const c = path.cmd[i];
        const ex = Math.round(path.px[i] * f) / f;
        const ey = Math.round(path.py[i] * f) / f;
        if (c === CMD_MOVE) {
            _svgChunks[_svgChunkLen++] = "M" + ex + " " + ey;
        } else if (c === CMD_LINE) {
            _svgChunks[_svgChunkLen++] = "L" + ex + " " + ey;
        } else if (c === CMD_QUAD) {
            _svgChunks[_svgChunkLen++] = "Q" + (Math.round(path.c1x[i] * f) / f) + " " +
                (Math.round(path.c1y[i] * f) / f) + " " + ex + " " + ey;
        } else if (c === CMD_CUBIC) {
            _svgChunks[_svgChunkLen++] = "C" + (Math.round(path.c1x[i] * f) / f) + " " +
                (Math.round(path.c1y[i] * f) / f) + " " +
                (Math.round(path.c2x[i] * f) / f) + " " +
                (Math.round(path.c2y[i] * f) / f) + " " + ex + " " + ey;
        } else if (c === CMD_ARC) {
            _svgChunks[_svgChunkLen++] = "A" + (Math.round(path.c1x[i] * f) / f) + " " +
                (Math.round(path.c1y[i] * f) / f) + " " +
                (Math.round(path.c1z[i] * f) / f) + " " +
                (path.c2x[i] !== 0 ? 1 : 0) + " " + (path.c2y[i] !== 0 ? 1 : 0) + " " +
                ex + " " + ey;
        } else if (c === CMD_CLOSE) {
            _svgChunks[_svgChunkLen++] = "Z";
        }
    }
    let out = "";
    for (let i = 0; i < _svgChunkLen; i++) out += _svgChunks[i];
    return out;
}

// ============================================================================
// Function Declarations — SOA batch (sync)
// ============================================================================
/** Build `count` independent shapes into a flat command arena. */
function soaBuildShapes(arena, params, count, stride) {
    const st = stride === undefined ? arena.capacity : stride;
    arena._ensure(count * st);
    const fn = getPathShape(params.shape);
    const baseOx = params.offsetX, baseOy = params.offsetY, baseRot = params.rotation;
    for (let i = 0; i < count; i++) {
        const sub = _batchSubPath(st);
        sub.clear();
        fn(sub, params, null);
        const n = Math.min(sub.count, st);
        const off = i * st;
        for (let k = 0; k < n; k++) {
            arena.cmd[off + k] = sub.cmd[k];
            arena.flags[off + k] = sub.flags[k];
            for (let c = 0; c < 9; c++) arena.arrays[c][off + k] = sub.arrays[c][k];
        }
    }
    arena.count = count * st;
    params.offsetX = baseOx; params.offsetY = baseOy; params.rotation = baseRot;
    return count;
}

let _batchSub = null;
function _batchSubPath(capacity) {
    if (_batchSub === null || _batchSub.capacity < capacity) _batchSub = new PathSOA(capacity);
    return _batchSub;
}

/** Per-instance 2D rotation of an arena of fixed-stride subpaths. */
function soaPathRotate2D(arena, count, stride, angles) {
    const isArr = angles && angles.BYTES_PER_ELEMENT !== undefined;
    for (let i = 0; i < count; i++) {
        const a = isArr ? angles[i] : angles;
        const c = Math.cos(a), s = Math.sin(a);
        const off = i * stride;
        for (let k = 0; k < stride; k++) {
            const o = off + k;
            const cmd = arena.cmd[o];
            if (cmd === CMD_CLOSE) continue;
            let x = arena.px[o], y = arena.py[o];
            arena.px[o] = x * c - y * s; arena.py[o] = x * s + y * c;
            if (cmd === CMD_QUAD || cmd === CMD_CUBIC) {
                x = arena.c1x[o]; y = arena.c1y[o];
                arena.c1x[o] = x * c - y * s; arena.c1y[o] = x * s + y * c;
            }
            if (cmd === CMD_CUBIC) {
                x = arena.c2x[o]; y = arena.c2y[o];
                arena.c2x[o] = x * c - y * s; arena.c2y[o] = x * s + y * c;
            }
        }
    }
    return arena;
}

/** Per-instance translate + uniform scale of an arena (foliage placement). */
function soaPathPlace(arena, count, stride, xs, ys, zs, scales) {
    const sArr = scales && scales.BYTES_PER_ELEMENT !== undefined;
    const zArr = zs && zs.BYTES_PER_ELEMENT !== undefined;
    for (let i = 0; i < count; i++) {
        const dx = xs[i], dy = ys[i];
        const dz = zArr ? zs[i] : (zs === undefined ? 0 : zs);
        const sc = sArr ? scales[i] : (scales === undefined ? 1 : scales);
        const off = i * stride;
        for (let k = 0; k < stride; k++) {
            const o = off + k;
            const cmd = arena.cmd[o];
            if (cmd === CMD_CLOSE) continue;
            arena.px[o] = arena.px[o] * sc + dx;
            arena.py[o] = arena.py[o] * sc + dy;
            arena.pz[o] = arena.pz[o] * sc + dz;
            if (cmd === CMD_QUAD || cmd === CMD_CUBIC) {
                arena.c1x[o] = arena.c1x[o] * sc + dx;
                arena.c1y[o] = arena.c1y[o] * sc + dy;
                arena.c1z[o] = arena.c1z[o] * sc + dz;
            }
            if (cmd === CMD_CUBIC) {
                arena.c2x[o] = arena.c2x[o] * sc + dx;
                arena.c2y[o] = arena.c2y[o] * sc + dy;
                arena.c2z[o] = arena.c2z[o] * sc + dz;
            }
            if (cmd === CMD_ARC) { arena.c1x[o] *= sc; arena.c1y[o] *= sc; }
        }
    }
    return arena;
}

/** Batch morph between two matching arenas. */
function soaPathMorph(out, a, b, ts, count, stride) {
    const tArr = ts && ts.BYTES_PER_ELEMENT !== undefined;
    const total = count * stride;
    out._ensure(total);
    for (let i = 0; i < count; i++) {
        const t = tArr ? ts[i] : ts;
        const u = 1 - t;
        const off = i * stride;
        for (let k = 0; k < stride; k++) {
            const o = off + k;
            out.cmd[o] = a.cmd[o];
            out.flags[o] = a.flags[o];
            for (let c = 0; c < 9; c++) {
                out.arrays[c][o] = a.arrays[c][o] * u + b.arrays[c][o] * t;
            }
        }
    }
    out.count = total;
    return out;
}

/** Batch flatten every subpath into a GPU fill buffer. Returns vertex count. */
function soaPathToFillVertices(outVerts, arena, count, stride, segments) {
    const sub = _batchSubPath(stride);
    let w = 0;
    for (let i = 0; i < count; i++) {
        const off = i * stride;
        sub.clear();
        sub._ensure(stride);
        sub.count = stride;
        for (let k = 0; k < stride; k++) {
            sub.cmd[k] = arena.cmd[off + k];
            sub.flags[k] = arena.flags[off + k];
            for (let c = 0; c < 9; c++) sub.arrays[c][k] = arena.arrays[c][off + k];
        }
        const pts = _resampleScratchPoints();
        const n = flattenPath(pts, sub, segments === undefined ? 10 : segments);
        if (n < 3) continue;
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < n; k++) { cx += pts.x[k]; cy += pts.y[k]; cz += pts.z[k]; }
        const inv = 1 / n;
        cx *= inv; cy *= inv; cz *= inv;
        for (let k = 0; k < n; k++) {
            const j = (k + 1) % n;
            outVerts[w++] = cx; outVerts[w++] = cy; outVerts[w++] = cz;
            outVerts[w++] = pts.x[k]; outVerts[w++] = pts.y[k]; outVerts[w++] = pts.z[k];
            outVerts[w++] = pts.x[j]; outVerts[w++] = pts.y[j]; outVerts[w++] = pts.z[j];
        }
    }
    return w / 3;
}

// ============================================================================
// Function Declarations — SOA batch (chunked async, inlined, zero closures)
// ============================================================================
async function soaBuildShapesChunked(arena, params, count, stride, cs, ye) {
    const st = stride === undefined ? arena.capacity : stride;
    arena._ensure(count * st);
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const fn = getPathShape(params.shape);
    const sub = _batchSubPath(st);
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            sub.clear();
            fn(sub, params, null);
            const n = Math.min(sub.count, st);
            const off = i * st;
            for (let k = 0; k < n; k++) {
                arena.cmd[off + k] = sub.cmd[k];
                arena.flags[off + k] = sub.flags[k];
                for (let ch = 0; ch < 9; ch++) arena.arrays[ch][off + k] = sub.arrays[ch][k];
            }
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    arena.count = count * st;
    return count;
}

async function soaPathPlaceChunked(arena, count, stride, xs, ys, zs, scales, cs, ye) {
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const sArr = scales && scales.BYTES_PER_ELEMENT !== undefined;
    const zArr = zs && zs.BYTES_PER_ELEMENT !== undefined;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const dx = xs[i], dy = ys[i];
            const dz = zArr ? zs[i] : (zs === undefined ? 0 : zs);
            const sc = sArr ? scales[i] : (scales === undefined ? 1 : scales);
            const off = i * stride;
            for (let k = 0; k < stride; k++) {
                const o = off + k;
                const cmd = arena.cmd[o];
                if (cmd === CMD_CLOSE) continue;
                arena.px[o] = arena.px[o] * sc + dx;
                arena.py[o] = arena.py[o] * sc + dy;
                arena.pz[o] = arena.pz[o] * sc + dz;
                if (cmd === CMD_QUAD || cmd === CMD_CUBIC) {
                    arena.c1x[o] = arena.c1x[o] * sc + dx;
                    arena.c1y[o] = arena.c1y[o] * sc + dy;
                    arena.c1z[o] = arena.c1z[o] * sc + dz;
                }
                if (cmd === CMD_CUBIC) {
                    arena.c2x[o] = arena.c2x[o] * sc + dx;
                    arena.c2y[o] = arena.c2y[o] * sc + dy;
                    arena.c2z[o] = arena.c2z[o] * sc + dz;
                }
                if (cmd === CMD_ARC) { arena.c1x[o] *= sc; arena.c1y[o] *= sc; }
            }
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return arena;
}

async function soaPathToFillVerticesChunked(outVerts, arena, count, stride, segments, cs, ye) {
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const sub = _batchSubPath(stride);
    const seg = segments === undefined ? 10 : segments;
    let w = 0;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const off = i * stride;
            sub.clear();
            sub._ensure(stride);
            sub.count = stride;
            for (let k = 0; k < stride; k++) {
                sub.cmd[k] = arena.cmd[off + k];
                sub.flags[k] = arena.flags[off + k];
                for (let ch = 0; ch < 9; ch++) sub.arrays[ch][k] = arena.arrays[ch][off + k];
            }
            const pts = _resampleScratchPoints();
            const n = flattenPath(pts, sub, seg);
            if (n < 3) continue;
            let cx = 0, cy = 0, cz = 0;
            for (let k = 0; k < n; k++) { cx += pts.x[k]; cy += pts.y[k]; cz += pts.z[k]; }
            const inv = 1 / n;
            cx *= inv; cy *= inv; cz *= inv;
            for (let k = 0; k < n; k++) {
                const j = (k + 1) % n;
                outVerts[w++] = cx; outVerts[w++] = cy; outVerts[w++] = cz;
                outVerts[w++] = pts.x[k]; outVerts[w++] = pts.y[k]; outVerts[w++] = pts.z[k];
                outVerts[w++] = pts.x[j]; outVerts[w++] = pts.y[j]; outVerts[w++] = pts.z[j];
            }
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return w / 3;
}

// ============================================================================
// Class Declarations — PathBatchState
// ============================================================================
/**
 * PathBatchState — reusable per-frame path pipeline for 1M+ foliage instances.
 * Holds a template path, a command arena, placement channels and a GPU vertex
 * buffer. Re-create after setPrecision() to pick up the new array type.
 */
class PathBatchState {
    constructor(count, options) {
        options = options || {};
        this.count  = count;
        this.stride = options.stride || 64;
        this.params = new PathParams();
        this.template = new PathSOA(this.stride);
        this.arena    = new PathSOA(count * this.stride);
        this.scratchPoints = createPointSOA(this.stride * 16);
        this.bounds = new Float64Array(6);
        const T = getArrayType();
        this.x = new T(count);
        this.y = new T(count);
        this.z = new T(count);
        this.scale = new T(count);
        this.angle = new T(count);
        this.morphT = new T(count);
        this.scale.fill(1);
        this.vertices = new Float32Array(count * this.stride * 3 * 3);
    }
    loadJSON(json) {
        this.params.fromJSON(json);
        this.template.clear();
        appendShape(this.template, this.params);
        return this;
    }
    build() { return soaBuildShapes(this.arena, this.params, this.count, this.stride); }
    place() { return soaPathPlace(this.arena, this.count, this.stride, this.x, this.y, this.z, this.scale); }
    rotate() { return soaPathRotate2D(this.arena, this.count, this.stride, this.angle); }
    toVertices(segments) {
        return soaPathToFillVertices(this.vertices, this.arena, this.count, this.stride, segments);
    }
    async buildChunked(cs, ye) {
        return soaBuildShapesChunked(this.arena, this.params, this.count, this.stride, cs, ye);
    }
    async toVerticesChunked(segments, cs, ye) {
        return soaPathToFillVerticesChunked(this.vertices, this.arena, this.count, this.stride, segments, cs, ye);
    }
    getBounds() { return pathBounds(this.bounds, this.template); }
    reset() {
        this.template.clear();
        this.arena.clear();
        this.x.fill(0); this.y.fill(0); this.z.fill(0);
        this.scale.fill(1); this.angle.fill(0); this.morphT.fill(0);
        return this;
    }
}

function createPathBatch(count, options) { return new PathBatchState(count, options); }

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    core: {
        PathSOA, PathParams, PathBatchState,
        createPath, createPathParams, createPathBatch,
        CMD_MOVE, CMD_LINE, CMD_QUAD, CMD_CUBIC, CMD_ARC, CMD_CLOSE,
        FLAG_SUBPATH_START, FLAG_LOD_KEEP
    },
    shapes: {
        register: registerPathShape,
        get: getPathShape,
        has: hasPathShape,
        list: listPathShapes,
        append: appendShape,
        build: buildShape,
        fromJSON: buildShapeFromJSON,
        whorl: appendWhorl,
        emitOutline: emitProfileOutline,
        emitBlade: emitProfileBlade
    },
    transform: {
        translate: pathTranslate,
        scale: pathScale,
        rotate2D: pathRotate2D,
        mirrorX: pathMirrorX,
        copy: pathCopy,
        reverse: pathReverse
    },
    metrics: { bounds: pathBounds, length: pathLength },
    geometry: {
        flatten: flattenPath,
        decimate: decimatePath,
        simplify: simplifyPath,
        resample: resamplePath,
        morph: morphPaths
    },
    emit: {
        canvas2D: pathToCanvas2D,
        fillVertices: pathToFillVertices,
        fillVerticesSOA: pathToFillVerticesSOA,
        strokeRibbon: pathToStrokeRibbon,
        svg: pathToSVG
    },
    batch: {
        buildShapes: soaBuildShapes,
        buildShapesChunked: soaBuildShapesChunked,
        place: soaPathPlace,
        placeChunked: soaPathPlaceChunked,
        rotate2D: soaPathRotate2D,
        morph: soaPathMorph,
        fillVertices: soaPathToFillVertices,
        fillVerticesChunked: soaPathToFillVerticesChunked,
        State: PathBatchState,
        create: createPathBatch
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing buffers are retained (Zero-GC); paths created after a precision
// change pick up the live array type via getArrayType().
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Core
    PathSOA, PathParams, PathBatchState,
    createPath, createPathParams, createPathBatch,
    CMD_MOVE, CMD_LINE, CMD_QUAD, CMD_CUBIC, CMD_ARC, CMD_CLOSE,
    FLAG_SUBPATH_START, FLAG_LOD_KEEP,
    // Shape registry (extensible)
    registerPathShape, getPathShape, hasPathShape, listPathShapes,
    appendShape, buildShape, buildShapeFromJSON, appendWhorl,
    emitProfileOutline, emitProfileBlade,
    // Transforms
    pathTranslate, pathScale, pathRotate2D, pathMirrorX, pathCopy, pathReverse,
    // Metrics
    pathBounds, pathLength,
    // Geometry
    flattenPath, decimatePath, simplifyPath, resamplePath, morphPaths,
    // Emitters
    pathToCanvas2D, pathToFillVertices, pathToFillVerticesSOA,
    pathToStrokeRibbon, pathToSVG,
    // SOA (sync)
    soaBuildShapes, soaPathRotate2D, soaPathPlace, soaPathMorph, soaPathToFillVertices,
    // SOA (chunked async)
    soaBuildShapesChunked, soaPathPlaceChunked, soaPathToFillVerticesChunked,
    // Namespace
    namespace
};

// ============================================================================
// ▶ NEXT FILE: 084_vector-bloom.js
//   (JSON flower-description loader + layer/whorl compositor, open generator
//    registry for petals / sepals / leaves / grasses / stems / stamens,
//    schema validation with alias tolerance for vector-bloom example files,
//    SOA scene output, chunked async bloom growth, SVG + WebGL scene export.)
//   Reply "continue" to generate it.
// ============================================================================
