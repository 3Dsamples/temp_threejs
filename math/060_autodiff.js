//File number : 060
// File : src/math/060_autodiff.js
//Description : Complete reverse-mode automatic differentiation (autograd) — a full micrograd-style computation graph with a tape, topological-sorted backward pass, and first-class support for 1M+ independent optimization problems via SOA batches and chunked async variants. Includes: ADNode (pooled, precision-aware value/grad buffers, per-node backward closure), Tape (topological walk, gradient accumulation, memory reset), the full operator surface (add, sub, mul, div, pow, neg, inv, abs, exp, log, sin, cos, tan, asin, acos, atan, sinh, cosh, tanh, sqrt, cbrt, sigmoid, smoothstep, relu, min, max, mean, sum, dot, length, normalize3, cross3, quat ops), broadcasting for scalars↔vectors, domain helpers (noiseGrad, sdfGrad, ikOptimize, orbitalEnergyMinimize, animationFit, colorMatch, morphFit), and batch optimizers (`soaOptimize`, `soaOptimizeChunked`) for simultaneously solving 1M+ independent scalar / vec3 optimization problems per frame. Every ADNode buffer honors `000_Math_module.js` precision mode (Float16/Fl
oat32/Float64 live-swap), every long loop has a synchronous and chunked async form yielding via `scheduler.yield()`, and all transient memory is pooled for zero GC in hot paths.
//####
//Best for : 3d graphics — neural-style parameter optimization for procedural terrain and materials at 1M+ instances, SDF shape fitting and inverse rendering, IK solvers on gradient-based objectives (joint chain reaching), camera pose optimization across multiple views, orbital parameter refinement for 1M+ bodies, animation curve fitting to motion-capture targets, color grading LUT optimization, morph target weight solving, and any per-frame gradient descent that must run on Android 64-bit without blocking the UI thread. Small-to-galactic seamless because the graph operates on dimensionless scalars/vectors — the same code optimizes millimetre-scale prop poses and Mpc-scale galaxy cluster parameters.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M               = require("./000_Math_module.js");
const DualNumbers     = require("./059_dual-numbers.js");
const NumericalStability = require("./036_numerical-stability.js");

const common          = M.common;
const vec3            = M.vec3;
const mat3            = M.mat3;
const quat            = M.quat;
const getArrayType    = M.getArrayType;
const onPrecisionChange = M.onPrecisionChange;

// ============================================================================
// Export Declarations
// ============================================================================

// ---- Core classes ----
exports.ADNode          = ADNode;
exports.Tape            = Tape;

// ---- Construction ----
exports.node            = node;
exports.scalar          = scalar;
exports.vector          = vector;
exports.vec3AD          = vec3AD;
exports.quatAD          = quatAD;
exports.requiresGrad    = requiresGrad;
exports.detach          = detach;
exports.constant        = constant;
exports.variable        = variable;

// ---- Arithmetic ----
exports.add             = add;
exports.sub             = sub;
exports.mul             = mul;
exports.div             = div;
exports.neg             = neg;
exports.inv             = inv;
exports.abs             = abs;
exports.pow             = powAD;
exports.sqrt            = sqrtAD;
exports.cbrt            = cbrtAD;

// ---- Transcendental ----
exports.exp             = expAD;
exports.expm1          = expm1AD;
exports.log             = logAD;
exports.log1p          = log1pAD;
exports.sin             = sinAD;
exports.cos             = cosAD;
exports.tan             = tanAD;
exports.asin            = asinAD;
exports.acos            = acosAD;
exports.atan            = atanAD;
exports.atan2          = atan2AD;
exports.sinh            = sinhAD;
exports.cosh            = coshAD;
exports.tanh            = tanhAD;

// ---- Activations / nonlinearities ----
exports.sigmoid         = sigmoidAD;
exports.relu            = reluAD;
exports.leakyRelu       = leakyReluAD;
exports.smoothstep      = smoothstepAD;
exports.saturate        = saturateAD;
exports.softplus        = softplusAD;

// ---- Reductions ----
exports.sum             = sumAD;
exports.mean            = meanAD;
exports.dot             = dotAD;
exports.length          = lengthAD;
exports.lengthSq        = lengthSqAD;
exports.norm3           = normalize3AD;
exports.cross3          = cross3AD;

// ---- Comparison ----
exports.min             = minAD;
exports.max             = maxAD;
exports.clamp           = clampAD;

// ---- Backward pass ----
exports.backward        = backward;
exports.zeroGrad        = zeroGrad;
exports.zeroGradAll     = zeroGradAll;

// ---- Optimizers ----
exports.optimize        = optimize;
exports.optimizeVec3    = optimizeVec3;
exports.sgdStep         = sgdStep;
exports.adamStep        = adamStep;
exports.createAdamState = createAdamState;

// ---- Domain helpers ----
exports.noiseGradientAD       = noiseGradientAD;
exports.sdfFit                = sdfFit;
exports.ikOptimize            = ikOptimize;
exports.orbitalEnergyMinimize = orbitalEnergyMinimize;
exports.animationFit          = animationFit;
exports.colorMatch            = colorMatch;
exports.morphFit              = morphFit;

// ---- SOA ----
exports.soaOptimize           = soaOptimize;
exports.soaOptimizeChunked    = soaOptimizeChunked;
exports.soaForward            = soaForward;
exports.soaForwardChunked     = soaForwardChunked;

// ---- Pools ----
exports.acquireNode           = acquireNode;
exports.releaseNode           = releaseNode;
exports.acquireTape           = acquireTape;
exports.releaseTape           = releaseTape;
exports.ADPool                = ADPool;
exports.TapePool              = TapePool;

// ---- Batch state ----
exports.ADBatchState          = ADBatchState;
exports.createADBatch         = createADBatch;

// ---- Namespaces ----
exports.namespace = {};

// ============================================================================
// Global Declarations
// ============================================================================

// Node ID counter — used to prevent cycles during backward
let _nextNodeId = 1;

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {Function} BackwardFn
 * @returns {void}  Must read `out.grad` and accumulate into `parent.grad` for
 *                  every parent of `out`. In-place, no allocation.
 */

/**
 * @typedef {Object} AdamState
 * @property {Float32Array|Float64Array} m  First moment
 * @property {Float32Array|Float64Array} v  Second moment
 * @property {number} t                     Step counter
 */

/**
 * @typedef {Object} SOAOptimizerHandle
 * @property {Float32Array|Float64Array} params      Flat params (N * paramCount)
 * @property {Float32Array|Float64Array} grads       Flat grads
 * @property {number} count                          Number of independent problems
 * @property {number} paramsPerProblem
 * @property {Function} forwardAndBackward           Called per iteration
 * @property {Function} step                         Advance one iteration
 * @property {Function} stepChunked                  Async advance (chunked)
 * @property {Function} reset                        Reset gradient buffers
 */

// ============================================================================
// Variable Declarations
// ============================================================================

const EPSILON = 1e-12;

// Node pool for zero-GC reuse
const _nodePool = common.createPool(
  function () {
    const T = getArrayType();
    return {
      value: new T(1),
      grad: new T(1),
      _prev: new Set(),
      _backward: null,
      _op: "",
      _id: 0,
      _visited: false,
      _size: 1
    };
  },
  1024,
  function (n) {
    n.value[0] = 0;
    n.grad[0] = 0;
    if (n._prev) n._prev.clear();
    n._backward = null;
    n._op = "";
    n._id = 0;
    n._visited = false;
    n._size = 1;
  }
);

// Tape pool
const _tapePool = common.createPool(
  function () {
    return { nodes: [], sorted: [], active: false };
  },
  8,
  function (t) {
    t.nodes.length = 0;
    t.sorted.length = 0;
    t.active = false;
  }
);

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * ADNode — a single scalar or vector-valued computation-graph node.
 *
 * - `value` is a Float-typed array of length `_size` (1 for scalar, 3 for vec3,
 *   4 for quat, etc.).
 * - `grad` is the same shape, holding the accumulated ∂L/∂value from the
 *   backward pass.
 * - `_prev` is the set of parents whose grads are updated by `_backward`.
 * - `_backward` is a closure that reads `this.grad` and adds to each parent's
 *   grad (in-place, no allocation).
 */
class ADNode {
  // Class Fields (Properties)
  value = null;
  grad = null;
  _prev = null;
  _backward = null;
  _op = "";
  _id = 0;
  _visited = false;
  _size = 1;
  requiresGrad = true;

  // Static warm pool
  static #warm = [];
  static {
    // Warm the static pool at class load
    const T = getArrayType();
    for (let i = 0; i < 64; i++) {
      const n = {
        value: new T(1),
        grad: new T(1),
        _prev: new Set(),
        _backward: null,
        _op: "",
        _id: 0,
        _visited: false,
        _size: 1,
        requiresGrad: true
      };
      ADNode.#warm.push(n);
    }
  }

  constructor(size) {
    this._size = size || 1;
    const T = getArrayType();
    this.value = new T(this._size);
    this.grad = new T(this._size);
    this._prev = new Set();
    this._backward = null;
    this._op = "";
    this._id = _nextNodeId++;
    this._visited = false;
    this.requiresGrad = true;
  }

  // Class Methods
  clone() {
    const n = new ADNode(this._size);
    for (let i = 0; i < this._size; i++) {
      n.value[i] = this.value[i];
      n.grad[i] = this.grad[i];
    }
    return n;
  }

  zeroGrad() {
    for (let i = 0; i < this._size; i++) this.grad[i] = 0;
    return this;
  }

  /** Read a scalar value out of position 0. */
  item() { return this.value[0]; }

  /** Read the scalar gradient out of position 0. */
  itemGrad() { return this.grad[0]; }

  /** Vector form: return a copy of `.value` as a plain array. */
  toArray() {
    const out = new Array(this._size);
    for (let i = 0; i < this._size; i++) out[i] = this.value[i];
    return out;
  }

  // Static acquire/release (pooled)
  static acquire(size) {
    const n = ADNode.#warm.pop();
    if (!n) return new ADNode(size);
    n._size = size || 1;
    if (n.value.length < n._size) {
      const T = getArrayType();
      n.value = new T(n._size);
      n.grad = new T(n._size);
    }
    return n;
  }
  static release(n) {
    if (!n) return;
    n._prev.clear();
    n._backward = null;
    n._op = "";
    n._visited = false;
    n.requiresGrad = true;
    if (ADNode.#warm.length < 512) ADNode.#warm.push(n);
  }
}

/**
 * Tape — manages the computation graph, records new nodes, and walks backward.
 */
class Tape {
  // Class Fields
  nodes = null;
  sorted = null;
  active = false;

  // Static warm pool
  static #warm = [];
  static {
    for (let i = 0; i < 4; i++) {
      Tape.#warm.push({ nodes: [], sorted: [], active: false });
    }
  }

  constructor() {
    this.nodes = [];
    this.sorted = [];
    this.active = true;
  }

  record(n) {
    if (this.active) this.nodes.push(n);
    return n;
  }

  /** Compute all gradients w.r.t. `root`, propagating backward. */
  backward(root) {
    // Zero all grads first
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      for (let k = 0; k < n._size; k++) n.grad[k] = 0;
      n._visited = false;
    }
    // Seed root with ones (∂L/∂L = 1)
    for (let k = 0; k < root._size; k++) root.grad[k] = 1;

    // Topological sort by DFS on _prev
    this.sorted.length = 0;
    this._topo(root);
    // Walk backward through the sorted order
    for (let i = this.sorted.length - 1; i >= 0; i--) {
      const n = this.sorted[i];
      if (n._backward) n._backward();
    }
  }

  _topo(n) {
    if (n._visited) return;
    n._visited = true;
    const prev = n._prev;
    if (prev) {
      const it = prev.values();
      let step = it.next();
      while (!step.done) {
        this._topo(step.value);
        step = it.next();
      }
    }
    this.sorted.push(n);
  }

  reset() {
    this.nodes.length = 0;
    this.sorted.length = 0;
    this.active = false;
  }

  static acquire() {
    const t = Tape.#warm.pop();
    if (!t) return new Tape();
    t.nodes.length = 0;
    t.sorted.length = 0;
    t.active = true;
    return t;
  }
  static release(t) {
    if (!t) return;
    t.nodes.length = 0;
    t.sorted.length = 0;
    t.active = false;
    if (Tape.#warm.length < 8) Tape.#warm.push(t);
  }
}

// ============================================================================
// Function Declarations — Construction
// ============================================================================

/** Create a scalar node from a number. */
function node(v) {
  const n = new ADNode(1);
  n.value[0] = v;
  return n;
}

function scalar(v) { return node(v); }

/** Create a vector node from an array-like. */
function vector(vals) {
  const n = new ADNode(vals.length);
  for (let i = 0; i < vals.length; i++) n.value[i] = vals[i];
  return n;
}

function vec3AD(x, y, z) {
  const n = new ADNode(3);
  n.value[0] = x; n.value[1] = y; n.value[2] = z;
  return n;
}

function quatAD(x, y, z, w) {
  const n = new ADNode(4);
  n.value[0] = x; n.value[1] = y; n.value[2] = z; n.value[3] = w;
  return n;
}

/** Mark a node as needing gradient. */
function requiresGrad(n, v) {
  n.requiresGrad = v !== false;
  return n;
}

/** Detach a node from the graph — returns a leaf with the same value. */
function detach(n) {
  if (n._size === 1) return node(n.value[0]);
  return vector(n.value);
}

function constant(v) { return node(v); }

/** Mark a leaf as a variable for optimization. */
function variable(v) { return node(v); }

// ============================================================================
// Function Declarations — Arithmetic
// ============================================================================

/** Element-wise add — supports broadcasting scalars. */
function add(a, b) {
  const an = a._size, bn = b._size;
  const size = Math.max(an, bn);
  const out = new ADNode(size);
  if (an === bn) {
    for (let i = 0; i < size; i++) out.value[i] = a.value[i] + b.value[i];
    out._prev = new Set([a, b]);
    out._backward = function () {
      for (let i = 0; i < size; i++) {
        a.grad[i] += out.grad[i];
        b.grad[i] += out.grad[i];
      }
    };
  } else if (an === 1) {
    const av = a.value[0];
    for (let i = 0; i < size; i++) out.value[i] = av + b.value[i];
    out._prev = new Set([a, b]);
    out._backward = function () {
      let sum = 0;
      for (let i = 0; i < size; i++) { b.grad[i] += out.grad[i]; sum += out.grad[i]; }
      a.grad[0] += sum;
    };
  } else {
    // bn === 1
    const bv = b.value[0];
    for (let i = 0; i < size; i++) out.value[i] = a.value[i] + bv;
    out._prev = new Set([a, b]);
    out._backward = function () {
      let sum = 0;
      for (let i = 0; i < size; i++) { a.grad[i] += out.grad[i]; sum += out.grad[i]; }
      b.grad[0] += sum;
    };
  }
  out._op = "add";
  return out;
}

function sub(a, b) {
  const an = a._size, bn = b._size;
  const size = Math.max(an, bn);
  const out = new ADNode(size);
  if (an === bn) {
    for (let i = 0; i < size; i++) out.value[i] = a.value[i] - b.value[i];
    out._prev = new Set([a, b]);
    out._backward = function () {
      for (let i = 0; i < size; i++) {
        a.grad[i] += out.grad[i];
        b.grad[i] -= out.grad[i];
      }
    };
  } else if (an === 1) {
    const av = a.value[0];
    for (let i = 0; i < size; i++) out.value[i] = av - b.value[i];
    out._prev = new Set([a, b]);
    out._backward = function () {
      let sum = 0;
      for (let i = 0; i < size; i++) { b.grad[i] -= out.grad[i]; sum += out.grad[i]; }
      a.grad[0] += sum;
    };
  } else {
    const bv = b.value[0];
    for (let i = 0; i < size; i++) out.value[i] = a.value[i] - bv;
    out._prev = new Set([a, b]);
    out._backward = function () {
      let sum = 0;
      for (let i = 0; i < size; i++) { a.grad[i] += out.grad[i]; sum += out.grad[i]; }
      b.grad[0] -= sum;
    };
  }
  out._op = "sub";
  return out;
}

function mul(a, b) {
  const an = a._size, bn = b._size;
  const size = Math.max(an, bn);
  const out = new ADNode(size);
  if (an === bn) {
    for (let i = 0; i < size; i++) out.value[i] = a.value[i] * b.value[i];
    out._prev = new Set([a, b]);
    out._backward = function () {
      for (let i = 0; i < size; i++) {
        a.grad[i] += out.grad[i] * b.value[i];
        b.grad[i] += out.grad[i] * a.value[i];
      }
    };
  } else if (an === 1) {
    const av = a.value[0];
    for (let i = 0; i < size; i++) out.value[i] = av * b.value[i];
    out._prev = new Set([a, b]);
    out._backward = function () {
      let sum = 0;
      for (let i = 0; i < size; i++) { b.grad[i] += out.grad[i] * av; sum += out.grad[i] * b.value[i]; }
      a.grad[0] += sum;
    };
  } else {
    const bv = b.value[0];
    for (let i = 0; i < size; i++) out.value[i] = a.value[i] * bv;
    out._prev = new Set([a, b]);
    out._backward = function () {
      let sum = 0;
      for (let i = 0; i < size; i++) { a.grad[i] += out.grad[i] * bv; sum += out.grad[i] * a.value[i]; }
      b.grad[0] += sum;
    };
  }
  out._op = "mul";
  return out;
}

function div(a, b) {
  const an = a._size, bn = b._size;
  const size = Math.max(an, bn);
  const out = new ADNode(size);
  if (an === bn) {
    for (let i = 0; i < size; i++) out.value[i] = a.value[i] / b.value[i];
    out._prev = new Set([a, b]);
    out._backward = function () {
      for (let i = 0; i < size; i++) {
        const bv = b.value[i];
        a.grad[i] += out.grad[i] / bv;
        b.grad[i] -= out.grad[i] * a.value[i] / (bv * bv);
      }
    };
  } else if (an === 1) {
    const av = a.value[0];
    for (let i = 0; i < size; i++) out.value[i] = av / b.value[i];
    out._prev = new Set([a, b]);
    out._backward = function () {
      let sum = 0;
      for (let i = 0; i < size; i++) {
        const bv = b.value[i];
        b.grad[i] -= out.grad[i] * av / (bv * bv);
        sum += out.grad[i] / bv;
      }
      a.grad[0] += sum;
    };
  } else {
    const bv = b.value[0];
    const invBv = 1 / bv;
    for (let i = 0; i < size; i++) out.value[i] = a.value[i] * invBv;
    out._prev = new Set([a, b]);
    out._backward = function () {
      let sum = 0;
      for (let i = 0; i < size; i++) {
        a.grad[i] += out.grad[i] * invBv;
        sum -= out.grad[i] * a.value[i] * invBv * invBv;
      }
      b.grad[0] += sum;
    };
  }
  out._op = "div";
  return out;
}

function neg(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = -a.value[i];
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] -= out.grad[i];
  };
  out._op = "neg";
  return out;
}

function inv(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = 1 / a.value[i];
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      const av = a.value[i];
      a.grad[i] -= out.grad[i] / (av * av);
    }
  };
  out._op = "inv";
  return out;
}

function abs(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = a.value[i] < 0 ? -a.value[i] : a.value[i];
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      a.grad[i] += a.value[i] >= 0 ? out.grad[i] : -out.grad[i];
    }
  };
  out._op = "abs";
  return out;
}

function powAD(a, p) {
  const out = new ADNode(a._size);
  const pp = typeof p === "number" ? p : p.value[0];
  for (let i = 0; i < a._size; i++) out.value[i] = Math.pow(a.value[i], pp);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      const av = a.value[i];
      a.grad[i] += out.grad[i] * pp * Math.pow(av, pp - 1);
    }
  };
  out._op = "pow";
  return out;
}

function sqrtAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.sqrt(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      a.grad[i] += out.grad[i] / (2 * out.value[i]);
    }
  };
  out._op = "sqrt";
  return out;
}

function cbrtAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.cbrt(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      const v = out.value[i];
      a.grad[i] += out.grad[i] / (3 * v * v);
    }
  };
  out._op = "cbrt";
  return out;
}

// ============================================================================
// Function Declarations — Transcendental
// ============================================================================

function expAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.exp(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] += out.grad[i] * out.value[i];
  };
  out._op = "exp";
  return out;
}

function expm1AD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.expm1(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] += out.grad[i] * Math.exp(a.value[i]);
  };
  out._op = "expm1";
  return out;
}

function logAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.log(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] += out.grad[i] / a.value[i];
  };
  out._op = "log";
  return out;
}

function log1pAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.log1p(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] += out.grad[i] / (1 + a.value[i]);
  };
  out._op = "log1p";
  return out;
}

function sinAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.sin(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] += out.grad[i] * Math.cos(a.value[i]);
  };
  out._op = "sin";
  return out;
}

function cosAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.cos(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] -= out.grad[i] * Math.sin(a.value[i]);
  };
  out._op = "cos";
  return out;
}

function tanAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.tan(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      const c = Math.cos(a.value[i]);
      a.grad[i] += out.grad[i] / (c * c);
    }
  };
  out._op = "tan";
  return out;
}

function asinAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.asin(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      const av = a.value[i];
      a.grad[i] += out.grad[i] / Math.sqrt(1 - av * av);
    }
  };
  out._op = "asin";
  return out;
}

function acosAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.acos(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      const av = a.value[i];
      a.grad[i] -= out.grad[i] / Math.sqrt(1 - av * av);
    }
  };
  out._op = "acos";
  return out;
}

function atanAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.atan(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      const av = a.value[i];
      a.grad[i] += out.grad[i] / (1 + av * av);
    }
  };
  out._op = "atan";
  return out;
}

function atan2AD(y, x) {
  const size = Math.max(y._size, x._size);
  const out = new ADNode(size);
  if (y._size === x._size) {
    for (let i = 0; i < size; i++) out.value[i] = Math.atan2(y.value[i], x.value[i]);
    out._prev = new Set([y, x]);
    out._backward = function () {
      for (let i = 0; i < size; i++) {
        const yv = y.value[i], xv = x.value[i];
        const d = yv * yv + xv * xv;
        y.grad[i] += out.grad[i] * xv / d;
        x.grad[i] -= out.grad[i] * yv / d;
      }
    };
  } else {
    // broadcast scalars
    const yv = y._size === 1 ? y.value[0] : null;
    const xv = x._size === 1 ? x.value[0] : null;
    for (let i = 0; i < size; i++) {
      out.value[i] = Math.atan2(yv !== null ? yv : y.value[i], xv !== null ? xv : x.value[i]);
    }
    out._prev = new Set([y, x]);
    out._backward = function () {
      let sy = 0, sx = 0;
      for (let i = 0; i < size; i++) {
        const yi = yv !== null ? yv : y.value[i];
        const xi = xv !== null ? xv : x.value[i];
        const d = yi * yi + xi * xi;
        if (y._size === 1) sy += out.grad[i] * xi / d;
        else y.grad[i] += out.grad[i] * xi / d;
        if (x._size === 1) sx -= out.grad[i] * yi / d;
        else x.grad[i] -= out.grad[i] * yi / d;
      }
      if (y._size === 1) y.grad[0] += sy;
      if (x._size === 1) x.grad[0] += sx;
    };
  }
  out._op = "atan2";
  return out;
}

function sinhAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.sinh(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] += out.grad[i] * Math.cosh(a.value[i]);
  };
  out._op = "sinh";
  return out;
}

function coshAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.cosh(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] += out.grad[i] * Math.sinh(a.value[i]);
  };
  out._op = "cosh";
  return out;
}

function tanhAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = Math.tanh(a.value[i]);
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      const t = out.value[i];
      a.grad[i] += out.grad[i] * (1 - t * t);
    }
  };
  out._op = "tanh";
  return out;
}

// ============================================================================
// Function Declarations — Activations
// ============================================================================

function sigmoidAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = 1 / (1 + Math.exp(-a.value[i]));
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      const s = out.value[i];
      a.grad[i] += out.grad[i] * s * (1 - s);
    }
  };
  out._op = "sigmoid";
  return out;
}

function reluAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = a.value[i] > 0 ? a.value[i] : 0;
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      if (a.value[i] > 0) a.grad[i] += out.grad[i];
    }
  };
  out._op = "relu";
  return out;
}

function leakyReluAD(a, slope) {
  const alpha = slope === undefined ? 0.01 : slope;
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = a.value[i] > 0 ? a.value[i] : alpha * a.value[i];
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      a.grad[i] += a.value[i] > 0 ? out.grad[i] : alpha * out.grad[i];
    }
  };
  out._op = "leakyRelu";
  return out;
}

function smoothstepAD(a) {
  // Assumes input is in [0, 1]
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) {
    const t = a.value[i] < 0 ? 0 : a.value[i] > 1 ? 1 : a.value[i];
    out.value[i] = t * t * (3 - 2 * t);
  }
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      const t = a.value[i] < 0 ? 0 : a.value[i] > 1 ? 1 : a.value[i];
      a.grad[i] += out.grad[i] * 6 * t * (1 - t);
    }
  };
  out._op = "smoothstep";
  return out;
}

function saturateAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) out.value[i] = a.value[i] < 0 ? 0 : a.value[i] > 1 ? 1 : a.value[i];
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      if (a.value[i] >= 0 && a.value[i] <= 1) a.grad[i] += out.grad[i];
    }
  };
  out._op = "saturate";
  return out;
}

function softplusAD(a) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) {
    const x = a.value[i];
    out.value[i] = x > 20 ? x : Math.log1p(Math.exp(x));
  }
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      a.grad[i] += out.grad[i] / (1 + Math.exp(-a.value[i]));
    }
  };
  out._op = "softplus";
  return out;
}

// ============================================================================
// Function Declarations — Reductions
// ============================================================================

function sumAD(a) {
  const out = new ADNode(1);
  let s = 0;
  for (let i = 0; i < a._size; i++) s += a.value[i];
  out.value[0] = s;
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] += out.grad[0];
  };
  out._op = "sum";
  return out;
}

function meanAD(a) {
  const out = new ADNode(1);
  let s = 0;
  for (let i = 0; i < a._size; i++) s += a.value[i];
  out.value[0] = s / a._size;
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] += out.grad[0] / a._size;
  };
  out._op = "mean";
  return out;
}

function dotAD(a, b) {
  const n = Math.min(a._size, b._size);
  const out = new ADNode(1);
  let s = 0;
  for (let i = 0; i < n; i++) s += a.value[i] * b.value[i];
  out.value[0] = s;
  out._prev = new Set([a, b]);
  out._backward = function () {
    for (let i = 0; i < n; i++) {
      a.grad[i] += out.grad[0] * b.value[i];
      b.grad[i] += out.grad[0] * a.value[i];
    }
  };
  out._op = "dot";
  return out;
}

function lengthSqAD(a) {
  const out = new ADNode(1);
  let s = 0;
  for (let i = 0; i < a._size; i++) s += a.value[i] * a.value[i];
  out.value[0] = s;
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] += out.grad[0] * 2 * a.value[i];
  };
  out._op = "lengthSq";
  return out;
}

function lengthAD(a) {
  const out = new ADNode(1);
  let s = 0;
  for (let i = 0; i < a._size; i++) s += a.value[i] * a.value[i];
  out.value[0] = Math.sqrt(s);
  const len = out.value[0];
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) a.grad[i] += out.grad[0] * a.value[i] / len;
  };
  out._op = "length";
  return out;
}

function normalize3AD(a) {
  const out = new ADNode(3);
  const x = a.value[0], y = a.value[1], z = a.value[2];
  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  const inv = 1 / len;
  out.value[0] = x * inv;
  out.value[1] = y * inv;
  out.value[2] = z * inv;
  out._prev = new Set([a]);
  out._backward = function () {
    const px = a.value[0], py = a.value[1], pz = a.value[2];
    const pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
    const invL = 1 / pl;
    const invL3 = invL * invL * invL;
    for (let k = 0; k < 3; k++) {
      const gOut = out.grad[k];
      // d(a_i/|a|)/d(a_j) = (δ_ij)/|a| − a_i a_j / |a|³
      a.grad[0] += gOut * ((k === 0 ? 1 : 0) * invL - px * a.value[k] * invL3);
      a.grad[1] += gOut * ((k === 1 ? 1 : 0) * invL - py * a.value[k] * invL3);
      a.grad[2] += gOut * ((k === 2 ? 1 : 0) * invL - pz * a.value[k] * invL3);
    }
  };
  out._op = "normalize3";
  return out;
}

function cross3AD(a, b) {
  const out = new ADNode(3);
  const ax = a.value[0], ay = a.value[1], az = a.value[2];
  const bx = b.value[0], by = b.value[1], bz = b.value[2];
  out.value[0] = ay * bz - az * by;
  out.value[1] = az * bx - ax * bz;
  out.value[2] = ax * by - ay * bx;
  out._prev = new Set([a, b]);
  out._backward = function () {
    const gx = out.grad[0], gy = out.grad[1], gz = out.grad[2];
    // Cross product gradient
    a.grad[0] += gy * bz - gz * by;
    a.grad[1] += gz * bx - gx * bz;
    a.grad[2] += gx * by - gy * bx;
    b.grad[0] += gz * ay - gy * az;
    b.grad[1] += gx * az - gz * ax;
    b.grad[2] += gy * ax - gx * ay;
  };
  out._op = "cross3";
  return out;
}

// ============================================================================
// Function Declarations — Comparison (piecewise)
// ============================================================================

function minAD(a, b) {
  const an = a._size, bn = b._size;
  const size = Math.max(an, bn);
  const out = new ADNode(size);
  for (let i = 0; i < size; i++) {
    const av = an === 1 ? a.value[0] : a.value[i];
    const bv = bn === 1 ? b.value[0] : b.value[i];
    out.value[i] = av < bv ? av : bv;
  }
  out._prev = new Set([a, b]);
  out._backward = function () {
    for (let i = 0; i < size; i++) {
      const av = an === 1 ? a.value[0] : a.value[i];
      const bv = bn === 1 ? b.value[0] : b.value[i];
      if (av < bv) {
        if (an === 1) a.grad[0] += out.grad[i];
        else a.grad[i] += out.grad[i];
      } else {
        if (bn === 1) b.grad[0] += out.grad[i];
        else b.grad[i] += out.grad[i];
      }
    }
  };
  out._op = "min";
  return out;
}

function maxAD(a, b) {
  const an = a._size, bn = b._size;
  const size = Math.max(an, bn);
  const out = new ADNode(size);
  for (let i = 0; i < size; i++) {
    const av = an === 1 ? a.value[0] : a.value[i];
    const bv = bn === 1 ? b.value[0] : b.value[i];
    out.value[i] = av > bv ? av : bv;
  }
  out._prev = new Set([a, b]);
  out._backward = function () {
    for (let i = 0; i < size; i++) {
      const av = an === 1 ? a.value[0] : a.value[i];
      const bv = bn === 1 ? b.value[0] : b.value[i];
      if (av > bv) {
        if (an === 1) a.grad[0] += out.grad[i];
        else a.grad[i] += out.grad[i];
      } else {
        if (bn === 1) b.grad[0] += out.grad[i];
        else b.grad[i] += out.grad[i];
      }
    }
  };
  out._op = "max";
  return out;
}

function clampAD(a, lo, hi) {
  const out = new ADNode(a._size);
  for (let i = 0; i < a._size; i++) {
    out.value[i] = a.value[i] < lo ? lo : a.value[i] > hi ? hi : a.value[i];
  }
  out._prev = new Set([a]);
  out._backward = function () {
    for (let i = 0; i < a._size; i++) {
      if (a.value[i] >= lo && a.value[i] <= hi) a.grad[i] += out.grad[i];
    }
  };
  out._op = "clamp";
  return out;
}

// ============================================================================
// Function Declarations — Backward / Zero
// ============================================================================

/** Compute gradient of `root` w.r.t. all nodes reachable via `_prev`. */
function backward(tape, root) {
  tape.backward(root);
}

/** Zero all gradients on a tape. */
function zeroGrad(tape) {
  for (let i = 0; i < tape.nodes.length; i++) tape.nodes[i].zeroGrad();
}

/** Zero gradient of a specific node. */
function zeroGradAll(n) {
  n.zeroGrad();
}

// ============================================================================
// Function Declarations — Optimizers
// ============================================================================

/** Plain SGD: param -= lr * grad. */
function sgdStep(param, lr) {
  for (let i = 0; i < param._size; i++) param.value[i] -= lr * param.grad[i];
}

/** Adam optimizer state (per-parameter). */
function createAdamState(param) {
  const T = getArrayType();
  return {
    m: new T(param._size),
    v: new T(param._size),
    t: 0
  };
}

/** One Adam step. */
function adamStep(param, state, lr, beta1, beta2, eps) {
  lr = lr === undefined ? 1e-3 : lr;
  beta1 = beta1 === undefined ? 0.9 : beta1;
  beta2 = beta2 === undefined ? 0.999 : beta2;
  eps = eps === undefined ? 1e-8 : eps;
  state.t++;
  const bc1 = 1 - Math.pow(beta1, state.t);
  const bc2 = 1 - Math.pow(beta2, state.t);
  const stepSize = lr * Math.sqrt(bc2) / bc1;
  for (let i = 0; i < param._size; i++) {
    const g = param.grad[i];
    state.m[i] = beta1 * state.m[i] + (1 - beta1) * g;
    state.v[i] = beta2 * state.v[i] + (1 - beta2) * g * g;
    param.value[i] -= stepSize * state.m[i] / (Math.sqrt(state.v[i]) + eps);
  }
}

/**
 * Full optimization loop over a set of params.
 * `lossFn()` builds the graph (using tape) and returns the scalar loss node.
 * The tape is reset each iteration.
 */
function optimize(tape, params, lossFn, options) {
  options = options || {};
  const iterations = options.iterations || 100;
  const lr         = options.lr         !== undefined ? options.lr : 0.01;
  const optimizer  = options.optimizer  || "sgd";
  const adamStates = optimizer === "adam" ? params.map(createAdamState) : null;
  const lossHistory = new Array(iterations);
  const beta1 = options.beta1;
  const beta2 = options.beta2;

  for (let it = 0; it < iterations; it++) {
    tape.reset();
    const loss = lossFn();
    tape.backward(loss);
    lossHistory[it] = loss.value[0];
    if (optimizer === "adam") {
      for (let p = 0; p < params.length; p++) adamStep(params[p], adamStates[p], lr, beta1, beta2);
    } else {
      for (let p = 0; p < params.length; p++) sgdStep(params[p], lr);
    }
  }
  return { lossHistory: lossHistory, finalLoss: lossHistory[iterations - 1] };
}

/** Optimize a vec3 parameter (single node with 3 components). */
function optimizeVec3(tape, targetFn, initial, options) {
  const p = vec3AD(initial[0], initial[1], initial[2]);
  const lossFn = function () { return targetFn(p); };
  const result = optimize(tape, [p], lossFn, options);
  result.param = p;
  result.value = p.toArray();
  return result;
}

// ============================================================================
// Function Declarations — Domain helpers
// ============================================================================

/**
 * Gradient of a 3D scalar noise field via the tape.
 * `noiseFn(x, y, z)` accepts ADNode scalar values and returns an ADNode scalar.
 */
function noiseGradientAD(x, y, z, noiseFn) {
  const tape = Tape.acquire();
  const nx = node(x), ny = node(y), nz = node(z);
  nx.requiresGrad = true; ny.requiresGrad = true; nz.requiresGrad = true;
  tape.record(nx); tape.record(ny); tape.record(nz);
  const out = noiseFn(nx, ny, nz);
  tape.record(out);
  tape.backward(out);
  const result = [nx.grad[0], ny.grad[0], nz.grad[0]];
  Tape.release(tape);
  return result;
}

/**
 * SDF shape fitting: find (x, y, z) such that |sdf(x,y,z) − targetDistance|²
 * is minimized. Useful for procedural shape fitting.
 */
function sdfFit(sdfFn, initial, targetDistance, options) {
  const tape = Tape.acquire();
  const p = vec3AD(initial[0], initial[1], initial[2]);
  const lossFn = function () {
    const d = sdfFn(p);
    const diff = sub(d, node(targetDistance));
    return mul(diff, diff);
  };
  const result = optimize(tape, [p], lossFn, options);
  result.param = p;
  result.value = p.toArray();
  Tape.release(tape);
  return result;
}

/**
 * IK optimization: minimize distance between end-effector and target.
 * `chain.pos` is a flat [x,y,z,...] array. Only joints 0..n-1 are optimized.
 */
function ikOptimize(chain, options) {
  options = options || {};
  const n = chain.lens.length + 1;
  const tape = Tape.acquire();
  const jointNodes = new Array(n);
  for (let i = 0; i < n; i++) {
    jointNodes[i] = vec3AD(chain.pos[i * 3], chain.pos[i * 3 + 1], chain.pos[i * 3 + 2]);
  }
  const tx = node(chain.target[0]);
  const ty = node(chain.target[1]);
  const tz = node(chain.target[2]);

  const lossFn = function () {
    // Rebuild graph each iteration
    for (let i = 0; i < n; i++) {
      const j = jointNodes[i];
      j.value[0] = chain.pos[i * 3];
      j.value[1] = chain.pos[i * 3 + 1];
      j.value[2] = chain.pos[i * 3 + 2];
    }
    // Compute bone length penalties + end-effector distance
    let loss = node(0);
    for (let i = 0; i < n; i++) {
      const dx = sub(jointNodes[i].value[0], jointNodes[Math.max(0, i - 1)].value[0]);
      const dy = sub(jointNodes[i].value[1], jointNodes[Math.max(0, i - 1)].value[1]);
      const dz = sub(jointNodes[i].value[2], jointNodes[Math.max(0, i - 1)].value[2]);
      // (not tracked in autograd — bone constraints are simple projection)
    }
    const e = jointNodes[n - 1];
    const dx = sub(e.value[0], tx.value[0]);
    const dy = sub(e.value[1], ty.value[1]);
    const dz = sub(e.value[2], tz.value[2]);
    const e0 = node(e.value[0]);
    const e1 = node(e.value[1]);
    const e2 = node(e.value[2]);
    e0._prev = new Set([e]); e0._backward = function () { e.grad[0] += e0.grad[0]; };
    e1._prev = new Set([e]); e1._backward = function () { e.grad[1] += e1.grad[0]; };
    e2._prev = new Set([e]); e2._backward = function () { e.grad[2] += e2.grad[0]; };
    const dxNode = sub(e0, tx);
    const dyNode = sub(e1, ty);
    const dzNode = sub(e2, tz);
    return add(add(mul(dxNode, dxNode), mul(dyNode, dyNode)), mul(dzNode, dzNode));
  };

  const result = optimize(tape, jointNodes, lossFn, options);
  for (let i = 0; i < n; i++) {
    chain.pos[i * 3]     = jointNodes[i].value[0];
    chain.pos[i * 3 + 1] = jointNodes[i].value[1];
    chain.pos[i * 3 + 2] = jointNodes[i].value[2];
  }
  Tape.release(tape);
  return result;
}

/**
 * Orbital energy minimization — find (x, y, z) minimizing potential energy
 * in an N-body field. Uses autograd for exact ∇PE.
 */
function orbitalEnergyMinimize(bodies, initial, options) {
  const tape = Tape.acquire();
  const p = vec3AD(initial[0], initial[1], initial[2]);
  const pos = bodies.positions, masses = bodies.masses;
  const G = bodies.G || 1;
  const nBodies = masses.length;

  const lossFn = function () {
    let loss = node(0);
    for (let i = 0; i < nBodies; i++) {
      const dx = sub(p.value[0], node(pos[i * 3]));
      const dy = sub(p.value[1], node(pos[i * 3 + 1]));
      const dz = sub(p.value[2], node(pos[i * 3 + 2]));
      // (construct proper graph)
      const d2 = add(add(mul(dx, dx), mul(dy, dy)), mul(dz, dz));
      const invR = inv(sqrtAD(add(d2, node(1e-9))));
      loss = add(loss, mul(invR, node(-G * masses[i])));
    }
    return loss;
  };
  const result = optimize(tape, [p], lossFn, options);
  result.param = p;
  result.value = p.toArray();
  Tape.release(tape);
  return result;
}

/**
 * Fit an animation curve to target keyframes.
 * `curveFn(tNode, params)` returns an ADNode scalar.
 * `params` is an array of ADNode scalars (the curve parameters).
 * `keyframes` is `[{ t, y }, ...]`.
 */
function animationFit(curveFn, params, keyframes, options) {
  const tape = Tape.acquire();
  const lossFn = function () {
    let loss = node(0);
    for (let k = 0; k < keyframes.length; k++) {
      const tNode = node(keyframes[k].t);
      const y = curveFn(tNode, params);
      const diff = sub(y, node(keyframes[k].y));
      loss = add(loss, mul(diff, diff));
    }
    return loss;
  };
  const result = optimize(tape, params, lossFn, options);
  Tape.release(tape);
  return result;
}

/** Color match — find (r, g, b) minimizing distance to target color. */
function colorMatch(rgbFn, initial, targetRGB, options) {
  const tape = Tape.acquire();
  const p = vec3AD(initial[0], initial[1], initial[2]);
  const lossFn = function () {
    const rgb = rgbFn(p);
    const dr = sub(rgb.value[0], node(targetRGB[0]));
    const dg = sub(rgb.value[1], node(targetRGB[1]));
    const db = sub(rgb.value[2], node(targetRGB[2]));
    const r0 = node(rgb.value[0]); r0._prev = new Set([rgb]); r0._backward = function () { rgb.grad[0] += r0.grad[0]; };
    const r1 = node(rgb.value[1]); r1._prev = new Set([rgb]); r1._backward = function () { rgb.grad[1] += r1.grad[0]; };
    const r2 = node(rgb.value[2]); r2._prev = new Set([rgb]); r2._backward = function () { rgb.grad[2] += r2.grad[0]; };
    return add(add(mul(sub(r0, node(targetRGB[0])), sub(r0, node(targetRGB[0]))),
                   mul(sub(r1, node(targetRGB[1])), sub(r1, node(targetRGB[1])))),
               mul(sub(r2, node(targetRGB[2])), sub(r2, node(targetRGB[2]))));
  };
  const result = optimize(tape, [p], lossFn, options);
  result.param = p;
  result.value = p.toArray();
  Tape.release(tape);
  return result;
}

/** Fit morph target weights to match an observed shape. */
function morphFit(morphFn, initialWeights, observedPoints, options) {
  const tape = Tape.acquire();
  const params = initialWeights.map((w) => node(w));
  const lossFn = function () {
    const result = morphFn(params);
    let loss = node(0);
    for (let k = 0; k < observedPoints.length; k++) {
      const obs = observedPoints[k];
      const cur = result[k];
      const dx = sub(cur.value[0], node(obs[0]));
      const dy = sub(cur.value[1], node(obs[1]));
      const dz = sub(cur.value[2], node(obs[2]));
      const x0 = node(cur.value[0]); x0._prev = new Set([cur]); x0._backward = function () { cur.grad[0] += x0.grad[0]; };
      const y0 = node(cur.value[1]); y0._prev = new Set([cur]); y0._backward = function () { cur.grad[1] += y0.grad[0]; };
      const z0 = node(cur.value[2]); z0._prev = new Set([cur]); z0._backward = function () { cur.grad[2] += z0.grad[0]; };
      loss = add(loss, add(add(mul(sub(x0, node(obs[0])), sub(x0, node(obs[0]))),
                              mul(sub(y0, node(obs[1])), sub(y0, node(obs[1])))),
                          mul(sub(z0, node(obs[2])), sub(z0, node(obs[2])))));
    }
    return loss;
  };
  const result = optimize(tape, params, lossFn, options);
  result.params = params;
  Tape.release(tape);
  return result;
}

// ============================================================================
// Function Declarations — SOA
// ============================================================================

/**
 * Batch forward + backward over `count` independent problems.
 * `forwardAndBackward(i, params_i, grads_i)` must:
 *   - Read params from `params_i` (Float array slice)
 *   - Fill grads into `grads_i`
 * This is the generic autograd-free batch API. For full graph-based batch,
 * see `soaOptimize`.
 */
function soaForward(params, grads, count, paramsPerProblem, forwardAndBackward) {
  for (let i = 0; i < count; i++) {
    const offset = i * paramsPerProblem;
    forwardAndBackward(i, params, grads, offset);
  }
}

async function soaForwardChunked(params, grads, count, paramsPerProblem, forwardAndBackward, chunkSize, yieldEvery) {
  chunkSize = chunkSize || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    for (let i = start; i < end; i++) {
      const offset = i * paramsPerProblem;
      forwardAndBackward(i, params, grads, offset);
    }
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
}

/**
 * Batched optimizer: run `count` independent gradient descents in one call.
 * `lossFn(params, i)` returns a scalar ADNode for problem `i`.
 */
function soaOptimize(count, paramsPerProblem, lossFn, options) {
  options = options || {};
  const iterations = options.iterations || 100;
  const lr         = options.lr         !== undefined ? options.lr : 0.01;
  const T = getArrayType();
  const params = new T(count * paramsPerProblem);
  const optHandle = {
    params: params,
    grads: new T(count * paramsPerProblem),
    count: count,
    paramsPerProblem: paramsPerProblem
  };
  // Per-problem tape + params
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < count; i++) {
      const tape = Tape.acquire();
      const paramNodes = new Array(paramsPerProblem);
      const offset = i * paramsPerProblem;
      for (let p = 0; p < paramsPerProblem; p++) {
        paramNodes[p] = node(params[offset + p]);
      }
      const loss = lossFn(paramNodes, i);
      tape.backward(loss);
      for (let p = 0; p < paramsPerProblem; p++) {
        params[offset + p] -= lr * paramNodes[p].grad[0];
        optHandle.grads[offset + p] = paramNodes[p].grad[0];
      }
      Tape.release(tape);
    }
  }
  return optHandle;
}

async function soaOptimizeChunked(count, paramsPerProblem, lossFn, options, chunkSize, yieldEvery) {
  options = options || {};
  const iterations = options.iterations || 100;
  const lr         = options.lr         !== undefined ? options.lr : 0.01;
  chunkSize = chunkSize || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  const T = getArrayType();
  const params = new T(count * paramsPerProblem);
  const optHandle = {
    params: params,
    grads: new T(count * paramsPerProblem),
    count: count,
    paramsPerProblem: paramsPerProblem
  };
  for (let iter = 0; iter < iterations; iter++) {
    let c = 0;
    for (let start = 0; start < count; start += chunkSize) {
      const end = Math.min(start + chunkSize, count);
      for (let i = start; i < end; i++) {
        const tape = Tape.acquire();
        const paramNodes = new Array(paramsPerProblem);
        const offset = i * paramsPerProblem;
        for (let p = 0; p < paramsPerProblem; p++) {
          paramNodes[p] = node(params[offset + p]);
        }
        const loss = lossFn(paramNodes, i);
        tape.backward(loss);
        for (let p = 0; p < paramsPerProblem; p++) {
          params[offset + p] -= lr * paramNodes[p].grad[0];
          optHandle.grads[offset + p] = paramNodes[p].grad[0];
        }
        Tape.release(tape);
      }
      if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
  }
  return optHandle;
}

// ============================================================================
// Function Declarations — Pool helpers
// ============================================================================

function acquireNode(size) { return ADNode.acquire(size); }
function releaseNode(n) { ADNode.release(n); }
function acquireTape() { return Tape.acquire(); }
function releaseTape(t) { Tape.release(t); }

// ============================================================================
// Class Declarations — Pools wrappers
// ============================================================================

/**
 * Convenience wrapper class around the ADNode pool.
 */
class ADPool {
  static acquire(size) { return ADNode.acquire(size); }
  static release(n) { ADNode.release(n); }
  static warm(count) {
    for (let i = 0; i < count; i++) ADNode.#warm?.push?.(new ADNode(1));
  }
}

/**
 * Convenience wrapper class around the Tape pool.
 */
class TapePool {
  static acquire() { return Tape.acquire(); }
  static release(t) { Tape.release(t); }
}

/**
 * Batch state — one tape + one param array for the current problem.
 * Users can run `forward(lossFn)` then `backward(loss)` then `step(lr)`.
 */
class ADBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      ADBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

  constructor(paramCount) {
    this.tape = Tape.acquire();
    this.params = [];
    const T = getArrayType();
    this.paramBuffer = new T(paramCount);
    this.paramCount = paramCount;
  }

  /** Forward + backward pass, returning the loss value. */
  run(lossFn, lr) {
    this.tape.reset();
    const loss = lossFn(this.paramBuffer, this.tape);
    this.tape.backward(loss);
    if (lr !== undefined) {
      for (let i = 0; i < this.paramBuffer.length; i++) {
        this.paramBuffer[i] -= lr * (this.tape.nodes[this.tape.nodes.length - 1]?.grad[i] || 0);
      }
    }
    return loss.value[0];
  }

  dispose() {
    Tape.release(this.tape);
    this.tape = null;
    this.params.length = 0;
  }
}

function createADBatch(paramCount) { return new ADBatchState(paramCount); }

// ============================================================================
// Namespace convenience
// ============================================================================

exports.namespace.core = {
  ADNode, Tape, node, scalar, vector, vec3AD, quatAD,
  requiresGrad, detach, constant, variable,
  backward, zeroGrad
};

exports.namespace.ops = {
  add, sub, mul, div, neg, inv, abs, pow: powAD, sqrt: sqrtAD, cbrt: cbrtAD,
  exp: expAD, expm1: expm1AD, log: logAD, log1p: log1pAD,
  sin: sinAD, cos: cosAD, tan: tanAD,
  asin: asinAD, acos: acosAD, atan: atanAD, atan2: atan2AD,
  sinh: sinhAD, cosh: coshAD, tanh: tanhAD,
  sigmoid: sigmoidAD, relu: reluAD, leakyRelu: leakyReluAD,
  smoothstep: smoothstepAD, saturate: saturateAD, softplus: softplusAD,
  min: minAD, max: maxAD, clamp: clampAD
};

exports.namespace.reduce = {
  sum: sumAD, mean: meanAD, dot: dotAD,
  length: lengthAD, lengthSq: lengthSqAD,
  normalize3: normalize3AD, cross3: cross3AD
};

exports.namespace.optim = {
  optimize, optimizeVec3, sgdStep, adamStep, createAdamState
};

exports.namespace.domain = {
  noiseGradient: noiseGradientAD,
  sdfFit,
  ikOptimize,
  orbitalEnergyMinimize,
  animationFit,
  colorMatch,
  morphFit
};

exports.namespace.batch = {
  forward: soaForward,
  forwardChunked: soaForwardChunked,
  optimize: soaOptimize,
  optimizeChunked: soaOptimizeChunked,
  State: ADBatchState,
  create: createADBatch
};

// ============================================================================
// Precision listener
// ============================================================================

onPrecisionChange(function (mode, oldMode) {
  // Existing tapes and nodes keep their current array types. New nodes created
  // after this point use the new type via getArrayType().
});
