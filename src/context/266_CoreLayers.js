// file number : 266
// full path name : src/context/266_CoreLayers.js
// description : Canonical bit-mask layer registry (32 layers, 0–31) for the living world. Defines named layer indices for spatial tiers, chunk scales, render passes, materials, lights, shadows, and special systems. Provides zero-allocation bitwise helpers (test, intersect, union, difference) built on the Layers class imported from 264_MathECSImportBarrel, with reserved WebXR layers (1 and 2) documented and skipped.
// best for : Bucket-level frustum culling, occlusion-graph visibility decisions, tier gating (60/10/1 Hz), and render-pass filtering. Every system that asks "is this object visible to this camera?" or "does this object belong to this tier?" reads its mask from here.
// license : MIT

import {
  Layers,
  Precision,
  BitECS,
  World,
  Components,
  Systems,
  Vec3,
  Mat4
} from './264_MathECSImportBarrel.js';

// ─── 32-layer index registry ──────────────────────────────────────
// Layer 0 is the default (everything that is not explicitly assigned).
// Layers 1 and 2 are reserved by WebXR for left/right eye rendering.
// Every layer from 3 to 31 is available to the living world.
const LAYER = Object.freeze({
  DEFAULT: 0,

  // WebXR-reserved (do not assign to world entities)
  // XR_LEFT: 1,
  // XR_RIGHT: 2,

  // ── spatial tiers ──────────────────────────────────────────────
  NEAR: 3,          // < 10 world units
  MID: 4,           // 10–100 units
  FAR: 5,           // 100–1,000 units
  DISTANT: 6,       // 1–10 km
  REGIONAL: 7,      // 10–100 km
  CONTINENTAL: 8,   // 100–1,000 km
  PLANETARY: 9,     // 1,000–10,000 km
  STELLAR: 10,      // 10,000–100,000 km

  // ── chunk scales ──────────────────────────────────────────────
  CHUNK_KM: 11,     // 1 km chunks
  CHUNK_10KM: 12,   // 10 km chunks
  CHUNK_100KM: 13,  // 100 km chunks

  // ── render passes ─────────────────────────────────────────────
  SHADOW_CAST: 14,
  SHADOW_RECEIVE: 15,
  DEPTH_PREPASS: 16,
  TRANSPARENT: 17,
  VOLUMETRIC: 18,
  UI_BILLBOARD: 19,

  // ── materials & lighting ──────────────────────────────────────
  PBR_OPAQUE: 20,
  PBR_TRANSLUCENT: 21,
  ANIME_OPAQUE: 22,
  ANIME_TRANSLUCENT: 23,
  EMISSIVE: 24,
  IGNITED: 25,      // currently on fire or recently ignited
  WET: 26,          // wetness response active
  BIOME_BLEND: 27,  // ecotone band where two biomes mix

  // ── special systems ───────────────────────────────────────────
  PLAYER: 28,
  FAUNA: 29,
  FLORA: 30,
  DEBUG_OVERLAY: 31
});

// ─── human-readable names for diagnostics ─────────────────────────
const LAYER_NAMES = Object.freeze(
  Object.keys(LAYER).reduce((acc, key) => {
    acc[LAYER[key]] = key;
    return acc;
  }, {})
);

// ─── precomputed single-bit masks ────────────────────────────────
const LAYER_MASKS = Object.freeze(
  Object.keys(LAYER).reduce((acc, key) => {
    acc[key] = 1 << LAYER[key];
    return acc;
  }, {})
);

class CoreLayers {
  constructor(options = {}) {
    // The internal Layers instance tracks the current membership mask.
    // It is the same class that Three.js Object3D uses, so it can be
    // handed directly to a Mesh, Camera, or Raycaster without conversion.
    this._layers = new Layers();

    // Precomputed masks for batch operations.
    this._allWorldMask = this._computeAllWorldMask();
    this._spatialMask = this._computeMaskGroup([
      'NEAR', 'MID', 'FAR', 'DISTANT', 'REGIONAL',
      'CONTINENTAL', 'PLANETARY', 'STELLAR'
    ]);
    this._chunkMask = this._computeMaskGroup([
      'CHUNK_KM', 'CHUNK_10KM', 'CHUNK_100KM'
    ]);
    this._materialMask = this._computeMaskGroup([
      'PBR_OPAQUE', 'PBR_TRANSLUCENT', 'ANIME_OPAQUE',
      'ANIME_TRANSLUCENT', 'EMISSIVE'
    ]);
    this._lightingMask = this._computeMaskGroup([
      'EMISSIVE', 'IGNITED', 'SHADOW_CAST', 'SHADOW_RECEIVE'
    ]);

    // Apply the initial mask if provided.
    if (options.initialMask !== undefined) {
      this._layers.mask = options.initialMask >>> 0;
    } else {
      this._layers.set(LAYER.DEFAULT);
    }

    this._stats = { queries: 0, mutations: 0 };
  }

  // ── group mask precomputation ───────────────────────────────────
  _computeMaskGroup(names) {
    let mask = 0;
    for (let i = 0; i < names.length; i++) {
      mask |= (1 << LAYER[names[i]]);
    }
    return mask >>> 0;
  }

  _computeAllWorldMask() {
    let mask = 0;
    for (const key of Object.keys(LAYER)) {
      // Skip DEFAULT (0) and XR-reserved (1, 2) only if they existed.
      // Every layer 0–31 that is part of the world registry is included.
      mask |= (1 << LAYER[key]);
    }
    return mask >>> 0;
  }

  // ── membership accessors ────────────────────────────────────────
  get mask() { return this._layers.mask; }

  set mask(value) {
    this._layers.mask = value >>> 0;
    this._stats.mutations++;
  }

  get layers() { return this._layers; }

  // ── single-layer operations ─────────────────────────────────────
  enable(layerIndex) {
    this._layers.enable(layerIndex);
    this._stats.mutations++;
    return this;
  }

  disable(layerIndex) {
    this._layers.disable(layerIndex);
    this._stats.mutations++;
    return this;
  }

  toggle(layerIndex) {
    this._layers.toggle(layerIndex);
    this._stats.mutations++;
    return this;
  }

  set(layerIndex) {
    this._layers.set(layerIndex);
    this._stats.mutations++;
    return this;
  }

  isEnabled(layerIndex) {
    this._stats.queries++;
    return this._layers.isEnabled(layerIndex);
  }

  // ── cross-object layer tests (zero allocation) ──────────────────
  // Returns true if this and the other Layers share at least one layer.
  test(otherLayers) {
    this._stats.queries++;
    return this._layers.test(otherLayers);
  }

  // Bitwise intersection: (this.mask & otherMask) !== 0
  intersectsMask(otherMask) {
    this._stats.queries++;
    return (this._layers.mask & (otherMask >>> 0)) !== 0;
  }

  // ── batch group tests ───────────────────────────────────────────
  isSpatial() {
    return this.intersectsMask(this._spatialMask);
  }

  isChunk() {
    return this.intersectsMask(this._chunkMask);
  }

  isMaterial() {
    return this.intersectsMask(this._materialMask);
  }

  isLighting() {
    return this.intersectsMask(this._lightingMask);
  }

  // ── frustum-culling fast path ───────────────────────────────────
  // Given a camera's Layers and a visibility mask, decides in one
  // bitwise AND whether the object should enter the render list.
  isVisibleTo(cameraLayers, visibilityMask = 0xFFFFFFFF) {
    this._stats.queries++;
    const combined = (this._layers.mask & cameraLayers.mask & visibilityMask) >>> 0;
    return combined !== 0;
  }

  // ── static helpers (no instance needed) ─────────────────────────
  static maskOf(layerIndex) {
    return (1 << layerIndex) >>> 0;
  }

  static maskGroup(layerIndices) {
    let m = 0;
    for (let i = 0; i < layerIndices.length; i++) {
      m |= (1 << layerIndices[i]);
    }
    return m >>> 0;
  }

  static nameOf(layerIndex) {
    return LAYER_NAMES[layerIndex] || 'UNKNOWN';
  }

  // ── copy / clone ────────────────────────────────────────────────
  copy(other) {
    this._layers.mask = other._layers.mask;
    return this;
  }

  clone() {
    const c = new CoreLayers();
    c._layers.mask = this._layers.mask;
    return c;
  }

  // ── diagnostics ─────────────────────────────────────────────────
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  describeMask() {
    const bits = [];
    for (let i = 0; i < 32; i++) {
      if ((this._layers.mask & (1 << i)) !== 0) {
        bits.push(LAYER_NAMES[i] || `BIT_${i}`);
      }
    }
    return bits;
  }
}

export { CoreLayers, LAYER, LAYER_NAMES, LAYER_MASKS };