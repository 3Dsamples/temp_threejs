// file number : 012
// full path name : src/core/012_InstancedBufferAttribute.js
// description : An instanced version of a buffer attribute. Extends BufferAttribute and adds meshPerAttribute to control how often each value is repeated across instances. Rewritten as an ES module; imports BufferAttribute from the corrected core file (011_BufferAttribute.js), consumes 001_MathUtils, 002_Vector2, 003_Vector3, and 016_Vector4 from the threejsbitecs/math folder, imports the non-math three.js r185 constants and DataUtils, and bridges to bitecs for SoA instanced-attribute registration, gl-matrix for packing the instanced header into a vec4, double.js for high-precision mesh-per-attribute byte tracking, and simplex-noise for procedural instanced-attribute generators. Corrected import paths and a single default export.
// best for : Instanced rendering (InstancedMesh, InstancedBufferGeometry). Per-instance transforms, colors, and any attribute whose value applies to groups of instances.
// license : MIT

import BufferAttribute from './011_BufferAttribute.js';

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

const _vector = new Vector3();
const _vector2 = new Vector2();

const InstancedBufferAttributeUtils = {

    // 001_MathUtils bridge: clamp meshPerAttribute to a valid positive integer.
    clampMeshPerAttribute: ( value ) => {

        return MathUtils.clamp( Math.floor( value ), 1, Infinity );

    },

    // 001_MathUtils bridge: denormalize a normalized instanced value.
    denormalize: ( value, array ) => {

        return MathUtils.denormalize( value, array );

    },

    // 001_MathUtils bridge: normalize an instanced value.
    normalize: ( value, array ) => {

        return MathUtils.normalize( value, array );

    },

    // 001_MathUtils bridge: generate a UUID for anonymous instanced attributes.
    generateUUID: () => {

        return MathUtils.generateUUID();

    },

    // gl-matrix bridge: pack the instanced header (itemSize, count, meshPerAttribute, version) into a vec4.
    packInstancedHeaderToVec4: ( out, itemSize, count, meshPerAttribute, version ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set( out || _scratchVec4, itemSize, count, meshPerAttribute, version );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // double.js bridge: high-precision effective byte length including meshPerAttribute repetition.
    effectiveBytes: ( array, itemSize, count, meshPerAttribute ) => {

        let total = new Double( array.BYTES_PER_ELEMENT || 4 );
        total.mul( itemSize ).mul( count ).div( meshPerAttribute );
        return total.valueOf();

    },

    // bitecs bridge: register an instanced attribute as a SoA component column.
    registerComponent: ( name, count, itemSize, meshPerAttribute ) => {

        const column = new Float32Array( count * itemSize );
        return { name, column, itemSize, meshPerAttribute, count };

    },

    // simplex-noise bridge: procedural noise for instanced-attribute generators.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class InstancedBufferAttribute extends BufferAttribute {

    constructor( array, itemSize, normalized = false, meshPerAttribute = 1 ) {

        super( array, itemSize, normalized );

        this.isInstancedBufferAttribute = true;

        this.meshPerAttribute = meshPerAttribute;

    }

    copy( source ) {

        super.copy( source );

        this.meshPerAttribute = source.meshPerAttribute;

        return this;

    }

    toJSON() {

        const data = super.toJSON();

        data.meshPerAttribute = this.meshPerAttribute;
        data.isInstancedBufferAttribute = true;

        return data;

    }

    // Convenience accessors backed by the utility surface above.
    clampMeshPerAttribute() {

        this.meshPerAttribute = InstancedBufferAttributeUtils.clampMeshPerAttribute( this.meshPerAttribute );
        return this;

    }

    packInstancedHeaderToVec4( out ) {

        return InstancedBufferAttributeUtils.packInstancedHeaderToVec4(
            out, this.itemSize, this.count, this.meshPerAttribute, this.version
        );

    }

    getEffectiveBytes() {

        return InstancedBufferAttributeUtils.effectiveBytes(
            this.array, this.itemSize, this.count, this.meshPerAttribute
        );

    }

    asBitecsComponent( name ) {

        return InstancedBufferAttributeUtils.registerComponent(
            name, this.count, this.itemSize, this.meshPerAttribute
        );

    }

}

InstancedBufferAttribute.Utils = InstancedBufferAttributeUtils;

export default InstancedBufferAttribute;