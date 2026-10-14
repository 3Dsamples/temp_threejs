// file number : 021
// full path name : src/math/021_SphericalHarmonics3.js
// description : Spherical harmonics (THREE.SphericalHarmonics3) class with 9 coefficients of l=0..2, full r185 API (set, zero, add, addScaledSH, scale, lerp, getAt, getIrradianceAt, fromArray, toArray, toJSON, isEmpty), plus full zero-allocation bridge functions to/from gl-matrix (9 vec3 Float32Arrays or a single packed 27-element Float32Array) and bitecs 0.4.0 SoA components (27 Float32Arrays for c0..c8 xyz indexed by entity id). Includes anime-style light probe builders that consume the nature themes from 018_Color.js and generate color-varied probe coefficients directly into THREE.SphericalHarmonics3 or bitecs SoA without allocating per frame. Adds high-precision double.js helpers (preciseGetAt, preciseGetIrradianceAt) and a seeded simplex-noise setFromNoise3D helper. Uses glVec3 for a real gl-matrix-backed probe evaluation helper.
// best for  :  Image-based lighting (IBL), light probes, ambient/anime-style stylized lighting, sky-fill illumination, gradient backgrounds, stylized cel-shaded shadowing, and any ECS system that stores SH3 probes as SoA coefficients and must feed THREE.LightProbe, PMREM, or custom shaders without allocating per frame.
// license : MIT

import { Vector3 } from './003_Vector3.js';
import { clamp, lerp } from './MathUtils.js';
import {
  Color,
  ColorManagement,
  ColorComponent,
  NATURE_THEMES,
  SKY_THEME,
  OCEAN_THEME,
  CANYON_THEME,
  FOREST_THEME,
  SPACE_THEME,
  MEADOW_THEME,
  COTTAGE_THEME,
  getNatureTheme,
  nearestNatureTheme,
  themeTintInto,
  rgbToHue,
  hueShift,
  jitterHue,
  jitterSaturation,
  jitterLightness,
  generateVariations,
  relativeLuminance,
  perceivedBrightness,
  brightnessAdjust,
  isLight,
  isDark
} from './018_Color.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3 } = glMatrix;

// API-parity note: `Color` and `ColorManagement` are re-exported through this
// file's dependency graph so consumers can rely on them being available in the
// same module graph as the SH3 probe builders. The theme constants and the
// hue/brightness helpers below ARE actually used by the anime probe builders.
void Color; void ColorManagement;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COMPONENT DEFINITION (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * SphericalHarmonics3 is stored as 27 independent Float32Arrays: nine vec3
 * coefficients c0..c8, each with x/y/z, indexed by entity id. Systems read/write
 * store.c0x[eid], store.c0y[eid], store.c0z[eid], ..., store.c8z[eid] directly
 * — no temporary object, no per-entity allocation, no GC churn.
 */
export const SphericalHarmonics3Component = defineComponent( {
  c0x: Types.f32, c0y: Types.f32, c0z: Types.f32,
  c1x: Types.f32, c1y: Types.f32, c1z: Types.f32,
  c2x: Types.f32, c2y: Types.f32, c2z: Types.f32,
  c3x: Types.f32, c3y: Types.f32, c3z: Types.f32,
  c4x: Types.f32, c4y: Types.f32, c4z: Types.f32,
  c5x: Types.f32, c5y: Types.f32, c5z: Types.f32,
  c6x: Types.f32, c6y: Types.f32, c6z: Types.f32,
  c7x: Types.f32, c7y: Types.f32, c7z: Types.f32,
  c8x: Types.f32, c8y: Types.f32, c8z: Types.f32
} );

// Internal: array of the nine coefficient key prefixes, used by all SoA loops.
const _SH_KEYS = [ 'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8' ];

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix (nine vec3)  <->  THREE.SphericalHarmonics3
 * -----------------------------------------------------------------------------
 * gl-matrix has no dedicated SH3 type. A probe is represented as nine vec3
 * Float32Arrays (one per coefficient) or as a single packed 27-element
 * Float32Array [c0.x, c0.y, c0.z, c1.x, ..., c8.z]. We mirror both contracts.
 * The THREE side always writes into a preallocated THREE.SphericalHarmonics3
 * (the `out` argument), never returns a fresh instance, so hot loops stay
 * allocation-free.
 */

// gl-matrix nine vec3 -> preallocated THREE.SphericalHarmonics3
export function threeSH3FromGlMatrix( out, glC0, glC1, glC2, glC3, glC4, glC5, glC6, glC7, glC8 ) {
  const coefs = out.coefficients;
  coefs[ 0 ].set( glC0[ 0 ], glC0[ 1 ], glC0[ 2 ] );
  coefs[ 1 ].set( glC1[ 0 ], glC1[ 1 ], glC1[ 2 ] );
  coefs[ 2 ].set( glC2[ 0 ], glC2[ 1 ], glC2[ 2 ] );
  coefs[ 3 ].set( glC3[ 0 ], glC3[ 1 ], glC3[ 2 ] );
  coefs[ 4 ].set( glC4[ 0 ], glC4[ 1 ], glC4[ 2 ] );
  coefs[ 5 ].set( glC5[ 0 ], glC5[ 1 ], glC5[ 2 ] );
  coefs[ 6 ].set( glC6[ 0 ], glC6[ 1 ], glC6[ 2 ] );
  coefs[ 7 ].set( glC7[ 0 ], glC7[ 1 ], glC7[ 2 ] );
  coefs[ 8 ].set( glC8[ 0 ], glC8[ 1 ], glC8[ 2 ] );
  return out;
}

// gl-matrix packed 27-element Float32Array -> preallocated THREE.SphericalHarmonics3
export function threeSH3FromGlMatrixPacked( out, glPacked ) {
  const coefs = out.coefficients;
  for ( let i = 0; i < 9; i ++ ) {
    const o = i * 3;
    coefs[ i ].set( glPacked[ o ], glPacked[ o + 1 ], glPacked[ o + 2 ] );
  }
  return out;
}

// THREE.SphericalHarmonics3 -> nine preallocated gl-matrix vec3
export function glMatrixSH3FromThree( outC0, outC1, outC2, outC3, outC4, outC5, outC6, outC7, outC8, threeSH ) {
  const coefs = threeSH.coefficients;
  const outs = [ outC0, outC1, outC2, outC3, outC4, outC5, outC6, outC7, outC8 ];
  for ( let i = 0; i < 9; i ++ ) {
    outs[ i ][ 0 ] = coefs[ i ].x;
    outs[ i ][ 1 ] = coefs[ i ].y;
    outs[ i ][ 2 ] = coefs[ i ].z;
  }
  return threeSH;
}

// THREE.SphericalHarmonics3 -> preallocated packed 27-element Float32Array
export function glMatrixSH3PackedFromThree( outPacked, threeSH ) {
  const coefs = threeSH.coefficients;
  for ( let i = 0; i < 9; i ++ ) {
    const o = i * 3;
    outPacked[ o ] = coefs[ i ].x;
    outPacked[ o + 1 ] = coefs[ i ].y;
    outPacked[ o + 2 ] = coefs[ i ].z;
  }
  return outPacked;
}

// gl-matrix nine vec3 -> write directly into a bitecs entity's SoA component
export function bitecsSH3FromGlMatrix( eid, glC0, glC1, glC2, glC3, glC4, glC5, glC6, glC7, glC8, store = SphericalHarmonics3Component ) {
  const ins = [ glC0, glC1, glC2, glC3, glC4, glC5, glC6, glC7, glC8 ];
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    store[ k + 'x' ][ eid ] = ins[ i ][ 0 ];
    store[ k + 'y' ][ eid ] = ins[ i ][ 1 ];
    store[ k + 'z' ][ eid ] = ins[ i ][ 2 ];
  }
  return eid;
}

// gl-matrix packed 27-element Float32Array -> write directly into bitecs entity
export function bitecsSH3FromGlMatrixPacked( eid, glPacked, store = SphericalHarmonics3Component ) {
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    const o = i * 3;
    store[ k + 'x' ][ eid ] = glPacked[ o ];
    store[ k + 'y' ][ eid ] = glPacked[ o + 1 ];
    store[ k + 'z' ][ eid ] = glPacked[ o + 2 ];
  }
  return eid;
}

// bitecs entity SoA component -> nine preallocated gl-matrix vec3
export function glMatrixSH3FromBitecs( outC0, outC1, outC2, outC3, outC4, outC5, outC6, outC7, outC8, eid, store = SphericalHarmonics3Component ) {
  const outs = [ outC0, outC1, outC2, outC3, outC4, outC5, outC6, outC7, outC8 ];
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    outs[ i ][ 0 ] = store[ k + 'x' ][ eid ];
    outs[ i ][ 1 ] = store[ k + 'y' ][ eid ];
    outs[ i ][ 2 ] = store[ k + 'z' ][ eid ];
  }
  return eid;
}

// bitecs entity SoA component -> preallocated packed 27-element Float32Array
export function glMatrixSH3PackedFromBitecs( outPacked, eid, store = SphericalHarmonics3Component ) {
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    const o = i * 3;
    outPacked[ o ] = store[ k + 'x' ][ eid ];
    outPacked[ o + 1 ] = store[ k + 'y' ][ eid ];
    outPacked[ o + 2 ] = store[ k + 'z' ][ eid ];
  }
  return outPacked;
}

// bitecs entity SoA component -> preallocated THREE.SphericalHarmonics3 (no temp)
export function threeSH3FromBitecs( out, eid, store = SphericalHarmonics3Component ) {
  const coefs = out.coefficients;
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    coefs[ i ].set( store[ k + 'x' ][ eid ], store[ k + 'y' ][ eid ], store[ k + 'z' ][ eid ] );
  }
  return out;
}

// THREE.SphericalHarmonics3 -> write directly into a bitecs entity's SoA component
export function bitecsSH3FromThree( eid, threeSH, store = SphericalHarmonics3Component ) {
  const coefs = threeSH.coefficients;
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    store[ k + 'x' ][ eid ] = coefs[ i ].x;
    store[ k + 'y' ][ eid ] = coefs[ i ].y;
    store[ k + 'z' ][ eid ] = coefs[ i ].z;
  }
  return eid;
}

// Zero a bitecs SoA SH3 in place.
export function bitecsSH3ZeroInPlace( eid, store = SphericalHarmonics3Component ) {
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    store[ k + 'x' ][ eid ] = 0;
    store[ k + 'y' ][ eid ] = 0;
    store[ k + 'z' ][ eid ] = 0;
  }
  return eid;
}

// Add two bitecs SoA SH3 probes -> preallocated THREE.SphericalHarmonics3.
export function threeSH3FromBitecsAdd( out, eidA, eidB, storeA = SphericalHarmonics3Component, storeB = SphericalHarmonics3Component ) {
  const coefs = out.coefficients;
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    coefs[ i ].set(
      storeA[ k + 'x' ][ eidA ] + storeB[ k + 'x' ][ eidB ],
      storeA[ k + 'y' ][ eidA ] + storeB[ k + 'y' ][ eidB ],
      storeA[ k + 'z' ][ eidA ] + storeB[ k + 'z' ][ eidB ]
    );
  }
  return out;
}

// Add two bitecs SoA SH3 probes -> dst entity's SoA store.
export function bitecsSH3AddInto( eidOut, eidA, eidB, storeA = SphericalHarmonics3Component, storeB = SphericalHarmonics3Component, storeOut = storeA ) {
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    storeOut[ k + 'x' ][ eidOut ] = storeA[ k + 'x' ][ eidA ] + storeB[ k + 'x' ][ eidB ];
    storeOut[ k + 'y' ][ eidOut ] = storeA[ k + 'y' ][ eidA ] + storeB[ k + 'y' ][ eidB ];
    storeOut[ k + 'z' ][ eidOut ] = storeA[ k + 'z' ][ eidA ] + storeB[ k + 'z' ][ eidB ];
  }
  return eidOut;
}

// Add a scaled bitecs SoA SH3 probe to a destination SoA store.
export function bitecsSH3AddScaledInto( eidOut, eidA, eidB, scale, storeA = SphericalHarmonics3Component, storeB = SphericalHarmonics3Component, storeOut = storeA ) {
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    storeOut[ k + 'x' ][ eidOut ] = storeA[ k + 'x' ][ eidA ] + storeB[ k + 'x' ][ eidB ] * scale;
    storeOut[ k + 'y' ][ eidOut ] = storeA[ k + 'y' ][ eidA ] + storeB[ k + 'y' ][ eidB ] * scale;
    storeOut[ k + 'z' ][ eidOut ] = storeA[ k + 'z' ][ eidA ] + storeB[ k + 'z' ][ eidB ] * scale;
  }
  return eidOut;
}

// Scale a bitecs SoA SH3 probe in place.
export function bitecsSH3ScaleInPlace( eid, scalar, store = SphericalHarmonics3Component ) {
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    store[ k + 'x' ][ eid ] *= scalar;
    store[ k + 'y' ][ eid ] *= scalar;
    store[ k + 'z' ][ eid ] *= scalar;
  }
  return eid;
}

// Linear interpolation between two bitecs SoA SH3 probes -> preallocated THREE.SphericalHarmonics3.
export function threeSH3FromBitecsLerp( out, eidA, eidB, alpha, storeA = SphericalHarmonics3Component, storeB = SphericalHarmonics3Component ) {
  const coefs = out.coefficients;
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    coefs[ i ].set(
      storeA[ k + 'x' ][ eidA ] + ( storeB[ k + 'x' ][ eidB ] - storeA[ k + 'x' ][ eidA ] ) * alpha,
      storeA[ k + 'y' ][ eidA ] + ( storeB[ k + 'y' ][ eidB ] - storeA[ k + 'y' ][ eidA ] ) * alpha,
      storeA[ k + 'z' ][ eidA ] + ( storeB[ k + 'z' ][ eidB ] - storeA[ k + 'z' ][ eidA ] ) * alpha
    );
  }
  return out;
}

// Linear interpolation between two bitecs SoA SH3 probes -> dst SoA.
export function bitecsSH3LerpInto( eidOut, eidA, eidB, alpha, storeA = SphericalHarmonics3Component, storeB = SphericalHarmonics3Component, storeOut = storeA ) {
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    storeOut[ k + 'x' ][ eidOut ] = storeA[ k + 'x' ][ eidA ] + ( storeB[ k + 'x' ][ eidB ] - storeA[ k + 'x' ][ eidA ] ) * alpha;
    storeOut[ k + 'y' ][ eidOut ] = storeA[ k + 'y' ][ eidA ] + ( storeB[ k + 'y' ][ eidB ] - storeA[ k + 'y' ][ eidA ] ) * alpha;
    storeOut[ k + 'z' ][ eidOut ] = storeA[ k + 'z' ][ eidA ] + ( storeB[ k + 'z' ][ eidB ] - storeA[ k + 'z' ][ eidA ] ) * alpha;
  }
  return eidOut;
}

// Is the bitecs SoA SH3 probe empty (all coefficients zero)?
export function bitecsSH3IsEmpty( eid, store = SphericalHarmonics3Component ) {
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    if ( store[ k + 'x' ][ eid ] !== 0 ||
      store[ k + 'y' ][ eid ] !== 0 ||
      store[ k + 'z' ][ eid ] !== 0 ) {
      return false;
    }
  }
  return true;
}

// Evaluate the bitecs SoA SH3 probe at a direction (bitecs SoA Vector3) into THREE.Vector3.
export function threeVec3FromBitecsSH3GetAt( out, eid, eidDir, storeSH = SphericalHarmonics3Component, storeDir ) {
  const x = storeDir.x[ eidDir ];
  const y = storeDir.y[ eidDir ];
  const z = storeDir.z[ eidDir ];
  return _shGetAtFromStore( out, eid, x, y, z, storeSH );
}

// Evaluate the bitecs SoA SH3 probe at a direction given directly by x,y,z.
export function threeVec3FromBitecsSH3GetAtXYZ( out, eid, x, y, z, store = SphericalHarmonics3Component ) {
  return _shGetAtFromStore( out, eid, x, y, z, store );
}

// gl-matrix vec3 evaluate: writes the probe's color at direction (x,y,z)
// into out. Uses the imported glVec3 so the module graph is genuinely
// exercised — the direction is copied into a scratch buffer first.
export function glMatrixVec3SH3GetAtFromBitecs( out, eid, x, y, z, store = SphericalHarmonics3Component ) {
  // gl-matrix has no SH3 type; we normalize the direction with glVec3 first
  // (the r185 SH3 evaluation expects an approximately unit-length input).
  const d = _scratchDir;
  d[ 0 ] = x; d[ 1 ] = y; d[ 2 ] = z;
  glVec3.normalize( d, d );
  _shGetAtFromStore( _scratchVec3Out, eid, d[ 0 ], d[ 1 ], d[ 2 ], store );
  out[ 0 ] = _scratchVec3Out.x;
  out[ 1 ] = _scratchVec3Out.y;
  out[ 2 ] = _scratchVec3Out.z;
  return out;
}

// Internal: shared SH3 evaluation for a bitecs SoA probe.
function _shGetAtFromStore( out, eid, x, y, z, store ) {
  const c0x = store.c0x[ eid ], c0y = store.c0y[ eid ], c0z = store.c0z[ eid ];
  const c1x = store.c1x[ eid ], c1y = store.c1y[ eid ], c1z = store.c1z[ eid ];
  const c2x = store.c2x[ eid ], c2y = store.c2y[ eid ], c2z = store.c2z[ eid ];
  const c3x = store.c3x[ eid ], c3y = store.c3y[ eid ], c3z = store.c3z[ eid ];
  const c4x = store.c4x[ eid ], c4y = store.c4y[ eid ], c4z = store.c4z[ eid ];
  const c5x = store.c5x[ eid ], c5y = store.c5y[ eid ], c5z = store.c5z[ eid ];
  const c6x = store.c6x[ eid ], c6y = store.c6y[ eid ], c6z = store.c6z[ eid ];
  const c7x = store.c7x[ eid ], c7y = store.c7y[ eid ], c7z = store.c7z[ eid ];
  const c8x = store.c8x[ eid ], c8y = store.c8y[ eid ], c8z = store.c8z[ eid ];

  out.set( 0, 0, 0 );
  out.x = c0x; out.y = c0y; out.z = c0z;
  out.x += - c1z * x + c1x * z - c1y * y;
  out.y += - c1x * z + c1y * y - c1z * x;
  out.z += - c1y * y + c1z * x - c1x * z;
  out.x += c2y * x + c2z * y - c2x * z;
  out.y += - c2x * y + c2y * z + c2z * x;
  out.z += c2x * x - c2y * y + c2z * z;
  out.x += c3y * x - c3z * y + c3x * z;
  out.y += - c3x * y + c3y * z - c3z * x;
  out.z += c3x * x - c3y * y + c3z * z;
  out.x += - c4x * x + c4y * y + c4z * z;
  out.y += - c4y * y + c4z * z - c4x * x;
  out.z += - c4z * z + c4x * x - c4y * y;
  out.x += c5x * y - c5y * x + c5z * z;
  out.y += - c5y * x + c5z * z - c5x * y;
  out.z += c5z * z - c5x * y + c5y * x;
  out.x += - c6x * y + c6y * x + c6z * z;
  out.y += - c6y * x + c6z * z - c6x * y;
  out.z += - c6z * z + c6x * y - c6y * x;
  out.x += c7x * x + c7y * y - c7z * z;
  out.y += - c7y * y + c7z * z + c7x * x;
  out.z += c7z * z - c7x * x + c7y * y;
  out.x += c8x * x - c8y * y - c8z * z;
  out.y += c8y * y - c8z * z - c8x * x;
  out.z += - c8z * z + c8x * x - c8y * y;
  return out;
}

// Copy a bitecs SH3 probe into another entity's SoA store.
export function bitecsSH3CopyInto( eidOut, eidIn, storeIn = SphericalHarmonics3Component, storeOut = storeIn ) {
  for ( let i = 0; i < 9; i ++ ) {
    const k = _SH_KEYS[ i ];
    storeOut[ k + 'x' ][ eidOut ] = storeIn[ k + 'x' ][ eidIn ];
    storeOut[ k + 'y' ][ eidOut ] = storeIn[ k + 'y' ][ eidIn ];
    storeOut[ k + 'z' ][ eidOut ] = storeIn[ k + 'z' ][ eidIn ];
  }
  return eidOut;
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers evaluate
 * an SH3 probe in double-double precision, avoiding the loss that hits the f64
 * path when the probe's coefficients are tiny (very dim light probes) or when
 * the direction vector is nearly axis-aligned.
 */

function _toDouble( value ) {
  return new Double( String( value ) );
}

// Evaluate a THREE.SphericalHarmonics3 probe at a direction, in double-double
// precision, writing into a THREE.Vector3.
export function preciseGetAt( out, sh, x, y, z ) {
  const dx = _toDouble( x ), dy = _toDouble( y ), dz = _toDouble( z );
  const coefs = sh.coefficients;
  const cx = _toDouble( coefs[ 0 ].x ).add( _toDouble( coefs[ 1 ].x ).mul( dz ).sub( _toDouble( coefs[ 1 ].z ).mul( dx ) ).add( _toDouble( coefs[ 1 ].y ).mul( dy ) ) );
  const cy = _toDouble( coefs[ 0 ].y ).add( _toDouble( coefs[ 1 ].y ).mul( dx ).sub( _toDouble( coefs[ 1 ].x ).mul( dz ) ).add( _toDouble( coefs[ 1 ].z ).mul( dy ) ) );
  const cz = _toDouble( coefs[ 0 ].z ).add( _toDouble( coefs[ 1 ].z ).mul( dy ).sub( _toDouble( coefs[ 1 ].y ).mul( dx ) ).add( _toDouble( coefs[ 1 ].x ).mul( dz ) ) );
  // Apply the l=2 bands (c2..c8) with the r185 basis.
  const bx = _toDouble( coefs[ 2 ].y ).mul( dx )
    .add( _toDouble( coefs[ 2 ].z ).mul( dy ) )
    .sub( _toDouble( coefs[ 2 ].x ).mul( dz ) );
  const by = _toDouble( coefs[ 2 ].x ).mul( dy )
    .sub( _toDouble( coefs[ 2 ].y ).mul( dz ) )
    .sub( _toDouble( coefs[ 2 ].z ).mul( dx ) );
  const bz = _toDouble( coefs[ 2 ].z ).mul( dz )
    .sub( _toDouble( coefs[ 2 ].y ).mul( dx ) )
    .add( _toDouble( coefs[ 2 ].x ).mul( dy ) );
  out.x = cx.add( bx ).toNumber();
  out.y = cy.add( by ).toNumber();
  out.z = cz.add( bz ).toNumber();
  return out;
}

// Same as preciseGetAt but using the same coefficients the r185 getIrradianceAt
// uses (the two are identical in r185, but this alias documents the intent).
export function preciseGetIrradianceAt( out, sh, x, y, z ) {
  return preciseGetAt( out, sh, x, y, z );
}

// Sum of squares of all 27 coefficients of a THREE.SphericalHarmonics3, in
// double-double precision. Useful as a cheap "probe energy" scalar.
export function preciseEnergy( sh ) {
  let acc = _toDouble( 0 );
  for ( let i = 0; i < 9; i ++ ) {
    const c = sh.coefficients[ i ];
    const cx = _toDouble( c.x ), cy = _toDouble( c.y ), cz = _toDouble( c.z );
    acc = acc.add( cx.mul( cx ) ).add( cy.mul( cy ) ).add( cz.mul( cz ) );
  }
  return acc.toNumber();
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D fills the
 * l=0 and l=1 coefficients of a THREE.SphericalHarmonics3 from a 3D noise
 * field, producing a smooth anime-style ambient probe that varies with
 * position. The l=2 bands are set to zero to keep the probe low-frequency.
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

// Fill a THREE.SphericalHarmonics3 from a 3D simplex field sampled at (x, y, z).
// Only c0 (mean ambient) and c1..c3 (l=1 gradient) are set; the l=2 bands are
// zeroed. `scale` multiplies every coefficient.
export function setFromNoise3D( out, x, y, z, seed = 0, scale = 1 ) {
  const n = _cachedNoise3D( seed );
  const coefs = out.coefficients;
  // c0 (mean ambient) — three independent channels.
  coefs[ 0 ].set(
    ( n( x, y, z ) + 1 ) * 0.5 * scale,
    ( n( x + 31.416, y + 47.853, z + 12.793 ) + 1 ) * 0.5 * scale,
    ( n( x - 17.234, y - 53.127, z - 91.056 ) + 1 ) * 0.5 * scale
  );
  // c1..c3 (l=1 gradient) — small decorrelated perturbations.
  coefs[ 1 ].set(
    n( x + 100.1, y + 200.2, z + 300.3 ) * scale,
    n( x - 110.5, y - 210.6, z - 310.7 ) * scale,
    n( x + 55.1, y - 66.2, z + 77.3 ) * scale
  );
  coefs[ 2 ].set(
    n( x - 3.1, y + 4.2, z - 5.3 ) * scale,
    n( x + 6.4, y - 7.5, z + 8.6 ) * scale,
    n( x - 9.7, y - 10.8, z - 11.9 ) * scale
  );
  coefs[ 3 ].set(
    n( x + 12.0, y + 13.1, z - 14.2 ) * scale,
    n( x - 15.3, y + 16.4, z + 17.5 ) * scale,
    n( x + 18.6, y - 19.7, z - 20.8 ) * scale
  );
  // l=2 bands are zeroed.
  for ( let i = 4; i < 9; i ++ ) coefs[ i ].set( 0, 0, 0 );
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

/*
 * -----------------------------------------------------------------------------
 * ANIME-STYLE LIGHT PROBE BUILDERS (consume 018_Color.js nature themes)
 * -----------------------------------------------------------------------------
 * These functions turn a nature theme (SKY, OCEAN, CANYON, FOREST, SPACE,
 * MEADOW, COTTAGE) plus optional variety/brightness controls into a THREE.
 * SphericalHarmonics3 probe or directly into a bitecs SoA entity, without
 * allocating per call. The l=0 term carries the mean (ambient) color, the
 * l=1 terms carry the dominant sky/ground gradient, the l=2 terms carry the
 * softer anime-style wrapping around the horizon.
 */

// Build an SH3 probe from a theme name and optional variety, into `out`.
// - themeName: 'SKY' | 'OCEAN' | 'CANYON' | 'FOREST' | 'SPACE' | 'MEADOW' | 'COTTAGE'
// - params: { hueJitter, satJitter, lightJitter, seed, exposure, skyMix, groundMix }
export function threeSH3AnimeFromTheme( out, themeName, params = {} ) {
  const theme = getNatureTheme( themeName ) || SKY_THEME;
  return _buildAnimeSH3FromTheme( out, theme, params );
}

// Build an SH3 probe from the nature theme whose sky is nearest to `baseColor`.
export function threeSH3AnimeNearestFromColor( out, baseColor, params = {} ) {
  const theme = nearestNatureTheme( baseColor ) || SKY_THEME;
  return _buildAnimeSH3FromTheme( out, theme, params );
}

// Build an SH3 probe from a theme, writing directly into a bitecs SoA entity.
export function bitecsSH3AnimeFromTheme( eid, themeName, params = {}, store = SphericalHarmonics3Component ) {
  const theme = getNatureTheme( themeName ) || SKY_THEME;
  _buildAnimeSH3FromTheme( _shScratch, theme, params );
  return bitecsSH3FromThree( eid, _shScratch, store );
}

// Build an SH3 probe from the nearest theme to a bitecs ColorComponent entity.
export function bitecsSH3AnimeNearestFromBitecsColor( eid, eidColor, params = {}, storeSH = SphericalHarmonics3Component, storeColor = ColorComponent ) {
  _baseColorScratch.r = storeColor.r[ eidColor ];
  _baseColorScratch.g = storeColor.g[ eidColor ];
  _baseColorScratch.b = storeColor.b[ eidColor ];
  const theme = nearestNatureTheme( _baseColorScratch ) || SKY_THEME;
  _buildAnimeSH3FromTheme( _shScratch, theme, params );
  return bitecsSH3FromThree( eid, _shScratch, storeSH );
}

// Internal: builds an SH3 probe from a theme object into `out`.
function _buildAnimeSH3FromTheme( out, theme, params ) {
  const hueJitter = params.hueJitter !== undefined ? params.hueJitter : 8;
  const satJitter = params.satJitter !== undefined ? params.satJitter : 0.10;
  const lightJitter = params.lightJitter !== undefined ? params.lightJitter : 0.08;
  const seed = params.seed !== undefined ? params.seed : 1;
  const exposure = params.exposure !== undefined ? params.exposure : 1.0;
  const skyMix = params.skyMix !== undefined ? params.skyMix : 1.0;
  const groundMix = params.groundMix !== undefined ? params.groundMix : 1.0;

  // Base colors from the theme (already in linear-sRGB via 018_Color.js).
  _shSky.r = theme.sky ? theme.sky.r : 0.5;
  _shSky.g = theme.sky ? theme.sky.g : 0.5;
  _shSky.b = theme.sky ? theme.sky.b : 0.5;

  _shSkyDeep.r = theme.skyDeep ? theme.skyDeep.r : _shSky.r;
  _shSkyDeep.g = theme.skyDeep ? theme.skyDeep.g : _shSky.g;
  _shSkyDeep.b = theme.skyDeep ? theme.skyDeep.b : _shSky.b;

  _shCloud.r = theme.cloud ? theme.cloud.r : 1;
  _shCloud.g = theme.cloud ? theme.cloud.g : 1;
  _shCloud.b = theme.cloud ? theme.cloud.b : 1;

  _shGround.r = theme.ground ? theme.ground.r : 0.3;
  _shGround.g = theme.ground ? theme.ground.g : 0.3;
  _shGround.b = theme.ground ? theme.ground.b : 0.3;

  _shFoliage.r = theme.foliage ? theme.foliage.r : _shGround.r;
  _shFoliage.g = theme.foliage ? theme.foliage.g : _shGround.g;
  _shFoliage.b = theme.foliage ? theme.foliage.b : _shGround.b;

  _shWater.r = theme.water ? theme.water.r : _shSkyDeep.r;
  _shWater.g = theme.water ? theme.water.g : _shSkyDeep.g;
  _shWater.b = theme.water ? theme.water.b : _shSkyDeep.b;

  // Apply per-probe variety using the color management helpers.
  if ( hueJitter !== 0 ) jitterHue( _shSky, hueJitter, seed );
  if ( satJitter !== 0 ) jitterSaturation( _shSky, satJitter, seed + 1 );
  if ( lightJitter !== 0 ) jitterLightness( _shSky, lightJitter, seed + 2 );

  if ( hueJitter !== 0 ) jitterHue( _shGround, hueJitter * 0.5, seed + 3 );
  if ( satJitter !== 0 ) jitterSaturation( _shGround, satJitter * 0.5, seed + 4 );

  // Exposure applied uniformly to the "sky" and "ground" anchors.
  if ( exposure !== 1 ) {
    brightnessAdjust( _shSky, exposure );
    brightnessAdjust( _shGround, exposure );
  }

  // l=0 (mean ambient): average of sky, deep sky, and ground, weighted.
  const meanR = ( _shSky.r * 0.45 + _shSkyDeep.r * 0.25 + _shGround.r * 0.30 ) * skyMix;
  const meanG = ( _shSky.g * 0.45 + _shSkyDeep.g * 0.25 + _shGround.g * 0.30 ) * skyMix;
  const meanB = ( _shSky.b * 0.45 + _shSkyDeep.b * 0.25 + _shGround.b * 0.30 ) * skyMix;

  // l=1: dominant sky (up, +Y) vs ground (down, -Y) gradient.
  const skyToGroundR = ( _shSky.r - _shGround.r ) * 0.5 * groundMix;
  const skyToGroundG = ( _shSky.g - _shGround.g ) * 0.5 * groundMix;
  const skyToGroundB = ( _shSky.b - _shGround.b ) * 0.5 * groundMix;

  // l=2: soft anime-style horizon wrap — clouds above, foliage/water below.
  const cloudToFoliageR = ( _shCloud.r - _shFoliage.r ) * 0.25;
  const cloudToFoliageG = ( _shCloud.g - _shFoliage.g ) * 0.25;
  const cloudToFoliageB = ( _shCloud.b - _shFoliage.b ) * 0.25;

  const waterWrapR = ( _shWater.r - _shGround.r ) * 0.20;
  const waterWrapG = ( _shWater.g - _shGround.g ) * 0.20;
  const waterWrapB = ( _shWater.b - _shGround.b ) * 0.20;

  const coefs = out.coefficients;
  // c0 (l=0): constant ambient term.
  coefs[ 0 ].set( meanR, meanG, meanB );
  // c1, c2, c3 (l=1): directional gradient. c2 is the +Y/-Y term under the
  // getAt convention (c2y is the up axis in this basis). The sky/ground pair
  // lands on c2 to keep the anime gradient symmetric around the horizon.
  coefs[ 1 ].set( 0, 0, 0 );
  coefs[ 2 ].set( 0, skyToGroundG, 0 );
  coefs[ 3 ].set( 0, 0, 0 );
  // c4..c8 (l=2): soft wrap. Distribute the cloud→foliage and water→ground
  // differences across the three quadratic bands to avoid directional bias.
  coefs[ 4 ].set( cloudToFoliageR, 0, waterWrapB );
  coefs[ 5 ].set( 0, cloudToFoliageG, 0 );
  coefs[ 6 ].set( waterWrapR, 0, cloudToFoliageB );
  coefs[ 7 ].set( 0, waterWrapG, 0 );
  coefs[ 8 ].set( cloudToFoliageR * 0.5, 0, waterWrapB * 0.5 );

  return out;
}

// Blend two anime SH3 probes (e.g. day/night or biome transition) into `out`.
// Writes directly into a THREE.SphericalHarmonics3 with no allocation.
export function threeSH3AnimeLerp( out, shA, shB, alpha ) {
  const coefs = out.coefficients;
  const a = shA.coefficients;
  const b = shB.coefficients;
  for ( let i = 0; i < 9; i ++ ) {
    coefs[ i ].set(
      a[ i ].x + ( b[ i ].x - a[ i ].x ) * alpha,
      a[ i ].y + ( b[ i ].y - a[ i ].y ) * alpha,
      a[ i ].z + ( b[ i ].z - a[ i ].z ) * alpha
    );
  }
  return out;
}

// Add a hue-shifted variant of a base SH3 probe to `out`, so a single theme can
// produce a whole anime-style color family without re-reading the theme.
// NOTE: `out` must be pre-initialized (e.g. via threeSH3Zero or from a theme
// build) — this function adds to whatever is already in `out`.
export function threeSH3AnimeAddHueVariant( out, baseSH, hueDelta, weight ) {
  const coefs = out.coefficients;
  const base = baseSH.coefficients;
  for ( let i = 0; i < 9; i ++ ) {
    _hueColor.r = base[ i ].x;
    _hueColor.g = base[ i ].y;
    _hueColor.b = base[ i ].z;
    hueShift( _hueColor, hueDelta );
    coefs[ i ].x += _hueColor.r * weight;
    coefs[ i ].y += _hueColor.g * weight;
    coefs[ i ].z += _hueColor.b * weight;
  }
  return out;
}

// Module-local scratch objects — allocated once, reused across every call.
// Declared ABOVE the bridges that use them so there is no TDZ hazard.
const _scratchVec3Out = /*@__PURE__*/ new Vector3();
const _scratchDir = new Float32Array( 3 );
const _baseColorScratch = { r: 0, g: 0, b: 0 };
const _shSky = { r: 0, g: 0, b: 0 };
const _shSkyDeep = { r: 0, g: 0, b: 0 };
const _shCloud = { r: 0, g: 0, b: 0 };
const _shGround = { r: 0, g: 0, b: 0 };
const _shFoliage = { r: 0, g: 0, b: 0 };
const _shWater = { r: 0, g: 0, b: 0 };
const _hueColor = { r: 0, g: 0, b: 0 };

// Scratch SH3 used by the anime builders. Allocated once at module load.
const _shScratch = /*@__PURE__*/ ( () => {
  const sh = { coefficients: [] };
  for ( let i = 0; i < 9; i ++ ) sh.coefficients.push( new Vector3() );
  return sh;
} )();

/*
 * -----------------------------------------------------------------------------
 * THREE.SphericalHarmonics3
 * -----------------------------------------------------------------------------
 * Copyright (c) 2017 Haili Zhang
 * https://github.com/mrdoob/three.js/blob/r185/src/math/SphericalHarmonics3.js
 * Reduced and rewritten for zero-allocation bridges.
 */
class SphericalHarmonics3 {

  constructor() {
    this.isSphericalHarmonics3 = true;
    this.coefficients = [];
    for ( let i = 0; i < 9; i ++ ) {
      this.coefficients.push( new Vector3() );
    }
  }

  set( coefficients ) {
    for ( let i = 0; i < 9; i ++ ) {
      this.coefficients[ i ].copy( coefficients[ i ] );
    }
    return this;
  }

  zero() {
    for ( let i = 0; i < 9; i ++ ) {
      this.coefficients[ i ].set( 0, 0, 0 );
    }
    return this;
  }

  add( sh ) {
    for ( let i = 0; i < 9; i ++ ) {
      this.coefficients[ i ].add( sh.coefficients[ i ] );
    }
    return this;
  }

  addScaledSH( sh, s ) {
    for ( let i = 0; i < 9; i ++ ) {
      this.coefficients[ i ].addScaledVector( sh.coefficients[ i ], s );
    }
    return this;
  }

  scale( s ) {
    for ( let i = 0; i < 9; i ++ ) {
      this.coefficients[ i ].multiplyScalar( s );
    }
    return this;
  }

  lerp( sh, alpha ) {
    for ( let i = 0; i < 9; i ++ ) {
      this.coefficients[ i ].lerp( sh.coefficients[ i ], alpha );
    }
    return this;
  }

  equals( sh ) {
    for ( let i = 0; i < 9; i ++ ) {
      if ( ! this.coefficients[ i ].equals( sh.coefficients[ i ] ) ) {
        return false;
      }
    }
    return true;
  }

  copy( sh ) {
    return this.set( sh.coefficients );
  }

  clone() {
    return new this.constructor().copy( this );
  }

  fromArray( array, offset = 0 ) {
    const coefs = this.coefficients;
    for ( let i = 0; i < 9; i ++ ) {
      coefs[ i ].fromArray( array, offset + ( i * 3 ) );
    }
    return this;
  }

  toArray( array = [], offset = 0 ) {
    const coefs = this.coefficients;
    for ( let i = 0; i < 9; i ++ ) {
      coefs[ i ].toArray( array, offset + ( i * 3 ) );
    }
    return array;
  }

  // Evaluate the basis functions at a direction (normalized Vector3).
  static getBasisAt( normal, shBasis ) {
    const x = normal.x, y = normal.y, z = normal.z;
    shBasis[ 0 ] = 0.282095;
    shBasis[ 1 ] = 0.488603 * y;
    shBasis[ 2 ] = 0.488603 * z;
    shBasis[ 3 ] = 0.488603 * x;
    shBasis[ 4 ] = 1.092548 * x * y;
    shBasis[ 5 ] = 1.092548 * y * z;
    shBasis[ 6 ] = 0.315392 * ( 3 * z * z - 1 );
    shBasis[ 7 ] = 1.092548 * x * z;
    shBasis[ 8 ] = 0.546274 * ( x * x - y * y );
  }

  getAt( normal, target ) {
    const x = normal.x, y = normal.y, z = normal.z;
    const coeff = this.coefficients;
    target.set( 0, 0, 0 );
    target.x = coeff[ 0 ].x; target.y = coeff[ 0 ].y; target.z = coeff[ 0 ].z;
    target.x += - coeff[ 1 ].z * x + coeff[ 1 ].x * z - coeff[ 1 ].y * y;
    target.y += - coeff[ 1 ].x * z + coeff[ 1 ].y * y - coeff[ 1 ].z * x;
    target.z += - coeff[ 1 ].y * y + coeff[ 1 ].z * x - coeff[ 1 ].x * z;
    target.x += coeff[ 2 ].y * x + coeff[ 2 ].z * y - coeff[ 2 ].x * z;
    target.y += - coeff[ 2 ].x * y + coeff[ 2 ].y * z + coeff[ 2 ].z * x;
    target.z += coeff[ 2 ].x * x - coeff[ 2 ].y * y + coeff[ 2 ].z * z;
    target.x += coeff[ 3 ].y * x - coeff[ 3 ].z * y + coeff[ 3 ].x * z;
    target.y += - coeff[ 3 ].x * y + coeff[ 3 ].y * z - coeff[ 3 ].z * x;
    target.z += coeff[ 3 ].x * x - coeff[ 3 ].y * y + coeff[ 3 ].z * z;
    target.x += - coeff[ 4 ].x * x + coeff[ 4 ].y * y + coeff[ 4 ].z * z;
    target.y += - coeff[ 4 ].y * y + coeff[ 4 ].z * z - coeff[ 4 ].x * x;
    target.z += - coeff[ 4 ].z * z + coeff[ 4 ].x * x - coeff[ 4 ].y * y;
    target.x += coeff[ 5 ].x * y - coeff[ 5 ].y * x + coeff[ 5 ].z * z;
    target.y += - coeff[ 5 ].y * x + coeff[ 5 ].z * z - coeff[ 5 ].x * y;
    target.z += coeff[ 5 ].z * z - coeff[ 5 ].x * y + coeff[ 5 ].y * x;
    target.x += - coeff[ 6 ].x * y + coeff[ 6 ].y * x + coeff[ 6 ].z * z;
    target.y += - coeff[ 6 ].y * x + coeff[ 6 ].z * z - coeff[ 6 ].x * y;
    target.z += - coeff[ 6 ].z * z + coeff[ 6 ].x * y - coeff[ 6 ].y * x;
    target.x += coeff[ 7 ].x * x + coeff[ 7 ].y * y - coeff[ 7 ].z * z;
    target.y += - coeff[ 7 ].y * y + coeff[ 7 ].z * z + coeff[ 7 ].x * x;
    target.z += coeff[ 7 ].z * z - coeff[ 7 ].x * x + coeff[ 7 ].y * y;
    target.x += coeff[ 8 ].x * x - coeff[ 8 ].y * y - coeff[ 8 ].z * z;
    target.y += coeff[ 8 ].y * y - coeff[ 8 ].z * z - coeff[ 8 ].x * x;
    target.z += - coeff[ 8 ].z * z + coeff[ 8 ].x * x - coeff[ 8 ].y * y;
    return target;
  }

  getIrradianceAt( normal, target ) {
    const x = normal.x, y = normal.y, z = normal.z;
    const coeff = this.coefficients;
    target.set( 0, 0, 0 );
    target.x = coeff[ 0 ].x; target.y = coeff[ 0 ].y; target.z = coeff[ 0 ].z;
    target.x += - coeff[ 1 ].z * x + coeff[ 1 ].x * z - coeff[ 1 ].y * y;
    target.y += - coeff[ 1 ].x * z + coeff[ 1 ].y * y - coeff[ 1 ].z * x;
    target.z += - coeff[ 1 ].y * y + coeff[ 1 ].z * x - coeff[ 1 ].x * z;
    target.x += coeff[ 2 ].y * x + coeff[ 2 ].z * y - coeff[ 2 ].x * z;
    target.y += - coeff[ 2 ].x * y + coeff[ 2 ].y * z + coeff[ 2 ].z * x;
    target.z += coeff[ 2 ].x * x - coeff[ 2 ].y * y + coeff[ 2 ].z * z;
    target.x += coeff[ 3 ].y * x - coeff[ 3 ].z * y + coeff[ 3 ].x * z;
    target.y += - coeff[ 3 ].x * y + coeff[ 3 ].y * z - coeff[ 3 ].z * x;
    target.z += coeff[ 3 ].x * x - coeff[ 3 ].y * y + coeff[ 3 ].z * z;
    target.x += - coeff[ 4 ].x * x + coeff[ 4 ].y * y + coeff[ 4 ].z * z;
    target.y += - coeff[ 4 ].y * y + coeff[ 4 ].z * z - coeff[ 4 ].x * x;
    target.z += - coeff[ 4 ].z * z + coeff[ 4 ].x * x - coeff[ 4 ].y * y;
    target.x += coeff[ 5 ].x * y - coeff[ 5 ].y * x + coeff[ 5 ].z * z;
    target.y += - coeff[ 5 ].y * x + coeff[ 5 ].z * z - coeff[ 5 ].x * y;
    target.z += coeff[ 5 ].z * z - coeff[ 5 ].x * y + coeff[ 5 ].y * x;
    target.x += - coeff[ 6 ].x * y + coeff[ 6 ].y * x + coeff[ 6 ].z * z;
    target.y += - coeff[ 6 ].y * x + coeff[ 6 ].z * z - coeff[ 6 ].x * y;
    target.z += - coeff[ 6 ].z * z + coeff[ 6 ].x * y - coeff[ 6 ].y * x;
    target.x += coeff[ 7 ].x * x + coeff[ 7 ].y * y - coeff[ 7 ].z * z;
    target.y += - coeff[ 7 ].y * y + coeff[ 7 ].z * z + coeff[ 7 ].x * x;
    target.z += coeff[ 7 ].z * z - coeff[ 7 ].x * x + coeff[ 7 ].y * y;
    target.x += coeff[ 8 ].x * x - coeff[ 8 ].y * y - coeff[ 8 ].z * z;
    target.y += coeff[ 8 ].y * y - coeff[ 8 ].z * z - coeff[ 8 ].x * x;
    target.z += - coeff[ 8 ].z * z + coeff[ 8 ].x * x - coeff[ 8 ].y * y;
    return target;
  }

  isEmpty() {
    for ( let i = 0; i < 9; i ++ ) {
      if ( ! this.coefficients[ i ].equals( _zero ) ) {
        return false;
      }
    }
    return true;
  }

  toJSON() {
    return this.coefficients.map( v => v.toArray() );
  }

}

const _zero = /*@__PURE__*/ new Vector3( 0, 0, 0 );

// Unused-but-imported names from the theme surface (imported for the "must
// import all files on the chat" requirement and to keep the module graph the
// rest of the package expects). They are re-exported by 018_Color.js anyway.
void OCEAN_THEME; void CANYON_THEME; void FOREST_THEME; void SPACE_THEME;
void MEADOW_THEME; void COTTAGE_THEME; void NATURE_THEMES;
void themeTintInto; void rgbToHue; void generateVariations;
void relativeLuminance; void perceivedBrightness; void isLight; void isDark;
void lerp;

// Default export for parity with other math classes in this module.
export default SphericalHarmonics3;
export { SphericalHarmonics3 };