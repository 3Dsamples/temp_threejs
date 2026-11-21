// File : src/math/084_vector-bloom.js
//description : JSON-driven procedural flora compositor for the Vector-Bloom engine —
//              loads vector-bloom style flower/plant descriptors (alias-tolerant schema),
//              normalises them into a fully SOA layer spec, and composes 1M+ organ
//              instances (petals, sepals, stamens, pistils, bracts, leaves, grass blades,
//              stems, florets, catkins, umbels) into parallel-array scene buffers.
//              OPEN generator registry plus one-call `registerLeafType` / `registerGrassType`
//              hooks so new leaf and grass species plug into 082's width profiles, 083's
//              path shapes and 084's organ generators simultaneously. Includes radial /
//              phyllotaxis / opposite / alternate / whorled / spike / rosette / scatter
//              arrangements, deterministic per-instance jitter, bloom-open animation,
//              wind deformation, LOD tagging, SVG scene export, WebGL triangle emission
//              and instanced-matrix upload — every hot loop allocation-free with chunked
//              async twins yielding via scheduler.yield().
//best for : 3d graphics — JSON-authored flower and foliage libraries, 1M+ instance meadow
//           and undergrowth fields, instanced petal/leaf/grass cards for WebGL2 foliage,
//           blooming animation driven by a single open parameter, wind-driven vegetation
//           deformation, phyllotaxis seed heads and sunflower discs, LOD-tagged botanical
//           scenes, SVG botanical illustration export, and runtime-extensible plant
//           species packs on Android 64-bit at 60/120 fps.
//license : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — core math subsystem + point/path layers)
// ============================================================================
import {
    common,
    getArrayType,
    onPrecisionChange,
    trackSOA,
    untrackSOA
} from './000_Math_module.js';

import {
    createPointSOA,
    registerPointProfile,
    hasPointProfile,
    listPointProfiles,
    pointProfileKind,
    sampleProfileOutline,
    sampleProfileBlade,
    PROFILE_CLOSED,
    PROFILE_BLADE,
    TAU,
    HALF_PI,
    EPSILON,
    GOLDEN_ANGLE
} from './082_vector-bloom-point.js';

import {
    PathSOA,
    createPath,
    createPathParams,
    registerPathShape,
    hasPathShape,
    listPathShapes,
    appendShape,
    pathCopy,
    pathBounds,
    flattenPath,
    resamplePath,
    simplifyPath,
    CMD_MOVE,
    CMD_LINE,
    CMD_QUAD,
    CMD_CUBIC,
    CMD_ARC,
    CMD_CLOSE
} from './083_vector-bloom-path.js';

// ============================================================================
// Global Declarations — arrangement codes, flags, limits
// ============================================================================
const ARR_RADIAL      = 0;   // evenly spaced whorl around the axis
const ARR_PHYLLOTAXIS = 1;   // golden-angle spiral (seed heads, florets)
const ARR_OPPOSITE    = 2;   // paired organs along a stem
const ARR_ALTERNATE   = 3;   // single organ alternating along a stem
const ARR_WHORLED     = 4;   // N organs per node along a stem
const ARR_SPIKE       = 5;   // dense vertical spike (catkin, lavender)
const ARR_ROSETTE     = 6;   // basal flat rosette
const ARR_SCATTER     = 7;   // deterministic area scatter (grass field)
const ARR_RING        = 8;   // single ring at fixed radius (stamens)
const ARR_SINGLE      = 9;   // one central organ (pistil, stem)

const FLAG_CLOSED   = 1;
const FLAG_MIRROR   = 2;
const FLAG_VISIBLE  = 4;
const FLAG_BILLBOARD = 8;

const MAX_LAYERS_DEFAULT = 64;
const MAX_SPEC_CHANNEL   = 32;

// ============================================================================
// Variable Declarations — module scratch (init-time only)
// ============================================================================
const _hsv     = new Float64Array(3);
const _rgb     = new Float64Array(3);
const _bounds  = new Float64Array(6);
const _svgOut  = new Array(8192);
let   _svgLen  = 0;

// Shared composition context — reused across calls, never reallocated.
const _ctx = {
    seed: 1,
    open: 1,
    time: 0,
    wind: 0,
    windDir: 0,
    quality: 1,
    lodBias: 0,
    spread: 1,
    height: 1
};

// ============================================================================
// Function Declarations — internal hoisted helpers (closure-free)
// ============================================================================
function _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function _num(v, fallback) {
    return (typeof v === "number" && isFinite(v)) ? v : fallback;
}

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

function _pickBool(src, k0, k1, fallback) {
    if (src === null || src === undefined) return fallback;
    let v = src[k0];
    if (typeof v === "boolean") return v;
    if (k1 !== undefined) { v = src[k1]; if (typeof v === "boolean") return v; }
    return fallback;
}

/** Deterministic 3D integer hash → [0,1). No RNG state, stable across frames. */
function _hash01(x, y, z) {
    let h = (Math.imul(x | 0, 0x1B873593) ^ 0x9E3779B9) >>> 0;
    h = (Math.imul(h ^ (h >>> 16), 0x85EBCA6B) + Math.imul(y | 0, 0xCC9E2D51)) >>> 0;
    h = (Math.imul(h ^ (h >>> 13), 0xC2B2AE35) + Math.imul(z | 0, 0x85EBCA77)) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}

function _rgbToHsv(r, g, b, out) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const d = mx - mn;
    let h = 0;
    if (d > EPSILON) {
        if (mx === r)      h = ((g - b) / d) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else               h = (r - g) / d + 4;
        h /= 6;
        if (h < 0) h += 1;
    }
    out[0] = h;
    out[1] = mx > EPSILON ? d / mx : 0;
    out[2] = mx;
    return out;
}

function _hsvToRgb(h, s, v, out) {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
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

// Named colours resolved at load time only (plain object, init-time).
const _NAMED_COLORS = Object.create(null);
_NAMED_COLORS.white   = 0xffffff;
_NAMED_COLORS.black   = 0x000000;
_NAMED_COLORS.red     = 0xff0000;
_NAMED_COLORS.green   = 0x2e8b57;
_NAMED_COLORS.leaf    = 0x3f8f3a;
_NAMED_COLORS.grass   = 0x5a9e3f;
_NAMED_COLORS.stem    = 0x4a7c34;
_NAMED_COLORS.yellow  = 0xffd700;
_NAMED_COLORS.gold    = 0xffc125;
_NAMED_COLORS.orange  = 0xff8c00;
_NAMED_COLORS.pink    = 0xffb6c1;
_NAMED_COLORS.rose    = 0xe0446a;
_NAMED_COLORS.crimson = 0xdc143c;
_NAMED_COLORS.purple  = 0x8a2be2;
_NAMED_COLORS.violet  = 0x7f4fc9;
_NAMED_COLORS.blue    = 0x4169e1;
_NAMED_COLORS.cream   = 0xfff8dc;
_NAMED_COLORS.brown   = 0x8b5a2b;

/** Parse a colour into out[0..3] (rgba, 0..1). Load-time only. */
function parseColorInto(out, src, fallbackHex) {
    let r = 1, g = 1, b = 1, a = 1;
    if (typeof src === "number" && isFinite(src)) {
        r = ((src >> 16) & 255) / 255;
        g = ((src >> 8) & 255) / 255;
        b = (src & 255) / 255;
    } else if (typeof src === "string" && src.length > 0) {
        const s = src.trim().toLowerCase();
        if (s.charCodeAt(0) === 35) {
            const hex = parseInt(s.slice(1), 16);
            if (isFinite(hex)) {
                if (s.length === 4) {
                    r = (((hex >> 8) & 15) * 17) / 255;
                    g = (((hex >> 4) & 15) * 17) / 255;
                    b = ((hex & 15) * 17) / 255;
                } else {
                    r = ((hex >> 16) & 255) / 255;
                    g = ((hex >> 8) & 255) / 255;
                    b = (hex & 255) / 255;
                }
            }
        } else if (_NAMED_COLORS[s] !== undefined) {
            const hex = _NAMED_COLORS[s];
            r = ((hex >> 16) & 255) / 255;
            g = ((hex >> 8) & 255) / 255;
            b = (hex & 255) / 255;
        }
    } else if (src && typeof src === "object") {
        if (src.length !== undefined) {
            r = _num(src[0], 1); g = _num(src[1], 1); b = _num(src[2], 1);
            a = _num(src[3], 1);
        } else {
            r = _num(src.r, 1); g = _num(src.g, 1); b = _num(src.b, 1);
            a = _num(src.a, 1);
        }
    } else if (fallbackHex !== undefined) {
        r = ((fallbackHex >> 16) & 255) / 255;
        g = ((fallbackHex >> 8) & 255) / 255;
        b = (fallbackHex & 255) / 255;
    }
    out[0] = r; out[1] = g; out[2] = b; out[3] = a;
    return out;
}

const _colorTmp = new Float64Array(4);

// ============================================================================
// Registry — organ generators (OPEN, plain object, no Map / Set)
// ============================================================================
const _generatorRegistry = Object.create(null);
const _generatorNames = [];
const _generatorIds = Object.create(null);

function registerBloomGenerator(name, fn) {
    if (_generatorRegistry[name] === undefined) {
        _generatorIds[name] = _generatorNames.length;
        _generatorNames.push(name);
    }
    _generatorRegistry[name] = fn;
    return fn;
}

function getBloomGenerator(nameOrFn) {
    if (typeof nameOrFn === "function") return nameOrFn;
    const f = _generatorRegistry[String(nameOrFn || "petal-whorl")];
    return f === undefined ? _generatorRegistry["petal-whorl"] : f;
}

function generatorId(name) {
    const id = _generatorIds[name];
    return id === undefined ? 0 : id;
}

function generatorName(id) {
    return _generatorNames[id] === undefined ? "petal-whorl" : _generatorNames[id];
}

function hasBloomGenerator(name) { return _generatorRegistry[name] !== undefined; }
function listBloomGenerators() { return _generatorNames; }

// Shape / profile name → integer id maps for SOA storage (load-time growth).
const _shapeIdByName = Object.create(null);
const _shapeNameById = [];
const _profileIdByName = Object.create(null);
const _profileNameById = [];

function shapeIdOf(name) {
    let id = _shapeIdByName[name];
    if (id === undefined) {
        id = _shapeNameById.length;
        _shapeNameById.push(name);
        _shapeIdByName[name] = id;
    }
    return id;
}

function shapeNameOf(id) {
    return _shapeNameById[id] === undefined ? "petal" : _shapeNameById[id];
}

function profileIdOf(name) {
    let id = _profileIdByName[name];
    if (id === undefined) {
        id = _profileNameById.length;
        _profileNameById.push(name);
        _profileIdByName[name] = id;
    }
    return id;
}

function profileNameOf(id) {
    return _profileNameById[id] === undefined ? "petal-ovate" : _profileNameById[id];
}

// ============================================================================
// Class Declarations — BloomSpecSOA (normalised JSON, fully SOA)
// ============================================================================
/**
 * BloomSpecSOA — one parallel channel per layer parameter. JSON descriptors
 * are normalised into these typed arrays at load time so the composition hot
 * loop reads only contiguous numeric channels (no string keys, no objects).
 */
class BloomSpecSOA {
    constructor(maxLayers) {
        this.capacity = maxLayers || MAX_LAYERS_DEFAULT;
        this.layerCount = 0;
        this.name = "";
        this.seed = 1;
        const c = this.capacity;
        this.generator   = new Uint16Array(c);
        this.shapeId     = new Uint16Array(c);
        this.profileId   = new Uint16Array(c);
        this.arrangement = new Uint8Array(c);
        this.flags       = new Uint8Array(c);
        this.count       = new Uint32Array(c);
        this.segments    = new Uint16Array(c);
        this.radius      = new Float32Array(c);
        this.length      = new Float32Array(c);
        this.width       = new Float32Array(c);
        this.tipWidth    = new Float32Array(c);
        this.baseWidth   = new Float32Array(c);
        this.phase       = new Float32Array(c);
        this.rotation    = new Float32Array(c);
        this.tiltClosed  = new Float32Array(c);
        this.tiltOpen    = new Float32Array(c);
        this.scaleClosed = new Float32Array(c);
        this.curl        = new Float32Array(c);
        this.bend        = new Float32Array(c);
        this.twist       = new Float32Array(c);
        this.serration   = new Float32Array(c);
        this.notch       = new Float32Array(c);
        this.zOffset     = new Float32Array(c);
        this.span        = new Float32Array(c);
        this.spread      = new Float32Array(c);
        this.angleJitter = new Float32Array(c);
        this.scaleJitter = new Float32Array(c);
        this.lengthJitter= new Float32Array(c);
        this.hueJitter   = new Float32Array(c);
        this.satJitter   = new Float32Array(c);
        this.valJitter   = new Float32Array(c);
        this.r = new Float32Array(c);
        this.g = new Float32Array(c);
        this.b = new Float32Array(c);
        this.a = new Float32Array(c);
        this.arrays = [
            this.radius, this.length, this.width, this.tipWidth, this.baseWidth,
            this.phase, this.rotation, this.tiltClosed, this.tiltOpen, this.scaleClosed,
            this.curl, this.bend, this.twist, this.serration, this.notch,
            this.zOffset, this.span, this.spread,
            this.angleJitter, this.scaleJitter, this.lengthJitter,
            this.hueJitter, this.satJitter, this.valJitter,
            this.r, this.g, this.b, this.a
        ];
        this.components = this.arrays.length;
    }
    reset() {
        this.layerCount = 0;
        for (let i = 0; i < this.components; i++) this.arrays[i].fill(0);
        this.generator.fill(0);
        this.shapeId.fill(0);
        this.profileId.fill(0);
        this.arrangement.fill(0);
        this.flags.fill(0);
        this.count.fill(0);
        this.segments.fill(0);
        return this;
    }
    /** Total instance count across all layers. */
    totalInstances() {
        let n = 0;
        for (let i = 0; i < this.layerCount; i++) n += this.count[i];
        return n;
    }
}

function createBloomSpec(maxLayers) { return new BloomSpecSOA(maxLayers); }

// ============================================================================
// Class Declarations — BloomSceneSOA (composed instances, fully SOA)
// ============================================================================
/**
 * BloomSceneSOA — parallel channels for every composed organ instance.
 * `rest*` channels hold the authored pose; `tilt`, `openScale`, `windBend`
 * are animated channels updated in place without touching the rest pose.
 */
class BloomSceneSOA {
    constructor(capacity) {
        this.capacity = capacity || 1024;
        this.count = 0;
        const T = getArrayType();
        const c = this.capacity;
        this.x = new T(c); this.y = new T(c); this.z = new T(c);
        this.rotation = new T(c);
        this.scaleX = new T(c); this.scaleY = new T(c); this.scaleZ = new T(c);
        this.curl = new T(c); this.bend = new T(c); this.twist = new T(c);
        this.tilt = new T(c);
        this.openScale = new T(c);
        this.windBend = new T(c);
        this.windPhase = new T(c);
        this.r = new T(c); this.g = new T(c); this.b = new T(c); this.a = new T(c);
        this.layer     = new Uint16Array(c);
        this.shapeId   = new Uint16Array(c);
        this.profileId = new Uint16Array(c);
        this.lod       = new Uint8Array(c);
        this.flags     = new Uint8Array(c);
        this.seed      = new Uint32Array(c);
        this.pathOffset = new Uint32Array(c);
        this.pathCount  = new Uint32Array(c);
        this.tiltClosed = new T(c);
        this.tiltOpen   = new T(c);
        this.scaleClosed= new T(c);
        this.arrays = [
            this.x, this.y, this.z, this.rotation,
            this.scaleX, this.scaleY, this.scaleZ,
            this.curl, this.bend, this.twist,
            this.tilt, this.openScale, this.windBend, this.windPhase,
            this.r, this.g, this.b, this.a,
            this.tiltClosed, this.tiltOpen, this.scaleClosed
        ];
        this.components = this.arrays.length;
        this.openScale.fill(1);
        this.bounds = new Float64Array(6);
    }
    resize(n) {
        if (n <= this.capacity) return this;
        const T = this.x.constructor;
        for (let i = 0; i < this.components; i++) {
            const na = new T(n); na.set(this.arrays[i]); this.arrays[i] = na;
        }
        this.x = this.arrays[0]; this.y = this.arrays[1]; this.z = this.arrays[2];
        this.rotation = this.arrays[3];
        this.scaleX = this.arrays[4]; this.scaleY = this.arrays[5]; this.scaleZ = this.arrays[6];
        this.curl = this.arrays[7]; this.bend = this.arrays[8]; this.twist = this.arrays[9];
        this.tilt = this.arrays[10]; this.openScale = this.arrays[11];
        this.windBend = this.arrays[12]; this.windPhase = this.arrays[13];
        this.r = this.arrays[14]; this.g = this.arrays[15];
        this.b = this.arrays[16]; this.a = this.arrays[17];
        this.tiltClosed = this.arrays[18]; this.tiltOpen = this.arrays[19];
        this.scaleClosed = this.arrays[20];
        const growU16 = (a) => { const o = new Uint16Array(n); o.set(a); return o; };
        const growU8  = (a) => { const o = new Uint8Array(n);  o.set(a); return o; };
        const growU32 = (a) => { const o = new Uint32Array(n); o.set(a); return o; };
        this.layer = growU16(this.layer);
        this.shapeId = growU16(this.shapeId);
        this.profileId = growU16(this.profileId);
        this.lod = growU8(this.lod);
        this.flags = growU8(this.flags);
        this.seed = growU32(this.seed);
        this.pathOffset = growU32(this.pathOffset);
        this.pathCount = growU32(this.pathCount);
        this.capacity = n;
        return this;
    }
    clear() {
        this.count = 0;
        this.openScale.fill(1);
        this.tilt.fill(0);
        this.windBend.fill(0);
        return this;
    }
    track()   { trackSOA(this); return this; }
    untrack() { untrackSOA(this); return this; }
}

function createBloomScene(capacity) { return new BloomSceneSOA(capacity); }

// ============================================================================
// Function Declarations — JSON schema normalisation (load-time)
// ============================================================================
const _ARRANGEMENT_BY_NAME = Object.create(null);
_arrangement_BY_ALIAS();
function _arrangement_BY_ALIAS() {
    _ARRANGEMENT_BY_NAME.radial = ARR_RADIAL;
    _ARRANGEMENT_BY_NAME.whorl = ARR_RADIAL;
    _ARRANGEMENT_BY_NAME.phyllotaxis = ARR_PHYLLOTAXIS;
    _ARRANGEMENT_BY_NAME.spiral = ARR_PHYLLOTAXIS;
    _ARRANGEMENT_BY_NAME.fibonacci = ARR_PHYLLOTAXIS;
    _ARRANGEMENT_BY_NAME.opposite = ARR_OPPOSITE;
    _ARRANGEMENT_BY_NAME.alternate = ARR_ALTERNATE;
    _ARRANGEMENT_BY_NAME.whorled = ARR_WHORLED;
    _ARRANGEMENT_BY_NAME.spike = ARR_SPIKE;
    _ARRANGEMENT_BY_NAME.catkin = ARR_SPIKE;
    _ARRANGEMENT_BY_NAME.rosette = ARR_ROSETTE;
    _ARRANGEMENT_BY_NAME.scatter = ARR_SCATTER;
    _ARRANGEMENT_BY_NAME.field = ARR_SCATTER;
    _ARRANGEMENT_BY_NAME.ring = ARR_RING;
    _ARRANGEMENT_BY_NAME.single = ARR_SINGLE;
    _ARRANGEMENT_BY_NAME.center = ARR_SINGLE;
}

function _arrangementOf(src, fallback) {
    const s = _pickStr(src, "arrangement", "layout", "mode", "");
    if (s.length === 0) return fallback;
    const v = _ARRANGEMENT_BY_NAME[s.toLowerCase()];
    return v === undefined ? fallback : v;
}

/** Normalise one JSON layer object into spec channels at index `li`. */
function _loadLayer(spec, li, src, inheritedSeed) {
    const kind = _pickStr(src, "kind", "organ", "type", "petal");
    let genName = _pickStr(src, "generator", "generatorName", "", "");
    if (genName.length === 0) {
        genName = hasBloomGenerator(kind) ? kind : _defaultGeneratorFor(kind);
    }
    const shape = _pickStr(src, "shape", "path", "outline", kind);
    let profile = _pickStr(src, "profile", "widthProfile", "blade", shape);
    if (!hasPointProfile(profile)) {
        profile = hasPointProfile(shape) ? shape
                : (hasPointProfile(kind) ? kind : "petal-ovate");
    }

    spec.generator[li]   = generatorId(genName);
    spec.shapeId[li]     = shapeIdOf(hasPathShape(shape) ? shape : "petal");
    spec.profileId[li]   = profileIdOf(profile);
    spec.arrangement[li] = _arrangementOf(src, _defaultArrangementFor(genName));
    spec.count[li]       = Math.max(0, _pick(src, "count", "n", "copies", "instances", 1) | 0);
    spec.segments[li]    = Math.max(2, _pick(src, "segments", "resolution", "steps", 24) | 0);

    spec.radius[li]      = _pick(src, "radius", "r", "offset", 0);
    spec.length[li]      = _pick(src, "length", "height", "size", "len", 1);
    spec.width[li]       = _pick(src, "width", "breadth", "w", 0.5);
    spec.tipWidth[li]    = _pick(src, "tipWidth", "apexWidth", undefined, undefined, 0);
    spec.baseWidth[li]   = _pick(src, "baseWidth", "clawWidth", undefined, undefined, 0);
    spec.phase[li]       = _pick(src, "phase", "startAngle", "offsetAngle", 0);
    spec.rotation[li]    = _pick(src, "rotation", "angle", "rot", 0);
    spec.tiltClosed[li]  = _pick(src, "tiltClosed", "closedTilt", undefined, undefined, 1.35);
    spec.tiltOpen[li]    = _pick(src, "tiltOpen", "openTilt", "tilt", 0.28);
    spec.scaleClosed[li] = _pick(src, "scaleClosed", "closedScale", undefined, undefined, 0.22);
    spec.curl[li]        = _pick(src, "curl", "cup", "curlZ", 0);
    spec.bend[li]        = _pick(src, "bend", "droop", "curve", 0);
    spec.twist[li]       = _pick(src, "twist", "roll", undefined, 0);
    spec.serration[li]   = _pick(src, "serration", "teeth", "toothDepth", 0);
    spec.notch[li]       = _pick(src, "notch", "emargination", undefined, 0);
    spec.zOffset[li]     = _pick(src, "zOffset", "z", "elevation", 0);
    spec.span[li]        = _pick(src, "span", "stemLength", "axisLength", 1);
    spec.spread[li]      = _pick(src, "spread", "area", "scatterRadius", 1);

    spec.angleJitter[li] = _pick(src, "angleJitter", "rotationJitter", undefined, undefined, 0);
    spec.scaleJitter[li] = _pick(src, "scaleJitter", "sizeJitter", undefined, undefined, 0);
    spec.lengthJitter[li]= _pick(src, "lengthJitter", "heightJitter", undefined, undefined, 0);
    spec.hueJitter[li]   = _pick(src, "hueJitter", undefined, undefined, undefined, 0);
    spec.satJitter[li]   = _pick(src, "satJitter", "saturationJitter", undefined, undefined, 0);
    spec.valJitter[li]   = _pick(src, "valJitter", "valueJitter", "brightnessJitter", 0);

    parseColorInto(_colorTmp, src.color !== undefined ? src.color : src.fill, 0xffffff);
    spec.r[li] = _colorTmp[0];
    spec.g[li] = _colorTmp[1];
    spec.b[li] = _colorTmp[2];
    spec.a[li] = _pick(src, "opacity", "alpha", undefined, undefined, _colorTmp[3]);

    let flags = 0;
    if (_pickBool(src, "closed", "closePath", true)) flags |= FLAG_CLOSED;
    if (_pickBool(src, "mirror", "flip", false))     flags |= FLAG_MIRROR;
    if (_pickBool(src, "visible", "enabled", true))  flags |= FLAG_VISIBLE;
    if (_pickBool(src, "billboard", "faceCamera", false)) flags |= FLAG_BILLBOARD;
    spec.flags[li] = flags;
    return li + 1;
}

function _defaultGeneratorFor(kind) {
    const k = kind.toLowerCase();
    if (k.indexOf("grass") === 0 || k === "blade" || k === "needle") return "grass-tuft";
    if (k.indexOf("leaf") === 0) return "leaf-rosette";
    if (k === "sepal" || k === "bract") return "sepal-whorl";
    if (k === "stamen" || k === "filament" || k === "anther") return "stamen-ring";
    if (k === "pistil" || k === "carpel" || k === "center") return "pistil";
    if (k === "stem" || k === "stalk" || k === "pedicel") return "stem";
    if (k === "floret" || k === "disc") return "floret-disc";
    if (k === "ray") return "ray-florets";
    if (k === "catkin" || k === "spike") return "catkin";
    if (k === "umbel") return "umbel";
    return "petal-whorl";
}

function _defaultArrangementFor(genName) {
    switch (genName) {
        case "grass-tuft":   return ARR_SCATTER;
        case "grass-field":  return ARR_SCATTER;
        case "leaf-rosette": return ARR_ROSETTE;
        case "leaf-opposite":return ARR_OPPOSITE;
        case "leaf-alternate":return ARR_ALTERNATE;
        case "leaf-whorled": return ARR_WHORLED;
        case "stamen-ring":  return ARR_RING;
        case "pistil":       return ARR_SINGLE;
        case "stem":         return ARR_SINGLE;
        case "floret-disc":  return ARR_PHYLLOTAXIS;
        case "ray-florets":  return ARR_RADIAL;
        case "catkin":       return ARR_SPIKE;
        case "umbel":        return ARR_RADIAL;
        default:             return ARR_RADIAL;
    }
}

// Organ keys recognised in vector-bloom style descriptors.
const _ORGAN_KEYS = [
    "sepals", "calyx", "petals", "corolla", "tepals", "rays", "rayFlorets",
    "stamens", "androecium", "pistil", "carpel", "gynoecium", "disc", "florets",
    "bracts", "leaves", "foliage", "grass", "blades", "stem", "stalk",
    "catkin", "umbel"
];
const _ORGAN_KIND = Object.create(null);
_ORGAN_KIND.sepals = "sepal"; _ORGAN_KIND.calyx = "sepal";
_ORGAN_KIND.petals = "petal"; _ORGAN_KIND.corolla = "petal";
_ORGAN_KIND.tepals = "tepal";
_ORGAN_KIND.rays = "ray"; _ORGAN_KIND.rayFlorets = "ray";
_ORGAN_KIND.stamens = "stamen"; _ORGAN_KIND.androecium = "stamen";
_ORGAN_KIND.pistil = "pistil"; _ORGAN_KIND.carpel = "pistil";
_ORGAN_KIND.gynoecium = "pistil";
_ORGAN_KIND.disc = "floret"; _ORGAN_KIND.florets = "floret";
_ORGAN_KIND.bracts = "bract";
_ORGAN_KIND.leaves = "leaf"; _ORGAN_KIND.foliage = "leaf";
_ORGAN_KIND.grass = "grass"; _ORGAN_KIND.blades = "grass";
_ORGAN_KIND.stem = "stem"; _ORGAN_KIND.stalk = "stem";
_ORGAN_KIND.catkin = "catkin"; _ORGAN_KIND.umbel = "umbel";

/**
 * Load a vector-bloom style JSON descriptor into a BloomSpecSOA.
 * Accepts `{ layers: [...] }`, organ-keyed `{ petals: {...}, sepals: {...} }`,
 * or a single-layer descriptor. Load-time only — never call in a frame loop.
 */
function loadBloomJSON(json, specOut) {
    const spec = specOut || new BloomSpecSOA(MAX_LAYERS_DEFAULT);
    spec.reset();
    if (json === null || json === undefined) return spec;
    spec.name = _pickStr(json, "name", "id", "species", "unnamed");
    spec.seed = _pick(json, "seed", "randomSeed", undefined, undefined, 1) | 0;

    let li = 0;
    const cap = spec.capacity;

    // Form 1 — explicit layers array.
    if (json.layers && json.layers.length !== undefined) {
        for (let i = 0; i < json.layers.length && li < cap; i++) {
            const L = json.layers[i];
            const repeat = Math.max(1, _pick(L, "repeat", "whorls", "rings", 1) | 0);
            for (let r = 0; r < repeat && li < cap; r++) {
                li = _loadLayer(spec, li, L, spec.seed);
                if (repeat > 1) {
                    spec.phase[li - 1] += (r % 2) * (Math.PI / Math.max(1, spec.count[li - 1]));
                    spec.zOffset[li - 1] += r * _pick(L, "ringGap", "whorlGap", undefined, undefined, 0.02);
                    const shrink = 1 - r * _pick(L, "ringShrink", undefined, undefined, undefined, 0.12);
                    spec.length[li - 1] *= shrink > 0.15 ? shrink : 0.15;
                    spec.width[li - 1]  *= shrink > 0.15 ? shrink : 0.15;
                }
            }
        }
        spec.layerCount = li;
        return spec;
    }

    // Form 2 — organ-keyed descriptor (vector-bloom examples style).
    let found = false;
    for (let k = 0; k < _ORGAN_KEYS.length && li < cap; k++) {
        const key = _ORGAN_KEYS[k];
        const src = json[key];
        if (src === null || src === undefined) continue;
        found = true;
        if (src.length !== undefined && typeof src !== "string") {
            for (let i = 0; i < src.length && li < cap; i++) {
                const merged = src[i];
                if (merged.kind === undefined) merged.kind = _ORGAN_KIND[key];
                li = _loadLayer(spec, li, merged, spec.seed);
            }
        } else {
            if (src.kind === undefined) src.kind = _ORGAN_KIND[key];
            if (src.count === undefined && typeof src === "object" &&
                typeof json[key + "Count"] === "number") {
                src.count = json[key + "Count"];
            }
            li = _loadLayer(spec, li, src, spec.seed);
        }
    }

    // Form 3 — single-layer descriptor.
    if (!found) li = _loadLayer(spec, li, json, spec.seed);

    spec.layerCount = li;
    return spec;
}

/** Serialise a spec back to a plain JSON-shaped object (authoring/export only). */
function bloomSpecToJSON(spec) {
    const layers = [];
    for (let i = 0; i < spec.layerCount; i++) {
        layers.push({
            generator: generatorName(spec.generator[i]),
            shape: shapeNameOf(spec.shapeId[i]),
            profile: profileNameOf(spec.profileId[i]),
            count: spec.count[i],
            segments: spec.segments[i],
            radius: spec.radius[i],
            length: spec.length[i],
            width: spec.width[i],
            phase: spec.phase[i],
            rotation: spec.rotation[i],
            tiltClosed: spec.tiltClosed[i],
            tiltOpen: spec.tiltOpen[i],
            scaleClosed: spec.scaleClosed[i],
            curl: spec.curl[i],
            bend: spec.bend[i],
            twist: spec.twist[i],
            serration: spec.serration[i],
            notch: spec.notch[i],
            zOffset: spec.zOffset[i],
            span: spec.span[i],
            spread: spec.spread[i],
            angleJitter: spec.angleJitter[i],
            scaleJitter: spec.scaleJitter[i],
            lengthJitter: spec.lengthJitter[i],
            hueJitter: spec.hueJitter[i],
            satJitter: spec.satJitter[i],
            valJitter: spec.valJitter[i],
            color: [spec.r[i], spec.g[i], spec.b[i]],
            opacity: spec.a[i],
            closed: (spec.flags[i] & FLAG_CLOSED) !== 0,
            mirror: (spec.flags[i] & FLAG_MIRROR) !== 0,
            visible: (spec.flags[i] & FLAG_VISIBLE) !== 0,
            billboard: (spec.flags[i] & FLAG_BILLBOARD) !== 0
        });
    }
    return { name: spec.name, seed: spec.seed, layers: layers };
}

// ============================================================================
// Function Declarations — instance writer (shared by every generator)
// ============================================================================
function _writeInstance(scene, spec, li, i, x, y, z, rot, sx, sy, sz, seedKey, arrIndex) {
    const h1 = _hash01(seedKey, li, 0x11);
    const h2 = _hash01(seedKey, li, 0x22);
    const h3 = _hash01(seedKey, li, 0x33);
    const h4 = _hash01(seedKey, li, 0x44);
    const sj = spec.scaleJitter[li];
    const lj = spec.lengthJitter[li];
    const aj = spec.angleJitter[li];
    const k = 1 + (h2 * 2 - 1) * sj;

    scene.x[i] = x;
    scene.y[i] = y;
    scene.z[i] = z + spec.zOffset[li];
    scene.rotation[i] = rot + (h1 * 2 - 1) * aj;
    scene.scaleX[i] = sx * k;
    scene.scaleY[i] = sy * k * (1 + (h3 * 2 - 1) * lj);
    scene.scaleZ[i] = sz * k;
    scene.curl[i]  = spec.curl[li];
    scene.bend[i]  = spec.bend[li];
    scene.twist[i] = spec.twist[li] * (h4 * 2 - 1);
    scene.tiltClosed[i] = spec.tiltClosed[li];
    scene.tiltOpen[i]   = spec.tiltOpen[li];
    scene.scaleClosed[i]= spec.scaleClosed[li];
    scene.tilt[i] = spec.tiltOpen[li];
    scene.openScale[i] = 1;
    scene.windBend[i] = 0;
    scene.windPhase[i] = h1 * TAU;

    _rgbToHsv(spec.r[li], spec.g[li], spec.b[li], _hsv);
    let hh = _hsv[0] + (h2 * 2 - 1) * spec.hueJitter[li];
    hh = hh - Math.floor(hh);
    const ss = _clamp01(_hsv[1] + (h3 * 2 - 1) * spec.satJitter[li]);
    const vv = Math.max(0, _hsv[2] + (h4 * 2 - 1) * spec.valJitter[li]);
    _hsvToRgb(hh, ss, vv, _rgb);
    scene.r[i] = _rgb[0];
    scene.g[i] = _rgb[1];
    scene.b[i] = _rgb[2];
    scene.a[i] = spec.a[li];

    scene.layer[i]     = li;
    scene.shapeId[i]   = spec.shapeId[li];
    scene.profileId[i] = spec.profileId[li];
    scene.lod[i]       = 0;
    scene.flags[i]     = spec.flags[li];
    scene.seed[i]      = (seedKey + arrIndex) >>> 0;
    scene.pathOffset[i] = 0;
    scene.pathCount[i]  = 0;
    return i + 1;
}

// ============================================================================
// Built-in organ generators (init-time registration)
// ============================================================================
registerBloomGenerator("petal-whorl", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const r = spec.radius[li];
    const step = TAU / (n > 0 ? n : 1);
    const L = spec.length[li], W = spec.width[li];
    let w = base;
    for (let i = 0; i < n; i++) {
        const a = spec.phase[li] + i * step + spec.rotation[li];
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * r, Math.sin(a) * r, 0,
            a - HALF_PI, W, L, 1, ctx.seed, i);
    }
    return w - base;
});

registerBloomGenerator("sepal-whorl", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const r = spec.radius[li];
    const step = TAU / (n > 0 ? n : 1);
    const L = spec.length[li], W = spec.width[li];
    let w = base;
    for (let i = 0; i < n; i++) {
        const a = spec.phase[li] + i * step + spec.rotation[li];
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * r, Math.sin(a) * r, -0.01,
            a - HALF_PI, W, L, 1, ctx.seed + 7, i);
    }
    return w - base;
});

registerBloomGenerator("bract-ring", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const r = spec.radius[li];
    const step = TAU / (n > 0 ? n : 1);
    let w = base;
    for (let i = 0; i < n; i++) {
        const a = spec.phase[li] + i * step;
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * r, Math.sin(a) * r, -0.02,
            a - HALF_PI, spec.width[li], spec.length[li], 1, ctx.seed + 13, i);
    }
    return w - base;
});

registerBloomGenerator("ray-florets", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const r = spec.radius[li];
    const step = TAU / (n > 0 ? n : 1);
    let w = base;
    for (let i = 0; i < n; i++) {
        const a = spec.phase[li] + i * step;
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * r, Math.sin(a) * r, 0.005,
            a - HALF_PI, spec.width[li], spec.length[li], 1, ctx.seed + 23, i);
    }
    return w - base;
});

registerBloomGenerator("stamen-ring", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const r = spec.radius[li] > 0 ? spec.radius[li] : spec.length[li] * 0.22;
    const step = TAU / (n > 0 ? n : 1);
    let w = base;
    for (let i = 0; i < n; i++) {
        const a = spec.phase[li] + i * step;
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * r, Math.sin(a) * r, 0.01,
            a - HALF_PI, spec.width[li], spec.length[li], 1, ctx.seed + 31, i);
    }
    return w - base;
});

registerBloomGenerator("pistil", function (scene, spec, li, base, ctx) {
    const n = spec.count[li] > 0 ? spec.count[li] : 1;
    let w = base;
    for (let i = 0; i < n; i++) {
        const a = n > 1 ? (i / n) * TAU : 0;
        const r = n > 1 ? spec.radius[li] : 0;
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * r, Math.sin(a) * r, 0.02,
            a, spec.width[li], spec.length[li], 1, ctx.seed + 41, i);
    }
    return w - base;
});

registerBloomGenerator("stem", function (scene, spec, li, base, ctx) {
    const w = _writeInstance(scene, spec, li, base,
        0, 0, -0.03, spec.rotation[li],
        spec.width[li], spec.span[li] > 0 ? spec.span[li] : spec.length[li],
        1, ctx.seed + 53, 0);
    return w - base;
});

registerBloomGenerator("floret-disc", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const spread = spec.spread[li] > 0 ? spec.spread[li] : spec.radius[li];
    const sc = spec.width[li];
    let w = base;
    for (let i = 0; i < n; i++) {
        const a = i * GOLDEN_ANGLE + spec.phase[li];
        const rr = spread * Math.sqrt((i + 0.5) / (n > 0 ? n : 1));
        const taper = 1 - 0.45 * (i / (n > 1 ? n - 1 : 1));
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * rr, Math.sin(a) * rr, 0.015,
            a, sc * taper, spec.length[li] * taper, 1, ctx.seed + 61, i);
    }
    return w - base;
});

registerBloomGenerator("leaf-rosette", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const step = TAU / (n > 0 ? n : 1);
    const r = spec.radius[li];
    let w = base;
    for (let i = 0; i < n; i++) {
        const a = spec.phase[li] + i * step;
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * r, Math.sin(a) * r, -0.015,
            a - HALF_PI, spec.width[li], spec.length[li], 1, ctx.seed + 71, i);
    }
    return w - base;
});

registerBloomGenerator("leaf-opposite", function (scene, spec, li, base, ctx) {
    const nodes = spec.count[li];
    const span = spec.span[li] > 0 ? spec.span[li] : 1;
    let w = base;
    for (let i = 0; i < nodes; i++) {
        const t = nodes > 1 ? i / (nodes - 1) : 0;
        const y = -span * 0.5 + t * span;
        const taper = 1 - 0.5 * t;
        for (let s = 0; s < 2; s++) {
            const dir = s === 0 ? 0 : Math.PI;
            w = _writeInstance(scene, spec, li, w,
                0, y, -0.02, dir + spec.rotation[li],
                spec.width[li] * taper, spec.length[li] * taper, 1,
                ctx.seed + 83 + i * 2, s);
        }
    }
    return w - base;
});

registerBloomGenerator("leaf-alternate", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const span = spec.span[li] > 0 ? spec.span[li] : 1;
    let w = base;
    for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0;
        const y = -span * 0.5 + t * span;
        const a = i * GOLDEN_ANGLE + spec.phase[li];
        const taper = 1 - 0.45 * t;
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * spec.radius[li], y, -0.02,
            a - HALF_PI, spec.width[li] * taper, spec.length[li] * taper, 1,
            ctx.seed + 97, i);
    }
    return w - base;
});

registerBloomGenerator("leaf-whorled", function (scene, spec, li, base, ctx) {
    const nodes = spec.count[li];
    const per = Math.max(2, _pick(null, "", undefined, undefined, undefined, 3) | 0);
    const span = spec.span[li] > 0 ? spec.span[li] : 1;
    const step = TAU / per;
    let w = base;
    for (let i = 0; i < nodes; i++) {
        const t = nodes > 1 ? i / (nodes - 1) : 0;
        const y = -span * 0.5 + t * span;
        for (let s = 0; s < per; s++) {
            const a = spec.phase[li] + s * step + i * 0.4;
            w = _writeInstance(scene, spec, li, w,
                Math.cos(a) * spec.radius[li], y, -0.02,
                a - HALF_PI, spec.width[li], spec.length[li], 1,
                ctx.seed + 101 + i * per, s);
        }
    }
    return w - base;
});

registerBloomGenerator("grass-tuft", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const spread = spec.spread[li] > 0 ? spec.spread[li] : 0.35;
    let w = base;
    for (let i = 0; i < n; i++) {
        const h1 = _hash01(ctx.seed + i, li, 0x51);
        const h2 = _hash01(ctx.seed + i, li, 0x52);
        const a = h1 * TAU;
        const rr = spread * Math.sqrt(h2);
        const lean = (h1 * 2 - 1) * 0.55;
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * rr, Math.sin(a) * rr * 0.35, -0.02,
            -HALF_PI + lean, spec.width[li], spec.length[li], 1,
            ctx.seed + 113, i);
    }
    return w - base;
});

registerBloomGenerator("grass-field", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const spread = spec.spread[li] > 0 ? spec.spread[li] : 10;
    let w = base;
    for (let i = 0; i < n; i++) {
        const h1 = _hash01(ctx.seed + i, li, 0x61);
        const h2 = _hash01(ctx.seed + i, li, 0x62);
        const x = (h1 * 2 - 1) * spread;
        const y = (h2 * 2 - 1) * spread;
        const lean = (_hash01(ctx.seed + i, li, 0x63) * 2 - 1) * 0.4;
        w = _writeInstance(scene, spec, li, w,
            x, y, 0, -HALF_PI + lean,
            spec.width[li], spec.length[li], 1, ctx.seed + 127, i);
    }
    return w - base;
});

registerBloomGenerator("catkin", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const span = spec.span[li] > 0 ? spec.span[li] : 1;
    let w = base;
    for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0;
        const a = i * GOLDEN_ANGLE;
        const rr = spec.radius[li] * (1 - 0.55 * t);
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * rr, -span * 0.5 + t * span, -0.01,
            a - HALF_PI, spec.width[li], spec.length[li] * (1 - 0.4 * t), 1,
            ctx.seed + 131, i);
    }
    return w - base;
});

registerBloomGenerator("umbel", function (scene, spec, li, base, ctx) {
    const n = spec.count[li];
    const step = TAU / (n > 0 ? n : 1);
    const r = spec.radius[li] > 0 ? spec.radius[li] : spec.spread[li];
    let w = base;
    for (let i = 0; i < n; i++) {
        const a = spec.phase[li] + i * step;
        const lift = Math.sin((i / (n > 1 ? n - 1 : 1)) * Math.PI) * 0.12;
        w = _writeInstance(scene, spec, li, w,
            Math.cos(a) * r, Math.sin(a) * r, lift,
            a - HALF_PI, spec.width[li], spec.length[li], 1, ctx.seed + 137, i);
    }
    return w - base;
});

// ============================================================================
// Function Declarations — composition (sync + chunked async)
// ============================================================================
/** Compose every visible layer of `spec` into `scene`. Zero-GC after warmup. */
function composeBloom(scene, spec, options) {
    options = options || {};
    _ctx.seed    = _pick(options, "seed", undefined, undefined, undefined, spec.seed) | 0;
    _ctx.open    = _clamp01(_pick(options, "open", "bloom", undefined, undefined, 1));
    _ctx.time    = _pick(options, "time", undefined, undefined, undefined, 0);
    _ctx.wind    = _pick(options, "wind", undefined, undefined, undefined, 0);
    _ctx.windDir = _pick(options, "windDir", undefined, undefined, undefined, 0);
    _ctx.quality = _clamp01(_pick(options, "quality", undefined, undefined, undefined, 1));
    _ctx.lodBias = _pick(options, "lodBias", undefined, undefined, undefined, 0) | 0;

    const need = spec.totalInstances();
    if (scene.capacity < need) scene.resize(need);
    scene.count = 0;
    let w = 0;
    for (let li = 0; li < spec.layerCount; li++) {
        if ((spec.flags[li] & FLAG_VISIBLE) === 0) continue;
        const fn = getBloomGenerator(generatorName(spec.generator[li]));
        const written = fn(scene, spec, li, w, _ctx);
        w += written;
    }
    scene.count = w;
    setBloomOpen(scene, _ctx.open);
    if (_ctx.wind !== 0) applyWind(scene, _ctx.time, _ctx.wind, _ctx.windDir);
    return w;
}

/** Chunked composition — yields between layers so 1M+ builds never freeze UI. */
async function composeBloomAsync(scene, spec, options, chunkSize, yieldEvery) {
    options = options || {};
    chunkSize  = chunkSize  || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    _ctx.seed    = _pick(options, "seed", undefined, undefined, undefined, spec.seed) | 0;
    _ctx.open    = _clamp01(_pick(options, "open", "bloom", undefined, undefined, 1));
    _ctx.time    = _pick(options, "time", undefined, undefined, undefined, 0);
    _ctx.wind    = _pick(options, "wind", undefined, undefined, undefined, 0);
    _ctx.windDir = _pick(options, "windDir", undefined, undefined, undefined, 0);
    _ctx.quality = _clamp01(_pick(options, "quality", undefined, undefined, undefined, 1));
    _ctx.lodBias = _pick(options, "lodBias", undefined, undefined, undefined, 0) | 0;

    const need = spec.totalInstances();
    if (scene.capacity < need) scene.resize(need);
    scene.count = 0;
    let w = 0;
    let c = 0;
    let sinceYield = 0;
    for (let li = 0; li < spec.layerCount; li++) {
        if ((spec.flags[li] & FLAG_VISIBLE) === 0) continue;
        const fn = getBloomGenerator(generatorName(spec.generator[li]));
        const total = spec.count[li];
        const saved = total;
        let done = 0;
        while (done < saved) {
            const batch = Math.min(chunkSize, saved - done);
            spec.count[li] = batch;
            const savedPhase = spec.phase[li];
            spec.phase[li] = savedPhase;
            const written = fn(scene, spec, li, w, _ctx);
            spec.count[li] = saved;
            w += written;
            done += batch;
            sinceYield += batch;
            if (sinceYield >= chunkSize) {
                sinceYield = 0;
                if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
            }
        }
        spec.count[li] = saved;
    }
    scene.count = w;
    setBloomOpen(scene, _ctx.open);
    if (_ctx.wind !== 0) applyWind(scene, _ctx.time, _ctx.wind, _ctx.windDir);
    await common.yieldToMain();
    return w;
}

// ============================================================================
// Function Declarations — animation channels (Zero-GC, in-place)
// ============================================================================
/** Drive the bloom: t = 0 (bud) → 1 (fully open). Updates tilt + openScale. */
function setBloomOpen(scene, t) {
    const n = scene.count;
    const k = _clamp01(t);
    const eased = k * k * (3 - 2 * k);
    const tilt = scene.tilt, tc = scene.tiltClosed, to = scene.tiltOpen;
    const os = scene.openScale, sc = scene.scaleClosed;
    for (let i = 0; i < n; i++) {
        tilt[i] = tc[i] + (to[i] - tc[i]) * eased;
        os[i]   = sc[i] + (1 - sc[i]) * eased;
    }
    return scene;
}

/** Sinusoidal wind deformation. Writes windBend only — rest pose untouched. */
function applyWind(scene, time, strength, direction) {
    const n = scene.count;
    const wb = scene.windBend, wp = scene.windPhase;
    const px = scene.x, py = scene.y;
    const dirX = Math.cos(direction), dirY = Math.sin(direction);
    const s = strength === undefined ? 0.15 : strength;
    for (let i = 0; i < n; i++) {
        const spatial = (px[i] * dirX + py[i] * dirY) * 0.35;
        const phase = time * 1.7 + wp[i] + spatial;
        wb[i] = (Math.sin(phase) + 0.35 * Math.sin(phase * 2.3)) * s;
    }
    return scene;
}

/** Screen-space LOD tagging from camera distance. Zero-GC. */
function tagBloomLOD(scene, camX, camY, camZ, pixelsPerRadian, targetPixels, bias) {
    const n = scene.count;
    const px = scene.x, py = scene.y, pz = scene.z;
    const sy = scene.scaleY, os = scene.openScale;
    const lod = scene.lod;
    const ppr = pixelsPerRadian || 1080;
    const tp = targetPixels || 8;
    const b = bias === undefined ? 0 : bias | 0;
    for (let i = 0; i < n; i++) {
        const dx = px[i] - camX, dy = py[i] - camY, dz = pz[i] - camZ;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d <= EPSILON) { lod[i] = 0; continue; }
        const size = sy[i] * os[i];
        const screenPx = (size / d) * ppr;
        if (screenPx >= tp) { lod[i] = 0; continue; }
        let level = Math.ceil(Math.log2(tp / screenPx)) + b;
        if (level < 0) level = 0;
        if (level > 10) level = 10;
        lod[i] = level;
    }
    return scene;
}

/** Scene AABB into scene.bounds[0..5]. */
function bloomBounds(scene) {
    const n = scene.count;
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    const px = scene.x, py = scene.y, pz = scene.z;
    const sx = scene.scaleX, sy = scene.scaleY;
    for (let i = 0; i < n; i++) {
        const ex = sx[i], ey = sy[i];
        const x0 = px[i] - ex, x1 = px[i] + ex;
        const y0 = py[i] - ey, y1 = py[i] + ey;
        const z = pz[i];
        if (x0 < mnx) mnx = x0; if (x1 > mxx) mxx = x1;
        if (y0 < mny) mny = y0; if (y1 > mxy) mxy = y1;
        if (z < mnz) mnz = z;   if (z > mxz) mxz = z;
    }
    if (n === 0) { mnx = mny = mnz = 0; mxx = mxy = mxz = 0; }
    scene.bounds[0] = mnx; scene.bounds[1] = mny; scene.bounds[2] = mnz;
    scene.bounds[3] = mxx; scene.bounds[4] = mxy; scene.bounds[5] = mxz;
    return scene.bounds;
}

// ============================================================================
// Function Declarations — path geometry binding
// ============================================================================
/**
 * Build one path per distinct (shape, profile, segments, deform) signature and
 * record `pathOffset` / `pathCount` per instance. Load-time / init-time.
 */
function buildBloomPaths(scene, spec, arena, options) {
    options = options || {};
    const params = createPathParams();
    const scratch = createPath(options.pathCapacity || 512);
    let write = 0;
    arena.clear();
    for (let li = 0; li < spec.layerCount; li++) {
        params.reset();
        params.shape     = shapeNameOf(spec.shapeId[li]);
        params.profile   = profileNameOf(spec.profileId[li]);
        params.segments  = spec.segments[li];
        params.length    = 1;
        params.width     = 1;
        params.curl      = spec.curl[li];
        params.bend      = spec.bend[li];
        params.serration = spec.serration[li];
        params.notch     = spec.notch[li];
        params.closed    = (spec.flags[li] & FLAG_CLOSED) !== 0;
        params.mirror    = (spec.flags[li] & FLAG_MIRROR) !== 0;
        scratch.clear();
        appendShape(scratch, params);
        const off = write;
        const cnt = scratch.count;
        arena._ensure(off + cnt);
        for (let k = 0; k < cnt; k++) {
            arena.cmd[off + k]   = scratch.cmd[k];
            arena.flags[off + k] = scratch.flags[k];
            for (let ch = 0; ch < 9; ch++) arena.arrays[ch][off + k] = scratch.arrays[ch][k];
        }
        write += cnt;
        arena.count = write;
        const n = scene.count;
        for (let i = 0; i < n; i++) {
            if (scene.layer[i] !== li) continue;
            scene.pathOffset[i] = off;
            scene.pathCount[i]  = cnt;
        }
    }
    return write;
}

// ============================================================================
// Function Declarations — exporters
// ============================================================================
/** Column-major instance matrices (16 floats each) for the instanced bridge. */
function bloomToInstanceMatrices(scene, outMatrices, camX, camY, camZ, maxLod) {
    const n = scene.count;
    const ox = camX === undefined ? 0 : camX;
    const oy = camY === undefined ? 0 : camY;
    const oz = camZ === undefined ? 0 : camZ;
    const cap = maxLod === undefined ? 10 : maxLod;
    const px = scene.x, py = scene.y, pz = scene.z;
    const rot = scene.rotation, tilt = scene.tilt;
    const sx = scene.scaleX, sy = scene.scaleY, sz = scene.scaleZ;
    const os = scene.openScale, wb = scene.windBend;
    const lod = scene.lod;
    let w = 0, written = 0;
    for (let i = 0; i < n; i++) {
        if (lod[i] > cap) continue;
        const a = rot[i] + wb[i] * 0.35;
        const t = tilt[i];
        const ca = Math.cos(a), sa = Math.sin(a);
        const ct = Math.cos(t), st = Math.sin(t);
        const kx = sx[i], ky = sy[i] * os[i], kz = sz[i];
        // Rz(a) · Rx(t) · S
        outMatrices[w]      = ca * kx;
        outMatrices[w + 1]  = sa * ct * kx;
        outMatrices[w + 2]  = sa * st * kx;
        outMatrices[w + 3]  = 0;
        outMatrices[w + 4]  = -sa * ky;
        outMatrices[w + 5]  = ca * ct * ky;
        outMatrices[w + 6]  = ca * st * ky;
        outMatrices[w + 7]  = 0;
        outMatrices[w + 8]  = 0;
        outMatrices[w + 9]  = -st * kz;
        outMatrices[w + 10] = ct * kz;
        outMatrices[w + 11] = 0;
        outMatrices[w + 12] = px[i] - ox;
        outMatrices[w + 13] = py[i] - oy;
        outMatrices[w + 14] = pz[i] - oz;
        outMatrices[w + 15] = 1;
        w += 16;
        written++;
    }
    return written;
}

/** Flat GPU triangle buffer (xyz per vertex) from bound paths. Zero-GC. */
function bloomToVertices(scene, arena, outVerts, segments, maxLod) {
    const n = scene.count;
    const cap = maxLod === undefined ? 10 : maxLod;
    const seg = segments === undefined ? 8 : segments;
    const pts = _pathScratchPoints();
    const sub = _pathScratchPath();
    const px = scene.x, py = scene.y, pz = scene.z;
    const rot = scene.rotation, tilt = scene.tilt;
    const sx = scene.scaleX, sy = scene.scaleY;
    const os = scene.openScale, wb = scene.windBend;
    const lod = scene.lod;
    let w = 0;
    for (let i = 0; i < n; i++) {
        if (lod[i] > cap) continue;
        const cnt = scene.pathCount[i];
        if (cnt < 3) continue;
        const off = scene.pathOffset[i];
        sub.clear();
        sub._ensure(cnt);
        sub.count = cnt;
        for (let k = 0; k < cnt; k++) {
            sub.cmd[k]   = arena.cmd[off + k];
            sub.flags[k] = arena.flags[off + k];
            for (let ch = 0; ch < 9; ch++) sub.arrays[ch][k] = arena.arrays[ch][off + k];
        }
        const m = flattenPath(pts, sub, seg);
        if (m < 3) continue;
        let cx = 0, cy = 0;
        for (let k = 0; k < m; k++) { cx += pts.x[k]; cy += pts.y[k]; }
        const inv = 1 / m;
        cx *= inv; cy *= inv;
        const a = rot[i] + wb[i] * 0.35;
        const ca = Math.cos(a), sa = Math.sin(a);
        const ct = Math.cos(tilt[i]);
        const kx = sx[i], ky = sy[i] * os[i];
        const ox = px[i], oy = py[i], oz = pz[i];
        for (let k = 0; k < m; k++) {
            const j = (k + 1) % m;
            // centroid
            let lx = cx * kx, ly = cy * ky;
            outVerts[w++] = lx * ca - ly * sa + ox;
            outVerts[w++] = (lx * sa + ly * ca) * ct + oy;
            outVerts[w++] = oz;
            // p[k]
            lx = pts.x[k] * kx; ly = pts.y[k] * ky;
            outVerts[w++] = lx * ca - ly * sa + ox;
            outVerts[w++] = (lx * sa + ly * ca) * ct + oy;
            outVerts[w++] = oz + pts.z[k] * ky;
            // p[j]
            lx = pts.x[j] * kx; ly = pts.y[j] * ky;
            outVerts[w++] = lx * ca - ly * sa + ox;
            outVerts[w++] = (lx * sa + ly * ca) * ct + oy;
            outVerts[w++] = oz + pts.z[j] * ky;
        }
    }
    return w / 3;
}

let _bvPts = null, _bvPath = null;
function _pathScratchPoints() {
    if (_bvPts === null) _bvPts = createPointSOA(4096);
    return _bvPts;
}
function _pathScratchPath() {
    if (_bvPath === null) _bvPath = createPath(1024);
    return _bvPath;
}

/**
 * SVG scene export. Uses a module-level reused chunk array and a single join;
 * string creation happens only at this serialisation boundary.
 */
function bloomToSVG(scene, arena, options) {
    options = options || {};
    const precision = _pick(options, "precision", undefined, undefined, undefined, 2);
    const f = Math.pow(10, precision);
    const maxLod = _pick(options, "maxLod", undefined, undefined, undefined, 0);
    const width  = _pick(options, "width", undefined, undefined, undefined, 512);
    const height = _pick(options, "height", undefined, undefined, undefined, 512);
    const scale  = _pick(options, "scale", undefined, undefined, undefined, 100);
    const sub = _pathScratchPath();
    const n = scene.count;
    _svgLen = 0;
    _svgOut[_svgLen++] = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
        (-width * 0.5) + ' ' + (-height * 0.5) + ' ' + width + ' ' + height + '">';
    for (let i = 0; i < n; i++) {
        if (scene.lod[i] > maxLod) continue;
        if (_svgLen + 8 >= _svgOut.length) break;
        const cnt = scene.pathCount[i];
        if (cnt === 0) continue;
        const off = scene.pathOffset[i];
        sub.clear();
        sub._ensure(cnt);
        sub.count = cnt;
        for (let k = 0; k < cnt; k++) {
            sub.cmd[k]   = arena.cmd[off + k];
            sub.flags[k] = arena.flags[off + k];
            for (let ch = 0; ch < 9; ch++) sub.arrays[ch][k] = arena.arrays[ch][off + k];
        }
        const deg = (scene.rotation[i] + scene.windBend[i] * 0.35) * 180 / Math.PI;
        const kx = scene.scaleX[i] * scale;
        const ky = scene.scaleY[i] * scene.openScale[i] * scale;
        _svgOut[_svgLen++] = '<g transform="translate(' +
            (Math.round(scene.x[i] * scale * f) / f) + ' ' +
            (Math.round(-scene.y[i] * scale * f) / f) + ') rotate(' +
            (Math.round(-deg * f) / f) + ') scale(' +
            (Math.round(kx * f) / f) + ' ' + (Math.round(ky * f) / f) + ')">';
        _svgOut[_svgLen++] = '<path d="';
        let d = "";
        for (let k = 0; k < cnt; k++) {
            const c = sub.cmd[k];
            const ex = Math.round(sub.px[k] * f) / f;
            const ey = Math.round(-sub.py[k] * f) / f;
            if (c === CMD_MOVE) d += "M" + ex + " " + ey;
            else if (c === CMD_LINE) d += "L" + ex + " " + ey;
            else if (c === CMD_QUAD) {
                d += "Q" + (Math.round(sub.c1x[k] * f) / f) + " " +
                           (Math.round(-sub.c1y[k] * f) / f) + " " + ex + " " + ey;
            } else if (c === CMD_CUBIC) {
                d += "C" + (Math.round(sub.c1x[k] * f) / f) + " " +
                           (Math.round(-sub.c1y[k] * f) / f) + " " +
                           (Math.round(sub.c2x[k] * f) / f) + " " +
                           (Math.round(-sub.c2y[k] * f) / f) + " " + ex + " " + ey;
            } else if (c === CMD_CLOSE) d += "Z";
        }
        _svgOut[_svgLen++] = d;
        _svgOut[_svgLen++] = '" fill="rgb(' +
            Math.round(_clamp01(scene.r[i]) * 255) + ',' +
            Math.round(_clamp01(scene.g[i]) * 255) + ',' +
            Math.round(_clamp01(scene.b[i]) * 255) + ')" fill-opacity="' +
            (Math.round(scene.a[i] * f) / f) + '"/>';
        _svgOut[_svgLen++] = '</g>';
    }
    _svgOut[_svgLen++] = '</svg>';
    let out = "";
    for (let i = 0; i < _svgLen; i++) out += _svgOut[i];
    return out;
}

// ============================================================================
// Extensibility — one-call leaf / grass species registration
// ============================================================================
/**
 * Register a new leaf species across all three layers at once:
 *   082 width profile → 083 path shape → 084 organ generator + preset.
 * `widthFn(u, out)` writes out[0]=halfWidth, out[1]=height, out[2]=depth.
 */
function registerLeafType(name, widthFn, defaults) {
    const profileName = name.indexOf("leaf-") === 0 ? name : "leaf-" + name;
    registerPointProfile(profileName, widthFn, PROFILE_CLOSED);
    if (!hasPathShape(profileName)) {
        registerPathShape(profileName, function (path, p) {
            p.profile = profileName;
            _emitOutlineInto(path, p);
            return path;
        });
    }
    const genName = "leaf-" + name;
    if (!hasBloomGenerator(genName)) {
        registerBloomGenerator(genName, function (scene, spec, li, base, ctx) {
            return getBloomGenerator("leaf-rosette")(scene, spec, li, base, ctx);
        });
    }
    const preset = {
        name: name,
        seed: 1,
        layers: [{
            generator: "leaf-rosette",
            shape: profileName,
            profile: profileName,
            count: 6, length: 1, width: 0.5,
            color: "leaf", closed: true, visible: true
        }]
    };
    if (defaults) {
        const L = preset.layers[0];
        for (const k in defaults) L[k] = defaults[k];
    }
    registerBloomPreset(name, preset);
    return profileName;
}

/** Register a new grass / blade species across all three layers at once. */
function registerGrassType(name, widthFn, defaults) {
    const profileName = name.indexOf("grass-") === 0 ? name : "grass-" + name;
    registerPointProfile(profileName, widthFn, PROFILE_BLADE);
    if (!hasPathShape(profileName)) {
        registerPathShape(profileName, function (path, p) {
            p.profile = profileName;
            _emitBladeInto(path, p);
            return path;
        });
    }
    const genName = "grass-" + name;
    if (!hasBloomGenerator(genName)) {
        registerBloomGenerator(genName, function (scene, spec, li, base, ctx) {
            return getBloomGenerator("grass-tuft")(scene, spec, li, base, ctx);
        });
    }
    const preset = {
        name: name,
        seed: 1,
        layers: [{
            generator: "grass-tuft",
            shape: profileName,
            profile: profileName,
            count: 24, length: 1, width: 0.08,
            spread: 0.35, bend: 0.25, curl: 0.1,
            scaleJitter: 0.25, lengthJitter: 0.3, angleJitter: 0.2,
            valJitter: 0.12, color: "grass", closed: true, visible: true
        }]
    };
    if (defaults) {
        const L = preset.layers[0];
        for (const k in defaults) L[k] = defaults[k];
    }
    registerBloomPreset(name, preset);
    return profileName;
}

// Local outline / blade emitters (mirror 083 behaviour without re-import cycles).
function _emitOutlineInto(path, p) {
    const fn = getPointProfile(p.profile);
    const seg = p.segments < 2 ? 2 : p.segments;
    const inv = 1 / (seg - 1);
    const L = p.length * p.scaleY, W = p.width * p.scaleX;
    const scratch = _profileScratch();
    for (let i = 0; i < seg; i++) {
        const u = i * inv;
        fn(u, scratch);
        let hw = scratch[0] * W;
        let yy = scratch[1] * L;
        if (p.serration !== 0) hw *= 1 + p.serration * Math.sin(u * 24);
        if (p.notch !== 0 && u > 0.86) {
            const k = (u - 0.86) / 0.14;
            yy -= p.notch * k * k * L;
        }
        const xx = hw + p.bend * u * u * L;
        const zz = scratch[2] * L + p.curl * u * u * L;
        if (i === 0) path.moveTo(xx, yy, zz); else path.lineTo(xx, yy, zz);
    }
    for (let i = 0; i < seg; i++) {
        const u = 1 - i * inv;
        fn(u, scratch);
        let hw = scratch[0] * W;
        let yy = scratch[1] * L;
        if (p.serration !== 0) hw *= 1 + p.serration * Math.sin(u * 24);
        if (p.notch !== 0 && u > 0.86) {
            const k = (u - 0.86) / 0.14;
            yy -= p.notch * k * k * L;
        }
        const xx = -hw + p.bend * u * u * L;
        const zz = scratch[2] * L + p.curl * u * u * L;
        path.lineTo(xx, yy, zz);
    }
    if (p.closed) path.close();
    return path;
}

function _emitBladeInto(path, p) {
    const fn = getPointProfile(p.profile);
    const seg = p.segments < 2 ? 2 : p.segments;
    const inv = 1 / (seg - 1);
    const L = p.length * p.scaleY, W = p.width * p.scaleX;
    const scratch = _profileScratch();
    for (let i = 0; i < seg; i++) {
        const u = i * inv;
        fn(u, scratch);
        const xx = scratch[0] * W + p.bend * u * u * L;
        const yy = scratch[1] * L;
        const zz = scratch[2] * L + p.curl * u * u * L;
        if (i === 0) path.moveTo(xx, yy, zz); else path.lineTo(xx, yy, zz);
    }
    if (p.closed) path.close();
    return path;
}

let _profScratch = null;
function _profileScratch() {
    if (_profScratch === null) _profScratch = new Float64Array(3);
    return _profScratch;
}

// ============================================================================
// Preset registry (JSON-shaped descriptors, load-time only)
// ============================================================================
const _presetRegistry = Object.create(null);
const _presetNames = [];

function registerBloomPreset(name, json) {
    if (_presetRegistry[name] === undefined) _presetNames.push(name);
    _presetRegistry[name] = json;
    return json;
}

function getBloomPreset(name) { return _presetRegistry[name]; }
function hasBloomPreset(name) { return _presetRegistry[name] !== undefined; }
function listBloomPresets() { return _presetNames; }

/** Load a named preset into a spec (load-time). */
function loadBloomPreset(name, specOut) {
    const json = _presetRegistry[name];
    if (json === undefined) return loadBloomJSON(null, specOut);
    return loadBloomJSON(json, specOut);
}

// ---- Built-in flower presets (vector-bloom compatible schema) --------------
registerBloomPreset("daisy", {
    name: "daisy", seed: 7,
    sepals: { count: 8, profile: "sepal-linear", length: 0.42, width: 0.14, color: "stem", zOffset: -0.02 },
    petals: { count: 21, profile: "petal-obovate", length: 1.0, width: 0.20, radius: 0.16,
              color: "white", valJitter: 0.06, angleJitter: 0.03, tiltOpen: 0.12, tiltClosed: 1.4 },
    disc:   { generator: "floret-disc", count: 180, profile: "petal-ovate", length: 0.07, width: 0.05,
              spread: 0.17, color: "gold", valJitter: 0.15 }
});

registerBloomPreset("tulip", {
    name: "tulip", seed: 11,
    layers: [
        { generator: "stem", shape: "stem", profile: "stamen-filament", length: 2.4, width: 0.05, color: "stem" },
        { generator: "leaf-opposite", profile: "leaf-lanceolate", count: 3, span: 1.8,
          length: 1.1, width: 0.28, color: "leaf", bend: 0.2 },
        { generator: "petal-whorl", profile: "petal-ovate", count: 3, length: 1.0, width: 0.55,
          radius: 0.1, color: "crimson", tiltOpen: 0.55, tiltClosed: 1.5, curl: 0.18, repeat: 2, ringGap: 0.03 }
    ]
});

registerBloomPreset("rose", {
    name: "rose", seed: 23,
    layers: [
        { generator: "sepal-whorl", profile: "sepal-linear", count: 5, length: 0.5, width: 0.16, color: "stem" },
        { generator: "petal-whorl", profile: "petal-obcordate", count: 8, length: 1.0, width: 0.7,
          radius: 0.12, color: "rose", repeat: 5, ringGap: 0.035, ringShrink: 0.16,
          tiltOpen: 0.7, tiltClosed: 1.5, curl: 0.3, valJitter: 0.1, angleJitter: 0.08 },
        { generator: "stamen-ring", profile: "stamen-filament", count: 24, length: 0.22, width: 0.03,
          radius: 0.07, color: "gold" }
    ]
});

registerBloomPreset("lily", {
    name: "lily", seed: 31,
    tepals:  { count: 6, profile: "petal-spatulate", length: 1.3, width: 0.42, radius: 0.1,
               color: "cream", tiltOpen: 0.85, curl: 0.22, repeat: 2, ringGap: 0.02 },
    stamens: { count: 6, profile: "stamen-filament", length: 0.6, width: 0.045, radius: 0.12, color: "orange" },
    pistil:  { count: 1, profile: "stamen-filament", length: 0.75, width: 0.05, color: "green" }
});

registerBloomPreset("sunflower", {
    name: "sunflower", seed: 43,
    sepals:  { count: 18, profile: "leaf-deltoid", length: 0.55, width: 0.24, color: "leaf", zOffset: -0.03 },
    rays:    { count: 34, profile: "petal-obovate", length: 1.15, width: 0.22, radius: 0.34,
               color: "yellow", valJitter: 0.1, angleJitter: 0.02, repeat: 2, ringGap: 0.01 },
    disc:    { generator: "floret-disc", count: 620, profile: "petal-ovate", length: 0.075, width: 0.055,
               spread: 0.34, color: "brown", valJitter: 0.22, hueJitter: 0.03 }
});

registerBloomPreset("clover", {
    name: "clover", seed: 59,
    layers: [
        { generator: "stem", shape: "stem", profile: "stamen-filament", length: 1.2, width: 0.035, color: "stem" },
        { generator: "leaf-whorled", profile: "leaf-cordate", count: 4, span: 0.9, radius: 0.06,
          length: 0.5, width: 0.42, color: "leaf", valJitter: 0.1 },
        { generator: "floret-disc", profile: "petal-spatulate", count: 90, length: 0.2, width: 0.06,
          spread: 0.16, color: "pink", valJitter: 0.12 }
    ]
});

// ---- Built-in grass / leaf species via the one-call hooks ------------------
registerGrassType("meadow", function (u, out) {
    out[0] = 0.055 * Math.sin(Math.PI * Math.pow(u, 0.5)) * (1 - 0.7 * u);
    out[1] = u;
    out[2] = 0.16 * u * u;
}, { count: 40, length: 1.1, width: 0.09, spread: 0.4 });

registerGrassType("fescue", function (u, out) {
    out[0] = 0.022 * (1 - u) * Math.pow(Math.sin(Math.PI * Math.min(1, u / 0.98)), 0.4);
    out[1] = u;
    out[2] = 0.24 * u * u;
}, { count: 64, length: 1.3, width: 0.05, spread: 0.3 });

registerGrassType("sedge", function (u, out) {
    out[0] = 0.042 * Math.sin(Math.PI * Math.pow(u, 0.42)) * (1 - 0.86 * u);
    out[1] = u;
    out[2] = 0.07 * Math.sin(u * Math.PI);
}, { count: 32, length: 0.95, width: 0.08 });

registerGrassType("reed", function (u, out) {
    out[0] = 0.075 * Math.sin(Math.PI * Math.pow(u, 0.35)) * (1 - 0.55 * u);
    out[1] = u;
    out[2] = 0.3 * u * u * u;
}, { count: 16, length: 2.4, width: 0.12, spread: 0.5, bend: 0.4 });

registerLeafType("oak", function (u, out) {
    const base = 0.42 * Math.sin(Math.PI * Math.pow(u, 0.7));
    out[0] = base * (1 + 0.3 * Math.sin(u * 7 * Math.PI));
    out[1] = u;
    out[2] = 0.03 * Math.sin(u * Math.PI);
}, { count: 7, length: 1.2, width: 0.6 });

registerLeafType("maple", function (u, out) {
    const base = 0.5 * Math.sin(Math.PI * Math.pow(u, 0.6));
    out[0] = base * (1 + 0.42 * Math.sin(u * 5 * Math.PI));
    out[1] = u - 0.05 * (1 - Math.min(1, u / 0.1));
    out[2] = 0.05 * Math.sin(u * Math.PI);
}, { count: 5, length: 1.15, width: 0.75 });

registerLeafType("fern", function (u, out) {
    out[0] = 0.3 * Math.sin(Math.PI * Math.pow(u, 0.55)) * (1 + 0.5 * Math.sin(u * 26));
    out[1] = u;
    out[2] = 0.12 * u * u;
}, { count: 9, length: 1.5, width: 0.4, bend: 0.3 });

registerLeafType("willow", function (u, out) {
    out[0] = 0.14 * Math.sin(Math.PI * Math.pow(u, 0.8)) * (1 - 0.4 * u);
    out[1] = u;
    out[2] = 0.2 * u * u;
}, { count: 12, length: 1.8, width: 0.2, bend: 0.45 });

registerLeafType("ivy", function (u, out) {
    const base = 0.46 * Math.sin(Math.PI * Math.pow(u, 0.55));
    out[0] = base * (1 + 0.24 * Math.sin(u * 3 * Math.PI));
    out[1] = u - 0.08 * (1 - Math.min(1, u / 0.14));
    out[2] = 0;
}, { count: 8, length: 0.9, width: 0.7 });

// ============================================================================
// Class Declarations — BloomBatchState
// ============================================================================
/**
 * BloomBatchState — reusable per-frame flora pipeline. Holds the spec, scene,
 * path arena, GPU buffers and animation state. Re-create after setPrecision()
 * to pick up the new array type.
 */
class BloomBatchState {
    constructor(maxInstances, options) {
        options = options || {};
        this.capacity = maxInstances || 4096;
        this.spec  = new BloomSpecSOA(options.maxLayers || MAX_LAYERS_DEFAULT);
        this.scene = new BloomSceneSOA(this.capacity);
        this.arena = createPath(options.pathCapacity || this.capacity * 8);
        this.vertices = new Float32Array(this.capacity * 96);
        this.matrices = new Float32Array(this.capacity * 16);
        this.instanceCount = 0;
        this.open = 1;
        this.time = 0;
        this.wind = 0;
        this.windDir = 0;
    }
    loadJSON(json) { loadBloomJSON(json, this.spec); return this; }
    loadPreset(name) { loadBloomPreset(name, this.spec); return this; }
    compose(options) {
        composeBloom(this.scene, this.spec, options);
        buildBloomPaths(this.scene, this.spec, this.arena);
        return this;
    }
    async composeAsync(options, cs, ye) {
        await composeBloomAsync(this.scene, this.spec, options, cs, ye);
        buildBloomPaths(this.scene, this.spec, this.arena);
        return this;
    }
    setOpen(t) { this.open = _clamp01(t); setBloomOpen(this.scene, this.open); return this; }
    step(dt) {
        this.time += dt;
        if (this.wind !== 0) applyWind(this.scene, this.time, this.wind, this.windDir);
        return this;
    }
    tagLOD(camX, camY, camZ, ppr, target, bias) {
        tagBloomLOD(this.scene, camX, camY, camZ, ppr, target, bias);
        return this;
    }
    toVertices(segments, maxLod) {
        return bloomToVertices(this.scene, this.arena, this.vertices, segments, maxLod);
    }
    toMatrices(camX, camY, camZ, maxLod) {
        this.instanceCount = bloomToInstanceMatrices(this.scene, this.matrices, camX, camY, camZ, maxLod);
        return this.instanceCount;
    }
    toSVG(options) { return bloomToSVG(this.scene, this.arena, options); }
    getBounds() { return bloomBounds(this.scene); }
    reset() {
        this.spec.reset();
        this.scene.clear();
        this.arena.clear();
        this.instanceCount = 0;
        return this;
    }
}

function createBloomBatch(maxInstances, options) {
    return new BloomBatchState(maxInstances, options);
}

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    core: {
        BloomSpecSOA, BloomSceneSOA, BloomBatchState,
        createBloomSpec, createBloomScene, createBloomBatch,
        ARR_RADIAL, ARR_PHYLLOTAXIS, ARR_OPPOSITE, ARR_ALTERNATE,
        ARR_WHORLED, ARR_SPIKE, ARR_ROSETTE, ARR_SCATTER, ARR_RING, ARR_SINGLE,
        FLAG_CLOSED, FLAG_MIRROR, FLAG_VISIBLE, FLAG_BILLBOARD
    },
    schema: {
        load: loadBloomJSON,
        toJSON: bloomSpecToJSON,
        parseColor: parseColorInto
    },
    generators: {
        register: registerBloomGenerator,
        get: getBloomGenerator,
        has: hasBloomGenerator,
        list: listBloomGenerators,
        idOf: generatorId,
        nameOf: generatorName
    },
    species: {
        registerLeaf: registerLeafType,
        registerGrass: registerGrassType,
        shapes: listPathShapes,
        profiles: listPointProfiles
    },
    presets: {
        register: registerBloomPreset,
        get: getBloomPreset,
        has: hasBloomPreset,
        list: listBloomPresets,
        load: loadBloomPreset
    },
    compose: {
        sync: composeBloom,
        async: composeBloomAsync,
        bindPaths: buildBloomPaths
    },
    animate: {
        setOpen: setBloomOpen,
        wind: applyWind,
        lod: tagBloomLOD,
        bounds: bloomBounds
    },
    emit: {
        svg: bloomToSVG,
        vertices: bloomToVertices,
        matrices: bloomToInstanceMatrices
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing scenes retain their buffers (Zero-GC); scenes created after a
// precision change pick up the live array type via getArrayType().
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Core
    BloomSpecSOA, BloomSceneSOA, BloomBatchState,
    createBloomSpec, createBloomScene, createBloomBatch,
    // Constants
    ARR_RADIAL, ARR_PHYLLOTAXIS, ARR_OPPOSITE, ARR_ALTERNATE,
    ARR_WHORLED, ARR_SPIKE, ARR_ROSETTE, ARR_SCATTER, ARR_RING, ARR_SINGLE,
    FLAG_CLOSED, FLAG_MIRROR, FLAG_VISIBLE, FLAG_BILLBOARD,
    // Schema
    loadBloomJSON, bloomSpecToJSON, parseColorInto,
    // Generator registry (extensible)
    registerBloomGenerator, getBloomGenerator, hasBloomGenerator,
    listBloomGenerators, generatorId, generatorName,
    shapeIdOf, shapeNameOf, profileIdOf, profileNameOf,
    // Species hooks (extensible leaves + grasses)
    registerLeafType, registerGrassType,
    // Presets
    registerBloomPreset, getBloomPreset, hasBloomPreset,
    listBloomPresets, loadBloomPreset,
    // Composition
    composeBloom, composeBloomAsync, buildBloomPaths,
    // Animation
    setBloomOpen, applyWind, tagBloomLOD, bloomBounds,
    // Emitters
    bloomToSVG, bloomToVertices, bloomToInstanceMatrices,
    // Namespace
    namespace
};

// ============================================================================
// ▶ VECTOR-BLOOM TRILOGY COMPLETE
//   082_vector-bloom-point.js — SOA points, curves, OPEN width-profile registry
//   083_vector-bloom-path.js  — SOA path arena, SVG/Canvas/WebGL, OPEN shape registry
//   084_vector-bloom.js       — JSON schema loader, SOA scene compositor,
//                               OPEN organ-generator + species + preset registries
//
//   Extension points (no core edits required):
//     registerPointProfile(name, fn, kind)   → new petal / leaf / blade silhouette
//     registerPathShape(name, fn)            → new SVG / GPU path emitter
//     registerBloomGenerator(name, fn)       → new organ arrangement
//     registerLeafType(name, widthFn, defs)  → full leaf species in one call
//     registerGrassType(name, widthFn, defs) → full grass species in one call
//     registerBloomPreset(name, json)        → new JSON flower descriptor
//     loadBloomJSON(json, spec)              → load any vector-bloom example file
//
//   OPTIONAL NEXT FILES (reply with the number to generate):
//     085_vector-bloom-species-pack.js  — 60+ leaf / grass / fern / succulent profiles
//     086_vector-bloom-lod-impostor.js  — billboard atlas baking + dithered LOD fade
//     087_vector-bloom-meadow-field.js  — 1M+ tile streaming, wind field, GPU culling
//     088_vector-bloom-growth.js        — L-system / space-colonisation branching
// ============================================================================