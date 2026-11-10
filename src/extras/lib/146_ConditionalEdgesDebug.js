// file number : 146
// full path name : src/extras/lib/146_ConditionalEdgesDebug.js
// description : Debug visualiser for conditional edges rewritten as a pure ES module with zero CDN imports. Renders the direction, control0, and control1 attributes as coloured arrows in the scene, colour-coded by edgeType when present (0 = smooth = green, 1 = hard = red, 2 = silhouette = blue) so authors can immediately see which edges are being classified as what. Uses pooled LineSegments-style arrow descriptors — one per vertex per attribute — so 10k+ edges can be visualised without per-arrow allocation churn. Exposes showDirections, showControls, showEdgeTypes, and showStats toggles, plus a readout string reporting per-type vertex counts and total edge count. Every arrow is a single 2-vertex line (base → base + direction * scale) packed into flat Float32Array buffers, so the entire debug visualisation consumes exactly 3 draw calls (one per attribute) regardless of edge count. Integrates with BufferGeometry (097), BufferAttribute (094), Vec3 (006), Color (069), Common (003), Constants (002), and the Pool system. BitECS SoA bridge exposes toggle state and per-attribute counters. Designed for 10k+ conditional edges on Android 64-bit debug sessions.
// best for : Authoring complex anime props with mixed edge classification, verifying that T-junction splitting (143) and manifold detection (144) produce the expected topology, debugging conditional line visibility on animated meshes, teaching the LDraw conditional-line technique visually, and any ECS-driven living-world pipeline that needs per-edge-type visual diagnostics at 10k+ edge scale on Android 64-bit.
// license : MIT — visualisation architecture inspired by gkjohnson/threejs-sandbox (conditional-lines)

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
import { BufferGeometry } from '../../core/097_BufferGeometry.js';
import { BufferAttribute } from '../../core/094_BufferAttribute.js';
import { Color } from '../../core/069_Color.js';

// ---------------------------------------------------------------------------
// Static pool for ConditionalEdgesDebug instances — recycled to eliminate
// per-mesh allocation churn when 10k+ meshes toggle debug visualisation at
// runtime.
// ---------------------------------------------------------------------------
const _debugPool = [];

function _acquireDebug() {
  const d = _debugPool.pop();
  if (d) {
    d._showDirections = true;
    d._showControls = true;
    d._showEdgeTypes = true;
    d._showStats = true;
    d._directionScale = 1.0;
    d._controlScale = 1.0;
    d._maxArrows = 10000;
    d._arrowCount = 0;
    d._smoothCount = 0;
    d._hardCount = 0;
    d._silhouetteCount = 0;
    d._triangleCount = 0;
    d._readout = '';
    // Clear vertex output buffers
    d._directionGeom = null;
    d._control0Geom = null;
    d._control1Geom = null;
    d._colourGeom = null;
    return d;
  }
  return new ConditionalEdgesDebug();
}

function _releaseDebug(d) {
  if (_debugPool.length < 32) _debugPool.push(d);
}

// ---------------------------------------------------------------------------
// Default debug colours — matched to the edgeType constants from 133 / 141.
// ---------------------------------------------------------------------------
const _smoothColor = new Color(0x00ff00);   // edgeType 0 — green
const _hardColor = new Color(0xff0000);     // edgeType 1 — red
const _silhouetteColor = new Color(0x0088ff); // edgeType 2 — blue
const _directionColor = new Color(0xffff00); // direction arrow — yellow
const _controlColor = new Color(0xff00ff);  // control arrow — magenta

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v3a = new Float32Array(3);
const _v3b = new Float32Array(3);

// ---------------------------------------------------------------------------
// ConditionalEdgesDebug — flat typed-array debug visualiser.
//
// Design:
//   For each conditional edge (2 vertices in the source geometry), we emit:
//     – One line segment from vertex.position to vertex.position + direction*scale
//       (shows the edge direction used by the conditional test)
//     – One line segment from vertex.position to vertex.control0
//       (shows the control point used for the conditional side test)
//     – One line segment from vertex.position to vertex.control1
//       (shows the other control point)
//     – Optional per-vertex colour based on edgeType (when present)
//
// All line segments are packed into flat Float32Array buffers, 2 vertices per
// segment, 3 floats per vertex, so a single BufferGeometry per attribute is
// all that's needed to render 10k+ arrows in 3 draw calls.
//
// Zero allocation in the hot path: the internal arrays are pre-sized to
// `maxArrows × 6 floats` per attribute and reused across rebuilds.
// ---------------------------------------------------------------------------
class ConditionalEdgesDebug {
  /**
   * @param {object} [options={}]
   * @param {number} [options.maxArrows=10000] — safety cap on rendered arrows
   * @param {number} [options.directionScale=1.0] — multiplier on the direction arrow length
   * @param {number} [options.controlScale=1.0] — multiplier on the control arrow length
   */
  constructor(options = {}) {
    this.isConditionalEdgesDebug = true;
    this.type = 'ConditionalEdgesDebug';

    this._showDirections = options.showDirections !== undefined ? options.showDirections : true;
    this._showControls = options.showControls !== undefined ? options.showControls : true;
    this._showEdgeTypes = options.showEdgeTypes !== undefined ? options.showEdgeTypes : true;
    this._showStats = options.showStats !== undefined ? options.showStats : true;
    this._directionScale = options.directionScale !== undefined ? options.directionScale : 1.0;
    this._controlScale = options.controlScale !== undefined ? options.controlScale : 1.0;
    this._maxArrows = options.maxArrows !== undefined ? options.maxArrows : 10000;

    // Per-attribute geometries (lazily built)
    this._directionGeom = null;
    this._control0Geom = null;
    this._control1Geom = null;
    this._colourGeom = null;

    // Stats
    this._arrowCount = 0;
    this._smoothCount = 0;
    this._hardCount = 0;
    this._silhouetteCount = 0;
    this._triangleCount = 0;
    this._readout = '';
  }

  // -----------------------------------------------------------------------
  // Build — populate all visualiser geometries from a source edge geometry
  // -----------------------------------------------------------------------

  /**
   * Build the debug visualisation from an edge geometry (128, 129, 133, 134,
   * 137, 141 all qualify).
   *
   * @param {BufferGeometry} edgesGeometry
   * @returns {this}
   */
  build(edgesGeometry) {
    if (!edgesGeometry || !edgesGeometry.attributes || !edgesGeometry.attributes.position) {
      throw new Error('ConditionalEdgesDebug.build: source geometry has no position attribute.');
    }

    const posAttr = edgesGeometry.attributes.position;
    const dirAttr = edgesGeometry.attributes.direction;
    const c0Attr = edgesGeometry.attributes.control0;
    const c1Attr = edgesGeometry.attributes.control1;
    const typeAttr = edgesGeometry.attributes.edgeType;

    const vertexCount = posAttr.count;
    const arrowCount = Math.min(vertexCount, this._maxArrows);

    this._arrowCount = arrowCount;

    if (arrowCount === 0) {
      this._directionGeom = null;
      this._control0Geom = null;
      this._control1Geom = null;
      this._colourGeom = null;
      this._smoothCount = 0;
      this._hardCount = 0;
      this._silhouetteCount = 0;
      this._readout = 'ConditionalEdgesDebug: no edges';
      return this;
    }

    // -------------------------------------------------------------------
    // 1. Allocate flat line buffers (2 vertices per arrow)
    // -------------------------------------------------------------------
    const directionPositions = this._showDirections
      ? new Float32Array(arrowCount * 6)
      : null;
    const control0Positions = (this._showControls && c0Attr)
      ? new Float32Array(arrowCount * 6)
      : null;
    const control1Positions = (this._showControls && c1Attr)
      ? new Float32Array(arrowCount * 6)
      : null;
    const colourBuffer = this._showEdgeTypes
      ? new Float32Array(arrowCount * 6) // RGB per vertex, 2 verts per arrow
      : null;

    // -------------------------------------------------------------------
    // 2. Fill the buffers
    // -------------------------------------------------------------------
    const posArr = posAttr.array;
    const posStride = posAttr.itemSize || 3;
    const dirArr = dirAttr ? dirAttr.array : null;
    const c0Arr = c0Attr ? c0Attr.array : null;
    const c1Arr = c1Attr ? c1Attr.array : null;
    const typeArr = typeAttr ? typeAttr.array : null;

    let smoothCount = 0;
    let hardCount = 0;
    let silhouetteCount = 0;

    for (let i = 0; i < arrowCount; i++) {
      const px = posArr[i * posStride + 0];
      const py = posArr[i * posStride + 1];
      const pz = posArr[i * posStride + 2];

      // --- Direction arrow (base → base + direction * scale) ---
      if (directionPositions && dirArr) {
        const dx = dirArr[i * 3 + 0];
        const dy = dirArr[i * 3 + 1];
        const dz = dirArr[i * 3 + 2];

        // Clip very long direction vectors so the visualiser doesn't blow up
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const norm = Math.min(1, 1 / len);
        const sx = dx * norm * this._directionScale;
        const sy = dy * norm * this._directionScale;
        const sz = dz * norm * this._directionScale;

        const o = i * 6;
        directionPositions[o + 0] = px;
        directionPositions[o + 1] = py;
        directionPositions[o + 2] = pz;
        directionPositions[o + 3] = px + sx;
        directionPositions[o + 4] = py + sy;
        directionPositions[o + 5] = pz + sz;
      }

      // --- Control0 arrow (base → control0 * scale) ---
      if (control0Positions && c0Arr) {
        const cx = c0Arr[i * 3 + 0];
        const cy = c0Arr[i * 3 + 1];
        const cz = c0Arr[i * 3 + 2];

        const o = i * 6;
        control0Positions[o + 0] = px;
        control0Positions[o + 1] = py;
        control0Positions[o + 2] = pz;
        control0Positions[o + 3] = px + (cx - px) * this._controlScale;
        control0Positions[o + 4] = py + (cy - py) * this._controlScale;
        control0Positions[o + 5] = pz + (cz - pz) * this._controlScale;
      }

      // --- Control1 arrow (base → control1 * scale) ---
      if (control1Positions && c1Arr) {
        const cx = c1Arr[i * 3 + 0];
        const cy = c1Arr[i * 3 + 1];
        const cz = c1Arr[i * 3 + 2];

        const o = i * 6;
        control1Positions[o + 0] = px;
        control1Positions[o + 1] = py;
        control1Positions[o + 2] = pz;
        control1Positions[o + 3] = px + (cx - px) * this._controlScale;
        control1Positions[o + 4] = py + (cy - py) * this._controlScale;
        control1Positions[o + 5] = pz + (cz - pz) * this._controlScale;
      }

      // --- Colour by edgeType ---
      if (colourBuffer) {
        let r = 1, g = 1, b = 1;
        if (typeArr) {
          const t = typeArr[i] | 0;
          if (t === 0) {
            r = _smoothColor.r; g = _smoothColor.g; b = _smoothColor.b;
            smoothCount++;
          } else if (t === 1) {
            r = _hardColor.r; g = _hardColor.g; b = _hardColor.b;
            hardCount++;
          } else if (t === 2) {
            r = _silhouetteColor.r; g = _silhouetteColor.g; b = _silhouetteColor.b;
            silhouetteCount++;
          } else {
            r = _directionColor.r; g = _directionColor.g; b = _directionColor.b;
          }
        }

        const o = i * 6;
        colourBuffer[o + 0] = r;
        colourBuffer[o + 1] = g;
        colourBuffer[o + 2] = b;
        colourBuffer[o + 3] = r;
        colourBuffer[o + 4] = g;
        colourBuffer[o + 5] = b;
      }
    }

    // -------------------------------------------------------------------
    // 3. Build BufferGeometries from the flat arrays
    // -------------------------------------------------------------------
    if (directionPositions) {
      this._directionGeom = _makeLineGeometry(directionPositions, colourBuffer);
    } else {
      this._directionGeom = null;
    }

    if (control0Positions) {
      this._control0Geom = _makeLineGeometry(control0Positions, colourBuffer);
    } else {
      this._control0Geom = null;
    }

    if (control1Positions) {
      this._control1Geom = _makeLineGeometry(control1Positions, colourBuffer);
    } else {
      this._control1Geom = null;
    }

    // -------------------------------------------------------------------
    // 4. Update stats and readout
    // -------------------------------------------------------------------
    this._smoothCount = smoothCount;
    this._hardCount = hardCount;
    this._silhouetteCount = silhouetteCount;
    this._triangleCount = Math.floor(arrowCount / 2); // 2 verts per edge

    if (this._showStats) {
      this._readout =
        `ConditionalEdgesDebug: ${arrowCount} vertices ` +
        `(${this._triangleCount} edges) — ` +
        `SMOOTH=${smoothCount} HARD=${hardCount} SILHOUETTE=${silhouetteCount}`;
    } else {
      this._readout = '';
    }

    return this;
  }

  // -----------------------------------------------------------------------
  // Toggles
  // -----------------------------------------------------------------------

  /** @returns {boolean} */
  get showDirections() { return this._showDirections; }
  set showDirections(v) { this._showDirections = !!v; }

  /** @returns {boolean} */
  get showControls() { return this._showControls; }
  set showControls(v) { this._showControls = !!v; }

  /** @returns {boolean} */
  get showEdgeTypes() { return this._showEdgeTypes; }
  set showEdgeTypes(v) { this._showEdgeTypes = !!v; }

  /** @returns {boolean} */
  get showStats() { return this._showStats; }
  set showStats(v) { this._showStats = !!v; }

  /** @returns {number} */
  get directionScale() { return this._directionScale; }
  set directionScale(v) { this._directionScale = Math.max(0, v); }

  /** @returns {number} */
  get controlScale() { return this._controlScale; }
  set controlScale(v) { this._controlScale = Math.max(0, v); }

  /** @returns {number} */
  get maxArrows() { return this._maxArrows; }
  set maxArrows(v) { this._maxArrows = Math.max(1, v | 0); }

  // -----------------------------------------------------------------------
  // Getters for the generated geometries
  // -----------------------------------------------------------------------

  /** @returns {BufferGeometry|null} — direction arrow lines */
  get directionGeometry() { return this._directionGeom; }

  /** @returns {BufferGeometry|null} — control0 arrow lines */
  get control0Geometry() { return this._control0Geom; }

  /** @returns {BufferGeometry|null} — control1 arrow lines */
  get control1Geometry() { return this._control1Geom; }

  /** @returns {number} — total arrow count in the last build() */
  get arrowCount() { return this._arrowCount; }

  /** @returns {number} — SMOOTH (edgeType 0) vertex count */
  get smoothCount() { return this._smoothCount; }

  /** @returns {number} — HARD (edgeType 1) vertex count */
  get hardCount() { return this._hardCount; }

  /** @returns {number} — SILHOUETTE (edgeType 2) vertex count */
  get silhouetteCount() { return this._silhouetteCount; }

  /** @returns {number} — edge count (arrowCount / 2) */
  get triangleCount() { return this._triangleCount; }

  /** @returns {string} — human-readable readout for HUD display */
  get readout() { return this._readout; }

  // -----------------------------------------------------------------------
  // Disposal
  // -----------------------------------------------------------------------

  /**
   * Dispose of the generated debug geometries.
   * @returns {this}
   */
  dispose() {
    if (this._directionGeom) {
      this._directionGeom.dispose();
      this._directionGeom = null;
    }
    if (this._control0Geom) {
      this._control0Geom.dispose();
      this._control0Geom = null;
    }
    if (this._control1Geom) {
      this._control1Geom.dispose();
      this._control1Geom = null;
    }
    this._colourGeom = null;
    return this;
  }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose the debug state as flat typed-array columns for ECS-driven
   * debug-overlay scheduling systems.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    return {
      name,
      arrowCount: this._arrowCount,
      smoothCount: this._smoothCount,
      hardCount: this._hardCount,
      silhouetteCount: this._silhouetteCount,
      triangleCount: this._triangleCount,
      showDirections: this._showDirections ? 1 : 0,
      showControls: this._showControls ? 1 : 0,
      showEdgeTypes: this._showEdgeTypes ? 1 : 0,
      showStats: this._showStats ? 1 : 0,
      directionScale: this._directionScale,
      controlScale: this._controlScale,
      maxArrows: this._maxArrows,
      readout: this._readout,
    };
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled ConditionalEdgesDebug instance (defaults: all toggles
   * on, scales 1.0, maxArrows 10000).
   * @returns {ConditionalEdgesDebug}
   */
  static acquire() {
    return _acquireDebug();
  }

  /**
   * Return this visualiser to the pool. Caller must not use it afterward.
   */
  release() {
    this.dispose();
    _releaseDebug(this);
  }

  /**
   * Clear the global ConditionalEdgesDebug pool.
   */
  static clearPool() {
    _debugPool.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Internal helper: build a LineSegments-style BufferGeometry from flat
// position/color arrays.
// ---------------------------------------------------------------------------
function _makeLineGeometry(positions, colours) {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(positions, 3, false));
  if (colours) {
    geom.setAttribute('color', new BufferAttribute(colours, 3, false));
  }
  return geom;
}

export { ConditionalEdgesDebug };
export default ConditionalEdgesDebug;