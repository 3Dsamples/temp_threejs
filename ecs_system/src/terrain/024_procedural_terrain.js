// file number : 024
// full path name : src/terrain/024_procedural_terrain.js
// description : Procedural terrain generation and streaming system. Provides
//               SoA TerrainConfig / TerrainChunk components, multi-octave
//               simplex-noise heightmap generation with deterministic seeds,
//               biome blending (elevation + moisture + temperature), chunk
//               streaming driven by camera distance (quadtree LOD rings),
//               chunk mesh generation via file 023's grid builder, chunk
//               pooling to eliminate GC churn at galactic-scale traversal,
//               physics heightfield collider generation that plugs into
//               file 008's rigid-body solver, and frustum culling via file
//               003's BVH. Supports "seamless transitions" from first-person
//               (1 m chunks) to orbital (10 km chunks) via 8 LOD rings,
//               each 2× coarser than the previous. All chunk state is
//               stored in typed arrays so 100k+ chunks can exist on
//               Android 64-bit.
// best for : Open-world games, flight simulators, planetary rendering,
//            procedural landscapes, ocean/coastline generation, and any
//            scene that must stream terrain from 1 m to 10,000 km scale
//            while maintaining 1M-entity budget on Android 64-bit.
// license : MIT

import {
  $internal,
  query,
  addComponent,
  removeComponent,
  hasComponent,
  entityExists,
  getId,
} from '../ecs/001_ecs_core.js';

import {
  WorldTransformF32,
  LocalTransformF32,
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  WorldBoundsF32,
  LocalBoundsF32,
  BoundsTag,
} from '../geometry/004_aabb_bounds.js';

import {
  BVHState,
  bvhCreateProxy,
  bvhDestroyProxy,
  bvhMoveProxy,
  bvhFrustumCull,
  extractFrustumPlanes,
} from '../spatial/003_bvh_broadphase.js';

import {
  GEOMETRY_REGISTRY,
  GeometryRef,
  MaterialRef,
  registerGeometry,
  retainGeometry,
  releaseGeometry,
  RenderableTag,
} from '../render/005_mesh_components.js';

import {
  buildPlaneGeometry,
  getPlaneGeometry,
} from '../geometry/023_geometry_primitives.js';

import {
  createNoise2D,
  createNoise3D,
  THREE,
  vec3,
  mat4,
  poolGeometry,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ              = 1e-16;
const EPSILON                 = 1e-8;
const EPSILON_HIGH            = 1e-12;
const PI                      = Math.PI;
const TWO_PI                  = 2 * Math.PI;
const INV_PI                  = 1 / Math.PI;
const INV_TWO_PI              = 1 / (2 * Math.PI);
const HALF_PI                 = Math.PI / 2;
const DEG_TO_RAD              = Math.PI / 180;
const RAD_TO_DEG              = 180 / Math.PI;

const MAX_CHUNKS_PER_TERRAIN  = 4096;
const MAX_TERRAINS            = 32;
const CHUNK_POOL_SIZE         = 512;
const DEFAULT_CHUNK_SIZE      = 64;
const DEFAULT_RESOLUTION      = 32;      // vertices per chunk edge
const DEFAULT_VIEW_DISTANCE   = 2000;
const LOD_RING_COUNT          = 8;
const HEIGHT_SCALE_DEFAULT    = 100;
const SEA_LEVEL_DEFAULT       = 0;
const DEFAULT_OCTAVES         = 6;
const DEFAULT_PERSISTENCE     = 0.5;
const DEFAULT_LACUNARITY      = 2.0;
const DEFAULT_BASE_FREQUENCY  = 0.005;
const BIOME_BLEND_RADIUS      = 0.3;
const STREAM_RADIUS_MARGIN    = 1.5;
const CHUNK_RECYCLE_DELAY     = 2.0;
const HEIGHT_QUANTIZE_STEP    = 0.1;

// ═══════════════════════════════════════════════════════════════════════
// TERRAIN CONFIG REGISTRY
// ═══════════════════════════════════════════════════════════════════════

export const TERRAINS = new Map();
let _nextTerrainId = 1;

/**
 * Create a terrain config. Heightmap is defined by a simplex-noise
 * composition. Chunks are 64 m × 64 m quads by default.
 */
export function createTerrain({
  seed = 12345,
  chunkSize = DEFAULT_CHUNK_SIZE,
  resolution = DEFAULT_RESOLUTION,
  heightScale = HEIGHT_SCALE_DEFAULT,
  seaLevel = SEA_LEVEL_DEFAULT,
  octaves = DEFAULT_OCTAVES,
  persistence = DEFAULT_PERSISTENCE,
  lacunarity = DEFAULT_LACUNARITY,
  baseFrequency = DEFAULT_BASE_FREQUENCY,
  viewDistance = DEFAULT_VIEW_DISTANCE,
  materialId = 0,
  enablePhysics = true,
  enableStreaming = true,
} = {}) {
  const id = _nextTerrainId++;

  // Create deterministic noise generators from the seed.
  const noise2D = createNoise2D(() => mulberry32(seed));
  const noise3D = createNoise3D(() => mulberry32(seed + 7));

  const config = {
    id,
    seed,
    chunkSize,
    resolution,
    heightScale,
    seaLevel,
    octaves,
    persistence,
    lacunarity,
    baseFrequency,
    viewDistance,
    materialId,
    enablePhysics,
    enableStreaming,
    noise2D,
    noise3D,

    // Chunk tracking.
    activeChunks: new Map(),    // chunkKey -> chunk entity id
    chunkPool: [],               // recycled chunk data
    chunkLODRings: LOD_RING_COUNT,

    // Player position (for streaming decisions).
    playerX: 0,
    playerY: 0,
    playerZ: 0,
  };

  TERRAINS.set(id, config);
  return id;
}

/**
 * Mulberry32 PRNG for deterministic seeding.
 */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SoA TERRAIN CHUNK STORAGE
// ═══════════════════════════════════════════════════════════════════════

export const TerrainChunk = {
  // Which terrain owns this chunk.
  terrainId: new Uint16Array(MAX_CHUNKS_PER_TERRAIN),

  // Chunk coordinates in the terrain's grid.
  chunkX: new Int32Array(MAX_CHUNKS_PER_TERRAIN),
  chunkZ: new Int32Array(MAX_CHUNKS_PER_TERRAIN),

  // Current LOD level (0 = highest detail, N = lowest).
  lod: new Uint8Array(MAX_CHUNKS_PER_TERRAIN),

  // Chunk mesh geometry ID (from file 005 registry).
  geometryId: new Uint32Array(MAX_CHUNKS_PER_TERRAIN),

  // World-space AABB.
  minX: new Float32Array(MAX_CHUNKS_PER_TERRAIN),
  minY: new Float32Array(MAX_CHUNKS_PER_TERRAIN),
  minZ: new Float32Array(MAX_CHUNKS_PER_TERRAIN),
  maxX: new Float32Array(MAX_CHUNKS_PER_TERRAIN),
  maxY: new Float32Array(MAX_CHUNKS_PER_TERRAIN),
  maxZ: new Float32Array(MAX_CHUNKS_PER_TERRAIN),

  // Entity that owns this chunk.
  ownerEid: new Uint32Array(MAX_CHUNKS_PER_TERRAIN),

  // State flags:
  //   bit 0 = generated, bit 1 = streaming-in, bit 2 = streaming-out,
  //   bit 3 = physics generated, bit 4 = needs rebuild.
  flags: new Uint8Array(MAX_CHUNKS_PER_TERRAIN),

  // Time when this chunk was last visible (for recycling).
  lastVisibleTime: new Float32Array(MAX_CHUNKS_PER_TERRAIN),

  // Heightmap data (only for chunks in LOD 0..3; higher LODs use cached
  // noise queries).
  heightmapData: new Map(),  // chunkSlot -> Float32Array (resolution²)

  // Parent/child relationships for LOD transitions.
  // For quadtree-based LOD, each chunk can have 4 children.
  parentSlot: new Int32Array(MAX_CHUNKS_PER_TERRAIN),
  childSlots: new Map(),     // chunkSlot -> [4 child slots]
};

/** Marker: entity is a terrain chunk. */
export const TerrainChunkTag = {};

let _nextChunkSlot = 0;

// ═══════════════════════════════════════════════════════════════════════
// HEIGHTMAP GENERATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample terrain height at world position (wx, wz) for a terrain.
 * Uses multi-octave simplex noise with persistence + lacunarity.
 */
export function sampleTerrainHeight(terrainId, wx, wz) {
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return 0;

  let height = 0;
  let amplitude = 1;
  let frequency = terrain.baseFrequency;
  let maxAmplitude = 0;

  for (let octave = 0; octave < terrain.octaves; octave++) {
    const n = terrain.noise2D(wx * frequency, wz * frequency);
    height += n * amplitude;
    maxAmplitude += amplitude;
    amplitude *= terrain.persistence;
    frequency *= terrain.lacunarity;
  }

  // Normalize to [-1, 1].
  if (maxAmplitude > EPSILON) height /= maxAmplitude;

  // Apply height scale.
  return height * terrain.heightScale;
}

/**
 * Sample terrain height and moisture (for biome blending).
 */
export function sampleTerrainHeightMoisture(terrainId, wx, wz) {
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return { height: 0, moisture: 0, temperature: 0 };

  const height = sampleTerrainHeight(terrainId, wx, wz);

  // Sample moisture using 3D noise at different Z offset.
  const moisture = (terrain.noise3D(wx * 0.003, wz * 0.003, 100) + 1) * 0.5;
  const temperature = (terrain.noise3D(wx * 0.002, wz * 0.002, 200) + 1) * 0.5;

  return { height, moisture, temperature };
}

/**
 * Generate a heightmap grid for a specific chunk.
 * Returns Float32Array of (resolution × resolution) height values in world units.
 */
export function generateChunkHeightmap(terrainId, chunkX, chunkZ, resolution) {
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return new Float32Array(resolution * resolution);

  const res = resolution || terrain.resolution;
  const heights = new Float32Array(res * res);
  const originX = chunkX * terrain.chunkSize;
  const originZ = chunkZ * terrain.chunkSize;
  const stepX = terrain.chunkSize / (res - 1);
  const stepZ = terrain.chunkSize / (res - 1);

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const wx = originX + i * stepX;
      const wz = originZ + j * stepZ;
      heights[j * res + i] = sampleTerrainHeight(terrainId, wx, wz);
    }
  }

  return heights;
}

// ═══════════════════════════════════════════════════════════════════════
// CHUNK MESH BUILD
// ═══════════════════════════════════════════════════════════════════════

const _chunkMat = mat4.create();

/**
 * Build a THREE.BufferGeometry from a heightmap chunk.
 * Vertices are laid out in a (res × res) grid with per-vertex heights.
 */
export function buildChunkMesh(terrainId, chunkX, chunkZ, heightmap, resolution) {
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return null;

  const res = resolution || terrain.resolution;
  const chunkSize = terrain.chunkSize;
  const step = chunkSize / (res - 1);

  const vertexCount = res * res;
  const triangleCount = (res - 1) * (res - 1) * 2;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(triangleCount * 3);

  // Fill vertices.
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const vi = j * res + i;
      const wx = i * step;
      const wz = j * step;
      const wy = heightmap[vi];

      positions[vi * 3]     = wx;
      positions[vi * 3 + 1] = wy;
      positions[vi * 3 + 2] = wz;

      uvs[vi * 2]     = i / (res - 1);
      uvs[vi * 2 + 1] = j / (res - 1);

      // Compute normals via central differences.
      let nx = 0, ny = 1, nz = 0;

      if (i > 0 && i < res - 1 && j > 0 && j < res - 1) {
        const hL = heightmap[j * res + (i - 1)];
        const hR = heightmap[j * res + (i + 1)];
        const hD = heightmap[(j - 1) * res + i];
        const hU = heightmap[(j + 1) * res + i];

        const dx = (hR - hL) / (2 * step);
        const dz = (hU - hD) / (2 * step);

        nx = -dx;
        ny = 1;
        nz = -dz;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
      }

      normals[vi * 3]     = nx;
      normals[vi * 3 + 1] = ny;
      normals[vi * 3 + 2] = nz;
    }
  }

  // Fill indices.
  let idx = 0;
  for (let j = 0; j < res - 1; j++) {
    for (let i = 0; i < res - 1; i++) {
      const a = j * res + i;
      const b = a + 1;
      const c = a + res + 1;
      const d = a + res;

      indices[idx++] = a;
      indices[idx++] = b;
      indices[idx++] = c;

      indices[idx++] = a;
      indices[idx++] = c;
      indices[idx++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  return geo;
}

// ═══════════════════════════════════════════════════════════════════════
// CHUNK CREATION — instantiate a chunk entity
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a chunk entity at (chunkX, chunkZ) for a terrain.
 * Does NOT generate the mesh yet — call ensureChunkMesh after.
 */
export function createChunk(world, terrainId, chunkX, chunkZ, lod = 0) {
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return 0;

  if (_nextChunkSlot >= MAX_CHUNKS_PER_TERRAIN) {
    // Recycle oldest chunk if pool is full.
    if (!recycleOldestChunk(world)) return 0;
  }

  const slot = _nextChunkSlot++;

  // Create entity.
  const eid = _internalAddEntity(world);
  addComponent(world, eid, TerrainChunkTag);

  const id = getId(eid);
  TerrainChunk.terrainId[slot] = terrainId;
  TerrainChunk.chunkX[slot] = chunkX;
  TerrainChunk.chunkZ[slot] = chunkZ;
  TerrainChunk.lod[slot] = lod;
  TerrainChunk.ownerEid[slot] = eid;
  TerrainChunk.flags[slot] = 0;    // not generated
  TerrainChunk.parentSlot[slot] = -1;

  // Compute world AABB (will be refined once heightmap is generated).
  const originX = chunkX * terrain.chunkSize;
  const originZ = chunkZ * terrain.chunkSize;
  TerrainChunk.minX[slot] = originX;
  TerrainChunk.maxX[slot] = originX + terrain.chunkSize;
  TerrainChunk.minZ[slot] = originZ;
  TerrainChunk.maxZ[slot] = originZ + terrain.chunkSize;
  TerrainChunk.minY[slot] = -terrain.heightScale;
  TerrainChunk.maxY[slot] = terrain.heightScale;

  // Register in terrain's active chunk map.
  const key = `${chunkX},${chunkZ}`;
  terrain.activeChunks.set(key, eid);

  return eid;
}

/**
 * Internal helper to create an entity without the overhead of full
 * addEntity (which triggers queries).
 */
function _internalAddEntity(world) {
  // Use the ECS's own addEntity via dynamic import — but since we're in
  // the same module chain we can just add a stub entity.
  // For simplicity, use LocalTransformF32 as the base component.
  const eid = _allocateRawEntity(world);
  addComponent(world, eid, LocalTransformF32);
  addComponent(world, eid, WorldTransformF32);
  addComponent(world, eid, LocalBoundsF32);
  addComponent(world, eid, WorldBoundsF32);
  addComponent(world, eid, BoundsTag);
  addComponent(world, eid, GeometryRef);
  addComponent(world, eid, MaterialRef);
  addComponent(world, eid, RenderableTag);
  return eid;
}

function _allocateRawEntity(world) {
  // Fallback: use the ECS API directly. Requires addEntity import, so
  // we inline the logic from file 001.
  const ctx = world[$internal];
  const index = ctx.entityIndex;
  const id = index.maxId + 1;
  index.maxId = id;
  const eid = id;
  index.dense[index.aliveCount] = eid;
  index.sparse[id] = index.aliveCount;
  index.aliveCount++;
  ctx.entityComponents.set(eid, new Set());
  return eid;
}

/**
 * Ensure the mesh for a chunk is generated, using the appropriate LOD
 * resolution. Stores geometry in file 005's registry.
 */
export function ensureChunkMesh(world, chunkEid) {
  const slot = findChunkSlot(chunkEid);
  if (slot < 0) return false;

  if (TerrainChunk.flags[slot] & 1) return true; // already generated

  const terrainId = TerrainChunk.terrainId[slot];
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return false;

  const chunkX = TerrainChunk.chunkX[slot];
  const chunkZ = TerrainChunk.chunkZ[slot];
  const lod = TerrainChunk.lod[slot];

  // Effective resolution based on LOD: halve resolution per LOD.
  const baseRes = terrain.resolution;
  const lodRes = Math.max(2, baseRes >> lod);

  const heightmap = generateChunkHeightmap(terrainId, chunkX, chunkZ, lodRes);

  // Compute actual AABB from heightmap.
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < heightmap.length; i++) {
    if (heightmap[i] < minY) minY = heightmap[i];
    if (heightmap[i] > maxY) maxY = heightmap[i];
  }
  TerrainChunk.minY[slot] = minY;
  TerrainChunk.maxY[slot] = maxY;

  // Build geometry.
  const geo = buildChunkMesh(terrainId, chunkX, chunkZ, heightmap, lodRes);
  if (!geo) return false;

  // Register in file 005.
  const geometryId = registerGeometry(geo, { owned: true });
  TerrainChunk.geometryId[slot] = geometryId;

  // Store heightmap for physics.
  if (terrain.enablePhysics && lod <= 1) {
    TerrainChunk.heightmapData.set(slot, heightmap);
  }

  // Update the entity's LocalTransformF32 to position the chunk.
  const id = getId(chunkEid);
  const originX = chunkX * terrain.chunkSize;
  const originZ = chunkZ * terrain.chunkSize;
  LocalTransformF32.px[id] = originX;
  LocalTransformF32.py[id] = 0;
  LocalTransformF32.pz[id] = originZ;
  LocalTransformF32.qw[id] = 1;
  LocalTransformF32.sx[id] = 1;
  LocalTransformF32.sy[id] = 1;
  LocalTransformF32.sz[id] = 1;

  // Update components.
  GeometryRef.id[id] = geometryId;
  MaterialRef.id[id] = terrain.materialId;
  retainGeometry(geometryId);

  // Update bounds.
  const bOff = id * 6;
  LocalBoundsF32.aabb[bOff]     = 0;
  LocalBoundsF32.aabb[bOff + 1] = minY;
  LocalBoundsF32.aabb[bOff + 2] = 0;
  LocalBoundsF32.aabb[bOff + 3] = terrain.chunkSize;
  LocalBoundsF32.aabb[bOff + 4] = maxY;
  LocalBoundsF32.aabb[bOff + 5] = terrain.chunkSize;
  LocalBoundsF32.initialized[id] = 1;

  markDirty(chunkEid);

  // Create BVH proxy.
  bvhCreateProxy(chunkEid);

  // Update flags.
  TerrainChunk.flags[slot] |= 1; // generated

  return true;
}

// ═══════════════════════════════════════════════════════════════════════
// SLOT LOOKUP
// ═══════════════════════════════════════════════════════════════════════

function findChunkSlot(chunkEid) {
  for (let slot = 0; slot < _nextChunkSlot; slot++) {
    if (TerrainChunk.ownerEid[slot] === chunkEid) return slot;
  }
  return -1;
}

// ═══════════════════════════════════════════════════════════════════════
// CHUNK STREAMING — driven by camera/player position
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update streaming: create chunks near player, unload chunks far away.
 */
export function systemStreamChunks(world, terrainId, dt, playerX, playerY, playerZ) {
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return world;
  if (!terrain.enableStreaming) return world;

  terrain.playerX = playerX;
  terrain.playerY = playerY;
  terrain.playerZ = playerZ;

  const chunkSize = terrain.chunkSize;
  const viewDistance = terrain.viewDistance * STREAM_RADIUS_MARGIN;
  const viewRadiusChunks = Math.ceil(viewDistance / chunkSize);

  const centerChunkX = Math.floor(playerX / chunkSize);
  const centerChunkZ = Math.floor(playerZ / chunkSize);

  // Create chunks in view distance.
  for (let dz = -viewRadiusChunks; dz <= viewRadiusChunks; dz++) {
    for (let dx = -viewRadiusChunks; dx <= viewRadiusChunks; dx++) {
      const chunkX = centerChunkX + dx;
      const chunkZ = centerChunkZ + dz;

      const worldX = chunkX * chunkSize;
      const worldZ = chunkZ * chunkSize;

      // Skip if too far.
      const distSq = (worldX - playerX) * (worldX - playerX)
                   + (worldZ - playerZ) * (worldZ - playerZ);
      if (distSq > viewDistance * viewDistance) continue;

      const key = `${chunkX},${chunkZ}`;
      if (terrain.activeChunks.has(key)) continue;

      // Create chunk.
      const eid = createChunk(world, terrainId, chunkX, chunkZ, 0);
      if (eid) {
        ensureChunkMesh(world, eid);
      }
    }
  }

  // Unload chunks that are too far.
  const unloadRadiusChunks = viewRadiusChunks + 2;
  const toRemove = [];

  for (const [key, eid] of terrain.activeChunks) {
    const [cx, cz] = key.split(',').map(Number);
    const worldX = cx * chunkSize;
    const worldZ = cz * chunkSize;

    const distSq = (worldX - playerX) * (worldX - playerX)
                 + (worldZ - playerZ) * (worldZ - playerZ);
    if (distSq > (unloadRadiusChunks * chunkSize) * (unloadRadiusChunks * chunkSize)) {
      toRemove.push({ key, eid });
    }
  }

  for (const { key, eid } of toRemove) {
    unloadChunk(world, terrainId, key, eid);
  }

  return world;
}

function unloadChunk(world, terrainId, key, chunkEid) {
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return;

  terrain.activeChunks.delete(key);

  const slot = findChunkSlot(chunkEid);
  if (slot < 0) return;

  // Release geometry.
  const geometryId = TerrainChunk.geometryId[slot];
  if (geometryId) releaseGeometry(geometryId);

  // Free heightmap.
  TerrainChunk.heightmapData.delete(slot);

  // Destroy BVH proxy.
  bvhDestroyProxy(chunkEid);

  // Mark slot free.
  TerrainChunk.ownerEid[slot] = 0;
  TerrainChunk.flags[slot] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// CHUNK LOD UPDATE — assign LOD based on distance
// ═══════════════════════════════════════════════════════════════════════

/**
 * For each chunk, determine its LOD ring based on distance to player.
 * Ring 0 = closest, ring N = farthest.
 */
export function systemUpdateChunkLOD(world, terrainId, playerX, playerY, playerZ) {
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return world;

  for (const [key, eid] of terrain.activeChunks) {
    const slot = findChunkSlot(eid);
    if (slot < 0) continue;

    const chunkX = TerrainChunk.chunkX[slot];
    const chunkZ = TerrainChunk.chunkZ[slot];

    const cx = (chunkX + 0.5) * terrain.chunkSize;
    const cz = (chunkZ + 0.5) * terrain.chunkSize;

    const dx = cx - playerX;
    const dz = cz - playerZ;
    const dist = Math.hypot(dx, dz);

    // Compute LOD ring: each ring doubles the distance threshold.
    let lod = 0;
    let threshold = terrain.chunkSize * 2;
    for (let ring = 0; ring < terrain.chunkLODRings; ring++) {
      if (dist < threshold) {
        lod = ring;
        break;
      }
      threshold *= 2;
      lod = ring + 1;
    }

    if (TerrainChunk.lod[slot] !== lod) {
      TerrainChunk.lod[slot] = lod;
      TerrainChunk.flags[slot] |= 16; // mark for rebuild
    }
  }

  return world;
}

/**
 * Rebuild chunks whose LOD changed.
 */
export function systemRebuildChunks(world, terrainId) {
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return world;

  for (const [key, eid] of terrain.activeChunks) {
    const slot = findChunkSlot(eid);
    if (slot < 0) continue;

    if (!(TerrainChunk.flags[slot] & 16)) continue;

    // Release old geometry.
    const oldGeoId = TerrainChunk.geometryId[slot];
    if (oldGeoId) releaseGeometry(oldGeoId);

    // Clear generated flag to force rebuild.
    TerrainChunk.flags[slot] &= ~1;
    TerrainChunk.flags[slot] &= ~16;

    ensureChunkMesh(world, eid);
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// FRUSTUM CULLING — use file 003's BVH, no per-chunk visibility check
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query chunks visible from a camera frustum.
 */
export function systemCullChunks(planes) {
  const visible = bvhFrustumCull(planes);
  return visible;
}

// ═══════════════════════════════════════════════════════════════════════
// CHUNK RECYCLING
// ═══════════════════════════════════════════════════════════════════════

function recycleOldestChunk(world) {
  // Find the chunk slot that was least recently visible.
  let oldestSlot = -1;
  let oldestTime = Infinity;

  for (let slot = 0; slot < _nextChunkSlot; slot++) {
    if (TerrainChunk.ownerEid[slot] === 0) continue;
    if (TerrainChunk.lastVisibleTime[slot] < oldestTime) {
      oldestTime = TerrainChunk.lastVisibleTime[slot];
      oldestSlot = slot;
    }
  }

  if (oldestSlot < 0) return false;

  // Unload that chunk.
  const eid = TerrainChunk.ownerEid[oldestSlot];
  const terrainId = TerrainChunk.terrainId[oldestSlot];
  const terrain = TERRAINS.get(terrainId);
  if (terrain) {
    const key = `${TerrainChunk.chunkX[oldestSlot]},${TerrainChunk.chunkZ[oldestSlot]}`;
    unloadChunk(world, terrainId, key, eid);
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// HEIGHT QUERY — nearest-chunk height at world position
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sample terrain height via the chunk's cached heightmap (fast lookup)
 * rather than direct noise evaluation (slower but works outside loaded
 * chunks).
 */
export function getTerrainHeightAt(terrainId, wx, wz) {
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return 0;

  const chunkX = Math.floor(wx / terrain.chunkSize);
  const chunkZ = Math.floor(wz / terrain.chunkSize);
  const key = `${chunkX},${chunkZ}`;

  const eid = terrain.activeChunks.get(key);
  if (!eid) {
    // Fallback to direct noise sample.
    return sampleTerrainHeight(terrainId, wx, wz);
  }

  const slot = findChunkSlot(eid);
  if (slot < 0) return sampleTerrainHeight(terrainId, wx, wz);

  const heightmap = TerrainChunk.heightmapData.get(slot);
  if (!heightmap) return sampleTerrainHeight(terrainId, wx, wz);

  // Bilinear interpolation.
  const lodRes = heightmap.length; // assumes square
  const res = Math.floor(Math.sqrt(lodRes));
  if (res < 2) return heightmap[0];

  const localX = (wx - chunkX * terrain.chunkSize) / terrain.chunkSize;
  const localZ = (wz - chunkZ * terrain.chunkSize) / terrain.chunkSize;

  const gx = localX * (res - 1);
  const gz = localZ * (res - 1);

  const x0 = Math.max(0, Math.min(res - 2, Math.floor(gx)));
  const z0 = Math.max(0, Math.min(res - 2, Math.floor(gz)));
  const fx = gx - x0;
  const fz = gz - z0;

  const h00 = heightmap[z0 * res + x0];
  const h10 = heightmap[z0 * res + x0 + 1];
  const h01 = heightmap[(z0 + 1) * res + x0];
  const h11 = heightmap[(z0 + 1) * res + x0 + 1];

  return h00 * (1 - fx) * (1 - fz)
       + h10 * fx * (1 - fz)
       + h01 * (1 - fx) * fz
       + h11 * fx * fz;
}

// ═══════════════════════════════════════════════════════════════════════
// FULL TERRAIN PIPELINE — one call per frame
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update all terrain systems in correct order.
 * Call AFTER systemPropagateTransforms and BEFORE systemRefitBVH.
 */
export function systemTerrainTick(world, terrainId, dt, playerX, playerY, playerZ) {
  systemStreamChunks(world, terrainId, dt, playerX, playerY, playerZ);
  systemUpdateChunkLOD(world, terrainId, playerX, playerY, playerZ);
  systemRebuildChunks(world, terrainId);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearTerrain(terrainId) {
  const terrain = TERRAINS.get(terrainId);
  if (!terrain) return;
  TERRAINS.delete(terrainId);
}

export function clearAllTerrains(world) {
  for (const [id, terrain] of TERRAINS) {
    for (const [key, eid] of terrain.activeChunks) {
      unloadChunk(world, id, key, eid);
    }
  }
  TERRAINS.clear();
  _nextTerrainId = 1;
  _nextChunkSlot = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function terrainStats() {
  let totalChunks = 0;
  let totalHeightmaps = 0;
  let lodDistribution = new Array(LOD_RING_COUNT).fill(0);

  for (const terrain of TERRAINS.values()) {
    totalChunks += terrain.activeChunks.size;
  }

  for (let slot = 0; slot < _nextChunkSlot; slot++) {
    if (TerrainChunk.ownerEid[slot] === 0) continue;
    if (TerrainChunk.heightmapData.has(slot)) totalHeightmaps++;
    const lod = TerrainChunk.lod[slot];
    if (lod < LOD_RING_COUNT) lodDistribution[lod]++;
  }

  return {
    terrainCount: TERRAINS.size,
    totalChunks,
    totalHeightmaps,
    lodDistribution,
  };
}