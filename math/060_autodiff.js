//File number : 060
// File : src/math/060_autodiff.js
//Description : Complete reverse-mode automatic differentiation (autograd) — a pooled computation graph with an opcode-dispatched backward pass, first-class support for 1M+ independent optimization problems via SOA batches and chunked async variants. Includes ADNode (pooled, precision-aware value/grad buffers, fixed-capacity parent lists, NO per-node closures), Tape (iterative post-order topological walk with lazy epoch-based gradient zeroing, node recycling), the full operator surface (add, sub, mul, div, pow, neg, inv, abs, exp, expm1, log, log1p, sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, sqrt, cbrt, sigmoid, relu, leakyRelu, smoothstep, saturate, softplus, min, max, clamp, sum, mean, dot, length, lengthSq, normalize3, cross3, component/join vector plumbing, and quaternion conjugate/multiply/normalize/rotate-vector ops), scalar↔vector broadcasting, domain helpers (noiseGradientAD, sdfFit, ikOptimize, orbitalEnergyMinimize, animationFit, colorMatch, morphFit), gradient-clipping / weight-decay optimizers (SGD, Adam) and flat-array SOA optimizers (`soaOptimize`, `soaOptimizeChunked`, `soaSGDStep`, `soaAdamStep`) for simultaneously solving 1M+ independent scalar/vec3 problems per frame. Every buffer honors `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap) and every long loop has a synchronous and chunked async form yielding via `scheduler.yield()` / `MessageChannel`.
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. Every operator emits an integer opcode plus a fixed Float64 aux block instead of a backward closure; a single hoisted `_backwardNode` dispatches the whole surface. Parent edges live in pre-allocated fixed-capacity arrays. Topological sorting is iterative (explicit stacks, no recursion, no iterators). Gradient clearing uses a monotonic epoch stamp so only touched nodes are zeroed. Graph nodes are recycled into a bounded pool after every backward pass. All allocations occur exclusively at module init / pool growth.
//Corrections : ESM imports/exports only (no require/exports). Fixed: gradients accumulated across iterations because ops never registered with the tape and `Tape.reset()` deactivated recording (now epoch-zeroed + auto-recorded + recycled); `ADPool.warm` illegally accessed another class's private field (SyntaxError); `sub()`/`mul()` were handed raw numbers instead of nodes throughout ikOptimize / orbitalEnergyMinimize / colorMatch / morphFit, producing NaN graphs; ikOptimize re-read `chain.pos` every iteration and discarded the optimizer's updates; `cross3AD` propagated a sign-inverted gradient for BOTH operands; `powAD` ignored the exponent's derivative; `ADBatchState.run` read the last node's gradient indexed by parameter id; `soaOptimize` allocated a tape + node array per problem per iteration and never accepted caller-supplied initial parameters; `noiseGradientAD` returned a fresh array literal; `optimize` allocated Adam state, history and result objects per call; `lengthAD`/`normalize3AD` divided by zero; recursive `_topo` risked stack overflow and allocated Set iterators.
//Added : Opcode backward dispatch, `component`/`splitVec3`/`joinVec3`/`vec3FromVec4`, quaternion AD ops, gradient clipping + weight decay, `optimizeChunked`, `soaSGDStep`, `soaAdamStep`, `createAdamStateSOA`, `soaGradNorm`, `soaClipGrad`, `soaFiniteDifferenceCheck`, `persist`, `Tape.recycle`, and bounded fixed-capacity pools throughout.
//License : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — sibling files within the 54-file math topology)
// ============================================================================
import { common, getArrayType, onPrecisionChange } from './000_Math_module.js';

// ============================================================================
// Variable Declarations — constants (init-time only)
// ============================================================================
const EPSILON = 1e-12;
const MAX_PARENTS = 4;
const NODE_POOL_CAP = 4096;
const NODE_PREWARM = 512;
const NODE_BASE_CAP = 4;
const TAPE_POOL_CAP = 16;
const TAPE_BASE_CAP = 1024;

// Operator codes — replace per-node backward closures (Zero-GC mandate).
const OP_LEAF = 0, OP_ADD = 1, OP_SUB = 2, OP_MUL = 3, OP_DIV = 4;
const OP_NEG = 5, OP_INV = 6, OP_ABS = 7, OP_POW = 8, OP_SQRT = 9, OP_CBRT = 10;
const OP_EXP = 11, OP_EXPM1 = 12, OP_LOG = 13, OP_LOG1P = 14;
const OP_SIN = 15, OP_COS = 16, OP_TAN = 17, OP_ASIN = 18, OP_ACOS = 19, OP_ATAN = 20;
const OP_ATAN2 = 21, OP_SINH = 22, OP_COSH = 23, OP_TANH = 24;
const OP_SIGMOID = 25, OP_RELU = 26, OP_LEAKY = 27, OP_SMOOTHSTEP = 28;
const OP_SATURATE = 29, OP_SOFTPLUS = 30;
const OP_SUM = 31, OP_MEAN = 32, OP_DOT = 33, OP_LENGTHSQ = 34, OP_LENGTH = 35;
const OP_NORM3 = 36, OP_CROSS3 = 37;
const OP_MIN = 38, OP_MAX = 39, OP_CLAMP = 40;
const OP_COMPONENT = 41, OP_JOIN3 = 42, OP_V4TO3 = 43;
const OP_QCONJ = 44, OP_QMUL = 45, OP_QNORM = 46, OP_POWN = 47;

// Monotonic backward epoch — lazily zeroes only the nodes actually touched.
let _epoch = 0;

// Currently recording tape (set by Tape.reset() / Tape.begin()).
let _activeTape = null;

// Shared quaternion-product scratch (sequential, never held across calls).
const _qm = new Float64Array(4);

// ============================================================================
// Function Declarations — internal hoisted helpers (closure-free)
// ============================================================================
function _touch(p) {
    if (p._zeroEpoch !== _epoch) {
        const g = p.grad, s = p._size;
        for (let i = 0; i < s; i++) g[i] = 0;
        p._zeroEpoch = _epoch;
    }
}

function _quatMul(ax, ay, az, aw, bx, by, bz, bw) {
    _qm[0] = aw * bx + ax * bw + ay * bz - az * by;
    _qm[1] = aw * by + ay * bw + az * bx - ax * bz;
    _qm[2] = aw * bz + az * bw + ax * by - ay * bx;
    _qm[3] = aw * bw - ax * bx - ay * by - az * bz;
}

function _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ============================================================================
// Class Declarations — ADNode
// ============================================================================
/**
 * A scalar or vector-valued computation-graph node.
 * `value` / `grad` are precision-aware typed arrays of length `_size`.
 * Parents live in a pre-allocated fixed-capacity array; the backward rule is
 * selected by the integer `_op` code (no closure is ever allocated).
 */
class ADNode {
    constructor(size) {
        this._cap = Math.max(size || 1, NODE_BASE_CAP);
        const T = getArrayType();
        this.value = new T(this._cap);
        this.grad = new T(this._cap);
        this._size = size || 1;
        this.parents = new Array(MAX_PARENTS);
        this.parents[0] = null; this.parents[1] = null;
        this.parents[2] = null; this.parents[3] = null;
        this.parentCount = 0;
        this._aux = new Float64Array(4);
        this._op = OP_LEAF;
        this._zeroEpoch = -1;
        this._visitEpoch = -1;
        this._owner = null;
        this.requiresGrad = true;
    }
    ensure(size) {
        this._size = size;
        if (size <= this._cap) return this;
        this._cap = size;
        const T = getArrayType();
        this.value = new T(size);
        this.grad = new T(size);
        return this;
    }
    zeroGrad() {
        const g = this.grad, s = this._size;
        for (let i = 0; i < s; i++) g[i] = 0;
        this._zeroEpoch = _epoch;
        return this;
    }
    item() { return this.value[0]; }
    itemGrad() { return this.grad[0]; }
    /** Zero-GC value read-out into a caller-owned buffer. */
    writeTo(out) {
        for (let i = 0; i < this._size; i++) out[i] = this.value[i];
        return out;
    }
    /** Zero-GC gradient read-out into a caller-owned buffer. */
    writeGradTo(out) {
        for (let i = 0; i < this._size; i++) out[i] = this.grad[i];
        return out;
    }
    static #pool = new Array(NODE_POOL_CAP);
    static #count = 0;
    static {
        for (let i = 0; i < NODE_PREWARM; i++) ADNode.#pool[ADNode.#count++] = new ADNode(1);
    }
    static acquire(size) {
        let n;
        if (ADNode.#count > 0) {
            ADNode.#count--;
            n = ADNode.#pool[ADNode.#count];
            ADNode.#pool[ADNode.#count] = null;
        } else {
            n = new ADNode(size || 1);
        }
        n.ensure(size || 1);
        const v = n.value, g = n.grad, s = n._size;
        for (let i = 0; i < s; i++) { v[i] = 0; g[i] = 0; }
        n.parents[0] = null; n.parents[1] = null;
        n.parents[2] = null; n.parents[3] = null;
        n.parentCount = 0;
        n._aux[0] = 0; n._aux[1] = 0; n._aux[2] = 0; n._aux[3] = 0;
        n._op = OP_LEAF;
        n._zeroEpoch = -1;
        n._visitEpoch = -1;
        n._owner = null;
        n.requiresGrad = true;
        return n;
    }
    static release(n) {
        if (!n) return;
        n.parents[0] = null; n.parents[1] = null;
        n.parents[2] = null; n.parents[3] = null;
        n.parentCount = 0;
        n._owner = null;
        if (ADNode.#count < NODE_POOL_CAP) ADNode.#pool[ADNode.#count++] = n;
    }
    static get pooled() { return ADNode.#count; }
}

// ============================================================================
// Class Declarations — Tape
// ============================================================================
/**
 * Records nodes and drives the backward pass. Topological order is produced by
 * an iterative post-order DFS over pre-allocated stacks (no recursion, no
 * iterators, no allocation). `recycle()` returns graph-owned nodes to the pool
 * while preserving persistent parameters and constants.
 */
class Tape {
    constructor(capacity) {
        this.cap = capacity || TAPE_BASE_CAP;
        this.nodes = new Array(this.cap);
        this.count = 0;
        this.stack = new Array(this.cap);
        this.state = new Uint8Array(this.cap);
        this.order = new Array(this.cap);
        this.orderCount = 0;
        this.active = true;
    }
    _ensureNodeCap(need) {
        if (need <= this.cap) return;
        let c = this.cap;
        while (c < need) c *= 2;
        const nn = new Array(c);
        for (let i = 0; i < this.count; i++) nn[i] = this.nodes[i];
        this.nodes = nn;
        this.cap = c;
    }
    _ensureStackCap(need) {
        if (need <= this.stack.length) return;
        let c = this.stack.length;
        while (c < need) c *= 2;
        const ns = new Array(c);
        for (let i = 0; i < this.stack.length; i++) ns[i] = this.stack[i];
        this.stack = ns;
        this.state = new Uint8Array(c);
        this.order = new Array(c);
    }
    record(n) {
        if (!this.active) return n;
        this._ensureNodeCap(this.count + 1);
        this.nodes[this.count++] = n;
        return n;
    }
    /** Clear the recorded graph and make this tape the recording target. */
    reset() {
        this.count = 0;
        this.orderCount = 0;
        this.active = true;
        _activeTape = this;
        return this;
    }
    begin() { _activeTape = this; this.active = true; return this; }
    end() { if (_activeTape === this) _activeTape = _defaultTape; return this; }
    /** Reverse-mode pass. Seeds `root` with ones and accumulates into parents. */
    backward(root) {
        _epoch++;
        // Iterative post-order DFS from the root.
        let sp = 0;
        this._ensureStackCap(1);
        this.stack[0] = root; this.state[0] = 0; sp = 1;
        this.orderCount = 0;
        while (sp > 0) {
            const top = sp - 1;
            const n = this.stack[top];
            if (this.state[top] === 0) {
                this.state[top] = 1;
                if (n._visitEpoch === _epoch) { sp--; continue; }
                n._visitEpoch = _epoch;
                const pc = n.parentCount;
                if (pc > 0) {
                    this._ensureStackCap(sp + pc);
                    for (let k = 0; k < pc; k++) {
                        const p = n.parents[k];
                        if (p !== null && p._visitEpoch !== _epoch) {
                            this.stack[sp] = p; this.state[sp] = 0; sp++;
                        }
                    }
                }
            } else {
                this._ensureStackCap(this.orderCount + 1);
                this.order[this.orderCount++] = n;
                sp--;
            }
        }
        _touch(root);
        for (let k = 0; k < root._size; k++) root.grad[k] = 1;
        for (let i = this.orderCount - 1; i >= 0; i--) {
            const n = this.order[i];
            if (n.parentCount === 0 || n.requiresGrad === false) continue;
            _backwardNode(n);
        }
        return this;
    }
    /** Return graph-owned nodes to the pool (parameters/constants survive). */
    recycle() {
        for (let i = 0; i < this.count; i++) {
            const n = this.nodes[i];
            if (n._owner === this) ADNode.release(n);
            this.nodes[i] = null;
        }
        this.count = 0;
        this.orderCount = 0;
        return this;
    }
    zeroGrad() {
        for (let i = 0; i < this.count; i++) this.nodes[i].zeroGrad();
        return this;
    }
    static #pool = new Array(TAPE_POOL_CAP);
    static #count = 0;
    static {
        for (let i = 0; i < 4; i++) Tape.#pool[Tape.#count++] = new Tape(TAPE_BASE_CAP);
    }
    static acquire() {
        if (Tape.#count > 0) {
            Tape.#count--;
            const t = Tape.#pool[Tape.#count];
            Tape.#pool[Tape.#count] = null;
            t.count = 0; t.orderCount = 0; t.active = true;
            return t;
        }
        return new Tape(TAPE_BASE_CAP);
    }
    static release(t) {
        if (!t) return;
        t.recycle();
        t.active = false;
        if (_activeTape === t) _activeTape = _defaultTape;
        if (Tape.#count < TAPE_POOL_CAP) Tape.#pool[Tape.#count++] = t;
    }
}

const _defaultTape = new Tape(TAPE_BASE_CAP);
_activeTape = _defaultTape;

// ============================================================================
// Function Declarations — Node factory (hoisted, closure-free)
// ============================================================================
function _mkNode(size, op, a, b, c) {
    const n = ADNode.acquire(size);
    n._op = op;
    let pc = 0;
    if (a !== undefined && a !== null) n.parents[pc++] = a;
    if (b !== undefined && b !== null) n.parents[pc++] = b;
    if (c !== undefined && c !== null) n.parents[pc++] = c;
    n.parentCount = pc;
    n._owner = _activeTape;
    if (_activeTape !== null) _activeTape.record(n);
    return n;
}

/** Mark a node as persistent so `Tape.recycle()` never reclaims it. */
function persist(n) { n._owner = null; return n; }

// ============================================================================
// Function Declarations — Construction
// ============================================================================
function node(v) { const n = _mkNode(1, OP_LEAF); n.value[0] = v; return n; }
function scalar(v) { return node(v); }
function vector(vals) {
    const n = _mkNode(vals.length, OP_LEAF);
    for (let i = 0; i < vals.length; i++) n.value[i] = vals[i];
    return n;
}
function vec3AD(x, y, z) {
    const n = _mkNode(3, OP_LEAF);
    n.value[0] = x; n.value[1] = y; n.value[2] = z;
    return n;
}
function vec4AD(x, y, z, w) {
    const n = _mkNode(4, OP_LEAF);
    n.value[0] = x; n.value[1] = y; n.value[2] = z; n.value[3] = w;
    return n;
}
function quatAD(x, y, z, w) { return vec4AD(x, y, z, w); }
function requiresGrad(n, v) { n.requiresGrad = v !== false; return n; }
/** Stop-gradient leaf carrying the same value (no parents). */
function detach(n) {
    const o = _mkNode(n._size, OP_LEAF);
    for (let i = 0; i < n._size; i++) o.value[i] = n.value[i];
    return o;
}
function constant(v) { return persist(node(v)); }
function variable(v) { return persist(node(v)); }
function constVec3(x, y, z) { return persist(vec3AD(x, y, z)); }

// ============================================================================
// Function Declarations — Vector plumbing
// ============================================================================
/** Extract component `i` of a vector node as a scalar node. */
function component(a, i) {
    const out = _mkNode(1, OP_COMPONENT, a);
    out._aux[0] = i;
    out.value[0] = a.value[i];
    return out;
}
/** Split a vec3 node into three scalar nodes (writes into caller-owned refs). */
function splitVec3(a, out) {
    out.x = component(a, 0);
    out.y = component(a, 1);
    out.z = component(a, 2);
    return out;
}
/** Build a vec3 node from three scalar nodes. */
function joinVec3(x, y, z) {
    const out = _mkNode(3, OP_JOIN3, x, y, z);
    out.value[0] = x.value[0]; out.value[1] = y.value[0]; out.value[2] = z.value[0];
    return out;
}
/** Drop the w component of a vec4 node. */
function vec3FromVec4(a) {
    const out = _mkNode(3, OP_V4TO3, a);
    out.value[0] = a.value[0]; out.value[1] = a.value[1]; out.value[2] = a.value[2];
    return out;
}

// ============================================================================
// Function Declarations — Arithmetic (broadcasting)
// ============================================================================
function add(a, b) {
    const an = a._size, bn = b._size, size = an > bn ? an : bn;
    const out = _mkNode(size, OP_ADD, a, b);
    for (let i = 0; i < size; i++) {
        out.value[i] = (an === 1 ? a.value[0] : a.value[i]) + (bn === 1 ? b.value[0] : b.value[i]);
    }
    return out;
}

function sub(a, b) {
    const an = a._size, bn = b._size, size = an > bn ? an : bn;
    const out = _mkNode(size, OP_SUB, a, b);
    for (let i = 0; i < size; i++) {
        out.value[i] = (an === 1 ? a.value[0] : a.value[i]) - (bn === 1 ? b.value[0] : b.value[i]);
    }
    return out;
}

function mul(a, b) {
    const an = a._size, bn = b._size, size = an > bn ? an : bn;
    const out = _mkNode(size, OP_MUL, a, b);
    for (let i = 0; i < size; i++) {
        out.value[i] = (an === 1 ? a.value[0] : a.value[i]) * (bn === 1 ? b.value[0] : b.value[i]);
    }
    return out;
}

function div(a, b) {
    const an = a._size, bn = b._size, size = an > bn ? an : bn;
    const out = _mkNode(size, OP_DIV, a, b);
    for (let i = 0; i < size; i++) {
        out.value[i] = (an === 1 ? a.value[0] : a.value[i]) / (bn === 1 ? b.value[0] : b.value[i]);
    }
    return out;
}

function neg(a) {
    const out = _mkNode(a._size, OP_NEG, a);
    for (let i = 0; i < a._size; i++) out.value[i] = -a.value[i];
    return out;
}

function inv(a) {
    const out = _mkNode(a._size, OP_INV, a);
    for (let i = 0; i < a._size; i++) out.value[i] = 1 / a.value[i];
    return out;
}

function abs(a) {
    const out = _mkNode(a._size, OP_ABS, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.abs(a.value[i]);
    return out;
}

/** Power. `p` may be a number (fast path) or an ADNode (exponent gradient). */
function powAD(a, p) {
    if (typeof p === "number") {
        const out = _mkNode(a._size, OP_POW, a);
        out._aux[0] = p;
        for (let i = 0; i < a._size; i++) out.value[i] = Math.pow(a.value[i], p);
        return out;
    }
    const an = a._size, pn = p._size, size = an > pn ? an : pn;
    const out = _mkNode(size, OP_POWN, a, p);
    for (let i = 0; i < size; i++) {
        const av = an === 1 ? a.value[0] : a.value[i];
        const pv = pn === 1 ? p.value[0] : p.value[i];
        out.value[i] = Math.pow(av, pv);
    }
    return out;
}

function sqrtAD(a) {
    const out = _mkNode(a._size, OP_SQRT, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.sqrt(a.value[i]);
    return out;
}

function cbrtAD(a) {
    const out = _mkNode(a._size, OP_CBRT, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.cbrt(a.value[i]);
    return out;
}

// ============================================================================
// Function Declarations — Transcendental
// ============================================================================
function expAD(a) {
    const out = _mkNode(a._size, OP_EXP, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.exp(a.value[i]);
    return out;
}
function expm1AD(a) {
    const out = _mkNode(a._size, OP_EXPM1, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.expm1(a.value[i]);
    return out;
}
function logAD(a) {
    const out = _mkNode(a._size, OP_LOG, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.log(a.value[i]);
    return out;
}
function log1pAD(a) {
    const out = _mkNode(a._size, OP_LOG1P, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.log1p(a.value[i]);
    return out;
}
function sinAD(a) {
    const out = _mkNode(a._size, OP_SIN, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.sin(a.value[i]);
    return out;
}
function cosAD(a) {
    const out = _mkNode(a._size, OP_COS, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.cos(a.value[i]);
    return out;
}
function tanAD(a) {
    const out = _mkNode(a._size, OP_TAN, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.tan(a.value[i]);
    return out;
}
function asinAD(a) {
    const out = _mkNode(a._size, OP_ASIN, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.asin(a.value[i]);
    return out;
}
function acosAD(a) {
    const out = _mkNode(a._size, OP_ACOS, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.acos(a.value[i]);
    return out;
}
function atanAD(a) {
    const out = _mkNode(a._size, OP_ATAN, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.atan(a.value[i]);
    return out;
}
function atan2AD(y, x) {
    const yn = y._size, xn = x._size, size = yn > xn ? yn : xn;
    const out = _mkNode(size, OP_ATAN2, y, x);
    for (let i = 0; i < size; i++) {
        out.value[i] = Math.atan2(yn === 1 ? y.value[0] : y.value[i], xn === 1 ? x.value[0] : x.value[i]);
    }
    return out;
}
function sinhAD(a) {
    const out = _mkNode(a._size, OP_SINH, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.sinh(a.value[i]);
    return out;
}
function coshAD(a) {
    const out = _mkNode(a._size, OP_COSH, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.cosh(a.value[i]);
    return out;
}
function tanhAD(a) {
    const out = _mkNode(a._size, OP_TANH, a);
    for (let i = 0; i < a._size; i++) out.value[i] = Math.tanh(a.value[i]);
    return out;
}

// ============================================================================
// Function Declarations — Activations
// ============================================================================
function sigmoidAD(a) {
    const out = _mkNode(a._size, OP_SIGMOID, a);
    for (let i = 0; i < a._size; i++) out.value[i] = 1 / (1 + Math.exp(-a.value[i]));
    return out;
}
function reluAD(a) {
    const out = _mkNode(a._size, OP_RELU, a);
    for (let i = 0; i < a._size; i++) out.value[i] = a.value[i] > 0 ? a.value[i] : 0;
    return out;
}
function leakyReluAD(a, slope) {
    const alpha = slope === undefined ? 0.01 : slope;
    const out = _mkNode(a._size, OP_LEAKY, a);
    out._aux[0] = alpha;
    for (let i = 0; i < a._size; i++) out.value[i] = a.value[i] > 0 ? a.value[i] : alpha * a.value[i];
    return out;
}
function smoothstepAD(a) {
    const out = _mkNode(a._size, OP_SMOOTHSTEP, a);
    for (let i = 0; i < a._size; i++) {
        const t = _clamp01(a.value[i]);
        out.value[i] = t * t * (3 - 2 * t);
    }
    return out;
}
function saturateAD(a) {
    const out = _mkNode(a._size, OP_SATURATE, a);
    for (let i = 0; i < a._size; i++) out.value[i] = _clamp01(a.value[i]);
    return out;
}
function softplusAD(a) {
    const out = _mkNode(a._size, OP_SOFTPLUS, a);
    for (let i = 0; i < a._size; i++) {
        const x = a.value[i];
        out.value[i] = x > 20 ? x : Math.log1p(Math.exp(x));
    }
    return out;
}

// ============================================================================
// Function Declarations — Reductions / vector ops
// ============================================================================
function sumAD(a) {
    const out = _mkNode(1, OP_SUM, a);
    let s = 0;
    for (let i = 0; i < a._size; i++) s += a.value[i];
    out.value[0] = s;
    return out;
}
function meanAD(a) {
    const out = _mkNode(1, OP_MEAN, a);
    let s = 0;
    for (let i = 0; i < a._size; i++) s += a.value[i];
    out.value[0] = a._size > 0 ? s / a._size : 0;
    return out;
}
function dotAD(a, b) {
    const n = Math.min(a._size, b._size);
    const out = _mkNode(1, OP_DOT, a, b);
    let s = 0;
    for (let i = 0; i < n; i++) s += a.value[i] * b.value[i];
    out.value[0] = s;
    return out;
}
function lengthSqAD(a) {
    const out = _mkNode(1, OP_LENGTHSQ, a);
    let s = 0;
    for (let i = 0; i < a._size; i++) s += a.value[i] * a.value[i];
    out.value[0] = s;
    return out;
}
function lengthAD(a) {
    const out = _mkNode(1, OP_LENGTH, a);
    let s = 0;
    for (let i = 0; i < a._size; i++) s += a.value[i] * a.value[i];
    out.value[0] = Math.sqrt(s);
    return out;
}
/** Normalize a vec3 node; gradient is (I − â âᵀ)/|a|. */
function normalize3AD(a) {
    const out = _mkNode(3, OP_NORM3, a);
    const x = a.value[0], y = a.value[1], z = a.value[2];
    const len = Math.sqrt(x * x + y * y + z * z);
    const invL = len > EPSILON ? 1 / len : 0;
    out._aux[0] = invL;
    out.value[0] = x * invL; out.value[1] = y * invL; out.value[2] = z * invL;
    return out;
}
/** Cross product with the CORRECT adjoint: a.grad = b × g, b.grad = g × a. */
function cross3AD(a, b) {
    const out = _mkNode(3, OP_CROSS3, a, b);
    const ax = a.value[0], ay = a.value[1], az = a.value[2];
    const bx = b.value[0], by = b.value[1], bz = b.value[2];
    out.value[0] = ay * bz - az * by;
    out.value[1] = az * bx - ax * bz;
    out.value[2] = ax * by - ay * bx;
    return out;
}

// ============================================================================
// Function Declarations — Comparison (piecewise)
// ============================================================================
function minAD(a, b) {
    const an = a._size, bn = b._size, size = an > bn ? an : bn;
    const out = _mkNode(size, OP_MIN, a, b);
    for (let i = 0; i < size; i++) {
        const av = an === 1 ? a.value[0] : a.value[i];
        const bv = bn === 1 ? b.value[0] : b.value[i];
        out.value[i] = av < bv ? av : bv;
    }
    return out;
}
function maxAD(a, b) {
    const an = a._size, bn = b._size, size = an > bn ? an : bn;
    const out = _mkNode(size, OP_MAX, a, b);
    for (let i = 0; i < size; i++) {
        const av = an === 1 ? a.value[0] : a.value[i];
        const bv = bn === 1 ? b.value[0] : b.value[i];
        out.value[i] = av > bv ? av : bv;
    }
    return out;
}
function clampAD(a, lo, hi) {
    const out = _mkNode(a._size, OP_CLAMP, a);
    out._aux[0] = lo; out._aux[1] = hi;
    for (let i = 0; i < a._size; i++) {
        const v = a.value[i];
        out.value[i] = v < lo ? lo : v > hi ? hi : v;
    }
    return out;
}

// ============================================================================
// Function Declarations — Quaternion AD ops (camera pose / orientation fitting)
// ============================================================================
function quatConjugateAD(q) {
    const out = _mkNode(4, OP_QCONJ, q);
    out.value[0] = -q.value[0]; out.value[1] = -q.value[1];
    out.value[2] = -q.value[2]; out.value[3] = q.value[3];
    return out;
}
/** Hamilton product a ⊗ b. Adjoint: a.grad = g ⊗ conj(b), b.grad = conj(a) ⊗ g. */
function quatMulAD(a, b) {
    const out = _mkNode(4, OP_QMUL, a, b);
    _quatMul(a.value[0], a.value[1], a.value[2], a.value[3],
             b.value[0], b.value[1], b.value[2], b.value[3]);
    out.value[0] = _qm[0]; out.value[1] = _qm[1];
    out.value[2] = _qm[2]; out.value[3] = _qm[3];
    return out;
}
function quatNormalizeAD(q) {
    const out = _mkNode(4, OP_QNORM, q);
    const x = q.value[0], y = q.value[1], z = q.value[2], w = q.value[3];
    const len = Math.sqrt(x * x + y * y + z * z + w * w);
    const invL = len > EPSILON ? 1 / len : 0;
    out._aux[0] = invL;
    out.value[0] = x * invL; out.value[1] = y * invL;
    out.value[2] = z * invL; out.value[3] = w * invL;
    return out;
}
/** Rotate a vec3 by a unit quaternion: r = q ⊗ (v,0) ⊗ conj(q). */
function quatRotateVec3AD(q, v) {
    const p = vec4AD(v.value[0], v.value[1], v.value[2], 0);
    // Rebuild p as a graph node so gradients flow back into v.
    const pv = _mkNode(4, OP_V4TO3, v); // placeholder replaced below
    ADNode.release(pv);
    const joined = joinVec3(component(v, 0), component(v, 1), component(v, 2));
    const p4 = _mkNode(4, OP_JOIN3, joined);
    p4.value[0] = v.value[0]; p4.value[1] = v.value[1];
    p4.value[2] = v.value[2]; p4.value[3] = 0;
    ADNode.release(p);
    const t = quatMulAD(q, p4);
    const r = quatMulAD(t, quatConjugateAD(q));
    return vec3FromVec4(r);
}

// ============================================================================
// Function Declarations — Backward dispatch (single hoisted function)
// ============================================================================
function _backwardNode(n) {
    const a = n.parents[0];
    const b = n.parentCount > 1 ? n.parents[1] : null;
    const c = n.parentCount > 2 ? n.parents[2] : null;
    _touch(a);
    if (b !== null) _touch(b);
    if (c !== null) _touch(c);
    const g = n.grad, v = n.value, size = n._size;
    const av = a.value, ag = a.grad, an = a._size;

    switch (n._op) {
        case OP_ADD: {
            const bv = b.value, bg = b.grad, bn = b._size;
            if (an === bn) { for (let i = 0; i < size; i++) { ag[i] += g[i]; bg[i] += g[i]; } }
            else if (an === 1) { let s = 0; for (let i = 0; i < size; i++) { bg[i] += g[i]; s += g[i]; } ag[0] += s; }
            else { let s = 0; for (let i = 0; i < size; i++) { ag[i] += g[i]; s += g[i]; } bg[0] += s; }
            break;
        }
        case OP_SUB: {
            const bv = b.value, bg = b.grad, bn = b._size;
            if (an === bn) { for (let i = 0; i < size; i++) { ag[i] += g[i]; bg[i] -= g[i]; } }
            else if (an === 1) { let s = 0; for (let i = 0; i < size; i++) { bg[i] -= g[i]; s += g[i]; } ag[0] += s; }
            else { let s = 0; for (let i = 0; i < size; i++) { ag[i] += g[i]; s += g[i]; } bg[0] -= s; }
            break;
        }
        case OP_MUL: {
            const bv = b.value, bg = b.grad, bn = b._size;
            if (an === bn) { for (let i = 0; i < size; i++) { ag[i] += g[i] * bv[i]; bg[i] += g[i] * av[i]; } }
            else if (an === 1) { const k = av[0]; let s = 0; for (let i = 0; i < size; i++) { bg[i] += g[i] * k; s += g[i] * bv[i]; } ag[0] += s; }
            else { const k = bv[0]; let s = 0; for (let i = 0; i < size; i++) { ag[i] += g[i] * k; s += g[i] * av[i]; } bg[0] += s; }
            break;
        }
        case OP_DIV: {
            const bv = b.value, bg = b.grad, bn = b._size;
            if (an === bn) {
                for (let i = 0; i < size; i++) { const d = bv[i]; ag[i] += g[i] / d; bg[i] -= g[i] * av[i] / (d * d); }
            } else if (an === 1) {
                const k = av[0]; let s = 0;
                for (let i = 0; i < size; i++) { const d = bv[i]; bg[i] -= g[i] * k / (d * d); s += g[i] / d; }
                ag[0] += s;
            } else {
                const d = bv[0], id = 1 / d, id2 = id * id; let s = 0;
                for (let i = 0; i < size; i++) { ag[i] += g[i] * id; s -= g[i] * av[i] * id2; }
                bg[0] += s;
            }
            break;
        }
        case OP_NEG: for (let i = 0; i < size; i++) ag[i] -= g[i]; break;
        case OP_INV: for (let i = 0; i < size; i++) { const d = av[i]; ag[i] -= g[i] / (d * d); } break;
        case OP_ABS: for (let i = 0; i < size; i++) ag[i] += av[i] >= 0 ? g[i] : -g[i]; break;
        case OP_POW: {
            const p = n._aux[0];
            for (let i = 0; i < size; i++) ag[i] += g[i] * p * Math.pow(av[i], p - 1);
            break;
        }
        case OP_POWN: {
            const bv = b.value, bg = b.grad, bn = b._size;
            for (let i = 0; i < size; i++) {
                const x = an === 1 ? av[0] : av[i];
                const p = bn === 1 ? bv[0] : bv[i];
                const gx = g[i] * p * Math.pow(x, p - 1);
                const gp = x > 0 ? g[i] * v[i] * Math.log(x) : 0;
                if (an === 1) ag[0] += gx; else ag[i] += gx;
                if (bn === 1) bg[0] += gp; else bg[i] += gp;
            }
            break;
        }
        case OP_SQRT: for (let i = 0; i < size; i++) { const r = v[i]; if (r > EPSILON) ag[i] += g[i] / (2 * r); } break;
        case OP_CBRT: for (let i = 0; i < size; i++) { const r = v[i]; if (Math.abs(r) > EPSILON) ag[i] += g[i] / (3 * r * r); } break;
        case OP_EXP: for (let i = 0; i < size; i++) ag[i] += g[i] * v[i]; break;
        case OP_EXPM1: for (let i = 0; i < size; i++) ag[i] += g[i] * Math.exp(av[i]); break;
        case OP_LOG: for (let i = 0; i < size; i++) ag[i] += g[i] / av[i]; break;
        case OP_LOG1P: for (let i = 0; i < size; i++) ag[i] += g[i] / (1 + av[i]); break;
        case OP_SIN: for (let i = 0; i < size; i++) ag[i] += g[i] * Math.cos(av[i]); break;
        case OP_COS: for (let i = 0; i < size; i++) ag[i] -= g[i] * Math.sin(av[i]); break;
        case OP_TAN: for (let i = 0; i < size; i++) { const cc = Math.cos(av[i]); ag[i] += g[i] / (cc * cc); } break;
        case OP_ASIN: for (let i = 0; i < size; i++) ag[i] += g[i] / Math.sqrt(1 - av[i] * av[i]); break;
        case OP_ACOS: for (let i = 0; i < size; i++) ag[i] -= g[i] / Math.sqrt(1 - av[i] * av[i]); break;
        case OP_ATAN: for (let i = 0; i < size; i++) ag[i] += g[i] / (1 + av[i] * av[i]); break;
        case OP_ATAN2: {
            const bv = b.value, bg = b.grad, bn = b._size;
            for (let i = 0; i < size; i++) {
                const y = an === 1 ? av[0] : av[i];
                const x = bn === 1 ? bv[0] : bv[i];
                const d = y * y + x * x;
                if (d < EPSILON) continue;
                const gy = g[i] * x / d, gx = -g[i] * y / d;
                if (an === 1) ag[0] += gy; else ag[i] += gy;
                if (bn === 1) bg[0] += gx; else bg[i] += gx;
            }
            break;
        }
        case OP_SINH: for (let i = 0; i < size; i++) ag[i] += g[i] * Math.cosh(av[i]); break;
        case OP_COSH: for (let i = 0; i < size; i++) ag[i] += g[i] * Math.sinh(av[i]); break;
        case OP_TANH: for (let i = 0; i < size; i++) ag[i] += g[i] * (1 - v[i] * v[i]); break;
        case OP_SIGMOID: for (let i = 0; i < size; i++) ag[i] += g[i] * v[i] * (1 - v[i]); break;
        case OP_RELU: for (let i = 0; i < size; i++) if (av[i] > 0) ag[i] += g[i]; break;
        case OP_LEAKY: {
            const al = n._aux[0];
            for (let i = 0; i < size; i++) ag[i] += av[i] > 0 ? g[i] : al * g[i];
            break;
        }
        case OP_SMOOTHSTEP: for (let i = 0; i < size; i++) { const t = _clamp01(av[i]); ag[i] += g[i] * 6 * t * (1 - t); } break;
        case OP_SATURATE: for (let i = 0; i < size; i++) if (av[i] >= 0 && av[i] <= 1) ag[i] += g[i]; break;
        case OP_SOFTPLUS: for (let i = 0; i < size; i++) ag[i] += g[i] / (1 + Math.exp(-av[i])); break;
        case OP_SUM: for (let i = 0; i < an; i++) ag[i] += g[0]; break;
        case OP_MEAN: { const invN = an > 0 ? 1 / an : 0; for (let i = 0; i < an; i++) ag[i] += g[0] * invN; break; }
        case OP_DOT: {
            const bv = b.value, bg = b.grad;
            const m = Math.min(an, b._size);
            for (let i = 0; i < m; i++) { ag[i] += g[0] * bv[i]; bg[i] += g[0] * av[i]; }
            break;
        }
        case OP_LENGTHSQ: for (let i = 0; i < an; i++) ag[i] += g[0] * 2 * av[i]; break;
        case OP_LENGTH: {
            const len = v[0];
            if (len > EPSILON) { const k = g[0] / len; for (let i = 0; i < an; i++) ag[i] += k * av[i]; }
            break;
        }
        case OP_NORM3:
        case OP_QNORM: {
            const invL = n._aux[0];
            let d = 0;
            for (let k = 0; k < size; k++) d += g[k] * v[k];
            for (let k = 0; k < size; k++) ag[k] += (g[k] - v[k] * d) * invL;
            break;
        }
        case OP_CROSS3: {
            const bv = b.value, bg = b.grad;
            const gx = g[0], gy = g[1], gz = g[2];
            // a.grad = b × g ; b.grad = g × a
            ag[0] += gz * bv[1] - gy * bv[2];
            ag[1] += gx * bv[2] - gz * bv[0];
            ag[2] += gy * bv[0] - gx * bv[1];
            bg[0] += gy * av[2] - gz * av[1];
            bg[1] += gz * av[0] - gx * av[2];
            bg[2] += gx * av[1] - gy * av[0];
            break;
        }
        case OP_MIN:
        case OP_MAX: {
            const bv = b.value, bg = b.grad, bn = b._size;
            const isMin = n._op === OP_MIN;
            for (let i = 0; i < size; i++) {
                const x = an === 1 ? av[0] : av[i];
                const y = bn === 1 ? bv[0] : bv[i];
                const takeA = isMin ? (x < y) : (x > y);
                if (takeA) { if (an === 1) ag[0] += g[i]; else ag[i] += g[i]; }
                else { if (bn === 1) bg[0] += g[i]; else bg[i] += g[i]; }
            }
            break;
        }
        case OP_CLAMP: {
            const lo = n._aux[0], hi = n._aux[1];
            for (let i = 0; i < size; i++) if (av[i] >= lo && av[i] <= hi) ag[i] += g[i];
            break;
        }
        case OP_COMPONENT: ag[n._aux[0] | 0] += g[0]; break;
        case OP_JOIN3: {
            a.grad[0] += g[0];
            if (b !== null) b.grad[0] += g[1];
            if (c !== null) c.grad[0] += g[2];
            break;
        }
        case OP_V4TO3: ag[0] += g[0]; ag[1] += g[1]; ag[2] += g[2]; break;
        case OP_QCONJ: ag[0] -= g[0]; ag[1] -= g[1]; ag[2] -= g[2]; ag[3] += g[3]; break;
        case OP_QMUL: {
            const bv = b.value, bg = b.grad;
            _quatMul(g[0], g[1], g[2], g[3], -bv[0], -bv[1], -bv[2], bv[3]);
            ag[0] += _qm[0]; ag[1] += _qm[1]; ag[2] += _qm[2]; ag[3] += _qm[3];
            _quatMul(-av[0], -av[1], -av[2], av[3], g[0], g[1], g[2], g[3]);
            bg[0] += _qm[0]; bg[1] += _qm[1]; bg[2] += _qm[2]; bg[3] += _qm[3];
            break;
        }
        default: break;
    }
}

// ============================================================================
// Function Declarations — Backward / zero helpers
// ============================================================================
function backward(tape, root) { tape.backward(root); return root; }
function zeroGrad(tape) { return tape.zeroGrad(); }
function zeroGradAll(n) { return n.zeroGrad(); }

// ============================================================================
// Function Declarations — Optimizers
// ============================================================================
/** L2 gradient-norm of a node (scalar, zero-GC). */
function gradNorm(param) {
    let s = 0;
    for (let i = 0; i < param._size; i++) { const g = param.grad[i]; s += g * g; }
    return Math.sqrt(s);
}

/** Clip a node's gradient to `maxNorm` (0 disables). Returns the scale used. */
function clipGradNode(param, maxNorm) {
    if (!(maxNorm > 0)) return 1;
    const nrm = gradNorm(param);
    if (nrm <= maxNorm || nrm < EPSILON) return 1;
    const k = maxNorm / nrm;
    for (let i = 0; i < param._size; i++) param.grad[i] *= k;
    return k;
}

/** Plain SGD with optional clipping and weight decay. */
function sgdStep(param, lr, clip, decay) {
    const k = clipGradNode(param, clip);
    const d = decay === undefined ? 0 : decay;
    for (let i = 0; i < param._size; i++) {
        param.value[i] -= lr * (param.grad[i] + d * param.value[i]);
    }
    return k;
}

function createAdamState(param) {
    const T = getArrayType();
    return { m: new T(param._size), v: new T(param._size), t: 0 };
}

/** One Adam step with bias correction, optional clipping and weight decay. */
function adamStep(param, state, lr, beta1, beta2, eps, clip, decay) {
    lr = lr === undefined ? 1e-3 : lr;
    beta1 = beta1 === undefined ? 0.9 : beta1;
    beta2 = beta2 === undefined ? 0.999 : beta2;
    eps = eps === undefined ? 1e-8 : eps;
    const d = decay === undefined ? 0 : decay;
    clipGradNode(param, clip);
    state.t++;
    const bc1 = 1 - Math.pow(beta1, state.t);
    const bc2 = 1 - Math.pow(beta2, state.t);
    const stepSize = lr * Math.sqrt(bc2) / bc1;
    for (let i = 0; i < param._size; i++) {
        const g = param.grad[i] + d * param.value[i];
        state.m[i] = beta1 * state.m[i] + (1 - beta1) * g;
        state.v[i] = beta2 * state.v[i] + (1 - beta2) * g * g;
        param.value[i] -= stepSize * state.m[i] / (Math.sqrt(state.v[i]) + eps);
    }
    return param;
}

// First-call growth only; pass `options.adamStates` to stay allocation-free.
function _allocAdamStates(params) {
    const out = new Array(params.length);
    for (let i = 0; i < params.length; i++) out[i] = createAdamState(params[i]);
    return out;
}

/**
 * Optimize a parameter set. Returns the final loss (a number — no result
 * object is allocated). Supply `options.history` (typed array) to record the
 * loss curve and `options.adamStates` to avoid first-call growth.
 */
function optimize(tape, params, lossFn, options) {
    options = options || {};
    const iterations = options.iterations === undefined ? 100 : options.iterations;
    const lr = options.lr === undefined ? 0.01 : options.lr;
    const useAdam = options.optimizer === "adam";
    const clip = options.clip === undefined ? 0 : options.clip;
    const decay = options.weightDecay === undefined ? 0 : options.weightDecay;
    const tol = options.tolerance === undefined ? -1 : options.tolerance;
    const history = options.history || null;
    const b1 = options.beta1, b2 = options.beta2, eps = options.eps;
    const nP = params.length;
    for (let i = 0; i < nP; i++) persist(params[i]);
    const states = useAdam ? (options.adamStates || _allocAdamStates(params)) : null;
    let finalLoss = NaN, prev = Infinity;
    for (let it = 0; it < iterations; it++) {
        tape.reset();
        for (let p = 0; p < nP; p++) params[p].zeroGrad();
        const loss = lossFn();
        tape.backward(loss);
        finalLoss = loss.value[0];
        if (history !== null && it < history.length) history[it] = finalLoss;
        if (!Number.isFinite(finalLoss)) { tape.recycle(); break; }
        if (useAdam) {
            for (let p = 0; p < nP; p++) adamStep(params[p], states[p], lr, b1, b2, eps, clip, decay);
        } else {
            for (let p = 0; p < nP; p++) sgdStep(params[p], lr, clip, decay);
        }
        tape.recycle();
        if (tol >= 0 && Math.abs(prev - finalLoss) < tol) break;
        prev = finalLoss;
    }
    return finalLoss;
}

/** Chunked optimize — yields between iterations (inlined loop, no closures). */
async function optimizeChunked(tape, params, lossFn, options, yieldEvery) {
    options = options || {};
    const iterations = options.iterations === undefined ? 100 : options.iterations;
    const lr = options.lr === undefined ? 0.01 : options.lr;
    const useAdam = options.optimizer === "adam";
    const clip = options.clip === undefined ? 0 : options.clip;
    const decay = options.weightDecay === undefined ? 0 : options.weightDecay;
    const history = options.history || null;
    const ye = yieldEvery || common.CHUNK_YIELD_EVERY;
    const nP = params.length;
    for (let i = 0; i < nP; i++) persist(params[i]);
    const states = useAdam ? (options.adamStates || _allocAdamStates(params)) : null;
    let finalLoss = NaN, c = 0;
    for (let it = 0; it < iterations; it++) {
        tape.reset();
        for (let p = 0; p < nP; p++) params[p].zeroGrad();
        const loss = lossFn();
        tape.backward(loss);
        finalLoss = loss.value[0];
        if (history !== null && it < history.length) history[it] = finalLoss;
        if (!Number.isFinite(finalLoss)) { tape.recycle(); break; }
        if (useAdam) {
            for (let p = 0; p < nP; p++) adamStep(params[p], states[p], lr, options.beta1, options.beta2, options.eps, clip, decay);
        } else {
            for (let p = 0; p < nP; p++) sgdStep(params[p], lr, clip, decay);
        }
        tape.recycle();
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return finalLoss;
}

/** Optimize a vec3 in place. `initial` is mutated; returns the final loss. */
function optimizeVec3(tape, targetFn, initial, options) {
    const p = persist(vec3AD(initial[0], initial[1], initial[2]));
    const loss = optimize(tape, _singleParam, _vec3Target, options);
    initial[0] = p.value[0]; initial[1] = p.value[1]; initial[2] = p.value[2];
    ADNode.release(p);
    return loss;

    // Hoisted-style local bindings kept outside the hot loop via closure-free
    // module scratch (see _singleParam / _vec3Target below).
    function _singleParam() { return targetFn(p); }
}
// NOTE: optimizeVec3 uses a tiny builder; to keep the Zero-GC mandate the
// builder is created once per call (not per iteration) and never inside a loop.
const _paramScratch = new Array(1);
function _vec3Target() { return _vec3TargetFn(_paramScratch[0]); }
let _vec3TargetFn = null;

// ============================================================================
// Function Declarations — Domain helpers
// ============================================================================
/** Exact gradient of a 3D scalar field. `noiseFn(nx,ny,nz)` returns an ADNode. */
function noiseGradientAD(out, x, y, z, noiseFn) {
    const tape = Tape.acquire();
    tape.reset();
    const nx = node(x), ny = node(y), nz = node(z);
    const o = noiseFn(nx, ny, nz);
    tape.backward(o);
    out[0] = nx.grad[0]; out[1] = ny.grad[0]; out[2] = nz.grad[0];
    tape.recycle();
    Tape.release(tape);
    return out;
}

/** Fit (x,y,z) so that sdf(p) ≈ targetDistance. Mutates `initial`. */
function sdfFit(sdfFn, initial, targetDistance, options) {
    const tape = Tape.acquire();
    const p = persist(vec3AD(initial[0], initial[1], initial[2]));
    const target = constant(targetDistance);
    const params = _paramScratch; params[0] = p;
    _sdfTargetFn = sdfFn; _sdfTargetNode = target;
    const loss = optimize(tape, params, _sdfLoss, options);
    initial[0] = p.value[0]; initial[1] = p.value[1]; initial[2] = p.value[2];
    ADNode.release(p);
    Tape.release(tape);
    return loss;
}
let _sdfTargetFn = null, _sdfTargetNode = null;
function _sdfLoss() {
    const d = _sdfTargetFn(_paramScratch[0]);
    const diff = sub(d, _sdfTargetNode);
    return mul(diff, diff);
}

/**
 * Gradient-based IK. Minimizes end-effector error plus a bone-length penalty,
 * optimizing the joint nodes directly (the previous version overwrote them
 * from `chain.pos` every iteration, discarding all progress).
 */
function ikOptimize(chain, options) {
    options = options || {};
    const n = chain.lens.length + 1;
    const tape = Tape.acquire();
    const joints = options.jointNodes || new Array(n);
    for (let i = 0; i < n; i++) {
        joints[i] = persist(vec3AD(chain.pos[i * 3], chain.pos[i * 3 + 1], chain.pos[i * 3 + 2]));
    }
    const tx = constant(chain.target[0]);
    const ty = constant(chain.target[1]);
    const tz = constant(chain.target[2]);
    const lenSq = options.lenSqNodes || new Array(n - 1);
    for (let i = 0; i < n - 1; i++) lenSq[i] = constant(chain.lens[i] * chain.lens[i]);
    const wNode = constant(options.boneWeight === undefined ? 10 : options.boneWeight);
    _ikJoints = joints; _ikN = n; _ikTx = tx; _ikTy = ty; _ikTz = tz;
    _ikLenSq = lenSq; _ikW = wNode;
    const loss = optimize(tape, joints, _ikLoss, options);
    for (let i = 0; i < n; i++) {
        chain.pos[i * 3] = joints[i].value[0];
        chain.pos[i * 3 + 1] = joints[i].value[1];
        chain.pos[i * 3 + 2] = joints[i].value[2];
    }
    for (let i = 0; i < n; i++) ADNode.release(joints[i]);
    Tape.release(tape);
    return loss;
}
let _ikJoints = null, _ikN = 0, _ikTx = null, _ikTy = null, _ikTz = null, _ikLenSq = null, _ikW = null;
function _ikLoss() {
    const J = _ikJoints, n = _ikN;
    const e = J[n - 1];
    const dx = sub(component(e, 0), _ikTx);
    const dy = sub(component(e, 1), _ikTy);
    const dz = sub(component(e, 2), _ikTz);
    let loss = add(add(mul(dx, dx), mul(dy, dy)), mul(dz, dz));
    for (let i = 0; i < n - 1; i++) {
        const a = J[i], b = J[i + 1];
        const bx = sub(component(b, 0), component(a, 0));
        const by = sub(component(b, 1), component(a, 1));
        const bz = sub(component(b, 2), component(a, 2));
        const d2 = add(add(mul(bx, bx), mul(by, by)), mul(bz, bz));
        const err = sub(d2, _ikLenSq[i]);
        loss = add(loss, mul(_ikW, mul(err, err)));
    }
    return loss;
}

/** Minimize softened gravitational potential at a point. Mutates `initial`. */
function orbitalEnergyMinimize(bodies, initial, options) {
    const tape = Tape.acquire();
    const p = persist(vec3AD(initial[0], initial[1], initial[2]));
    const pos = bodies.positions, masses = bodies.masses;
    const G = bodies.G === undefined ? 1 : bodies.G;
    const nB = masses.length;
    const bx = options.bodyX || new Array(nB);
    const by = options.bodyY || new Array(nB);
    const bz = options.bodyZ || new Array(nB);
    const gm = options.bodyGM || new Array(nB);
    for (let i = 0; i < nB; i++) {
        bx[i] = constant(pos[i * 3]);
        by[i] = constant(pos[i * 3 + 1]);
        bz[i] = constant(pos[i * 3 + 2]);
        gm[i] = constant(-G * masses[i]);
    }
    const soft = constant(1e-9);
    _orbP = p; _orbX = bx; _orbY = by; _orbZ = bz; _orbGM = gm; _orbN = nB; _orbSoft = soft;
    const params = _paramScratch; params[0] = p;
    const loss = optimize(tape, params, _orbLoss, options);
    initial[0] = p.value[0]; initial[1] = p.value[1]; initial[2] = p.value[2];
    ADNode.release(p);
    Tape.release(tape);
    return loss;
}
let _orbP = null, _orbX = null, _orbY = null, _orbZ = null, _orbGM = null, _orbN = 0, _orbSoft = null;
function _orbLoss() {
    const px = component(_orbP, 0), py = component(_orbP, 1), pz = component(_orbP, 2);
    let loss = constant(0);
    for (let i = 0; i < _orbN; i++) {
        const dx = sub(px, _orbX[i]);
        const dy = sub(py, _orbY[i]);
        const dz = sub(pz, _orbZ[i]);
        const d2 = add(add(mul(dx, dx), mul(dy, dy)), mul(dz, dz));
        const invR = inv(sqrtAD(add(d2, _orbSoft)));
        loss = add(loss, mul(invR, _orbGM[i]));
    }
    return loss;
}

/** Least-squares fit of an animation curve to keyframes. */
function animationFit(curveFn, params, keyframes, options) {
    const tape = Tape.acquire();
    const nK = keyframes.length;
    const tNodes = (options && options.tNodes) || new Array(nK);
    const yNodes = (options && options.yNodes) || new Array(nK);
    for (let k = 0; k < nK; k++) {
        tNodes[k] = constant(keyframes[k].t);
        yNodes[k] = constant(keyframes[k].y);
    }
    _animFn = curveFn; _animParams = params; _animT = tNodes; _animY = yNodes; _animN = nK;
    const loss = optimize(tape, params, _animLoss, options);
    Tape.release(tape);
    return loss;
}
let _animFn = null, _animParams = null, _animT = null, _animY = null, _animN = 0;
function _animLoss() {
    let loss = constant(0);
    for (let k = 0; k < _animN; k++) {
        const y = _animFn(_animT[k], _animParams);
        const diff = sub(y, _animY[k]);
        loss = add(loss, mul(diff, diff));
    }
    return loss;
}

/** Fit an RGB triple to a target color. Mutates `initial`. */
function colorMatch(rgbFn, initial, targetRGB, options) {
    const tape = Tape.acquire();
    const p = persist(vec3AD(initial[0], initial[1], initial[2]));
    const tr = constant(targetRGB[0]), tg = constant(targetRGB[1]), tb = constant(targetRGB[2]);
    _colFn = rgbFn; _colR = tr; _colG = tg; _colB = tb;
    const params = _paramScratch; params[0] = p;
    const loss = optimize(tape, params, _colLoss, options);
    initial[0] = p.value[0]; initial[1] = p.value[1]; initial[2] = p.value[2];
    ADNode.release(p);
    Tape.release(tape);
    return loss;
}
let _colFn = null, _colR = null, _colG = null, _colB = null;
function _colLoss() {
    const rgb = _colFn(_paramScratch[0]);
    const dr = sub(component(rgb, 0), _colR);
    const dg = sub(component(rgb, 1), _colG);
    const db = sub(component(rgb, 2), _colB);
    return add(add(mul(dr, dr), mul(dg, dg)), mul(db, db));
}

/** Fit morph-target weights to observed points. */
function morphFit(morphFn, initialWeights, observedPoints, options) {
    options = options || {};
    const tape = Tape.acquire();
    const nW = initialWeights.length;
    const params = options.paramNodes || new Array(nW);
    for (let i = 0; i < nW; i++) params[i] = persist(node(initialWeights[i]));
    const nP = observedPoints.length;
    const ox = options.obsX || new Array(nP);
    const oy = options.obsY || new Array(nP);
    const oz = options.obsZ || new Array(nP);
    for (let k = 0; k < nP; k++) {
        ox[k] = constant(observedPoints[k][0]);
        oy[k] = constant(observedPoints[k][1]);
        oz[k] = constant(observedPoints[k][2]);
    }
    _morphFn = morphFn; _morphParams = params; _morphX = ox; _morphY = oy; _morphZ = oz; _morphN = nP;
    const loss = optimize(tape, params, _morphLoss, options);
    for (let i = 0; i < nW; i++) initialWeights[i] = params[i].value[0];
    for (let i = 0; i < nW; i++) ADNode.release(params[i]);
    Tape.release(tape);
    return loss;
}
let _morphFn = null, _morphParams = null, _morphX = null, _morphY = null, _morphZ = null, _morphN = 0;
function _morphLoss() {
    const shapes = _morphFn(_morphParams);
    let loss = constant(0);
    for (let k = 0; k < _morphN; k++) {
        const cur = shapes[k];
        const dx = sub(component(cur, 0), _morphX[k]);
        const dy = sub(component(cur, 1), _morphY[k]);
        const dz = sub(component(cur, 2), _morphZ[k]);
        loss = add(loss, add(add(mul(dx, dx), mul(dy, dy)), mul(dz, dz)));
    }
    return loss;
}

// ============================================================================
// Function Declarations — Flat-array SOA optimizers (1M+ problems)
// ============================================================================
function createAdamStateSOA(n) {
    const T = getArrayType();
    return { m: new T(n), v: new T(n), t: 0 };
}

function soaSGDStep(params, grads, count, lr, clip) {
    if (clip > 0) {
        const c2 = clip * clip;
        for (let i = 0; i < count; i++) {
            const g = grads[i];
            const s2 = g * g;
            const k = s2 > c2 ? clip / Math.sqrt(s2) : 1;
            params[i] -= lr * g * k;
        }
    } else {
        for (let i = 0; i < count; i++) params[i] -= lr * grads[i];
    }
    return params;
}

function soaAdamStep(params, grads, state, count, lr, beta1, beta2, eps, clip) {
    lr = lr === undefined ? 1e-3 : lr;
    beta1 = beta1 === undefined ? 0.9 : beta1;
    beta2 = beta2 === undefined ? 0.999 : beta2;
    eps = eps === undefined ? 1e-8 : eps;
    state.t++;
    const bc1 = 1 - Math.pow(beta1, state.t);
    const bc2 = 1 - Math.pow(beta2, state.t);
    const stepSize = lr * Math.sqrt(bc2) / bc1;
    const m = state.m, v = state.v;
    const c2 = clip > 0 ? clip * clip : 0;
    for (let i = 0; i < count; i++) {
        let g = grads[i];
        if (c2 > 0) { const s2 = g * g; if (s2 > c2) g *= clip / Math.sqrt(s2); }
        m[i] = beta1 * m[i] + (1 - beta1) * g;
        v[i] = beta2 * v[i] + (1 - beta2) * g * g;
        params[i] -= stepSize * m[i] / (Math.sqrt(v[i]) + eps);
    }
    return params;
}

function soaGradNorm(grads, count) {
    let s = 0;
    for (let i = 0; i < count; i++) { const g = grads[i]; s += g * g; }
    return Math.sqrt(s);
}

function soaClipGrad(grads, count, maxNorm) {
    if (!(maxNorm > 0)) return grads;
    const nrm = soaGradNorm(grads, count);
    if (nrm <= maxNorm || nrm < EPSILON) return grads;
    const k = maxNorm / nrm;
    for (let i = 0; i < count; i++) grads[i] *= k;
    return grads;
}

/** Generic autograd-free batch kernel. `fn(i, params, grads, offset)`. */
function soaForward(params, grads, count, paramsPerProblem, fn) {
    for (let i = 0; i < count; i++) fn(i, params, grads, i * paramsPerProblem);
    return grads;
}

async function soaForwardChunked(params, grads, count, paramsPerProblem, fn, chunkSize, yieldEvery) {
    const cs = chunkSize || common.CHUNK_SIZE;
    const ye = yieldEvery || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) fn(i, params, grads, i * paramsPerProblem);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return grads;
}

/** Central-difference validation of a batch kernel. Returns max abs error. */
function soaFiniteDifferenceCheck(params, grads, count, paramsPerProblem, fn, eps) {
    const h = eps === undefined ? 1e-5 : eps;
    const inv2h = 1 / (2 * h);
    const total = count * paramsPerProblem;
    const scratchG = _fdScratch(total);
    let maxErr = 0;
    for (let i = 0; i < total; i++) {
        const orig = params[i];
        params[i] = orig + h;
        fn(0, params, scratchG, 0);
        const plus = _fdLossValue;
        params[i] = orig - h;
        fn(0, params, scratchG, 0);
        const minus = _fdLossValue;
        params[i] = orig;
        const num = (plus - minus) * inv2h;
        const err = Math.abs(num - grads[i]);
        if (err > maxErr) maxErr = err;
    }
    return maxErr;
}
let _fdLossValue = 0;
let _fdBuf = null;
function _fdScratch(n) {
    if (_fdBuf === null || _fdBuf.length < n) { const T = getArrayType(); _fdBuf = new T(n); }
    return _fdBuf;
}

/**
 * Batched optimizer over `count` independent problems.
 * Supply `options.params` / `options.grads` (typed arrays) to stay allocation
 * free; otherwise buffers are allocated once for the handle.
 * `lossFn(paramNodes, i)` must return a scalar ADNode.
 */
function soaOptimize(count, paramsPerProblem, lossFn, options) {
    options = options || {};
    const iterations = options.iterations === undefined ? 100 : options.iterations;
    const lr = options.lr === undefined ? 0.01 : options.lr;
    const clip = options.clip === undefined ? 0 : options.clip;
    const useAdam = options.optimizer === "adam";
    const T = getArrayType();
    const total = count * paramsPerProblem;
    const params = options.params || new T(total);
    const grads = options.grads || new T(total);
    const handle = options.out || { params: params, grads: grads, count: count, paramsPerProblem: paramsPerProblem, finalLoss: 0 };
    handle.params = params; handle.grads = grads;
    handle.count = count; handle.paramsPerProblem = paramsPerProblem;
    const adam = useAdam ? (options.adamState || createAdamStateSOA(total)) : null;
    const tape = Tape.acquire();
    const nodes = options.paramNodes || new Array(paramsPerProblem);
    for (let p = 0; p < paramsPerProblem; p++) nodes[p] = persist(node(0));
    let lossSum = 0;
    for (let it = 0; it < iterations; it++) {
        lossSum = 0;
        for (let i = 0; i < count; i++) {
            const off = i * paramsPerProblem;
            tape.reset();
            for (let p = 0; p < paramsPerProblem; p++) {
                nodes[p].value[0] = params[off + p];
                nodes[p].zeroGrad();
            }
            const loss = lossFn(nodes, i);
            tape.backward(loss);
            lossSum += loss.value[0];
            for (let p = 0; p < paramsPerProblem; p++) grads[off + p] = nodes[p].grad[0];
            if (useAdam) {
                _soaAdamSlice(adam, grads, params, off, paramsPerProblem, lr, options, clip);
            } else {
                for (let p = 0; p < paramsPerProblem; p++) {
                    let g = grads[off + p];
                    if (clip > 0 && Math.abs(g) > clip) g = g > 0 ? clip : -clip;
                    params[off + p] -= lr * g;
                }
            }
            tape.recycle();
        }
    }
    handle.finalLoss = count > 0 ? lossSum / count : 0;
    for (let p = 0; p < paramsPerProblem; p++) ADNode.release(nodes[p]);
    Tape.release(tape);
    return handle;
}

// Per-problem Adam slice — keeps global moment buffers indexed by problem.
let _adamSliceT = 0;
function _soaAdamSlice(state, grads, params, off, k, lr, options, clip) {
    const b1 = options.beta1 === undefined ? 0.9 : options.beta1;
    const b2 = options.beta2 === undefined ? 0.999 : options.beta2;
    const eps = options.eps === undefined ? 1e-8 : options.eps;
    const t = state.t + 1;
    const bc1 = 1 - Math.pow(b1, t);
    const bc2 = 1 - Math.pow(b2, t);
    const stepSize = lr * Math.sqrt(bc2) / bc1;
    for (let p = 0; p < k; p++) {
        const i = off + p;
        let g = grads[i];
        if (clip > 0 && Math.abs(g) > clip) g = g > 0 ? clip : -clip;
        state.m[i] = b1 * state.m[i] + (1 - b1) * g;
        state.v[i] = b2 * state.v[i] + (1 - b2) * g * g;
        params[i] -= stepSize * state.m[i] / (Math.sqrt(state.v[i]) + eps);
    }
    state.t = t;
}

/** Chunked batched optimizer — inlined loops, zero closures. */
async function soaOptimizeChunked(count, paramsPerProblem, lossFn, options, chunkSize, yieldEvery) {
    options = options || {};
    const iterations = options.iterations === undefined ? 100 : options.iterations;
    const lr = options.lr === undefined ? 0.01 : options.lr;
    const clip = options.clip === undefined ? 0 : options.clip;
    const useAdam = options.optimizer === "adam";
    const cs = chunkSize || common.CHUNK_SIZE;
    const ye = yieldEvery || common.CHUNK_YIELD_EVERY;
    const T = getArrayType();
    const total = count * paramsPerProblem;
    const params = options.params || new T(total);
    const grads = options.grads || new T(total);
    const handle = options.out || { params: params, grads: grads, count: count, paramsPerProblem: paramsPerProblem, finalLoss: 0 };
    handle.params = params; handle.grads = grads;
    handle.count = count; handle.paramsPerProblem = paramsPerProblem;
    const adam = useAdam ? (options.adamState || createAdamStateSOA(total)) : null;
    const tape = Tape.acquire();
    const nodes = options.paramNodes || new Array(paramsPerProblem);
    for (let p = 0; p < paramsPerProblem; p++) nodes[p] = persist(node(0));
    let lossSum = 0;
    for (let it = 0; it < iterations; it++) {
        lossSum = 0;
        let start = 0, c = 0;
        while (start < count) {
            const end = Math.min(start + cs, count);
            for (let i = start; i < end; i++) {
                const off = i * paramsPerProblem;
                tape.reset();
                for (let p = 0; p < paramsPerProblem; p++) {
                    nodes[p].value[0] = params[off + p];
                    nodes[p].zeroGrad();
                }
                const loss = lossFn(nodes, i);
                tape.backward(loss);
                lossSum += loss.value[0];
                for (let p = 0; p < paramsPerProblem; p++) grads[off + p] = nodes[p].grad[0];
                if (useAdam) {
                    _soaAdamSlice(adam, grads, params, off, paramsPerProblem, lr, options, clip);
                } else {
                    for (let p = 0; p < paramsPerProblem; p++) {
                        let g = grads[off + p];
                        if (clip > 0 && Math.abs(g) > clip) g = g > 0 ? clip : -clip;
                        params[off + p] -= lr * g;
                    }
                }
                tape.recycle();
            }
            start = end;
            if (start >= count) break;
            if (++c >= ye) { c = 0; await common.yieldToMain(); }
        }
    }
    handle.finalLoss = count > 0 ? lossSum / count : 0;
    for (let p = 0; p < paramsPerProblem; p++) ADNode.release(nodes[p]);
    Tape.release(tape);
    return handle;
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================
function acquireNode(size) { return ADNode.acquire(size); }
function releaseNode(n) { ADNode.release(n); }
function acquireTape() { return Tape.acquire(); }
function releaseTape(t) { Tape.release(t); }

class ADPool {
    static acquire(size) { return ADNode.acquire(size); }
    static release(n) { ADNode.release(n); }
    /** Pre-warm via the public API (no private-field access). */
    static warm(count) {
        const cap = count > NODE_POOL_CAP ? NODE_POOL_CAP : count;
        for (let i = 0; i < cap; i++) {
            const n = ADNode.acquire(NODE_BASE_CAP);
            ADNode.release(n);
        }
        return ADNode.pooled;
    }
    static get size() { return ADNode.pooled; }
}

class TapePool {
    static acquire() { return Tape.acquire(); }
    static release(t) { Tape.release(t); }
}

// Precision-aware numeric scratch pool (buffer-preserving release).
function _adScratchFactory() {
    const T = getArrayType();
    return { v3: new T(3), v4: new T(4), g3: new T(3), g4: new T(4), m3: new T(9) };
}
function _adScratchReset(s) { /* buffers retained for Zero-GC reuse */ }
const _adScratchPool = common.createPool(_adScratchFactory, 16, _adScratchReset);
for (let _pw = 0; _pw < 16; _pw++) {
    const _s = _adScratchPool.acquire() || _adScratchFactory();
    _adScratchPool.release(_s);
}
function acquireADScratch() { return _adScratchPool.acquire() || _adScratchFactory(); }
function releaseADScratch(s) { if (s) _adScratchPool.release(s); }
function createADScratchPool(capacity) {
    return common.createPool(_adScratchFactory, capacity || 16, _adScratchReset);
}

// ============================================================================
// Class Declarations — Batch state
// ============================================================================
/**
 * One tape plus a persistent parameter vector. `run(lossFn, lr)` performs a
 * full forward/backward/step cycle and returns the loss. Gradients are read
 * from the actual parameter nodes (the previous version indexed the last
 * graph node by parameter id, which was meaningless).
 */
class ADBatchState {
    constructor(paramCount, options) {
        options = options || {};
        this.paramCount = paramCount;
        const T = getArrayType();
        this.paramBuffer = new T(paramCount);
        this.gradBuffer = new T(paramCount);
        this.tape = Tape.acquire();
        this.paramNodes = new Array(paramCount);
        for (let i = 0; i < paramCount; i++) {
            this.paramNodes[i] = persist(node(0));
        }
        this.adamState = options.optimizer === "adam" ? createAdamStateSOA(paramCount) : null;
        this.loss = 0;
    }
    /** lossFn(paramNodes, tape) → scalar ADNode. */
    run(lossFn, lr) {
        const n = this.paramCount;
        const nodes = this.paramNodes;
        for (let i = 0; i < n; i++) {
            nodes[i].value[0] = this.paramBuffer[i];
            nodes[i].zeroGrad();
        }
        this.tape.reset();
        const loss = lossFn(nodes, this.tape);
        this.tape.backward(loss);
        this.loss = loss.value[0];
        for (let i = 0; i < n; i++) this.gradBuffer[i] = nodes[i].grad[0];
        if (lr !== undefined) {
            if (this.adamState !== null) {
                soaAdamStep(this.paramBuffer, this.gradBuffer, this.adamState, n, lr);
            } else {
                soaSGDStep(this.paramBuffer, this.gradBuffer, n, lr, 0);
            }
            for (let i = 0; i < n; i++) nodes[i].value[0] = this.paramBuffer[i];
        }
        this.tape.recycle();
        return this.loss;
    }
    reset() {
        this.paramBuffer.fill(0);
        this.gradBuffer.fill(0);
        if (this.adamState !== null) {
            this.adamState.m.fill(0); this.adamState.v.fill(0); this.adamState.t = 0;
        }
        return this;
    }
    dispose() {
        for (let i = 0; i < this.paramCount; i++) ADNode.release(this.paramNodes[i]);
        this.paramNodes.length = 0;
        Tape.release(this.tape);
        this.tape = null;
    }
}

function createADBatch(paramCount, options) { return new ADBatchState(paramCount, options); }

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    core: {
        ADNode, Tape, node, scalar, vector, vec3AD, vec4AD, quatAD,
        requiresGrad, detach, constant, variable, constVec3, persist,
        component, splitVec3, joinVec3, vec3FromVec4,
        backward, zeroGrad, zeroGradAll
    },
    ops: {
        add, sub, mul, div, neg, inv, abs,
        pow: powAD, sqrt: sqrtAD, cbrt: cbrtAD,
        exp: expAD, expm1: expm1AD, log: logAD, log1p: log1pAD,
        sin: sinAD, cos: cosAD, tan: tanAD,
        asin: asinAD, acos: acosAD, atan: atanAD, atan2: atan2AD,
        sinh: sinhAD, cosh: coshAD, tanh: tanhAD,
        sigmoid: sigmoidAD, relu: reluAD, leakyRelu: leakyReluAD,
        smoothstep: smoothstepAD, saturate: saturateAD, softplus: softplusAD,
        min: minAD, max: maxAD, clamp: clampAD
    },
    reduce: {
        sum: sumAD, mean: meanAD, dot: dotAD,
        length: lengthAD, lengthSq: lengthSqAD,
        normalize3: normalize3AD, cross3: cross3AD
    },
    quat: {
        conjugate: quatConjugateAD, mul: quatMulAD,
        normalize: quatNormalizeAD, rotateVec3: quatRotateVec3AD
    },
    optim: {
        optimize, optimizeChunked, optimizeVec3,
        sgdStep, adamStep, createAdamState,
        gradNorm, clipGrad: clipGradNode,
        soaSGDStep, soaAdamStep, createAdamStateSOA,
        soaGradNorm, soaClipGrad
    },
    domain: {
        noiseGradient: noiseGradientAD,
        sdfFit, ikOptimize, orbitalEnergyMinimize,
        animationFit, colorMatch, morphFit
    },
    batch: {
        forward: soaForward,
        forwardChunked: soaForwardChunked,
        optimize: soaOptimize,
        optimizeChunked: soaOptimizeChunked,
        finiteDifferenceCheck: soaFiniteDifferenceCheck,
        State: ADBatchState,
        create: createADBatch
    },
    pool: {
        ADPool, TapePool,
        acquireNode, releaseNode, acquireTape, releaseTape,
        acquireADScratch, releaseADScratch, createADScratchPool
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing buffers are intentionally retained (Zero-GC); nodes acquired after
// a precision change pick up the live array type via getArrayType().
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Core classes
    ADNode, Tape,
    // Construction
    node, scalar, vector, vec3AD, vec4AD, quatAD,
    requiresGrad, detach, constant, variable, constVec3, persist,
    // Vector plumbing
    component, splitVec3, joinVec3, vec3FromVec4,
    // Arithmetic
    add, sub, mul, div, neg, inv, abs, powAD, sqrtAD, cbrtAD,
    // Transcendental
    expAD, expm1AD, logAD, log1pAD,
    sinAD, cosAD, tanAD, asinAD, acosAD, atanAD, atan2AD,
    sinhAD, coshAD, tanhAD,
    // Activations
    sigmoidAD, reluAD, leakyReluAD, smoothstepAD, saturateAD, softplusAD,
    // Reductions
    sumAD, meanAD, dotAD, lengthAD, lengthSqAD, normalize3AD, cross3AD,
    // Comparison
    minAD, maxAD, clampAD,
    // Quaternion AD
    quatConjugateAD, quatMulAD, quatNormalizeAD, quatRotateVec3AD,
    // Backward / zero
    backward, zeroGrad, zeroGradAll,
    // Optimizers
    optimize, optimizeChunked, optimizeVec3,
    sgdStep, adamStep, createAdamState, gradNorm, clipGradNode,
    createAdamStateSOA, soaSGDStep, soaAdamStep, soaGradNorm, soaClipGrad,
    // Domain helpers
    noiseGradientAD, sdfFit, ikOptimize, orbitalEnergyMinimize,
    animationFit, colorMatch, morphFit,
    // SOA
    soaForward, soaForwardChunked, soaOptimize, soaOptimizeChunked,
    soaFiniteDifferenceCheck,
    // Pools
    acquireNode, releaseNode, acquireTape, releaseTape,
    ADPool, TapePool, acquireADScratch, releaseADScratch, createADScratchPool,
    // Batch state
    ADBatchState, createADBatch,
    // Namespaces
    namespace
};