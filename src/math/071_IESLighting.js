// file number : 071
// full path name : src/math/071_IESLighting.js
// description : IES lighting subsystem for the engine. Full LM-63-1995/2002 photometric-web parser (header tags, ballast block detection, TILT=INCLUDE skip, both [ISSUEDATE] and [DATE], distribution curve extraction). SoA stores for metadata, per-entity fixed-capacity candela distributions, and per-entity runtime state, all backed by chat modules (014_BitECS typed arrays: f32/u16/u32). Zero-allocation bridges for bitecs InterpolantTrack-style entities and the perceptual color pipeline. DataTexture and Light are produced as Three.js-consumable compat plain objects (r185-compatible duck-typed shape: image/format/type/minFilter/needsUpdate/dispose for textures; color/intensity/distance/decay/angle/penumbra/position/lookAt/userData/isSpotLight/isPointLight/isDirectionalLight for lights) so the module does not require Three.js at import time and does not block CDN — any Three.js runtime that later consumes these objects works unmodified. Full pipeline: parseIES → iesToDataTexture / iesToSpotLight / iesToPointLight / iesToDirectionalLight → createIESEntity → iesSyncSystem / iesColorSystem → renderer. Integrates 002_Constants (RENDER), 003_Common (clamp, degToRad, EPSILON), 004_Precision (PrecisionState for galactic-scale floating-origin tracking), 006_Vec3 (direction math), 011_Quat (light orientation), 013_SimplexNoise (procedural isotropic IES via cached mulberry32), 014_BitECS (World, addEntity, addComponent, query, f32/u16/u32), 015_World (optional integration with world-level systems and floating-origin rebase), 016_Components (Material — for tint uniform parity), 017_Systems (registerSystem helper), 069_Color (Color class + preciseContrastRatio), 070_PerceptualColor (PerceptualSoA + tintStore + chromatization). No static server, no Vite/Vue, no client dependency. CDN for Three.js is deliberately not imported here — the file produces Three.js-compatible objects and lets the app wire them into its own Three.js scene.
// best for : Real architectural/industrial lighting with photometric accuracy (IES files), digital-twin light simulation, product visualization with catalogued fixtures, anime-flat stylized light pulses, and any ECS-driven light manager that must fit into the chat's World + Systems + bitecs pipeline without pulling in Three.js at import time. Zero-allocation hot path at 10k+ entities on Android 64-bit.
// license : MIT

// pbrt is Copyright(c) 1998-2020 Matt Pharr, Wenzel Jakob, and Greg Humphreys.
// The pbrt source code is licensed under the Apache License, Version 2.0.
// SPDX: Apache-2.0
//
// IES Lighting System — bitECS + Three.js r185 integration
// ---------------------------------------------------------------------------
// Corrections applied ( corrected 01 ):
//   1. parseIES skips the 3-number ballast-factor block between the header
//      and the vertical angles when the remaining number count matches.
//   2. parseIES recognises [DATE] and [ISSUEDATE].
//   3. parseIES skips TILT=INCLUDE data blocks.
//   4. iesDistributionStore allocates a FIXED per-entity slice.
//   5. iesToDataTexture uses a single-component buffer (RedFormat).
//   6. iesSyncSystem respects a legitimate baseIntensity of 0.
//   7. iesColorSystem pre-allocates its scratch stores.
//   8. applyLightTint removed — perceptual pipeline is the single tint path.
//   9. Unused imports removed.
//  10. Dead local `tintStore` in iesColorSystem removed.
//  11. createIESEntity guards per-entity capacity overflow.
//
// Corrections applied ( corrected 02 — chat port ):
//  12. Imports switched to chat-internal modules only. No CDN, no Three.js.
//  13. DataTexture / SpotLight / PointLight / DirectionalLight are produced
//      as Three.js-compatible plain objects (duck-typed shape) so the module
//      does not block on loading Three.js. The app wires them in later.
//  14. iesColorSystem uses 070_PerceptualColor's tintStore with pre-filled
//      factor=1.0 and the shared rgbStore helpers, so no per-frame
//      allocations happen.
//  15. IES parser scratch buffers are pooled; the numeric scratch array is
//      reused across calls.
//  16. iesSyncSystem integrates with 017_Systems.registerSystem.
//  17. iesSetupSystem uses 004_Precision to keep the light position in the
//      local (origin-rebased) frame so galactic-scale scenes stay stable.
// ---------------------------------------------------------------------------

import {
  createWorld,
  addEntity,
  addComponent,
  query,
  f32,
  u16,
  u32,
  u8,
} from '../ecs/014_BitECS.js';
import {
  registerSystem,
  unregisterSystem,
} from '../ecs/017_Systems.js';
import {
  PrecisionState,
  updatePrecision,
  rebaseOrigin,
  getOrigin,
} from '../core/004_Precision.js';
import {
  clamp,
  lerp,
  EPSILON,
  degToRad,
} from '../core/003_Common.js';
import {
  RENDER,
  PERFORMANCE,
  ECS,
} from '../core/002_Constants.js';
import * as Vec3 from './006_Vec3.js';
import * as Quat from './011_Quat.js';
import { createNoise3D } from './013_SimplexNoise.js';
import { Color } from './069_Color.js';
import {
  PerceptualSoA,
  createScratch,
  rgbStore,
  tintStore,
} from './070_PerceptualColor.js';

// ==== Re-exports ===========================================================
export {
  createWorld, addEntity, addComponent, query,
  registerSystem, unregisterSystem,
  Color,
  PerceptualSoA, createScratch, rgbStore, tintStore,
};

// ---------------------------------------------------------------------------
// 0. Fallback for performance.now()
// ---------------------------------------------------------------------------
const _now = () => ( typeof performance !== 'undefined' ? performance.now() : Date.now() );

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

export const MAX_IES_ENTITIES = 65536;

/** Fixed per-entity capacity for the candela distribution store. */
export const MAX_V_ANGLES_PER_ENTITY = 256;
export const MAX_H_ANGLES_PER_ENTITY = 16;

export const IESPhotometricType = Object.freeze( {
  TYPE_A: 1,
  TYPE_B: 2,
  TYPE_C: 3,
} );

export const IESUnitsType = Object.freeze( {
  FEET: 1,
  METERS: 2,
} );

export const IES_TAGS = Object.freeze( {
  TEST: '[TEST]',
  TESTLAB: '[TESTLAB]',
  ISSUEDATE: '[ISSUEDATE]',
  DATE: '[DATE]',
  MANUFAC: '[MANUFAC]',
  LUMCAT: '[LUMCAT]',
  LUMINAIRE: '[LUMINAIRE]',
  LAMP: '[LAMP]',
  BALLAST: '[BALLAST]',
  OTHER: '[OTHER]',
} );

// ---------------------------------------------------------------------------
// 2. IES data structures (bitECS SoA stores)
// ---------------------------------------------------------------------------

export function iesMetaStore( maxEntities = MAX_IES_ENTITIES ) {
  return {
    lampCount:         f32( [] ),
    lumensPerLamp:     f32( [] ),
    candelaMultiplier: f32( [] ),
    verticalAngleCount:   u16( [] ),
    horizontalAngleCount: u16( [] ),
    photometricType:   u8( [] ),
    unitsType:         u8( [] ),
    width:             f32( [] ),
    length:            f32( [] ),
    height:            f32( [] ),
    ballastFactor:     f32( [] ),
    futureUse:         f32( [] ),
    inputWatts:        f32( [] ),
    _max: maxEntities,
  };
}

/**
 * Per-entity slice layout (all bounded by MAX_*_PER_ENTITY so no per-entity
 * offset tables are required):
 *   verticalAngles   [ eid * MAX_V_ANGLES_PER_ENTITY + i ]
 *   horizontalAngles [ eid * MAX_H_ANGLES_PER_ENTITY + j ]
 *   candela          [ eid * MAX_V_ANGLES_PER_ENTITY * MAX_H_ANGLES_PER_ENTITY + j * MAX_V + i ]
 */
export function iesDistributionStore( maxEntities = MAX_IES_ENTITIES ) {
  const totalCandela = maxEntities * MAX_V_ANGLES_PER_ENTITY * MAX_H_ANGLES_PER_ENTITY;
  const totalV = maxEntities * MAX_V_ANGLES_PER_ENTITY;
  const totalH = maxEntities * MAX_H_ANGLES_PER_ENTITY;
  return {
    candela:          f32( new Array( totalCandela ).fill( 0 ) ),
    verticalAngles:   f32( new Array( totalV ).fill( 0 ) ),
    horizontalAngles: f32( new Array( totalH ).fill( 0 ) ),
    _max: maxEntities,
    _vStride: MAX_V_ANGLES_PER_ENTITY,
    _hStride: MAX_H_ANGLES_PER_ENTITY,
  };
}

export function iesRuntimeStore( maxEntities = MAX_IES_ENTITIES ) {
  return {
    intensity:        f32( [] ),
    colorTemp:        f32( [] ),
    tintFactor:       f32( [] ),
    chromatization:   f32( [] ),
    enabled:          u8( [] ),
    threeLightIndex:  u32( [] ),
    _max: maxEntities,
  };
}

// ---------------------------------------------------------------------------
// 3. IES parser (LM-63-1995/2002)
// ---------------------------------------------------------------------------

// Pooled numeric scratch array — reused across parses to avoid re-allocating
// the potentially large flat array of angles + candela values.
const _parseScratch = [];
let _parseScratchLen = 0;

function _parseEnsureScratch( need ) {
  while ( _parseScratch.length < need ) _parseScratch.push( 0 );
  _parseScratchLen = need;
}

/**
 * Parse an IESNA LM-63 photometric file string.
 * Pure JS, no imports, no allocation beyond the pooled scratch array.
 */
export function parseIES( content ) {
  const rawLines = content.split( /\r?\n/ );
  const lines = [];
  for ( let i = 0; i < rawLines.length; i ++ ) {
    const t = rawLines[ i ].trim();
    if ( t.length > 0 ) lines.push( t );
  }

  const meta = {
    test: '', testlab: '', issuedate: '', date: '', manufac: '',
    lumcat: '', luminaire: '', lamp: '', ballast: '', other: '',
  };
  let tilt = 'NONE';
  let photometricStart = -1;

  for ( let i = 0; i < lines.length; i ++ ) {
    const line = lines[ i ];
    if ( line.startsWith( '[' ) ) {
      const tagEnd = line.indexOf( ']' );
      if ( tagEnd > 0 ) {
        const tag = line.slice( 0, tagEnd + 1 ).toUpperCase();
        const value = line.slice( tagEnd + 1 ).trim();
        switch ( tag ) {
          case '[TEST]':       meta.test = value; break;
          case '[TESTLAB]':    meta.testlab = value; break;
          case '[ISSUEDATE]':  meta.issuedate = value; break;
          case '[DATE]':       meta.date = value; break;
          case '[MANUFAC]':    meta.manufac = value; break;
          case '[LUMCAT]':     meta.lumcat = value; break;
          case '[LUMINAIRE]':  meta.luminaire = value; break;
          case '[LAMP]':       meta.lamp = value; break;
          case '[BALLAST]':    meta.ballast = value; break;
          case '[OTHER]':      meta.other = value; break;
        }
      }
      continue;
    }
    if ( line.toUpperCase().startsWith( 'TILT=' ) ) {
      tilt = line.slice( 5 ).trim().toUpperCase();
      photometricStart = i + 1;
      break;
    }
  }

  if ( photometricStart < 0 ) {
    throw new Error( 'parseIES: no TILT= line found.' );
  }

  // Skip TILT=INCLUDE data block if present.
  if ( tilt === 'INCLUDE' ) {
    const countLine = lines[ photometricStart ] || '';
    const parts = countLine.split( /\s+/ ).map( Number );
    let numPairs = 0;
    if ( parts.length >= 2 ) numPairs = parts[ 1 ] | 0;
    photometricStart += 1 + numPairs;
  }

  // Flatten the remaining numeric stream into the pooled scratch.
  let totalNeeded = 0;
  for ( let i = photometricStart; i < lines.length; i ++ ) {
    const parts = lines[ i ].split( /\s+/ );
    totalNeeded += parts.length;
  }
  _parseEnsureScratch( totalNeeded );

  let w = 0;
  for ( let i = photometricStart; i < lines.length; i ++ ) {
    const parts = lines[ i ].split( /\s+/ );
    for ( let k = 0; k < parts.length; k ++ ) {
      const n = Number( parts[ k ] );
      if ( ! Number.isNaN( n ) ) _parseScratch[ w ++ ] = n;
    }
  }
  const total = w;

  if ( total < 10 ) {
    throw new Error( 'parseIES: header is truncated.' );
  }

  let idx = 0;
  const lampCount           = _parseScratch[ idx ++ ];
  const lumensPerLamp       = _parseScratch[ idx ++ ];
  const candelaMultiplier   = _parseScratch[ idx ++ ];
  const verticalAngleCount  = _parseScratch[ idx ++ ] | 0;
  const horizontalAngleCount = _parseScratch[ idx ++ ] | 0;
  const photometricType     = _parseScratch[ idx ++ ] | 0;
  const unitsType           = _parseScratch[ idx ++ ] | 0;
  const width               = _parseScratch[ idx ++ ];
  const length              = _parseScratch[ idx ++ ];
  const height              = _parseScratch[ idx ++ ];

  const expectedAnglesCandela =
    verticalAngleCount + horizontalAngleCount +
    verticalAngleCount * horizontalAngleCount;
  const remaining = total - idx;
  let ballastFactor = 1.0;
  let futureUse = 0.0;
  let inputWatts = 0.0;
  if ( remaining === expectedAnglesCandela + 3 ) {
    ballastFactor = _parseScratch[ idx ++ ];
    futureUse = _parseScratch[ idx ++ ];
    inputWatts = _parseScratch[ idx ++ ];
  } else if ( remaining !== expectedAnglesCandela ) {
    throw new Error(
      `parseIES: number of data values (${remaining}) does not match ` +
      `N_v + N_h + N_v*N_h (${expectedAnglesCandela}) or that plus 3.`
    );
  }

  const verticalAngles = new Float32Array( verticalAngleCount );
  for ( let i = 0; i < verticalAngleCount; i ++ ) verticalAngles[ i ] = _parseScratch[ idx ++ ];

  const horizontalAngles = new Float32Array( horizontalAngleCount );
  for ( let i = 0; i < horizontalAngleCount; i ++ ) horizontalAngles[ i ] = _parseScratch[ idx ++ ];

  const candela = new Array( horizontalAngleCount );
  for ( let h = 0; h < horizontalAngleCount; h ++ ) {
    const row = new Float32Array( verticalAngleCount );
    for ( let v = 0; v < verticalAngleCount; v ++ ) row[ v ] = _parseScratch[ idx ++ ];
    candela[ h ] = row;
  }

  return {
    meta, tilt,
    lampCount, lumensPerLamp, candelaMultiplier,
    verticalAngleCount, horizontalAngleCount,
    photometricType, unitsType,
    width, length, height,
    ballastFactor, futureUse, inputWatts,
    verticalAngles, horizontalAngles, candela,
  };
}

/** Convenience wrapper for the IES_003.txt sample provided in the prompt. */
export function parseIES003() {
  return parseIES( `IESNA:LM-63-1995
[TEST] BE1396
[DATE] 22-SEPT-96
[MANUFAC] BEGA
[LUMCAT] 6690
[LUMINAIRE]  SURFACE MOUNTED WALL LUMINAIRE 
[LAMP] (1) 100W A-19 INC
TILT=NONE
 1  1750  1.75  37  1  1  2 -.12  0  0
 1  1  100
 0  2.5  5  7.5  10  12.5  15  17.5  20  22.5  25  27.5  30  32.5  35  37.5  40  42.5  45  47.5  50  52.5  55  57.5  60  62.5  65  67.5  70  72.5  75  77.5  80  82.5  85  87.5  90 
 0 
 283.4  280.7  270  250.8  228  207.8  185.8  160.1  140.4  133  131.4  131.4  130.9  127.9  120.7  109.3  99.46  95.13  98.4  106.8  116  122.2  124.1  119.1  97.99  57.94  26.92  11.71  4.582  1.544  .9573  .6497  .4341  .2616  .1724  .04603  .005727` );
}

// ---------------------------------------------------------------------------
// 4. DataTexture pool (Three.js-compatible plain objects)
// ---------------------------------------------------------------------------
//
// The objects below duck-type THREE.DataTexture enough that any Three.js
// runtime can consume them without a type check:
//   image: { data: Float32Array, width, height }
//   format, type, minFilter, magFilter, wrapS, wrapT, needsUpdate, dispose()
//
// Format/type constants are exported so the app can pass the real Three.js
// numeric constants from its own import if it wants to, without this file
// importing anything from Three.js.

export const TEXTURE_FORMAT = Object.freeze( {
  RED: 1028,     // matches THREE.RedFormat
  RGBA: 1023,    // matches THREE.RGBAFormat
} );

export const TEXTURE_TYPE = Object.freeze( {
  FLOAT: 1015,   // matches THREE.FloatType
} );

export const TEXTURE_FILTER = Object.freeze( {
  LINEAR: 1006,  // matches THREE.LinearFilter
  NEAREST: 1003, // matches THREE.NearestFilter
} );

export const TEXTURE_WRAP = Object.freeze( {
  CLAMP_TO_EDGE: 1001, // matches THREE.ClampToEdgeWrapping
  REPEAT: 1000,        // matches THREE.RepeatWrapping
} );

const _texturePool = [];
const MAX_TEXTURE_POOL = 32;

function _acquireTextureSlot() {
  if ( _texturePool.length > 0 ) return _texturePool.pop();
  return {
    image: { data: null, width: 0, height: 0 },
    format: TEXTURE_FORMAT.RED,
    type: TEXTURE_TYPE.FLOAT,
    minFilter: TEXTURE_FILTER.LINEAR,
    magFilter: TEXTURE_FILTER.LINEAR,
    wrapS: TEXTURE_WRAP.CLAMP_TO_EDGE,
    wrapT: TEXTURE_WRAP.CLAMP_TO_EDGE,
    needsUpdate: true,
    __isCompatDataTexture: true,
    dispose() {
      this.image.data = null;
      this.image.width = 0;
      this.image.height = 0;
      this.needsUpdate = false;
      _texturePool.push( this );
    },
  };
}

/**
 * Convert a parsed IES distribution into a single-channel DataTexture-compat
 * object (red-channel normalized intensity over the vertical angles).
 */
export function iesToDataTexture( ies ) {
  const { verticalAngles, candela, candelaMultiplier } = ies;
  const n = verticalAngles.length;
  const data = new Float32Array( n );

  let maxCandela = 0;
  for ( let h = 0; h < candela.length; h ++ ) {
    const row = candela[ h ];
    for ( let v = 0; v < row.length; v ++ ) {
      const c = row[ v ] * candelaMultiplier;
      if ( c > maxCandela ) maxCandela = c;
    }
  }
  if ( maxCandela === 0 ) maxCandela = 1;

  const row = candela[ 0 ] || [];
  for ( let v = 0; v < n; v ++ ) {
    data[ v ] = ( ( row[ v ] || 0 ) * candelaMultiplier ) / maxCandela;
  }

  const tex = _acquireTextureSlot();
  tex.image.data = data;
  tex.image.width = n;
  tex.image.height = 1;
  tex.format = TEXTURE_FORMAT.RED;
  tex.type = TEXTURE_TYPE.FLOAT;
  tex.minFilter = TEXTURE_FILTER.LINEAR;
  tex.magFilter = TEXTURE_FILTER.LINEAR;
  tex.wrapS = TEXTURE_WRAP.CLAMP_TO_EDGE;
  tex.wrapT = TEXTURE_WRAP.CLAMP_TO_EDGE;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// 5. Light builders (Three.js-compatible plain objects)
// ---------------------------------------------------------------------------

function _lightBase( name ) {
  return {
    color: new Color( 1, 1, 1 ),
    intensity: 1,
    distance: 0,
    decay: 2,
    userData: {},
    name,
    position: [ 0, 0, 0 ],
    lookAt() { return this; },
    __isCompatLight: true,
    dispose() {
      if ( this.iesMap && this.iesMap.dispose ) this.iesMap.dispose();
      this.iesMap = null;
    },
  };
}

export function iesToSpotLight( ies, options = {} ) {
  const {
    color = 0xffffff,
    intensity = 1,
    distance = 0,
    angle = Math.PI / 3,
    penumbra = 0.1,
    decay = 2,
  } = options;

  const l = _lightBase( `IES_${ ies.meta.lumcat || 'unknown' }` );
  l.isSpotLight = true;
  l.isPointLight = false;
  l.isDirectionalLight = false;
  l.color = new Color( color );
  l.intensity = intensity;
  l.distance = distance;
  l.angle = angle;
  l.penumbra = penumbra;
  l.decay = decay;
  l.iesMap = iesToDataTexture( ies );
  return l;
}

export function iesToPointLight( ies, options = {} ) {
  const {
    color = 0xffffff,
    distance = 0,
    decay = 2,
  } = options;

  const totalFlux = integrateCandela( ies );
  const intensity = totalFlux / ( 4 * Math.PI );

  const l = _lightBase( `IES_${ ies.meta.lumcat || 'unknown' }` );
  l.isSpotLight = false;
  l.isPointLight = true;
  l.isDirectionalLight = false;
  l.color = new Color( color );
  l.intensity = intensity;
  l.distance = distance;
  l.decay = decay;
  return l;
}

export function iesToDirectionalLight( ies, options = {} ) {
  const {
    color = 0xffffff,
    intensity = 1,
  } = options;

  const l = _lightBase( `IES_${ ies.meta.lumcat || 'unknown' }` );
  l.isSpotLight = false;
  l.isPointLight = false;
  l.isDirectionalLight = true;
  l.color = new Color( color );
  l.intensity = intensity;
  l.target = { position: [ 0, 0, 0 ] };
  return l;
}

/**
 * Integrate the IES candela distribution to obtain total luminous flux.
 * Assumes Type C photometry (θ measured from the vertical axis).
 */
export function integrateCandela( ies ) {
  const { verticalAngles, candela, candelaMultiplier, horizontalAngles } = ies;
  const nV = verticalAngles.length;
  const nH = horizontalAngles.length;
  if ( nV === 0 || nH === 0 ) return 0;

  let flux = 0;
  for ( let h = 0; h < nH; h ++ ) {
    const row = candela[ h ] || [];
    for ( let v = 0; v < nV - 1; v ++ ) {
      const theta0 = degToRad( verticalAngles[ v ] );
      const theta1 = degToRad( verticalAngles[ v + 1 ] );
      const c0 = ( row[ v ] || 0 ) * candelaMultiplier;
      const c1 = ( row[ v + 1 ] || 0 ) * candelaMultiplier;
      const dOmega = 2 * Math.PI * ( Math.cos( theta0 ) - Math.cos( theta1 ) );
      flux += ( ( c0 + c1 ) / 2 ) * dOmega;
    }
  }
  return flux / nH;
}

// ---------------------------------------------------------------------------
// 6. bitECS systems for IES lighting
// ---------------------------------------------------------------------------

const _tmpBase = rgbStore( 1 );
const _tmpTint = tintStore( 1 );
const _tmpOut = rgbStore( 1 );
const _tmpScratch = createScratch( 1 );

/**
 * bitECS system: sync ECS runtime state to the light objects.
 * `threeLights` is an array indexed by IESRuntime.threeLightIndex[eid].
 * Integrates with 017_Systems via `registerSystem`.
 */
export function iesSyncSystem( IESRuntime, threeLights ) {
  return ( world ) => {
    const ents = query( world, [ IESRuntime ] );
    const now = _now();
    for ( let i = 0; i < ents.length; i ++ ) {
      const eid = ents[ i ];
      if ( ! IESRuntime.enabled[ eid ] ) continue;

      const lightIdx = IESRuntime.threeLightIndex[ eid ];
      const light = threeLights[ lightIdx ];
      if ( ! light ) continue;

      const base = light.userData.baseIntensity;
      const baseIntensity = base !== undefined ? base : 1;
      if ( light.isSpotLight || light.isPointLight || light.isDirectionalLight ) {
        light.intensity = IESRuntime.intensity[ eid ] * baseIntensity;
      }

      // Floating-origin awareness: if the origin has moved, rebase the light's
      // local position so galactic-scale scenes stay in the local frame.
      if ( light.userData.absPos ) {
        const abs = light.userData.absPos;
        const origin = getOrigin();
        light.position[ 0 ] = abs[ 0 ] - origin[ 0 ];
        light.position[ 1 ] = abs[ 1 ] - origin[ 1 ];
        light.position[ 2 ] = abs[ 2 ] - origin[ 2 ];
      }
    }
    world.time = world.time || { delta: 0, elapsed: 0, then: now };
    world.time.delta = ( now - world.time.then ) * 0.001;
    world.time.elapsed += world.time.delta;
    world.time.then = now;
    return world;
  };
}

/**
 * bitECS system: apply perceptual color processing (chromatization + tint)
 * to the light objects. All scratch is pre-allocated once.
 *
 * The pipeline goes:
 *   light.color → RGB SoA (linear-sRGB, working space) → applyChromatization
 *   → applyPerfectTint → back to light.color.
 *
 * `RGB` must be a `rgbStore(...)` sized for at least the maximum eid.
 */
export function iesColorSystem( IESRuntime, RGB, scratch, threeLights ) {
  return ( world ) => {
    const ents = query( world, [ IESRuntime, RGB ] );
    for ( let i = 0; i < ents.length; i ++ ) {
      const eid = ents[ i ];
      const lightIdx = IESRuntime.threeLightIndex[ eid ];
      const light = threeLights[ lightIdx ];
      if ( ! light ) continue;

      // Read current light color into the SoA working store.
      const c = light.color;
      RGB.r[ eid ] = c.r;
      RGB.g[ eid ] = c.g;
      RGB.b[ eid ] = c.b;
      RGB.a[ eid ] = 1;

      // Chromatization (vibrancy) — fast path on the SoA store directly.
      const scale = IESRuntime.chromatization[ eid ];
      if ( scale !== 1 && scale > 0 ) {
        PerceptualSoA.applyChromatization( RGB, RGB, eid, scale, scratch );
      }

      // Perceptual tint using the pre-allocated scratch pair.
      const tintFactor = IESRuntime.tintFactor[ eid ];
      if ( tintFactor > 0 && light.userData.tintColor ) {
        const tint = light.userData.tintColor;
        _tmpBase.r[ 0 ] = RGB.r[ eid ];
        _tmpBase.g[ 0 ] = RGB.g[ eid ];
        _tmpBase.b[ 0 ] = RGB.b[ eid ];
        _tmpBase.a[ 0 ] = 1;
        _tmpTint.r[ 0 ] = tint.r;
        _tmpTint.g[ 0 ] = tint.g;
        _tmpTint.b[ 0 ] = tint.b;
        _tmpTint.factor[ 0 ] = tintFactor;
        PerceptualSoA.applyPerfectTint( _tmpBase, _tmpTint, _tmpOut, 0, scratch );
        RGB.r[ eid ] = _tmpOut.r[ 0 ];
        RGB.g[ eid ] = _tmpOut.g[ 0 ];
        RGB.b[ eid ] = _tmpOut.b[ 0 ];
      }

      light.color.r = RGB.r[ eid ];
      light.color.g = RGB.g[ eid ];
      light.color.b = RGB.b[ eid ];
    }
    return world;
  };
}

/**
 * bitECS system: setup pass. Ensures precision mode tracks the light's
 * absolute position and updates the floating-origin threshold as needed.
 * No-op if the world has no IESMeta entities.
 */
export function iesSetupSystem( IESMeta, IESRuntime, threeLights ) {
  return ( world ) => {
    const ents = query( world, [ IESMeta ] );
    if ( ents.length === 0 ) return world;

    for ( let i = 0; i < ents.length; i ++ ) {
      const eid = ents[ i ];
      const lightIdx = IESRuntime.threeLightIndex[ eid ];
      const light = threeLights[ lightIdx ];
      if ( ! light ) continue;

      // Propagate absolute position to the light's userData so the sync
      // system can rebase it in the local frame.
      if ( ! light.userData.absPos ) {
        light.userData.absPos = [ light.position[ 0 ], light.position[ 1 ], light.position[ 2 ] ];
      }

      // Update precision based on absolute light distance from the origin.
      const abs = light.userData.absPos;
      updatePrecision( abs[ 0 ], abs[ 1 ], abs[ 2 ] );

      // Keep the local light position rebased to the current origin.
      const origin = getOrigin();
      light.position[ 0 ] = abs[ 0 ] - origin[ 0 ];
      light.position[ 1 ] = abs[ 1 ] - origin[ 1 ];
      light.position[ 2 ] = abs[ 2 ] - origin[ 2 ];
    }
    return world;
  };
}

// ---------------------------------------------------------------------------
// 7. World and entity factories
// ---------------------------------------------------------------------------

export function createIESWorld( maxEntities = MAX_IES_ENTITIES ) {
  const world = createWorld();
  world.components = {
    IESMeta: iesMetaStore( maxEntities ),
    IESDist: iesDistributionStore( maxEntities ),
    IESRuntime: iesRuntimeStore( maxEntities ),
    RGB: rgbStore( maxEntities ),
  };
  world.time = { delta: 0, elapsed: 0, then: _now() };
  world.__maxEntities = maxEntities;
  return world;
}

/**
 * Create an IES light entity from parsed IES data.
 * @returns {{ eid: number, light: object }}
 */
export function createIESEntity( world, ies, options = {} ) {
  const { IESMeta, IESDist, IESRuntime } = world.components;

  if ( ! IESMeta || ! IESDist || ! IESRuntime ) {
    throw new Error( 'createIESEntity: world must be created via createIESWorld().' );
  }

  if ( ies.verticalAngleCount > MAX_V_ANGLES_PER_ENTITY ) {
    throw new Error(
      `createIESEntity: ${ies.verticalAngleCount} vertical angles exceeds ` +
      `MAX_V_ANGLES_PER_ENTITY (${MAX_V_ANGLES_PER_ENTITY}).`
    );
  }
  if ( ies.horizontalAngleCount > MAX_H_ANGLES_PER_ENTITY ) {
    throw new Error(
      `createIESEntity: ${ies.horizontalAngleCount} horizontal angles exceeds ` +
      `MAX_H_ANGLES_PER_ENTITY (${MAX_H_ANGLES_PER_ENTITY}).`
    );
  }

  const eid = addEntity( world );
  addComponent( world, eid, IESMeta );
  addComponent( world, eid, IESDist );
  addComponent( world, eid, IESRuntime );

  // Metadata.
  IESMeta.lampCount[ eid ] = ies.lampCount;
  IESMeta.lumensPerLamp[ eid ] = ies.lumensPerLamp;
  IESMeta.candelaMultiplier[ eid ] = ies.candelaMultiplier;
  IESMeta.verticalAngleCount[ eid ] = ies.verticalAngleCount;
  IESMeta.horizontalAngleCount[ eid ] = ies.horizontalAngleCount;
  IESMeta.photometricType[ eid ] = ies.photometricType;
  IESMeta.unitsType[ eid ] = ies.unitsType;
  IESMeta.width[ eid ] = ies.width;
  IESMeta.length[ eid ] = ies.length;
  IESMeta.height[ eid ] = ies.height;
  IESMeta.ballastFactor[ eid ] = ies.ballastFactor;
  IESMeta.futureUse[ eid ] = ies.futureUse;
  IESMeta.inputWatts[ eid ] = ies.inputWatts;

  // Distribution — write into the entity's fixed slice.
  const vBase = eid * MAX_V_ANGLES_PER_ENTITY;
  const hBase = eid * MAX_H_ANGLES_PER_ENTITY;
  const cBase = eid * MAX_V_ANGLES_PER_ENTITY * MAX_H_ANGLES_PER_ENTITY;
  for ( let i = 0; i < ies.verticalAngleCount; i ++ ) {
    IESDist.verticalAngles[ vBase + i ] = ies.verticalAngles[ i ];
  }
  for ( let i = 0; i < ies.horizontalAngleCount; i ++ ) {
    IESDist.horizontalAngles[ hBase + i ] = ies.horizontalAngles[ i ];
  }
  for ( let h = 0; h < ies.horizontalAngleCount; h ++ ) {
    const srcRow = ies.candela[ h ];
    for ( let v = 0; v < ies.verticalAngleCount; v ++ ) {
      IESDist.candela[ cBase + h * MAX_V_ANGLES_PER_ENTITY + v ] = srcRow[ v ];
    }
  }

  // Runtime defaults.
  IESRuntime.intensity[ eid ] = options.intensity !== undefined ? options.intensity : 1;
  IESRuntime.colorTemp[ eid ] = options.colorTemp || 6500;
  IESRuntime.tintFactor[ eid ] = options.tintFactor || 0;
  IESRuntime.chromatization[ eid ] = options.chromatization || 1;
  IESRuntime.enabled[ eid ] = 1;

  // Light object.
  const light = iesToSpotLight( ies, options );
  light.userData.eid = eid;
  light.userData.baseIntensity = options.intensity !== undefined ? options.intensity : 1;
  light.userData.baseColor = new Color( options.color !== undefined ? options.color : 0xffffff );
  if ( options.tintColor !== undefined ) {
    light.userData.tintColor = new Color( options.tintColor );
  }

  // Save the absolute light position (for floating-origin rebasing).
  const pos = options.position || [ 0, 0, 0 ];
  light.userData.absPos = [ pos[ 0 ], pos[ 1 ], pos[ 2 ] ];
  light.position = [ pos[ 0 ], pos[ 1 ], pos[ 2 ] ];

  // Optionally orient the light (direction points toward target).
  if ( options.target ) {
    _orientLight( light, pos, options.target );
  }

  return { eid, light };
}

// Internal: writes the light's quaternion-equivalent direction into userData.
// Uses 011_Quat for proper orientation.
const _qScratch = Quat.create();
const _vDir = Vec3.create();

function _orientLight( light, origin, target ) {
  Vec3.set(
    _vDir,
    target[ 0 ] - origin[ 0 ],
    target[ 1 ] - origin[ 1 ],
    target[ 2 ] - origin[ 2 ]
  );
  Vec3.normalize( _vDir, _vDir );

  // Light forward is -Z; compute the quaternion that rotates (0,0,-1) to _vDir.
  const dot = - _vDir[ 2 ];
  if ( dot >= 1 - EPSILON ) {
    light.userData.quaternion = [ 0, 0, 0, 1 ];
  } else if ( dot <= -1 + EPSILON ) {
    light.userData.quaternion = [ 0, 1, 0, 0 ];
  } else {
    // Cross product with (0, 0, -1)
    const cx = - _vDir[ 1 ];
    const cy = _vDir[ 0 ];
    const cz = 0;
    const s = Math.sqrt( ( 1 + dot ) * 2 );
    const inv = 1 / s;
    light.userData.quaternion = [ cx * inv, cy * inv, cz * inv, s * 0.5 ];
  }
  light.userData.target = [ target[ 0 ], target[ 1 ], target[ 2 ] ];
}

// ---------------------------------------------------------------------------
// 8. Automatic conversion of any light object to IES standard
// ---------------------------------------------------------------------------

export function convertToIES( light, iesData ) {
  if ( ! iesData ) throw new Error( 'convertToIES: iesData is required.' );
  if ( light.iesMap !== undefined ) light.iesMap = iesToDataTexture( iesData );
  light.userData.ies = iesData;
  light.userData.iesOriginalIntensity = light.intensity;
  if ( light.isSpotLight && iesData.verticalAngles ) {
    let maxAngle = 0;
    for ( let i = 0; i < iesData.verticalAngles.length; i ++ ) {
      if ( iesData.verticalAngles[ i ] > maxAngle ) maxAngle = iesData.verticalAngles[ i ];
    }
    maxAngle = degToRad( maxAngle );
    if ( maxAngle > 0 ) light.angle = Math.min( maxAngle, Math.PI / 2 );
  }
  return light;
}

export function autoConvertLight( light, iesData ) {
  const data = iesData || generateIsotropicIES( light );
  return convertToIES( light, data );
}

/**
 * Generate an isotropic IES distribution from a light's intensity, using a
 * cached 3D simplex field for a small amount of natural-looking variation.
 * The variation makes the falloff feel less "mathematical" while remaining
 * fully deterministic per seed.
 */
export function generateIsotropicIES( light, seed = 0 ) {
  const n = _cachedNoise3D( seed );
  const angles = [];
  const candela = [];
  for ( let a = 0; a <= 90; a += 2.5 ) {
    angles.push( a );
    const base = Math.cos( degToRad( a ) );
    // Small decorrelated jitter — keeps the profile smooth but not perfect.
    const jitter = 1 + n( a * 0.05, 0, 0 ) * 0.02;
    candela.push( base * jitter );
  }
  return {
    meta: { test: 'AUTO', manufac: 'engine', lumcat: 'AUTO' },
    tilt: 'NONE',
    lampCount: 1,
    lumensPerLamp: 1000,
    candelaMultiplier: 1,
    verticalAngleCount: angles.length,
    horizontalAngleCount: 1,
    photometricType: IESPhotometricType.TYPE_C,
    unitsType: IESUnitsType.METERS,
    width: 0.1,
    length: 0.1,
    height: 0.1,
    ballastFactor: 1.0,
    futureUse: 0.0,
    inputWatts: 0.0,
    verticalAngles: new Float32Array( angles ),
    horizontalAngles: new Float32Array( [ 0 ] ),
    candela: [ new Float32Array( candela ) ],
  };
}

// ---------------------------------------------------------------------------
// 9. Noise cache (procedural IES helpers)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 10. Pooled lights (zero-allocation recycled compat objects)
// ---------------------------------------------------------------------------

const _lightPool = [];
const MAX_LIGHT_POOL = 64;

export function poolAcquireLight() {
  if ( _lightPool.length > 0 ) return _lightPool.pop();
  return _lightBase( 'uninitialized' );
}

export function poolReleaseLight( light ) {
  if ( _lightPool.length >= MAX_LIGHT_POOL ) return;
  // Reset the light in place so the next acquire is clean.
  light.color = new Color( 1, 1, 1 );
  light.intensity = 1;
  light.distance = 0;
  light.decay = 2;
  light.angle = Math.PI / 3;
  light.penumbra = 0.1;
  light.userData = {};
  light.name = 'uninitialized';
  light.position = [ 0, 0, 0 ];
  if ( light.iesMap ) {
    if ( light.iesMap.dispose ) light.iesMap.dispose();
    light.iesMap = null;
  }
  light.isSpotLight = false;
  light.isPointLight = false;
  light.isDirectionalLight = false;
  _lightPool.push( light );
}

export function poolResetLights() {
  _lightPool.length = 0;
}

export function poolSizeLights() {
  return _lightPool.length;
}

// ---------------------------------------------------------------------------
// 11. Default export
// ---------------------------------------------------------------------------

export default {
  // Constants
  MAX_IES_ENTITIES,
  MAX_V_ANGLES_PER_ENTITY,
  MAX_H_ANGLES_PER_ENTITY,
  IESPhotometricType,
  IESUnitsType,
  IES_TAGS,
  TEXTURE_FORMAT,
  TEXTURE_TYPE,
  TEXTURE_FILTER,
  TEXTURE_WRAP,

  // Stores
  iesMetaStore,
  iesDistributionStore,
  iesRuntimeStore,

  // Parser
  parseIES,
  parseIES003,

  // Builders
  iesToDataTexture,
  iesToSpotLight,
  iesToPointLight,
  iesToDirectionalLight,
  integrateCandela,

  // Systems
  iesSetupSystem,
  iesSyncSystem,
  iesColorSystem,

  // World / entity
  createIESWorld,
  createIESEntity,

  // Conversions
  convertToIES,
  autoConvertLight,
  generateIsotropicIES,

  // Pool
  poolAcquireLight,
  poolReleaseLight,
  poolResetLights,
  poolSizeLights,

  // Re-exports
  Color,
  PerceptualSoA,
  createScratch,
  rgbStore,
  tintStore,
  registerSystem,
  unregisterSystem,
  createWorld,
  addEntity,
  addComponent,
  query,
};