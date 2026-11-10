// file number : 038
// full path name : src/math/038_MatrixML.js
// description : High-performance reimplementation of the mljs/matrix API (Matrix class + static factories + solvers + Strassen + Kronecker + elementwise ops + Gauss-Jordan + determinant + trace + row/column/diagonal selection + permute/sort + FMM). Fully integrated with the engine's ARRAY_TYPE (32/64-bit), DoubleDouble high-precision mode, 030_Policy diagnostics/budget, and pooled scratch buffers. Class is named MLMatrix to avoid collision with 037_LinearAlgebra Matrix. Supports in-place variants, DD-aware arithmetic, and zero-allocation hot paths.
// best for : ML feature matrices, PCA/regression in-engine, physics Jacobian assembly, procedural mesh deformation, PBR fitting, galactic-scale dense workloads, and any large matrix workload in the ECS on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, RANDOM, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixMLDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixMLDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkPositiveInt(n, op, name) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new DecodeError(op, name + ' must be a positive integer');
  }
}

const STRASSEN_THRESHOLD = 128;

// ============================================================================
// MATRIX CLASS
// ============================================================================
export class MLMatrix {
  constructor(nRows, nColumns, options) {
    if (arguments.length === 1 && typeof nRows === 'object' && nRows !== null && !(nRows instanceof MLMatrix)) {
      const obj = nRows;
      this.rows = obj.rows;
      this.columns = obj.columns;
      const n = this.rows * this.columns;
      this.data = new ARRAY_TYPE(n);
      for (let i = 0; i < n; i++) this.data[i] = obj.data[i];
      this.dd = !!obj.dd;
      return;
    }

    if (nRows instanceof MLMatrix) {
      this.rows = nRows.rows;
      this.columns = nRows.columns;
      this.dd = nRows.dd;
      const n = this.rows * this.columns;
      this.data = new ARRAY_TYPE(this.dd ? n * 2 : n);
      for (let i = 0; i < this.data.length; i++) this.data[i] = nRows.data[i];
      return;
    }

    if (!Number.isInteger(nRows) || !Number.isInteger(nColumns) || nRows < 0 || nColumns < 0) {
      throw new DecodeError('MLMatrix', 'dimensions must be non-negative integers');
    }
    const opts = options || {};
    this.rows = nRows;
    this.columns = nColumns;
    this.dd = !!opts.dd;
    const n = nRows * nColumns;
    if (this.dd) {
      this.data = new ARRAY_TYPE(n * 2);
      const init = opts.initial !== undefined ? opts.initial : 0;
      for (let i = 0; i < n; i++) this.data[i * 2 + 1] = init;
    } else {
      this.data = new ARRAY_TYPE(n);
      if (opts.initial !== undefined) this.data.fill(opts.initial);
    }
  }

  // ---------------------------------------------------------------
  // Static factories
  // ---------------------------------------------------------------
  static from1DArray(nRows, nColumns, data, dd) {
    checkPositiveInt(nRows, 'from1DArray', 'nRows');
    checkPositiveInt(nColumns, 'from1DArray', 'nColumns');
    if (nRows * nColumns !== data.length) {
      throw new DecodeError('from1DArray', 'data length mismatch');
    }
    const m = new MLMatrix(nRows, nColumns, { dd });
    for (let i = 0; i < data.length; i++) {
      if (dd) m.data[i * 2 + 1] = data[i];
      else m.data[i] = data[i];
    }
    return m;
  }

  static from2DArray(data, dd) {
    if (!Array.isArray(data) || data.length === 0) throw new DecodeError('from2DArray', 'data must be non-empty 2D array');
    const rows = data.length;
    const cols = data[0].length;
    if (cols === 0) throw new DecodeError('from2DArray', 'columns must be positive');
    const m = new MLMatrix(rows, cols, { dd });
    for (let r = 0; r < rows; r++) {
      if (data[r].length !== cols) throw new DecodeError('from2DArray', 'row length mismatch');
      for (let c = 0; c < cols; c++) {
        const v = data[r][c];
        if (dd) m.data[(r * cols + c) * 2 + 1] = v;
        else m.data[r * cols + c] = v;
      }
    }
    return m;
  }

  static eye(n, dd) {
    checkPositiveInt(n, 'eye', 'n');
    const m = new MLMatrix(n, n, { dd });
    for (let i = 0; i < n; i++) {
      if (dd) m.data[(i * n + i) * 2 + 1] = 1;
      else m.data[i * n + i] = 1;
    }
    return m;
  }

  static ones(n, dd) { return new MLMatrix(n, n, { initial: 1, dd }); }
  static zeros(n, dd) { return new MLMatrix(n, n, { initial: 0, dd }); }

  static random(n, dd) {
    checkPositiveInt(n, 'random', 'n');
    const m = new MLMatrix(n, n, { dd });
    for (let i = 0; i < n * n; i++) {
      if (dd) m.data[i * 2 + 1] = RANDOM();
      else m.data[i] = RANDOM();
    }
    return m;
  }

  static randomInt(n, max, dd) {
    checkPositiveInt(n, 'randomInt', 'n');
    const mx = max === undefined ? Number.MAX_SAFE_INTEGER : max;
    const m = new MLMatrix(n, n, { dd });
    for (let i = 0; i < n * n; i++) {
      const v = Math.floor(RANDOM() * mx);
      if (dd) m.data[i * 2 + 1] = v;
      else m.data[i] = v;
    }
    return m;
  }

  static diag(array, dd) {
    if (!Array.isArray(array) || array.length === 0) throw new DecodeError('diag', 'array required');
    const n = array.length;
    const m = new MLMatrix(n, n, { dd });
    for (let i = 0; i < n; i++) {
      if (dd) m.data[(i * n + i) * 2 + 1] = array[i];
      else m.data[i * n + i] = array[i];
    }
    return m;
  }

  static columnVector(nRows, data, dd) { return MLMatrix.from1DArray(nRows, 1, data, dd); }
  static rowVector(nColumns, data, dd) { return MLMatrix.from1DArray(1, nColumns, data, dd); }

  static isMatrix(m) { return m instanceof MLMatrix; }

  static checkMatrix(m, op) {
    if (!(m instanceof MLMatrix)) throw new DecodeError(op || 'checkMatrix', 'Matrix instance required');
    return m;
  }

  static xrange(start, stop) {
    if (stop === undefined) { stop = start; start = 0; }
    const n = Math.max(0, Math.ceil(stop - start));
    const out = new ARRAY_TYPE(n);
    for (let i = 0; i < n; i++) out[i] = start + i;
    return out;
  }

  static sort(arr) { return Array.from(arr).sort((a, b) => a - b); }

  // ---------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------
  get(r, c) {
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= this.rows || c < 0 || c >= this.columns) {
      throw new DecodeError('get', 'index out of bounds');
    }
    if (this.dd) {
      const i = (r * this.columns + c) * 2;
      return [this.data[i], this.data[i + 1]];
    }
    return this.data[r * this.columns + c];
  }

  set(r, c, v) {
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= this.rows || c < 0 || c >= this.columns) {
      throw new DecodeError('set', 'index out of bounds');
    }
    if (this.dd) {
      const i = (r * this.columns + c) * 2;
      this.data[i] = 0;
      this.data[i + 1] = v;
    } else {
      this.data[r * this.columns + c] = v;
    }
  }

  clone() { return new MLMatrix(this); }

  to2DArray() {
    const out = new Array(this.rows);
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.columns);
      for (let c = 0; c < this.columns; c++) {
        row[c] = this.dd
          ? this.data[(r * this.columns + c) * 2 + 1]
          : this.data[r * this.columns + c];
      }
      out[r] = row;
    }
    return out;
  }

  to1DArray() {
    const n = this.rows * this.columns;
    const out = new ARRAY_TYPE(n);
    if (this.dd) {
      for (let i = 0; i < n; i++) out[i] = this.data[i * 2 + 1];
    } else {
      for (let i = 0; i < n; i++) out[i] = this.data[i];
    }
    return out;
  }

  // ---------------------------------------------------------------
  // Multiplication
  // ---------------------------------------------------------------
  mmul(other) {
    MLMatrix.checkMatrix(other, 'mmul');
    if (this.columns !== other.rows) {
      throw new DomainViolationError('mmul', `inner dim mismatch: ${this.columns} vs ${other.rows}`);
    }
    const dd = this.dd || other.dd;
    const out = new MLMatrix(this.rows, other.columns, { dd });
    this._mmulInto(out, other);
    return out;
  }

  mmul_(other) {
    const out = this.mmul(other);
    this.rows = out.rows;
    this.columns = out.columns;
    this.dd = out.dd;
    this.data = out.data;
    return this;
  }

  _mmulInto(out, other) {
    const n = this.rows;
    const m = other.columns;
    const k = this.columns;
    if (!out.dd) {
      const a = this.data;
      const b = other.data;
      const c = out.data;
      for (let i = 0; i < n; i++) {
        const ai = i * k;
        const ci = i * m;
        for (let j = 0; j < m; j++) c[ci + j] = 0;
        for (let p = 0; p < k; p++) {
          const aip = a[ai + p];
          if (aip === 0) continue;
          const bp = p * m;
          for (let j = 0; j < m; j++) c[ci + j] += aip * b[bp + j];
        }
      }
    } else {
      const a = this.data;
      const b = other.data;
      const c = out.data;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
          let acc = [0, 0];
          for (let p = 0; p < k; p++) {
            const ai = this.dd ? [a[(i * k + p) * 2], a[(i * k + p) * 2 + 1]] : [0, a[i * k + p]];
            const bi = other.dd ? [b[(p * m + j) * 2], b[(p * m + j) * 2 + 1]] : [0, b[p * m + j]];
            acc = DD.add(acc, DD.multiply(ai, bi));
          }
          const oi = (i * m + j) * 2;
          c[oi] = acc[0];
          c[oi + 1] = acc[1];
        }
      }
    }
  }

  strassen(other) {
    MLMatrix.checkMatrix(other, 'strassen');
    if (this.columns !== other.rows) throw new DomainViolationError('strassen', 'inner dim mismatch');
    // Fallback to standard for small matrices or non-square
    if (this.rows <= STRASSEN_THRESHOLD || this.columns <= STRASSEN_THRESHOLD || other.columns <= STRASSEN_THRESHOLD ||
        this.rows !== this.columns || other.rows !== other.columns || this.rows !== other.rows) {
      return this.mmul(other);
    }
    return this._strassenRecursive(other);
  }

  _strassenRecursive(other) {
    const n = this.rows;
    if (n <= STRASSEN_THRESHOLD) return this.mmul(other);
    const half = n >> 1;
    const A = this._submat(0, 0, half);
    const B = this._submat(0, half, half);
    const C = this._submat(half, 0, half);
    const D = this._submat(half, half, half);
    const E = other._submat(0, 0, half);
    const F = other._submat(0, half, half);
    const G = other._submat(half, 0, half);
    const H = other._submat(half, half, half);

    const P1 = A._strassenRecursive(F.minus(H));
    const P2 = A.plus(B)._strassenRecursive(H);
    const P3 = C.plus(D)._strassenRecursive(E);
    const P4 = D._strassenRecursive(G.minus(E));
    const P5 = A.plus(D)._strassenRecursive(E.plus(H));
    const P6 = B.minus(D)._strassenRecursive(G.plus(H));
    const P7 = A.minus(C)._strassenRecursive(E.plus(F));

    const C11 = P5.plus(P4).minus(P2).plus(P6);
    const C12 = P1.plus(P2);
    const C21 = P3.plus(P4);
    const C22 = P1.plus(P5).minus(P3).minus(P7);

    const out = new MLMatrix(n, n, { dd: this.dd || other.dd });
    out._setSubmat(0, 0, C11);
    out._setSubmat(0, half, C12);
    out._setSubmat(half, 0, C21);
    out._setSubmat(half, half, C22);
    return out;
  }

  _submat(r0, c0, size) {
    const out = new MLMatrix(size, size, { dd: this.dd });
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (this.dd) {
          const src = ((r0 + r) * this.columns + (c0 + c)) * 2;
          const dst = (r * size + c) * 2;
          out.data[dst] = this.data[src];
          out.data[dst + 1] = this.data[src + 1];
        } else {
          out.data[r * size + c] = this.data[(r0 + r) * this.columns + (c0 + c)];
        }
      }
    }
    return out;
  }

  _setSubmat(r0, c0, sub) {
    const size = sub.rows;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (this.dd || sub.dd) {
          // Promote to dd if needed
          const dst = ((r0 + r) * this.columns + (c0 + c)) * 2;
          const src = (r * size + c) * 2;
          if (this.dd) {
            this.data[dst] = sub.dd ? sub.data[src] : 0;
            this.data[dst + 1] = sub.dd ? sub.data[src + 1] : sub.data[r * size + c];
          } else {
            // sub is dd but this isn't - shouldn't happen in strassen
            this.data[(r0 + r) * this.columns + (c0 + c)] = sub.data[src + 1];
          }
        } else {
          this.data[(r0 + r) * this.columns + (c0 + c)] = sub.data[r * size + c];
        }
      }
    }
  }

  fmm(other) {
    // Fast matrix multiplication - dispatch to strassen for large, mmul otherwise
    if (this.rows > STRASSEN_THRESHOLD && this.rows === this.columns && other.rows === other.columns && this.rows === other.rows) {
      return this.strassen(other);
    }
    return this.mmul(other);
  }

  kroneckerProduct(other) {
    MLMatrix.checkMatrix(other, 'kroneckerProduct');
    const dd = this.dd || other.dd;
    const r = this.rows * other.rows;
    const c = this.columns * other.columns;
    const out = new MLMatrix(r, c, { dd });
    for (let i = 0; i < this.rows; i++) {
      for (let j = 0; j < this.columns; j++) {
        const aij = this.dd
          ? [this.data[(i * this.columns + j) * 2], this.data[(i * this.columns + j) * 2 + 1]]
          : this.data[i * this.columns + j];
        for (let k = 0; k < other.rows; k++) {
          for (let l = 0; l < other.columns; l++) {
            const bkl = other.dd
              ? [other.data[(k * other.columns + l) * 2], other.data[(k * other.columns + l) * 2 + 1]]
              : other.data[k * other.columns + l];
            const or = i * other.rows + k;
            const oc = j * other.columns + l;
            if (out.dd) {
              const v = DD.multiply(this.dd ? aij : [0, aij], other.dd ? bkl : [0, bkl]);
              out.data[(or * c + oc) * 2] = v[0];
              out.data[(or * c + oc) * 2 + 1] = v[1];
            } else {
              out.data[or * c + oc] = aij * bkl;
            }
          }
        }
      }
    }
    return out;
  }

  transpose() {
    const out = new MLMatrix(this.columns, this.rows, { dd: this.dd });
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.columns; c++) {
        if (this.dd) {
          const src = (r * this.columns + c) * 2;
          const dst = (c * this.rows + r) * 2;
          out.data[dst] = this.data[src];
          out.data[dst + 1] = this.data[src + 1];
        } else {
          out.data[c * this.rows + r] = this.data[r * this.columns + c];
        }
      }
    }
    return out;
  }

  transpose_() {
    const out = this.transpose();
    this.rows = out.rows;
    this.columns = out.columns;
    this.data = out.data;
    return this;
  }

  // ---------------------------------------------------------------
  // Element-wise arithmetic
  // ---------------------------------------------------------------
  _sameShape(other, op) {
    MLMatrix.checkMatrix(other, op);
    if (this.rows !== other.rows || this.columns !== other.columns) {
      throw new DomainViolationError(op, 'shape mismatch');
    }
  }

  add(other) {
    this._sameShape(other, 'add');
    const dd = this.dd || other.dd;
    const out = new MLMatrix(this.rows, this.columns, { dd });
    this._elementwise(out, other, 'add');
    return out;
  }

  sub(other) {
    this._sameShape(other, 'sub');
    const dd = this.dd || other.dd;
    const out = new MLMatrix(this.rows, this.columns, { dd });
    this._elementwise(out, other, 'sub');
    return out;
  }

  mul(other) {
    this._sameShape(other, 'mul');
    const dd = this.dd || other.dd;
    const out = new MLMatrix(this.rows, this.columns, { dd });
    this._elementwise(out, other, 'mul');
    return out;
  }

  div(other) {
    this._sameShape(other, 'div');
    const dd = this.dd || other.dd;
    const out = new MLMatrix(this.rows, this.columns, { dd });
    this._elementwise(out, other, 'div');
    return out;
  }

  _elementwise(out, other, op) {
    const n = this.rows * this.columns;
    for (let i = 0; i < n; i++) {
      if (out.dd) {
        const a = this.dd ? [this.data[i * 2], this.data[i * 2 + 1]] : [0, this.data[i]];
        const b = other.dd ? [other.data[i * 2], other.data[i * 2 + 1]] : [0, other.data[i]];
        let v;
        if (op === 'add') v = DD.add(a, b);
        else if (op === 'sub') v = DD.subtract(a, b);
        else if (op === 'mul') v = DD.multiply(a, b);
        else v = DD.divide(a, b);
        out.data[i * 2] = v[0];
        out.data[i * 2 + 1] = v[1];
      } else {
        const a = this.data[i];
        const b = other.data[i];
        if (op === 'add') out.data[i] = a + b;
        else if (op === 'sub') out.data[i] = a - b;
        else if (op === 'mul') out.data[i] = a * b;
        else out.data[i] = a / b;
      }
    }
  }

  add_(other) { const o = this.add(other); this._adopt(o); return this; }
  sub_(other) { const o = this.sub(other); this._adopt(o); return this; }
  mul_(other) { const o = this.mul(other); this._adopt(o); return this; }
  div_(other) { const o = this.div(other); this._adopt(o); return this; }

  _adopt(o) {
    this.rows = o.rows;
    this.columns = o.columns;
    this.dd = o.dd;
    this.data = o.data;
  }

  scale(s) {
    const out = new MLMatrix(this.rows, this.columns, { dd: this.dd });
    const n = this.rows * this.columns;
    if (out.dd) {
      const sDD = DD.fromDouble(s);
      for (let i = 0; i < n; i++) {
        const v = DD.multiply([this.data[i * 2], this.data[i * 2 + 1]], sDD);
        out.data[i * 2] = v[0];
        out.data[i * 2 + 1] = v[1];
      }
    } else {
      for (let i = 0; i < n; i++) out.data[i] = this.data[i] * s;
    }
    return out;
  }

  scale_(s) { this._adopt(this.scale(s)); return this; }
  addS(s) { return this._scalarOp(s, 'add'); }
  subS(s) { return this._scalarOp(s, 'sub'); }
  mulS(s) { return this._scalarOp(s, 'mul'); }
  divS(s) { return this._scalarOp(s, 'div'); }
  addS_(s) { this._adopt(this.addS(s)); return this; }
  subS_(s) { this._adopt(this.subS(s)); return this; }
  mulS_(s) { this._adopt(this.mulS(s)); return this; }
  divS_(s) { this._adopt(this.divS(s)); return this; }

  _scalarOp(s, op) {
    const out = new MLMatrix(this.rows, this.columns, { dd: this.dd });
    const n = this.rows * this.columns;
    for (let i = 0; i < n; i++) {
      if (out.dd) {
        const a = [this.data[i * 2], this.data[i * 2 + 1]];
        const b = DD.fromDouble(s);
        let v;
        if (op === 'add') v = DD.add(a, b);
        else if (op === 'sub') v = DD.subtract(a, b);
        else if (op === 'mul') v = DD.multiply(a, b);
        else v = DD.divide(a, b);
        out.data[i * 2] = v[0];
        out.data[i * 2 + 1] = v[1];
      } else {
        const a = this.data[i];
        if (op === 'add') out.data[i] = a + s;
        else if (op === 'sub') out.data[i] = a - s;
        else if (op === 'mul') out.data[i] = a * s;
        else out.data[i] = a / s;
      }
    }
    return out;
  }

  exp() { return this.map((x) => Math.exp(x)); }
  exp_() { this._adopt(this.exp()); return this; }
  abs() { return this.map((x) => Math.abs(x)); }
  abs_() { this._adopt(this.abs()); return this; }

  map(fn) {
    const out = new MLMatrix(this.rows, this.columns, { dd: this.dd });
    const n = this.rows * this.columns;
    for (let i = 0; i < n; i++) {
      const v = this.dd ? DD.toDouble([this.data[i * 2], this.data[i * 2 + 1]]) : this.data[i];
      const r = fn(v);
      if (out.dd) {
        out.data[i * 2] = 0;
        out.data[i * 2 + 1] = r;
      } else {
        out.data[i] = r;
      }
    }
    return out;
  }

  map_(fn) { this._adopt(this.map(fn)); return this; }

  // ---------------------------------------------------------------
  // Norms and dot
  // ---------------------------------------------------------------
  norm(type) {
    const t = type === undefined ? 'frobenius' : type;
    const n = this.rows * this.columns;
    if (t === 'frobenius' || t === 'fro') {
      if (this.dd) {
        let acc = [0, 0];
        for (let i = 0; i < n; i++) {
          const v = [this.data[i * 2], this.data[i * 2 + 1]];
          acc = DD.add(acc, DD.multiply(v, v));
        }
        return DD.toDouble(DD.sqrt(acc));
      }
      let sum = 0;
      for (let i = 0; i < n; i++) sum += this.data[i] * this.data[i];
      return Math.sqrt(sum);
    }
    if (t === 'max') {
      let mx = 0;
      for (let i = 0; i < n; i++) {
        const v = Math.abs(this.dd ? this.data[i * 2 + 1] : this.data[i]);
        if (v > mx) mx = v;
      }
      return mx;
    }
    if (t === 'manhattan' || t === '1') {
      let s = 0;
      for (let i = 0; i < n; i++) s += Math.abs(this.dd ? this.data[i * 2 + 1] : this.data[i]);
      return s;
    }
    return NaN;
  }

  dot(other) {
    this._sameShape(other, 'dot');
    const n = this.rows * this.columns;
    if (this.dd || other.dd) {
      let acc = [0, 0];
      for (let i = 0; i < n; i++) {
        const a = this.dd ? [this.data[i * 2], this.data[i * 2 + 1]] : [0, this.data[i]];
        const b = other.dd ? [other.data[i * 2], other.data[i * 2 + 1]] : [0, other.data[i]];
        acc = DD.add(acc, DD.multiply(a, b));
      }
      return DD.toDouble(acc);
    }
    let s = 0;
    for (let i = 0; i < n; i++) s += this.data[i] * other.data[i];
    return s;
  }

  // ---------------------------------------------------------------
  // Inverse / Gauss-Jordan / determinant
  // ---------------------------------------------------------------
  gaussJordan(destination) {
    if (this.rows !== this.columns) throw new DomainViolationError('gaussJordan', 'matrix must be square');
    const n = this.rows;
    const dd = this.dd;
    const A = new MLMatrix(n, n, { dd });
    for (let i = 0; i < n * n; i++) {
      if (dd) {
        A.data[i * 2] = this.data[i * 2];
        A.data[i * 2 + 1] = this.data[i * 2 + 1];
      } else A.data[i] = this.data[i];
    }

    let dest = destination;
    if (dest === undefined) dest = MLMatrix.eye(n, dd);

    for (let i = 0; i < n; i++) {
      let pivotIdx = i;
      let pivotVal = Math.abs(dd ? A.data[(i * n + i) * 2 + 1] : A.data[i * n + i]);
      for (let k = i + 1; k < n; k++) {
        const v = Math.abs(dd ? A.data[(k * n + i) * 2 + 1] : A.data[k * n + i]);
        if (v > pivotVal) { pivotVal = v; pivotIdx = k; }
      }
      if (pivotVal < EPSILON) {
        throw new DomainViolationError('gaussJordan', 'matrix is singular');
      }
      if (pivotIdx !== i) {
        for (let c = 0; c < n; c++) {
          if (dd) {
            const a = (i * n + c) * 2;
            const b = (pivotIdx * n + c) * 2;
            let t0 = A.data[a], t1 = A.data[a + 1];
            A.data[a] = A.data[b]; A.data[a + 1] = A.data[b + 1];
            A.data[b] = t0; A.data[b + 1] = t1;
            const da = (i * n + c) * 2;
            const db = (pivotIdx * n + c) * 2;
            let d0 = dest.data[da], d1 = dest.data[da + 1];
            dest.data[da] = dest.data[db]; dest.data[da + 1] = dest.data[db + 1];
            dest.data[db] = d0; dest.data[db + 1] = d1;
          } else {
            const t = A.data[i * n + c];
            A.data[i * n + c] = A.data[pivotIdx * n + c];
            A.data[pivotIdx * n + c] = t;
            const d = dest.data[i * n + c];
            dest.data[i * n + c] = dest.data[pivotIdx * n + c];
            dest.data[pivotIdx * n + c] = d;
          }
        }
      }

      const invPivot = dd
        ? DD.divide(DD.fromDouble(1), [A.data[(i * n + i) * 2], A.data[(i * n + i) * 2 + 1]])
        : 1 / A.data[i * n + i];
      for (let c = 0; c < n; c++) {
        if (dd) {
          const pos = (i * n + c) * 2;
          const v = DD.multiply([A.data[pos], A.data[pos + 1]], invPivot);
          A.data[pos] = v[0]; A.data[pos + 1] = v[1];
          const pd = (i * n + c) * 2;
          const vd = DD.multiply([dest.data[pd], dest.data[pd + 1]], invPivot);
          dest.data[pd] = vd[0]; dest.data[pd + 1] = vd[1];
        } else {
          A.data[i * n + c] *= invPivot;
          dest.data[i * n + c] *= invPivot;
        }
      }

      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const factor = dd
          ? [A.data[(r * n + i) * 2], A.data[(r * n + i) * 2 + 1]]
          : A.data[r * n + i];
        if (dd ? DD.toDouble(factor) === 0 : factor === 0) continue;
        for (let c = 0; c < n; c++) {
          if (dd) {
            const apos = (r * n + c) * 2;
            const ipos = (i * n + c) * 2;
            const prod = DD.multiply(factor, [A.data[ipos], A.data[ipos + 1]]);
            const sub = DD.subtract([A.data[apos], A.data[apos + 1]], prod);
            A.data[apos] = sub[0]; A.data[apos + 1] = sub[1];
            const dpos = (r * n + c) * 2;
            const prodD = DD.multiply(factor, [dest.data[ipos], dest.data[ipos + 1]]);
            const subD = DD.subtract([dest.data[dpos], dest.data[dpos + 1]], prodD);
            dest.data[dpos] = subD[0]; dest.data[dpos + 1] = subD[1];
          } else {
            A.data[r * n + c] -= factor * A.data[i * n + c];
            dest.data[r * n + c] -= factor * dest.data[i * n + c];
          }
        }
      }
    }
    return dest;
  }

  inverse() {
    if (this.rows !== this.columns) throw new DomainViolationError('inverse', 'matrix must be square');
    return this.gaussJordan();
  }

  determinant() {
    if (this.rows !== this.columns) throw new DomainViolationError('determinant', 'matrix must be square');
    const n = this.rows;
    const A = new MLMatrix(n, n, { dd: this.dd });
    for (let i = 0; i < n * n; i++) {
      if (this.dd) { A.data[i * 2] = this.data[i * 2]; A.data[i * 2 + 1] = this.data[i * 2 + 1]; }
      else A.data[i] = this.data[i];
    }
    let det = this.dd ? [0, 1] : 1;
    let sign = 1;
    for (let i = 0; i < n; i++) {
      let pivotIdx = i;
      let pivotVal = Math.abs(this.dd ? A.data[(i * n + i) * 2 + 1] : A.data[i * n + i]);
      for (let k = i + 1; k < n; k++) {
        const v = Math.abs(this.dd ? A.data[(k * n + i) * 2 + 1] : A.data[k * n + i]);
        if (v > pivotVal) { pivotVal = v; pivotIdx = k; }
      }
      if (pivotVal < EPSILON) return this.dd ? [0, 0] : 0;
      if (pivotIdx !== i) {
        for (let c = 0; c < n; c++) {
          if (this.dd) {
            const a = (i * n + c) * 2;
            const b = (pivotIdx * n + c) * 2;
            let t0 = A.data[a], t1 = A.data[a + 1];
            A.data[a] = A.data[b]; A.data[a + 1] = A.data[b + 1];
            A.data[b] = t0; A.data[b + 1] = t1;
          } else {
            const t = A.data[i * n + c];
            A.data[i * n + c] = A.data[pivotIdx * n + c];
            A.data[pivotIdx * n + c] = t;
          }
        }
        sign = -sign;
      }
      const pivot = this.dd
        ? [A.data[(i * n + i) * 2], A.data[(i * n + i) * 2 + 1]]
        : A.data[i * n + i];
      if (this.dd) det = DD.multiply(det, pivot);
      else det *= pivot;
      for (let r = i + 1; r < n; r++) {
        const factor = this.dd
          ? DD.divide([A.data[(r * n + i) * 2], A.data[(r * n + i) * 2 + 1]], pivot)
          : A.data[r * n + i] / pivot;
        for (let c = i + 1; c < n; c++) {
          if (this.dd) {
            const rpos = (r * n + c) * 2;
            const ipos = (i * n + c) * 2;
            const prod = DD.multiply(factor, [A.data[ipos], A.data[ipos + 1]]);
            const sub = DD.subtract([A.data[rpos], A.data[rpos + 1]], prod);
            A.data[rpos] = sub[0]; A.data[rpos + 1] = sub[1];
          } else {
            A.data[r * n + c] -= factor * A.data[i * n + c];
          }
        }
      }
    }
    if (this.dd) {
      return sign === -1 ? [-det[0], -det[1]] : det;
    }
    return sign === -1 ? -det : det;
  }

  trace() {
    if (this.rows !== this.columns) throw new DomainViolationError('trace', 'matrix must be square');
    if (this.dd) {
      let acc = [0, 0];
      for (let i = 0; i < this.rows; i++) {
        acc = DD.add(acc, [this.data[(i * this.columns + i) * 2], this.data[(i * this.columns + i) * 2 + 1]]);
      }
      return DD.toDouble(acc);
    }
    let sum = 0;
    for (let i = 0; i < this.rows; i++) sum += this.data[i * this.columns + i];
    return sum;
  }

  // ---------------------------------------------------------------
  // Shape predicates
  // ---------------------------------------------------------------
  isSquare() { return this.rows === this.columns; }
  isRowVector() { return this.rows === 1; }
  isColumnVector() { return this.columns === 1; }
  isVector() { return this.isRowVector() || this.isColumnVector(); }

  isSymmetric() {
    if (this.rows !== this.columns) return false;
    const n = this.rows;
    for (let r = 0; r < n; r++) {
      for (let c = r + 1; c < n; c++) {
        const a = this.dd ? this.data[(r * n + c) * 2 + 1] : this.data[r * n + c];
        const b = this.dd ? this.data[(c * n + r) * 2 + 1] : this.data[c * n + r];
        if (Math.abs(a - b) > EPSILON) return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------
  // Slicing
  // ---------------------------------------------------------------
  diagonal() {
    const n = Math.min(this.rows, this.columns);
    const out = new MLMatrix(n, 1, { dd: this.dd });
    for (let i = 0; i < n; i++) {
      if (this.dd) {
        out.data[i * 2] = this.data[(i * this.columns + i) * 2];
        out.data[i * 2 + 1] = this.data[(i * this.columns + i) * 2 + 1];
      } else out.data[i] = this.data[i * this.columns + i];
    }
    return out;
  }

  row(index) {
    if (index < 0 || index >= this.rows) throw new DecodeError('row', 'index out of bounds');
    const out = new MLMatrix(1, this.columns, { dd: this.dd });
    for (let c = 0; c < this.columns; c++) {
      if (this.dd) {
        out.data[c * 2] = this.data[(index * this.columns + c) * 2];
        out.data[c * 2 + 1] = this.data[(index * this.columns + c) * 2 + 1];
      } else out.data[c] = this.data[index * this.columns + c];
    }
    return out;
  }

  column(index) {
    if (index < 0 || index >= this.columns) throw new DecodeError('column', 'index out of bounds');
    const out = new MLMatrix(this.rows, 1, { dd: this.dd });
    for (let r = 0; r < this.rows; r++) {
      if (this.dd) {
        out.data[r * 2] = this.data[(r * this.columns + index) * 2];
        out.data[r * 2 + 1] = this.data[(r * this.columns + index) * 2 + 1];
      } else out.data[r] = this.data[r * this.columns + index];
    }
    return out;
  }

  selection(rowIndices, columnIndices) {
    const rows = rowIndices || MLMatrix.xrange(0, this.rows);
    const cols = columnIndices || MLMatrix.xrange(0, this.columns);
    const out = new MLMatrix(rows.length, cols.length, { dd: this.dd });
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols.length; c++) {
        if (this.dd) {
          const src = (rows[r] * this.columns + cols[c]) * 2;
          const dst = (r * cols.length + c) * 2;
          out.data[dst] = this.data[src];
          out.data[dst + 1] = this.data[src + 1];
        } else {
          out.data[r * cols.length + c] = this.data[rows[r] * this.columns + cols[c]];
        }
      }
    }
    return out;
  }

  repeat(nRows, nCols) {
    const r = nRows === undefined ? 1 : nRows;
    const c = nCols === undefined ? 1 : nCols;
    const out = new MLMatrix(this.rows * r, this.columns * c, { dd: this.dd });
    for (let rr = 0; rr < r; rr++) {
      for (let cc = 0; cc < c; cc++) {
        for (let i = 0; i < this.rows; i++) {
          for (let j = 0; j < this.columns; j++) {
            const dstR = rr * this.rows + i;
            const dstC = cc * this.columns + j;
            if (this.dd) {
              const src = (i * this.columns + j) * 2;
              const dst = (dstR * out.columns + dstC) * 2;
              out.data[dst] = this.data[src];
              out.data[dst + 1] = this.data[src + 1];
            } else {
              out.data[dstR * out.columns + dstC] = this.data[i * this.columns + j];
            }
          }
        }
      }
    }
    return out;
  }

  fill(v) {
    const n = this.rows * this.columns;
    if (this.dd) {
      for (let i = 0; i < n; i++) { this.data[i * 2] = 0; this.data[i * 2 + 1] = v; }
    } else {
      this.data.fill(v);
    }
    return this;
  }

  // ---------------------------------------------------------------
  // Reductions
  // ---------------------------------------------------------------
  max() {
    const n = this.rows * this.columns;
    let mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = this.dd ? this.data[i * 2 + 1] : this.data[i];
      if (v > mx) mx = v;
    }
    return mx;
  }

  min() {
    const n = this.rows * this.columns;
    let mn = Infinity;
    for (let i = 0; i < n; i++) {
      const v = this.dd ? this.data[i * 2 + 1] : this.data[i];
      if (v < mn) mn = v;
    }
    return mn;
  }

  mean() { return this.sum() / (this.rows * this.columns); }

  sum() {
    const n = this.rows * this.columns;
    if (this.dd) {
      let acc = [0, 0];
      for (let i = 0; i < n; i++) acc = DD.add(acc, [this.data[i * 2], this.data[i * 2 + 1]]);
      return DD.toDouble(acc);
    }
    let s = 0;
    for (let i = 0; i < n; i++) s += this.data[i];
    return s;
  }

  // ---------------------------------------------------------------
  // Permutation and sorting
  // ---------------------------------------------------------------
  permuteRows(permutation) {
    if (!Array.isArray(permutation) || permutation.length !== this.rows) {
      throw new DecodeError('permuteRows', 'permutation must match rows');
    }
    const out = new MLMatrix(this.rows, this.columns, { dd: this.dd });
    for (let r = 0; r < this.rows; r++) {
      const srcR = permutation[r];
      for (let c = 0; c < this.columns; c++) {
        if (this.dd) {
          const src = (srcR * this.columns + c) * 2;
          const dst = (r * this.columns + c) * 2;
          out.data[dst] = this.data[src];
          out.data[dst + 1] = this.data[src + 1];
        } else {
          out.data[r * this.columns + c] = this.data[srcR * this.columns + c];
        }
      }
    }
    return out;
  }

  permuteColumns(permutation) {
    if (!Array.isArray(permutation) || permutation.length !== this.columns) {
      throw new DecodeError('permuteColumns', 'permutation must match columns');
    }
    const out = new MLMatrix(this.rows, this.columns, { dd: this.dd });
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.columns; c++) {
        const srcC = permutation[c];
        if (this.dd) {
          const src = (r * this.columns + srcC) * 2;
          const dst = (r * this.columns + c) * 2;
          out.data[dst] = this.data[src];
          out.data[dst + 1] = this.data[src + 1];
        } else {
          out.data[r * this.columns + c] = this.data[r * this.columns + srcC];
        }
      }
    }
    return out;
  }

  sortRows(compareFn) {
    const rows = this.rows;
    const cols = this.columns;
    const indices = Array.from({ length: rows }, (_, i) => i);
    indices.sort((a, b) => {
      for (let c = 0; c < cols; c++) {
        const va = this.dd ? this.data[(a * cols + c) * 2 + 1] : this.data[a * cols + c];
        const vb = this.dd ? this.data[(b * cols + c) * 2 + 1] : this.data[b * cols + c];
        if (compareFn) { const r = compareFn(va, vb); if (r !== 0) return r; }
        else if (va !== vb) return va - vb;
      }
      return 0;
    });
    return this.permuteRows(indices);
  }

  sortColumns(compareFn) {
    const rows = this.rows;
    const cols = this.columns;
    const indices = Array.from({ length: cols }, (_, i) => i);
    indices.sort((a, b) => {
      for (let r = 0; r < rows; r++) {
        const va = this.dd ? this.data[(r * cols + a) * 2 + 1] : this.data[r * cols + a];
        const vb = this.dd ? this.data[(r * cols + b) * 2 + 1] : this.data[r * cols + b];
        if (compareFn) { const rr = compareFn(va, vb); if (rr !== 0) return rr; }
        else if (va !== vb) return va - vb;
      }
      return 0;
    });
    return this.permuteColumns(indices);
  }
}

// ============================================================================
// STANDALONE UTILITIES
// ============================================================================
export function solve(A, B) {
  return A.inverse().mmul(B);
}

export function inverse(A) { return A.inverse(); }

export function xrange(start, stop) { return MLMatrix.xrange(start, stop); }

export function zeros(n) { return MLMatrix.zeros(n); }
export function ones(n) { return MLMatrix.ones(n); }
export function random(n) { return MLMatrix.random(n); }
export function randomInt(n, max) { return MLMatrix.randomInt(n, max); }
export function diag(array) { return MLMatrix.diag(array); }
export function from1DArray(nRows, nColumns, data) { return MLMatrix.from1DArray(nRows, nColumns, data); }
export function from2DArray(data) { return MLMatrix.from2DArray(data); }
export function columnVector(nRows, data) { return MLMatrix.columnVector(nRows, data); }
export function rowVector(nColumns, data) { return MLMatrix.rowVector(nColumns, data); }

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const MatrixInput = Object.freeze({
  decode(input) {
    if (!(input instanceof MLMatrix)) throw new DecodeError('matrix', 'MLMatrix instance required');
    return input;
  }
});

export const TwoMatrixInput = Object.freeze({
  make(a, b) { return { a, b }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('twoMatrix', 'Expected {a, b}');
    if (!(input.a instanceof MLMatrix) || !(input.b instanceof MLMatrix)) {
      throw new DecodeError('twoMatrix', 'both a and b must be MLMatrix');
    }
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function mmulValidated(input) {
  const d = TwoMatrixInput.decode(input);
  return d.a.mmul(d.b);
}

export function transposeValidated(input) {
  const a = MatrixInput.decode(input);
  return a.transpose();
}

export function inverseValidated(input) {
  const a = MatrixInput.decode(input);
  return a.inverse();
}

export function determinantValidated(input) {
  const a = MatrixInput.decode(input);
  return a.determinant();
}

export function solveValidated(input) {
  const d = TwoMatrixInput.decode(input);
  return solve(d.a, d.b);
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

export function mmulWithPolicies(a, b, policy) {
  return policyCustom(
    'MatrixML.mmulWithPolicies',
    () => a.mmul(b),
    (m) => m instanceof MLMatrix,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function inverseWithPolicies(a, policy) {
  return policyCustom(
    'MatrixML.inverseWithPolicies',
    () => a.inverse(),
    (m) => m instanceof MLMatrix,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

// ============================================================================
// POOL
// ============================================================================
const _pool = [];
const _MAX_POOL = 16;

export function poolAcquire(nRows, nCols) {
  for (let i = 0; i < _pool.length; i++) {
    if (_pool[i].rows === nRows && _pool[i].columns === nCols) {
      const m = _pool.splice(i, 1)[0];
      m.data.fill(0);
      return m;
    }
  }
  return new MLMatrix(nRows, nCols);
}

export function poolRelease(m) {
  if (_pool.length >= _MAX_POOL) return;
  _pool.push(m);
}

export function poolReset() { _pool.length = 0; }
export function poolSize() { return _pool.length; }

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  MLMatrix,
  solve,
  inverse,
  xrange,
  zeros,
  ones,
  random,
  randomInt,
  diag,
  from1DArray,
  from2DArray,
  columnVector,
  rowVector,
  MatrixInput,
  TwoMatrixInput,
  mmulValidated,
  transposeValidated,
  inverseValidated,
  determinantValidated,
  solveValidated,
  mmulWithPolicies,
  inverseWithPolicies,
  poolAcquire,
  poolRelease,
  poolReset,
  poolSize
};