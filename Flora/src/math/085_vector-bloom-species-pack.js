// File : src/math/085_vector-bloom-species-pack.js
//description : Japanese-focus procedural flora species pack for the Vector-Bloom engine —
//              76 zero-GC width profiles and JSON presets spanning broadleaf leaves,
//              grasses / sedges / rushes, ferns, and succulents. Every species registers
//              simultaneously into 082's width-profile registry, 083's path-shape registry,
//              and 084's organ-generator / preset registries, so existing JSON flower
//              descriptors can reference species by name immediately. Includes SOA outline
//              and blade sampling, chunked async variants, and one-call species composition
//              into BloomSceneSOA / BloomSpecSOA / PathSOA buffers.
//best for : 3d graphics — Japanese garden / meadow / forest understory generation,
//           sakura / momiji / ginkgo / bamboo / susuki / zenmai / sedum foliage cards,
//           1M+ instanced leaf and grass blade fields, JSON-authored species libraries,
//           procedural ikebana and bonsai foliage, LOD impostor baking source geometry,
//           and mobile-safe chunked async species sampling on Android 64-bit.
//license : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — core math subsystem + Vector-Bloom trilogy)
// ============================================================================
import {
    common,
    getArrayType,
    onPrecisionChange
} from './000_Math_module.js';

import {
    registerPointProfile,
    hasPointProfile,
    getPointProfile,
    sampleProfileOutline,
    sampleProfileBlade,
    soaSampleProfileOutlines,
    soaSampleProfileOutlinesChunked,
    createPointSOA,
    PROFILE_CLOSED,
    PROFILE_BLADE,
    TAU,
    HALF_PI,
    EPSILON
} from './082_vector-bloom-point.js';

import {
    registerPathShape,
    hasPathShape,
    emitProfileOutline,
    emitProfileBlade,
    createPath
} from './083_vector-bloom-path.js';

import {
    registerLeafType,
    registerGrassType,
    registerBloomGenerator,
    getBloomGenerator,
    registerBloomPreset,
    loadBloomPreset,
    composeBloom,
    composeBloomAsync,
    buildBloomPaths,
    createBloomSpec,
    BloomSpecSOA,
    BloomSceneSOA
} from './084_vector-bloom.js';

// ============================================================================
// Global Declarations — constants
// ============================================================================
const PI = Math.PI;

const KIND_LEAF      = 0;
const KIND_GRASS     = 1;
const KIND_FERN      = 2;
const KIND_SUCCULENT = 3;

const KIND_NAMES = ["leaf", "grass", "fern", "succulent"];

// ============================================================================
// Species registry — plain objects + parallel arrays (no Map / Set)
// ============================================================================
const _speciesRegistry = Object.create(null);
const _speciesAlias    = Object.create(null);
const _speciesNames    = [];
const _speciesKinds    = [];
const _speciesProfiles = [];
const _speciesPresets  = [];
const _speciesTags     = [];

function _addSpecies(name, kind, profileName, presetName, tags) {
    const id = _speciesNames.length;
    _speciesNames.push(name);
    _speciesKinds.push(kind);
    _speciesProfiles.push(profileName);
    _speciesPresets.push(presetName);
    _speciesTags.push(tags || "");
    _speciesRegistry[name] = id;
    return id;
}

function _aliasSpecies(alias, target) {
    const id = _speciesRegistry[target];
    if (id !== undefined) _speciesAlias[alias] = id;
    return alias;
}

function _speciesId(nameOrId) {
    if (typeof nameOrId === "number") return nameOrId | 0;
    const n = String(nameOrId || "sakura");
    let id = _speciesRegistry[n];
    if (id === undefined) id = _speciesAlias[n];
    return id === undefined ? 0 : id;
}

function listVectorBloomSpecies() { return _speciesNames; }
function listVectorBloomSpeciesByKind(kind) {
    const k = typeof kind === "number" ? kind : KIND_NAMES.indexOf(String(kind));
    const out = [];
    for (let i = 0; i < _speciesNames.length; i++) if (_speciesKinds[i] === k) out.push(_speciesNames[i]);
    return out;
}
function getVectorBloomSpecies(nameOrId) {
    const id = _speciesId(nameOrId);
    return {
        id: id,
        name: _speciesNames[id],
        kind: KIND_NAMES[_speciesKinds[id]],
        kindId: _speciesKinds[id],
        profile: _speciesProfiles[id],
        preset: _speciesPresets[id],
        tags: _speciesTags[id]
    };
}
function getSpeciesProfileName(nameOrId) { return _speciesProfiles[_speciesId(nameOrId)]; }
function getSpeciesKind(nameOrId) { return _speciesKinds[_speciesId(nameOrId)]; }
function getSpeciesPresetName(nameOrId) { return _speciesPresets[_speciesId(nameOrId)]; }
function hasVectorBloomSpecies(name) {
    return _speciesRegistry[name] !== undefined || _speciesAlias[name] !== undefined;
}
function vectorBloomSpeciesCount() { return _speciesNames.length; }

// ============================================================================
// Parametric profile makers — closures created once at init, never per frame
// ============================================================================
function _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** General leaf / petal width profile with lobes, serration, curl and notch. */
function _makeLeaf(base, pow, taper, lobeAmp, lobeFreq, serrAmp, serrFreq, curl, notch) {
    return function (u, out) {
        let w = base * Math.sin(PI * Math.pow(u, pow)) * (1 - taper * u);
        if (lobeAmp !== 0) w *= 1 + lobeAmp * Math.sin(u * lobeFreq * PI);
        if (serrAmp !== 0) w *= 1 + serrAmp * Math.sin(u * serrFreq);
        let y = u;
        if (notch !== 0 && u > 0.86) {
            const k = (u - 0.86) / 0.14;
            y -= notch * k * k;
        }
        out[0] = w > 0 ? w : 0;
        out[1] = y;
        out[2] = curl * u * u;
    };
}

/** Ginkgo / fan leaf — broad tip, narrow base, bilobed apical notch. */
function _makeFan(base, pow, notch, curl) {
    return function (u, out) {
        let w = base * (0.12 + 0.88 * Math.pow(u, pow));
        w *= 1 - 0.10 * Math.sin(u * 2 * PI);
        let y = u;
        if (u > 0.82) {
            const k = (u - 0.82) / 0.18;
            y -= notch * k * k;
        }
        out[0] = w;
        out[1] = y;
        out[2] = curl * u * u;
    };
}

/** Grass / sedge / rush blade — narrow, tapering, wind-curled. */
function _makeGrass(base, pow, taper, curl, bend) {
    return function (u, out) {
        const w = base * Math.sin(PI * Math.pow(u, pow)) * (1 - taper * u);
        out[0] = w > 0 ? w : 0;
        out[1] = u;
        out[2] = curl * u * u + bend * u * u * u;
    };
}

/** Fern frond — pinnae lobes along a tapering rachis. */
function _makeFern(base, pow, pinnae, amp, curl) {
    return function (u, out) {
        const body = base * Math.sin(PI * Math.pow(u, pow)) * (1 - 0.35 * u);
        const lobes = 1 + amp * Math.sin(u * pinnae * PI);
        out[0] = body * lobes;
        out[1] = u;
        out[2] = curl * u * u;
    };
}

/** Succulent leaf — fleshy, thick, rounded tip. */
function _makeSucculent(base, pow, tip, curl) {
    return function (u, out) {
        const s = Math.sin(PI * Math.pow(u, pow));
        const w = base * Math.pow(s > 0 ? s : 0, 0.65) * (1 - tip * u);
        out[0] = w;
        out[1] = u;
        out[2] = curl * u * u;
    };
}

// ============================================================================
// Registration helpers
// ============================================================================
function _registerLeafSpecies(name, fn, defaults, tags) {
    const profileName = registerLeafType(name, fn, defaults);
    _addSpecies(name, KIND_LEAF, profileName, name, tags || "japan,leaf");
    return profileName;
}

function _registerGrassSpecies(name, fn, defaults, tags) {
    const profileName = registerGrassType(name, fn, defaults);
    _addSpecies(name, KIND_GRASS, profileName, name, tags || "japan,grass");
    return profileName;
}

function _registerPathProfile(profileName, fn, kind, emitter) {
    registerPointProfile(profileName, fn, kind);
    if (!hasPathShape(profileName)) {
        registerPathShape(profileName, function (path, p) {
            p.profile = profileName;
            return emitter(path, p);
        });
    }
}

function _registerFernSpecies(name, fn, defaults, tags) {
    const profileName = "fern-" + name;
    _registerPathProfile(profileName, fn, PROFILE_CLOSED, emitProfileOutline);
    const preset = {
        name: name,
        seed: 1,
        layers: [{
            generator: "fern-frond",
            shape: profileName,
            profile: profileName,
            count: 7,
            length: 1.2,
            width: 0.35,
            span: 1.0,
            radius: 0.05,
            bend: 0.25,
            curl: 0.1,
            color: "leaf",
            closed: true,
            visible: true
        }]
    };
    if (defaults) { const L = preset.layers[0]; for (const k in defaults) L[k] = defaults[k]; }
    registerBloomPreset(name, preset);
    _addSpecies(name, KIND_FERN, profileName, name, tags || "japan,fern");
    return profileName;
}

function _registerSucculentSpecies(name, fn, defaults, tags) {
    const profileName = "succulent-" + name;
    _registerPathProfile(profileName, fn, PROFILE_CLOSED, emitProfileOutline);
    const preset = {
        name: name,
        seed: 1,
        layers: [{
            generator: "succulent-rosette",
            shape: profileName,
            profile: profileName,
            count: 12,
            length: 0.8,
            width: 0.5,
            radius: 0.05,
            curl: 0.08,
            color: "green",
            closed: true,
            visible: true
        }]
    };
    if (defaults) { const L = preset.layers[0]; for (const k in defaults) L[k] = defaults[k]; }
    registerBloomPreset(name, preset);
    _addSpecies(name, KIND_SUCCULENT, profileName, name, tags || "succulent");
    return profileName;
}

// ============================================================================
// Custom organ generators for fern / succulent presets
// ============================================================================
registerBloomGenerator("fern-frond", function (scene, spec, li, base, ctx) {
    return getBloomGenerator("leaf-alternate")(scene, spec, li, base, ctx);
});

registerBloomGenerator("succulent-rosette", function (scene, spec, li, base, ctx) {
    return getBloomGenerator("leaf-rosette")(scene, spec, li, base, ctx);
});

// ============================================================================
// Species registrations — 27 leaves
// ============================================================================
_registerLeafSpecies("sakura",        _makeLeaf(0.46, 0.72, 0.25, 0.00, 0, 0.08, 42, 0.02, 0.00), { count: 7, length: 1.0, width: 0.46, serration: 0.08 }, "japan,prunus,serrulata");
_registerLeafSpecies("yamazakura",    _makeLeaf(0.44, 0.70, 0.30, 0.00, 0, 0.10, 46, 0.03, 0.00), { count: 7, length: 1.0, width: 0.44 }, "japan,prunus,mountain");
_registerLeafSpecies("someiyoshino",  _makeLeaf(0.42, 0.75, 0.28, 0.00, 0, 0.07, 40, 0.02, 0.00), { count: 7, length: 0.95, width: 0.42 }, "japan,prunus,yoshino");
_registerLeafSpecies("ukezakura",     _makeLeaf(0.48, 0.68, 0.22, 0.00, 0, 0.09, 44, 0.02, 0.00), { count: 7, length: 1.05, width: 0.48 }, "japan,prunus");
_registerLeafSpecies("momiji",        _makeLeaf(0.50, 0.60, 0.10, 0.42, 5, 0.05, 30, 0.04, 0.05), { count: 6, length: 1.1, width: 0.6 }, "japan,acer,palmatum");
_registerLeafSpecies("iroha-momiji",  _makeLeaf(0.48, 0.58, 0.12, 0.50, 7, 0.04, 28, 0.05, 0.06), { count: 6, length: 1.05, width: 0.58 }, "japan,acer");
_registerLeafSpecies("kaede",         _makeLeaf(0.52, 0.62, 0.08, 0.35, 5, 0.03, 26, 0.03, 0.04), { count: 6, length: 1.15, width: 0.62 }, "japan,acer");
_registerLeafSpecies("ichou",         _makeFan(0.62, 0.70, 0.18, 0.08),                              { count: 8, length: 0.9, width: 0.7 }, "japan,ginkgo,biloba");
_registerLeafSpecies("keyaki",        _makeLeaf(0.42, 0.80, 0.35, 0.00, 0, 0.12, 52, 0.02, 0.00), { count: 8, length: 1.1, width: 0.42 }, "japan,zelkova,serrata");
_registerLeafSpecies("katsura",       _makeLeaf(0.50, 0.55, 0.15, 0.10, 3, 0.02, 20, 0.02, 0.08), { count: 7, length: 0.95, width: 0.55 }, "japan,cercidiphyllum");
_registerLeafSpecies("tsubaki",       _makeLeaf(0.42, 0.85, 0.35, 0.00, 0, 0.03, 18, 0.01, 0.00), { count: 8, length: 1.0, width: 0.42 }, "japan,camellia");
_registerLeafSpecies("sasanqua",      _makeLeaf(0.36, 0.85, 0.40, 0.00, 0, 0.03, 20, 0.01, 0.00), { count: 8, length: 0.85, width: 0.36 }, "japan,camellia,sasanqua");
_registerLeafSpecies("tsutsuji",      _makeLeaf(0.34, 0.80, 0.35, 0.00, 0, 0.02, 16, 0.01, 0.00), { count: 9, length: 0.7, width: 0.34 }, "japan,azalea");
_registerLeafSpecies("ajisai",        _makeLeaf(0.55, 0.60, 0.15, 0.08, 4, 0.08, 36, 0.02, 0.03), { count: 7, length: 1.1, width: 0.6 }, "japan,hydrangea");
_registerLeafSpecies("kashiwa",       _makeLeaf(0.46, 0.70, 0.20, 0.25, 7, 0.03, 24, 0.02, 0.00), { count: 7, length: 1.2, width: 0.5 }, "japan,oak");
_registerLeafSpecies("kuwa",          _makeLeaf(0.50, 0.65, 0.20, 0.15, 5, 0.08, 40, 0.02, 0.04), { count: 7, length: 1.0, width: 0.55 }, "japan,mulberry");
_registerLeafSpecies("ume",           _makeLeaf(0.38, 0.75, 0.30, 0.00, 0, 0.06, 36, 0.02, 0.00), { count: 7, length: 0.85, width: 0.38 }, "japan,plum");
_registerLeafSpecies("fuji",          _makeLeaf(0.36, 0.80, 0.35, 0.00, 0, 0.02, 18, 0.02, 0.00), { count: 9, length: 0.8, width: 0.36 }, "japan,wisteria");
_registerLeafSpecies("botan",         _makeLeaf(0.50, 0.65, 0.15, 0.20, 5, 0.04, 28, 0.03, 0.03), { count: 7, length: 1.0, width: 0.55 }, "japan,peony");
_registerLeafSpecies("yuzu",          _makeLeaf(0.34, 0.80, 0.35, 0.00, 0, 0.02, 14, 0.01, 0.00), { count: 8, length: 0.8, width: 0.34 }, "japan,citrus");
_registerLeafSpecies("hiiragi",       _makeLeaf(0.40, 0.75, 0.25, 0.18, 6, 0.18, 12, 0.01, 0.00), { count: 7, length: 0.9, width: 0.42 }, "japan,holly,osmanthus");
_registerLeafSpecies("nandina",       _makeLeaf(0.30, 0.85, 0.40, 0.00, 0, 0.01, 12, 0.01, 0.00), { count: 9, length: 0.75, width: 0.3 }, "japan,nandina");
_registerLeafSpecies("shidare-yanagi",_makeLeaf(0.14, 0.80, 0.40, 0.00, 0, 0.01, 10, 0.20, 0.00), { count: 12, length: 1.6, width: 0.16, bend: 0.4 }, "japan,willow");
_registerLeafSpecies("daidai",        _makeLeaf(0.36, 0.80, 0.32, 0.00, 0, 0.02, 16, 0.01, 0.00), { count: 8, length: 0.85, width: 0.36 }, "japan,citrus,daidai");
_registerLeafSpecies("aokiba",        _makeLeaf(0.40, 0.80, 0.30, 0.00, 0, 0.01, 12, 0.01, 0.00), { count: 8, length: 0.9, width: 0.4 }, "japan,aucuba");
_registerLeafSpecies("take",          _makeLeaf(0.16, 0.80, 0.50, 0.00, 0, 0.00, 0, 0.05, 0.00),  { count: 10, length: 1.3, width: 0.18 }, "japan,bamboo");
_registerLeafSpecies("enoki",         _makeLeaf(0.32, 0.80, 0.35, 0.00, 0, 0.02, 18, 0.01, 0.00), { count: 8, length: 0.85, width: 0.32 }, "japan,hackberry");

// ============================================================================
// Species registrations — 18 grasses / sedges / rushes
// ============================================================================
_registerGrassSpecies("susuki",                 _makeGrass(0.055, 0.50, 0.75, 0.16, 0.10), { count: 40, length: 1.3, width: 0.09, spread: 0.4 }, "japan,miscanthus,pampas");
_registerGrassSpecies("yoshi",                  _makeGrass(0.075, 0.35, 0.55, 0.30, 0.20), { count: 18, length: 2.2, width: 0.12, spread: 0.5 }, "japan,phragmites,reed");
_registerGrassSpecies("kumazasa",               _makeGrass(0.090, 0.45, 0.60, 0.08, 0.05), { count: 28, length: 0.9, width: 0.14, spread: 0.35 }, "japan,bamboo-grass");
_registerGrassSpecies("shiba",                  _makeGrass(0.030, 0.50, 0.80, 0.05, 0.03), { count: 64, length: 0.5, width: 0.05, spread: 0.4 }, "japan,zoysia,lawn");
_registerGrassSpecies("hakonechloa",            _makeGrass(0.070, 0.55, 0.65, 0.22, 0.15), { count: 32, length: 0.8, width: 0.11, spread: 0.35 }, "japan,hakone-grass");
_registerGrassSpecies("imperata",               _makeGrass(0.040, 0.50, 0.75, 0.12, 0.08), { count: 36, length: 0.9, width: 0.07, spread: 0.35 }, "japan,blood-grass");
_registerGrassSpecies("carex-morrowii",         _makeGrass(0.050, 0.45, 0.70, 0.18, 0.12), { count: 34, length: 0.85, width: 0.08, spread: 0.35 }, "japan,sedge");
_registerGrassSpecies("jaburan",                _makeGrass(0.045, 0.50, 0.70, 0.14, 0.10), { count: 30, length: 0.8, width: 0.07, spread: 0.3 }, "japan,ophiopogon");
_registerGrassSpecies("yaburan",                _makeGrass(0.050, 0.50, 0.68, 0.16, 0.10), { count: 30, length: 0.85, width: 0.08, spread: 0.3 }, "japan,liriope");
_registerGrassSpecies("pennisetum",             _makeGrass(0.040, 0.55, 0.80, 0.20, 0.15), { count: 42, length: 1.0, width: 0.07, spread: 0.4 }, "japan,fountain-grass");
_registerGrassSpecies("miscanthus-sacchariflorus",_makeGrass(0.060, 0.45, 0.70, 0.18, 0.12), { count: 30, length: 1.6, width: 0.1, spread: 0.45 }, "japan,miscanthus");
_registerGrassSpecies("arundinella",            _makeGrass(0.040, 0.50, 0.75, 0.14, 0.10), { count: 40, length: 1.0, width: 0.06, spread: 0.4 }, "japan,arundinella");
_registerGrassSpecies("themeda-japonica",       _makeGrass(0.045, 0.50, 0.75, 0.16, 0.10), { count: 38, length: 1.1, width: 0.07, spread: 0.4 }, "japan,themeda");
_registerGrassSpecies("juncus",                 _makeGrass(0.025, 0.40, 0.85, 0.08, 0.05), { count: 48, length: 1.0, width: 0.04, spread: 0.35 }, "japan,rush");
_registerGrassSpecies("acorus",                 _makeGrass(0.060, 0.50, 0.60, 0.10, 0.06), { count: 26, length: 1.1, width: 0.1, spread: 0.35 }, "japan,sweet-flag");
_registerGrassSpecies("bambusa",                _makeGrass(0.080, 0.45, 0.60, 0.12, 0.08), { count: 22, length: 1.8, width: 0.12, spread: 0.45 }, "japan,bamboo");
_registerGrassSpecies("sasa",                   _makeGrass(0.080, 0.45, 0.60, 0.08, 0.05), { count: 28, length: 0.95, width: 0.13, spread: 0.35 }, "japan,sasa");
_registerGrassSpecies("festuca",                _makeGrass(0.022, 0.50, 0.80, 0.24, 0.16), { count: 64, length: 0.7, width: 0.04, spread: 0.4 }, "fescue");

// ============================================================================
// Species registrations — 14 ferns
// ============================================================================
_registerFernSpecies("zenmai",                 _makeFern(0.34, 0.55, 10, 0.35, 0.12), { count: 7, length: 1.3, width: 0.38 }, "japan,royal-fern");
_registerFernSpecies("warabi",                 _makeFern(0.30, 0.50, 12, 0.40, 0.15), { count: 7, length: 1.2, width: 0.34 }, "japan,bracken");
_registerFernSpecies("kogomi",                 _makeFern(0.32, 0.55, 14, 0.45, 0.10), { count: 7, length: 1.25, width: 0.36 }, "japan,ostrich-fern");
_registerFernSpecies("shida",                  _makeFern(0.30, 0.60, 16, 0.50, 0.08), { count: 8, length: 1.1, width: 0.34 }, "japan,fern");
_registerFernSpecies("nokishinobu",            _makeFern(0.28, 0.60, 18, 0.55, 0.10), { count: 8, length: 1.0, width: 0.32 }, "japan,fern");
_registerFernSpecies("japanese-painted-fern",  _makeFern(0.30, 0.60, 14, 0.45, 0.08), { count: 8, length: 1.05, width: 0.34, color: "violet" }, "japan,athyrium");
_registerFernSpecies("holly-fern",             _makeFern(0.32, 0.70, 8, 0.30, 0.04), { count: 7, length: 1.0, width: 0.36 }, "japan,cyrtomium");
_registerFernSpecies("maidenhair",             _makeFern(0.26, 0.60, 10, 0.35, 0.06), { count: 9, length: 0.85, width: 0.3 }, "japan,adiantum");
_registerFernSpecies("wood-fern",              _makeFern(0.30, 0.60, 16, 0.50, 0.08), { count: 8, length: 1.1, width: 0.34 }, "fern,dryopteris");
_registerFernSpecies("lady-fern",              _makeFern(0.28, 0.60, 18, 0.55, 0.09), { count: 8, length: 1.05, width: 0.32 }, "fern,athyrium");
_registerFernSpecies("ostrich-fern",           _makeFern(0.34, 0.55, 14, 0.45, 0.10), { count: 7, length: 1.3, width: 0.38 }, "fern,matteuccia");
_registerFernSpecies("royal-fern",             _makeFern(0.32, 0.55, 10, 0.35, 0.12), { count: 7, length: 1.3, width: 0.36 }, "fern,osmunda");
_registerFernSpecies("bracken",                _makeFern(0.30, 0.50, 12, 0.40, 0.15), { count: 7, length: 1.2, width: 0.34 }, "fern,pteridium");
_registerFernSpecies("bamboo-fern",            _makeFern(0.24, 0.65, 8, 0.25, 0.05), { count: 8, length: 0.9, width: 0.28 }, "fern,conogramme");

// ============================================================================
// Species registrations — 17 succulents
// ============================================================================
_registerSucculentSpecies("echeveria",              _makeSucculent(0.50, 0.65, 0.25, 0.08), { count: 14, length: 0.8, width: 0.55 }, "succulent,echeveria");
_registerSucculentSpecies("haworthia",              _makeSucculent(0.34, 0.70, 0.35, 0.12), { count: 16, length: 0.7, width: 0.38 }, "succulent,haworthia");
_registerSucculentSpecies("sedum-japonicum",        _makeSucculent(0.22, 0.60, 0.30, 0.06), { count: 18, length: 0.5, width: 0.26 }, "japan,sedum");
_registerSucculentSpecies("sedum-makinoi",          _makeSucculent(0.18, 0.60, 0.35, 0.05), { count: 20, length: 0.45, width: 0.22 }, "japan,sedum");
_registerSucculentSpecies("sedum-sarmentosum",      _makeSucculent(0.20, 0.60, 0.30, 0.06), { count: 18, length: 0.5, width: 0.24 }, "japan,sedum");
_registerSucculentSpecies("sedum-album",            _makeSucculent(0.18, 0.60, 0.35, 0.05), { count: 20, length: 0.45, width: 0.22 }, "sedum");
_registerSucculentSpecies("sedum-reflexum",         _makeSucculent(0.14, 0.65, 0.45, 0.08), { count: 22, length: 0.5, width: 0.18 }, "sedum");
_registerSucculentSpecies("sedum-spurium",          _makeSucculent(0.22, 0.60, 0.30, 0.06), { count: 18, length: 0.5, width: 0.26 }, "sedum");
_registerSucculentSpecies("sedum-kamtschaticum",    _makeSucculent(0.24, 0.60, 0.30, 0.06), { count: 18, length: 0.55, width: 0.28 }, "japan,sedum");
_registerSucculentSpecies("phedimus-takesimensis",  _makeSucculent(0.24, 0.60, 0.30, 0.06), { count: 18, length: 0.55, width: 0.28 }, "japan,phedimus");
_registerSucculentSpecies("sempervivum",            _makeSucculent(0.30, 0.65, 0.35, 0.08), { count: 16, length: 0.65, width: 0.34 }, "succulent,sempervivum");
_registerSucculentSpecies("aeonium",                _makeSucculent(0.40, 0.65, 0.25, 0.07), { count: 14, length: 0.75, width: 0.45 }, "succulent,aeonium");
_registerSucculentSpecies("crassula",               _makeSucculent(0.32, 0.65, 0.30, 0.06), { count: 16, length: 0.65, width: 0.36 }, "succulent,crassula");
_registerSucculentSpecies("kalanchoe",              _makeSucculent(0.36, 0.65, 0.28, 0.06), { count: 14, length: 0.7, width: 0.4 }, "succulent,kalanchoe");
_registerSucculentSpecies("graptopetalum",          _makeSucculent(0.38, 0.65, 0.30, 0.07), { count: 14, length: 0.7, width: 0.42 }, "succulent,graptopetalum");
_registerSucculentSpecies("pachyphytum",            _makeSucculent(0.36, 0.65, 0.32, 0.07), { count: 14, length: 0.7, width: 0.4 }, "succulent,pachyphytum");
_registerSucculentSpecies("cotyledon",              _makeSucculent(0.34, 0.65, 0.30, 0.06), { count: 14, length: 0.68, width: 0.38 }, "succulent,cotyledon");

// ============================================================================
// Aliases — common / romanised / scientific names
// ============================================================================
_aliasSpecies("ginkgo", "ichou");
_aliasSpecies("ginkgo-biloba", "ichou");
_aliasSpecies("japanese-maple", "momiji");
_aliasSpecies("acer-palmatum", "momiji");
_aliasSpecies("cherry-leaf", "sakura");
_aliasSpecies("prunus-serrulata", "sakura");
_aliasSpecies("camellia", "tsubaki");
_aliasSpecies("hydrangea", "ajisai");
_aliasSpecies("azalea", "tsutsuji");
_aliasSpecies("bamboo-leaf", "take");
_aliasSpecies("bamboo-grass", "kumazasa");
_aliasSpecies("pampas-grass", "susuki");
_aliasSpecies("miscanthus", "susuki");
_aliasSpecies("reed", "yoshi");
_aliasSpecies("zoysia", "shiba");
_aliasSpecies("hakone-grass", "hakonechloa");
_aliasSpecies("blood-grass", "imperata");
_aliasSpecies("sedge", "carex-morrowii");
_aliasSpecies("ophiopogon", "jaburan");
_aliasSpecies("liriope", "yaburan");
_aliasSpecies("royal-fern", "zenmai");
_aliasSpecies("bracken", "warabi");
_aliasSpecies("ostrich-fern", "kogomi");
_aliasSpecies("athyrium-niponicum", "japanese-painted-fern");
_aliasSpecies("cyrtomium-falcatum", "holly-fern");
_aliasSpecies("adiantum", "maidenhair");
_aliasSpecies("sedum", "sedum-japonicum");
_aliasSpecies("phedimus", "phedimus-takesimensis");
_aliasSpecies("hens-and-chicks", "sempervivum");
_aliasSpecies("jade-plant", "crassula");
_aliasSpecies("echeveria-elegans", "echeveria");
_aliasSpecies("haworthia-fasciata", "haworthia");
_aliasSpecies("willow", "shidare-yanagi");
_aliasSpecies("wisteria", "fuji");
_aliasSpecies("peony", "botan");
_aliasSpecies("citrus", "yuzu");
_aliasSpecies("holly", "hiiragi");
_aliasSpecies("mulberry", "kuwa");
_aliasSpecies("oak", "kashiwa");
_aliasSpecies("zelkova", "keyaki");
_aliasSpecies("katsura-tree", "katsura");
_aliasSpecies("plum-leaf", "ume");
_aliasSpecies("nandina-domestica", "nandina");
_aliasSpecies("aucuba", "aokiba");
_aliasSpecies("hackberry", "enoki");
_aliasSpecies("sweet-flag", "acorus");
_aliasSpecies("rush", "juncus");
_aliasSpecies("fountain-grass", "pennisetum");
_aliasSpecies("themeda", "themeda-japonica");
_aliasSpecies("arundinella-hirta", "arundinella");
_aliasSpecies("miscanthus-sacchariflorus", "miscanthus-sacchariflorus");
_aliasSpecies("fescue", "festuca");
_aliasSpecies("dryopteris", "wood-fern");
_aliasSpecies("lady-fern", "lady-fern");
_aliasSpecies("matteuccia", "ostrich-fern");
_aliasSpecies("osmunda", "royal-fern");
_aliasSpecies("pteridium", "bracken");
_aliasSpecies("conogramme", "bamboo-fern");
_aliasSpecies("sedum-album", "sedum-album");
_aliasSpecies("sedum-reflexum", "sedum-reflexum");
_aliasSpecies("sedum-spurium", "sedum-spurium");
_aliasSpecies("sedum-kamtschaticum", "sedum-kamtschaticum");
_aliasSpecies("sedum-makinoi", "sedum-makinoi");
_aliasSpecies("sedum-sarmentosum", "sedum-sarmentosum");
_aliasSpecies("aeonium-arboreum", "aeonium");
_aliasSpecies("graptopetalum-paraguayense", "graptopetalum");
_aliasSpecies("pachyphytum-oviferum", "pachyphytum");
_aliasSpecies("cotyledon-orbiculata", "cotyledon");
_aliasSpecies("kalanchoe-blossfeldiana", "kalanchoe");
_aliasSpecies("crassula-ovata", "crassula");
_aliasSpecies("sempervivum-tectorum", "sempervivum");

// ============================================================================
// Function Declarations — species sampling (Zero-GC)
// ============================================================================
/** Sample one species outline / blade into a PointSOA. Returns point count. */
function sampleSpecies(outPoints, nameOrId, segments, scaleX, scaleY) {
    const id = _speciesId(nameOrId);
    const profileName = _speciesProfiles[id];
    const kind = _speciesKinds[id];
    if (kind === KIND_GRASS) return sampleProfileBlade(outPoints, profileName, segments, scaleX, scaleY, 0);
    return sampleProfileOutline(outPoints, profileName, segments, scaleX, scaleY, 0);
}

/** Batch closed-outline sampling for a species. Returns total points written. */
function soaSampleSpeciesOutlines(out, nameOrId, count, segments, scaleX, scaleY) {
    const profileName = _speciesProfiles[_speciesId(nameOrId)];
    return soaSampleProfileOutlines(out, profileName, count, segments, scaleX, scaleY);
}

/** Batch single-sided blade sampling for a species. Zero-GC. */
function soaSampleSpeciesBlades(out, nameOrId, count, segments, scaleX, scaleY) {
    const profileName = _speciesProfiles[_speciesId(nameOrId)];
    const fn = getPointProfile(profileName);
    const seg = segments < 2 ? 2 : segments;
    const need = count * seg;
    if (out.capacity < need) out.resize(need);
    const ox = out.x, oy = out.y, oz = out.z;
    const sxArr = scaleX && scaleX.BYTES_PER_ELEMENT !== undefined ? scaleX : null;
    const syArr = scaleY && scaleY.BYTES_PER_ELEMENT !== undefined ? scaleY : null;
    const sx = sxArr ? 1 : (scaleX === undefined ? 1 : scaleX);
    const sy = syArr ? 1 : (scaleY === undefined ? 1 : scaleY);
    const inv = 1 / (seg - 1);
    const scratch = _bladeScratch();
    for (let c = 0; c < count; c++) {
        const kx = sxArr ? sxArr[c] : sx;
        const ky = syArr ? syArr[c] : sy;
        const base = c * seg;
        for (let i = 0; i < seg; i++) {
            fn(i * inv, scratch);
            const o = base + i;
            ox[o] = scratch[0] * kx;
            oy[o] = scratch[1] * ky;
            oz[o] = scratch[2] * ky;
        }
    }
    out.count = need;
    return need;
}

let _bladeScratchBuf = null;
function _bladeScratch() {
    if (_bladeScratchBuf === null) _bladeScratchBuf = new Float64Array(3);
    return _bladeScratchBuf;
}

// ============================================================================
// Function Declarations — species composition into Vector-Bloom buffers
// ============================================================================
/** Load a species preset into a BloomSpecSOA (load-time). */
function loadSpeciesPreset(nameOrId, specOut) {
    const presetName = _speciesPresets[_speciesId(nameOrId)];
    return loadBloomPreset(presetName, specOut);
}

/** Create a fresh BloomSpecSOA for a species (init-time). */
function createSpeciesSpec(nameOrId, maxLayers) {
    const spec = createBloomSpec(maxLayers);
    loadSpeciesPreset(nameOrId, spec);
    return spec;
}

/** Compose a species into caller-provided scene / spec / path arena. Zero-GC. */
function composeSpeciesInto(scene, spec, arena, nameOrId, options) {
    loadSpeciesPreset(nameOrId, spec);
    composeBloom(scene, spec, options);
    buildBloomPaths(scene, spec, arena);
    return scene.count;
}

/** Chunked async species composition. */
async function composeSpeciesIntoAsync(scene, spec, arena, nameOrId, options, chunkSize, yieldEvery) {
    loadSpeciesPreset(nameOrId, spec);
    await composeBloomAsync(scene, spec, options, chunkSize, yieldEvery);
    buildBloomPaths(scene, spec, arena);
    return scene.count;
}

// ============================================================================
// Function Declarations — SOA (chunked async, inlined loops, zero closures)
// ============================================================================
async function soaSampleSpeciesOutlinesChunked(out, nameOrId, count, segments, scaleX, scaleY, cs, ye) {
    const profileName = _speciesProfiles[_speciesId(nameOrId)];
    return soaSampleProfileOutlinesChunked(out, profileName, count, segments, scaleX, scaleY, cs, ye);
}

async function soaSampleSpeciesBladesChunked(out, nameOrId, count, segments, scaleX, scaleY, cs, ye) {
    const profileName = _speciesProfiles[_speciesId(nameOrId)];
    const fn = getPointProfile(profileName);
    const seg = segments < 2 ? 2 : segments;
    const need = count * seg;
    if (out.capacity < need) out.resize(need);
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const ox = out.x, oy = out.y, oz = out.z;
    const sxArr = scaleX && scaleX.BYTES_PER_ELEMENT !== undefined ? scaleX : null;
    const syArr = scaleY && scaleY.BYTES_PER_ELEMENT !== undefined ? scaleY : null;
    const sx = sxArr ? 1 : (scaleX === undefined ? 1 : scaleX);
    const sy = syArr ? 1 : (scaleY === undefined ? 1 : scaleY);
    const inv = 1 / (seg - 1);
    const scratch = _bladeScratch();
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let ci = start; ci < end; ci++) {
            const kx = sxArr ? sxArr[ci] : sx;
            const ky = syArr ? syArr[ci] : sy;
            const base = ci * seg;
            for (let i = 0; i < seg; i++) {
                fn(i * inv, scratch);
                const o = base + i;
                ox[o] = scratch[0] * kx;
                oy[o] = scratch[1] * ky;
                oz[o] = scratch[2] * ky;
            }
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    out.count = need;
    return need;
}

// ============================================================================
// Function Declarations — runtime species extension
// ============================================================================
/** Register a new leaf species at runtime (init / authoring time). */
function registerSpeciesLeaf(name, widthFn, defaults, tags) {
    return _registerLeafSpecies(name, widthFn, defaults, tags);
}
/** Register a new grass species at runtime. */
function registerSpeciesGrass(name, widthFn, defaults, tags) {
    return _registerGrassSpecies(name, widthFn, defaults, tags);
}
/** Register a new fern species at runtime. */
function registerSpeciesFern(name, widthFn, defaults, tags) {
    return _registerFernSpecies(name, widthFn, defaults, tags);
}
/** Register a new succulent species at runtime. */
function registerSpeciesSucculent(name, widthFn, defaults, tags) {
    return _registerSucculentSpecies(name, widthFn, defaults, tags);
}
/** Add an alias for an existing species. */
function registerSpeciesAlias(alias, target) { return _aliasSpecies(alias, target); }

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    registry: {
        list: listVectorBloomSpecies,
        listByKind: listVectorBloomSpeciesByKind,
        get: getVectorBloomSpecies,
        has: hasVectorBloomSpecies,
        count: vectorBloomSpeciesCount,
        profileName: getSpeciesProfileName,
        presetName: getSpeciesPresetName,
        kind: getSpeciesKind,
        alias: registerSpeciesAlias
    },
    kinds: {
        LEAF: KIND_LEAF,
        GRASS: KIND_GRASS,
        FERN: KIND_FERN,
        SUCCULENT: KIND_SUCCULENT,
        names: KIND_NAMES
    },
    register: {
        leaf: registerSpeciesLeaf,
        grass: registerSpeciesGrass,
        fern: registerSpeciesFern,
        succulent: registerSpeciesSucculent
    },
    sample: {
        one: sampleSpecies,
        outlines: soaSampleSpeciesOutlines,
        outlinesChunked: soaSampleSpeciesOutlinesChunked,
        blades: soaSampleSpeciesBlades,
        bladesChunked: soaSampleSpeciesBladesChunked
    },
    compose: {
        loadPreset: loadSpeciesPreset,
        createSpec: createSpeciesSpec,
        into: composeSpeciesInto,
        intoAsync: composeSpeciesIntoAsync
    },
    makers: {
        leaf: _makeLeaf,
        fan: _makeFan,
        grass: _makeGrass,
        fern: _makeFern,
        succulent: _makeSucculent
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Species profiles are dimensionless; buffers created after a precision change
// pick up the live array type via getArrayType().
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Kind constants
    KIND_LEAF, KIND_GRASS, KIND_FERN, KIND_SUCCULENT, KIND_NAMES,
    // Registry
    listVectorBloomSpecies, listVectorBloomSpeciesByKind,
    getVectorBloomSpecies, hasVectorBloomSpecies, vectorBloomSpeciesCount,
    getSpeciesProfileName, getSpeciesPresetName, getSpeciesKind,
    // Runtime extension
    registerSpeciesLeaf, registerSpeciesGrass,
    registerSpeciesFern, registerSpeciesSucculent, registerSpeciesAlias,
    // Sampling
    sampleSpecies,
    soaSampleSpeciesOutlines, soaSampleSpeciesOutlinesChunked,
    soaSampleSpeciesBlades, soaSampleSpeciesBladesChunked,
    // Composition
    loadSpeciesPreset, createSpeciesSpec,
    composeSpeciesInto, composeSpeciesIntoAsync,
    // Profile makers
    _makeLeaf, _makeFan, _makeGrass, _makeFern, _makeSucculent,
    // Namespace
    namespace
};

// ============================================================================
// ▶ VECTOR-BLOOM SPECIES PACK COMPLETE — 76 species registered.
//   Next file: 086_vector-bloom-lod-impostor.js
// ============================================================================