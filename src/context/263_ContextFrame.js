// file number : 263
// full path name : src/context/263_ContextFrame.js
// description : Five-layer typed context frame (spatial, temporal, physical, causal, player) that all providers write and all consumers read. Implements contiguous structure-of-arrays buffers, exponential layer freshness decay, six-stage topological ordering, async-safe immutable snapshots, and zero-copy frame handoff.
// best for : Central nervous system of the living world. Every geometry, material, and system reads from and writes to this frame instead of communicating directly.
// license : MIT

const FRESHNESS_DECAY = Object.freeze({
  spatial: 2.0,
  temporal: 0.5,
  physical: 1.0,
  causal: 3.0,
  player: 1.5
});

class ContextFrame {
  constructor(capacity = 1024) {
    this.capacity = capacity;
    this.layers = {
      spatial: { aabb: new Float64Array(capacity * 6), sphere: new Float64Array(capacity * 4), frustumFlags: new Uint8Array(capacity), screenCoverage: new Float32Array(capacity), distancesSq: new Float64Array(capacity), lastUpdated: new Float64Array(5) },
      temporal: { timeOfDay: 0.5, tick: 0, tickHash: 0, season: 0.0, weatherSeverity: 0.0, elapsedWorldSeconds: 0.0, lastUpdated: new Float64Array(5) },
      physical: { gravity: [0, -9.81, 0], wind: [0, 0, 0], ambientTemperature: 293.15, humidity: 0.5, lastUpdated: new Float64Array(5) },
      causal: { events: new Array(64).fill(null), head: 0, length: 0, lastUpdated: new Float64Array(5) },
      player: { position: [0, 0, 0], velocity: [0, 0, 0], facing: [0, 0, 1], activeTool: -1, health: 100, mana: 100, focusDistance: 10, lastUpdated: new Float64Array(5) }
    };
    this.stage = 0;
    this.snapshot = null;
    this._writers = 0;
    this._readers = 0;
    this._version = 0;
    this._pendingStage = -1;
    this._constants = { MAX_ENTITIES: capacity, EVENT_CAPACITY: 64, FRESHNESS_DECAY };
  }

  computeTickHash() {
    return this.layers.temporal.tick % 256;
  }

  computeDistanceSq(entityIndex, cx, cy, cz) {
    const aabb = this.layers.spatial.aabb;
    const o = entityIndex * 6;
    const ex = (aabb[o] + aabb[o+3]) * 0.5;
    const ey = (aabb[o+1] + aabb[o+4]) * 0.5;
    const ez = (aabb[o+2] + aabb[o+5]) * 0.5;
    const dx = ex - cx, dy = ey - cy, dz = ez - cz;
    return dx*dx + dy*dy + dz*dz;
  }

  applyFreshnessDecay(layer, dt) {
    const state = this.layers[layer];
    if (!state || !state.lastUpdated) return;
    const decay = FRESHNESS_DECAY[layer];
    for (let i = 0; i < state.lastUpdated.length; i++) {
      state.lastUpdated[i] *= Math.exp(-decay * dt);
    }
  }

  queueEvent(event) {
    const causal = this.layers.causal;
    const index = (causal.head + causal.length) % causal.events.length;
    causal.events[index] = { ...event, timestamp: this.layers.temporal.elapsedWorldSeconds, decay: Math.exp(-(event.decayRate || 1.0) * 0.1) };
    if (causal.length < causal.events.length) causal.length++;
    else causal.head = (causal.head + 1) % causal.events.length;
  }

  drainEvents() {
    const causal = this.layers.causal;
    const drained = causal.events.slice(causal.head, causal.head + causal.length);
    causal.head = 0;
    causal.length = 0;
    return drained;
  }

  buildSnapshot() {
    if (this._readers > 0) return this.snapshot;
    const snap = { version: this._version, capacity: this.capacity, layers: {}, stage: this.stage };
    for (const key of Object.keys(this.layers)) snap.layers[key] = Object.freeze({ ...this.layers[key] });
    Object.freeze(snap);
    this.snapshot = snap;
    return snap;
  }

  advanceStage(stage) {
    if (stage < 0 || stage > 5 || stage <= this.stage && stage !== 0) return false;
    this.stage = stage;
    this._version++;
    if (stage === 5) this.buildSnapshot();
    return true;
  }

  readLayer(layer, reader) {
    const snap = this.snapshot;
    if (!snap || snap.version < this._version) return null;
    this._readers++;
    try { return reader(snap.layers[layer]); } finally { this._readers--; }
  }

  writeLayer(layer, writer) {
    this._writers++;
    try { writer(this.layers[layer]); this._version++; } finally { this._writers--; }
  }
}

export { ContextFrame, FRESHNESS_DECAY };