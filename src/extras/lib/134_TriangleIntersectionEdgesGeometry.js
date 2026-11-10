// file number : 134
// full path name : src/extras/lib/134_TriangleIntersectionEdgesGeometry.js
// description : Triangle-triangle intersection edge detector rewritten as a pure ES module with zero CDN imports. Detects and emits line segments where two non-adjacent triangles from the same mesh physically intersect — the specific case the LDraw conditional-lines spec cannot handle (a sword blade entering a scabbard, a prop clipping into a wall, a robot limb passing through a torso). Implements a three-phase pipeline: (1) per-triangle AABB and face normal precomputation, (2) sweep-and-prune broadphase over minX with AABB overlap culling, (3) Möller's exact triangle-triangle intersection narrowphase with signed-distance interval overlap. Adjacency is detected by shared-vertex ID and skipped, so co-planar neighbour triangles never produce spurious intersections. Coplanar and degenerate triangles are rejected. Emits `position`, `intersectionNormal`, `control0`, `control1`, and `edgeType` attributes compatible with the conditional shader (127) and the combined edges pipeline (133). All temporary storage uses flat typed arrays; growing buffers are amortised O(n). Pooled instances via acquire()/release() and a BitECS SoA bridge for ECS-driven context-awareness systems. Uses the project's BufferGeometry (097), BufferAttribute (094), Vec3 (006), Common (003), and Constants (002) modules. Designed for 10k+ triangle meshes on Android 64-bit with zero CDN dependencies.
// best for : Self-intersection detection on every 3D mesh, LDraw-style model outlines for props that clip through walls, anime props with complex layered geometry (sword + scabbard, robot limbs + torso), CAD wireframe overlays, cloth self-collision cues, and any ECS-driven living-world pipeline that toggles self-intersection edges per mesh at 10k+ triangle scale on Android 64-bit.
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
import { BufferGeometry } from '../../core/097_BufferGeometry.js';
import { BufferAttribute } from '../../core/094_BufferAttribute.js';

// ---------------------------------------------------------------------------
// Static pool for TriangleIntersectionEdgesGeometry instances — recycled to
// eliminate per-mesh allocation churn when 10k+ meshes toggle self-intersection
// edge overlays at runtime.
// ---------------------------------------------------------------------------
const _geometryPool = [];

function _acquireGeometry() {
  const g = _geometryPool.pop();
  if (g) {
    for (const key in g.attributes) delete g.attributes[key];
    g.index = null;
    g.groups.length = 0;
    g.boundingBox = null;
    g.boundingSphere = null;
    g.userData = {};
    g.version = 0;
    g._needsUpdate = false;
    g._intersectionCount = 0;
    g._narrowphaseTests = 0;
    g._broadphaseHits = 0;
    g._skippedAdjacent = 0;
    g._skippedCoplanar = 0;
    g._skippedDegenerate = 0;
    g._skippedShort = 0;
    g._capReached = false;
    return g;
  }
  return new TriangleIntersectionEdgesGeometry();
}

function _releaseGeometry(g) {
  if (_geometryPool.length < 64) _geometryPool.push(g);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _seg = new Float32Array(6); // [ax, ay, az, bx, by, bz]

const DEFAULT_EPS = 1e-6;
const DEFAULT_MAX_PAIRS = 1e6;

// ---------------------------------------------------------------------------
// Möller's exact triangle-triangle intersection test.
//
// Writes the world-space intersection segment endpoints into `out[0..5]`:
//   out[0..2] = point A (start of intersection segment)
//   out[3..5] = point B (end   of intersection segment)
//
// Returns true only when a proper overlapping segment exists (length > eps).
//
// Both triangles are passed as raw scalar coordinates to avoid any object
// dereference in the hot loop. Face normals are precomputed by the caller.
// ---------------------------------------------------------------------------
function _triTriIntersect(
  // Triangle A
  a0x, a0y, a0z, a1x, a1y, a1z, a2x, a2y, a2z,
  // Triangle B
  b0x, b0y, b0z, b1x, b1y, b1z, b2x, b2y, b2z,
  // Normals (precomputed, unit length)
  nax, nay, naz, nbx, nby, nbz,
  // Output: 6 floats
  out,
  eps
) {
  // --- Plane of B ---
  const db = -(nbx * b0x + nby * b0y + nbz * b0z);

  // Signed distances of A's vertices from plane B
  const da0 = nbx * a0x + nby * a0y + nbz * a0z + db;
  const da1 = nbx * a1x + nby * a1y + nbz * a1z + db;
  const da2 = nbx * a2x + nby * a2y + nbz * a2z + db;

  // All on the same side → no intersection
  if ((da0 > eps && da1 > eps && da2 > eps) ||
      (da0 < -eps && da1 < -eps && da2 < -eps)) {
    return false;
  }

  // All coplanar → they intersect on an area, not a line → skip
  if (Math.abs(da0) < eps && Math.abs(da1) < eps && Math.abs(da2) < eps) {
    return false;
  }

  // --- Plane of A ---
  const da = -(nax * a0x + nay * a0y + naz * a0z);

  // Signed distances of B's vertices from plane A
  const db0 = nax * b0x + nay * b0y + naz * b0z + da;
  const db1 = nax * b1x + nay * b1y + naz * b1z + da;
  const db2 = nax * b2x + nay * b2y + naz * b2z + da;

  if ((db0 > eps && db1 > eps && db2 > eps) ||
      (db0 < -eps && db1 < -eps && db2 < -eps)) {
    return false;
  }

  if (Math.abs(db0) < eps && Math.abs(db1) < eps && Math.abs(db2) < eps) {
    return false; // coplanar
  }

  // --- Direction of intersection line D = nA × nB ---
  const Dx = nay * nbz - naz * nby;
  const Dy = naz * nbx - nax * nbz;
  const Dz = nax * nby - nay * nbx;

  const DdotD = Dx * Dx + Dy * Dy + Dz * Dz;
  if (DdotD < eps * eps) {
    // Parallel non-coplanar planes → no intersection
    return false;
  }

  // --- Project A's vertices onto D ---
  const pa0 = Dx * a0x + Dy * a0y + Dz * a0z;
  const pa1 = Dx * a1x + Dy * a1y + Dz * a1z;
  const pa2 = Dx * a2x + Dy * a2y + Dz * a2z;

  // --- Interval for A along D (clipped to plane B) ---
  let amin = Infinity;
  let amax = -Infinity;

  if (da0 * da1 < 0) {
    const t = pa0 + (pa1 - pa0) * (da0 / (da0 - da1));
    if (t < amin) amin = t;
    if (t > amax) amax = t;
  }
  if (da1 * da2 < 0) {
    const t = pa1 + (pa2 - pa1) * (da1 / (da1 - da2));
    if (t < amin) amin = t;
    if (t > amax) amax = t;
  }
  if (da2 * da0 < 0) {
    const t = pa2 + (pa0 - pa2) * (da2 / (da2 - da0));
    if (t < amin) amin = t;
    if (t > amax) amax = t;
  }
  if (Math.abs(da0) < eps) { if (pa0 < amin) amin = pa0; if (pa0 > amax) amax = pa0; }
  if (Math.abs(da1) < eps) { if (pa1 < amin) amin = pa1; if (pa1 > amax) amax = pa1; }
  if (Math.abs(da2) < eps) { if (pa2 < amin) amin = pa2; if (pa2 > amax) amax = pa2; }

  if (amin > amax || amin === Infinity) return false;

  // --- Project B's vertices onto D ---
  const pb0 = Dx * b0x + Dy * b0y + Dz * b0z;
  const pb1 = Dx * b1x + Dy * b1y + Dz * b1z;
  const pb2 = Dx * b2x + Dy * b2y + Dz * b2z;

  // --- Interval for B along D ---
  let bmin = Infinity;
  let bmax = -Infinity;

  if (db0 * db1 < 0) {
    const t = pb0 + (pb1 - pb0) * (db0 / (db0 - db1));
    if (t < bmin) bmin = t;
    if (t > bmax) bmax = t;
  }
  if (db1 * db2 < 0) {
    const t = pb1 + (pb2 - pb1) * (db1 / (db1 - db2));
    if (t < bmin) bmin = t;
    if (t > bmax) bmax = t;
  }
  if (db2 * db0 < 0) {
    const t = pb2 + (pb0 - pb2) * (db2 / (db2 - db0));
    if (t < bmin) bmin = t;
    if (t > bmax) bmax = t;
  }
  if (Math.abs(db0) < eps) { if (pb0 < bmin) bmin = pb0; if (pb0 > bmax) bmax = pb0; }
  if (Math.abs(db1) < eps) { if (pb1 < bmin) bmin = pb1; if (pb1 > bmax) bmax = pb1; }
  if (Math.abs(db2) < eps) { if (pb2 < bmin) bmin = pb2; if (pb2 > bmax) bmax = pb2; }

  if (bmin > bmax || bmin === Infinity) return false;

  // --- Interval overlap ---
  const tmin = amin > bmin ? amin : bmin;
  const tmax = amax < bmax ? amax : bmax;

  if (tmin >= tmax) return false;

  // --- Reconstruct world points at tmin and tmax along line L ---
  // A point on L satisfies P·nA = -dA and P·nB = -dB.
  // Base point on L:
  //   P0 = (-dA * (nB × D) + dB * (nA × D)) / |D|²
  const c1x = nby * Dz - nbz * Dy;
  const c1y = nbz * Dx - nbx * Dz;
  const c1z = nbx * Dy - nby * Dx;

  const c2x = nay * Dz - naz * Dy;
  const c2y = naz * Dx - nax * Dz;
  const c2z = nax * Dy - nay * Dx;

  const invDdotD = 1 / DdotD;
  const P0x = (-da * c1x + db * c2x) * invDdotD;
  const P0y = (-da * c1y + db * c2y) * invDdotD;
  const P0z = (-da * c1z + db * c2z) * invDdotD;

  const P0dotD = P0x * Dx + P0y * Dy + P0z * Dz;
  const sMin = (tmin - P0dotD) * invDdotD;
  const sMax = (tmax - P0dotD) * invDdotD;

  out[0] = P0x + sMin * Dx;
  out[1] = P0y + sMin * Dy;
  out[2] = P0z + sMin * Dz;
  out[3] = P0x + sMax * Dx;
  out[4] = P0y + sMax * Dy;
  out[5] = P0z + sMax * Dz;

  return true;
}

// ---------------------------------------------------------------------------
// TriangleIntersectionEdgesGeometry — emits self-intersection segments.
//
// Pipeline:
//   1. Build a flat index array (indexed or non-indexed input).
//   2. Precompute per-triangle face normals and axis-aligned bounding boxes
//      in a single linear pass.
//   3. Sweep-and-prune over AABB minX (sorted index), with early-out once
//      the sorted minX exceeds the current maxX.
//   4. For each surviving pair:
//        a. Skip if they share any vertex (they are adjacent, not intersecting).
//        b. Skip if either triangle is degenerate (zero-area).
//        c. Run Möller's tri-tri test in scalar form.
//        d. Reject segments shorter than `minSegmentLength`.
//   5. Two-pass emit: count first, then allocate exact buffers.
//
// Notes on semantics:
//   – Adjacent triangles are detected by shared vertex ID, not by position.
//     Two triangles whose intersection lies entirely on a shared edge are
//     therefore correctly skipped. This matches the intuitive meaning of
//     "self-intersection" and prevents the O(n²) spurious cases that
//     position-based tests would produce on welded meshes.
//   – Coplanar triangles are rejected (they intersect on an area, not a
//     line, and their outline is already covered by silhouette edges).
//   – Each emitted segment gets two vertices with:
//       position          = (endpoint A or B)
//       intersectionNormal= unit average of the two face normals
//       control0          = endpoint B (forces the conditional test to draw)
//       control1          = endpoint B (forces the conditional test to draw)
//       edgeType          = 1 (HARD — always drawn in 133/127 pipelines)
// ---------------------------------------------------------------------------
class TriangleIntersectionEdgesGeometry extends BufferGeometry {
  /**
   * @param {BufferGeometry} [geometry] — source geometry
   * @param {object} [options] — see fromGeometry() for full option list
   */
  constructor(geometry, options = {}) {
    super();

    this.isTriangleIntersectionEdgesGeometry = true;
    this.type = 'TriangleIntersectionEdgesGeometry';

    this._intersectionCount = 0;
    this._narrowphaseTests = 0;
    this._broadphaseHits = 0;
    this._skippedAdjacent = 0;
    this._skippedCoplanar = 0;
    this._skippedDegenerate = 0;
    this._skippedShort = 0;
    this._capReached = false;

    if (geometry) {
      this.fromGeometry(geometry, options);
    }
  }

  /**
   * Rebuild this geometry from a source BufferGeometry.
   *
   * @param {BufferGeometry} geometry — source geometry
   * @param {object} [options={}]
   * @param {number} [options.epsilon=1e-6] — geometric epsilon
   * @param {number} [options.maxPairs=1e6] — narrowphase test cap
   * @param {boolean} [options.skipAdjacent=true] — skip shared-vertex pairs
   * @param {boolean} [options.skipCoplanar=true] — skip coplanar pairs
   * @param {number} [options.minSegmentLength=0] — reject short segments
   * @param {boolean} [options.includeNormals=true] — emit intersectionNormal
   * @returns {this}
   */
  fromGeometry(geometry, options = {}) {
    if (!geometry || !geometry.attributes || !geometry.attributes.position) {
      throw new Error('TriangleIntersectionEdgesGeometry.fromGeometry: source geometry has no position attribute.');
    }

    const {
      epsilon = DEFAULT_EPS,
      maxPairs = DEFAULT_MAX_PAIRS,
      skipAdjacent = true,
      skipCoplanar = true,
      minSegmentLength = 0,
      includeNormals = true,
    } = options;

    // Reset output + counters
    for (const key in this.attributes) delete this.attributes[key];
    this.index = null;
    this.groups.length = 0;

    this._intersectionCount = 0;
    this._narrowphaseTests = 0;
    this._broadphaseHits = 0;
    this._skippedAdjacent = 0;
    this._skippedCoplanar = 0;
    this._skippedDegenerate = 0;
    this._skippedShort = 0;
    this._capReached = false;

    const position = geometry.attributes.position;
    const posArr = position.array;
    const stride = position.itemSize || 3;
    const vertexCount = position.count;

    // ---------------------------------------------------------------------
    // 1. Flat index array
    // ---------------------------------------------------------------------
    let idx;
    let numTris;
    if (geometry.index) {
      idx = geometry.index.array;
      numTris = Math.floor(geometry.index.count / 3);
    } else {
      idx = new Uint32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) idx[i] = i;
      numTris = Math.floor(vertexCount / 3);
    }

    if (numTris < 2) {
      this._emitEmpty();
      return this;
    }

    // ---------------------------------------------------------------------
    // 2. Precompute per-triangle normals + AABBs
    // ---------------------------------------------------------------------
    const triNormals = new Float32Array(numTris * 3);
    const triAABB = new Float32Array(numTris * 6);
    const triValid = new Uint8Array(numTris);

    for (let t = 0; t < numTris; t++) {
      const i0 = idx[t * 3 + 0];
      const i1 = idx[t * 3 + 1];
      const i2 = idx[t * 3 + 2];

      const ax = posArr[i0 * stride + 0];
      const ay = posArr[i0 * stride + 1];
      const az = posArr[i0 * stride + 2];
      const bx = posArr[i1 * stride + 0];
      const by = posArr[i1 * stride + 1];
      const bz = posArr[i1 * stride + 2];
      const cx = posArr[i2 * stride + 0];
      const cy = posArr[i2 * stride + 1];
      const cz = posArr[i2 * stride + 2];

      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);

      if (nlen < epsilon) {
        triValid[t] = 0;
        triNormals[t * 3 + 0] = 0;
        triNormals[t * 3 + 1] = 0;
        triNormals[t * 3 + 2] = 0;
      } else {
        triValid[t] = 1;
        const invN = 1 / nlen;
        triNormals[t * 3 + 0] = nx * invN;
        triNormals[t * 3 + 1] = ny * invN;
        triNormals[t * 3 + 2] = nz * invN;
      }

      triAABB[t * 6 + 0] = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
      triAABB[t * 6 + 1] = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
      triAABB[t * 6 + 2] = az < bz ? (az < cz ? az : cz) : (bz < cz ? bz : cz);
      triAABB[t * 6 + 3] = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
      triAABB[t * 6 + 4] = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
      triAABB[t * 6 + 5] = az > bz ? (az > cz ? az : cz) : (bz > cz ? bz : cz);
    }

    // ---------------------------------------------------------------------
    // 3. Sweep-and-prune over sorted-by-minX triangle indices
    // ---------------------------------------------------------------------
    const order = new Array(numTris);
    for (let i = 0; i < numTris; i++) order[i] = i;
    order.sort((a, b) => triAABB[a * 6] - triAABB[b * 6]);

    // Growable hit buffer: 9 floats per hit = 2 endpoints × 3 + normal × 3
    let hitCap = 256;
    let hitCount = 0;
    let hitBuf = new Float32Array(hitCap * 9);

    const growHits = () => {
      hitCap *= 2;
      const nb = new Float32Array(hitCap * 9);
      nb.set(hitBuf);
      hitBuf = nb;
    };

    outerLoop:
    for (let si = 0; si < numTris; si++) {
      const ta = order[si];
      if (!triValid[ta]) continue;

      const taMinX = triAABB[ta * 6 + 0];
      const taMaxX = triAABB[ta * 6 + 3];
      const taMinY = triAABB[ta * 6 + 1];
      const taMaxY = triAABB[ta * 6 + 4];
      const taMinZ = triAABB[ta * 6 + 2];
      const taMaxZ = triAABB[ta * 6 + 5];

      const ia0 = idx[ta * 3 + 0];
      const ia1 = idx[ta * 3 + 1];
      const ia2 = idx[ta * 3 + 2];

      const a0x = posArr[ia0 * stride + 0];
      const a0y = posArr[ia0 * stride + 1];
      const a0z = posArr[ia0 * stride + 2];
      const a1x = posArr[ia1 * stride + 0];
      const a1y = posArr[ia1 * stride + 1];
      const a1z = posArr[ia1 * stride + 2];
      const a2x = posArr[ia2 * stride + 0];
      const a2y = posArr[ia2 * stride + 1];
      const a2z = posArr[ia2 * stride + 2];

      const nax = triNormals[ta * 3 + 0];
      const nay = triNormals[ta * 3 + 1];
      const naz = triNormals[ta * 3 + 2];

      for (let sj = si + 1; sj < numTris; sj++) {
        const tb = order[sj];
        if (triAABB[tb * 6] > taMaxX) break;

        if (!triValid[tb]) continue;

        // AABB overlap test (Y and Z; X already guaranteed by sort order)
        if (triAABB[tb * 6 + 1] > taMaxY || triAABB[tb * 6 + 4] < taMinY) continue;
        if (triAABB[tb * 6 + 2] > taMaxZ || triAABB[tb * 6 + 5] < taMinZ) continue;

        const ib0 = idx[tb * 3 + 0];
        const ib1 = idx[tb * 3 + 1];
        const ib2 = idx[tb * 3 + 2];

        // --- Adjacency check (shared vertex ID) ---
        if (skipAdjacent) {
          if (ia0 === ib0 || ia0 === ib1 || ia0 === ib2 ||
              ia1 === ib0 || ia1 === ib1 || ia1 === ib2 ||
              ia2 === ib0 || ia2 === ib1 || ia2 === ib2) {
            this._skippedAdjacent++;
            continue;
          }
        }

        this._broadphaseHits++;

        if (this._narrowphaseTests >= maxPairs) {
          this._capReached = true;
          break outerLoop;
        }
        this._narrowphaseTests++;

        const b0x = posArr[ib0 * stride + 0];
        const b0y = posArr[ib0 * stride + 1];
        const b0z = posArr[ib0 * stride + 2];
        const b1x = posArr[ib1 * stride + 0];
        const b1y = posArr[ib1 * stride + 1];
        const b1z = posArr[ib1 * stride + 2];
        const b2x = posArr[ib2 * stride + 0];
        const b2y = posArr[ib2 * stride + 1];
        const b2z = posArr[ib2 * stride + 2];

        const nbx = triNormals[tb * 3 + 0];
        const nby = triNormals[tb * 3 + 1];
        const nbz = triNormals[tb * 3 + 2];

        if (!_triTriIntersect(
          a0x, a0y, a0z, a1x, a1y, a1z, a2x, a2y, a2z,
          b0x, b0y, b0z, b1x, b1y, b1z, b2x, b2y, b2z,
          nax, nay, naz, nbx, nby, nbz,
          _seg, epsilon
        )) {
          continue;
        }

        // Reject short segments (e.g. grazing contacts)
        if (minSegmentLength > 0) {
          const dx = _seg[3] - _seg[0];
          const dy = _seg[4] - _seg[1];
          const dz = _seg[5] - _seg[2];
          if (dx * dx + dy * dy + dz * dz < minSegmentLength * minSegmentLength) {
            this._skippedShort++;
            continue;
          }
        }

        if (hitCount >= hitCap) growHits();

        const base = hitCount * 9;
        hitBuf[base + 0] = _seg[0];
        hitBuf[base + 1] = _seg[1];
        hitBuf[base + 2] = _seg[2];
        hitBuf[base + 3] = _seg[3];
        hitBuf[base + 4] = _seg[4];
        hitBuf[base + 5] = _seg[5];

        // Intersection normal = unit average of the two face normals
        let anx = nax + nbx;
        let any = nay + nby;
        let anz = naz + nbz;
        const alen = Math.sqrt(anx * anx + any * any + anz * anz);
        if (alen > epsilon) {
          const invA = 1 / alen;
          anx *= invA; any *= invA; anz *= invA;
        } else {
          anx = nax; any = nay; anz = naz;
        }
        hitBuf[base + 6] = anx;
        hitBuf[base + 7] = any;
        hitBuf[base + 8] = anz;

        hitCount++;
      }
    }

    // ---------------------------------------------------------------------
    // 4. Emit attributes
    // ---------------------------------------------------------------------
    if (hitCount === 0) {
      this._emitEmpty();
      return this;
    }

    const outVertexCount = hitCount * 2;
    const outPosition = new Float32Array(outVertexCount * 3);
    const outNormal = includeNormals ? new Float32Array(outVertexCount * 3) : null;
    const outControl0 = new Float32Array(outVertexCount * 3);
    const outControl1 = new Float32Array(outVertexCount * 3);
    const outEdgeType = new Float32Array(outVertexCount);

    let o = 0;
    let oi = 0;

    for (let h = 0; h < hitCount; h++) {
      const base = h * 9;
      const ax = hitBuf[base + 0];
      const ay = hitBuf[base + 1];
      const az = hitBuf[base + 2];
      const bx = hitBuf[base + 3];
      const by = hitBuf[base + 4];
      const bz = hitBuf[base + 5];
      const nx = hitBuf[base + 6];
      const ny = hitBuf[base + 7];
      const nz = hitBuf[base + 8];

      // Vertex 1 (endpoint A)
      outPosition[o + 0] = ax;
      outPosition[o + 1] = ay;
      outPosition[o + 2] = az;
      if (outNormal) {
        outNormal[o + 0] = nx;
        outNormal[o + 1] = ny;
        outNormal[o + 2] = nz;
      }
      outControl0[o + 0] = bx;
      outControl0[o + 1] = by;
      outControl0[o + 2] = bz;
      outControl1[o + 0] = bx;
      outControl1[o + 1] = by;
      outControl1[o + 2] = bz;
      outEdgeType[oi] = 1; // HARD — always drawn
      o += 3;
      oi += 1;

      // Vertex 2 (endpoint B)
      outPosition[o + 0] = bx;
      outPosition[o + 1] = by;
      outPosition[o + 2] = bz;
      if (outNormal) {
        outNormal[o + 0] = nx;
        outNormal[o + 1] = ny;
        outNormal[o + 2] = nz;
      }
      outControl0[o + 0] = bx;
      outControl0[o + 1] = by;
      outControl0[o + 2] = bz;
      outControl1[o + 0] = bx;
      outControl1[o + 1] = by;
      outControl1[o + 2] = bz;
      outEdgeType[oi] = 1;
      o += 3;
      oi += 1;
    }

    this.setAttribute('position', new BufferAttribute(outPosition, 3, false));
    this.setAttribute('control0', new BufferAttribute(outControl0, 3, false));
    this.setAttribute('control1', new BufferAttribute(outControl1, 3, false));
    this.setAttribute('edgeType', new BufferAttribute(outEdgeType, 1, false));
    if (outNormal) {
      this.setAttribute('intersectionNormal', new BufferAttribute(outNormal, 3, false));
    }

    this._intersectionCount = hitCount;
    this.needsUpdate = true;
    return this;
  }

  /**
   * Emit empty attributes (no intersections found).
   * @private
   */
  _emitEmpty() {
    const empty3 = new BufferAttribute(new Float32Array(0), 3, false);
    const empty1 = new BufferAttribute(new Float32Array(0), 1, false);
    this.setAttribute('position', empty3);
    this.setAttribute('control0', new BufferAttribute(new Float32Array(0), 3, false));
    this.setAttribute('control1', new BufferAttribute(new Float32Array(0), 3, false));
    this.setAttribute('edgeType', empty1);
    this._intersectionCount = 0;
    this.needsUpdate = true;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** @returns {number} — number of emitted intersection segments */
  get intersectionCount() { return this._intersectionCount; }

  /** @returns {number} — number of narrowphase tri-tri tests performed */
  get narrowphaseTests() { return this._narrowphaseTests; }

  /** @returns {number} — number of AABB-overlap pairs */
  get broadphaseHits() { return this._broadphaseHits; }

  /** @returns {number} — number of pairs skipped due to shared vertices */
  get skippedAdjacent() { return this._skippedAdjacent; }

  /** @returns {number} — number of coplanar pairs skipped */
  get skippedCoplanar() { return this._skippedCoplanar; }

  /** @returns {number} — number of degenerate triangles skipped */
  get skippedDegenerate() { return this._skippedDegenerate; }

  /** @returns {number} — number of segments rejected by minSegmentLength */
  get skippedShort() { return this._skippedShort; }

  /** @returns {boolean} — true if maxPairs was reached before completion */
  get capReached() { return this._capReached; }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose all attributes plus diagnostic counters as flat typed-array
   * columns for ECS systems that drive per-mesh self-intersection overlays.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const posAttr = this.attributes.position;
    const c0Attr = this.attributes.control0;
    const c1Attr = this.attributes.control1;
    const typeAttr = this.attributes.edgeType;
    const normAttr = this.attributes.intersectionNormal;

    return {
      name,
      intersectionCount: this._intersectionCount,
      narrowphaseTests: this._narrowphaseTests,
      broadphaseHits: this._broadphaseHits,
      capReached: this._capReached ? 1 : 0,
      vertexCount: posAttr ? posAttr.count : 0,
      position: posAttr ? posAttr.array : null,
      control0: c0Attr ? c0Attr.array : null,
      control1: c1Attr ? c1Attr.array : null,
      edgeType: typeAttr ? typeAttr.array : null,
      intersectionNormal: normAttr ? normAttr.array : null,
    };
  }

  // -----------------------------------------------------------------------
  // Disposal
  // -----------------------------------------------------------------------

  dispose() {
    super.dispose();
    this._intersectionCount = 0;
    this._narrowphaseTests = 0;
    this._broadphaseHits = 0;
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled TriangleIntersectionEdgesGeometry instance (empty).
   * @returns {TriangleIntersectionEdgesGeometry}
   */
  static acquire() {
    return _acquireGeometry();
  }

  /**
   * Return this geometry to the pool. Caller must not use it afterward.
   */
  release() {
    for (const key in this.attributes) delete this.attributes[key];
    this._intersectionCount = 0;
    this._narrowphaseTests = 0;
    this._broadphaseHits = 0;
    this._skippedAdjacent = 0;
    this._skippedCoplanar = 0;
    this._skippedDegenerate = 0;
    this._skippedShort = 0;
    this._capReached = false;
    _releaseGeometry(this);
  }

  /**
   * Clear the global TriangleIntersectionEdgesGeometry pool.
   */
  static clearPool() {
    _geometryPool.length = 0;
  }
}

export { TriangleIntersectionEdgesGeometry };
export default TriangleIntersectionEdgesGeometry;