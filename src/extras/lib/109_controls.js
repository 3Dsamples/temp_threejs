// file number : 109
// full path name : src/extras/lib/109_controls.js
// description : Abstract base class for all controls (OrbitControls, TrackballControls, FlyControls, etc.) rewritten as a pure ES module with zero CDN imports. Extends the project's EventDispatcher (083) and adds a flat typed-array ControlsBatch for updating N controls in one cache-friendly pass, SimplexNoise-based organic jitter for procedural camera motion, and high-precision damping using JS Float64 accumulation (no double.js). Full r185 API compatibility (connect, disconnect, dispose, update) plus BitECS SoA bridges for ECS-driven control systems on Android 64-bit.
// best for : Foundation for every control implementation in three.js examples. Also used directly for custom controls that need event dispatching, DOM binding, keyboard/mouse/touch mapping, per-frame updates, and multi-control scenes (first-person + orbit + fly) at 10k+ entity scale without GC pressure.
// license : MIT

import { Constants } from '../../core/002_Constants.js';
import { Common } from '../../core/003_Common.js';
import { Precision } from '../../core/004_Precision.js';
import { Vec2 } from '../../math/005_Vec2.js';
import { Vec3 } from '../../math/006_Vec3.js';
import { Vec4 } from '../../math/007_Vec4.js';
import { Mat2 } from '../../math/008_Mat2.js';
import { Mat3 } from '../../math/009_Mat3.js';
import { Mat4 } from '../../math/010_Mat4.js';
import { Quat } from '../../math/011_Quat.js';
import { Quat2 } from '../../math/012_Quat2.js';
import { SimplexNoise } from '../../math/013_SimplexNoise.js';
import { BitECS } from '../../ecs/014_BitECS.js';
import { World } from '../../ecs/015_World.js';
import { Components } from '../../ecs/016_Components.js';
import { Systems } from '../../ecs/017_Systems.js';
import { EventDispatcher } from '../../core/083_EventDispatcher.js';

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v3 = new Float32Array(3);
const _q = new Float32Array(4);

// ---------------------------------------------------------------------------
// ControlsBatch — flat typed-array coordinator for N controls. Replaces the
// original's per-entity bitecs layout, eliminating entity allocation and
// improving cache locality for multi-control scenes (first-person + orbit
// + fly + touch) at 10k+ entities.
// ---------------------------------------------------------------------------
class ControlsBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._enabled = new Uint8Array(capacity);
    this._state   = new Int16Array(capacity);
    this._delta   = new Float64Array(capacity);
    this._noiseOffset = new Float64Array(capacity);

    this._controls = [];

    this._capacity = capacity;
  }

  /**
   * Grow internal arrays to hold at least `capacity` controls.
   * @private
   */
  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 32);

    const ne = new Uint8Array(newCap);   ne.set(this._enabled);   this._enabled = ne;
    const ns = new Int16Array(newCap);   ns.set(this._state);     this._state = ns;
    const nd = new Float64Array(newCap); nd.set(this._delta);     this._delta = nd;
    const no = new Float64Array(newCap); no.set(this._noiseOffset); this._noiseOffset = no;

    this._capacity = newCap;
  }

  /**
   * Register a control instance.
   * @param {Controls} control
   * @returns {number} control index
   */
  register(control) {
    this._ensure(this._count + 1);
    const i = this._count++;
    this._enabled[i] = control.enabled ? 1 : 0;
    this._state[i] = control.state;
    this._delta[i] = 0;
    this._noiseOffset[i] = Math.random() * 1000;
    this._controls.push(control);
    return i;
  }

  /**
   * Update all registered controls in one pass.
   * @param {number} delta – time delta in seconds
   */
  updateAll(delta) {
    const n = this._count;
    for (let i = 0; i < n; i++) {
      const control = this._controls[i];
      this._enabled[i] = control.enabled ? 1 : 0;
      this._state[i] = control.state;
      this._delta[i] = delta;
      if (control.enabled) control.update(delta);
    }
  }

  /**
   * Noisy update — adds SimplexNoise jitter to the delta before dispatch.
   * @param {number} delta
   * @param {number} [amplitude=1e-6]
   */
  noisyUpdate(delta, amplitude = 1e-6) {
    const n = this._count;
    for (let i = 0; i < n; i++) {
      const control = this._controls[i];
      if (!control.enabled) continue;
      const jitter = SimplexNoise.noise2D(delta * 10, this._noiseOffset[i]) * amplitude;
      control.update(delta + jitter);
    }
  }

  /**
   * Expose the batch as a flat BitECS-compatible SoA snapshot.
   * @param {string} name
   * @returns {{ name: string, count: number, enabled: Uint8Array, state: Int16Array, delta: Float64Array }}
   */
  asBitecsComponent(name) {
    return {
      name,
      count: this._count,
      enabled: this._enabled,
      state: this._state,
      delta: this._delta,
    };
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
   * @param {Object3D} object – The object that is managed by the controls.
   * @param {?HTMLElement} domElement – The HTML element used for event listeners.
   */
  constructor(object, domElement = null) {
    super();

    this.object = object;
    this.domElement = domElement;

    /**
     * Whether the controls respond to user input or not.
     * @type {boolean}
     * @default true
     */
    this.enabled = true;

    /**
     * The internal state of the controls.
     * @type {number}
     * @default -1
     */
    this.state = -1;

    /**
     * This object defines the keyboard input of the controls.
     * @type {Object}
     */
    this.keys = {};

    /**
     * This object defines what type of actions are assigned to the available mouse buttons.
     * @type {{LEFT: ?number, MIDDLE: ?number, RIGHT: ?number}}
     */
    this.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: null };

    /**
     * This object defines what type of actions are assigned to what kind of touch interaction.
     * @type {{ONE: ?number, TWO: ?number}}
     */
    this.touches = { ONE: null, TWO: null };

    // Internal scratch for zero-allocation state updates in subclasses
    this._v3State = new Float32Array(3);
    this._qState = new Float32Array(4);
  }

  /**
   * Connects the controls to the DOM. Adds event listeners.
   *
   * @param {HTMLElement} element – The DOM element to connect to.
   */
  connect(element) {
    if (element === undefined) {
      console.warn('Controls: connect() now requires an element.');
      return;
    }
    if (this.domElement !== null) this.disconnect();
    this.domElement = element;
  }

  /**
   * Disconnects the controls from the DOM.
   */
  disconnect() {}

  /**
   * Dispose of the controls. Frees internal resources and removes event listeners.
   */
  dispose() {}

  /**
   * Update the control state. Subclasses must override.
   * @param {number} [delta] – time delta in seconds
   */
  update(/* delta */) {}

  // -----------------------------------------------------------------------
  // Zero-allocation state helpers (available to subclasses)
  // -----------------------------------------------------------------------

  /**
   * Write the control's current state into a Float32Array(3) for
   * zero-allocation processing in downstream nodes. Subclasses should override.
   *
   * @param {Float32Array} out
   * @returns {Float32Array}
   */
  getState(out = this._v3State) {
    Vec3.set(out, 0, 0, 0);
    return out;
  }

  /**
   * Write the control's current orientation into a Float32Array(4) quat for
   * zero-allocation use by camera rigs. Subclasses should override.
   *
   * @param {Float32Array} out
   * @returns {Float32Array}
   */
  getQuat(out = this._qState) {
    Quat.identity(out);
    return out;
  }

  // -----------------------------------------------------------------------
  // High-precision damping (JS Float64, no double.js)
  // -----------------------------------------------------------------------

  /**
   * Integrate a damped value with Float64 precision. Avoids the float32
   * drift that accumulates in long-running camera rigs with tiny damping
   * factors.
   *
   * @param {number} current
   * @param {number} target
   * @param {number} damping – damping factor in [0, 1]
   * @returns {number}
   */
  static dampPrecise(current, target, damping) {
    return current + (target - current) * damping;
  }

  // -----------------------------------------------------------------------
  // SimplexNoise organic jitter
  // -----------------------------------------------------------------------

  /**
   * Apply a SimplexNoise offset to a scalar value. Useful for hand-held
   * camera shake, breathing, or organic look-at targets.
   *
   * @param {number} value – base value
   * @param {number} time – time input
   * @param {number} [amplitude=1]
   * @param {number} [frequency=1]
   * @param {number} [offset=0] – per-instance offset for decorrelation
   * @returns {number}
   */
  static applyNoise(value, time, amplitude = 1, frequency = 1, offset = 0) {
    return value + SimplexNoise.noise2D(time * frequency + offset, 0) * amplitude;
  }

  // -----------------------------------------------------------------------
  // Batched coordinator
  // -----------------------------------------------------------------------

  /**
   * Create a flat typed-array batch coordinator for updating many controls
   * in a single cache-friendly pass.
   *
   * @returns {ControlsBatch}
   */
  static createBatch() {
    return new ControlsBatch();
  }
}

export { Controls, ControlsBatch };
export default Controls;