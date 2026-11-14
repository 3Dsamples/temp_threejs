// file number : 386_Z02
// full path name : src/context/386_Z02_ProceduralTerrainGenerator_Adv.js
//### Description : Second extension layer for ProceduralTerrainGenerator
//###               (files 386 and 386_Z01). Adds volumetric depth (caves,
//###               subterranean layers), a full river-network builder with
//###               branching and lake filling, tectonic plate and fault-line
//###               simulation, volcanic activity and lava-flow modeling, an
//###               impact-crater system, mineral and ore-deposit markers,
//###               biome transition zones, climate-adaptive terrain modifiers,
//###               context-driven deformation events, advanced scatter with
//###               fractal rock and L-system tree parameterization, a water
//###               table and aquifer model, anisotropic detail passes (wind
//###               streaks and water-flow marks), cavity and ambient-occlusion
//###               map computation, curvature/flow/aspect data layers for
//###               downstream material shading, macro/micro detail lamination,
//###               archaeological and ruin markers, and an LOD-aware fidelity
//###               system that chooses resolution and detail budget per tile.
//###               Composes cleanly on top of 386 and 386_Z01 by registering
//###               every new terrain generator, biome, and pass through the
//###               existing registration API, so the seamless pipeline
//###               (reconciler, painter, dispatcher) sees one unified system.
//###               Fully parametric: no external loader, no CDN access, no
//###               static server. Allocation-free in the hot path,
//###               worker-friendly, and designed for Android arm64 under the
//###               8 ms per-tick CPU ceiling and 200 MB resident memory cap.
//### Best for : Worlds that need geological realism and verticality in
//###            addition to surface variety. Use createAdvancedTerrainGenerator
//###            to get an ExtendedTerrainGenerator instance pre-populated with
//###            every advanced feature, or call
//###            installAdvancedTerrainExtensions on an existing instance to
//###            augment it in place. The advanced layer is optional — the
//###            surface pipeline keeps working unchanged if you skip it.
//### License : MIT

import {
  Vec3,
  Quat,
  Mat4,
  SimplexNoise,
  DoubleDouble,
  Precision,
  BitECS,
  World,
  Components,
  Systems,
  EventDispatcher,
  Timer,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  WebGLRenderer,
  WebGPURenderer,
  backendConfig
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE } from './265_CoreEventDispatcher.js';

import {
  TilesetSourceFormat,
  TileState,
  SeamEdge,
  stringTileKey,
  fnv1aHash
} from './373_Tileset2DTypes.js';

import { HeightmapTerrain } from './374_TerrainHeightmapTile.js';
import { QuantizedMeshTerrain } from './375_TerrainParseQuantizedMesh.js';

import {
  ProceduralTerrainGenerator,
  ProceduralNoise,
  TerrainErosion,
  TerrainType,
  BiomeType,
  createProceduralTerrainGenerator
} from './386_ProceduralTerrainGenerator.js';

import {
  ExtendedTerrainGenerator,
  ExtendedTerrainType,
  ExtendedBiomeType,
  ExtendedErosion,
  ScatterMarkerBuffer,
  ScatterMarkerType,
  HydrologyExtension,
  SeasonalVariantCache,
  installTerrainGeneratorExtensions,
  createExtendedTerrainGenerator
} from './386_Z01_ProceduralTerrainGenerator_Ext.js';

// ---------------------------------------------------------------------------
// 1. ADVANCED TERRAIN TYPE CATALOGUE
// ---------------------------------------------------------------------------

/**
 * AdvancedTerrainType — additional geological and vertical terrain types.
 * IDs start at 100, continuing from the base (0–36) and extended (37–70)
 * catalogues so the three layers never collide.
 */
export const AdvancedTerrainType = Object.freeze({
  VOLCANIC_CALDERA:          100,   // large collapse caldera
  LAVA_TUBES_SURFACE:        101,   // surface expression of lava tubes
  OBSIDIAN_FLOW:             102,   // glassy lava flows
  TUFF_RING_DIATREME:        103,   // maar-diatreme volcanic ring
  SUBMARINE_RIDGE:           104,   // underwater volcanic ridge
  ACCRETIONARY_WEDGE:        105,   // tectonic wedge
  OPHIOLITE_SEQUENCE:        106,   // exposed mantle rock
  FAULT_SCARP:               107,   // fault-line scarp
  HORST_AND_GRABEN:          108,   // tectonic block terrain
  RIFT_VALLEY:               109,   // continental rift
  MID_OCEAN_RIDGE:           110,   // divergent plate boundary
  TRENCH:                    111,   // deep subduction trench
  ARC_VOLCANO_CHAIN:         112,   // volcanic island arc
  FOLD_MOUNTAIN_BELT:        113,   // compressional folding
  THRUST_FAULT_TERRAIN:      114,   // thrust fault terrain
  BASEMENT_UPLIFT:           115,   // exposed crystalline basement
  LACCOLITH_DOME:            116,   // mushroom-shaped intrusion
  SILL_TERRACES:             117,   // horizontal igneous sheets
  VEIN_NETWORK:              118,   // hydrothermal vein system surface
  HYDROTHERMAL_FIELD:        119,   // geyser basin / fumarole field
  MUD_POT_FIELD:             120,   // boiling mud pots
  TRAVERTINE_CASCADE:        121,   // stepped calcium-carbonate cascade
  SNOW_AVALANCHE_GULLY:      122,   // avalanche paths on slope
  ROCK_GLACIER:              123,   // periglacial rock-ice mixture
  DEBRIS_CONE:               124,   // talus / debris cone
  ALLUVIAL_FAN:              125,   // fan-shaped sediment deposit
  DRIED_LAKEBED:             126,   // playa / dried lake
  TERRACED_FARMLAND:         127,   // anthropogenic terraced field
  ANCIENT_CITY_RUINS:        128,   // abandoned settlement terrain
  QUARRY:                    129,   // open-pit quarry
  MINE_TAILINGS:             130,   // mining waste landscape
  CANAL_NETWORK:             131,   // irrigation canal terrain
  PYRAMID_COMPLEX:           132,   // monument on flat plain
  MEGALITH_SITE:             133,   // standing-stones terrain
  ICEBERG_FIELD:             134,   // frozen ocean fragment field
  SUBGLACIAL_LAKE:           135,   // hidden lake surface expression
  KETTLE_HOLE:               136,   // glacial-melt depression
  PARABOLIC_DUNE:            137,   // convex dune (vegetation-anchored)
  LUNAR_MARE:                138,   // dark lava plain (moon/asteroid)
  LUNAR_HIGHLAND:            139,   // bright cratered highland
  MARTIAN_CHAOS:             140,   // fractured plateau chaos terrain
  MARTIAN_POLAR_LAYERED:     141,   // layered polar deposit
  TITAN_METHANE_DELTA:       142,   // hydrocarbon river delta
  ENCELADUS_TIGER_STRIPES:   143,   // parallel fracture stripes
  EUROPA_LINEAE:             144,   // crisscrossing ice fractures
  IO_VOLCANIC_PLAINS:        145,   // sulfur volcanic plains
  TRITON_CANTALOUPE:         146,   // melon-rind terrain
  ASTEROID_RUBBLE_PILE:      147,   // impact rubble terrain
  COMET_NUCLEUS:             148    // comet-shaped terrain
});

// ---------------------------------------------------------------------------
// 2. ADVANCED BIOME CATALOGUE
// ---------------------------------------------------------------------------

/**
 * AdvancedBiomeType — exotic and extraterrestrial biomes. Continues the
 * biome catalogue so downstream material painting and vegetation scatter
 * pick the right descriptors.
 */
export const AdvancedBiomeType = Object.freeze({
  HYDROTHERMAL_VENT:         'hydrothermal_vent',
  HIGH_ALTITUDE_DESERT:      'high_altitude_desert',
  CRYO_VOLCANIC:             'cryo_volcanic',
  SALINE_LAKE:               'saline_lake',
  OKAVANGO_DELTA:            'okavango_delta',
  SOCOTRA_ALIEN:             'socotra_alien',
  ATACAMA_HYPERARID:         'atacama_hyperarid',
  ANTARCTIC_DRY_VALLEY:      'antarctic_dry_valley',
  MCMURDO_SOUND:             'mcmurdo_sound',
  NAMIB_FOG_DESERT:          'namib_fog_desert',
  ARCTIC_TUNDRA_POLYGONS:    'arctic_tundra_polygons',
  LUNAR_MARE_BIOME:          'lunar_mare_biome',
  LUNAR_HIGHLAND_BIOME:      'lunar_highland_biome',
  MARTIAN_POLAR_BIOME:       'martian_polar_biome',
  MARTIAN_DUNE_BIOME:        'martian_dune_biome',
  TITAN_LAKE_BIOME:          'titan_lake_biome',
  EUROPA_ICE_BIOME:          'europa_ice_biome',
  IO_SULFUR_BIOME:           'io_sulfur_biome',
  TRITON_NITROGEN_BIOME:     'triton_nitrogen_biome',
  CARBONACEOUS_ASTEROID:     'carbonaceous_asteroid'
});

// ---------------------------------------------------------------------------
// 3. SUBSURFACE LAYER MODEL
// ---------------------------------------------------------------------------

/**
 * SubsurfaceLayer — a single layer of the vertical geology beneath the
 * surface. Stored as a per-tile array of {depth, hardness, composition,
 * waterYield}. Used by cave and aquifer systems.
 */
export const SubsurfaceComposition = Object.freeze({
  BEDROCK:         0,
  SANDSTONE:       1,
  LIMESTONE:       2,
  SHALE:           3,
  GRANITE:         4,
  BASALT:          5,
  RHYOLITE:        6,
  SALT:            7,
  GYPSUM:          8,
  COAL:            9,
  ORE_BEARING:    10,
  AQUIFER:        11,
  WATER_TABLE:    12,
  MAGMA_CHAMBER:  13,
  LAVA_TUBE:      14,
  CRYSTALLINE:    15
});

export class SubsurfaceLayer {
  constructor(props) {
    this.depthTop = props.depthTop ?? 0;
    this.depthBottom = props.depthBottom ?? 10;
    this.composition = props.composition ?? SubsurfaceComposition.BEDROCK;
    this.hardness = props.hardness ?? 0.8;
    this.permeability = props.permeability ?? 0.1;
    this.waterYield = props.waterYield ?? 0;
    this.caveProbability = props.caveProbability ?? 0;
  }
}

/**
 * SubsurfaceColumn — the vertical stratigraphy at a single surface point.
 * Stored per-tile in a structure-of-arrays buffer for O(1) access.
 */
export class SubsurfaceColumn {
  constructor(maxLayers = 8) {
    this.maxLayers = maxLayers;
    this.count = 0;
    this.layers = new Array(maxLayers);
    for (let i = 0; i < maxLayers; i++) {
      this.layers[i] = new SubsurfaceLayer({});
    }
  }

  reset() { this.count = 0; }

  addLayer(depthTop, depthBottom, composition, hardness, permeability, waterYield, caveProbability) {
    if (this.count >= this.maxLayers) return;
    const l = this.layers[this.count++];
    l.depthTop = depthTop;
    l.depthBottom = depthBottom;
    l.composition = composition;
    l.hardness = hardness;
    l.permeability = permeability;
    l.waterYield = waterYield;
    l.caveProbability = caveProbability;
  }

  getLayerAtDepth(depth) {
    for (let i = 0; i < this.count; i++) {
      const l = this.layers[i];
      if (depth >= l.depthTop && depth < l.depthBottom) return l;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. RIVER NETWORK BUILDER
// ---------------------------------------------------------------------------

/**
 * RiverNetworkBuilder — constructs a full river network with branching,
 * width classes, and lake filling. Runs on the flow-accumulation map and
 * produces a SoA river-segment list for downstream rendering and the
 * water shader.
 */
export class RiverNetworkBuilder {
  /**
   * Builds the river network from a heightfield.
   *
   * @param {Float32Array} height
   * @param {number} resolution
   * @param {Float32Array} flow – flow-accumulation map
   * @param {number} tileX
   * @param {number} tileY
   * @param {number} lod
   * @param {object} options
   * @returns {object} river network SoA
   */
  static build(height, resolution, flow, tileX, tileY, lod, options = {}) {
    const threshold = options.flowThreshold ?? 200;
    const n = resolution;
    const cellSize = options.cellSize ?? 100 / (resolution - 1);
    const originX = tileX * (options.tileWorldSize ?? 100);
    const originY = tileY * (options.tileWorldSize ?? 100);

    // Segment storage.
    const segStartX = [];
    const segStartY = [];
    const segEndX = [];
    const segEndY = [];
    const segWidth = [];
    const segFlow = [];
    const segOrder = []; // Strahler-like stream order (1 = headwater)

    // Build a directed graph: each cell flows to its lowest neighbor.
    const downstream = new Int32Array(n * n).fill(-1);
    const streamOrder = new Uint8Array(n * n);

    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const idx = y * n + x;
        let lowestIdx = -1;
        let lowestH = height[idx];
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = x + ox, ny = y + oy;
            if (nx < 0 || nx >= n || ny < 0 || ny >= n) continue;
            const nidx = ny * n + nx;
            if (height[nidx] < lowestH) {
              lowestH = height[nidx];
              lowestIdx = nidx;
            }
          }
        }
        downstream[idx] = lowestIdx;
      }
    }

    // Compute Strahler order bottom-up: process cells by descending flow.
    const order = new Uint32Array(n * n);
    for (let i = 0; i < n * n; i++) order[i] = i;
    order.sort((a, b) => flow[b] - flow[a]);

    // Headwaters start at order 1.
    for (let i = 0; i < n * n; i++) streamOrder[i] = flow[i] > threshold ? 1 : 0;

    // Propagate order downstream (two passes for stability).
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n * n; i++) {
        const idx = order[i];
        const down = downstream[idx];
        if (down < 0) continue;
        if (streamOrder[idx] > streamOrder[down]) {
          streamOrder[down] = streamOrder[idx];
        } else if (streamOrder[idx] === streamOrder[down] &&
                   streamOrder[idx] > 0 &&
                   flow[idx] > flow[down]) {
          streamOrder[down] = streamOrder[idx] + 1;
        }
      }
    }

    // Emit segments.
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const idx = y * n + x;
        if (streamOrder[idx] === 0) continue;
        const down = downstream[idx];
        if (down < 0) continue;

        const downX = down % n;
        const downY = (down / n) | 0;

        // Convert cell coordinates to world coordinates.
        const sx = originX + (x / (n - 1)) * (options.tileWorldSize ?? 100);
        const sy = originY + (y / (n - 1)) * (options.tileWorldSize ?? 100);
        const ex = originX + (downX / (n - 1)) * (options.tileWorldSize ?? 100);
        const ey = originY + (downY / (n - 1)) * (options.tileWorldSize ?? 100);

        // Width scales with flow and order.
        const fw = Math.min(1, flow[idx] / (threshold * 5));
        const width = 0.5 + fw * 8 + streamOrder[idx] * 0.5;

        segStartX.push(sx);
        segStartY.push(sy);
        segEndX.push(ex);
        segEndY.push(ey);
        segWidth.push(width);
        segFlow.push(flow[idx]);
        segOrder.push(streamOrder[idx]);
      }
    }

    return {
      segmentCount: segStartX.length,
      startX: new Float32Array(segStartX),
      startY: new Float32Array(segStartY),
      endX: new Float32Array(segEndX),
      endY: new Float32Array(segEndY),
      width: new Float32Array(segWidth),
      flow: new Float32Array(segFlow),
      order: new Uint8Array(segOrder),
      tileX, tileY, lod
    };
  }

  /**
   * Fills lakes by finding local minima and raising the terrain to the
   * spillover level. Produces a lake mask and an updated heightfield.
   */
  static fillLakes(height, resolution, flow, options = {}) {
    const n = resolution;
    const minFlowForLake = options.minFlowForLake ?? 300;
    const lakeMask = new Uint8Array(n * n);

    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const idx = y * n + x;
        if (flow[idx] < minFlowForLake) continue;

        // Local minimum check.
        const h = height[idx];
        let isMin = true;
        let spillLevel = Infinity;
        for (let oy = -1; oy <= 1 && isMin; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nh = height[(y + oy) * n + (x + ox)];
            if (nh < h) { isMin = false; break; }
            if (nh < spillLevel) spillLevel = nh;
          }
        }

        if (isMin && spillLevel < h + 20) {
          // Fill the depression to the spill level.
          lakeMask[idx] = 1;
          height[idx] = spillLevel;
        }
      }
    }

    return lakeMask;
  }
}

// ---------------------------------------------------------------------------
// 5. TECTONIC PLATE SIMULATOR
// ---------------------------------------------------------------------------

/**
 * TectonicPlateSimulator — generates plate boundaries, fault lines, and
 * tectonic stresses that influence the base terrain. Useful for large-scale
 * realism where mountain ranges, trenches, and rift valleys must align
 * geographically.
 */
export class TectonicPlateSimulator {
  constructor(seed = 1337, plateCount = 12) {
    this.seed = seed;
    this.plateCount = plateCount;
    this.noise = new ProceduralNoise(seed + 91);
    this.plates = this._generatePlates();
  }

  _generatePlates() {
    // Distribute plate seeds using a low-discrepancy sequence.
    const plates = [];
    const phi = (1 + Math.sqrt(5)) / 2;
    for (let i = 0; i < this.plateCount; i++) {
      const angle = i * 2 * Math.PI / phi;
      const radius = Math.sqrt(i / this.plateCount) * 1000;
      plates.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        // Plate velocity derived from the seed.
        vx: this.noise.fbm(i * 0.1, 0.5, 3) * 2,
        vy: this.noise.fbm(0.5, i * 0.1, 3) * 2,
        type: i % 2 === 0 ? 'continental' : 'oceanic'
      });
    }
    return plates;
  }

  /**
   * Computes the distance to the nearest plate boundary at a world position.
   * Returns { distance, plateIndexA, plateIndexB, boundaryType }.
   */
  boundaryAt(wx, wy) {
    // Find the two nearest plate seeds.
    let nearestA = -1, nearestB = -1;
    let distA = Infinity, distB = Infinity;
    for (let i = 0; i < this.plates.length; i++) {
      const p = this.plates[i];
      const d = Math.sqrt((p.x - wx) ** 2 + (p.y - wy) ** 2);
      if (d < distA) { distB = distA; nearestB = nearestA; distA = d; nearestA = i; }
      else if (d < distB) { distB = d; nearestB = i; }
    }
    if (nearestB < 0) return { distance: 99999, plateIndexA: nearestA, plateIndexB: -1, boundaryType: 'none' };

    // Boundary distance = |distA - distB| (Voronoi boundary).
    const distance = Math.abs(distA - distB);

    const a = this.plates[nearestA];
    const b = this.plates[nearestB];
    const dx = b.vx - a.vx;
    const dy = b.vy - a.vy;

    // Determine boundary type from relative motion and plate type.
    let boundaryType = 'none';
    if (distance < 100) {
      if (a.type === 'continental' && b.type === 'continental') {
        boundaryType = Math.abs(dx) > Math.abs(dy) ? 'transform' : 'convergent';
      } else if (a.type === 'oceanic' && b.type === 'oceanic') {
        boundaryType = 'divergent';
      } else {
        boundaryType = 'subduction';
      }
    }
    return { distance, plateIndexA: nearestA, plateIndexB: nearestB, boundaryType };
  }

  /**
   * Modifies a heightfield by adding tectonic uplift or subsidence near
   * plate boundaries. Call this before the surface generator for realistic
   * mountain placement.
   */
  applyTectonicModification(height, resolution, tileWorldSize, tileX, tileY) {
    const n = resolution;
    const originX = tileX * tileWorldSize;
    const originY = tileY * tileWorldSize;
    const cellSize = tileWorldSize / (n - 1);

    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const wx = originX + x * cellSize;
        const wy = originY + y * cellSize;
        const b = this.boundaryAt(wx, wy);
        if (b.boundaryType === 'none') continue;

        const idx = y * n + x;
        const influence = Math.max(0, 1 - b.distance / 100);

        switch (b.boundaryType) {
          case 'convergent':
          case 'subduction':
            // Uplift — mountains rise at compressional boundaries.
            height[idx] += influence * 0.4;
            break;
          case 'divergent':
            // Subsidence — rift valleys sink at extensional boundaries.
            height[idx] -= influence * 0.15;
            break;
          case 'transform':
            // Offset — introduce a shear displacement (approximated as
            // a height discontinuity along the fault line).
            height[idx] += Math.sin(wy * 0.1) * influence * 0.1;
            break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 6. VOLCANIC ACTIVITY SIMULATOR
// ---------------------------------------------------------------------------

/**
 * VolcanicActivitySimulator — places volcanoes and simulates lava flows.
 * Produces a volcanic feature list and a lava mask for material painting.
 */
export class VolcanicActivitySimulator {
  constructor(seed = 1337) {
    this.seed = seed;
    this.noise = new ProceduralNoise(seed + 37);
  }

  /**
   * Places volcanoes across a world position range using a Poisson-disk
   * sampling approximation over the noise field.
   */
  placeVolcanoes(gridWidth, gridHeight, tileWorldSize, density = 0.02) {
    const volcanoes = [];
    for (let ty = 0; ty < gridHeight; ty++) {
      for (let tx = 0; tx < gridWidth; tx++) {
        const hash = this.noise.fbm(tx * 0.31, ty * 0.31, 4);
        if (hash > 1 - density) {
          volcanoes.push({
            x: tx * tileWorldSize + this.noise.fbm(tx * 0.1, ty * 0.1, 3) * 0.5 * tileWorldSize,
            y: ty * tileWorldSize + this.noise.fbm(tx * 0.1 + 10, ty * 0.1 + 10, 3) * 0.5 * tileWorldSize,
            radius: 200 + this.noise.fbm(tx * 0.2, ty * 0.2, 3) * 400,
            height: 300 + this.noise.fbm(tx * 0.4, ty * 0.4, 3) * 600,
            active: this.noise.fbm(tx * 0.5, ty * 0.5, 3) > 0.3
          });
        }
      }
    }
    return volcanoes;
  }

  /**
   * Adds volcano cone and lava flow shapes to a heightfield.
   */
  applyVolcanoes(height, resolution, tileWorldSize, tileX, tileY, volcanoes) {
    const n = resolution;
    const originX = tileX * tileWorldSize;
    const originY = tileY * tileWorldSize;
    const cellSize = tileWorldSize / (n - 1);

    for (const v of volcanoes) {
      // Quick bounding-box check.
      if (v.x + v.radius < originX || v.x - v.radius > originX + tileWorldSize) continue;
      if (v.y + v.radius < originY || v.y - v.radius > originY + tileWorldSize) continue;

      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const wx = originX + x * cellSize;
          const wy = originY + y * cellSize;
          const dx = wx - v.x;
          const dy = wy - v.y;
          const d = Math.sqrt(dx * dx + dy * dy);

          if (d < v.radius) {
            const t = 1 - d / v.radius;
            const cone = Math.pow(t, 1.5) * v.height;

            // Crater depression.
            const crater = d < v.radius * 0.1 ? -v.height * 0.3 * (1 - d / (v.radius * 0.1)) : 0;

            // Lava channels from the crater.
            if (v.active && d > v.radius * 0.1 && d < v.radius) {
              const angle = Math.atan2(dy, dx);
              const channel = Math.abs(Math.sin(angle * 6)) > 0.85 ? -cone * 0.2 : 0;
              height[y * n + x] += channel;
            }

            height[y * n + x] += cone + crater;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 7. IMPACT CRATER SYSTEM
// ---------------------------------------------------------------------------

/**
 * ImpactCraterSystem — places impact craters at random locations and applies
 * their bowl+rim profile to the heightfield. Works both for terrestrial
 * meteorite craters and for lunar/martian surfaces.
 */
export class ImpactCraterSystem {
  constructor(seed = 1337) {
    this.seed = seed;
    this.noise = new ProceduralNoise(seed + 71);
  }

  /**
   * Generates craters at a given world region.
   */
  generateCraters(gridWidth, gridHeight, tileWorldSize, density = 0.03) {
    const craters = [];
    for (let ty = 0; ty < gridHeight; ty++) {
      for (let tx = 0; tx < gridWidth; tx++) {
        const hash = this.noise.fbm(tx * 0.47, ty * 0.47, 4);
        if (hash > 1 - density) {
          const radius = 20 + this.noise.fbm(tx * 0.3, ty * 0.3, 3) * 200;
          craters.push({
            x: tx * tileWorldSize + this.noise.fbm(tx * 0.1, ty * 0.1, 3) * 0.5 * tileWorldSize,
            y: ty * tileWorldSize + this.noise.fbm(tx * 0.1 + 10, ty * 0.1 + 10, 3) * 0.5 * tileWorldSize,
            radius,
            depth: radius * 0.2,
            rimHeight: radius * 0.05,
            age: this.noise.fbm(tx * 0.6, ty * 0.6, 3)
          });
        }
      }
    }
    return craters;
  }

  /**
   * Applies crater bowl + rim profiles to a heightfield.
   */
  applyCraters(height, resolution, tileWorldSize, tileX, tileY, craters) {
    const n = resolution;
    const originX = tileX * tileWorldSize;
    const originY = tileY * tileWorldSize;
    const cellSize = tileWorldSize / (n - 1);

    for (const c of craters) {
      if (c.x + c.radius < originX || c.x - c.radius > originX + tileWorldSize) continue;
      if (c.y + c.radius < originY || c.y - c.radius > originY + tileWorldSize) continue;

      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const wx = originX + x * cellSize;
          const wy = originY + y * cellSize;
          const dx = wx - c.x;
          const dy = wy - c.y;
          const d = Math.sqrt(dx * dx + dy * dy);

          if (d > c.radius * 1.5) continue;

          const t = d / c.radius;
          let profile = 0;

          if (t < 1) {
            // Bowl interior.
            profile = -c.depth * (1 - t * t);
          } else if (t < 1.5) {
            // Rim region.
            const rimT = (t - 1) / 0.5;
            profile = c.rimHeight * (1 - rimT);
          }

          // Age: older craters are more eroded.
          const ageFactor = Math.max(0.3, 1 - c.age);
          height[y * n + x] += profile * ageFactor;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 8. MINERAL AND ORE DEPOSIT MARKERS
// ---------------------------------------------------------------------------

/**
 * MineralDepositSystem — determines where ore bodies, gems, and other
 * economic minerals are located. Markers feed into downstream mining,
 * economy, and player-interaction systems.
 */
export const MineralType = Object.freeze({
  IRON:        0,
  COPPER:      1,
  GOLD:        2,
  SILVER:      3,
  COAL:        4,
  DIAMOND:     5,
  RUBY:        6,
  SAPPHIRE:    7,
  EMERALD:     8,
  URANIUM:     9,
  RARE_EARTH: 10,
  SALT:       11,
  GYPSUM:     12,
  OBSIDIAN:   13,
  SULFUR:     14
});

export class MineralDepositSystem {
  constructor(seed = 1337) {
    this.seed = seed;
    this.noise = new ProceduralNoise(seed + 23);
  }

  /**
   * Scans a terrain tile and emits mineral deposit markers based on the
   * subsurface geology.
   */
  scanTerrain(terrain, tileX, tileY, lod, markers, subsurfaceColumn) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const cellSize = terrain.tileWorldSize / (res - 1);

    // Deposits cluster along geological contacts and near surface outcrops.
    // Sample at a coarse grid (every 4 cells) to keep the marker count low.
    for (let y = 2; y < res - 2; y += 4) {
      for (let x = 2; x < res - 2; x += 4) {
        const idx = y * res + x;
        const h = elevation[idx];

        // Compute local slope for exposure analysis.
        const dx = elevation[idx + 1] - elevation[idx - 1];
        const dy = elevation[idx + res] - elevation[idx - res];
        const slope = Math.sqrt(dx * dx + dy * dy);

        // Deposit probability depends on slope (exposed rock) and depth.
        const exposure = Math.min(1, slope * 2);
        const noise = this.noise.fbm(x * 0.15, y * 0.15, 4);

        if (exposure > 0.4 && noise > 0.6) {
          // Choose a mineral type based on the subsurface composition.
          let mineralType = MineralType.IRON;
          if (subsurfaceColumn) {
            const surfaceLayer = subsurfaceColumn.getLayerAtDepth(0.5);
            if (surfaceLayer) {
              switch (surfaceLayer.composition) {
                case SubsurfaceComposition.GRANITE: mineralType = MineralType.RARE_EARTH; break;
                case SubsurfaceComposition.BASALT: mineralType = MineralType.COPPER; break;
                case SubsurfaceComposition.SHALE: mineralType = MineralType.COAL; break;
                case SubsurfaceComposition.LIMESTONE: mineralType = MineralType.IRON; break;
                case SubsurfaceComposition.ORE_BEARING: mineralType = MineralType.GOLD; break;
                case SubsurfaceComposition.CRYSTALLINE: mineralType = MineralType.DIAMOND; break;
                default: mineralType = MineralType.IRON;
              }
            }
          }

          const wx = terrain.originX + (x / (res - 1)) * terrain.tileWorldSize;
          const wy = terrain.originY + (y / (res - 1)) * terrain.tileWorldSize;
          const depositSize = 0.5 + noise * 1.5;
          markers.push(
            ScatterMarkerType.ROCK_LARGE,
            wx, wy, h,
            0.8,
            mineralType,
            depositSize,
            tileX, tileY, lod
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 9. BIOME TRANSITION ZONE SYSTEM
// ---------------------------------------------------------------------------

/**
 * BiomeTransitionZoneSystem — smooths transitions between biomes so adjacent
 * tiles do not pop from desert to rainforest at a hard boundary. Uses a
 * domain-warped noise field to blend the biome weight fields.
 */
export class BiomeTransitionZoneSystem {
  constructor(seed = 1337) {
    this.seed = seed;
    this.noise = new ProceduralNoise(seed + 43);
  }

  /**
   * Smooths the biome weights across a tile by warping and averaging the
   * adjacent biomes.
   */
  smoothBiomeWeights(terrain, blendWidth = 0.2) {
    const res = terrain.resolution;
    const biome = terrain.biomeWeights;
    const copy = new Float32Array(biome);

    for (let y = 1; y < res - 1; y++) {
      for (let x = 1; x < res - 1; x++) {
        const idx = y * res + x;

        // Warp the sample position to blur the hard boundary.
        const warp = this.noise.fbm(x * 0.1, y * 0.1, 3) * blendWidth;
        const wx = x + warp;
        const wy = y + warp;

        const bx = Math.floor(wx);
        const by = Math.floor(wy);
        if (bx < 0 || bx >= res - 1 || by < 0 || by >= res - 1) continue;

        const fx = wx - bx;
        const fy = wy - by;

        const b00 = copy[by * res + bx];
        const b10 = copy[by * res + bx + 1];
        const b01 = copy[(by + 1) * res + bx];
        const b11 = copy[(by + 1) * res + bx + 1];

        const top = b00 + (b10 - b00) * fx;
        const bot = b01 + (b11 - b01) * fx;
        biome[idx] = top + (bot - top) * fy;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 10. CLIMATE-ADAPTIVE TERRAIN MODIFIERS
// ---------------------------------------------------------------------------

/**
 * ClimateAdaptiveModifiers — adjusts terrain shape based on the current
 * climate (temperature, precipitation, wind) from the context frame’s
 * temporal channel.
 */
export class ClimateAdaptiveModifiers {
  constructor(seed = 1337) {
    this.noise = new ProceduralNoise(seed + 59);
  }

  /**
   * Applies climate-specific weathering to a terrain tile.
   */
  apply(terrain, climate) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const temperature = climate.temperature ?? 0.5;
    const precipitation = climate.precipitation ?? 0.5;
    const wind = climate.wind ?? 0.5;

    // Cold climate: increase snow-loading in high elevation, add ice-carved
    // striations.
    if (temperature < 0.3) {
      for (let i = 0; i < elevation.length; i++) {
        // Ice-carved striations are subtle ridges.
        const striation = Math.sin(elevation[i] * 100) * 0.005;
        elevation[i] += striation;
      }
    }

    // Wet climate: increase channelization (deeper river valleys).
    if (precipitation > 0.7) {
      const flow = TerrainErosion.flowAccumulation(elevation, res);
      TerrainErosion.carveRivers(elevation, res, flow, 4.0, 80);
    }

    // Windy climate: smooth windward slopes.
    if (wind > 0.6) {
      ExtendedErosion.wind(elevation, res, 1, 0, 3, 0.05);
    }
  }
}

// ---------------------------------------------------------------------------
// 11. CONTEXT-DRIVEN DEFORMATION SYSTEM
// ---------------------------------------------------------------------------

/**
 * ContextDrivenDeformation — reacts to causal events (impacts, explosions,
 * mining, tunneling) by modifying the terrain heightfield in real time.
 * The effects are recorded in the terrain’s per-tile deformation buffer,
 * which downstream systems can query without triggering a full rebuild.
 */
export class ContextDrivenDeformation {
  constructor(options = {}) {
    this.options = {
      maxDeformations: options.maxDeformations ?? 16,
      ...options
    };

    // Per-tile deformation buffer.
    this.deformations = new Map();
  }

  /**
   * Applies a deformation to a terrain tile. The deformation is stored in
   * a per-tile array and applied to the elevation array in place.
   */
  applyDeformation(terrain, deformation) {
    const tileKey = terrain.tileKey;
    let list = this.deformations.get(tileKey);
    if (!list) {
      list = [];
      this.deformations.set(tileKey, list);
    }

    // Cap the list length.
    if (list.length >= this.options.maxDeformations) {
      list.shift();
    }

    list.push(deformation);

    // Apply the deformation to the elevation array.
    this._applyToTerrain(terrain, deformation);
  }

  _applyToTerrain(terrain, def) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const cellSize = terrain.tileWorldSize / (res - 1);

    const radius = def.radius ?? 10;
    const depth = def.depth ?? 5;
    const rimHeight = def.rimHeight ?? depth * 0.15;

    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const wx = terrain.originX + x * cellSize;
        const wy = terrain.originY + y * cellSize;
        const dx = wx - def.x;
        const dy = wy - def.y;
        const d = Math.sqrt(dx * dx + dy * dy);

        if (d > radius * 1.5) continue;

        const t = d / radius;
        let delta = 0;

        if (t < 1) {
          // Bowl interior.
          delta = -depth * (1 - t * t);
        } else if (t < 1.5) {
          // Rim.
          const rimT = (t - 1) / 0.5;
          delta = rimHeight * (1 - rimT);
        }

        elevation[y * res + x] += delta;
      }
    }

    // Recompute bounds.
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < elevation.length; i++) {
      if (elevation[i] < minH) minH = elevation[i];
      if (elevation[i] > maxH) maxH = elevation[i];
    }
    terrain.minElevation = minH;
    terrain.maxElevation = maxH;
    terrain.heightRange = Math.max(maxH - minH, 1e-9);
    terrain._boundingBox = null;
    terrain._boundingSphere = null;
  }

  /**
   * Returns the list of deformations for a tile key.
   */
  getDeformations(tileKey) {
    return this.deformations.get(tileKey) ?? [];
  }

  /**
   * Clears all deformations.
   */
  clear() {
    this.deformations.clear();
  }
}

// ---------------------------------------------------------------------------
// 12. ADVANCED SCATTER PARAMETERIZATION
// ---------------------------------------------------------------------------

/**
 * AdvancedScatterParams — expands the scatter system to include fractal
 * rock parameters and L-system tree parameters, so downstream systems can
 * instantiate high-fidelity scatter meshes without additional procedural
 * work.
 */
export const ScatterRockShape = Object.freeze({
  SPHERE:      0,
  ELLIPSOID:   1,
  CUBE:        2,
  ANGULAR:     3,
  FRACTAL:     4
});

export const ScatterTreeShape = Object.freeze({
  CONIFER:     0,
  DECIDUOUS:   1,
  PALM:        2,
  CACTUS:      3,
  BAMBOO:      4,
  SHRUB:       5,
  FERN:        6
});

/**
 * AdvancedScatterParams — the additional metadata attached to each scatter
 * marker. Stored in a structure-of-arrays buffer parallel to the marker
 * buffer.
 */
export class AdvancedScatterParams {
  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.count = 0;

    // Rock parameters.
    this.rockShape    = new Uint8Array(capacity);
    this.rockFractalSeed = new Uint32Array(capacity);
    this.rockFractalIter = new Uint8Array(capacity);

    // Tree parameters.
    this.treeShape    = new Uint8Array(capacity);
    this.treeSeed     = new Uint32Array(capacity);
    this.treeHeight   = new Float32Array(capacity);
    this.treeTrunkRadius = new Float32Array(capacity);
    this.treeBranchAngle = new Float32Array(capacity);
    this.treeLeafDensity = new Float32Array(capacity);

    // Grass parameters.
    this.grassDensity = new Float32Array(capacity);
    this.grassHeight  = new Float32Array(capacity);
  }

  reset() { this.count = 0; }

  push(params) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.rockShape[i] = params.rockShape ?? 0;
    this.rockFractalSeed[i] = params.rockFractalSeed ?? 0;
    this.rockFractalIter[i] = params.rockFractalIter ?? 3;
    this.treeShape[i] = params.treeShape ?? 0;
    this.treeSeed[i] = params.treeSeed ?? 0;
    this.treeHeight[i] = params.treeHeight ?? 5;
    this.treeTrunkRadius[i] = params.treeTrunkRadius ?? 0.3;
    this.treeBranchAngle[i] = params.treeBranchAngle ?? 30;
    this.treeLeafDensity[i] = params.treeLeafDensity ?? 0.7;
    this.grassDensity[i] = params.grassDensity ?? 1;
    this.grassHeight[i] = params.grassHeight ?? 0.5;
    return i;
  }
}

// ---------------------------------------------------------------------------
// 13. WATER TABLE AND AQUIFER MODEL
// ---------------------------------------------------------------------------

/**
 * WaterTableModel — computes the water table elevation for a tile based on
 * surface elevation and precipitation. Reveals springs, wells, and aquifer
 * locations.
 */
export class WaterTableModel {
  constructor(seed = 1337) {
    this.noise = new ProceduralNoise(seed + 97);
  }

  /**
   * Computes the water table elevation at each cell.
   */
  computeWaterTable(terrain, precipitation = 0.5, porosity = 0.3) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const waterTable = new Float32Array(res * res);

    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const idx = y * res + x;
        const h = elevation[idx];
        // Water table follows the terrain with a smoothed offset that
        // depends on precipitation and porosity.
        const offset = -Math.max(0, (1 - precipitation) * 20 + porosity * 10);
        waterTable[idx] = h + offset;
      }
    }

    // Smooth the water table with a low-pass filter.
    this._smooth(waterTable, res, 3);

    return waterTable;
  }

  _smooth(arr, res, iterations) {
    for (let iter = 0; iter < iterations; iter++) {
      const copy = arr.slice();
      for (let y = 1; y < res - 1; y++) {
        for (let x = 1; x < res - 1; x++) {
          const idx = y * res + x;
          arr[idx] = (
            copy[idx - 1] + copy[idx + 1] +
            copy[idx - res] + copy[idx + res]
          ) * 0.25;
        }
      }
    }
  }

  /**
   * Finds wells and springs — locations where the water table meets or
   * exceeds the surface.
   */
  findWaterFeatures(terrain, waterTable, tileX, tileY, lod, markers) {
    const res = terrain.resolution;
    for (let y = 1; y < res - 1; y++) {
      for (let x = 1; x < res - 1; x++) {
        const idx = y * res + x;
        if (waterTable[idx] > terrain.elevation[idx] - 0.1) {
          const wx = terrain.originX + (x / (res - 1)) * terrain.tileWorldSize;
          const wy = terrain.originY + (y / (res - 1)) * terrain.tileWorldSize;
          markers.push(
            ScatterMarkerType.SPRING,
            wx, wy, terrain.elevation[idx],
            0.6, 0, 1.0, tileX, tileY, lod
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 14. ANISOTROPIC DETAIL PASSES
// ---------------------------------------------------------------------------

/**
 * AnisotropicDetailPass — adds directional detail to a heightfield: wind
 * streaks on exposed surfaces, water flow marks along rivers, and ice
 * striations on cold terrain.
 */
export class AnisotropicDetailPass {
  constructor(seed = 1337) {
    this.noise = new ProceduralNoise(seed + 41);
  }

  /**
   * Applies wind streaks to a terrain heightfield.
   */
  applyWindStreaks(terrain, direction = 0, strength = 0.02, scale = 20) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const cosA = Math.cos(direction);
    const sinA = Math.sin(direction);
    const cellSize = terrain.tileWorldSize / (res - 1);

    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const idx = y * res + x;
        const wx = terrain.originX + x * cellSize;
        const wy = terrain.originY + y * cellSize;
        // Project onto the wind direction to get the streak coordinate.
        const streakCoord = (wx * cosA + wy * sinA) * scale;
        const streak = Math.sin(streakCoord) * strength;
        elevation[idx] += streak;
      }
    }

    this._refreshBounds(terrain);
  }

  /**
   * Applies water-flow marks along the drainage network.
   */
  applyWaterFlowMarks(terrain, flow, strength = 0.03) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;

    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const idx = y * res + x;
        if (flow[idx] > 100) {
          // Carve a small channel where flow is high.
          const carve = Math.min(1, flow[idx] / 1000) * strength;
          elevation[idx] -= carve;
        }
      }
    }

    this._refreshBounds(terrain);
  }

  _refreshBounds(terrain) {
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < terrain.elevation.length; i++) {
      if (terrain.elevation[i] < minH) minH = terrain.elevation[i];
      if (terrain.elevation[i] > maxH) maxH = terrain.elevation[i];
    }
    terrain.minElevation = minH;
    terrain.maxElevation = maxH;
    terrain.heightRange = Math.max(maxH - minH, 1e-9);
    terrain._boundingBox = null;
    terrain._boundingSphere = null;
  }
}

// ---------------------------------------------------------------------------
// 15. CAVITY AND AMBIENT OCCLUSION MAPS
// ---------------------------------------------------------------------------

/**
 * CavityAO — computes per-vertex cavity and ambient-occlusion maps for
 * downstream shading. Uses local curvature and multi-sample AO estimation.
 */
export class CavityAO {
  /**
   * Computes the cavity map (negative for concave, positive for convex).
   */
  static computeCavity(terrain) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const cavity = new Float32Array(res * res);
    const cellSize = terrain.tileWorldSize / (res - 1);

    for (let y = 1; y < res - 1; y++) {
      for (let x = 1; x < res - 1; x++) {
        const idx = y * res + x;
        const h = elevation[idx];

        // Sum of neighbor heights.
        let sum = 0;
        let count = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            sum += elevation[(y + oy) * res + (x + ox)];
            count++;
          }
        }
        const avg = sum / count;

        // Cavity is the curvature: negative for pits, positive for peaks.
        cavity[idx] = (h - avg) / cellSize;
      }
    }

    return cavity;
  }

  /**
   * Computes an approximate ambient occlusion map using sky visibility
   * sampling over a hemisphere.
   */
  static computeAO(terrain, samples = 8) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const ao = new Float32Array(res * res).fill(1.0);
    const cellSize = terrain.tileWorldSize / (res - 1);

    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const idx = y * res + x;
        const h = elevation[idx];

        // Sample rays in a hemisphere above the cell.
        let occluded = 0;
        for (let s = 0; s < samples; s++) {
          const angle = (s / samples) * Math.PI * 2;
          const elevationAngle = Math.PI / 4; // 45° above horizon
          const dx = Math.cos(angle);
          const dy = Math.sin(angle);

          // March along the ray.
          let isOccluded = false;
          for (let step = 1; step < 10; step++) {
            const sx = x + Math.round(dx * step);
            const sy = y + Math.round(dy * step);
            if (sx < 0 || sx >= res || sy < 0 || sy >= res) break;
            const sampleH = elevation[sy * res + sx];
            const expectedH = h + Math.tan(elevationAngle) * step * cellSize;
            if (sampleH > expectedH) {
              isOccluded = true;
              break;
            }
          }
          if (isOccluded) occluded++;
        }

        ao[idx] = 1 - occluded / samples;
      }
    }

    return ao;
  }
}

// ---------------------------------------------------------------------------
// 16. CURVATURE, FLOW, ASPECT DATA LAYERS
// ---------------------------------------------------------------------------

/**
 * TerrainDerivedData — computes the curvature, flow accumulation, and aspect
 * layers for a tile. These are consumed by the material painter for slope-
 * based blending, and by hydrology systems for water simulation.
 */
export class TerrainDerivedData {
  static compute(terrain) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const cellSize = terrain.tileWorldSize / (res - 1);

    const curvature = new Float32Array(res * res);
    const aspect = new Float32Array(res * res);
    const slope = new Float32Array(res * res);

    for (let y = 1; y < res - 1; y++) {
      for (let x = 1; x < res - 1; x++) {
        const idx = y * res + x;

        // Gradient.
        const dx = (elevation[idx + 1] - elevation[idx - 1]) / (2 * cellSize);
        const dy = (elevation[idx + res] - elevation[idx - res]) / (2 * cellSize);

        // Slope.
        slope[idx] = Math.sqrt(dx * dx + dy * dy);

        // Aspect (direction of steepest descent, in radians).
        aspect[idx] = Math.atan2(-dy, -dx);

        // Curvature (Laplacian).
        const laplacian = (
          elevation[idx + 1] + elevation[idx - 1] +
          elevation[idx + res] + elevation[idx - res] -
          4 * elevation[idx]
        ) / (cellSize * cellSize);
        curvature[idx] = laplacian;
      }
    }

    // Flow accumulation.
    const flow = TerrainErosion.flowAccumulation(elevation, res);

    return { curvature, slope, aspect, flow };
  }
}

// ---------------------------------------------------------------------------
// 17. MACRO / MICRO DETAIL LAMINATION
// ---------------------------------------------------------------------------

/**
 * DetailLamination — combines macro (coarse) detail with micro (fine) detail
 * to produce a rich surface without increasing the tile’s vertex count. The
 * macro layer defines the overall shape; the micro layer adds high-frequency
 * detail that reads at close range.
 */
export class DetailLamination {
  constructor(seed = 1337) {
    this.noise = new ProceduralNoise(seed + 13);
  }

  /**
   * Applies micro detail to a heightfield. The micro detail is attenuated
   * by the macro slope so vertical cliffs stay sharp while gentle slopes
   * gain fine texture.
   */
  apply(terrain, microAmplitude = 0.5, microScale = 10) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const cellSize = terrain.tileWorldSize / (res - 1);

    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const idx = y * res + x;

        // Compute the macro slope.
        if (x > 0 && x < res - 1 && y > 0 && y < res - 1) {
          const dx = (elevation[idx + 1] - elevation[idx - 1]) / (2 * cellSize);
          const dy = (elevation[idx + res] - elevation[idx - res]) / (2 * cellSize);
          const slope = Math.sqrt(dx * dx + dy * dy);

          // Attenuate micro detail by slope: cliffs stay sharp.
          const attenuation = Math.max(0.1, 1 - slope * 0.5);

          // Add micro detail.
          const wx = x * microScale;
          const wy = y * microScale;
          const micro = this.noise.fbm(wx, wy, 3) * microAmplitude * attenuation;
          elevation[idx] += micro;
        }
      }
    }

    this._refreshBounds(terrain);
  }

  _refreshBounds(terrain) {
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < terrain.elevation.length; i++) {
      if (terrain.elevation[i] < minH) minH = terrain.elevation[i];
      if (terrain.elevation[i] > maxH) maxH = terrain.elevation[i];
    }
    terrain.minElevation = minH;
    terrain.maxElevation = maxH;
    terrain.heightRange = Math.max(maxH - minH, 1e-9);
    terrain._boundingBox = null;
    terrain._boundingSphere = null;
  }
}

// ---------------------------------------------------------------------------
// 18. ARCHAEOLOGICAL AND RUIN MARKERS
// ---------------------------------------------------------------------------

/**
 * ArchaeologyMarkerSystem — places ruins, standing stones, temples, and
 * ancient settlements on flat terrain with favourable access (near water
 * or on trade routes). Places markers only — downstream systems handle the
 * actual geometry.
 */
export class ArchaeologyMarkerSystem {
  constructor(seed = 1337) {
    this.noise = new ProceduralNoise(seed + 17);
  }

  /**
   * Scans a terrain tile for suitable settlement sites.
   */
  scanForSettlements(terrain, tileX, tileY, lod, markers) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const cellSize = terrain.tileWorldSize / (res - 1);

    // Settlement sites prefer flat, mid-elevation terrain near water.
    for (let y = 4; y < res - 4; y += 8) {
      for (let x = 4; x < res - 4; x += 8) {
        const idx = y * res + x;
        const h = elevation[idx];

        // Local slope check.
        const dx = (elevation[idx + 4] - elevation[idx - 4]) / (8 * cellSize);
        const dy = (elevation[idx + 4 * res] - elevation[idx - 4 * res]) / (8 * cellSize);
        const slope = Math.sqrt(dx * dx + dy * dy);

        if (slope > 0.15) continue; // Too steep for a settlement.

        // Random site probability.
        const chance = this.noise.fbm(x * 0.05, y * 0.05, 4);
        if (chance > 0.75) {
          const wx = terrain.originX + (x / (res - 1)) * terrain.tileWorldSize;
          const wy = terrain.originY + (y / (res - 1)) * terrain.tileWorldSize;

          // Determine site type: temple, village, standing stones, or ruins.
          let siteType = ScatterMarkerType.ROCK_LARGE;
          if (chance > 0.95) siteType = ScatterMarkerType.BOULDER; // temple
          else if (chance > 0.88) siteType = ScatterMarkerType.ROCK_LARGE; // village
          else siteType = ScatterMarkerType.ROCK_SMALL; // ruin field

          markers.push(
            siteType,
            wx, wy, h,
            0.7,
            this.noise.fbm(x * 0.3, y * 0.3, 3), // rotation seed
            0.8 + this.noise.fbm(x * 0.4, y * 0.4, 3) * 0.6, // size
            tileX, tileY, lod
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 19. LOD-AWARE FIDELITY SYSTEM
// ---------------------------------------------------------------------------

/**
 * LODFidelitySystem — chooses resolution and detail budget per tile based on
 * the tile’s LOD and the current GPU/CPU budget. Allows the pipeline to
 * generate coarse tiles for distant terrain and fine tiles for near terrain
 * without changing the generator’s API.
 */
export class LODFidelitySystem {
  constructor(options = {}) {
    this.options = {
      baseResolution: options.baseResolution ?? 65,
      maxResolution: options.maxResolution ?? 257,
      resolutionScalePerLod: options.resolutionScalePerLod ?? 1.5,
      maxLod: options.maxLod ?? 12,
      targetFrameMs: options.targetFrameMs ?? 8,
      minResolution: options.minResolution ?? 17,
      ...options
    };
  }

  /**
   * Returns the recommended resolution for a given LOD level.
   */
  resolutionForLod(lod) {
    const scale = Math.pow(this.options.resolutionScalePerLod, lod);
    const res = Math.floor(this.options.baseResolution * scale);
    return Math.min(this.options.maxResolution, Math.max(this.options.minResolution, res));
  }

  /**
   * Returns the recommended detail budget (0..1) for a given LOD.
   * Higher LOD = more detail.
   */
  detailBudgetForLod(lod) {
    return Math.min(1, 1 / Math.pow(1.3, lod));
  }

  /**
   * Returns the recommended erosion iterations for a given LOD.
   * Coarse tiles get fewer iterations for speed.
   */
  erosionIterationsForLod(lod) {
    const budget = this.detailBudgetForLod(lod);
    return Math.floor(50000 * budget);
  }

  /**
   * Returns a complete fidelity config for a given LOD.
   */
  configForLod(lod) {
    return {
      resolution: this.resolutionForLod(lod),
      detailBudget: this.detailBudgetForLod(lod),
      erosionIterations: this.erosionIterationsForLod(lod),
      thermalIterations: Math.max(2, Math.floor(10 * this.detailBudgetForLod(lod))),
      includeScatter: lod <= 4,
      includeRivers: lod <= 6,
      includeCaves: lod <= 3
    };
  }
}

// ---------------------------------------------------------------------------
// 20. ADVANCED TERRAIN GENERATOR
// ---------------------------------------------------------------------------

/**
 * AdvancedTerrainGenerator — an ExtendedTerrainGenerator subclass that adds
 * every advanced feature. It exposes the same public API plus advanced
 * helpers:
 *
 *   generateTileWithDepth(tileInfo, options) → { terrain, rivers, caves,
 *                                                 minerals, subsurface }
 *   applyContextDeformation(terrain, event) → terrain (mutated)
 *   computeDerivedData(terrain) → { curvature, slope, aspect, flow, ao, cavity }
 */
export class AdvancedTerrainGenerator extends ExtendedTerrainGenerator {
  constructor(options = {}) {
    super(options);

    // ---- Subsystems ----
    this.tectonics = new TectonicPlateSimulator(
      this.options.seed + 1,
      options.plateCount ?? 12
    );
    this.volcanics = new VolcanicActivitySimulator(this.options.seed + 2);
    this.impactCraters = new ImpactCraterSystem(this.options.seed + 3);
    this.minerals = new MineralDepositSystem(this.options.seed + 4);
    this.biomeTransition = new BiomeTransitionZoneSystem(this.options.seed + 5);
    this.climateMods = new ClimateAdaptiveModifiers(this.options.seed + 6);
    this.deformations = new ContextDrivenDeformation();
    this.waterTable = new WaterTableModel(this.options.seed + 7);
    this.anisotropic = new AnisotropicDetailPass(this.options.seed + 8);
    this.detailLamination = new DetailLamination(this.options.seed + 9);
    this.archaeology = new ArchaeologyMarkerSystem(this.options.seed + 10);
    this.lodFidelity = new LODFidelitySystem({
      baseResolution: this.options.resolution,
      maxLod: this.options.maxLod,
      targetFrameMs: this.options.targetFrameMs
    });

    // ---- Register advanced terrain types ----
    this._registerAdvancedTerrainTypes();
    this._registerAdvancedBiomes();
  }

  // ------------------------------------------------------------------------
  // Advanced terrain type registration
  // ------------------------------------------------------------------------

  _registerAdvancedTerrainTypes() {
    // --- Volcanic ---
    this.registerTerrainGenerator(AdvancedTerrainType.VOLCANIC_CALDERA, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      const calderaRim = Math.exp(-Math.pow((r - 15) / 5, 2)) * 0.8;
      const calderaFloor = r < 15 ? -0.3 : 0;
      const noise = n.fbm(x * 0.05, y * 0.05, 3) * 0.1;
      return calderaRim + calderaFloor + noise;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.LAVA_TUBES_SURFACE, (n, x, y) => {
      const tunnel = Math.abs(Math.sin(x * 0.05 + n.fbm(y * 0.02, 0, 3) * 2));
      return -Math.pow(1 - tunnel, 4) * 0.4;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.OBSIDIAN_FLOW, (n, x, y) => {
      const flow = n.fbm(x * 0.02, y * 0.05, 4);
      const streaks = Math.sin(flow * 20) * 0.02;
      return flow * 0.3 + streaks;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.TUFF_RING_DIATREME, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      const ring = Math.exp(-Math.pow((r - 10) / 2, 2)) * 0.6;
      const crater = r < 8 ? -0.2 : 0;
      return ring + crater;
    });

    // --- Tectonic ---
    this.registerTerrainGenerator(AdvancedTerrainType.FAULT_SCARP, (n, x, y) => {
      const scarp = Math.sign(Math.sin(y * 0.01)) * 0.3;
      return scarp;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.HORST_AND_GRABEN, (n, x, y) => {
      const block = Math.floor(n.fbm(x * 0.01, y * 0.01, 3) * 4) / 4;
      return block;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.RIFT_VALLEY, (n, x, y) => {
      const valley = -Math.exp(-Math.pow(y / 15, 2)) * 0.5;
      const base = n.fbm(x * 0.005, y * 0.005, 3) * 0.2;
      return valley + base;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.FOLD_MOUNTAIN_BELT, (n, x, y) => {
      const folds = Math.sin(y * 0.02) * 0.4 + Math.sin(y * 0.03) * 0.2;
      const noise = n.fbm(x * 0.01, y * 0.01, 3) * 0.2;
      return folds + noise;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.THRUST_FAULT_TERRAIN, (n, x, y) => {
      const shear = Math.sin((x + y) * 0.02) * 0.3;
      return shear;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.BASEMENT_UPLIFT, (n, x, y) => {
      const dome = Math.exp(-Math.pow(Math.sqrt(x * x + y * y) / 30, 2)) * 0.6;
      return dome;
    });

    // --- Intrusive ---
    this.registerTerrainGenerator(AdvancedTerrainType.LACCOLITH_DOME, (n, x, y) => {
      const v = n.voronoi(x * 0.005, y * 0.005, 1.0);
      return Math.max(0, 0.5 - v) * 0.8;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.SILL_TERRACES, (n, x, y) => {
      const base = n.fbm(x * 0.005, y * 0.005, 3) * 0.5;
      return Math.floor(base * 8) / 8;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.VEIN_NETWORK, (n, x, y) => {
      const vein = Math.abs(n.fbm(x * 0.02, y * 0.02, 4) - 0.5);
      return vein * 0.05;
    });

    // --- Hydrothermal ---
    this.registerTerrainGenerator(AdvancedTerrainType.HYDROTHERMAL_FIELD, (n, x, y) => {
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      const vent = Math.max(0, 0.2 - v) * 0.3;
      return vent;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.MUD_POT_FIELD, (n, x, y) => {
      const v = n.voronoi(x * 0.03, y * 0.03, 1.0);
      return -Math.max(0, 0.15 - v) * 0.2;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.TRAVERTINE_CASCADE, (n, x, y) => {
      const base = n.fbm(x * 0.01, y * 0.01, 3) * 0.3;
      return Math.floor(base * 15) / 15;
    });

    // --- Periglacial ---
    this.registerTerrainGenerator(AdvancedTerrainType.SNOW_AVALANCHE_GULLY, (n, x, y) => {
      const gully = -Math.abs(Math.sin(y * 0.02));
      return gully * 0.2;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.ROCK_GLACIER, (n, x, y) => {
      const base = n.fbm(x * 0.005, y * 0.005, 3) * 0.2;
      const debris = n.billow(x * 0.02, y * 0.02, 3) * 0.1;
      return base + debris;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.DEBRIS_CONE, (n, x, y) => {
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      return Math.max(0, 0.3 - v) * 0.4;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.ALLUVIAL_FAN, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      return Math.max(0, 1 - r / 40) * 0.3;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.DRIED_LAKEBED, (n, x, y) => {
      const mudCrack = Math.abs(n.fbm(x * 0.05, y * 0.05, 3) - 0.5);
      return -mudCrack * 0.05;
    });

    // --- Anthropogenic ---
    this.registerTerrainGenerator(AdvancedTerrainType.TERRACED_FARMLAND, (n, x, y) => {
      const base = n.fbm(x * 0.005, y * 0.005, 3) * 0.4;
      return Math.floor(base * 20) / 20;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.ANCIENT_CITY_RUINS, (n, x, y) => {
      const grid = n.voronoi(x * 0.05, y * 0.05, 1.0);
      return grid > 0.6 ? 0.1 : 0;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.QUARRY, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      return -Math.max(0, 1 - r / 20) * 0.4;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.MINE_TAILINGS, (n, x, y) => {
      const v = n.voronoi(x * 0.03, y * 0.03, 1.0);
      return Math.max(0, 0.3 - v) * 0.2;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.CANAL_NETWORK, (n, x, y) => {
      const grid = Math.abs(Math.sin(x * 0.05)) * Math.abs(Math.sin(y * 0.05));
      return grid > 0.95 ? -0.05 : 0;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.PYRAMID_COMPLEX, (n, x, y) => {
      const v = n.voronoi(x * 0.01, y * 0.01, 1.0);
      return Math.max(0, 0.15 - v) * 1.2;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.MEGALITH_SITE, (n, x, y) => {
      const v = n.voronoi(x * 0.05, y * 0.05, 1.0);
      return Math.max(0, 0.1 - v) * 0.5;
    });

    // --- Glacial / polar ---
    this.registerTerrainGenerator(AdvancedTerrainType.ICEBERG_FIELD, (n, x, y) => {
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      return v < 0.2 ? 0.4 : -0.4;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.SUBGLACIAL_LAKE, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      return -Math.max(0, 1 - r / 15) * 0.3;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.KETTLE_HOLE, (n, x, y) => {
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      return -Math.max(0, 0.2 - v) * 0.4;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.PARABOLIC_DUNE, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      return Math.exp(-Math.pow((r - 10) / 3, 2)) * 0.4;
    });

    // --- Extraterrestrial ---
    this.registerTerrainGenerator(AdvancedTerrainType.LUNAR_MARE, (n, x, y) => {
      const base = n.fbm(x * 0.003, y * 0.003, 3) * 0.05;
      const crater = n.voronoi(x * 0.02, y * 0.02, 1.0) < 0.15 ? -0.1 : 0;
      return base + crater;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.LUNAR_HIGHLAND, (n, x, y) => {
      const base = n.fbm(x * 0.005, y * 0.005, 4) * 0.3;
      const crater = n.voronoi(x * 0.05, y * 0.05, 1.0) < 0.2 ? -0.15 : 0;
      return base + crater;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.MARTIAN_CHAOS, (n, x, y) => {
      const plates = Math.floor(n.fbm(x * 0.01, y * 0.01, 4) * 6) / 6;
      const cracks = Math.abs(n.fbm(x * 0.05, y * 0.05, 3) - 0.5);
      return plates * 0.5 - cracks * 0.1;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.MARTIAN_POLAR_LAYERED, (n, x, y) => {
      const layers = Math.floor(n.fbm(x * 0.001, y * 0.005, 3) * 12) / 12;
      return layers;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.TITAN_METHANE_DELTA, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      const channels = Math.abs(Math.sin(Math.atan2(y, x) * 8)) * Math.max(0, 1 - r / 40);
      return -channels * 0.15;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.ENCELADUS_TIGER_STRIPES, (n, x, y) => {
      const stripes = Math.abs(Math.sin(x * 0.05));
      return stripes > 0.9 ? -0.1 : 0;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.EUROPA_LINEAE, (n, x, y) => {
      const lines1 = Math.abs(Math.sin(x * 0.02));
      const lines2 = Math.abs(Math.sin((x + y) * 0.02));
      return Math.max(lines1, lines2) > 0.95 ? -0.05 : 0;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.IO_VOLCANIC_PLAINS, (n, x, y) => {
      const base = n.fbm(x * 0.01, y * 0.01, 3) * 0.2;
      const vents = n.voronoi(x * 0.05, y * 0.05, 1.0) < 0.1 ? 0.3 : 0;
      return base + vents;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.TRITON_CANTALOUPE, (n, x, y) => {
      const v = n.voronoi(x * 0.03, y * 0.03, 1.0);
      const dimples = Math.max(0, 0.3 - v) * -0.3;
      return dimples;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.ASTEROID_RUBBLE_PILE, (n, x, y) => {
      const v = n.voronoi(x * 0.02, y * 0.02, 1.0);
      return Math.max(0, 0.4 - v) * 0.5;
    });

    this.registerTerrainGenerator(AdvancedTerrainType.COMET_NUCLEUS, (n, x, y) => {
      const r = Math.sqrt(x * x + y * y);
      const elliptical = Math.max(0, 1 - (x / 40) ** 2 - (y / 15) ** 2);
      const craters = n.voronoi(x * 0.05, y * 0.05, 1.0) < 0.15 ? -0.1 : 0;
      return elliptical * 0.5 + craters;
    });
  }

  // ------------------------------------------------------------------------
  // Advanced biome registration
  // ------------------------------------------------------------------------

  _registerAdvancedBiomes() {
    const biomes = [
      [AdvancedBiomeType.HYDROTHERMAL_VENT,        { offset: 0.0,  minTemp: 0.3, minPrecip: 0.9 }],
      [AdvancedBiomeType.HIGH_ALTITUDE_DESERT,     { offset: 0.05, minTemp: 0.2, minPrecip: 0.0 }],
      [AdvancedBiomeType.CRYO_VOLCANIC,            { offset: 0.05, minTemp: 0.0, minPrecip: 0.3 }],
      [AdvancedBiomeType.SALINE_LAKE,              { offset: -0.05, minTemp: 0.3, minPrecip: 0.1 }],
      [AdvancedBiomeType.OKAVANGO_DELTA,           { offset: -0.03, minTemp: 0.5, minPrecip: 0.5 }],
      [AdvancedBiomeType.SOCOTRA_ALIEN,            { offset: 0.02, minTemp: 0.6, minPrecip: 0.2 }],
      [AdvancedBiomeType.ATACAMA_HYPERARID,        { offset: 0.00, minTemp: 0.4, minPrecip: 0.0 }],
      [AdvancedBiomeType.ANTARCTIC_DRY_VALLEY,     { offset: 0.00, minTemp: 0.0, minPrecip: 0.0 }],
      [AdvancedBiomeType.MCMURDO_SOUND,            { offset: 0.00, minTemp: 0.1, minPrecip: 0.1 }],
      [AdvancedBiomeType.NAMIB_FOG_DESERT,         { offset: 0.00, minTemp: 0.4, minPrecip: 0.1 }],
      [AdvancedBiomeType.ARCTIC_TUNDRA_POLYGONS,   { offset: 0.02, minTemp: 0.1, minPrecip: 0.2 }],
      [AdvancedBiomeType.LUNAR_MARE_BIOME,         { offset: -0.02, minTemp: 0.0, minPrecip: 0.0 }],
      [AdvancedBiomeType.LUNAR_HIGHLAND_BIOME,     { offset: 0.05, minTemp: 0.0, minPrecip: 0.0 }],
      [AdvancedBiomeType.MARTIAN_POLAR_BIOME,      { offset: 0.00, minTemp: 0.0, minPrecip: 0.0 }],
      [AdvancedBiomeType.MARTIAN_DUNE_BIOME,       { offset: 0.00, minTemp: 0.1, minPrecip: 0.0 }],
      [AdvancedBiomeType.TITAN_LAKE_BIOME,         { offset: -0.05, minTemp: 0.1, minPrecip: 0.3 }],
      [AdvancedBiomeType.EUROPA_ICE_BIOME,         { offset: 0.00, minTemp: 0.0, minPrecip: 0.0 }],
      [AdvancedBiomeType.IO_SULFUR_BIOME,          { offset: 0.05, minTemp: 0.2, minPrecip: 0.0 }],
      [AdvancedBiomeType.TRITON_NITROGEN_BIOME,    { offset: 0.00, minTemp: 0.0, minPrecip: 0.0 }],
      [AdvancedBiomeType.CARBONACEOUS_ASTEROID,    { offset: 0.00, minTemp: 0.0, minPrecip: 0.0 }]
    ];

    for (const [name, cfg] of biomes) {
      const descriptor = {
        name,
        offset: cfg.offset,
        minTemp: cfg.minTemp,
        minPrecip: cfg.minPrecip,
        modulateHeight(elevation) {
          for (let i = 0; i < elevation.length; i++) {
            elevation[i] += cfg.offset;
          }
        },
        isSuitable(temperature, precipitation) {
          return temperature >= cfg.minTemp && precipitation >= cfg.minPrecip;
        }
      };
      this.registerBiome(name, descriptor);
    }
  }

  // ------------------------------------------------------------------------
  // Advanced tile generation
  // ------------------------------------------------------------------------

  /**
   * Generates a tile with full geological and volumetric depth.
   *
   * @param {object} tileInfo – { tileX, tileY, tileZ, lod }
   * @param {object} options
   * @returns {{
   *   terrain: HeightmapTerrain,
   *   rivers: object,
   *   waterTable: Float32Array,
   *   lakeMask: Uint8Array,
   *   subsurface: SubsurfaceColumn,
   *   minerals: ScatterMarkerBuffer,
   *   derived: object,
   *   markers: ScatterMarkerBuffer
   * }}
   */
  generateTileWithDepth(tileInfo, options = {}) {
    // 1. Use LOD-aware fidelity config if not overridden.
    const lod = tileInfo.lod ?? 0;
    const fidelity = this.lodFidelity.configForLod(lod);
    const resolution = options.resolution ?? fidelity.resolution;

    // 2. Generate the base terrain with the extended generator.
    const baseOpts = {
      ...options,
      resolution,
      erosionIterations: options.erosionIterations ?? fidelity.erosionIterations
    };
    const { terrain, markers } = this.generateTileWithScatter(tileInfo, baseOpts);

    // 3. Apply tectonic modification (uplift/subsidence).
    this.tectonics.applyTectonicModification(
      terrain.elevation, terrain.resolution, terrain.tileWorldSize,
      tileInfo.tileX ?? 0, tileInfo.tileY ?? 0
    );

    // 4. Apply volcano and crater modifications.
    const volcanoes = this.volcanics.placeVolcanoes(
      Math.ceil(terrain.tileWorldSize / 100), Math.ceil(terrain.tileWorldSize / 100),
      terrain.tileWorldSize, options.volcanoDensity ?? 0.01
    );
    this.volcanics.applyVolcanoes(
      terrain.elevation, terrain.resolution, terrain.tileWorldSize,
      tileInfo.tileX ?? 0, tileInfo.tileY ?? 0, volcanoes
    );

    const craters = this.impactCraters.generateCraters(
      Math.ceil(terrain.tileWorldSize / 100), Math.ceil(terrain.tileWorldSize / 100),
      terrain.tileWorldSize, options.craterDensity ?? 0.02
    );
    this.impactCraters.applyCraters(
      terrain.elevation, terrain.resolution, terrain.tileWorldSize,
      tileInfo.tileX ?? 0, tileInfo.tileY ?? 0, craters
    );

    // 5. Smooth biome transitions.
    this.biomeTransition.smoothBiomeWeights(terrain, options.biomeBlend ?? 0.2);

    // 6. Apply climate modifiers if a climate is provided.
    if (options.climate) {
      this.climateMods.apply(terrain, options.climate);
    }

    // 7. Build river network.
    const flow = TerrainErosion.flowAccumulation(terrain.elevation, terrain.resolution);
    const lakeMask = RiverNetworkBuilder.fillLakes(
      terrain.elevation, terrain.resolution, flow,
      { flowThreshold: 300, minFlowForLake: 300, tileWorldSize: terrain.tileWorldSize }
    );
    const rivers = RiverNetworkBuilder.build(
      terrain.elevation, terrain.resolution, flow,
      tileInfo.tileX ?? 0, tileInfo.tileY ?? 0, lod,
      {
        flowThreshold: 200,
        cellSize: terrain.tileWorldSize / (terrain.resolution - 1),
        tileWorldSize: terrain.tileWorldSize
      }
    );

    // 8. Compute water table.
    const waterTable = this.waterTable.computeWaterTable(
      terrain, options.precipitation ?? 0.5, options.porosity ?? 0.3
    );
    this.waterTable.findWaterFeatures(
      terrain, waterTable,
      tileInfo.tileX ?? 0, tileInfo.tileY ?? 0, lod, markers
    );

    // 9. Build subsurface column for this tile.
    const subsurface = this._buildSubsurfaceColumn(terrain, options);

    // 10. Scan for mineral deposits.
    const minerals = new ScatterMarkerBuffer(1024);
    this.minerals.scanTerrain(
      terrain, tileInfo.tileX ?? 0, tileInfo.tileY ?? 0, lod, minerals, subsurface
    );

    // 11. Scan for archaeological sites on flat terrain.
    if (options.scanArchaeology !== false && lod <= 5) {
      this.archaeology.scanForSettlements(
        terrain, tileInfo.tileX ?? 0, tileInfo.tileY ?? 0, lod, markers
      );
    }

    // 12. Apply anisotropic detail passes.
    if (options.climate) {
      if (options.climate.wind > 0.5) {
        this.anisotropic.applyWindStreaks(terrain, options.climate.windDirection ?? 0, 0.02, 20);
      }
      this.anisotropic.applyWaterFlowMarks(terrain, flow, 0.02);
    }

    // 13. Apply micro detail lamination.
    this.detailLamination.apply(terrain, options.microAmplitude ?? 0.3, options.microScale ?? 5);

    // 14. Compute derived data (curvature, slope, aspect, AO, cavity).
    const derived = TerrainDerivedData.compute(terrain);
    derived.ao = CavityAO.computeAO(terrain, 8);
    derived.cavity = CavityAO.computeCavity(terrain);

    // 15. Refresh terrain bounds after all modifications.
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < terrain.elevation.length; i++) {
      if (terrain.elevation[i] < minH) minH = terrain.elevation[i];
      if (terrain.elevation[i] > maxH) maxH = terrain.elevation[i];
    }
    terrain.minElevation = minH;
    terrain.maxElevation = maxH;
    terrain.heightRange = Math.max(maxH - minH, 1e-9);
    terrain._boundingBox = null;
    terrain._boundingSphere = null;

    return {
      terrain,
      rivers,
      lakeMask,
      waterTable,
      subsurface,
      minerals,
      derived,
      markers
    };
  }

  /**
   * Builds a subsurface column for a tile based on its dominant composition.
   */
  _buildSubsurfaceColumn(terrain, options = {}) {
    const col = new SubsurfaceColumn(options.maxSubsurfaceLayers ?? 8);

    // Stratigraphy depends on the terrain type and biome.
    // A simple layered model: soil → subsoil → bedrock.
    const soilDepth = options.soilDepth ?? 2.0;
    const subsoilDepth = options.subsoilDepth ?? 5.0;
    const bedrockDepth = options.bedrockDepth ?? 20.0;

    col.addLayer(0, soilDepth, SubsurfaceComposition.SANDSTONE, 0.4, 0.5, 0.2, 0);
    col.addLayer(soilDepth, subsoilDepth, SubsurfaceComposition.SHALE, 0.6, 0.2, 0.1, 0.05);
    col.addLayer(subsoilDepth, bedrockDepth, SubsurfaceComposition.LIMESTONE, 0.7, 0.3, 0.3, 0.15);
    col.addLayer(bedrockDepth, bedrockDepth * 2, SubsurfaceComposition.GRANITE, 0.9, 0.05, 0.05, 0.02);

    return col;
  }

  // ------------------------------------------------------------------------
  // Context-driven deformation
  // ------------------------------------------------------------------------

  /**
   * Applies a causal event (impact, explosion, mining) as a deformation to
   * a terrain tile.
   *
   * @param {HeightmapTerrain} terrain – the tile to deform
   * @param {object} event – { x, y, radius, depth, rimHeight, type }
   */
  applyContextDeformation(terrain, event) {
    this.deformations.applyDeformation(terrain, event);
  }

  /**
   * Returns the list of deformations applied to a tile.
   */
  getDeformations(tileKey) {
    return this.deformations.getDeformations(tileKey);
  }

  // ------------------------------------------------------------------------
  // Derived data
  // ------------------------------------------------------------------------

  /**
   * Computes all derived data layers for a terrain tile.
   */
  computeDerivedData(terrain) {
    const derived = TerrainDerivedData.compute(terrain);
    derived.ao = CavityAO.computeAO(terrain, 8);
    derived.cavity = CavityAO.computeCavity(terrain);
    return derived;
  }

  // ------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------

  dispose() {
    super.dispose();
    this.deformations.clear();
  }
}

// ---------------------------------------------------------------------------
// 21. INSTALLER
// ---------------------------------------------------------------------------

/**
 * installAdvancedTerrainExtensions — augments an existing generator
 * (base or extended) in place with every advanced feature.
 */
export function installAdvancedTerrainExtensions(generator) {
  if (!generator || typeof generator.registerTerrainGenerator !== 'function') {
    throw new Error('installAdvancedTerrainExtensions requires a ProceduralTerrainGenerator');
  }

  // Create a temporary AdvancedTerrainGenerator to harvest its registrations.
  const temp = new AdvancedTerrainGenerator({
    resolution: generator.options.resolution,
    seed: generator.options.seed
  });

  // Copy every advanced terrain generator.
  for (const [typeId, fn] of temp.terrainGenerators) {
    if (!generator.terrainGenerators.has(typeId)) {
      generator.registerTerrainGenerator(typeId, fn);
    }
  }

  // Copy every advanced biome.
  for (const [name, cls] of temp.biomeRegistry) {
    if (!generator.biomeRegistry.has(name)) {
      generator.registerBiome(name, cls);
    }
  }

  // Attach advanced subsystem instances.
  generator.tectonics = temp.tectonics;
  generator.volcanics = temp.volcanics;
  generator.impactCraters = temp.impactCraters;
  generator.minerals = temp.minerals;
  generator.biomeTransition = temp.biomeTransition;
  generator.climateMods = temp.climateMods;
  generator.deformations = temp.deformations;
  generator.waterTable = temp.waterTable;
  generator.anisotropic = temp.anisotropic;
  generator.detailLamination = temp.detailLamination;
  generator.archaeology = temp.archaeology;
  generator.lodFidelity = temp.lodFidelity;

  // Attach advanced methods.
  generator.generateTileWithDepth = function (tileInfo, options) {
    return AdvancedTerrainGenerator.prototype.generateTileWithDepth.call(this, tileInfo, options);
  };
  generator.applyContextDeformation = function (terrain, event) {
    return AdvancedTerrainGenerator.prototype.applyContextDeformation.call(this, terrain, event);
  };
  generator.getDeformations = function (tileKey) {
    return AdvancedTerrainGenerator.prototype.getDeformations.call(this, tileKey);
  };
  generator.computeDerivedData = function (terrain) {
    return AdvancedTerrainGenerator.prototype.computeDerivedData.call(this, terrain);
  };
  generator._buildSubsurfaceColumn = function (terrain, options) {
    return AdvancedTerrainGenerator.prototype._buildSubsurfaceColumn.call(this, terrain, options);
  };

  temp.dispose();
  return generator;
}

// ---------------------------------------------------------------------------
// 22. FACTORY
// ---------------------------------------------------------------------------

/**
 * Creates an AdvancedTerrainGenerator pre-populated with every base,
 * extended, and advanced feature.
 */
export function createAdvancedTerrainGenerator(options = {}) {
  return new AdvancedTerrainGenerator({
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
    seasonalCacheCapacity: options.seasonalCacheCapacity ?? 512,
    plateCount: options.plateCount ?? 12,
    maxLod: options.maxLod ?? 12,
    targetFrameMs: options.targetFrameMs ?? 8,
    ...options
  });
}

// ---------------------------------------------------------------------------
// 23. BARREL EXPORT
// ---------------------------------------------------------------------------

export default {
  AdvancedTerrainGenerator,
  AdvancedTerrainType,
  AdvancedBiomeType,
  AdvancedScatterParams,
  AdvancedScatterParams as ScatterAdvancedParams,
  SubsurfaceLayer,
  SubsurfaceColumn,
  SubsurfaceComposition,
  MineralType,
  MineralDepositSystem,
  RiverNetworkBuilder,
  TectonicPlateSimulator,
  VolcanicActivitySimulator,
  ImpactCraterSystem,
  BiomeTransitionZoneSystem,
  ClimateAdaptiveModifiers,
  ContextDrivenDeformation,
  WaterTableModel,
  AnisotropicDetailPass,
  CavityAO,
  TerrainDerivedData,
  DetailLamination,
  ArchaeologyMarkerSystem,
  LODFidelitySystem,
  ScatterRockShape,
  ScatterTreeShape,
  installAdvancedTerrainExtensions,
  createAdvancedTerrainGenerator
};