// file number : 041
// full path name : src/math/041_MatrixQR.js
// description : High-performance QR decomposition (Householder) reimplemented from mljs/matrix dc/qr.js. Works directly on the flat typed array backing of MLMatrix (038) with cache-friendly inner loops. Provides Q and R factors, solve, full-rank check, and rank-deficient detection. Supports DoubleDouble precision, policy-aware wrappers via 030_Policy, and schema validators. Uses the stable `hypotenuse` helper from 047_MatrixDCUtil.
// best for : Least-squares regression, ML feature reduction, PBR model fitting, physics constraint Jacobians, and any QR-based pipeline in the ECS on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as ML from './038_MatrixML.js';
import * as DCUtil from './047_MatrixDCUtil.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'QRDecompositionDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'QRDecompositionDomainViolationError';
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
// QR DECOMPOSITION
// ============================================================================
export class QrDecomposition {
  constructor(value) {
    checkMatrix(value, 'QrDecomposition');
    const qr = value.clone();
    const m = value.rows;
    const n = value.columns;
    const dd = qr.dd;
    const rdiag = new ARRAY_TYPE(n);

    if (!dd) {
      const data = qr.data;
      for (let k = 0; k < n; k++) {
        let nrm = 0;
        for (let i = k; i < m; i++) nrm = DCUtil.hypotenuse(nrm, data[i * n + k]);
        if (nrm !== 0) {
          if (data[k * n + k] < 0) nrm = -nrm;
          for (let i = k; i < m; i++) data[i * n + k] /= nrm;
          data[k * n + k] += 1;
          for (let j = k + 1; j < n; j++) {
            let s = 0;
            for (let i = k; i < m; i++) s += data[i * n + k] * data[i * n + j];
            s = -s / data[k * n + k];
            for (let i = k; i < m; i++) data[i * n + j] += s * data[i * n + k];
          }
        }
        rdiag[k] = -nrm;
      }
    } else {
      const data = qr.data;
      for (let k = 0; k < n; k++) {
        let nrm = 0;
        for (let i = k; i < m; i++) {
          const pos = (i * n + k) * 2;
          nrm = DCUtil.hypotenuse(nrm, data[pos + 1]);
        }
        if (nrm !== 0) {
          const kkPos = (k * n + k) * 2;
          if (data[kkPos + 1] < 0) nrm = -nrm;
          for (let i = k; i < m; i++) {
            const pos = (i * n + k) * 2;
            data[pos + 1] /= nrm;
          }
          data[kkPos + 1] += 1;
          for (let j = k + 1; j < n; j++) {
            let s = 0;
            for (let i = k; i < m; i++) {
              const a = (i * n + k) * 2;
              const b = (i * n + j) * 2;
              s += data[a + 1] * data[b + 1];
            }
            s = -s / data[kkPos + 1];
            for (let i = k; i < m; i++) {
              const a = (i * n + k) * 2;
              const b = (i * n + j) * 2;
              data[b + 1] += s * data[a + 1];
            }
          }
        }
        rdiag[k] = -nrm;
      }
    }

    this.QR = qr;
    this.Rdiag = rdiag;
  }

  solve(value) {
    checkMatrix(value, 'solve');
    const qr = this.QR;
    const m = qr.rows;
    if (value.rows !== m) throw new DomainViolationError('solve', 'Matrix row dimensions must agree');
    if (!this.isFullRank()) throw new DomainViolationError('solve', 'Matrix is rank deficient');

    const count = value.columns;
    const X = value.clone();
    const n = qr.columns;
    const dd = qr.dd || X.dd;

    if (!dd) {
      const qrData = qr.data;
      const xData = X.data;
      for (let k = 0; k < n; k++) {
        for (let j = 0; j < count; j++) {
          let s = 0;
          for (let i = k; i < m; i++) s += qrData[i * n + k] * xData[i * count + j];
          s = -s / qrData[k * n + k];
          for (let i = k; i < m; i++) xData[i * count + j] += s * qrData[i * n + k];
        }
      }
      for (let k = n - 1; k >= 0; k--) {
        for (let j = 0; j < count; j++) xData[k * count + j] /= this.Rdiag[k];
        for (let i = 0; i < k; i++) {
          const factor = qrData[i * n + k];
          if (factor === 0) continue;
          for (let j = 0; j < count; j++) xData[i * count + j] -= xData[k * count + j] * factor;
        }
      }
      return X.selection(ML.MLMatrix.xrange(0, n), ML.MLMatrix.xrange(0, count));
    }

    const qrData = qr.data;
    const xData = X.data;
    for (let k = 0; k < n; k++) {
      const kkPos = (k * n + k) * 2;
      for (let j = 0; j < count; j++) {
        let s = [0, 0];
        for (let i = k; i < m; i++) {
          const a = (i * n + k) * 2;
          const b = (i * count + j) * 2;
          s = DD.add(s, DD.multiply([qrData[a], qrData[a + 1]], [xData[b], xData[b + 1]]));
        }
        const div = DD.divide(s, [qrData[kkPos], qrData[kkPos + 1]]);
        const sNeg = DD.negate(div);
        for (let i = k; i < m; i++) {
          const a = (i * n + k) * 2;
          const b = (i * count + j) * 2;
          const prod = DD.multiply(sNeg, [qrData[a], qrData[a + 1]]);
          const sum = DD.add([xData[b], xData[b + 1]], prod);
          xData[b] = sum[0];
          xData[b + 1] = sum[1];
        }
      }
    }
    for (let k = n - 1; k >= 0; k--) {
      const rdiagDD = DD.fromDouble(this.Rdiag[k]);
      for (let j = 0; j < count; j++) {
        const b = (k * count + j) * 2;
        const div = DD.divide([xData[b], xData[b + 1]], rdiagDD);
        xData[b] = div[0];
        xData[b + 1] = div[1];
      }
      for (let i = 0; i < k; i++) {
        const fpos = (i * n + k) * 2;
        const factor = [qrData[fpos], qrData[fpos + 1]];
        for (let j = 0; j < count; j++) {
          const kpos = (k * count + j) * 2;
          const ipos = (i * count + j) * 2;
          const prod = DD.multiply(factor, [xData[kpos], xData[kpos + 1]]);
          const sub = DD.subtract([xData[ipos], xData[ipos + 1]], prod);
          xData[ipos] = sub[0];
          xData[ipos + 1] = sub[1];
        }
      }
    }
    return X.selection(ML.MLMatrix.xrange(0, n), ML.MLMatrix.xrange(0, count));
  }

  isFullRank() {
    const columns = this.QR.columns;
    for (let i = 0; i < columns; i++) {
      if (this.Rdiag[i] === 0) return false;
    }
    return true;
  }

  get upperTriangularMatrix() {
    const qr = this.QR;
    const n = qr.columns;
    const X = new ML.MLMatrix(n, n, { dd: qr.dd });
    if (qr.dd) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i < j) {
            const pos = (i * n + j) * 2;
            X.data[pos] = qr.data[pos];
            X.data[pos + 1] = qr.data[pos + 1];
          } else if (i === j) {
            const pos = (i * n + j) * 2;
            X.data[pos + 1] = this.Rdiag[i];
          }
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i < j) X.data[i * n + j] = qr.data[i * n + j];
          else if (i === j) X.data[i * n + j] = this.Rdiag[i];
        }
      }
    }
    return X;
  }

  get orthogonalMatrix() {
    const qr = this.QR;
    const rows = qr.rows;
    const columns = qr.columns;
    const X = new ML.MLMatrix(rows, columns, { dd: qr.dd });
    if (qr.dd) {
      for (let k = columns - 1; k >= 0; k--) {
        for (let i = 0; i < rows; i++) {
          X.data[(i * columns + k) * 2] = 0;
          X.data[(i * columns + k) * 2 + 1] = 0;
        }
        X.data[(k * columns + k) * 2 + 1] = 1;
        for (let j = k; j < columns; j++) {
          if (qr.data[(k * columns + k) * 2 + 1] !== 0) {
            let s = 0;
            for (let i = k; i < rows; i++) {
              const a = (i * columns + k) * 2;
              const b = (i * columns + j) * 2;
              s += qr.data[a + 1] * qr.data[b + 1];
            }
            s = -s / qr.data[(k * columns + k) * 2 + 1];
            for (let i = k; i < rows; i++) {
              const a = (i * columns + k) * 2;
              const b = (i * columns + j) * 2;
              X.data[b + 1] += s * qr.data[a + 1];
            }
          }
        }
      }
    } else {
      for (let k = columns - 1; k >= 0; k--) {
        for (let i = 0; i < rows; i++) X.data[i * columns + k] = 0;
        X.data[k * columns + k] = 1;
        for (let j = k; j < columns; j++) {
          if (qr.data[k * columns + k] !== 0) {
            let s = 0;
            for (let i = k; i < rows; i++) s += qr.data[i * columns + k] * qr.data[i * columns + j];
            s = -s / qr.data[k * columns + k];
            for (let i = k; i < rows; i++) X.data[i * columns + j] += s * qr.data[i * columns + k];
          }
        }
      }
    }
    return X;
  }
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const QRInput = Object.freeze({
  make(matrix) { return { matrix }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('qr', 'Expected {matrix}');
    checkMatrix(input.matrix, 'qr');
    return input;
  }
});

export const QRSolveInput = Object.freeze({
  make(decomposition, value) { return { decomposition, value }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('qrSolve', 'Expected {decomposition, value}');
    if (!(input.decomposition instanceof QrDecomposition)) {
      throw new DecodeError('qrSolve', 'QrDecomposition instance required');
    }
    checkMatrix(input.value, 'qrSolve');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function qrDecomposeValidated(input) {
  const d = QRInput.decode(input);
  return new QrDecomposition(d.matrix);
}

export function qrSolveValidated(input) {
  const d = QRSolveInput.decode(input);
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

export function qrDecomposeWithPolicies(matrix, policy) {
  return policyCustom(
    'MatrixQR.qrDecomposeWithPolicies',
    () => new QrDecomposition(matrix),
    (d) => d instanceof QrDecomposition,
    (d) => ({ rows: d.QR.rows, columns: d.QR.columns }),
    policy
  );
}

export function qrSolveWithPolicies(decomposition, value, policy) {
  return policyCustom(
    'MatrixQR.qrSolveWithPolicies',
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
  QrDecomposition,
  QRInput,
  QRSolveInput,
  qrDecomposeValidated,
  qrSolveValidated,
  qrDecomposeWithPolicies,
  qrSolveWithPolicies
};