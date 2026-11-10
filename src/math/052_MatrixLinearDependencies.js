// file number : 052
// full path name : src/math/052_MatrixLinearDependencies.js
// description : High-performance recursive linear-dependency analysis reimplemented from mljs/matrix linear-dependencies.js. For each column i of the input matrix A (n × m), determines whether column i is a linear combination of columns 0..i-1, and if so, records the coefficients in row i of a lower-triangular output matrix B. Uses QR-based least squares when the leading sub-matrix is full rank, and SVD-based pseudo-inverse otherwise (or when A.columns > A.rows). Supports DoubleDouble precision, configurable tolerance, detailed diagnostics (rank, independent columns, residuals), policy-aware wrappers via 030_Policy, and schema validators. Designed for cache-friendly flat typed array access on MLMatrix (038) with reuse of the engine's QR (041), SVD (042), and pseudo-inverse (051) primitives.
// best for : Feature redundancy detection, PBR parameter collinearity analysis, physics constraint rank analysis, ML feature selection, camera calibration degeneracy detection, procedural scatter validation, and any linear-dependency analysis at 10k+ entity scale on Android 64-bit.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as ML from './038_MatrixML.js';
import * as QR from './041_MatrixQR.js';
import * as SVD from './042_MatrixSVD.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'LinearDependenciesDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'LinearDependenciesDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function checkMatrix(m, op) {
  if (!(m instanceof ML.MLMatrix)) throw new DecodeError(op, 'MLMatrix instance required');
}

// Read one element of MLMatrix into float64 (promoting dd hi)
function read(m, r, c) {
  return m.dd ? m.data[(r * m.columns + c) * 2 + 1] : m.data[r * m.columns + c];
}

// ============================================================================
// CORE: LINEAR DEPENDENCIES (columns) → lower-triangular coefficient matrix
// ============================================================================
export function linearDependencies(A, options) {
  checkMatrix(A, 'linearDependencies');
  const opts = options || {};
  const tol = opts.tolerance !== undefined ? opts.tolerance : 1e-10;
  const useSVD = opts.useSVD === true;
  const useDD = A.dd || opts.dd === true;
  if (tol <= 0) throw new DomainViolationError('linearDependencies', 'tolerance must be positive');

  const n = A.rows;
  const m = A.columns;

  // Output B: m × m lower triangular with diagonal 1
  const B = new ML.MLMatrix(m, m, { dd: useDD });
  for (let i = 0; i < m; i++) {
    if (useDD) B.data[(i * m + i) * 2 + 1] = 1;
    else B.data[i * m + i] = 1;
  }

  if (m <= 1 || n === 0) return B;

  // Cache full data into flat float64 array for cache-friendly access
  const flat = new ARRAY_TYPE(n * m);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) {
      flat[r * m + c] = read(A, r, c);
    }
  }

  // Reusable scratch buffers (avoid re-allocation per i)
  let colsBuf = new ARRAY_TYPE(n * m);
  let colIBuf = new ARRAY_TYPE(n);

  for (let i = 1; i < m; i++) {
    // Copy first i columns of A into cols (n × i) flat buffer
    for (let r = 0; r < n; r++) {
      const srcRow = r * m;
      const dstRow = r * i;
      for (let c = 0; c < i; c++) {
        colsBuf[dstRow + c] = flat[srcRow + c];
      }
    }

    // Copy column i into colI (n)
    for (let r = 0; r < n; r++) {
      colIBuf[r] = flat[r * m + i];
    }

    // Check colI norm; zero column is trivially dependent (coefs = 0)
    let colINormSq = 0;
    for (let r = 0; r < n; r++) colINormSq += colIBuf[r] * colIBuf[r];
    if (colINormSq < tol * tol) continue;

    // Build MLMatrix from flat buffer (row-major, n rows × i cols)
    const cols = new ML.MLMatrix(n, i, { dd: useDD });
    if (useDD) {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < i; c++) {
          const dst = (r * i + c) * 2;
          cols.data[dst] = 0;
          cols.data[dst + 1] = colsBuf[r * i + c];
        }
      }
    } else {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < i; c++) {
          cols.data[r * i + c] = colsBuf[r * i + c];
        }
      }
    }

    const colI = new ML.MLMatrix(n, 1, { dd: useDD });
    if (useDD) {
      for (let r = 0; r < n; r++) {
        colI.data[r * 2] = 0;
        colI.data[r * 2 + 1] = colIBuf[r];
      }
    } else {
      for (let r = 0; r < n; r++) colI.data[r] = colIBuf[r];
    }

    // Least-squares solve
    let x = null;
    try {
      if (useSVD || i > n) {
        const svd = new SVD.SingularValueDecomposition(cols);
        x = svd.solve(colI);
      } else {
        const qr = new QR.QrDecomposition(cols);
        if (qr.isFullRank()) {
          x = qr.solve(colI);
        } else {
          const svd = new SVD.SingularValueDecomposition(cols);
          x = svd.solve(colI);
        }
      }
    } catch (e) {
      continue;
    }
    if (!x) continue;

    // Compute residual ||cols · x - colI||
    let residualSq = 0;
    for (let r = 0; r < n; r++) {
      let predicted = 0;
      const colsRow = r * i;
      for (let c = 0; c < i; c++) {
        const xc = useDD || x.dd ? x.data[c * 2 + 1] : x.data[c];
        predicted += colsBuf[colsRow + c] * xc;
      }
      const diff = predicted - colIBuf[r];
      residualSq += diff * diff;
    }
    const colINorm = Math.sqrt(colINormSq);
    const residual = Math.sqrt(residualSq);

    // If relative residual < tolerance, column i is dependent
    if (residual / colINorm < tol) {
      for (let c = 0; c < i; c++) {
        const coef = useDD || x.dd ? x.data[c * 2 + 1] : x.data[c];
        if (useDD) {
          B.data[(i * m + c) * 2] = 0;
          B.data[(i * m + c) * 2 + 1] = coef;
        } else {
          B.data[i * m + c] = coef;
        }
      }
    }
  }

  return B;
}

// ============================================================================
// DETAILED: return B with extra diagnostics
// ============================================================================
export function linearDependenciesDetailed(A, options) {
  checkMatrix(A, 'linearDependenciesDetailed');
  const opts = options || {};
  const tol = opts.tolerance !== undefined ? opts.tolerance : 1e-10;
  const useSVD = opts.useSVD === true;
  const useDD = A.dd || opts.dd === true;

  const n = A.rows;
  const m = A.columns;

  const B = new ML.MLMatrix(m, m, { dd: useDD });
  for (let i = 0; i < m; i++) {
    if (useDD) B.data[(i * m + i) * 2 + 1] = 1;
    else B.data[i * m + i] = 1;
  }

  const residuals = new ARRAY_TYPE(m);
  const norms = new ARRAY_TYPE(m);
  const independent = new Uint8Array(m);
  independent[0] = 1;

  if (m <= 1 || n === 0) {
    return { B, residuals, norms, independent, rank: 1, dependentColumns: [] };
  }

  const flat = new ARRAY_TYPE(n * m);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) flat[r * m + c] = read(A, r, c);
  }

  const colsBuf = new ARRAY_TYPE(n * m);

  for (let i = 1; i < m; i++) {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < i; c++) colsBuf[r * i + c] = flat[r * m + c];
    }
    let colINormSq = 0;
    for (let r = 0; r < n; r++) colINormSq += flat[r * m + i] * flat[r * m + i];
    norms[i] = Math.sqrt(colINormSq);

    if (colINormSq < tol * tol) {
      residuals[i] = 0;
      independent[i] = 0;
      continue;
    }

    const cols = new ML.MLMatrix(n, i, { dd: useDD });
    if (useDD) {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < i; c++) {
          const dst = (r * i + c) * 2;
          cols.data[dst] = 0;
          cols.data[dst + 1] = colsBuf[r * i + c];
        }
      }
    } else {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < i; c++) cols.data[r * i + c] = colsBuf[r * i + c];
      }
    }

    const colI = new ML.MLMatrix(n, 1, { dd: useDD });
    if (useDD) {
      for (let r = 0; r < n; r++) {
        colI.data[r * 2] = 0;
        colI.data[r * 2 + 1] = flat[r * m + i];
      }
    } else {
      for (let r = 0; r < n; r++) colI.data[r] = flat[r * m + i];
    }

    let x = null;
    try {
      if (useSVD || i > n) {
        const svd = new SVD.SingularValueDecomposition(cols);
        x = svd.solve(colI);
      } else {
        const qr = new QR.QrDecomposition(cols);
        if (qr.isFullRank()) x = qr.solve(colI);
        else {
          const svd = new SVD.SingularValueDecomposition(cols);
          x = svd.solve(colI);
        }
      }
    } catch (e) { /* ignore */ }

    if (!x) {
      residuals[i] = Infinity;
      independent[i] = 1;
      continue;
    }

    let residualSq = 0;
    for (let r = 0; r < n; r++) {
      let pred = 0;
      for (let c = 0; c < i; c++) {
        const coef = (useDD || x.dd) ? x.data[c * 2 + 1] : x.data[c];
        pred += colsBuf[r * i + c] * coef;
      }
      const diff = pred - flat[r * m + i];
      residualSq += diff * diff;
    }
    residuals[i] = Math.sqrt(residualSq);

    if (residuals[i] / norms[i] < tol) {
      independent[i] = 0;
      for (let c = 0; c < i; c++) {
        const coef = (useDD || x.dd) ? x.data[c * 2 + 1] : x.data[c];
        if (useDD) {
          B.data[(i * m + c) * 2] = 0;
          B.data[(i * m + c) * 2 + 1] = coef;
        } else {
          B.data[i * m + c] = coef;
        }
      }
    } else {
      independent[i] = 1;
    }
  }

  let rank = 0;
  const dependent = [];
  for (let i = 0; i < m; i++) {
    if (independent[i]) rank++;
    else if (i > 0) dependent.push(i);
  }

  return { B, residuals, norms, independent, rank, dependentColumns: dependent };
}

// ============================================================================
// RANK VIA DEPENDENCIES
// ============================================================================
export function rankViaDependencies(A, options) {
  const detailed = linearDependenciesDetailed(A, options);
  return detailed.rank;
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const LinearDependenciesInput = Object.freeze({
  make(matrix, options) { return { matrix, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('linearDependencies', 'Expected {matrix, options?}');
    checkMatrix(input.matrix, 'linearDependencies');
    if (input.options && input.options.tolerance !== undefined) {
      if (typeof input.options.tolerance !== 'number' || input.options.tolerance <= 0) {
        throw new DecodeError('linearDependencies', 'tolerance must be positive number');
      }
    }
    return input;
  }
});

export const RankViaDependenciesInput = LinearDependenciesInput;

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function linearDependenciesValidated(input) {
  const d = LinearDependenciesInput.decode(input);
  return linearDependencies(d.matrix, d.options);
}

export function linearDependenciesDetailedValidated(input) {
  const d = LinearDependenciesInput.decode(input);
  return linearDependenciesDetailed(d.matrix, d.options);
}

export function rankViaDependenciesValidated(input) {
  const d = RankViaDependenciesInput.decode(input);
  return rankViaDependencies(d.matrix, d.options);
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

function policyScalar(operation, compute, annotate, policy) {
  const pol = PolicyModule.resolvePolicy(policy);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = compute();
  if (pol.precision === PolicyModule.PrecisionMode.STRICT && typeof result === 'number' && !Number.isFinite(result)) {
    throw new DomainViolationError(operation, 'strict precision rejected non-finite result');
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

function isValidMatrixFinite(m) {
  if (!(m instanceof ML.MLMatrix)) return false;
  for (let i = 0; i < m.data.length; i++) {
    if (!Number.isFinite(m.data[i])) return false;
  }
  return true;
}

export function linearDependenciesWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixLinearDependencies.linearDependenciesWithPolicies',
    () => linearDependencies(matrix, options),
    isValidMatrixFinite,
    (m) => ({ rows: m.rows, columns: m.columns }),
    policy
  );
}

export function linearDependenciesDetailedWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixLinearDependencies.linearDependenciesDetailedWithPolicies',
    () => linearDependenciesDetailed(matrix, options),
    (r) => r && isValidMatrixFinite(r.B),
    (r) => ({ rows: r.B.rows, columns: r.B.columns, rank: r.rank }),
    policy
  );
}

export function rankViaDependenciesWithPolicies(matrix, policy, options) {
  return policyScalar(
    'MatrixLinearDependencies.rankViaDependenciesWithPolicies',
    () => rankViaDependencies(matrix, options),
    (r) => ({ rows: matrix.rows, columns: matrix.columns, rank: r }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  linearDependencies,
  linearDependenciesDetailed,
  rankViaDependencies,
  LinearDependenciesInput,
  RankViaDependenciesInput,
  linearDependenciesValidated,
  linearDependenciesDetailedValidated,
  rankViaDependenciesValidated,
  linearDependenciesWithPolicies,
  linearDependenciesDetailedWithPolicies,
  rankViaDependenciesWithPolicies
};