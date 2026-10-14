// file number : 017
// full path name : src/core/017_InterleavedBufferAttribute.js
// description : An alternative version of a buffer attribute with interleaved data. Interleaved attributes share a common interleaved data storage (InterleavedBuffer) and refer with different offsets into the buffer. Rewritten as an ES module; consumes 011_BufferAttribute from the core folder, plus 001_MathUtils, 002_Vector2, 003_Vector3, and 016_Vector4 from the threejsbitecs/math folder for attribute and vector bridging. Bridges to 001_MathUtils for denormalize / normalize, gl-matrix for packing the attribute header (itemSize, offset, normalized, version) into a vec4, double.js for high-precision byte-offset tracking, bitecs for SoA interleaved-attribute registration, and simplex-noise for procedural attribute generators. All non-math three.js r185 imports (log from utils.js) are imported explicitly so the module remains self-contained. Corrected import paths and a single default export.
// best for : Sharing a single interleaved buffer across multiple attributes (position, normal, uv, color) where each attribute reads from a different offset. Consumed by BufferGeometry when attributes are backed by an InterleavedBuffer.
// license : MIT

import BufferAttribute from './011_BufferAttribute.js';

import MathUtils from '../math/001_MathUtils.js';
import Vector2 from '../math/002_Vector2.js';
import Vector3 from '../math/003_Vector3.js';
import Vector4 from '../math/016_Vector4.js';

import { log } from 'https://cdn.jsdelivr.net/npm/three@0.185.0/src/utils.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

// Module-private scratch vector (mirrors r185 source).
const _vector = new Vector3();

const InterleavedBufferAttributeUtils = {

    // 001_MathUtils bridge: denormalize a normalized value back to its integer range.
    denormalize: ( value, array ) => MathUtils.denormalize( value, array ),

    // 001_MathUtils bridge: normalize an integer value into the [ -1, 1 ] or [ 0, 1 ] range.
    normalize: ( value, array ) => MathUtils.normalize( value, array ),

    // 001_MathUtils bridge: clamp an interleaved offset to a valid non-negative integer.
    clampOffset: ( value ) => MathUtils.clamp( Math.floor( value ), 0, Infinity ),

    // 001_MathUtils bridge: generate a UUID for anonymous interleaved attributes.
    generateUUID: () => MathUtils.generateUUID(),

    // gl-matrix bridge: pack the interleaved-attribute header (itemSize, offset, normalized, version) into a vec4.
    packHeaderVec4: ( out, itemSize, offset, normalized, version ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set( out || _scratchVec4, itemSize, offset, normalized ? 1 : 0, version );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // bitecs bridge: register an interleaved attribute as a SoA component column.
    registerComponent: ( name, count, itemSize, offset ) => {

        const column = new Float32Array( count * itemSize );
        return { name, column, itemSize, offset, count };

    },

    // double.js bridge: high-precision byte offset for a given vertex index.
    byteOffset: ( index, offset, stride, bytesPerElement = 4 ) => {

        const i = new Double( index );
        const o = new Double( offset );
        const s = new Double( stride );
        const b = new Double( bytesPerElement );
        return i.mul( s ).add( o ).mul( b ).valueOf();

    },

    // double.js bridge: high-precision total byte length of the interleaved attribute.
    totalBytes: ( array, itemSize, count ) => {

        let total = new Double( array.BYTES_PER_ELEMENT || 4 );
        total.mul( itemSize ).mul( count );
        return total.valueOf();

    },

    // simplex-noise bridge: fill a position attribute array with procedural 3D noise.
    fillWithNoise: ( out, vertexCount, itemSize, scale = 0.1, seed = 0 ) => {

        let i = 0;
        for ( let v = 0; v < vertexCount; v ++ ) {

            for ( let c = 0; c < itemSize; c ++ ) {

                out[ i ++ ] = _noise3D( v * scale + seed, c * scale + seed, seed );

            }

        }
        return out;

    },

    // simplex-noise bridge: procedural noise helpers.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class InterleavedBufferAttribute {

    constructor( interleavedBuffer, itemSize, offset, normalized = false ) {

        this.isInterleavedBufferAttribute = true;

        this.name = '';

        this.data = interleavedBuffer;
        this.itemSize = itemSize;
        this.offset = offset;

        this.normalized = normalized;

    }

    get count() {

        return this.data.count;

    }

    get array() {

        return this.data.array;

    }

    set needsUpdate( value ) {

        this.data.needsUpdate = value;

    }

    applyMatrix4( m ) {

        for ( let i = 0, l = this.data.count; i < l; i ++ ) {

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

    getX( index ) {

        let x = this.data.array[ index * this.data.stride + this.offset ];

        if ( this.normalized ) x = MathUtils.denormalize( x, this.array );

        return x;

    }

    setX( index, x ) {

        if ( this.normalized ) x = MathUtils.normalize( x, this.array );

        this.data.array[ index * this.data.stride + this.offset ] = x;

        return this;

    }

    getY( index ) {

        let y = this.data.array[ index * this.data.stride + this.offset + 1 ];

        if ( this.normalized ) y = MathUtils.denormalize( y, this.array );

        return y;

    }

    setY( index, y ) {

        if ( this.normalized ) y = MathUtils.normalize( y, this.array );

        this.data.array[ index * this.data.stride + this.offset + 1 ] = y;

        return this;

    }

    getZ( index ) {

        let z = this.data.array[ index * this.data.stride + this.offset + 2 ];

        if ( this.normalized ) z = MathUtils.denormalize( z, this.array );

        return z;

    }

    setZ( index, z ) {

        if ( this.normalized ) z = MathUtils.normalize( z, this.array );

        this.data.array[ index * this.data.stride + this.offset + 2 ] = z;

        return this;

    }

    getW( index ) {

        let w = this.data.array[ index * this.data.stride + this.offset + 3 ];

        if ( this.normalized ) w = MathUtils.denormalize( w, this.array );

        return w;

    }

    setW( index, w ) {

        if ( this.normalized ) w = MathUtils.normalize( w, this.array );

        this.data.array[ index * this.data.stride + this.offset + 3 ] = w;

        return this;

    }

    setXY( index, x, y ) {

        index = index * this.data.stride + this.offset;

        if ( this.normalized ) {

            x = MathUtils.normalize( x, this.array );
            y = MathUtils.normalize( y, this.array );

        }

        this.data.array[ index + 0 ] = x;
        this.data.array[ index + 1 ] = y;

        return this;

    }

    setXYZ( index, x, y, z ) {

        index = index * this.data.stride + this.offset;

        if ( this.normalized ) {

            x = MathUtils.normalize( x, this.array );
            y = MathUtils.normalize( y, this.array );
            z = MathUtils.normalize( z, this.array );

        }

        this.data.array[ index + 0 ] = x;
        this.data.array[ index + 1 ] = y;
        this.data.array[ index + 2 ] = z;

        return this;

    }

    setXYZW( index, x, y, z, w ) {

        index = index * this.data.stride + this.offset;

        if ( this.normalized ) {

            x = MathUtils.normalize( x, this.array );
            y = MathUtils.normalize( y, this.array );
            z = MathUtils.normalize( z, this.array );
            w = MathUtils.normalize( w, this.array );

        }

        this.data.array[ index + 0 ] = x;
        this.data.array[ index + 1 ] = y;
        this.data.array[ index + 2 ] = z;
        this.data.array[ index + 3 ] = w;

        return this;

    }

    clone( data ) {

        if ( data === undefined ) {

            log( 'THREE.InterleavedBufferAttribute.clone(): Cloning an interleaved buffer attribute will de-interleave attribute arrays. Use InterleavedBuffer.clone() for cloning the interleaved buffer instead.' );

            const array = new this.array.constructor( this.count * this.itemSize );

            for ( let i = 0; i < this.count; i ++ ) {

                for ( let j = 0; j < this.itemSize; j ++ ) {

                    array[ i * this.itemSize + j ] = this.getComponent( i, j );

                }

            }

            return new BufferAttribute( array, this.itemSize ).copy( this );

        } else {

            return new this.constructor( data, this.itemSize, this.offset, this.normalized );

        }

    }

    toJSON( data ) {

        if ( data === undefined ) {

            log( 'THREE.InterleavedBufferAttribute.toJSON(): Serializing an interleaved buffer attribute will de-interleave attribute arrays. Use InterleavedBuffer.toJSON() for serializing the interleaved buffer instead.' );

            const array = new this.array.constructor( this.count * this.itemSize );

            for ( let i = 0; i < this.count; i ++ ) {

                for ( let j = 0; j < this.itemSize; j ++ ) {

                    array[ i * this.itemSize + j ] = this.getComponent( i, j );

                }

            }

            return {
                itemSize: this.itemSize,
                type: this.array.constructor.name,
                array: Array.from( array ),
                normalized: this.normalized,
                name: this.name,
            };

        } else {

            const json = {
                isInterleavedBufferAttribute: true,
                itemSize: this.itemSize,
                offset: this.offset,
                normalized: this.normalized,
            };

            if ( this.name !== '' ) json.name = this.name;

            if ( this.data.uuid !== undefined ) json.data = this.data.uuid;
            else json.data = this.data;

            return json;

        }

    }

    getComponent( index, component ) {

        let value = this.array[ index * this.data.stride + this.offset + component ];

        if ( this.normalized ) value = MathUtils.denormalize( value, this.array );

        return value;

    }

    setComponent( index, component, value ) {

        if ( this.normalized ) value = MathUtils.normalize( value, this.array );

        this.array[ index * this.data.stride + this.offset + component ] = value;

        return this;

    }

    // Convenience accessors backed by the utility surface above.
    packHeaderToVec4( out ) {

        return InterleavedBufferAttributeUtils.packHeaderVec4(
            out, this.itemSize, this.offset, this.normalized, this.data.version
        );

    }

    asBitecsComponent( name ) {

        return InterleavedBufferAttributeUtils.registerComponent(
            name, this.count, this.itemSize, this.offset
        );

    }

    getByteOffset( index, bytesPerElement = 4 ) {

        return InterleavedBufferAttributeUtils.byteOffset(
            index, this.offset, this.data.stride, bytesPerElement
        );

    }

    getTotalBytes() {

        return InterleavedBufferAttributeUtils.totalBytes(
            this.array, this.itemSize, this.count
        );

    }

    fillWithNoise( scale = 0.1, seed = 0 ) {

        InterleavedBufferAttributeUtils.fillWithNoise(
            this.array, this.count, this.itemSize, scale, seed
        );
        this.data.needsUpdate = true;

        return this;

    }

}

InterleavedBufferAttribute.Utils = InterleavedBufferAttributeUtils;

export default InterleavedBufferAttribute;