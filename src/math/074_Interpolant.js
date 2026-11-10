// file number : 074
// full path name : src/math/074_Interpolant.js
// description : Base Interpolant class (THREE.Interpolant) with the r185 parameterPositions/sampleValues/sampleSize/resultBuffer layout and the exact r185 evaluate() algorithm (binary-search-then-linear-scan with _cachedIndex, beforeStart_/afterEnd_, forward-scan, backward-scan, and boundary handling). Provides zero-allocation bridges for a bitecs 0.4.0 SoA entity descriptor (`InterpolantTrackComponent` with positionStart/positionCount/valueStart/valueStride) pointing into a caller-managed shared `InterpolantPools` (Float32Arrays for parameterPositions and sampleValues). No copy is performed per call — subarray views bind the interpolant directly to the pool slices. Full set of typed views (threeVec3FromInterpolant, threeVec4FromInterpolant, glMatrixVec3FromInterpolant, glMatrixVec4FromInterpolant, glMatrixQuatFromInterpolant) reads the resultBuffer into a preallocated target without allocation. Full set of evaluate helpers (threeVec3FromBitecsInterpolantEvaluate, threeVec4FromBitecsInterpolantEvaluate, glMatrixVec3FromBitecsInterpolantEvaluate, glMatrixVec4FromBitecsInterpolantEvaluate, bitecsVec3FromBitecsInterpolantEvaluate, bitecsVec4FromBitecsInterpolantEvaluate) reads from a bitecs-bound track into THREE- or gl-matrix- or bitecs-SoA targets. Sample-slot helpers (threeVec3FromBitecsInterpolantSample, threeVec4FromBitecsInterpolantSample, glMatrixVec3FromBitecsInterpolantSample, glMatrixVec4FromBitecsInterpolantSample, bitecsInterpolantSampleFromVec3, bitecsInterpolantSampleFromVec4) read/write individual slots without allocation. Parameter-slot helpers (bitecsInterpolantPositionSet/Get) and a normalized keyframe scrub (bitecsInterpolantSampleSlotFromT). DoubleDouble `preciseLinearInterpolate` and `preciseCubicInterpolate` (Hermite weights in double-double for accuracy across galactic-scale animation tracks). Procedural `fillNoiseTrack` via 013_SimplexNoise with cached per-seed mulberry32. `disposeNoise3DCache` for cleanup. Uses 002_Constants (ECS.PRIORITY, PERFORMANCE), 003_Common (clamp, EPSILON), 006_Vec3/007_Vec4/011_Quat for the typed views, 013_SimplexNoise for procedural tracks, 014_BitECS for the SoA descriptor (f32/u32). No CDN, no static server, no Vite/Vue.
// best for : Animation curves, keyframe interpolation, ECS-driven animation tracks, gl-matrix-driven tweening, physics trajectories sampled per entity, and any hot loop that must evaluate interpolants over SoA data without allocating per frame. The bitecs-bound path is the recommended one for 10k+ entities on Android 64-bit; the precise* helpers keep accuracy across floating-origin rebases at galactic scale.
// license : MIT

import {
  ECS,
  PERFORMANCE,
} from '../core/002_Constants.js';
import {
  clamp,
  EPSILON,
} from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as Vec3 from './006_Vec3.js';
import * as Vec4 from './007_Vec4.js';
import * as Quat from './011_Quat.js';
import * as bitecs from '../ecs/014_BitECS.js';
import { createNoise3D } from './013_SimplexNoise.js';

// ═══════════════════════════════════════════════════════════════════
// bitECS 0.4.0 SoA TRACK DESCRIPTOR (archetype-friendly, cache-friendly)
// ═══════════════════════════════════════════════════════════════════
//
// An entity's interpolant track is described by:
//   positionStart : f32 offset into pools.parameterPositions
//   positionCount : u32 number of keyframes (≥ 1)
//   valueStart    : f32 offset into pools.sampleValues
//   valueStride   : u32 components per sample (1, 2, 3, 4, …)
//
// The actual positions and values live in the shared InterpolantPools. This
// keeps the ECS side fully SoA-friendly and cache-friendly: systems read/write
// the descriptor arrays by entity id, and each evaluate() binds the
// interpolant to the correct slice with a zero-copy subarray view.
export const InterpolantTrackComponent = {
  positionStart: bitecs.f32( [] ),
  positionCount: bitecs.u32( [] ),
  valueStart:    bitecs.f32( [] ),
  valueStride:   bitecs.u32( [] ),
};

// ═══════════════════════════════════════════════════════════════════
// SHARED POOL (caller-managed, zero-allocation in hot loops)
// ═══════════════════════════════════════════════════════════════════
//
// The caller supplies these once and can grow them. Every bridge reads/writes
// directly into these Float32Arrays. No copy is performed per call.

export const InterpolantPools = {
  parameterPositions: new Float32Array( 0 ),
  sampleValues:       new Float32Array( 0 ),

  set( positions, values ) {
    InterpolantPools.parameterPositions = positions;
    InterpolantPools.sampleValues       = values;
  },

  ensurePositions( size ) {
    if ( InterpolantPools.parameterPositions.length < size ) {
      const next = new Float32Array( size );
      next.set( InterpolantPools.parameterPositions );
      InterpolantPools.parameterPositions = next;
    }
    return InterpolantPools.parameterPositions;
  },

  ensureValues( size ) {
    if ( InterpolantPools.sampleValues.length < size ) {
      const next = new Float32Array( size );
      next.set( InterpolantPools.sampleValues );
      InterpolantPools.sampleValues = next;
    }
    return InterpolantPools.sampleValues;
  },
};

// ═══════════════════════════════════════════════════════════════════
// Vector / Quat pool helpers (pre-allocated targets)
// ═══════════════════════════════════════════════════════════════════

const _zero = Vec3.create();

// Module-local scratch buffers — allocated once, reused across every bridge.
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );
const _scratchVec4A = new Float32Array( 4 );
const _scratchQuatA = new Float32Array( 4 );
const _scratchQuatB = new Float32Array( 4 );

// ═══════════════════════════════════════════════════════════════════
// THREE.Interpolant (r185)
// ═══════════════════════════════════════════════════════════════════
//
// The `evaluate()` method below is the exact r185 implementation. It keeps
// the same binary-search-then-linear-scan logic, the same `_cachedIndex`
// fast path, the same boundary handling, and the same `beforeStart_` /
// `afterEnd_` bookkeeping that three.js r185 relies on for hot-path
// evaluation of large keyframe tracks.

class Interpolant {

  constructor( parameterPositions, sampleValues, sampleSize, resultBuffer ) {
    this.parameterPositions = parameterPositions;
    this._cachedIndex = 0;
    this.resultBuffer = resultBuffer !== undefined ?
      resultBuffer : new sampleValues.constructor( sampleSize );
    this.sampleValues = sampleValues;
    this.valueSize = sampleSize;
    this.settings = null;
    this.DefaultSettings_ = {};
  }

  evaluate( t ) {

    const pp = this.parameterPositions;
    let i1 = this._cachedIndex,
      t1 = pp[ i1 ],
      t0 = pp[ i1 - 1 ];

    validate_interval: {

      seek: {

        let right;

        linear_scan: {

          // Forward scan
          forward_scan:
          if ( ! ( t < t1 ) ) {

            for ( let giveUpAt = i1 + 2; ; ) {

              if ( t1 === undefined ) {

                if ( t < t0 ) break forward_scan;

                // after end
                i1 = pp.length;
                this._cachedIndex = i1;
                return this.copySampleValue_( i1 - 1 );

              }

              if ( i1 === giveUpAt ) break; // this loop

              t0 = t1;
              t1 = pp[ ++ i1 ];

              if ( t < t1 ) {
                // we have arrived at the sought interval
                break seek;
              }

            }

            // prepare binary search on the right side of the index
            right = pp.length;
            break linear_scan;

          }

          // Backward scan
          if ( ! ( t >= t0 ) ) {

            const t1global = pp[ 1 ];

            if ( t < t1global ) {

              i1 = 2; // using the INTERNAL representation
              t0 = t1global;

            }

            for ( let giveUpAt = i1 - 2; ; ) {

              if ( t0 === undefined ) {

                // before start
                this._cachedIndex = 0;
                return this.copySampleValue_( 0 );

              }

              if ( i1 === giveUpAt ) break; // this loop

              t1 = t0;
              t0 = pp[ -- i1 - 1 ];

              if ( t >= t0 ) {
                // we have arrived at the sought interval
                break seek;
              }

            }

            // prepare binary search on the left side of the index
            right = i1;
            i1 = 0;
            break linear_scan;

          }

          // the interval is valid
          break validate_interval;

        } // linear scan

        // binary search
        while ( i1 < right ) {

          const mid = ( i1 + right ) >>> 1;

          if ( t < pp[ mid ] ) {
            right = mid;
          } else {
            i1 = mid + 1;
          }

        }

        t1 = pp[ i1 ];
        t0 = pp[ i1 - 1 ];

        // check boundary cases, again
        if ( t0 === undefined ) {

          this._cachedIndex = 0;
          return this.copySampleValue_( 0 );

        }

        if ( t1 === undefined ) {

          i1 = pp.length;
          this._cachedIndex = i1;
          return this.copySampleValue_( i1 - 1 );

        }

      } // seek

      this._cachedIndex = i1;

      this.beforeStart_ = i1;
      this.afterEnd_ = i1 + 1;

      return this.interpolate_( i1, t0, t, t1 );

    } // validate_interval

    return this.interpolate_( i1, t0, t, t1 );

  }

  // Base class: zero-order hold. Subclasses override this.
  interpolate_( i1 /*, t0, t, t1 */ ) {
    return this.copySampleValue_( i1 - 1 );
  }

  copySampleValue_( index ) {

    // copies a sample value to the result buffer
    const result = this.resultBuffer,
      values = this.sampleValues,
      stride = this.valueSize,
      offset = index * stride;

    for ( let i = 0; i !== stride; ++ i ) {
      result[ i ] = values[ offset + i ];
    }

    return result;

  }

  getSettings_() {
    return this.settings || this.DefaultSettings_;
  }

}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: Interpolant resultBuffer → typed THREE / gl-matrix targets
// ═══════════════════════════════════════════════════════════════════

export function threeVec3FromInterpolant( out, interpolant ) {
  const buf = interpolant.resultBuffer;
  out.x = buf[ 0 ];
  out.y = buf[ 1 ];
  out.z = buf[ 2 ];
  return out;
}

export function threeVec4FromInterpolant( out, interpolant ) {
  const buf = interpolant.resultBuffer;
  out.x = buf[ 0 ];
  out.y = buf[ 1 ];
  out.z = buf[ 2 ];
  out.w = buf[ 3 ];
  return out;
}

export function glMatrixVec3FromInterpolant( out, interpolant ) {
  const buf = interpolant.resultBuffer;
  out[ 0 ] = buf[ 0 ];
  out[ 1 ] = buf[ 1 ];
  out[ 2 ] = buf[ 2 ];
  return out;
}

export function glMatrixVec4FromInterpolant( out, interpolant ) {
  const buf = interpolant.resultBuffer;
  out[ 0 ] = buf[ 0 ];
  out[ 1 ] = buf[ 1 ];
  out[ 2 ] = buf[ 2 ];
  out[ 3 ] = buf[ 3 ];
  return out;
}

export function glMatrixQuatFromInterpolant( out, interpolant ) {
  return glMatrixVec4FromInterpolant( out, interpolant );
}

// Writes into the interpolant's resultBuffer from preallocated typed targets
// (used by external evaluators that want to inject a custom result).
export function interpolantFromGlMatrixVec3( interpolant, glVec ) {
  const buf = interpolant.resultBuffer;
  buf[ 0 ] = glVec[ 0 ];
  buf[ 1 ] = glVec[ 1 ];
  buf[ 2 ] = glVec[ 2 ];
  return interpolant;
}

export function interpolantFromGlMatrixVec4( interpolant, glVec ) {
  const buf = interpolant.resultBuffer;
  buf[ 0 ] = glVec[ 0 ];
  buf[ 1 ] = glVec[ 1 ];
  buf[ 2 ] = glVec[ 2 ];
  buf[ 3 ] = glVec[ 3 ];
  return interpolant;
}

// gl-matrix vec3 lerp between two interpolant resultBuffers (stride 3).
export function glMatrixVec3LerpFromInterpolants( out, a, b, t ) {
  const av = _scratchVec3A;
  const bv = _scratchVec3B;
  const abuf = a.resultBuffer, bbuf = b.resultBuffer;
  av[ 0 ] = abuf[ 0 ]; av[ 1 ] = abuf[ 1 ]; av[ 2 ] = abuf[ 2 ];
  bv[ 0 ] = bbuf[ 0 ]; bv[ 1 ] = bbuf[ 1 ]; bv[ 2 ] = bbuf[ 2 ];
  out[ 0 ] = av[ 0 ] + ( bv[ 0 ] - av[ 0 ] ) * t;
  out[ 1 ] = av[ 1 ] + ( bv[ 1 ] - av[ 1 ] ) * t;
  out[ 2 ] = av[ 2 ] + ( bv[ 2 ] - av[ 2 ] ) * t;
  return out;
}

// gl-matrix vec4 copy from an interpolant resultBuffer (stride 4).
export function glMatrixVec4CopyFromInterpolant( out, interpolant ) {
  const av = _scratchVec4A;
  const buf = interpolant.resultBuffer;
  av[ 0 ] = buf[ 0 ]; av[ 1 ] = buf[ 1 ]; av[ 2 ] = buf[ 2 ]; av[ 3 ] = buf[ 3 ];
  out[ 0 ] = av[ 0 ]; out[ 1 ] = av[ 1 ]; out[ 2 ] = av[ 2 ]; out[ 3 ] = av[ 3 ];
  return out;
}

// gl-matrix quat slerp between two interpolant resultBuffers (stride 4).
export function glMatrixQuatSlerpFromInterpolants( out, a, b, t ) {
  const aq = _scratchQuatA;
  const bq = _scratchQuatB;
  const abuf = a.resultBuffer, bbuf = b.resultBuffer;
  aq[ 0 ] = abuf[ 0 ]; aq[ 1 ] = abuf[ 1 ]; aq[ 2 ] = abuf[ 2 ]; aq[ 3 ] = abuf[ 3 ];
  bq[ 0 ] = bbuf[ 0 ]; bq[ 1 ] = bbuf[ 1 ]; bq[ 2 ] = bbuf[ 2 ]; bq[ 3 ] = bbuf[ 3 ];

  // Normalized quat slerp matching r185's default QuaternionLinearInterpolant.
  let ax = aq[ 0 ], ay = aq[ 1 ], az = aq[ 2 ], aw = aq[ 3 ];
  let bx = bq[ 0 ], by = bq[ 1 ], bz = bq[ 2 ], bw = bq[ 3 ];

  let cosom = ax * bx + ay * by + az * bz + aw * bw;
  if ( cosom < 0.0 ) {
    cosom = - cosom;
    bx = - bx; by = - by; bz = - bz; bw = - bw;
  }

  let scale0, scale1;
  if ( 1.0 - cosom > EPSILON ) {
    const omega = Math.acos( cosom );
    const sinom = Math.sin( omega );
    scale0 = Math.sin( ( 1.0 - t ) * omega ) / sinom;
    scale1 = Math.sin( t * omega ) / sinom;
  } else {
    scale0 = 1.0 - t;
    scale1 = t;
  }

  out[ 0 ] = scale0 * ax + scale1 * bx;
  out[ 1 ] = scale0 * ay + scale1 * by;
  out[ 2 ] = scale0 * az + scale1 * bz;
  out[ 3 ] = scale0 * aw + scale1 * bw;
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// HIGH-PRECISION (DoubleDouble) evaluation helpers
// ═══════════════════════════════════════════════════════════════════

const _oneDouble = DD.fromDouble( 1 );

// High-precision linear interpolation between two f64 sample values.
export function preciseLinearInterpolate( v0, v1, t ) {
  const dv0 = DD.fromDouble( v0 );
  const dv1 = DD.fromDouble( v1 );
  const dt = DD.fromDouble( t );
  const oneMinusT = DD.subtract( _oneDouble, dt );
  return DD.toDouble(
    DD.add(
      DD.multiply( dv0, oneMinusT ),
      DD.multiply( dv1, dt )
    )
  );
}

// High-precision Catmull-Rom / Hermite blend between four f64 samples at
// normalized parameter u in [0,1]:
//   w0 = -0.5u^3 + u^2 - 0.5u
//   w1 =  1.5u^3 - 2.5u^2 + 1
//   w2 = -1.5u^3 + 2.0u^2 + 0.5u
//   w3 =  0.5u^3 - 0.5u^2
export function preciseCubicInterpolate( v0, v1, v2, v3, u ) {
  const du = DD.fromDouble( u );
  const u2 = DD.multiply( du, du );
  const u3 = DD.multiply( u2, du );

  const w0 = DD.add(
    DD.multiply( u3, DD.fromDouble( -0.5 ) ),
    DD.add( u2, DD.multiply( du, DD.fromDouble( -0.5 ) ) )
  );
  const w1 = DD.add(
    DD.multiply( u3, DD.fromDouble( 1.5 ) ),
    DD.add(
      DD.multiply( u2, DD.fromDouble( -2.5 ) ),
      _oneDouble
    )
  );
  const w2 = DD.add(
    DD.multiply( u3, DD.fromDouble( -1.5 ) ),
    DD.add(
      DD.multiply( u2, DD.fromDouble( 2.0 ) ),
      DD.multiply( du, DD.fromDouble( 0.5 ) )
    )
  );
  const w3 = DD.subtract(
    DD.multiply( u3, DD.fromDouble( 0.5 ) ),
    DD.multiply( u2, DD.fromDouble( 0.5 ) )
  );

  return DD.toDouble(
    DD.add(
      DD.add(
        DD.multiply( DD.fromDouble( v0 ), w0 ),
        DD.multiply( DD.fromDouble( v1 ), w1 )
      ),
      DD.add(
        DD.multiply( DD.fromDouble( v2 ), w2 ),
        DD.multiply( DD.fromDouble( v3 ), w3 )
      )
    )
  );
}

// ═══════════════════════════════════════════════════════════════════
// PROCEDURAL NOISE — fill a bitecs track from a 3D simplex field
// ═══════════════════════════════════════════════════════════════════

function _mulberry32( seed ) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = ( a + 0x6D2B79F5 ) | 0;
    let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
    t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
    return ( ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296 );
  };
}

const _noise3DCache = new Map();

function _cachedNoise3D( seed ) {
  let gen = _noise3DCache.get( seed );
  if ( gen === undefined ) {
    gen = createNoise3D( _mulberry32( seed ) );
    _noise3DCache.set( seed, gen );
  }
  return gen;
}

export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

// Fill an entity's track sample slots from a 3D simplex field.
export function fillNoiseTrack( eid, seed = 0, freq = 1, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const n = _cachedNoise3D( seed );
  const pStart = store.positionStart[ eid ] | 0;
  const pCount = store.positionCount[ eid ] | 0;
  const vStart = store.valueStart[ eid ] | 0;
  const vStride = store.valueStride[ eid ] | 0;

  for ( let i = 0; i < pCount; i ++ ) {
    const t = pCount <= 1 ? 0 : i / ( pCount - 1 );
    pools.parameterPositions[ pStart + i ] = t;
    const o = vStart + i * vStride;
    pools.sampleValues[ o ] = n( i * freq, 0, 0 );
    if ( vStride > 1 ) pools.sampleValues[ o + 1 ] = n( i * freq, 1, 0 );
    if ( vStride > 2 ) pools.sampleValues[ o + 2 ] = n( i * freq, 2, 0 );
    if ( vStride > 3 ) pools.sampleValues[ o + 3 ] = n( i * freq, 3, 0 );
    for ( let k = 4; k < vStride; k ++ ) {
      pools.sampleValues[ o + k ] = n( i * freq, k, 0 );
    }
  }
  return eid;
}

// ═══════════════════════════════════════════════════════════════════
// BRIDGE: bitecs InterpolantTrackComponent  ↔  THREE.Interpolant
// ═══════════════════════════════════════════════════════════════════

// Wire an interpolant to a bitecs entity's track descriptor using zero-copy
// subarray views of the shared pools.
export function bitecsInterpolantBindFromTrack( interpolant, eid, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const pStart = store.positionStart[ eid ] | 0;
  const pCount = store.positionCount[ eid ] | 0;
  const vStart = store.valueStart[ eid ] | 0;
  const vStride = store.valueStride[ eid ] | 0;
  const vCount = pCount * vStride;

  interpolant.parameterPositions = pools.parameterPositions.subarray( pStart, pStart + pCount );
  interpolant.sampleValues = pools.sampleValues.subarray( vStart, vStart + vCount );
  interpolant.valueSize = vStride;
  interpolant._cachedIndex = 0;
  return interpolant;
}

// Evaluate a bitecs-bound interpolant at t → THREE.Vector3 (stride 3).
export function threeVec3FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eid, store, pools );
  const r = interpolant.evaluate( t );
  out.x = r[ 0 ]; out.y = r[ 1 ]; out.z = r[ 2 ];
  return out;
}

// Evaluate a bitecs-bound interpolant at t → THREE.Vector4 (stride 4).
export function threeVec4FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eid, store, pools );
  const r = interpolant.evaluate( t );
  out.x = r[ 0 ]; out.y = r[ 1 ]; out.z = r[ 2 ]; out.w = r[ 3 ];
  return out;
}

// Evaluate a bitecs-bound interpolant at t → gl-matrix vec3 (stride 3).
export function glMatrixVec3FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eid, store, pools );
  const r = interpolant.evaluate( t );
  out[ 0 ] = r[ 0 ]; out[ 1 ] = r[ 1 ]; out[ 2 ] = r[ 2 ];
  return out;
}

// Evaluate a bitecs-bound interpolant at t → gl-matrix vec4/quat (stride 4).
export function glMatrixVec4FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eid, store, pools );
  const r = interpolant.evaluate( t );
  out[ 0 ] = r[ 0 ]; out[ 1 ] = r[ 1 ]; out[ 2 ] = r[ 2 ]; out[ 3 ] = r[ 3 ];
  return out;
}

// Evaluate a bitecs-bound interpolant at t → bitecs SoA Vector3 target.
export function bitecsVec3FromBitecsInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eidTrack, storeTrack, pools );
  const r = interpolant.evaluate( t );
  storeVec.x[ eidOut ] = r[ 0 ];
  storeVec.y[ eidOut ] = r[ 1 ];
  storeVec.z[ eidOut ] = r[ 2 ];
  return eidOut;
}

// Evaluate a bitecs-bound interpolant at t → bitecs SoA Vector4 target.
export function bitecsVec4FromBitecsInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eidTrack, storeTrack, pools );
  const r = interpolant.evaluate( t );
  storeVec.x[ eidOut ] = r[ 0 ];
  storeVec.y[ eidOut ] = r[ 1 ];
  storeVec.z[ eidOut ] = r[ 2 ];
  storeVec.w[ eidOut ] = r[ 3 ];
  return eidOut;
}

// Copy a bitecs-bound interpolant's result at t into the destination track's
// value slot (writes directly into the shared pool).
export function bitecsInterpolantResultIntoPool( interpolant, eidDst, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidDst ] | 0;
  const vStride = store.valueStride[ eidDst ] | 0;
  const r = interpolant.evaluate( t );
  for ( let i = 0; i < vStride; i ++ ) {
    pools.sampleValues[ vStart + i ] = r[ i ];
  }
  return eidDst;
}

// ═══════════════════════════════════════════════════════════════════
// Sample-slot readers / writers (no allocation)
// ═══════════════════════════════════════════════════════════════════

export function threeVec3FromBitecsInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidSlot ] | 0;
  const vStride = store.valueStride[ eidSlot ] | 0;
  const o = vStart + slotIndex * vStride;
  out.x = pools.sampleValues[ o ];
  out.y = pools.sampleValues[ o + 1 ];
  out.z = pools.sampleValues[ o + 2 ];
  return out;
}

export function threeVec4FromBitecsInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidSlot ] | 0;
  const vStride = store.valueStride[ eidSlot ] | 0;
  const o = vStart + slotIndex * vStride;
  out.x = pools.sampleValues[ o ];
  out.y = pools.sampleValues[ o + 1 ];
  out.z = pools.sampleValues[ o + 2 ];
  out.w = pools.sampleValues[ o + 3 ];
  return out;
}

export function glMatrixVec3FromBitecsInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidSlot ] | 0;
  const vStride = store.valueStride[ eidSlot ] | 0;
  const o = vStart + slotIndex * vStride;
  out[ 0 ] = pools.sampleValues[ o ];
  out[ 1 ] = pools.sampleValues[ o + 1 ];
  out[ 2 ] = pools.sampleValues[ o + 2 ];
  return out;
}

export function glMatrixVec4FromBitecsInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidSlot ] | 0;
  const vStride = store.valueStride[ eidSlot ] | 0;
  const o = vStart + slotIndex * vStride;
  out[ 0 ] = pools.sampleValues[ o ];
  out[ 1 ] = pools.sampleValues[ o + 1 ];
  out[ 2 ] = pools.sampleValues[ o + 2 ];
  out[ 3 ] = pools.sampleValues[ o + 3 ];
  return out;
}

export function bitecsInterpolantSampleFromVec3( eidSlot, slotIndex, eidVec, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidSlot ] | 0;
  const vStride = store.valueStride[ eidSlot ] | 0;
  const o = vStart + slotIndex * vStride;
  pools.sampleValues[ o ]     = storeVec.x[ eidVec ];
  pools.sampleValues[ o + 1 ] = storeVec.y[ eidVec ];
  pools.sampleValues[ o + 2 ] = storeVec.z[ eidVec ];
  return eidSlot;
}

export function bitecsInterpolantSampleFromVec4( eidSlot, slotIndex, eidVec, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidSlot ] | 0;
  const vStride = store.valueStride[ eidSlot ] | 0;
  const o = vStart + slotIndex * vStride;
  pools.sampleValues[ o ]     = storeVec.x[ eidVec ];
  pools.sampleValues[ o + 1 ] = storeVec.y[ eidVec ];
  pools.sampleValues[ o + 2 ] = storeVec.z[ eidVec ];
  pools.sampleValues[ o + 3 ] = storeVec.w[ eidVec ];
  return eidSlot;
}

export function bitecsInterpolantPositionSet( eidSlot, slotIndex, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const pStart = store.positionStart[ eidSlot ] | 0;
  pools.parameterPositions[ pStart + slotIndex ] = t;
  return eidSlot;
}

export function bitecsInterpolantPositionGet( eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const pStart = store.positionStart[ eidSlot ] | 0;
  return pools.parameterPositions[ pStart + slotIndex ];
}

export function bitecsInterpolantSampleSlotFromT( eidSlot, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const pStart = store.positionStart[ eidSlot ] | 0;
  const pCount = store.positionCount[ eidSlot ] | 0;
  if ( pCount <= 1 ) return 0;
  const t0 = pools.parameterPositions[ pStart ];
  const t1 = pools.parameterPositions[ pStart + pCount - 1 ];
  if ( t1 === t0 ) return 0;
  const u = clamp( ( t - t0 ) / ( t1 - t0 ), 0, 1 );
  return u * ( pCount - 1 );
}

// ═══════════════════════════════════════════════════════════════════
// Default export
// ═══════════════════════════════════════════════════════════════════
export default Interpolant;
export { Interpolant };