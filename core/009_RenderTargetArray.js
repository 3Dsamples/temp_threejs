// file number : 009
// full path name : src/core/009_RenderTargetArray.js
// description : Represents an array render target. Extends RenderTarget and overrides the texture to be a DataArrayTexture. Rewritten as an ES module; imports RenderTarget from the corrected core file (007_RenderTarget.js), imports DataArrayTexture from three.js r185 (non-math), and bridges to bitecs for SoA registration, gl-matrix for layer-index packing, double.js for high-precision layer-count tracking, and simplex-noise for procedural array render-target utilities. Corrected the export to a single default export.
// best for : Rendering to 2D texture arrays (sampler2DArray), multi-layer post-processing, and any effect that requires per-layer slices in a single texture object.
// license : MIT

import RenderTarget from './007_RenderTarget.js';

import { DataArrayTexture } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/textures/DataArrayTexture.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

const RenderTargetArrayUtils = {

    // gl-matrix bridge: pack (width, height, depth, layerIndex) into a vec4.
    packLayerToVec4: ( out, width, height, depth, layerIndex = 0 ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set( out || _scratchVec4, width, height, depth, layerIndex );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // double.js bridge: high-precision total texel count across all layers.
    totalTexels: ( width, height, depth ) => {

        let total = new Double( width );
        total.mul( height ).mul( depth );
        return total.valueOf();

    },

    // bitecs bridge: register a RenderTargetArray as a SoA component column.
    registerComponent: ( name, count ) => {

        const widthColumn = new Float64Array( count );
        const heightColumn = new Float64Array( count );
        const depthColumn = new Float64Array( count );
        return { name, widthColumn, heightColumn, depthColumn, count };

    },

    // simplex-noise bridge: procedural noise for array render-target utilities.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class RenderTargetArray extends RenderTarget {

    constructor( width = 1, height = 1, depth = 1, options = {} ) {

        super( width, height, options );

        this.isRenderTargetArray = true;

        this.depth = depth;

        // Overwritten with a different texture type.
        this.texture = new DataArrayTexture( null, width, height, depth );
        this._setTextureOptions( options );
        this.texture.isRenderTargetTexture = true;

    }

    // Convenience accessors backed by the utility surface above.
    packLayerToVec4( out, layerIndex = 0 ) {

        return RenderTargetArrayUtils.packLayerToVec4( out, this.width, this.height, this.depth, layerIndex );

    }

    getTotalTexels() {

        return RenderTargetArrayUtils.totalTexels( this.width, this.height, this.depth );

    }

    asBitecsComponent( name, count ) {

        return RenderTargetArrayUtils.registerComponent( name, count );

    }

    // Mark a single layer for partial upload (forwards to DataArrayTexture).
    addLayerUpdate( layerIndex ) {

        if ( this.texture && typeof this.texture.addLayerUpdate === 'function' ) {

            this.texture.addLayerUpdate( layerIndex );

        }

        return this;

    }

    clearLayerUpdates() {

        if ( this.texture && typeof this.texture.clearLayerUpdates === 'function' ) {

            this.texture.clearLayerUpdates();

        }

        return this;

    }

}

RenderTargetArray.Utils = RenderTargetArrayUtils;

export default RenderTargetArray;