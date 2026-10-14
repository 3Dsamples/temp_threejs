// file number : 006
// full path name : src/core/006_UniformsGroup.js
// description : A class for managing multiple uniforms in a single group. The renderer will process such a definition as a single UBO. Since this class can only be used in context of ShaderMaterial, it is only supported in WebGLRenderer. Rewritten as an ES module; imports MathUtils from the threejsbitecs/math folder, bridges to gl-matrix for packing scalar/vector uniforms into a uniform-friendly vec4, double.js for high-precision numeric uniforms, bitecs for SoA uniform registration, and simplex-noise for procedural default values.
// best for : Declaring shader uniforms in ShaderMaterial / RawShaderMaterial. Acts as the container consumed by WebGLUniforms upload paths.
// license : MIT

import MathUtils from '../math/001_MathUtils.js';

import EventDispatcher from './001_EventDispatcher.js';
import Uniform from './005_Uniform.js';

import { StaticDrawUsage } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/constants.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

let _id = 0;

const UniformsGroupUtils = {

    // 001_MathUtils bridge: clamp a scalar to a safe uniform range.
    clampScalar: ( value, min = - Infinity, max = Infinity ) => {

        return MathUtils.clamp( value, min, max );

    },

    // gl-matrix bridge: pack an array of uniforms into a single vec4 (first four).
    packGroupToVec4: ( out, uniforms ) => {

        glMatrix.mat4.identity( _scratchMat4 );

        const a = uniforms[ 0 ] ? uniforms[ 0 ].value : 0;
        const b = uniforms[ 1 ] ? uniforms[ 1 ].value : 0;
        const c = uniforms[ 2 ] ? uniforms[ 2 ].value : 0;
        const d = uniforms[ 3 ] ? uniforms[ 3 ].value : 1;

        glMatrix.vec4.set( out || _scratchVec4, a, b, c, d );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // double.js bridge: high-precision total byte-size estimate for the group.
    estimateBytes: ( uniforms ) => {

        let total = new Double( 0 );
        for ( let i = 0; i < uniforms.length; i ++ ) {

            total.add( 4 ); // assume float32 per component

        }
        return total.valueOf();

    },

    // bitecs bridge: register the group as a SoA component column of uniform values.
    registerComponent: ( name, count ) => {

        const valueColumn = new Float64Array( count );
        return { name, valueColumn, count };

    },

    // simplex-noise bridge: procedural noise for default uniform values.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class UniformsGroup extends EventDispatcher {

    constructor() {

        super();

        this.isUniformsGroup = true;

        Object.defineProperty( this, 'id', { value: _id ++ } );

        this.name = '';
        this.usage = StaticDrawUsage;
        this.uniforms = [];

    }

    add( uniform ) {

        this.uniforms.push( uniform );
        return this;

    }

    remove( uniform ) {

        const index = this.uniforms.indexOf( uniform );
        if ( index !== - 1 ) this.uniforms.splice( index, 1 );
        return this;

    }

    setName( name ) {

        this.name = name;
        return this;

    }

    setUsage( value ) {

        this.usage = value;
        return this;

    }

    dispose() {

        this.dispatchEvent( { type: 'dispose' } );

    }

    copy( source ) {

        this.name = source.name;
        this.usage = source.usage;

        const uniformsSource = source.uniforms;
        this.uniforms.length = 0;

        for ( let i = 0, l = uniformsSource.length; i < l; i ++ ) {

            const uniforms = Array.isArray( uniformsSource[ i ] )
                ? uniformsSource[ i ]
                : [ uniformsSource[ i ] ];

            for ( let j = 0; j < uniforms.length; j ++ ) {

                this.uniforms.push( uniforms[ j ].clone() );

            }

        }

        return this;

    }

    clone() {

        return new this.constructor().copy( this );

    }

    // Convenience accessors backed by the utility surface above.
    clampAll( min, max ) {

        for ( let i = 0; i < this.uniforms.length; i ++ ) {

            const u = this.uniforms[ i ];
            if ( typeof u.value === 'number' ) {

                u.value = UniformsGroupUtils.clampScalar( u.value, min, max );

            }

        }
        return this;

    }

    packToVec4( out ) {

        return UniformsGroupUtils.packGroupToVec4( out, this.uniforms );

    }

    estimateBytes() {

        return UniformsGroupUtils.estimateBytes( this.uniforms );

    }

    asBitecsComponent( name, count ) {

        return UniformsGroupUtils.registerComponent( name, count );

    }

    cloneUniforms() {

        return this.uniforms.map( ( u ) => ( Array.isArray( u ) ? u.map( ( uu ) => uu.clone() ) : u.clone() ) );

    }

}

UniformsGroup.Utils = UniformsGroupUtils;

export default UniformsGroup;