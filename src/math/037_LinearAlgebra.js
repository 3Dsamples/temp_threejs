// file number : 037
// full path name : src/math/037_LinearAlgebra.js
// description : High-performance reimplementation of the linear-algebra@3.1.4 API (Matrix/Vector, trans, dot, elementwise mul/div/plus/minus, map, log, sigmoid, mulEach, plusEach, getSum, identity, scalar, zero) on top of the engine's flat typed arrays and DoubleDouble precision. Includes in-place variants (`_` suffix), engine-wide ARRAY_TYPE, optional DD high-precision mode, policy-aware wrappers, and pooled scratch buffers for zero-allocation hot paths. Designed for seamless integration with the existing math stack (003_Common, 014_DoubleDouble, 030_Policy).
// best for : ML feature pipelines, physics constraint Jacobians, PBR parameter fitting, neural-network layers inside the ECS, procedural mesh analysis, camera calibration, and any dense matrix/vector workload at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'LinearAlgebraDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'LinearAlgebraDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkMatrix(m, op) {
  if (!m || !(m instanceof Matrix)) {
    throw new DecodeError(op, 'Matrix instance required');
  }
  return m;
}

function checkSizeMatch(a, b, op) {
  if (a.rows !== b.rows || a.cols !== b.cols) {
    throw new DomainViolationError(
      op,
      `size mismatch: ${a.rows}x${a.cols} vs ${b.rows}x${b.cols}`
    );
  }
}

function checkDotShape(a, b, op) {
  if (a.cols !== b.rows) {
    throw new DomainViolationError(
      op,
      `dot shape mismatch: ${a.rows}x${a.cols} · ${b.rows}x${b.cols}`
    );
  }
}

// ============================================================================
// MATRIX CLASS (flat typed array backing)
// ============================================================================
export class Matrix {
  constructor(values, ddMode) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new DecodeError('Matrix', 'values must be a non-empty array');
    }
    const is2D = Array.isArray(values[0]);
    const rows = is2D ? values.length : 1;
    const cols = is2D ? values[0].length : values.length;
    if (rows === 0 || cols === 0) {
      throw new DecodeError('Matrix', 'dimensions must be positive');
    }
    this.rows = rows;
    this.cols = cols;
    this.dd = !!ddMode;
    const n = rows * cols;
    if (this.dd) {
      // Flat array of DD pairs: [lo, hi, lo, hi, ...]
      this.data = new ARRAY_TYPE(n * 2);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = is2D ? values[r][c] : values[c];
          if (!isFiniteNumber(v)) {
            throw new DecodeError('Matrix', `element [${r},${c}] must be finite`);
          }
          this.data[(r * cols + c) * 2] = 0;
          this.data[(r * cols + c) * 2 + 1] = v;
        }
      }
    } else {
      this.data = new ARRAY_TYPE(n);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = is2D ? values[r][c] : values[c];
          if (!isFiniteNumber(v)) {
            throw new DecodeError('Matrix', `element [${r},${c}] must be finite`);
          }
          this.data[r * cols + c] = v;
        }
      }
    }
  }

  get(r, c) {
    if (this.dd) {
      const i = (r * this.cols + c) * 2;
      return [this.data[i], this.data[i + 1]];
    }
    return this.data[r * this.cols + c];
  }

  set(r, c, v) {
    if (this.dd) {
      const i = (r * this.cols + c) * 2;
      this.data[i] = 0;
      this.data[i + 1] = v;
    } else {
      this.data[r * this.cols + c] = v;
    }
  }

  clone() {
    const m = Object.create(Matrix.prototype);
    m.rows = this.rows;
    m.cols = this.cols;
    m.dd = this.dd;
    m.data = new ARRAY_TYPE(this.data.length);
    for (let i = 0; i < this.data.length; i++) m.data[i] = this.data[i];
    return m;
  }

  toArray() {
    const out = new Array(this.rows);
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) {
        row[c] = this.dd
          ? this.data[(r * this.cols + c) * 2 + 1]
          : this.data[r * this.cols + c];
      }
      out[r] = row;
    }
    return out;
  }

  // ----------------------------------------------------------------
  // Transpose
  // ----------------------------------------------------------------
  trans() {
    const out = new Matrix(this.rows === 1 ? this.toRowVectorArray() : this.toArray());
    out.rows = this.cols;
    out.cols = this.rows;
    out.dd = this.dd;
    const n = this.rows * this.cols;
    if (this.dd) {
      out.data = new ARRAY_TYPE(n * 2);
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const src = (r * this.cols + c) * 2;
          const dst = (c * this.rows + r) * 2;
          out.data[dst] = this.data[src];
          out.data[dst + 1] = this.data[src + 1];
        }
      }
    } else {
      out.data = new ARRAY_TYPE(n);
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          out.data[c * this.rows + r] = this.data[r * this.cols + c];
        }
      }
    }
    return out;
  }

  trans_() {
    const rows = this.rows;
    const cols = this.cols;
    const n = rows * cols;
    if (this.dd) {
      const tmp = new ARRAY_TYPE(n * 2);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const src = (r * cols + c) * 2;
          const dst = (c * rows + r) * 2;
          tmp[dst] = this.data[src];
          tmp[dst + 1] = this.data[src + 1];
        }
      }
      this.data = tmp;
    } else {
      const tmp = new ARRAY_TYPE(n);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          tmp[c * rows + r] = this.data[r * cols + c];
        }
      }
      this.data = tmp;
    }
    this.rows = cols;
    this.cols = rows;
    return this;
  }

  toRowVectorArray() {
    const row = new Array(this.cols);
    for (let c = 0; c < this.cols; c++) {
      row[c] = this.dd
        ? this.data[c * 2 + 1]
        : this.data[c];
    }
    return [row];
  }

  // ----------------------------------------------------------------
  // Element-wise algebra
  // ----------------------------------------------------------------
  _binaryOp(op, other) {
    checkMatrix(other, op);
    checkSizeMatch(this, other, op);
    const out = this.clone();
    const n = this.rows * this.cols;
    if (this.dd || other.dd) {
      out.dd = true;
      out.data = new ARRAY_TYPE(n * 2);
      for (let i = 0; i < n; i++) {
        const a = this.dd ? [this.data[i * 2], this.data[i * 2 + 1]] : [0, this.data[i]];
        const b = other.dd ? [other.data[i * 2], other.data[i * 2 + 1]] : [0, other.data[i]];
        let r;
        if (op === 'mul') r = DD.multiply(a, b);
        else if (op === 'div') r = DD.divide(a, b);
        else if (op === 'plus') r = DD.add(a, b);
        else r = DD.subtract(a, b);
        out.data[i * 2] = r[0];
        out.data[i * 2 + 1] = r[1];
      }
    } else {
      out.data = new ARRAY_TYPE(n);
      for (let i = 0; i < n; i++) {
        const a = this.data[i];
        const b = other.data[i];
        if (op === 'mul') out.data[i] = a * b;
        else if (op === 'div') out.data[i] = a / b;
        else if (op === 'plus') out.data[i] = a + b;
        else out.data[i] = a - b;
      }
    }
    return out;
  }

  mul(other) { return this._binaryOp('mul', other); }
  div(other) { return this._binaryOp('div', other); }
  plus(other) { return this._binaryOp('plus', other); }
  minus(other) { return this._binaryOp('minus', other); }

  mul_(other) {
    const out = this._binaryOp('mul', other);
    this._adopt(out);
    return this;
  }
  div_(other) {
    const out = this._binaryOp('div', other);
    this._adopt(out);
    return this;
  }
  plus_(other) {
    const out = this._binaryOp('plus', other);
    this._adopt(out);
    return this;
  }
  minus_(other) {
    const out = this._binaryOp('minus', other);
    this._adopt(out);
    return this;
  }

  _adopt(out) {
    this.data = out.data;
    this.rows = out.rows;
    this.cols = out.cols;
    this.dd = out.dd;
  }

  // ----------------------------------------------------------------
  // Dot product
  // ----------------------------------------------------------------
  dot(other) {
    checkMatrix(other, 'dot');
    checkDotShape(this, other, 'dot');
    const n = this.rows;
    const m = other.cols;
    const k = this.cols;
    const out = new Matrix(
      Array.from({ length: n }, () => new Array(m).fill(0)),
      this.dd || other.dd
    );
    if (out.dd) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
          let acc = [0, 0];
          for (let p = 0; p < k; p++) {
            const a = this.dd ? [this.data[(i * k + p) * 2], this.data[(i * k + p) * 2 + 1]] : [0, this.data[i * k + p]];
            const b = other.dd ? [other.data[(p * m + j) * 2], other.data[(p * m + j) * 2 + 1]] : [0, other.data[p * m + j]];
            acc = DD.add(acc, DD.multiply(a, b));
          }
          out.data[(i * m + j) * 2] = acc[0];
          out.data[(i * m + j) * 2 + 1] = acc[1];
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
          let acc = 0;
          for (let p = 0; p < k; p++) {
            acc += this.data[i * k + p] * other.data[p * m + j];
          }
          out.data[i * m + j] = acc;
        }
      }
    }
    return out;
  }

  dot_(other) {
    const out = this.dot(other);
    this._adopt(out);
    return this;
  }

  // ----------------------------------------------------------------
  // Math transforms
  // ----------------------------------------------------------------
  map(fn) {
    const out = this.clone();
    const n = this.rows * this.cols;
    if (this.dd) {
      for (let i = 0; i < n; i++) {
        const v = [this.data[i * 2], this.data[i * 2 + 1]];
        const r = fn(DD.toDouble(v));
        out.data[i * 2] = 0;
        out.data[i * 2 + 1] = r;
      }
    } else {
      for (let i = 0; i < n; i++) out.data[i] = fn(this.data[i]);
    }
    return out;
  }

  map_(fn) {
    const out = this.map(fn);
    this._adopt(out);
    return this;
  }

  log() { return this.map((v) => Math.log(v)); }
  log_() { return this.map_((v) => Math.log(v)); }

  sigmoid() { return this.map((v) => 1 / (1 + Math.exp(-v))); }
  sigmoid_() { return this.map_((v) => 1 / (1 + Math.exp(-v))); }

  mulEach(value) {
    if (!isFiniteNumber(value)) throw new DecodeError('mulEach', 'value must be finite');
    return this.map((v) => v * value);
  }

  mulEach_(value) {
    if (!isFiniteNumber(value)) throw new DecodeError('mulEach_', 'value must be finite');
    return this.map_((v) => v * value);
  }

  plusEach(value) {
    if (!isFiniteNumber(value)) throw new DecodeError('plusEach', 'value must be finite');
    return this.map((v) => v + value);
  }

  plusEach_(value) {
    if (!isFiniteNumber(value)) throw new DecodeError('plusEach_', 'value must be finite');
    return this.map_((v) => v + value);
  }

  // ----------------------------------------------------------------
  // Reductions
  // ----------------------------------------------------------------
  getSum() {
    const n = this.rows * this.cols;
    if (this.dd) {
      let acc = [0, 0];
      for (let i = 0; i < n; i++) {
        acc = DD.add(acc, [this.data[i * 2], this.data[i * 2 + 1]]);
      }
      return DD.toDouble(acc);
    }
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.data[i];
    return sum;
  }

  // ----------------------------------------------------------------
  // Static factories
  // ----------------------------------------------------------------
  static identity(n, ddMode) {
    if (!Number.isInteger(n) || n <= 0) throw new DecodeError('identity', 'n must be positive integer');
    const m = new Matrix(Array.from({ length: n }, () => new Array(n).fill(0)), ddMode);
    for (let i = 0; i < n; i++) {
      if (m.dd) m.data[(i * n + i) * 2 + 1] = 1;
      else m.data[i * n + i] = 1;
    }
    return m;
  }

  static scalar(n, value, ddMode) {
    if (!Number.isInteger(n) || n <= 0) throw new DecodeError('scalar', 'n must be positive integer');
    if (!isFiniteNumber(value)) throw new DecodeError('scalar', 'value must be finite');
    const m = new Matrix(Array.from({ length: n }, () => new Array(n).fill(0)), ddMode);
    for (let i = 0; i < n; i++) {
      if (m.dd) m.data[(i * n + i) * 2 + 1] = value;
      else m.data[i * n + i] = value;
    }
    return m;
  }
}

// ============================================================================
// VECTOR HELPERS (single-row Matrix)
// ============================================================================
export const Vector = {
  zero(n, ddMode) {
    if (!Number.isInteger(n) || n <= 0) throw new DecodeError('Vector.zero', 'n must be positive integer');
    return new Matrix([new Array(n).fill(0)], ddMode);
  },
  one(n, ddMode) {
    if (!Number.isInteger(n) || n <= 0) throw new DecodeError('Vector.one', 'n must be positive integer');
    return new Matrix([new Array(n).fill(1)], ddMode);
  },
  from(values, ddMode) {
    return new Matrix([values.slice()], ddMode);
  }
};

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const MatrixInput = Object.freeze({
  make(rows, cols, values, ddMode) {
    const m = new Matrix(values, ddMode);
    if (m.rows !== rows || m.cols !== cols) {
      throw new DecodeError('matrix', 'dimension mismatch');
    }
    return m;
  },
  decode(input) {
    if (!input || !(input instanceof Matrix)) {
      throw new DecodeError('matrix', 'Matrix instance required');
    }
    return input;
  }
});

export const BinaryOpInput = Object.freeze({
  make(a, b) { return { a, b }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('binaryOp', 'Expected {a, b}');
    checkMatrix(input.a, 'binaryOp');
    checkMatrix(input.b, 'binaryOp');
    return input;
  }
});

export const DotInput = Object.freeze({
  make(a, b) { return { a, b }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('dot', 'Expected {a, b}');
    checkMatrix(input.a, 'dot');
    checkMatrix(input.b, 'dot');
    checkDotShape(input.a, input.b, 'dot');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function transposeValidated(input) {
  const m = MatrixInput.decode(input);
  return m.trans();
}

export function dotValidated(input) {
  const d = DotInput.decode(input);
  return d.a.dot(d.b);
}

export function mulValidated(input) {
  const d = BinaryOpInput.decode(input);
  return d.a.mul(d.b);
}

export function divValidated(input) {
  const d = BinaryOpInput.decode(input);
  return d.a.div(d.b);
}

export function plusValidated(input) {
  const d = BinaryOpInput.decode(input);
  return d.a.plus(d.b);
}

export function minusValidated(input) {
  const d = BinaryOpInput.decode(input);
  return d.a.minus(d.b);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================
function policyCustom(operation, compute, isValid, annotate, policy) {
  const pol = PolicyModule.resolvePolicy(policy);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = compute();
  if (pol.precision === PolicyModule.PrecisionMode.STRICT && !isValid(result)) {
    throw new DomainViolationError(operation, 'strict precision rejected invalid result');
  }
  if (pol.diagnostics !== PolicyModule.DiagnosticMode.DISABLED) {
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const info = annotate ? annotate(result) : {};
    info.precision = pol.precision;
    info.elapsedMs = elapsed;
    // eslint-disable-next-line no-console
    console.log(`[${operation}]`, info);
  }
  return result;
}

function isValidMatrix(m) {
  if (!m || !(m instanceof Matrix)) return false;
  for (let i = 0; i < m.data.length; i++) {
    if (!isFiniteNumber(m.data[i])) return false;
  }
  return true;
}

export function dotWithPolicies(a, b, policy) {
  return policyCustom(
    'LinearAlgebra.dotWithPolicies',
    () => a.dot(b),
    isValidMatrix,
    (r) => ({ rows: r.rows, cols: r.cols }),
    policy
  );
}

export function transposeWithPolicies(m, policy) {
  return policyCustom(
    'LinearAlgebra.transposeWithPolicies',
    () => m.trans(),
    isValidMatrix,
    (r) => ({ rows: r.rows, cols: r.cols }),
    policy
  );
}

export function mulWithPolicies(a, b, policy) {
  return policyCustom(
    'LinearAlgebra.mulWithPolicies',
    () => a.mul(b),
    isValidMatrix,
    (r) => ({ rows: r.rows, cols: r.cols }),
    policy
  );
}

// ============================================================================
// POOL (scratch buffers)
// ============================================================================
const _scratchPool = [];
const _MAX_SCRATCH = 32;

export function poolAcquireScratch(n) {
  if (_scratchPool.length > 0) {
    const s = _scratchPool.pop();
    if (s.length === n) {
      s.fill(0);
      return s;
    }
  }
  return new ARRAY_TYPE(n);
}

export function poolReleaseScratch(s) {
  if (_scratchPool.length >= _MAX_SCRATCH) return;
  _scratchPool.push(s);
}

export function poolReset() {
  _scratchPool.length = 0;
}

export function poolSize() {
  return _scratchPool.length;
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  Matrix,
  Vector,
  MatrixInput,
  BinaryOpInput,
  DotInput,
  transposeValidated,
  dotValidated,
  mulValidated,
  divValidated,
  plusValidated,
  minusValidated,
  dotWithPolicies,
  transposeWithPolicies,
  mulWithPolicies,
  poolAcquireScratch,
  poolReleaseScratch,
  poolReset,
  poolSize
};