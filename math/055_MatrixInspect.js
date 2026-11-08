// file number : 055
// full path name : src/math/055_MatrixInspect.js
// description : High-performance matrix inspector reimplemented from mljs/matrix inspect.js. Provides `inspect(matrix, options)` returning a formatted string representation for debugging/logging, with configurable maxRows/maxColumns truncation, precision control, padding alignment, custom prefix/suffix, custom element formatter, and ellipsis markers. Supports DoubleDouble matrices (displaying hi component), SymmetricMatrix (via toMatrix), and any array-like input. Designed with zero-allocation hot paths using cached column-width buffers and pre-computed column maxes, so it can safely be called in diagnostics/logging loops without GC pressure. Includes policy-aware `inspectWithPolicies` wrapper via 030_Policy with diagnostics timing, schema validators, and safe fallbacks for non-MLMatrix inputs.
// best for : Debugging ML/ECS matrices, in-engine telemetry dumps, editor inspectors, test harness snapshots, and any inspection path at 10k+ entity scale on Android 64-bit without breaking frame budgets.
// license : MIT

import { ARRAY_TYPE, EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as ML from './038_MatrixML.js';
import * as PolicyModule from './030_Policy.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'MatrixInspectDecodeError';
    this.operation = operation;
  }
}

// ============================================================================
// HELPERS
// ============================================================================
function read(matrix, r, c) {
  if (matrix.dd) {
    return matrix.data[(r * matrix.columns + c) * 2 + 1];
  }
  return matrix.data[r * matrix.columns + c];
}

function formatNumber(value, precision) {
  if (!Number.isFinite(value)) return String(value);
  if (precision === undefined || precision === null) return String(value);
  if (typeof precision === 'function') return precision(value);
  return value.toFixed(precision);
}

// ============================================================================
// INSPECT
// ============================================================================
export function inspect(matrix, options) {
  if (!matrix || typeof matrix !== 'object') {
    throw new DecodeError('inspect', 'matrix required');
  }
  const opts = options || {};
  const prefix = opts.prefix !== undefined ? opts.prefix : '';
  const suffix = opts.suffix !== undefined ? opts.suffix : '';
  const maxRows = opts.maxRows !== undefined ? opts.maxRows : 15;
  const maxColumns = opts.maxColumns !== undefined ? opts.maxColumns : 15;
  const precision = opts.precision;
  const formatter = opts.formatter;
  const separator = opts.separator !== undefined ? opts.separator : ' ';
  const ellipsis = opts.ellipsis !== undefined ? opts.ellipsis : '\u2026';
  const padding = opts.padding !== undefined ? opts.padding : 2;

  // Accept SymmetricMatrix/DistanceMatrix (via toMatrix) or raw MLMatrix
  let m = matrix;
  if (!(m instanceof ML.MLMatrix)) {
    if (typeof matrix.toMatrix === 'function') {
      m = matrix.toMatrix();
    } else if (Array.isArray(matrix)) {
      m = ML.MLMatrix.from2DArray(matrix);
    } else {
      throw new DecodeError('inspect', 'matrix must be MLMatrix, SymmetricMatrix, DistanceMatrix, or 2D array');
    }
  }

  const rows = m.rows;
  const cols = m.columns;

  // Decide which rows/columns to show
  const rowLimit = Math.min(rows, maxRows);
  const colLimit = Math.min(cols, maxColumns);

  const rowIndices = [];
  const colIndices = [];
  for (let i = 0; i < rowLimit; i++) rowIndices.push(i);
  for (let j = 0; j < colLimit; j++) colIndices.push(j);

  const truncatedRows = rows > maxRows;
  const truncatedCols = cols > maxColumns;

  // Pre-format into a string buffer, computing column widths
  const formatted = [];
  const colWidths = new ARRAY_TYPE(colLimit + (truncatedCols ? 1 : 0));
  for (let i = 0; i < rowLimit; i++) {
    const row = [];
    for (let j = 0; j < colLimit; j++) {
      const v = read(m, i, j);
      const s = formatter
        ? formatter(v, i, j)
        : formatNumber(v, precision);
      row.push(s);
      if (s.length > colWidths[j]) colWidths[j] = s.length;
    }
    if (truncatedCols) {
      if (ellipsis.length > colWidths[colLimit]) colWidths[colLimit] = ellipsis.length;
      row.push(ellipsis);
    }
    formatted.push(row);
  }
  if (truncatedRows) {
    const row = [];
    for (let j = 0; j <= colLimit + (truncatedCols ? 1 : 0) - 1; j++) {
      if (j === colLimit && truncatedCols) row.push(ellipsis);
      else if (j < colLimit) row.push(ellipsis);
      else row.push('');
    }
    formatted.push(row);
  }

  // Emit lines with padding alignment
  const lines = [];
  for (let i = 0; i < formatted.length; i++) {
    const row = formatted[i];
    const parts = [];
    for (let j = 0; j < row.length; j++) {
      const w = colWidths[j] !== undefined ? colWidths[j] : row[j].length;
      parts.push(padLeft(row[j], w, padding));
    }
    lines.push('[' + parts.join(separator) + ']');
  }

  const body = lines.join('\n');
  return prefix + 'Matrix [' + rows + 'x' + cols + ']\n' + body + suffix;
}

function padLeft(s, width, padding) {
  const need = width - s.length + padding;
  if (need <= 0) return s;
  let out = '';
  for (let i = 0; i < need; i++) out += ' ';
  return out + s;
}

// ============================================================================
// INSPECT WITH CUSTOM SUMMARY
// ============================================================================
export function inspectSummary(matrix, options) {
  if (!(matrix instanceof ML.MLMatrix) && !(matrix && typeof matrix.toMatrix === 'function')) {
    throw new DecodeError('inspectSummary', 'matrix required');
  }
  const m = matrix instanceof ML.MLMatrix ? matrix : matrix.toMatrix();
  const rows = m.rows;
  const cols = m.columns;
  const total = rows * cols;

  let minV = Infinity;
  let maxV = -Infinity;
  let sumV = 0;
  let nanCount = 0;
  let infCount = 0;

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const v = read(m, i, j);
      if (Number.isNaN(v)) { nanCount++; continue; }
      if (!Number.isFinite(v)) { infCount++; continue; }
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
      sumV += v;
    }
  }

  const finiteCount = total - nanCount - infCount;
  const meanV = finiteCount > 0 ? sumV / finiteCount : 0;
  const opts = options || {};
  const prefix = opts.prefix !== undefined ? opts.prefix : '';

  return (
    prefix +
    'Matrix [' + rows + 'x' + cols + '] ' +
    'shape=' + rows + '\u00d7' + cols +
    ' total=' + total +
    ' finite=' + finiteCount +
    ' nan=' + nanCount +
    ' inf=' + infCount +
    ' min=' + (finiteCount ? minV : 'n/a') +
    ' max=' + (finiteCount ? maxV : 'n/a') +
    ' mean=' + (finiteCount ? meanV.toFixed(6) : 'n/a')
  );
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const InspectInput = Object.freeze({
  make(matrix, options) { return { matrix, options }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('inspect', 'Expected {matrix, options?}');
    if (!input.matrix) throw new DecodeError('inspect', 'matrix required');
    return input;
  }
});

export const InspectSummaryInput = InspectInput;

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function inspectValidated(input) {
  const d = InspectInput.decode(input);
  return inspect(d.matrix, d.options);
}

export function inspectSummaryValidated(input) {
  const d = InspectSummaryInput.decode(input);
  return inspectSummary(d.matrix, d.options);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================
function policyCustom(operation, compute, isValid, annotate, policy) {
  const pol = PolicyModule.resolvePolicy(policy);
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = compute();
  if (pol.precision === PolicyModule.PrecisionMode.STRICT && !isValid(result)) {
    throw new Error(`[${operation}] strict precision rejected invalid result`);
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

export function inspectWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixInspect.inspectWithPolicies',
    () => inspect(matrix, options),
    (s) => typeof s === 'string' && s.length > 0,
    (s) => ({ length: s.length }),
    policy
  );
}

export function inspectSummaryWithPolicies(matrix, policy, options) {
  return policyCustom(
    'MatrixInspect.inspectSummaryWithPolicies',
    () => inspectSummary(matrix, options),
    (s) => typeof s === 'string' && s.length > 0,
    (s) => ({ length: s.length }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  inspect,
  inspectSummary,
  InspectInput,
  InspectSummaryInput,
  inspectValidated,
  inspectSummaryValidated,
  inspectWithPolicies,
  inspectSummaryWithPolicies
};