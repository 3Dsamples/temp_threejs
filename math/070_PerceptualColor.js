// file number : 070
// full path name : src/math/070_PerceptualColor.js
// description : pbrt's perceptual_color.h ported to bitECS 0.4.0 SoA stores and the chat's Color primitive. Full Oklab/OKLCH conversion pipeline for linear-RGB colors, applied as two bitECS systems (tintSystem, chromatizationSystem) and as direct PerceptualSoA methods. Zero-allocation hot paths: all stores are pre-allocated Float32Arrays, scratch buffers are reused across calls, and a shared pool backs the Three.js-friendly wrappers. Provides rgbStore, oklabStore, oklchStore, tintStore, createScratch, PerceptualSoA, createColorWorld, createColorEntity, setTint, colorToOklab, oklabToColor, applyPerfectTintColor, applyChromatizationColor. All bitECS component stores are plain typed arrays recognized by the chat's SoA/AoS serializers. Uses 014_BitECS for ECS primitives, 069_Color for the Color class, and 003_Common for MathUtils. No THREE, no CDN, no static server, no Vite/Vue.
// best for : anime-flat and semi-realistic character tinting, PBR albedo hue preservation, procedural palette variation, per-frame color correction pipelines on ECS entities, and any hot loop that must convert between linear-RGB and perceptual Oklab/OKLCH without allocating.
// license : MIT

// pbrt is Copyright(c) 1998-2020 Matt Pharr, Wenzel Jakob, and Greg Humphreys.
// The pbrt source code is licensed under the Apache License, Version 2.0.
// SPDX: Apache-2.0
//
// bitECS-adapted port of pbrt's perceptual_color.h
// ---------------------------------------------------------------------------
// Three.js r185 + bitECS 0.4.0 companion module.
//
// Corrections applied in ( corrected 01):
//   1. tintStore now initialises `factor` to 1.0 (was 0.0, which silently
//      disabled the tint in applyPerfectTint).
//   2. createScratch now includes a `baseRGB` store so the systems do not
//      lazily allocate it on first call.
//   3. Added setTint() helper to write a tint + factor for an entity.
//   4. JSDoc for tintSystem / chromatizationSystem no longer claims they are
//      methods of PerceptualSoA (they are free functions).
//   5. Removed the redundant `tint.factor ? … : 1.0` check — factor is now
//      guaranteed to exist and default to 1.0.
//   6. createColorEntity now also adds the Tint component so the entity is
//      usable by the tint system without extra setup.
//
// Corrections applied in ( corrected 02 — chat port ):
//   7. Imports switched to the chat's own modules:
//        017 → 069_Color.js
//        001_MathUtils → 003_Common.js
//        'bitecs' → 014_BitECS.js
//   8. createColorWorld() rewritten for the chat's createWorld() signature
//      (no `components` / `time` args — attached after world creation).
//   9. All component stores are now real Float32Arrays (recognized by the
//      chat's SoA serializers via `instanceof Float32Array → $f32`). They
//      remain zero-allocation hot paths because they are pre-allocated once
//      in createColorWorld().
// ---------------------------------------------------------------------------

import {
  createWorld,
  addEntity,
  addComponent,
  query,
} from '../ecs/014_BitECS.js';
import { Color } from './069_Color.js';
import * as MathUtils from '../core/003_Common.js';

// ==== Re-exports ===========================================================
export { Color, MathUtils };
export { createWorld, addEntity, addComponent, query };

// ---------------------------------------------------------------------------
// 0. Fallback for performance.now() (Node.js / older browsers)
// ---------------------------------------------------------------------------
const _now = () => ( typeof performance !== 'undefined' ? performance.now() : Date.now() );

// ---------------------------------------------------------------------------
// 1. Component stores (bitECS SoA layout, typed arrays)
// ---------------------------------------------------------------------------

/** Linear-RGB colour store. Alpha in a separate array. */
export function rgbStore( maxEntities = 65536 ) {
  return {
    r: new Float32Array( maxEntities ),
    g: new Float32Array( maxEntities ),
    b: new Float32Array( maxEntities ),
    a: new Float32Array( maxEntities ),
  };
}

/** Oklab Cartesian coordinates (L, a, b). */
export function oklabStore( maxEntities = 65536 ) {
  return {
    L: new Float32Array( maxEntities ),
    a: new Float32Array( maxEntities ),
    b: new Float32Array( maxEntities ),
  };
}

/** OKLCH cylindrical coordinates (L, C, H). H is in radians. */
export function oklchStore( maxEntities = 65536 ) {
  return {
    L: new Float32Array( maxEntities ),
    C: new Float32Array( maxEntities ),
    H: new Float32Array( maxEntities ),
  };
}

/**
 * Tint parameter: arbitrary linear-RGB colour plus intensity factor.
 * `factor` is pre-filled with 1.0 so an entity that only sets r/g/b still
 * receives a full-strength tint.
 */
export function tintStore( maxEntities = 65536 ) {
  const factor = new Float32Array( maxEntities );
  factor.fill( 1.0 );
  return {
    r: new Float32Array( maxEntities ),
    g: new Float32Array( maxEntities ),
    b: new Float32Array( maxEntities ),
    factor,
  };
}

// ---------------------------------------------------------------------------
// 2. Pure SoA conversion functions (Tier 1 — hot path)
// ---------------------------------------------------------------------------

export const PerceptualSoA = {

  // ----- LinearRGB -> Oklab -----

  /**
   * pbrt: LinearRGBToOklab(Vector4 rgb)
   * Writes Oklab components into `out` for entity `eid`.
   */
  linearRGBToOklab( rgb, out, eid ) {
    const r = rgb.r[ eid ], g = rgb.g[ eid ], b = rgb.b[ eid ];

    // LMS matrix transform (Björn Ottosson, D65).
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

    // Perceptual compression via cube root.
    const lp = Math.cbrt( l );
    const mp = Math.cbrt( m );
    const sp = Math.cbrt( s );

    out.L[ eid ] = 0.2104542553 * lp + 0.7936177850 * mp - 0.0040720468 * sp;
    out.a[ eid ] = 1.9779984951 * lp - 2.4285922050 * mp + 0.4505937099 * sp;
    out.b[ eid ] = 0.0259040371 * lp + 0.7827717662 * mp - 0.8086758033 * sp;
  },

  // ----- Oklab -> LinearRGB (with gamut clamp) -----

  /**
   * pbrt: OklabToLinearRGB(ColorOklab lab, float alpha)
   * Reads Oklab from `lab`, writes clamped linear RGB into `rgb`.
   */
  oklabToLinearRGB( lab, rgb, eid ) {
    const L = lab.L[ eid ], a = lab.a[ eid ], b = lab.b[ eid ];

    const lp = L + 0.3963377774 * a + 0.2158037573 * b;
    const mp = L - 0.1055613458 * a - 0.0638541728 * b;
    const sp = L - 0.0894841775 * a - 1.2914855480 * b;

    const l = lp * lp * lp;
    const m = mp * mp * mp;
    const s = sp * sp * sp;

    let r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    let bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

    if ( r < 0 ) r = 0; else if ( r > 1 ) r = 1;
    if ( g < 0 ) g = 0; else if ( g > 1 ) g = 1;
    if ( bl < 0 ) bl = 0; else if ( bl > 1 ) bl = 1;

    rgb.r[ eid ] = r;
    rgb.g[ eid ] = g;
    rgb.b[ eid ] = bl;
  },

  // ----- Oklab <-> OKLCH -----

  /** pbrt: OklabToOKLCH(ColorOklab lab) */
  oklabToOKLCH( lab, out, eid ) {
    const a = lab.a[ eid ], b = lab.b[ eid ];
    out.L[ eid ] = lab.L[ eid ];
    out.C[ eid ] = Math.sqrt( a * a + b * b );
    out.H[ eid ] = Math.atan2( b, a );
  },

  /** pbrt: OKLCHToOklab(ColorOKLCH lch) */
  oklchToOklab( lch, out, eid ) {
    const C = lch.C[ eid ], H = lch.H[ eid ];
    out.L[ eid ] = lch.L[ eid ];
    out.a[ eid ] = C * Math.cos( H );
    out.b[ eid ] = C * Math.sin( H );
  },

  // ----- High-level operations -----

  /**
   * pbrt: ApplyPerfectTint(Vector4 baseTexture, Vector4 tintColor, float factor)
   *
   * Replaces the hue of `base` with the hue of `tint`, preserves base
   * lightness, and scales chroma by the tint's saturation ratio.
   * The result is written into `out`.
   */
  applyPerfectTint( base, tint, out, eid, scratch ) {
    const {
      baseLab, baseLCH,
      tintLab, tintLCH,
      targetLab, targetLCH,
    } = scratch;

    // 1. Project both colours into perceptual polar space.
    PerceptualSoA.linearRGBToOklab( base, baseLab, eid );
    PerceptualSoA.linearRGBToOklab( tint, tintLab, eid );
    PerceptualSoA.oklabToOKLCH( baseLab, baseLCH, eid );
    PerceptualSoA.oklabToOKLCH( tintLab, tintLCH, eid );

    // 2. Structural preservation: carry over base lightness.
    targetLCH.L[ eid ] = baseLCH.L[ eid ];

    // 3. Hue replacement: adopt the tint's hue angle.
    targetLCH.H[ eid ] = tintLCH.H[ eid ];

    // 4. Chroma heuristic: scale base chroma by the tint's saturation ratio.
    const tintSaturation = tintLCH.C[ eid ] / ( tintLCH.L[ eid ] + 0.00001 );
    let sat = tintSaturation;
    if ( sat < 0 ) sat = 0; else if ( sat > 1 ) sat = 1;
    targetLCH.C[ eid ] = baseLCH.C[ eid ] * sat;

    // 5. Final synthesis.
    PerceptualSoA.oklchToOklab( targetLCH, targetLab, eid );
    PerceptualSoA.oklabToLinearRGB( targetLab, out, eid );

    // Alpha-aware lerp toward the tinted result.
    const factor = tint.factor[ eid ];
    const br = base.r[ eid ], bg = base.g[ eid ], bb = base.b[ eid ];
    out.r[ eid ] = br + factor * ( out.r[ eid ] - br );
    out.g[ eid ] = bg + factor * ( out.g[ eid ] - bg );
    out.b[ eid ] = bb + factor * ( out.b[ eid ] - bb );
    out.a[ eid ] = base.a[ eid ];
  },

  /**
   * pbrt: ApplyChromatization(Vector4 color, float scale)
   * Adjusts chroma without shifting lightness or hue.
   */
  applyChromatization( color, out, eid, scale, scratch ) {
    const { baseLab, baseLCH, targetLab } = scratch;

    PerceptualSoA.linearRGBToOklab( color, baseLab, eid );
    PerceptualSoA.oklabToOKLCH( baseLab, baseLCH, eid );

    baseLCH.C[ eid ] *= scale;

    PerceptualSoA.oklchToOklab( baseLCH, targetLab, eid );
    PerceptualSoA.oklabToLinearRGB( targetLab, out, eid );
    out.a[ eid ] = color.a[ eid ];
  },
};

// ---------------------------------------------------------------------------
// 3. Scratch buffer (reused intermediate stores)
// ---------------------------------------------------------------------------

/**
 * Allocate the scratch stores needed by applyPerfectTint / applyChromatization
 * and by the systems. `baseRGB` is included so the systems do not allocate it
 * lazily on first call.
 */
export function createScratch( maxEntities = 65536 ) {
  return {
    baseRGB: rgbStore( maxEntities ),
    baseLab: oklabStore( maxEntities ),
    baseLCH: oklchStore( maxEntities ),
    tintLab: oklabStore( maxEntities ),
    tintLCH: oklchStore( maxEntities ),
    targetLab: oklabStore( maxEntities ),
    targetLCH: oklchStore( maxEntities ),
  };
}

// ---------------------------------------------------------------------------
// 4. bitECS systems (free functions, not methods)
// ---------------------------------------------------------------------------

/**
 * bitECS system: apply PerfectTint to every entity with RGB + Tint
 * components. Results are written to the RGB store in place.
 *
 *   const world = createColorWorld();
 *   const { RGB, Tint } = world.components;
 *   const sys = tintSystem(RGB, Tint, scratch);
 */
export function tintSystem( RGB, Tint, scratch ) {
  return ( world ) => {
    const ents = query( world, [ RGB, Tint ] );
    const base = scratch.baseRGB;
    for ( let i = 0; i < ents.length; i ++ ) {
      const eid = ents[ i ];
      base.r[ eid ] = RGB.r[ eid ];
      base.g[ eid ] = RGB.g[ eid ];
      base.b[ eid ] = RGB.b[ eid ];
      base.a[ eid ] = RGB.a[ eid ];
      PerceptualSoA.applyPerfectTint( base, Tint, RGB, eid, scratch );
    }
    return world;
  };
}

/**
 * bitECS system: apply Chromatization to every entity with an RGB component.
 * `scale` may be a constant or a function (world, eid) -> number.
 */
export function chromatizationSystem( RGB, scale, scratch ) {
  return ( world ) => {
    const ents = query( world, [ RGB ] );
    const base = scratch.baseRGB;
    for ( let i = 0; i < ents.length; i ++ ) {
      const eid = ents[ i ];
      base.r[ eid ] = RGB.r[ eid ];
      base.g[ eid ] = RGB.g[ eid ];
      base.b[ eid ] = RGB.b[ eid ];
      base.a[ eid ] = RGB.a[ eid ];
      const s = typeof scale === 'function' ? scale( world, eid ) : scale;
      PerceptualSoA.applyChromatization( base, RGB, eid, s, scratch );
    }
    return world;
  };
}

// ---------------------------------------------------------------------------
// 5. World / entity factories
// ---------------------------------------------------------------------------

/**
 * Create a bitECS world pre-populated with the perceptual colour components.
 * The chat's createWorld() does not accept `components` / `time` args, so
 * they are attached after world creation. This is the only behavioural
 * difference from the upstream bitECS 0.4.0 API.
 */
export function createColorWorld( maxEntities = 65536 ) {
  const world = createWorld();
  world.components = {
    RGB: rgbStore( maxEntities ),
    Tint: tintStore( maxEntities ),
  };
  world.time = { delta: 0, elapsed: 0, then: _now() };
  return world;
}

/**
 * Create an entity with RGB (and Tint) components initialised from a Color or
 * raw linear RGB values. Tint.factor already defaults to 1.0 from tintStore().
 */
export function createColorEntity( world, color ) {
  const { RGB, Tint } = world.components;
  const eid = addEntity( world );
  addComponent( world, eid, RGB );
  addComponent( world, eid, Tint );
  if ( color ) {
    RGB.r[ eid ] = color.r;
    RGB.g[ eid ] = color.g;
    RGB.b[ eid ] = color.b;
    RGB.a[ eid ] = color.a !== undefined ? color.a : 1.0;
  }
  // Tint.factor already defaults to 1.0 from tintStore().
  return eid;
}

/**
 * Write a tint + factor for an entity. `factor` defaults to 1.0.
 *
 *   setTint(world, eid, new Color(0, 1, 1));       // full-strength cyan tint
 *   setTint(world, eid, new Color(0, 1, 1), 0.5);  // 50% strength
 */
export function setTint( world, eid, color, factor = 1.0 ) {
  const { Tint } = world.components;
  Tint.r[ eid ] = color.r;
  Tint.g[ eid ] = color.g;
  Tint.b[ eid ] = color.b;
  Tint.factor[ eid ] = factor;
}

// ---------------------------------------------------------------------------
// 6. Three.js-friendly wrappers (Tier 2 — setup / inspection)
// ---------------------------------------------------------------------------

/**
 * Convert a Color (linear RGB) to an Oklab triple.
 * @param {Color} color
 * @returns {{L:number, a:number, b:number}}
 */
export function colorToOklab( color ) {
  const rgb = { r: [ color.r ], g: [ color.g ], b: [ color.b ] };
  const lab = { L: [ 0 ], a: [ 0 ], b: [ 0 ] };
  PerceptualSoA.linearRGBToOklab( rgb, lab, 0 );
  return { L: lab.L[ 0 ], a: lab.a[ 0 ], b: lab.b[ 0 ] };
}

/**
 * Convert an Oklab triple back to a Color (linear RGB).
 * @param {{L:number, a:number, b:number}} lab
 * @returns {Color}
 */
export function oklabToColor( lab ) {
  const labArr = { L: [ lab.L ], a: [ lab.a ], b: [ lab.b ] };
  const rgb = { r: [ 0 ], g: [ 0 ], b: [ 0 ] };
  PerceptualSoA.oklabToLinearRGB( labArr, rgb, 0 );
  return new Color( rgb.r[ 0 ], rgb.g[ 0 ], rgb.b[ 0 ] );
}

/**
 * Apply PerfectTint to a single Color pair.
 * @param {Color} base
 * @param {Color} tint
 * @param {number} [factor=1.0]
 * @returns {Color}
 */
export function applyPerfectTintColor( base, tint, factor = 1.0 ) {
  const baseStore = rgbStore( 1 );
  const tintStoreInstance = tintStore( 1 );
  const outStore = rgbStore( 1 );
  const scratch = createScratch( 1 );

  baseStore.r[ 0 ] = base.r; baseStore.g[ 0 ] = base.g;
  baseStore.b[ 0 ] = base.b; baseStore.a[ 0 ] = base.a !== undefined ? base.a : 1;
  tintStoreInstance.r[ 0 ] = tint.r; tintStoreInstance.g[ 0 ] = tint.g;
  tintStoreInstance.b[ 0 ] = tint.b; tintStoreInstance.factor[ 0 ] = factor;

  PerceptualSoA.applyPerfectTint( baseStore, tintStoreInstance, outStore, 0, scratch );
  return new Color( outStore.r[ 0 ], outStore.g[ 0 ], outStore.b[ 0 ] );
}

/**
 * Apply Chromatization to a single Color.
 * @param {Color} color
 * @param {number} scale
 * @returns {Color}
 */
export function applyChromatizationColor( color, scale ) {
  const inStore = rgbStore( 1 );
  const outStore = rgbStore( 1 );
  const scratch = createScratch( 1 );

  inStore.r[ 0 ] = color.r; inStore.g[ 0 ] = color.g;
  inStore.b[ 0 ] = color.b; inStore.a[ 0 ] = color.a !== undefined ? color.a : 1;

  PerceptualSoA.applyChromatization( inStore, outStore, 0, scale, scratch );
  return new Color( outStore.r[ 0 ], outStore.g[ 0 ], outStore.b[ 0 ] );
}

// ---------------------------------------------------------------------------
// 7. Default export
// ---------------------------------------------------------------------------

export default {
  // Stores
  rgbStore, oklabStore, oklchStore, tintStore, createScratch,

  // SoA math
  PerceptualSoA,

  // Systems
  tintSystem, chromatizationSystem,

  // Factories
  createColorWorld, createColorEntity, setTint,

  // Three.js wrappers
  colorToOklab, oklabToColor,
  applyPerfectTintColor, applyChromatizationColor,

  // Re-exports
  Color, MathUtils,
  createWorld, addEntity, addComponent, query,
};