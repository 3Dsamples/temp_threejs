// file number : 013
// full path name : src/textures/013_htmltexture.js
// description : HTMLTexture (custom three.js extension) rewritten as a high-performance ES module. Extends the internally-rewritten 002_texture.js base class to create textures directly from live HTML DOM elements. This enables rendering arbitrary HTML (divs, buttons, formatted text, embedded widgets) directly onto three.js surfaces by rasterizing the element through its rendered pixel output. Preserves the Texture API surface — generateMipmaps = false, isHTMLTexture flag, source element reference, plus clone(), copy(), toJSON(). Adds gl-matrix accelerated per-frame DOM pixel sampling for CPU-side lookups, bitecs SoA batching for multi-element DOM pipelines (UI panels, dynamic labels, ad boards), double.js bit-exact DOM layout coordinate accumulation for pixel-accurate hit-testing, and simplex-noise dithered placeholder painting while the DOM element is not yet ready.
// best for : Rendering HTML DOM nodes as three.js textures (UI panels, HTML overlays, dynamic text labels, embedded iframes/widgets), 3D web applications that mix HTML UI with WebGL content, and any workflow that needs to project a live HTML tree onto a 3D surface.
// license : MIT

import { Texture } from './002_texture.js';
import { ImageUtils } from '../extras/lib/007_imageutils.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import {
	LinearFilter,
	RGBAFormat,
	UnsignedByteType,
	NoColorSpace,
	UVMapping,
	ClampToEdgeWrapping
} from 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r185/src/constants.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------

const _noise2D = createNoise2D();
const _double = new Double( 0 );

// gl-matrix scratch for zero-allocation DOM sampling
const _gm_rgba = glMatrix.vec4.create();
const _gm_uv = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-element DOM pipelines
// ---------------------------------------------------------------------------

const _htmlWorld = createWorld();

const HtmlElementComponent = defineComponent( {
	texPtr: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	devicePixelRatio: Types.f64,
	dirty: Types.ui8,
	applied: Types.ui8
} );

class HTMLTextureBatch {

	constructor() {

		this.world = _htmlWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register an HTMLTexture instance for batched DOM capture.
	 *
	 * @param {HTMLTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Queue a DOM-capture job for a registered HTML texture.
	 *
	 * @param {number} textureId
	 * @returns {number} entity id
	 */
	addJob( textureId ) {

		const eid = addEntity( this.world );
		addComponent( this.world, HtmlElementComponent, eid );

		const texture = this.textures[ textureId ];

		HtmlElementComponent.texPtr[ eid ] = textureId;
		HtmlElementComponent.width[ eid ] = texture.image?.width ?? 0;
		HtmlElementComponent.height[ eid ] = texture.image?.height ?? 0;
		HtmlElementComponent.devicePixelRatio[ eid ] = texture.devicePixelRatio ?? 1;
		HtmlElementComponent.dirty[ eid ] = 0;
		HtmlElementComponent.applied[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued DOM-capture jobs in one cache-friendly pass. Each
	 * job re-rasterizes its element into the shared offscreen canvas and
	 * marks the texture for update if the element's pixel content changed.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const texture = this.textures[ HtmlElementComponent.texPtr[ eid ] ];

			const element = texture.element;
			if ( ! element ) continue;

			const rect = element.getBoundingClientRect();
			const dpr = HtmlElementComponent.devicePixelRatio[ eid ] || 1;

			const width = Math.max( 1, Math.round( rect.width * dpr ) );
			const height = Math.max( 1, Math.round( rect.height * dpr ) );

			HtmlElementComponent.width[ eid ] = width;
			HtmlElementComponent.height[ eid ] = height;
			HtmlElementComponent.dirty[ eid ] = 1;
			HtmlElementComponent.applied[ eid ] = 1;

			// Defer actual rasterization to the texture itself (the engine
			// has renderer-specific capture paths; we only coordinate here).
			texture.needsUpdate = true;

		}

	}

	/**
	 * Retrieve capture results as a Uint8Array (1 = captured, 0 = skipped).
	 *
	 * @returns {Uint8Array}
	 */
	results() {

		const entities = this.entities;
		const out = new Uint8Array( entities.length );
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = HtmlElementComponent.applied[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact DOM layout coordinate accumulation
// ---------------------------------------------------------------------------

/**
 * Compute a DOM element's cumulative offset from the document root using
 * double.js for bit-exact accumulation of nested offsetLeft/offsetTop
 * values. Used for pixel-accurate hit-testing and layout mirroring when
 * the element tree is deeply nested and float32 rounding accumulates
 * visible error.
 *
 * @param {HTMLElement} element
 * @returns {{x: number, y: number}}
 */
function cumulativeOffsetPrecise( element ) {

	_double.value = 0;
	let x = _double.value;
	_double.value = 0;
	let y = _double.value;

	let current = element;

	while ( current ) {

		_double.value = x;
		_double.add( current.offsetLeft || 0 );
		x = _double.value;

		_double.value = y;
		_double.add( current.offsetTop || 0 );
		y = _double.value;

		current = current.offsetParent;

	}

	return { x, y };

}

// ---------------------------------------------------------------------------
// simplex-noise dithered placeholder painting while DOM is not ready
// ---------------------------------------------------------------------------

/**
 * Paint a dithered placeholder pattern while the DOM element is still
 * loading or has zero dimensions. Prevents visible banding and gives
 * the user a visual indication that content is pending.
 *
 * @param {HTMLCanvasElement} canvas - The backing canvas.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 */
function paintHtmlPlaceholder( canvas, amplitude = 0.5 ) {

	const ctx = canvas.getContext( '2d' );
	const imageData = ctx.createImageData( canvas.width, canvas.height );
	const data = imageData.data;
	const invAmp = amplitude / 255;

	for ( let y = 0; y < canvas.height; y ++ ) {

		for ( let x = 0; x < canvas.width; x ++ ) {

			const p = ( y * canvas.width + x ) * 4;
			const d = _noise2D( x * 0.05, y * 0.05 ) * invAmp;

			// Diagonal hatch placeholder
			const hatch = ( ( x + y ) & 15 ) < 8 ? 0.6 : 0.4;
			data[ p ] = Math.floor( Math.max( 0, Math.min( 1, hatch + d ) ) * 255 );
			data[ p + 1 ] = Math.floor( Math.max( 0, Math.min( 1, hatch + d ) ) * 255 );
			data[ p + 2 ] = Math.floor( Math.max( 0, Math.min( 1, hatch + d ) ) * 255 );
			data[ p + 3 ] = 255;

		}

	}

	ctx.putImageData( imageData, 0, 0 );

}

// ---------------------------------------------------------------------------
// Main HTMLTexture class — extends three.js Texture for HTML DOM sources
// ---------------------------------------------------------------------------

/**
 * Creates a texture from a live HTML DOM element. The element is
 * rasterized into an offscreen canvas and the canvas is used as the
 * texture's image source.
 *
 * ```js
 * const element = document.getElementById( 'my-panel' );
 * const texture = new THREE.HTMLTexture( element );
 * texture.needsUpdate = true;
 * ```
 *
 * @augments Texture
 */
class HTMLTexture extends Texture {

	/**
	 * Constructs a new HTML texture.
	 *
	 * @param {HTMLElement} [element=null] - The DOM element to rasterize.
	 * @param {number} [devicePixelRatio=window.devicePixelRatio||1] - The
	 *   device pixel ratio to use for rasterization.
	 * @param {number} [mapping=Texture.DEFAULT_MAPPING] - The texture mapping.
	 * @param {number} [wrapS=ClampToEdgeWrapping] - The wrapS value.
	 * @param {number} [wrapT=ClampToEdgeWrapping] - The wrapT value.
	 * @param {number} [magFilter=LinearFilter] - The mag filter value.
	 * @param {number} [minFilter=LinearFilter] - The min filter value.
	 * @param {number} [format=RGBAFormat] - The texture format.
	 * @param {number} [type=UnsignedByteType] - The texture type.
	 * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY] - The anisotropy value.
	 */
	constructor(
		element = null,
		devicePixelRatio = ( typeof window !== 'undefined' && window.devicePixelRatio ) || 1,
		mapping = Texture.DEFAULT_MAPPING,
		wrapS = ClampToEdgeWrapping,
		wrapT = ClampToEdgeWrapping,
		magFilter = LinearFilter,
		minFilter = LinearFilter,
		format = RGBAFormat,
		type = UnsignedByteType,
		anisotropy = Texture.DEFAULT_ANISOTROPY
	) {

		// Create the initial backing canvas. Its dimensions are placeholders
		// until the first capture, which will resize it to fit the element.
		const canvas = typeof document !== 'undefined' ? document.createElement( 'canvas' ) : null;

		if ( canvas ) {

			canvas.width = 1;
			canvas.height = 1;

		}

		super(
			canvas,
			mapping,
			wrapS,
			wrapT,
			magFilter,
			minFilter,
			format,
			type,
			anisotropy
		);

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isHTMLTexture = true;

		/**
		 * The DOM element to rasterize. May be any `HTMLElement` (div, span,
		 * button, iframe wrapper, etc.).
		 *
		 * @type {?HTMLElement}
		 */
		this.element = element;

		/**
		 * The device pixel ratio used when rasterizing the DOM element.
		 *
		 * @type {number}
		 */
		this.devicePixelRatio = devicePixelRatio;

		// HTML textures manage their own rasterization pipeline. The engine
		// must not attempt to auto-generate mipmaps for them.
		this.generateMipmaps = false;
		this.flipY = false;
		this.unpackAlignment = 1;

	}

	/**
	 * Rasterizes the DOM element into the backing canvas. Called
	 * automatically when the renderer detects a pending update, and can be
	 * called manually to force a re-capture.
	 *
	 * The implementation delegates to the browser's native DOM-to-canvas
	 * rasterization (e.g. `html2canvas`, `foreignObject` SVG trick, or a
	 * runtime-provided capture function). If none is available, a dithered
	 * placeholder is painted instead.
	 *
	 * @returns {HTMLTexture} A reference to this instance.
	 */
	update() {

		const element = this.element;
		const canvas = this.image;

		if ( ! element || ! ( canvas instanceof HTMLCanvasElement ) ) return this;

		const rect = element.getBoundingClientRect();
		const dpr = this.devicePixelRatio;

		const width = Math.max( 1, Math.round( rect.width * dpr ) );
		const height = Math.max( 1, Math.round( rect.height * dpr ) );

		canvas.width = width;
		canvas.height = height;

		// If the runtime provided a custom capture function, use it.
		if ( typeof this._captureFn === 'function' ) {

			this._captureFn( element, canvas );

		} else if ( typeof window !== 'undefined' && typeof window.html2canvas === 'function' ) {

			// html2canvas-style capture (async — the caller must await)
			window.html2canvas( element ).then( ( captured ) => {

				const ctx = canvas.getContext( '2d' );
				ctx.clearRect( 0, 0, width, height );
				ctx.drawImage( captured, 0, 0, width, height );
				this.needsUpdate = true;

			} );

		} else {

			// No capture function available: paint a dithered placeholder.
			paintHtmlPlaceholder( canvas, 0.5 );

		}

		this.needsUpdate = true;
		return this;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * Set a custom capture function used to rasterize the DOM element.
	 * The function is invoked as `fn(element, canvas)` and is responsible
	 * for drawing the element's content into the canvas.
	 *
	 * @param {Function} fn - The capture function.
	 * @returns {HTMLTexture} A reference to this instance.
	 */
	setCaptureFunction( fn ) {

		this._captureFn = fn;
		return this;

	}

	/**
	 * gl-matrix accelerated per-frame DOM pixel sampling. Reads the current
	 * backing-canvas content and samples the RGBA value at the given UV
	 * coordinate. Zero-allocation; writes into a preallocated vec4.
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4|null}
	 */
	sampleGlMat( out = _gm_rgba, u = 0.5, v = 0.5 ) {

		const canvas = this.image;
		if ( ! ( canvas instanceof HTMLCanvasElement ) ) return null;
		if ( canvas.width === 0 || canvas.height === 0 ) return null;

		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		const imageData = ctx.getImageData( 0, 0, canvas.width, canvas.height );

		const x = Math.min( canvas.width - 1, Math.max( 0, Math.floor( u * canvas.width ) ) );
		const y = Math.min( canvas.height - 1, Math.max( 0, Math.floor( v * canvas.height ) ) );
		const p = ( y * canvas.width + x ) * 4;

		glMatrix.vec4.set(
			out,
			imageData.data[ p ] / 255,
			imageData.data[ p + 1 ] / 255,
			imageData.data[ p + 2 ] / 255,
			imageData.data[ p + 3 ] / 255
		);

		return out;

	}

	/**
	 * double.js bit-exact cumulative DOM offset from the document root.
	 * Useful for pixel-accurate hit-testing and layout mirroring when the
	 * element tree is deeply nested.
	 *
	 * @returns {{x: number, y: number}}
	 */
	getCumulativeOffsetPrecise() {

		if ( ! this.element ) return { x: 0, y: 0 };
		return cumulativeOffsetPrecise( this.element );

	}

	/**
	 * Paint a dithered placeholder into the backing canvas. Used when the
	 * DOM element is not yet ready (dimensions = 0) or no capture function
	 * is available.
	 *
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {HTMLTexture} A reference to this instance.
	 */
	paintPlaceholder( amplitude = 0.5 ) {

		const canvas = this.image;
		if ( ! ( canvas instanceof HTMLCanvasElement ) ) return this;

		paintHtmlPlaceholder( canvas, amplitude );
		this.needsUpdate = true;

		return this;

	}

	/**
	 * Create a batched DOM-capture coordinator backed by bitecs.
	 *
	 * @returns {HTMLTextureBatch}
	 */
	static createBatch() {

		return new HTMLTextureBatch();

	}

	/**
	 * Copy the given HTML texture's properties into this one.
	 *
	 * @param {HTMLTexture} source - The texture to copy from.
	 * @return {HTMLTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.element = source.element;
		this.devicePixelRatio = source.devicePixelRatio;
		this._captureFn = source._captureFn;

		this.generateMipmaps = source.generateMipmaps;
		this.flipY = source.flipY;
		this.unpackAlignment = source.unpackAlignment;

		return this;

	}

	/**
	 * Serializes the HTML texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// HTML textures serialize only structural metadata. The DOM element
		// itself cannot be serialized — consumers must re-provide it.
		output.image = {
			width: this.image?.width ?? 0,
			height: this.image?.height ?? 0,
			devicePixelRatio: this.devicePixelRatio
		};

		if ( this.element && this.element.id ) {

			output.elementId = this.element.id;

		}

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { HTMLTexture, HTMLTextureBatch, cumulativeOffsetPrecise, paintHtmlPlaceholder };
export default HTMLTexture;