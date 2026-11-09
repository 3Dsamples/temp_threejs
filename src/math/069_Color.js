// file number : 069
// full path name : src/math/069_Color.js
// description : `THREE.Color`-compatible color primitive — drop-in replacement for THREE.Color (r185). Stores r/g/b in working color space (default linear-sRGB [0..1]) with an isColor flag. Complete r185 surface: constructor(r?, g?, b?), set(r?, g?, b?), setScalar(s), setHex(hex, colorSpace='srgb'), setRGB(r, g, b, colorSpace=workingColorSpace), setHSL(h, s, l, colorSpace=workingColorSpace), setStyle(style, colorSpace='srgb'), setColorName(name, colorSpace='srgb'), copy(color), copySRGBToLinear(color), copyLinearToSRGB(color), convertSRGBToLinear(), convertLinearToSRGB(), getHex(colorSpace='srgb'), getHexString(colorSpace='srgb'), getHSL(target, colorSpace=workingColorSpace), getRGB(target, colorSpace=workingColorSpace), getStyle(colorSpace='srgb'), offsetHSL(h, s, l), add(color), addColors(a, b), addScalar(s), sub(color), multiply(color), multiplyScalar(s), lerp(color, alpha), lerpColors(a, b, alpha), lerpHSL(color, alpha), equals(c), fromArray(arr, offset=0), toArray(arr=[], offset=0), fromBufferAttribute(attr, index), toJSON(), clone(), Symbol.iterator, static Color.NAMES (full CSS/X11 table). Extended: preciseFromHexInto / preciseContrastRatio via DoubleDouble (014) for accessibility and galactic-scale HDR luminance; setFromNoise3D via SimplexNoise (013) with cached per-seed mulberry32; full zero-alloc bitECS SoA bridge set using 068's ColorComponent (r/g/b f32([])) covering from/to/copy/add/sub/mul/scale-in-place/lerp/hue-shift/brightness/luminance/perceived-brightness/theme-tint/srgb<->linear; flat-array [r,g,b] and [r,g,b,a] interop with alpha preserved; and a recycled local pool via Color.acquire / Color.recycle that resets to linear-white (1,1,1). Delegates all color-space math to 068_ColorManagement so a single working-color-space switch updates the whole engine. Uses 003_Common (clamp, euclideanModulo) and 004_Precision only for the error-free round-trip on hex I/O. No THREE, no CDN, no static server, no Vite/Vue.
// best for : PBR material albedo, light color, fog, scene background, vertex colors, GUI/gizmo overlays, sprite tint, anime-flat palette selection, semi-realistic rim/subsurface tint, ECS-driven rendering colors, and any hot loop that must move flat-array or bitecs SoA rgb into a THREE.Color (or from it) without allocating per frame. The pooled variant is the recommended path for per-frame UI and shader uniforms at 10k+ entities on Android 64-bit.
// license : MIT

import { clamp, euclideanModulo } from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as bitecs from './014_BitECS.js';
import { createNoise3D } from './013_SimplexNoise.js';
import {
  ColorManagement,
  SRGBToLinear,
  LinearToSRGB,
  ColorComponent,
  rgbToHue,
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
  setFromNoise3D as cmSetFromNoise3D,
  noiseTintInto,
  colorFromBitecs,
  bitecsColorFromColor,
  bitecsColorFromFlat3,
  flat3FromBitecsColor,
  bitecsColorCopyInto,
  bitecsColorAddInto,
  bitecsColorSubInto,
  bitecsColorMulInto,
  bitecsColorScaleInPlace,
  bitecsColorLerpInto,
  bitecsColorHueShiftInPlace,
  bitecsColorBrightnessInPlace,
  bitecsColorRelativeLuminance,
  bitecsColorPerceivedBrightness,
  bitecsColorThemeTintInto,
  bitecsColorSRGBToLinearInPlace,
  bitecsColorLinearToSRGBInPlace,
  bitecsColorApplyThemeRange,
  colorFromFlat3,
  colorFromFlat4,
  flat3FromColor,
  flat4FromColor,
  sRGB3ToLinear3,
  linear3ToSRGB3,
  preciseSRGBToLinear,
  preciseLinearToSRGB,
  preciseRelativeLuminance,
  preciseContrastRatio
} from './068_ColorManagement.js';

// ═══════════════════════════════════════════════════════════════════
// CSS / X11 named color table (r185 parity)
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
// Duck-typed color accessors — zero allocation in hot paths
// ═══════════════════════════════════════════════════════════════════

function _cr( c ) { return c.r !== undefined ? c.r : c[ 0 ]; }
function _cg( c ) { return c.g !== undefined ? c.g : c[ 1 ]; }
function _cb( c ) { return c.b !== undefined ? c.b : c[ 2 ]; }

function _writeColor( c, r, g, b ) {
  if ( c === null || c === undefined ) return { r, g, b };
  if ( Array.isArray( c ) ) {
    c[ 0 ] = r;
    c[ 1 ] = g;
    c[ 2 ] = b;
    return c;
  }
  c.r = r;
  c.g = g;
  c.b = b;
  return c;
}

function _copyColorInto( target, source ) {
  return _writeColor( target, _cr( source ), _cg( source ), _cb( source ) );
}

// ────────────── scratch buffers ──────────────
const _hslScratch = { h: 0, s: 0, l: 0 };
const _hslScratchB = { h: 0, s: 0, l: 0 };
const _rgbScratch = { r: 0, g: 0, b: 0 };
const _rgbScratchB = { r: 0, g: 0, b: 0 };

// ────────────── noise cache ──────────────
const _noise3DCache = new Map();

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

// ────────────── local pool ──────────────
const _localPool = [];
const LOCAL_POOL_MAX = 512;

// ═══════════════════════════════════════════════════════════════════
// HSL ↔ RGB helpers (working in the same space as r185's Color)
// HSL uses turns for hue (0..1), s and l in [0..1].
// ═══════════════════════════════════════════════════════════════════

function _hue2rgb( p, q, t ) {
  if ( t < 0 ) t += 1;
  if ( t > 1 ) t -= 1;
  if ( t < 1 / 6 ) return p + ( q - p ) * 6 * t;
  if ( t < 1 / 2 ) return q;
  if ( t < 2 / 3 ) return p + ( q - p ) * 6 * ( 2 / 3 - t );
  return p;
}

// Writes HSL → RGB (in the SAME color space as the input HSL) into out.
function _hslToRgbInto( out, h, s, l ) {
  h = euclideanModulo( h, 1 );
  s = clamp( s, 0, 1 );
  l = clamp( l, 0, 1 );

  if ( s === 0 ) {
    return _writeColor( out, l, l, l );
  }
  const q = l < 0.5 ? l * ( 1 + s ) : l + s - l * s;
  const p = 2 * l - q;
  return _writeColor(
    out,
    _hue2rgb( p, q, h + 1 / 3 ),
    _hue2rgb( p, q, h ),
    _hue2rgb( p, q, h - 1 / 3 )
  );
}

// Writes RGB → HSL into out { h, s, l }.
function _rgbToHslInto( out, r, g, b ) {
  const max = Math.max( r, g, b );
  const min = Math.min( r, g, b );
  const lightness = ( min + max ) / 2;

  if ( max === min ) {
    out.h = 0;
    out.s = 0;
  } else {
    const delta = max - min;
    out.s = lightness <= 0.5 ? delta / ( max + min ) : delta / ( 2 - max - min );
    switch ( max ) {
      case r: out.h = ( g - b ) / delta + ( g < b ? 6 : 0 ); break;
      case g: out.h = ( b - r ) / delta + 2; break;
      case b: out.h = ( r - g ) / delta + 4; break;
    }
    out.h /= 6;
  }
  out.l = lightness;
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// class Color
// ═══════════════════════════════════════════════════════════════════
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
    _hslToRgbInto( _rgbScratch, h, s, l );
    this.r = _rgbScratch.r;
    this.g = _rgbScratch.g;
    this.b = _rgbScratch.b;
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
          // Unrecognized CSS function — leave color unchanged.
          break;
      }
    } else if ( style.charAt( 0 ) === '#' ) {
      this.setHex( parseInt( style.replace( '#', '0x' ), 16 ), colorSpace );
    } else if ( Object.prototype.hasOwnProperty.call( COLOR_NAMES, style.toLowerCase() ) ) {
      this.setHex( COLOR_NAMES[ style.toLowerCase() ], colorSpace );
    }
    return this;
  }

  setColorName( name, colorSpace = 'srgb' ) {
    const hex = COLOR_NAMES[ String( name ).toLowerCase() ];
    if ( hex !== undefined ) this.setHex( hex, colorSpace );
    return this;
  }

  copy( color ) {
    this.r = _cr( color );
    this.g = _cg( color );
    this.b = _cb( color );
    return this;
  }

  copySRGBToLinear( color ) {
    this.r = SRGBToLinear( _cr( color ) );
    this.g = SRGBToLinear( _cg( color ) );
    this.b = SRGBToLinear( _cb( color ) );
    return this;
  }

  copyLinearToSRGB( color ) {
    this.r = LinearToSRGB( _cr( color ) );
    this.g = LinearToSRGB( _cg( color ) );
    this.b = LinearToSRGB( _cb( color ) );
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
    _writeColor( _rgbScratch, this.r, this.g, this.b );
    ColorManagement.fromWorkingColorSpace( _rgbScratch, colorSpace );
    return (
      ( clamp( Math.round( _rgbScratch.r * 255 ), 0, 255 ) << 16 ) ^
      ( clamp( Math.round( _rgbScratch.g * 255 ), 0, 255 ) << 8 ) ^
      ( clamp( Math.round( _rgbScratch.b * 255 ), 0, 255 ) << 0 )
    );
  }

  getHexString( colorSpace = 'srgb' ) {
    return ( '000000' + this.getHex( colorSpace ).toString( 16 ) ).slice( -6 );
  }

  getHSL( target, colorSpace = ColorManagement.workingColorSpace ) {
    _writeColor( _rgbScratch, this.r, this.g, this.b );
    ColorManagement.fromWorkingColorSpace( _rgbScratch, colorSpace );
    return _rgbToHslInto( target, _rgbScratch.r, _rgbScratch.g, _rgbScratch.b );
  }

  getRGB( target, colorSpace = ColorManagement.workingColorSpace ) {
    _writeColor( target, this.r, this.g, this.b );
    ColorManagement.fromWorkingColorSpace( target, colorSpace );
    return target;
  }

  getStyle( colorSpace = 'srgb' ) {
    _writeColor( _rgbScratch, this.r, this.g, this.b );
    ColorManagement.fromWorkingColorSpace( _rgbScratch, colorSpace );
    const r = clamp( Math.round( _rgbScratch.r * 255 ), 0, 255 );
    const g = clamp( Math.round( _rgbScratch.g * 255 ), 0, 255 );
    const b = clamp( Math.round( _rgbScratch.b * 255 ), 0, 255 );
    return `rgb(${r},${g},${b})`;
  }

  offsetHSL( h, s, l ) {
    this.getHSL( _hslScratch, ColorManagement.workingColorSpace );
    return this.setHSL( _hslScratch.h + h, _hslScratch.s + s, _hslScratch.l + l );
  }

  add( color ) {
    this.r += _cr( color );
    this.g += _cg( color );
    this.b += _cb( color );
    return this;
  }

  addColors( color1, color2 ) {
    this.r = _cr( color1 ) + _cr( color2 );
    this.g = _cg( color1 ) + _cg( color2 );
    this.b = _cb( color1 ) + _cb( color2 );
    return this;
  }

  addScalar( s ) {
    this.r += s;
    this.g += s;
    this.b += s;
    return this;
  }

  sub( color ) {
    this.r = Math.max( 0, this.r - _cr( color ) );
    this.g = Math.max( 0, this.g - _cg( color ) );
    this.b = Math.max( 0, this.b - _cb( color ) );
    return this;
  }

  multiply( color ) {
    this.r *= _cr( color );
    this.g *= _cg( color );
    this.b *= _cb( color );
    return this;
  }

  multiplyScalar( s ) {
    this.r *= s;
    this.g *= s;
    this.b *= s;
    return this;
  }

  lerp( color, alpha ) {
    this.r += ( _cr( color ) - this.r ) * alpha;
    this.g += ( _cg( color ) - this.g ) * alpha;
    this.b += ( _cb( color ) - this.b ) * alpha;
    return this;
  }

  lerpColors( color1, color2, alpha ) {
    this.r = _cr( color1 ) + ( _cr( color2 ) - _cr( color1 ) ) * alpha;
    this.g = _cg( color1 ) + ( _cg( color2 ) - _cg( color1 ) ) * alpha;
    this.b = _cb( color1 ) + ( _cb( color2 ) - _cb( color1 ) ) * alpha;
    return this;
  }

  lerpHSL( color, alpha ) {
    this.getHSL( _hslScratch );
    _writeColor( _rgbScratch, _cr( color ), _cg( color ), _cb( color ) );
    _rgbToHslInto( _hslScratchB, _rgbScratch.r, _rgbScratch.g, _rgbScratch.b );

    const h = _hslScratch.h + ( _hslScratchB.h - _hslScratch.h ) * alpha;
    const s = _hslScratch.s + ( _hslScratchB.s - _hslScratch.s ) * alpha;
    const l = _hslScratch.l + ( _hslScratchB.l - _hslScratch.l ) * alpha;
    this.setHSL( h, s, l );
    return this;
  }

  equals( c ) {
    return _cr( c ) === this.r && _cg( c ) === this.g && _cb( c ) === this.b;
  }

  fromArray( array, offset = 0 ) {
    this.r = array[ offset ];
    this.g = array[ offset + 1 ];
    this.b = array[ offset + 2 ];
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ]     = this.r;
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

  clone() {
    return new this.constructor( this.r, this.g, this.b );
  }

  *[ Symbol.iterator ]() {
    yield this.r;
    yield this.g;
    yield this.b;
  }

  // ────────────── extended helpers (delegate to 068) ──────────────

  hue() { return rgbToHue( this ); }
  shiftHue( d ) { return hueShift( this, d ); }
  setHue( h ) { return setHue( this, h ); }
  luminance() { return relativeLuminance( this ); }
  brightness() { return perceivedBrightness( this ); }
  isLight() { return isLight( this ); }
  isDark() { return isDark( this ); }
  brightnessAdjust( f ) { return brightnessAdjust( this, f ); }
  brightnessGamma( g ) { return brightnessGamma( this, g ); }
  contrastRatio( other ) { return preciseContrastRatio( this, other ); }

  // ────────────── pooled instances ──────────────

  static acquire() {
    return _localPool.length > 0 ? _localPool.pop() : new Color();
  }

  static recycle( color ) {
    if ( color instanceof Color && _localPool.length < LOCAL_POOL_MAX ) {
      color.r = 1;
      color.g = 1;
      color.b = 1;
      _localPool.push( color );
    }
  }

  static poolReset() {
    _localPool.length = 0;
  }

  static poolSize() {
    return _localPool.length;
  }
}

// Full CSS/X11 name table exposed on the class (r185 parity).
Color.NAMES = COLOR_NAMES;

// ═══════════════════════════════════════════════════════════════════
// HIGH-PRECISION (DoubleDouble) helpers — accessibility / HDR I/O
// ═══════════════════════════════════════════════════════════════════

const _INV_255 = DD.divide( DD.fromDouble( 1 ), DD.fromDouble( 255 ) );

// Parse a hex string (with or without leading '#') into a linear-sRGB color
// written into `out`. Uses double-double for the divisions so the 8-bit
// channel values are not rounded twice.
export function preciseFromHexInto( out, hexString ) {
  let s = String( hexString );
  if ( s.charAt( 0 ) === '#' ) s = s.substring( 1 );
  if ( s.length === 3 ) {
    s = s[ 0 ] + s[ 0 ] + s[ 1 ] + s[ 1 ] + s[ 2 ] + s[ 2 ];
  }
  const intVal = parseInt( s, 16 );
  if ( Number.isNaN( intVal ) ) {
    return _writeColor( out, 0, 0, 0 );
  }
  const r8 = ( intVal >> 16 ) & 0xff;
  const g8 = ( intVal >> 8 ) & 0xff;
  const b8 = intVal & 0xff;
  const r = DD.toDouble( DD.multiply( DD.fromDouble( r8 ), _INV_255 ) );
  const g = DD.toDouble( DD.multiply( DD.fromDouble( g8 ), _INV_255 ) );
  const b = DD.toDouble( DD.multiply( DD.fromDouble( b8 ), _INV_255 ) );
  return _writeColor(
    out,
    preciseSRGBToLinear( r ),
    preciseSRGBToLinear( g ),
    preciseSRGBToLinear( b )
  );
}

// ═══════════════════════════════════════════════════════════════════
// PROCEDURAL color via SimplexNoise (separate from 068 for class-level use)
// ═══════════════════════════════════════════════════════════════════

export function setFromNoise3D( out, x, y, z, seed = 0 ) {
  const n = _cachedNoise3D( seed );
  return _writeColor(
    out,
    ( n( x, y, z ) + 1 ) * 0.5,
    ( n( x + 31.416, y + 47.853, z + 12.793 ) + 1 ) * 0.5,
    ( n( x - 17.234, y - 53.127, z - 91.056 ) + 1 ) * 0.5
  );
}

// ═══════════════════════════════════════════════════════════════════
// bitECS SoA bridge that accepts Color instances or ColorComponent
// ═══════════════════════════════════════════════════════════════════

export function bitecsColorFromColorInstance( eid, color, store = ColorComponent ) {
  store.r[ eid ] = color.r;
  store.g[ eid ] = color.g;
  store.b[ eid ] = color.b;
  return eid;
}

export function colorInstanceFromBitecs( out, eid, store = ColorComponent ) {
  out.r = store.r[ eid ];
  out.g = store.g[ eid ];
  out.b = store.b[ eid ];
  return out;
}

export function bitecsColorFromColorSRGB( eid, color, store = ColorComponent ) {
  _writeColor( _rgbScratch, color.r, color.g, color.b );
  ColorManagement.toWorkingColorSpace( _rgbScratch, 'srgb' );
  store.r[ eid ] = _rgbScratch.r;
  store.g[ eid ] = _rgbScratch.g;
  store.b[ eid ] = _rgbScratch.b;
  return eid;
}

export function colorInstanceFromBitecsSRGB( out, eid, store = ColorComponent ) {
  _writeColor( _rgbScratch, store.r[ eid ], store.g[ eid ], store.b[ eid ] );
  ColorManagement.fromWorkingColorSpace( _rgbScratch, 'srgb' );
  out.r = _rgbScratch.r;
  out.g = _rgbScratch.g;
  out.b = _rgbScratch.b;
  return out;
}

export function bitecsColorFromHex( eid, hex, store = ColorComponent ) {
  store.r[ eid ] = ( hex >> 16 & 255 ) / 255;
  store.g[ eid ] = ( hex >> 8 & 255 ) / 255;
  store.b[ eid ] = ( hex & 255 ) / 255;
  bitecsColorSRGBToLinearInPlace( eid, store );
  return eid;
}

// Bulk apply a Color to a range of SoA entities.
export function bitecsColorApplyInstanceRange( store, color, startEid, count ) {
  const r = color.r, g = color.g, b = color.b;
  const end = startEid + count;
  for ( let eid = startEid; eid < end; eid ++ ) {
    store.r[ eid ] = r;
    store.g[ eid ] = g;
    store.b[ eid ] = b;
  }
  return end;
}

// ═══════════════════════════════════════════════════════════════════
// Re-export the extended palette/theme/brightness/hue helpers so a single
// `import { Color, SKY_THEME, ... } from './069_Color.js'` is enough.
// ═══════════════════════════════════════════════════════════════════

export {
  ColorManagement,
  SRGBToLinear,
  LinearToSRGB,
  ColorComponent,
  rgbToHue,
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
  noiseTintInto,
  colorFromBitecs,
  bitecsColorFromColor,
  bitecsColorFromFlat3,
  flat3FromBitecsColor,
  bitecsColorCopyInto,
  bitecsColorAddInto,
  bitecsColorSubInto,
  bitecsColorMulInto,
  bitecsColorScaleInPlace,
  bitecsColorLerpInto,
  bitecsColorHueShiftInPlace,
  bitecsColorBrightnessInPlace,
  bitecsColorRelativeLuminance,
  bitecsColorPerceivedBrightness,
  bitecsColorThemeTintInto,
  bitecsColorSRGBToLinearInPlace,
  bitecsColorLinearToSRGBInPlace,
  bitecsColorApplyThemeRange,
  colorFromFlat3,
  colorFromFlat4,
  flat3FromColor,
  flat4FromColor,
  sRGB3ToLinear3,
  linear3ToSRGB3,
  preciseSRGBToLinear,
  preciseLinearToSRGB,
  preciseRelativeLuminance,
  preciseContrastRatio
};

export { Color };
export default Color;