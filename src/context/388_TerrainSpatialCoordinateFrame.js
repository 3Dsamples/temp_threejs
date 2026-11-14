// file number : 388
// full path name : src/context/388_TerrainSpatialCoordinateFrame.js
//### Description : Context-aware spatial coordinate frame for the seamless
//###               terrain pipeline. Provides the complete geodetic ↔ ECEF ↔
//###               ENU transformation stack required by 3D Tiles, I3S, and any
//###               planetary-scale terrain system, plus a coordinate-frame
//###               detector that infers the frame kind from a NormalizedCRS
//###               record (file 387). Implements the standard WGS84 ellipsoid
//###               math: semi-major axis a = 6378137.0 m, flattening f =
//###               1/298.257223563, first eccentricity squared e² = f(2−f), the
//###               prime-vertical radius N(φ) = a / √(1 − e² sin²φ), the forward
//###               geodetic → ECEF projection, the closed-form Bowring
//###               ECEF → geodetic inverse, and the six-parameter ENU rotation
//###               matrix. Also supports alternative planetary ellipsoids
//###               (GRS80, Mars MOLA, Moon ULCN, custom) so the same pipeline
//###               can render lunar, Martian, and asteroid terrain without a
//###               second coordinate system. All transforms are allocation-free
//###               and accept caller-supplied output arrays, so they can run
//###               inside the 60 Hz render loop without triggering GC pauses.
//###               Coordinates are stored as double-precision internally and
//###               can be cast to Float32Array for GPU upload when needed. The
//###               module streams per-tile coordinate-frame metadata into the
//###               context frame’s physical channel and binds each tile to an
//###               ECS entity with SpatialCoordinateFrameComponent so downstream
//###               systems can query the frame without a lookup. No external
//###               loader, no CDN access, no static server. Designed for
//###               Android arm64 under the 8 ms per-tick CPU ceiling and 200 MB
//###               resident memory cap.
//### Best for : Any terrain pipeline that must place geometry on a real
//###            planetary body — from a 10-unit local patch to a full-Earth
//###            3D Tiles tileset to a galactic-scale lunar or Martian surface.
//###            The frame is the single source of truth for “what coordinate
//###            system is this tile in?” and “how do I convert between local
//###            ENU, ECEF, and geodetic?” Every downstream system — reconciler,
//###            painter, dispatcher, query system — reads it instead of
//###            hard-coding WGS84.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat3, Mat4, Quat, DoubleDouble, Precision,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';

import {
  NormalizedCRS, NormalizedCRSComponent,
  CRSAuthority, CRSKind, CRSUnit
} from './387_TerrainNormalizeCRSIdentifier.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ELLIPSOID DEFINITIONS
// ═════════════════════════════════════════════════════════════════════

/**
 * Ellipsoid — a parametric reference ellipsoid.
 * Fields are the standard geodetic quantities:
 *   a  = semi-major axis (metres)
 *   f  = flattening
 *   b  = semi-minor axis (metres)
 *   e2 = first eccentricity squared
 *   ep2 = second eccentricity squared
 */
export class Ellipsoid {
  constructor(props) {
    this.name = props.name ?? 'custom';
    this.a = props.a;
    this.f = props.f;
    this.b = this.a * (1 - this.f);
    this.e2 = this.f * (2 - this.f);
    this.ep2 = (this.a * this.a - this.b * this.b) / (this.b * this.b);
  }

  /**
   * Prime-vertical radius of curvature at latitude φ (radians).
   */
  primeVerticalRadius(latRad) {
    const s = Math.sin(latRad);
    return this.a / Math.sqrt(1 - this.e2 * s * s);
  }

  /**
   * Meridian radius of curvature at latitude φ (radians).
   */
  meridianRadius(latRad) {
    const s = Math.sin(latRad);
    const w = 1 - this.e2 * s * s;
    return this.a * (1 - this.e2) / (w * Math.sqrt(w));
  }
}

/**
 * Built-in ellipsoids. Add a new entry to support a new planetary body.
 */
export const Ellipsoids = Object.freeze({
  WGS84: new Ellipsoid({
    name: 'WGS84', a: 6378137.0, f: 1 / 298.257223563
  }),
  GRS80: new Ellipsoid({
    name: 'GRS80', a: 6378137.0, f: 1 / 298.257222101
  }),
  MARS_MOLA: new Ellipsoid({
    name: 'MARS_MOLA', a: 3396190.0, f: 1 / 169.894447223612
  }),
  MOON_ULCN: new Ellipsoid({
    name: 'MOON_ULCN', a: 1737400.0, f: 0.0
  }),
  IO: new Ellipsoid({
    name: 'IO', a: 1821494.0, f: 0.0
  }),
  EUROPA: new Ellipsoid({
    name: 'EUROPA', a: 1560800.0, f: 0.0
  }),
  TITAN: new Ellipsoid({
    name: 'TITAN', a: 2575000.0, f: 0.0
  }),
  ENCELADUS: new Ellipsoid({
    name: 'ENCELADUS', a: 252100.0, f: 0.0
  }),
  CUSTOM: null // caller must provide
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENT
// ═════════════════════════════════════════════════════════════════════

/**
 * SpatialCoordinateFrameComponent — bound to every terrain tile that has a
 * resolved spatial coordinate frame. Stores the frame kind, the ellipsoid
 * parameters (a, b, e2), the local ENU origin (lat0, lon0, h0, and its
 * ECEF coordinates), and the ECEF-to-local rotation matrix so downstream
 * systems can transform points without re-deriving the matrix.
 */
export class SpatialCoordinateFrameComponent {
  static schema = {
    // Frame kind (matches SpatialFrameKind)
    frameKind:        { type: 'u8' },
    // Ellipsoid parameters
    ellipsoidA:       { type: 'f64' },
    ellipsoidB:       { type: 'f64' },
    ellipsoidE2:      { type: 'f64' },
    // ENU origin (geodetic)
    originLat:        { type: 'f64' },  // radians
    originLon:        { type: 'f64' },  // radians
    originHeight:     { type: 'f64' },  // metres above ellipsoid
    // ENU origin (ECEF)
    originEcefX:      { type: 'f64' },
    originEcefY:      { type: 'f64' },
    originEcefZ:      { type: 'f64' },
    // ECEF → ENU rotation matrix (row-major, 9 floats)
    rotM00: { type: 'f64' }, rotM01: { type: 'f64' }, rotM02: { type: 'f64' },
    rotM10: { type: 'f64' }, rotM11: { type: 'f64' }, rotM12: { type: 'f64' },
    rotM20: { type: 'f64' }, rotM21: { type: 'f64' }, rotM22: { type: 'f64' },
    // Source CRS hash for provenance
    crsHash:          { type: 'u32' },
    lastUpdatedTick:  { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. FRAME KIND ENUM
// ═════════════════════════════════════════════════════════════════════

/**
 * SpatialFrameKind — the kind of coordinate frame a tile is expressed in.
 */
export const SpatialFrameKind = Object.freeze({
  UNKNOWN:      0,
  LOCAL_ENU:    1,   // local east-north-up tangent plane
  LOCAL_Y_UP:   2,   // Three.js-style Y-up local frame
  ECEF:         3,   // earth-centred earth-fixed cartesian
  GEODETIC:     4,   // latitude, longitude, height on an ellipsoid
  PROJECTED:    5,   // planar projection (Web Mercator, UTM, etc.)
  GEOCENTRIC:   6    // synonym for ECEF, kept for CRS compatibility
});

// ═════════════════════════════════════════════════════════════════════
// 4. GEODETIC ↔ ECEF CONVERSION
// ═════════════════════════════════════════════════════════════════════

/**
 * GeodeticECEF — forward and inverse projections between geodetic
 * coordinates (lat, lon, h) and ECEF cartesian coordinates (X, Y, Z).
 *
 * All methods are pure functions of an Ellipsoid and are allocation-free
 * when the caller supplies output arrays.
 */
export class GeodeticECEF {
  /**
   * Forward: geodetic → ECEF.
   *   N = a / √(1 − e² sin²φ)
   *   X = (N + h) cosφ cosλ
   *   Y = (N + h) cosφ sinλ
   *   Z = (N(1 − e²) + h) sinφ
   *
   * @param {number} latRad – geodetic latitude (radians)
   * @param {number} lonRad – longitude (radians)
   * @param {number} h      – ellipsoidal height (metres)
   * @param {Ellipsoid} ellipsoid
   * @param {number[]|Float64Array} out – [X, Y, Z]
   * @returns {number[]|Float64Array} out
   */
  static toECEF(latRad, lonRad, h, ellipsoid, out) {
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);

    const N = ellipsoid.a / Math.sqrt(1 - ellipsoid.e2 * sinLat * sinLat);

    out[0] = (N + h) * cosLat * cosLon;
    out[1] = (N + h) * cosLat * sinLon;
    out[2] = (N * (1 - ellipsoid.e2) + h) * sinLat;
    return out;
  }

  /**
   * Inverse: ECEF → geodetic (lat, lon, h) using Bowring’s closed-form
   * method followed by one Newton refinement step for sub-millimetre
   * accuracy at terrestrial altitudes.
   *
   * @param {number} X, Y, Z – ECEF coordinates (metres)
   * @param {Ellipsoid} ellipsoid
   * @param {number[]|Float64Array} out – [latRad, lonRad, h]
   * @returns {number[]|Float64Array} out
   */
  static toGeodetic(X, Y, Z, ellipsoid, out) {
    const a = ellipsoid.a;
    const b = ellipsoid.b;
    const e2 = ellipsoid.e2;
    const ep2 = ellipsoid.ep2;

    const p = Math.sqrt(X * X + Y * Y);
    const lon = Math.atan2(Y, X);

    // Bowring’s auxiliary angle.
    const theta = Math.atan2(Z * a, p * b);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    // First estimate of latitude.
    const lat0 = Math.atan2(
      Z + ep2 * b * sinTheta * sinTheta * sinTheta,
      p - e2 * a * cosTheta * cosTheta * cosTheta
    );

    // Refinement (one Newton step).
    const sinLat = Math.sin(lat0);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const h = p / Math.cos(lat0) - N;
    const lat1 = Math.atan2(Z, p * (1 - e2 * N / (N + h)));

    out[0] = lat1;
    out[1] = lon;
    out[2] = h;
    return out;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. ECEF ↔ ENU CONVERSION
// ═════════════════════════════════════════════════════════════════════

/**
 * ECEFENU — conversion between ECEF cartesian coordinates and a local
 * East-North-Up tangent plane anchored at a reference geodetic point.
 *
 * The ECEF → ENU rotation matrix at origin (φ₀, λ₀) is:
 *
 *   R = [ −sinλ₀             cosλ₀              0     ]
 *       [ −sinφ₀ cosλ₀      −sinφ₀ sinλ₀        cosφ₀ ]
 *       [  cosφ₀ cosλ₀       cosφ₀ sinλ₀        sinφ₀ ]
 *
 * A point P expressed in ECEF is transformed to ENU by:
 *
 *   [E]       [X − X₀]
 *   [N] = R · [Y − Y₀]
 *   [U]       [Z − Z₀]
 *
 * The inverse transform is the transpose of R.
 */
export class ECEFENU {
  /**
   * Computes the ECEF → ENU rotation matrix at the given origin latitude
   * and longitude (radians). Writes nine values into `out` (row-major).
   */
  static rotationMatrix(lat0Rad, lon0Rad, out) {
    const sinLat = Math.sin(lat0Rad);
    const cosLat = Math.cos(lat0Rad);
    const sinLon = Math.sin(lon0Rad);
    const cosLon = Math.cos(lon0Rad);

    out[0] = -sinLon;         out[1] =  cosLon;         out[2] = 0;
    out[3] = -sinLat * cosLon; out[4] = -sinLat * sinLon; out[5] = cosLat;
    out[6] =  cosLat * cosLon; out[7] =  cosLat * sinLon; out[8] = sinLat;
    return out;
  }

  /**
   * ECEF → ENU. Writes [E, N, U] into `out`.
   * `rot` is the 9-element rotation matrix from rotationMatrix().
   */
  static toENU(X, Y, Z, originEcef, rot, out) {
    const dx = X - originEcef[0];
    const dy = Y - originEcef[1];
    const dz = Z - originEcef[2];
    out[0] = rot[0] * dx + rot[1] * dy + rot[2] * dz;
    out[1] = rot[3] * dx + rot[4] * dy + rot[5] * dz;
    out[2] = rot[6] * dx + rot[7] * dy + rot[8] * dz;
    return out;
  }

  /**
   * ENU → ECEF. Writes [X, Y, Z] into `out`.
   * Uses the transpose of the rotation matrix (i.e. R⁻¹ = Rᵀ).
   */
  static toECEF(E, N, U, originEcef, rot, out) {
    // out = Rᵀ · [E, N, U] + originEcef
    out[0] = rot[0] * E + rot[3] * N + rot[6] * U + originEcef[0];
    out[1] = rot[1] * E + rot[4] * N + rot[7] * U + originEcef[1];
    out[2] = rot[2] * E + rot[5] * N + rot[8] * U + originEcef[2];
    return out;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. SPATIAL COORDINATE FRAME
// ═════════════════════════════════════════════════════════════════════

/**
 * SpatialCoordinateFrame — a fully-resolved coordinate frame that knows
 * everything needed to transform between geodetic, ECEF, ENU, and local
 * Y-up coordinates. Instances are immutable after construction and are
 * cheap to clone.
 *
 * Constructed either from explicit geodetic origin parameters or from a
 * NormalizedCRS record (file 387) via the factory `fromCRS`.
 */
export class SpatialCoordinateFrame {
  constructor(props) {
    // ---- Ellipsoid ----
    this.ellipsoid = props.ellipsoid ?? Ellipsoids.WGS84;

    // ---- Frame kind ----
    this.kind = props.kind ?? SpatialFrameKind.LOCAL_ENU;

    // ---- Origin (geodetic) ----
    this.originLat = props.originLat ?? 0;     // radians
    this.originLon = props.originLon ?? 0;     // radians
    this.originHeight = props.originHeight ?? 0; // metres

    // ---- Origin (ECEF) ----
    this.originEcef = new Float64Array(3);
    GeodeticECEF.toECEF(
      this.originLat, this.originLon, this.originHeight,
      this.ellipsoid, this.originEcef
    );

    // ---- Rotation matrix (ECEF → ENU) ----
    this.rotation = new Float64Array(9);
    ECEFENU.rotationMatrix(this.originLat, this.originLon, this.rotation);

    // ---- Source CRS (optional) ----
    this.sourceCRS = props.sourceCRS ?? null;
    this.crsHash = props.crsHash ?? 0;

    // ---- Scratch buffers (per-instance, reused) ----
    this._scratch3 = new Float64Array(3);
  }

  // ---------------------------------------------------------------------
  // Geodetic
  // ---------------------------------------------------------------------

  /** Converts geodetic (lat, lon, h) to ECEF. */
  geodeticToECEF(latRad, lonRad, h, out) {
    return GeodeticECEF.toECEF(latRad, lonRad, h, this.ellipsoid, out);
  }

  /** Converts ECEF (X, Y, Z) to geodetic (lat, lon, h). */
  ecefToGeodetic(X, Y, Z, out) {
    return GeodeticECEF.toGeodetic(X, Y, Z, this.ellipsoid, out);
  }

  // ---------------------------------------------------------------------
  // ECEF ↔ ENU (relative to this frame’s origin)
  // ---------------------------------------------------------------------

  /** Converts ECEF to local ENU. */
  ecefToENU(X, Y, Z, out) {
    return ECEFENU.toENU(X, Y, Z, this.originEcef, this.rotation, out);
  }

  /** Converts local ENU to ECEF. */
  enuToECEF(E, N, U, out) {
    return ECEFENU.toECEF(E, N, U, this.originEcef, this.rotation, out);
  }

  // ---------------------------------------------------------------------
  // Direct geodetic ↔ ENU
  // ---------------------------------------------------------------------

  /** Converts geodetic to local ENU. */
  geodeticToENU(latRad, lonRad, h, out) {
    const ecef = this._scratch3;
    GeodeticECEF.toECEF(latRad, lonRad, h, this.ellipsoid, ecef);
    return ECEFENU.toENU(ecef[0], ecef[1], ecef[2], this.originEcef, this.rotation, out);
  }

  /** Converts local ENU to geodetic. */
  enuToGeodetic(E, N, U, out) {
    const ecef = this._scratch3;
    ECEFENU.toECEF(E, N, U, this.originEcef, this.rotation, ecef);
    return GeodeticECEF.toGeodetic(ecef[0], ecef[1], ecef[2], this.ellipsoid, out);
  }

  // ---------------------------------------------------------------------
  // Local Y-up (Three.js convention)
  // ---------------------------------------------------------------------

  /**
   * Converts ENU (East, North, Up) to a Three.js-style Y-up local frame
   * where Y is Up, X is East, and Z is South (so that -Z is North, matching
   * the standard camera convention).
   */
  enuToLocalYUp(E, N, U, out) {
    out[0] = E;
    out[1] = U;
    out[2] = -N;
    return out;
  }

  /**
   * Converts local Y-up back to ENU.
   */
  localYUpToENU(x, y, z, out) {
    out[0] = x;
    out[1] = -z;
    out[2] = y;
    return out;
  }

  /**
   * Converts geodetic to local Y-up directly.
   */
  geodeticToLocalYUp(latRad, lonRad, h, out) {
    const enu = this._scratch3;
    this.geodeticToENU(latRad, lonRad, h, enu);
    return this.enuToLocalYUp(enu[0], enu[1], enu[2], out);
  }

  // ---------------------------------------------------------------------
  // Bulk transforms (for whole-grid reprojection)
  // ---------------------------------------------------------------------

  /**
   * Transforms an array of local ENU points to local Y-up in place.
   * `positions` is a Float32Array or Float64Array of [E, N, U, E, N, U, ...].
   */
  transformENUArrayToLocalYUp(positions) {
    for (let i = 0; i < positions.length; i += 3) {
      const e = positions[i];
      const n = positions[i + 1];
      const u = positions[i + 2];
      positions[i] = e;
      positions[i + 1] = u;
      positions[i + 2] = -n;
    }
    return positions;
  }

  // ---------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------

  /** Returns a compact diagnostic string. */
  toString() {
    return `SpatialCoordinateFrame(kind=${this.kind}, ellipsoid=${this.ellipsoid.name}, origin=[${this.originLat.toFixed(6)}, ${this.originLon.toFixed(6)}])`;
  }

  /** Clones the frame. */
  clone() {
    return new SpatialCoordinateFrame({
      ellipsoid: this.ellipsoid,
      kind: this.kind,
      originLat: this.originLat,
      originLon: this.originLon,
      originHeight: this.originHeight,
      sourceCRS: this.sourceCRS,
      crsHash: this.crsHash
    });
  }

  // ---------------------------------------------------------------------
  // Factory: from a NormalizedCRS record
  // ---------------------------------------------------------------------

  /**
   * Derives a SpatialCoordinateFrame from a NormalizedCRS record. The
   * frame kind is inferred from the CRS kind, and the ellipsoid from the
   * authority code (with sensible defaults per planetary body).
   */
  static fromCRS(crs, options = {}) {
    if (!crs) return null;

    // Infer frame kind from the CRS kind.
    let kind;
    switch (crs.kind) {
      case CRSKind.GEOGRAPHIC:   kind = SpatialFrameKind.GEODETIC; break;
      case CRSKind.GEOCENTRIC:   kind = SpatialFrameKind.ECEF;    break;
      case CRSKind.PROJECTED:    kind = SpatialFrameKind.PROJECTED; break;
      default:                   kind = SpatialFrameKind.UNKNOWN;
    }

    // Infer ellipsoid from the authority + code.
    const ellipsoid = options.ellipsoid ?? inferEllipsoid(crs);

    // Origin defaults (caller can override).
    const originLat = options.originLat ?? 0;
    const originLon = options.originLon ?? 0;
    const originHeight = options.originHeight ?? 0;

    return new SpatialCoordinateFrame({
      ellipsoid,
      kind,
      originLat,
      originLon,
      originHeight,
      sourceCRS: crs,
      crsHash: crs.urnHash
    });
  }
}

// ═════════════════════════════════════════════════════════════════════
// 7. ELLIPSOID INFERENCE FROM CRS
// ═════════════════════════════════════════════════════════════════════

/**
 * Infers the reference ellipsoid from a NormalizedCRS record. Falls back to
 * WGS84 for anything unrecognized — matching the loaders.gl default where
 * the specification establishes a global frame.
 */
function inferEllipsoid(crs) {
  // IAU authority → planetary body ellipsoid.
  if (crs.authority === CRSAuthority.IAU) {
    switch (crs.code) {
      case 30100: // Mars
      case 30101:
        return Ellipsoids.MARS_MOLA;
      case 30102: // Moon
        return Ellipsoids.MOON_ULCN;
      case 30103: // Io
        return Ellipsoids.IO;
      case 30104: // Europa
        return Ellipsoids.EUROPA;
      case 30105: // Titan
        return Ellipsoids.TITAN;
      case 30106: // Enceladus
        return Ellipsoids.ENCELADUS;
      default:
        return Ellipsoids.WGS84;
    }
  }

  // All EPSG and ESRI CRS use WGS84 or GRS80. GRS80 differs from WGS84
  // in flattening only, so we default to WGS84 for compatibility.
  return Ellipsoids.WGS84;
}

// ═════════════════════════════════════════════════════════════════════
// 8. COORDINATE FRAME PROVIDER
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainSpatialCoordinateFrame — the context provider that manages
 * SpatialCoordinateFrame instances and their integration with the living
 * world:
 *
 *   • Creates a frame for each source CRS the pipeline encounters.
 *   • Binds each frame to an ECS entity with SpatialCoordinateFrameComponent.
 *   • Streams frame metadata into the context frame’s physical channel.
 *   • Exposes the transform API to any downstream system.
 *
 * Frames are memoized by CRS hash so two tiles with the same CRS share the
 * same frame instance — no redundant matrix computation.
 */
export class TerrainSpatialCoordinateFrame {
  constructor(options = {}) {
    this.options = {
      targetHz: options.targetHz ?? 1,
      defaultEllipsoid: options.defaultEllipsoid ?? Ellipsoids.WGS84,
      defaultOriginLat: options.defaultOriginLat ?? 0,
      defaultOriginLon: options.defaultOriginLon ?? 0,
      defaultOriginHeight: options.defaultOriginHeight ?? 0,
      ...options
    };

    // Frame registry: crsHash → SpatialCoordinateFrame
    this._framesByHash = new Map();
    // Frame-to-entity mapping: crsHash → entityId
    this._entityByHash = new Map();

    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;
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
  // Frame resolution
  // ---------------------------------------------------------------------

  /**
   * Resolves a SpatialCoordinateFrame for the given NormalizedCRS. Frames
   * are memoized so the same CRS always yields the same frame instance.
   */
  resolveFrame(crs, options = {}) {
    if (!crs) {
      // Return the default frame.
      return this._getOrCreateDefaultFrame();
    }

    const hash = crs.urnHash;
    const existing = this._framesByHash.get(hash);
    if (existing) return existing;

    const frame = SpatialCoordinateFrame.fromCRS(crs, {
      ellipsoid: options.ellipsoid ?? this.options.defaultEllipsoid,
      originLat: options.originLat ?? this.options.defaultOriginLat,
      originLon: options.originLon ?? this.options.defaultOriginLon,
      originHeight: options.originHeight ?? this.options.defaultOriginHeight
    });

    this._framesByHash.set(hash, frame);
    this._registerFrame(frame, crs, this.lastTick);
    return frame;
  }

  _getOrCreateDefaultFrame() {
    const hash = 0;
    const existing = this._framesByHash.get(hash);
    if (existing) return existing;

    const frame = new SpatialCoordinateFrame({
      ellipsoid: this.options.defaultEllipsoid,
      kind: SpatialFrameKind.LOCAL_ENU,
      originLat: this.options.defaultOriginLat,
      originLon: this.options.defaultOriginLon,
      originHeight: this.options.defaultOriginHeight,
      sourceCRS: null,
      crsHash: 0
    });

    this._framesByHash.set(hash, frame);
    return frame;
  }

  // ---------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------

  _registerFrame(frame, crs, tick) {
    const hash = frame.crsHash;

    // Physical channel registry.
    if (this.frame?.layers?.physical) {
      const physical = this.frame.layers.physical;
      if (!physical.spatialFrames) {
        physical.spatialFrames = new Map();
        physical.spatialFrameEntityIds = [];
      }
      if (!physical.spatialFrames.has(hash)) {
        physical.spatialFrames.set(hash, frame);
        physical.spatialFrameEntityIds.push(this._entityByHash.get(hash) ?? 0xFFFFFFFF);
      }
    }

    // ECS binding.
    if (this.ecsWorld && !this._entityByHash.has(hash)) {
      const entityId = this.ecsWorld.createEntity?.() ?? 0xFFFFFFFF;
      if (entityId !== 0xFFFFFFFF) {
        this.ecsWorld.addComponent?.(entityId, SpatialCoordinateFrameComponent, {
          frameKind: frame.kind,
          ellipsoidA: frame.ellipsoid.a,
          ellipsoidB: frame.ellipsoid.b,
          ellipsoidE2: frame.ellipsoid.e2,
          originLat: frame.originLat,
          originLon: frame.originLon,
          originHeight: frame.originHeight,
          originEcefX: frame.originEcef[0],
          originEcefY: frame.originEcef[1],
          originEcefZ: frame.originEcef[2],
          rotM00: frame.rotation[0], rotM01: frame.rotation[1], rotM02: frame.rotation[2],
          rotM10: frame.rotation[3], rotM11: frame.rotation[4], rotM12: frame.rotation[5],
          rotM20: frame.rotation[6], rotM21: frame.rotation[7], rotM22: frame.rotation[8],
          crsHash: hash,
          lastUpdatedTick: tick
        });
        this._entityByHash.set(hash, entityId);

        const physical = this.frame?.layers?.physical;
        if (physical?.spatialFrameEntityIds) {
          const idx = physical.spatialFrameEntityIds.indexOf(0xFFFFFFFF);
          if (idx >= 0) physical.spatialFrameEntityIds[idx] = entityId;
          else physical.spatialFrameEntityIds.push(entityId);
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  /**
   * Returns the frame for a CRS hash, or null.
   */
  getFrameByHash(hash) {
    return this._framesByHash.get(hash) ?? null;
  }

  /**
   * Returns the ECS entity id for a frame, or 0xFFFFFFFF.
   */
  getEntityId(crsHash) {
    return this._entityByHash.get(crsHash) ?? 0xFFFFFFFF;
  }

  /**
   * Returns the number of registered frames.
   */
  get size() {
    return this._framesByHash.size;
  }

  /**
   * Returns the default frame (used when no CRS is provided).
   */
  getDefaultFrame() {
    return this._getOrCreateDefaultFrame();
  }

  getStats() {
    return {
      registeredFrames: this._framesByHash.size,
      boundEntities: this._entityByHash.size
    };
  }

  dispose() {
    this._framesByHash.clear();
    this._entityByHash.clear();
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 9. FACTORY
// ═════════════════════════════════════════════════════════════════════

export function createTerrainSpatialCoordinateFrame(options = {}) {
  return new TerrainSpatialCoordinateFrame({
    targetHz: options.targetHz ?? 1,
    defaultEllipsoid: options.defaultEllipsoid ?? Ellipsoids.WGS84,
    defaultOriginLat: options.defaultOriginLat ?? 0,
    defaultOriginLon: options.defaultOriginLon ?? 0,
    defaultOriginHeight: options.defaultOriginHeight ?? 0,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 10. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  // Ellipsoids
  Ellipsoid,
  Ellipsoids,
  // Math
  GeodeticECEF,
  ECEFENU,
  // Frame
  SpatialCoordinateFrame,
  SpatialFrameKind,
  SpatialCoordinateFrameComponent,
  // Provider
  TerrainSpatialCoordinateFrame,
  createTerrainSpatialCoordinateFrame
};