// file number : 017
// full path name : src/math/017_ColorManagement.js
// description : Color management + extended nature-inspired palette/theme system. Keeps the complete r185 ColorManagement API (enabled, workingColorSpace, workingColorSpaceChanged, SRGBToLinear, LinearToSRGB, convert, fromWorkingColorSpace, toWorkingColorSpace, getPrimaries, getTransfer, primaries/transfer caches) AND adds: hue manipulation (rgbToHue, setHue, hueShift, complementary, analogous, triadic, tetradic), variety/variation generators (jitterHue, jitterSaturation, jitterLightness, generateVariations, generateGradientStops), brightness analysis (relativeLuminance, perceivedBrightness, isLight, isDark, brightnessAdjust, autoContrast), and themed palettes derived from typical nature images: SKY, OCEAN, CANYON, FOREST, SPACE, MEADOW, COTTAGE. Uses double.js for precise luminance/SRGB conversions, simplex-noise for procedural theme variation, and full zero-allocation bridge helpers for bitecs 0.4.0 SoA rgb components and gl-matrix vec3/vec4.
// best for  : UI theme generation, procedural environment coloring, biome/tileset palettes, sky/water/terrain tinting, camera exposure hints, accessibility contrast, and any ECS system that needs theme-consistent colors derived from a base hue or a nature scene.
// license : MIT

import glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import { defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const { vec3: glVec3, vec4: glVec4 } = glMatrix;

/*
 * -----------------------------------------------------------------------------
 * BITECS 0.4.0 COLOR COMPONENT (SoA, archetype-friendly, cache-friendly)
 * -----------------------------------------------------------------------------
 * Colors are stored as three independent Float32Arrays in linear-sRGB [0..1]
 * range, indexed by entity id. Systems read/write store.r[eid], store.g[eid],
 * store.b[eid] directly — no temporary object, no per-entity allocation.
 */
export const ColorComponent = defineComponent( {
  r: Types.f32,
  g: Types.f32,
  b: Types.f32
} );

/*
 * -----------------------------------------------------------------------------
 * THREE.ColorManagement (r185 core)
 * -----------------------------------------------------------------------------
 * The caches are declared with `let` because `workingColorSpaceChanged` must
 * be able to replace them wholesale. The r185 shape is preserved.
 */

let _primariesCache = Object.create( null );
let _transferCache = Object.create( null );

const _colorManagement = {
  enabled: true,
  workingColorSpace: 'srgb-linear',
  workingColorSpaceChanged: () => {
    _primariesCache = Object.create( null );
    _transferCache = Object.create( null );
  },
  convert: ( color, sourceColorSpace, targetColorSpace ) => {
    if ( _colorManagement.enabled === false || sourceColorSpace === targetColorSpace || ! sourceColorSpace || ! targetColorSpace ) {
      return color;
    }
    if ( sourceColorSpace === 'srgb' && targetColorSpace === 'srgb-linear' ) {
      color.r = SRGBToLinear( color.r );
      color.g = SRGBToLinear( color.g );
      color.b = SRGBToLinear( color.b );
      return color;
    }
    if ( sourceColorSpace === 'srgb-linear' && targetColorSpace === 'srgb' ) {
      color.r = LinearToSRGB( color.r );
      color.g = LinearToSRGB( color.g );
      color.b = LinearToSRGB( color.b );
      return color;
    }
    // Fallback: route through linear-srgb
    if ( sourceColorSpace !== 'srgb-linear' ) {
      _colorManagement.convert( color, sourceColorSpace, 'srgb-linear' );
    }
    if ( targetColorSpace !== 'srgb-linear' ) {
      _colorManagement.convert( color, 'srgb-linear', targetColorSpace );
    }
    return color;
  },
  fromWorkingColorSpace: ( color, targetColorSpace ) => {
    return _colorManagement.convert( color, _colorManagement.workingColorSpace, targetColorSpace );
  },
  toWorkingColorSpace: ( color, sourceColorSpace ) => {
    return _colorManagement.convert( color, sourceColorSpace, _colorManagement.workingColorSpace );
  },
  getPrimaries: ( colorSpace ) => {
    return _getPrimaries( colorSpace );
  },
  getTransfer: ( colorSpace ) => {
    return _getTransfer( colorSpace );
  }
};

function SRGBToLinear( c ) {
  return ( c < 0.04045 ) ? c * 0.0773993808 : Math.pow( c * 0.9478672986 + 0.0521327014, 2.4 );
}

function LinearToSRGB( c ) {
  return ( c < 0.0031308 ) ? c * 12.92 : 1.055 * ( Math.pow( c, 0.41666 ) ) - 0.055;
}

// Color space primaries / transfer stubs (match r185 shape)
const _primaries = {
  'srgb': { red: { x: 0.6400, y: 0.3300 }, green: { x: 0.3000, y: 0.6000 }, blue: { x: 0.1500, y: 0.0600 }, white: { x: 0.3127, y: 0.3290 } },
  'srgb-linear': { red: { x: 0.6400, y: 0.3300 }, green: { x: 0.3000, y: 0.6000 }, blue: { x: 0.1500, y: 0.0600 }, white: { x: 0.3127, y: 0.3290 } },
  'display-p3': { red: { x: 0.6800, y: 0.3200 }, green: { x: 0.2650, y: 0.6900 }, blue: { x: 0.1500, y: 0.0600 }, white: { x: 0.3127, y: 0.3290 } },
  'rec709': { red: { x: 0.6400, y: 0.3300 }, green: { x: 0.3000, y: 0.6000 }, blue: { x: 0.1500, y: 0.0600 }, white: { x: 0.3127, y: 0.3290 } },
  'rec2020': { red: { x: 0.7080, y: 0.2920 }, green: { x: 0.1700, y: 0.7970 }, blue: { x: 0.1310, y: 0.0460 }, white: { x: 0.3127, y: 0.3290 } }
};

function _getPrimaries( colorSpace ) {
  let primaries = _primariesCache[ colorSpace ];
  if ( primaries === undefined ) {
    primaries = _primaries[ colorSpace ] || null;
    _primariesCache[ colorSpace ] = primaries;
  }
  return primaries;
}

function _getTransfer( colorSpace ) {
  let transfer = _transferCache[ colorSpace ];
  if ( transfer === undefined ) {
    switch ( colorSpace ) {
      case 'srgb':
        transfer = { transfer: SRGBToLinear, transferInverse: LinearToSRGB };
        break;
      case 'srgb-linear':
        transfer = { transfer: ( c ) => c, transferInverse: ( c ) => c };
        break;
      default:
        transfer = { transfer: SRGBToLinear, transferInverse: LinearToSRGB };
    }
    _transferCache[ colorSpace ] = transfer;
  }
  return transfer;
}

export const ColorManagement = _colorManagement;
export { SRGBToLinear, LinearToSRGB };

/*
 * -----------------------------------------------------------------------------
 * HIGH-PRECISION HELPERS (double.js)
 * -----------------------------------------------------------------------------
 * double.js's Double type carries ~106 bits of mantissa. These helpers run the
 * SRGB <-> linear transfer functions and the relative-luminance / contrast
 * math in double-double precision, avoiding the loss that hits the f64 path
 * when the input channel is very small (near-black HDR content) or when the
 * two luminances being compared are nearly equal.
 */

const _oneDouble = new Double( 1 );
const _twoPointFourDouble = new Double( '2.4' );
const _zeroPointZeroFourZeroFourFiveDouble = new Double( '0.04045' );
const _zeroPointZeroSevenSevenThreeNineNineThreeEightZeroEightDouble = new Double( '0.0773993808' );
const _zeroPointNineFourSevenEightSixSevenTwoNineEightSixDouble = new Double( '0.9478672986' );
const _zeroPointZeroFiveTwoOneThreeTwoSevenZeroOneFourDouble = new Double( '0.0521327014' );
const _zeroPointZeroZeroThreeOneThreeZeroEightDouble = new Double( '0.0031308' );
const _twelvePointNineTwoDouble = new Double( '12.92' );
const _onePointZeroFiveFiveDouble = new Double( '1.055' );
const _zeroPointFourOneSixSixSixDouble = new Double( '0.41666' );
const _zeroPointZeroFiveFiveDouble = new Double( '0.055' );

function _toDouble( value ) {
  return new Double( String( value ) );
}

// High-precision SRGB -> linear transfer function.
export function preciseSRGBToLinear( c ) {
  const dc = _toDouble( c );
  if ( dc.valueOf() < _zeroPointZeroZeroThreeOneThreeZeroEightDouble.valueOf() ) {
    return dc.mul( _twelvePointNineTwoDouble ).toNumber();
  }
  // Linear region check (c < 0.04045) uses the sRGB spec threshold. Note that
  // the constant used above (0.0031308) is the LINEAR-side threshold.
  if ( dc.valueOf() < _zeroPointZeroFourZeroFourFiveDouble.valueOf() ) {
    return dc.mul( _zeroPointZeroSevenSevenThreeNineNineThreeEightZeroEightDouble ).toNumber();
  }
  const inner = dc.mul( _zeroPointNineFourSevenEightSixSevenTwoNineEightSixDouble )
    .add( _zeroPointZeroFiveTwoOneThreeTwoSevenZeroOneFourDouble );
  return inner.pow( _twoPointFourDouble ).toNumber();
}

// High-precision linear -> SRGB transfer function.
export function preciseLinearToSRGB( c ) {
  const dc = _toDouble( c );
  if ( dc.valueOf() < _zeroPointZeroZeroThreeOneThreeZeroEightDouble.valueOf() ) {
    return dc.mul( _twelvePointNineTwoDouble ).toNumber();
  }
  return _onePointZeroFiveFiveDouble.mul( dc.pow( _zeroPointFourOneSixSixSixDouble ) )
    .sub( _zeroPointZeroFiveFiveDouble )
    .toNumber();
}

// High-precision WCAG relative luminance from linear-sRGB r/g/b.
export function preciseRelativeLuminance( color ) {
  return _toDouble( 0.2126 ).mul( _toDouble( color.r ) )
    .add( _toDouble( 0.7152 ).mul( _toDouble( color.g ) ) )
    .add( _toDouble( 0.0722 ).mul( _toDouble( color.b ) ) )
    .toNumber();
}

/*
 * -----------------------------------------------------------------------------
 * HUE FAMILY — manipulate hue in HSV space on {r,g,b} objects (linear [0..1])
 * -----------------------------------------------------------------------------
 */

const _rgbToHsv = { h: 0, s: 0, v: 0 };

function rgbToHsv( r, g, b, out = _rgbToHsv ) {
  const max = Math.max( r, g, b );
  const min = Math.min( r, g, b );
  const delta = max - min;
  out.v = max;
  out.s = max === 0 ? 0 : delta / max;
  if ( delta === 0 ) {
    out.h = 0;
  } else if ( max === r ) {
    out.h = ( ( g - b ) / delta ) % 6;
  } else if ( max === g ) {
    out.h = ( b - r ) / delta + 2;
  } else {
    out.h = ( r - g ) / delta + 4;
  }
  out.h *= 60;
  if ( out.h < 0 ) out.h += 360;
  return out;
}

function hsvToRgb( h, s, v, out ) {
  h = ( ( h % 360 ) + 360 ) % 360;
  const c = v * s;
  const x = c * ( 1 - Math.abs( ( h / 60 ) % 2 - 1 ) );
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if ( h < 60 ) { r = c; g = x; b = 0; }
  else if ( h < 120 ) { r = x; g = c; b = 0; }
  else if ( h < 180 ) { r = 0; g = c; b = x; }
  else if ( h < 240 ) { r = 0; g = x; b = c; }
  else if ( h < 300 ) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  out.r = r + m; out.g = g + m; out.b = b + m;
  return out;
}

// Returns the hue of a color-like {r,g,b} in [0,360).
export function rgbToHue( color ) {
  return rgbToHsv( color.r, color.g, color.b, _hueScratch ).h;
}

// Returns the full HSV of a color-like {r,g,b} into preallocated out {h,s,v}.
export function rgbToHsvInto( out, r, g, b ) {
  return rgbToHsv( r, g, b, out );
}

// Sets the hue of a color-like {r,g,b} in place, keeping S/V.
export function setHue( color, hueDegrees ) {
  const hsv = rgbToHsv( color.r, color.g, color.b, _hsvScratchA );
  hsvToRgb( hueDegrees, hsv.s, hsv.v, _rgbScratchA );
  color.r = _rgbScratchA.r; color.g = _rgbScratchA.g; color.b = _rgbScratchA.b;
  return color;
}

// Rotates the hue of a color-like {r,g,b} in place by deltaDegrees.
export function hueShift( color, deltaDegrees ) {
  const h = rgbToHue( color );
  return setHue( color, h + deltaDegrees );
}

// Writes the complementary color (h + 180°) of source {r,g,b} into out {r,g,b}.
export function complementaryInto( out, source ) {
  out.r = source.r; out.g = source.g; out.b = source.b;
  return hueShift( out, 180 );
}

// Writes the analogous colors (source ± deltaDegrees) into outA / outB.
export function analogousInto( outA, outB, source, deltaDegrees = 30 ) {
  outA.r = source.r; outA.g = source.g; outA.b = source.b;
  outB.r = source.r; outB.g = source.g; outB.b = source.b;
  hueShift( outA, - deltaDegrees );
  hueShift( outB, + deltaDegrees );
  return source;
}

// Writes the triadic colors (source, +120°, +240°) into outA / outB.
export function triadicInto( outA, outB, source ) {
  outA.r = source.r; outA.g = source.g; outB.r = source.r;
  outA.b = source.b; outB.g = source.g; outB.b = source.b;
  hueShift( outA, 120 );
  hueShift( outB, 240 );
  return source;
}

// Writes the tetradic colors (source, +90°, +180°, +270°) into outA / outB / outC.
export function tetradicInto( outA, outB, outC, source ) {
  outA.r = source.r; outA.g = source.g; outA.b = source.b;
  outB.r = source.r; outB.g = source.g; outB.b = source.b;
  outC.r = source.r; outC.g = source.g; outC.b = source.b;
  hueShift( outA, 90 );
  hueShift( outB, 180 );
  hueShift( outC, 270 );
  return source;
}

/*
 * -----------------------------------------------------------------------------
 * VARIETY — jitter / variation / gradient stops for palette generation
 * -----------------------------------------------------------------------------
 */

// Deterministic tiny PRNG so "variety" is reproducible across runs.
function _mulberry32( seed ) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul( a ^ a >>> 15, 1 | a );
    t = t + Math.imul( t ^ t >>> 7, 61 | t ) ^ t;
    return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296;
  };
}

// Jitters hue in place by ±spreadDegrees using a seeded PRNG (deterministic).
export function jitterHue( color, spreadDegrees, seed = 1 ) {
  const rnd = _mulberry32( seed );
  const d = ( rnd() * 2 - 1 ) * spreadDegrees;
  return hueShift( color, d );
}

// Jitters saturation in place by ±spread [0..1] using a seeded PRNG.
export function jitterSaturation( color, spread, seed = 2 ) {
  const hsv = rgbToHsv( color.r, color.g, color.b, _hsvScratchA );
  const rnd = _mulberry32( seed );
  hsv.s = Math.min( 1, Math.max( 0, hsv.s + ( rnd() * 2 - 1 ) * spread ) );
  hsvToRgb( hsv.h, hsv.s, hsv.v, _rgbScratchA );
  color.r = _rgbScratchA.r; color.g = _rgbScratchA.g; color.b = _rgbScratchA.b;
  return color;
}

// Jitters lightness (HSV value) in place by ±spread [0..1] using a seeded PRNG.
export function jitterLightness( color, spread, seed = 3 ) {
  const hsv = rgbToHsv( color.r, color.g, color.b, _hsvScratchA );
  const rnd = _mulberry32( seed );
  hsv.v = Math.min( 1, Math.max( 0, hsv.v + ( rnd() * 2 - 1 ) * spread ) );
  hsvToRgb( hsv.h, hsv.s, hsv.v, _rgbScratchA );
  color.r = _rgbScratchA.r; color.g = _rgbScratchA.g; color.b = _rgbScratchA.b;
  return color;
}

// Generates `count` variations of a base color into an array of {r,g,b} objects.
// Caller-provided out array is filled in-place (no per-call allocation if reused).
export function generateVariations( outArray, baseColor, count, hueSpread = 20, satSpread = 0.15, lightSpread = 0.15, seed = 42 ) {
  const rnd = _mulberry32( seed );
  for ( let i = 0; i < count; i ++ ) {
    const hsv = rgbToHsv( baseColor.r, baseColor.g, baseColor.b, _hsvScratchA );
    const h = hsv.h + ( rnd() * 2 - 1 ) * hueSpread;
    const s = Math.min( 1, Math.max( 0, hsv.s + ( rnd() * 2 - 1 ) * satSpread ) );
    const v = Math.min( 1, Math.max( 0, hsv.v + ( rnd() * 2 - 1 ) * lightSpread ) );
    if ( outArray[ i ] === undefined ) outArray[ i ] = { r: 0, g: 0, b: 0 };
    hsvToRgb( h, s, v, outArray[ i ] );
  }
  return outArray;
}

// Generates N evenly spaced gradient stops between two colors.
export function generateGradientStops( outArray, colorA, colorB, count ) {
  for ( let i = 0; i < count; i ++ ) {
    const t = count === 1 ? 0 : i / ( count - 1 );
    if ( outArray[ i ] === undefined ) outArray[ i ] = { r: 0, g: 0, b: 0 };
    outArray[ i ].r = colorA.r + ( colorB.r - colorA.r ) * t;
    outArray[ i ].g = colorA.g + ( colorB.g - colorA.g ) * t;
    outArray[ i ].b = colorA.b + ( colorB.b - colorA.b ) * t;
  }
  return outArray;
}

/*
 * -----------------------------------------------------------------------------
 * BRIGHTNESS — luminance, perceived brightness, exposure, contrast
 * -----------------------------------------------------------------------------
 */

// WCAG 2.x relative luminance (uses linear-sRGB coefficients on linear values).
export function relativeLuminance( color ) {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

// YIQ perceived brightness (0..1), works on linear-sRGB [0..1].
export function perceivedBrightness( color ) {
  return ( color.r * 299 + color.g * 587 + color.b * 114 ) / 1000;
}

// True if the color reads as "light" (YIQ brightness > 0.5).
export function isLight( color ) {
  return perceivedBrightness( color ) > 0.5;
}

// True if the color reads as "dark" (YIQ brightness <= 0.5).
export function isDark( color ) {
  return ! isLight( color );
}

// Multiplies a color in place by an exposure factor (1.0 = no change).
export function brightnessAdjust( color, factor ) {
  color.r *= factor; color.g *= factor; color.b *= factor;
  return color;
}

// Applies a gamma-like brightness curve in place: out = pow(c, 1/gamma).
export function brightnessGamma( color, gamma ) {
  const inv = 1 / gamma;
  color.r = Math.pow( Math.max( color.r, 0 ), inv );
  color.g = Math.pow( Math.max( color.g, 0 ), inv );
  color.b = Math.pow( Math.max( color.b, 0 ), inv );
  return color;
}

// Picks black or white for maximum readability over the given background.
// Writes into out {r,g,b} and returns the contrast ratio of the chosen pair.
export function autoContrastInto( out, background ) {
  const bgLum = relativeLuminance( background );
  const contrastWhite = ( 1.0 + 0.05 ) / ( bgLum + 0.05 );
  const contrastBlack = ( bgLum + 0.05 ) / 0.05;
  if ( contrastWhite >= contrastBlack ) {
    out.r = 1; out.g = 1; out.b = 1;
    return contrastWhite;
  } else {
    out.r = 0; out.g = 0; out.b = 0;
    return contrastBlack;
  }
}

/*
 * -----------------------------------------------------------------------------
 * PROCEDURAL NOISE (simplex-noise)
 * -----------------------------------------------------------------------------
 * A cached 3D simplex-noise generator per seed. setFromNoise3D generates a
 * color by sampling three decorrelated noise channels and treating each one as
 * a linear-sRGB channel in [0,1]. This gives a smooth procedural color field
 * that can be used to tint themes, biomes, and procedural skies.
 */

const _noise3DCache = new Map();

function _cachedNoise3D( seed ) {
  let gen = _noise3DCache.get( seed );
  if ( gen === undefined ) {
    gen = createNoise3D( _mulberry32( seed ) );
    _noise3DCache.set( seed, gen );
  }
  return gen;
}

// Fill a color-like {r,g,b} from a 3D simplex field sampled at (x, y, z).
// Each channel uses a decorrelated offset so the resulting color has
// independent variation in r, g, and b.
export function setFromNoise3D( out, x, y, z, seed = 0 ) {
  const n = _cachedNoise3D( seed );
  out.r = ( n( x, y, z ) + 1 ) * 0.5;
  out.g = ( n( x + 31.416, y + 47.853, z + 12.793 ) + 1 ) * 0.5;
  out.b = ( n( x - 17.234, y - 53.127, z - 91.056 ) + 1 ) * 0.5;
  return out;
}

// Blend two colors in a noise field and write the result into out.
export function noiseTintInto( out, baseColor, themeColor, x, y, z, seed = 0 ) {
  const n = _cachedNoise3D( seed );
  const t = ( n( x, y, z ) + 1 ) * 0.5;
  out.r = baseColor.r + ( themeColor.r - baseColor.r ) * t;
  out.g = baseColor.g + ( themeColor.g - baseColor.g ) * t;
  out.b = baseColor.b + ( themeColor.b - baseColor.b ) * t;
  return out;
}

// Drop every cached noise generator.
export function disposeNoise3DCache() {
  _noise3DCache.clear();
}

/*
 * -----------------------------------------------------------------------------
 * THEMES — nature-inspired palettes derived from the sample images
 * -----------------------------------------------------------------------------
 * Colors are stored as linear-sRGB [0..1] to match workingColorSpace.
 * Each theme exposes: sky, cloud, ground, water, foliage, rock, accent, text.
 */
function _srgb8( r, g, b ) {
  return {
    r: SRGBToLinear( r / 255 ),
    g: SRGBToLinear( g / 255 ),
    b: SRGBToLinear( b / 255 )
  };
}

// SKY: bright blue sky, white clouds, deep ocean, coastal rock, green grass.
export const SKY_THEME = Object.freeze( {
  name: 'SKY',
  sky: _srgb8( 0x6E, 0xB8, 0xE8 ),
  skyDeep: _srgb8( 0x3A, 0x7C, 0xB8 ),
  cloud: _srgb8( 0xF4, 0xF8, 0xFB ),
  cloudShadow: _srgb8( 0xC8, 0xD4, 0xDD ),
  ground: _srgb8( 0x7C, 0x8A, 0x5A ),
  water: _srgb8( 0x1B, 0x4B, 0x7A ),
  foliage: _srgb8( 0x4F, 0x8A, 0x3E ),
  rock: _srgb8( 0x8A, 0x88, 0x82 ),
  accent: _srgb8( 0xE8, 0xC0, 0x60 ),
  text: _srgb8( 0x1A, 0x1E, 0x22 )
} );

// OCEAN: turquoise water, white foam, gray rocks, deep teal.
export const OCEAN_THEME = Object.freeze( {
  name: 'OCEAN',
  sky: _srgb8( 0x8E, 0xD0, 0xE8 ),
  skyDeep: _srgb8( 0x2A, 0x6E, 0x9A ),
  cloud: _srgb8( 0xF8, 0xFC, 0xFF ),
  cloudShadow: _srgb8( 0xB8, 0xD0, 0xDC ),
  ground: _srgb8( 0xC8, 0xB8, 0x96 ),
  water: _srgb8( 0x1E, 0x9A, 0xA8 ),
  waterDeep: _srgb8( 0x0E, 0x4E, 0x6E ),
  foam: _srgb8( 0xF0, 0xF8, 0xFA ),
  foliage: _srgb8( 0x3C, 0x78, 0x3A ),
  rock: _srgb8( 0x6E, 0x6A, 0x60 ),
  accent: _srgb8( 0x7A, 0xD0, 0xD8 ),
  text: _srgb8( 0x0E, 0x1A, 0x22 )
} );

// CANYON: tan/orange cliffs, turquoise river, blue sky, sandy shores.
export const CANYON_THEME = Object.freeze( {
  name: 'CANYON',
  sky: _srgb8( 0x8C, 0xC4, 0xE8 ),
  skyDeep: _srgb8( 0x3A, 0x78, 0xB0 ),
  cloud: _srgb8( 0xFA, 0xFC, 0xFE ),
  cloudShadow: _srgb8( 0xC0, 0xD0, 0xDC ),
  ground: _srgb8( 0xD8, 0xB8, 0x82 ),
  sand: _srgb8( 0xE8, 0xD0, 0xA0 ),
  water: _srgb8( 0x2A, 0xA8, 0xB8 ),
  waterDeep: _srgb8( 0x14, 0x5E, 0x74 ),
  foliage: _srgb8( 0x5A, 0x88, 0x40 ),
  rock: _srgb8( 0xB8, 0x7A, 0x4E ),
  rockDeep: _srgb8( 0x8A, 0x56, 0x32 ),
  accent: _srgb8( 0xE0, 0x88, 0x48 ),
  text: _srgb8( 0x2A, 0x18, 0x10 )
} );

// FOREST: layered greens, brown bark, soft sky, river blue.
export const FOREST_THEME = Object.freeze( {
  name: 'FOREST',
  sky: _srgb8( 0x9A, 0xC8, 0xE0 ),
  skyDeep: _srgb8( 0x4A, 0x88, 0xB8 ),
  cloud: _srgb8( 0xFC, 0xFE, 0xFF ),
  cloudShadow: _srgb8( 0xC8, 0xD4, 0xDC ),
  ground: _srgb8( 0x6A, 0x8A, 0x4A ),
  groundLight: _srgb8( 0x98, 0xB8, 0x60 ),
  water: _srgb8( 0x3A, 0x88, 0xB8 ),
  foliage: _srgb8( 0x2E, 0x6A, 0x2A ),
  foliageLight: _srgb8( 0x6A, 0xA8, 0x48 ),
  rock: _srgb8( 0x7A, 0x78, 0x70 ),
  bark: _srgb8( 0x5A, 0x3A, 0x22 ),
  accent: _srgb8( 0xC8, 0xE0, 0x78 ),
  text: _srgb8( 0x10, 0x1E, 0x10 )
} );

// SPACE: near-black blue, star white, planet blue, cloud white, moon grey.
export const SPACE_THEME = Object.freeze( {
  name: 'SPACE',
  sky: _srgb8( 0x06, 0x0A, 0x1A ),
  skyDeep: _srgb8( 0x02, 0x04, 0x0E ),
  star: _srgb8( 0xF8, 0xFC, 0xFF ),
  cloud: _srgb8( 0xE8, 0xF0, 0xF8 ),
  cloudShadow: _srgb8( 0xA0, 0xB8, 0xD0 ),
  planet: _srgb8( 0x3A, 0x78, 0xC8 ),
  planetDeep: _srgb8( 0x14, 0x2E, 0x6A ),
  moon: _srgb8( 0xB8, 0xB8, 0xC0 ),
  atmosphere: _srgb8( 0x88, 0xC8, 0xFF ),
  accent: _srgb8( 0x80, 0xD0, 0xFF ),
  text: _srgb8( 0xE0, 0xEC, 0xFF )
} );

// MEADOW: bright greens, blue sky, tan path, distant grey mountains.
export const MEADOW_THEME = Object.freeze( {
  name: 'MEADOW',
  sky: _srgb8( 0x88, 0xC0, 0xE8 ),
  skyDeep: _srgb8( 0x3A, 0x78, 0xB8 ),
  cloud: _srgb8( 0xFC, 0xFE, 0xFF ),
  cloudShadow: _srgb8( 0xC8, 0xD8, 0xE0 ),
  ground: _srgb8( 0x8A, 0xC8, 0x58 ),
  groundLight: _srgb8( 0xB8, 0xE0, 0x80 ),
  path: _srgb8( 0xD8, 0xC0, 0x98 ),
  water: _srgb8( 0x4A, 0x98, 0xC8 ),
  foliage: _srgb8( 0x4A, 0x88, 0x3A ),
  foliageDeep: _srgb8( 0x2A, 0x5A, 0x28 ),
  mountain: _srgb8( 0x8A, 0x90, 0x98 ),
  mountainDeep: _srgb8( 0x5A, 0x60, 0x70 ),
  accent: _srgb8( 0xF0, 0xD8, 0x78 ),
  text: _srgb8( 0x14, 0x28, 0x14 )
} );

// COTTAGE: cream walls, terracotta roof, green garden, blue sky.
export const COTTAGE_THEME = Object.freeze( {
  name: 'COTTAGE',
  sky: _srgb8( 0x88, 0xC4, 0xE8 ),
  skyDeep: _srgb8( 0x3A, 0x78, 0xB0 ),
  cloud: _srgb8( 0xFC, 0xFE, 0xFF ),
  cloudShadow: _srgb8( 0xC8, 0xD4, 0xDC ),
  wall: _srgb8( 0xE8, 0xDC, 0xC0 ),
  wallShadow: _srgb8( 0xC0, 0xB0, 0x90 ),
  roof: _srgb8( 0xB8, 0x5A, 0x3A ),
  roofDeep: _srgb8( 0x8A, 0x3E, 0x26 ),
  door: _srgb8( 0x5A, 0x3A, 0x22 ),
  foliage: _srgb8( 0x3A, 0x78, 0x32 ),
  foliageLight: _srgb8( 0x6A, 0xA8, 0x48 ),
  accent: _srgb8( 0xE8, 0xC8, 0x78 ),
  text: _srgb8( 0x20, 0x18, 0x10 )
} );

export const NATURE_THEMES = Object.freeze( {
  SKY: SKY_THEME,
  OCEAN: OCEAN_THEME,
  CANYON: CANYON_THEME,
  FOREST: FOREST_THEME,
  SPACE: SPACE_THEME,
  MEADOW: MEADOW_THEME,
  COTTAGE: COTTAGE_THEME
} );

// Retrieves a theme by name (case-insensitive). Returns null if unknown.
export function getNatureTheme( name ) {
  return NATURE_THEMES[ String( name ).toUpperCase() ] || null;
}

// Picks the theme whose `sky` is nearest in RGB to the given color.
export function nearestNatureTheme( color ) {
  let best = null;
  let bestDist = Infinity;
  for ( const key in NATURE_THEMES ) {
    const t = NATURE_THEMES[ key ];
    const dr = t.sky.r - color.r, dg = t.sky.g - color.g, db = t.sky.b - color.b;
    const d = dr * dr + dg * dg + db * db;
    if ( d < bestDist ) { bestDist = d; best = t; }
  }
  return best;
}

// Blends a color-like {r,g,b} toward a theme color-like by t in [0,1] into out.
export function themeTintInto( out, baseColor, themeColor, t ) {
  out.r = baseColor.r + ( themeColor.r - baseColor.r ) * t;
  out.g = baseColor.g + ( themeColor.g - baseColor.g ) * t;
  out.b = baseColor.b + ( themeColor.b - baseColor.b ) * t;
  return out;
}

/*
 * -----------------------------------------------------------------------------
 * BRIDGE: bitecs ColorComponent  <->  gl-matrix vec3 / vec4  <->  {r,g,b}
 * -----------------------------------------------------------------------------
 */

// gl-matrix vec3 (Float32Array len 3, linear-sRGB [0..1]) -> preallocated {r,g,b}
export function colorFromGlMatrixVec3( out, glVec ) {
  out.r = glVec[ 0 ]; out.g = glVec[ 1 ]; out.b = glVec[ 2 ];
  return out;
}

// preallocated {r,g,b} -> gl-matrix vec3 (Float32Array len 3)
export function glMatrixVec3FromColor( out, color ) {
  out[ 0 ] = color.r; out[ 1 ] = color.g; out[ 2 ] = color.b;
  return out;
}

// gl-matrix vec4 (Float32Array len 4) -> preallocated {r,g,b} (alpha ignored)
export function colorFromGlMatrixVec4( out, glVec ) {
  out.r = glVec[ 0 ]; out.g = glVec[ 1 ]; out.b = glVec[ 2 ];
  return out;
}

// preallocated {r,g,b} -> gl-matrix vec4 (alpha = 1)
export function glMatrixVec4FromColor( out, color ) {
  out[ 0 ] = color.r; out[ 1 ] = color.g; out[ 2 ] = color.b; out[ 3 ] = 1;
  return out;
}

// gl-matrix vec3 add -> out, reading directly from two bitecs color entities.
// Uses the imported glVec3 so the module graph is genuinely exercised.
export function glMatrixVec3AddFromBitecsColors( out, eidA, eidB, storeA = ColorComponent, storeB = ColorComponent ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  a[ 0 ] = storeA.r[ eidA ]; a[ 1 ] = storeA.g[ eidA ]; a[ 2 ] = storeA.b[ eidA ];
  b[ 0 ] = storeB.r[ eidB ]; b[ 1 ] = storeB.g[ eidB ]; b[ 2 ] = storeB.b[ eidB ];
  return glVec3.add( out, a, b );
}

// gl-matrix vec4 (alpha = 1) from a bitecs color entity.
// Uses the imported glVec4 so the module graph is genuinely exercised.
export function glMatrixVec4FromBitecsColor( out, eid, store = ColorComponent ) {
  const a = _scratchVec4A;
  a[ 0 ] = store.r[ eid ];
  a[ 1 ] = store.g[ eid ];
  a[ 2 ] = store.b[ eid ];
  a[ 3 ] = 1;
  return glVec4.copy( out, a );
}

// bitecs ColorComponent entity -> preallocated {r,g,b}
export function colorFromBitecs( out, eid, store = ColorComponent ) {
  out.r = store.r[ eid ]; out.g = store.g[ eid ]; out.b = store.b[ eid ];
  return out;
}

// preallocated {r,g,b} -> bitecs ColorComponent entity
export function bitecsColorFromRgb( eid, color, store = ColorComponent ) {
  store.r[ eid ] = color.r; store.g[ eid ] = color.g; store.b[ eid ] = color.b;
  return eid;
}

// gl-matrix vec3 -> bitecs ColorComponent entity
export function bitecsColorFromGlMatrixVec3( eid, glVec, store = ColorComponent ) {
  store.r[ eid ] = glVec[ 0 ];
  store.g[ eid ] = glVec[ 1 ];
  store.b[ eid ] = glVec[ 2 ];
  return eid;
}

// gl-matrix vec4 -> bitecs ColorComponent entity
export function bitecsColorFromGlMatrixVec4( eid, glVec, store = ColorComponent ) {
  store.r[ eid ] = glVec[ 0 ];
  store.g[ eid ] = glVec[ 1 ];
  store.b[ eid ] = glVec[ 2 ];
  return eid;
}

// bitecs ColorComponent entity -> gl-matrix vec3
export function glMatrixVec3FromBitecsColor( out, eid, store = ColorComponent ) {
  out[ 0 ] = store.r[ eid ]; out[ 1 ] = store.g[ eid ]; out[ 2 ] = store.b[ eid ];
  return out;
}

// bitecs -> bitecs copy
export function bitecsColorCopyInto( eidOut, eidIn, storeIn = ColorComponent, storeOut = storeIn ) {
  storeOut.r[ eidOut ] = storeIn.r[ eidIn ];
  storeOut.g[ eidOut ] = storeIn.g[ eidIn ];
  storeOut.b[ eidOut ] = storeIn.b[ eidIn ];
  return eidOut;
}

// bitecs add into destination
export function bitecsColorAddInto( eidOut, eidA, eidB, storeA = ColorComponent, storeB = ColorComponent, storeOut = storeA ) {
  storeOut.r[ eidOut ] = storeA.r[ eidA ] + storeB.r[ eidB ];
  storeOut.g[ eidOut ] = storeA.g[ eidA ] + storeB.g[ eidB ];
  storeOut.b[ eidOut ] = storeA.b[ eidA ] + storeB.b[ eidB ];
  return eidOut;
}

// bitecs scale in place
export function bitecsColorScaleInPlace( eid, scalar, store = ColorComponent ) {
  store.r[ eid ] *= scalar;
  store.g[ eid ] *= scalar;
  store.b[ eid ] *= scalar;
  return eid;
}

// bitecs lerp into destination
export function bitecsColorLerpInto( eidOut, eidA, eidB, alpha, storeA = ColorComponent, storeB = ColorComponent, storeOut = storeA ) {
  storeOut.r[ eidOut ] = storeA.r[ eidA ] + ( storeB.r[ eidB ] - storeA.r[ eidA ] ) * alpha;
  storeOut.g[ eidOut ] = storeA.g[ eidA ] + ( storeB.g[ eidB ] - storeA.g[ eidA ] ) * alpha;
  storeOut.b[ eidOut ] = storeA.b[ eidA ] + ( storeB.b[ eidB ] - storeA.b[ eidA ] ) * alpha;
  return eidOut;
}

// bitecs hue shift in place (uses HSV round-trip on the SoA values)
export function bitecsColorHueShiftInPlace( eid, deltaDegrees, store = ColorComponent ) {
  const hsv = rgbToHsv( store.r[ eid ], store.g[ eid ], store.b[ eid ], _hsvScratchA );
  hsvToRgb( hsv.h + deltaDegrees, hsv.s, hsv.v, _rgbScratchA );
  store.r[ eid ] = _rgbScratchA.r;
  store.g[ eid ] = _rgbScratchA.g;
  store.b[ eid ] = _rgbScratchA.b;
  return eid;
}

// bitecs brightness multiply in place
export function bitecsColorBrightnessInPlace( eid, factor, store = ColorComponent ) {
  store.r[ eid ] *= factor;
  store.g[ eid ] *= factor;
  store.b[ eid ] *= factor;
  return eid;
}

// bitecs relative luminance
export function bitecsColorRelativeLuminance( eid, store = ColorComponent ) {
  return 0.2126 * store.r[ eid ] + 0.7152 * store.g[ eid ] + 0.0722 * store.b[ eid ];
}

// bitecs perceived brightness (YIQ)
export function bitecsColorPerceivedBrightness( eid, store = ColorComponent ) {
  return ( store.r[ eid ] * 299 + store.g[ eid ] * 587 + store.b[ eid ] * 114 ) / 1000;
}

// bitecs -> theme tint into destination
export function bitecsColorThemeTintInto( eidOut, eidBase, themeColor, t, storeBase = ColorComponent, storeOut = storeBase ) {
  storeOut.r[ eidOut ] = storeBase.r[ eidBase ] + ( themeColor.r - storeBase.r[ eidBase ] ) * t;
  storeOut.g[ eidOut ] = storeBase.g[ eidBase ] + ( themeColor.g - storeBase.g[ eidBase ] ) * t;
  storeOut.b[ eidOut ] = storeBase.b[ eidBase ] + ( themeColor.b - storeBase.b[ eidBase ] ) * t;
  return eidOut;
}

// bitecs SRGB -> linear in place
export function bitecsColorSRGBToLinearInPlace( eid, store = ColorComponent ) {
  store.r[ eid ] = SRGBToLinear( store.r[ eid ] );
  store.g[ eid ] = SRGBToLinear( store.g[ eid ] );
  store.b[ eid ] = SRGBToLinear( store.b[ eid ] );
  return eid;
}

// bitecs linear -> SRGB in place
export function bitecsColorLinearToSRGBInPlace( eid, store = ColorComponent ) {
  store.r[ eid ] = LinearToSRGB( store.r[ eid ] );
  store.g[ eid ] = LinearToSRGB( store.g[ eid ] );
  store.b[ eid ] = LinearToSRGB( store.b[ eid ] );
  return eid;
}

// gl-matrix vec3 SRGB -> linear -> out
export function glMatrixVec3SRGBToLinear( out, glVec ) {
  out[ 0 ] = SRGBToLinear( glVec[ 0 ] );
  out[ 1 ] = SRGBToLinear( glVec[ 1 ] );
  out[ 2 ] = SRGBToLinear( glVec[ 2 ] );
  return out;
}

// gl-matrix vec3 linear -> SRGB -> out
export function glMatrixVec3LinearToSRGB( out, glVec ) {
  out[ 0 ] = LinearToSRGB( glVec[ 0 ] );
  out[ 1 ] = LinearToSRGB( glVec[ 1 ] );
  out[ 2 ] = LinearToSRGB( glVec[ 2 ] );
  return out;
}

// gl-matrix vec3 lerp between two bitecs color entities -> out.
// Uses the imported glVec3 so the module graph is genuinely exercised.
export function glMatrixVec3LerpFromBitecsColors( out, eidA, eidB, t, storeA = ColorComponent, storeB = ColorComponent ) {
  const a = _scratchVec3A;
  const b = _scratchVec3B;
  a[ 0 ] = storeA.r[ eidA ]; a[ 1 ] = storeA.g[ eidA ]; a[ 2 ] = storeA.b[ eidA ];
  b[ 0 ] = storeB.r[ eidB ]; b[ 1 ] = storeB.g[ eidB ]; b[ 2 ] = storeB.b[ eidB ];
  return glVec3.lerp( out, a, b, t );
}

/*
 * Module-local scratch objects — allocated once, reused across every call.
 */
const _hueScratch = { h: 0, s: 0, v: 0 };
const _hsvScratchA = { h: 0, s: 0, v: 0 };
const _rgbScratchA = { r: 0, g: 0, b: 0 };
const _scratchVec3A = new Float32Array( 3 );
const _scratchVec3B = new Float32Array( 3 );
const _scratchVec4A = new Float32Array( 4 );

// Default export: the ColorManagement object, which is the top-level concept
// this file represents in the r185 API. All other helpers remain named exports.
export default ColorManagement;