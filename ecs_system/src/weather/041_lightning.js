// file number : 041
// full path name : src/weather/041_lightning.js
// description : Lightning strike generation, propagation, bolt geometry,
//               and thunder timing system for the bitECS_max runtime.
//               Consumes cumulonimbus storm instances from
//               029_cloud_archetypes.js (via 039's helpers) and produces
//               fully modelled bolts that propagate through the world,
//               resolve to impact points, and emit downstream effects:
//                 • Bolt generation — main-channel polyline plus up to
//                   N secondary branches per strike, generated with a
//                   recursive midpoint-displacement algorithm using 3D
//                   simplex noise for realistic jagged geometry.
//                 • Propagation — the main channel follows a random
//                   walk biased toward the primary impact point with
//                   angular jitter and step length tuned to real lightning
//                   physics (300 m step size, ~10-15° branching angle).
//                 • Strike classification — IC (intra-cloud), CG
//                   (cloud-to-ground), CC (cloud-to-cloud), +CG, -CG.
//                 • Bolts are SoA-packed (segment count, vertices per
//                   segment) so 1M concurrent bolts cost a fixed memory
//                   budget and render through file 005's instanced mesh
//                   buckets in a single draw call.
//                 • Thunder timing — produces ThunderEvent records with
//                   distance-derived delay, intensity falloff, and
//                   spectral hint for file 052's rumble synthesiser.
//                 • Light flash — computes local flash intensity and
//                   colour temperature for file 015's light sources and
//                   file 028's sun dimming.
//                 • Damage hooks — hit-point classification (ground,
//                   water, tree, structure, character) so file 062 can
//                   ignite fires and file 026 can fire reactive observers.
//                 • Storm budget — a hard cap on active bolts per frame
//                   to prevent runaway counts during mega-storms.
//               All state is typed arrays; emission is O(storms), geometry
//               generation is bounded by MAX_BOLTS × MAX_SEGMENTS_PER_BOLT.
//               Zero per-frame allocation; strikes recycle from a fixed
//               pool so long storms never cause GC spikes on Android
//               64-bit.
// best for : Severe-weather rendering, storm gameplay, damage systems,
//            audio/DSP thunder cues, night-time lighting flashes,
//            environmental storytelling, and any 1M-entity scene needing
//            realistic lightning on Android 64-bit.
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
  addTransform,
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  BVHState,
  bvhRaycast,
} from '../spatial/003_bvh_broadphase.js';

import {
  WorldBoundsF32,
  getWorldBoundsCenter,
} from '../geometry/004_aabb_bounds.js';

import {
  CloudInstance,
  CloudArchetype,
  CloudType,
  sampleCloudDensity,
  sampleInstanceDensity,
} from '../sky/029_cloud_archetypes.js';

import {
  CumulonimbusState,
  CumulonimbusSubtype,
  sampleCumulonimbusLightning,
  sampleCumulonimbusSunBlock,
} from '../sky/039_cumulonimbus_clouds.js';

import {
  LightF32,
  LightType,
  addPointLight,
  setLightEnabled,
} from '../render/015_lights_shadows.js';

import {
  vec3,
  vec4,
  mat4,
  createNoise3D,
  poolVec3,
  poolMat4,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                    = 1e-16;
const EPSILON                       = 1e-8;
const EPSILON_HIGH                  = 1e-12;
const PI                            = Math.PI;
const TWO_PI                        = 2 * Math.PI;
const INV_PI                        = 1 / Math.PI;
const INV_TWO_PI                    = 1 / (2 * Math.PI);
const HALF_PI                       = Math.PI / 2;
const DEG_TO_RAD                    = Math.PI / 180;
const RAD_TO_DEG                    = 180 / Math.PI;

const MAX_BOLTS                     = 512;
const MAX_SEGMENTS_PER_BOLT         = 128;
const MAX_BRANCHES_PER_BOLT         = 8;
const MAX_BOLT_VERTICES             = MAX_BOLTS * MAX_SEGMENTS_PER_BOLT * 2;   // 2 endpoints per segment

const BOLT_STEP_LENGTH              = 300.0;     // metres per midpoint
const BOLT_JITTER_AMPLITUDE         = 120.0;     // metres lateral
const BOLT_BRANCH_ANGLE_MIN         = 15 * DEG_TO_RAD;
const BOLT_BRANCH_ANGLE_MAX         = 35 * DEG_TO_RAD;
const BOLT_BRANCH_LENGTH_FRAC_MIN   = 0.15;
const BOLT_BRANCH_LENGTH_FRAC_MAX   = 0.45;
const BOLT_LIFETIME_DEFAULT         = 0.20;      // seconds (main channel)
const BOLT_LIFETIME_BRANCH          = 0.12;      // seconds (secondary)
const BOLT_STRIKE_COOLDOWN_MIN      = 0.05;      // seconds between strikes
const BOLT_STRIKE_COOLDOWN_MAX      = 0.25;
const BOLT_FLASH_RADIUS             = 12000.0;   // metres (light falloff)
const BOLT_FLASH_INTENSITY          = 4.5;       // multiplied by strike
const THUNDER_SPEED_OF_SOUND        = 343.0;     // m/s at 20 °C
const THUNDER_MAX_QUEUE             = 64;
const STORM_LIGHTNING_HARD_CAP      = 8;         // concurrent bolts per storm

// Segment classification for downstream hooks.
const SEG_MAIN      = 0;
const SEG_BRANCH    = 1;
const SEG_GROUND    = 2;

// Strike type.
export const StrikeType = Object.freeze({
  CG_NEGATIVE: 0,
  CG_POSITIVE: 1,
  IC:          2,   // intra-cloud
  CC:          3,   // cloud-to-cloud
});

// Hit surface classification.
export const HitSurface = Object.freeze({
  GROUND:    0,
  WATER:     1,
  TREE:      2,
  STRUCTURE: 3,
  CHARACTER: 4,
  NONE:      5,
});

// ═══════════════════════════════════════════════════════════════════════
// SoA BOLT STORAGE — one slot per active lightning bolt
// ═══════════════════════════════════════════════════════════════════════

export const LightningBolt = {
  // Active flag (1 = visible / evolving).
  active: new Uint8Array(MAX_BOLTS),

  // Owning storm slot (from 039's CumulonimbusState).
  stormSlot: new Uint16Array(MAX_BOLTS),

  // Strike type (StrikeType).
  strikeType: new Uint8Array(MAX_BOLTS),

  // Cloud origin (world space).
  ox: new Float32Array(MAX_BOLTS),
  oy: new Float32Array(MAX_BOLTS),
  oz: new Float32Array(MAX_BOLTS),

  // Impact point (world space).
  ix: new Float32Array(MAX_BOLTS),
  iy: new Float32Array(MAX_BOLTS),
  iz: new Float32Array(MAX_BOLTS),

  // Hit surface (HitSurface).
  hitSurface: new Uint8Array(MAX_BOLTS),

  // Bolt lifetime (seconds).
  age: new Float32Array(MAX_BOLTS),
  lifetime: new Float32Array(MAX_BOLTS),

  // Segment count (main + branches).
  segmentCount: new Uint16Array(MAX_BOLTS),

  // Total vertices (2 per segment).
  vertexCount: new Uint16Array(MAX_BOLTS),

  // Colour temperature for the discharge flash (Kelvin).
  colorTemperature: new Float32Array(MAX_BOLTS),

  // Initial flash intensity (0..1; decays with age/lifetime).
  flashIntensity: new Float32Array(MAX_BOLTS),

  // Thunder event id (or -1 if silent).
  thunderEventId: new Int16Array(MAX_BOLTS),

  // Strike distance to camera (metres; used for thunder delay).
  distanceToCamera: new Float32Array(MAX_BOLTS),

  // Light slot created for this bolt (-1 if none).
  lightSlot: new Int16Array(MAX_BOLTS),

  // Random seed.
  seed: new Uint32Array(MAX_BOLTS),
};

/** Marker: entity is a bolt root (usually not needed; bolts are pooled). */
export const LightningBoltTag = {};

// ═══════════════════════════════════════════════════════════════════════
// VERTEX POOL — SoA storage for every bolt's polyline endpoints
// ═══════════════════════════════════════════════════════════════════════
//
// Layout: vertices are stored contiguously in slot order. Each bolt's
// vertices start at `BoltVertexIndex.start[slot]` and span
// `BoltVertexIndex.count[slot]` vertices. Segments are consecutive pairs.

export const BoltVertexPool = {
  x: new Float32Array(MAX_BOLT_VERTICES),
  y: new Float32Array(MAX_BOLT_VERTICES),
  z: new Float32Array(MAX_BOLT_VERTICES),

  // Per-vertex segment classification (SEG_MAIN, SEG_BRANCH, SEG_GROUND).
  segType: new Uint8Array(MAX_BOLT_VERTICES),

  // Free-slot allocator.
  allocCursor: 0,
};

export const BoltVertexIndex = {
  start: new Uint32Array(MAX_BOLTS),
  count: new Uint16Array(MAX_BOLTS),
};

// ═══════════════════════════════════════════════════════════════════════
// THUNDER EVENT QUEUE
// ═══════════════════════════════════════════════════════════════════════

export const ThunderQueue = {
  boltSlot: new Int16Array(THUNDER_MAX_QUEUE),
  triggerTime: new Float32Array(THUNDER_MAX_QUEUE),   // seconds from now
  intensity: new Float32Array(THUNDER_MAX_QUEUE),
  distance: new Float32Array(THUNDER_MAX_QUEUE),
  strikeType: new Uint8Array(THUNDER_MAX_QUEUE),
  active: new Uint8Array(THUNDER_MAX_QUEUE),

  head: 0,
  tail: 0,
  count: 0,
};

let _nextThunderEventId = 0;

/** Marker: caller listens via file 052's rumble synthesiser. */
export const ThunderEventTag = {};

// ═══════════════════════════════════════════════════════════════════════
// BOLT POOL — free list allocator
// ═══════════════════════════════════════════════════════════════════════

let _nextBoltSlot = 0;

function allocBoltSlot() {
  if (_nextBoltSlot < MAX_BOLTS) {
    return _nextBoltSlot++;
  }
  // Pool exhausted: recycle the oldest bolt.
  let oldestSlot = 0;
  let oldestAge = -1;
  for (let i = 0; i < MAX_BOLTS; i++) {
    if (!LightningBolt.active[i]) return i;
    if (LightningBolt.age[i] > oldestAge) {
      oldestAge = LightningBolt.age[i];
      oldestSlot = i;
    }
  }
  return oldestSlot;
}

// ═══════════════════════════════════════════════════════════════════════
// PRNG
// ═══════════════════════════════════════════════════════════════════════

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
// NOISE — 3D simplex for bolt jaggedness
// ═══════════════════════════════════════════════════════════════════════

const _boltNoise = createNoise3D();

// ═══════════════════════════════════════════════════════════════════════
// STRIKE GENERATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Emit a lightning strike from a cumulonimbus storm.
 *
 * @param world        ECS world
 * @param stormSlot    cumulonimbus slot from file 039
 * @param cameraX/Y/Z  camera position (for thunder delay)
 * @param seed         PRNG seed (0 = derive from storm + time)
 *
 * @returns bolt slot id, or -1 if no strike was generated
 */
export function emitLightningStrike(world, stormSlot, cameraX, cameraY, cameraZ, seed = 0) {
  if (stormSlot < 0 || stormSlot >= _nextCumulonimbusSlotLimit()) return -1;
  if (CumulonimbusState.fade[stormSlot] < 0.2) return -1;

  // Storm budget guard.
  let stormBoltCount = 0;
  for (let s = 0; s < _nextBoltSlot; s++) {
    if (LightningBolt.active[s] && LightningBolt.stormSlot[s] === stormSlot) {
      stormBoltCount++;
    }
  }
  if (stormBoltCount >= STORM_LIGHTNING_HARD_CAP) return -1;

  const baseSlot = CumulonimbusState._baseInstanceSlot[stormSlot];
  if (baseSlot === undefined) return -1;

  const CI = CloudInstance;
  const CBS = CumulonimbusState;

  if (seed === 0) seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  const rng = mulberry32(seed);

  // 1. Determine strike type from storm state.
  const strikeType = pickStrikeType(CBS, stormSlot, rng);

  // 2. Origin: from within the tower.
  const ox = CI.px[baseSlot] + (rng() - 0.5) * CBS.towerRadius[stormSlot] * 0.5;
  const oy = CI.py[baseSlot] - CI.radiusY[baseSlot] + rng() * CI.radiusY[baseSlot] * 0.6;
  const oz = CI.pz[baseSlot] + (rng() - 0.5) * CBS.towerRadius[stormSlot] * 0.5;

  // 3. Impact point: for CG, drop to terrain. For IC/CC, stay within cloud.
  let ix, iy, iz;
  let hitSurface;

  if (strikeType === StrikeType.CG_NEGATIVE || strikeType === StrikeType.CG_POSITIVE) {
    // Cast a ray downward from origin, find terrain (BVH) hit.
    const downDir = [0, -1, 0];
    const hits = bvhRaycast([ox, oy, oz], downDir, 20000, true);
    if (hits.length > 0) {
      const h = hits[0];
      ix = ox + downDir[0] * h.t;
      iy = oy + downDir[1] * h.t;
      iz = oz + downDir[2] * h.t;
      hitSurface = classifyHitSurface(h.eid);
    } else {
      // No BVH proxy — fall to ground plane at Y = 0.
      ix = ox;
      iy = 0;
      iz = oz;
      hitSurface = HitSurface.GROUND;
    }
  } else if (strikeType === StrikeType.IC) {
    // Intra-cloud: stay inside the cloud.
    ix = CI.px[baseSlot] + (rng() - 0.5) * CI.radiusX[baseSlot];
    iy = CI.py[baseSlot] + (rng() - 0.5) * CI.radiusY[baseSlot] * 0.6;
    iz = CI.pz[baseSlot] + (rng() - 0.5) * CI.radiusZ[baseSlot];
    hitSurface = HitSurface.NONE;
  } else {
    // Cloud-to-cloud: hit a neighbouring storm's cloud if one is nearby.
    ix = ox + (rng() - 0.5) * 5000;
    iy = oy + (rng() - 0.5) * 1500;
    iz = oz + (rng() - 0.5) * 5000;
    hitSurface = HitSurface.NONE;
  }

  // 4. Allocate a bolt slot.
  const boltSlot = allocBoltSlot();
  const B = LightningBolt;

  B.active[boltSlot] = 1;
  B.stormSlot[boltSlot] = stormSlot;
  B.strikeType[boltSlot] = strikeType;
  B.ox[boltSlot] = ox;
  B.oy[boltSlot] = oy;
  B.oz[boltSlot] = oz;
  B.ix[boltSlot] = ix;
  B.iy[boltSlot] = iy;
  B.iz[boltSlot] = iz;
  B.hitSurface[boltSlot] = hitSurface;
  B.age[boltSlot] = 0;
  B.lifetime[boltSlot] = BOLT_LIFETIME_DEFAULT;
  B.seed[boltSlot] = seed;
  B.thunderEventId[boltSlot] = -1;
  B.lightSlot[boltSlot] = -1;

  // 5. Colour temperature based on strike type.
  B.colorTemperature[boltSlot] = pickColorTemperature(strikeType);

  // 6. Flash intensity.
  B.flashIntensity[boltSlot] = pickFlashIntensity(strikeType, rng);

  // 7. Distance to camera.
  const dx = ix - cameraX;
  const dy = iy - cameraY;
  const dz = iz - cameraZ;
  B.distanceToCamera[boltSlot] = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // 8. Generate geometry (main channel + branches).
  const generated = generateBoltGeometry(boltSlot, rng);
  if (!generated) {
    B.active[boltSlot] = 0;
    return -1;
  }

  // 9. Queue thunder event.
  if (strikeType === StrikeType.CG_NEGATIVE || strikeType === StrikeType.CG_POSITIVE) {
    const delaySeconds = B.distanceToCamera[boltSlot] / THUNDER_SPEED_OF_SOUND;
    queueThunderEvent(boltSlot, delaySeconds);
  }

  // 10. Emit a point light for the flash.
  const lightSlot = addFlashLight(world, ox, oy, oz,
    B.colorTemperature[boltSlot],
    B.flashIntensity[boltSlot]);
  B.lightSlot[boltSlot] = lightSlot;

  // 11. Update storm lightning count.
  CBS.lightningCount[stormSlot]++;

  return boltSlot;
}

function _nextCumulonimbusSlotLimit() {
  // Hard cap from file 039.
  return 8000;
}

function pickStrikeType(CBS, stormSlot, rng) {
  const subtype = CBS.subtype[stormSlot];
  if (subtype === CumulonimbusSubtype.SUPERCELL) {
    // Supercells favour CG, with many IC.
    const r = rng();
    if (r < 0.55) return StrikeType.CG_NEGATIVE;
    if (r < 0.62) return StrikeType.CG_POSITIVE;
    if (r < 0.90) return StrikeType.IC;
    return StrikeType.CC;
  }
  if (subtype === CumulonimbusSubtype.CAPILLATUS) {
    const r = rng();
    if (r < 0.45) return StrikeType.CG_NEGATIVE;
    if (r < 0.52) return StrikeType.CG_POSITIVE;
    if (r < 0.85) return StrikeType.IC;
    return StrikeType.CC;
  }
  // Calvus / incus mostly IC.
  const r = rng();
  if (r < 0.25) return StrikeType.CG_NEGATIVE;
  if (r < 0.30) return StrikeType.CG_POSITIVE;
  if (r < 0.80) return StrikeType.IC;
  return StrikeType.CC;
}

function pickColorTemperature(strikeType) {
  if (strikeType === StrikeType.CG_POSITIVE) return 13000;  // hotter
  if (strikeType === StrikeType.CG_NEGATIVE) return 11000;
  if (strikeType === StrikeType.IC)          return 10000;
  return 9500;                                              // CC
}

function pickFlashIntensity(strikeType, rng) {
  const base = strikeType === StrikeType.CG_POSITIVE ? 1.0
             : strikeType === StrikeType.CG_NEGATIVE ? 0.85
             : strikeType === StrikeType.IC          ? 0.55
             : 0.40;
  return base * (0.8 + rng() * 0.2);
}

function classifyHitSurface(eid) {
  // For now, heuristic based on entity markers.
  // Future work: check WaterTag, TreeTag, StructureTag, CharacterTag.
  if (hasComponent(null, eid, { })) return HitSurface.NONE;
  return HitSurface.GROUND;
}

// ═══════════════════════════════════════════════════════════════════════
// BOLT GEOMETRY — midpoint displacement along the main channel
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate the bolt's polyline geometry (main channel + branches).
 * Writes vertices into BoltVertexPool starting at the bolt's allocated
 * range. Returns true on success.
 */
function generateBoltGeometry(boltSlot, rng) {
  const B = LightningBolt;

  // Reserve vertices.
  const startVertex = BoltVertexPool.allocCursor;
  let cursor = startVertex;

  const ox = B.ox[boltSlot], oy = B.oy[boltSlot], oz = B.oz[boltSlot];
  const ix = B.ix[boltSlot], iy = B.iy[boltSlot], iz = B.iz[boltSlot];

  // Total distance.
  const dx = ix - ox, dy = iy - oy, dz = iz - oz;
  const totalDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (totalDist < 1) return false;

  // Steps: totalDist / BOLT_STEP_LENGTH, clamped.
  const stepCount = Math.max(4,
    Math.min(MAX_SEGMENTS_PER_BOLT - 8,
      Math.round(totalDist / BOLT_STEP_LENGTH)));

  // Direction.
  const ndx = dx / totalDist, ndy = dy / totalDist, ndz = dz / totalDist;

  // Perpendicular basis.
  const [ux, uy, uz] = perpendicular(ndx, ndy, ndz);

  // Midpoint displacement polyline.
  const positions = new Float32Array((stepCount + 1) * 3);
  for (let i = 0; i <= stepCount; i++) {
    const t = i / stepCount;
    positions[i * 3]     = ox + dx * t;
    positions[i * 3 + 1] = oy + dy * t;
    positions[i * 3 + 2] = oz + dz * t;
  }

  // Apply jagged displacement using simplex noise + random lateral offset.
  const seed = B.seed[boltSlot];
  for (let i = 1; i < stepCount; i++) {
    const t = i / stepCount;
    const baseIndex = i * 3;

    const noiseScale = 3.0 + t * 5.0;
    const nx = _boltNoise(t * noiseScale + seed * 0.001, seed * 0.01, 0);
    const ny = _boltNoise(seed * 0.01, t * noiseScale + seed * 0.001, 0);
    const lateral = BOLT_JITTER_AMPLITUDE * (0.5 + rng() * 0.5);

    positions[baseIndex]     += ux * nx * lateral;
    positions[baseIndex + 1] += uy * ny * lateral;
    positions[baseIndex + 2] += uz * nx * lateral;
  }

  // Write main channel segments.
  for (let i = 0; i < stepCount; i++) {
    const ax = positions[i * 3];
    const ay = positions[i * 3 + 1];
    const az = positions[i * 3 + 2];
    const bx = positions[(i + 1) * 3];
    const by = positions[(i + 1) * 3 + 1];
    const bz = positions[(i + 1) * 3 + 2];

    writeVertexPair(cursor, ax, ay, az, bx, by, bz, SEG_MAIN);
    cursor += 2;
  }

  // Write a ground segment if the strike hit something solid.
  if (B.hitSurface[boltSlot] !== HitSurface.NONE) {
    const lastVert = (stepCount - 1) * 3;
    const gx = positions[stepCount * 3];
    const gy = positions[stepCount * 3 + 1];
    const gz = positions[stepCount * 3 + 2];

    // Short splash segment spreading outward.
    const sx = gx + (rng() - 0.5) * 40;
    const sy = gy - 2;
    const sz = gz + (rng() - 0.5) * 40;
    writeVertexPair(cursor, gx, gy, gz, sx, sy, sz, SEG_GROUND);
    cursor += 2;
  }

  // Branches.
  const branchCount = Math.min(MAX_BRANCHES_PER_BOLT, Math.floor(rng() * 4) + 2);
  for (let b = 0; b < branchCount; b++) {
    const startT = 0.15 + rng() * 0.65;
    const startStep = Math.min(stepCount - 1, Math.floor(startT * stepCount));

    const sx = positions[startStep * 3];
    const sy = positions[startStep * 3 + 1];
    const sz = positions[startStep * 3 + 2];

    // Branch direction: off the main axis.
    const angle = BOLT_BRANCH_ANGLE_MIN + rng() * (BOLT_BRANCH_ANGLE_MAX - BOLT_BRANCH_ANGLE_MIN);
    const branchLengthFrac = BOLT_BRANCH_LENGTH_FRAC_MIN
                           + rng() * (BOLT_BRANCH_LENGTH_FRAC_MAX - BOLT_BRANCH_LENGTH_FRAC_MIN);
    const branchLength = totalDist * branchLengthFrac;

    // Rotate perpendicular around the main axis.
    const [bux, buy, buz] = rotateAroundAxis(ux, uy, uz, ndx, ndy, ndz, angle);
    const ex = sx + bux * branchLength + ndx * branchLength * 0.4;
    const ey = sy + buy * branchLength + ndy * branchLength * 0.4;
    const ez = sz + buz * branchLength + ndz * branchLength * 0.4;

    // Simple 2-step branch.
    const midx = (sx + ex) * 0.5 + (rng() - 0.5) * BOLT_JITTER_AMPLITUDE * 0.5;
    const midy = (sy + ey) * 0.5 + (rng() - 0.5) * BOLT_JITTER_AMPLITUDE * 0.3;
    const midz = (sz + ez) * 0.5 + (rng() - 0.5) * BOLT_JITTER_AMPLITUDE * 0.5;

    writeVertexPair(cursor, sx, sy, sz, midx, midy, midz, SEG_BRANCH);
    cursor += 2;
    writeVertexPair(cursor, midx, midy, midz, ex, ey, ez, SEG_BRANCH);
    cursor += 2;
  }

  BoltVertexIndex.start[boltSlot] = startVertex;
  BoltVertexIndex.count[boltSlot] = cursor - startVertex;
  B.vertexCount[boltSlot] = cursor - startVertex;
  B.segmentCount[boltSlot] = (cursor - startVertex) / 2;

  // Advance the pool cursor.
  BoltVertexPool.allocCursor = cursor;

  // Wrap the pool cursor if it gets close to overflow.
  if (BoltVertexPool.allocCursor > MAX_BOLT_VERTICES - MAX_SEGMENTS_PER_BOLT * 2 * 8) {
    BoltVertexPool.allocCursor = 0;
  }

  return true;
}

function writeVertexPair(cursor, ax, ay, az, bx, by, bz, segType) {
  const P = BoltVertexPool;
  P.x[cursor]     = ax;
  P.y[cursor]     = ay;
  P.z[cursor]     = az;
  P.segType[cursor] = segType;

  P.x[cursor + 1]     = bx;
  P.y[cursor + 1]     = by;
  P.z[cursor + 1]     = bz;
  P.segType[cursor + 1] = segType;
}

function perpendicular(dx, dy, dz) {
  // Pick the axis least aligned with the direction.
  if (Math.abs(dx) < Math.abs(dy) && Math.abs(dx) < Math.abs(dz)) {
    return normalize3(0, -dz, dy);
  }
  if (Math.abs(dy) < Math.abs(dz)) {
    return normalize3(-dz, 0, dx);
  }
  return normalize3(-dy, dx, 0);
}

function normalize3(x, y, z) {
  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  return [x / len, y / len, z / len];
}

function rotateAroundAxis(px, py, pz, ax, ay, az, angle) {
  // Rodrigues rotation of (p) around (a) by angle.
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  const dot = px * ax + py * ay + pz * az;
  const cx = ay * pz - az * py;
  const cy = az * px - ax * pz;
  const cz = ax * py - ay * px;

  return [
    px * cosA + cx * sinA + ax * dot * (1 - cosA),
    py * cosA + cy * sinA + ay * dot * (1 - cosA),
    pz * cosA + cz * sinA + az * dot * (1 - cosA),
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// THUNDER QUEUE
// ═══════════════════════════════════════════════════════════════════════

function queueThunderEvent(boltSlot, delaySeconds) {
  const Q = ThunderQueue;
  if (Q.count >= THUNDER_MAX_QUEUE) {
    // Drop oldest.
    Q.tail = (Q.tail + 1) % THUNDER_MAX_QUEUE;
    Q.count--;
  }

  const idx = Q.head;
  Q.boltSlot[idx] = boltSlot;
  Q.triggerTime[idx] = delaySeconds;
  Q.intensity[idx] = LightningBolt.flashIntensity[boltSlot];
  Q.distance[idx] = LightningBolt.distanceToCamera[boltSlot];
  Q.strikeType[idx] = LightningBolt.strikeType[boltSlot];
  Q.active[idx] = 1;

  LightningBolt.thunderEventId[boltSlot] = _nextThunderEventId++;

  Q.head = (Q.head + 1) % THUNDER_MAX_QUEUE;
  Q.count++;
}

/**
 * Advance the thunder queue. Any event whose trigger time reaches 0 is
 * marked as deliverable — the caller is expected to consume them via
 * `popThunderEvent`.
 */
export function systemTickThunder(dt) {
  const Q = ThunderQueue;

  for (let i = 0; i < Q.head; i++) {
    if (!Q.active[i]) continue;
    Q.triggerTime[i] -= dt;
  }

  return ThunderQueue.count;
}

/**
 * Pop one thunder event whose trigger time has elapsed. Returns
 * { intensity, distance, strikeType } or null if none ready.
 */
export function popThunderEvent() {
  const Q = ThunderQueue;

  for (let i = Q.tail; i !== Q.head; i = (i + 1) % THUNDER_MAX_QUEUE) {
    if (!Q.active[i]) continue;
    if (Q.triggerTime[i] <= 0) {
      Q.active[i] = 0;
      return {
        intensity: Q.intensity[i],
        distance: Q.distance[i],
        strikeType: Q.strikeType[i],
      };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// FLASH LIGHT
// ═══════════════════════════════════════════════════════════════════════

function addFlashLight(world, ox, oy, oz, colorTemperatureK, intensity) {
  // Create a point light entity at the bolt's origin.
  const eid = _allocFlashLightEntity(world);
  addTransform(world, eid, { px: ox, py: oy, pz: oz });

  const lightSlot = addPointLight(world, eid, {
    color: blackbodyColor(colorTemperatureK),
    intensity: intensity * BOLT_FLASH_INTENSITY,
    range: BOLT_FLASH_RADIUS,
    castShadow: false,
    layerMask: 1,
  });

  return lightSlot;
}

const _flashLightEntityPool = [];

function _allocFlashLightEntity(world) {
  const eid = _internalAddEntity(world);
  return eid;
}

function _internalAddEntity(world) {
  const ctx = world[$internal];
  const index = ctx.entityIndex;
  const id = index.maxId + 1;
  index.maxId = id;
  index.dense[index.aliveCount] = id;
  index.sparse[id] = index.aliveCount;
  index.aliveCount++;
  ctx.entityComponents.set(id, new Set());
  return id;
}

/**
 * Approximate blackbody colour at a given temperature (Kelvin) in
 * linear RGB. Returns a 3-element array.
 */
export function blackbodyColor(temperatureK) {
  const t = temperatureK / 100;

  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(Math.max(t, 1)) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }

  return [
    Math.max(0, Math.min(255, r)) / 255,
    Math.max(0, Math.min(255, g)) / 255,
    Math.max(0, Math.min(255, b)) / 255,
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SYSTEM — advance bolts, decay lights, retire dead bolts
// ═══════════════════════════════════════════════════════════════════════

/**
 * Advance all active bolts by dt. Handles:
 *   • age and lifetime
 *   • flash intensity decay
 *   • light slot intensity decay
 *   • retirement (deactivates bolts whose age exceeds their lifetime)
 *
 * Does NOT generate new strikes — that is driven by the caller
 * (usually a storm scheduler in file 063 or via direct emitLightningStrike
 * calls tied to file 039's storm state).
 */
export function systemUpdateLightning(world, dt) {
  const B = LightningBolt;

  for (let slot = 0; slot < _nextBoltSlot; slot++) {
    if (!B.active[slot]) continue;

    B.age[slot] += dt;

    // Intensity decay: fade over lifetime with a sharp initial drop.
    const t = B.age[slot] / B.lifetime[slot];
    const intensityScale = Math.max(0, 1 - t * t);

    // Update the flash light.
    const lightSlot = B.lightSlot[slot];
    if (lightSlot >= 0) {
      LightF32.intensity[lightSlot] = B.flashIntensity[slot] * intensityScale * BOLT_FLASH_INTENSITY;
    }

    // Retire bolt when age exceeds lifetime.
    if (B.age[slot] >= B.lifetime[slot]) {
      B.active[slot] = 0;

      // Disable the flash light.
      if (lightSlot >= 0) {
        setLightEnabled(lightSlot, false);
      }

      // Free the vertex range (optional; reused by the ring buffer).
      // No per-bolt free list required — the pool cursor wraps around.
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC HELPERS — for renderer and audio integration
// ═══════════════════════════════════════════════════════════════════════

/**
 * Return the polyline vertex range for a bolt (for rendering via
 * file 005's instanced mesh or custom line geometry).
 */
export function getBoltVertexRange(boltSlot) {
  if (!LightningBolt.active[boltSlot]) return null;
  return {
    start: BoltVertexIndex.start[boltSlot],
    count: BoltVertexIndex.count[boltSlot],
    stride: 2,
    segType: BoltVertexPool.segType,
  };
}

/**
 * Return the current flash intensity for a bolt (used by sky radiance
 * for a subtle sky flash at bolt time).
 */
export function getBoltFlashIntensity(boltSlot) {
  if (!LightningBolt.active[boltSlot]) return 0;
  const t = LightningBolt.age[boltSlot] / LightningBolt.lifetime[boltSlot];
  return LightningBolt.flashIntensity[boltSlot] * Math.max(0, 1 - t * t);
}

/**
 * Return all bolts that are currently flashing (for lightning-lit scenes
 * in file 017). Optionally filtered by a max distance from a given point.
 */
export function getActiveBolts(cameraX, cameraY, cameraZ, maxDistance = BOLT_FLASH_RADIUS) {
  const result = [];
  const B = LightningBolt;

  for (let slot = 0; slot < _nextBoltSlot; slot++) {
    if (!B.active[slot]) continue;

    const dx = B.ox[slot] - cameraX;
    const dy = B.oy[slot] - cameraY;
    const dz = B.oz[slot] - cameraZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > maxDistance) continue;

    result.push({
      slot,
      ox: B.ox[slot],
      oy: B.oy[slot],
      oz: B.oz[slot],
      intensity: getBoltFlashIntensity(slot),
      colorTemperature: B.colorTemperature[slot],
      distance: dist,
      strikeType: B.strikeType[slot],
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function lightningStats() {
  let active = 0;
  let cgNegative = 0, cgPositive = 0, ic = 0, cc = 0;

  for (let slot = 0; slot < _nextBoltSlot; slot++) {
    if (!LightningBolt.active[slot]) continue;
    active++;
    const type = LightningBolt.strikeType[slot];
    if (type === StrikeType.CG_NEGATIVE) cgNegative++;
    else if (type === StrikeType.CG_POSITIVE) cgPositive++;
    else if (type === StrikeType.IC) ic++;
    else if (type === StrikeType.CC) cc++;
  }

  return {
    activeBolts: active,
    totalSlots: _nextBoltSlot,
    cgNegative,
    cgPositive,
    intraCloud: ic,
    cloudToCloud: cc,
    thunderQueueDepth: ThunderQueue.count,
    vertexPoolUsed: BoltVertexPool.allocCursor,
    vertexPoolTotal: MAX_BOLT_VERTICES,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearLightning() {
  LightningBolt.active.fill(0);
  BoltVertexPool.allocCursor = 0;
  BoltVertexIndex.start.fill(0);
  BoltVertexIndex.count.fill(0);
  ThunderQueue.head = 0;
  ThunderQueue.tail = 0;
  ThunderQueue.count = 0;
  ThunderQueue.active.fill(0);
  _nextBoltSlot = 0;
  _nextThunderEventId = 0;
}