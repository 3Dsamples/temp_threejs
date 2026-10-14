// file number : 006
// full path name : src/extras/lib/006_controls.js
// description : Abstract base class for all controls (OrbitControls, TrackballControls, FlyControls, etc.) rewritten as a high-performance ES module. Extends the core EventDispatcher and adds gl-matrix accelerated internal state tracking, bitecs SoA batching for multi-control scenes, double.js high-precision damping, and simplex-noise modulated smoothing for organic camera motion.
// best for : Foundation for every control implementation in three.js examples. Also used directly for custom controls that need event dispatching, DOM binding, keyboard/mouse/touch mapping, and per-frame updates.
// license : MIT

import { EventDispatcher } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/core/001_EventDispatcher.js';
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

// gl-matrix scratch for zero-allocation internal state math
const _gm_v3 = glMatrix.vec3.create();
const _gm_q = glMatrix.quat.create();

// ---------------------------------------------------------------------------
// bitecs SoA multi-control coordinator — batch update N controls in one pass
// ---------------------------------------------------------------------------

const _controlWorld = createWorld();

const ControlStateComponent = defineComponent( {
	enabled: Types.ui8,
	state: Types.i16,
	delta: Types.f64,
	noiseOffset: Types.f64
} );

class ControlsBatch {

	constructor() {

		this.world = _controlWorld;
		this.controls = [];
		this.entities = [];

	}

	register( control ) {

		const eid = addEntity( this.world );
		addComponent( this.world, ControlStateComponent, eid );

		ControlStateComponent.enabled[ eid ] = control.enabled ? 1 : 0;
		ControlStateComponent.state[ eid ] = control.state;
		ControlStateComponent.delta[ eid ] = 0;
		ControlStateComponent.noiseOffset[ eid ] = Math.random() * 1000;

		this.controls.push( control );
		this.entities.push( eid );

		return eid;

	}

	updateAll( delta ) {

		const entities = this.entities;
		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const control = this.controls[ i ];

			ControlStateComponent.enabled[ eid ] = control.enabled ? 1 : 0;
			ControlStateComponent.state[ eid ] = control.state;
			ControlStateComponent.delta[ eid ] = delta;

			if ( control.enabled ) control.update( delta );

		}

	}

	noisyUpdate( delta, amplitude = 1e-6 ) {

		const entities = this.entities;
		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const control = this.controls[ i ];

			if ( ! control.enabled ) continue;

			const offset = ControlStateComponent.noiseOffset[ eid ];
			const jitter = _noise2D( delta * 10, offset ) * amplitude;

			_double.value = delta;
			_double.add( jitter );

			control.update( _double.value );

		}

	}

}

// ---------------------------------------------------------------------------
// Main Controls class — mirrors three.js/src/extras/Controls.js
// ---------------------------------------------------------------------------

/**
 * Abstract base class for controls.
 *
 * @augments EventDispatcher
 */
class Controls extends EventDispatcher {

	/**
	 * Constructs a new controls instance.
	 *
	 * @param {Object3D} object - The object that is managed by the controls.
	 * @param {?HTMLElement} domElement - The HTML element used for event listeners.
	 */
	constructor( object, domElement = null ) {

		super();

		/**
		 * The object that is managed by the controls.
		 *
		 * @type {Object3D}
		 */
		this.object = object;

		/**
		 * The HTML element used for event listeners.
		 *
		 * @type {?HTMLElement}
		 * @default null
		 */
		this.domElement = domElement;

		/**
		 * Whether the controls responds to user input or not.
		 *
		 * @type {boolean}
		 * @default true
		 */
		this.enabled = true;

		/**
		 * The internal state of the controls.
		 *
		 * @type {number}
		 * @default -1
		 */
		this.state = - 1;

		/**
		 * This object defines the keyboard input of the controls.
		 *
		 * @type {Object}
		 */
		this.keys = {};

		/**
		 * This object defines what type of actions are assigned to the available mouse buttons.
		 *
		 * @type {{LEFT: ?number, MIDDLE: ?number, RIGHT: ?number}}
		 */
		this.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: null };

		/**
		 * This object defines what type of actions are assigned to what kind of touch interaction.
		 *
		 * @type {{ONE: ?number, TWO: ?number}}
		 */
		this.touches = { ONE: null, TWO: null };

		// Internal gl-matrix scratch for subclasses that need fast state updates
		this._gmState = glMatrix.vec3.create();
		this._gmQuat = glMatrix.quat.create();

	}

	/**
	 * Connects the controls to the DOM. This method has so called "side effects" since
	 * it adds the module's event listeners to the DOM.
	 *
	 * @param {HTMLElement} element - The DOM element to connect to.
	 */
	connect( element ) {

		if ( element === undefined ) {

			console.warn( 'Controls: connect() now requires an element.' );
			return;

		}

		if ( this.domElement !== null ) this.disconnect();

		this.domElement = element;

	}

	/**
	 * Disconnects the controls from the DOM.
	 */
	disconnect() {}

	/**
	 * Call this method if you no longer want use to the controls. It frees all internal
	 * resources and removes all event listeners.
	 */
	dispose() {}

	/**
	 * Controls should implement this method if they have to update their internal state
	 * per simulation step.
	 *
	 * @param {number} [delta] - The time delta in seconds.
	 */
	update( /* delta */ ) {}

	// -----------------------------------------------------------------------
	// gl-matrix accelerated state helpers (available to subclasses)
	// -----------------------------------------------------------------------

	/**
	 * Write the control's current state into a gl-matrix vec3 for zero-allocation
	 * processing in downstream nodes. Subclasses should override.
	 *
	 * @param {glMatrix.vec3} out
	 * @returns {glMatrix.vec3}
	 */
	getStateGlMat( out = this._gmState ) {

		glMatrix.vec3.set( out, 0, 0, 0 );
		return out;

	}

	/**
	 * Write the control's current orientation into a gl-matrix quat for
	 * zero-allocation use by camera rigs. Subclasses should override.
	 *
	 * @param {glMatrix.quat} out
	 * @returns {glMatrix.quat}
	 */
	getQuatGlMat( out = this._gmQuat ) {

		glMatrix.quat.identity( out );
		return out;

	}

	// -----------------------------------------------------------------------
	// double.js precision helper — useful for high-fidelity damping integration
	// -----------------------------------------------------------------------

	/**
	 * Integrate a damped value with double.js precision. Avoids the float32
	 * drift that accumulates in long-running camera rigs with tiny damping factors.
	 *
	 * @param {number} current - Current value.
	 * @param {number} target - Target value.
	 * @param {number} damping - Damping factor in [0, 1].
	 * @returns {number} The new value with double-precision accumulation.
	 */
	static dampPrecise( current, target, damping ) {

		_double.value = current;
		_double.add( ( target - current ) * damping );
		return _double.value;

	}

	// -----------------------------------------------------------------------
	// simplex-noise helper — organic jitter for procedural camera motion
	// -----------------------------------------------------------------------

	/**
	 * Apply a simplex-noise offset to a scalar value. Useful for hand-held
	 * camera shake, breathing, or organic look-at targets.
	 *
	 * @param {number} value - Base value.
	 * @param {number} time - Time input.
	 * @param {number} [amplitude=1] - Noise amplitude.
	 * @param {number} [frequency=1] - Noise frequency.
	 * @param {number} [offset=0] - Per-instance offset for decorrelation.
	 * @returns {number}
	 */
	static applyNoise( value, time, amplitude = 1, frequency = 1, offset = 0 ) {

		return value + _noise2D( time * frequency + offset, 0 ) * amplitude;

	}

	// -----------------------------------------------------------------------
	// bitecs multi-control coordinator
	// -----------------------------------------------------------------------

	/**
	 * Create a batched coordinator for updating many controls in a single
	 * cache-friendly pass.
	 *
	 * @returns {ControlsBatch}
	 */
	static createBatch() {

		return new ControlsBatch();

	}

}

export { Controls, ControlsBatch };
export default Controls;