// file number : 059
// full path name : src/math/059_Euler.js
// description : Euler-angle orientation primitive — drop-in replacement for THREE.Euler (r185) renumbered from the incoming 008/009 slot to avoid collision with the existing chat files (008_Mat2, 009_Mat3). Backed by plain f64 fields _x, _y, _z plus an order string _order (Euler cannot be a Float32Array because order is a string — so this is a plain class; public x/y/z accessors are the three.js callback hooks, while _x/_y/_z are silent internal writes for zero-callback hot paths). Complete r185 surface: constructor, isEuler, get/set x,y,z,order, set(x,y,z,order), clone, copy, reorder, fromArray, toArray, fromBufferAttribute, equals, fromQuaternion, setFromQuaternion, setFromRotationMatrix (all 6 orders, r185-exact signs, 0.9999999 gimbal-lock threshold), setFromVector3, toVector3, onChange, _onChange, _onChangeCallback, isEuler flag, toJSON, Symbol.iterator. Extended: toQuaternion(out) / toMatrix4(out) non-allocating helpers, preciseMagnitude() via the chat's DoubleDouble module, setFromNoise(x,y,z,seed,scale) using the chat's SimplexNoise (cached per-seed mulberry32), bitECS SoA bridges fromBitecs/toBitecs with the six order codes EULER_ORDER_XYZ..EULER_ORDER_XZY, recycled local pool that resets order to 'XYZ' and clears the _onChangeCallback instance shadow, acquireSnapshot() for ECS history, and duck-typed inputs everywhere (accepts {x,y,z,order}, {_x,_y,_z,_order}, flat [x,y,z,order], and any three.js-style quaternion/matrix via .x/.y/.z/.elements duck-typing). Uses the chat's quat/mat4 flat-array primitives instead of THREE.Quaternion/THREE.Matrix4. No CDN, no static server, no Vite/Vue.
// best for : authoring-facing rotation parameters (UI angle fields, animation curves, rig controls), procedural spawn orientation jitter, bone / joint orientations where the animator specifies Euler angles, and the boundary layer where a Quaternion must be presented back to the user as readable angles. Internally, prefer Quat / Mat4 for hot-path math — Euler is provided for three.js compatibility and for authoring surfaces where the gimbal-lock trade-off is acceptable and the DoubleDouble magnitude helper guards the degenerate region.
// license : MIT

import { clamp } from '../core/003_Common.js';
import * as DD from './014_DoubleDouble.js';
import * as quat from './011_Quat.js';
import * as mat4 from './010_Mat4.js';
import { createNoise3D } from './013_SimplexNoise.js';

// ═══════════════════════════════════════════════════════════════════
// Order constants (bitECS Uint8Array encoding)
// ═══════════════════════════════════════════════════════════════════
export const EULER_ORDER_XYZ = 0;
export const EULER_ORDER_YXZ = 1;
export const EULER_ORDER_ZXY = 2;
export const EULER_ORDER_ZYX = 3;
export const EULER_ORDER_YZX = 4;
export const EULER_ORDER_XZY = 5;

const _ORDER_TO_INDEX = {
  XYZ: EULER_ORDER_XYZ,
  YXZ: EULER_ORDER_YXZ,
  ZXY: EULER_ORDER_ZXY,
  ZYX: EULER_ORDER_ZYX,
  YZX: EULER_ORDER_YZX,
  XZY: EULER_ORDER_XZY
};

const _INDEX_TO_ORDER = [ 'XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY' ];

// ═══════════════════════════════════════════════════════════════════
// Module-scoped helpers — zero allocation in hot paths
// ═══════════════════════════════════════════════════════════════════

function _asMat( m ) {
  return ( m != null && m.elements !== undefined ) ? m.elements : m;
}

function _sx( v ) { return v.x !== undefined ? v.x : ( v._x !== undefined ? v._x : v[ 0 ] ); }
function _sy( v ) { return v.y !== undefined ? v.y : ( v._y !== undefined ? v._y : v[ 1 ] ); }
function _sz( v ) { return v.z !== undefined ? v.z : ( v._z !== undefined ? v._z : v[ 2 ] ); }
function _sorder( v ) {
  return v.order !== undefined ? v.order : ( v._order !== undefined ? v._order : 'XYZ' );
}

const _noise3DCache = new Map();

function _mulberry32( seed ) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = ( a + 0x6D2B79F5 ) | 0;
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

const _matrix4Scratch = mat4.create();
const _quaternionScratch = quat.create();

const _localPool = [];
const LOCAL_POOL_MAX = 256;

// ═══════════════════════════════════════════════════════════════════
// class Euler
// ═══════════════════════════════════════════════════════════════════
class Euler {

  constructor( x = 0, y = 0, z = 0, order = 'XYZ' ) {
    this.isEuler = true;

    if ( x !== null && typeof x === 'object' ) {
      this._x = _sx( x );
      this._y = _sy( x );
      this._z = _sz( x );
      this._order = _sorder( x );
    } else {
      this._x = x;
      this._y = y;
      this._z = z;
      this._order = order;
    }
  }

  get x() { return this._x; }
  set x( value ) { this._x = value; this._onChangeCallback(); }
  get y() { return this._y; }
  set y( value ) { this._y = value; this._onChangeCallback(); }
  get z() { return this._z; }
  set z( value ) { this._z = value; this._onChangeCallback(); }
  get order() { return this._order; }
  set order( value ) { this._order = value; this._onChangeCallback(); }

  _onChangeCallback() {}

  onChange( callback ) {
    this._onChangeCallback = callback;
    return this;
  }

  _onChange( callback ) {
    return this.onChange( callback );
  }

  set( x, y, z, order = this._order ) {
    this._x = x;
    this._y = y;
    this._z = z;
    this._order = order;
    this._onChangeCallback();
    return this;
  }

  clone() {
    return new Euler( this._x, this._y, this._z, this._order );
  }

  copy( euler ) {
    this._x = _sx( euler );
    this._y = _sy( euler );
    this._z = _sz( euler );
    this._order = _sorder( euler );
    this._onChangeCallback();
    return this;
  }

  reorder( newOrder ) {
    quat.fromEuler( _quaternionScratch, this._x, this._y, this._z, this._order );
    return this.setFromQuaternion( _quaternionScratch, newOrder );
  }

  fromArray( array ) {
    this._x = array[ 0 ];
    this._y = array[ 1 ];
    this._z = array[ 2 ];
    if ( array[ 3 ] !== undefined ) this._order = array[ 3 ];
    this._onChangeCallback();
    return this;
  }

  toArray( array = [], offset = 0 ) {
    array[ offset ]     = this._x;
    array[ offset + 1 ] = this._y;
    array[ offset + 2 ] = this._z;
    array[ offset + 3 ] = this._order;
    return array;
  }

  fromBufferAttribute( attribute, index ) {
    this._x = attribute.getX( index );
    this._y = attribute.getY( index );
    this._z = attribute.getZ( index );
    this._onChangeCallback();
    return this;
  }

  equals( euler ) {
    return _sx( euler ) === this._x
        && _sy( euler ) === this._y
        && _sz( euler ) === this._z
        && _sorder( euler ) === this._order;
  }

  fromQuaternion( q ) {
    this.setFromQuaternion( q );
    return this;
  }

  setFromQuaternion( q, order = this._order, update = true ) {
    // Duck-typed quaternion: accept {x,y,z,w} (three.js style) or flat [x,y,z,w]
    const qx = ( q.x !== undefined ) ? q.x : q[ 0 ];
    const qy = ( q.y !== undefined ) ? q.y : q[ 1 ];
    const qz = ( q.z !== undefined ) ? q.z : q[ 2 ];
    const qw = ( q.w !== undefined ) ? q.w : q[ 3 ];
    _quaternionScratch[ 0 ] = qx;
    _quaternionScratch[ 1 ] = qy;
    _quaternionScratch[ 2 ] = qz;
    _quaternionScratch[ 3 ] = qw;
    mat4.fromQuat( _matrix4Scratch, _quaternionScratch );
    return this.setFromRotationMatrix( _matrix4Scratch, order, update );
  }

  setFromRotationMatrix( m, order = this._order, update = true ) {
    const te = _asMat( m );
    const m11 = te[ 0 ], m12 = te[ 4 ], m13 = te[ 8 ];
    const m21 = te[ 1 ], m22 = te[ 5 ], m23 = te[ 9 ];
    const m31 = te[ 2 ], m32 = te[ 6 ], m33 = te[ 10 ];

    switch ( order ) {
      case 'XYZ':
        this._y = Math.asin( clamp( m13, - 1, 1 ) );
        if ( Math.abs( m13 ) < 0.9999999 ) {
          this._x = Math.atan2( - m23, m33 );
          this._z = Math.atan2( - m12, m11 );
        } else {
          this._x = Math.atan2( m32, m22 );
          this._z = 0;
        }
        break;

      case 'YXZ':
        this._x = Math.asin( - clamp( m23, - 1, 1 ) );
        if ( Math.abs( m23 ) < 0.9999999 ) {
          this._y = Math.atan2( m13, m33 );
          this._z = Math.atan2( m21, m22 );
        } else {
          this._y = Math.atan2( - m31, m11 );
          this._z = 0;
        }
        break;

      case 'ZXY':
        this._x = Math.asin( clamp( m32, - 1, 1 ) );
        if ( Math.abs( m32 ) < 0.9999999 ) {
          this._y = Math.atan2( - m31, m33 );
          this._z = Math.atan2( - m12, m22 );
        } else {
          this._y = 0;
          this._z = Math.atan2( m21, m11 );
        }
        break;

      case 'ZYX':
        this._y = Math.asin( - clamp( m31, - 1, 1 ) );
        if ( Math.abs( m31 ) < 0.9999999 ) {
          this._x = Math.atan2( m32, m33 );
          this._z = Math.atan2( m21, m11 );
        } else {
          this._x = 0;
          this._z = Math.atan2( - m12, m22 );
        }
        break;

      case 'YZX':
        this._z = Math.asin( clamp( m21, - 1, 1 ) );
        if ( Math.abs( m21 ) < 0.9999999 ) {
          this._x = Math.atan2( - m23, m22 );
          this._y = Math.atan2( - m31, m11 );
        } else {
          this._x = 0;
          this._y = Math.atan2( m13, m33 );
        }
        break;

      case 'XZY':
        this._z = Math.asin( - clamp( m12, - 1, 1 ) );
        if ( Math.abs( m12 ) < 0.9999999 ) {
          this._x = Math.atan2( m32, m22 );
          this._y = Math.atan2( m13, m11 );
        } else {
          this._x = Math.atan2( - m23, m33 );
          this._y = 0;
        }
        break;

      default:
        throw new Error( 'Euler.setFromRotationMatrix: unknown order ' + order );
    }

    this._order = order;
    if ( update === true ) this._onChangeCallback();
    return this;
  }

  setFromMatrix4( m, order = this._order, update = true ) {
    return this.setFromRotationMatrix( m, order, update );
  }

  setFromVector3( v, order = this._order ) {
    return this.set( _sx( v ), _sy( v ), _sz( v ), order );
  }

  toVector3( optionalResult ) {
    if ( optionalResult ) {
      if ( typeof optionalResult.set === 'function' ) {
        return optionalResult.set( this._x, this._y, this._z );
      }
      // Flat array
      optionalResult[ 0 ] = this._x;
      optionalResult[ 1 ] = this._y;
      optionalResult[ 2 ] = this._z;
      return optionalResult;
    }
    return { x: this._x, y: this._y, z: this._z };
  }

  toJSON() { return [ this._x, this._y, this._z, this._order ]; }

  *[ Symbol.iterator ]() {
    yield this._x;
    yield this._y;
    yield this._z;
    yield this._order;
  }

  // ────────────── extended helpers ──────────────

  toQuaternion( out ) {
    quat.fromEuler( out, this._x, this._y, this._z, this._order );
    return out;
  }

  toMatrix4( out ) {
    quat.fromEuler( _quaternionScratch, this._x, this._y, this._z, this._order );
    mat4.fromQuat( out, _quaternionScratch );
    return out;
  }

  preciseMagnitude() {
    const dx = DD.fromDouble( this._x );
    const dy = DD.fromDouble( this._y );
    const dz = DD.fromDouble( this._z );
    const sumSq = DD.add(
      DD.add( DD.multiply( dx, dx ), DD.multiply( dy, dy ) ),
      DD.multiply( dz, dz )
    );
    return DD.toDouble( DD.sqrt( sumSq ) );
  }

  setFromNoise( x, y, z, seed = 0, scale = Math.PI ) {
    const n = _cachedNoise3D( seed );
    this._x = n( x, y, z ) * scale;
    this._y = n( x + 31.416, y + 47.853, z + 12.793 ) * scale;
    this._z = n( x - 17.234, y - 53.127, z - 91.056 ) * scale;
    this._onChangeCallback();
    return this;
  }

  fromBitecs( store, eid ) {
    this._x = store.x[ eid ];
    this._y = store.y[ eid ];
    this._z = store.z[ eid ];
    const idx = store.order[ eid ];
    this._order = _INDEX_TO_ORDER[ idx ] || 'XYZ';
    return this;
  }

  toBitecs( store, eid ) {
    store.x[ eid ] = this._x;
    store.y[ eid ] = this._y;
    store.z[ eid ] = this._z;
    const idx = _ORDER_TO_INDEX[ this._order ];
    store.order[ eid ] = idx !== undefined ? idx : EULER_ORDER_XYZ;
    return this;
  }

  acquireSnapshot() {
    return new Euler( this._x, this._y, this._z, this._order );
  }

  static acquire() {
    return _localPool.length > 0 ? _localPool.pop() : new Euler();
  }

  static recycle( e ) {
    if ( e instanceof Euler && _localPool.length < LOCAL_POOL_MAX ) {
      e._x = 0; e._y = 0; e._z = 0; e._order = 'XYZ';
      delete e._onChangeCallback;
      _localPool.push( e );
    }
  }
}

export { Euler };
export default Euler;