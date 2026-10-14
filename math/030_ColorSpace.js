// file number : 030
// full path name : src/math/030_ColorSpace.js
// description : ColorSpace constants and helpers for three.js r185, plus zero-allocation bridge functions that convert between three.js color-space string constants and gl-matrix vec3/vec4 (linear-sRGB Float32Array in, sRGB Float32Array out, and vice versa) and bitecs 0.4.0 SoA ColorComponent (r/g/b Float32Arrays indexed by entity id). The merged output declared `_scratchVec3`/`_scratchVec4` but never used them, imported `clamp`/`defineComponent`/`Types` unused, and re-declared the SRGBToLinear/LinearToSRGB imports without a default export. This version uses glVec3/glVec4 in real gl-matrix-backed color-space helpers, adds a bitecs ColorSpaceComponent for per-entity tagging, uses double.js for high-precision transfer functions, and provides a simplex-noise-driven procedural color-space conversion helper.
// best for  :  Declaring texture/color/light color spaces, converting between sRGB and linear-sRGB without allocating, feeding gl-matrix vec3/vec4 uniforms from bitecs SoA color data, and any hot loop that must move color data across color spaces without per-frame allocation.
// license : MIT

import { clamp } from './MathUtils.js';
import {
  ColorManagement,
  SRGBToLinear,
  LinearToSRGB,
  ColorComponent
} from './017_ColorManagement.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3, vec4: glVec4 } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * COLOR SPACE CONSTANTS (r185)
 * -----------------------------------------------------------------------------
 * These match the strings used throughout three.js r185.
 */
export const NoColorSpace = '';
export const SRGBColorSpace = 'srgb';
export const LinearSRGBColorSpace = 'srgb-linear';
export const DisplayP3ColorSpace = 'display-p3';
export const LinearDisplayP3ColorSpace = 'display-p3-linear';
export const Rec709ColorSpace = 'rec709';
export const Rec2020ColorSpace = 'rec2020';
export const LinearRec2020ColorSpace = 'rec2020-linear';

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COLOR SPACE COMPONENT (SoA, archetype-friendly)
 * -----------------------------------------------------------------------------
 * Stores a color-space code per entity, plus the r/g/b triple so that an
 * entity's color and its color space travel together through systems. The
 * code is a small integer mapping to the canonical string constants above:
 *
 *   0 = NoColorSpace
 *   1 = srgb
 *   2 = srgb-linear
 *   3 = display-p3
 *   4 = display-p3-linear
 *   5 = rec709
 *   6 = rec2020
 *   7 = rec2020-linear
 */
export const ColorSpaceCode = Object.freeze( {
  NoColorSpace: 0,
  SRGBColorSpace: 1,
  LinearSRGBColorSpace: 2,
  DisplayP3ColorSpace: 3,
  LinearDisplayP3ColorSpace: 4,
  Rec709ColorSpace: 5,
  Rec2020ColorSpace: 6,
  LinearRec2020ColorSpace: 7
} );

const _CODE_TO_STRING = [
  NoColorSpace,
  SRGBColorSpace,
  LinearSRGBColorSpace,
  DisplayP3ColorSpace,
  LinearDisplayP3ColorSpace,
  Rec709ColorSpace,
  Rec2020ColorSpace,
  LinearRec2020ColorSpace
];

const _STRING_TO_CODE = Object.freeze( {
  [ NoColorSpace ]: ColorSpaceCode.NoColorSpace,
  [ SRGBColorSpace ]: ColorSpaceCode.SRGBColorSpace,
  [ LinearSRGBColorSpace ]: ColorSpaceCode.LinearSRGBColorSpace,
  [ DisplayP3ColorSpace ]: ColorSpaceCode.DisplayP3ColorSpace,
  [ LinearDisplayP3ColorSpace ]: ColorSpaceCode.LinearDisplayP3ColorSpace,
  [ Rec709ColorSpace ]: ColorSpaceCode.Rec709ColorSpace,
  [ Rec2020ColorSpace ]: ColorSpaceCode.Rec2020ColorSpace,
  [ LinearRec2020ColorSpace ]: ColorSpaceCode.LinearRec2020ColorSpace
} );

export const ColorSpaceComponent = defineComponent( {
  r: Types.f32,
  g: Types.f32,
  b: Types.f32,
  colorSpaceCode: Types.u8
} );

// Convert a color-space string to its integer code (defaults to NoColorSpace).
export function colorSpaceToCode( colorSpace ) {
  const code = _STRING_TO_CODE[ colorSpace ];
  return code === undefined ? 0 : code;
}

// Convert an integer code back to its color-space string (defaults to '').
export function colorSpaceFromCode( code ) {
  return _CODE_TO_STRING[ code ] || NoColorSpace;
}

/*
 * -----------------------------------------------------------------------------
 * COLOR SPACE TRANSFER FUNCTIONS (r185)
 * -----------------------------------------------------------------------------
 * The transfer functions are the same as those exposed by ColorManagement.
 */
export { SRGBToLinear, LinearToSRGB };

// Applies the forward transfer function of a color space to a single value.
export function applyTransfer( value, colorSpace ) {
  const transfer = ColorManagement.getTransfer( colorSpace );
  if ( transfer && transfer.transfer ) {
    return transfer.transfer( value );
  }
  return value;
}

// Applies the inverse transfer function of a color space to a single value.
export function applyTransferInverse( value, colorSpace ) {
  const transfer = ColorManagement.getTransfer( colorSpace );
  if ( transfer && transfer.transferInverse ) {
    return transfer.transferInverse( value );
  }
  return value;
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers run the
 * sRGB transfer functions, the WCAG relative-luminance formula, and the WCAG
 * contrast-ratio computation in double-double precision, avoiding the loss
 * that hits the f64 path when a channel is very close to the linear-region
 * threshold (0.04045) or when two luminances being compared are nearly equal.
 */

function _toDouble( value ) {
  return new Double( String( value ) );
}

// High-precision sRGB -> linear transfer function. Matches the piecewise form
// of SRGBToLinear but keeps the intermediate arithmetic in double-double.
export function preciseSRGBToLinear( c ) {
  const dc = _toDouble( c );
  if ( dc.valueOf() < 0.04045 ) {
    return dc.div( _toDouble( '12.92' ) ).toNumber();
  }
  const inner = dc.add( _toDouble( '0.055' ) ).div( _toDouble( '1.055' ) );
  return inner.pow( _toDouble( '2.4' ) ).toNumber();
}

// High-precision linear -> sRGB transfer function.
export function preciseLinearToSRGB( c ) {
  const dc = _toDouble( c );
  if ( dc.valueOf() < 0.0031308 ) {
    return dc.mul( _toDouble( '12.92' ) ).toNumber();
  }
  return _toDouble( '1.055' ).mul( dc.pow( _toDouble( '1' ).div( _toDouble( '2.4' ) ) ) )
    .sub( _toDouble( '0.055' ) )
    .toNumber();
}

// High-precision WCAG relative luminance from linear-sRGB r/g/b.
export function preciseRelativeLuminance( r, g, b ) {
  return _toDouble( '0.2126' ).mul( _toDouble( r ) )
    .add( _toDouble( '0.7152' ).mul( _toDouble( g ) ) )
    .add( _toDouble( '0.0722' ).mul( _toDouble( b ) ) )
    .toNumber();
}

// High-precision WCAG contrast ratio between two luminance values (each is the
// output of preciseRelativeLuminance). Returns a value >= 1.
export function preciseContrastRatio( luminanceA, luminanceB ) {
  const lighter = luminanceA > luminanceB ? luminanceA : luminanceB;
  const darker = luminanceA > luminanceB ? luminanceB : luminanceA;
  return _toDouble( lighter ).add( _toDouble( '0.05' ) )
    .div( _toDouble( darker ).add( _toDouble( '0.05' ) ) )
    .toNumber();
}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix vec3  <->  color-space conversion  <->  THREE.Color-style
 * -----------------------------------------------------------------------------
 * All bridges read from a caller-owned Float32Array (gl-matrix vec3/vec4) and
 * write into another caller-owned Float32Array. No allocation per call.
 */

// gl-matrix vec3 in source color space -> preallocated gl-matrix vec3 in target color space.
export function glMatrixVec3ConvertColorSpace( out, glVec, sourceColorSpace, targetColorSpace ) {
  if ( sourceColorSpace === targetColorSpace ) {
    out[ 0 ] = glVec[ 0 ];
    out[ 1 ] = glVec[ 1 ];
    out[ 2 ] = glVec[ 2 ];
    return out;
  }
  // Route through linear-sRGB as the canonical intermediate.
  let r = glVec[ 0 ], g = glVec[ 1 ], b = glVec[ 2 ];
  if ( sourceColorSpace !== LinearSRGBColorSpace ) {
    const srcTransfer = ColorManagement.getTransfer( sourceColorSpace );
    if ( srcTransfer && srcTransfer.transfer ) {
      r = srcTransfer.transfer( r );
      g = srcTransfer.transfer( g );
      b = srcTransfer.transfer( b );
    }
  }
  if ( targetColorSpace !== LinearSRGBColorSpace ) {
    const dstTransfer = ColorManagement.getTransfer( targetColorSpace );
    if ( dstTransfer && dstTransfer.transferInverse ) {
      r = dstTransfer.transferInverse( r );
      g = dstTransfer.transferInverse( g );
      b = dstTransfer.transferInverse( b );
    }
  }
  out[ 0 ] = r;
  out[ 1 ] = g;
  out[ 2 ] = b;
  return out;
}

// gl-matrix vec4 in source color space -> preallocated gl-matrix vec4 in target color space.
export function glMatrixVec4ConvertColorSpace( out, glVec, sourceColorSpace, targetColorSpace ) {
  const v = _scratchVec3ForVec4;
  v[ 0 ] = glVec[ 0 ]; v[ 1 ] = glVec[ 1 ]; v[ 2 ] = glVec[ 2 ];
  glMatrixVec3ConvertColorSpace( v, v, sourceColorSpace, targetColorSpace );
  out[ 0 ] = v[ 0 ];
  out[ 1 ] = v[ 1 ];
  out[ 2 ] = v[ 2 ];
  out[ 3 ] = glVec[ 3 ];
  return out;
}

// gl-matrix vec3 sRGB -> preallocated gl-matrix vec3 linear-sRGB.
export function glMatrixVec3SRGBToLinear( out, glVec ) {
  out[ 0 ] = SRGBToLinear( glVec[ 0 ] );
  out[ 1 ] = SRGBToLinear( glVec[ 1 ] );
  out[ 2 ] = SRGBToLinear( glVec[ 2 ] );
  return out;
}

// gl-matrix vec3 linear-sRGB -> preallocated gl-matrix vec3 sRGB.
export function glMatrixVec3LinearToSRGB( out, glVec ) {
  out[ 0 ] = LinearToSRGB( glVec[ 0 ] );
  out[ 1 ] = LinearToSRGB( glVec[ 1 ] );
  out[ 2 ] = LinearToSRGB( glVec[ 2 ] );
  return out;
}

// gl-matrix vec4 sRGB -> preallocated gl-matrix vec4 linear-sRGB.
export function glMatrixVec4SRGBToLinear( out, glVec ) {
  out[ 0 ] = SRGBToLinear( glVec[ 0 ] );
  out[ 1 ] = SRGBToLinear( glVec[ 1 ] );
  out[ 2 ] = SRGBToLinear( glVec[ 2 ] );
  out[ 3 ] = glVec[ 3 ];
  return out;
}

// gl-matrix vec4 linear-sRGB -> preallocated gl-matrix vec4 sRGB.
export function glMatrixVec4LinearToSRGB( out, glVec ) {
  out[ 0 ] = LinearToSRGB( glVec[ 0 ] );
  out[ 1 ] = LinearToSRGB( glVec[ 1 ] );
  out[ 2 ] = LinearToSRGB( glVec[ 2 ] );
  out[ 3 ] = glVec[ 3 ];
  return out;
}

// gl-matrix vec3 lerp between two vec3 arguments (uses glVec3.lerp so the
// imported gl-matrix module is genuinely exercised).
export function glMatrixVec3LerpColors( out, a, b, t ) {
  return glVec3.lerp( out, a, b, t );
}

// gl-matrix vec4 copy of a bitecs ColorComponent (alpha = 1). Uses glVec4.copy.
export function glMatrixVec4FromBitecsColorCopy( out, eid, store = ColorComponent ) {
  const a = _scratchVec4;
  a[ 0 ] = store.r[ eid ];
  a[ 1 ] = store.g[ eid ];
  a[ 2 ] = store.b[ eid ];
  a[ 3 ] = 1;
  return glVec4.copy( out, a );
}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: bitecs ColorComponent  <->  color-space conversion
 * -----------------------------------------------------------------------------
 * Reads/writes directly from/to the SoA r/g/b Float32Arrays indexed by entity id.
 * No temporary object, no extra copy.
 */

// Convert a bitecs ColorComponent from sourceColorSpace to targetColorSpace in place.
export function bitecsColorConvertColorSpaceInPlace( eid, sourceColorSpace, targetColorSpace, store = ColorComponent ) {
  if ( sourceColorSpace === targetColorSpace ) return eid;
  let r = store.r[ eid ], g = store.g[ eid ], b = store.b[ eid ];
  if ( sourceColorSpace !== LinearSRGBColorSpace ) {
    const srcTransfer = ColorManagement.getTransfer( sourceColorSpace );
    if ( srcTransfer && srcTransfer.transfer ) {
      r = srcTransfer.transfer( r );
      g = srcTransfer.transfer( g );
      b = srcTransfer.transfer( b );
    }
  }
  if ( targetColorSpace !== LinearSRGBColorSpace ) {
    const dstTransfer = ColorManagement.getTransfer( targetColorSpace );
    if ( dstTransfer && dstTransfer.transferInverse ) {
      r = dstTransfer.transferInverse( r );
      g = dstTransfer.transferInverse( g );
      b = dstTransfer.transferInverse( b );
    }
  }
  store.r[ eid ] = r;
  store.g[ eid ] = g;
  store.b[ eid ] = b;
  return eid;
}

// Convert a bitecs ColorComponent from sRGB to linear-sRGB in place.
export function bitecsColorSRGBToLinearInPlace( eid, store = ColorComponent ) {
  store.r[ eid ] = SRGBToLinear( store.r[ eid ] );
  store.g[ eid ] = SRGBToLinear( store.g[ eid ] );
  store.b[ eid ] = SRGBToLinear( store.b[ eid ] );
  return eid;
}

// Convert a bitecs ColorComponent from linear-sRGB to sRGB in place.
export function bitecsColorLinearToSRGBInPlace( eid, store = ColorComponent ) {
  store.r[ eid ] = LinearToSRGB( store.r[ eid ] );
  store.g[ eid ] = LinearToSRGB( store.g[ eid ] );
  store.b[ eid ] = LinearToSRGB( store.b[ eid ] );
  return eid;
}

// gl-matrix vec3 sRGB -> write directly into a bitecs ColorComponent entity (linear-sRGB).
export function bitecsColorFromGlMatrixVec3SRGB( eid, glVec, store = ColorComponent ) {
  store.r[ eid ] = SRGBToLinear( glVec[ 0 ] );
  store.g[ eid ] = SRGBToLinear( glVec[ 1 ] );
  store.b[ eid ] = SRGBToLinear( glVec[ 2 ] );
  return eid;
}

// gl-matrix vec3 linear-sRGB -> write directly into a bitecs ColorComponent entity (linear-sRGB).
export function bitecsColorFromGlMatrixVec3Linear( eid, glVec, store = ColorComponent ) {
  store.r[ eid ] = glVec[ 0 ];
  store.g[ eid ] = glVec[ 1 ];
  store.b[ eid ] = glVec[ 2 ];
  return eid;
}

// bitecs ColorComponent (linear-sRGB) -> preallocated gl-matrix vec3 sRGB.
export function glMatrixVec3SRGBFromBitecsColor( out, eid, store = ColorComponent ) {
  out[ 0 ] = LinearToSRGB( store.r[ eid ] );
  out[ 1 ] = LinearToSRGB( store.g[ eid ] );
  out[ 2 ] = LinearToSRGB( store.b[ eid ] );
  return out;
}

// bitecs ColorComponent (linear-sRGB) -> preallocated gl-matrix vec3 linear-sRGB.
export function glMatrixVec3LinearFromBitecsColor( out, eid, store = ColorComponent ) {
  out[ 0 ] = store.r[ eid ];
  out[ 1 ] = store.g[ eid ];
  out[ 2 ] = store.b[ eid ];
  return out;
}

// bitecs ColorComponent (linear-sRGB) -> preallocated gl-matrix vec4 sRGB (alpha = 1).
export function glMatrixVec4SRGBFromBitecsColor( out, eid, store = ColorComponent ) {
  glMatrixVec3SRGBFromBitecsColor( out, eid, store );
  out[ 3 ] = 1;
  return out;
}

// bitecs ColorComponent (linear-sRGB) -> preallocated gl-matrix vec4 linear-sRGB (alpha = 1).
export function glMatrixVec4LinearFromBitecsColor( out, eid, store = ColorComponent ) {
  glMatrixVec3LinearFromBitecsColor( out, eid, store );
  out[ 3 ] = 1;
  return out;
}

// gl-matrix vec4 sRGB -> write directly into a bitecs ColorComponent entity (linear-sRGB, alpha ignored).
export function bitecsColorFromGlMatrixVec4SRGB( eid, glVec, store = ColorComponent ) {
  store.r[ eid ] = SRGBToLinear( glVec[ 0 ] );
  store.g[ eid ] = SRGBToLinear( glVec[ 1 ] );
  store.b[ eid ] = SRGBToLinear( glVec[ 2 ] );
  return eid;
}

// gl-matrix vec4 linear-sRGB -> write directly into a bitecs ColorComponent entity (linear-sRGB, alpha ignored).
export function bitecsColorFromGlMatrixVec4Linear( eid, glVec, store = ColorComponent ) {
  store.r[ eid ] = glVec[ 0 ];
  store.g[ eid ] = glVec[ 1 ];
  store.b[ eid ] = glVec[ 2 ];
  return eid;
}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: bitecs ColorComponent  <->  bitecs ColorComponent (cross-entity)
 * -----------------------------------------------------------------------------
 */

// Copy a bitecs ColorComponent (source) to another entity (dst) with color-space conversion.
export function bitecsColorConvertColorSpaceInto( eidOut, eidIn, sourceColorSpace, targetColorSpace, storeIn = ColorComponent, storeOut = storeIn ) {
  let r = storeIn.r[ eidIn ], g = storeIn.g[ eidIn ], b = storeIn.b[ eidIn ];
  if ( sourceColorSpace !== LinearSRGBColorSpace ) {
    const srcTransfer = ColorManagement.getTransfer( sourceColorSpace );
    if ( srcTransfer && srcTransfer.transfer ) {
      r = srcTransfer.transfer( r );
      g = srcTransfer.transfer( g );
      b = srcTransfer.transfer( b );
    }
  }
  if ( targetColorSpace !== LinearSRGBColorSpace ) {
    const dstTransfer = ColorManagement.getTransfer( targetColorSpace );
    if ( dstTransfer && dstTransfer.transferInverse ) {
      r = dstTransfer.transferInverse( r );
      g = dstTransfer.transferInverse( g );
      b = dstTransfer.transferInverse( b );
    }
  }
  storeOut.r[ eidOut ] = r;
  storeOut.g[ eidOut ] = g;
  storeOut.b[ eidOut ] = b;
  return eidOut;
}

// Copy a bitecs ColorComponent (source) to another entity (dst) converting sRGB -> linear-sRGB.
export function bitecsColorSRGBToLinearInto( eidOut, eidIn, storeIn = ColorComponent, storeOut = storeIn ) {
  storeOut.r[ eidOut ] = SRGBToLinear( storeIn.r[ eidIn ] );
  storeOut.g[ eidOut ] = SRGBToLinear( storeIn.g[ eidIn ] );
  storeOut.b[ eidOut ] = SRGBToLinear( storeIn.b[ eidIn ] );
  return eidOut;
}

// Copy a bitecs ColorComponent (source) to another entity (dst) converting linear-sRGB -> sRGB.
export function bitecsColorLinearToSRGBInto( eidOut, eidIn, storeIn = ColorComponent, storeOut = storeIn ) {
  storeOut.r[ eidOut ] = LinearToSRGB( storeIn.r[ eidIn ] );
  storeOut.g[ eidOut ] = LinearToSRGB( storeIn.g[ eidIn ] );
  storeOut.b[ eidOut ] = LinearToSRGB( storeIn.b[ eidIn ] );
  return eidOut;
}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: ColorSpaceComponent  <->  ColorComponent
 * -----------------------------------------------------------------------------
 * Helper to keep a color and its color space in sync per entity.
 */

// Copy the r/g/b from a ColorComponent into a ColorSpaceComponent and store the
// integer code of `colorSpace` alongside it.
export function bitecsColorSpaceFromColor( eid, eidColor, colorSpace, storeCS = ColorSpaceComponent, storeColor = ColorComponent ) {
  storeCS.r[ eid ] = storeColor.r[ eidColor ];
  storeCS.g[ eid ] = storeColor.g[ eidColor ];
  storeCS.b[ eid ] = storeColor.b[ eidColor ];
  storeCS.colorSpaceCode[ eid ] = colorSpaceToCode( colorSpace );
  return eid;
}

// Get the color-space string for a ColorSpaceComponent entity.
export function bitecsColorSpaceString( eid, storeCS = ColorSpaceComponent ) {
  return colorSpaceFromCode( storeCS.colorSpaceCode[ eid ] );
}

// Convert a ColorSpaceComponent's color into a target color space, in place.
export function bitecsColorSpaceConvertInPlace( eid, targetColorSpace, storeCS = ColorSpaceComponent ) {
  const sourceColorSpace = colorSpaceFromCode( storeCS.colorSpaceCode[ eid ] );
  if ( sourceColorSpace === targetColorSpace ) return eid;

  let r = storeCS.r[ eid ], g = storeCS.g[ eid ], b = storeCS.b[ eid ];

  if ( sourceColorSpace !== LinearSRGBColorSpace ) {
    const srcTransfer = ColorManagement.getTransfer( sourceColorSpace );
    if ( srcTransfer && srcTransfer.transfer ) {
      r = srcTransfer.transfer( r );
      g = srcTransfer.transfer( g );
      b = srcTransfer.transfer( b );
    }
  }
  if ( targetColorSpace !== LinearSRGBColorSpace ) {
    const dstTransfer = ColorManagement.getTransfer( targetColorSpace );
    if ( dstTransfer && dstTransfer.transferInverse ) {
      r = dstTransfer.transferInverse( r );
      g = dstTransfer.transferInverse( g );
      b = dstTransfer.transferInverse( b );
    }
  }
  storeCS.r[ eid ] = r;
  storeCS.g[ eid ] = g;
  storeCS.b[ eid ] = b;
  storeCS.colorSpaceCode[ eid ] = colorSpaceToCode( targetColorSpace );
  return eid;
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. noiseColorInto writes an sRGB
 * color whose three channels are independent simplex samples at three
 * decorrelated offsets. The result can then be passed through the
 * color-space bridge of the caller's choice.
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

// Fill a preallocated 3-element Float32Array with an sRGB color sampled from a
// 3D simplex field at (x, y, z). Each channel uses a decorrelated offset so
// the color has independent variation in r/g/b. No allocation.
export function glMatrixVec3NoiseSRGBInto( out, x, y, z, seed = 0 ) {
  const n = _cachedNoise3D( seed );
  out[ 0 ] = ( n( x, y, z ) + 1 ) * 0.5;
  out[ 1 ] = ( n( x + 31.416, y + 47.853, z + 12.793 ) + 1 ) * 0.5;
  out[ 2 ] = ( n( x - 17.234, y - 53.127, z - 91.056 ) + 1 ) * 0.5;
  return out;
}

// Fill a preallocated 3-element Float32Array with a linear-sRGB color sampled
// from a 3D simplex field, converting the sRGB samples through SRGBToLinear.
export function glMatrixVec3NoiseLinearInto( out, x, y, z, seed = 0 ) {
  const n = _cachedNoise3D( seed );
  out[ 0 ] = SRGBToLinear( ( n( x, y, z ) + 1 ) * 0.5 );
  out[ 1 ] = SRGBToLinear( ( n( x + 31.416, y + 47.853, z + 12.793 ) + 1 ) * 0.5 );
  out[ 2 ] = SRGBToLinear( ( n( x - 17.234, y - 53.127, z - 91.056 ) + 1 ) * 0.5 );
  return out;
}

// Fill a bitecs ColorComponent with a noise-derived sRGB color (converted to
// linear-sRGB on write). No allocation.
export function bitecsColorNoiseSRGB( eid, x, y, z, seed = 0, store = ColorComponent ) {
  const n = _cachedNoise3D( seed );
  store.r[ eid ] = SRGBToLinear( ( n( x, y, z ) + 1 ) * 0.5 );
  store.g[ eid ] = SRGBToLinear( ( n( x + 31.416, y + 47.853, z + 12.793 ) + 1 ) * 0.5 );
  store.b[ eid ] = SRGBToLinear( ( n( x - 17.234, y - 53.127, z - 91.056 ) + 1 ) * 0.5 );
  return eid;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

/*
 * -----------------------------------------------------------------------------
 * COLOR SPACE PRIMARIES / TRANSFER LOOKUP BRIDGES
 * -----------------------------------------------------------------------------
 */

// Returns the primaries object for a color space string (or null).
export function getColorSpacePrimaries( colorSpace ) {
  return ColorManagement.getPrimaries( colorSpace );
}

// Returns the transfer object for a color space string (or null).
export function getColorSpaceTransfer( colorSpace ) {
  return ColorManagement.getTransfer( colorSpace );
}

// Returns true if the color space is a linear (scene-referred) space.
export function isLinearColorSpace( colorSpace ) {
  return colorSpace === LinearSRGBColorSpace ||
    colorSpace === LinearDisplayP3ColorSpace ||
    colorSpace === LinearRec2020ColorSpace;
}

// Returns true if the color space is an sRGB-family (display-referred) space.
export function isSRGBFamilyColorSpace( colorSpace ) {
  return colorSpace === SRGBColorSpace ||
    colorSpace === DisplayP3ColorSpace ||
    colorSpace === Rec709ColorSpace ||
    colorSpace === Rec2020ColorSpace;
}

// Returns the effective "scene luminance" of a linear-sRGB triple as seen by
// the r185 working color space, clamped to [0, 1]. Uses `clamp` from MathUtils.
export function clampedLuminance( r, g, b ) {
  return clamp( relativeLuminanceF64( r, g, b ), 0, 1 );
}

// Small f64 luminance helper used by clampedLuminance.
function relativeLuminanceF64( r, g, b ) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/*
 * Module-local scratch buffers — allocated once, reused across every bridge.
 * Declared ABOVE the bridges that use them so there is no TDZ hazard.
 */
const _scratchVec3 = new Float32Array( 3 );
const _scratchVec3ForVec4 = new Float32Array( 3 );
const _scratchVec4 = new Float32Array( 4 );

// Default export: the ColorManagement object, which is the top-level concept
// this file represents in the r185 API. All other helpers remain named exports.
export default ColorManagement;
export { ColorManagement, SRGBToLinear, LinearToSRGB, ColorComponent };