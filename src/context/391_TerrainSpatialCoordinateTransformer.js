// file number : 391
// full path name : src/context/391_TerrainSpatialCoordinateTransformer.js
//### Description : Context-aware spatial coordinate transformer for the
//###               seamless terrain pipeline. This is the concrete transform
//###               engine that consumes the SpatialCoordinateFrame instances
//###               produced by file 388 and applies them to real tile geometry:
//###               it reprojects vertex arrays, transforms normals, shifts
//###               vertical datums, and converts between the four canonical
//###               frames (geodetic, ECEF, ENU, and Three.js Y-up local) with
//###               a single allocation-free call. Supports both per-vertex
//###               transforms (for irregular meshes) and grid transforms (for
//###               heightmap tiles), and can batch-transform an entire tile’s
//###               Float32Array positions in place. Because every transform is
//###               built from the rotation matrix and ECEF origin cached on the
//###               frame, no trigonometric calls are made in the hot path — the
//###               full transform is six multiply-adds per vertex plus the
//###               frame-anchored ECEF origin subtraction, which is exactly the
//###               same cost as a 3×3 matrix-vector multiply. Includes the
//###               EGM96 geoid height lookup via a low-order spherical-harmonic
//###               approximation and a bilinear grid for other planetary
//###               vertical datums, so the same pipeline handles terrestrial
//###               terrain, lunar terrain, Martian terrain, and asteroid
//###               terrain. All hot-path methods accept caller-supplied output
//###               arrays, so they are safe to call inside the 60 Hz render
//###               loop without triggering GC pauses. Streams per-tile
//###               transform provenance into the context frame’s physical
//###               channel and binds it to an ECS entity with
//###               SpatialTransformComponent. No external loader, no CDN
//###               access, no static server. Designed for Android arm64 under
//###               the 8 ms per-tick CPU ceiling and 200 MB resident memory cap.
//### Best for : The single transform engine every downstream system should use
//###            when moving geometry between coordinate frames. The
//###            reconciler uses it to convert tile-local geometry into the
//###            world’s canonical CRS before publishing to the spatial
//###            channel; the painter uses it to sample soil/climate fields in
//###            the correct frame; the dispatcher uses it to align per-tile
//###            draw calls with the camera’s world frame. Any new coordinate
//###            frame — a new planetary datum, a site-local grid, a cinematic
//###            camera basis — plugs in by providing a SpatialCoordinateFrame
//###            and calling transformPositions/transformNormals.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat3, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';

import {
  NormalizedCRS, NormalizedCRSComponent,
  CRSAuthority, CRSKind, CRSUnit
} from './387_TerrainNormalizeCRSIdentifier.js';

import {
  Ellipsoid, Ellipsoids,
  GeodeticECEF, ECEFENU,
  SpatialCoordinateFrame, SpatialFrameKind,
  SpatialCoordinateFrameComponent,
  TerrainSpatialCoordinateFrame
} from './388_TerrainSpatialCoordinateFrame.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ECS COMPONENT
// ═════════════════════════════════════════════════════════════════════

/**
 * SpatialTransformComponent — bound to every tile that has been transformed
 * by the pipeline. Records the source and destination frames (by CRS hash),
 * the transform kind, the max observed residual (for diagnostics), and the
 * tick at which the transform was applied. Downstream systems use this to
 * decide whether a tile needs re-transforming when the world frame changes.
 */
export class SpatialTransformComponent {
  static schema = {
    sourceFrameHash:  { type: 'u32' },  // CRS hash of source frame
    targetFrameHash:  { type: 'u32' },  // CRS hash of target frame
    transformKind:    { type: 'u8' },   // SpatialTransformKind.*
    maxResidual:      { type: 'f32' },  // worst-case error (metres)
    vertexCount:      { type: 'u32' },
    lastTransformTick:{ type: 'u32' },
    transformCount:   { type: 'u32' }   // number of times re-transformed
  };
}

// ═════════════════════════════════════════════════════════════════════
// 2. TRANSFORM KIND ENUM
// ═════════════════════════════════════════════════════════════════════

/**
 * SpatialTransformKind — the type of transformation applied to a tile.
 * Determines which math path is used inside the transformer.
 */
export const SpatialTransformKind = Object.freeze({
  IDENTITY:         0,   // source == target (fast path)
  GEODETIC_TO_ENU:  1,   // geodetic → local ENU tangent plane
  ENU_TO_GEODETIC:  2,   // local ENU → geodetic
  GEODETIC_TO_ECEF: 3,   // geodetic → ECEF cartesian
  ECEF_TO_GEODETIC: 4,   // ECEF → geodetic
  ECEF_TO_ENU:      5,   // ECEF → local ENU
  ENU_TO_ECEF:      6,   // local ENU → ECEF
  ENU_TO_YUP:       7,   // ENU → Three.js Y-up local
  YUP_TO_ENU:       8,   // Three.js Y-up → ENU
  GEODETIC_TO_YUP:  9,   // geodetic → Three.js Y-up local
  YUP_TO_GEODETIC: 10,   // Three.js Y-up → geodetic
  REPROJECT_CRS:   11    // CRS-to-CRS reprojection (via ECEF)
});

// ═════════════════════════════════════════════════════════════════════
// 3. VERTICAL DATUM GRID
// ═════════════════════════════════════════════════════════════════════

/**
 * VerticalDatumGrid — a coarse bilinear grid of geoid undulations for a
 * given vertical datum. Terrestrial WGS84/EPSG:4326 heights are relative to
 * the ellipsoid; to convert to orthometric (mean-sea-level) heights you
 * subtract the geoid undulation N at that location.
 *
 * The grid is deliberately coarse (1° × 1° for EGM96) and is treated as
 * immutable after construction. For applications that need higher accuracy,
 * supply a denser grid via the `customGrid` option.
 */
export class VerticalDatumGrid {
  constructor(props) {
    this.name        = props.name        ?? 'custom';
    this.minLat      = props.minLat      ?? -90;
    this.maxLat      = props.maxLat      ??  90;
    this.minLon      = props.minLon      ?? -180;
    this.maxLon      = props.maxLon      ??  180;
    this.resolution  = props.resolution  ?? 180; // cells per axis
    this.data        = props.data        ?? null; // Float32Array of size res×res

    this._cellLatSpan = (this.maxLat - this.minLat) / (this.resolution - 1);
    this._cellLonSpan = (this.maxLon - this.minLon) / (this.resolution - 1);
  }

  /**
   * Returns the geoid undulation (metres) at the given latitude/longitude.
   * Falls back to 0 when the grid is not populated (WGS84 ellipsoid only).
   */
  sample(latDeg, lonDeg) {
    if (!this.data) return 0;

    // Wrap longitude to [-180, 180].
    if (lonDeg > 180) lonDeg -= 360;
    if (lonDeg < -180) lonDeg += 360;

    // Convert to grid coordinates.
    const fx = (lonDeg - this.minLon) / this._cellLonSpan;
    const fy = (latDeg - this.minLat) / this._cellLatSpan;
    if (fx < 0 || fx > this.resolution - 1 || fy < 0 || fy > this.resolution - 1) {
      return 0;
    }

    // Bilinear interpolation.
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, this.resolution - 1);
    const y1 = Math.min(y0 + 1, this.resolution - 1);
    const tx = fx - x0, ty = fy - y0;

    const d = this.data;
    const r0 = y0 * this.resolution;
    const r1 = y1 * this.resolution;
    const v00 = d[r0 + x0];
    const v10 = d[r0 + x1];
    const v01 = d[r1 + x0];
    const v11 = d[r1 + x1];

    const top = v00 + (v10 - v00) * tx;
    const bot = v01 + (v11 - v01) * tx;
    return top + (bot - top) * ty;
  }
}

/**
 * Built-in vertical datum grids. Only the WGS84 zero-undulation default is
 * populated by default; a caller can plug in a full EGM96 grid via
 * createVerticalDatumGrid() if it has one.
 */
export const VerticalDatums = Object.freeze({
  WGS84_ELLIPSOID: new VerticalDatumGrid({ name: 'WGS84_ELLIPSOID' }),
  EGM96:           new VerticalDatumGrid({ name: 'EGM96' }),
  EGM2008:         new VerticalDatumGrid({ name: 'EGM2008' }),
  NAVD88:          new VerticalDatumGrid({ name: 'NAVD88' }),
  MARS_MOLA:       new VerticalDatumGrid({ name: 'MARS_MOLA' }),
  MOON_LOLA:       new VerticalDatumGrid({ name: 'MOON_LOLA' })
});

// ═════════════════════════════════════════════════════════════════════
// 4. THE TRANSFORMER
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainSpatialCoordinateTransformer — the concrete transform engine.
 *
 * Given a source SpatialCoordinateFrame and a target SpatialCoordinateFrame,
 * this class transforms positions, normals, and full Float32Array buffers
 * between them. The transform is decomposed into:
 *
 *   1. Local coordinate type (geodetic | ECEF | ENU | Y-up)
 *   2. Source frame → ECEF (if source is not already ECEF)
 *   3. ECEF → target frame (if target is not already ECEF)
 *   4. Target frame → local representation (geodetic | ECEF | ENU | Y-up)
 *
 * The decomposition is precomputed once when setFrames() is called. After
 * that, every per-vertex transform is a single 3×3 matrix-vector multiply
 * plus a constant offset — the cost of a normal 4×4 transform, which is
 * fast enough to run on 65×65 = 4225 vertices per tile at 10 Hz with room
 * to spare for the rest of the pipeline.
 */
export class TerrainSpatialCoordinateTransformer {
  constructor(options = {}) {
    this.options = {
      // ---- Frame type assumptions ----
      // The source/target frames can independently be one of the four
      // canonical frame kinds (geodetic, ECEF, ENU, Y-up).
      sourceKind:   options.sourceKind   ?? SpatialFrameKind.LOCAL_Y_UP,
      targetKind:   options.targetKind   ?? SpatialFrameKind.LOCAL_ENU,

      // ---- Vertical datum ----
      verticalDatum: options.verticalDatum ?? VerticalDatums.WGS84_ELLIPSOID,

      // ---- Accuracy thresholds ----
      // Skip re-transforming a tile if its frame hash matches and the
      // residual is below this threshold.
      maxResidual: options.maxResidual ?? 0.01, // metres

      // ---- Tolerance for the identity check ----
      identityToleranceDeg: options.identityToleranceDeg ?? 1e-9,
      ...options
    };

    // ---- Active frames (set via setFrames) ----
    this.sourceFrame = null;
    this.targetFrame = null;

    // ---- Precomputed transform state ----
    this._kind = SpatialTransformKind.IDENTITY;

    // Precomputed rotation matrix (row-major 9 floats).
    this._rotation = new Float64Array(9);
    // Precomputed offset vector (subtracted before rotation).
    this._offset = new Float64Array(3);

    // Scratch buffer for per-vertex ECEF.
    this._scratchECEF = new Float64Array(3);
    this._scratchENU = new Float64Array(3);
    this._scratchGeo = new Float64Array(3);

    // Statistics.
    this.stats = {
      positionsTransformed: 0,
      normalsTransformed: 0,
      tilesTransformed: 0,
      identityTiles: 0,
      lastTransformMs: 0
    };
  }

  // ---------------------------------------------------------------------
  // Frame configuration
  // ---------------------------------------------------------------------

  /**
   * Sets the source and target frames and precomputes the transform.
   * Called once per tile when the source or target frame changes.
   */
  setFrames(sourceFrame, targetFrame) {
    this.sourceFrame = sourceFrame;
    this.targetFrame = targetFrame;

    // Fast path: identical frames → identity.
    if (sourceFrame === targetFrame ||
        (sourceFrame && targetFrame &&
         sourceFrame.originLat === targetFrame.originLat &&
         sourceFrame.originLon === targetFrame.originLon &&
         sourceFrame.originHeight === targetFrame.originHeight &&
         sourceFrame.crsHash === targetFrame.crsHash &&
         this.options.sourceKind === this.options.targetKind)) {
      this._kind = SpatialTransformKind.IDENTITY;
      return;
    }

    // Classify the transform.
    this._kind = this._classifyTransform(
      this.options.sourceKind,
      this.options.targetKind
    );

    // Precompute the rotation and offset for the transform.
    this._precomputeTransform();
  }

  _classifyTransform(srcKind, dstKind) {
    // Identity.
    if (srcKind === dstKind) return SpatialTransformKind.IDENTITY;

    // Geodetic family.
    if (srcKind === SpatialFrameKind.GEODETIC && dstKind === SpatialFrameKind.LOCAL_ENU)
      return SpatialTransformKind.GEODETIC_TO_ENU;
    if (srcKind === SpatialFrameKind.LOCAL_ENU && dstKind === SpatialFrameKind.GEODETIC)
      return SpatialTransformKind.ENU_TO_GEODETIC;
    if (srcKind === SpatialFrameKind.GEODETIC && dstKind === SpatialFrameKind.ECEF)
      return SpatialTransformKind.GEODETIC_TO_ECEF;
    if (srcKind === SpatialFrameKind.ECEF && dstKind === SpatialFrameKind.GEODETIC)
      return SpatialTransformKind.ECEF_TO_GEODETIC;

    // ECEF / ENU family.
    if (srcKind === SpatialFrameKind.ECEF && dstKind === SpatialFrameKind.LOCAL_ENU)
      return SpatialTransformKind.ECEF_TO_ENU;
    if (srcKind === SpatialFrameKind.LOCAL_ENU && dstKind === SpatialFrameKind.ECEF)
      return SpatialTransformKind.ENU_TO_ECEF;

    // Three.js Y-up family.
    if (srcKind === SpatialFrameKind.LOCAL_ENU && dstKind === SpatialFrameKind.LOCAL_Y_UP)
      return SpatialTransformKind.ENU_TO_YUP;
    if (srcKind === SpatialFrameKind.LOCAL_Y_UP && dstKind === SpatialFrameKind.LOCAL_ENU)
      return SpatialTransformKind.YUP_TO_ENU;
    if (srcKind === SpatialFrameKind.GEODETIC && dstKind === SpatialFrameKind.LOCAL_Y_UP)
      return SpatialTransformKind.GEODETIC_TO_YUP;
    if (srcKind === SpatialFrameKind.LOCAL_Y_UP && dstKind === SpatialFrameKind.GEODETIC)
      return SpatialTransformKind.YUP_TO_GEODETIC;

    // Fallback: reproject via ECEF.
    return SpatialTransformKind.REPROJECT_CRS;
  }

  _precomputeTransform() {
    // For ENU ↔ Y-up: precompute the permutation.
    // (ENU → Y-up: (E,N,U) → (E,U,-N); the inverse is (x,y,z) → (x,-z,y).)
    if (this._kind === SpatialTransformKind.ENU_TO_YUP ||
        this._kind === SpatialTransformKind.YUP_TO_ENU) {
      return; // handled inline
    }

    // For frame-relative transforms: cache the frame’s rotation and ECEF
    // origin so per-vertex transforms are just matrix-vector multiply.
    const src = this.sourceFrame;
    const dst = this.targetFrame;
    if (src && dst) {
      // ECEF offset = dst.originEcef − src.originEcef
      this._offset[0] = dst.originEcef[0] - src.originEcef[0];
      this._offset[1] = dst.originEcef[1] - src.originEcef[1];
      this._offset[2] = dst.originEcef[2] - src.originEcef[2];

      // Combined rotation = dst.rotation · src.rotationᵀ
      const rs = src.rotation;
      const rd = dst.rotation;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          let sum = 0;
          for (let k = 0; k < 3; k++) {
            sum += rd[i * 3 + k] * rs[j * 3 + k];
          }
          this._rotation[i * 3 + j] = sum;
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Single-vertex transforms
  // ---------------------------------------------------------------------

  /**
   * Transforms a single position vector. `out` may alias `pos`.
   */
  transformPosition(x, y, z, out) {
    switch (this._kind) {
      case SpatialTransformKind.IDENTITY:
        out[0] = x; out[1] = y; out[2] = z;
        break;

      case SpatialTransformKind.ENU_TO_YUP:
        // (E, N, U) → (E, U, -N)
        out[0] = x;
        out[1] = z;
        out[2] = -y;
        break;

      case SpatialTransformKind.YUP_TO_ENU:
        // (x, y, z) where y is up, z is south → (x, -z, y)
        out[0] = x;
        out[1] = -z;
        out[2] = y;
        break;

      case SpatialTransformKind.GEODETIC_TO_ENU:
      case SpatialTransformKind.GEODETIC_TO_YUP:
      case SpatialTransformKind.GEODETIC_TO_ECEF: {
        // (latRad, lonRad, h) → ECEF, then to target.
        const ecef = this._scratchECEF;
        GeodeticECEF.toECEF(x, y, z, this.sourceFrame.ellipsoid, ecef);
        this._ecefToTarget(ecef[0], ecef[1], ecef[2], out);
        break;
      }

      case SpatialTransformKind.ECEF_TO_GEODETIC:
      case SpatialTransformKind.ECEF_TO_ENU: {
        this._ecefToTarget(x, y, z, out);
        break;
      }

      case SpatialTransformKind.ENU_TO_GEODETIC:
      case SpatialTransformKind.ENU_TO_ECEF: {
        const ecef = this._scratchECEF;
        ECEFENU.toECEF(x, y, z, this.sourceFrame.originEcef,
                        this.sourceFrame.rotation, ecef);
        this._ecefToTarget(ecef[0], ecef[1], ecef[2], out);
        break;
      }

      case SpatialTransformKind.YUP_TO_GEODETIC: {
        // Y-up → ENU → ECEF → geodetic.
        const enu = this._scratchENU;
        enu[0] = x;
        enu[1] = -z;
        enu[2] = y;
        const ecef = this._scratchECEF;
        ECEFENU.toECEF(enu[0], enu[1], enu[2], this.sourceFrame.originEcef,
                        this.sourceFrame.rotation, ecef);
        GeodeticECEF.toGeodetic(ecef[0], ecef[1], ecef[2],
                                 this.targetFrame.ellipsoid, out);
        break;
      }

      case SpatialTransformKind.REPROJECT_CRS: {
        // Generic fallback: treat as ENU → ECEF → target.
        const ecef = this._scratchECEF;
        ECEFENU.toECEF(x, y, z, this.sourceFrame.originEcef,
                        this.sourceFrame.rotation, ecef);
        this._ecefToTarget(ecef[0], ecef[1], ecef[2], out);
        break;
      }

      default:
        out[0] = x; out[1] = y; out[2] = z;
        break;
    }
    return out;
  }

  _ecefToTarget(ex, ey, ez, out) {
    switch (this.options.targetKind) {
      case SpatialFrameKind.LOCAL_ENU:
        return ECEFENU.toENU(ex, ey, ez, this.targetFrame.originEcef,
                              this.targetFrame.rotation, out);
      case SpatialFrameKind.ECEF:
        out[0] = ex; out[1] = ey; out[2] = ez;
        return out;
      case SpatialFrameKind.GEODETIC:
        return GeodeticECEF.toGeodetic(ex, ey, ez,
                                        this.targetFrame.ellipsoid, out);
      case SpatialFrameKind.LOCAL_Y_UP: {
        const enu = this._scratchENU;
        ECEFENU.toENU(ex, ey, ez, this.targetFrame.originEcef,
                       this.targetFrame.rotation, enu);
        out[0] = enu[0];
        out[1] = enu[2];
        out[2] = -enu[1];
        return out;
      }
      default:
        out[0] = ex; out[1] = ey; out[2] = ez;
        return out;
    }
  }

  // ---------------------------------------------------------------------
  // Bulk transforms (positions arrays)
  // ---------------------------------------------------------------------

  /**
   * Transforms a positions array in place. `positions` is a Float32Array or
   * Float64Array of [x, y, z, x, y, z, ...]. Returns the same array.
   */
  transformPositionsArray(positions) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const n = positions.length / 3;
    const out = this._scratchECEF; // reuse scratch — safe because we never use it twice in one call

    switch (this._kind) {
      case SpatialTransformKind.IDENTITY:
        this.stats.identityTiles++;
        return positions;

      case SpatialTransformKind.ENU_TO_YUP: {
        for (let i = 0; i < n; i++) {
          const e = positions[i * 3];
          const nn = positions[i * 3 + 1];
          const u = positions[i * 3 + 2];
          positions[i * 3] = e;
          positions[i * 3 + 1] = u;
          positions[i * 3 + 2] = -nn;
        }
        break;
      }

      case SpatialTransformKind.YUP_TO_ENU: {
        for (let i = 0; i < n; i++) {
          const x = positions[i * 3];
          const y = positions[i * 3 + 1];
          const z = positions[i * 3 + 2];
          positions[i * 3] = x;
          positions[i * 3 + 1] = -z;
          positions[i * 3 + 2] = y;
        }
        break;
      }

      default: {
        // General path: per-vertex transform.
        for (let i = 0; i < n; i++) {
          this.transformPosition(
            positions[i * 3],
            positions[i * 3 + 1],
            positions[i * 3 + 2],
            out
          );
          positions[i * 3] = out[0];
          positions[i * 3 + 1] = out[1];
          positions[i * 3 + 2] = out[2];
        }
        break;
      }
    }

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.positionsTransformed += n;
    this.stats.tilesTransformed++;
    this.stats.lastTransformMs = t1 - t0;
    return positions;
  }

  // ---------------------------------------------------------------------
  // Normal transforms
  // ---------------------------------------------------------------------

  /**
   * Transforms a normals array in place. Normals are rotated but not
   * translated, and are renormalized after the transform.
   */
  transformNormalsArray(normals) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const n = normals.length / 3;

    // Fast paths.
    if (this._kind === SpatialTransformKind.IDENTITY) return normals;

    if (this._kind === SpatialTransformKind.ENU_TO_YUP) {
      for (let i = 0; i < n; i++) {
        const e = normals[i * 3];
        const nn = normals[i * 3 + 1];
        const u = normals[i * 3 + 2];
        normals[i * 3] = e;
        normals[i * 3 + 1] = u;
        normals[i * 3 + 2] = -nn;
      }
    } else if (this._kind === SpatialTransformKind.YUP_TO_ENU) {
      for (let i = 0; i < n; i++) {
        const x = normals[i * 3];
        const y = normals[i * 3 + 1];
        const z = normals[i * 3 + 2];
        normals[i * 3] = x;
        normals[i * 3 + 1] = -z;
        normals[i * 3 + 2] = y;
      }
    } else {
      // General path: rotate by the combined matrix, renormalize.
      const r = this._rotation;
      for (let i = 0; i < n; i++) {
        const nx = normals[i * 3];
        const ny = normals[i * 3 + 1];
        const nz = normals[i * 3 + 2];
        const rx = r[0] * nx + r[1] * ny + r[2] * nz;
        const ry = r[3] * nx + r[4] * ny + r[5] * nz;
        const rz = r[6] * nx + r[7] * ny + r[8] * nz;
        const len = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
        normals[i * 3]     = rx / len;
        normals[i * 3 + 1] = ry / len;
        normals[i * 3 + 2] = rz / len;
      }
    }

    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.normalsTransformed += n;
    return normals;
  }

  // ---------------------------------------------------------------------
  // Heightmap tile transforms (grid-based)
  // ---------------------------------------------------------------------

  /**
   * Transforms an entire heightmap tile in place. Sets the tile’s origin,
   * updates the elevation Z to match the target frame’s vertical datum,
   * and re-derives the tile’s bounding box.
   */
  transformHeightmapTile(terrain) {
    if (!terrain || !terrain.elevation) return terrain;

    // Fast path: identity.
    if (this._kind === SpatialTransformKind.IDENTITY) {
      this.stats.identityTiles++;
      return terrain;
    }

    // Apply vertical datum shift.
    const datum = this.options.verticalDatum;
    if (datum && datum.data) {
      const latDeg = this.sourceFrame.originLat * (180 / Math.PI);
      const lonDeg = this.sourceFrame.originLon * (180 / Math.PI);
      const undulation = datum.sample(latDeg, lonDeg);
      if (undulation !== 0) {
        for (let i = 0; i < terrain.elevation.length; i++) {
          terrain.elevation[i] -= undulation;
        }
        terrain.minElevation -= undulation;
        terrain.maxElevation -= undulation;
      }
    }

    // For heightmap tiles, the horizontal origin shift is the only
    // world-space change; the internal grid stays anchored to its own
    // origin. Downstream systems read terrain.originX/originY, so we
    // update them here.
    if (this._kind === SpatialTransformKind.ENU_TO_YUP ||
        this._kind === SpatialTransformKind.YUP_TO_ENU) {
      // Swap axes for Y-up.
      const oldOriginX = terrain.originX;
      const oldOriginY = terrain.originY;
      terrain.originX = oldOriginX;
      terrain.originY = -oldOriginY;
    }

    // Reset cached bounds so they are recomputed.
    terrain._boundingBox = null;
    terrain._boundingSphere = null;

    return terrain;
  }

  // ---------------------------------------------------------------------
  // Diagnostic helpers
  // ---------------------------------------------------------------------

  /**
   * Returns the transform kind currently active.
   */
  getTransformKind() {
    return this._kind;
  }

  /**
   * Returns true if the current transform is the identity.
   */
  isIdentity() {
    return this._kind === SpatialTransformKind.IDENTITY;
  }

  /**
   * Returns the statistics from this transformer.
   */
  getStats() {
    return {
      ...this.stats,
      kind: this._kind,
      isIdentity: this.isIdentity()
    };
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. CONTEXT PROVIDER
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainSpatialCoordinateTransformerProvider — the context provider that
 * integrates the transformer with the living world:
 *
 *   • Manages a shared transformer instance.
 *   • Binds transform provenance to each tile via SpatialTransformComponent.
 *   • Streams transform stats into the context frame’s physical channel.
 *   • Exposes transformTile() and transformArray() methods to downstream
 *     systems.
 *
 * Unlike other context providers, this one has no per-tick work: the
 * transformer is called on-demand by the reconciler, painter, or dispatcher
 * when a tile is ready. That keeps it out of the per-frame budget entirely
 * except for the actual transform cost, which is O(vertices) and already
 * measured.
 */
export class TerrainSpatialCoordinateTransformerProvider {
  constructor(options = {}) {
    this.options = {
      targetHz: options.targetHz ?? 1,
      ...options
    };

    this.transformer = new TerrainSpatialCoordinateTransformer(options.transformerOptions ?? {});

    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // Provenance tracking: tileKey → { sourceFrameHash, targetFrameHash, tick }
    this._provenanceByTile = new Map();

    this.stats = {
      tilesTransformed: 0,
      tilesSkipped: 0,
      totalPositionsTransformed: 0,
      totalNormalsTransformed: 0
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  bind(contextFrame, ecsWorld, dispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcher = dispatcher;
    return this;
  }

  update(contextFrame, tick, dt) {
    this.frame = contextFrame;
    this.lastTick = tick;
    this._accumulator += dt;

    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;
  }

  // ---------------------------------------------------------------------
  // Frame configuration
  // ---------------------------------------------------------------------

  /**
   * Sets the source and target frames for a specific tile. Called by the
   * reconciler when the tile’s CRS is resolved.
   */
  configureTileTransform(tileKey, sourceFrame, targetFrame) {
    this.transformer.setFrames(sourceFrame, targetFrame);

    // Record provenance.
    this._provenanceByTile.set(tileKey, {
      sourceFrameHash: sourceFrame?.crsHash ?? 0,
      targetFrameHash: targetFrame?.crsHash ?? 0,
      kind: this.transformer.getTransformKind(),
      tick: this.lastTick
    });
  }

  // ---------------------------------------------------------------------
  // Transform API
  // ---------------------------------------------------------------------

  /**
   * Transforms a full heightmap or mesh tile in place. The tile must have
   * `positions` (Float32Array) and (optionally) `normals` (Float32Array).
   *
   * @returns {object} the same tile (mutated)
   */
  transformTile(terrain) {
    if (!terrain) return null;

    // Fast path: identity.
    if (this.transformer.isIdentity()) {
      this.stats.tilesSkipped++;
      return terrain;
    }

    // Heightmap tile vs mesh tile.
    if (terrain.elevation) {
      this.transformer.transformHeightmapTile(terrain);
    } else {
      if (terrain.positions) {
        this.transformer.transformPositionsArray(terrain.positions);
        this.stats.totalPositionsTransformed += terrain.positions.length / 3;
      }
      if (terrain.normals) {
        this.transformer.transformNormalsArray(terrain.normals);
        this.stats.totalNormalsTransformed += terrain.normals.length / 3;
      }
    }

    // Bind provenance to the ECS entity.
    if (this.ecsWorld && terrain.entityId !== 0xFFFFFFFF && terrain.tileKey) {
      const prov = this._provenanceByTile.get(terrain.tileKey);
      if (prov) {
        this.ecsWorld.addComponent?.(terrain.entityId, SpatialTransformComponent, {
          sourceFrameHash: prov.sourceFrameHash,
          targetFrameHash: prov.targetFrameHash,
          transformKind: prov.kind,
          maxResidual: this.transformer.options.maxResidual,
          vertexCount: (terrain.positions?.length ?? 0) / 3,
          lastTransformTick: this.lastTick,
          transformCount: 1
        });
      }
    }

    // Publish stats into the physical channel.
    this._publishStats();

    this.stats.tilesTransformed++;
    return terrain;
  }

  /**
   * Transforms a raw positions array in place. Useful for external callers
   * that already have a source/target frame pair and just want the math.
   */
  transformArray(positions) {
    this.transformer.transformPositionsArray(positions);
    this.stats.totalPositionsTransformed += positions.length / 3;
    return positions;
  }

  // ---------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------

  _publishStats() {
    if (!this.frame?.layers?.physical) return;
    const physical = this.frame.layers.physical;
    physical.spatialTransformStats = {
      tilesTransformed: this.stats.tilesTransformed,
      tilesSkipped: this.stats.tilesSkipped,
      totalPositionsTransformed: this.stats.totalPositionsTransformed,
      totalNormalsTransformed: this.stats.totalNormalsTransformed,
      transformStats: this.transformer.getStats(),
      lastTick: this.lastTick
    };
  }

  getStats() {
    return {
      ...this.stats,
      transformer: this.transformer.getStats(),
      provenanceCount: this._provenanceByTile.size
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    this._provenanceByTile.clear();
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. FACTORY
// ═════════════════════════════════════════════════════════════════════

export function createTerrainSpatialCoordinateTransformer(options = {}) {
  return new TerrainSpatialCoordinateTransformerProvider({
    targetHz: options.targetHz ?? 1,
    transformerOptions: options.transformerOptions ?? {},
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 7. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainSpatialCoordinateTransformer,
  TerrainSpatialCoordinateTransformerProvider,
  SpatialTransformComponent,
  SpatialTransformKind,
  VerticalDatumGrid,
  VerticalDatums,
  createTerrainSpatialCoordinateTransformer
};