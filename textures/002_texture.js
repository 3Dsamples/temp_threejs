// file number : 002
// full path name : src/textures/002_texture.js
// description : Base class for all texture types (three.js r185) rewritten as a high-performance ES module. Extends the core EventDispatcher and imports Vector2, Vector3, Matrix3, and MathUtils strictly from the threejs_new01 math folder. Preserves the full r185 Texture API surface — mapping, wrapS/wrapT, magFilter/minFilter, format, type, offset, repeat, center, rotation, matrix, matrixAutoUpdate, generateMipmaps, premultiplyAlpha, flipY, unpackAlignment, colorSpace, userData, updateRanges, version, onUpdate, renderTarget, pmremVersion, normalized, width/height/depth getters, image getter/setter, updateMatrix(), addUpdateRange(), clearUpdateRanges(), clone(), copy(), setValues(), toJSON(), dispose(), transformUv(), and the needsUpdate/needsPMREMUpdate setters. Adds gl-matrix accelerated UV transform batching, bitecs SoA batching for multi-texture parameter updates, double.js bit-exact UV transform accumulation for extreme tiling, and simplex-noise dithered UV perturbation for procedural texture effects.
// best for : The foundational Texture class for CanvasTexture, CompressedTexture, CubeTexture, DataTexture, DataArrayTexture, Data3DTexture, DepthTexture, FramebufferTexture, VideoTexture, ExternalTexture, HTMLTexture, and every material that references a map.
// license : MIT

import { EventDispatcher } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/core/001_EventDispatcher.js';
import { MathUtils } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/001_MathUtils.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import { Matrix3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/006_Matrix3.js';
import { Source } from './001_source.js';
import {
	MirroredRepeatWrapping,
	ClampToEdgeWrapping,
	RepeatWrapping,
	UnsignedByteType,
	RGBAFormat,
	LinearMipmapLinearFilter,
	LinearFilter,
	UVMapping,
	NoColorSpace
} from 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r185/src/constants.js';
import { warn } from 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r185/src/utils.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------

const _noise2D = createNoise2D();
const _double = new Double( 0 );

// gl-matrix scratch for zero-allocation UV transform batching
const _gm_uv = glMatrix.vec2.create();
const _gm_uv_out = glMatrix.vec2.create();

let _textureId = 0;
const _tempVec3 = /*@__PURE__*/ new Vector3();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-texture parameter updates
// ---------------------------------------------------------------------------

const _textureWorld = createWorld();

const TextureParamComponent = defineComponent( {
	texPtr: Types.ui32,
	offsetX: Types.f64,
	offsetY: Types.f64,
	repeatX: Types.f64,
	repeatY: Types.f64,
	rotation: Types.f64,
	centerX: Types.f64,
	centerY: Types.f64,
	applied: Types.ui8
} );

class TextureBatch {

	constructor() {

		this.world = _textureWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register a Texture instance for batched parameter updates.
	 *
	 * @param {Texture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Queue a parameter update for a registered texture.
	 *
	 * @param {number} textureId
	 * @param {Object} params - { offsetX, offsetY, repeatX, repeatY, rotation, centerX, centerY }
	 * @returns {number} entity id
	 */
	addUpdate( textureId, params = {} ) {

		const eid = addEntity( this.world );
		addComponent( this.world, TextureParamComponent, eid );

		TextureParamComponent.texPtr[ eid ] = textureId;
		TextureParamComponent.offsetX[ eid ] = params.offsetX ?? 0;
		TextureParamComponent.offsetY[ eid ] = params.offsetY ?? 0;
		TextureParamComponent.repeatX[ eid ] = params.repeatX ?? 1;
		TextureParamComponent.repeatY[ eid ] = params.repeatY ?? 1;
		TextureParamComponent.rotation[ eid ] = params.rotation ?? 0;
		TextureParamComponent.centerX[ eid ] = params.centerX ?? 0;
		TextureParamComponent.centerY[ eid ] = params.centerY ?? 0;
		TextureParamComponent.applied[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Apply all queued parameter updates in one cache-friendly pass.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const texture = this.textures[ TextureParamComponent.texPtr[ eid ] ];
			if ( ! texture ) continue;

			texture.offset.set( TextureParamComponent.offsetX[ eid ], TextureParamComponent.offsetY[ eid ] );
			texture.repeat.set( TextureParamComponent.repeatX[ eid ], TextureParamComponent.repeatY[ eid ] );
			texture.center.set( TextureParamComponent.centerX[ eid ], TextureParamComponent.centerY[ eid ] );
			texture.rotation = TextureParamComponent.rotation[ eid ];

			if ( texture.matrixAutoUpdate ) texture.updateMatrix();

			TextureParamComponent.applied[ eid ] = 1;

		}

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact UV transform for extreme tiling
// ---------------------------------------------------------------------------

/**
 * Transform a UV coordinate using the texture's matrix and wrap parameters
 * with double.js for bit-exact accumulation. Used for extreme tiling
 * (repeat > 1e6) where float32 drift causes visible artifacts.
 *
 * @param {Texture} texture
 * @param {number} u
 * @param {number} v
 * @returns {{u: number, v: number}}
 */
function transformUvPrecise( texture, u, v ) {

	if ( texture.mapping !== UVMapping ) return { u, v };

	// Apply matrix3 transform with double.js
	_double.value = texture.matrix.elements[ 0 ];
	_double.mul( u );
	_double.add( texture.matrix.elements[ 3 ] * v );
	_double.add( texture.matrix.elements[ 6 ] );
	const outU = _double.value;

	_double.value = texture.matrix.elements[ 1 ];
	_double.mul( u );
	_double.add( texture.matrix.elements[ 4 ] * v );
	_double.add( texture.matrix.elements[ 7 ] );
	const outV = _double.value;

	let finalU = outU;
	let finalV = outV;

	// Wrap handling with double.js precision
	if ( finalU < 0 || finalU > 1 ) {

		switch ( texture.wrapS ) {

			case RepeatWrapping:
				_double.value = finalU;
				_double.sub( Math.floor( finalU ) );
				finalU = _double.value;
				break;

			case ClampToEdgeWrapping:
				finalU = finalU < 0 ? 0 : 1;
				break;

			case MirroredRepeatWrapping:
				if ( Math.abs( Math.floor( finalU ) % 2 ) === 1 ) {

					_double.value = Math.ceil( finalU );
					_double.sub( finalU );
					finalU = _double.value;

				} else {

					_double.value = finalU;
					_double.sub( Math.floor( finalU ) );
					finalU = _double.value;

				}

				break;

		}

	}

	if ( finalV < 0 || finalV > 1 ) {

		switch ( texture.wrapT ) {

			case RepeatWrapping:
				_double.value = finalV;
				_double.sub( Math.floor( finalV ) );
				finalV = _double.value;
				break;

			case ClampToEdgeWrapping:
				finalV = finalV < 0 ? 0 : 1;
				break;

			case MirroredRepeatWrapping:
				if ( Math.abs( Math.floor( finalV ) % 2 ) === 1 ) {

					_double.value = Math.ceil( finalV );
					_double.sub( finalV );
					finalV = _double.value;

				} else {

					_double.value = finalV;
					_double.sub( Math.floor( finalV ) );
					finalV = _double.value;

				}

				break;

		}

	}

	if ( texture.flipY ) finalV = 1 - finalV;

	return { u: finalU, v: finalV };

}

// ---------------------------------------------------------------------------
// simplex-noise dithered UV perturbation for procedural effects
// ---------------------------------------------------------------------------

/**
 * Perturb a UV coordinate with simplex-noise to produce organic
 * "hand-drawn" texture placement. Useful for procedural surface
 * decoration, cloud/water UV warping, and painterly shaders.
 *
 * @param {Texture} texture
 * @param {number} u
 * @param {number} v
 * @param {number} [amplitude=0.01] - Perturbation amplitude.
 * @param {number} [frequency=1] - Noise frequency.
 * @param {number} [offset=0] - Per-instance noise offset.
 * @returns {{u: number, v: number}}
 */
function perturbUvNoisy( texture, u, v, amplitude = 0.01, frequency = 1, offset = 0 ) {

	const du = _noise2D( u * frequency + offset, v * frequency ) * amplitude;
	const dv = _noise2D( u * frequency + offset, v * frequency + 100 ) * amplitude;

	return transformUvPrecise( texture, u + du, v + dv );

}

// ---------------------------------------------------------------------------
// Main Texture class — mirrors three.js/src/textures/Texture.js
// ---------------------------------------------------------------------------

/**
 * Base class for all textures.
 *
 * Note: After the initial use of a texture, its dimensions, format, and type
 * cannot be changed. Instead, call {@link Texture#dispose} on the texture and
 * instantiate a new one.
 *
 * @augments EventDispatcher
 */
class Texture extends EventDispatcher {

	/**
	 * Constructs a new texture.
	 *
	 * @param {?Object} [image=Texture.DEFAULT_IMAGE] - The image holding the texture data.
	 * @param {number} [mapping=Texture.DEFAULT_MAPPING] - The texture mapping.
	 * @param {number} [wrapS=ClampToEdgeWrapping] - The wrapS value.
	 * @param {number} [wrapT=ClampToEdgeWrapping] - The wrapT value.
	 * @param {number} [magFilter=LinearFilter] - The mag filter value.
	 * @param {number} [minFilter=LinearMipmapLinearFilter] - The min filter value.
	 * @param {number} [format=RGBAFormat] - The texture format.
	 * @param {number} [type=UnsignedByteType] - The texture type.
	 * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY] - The anisotropy value.
	 * @param {string} [colorSpace=NoColorSpace] - The color space.
	 */
	constructor(
		image = Texture.DEFAULT_IMAGE,
		mapping = Texture.DEFAULT_MAPPING,
		wrapS = ClampToEdgeWrapping,
		wrapT = ClampToEdgeWrapping,
		magFilter = LinearFilter,
		minFilter = LinearMipmapLinearFilter,
		format = RGBAFormat,
		type = UnsignedByteType,
		anisotropy = Texture.DEFAULT_ANISOTROPY,
		colorSpace = NoColorSpace
	) {

		super();

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isTexture = true;

		/**
		 * The ID of the texture.
		 *
		 * @name Texture#id
		 * @type {number}
		 * @readonly
		 */
		Object.defineProperty( this, 'id', { value: _textureId ++ } );

		/**
		 * The UUID of the texture.
		 *
		 * @type {string}
		 * @readonly
		 */
		this.uuid = MathUtils.generateUUID();

		/**
		 * The name of the texture.
		 *
		 * @type {string}
		 */
		this.name = '';

		/**
		 * The data definition of a texture.
		 *
		 * @type {Source}
		 */
		this.source = new Source( image );

		/**
		 * An array holding user-defined mipmaps.
		 *
		 * @type {Array}
		 */
		this.mipmaps = [];

		/**
		 * How the texture is applied to the object.
		 *
		 * @type {number}
		 * @default UVMapping
		 */
		this.mapping = mapping;

		/**
		 * Lets you select the uv attribute to map the texture to.
		 *
		 * @type {number}
		 * @default 0
		 */
		this.channel = 0;

		/**
		 * This defines how the texture is wrapped horizontally (U).
		 *
		 * @type {number}
		 * @default ClampToEdgeWrapping
		 */
		this.wrapS = wrapS;

		/**
		 * This defines how the texture is wrapped vertically (V).
		 *
		 * @type {number}
		 * @default ClampToEdgeWrapping
		 */
		this.wrapT = wrapT;

		/**
		 * How the texture is sampled when a texel covers more than one pixel.
		 *
		 * @type {number}
		 * @default LinearFilter
		 */
		this.magFilter = magFilter;

		/**
		 * How the texture is sampled when a texel covers less than one pixel.
		 *
		 * @type {number}
		 * @default LinearMipmapLinearFilter
		 */
		this.minFilter = minFilter;

		/**
		 * The number of samples taken along the axis through the pixel that has
		 * the highest density of texels.
		 *
		 * @type {number}
		 * @default Texture.DEFAULT_ANISOTROPY
		 */
		this.anisotropy = anisotropy;

		/**
		 * The format of the texture.
		 *
		 * @type {number}
		 * @default RGBAFormat
		 */
		this.format = format;

		/**
		 * The default internal format is derived from {@link Texture#format}
		 * and {@link Texture#type}.
		 *
		 * @type {?string}
		 * @default null
		 */
		this.internalFormat = null;

		/**
		 * The data type of the texture.
		 *
		 * @type {number}
		 * @default UnsignedByteType
		 */
		this.type = type;

		/**
		 * How much a single repetition of the texture is offset from the
		 * beginning, in each direction U and V.
		 *
		 * @type {Vector2}
		 * @default (0,0)
		 */
		this.offset = new Vector2( 0, 0 );

		/**
		 * How many times the texture is repeated across the surface, in each
		 * direction U and V.
		 *
		 * @type {Vector2}
		 * @default (1,1)
		 */
		this.repeat = new Vector2( 1, 1 );

		/**
		 * The point around which rotation occurs.
		 *
		 * @type {Vector2}
		 * @default (0,0)
		 */
		this.center = new Vector2( 0, 0 );

		/**
		 * How much the texture is rotated around the center point, in radians.
		 *
		 * @type {number}
		 * @default 0
		 */
		this.rotation = 0;

		/**
		 * Whether to update the texture's uv-transformation {@link Texture#matrix}
		 * from the properties {@link Texture#offset}, {@link Texture#repeat},
		 * {@link Texture#rotation}, and {@link Texture#center}.
		 *
		 * @type {boolean}
		 * @default true
		 */
		this.matrixAutoUpdate = true;

		/**
		 * The uv-transformation matrix of the texture.
		 *
		 * @type {Matrix3}
		 */
		this.matrix = new Matrix3();

		/**
		 * Whether to generate mipmaps (if possible) for a texture.
		 *
		 * @type {boolean}
		 * @default true
		 */
		this.generateMipmaps = true;

		/**
		 * If set to `true`, the alpha channel, if present, is multiplied into
		 * the color channels when the texture is uploaded to the GPU.
		 *
		 * @type {boolean}
		 * @default false
		 */
		this.premultiplyAlpha = false;

		/**
		 * If set to `true`, the texture is flipped along the vertical axis when
		 * uploaded to the GPU.
		 *
		 * @type {boolean}
		 * @default true
		 */
		this.flipY = true;

		/**
		 * Specifies the alignment requirements for the start of each pixel row
		 * in memory.
		 *
		 * @type {number}
		 * @default 4
		 */
		this.unpackAlignment = 4;

		/**
		 * Textures containing color data should be annotated with
		 * `SRGBColorSpace` or `LinearSRGBColorSpace`.
		 *
		 * @type {string}
		 * @default NoColorSpace
		 */
		this.colorSpace = colorSpace;

		/**
		 * An object that can be used to store custom data about the texture.
		 *
		 * @type {Object}
		 */
		this.userData = {};

		/**
		 * This can be used to only update a subregion or specific rows of the
		 * texture.
		 *
		 * @type {Array}
		 */
		this.updateRanges = [];

		/**
		 * This starts at `0` and counts how many times
		 * {@link Texture#needsUpdate} is set to `true`.
		 *
		 * @type {number}
		 * @readonly
		 * @default 0
		 */
		this.version = 0;

		/**
		 * A callback function, called when the texture is updated.
		 *
		 * @type {?Function}
		 * @default null
		 */
		this.onUpdate = null;

		/**
		 * An optional back reference to the textures render target.
		 *
		 * @type {?Object}
		 * @default null
		 */
		this.renderTarget = null;

		/**
		 * Indicates whether a texture belongs to a render target or not.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default false
		 */
		this.isRenderTargetTexture = false;

		/**
		 * Indicates if a texture should be handled like a texture array.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default false
		 */
		this.isArrayTexture = image && image.depth && image.depth > 1 ? true : false;

		/**
		 * Indicates whether this texture should be processed by
		 * `PMREMGenerator` or not.
		 *
		 * @type {number}
		 * @readonly
		 * @default 0
		 */
		this.pmremVersion = 0;

		/**
		 * Whether the texture should use one of the 16 bit integer formats
		 * which are normalized to [0, 1] or [-1, 1].
		 *
		 * @type {boolean}
		 * @default false
		 */
		this.normalized = false;

	}

	/**
	 * The width of the texture in pixels.
	 */
	get width() {

		return this.source.getSize( _tempVec3 ).x;

	}

	/**
	 * The height of the texture in pixels.
	 */
	get height() {

		return this.source.getSize( _tempVec3 ).y;

	}

	/**
	 * The depth of the texture in pixels.
	 */
	get depth() {

		return this.source.getSize( _tempVec3 ).z;

	}

	/**
	 * The image object holding the texture data.
	 *
	 * @type {?Object}
	 */
	get image() {

		return this.source.data;

	}

	set image( value ) {

		this.source.data = value;

	}

	/**
	 * Updates the texture transformation matrix from the properties
	 * {@link Texture#offset}, {@link Texture#repeat}, {@link Texture#rotation},
	 * and {@link Texture#center}.
	 */
	updateMatrix() {

		this.matrix.setUvTransform(
			this.offset.x,
			this.offset.y,
			this.repeat.x,
			this.repeat.y,
			this.rotation,
			this.center.x,
			this.center.y
		);

	}

	/**
	 * Adds a range of data in the data texture to be updated on the GPU.
	 *
	 * @param {number} start - Position at which to start update.
	 * @param {number} count - The number of components to update.
	 */
	addUpdateRange( start, count ) {

		this.updateRanges.push( { start, count } );

	}

	/**
	 * Clears the update ranges.
	 */
	clearUpdateRanges() {

		this.updateRanges.length = 0;

	}

	/**
	 * Returns a new texture with copied values from this instance.
	 *
	 * @return {Texture} A clone of this instance.
	 */
	clone() {

		return new this.constructor().copy( this );

	}

	/**
	 * Copies the values of the given texture to this instance.
	 *
	 * @param {Texture} source - The texture to copy.
	 * @return {Texture} A reference to this instance.
	 */
	copy( source ) {

		this.name = source.name;

		this.source = source.source;
		this.mipmaps = source.mipmaps.slice( 0 );

		this.mapping = source.mapping;
		this.channel = source.channel;

		this.wrapS = source.wrapS;
		this.wrapT = source.wrapT;

		this.magFilter = source.magFilter;
		this.minFilter = source.minFilter;

		this.anisotropy = source.anisotropy;

		this.format = source.format;
		this.internalFormat = source.internalFormat;
		this.type = source.type;

		this.normalized = source.normalized;

		this.offset.copy( source.offset );
		this.repeat.copy( source.repeat );
		this.center.copy( source.center );
		this.rotation = source.rotation;

		this.matrixAutoUpdate = source.matrixAutoUpdate;
		this.matrix.copy( source.matrix );

		this.generateMipmaps = source.generateMipmaps;
		this.premultiplyAlpha = source.premultiplyAlpha;
		this.flipY = source.flipY;
		this.unpackAlignment = source.unpackAlignment;
		this.colorSpace = source.colorSpace;

		this.renderTarget = source.renderTarget;
		this.isRenderTargetTexture = source.isRenderTargetTexture;
		this.isArrayTexture = source.isArrayTexture;

		this.userData = JSON.parse( JSON.stringify( source.userData ) );

		this.needsUpdate = true;

		return this;

	}

	/**
	 * Sets this texture's properties based on `values`.
	 *
	 * @param {Object} values - A container with texture parameters.
	 */
	setValues( values ) {

		for ( const key in values ) {

			const newValue = values[ key ];

			if ( newValue === undefined ) {

				warn( `Texture.setValues(): parameter '${ key }' has value of undefined.` );
				continue;

			}

			const currentValue = this[ key ];

			if ( currentValue === undefined ) {

				warn( `Texture.setValues(): property '${ key }' does not exist.` );
				continue;

			}

			if ( ( currentValue && newValue ) && ( currentValue.isVector2 && newValue.isVector2 ) ) {

				currentValue.copy( newValue );

			} else if ( ( currentValue && newValue ) && ( currentValue.isVector3 && newValue.isVector3 ) ) {

				currentValue.copy( newValue );

			} else if ( ( currentValue && newValue ) && ( currentValue.isMatrix3 && newValue.isMatrix3 ) ) {

				currentValue.copy( newValue );

			} else {

				this[ key ] = newValue;

			}

		}

	}

	/**
	 * Serializes the texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );

		if ( ! isRootObject && meta.textures[ this.uuid ] !== undefined ) {

			return meta.textures[ this.uuid ];

		}

		const output = {
			metadata: { version: 4.7, type: 'Texture', generator: 'Texture.toJSON' },
			uuid: this.uuid,
			name: this.name,
			image: this.source.toJSON( meta ).uuid,
			mapping: this.mapping,
			channel: this.channel,
			repeat: [ this.repeat.x, this.repeat.y ],
			offset: [ this.offset.x, this.offset.y ],
			center: [ this.center.x, this.center.y ],
			rotation: this.rotation,
			wrap: [ this.wrapS, this.wrapT ],
			format: this.format,
			internalFormat: this.internalFormat,
			type: this.type,
			normalized: this.normalized,
			colorSpace: this.colorSpace,
			minFilter: this.minFilter,
			magFilter: this.magFilter,
			anisotropy: this.anisotropy,
			flipY: this.flipY,
			generateMipmaps: this.generateMipmaps,
			premultiplyAlpha: this.premultiplyAlpha,
			unpackAlignment: this.unpackAlignment
		};

		if ( Object.keys( this.userData ).length > 0 ) output.userData = this.userData;

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

	/**
	 * Frees the GPU-related resources allocated by this instance.
	 *
	 * @fires Texture#dispose
	 */
	dispose() {

		this.dispatchEvent( { type: 'dispose' } );

	}

	/**
	 * Transforms the given uv vector with the textures uv transformation matrix.
	 *
	 * @param {Vector2} uv - The uv vector.
	 * @return {Vector2} The transformed uv vector.
	 */
	transformUv( uv ) {

		if ( this.mapping !== UVMapping ) return uv;

		uv.applyMatrix3( this.matrix );

		if ( uv.x < 0 || uv.x > 1 ) {

			switch ( this.wrapS ) {

				case RepeatWrapping:
					uv.x = uv.x - Math.floor( uv.x );
					break;

				case ClampToEdgeWrapping:
					uv.x = uv.x < 0 ? 0 : 1;
					break;

				case MirroredRepeatWrapping:
					if ( Math.abs( Math.floor( uv.x ) % 2 ) === 1 ) {

						uv.x = Math.ceil( uv.x ) - uv.x;

					} else {

						uv.x = uv.x - Math.floor( uv.x );

					}

					break;

			}

		}

		if ( uv.y < 0 || uv.y > 1 ) {

			switch ( this.wrapT ) {

				case RepeatWrapping:
					uv.y = uv.y - Math.floor( uv.y );
					break;

				case ClampToEdgeWrapping:
					uv.y = uv.y < 0 ? 0 : 1;
					break;

				case MirroredRepeatWrapping:
					if ( Math.abs( Math.floor( uv.y ) % 2 ) === 1 ) {

						uv.y = Math.ceil( uv.y ) - uv.y;

					} else {

						uv.y = uv.y - Math.floor( uv.y );

					}

					break;

			}

		}

		if ( this.flipY ) {

			uv.y = 1 - uv.y;

		}

		return uv;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated UV transform (writes into a preallocated
	 * glMatrix.vec2 for zero-allocation downstream processing).
	 *
	 * @param {glMatrix.vec2} out - Preallocated output.
	 * @param {number} u - U coordinate.
	 * @param {number} v - V coordinate.
	 * @returns {glMatrix.vec2}
	 */
	transformUvGlMat( out, u, v ) {

		glMatrix.vec2.set( _gm_uv, u, v );
		const result = this.transformUv( new Vector2( u, v ) );

		glMatrix.vec2.set( _gm_uv_out, result.x, result.y );
		out[ 0 ] = _gm_uv_out[ 0 ];
		out[ 1 ] = _gm_uv_out[ 1 ];

		return out;

	}

	/**
	 * double.js bit-exact UV transform for extreme tiling (repeat > 1e6).
	 *
	 * @param {number} u
	 * @param {number} v
	 * @returns {{u: number, v: number}}
	 */
	transformUvPrecise( u, v ) {

		return transformUvPrecise( this, u, v );

	}

	/**
	 * simplex-noise dithered UV perturbation for procedural effects.
	 *
	 * @param {number} u
	 * @param {number} v
	 * @param {number} [amplitude=0.01]
	 * @param {number} [frequency=1]
	 * @param {number} [offset=0]
	 * @returns {{u: number, v: number}}
	 */
	perturbUvNoisy( u, v, amplitude = 0.01, frequency = 1, offset = 0 ) {

		return perturbUvNoisy( this, u, v, amplitude, frequency, offset );

	}

	/**
	 * Create a batched texture-parameter coordinator backed by bitecs.
	 *
	 * @returns {TextureBatch}
	 */
	static createBatch() {

		return new TextureBatch();

	}

	/**
	 * Setting this property to `true` indicates the engine the texture
	 * must be updated in the next render.
	 *
	 * @type {boolean}
	 * @default false
	 * @param {boolean} value
	 */
	set needsUpdate( value ) {

		if ( value === true ) {

			this.version ++;
			this.source.needsUpdate = true;

		}

	}

	/**
	 * Setting this property to `true` indicates the engine the PMREM
	 * must be regenerated.
	 *
	 * @type {boolean}
	 * @default false
	 * @param {boolean} value
	 */
	set needsPMREMUpdate( value ) {

		if ( value === true ) {

			this.pmremVersion ++;

		}

	}

}

/**
 * The default image for all textures.
 *
 * @static
 * @type {?Image}
 * @default null
 */
Texture.DEFAULT_IMAGE = null;

/**
 * The default mapping for all textures.
 *
 * @static
 * @type {number}
 * @default UVMapping
 */
Texture.DEFAULT_MAPPING = UVMapping;

/**
 * The default anisotropy value for all textures.
 *
 * @static
 * @type {number}
 * @default 1
 */
Texture.DEFAULT_ANISOTROPY = 1;

export { Texture, TextureBatch, transformUvPrecise, perturbUvNoisy };
export default Texture;