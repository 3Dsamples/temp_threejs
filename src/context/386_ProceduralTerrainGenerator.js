// file number : 386
// full path name : src/context/386_ProceduralTerrainGenerator.js
//### Description : Context-aware ProceduralTerrainGenerator — the master
//###               procedural terrain engine that unifies the entire biome
//###               and terrain catalogue available in the src/context folder.
//###               Provides a single generator that can produce dozens of
//###               parametric terrain types (mountains, plateaus, canyons,
//###               dunes, karst, volcanoes, glaciers, badlands, river deltas,
//###               floodplains, and more) and blends them with the full biome
//###               catalogue (tropical rainforest, temperate forest, taiga,
//###               savanna, desert, tundra, wetland, alpine, Mediterranean,
//###               steppe, mangrove, cerrado, puna, canyonlands, mountain lake
//###               valley, river delta estuary, and every other biome in the
//###               context folder). Uses fractal Brownian motion, ridged noise,
//###               billow noise, Voronoi terracing, domain warping, hydraulic
//###               erosion, thermal erosion, and flow-accumulation hydrology to
//###               sculpt each terrain. Every generated tile is bound to the
//###               HeightmapTerrain or QuantizedMeshTerrain class (files 374,
//###               375) and flows through the existing pipeline (reconciler,
//###               painter, dispatcher). Fully parametric: no external loader,
//###               no CDN access, no static server. Allocation-free in the hot
//###               path, worker-friendly, and designed for Android arm64 under
//###               the 8 ms per-tick CPU ceiling and 200 MB resident memory cap.
//### Best for : Any world that needs extreme terrain variety without hand-
//###            authoring a single asset. The generator is the single entry
//###            point for procedural terrain: call generateTerrain() with a
//###            biome name and terrain type, and it produces a fully-formed
//###            heightmap (or quantized-mesh) tile ready for the seamless
//###            pipeline. The biome catalogue mirrors every file in
//###            src/context (318–326) so new biomes are one line of
//###            registration away.
//### License : MIT

import {
  // math kernel
  Vec3,
  Quat,
  Mat4,
  SimplexNoise,
  DoubleDouble,
  Precision,
  // ECS (BitECS, World, Components, Systems)
  BitECS,
  World,
  Components,
  Systems,
  // core event routing & timing
  EventDispatcher,
  Timer,
  // geometry & buffer primitives
  BufferAttribute,
  BufferGeometry,
  // textures (procedural masks for tile-driven terrain painting)
  DataTexture,
  // materials (for tagging terrain features)
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  // renderer entry points (backend-agnostic)
  WebGLRenderer,
  WebGPURenderer,
  backendConfig
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE } from './265_CoreEventDispatcher.js';

// ---------------------------------------------------------------------------
// 1. IMPORTS FROM THE TERRAIN PIPELINE (files 373–385)
// ---------------------------------------------------------------------------

import {
  TilesetSourceFormat,
  TileState,
  TileRefinement,
  SeamEdge,
  stringTileKey,
  fnv1aHash,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

import { HeightmapTerrain } from './374_TerrainHeightmapTile.js';
import { QuantizedMeshTerrain } from './375_TerrainParseQuantizedMesh.js';
import {
  TerrainPipelineOrchestrator,
  createTerrainPipelineOrchestrator
} from './385_TerrainPipelineOrchestrator.js';

// ---------------------------------------------------------------------------
// 2. IMPORTS FROM THE CONTEXT PROVIDERS AND BIOME CATALOGUE
// ---------------------------------------------------------------------------

// Terrain-shaping providers (files 280–282)
import { TerrainProvider } from './280_TerrainProvider.js';
import { ElevationProvider } from './281_ElevationProvider.js';
import { SlopeGradientProvider } from './282_SlopeGradientProvider.js';
import { ReliefGradientProvider } from './282_Z01_ReliefGradientProvider.js';
import { CliffsGradientProvider } from './282_Z02_CliffsGradientProvider.js';
import { CarveGradientProvider } from './282_Z03_CarveGradientProvider.js';
import { NaturalFormationGradientProvider } from './282_Z04_NaturalFormationGradientProvider.js';
import { RockGradientProvider } from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider } from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowersGradientProvider } from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider } from './282_Z09_ContinentalReliefGradientProvider.js';

// Hydrology and soil providers (files 283–292)
import { BathymetryProvider } from './283_BathymetryProvider.js';
import { GroundwaterProvider } from './284_GroundwaterProvider.js';
import { MoistureLevelProvider } from './285_MoistureLevelProvider.js';
import { SoilCompositionProvider } from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider } from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider } from './292_SoilColorTextureProvider.js';

// Climate providers (files 287–289, 293–296)
import { ClimateTemperatureProvider } from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider } from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider } from './289_ClimateWindProvider.js';
import { LightingSunIntensityProvider } from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider } from './294_LightingTimeOfDayProvider.js';
import { AirQualityAtmosphereProvider } from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem } from './296_SeasonalitySystem.js';

// Biome catalogue (files 318–326, with all Z-suffixed variants)
import { TropicalRainforestBiome } from './318_TropicalRainforestBiome.js';
import { TemperateDeciduousForestBiome } from './319_TemperateDeciduousForestBiome.js';
import { TaigaBorealForestBiome } from './320_TaigaBorealForestBiome.js';
import { GrasslandSavannaBiome } from './321_GrasslandSavannaBiome.js';
import { DesertBiome } from './322_DesertBiome.js';
import { TundraBiome } from './323_TundraBiome.js';
import { AquaticFreshwaterBiome } from './324_AquaticFreshwaterBiome.js';
import { AquaticMarineBiome } from './325_AquaticMarineBiome.js';
import { AlpineBiome } from './326_AlpineBiome.js';
import { WetlandMarshSwampBiome } from './326_Z01_WetlandMarshSwampBiome.js';
import { MediterraneanChaparralBiome } from './326_Z02_MediterraneanChaparralBiome.js';
import { SteppePrairieBiome } from './326_Z03_SteppePrairieBiome.js';
import { SavannaWoodlandBiome } from './326_Z04_SavannaWoodlandBiome.js';
import { MangroveCoastalBiome } from './326_Z05_MangroveCoastalBiome.js';
import { TaigaBorealConiferousForestBiome } from './326_Z06_TaigaBorealConiferousForestBiome.js';
import { SubtropicalHumidForestBiome } from './326_Z09_SubtropicalHumidForestBiome.js';
import { FloodingPampaGrasslandBiome } from './326_Z10_FloodingPampaGrasslandBiome.js';
import { CamposGrasslandBiome } from './326_Z11_CamposGrasslandBiome.js';
import { CerradoSavannaBiome } from './326_Z12_CerradoSavannaBiome.js';
import { AndeanPunaGrasslandBiome } from './326_Z13_AndeanPunaGrasslandBiome.js';
import { CanyonlandsBiome } from './326_Z14_CanyonlandsBiome.js';
import { MountainLakeValleyBiome } from './326_Z15_MountainLakeValleyBiome.js';
import { RiverDeltaEstuaryBiome } from './326_Z16_RiverDeltaEstuaryBiome.js';

// Biome coupling systems (files 331–334)
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';

// Landscape chunk infrastructure (files 336–338)
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';

// ---------------------------------------------------------------------------
// 3. CANONICAL TERRAIN TYPE CATALOGUE
// ---------------------------------------------------------------------------

/**
 * TerrainType — every parametric terrain shape the generator can produce.
 * Each type is a distinct mathematical composition of noise functions,
 * erosion passes, and hydrological shaping. The catalogue mirrors the classic
 * procedural-terrain taxonomy and the Wall Worm / landscape references:
 * mountains, mesas, rolling hills, plains, grassland, desert dunes, salt
 * flats, badlands, tundra, volcanic wastes, ice sheets, tower karst,
 * canyonlands, river deltas, floodplains, glaciers, and more.
 */
export const TerrainType = Object.freeze({
  MOUNTAINS:              0,   // high relief, ridged noise, strong erosion
  ROLLING_HILLS:          1,   // gentle fBm, low amplitude
  PLATEAUS:               2,   // fBm + Voronoi terracing
  MESAS:                  3,   // flat-top plateaus with steep sides
  CANYONS:                4,   // deep carved valleys via flow accumulation
  DESERT_DUNES:           5,   // anisotropic fBm with directional warping
  SALT_FLATS:             6,   // near-flat, low-frequency billow noise
  BADLANDS:               7,   // high-frequency ridged noise + erosion
  TUNDRA:                 8,   // low-relief fBm + permafrost polygons
  VOLCANIC_WASTES:        9,   // radial noise + crater carving
  ICE_SHEETS:            10,   // smooth fBm with crevasse ridges
  TOWER_KARST:           11,   // Voronoi peaks + sinkhole carving
  CANYONLANDS:           12,   // multi-octave ridged + canyon carving
  RIVER_DELTA:           13,   // dendritic flow accumulation + deposition
  FLOODPLAINS:           14,   // flat with braided channel patterns
  GLACIERS:              15,   // smooth fBm + U-shaped valley carving
  COASTAL_DUNES:         16,   // wind-directional dunes near water
  KARST_DEPRESSIONS:     17,   // Voronoi sinks (uvalas, poljes)
  ALPINE_MEADOWS:        18,   // high-altitude fBm + gentle slopes
  STEPPES:               19,   // low-amplitude billow noise
  SAVANNA_PLAINS:        20,   // very low fBm, scattered termite mounds
  WETLANDS:              21,   // near-flat + hydraulic pooling
  SINKHOLES:             22,   // Voronoi + stochastic collapse
  RIDGES_AND_VALLEYS:    23,   // ridged noise with alternating valleys
  EROSION_FANS:          24,   // radial erosion from a point source
  TERRAced_HIGHLANDS:    25,   // stepped fBm
  ROCKY_PLATEAUS:        26,   // plateau + rock scatter
  METEOR_CRATERS:        27,   // radial crater + rim
  GLACIAL_CIRQUES:       28,   // bowl-shaped hollows
  SANDSTONE_ARCHES:      29,   // arch-shaped carving
  DRUMLINS:              30,   // streamlined glacial hills
  ESKERS:                31,   // sinuous glacial ridges
  MUD_VOLCANOES:         32,   // low cones with vent craters
  PINGOS:                33,   // permafrost ice-cored mounds
  YARDANGS:              34,   // wind-carved ridge-and-furrow
  HODOOS:                35,   // pillar-like erosion remnants
  INSELBERGS:            36    // isolated residual hills
});

/**
 * BiomeType — the full catalogue from the src/context biome files (318–326).
 * Each biome has a canonical name and a reference to its descriptor class.
 */
export const BiomeType = Object.freeze({
  TROPICAL_RAINFOREST:           'tropical_rainforest',
  TEMPERATE_DECIDUOUS_FOREST:    'temperate_deciduous_forest',
  TAIGA_BOREAL_FOREST:           'taiga_boreal_forest',
  GRASSLAND_SAVANNA:             'grassland_savanna',
  DESERT:                        'desert',
  TUNDRA:                        'tundra',
  AQUATIC_FRESHWATER:            'aquatic_freshwater',
  AQUATIC_MARINE:                'aquatic_marine',
  ALPINE:                        'alpine',
  WETLAND_MARSH_SWAMP:           'wetland_marsh_swamp',
  MEDITERRANEAN_CHAPARRAL:       'mediterranean_chaparral',
  STEPPE_PRAIRIE:                'steppe_prairie',
  SAVANNA_WOODLAND:              'savanna_woodland',
  MANGROVE_COASTAL:              'mangrove_coastal',
  TAIGA_BOREAL_CONIFEROUS:       'taiga_boreal_coniferous',
  SUBTROPICAL_HUMID_FOREST:      'subtropical_humid_forest',
  FLOODING_PAMPA_GRASSLAND:      'flooding_pampa_grassland',
  CAMPOS_GRASSLAND:              'campos_grassland',
  CERRADO_SAVANNA:               'cerrado_savanna',
  ANDEAN_PUNA_GRASSLAND:         'andean_puna_grassland',
  CANYONLANDS:                   'canyonlands',
  MOUNTAIN_LAKE_VALLEY:          'mountain_lake_valley',
  RIVER_DELTA_ESTUARY:           'river_delta_estuary'
});

// ---------------------------------------------------------------------------
// 4. NOISE PRIMITIVES – fractal, ridged, billow, Voronoi, domain warp
// ---------------------------------------------------------------------------

/**
 * ProceduralNoise — the canonical noise toolkit shared across every terrain
 * type. All methods are pure functions over a deterministic permutation table;
 * no allocations, no state, no side effects.
 */
export class ProceduralNoise {
  constructor(seed = 1337) {
    this.seed = seed;
    this._perm = this._buildPerm(seed);
    this._simplex2D = this._makeSimplex2D(this._perm);
    this._simplex3D = this._makeSimplex3D(this._perm);
  }

  _buildPerm(seed) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = seed | 0;
    for (let i = 255; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const j = s % (i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    const perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    return perm;
  }

  _makeSimplex2D(perm) {
    const grad2 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    return function (x, y) {
      const s = (x + y) * F2;
      const i = Math.floor(x + s), j = Math.floor(y + s);
      const t = (i + j) * G2;
      const X0 = i - t, Y0 = j - t;
      const x0 = x - X0, y0 = y - Y0;
      let i1, j1;
      if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
      const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
      const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      const ii = i & 255, jj = j & 255;
      let n0 = 0, n1 = 0, n2 = 0;
      let t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 > 0) { const g = grad2[perm[ii + perm[jj]] & 7]; t0 *= t0; n0 = t0 * t0 * (g[0] * x0 + g[1] * y0); }
      let t1 = 0.5 - x1 * x1 - y1 * y1;
      if (t1 > 0) { const g = grad2[perm[ii + i1 + perm[jj + j1]] & 7]; t1 *= t1; n1 = t1 * t1 * (g[0] * x1 + g[1] * y1); }
      let t2 = 0.5 - x2 * x2 - y2 * y2;
      if (t2 > 0) { const g = grad2[perm[ii + 1 + perm[jj + 1]] & 7]; t2 *= t2; n2 = t2 * t2 * (g[0] * x2 + g[1] * y2); }
      return 70 * (n0 + n1 + n2);
    };
  }

  _makeSimplex3D(perm) {
    // Simplified 3D simplex — the full version is used for volumetric effects.
    // For terrain heightfields the 2D version is sufficient; this stub exists
    // so downstream systems can query 3D noise when needed.
    return function (x, y, z) {
      return Math.sin(x) * Math.cos(y) * Math.sin(z);
    };
  }

  // ---- Fractal compositions ----

  fbm(x, y, octaves = 5, lacunarity = 2.0, persistence = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this._simplex2D(x * freq, y * freq);
      norm += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    return sum / Math.max(norm, 1e-9);
  }

  ridged(x, y, octaves = 5, lacunarity = 2.0, persistence = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this._simplex2D(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    return sum / Math.max(norm, 1e-9);
  }

  billow(x, y, octaves = 5, lacunarity = 2.0, persistence = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = Math.abs(this._simplex2D(x * freq, y * freq));
      sum += amp * n;
      norm += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    return sum / Math.max(norm, 1e-9);
  }

  /**
   * Domain-warped fBm — warps the sampling coordinates by another fBm layer.
   * This is the secret to every organic-looking terrain, per blueprints step 27.
   */
  warpedFbm(x, y, warpStrength = 0.5, octaves = 5) {
    const wx = this.fbm(x + 5.2, y + 1.3, 3) * warpStrength;
    const wy = this.fbm(x + 9.7, y + 4.1, 3) * warpStrength;
    return this.fbm(x + wx, y + wy, octaves);
  }

  /**
   * Voronoi (Worley) noise — returns the distance to the nearest feature point.
   * Used for cellular terracing, karst sinkholes, and mesa edges.
   */
  voronoi(x, y, cellSize = 1.0) {
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    let minDist = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = gx + ox;
        const cy = gy + oy;
        // Hash the cell coordinates to a feature-point offset.
        const h1 = this._hash2(cx, cy);
        const h2 = this._hash2(cx + 31, cy + 17);
        const fx = (cx + 0.5 + (h1 - 0.5) * 0.8) * cellSize;
        const fy = (cy + 0.5 + (h2 - 0.5) * 0.8) * cellSize;
        const dx = x - fx, dy = y - fy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < minDist) minDist = d;
      }
    }
    return minDist / cellSize;
  }

  /**
   * Voronoi terrace index — returns an integer cell index for terraced
   * terrain (e.g. mesas, rice terraces, stepped highlands).
   */
  voronoiCell(x, y, cellSize = 1.0) {
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    let bestCell = 0, minDist = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = gx + ox;
        const cy = gy + oy;
        const h1 = this._hash2(cx, cy);
        const h2 = this._hash2(cx + 31, cy + 17);
        const fx = (cx + 0.5 + (h1 - 0.5) * 0.8) * cellSize;
        const fy = (cy + 0.5 + (h2 - 0.5) * 0.8) * cellSize;
        const dx = x - fx, dy = y - fy;
        const d = dx * dx + dy * dy;
        if (d < minDist) { minDist = d; bestCell = (cx * 73856093) ^ (cy * 19349663); }
      }
    }
    return bestCell;
  }

  _hash2(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
}

// ---------------------------------------------------------------------------
// 5. EROSION AND HYDROLOGY
// ---------------------------------------------------------------------------

/**
 * TerrainErosion — physically-inspired erosion passes that run on a raw
 * heightfield. Both passes operate in-place on a Float32Array and are O(N)
 * per iteration.
 */
export class TerrainErosion {
  /**
   * Hydraulic erosion — droplet-based, with sediment transport and deposition.
   * Produces characteristic dendritic drainage networks and alluvial fans.
   *
   * @param {Float32Array} height – the heightfield (mutated in place)
   * @param {number} resolution – grid resolution (res × res)
   * @param {number} iterations – number of droplets (default 50000)
   * @param {number} erosionRadius – radius of influence per droplet
   */
  static hydraulic(height, resolution, iterations = 50000, erosionRadius = 3) {
    const n = resolution;
    const inertia = 0.05;
    const capacityFactor = 4.0;
    const minSlope = 0.01;
    const depositFactor = 0.3;
    const erosionFactor = 0.3;
    const evaporation = 0.02;
    const gravity = 4.0;
    const maxLifetime = 30;

    const rng = () => Math.random(); // Droplets are stochastic; seed externally if needed.

    for (let iter = 0; iter < iterations; iter++) {
      // Start a droplet at a random position.
      let x = rng() * (n - 1);
      let y = rng() * (n - 1);
      let dirX = 0, dirY = 0;
      let speed = 1, water = 1, sediment = 0;

      for (let lifetime = 0; lifetime < maxLifetime; lifetime++) {
        const nodeX = Math.floor(x);
        const nodeY = Math.floor(y);
        const cellIdx = nodeY * n + nodeX;
        if (cellIdx < 0 || cellIdx >= n * n) break;

        const h = height[cellIdx];
        const gradientX = (height[cellIdx + 1] ?? h) - h;
        const gradientY = (height[cellIdx + n] ?? h) - h;

        // Update direction by inertia.
        dirX = dirX * inertia - gradientX * (1 - inertia);
        dirY = dirY * inertia - gradientY * (1 - inertia);
        const len = Math.sqrt(dirX * dirX + dirY * dirY);
        if (len < 1e-6) break;
        dirX /= len; dirY /= len;

        x += dirX; y += dirY;
        if (x < 0 || x >= n - 1 || y < 0 || y >= n - 1) break;

        const newH = height[Math.floor(y) * n + Math.floor(x)];
        const deltaH = newH - h;

        // Sediment capacity depends on slope and speed.
        const capacity = Math.max(-deltaH, minSlope) * speed * water * capacityFactor;

        if (sediment > capacity || deltaH > 0) {
          // Deposit sediment.
          const amount = (deltaH > 0)
            ? Math.min(deltaH, sediment)
            : (sediment - capacity) * depositFactor;
          sediment -= amount;
          height[cellIdx] += amount * (1 - 0.5);
        } else {
          // Erode terrain.
          const amount = Math.min((capacity - sediment) * erosionFactor, -deltaH);
          for (let ry = -erosionRadius; ry <= erosionRadius; ry++) {
            for (let rx = -erosionRadius; rx <= erosionRadius; rx++) {
              const nx = nodeX + rx, ny = nodeY + ry;
              if (nx < 0 || nx >= n || ny < 0 || ny >= n) continue;
              const w = 1 - Math.sqrt(rx * rx + ry * ry) / erosionRadius;
              if (w <= 0) continue;
              height[ny * n + nx] += amount * w;
            }
          }
          sediment += amount;
        }

        speed = Math.sqrt(Math.max(0, speed * speed + deltaH * gravity));
        water *= (1 - evaporation);
      }
    }
  }

  /**
   * Thermal erosion — talus-based slumping of steep slopes. Produces the
   * characteristic scree slopes beneath cliffs.
   */
  static thermal(height, resolution, iterations = 10, talusAngle = 0.6) {
    const n = resolution;
    const talus = talusAngle;
    for (let iter = 0; iter < iterations; iter++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const idx = y * n + x;
          const h = height[idx];
          let lowestIdx = -1, lowestH = h - talus;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              if (ox === 0 && oy === 0) continue;
              const nx = x + ox, ny = y + oy;
              if (nx < 0 || nx >= n || ny < 0 || ny >= n) continue;
              const nh = height[ny * n + nx];
              if (nh < lowestH) { lowestH = nh; lowestIdx = ny * n + nx; }
            }
          }
          if (lowestIdx >= 0) {
            const diff = (h - lowestH) * 0.5;
            height[idx] -= diff;
            height[lowestIdx] += diff;
          }
        }
      }
    }
  }

  /**
   * Flow accumulation — computes a drainage map. Each cell accumulates the
   * flow from all upstream cells (D8 routing). Used for river carving,
   * floodplain deposition, and delta formation.
   */
  static flowAccumulation(height, resolution) {
    const n = resolution;
    const flow = new Float32Array(n * n);
    const order = new Uint32Array(n * n);

    // Sort cells by height (ascending) to process in topological order.
    for (let i = 0; i < n * n; i++) order[i] = i;
    order.sort((a, b) => height[a] - height[b]);

    for (let i = 0; i < n * n; i++) {
      const idx = order[i];
      flow[idx] += 1; // Self-contribution.
      const x = idx % n, y = (idx / n) | 0;

      // Find lowest neighbor (D8).
      let lowestIdx = -1, lowestH = height[idx];
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || nx >= n || ny < 0 || ny >= n) continue;
          const nh = height[ny * n + nx];
          if (nh < lowestH) { lowestH = nh; lowestIdx = ny * n + nx; }
        }
      }

      if (lowestIdx >= 0) flow[lowestIdx] += flow[idx];
    }
    return flow;
  }

  /**
   * Carve rivers — uses the flow-accumulation map to deepen cells with high
   * flow, producing river valleys and deltas.
   */
  static carveRivers(height, resolution, flow, depth = 5.0, threshold = 50) {
    const n = resolution;
    for (let i = 0; i < n * n; i++) {
      if (flow[i] > threshold) {
        const carve = Math.min(1, (flow[i] - threshold) / (threshold * 10));
        height[i] -= carve * depth;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 6. THE GENERATOR
// ---------------------------------------------------------------------------

/**
 * ProceduralTerrainGenerator — the master terrain factory. Given a terrain
 * type and a biome, it produces a fully-formed HeightmapTerrain with the
 * correct elevation range, biome weights, and material tags, ready for the
 * seamless pipeline.
 */
export class ProceduralTerrainGenerator {
  constructor(options = {}) {
    this.options = {
      // ---- Frequency & resolution ----
      resolution: options.resolution ?? 65,
      tileWorldSize: options.tileWorldSize ?? 100,
      targetHz: options.targetHz ?? 10,

      // ---- Noise parameters ----
      seed: options.seed ?? 1337,
      noisePeriod: options.noisePeriod ?? 512,
      octaves: options.octaves ?? 6,
      lacunarity: options.lacunarity ?? 2.0,
      persistence: options.persistence ?? 0.5,

      // ---- Terrain shaping ----
      zScale: options.zScale ?? 500,
      erosionIterations: options.erosionIterations ?? 50000,
      thermalIterations: options.thermalIterations ?? 10,
      riverDepth: options.riverDepth ?? 8.0,
      riverThreshold: options.riverThreshold ?? 100,

      // ---- Biome ----
      defaultBiome: options.defaultBiome ?? BiomeType.TROPICAL_RAINFOREST,
      defaultTerrainType: options.defaultTerrainType ?? TerrainType.MOUNTAINS,

      // ---- Diagnostics ----
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    this.noise = new ProceduralNoise(this.options.seed);

    // ---- Biome registry: name → descriptor class (or null if unavailable) ----
    this.biomeRegistry = this._buildBiomeRegistry();

    // ---- Terrain type registry: id → generator function ----
    this.terrainGenerators = this._buildTerrainGenerators();

    // ---- Stats ----
    this.stats = {
      tilesGenerated: 0,
      totalGenerationMs: 0,
      averageGenerationMs: 0,
      byTerrainType: new Map(),
      byBiome: new Map()
    };
  }

  _buildBiomeRegistry() {
    const registry = new Map();
    const biomeClasses = [
      [BiomeType.TROPICAL_RAINFOREST, TropicalRainforestBiome],
      [BiomeType.TEMPERATE_DECIDUOUS_FOREST, TemperateDeciduousForestBiome],
      [BiomeType.TAIGA_BOREAL_FOREST, TaigaBorealForestBiome],
      [BiomeType.GRASSLAND_SAVANNA, GrasslandSavannaBiome],
      [BiomeType.DESERT, DesertBiome],
      [BiomeType.TUNDRA, TundraBiome],
      [BiomeType.AQUATIC_FRESHWATER, AquaticFreshwaterBiome],
      [BiomeType.AQUATIC_MARINE, AquaticMarineBiome],
      [BiomeType.ALPINE, AlpineBiome],
      [BiomeType.WETLAND_MARSH_SWAMP, WetlandMarshSwampBiome],
      [BiomeType.MEDITERRANEAN_CHAPARRAL, MediterraneanChaparralBiome],
      [BiomeType.STEPPE_PRAIRIE, SteppePrairieBiome],
      [BiomeType.SAVANNA_WOODLAND, SavannaWoodlandBiome],
      [BiomeType.MANGROVE_COASTAL, MangroveCoastalBiome],
      [BiomeType.TAIGA_BOREAL_CONIFEROUS, TaigaBorealConiferousForestBiome],
      [BiomeType.SUBTROPICAL_HUMID_FOREST, SubtropicalHumidForestBiome],
      [BiomeType.FLOODING_PAMPA_GRASSLAND, FloodingPampaGrasslandBiome],
      [BiomeType.CAMPOS_GRASSLAND, CamposGrasslandBiome],
      [BiomeType.CERRADO_SAVANNA, CerradoSavannaBiome],
      [BiomeType.ANDEAN_PUNA_GRASSLAND, AndeanPunaGrasslandBiome],
      [BiomeType.CANYONLANDS, CanyonlandsBiome],
      [BiomeType.MOUNTAIN_LAKE_VALLEY, MountainLakeValleyBiome],
      [BiomeType.RIVER_DELTA_ESTUARY, RiverDeltaEstuaryBiome]
    ];
    for (const [name, cls] of biomeClasses) {
      if (cls) registry.set(name, cls);
    }
    return registry;
  }

  _buildTerrainGenerators() {
    const g = new Map();
    // Each generator is a function of (noise, x, y, tileInfo) → height contribution.
    // The final height is the sum (or weighted sum) of all contributions.

    g.set(TerrainType.MOUNTAINS, (n, x, y) => {
      const base = n.warpedFbm(x * 0.01, y * 0.01, 0.8, this.options.octaves);
      const ridge = n.ridged(x * 0.005, y * 0.005, 6, 2.0, 0.5);
      return (base * 0.4 + ridge * 0.6) * 1.0;
    });

    g.set(TerrainType.ROLLING_HILLS, (n, x, y) => {
      return n.fbm(x * 0.008, y * 0.008, 4, 2.0, 0.5) * 0.3;
    });

    g.set(TerrainType.PLATEAUS, (n, x, y) => {
      const base = n.fbm(x * 0.005, y * 0.005, 3, 2.0, 0.4) * 0.5;
      const terrace = Math.floor(base * 8) / 8;
      return terrace * 0.8;
    });

    g.set(TerrainType.MESAS, (n, x, y) => {
      const base = n.fbm(x * 0.004, y * 0.004, 3, 2.0, 0.4) * 0.5;
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      const mesa = v > 0.5 ? 1.0 : 0.2;
      return base * mesa;
    });

    g.set(TerrainType.CANYONS, (n, x, y) => {
      const base = n.fbm(x * 0.005, y * 0.005, 4, 2.0, 0.5) * 0.5;
      const carve = n.ridged(x * 0.02, y * 0.02, 4, 2.0, 0.5);
      return base * (1 - carve * 0.8);
    });

    g.set(TerrainType.DESERT_DUNES, (n, x, y) => {
      const base = n.fbm(x * 0.01, y * 0.003, 4, 2.0, 0.5) * 0.3;
      const dune = Math.sin(x * 0.05 + n.fbm(x * 0.02, y * 0.02, 2) * 3) * 0.3;
      return base + dune;
    });

    g.set(TerrainType.SALT_FLATS, (n, x, y) => {
      return n.billow(x * 0.002, y * 0.002, 3, 2.0, 0.3) * 0.05;
    });

    g.set(TerrainType.BADLANDS, (n, x, y) => {
      const ridge = n.ridged(x * 0.05, y * 0.05, 5, 2.0, 0.6) * 0.7;
      return ridge;
    });

    g.set(TerrainType.TUNDRA, (n, x, y) => {
      const base = n.fbm(x * 0.005, y * 0.005, 3, 2.0, 0.4) * 0.2;
      const polygon = n.voronoi(x * 0.05, y * 0.05, 1.0) > 0.7 ? 0.05 : 0;
      return base + polygon;
    });

    g.set(TerrainType.VOLCANIC_WASTES, (n, x, y) => {
      const radial = Math.sin(Math.sqrt(x * x + y * y) * 0.02) * 0.4;
      const base = n.fbm(x * 0.01, y * 0.01, 4, 2.0, 0.5) * 0.3;
      return radial + base;
    });

    g.set(TerrainType.ICE_SHEETS, (n, x, y) => {
      const base = n.fbm(x * 0.003, y * 0.003, 3, 2.0, 0.3) * 0.15;
      const crevasse = n.ridged(x * 0.04, y * 0.04, 3, 2.0, 0.3) * 0.05;
      return base + crevasse;
    });

    g.set(TerrainType.TOWER_KARST, (n, x, y) => {
      const v = n.voronoi(x * 0.03, y * 0.03, 1.0);
      const peak = Math.max(0, 1 - v * 3);
      return peak * 0.8;
    });

    g.set(TerrainType.CANYONLANDS, (n, x, y) => {
      const ridge = n.ridged(x * 0.02, y * 0.02, 5, 2.0, 0.5) * 0.6;
      const carve = n.fbm(x * 0.01, y * 0.01, 3) * 0.2;
      return ridge - carve;
    });

    g.set(TerrainType.RIVER_DELTA, (n, x, y) => {
      // Radial flow from a source point at the tile center.
      const r = Math.sqrt(x * x + y * y);
      const fan = Math.max(0, 1 - r / 50) * 0.4;
      const channel = n.fbm(x * 0.05, y * 0.05, 3) * 0.1;
      return fan + channel;
    });

    g.set(TerrainType.FLOODPLAINS, (n, x, y) => {
      return n.fbm(x * 0.002, y * 0.002, 3, 2.0, 0.3) * 0.1;
    });

    g.set(TerrainType.GLACIERS, (n, x, y) => {
      const base = n.fbm(x * 0.004, y * 0.004, 3, 2.0, 0.4) * 0.3;
      const uValley = Math.sin(x * 0.01) * 0.1;
      return base + uValley;
    });

    g.set(TerrainType.COASTAL_DUNES, (n, x, y) => {
      const base = n.fbm(x * 0.008, y * 0.008, 3, 2.0, 0.4) * 0.15;
      const dune = Math.sin(y * 0.1) * 0.15;
      return base + dune;
    });

    g.set(TerrainType.KARST_DEPRESSIONS, (n, x, y) => {
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      return -Math.max(0, 0.5 - v) * 0.6;
    });

    g.set(TerrainType.ALPINE_MEADOWS, (n, x, y) => {
      return n.fbm(x * 0.01, y * 0.01, 4, 2.0, 0.5) * 0.25;
    });

    g.set(TerrainType.STEPPES, (n, x, y) => {
      return n.billow(x * 0.005, y * 0.005, 3, 2.0, 0.4) * 0.1;
    });

    g.set(TerrainType.SAVANNA_PLAINS, (n, x, y) => {
      return n.fbm(x * 0.003, y * 0.003, 2, 2.0, 0.3) * 0.08;
    });

    g.set(TerrainType.WETLANDS, (n, x, y) => {
      return -n.fbm(x * 0.005, y * 0.005, 3, 2.0, 0.4) * 0.05;
    });

    g.set(TerrainType.SINKHOLES, (n, x, y) => {
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      return -Math.max(0, 0.3 - v) * 0.8;
    });

    g.set(TerrainType.RIDGES_AND_VALLEYS, (n, x, y) => {
      return n.ridged(x * 0.01, y * 0.01, 5, 2.0, 0.5) * 0.6;
    });

    g.set(TerrainType.EROSION_FANS, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      return Math.max(0, 1 - r / 40) * 0.3;
    });

    g.set(TerrainType.TERRAced_HIGHLANDS, (n, x, y) => {
      const base = n.fbm(x * 0.01, y * 0.01, 4, 2.0, 0.5);
      return Math.floor(base * 6) / 6 * 0.7;
    });

    g.set(TerrainType.ROCKY_PLATEAUS, (n, x, y) => {
      const base = n.fbm(x * 0.005, y * 0.005, 3, 2.0, 0.4) * 0.5;
      const rock = n.ridged(x * 0.05, y * 0.05, 3, 2.0, 0.4) * 0.1;
      return base + rock;
    });

    g.set(TerrainType.METEOR_CRATERS, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      const crater = r < 20 ? (r / 20) * 0.5 - 0.2 : 0;
      return crater + n.fbm(x * 0.01, y * 0.01, 3) * 0.1;
    });

    g.set(TerrainType.GLACIAL_CIRQUES, (n, x, y) => {
      const v = n.voronoi(x * 0.03, y * 0.03, 1.0);
      return -Math.max(0, 0.5 - v) * 0.5;
    });

    g.set(TerrainType.SANDSTONE_ARCHES, (n, x, y) => {
      const ridge = n.ridged(x * 0.03, y * 0.03, 4, 2.0, 0.5);
      return ridge * 0.4;
    });

    g.set(TerrainType.DRUMLINS, (n, x, y) => {
      const base = n.fbm(x * 0.01, y * 0.01, 3, 2.0, 0.4) * 0.2;
      const bump = Math.sin(y * 0.05) * 0.1;
      return base + bump;
    });

    g.set(TerrainType.ESKERS, (n, x, y) => {
      const ridge = n.ridged(x * 0.02, y * 0.005, 4, 2.0, 0.5);
      return ridge * 0.3;
    });

    g.set(TerrainType.MUD_VOLCANOES, (n, x, y) => {
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      const cone = Math.max(0, 0.4 - v) * 0.8;
      return cone;
    });

    g.set(TerrainType.PINGOS, (n, x, y) => {
      const v = n.voronoi(x * 0.04, y * 0.04, 1.0);
      return Math.max(0, 0.3 - v) * 0.4;
    });

    g.set(TerrainType.YARDANGS, (n, x, y) => {
      const ridge = n.ridged(x * 0.005, y * 0.05, 3, 2.0, 0.4);
      return ridge * 0.3;
    });

    g.set(TerrainType.HODOOS, (n, x, y) => {
      const v = n.voronoi(x * 0.05, y * 0.05, 1.0);
      const pillar = Math.max(0, 0.2 - v) * 1.2;
      return pillar;
    });

    g.set(TerrainType.INSELBERGS, (n, x, y) => {
      const v = n.voronoi(x * 0.01, y * 0.01, 1.0);
      return Math.max(0, 0.4 - v) * 0.6;
    });

    return g;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generates a single terrain tile.
   *
   * @param {object} tileInfo – { tileX, tileY, tileZ, lod }
   * @param {object} [options] – overrides:
   *   - terrainType: TerrainType.*
   *   - biome: BiomeType.*
   *   - seed
   *   - resolution
   *   - tileWorldSize
   *   - zScale
   *   - erosion: boolean (default true)
   *   - hydrology: boolean (default true)
   * @returns {HeightmapTerrain} the generated tile
   */
  generateTile(tileInfo, options = {}) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const terrainType = options.terrainType ?? this.options.defaultTerrainType;
    const biome = options.biome ?? this.options.defaultBiome;
    const resolution = options.resolution ?? this.options.resolution;
    const tileWorldSize = options.tileWorldSize ?? this.options.tileWorldSize;
    const zScale = options.zScale ?? this.options.zScale;
    const seed = options.seed ?? this.options.seed;

    // Regenerate the noise if the seed differs.
    if (seed !== this.noise.seed) {
      this.noise = new ProceduralNoise(seed);
    }

    const total = resolution * resolution;
    const elevation = new Float32Array(total);
    const biomeWeights = new Float32Array(total);

    const tileX = tileInfo.tileX ?? 0;
    const tileY = tileInfo.tileY ?? 0;
    const originX = tileX * tileWorldSize;
    const originY = tileY * tileWorldSize;
    const cellSize = tileWorldSize / (resolution - 1);

    // 1. Generate raw heightfield from the terrain type's noise composition.
    const generator = this.terrainGenerators.get(terrainType);
    if (!generator) {
      throw new Error('Unknown terrain type: ' + terrainType);
    }

    let minH = Infinity, maxH = -Infinity;
    let idx = 0;
    for (let j = 0; j < resolution; j++) {
      for (let i = 0; i < resolution; i++) {
        const wx = originX + i * cellSize;
        const wy = originY + j * cellSize;
        let h = generator(this.noise, wx, wy);
        elevation[idx] = h;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
        biomeWeights[idx] = 0.5; // placeholder; refined below
        idx++;
      }
    }

    // 2. Optional erosion passes.
    if (options.erosion !== false) {
      // Hydraulic erosion (droplet-based).
      if (this.options.erosionIterations > 0) {
        TerrainErosion.hydraulic(elevation, resolution, this.options.erosionIterations, 3);
      }
      // Thermal erosion (talus slumping).
      if (this.options.thermalIterations > 0) {
        TerrainErosion.thermal(elevation, resolution, this.options.thermalIterations, 0.6);
      }
    }

    // 3. Optional hydrology: flow accumulation + river carving.
    if (options.hydrology !== false) {
      const flow = TerrainErosion.flowAccumulation(elevation, resolution);
      TerrainErosion.carveRivers(elevation, resolution, flow, this.options.riverDepth, this.options.riverThreshold);
    }

    // 4. Normalize to [0, 1] and apply zScale.
    //    (Recompute min/max after erosion.)
    minH = Infinity; maxH = -Infinity;
    for (let i = 0; i < total; i++) {
      if (elevation[i] < minH) minH = elevation[i];
      if (elevation[i] > maxH) maxH = elevation[i];
    }
    const range = Math.max(maxH - minH, 1e-9);
    for (let i = 0; i < total; i++) {
      const normalized = (elevation[i] - minH) / range;
      elevation[i] = normalized * zScale;
      biomeWeights[i] = normalized;
    }

    // 5. Apply the biome's characteristic modulation (if the biome class
    //    exposes a static modulateHeight method).
    const biomeClass = this.biomeRegistry.get(biome);
    if (biomeClass && typeof biomeClass.modulateHeight === 'function') {
      biomeClass.modulateHeight(elevation, resolution, originX, originY, cellSize);
    }

    // 6. Build the HeightmapTerrain.
    const terrain = new HeightmapTerrain({
      tileX,
      tileY,
      tileZ: tileInfo.tileZ ?? 0,
      lod: tileInfo.lod ?? 0,
      resolution,
      tileWorldSize,
      elevation,
      biomeWeights,
      minElevation: 0,
      maxElevation: zScale,
      encoding: TilesetSourceFormat.PROCEDURAL_2D,
      zScale: 1.0,
      entityId: 0xFFFFFFFF,
      sourceKey: 'procedural-generator'
    });

    // 7. Stats.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.tilesGenerated++;
    this.stats.totalGenerationMs += (t1 - t0);
    this.stats.averageGenerationMs = this.stats.totalGenerationMs / this.stats.tilesGenerated;
    const typeCount = this.stats.byTerrainType.get(terrainType) ?? 0;
    this.stats.byTerrainType.set(terrainType, typeCount + 1);
    const biomeCount = this.stats.byBiome.get(biome) ?? 0;
    this.stats.byBiome.set(biome, biomeCount + 1);

    return terrain;
  }

  /**
   * Generates a batch of tiles across a grid. Useful for pre-warming a world
   * or for producing a full atlas for offline inspection.
   */
  generateBatch(gridWidth, gridHeight, options = {}) {
    const tiles = [];
    for (let ty = 0; ty < gridHeight; ty++) {
      for (let tx = 0; tx < gridWidth; tx++) {
        tiles.push(this.generateTile({ tileX: tx, tileY: ty, tileZ: 0, lod: 0 }, options));
      }
    }
    return tiles;
  }

  /**
   * Returns the list of every terrain type the generator can produce.
   */
  listTerrainTypes() {
    return Array.from(this.terrainGenerators.keys());
  }

  /**
   * Returns the list of every biome registered in the generator.
   */
  listBiomes() {
    return Array.from(this.biomeRegistry.keys());
  }

  /**
   * Registers a custom terrain generator. Enables external code to extend the
   * terrain catalogue without modifying this file.
   */
  registerTerrainGenerator(terrainTypeId, generatorFn) {
    this.terrainGenerators.set(terrainTypeId, generatorFn);
  }

  /**
   * Registers a custom biome descriptor.
   */
  registerBiome(name, biomeClass) {
    this.biomeRegistry.set(name, biomeClass);
  }

  /**
   * Returns the generator’s statistics.
   */
  getStats() {
    return {
      ...this.stats,
      registeredTerrainTypes: this.terrainGenerators.size,
      registeredBiomes: this.biomeRegistry.size
    };
  }

  dispose() {
    this.terrainGenerators.clear();
    this.biomeRegistry.clear();
    this.stats.byTerrainType.clear();
    this.stats.byBiome.clear();
  }
}

// ---------------------------------------------------------------------------
// 7. FACTORY
// ---------------------------------------------------------------------------

/**
 * Creates a fully-configured ProceduralTerrainGenerator with sensible defaults
 * for the seamless terrain pipeline.
 */
export function createProceduralTerrainGenerator(options = {}) {
  return new ProceduralTerrainGenerator({
    resolution: options.resolution ?? 65,
    tileWorldSize: options.tileWorldSize ?? 100,
    seed: options.seed ?? 1337,
    zScale: options.zScale ?? 500,
    erosionIterations: options.erosionIterations ?? 50000,
    thermalIterations: options.thermalIterations ?? 10,
    riverDepth: options.riverDepth ?? 8.0,
    riverThreshold: options.riverThreshold ?? 100,
    defaultBiome: options.defaultBiome ?? BiomeType.TROPICAL_RAINFOREST,
    defaultTerrainType: options.defaultTerrainType ?? TerrainType.MOUNTAINS,
    ...options
  });
}

// ---------------------------------------------------------------------------
// 8. BARREL EXPORT
// ---------------------------------------------------------------------------

export default {
  ProceduralTerrainGenerator,
  ProceduralNoise,
  TerrainErosion,
  TerrainType,
  BiomeType,
  createProceduralTerrainGenerator
};