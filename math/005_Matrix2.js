// file number : 005
// full path name : src/math/005_Matrix2.js
// description : 2x2 matrix class (THREE.Matrix2) stored column-major, with method chaining, plus full zero-allocation bridge functions to/from gl-matrix mat2 (Float32Array of length 4) and bitecs 0.4.0 SoA components (separate m11/m12/m21/m22 Float32Arrays indexed by entity id). Adds high-precision double.js helpers (preciseDeterminant, preciseInvertInto) and a seeded simplex-noise setFromNoise2D helper that fills a rotation/scale matrix from two noise samples.
// best for  :  2D transforms (affine, rotation, scale, shear) used by texture atlases, sprite batching, UV manipulation, and any ECS system that drives 2D matrices into THREE.Material uniforms or Object3D matrices without allocating per frame.
// license : MIT

import { clamp } from './MathUtils.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { mat2: glMat2 } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Matrix2 is stored as four independent Float32Arrays indexed by entity id.
 * Systems read/write store.m11[eid], store.m12[eid], store.m21[eid],
 * store.m22[eid] directly — no temporary mat2 object, no per-entity
 * allocation, no GC churn. Column-major layout: [m11, m21, m12, m22].
 */
export const Matrix2Component = defineComponent( {
  m11: Types.f32,
  m12: Types.f32,
  m21: Types.f32,
  m22: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix mat2  <->  THREE.Matrix2
 * -----------------------------------------------------------------------------
 * gl-matrix writes into a Float32Array out param of length 4 in the order
 * [m11, m21, m12, m22] (column-major, same as THREE.Matrix2.elements). We
 * mirror that contract exactly. The THREE side always writes into a
 * preallocated THREE.Matrix2 (the `out` argument), never returns a fresh
 * instance, so hot loops stay allocation-free.
 */

// gl-matrix mat2 (Float32Array len 4, column-major) -> preallocated THREE.Matrix2
export function threeMat2FromGlMatrix( out, glM ) {
  const e = out.elements;
  e[ 0 ] = glM[ 0 ];
  e[ 1 ] = glM[ 1 ];
  e[ 2 ] = glM[ 2 ];
  e[ 3 ] = glM[ 3 ];
  return out;
}

// THREE.Matrix2 -> preallocated gl-matrix mat2 (Float32Array len 4)
export function glMatrixMat2FromThree( out, threeM ) {
  const e = threeM.elements;
  out[ 0 ] = e[ 0 ];
  out[ 1 ] = e[ 1 ];
  out[ 2 ] = e[ 2 ];
  out[ 3 ] = e[ 3 ];
  return out;
}

// gl-matrix mat2 -> write directly into a bitecs entity's SoA component
export function bitecsMat2FromGlMatrix( eid, glM, store = Matrix2Component ) {
  store.m11[ eid ] = glM[ 0 ];
  store.m21[ eid ] = glM[ 1 ];
  store.m12[ eid ] = glM[ 2 ];
  store.m22[ eid ] = glM[ 3 ];
  return eid;
}

// bitecs entity SoA component -> preallocated gl-matrix mat2 (Float32Array len 4)
export function glMatrixMat2FromBitecs( out, eid, store = Matrix2Component ) {
  out[ 0 ] = store.m11[ eid ];
  out[ 1 ] = store.m21[ eid ];
  out[ 2 ] = store.m12[ eid ];
  out[ 3 ] = store.m22[ eid ];
  return out;
}

// bitecs entity SoA component -> preallocated THREE.Matrix2
export function threeMat2FromBitecs( out, eid, store = Matrix2Component ) {
  const e = out.elements;
  e[ 0 ] = store.m11[ eid ];
  e[ 1 ] = store.m21[ eid ];
  e[ 2 ] = store.m12[ eid ];
  e[ 3 ] = store.m22[ eid ];
  return out;
}

// THREE.Matrix2 -> write directly into a bitecs entity's SoA component
export function bitecsMat2FromThree( eid, threeM, store = Matrix2Component ) {
  const e = threeM.elements;
  store.m11[ eid ] = e[ 0 ];
  store.m21[ eid ] = e[ 1 ];
  store.m12[ eid ] = e[ 2 ];
  store.m22[ eid ] = e[ 3 ];
  return eid;
}

// Multiply two bitecs SoA matrices -> preallocated THREE.Matrix2.
export function threeMat2FromBitecsMultiply( out, eidA, eidB, storeA = Matrix2Component, storeB = Matrix2Component ) {
  const a11 = storeA.m11[ eidA ], a21 = storeA.m21[ eidA ], a12 = storeA.m12[ eidA ], a22 = storeA.m22[ eidA ];
  const b11 = storeB.m11[ eidB ], b21 = storeB.m21[ eidB ], b12 = storeB.m12[ eidB ], b22 = storeB.m22[ eidB ];
  const e = out.elements;
  e[ 0 ] = a11 * b11 + a12 * b21;
  e[ 1 ] = a21 * b11 + a22 * b21;
  e[ 2 ] = a11 * b12 + a12 * b22;
  e[ 3 ] = a21 * b12 + a22 * b22;
  return out;
}

// Multiply two bitecs SoA matrices -> dst entity's SoA store.
export function bitecsMat2MultiplyInto( eidOut, eidA, eidB, storeA = Matrix2Component, storeB = Matrix2Component, storeOut = storeA ) {
  const a11 = storeA.m11[ eidA ], a21 = storeA.m21[ eidA ], a12 = storeA.m12[ eidA ], a22 = storeA.m22[ eidA ];
  const b11 = storeB.m11[ eidB ], b21 = storeB.m21[ eidB ], b12 = storeB.m12[ eidB ], b22 = storeB.m22[ eidB ];
  storeOut.m11[ eidOut ] = a11 * b11 + a12 * b21;
  storeOut.m21[ eidOut ] = a21 * b11 + a22 * b21;
  storeOut.m12[ eidOut ] = a11 * b12 + a12 * b22;
  storeOut.m22[ eidOut ] = a21 * b12 + a22 * b22;
  return eidOut;
}

// Add two bitecs SoA matrices -> preallocated THREE.Matrix2.
export function threeMat2FromBitecsAdd( out, eidA, eidB, storeA = Matrix2Component, storeB = Matrix2Component ) {
  const e = out.elements;
  e[ 0 ] = storeA.m11[ eidA ] + storeB.m11[ eidB ];
  e[ 1 ] = storeA.m21[ eidA ] + storeB.m21[ eidB ];
  e[ 2 ] = storeA.m12[ eidA ] + storeB.m12[ eidB ];
  e[ 3 ] = storeA.m22[ eidA ] + storeB.m22[ eidB ];
  return out;
}

// Add two bitecs SoA matrices -> dst entity's SoA store.
export function bitecsMat2AddInto( eidOut, eidA, eidB, storeA = Matrix2Component, storeB = Matrix2Component, storeOut = storeA ) {
  storeOut.m11[ eidOut ] = storeA.m11[ eidA ] + storeB.m11[ eidB ];
  storeOut.m21[ eidOut ] = storeA.m21[ eidA ] + storeB.m21[ eidB ];
  storeOut.m12[ eidOut ] = storeA.m12[ eidA ] + storeB.m12[ eidB ];
  storeOut.m22[ eidOut ] = storeA.m22[ eidA ] + storeB.m22[ eidB ];
  return eidOut;
}

// Subtract two bitecs SoA matrices -> preallocated THREE.Matrix2.
export function threeMat2FromBitecsSub( out, eidA, eidB, storeA = Matrix2Component, storeB = Matrix2Component ) {
  const e = out.elements;
  e[ 0 ] = storeA.m11[ eidA ] - storeB.m11[ eidB ];
  e[ 1 ] = storeA.m21[ eidA ] - storeB.m21[ eidB ];
  e[ 2 ] = storeA.m12[ eidA ] - storeB.m12[ eidB ];
  e[ 3 ] = storeA.m22[ eidA ] - storeB.m22[ eidB ];
  return out;
}

// Subtract two bitecs SoA matrices -> dst entity's SoA store.
export function bitecsMat2SubInto( eidOut, eidA, eidB, storeA = Matrix2Component, storeB = Matrix2Component, storeOut = storeA ) {
  storeOut.m11[ eidOut ] = storeA.m11[ eidA ] - storeB.m11[ eidB ];
  storeOut.m21[ eidOut ] = storeA.m21[ eidA ] - storeB.m21[ eidB ];
  storeOut.m12[ eidOut ] = storeA.m12[ eidA ] - storeB.m12[ eidB ];
  storeOut.m22[ eidOut ] = storeA.m22[ eidA ] - storeB.m22[ eidB ];
  return eidOut;
}

// Scale a bitecs SoA matrix in place by a scalar.
export function bitecsMat2ScaleInPlace( eid, scalar, store = Matrix2Component ) {
  store.m11[ eid ] *= scalar;
  store.m21[ eid ] *= scalar;
  store.m12[ eid ] *= scalar;
  store.m22[ eid ] *= scalar;
  return eid;
}

// Transpose a bitecs SoA matrix in place.
export function bitecsMat2TransposeInPlace( eid, store = Matrix2Component ) {
  const m12 = store.m12[ eid ];
  const m21 = store.m21[ eid ];
  store.m12[ eid ] = m21;
  store.m21[ eid ] = m12;
  return eid;
}

// Invert a bitecs SoA matrix in place (degenerate -> identity).
export function bitecsMat2InvertInPlace( eid, store = Matrix2Component ) {
  const a11 = store.m11[ eid ], a21 = store.m21[ eid ], a12 = store.m12[ eid ], a22 = store.m22[ eid ];
  const det = a11 * a22 - a12 * a21;
  if ( det === 0 ) {
    store.m11[ eid ] = 1; store.m21[ eid ] = 0; store.m12[ eid ] = 0; store.m22[ eid ] = 1;
  } else {
    const invDet = 1 / det;
    store.m11[ eid ] = a22 * invDet;
    store.m21[ eid ] = - a21 * invDet;
    store.m12[ eid ] = - a12 * invDet;
    store.m22[ eid ] = a11 * invDet;
  }
  return eid;
}

// Determinant of a bitecs SoA matrix.
export function bitecsMat2Determinant( eid, store = Matrix2Component ) {
  return store.m11[ eid ] * store.m22[ eid ] - store.m12[ eid ] * store.m21[ eid ];
}

// gl-matrix mat2 multiply -> out, reading directly from two bitecs entities.
// Uses module-scoped scratch buffers instead of allocating two inline arrays
// per call (the original code allocated two arrays on every invocation).
export function glMatrixMat2MultiplyFromBitecs( out, eidA, eidB, storeA = Matrix2Component, storeB = Matrix2Component ) {
  const a = _scratchMat2A;
  const b = _scratchMat2B;
  a[ 0 ] = storeA.m11[ eidA ]; a[ 1 ] = storeA.m21[ eidA ]; a[ 2 ] = storeA.m12[ eidA ]; a[ 3 ] = storeA.m22[ eidA ];
  b[ 0 ] = storeB.m11[ eidB ]; b[ 1 ] = storeB.m21[ eidB ]; b[ 2 ] = storeB.m12[ eidB ]; b[ 3 ] = storeB.m22[ eidB ];
  return glMat2.multiply( out, a, b );
}

// gl-matrix mat2 invert -> out, reading directly from a bitecs entity.
export function glMatrixMat2InvertFromBitecs( out, eid, store = Matrix2Component ) {
  const a = _scratchMat2A;
  a[ 0 ] = store.m11[ eid ]; a[ 1 ] = store.m21[ eid ]; a[ 2 ] = store.m12[ eid ]; a[ 3 ] = store.m22[ eid ];
  return glMat2.invert( out, a );
}

// gl-matrix mat2 adjoint -> out, reading directly from a bitecs entity.
export function glMatrixMat2AdjointFromBitecs( out, eid, store = Matrix2Component ) {
  const a = _scratchMat2A;
  a[ 0 ] = store.m11[ eid ]; a[ 1 ] = store.m21[ eid ]; a[ 2 ] = store.m12[ eid ]; a[ 3 ] = store.m22[ eid ];
  return glMat2.adjoint( out, a );
}

// gl-matrix mat2 determinant -> scalar, reading directly from a bitecs entity.
export function glMatrixMat2DeterminantFromBitecs( eid, store = Matrix2Component ) {
  const a = _scratchMat2A;
  a[ 0 ] = store.m11[ eid ]; a[ 1 ] = store.m21[ eid ]; a[ 2 ] = store.m12[ eid ]; a[ 3 ] = store.m22[ eid ];
  return glMat2.determinant( a );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers compute
 * the determinant and invert a matrix in double-double precision, which avoids
 * the loss of precision that hits the f64 path when the determinant is small.
 */

function _toDouble( value ) {
  return new Double( value );
}

// Returns m11*m22 - m12*m21 evaluated in double-double precision.
export function preciseDeterminant( m ) {
  const e = m.elements;
  const a11 = _toDouble( e[ 0 ] );
  const a22 = _toDouble( e[ 3 ] );
  const a12 = _toDouble( e[ 2 ] );
  const a21 = _toDouble( e[ 1 ] );
  return a11.mul( a22 ).sub( a12.mul( a21 ) ).toNumber();
}

// Inverts m into out using double-double precision for the intermediate values.
// Writes the result into out.elements. Degenerate matrices produce a zero
// matrix, matching THREE.Matrix2.invert()'s r185 behavior.
export function preciseInvertInto( out, m ) {
  const e = m.elements;
  const a11 = _toDouble( e[ 0 ] );
  const a21 = _toDouble( e[ 1 ] );
  const a12 = _toDouble( e[ 2 ] );
  const a22 = _toDouble( e[ 3 ] );
  const det = a11.mul( a22 ).sub( a12.mul( a21 ) );
  const te = out.elements;
  if ( det.valueOf() === 0 ) {
    te[ 0 ] = 0; te[ 1 ] = 0; te[ 2 ] = 0; te[ 3 ] = 0;
    return out;
  }
  const invDet = _toDouble( 1 ).div( det );
  te[ 0 ] = a22.mul( invDet ).toNumber();
  te[ 1 ] = a21.mul( invDet ).neg().toNumber();
  te[ 2 ] = a12.mul( invDet ).neg().toNumber();
  te[ 3 ] = a11.mul( invDet ).toNumber();
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 2D simplex-noise generator per seed. setFromNoise2D builds a 2x2
 * matrix whose first column is a unit vector derived from the noise field at
 * (x, y) and whose second column is its perpendicular, giving a rotation-like
 * matrix with unit determinant. Additional scale is applied if requested.
 */

function _mulberry32( seed ) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul( a ^ a >>> 15, 1 | a );
    t = t + Math.imul( t ^ t >>> 7, 61 | t ) ^ t;
    return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296;
  };
}

const _noise2DCache = new Map();

function _cachedNoise2D( seed ) {
  let gen = _noise2DCache.get( seed );
  if ( gen === undefined ) {
    gen = createNoise2D( _mulberry32( seed ) );
    _noise2DCache.set( seed, gen );
  }
  return gen;
}

// Set out from a 2D simplex field sampled at (x, y) with the given seed. The
// resulting matrix is a rotation matrix scaled by `scale` (default 1), so the
// determinant is scale^2.
export function setFromNoise2D( out, x, y, seed = 0, scale = 1 ) {
  const n = _cachedNoise2D( seed );
  // Convert a noise sample in [-1, 1] into an angle in [0, 2π).
  const angle = ( n( x, y ) + 1 ) * Math.PI;
  const c = Math.cos( angle ) * scale;
  const s = Math.sin( angle ) * scale;
  const e = out.elements;
  // Column-major: col0 = (c, s), col1 = (-s, c).
  e[ 0 ] = c;
  e[ 1 ] = s;
  e[ 2 ] = - s;
  e[ 3 ] = c;
  return out;
}

// Drop every cached noise generator.
export function disposeNoise2DCache() {
  _noise2DCache.clear();
}

// Module-local scratch buffers — allocated once, reused across every bridge.
const _scratchMat2A = new Float32Array( 4 );
const _scratchMat2B = new Float32Array( 4 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Matrix2
 * -----------------------------------------------------------------------------
 */
class Matrix2 {

  constructor( n11, n12, n21, n22 ) {
    Matrix2.prototype.isMatrix2 = true;
    this.elements = [ 1, 0, 0, 1 ];
    if ( n11 !== undefined ) {
      this.set( n11, n12, n21, n22 );
    }
  }

  identity() {
    this.set( 1, 0, 0, 1 );
    return this;
  }

  fromArray( array, offset = 0 ) {
    for ( let i = 0; i < 4; i ++ ) {
      this.elements[ i ] = array[ i + offset ];
    }
    return this;
  }

  set( n11, n12, n21, n22 ) {
    const te = this.elements;
    te[ 0 ] = n11; te[ 2 ] = n12;
    te[ 1 ] = n21; te[ 3 ] = n22;
    return this;
  }

  clone() {
    return new this.constructor().fromArray( this.elements );
  }

  copy( m ) {
    const te = this.elements;
    const me = m.elements;
    te[ 0 ] = me[ 0 ]; te[ 1 ] = me[ 1 ]; te[ 2 ] = me[ 2 ]; te[ 3 ] = me[ 3 ];
    return this;
  }

  add( m ) {
    const te = this.elements;
    const me = m.elements;
    te[ 0 ] += me[ 0 ]; te[ 1 ] += me[ 1 ]; te[ 2 ] += me[ 2 ]; te[ 3 ] += me[ 3 ];
    return this;
  }

  sub( m ) {
    const te = this.elements;
    const me = m.elements;
    te[ 0 ] -= me[ 0 ]; te[ 1 ] -= me[ 1 ]; te[ 2 ] -= me[ 2 ]; te[ 3 ] -= me[ 3 ];
    return this;
  }

  multiply( m ) {
    return this.multiplyMatrices( this, m );
  }

  multiplyMatrices( a, b ) {
    const ae = a.elements;
    const be = b.elements;
    const te = this.elements;
    const a11 = ae[ 0 ], a12 = ae[ 2 ];
    const a21 = ae[ 1 ], a22 = ae[ 3 ];
    const b11 = be[ 0 ], b12 = be[ 2 ];
    const b21 = be[ 1 ], b22 = be[ 3 ];
    te[ 0 ] = a11 * b11 + a12 * b21;
    te[ 1 ] = a21 * b11 + a22 * b21;
    te[ 2 ] = a11 * b12 + a12 * b22;
    te[ 3 ] = a21 * b12 + a22 * b22;
    return this;
  }

  scale( sx, sy ) {
    const te = this.elements;
    te[ 0 ] *= sx; te[ 1 ] *= sx;
    te[ 2 ] *= sy; te[ 3 ] *= sy;
    return this;
  }

  determinant() {
    const te = this.elements;
    return te[ 0 ] * te[ 3 ] - te[ 2 ] * te[ 1 ];
  }

  invert() {
    const te = this.elements;
    const a11 = te[ 0 ], a21 = te[ 1 ], a12 = te[ 2 ], a22 = te[ 3 ];
    const det = a11 * a22 - a12 * a21;
    if ( det === 0 ) {
      this.set( 0, 0, 0, 0 );
    } else {
      const invDet = 1 / det;
      te[ 0 ] = a22 * invDet;
      te[ 1 ] = - a21 * invDet;
      te[ 2 ] = - a12 * invDet;
      te[ 3 ] = a11 * invDet;
    }
    return this;
  }

  transpose() {
    const te = this.elements;
    const tmp = te[ 1 ];
    te[ 1 ] = te[ 2 ];
    te[ 2 ] = tmp;
    return this;
  }

  equals( m ) {
    const te = this.elements;
    const me = m.elements;
    return te[ 0 ] === me[ 0 ] && te[ 1 ] === me[ 1 ] &&
           te[ 2 ] === me[ 2 ] && te[ 3 ] === me[ 3 ];
  }

  fromMatrix3( m ) {
    const e = m.elements;
    return this.set(
      e[ 0 ], e[ 3 ],
      e[ 1 ], e[ 4 ]
    );
  }

  toArray( array = [], offset = 0 ) {
    const te = this.elements;
    array[ offset ] = te[ 0 ];
    array[ offset + 1 ] = te[ 1 ];
    array[ offset + 2 ] = te[ 2 ];
    array[ offset + 3 ] = te[ 3 ];
    return array;
  }

}

export { Matrix2 };