// file number : 043
// full path name : src/math/043_MatrixEVD.js
// description : High-performance Eigenvalue Decomposition (EVD) reimplemented from mljs/matrix dc/evd.js. Handles both symmetric matrices (Householder tridiagonalization tred2 + implicit QL tql2) and general matrices (Hessenberg reduction orthes + Francis QR hqr2). Provides real/imaginary eigenvalues, eigenvector matrix V, diagonal matrix, and the original matrix. Works on the flat typed array backing of MLMatrix (038) with cache-friendly inner loops. Includes policy-aware wrappers via 030_Policy and schema validators. Uses the stable `hypotenuse` helper from 047_MatrixDCUtil.
// best for : PCA on vertex data, PBR covariance analysis, physics stability (symmetric eigensystems), camera calibration, ML feature compression, procedural mesh analysis, and any eigen-based pipeline in the ECS on Android 64-bit.
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
    this.name = 'EVDDecompositionDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'EVDDecompositionDomainViolationError';
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
// EIGENVALUE DECOMPOSITION
// ============================================================================
export class EigenvalueDecomposition {
  constructor(value) {
    checkMatrix(value, 'EigenvalueDecomposition');
    const n = value.columns;
    if (n !== value.rows) {
      throw new DomainViolationError('EigenvalueDecomposition', 'Matrix must be square');
    }

    this.n = n;
    this.V = new ML.MLMatrix(n, n);
    this.d = new ARRAY_TYPE(n);
    this.e = new ARRAY_TYPE(n);
    this.symmetric = false;

    const A = new ARRAY_TYPE(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        A[i * n + j] = value.dd ? value.data[(i * n + j) * 2 + 1] : value.data[i * n + j];
      }
    }
    this._A = A;

    if (value.isSymmetric()) {
      this._tred2();
      this._tql2();
      this.symmetric = true;
    } else {
      this._orthes();
      this._hqr2();
      this.symmetric = false;
    }
  }

  // ----------------------------------------------------------------
  // TRED2: Householder tridiagonalization (symmetric)
  // ----------------------------------------------------------------
  _tred2() {
    const n = this.n;
    const V = this.V.data;
    const d = this.d;
    const e = this.e;
    const A = this._A;

    for (let i = 0; i < n * n; i++) V[i] = A[i];
    for (let j = 0; j < n; j++) d[j] = V[(n - 1) * n + j];

    for (let i = n - 1; i > 0; i--) {
      let scale = 0;
      let h = 0;
      for (let k = 0; k < i; k++) scale += Math.abs(d[k]);

      if (scale === 0) {
        e[i] = d[i - 1];
        for (let j = 0; j < i; j++) {
          d[j] = V[(i - 1) * n + j];
          V[i * n + j] = 0;
          V[j * n + i] = 0;
        }
      } else {
        for (let k = 0; k < i; k++) {
          d[k] /= scale;
          h += d[k] * d[k];
        }
        let f = d[i - 1];
        let g = Math.sqrt(h);
        if (f > 0) g = -g;
        e[i] = scale * g;
        h -= f * g;
        d[i - 1] = f - g;
        for (let j = 0; j < i; j++) e[j] = 0;

        for (let j = 0; j < i; j++) {
          f = d[j];
          V[j * n + i] = f;
          g = e[j] + V[j * n + j] * f;
          for (let k = j + 1; k <= i - 1; k++) {
            g += V[k * n + j] * d[k];
            e[k] += V[k * n + j] * f;
          }
          e[j] = g;
        }

        f = 0;
        for (let j = 0; j < i; j++) {
          e[j] /= h;
          f += e[j] * d[j];
        }
        const hh = f / (h + h);
        for (let j = 0; j < i; j++) e[j] -= hh * d[j];
        for (let j = 0; j < i; j++) {
          f = d[j];
          g = e[j];
          for (let k = j; k <= i - 1; k++) {
            V[k * n + j] -= f * e[k] + g * d[k];
          }
          d[j] = V[(i - 1) * n + j];
          V[i * n + j] = 0;
        }
      }
      d[i] = h;
    }

    for (let i = 0; i < n - 1; i++) {
      V[(n - 1) * n + i] = V[i * n + i];
      V[i * n + i] = 1;
      const h = d[i + 1];
      if (h !== 0) {
        for (let k = 0; k <= i; k++) d[k] = V[k * n + (i + 1)] / h;
        for (let j = 0; j <= i; j++) {
          let g = 0;
          for (let k = 0; k <= i; k++) g += V[k * n + (i + 1)] * V[k * n + j];
          for (let k = 0; k <= i; k++) V[k * n + j] -= g * d[k];
        }
      }
      for (let k = 0; k <= i; k++) V[k * n + (i + 1)] = 0;
    }
    for (let j = 0; j < n; j++) {
      d[j] = V[(n - 1) * n + j];
      V[(n - 1) * n + j] = 0;
    }
    V[(n - 1) * n + (n - 1)] = 1;
    e[0] = 0;
  }

  // ----------------------------------------------------------------
  // TQL2: QL method for symmetric tridiagonal
  // ----------------------------------------------------------------
  _tql2() {
    const n = this.n;
    const V = this.V.data;
    const d = this.d;
    const e = this.e;

    for (let i = 1; i < n; i++) e[i - 1] = e[i];
    e[n - 1] = 0;

    let f = 0;
    let tst1 = 0;
    const eps = Math.pow(2, -52);

    for (let l = 0; l < n; l++) {
      tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
      let m = l;
      while (m < n) {
        if (Math.abs(e[m]) <= eps * tst1) break;
        m++;
      }

      if (m > l) {
        let iter = 0;
        do {
          iter++;
          if (iter > 1000) throw new DomainViolationError('TQL2', 'max iterations exceeded');
          let g = d[l];
          let p = (d[l + 1] - g) / (2 * e[l]);
          let r = DCUtil.hypotenuse(p, 1);
          if (p < 0) r = -r;
          d[l] = e[l] / (p + r);
          d[l + 1] = e[l] * (p + r);
          const dl1 = d[l + 1];
          let h = g - d[l];
          for (let i = l + 2; i < n; i++) d[i] -= h;
          f += h;

          p = d[m];
          let c = 1;
          let c2 = c;
          let c3 = c;
          const el1 = e[l + 1];
          let s = 0;
          let s2 = 0;

          for (let i = m - 1; i >= l; i--) {
            c3 = c2;
            c2 = c;
            s2 = s;
            g = c * e[i];
            h = c * p;
            r = DCUtil.hypotenuse(p, e[i]);
            e[i + 1] = s * r;
            s = e[i] / r;
            c = p / r;
            p = c * d[i] - s * g;
            d[i + 1] = h + s * (c * g + s * d[i]);
            for (let k = 0; k < n; k++) {
              h = V[k * n + (i + 1)];
              V[k * n + (i + 1)] = s * V[k * n + i] + c * h;
              V[k * n + i] = c * V[k * n + i] - s * h;
            }
          }
          p = -s * s2 * c3 * el1 * e[l] / dl1;
          e[l] = s * p;
          d[l] = c * p;
        } while (Math.abs(e[l]) > eps * tst1);
      }
      d[l] = d[l] + f;
      e[l] = 0;
    }

    // Sort ascending
    for (let i = 0; i < n - 1; i++) {
      let k = i;
      let p = d[i];
      for (let j = i + 1; j < n; j++) {
        if (d[j] < p) {
          k = j;
          p = d[j];
        }
      }
      if (k !== i) {
        d[k] = d[i];
        d[i] = p;
        for (let j = 0; j < n; j++) {
          const t = V[j * n + i];
          V[j * n + i] = V[j * n + k];
          V[j * n + k] = t;
        }
      }
    }
  }

  // ----------------------------------------------------------------
  // ORTHES: Hessenberg reduction (general)
  // ----------------------------------------------------------------
  _orthes() {
    const n = this.n;
    const V = this.V.data;
    const A = this._A;

    for (let i = 0; i < n * n; i++) V[i] = A[i];

    const low = 0;
    const high = n - 1;
    const ort = new ARRAY_TYPE(n);

    for (let m = low + 1; m <= high - 1; m++) {
      let scale = 0;
      for (let i = m; i <= high; i++) scale += Math.abs(V[i * n + (m - 1)]);

      if (scale !== 0) {
        let h = 0;
        for (let i = high; i >= m; i--) {
          ort[i] = V[i * n + (m - 1)] / scale;
          h += ort[i] * ort[i];
        }
        let g = Math.sqrt(h);
        if (ort[m] > 0) g = -g;
        h -= ort[m] * g;
        ort[m] = ort[m] - g;

        for (let j = m; j < n; j++) {
          let f = 0;
          for (let i = high; i >= m; i--) f += ort[i] * V[i * n + j];
          f /= h;
          for (let i = m; i <= high; i++) V[i * n + j] -= f * ort[i];
        }

        for (let i = 0; i <= high; i++) {
          let f = 0;
          for (let j = high; j >= m; j--) f += ort[j] * V[i * n + j];
          f /= h;
          for (let j = m; j <= high; j++) V[i * n + j] -= f * ort[j];
        }

        ort[m] = scale * ort[m];
        V[m * n + (m - 1)] = scale * g;
      }
    }

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i > j + 1) V[i * n + j] = 0;
      }
    }
  }

  // ----------------------------------------------------------------
  // HQR2: Francis QR (general)
  // ----------------------------------------------------------------
  _hqr2() {
    const nn = this.n;
    const n = nn - 1;
    const low = 0;
    const high = nn - 1;
    const eps = Math.pow(2, -52);
    let exshift = 0;
    let p = 0, q = 0, r = 0, s = 0, z = 0, t, w, x, y;

    const V = this.V.data;
    const d = this.d;
    const e = this.e;

    for (let i = 0; i < nn; i++) {
      if (i < low || i > high) {
        d[i] = V[i * nn + i];
        e[i] = 0;
      }
    }

    let iter = 0;
    while (n >= low) {
      let l = n;
      while (l > low) {
        s = Math.abs(V[(l - 1) * nn + (l - 1)]) + Math.abs(V[l * nn + l]);
        if (s === 0) s = 1;
        if (Math.abs(V[l * nn + (l - 1)]) < eps * s) break;
        l--;
      }

      if (l === n) {
        V[n * nn + n] = V[n * nn + n] + exshift;
        d[n] = V[n * nn + n];
        e[n] = 0;
        n--;
        iter = 0;
      } else if (l === n - 1) {
        w = V[n * nn + (n - 1)] * V[(n - 1) * nn + n];
        p = (V[(n - 1) * nn + (n - 1)] - V[n * nn + n]) / 2;
        q = p * p + w;
        z = Math.sqrt(Math.abs(q));
        V[n * nn + n] = V[n * nn + n] + exshift;
        V[(n - 1) * nn + (n - 1)] = V[(n - 1) * nn + (n - 1)] + exshift;
        x = V[n * nn + n];

        if (q >= 0) {
          z = p >= 0 ? p + z : p - z;
          d[n - 1] = x + z;
          d[n] = d[n - 1];
          if (z !== 0) d[n] = x - w / z;
          e[n - 1] = 0;
          e[n] = 0;
          x = V[n * nn + (n - 1)];
          s = Math.abs(x) + Math.abs(z);
          p = x / s;
          q = z / s;
          r = Math.sqrt(p * p + q * q);
          p /= r;
          q /= r;
          for (let j = n - 1; j < nn; j++) {
            z = V[(n - 1) * nn + j];
            V[(n - 1) * nn + j] = q * z + p * V[n * nn + j];
            V[n * nn + j] = q * V[n * nn + j] - p * z;
          }
          for (let i = 0; i <= n; i++) {
            z = V[i * nn + (n - 1)];
            V[i * nn + (n - 1)] = q * z + p * V[i * nn + n];
            V[i * nn + n] = q * V[i * nn + n] - p * z;
          }
          for (let i = low; i <= high; i++) {
            z = V[i * nn + (n - 1)];
            V[i * nn + (n - 1)] = q * z + p * V[i * nn + n];
            V[i * nn + n] = q * V[i * nn + n] - p * z;
          }
        } else {
          d[n - 1] = x + p;
          d[n] = x + p;
          e[n - 1] = z;
          e[n] = -z;
        }
        n -= 2;
        iter = 0;
      } else {
        x = V[n * nn + n];
        y = 0;
        w = 0;
        if (l < n) {
          y = V[(n - 1) * nn + (n - 1)];
          w = V[n * nn + (n - 1)] * V[(n - 1) * nn + n];
        }
        if (iter === 10) {
          exshift += x;
          for (let i = low; i <= n; i++) V[i * nn + i] -= x;
          s = Math.abs(V[n * nn + (n - 1)]) + Math.abs(V[(n - 1) * nn + (n - 2)]);
          x = y = 0.75 * s;
          w = -0.4375 * s * s;
        }
        if (iter === 30) {
          s = (y - x) / 2;
          s = s * s + w;
          if (s > 0) {
            s = Math.sqrt(s);
            if (y < x) s = -s;
            s = x - w / ((y - x) / 2 + s);
            for (let i = low; i <= n; i++) V[i * nn + i] -= s;
            exshift += s;
            x = y = w = 0.964;
          }
        }
        iter++;
        if (iter > 1000) throw new DomainViolationError('HQR2', 'max iterations exceeded');

        let m = n - 2;
        while (m >= l) {
          z = V[m * nn + m];
          r = x - z;
          s = y - z;
          p = (r * s - w) / V[(m + 1) * nn + m] + V[m * nn + (m + 1)];
          q = V[(m + 1) * nn + (m + 1)] - z - r - s;
          r = V[(m + 2) * nn + (m + 1)];
          s = Math.abs(p) + Math.abs(q) + Math.abs(r);
          p /= s;
          q /= s;
          r /= s;
          if (m === l) break;
          if (Math.abs(V[m * nn + (m - 1)]) * (Math.abs(q) + Math.abs(r)) <
              eps * (Math.abs(p) * (Math.abs(V[(m - 1) * nn + (m - 1)]) + Math.abs(z) + Math.abs(V[(m + 1) * nn + (m + 1)])))) break;
          m--;
        }

        for (let i = m + 2; i <= n; i++) {
          V[i * nn + (i - 2)] = 0;
          if (i > m + 2) V[i * nn + (i - 3)] = 0;
        }

        for (let k = m; k <= n - 1; k++) {
          const notlast = k !== n - 1;
          if (k !== m) {
            p = V[k * nn + (k - 1)];
            q = V[(k + 1) * nn + (k - 1)];
            r = notlast ? V[(k + 2) * nn + (k - 1)] : 0;
            x = Math.abs(p) + Math.abs(q) + Math.abs(r);
            if (x === 0) continue;
            p /= x;
            q /= x;
            r /= x;
          }
          s = Math.sqrt(p * p + q * q + r * r);
          if (p < 0) s = -s;
          if (s !== 0) {
            if (k === m) {
              if (l !== m) V[k * nn + (k - 1)] = -V[k * nn + (k - 1)];
            } else {
              V[k * nn + (k - 1)] = -s * x;
            }
            p += s;
            x = p / s;
            y = q / s;
            z = r / s;
            q /= p;
            r /= p;
            for (let j = k; j < nn; j++) {
              p = V[k * nn + j] + q * V[(k + 1) * nn + j];
              if (notlast) {
                p += r * V[(k + 2) * nn + j];
                V[(k + 2) * nn + j] -= p * z;
              }
              V[k * nn + j] -= p * x;
              V[(k + 1) * nn + j] -= p * y;
            }
            for (let i = 0; i <= Math.min(n, k + 3); i++) {
              p = x * V[i * nn + k] + y * V[i * nn + (k + 1)];
              if (notlast) {
                p += z * V[i * nn + (k + 2)];
                V[i * nn + (k + 2)] -= p * r;
              }
              V[i * nn + k] -= p;
              V[i * nn + (k + 1)] -= p * q;
            }
          }
        }
      }
    }

    // Back-substitute to find vectors of upper triangular form
    if (Math.abs(V[nn * nn - 1]) < eps) V[nn * nn - 1] = 0;
    for (let m = nn - 1; m >= 0; m--) {
      p = d[m];
      q = e[m];
      if (q === 0) {
        let l = m;
        V[m * nn + m] = 1;
        for (let i = m - 1; i >= 0; i--) {
          w = V[i * nn + i] - p;
          r = 0;
          for (let j = l; j <= m; j++) r += V[i * nn + j] * V[j * nn + m];
          if (e[i] < 0) {
            z = w;
            s = r;
          } else {
            l = i;
            if (e[i] === 0) {
              if (w !== 0) V[i * nn + m] = -r / w;
              else V[i * nn + m] = -r / (eps * (Math.abs(V[i * nn + i]) + Math.abs(V[(i + 1) * nn + (i + 1)])));
            } else {
              x = V[i * nn + i];
              y = V[(i + 1) * nn + (i + 1)];
              let qq = (d[i] - p) * (d[i] - p) + e[i] * e[i];
              t = (x - p) * (y - p) - qq;
              if (t === 0) t = eps * (Math.abs(x - p) + Math.abs(y - p) + Math.abs(w) + Math.abs(qq));
              if (w !== 0) V[i * nn + m] = -(r * x + (x + y) * (qq - w * (y - p)) / t) / w;
              else V[i * nn + m] = -(r + (qq - w * (y - p)) / t) / s;
            }
            z = Math.abs(V[i * nn + m]);
            s = Math.max(s, z);
            if (s !== 0) {
              for (let j = 0; j <= m; j++) V[j * nn + i] /= s;
              for (let j = m; j >= i; j--) V[j * nn + i] *= z;
            }
          }
        }
      } else if (q < 0) {
        let l = m - 1;
        if (Math.abs(V[(m - 1) * nn + m]) > Math.abs(V[m * nn + (m - 1)])) {
          V[(m - 1) * nn + (m - 1)] = -q / V[(m - 1) * nn + m];
          V[(m - 1) * nn + m] = -(V[m * nn + m] - p) / V[(m - 1) * nn + m];
        } else {
          const cdiv = this._cdiv(0, -V[m * nn + (m - 1)], V[(m - 1) * nn + (m - 1)] - p, q);
          V[(m - 1) * nn + (m - 1)] = cdiv[0];
          V[(m - 1) * nn + m] = cdiv[1];
        }
        V[m * nn + (m - 1)] = 0;
        V[m * nn + m] = 1;
        for (let i = m - 2; i >= 0; i--) {
          let ra = 0;
          let sa = 0;
          for (let j = l; j <= m; j++) {
            ra += V[i * nn + j] * V[j * nn + (m - 1)];
            sa += V[i * nn + j] * V[j * nn + m];
          }
          w = V[i * nn + i] - p;
          if (e[i] < 0) {
            z = w;
            r = ra;
            s = sa;
          } else {
            l = i;
            if (e[i] === 0) {
              const cdiv = this._cdiv(-ra, -sa, w, q);
              V[i * nn + (m - 1)] = cdiv[0];
              V[i * nn + m] = cdiv[1];
            } else {
              x = V[i * nn + i];
              y = V[(i + 1) * nn + (i + 1)];
              let vr = (d[i] - p) * (d[i] - p) + e[i] * e[i] - q * q;
              const vi = (d[i] - p) * 2 * q;
              if (vr === 0) vr = eps * (Math.abs((d[i] - p) * 2 * q) + Math.abs(x - p) + Math.abs(y - p) + Math.abs(z) + Math.abs(r) + Math.abs(s) + Math.abs(w));
              const cdiv = this._cdiv(x * r - z * ra + q * sa, x * s - z * sa - q * ra, vr, vi);
              V[i * nn + (m - 1)] = cdiv[0];
              V[i * nn + m] = cdiv[1];
              if (Math.abs(x) > Math.abs(z) + Math.abs(q)) {
                V[(i + 1) * nn + (m - 1)] = (-ra - w * V[i * nn + (m - 1)] + q * V[i * nn + m]) / x;
                V[(i + 1) * nn + m] = (-sa - w * V[i * nn + m] - q * V[i * nn + (m - 1)]) / x;
              } else {
                const cdiv2 = this._cdiv(-r - y * V[i * nn + (m - 1)], -s - y * V[i * nn + m], z, q);
                V[(i + 1) * nn + (m - 1)] = cdiv2[0];
                V[(i + 1) * nn + m] = cdiv2[1];
              }
            }
            z = Math.max(Math.abs(V[i * nn + (m - 1)]), Math.abs(V[i * nn + m]));
            if (z !== 0) {
              for (let j = i; j <= m; j++) {
                V[j * nn + i] /= z;
                V[j * nn + (m - 1)] /= z;
                V[j * nn + m] /= z;
              }
            }
          }
        }
      }
    }

    // Back-transform to original basis
    if (this._A && nn > 0) {
      for (let j = nn - 1; j >= low; j--) {
        for (let i = low; i <= high; i++) {
          z = 0;
          for (let k = low; k <= Math.min(j, high); k++) z += V[i * nn + k] * V[k * nn + j];
          V[i * nn + j] = z;
        }
      }
    }
  }

  _cdiv(xr, xi, yr, yi) {
    let r, d;
    if (Math.abs(yr) > Math.abs(yi)) {
      r = yi / yr;
      d = yr + r * yi;
      return [(xr + r * xi) / d, (xi - r * xr) / d];
    }
    r = yr / yi;
    d = yi + r * yr;
    return [(r * xr + xi) / d, (r * xi - xr) / d];
  }

  // ----------------------------------------------------------------
  // Accessors
  // ----------------------------------------------------------------
  get realEigenvalues() { return this.d; }

  get imaginaryEigenvalues() { return this.e; }

  get eigenvalueMultiset() {
    const out = [];
    for (let i = 0; i < this.n; i++) {
      if (this.e[i] === 0) {
        out.push(this.d[i]);
      } else {
        out.push([this.d[i], this.e[i]]);
        out.push([this.d[i], -this.e[i]]);
        i++;
      }
    }
    return out;
  }

  get eigenvectorMatrix() { return this.V; }

  get diagonalMatrix() {
    const out = new ML.MLMatrix(this.n, this.n);
    for (let i = 0; i < this.n; i++) out.data[i * this.n + i] = this.d[i];
    return out;
  }
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const EVDInput = Object.freeze({
  make(matrix) { return { matrix }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('evd', 'Expected {matrix}');
    checkMatrix(input.matrix, 'evd');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function evdDecomposeValidated(input) {
  const d = EVDInput.decode(input);
  return new EigenvalueDecomposition(d.matrix);
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

export function evdDecomposeWithPolicies(matrix, policy) {
  return policyCustom(
    'MatrixEVD.evdDecomposeWithPolicies',
    () => new EigenvalueDecomposition(matrix),
    (d) => d instanceof EigenvalueDecomposition,
    (d) => ({ n: d.n, symmetric: d.symmetric }),
    policy
  );
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================
export default {
  DecodeError,
  DomainViolationError,
  EigenvalueDecomposition,
  EVDInput,
  evdDecomposeValidated,
  evdDecomposeWithPolicies
};