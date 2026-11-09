// file number : 084
// full path name : src/core/084_GLBufferAttribute.js
// description : High-performance GLBufferAttribute wrapper that delegates VBO ownership to the caller (e.g. GPGPU compute, WebGL2 transform feedback, or external streaming). Rewritten to integrate natively with the project's BitECS typed-array foundations and pooled metadata descriptors. Zero CDN imports, zero static-server dependency, and allocation-free hot paths for 10k+ entity pipelines on Android 64-bit.
// best for : GPGPU-driven vertex streams, WebGL2 transform-feedback outputs, external VBO producers (video/streaming), and any ECS-driven rendering path where the VBO is owned outside three.js but must participate in BufferGeometry attributes.
// license : MIT

import { Constants } from '../math/002_Constants.js';
import { Common } from '../math/003_Common.js';
import { Precision } from '../math/004_Precision.js';
import { Vec2 } from '../math/005_Vec2.js';
import { Vec3 } from '../math/006_Vec3.js';
import { Vec4 } from '../math/007_Vec4.js';
import { Mat2 } from '../math/008_Mat2.js';
import { Mat3 } from '../math/009_Mat3.js';
import { Mat4 } from '../math/010_Mat4.js';
import { Quat } from '../math/011_Quat.js';
import { Quat2 } from '../math/012_Quat2.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';
import { BitECS } from '../ecs/014_BitECS.js';
import { World } from '../ecs/015_World.js';
import { Components } from '../ecs/016_Components.js';
import { Systems } from '../ecs/017_Systems.js';

// ---------------------------------------------------------------------------
// Static pool for GLBufferAttribute descriptors – reused across instances
// to eliminate per-frame allocation churn when spawning/despawning entities.
// ---------------------------------------------------------------------------
const _descriptorPool = [];

/**
 * Acquire a descriptor object from the pool.
 * @returns {object}
 */
function acquireDescriptor() {
  const d = _descriptorPool.pop();
  if (d) return d;
  return {
    buffer: null,
    type: 0,
    itemSize: 0,
    elementSize: 0,
    count: 0,
    normalized: false,
    name: '',
  };
}

/**
 * Return a descriptor to the pool. Caller must not use it afterward.
 * @param {object} d
 */
function releaseDescriptor(d) {
  d.buffer = null;
  d.type = 0;
  d.itemSize = 0;
  d.elementSize = 0;
  d.count = 0;
  d.normalized = false;
  d.name = '';
  if (_descriptorPool.length < 64) _descriptorPool.push(d);
}

// ---------------------------------------------------------------------------
// WebGL type → elementSize (bytes per component), mirrors three.js r185.
// ---------------------------------------------------------------------------
const TYPE_TO_ELEMENT_SIZE = {
  0x1406: 4, // gl.FLOAT
  0x140B: 2, // gl.HALF_FLOAT
  0x1401: 1, // gl.UNSIGNED_BYTE
  0x1400: 1, // gl.BYTE
  0x1403: 2, // gl.UNSIGNED_SHORT
  0x1402: 2, // gl.SHORT
  0x1405: 4, // gl.UNSIGNED_INT
  0x1404: 4, // gl.INT
};

// ---------------------------------------------------------------------------
// Minimal event surface (avoids circular dependency with 083_EventDispatcher)
// ---------------------------------------------------------------------------
const _changeListeners = [];

function dispatchChangeEvent(event) {
  for (let i = 0; i < _changeListeners.length; i++) {
    _changeListeners[i].call(null, event);
  }
}

/**
 * GLBufferAttribute
 *
 * Wraps an externally-owned WebGLBuffer as a three.js-compatible attribute.
 * Does NOT construct a VBO — accepts one and exposes metadata (type, itemSize,
 * elementSize, count) so the renderer can bind it without CPU-side arrays.
 *
 * Features:
 * – Pooled descriptor objects (acquire on construct, release on dispose).
 * – Zero-allocation setBuffer / setType / setItemSize / setCount.
 * – needsUpdate flag with version counter (three.js r185 compatible).
 * – Native BitECS bridge: getECSDescriptor() returns a view for Components.
 * – No static server, no bundler, no CDN dependency.
 */
class GLBufferAttribute {
  /**
   * @param {WebGLBuffer} buffer      – externally-owned VBO handle
   * @param {number}      type        – WebGL data type (e.g. gl.FLOAT)
   * @param {number}      itemSize    – components per vertex (e.g. 3 for position)
   * @param {number}      elementSize – bytes per component (e.g. 4 for gl.FLOAT)
   * @param {number}      count       – number of vertices in the VBO
   */
  constructor(buffer, type, itemSize, elementSize, count) {
    const d = acquireDescriptor();
    d.buffer = buffer;
    d.type = type;
    d.itemSize = itemSize;
    d.elementSize = elementSize;
    d.count = count;
    d.normalized = false;
    d.name = '';

    Object.defineProperty(this, '_descriptor', {
      value: d,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    this._version = 0;
    this._needsUpdate = false;
    this.isGLBufferAttribute = true;
  }

  // --- Buffer -------------------------------------------------------------

  get buffer() { return this._descriptor.buffer; }
  set buffer(v) { this._descriptor.buffer = v; this._version++; }

  setBuffer(buffer) {
    this._descriptor.buffer = buffer;
    this._version++;
    return this;
  }

  // --- Type + elementSize -------------------------------------------------

  get type() { return this._descriptor.type; }
  set type(v) { this.setType(v); }

  get elementSize() { return this._descriptor.elementSize; }

  /**
   * Set both `type` and `elementSize` atomically from the WebGL type.
   * Uses a lookup table to avoid repeated switch/branch overhead.
   */
  setType(type) {
    const d = this._descriptor;
    d.type = type;
    d.elementSize = TYPE_TO_ELEMENT_SIZE[type] || 4;
    this._version++;
    return this;
  }

  // --- ItemSize -----------------------------------------------------------

  get itemSize() { return this._descriptor.itemSize; }
  set itemSize(v) { this.setItemSize(v); }

  setItemSize(itemSize) {
    this._descriptor.itemSize = itemSize;
    this._version++;
    return this;
  }

  // --- Count --------------------------------------------------------------

  get count() { return this._descriptor.count; }
  set count(v) { this.setCount(v); }

  setCount(count) {
    this._descriptor.count = count;
    this._version++;
    return this;
  }

  // --- Normalized / Name --------------------------------------------------

  get normalized() { return this._descriptor.normalized; }
  set normalized(v) { this._descriptor.normalized = !!v; }

  get name() { return this._descriptor.name; }
  set name(v) { this._descriptor.name = v || ''; }

  // --- Update lifecycle ---------------------------------------------------

  get version() { return this._version; }

  get needsUpdate() { return this._needsUpdate; }
  set needsUpdate(v) {
    if (v) {
      this._version++;
      this._needsUpdate = true;
      dispatchChangeEvent({ type: 'needsUpdate', target: this });
    } else {
      this._needsUpdate = false;
    }
  }

  // --- BitECS bridge ------------------------------------------------------

  /**
   * Returns a plain descriptor compatible with the project's BitECS
   * `Components` schema registration. The returned object is a lightweight
   * snapshot — it is not pooled and is GC-collected normally.
   */
  getECSDescriptor() {
    return {
      buffer: this._descriptor.buffer,
      type: this._descriptor.type,
      itemSize: this._descriptor.itemSize,
      elementSize: this._descriptor.elementSize,
      count: this._descriptor.count,
      normalized: this._descriptor.normalized,
    };
  }

  // --- Change notification ------------------------------------------------

  addChangeListener(listener) {
    if (_changeListeners.indexOf(listener) === -1) {
      _changeListeners.push(listener);
    }
    return this;
  }

  removeChangeListener(listener) {
    const idx = _changeListeners.indexOf(listener);
    if (idx !== -1) _changeListeners.splice(idx, 1);
    return this;
  }

  // --- Disposal -----------------------------------------------------------

  /**
   * Release the pooled descriptor. The VBO itself is NOT deleted because
   * it is owned externally. Call this when the attribute is no longer
   * needed to avoid memory leaks on mobile.
   */
  dispose() {
    releaseDescriptor(this._descriptor);
    this._descriptor = null;
  }
}

export { GLBufferAttribute };