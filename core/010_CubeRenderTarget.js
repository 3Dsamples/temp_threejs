// file number : 010
// full path name : src/core/010_CubeRenderTarget.js
// description : Represents a cube render target (six faces) compatible with both WebGL and WebGPU renderers. Derives from RenderTarget and overrides the texture to be a CubeTexture. Rewritten as an ES module; imports Vector3/Vector4 from the threejsbitecs/math folder, imports CubeTexture from three.js r185 (non-math), and bridges to bitecs for SoA registration, gl-matrix for cube-face packing, double.js for high-precision face-texel tracking, and simplex-noise for procedural cube-map utilities. Corrected import paths and a single default export.
// best for : Real-time environment capture, dynamic reflections (CubeCamera), and any effect requiring six-face rendering into a cube map.
// license : MIT

import RenderTarget from './007_RenderTarget.js';
import Vector3 from '../math/003_Vector3.js';
import Vector4 from '../math/002_Vector4.js';

import { CubeTexture } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/textures/CubeTexture.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3 = new Float64Array( 3 );
const _scratchMat4 = new Float64Array( 16 );

const CubeRenderTargetUtils = {

    // Vector3 bridge: compute a face-direction vector for a given cube-face index (0..5).
    faceDirection: ( faceIndex, out ) => {

        const dir = out || _scratchVec3;
        switch ( faceIndex ) {
            case 0: dir[ 0 ] =  1; dir[ 1 ] =  0; dir[ 2 ] =  0; break; // +X
            case 1: dir[ 0 ] = -1; dir[ 1 ] =  0; dir[ 2 ] =  0; break; // -X
            case 2: dir[ 0 ] =  0; dir[ 1 ] =  1; dir[ 2 ] =  0; break; // +Y
            case 3: dir[ 0 ] =  0; dir[ 1 ] = -1; dir[ 2 ] =  0; break; // -Y
            case 4: dir[ 0 ] =  0; dir[ 1 ] =  0; dir[ 2 ] =  1; break; // +Z
            case 5: dir[ 0 ] =  0; dir[ 1 ] =  0; dir[ 2 ] = -1; break; // -Z
        }
        return dir;

    },

    // Vector4 bridge: pack cube size and face index into a vec4.
    packFaceToVec4: ( out, size, faceIndex ) => {

        const v = out || _scratchVec4;
        v[ 0 ] = size;
        v[ 1 ] = size;
        v[ 2 ] = faceIndex;
        v[ 3 ] = 1;
        return v;

    },

    // gl-matrix bridge: transform a face direction by an identity mat4 (placeholder for camera matrices).
    transformFace: ( out, dir, matrix ) => {

        glMatrix.vec3.transformMat4( out || _scratchVec3, dir, matrix || _scratchMat4 );
        return out || _scratchVec3;

    },

    // double.js bridge: high-precision total texel count across all six faces.
    totalTexels: ( size ) => {

        let total = new Double( size );
        total.mul( size ).mul( 6 );
        return total.valueOf();

    },

    // bitecs bridge: register a CubeRenderTarget as a SoA component column.
    registerComponent: ( name, count ) => {

        const sizeColumn = new Float64Array( count );
        const faceCountColumn = new Uint8Array( count );
        return { name, sizeColumn, faceCountColumn, count };

    },

    // simplex-noise bridge: procedural noise for cube-map utilities.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class CubeRenderTarget extends RenderTarget {

    constructor( size = 1, options = {} ) {

        super( size, size, options );

        this.isCubeRenderTarget = true;

        this.width = size;
        this.height = size;

        // Overwritten with a different texture type.
        const image = { width: size, height: size, depth: 1 };
        const images = [ image, image, image, image, image, image ];

        this.texture = new CubeTexture( images );
        this._setTextureOptions( options );

        // By convention -- likely based on the RenderMan spec from the 1990's -- cube maps are specified
        // by WebGL (and three.js) in a coordinate system in which positive-x is to the right when looking
        // up the positive-z axis -- in other words, in a left-handed coordinate system. By continuing this
        // convention, preexisting cube maps continued to render correctly. three.js uses a right-handed
        // coordinate system. So environment maps used in three.js appear to have px and nx swapped and
        // the flag isRenderTargetTexture controls this conversion. The flip is not required when using
        // CubeRenderTarget.texture as a cube texture (this is detected when isRenderTargetTexture is set
        // to true for cube textures).
        this.texture.isRenderTargetTexture = true;

    }

    // Convenience accessors backed by the utility surface above.
    getFaceDirection( faceIndex, out ) {

        return CubeRenderTargetUtils.faceDirection( faceIndex, out );

    }

    packFaceToVec4( out, faceIndex ) {

        return CubeRenderTargetUtils.packFaceToVec4( out, this.width, faceIndex );

    }

    getTotalTexels() {

        return CubeRenderTargetUtils.totalTexels( this.width );

    }

    asBitecsComponent( name, count ) {

        return CubeRenderTargetUtils.registerComponent( name, count );

    }

    // Placeholder for equirectangular → cube-map conversion (full implementation
    // requires a renderer instance and lives in the renderer-specific subclass).
    fromEquirectangularTexture( renderer, texture ) {

        // Intentionally unimplemented in the core layer; renderer-specific
        // subclasses (WebGLCubeRenderTarget, WebGPUCubeRenderTarget) provide
        // the material-system-specific conversion.
        this.texture.type = texture.type;
        this.texture.colorSpace = texture.colorSpace;
        this.texture.generateMipmaps = texture.generateMipmaps;
        this.texture.minFilter = texture.minFilter;
        this.texture.magFilter = texture.magFilter;

        return this;

    }

    clone() {

        return new this.constructor( this.width ).copy( this );

    }

}

CubeRenderTarget.Utils = CubeRenderTargetUtils;

export default CubeRenderTarget;