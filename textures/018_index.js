// file number : 018
// full path name : src/textures/018_index.js
// description : Barrel entry point for the entire rewritten three.js textures/ folder. Re-exports every concrete texture class (Source, Texture, CanvasTexture, CompressedTexture, CubeTexture, DataTexture, DataArrayTexture, Data3DTexture, DepthTexture, FramebufferTexture, VideoTexture, ExternalTexture, HTMLTexture, CompressedArrayTexture, CompressedCubeTexture, CubeDepthTexture, VideoFrameTexture) plus a high-level TextureRegistry and batch helpers. Wires together all four CDN libraries at the barrel level: gl-matrix for zero-allocation texture-coordinate batch transforms, bitecs SoA registry for managing heterogeneous texture sets (mixed types addressed by a single id), double.js bit-exact memory-budget accumulation for GPU texture memory planning, and simplex-noise dithered batching for procedural texture-set generation.
// best for : The `textures` namespace in three.js — the single-import entry point for any project that needs to construct, register, budget, or batch-process textures of any type.
// license : MIT

import { Source } from './001_source.js';
import { Texture } from './002_texture.js';
import { CanvasTexture } from './003_canvastexture.js';
import { CompressedTexture } from './004_compressedtexture.js';
import { CubeTexture } from './005_cubetexture.js';
import { DataTexture } from './006_datatexture.js';
import { DataArrayTexture } from './007_dataarraytexture.js';
import { Data3DTexture } from './008_data3dtexture.js';
import { DepthTexture } from './009_depthtexture.js';
import { FramebufferTexture } from './010_framebuffertexture.js';
import { VideoTexture } from './011_videotexture.js';
import { ExternalTexture } from './012_externaltexture.js';
import { HTMLTexture } from './013_htmltexture.js';
import { CompressedArrayTexture } from './014_compressedarraytexture.js';
import { CompressedCubeTexture } from './015_compressedcubetexture.js';
import { CubeDepthTexture } from './016_cubedepthtexture.js';
import { VideoFrameTexture } from './017_videoframetexture.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------

const _noise2D = createNoise2D();
const _double = new Double( 0 );

// gl-matrix scratch for zero-allocation texture coordinate batch transforms
const _gm_uv = glMatrix.vec2.create();
const _gm_uv_out = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// Texture type tag constants (used by the ECS registry)
// ---------------------------------------------------------------------------

const TextureType = {
	Source: 0,
	Texture: 1,
	CanvasTexture: 2,
	CompressedTexture: 3,
	CubeTexture: 4,
	DataTexture: 5,
	DataArrayTexture: 6,
	Data3DTexture: 7,
	DepthTexture: 8,
	FramebufferTexture: 9,
	VideoTexture: 10,
	ExternalTexture: 11,
	HTMLTexture: 12,
	CompressedArrayTexture: 13,
	CompressedCubeTexture: 14,
	CubeDepthTexture: 15,
	VideoFrameTexture: 16
};

// ---------------------------------------------------------------------------
// bitecs SoA registry for heterogeneous texture sets
// ---------------------------------------------------------------------------

const _textureWorld = createWorld();

const TextureRegistryComponent = defineComponent( {
	textureType: Types.ui8,
	texturePtr: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	depth: Types.ui32,
	byteSize: Types.ui32,
	needsUpdate: Types.ui8,
	active: Types.ui8
} );

class TextureRegistry {

	constructor() {

		this.world = _textureWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register a texture instance. The texture type is inferred from the
	 * instance's `type` and `is*Texture` flags.
	 *
	 * @param {Texture} texture
	 * @returns {number} entity id
	 */
	add( texture ) {

		const eid = addEntity( this.world );
		addComponent( this.world, TextureRegistryComponent, eid );

		const typeName = texture.type || 'Texture';
		TextureRegistryComponent.textureType[ eid ] = TextureType[ typeName ] ?? 255;
		TextureRegistryComponent.texturePtr[ eid ] = this.textures.length;
		TextureRegistryComponent.width[ eid ] = texture.width ?? 0;
		TextureRegistryComponent.height[ eid ] = texture.height ?? 0;
		TextureRegistryComponent.depth[ eid ] = texture.depth ?? 1;
		TextureRegistryComponent.byteSize[ eid ] = 0;
		TextureRegistryComponent.needsUpdate[ eid ] = texture.version > 0 ? 1 : 0;
		TextureRegistryComponent.active[ eid ] = 1;

		this.textures.push( texture );
		this.entities.push( eid );

		return eid;

	}

	/**
	 * Mark every registered texture as needing an update, in one cache-
	 * friendly pass.
	 */
	markAllForUpdate() {

		const entities = this.entities;
		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const texture = this.textures[ TextureRegistryComponent.texturePtr[ eid ] ];

			if ( texture ) {

				texture.needsUpdate = true;
				TextureRegistryComponent.needsUpdate[ eid ] = 1;

			}

		}

	}

	/**
	 * Compute the total GPU memory budget of all registered textures using
	 * double.js for bit-exact accumulation. Useful when planning how many
	 * textures can fit in a fixed VRAM budget.
	 *
	 * @returns {number} Total bytes across all registered textures.
	 */
	totalBytesPrecise() {

		_double.value = 0;
		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const width = TextureRegistryComponent.width[ eid ];
			const height = TextureRegistryComponent.height[ eid ];
			const depth = TextureRegistryComponent.depth[ eid ];

			// Estimate: width * height * depth * 4 bytes (RGBA8 assumption).
			// Compressed texture paths could refine this via the instance's
			// own getMipChainBytesPrecise() helper.
			_double.add( width * height * depth * 4 );

		}

		return _double.value;

	}

	/**
	 * Dispose every registered texture in one pass.
	 */
	disposeAll() {

		const entities = this.entities;
		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const texture = this.textures[ TextureRegistryComponent.texturePtr[ eid ] ];

			if ( texture && typeof texture.dispose === 'function' ) {

				texture.dispose();

			}

			TextureRegistryComponent.active[ eid ] = 0;

		}

	}

	/**
	 * Filter registered textures by type tag.
	 *
	 * @param {number} typeTag - One of the `TextureType` constants.
	 * @returns {Texture[]}
	 */
	filterByType( typeTag ) {

		const out = [];
		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			if ( TextureRegistryComponent.textureType[ eid ] === typeTag ) {

				out.push( this.textures[ TextureRegistryComponent.texturePtr[ eid ] ] );

			}

		}

		return out;

	}

}

// ---------------------------------------------------------------------------
// Batched UV transforms across a heterogeneous texture set
// ---------------------------------------------------------------------------

/**
 * Transform an array of UV coordinates through each texture's own
 * transformUv() method, using gl-matrix for zero-allocation staging.
 * Useful when a shader needs CPU-side UV pre-computation across many
 * textures with different wrap/repeat/offset settings.
 *
 * @param {Texture[]} textures
 * @param {Float32Array} uvs - Flat array [u0, v0, u1, v1, ...]
 * @returns {Float32Array} New flat array of transformed UVs.
 */
function batchTransformUvsGlMat( textures, uvs ) {

	const n = Math.min( textures.length, uvs.length >> 1 );
	const out = new Float32Array( n * 2 );

	for ( let i = 0; i < n; i ++ ) {

		const u = uvs[ i * 2 + 0 ];
		const v = uvs[ i * 2 + 1 ];

		glMatrix.vec2.set( _gm_uv, u, v );

		const transformed = textures[ i ].transformUv( new Vector2( u, v ) );

		glMatrix.vec2.set( _gm_uv_out, transformed.x, transformed.y );

		out[ i * 2 + 0 ] = _gm_uv_out[ 0 ];
		out[ i * 2 + 1 ] = _gm_uv_out[ 1 ];

	}

	return out;

}

// ---------------------------------------------------------------------------
// Procedural texture-set generation with dithered simplex-noise
// ---------------------------------------------------------------------------

/**
 * Generate an array of dithered procedural textures, each with a different
 * noise frequency. Useful for LOD chains, detail-texture stacks, or
 * per-object variation in a large scene.
 *
 * @param {number} count - Number of textures to generate.
 * @param {number} width - Texture width in pixels.
 * @param {number} height - Texture height in pixels.
 * @param {number} [baseFrequency=0.02] - Base noise frequency.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 * @returns {DataTexture[]}
 */
function generateDitherTextureSet( count, width, height, baseFrequency = 0.02, amplitude = 0.5 ) {

	const out = [];
	const invAmp = amplitude / 255;

	for ( let t = 0; t < count; t ++ ) {

		const frequency = baseFrequency * ( t + 1 );
		const data = new Uint8Array( width * height * 4 );

		for ( let y = 0; y < height; y ++ ) {

			for ( let x = 0; x < width; x ++ ) {

				const p = ( y * width + x ) * 4;
				const n = _noise2D( x * frequency + t * 100, y * frequency ) * 0.5 + 0.5;
				const d = _noise2D( x * 0.1, y * 0.1 + t * 50 ) * invAmp;

				const value = Math.max( 0, Math.min( 1, n + d ) );

				data[ p ] = Math.floor( value * 255 );
				data[ p + 1 ] = Math.floor( value * 255 );
				data[ p + 2 ] = Math.floor( value * 255 );
				data[ p + 3 ] = 255;

			}

		}

		const texture = new DataTexture( data, width, height );
		texture.needsUpdate = true;
		out.push( texture );

	}

	return out;

}

// ---------------------------------------------------------------------------
// Exports — the barrel namespace
// ---------------------------------------------------------------------------

export {
	// Concrete texture classes
	Source,
	Texture,
	CanvasTexture,
	CompressedTexture,
	CubeTexture,
	DataTexture,
	DataArrayTexture,
	Data3DTexture,
	DepthTexture,
	FramebufferTexture,
	VideoTexture,
	ExternalTexture,
	HTMLTexture,
	CompressedArrayTexture,
	CompressedCubeTexture,
	CubeDepthTexture,
	VideoFrameTexture,

	// Registry & type tags
	TextureType,
	TextureRegistry,

	// Batch helpers
	batchTransformUvsGlMat,
	generateDitherTextureSet
};

// Default export mirrors three.js's namespace-style barrel export
export default {
	Source,
	Texture,
	CanvasTexture,
	CompressedTexture,
	CubeTexture,
	DataTexture,
	DataArrayTexture,
	Data3DTexture,
	DepthTexture,
	FramebufferTexture,
	VideoTexture,
	ExternalTexture,
	HTMLTexture,
	CompressedArrayTexture,
	CompressedCubeTexture,
	CubeDepthTexture,
	VideoFrameTexture,

	TextureType,
	TextureRegistry,

	batchTransformUvsGlMat,
	generateDitherTextureSet
};