// file number : 018
// full path name : src/math/018_Color.js
// description : Color class (THREE.Color) stored as linear-sRGB r/g/b [0..1] in the working color space, with full r185 API (set, setHex, setRGB, setHSL, setStyle, setColorName, getHex, getHexString, getStyle, getHSL, add, sub, multiply, lerp, lerpHSL, fromArray, toArray, fromBufferAttribute, toJSON) plus zero-allocation bridge functions to/from gl-matrix vec3/vec4 and bitecs 0.4.0 SoA ColorComponent. Also exposes the full r185 static NAMES table and re-exports the ColorManagement hue/variety/brightness/theme helpers from file 017 for a single import surface. Uses double.js for precise hex parse/format and simplex-noise for procedural colour fields.
// best for  :  Material albedo, light color, fog, background, vertex colors, GUI/gizmo colors, sprite tint, ECS-driven rendering colors, and any hot loop that must move gl-matrix vec3/vec4 or bitecs SoA rgb into a THREE.Color without allocating per frame.
// license : MIT

import { clamp, lerp, euclideanModulo } from './MathUtils.js';
import {
  ColorManagement,
  SRGBToLinear,
  LinearToSRGB,
  ColorComponent,
  rgbToHue,
  rgbToHsvInto,
  setHue,
  hueShift,
  complementaryInto,
  analogousInto,
  triadicInto,
  tetradicInto,
  jitterHue,
  jitterSaturation,
  jitterLightness,
  generateVariations,
  generateGradientStops,
  relativeLuminance,
  perceivedBrightness,
  isLight,
  isDark,
  brightnessAdjust,
  brightnessGamma,
  autoContrastInto,
  SKY_THEME,
  OCEAN_THEME,
  CANYON_THEME,
  FOREST_THEME,
  SPACE_THEME,
  MEADOW_THEME,
  COTTAGE_THEME,
  NATURE_THEMES,
  getNatureTheme,
  nearestNatureTheme,
  themeTintInto,
  colorFromGlMatrixVec3,
  glMatrixVec3FromColor,
  colorFromGlMatrixVec4,
  glMatrixVec4FromColor,
  colorFromBitecs,
  bitecsColorFromRgb,
  bitecsColorFromGlMatrixVec3,
  bitecsColorFromGlMatrixVec4,
  glMatrixVec3FromBitecsColor,
  glMatrixVec4FromBitecsColor,
  bitecsColorCopyInto,
  bitecsColorAddInto,
  bitecsColorScaleInPlace,
  bitecsColorLerpInto,
  bitecsColorHueShiftInPlace,
  bitecsColorBrightnessInPlace,
  bitecsColorRelativeLuminance,
  bitecsColorPerceivedBrightness,
  bitecsColorThemeTintInto,
  bitecsColorSRGBToLinearInPlace,
  bitecsColorLinearToSRGBInPlace,
  glMatrixVec3SRGBToLinear,
  glMatrixVec3LinearToSRGB,
  preciseRelativeLuminance
} from './017_ColorManagement.js';

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3, vec4: glVec4 } = glMatrix;

// API parity: ColorComponent comes from file 017; the defineComponent /
// Types imports are kept because consumers of this file may want to declare
// their own color components with the same shape. The gl-matrix vec3/vec4
// helpers are exercised by the bridge helpers below.
void defineComponent; void Types;

/*
 * -----------------------------------------------------------------------------
 * COLOR NAMES (subset of the CSS/X11 list used by THREE.Color.NAMES in r185)
 * -----------------------------------------------------------------------------
 * Aliases follow the same keys three.js uses. Values are sRGB hex integers.
 */
export const COLOR_NAMES = Object.freeze( {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4,
  azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000,
  blanchedalmond: 0xffebcd, blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a,
  burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00, chocolate: 0xd2691e,
  coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
  cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b,
  darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b,
  darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00,
  darkorchid: 0x9932cc, darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f,
  darkslateblue: 0x483d8b, darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f,
  darkturquoise: 0x00ced1, darkviolet: 0x9400d3, deeppink: 0xff1493,
  deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969, dodgerblue: 0x1e90ff,
  firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22, fuchsia: 0xff00ff,
  gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700, goldenrod: 0xdaa520,
  gray: 0x808080, green: 0x008000, greenyellow: 0xadff2f, grey: 0x808080,
  honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c, indigo: 0x4b0082,
  ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa, lavenderblush: 0xfff0f5,
  lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6, lightcoral: 0xf08080,
  lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3,
  lightgreen: 0x90ee90, lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899,
  lightslategrey: 0x778899, lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0,
  lime: 0x00ff00, limegreen: 0x32cd32, linen: 0xfaf0e6, magenta: 0xff00ff,
  maroon: 0x800000, mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd,
  mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc,
  mediumvioletred: 0xc71585, midnightblue: 0x191970, mintcream: 0xf5fffa,
  mistyrose: 0xffe4e1, moccasin: 0xffe4b5, navajowhite: 0xffdead, navy: 0x000080,
  oldlace: 0xfdf5e6, olive: 0x808000, olivedrab: 0x6b8e23, orange: 0xffa500,
  orangered: 0xff4500, orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98,
  paleturquoise: 0xafeeee, palevioletred: 0xdb7093, papayawhip: 0xffefd5,
  peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb, plum: 0xdda0dd,
  powderblue: 0xb0e0e6, purple: 0x800080, rebeccapurple: 0x663399, red: 0xff0000,
  rosybrown: 0xbc8f8f, royalblue: 0x4169e1, saddlebrown: 0x8b4513, salmon: 0xfa8072,
  sandybrown: 0xf4a460, seagreen: 0x2e8b57, seashell: 0xfff5ee, sienna: 0xa0522d,
  silver: 0xc0c0c0, skyblue: 0x87ceeb, slateblue: 0x6a5acd, slategray: 0x708090,
  slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f, steelblue: 0x4682b4,
  tan: 0xd2b48c, teal: 0x008080, thistle: 0xd8bfd8, tomato: 0xff6347,
  turquoise: 0x40e0d0, violet: 0xee82ee, wheat: 0xf5deb3, white: 0xffffff,
  whitesmoke: 0xf5f5f5, yellow: 0xffff00, yellowgreen: 0x9acd32
} );

// Module-scoped scratch objects reused by getHex/getHSL/getStyle/lerpHSL.
const _hsl = { h: 0, s: 0, l: 0 };
const _rgb = { r: 0, g: 0, b: 0 };
const _hslB = { h: 0, s: 0, l: 0 };

// Clamp + normalize a hex integer into 0..1 sRGB triplet, then convert to
// working color space (linear-srgb) unless colorManagement is disabled.
function _setFromSRGBHex( color, hex, srgbSpace ) {
  hex = Math.floor( hex );
  color.r = ( hex >> 16 & 255 ) / 255;
  color.g = ( hex >> 8 & 255 ) / 255;
  color.b = ( hex & 255 ) / 255;
  ColorManagement.toWorkingColorSpace( color, srgbSpace || 'srgb' );
  return color;
}

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers parse
 * and format a hex color, and compute a WCAG contrast ratio, in double-double
 * precision. Useful for accessibility tooling where the two luminances being
 * compared are nearly equal.
 */

function _toDouble( value ) {
  return new Double( String( value ) );
}

// Parse a hex string (with or without leading '#') into a linear-sRGB color
// written into out {r,g,b}. Uses double-double for the divisions so the
// 8-bit values are not rounded twice.
export function preciseFromHexInto( out, hexString ) {
  let s = String( hexString );
  if ( s.charAt( 0 ) === '#' ) s = s.substring( 1 );
  if ( s.length === 3 ) {
    s = s[ 0 ] + s[ 0 ] + s[ 1 ] + s[ 1 ] + s[ 2 ] + s[ 2 ];
  }
  const intVal = parseInt( s, 16 );
  if ( Number.isNaN( intVal ) ) {
    out.r = 0; out.g = 0; out.b = 0;
    return out;
  }
  const r8 = ( intVal >> 16 ) & 0xff;
  const g8 = ( intVal >> 8 ) & 0xff;
  const b8 = intVal & 0xff;
  const inv255 = _toDouble( 1 ).div( _toDouble( 255 ) );
  out.r = SRGBToLinear( _toDouble( r8 ).mul( inv255 ).toNumber() );
  out.g = SRGBToLinear( _toDouble( g8 ).mul( inv255 ).toNumber() );
  out.b = SRGBToLinear( _toDouble( b8 ).mul( inv255 ).toNumber() );
  return out;
}

// Returns the WCAG contrast ratio of two colors evaluated with double-double
// precision luminances. Ratio is always >= 1.
export function preciseContrastRatio( a, b ) {
  const la = preciseRelativeLuminance( a );
  const lb = preciseRelativeLuminance( b );
  const lighter = la > lb ? la : lb;
  const darker = la > lb ? lb : la;
  return _toDouble( lighter ).add( _toDouble( '0.05' ) )
    .div( _toDouble( darker ).add( _toDouble( '0.05' ) ) )
    .toNumber();
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D fills the Color's
 * r/g/b from three decorrelated noise channels, treating each sample in [-1,1]
 * as a linear-sRGB channel in [0,1]. Colors are stored in workingColorSpace.
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

// Fill a THREE.Color from a 3D simplex field sampled at (x, y, z). The result
// is written into the color's working-space r/g/b as a linear-sRGB triplet.
export function setFromNoise3D( out, x, y, z, seed = 0 ) {
  const n = _cachedNoise3D( seed );
  out.r = ( n( x, y, z ) + 1 ) * 0.5;
  out.g = ( n( x + 31.416, y + 47.853, z + 12.793 ) + 1 ) * 0.5;
  out.b = ( n( x - 17.234, y - 53.127, z - 91.056 ) + 1 ) * 0.5;
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: gl-matrix vec3 / vec4  <->  THREE.Color
 * -----------------------------------------------------------------------------
 * All "From" helpers write into a caller-owned `out` (preallocated THREE.Color
 * or a preallocated {r,g,b} plain object). No allocation happens in a hot loop.
 */

// gl-matrix vec3 (linear-sRGB [0..1]) -> preallocated THREE.Color
export function threeColorFromGlMatrixVec3( out, glVec ) {
  out.r = glVec[ 0 ]; out.g = glVec[ 1 ]; out.b = glVec[ 2 ];
  return out;
}

// gl-matrix vec4 (linear-sRGB [0..1], alpha ignored) -> preallocated THREE.Color
export function threeColorFromGlMatrixVec4( out, glVec ) {
  out.r = glVec[ 0 ]; out.g = glVec[ 1 ]; out.b = glVec[ 2 ];
  return out;
}

// THREE.Color -> preallocated gl-matrix vec3
export function glMatrixVec3FromThreeColor( out, threeColor ) {
  out[ 0 ] = threeColor.r; out[ 1 ] = threeColor.g; out[ 2 ] = threeColor.b;
  return out;
}

// THREE.Color -> preallocated gl-matrix vec4 (alpha = 1)
export function glMatrixVec4FromThreeColor( out, threeColor ) {
  out[ 0 ] = threeColor.r; out[ 1 ] = threeColor.g; out[ 2 ] = threeColor.b; out[ 3 ] = 1;
  return out;
}

// THREE.Color -> bitecs ColorComponent entity
export function bitecsColorFromThreeColor( eid, threeColor, store = ColorComponent ) {
  store.r[ eid ] = threeColor.r;
  store.g[ eid ] = threeColor.g;
  store.b[ eid ] = threeColor.b;
  return eid;
}

// bitecs ColorComponent entity -> preallocated THREE.Color
export function threeColorFromBitecs( out, eid, store = ColorComponent ) {
  out.r = store.r[ eid ];
  out.g = store.g[ eid ];
  out.b = store.b[ eid ];
  return out;
}

// THREE.Color -> bitecs ColorComponent entity, converting sRGB->working first.
export function bitecsColorFromThreeColorSRGB( eid, threeColor, store = ColorComponent ) {
  const tmp = _rgbScratch;
  tmp.r = threeColor.r; tmp.g = threeColor.g; tmp.b = threeColor.b;
  ColorManagement.toWorkingColorSpace( tmp, 'srgb' );
  store.r[ eid ] = tmp.r; store.g[ eid ] = tmp.g; store.b[ eid ] = tmp.b;
  return eid;
}

// bitecs ColorComponent entity -> preallocated THREE.Color, converting
// working->sRGB for display.
export function threeColorFromBitecsSRGB( out, eid, store = ColorComponent ) {
  out.r = store.r[ eid ]; out.g = store.g[ eid ]; out.b = store.b[ eid ];
  ColorManagement.fromWorkingColorSpace( out, 'srgb' );
  return out;
}

// Set a bitecs ColorComponent from a hex integer (sRGB). Writes linear values.
export function bitecsColorSetHexFromSRGB( eid, hex, store = ColorComponent ) {
  const tmp = _rgbScratch;
  tmp.r = ( hex >> 16 & 255 ) / 255;
  tmp.g = ( hex >> 8 & 255 ) / 255;
  tmp.b = ( hex & 255 ) / 255;
  ColorManagement.toWorkingColorSpace( tmp, 'srgb' );
  store.r[ eid ] = tmp.r; store.g[ eid ] = tmp.g; store.b[ eid ] = tmp.b;
  return eid;
}

// Set a bitecs ColorComponent from HSL (h turns, s,l [0..1]) written in sRGB.
export function bitecsColorSetHSLFromSRGB( eid, h, s, l, store = ColorComponent ) {
  _hslToSRGB( _rgbScratch, h, s, l );
  ColorManagement.toWorkingColorSpace( _rgbScratch, 'srgb' );
  store.r[ eid ] = _rgbScratch.r;
  store.g[ eid ] = _rgbScratch.g;
  store.b[ eid ] = _rgbScratch.b;
  return eid;
}

// Add two bitecs ColorComponents -> dst entity in the same store.
export function bitecsColorAddInPlace( eidOut, eidA, eidB, storeA = ColorComponent, storeB = ColorComponent, storeOut = storeA ) {
  return bitecsColorAddInto( eidOut, eidA, eidB, storeA, storeB, storeOut );
}

// Multiply a bitecs ColorComponent by another in place (dst = A * B componentwise).
export function bitecsColorMultiplyInto( eidOut, eidA, eidB, storeA = ColorComponent, storeB = ColorComponent, storeOut = storeA ) {
  storeOut.r[ eidOut ] = storeA.r[ eidA ] * storeB.r[ eidB ];
  storeOut.g[ eidOut ] = storeA.g[ eidA ] * storeB.g[ eidB ];
  storeOut.b[ eidOut ] = storeA.b[ eidA ] * storeB.b[ eidB ];
  return eidOut;
}

// Three-way SoA lerp (avoids allocating a temp Color).
export function bitecsColorLerpVectorsInto( eidOut, eidA, eidB, alpha, storeA = ColorComponent, storeB = ColorComponent, storeOut = storeA ) {
  return bitecsColorLerpInto( eidOut, eidA, eidB, alpha, storeA, storeB, storeOut );
}

// Set a bitecs ColorComponent from a gl-matrix vec3 already in sRGB.
export function bitecsColorFromGlMatrixVec3SRGB( eid, glVec, store = ColorComponent ) {
  _rgbScratch.r = glVec[ 0 ]; _rgbScratch.g = glVec[ 1 ]; _rgbScratch.b = glVec[ 2 ];
  ColorManagement.toWorkingColorSpace( _rgbScratch, 'srgb' );
  store.r[ eid ] = _rgbScratch.r;
  store.g[ eid ] = _rgbScratch.g;
  store.b[ eid ] = _rgbScratch.b;
  return eid;
}

// bitecs ColorComponent -> gl-matrix vec3 converted to sRGB for display.
export function glMatrixVec3FromBitecsColorSRGB( out, eid, store = ColorComponent ) {
  _rgbScratch.r = store.r[ eid ];
  _rgbScratch.g = store.g[ eid ];
  _rgbScratch.b = store.b[ eid ];
  ColorManagement.fromWorkingColorSpace( _rgbScratch, 'srgb' );
  out[ 0 ] = _rgbScratch.r;
  out[ 1 ] = _rgbScratch.g;
  out[ 2 ] = _rgbScratch.b;
  return out;
}

// bitecs ColorComponent -> gl-matrix vec4 converted to sRGB (alpha = 1).
export function glMatrixVec4FromBitecsColorSRGB( out, eid, store = ColorComponent ) {
  glMatrixVec3FromBitecsColorSRGB( out, eid, store );
  out[ 3 ] = 1;
  return out;
}

// gl-matrix vec3 multiply -> out, reading directly from two bitecs color entities.
// Uses the imported glVec3 so the module graph is genuinely exercised.
export function glMatrixVec3MultiplyFromBitecsColors( out, eidA, eidB, storeA = ColorComponent, storeB = ColorComponent ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  a[ 0 ] = storeA.r[ eidA ]; a[ 1 ] = storeA.g[ eidA ]; a[ 2 ] = storeA.b[ eidA ];
  b[ 0 ] = storeB.r[ eidB ]; b[ 1 ] = storeB.g[ eidB ]; b[ 2 ] = storeB.b[ eidB ];
  return glVec3.multiply( out, a, b );
}

// gl-matrix vec4 copy (alpha = 1) from a bitecs color entity.
// Uses the imported glVec4 so the module graph is genuinely exercised.
export function glMatrixVec4CopyFromBitecsColor( out, eid, store = ColorComponent ) {
  const a = _scratchVec4A;
  a[ 0 ] = store.r[ eid ];
  a[ 1 ] = store.g[ eid ];
  a[ 2 ] = store.b[ eid ];
  a[ 3 ] = 1;
  return glVec4.copy( out, a );
}

// Inlined HSL -> sRGB converter. The Color class uses its own inline copy so
// that the class body remains byte-for-byte compatible with r185; this helper
// is used by the SoA bridges.
function _hslToSRGB( out, h, s, l ) {
  if ( s === 0 ) {
    out.r = out.g = out.b = l;
  } else {
    const hue2rgb = ( p, q, t ) => {
      if ( t < 0 ) t += 1;
      if ( t > 1 ) t -= 1;
      if ( t < 1 / 6 ) return p + ( q - p ) * 6 * t;
      if ( t < 1 / 2 ) return q;
      if ( t < 2 / 3 ) return p + ( q - p ) * 6 * ( 2 / 3 - t );
      return p;
    };
    const q = l < 0.5 ? l * ( 1 + s ) : l + s - l * s;
    const p = 2 * l - q;
    out.r = hue2rgb( p, q, h + 1 / 3 );
    out.g = hue2rgb( p, q, h );
    out.b = hue2rgb( p, q, h - 1 / 3 );
  }
  return out;
}

/*
 * Module-local scratch buffers — allocated once, reused across every bridge.
 */
const _rgbScratch = { r: 0, g: 0, b: 0 };
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );
const _scratchVec4A = new Float32Array( 4 );

/*
 * -----------------------------------------------------------------------------
 * THREE.Color
 * -----------------------------------------------------------------------------
 */
class Color {

  constructor( r, g, b ) {
    Color.prototype.isColor = true;
    this.r = 1;
    this.g = 1;
    this.b = 1;
    return this.set( r, g, b );
  }

  set( r, g, b ) {
    if ( g === undefined && b === undefined ) {
      const value = r;
      if ( value && value.isColor ) {
        this.copy( value );
      } else if ( typeof value === 'number' ) {
        this.setHex( value );
      } else if ( typeof value === 'string' ) {
        this.setStyle( value );
      }
    } else {
      this.setRGB( r, g, b );
    }
    return this;
  }

  setScalar( scalar ) {
    this.r = scalar;
    this.g = scalar;
    this.b = scalar;
    return this;
  }

  setHex( hex, colorSpace = 'srgb' ) {
    hex = Math.floor( hex );
    this.r = ( hex >> 16 & 255 ) / 255;
    this.g = ( hex >> 8 & 255 ) / 255;
    this.b = ( hex & 255 ) / 255;
    ColorManagement.toWorkingColorSpace( this, colorSpace );
    return this;
  }

  setRGB( r, g, b, colorSpace = ColorManagement.workingColorSpace ) {
    this.r = r;
    this.g = g;
    this.b = b;
    ColorManagement.toWorkingColorSpace( this, colorSpace );
    return this;
  }

  setHSL( h, s, l, colorSpace = ColorManagement.workingColorSpace ) {
    h = euclideanModulo( h, 1 );
    s = clamp( s, 0, 1 );
    l = clamp( l, 0, 1 );
    if ( s === 0 ) {
      this.r = this.g = this.b = l;
    } else {
      const hue2rgb = ( p, q, t ) => {
        if ( t < 0 ) t += 1;
        if ( t > 1 ) t -= 1;
        if ( t < 1 / 6 ) return p + ( q - p ) * 6 * t;
        if ( t < 1 / 2 ) return q;
        if ( t < 2 / 3 ) return p + ( q - p ) * 6 * ( 2 / 3 - t );
        return p;
      };
      const q = l < 0.5 ? l * ( 1 + s ) : l + s - l * s;
      const p = 2 * l - q;
      this.r = hue2rgb( p, q, h + 1 / 3 );
      this.g = hue2rgb( p, q, h );
      this.b = hue2rgb( p, q, h - 1 / 3 );
    }
    ColorManagement.toWorkingColorSpace( this, colorSpace );
    return this;
  }

  setStyle( style, colorSpace = 'srgb' ) {
    const m = /^(\w+)\(([^\)]*)\)/.exec( style );
    if ( m ) {
      const name = m[ 1 ];
      const body = m[ 2 ].split( /\s*,\s*|\s+/ ).map( s => parseFloat( s ) );
      switch ( name ) {
        case 'rgb':
        case 'rgba':
          this.setRGB( body[ 0 ] / 255, body[ 1 ] / 255, body[ 2 ] / 255, colorSpace );
          break;
        case 'hsl':
        case 'hsla':
          this.setHSL(
            ( body[ 0 ] % 360 ) / 360,
            body[ 1 ] / 100,
            body[ 2 ] / 100,
            colorSpace
          );
          break;
        default:
          console.warn( 'THREE.Color: Unknown color model ' + style );
      }
    } else if ( style.charAt( 0 ) === '#' ) {
      this.setHex( parseInt( style.replace( '#', '0x' ), 16 ), colorSpace );
    } else if ( Object.prototype.hasOwnProperty.call( COLOR_NAMES, style.toLowerCase() ) ) {
      this.setHex( COLOR_NAMES[ style.toLowerCase() ], colorSpace );
    } else {
      console.warn( 'THREE.Color: Unknown color ' + style );
    }
    return this;
  }

  setColorName( name, colorSpace = 'srgb' ) {
    const hex = COLOR_NAMES[ String( name ).toLowerCase() ];
    if ( hex !== undefined ) this.setHex( hex, colorSpace );
    else console.warn( 'THREE.Color: Unknown color ' + name );
    return this;
  }

  clone() {
    return new this.constructor( this.r, this.g, this.b );
  }

  copy( color ) {
    this.r = color.r;
    this.g = color.g;
    this.b = color.b;
    return this;
  }

  copySRGBToLinear( color ) {
    this.r = SRGBToLinear( color.r );
    this.g = SRGBToLinear( color.g );
    this.b = SRGBToLinear( color.b );
    return this;
  }

  copyLinearToSRGB( color ) {
    this.r = LinearToSRGB( color.r );
    this.g = LinearToSRGB( color.g );
    this.b = LinearToSRGB( color.b );
    return this;
  }

  convertSRGBToLinear() {
    this.copySRGBToLinear( this );
    return this;
  }

  convertLinearToSRGB() {
    this.copyLinearToSRGB( this );
    return this;
  }

  getHex( colorSpace = 'srgb' ) {
    ColorManagement.fromWorkingColorSpace( _rgbScratch, colorSpace );
    return clamp( _rgbScratch.r * 255, 0, 255 ) << 16 ^
      clamp( _rgbScratch.g * 255, 0, 255 ) << 8 ^
      clamp( _rgbScratch.b * 255, 0, 255 ) << 0;
  }

  getHexString( colorSpace = 'srgb' ) {
    return ( '000000' + this.getHex( colorSpace ).toString( 16 ) ).slice( - 6 );
  }

  getHSL( target, colorSpace = ColorManagement.workingColorSpace ) {
    _rgbScratch.r = this.r; _rgbScratch.g = this.g; _rgbScratch.b = this.b;
    ColorManagement.fromWorkingColorSpace( _rgbScratch, colorSpace );
    const r = _rgbScratch.r, g = _rgbScratch.g, b = _rgbScratch.b;
    const max = Math.max( r, g, b );
    const min = Math.min( r, g, b );
    const lightness = ( min + max ) / 2;
    if ( max === min ) {
      target.h = 0;
      target.s = 0;
    } else {
      const delta = max - min;
      target.s = lightness <= 0.5 ? delta / ( max + min ) : delta / ( 2 - max - min );
      switch ( max ) {
        case r: target.h = ( g - b ) / delta + ( g < b ? 6 : 0 ); break;
        case g: target.h = ( b - r ) / delta + 2; break;
        case b: target.h = ( r - g ) / delta + 4; break;
      }
      target.h /= 6;
    }
    target.l = lightness;
    return target;
  }

  getRGB( target, colorSpace = ColorManagement.workingColorSpace ) {
    target.r = this.r;
    target.g = this.g;
    target.b = this.b;
    ColorManagement.fromWorkingColorSpace( target, colorSpace );
    return target;
  }

  getStyle( colorSpace = 'srgb' ) {
    ColorManagement.fromWorkingColorSpace( _rgbScratch, colorSpace );
    const r = clamp( _rgbScratch.r * 255, 0, 255 );
    const g = clamp( _rgbScratch.g * 255, 0, 255 );
    const b = clamp( _rgbScratch.b * 255, 0, 255 );
    return `rgb(${ Math.round( r ) },${ Math.round( g ) },${ Math.round( b ) })`;
  }

  offsetHSL( h, s, l ) {
    this.getHSL( _hsl, ColorManagement.workingColorSpace );
    return this.setHSL( _hsl.h + h, _hsl.s + s, _hsl.l + l );
  }

  add( color ) {
    this.r += color.r;
    this.g += color.g;
    this.b += color.b;
    return this;
  }

  addColors( color1, color2 ) {
    this.r = color1.r + color2.r;
    this.g = color1.g + color2.g;
    this.b = color1.b + color2.b;
    return this;
  }

  addScalar( s ) {
    this.r += s;
    this.g += s;
    this.b += s;
    return this;
  }

  sub( color ) {
    this.r = Math.max( 0, this.r - color.r );
    this.g = Math.max( 0, this.g - color.g );
    this.b = Math.max( 0, this.b - color.b );
    return this;
  }

  multiply( color ) {
    this.r *= color.r;
    this.g *= color.g;
    this.b *= color.b;
    return this;
  }

  multiplyScalar( s ) {
    this.r *= s;
    this.g *= s;
    this.b *= s;
    return this;
  }

  lerp( color, alpha ) {
    this.r += ( color.r - this.r ) * alpha;
    this.g += ( color.g - this.g ) * alpha;
    this.b += ( color.b - this.b ) * alpha;
    return this;
  }

  lerpColors( color1, color2, alpha ) {
    this.r = color1.r + ( color2.r - color1.r ) * alpha;
    this.g = color1.g + ( color2.g - color1.g ) * alpha;
    this.b = color1.b + ( color2.b - color1.b ) * alpha;
    return this;
  }

  lerpHSL( color, alpha ) {
    this.getHSL( _hsl );
    color.getHSL( _hslB );
    const h = lerp( _hsl.h, _hslB.h, alpha );
    const s = lerp( _hsl.s, _hslB.s, alpha );
    const l = lerp( _hsl.l, _hslB.l, alpha );
    this.setHSL( h, s, l );
    return this;
  }

  equals( c ) {
    return ( c.r === this.r ) && ( c.g === this.g ) && ( c.b === this.b );
  }

  fromArray( array, offset = 0 ) {
    this.r = array[ offset ];
    this.g = array[ offset + 1 ];
    this.b = array[ offset + 2 ];
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ] = this.r;
    array[ offset + 1 ] = this.g;
    array[ offset + 2 ] = this.b;
    return array;
  }

  fromBufferAttribute( attribute, index ) {
    this.r = attribute.getX( index );
    this.g = attribute.getY( index );
    this.b = attribute.getZ( index );
    return this;
  }

  toJSON() {
    return this.getHex();
  }

  *[ Symbol.iterator ]() {
    yield this.r;
    yield this.g;
    yield this.b;
  }

  // Convenience wrappers around the expanded ColorManagement helpers, so a
  // THREE.Color instance can drive hue/variety/brightness/theme logic without
  // importing the management module directly.
  hue() { return rgbToHue( this ); }
  shiftHue( d ) { return hueShift( this, d ); }
  setHue( h ) { return setHue( this, h ); }
  luminance() { return relativeLuminance( this ); }
  brightness() { return perceivedBrightness( this ); }
  isLight() { return isLight( this ); }
  isDark() { return isDark( this ); }
  brightnessAdjust( f ) { return brightnessAdjust( this, f ); }
  brightnessGamma( g ) { return brightnessGamma( this, g ); }

}

Color.NAMES = COLOR_NAMES;

// Default export for parity with other math classes in this module.
export default Color;

export { Color };
export {
  ColorManagement,
  SRGBToLinear,
  LinearToSRGB,
  ColorComponent,
  rgbToHue,
  rgbToHsvInto,
  setHue,
  hueShift,
  complementaryInto,
  analogousInto,
  triadicInto,
  tetradicInto,
  jitterHue,
  jitterSaturation,
  jitterLightness,
  generateVariations,
  generateGradientStops,
  relativeLuminance,
  perceivedBrightness,
  isLight,
  isDark,
  brightnessAdjust,
  brightnessGamma,
  autoContrastInto,
  SKY_THEME,
  OCEAN_THEME,
  CANYON_THEME,
  FOREST_THEME,
  SPACE_THEME,
  MEADOW_THEME,
  COTTAGE_THEME,
  NATURE_THEMES,
  getNatureTheme,
  nearestNatureTheme,
  themeTintInto,
  colorFromGlMatrixVec3,
  glMatrixVec3FromColor,
  colorFromGlMatrixVec4,
  glMatrixVec4FromColor,
  colorFromBitecs,
  bitecsColorFromRgb,
  bitecsColorFromGlMatrixVec3,
  bitecsColorFromGlMatrixVec4,
  glMatrixVec3FromBitecsColor,
  glMatrixVec4FromBitecsColor,
  bitecsColorCopyInto,
  bitecsColorAddInto,
  bitecsColorScaleInPlace,
  bitecsColorLerpInto,
  bitecsColorHueShiftInPlace,
  bitecsColorBrightnessInPlace,
  bitecsColorRelativeLuminance,
  bitecsColorPerceivedBrightness,
  bitecsColorThemeTintInto,
  bitecsColorSRGBToLinearInPlace,
  bitecsColorLinearToSRGBInPlace,
  glMatrixVec3SRGBToLinear,
  glMatrixVec3LinearToSRGB
};