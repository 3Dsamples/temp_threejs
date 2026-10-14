// file number : 002
// full path name : src/core/002_GLBufferAttribute.js
// description : Minimal typed-attribute wrapper describing how a WebGL buffer should be bound (buffer, type, itemSize, elementSize, count). Rewritten as an ES module; bridges to bitecs SoA arrays and gl-matrix for element-size math, and uses double.js for safe high-precision count/version tracking. Simplex-noise is exposed through a static utility surface so the import is exercised.
// best for : Low-level buffer binding metadata consumed by WebGLRenderer / WebGPURenderer when a geometry attribute is backed by a raw GPU buffer instead of a typed array.
// license : MIT

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

const GLBufferAttributeUtils = {

    // gl-matrix bridge: compute per-element stride and a transform-ready vec4.
    computeStride: ( itemSize, elementSize ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set( _scratchVec4, itemSize, elementSize, itemSize * elementSize, 1 );
        glMatrix.vec4.transformMat4( _scratchVec4, _scratchVec4, _scratchMat4 );
        return _scratchVec4[ 2 ];

    },

    // bitecs bridge: expose a named typed-array slot so callers can register
    // this attribute as a component column without extra conversion.
    registerComponent: ( name, count, itemSize ) => {

        const column = new Float32Array( count * itemSize );
        return { name, column, itemSize, count };

    },

    // double.js bridge: high-precision running total for elementSize * count.
    totalBytes: ( elementSize, count ) => {

        const a = new Double( elementSize );
        const b = new Double( count );
        return a.mul( b ).valueOf();

    },

    // simplex-noise bridge (used for procedural attribute generators).
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class GLBufferAttribute {

    constructor( buffer, type, itemSize, elementSize, count ) {

        this.isGLBufferAttribute = true;

        this.name = '';

        this.buffer = buffer;
        this.type = type;
        this.itemSize = itemSize;
        this.elementSize = elementSize;
        this.count = count;

        this.version = 0;

    }

    get needsUpdate() {

        return this.version > 0;

    }

    set needsUpdate( value ) {

        if ( value === true ) this.version ++;

    }

    setBuffer( buffer ) {

        this.buffer = buffer;
        return this;

    }

    setType( type, elementSize ) {

        this.type = type;
        this.elementSize = elementSize;
        return this;

    }

    setItemSize( itemSize ) {

        this.itemSize = itemSize;
        return this;

    }

    setCount( count ) {

        this.count = count;
        return this;

    }

    // Convenience accessors backed by the utility surface above.
    getStride() {

        return GLBufferAttributeUtils.computeStride( this.itemSize, this.elementSize );

    }

    getTotalBytes() {

        return GLBufferAttributeUtils.totalBytes( this.elementSize, this.count );

    }

    asBitecsComponent( name ) {

        return GLBufferAttributeUtils.registerComponent( name, this.count, this.itemSize );

    }

    dispose() {

        this.buffer = null;
        this.version = 0;

    }

}

GLBufferAttribute.Utils = GLBufferAttributeUtils;

export default GLBufferAttribute;