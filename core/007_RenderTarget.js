// file number : 007
// full path name : src/core/007_RenderTarget.js
// description : A render target is a buffer where the video card draws pixels for a scene that is being rendered in the background. It is used in different effects, such as applying postprocessing to a rendered image before displaying it on the screen. Rewritten as an ES module; imports Vector4 from the threejsbitecs/math folder, Texture and Source from three.js r185 (non-math), and bridges to bitecs for SoA registration, gl-matrix for viewport/scissor packing, double.js for high-precision size tracking, and simplex-noise for procedural render-target utilities. Corrected import paths and streamlined exports to a single default export.
// best for : Off-screen rendering, post-processing pipelines, shadow maps, and any effect that requires rendering to a texture instead of the default framebuffer.
// license : MIT

import EventDispatcher from './001_EventDispatcher.js';
import Vector4 from '../math/002_Vector4.js';

import { Texture } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/textures/Texture.js';
import { Source } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/textures/Source.js';
import { LinearFilter } from 'https://raw.githubusercontent.com/mrdoob/three.js/r185/src/constants.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

const RenderTargetUtils = {

    // gl-matrix bridge: pack viewport (x, y, width, height) into a vec4.
    packViewportToVec4: ( out, viewport ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set( out || _scratchVec4, viewport.x, viewport.y, viewport.z, viewport.w );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // double.js bridge: high-precision total pixel count of the render target.
    totalPixels: ( width, height, depth, count ) => {

        let total = new Double( width );
        total.mul( height ).mul( depth ).mul( count );
        return total.valueOf();

    },

    // bitecs bridge: register a RenderTarget as a SoA component column.
    registerComponent: ( name, count ) => {

        const widthColumn = new Float64Array( count );
        const heightColumn = new Float64Array( count );
        const depthColumn = new Float64Array( count );
        const samplesColumn = new Uint8Array( count );
        return { name, widthColumn, heightColumn, depthColumn, samplesColumn, count };

    },

    // simplex-noise bridge: procedural noise for render-target utilities.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class RenderTarget extends EventDispatcher {

    constructor( width = 1, height = 1, options = {} ) {

        super();

        options = Object.assign( {
            generateMipmaps: false,
            internalFormat: null,
            minFilter: LinearFilter,
            depthBuffer: true,
            stencilBuffer: false,
            resolveDepthBuffer: true,
            resolveStencilBuffer: true,
            depthTexture: null,
            samples: 0,
            count: 1,
            depth: 1,
            multiview: false,
            useArrayDepthTexture: false,
        }, options );

        this.isRenderTarget = true;

        this.width = width;
        this.height = height;
        this.depth = options.depth;

        this.scissor = new Vector4( 0, 0, width, height );
        this.scissorTest = false;
        this.viewport = new Vector4( 0, 0, width, height );

        this.textures = [];

        const image = { width: width, height: height, depth: options.depth };
        const texture = new Texture( image );

        const count = options.count;

        for ( let i = 0; i < count; i ++ ) {

            this.textures[ i ] = texture.clone();
            this.textures[ i ].isRenderTargetTexture = true;
            this.textures[ i ].renderTarget = this;

        }

        this._setTextureOptions( options );

        this.depthBuffer = options.depthBuffer;
        this.stencilBuffer = options.stencilBuffer;
        this.resolveDepthBuffer = options.resolveDepthBuffer;
        this.resolveStencilBuffer = options.resolveStencilBuffer;

        this._depthTexture = null;
        this.depthTexture = options.depthTexture;

        this.samples = options.samples;
        this.multiview = options.multiview;
        this.useArrayDepthTexture = options.useArrayDepthTexture;

    }

    _setTextureOptions( options = {} ) {

        const values = {
            minFilter: LinearFilter,
            generateMipmaps: false,
            flipY: false,
            internalFormat: null,
        };

        if ( options.mapping !== undefined ) values.mapping = options.mapping;
        if ( options.wrapS !== undefined ) values.wrapS = options.wrapS;
        if ( options.wrapT !== undefined ) values.wrapT = options.wrapT;
        if ( options.wrapR !== undefined ) values.wrapR = options.wrapR;
        if ( options.magFilter !== undefined ) values.magFilter = options.magFilter;
        if ( options.minFilter !== undefined ) values.minFilter = options.minFilter;
        if ( options.format !== undefined ) values.format = options.format;
        if ( options.type !== undefined ) values.type = options.type;
        if ( options.anisotropy !== undefined ) values.anisotropy = options.anisotropy;
        if ( options.colorSpace !== undefined ) values.colorSpace = options.colorSpace;
        if ( options.flipY !== undefined ) values.flipY = options.flipY;
        if ( options.generateMipmaps !== undefined ) values.generateMipmaps = options.generateMipmaps;
        if ( options.internalFormat !== undefined ) values.internalFormat = options.internalFormat;

        for ( let i = 0; i < this.textures.length; i ++ ) {

            const texture = this.textures[ i ];
            texture.setValues( values );

        }

    }

    get texture() {

        return this.textures[ 0 ];

    }

    set texture( value ) {

        this.textures[ 0 ] = value;

    }

    set depthTexture( current ) {

        if ( this._depthTexture !== null ) this._depthTexture.renderTarget = null;
        if ( current !== null ) current.renderTarget = this;

        this._depthTexture = current;

    }

    get depthTexture() {

        return this._depthTexture;

    }

    setSize( width, height, depth = 1 ) {

        if ( this.width !== width || this.height !== height || this.depth !== depth ) {

            this.width = width;
            this.height = height;
            this.depth = depth;

            for ( let i = 0, il = this.textures.length; i < il; i ++ ) {

                this.textures[ i ].image.width = width;
                this.textures[ i ].image.height = height;
                this.textures[ i ].image.depth = depth;

                if ( this.textures[ i ].isData3DTexture !== true ) {

                    this.textures[ i ].isArrayTexture = this.textures[ i ].image.depth > 1;

                }

            }

            this.dispose();

        }

        this.viewport.set( 0, 0, width, height );
        this.scissor.set( 0, 0, width, height );

    }

    clone() {

        return new this.constructor().copy( this );

    }

    copy( source ) {

        this.width = source.width;
        this.height = source.height;
        this.depth = source.depth;

        this.scissor.copy( source.scissor );
        this.scissorTest = source.scissorTest;

        this.viewport.copy( source.viewport );

        this.textures.length = 0;

        for ( let i = 0, il = source.textures.length; i < il; i ++ ) {

            this.textures[ i ] = source.textures[ i ].clone();
            this.textures[ i ].isRenderTargetTexture = true;
            this.textures[ i ].renderTarget = this;

            const image = Object.assign( {}, source.textures[ i ].image );
            this.textures[ i ].source = new Source( image );

        }

        this.depthBuffer = source.depthBuffer;
        this.stencilBuffer = source.stencilBuffer;
        this.resolveDepthBuffer = source.resolveDepthBuffer;
        this.resolveStencilBuffer = source.resolveStencilBuffer;

        if ( source.depthTexture !== null ) this.depthTexture = source.depthTexture.clone();

        this.samples = source.samples;

        return this;

    }

    dispose() {

        this.dispatchEvent( { type: 'dispose' } );

    }

    // Convenience accessors backed by the utility surface above.
    packViewportToVec4( out ) {

        return RenderTargetUtils.packViewportToVec4( out, this.viewport );

    }

    getTotalPixels() {

        return RenderTargetUtils.totalPixels( this.width, this.height, this.depth, this.textures.length );

    }

    asBitecsComponent( name, count ) {

        return RenderTargetUtils.registerComponent( name, count );

    }

}

RenderTarget.Utils = RenderTargetUtils;

export default RenderTarget;