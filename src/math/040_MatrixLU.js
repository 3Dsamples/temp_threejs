// file number : 040
// full path name : src/math/040_MatrixLU.js
// description : High-performance LU decomposition (partial pivoting) reimplemented from mljs/matrix dc/lu.js. Works directly on the flat typed array backing of MLMatrix (038) for cache-friendly inner loops. Provides L and U triangular factors, pivot vector, pivot sign, determinant, singular check, and multi-RHS solve. Supports DoubleDouble precision, policy-aware wrappers via 030_Policy, and schema validators.
// best for : Physics constraint solving, PBR linear systems, camera calibration, ML regression, galactic-scale dense solves, and any LU-based pipeline in the ECS on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as ML from './038_MatrixML.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'LUDecompositionDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'LUDecompositionDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function checkMatrix(m, op) {
  if (!(m instanceof ML.MLMatrix)) throw new DecodeError(op, 'MLMatrix instance required');
}

// ============================================================================
// LU DECOMPOSITION
// ============================================================================
export class LuDecomposition {
  constructor(matrix) {
    checkMatrix(matrix, 'LuDecomposition');
    const lu = matrix.clone();
    const rows = lu.rows;
    const columns = lu.columns;
    const dd = lu.dd;
    const pivotVector = new Int32Array(rows);
    let pivotSign = 1;

    for (let i = 0; i < rows; i++) pivotVector[i] = i;

    if (!dd) {
      const data = lu.data;
      const luColj = new ARRAY_TYPE(rows);
      for (let j = 0; j < columns; j++) {
        for (let i = 0; i < rows; i++) luColj[i] = data[i * columns + j];
        for (let i = 0; i < rows; i++) {
          const kmax = Math.min(i, j);
          let s = 0;
          for (let k = 0; k < kmax; k++) s += data[i * columns + k] * luColj[k];
          luColj[i] -= s;
          data[i * columns + j] = luColj[i];
        }
        let p = j;
        for (let i = j + 1; i < rows; i++) {
          if (Math.abs(luColj[i]) > Math.abs(luColj[p])) p = i;
        }
        if (p !== j) {
          for (let k = 0; k < columns; k++) {
            const t = data[p * columns + k];
            data[p * columns + k] = data[j * columns + k];
            data[j * columns + k] = t;
          }
          const v = pivotVector[p];
          pivotVector[p] = pivotVector[j];
          pivotVector[j] = v;
          pivotSign = -pivotSign;
        }
        if (j < rows && data[j * columns + j] !== 0) {
          for (let i = j + 1; i < rows; i++) {
            data[i * columns + j] /= data[j * columns + j];
          }
        }
      }
    } else {
      const luColj = new ARRAY_TYPE(rows * 2);
      for (let j = 0; j < columns; j++) {
        for (let i = 0; i < rows; i++) {
          const pos = (i * columns + j) * 2;
          luColj[i * 2] = lu.data[pos];
          luColj[i * 2 + 1] = lu.data[pos + 1];
        }
        for (let i = 0; i < rows; i++) {
          const kmax = Math.min(i, j);
          let s = [0, 0];
          for (let k = 0; k < kmax; k++) {
            const a = [lu.data[(i * columns + k) * 2], lu.data[(i * columns + k) * 2 + 1]];
            const b = [luColj[k * 2], luColj[k * 2 + 1]];
            s = DD.add(s, DD.multiply(a, b));
          }
          const sub = DD.subtract([luColj[i * 2], luColj[i * 2 + 1]], s);
          luColj[i * 2] = sub[0];
          luColj[i * 2 + 1] = sub[1];
          const pos = (i * columns + j) * 2;
          lu.data[pos] = sub[0];
          lu.data[pos + 1] = sub[1];
        }
        let p = j;
        for (let i = j + 1; i < rows; i++) {
          if (Math.abs(luColj[i * 2 + 1]) > Math.abs(luColj[p * 2 + 1])) p = i;
        }
        if (p !== j) {
          for (let k = 0; k < columns; k++) {
            const a = (p * columns + k) * 2;
            const b = (j * columns + k) * 2;
            let t0 = lu.data[a], t1 = lu.data[a + 1];
            lu.data[a] = lu.data[b]; lu.data[a + 1] = lu.data[b + 1];
            lu.data[b] = t0; lu.data[b + 1] = t1;
          }
          const v = pivotVector[p];
          pivotVector[p] = pivotVector[j];
          pivotVector[j] = v;
          pivotSign = -pivotSign;
        }
        const pivotPos = (j * columns + j) * 2;
        if (j < rows && lu.data[pivotPos + 1] !== 0) {
          for (let i = j + 1; i < rows; i++) {
            const pos = (i * columns + j) * 2;
            const div = DD.divide(
              [lu.data[pos], lu.data[pos + 1]],
              [lu.data[pivotPos], lu.data[pivotPos + 1]]
            );
            lu.data[pos] = div[0];
            lu.data[pos + 1] = div[1];
          }
        }
      }
    }

    this.LU = lu;
    this.pivotVector = pivotVector;
    this.pivotSign = pivotSign;
  }

  isSingular() {
    const data = this.LU;
    const col = data.columns;
    if (data.dd) {
      for (let j = 0; j < col; j++) {
        if (data.data[(j * col + j) * 2 + 1] === 0) return true;
      }
    } else {
      for (let j = 0; j < col; j++) {
        if (data.data[j * col + j] === 0) return true;
      }
    }
    return false;
  }

  solve(value) {
    checkMatrix(value, 'solve');
    const lu = this.LU;
    const rows = lu.rows;
    if (rows !== value.rows) throw new DomainViolationError('solve', 'Invalid matrix dimensions');
    if (this.isSingular()) throw new DomainViolationError('solve', 'LU matrix is singular');

    const count = value.columns;
    const X = new ML.MLMatrix(rows, count, { dd: lu.dd || value.dd });
    for (let i = 0; i < rows; i++) {
      const srcRow = this.pivotVector[i];
      for (let j = 0; j < count; j++) {
        if (lu.dd || value.dd) {
          const pos = (i * count + j) * 2;
          X.data[pos] = 0;
          X.data[pos + 1] = value.dd
            ? value.data[(srcRow * value.columns + j) * 2 + 1]
            : value.data[srcRow * value.columns + j];
        } else {
          X.data[i * count + j] = value.data[srcRow * value.columns + j];
        }
      }
    }

    const columns = lu.columns;
    if (!lu.dd && !X.dd) {
      for (let k = 0; k < columns; k++) {
        for (let i = k + 1; i < columns; i++) {
          const factor = lu.data[i * columns + k];
          if (factor === 0) continue;
          for (let j = 0; j < count; j++) {
            X.data[i * count + j] -= X.data[k * count + j] * factor;
          }
        }
      }
      for (let k = columns - 1; k >= 0; k--) {
        const pivot = lu.data[k * columns + k];
        for (let j = 0; j < count; j++) X.data[k * count + j] /= pivot;
        for (let i = 0; i < k; i++) {
          const factor = lu.data[i * columns + k];
          if (factor === 0) continue;
          for (let j = 0; j < count; j++) {
            X.data[i * count + j] -= X.data[k * count + j] * factor;
          }
        }
      }
    } else {
      for (let k = 0; k < columns; k++) {
        for (let i = k + 1; i < columns; i++) {
          const fpos = (i * columns + k) * 2;
          const factor = [lu.data[fpos], lu.data[fpos + 1]];
          for (let j = 0; j < count; j++) {
            const xpos = (k * count + j) * 2;
            const ipos = (i * count + j) * 2;
            const prod = DD.multiply(factor, [X.data[xpos], X.data[xpos + 1]]);
            const sub = DD.subtract([X.data[ipos], X.data[ipos + 1]], prod);
            X.data[ipos] = sub[0];
            X.data[ipos + 1] = sub[1];
          }
        }
      }
      for (let k = columns - 1; k >= 0; k--) {
        const ppos = (k * columns + k) * 2;
        const pivot = [lu.data[ppos], lu.data[ppos + 1]];
        for (let j = 0; j < count; j++) {
          const pos = (k * count + j) * 2;
          const div = DD.divide([X.data[pos], X.data[pos + 1]], pivot);
          X.data[pos] = div[0];
          X.data[pos + 1] = div[1];
        }
        for (let i = 0; i < k; i++) {
          const fpos = (i * columns + k) * 2;
          const factor = [lu.data[fpos], lu.data[fpos + 1]];
          for (let j = 0; j < count; j++) {
            const xpos = (k * count + j) * 2;
            const ipos = (i * count + j) * 2;
            const prod = DD.multiply(factor, [X.data[xpos], X.data[xpos + 1]]);
            const sub = DD.subtract([X.data[ipos], X.data[ipos + 1]], prod);
            X.data[ipos] = sub[0];
            X.data[ipos + 1] = sub[1];
          }
        }
      }
    }
    return X;
  }

  get determinant() {
    const data = this.LU;
    if (!data.isSquare()) throw new DomainViolationError('determinant', 'Matrix must be square');
    if (data.dd) {
      let det = [0, this.pivotSign];
      const col = data.columns;
      for (let j = 0; j < col; j++) {
        det = DD.multiply(det, [data.data[(j * col + j) * 2], data.data[(j * col + j) * 2 + 1]]);
      }
      return DD.toDouble(det);
    }
    let det = this.pivotSign;
    const col = data.columns;
    for (let j = 0; j < col; j++) det *= data.data[j * col + j];
    return det;
  }

  get lowerTriangularMatrix() {
    const data = this.LU;
    const rows = data.rows;
    const columns = data.columns;
    const X = new ML.MLMatrix(rows, columns, { dd: data.dd });
    if (data.dd) {
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < columns; j++) {
          const pos = (i * columns + j) * 2;
          if (i > j) {
            X.data[pos] = data.data[pos];
            X.data[pos + 1] = data.data[pos + 1];
          } else if (i === j) {
            X.data[pos + 1] = 1;
          }
        }
      }
    } else {
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < columns; j++) {
          if (i > j) X.data[i * columns + j] = data.data[i * columns + j];
          else if (i === j) X.data[i * columns + j] = 1;
        }
      }
    }
    return X;
  }

  get upperTriangularMatrix() {
    const data = this.LU;
    const rows = data.rows;
    const columns = data.columns;
    const X = new ML.MLMatrix(rows, columns, { dd: data.dd });
    if (data.dd) {
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < columns; j++) {
          if (i <= j) {
            const pos = (i * columns + j) * 2;
            X.data[pos] = data.data[pos];
            X.data[pos + 1] = data.data[pos + 1];
          }
        }
      }
    } else {
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < columns; j++) {
          if (i <= j) X.data[i * columns + j] = data.data[i * columns + j];
        }
      }
    }
    return X;
  }

  get pivotPermutationVector() {
    return Array.from(this.pivotVector);
  }
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const LUInput = Object.freeze({
  make(matrix) { return { matrix }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('lu', 'Expected {matrix}');
    checkMatrix(input.matrix, 'lu');
    return input;
  }
});

export const LUSolveInput = Object.freeze({
  make(decomposition, value) { return { decomposition, value }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('luSolve', 'Expected {decomposition, value}');
    if (!(input.decomposition instanceof LuDecomposition)) {
      throw new DecodeError('luSolve', 'LuDecomposition instance required');
    }
    checkMatrix(input.value, 'luSolve');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function luDecomposeValidated(input) {
  const d = LUInput.decode(input);
  return new LuDecomposition(d.matrix);
}

export function luSolveValidated(input) {
  const d = LUSolveInput.decode(input);
  return d.decomposition.solve(d.value);
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

export function luDecomposeWithPolicies(matrix, policy) {
  return policyCustom(
    'MatrixLU.luDecomposeWithPolicies',
    () => new LuDecomposition(matrix),
    (d) => d instanceof LuDecomposition,
    (d) => ({ rows: d.LU.rows, columns: d.LU.columns }),
    policy
  );
}

export function luSolveWithPolicies(decomposition, value, policy) {
  return policyCustom(
    'MatrixLU.luSolveWithPolicies',
    () => decomposition.solve(value),
    (m) => m instanceof ML.MLMatrix,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  LuDecomposition,
  LUInput,
  LUSolveInput,
  luDecomposeValidated,
  luSolveValidated,
  luDecomposeWithPolicies,
  luSolveWithPolicies
};