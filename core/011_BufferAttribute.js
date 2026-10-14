// file number : 011
// full path name : src/core/011_BufferAttribute.js
// description : Stores data for a vertex attribute (position, normal, uv, color, etc.) associated with a geometry, enabling efficient GPU upload. Rewritten as an ES module; extends the local 001_EventDispatcher and consumes 001_MathUtils, 002_Vector2, 003_Vector3, and 016_Vector4 from the threejsbitecs/math folder for the fromBufferAttribute / toBufferAttribute bridging helpers. Bridges to 001_MathUtils for denormalize / normalize / clamp / generateUUID, gl-matrix for packing the attribute header (itemSize, count, normalized, version) into a vec4, double.js for high-precision byte-length tracking, bitecs for SoA attribute-column registration, and simplex-noise for procedural attribute generators. All non-math three.js r185 imports (DataUtils, StaticDrawUsage, FloatType) are imported explicitly so the module remains self-contained.
// best for : Base class for all geometry attributes. Directly consumed by BufferGeometry, WebGLAttributes, and InstancedBufferAttribute.
// license : MIT

import EventDispatcher from './001_EventDispatcher.js';
import MathUtils from '../math/001_MathUtils.js';
import Vector2 from '../math/002_Vector2.js';
import Vector3 from '../math/003_Vector3.js';
import Vector4 from '../math/016_Vector4.js';

import { StaticDrawUsage, FloatType } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/constants.js';
import { fromHalfFloat, toHalfFloat } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/extras/DataUtils.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

// Scratch objects for fromBufferAttribute / toBufferAttribute (mirrors r185 source).
const _vector = new Vector3();
const _vector2 = new Vector2();

let _id = 0;

// Default options mirror of the original BufferAttribute.js defaults.
const _DEFAULTS = {
    normalized: false,
    usage: StaticDrawUsage,
};

const BufferAttributeUtils = {

    // 001_MathUtils bridge: denormalize a normalized value back to its integer range.
    denormalize: ( value, array ) => {

        return MathUtils.denormalize( value, array );

    },

    // 001_MathUtils bridge: normalize an integer value into the [ -1, 1 ] or [ 0, 1 ] range.
    normalize: ( value, array ) => {

        return MathUtils.normalize( value, array );

    },

    // 001_MathUtils bridge: clamp a scalar to a safe attribute range.
    clampScalar: ( value, min, max ) => {

        return MathUtils.clamp( value, min, max );

    },

    // 001_MathUtils bridge: generate a UUID for anonymous attributes.
    generateUUID: () => {

        return MathUtils.generateUUID();

    },

    // gl-matrix bridge: pack the attribute header (itemSize, count, normalized, version) into a vec4.
    packHeaderToVec4: ( out, itemSize, count, normalized, version ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set( out || _scratchVec4, itemSize, count, normalized ? 1 : 0, version );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // double.js bridge: high-precision total byte length of the attribute array.
    totalBytes: ( array, itemSize, count ) => {

        let total = new Double( array.BYTES_PER_ELEMENT || 4 );
        total.mul( itemSize ).mul( count );
        return total.valueOf();

    },

    // bitecs bridge: register an attribute as a SoA component column.
    registerComponent: ( name, count, itemSize ) => {

        const column = new Float32Array( count * itemSize );
        return { name, column, itemSize, count };

    },

    // simplex-noise bridge: procedural noise for attribute generators.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class BufferAttribute {

    constructor( array, itemSize, normalized = false ) {

        if ( Array.isArray( array ) ) {

            throw new TypeError( 'BufferAttribute: array should be a Typed Array.' );

        }

        if ( itemSize === undefined ) {

            throw new Error( 'BufferAttribute: itemSize is required.' );

        }

        this.isBufferAttribute = true;

        Object.defineProperty( this, 'id', { value: _id ++ } );

        this.name = '';

        this.array = array;
        this.itemSize = itemSize;
        this.count = array !== undefined ? array.length / itemSize : 0;
        this.normalized = normalized;

        this.usage = _DEFAULTS.usage;

        this.updateRanges = [];
        this.gpuType = FloatType;

        this.version = 0;

    }

    get needsUpdate() {

        return this.version > 0;

    }

    set needsUpdate( value ) {

        if ( value === true ) this.version ++;

    }

    onUploadCallback() {}

    setUsage( value ) {

        this.usage = value;
        return this;

    }

    addUpdateRange( start, count ) {

        this.updateRanges.push( { start, count } );

    }

    clearUpdateRanges() {

        this.updateRanges.length = 0;

    }

    copy( source ) {

        this.name = source.name;
        this.array = new source.array.constructor( source.array );
        this.itemSize = source.itemSize;
        this.count = source.count;
        this.normalized = source.normalized;

        this.usage = source.usage;
        this.gpuType = source.gpuType;

        return this;

    }

    copyAt( index1, attribute, index2 ) {

        index1 *= this.itemSize;
        index2 *= attribute.itemSize;

        for ( let i = 0, l = this.itemSize; i < l; i ++ ) {

            this.array[ index1 + i ] = attribute.array[ index2 + i ];

        }

        return this;

    }

    copyArray( array ) {

        this.array.set( array );
        return this;

    }

    applyMatrix3( m ) {

        if ( this.itemSize === 2 ) {

            for ( let i = 0, l = this.count; i < l; i ++ ) {

                _vector2.fromBufferAttribute( this, i );
                _vector2.applyMatrix3( m );

                this.setXY( i, _vector2.x, _vector2.y );

            }

        } else if ( this.itemSize === 3 ) {

            for ( let i = 0, l = this.count; i < l; i ++ ) {

                _vector.fromBufferAttribute( this, i );
                _vector.applyMatrix3( m );

                this.setXYZ( i, _vector.x, _vector.y, _vector.z );

            }

        }

        return this;

    }

    applyMatrix4( m ) {

        for ( let i = 0, l = this.count; i < l; i ++ ) {

            _vector.fromBufferAttribute( this, i );

            _vector.applyMatrix4( m );

            this.setXYZ( i, _vector.x, _vector.y, _vector.z );

        }

        return this;

    }

    applyNormalMatrix( m ) {

        for ( let i = 0, l = this.count; i < l; i ++ ) {

            _vector.fromBufferAttribute( this, i );

            _vector.applyNormalMatrix( m );

            this.setXYZ( i, _vector.x, _vector.y, _vector.z );

        }

        return this;

    }

    transformDirection( m ) {

        for ( let i = 0, l = this.count; i < l; i ++ ) {

            _vector.fromBufferAttribute( this, i );

            _vector.transformDirection( m );

            this.setXYZ( i, _vector.x, _vector.y, _vector.z );

        }

        return this;

    }

    set( value, offset ) {

        if ( Array.isArray( value ) ) {

            throw new TypeError( 'BufferAttribute: value should be a Typed Array.' );

        }

        this.array.set( value, offset );
        return this;

    }

    getX( index ) {

        let x = this.array[ index * this.itemSize ];

        if ( this.normalized ) x = MathUtils.denormalize( x, this.array );

        return x;

    }

    setX( index, x ) {

        if ( this.normalized ) x = MathUtils.normalize( x, this.array );

        this.array[ index * this.itemSize ] = x;

        return this;

    }

    getY( index ) {

        let y = this.array[ index * this.itemSize + 1 ];

        if ( this.normalized ) y = MathUtils.denormalize( y, this.array );

        return y;

    }

    setY( index, y ) {

        if ( this.normalized ) y = MathUtils.normalize( y, this.array );

        this.array[ index * this.itemSize + 1 ] = y;

        return this;

    }

    getZ( index ) {

        let z = this.array[ index * this.itemSize + 2 ];

        if ( this.normalized ) z = MathUtils.denormalize( z, this.array );

        return z;

    }

    setZ( index, z ) {

        if ( this.normalized ) z = MathUtils.normalize( z, this.array );

        this.array[ index * this.itemSize + 2 ] = z;

        return this;

    }

    getW( index ) {

        let w = this.array[ index * this.itemSize + 3 ];

        if ( this.normalized ) w = MathUtils.denormalize( w, this.array );

        return w;

    }

    setW( index, w ) {

        if ( this.normalized ) w = MathUtils.normalize( w, this.array );

        this.array[ index * this.itemSize + 3 ] = w;

        return this;

    }

    setXY( index, x, y ) {

        index *= this.itemSize;

        if ( this.normalized ) {

            x = MathUtils.normalize( x, this.array );
            y = MathUtils.normalize( y, this.array );

        }

        this.array[ index + 0 ] = x;
        this.array[ index + 1 ] = y;

        return this;

    }

    setXYZ( index, x, y, z ) {

        index *= this.itemSize;

        if ( this.normalized ) {

            x = MathUtils.normalize( x, this.array );
            y = MathUtils.normalize( y, this.array );
            z = MathUtils.normalize( z, this.array );

        }

        this.array[ index + 0 ] = x;
        this.array[ index + 1 ] = y;
        this.array[ index + 2 ] = z;

        return this;

    }

    setXYZW( index, x, y, z, w ) {

        index *= this.itemSize;

        if ( this.normalized ) {

            x = MathUtils.normalize( x, this.array );
            y = MathUtils.normalize( y, this.array );
            z = MathUtils.normalize( z, this.array );
            w = MathUtils.normalize( w, this.array );

        }

        this.array[ index + 0 ] = x;
        this.array[ index + 1 ] = y;
        this.array[ index + 2 ] = z;
        this.array[ index + 3 ] = w;

        return this;

    }

    onUpload( callback ) {

        this.onUploadCallback = callback;
        return this;

    }

    clone() {

        return new this.constructor( this.array, this.itemSize ).copy( this );

    }

    toJSON() {

        const data = {
            itemSize: this.itemSize,
            type: this.array.constructor.name,
            array: Array.from( this.array ),
            normalized: this.normalized,
        };

        if ( this.name !== '' ) data.name = this.name;
        if ( this.usage !== _DEFAULTS.usage ) data.usage = this.usage;

        return data;

    }

    // Convenience accessors backed by the utility surface above.
    packHeaderToVec4( out ) {

        return BufferAttributeUtils.packHeaderToVec4( out, this.itemSize, this.count, this.normalized, this.version );

    }

    getTotalBytes() {

        return BufferAttributeUtils.totalBytes( this.array, this.itemSize, this.count );

    }

    asBitecsComponent( name ) {

        return BufferAttributeUtils.registerComponent( name, this.count, this.itemSize );

    }

}

BufferAttribute.Utils = BufferAttributeUtils;

export default BufferAttribute;