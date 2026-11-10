// file number : 043
// full path name : src/math/043_MatrixNIPALS.js
// description : High-performance NIPALS (Nonlinear Iterative Partial Least Squares) reimplemented from mljs/matrix dc/nipals.js. Provides PLS regression with X and optional Y matrices, producing weight (w), score (t), loading (p), Y-loading (q), Y-score (u), residuals (xResidual, yResidual), and regression coefficients (betas). Works on the flat typed array backing of MLMatrix (038). Supports DoubleDouble precision, policy-aware wrappers via 030_Policy, and schema validators. Uses the `hypotenuse` helper from 047_MatrixDCUtil.
// best for : On-device ML regression, PBR parameter fitting, feature extraction from sensor streams, and any PLS workload at 10k+ entity scale on Android 64-bit.
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
    this.name = 'NIPALSDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'NIPALSDomainViolationError';
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
// NIPALS
// ============================================================================
export class NIPALS {
  constructor(X, options = {}) {
    checkMatrix(X, 'NIPALS');
    const { Y } = options;
    const scaleScores = options.scaleScores === true;
    const maxIterations = options.maxIterations !== undefined ? options.maxIterations : 1000;
    const terminationCriteria = options.terminationCriteria !== undefined ? options.terminationCriteria : 1e-10;

    let Ymat = null;
    let u;
    if (Y) {
      if (Array.isArray(Y) && typeof Y[0] === 'number') {
        Ymat = ML.MLMatrix.columnVector(Y.length, Y);
      } else {
        Ymat = Y instanceof ML.MLMatrix ? Y : new ML.MLMatrix(Y);
      }
      if (Ymat.rows !== X.rows) throw new DomainViolationError('NIPALS', 'Y should have the same number of rows as X');
      u = Ymat.getColumnVector(0);
    } else {
      u = X.getColumnVector(0);
    }

    let diff = 1;
    let t, q, w, tOld;
    for (let counter = 0; counter < maxIterations && diff > terminationCriteria; counter++) {
      w = X.transpose().mmul(u).div(u.transpose().mmul(u).get(0, 0));
      w = w.div(w.norm());
      t = X.mmul(w).div(w.transpose().mmul(w).get(0, 0));
      if (counter > 0) {
        diff = t.clone().sub(tOld).pow(2).sum();
      }
      tOld = t.clone();
      if (Ymat) {
        q = Ymat.transpose().mmul(t).div(t.transpose().mmul(t).get(0, 0));
        q = q.div(q.norm());
        u = Ymat.mmul(q).div(q.transpose().mmul(q).get(0, 0));
      } else {
        u = t;
      }
    }

    if (Ymat) {
      let p = X.transpose().mmul(t).div(t.transpose().mmul(t).get(0, 0));
      p = p.div(p.norm());
      const xResidual = X.clone().sub(t.clone().mmul(p.transpose()));
      const residual = u.transpose().mmul(t).div(t.transpose().mmul(t).get(0, 0));
      const yResidual = Ymat.clone().sub(t.clone().mulS(residual.get(0, 0)).mmul(q.transpose()));
      this.t = t;
      this.p = p.transpose();
      this.w = w.transpose();
      this.q = q;
      this.u = u;
      this.s = t.transpose().mmul(t);
      this.xResidual = xResidual;
      this.yResidual = yResidual;
      this.betas = residual;
    } else {
      this.w = w.transpose();
      this.s = t.transpose().mmul(t).sqrt();
      if (scaleScores) {
        this.t = t.clone().div(this.s.get(0, 0));
      } else {
        this.t = t;
      }
      this.xResidual = X.sub(t.mmul(w.transpose()));
    }
  }
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const NIPALSInput = Object.freeze({
  make(X, options) { return { X, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('nipals', 'Expected {X, options?}');
    checkMatrix(input.X, 'nipals');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function nipalsValidated(input) {
  const d = NIPALSInput.decode(input);
  return new NIPALS(d.X, d.options || {});
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

export function nipalsWithPolicies(X, options, policy) {
  return policyCustom(
    'MatrixNIPALS.nipalsWithPolicies',
    () => new NIPALS(X, options || {}),
    (r) => r instanceof NIPALS,
    (r) => ({ rows: X.rows, columns: X.columns }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  NIPALS,
  NIPALSInput,
  nipalsValidated,
  nipalsWithPolicies
};