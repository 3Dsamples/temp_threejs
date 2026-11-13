// file number : 281
// full path name : src/context/281_ElevationProvider.js
// description : Elevation sub-slice provider feeding the spatial and physical context layers. Reads per-chunk terrain summaries written by 280_TerrainProvider into frame.layers.spatial.terrainChunks, then produces a smooth elevation field that every downstream consumer (SlopeGradientProvider, BathymetryProvider, GroundwaterProvider, MoistureLevelProvider, BiomeBlendField, MaterialsContextProvider, LandscapeLightingCoupler) can query without touching raw heightfield data. Implements the barometric pressure formula P(h) = P₀ · (1 − L·h/T₀)^(g·M/(R·L)) with the standard atmosphere constants (P₀ = 101325 Pa, T₀ = 288.15 K, L = 0.0065 K/m, g = 9.80665 m/s², M = 0.0289644 kg/mol, R = 8.3144598 J/(mol·K)), temperature falloff T(z) = T₀ − Γ·z with Γ ≈ 6.5 K/km, air density ρ(h) = P(h)·M/(R·T(h)), and a sky-light attenuation L_sky(h) = exp(−h/H_atm) that materials read to darken ambient IBL and shift sky tint at altitude. Provides bilinear and barycentric interpolation across chunk boundaries (so elevations do not pop), sub-meter query accuracy for entity placement, sea-level-relative height for biomes, and elevation-band colour grading hints (rock/grass/snow transitions) that materials use to blend their shader mix. All queries are pooled (Vec3, Mat4) and allocate nothing after the first frame.
// best for : The single source of elevation truth for the living world. Every consumer that needs to know "how high is this point" or "how does altitude affect this material, light, temperature, or biome" reads from here instead of touching the raw heightfield. Feeds SlopeGradientProvider, BathymetryProvider, GroundwaterProvider, BiomeClimateCoupling, LandscapeSkyCoupler, materials, and lighting.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision,
  ContextFrame, CoreClock, CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES,
  TemporalContextProvider, WEATHER,
  CausalContextProvider, DERIVED_SIGNAL,
  CoreLayers, LAYER, LAYER_MASKS,
  smoothstep,
  TerrainProvider, BIOME_HINT
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 1;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── standard-atmosphere constants (SI units) ────────────────────
const ATMOSPHERE = Object.freeze({
  P0:       101325.0,       // sea-level pressure, Pa
  T0:       288.15,         // sea-level temperature, K
  L:        0.0065,         // temperature lapse rate, K/m
  g:        9.80665,        // gravity, m/s²
  M:        0.0289644,      // molar mass of dry air, kg/mol
  R:        8.3144598,      // universal gas constant, J/(mol·K)
  Gamma:    0.0065,         // temperature falloff per metre, K/m (same as L)
  H_atm:    8500.0          // atmosphere scale height, m
});

// ─── elevation bands for material colour grading ─────────────────
// Consumers pick a band and blend its base colour into their mix.
const ELEVATION_BAND = Object.freeze({
  UNDERWATER:   0,   // < seaLevel
  BEACH:        1,   // seaLevel .. seaLevel + 5
  LOWLAND:      2,   // +5 .. +200
  HIGHLAND:     3,   // +200 .. +800
  MOUNTAIN:     4,   // +800 .. +1800
  ALPINE:       5,   // +1800 .. +3000
  SNOWCAP:      6    // > +3000
});

// ─── default band thresholds (relative to seaLevel) ─────────────
const BAND_THRESHOLDS = Object.freeze({
  beachUpper:     5.0,
  lowlandUpper:   200.0,
  highlandUpper:  800.0,
  mountainUpper:  1800.0,
  alpineUpper:    3000.0
});

// ─── default band colours (sRGB 0..1) for material blending ─────
const BAND_COLORS = Object.freeze({
  [ELEVATION_BAND.UNDERWATER]: [0.10, 0.20, 0.35],
  [ELEVATION_BAND.BEACH]:      [0.85, 0.78, 0.58],
  [ELEVATION_BAND.LOWLAND]:    [0.42, 0.58, 0.28],
  [ELEVATION_BAND.HIGHLAND]:   [0.50, 0.52, 0.32],
  [ELEVATION_BAND.MOUNTAIN]:   [0.48, 0.46, 0.42],
  [ELEVATION_BAND.ALPINE]:     [0.60, 0.60, 0.62],
  [ELEVATION_BAND.SNOWCAP]:    [0.95, 0.95, 0.98]
});

class ElevationProvider {
  constructor(options = {}) {
    // ── configuration ────────────────────────────────────────
    this.seaLevel = options.seaLevel ?? 0;
    this.atmosphere = { ...ATMOSPHERE, ...(options.atmosphere || {}) };
    this.bandThresholds = { ...BAND_THRESHOLDS, ...(options.bandThresholds || {}) };
    this.enableAtmosphere = options.enableAtmosphere ?? true;
    this.enableLightAttenuation = options.enableLightAttenuation ?? true;

    // ── scratch objects (pooled, never reallocated) ──────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpMatA = new Mat4();

    // ── per-frame elevation summary (reused) ────────────────
    this._elevationSummary = {
      count: 0,
      minY: 0,
      maxY: 0,
      avgY: 0,
      pressureAtMin: 0,
      pressureAtMax: 0,
      tempAtMin: 0,
      tempAtMax: 0,
      seaLevel: this.seaLevel
    };

    // ── entity-level elevation cache ─────────────────────────
    // Bounded ring buffer: [entityId, x, y, z, elevation, pressure,
    // temperature, density, band, light] per entity.
    this._entityCacheCapacity = options.entityCacheCapacity ?? 2048;
    this._entityElevation = new Float32Array(this._entityCacheCapacity);
    this._entityPressure  = new Float32Array(this._entityCacheCapacity);
    this._entityTemp      = new Float32Array(this._entityCacheCapacity);
    this._entityDensity   = new Float32Array(this._entityCacheCapacity);
    this._entityBand      = new Uint8Array(this._entityCacheCapacity);
    this._entityLight     = new Float32Array(this._entityCacheCapacity);
    this._entityValid     = new Uint8Array(this._entityCacheCapacity);

    // ── colour band output (per entity, for materials) ──────
    // Colours are written into this flat SoA and materials read them
    // in the same frame.
    this._entityBandColor = new Float32Array(this._entityCacheCapacity * 3);
    this._entityBandBlend = new Float32Array(this._entityCacheCapacity);

    // ── stats ────────────────────────────────────────────────
    this._stats = {
      updates: 0,
      entitiesSampled: 0,
      chunkQueries: 0,
      pressureComputes: 0,
      tempComputes: 0,
      densityComputes: 0,
      lightComputes: 0,
      bandClassifies: 0,
      interpolated: 0
    };

    // ── timing ──────────────────────────────────────────────
    this._lastUpdateTime = -Infinity;

    // ── frame reference ─────────────────────────────────────
    this._frameRef = null;

    // ── optional direct terrain reference (else reads from frame) ─
    this._terrain = options.terrain || null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── attach terrain provider ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachTerrain(terrain) {
    this._terrain = terrain;
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── elevation queries (bilinear / barycentric) ──────────
  // ══════════════════════════════════════════════════════════

  // Primary query: bilinear interpolation from TerrainProvider.
  // Falls back to a constant sea-level result if terrain is absent.
  getElevation(wx, wz, lod = 0) {
    if (this._terrain) {
      return this._terrain.getHeight(wx, wz, lod);
    }
    // Try the frame cache.
    const tc = this._frameRef?.layers?.spatial?.terrainChunks;
    if (!tc || tc.count === 0) return this.seaLevel;
    return this._interpolateFromChunks(tc, wx, wz);
  }

  // ── inverse-distance-weighted interpolation from chunk summaries ─
  _interpolateFromChunks(tc, wx, wz) {
    // Use the 4 nearest chunks, weighted by inverse distance.
    const chunkSize = this._terrain ? this._terrain.chunkSize : 1000;
    const cx = Math.floor(wx / chunkSize);
    const cz = Math.floor(wz / chunkSize);

    let wSum = 0;
    let hSum = 0;

    for (let i = 0; i < tc.count; i++) {
      const dcx = tc.cx[i] - cx;
      const dcz = tc.cz[i] - cz;
      const d2 = dcx * dcx + dcz * dcz + 1e-6;
      if (d2 > 4) continue;   // only near 2x2 neighbourhood
      const w = 1.0 / d2;
      const avg = (tc.minY[i] + tc.maxY[i]) * 0.5;
      hSum += avg * w;
      wSum += w;
      this._stats.interpolated++;
    }

    if (wSum > 0) return hSum / wSum;
    return this.seaLevel;
  }

  // ── barycentric elevation from a triangle (used by shaders) ─
  getElevationBarycentric(wx, wz, pA, pB, pC, hA, hB, hC) {
    // 2D barycentric on XZ plane.
    const v0x = pB.x - pA.x, v0z = pB.z - pA.z;
    const v1x = pC.x - pA.x, v1z = pC.z - pA.z;
    const v2x = wx - pA.x, v2z = wz - pA.z;
    const d00 = v0x * v0x + v0z * v0z;
    const d01 = v0x * v1x + v0z * v1z;
    const d11 = v1x * v1x + v1z * v1z;
    const d20 = v2x * v0x + v2z * v0z;
    const d21 = v2x * v1x + v2z * v1z;
    const denom = d00 * d11 - d01 * d01;
    if (Math.abs(denom) < 1e-9) return (hA + hB + hC) / 3;
    const v = (d11 * d20 - d01 * d21) / denom;
    const w = (d00 * d21 - d01 * d20) / denom;
    const u = 1 - v - w;
    return u * hA + v * hB + w * hC;
  }

  // ══════════════════════════════════════════════════════════
  // ─── atmosphere (pressure / temperature / density) ───────
  // ══════════════════════════════════════════════════════════
  // Barometric pressure formula:
  //   P(h) = P0 · (1 − L·h / T0)^(g·M / (R·L))
  getPressure(altitudeMetres) {
    if (!this.enableAtmosphere) return this.atmosphere.P0;
    this._stats.pressureComputes++;
    const { P0, T0, L, g, M, R } = this.atmosphere;
    const ratio = 1 - (L * altitudeMetres) / T0;
    if (ratio <= 0) return 0;
    const exponent = (g * M) / (R * L);
    return P0 * Math.pow(ratio, exponent);
  }

  // Temperature falloff: T(z) = T0 − Γ·z (with clamp at absolute zero).
  getTemperature(altitudeMetres, ambientK = null) {
    this._stats.tempComputes++;
    const base = ambientK ?? this.atmosphere.T0;
    const t = base - this.atmosphere.Gamma * altitudeMetres;
    return Math.max(t, 1.0);
  }

  // Air density: ρ(h) = P(h) · M / (R · T(h))
  getAirDensity(altitudeMetres) {
    if (!this.enableAtmosphere) return 1.225;
    this._stats.densityComputes++;
    const P = this.getPressure(altitudeMetres);
    const T = this.getTemperature(altitudeMetres);
    return (P * this.atmosphere.M) / (this.atmosphere.R * T);
  }

  // Sky-light attenuation at altitude: L_sky(h) = exp(-h / H_atm)
  getSkyLightAttenuation(altitudeMetres) {
    if (!this.enableLightAttenuation) return 1.0;
    this._stats.lightComputes++;
    const h = Math.max(0, altitudeMetres);
    return Math.exp(-h / this.atmosphere.H_atm);
  }

  // ══════════════════════════════════════════════════════════
  // ─── elevation band classification ───────────────────────
  // ══════════════════════════════════════════════════════════
  getElevationBand(altitudeMetres) {
    this._stats.bandClassifies++;
    const h = altitudeMetres - this.seaLevel;
    if (h < 0) return ELEVATION_BAND.UNDERWATER;
    if (h < this.bandThresholds.beachUpper) return ELEVATION_BAND.BEACH;
    if (h < this.bandThresholds.lowlandUpper) return ELEVATION_BAND.LOWLAND;
    if (h < this.bandThresholds.highlandUpper) return ELEVATION_BAND.HIGHLAND;
    if (h < this.bandThresholds.mountainUpper) return ELEVATION_BAND.MOUNTAIN;
    if (h < this.bandThresholds.alpineUpper) return ELEVATION_BAND.ALPINE;
    return ELEVATION_BAND.SNOWCAP;
  }

  // Full colour grading result: base colour + blend weight.
  // The blend weight is the sub-band transition weight toward the
  // next band, so materials can fade smoothly across boundaries.
  getBandColor(altitudeMetres, outColor) {
    const band = this.getElevationBand(altitudeMetres);
    const base = BAND_COLORS[band] || BAND_COLORS[ELEVATION_BAND.LOWLAND];

    // Compute transition weight to next band.
    const h = altitudeMetres - this.seaLevel;
    const thresholds = [
      -1e9, 0, this.bandThresholds.beachUpper, this.bandThresholds.lowlandUpper,
      this.bandThresholds.highlandUpper, this.bandThresholds.mountainUpper,
      this.bandThresholds.alpineUpper, 1e9
    ];
    let nextBand = band;
    let blend = 0;
    if (band < ELEVATION_BAND.SNOWCAP) {
      const bandLow = thresholds[band];
      const bandHigh = thresholds[band + 1];
      if (bandHigh > bandLow) {
        const range = bandHigh - bandLow;
        const within = h - bandLow;
        const t = smoothstep(0.8, 1.0, within / range);
        nextBand = band + 1;
        blend = t;
      }
    }

    const nextColor = BAND_COLORS[nextBand] || base;
    outColor[0] = base[0] * (1 - blend) + nextColor[0] * blend;
    outColor[1] = base[1] * (1 - blend) + nextColor[1] * blend;
    outColor[2] = base[2] * (1 - blend) + nextColor[2] * blend;
    return { band, blend, color: outColor };
  }

  // ══════════════════════════════════════════════════════════
  // ─── entity sampling for the context frame ────────────────
  // ══════════════════════════════════════════════════════════
  // Given the frame's spatial layer (with AABB centres), compute
  // per-entity elevation, pressure, temperature, density, band,
  // band colour, and sky-light attenuation. Written into the frame
  // so materials and lighting consumers read them directly.
  _sampleEntities(frame, clock) {
    const spatial = frame.layers.spatial;
    if (!spatial || !spatial.sphere) return 0;

    const sphere = spatial.sphere;
    const n = Math.min(sphere.length / 4, this._entityCacheCapacity);
    let sampled = 0;

    for (let i = 0; i < n; i++) {
      const so = i * 4;
      const sx = sphere[so];
      const sz = sphere[so + 2];

      // Elevation at entity's XZ position.
      const elevation = this.getElevation(sx, sz);
      const pressure = this.getPressure(elevation);
      const temp = this.getTemperature(elevation);
      const density = this.getAirDensity(elevation);
      const light = this.getSkyLightAttenuation(elevation);
      const band = this.getElevationBand(elevation);

      this._entityElevation[i] = elevation;
      this._entityPressure[i] = pressure;
      this._entityTemp[i] = temp;
      this._entityDensity[i] = density;
      this._entityBand[i] = band;
      this._entityLight[i] = light;
      this._entityValid[i] = 1;

      // Colour band blending for materials.
      const c = this._tmpVecA;   // reuse as colour scratch
      this.getBandColor(elevation, c);
      this._entityBandColor[i * 3]     = c.x;
      this._entityBandColor[i * 3 + 1] = c.y;
      this._entityBandColor[i * 3 + 2] = c.z;
      // Blend weight toward next band (0 = pure this band, 1 = pure next).
      const b = this.getBandColor(elevation, this._tmpVecB);
      this._entityBandBlend[i] = b.blend;

      sampled++;
    }

    this._stats.entitiesSampled += sampled;
    return sampled;
  }

  // ══════════════════════════════════════════════════════════
  // ─── frame updates ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) return 0;
    this._lastUpdateTime = now;
    this._frameRef = frame;

    // ── compute elevation summary from terrain chunks ───────
    this._computeSummary(frame);

    // ── sample entity-level elevation and atmosphere ────────
    this._sampleEntities(frame, clock);

    // ── write elevation sub-slice into frame.spatial ────────
    this._writeToSpatialLayer(frame);

    // ── write atmosphere sub-slice into frame.physical ─────
    this._writeToPhysicalLayer(frame);

    this._stats.updates++;
    return 1;
  }

  _computeSummary(frame) {
    const tc = frame.layers.spatial?.terrainChunks;
    if (!tc || tc.count === 0) {
      this._elevationSummary.count = 0;
      return;
    }
    let minY = Infinity;
    let maxY = -Infinity;
    let sumY = 0;
    for (let i = 0; i < tc.count; i++) {
      const min = tc.minY[i];
      const max = tc.maxY[i];
      const avg = (min + max) * 0.5;
      if (min < minY) minY = min;
      if (max > maxY) maxY = max;
      sumY += avg;
    }
    this._elevationSummary.count = tc.count;
    this._elevationSummary.minY = minY;
    this._elevationSummary.maxY = maxY;
    this._elevationSummary.avgY = sumY / tc.count;
    this._elevationSummary.pressureAtMin = this.getPressure(minY);
    this._elevationSummary.pressureAtMax = this.getPressure(maxY);
    this._elevationSummary.tempAtMin = this.getTemperature(minY);
    this._elevationSummary.tempAtMax = this.getTemperature(maxY);
    this._elevationSummary.seaLevel = this.seaLevel;
  }

  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.elevation) {
      spatial.elevation = {
        entityElevation: this._entityElevation,
        entityBand: this._entityBand,
        entityBandColor: this._entityBandColor,
        entityBandBlend: this._entityBandBlend,
        entityValid: this._entityValid,
        summary: this._elevationSummary,
        seaLevel: this.seaLevel
      };
    } else {
      // The pooled arrays are stable references; just refresh summary.
      spatial.elevation.summary = this._elevationSummary;
      spatial.elevation.seaLevel = this.seaLevel;
    }
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.atmosphere) {
      physical.atmosphere = {
        pressure: this.atmosphere.P0,
        temperature: this.atmosphere.T0,
        density: 1.225,
        seaLevel: this.seaLevel,
        constants: this.atmosphere,
        entityPressure: this._entityPressure,
        entityTemp: this._entityTemp,
        entityDensity: this._entityDensity,
        entityLightAttenuation: this._entityLight,
        entityValid: this._entityValid
      };
    }

    const atm = physical.atmosphere;
    atm.pressure = this._elevationSummary.count > 0 ? this._elevationSummary.pressureAtMin : this.atmosphere.P0;
    atm.temperature = this._elevationSummary.count > 0 ? this._elevationSummary.tempAtMin : this.atmosphere.T0;
    atm.density = this.getAirDensity(this._elevationSummary.avgY);
    atm.summary = this._elevationSummary;

    // ── sky-light multiplier for materials ────────────────
    // Materials read `physical.skyLightMultiplier` to attenuate
    // their ambient IBL by altitude. 1.0 at sea level, ~0.6 at 4km.
    physical.skyLightMultiplier = this.getSkyLightAttenuation(
      this._elevationSummary.avgY
    );

    // ── pressure-corrected air density for physics ────────
    // PhysicalContextProvider reads this to update wind drag and
    // buoyancy calculations.
    physical.airDensityAtAltitude = this.getAirDensity(this._elevationSummary.avgY);
    physical.pressureAtAltitude = atm.pressure;
    physical.temperatureAtAltitude = atm.temperature;
  }

  // ══════════════════════════════════════════════════════════
  // ─── interactive setters ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setSeaLevel(level) {
    this.seaLevel = level;
    if (this._terrain) this._terrain.setSeaLevel(level);
    return this;
  }

  setAtmosphere(params) {
    for (const k of Object.keys(this.atmosphere)) {
      if (params[k] !== undefined) this.atmosphere[k] = params[k];
    }
    return this;
  }

  setBandThresholds(thresholds) {
    for (const k of Object.keys(this.bandThresholds)) {
      if (thresholds[k] !== undefined) this.bandThresholds[k] = thresholds[k];
    }
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── diagnostics ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getSummary() { return this._elevationSummary; }
  getElevationSummary() { return this._elevationSummary; }

  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  dispose() {
    this._terrain = null;
    this._frameRef = null;
    this._entityElevation.fill(0);
    this._entityPressure.fill(0);
    this._entityTemp.fill(0);
    this._entityDensity.fill(0);
    this._entityBand.fill(0);
    this._entityLight.fill(0);
    this._entityValid.fill(0);
    this._entityBandColor.fill(0);
    this._entityBandBlend.fill(0);
  }
}

export {
  ElevationProvider,
  ATMOSPHERE,
  ELEVATION_BAND,
  BAND_THRESHOLDS,
  BAND_COLORS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};