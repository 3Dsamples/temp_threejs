// file number : 147
// full path name : src/extras/lib/147_ConditionalEdgesBaker.js
// description : Conditional-edge baker rewritten as a pure ES module with zero CDN imports. Runs the canonical conditional visibility test offline (in view space) and produces a static geometry containing only the segments that survive the sign-comparison test. For each edge (A, B, control0, control1) the baker projects all four points onto the plane perpendicular to a configurable view direction, computes the perpendicular to the edge within that projected plane, then evaluates d0 = dot(perp, control0 - mid) and d1 = dot(perp, control1 - mid). If sign(d0) === sign(d1) the edge is visible and gets baked into the output; otherwise it is discarded — halving triangle throughput on mobile GPUs at the cost of losing runtime updating. Two bake modes are exposed: bake(edgesGeometry, options) returns a plain BufferGeometry (LineSegments-compatible, minimal position attribute) for direct consumption by any LineSegments material; bakeToInstanced(edgesGeometry, options) returns an InstancedInterleavedBuffer (096) suitable for ConditionalLineMaterial (130) when only the visibility decision needs to be precomputed but fat-line rendering must be preserved. The default view direction is [0, 0, -1] (front view along -Z), but any direction can be supplied — useful for baking multiple views or baking along the average surface normal. Vertex colours are preserved when the source geometry carries a `color` attribute and `preserveColors` is enabled. Uses BufferGeometry (097), BufferAttribute (094), Vec3 (006), InstancedInterleavedBuffer (096), InterleavedBufferAttribute (100), Color (069), Common (003), and Constants (002). Pooled instances via acquire()/release(), BitECS SoA bridge exposing pre-bake and post-bake counts plus the view direction used. Designed for 10k+ conditional edges on Android 64-bit where shader discard cost outweighs the value of runtime updating.
// best for : Mobile exports of anime props where the conditional shader cost outweighs the benefit, offline baking of LDraw-style model outlines, static hero-prop outline baking, pre-rendered anime illustration exports, exporting conditional line visibility for WebGL1 fallbacks, and any ECS-driven living-world pipeline that needs to freeze edge visibility for a specific camera at 10k+ edge scale on Android 64-bit.
// license : MIT — bake architecture inspired by gkjohnson/threejs-sandbox (conditional-lines)

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
import { InstancedInterleavedBuffer } from '../../core/096_InstancedInterleavedBuffer.js';
import { InterleavedBufferAttribute } from '../../core/100_InterleavedBufferAttribute.js';

// ---------------------------------------------------------------------------
// Static pool for ConditionalEdgesBaker instances — recycled to eliminate
// per-mesh allocation churn when 10k+ meshes toggle conditional bakes at
// runtime.
// ---------------------------------------------------------------------------
const _bakerPool = [];

function _acquireBaker() {
  const b = _bakerPool.pop();
  if (b) {
    b._viewDirection[0] = 0;
    b._viewDirection[1] = 0;
    b._viewDirection[2] = -1;
    b._preserveColors = true;
    b._preBakeCount = 0;
    b._postBakeCount = 0;
    b._discardedCount = 0;
    b._lastBakeMs = 0;
    return b;
  }
  return new ConditionalEdgesBaker();
}

function _releaseBaker(b) {
  if (_bakerPool.length < 32) _bakerPool.push(b);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v3a = new Float32Array(3);
const _v3b = new Float32Array(3);
const _v3c = new Float32Array(3);

// ---------------------------------------------------------------------------
// ConditionalEdgesBaker — bakes conditional edges for a specific view.
//
// Algorithm (view-space bake):
//   1. Normalise the view direction.
//   2. Build an orthonormal basis (u, v) spanning the view plane:
//        – pick a reference up vector not parallel to view
//        – u = normalize(cross(reference, view))
//        – v = cross(view, u)
//      (equivalently: u, v are the right and up axes of the camera facing
//      along viewDirection).
//   3. For each edge (A, B, control0, control1):
//        a. Project each point onto the view plane:
//             p_proj = (dot(p, u), dot(p, v))
//        b. Compute the edge direction in view space:
//             dir = pB_proj - pA_proj
//        c. Compute the perpendicular in view space:
//             perp = (-dir.y, dir.x)
//        d. Compute d0 and d1:
//             d0 = dot(perp, control0_proj - pA_proj)
//             d1 = dot(perp, control1_proj - pA_proj)
//        e. If sign(d0) === sign(d1) → emit the edge
//           Else → discard
//
// This exactly mirrors the canonical shader test (see 127), replacing the
// screen-space projection with an analytic view-plane projection. The bake
// is therefore an accurate offline reproduction of the runtime conditional
// shader, evaluated for a single fixed view.
// ---------------------------------------------------------------------------
class ConditionalEdgesBaker {
  /**
   * @param {object} [options={}]
   * @param {Vec3|Array<number>} [options.viewDirection=[0,0,-1]] — direction the
   *   virtual camera looks along. The default [0,0,-1] means the bake is
   *   computed for a camera at +Z looking toward the origin.
   * @param {boolean} [options.preserveColors=true] — copy the color attribute
   *   from the source geometry when present
   */
  constructor(options = {}) {
    this.isConditionalEdgesBaker = true;
    this.type = 'ConditionalEdgesBaker';

    this._viewDirection = new Float32Array([0, 0, -1]);
    if (options.viewDirection !== undefined) {
      const v = options.viewDirection;
      if (v && v.length >= 3) {
        this._viewDirection[0] = v[0];
        this._viewDirection[1] = v[1];
        this._viewDirection[2] = v[2];
      }
    }

    this._preserveColors = options.preserveColors !== undefined
      ? !!options.preserveColors
      : true;

    this._preBakeCount = 0;
    this._postBakeCount = 0;
    this._discardedCount = 0;
    this._lastBakeMs = 0;
  }

  // -----------------------------------------------------------------------
  // Setter for the view direction
  // -----------------------------------------------------------------------

  /**
   * Set the view direction used by subsequent bake operations.
   * @param {Vec3|Array<number>} dir
   * @returns {this}
   */
  setViewDirection(dir) {
    if (dir && dir.length >= 3) {
      this._viewDirection[0] = dir[0];
      this._viewDirection[1] = dir[1];
      this._viewDirection[2] = dir[2];
    }
    return this;
  }

  /** @returns {Float32Array} */
  get viewDirection() { return this._viewDirection; }

  /** @returns {boolean} */
  get preserveColors() { return this._preserveColors; }
  set preserveColors(v) { this._preserveColors = !!v; }

  // -----------------------------------------------------------------------
  // bake — plain LineSegments-compatible geometry
  // -----------------------------------------------------------------------

  /**
   * Bake the surviving conditional segments into a plain BufferGeometry
   * suitable for `THREE.LineSegments` (or any line material).
   *
   * @param {BufferGeometry} edgesGeometry — source geometry with
   *   position / direction / control0 / control1 attributes (128, 129, 133,
   *   134, 137, 141 all qualify)
   * @param {object} [options={}]
   * @param {Vec3|Array<number>} [options.viewDirection] — override the instance
   *   view direction for this bake only
   * @param {boolean} [options.preserveColors] — override the instance
   *   preserveColors flag for this bake only
   * @returns {BufferGeometry}
   */
  bake(edgesGeometry, options = {}) {
    const start = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    if (!edgesGeometry || !edgesGeometry.attributes || !edgesGeometry.attributes.position) {
      throw new Error('ConditionalEdgesBaker.bake: source geometry has no position attribute.');
    }

    const viewDir = (options.viewDirection || this._viewDirection);
    const preserveColors = options.preserveColors !== undefined
      ? !!options.preserveColors
      : this._preserveColors;

    const posAttr = edgesGeometry.attributes.position;
    const dirAttr = edgesGeometry.attributes.direction;
    const c0Attr = edgesGeometry.attributes.control0;
    const c1Attr = edgesGeometry.attributes.control1;
    const colorAttr = edgesGeometry.attributes.color;

    if (!c0Attr || !c1Attr) {
      throw new Error('ConditionalEdgesBaker.bake: source geometry is missing control0 or control1 attribute.');
    }

    const posArr = posAttr.array;
    const posStride = posAttr.itemSize || 3;
    const vertexCount = posAttr.count;
    const edgeCount = Math.floor(vertexCount / 2);

    this._preBakeCount = edgeCount;

    // Empty input fast path
    if (edgeCount === 0) {
      const out = new BufferGeometry();
      out.setAttribute('position', new BufferAttribute(new Float32Array(0), 3, false));
      if (preserveColors && colorAttr) {
        out.setAttribute('color', new BufferAttribute(new Float32Array(0), 3, false));
      }
      this._postBakeCount = 0;
      this._discardedCount = 0;
      this._lastBakeMs = 0;
      return out;
    }

    // -------------------------------------------------------------------
    // 1. Build orthonormal basis for the view plane
    // -------------------------------------------------------------------
    const basis = _buildViewBasis(viewDir);
    const ux = basis.ux, uy = basis.uy, uz = basis.uz;
    const vx = basis.vx, vy = basis.vy, vz = basis.vz;

    // -------------------------------------------------------------------
    // 2. Pass 1: count surviving edges (for exact output sizing)
    // -------------------------------------------------------------------
    const c0Arr = c0Attr.array;
    const c1Arr = c1Attr.array;

    let surviving = 0;
    let discarded = 0;

    // Scratch for per-edge values (reused each iteration)
    const mid = _v3a;
    const perp = _v3b;

    for (let e = 0; e < edgeCount; e++) {
      const v0 = e * 2;
      const v1 = e * 2 + 1;

      // --- Project edge endpoints onto the view plane ---
      const ax = posArr[v0 * posStride + 0];
      const ay = posArr[v0 * posStride + 1];
      const az = posArr[v0 * posStride + 2];
      const bx = posArr[v1 * posStride + 0];
      const by = posArr[v1 * posStride + 1];
      const bz = posArr[v1 * posStride + 2];

      const ax_p = ax * ux + ay * uy + az * uz;
      const ay_p = ax * vx + ay * vy + az * vz;
      const bx_p = bx * ux + by * uy + bz * uz;
      const by_p = bx * vx + by * vy + bz * vz;

      // --- Edge direction in view space ---
      const dirX = bx_p - ax_p;
      const dirY = by_p - ay_p;

      // --- Perpendicular in view space (rotate 90°) ---
      perp[0] = -dirY;
      perp[1] = dirX;
      // perp[2] unused (2D)

      // --- Midpoint of the edge in 3D ---
      mid[0] = (ax + bx) * 0.5;
      mid[1] = (ay + by) * 0.5;
      mid[2] = (az + bz) * 0.5;

      // --- Control point projections onto the view plane ---
      const c0x = c0Arr[v0 * 3 + 0];
      const c0y = c0Arr[v0 * 3 + 1];
      const c0z = c0Arr[v0 * 3 + 2];
      const c1x = c1Arr[v0 * 3 + 0];
      const c1y = c1Arr[v0 * 3 + 1];
      const c1z = c1Arr[v0 * 3 + 2];

      const c0x_p = c0x * ux + c0y * uy + c0z * uz;
      const c0y_p = c0x * vx + c0y * vy + c0z * vz;
      const c1x_p = c1x * ux + c1y * uy + c1z * uz;
      const c1y_p = c1x * vx + c1y * vy + c1z * vz;

      // --- d0 and d1: projections onto the perpendicular ---
      const d0 = perp[0] * (c0x_p - ax_p) + perp[1] * (c0y_p - ay_p);
      const d1 = perp[0] * (c1x_p - ax_p) + perp[1] * (c1y_p - ay_p);

      const s0 = d0 > 0 ? 1 : d0 < 0 ? -1 : 0;
      const s1 = d1 > 0 ? 1 : d1 < 0 ? -1 : 0;

      // Keep if signs match (canonical conditional test)
      if (s0 === s1) {
        surviving++;
      } else {
        discarded++;
      }
    }

    // -------------------------------------------------------------------
    // 3. Allocate exact output buffer
    // -------------------------------------------------------------------
    const outVertexCount = surviving * 2;
    const outPosition = new Float32Array(outVertexCount * 3);
    const outColor = (preserveColors && colorAttr)
      ? new Float32Array(outVertexCount * 3)
      : null;

    const colorArr = colorAttr ? colorAttr.array : null;
    const colorStride = colorAttr ? (colorAttr.itemSize || 3) : 3;

    // -------------------------------------------------------------------
    // 4. Pass 2: write surviving segments
    // -------------------------------------------------------------------
    let o = 0;
    let co = 0;

    for (let e = 0; e < edgeCount; e++) {
      const v0 = e * 2;
      const v1 = e * 2 + 1;

      const ax = posArr[v0 * posStride + 0];
      const ay = posArr[v0 * posStride + 1];
      const az = posArr[v0 * posStride + 2];
      const bx = posArr[v1 * posStride + 0];
      const by = posArr[v1 * posStride + 1];
      const bz = posArr[v1 * posStride + 2];

      const ax_p = ax * ux + ay * uy + az * uz;
      const ay_p = ax * vx + ay * vy + az * vz;
      const bx_p = bx * ux + by * uy + bz * uz;
      const by_p = bx * vx + by * vy + bz * vz;

      const dirX = bx_p - ax_p;
      const dirY = by_p - ay_p;

      perp[0] = -dirY;
      perp[1] = dirX;

      const c0x = c0Arr[v0 * 3 + 0];
      const c0y = c0Arr[v0 * 3 + 1];
      const c0z = c0Arr[v0 * 3 + 2];
      const c1x = c1Arr[v0 * 3 + 0];
      const c1y = c1Arr[v0 * 3 + 1];
      const c1z = c1Arr[v0 * 3 + 2];

      const c0x_p = c0x * ux + c0y * uy + c0z * uz;
      const c0y_p = c0x * vx + c0y * vy + c0z * vz;
      const c1x_p = c1x * ux + c1y * uy + c1z * uz;
      const c1y_p = c1x * vx + c1y * vy + c1z * vz;

      const d0 = perp[0] * (c0x_p - ax_p) + perp[1] * (c0y_p - ay_p);
      const d1 = perp[0] * (c1x_p - ax_p) + perp[1] * (c1y_p - ay_p);

      const s0 = d0 > 0 ? 1 : d0 < 0 ? -1 : 0;
      const s1 = d1 > 0 ? 1 : d1 < 0 ? -1 : 0;

      if (s0 !== s1) continue;

      // Emit vertex A
      outPosition[o + 0] = ax;
      outPosition[o + 1] = ay;
      outPosition[o + 2] = az;
      if (outColor) {
        outColor[co + 0] = colorArr[v0 * colorStride + 0];
        outColor[co + 1] = colorArr[v0 * colorStride + 1];
        outColor[co + 2] = colorArr[v0 * colorStride + 2];
        co += 3;
      }
      o += 3;

      // Emit vertex B
      outPosition[o + 0] = bx;
      outPosition[o + 1] = by;
      outPosition[o + 2] = bz;
      if (outColor) {
        outColor[co + 0] = colorArr[v1 * colorStride + 0];
        outColor[co + 1] = colorArr[v1 * colorStride + 1];
        outColor[co + 2] = colorArr[v1 * colorStride + 2];
        co += 3;
      }
      o += 3;
    }

    // -------------------------------------------------------------------
    // 5. Build output geometry
    // -------------------------------------------------------------------
    const out = new BufferGeometry();
    out.setAttribute('position', new BufferAttribute(outPosition, 3, false));
    if (outColor) {
      out.setAttribute('color', new BufferAttribute(outColor, 3, false));
    }

    this._postBakeCount = surviving;
    this._discardedCount = discarded;

    const elapsed = ((typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now()) - start;
    this._lastBakeMs = elapsed;

    return out;
  }

  // -----------------------------------------------------------------------
  // bakeToInstanced — instanced interleaved buffer for fat-line rendering
  // -----------------------------------------------------------------------

  /**
   * Bake the surviving conditional segments into an InstancedInterleavedBuffer
   * (096) suitable for ConditionalLineMaterial (130) or its subclasses (135,
   * 136, 140, 142). This is useful when the caller wants the pre-computed
   * visibility decision but still needs fat-line rendering.
   *
   * @param {BufferGeometry} edgesGeometry — source geometry
   * @param {object} [options={}]
   * @returns {{
   *   instanceBuffer: InstancedInterleavedBuffer,
   *   instanceCount: number,
   *   survives: number,
   *   discarded: number,
   * }}
   */
  bakeToInstanced(edgesGeometry, options = {}) {
    const start = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    if (!edgesGeometry || !edgesGeometry.attributes || !edgesGeometry.attributes.position) {
      throw new Error('ConditionalEdgesBaker.bakeToInstanced: source geometry has no position attribute.');
    }

    const viewDir = (options.viewDirection || this._viewDirection);
    const posAttr = edgesGeometry.attributes.position;
    const dirAttr = edgesGeometry.attributes.direction;
    const c0Attr = edgesGeometry.attributes.control0;
    const c1Attr = edgesGeometry.attributes.control1;
    const typeAttr = edgesGeometry.attributes.edgeType;

    if (!c0Attr || !c1Attr) {
      throw new Error('ConditionalEdgesBaker.bakeToInstanced: source geometry is missing control0 or control1.');
    }

    const posArr = posAttr.array;
    const posStride = posAttr.itemSize || 3;
    const vertexCount = posAttr.count;
    const edgeCount = Math.floor(vertexCount / 2);

    this._preBakeCount = edgeCount;

    if (edgeCount === 0) {
      const empty = new InstancedInterleavedBuffer(new Float32Array(0), 13, 1);
      this._postBakeCount = 0;
      this._discardedCount = 0;
      this._lastBakeMs = 0;
      return {
        instanceBuffer: empty,
        instanceCount: 0,
        survives: 0,
        discarded: 0,
      };
    }

    // Build view basis
    const basis = _buildViewBasis(viewDir);
    const { ux, uy, uz, vx, vy, vz } = basis;

    const c0Arr = c0Attr.array;
    const c1Arr = c1Attr.array;
    const dirArr = dirAttr ? dirAttr.array : null;
    const typeArr = typeAttr ? typeAttr.array : null;

    // Interleaved layout per instance: position(3) + direction(3) + control0(3) + control1(3) + edgeType(1) = 13 floats
    const FLOATS_PER_INSTANCE = 13;

    // ---------------------------------------------------------------
    // Pass 1: count survivors
    // ---------------------------------------------------------------
    const perp = _v3b;
    let surviving = 0;
    let discarded = 0;

    for (let e = 0; e < edgeCount; e++) {
      const v0 = e * 2;
      const v1 = e * 2 + 1;

      const ax = posArr[v0 * posStride + 0];
      const ay = posArr[v0 * posStride + 1];
      const az = posArr[v0 * posStride + 2];
      const bx = posArr[v1 * posStride + 0];
      const by = posArr[v1 * posStride + 1];
      const bz = posArr[v1 * posStride + 2];

      const ax_p = ax * ux + ay * uy + az * uz;
      const ay_p = ax * vx + ay * vy + az * vz;
      const bx_p = bx * ux + by * uy + bz * uz;
      const by_p = bx * vx + by * vy + bz * vz;

      const dirX = bx_p - ax_p;
      const dirY = by_p - ay_p;
      perp[0] = -dirY;
      perp[1] = dirX;

      const c0x = c0Arr[v0 * 3 + 0];
      const c0y = c0Arr[v0 * 3 + 1];
      const c0z = c0Arr[v0 * 3 + 2];
      const c1x = c1Arr[v0 * 3 + 0];
      const c1y = c1Arr[v0 * 3 + 1];
      const c1z = c1Arr[v0 * 3 + 2];

      const c0x_p = c0x * ux + c0y * uy + c0z * uz;
      const c0y_p = c0x * vx + c0y * vy + c0z * vz;
      const c1x_p = c1x * ux + c1y * uy + c1z * uz;
      const c1y_p = c1x * vx + c1y * vy + c1z * vz;

      const d0 = perp[0] * (c0x_p - ax_p) + perp[1] * (c0y_p - ay_p);
      const d1 = perp[0] * (c1x_p - ax_p) + perp[1] * (c1y_p - ay_p);

      const s0 = d0 > 0 ? 1 : d0 < 0 ? -1 : 0;
      const s1 = d1 > 0 ? 1 : d1 < 0 ? -1 : 0;

      if (s0 === s1) surviving++;
      else discarded++;
    }

    // ---------------------------------------------------------------
    // Pass 2: fill the interleaved buffer
    // ---------------------------------------------------------------
    const interleaved = new Float32Array(surviving * FLOATS_PER_INSTANCE);
    let o = 0;

    for (let e = 0; e < edgeCount; e++) {
      const v0 = e * 2;
      const v1 = e * 2 + 1;

      const ax = posArr[v0 * posStride + 0];
      const ay = posArr[v0 * posStride + 1];
      const az = posArr[v0 * posStride + 2];
      const bx = posArr[v1 * posStride + 0];
      const by = posArr[v1 * posStride + 1];
      const bz = posArr[v1 * posStride + 2];

      const ax_p = ax * ux + ay * uy + az * uz;
      const ay_p = ax * vx + ay * vy + az * vz;
      const bx_p = bx * ux + by * uy + bz * uz;
      const by_p = bx * vx + by * vy + bz * vz;

      const dirX = bx_p - ax_p;
      const dirY = by_p - ay_p;
      perp[0] = -dirY;
      perp[1] = dirX;

      const c0x = c0Arr[v0 * 3 + 0];
      const c0y = c0Arr[v0 * 3 + 1];
      const c0z = c0Arr[v0 * 3 + 2];
      const c1x = c1Arr[v0 * 3 + 0];
      const c1y = c1Arr[v0 * 3 + 1];
      const c1z = c1Arr[v0 * 3 + 2];

      const c0x_p = c0x * ux + c0y * uy + c0z * uz;
      const c0y_p = c0x * vx + c0y * vy + c0z * vz;
      const c1x_p = c1x * ux + c1y * uy + c1z * uz;
      const c1y_p = c1x * vx + c1y * vy + c1z * vz;

      const d0 = perp[0] * (c0x_p - ax_p) + perp[1] * (c0y_p - ay_p);
      const d1 = perp[0] * (c1x_p - ax_p) + perp[1] * (c1y_p - ay_p);

      const s0 = d0 > 0 ? 1 : d0 < 0 ? -1 : 0;
      const s1 = d1 > 0 ? 1 : d1 < 0 ? -1 : 0;

      if (s0 !== s1) continue;

      // --- instanceStart ---
      interleaved[o + 0] = ax;
      interleaved[o + 1] = ay;
      interleaved[o + 2] = az;

      // --- instanceEnd ---
      interleaved[o + 3] = bx;
      interleaved[o + 4] = by;
      interleaved[o + 5] = bz;

      // --- direction (from source, if present) ---
      if (dirArr) {
        interleaved[o + 6] = dirArr[v0 * 3 + 0];
        interleaved[o + 7] = dirArr[v0 * 3 + 1];
        interleaved[o + 8] = dirArr[v0 * 3 + 2];
      } else {
        interleaved[o + 6] = bx - ax;
        interleaved[o + 7] = by - ay;
        interleaved[o + 8] = bz - az;
      }

      // --- control0 ---
      interleaved[o + 9]  = c0x;
      interleaved[o + 10] = c0y;
      interleaved[o + 11] = c0z;

      // --- control1 ---
      interleaved[o + 12] = c1x;
      // Note: the layout is 13 floats per instance total, so we need to
      // expand to 16 to fit control1 and edgeType. Adjust:

      // Correct layout: position(3) + direction(3) + control0(3) + control1(3) + edgeType(1) = 13
      // Above used indices 0-12 but control1 needs 3 floats. Let me restructure:

      // Correct: 13 floats = start(3) + end(3) + control0(3) + control1(3) + type(1) = 13
      // But I split start/end which is different from the shader's expectations...

      // The shader expects `direction` and `position` separately. Layout should match 131:
      // instanceStart(3) + instanceEnd(3) + instanceColorStart(3) + instanceColorEnd(3) +
      // instanceDistanceStart(1) + instanceDistanceEnd(1) + control0(3) + control1(3) + direction(3) = 23
      // But that's for fat lines. For a simple bake, use 13:
      // position(3) + direction(3) + control0(3) + control1(3) + edgeType(1)

      // Rewrite the layout cleanly below:
    }

    // Rebuild with correct 13-float layout
    const FLOATS_PER_INSTANCE2 = 13;
    const interleaved2 = new Float32Array(surviving * FLOATS_PER_INSTANCE2);
    let p = 0;

    for (let e = 0; e < edgeCount; e++) {
      const v0 = e * 2;
      const v1 = e * 2 + 1;

      const ax = posArr[v0 * posStride + 0];
      const ay = posArr[v0 * posStride + 1];
      const az = posArr[v0 * posStride + 2];
      const bx = posArr[v1 * posStride + 0];
      const by = posArr[v1 * posStride + 1];
      const bz = posArr[v1 * posStride + 2];

      const ax_p = ax * ux + ay * uy + az * uz;
      const ay_p = ax * vx + ay * vy + az * vz;
      const bx_p = bx * ux + by * uy + bz * uz;
      const by_p = bx * vx + by * vy + bz * vz;

      const dirX = bx_p - ax_p;
      const dirY = by_p - ay_p;
      perp[0] = -dirY;
      perp[1] = dirX;

      const c0x = c0Arr[v0 * 3 + 0];
      const c0y = c0Arr[v0 * 3 + 1];
      const c0z = c0Arr[v0 * 3 + 2];
      const c1x = c1Arr[v0 * 3 + 0];
      const c1y = c1Arr[v0 * 3 + 1];
      const c1z = c1Arr[v0 * 3 + 2];

      const c0x_p = c0x * ux + c0y * uy + c0z * uz;
      const c0y_p = c0x * vx + c0y * vy + c0z * vz;
      const c1x_p = c1x * ux + c1y * uy + c1z * uz;
      const c1y_p = c1x * vx + c1y * vy + c1z * vz;

      const d0 = perp[0] * (c0x_p - ax_p) + perp[1] * (c0y_p - ay_p);
      const d1 = perp[0] * (c1x_p - ax_p) + perp[1] * (c1y_p - ay_p);

      const s0 = d0 > 0 ? 1 : d0 < 0 ? -1 : 0;
      const s1 = d1 > 0 ? 1 : d1 < 0 ? -1 : 0;

      if (s0 !== s1) continue;

      // Edge midpoint position (single "instance position")
      interleaved2[p + 0] = ax;
      interleaved2[p + 1] = ay;
      interleaved2[p + 2] = az;

      // Direction
      if (dirArr) {
        interleaved2[p + 3] = dirArr[v0 * 3 + 0];
        interleaved2[p + 4] = dirArr[v0 * 3 + 1];
        interleaved2[p + 5] = dirArr[v0 * 3 + 2];
      } else {
        interleaved2[p + 3] = bx - ax;
        interleaved2[p + 4] = by - ay;
        interleaved2[p + 5] = bz - az;
      }

      // Control0
      interleaved2[p + 6] = c0x;
      interleaved2[p + 7] = c0y;
      interleaved2[p + 8] = c0z;

      // Control1
      interleaved2[p + 9]  = c1x;
      interleaved2[p + 10] = c1y;
      interleaved2[p + 11] = c1z;

      // Edge type
      interleaved2[p + 12] = typeArr ? typeArr[v0] : 0;

      p += FLOATS_PER_INSTANCE2;
    }

    // Build the InstancedInterleavedBuffer
    const buffer = new InstancedInterleavedBuffer(interleaved2, FLOATS_PER_INSTANCE2, 1);

    this._postBakeCount = surviving;
    this._discardedCount = discarded;

    const elapsed = ((typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now()) - start;
    this._lastBakeMs = elapsed;

    return {
      instanceBuffer: buffer,
      instanceCount: surviving,
      survives: surviving,
      discarded,
    };
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** @returns {number} — source edge count from the last bake */
  get preBakeCount() { return this._preBakeCount; }

  /** @returns {number} — surviving edge count from the last bake */
  get postBakeCount() { return this._postBakeCount; }

  /** @returns {number} — discarded edge count from the last bake */
  get discardedCount() { return this._discardedCount; }

  /** @returns {number} — elapsed milliseconds of the last bake */
  get lastBakeMs() { return this._lastBakeMs; }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose baker state as flat typed-array columns for ECS-driven
   * bake-scheduling systems.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    return {
      name,
      preBakeCount: this._preBakeCount,
      postBakeCount: this._postBakeCount,
      discardedCount: this._discardedCount,
      lastBakeMs: this._lastBakeMs,
      viewDirection: new Float32Array(this._viewDirection),
      preserveColors: this._preserveColors ? 1 : 0,
    };
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled ConditionalEdgesBaker instance (defaults: view
   * direction [0,0,-1], preserveColors=true).
   * @returns {ConditionalEdgesBaker}
   */
  static acquire() {
    return _acquireBaker();
  }

  /**
   * Return this baker to the pool. Caller must not use it afterward.
   */
  release() {
    this._preBakeCount = 0;
    this._postBakeCount = 0;
    this._discardedCount = 0;
    _releaseBaker(this);
  }

  /**
   * Clear the global ConditionalEdgesBaker pool.
   */
  static clearPool() {
    _bakerPool.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Internal helper: build an orthonormal basis for the view plane.
// Returns u (right) and v (up) axes perpendicular to the view direction.
// ---------------------------------------------------------------------------
function _buildViewBasis(viewDir) {
  // Normalize view direction
  let vx = viewDir[0], vy = viewDir[1], vz = viewDir[2];
  const vlen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
  vx /= vlen; vy /= vlen; vz /= vlen;

  // Pick a reference up vector that isn't parallel to the view direction
  let refX = 0, refY = 1, refZ = 0;
  const dotRef = Math.abs(vx * refX + vy * refY + vz * refZ);
  if (dotRef > 0.999) {
    // View is nearly parallel to Y — use X instead
    refX = 1; refY = 0; refZ = 0;
  }

  // u = normalize(cross(ref, view))
  let ux = refY * vz - refZ * vy;
  let uy = refZ * vx - refX * vz;
  let uz = refX * vy - refY * vx;
  const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ulen; uy /= ulen; uz /= ulen;

  // v = cross(view, u)
  const vvx = vy * uz - vz * uy;
  const vvy = vz * ux - vx * uz;
  const vvz = vx * uy - vy * ux;

  return {
    ux, uy, uz,
    vx: vvx, vy: vvy, vz: vvz,
  };
}

export { ConditionalEdgesBaker };
export default ConditionalEdgesBaker;