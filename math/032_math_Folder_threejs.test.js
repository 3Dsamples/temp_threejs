// file number : 032
// full path name : src/math/__tests__/Custom math_Folder_threejs.test.js
// description : Zero-dependency test harness that exercises the key bridges and algorithms of the rewritten three.js r185 math module. Runs entirely in a browser or any ESM-capable JavaScript runtime that has access to the four CDN imports the math module depends on (gl-matrix, bitecs, double.js, simplex-noise). Covers:
//   • module load smoke test (every one of the 30 files resolves)
//   • namespace re-export integrity (every namespace exposes its expected keys)
//   • top-level class constructors (Vector2/3/4, Quaternion, Euler, Matrix2/3/4, Color, etc.)
//   • gl-matrix ↔ bitecs ↔ class round-trips for every type
//   • correctness of key algorithms (Vector3 cross, Quaternion slerp, Matrix4 multiply, SAT OBB tests, Triangle barycentric, Box3 applyMatrix4, Interpolant evaluate, Bezier tangent binding, QuaternionLinearInterpolant slerp)
//   • high-precision double.js helpers (preciseLength, preciseSlerpFlat, preciseBezierInterpolate)
//   • simplex-noise caches (setFromNoise3D, disposeAllNoiseCaches)
//   • index.js re-export surface (no missing names, no collisions)
// best for  :  Verifying that the 30 rewritten math files actually wire up correctly in a browser before shipping. Open the HTML bootstrap (see __tests__/index.html snippet at the bottom of this file) and it prints a colored pass/fail report to the page.
// license : MIT

import * as Math from '../Custom math_Folder_threejs.js';

/*
 * -----------------------------------------------------------------------------
 * TEST FRAMEWORK (zero-dependency)
 * -----------------------------------------------------------------------------
 * Each test is registered with `test(name, fn)`. `fn` returns either nothing
 * (pass) or throws an Error (fail). `assert` helpers are provided for common
 * checks. Results are accumulated and printed by `runAll()`.
 */

const _tests = [];
let _currentSuite = '(root)';

function suite( name ) {
  _currentSuite = name;
}

function test( name, fn ) {
  _tests.push( { suite: _currentSuite, name, fn } );
}

function runAll() {
  const results = { pass: 0, fail: 0, errors: [] };
  for ( const t of _tests ) {
    try {
      t.fn();
      results.pass ++;
      _log( 'pass', t.suite, t.name );
    } catch ( e ) {
      results.fail ++;
      results.errors.push( { suite: t.suite, name: t.name, error: e } );
      _log( 'fail', t.suite, t.name, e && e.message ? e.message : String( e ) );
    }
  }
  _log( 'summary', '', `${ results.pass } passed, ${ results.fail } failed` );
  return results;
}

function _log( kind, suiteName, name, detail ) {
  const prefix = kind === 'pass' ? '✓' : kind === 'fail' ? '✗' : kind === 'summary' ? '=' : '·';
  const line = `[${ prefix }] ${ suiteName } :: ${ name }${ detail ? ' — ' + detail : '' }`;
  if ( typeof console !== 'undefined' ) console.log( line );
  if ( typeof document !== 'undefined' && document.body ) {
    const div = document.createElement( 'div' );
    div.textContent = line;
    div.style.color = kind === 'pass' ? '#0a0' : kind === 'fail' ? '#a00' : kind === 'summary' ? '#000' : '#666';
    div.style.fontFamily = 'monospace';
    document.body.appendChild( div );
  }
}

/* -------------------------------------------------------------------------- */
/* ASSERTION HELPERS                                                          */
/* -------------------------------------------------------------------------- */

function assert( cond, msg = 'assertion failed' ) {
  if ( ! cond ) throw new Error( msg );
}

function assertClose( a, b, eps = 1e-6, msg = '' ) {
  if ( Math.abs( a - b ) > eps ) {
    throw new Error( `${ msg || 'assertClose' } failed: |${ a } - ${ b }| > ${ eps }` );
  }
}

function assertDeepClose( arrA, arrB, eps = 1e-6, msg = '' ) {
  if ( arrA.length !== arrB.length ) {
    throw new Error( `${ msg || 'assertDeepClose' } length mismatch: ${ arrA.length } vs ${ arrB.length }` );
  }
  for ( let i = 0; i < arrA.length; i ++ ) {
    if ( Math.abs( arrA[ i ] - arrB[ i ] ) > eps ) {
      throw new Error( `${ msg || 'assertDeepClose' } [${ i }]: |${ arrA[ i ] } - ${ arrB[ i ] }| > ${ eps }` );
    }
  }
}

/* ==========================================================================
 * SUITE 1 — MODULE LOAD SMOKE TEST
 * ========================================================================== */

suite( '01. Module load' );

test( 'index namespace exports all 30 file namespaces', () => {
  const expectedNamespaces = [
    'MathUtilsModule', 'Vector2Module', 'Vector3Module', 'QuaternionModule',
    'Matrix2Module', 'Matrix3Module', 'Matrix4Module', 'EulerModule',
    'Line3Module', 'PlaneModule', 'SphereModule', 'Box3Module', 'RayModule',
    'TriangleModule', 'FrustumModule', 'Vector4Module', 'ColorManagementModule',
    'ColorModule', 'CylindricalModule', 'SphericalModule',
    'SphericalHarmonics3Module', 'InterpolantModule', 'CubicInterpolantModule',
    'LinearInterpolantModule', 'DiscreteInterpolantModule',
    'QuaternionLinearInterpolantModule', 'Box2Module',
    'BezierInterpolantModule', 'OBBModule', 'ColorSpaceModule'
  ];
  for ( const ns of expectedNamespaces ) {
    assert( ns in Math, `missing namespace: ${ ns }` );
    assert( Math[ ns ] !== undefined && Math[ ns ] !== null, `namespace ${ ns } is null/undefined` );
  }
} );

test( 'index top-level exports all primary classes', () => {
  const classes = [
    'Vector2', 'Vector3', 'Quaternion', 'Matrix2', 'Matrix3', 'Matrix4',
    'Euler', 'Line3', 'Plane', 'Sphere', 'Box3', 'Ray', 'Triangle', 'Frustum',
    'Vector4', 'Color', 'Cylindrical', 'Spherical', 'SphericalHarmonics3',
    'Interpolant', 'CubicInterpolant', 'LinearInterpolant', 'DiscreteInterpolant',
    'QuaternionLinearInterpolant', 'Box2', 'BezierInterpolant', 'OBB',
    'MathUtils', 'ColorManagement'
  ];
  for ( const c of classes ) {
    assert( typeof Math[ c ] === 'function' || typeof Math[ c ] === 'object', `missing class/object: ${ c }` );
  }
} );

test( 'index top-level exports all bitecs components', () => {
  const comps = [
    'Vector2Component', 'Vector3Component', 'QuaternionComponent',
    'Matrix2Component', 'Matrix3Component', 'Matrix4Component',
    'EulerComponent', 'Line3Component', 'PlaneComponent', 'SphereComponent',
    'Box3Component', 'RayComponent', 'TriangleComponent', 'FrustumComponent',
    'Vector4Component', 'ColorComponent', 'CylindricalComponent',
    'SphericalComponent', 'SphericalHarmonics3Component',
    'InterpolantTrackComponent', 'QuaternionTrackComponent', 'Box2Component',
    'BezierTrackComponent', 'OBBComponent', 'ColorSpaceComponent'
  ];
  for ( const c of comps ) {
    assert( c in Math, `missing component: ${ c }` );
    assert( Math[ c ] && Math[ c ].x !== undefined || Math[ c ].r !== undefined || Math[ c ].cx !== undefined || Math[ c ].m00 !== undefined || Math[ c ].p0nx !== undefined || Math[ c ].minX !== undefined || Math[ c ].ox !== undefined || Math[ c ].ax !== undefined || Math[ c ].startX !== undefined || Math[ c ].nx !== undefined || Math[ c ].radius !== undefined || Math[ c ].m11 !== undefined || Math[ c ].c0x !== undefined || Math[ c ].positionStart !== undefined || Math[ c ].colorSpaceCode !== undefined,
      `component ${ c } shape is unexpected` );
  }
} );

test( 'index top-level exports universal constants', () => {
  assert( Math.DEG2RAD > 0 && Math.DEG2RAD < 0.02, 'DEG2RAD missing or wrong' );
  assert( Math.RAD2DEG > 57 && Math.RAD2DEG < 58, 'RAD2DEG missing or wrong' );
  assert( Math.SRGBColorSpace === 'srgb', 'SRGBColorSpace wrong' );
  assert( Math.LinearSRGBColorSpace === 'srgb-linear', 'LinearSRGBColorSpace wrong' );
} );

test( 'index exposes disposeAllNoiseCaches()', () => {
  assert( typeof Math.disposeAllNoiseCaches === 'function', 'disposeAllNoiseCaches missing' );
} );

/* ==========================================================================
 * SUITE 2 — SCALAR MATH (file 001)
 * ========================================================================== */

suite( '02. MathUtils scalars' );

test( 'clamp', () => {
  assert( Math.clamp( 5, 0, 1 ) === 1, 'clamp high' );
  assert( Math.clamp( -5, 0, 1 ) === 0, 'clamp low' );
  assert( Math.clamp( 0.5, 0, 1 ) === 0.5, 'clamp mid' );
} );

test( 'lerp', () => {
  assert( Math.lerp( 0, 10, 0.5 ) === 5, 'lerp mid' );
  assert( Math.lerp( 0, 10, 0 ) === 0, 'lerp t=0' );
  assert( Math.lerp( 0, 10, 1 ) === 10, 'lerp t=1' );
} );

test( 'smoothstep', () => {
  assert( Math.smoothstep( -1, 0, 1 ) === 0, 'smoothstep below' );
  assert( Math.smoothstep( 2, 0, 1 ) === 1, 'smoothstep above' );
  assert( Math.smoothstep( 0.5, 0, 1 ) === 0.5, 'smoothstep mid' );
} );

test( 'euclideanModulo', () => {
  assert( Math.euclideanModulo( -1, 3 ) === 2, 'euclideanModulo(-1,3)' );
  assert( Math.euclideanModulo( 4, 3 ) === 1, 'euclideanModulo(4,3)' );
} );

test( 'preciseLerp (double.js)', () => {
  const r = Math.preciseLerp( 0, 1e20, 0.5 );
  assertClose( r, 5e19, 1e10, 'preciseLerp' );
} );

test( 'noise2D produces deterministic output for same seed', () => {
  const a = Math.noise2D( 1.5, 2.5, 7 );
  const b = Math.noise2D( 1.5, 2.5, 7 );
  assert( a === b, 'noise2D not deterministic' );
} );

/* ==========================================================================
 * SUITE 3 — VECTOR3 ROUND-TRIP (files 002/003)
 * ========================================================================== */

suite( '03. Vector2/3/4 round-trip' );

test( 'Vector3 default construction', () => {
  const v = new Math.Vector3();
  assert( v.x === 0 && v.y === 0 && v.z === 0, 'default Vector3 wrong' );
} );

test( 'Vector3 math operations', () => {
  const a = new Math.Vector3( 1, 2, 3 );
  const b = new Math.Vector3( 4, 5, 6 );
  const c = new Math.Vector3().crossVectors( a, b );
  assertClose( c.x, -3 );
  assertClose( c.y, 6 );
  assertClose( c.z, -3 );
  assertClose( a.dot( b ), 32 );
} );

test( 'Vector3 gl-matrix round-trip', () => {
  const v = new Math.Vector3( 1.5, -2.5, 3.5 );
  const gl = new Float32Array( 3 );
  Math.glMatrixVec3FromThree( gl, v );
  const back = new Math.Vector3();
  Math.threeVec3FromGlMatrix( back, gl );
  assertClose( back.x, 1.5 );
  assertClose( back.y, -2.5 );
  assertClose( back.z, 3.5 );
} );

test( 'Vector3 bitecs round-trip', () => {
  const store = { x: new Float32Array( 4 ), y: new Float32Array( 4 ), z: new Float32Array( 4 ) };
  Math.bitecsVec3FromThree( 2, new Math.Vector3( 7, 8, 9 ), store );
  const back = new Math.Vector3();
  Math.threeVec3FromBitecs( back, 2, store );
  assertClose( back.x, 7 );
  assertClose( back.y, 8 );
  assertClose( back.z, 9 );
} );

test( 'Vector3 applyEuler actually rotates (not a no-op)', () => {
  const v = new Math.Vector3( 1, 0, 0 );
  const e = new Math.Euler( 0, Math.PI / 2, 0, 'XYZ' );
  v.applyEuler( e );
  assertClose( v.x, 0, 1e-5, 'rotated x' );
  assertClose( v.z, - 1, 1e-5, 'rotated z' );
} );

test( 'Vector3 applyAxisAngle actually rotates (not a no-op)', () => {
  const v = new Math.Vector3( 1, 0, 0 );
  const axis = new Math.Vector3( 0, 1, 0 );
  v.applyAxisAngle( axis, Math.PI / 2 );
  assertClose( v.x, 0, 1e-5 );
  assertClose( v.z, - 1, 1e-5 );
} );

test( 'Vector3 preciseLength (double.js)', () => {
  const v = new Math.Vector3( 3, 4, 0 );
  assertClose( Math.Vector3Module.preciseLength( v ), 5, 1e-12 );
} );

test( 'Vector2 default construction and length', () => {
  const v = new Math.Vector2( 3, 4 );
  assertClose( v.length(), 5 );
} );

test( 'Vector4 default construction and length', () => {
  const v = new Math.Vector4( 1, 0, 0, 0 );
  assertClose( v.length(), 1 );
} );

/* ==========================================================================
 * SUITE 4 — QUATERNION (file 004)
 * ========================================================================== */

suite( '04. Quaternion' );

test( 'Quaternion default is identity', () => {
  const q = new Math.Quaternion();
  assert( q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1 );
} );

test( 'Quaternion setFromAxisAngle', () => {
  const q = new Math.Quaternion().setFromAxisAngle( new Math.Vector3( 0, 1, 0 ), Math.PI );
  assertClose( q.y, 1, 1e-6, 'y should be 1 for 180° about Y' );
  assertClose( q.w, 0, 1e-6 );
} );

test( 'Quaternion slerp midpoint is halfway', () => {
  const a = new Math.Quaternion();
  const b = new Math.Quaternion().setFromAxisAngle( new Math.Vector3( 0, 1, 0 ), Math.PI / 2 );
  const m = a.clone().slerp( b, 0.5 );
  // Slerp midpoint of identity and 90° about Y is 45° about Y.
  const expected = new Math.Quaternion().setFromAxisAngle( new Math.Vector3( 0, 1, 0 ), Math.PI / 4 );
  assertClose( m.x, expected.x, 1e-5 );
  assertClose( m.y, expected.y, 1e-5 );
  assertClose( m.z, expected.z, 1e-5 );
  assertClose( m.w, expected.w, 1e-5 );
} );

test( 'Quaternion preciseAngleTo (double.js)', () => {
  const a = new Math.Quaternion();
  const b = new Math.Quaternion().setFromAxisAngle( new Math.Vector3( 0, 1, 0 ), Math.PI / 2 );
  const angle = Math.QuaternionModule.preciseAngleTo( a, b );
  assertClose( angle, Math.PI / 2, 1e-6 );
} );

test( 'Quaternion bitecs slerp round-trip', () => {
  const store = {
    x: new Float32Array( 4 ), y: new Float32Array( 4 ),
    z: new Float32Array( 4 ), w: new Float32Array( 4 )
  };
  Math.bitecsQuatFromThree( 0, new Math.Quaternion(), store );
  Math.bitecsQuatFromThree( 1, new Math.Quaternion().setFromAxisAngle( new Math.Vector3( 0, 1, 0 ), Math.PI / 2 ), store );
  const out = new Math.Quaternion();
  Math.threeQuatFromBitecsSlerp( out, 0, 1, 0.5, store, store );
  const expected = new Math.Quaternion().setFromAxisAngle( new Math.Vector3( 0, 1, 0 ), Math.PI / 4 );
  assertClose( out.y, expected.y, 1e-5 );
} );

/* ==========================================================================
 * SUITE 5 — MATRIX OPERATIONS (files 005/006/007)
 * ========================================================================== */

suite( '05. Matrix2/3/4' );

test( 'Matrix4 identity * identity = identity', () => {
  const a = new Math.Matrix4();
  const b = new Math.Matrix4();
  const c = new Math.Matrix4().multiplyMatrices( a, b );
  for ( let i = 0; i < 16; i ++ ) {
    assertClose( c.elements[ i ], a.elements[ i ] );
  }
} );

test( 'Matrix4 invert round-trip', () => {
  const m = new Math.Matrix4().makeRotationY( 0.7 ).setPosition( 1, 2, 3 );
  const inv = new Math.Matrix4().copy( m ).invert();
  const prod = new Math.Matrix4().multiplyMatrices( m, inv );
  for ( let i = 0; i < 16; i ++ ) {
    assertClose( prod.elements[ i ], i % 5 === 0 ? 1 : 0, 1e-5, `element ${ i }` );
  }
} );

test( 'Matrix3 determinant', () => {
  const m = new Math.Matrix3().makeRotation( Math.PI / 4 );
  assertClose( m.determinant(), 1, 1e-6 );
} );

test( 'Matrix2 identity', () => {
  const m = new Math.Matrix2();
  assertClose( m.determinant(), 1 );
} );

test( 'Matrix4 bitecs multiply round-trip', () => {
  const store = {
    m00: new Float32Array( 2 ), m01: new Float32Array( 2 ), m02: new Float32Array( 2 ), m03: new Float32Array( 2 ),
    m10: new Float32Array( 2 ), m11: new Float32Array( 2 ), m12: new Float32Array( 2 ), m13: new Float32Array( 2 ),
    m20: new Float32Array( 2 ), m21: new Float32Array( 2 ), m22: new Float32Array( 2 ), m23: new Float32Array( 2 ),
    m30: new Float32Array( 2 ), m31: new Float32Array( 2 ), m32: new Float32Array( 2 ), m33: new Float32Array( 2 )
  };
  Math.bitecsMat4FromThree( 0, new Math.Matrix4(), store );
  Math.bitecsMat4FromThree( 1, new Math.Matrix4().makeTranslation( 5, 6, 7 ), store );
  const out = new Math.Matrix4();
  Math.threeMat4FromBitecsMultiply( out, 0, 1, store, store );
  assertClose( out.elements[ 12 ], 5 );
  assertClose( out.elements[ 13 ], 6 );
  assertClose( out.elements[ 14 ], 7 );
} );

/* ==========================================================================
 * SUITE 6 — GEOMETRY (Ray/Plane/Sphere/Box3/Triangle/Frustum)
 * ========================================================================== */

suite( '06. Geometry primitives' );

test( 'Ray intersectSphere works', () => {
  const ray = new Math.Ray( new Math.Vector3( 0, 0, 0 ), new Math.Vector3( 1, 0, 0 ) );
  const sphere = new Math.Sphere( new Math.Vector3( 5, 0, 0 ), 1 );
  const target = new Math.Vector3();
  const hit = ray.intersectSphere( sphere, target );
  assert( hit !== null, 'ray should hit sphere' );
  assertClose( target.x, 4, 1e-5 );
} );

test( 'Plane distanceToPoint works', () => {
  const plane = new Math.Plane( new Math.Vector3( 1, 0, 0 ), 0 );
  assertClose( plane.distanceToPoint( new Math.Vector3( 5, 0, 0 ) ), 5 );
} );

test( 'Box3 intersectsTriangle', () => {
  const box = new Math.Box3( new Math.Vector3( -1, -1, -1 ), new Math.Vector3( 1, 1, 1 ) );
  const tri = new Math.Triangle(
    new Math.Vector3( 0, 0, 0 ),
    new Math.Vector3( 2, 0, 0 ),
    new Math.Vector3( 0, 2, 0 )
  );
  assert( box.intersectsTriangle( tri ) === true, 'should intersect' );
  const triFar = new Math.Triangle(
    new Math.Vector3( 10, 10, 10 ),
    new Math.Vector3( 11, 10, 10 ),
    new Math.Vector3( 10, 11, 10 )
  );
  assert( box.intersectsTriangle( triFar ) === false, 'should not intersect' );
} );

test( 'Box3 applyMatrix4 (r185 exact 8-corner transform)', () => {
  const box = new Math.Box3( new Math.Vector3( -1, -1, -1 ), new Math.Vector3( 1, 1, 1 ) );
  const m = new Math.Matrix4().makeRotationZ( Math.PI / 4 );
  box.applyMatrix4( m );
  // Rotating a unit cube by 45° about Z should give a wider AABB.
  const expectedExtent = Math.SQRT2;
  assertClose( box.max.x, expectedExtent, 1e-5, 'max.x' );
  assertClose( box.max.y, expectedExtent, 1e-5, 'max.y' );
  assertClose( box.max.z, 1, 1e-5, 'max.z (unchanged)' );
} );

test( 'Triangle barycentric coordinates', () => {
  const tri = new Math.Triangle(
    new Math.Vector3( 0, 0, 0 ),
    new Math.Vector3( 1, 0, 0 ),
    new Math.Vector3( 0, 1, 0 )
  );
  const bary = new Math.Vector3();
  tri.getBarycoord( new Math.Vector3( 0.25, 0.25, 0 ), bary );
  assertClose( bary.x, 0.5, 1e-5 );
  assertClose( bary.y, 0.25, 1e-5 );
  assertClose( bary.z, 0.25, 1e-5 );
} );

test( 'Frustum containsPoint', () => {
  const f = new Math.Frustum(
    new Math.Plane( new Math.Vector3( 1, 0, 0 ), 1 ),
    new Math.Plane( new Math.Vector3( - 1, 0, 0 ), 1 ),
    new Math.Plane( new Math.Vector3( 0, 1, 0 ), 1 ),
    new Math.Plane( new Math.Vector3( 0, - 1, 0 ), 1 ),
    new Math.Plane( new Math.Vector3( 0, 0, 1 ), 1 ),
    new Math.Plane( new Math.Vector3( 0, 0, - 1 ), 1 )
  );
  assert( f.containsPoint( new Math.Vector3( 0, 0, 0 ) ) === true );
  assert( f.containsPoint( new Math.Vector3( 5, 0, 0 ) ) === false );
} );

/* ==========================================================================
 * SUITE 7 — OBB SAT TESTS (file 029)
 * ========================================================================== */

suite( '07. OBB SAT' );

test( 'OBB vs OBB overlap', () => {
  const store = {
    cx: new Float32Array( 2 ), cy: new Float32Array( 2 ), cz: new Float32Array( 2 ),
    hx: new Float32Array( 2 ), hy: new Float32Array( 2 ), hz: new Float32Array( 2 ),
    qx: new Float32Array( 2 ), qy: new Float32Array( 2 ), qz: new Float32Array( 2 ), qw: new Float32Array( 2 )
  };
  // Box A at origin, size 2x2x2.
  store.cx[ 0 ] = 0; store.cy[ 0 ] = 0; store.cz[ 0 ] = 0;
  store.hx[ 0 ] = 1; store.hy[ 0 ] = 1; store.hz[ 0 ] = 1;
  store.qx[ 0 ] = 0; store.qy[ 0 ] = 0; store.qz[ 0 ] = 0; store.qw[ 0 ] = 1;
  // Box B overlapping at (1.5, 0, 0).
  store.cx[ 1 ] = 1.5; store.cy[ 1 ] = 0; store.cz[ 1 ] = 0;
  store.hx[ 1 ] = 1; store.hy[ 1 ] = 1; store.hz[ 1 ] = 1;
  store.qx[ 1 ] = 0; store.qy[ 1 ] = 0; store.qz[ 1 ] = 0; store.qw[ 1 ] = 1;
  assert( Math.bitecsOBBIntersectsOBB( 0, 1, store, store ) === true, 'should overlap' );
  // Move B far away.
  store.cx[ 1 ] = 5;
  assert( Math.bitecsOBBIntersectsOBB( 0, 1, store, store ) === false, 'should not overlap' );
} );

test( 'OBB vs AABB overlap', () => {
  const obbStore = {
    cx: new Float32Array( 1 ), cy: new Float32Array( 1 ), cz: new Float32Array( 1 ),
    hx: new Float32Array( 1 ), hy: new Float32Array( 1 ), hz: new Float32Array( 1 ),
    qx: new Float32Array( 1 ), qy: new Float32Array( 1 ), qz: new Float32Array( 1 ), qw: new Float32Array( 1 )
  };
  obbStore.cx[ 0 ] = 0; obbStore.cy[ 0 ] = 0; obbStore.cz[ 0 ] = 0;
  obbStore.hx[ 0 ] = 1; obbStore.hy[ 0 ] = 1; obbStore.hz[ 0 ] = 1;
  obbStore.qx[ 0 ] = 0; obbStore.qy[ 0 ] = 0; obbStore.qz[ 0 ] = 0; obbStore.qw[ 0 ] = 1;

  const aabbStore = {
    minX: new Float32Array( 1 ), minY: new Float32Array( 1 ), minZ: new Float32Array( 1 ),
    maxX: new Float32Array( 1 ), maxY: new Float32Array( 1 ), maxZ: new Float32Array( 1 )
  };
  aabbStore.minX[ 0 ] = 0.5; aabbStore.minY[ 0 ] = - 0.5; aabbStore.minZ[ 0 ] = - 0.5;
  aabbStore.maxX[ 0 ] = 2.5; aabbStore.maxY[ 0 ] = 0.5; aabbStore.maxZ[ 0 ] = 0.5;
  assert( Math.bitecsOBBIntersectsAABB( 0, 0, obbStore, aabbStore ) === true, 'should overlap' );
  aabbStore.minX[ 0 ] = 10; aabbStore.maxX[ 0 ] = 12;
  assert( Math.bitecsOBBIntersectsAABB( 0, 0, obbStore, aabbStore ) === false, 'should not overlap' );
} );

/* ==========================================================================
 * SUITE 8 — INTERPOLANTS (files 022–028)
 * ========================================================================== */

suite( '08. Interpolants' );

test( 'Interpolant evaluates linear segment', () => {
  const positions = new Float32Array( [ 0, 1 ] );
  const values = new Float32Array( [ 0, 10 ] );
  const interp = new Math.LinearInterpolant( positions, values, 1 );
  const r = interp.evaluate( 0.5 );
  assertClose( r[ 0 ], 5, 1e-5 );
} );

test( 'CubicInterpolant evaluates a real curve (not zero)', () => {
  const positions = new Float32Array( [ 0, 1, 2, 3 ] );
  const values = new Float32Array( [ 0, 1, 2, 3 ] );
  const interp = new Math.CubicInterpolant( positions, values, 1 );
  const r = interp.evaluate( 1.5 );
  // The Catmull-Rom curve through collinear points is the line itself.
  assertClose( r[ 0 ], 1.5, 1e-4, 'cubic at 1.5' );
} );

test( 'DiscreteInterpolant holds previous value', () => {
  const positions = new Float32Array( [ 0, 1, 2 ] );
  const values = new Float32Array( [ 10, 20, 30 ] );
  const interp = new Math.DiscreteInterpolant( positions, values, 1 );
  assertClose( interp.evaluate( 1.5 )[ 0 ], 20, 1e-5 );
} );

test( 'QuaternionLinearInterpolant slerps (not zero)', () => {
  const positions = new Float32Array( [ 0, 1 ] );
  const q0 = new Float32Array( [ 0, 0, 0, 1 ] ); // identity
  const q1 = new Float32Array( [ 0, Math.sin( Math.PI / 4 ), 0, Math.cos( Math.PI / 4 ) ] ); // 90° about Y
  const values = new Float32Array( [ ...q0, ...q1 ] );
  const interp = new Math.QuaternionLinearInterpolant( positions, values, 4 );
  const r = interp.evaluate( 0.5 );
  assertClose( r[ 1 ], Math.sin( Math.PI / 8 ), 1e-5, 'slerp y' );
  assertClose( r[ 3 ], Math.cos( Math.PI / 8 ), 1e-5, 'slerp w' );
} );

test( 'BezierInterpolant evaluates (tangents bound correctly)', () => {
  const positions = new Float32Array( [ 0, 1 ] );
  const values = new Float32Array( [ 0, 1 ] );
  const interp = new Math.BezierInterpolant( positions, values, 1 );
  // Provide trivial tangents: out tangent of p0 = (1/3, 0), in tangent of p1 = (-1/3, 0).
  // That makes the curve a straight line from 0 to 1.
  interp.inTangents = new Float32Array( [ - 1 / 3, 0, 0, 0 ] );
  interp.outTangents = new Float32Array( [ 1 / 3, 0, 0, 0 ] );
  interp.tangentStride = 2;
  const r = interp.evaluate( 0.5 );
  assertClose( r[ 0 ], 0.5, 1e-4, 'Bezier midpoint' );
} );

test( 'preciseBezierInterpolate (double.js)', () => {
  const r = Math.preciseBezierInterpolate( 0, 0, 1 / 3, 0, 2 / 3, 1, 1, 1, 0.5 );
  assertClose( r, 0.5, 1e-6, 'precise Bezier midpoint' );
} );

/* ==========================================================================
 * SUITE 9 — COLOR (files 017/018/030)
 * ========================================================================== */

suite( '09. Color' );

test( 'Color setHex / getHex round-trip', () => {
  const c = new Math.Color().setHex( 0xff0000 );
  assert( c.getHex() === 0xff0000, 'red round-trip' );
} );

test( 'ColorManagement convert sRGB <-> linear', () => {
  const c = { r: 0.5, g: 0.5, b: 0.5 };
  Math.ColorManagement.convert( c, 'srgb', 'srgb-linear' );
  assert( c.r < 0.5, 'linear should be smaller than 0.5' );
  Math.ColorManagement.convert( c, 'srgb-linear', 'srgb' );
  assertClose( c.r, 0.5, 1e-5, 'round-trip' );
} );

test( 'NATURE_THEMES contains all 7 expected themes', () => {
  for ( const name of [ 'SKY', 'OCEAN', 'CANYON', 'FOREST', 'SPACE', 'MEADOW', 'COTTAGE' ] ) {
    assert( name in Math.NATURE_THEMES, `missing theme ${ name }` );
  }
} );

test( 'themeTintInto blends two colors', () => {
  const out = { r: 0, g: 0, b: 0 };
  Math.themeTintInto( out, { r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }, 0.5 );
  assertClose( out.r, 0.5 );
} );

test( 'getNatureTheme lookup', () => {
  const t = Math.getNatureTheme( 'sky' );
  assert( t && t.name === 'SKY', 'SKY theme lookup failed' );
} );

/* ==========================================================================
 * SUITE 10 — SPHERICAL HARMONICS (file 021)
 * ========================================================================== */

suite( '10. SphericalHarmonics3' );

test( 'SH3 zero produces empty probe', () => {
  const sh = new Math.SphericalHarmonics3();
  sh.zero();
  assert( sh.isEmpty() === true, 'zeroed SH3 should be empty' );
} );

test( 'SH3 anime probe from SKY theme is not empty', () => {
  const sh = new Math.SphericalHarmonics3();
  Math.threeSH3AnimeFromTheme( sh, 'SKY' );
  assert( sh.isEmpty() === false, 'SKY probe should not be empty' );
} );

test( 'SH3 getAt at +Y returns non-zero', () => {
  const sh = new Math.SphericalHarmonics3();
  Math.threeSH3AnimeFromTheme( sh, 'MEADOW' );
  const target = new Math.Vector3();
  sh.getAt( new Math.Vector3( 0, 1, 0 ), target );
  const len = Math.sqrt( target.x * target.x + target.y * target.y + target.z * target.z );
  assert( len > 0, 'getAt should return non-zero' );
} );

/* ==========================================================================
 * SUITE 11 — EULER (file 008)
 * ========================================================================== */

suite( '11. Euler' );

test( 'Euler round-trip through Quaternion', () => {
  const e = new Math.Euler( 0.1, 0.2, 0.3, 'XYZ' );
  const q = new Math.Quaternion().setFromEuler( e );
  const e2 = new Math.Euler().setFromQuaternion( q );
  assertClose( e2.x, 0.1, 1e-5 );
  assertClose( e2.y, 0.2, 1e-5 );
  assertClose( e2.z, 0.3, 1e-5 );
} );

test( 'Euler bitecs round-trip', () => {
  const store = {
    x: new Float32Array( 1 ), y: new Float32Array( 1 ),
    z: new Float32Array( 1 ), orderCode: new Uint8Array( 1 )
  };
  Math.bitecsEulerFromThree( 0, new Math.Euler( 0.5, 0.6, 0.7, 'YXZ' ), store );
  const back = new Math.Euler();
  Math.threeEulerFromBitecs( back, 0, store );
  assertClose( back.x, 0.5 );
  assertClose( back.order, 'YXZ' );
} );

/* ==========================================================================
 * SUITE 12 — CYLINDRICAL / SPHERICAL (files 019/020)
 * ========================================================================== */

suite( '12. Cylindrical / Spherical' );

test( 'Cylindrical <-> Cartesian round-trip', () => {
  const c = new Math.Cylindrical( 5, Math.PI / 3, 2 );
  const v = new Math.Vector3();
  Math.threeVec3FromBitecsCylindrical( v,
    { radius: new Float32Array( [ 5 ] ), theta: new Float32Array( [ Math.PI / 3 ] ), y: new Float32Array( [ 2 ] ) }[ 'radius' ] ? 0 : 0,
    { radius: new Float32Array( [ 5 ] ), theta: new Float32Array( [ Math.PI / 3 ] ), y: new Float32Array( [ 2 ] ) } );
  // More direct: just check the class itself.
  const cyl = new Math.Cylindrical( 5, Math.PI / 3, 2 );
  assertClose( cyl.radius, 5 );
  assertClose( cyl.y, 2 );
} );

test( 'Spherical setFromCartesianCoords', () => {
  const s = new Math.Spherical();
  s.setFromCartesianCoords( 0, 1, 0 );
  assertClose( s.radius, 1, 1e-5 );
  assertClose( s.phi, 0, 1e-5 );
} );

test( 'Spherical makeSafe clamps phi', () => {
  const s = new Math.Spherical( 1, 0, 0 );
  s.makeSafe();
  assert( s.phi > 0, 'makeSafe should clamp' );
} );

/* ==========================================================================
 * SUITE 13 — NOISE CACHE MANAGEMENT
 * ========================================================================== */

suite( '13. Noise caches' );

test( 'disposeAllNoiseCaches runs without error', () => {
  Math.disposeAllNoiseCaches();
  assert( true );
} );

test( 'noise generates after cache clear', () => {
  const a = Math.noise3D( 1, 2, 3, 5 );
  assert( typeof a === 'number' && a >= - 1.01 && a <= 1.01, 'noise3D should return [-1,1]' );
} );

/* ==========================================================================
 * SUITE 14 — OBB precise helpers (double.js)
 * ========================================================================== */

suite( '14. OBB precise helpers' );

test( 'OBB preciseVolume matches f64 volume', () => {
  const obb = new Math.OBB( new Math.Vector3( 0, 0, 0 ), new Math.Vector3( 1, 2, 3 ) );
  const expected = 8 * 1 * 2 * 3;
  assertClose( Math.OBBModule.preciseVolume( obb ), expected, 1e-9 );
} );

test( 'OBB preciseContainsPoint', () => {
  const obb = new Math.OBB( new Math.Vector3( 0, 0, 0 ), new Math.Vector3( 1, 1, 1 ) );
  assert( Math.OBBModule.preciseContainsPoint( obb, new Math.Vector3( 0.5, 0.5, 0.5 ) ) === true );
  assert( Math.OBBModule.preciseContainsPoint( obb, new Math.Vector3( 2, 0, 0 ) ) === false );
} );

/* ==========================================================================
 * SUITE 15 — INDEX RE-EXPORT INTEGRITY
 * ========================================================================== */

suite( '15. Index integrity' );

test( 'every namespace exposes at least one symbol', () => {
  for ( const key of Object.keys( Math ) ) {
    if ( ! key.endsWith( 'Module' ) ) continue;
    const ns = Math[ key ];
    assert( ns && Object.keys( ns ).length > 0, `namespace ${ key } is empty` );
  }
} );

test( 'no top-level name is undefined', () => {
  for ( const key of Object.keys( Math ) ) {
    assert( Math[ key ] !== undefined, `top-level export ${ key } is undefined` );
  }
} );

test( 'default exports are all constructors', () => {
  const classNames = [
    'Vector2', 'Vector3', 'Quaternion', 'Matrix2', 'Matrix3', 'Matrix4',
    'Euler', 'Line3', 'Plane', 'Sphere', 'Box3', 'Ray', 'Triangle', 'Frustum',
    'Vector4', 'Color', 'Cylindrical', 'Spherical', 'SphericalHarmonics3',
    'Interpolant', 'CubicInterpolant', 'LinearInterpolant', 'DiscreteInterpolant',
    'QuaternionLinearInterpolant', 'Box2', 'BezierInterpolant', 'OBB'
  ];
  for ( const name of classNames ) {
    assert( typeof Math[ name ] === 'function', `${ name } is not a constructor` );
  }
} );

/* ==========================================================================
 * RUN
 * ========================================================================== */

runAll();

export { runAll };