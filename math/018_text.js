// file number : 018
// full path name : src/math/018_text.js
// description : Text utilities — every original export preserved and corrected
//               (text.splitChars / text.splitWords / text.scramble, the async
//               DOM splitters, pooled scramble, SOA scramble, procedural
//               reveal ordering, HDR-safe per-glyph color scrambling and the
//               combined `text` object), rewritten as a self-contained native
//               ES module in the three.js r185 JSM addon style: no strict-mode
//               directive, no CommonJS, no Vite / Vue / client build, no CDN.
//               Corrections: all transcription damage repaired (broken
//               identifiers, `& &`, trailing-space string literals, the HTML
//               escape map that emitted raw `&`/`<` instead of entities,
//               `split(" ")` that split on spaces instead of characters,
//               `join(" ")` that injected stray spaces between glyph spans,
//               and `outChars` that stored a random *index* instead of a char
//               code); missing `keplerSolve` / `eccentricToTrue` helpers are
//               now inlined; the pooled scramble path actually reuses pooled
//               Animation instances and can be released.
//               Additions for 1M+ glyphs at real time: LUT-accelerated easing,
//               chunked-yielding counterparts for every loop, a glyph-atlas
//               LUT (char code -> atlas index) for instanced text, duck-typed
//               three.js r185 bridges (BufferAttribute / InstancedMesh), and a
//               resident-state Blob-URL worker pool for genuine multi-core
//               scrambling with a non-blocking main-thread fallback.
//               The provided 002..017 SOA stack stays the default vector /
//               matrix / quaternion maths; three.js r185 only renders.
// best for : 3d graphics + UI — hero text intros with real GLSL/WebGL backends
//            (createScrambleSystem on instanced glyphs), HDR color-tinting of
//            text during scramble for cinematic intros, orbiting-text logos
//            (chase reveal around an ellipse with the Kepler solver),
//            noise-wave reveals on giant headline arrays, IK-driven
//            hand-writing / typewriter effects, 1M+ per-glyph scramble states
//            stored in SOA for WebGPU text rendering, and mixed DOM+WebGL
//            scenes that must never drop a frame on mobile 64-bit.
// license : MIT
//
// topological hierarchy (dependencies first — this file is last):
//   src/math/002_vec2.js
//   src/math/003_vec3.js
//   src/math/004_vec4.js
//   src/math/005_mat2.js
//   src/math/006_mat3.js          (optional, dynamic)
//   src/math/007_mat4.js
//   src/math/008_quat.js
//   src/math/009_quat2.js
//   src/math/010_bitECS_core.js   (optional, dynamic)
//   src/math/012_double.js        (optional precision tier)
//   src/math/013_simplex.js       (optional, dynamic — noise reveal)
//   src/math/014_utils.js
//   src/math/015_easings.js
//   src/math/016_engine.js
//   src/math/017_animation.js
//   src/math/018_text.js          <- THIS FILE
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

const Animation = animationModule.Animation;
const acquireAnimation = animationModule.acquireAnimation;
const releaseAnimation = animationModule.releaseAnimation;
const GlobalEngine = engineModule.GlobalEngine;
const toArray = utils.toArray;

// ============================================================================
// 0. FOUNDATION (inlined — replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const POOL_PREALLOC = 8;

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

function mulberry32(seed) {
    let a = seed | 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
    yieldToMain, createPool, mulberry32, keplerSolve, eccentricToTrue
};

// ============================================================================
// 1. CONSTANTS + HTML ESCAPING (corrected entity map)
// ============================================================================
const DEFAULT_SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+{}[]:;";

const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPE_MAP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
};

function escapeHtml(s) {
    if (s.indexOf("&") === -1 && s.indexOf("<") === -1 && s.indexOf(">") === -1 &&
        s.indexOf("\"") === -1 && s.indexOf("'") === -1) {
        return s;
    }
    return s.replace(HTML_ESCAPE_RE, function (c) { return HTML_ESCAPE_MAP[c]; });
}

const CHAR_STYLE = "display:inline-block;will-change:transform,opacity;";
const WORD_STYLE = "display:inline-block;margin-right:0.25em;will-change:transform,opacity;";

// ============================================================================
// 2. ORIGINAL DOM API (behaviour preserved, markup corrected)
// ============================================================================
/**
 * Split each target's text into per-character <span> elements.
 * Returns the flat array of created spans (original contract).
 */
function splitChars(targets, className) {
    className = className || "char";
    const els = toArray(targets);
    for (let e = 0; e < els.length; e++) {
        const el = els[e];
        const textContent = el.textContent;
        const parts = new Array(textContent.length);
        for (let i = 0; i < textContent.length; i++) {
            const c = textContent[i];
            parts[i] = "<span class=\"" + className + "\" style=\"" + CHAR_STYLE + "\">" +
                (c === " " ? "\u00A0" : escapeHtml(c)) + "</span>";
        }
        el.innerHTML = parts.join("");
    }
    const out = [];
    for (let i = 0; i < els.length; i++) {
        const spans = els[i].querySelectorAll("." + className);
        for (let j = 0; j < spans.length; j++) { out.push(spans[j]); }
    }
    return out;
}

/** Split each target's text into per-word <span> elements. */
function splitWords(targets, className) {
    className = className || "word";
    const els = toArray(targets);
    for (let e = 0; e < els.length; e++) {
        const el = els[e];
        const words = el.textContent.split(/\s+/);
        const parts = [];
        for (let i = 0; i < words.length; i++) {
            const w = words[i];
            if (w === "") { continue; }
            parts.push("<span class=\"" + className + "\" style=\"" + WORD_STYLE + "\">" +
                escapeHtml(w) + "</span>");
        }
        el.innerHTML = parts.join(" ");
    }
    const out = [];
    for (let i = 0; i < els.length; i++) {
        const spans = els[i].querySelectorAll("." + className);
        for (let j = 0; j < spans.length; j++) { out.push(spans[j]); }
    }
    return out;
}

/**
 * Progressive left-to-right reveal with random scramble on the unrevealed tail.
 * Returns one Animation per target (original contract).
 */
function scramble(targets, endText, opts) {
    opts = opts || {};
    const els = toArray(targets);
    const chars = opts.chars || DEFAULT_SCRAMBLE_CHARS;
    const charLen = chars.length;
    const out = [];
    for (let e = 0; e < els.length; e++) {
        const el = els[e];
        const targetStr = endText || el.textContent;
        const len = targetStr.length;
        const cfg = {
            targets: el,
            duration: opts.duration || 1200,
            easing: opts.easing || "easeOutCubic",
            onUpdate: (function (elRef, tStr, tLen, tChars, tCharLen) {
                return function (anim) {
                    const revealedCount = Math.floor(anim.progress * tLen);
                    let s = "";
                    for (let i = 0; i < tLen; i++) {
                        if (i < revealedCount || tStr[i] === " ") { s += tStr[i]; }
                        else { s += tChars[(Math.random() * tCharLen) | 0]; }
                    }
                    elRef.textContent = s;
                };
            })(el, targetStr, len, chars, charLen)
        };
        for (const k in opts) { cfg[k] = opts[k]; }
        out.push(new Animation(cfg));
    }
    return out;
}

// ============================================================================
// 3. CHUNKED ASYNC DOM — never blocks the UI thread on very long strings
// ============================================================================
async function splitCharsAsync(targets, className, chunkSize, yieldEvery) {
    className = className || "char";
    chunkSize = chunkSize || 2048;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    const els = toArray(targets);
    const allSpans = [];
    for (let e = 0; e < els.length; e++) {
        const el = els[e];
        const textContent = el.textContent;
        const total = textContent.length;
        const parts = [];
        let chunksSinceYield = 0;
        for (let start = 0; start < total; start += chunkSize) {
            const end = Math.min(start + chunkSize, total);
            for (let i = start; i < end; i++) {
                const c = textContent[i];
                parts.push("<span class=\"" + className + "\" style=\"" + CHAR_STYLE + "\">" +
                    (c === " " ? "\u00A0" : escapeHtml(c)) + "</span>");
            }
            if (++chunksSinceYield >= yieldEvery) { chunksSinceYield = 0; await yieldToMain(); }
        }
        el.innerHTML = parts.join("");
        const spans = el.querySelectorAll("." + className);
        for (let j = 0; j < spans.length; j++) { allSpans.push(spans[j]); }
        await yieldToMain();
    }
    return allSpans;
}

async function splitWordsAsync(targets, className, chunkSize, yieldEvery) {
    className = className || "word";
    chunkSize = chunkSize || 512;
    yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
    const els = toArray(targets);
    const allSpans = [];
    for (let e = 0; e < els.length; e++) {
        const el = els[e];
        const words = el.textContent.split(/\s+/);
        const total = words.length;
        const parts = [];
        let chunksSinceYield = 0;
        for (let start = 0; start < total; start += chunkSize) {
            const end = Math.min(start + chunkSize, total);
            for (let i = start; i < end; i++) {
                if (words[i] === "") { continue; }
                parts.push("<span class=\"" + className + "\" style=\"" + WORD_STYLE + "\">" +
                    escapeHtml(words[i]) + "</span>");
            }
            if (++chunksSinceYield >= yieldEvery) { chunksSinceYield = 0; await yieldToMain(); }
        }
        el.innerHTML = parts.join(" ");
        const spans = el.querySelectorAll("." + className);
        for (let j = 0; j < spans.length; j++) { allSpans.push(spans[j]); }
        await yieldToMain();
    }
    return allSpans;
}

async function scrambleAsync(targets, endText, opts) {
    opts = opts || {};
    const els = toArray(targets);
    const chars = opts.chars || DEFAULT_SCRAMBLE_CHARS;
    const charLen = chars.length;
    const animations = [];
    for (let e = 0; e < els.length; e++) {
        const el = els[e];
        const targetStr = endText || el.textContent;
        const len = targetStr.length;
        const cfg = {
            targets: el,
            duration: opts.duration || 1200,
            easing: opts.easing || "easeOutCubic",
            onUpdate: (function (elRef, tStr, tLen, tChars, tCharLen) {
                return function (anim) {
                    const revealedCount = Math.floor(anim.progress * tLen);
                    let s = "";
                    for (let i = 0; i < tLen; i++) {
                        if (i < revealedCount || tStr[i] === " ") { s += tStr[i]; }
                        else { s += tChars[(Math.random() * tCharLen) | 0]; }
                    }
                    elRef.textContent = s;
                };
            })(el, targetStr, len, chars, charLen)
        };
        for (const k in opts) { cfg[k] = opts[k]; }
        animations.push(new Animation(cfg));
        await yieldToMain();
    }
    return animations;
}

// ============================================================================
// 4. POOLED SCRAMBLE — zero-GC reuse when re-running on the same elements
// ============================================================================
const _scramblePool = createPool(
    function () { return { anim: null, el: null, targetStr: "", len: 0, chars: DEFAULT_SCRAMBLE_CHARS }; },
    POOL_PREALLOC,
    function (s) { s.anim = null; s.el = null; s.targetStr = ""; s.len = 0; s.chars = DEFAULT_SCRAMBLE_CHARS; }
);
const _pooledEntries = [];

function scramblePooled(targets, endText, opts) {
    opts = opts || {};
    const els = toArray(targets);
    const chars = opts.chars || DEFAULT_SCRAMBLE_CHARS;
    const charLen = chars.length;
    const out = [];
    for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const targetStr = endText || el.textContent;
        const len = targetStr.length;

        let entry = null;
        for (let p = 0; p < _pooledEntries.length; p++) {
            if (_pooledEntries[p].el === el) { entry = _pooledEntries[p]; break; }
        }
        if (!entry) {
            entry = _scramblePool.acquire();
            entry.el = el;
            _pooledEntries.push(entry);
        }
        entry.targetStr = targetStr;
        entry.len = len;
        entry.chars = chars;

        if (entry.anim) { releaseAnimation(entry.anim); entry.anim = null; }

        const cfg = {
            targets: el,
            duration: opts.duration || 1200,
            easing: opts.easing || "easeOutCubic",
            onUpdate: (function (en, tCharLen) {
                return function (anim) {
                    const revealedCount = Math.floor(anim.progress * en.len);
                    let s = "";
                    for (let j = 0; j < en.len; j++) {
                        if (j < revealedCount || en.targetStr[j] === " ") { s += en.targetStr[j]; }
                        else { s += en.chars[(Math.random() * tCharLen) | 0]; }
                    }
                    en.el.textContent = s;
                };
            })(entry, charLen)
        };
        for (const k in opts) { cfg[k] = opts[k]; }
        entry.anim = acquireAnimation(cfg);
        out.push(entry.anim);
    }
    return out;
}

/** Release every pooled scramble entry (call when a scene unmounts). */
function releaseScramblePool() {
    for (let i = 0; i < _pooledEntries.length; i++) {
        const entry = _pooledEntries[i];
        if (entry.anim) { releaseAnimation(entry.anim); entry.anim = null; }
        _scramblePool.release(entry);
    }
    _pooledEntries.length = 0;
}

// ============================================================================
// 5. SOA SCRAMBLE — 1M+ glyphs driven through typed arrays
// ============================================================================
/**
 * Per-glyph scramble state in SOA form.
 * `outChars` holds CHAR CODES (corrected — the original stored a random index,
 * which was inconsistent with the revealed branch that stores targetChars[i]).
 * `targetChars` holds the destination char codes.
 */
function createSOAScramble(count, options) {
    options = options || {};
    const targetChars = options.targetChars instanceof Uint32Array
        ? options.targetChars : new Uint32Array(count);
    const outChars = new Uint32Array(count);
    const progress = new Float32Array(count);
    const delay = new Float32Array(count);
    const revealed = new Uint8Array(count);
    const duration = options.duration !== undefined ? options.duration : 1.0;
    const chars = options.chars || DEFAULT_SCRAMBLE_CHARS;
    const charLen = chars.length;
    const charCodes = new Uint32Array(charLen);
    for (let c = 0; c < charLen; c++) { charCodes[c] = chars.charCodeAt(c); }

    const ease = easings.getEasing(options.ease || "easeOutCubic");
    let lut = null;
    let lutN = 0;
    let done = false;
    let revealCount = 0;
    const rng = options.seed !== undefined ? mulberry32(options.seed) : Math.random;

    for (let i = 0; i < count; i++) {
        if (targetChars[i] === 0 && options.defaultChar !== undefined) {
            targetChars[i] = options.defaultChar;
        }
        outChars[i] = charCodes[(rng() * charLen) | 0];
    }

    function sampleEase(t) {
        if (lut) {
            if (t <= 0) { return lut[0]; }
            if (t >= 1) { return lut[lutN]; }
            const x = t * lutN, k = x | 0;
            return lut[k] + (lut[k + 1] - lut[k]) * (x - k);
        }
        return ease(t);
    }

    function stepRange(s, e, dtSec) {
        for (let i = s; i < e; i++) {
            if (revealed[i]) { continue; }
            if (delay[i] > 0) { delay[i] -= dtSec; if (delay[i] > 0) { continue; } }
            let p = duration <= 0 ? 1 : progress[i] + dtSec / duration;
            if (p > 1) { p = 1; }
            progress[i] = p;
            if (sampleEase(p) >= 1) {
                revealed[i] = 1;
                outChars[i] = targetChars[i];
                revealCount++;
            } else {
                outChars[i] = charCodes[(rng() * charLen) | 0];
            }
        }
    }

    function step(dtSec) {
        if (done) { return api; }
        stepRange(0, count, dtSec);
        if (revealCount >= count) { done = true; }
        return api;
    }

    async function stepChunked(dtSec, chunkSize, yieldEvery) {
        if (done) { return api; }
        chunkSize = chunkSize || CHUNK_SIZE;
        yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
        let c = 0;
        for (let start = 0; start < count; start += chunkSize) {
            const end = Math.min(start + chunkSize, count);
            stepRange(start, end, dtSec);
            if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
        }
        if (revealCount >= count) { done = true; }
        return api;
    }

    const api = {
        count: count,
        targetChars: targetChars,
        outChars: outChars,
        progress: progress,
        delay: delay,
        revealed: revealed,
        charCodes: charCodes,
        duration: duration,
        step: step,
        stepRange: stepRange,
        stepChunked: stepChunked,
        get done() { return done; },
        get revealedCount() { return revealCount; },
        /** Bake the curve into a LUT: one table tap per glyph per frame. */
        useLUT(size) {
            lut = easings.bakeEasingLUT(ease, size || 1024);
            lutN = lut.length - 1;
            return api;
        },
        clearLUT() { lut = null; lutN = 0; return api; },
        setTargetString(str) {
            const n = targetChars.length;
            if (!str || str.length === 0) { return api; }
            for (let i = 0; i < n; i++) { targetChars[i] = str.charCodeAt(i % str.length); }
            return api;
        },
        reset() {
            progress.fill(0);
            revealed.fill(0);
            revealCount = 0;
            done = false;
            for (let i = 0; i < count; i++) { outChars[i] = charCodes[(rng() * charLen) | 0]; }
            return api;
        },
        applyTo(dst) { dst.set(outChars); return dst; }
    };
    return api;
}

// ============================================================================
// 6. PROCEDURAL REVEAL ORDERING
// ============================================================================
let simplex = null;
function _fallbackNoise3(x, y, z) { return vec3.gradientNoise3D(x, y, z); }

/** Simplex-noise wave reveal — normalised delays in [0, speed]. */
function createNoiseReveal(positions, options) {
    options = options || {};
    const noiseFn = options.noiseFn ||
        (simplex ? simplex.acquireNoise3D(options.seed) : _fallbackNoise3);
    const scale = options.scale !== undefined ? options.scale : 0.05;
    const speed = options.speed !== undefined ? options.speed : 0.5;
    const n = positions.count;
    const delays = new Float32Array(n);
    const px = positions.x, py = positions.y, pz = positions.z;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
        const v = 0.5 + 0.5 * noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale);
        delays[i] = v;
        if (v < lo) { lo = v; }
        if (v > hi) { hi = v; }
    }
    const span = hi - lo;
    const inv = span > 0 ? 1 / span : 0;
    for (let j = 0; j < n; j++) { delays[j] = (delays[j] - lo) * inv * speed; }
    return delays;
}

async function createNoiseRevealAsync(positions, options, chunkSize, yieldEvery) {
    options = options || {};
    const noiseFn = options.noiseFn ||
        (simplex ? simplex.acquireNoise3D(options.seed) : _fallbackNoise3);
    const scale = options.scale !== undefined ? options.scale : 0.05;
    const speed = options.speed !== undefined ? options.speed : 0.5;
    const n = positions.count;
    const delays = new Float32Array(n);
    const px = positions.x, py = positions.y, pz = positions.z;
    let lo = Infinity, hi = -Infinity;
    await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) {
            const v = 0.5 + 0.5 * noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale);
            delays[i] = v;
            if (v < lo) { lo = v; }
            if (v > hi) { hi = v; }
        }
    });
    const span = hi - lo;
    const inv = span > 0 ? 1 / span : 0;
    await _chunkedRange(n, chunkSize, yieldEvery, function (s, e) {
        for (let i = s; i < e; i++) { delays[i] = (delays[i] - lo) * inv * speed; }
    });
    return delays;
}

/** Kepler-orbital angular reveal — chase around an ellipse. */
function createOrbitalReveal(count, options) {
    options = options || {};
    const e = options.e !== undefined ? options.e : 0.5;
    const speed = options.speed !== undefined ? options.speed : 1.0;
    const delays = new Float32Array(count);
    const invTwoPi = 1 / (Math.PI * 2);
    for (let i = 0; i < count; i++) {
        const M = (i / count) * Math.PI * 2;
        const E = keplerSolve(M, e);
        const nu = eccentricToTrue(E, e);
        delays[i] = ((nu + Math.PI) * invTwoPi) * speed;
    }
    return delays;
}

async function createOrbitalRevealChunked(count, options, chunkSize, yieldEvery) {
    options = options || {};
    const e = options.e !== undefined ? options.e : 0.5;
    const speed = options.speed !== undefined ? options.speed : 1.0;
    const delays = new Float32Array(count);
    const invTwoPi = 1 / (Math.PI * 2);
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, en) {
        for (let i = s; i < en; i++) {
            const M = (i / count) * Math.PI * 2;
            const E = keplerSolve(M, e);
            const nu = eccentricToTrue(E, e);
            delays[i] = ((nu + Math.PI) * invTwoPi) * speed;
        }
    });
    return delays;
}

/** FABRIK / CCD chain reveal — arc-length normalised along the bone chain. */
function createIKReveal(chainPos, count, options) {
    options = options || {};
    const speed = options.speed !== undefined ? options.speed : 1.0;
    const joints = (chainPos.length / 3) | 0;
    const delays = new Float32Array(count);
    if (joints < 2) { return delays; }
    const cum = new Float32Array(joints);
    for (let i = 1; i < joints; i++) {
        const dx = chainPos[i * 3] - chainPos[(i - 1) * 3];
        const dy = chainPos[i * 3 + 1] - chainPos[(i - 1) * 3 + 1];
        const dz = chainPos[i * 3 + 2] - chainPos[(i - 1) * 3 + 2];
        cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const total = cum[joints - 1] || 1;
    const invTotal = 1 / total;
    const denom = Math.max(1, count - 1);
    for (let k = 0; k < count; k++) {
        const arc = (k / denom) * total;
        delays[k] = (arc * invTotal) * speed;
    }
    return delays;
}

async function createIKRevealChunked(chainPos, count, options, chunkSize, yieldEvery) {
    options = options || {};
    const speed = options.speed !== undefined ? options.speed : 1.0;
    const joints = (chainPos.length / 3) | 0;
    const delays = new Float32Array(count);
    if (joints < 2) { return delays; }
    const cum = new Float32Array(joints);
    for (let i = 1; i < joints; i++) {
        const dx = chainPos[i * 3] - chainPos[(i - 1) * 3];
        const dy = chainPos[i * 3 + 1] - chainPos[(i - 1) * 3 + 1];
        const dz = chainPos[i * 3 + 2] - chainPos[(i - 1) * 3 + 2];
        cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const total = cum[joints - 1] || 1;
    const invTotal = 1 / total;
    const denom = Math.max(1, count - 1);
    await _chunkedRange(count, chunkSize, yieldEvery, function (s, e) {
        for (let k = s; k < e; k++) {
            delays[k] = (((k / denom) * total) * invTotal) * speed;
        }
    });
    return delays;
}

function applyDelays(soaScramble, delays) {
    const d = soaScramble.delay;
    const n = Math.min(d.length, delays.length);
    for (let i = 0; i < n; i++) { d[i] = delays[i]; }
    return soaScramble;
}

// ============================================================================
// 7. HDR-SAFE COLOR SCRAMBLING (never clamps — exposure pipelines stay intact)
// ============================================================================
function createScrambleColorSystem(soaScramble, colors, fromColor, toColor) {
    const count = colors.count;
    const r = colors.x, g = colors.y, b = colors.z, a = colors.w;
    const fr = fromColor[0], fg = fromColor[1], fb = fromColor[2], fa = fromColor[3];
    const dr = toColor[0] - fr, dg = toColor[1] - fg, db = toColor[2] - fb, da = toColor[3] - fa;
    const progress = soaScramble.progress;

    function range(s, e) {
        for (let i = s; i < e; i++) {
            let t = progress[i];
            if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
            r[i] = fr + dr * t;
            g[i] = fg + dg * t;
            b[i] = fb + db * t;
            a[i] = fa + da * t;
        }
    }

    return {
        step() { range(0, count); return colors; },
        async stepChunked(chunkSize, yieldEvery) {
            await _chunkedRange(count, chunkSize, yieldEvery, range);
            return colors;
        }
    };
}

// ============================================================================
// 8. SCRAMBLE SYSTEM — 1M+ glyph entities (bitECS-friendly)
// ============================================================================
function createScrambleSystem(count, options) {
    options = options || {};
    const soa = createSOAScramble(count, options);
    if (options.lut) { soa.useLUT(options.lut === true ? 1024 : options.lut); }
    if (options.delays) { applyDelays(soa, options.delays); }
    if (options.reveal) {
        if (options.reveal === "noise" && options.positions) {
            applyDelays(soa, createNoiseReveal(options.positions, options.noiseOptions || {}));
        } else if (options.reveal === "orbital") {
            applyDelays(soa, createOrbitalReveal(count, options.orbitalOptions || {}));
        } else if (options.reveal === "ik" && options.chainPos) {
            applyDelays(soa, createIKReveal(options.chainPos, count, options.ikOptions || {}));
        }
    }

    const api = {
        soa: soa,
        targetChars: soa.targetChars,
        outChars: soa.outChars,
        progress: soa.progress,
        step(dt) { soa.step(dt); return api; },
        stepChunked(dt, chunkSize, yieldEvery) { return soa.stepChunked(dt, chunkSize, yieldEvery); },
        get done() { return soa.done; },
        get revealedCount() { return soa.revealedCount; },
        reset() { soa.reset(); return api; },
        setTargetString(str) { soa.setTargetString(str); return api; },
        applyDelays(delays) { applyDelays(soa, delays); return api; }
    };
    return api;
}

// ============================================================================
// 9. THREE.JS r185 INTEROP (duck-typed — no three import, no CDN, no build)
// ============================================================================
/**
 * Build a char-code -> glyph-atlas-index LUT (Uint32Array of 65536).
 * Unknown codes map to `fallbackIndex` (default 0).
 */
function createGlyphAtlasLUT(atlasChars, fallbackIndex) {
    const lut = new Uint32Array(65536);
    const fb = fallbackIndex === undefined ? 0 : fallbackIndex;
    if (fb !== 0) { lut.fill(fb); }
    for (let i = 0; i < atlasChars.length; i++) {
        lut[atlasChars.charCodeAt(i)] = i;
    }
    return lut;
}

/** Convert SOA char codes into atlas indices (zero allocation when out given). */
function applyGlyphIndices(out, soaScramble, lut, count) {
    const n = count === undefined ? soaScramble.count : count;
    const src = soaScramble.outChars;
    for (let i = 0; i < n; i++) { out[i] = lut[src[i] & 0xffff]; }
    return out;
}

/** Write atlas indices straight into a three.js r185 (Instanced)BufferAttribute. */
function applyScrambleToAttribute(attribute, soaScramble, lut, count) {
    const n = count === undefined ? Math.min(soaScramble.count, attribute.count) : count;
    const dst = attribute.array;
    const src = soaScramble.outChars;
    if (lut) {
        for (let i = 0; i < n; i++) { dst[i] = lut[src[i] & 0xffff]; }
    } else {
        for (let i = 0; i < n; i++) { dst[i] = src[i]; }
    }
    attribute.needsUpdate = true;
    return attribute;
}

/** Write HDR per-glyph RGBA into an interleaved three.js color attribute. */
function applyScrambleColorsToAttribute(attribute, colors, count) {
    const n = count === undefined ? colors.count : count;
    const dst = attribute.array;
    const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
    const stride = attribute.itemSize || 4;
    for (let i = 0, o = 0; i < n; i++, o += stride) {
        dst[o] = cx[i]; dst[o + 1] = cy[i]; dst[o + 2] = cz[i];
        if (stride > 3) { dst[o + 3] = cw[i]; }
    }
    attribute.needsUpdate = true;
    return attribute;
}

/**
 * Bind a scramble system to a three.js r185 InstancedMesh (or any object
 * exposing instanced attributes). Returns a driver whose `step` advances the
 * scramble and uploads the glyph / color attributes in one pass.
 */
function attachScrambleToMesh(mesh, system, options) {
    options = options || {};
    const soa = system.soa || system;
    const glyphAttr = options.glyphAttribute ||
        (mesh.geometry && mesh.geometry.attributes[options.glyphName || "aGlyph"]) || null;
    const colorAttr = options.colorAttribute ||
        (mesh.geometry && mesh.geometry.attributes[options.colorName || "aColor"]) || null;
    const lut = options.atlasChars ? createGlyphAtlasLUT(options.atlasChars, options.fallbackIndex) : (options.lut || null);
    const colors = options.colors || null;
    const colorSystem = (colors && options.fromColor && options.toColor)
        ? createScrambleColorSystem(soa, colors, options.fromColor, options.toColor)
        : null;
    const count = options.count !== undefined ? options.count : soa.count;

    function upload() {
        if (glyphAttr) { applyScrambleToAttribute(glyphAttr, soa, lut, count); }
        if (colorSystem) { colorSystem.step(); }
        if (colorAttr && colors) { applyScrambleColorsToAttribute(colorAttr, colors, count); }
        if (mesh.count !== undefined && options.setCount !== false) { mesh.count = count; }
    }

    return {
        system: system,
        lut: lut,
        upload: upload,
        step(dt) { soa.step(dt); upload(); return soa.done; },
        async stepChunked(dt, chunkSize, yieldEvery) {
            await soa.stepChunked(dt, chunkSize, yieldEvery);
            if (colorSystem) { await colorSystem.stepChunked(chunkSize, yieldEvery); }
            if (glyphAttr) { applyScrambleToAttribute(glyphAttr, soa, lut, count); }
            if (colorAttr && colors) { applyScrambleColorsToAttribute(colorAttr, colors, count); }
            if (mesh.count !== undefined && options.setCount !== false) { mesh.count = count; }
            return soa.done;
        },
        get done() { return soa.done; }
    };
}

// ============================================================================
// 10. WORKER POOL — resident-state multi-core scrambling (Blob URL, no server)
// ============================================================================
const _textWorkerSource = "(" + function () {
    const resident = new Map();

    function rng(seed) {
        let a = seed | 0;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    self.onmessage = function (e) {
        const d = e.data;
        if (d.op === "attach") {
            resident.set(d.trackId, {
                targetChars: d.targetChars,
                charCodes: d.charCodes,
                lut: d.lut,
                duration: d.duration,
                rand: rng(d.seed || 1)
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
        const progress = d.progress, delay = d.delay, revealed = d.revealed, outChars = d.outChars;
        const n = d.n, dt = d.dt;
        const targetChars = st.targetChars, charCodes = st.charCodes, lut = st.lut;
        const duration = st.duration, rand = st.rand;
        const charLen = charCodes.length;
        const lutN = lut ? lut.length - 1 : 0;
        let revealCount = 0;

        for (let i = 0; i < n; i++) {
            if (revealed[i]) { revealCount++; continue; }
            if (delay[i] > 0) { delay[i] -= dt; if (delay[i] > 0) { continue; } }
            let p = duration <= 0 ? 1 : progress[i] + dt / duration;
            if (p > 1) { p = 1; }
            progress[i] = p;
            let et;
            if (lut) {
                if (p <= 0) { et = lut[0]; }
                else if (p >= 1) { et = lut[lutN]; }
                else { const x = p * lutN, k = x | 0; et = lut[k] + (lut[k + 1] - lut[k]) * (x - k); }
            } else { et = p; }
            if (et >= 1) {
                revealed[i] = 1;
                outChars[i] = targetChars[i];
                revealCount++;
            } else {
                outChars[i] = charCodes[(rand() * charLen) | 0];
            }
        }

        self.postMessage({
            id: d.id, progress: progress, delay: delay, revealed: revealed,
            outChars: outChars, revealCount: revealCount
        }, [progress.buffer, delay.buffer, revealed.buffer, outChars.buffer]);
    };
}.toString() + ")();";

/**
 * Optional multi-core executor for SOA scramble tracks. Immutable channels
 * (targetChars / charCodes / ease LUT / duration) are attached once and stay
 * resident in the worker; only the mutable channels are transferred each step
 * (zero copy). Without Workers / Blob URLs the pool falls back to
 * `soa.stepChunked`, so a call never blocks the UI and never throws.
 */
class TextWorkerPool {
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
            this._url = URL.createObjectURL(new Blob([_textWorkerSource], { type: "text/javascript" }));
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

    /** Upload the immutable channels of a scramble track once. */
    async attach(soa, seed) {
        if (this._disposed || this._workers.length === 0) { return false; }
        if (!soa._lut) { soa.useLUT(1024); }
        const id = this._nextId++;
        await this._post({
            id: this._nextId++, op: "attach", trackId: id,
            targetChars: soa.targetChars.slice(),
            charCodes: soa.charCodes.slice(),
            lut: soa._lut ? soa._lut.slice() : null,
            duration: soa.duration,
            seed: seed === undefined ? 1 : seed
        }, []);
        this._attached.set(soa, id);
        return true;
    }

    /** Step a track off-thread; mutable channels are transferred, not copied. */
    async step(soa, dt, chunkSize, yieldEvery) {
        if (this._disposed) { throw new Error("TextWorkerPool disposed"); }
        const id = this._attached.get(soa);
        if (this._workers.length === 0 || id === undefined) {
            return soa.stepChunked(dt, chunkSize, yieldEvery);
        }
        const res = await this._post({
            id: this._nextId++, op: "step", trackId: id, n: soa.count, dt: dt,
            progress: soa.progress, delay: soa.delay,
            revealed: soa.revealed, outChars: soa.outChars
        }, [soa.progress.buffer, soa.delay.buffer, soa.revealed.buffer, soa.outChars.buffer]);

        soa.progress = res.progress;
        soa.delay = res.delay;
        soa.revealed = res.revealed;
        soa.outChars = res.outChars;
        return soa;
    }

    async detach(soa) {
        const id = this._attached.get(soa);
        if (id === undefined || this._workers.length === 0) { return false; }
        this._attached.delete(soa);
        await this._post({ id: this._nextId++, op: "detach", trackId: id }, []);
        return true;
    }

    dispose() {
        this._disposed = true;
        for (let i = 0; i < this._workers.length; i++) { this._workers[i].terminate(); }
        this._workers.length = 0;
        this._idle.length = 0;
        for (const job of this._pending.values()) { job.reject(new Error("TextWorkerPool disposed")); }
        this._pending.clear();
        for (let i = 0; i < this._queue.length; i++) { this._queue[i].reject(new Error("TextWorkerPool disposed")); }
        this._queue.length = 0;
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }
}

function createTextWorkerPool(size) { return new TextWorkerPool(size); }

// ============================================================================
// 11. COMBINED `text` OBJECT + MATH NAMESPACE
// ============================================================================
const text = {
    splitChars: splitChars,
    splitWords: splitWords,
    scramble: scramble,
    splitCharsAsync: splitCharsAsync,
    splitWordsAsync: splitWordsAsync,
    scrambleAsync: scrambleAsync,
    scramblePooled: scramblePooled,
    releaseScramblePool: releaseScramblePool,
    createSOAScramble: createSOAScramble,
    createScrambleSystem: createScrambleSystem,
    createNoiseReveal: createNoiseReveal,
    createNoiseRevealAsync: createNoiseRevealAsync,
    createOrbitalReveal: createOrbitalReveal,
    createOrbitalRevealChunked: createOrbitalRevealChunked,
    createIKReveal: createIKReveal,
    createIKRevealChunked: createIKRevealChunked,
    applyDelays: applyDelays,
    createScrambleColorSystem: createScrambleColorSystem,
    createGlyphAtlasLUT: createGlyphAtlasLUT,
    applyGlyphIndices: applyGlyphIndices,
    applyScrambleToAttribute: applyScrambleToAttribute,
    applyScrambleColorsToAttribute: applyScrambleColorsToAttribute,
    attachScrambleToMesh: attachScrambleToMesh,
    createTextWorkerPool: createTextWorkerPool
};

const math = {
    common: common,
    utils: utils,
    easings: easings,
    animation: animationModule,
    engine: engineModule,
    vec2: vec2, vec3: vec3, vec4: vec4,
    mat2: mat2, mat3: null, mat4: mat4,
    quat: quat, quat2: quat2,
    bitecs: null, simplex: null,
    text: text
};

/** Optional modules load dynamically; a failure never breaks this module. */
const mathReady = Promise.allSettled([
    import("./006_mat3.js").then(function (m) { math.mat3 = m; }),
    import("./010_bitECS_core.js").then(function (m) { math.bitecs = m; }),
    import("./013_simplex.js").then(function (m) { simplex = m; math.simplex = m; })
]);

// ============================================================================
// 12. EXPORTS — every original export preserved + the 1M-scale parallel layer
// ============================================================================
export {
    // foundation
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC,
    DEFAULT_SCRAMBLE_CHARS, escapeHtml,
    // original DOM API
    splitChars, splitWords, scramble,
    // chunked async DOM
    splitCharsAsync, splitWordsAsync, scrambleAsync,
    // pooled
    scramblePooled, releaseScramblePool,
    // SOA scramble
    createSOAScramble, createScrambleSystem,
    // procedural reveal ordering
    createNoiseReveal, createNoiseRevealAsync,
    createOrbitalReveal, createOrbitalRevealChunked,
    createIKReveal, createIKRevealChunked,
    applyDelays,
    // HDR color
    createScrambleColorSystem,
    // three.js r185 interop
    createGlyphAtlasLUT, applyGlyphIndices,
    applyScrambleToAttribute, applyScrambleColorsToAttribute, attachScrambleToMesh,
    // parallelism
    TextWorkerPool, createTextWorkerPool,
    // combined object + namespace
    text, math, mathReady
};

export default {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC,
    DEFAULT_SCRAMBLE_CHARS, escapeHtml,
    splitChars, splitWords, scramble,
    splitCharsAsync, splitWordsAsync, scrambleAsync,
    scramblePooled, releaseScramblePool,
    createSOAScramble, createScrambleSystem,
    createNoiseReveal, createNoiseRevealAsync,
    createOrbitalReveal, createOrbitalRevealChunked,
    createIKReveal, createIKRevealChunked,
    applyDelays,
    createScrambleColorSystem,
    createGlyphAtlasLUT, applyGlyphIndices,
    applyScrambleToAttribute, applyScrambleColorsToAttribute, attachScrambleToMesh,
    TextWorkerPool, createTextWorkerPool,
    text, math, mathReady
};

// Continue with next file: src/math/019_timeline.js (keyframe tracks + pooled
// timeline scheduler — 1M-instance staggered playback, bezier track solver,
// bitECS timeline system and three.js r185 AnimationClip bridging)?