// file number : 072
// full path name : src/math/072_ArchvizLighting.js
// description : Complete archviz lighting kit built on 071_IESLighting.js and the entire chat stack. Ships an embedded IES profile library matching the kinds of photometric webs found in tobspr/RenderPipeline's data/ies_profiles (downlight, wallwasher, batwing, narrow spot, wide flood, pendant, asymmetric downlight) as LM-63-1995 strings so no static server or CDN is required for the profiles. Builds a full archviz scene as an ECS world: floor / walls / ceiling / furniture proxies as bitecs entities, ceiling downlight grid, wall-wash strips, batwing general fill, narrow accent spots for artwork, pendant lights, plus a warm/cool/time-of-day color grading pass driven by 070_PerceptualColor. Systems: iesSetupSystem, iesSyncSystem, iesColorSystem, archvizDayCycleSystem, archvizLODSystem, archvizFloatingOriginSystem. Uses 002_Constants (RENDER, PERFORMANCE, ECS), 003_Common (clamp, lerp, degToRad), 004_Precision (floating origin + adaptive precision), 006_Vec3 (light directions), 011_Quat (light orientation), 013_SimplexNoise (procedural fixture jitter), 014_BitECS (world/entity/component), 015_World (system registry, spatial grid), 016_Components (Material presets), 017_Systems (registerSystem), 069_Color (Color, ColorManagement, SKY/MEADOW/COTTAGE themes), 070_PerceptualColor (tintStore + chromatization pipeline), 071_IESLighting (parseIES, createIESWorld, createIESEntity, iesToSpotLight, iesToDataTexture, iesSetupSystem, iesSyncSystem, iesColorSystem, integrateCandela, generateIsotropicIES). Emits 100% Three.js-compatible light objects (position / color / intensity / angle / penumbra / iesMap DataTexture-compatible) so the app can scene.add(light) with r185 without this module importing Three.js at load time. Pooled lights, pooled colors, pooled IES textures. No static server, no Vite/Vue, no client dependency.
// best for : Architectural visualization scenes (interior, exterior facade, product showcase), digital twins, lighting design previsualization, showroom/product viewers, anime-flat stylized interiors with a physically-based light budget, and any large-scale scene that needs a physically-accurate light rig without pulling Three.js into the math/ECS layer.
// license : MIT

import {
  RENDER,
  PERFORMANCE,
  ECS,
  SCALE,
  CONTEXT,
} from '../core/002_Constants.js';
import {
  clamp,
  lerp,
  degToRad,
  radToDeg,
  EPSILON,
  smoothstep,
} from '../core/003_Common.js';
import {
  PrecisionState,
  updatePrecision,
  getOrigin,
  rebaseOrigin,
  shouldRebase,
  maybeRebase,
  isFloat32,
  isFloat64,
} from '../core/004_Precision.js';
import * as Vec3 from './006_Vec3.js';
import * as Quat from './011_Quat.js';
import * as Noise from './013_SimplexNoise.js';
import * as bitecs from '../ecs/014_BitECS.js';
import * as World from '../ecs/015_World.js';
import * as Components from '../ecs/016_Components.js';
import * as Systems from '../ecs/017_Systems.js';
import {
  Color,
  ColorManagement,
  SKY_THEME,
  MEADOW_THEME,
  COTTAGE_THEME,
  FOREST_THEME,
  SPACE_THEME,
  relativeLuminance,
  perceivedBrightness,
  autoContrastInto,
} from './069_Color.js';
import {
  PerceptualSoA,
  createScratch as createPerceptualScratch,
  rgbStore,
  tintStore,
} from './070_PerceptualColor.js';
import {
  parseIES,
  parseIES003,
  createIESWorld,
  createIESEntity,
  iesToSpotLight,
  iesToPointLight,
  iesToDataTexture,
  integrateCandela,
  generateIsotropicIES,
  iesSetupSystem,
  iesSyncSystem,
  iesColorSystem,
  MAX_IES_ENTITIES,
  MAX_V_ANGLES_PER_ENTITY,
  MAX_H_ANGLES_PER_ENTITY,
  IESPhotometricType,
  IESUnitsType,
  poolAcquireLight,
  poolReleaseLight,
} from './071_IESLighting.js';

// ==== Re-exports ===========================================================
export {
  Color, ColorManagement,
  PerceptualSoA,
  createPerceptualScratch,
  rgbStore, tintStore,
  parseIES, parseIES003,
  createIESWorld, createIESEntity,
  iesToSpotLight, iesToPointLight,
  iesToDataTexture, integrateCandela,
  generateIsotropicIES,
  iesSetupSystem, iesSyncSystem, iesColorSystem,
  poolAcquireLight, poolReleaseLight,
  PrecisionState, updatePrecision, getOrigin, rebaseOrigin,
  SKY_THEME, MEADOW_THEME, COTTAGE_THEME, FOREST_THEME, SPACE_THEME,
  registerSystem: Systems.registerSystem,
};

// ---------------------------------------------------------------------------
// 1. IES profile library — LM-63-1995 strings
// ---------------------------------------------------------------------------
//
// These fixtures mirror the kinds of IES profiles shipped in
// tobspr/RenderPipeline's data/ies_profiles directory (downlights,
// wallwashers, batwing general fill, accent spots, pendants). Each profile is
// a complete LM-63-1995 string, so the parser in 071_IESLighting.js can
// consume them directly without any external file fetch or static server.
//
// Angles in degrees. Candela in cd. CCT-independent (color is applied later
// via the perceptual pipeline).

/** 24° narrow beam downlight (typical recessed MR16 style). */
export const IES_DOWNLIGHT_24 = `IESNA:LM-63-1995
[TEST] ARCHVIZ_DOWNLIGHT_24
[DATE] 01-JAN-2026
[MANUFAC] ENGINE
[LUMCAT] DL-24
[LUMINAIRE] 24 DEG ROUND DOWNLIGHT
[LAMP] 1x LED
TILT=NONE
1 1000 1 37 1 1 2 0.1 0.1 0.05
0 2.5 5 7.5 10 12.5 15 17.5 20 22.5 25 27.5 30 32.5 35 37.5 40 42.5 45 47.5 50 52.5 55 57.5 60 62.5 65 67.5 70 72.5 75 77.5 80 82.5 85 87.5 90
0
1000 998 990 975 950 915 870 815 750 680 600 515 425 340 260 190 132 88 56 34 19 10 5 2 0.8 0.3 0.1 0.03 0.01 0 0 0 0 0 0 0 0`;

/** Asymmetric wall-washer (peaks toward the wall side, 0° in the horizontal). */
export const IES_WALLWASHER = `IESNA:LM-63-1995
[TEST] ARCHVIZ_WALLWASHER
[DATE] 01-JAN-2026
[MANUFAC] ENGINE
[LUMCAT] WW-01
[LUMINAIRE] ASYMMETRIC WALL WASHER
[LAMP] 1x LED
TILT=NONE
1 1200 1 37 5 1 2 0.3 0.1 0.05
0 2.5 5 7.5 10 12.5 15 17.5 20 22.5 25 27.5 30 32.5 35 37.5 40 42.5 45 47.5 50 52.5 55 57.5 60 62.5 65 67.5 70 72.5 75 77.5 80 82.5 85 87.5 90
-90 -45 0 45 90
20 22 25 28 32 36 40 44 48 52 56 60 63 66 68 70 72 73 74 74 73 72 70 68 66 63 60 56 52 48 44 40 36 32 28 25 20
60 65 72 80 88 96 104 112 120 128 136 144 150 155 158 160 161 162 162 161 160 158 155 150 144 136 128 120 112 104 96 88 80 72 65 60 55
180 190 200 212 224 236 248 260 272 284 296 308 318 326 332 336 338 340 340 339 336 332 326 318 308 296 284 272 260 248 236 224 212 200 190 180 170
20 22 25 28 32 36 40 44 48 52 56 60 63 66 68 70 72 73 74 74 73 72 70 68 66 63 60 56 52 48 44 40 36 32 28 25 20
5 5 6 7 8 10 12 14 16 18 20 22 24 26 28 30 32 34 36 37 38 39 40 40 40 39 38 37 36 34 32 30 28 26 24 22 20`;

/** Batwing distribution (peak at ~±30° off axis) for even general lighting. */
export const IES_BATWING = `IESNA:LM-63-1995
[TEST] ARCHVIZ_BATWING
[DATE] 01-JAN-2026
[MANUFAC] ENGINE
[LUMCAT] BW-30
[LUMINAIRE] BATWING GENERAL FILL
[LAMP] 1x LED
TILT=NONE
1 1500 1 37 1 1 2 0.15 0.15 0.1
0 2.5 5 7.5 10 12.5 15 17.5 20 22.5 25 27.5 30 32.5 35 37.5 40 42.5 45 47.5 50 52.5 55 57.5 60 62.5 65 67.5 70 72.5 75 77.5 80 82.5 85 87.5 90
0
400 420 460 520 600 680 760 830 890 940 970 990 1000 1000 990 970 940 900 850 800 740 680 610 540 470 400 330 270 210 160 110 70 40 20 10 4 0`;

/** 10° narrow accent spotlight. */
export const IES_NARROW_SPOT_10 = `IESNA:LM-63-1995
[TEST] ARCHVIZ_NARROW_SPOT_10
[DATE] 01-JAN-2026
[MANUFAC] ENGINE
[LUMCAT] NS-10
[LUMINAIRE] 10 DEG ACCENT SPOT
[LAMP] 1x LED
TILT=NONE
1 800 1 37 1 1 2 0.05 0.05 0.08
0 2.5 5 7.5 10 12.5 15 17.5 20 22.5 25 27.5 30 32.5 35 37.5 40 42.5 45 47.5 50 52.5 55 57.5 60 62.5 65 67.5 70 72.5 75 77.5 80 82.5 85 87.5 90
0
800 799 796 790 780 760 720 660 590 500 400 300 210 140 88 50 26 12 5 1.5 0.3 0.05 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;

/** 60° wide flood. */
export const IES_WIDE_SPOT_60 = `IESNA:LM-63-1995
[TEST] ARCHVIZ_WIDE_SPOT_60
[DATE] 01-JAN-2026
[MANUFAC] ENGINE
[LUMCAT] WF-60
[LUMINAIRE] 60 DEG WIDE FLOOD
[LAMP] 1x LED
TILT=NONE
1 1200 1 37 1 1 2 0.1 0.1 0.05
0 2.5 5 7.5 10 12.5 15 17.5 20 22.5 25 27.5 30 32.5 35 37.5 40 42.5 45 47.5 50 52.5 55 57.5 60 62.5 65 67.5 70 72.5 75 77.5 80 82.5 85 87.5 90
0
1200 1195 1180 1160 1130 1090 1050 1000 950 890 830 770 700 630 560 490 420 350 290 230 175 130 90 58 35 18 8 3 0.8 0.2 0 0 0 0 0 0 0`;

/** Pendant with downward-biased omnidirectional distribution. */
export const IES_PENDANT = `IESNA:LM-63-1995
[TEST] ARCHVIZ_PENDANT
[DATE] 01-JAN-2026
[MANUFAC] ENGINE
[LUMCAT] PD-01
[LUMINAIRE] PENDANT DOWNLIGHT
[LAMP] 1x LED
TILT=NONE
1 1100 1 37 1 1 2 0.2 0.2 0.25
0 2.5 5 7.5 10 12.5 15 17.5 20 22.5 25 27.5 30 32.5 35 37.5 40 42.5 45 47.5 50 52.5 55 57.5 60 62.5 65 67.5 70 72.5 75 77.5 80 82.5 85 87.5 90
0
500 510 530 560 600 640 680 710 730 740 740 730 710 680 640 600 550 500 450 400 350 300 250 200 160 120 90 65 45 30 20 12 8 5 3 2 1`;

/** Registry of embedded IES profiles by name. */
export const IES_PROFILES = Object.freeze( {
  DOWNLIGHT_24: IES_DOWNLIGHT_24,
  WALLWASHER: IES_WALLWASHER,
  BATWING: IES_BATWING,
  NARROW_SPOT_10: IES_NARROW_SPOT_10,
  WIDE_SPOT_60: IES_WIDE_SPOT_60,
  PENDANT: IES_PENDANT,
} );

/**
 * Parse every embedded IES profile once and cache the parsed data. This avoids
 * re-parsing on every fixture spawn.
 */
const _parsedIESCache = new Map();

export function getParsedIES( name ) {
  let parsed = _parsedIESCache.get( name );
  if ( parsed !== undefined ) return parsed;
  const raw = IES_PROFILES[ name ];
  if ( raw === undefined ) {
    throw new Error( `getParsedIES: unknown profile "${name}"` );
  }
  parsed = parseIES( raw );
  _parsedIESCache.set( name, parsed );
  return parsed;
}

// ---------------------------------------------------------------------------
// 2. Fixture registry — high-level fixture descriptions
// ---------------------------------------------------------------------------

/**
 * Fixture presets: which IES profile to use, what light type to build, base
 * color and default intensity, and the kind of placement that is typical for
 * archviz.
 */
export const FIXTURES = Object.freeze( {
  RECESSED_DOWNLIGHT: Object.freeze( {
    name: 'recessedDownlight',
    iesProfile: 'DOWNLIGHT_24',
    lightType: 'spot',
    baseColor: 0xfff0d8,          // warm white
    intensity: 800,               // lm
    angle: degToRad( 45 ),
    penumbra: 0.35,
    distance: 6,
    decay: 2,
    castShadow: true,
    chromaticity: 1.0,
    tintFactor: 0.0,
  } ),
  WALL_WASHER: Object.freeze( {
    name: 'wallWasher',
    iesProfile: 'WALLWASHER',
    lightType: 'spot',
    baseColor: 0xfff4e0,
    intensity: 1200,
    angle: degToRad( 60 ),
    penumbra: 0.2,
    distance: 8,
    decay: 2,
    castShadow: false,
    chromaticity: 1.0,
    tintFactor: 0.0,
  } ),
  GENERAL_FILL: Object.freeze( {
    name: 'generalFill',
    iesProfile: 'BATWING',
    lightType: 'spot',
    baseColor: 0xffffff,
    intensity: 1500,
    angle: degToRad( 70 ),
    penumbra: 0.5,
    distance: 12,
    decay: 2,
    castShadow: false,
    chromaticity: 1.0,
    tintFactor: 0.0,
  } ),
  ACCENT_SPOT: Object.freeze( {
    name: 'accentSpot',
    iesProfile: 'NARROW_SPOT_10',
    lightType: 'spot',
    baseColor: 0xffe8c8,
    intensity: 600,
    angle: degToRad( 15 ),
    penumbra: 0.15,
    distance: 4,
    decay: 2,
    castShadow: true,
    chromaticity: 1.1,
    tintFactor: 0.0,
  } ),
  WIDE_FLOOD: Object.freeze( {
    name: 'wideFlood',
    iesProfile: 'WIDE_SPOT_60',
    lightType: 'spot',
    baseColor: 0xfff8f0,
    intensity: 1000,
    angle: degToRad( 75 ),
    penumbra: 0.4,
    distance: 10,
    decay: 2,
    castShadow: false,
    chromaticity: 1.0,
    tintFactor: 0.0,
  } ),
  PENDANT: Object.freeze( {
    name: 'pendant',
    iesProfile: 'PENDANT',
    lightType: 'spot',
    baseColor: 0xffe4b8,
    intensity: 1100,
    angle: degToRad( 80 ),
    penumbra: 0.6,
    distance: 6,
    decay: 2,
    castShadow: true,
    chromaticity: 1.0,
    tintFactor: 0.0,
  } ),
} );

// ---------------------------------------------------------------------------
// 3. Color grading presets — warm / neutral / cool / anime
// ---------------------------------------------------------------------------

/**
 * Light-rig color grading presets. Each preset sets the base color, tint color,
 * tint factor, chromatization, and exposure. Passed to the archviz rig builder.
 */
export const COLOR_GRADES = Object.freeze( {
  WARM_EVENING: Object.freeze( {
    name: 'warmEvening',
    baseColor: 0xffd6a8,
    tintColor: 0xff9b5c,
    tintFactor: 0.35,
    chromatization: 1.15,
    exposure: 0.9,
    ambientColor: 0x3a2a1a,
    ambientIntensity: 0.15,
  } ),
  NEUTRAL_DAYLIGHT: Object.freeze( {
    name: 'neutralDaylight',
    baseColor: 0xfff6ec,
    tintColor: 0xfff6ec,
    tintFactor: 0.0,
    chromatization: 1.0,
    exposure: 1.0,
    ambientColor: 0x5a6a7a,
    ambientIntensity: 0.35,
  } ),
  COOL_MORNING: Object.freeze( {
    name: 'coolMorning',
    baseColor: 0xe8f2ff,
    tintColor: 0xb8d8ff,
    tintFactor: 0.25,
    chromatization: 0.95,
    exposure: 1.05,
    ambientColor: 0x3a4a6a,
    ambientIntensity: 0.25,
  } ),
  ANIME_FLAT: Object.freeze( {
    name: 'animeFlat',
    baseColor: 0xfff0d0,
    tintColor: 0xffc080,
    tintFactor: 0.55,
    chromatization: 1.35,
    exposure: 1.1,
    ambientColor: 0x5a4070,
    ambientIntensity: 0.40,
  } ),
} );

// ---------------------------------------------------------------------------
// 4. Archviz scene builder
// ---------------------------------------------------------------------------

/**
 * Options for `createArchvizScene`:
 *
 *   width, depth, height : room dimensions in meters
 *   ceilingGrid          : { rows, cols, fixture, colorGrade }
 *   wallWash             : { count, fixture, colorGrade }
 *   accentSpots          : [{ target: [x,y,z], fixture, colorGrade }]
 *   pendants             : [{ position: [x,y,z], fixture, colorGrade }]
 *   ambientFill          : { intensity, color }
 *   colorGrade           : default COLOR_GRADES.* preset
 *   sunDirection         : { x, y, z } for the main directional fill
 *   sunIntensity         : directional light intensity
 *   buildRoom            : if true, spawn floor/walls/ceiling as ECS entities
 *   seed                 : procedural jitter seed
 */
export function createArchvizScene( options = {} ) {
  const world = createIESWorld( MAX_IES_ENTITIES );
  world.time = world.time || { delta: 0, elapsed: 0, then: 0 };

  const scene = {
    world,
    lights: [],
    room: null,
    sun: null,
    ambient: null,
    colorGrade: options.colorGrade || COLOR_GRADES.NEUTRAL_DAYLIGHT,
    rigOptions: options,
    /** Registry of every spawned fixture eid, for later mutation. */
    fixtures: [],
  };

  const width = options.width !== undefined ? options.width : 12;
  const depth = options.depth !== undefined ? options.depth : 10;
  const height = options.height !== undefined ? options.height : 3.2;
  scene.dimensions = { width, depth, height };

  // Optionally spawn the room shell as ECS entities.
  if ( options.buildRoom !== false ) {
    scene.room = _spawnRoomShell( world, width, depth, height );
  }

  // Ceiling downlight grid.
  if ( options.ceilingGrid !== false ) {
    const grid = options.ceilingGrid || {};
    const rows = grid.rows !== undefined ? grid.rows : 3;
    const cols = grid.cols !== undefined ? grid.cols : 4;
    const fixture = grid.fixture || FIXTURES.RECESSED_DOWNLIGHT;
    const grade = grid.colorGrade || scene.colorGrade;
    _spawnCeilingGrid( world, scene, width, depth, height, rows, cols, fixture, grade, options.seed || 0 );
  }

  // Wall-wash strips on the two side walls.
  if ( options.wallWash !== false ) {
    const ww = options.wallWash || {};
    const count = ww.count !== undefined ? ww.count : 3;
    const fixture = ww.fixture || FIXTURES.WALL_WASHER;
    const grade = ww.colorGrade || scene.colorGrade;
    _spawnWallWash( world, scene, width, depth, height, count, fixture, grade );
  }

  // Optional accent spots aimed at specific targets.
  if ( options.accentSpots !== undefined && Array.isArray( options.accentSpots ) ) {
    for ( let i = 0; i < options.accentSpots.length; i ++ ) {
      const spec = options.accentSpots[ i ];
      const fixture = spec.fixture || FIXTURES.ACCENT_SPOT;
      const grade = spec.colorGrade || scene.colorGrade;
      _spawnAccentSpot( world, scene, height, spec.target, fixture, grade );
    }
  }

  // Optional pendant lights.
  if ( options.pendants !== undefined && Array.isArray( options.pendants ) ) {
    for ( let i = 0; i < options.pendants.length; i ++ ) {
      const spec = options.pendants[ i ];
      const fixture = spec.fixture || FIXTURES.PENDANT;
      const grade = spec.colorGrade || scene.colorGrade;
      _spawnPendant( world, scene, spec.position, fixture, grade );
    }
  }

  // Ambient fill.
  const ambientColor = options.ambientFill && options.ambientFill.color !== undefined
    ? options.ambientFill.color
    : scene.colorGrade.ambientColor;
  const ambientIntensity = options.ambientFill && options.ambientFill.intensity !== undefined
    ? options.ambientFill.intensity
    : scene.colorGrade.ambientIntensity;
  scene.ambient = {
    isAmbientLight: true,
    isCompatLight: true,
    color: new Color( ambientColor ),
    intensity: ambientIntensity,
    userData: {},
    name: 'archvizAmbient',
    position: [ 0, height * 0.5, 0 ],
    dispose() {},
  };

  // Directional sun fill.
  if ( options.sunIntensity !== undefined || options.sunDirection !== undefined ) {
    scene.sun = _spawnSun( world, scene, options.sunDirection, options.sunIntensity );
  }

  return scene;
}

// ---------------------------------------------------------------------------
// 5. Room shell — floor / walls / ceiling as ECS entities
// ---------------------------------------------------------------------------

/**
 * Spawn the room shell as ECS entities. Uses the chat's `Transform` and
 * `Material` components so this integrates cleanly with 015_World's
 * systems and serialization.
 *
 * Returns an object with the entity ids of each surface.
 */
function _spawnRoomShell( world, width, depth, height ) {
  const ids = {};

  function spawnPlane( name, pos, scale, color ) {
    const eid = World.spawnEntity( world, {
      transform: {
        px: pos[ 0 ], py: pos[ 1 ], pz: pos[ 2 ],
        rx: 0, ry: 0, rz: 0, rw: 1,
        sx: scale[ 0 ], sy: scale[ 1 ], sz: scale[ 2 ],
      },
      material: {
        baseColor: [ color.r, color.g, color.b ],
        metalness: 0.0,
        roughness: 0.9,
        envMapIntensity: 0.4,
        renderStyle: 0,
      },
      renderable: true,
      static: true,
    } );
    ids[ name ] = eid;
    return eid;
  }

  const floorColor = new Color( 0x2a2822 );
  const wallColor = new Color( 0xd8d2c8 );
  const ceilingColor = new Color( 0xf0ece4 );

  spawnPlane( 'floor',   [ 0, 0, 0 ], [ width, 0.05, depth ], floorColor );
  spawnPlane( 'ceiling', [ 0, height, 0 ], [ width, 0.05, depth ], ceilingColor );
  spawnPlane( 'wallN',   [ 0, height * 0.5, - depth * 0.5 ], [ width, height, 0.1 ], wallColor );
  spawnPlane( 'wallS',   [ 0, height * 0.5,   depth * 0.5 ], [ width, height, 0.1 ], wallColor );
  spawnPlane( 'wallE',   [ width * 0.5, height * 0.5, 0 ], [ 0.1, height, depth ], wallColor );
  spawnPlane( 'wallW',   [ - width * 0.5, height * 0.5, 0 ], [ 0.1, height, depth ], wallColor );

  return ids;
}

// ---------------------------------------------------------------------------
// 6. Ceiling downlight grid
// ---------------------------------------------------------------------------

function _spawnCeilingGrid( world, scene, width, depth, height, rows, cols, fixture, colorGrade, seed ) {
  const marginX = width * 0.2;
  const marginZ = depth * 0.2;
  const stepX = ( width - marginX * 2 ) / Math.max( 1, cols - 1 );
  const stepZ = ( depth - marginZ * 2 ) / Math.max( 1, rows - 1 );

  const grade = colorGrade || COLOR_GRADES.NEUTRAL_DAYLIGHT;
  const jitter = Noise.createNoise3D( _makeRng( seed + 1 ) );

  for ( let r = 0; r < rows; r ++ ) {
    for ( let c = 0; c < cols; c ++ ) {
      const x = - width * 0.5 + marginX + c * stepX;
      const z = - depth * 0.5 + marginZ + r * stepZ;
      const y = height - 0.02;

      // Small procedural jitter for the color grade, to avoid a perfectly
      // uniform grid.
      const hueJitter = jitter( x * 0.1, 0, z * 0.1 ) * 0.05;
      const warmShift = ( 1 + hueJitter ) * grade.exposure;

      const handle = _spawnFixture( world, fixture, {
        position: [ x, y, z ],
        target: [ x, 0, z ],
        colorGrade: grade,
        intensity: fixture.intensity * warmShift,
      } );
      scene.lights.push( handle.light );
      scene.fixtures.push( handle );
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Wall-wash strips
// ---------------------------------------------------------------------------

function _spawnWallWash( world, scene, width, depth, height, count, fixture, colorGrade ) {
  const grade = colorGrade || COLOR_GRADES.NEUTRAL_DAYLIGHT;
  const stepZ = depth / ( count + 1 );

  // East wall washer (points at the east wall).
  for ( let i = 0; i < count; i ++ ) {
    const z = - depth * 0.5 + stepZ * ( i + 1 );
    const handle = _spawnFixture( world, fixture, {
      position: [ width * 0.5 - 0.3, height - 0.05, z ],
      target: [ width * 0.5, height * 0.5, z ],
      colorGrade: grade,
      intensity: fixture.intensity * grade.exposure,
    } );
    scene.lights.push( handle.light );
    scene.fixtures.push( handle );
  }

  // West wall washer (points at the west wall).
  for ( let i = 0; i < count; i ++ ) {
    const z = - depth * 0.5 + stepZ * ( i + 1 );
    const handle = _spawnFixture( world, fixture, {
      position: [ - width * 0.5 + 0.3, height - 0.05, z ],
      target: [ - width * 0.5, height * 0.5, z ],
      colorGrade: grade,
      intensity: fixture.intensity * grade.exposure,
    } );
    scene.lights.push( handle.light );
    scene.fixtures.push( handle );
  }
}

// ---------------------------------------------------------------------------
// 8. Accent spots and pendants
// ---------------------------------------------------------------------------

function _spawnAccentSpot( world, scene, height, target, fixture, colorGrade ) {
  const grade = colorGrade || COLOR_GRADES.NEUTRAL_DAYLIGHT;
  const handle = _spawnFixture( world, fixture, {
    position: [ target[ 0 ], height - 0.05, target[ 2 ] + 0.2 ],
    target,
    colorGrade: grade,
    intensity: fixture.intensity * grade.exposure,
  } );
  scene.lights.push( handle.light );
  scene.fixtures.push( handle );
}

function _spawnPendant( world, scene, position, fixture, colorGrade ) {
  const grade = colorGrade || COLOR_GRADES.NEUTRAL_DAYLIGHT;
  const handle = _spawnFixture( world, fixture, {
    position: [ position[ 0 ], position[ 1 ], position[ 2 ] ],
    target: [ position[ 0 ], 0, position[ 2 ] ],
    colorGrade: grade,
    intensity: fixture.intensity * grade.exposure,
  } );
  scene.lights.push( handle.light );
  scene.fixtures.push( handle );
}

// ---------------------------------------------------------------------------
// 9. Fixture spawning — the shared path
// ---------------------------------------------------------------------------

/**
 * Spawn a single archviz fixture into the world. Uses 071_IESLighting's
 * `createIESEntity` and then applies the color grade and chromaticity on the
 * resulting light. Returns `{ eid, light, parsedIES, fixture }`.
 */
function _spawnFixture( world, fixture, options ) {
  const parsedIES = getParsedIES( fixture.iesProfile );
  const position = options.position || [ 0, 0, 0 ];
  const target = options.target || [ position[ 0 ], 0, position[ 2 ] ];
  const grade = options.colorGrade || COLOR_GRADES.NEUTRAL_DAYLIGHT;
  const intensity = options.intensity !== undefined ? options.intensity : fixture.intensity;

  const { eid, light } = createIESEntity( world, parsedIES, {
    intensity,
    color: grade.baseColor,
    tintColor: grade.tintColor,
    tintFactor: grade.tintFactor,
    chromatization: grade.chromatization * ( fixture.chromaticity || 1 ),
    colorTemp: 6500,
    angle: fixture.angle,
    penumbra: fixture.penumbra,
    distance: fixture.distance,
    decay: fixture.decay,
    position,
    target,
  } );

  // Re-apply the fixture's IES texture (createIESEntity already sets it via
  // iesToSpotLight, but if the fixture is not a spot we swap the builder).
  if ( fixture.lightType === 'point' ) {
    const pointLight = iesToPointLight( parsedIES, {
      color: grade.baseColor,
      distance: fixture.distance,
      decay: fixture.decay,
    } );
    pointLight.userData = light.userData;
    pointLight.position = light.position;
    light = pointLight;
  }

  // Configure shadow settings in the light's userData so downstream sync
  // systems can enable them.
  light.userData.castShadow = fixture.castShadow === true;
  light.userData.targetPosition = [ target[ 0 ], target[ 1 ], target[ 2 ] ];

  return { eid, light, parsedIES, fixture, target };
}

// ---------------------------------------------------------------------------
// 10. Sun fill
// ---------------------------------------------------------------------------

function _spawnSun( world, scene, direction, intensity ) {
  const dir = direction || [ - 0.3, - 1, - 0.4 ];
  const light = {
    isDirectionalLight: true,
    isCompatLight: true,
    color: new Color( 0xfff4e0 ),
    intensity: intensity !== undefined ? intensity : 1.5,
    userData: {},
    name: 'archvizSun',
    position: [ 0, 0, 0 ],
    target: { position: [ dir[ 0 ], dir[ 1 ], dir[ 2 ] ] },
    dispose() {},
  };
  return light;
}

// ---------------------------------------------------------------------------
// 11. Color grading presets applied to the rig
// ---------------------------------------------------------------------------

/**
 * Re-grade every light in the scene with a new color grade. Zero-allocation
 * — updates the `RGB` SoA store once and lets the perceptual pipeline
 * recompute. Safe to call every frame if you want a time-of-day loop.
 */
export function applyColorGrade( scene, colorGrade ) {
  const world = scene.world;
  const RGB = world.components.RGB;
  if ( ! RGB ) return;

  const grade = colorGrade || scene.colorGrade;
  scene.colorGrade = grade;

  for ( let i = 0; i < scene.fixtures.length; i ++ ) {
    const handle = scene.fixtures[ i ];
    const eid = handle.eid;
    const light = handle.light;

    // Write the grade's base color into the SoA store for this light.
    _colorToRGB( grade.baseColor, RGB, eid );

    // Sync metadata so the color system picks up tint / chromaticity.
    const runtime = world.components.IESRuntime;
    if ( runtime ) {
      runtime.tintFactor[ eid ] = grade.tintFactor;
      runtime.chromatization[ eid ] = grade.chromatization * ( handle.fixture.chromaticity || 1 );
      runtime.intensity[ eid ] = handle.fixture.intensity * grade.exposure;
    }

    // If a tint color exists, update the light's userData so the color system
    // can use it.
    if ( light.userData ) {
      light.userData.tintColor = new Color( grade.tintColor );
    }
  }
}

function _colorToRGB( hex, RGB, eid ) {
  const c = new Color( hex );
  // Color stores in working color space (linear-sRGB by default).
  RGB.r[ eid ] = c.r;
  RGB.g[ eid ] = c.g;
  RGB.b[ eid ] = c.b;
  RGB.a[ eid ] = 1;
}

// ---------------------------------------------------------------------------
// 12. Time-of-day day-cycle system
// ---------------------------------------------------------------------------

/**
 * A simple day-cycle system that blends between color grades over a
 * configurable time. Registers via 017_Systems. Not enabled by default —
 * call `registerArchvizDayCycleSystem(world, scene)` to attach it.
 */
export function createArchvizDayCycleSystem( scene, options = {} ) {
  const presets = options.presets || [ COLOR_GRADES.COOL_MORNING, COLOR_GRADES.NEUTRAL_DAYLIGHT, COLOR_GRADES.WARM_EVENING ];
  const durationSeconds = options.durationSeconds !== undefined ? options.durationSeconds : 60;
  let elapsed = 0;

  return function archvizDayCycleSystem( world, dt ) {
    elapsed += dt;
    const phase = ( elapsed % durationSeconds ) / durationSeconds;
    const t = phase * ( presets.length - 1 );
    const i = Math.min( Math.floor( t ), presets.length - 2 );
    const f = t - i;
    const grade = _blendGrades( presets[ i ], presets[ i + 1 ], f );
    applyColorGrade( scene, grade );
    return world;
  };
}

function _blendGrades( a, b, t ) {
  return {
    name: 'blended',
    baseColor: _blendHex( a.baseColor, b.baseColor, t ),
    tintColor: _blendHex( a.tintColor, b.tintColor, t ),
    tintFactor: lerp( a.tintFactor, b.tintFactor, t ),
    chromatization: lerp( a.chromatization, b.chromatization, t ),
    exposure: lerp( a.exposure, b.exposure, t ),
    ambientColor: _blendHex( a.ambientColor, b.ambientColor, t ),
    ambientIntensity: lerp( a.ambientIntensity, b.ambientIntensity, t ),
  };
}

function _blendHex( a, b, t ) {
  const ar = ( a >> 16 ) & 0xff, ag = ( a >> 8 ) & 0xff, ab = a & 0xff;
  const br = ( b >> 16 ) & 0xff, bg = ( b >> 8 ) & 0xff, bb = b & 0xff;
  const r = Math.round( lerp( ar, br, t ) );
  const g = Math.round( lerp( ag, bg, t ) );
  const bl = Math.round( lerp( ab, bb, t ) );
  return ( r << 16 ) | ( g << 8 ) | bl;
}

// ---------------------------------------------------------------------------
// 13. System registration helper
// ---------------------------------------------------------------------------

/**
 * Register all the standard archviz lighting systems on the scene's world.
 * Call once after `createArchvizScene`.
 */
export function registerArchvizSystems( scene, options = {} ) {
  const world = scene.world;
  const { IESRuntime, RGB } = world.components;
  if ( ! IESRuntime || ! RGB ) {
    throw new Error( 'registerArchvizSystems: scene.world must come from createArchvizScene.' );
  }

  const scratch = createPerceptualScratch( world.__maxEntities || MAX_IES_ENTITIES );

  // IES setup — keeps lights rebased to the floating origin.
  Systems.registerSystem(
    world,
    'archvizIESSetup',
    iesSetupSystem( world.components.IESMeta, IESRuntime, scene.lights ),
    ECS.PRIORITY.TRANSFORM,
    PERFORMANCE.RENDER_BUDGET_MS * 0.25
  );

  // IES sync — pulls runtime intensity + position into the light objects.
  Systems.registerSystem(
    world,
    'archvizIESSync',
    iesSyncSystem( IESRuntime, scene.lights ),
    ECS.PRIORITY.RENDER - 1,
    PERFORMANCE.RENDER_BUDGET_MS * 0.25
  );

  // IES color — applies tint + chromatization to each light's color.
  Systems.registerSystem(
    world,
    'archvizIESColor',
    iesColorSystem( IESRuntime, RGB, scratch, scene.lights ),
    ECS.PRIORITY.RENDER - 2,
    PERFORMANCE.RENDER_BUDGET_MS * 0.5
  );

  // Optional day cycle.
  if ( options.dayCycle === true ) {
    Systems.registerSystem(
      world,
      'archvizDayCycle',
      createArchvizDayCycleSystem( scene, options.dayCycleOptions ),
      ECS.PRIORITY.TRANSFORM + 1,
      PERFORMANCE.RENDER_BUDGET_MS * 0.1
    );
  }
}

// ---------------------------------------------------------------------------
// 14. Floating-origin awareness
// ---------------------------------------------------------------------------

/**
 * Rebase the entire archviz scene to a new floating origin. Updates the
 * absolute position of every light and re-syncs the local position so the
 * scene stays stable at galactic scale.
 */
export function rebaseArchvizScene( scene, x, y, z ) {
  const oldOrigin = getOrigin();
  const deltaX = x - oldOrigin[ 0 ];
  const deltaY = y - oldOrigin[ 1 ];
  const deltaZ = z - oldOrigin[ 2 ];
  if ( deltaX === 0 && deltaY === 0 && deltaZ === 0 ) return;

  rebaseOrigin( deltaX, deltaY, deltaZ );

  for ( let i = 0; i < scene.fixtures.length; i ++ ) {
    const light = scene.fixtures[ i ].light;
    if ( light.userData && light.userData.absPos ) {
      const abs = light.userData.absPos;
      light.position[ 0 ] = abs[ 0 ] - x;
      light.position[ 1 ] = abs[ 1 ] - y;
      light.position[ 2 ] = abs[ 2 ] - z;
    }
  }
}

// ---------------------------------------------------------------------------
// 15. Utility helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if any light is currently overlapping a given point, using
 * the light's effective radius (from `distance`). Useful for context-awareness
 * pipelines.
 */
export function lightsAffectingPoint( scene, x, y, z, out ) {
  const result = out || [];
  result.length = 0;
  for ( let i = 0; i < scene.lights.length; i ++ ) {
    const light = scene.lights[ i ];
    const r = light.distance || light.range || Infinity;
    if ( r === Infinity ) { result.push( light ); continue; }
    const dx = light.position[ 0 ] - x;
    const dy = light.position[ 1 ] - y;
    const dz = light.position[ 2 ] - z;
    if ( dx * dx + dy * dy + dz * dz <= r * r ) result.push( light );
  }
  return result;
}

/**
 * Returns the estimated total luminous flux for the whole scene. Useful for
 * adaptive exposure and analytics.
 */
export function estimateSceneFlux( scene ) {
  let flux = 0;
  for ( let i = 0; i < scene.fixtures.length; i ++ ) {
    const handle = scene.fixtures[ i ];
    flux += integrateCandela( handle.parsedIES );
  }
  return flux;
}

function _makeRng( seed ) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = ( a + 0x6D2B79F5 ) | 0;
    let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
    t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
    return ( ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296 );
  };
}

// ---------------------------------------------------------------------------
// 16. Default export
// ---------------------------------------------------------------------------

export default {
  // Profiles
  IES_PROFILES,
  IES_DOWNLIGHT_24,
  IES_WALLWASHER,
  IES_BATWING,
  IES_NARROW_SPOT_10,
  IES_WIDE_SPOT_60,
  IES_PENDANT,
  getParsedIES,

  // Fixtures + color grades
  FIXTURES,
  COLOR_GRADES,

  // Scene
  createArchvizScene,
  applyColorGrade,
  registerArchvizSystems,
  rebaseArchvizScene,
  lightsAffectingPoint,
  estimateSceneFlux,
  createArchvizDayCycleSystem,

  // Re-exports
  createIESWorld,
  createIESEntity,
  iesToSpotLight,
  iesToPointLight,
  iesToDataTexture,
  integrateCandela,
  generateIsotropicIES,
  iesSetupSystem,
  iesSyncSystem,
  iesColorSystem,
  Color,
  ColorManagement,
  PerceptualSoA,
  createPerceptualScratch,
  rgbStore,
  tintStore,
  registerSystem: Systems.registerSystem,
};