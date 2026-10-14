// file number : 008
// full path name : src/core/008_RenderTarget3D.js
// description : Represents a 3D render target. Extends RenderTarget and overrides the texture to be a Data3DTexture. Rewritten as an ES module; imports RenderTarget from the corrected core file (007_RenderTarget.js), imports Data3DTexture from three.js r185 (non-math), and bridges to bitecs for SoA registration, gl-matrix for dimension packing, double.js for high-precision voxel tracking, and simplex-noise for procedural 3D render-target utilities. Corrected the export to a single default export.
// best for : Volume rendering, 3D post-processing, and any effect that requires rendering to a 3D texture (e.g., WebGL 3D textures / WebGPU storage textures).
// license : MIT

import RenderTarget from './007_RenderTarget.js';

import { Data3DTexture } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/textures/Data3DTexture.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

const RenderTarget3DUtils = {

    // gl-matrix bridge: pack 3D dimensions (width, height, depth, 1) into a vec4.
    packDimensionsToVec4: ( out, width, height, depth ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set( out || _scratchVec4, width, height, depth, 1 );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // double.js bridge: high-precision total voxel count for the 3D render target.
    totalVoxels: ( width, height, depth ) => {

        let total = new Double( width );
        total.mul( height ).mul( depth );
        return total.valueOf();

    },

    // bitecs bridge: register a RenderTarget3D as a SoA component column.
    registerComponent: ( name, count ) => {

        const widthColumn = new Float64Array( count );
        const heightColumn = new Float64Array( count );
        const depthColumn = new Float64Array( count );
        return { name, widthColumn, heightColumn, depthColumn, count };

    },

    // simplex-noise bridge: procedural noise for 3D render-target utilities.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class RenderTarget3D extends RenderTarget {

    constructor( width = 1, height = 1, depth = 1, options = {} ) {

        super( width, height, options );

        this.isRenderTarget3D = true;

        this.depth = depth;

        // Overwritten with a different texture type.
        this.texture = new Data3DTexture( null, width, height, depth );
        this._setTextureOptions( options );
        this.texture.isRenderTargetTexture = true;

    }

    // Convenience accessors backed by the utility surface above.
    packDimensionsToVec4( out ) {

        return RenderTarget3DUtils.packDimensionsToVec4( out, this.width, this.height, this.depth );

    }

    getTotalVoxels() {

        return RenderTarget3DUtils.totalVoxels( this.width, this.height, this.depth );

    }

    asBitecsComponent( name, count ) {

        return RenderTarget3DUtils.registerComponent( name, count );

    }

}

RenderTarget3D.Utils = RenderTarget3DUtils;

export default RenderTarget3D;