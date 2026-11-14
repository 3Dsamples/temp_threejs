// file number : 387
// full path name : src/context/387_TerrainNormalizeCRSIdentifier.js
//### Description : Context-aware CRS identifier normalization utility for the
//###               seamless terrain pipeline. Parses and canonicalizes every
//###               coordinate reference system identifier form that can appear
//###               in a terrain payload: EPSG numeric codes (4326), OGC URNs
//###               (urn:ogc:def:crs:EPSG::4326), OGC HTTP URIs
//###               (http://www.opengis.net/def/crs/EPSG/0/4326), ESRI codes
//###               (ESRI:102100), WKT-CRS authority clauses, and plain
//###               namespace-prefixed strings (EPSG:4326). Produces a single
//###               canonical record — { authority, code, urn, uri, kind,
//###               datumType, isGeographic, isProjected } — that downstream
//###               terrain systems (files 372, 375, 380, 381, 386) can rely on
//###               without re-parsing. No worker is required because every
//###               normalization is a pure string-to-record transform; the
//###               entire module is allocation-free after the first parse of
//###               any given identifier, since parsed records are memoized in a
//###               bounded LRU cache. The normalized records are also streamed
//###               into the context frame’s physical channel and bound to ECS
//###               entities so downstream systems can query them without a
//###               lookup. No external loader, no CDN access, no static server.
//###               Designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap.
//### Best for : Any terrain pipeline that must accept CRS identifiers from
//###            mixed sources — WKB, WKT, SHP, GeoPackage, quantized-mesh,
//###            3D Tiles metadata, or user input — and needs a single canonical
//###            representation before geometry is placed in the world. The
//###            canonical record is deliberately tiny (a few dozen bytes) and
//###            fully structure-of-arrays so ECS systems can iterate it
//###            without pointer chasing.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';

import {
  TilesetSourceFormat,
  TileState,
  SeamEdge,
  stringTileKey,
  fnv1aHash
} from './373_Tileset2DTypes.js';

// ═════════════════════════════════════════════════════════════════════
// 1. CRS CONSTANTS
// ═════════════════════════════════════════════════════════════════════

/**
 * CRSAuthority — canonical authority identifiers. Matches the enumeration
 * used by file 362 (WKT-CRS) and by the terrain pipeline’s physical channel.
 */
export const CRSAuthority = Object.freeze({
  NONE:    0,
  EPSG:    1,
  ESRI:    2,
  OGC:     3,
  SR_ORG:  4,   // spatialreference.org
  IAU:     5,   // International Astronomical Union (for lunar/martian CRS)
  CUSTOM:  6
});

/**
 * CRSKind — high-level classification of the CRS.
 */
export const CRSKind = Object.freeze({
  UNKNOWN:     0,
  GEOGRAPHIC:  1,   // angular lat/lon, usually degrees
  PROJECTED:   2,   // planar, usually metres or feet
  GEOCENTRIC:  3,   // 3D cartesian, usually metres
  COMPOUND:    4,   // horizontal + vertical
  VERTICAL:    5,   // vertical only
  LOCAL:       6,   // local tangent-plane or site CRS
  ENGINEERING: 7,   // engineering coordinate system
  TEMPORAL:    8    // temporal CRS (rare)
});

/**
 * CRSUnit — canonical unit system.
 */
export const CRSUnit = Object.freeze({
  UNKNOWN:     0,
  METRES:      1,
  FEET:        2,
  US_SURVEY_FEET: 3,
  DEGREES:     4,
  RADIANS:     5,
  ARCSECONDS:  6
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENTS
// ═════════════════════════════════════════════════════════════════════

/**
 * NormalizedCRSComponent — bound to every entity that carries geometry
 * tagged with a CRS. Stores the canonical fields so downstream systems
 * (reconciler, painter, dispatcher, query system) can read the CRS without
 * re-parsing the identifier string.
 */
export class NormalizedCRSComponent {
  static schema = {
    authority:        { type: 'u8' },   // CRSAuthority.*
    kind:             { type: 'u8' },   // CRSKind.*
    unit:             { type: 'u8' },   // CRSUnit.*
    code:             { type: 'u32' },  // authority-specific numeric code
    urnHash:          { type: 'u32' },  // FNV-1a of the canonical URN
    uriHash:          { type: 'u32' },  // FNV-1a of the canonical URI
    isGeographic:     { type: 'u8' },
    isProjected:      { type: 'u8' },
    isGeocentric:     { type: 'u8' },
    hasVertical:      { type: 'u8' },
    datumShiftKnown:  { type: 'u8' },
    lastUpdatedTick:  { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. NORMALIZED CRS RECORD
// ═════════════════════════════════════════════════════════════════════

/**
 * NormalizedCRS — the canonical record returned by every parse operation.
 * Immutable after construction; safe to share across tiles, threads, and
 * frames.
 */
export class NormalizedCRS {
  constructor(fields) {
    this.authority    = fields.authority ?? CRSAuthority.NONE;
    this.kind         = fields.kind ?? CRSKind.UNKNOWN;
    this.unit         = fields.unit ?? CRSUnit.UNKNOWN;
    this.code         = fields.code ?? 0;
    this.urn          = fields.urn ?? '';
    this.uri          = fields.uri ?? '';
    this.wktAuthority = fields.wktAuthority ?? '';
    this.isGeographic = fields.isGeographic ?? false;
    this.isProjected  = fields.isProjected ?? false;
    this.isGeocentric = fields.isGeocentric ?? false;
    this.hasVertical  = fields.hasVertical ?? false;
    this.datumShiftKnown = fields.datumShiftKnown ?? false;
    this.urnHash      = fnv1aHash(this.urn);
    this.uriHash      = fnv1aHash(this.uri);
    this.original     = fields.original ?? '';
  }

  /** Returns the canonical authority name as a string (EPSG, ESRI, ...). */
  get authorityName() {
    switch (this.authority) {
      case CRSAuthority.EPSG:    return 'EPSG';
      case CRSAuthority.ESRI:    return 'ESRI';
      case CRSAuthority.OGC:     return 'OGC';
      case CRSAuthority.SR_ORG:  return 'SR-ORG';
      case CRSAuthority.IAU:     return 'IAU';
      case CRSAuthority.CUSTOM:  return 'CUSTOM';
      default:                   return 'NONE';
    }
  }

  /** Returns a compact diagnostic string. */
  toString() {
    return `NormalizedCRS(${this.authorityName}:${this.code}, kind=${this.kind}, unit=${this.unit})`;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. PARSERS — one per accepted identifier form
// ═════════════════════════════════════════════════════════════════════

const _PARSER_NAMES = ['epsg-numeric', 'epsg-prefix', 'ogc-urn', 'ogc-http',
                        'esri-prefix', 'wkt-authority', 'plain-urn', 'plain-http'];

/**
 * CRSIdentifierParser — a set of pure parsers that together cover every
 * identifier form the terrain pipeline is expected to encounter. Each parser
 * returns either a NormalizedCRS or null (meaning “this form does not match”).
 */
export class CRSIdentifierParser {
  /**
   * Matches a bare integer (e.g. "4326").
   */
  static parseEpsgNumeric(s) {
    const trimmed = s.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const code = parseInt(trimmed, 10);
    return new NormalizedCRS({
      authority: CRSAuthority.EPSG,
      code,
      urn: `urn:ogc:def:crs:EPSG::${code}`,
      uri: `http://www.opengis.net/def/crs/EPSG/0/${code}`,
      kind: inferKindFromEpsg(code),
      unit: inferUnitFromEpsg(code),
      isGeographic: isGeographicEpsg(code),
      isProjected: isProjectedEpsg(code),
      isGeocentric: isGeocentricEpsg(code),
      datumShiftKnown: code === 4326 || code === 3857,
      original: s
    });
  }

  /**
   * Matches "EPSG:4326", "EPSG::4326", "EPSG/0/4326".
   */
  static parseEpsgPrefix(s) {
    const m = s.match(/^\s*EPSG\s*[:/]\s*(?:\d+\s*[:/]\s*)?(\d+)\s*$/i);
    if (!m) return null;
    const code = parseInt(m[1], 10);
    return new NormalizedCRS({
      authority: CRSAuthority.EPSG,
      code,
      urn: `urn:ogc:def:crs:EPSG::${code}`,
      uri: `http://www.opengis.net/def/crs/EPSG/0/${code}`,
      kind: inferKindFromEpsg(code),
      unit: inferUnitFromEpsg(code),
      isGeographic: isGeographicEpsg(code),
      isProjected: isProjectedEpsg(code),
      isGeocentric: isGeocentricEpsg(code),
      datumShiftKnown: code === 4326 || code === 3857,
      original: s
    });
  }

  /**
   * Matches "urn:ogc:def:crs:EPSG::4326" and OGC URN variants.
   */
  static parseOgcUrn(s) {
    const m = s.match(/^\s*urn:ogc:def:crs:([A-Za-z0-9_]+):([^:]*):(\d+)\s*$/i);
    if (!m) return null;
    const auth = m[1].toUpperCase();
    const version = m[2] || '0';
    const code = parseInt(m[3], 10);
    return _makeRecord(auth, code, version, s);
  }

  /**
   * Matches "http://www.opengis.net/def/crs/EPSG/0/4326".
   */
  static parseOgcHttp(s) {
    const m = s.match(/^\s*https?:\/\/www\.opengis\.net\/def\/crs\/([A-Za-z0-9_]+)\/([0-9.]+)\/(\d+)\s*$/i);
    if (!m) return null;
    const auth = m[1].toUpperCase();
    const version = m[2];
    const code = parseInt(m[3], 10);
    return _makeRecord(auth, code, version, s);
  }

  /**
   * Matches "ESRI:102100".
   */
  static parseEsriPrefix(s) {
    const m = s.match(/^\s*ESRI\s*[:/]\s*(\d+)\s*$/i);
    if (!m) return null;
    const code = parseInt(m[1], 10);
    return new NormalizedCRS({
      authority: CRSAuthority.ESRI,
      code,
      urn: `urn:ogc:def:crs:ESRI::${code}`,
      uri: `http://www.opengis.net/def/crs/ESRI/0/${code}`,
      kind: inferKindFromEsri(code),
      unit: CRSUnit.METRES,
      isGeographic: false,
      isProjected: true,
      isGeocentric: false,
      datumShiftKnown: false,
      original: s
    });
  }

  /**
   * Matches the "AUTHORITY["EPSG","4326"]" clause (WKT 1) or
   * "ID["EPSG",4326]" clause (WKT 2).
   */
  static parseWktAuthority(s) {
    const m = s.match(/^\s*(?:AUTHORITY|ID)\s*\[\s*"([^"]+)"\s*,\s*"?(\d+)"?\s*\]\s*$/i);
    if (!m) return null;
    const auth = m[1].toUpperCase();
    const code = parseInt(m[2], 10);
    const record = _makeRecord(auth, code, '0', s);
    if (record) record.wktAuthority = s;
    return record;
  }

  /**
   * Matches a plain URN that isn't OGC (e.g. "urn:ogc:def:crs:IAU::30100").
   */
  static parsePlainUrn(s) {
    const m = s.match(/^\s*urn:([a-z0-9_]+):def:crs:([A-Za-z0-9_]+)::?(\d+)\s*$/i);
    if (!m) return null;
    const auth = m[2].toUpperCase();
    const code = parseInt(m[3], 10);
    return _makeRecord(auth, code, '0', s);
  }

  /**
   * Matches a generic URL that ends with an authority and code.
   */
  static parsePlainHttp(s) {
    const m = s.match(/^\s*https?:\/\/[^\s]*\/([A-Za-z0-9_]+)\/(?:[0-9.]+\/)?(\d+)\s*$/i);
    if (!m) return null;
    const auth = m[1].toUpperCase();
    const code = parseInt(m[2], 10);
    return _makeRecord(auth, code, '0', s);
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. INTERNAL HELPERS — inferred metadata per authority
// ═════════════════════════════════════════════════════════════════════

function _makeRecord(authName, code, version, original) {
  let authority = CRSAuthority.CUSTOM;
  switch (authName) {
    case 'EPSG':   authority = CRSAuthority.EPSG;   break;
    case 'ESRI':   authority = CRSAuthority.ESRI;   break;
    case 'OGC':    authority = CRSAuthority.OGC;    break;
    case 'SR-ORG':
    case 'SR_ORG': authority = CRSAuthority.SR_ORG; break;
    case 'IAU':    authority = CRSAuthority.IAU;    break;
    default:       authority = CRSAuthority.CUSTOM; break;
  }
  return new NormalizedCRS({
    authority,
    code,
    urn: `urn:ogc:def:crs:${authName}::${code}`,
    uri: `http://www.opengis.net/def/crs/${authName}/${version}/${code}`,
    kind: inferKindFromEpsg(code),
    unit: inferUnitFromEpsg(code),
    isGeographic: isGeographicEpsg(code),
    isProjected: isProjectedEpsg(code),
    isGeocentric: isGeocentricEpsg(code),
    datumShiftKnown: code === 4326 || code === 3857,
    original
  });
}

function inferKindFromEpsg(code) {
  if (code === 4978) return CRSKind.GEOCENTRIC;              // WGS 84 geocentric
  if (code >= 4000 && code < 5000) return CRSKind.GEOGRAPHIC;
  if (code >= 2000 && code < 4000) return CRSKind.PROJECTED;
  if (code >= 5000 && code < 6000) return CRSKind.PROJECTED;  // ESRI-style projected
  if (code >= 6000 && code < 7000) return CRSKind.PROJECTED;
  if (code >= 20000 && code < 33000) return CRSKind.PROJECTED;
  if (code >= 32000 && code < 33000) return CRSKind.GEOGRAPHIC;
  return CRSKind.UNKNOWN;
}

function inferKindFromEsri(code) {
  if (code >= 1000 && code < 4000) return CRSKind.PROJECTED;
  if (code >= 4000 && code < 5000) return CRSKind.GEOGRAPHIC;
  if (code >= 100000) return CRSKind.PROJECTED;
  return CRSKind.UNKNOWN;
}

function inferUnitFromEpsg(code) {
  // EPSG 4326 and other geographic CRS use degrees by default.
  if (code >= 4000 && code < 5000) return CRSUnit.DEGREES;
  // 4978 is geocentric, use metres.
  if (code === 4978) return CRSUnit.METRES;
  // 2226+ (California) and 2263+ (New York) use US survey feet.
  if (code >= 2226 && code < 2300) return CRSUnit.US_SURVEY_FEET;
  if (code === 2263) return CRSUnit.US_SURVEY_FEET;
  // Everything else defaults to metres.
  return CRSUnit.METRES;
}

function isGeographicEpsg(code) {
  return code >= 4000 && code < 5000;
}

function isProjectedEpsg(code) {
  return (code >= 2000 && code < 4000) ||
         (code >= 5000 && code < 7000) ||
         (code >= 20000 && code < 33000);
}

function isGeocentricEpsg(code) {
  return code === 4978 || code === 4979;
}

// ═════════════════════════════════════════════════════════════════════
// 6. MEMOIZED NORMALIZER
// ═════════════════════════════════════════════════════════════════════

/**
 * CRSIdentifierNormalizer — the single public entry point for converting any
 * CRS identifier string into a canonical NormalizedCRS record. Memoizes
 * every successful parse in a bounded LRU cache so repeated calls (which
 * happen constantly during tile streaming) become O(1) hash lookups.
 */
export class CRSIdentifierNormalizer {
  constructor(options = {}) {
    this.options = {
      maxCacheSize: options.maxCacheSize ?? 1024,
      ...options
    };

    // Memo cache: key = lowercase trimmed string, value = NormalizedCRS
    this._cache = new Map();
    this._cacheOrder = [];

    // Parse order: most-specific first, then generic fallbacks.
    this._parsers = [
      CRSIdentifierParser.parseOgcHttp,
      CRSIdentifierParser.parseOgcUrn,
      CRSIdentifierParser.parsePlainUrn,
      CRSIdentifierParser.parsePlainHttp,
      CRSIdentifierParser.parseWktAuthority,
      CRSIdentifierParser.parseEpsgPrefix,
      CRSIdentifierParser.parseEsriPrefix,
      CRSIdentifierParser.parseEpsgNumeric
    ];

    // Statistics.
    this.stats = {
      parsed: 0,
      cached: 0,
      failed: 0
    };
  }

  /**
   * Parses any CRS identifier form into a NormalizedCRS record.
   * Never throws; returns null on failure (the caller decides the fallback).
   */
  parse(identifier) {
    if (identifier == null) {
      this.stats.failed++;
      return null;
    }
    if (typeof identifier !== 'string') {
      this.stats.failed++;
      return null;
    }
    const key = identifier.trim().toLowerCase();
    if (key.length === 0) {
      this.stats.failed++;
      return null;
    }

    // Fast path: memo cache hit.
    const cached = this._cache.get(key);
    if (cached) {
      this.stats.cached++;
      this._touch(key);
      return cached;
    }

    // Slow path: try every parser in order.
    for (const parser of this._parsers) {
      try {
        const result = parser(identifier);
        if (result) {
          this.stats.parsed++;
          this._insert(key, result);
          return result;
        }
      } catch (e) {
        // Continue to the next parser.
      }
    }

    this.stats.failed++;
    return null;
  }

  /**
   * Convenience: parse a bare EPSG code (number or numeric string) directly,
   * skipping the parser loop. Useful when the caller already knows the
   * authority.
   */
  parseEpsg(code) {
    if (typeof code === 'string') code = parseInt(code, 10);
    if (!Number.isFinite(code) || code <= 0) return null;
    const key = `epsg:${code}`;
    const cached = this._cache.get(key);
    if (cached) {
      this.stats.cached++;
      this._touch(key);
      return cached;
    }
    const result = _makeRecord('EPSG', code, '0', String(code));
    this.stats.parsed++;
    this._insert(key, result);
    return result;
  }

  /**
   * Returns true if the identifier has been parsed before (cache hit).
   */
  isCached(identifier) {
    const key = String(identifier ?? '').trim().toLowerCase();
    return this._cache.has(key);
  }

  /**
   * Returns the number of entries in the cache.
   */
  get cacheSize() {
    return this._cache.size;
  }

  // ---------------------------------------------------------------------
  // LRU eviction
  // ---------------------------------------------------------------------

  _insert(key, value) {
    if (this._cache.size >= this.options.maxCacheSize) {
      const oldest = this._cacheOrder.shift();
      if (oldest !== undefined) this._cache.delete(oldest);
    }
    this._cache.set(key, value);
    this._cacheOrder.push(key);
  }

  _touch(key) {
    const idx = this._cacheOrder.indexOf(key);
    if (idx >= 0) this._cacheOrder.splice(idx, 1);
    this._cacheOrder.push(key);
  }

  clear() {
    this._cache.clear();
    this._cacheOrder.length = 0;
  }

  dispose() {
    this.clear();
    this._parsers = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 7. CONTEXT-FRAME PROVIDER
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainNormalizeCRSIdentifier — the context provider that integrates the
 * normalizer with the living world:
 *
 *   • Streams every normalized record into the context frame’s physical
 *     channel (physical.crsRegistry).
 *   • Binds each normalized record to an ECS entity with
 *     NormalizedCRSComponent so downstream systems can query it.
 *   • Exposes the parse() method to any system that needs to canonicalize a
 *     CRS identifier on demand.
 *
 * Because every normalization is a pure transform and the memo cache is
 * bounded, this provider does not require a worker pool and imposes no
 * per-tick cost unless a new identifier appears.
 */
export class TerrainNormalizeCRSIdentifier {
  constructor(options = {}) {
    this.options = {
      targetHz: options.targetHz ?? 1,   // housekeeping tier
      maxCacheSize: options.maxCacheSize ?? 1024,
      ...options
    };

    this.normalizer = new CRSNormalizerCacheWrapper(new CRSIdentifierNormalizer({
      maxCacheSize: this.options.maxCacheSize
    }));

    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // Registry: authorityHash → entityId
    this._entityByKey = new Map();
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /**
   * Binds the provider to the runtime.
   */
  bind(contextFrame, ecsWorld, dispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcher = dispatcher;
    return this;
  }

  // ---------------------------------------------------------------------
  // Provider update — called at 1 Hz
  // ---------------------------------------------------------------------

  update(contextFrame, tick, dt) {
    this.frame = contextFrame;
    this.lastTick = tick;
    this._accumulator += dt;

    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    // Nothing to do unless new records were added externally; the parsing
    // path is triggered by ingest().
  }

  // ---------------------------------------------------------------------
  // Public parse (also used internally by all other terrain systems)
  // ---------------------------------------------------------------------

  /**
   * Parses a CRS identifier, registers it in the frame and ECS world, and
   * returns the canonical record. Idempotent: calling parse() twice with
   * the same identifier returns the same record and reuses the same ECS
   * entity.
   */
  parse(identifier, tick = null) {
    const record = this.normalizer.parse(identifier);
    if (!record) return null;

    const effectiveTick = tick ?? this.lastTick;
    this._register(record, effectiveTick);
    return record;
  }

  /**
   * Convenience: parses a bare EPSG code.
   */
  parseEpsg(code, tick = null) {
    const record = this.normalizer.parseEpsg(code);
    if (!record) return null;
    const effectiveTick = tick ?? this.lastTick;
    this._register(record, effectiveTick);
    return record;
  }

  // ---------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------

  _register(record, tick) {
    const key = `${record.authority}:${record.code}`;

    // Physical channel registry.
    if (this.frame?.layers?.physical) {
      const physical = this.frame.layers.physical;
      if (!physical.crsRegistry) {
        physical.crsRegistry = new Map();
        physical.crsEntityIds = [];
        physical.crsAuthorityNames = {
          0: 'NONE', 1: 'EPSG', 2: 'ESRI', 3: 'OGC', 4: 'SR-ORG', 5: 'IAU', 6: 'CUSTOM'
        };
      }
      if (!physical.crsRegistry.has(key)) {
        physical.crsRegistry.set(key, record);
        physical.crsEntityIds.push(this._entityByKey.get(key) ?? 0xFFFFFFFF);
      }
    }

    // ECS binding.
    if (this.ecsWorld && !this._entityByKey.has(key)) {
      const entityId = this.ecsWorld.createEntity?.() ?? 0xFFFFFFFF;
      if (entityId !== 0xFFFFFFFF) {
        this.ecsWorld.addComponent?.(entityId, NormalizedCRSComponent, {
          authority: record.authority,
          kind: record.kind,
          unit: record.unit,
          code: record.code,
          urnHash: record.urnHash,
          uriHash: record.uriHash,
          isGeographic: record.isGeographic ? 1 : 0,
          isProjected: record.isProjected ? 1 : 0,
          isGeocentric: record.isGeocentric ? 1 : 0,
          hasVertical: record.hasVertical ? 1 : 0,
          datumShiftKnown: record.datumShiftKnown ? 1 : 0,
          lastUpdatedTick: tick
        });
        this._entityByKey.set(key, entityId);

        // Patch the physical.crsEntityIds list if it already exists.
        const physical = this.frame?.layers?.physical;
        if (physical?.crsEntityIds) {
          const idx = physical.crsEntityIds.indexOf(0xFFFFFFFF);
          if (idx >= 0) physical.crsEntityIds[idx] = entityId;
          else physical.crsEntityIds.push(entityId);
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  /**
   * Returns the canonical record for an identifier (or null).
   * Does not trigger a parse; only returns already-cached records.
   */
  lookup(identifier) {
    const key = String(identifier ?? '').trim().toLowerCase();
    return this.normalizer._cache.get(key) ?? null;
  }

  /**
   * Returns the ECS entity id for a normalized CRS record, or 0xFFFFFFFF.
   */
  getEntityId(record) {
    if (!record) return 0xFFFFFFFF;
    return this._entityByKey.get(`${record.authority}:${record.code}`) ?? 0xFFFFFFFF;
  }

  /**
   * Returns the number of registered CRS records.
   */
  get size() {
    return this._entityByKey.size;
  }

  /**
   * Returns statistics from the underlying normalizer.
   */
  getStats() {
    return {
      ...this.normalizer.stats,
      cacheSize: this.normalizer.cacheSize,
      registeredEntities: this._entityByKey.size
    };
  }

  dispose() {
    this.normalizer?.dispose?.();
    this._entityByKey.clear();
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 8. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a TerrainNormalizeCRSIdentifier provider with sensible defaults.
 */
export function createTerrainNormalizeCRSIdentifier(options = {}) {
  return new TerrainNormalizeCRSIdentifier({
    targetHz: options.targetHz ?? 1,
    maxCacheSize: options.maxCacheSize ?? 1024,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 9. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainNormalizeCRSIdentifier,
  CRSIdentifierNormalizer,
  CRSIdentifierParser,
  NormalizedCRS,
  NormalizedCRSComponent,
  CRSAuthority,
  CRSKind,
  CRSUnit,
  createTerrainNormalizeCRSIdentifier
};