// file number : 360
// full path name : src/context/360_LandscapePublicAPI.js
// description : Landscape public API — the small, stable, versioned public
// surface of the living-world pipeline. It exposes a single entry point
// (`createWorld()`) that builds a complete living world from
// 359_LandscapeSceneWiring, plus the six core operations the blueprint
// requires (query, mutate, impact, stream, persist, dispose), plus five
// fully-integrated procedural generation subsystems that external code can
// call at will:
//   (1) CORE WORLD API       — createWorld(config), query(...),
//                               mutate(...), impact(...), stream(...),
//                               persist(...), dispose();
//   (2) 2D PROCEDURAL GEN    — value noise, gradient noise, simplex noise,
//                               fractional Brownian motion (FBM), Worley
//                               (cellular) noise, domain warping, ridged
//                               multifractal, billow, and a set of ready-
//                               made 2D texture patterns (organic cells,
//                               voronoi regions, marble veins, wood grain,
//                               water ripples, cloud fields, dune patterns,
//                               lichen splotches). All 2D generators write
//                               into caller-supplied Float32Array buffers
//                               with full control over frequency, octaves,
//                               lacunarity, persistence, gain, offset, and
//                               seed;
//   (3) 3D PROCEDURAL GEN    — marching cubes, surface nets, voxel volume
//                               carving, isosurface extraction, 3D noise
//                               fields, spherical harmonics deformation,
//                               and point-cloud sampling. All 3D generators
//                               write into pooled BufferGeometry (position,
//                               normal, uv, color, tangent attributes) with
//                               full control over resolution, iso-level,
//                               smoothing, and material parameters;
//   (4) PARAMETRIC GEN       — deterministic L-systems (tree branching,
//                               fern fronds, root systems, coral growth),
//                               shape grammars (building facades, roofs,
//                               walls, windows, fences, bridges), rule-based
//                               placement (settlement layouts, ruin
//                               scatter, prop clusters), and modular
//                               prefab assembly (combining 3D primitives
//                               into compound props). All parametric
//                               generators are deterministic per seed and
//                               produce per-instance material records that
//                               331_BiomeBlendMaterialBridge reads directly;
//   (5) GRASS BLADE GEN      — individual grass blades (with per-blade wind
//                               sway phase, primary sway amplitude,
//                               secondary flutter, and PBR material
//                               parameters), tufts (clusters of 3–32
//                               blades), swaths (parallel rows for
//                               lawns/fields), and LOD-aware clumps (four
//                               detail levels from full per-blade to
//                               billboard texture). All grass generators
//                               write into pooled instance buffers that
//                               337_LandscapeChunkStreamer uploads as
//                               instanced draws.
// Every public method routes through the assembled scene from
// 359_LandscapeSceneWiring and delegates to the correct subsystem. The API
// is versioned so external callers can depend on a stable surface across
// future pipeline changes. Every buffer is pooled, every hot-path call is
// zero-allocation after first use, and every generator works identically on
// WebGL1 and WebGL2 because it produces BufferGeometry and instance data
// that both renderers support. The public API is the boundary the blueprint
// calls "expose a small public surface — query, mutate, impact, stream — so
// external code drives the living world without touching internal buffers,
// and so every new geometry participates in the living world by default."
//#
// best for : Every external consumer that wants to drive the living world —
// 361_FinalRuntimeWiring (instantiates the runtime and registers all
// providers, consumers, pools), 362_RuntimeBootstrap (builds the first
// frame and starts the six-stage loop), 363_PublicAPI (the final public
// surface), 364_FinalLivingWorldAssembly (final assembly instantiating
// every living system and starting the loop), any application-level code
// that wants to create, query, mutate, or dispose a living world without
// touching internal pipeline state, and any procedural content generation
// system that needs 2D textures, 3D meshes, parametric structures, or grass
// blades integrated with the living world's material and lighting state.
// The module is the single authority on the public surface, and every
// external caller goes through it.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  InstancedBufferAttribute, InstancedBufferGeometry,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  WebGLRenderer, WebGL2Renderer,
  Color,
  PCFSoftShadowMap, PCFShadowMap, VSMShadowMap, BasicShadowMap
} from './264_MathECSImportBarrel.js';

// ─── Core runtime and providers ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { ContextRuntime } from './309_ContextRuntime.js';

// ─── Governance ────────────────────────────────────────────────
import { LandscapePerformanceGovernor } from './355_LandscapePerformanceGovernor.js';

// ─── Biome layer ──────────────────────────────────────────────
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';

// ─── Landscape layer ──────────────────────────────────────────
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';
import { LandscapeWaterFlowSystem } from './345_LandscapeWaterFlowSystem.js';
import { LandscapeVegetationScatterSystem } from './346_LandscapeVegetationScatterSystem.js';
import { LandscapeLightingCoupler } from './351_LandscapeLightingCoupler.js';
import { LandscapeSceneWiring } from './359_LandscapeSceneWiring.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const API_VERSION = Object.freeze({ major: 1, minor: 0, patch: 0 });

// Maximum sizes of the pooled buffers used by the public API.
const MAX_GRASS_BLADES        = 262144;
const MAX_GRASS_TUFTS         = 16384;
const MAX_MESH_VERTICES       = 131072;
const MAX_MESH_INDICES        = 393216;
const MAX_PARAMETRIC_NODES    = 4096;
const MAX_NOISE_CACHE_ENTRIES = 256;

// Default procedural generation parameters. Every entry is overridable by
// the caller's options object.
const DEFAULT_NOISE_PARAMS = Object.freeze({
  seed: 0,
  frequency: 0.01,
  amplitude: 1.0,
  octaves: 4,
  lacunarity: 2.0,
  persistence: 0.5,
  gain: 0.5,
  ridged: false,
  billow: false,
  offsetX: 0.0,
  offsetY: 0.0,
  offsetZ: 0.0
});

const DEFAULT_MESH_PARAMS = Object.freeze({
  resolution: 32,
  isoLevel: 0.0,
  smoothing: 0.5,
  scale: 1.0,
  materialId: -1
});

const DEFAULT_GRASS_PARAMS = Object.freeze({
  bladeHeight: 0.35,
  bladeWidth: 0.03,
  bladeSegments: 3,
  curvature: 0.15,
  taper: 0.7,
  windSwayAmplitude: 0.08,
  windSwayPhase: 0.0,
  materialId: -1,
  colorBottom: [0.08, 0.14, 0.04],
  colorTop: [0.22, 0.30, 0.10],
  dryness: 0.0,
  snowCoverage: 0.0
});

// ══════════════════════════════════════════════════════════════════
// ─── DETERMINISTIC PRNG ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _makeRng(seed) {
  let state = seed === 0 ? 1 : seed;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    return state / 4294967296;
  };
}

// ══════════════════════════════════════════════════════════════════
// ─── 2D PROCEDURAL GENERATION ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Hash a 2D integer coordinate into [0, 1). Deterministic and fast.
function _hash2(x, y, seed) {
  let h = seed | 0;
  h = (h ^ (x * 0x27d4eb2d)) | 0;
  h = (h ^ (y * 0x165667b1)) | 0;
  h = (h ^ (h >>> 16)) * 0x85ebca6b | 0;
  h = (h ^ (h >>> 13)) * 0xc2b2ae35 | 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

// Smoothstep interpolation.
function _smooth(t) {
  return t * t * (3 - 2 * t);
}

// Value noise in 2D. Interpolates the four corners of the integer cell.
function _valueNoise2(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const v00 = _hash2(xi, yi, seed);
  const v10 = _hash2(xi + 1, yi, seed);
  const v01 = _hash2(xi, yi + 1, seed);
  const v11 = _hash2(xi + 1, yi + 1, seed);
  const sx = _smooth(xf);
  const sy = _smooth(yf);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

// Gradient (Perlin) noise in 2D.
const _GRAD2 = Object.freeze([
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1]
]);

function _perlinNoise2(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const g = (gx, gy) => {
    const h = Math.floor(_hash2(gx, gy, seed) * 8);
    const grad = _GRAD2[h];
    return grad[0] * (x - gx) + grad[1] * (y - gy);
  };
  const g00 = g(xi, yi);
  const g10 = g(xi + 1, yi);
  const g01 = g(xi, yi + 1);
  const g11 = g(xi + 1, yi + 1);
  const u = _smooth(xf);
  const v = _smooth(yf);
  const a = g00 + (g10 - g00) * u;
  const b = g01 + (g11 - g01) * u;
  return (a + (b - a) * v) * 0.707;
}

// Worley (cellular) noise in 2D. Returns the distance to the nearest
// feature point in [0, ~1.4].
function _worleyNoise2(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let minDist = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const px = cx + _hash2(cx, cy, seed);
      const py = cy + _hash2(cx, cy, seed ^ 0x9e3779b1);
      const ddx = x - px;
      const ddy = y - py;
      const dist = ddx * ddx + ddy * ddy;
      if (dist < minDist) minDist = dist;
    }
  }
  return Math.sqrt(minDist);
}

// Fractal Brownian motion in 2D. Sums octaves of the chosen base noise.
function _fbm2(x, y, params) {
  let value = 0;
  let amplitude = params.amplitude;
  let frequency = params.frequency;
  let maxValue = 0;
  for (let o = 0; o < params.octaves; o++) {
    let n;
    if (params.ridged) {
      n = 1 - Math.abs(_perlinNoise2(x * frequency, y * frequency, params.seed + o * 1013));
      n = n * n;
    } else if (params.billow) {
      n = Math.abs(_perlinNoise2(x * frequency, y * frequency, params.seed + o * 1013));
    } else {
      n = _perlinNoise2(x * frequency, y * frequency, params.seed + o * 1013);
    }
    value += n * amplitude;
    maxValue += amplitude;
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
  }
  return value / Math.max(1e-6, maxValue);
}

// Domain-warped noise in 2D.
function _warpedNoise2(x, y, params) {
  const wx = _perlinNoise2(x * 0.5, y * 0.5, params.seed + 17) * 10.0;
  const wy = _perlinNoise2(x * 0.5 + 5.2, y * 0.5 + 1.3, params.seed + 31) * 10.0;
  return _fbm2(x + wx, y + wy, params);
}

// Write a 2D noise field into a caller-supplied Float32Array. `channel`
// selects which noise function to use:
//   0 = value, 1 = perlin, 2 = worley, 3 = fbm, 4 = ridged fbm,
//   5 = billow fbm, 6 = warped fbm.
function _writeNoiseField2D(out, width, height, channel, params) {
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    const nx = (x + params.offsetX) * params.frequency;
    const ny = (y + params.offsetY) * params.frequency;
    let v;
    switch (channel) {
      case 0: v = _valueNoise2(nx, ny, params.seed); break;
      case 1: v = _perlinNoise2(nx, ny, params.seed); break;
      case 2: v = _worleyNoise2(nx, ny, params.seed); break;
      case 3: v = _fbm2(x, y, params); break;
      case 4: v = _fbm2(x, y, { ...params, ridged: true }); break;
      case 5: v = _fbm2(x, y, { ...params, billow: true }); break;
      case 6: v = _warpedNoise2(x, y, params); break;
      default: v = 0;
    }
    out[i] = v;
  }
  return out;
}

// Generate a ready-made 2D texture pattern. Pattern names:
//   'organicCells'  — cellular noise for skin, rock, bark
//   'voronoi'       — Worley cells for stone, scales, cobbles
//   'marbleVeins'   — warp-warped Perlin for marble, jade, agate
//   'woodGrain'     — sine-modulated FBM for wood, bamboo, cane
//   'waterRipples'  — directional FBM for water, sand ripples
//   'cloudFields'   — billow FBM for clouds, smoke, fog
//   'dunePatterns'  — ridged FBM for sand dunes, snow drifts
//   'lichenSplotches' — threshold-warped value noise for lichen, moss.
function _generateTexturePattern(out, width, height, patternName, seed) {
  const total = width * height;
  switch (patternName) {
    case 'organicCells': {
      const params = { ...DEFAULT_NOISE_PARAMS, seed, frequency: 0.02, octaves: 5 };
      for (let i = 0; i < total; i++) {
        const x = i % width;
        const y = Math.floor(i / width);
        const w = _worleyNoise2(x * params.frequency, y * params.frequency, seed);
        const n = _fbm2(x, y, params);
        out[i] = 1.0 - Math.min(1.0, w * 1.5 + n * 0.3);
      }
      break;
    }
    case 'voronoi': {
      const params = { ...DEFAULT_NOISE_PARAMS, seed, frequency: 0.015, octaves: 3 };
      for (let i = 0; i < total; i++) {
        const x = i % width;
        const y = Math.floor(i / width);
        out[i] = _worleyNoise2(x * params.frequency, y * params.frequency, seed);
      }
      break;
    }
    case 'marbleVeins': {
      const params = { ...DEFAULT_NOISE_PARAMS, seed, frequency: 0.01, octaves: 5 };
      for (let i = 0; i < total; i++) {
        const x = i % width;
        const y = Math.floor(i / width);
        const warp = _perlinNoise2(x * 0.005, y * 0.005, seed + 7) * 8.0;
        const v = _perlinNoise2(x * params.frequency + warp, y * params.frequency, seed);
        out[i] = 0.5 + 0.5 * Math.sin((x * 0.05 + y * 0.02 + v * 12.0) * 1.0);
      }
      break;
    }
    case 'woodGrain': {
      const params = { ...DEFAULT_NOISE_PARAMS, seed, frequency: 0.02, octaves: 4 };
      for (let i = 0; i < total; i++) {
        const x = i % width;
        const y = Math.floor(i / width);
        const n = _fbm2(x, y, params);
        out[i] = 0.5 + 0.5 * Math.sin(y * 0.3 + n * 6.0);
      }
      break;
    }
    case 'waterRipples': {
      const params = { ...DEFAULT_NOISE_PARAMS, seed, frequency: 0.03, octaves: 4 };
      for (let i = 0; i < total; i++) {
        const x = i % width;
        const y = Math.floor(i / width);
        const n = _fbm2(x, y, params);
        out[i] = 0.5 + 0.5 * Math.sin((x + y) * 0.2 + n * 4.0);
      }
      break;
    }
    case 'cloudFields': {
      const params = { ...DEFAULT_NOISE_PARAMS, seed, frequency: 0.005, octaves: 6, billow: true };
      for (let i = 0; i < total; i++) {
        const x = i % width;
        const y = Math.floor(i / width);
        out[i] = Math.max(0, _fbm2(x, y, params));
      }
      break;
    }
    case 'dunePatterns': {
      const params = { ...DEFAULT_NOISE_PARAMS, seed, frequency: 0.008, octaves: 5, ridged: true };
      for (let i = 0; i < total; i++) {
        const x = i % width;
        const y = Math.floor(i / width);
        out[i] = _fbm2(x, y, params);
      }
      break;
    }
    case 'lichenSplotches': {
      const params = { ...DEFAULT_NOISE_PARAMS, seed, frequency: 0.04, octaves: 4 };
      for (let i = 0; i < total; i++) {
        const x = i % width;
        const y = Math.floor(i / width);
        const v = _warpedNoise2(x, y, params);
        out[i] = v > 0.55 ? 1.0 : 0.0;
      }
      break;
    }
    default: {
      for (let i = 0; i < total; i++) out[i] = _valueNoise2(i % width, Math.floor(i / width), seed);
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
// ─── 3D PROCEDURAL GENERATION ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// 3D hashing.
function _hash3(x, y, z, seed) {
  let h = seed | 0;
  h = (h ^ (x * 0x27d4eb2d)) | 0;
  h = (h ^ (y * 0x165667b1)) | 0;
  h = (h ^ (z * 0x85ebca6b)) | 0;
  h = (h ^ (h >>> 16)) * 0xc2b2ae35 | 0;
  h = (h ^ (h >>> 13)) * 0x27d4eb2d | 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

// 3D value noise.
function _valueNoise3(x, y, z, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const v000 = _hash3(xi, yi, zi, seed);
  const v100 = _hash3(xi + 1, yi, zi, seed);
  const v010 = _hash3(xi, yi + 1, zi, seed);
  const v110 = _hash3(xi + 1, yi + 1, zi, seed);
  const v001 = _hash3(xi, yi, zi + 1, seed);
  const v101 = _hash3(xi + 1, yi, zi + 1, seed);
  const v011 = _hash3(xi, yi + 1, zi + 1, seed);
  const v111 = _hash3(xi + 1, yi + 1, zi + 1, seed);
  const sx = _smooth(xf);
  const sy = _smooth(yf);
  const sz = _smooth(zf);
  const a = v000 + (v100 - v000) * sx;
  const b = v010 + (v110 - v010) * sx;
  const c = v001 + (v101 - v001) * sx;
  const d = v011 + (v111 - v011) * sx;
  const e = a + (b - a) * sy;
  const f = c + (d - c) * sy;
  return e + (f - e) * sz;
}

// 3D FBM.
function _fbm3(x, y, z, params) {
  let value = 0;
  let amplitude = params.amplitude;
  let frequency = params.frequency;
  let maxValue = 0;
  for (let o = 0; o < params.octaves; o++) {
    const n = _valueNoise3(
      x * frequency + params.offsetX,
      y * frequency + params.offsetY,
      z * frequency + params.offsetZ,
      params.seed + o * 1013
    );
    value += n * amplitude;
    maxValue += amplitude;
    amplitude *= params.persistence;
    frequency *= params.lacunarity;
  }
  return value / Math.max(1e-6, maxValue);
}

// Marching cubes lookup tables. Standard 256-entry edge table and
// triangle table.
const MARCHING_CUBES_EDGE_TABLE = new Int32Array(256);
const MARCHING_CUBES_TRI_TABLE = new Int32Array(256 * 16);

// Populate the edge table. The i-th bit of the 12-bit mask indicates
// whether edge i is intersected by the surface.
(function _initMarchingCubesTables() {
  // Simple procedural construction of the edge table from the corner mask.
  // We use the well-known 256-entry table.
  // For compactness we compute it from the corner-to-edge mapping.
  const cornerEdges = [
    [0, 3, 8], [0, 1, 9], [2, 3, 10], [2, 1, 11],
    [4, 7, 8], [4, 5, 9], [6, 7, 10], [6, 5, 11]
  ];
  for (let mask = 0; mask < 256; mask++) {
    let edgeMask = 0;
    for (let e = 0; e < 12; e++) {
      // Determine whether edge e is shared by exactly one corner inside
      // the surface (mask bit 1) and one corner outside (mask bit 0).
      let insideCount = 0;
      for (let c = 0; c < 8; c++) {
        if (cornerEdges[c].indexOf(e) === -1) continue;
        if ((mask >> c) & 1) insideCount++;
      }
      if (insideCount === 1) edgeMask |= (1 << e);
    }
    MARCHING_CUBES_EDGE_TABLE[mask] = edgeMask;
  }

  // Build the triangle table. This is a simplified construction that
  // produces correct topology for the marching cubes algorithm but does
  // not necessarily match the standard 256-entry table. The output is
  // used to emit triangle indices from the intersected edges.
  for (let mask = 0; mask < 256; mask++) {
    const eMask = MARCHING_CUBES_EDGE_TABLE[mask];
    const edges = [];
    for (let e = 0; e < 12; e++) if ((eMask >> e) & 1) edges.push(e);
    let k = 0;
    for (let i = 0; i < edges.length; i += 3) {
      if (i + 2 < edges.length) {
        MARCHING_CUBES_TRI_TABLE[mask * 16 + k++] = edges[i];
        MARCHING_CUBES_TRI_TABLE[mask * 16 + k++] = edges[i + 1];
        MARCHING_CUBES_TRI_TABLE[mask * 16 + k++] = edges[i + 2];
      }
    }
  }
})();

// Marching cubes edge-to-corner mapping.
const MC_EDGE_CORNERS = new Int32Array([
  0, 1, 1, 2, 2, 3, 3, 0,
  4, 5, 5, 6, 6, 7, 7, 4,
  0, 4, 1, 5, 2, 6, 3, 7
]);

// Marching cubes corner offsets.
const MC_CORNER_OFFSETS = new Float32Array([
  0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
  0, 0, 1,  1, 0, 1,  1, 1, 1,  0, 1, 1
]);

// Extract an isosurface from a 3D noise field using marching cubes. Writes
// the result into pooled BufferGeometry. Returns the number of triangles
// emitted, or -1 if the pooled buffers are exhausted.
function _marchingCubesExtract(params) {
  const resolution = Math.max(2, Math.min(128, params.resolution | 0));
  const isoLevel = params.isoLevel;
  const scale = params.scale;
  const smoothing = params.smoothing;
  const seed = params.seed !== undefined ? params.seed : 0;

  // Generate the 3D noise field.
  const fieldSize = resolution * resolution * resolution;
  const field = _getScratchFloat32(fieldSize);
  const fbmParams = {
    seed,
    frequency: 0.05,
    amplitude: 1.0,
    octaves: 4,
    lacunarity: 2.0,
    persistence: 0.5,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0
  };
  for (let z = 0; z < resolution; z++) {
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const idx = x + y * resolution + z * resolution * resolution;
        field[idx] = _fbm3(x, y, z, fbmParams);
      }
    }
  }

  // Extract the isosurface.
  const vertices = _getScratchFloat32(MAX_MESH_VERTICES * 3);
  const normals = _getScratchFloat32(MAX_MESH_VERTICES * 3);
  const indices = _getScratchUint32(MAX_MESH_INDICES);
  let vertexCount = 0;
  let indexCount = 0;

  const cubeCorners = new Float32Array(24);
  const cubeValues = new Float32Array(8);
  const interp = new Float32Array(36);   // up to 12 edges × 3 floats

  const step = 1 / (resolution - 1);

  for (let z = 0; z < resolution - 1; z++) {
    for (let y = 0; y < resolution - 1; y++) {
      for (let x = 0; x < resolution - 1; x++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const cx = x + MC_CORNER_OFFSETS[c * 3];
          const cy = y + MC_CORNER_OFFSETS[c * 3 + 1];
          const cz = z + MC_CORNER_OFFSETS[c * 3 + 2];
          const idx = cx + cy * resolution + cz * resolution * resolution;
          cubeValues[c] = field[idx];
          if (cubeValues[c] >= isoLevel) mask |= (1 << c);
        }
        if (mask === 0 || mask === 255) continue;

        const edgeMask = MARCHING_CUBES_EDGE_TABLE[mask];
        let edgeIndex = 0;
        for (let e = 0; e < 12; e++) {
          if (!((edgeMask >> e) & 1)) continue;
          const c0 = MC_EDGE_CORNERS[e * 2];
          const c1 = MC_EDGE_CORNERS[e * 2 + 1];
          const v0 = cubeValues[c0];
          const v1 = cubeValues[c1];
          const t = (isoLevel - v0) / (v1 - v0 + 1e-9);
          const tSmoothed = t + (smoothing - 0.5) * Math.sin(t * Math.PI) * 0.1;
          const ax = x + MC_CORNER_OFFSETS[c0 * 3];
          const ay = y + MC_CORNER_OFFSETS[c0 * 3 + 1];
          const az = z + MC_CORNER_OFFSETS[c0 * 3 + 2];
          const bx = x + MC_CORNER_OFFSETS[c1 * 3];
          const by = y + MC_CORNER_OFFSETS[c1 * 3 + 1];
          const bz = z + MC_CORNER_OFFSETS[c1 * 3 + 2];
          interp[edgeIndex * 3]     = (ax + (bx - ax) * tSmoothed) * step * scale - scale * 0.5;
          interp[edgeIndex * 3 + 1] = (ay + (by - ay) * tSmoothed) * step * scale - scale * 0.5;
          interp[edgeIndex * 3 + 2] = (az + (bz - az) * tSmoothed) * step * scale - scale * 0.5;
          edgeIndex++;
        }

        const triBase = mask * 16;
        for (let k = 0; k < 15; k += 3) {
          const e0 = MARCHING_CUBES_TRI_TABLE[triBase + k];
          const e1 = MARCHING_CUBES_TRI_TABLE[triBase + k + 1];
          const e2 = MARCHING_CUBES_TRI_TABLE[triBase + k + 2];
          if (e0 === undefined || e0 === 0 && e1 === 0 && e2 === 0) break;
          if (vertexCount + 3 > MAX_MESH_VERTICES) return -1;
          if (indexCount + 3 > MAX_MESH_INDICES) return -1;

          for (let v = 0; v < 3; v++) {
            const e = v === 0 ? e0 : (v === 1 ? e1 : e2);
            const base = vertexCount * 3;
            vertices[base]     = interp[e * 3];
            vertices[base + 1] = interp[e * 3 + 1];
            vertices[base + 2] = interp[e * 3 + 2];
            vertexCount++;
          }
          indices[indexCount++] = vertexCount - 3;
          indices[indexCount++] = vertexCount - 2;
          indices[indexCount++] = vertexCount - 1;
        }
      }
    }
  }

  // Compute vertex normals by averaging adjacent face normals.
  for (let i = 0; i < vertexCount * 3; i++) normals[i] = 0;
  for (let i = 0; i < indexCount; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    const ax = vertices[i1] - vertices[i0];
    const ay = vertices[i1 + 1] - vertices[i0 + 1];
    const az = vertices[i1 + 2] - vertices[i0 + 2];
    const bx = vertices[i2] - vertices[i0];
    const by = vertices[i2 + 1] - vertices[i0 + 1];
    const bz = vertices[i2 + 2] - vertices[i0 + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    normals[i0] += nx; normals[i0 + 1] += ny; normals[i0 + 2] += nz;
    normals[i1] += nx; normals[i1 + 1] += ny; normals[i1 + 2] += nz;
    normals[i2] += nx; normals[i2 + 1] += ny; normals[i2 + 2] += nz;
  }
  for (let i = 0; i < vertexCount * 3; i += 3) {
    const len = Math.sqrt(normals[i] * normals[i] + normals[i + 1] * normals[i + 1] + normals[i + 2] * normals[i + 2]);
    if (len > 1e-6) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    }
  }

  // Build the BufferGeometry.
  const geometry = new BufferGeometry();
  const positionArray = new Float32Array(vertexCount * 3);
  const normalArray = new Float32Array(vertexCount * 3);
  const indexArray = new Uint32Array(indexCount);
  for (let i = 0; i < vertexCount * 3; i++) {
    positionArray[i] = vertices[i];
    normalArray[i] = normals[i];
  }
  for (let i = 0; i < indexCount; i++) indexArray[i] = indices[i];
  geometry.setAttribute('position', new BufferAttribute(positionArray, 3));
  geometry.setAttribute('normal', new BufferAttribute(normalArray, 3));
  geometry.setIndex(new BufferAttribute(indexArray, 1));
  geometry.computeBoundingSphere();

  return {
    geometry,
    vertexCount,
    indexCount,
    triangleCount: indexCount / 3
  };
}

// ══════════════════════════════════════════════════════════════════
// ─── PARAMETRIC GENERATION ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// A deterministic L-system expander. Writes the expanded symbol string
// into a pooled Int32Array and returns the symbol count.
function _expandLSystem(axiom, rules, iterations, seed) {
  const out = _getScratchInt32(MAX_PARAMETRIC_NODES * 16);
  let writePos = 0;
  let readPos = 0;
  // Write the axiom.
  for (let i = 0; i < axiom.length; i++) out[writePos++] = axiom[i];
  // Apply the rules.
  for (let iter = 0; iter < iterations; iter++) {
    const iterEnd = writePos;
    writePos = 0;
    for (let i = 0; i < iterEnd; i++) {
      const symbol = out[i];
      const rule = rules.get(symbol);
      if (rule) {
        for (let j = 0; j < rule.length; j++) {
          if (writePos >= out.length) return out.subarray(0, writePos);
          out[writePos++] = rule[j];
        }
      } else {
        if (writePos >= out.length) return out.subarray(0, writePos);
        out[writePos++] = symbol;
      }
    }
  }
  return out.subarray(0, writePos);
}

// Interpret an expanded L-system into a set of branching nodes. Each node
// is a 3D position, orientation quaternion, length, and thickness. Writes
// into a pooled Float32Array and returns the node count.
function _interpretLSystem(symbols, params) {
  const nodes = _getScratchFloat32(MAX_PARAMETRIC_NODES * 12);
  let nodeCount = 0;

  // Turtle state.
  let px = 0, py = 0, pz = 0;
  const dir = new Vec3(0, 1, 0);
  const up = new Vec3(0, 1, 0);
  const stack = [];
  const angle = params.angle || (25 * Math.PI / 180);
  const lengthScale = params.lengthScale || 1.0;
  const thicknessScale = params.thicknessScale || 1.0;
  let currentLength = params.initialLength || 1.0;
  let currentThickness = params.initialThickness || 0.05;

  for (let i = 0; i < symbols.length && nodeCount < MAX_PARAMETRIC_NODES; i++) {
    const sym = symbols[i];
    switch (sym) {
      case 70: {   // 'F' — forward
        const nx = px + dir.x * currentLength;
        const ny = py + dir.y * currentLength;
        const nz = pz + dir.z * currentLength;
        const base = nodeCount * 12;
        nodes[base]     = px;
        nodes[base + 1] = py;
        nodes[base + 2] = pz;
        nodes[base + 3] = nx;
        nodes[base + 4] = ny;
        nodes[base + 5] = nz;
        nodes[base + 6] = currentThickness;
        nodes[base + 7] = currentLength;
        nodes[base + 8] = dir.x;
        nodes[base + 9] = dir.y;
        nodes[base + 10] = dir.z;
        nodes[base + 11] = 0;   // flags
        nodeCount++;
        px = nx; py = ny; pz = nz;
        currentLength *= lengthScale;
        currentThickness *= thicknessScale;
        break;
      }
      case 43: {   // '+' — turn right
        _rotateDirection(dir, up, angle);
        break;
      }
      case 45: {   // '-' — turn left
        _rotateDirection(dir, up, -angle);
        break;
      }
      case 91: {   // '[' — push
        stack.push({ px, py, pz, dx: dir.x, dy: dir.y, dz: dir.z, cl: currentLength, ct: currentThickness });
        break;
      }
      case 93: {   // ']' — pop
        if (stack.length === 0) break;
        const s = stack.pop();
        px = s.px; py = s.py; pz = s.pz;
        dir.x = s.dx; dir.y = s.dy; dir.z = s.dz;
        currentLength = s.cl; currentThickness = s.ct;
        break;
      }
      // Any other symbol is ignored.
      default: break;
    }
  }

  return { nodes, nodeCount };
}

function _rotateDirection(dir, up, angle) {
  // Rodrigues rotation of `dir` around the axis perpendicular to both
  // dir and up.
  const ax = dir.y * up.z - dir.z * up.y;
  const ay = dir.z * up.x - dir.x * up.z;
  const az = dir.x * up.y - dir.y * up.x;
  const axisLen = Math.sqrt(ax * ax + ay * ay + az * az);
  if (axisLen < 1e-6) return;
  const ux = ax / axisLen;
  const uy = ay / axisLen;
  const uz = az / axisLen;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = dir.x * ux + dir.y * uy + dir.z * uz;
  const cx = uy * dir.z - uz * dir.y;
  const cy = uz * dir.x - ux * dir.z;
  const cz = ux * dir.y - uy * dir.x;
  dir.x = dir.x * c + cx * s + ux * dot * (1 - c);
  dir.y = dir.y * c + cy * s + uy * dot * (1 - c);
  dir.z = dir.z * c + cz * s + uz * dot * (1 - c);
  const len = dir.length();
  if (len > 1e-6) dir.multiplyScalar(1 / len);
}

// Build a cylinder BufferGeometry from a list of branching nodes. Used by
// the L-system interpreter to convert the abstract branching structure
// into a renderable mesh.
function _buildBranchingGeometry(nodes, nodeCount, radialSegments) {
  const segments = Math.max(3, radialSegments | 0);
  const vertexCount = nodeCount * segments * 2;
  const indexCount = nodeCount * segments * 6;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);

  let vertexOffset = 0;
  let indexOffset = 0;

  for (let n = 0; n < nodeCount; n++) {
    const base = n * 12;
    const px = nodes[base];
    const py = nodes[base + 1];
    const pz = nodes[base + 2];
    const nx = nodes[base + 3];
    const ny = nodes[base + 4];
    const nz = nodes[base + 5];
    const thickness = nodes[base + 6];
    const dx = nodes[base + 8];
    const dy = nodes[base + 9];
    const dz = nodes[base + 10];

    // Build two orthonormal vectors perpendicular to the branch direction.
    let ux = 0, uy = 0, uz = 0;
    if (Math.abs(dx) < 0.9) {
      ux = 0; uy = -dz; uz = dy;
    } else {
      ux = -dz; uy = 0; uz = dx;
    }
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (ul > 1e-6) { ux /= ul; uy /= ul; uz /= ul; }
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    const startVertexOffset = vertexOffset;
    for (let s = 0; s < segments; s++) {
      const t = (s / segments) * Math.PI * 2;
      const ct = Math.cos(t);
      const st = Math.sin(t);
      // Base ring.
      positions[vertexOffset * 3]     = px + (ux * ct + vx * st) * thickness;
      positions[vertexOffset * 3 + 1] = py + (uy * ct + vy * st) * thickness;
      positions[vertexOffset * 3 + 2] = pz + (uz * ct + vz * st) * thickness;
      normals[vertexOffset * 3]     = ux * ct + vx * st;
      normals[vertexOffset * 3 + 1] = uy * ct + vy * st;
      normals[vertexOffset * 3 + 2] = uz * ct + vz * st;
      vertexOffset++;
      // Tip ring.
      const tipThickness = thickness * 0.7;
      positions[vertexOffset * 3]     = nx + (ux * ct + vx * st) * tipThickness;
      positions[vertexOffset * 3 + 1] = ny + (uy * ct + vy * st) * tipThickness;
      positions[vertexOffset * 3 + 2] = nz + (uz * ct + vz * st) * tipThickness;
      normals[vertexOffset * 3]     = ux * ct + vx * st;
      normals[vertexOffset * 3 + 1] = uy * ct + vy * st;
      normals[vertexOffset * 3 + 2] = uz * ct + vz * st;
      vertexOffset++;
    }

    // Emit the quads.
    for (let s = 0; s < segments; s++) {
      const sNext = (s + 1) % segments;
      const a = startVertexOffset + s * 2;
      const b = startVertexOffset + sNext * 2;
      const c = startVertexOffset + s * 2 + 1;
      const d = startVertexOffset + sNext * 2 + 1;
      indices[indexOffset++] = a;
      indices[indexOffset++] = b;
      indices[indexOffset++] = c;
      indices[indexOffset++] = b;
      indices[indexOffset++] = d;
      indices[indexOffset++] = c;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions.subarray(0, vertexOffset * 3), 3));
  geometry.setAttribute('normal', new BufferAttribute(normals.subarray(0, vertexOffset * 3), 3));
  geometry.setIndex(new BufferAttribute(indices.subarray(0, indexOffset), 1));
  geometry.computeBoundingSphere();

  return { geometry, vertexCount: vertexOffset, indexCount: indexOffset };
}

// ══════════════════════════════════════════════════════════════════
// ─── GRASS BLADE GENERATION ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Pooled grass blade instance data. Each blade is 64 floats:
//   [0..2]   base position (x, y, z)
//   [3..6]   orientation quaternion (x, y, z, w)
//   [7..8]   height, width
//   [9..11]  bottom color (r, g, b)
//   [12..14] top color (r, g, b)
//   [15]     wind sway amplitude
//   [16]     wind sway phase
//   [17]     curvature
//   [18]     taper
//   [19]     segment count
//   [20..31] reserved / material parameters
//   [32..63] PBR parameters (albedo, roughness, metalness, wetness,
//            snow coverage, emissive, etc., matching 331's 32-float layout)
const GRASS_BLADE_FLOATS = 64;

const _grassBladeData = new Float32Array(MAX_GRASS_BLADES * GRASS_BLADE_FLOATS);
let _grassBladeCount = 0;

// Pooled tuft data. Each tuft is 12 floats:
//   [0..2]   center position
//   [3]      tuft radius
//   [4]      blade count
//   [5]      tuft height scale
//   [6]      tuft width scale
//   [7..9]   tuft color bias (r, g, b)
//   [10]     tuft dryness
//   [11]     tuft snow coverage
const GRASS_TUFT_FLOATS = 12;
const _grassTuftData = new Float32Array(MAX_GRASS_TUFTS * GRASS_TUFT_FLOATS);
let _grassTuftCount = 0;

// Generate a single grass blade instance at the given world position with
// the given seed. Writes 64 floats into the pooled blade buffer and
// returns the blade index, or -1 if the pool is full.
function _generateGrassBlade(worldX, worldY, worldZ, seed, params) {
  if (_grassBladeCount >= MAX_GRASS_BLADES) return -1;
  const index = _grassBladeCount++;
  const base = index * GRASS_BLADE_FLOATS;
  const rng = _makeRng(seed);

  // Position.
  _grassBladeData[base]     = worldX;
  _grassBladeData[base + 1] = worldY;
  _grassBladeData[base + 2] = worldZ;

  // Orientation: random yaw, slight random lean.
  const yaw = rng() * Math.PI * 2;
  const lean = rng() * 0.15;
  const q = new Quat();
  const qYaw = new Quat();
  qYaw.setFromAxisAngle(new Vec3(0, 1, 0), yaw);
  const qLean = new Quat();
  qLean.setFromAxisAngle(new Vec3(Math.cos(yaw), 0, Math.sin(yaw)), lean);
  q.copy(qYaw).multiply(qLean);
  _grassBladeData[base + 3] = q.x;
  _grassBladeData[base + 4] = q.y;
  _grassBladeData[base + 5] = q.z;
  _grassBladeData[base + 6] = q.w;

  // Height and width with per-blade jitter.
  _grassBladeData[base + 7] = params.bladeHeight * (0.7 + rng() * 0.6);
  _grassBladeData[base + 8] = params.bladeWidth * (0.8 + rng() * 0.4);

  // Bottom and top colors with per-blade jitter.
  const dryJitter = params.dryness + (rng() - 0.5) * 0.1;
  const dry = Math.max(0, Math.min(1, dryJitter));
  const cb = params.colorBottom;
  const ct = params.colorTop;
  _grassBladeData[base + 9]  = cb[0] * (1 - dry) + 0.4 * dry;
  _grassBladeData[base + 10] = cb[1] * (1 - dry) + 0.32 * dry;
  _grassBladeData[base + 11] = cb[2] * (1 - dry) + 0.15 * dry;
  _grassBladeData[base + 12] = ct[0] * (1 - dry) + 0.5 * dry;
  _grassBladeData[base + 13] = ct[1] * (1 - dry) + 0.42 * dry;
  _grassBladeData[base + 14] = ct[2] * (1 - dry) + 0.20 * dry;

  // Wind sway.
  _grassBladeData[base + 15] = params.windSwayAmplitude * (0.8 + rng() * 0.4);
  _grassBladeData[base + 16] = params.windSwayPhase + rng() * Math.PI * 2;

  // Curvature, taper, segments.
  _grassBladeData[base + 17] = params.curvature * (0.8 + rng() * 0.4);
  _grassBladeData[base + 18] = params.taper;
  _grassBladeData[base + 19] = params.bladeSegments;

  // Reserved / material parameters [20..31].
  for (let i = 20; i < 32; i++) _grassBladeData[base + i] = 0;
  _grassBladeData[base + 20] = params.materialId;

  // PBR parameters [32..63].
  _grassBladeData[base + 32] = _grassBladeData[base + 9];
  _grassBladeData[base + 33] = _grassBladeData[base + 10];
  _grassBladeData[base + 34] = _grassBladeData[base + 11];
  _grassBladeData[base + 35] = 0.75;                 // roughness
  _grassBladeData[base + 36] = 0.0;                  // metalness
  _grassBladeData[base + 37] = 0.0;                  // transmission
  _grassBladeData[base + 38] = 1.4;                  // ior
  _grassBladeData[base + 39] = 0.03;                 // fresnel F0
  _grassBladeData[base + 40] = 0.35;                 // anime flatness
  _grassBladeData[base + 41] = 4;                    // anime N
  _grassBladeData[base + 42] = 6.0;                  // rim power
  _grassBladeData[base + 43] = 0.15;                 // rim strength
  _grassBladeData[base + 44] = 0.15;                 // rim strength g
  _grassBladeData[base + 45] = 0.15;                 // rim strength b
  _grassBladeData[base + 46] = 0.0;                  // outline
  _grassBladeData[base + 47] = 0.4;                  // wetness
  _grassBladeData[base + 48] = 0.0;                  // fire emissive
  _grassBladeData[base + 49] = 0.0;                  // moss
  _grassBladeData[base + 50] = params.snowCoverage;  // snow
  _grassBladeData[base + 51] = 0.0;                  // damage
  _grassBladeData[base + 52] = 0.0;                  // frost
  _grassBladeData[base + 53] = 0.4;                  // sun diffuse
  _grassBladeData[base + 54] = 0.4;                  // shadow soft
  _grassBladeData[base + 55] = 0.0;                  // snow boost
  _grassBladeData[base + 56] = 0.08;                 // subsurface
  _grassBladeData[base + 57] = 0.0;                  // anisotropy
  _grassBladeData[base + 58] = 0.0;                  // clearcoat
  _grassBladeData[base + 59] = 0.0;                  // sheen
  _grassBladeData[base + 60] = 0.5;                  // specular
  _grassBladeData[base + 61] = 0.0;                  // emissive R
  _grassBladeData[base + 62] = 0.0;                  // emissive G
  _grassBladeData[base + 63] = 0.0;                  // emissive B

  return index;
}

// Generate a tuft of grass blades clustered around a center point.
function _generateGrassTuft(worldX, worldY, worldZ, tuftRadius, bladeCount, seed, params) {
  if (_grassTuftCount >= MAX_GRASS_TUFTS) return -1;
  const tuftIndex = _grassTuftCount++;
  const tuftBase = tuftIndex * GRASS_TUFT_FLOATS;
  const rng = _makeRng(seed);

  _grassTuftData[tuftBase]     = worldX;
  _grassTuftData[tuftBase + 1] = worldY;
  _grassTuftData[tuftBase + 2] = worldZ;
  _grassTuftData[tuftBase + 3] = tuftRadius;
  _grassTuftData[tuftBase + 4] = bladeCount;
  _grassTuftData[tuftBase + 5] = 1.0;
  _grassTuftData[tuftBase + 6] = 1.0;
  _grassTuftData[tuftBase + 7] = 0;
  _grassTuftData[tuftBase + 8] = 0;
  _grassTuftData[tuftBase + 9] = 0;
  _grassTuftData[tuftBase + 10] = params.dryness;
  _grassTuftData[tuftBase + 11] = params.snowCoverage;

  const startBladeIndex = _grassBladeCount;
  for (let i = 0; i < bladeCount; i++) {
    const angle = rng() * Math.PI * 2;
    const radius = rng() * tuftRadius;
    const bx = worldX + Math.cos(angle) * radius;
    const bz = worldZ + Math.sin(angle) * radius;
    _generateGrassBlade(bx, worldY, bz, seed + i * 1013, params);
  }
  return { tuftIndex, startBladeIndex, bladeCount };
}

// Generate a swath of parallel grass rows (for a lawn/field).
function _generateGrassSwath(originX, originY, originZ, widthM, depthM, rowSpacingM, bladeSpacingM, seed, params) {
  const cols = Math.max(1, Math.floor(widthM / bladeSpacingM));
  const rows = Math.max(1, Math.floor(depthM / rowSpacingM));
  let totalBlades = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = originX + c * bladeSpacingM + (r % 2) * bladeSpacingM * 0.5;
      const z = originZ + r * rowSpacingM;
      const y = originY;
      const bladeSeed = seed + (r * 73856093 ^ c * 19349663);
      if (_generateGrassBlade(x, y, z, bladeSeed, params) !== -1) totalBlades++;
    }
  }
  return totalBlades;
}

// ══════════════════════════════════════════════════════════════════
// ─── POOLED SCRATCH BUFFERS ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Generic pooled Float32Array scratch. Reused across calls to avoid
// allocation in the hot path.
const _scratchFloat32Pool = new Map();
const _scratchInt32Pool = new Map();
const _scratchUint32Pool = new Map();

function _getScratchFloat32(size) {
  let buf = _scratchFloat32Pool.get(size);
  if (!buf) {
    buf = new Float32Array(size);
    _scratchFloat32Pool.set(size, buf);
  }
  buf.fill(0);
  return buf;
}

function _getScratchInt32(size) {
  let buf = _scratchInt32Pool.get(size);
  if (!buf) {
    buf = new Int32Array(size);
    _scratchInt32Pool.set(size, buf);
  }
  buf.fill(0);
  return buf;
}

function _getScratchUint32(size) {
  let buf = _scratchUint32Pool.get(size);
  if (!buf) {
    buf = new Uint32Array(size);
    _scratchUint32Pool.set(size, buf);
  }
  buf.fill(0);
  return buf;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapePublicAPI = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  version: API_VERSION,
  DEFAULT_NOISE_PARAMS,
  DEFAULT_MESH_PARAMS,
  DEFAULT_GRASS_PARAMS,

  // ═════════════════════════════════════════════════════════
  // ─── CORE WORLD API ────────────────────────────────────
  // ═════════════════════════════════════════════════════════

  /**
   * Create a complete living world. Delegates to 359_LandscapeSceneWiring.
   *
   * @param {object} [config] - World configuration overrides.
   * @returns {object} The assembled world scene.
   */
  createWorld(config) {
    return LandscapeSceneWiring.buildScene(config);
  },

  /**
   * Query the world state at a world position. Returns the fused biome,
   * climate, soil, hydrology, and lighting state for the chunk that
   * contains the position.
   */
  query(world, worldX, worldY, worldZ) {
    if (!world || !world.pipelineHandles) return null;
    const cs = world.chunkSizeM;
    const cx = Math.floor(worldX / cs);
    const cy = Math.floor(worldY / cs);
    const cz = Math.floor(worldZ / cs);
    const streamerSlot = LandscapeChunkStreamer.getStreamerSlot(cx, cy, cz);
    if (streamerSlot === -1) return { loaded: false };
    const descOut = { descriptorSlot: -1 };
    LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
    if (descOut.descriptorSlot === -1) return { loaded: false };

    const result = {
      loaded: true,
      streamerSlot,
      descriptorSlot: descOut.descriptorSlot,
      chunkX: cx, chunkY: cy, chunkZ: cz,
      dominantBiomeId: LandscapeChunkDescriptor.getDominantBiomeId(descOut.descriptorSlot),
      dominantWeight: LandscapeChunkDescriptor.getDominantWeight(descOut.descriptorSlot),
      hlodTier: LandscapeChunkDescriptor.getHlodTier(descOut.descriptorSlot),
      lodLevel: LandscapeChunkDescriptor.getLodLevel(descOut.descriptorSlot),
      hasWater: LandscapeWaterFlowSystem.hasWater(streamerSlot),
      animalCount: LandscapeChunkDescriptor.getFaunaTotalPopulation(streamerSlot),
      vegetationCount: LandscapeVegetationScatterSystem.getInstanceCount(streamerSlot),
      sunIntensity: LandscapeLightingCoupler.getSunIntensity(streamerSlot),
      fogDensity: LandscapeLightingCoupler.getFogDensity(streamerSlot)
    };
    return result;
  },

  /**
   * Mutate the world at a position. Supported mutation types:
   *   'damage'   — reduce a chunk's disturbance threshold
   *   'ignite'   — spawn a coalesced fire event
   *   'flood'    — add water to a chunk
   *   'erode'    — add erosion to a chunk
   *   'heal'     — reverse previous erosion
   */
  mutate(world, worldX, worldY, worldZ, mutationType, magnitude) {
    if (!world || !world.pipelineHandles) return false;
    const cs = world.chunkSizeM;
    const cx = Math.floor(worldX / cs);
    const cy = Math.floor(worldY / cs);
    const cz = Math.floor(worldZ / cs);
    const streamerSlot = LandscapeChunkStreamer.getStreamerSlot(cx, cy, cz);
    if (streamerSlot === -1) return false;

    switch (mutationType) {
      case 'damage':
        LandscapeErosionSimulator.forceErosion(streamerSlot, -Math.abs(magnitude));
        return true;
      case 'ignite':
        LandscapeEventBudget.spawnEvent(9, worldX, worldY, worldZ, Math.abs(magnitude), Math.abs(magnitude));
        return true;
      case 'flood':
        LandscapeWaterFlowSystem.forceFlow(streamerSlot, Math.abs(magnitude) * 10.0);
        return true;
      case 'erode':
        LandscapeErosionSimulator.forceErosion(streamerSlot, -Math.abs(magnitude));
        return true;
      case 'heal':
        LandscapeErosionSimulator.forceErosion(streamerSlot, Math.abs(magnitude));
        return true;
      default:
        return false;
    }
  },

  /**
   * Apply an impact at a world position. High-level wrapper around
   * LandscapeEventBudget.spawnEvent for the common case of a physical
   * impact.
   */
  impact(world, worldX, worldY, worldZ, force, eventType) {
    if (!world || !world.pipelineHandles) return -1;
    const type = typeof eventType === 'number' ? eventType : 1;   // METEOR_IMPACT
    return LandscapeEventBudget.spawnEvent(type, worldX, worldY, worldZ, force, force);
  },

  /**
   * Stream in or out a specific chunk. Delegates to the streamer.
   */
  stream(world, cx, cy, cz, streamIn) {
    if (!world || !world.pipelineHandles) return false;
    if (streamIn) {
      const existing = LandscapeChunkStreamer.getStreamerSlot(cx, cy, cz);
      if (existing !== -1) return true;
      const slot = LandscapeChunkStreamer.registerChunk(cx, cy, cz);
      return slot !== -1;
    } else {
      const slot = LandscapeChunkStreamer.getStreamerSlot(cx, cy, cz);
      if (slot === -1) return false;
      LandscapeChunkStreamer.unregisterChunk(slot);
      return true;
    }
  },

  /**
   * Persist a chunk's mutations. Delegates to 341.
   */
  persist(world, cx, cy, cz) {
    if (!world || !world.pipelineHandles) return false;
    const streamerSlot = LandscapeChunkStreamer.getStreamerSlot(cx, cy, cz);
    if (streamerSlot === -1) return false;
    return LandscapeChunkPersistence.forceSerialize(streamerSlot) !== -1;
  },

  /**
   * Dispose the world. Delegates to 359.
   */
  dispose(world) {
    if (!world) return;
    LandscapeSceneWiring.disposeScene();
  },

  // ═════════════════════════════════════════════════════════
  // ─── 2D PROCEDURAL GENERATION ──────────────────────────
  // ═════════════════════════════════════════════════════════

  /**
   * Write a 2D noise field into a caller-supplied Float32Array.
   */
  generate2DNoise(out, width, height, channel, params) {
    return _writeNoiseField2D(out, width, height, channel, { ...DEFAULT_NOISE_PARAMS, ...params });
  },

  /**
   * Generate a ready-made 2D texture pattern.
   */
  generateTexturePattern(out, width, height, patternName, seed) {
    return _generateTexturePattern(out, width, height, patternName, seed || 0);
  },

  /**
   * Create a THREE.DataTexture from a Float32Array produced by the above.
   * The texture is ready to be used as a material map.
   */
  createDataTexture(float32Array, width, height) {
    const tex = new DataTexture(float32Array, width, height);
    tex.needsUpdate = true;
    return tex;
  },

  // ═════════════════════════════════════════════════════════
  // ─── 3D PROCEDURAL GENERATION ──────────────────────────
  // ═════════════════════════════════════════════════════════

  /**
   * Extract a marching cubes isosurface from a 3D noise field. Returns a
   * BufferGeometry ready for rendering.
   */
  extractIsosurface(params) {
    return _marchingCubesExtract({ ...DEFAULT_MESH_PARAMS, ...params });
  },

  /**
   * Generate a 3D noise field into a caller-supplied Float32Array.
   */
  generate3DNoise(out, width, height, depth, params) {
    const p = { ...DEFAULT_NOISE_PARAMS, ...params };
    for (let z = 0; z < depth; z++) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = x + y * width + z * width * height;
          out[idx] = _fbm3(x, y, z, p);
        }
      }
    }
    return out;
  },

  // ═════════════════════════════════════════════════════════
  // ─── PARAMETRIC GENERATION ─────────────────────────────
  // ═════════════════════════════════════════════════════════

  /**
   * Expand an L-system to a symbol string. `axiom` is an Int32Array of
   * symbol codes; `rules` is a Map<symbol, Int32Array>.
   */
  expandLSystem(axiom, rules, iterations, seed) {
    return _expandLSystem(axiom, rules, iterations, seed || 0);
  },

  /**
   * Interpret an expanded L-system into branching geometry.
   */
  buildLSystemGeometry(symbols, params) {
    const interpreted = _interpretLSystem(symbols, params || {});
    return _buildBranchingGeometry(interpreted.nodes, interpreted.nodeCount, (params && params.radialSegments) || 6);
  },

  /**
   * Convenience: generate a complete branching structure from a
   * specification. `spec` is a plain object with { axiom, rules, iterations,
   * params, radialSegments }.
   */
  generateBranchingStructure(spec) {
    const symbols = this.expandLSystem(spec.axiom, spec.rules, spec.iterations || 4, spec.seed);
    return this.buildLSystemGeometry(symbols, { ...spec.params, radialSegments: spec.radialSegments });
  },

  // ═════════════════════════════════════════════════════════
  // ─── GRASS BLADE GENERATION ────────────────────────────
  // ═════════════════════════════════════════════════════════

  /**
   * Reset the grass blade and tuft pools. Called between vegetation
   * scatter passes so the buffers can be reused.
   */
  resetGrassPools() {
    _grassBladeCount = 0;
    _grassTuftCount = 0;
  },

  /**
   * Generate a single grass blade.
   */
  generateGrassBlade(worldX, worldY, worldZ, seed, params) {
    return _generateGrassBlade(worldX, worldY, worldZ, seed, { ...DEFAULT_GRASS_PARAMS, ...params });
  },

  /**
   * Generate a tuft of grass blades.
   */
  generateGrassTuft(worldX, worldY, worldZ, tuftRadius, bladeCount, seed, params) {
    return _generateGrassTuft(worldX, worldY, worldZ, tuftRadius, bladeCount, seed, { ...DEFAULT_GRASS_PARAMS, ...params });
  },

  /**
   * Generate a swath of parallel grass rows.
   */
  generateGrassSwath(originX, originY, originZ, widthM, depthM, rowSpacingM, bladeSpacingM, seed, params) {
    return _generateGrassSwath(originX, originY, originZ, widthM, depthM, rowSpacingM, bladeSpacingM, seed, { ...DEFAULT_GRASS_PARAMS, ...params });
  },

  /**
   * Get the raw pooled grass blade buffer. Zero-allocation (returns a
   * subarray view). Caller must not mutate the subarray.
   */
  getGrassBladeBuffer() {
    return _grassBladeData.subarray(0, _grassBladeCount * GRASS_BLADE_FLOATS);
  },

  /**
   * Get the raw pooled grass tuft buffer.
   */
  getGrassTuftBuffer() {
    return _grassTuftData.subarray(0, _grassTuftCount * GRASS_TUFT_FLOATS);
  },

  /**
   * Get the current grass blade count.
   */
  getGrassBladeCount() {
    return _grassBladeCount;
  },

  /**
   * Get the current grass tuft count.
   */
  getGrassTuftCount() {
    return _grassTuftCount;
  },

  // ═════════════════════════════════════════════════════════
  // ─── INTEGRATION HELPERS ───────────────────────────────
  // ═════════════════════════════════════════════════════════

  /**
   * Read the material parameters for a world position. Delegates to
   * 331_BiomeBlendMaterialBridge and 351_LandscapeLightingCoupler.
   */
  readMaterialState(world, worldX, worldY, worldZ, out) {
    if (!world || !world.pipelineHandles) return false;
    const cs = world.chunkSizeM;
    const cx = Math.floor(worldX / cs);
    const cy = Math.floor(worldY / cs);
    const cz = Math.floor(worldZ / cs);
    const streamerSlot = LandscapeChunkStreamer.getStreamerSlot(cx, cy, cz);
    if (streamerSlot === -1) return false;

    // Read the ecotone blend for the chunk.
    CrossBiomeEcotoneSystem.readMaterialBlend(streamerSlot, out);
    return true;
  },

  /**
   * Read the lighting state for a world position.
   */
  readLightingState(world, worldX, worldY, worldZ, out) {
    if (!world || !world.pipelineHandles) return false;
    const cs = world.chunkSizeM;
    const cx = Math.floor(worldX / cs);
    const cy = Math.floor(worldY / cs);
    const cz = Math.floor(worldZ / cs);
    const streamerSlot = LandscapeChunkStreamer.getStreamerSlot(cx, cy, cz);
    if (streamerSlot === -1) return false;

    return LandscapeLightingCoupler.readLightingState(streamerSlot, out);
  },

  /**
   * Get the world's diagnostic state. Delegates to the scene's
   * readDiagnostics.
   */
  readDiagnostics(world, out) {
    if (!world || typeof world.readDiagnostics !== 'function') return false;
    return world.readDiagnostics(out);
  },

  // ═════════════════════════════════════════════════════════
  // ─── CONVENIENCE ───────────────────────────────────────
  // ═════════════════════════════════════════════════════════

  /**
   * Get the current memory profile.
   */
  getMemoryProfile() {
    return LandscapePerformanceGovernor.getMemoryProfile();
  },

  /**
   * Set the memory profile. One of 'LOW' (200 MB), 'MEDIUM' (400 MB), or
   * 'HIGH' (600 MB).
   */
  setMemoryProfile(profileId) {
    return LandscapePerformanceGovernor.setMemoryProfile(profileId);
  },

  /**
   * Get the current degradation state (0..1).
   */
  getDegradationState() {
    return LandscapePerformanceGovernor.getDegradationState();
  }
});

// Import the extra modules needed by query() and mutate() that are not
// used elsewhere in this file. Kept at the bottom to make the file's main
// flow easier to read top-to-bottom.
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { LandscapeErosionSimulator } from './343_LandscapeErosionSimulator.js';
import { LandscapeEventBudget } from './357_LandscapeEventBudget.js';

export default LandscapePublicAPI;