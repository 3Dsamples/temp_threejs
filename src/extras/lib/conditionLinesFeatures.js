// file number : 149
// full path name : src/extras/lib/conditionLinesFeatures.js
// description : Complete dynamic orchestrator for the conditional-lines toolchain (features 133–148). Loads all 16 feature modules into a single registry, exposes runtime on/off toggles per feature, per-category, and per-preset, resolves the best available implementation for each capability (edge-geometry, line-material, topology-helper, culling-batch, buffer-helper, debug-tool, bake-tool, merge-builder), and returns safe nulls instead of throwing when a feature is disabled — so the rendering pipeline never breaks. Provides capability factories that transparently handle the three different geometry-construction APIs across the toolchain (constructor-based, accumulate+finalize, detect-based), a state hash for cache invalidation, preset profile detection, a debug string for HUD display, and a full EventDispatcher integration (using 083_EventDispatcher.js) so external systems can subscribe to toggle changes. Zero CDN imports. Uses the project’s core/math/ecs modules exclusively. Designed to keep 10k+ conditional line meshes running smoothly on Android 64-bit while authoring / debugging / toggling features at runtime.
// best for : Central control panel for the entire conditional-lines feature set, runtime feature experimentation, preset-based rendering profiles (performance / fidelity / anime / cad / debug / mobile-export), ECS-driven dynamic feature toggling, safe fallback when features are disabled, and any living-world pipeline that needs per-frame feature flexibility at 10k+ entity scale on Android 64-bit.
// license : MIT

import { EventDispatcher } from '../core/083_EventDispatcher.js';

// ---------------------------------------------------------------------------
// Feature modules (133–148)
// ---------------------------------------------------------------------------
import { CombinedEdgesGeometry } from './133_CombinedEdgesGeometry.js';
import { TriangleIntersectionEdgesGeometry } from './134_TriangleIntersectionEdgesGeometry.js';
import { AttenuatedLineMaterial } from './135_AttenuatedLineMaterial.js';
import { CurvatureLineMaterial } from './136_CurvatureLineMaterial.js';
import { GPUConditionalEdges } from './137_GPUConditionalEdges.js';
import { CulledEdgesBatch } from './138_CulledEdgesBatch.js';
import { EdgesBufferUpdater } from './139_EdgesBufferUpdater.js';
import { VertexColorLineMaterial } from './140_VertexColorLineMaterial.js';
import { EdgeTypeTaggedGeometry } from './141_EdgeTypeTaggedGeometry.js';
import { ConditionalToonMaterial } from './142_ConditionalToonMaterial.js';
import { TIntersectionSplitter } from './143_TIntersectionSplitter.js';
import { ManifoldEdgeDetector } from './144_ManifoldEdgeDetector.js';
import { DoubleSidedOutsideEdges } from './145_DoubleSidedOutsideEdges.js';
import { ConditionalEdgesDebug } from './146_ConditionalEdgesDebug.js';
import { ConditionalEdgesBaker } from './147_ConditionalEdgesBaker.js';
import { MergedConditionalEdges } from './148_MergedConditionalEdges.js';

// ---------------------------------------------------------------------------
// Feature registry
//
// Each entry has:
//   id              : stable string identifier used by the toggle API
//   file            : numeric source file number
//   category        : 'fidelity' | 'performance' | 'anime' | 'robustness' | 'tooling'
//   Module          : the imported class
//   kind            : see below
//   priority        : higher wins when multiple features of the same kind are enabled
//   defaultEnabled  : whether this feature starts enabled in 'default' initial state
//   description     : human-readable one-liner
//   factory         : (source, orchestrator, options) => instance|null
//                     Only used for 'edge-producer' kind; material factories are generic.
//
// Kinds:
//   'edge-producer'      — constructs a renderable edge geometry from a source mesh
//   'material-producer'  — constructs a conditional line material
//   'geometry-transformer' — consumes an edge geometry and returns a transformed one
//   'batch-builder'      — merges multiple edge geometries into one
//   'culling-batch'      — per-scene frustum-culled edge batch
//   'buffer-helper'      — partial-upload helper
//   'topology-helper'    — split / detect utilities
//   'debug-tool'         — debug visualizer
//   'bake-tool'          — offline bake
// ---------------------------------------------------------------------------
const FEATURES = {
  'combined-edges': {
    id: 'combined-edges',
    file: 133,
    category: 'fidelity',
    Module: CombinedEdgesGeometry,
    kind: 'edge-producer',
    priority: 100,
    defaultEnabled: true,
    description: 'Single-pass hard + smooth + silhouette edge generator',
    factory: (source, orchestrator, options) => {
      return new CombinedEdgesGeometry(source, options.thresholdDot);
    },
  },

  'triangle-intersection-edges': {
    id: 'triangle-intersection-edges',
    file: 134,
    category: 'fidelity',
    Module: TriangleIntersectionEdgesGeometry,
    kind: 'edge-producer',
    priority: 80,
    defaultEnabled: false,
    description: 'Self-intersection edge detector (BVH-accelerated)',
    factory: (source, orchestrator, options) => {
      return new TriangleIntersectionEdgesGeometry(source, options.detectOptions || {});
    },
  },

  'attenuated-line-material': {
    id: 'attenuated-line-material',
    file: 135,
    category: 'fidelity',
    Module: AttenuatedLineMaterial,
    kind: 'material-producer',
    priority: 100,
    defaultEnabled: true,
    description: 'Fat-line material with distance attenuation',
  },

  'curvature-line-material': {
    id: 'curvature-line-material',
    file: 136,
    category: 'fidelity',
    Module: CurvatureLineMaterial,
    kind: 'material-producer',
    priority: 90,
    defaultEnabled: false,
    description: 'Curvature-modulated fat-line material',
  },

  'gpu-conditional-edges': {
    id: 'gpu-conditional-edges',
    file: 137,
    category: 'performance',
    Module: GPUConditionalEdges,
    kind: 'edge-producer',
    priority: 95,
    defaultEnabled: false,
    description: 'GPU-side edge detection via transform feedback',
    factory: (source, orchestrator, options) => {
      const detector = new GPUConditionalEdges(options.detectOptions || {});
      detector.detect(source, options.gpuOptions || options.detectOptions || {});
      return detector;
    },
  },

  'culled-edges-batch': {
    id: 'culled-edges-batch',
    file: 138,
    category: 'performance',
    Module: CulledEdgesBatch,
    kind: 'culling-batch',
    priority: 100,
    defaultEnabled: false,
    description: 'Frustum-culling-aware edge batch',
  },

  'edges-buffer-updater': {
    id: 'edges-buffer-updater',
    file: 139,
    category: 'performance',
    Module: EdgesBufferUpdater,
    kind: 'buffer-helper',
    priority: 100,
    defaultEnabled: false,
    description: 'Partial-upload buffer updater for skinned meshes',
  },

  'vertex-color-line-material': {
    id: 'vertex-color-line-material',
    file: 140,
    category: 'anime',
    Module: VertexColorLineMaterial,
    kind: 'material-producer',
    priority: 85,
    defaultEnabled: false,
    description: 'Per-instance vertex-color fat-line material',
  },

  'edge-type-tagged-geometry': {
    id: 'edge-type-tagged-geometry',
    file: 141,
    category: 'anime',
    Module: EdgeTypeTaggedGeometry,
    kind: 'geometry-transformer',
    priority: 100,
    defaultEnabled: false,
    description: 'Edge geometry with unified edgeType attribute',
  },

  'conditional-toon-material': {
    id: 'conditional-toon-material',
    file: 142,
    category: 'anime',
    Module: ConditionalToonMaterial,
    kind: 'material-producer',
    priority: 95,
    defaultEnabled: false,
    description: 'MToon-compatible toon-shaded line material',
  },

  't-intersection-splitter': {
    id: 't-intersection-splitter',
    file: 143,
    category: 'robustness',
    Module: TIntersectionSplitter,
    kind: 'topology-helper',
    priority: 100,
    defaultEnabled: false,
    description: 'Detects and splits T-junctions',
  },

  'manifold-edge-detector': {
    id: 'manifold-edge-detector',
    file: 144,
    category: 'robustness',
    Module: ManifoldEdgeDetector,
    kind: 'topology-helper',
    priority: 100,
    defaultEnabled: false,
    description: 'Diagnoses non-manifold and degenerate edges',
  },

  'double-sided-outside-edges': {
    id: 'double-sided-outside-edges',
    file: 145,
    category: 'robustness',
    Module: DoubleSidedOutsideEdges,
    kind: 'edge-producer',
    priority: 70,
    defaultEnabled: false,
    description: 'Outside edges for double-sided meshes',
    factory: (source, orchestrator, options) => {
      return new DoubleSidedOutsideEdges(source, options.windingOptions || {});
    },
  },

  'conditional-edges-debug': {
    id: 'conditional-edges-debug',
    file: 146,
    category: 'tooling',
    Module: ConditionalEdgesDebug,
    kind: 'debug-tool',
    priority: 100,
    defaultEnabled: false,
    description: 'Debug visualizer for edge attributes',
  },

  'conditional-edges-baker': {
    id: 'conditional-edges-baker',
    file: 147,
    category: 'tooling',
    Module: ConditionalEdgesBaker,
    kind: 'bake-tool',
    priority: 100,
    defaultEnabled: false,
    description: 'Offline bake to static LineSegments geometry',
  },

  'merged-conditional-edges': {
    id: 'merged-conditional-edges',
    file: 148,
    category: 'tooling',
    Module: MergedConditionalEdges,
    kind: 'batch-builder',
    priority: 100,
    defaultEnabled: false,
    description: 'Merge multiple edge sources into one draw call',
  },
};

// ---------------------------------------------------------------------------
// Category groupings
// ---------------------------------------------------------------------------
const CATEGORIES = {
  fidelity: ['combined-edges', 'triangle-intersection-edges', 'attenuated-line-material', 'curvature-line-material'],
  performance: ['gpu-conditional-edges', 'culled-edges-batch', 'edges-buffer-updater'],
  anime: ['vertex-color-line-material', 'edge-type-tagged-geometry', 'conditional-toon-material'],
  robustness: ['t-intersection-splitter', 'manifold-edge-detector', 'double-sided-outside-edges'],
  tooling: ['conditional-edges-debug', 'conditional-edges-baker', 'merged-conditional-edges'],
};

// ---------------------------------------------------------------------------
// Preset profiles
// ---------------------------------------------------------------------------
const PRESETS = {
  safe: ['combined-edges', 'attenuated-line-material'],

  performance: [
    'gpu-conditional-edges',
    'attenuated-line-material',
    'culled-edges-batch',
    'edges-buffer-updater',
  ],

  fidelity: [
    'combined-edges',
    'triangle-intersection-edges',
    'curvature-line-material',
  ],

  anime: [
    'combined-edges',
    'edge-type-tagged-geometry',
    'vertex-color-line-material',
    'conditional-toon-material',
  ],

  cad: [
    'combined-edges',
    't-intersection-splitter',
    'manifold-edge-detector',
    'double-sided-outside-edges',
  ],

  debug: [
    'combined-edges',
    'attenuated-line-material',
    'conditional-edges-debug',
  ],

  'mobile-export': [
    'conditional-edges-baker',
    'merged-conditional-edges',
    'attenuated-line-material',
  ],

  all: Object.keys(FEATURES),
};

// ---------------------------------------------------------------------------
// ConditionalLinesFeatures — dynamic orchestrator for the toolchain.
// ---------------------------------------------------------------------------
class ConditionalLinesFeatures extends EventDispatcher {
  /**
   * @param {object} [options={}]
   * @param {string} [options.initialState='default'] — 'default' | 'safe' |
   *   'all-on' | 'all-off' | any PRESETS key
   * @param {boolean} [options.warn=true] — emit console warnings when a
   *   requested feature is unavailable
   */
  constructor(options = {}) {
    super();

    this.isConditionalLinesFeatures = true;
    this.type = 'ConditionalLinesFeatures';

    this._warnEnabled = options.warn !== undefined ? !!options.warn : true;
    this._warnedMessages = new Set();

    // State — featureId -> boolean
    this._state = new Map();

    // Singletons (lazily created)
    this._singletons = {
      manifoldDetector: null,
      tIntersectionSplitter: null,
    };

    // State hash cache
    this._stateHash = null;

    // Apply the initial state
    const initialState = options.initialState !== undefined ? options.initialState : 'default';
    this._applyInitialState(initialState);
  }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  /**
   * Apply the initial feature state.
   * @private
   */
  _applyInitialState(state) {
    // Reset all state
    this._state.clear();

    if (state === 'all-on') {
      for (const id of Object.keys(FEATURES)) this._state.set(id, true);
    } else if (state === 'all-off') {
      for (const id of Object.keys(FEATURES)) this._state.set(id, false);
    } else if (PRESETS[state]) {
      for (const id of Object.keys(FEATURES)) this._state.set(id, PRESETS[state].includes(id));
    } else if (state === 'safe') {
      for (const id of Object.keys(FEATURES)) this._state.set(id, PRESETS.safe.includes(id));
    } else {
      // 'default' — use the per-feature defaultEnabled flag
      for (const id of Object.keys(FEATURES)) {
        this._state.set(id, FEATURES[id].defaultEnabled === true);
      }
    }

    this._stateHash = null;
  }

  // -----------------------------------------------------------------------
  // Toggle API
  // -----------------------------------------------------------------------

  /**
   * Check whether a feature is enabled.
   * @param {string} id
   * @returns {boolean}
   */
  isEnabled(id) {
    return this._state.get(id) === true;
  }

  /**
   * Enable a feature by ID.
   * @param {string} id
   * @returns {boolean} — true if the state actually changed
   */
  enable(id) {
    if (!FEATURES[id]) {
      this._warn(`Unknown feature: ${id}`);
      return false;
    }
    if (this._state.get(id) === true) return false;

    this._state.set(id, true);
    this._stateHash = null;
    this.dispatchEvent({ type: 'change', featureId: id, enabled: true });
    return true;
  }

  /**
   * Disable a feature by ID.
   * @param {string} id
   * @returns {boolean} — true if the state actually changed
   */
  disable(id) {
    if (!FEATURES[id]) {
      this._warn(`Unknown feature: ${id}`);
      return false;
    }
    if (this._state.get(id) === false) return false;

    this._state.set(id, false);
    this._stateHash = null;
    this.dispatchEvent({ type: 'change', featureId: id, enabled: false });
    return true;
  }

  /**
   * Toggle a feature.
   * @param {string} id
   * @returns {boolean} — the new state
   */
  toggle(id) {
    if (!FEATURES[id]) {
      this._warn(`Unknown feature: ${id}`);
      return false;
    }
    const next = !this._state.get(id);
    this._state.set(id, next);
    this._stateHash = null;
    this.dispatchEvent({ type: 'change', featureId: id, enabled: next });
    return next;
  }

  /**
   * Enable all features in a category.
   * @param {string} category
   * @returns {number} — number of features changed
   */
  enableCategory(category) {
    const ids = CATEGORIES[category];
    if (!ids) {
      this._warn(`Unknown category: ${category}`);
      return 0;
    }
    let changed = 0;
    for (const id of ids) if (this.enable(id)) changed++;
    this.dispatchEvent({ type: 'categoryChange', category, enabled: true });
    return changed;
  }

  /**
   * Disable all features in a category.
   * @param {string} category
   * @returns {number} — number of features changed
   */
  disableCategory(category) {
    const ids = CATEGORIES[category];
    if (!ids) {
      this._warn(`Unknown category: ${category}`);
      return 0;
    }
    let changed = 0;
    for (const id of ids) if (this.disable(id)) changed++;
    this.dispatchEvent({ type: 'categoryChange', category, enabled: false });
    return changed;
  }

  /**
   * Toggle all features in a category.
   * @param {string} category
   * @returns {boolean} — the new state of the category
   */
  toggleCategory(category) {
    const ids = CATEGORIES[category];
    if (!ids) {
      this._warn(`Unknown category: ${category}`);
      return false;
    }
    const anyEnabled = ids.some((id) => this._state.get(id));
    if (anyEnabled) this.disableCategory(category);
    else this.enableCategory(category);
    return !anyEnabled;
  }

  /**
   * Enable every feature.
   * @returns {number} — number of features changed
   */
  enableAll() {
    let changed = 0;
    for (const id of Object.keys(FEATURES)) if (this.enable(id)) changed++;
    return changed;
  }

  /**
   * Disable every feature.
   * @returns {number} — number of features changed
   */
  disableAll() {
    let changed = 0;
    for (const id of Object.keys(FEATURES)) if (this.disable(id)) changed++;
    return changed;
  }

  /**
   * Apply a preset profile.
   * @param {string} presetName
   * @returns {boolean} — true if the preset was applied
   */
  applyPreset(presetName) {
    const preset = PRESETS[presetName];
    if (!preset) {
      this._warn(`Unknown preset: ${presetName}`);
      return false;
    }
    for (const id of Object.keys(FEATURES)) {
      this._state.set(id, preset.includes(id));
    }
    this._stateHash = null;
    this.dispatchEvent({ type: 'presetApplied', preset: presetName });
    return true;
  }

  /**
   * Reset to the initial state.
   * @param {string} [state='default']
   */
  reset(state = 'default') {
    this._applyInitialState(state);
    this.dispatchEvent({ type: 'reset', state });
  }

  // -----------------------------------------------------------------------
  // State inspection
  // -----------------------------------------------------------------------

  /**
   * Return the list of enabled feature IDs.
   * @returns {string[]}
   */
  getEnabledFeatures() {
    const out = [];
    for (const [id, enabled] of this._state) if (enabled) out.push(id);
    return out;
  }

  /**
   * Return the list of disabled feature IDs.
   * @returns {string[]}
   */
  getDisabledFeatures() {
    const out = [];
    for (const [id, enabled] of this._state) if (!enabled) out.push(id);
    return out;
  }

  /**
   * Return a compact snapshot of the state.
   * @returns {object}
   */
  getState() {
    const out = {};
    for (const [id, enabled] of this._state) out[id] = enabled;
    return out;
  }

  /**
   * Return a stable string that changes whenever any toggle changes.
   * Useful as a cache key in renderers.
   * @returns {string}
   */
  getStateHash() {
    if (this._stateHash !== null) return this._stateHash;
    const enabled = this.getEnabledFeatures().sort();
    this._stateHash = enabled.join('|');
    return this._stateHash;
  }

  /**
   * Return the currently-active preset profile, or 'custom' if the state
   * doesn't match any preset.
   * @returns {string}
   */
  getActiveProfile() {
    for (const [name, ids] of Object.entries(PRESETS)) {
      let matches = true;
      for (const featureId of Object.keys(FEATURES)) {
        if (ids.includes(featureId) !== (this._state.get(featureId) === true)) {
          matches = false;
          break;
        }
      }
      if (matches) return name;
    }
    return 'custom';
  }

  /**
   * Return a formatted multi-line string showing the current state grouped
   * by category. Useful for HUDs and console logging.
   * @returns {string}
   */
  debugString() {
    const lines = ['=== ConditionalLinesFeatures ==='];
    for (const [catName, ids] of Object.entries(CATEGORIES)) {
      const anyOn = ids.some((id) => this._state.get(id));
      lines.push(`[${anyOn ? 'x' : ' '}] ${catName}`);
      for (const id of ids) {
        const on = this._state.get(id);
        const feat = FEATURES[id];
        lines.push(`    [${on ? 'x' : ' '}] ${id} (file ${feat.file}) — ${feat.description}`);
      }
    }
    lines.push('');
    lines.push(`Renderable: ${this.isRenderable() ? 'yes' : 'NO'}`);
    lines.push(`Profile: ${this.getActiveProfile()}`);
    lines.push(`Hash: ${this.getStateHash()}`);
    return lines.join('\n');
  }

  /**
   * Return true if at least one edge producer and one material producer are
   * enabled — meaning the pipeline can actually draw something.
   * @returns {boolean}
   */
  isRenderable() {
    return this.hasKind('edge-producer') && this.hasKind('material-producer');
  }

  /**
   * Check whether at least one feature of a given kind is enabled.
   * @param {string} kind
   * @returns {boolean}
   */
  hasKind(kind) {
    for (const [id, enabled] of this._state) {
      if (enabled && FEATURES[id].kind === kind) return true;
    }
    return false;
  }

  /**
   * Return the feature metadata for a given ID.
   * @param {string} id
   * @returns {object|null}
   */
  getFeatureInfo(id) {
    return FEATURES[id] ? { ...FEATURES[id] } : null;
  }

  // -----------------------------------------------------------------------
  // Capability factories
  // -----------------------------------------------------------------------

  /**
   * Return the best available edge geometry for a source mesh.
   *
   * Iterates over enabled 'edge-producer' features in priority order (or
   * uses `options.preferred` if provided). Returns null if no suitable
   * feature is enabled — the caller should skip rendering conditional lines
   * in that case (no crash, no throw).
   *
   * @param {BufferGeometry} source — original mesh geometry
   * @param {object} [options={}]
   * @param {string} [options.preferred] — force a specific feature ID
   * @param {number} [options.thresholdDot] — passed to 133 / 141
   * @param {object} [options.detectOptions] — passed to 134 / 137
   * @param {object} [options.gpuOptions] — passed to 137
   * @param {object} [options.windingOptions] — passed to 145
   * @returns {BufferGeometry|null}
   */
  getEdgeGeometry(source, options = {}) {
    if (!source || !source.attributes || !source.attributes.position) {
      this._warn('getEdgeGeometry: source has no position attribute');
      return null;
    }

    const candidates = options.preferred
      ? (FEATURES[options.preferred] ? [options.preferred] : [])
      : this._getEnabledByKind('edge-producer').map((f) => f.id);

    for (const id of candidates) {
      const feat = FEATURES[id];
      if (!feat || !this._state.get(id)) continue;
      try {
        const result = feat.factory(source, this, options);
        if (result) return result;
      } catch (e) {
        this._warn(`getEdgeGeometry: feature "${id}" threw: ${e.message}`);
      }
    }

    this._warn('getEdgeGeometry: no enabled edge-producer feature is available');
    return null;
  }

  /**
   * Return the best available line material.
   *
   * Iterates over enabled 'material-producer' features in priority order
   * (or uses `options.preferred`). Returns null if none is enabled.
   *
   * @param {object} [options={}]
   * @param {string} [options.preferred]
   * @param {object} [options.params] — passed to the material constructor
   * @returns {object|null}
   */
  getLineMaterial(options = {}) {
    const candidates = options.preferred
      ? (FEATURES[options.preferred] ? [options.preferred] : [])
      : this._getEnabledByKind('material-producer').map((f) => f.id);

    for (const id of candidates) {
      const feat = FEATURES[id];
      if (!feat || feat.kind !== 'material-producer') continue;
      if (!this._state.get(id)) continue;
      try {
        const params = options.params || {};
        return new feat.Module(params);
      } catch (e) {
        this._warn(`getLineMaterial: feature "${id}" threw: ${e.message}`);
      }
    }

    this._warn('getLineMaterial: no enabled material-producer feature is available');
    return null;
  }

  /**
   * Return a wrapped edge geometry with the unified edgeType attribute.
   * @param {BufferGeometry} edgesGeometry — source edge geometry
   * @param {object} [options={}]
   * @returns {EdgeTypeTaggedGeometry|null}
   */
  getEdgeTypeTaggedGeometry(edgesGeometry, options = {}) {
    if (!this._state.get('edge-type-tagged-geometry')) {
      this._warn('edge-type-tagged-geometry is disabled');
      return null;
    }
    try {
      const tagged = new EdgeTypeTaggedGeometry();
      tagged.fromSource(edgesGeometry, options);
      return tagged;
    } catch (e) {
      this._warn(`getEdgeTypeTaggedGeometry: ${e.message}`);
      return null;
    }
  }

  /**
   * Return a per-scene frustum-culled edge batch.
   * @param {object} [options={}]
   * @returns {CulledEdgesBatch|null}
   */
  getCulledBatch(options = {}) {
    if (!this._state.get('culled-edges-batch')) {
      this._warn('culled-edges-batch is disabled');
      return null;
    }
    try {
      return new CulledEdgesBatch(options);
    } catch (e) {
      this._warn(`getCulledBatch: ${e.message}`);
      return null;
    }
  }

  /**
   * Return a partial-upload buffer updater.
   * @param {object} [options={}]
   * @returns {EdgesBufferUpdater|null}
   */
  getBufferUpdater(options = {}) {
    if (!this._state.get('edges-buffer-updater')) {
      this._warn('edges-buffer-updater is disabled');
      return null;
    }
    try {
      return new EdgesBufferUpdater(options);
    } catch (e) {
      this._warn(`getBufferUpdater: ${e.message}`);
      return null;
    }
  }

  /**
   * Return the shared T-junction splitter singleton.
   * @returns {TIntersectionSplitter|null}
   */
  getTIntersectionSplitter() {
    if (!this._state.get('t-intersection-splitter')) {
      this._warn('t-intersection-splitter is disabled');
      return null;
    }
    if (!this._singletons.tIntersectionSplitter) {
      try {
        this._singletons.tIntersectionSplitter = new TIntersectionSplitter();
      } catch (e) {
        this._warn(`getTIntersectionSplitter: ${e.message}`);
        return null;
      }
    }
    return this._singletons.tIntersectionSplitter;
  }

  /**
   * Return the shared manifold edge detector singleton.
   * @returns {ManifoldEdgeDetector|null}
   */
  getManifoldDetector() {
    if (!this._state.get('manifold-edge-detector')) {
      this._warn('manifold-edge-detector is disabled');
      return null;
    }
    if (!this._singletons.manifoldDetector) {
      try {
        this._singletons.manifoldDetector = new ManifoldEdgeDetector();
      } catch (e) {
        this._warn(`getManifoldDetector: ${e.message}`);
        return null;
      }
    }
    return this._singletons.manifoldDetector;
  }

  /**
   * Return a new debug visualiser.
   * @param {object} [options={}]
   * @returns {ConditionalEdgesDebug|null}
   */
  getConditionalEdgesDebug(options = {}) {
    if (!this._state.get('conditional-edges-debug')) {
      this._warn('conditional-edges-debug is disabled');
      return null;
    }
    try {
      return new ConditionalEdgesDebug(options);
    } catch (e) {
      this._warn(`getConditionalEdgesDebug: ${e.message}`);
      return null;
    }
  }

  /**
   * Return a new conditional edges baker.
   * @param {object} [options={}]
   * @returns {ConditionalEdgesBaker|null}
   */
  getConditionalEdgesBaker(options = {}) {
    if (!this._state.get('conditional-edges-baker')) {
      this._warn('conditional-edges-baker is disabled');
      return null;
    }
    try {
      return new ConditionalEdgesBaker(options);
    } catch (e) {
      this._warn(`getConditionalEdgesBaker: ${e.message}`);
      return null;
    }
  }

  /**
   * Return a new merged conditional edges batch builder.
   * @returns {MergedConditionalEdges|null}
   */
  getMergedConditionalEdges() {
    if (!this._state.get('merged-conditional-edges')) {
      this._warn('merged-conditional-edges is disabled');
      return null;
    }
    try {
      return new MergedConditionalEdges();
    } catch (e) {
      this._warn(`getMergedConditionalEdges: ${e.message}`);
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Return all enabled features of a given kind, sorted by priority descending.
   * @private
   */
  _getEnabledByKind(kind) {
    const out = [];
    for (const id of Object.keys(FEATURES)) {
      const feat = FEATURES[id];
      if (feat.kind === kind && this._state.get(id)) out.push(feat);
    }
    out.sort((a, b) => b.priority - a.priority);
    return out;
  }

  /**
   * Emit a warning once per unique message (avoids spam in render loops).
   * @private
   */
  _warn(message) {
    if (!this._warnEnabled) return;
    if (this._warnedMessages.has(message)) return;
    this._warnedMessages.add(message);
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[ConditionalLinesFeatures] ${message}`);
    }
  }

  /**
   * Clear the warning-dedup cache. Useful when you want the next warning to
   * re-emit after a state change.
   * @private
   */
  _clearWarnCache() {
    this._warnedMessages.clear();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Dispose of any singletons and clear internal state.
   */
  dispose() {
    if (this._singletons.manifoldDetector) {
      this._singletons.manifoldDetector.release();
      this._singletons.manifoldDetector = null;
    }
    if (this._singletons.tIntersectionSplitter) {
      this._singletons.tIntersectionSplitter.release();
      this._singletons.tIntersectionSplitter = null;
    }
    this._warnedMessages.clear();
    this._state.clear();
    this._stateHash = null;
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  ConditionalLinesFeatures,
  FEATURES,
  CATEGORIES,
  PRESETS,
};

export default ConditionalLinesFeatures;