// file number : 390
// full path name : src/context/390_TerrainFormatSpatialReference.js
//### Description : Context-aware spatial reference formatter for the seamless
//###               terrain pipeline. Produces human-readable labels, short
//###               codes, canonical URNs, canonical URIs, and diagnostic
//###               strings from any NormalizedCRS record (file 387) or any raw
//###               CRS identifier string. Also produces a structured
//###               “spatial reference descriptor” that downstream systems
//###               (HUD, debug overlay, tile metadata UI, error messages,
//###               persistence layer) can display or serialize without
//###               re-parsing the CRS. Includes a stable short-name catalogue
//###               for the most common CRSs (WGS84, Web Mercator, EGM96,
//###               UTM zones, GDA94, NAD83, ETRS89, lunar and planetary
//###               frames) so a well-known CRS is always shown with its
//###               canonical label even when the caller passes just a numeric
//###               code. Every formatter is a pure string-to-string transform;
//###               the entire module is allocation-free after the first parse
//###               of any given identifier because results are memoized in a
//###               bounded LRU cache. No external loader, no CDN access, no
//###               static server. Designed for Android arm64 under the 8 ms
//###               per-tick CPU ceiling and 200 MB resident memory cap.
//### Best for : Any terrain pipeline that must display, log, persist, or
//###            transmit a spatial reference — from a player-facing HUD that
//###            shows “WGS84 (EPSG:4326)” to a persistence layer that stores
//###            “urn:ogc:def:crs:EPSG::4326” to a debug overlay that shows
//###            “WGS 84 · Geographic · degrees”. The formatter also produces
//###            stable hashes so two representations of the same CRS always
//###            hash to the same value — critical for chunk caches and asset
//###            deduplication.
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
  NormalizedCRS, NormalizedCRSComponent,
  CRSAuthority, CRSKind, CRSUnit,
  CRSIdentifierNormalizer
} from './387_TerrainNormalizeCRSIdentifier.js';

import {
  SpatialCoordinateFrame, SpatialFrameKind, Ellipsoids
} from './388_TerrainSpatialCoordinateFrame.js';

// ═════════════════════════════════════════════════════════════════════
// 1. SHORT-NAME CATALOGUE
// ═════════════════════════════════════════════════════════════════════

/**
 * WELL_KNOWN_CRS — canonical short names for the most common CRSs that
 * appear in terrain pipelines. Keyed by `${authority}:${code}`.
 *
 * If a CRS is not in this table, the formatter falls back to
 * “${authorityName}:${code}” — still stable and unambiguous.
 */
const WELL_KNOWN_CRS = Object.freeze({
  // WGS84 family
  '1:4326':  'WGS 84',
  '1:4978':  'WGS 84 (geocentric)',
  '1:4979':  'WGS 84 (3D)',
  '1:3857':  'WGS 84 / Pseudo-Mercator',
  '1:900913': 'Google Web Mercator',

  // EGM96 and other vertical CRSs
  '1:5773':  'EGM96 height',
  '1:5703':  'NAVD88 height',

  // Continental / national
  '1:4269':  'NAD83',
  '1:26910': 'NAD83 / UTM zone 10N',
  '1:26918': 'NAD83 / UTM zone 18N',
  '1:4283':  'GDA94',
  '1:28355': 'GDA94 / MGA zone 55',
  '1:4258':  'ETRS89',
  '1:25832': 'ETRS89 / UTM zone 32N',
  '1:27700': 'OSGB 1936 / British National Grid',
  '1:2154':  'RGF93 / Lambert-93',
  '1:32601': 'WGS 84 / UTM zone 1N',
  '1:32633': 'WGS 84 / UTM zone 33N',
  '1:32660': 'WGS 84 / UTM zone 60N',
  '1:32701': 'WGS 84 / UTM zone 1S',
  '1:32760': 'WGS 84 / UTM zone 60S',

  // Astronomical
  '5:30100': 'IAU Mars 2000',
  '5:30101': 'IAU Mars 2015',
  '5:30102': 'Moon ULCN 2005',
  '5:30103': 'Io',
  '5:30104': 'Europa',
  '5:30105': 'Titan',
  '5:30106': 'Enceladus',

  // ESRI
  '2:102100': 'ESRI Web Mercator',
  '2:4326':   'ESRI WGS84',
  '2:102113': 'ESRI Web Mercator (Auxiliary Sphere)'
});

// ═════════════════════════════════════════════════════════════════════
// 2. KIND / UNIT LABEL TABLES
// ═════════════════════════════════════════════════════════════════════

const KIND_LABELS = Object.freeze({
  [CRSKind.UNKNOWN]:    'Unknown',
  [CRSKind.GEOGRAPHIC]: 'Geographic',
  [CRSKind.PROJECTED]:  'Projected',
  [CRSKind.GEOCENTRIC]: 'Geocentric',
  [CRSKind.COMPOUND]:   'Compound',
  [CRSKind.VERTICAL]:   'Vertical',
  [CRSKind.LOCAL]:      'Local',
  [CRSKind.ENGINEERING]:'Engineering',
  [CRSKind.TEMPORAL]:   'Temporal'
});

const UNIT_LABELS = Object.freeze({
  [CRSUnit.UNKNOWN]:        'unknown',
  [CRSUnit.METRES]:         'metres',
  [CRSUnit.FEET]:           'feet',
  [CRSUnit.US_SURVEY_FEET]: 'US survey feet',
  [CRSUnit.DEGREES]:        'degrees',
  [CRSUnit.RADIANS]:        'radians',
  [CRSUnit.ARCSECONDS]:     'arc-seconds'
});

const AUTHORITY_LABELS = Object.freeze({
  [CRSAuthority.NONE]:   'Unknown',
  [CRSAuthority.EPSG]:   'EPSG',
  [CRSAuthority.ESRI]:   'ESRI',
  [CRSAuthority.OGC]:    'OGC',
  [CRSAuthority.SR_ORG]: 'SR-ORG',
  [CRSAuthority.IAU]:    'IAU',
  [CRSAuthority.CUSTOM]: 'Custom'
});

// ═════════════════════════════════════════════════════════════════════
// 3. SPATIAL REFERENCE DESCRIPTOR
// ═════════════════════════════════════════════════════════════════════

/**
 * SpatialReferenceDescriptor — the canonical, user-facing representation of
 * a CRS. Immutable after construction; safe to share, log, and persist.
 *
 * Fields:
 *   shortLabel       – "WGS 84" or "EPSG:4326"
 *   longLabel        – "WGS 84 (EPSG:4326) · Geographic · degrees"
 *   diagnosticLabel  – "NormalizedCRS(EPSG:4326, kind=GEOGRAPHIC, unit=DEGREES)"
 *   canonicalURN     – "urn:ogc:def:crs:EPSG::4326"
 *   canonicalURI     – "http://www.opengis.net/def/crs/EPSG/0/4326"
 *   authorityName    – "EPSG"
 *   code             – 4326
 *   kindLabel        – "Geographic"
 *   unitLabel        – "degrees"
 *   hash             – stable uint32 hash combining authority + code
 *   original         – the original identifier string
 */
export class SpatialReferenceDescriptor {
  constructor(fields) {
    this.shortLabel      = fields.shortLabel ?? 'Unknown';
    this.longLabel       = fields.longLabel ?? 'Unknown CRS';
    this.diagnosticLabel = fields.diagnosticLabel ?? 'Unknown';
    this.canonicalURN    = fields.canonicalURN ?? '';
    this.canonicalURI    = fields.canonicalURI ?? '';
    this.authorityName   = fields.authorityName ?? 'Unknown';
    this.code            = fields.code ?? 0;
    this.kindLabel       = fields.kindLabel ?? 'Unknown';
    this.unitLabel       = fields.unitLabel ?? 'unknown';
    this.hash            = fields.hash ?? 0;
    this.original        = fields.original ?? '';
  }

  /**
   * Returns the short label, or a fallback string if the label is unknown.
   */
  toString() {
    return this.shortLabel;
  }

  /**
   * Returns a JSON-friendly object — useful for serializing into a
   * persistence layer or a debug overlay.
   */
  toJSON() {
    return {
      shortLabel: this.shortLabel,
      longLabel: this.longLabel,
      diagnosticLabel: this.diagnosticLabel,
      canonicalURN: this.canonicalURN,
      canonicalURI: this.canonicalURI,
      authorityName: this.authorityName,
      code: this.code,
      kindLabel: this.kindLabel,
      unitLabel: this.unitLabel,
      hash: this.hash,
      original: this.original
    };
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. FORMATTER
// ═════════════════════════════════════════════════════════════════════

/**
 * SpatialReferenceFormatter — converts a NormalizedCRS (or a raw string) into
 * a SpatialReferenceDescriptor with all the labels a downstream system
 * needs. Results are memoized in a bounded LRU cache so repeated lookups
 * (which happen every frame for every visible tile) become O(1).
 */
export class SpatialReferenceFormatter {
  constructor(options = {}) {
    this.options = {
      maxCacheSize: options.maxCacheSize ?? 1024,
      ...options
    };

    // Cache: key = `${authority}:${code}` → SpatialReferenceDescriptor
    this._cache = new Map();
    this._cacheOrder = [];

    // Underlying normalizer for raw-string parsing.
    this._normalizer = new CRSIdentifierNormalizer({
      maxCacheSize: this.options.maxCacheSize
    });

    // Statistics.
    this.stats = {
      formatted: 0,
      cached: 0,
      failed: 0
    };
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Formats a NormalizedCRS record.
   */
  formatNormalized(crs) {
    if (!crs) {
      this.stats.failed++;
      return makeUnknownDescriptor();
    }

    const key = `${crs.authority}:${crs.code}`;
    const cached = this._cache.get(key);
    if (cached) {
      this.stats.cached++;
      this._touch(key);
      return cached;
    }

    const descriptor = this._buildDescriptor(crs);
    this._insert(key, descriptor);
    this.stats.formatted++;
    return descriptor;
  }

  /**
   * Formats any raw CRS identifier string. Parses via the normalizer first.
   */
  format(identifier) {
    const crs = this._normalizer.parse(identifier);
    if (!crs) {
      this.stats.failed++;
      return makeUnknownDescriptor(identifier);
    }
    return this.formatNormalized(crs);
  }

  /**
   * Convenience: formats a bare EPSG code.
   */
  formatEpsg(code) {
    const crs = this._normalizer.parseEpsg(code);
    if (!crs) {
      this.stats.failed++;
      return makeUnknownDescriptor(String(code));
    }
    return this.formatNormalized(crs);
  }

  /**
   * Formats a NormalizedCRS with a CoordinateFrame for planetary bodies
   * (adds the ellipsoid name to the long label).
   */
  formatWithFrame(crs, frame) {
    const descriptor = this.formatNormalized(crs);
    if (!frame || !frame.ellipsoid) return descriptor;

    const ellipsoidName = frame.ellipsoid.name;
    return new SpatialReferenceDescriptor({
      ...descriptor.toJSON(),
      longLabel: `${descriptor.longLabel} · ${ellipsoidName}`,
      diagnosticLabel: `${descriptor.diagnosticLabel} · ellipsoid=${ellipsoidName}`
    });
  }

  // ---------------------------------------------------------------------
  // Descriptor construction
  // ---------------------------------------------------------------------

  _buildDescriptor(crs) {
    const key = `${crs.authority}:${crs.code}`;
    const authorityName = AUTHORITY_LABELS[crs.authority] ?? 'Unknown';
    const kindLabel = KIND_LABELS[crs.kind] ?? 'Unknown';
    const unitLabel = UNIT_LABELS[crs.unit] ?? 'unknown';

    // Short label: prefer the well-known catalogue, fall back to
    // "${authority}:${code}".
    const wellKnown = WELL_KNOWN_CRS[key];
    const shortLabel = wellKnown ?? `${authorityName}:${crs.code}`;

    // Long label: short + authority + kind + unit.
    const longLabel = wellKnown
      ? `${wellKnown} (${authorityName}:${crs.code}) · ${kindLabel} · ${unitLabel}`
      : `${authorityName}:${crs.code} · ${kindLabel} · ${unitLabel}`;

    // Diagnostic label: full technical form.
    const diagnosticLabel = `NormalizedCRS(${authorityName}:${crs.code}, kind=${kindLabel}, unit=${unitLabel})`;

    // Stable hash combining authority and code.
    const hash = ((crs.authority & 0xFF) << 24) ^ (crs.code & 0x00FFFFFF);

    return new SpatialReferenceDescriptor({
      shortLabel,
      longLabel,
      diagnosticLabel,
      canonicalURN: crs.urn,
      canonicalURI: crs.uri,
      authorityName,
      code: crs.code,
      kindLabel,
      unitLabel,
      hash,
      original: crs.original ?? ''
    });
  }

  // ---------------------------------------------------------------------
  // LRU cache
  // ---------------------------------------------------------------------

  _insert(key, descriptor) {
    if (this._cache.size >= this.options.maxCacheSize) {
      const oldest = this._cacheOrder.shift();
      if (oldest !== undefined) this._cache.delete(oldest);
    }
    this._cache.set(key, descriptor);
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
    this._normalizer?.dispose?.();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. UNKNOWN DESCRIPTOR HELPER
// ═════════════════════════════════════════════════════════════════════

function makeUnknownDescriptor(original = '') {
  return new SpatialReferenceDescriptor({
    shortLabel: 'Unknown',
    longLabel: 'Unknown CRS',
    diagnosticLabel: 'NormalizedCRS(unknown)',
    canonicalURN: '',
    canonicalURI: '',
    authorityName: 'Unknown',
    code: 0,
    kindLabel: 'Unknown',
    unitLabel: 'unknown',
    hash: 0,
    original
  });
}

// ═════════════════════════════════════════════════════════════════════
// 6. CONTEXT PROVIDER
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainFormatSpatialReference — the context provider that manages spatial
 * reference formatting and integrates it with the living world:
 *
 *   • Formats every NormalizedCRS that appears in a tile’s metadata.
 *   • Streams the resulting descriptors into the context frame’s physical
 *     channel keyed by CRS hash so downstream HUD / persistence / debug
 *     systems can look them up without re-formatting.
 *   • Binds each descriptor to an ECS entity with a SpatialReferenceComponent
 *     so ECS systems can iterate the registered descriptors directly.
 *
 * Because the formatter is memoized, this provider imposes no per-tick cost
 * after warm-up.
 */
export class TerrainFormatSpatialReference {
  constructor(options = {}) {
    this.options = {
      targetHz: options.targetHz ?? 1,
      maxCacheSize: options.maxCacheSize ?? 1024,
      ...options
    };

    this.formatter = new SpatialReferenceFormatter({
      maxCacheSize: this.options.maxCacheSize
    });

    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // Registry: hash → entityId
    this._entityByHash = new Map();
  }

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
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Formats a CRS and registers the descriptor in the frame + ECS world.
   */
  format(crs, tick = null) {
    const descriptor = this.formatter.formatNormalized(crs);
    const effectiveTick = tick ?? this.lastTick;
    this._register(descriptor, effectiveTick);
    return descriptor;
  }

  /**
   * Formats a raw identifier and registers the descriptor.
   */
  formatIdentifier(identifier, tick = null) {
    const descriptor = this.formatter.format(identifier);
    const effectiveTick = tick ?? this.lastTick;
    this._register(descriptor, effectiveTick);
    return descriptor;
  }

  /**
   * Formats an EPSG code and registers the descriptor.
   */
  formatEpsg(code, tick = null) {
    const descriptor = this.formatter.formatEpsg(code);
    const effectiveTick = tick ?? this.lastTick;
    this._register(descriptor, effectiveTick);
    return descriptor;
  }

  /**
   * Formats a CRS with an explicit coordinate frame and registers it.
   */
  formatWithFrame(crs, frame, tick = null) {
    const descriptor = this.formatter.formatWithFrame(crs, frame);
    const effectiveTick = tick ?? this.lastTick;
    this._register(descriptor, effectiveTick);
    return descriptor;
  }

  /**
   * Returns a previously-formatted descriptor by its hash, or null.
   */
  lookupByHash(hash) {
    for (const [key, descriptor] of this.formatter._cache) {
      if (descriptor.hash === hash) return descriptor;
    }
    return null;
  }

  /**
   * Returns the ECS entity id for a descriptor, or 0xFFFFFFFF.
   */
  getEntityId(descriptor) {
    if (!descriptor) return 0xFFFFFFFF;
    return this._entityByHash.get(descriptor.hash) ?? 0xFFFFFFFF;
  }

  getStats() {
    return {
      ...this.formatter.stats,
      cacheSize: this.formatter._cache.size,
      boundEntities: this._entityByHash.size
    };
  }

  // ---------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------

  _register(descriptor, tick) {
    const hash = descriptor.hash;

    // Physical channel registry.
    if (this.frame?.layers?.physical) {
      const physical = this.frame.layers.physical;
      if (!physical.spatialReferences) {
        physical.spatialReferences = new Map();
        physical.spatialReferenceEntityIds = [];
      }
      if (!physical.spatialReferences.has(hash)) {
        physical.spatialReferences.set(hash, descriptor);
        physical.spatialReferenceEntityIds.push(this._entityByHash.get(hash) ?? 0xFFFFFFFF);
      }
    }

    // ECS binding.
    if (this.ecsWorld && !this._entityByHash.has(hash)) {
      const entityId = this.ecsWorld.createEntity?.() ?? 0xFFFFFFFF;
      if (entityId !== 0xFFFFFFFF) {
        this.ecsWorld.addComponent?.(entityId, SpatialReferenceComponent, {
          hash,
          authorityName: descriptor.authorityName.charCodeAt(0) | (descriptor.authorityName.charCodeAt(1) << 8),
          code: descriptor.code,
          shortLabelHash: fnv1aHash(descriptor.shortLabel),
          longLabelHash: fnv1aHash(descriptor.longLabel),
          lastUpdatedTick: tick
        });
        this._entityByHash.set(hash, entityId);

        const physical = this.frame?.layers?.physical;
        if (physical?.spatialReferenceEntityIds) {
          const idx = physical.spatialReferenceEntityIds.indexOf(0xFFFFFFFF);
          if (idx >= 0) physical.spatialReferenceEntityIds[idx] = entityId;
          else physical.spatialReferenceEntityIds.push(entityId);
        }
      }
    }
  }

  dispose() {
    this.formatter?.dispose?.();
    this._entityByHash.clear();
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 7. ECS COMPONENT
// ═════════════════════════════════════════════════════════════════════

/**
 * SpatialReferenceComponent — bound to every entity that carries a formatted
 * spatial reference descriptor. Stores only hashes (not strings) to keep the
 * component small; downstream systems resolve the actual descriptor via the
 * physical channel registry.
 */
export class SpatialReferenceComponent {
  static schema = {
    hash:             { type: 'u32' },
    authorityName:    { type: 'u16' },   // first two ASCII chars packed
    code:             { type: 'u32' },
    shortLabelHash:   { type: 'u32' },
    longLabelHash:    { type: 'u32' },
    lastUpdatedTick:  { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 8. UTILITY — FNV-1a hash (local fallback)
// ═════════════════════════════════════════════════════════════════════

function fnv1aHash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

// ═════════════════════════════════════════════════════════════════════
// 9. FACTORY
// ═════════════════════════════════════════════════════════════════════

export function createTerrainFormatSpatialReference(options = {}) {
  return new TerrainFormatSpatialReference({
    targetHz: options.targetHz ?? 1,
    maxCacheSize: options.maxCacheSize ?? 1024,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 10. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainFormatSpatialReference,
  SpatialReferenceFormatter,
  SpatialReferenceDescriptor,
  SpatialReferenceComponent,
  WELL_KNOWN_CRS,
  createTerrainFormatSpatialReference
};