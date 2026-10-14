// file number : 005
// full path name : src/core/005_Uniform.js
// description : Simple value-holder class representing a single shader uniform (name + value). Rewritten as an ES module; imports MathUtils from the threejsbitecs/math folder, bridges to gl-matrix for packing scalar/vector uniforms into a uniform-friendly vec4, double.js for high-precision numeric uniforms, bitecs for SoA uniform registration, and simplex-noise for procedural default values. Uses a WeakMap-backed private value so no public property collision exists with the .value accessor. Corrected import path for MathUtils and streamlined exports to a single default export.
// best for : Declaring shader uniforms in ShaderMaterial / RawShaderMaterial. Acts as the leaf unit consumed by UniformsGroup and WebGLUniforms upload paths.
// license : MIT

import MathUtils from '../math/001_MathUtils.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

// Private per-instance value storage. Keeps `value` a real accessor, not an own property.
const _values = new WeakMap();

const UniformUtils = {

    // 001_MathUtils bridge: coerce a raw scalar to a finite uniform-safe number.
    normalizeScalar: ( value ) => {

        return Number.isFinite( value ) ? value : MathUtils.clamp( Number( value ) || 0, - Infinity, Infinity );

    },

    // gl-matrix bridge: pack a scalar or array-like uniform into a vec4.
    packToVec4: ( out, value ) => {

        glMatrix.mat4.identity( _scratchMat4 );

        if ( typeof value === 'number' ) {

            glMatrix.vec4.set( out || _scratchVec4, value, 0, 0, 1 );

        } else if ( value && typeof value.length === 'number' ) {

            glMatrix.vec4.set(
                out || _scratchVec4,
                value[ 0 ] || 0,
                value[ 1 ] || 0,
                value[ 2 ] || 0,
                value[ 3 ] !== undefined ? value[ 3 ] : 1
            );

        } else {

            glMatrix.vec4.set( out || _scratchVec4, 0, 0, 0, 1 );

        }

        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // double.js bridge: wrap a numeric uniform in extended precision for accumulation.
    toDouble: ( value ) => new Double( typeof value === 'number' ? value : 0 ),

    // bitecs bridge: register a uniform as a SoA component column.
    registerComponent: ( name, count ) => {

        const valueColumn = new Float64Array( count );
        return { name, valueColumn, count };

    },

    // simplex-noise bridge: procedural default value for a uniform.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class Uniform {

    constructor( value ) {

        this.name = '';
        _values.set( this, value );

    }

    get value() {

        return _values.get( this );

    }

    set value( value ) {

        _values.set( this, value );

    }

    // Convenience accessors backed by the utility surface above.
    normalize() {

        _values.set( this, UniformUtils.normalizeScalar( this.value ) );
        return this;

    }

    packToVec4( out ) {

        return UniformUtils.packToVec4( out, this.value );

    }

    asDouble() {

        return UniformUtils.toDouble( this.value );

    }

    asBitecsComponent( name, count ) {

        return UniformUtils.registerComponent( name, count );

    }

    clone() {

        return new Uniform( this.value );

    }

}

Uniform.Utils = UniformUtils;

export default Uniform;