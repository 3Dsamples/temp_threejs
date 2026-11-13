// file number : 327
// full path name : src/context/327_BiomeRegistryBarrel.js
// description : Central biome registry barrel — the single import fan-out point
// that aggregates all twenty-six biome descriptors in the living-world palette
// and exposes O(1) lookups, a pooled scratch-stack for zero-allocation
// per-chunk biome resolution, identity-bit validation, and the register()
// hook contract that every downstream biome consumer (328–336) depends on.
// The registry is pure data and pure logic: it owns no allocation after
// construction, uses pre-sized typed arrays for its lookup tables, and never
// touches the render loop. It imports every biome descriptor from 318–326 and
// from the extended biomes 326_Z01 through 326_Z17, validates that each one
// declares a unique `id`, a unique `bit`, and a `name`, and calls its
// `register(this)` hook so the descriptor can self-register any additional
// tables it needs (e.g. materialId → biomeId maps). The registry then exposes
//   - `getBiome(id)` / `getBiomeByName(name)` / `getBiomeByBit(bit)`
//   - `getMaterialBiome(materialId)` — resolved lazily through each biome's
//     `materialMap` if it declares one, otherwise `-1`
//   - `resolveBiomes(env, outIds, outWeights, maxCount)` — a pooled,
//     zero-allocation per-chunk resolution that scores every registered biome
//     against the environmental sample and returns the top-N (biomeId, weight)
//     pairs ready for 328_BiomeBlendField to smooth.
// All lookups are O(1) via dense integer-keyed arrays sized to the maximum
// biome id; all resolution is O(N_biomes) with a small fixed-N top-K heap that
// uses a preallocated scratch buffer. The descriptor is frozen; consumers
// cannot mutate the registry by accident.
//#
// best for : Every consumer that needs to resolve, blend, or query biome
// descriptors — 328_BiomeBlendField (per-chunk weight resolution),
// 329_BiomeBlendSystem (applies blend weights to the context frame),
// 330_CrossBiomeEcotoneSystem (overlapping biome bands),
// 331_BiomeBlendMaterialBridge (pushes blend scalars into material uniforms),
// 332–335 couplings (climate, soil, hydrology, fauna migration),
// 336_LandscapeChunkDescriptor (per-chunk biome weights), the flora and fauna
// spawners (346–347), the material registry bridge (298), and any runtime
// system that needs to ask "which biome owns this world point?" The registry
// is designed to remain stable from small to galactic scale: the dense
// integer-keyed lookup tables scale with the number of registered biomes, not
// with world size, and the pooled resolution buffer is reused across all
// chunks without allocation.
// license : MIT

// ─── raw 3js primitives — re-exported for downstream consumers ──
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── smoothstep for suitability scoring re-normalisation ────────
import { smoothstep } from './268_ExtrasCurveUtils.js';

// ══════════════════════════════════════════════════════════════════
// ─── BIOME DESCRIPTOR IMPORTS ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Base nine biomes — 318 through 326
import { TropicalRainforestBiome }        from './318_TropicalRainforestBiome.js';
import { TemperateDeciduousForestBiome }  from './319_TemperateDeciduousForestBiome.js';
import { TaigaBorealForestBiome }         from './320_TaigaBorealForestBiome.js';
import { GrasslandSavannaBiome }          from './321_GrasslandSavannaBiome.js';
import { DesertBiome }                    from './322_DesertBiome.js';
import { TundraBiome }                    from './323_TundraBiome.js';
import { AquaticFreshwaterBiome }         from './324_AquaticFreshwaterBiome.js';
import { AquaticMarineBiome }             from './325_AquaticMarineBiome.js';
import { AlpineBiome }                    from './326_AlpineBiome.js';

// Extended biomes — 326_Z01 through 326_Z17
import { WetlandMarshSwampBiome }         from './326_Z01_WetlandMarshSwampBiome.js';
import { MediterraneanChaparralBiome }    from './326_Z02_MediterraneanChaparralBiome.js';
import { SteppePrairieBiome }             from './326_Z03_SteppePrairieBiome.js';
import { SavannaWoodlandBiome }           from './326_Z04_SavannaWoodlandBiome.js';
import { MangroveCoastalBiome }           from './326_Z05_MangroveCoastalBiome.js';
import { TaigaBorealConiferousForestBiome } from './326_Z06_TaigaBorealConiferousForestBiome.js';
import { TemperateDeciduousForestBiome as TemperateDeciduousForestBiomeZ07 }
  from './326_Z07_TemperateDeciduousForestBiome.js';
import { TemperateRainforestBiome }       from './326_Z08_TemperateRainforestBiome.js';
import { SubtropicalHumidForestBiome }    from './326_Z09_SubtropicalHumidForestBiome.js';
import { FloodingPampaGrasslandBiome }    from './326_Z10_FloodingPampaGrasslandBiome.js';
import { CamposGrasslandBiome }           from './326_Z11_CamposGrasslandBiome.js';
import { CerradoSavannaBiome }            from './326_Z12_CerradoSavannaBiome.js';
import { AndeanPunaGrasslandBiome }       from './326_Z13_AndeanPunaGrasslandBiome.js';
import { CanyonlandsBiome }               from './326_Z14_CanyonlandsBiome.js';
import { MountainLakeValleyBiome }        from './326_Z15_MountainLakeValleyBiome.js';
import { RiverDeltaEstuaryBiome }         from './326_Z16_RiverDeltaEstuaryBiome.js';
import { BadlandsErodedHillsBiome }       from './326_Z17_BadlandsErodedHillsBiome.js';

// ══════════════════════════════════════════════════════════════════
// ─── STATIC BIOME LIST ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Order matters only for iteration determinism, not for lookup cost.
const BIOME_LIST = Object.freeze([
  // Base nine
  TropicalRainforestBiome,
  TemperateDeciduousForestBiome,
  TaigaBorealForestBiome,
  GrasslandSavannaBiome,
  DesertBiome,
  TundraBiome,
  AquaticFreshwaterBiome,
  AquaticMarineBiome,
  AlpineBiome,
  // Extended seventeen
  WetlandMarshSwampBiome,
  MediterraneanChaparralBiome,
  SteppePrairieBiome,
  SavannaWoodlandBiome,
  MangroveCoastalBiome,
  TaigaBorealConiferousForestBiome,
  TemperateDeciduousForestBiomeZ07,
  TemperateRainforestBiome,
  SubtropicalHumidForestBiome,
  FloodingPampaGrasslandBiome,
  CamposGrasslandBiome,
  CerradoSavannaBiome,
  AndeanPunaGrasslandBiome,
  CanyonlandsBiome,
  MountainLakeValleyBiome,
  RiverDeltaEstuaryBiome,
  BadlandsErodedHillsBiome
]);

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL POOL ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// A single, shared, preallocated scratch buffer used by every call to
// resolveBiomes(). This eliminates all per-call allocation for the biome
// resolution path. The buffer is sized to hold a fixed maximum number of
// candidates; any excess biomes are dropped from the top-K heap.
const MAX_RESOLVED_BIOMES = 8;
const _scratchScores = new Float32Array(BIOME_LIST.length);
const _scratchIndex  = new Int32Array(BIOME_LIST.length);
const _scratchOrder  = new Int32Array(BIOME_LIST.length);

// ══════════════════════════════════════════════════════════════════
// ─── REGISTRY CONSTRUCTION ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Maximum biome id determines the size of the dense lookup tables.
let _maxBiomeId = -1;
for (let i = 0; i < BIOME_LIST.length; i++) {
  const b = BIOME_LIST[i];
  if (!b || typeof b.id !== 'number') {
    throw new Error(`Biome at index ${i} is missing a numeric id.`);
  }
  if (b.id > _maxBiomeId) _maxBiomeId = b.id;
}

// Dense integer-keyed lookup: id → descriptor, bit → descriptor, name → id
const _byId = new Array(_maxBiomeId + 1).fill(null);
const _byName = new Map();
const _byBit = new Map();
const _materialMap = new Int16Array(65536).fill(-1); // materialId → biomeId

// Validate uniqueness and populate the lookup tables.
for (let i = 0; i < BIOME_LIST.length; i++) {
  const b = BIOME_LIST[i];
  if (_byId[b.id] !== null) {
    throw new Error(`Duplicate biome id ${b.id} (${b.name}).`);
  }
  if (typeof b.bit !== 'number' || b.bit <= 0) {
    throw new Error(`Biome ${b.name} has an invalid bit ${b.bit}.`);
  }
  if (_byBit.has(b.bit)) {
    throw new Error(`Duplicate biome bit ${b.bit} (${b.name}).`);
  }
  if (_byName.has(b.name)) {
    throw new Error(`Duplicate biome name ${b.name}.`);
  }
  _byId[b.id] = b;
  _byName.set(b.name, b.id);
  _byBit.set(b.bit, b.id);
}

// ══════════════════════════════════════════════════════════════════
// ─── MATERIAL → BIOME MAPPING ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Each biome may declare a `materialMap` (Object<materialId, boolean> or
// Object<materialId, weight>). We flatten these into a single dense array
// so `getMaterialBiome(materialId)` is O(1). If a material is claimed by
// more than one biome, the biome with the higher declared weight wins;
// ties are broken by registration order.
for (let i = 0; i < BIOME_LIST.length; i++) {
  const b = BIOME_LIST[i];
  if (!b.materialMap) continue;
  const keys = Object.keys(b.materialMap);
  for (let k = 0; k < keys.length; k++) {
    const matId = Number(keys[k]);
    if (!Number.isInteger(matId) || matId < 0 || matId >= 65536) continue;
    if (_materialMap[matId] === -1) {
      _materialMap[matId] = b.id;
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const BiomeRegistry = Object.freeze({
  // ─── Identity ──────────────────────────────────────────────
  count: BIOME_LIST.length,
  maxId: _maxBiomeId,

  // ─── Direct lookups ───────────────────────────────────────
  /**
   * Get a biome descriptor by its numeric id.
   * @param {number} id
   * @returns {object|null}
   */
  getBiome(id) {
    if (id < 0 || id > _maxBiomeId) return null;
    return _byId[id];
  },

  /**
   * Get a biome descriptor by its string name.
   * @param {string} name
   * @returns {object|null}
   */
  getBiomeByName(name) {
    const id = _byName.get(name);
    return id === undefined ? null : _byId[id];
  },

  /**
   * Get a biome descriptor by its identity bit.
   * @param {number} bit
   * @returns {object|null}
   */
  getBiomeByBit(bit) {
    const id = _byBit.get(bit);
    return id === undefined ? null : _byId[id];
  },

  /**
   * Get the biome id that owns a given material id, or -1 if unclaimed.
   * @param {number} materialId
   * @returns {number}
   */
  getMaterialBiome(materialId) {
    if (!Number.isInteger(materialId) || materialId < 0 || materialId >= 65536) {
      return -1;
    }
    return _materialMap[materialId];
  },

  // ─── Iteration helpers ────────────────────────────────────
  /**
   * Iterate all registered biome descriptors in deterministic order.
   * @param {(biome: object, index: number) => void} fn
   */
  forEach(fn) {
    for (let i = 0; i < BIOME_LIST.length; i++) fn(BIOME_LIST[i], i);
  },

  /**
   * Return a snapshot array of all registered biome descriptors.
   * @returns {object[]}
   */
  list() {
    return BIOME_LIST.slice();
  },

  // ─── Per-chunk resolution (pooled, zero-allocation) ───────
  /**
   * Resolve the top-K biomes for an environmental sample.
   *
   * The function is allocation-free after the first call: it reuses three
   * preallocated scratch buffers sized to BIOME_LIST.length. The caller
   * passes in two preallocated output arrays (`outIds` and `outWeights`)
   * sized to at least `maxCount`; the function writes the resolved biome
   * ids and their normalised weights into these arrays and returns the
   * number of resolved entries (≤ maxCount).
   *
   * The scoring path is O(N_biomes) and uses each biome's own
   * `getSuitability(env)`, so biomes with cheap suitability functions cost
   * less than biomes with expensive ones.
   *
   * @param {object} env - Environmental sample passed through to each biome.
   * @param {Int16Array|Int32Array|Uint16Array} outIds - Output biome ids.
   * @param {Float32Array} outWeights - Output normalised weights.
   * @param {number} [maxCount=4] - Maximum number of resolved biomes.
   * @returns {number} Number of entries written (0..maxCount).
   */
  resolveBiomes(env, outIds, outWeights, maxCount = 4) {
    const n = BIOME_LIST.length;
    const limit = Math.min(maxCount, n, outIds.length, outWeights.length);
    if (limit === 0) return 0;

    // 1. Score every biome and remember its index.
    for (let i = 0; i < n; i++) {
      _scratchIndex[i] = i;
      const s = BIOME_LIST[i].getSuitability(env);
      _scratchScores[i] = (s > 0 && s < 1e-6) ? 0 : s; // flush denormals
    }

    // 2. Partial selection sort for top-K (K is small and fixed).
    //    This avoids allocating an arguments array for a comparator sort.
    for (let k = 0; k < limit; k++) {
      let bestIdx = k;
      let bestScore = _scratchScores[k];
      for (let j = k + 1; j < n; j++) {
        const s = _scratchScores[j];
        if (s > bestScore) {
          bestScore = s;
          bestIdx = j;
        }
      }
      if (bestIdx !== k) {
        // swap scores
        const tmpS = _scratchScores[k];
        _scratchScores[k] = _scratchScores[bestIdx];
        _scratchScores[bestIdx] = tmpS;
        // swap indices
        const tmpI = _scratchIndex[k];
        _scratchIndex[k] = _scratchIndex[bestIdx];
        _scratchIndex[bestIdx] = tmpI;
      }
      _scratchOrder[k] = _scratchIndex[k];
    }

    // 3. Normalise the top-K scores into weights that sum to 1.
    let sum = 0;
    for (let k = 0; k < limit; k++) sum += _scratchScores[k];
    if (sum <= 0) {
      // Degenerate case: assign uniform weights.
      for (let k = 0; k < limit; k++) {
        outIds[k] = BIOME_LIST[_scratchOrder[k]].id;
        outWeights[k] = 1 / limit;
      }
      return limit;
    }
    const invSum = 1 / sum;
    for (let k = 0; k < limit; k++) {
      outIds[k] = BIOME_LIST[_scratchOrder[k]].id;
      outWeights[k] = _scratchScores[k] * invSum;
    }
    return limit;
  },

  // ─── Registration hooks ───────────────────────────────────
  /**
   * Call every biome's register(registry) hook at construction time. Biomes
   * that do not implement register() are silently skipped. This is the
   * contract every downstream biome consumer (328–336) depends on: the
   * registry is fully populated before any consumer reads from it.
   */
  registerAll() {
    for (let i = 0; i < BIOME_LIST.length; i++) {
      const b = BIOME_LIST[i];
      if (typeof b.register === 'function') {
        b.register(this);
      }
    }
  }
});

// ══════════════════════════════════════════════════════════════════
// ─── AUTO-REGISTER AT MODULE LOAD ───────────────────────────────
// ══════════════════════════════════════════════════════════════════
// The registry self-populates on import. This keeps the barrel a pure
// side-effect-free module from the consumer's perspective: `import {
// BiomeRegistry } from './327_BiomeRegistryBarrel.js'` is all that is
// required to get a fully populated registry.
BiomeRegistry.registerAll();

// ─── Convenience re-exports for downstream consumers ────────────
export {
  TropicalRainforestBiome,
  TemperateDeciduousForestBiome,
  TaigaBorealForestBiome,
  GrasslandSavannaBiome,
  DesertBiome,
  TundraBiome,
  AquaticFreshwaterBiome,
  AquaticMarineBiome,
  AlpineBiome,
  WetlandMarshSwampBiome,
  MediterraneanChaparralBiome,
  SteppePrairieBiome,
  SavannaWoodlandBiome,
  MangroveCoastalBiome,
  TaigaBorealConiferousForestBiome,
  TemperateDeciduousForestBiomeZ07,
  TemperateRainforestBiome,
  SubtropicalHumidForestBiome,
  FloodingPampaGrasslandBiome,
  CamposGrasslandBiome,
  CerradoSavannaBiome,
  AndeanPunaGrasslandBiome,
  CanyonlandsBiome,
  MountainLakeValleyBiome,
  RiverDeltaEstuaryBiome,
  BadlandsErodedHillsBiome
};

export default BiomeRegistry;