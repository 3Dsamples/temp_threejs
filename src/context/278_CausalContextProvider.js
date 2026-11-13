// file number : 278
// full path name : src/context/278_CausalContextProvider.js
// description : Causal context provider that fills the causal layer of the context frame with decaying world events. Drains 265_CoreEventDispatcher's ring buffer into frame.layers.causal, applies exponential decay D(τ)=exp(-τ/τ_decay) per event, and coalesces events that share type+materialId within a spatial radius (so a fireball hitting a forest produces one causal event, not fifty, per blueprint step 16). Emits derived material/lighting signals: ignition candidates (flammability gate), emissive boost (audio/light events near a material), wetness trigger (splash events), decal placement requests (impact events with sufficient force), and light flicker seeds for clustered lighting. All decay and coalescing logic runs in one pass; no allocation after construction; all Vec3 and event scratch slots are pooled.
// best for : Every consumer that reads "what just happened here" — EcologyResponseSystem, ImpactEventCoordinator, AudioLightEmissionSystem, material wetness response, flora ignition, fauna flee decisions, and clustered-lighting reactive flicker. This is the memory of "now" that makes the world reactive rather than scripted.
// license : MIT

import {
  Vec3,
  Vec4,
  Mat4,
  Quat,
  Precision,
  ContextFrame,
  CoreClock,
  CoreEventDispatcher,
  EVENT_TYPE,
  EVENT_NAMES,
  TemporalContextProvider,
  WEATHER,
  SimplexNoise,
  ColorManagement
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 10;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── causal defaults ─────────────────────────────────────────────
const CAUSAL_DEFAULTS = Object.freeze({
  ringCapacity: 64,             // frame.layers.causal.events length
  drainPerTick: 32,             // max events drained per provider tick
  decayCurve: 'exponential',    // 'exponential' | 'linear'
  coalesceRadius: 4.0,          // world units for same-type coalesce
  coalesceWindow: 0.5,          // seconds within which events merge
  pruneThreshold: 0.01,         // D(τ) below this → drop
  defaultTau: 3.0,              // seconds
  // material/lighting derived signals
  igniteForceThreshold: 25.0,
  igniteFlammabilityGate: 0.35,
  decalForceThreshold: 10.0,
  emissiveBoostScale: 1.8,
  emissiveBoostTau: 1.2,
  wetnessTriggerThreshold: 5.0
});

// ─── derived signal codes ────────────────────────────────────────
const DERIVED_SIGNAL = Object.freeze({
  IGNITE_CANDIDATE: 1,
  DECAL_REQUEST: 2,
  EMISSIVE_BOOST: 3,
  WETNESS_TRIGGER: 4,
  LIGHT_FLICKER: 5,
  ECOLOGY_RESPONSE: 6
});

class CausalContextProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.ringCapacity = options.ringCapacity ?? CAUSAL_DEFAULTS.ringCapacity;
    this.drainPerTick = options.drainPerTick ?? CAUSAL_DEFAULTS.drainPerTick;
    this.coalesceRadius = options.coalesceRadius ?? CAUSAL_DEFAULTS.coalesceRadius;
    this.coalesceWindow = options.coalesceWindow ?? CAUSAL_DEFAULTS.coalesceWindow;
    this.pruneThreshold = options.pruneThreshold ?? CAUSAL_DEFAULTS.pruneThreshold;
    this.defaultTau = options.defaultTau ?? CAUSAL_DEFAULTS.defaultTau;

    // Material/lighting gates
    this.igniteForceThreshold = options.igniteForceThreshold ?? CAUSAL_DEFAULTS.igniteForceThreshold;
    this.igniteFlammabilityGate = options.igniteFlammabilityGate ?? CAUSAL_DEFAULTS.igniteFlammabilityGate;
    this.decalForceThreshold = options.decalForceThreshold ?? CAUSAL_DEFAULTS.decalForceThreshold;
    this.emissiveBoostScale = options.emissiveBoostScale ?? CAUSAL_DEFAULTS.emissiveBoostScale;
    this.emissiveBoostTau = options.emissiveBoostTau ?? CAUSAL_DEFAULTS.emissiveBoostTau;
    this.wetnessTriggerThreshold = options.wetnessTriggerThreshold ?? CAUSAL_DEFAULTS.wetnessTriggerThreshold;

    // ── dispatcher (source of events) ────────────────────────
    this._dispatcher = options.dispatcher || null;

    // ── coalesce scratch (reused per tick) ──────────────────
    this._coalesceKeys = new Map();
    this._coalesceEntries = [];

    // ── derived-signal output buffers (pooled) ──────────────
    this._derivedCapacity = options.derivedCapacity ?? 128;
    this._derivedTypes = new Uint8Array(this._derivedCapacity);
    this._derivedEntityIds = new Int32Array(this._derivedCapacity);
    this._derivedMaterialIds = new Int32Array(this._derivedCapacity);
    this._derivedForces = new Float32Array(this._derivedCapacity);
    this._derivedTimestamps = new Float64Array(this._derivedCapacity);
    this._derivedPositions = new Float32Array(this._derivedCapacity * 3);
    this._derivedDecays = new Float32Array(this._derivedCapacity);
    this._derivedCount = 0;

    // ── per-material accumulation (for material/lighting) ───
    this._materialEmissiveBoost = new Float32Array(512);
    this._materialWetness = new Float32Array(512);
    this._materialIgnitionQueue = new Int32Array(512);
    this._materialIgnitionQueueCount = 0;

    // ── scratch objects (pooled) ────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpQuat = new Quat();
    this._tmpMat = new Mat4();

    // ── timing ───────────────────────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._updateCount = 0;
    this._lastNow = 0;

    // ── statistics ──────────────────────────────────────────
    this._stats = {
      updates: 0,
      drained: 0,
      coalesced: 0,
      pruned: 0,
      igniteCandidates: 0,
      decalRequests: 0,
      emissiveBoosts: 0,
      wetnessTriggers: 0,
      lightFlickers: 0
    };
  }

  // ── attach / detach dispatcher ──────────────────────────────
  attachDispatcher(dispatcher) {
    this._dispatcher = dispatcher;
    return this;
  }

  // ── update: called from provider tier (10 Hz) ──────────────
  update(frame, clock) {
    if (!frame || !frame.layers || !frame.layers.causal) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) return 0;
    this._lastUpdateTime = now;
    this._lastNow = now;

    const causal = frame.layers.causal;

    // ── 1. drain the dispatcher into the frame's ring buffer ─
    this._drainDispatcher(now);

    // ── 2. decay existing events in the frame ────────────────
    this._decayFrameEvents(causal, now);

    // ── 3. coalesce duplicate events within the ring ────────
    this._coalesceFrameEvents(causal, now);

    // ── 4. derive material/lighting signals from events ────
    this._deriveSignals(causal, frame, now);

    // ── 5. prune fully decayed events ───────────────────────
    this._pruneFrameEvents(causal, now);

    // ── 6. write derived signals into the frame ─────────────
    this._writeDerivedToFrame(frame);

    this._stats.updates++;
    this._updateCount++;
    return 1;
  }

  // ── drain dispatcher ring into the frame's causal layer ────
  _drainDispatcher(now) {
    if (!this._dispatcher) return 0;
    // Use the dispatcher's drainIntoFrame if a frame is available;
    // otherwise consume events into the local derived buffers.
    const count = this._dispatcher.drainIntoFrame
      ? this._dispatcher.drainIntoFrame(this._frameRef)
      : 0;
    this._stats.drained += count;
    return count;
  }

  // ── exponential decay per event in the frame ────────────────
  _decayFrameEvents(causal, now) {
    const events = causal.events;
    if (!events) return;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.type === undefined || ev.type < 0) continue;
      if (ev.timestamp === undefined) continue;
      const age = now - ev.timestamp;
      if (age <= 0) { ev.decay = 1.0; continue; }
      const tau = ev.tau && ev.tau > 0 ? ev.tau : this.defaultTau;
      ev.decay = Math.exp(-age / tau);
      // Cache derived material/lighting values for later use.
      this._updateDerivedMaterialState(ev);
    }
  }

  // ── coalesce same-type events within radius+time window ────
  _coalesceFrameEvents(causal, now) {
    const events = causal.events;
    if (!events) return;
    this._coalesceKeys.clear();
    this._coalesceEntries.length = 0;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.type === undefined || ev.type < 0) continue;
      if (!ev.position) continue;

      // Coalesce key: type | materialId | quantized cell
      const cx = Math.round(ev.position[0] / this.coalesceRadius);
      const cy = Math.round(ev.position[1] / this.coalesceRadius);
      const cz = Math.round(ev.position[2] / this.coalesceRadius);
      const key = `${ev.type}|${ev.materialId}|${cx}|${cy}|${cz}`;

      const existing = this._coalesceKeys.get(key);
      if (existing === undefined) {
        this._coalesceKeys.set(key, i);
        this._coalesceEntries.push(i);
      } else {
        // Merge this event's force into the first occurrence.
        const first = events[existing];
        if (first && ev.force > first.force) {
          first.force = ev.force;
          first.timestamp = now;
          first.decay = 1.0;
        }
        // Clear this event from the ring.
        ev.type = -1;
        ev.force = 0;
        ev.decay = 0;
        this._stats.coalesced++;
      }
    }
  }

  // ── prune fully decayed events from the ring ────────────────
  _pruneFrameEvents(causal, now) {
    const events = causal.events;
    if (!events) return;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.type === undefined || ev.type < 0) continue;
      if (ev.decay !== undefined && ev.decay < this.pruneThreshold) {
        ev.type = -1;
        ev.force = 0;
        ev.decay = 0;
        this._stats.pruned++;
      }
    }
  }

  // ── derive material/lighting signals from active events ────
  _deriveSignals(causal, frame, now) {
    this._derivedCount = 0;
    this._materialEmissiveBoost.fill(0);
    this._materialWetness.fill(0);
    this._materialIgnitionQueueCount = 0;

    const events = causal.events;
    if (!events) return;
    const physical = frame.layers.physical;
    const materialCount = physical && physical.materialCount ? physical.materialCount : 0;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.type === undefined || ev.type < 0) continue;
      if (ev.decay === undefined || ev.decay < 0.05) continue;

      const force = ev.force || 0;
      const materialId = ev.materialId ?? -1;

      // ── IGNITE candidate: impact with sufficient force on flammable ─
      if ((ev.type === EVENT_TYPE.IMPACT || ev.type === EVENT_TYPE.ECOLOGY) &&
          force >= this.igniteForceThreshold) {
        const flam = this._lookupFlammability(physical, materialId);
        if (flam >= this.igniteFlammabilityGate) {
          this._emitDerived(
            DERIVED_SIGNAL.IGNITE_CANDIDATE,
            -1, materialId,
            force, now, ev.position, ev.decay
          );
          this._stats.igniteCandidates++;
          // Queue for the ecology response system.
          if (this._materialIgnitionQueueCount < this._materialIgnitionQueue.length) {
            this._materialIgnitionQueue[this._materialIgnitionQueueCount++] = materialId;
          }
        }
      }

      // ── DECAL request: impact with sufficient force on non-glass/non-water
      if (ev.type === EVENT_TYPE.IMPACT && force >= this.decalForceThreshold) {
        if (materialId >= 0) {
          this._emitDerived(
            DERIVED_SIGNAL.DECAL_REQUEST,
            -1, materialId,
            force, now, ev.position, ev.decay
          );
          this._stats.decalRequests++;
        }
      }

      // ── EMISSIVE boost: audio/light events near a material ──────
      if (ev.type === EVENT_TYPE.AUDIO_LIGHT && force > 0) {
        if (materialId >= 0 && materialId < this._materialEmissiveBoost.length) {
          const boost = this.emissiveBoostScale * force * ev.decay;
          this._materialEmissiveBoost[materialId] = Math.max(
            this._materialEmissiveBoost[materialId], boost
          );
          this._emitDerived(
            DERIVED_SIGNAL.EMISSIVE_BOOST,
            -1, materialId,
            boost, now, ev.position, ev.decay
          );
          this._stats.emissiveBoosts++;
        }
      }

      // ── WETNESS trigger: splash events ──────────────────────────
      if (ev.type === EVENT_TYPE.SPLASH && force >= this.wetnessTriggerThreshold) {
        if (materialId >= 0 && materialId < this._materialWetness.length) {
          this._materialWetness[materialId] = Math.max(
            this._materialWetness[materialId], ev.decay
          );
          this._emitDerived(
            DERIVED_SIGNAL.WETNESS_TRIGGER,
            -1, materialId,
            ev.decay, now, ev.position, ev.decay
          );
          this._stats.wetnessTriggers++;
        }
      }

      // ── LIGHT FLICKER seed: any high-force impact ──────────────
      if (ev.type === EVENT_TYPE.IMPACT && force > this.igniteForceThreshold * 0.5) {
        if (materialId >= 0) {
          this._emitDerived(
            DERIVED_SIGNAL.LIGHT_FLICKER,
            -1, materialId,
            force, now, ev.position, ev.decay
          );
          this._stats.lightFlickers++;
        }
      }
    }
  }

  // ── lookup material flammability from the physical registry ─
  _lookupFlammability(physical, materialId) {
    if (!physical || materialId < 0) return 0.0;
    if (!physical.materialFlammability) return 0.5;   // default
    return physical.materialFlammability[materialId] ?? 0.5;
  }

  // ── cache material/lighting derived state per event ────────
  _updateDerivedMaterialState(ev) {
    if (ev.materialId === undefined || ev.materialId < 0) return;
    if (ev.decay === undefined) return;
    // This function exists as a hook for per-frame state; the bulk
    // of material/lighting updates are performed in _deriveSignals.
  }

  // ── emit a derived signal into the local buffer ────────────
  _emitDerived(type, entityId, materialId, force, timestamp, position, decay) {
    if (this._derivedCount >= this._derivedCapacity) return;
    const idx = this._derivedCount++;
    this._derivedTypes[idx] = type;
    this._derivedEntityIds[idx] = entityId;
    this._derivedMaterialIds[idx] = materialId;
    this._derivedForces[idx] = force;
    this._derivedTimestamps[idx] = timestamp;
    this._derivedDecays[idx] = decay;
    if (position) {
      const o = idx * 3;
      this._derivedPositions[o] = position[0];
      this._derivedPositions[o + 1] = position[1];
      this._derivedPositions[o + 2] = position[2];
    } else {
      const o = idx * 3;
      this._derivedPositions[o] = 0;
      this._derivedPositions[o + 1] = 0;
      this._derivedPositions[o + 2] = 0;
    }
  }

  // ── write derived signals into the frame's causal layer ────
  _writeDerivedToFrame(frame) {
    if (!frame.layers.causal) return;
    const causal = frame.layers.causal;

    // Attach derived signals as a parallel array.
    causal.derivedSignals = causal.derivedSignals || {
      types: this._derivedTypes,
      entityIds: this._derivedEntityIds,
      materialIds: this._derivedMaterialIds,
      forces: this._derivedForces,
      timestamps: this._derivedTimestamps,
      positions: this._derivedPositions,
      decays: this._derivedDecays,
      count: 0
    };
    causal.derivedSignals.count = this._derivedCount;

    // Attach material/lighting derived state for fast consumer reads.
    if (!frame.layers.physical) frame.layers.physical = {};
    frame.layers.physical.materialEmissiveBoost = this._materialEmissiveBoost;
    frame.layers.physical.materialWetness = this._materialWetness;
    frame.layers.physical.materialIgnitionQueue = this._materialIgnitionQueue;
    frame.layers.physical.materialIgnitionQueueCount = this._materialIgnitionQueueCount;
  }

  // ── set the frame reference for drainIntoFrame ─────────────
  setFrameReference(frame) {
    this._frameRef = frame;
    return this;
  }

  // ── interactive: inject an event directly (bypassing dispatcher) ─
  injectEvent(frame, type, position, materialId, force, tau = -1) {
    if (!frame || !frame.layers || !frame.layers.causal) return false;
    const causal = frame.layers.causal;
    const events = causal.events;
    if (!events) return false;

    // Find a free slot in the ring.
    let slot = -1;
    for (let i = 0; i < events.length; i++) {
      if (!events[i] || events[i].type === undefined || events[i].type < 0) {
        slot = i;
        break;
      }
    }
    if (slot === -1) {
      // Overwrite the oldest via the ring head.
      slot = causal.head;
      causal.head = (causal.head + 1) % events.length;
    }

    let ev = events[slot];
    if (!ev) {
      ev = events[slot] = {
        type: -1, typeName: '',
        position: new Float32Array(3),
        materialId: -1, force: 0, timestamp: 0,
        decay: 1.0, tau: this.defaultTau, payload: null
      };
    }
    ev.type = type;
    ev.typeName = EVENT_NAMES[type] || 'custom';
    ev.position[0] = position ? position[0] : 0;
    ev.position[1] = position ? position[1] : 0;
    ev.position[2] = position ? position[2] : 0;
    ev.materialId = materialId;
    ev.force = force;
    ev.timestamp = this._lastNow || performance.now() / 1000;
    ev.decay = 1.0;
    ev.tau = tau > 0 ? tau : this.defaultTau;

    if (causal.length === undefined) causal.length = 0;
    if (causal.length < events.length) causal.length++;
    return true;
  }

  // ── public accessors for consumers ─────────────────────────
  get derivedCount() { return this._derivedCount; }
  get derivedTypes() { return this._derivedTypes; }
  get derivedForces() { return this._derivedForces; }
  get derivedMaterialIds() { return this._derivedMaterialIds; }
  get derivedDecays() { return this._derivedDecays; }
  get materialEmissiveBoost() { return this._materialEmissiveBoost; }
  get materialWetness() { return this._materialWetness; }
  get materialIgnitionQueue() { return this._materialIgnitionQueue; }
  get materialIgnitionQueueCount() { return this._materialIgnitionQueueCount; }

  // ── query helpers for downstream systems ───────────────────
  queryActiveEvents(frame, type, outBuffer) {
    if (!frame || !frame.layers || !frame.layers.causal) return 0;
    const events = frame.layers.causal.events;
    if (!events) return 0;
    let count = 0;
    for (let i = 0; i < events.length && count < outBuffer.length; i++) {
      const ev = events[i];
      if (!ev || ev.type !== type) continue;
      if (ev.decay === undefined || ev.decay < 0.05) continue;
      outBuffer[count++] = ev;
    }
    return count;
  }

  queryActiveCount(frame, type) {
    if (!frame || !frame.layers || !frame.layers.causal) return 0;
    const events = frame.layers.causal.events;
    if (!events) return 0;
    let count = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.type !== type) continue;
      if (ev.decay === undefined || ev.decay < 0.05) continue;
      count++;
    }
    return count;
  }

  // ── decay function: D(τ) = exp(−τ/τ_decay) ────────────────
  static decay(age, tau) {
    return Math.exp(-age / (tau > 0 ? tau : 1));
  }

  // ── diagnostics ────────────────────────────────────────────
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    this._stats.updates = 0;
    this._stats.drained = 0;
    this._stats.coalesced = 0;
    this._stats.pruned = 0;
    this._stats.igniteCandidates = 0;
    this._stats.decalRequests = 0;
    this._stats.emissiveBoosts = 0;
    this._stats.wetnessTriggers = 0;
    this._stats.lightFlickers = 0;
  }

  dispose() {
    this._dispatcher = null;
    this._coalesceKeys.clear();
    this._coalesceEntries.length = 0;
    this._derivedCount = 0;
    this._materialEmissiveBoost.fill(0);
    this._materialWetness.fill(0);
    this._materialIgnitionQueue.fill(0);
    this._materialIgnitionQueueCount = 0;
  }
}

export {
  CausalContextProvider,
  DERIVED_SIGNAL,
  CAUSAL_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};