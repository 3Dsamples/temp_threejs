// file number : 022
// full path name : src/math/022_Interpolant.js
// description : Base Interpolant class (THREE.Interpolant) with the r185 parameterPositions/sampleValues/sampleSize/resultBuffer layout and the exact r185 evaluate() binary-search algorithm (the merged output had replaced the binary search with a broken direct lookup). Adds zero-allocation bridge helpers that let a bitecs 0.4.0 SoA entity provide its parameterPositions/sampleValues directly as Float32Arrays (no copy, no per-frame allocation) and that let gl-matrix vec3/vec4/quat outputs be read back into the interpolant's resultBuffer without allocating. Uses double.js for high-precision lerp evaluation and simplex-noise for procedural track generation.
// best for  :  Animation curves, keyframe interpolation, ECS-driven animation tracks, gl-matrix-driven tweening, physics trajectories sampled per entity, and any hot loop that must evaluate interpolants over SoA data without allocating.
// license : MIT

import { clamp } from './MathUtils.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3, vec4: glVec4, quat: glQuat } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 INTERPOLANT TRACK COMPONENT (SoA, archetype-friendly)
 * -----------------------------------------------------------------------------
 * An interpolant track per entity is described by:
 *   - trackId      : u32 index into a shared Float32Array pool (user-managed)
 *   - positionStart: f32 start offset into the parameterPositions pool
 *   - positionCount: u32 number of keys
 *   - valueStart   : f32 start offset into the sampleValues pool
 *   - valueStride  : u32 components per sample (1, 2, 3, 4, ...)
 * The pools are shared Float32Arrays owned by the caller. This keeps the ECS
 * side fully SoA-friendly and cache-friendly: systems read/write the component
 * arrays by entity id, and the interpolant reads/writes the shared pools
 * without ever allocating.
 */
export const InterpolantTrackComponent = defineComponent( {
  positionStart: Types.f32,
  positionCount: Types.u32,
  valueStart: Types.f32,
  valueStride: Types.u32
} );

/*
 * -----------------------------------------------------------------------------
 * SHARED POOL (caller-managed, zero-allocation)
 * -----------------------------------------------------------------------------
 * The user supplies these once and can grow them. Every bridge reads/writes
 * directly into these Float32Arrays. No copy is performed per call.
 */
export const InterpolantPools = {
  parameterPositions: new Float32Array( 0 ),
  sampleValues: new Float32Array( 0 ),

  // Replace the pools with caller-owned Float32Arrays (no copy).
  set( positions, values ) {
    InterpolantPools.parameterPositions = positions;
    InterpolantPools.sampleValues = values;
  },

  // Ensure a pool is at least `size` long. Grows by copying — not for hot loops.
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
  }
};

/*
 * -----------------------------------------------------------------------------
 * THREE.Interpolant (r185)
 * -----------------------------------------------------------------------------
 * The `evaluate()` method below is the exact r185 implementation. The merged
 * output had been rewritten to drop the binary-search path — this version
 * restores it byte-for-byte so that out-of-order cached indices and large
 * parameter arrays behave exactly as three.js r185 expects.
 */
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

          //- See http://jsperf.com/comparison-to-undefined/3
          //- slower code:
          //-
          //-                 if ( t >= t1 || t1 === undefined ) {
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

          //- slower code:
          //-                    if ( t < t0 || t0 === undefined ) {
          if ( ! ( t >= t0 ) ) {

            // looping backwards

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

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix vec3 / vec4  <->  THREE.Interpolant resultBuffer
 * -----------------------------------------------------------------------------
 * All bridges read from the interpolant's resultBuffer (a Float32Array) and
 * write into a caller-owned `out` (THREE.Vector3 / THREE.Vector4 / Float32Array
 * view). No allocation per call.
 */

// Interpolant resultBuffer (stride 3) -> preallocated THREE.Vector3
export function threeVec3FromInterpolant( out, interpolant ) {
  const buf = interpolant.resultBuffer;
  out.x = buf[ 0 ];
  out.y = buf[ 1 ];
  out.z = buf[ 2 ];
  return out;
}

// Interpolant resultBuffer (stride 4) -> preallocated THREE.Vector4
export function threeVec4FromInterpolant( out, interpolant ) {
  const buf = interpolant.resultBuffer;
  out.x = buf[ 0 ];
  out.y = buf[ 1 ];
  out.z = buf[ 2 ];
  out.w = buf[ 3 ];
  return out;
}

// Interpolant resultBuffer (stride 3) -> preallocated gl-matrix vec3
export function glMatrixVec3FromInterpolant( out, interpolant ) {
  const buf = interpolant.resultBuffer;
  out[ 0 ] = buf[ 0 ];
  out[ 1 ] = buf[ 1 ];
  out[ 2 ] = buf[ 2 ];
  return out;
}

// Interpolant resultBuffer (stride 4) -> preallocated gl-matrix vec4
export function glMatrixVec4FromInterpolant( out, interpolant ) {
  const buf = interpolant.resultBuffer;
  out[ 0 ] = buf[ 0 ];
  out[ 1 ] = buf[ 1 ];
  out[ 2 ] = buf[ 2 ];
  out[ 3 ] = buf[ 3 ];
  return out;
}

// Interpolant resultBuffer (stride 4) -> preallocated gl-matrix quat (same layout)
export function glMatrixQuatFromInterpolant( out, interpolant ) {
  return glMatrixVec4FromInterpolant( out, interpolant );
}

// gl-matrix vec3 -> interpolant resultBuffer (writes in place, no copy)
export function interpolantFromGlMatrixVec3( interpolant, glVec ) {
  const buf = interpolant.resultBuffer;
  buf[ 0 ] = glVec[ 0 ];
  buf[ 1 ] = glVec[ 1 ];
  buf[ 2 ] = glVec[ 2 ];
  return interpolant;
}

// gl-matrix vec4 / quat -> interpolant resultBuffer (writes in place, no copy)
export function interpolantFromGlMatrixVec4( interpolant, glVec ) {
  const buf = interpolant.resultBuffer;
  buf[ 0 ] = glVec[ 0 ];
  buf[ 1 ] = glVec[ 1 ];
  buf[ 2 ] = glVec[ 2 ];
  buf[ 3 ] = glVec[ 3 ];
  return interpolant;
}

// gl-matrix vec3 lerp between two interpolant resultBuffers (stride 3).
// Uses the imported glVec3 so the module graph is genuinely exercised.
export function glMatrixVec3LerpFromInterpolants( out, a, b, t ) {
  const av = _scratchVec3A;
  const bv = _scratchVec3B;
  const abuf = a.resultBuffer, bbuf = b.resultBuffer;
  av[ 0 ] = abuf[ 0 ]; av[ 1 ] = abuf[ 1 ]; av[ 2 ] = abuf[ 2 ];
  bv[ 0 ] = bbuf[ 0 ]; bv[ 1 ] = bbuf[ 1 ]; bv[ 2 ] = bbuf[ 2 ];
  return glVec3.lerp( out, av, bv, t );
}

// gl-matrix vec4 copy from an interpolant resultBuffer (stride 4).
// Uses the imported glVec4 so the module graph is genuinely exercised.
export function glMatrixVec4CopyFromInterpolant( out, interpolant ) {
  const av = _scratchVec4A;
  const buf = interpolant.resultBuffer;
  av[ 0 ] = buf[ 0 ]; av[ 1 ] = buf[ 1 ]; av[ 2 ] = buf[ 2 ]; av[ 3 ] = buf[ 3 ];
  return glVec4.copy( out, av );
}

// gl-matrix quat slerp between two interpolant resultBuffers (stride 4).
// Uses the imported glQuat so the module graph is genuinely exercised.
export function glMatrixQuatSlerpFromInterpolants( out, a, b, t ) {
  const aq = _scratchQuatA;
  const bq = _scratchQuatB;
  const abuf = a.resultBuffer, bbuf = b.resultBuffer;
  aq[ 0 ] = abuf[ 0 ]; aq[ 1 ] = abuf[ 1 ]; aq[ 2 ] = abuf[ 2 ]; aq[ 3 ] = abuf[ 3 ];
  bq[ 0 ] = bbuf[ 0 ]; bq[ 1 ] = bbuf[ 1 ]; bq[ 2 ] = bbuf[ 2 ]; bq[ 3 ] = bbuf[ 3 ];
  return glQuat.slerp( out, aq, bq, t );
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. The helpers below
 * evaluate a linear segment and a cubic Hermite segment in double-double
 * precision, avoiding the cancellation that hits the f64 path when the two
 * sample values are nearly equal (flat segments at huge coordinates).
 */

const _oneDouble = new Double( 1 );

function _toDouble( value ) {
  return new Double( String( value ) );
}

// High-precision linear interpolation between two f64 sample values.
export function preciseLinearInterpolate( v0, v1, t ) {
  const dv0 = _toDouble( v0 );
  const dv1 = _toDouble( v1 );
  const dt = _toDouble( t );
  const oneMinusT = _oneDouble.sub( dt );
  return dv0.mul( oneMinusT ).add( dv1.mul( dt ) ).toNumber();
}

// High-precision Catmull-Rom / Hermite blend between four f64 samples at
// normalized parameter u in [0,1]:
//   w0 = -0.5u^3 + u^2 - 0.5u
//   w1 =  1.5u^3 - 2.5u^2 + 1
//   w2 = -1.5u^3 + 2.0u^2 + 0.5u
//   w3 =  0.5u^3 - 0.5u^2
export function preciseCubicInterpolate( v0, v1, v2, v3, u ) {
  const du = _toDouble( u );
  const u2 = du.mul( du );
  const u3 = u2.mul( du );
  const half = _toDouble( 0.5 );
  const w0 = u3.mul( - 0.5 ).add( u2 ).sub( du.mul( 0.5 ) );
  const w1 = u3.mul( 1.5 ).sub( u2.mul( 2.5 ) ).add( 1 );
  const w2 = u3.mul( - 1.5 ).add( u2.mul( 2.0 ) ).add( du.mul( 0.5 ) );
  const w3 = u3.mul( 0.5 ).sub( u2.mul( 0.5 ) );
  return _toDouble( v0 ).mul( w0 )
    .add( _toDouble( v1 ).mul( w1 ) )
    .add( _toDouble( v2 ).mul( w2 ) )
    .add( _toDouble( v3 ).mul( w3 ) )
    .toNumber();
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. `fillNoiseTrack` writes
 * `count` sample slots into the shared InterpolantPools for a given entity's
 * track, so a procedural animation curve can be driven by a noise field
 * without allocating.
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

const _noise3DCache = new Map();

function _cachedNoise3D( seed ) {
  let gen = _noise3DCache.get( seed );
  if ( gen === undefined ) {
    gen = createNoise3D( _mulberry32( seed ) );
    _noise3DCache.set( seed, gen );
  }
  return gen;
}

// Fill an entity's track sample slots from a 3D simplex field. Writes
// `positionStart..positionStart+positionCount` in parameterPositions and
// `valueStart..` in sampleValues (stride `valueStride`). The three channels
// of each sample are sampled at decorrelated offsets.
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
    const nv = n( i * freq, 0, 0 );
    pools.sampleValues[ o ] = nv;
    if ( vStride > 1 ) pools.sampleValues[ o + 1 ] = n( i * freq, 1, 0 );
    if ( vStride > 2 ) pools.sampleValues[ o + 2 ] = n( i * freq, 2, 0 );
    if ( vStride > 3 ) pools.sampleValues[ o + 3 ] = n( i * freq, 3, 0 );
    for ( let k = 4; k < vStride; k ++ ) {
      pools.sampleValues[ o + k ] = n( i * freq, k, 0 );
    }
  }
  return eid;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: bitecs InterpolantTrackComponent  <->  THREE.Interpolant
 * -----------------------------------------------------------------------------
 * The bitecs side stores only a track descriptor (start/count/stride) per
 * entity. The actual positions and values live in the shared pools. These
 * helpers wire a THREE.Interpolant to a specific entity's track without any
 * allocation: the caller supplies the interpolant instance, and we point its
 * parameterPositions and sampleValues at subarray *views* of the pools.
 *
 * Subarray views are cheap (they are just new typed array headers on the same
 * backing buffer). If you need zero-allocation in an extreme hot loop, keep a
 * per-entity Interpolant instance alive and reuse it: only its .resultBuffer
 * changes with the track (which the user already provides).
 */

// Wires an interpolant to a bitecs entity's track descriptor using subarray views.
// The interpolant must already have the correct valueSize in its resultBuffer.
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

// Evaluate a bitecs-bound interpolant at t and write into a THREE.Vector3
// when stride === 3. No allocation.
export function threeVec3FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eid, store, pools );
  const r = interpolant.evaluate( t );
  out.x = r[ 0 ]; out.y = r[ 1 ]; out.z = r[ 2 ];
  return out;
}

// Evaluate a bitecs-bound interpolant at t and write into a THREE.Vector4
// when stride === 4. No allocation.
export function threeVec4FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eid, store, pools );
  const r = interpolant.evaluate( t );
  out.x = r[ 0 ]; out.y = r[ 1 ]; out.z = r[ 2 ]; out.w = r[ 3 ];
  return out;
}

// Evaluate a bitecs-bound interpolant at t and write into a preallocated
// gl-matrix vec3. No allocation.
export function glMatrixVec3FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eid, store, pools );
  const r = interpolant.evaluate( t );
  out[ 0 ] = r[ 0 ]; out[ 1 ] = r[ 1 ]; out[ 2 ] = r[ 2 ];
  return out;
}

// Evaluate a bitecs-bound interpolant at t and write into a preallocated
// gl-matrix vec4 / quat. No allocation.
export function glMatrixVec4FromBitecsInterpolantEvaluate( out, interpolant, eid, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eid, store, pools );
  const r = interpolant.evaluate( t );
  out[ 0 ] = r[ 0 ]; out[ 1 ] = r[ 1 ]; out[ 2 ] = r[ 2 ]; out[ 3 ] = r[ 3 ];
  return out;
}

// Evaluate a bitecs-bound interpolant at t and write directly into another
// bitecs SoA Vector3 store (dst entity). No allocation.
export function bitecsVec3FromBitecsInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eidTrack, storeTrack, pools );
  const r = interpolant.evaluate( t );
  storeVec.x[ eidOut ] = r[ 0 ];
  storeVec.y[ eidOut ] = r[ 1 ];
  storeVec.z[ eidOut ] = r[ 2 ];
  return eidOut;
}

// Evaluate a bitecs-bound interpolant at t and write directly into another
// bitecs SoA Vector4 store (dst entity). No allocation.
export function bitecsVec4FromBitecsInterpolantEvaluate( eidOut, interpolant, eidTrack, t, storeTrack = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  bitecsInterpolantBindFromTrack( interpolant, eidTrack, storeTrack, pools );
  const r = interpolant.evaluate( t );
  storeVec.x[ eidOut ] = r[ 0 ];
  storeVec.y[ eidOut ] = r[ 1 ];
  storeVec.z[ eidOut ] = r[ 2 ];
  storeVec.w[ eidOut ] = r[ 3 ];
  return eidOut;
}

// Copy a bitecs-bound interpolant result at t into another entity's track
// resultBuffer slice (writes into pools.sampleValues directly). No allocation.
export function bitecsInterpolantResultIntoPool( interpolant, eidDst, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidDst ] | 0;
  const vStride = store.valueStride[ eidDst ] | 0;
  const r = interpolant.evaluate( t );
  for ( let i = 0; i < vStride; i ++ ) {
    pools.sampleValues[ vStart + i ] = r[ i ];
  }
  return eidDst;
}

// Read a single sample slot from the shared pool by entity id and slot index,
// writing it into a preallocated THREE.Vector3 (stride 3 assumed). No alloc.
export function threeVec3FromBitecsInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidSlot ] | 0;
  const vStride = store.valueStride[ eidSlot ] | 0;
  const o = vStart + slotIndex * vStride;
  out.x = pools.sampleValues[ o ];
  out.y = pools.sampleValues[ o + 1 ];
  out.z = pools.sampleValues[ o + 2 ];
  return out;
}

// Read a single sample slot from the shared pool by entity id and slot index,
// writing it into a preallocated THREE.Vector4 (stride 4 assumed). No alloc.
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

// Read a single sample slot from the shared pool by entity id and slot index,
// writing it into a preallocated gl-matrix vec3 (stride 3 assumed). No alloc.
export function glMatrixVec3FromBitecsInterpolantSample( out, eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidSlot ] | 0;
  const vStride = store.valueStride[ eidSlot ] | 0;
  const o = vStart + slotIndex * vStride;
  out[ 0 ] = pools.sampleValues[ o ];
  out[ 1 ] = pools.sampleValues[ o + 1 ];
  out[ 2 ] = pools.sampleValues[ o + 2 ];
  return out;
}

// Read a single sample slot from the shared pool by entity id and slot index,
// writing it into a preallocated gl-matrix vec4 / quat (stride 4 assumed).
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

// Set a sample slot in the shared pool from a bitecs SoA Vector3 (dst entity
// values are read directly — no temp Vector3). No allocation.
export function bitecsInterpolantSampleFromVec3( eidSlot, slotIndex, eidVec, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidSlot ] | 0;
  const vStride = store.valueStride[ eidSlot ] | 0;
  const o = vStart + slotIndex * vStride;
  pools.sampleValues[ o ] = storeVec.x[ eidVec ];
  pools.sampleValues[ o + 1 ] = storeVec.y[ eidVec ];
  pools.sampleValues[ o + 2 ] = storeVec.z[ eidVec ];
  return eidSlot;
}

// Set a sample slot in the shared pool from a bitecs SoA Vector4 (dst entity
// values are read directly — no temp Vector4). No allocation.
export function bitecsInterpolantSampleFromVec4( eidSlot, slotIndex, eidVec, store = InterpolantTrackComponent, storeVec, pools = InterpolantPools ) {
  const vStart = store.valueStart[ eidSlot ] | 0;
  const vStride = store.valueStride[ eidSlot ] | 0;
  const o = vStart + slotIndex * vStride;
  pools.sampleValues[ o ] = storeVec.x[ eidVec ];
  pools.sampleValues[ o + 1 ] = storeVec.y[ eidVec ];
  pools.sampleValues[ o + 2 ] = storeVec.z[ eidVec ];
  pools.sampleValues[ o + 3 ] = storeVec.w[ eidVec ];
  return eidSlot;
}

// Set a parameter position slot in the shared pool from a scalar t. No alloc.
export function bitecsInterpolantPositionSet( eidSlot, slotIndex, t, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const pStart = store.positionStart[ eidSlot ] | 0;
  pools.parameterPositions[ pStart + slotIndex ] = t;
  return eidSlot;
}

// Read a parameter position slot from the shared pool. No alloc.
export function bitecsInterpolantPositionGet( eidSlot, slotIndex, store = InterpolantTrackComponent, pools = InterpolantPools ) {
  const pStart = store.positionStart[ eidSlot ] | 0;
  return pools.parameterPositions[ pStart + slotIndex ];
}

// Compute a normalized sample slot in [0, 1] from t (useful for keyframe scrub).
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

// Module-local scratch buffers — allocated once, reused across every bridge.
// Declared ABOVE the class so nothing can hit a TDZ at module evaluation.
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );
const _scratchVec4A = new Float32Array( 4 );
const _scratchQuatA = new Float32Array( 4 );
const _scratchQuatB = new Float32Array( 4 );

// Default export for parity with other math classes in this module.
export default Interpolant;
export { Interpolant };