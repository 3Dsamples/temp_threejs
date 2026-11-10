// file number : 042
// full path name : src/math/042_MatrixSVD.js
// description : High-performance Singular Value Decomposition (SVD) reimplemented from mljs/matrix dc/svd.js. Uses Householder bidiagonalization + implicit-shift QR iteration (Golub-Reinsch). Provides U, S (diagonal), V (right singular vectors), and singular values. Works on the flat typed array backing of MLMatrix (038) with cache-friendly inner loops. Supports DoubleDouble precision, policy-aware wrappers via 030_Policy, and schema validators. Uses the stable `hypotenuse` helper from 047_MatrixDCUtil.
// best for : Rank-revealing decomposition, pseudo-inverse, low-rank approximation, PCA on vertex data, ML feature compression, procedural mesh analysis, PBR model fitting, and any SVD-based pipeline in the ECS on Android 64-bit.
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
    this.name = 'SVDDecompositionDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'SVDDecompositionDomainViolationError';
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
// SINGULAR VALUE DECOMPOSITION
// ============================================================================
export class SingularValueDecomposition {
  constructor(value) {
    checkMatrix(value, 'SingularValueDecomposition');
    const arg = value.clone();
    const m = arg.rows;
    const n = arg.columns;
    const dd = arg.dd;

    let nu = Math.min(m, n);
    const wantu = true;
    const wantv = true;

    // Working arrays
    const s = new ARRAY_TYPE(Math.min(m + 1, n));
    const U = new ML.MLMatrix(m, nu, { dd });
    const V = new ML.MLMatrix(n, n, { dd });
    const e = new ARRAY_TYPE(n);
    const work = new ARRAY_TYPE(m);

    const nct = Math.min(m - 1, n);
    const nrt = Math.max(0, Math.min(n - 2, m));
    let k, kase;

    // Reduce to bidiagonal form
    if (!dd) {
      const aData = arg.data;
      const uData = U.data;
      const vData = V.data;

      for (k = 0; k < Math.max(nct, nrt); k++) {
        if (k < nct) {
          s[k] = 0;
          for (let i = k; i < m; i++) s[k] = DCUtil.hypotenuse(s[k], aData[i * n + k]);
          if (s[k] !== 0) {
            if (aData[k * n + k] < 0) s[k] = -s[k];
            for (let i = k; i < m; i++) aData[i * n + k] /= s[k];
            aData[k * n + k] += 1;
          }
          s[k] = -s[k];
        }
        for (let j = k + 1; j < n; j++) {
          if (k < nct && s[k] !== 0) {
            let t = 0;
            for (let i = k; i < m; i++) t += aData[i * n + k] * aData[i * n + j];
            t = -t / aData[k * n + k];
            for (let i = k; i < m; i++) aData[i * n + j] += t * aData[i * n + k];
          }
          e[j] = aData[k * n + j];
        }
        if (wantu && k < nct) {
          for (let i = k; i < m; i++) uData[i * nu + k] = aData[i * n + k];
        }
        if (k < nrt) {
          e[k] = 0;
          for (let i = k + 1; i < n; i++) e[k] = DCUtil.hypotenuse(e[k], e[i]);
          if (e[k] !== 0) {
            if (e[k + 1] < 0) e[k] = -e[k];
            for (let i = k + 1; i < n; i++) e[i] /= e[k];
            e[k + 1] += 1;
          }
          e[k] = -e[k];
          if (k + 1 < m && e[k] !== 0) {
            for (let i = k + 1; i < m; i++) work[i] = 0;
            for (let j = k + 1; j < n; j++) {
              for (let i = k + 1; i < m; i++) work[i] += e[j] * aData[i * n + j];
            }
            for (let j = k + 1; j < n; j++) {
              const t = -e[j] / e[k + 1];
              for (let i = k + 1; i < m; i++) aData[i * n + j] += t * work[i];
            }
          }
          if (wantv) {
            for (let i = k + 1; i < n; i++) vData[i * n + k] = e[i];
          }
        }
      }

      const p = Math.min(n, m + 1);
      if (nct < n) s[nct] = aData[nct * n + nct];
      if (m < p) s[p - 1] = 0;
      if (nrt + 1 < p) e[nrt] = aData[nrt * n + (p - 1)];
      e[p - 1] = 0;

      if (wantu) {
        for (let j = nct; j < nu; j++) {
          for (let i = 0; i < m; i++) uData[i * nu + j] = 0;
          uData[j * nu + j] = 1;
        }
        for (k = nct - 1; k >= 0; k--) {
          if (s[k] !== 0) {
            for (let j = k + 1; j < nu; j++) {
              let t = 0;
              for (let i = k; i < m; i++) t += uData[i * nu + k] * uData[i * nu + j];
              t = -t / uData[k * nu + k];
              for (let i = k; i < m; i++) uData[i * nu + j] += t * uData[i * nu + k];
            }
            for (let i = k; i < m; i++) uData[i * nu + k] = -uData[i * nu + k];
            uData[k * nu + k] = 1 + uData[k * nu + k];
            for (let i = 0; i < k - 1; i++) uData[i * nu + k] = 0;
          } else {
            for (let i = 0; i < m; i++) uData[i * nu + k] = 0;
            uData[k * nu + k] = 1;
          }
        }
      }

      if (wantv) {
        for (k = n - 1; k >= 0; k--) {
          if (k < nrt && e[k] !== 0) {
            for (let j = k + 1; j < n; j++) {
              let t = 0;
              for (let i = k + 1; i < n; i++) t += vData[i * n + k] * vData[i * n + j];
              t = -t / vData[(k + 1) * n + k];
              for (let i = k + 1; i < n; i++) vData[i * n + j] += t * vData[i * n + k];
            }
          }
          for (let i = 0; i < n; i++) vData[i * n + k] = 0;
          vData[k * n + k] = 1;
        }
      }
    } else {
      // DD path (numerical accumulation)
      const aData = arg.data;
      for (k = 0; k < Math.max(nct, nrt); k++) {
        if (k < nct) {
          s[k] = 0;
          for (let i = k; i < m; i++) s[k] = DCUtil.hypotenuse(s[k], aData[(i * n + k) * 2 + 1]);
          if (s[k] !== 0) {
            if (aData[(k * n + k) * 2 + 1] < 0) s[k] = -s[k];
            for (let i = k; i < m; i++) {
              const pos = (i * n + k) * 2;
              aData[pos + 1] /= s[k];
            }
            aData[(k * n + k) * 2 + 1] += 1;
          }
          s[k] = -s[k];
        }
        for (let j = k + 1; j < n; j++) {
          if (k < nct && s[k] !== 0) {
            let t = 0;
            for (let i = k; i < m; i++) t += aData[(i * n + k) * 2 + 1] * aData[(i * n + j) * 2 + 1];
            t = -t / aData[(k * n + k) * 2 + 1];
            for (let i = k; i < m; i++) aData[(i * n + j) * 2 + 1] += t * aData[(i * n + k) * 2 + 1];
          }
          e[j] = aData[(k * n + j) * 2 + 1];
        }
        if (wantu && k < nct) {
          for (let i = k; i < m; i++) {
            const dst = (i * nu + k) * 2;
            U.data[dst] = aData[(i * n + k) * 2];
            U.data[dst + 1] = aData[(i * n + k) * 2 + 1];
          }
        }
        if (k < nrt) {
          e[k] = 0;
          for (let i = k + 1; i < n; i++) e[k] = DCUtil.hypotenuse(e[k], e[i]);
          if (e[k] !== 0) {
            if (e[k + 1] < 0) e[k] = -e[k];
            for (let i = k + 1; i < n; i++) e[i] /= e[k];
            e[k + 1] += 1;
          }
          e[k] = -e[k];
          if (k + 1 < m && e[k] !== 0) {
            for (let i = k + 1; i < m; i++) work[i] = 0;
            for (let j = k + 1; j < n; j++) {
              for (let i = k + 1; i < m; i++) work[i] += e[j] * aData[(i * n + j) * 2 + 1];
            }
            for (let j = k + 1; j < n; j++) {
              const t = -e[j] / e[k + 1];
              for (let i = k + 1; i < m; i++) aData[(i * n + j) * 2 + 1] += t * work[i];
            }
          }
          if (wantv) {
            for (let i = k + 1; i < n; i++) {
              const dst = (i * n + k) * 2;
              V.data[dst + 1] = e[i];
            }
          }
        }
      }
      const p = Math.min(n, m + 1);
      if (nct < n) s[nct] = aData[(nct * n + nct) * 2 + 1];
      if (m < p) s[p - 1] = 0;
      if (nrt + 1 < p) e[nrt] = aData[(nrt * n + (p - 1)) * 2 + 1];
      e[p - 1] = 0;
    }

    // QR iteration for bidiagonal form
    const maxIter = Math.max(30, n * 30);
    const eps = Math.pow(2, -52);
    let pp = p - 1;
    let iter = 0;
    while (pp >= 0) {
      for (k = pp; k >= 0; k--) {
        kase = 0;
        if (k === 0) kase = 4;
        else {
          let test = Math.abs(s[k - 1]) + Math.abs(s[k]);
          if (test === 0) test = 1;
          const ks = k - 1;
          if (Math.abs(e[ks]) < eps * test) {
            e[ks] = 0;
            kase = 3;
          } else if (Math.abs(s[ks]) < eps * test) {
            s[ks] = 0;
            kase = 1;
          } else if (Math.abs(s[k]) < eps * test) {
            kase = 2;
          } else {
            kase = 0;
          }
        }
        if (kase !== 0) break;
      }

      if (kase === 1) {
        // Deflate negligible s[ks]
        const ks = k - 1;
        const f = e[ks];
        e[ks] = 0;
        for (let j = ks; j < pp; j++) {
          const t = DCUtil.hypotenuse(s[j], f);
          const cs = s[j] / t;
          const sn = f / t;
          s[j] = t;
          if (j + 1 < p) {
            const fj = e[j];
            e[j] = cs * fj - sn * s[j + 1];
            s[j + 1] = sn * fj + cs * s[j + 1];
          }
          if (wantv) {
            if (!V.dd) {
              const vData = V.data;
              for (let i = 0; i < n; i++) {
                const v = vData[i * n + ks];
                const w = vData[i * n + j];
                vData[i * n + ks] = cs * v - sn * w;
                vData[i * n + j] = sn * v + cs * w;
              }
            } else {
              for (let i = 0; i < n; i++) {
                const vp = (i * n + ks) * 2;
                const wp = (i * n + j) * 2;
                const vv = [V.data[vp], V.data[vp + 1]];
                const ww = [V.data[wp], V.data[wp + 1]];
                const nv = DD.subtract(DD.multiply(DD.fromDouble(cs), vv), DD.multiply(DD.fromDouble(sn), ww));
                const nw = DD.add(DD.multiply(DD.fromDouble(sn), vv), DD.multiply(DD.fromDouble(cs), ww));
                V.data[vp] = nv[0]; V.data[vp + 1] = nv[1];
                V.data[wp] = nw[0]; V.data[wp + 1] = nw[1];
              }
            }
          }
        }
      } else if (kase === 2) {
        // Deflate negligible s[k]
        const f = e[pp - 1];
        e[pp - 1] = 0;
        for (let j = pp - 1; j >= k; j--) {
          const t = DCUtil.hypotenuse(s[j], f);
          const cs = s[j] / t;
          const sn = f / t;
          s[j] = t;
          if (j !== k) {
            const fj = e[j - 1];
            e[j - 1] = cs * fj - sn * s[j - 1];
            s[j - 1] = sn * fj + cs * s[j - 1];
          }
          if (wantu) {
            if (!U.dd) {
              const uData = U.data;
              for (let i = 0; i < m; i++) {
                const v = uData[i * nu + j];
                const w = uData[i * nu + pp - 1];
                uData[i * nu + j] = cs * v - sn * w;
                uData[i * nu + pp - 1] = sn * v + cs * w;
              }
            } else {
              for (let i = 0; i < m; i++) {
                const vp = (i * nu + j) * 2;
                const wp = (i * nu + pp - 1) * 2;
                const vv = [U.data[vp], U.data[vp + 1]];
                const ww = [U.data[wp], U.data[wp + 1]];
                const nv = DD.subtract(DD.multiply(DD.fromDouble(cs), vv), DD.multiply(DD.fromDouble(sn), ww));
                const nw = DD.add(DD.multiply(DD.fromDouble(sn), vv), DD.multiply(DD.fromDouble(cs), ww));
                U.data[vp] = nv[0]; U.data[vp + 1] = nv[1];
                U.data[wp] = nw[0]; U.data[wp + 1] = nw[1];
              }
            }
          }
        }
      } else if (kase === 3) {
        // Shift from bottom 2x2 minor
        const scale = Math.max(Math.max(Math.max(Math.max(Math.abs(s[pp]), Math.abs(s[pp - 1])), Math.abs(e[pp - 1])), Math.abs(s[k])), Math.abs(e[k]));
        const sp = s[pp] / scale;
        const spm1 = s[pp - 1] / scale;
        const epm1 = e[pp - 1] / scale;
        const sk = s[k] / scale;
        const ek = e[k] / scale;
        const b = ((spm1 + sp) * (spm1 - sp) + epm1 * epm1) / 2;
        const c = sp * epm1 * (sp * epm1);
        let shift = 0;
        if (b !== 0 || c !== 0) {
          shift = Math.sqrt(b * b + c);
          if (b < 0) shift = -shift;
          shift = c / (b + shift);
        }
        let f = (sk + sp) * (sk - sp) + shift;
        let g = sk * ek;

        for (let j = k; j < pp; j++) {
          let t = DCUtil.hypotenuse(f, g);
          let cs = f / t;
          let sn = g / t;
          if (j !== k) {
            e[j - 1] = t;
          }
          f = cs * s[j] + sn * e[j];
          e[j] = cs * e[j] - sn * s[j];
          g = sn * s[j + 1];
          s[j + 1] = cs * s[j + 1];
          if (wantv) {
            if (!V.dd) {
              const vData = V.data;
              for (let i = 0; i < n; i++) {
                const v = vData[i * n + j];
                const w = vData[i * n + j + 1];
                vData[i * n + j] = cs * v - sn * w;
                vData[i * n + j + 1] = sn * v + cs * w;
              }
            } else {
              for (let i = 0; i < n; i++) {
                const vp = (i * n + j) * 2;
                const wp = (i * n + j + 1) * 2;
                const vv = [V.data[vp], V.data[vp + 1]];
                const ww = [V.data[wp], V.data[wp + 1]];
                const nv = DD.subtract(DD.multiply(DD.fromDouble(cs), vv), DD.multiply(DD.fromDouble(sn), ww));
                const nw = DD.add(DD.multiply(DD.fromDouble(sn), vv), DD.multiply(DD.fromDouble(cs), ww));
                V.data[vp] = nv[0]; V.data[vp + 1] = nv[1];
                V.data[wp] = nw[0]; V.data[wp + 1] = nw[1];
              }
            }
          }
          t = DCUtil.hypotenuse(f, g);
          cs = f / t;
          sn = g / t;
          s[j] = t;
          f = cs * e[j] + sn * s[j + 1];
          s[j + 1] = -sn * e[j] + cs * s[j + 1];
          g = sn * e[j + 1];
          e[j + 1] = cs * e[j + 1];
          if (wantu && j < m - 1) {
            if (!U.dd) {
              const uData = U.data;
              for (let i = 0; i < m; i++) {
                const v = uData[i * nu + j];
                const w = uData[i * nu + j + 1];
                uData[i * nu + j] = cs * v - sn * w;
                uData[i * nu + j + 1] = sn * v + cs * w;
              }
            } else {
              for (let i = 0; i < m; i++) {
                const vp = (i * nu + j) * 2;
                const wp = (i * nu + j + 1) * 2;
                const vv = [U.data[vp], U.data[vp + 1]];
                const ww = [U.data[wp], U.data[wp + 1]];
                const nv = DD.subtract(DD.multiply(DD.fromDouble(cs), vv), DD.multiply(DD.fromDouble(sn), ww));
                const nw = DD.add(DD.multiply(DD.fromDouble(sn), vv), DD.multiply(DD.fromDouble(cs), ww));
                U.data[vp] = nv[0]; U.data[vp + 1] = nv[1];
                U.data[wp] = nw[0]; U.data[wp + 1] = nw[1];
              }
            }
          }
        }
        e[k] = f;
        e[pp] = g;
      } else if (kase === 4) {
        // Convergence
        if (s[k] <= 0) {
          s[k] = s[k] < 0 ? -s[k] : 0;
          if (wantv) {
            if (!V.dd) {
              const vData = V.data;
              for (let i = 0; i <= pp; i++) vData[i * n + k] = -vData[i * n + k];
            } else {
              for (let i = 0; i <= pp; i++) {
                const pos = (i * n + k) * 2;
                V.data[pos] = -V.data[pos];
                V.data[pos + 1] = -V.data[pos + 1];
              }
            }
          }
        }
        while (k < pp) {
          if (s[k] >= s[k + 1]) break;
          const t = s[k];
          s[k] = s[k + 1];
          s[k + 1] = t;
          if (wantv && k < n - 1) {
            if (!V.dd) {
              const vData = V.data;
              for (let i = 0; i < n; i++) {
                const tmp = vData[i * n + k + 1];
                vData[i * n + k + 1] = vData[i * n + k];
                vData[i * n + k] = tmp;
              }
            } else {
              for (let i = 0; i < n; i++) {
                const a = (i * n + k + 1) * 2;
                const b = (i * n + k) * 2;
                let t0 = V.data[a], t1 = V.data[a + 1];
                V.data[a] = V.data[b]; V.data[a + 1] = V.data[b + 1];
                V.data[b] = t0; V.data[b + 1] = t1;
              }
            }
          }
          if (wantu && k < m - 1) {
            if (!U.dd) {
              const uData = U.data;
              for (let i = 0; i < m; i++) {
                const tmp = uData[i * nu + k + 1];
                uData[i * nu + k + 1] = uData[i * nu + k];
                uData[i * nu + k] = tmp;
              }
            } else {
              for (let i = 0; i < m; i++) {
                const a = (i * nu + k + 1) * 2;
                const b = (i * nu + k) * 2;
                let t0 = U.data[a], t1 = U.data[a + 1];
                U.data[a] = U.data[b]; U.data[a + 1] = U.data[b + 1];
                U.data[b] = t0; U.data[b + 1] = t1;
              }
            }
          }
          k++;
        }
        iter = iter + 1;
        pp--;
      } else {
        break;
      }

      if (iter > maxIter) {
        throw new DomainViolationError('SVD', 'Maximum iterations exceeded');
      }
    }

    // Sort singular values in descending order
    const su = s;
    let nuIdx = Math.min(m, su.length);
    for (let i = 0; i < nuIdx - 1; i++) {
      k = i;
      let pVal = su[i];
      for (let j = i + 1; j < nuIdx; j++) {
        if (su[j] > pVal) {
          k = j;
          pVal = su[j];
        }
      }
      if (k !== i) {
        su[k] = su[i];
        su[i] = pVal;
        if (wantv && i < n - 1 && k < n - 1) {
          if (!V.dd) {
            const vData = V.data;
            for (let col = 0; col < n; col++) {
              const tmp = vData[col * n + k];
              vData[col * n + k] = vData[col * n + i];
              vData[col * n + i] = tmp;
            }
          } else {
            for (let col = 0; col < n; col++) {
              const a = (col * n + k) * 2;
              const b = (col * n + i) * 2;
              let t0 = V.data[a], t1 = V.data[a + 1];
              V.data[a] = V.data[b]; V.data[a + 1] = V.data[b + 1];
              V.data[b] = t0; V.data[b + 1] = t1;
            }
          }
        }
        if (wantu && i < m - 1 && k < m - 1) {
          if (!U.dd) {
            const uData = U.data;
            for (let row = 0; row < m; row++) {
              const tmp = uData[row * nu + k];
              uData[row * nu + k] = uData[row * nu + i];
              uData[row * nu + i] = tmp;
            }
          } else {
            for (let row = 0; row < m; row++) {
              const a = (row * nu + k) * 2;
              const b = (row * nu + i) * 2;
              let t0 = U.data[a], t1 = U.data[a + 1];
              U.data[a] = U.data[b]; U.data[a + 1] = U.data[b + 1];
              U.data[b] = t0; U.data[b + 1] = t1;
            }
          }
        }
      }
    }

    // Construct S matrix
    const S = new ML.MLMatrix(nuIdx, n, { dd });
    for (let i = 0; i < nuIdx; i++) {
      if (S.dd) {
        S.data[(i * n + i) * 2 + 1] = su[i];
      } else {
        S.data[i * n + i] = su[i];
      }
    }

    this.m = m;
    this.n = n;
    this.U = U;
    this.V = V;
    this.S = S;
    this.s = su;
  }

  get condition() {
    return this.s[0] / this.s[Math.min(this.m, this.n) - 1];
  }

  get norm2() {
    return this.s[0];
  }

  get rank() {
    const eps = Math.pow(2, -52);
    const tolerance = Math.max(this.m, this.n) * this.s[0] * eps;
    let r = 0;
    const su = this.s;
    for (let i = 0; i < su.length; i++) {
      if (su[i] > tolerance) r++;
    }
    return r;
  }

  get diagonal() {
    return this.s;
  }

  get leftSingularVectors() {
    if (!this.U.isSquare()) {
      return this.U.selection(ML.MLMatrix.xrange(0, this.m), ML.MLMatrix.xrange(0, this.m));
    }
    return this.U;
  }

  get rightSingularVectors() {
    if (!this.V.isSquare()) {
      return this.V.selection(ML.MLMatrix.xrange(0, this.n), ML.MLMatrix.xrange(0, this.n));
    }
    return this.V;
  }

  get diagonalMatrix() {
    return this.S;
  }

  solve(value) {
    checkMatrix(value, 'solve');
    const rows = this.U.rows;
    if (value.rows !== rows) throw new DomainViolationError('solve', 'Matrix dimensions do not match');

    const columns = this.U.columns;
    const B = new ML.MLMatrix(rows, value.columns, { dd: this.U.dd || value.dd });

    // Compute B * U^T
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < columns; j++) {
        let sum = 0;
        for (let k = 0; k < rows; k++) {
          sum += value.get(k, i) * this.U.get(k, j);
        }
        if (B.dd) {
          B.data[(i * columns + j) * 2 + 1] = sum;
        } else {
          B.data[i * columns + j] = sum;
        }
      }
    }

    // Compute B / S
    for (let i = 0; i < columns; i++) {
      const inv = this.s[i] === 0 ? 0 : 1 / this.s[i];
      for (let j = 0; j < value.columns; j++) {
        if (B.dd) {
          B.data[(i * value.columns + j) * 2 + 1] *= inv;
        } else {
          B.data[i * value.columns + j] *= inv;
        }
      }
    }

    // Compute B * V
    const X = new ML.MLMatrix(value.columns, this.V.columns, { dd: B.dd });
    for (let i = 0; i < this.V.columns; i++) {
      for (let j = 0; j < value.columns; j++) {
        let sum = 0;
        for (let k = 0; k < columns; k++) {
          sum += B.get(k, j) * this.V.get(i, k);
        }
        if (X.dd) {
          X.data[(i * X.columns + j) * 2 + 1] = sum;
        } else {
          X.data[i * X.columns + j] = sum;
        }
      }
    }
    return X.transpose();
  }
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================
export const SVDInput = Object.freeze({
  make(matrix) { return { matrix }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('svd', 'Expected {matrix}');
    checkMatrix(input.matrix, 'svd');
    return input;
  }
});

export const SVDSolveInput = Object.freeze({
  make(decomposition, value) { return { decomposition, value }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('svdSolve', 'Expected {decomposition, value}');
    if (!(input.decomposition instanceof SingularValueDecomposition)) {
      throw new DecodeError('svdSolve', 'SingularValueDecomposition instance required');
    }
    checkMatrix(input.value, 'svdSolve');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================
export function svdDecomposeValidated(input) {
  const d = SVDInput.decode(input);
  return new SingularValueDecomposition(d.matrix);
}

export function svdSolveValidated(input) {
  const d = SVDSolveInput.decode(input);
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

export function svdDecomposeWithPolicies(matrix, policy) {
  return policyCustom(
    'MatrixSVD.svdDecomposeWithPolicies',
    () => new SingularValueDecomposition(matrix),
    (d) => d instanceof SingularValueDecomposition,
    (d) => ({ m: d.m, n: d.n, rank: d.rank }),
    policy
  );
}

export function svdSolveWithPolicies(decomposition, value, policy) {
  return policyCustom(
    'MatrixSVD.svdSolveWithPolicies',
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
  SingularValueDecomposition,
  SVDInput,
  SVDSolveInput,
  svdDecomposeValidated,
  svdSolveValidated,
  svdDecomposeWithPolicies,
  svdSolveWithPolicies
};