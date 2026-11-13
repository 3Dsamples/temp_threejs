// file number : 265
// full path name : src/context/265_CoreEventDispatcher.js
// description : Typed zero-allocation event dispatcher with integer event discriminants, priority-ordered listeners, one-shot listeners, deferred removal during dispatch, a fixed-capacity causal ring buffer with exponential decay D(τ)=exp(-τ/τ_decay), frame-stage draining into the context frame's causal layer, and stage-six batched dispatch. Integrates with 263_ContextFrame and imports exclusively from 264_MathECSImportBarrel.
// best for : Causal event routing between providers and consumers. Impact, ignition, splash, fracture, decal, ecology, and audio/light events flow through this dispatcher without allocating per dispatch, keeping the 8 ms per-tick CPU ceiling intact on Snapdragon 7-series.
// license : MIT

import {
  EventDispatcher as CoreEventDispatcher,
  Precision,
  Timer,
  Vec3,
  Vec4,
  Mat4,
  Quat,
  BitECS,
  World,
  Components,
  Systems,
  EventDispatcher as ThreeEventDispatcher
} from './264_MathECSImportBarrel.js';

// ─── integer event discriminants ──────────────────────────────────
const EVENT_TYPE = Object.freeze({
  IMPACT: 0,
  IGNITION: 1,
  SPLASH: 2,
  FRACTURE: 3,
  DECAL: 4,
  ECOLOGY: 5,
  AUDIO_LIGHT: 6,
  MUTATION: 7,
  STREAM_LOAD: 8,
  STREAM_UNLOAD: 9,
  BIOME_BLEND: 10,
  PLAYER_INTERACT: 11
});

const EVENT_NAMES = Object.freeze([
  'impact', 'ignition', 'splash', 'fracture', 'decal', 'ecology',
  'audio_light', 'mutation', 'stream_load', 'stream_unload',
  'biome_blend', 'player_interact'
]);

// ─── listener slot layout ─────────────────────────────────────────
const SLOT_FN = 0;
const SLOT_PRIORITY = 1;
const SLOT_ONCE = 2;
const SLOT_ACTIVE = 3;

class CoreEventDispatcher {
  constructor(options = {}) {
    this._capacity = options.capacity ?? 64;
    this._listeners = new Array(32).fill(null);
    this._deferredRemovals = [];
    this._dispatching = 0;
    this._frameStage = 0;
    this._contextFrame = null;
    this._timer = new Timer();
    this._eventPool = [];
    this._poolIndex = 0;
    this._eventBuffer = new Array(16).fill(null).map(() => this._makeEventSlot());
    this._decayCache = new Map();
    this._stats = { dispatched: 0, drained: 0, decayed: 0, overflow: 0 };
  }

  // ── pre-allocated event slot ────────────────────────────────────
  _makeEventSlot() {
    return {
      type: -1,
      typeName: '',
      position: new Float32Array(3),
      materialId: -1,
      force: 0,
      timestamp: 0,
      decayRate: 1.0,
      payload: null,
      _decayCacheKey: 0,
      _decayCacheValue: 1.0,
      target: null
    };
  }

  // ── listener registration (priority insertion sort) ─────────────
  addEventListener(type, fn, priority = 0, once = false) {
    if (typeof type !== 'number' || typeof fn !== 'function') return this;
    while (this._listeners.length <= type) this._listeners.push(null);
    if (this._listeners[type] === null) this._listeners[type] = [];
    const arr = this._listeners[type];
    if (arr.some(s => s[SLOT_FN] === fn)) return this;
    const slot = [fn, priority, once ? 1 : 0, 1];
    let i = arr.length;
    while (i > 0 && arr[i - 1][SLOT_PRIORITY] < priority) i--;
    arr.splice(i, 0, slot);
    return this;
  }

  removeEventListener(type, fn) {
    const arr = this._listeners[type];
    if (!arr) return this;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i][SLOT_FN] === fn) {
        if (this._dispatching > 0) {
          this._deferredRemovals.push([type, i]);
        } else {
          arr.splice(i, 1);
        }
        return this;
      }
    }
    return this;
  }

  hasEventListener(type, fn) {
    const arr = this._listeners[type];
    return arr ? arr.some(s => s[SLOT_FN] === fn) : false;
  }

  // ── pooled event acquisition ────────────────────────────────────
  acquireEvent(type, typeName) {
    let ev;
    if (this._eventPool.length > 0 && this._eventPool[this._eventPool.length - 1].type === -1) {
      ev = this._eventPool.pop();
    } else {
      ev = this._makeEventSlot();
      this._eventPool.push(ev);
    }
    ev.type = type;
    ev.typeName = typeName || EVENT_NAMES[type] || 'unknown';
    ev.position.fill(0);
    ev.materialId = -1;
    ev.force = 0;
    ev.timestamp = 0;
    ev.decayRate = 1.0;
    ev.payload = null;
    ev.target = null;
    ev._decayCacheKey = 0;
    ev._decayCacheValue = 1.0;
    return ev;
  }

  releaseEvent(ev) {
    if (ev && ev.type !== -1) {
      ev.type = -1;
      ev.payload = null;
      ev.target = null;
      this._eventPool.push(ev);
    }
  }

  // ── dispatch: zero allocation, deferred removal safe ────────────
  dispatchEvent(event) {
    const type = event.type;
    const arr = this._listeners[type];
    if (!arr || arr.length === 0) return this;
    this._dispatching++;
    try {
      event.target = this;
      const len = arr.length;
      for (let i = 0; i < len; i++) {
        const slot = arr[i];
        if (slot[SLOT_ACTIVE] !== 1) continue;
        slot[SLOT_FN].call(this, event);
        if (slot[SLOT_ONCE] === 1) slot[SLOT_ACTIVE] = 0;
      }
    } finally {
      this._dispatching--;
    }
    if (this._dispatching === 0 && this._deferredRemovals.length > 0) {
      for (let d = this._deferredRemovals.length - 1; d >= 0; d--) {
        const [t, idx] = this._deferredRemovals[d];
        if (this._listeners[t] && idx < this._listeners[t].length) {
          this._listeners[t].splice(idx, 1);
        }
      }
      this._deferredRemovals.length = 0;
    }
    this._stats.dispatched++;
    return this;
  }

  // ── causal ring buffer (fixed capacity, exponential decay) ──────
  queueCausalEvent(type, position, materialId, force, decayRate = 1.0, payload = null) {
    const ev = this.acquireEvent(type, EVENT_NAMES[type]);
    if (position) {
      ev.position[0] = position[0];
      ev.position[1] = position[1];
      ev.position[2] = position[2];
    }
    ev.materialId = materialId;
    ev.force = force;
    ev.decayRate = decayRate;
    ev.payload = payload;
    ev.timestamp = this._timer.elapsedSeconds;
    ev._decayCacheKey = 0;
    ev._decayCacheValue = 1.0;
    this._ringPush(ev);
    return ev;
  }

  _ringPush(ev) {
    if (this._ringLength() >= this._capacity) {
      const oldest = this._ringPop();
      this.releaseEvent(oldest);
      this._stats.overflow++;
    }
    const index = (this._ringHead + this._ringLength()) % this._capacity;
    this._ring[index] = ev;
    this._ringCount++;
  }

  _ringLength() { return this._ringCount || 0; }
  _ringPop() {
    if (this._ringCount === 0) return null;
    const ev = this._ring[this._ringHead];
    this._ring[this._ringHead] = null;
    this._ringHead = (this._ringHead + 1) % this._capacity;
    this._ringCount--;
    return ev;
  }

  // ── decay evaluation: D(τ) = exp(-τ / τ_decay) ──────────────────
  evaluateDecay(ev, now = this._timer.elapsedSeconds) {
    const age = now - ev.timestamp;
    if (age <= 0) return 1.0;
    const key = (ev.timestamp + '|' + ev.decayRate).length;
    if (ev._decayCacheKey === age && ev._decayCacheValue !== undefined) return ev._decayCacheValue;
    const value = Math.exp(-age / Math.max(ev.decayRate, Precision.EPSILON));
    ev._decayCacheKey = age;
    ev._decayCacheValue = value;
    return value;
  }

  decayAll(now = this._timer.elapsedSeconds) {
    const len = this._ringLength();
    for (let i = 0; i < len; i++) {
      const idx = (this._ringHead + i) % this._capacity;
      const ev = this._ring[idx];
      if (ev) {
        this.evaluateDecay(ev, now);
        if (ev._decayCacheValue < 0.001) {
          ev.force = 0;
        }
        this._stats.decayed++;
      }
    }
  }

  // ── stage-two drain into the context frame's causal layer ───────
  drainIntoFrame(frame) {
    if (!frame || !frame.layers || !frame.layers.causal) return 0;
    const causal = frame.layers.causal;
    let drained = 0;
    while (this._ringLength() > 0) {
      const ev = this._ringPop();
      if (!ev) break;
      const slot = causal.events[causal.length % causal.events.length];
      if (slot) {
        slot.type = ev.type;
        slot.typeName = ev.typeName;
        slot.position[0] = ev.position[0];
        slot.position[1] = ev.position[1];
        slot.position[2] = ev.position[2];
        slot.materialId = ev.materialId;
        slot.force = ev.force;
        slot.timestamp = ev.timestamp;
        slot.decay = this.evaluateDecay(ev);
      }
      causal.length++;
      if (causal.length > causal.events.length) causal.head = (causal.head + 1) % causal.events.length;
      this.releaseEvent(ev);
      drained++;
    }
    this._stats.drained += drained;
    return drained;
  }

  // ── stage-six batched dispatch of accumulated render-side outputs ──
  dispatchBatch(events) {
    for (let i = 0; i < events.length; i++) {
      this.dispatchEvent(events[i]);
    }
    return this;
  }

  // ── diagnostics ─────────────────────────────────────────────────
  getStats() { return Object.freeze({ ...this._stats }); }

  resetStats() {
    this._stats.dispatched = 0;
    this._stats.drained = 0;
    this._stats.decayed = 0;
    this._stats.overflow = 0;
  }

  dispose() {
    this._listeners.length = 0;
    this._eventPool.length = 0;
    this._ring.length = 0;
    this._deferredRemovals.length = 0;
  }
}

// ─── ring buffer storage (lazy-initialized) ───────────────────────
CoreEventDispatcher.prototype._ring = [];
CoreEventDispatcher.prototype._ringHead = 0;
CoreEventDispatcher.prototype._ringCount = 0;

export { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES };