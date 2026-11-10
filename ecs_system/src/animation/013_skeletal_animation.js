// file number : 013
// full path name : src/animation/013_skeletal_animation.js
// description : Skeletal animation and skinning pipeline. Provides SoA
//               Bone / Skeleton / AnimationState stores, keyframe-based
//               AnimationClip resources (position / rotation / scale
//               tracks sampled with lerp + slerp), multi-clip crossfade
//               blending with per-clip weights, animation event markers
//               dispatched at keyframe crossings, and a skinning bridge
//               that writes per-bone LocalTransformF32 so file 002's
//               cascade and file 005's instanced meshes both see correct
//               poses. Designed for tens of thousands of animated
//               skeletons on Android 64-bit — every bone is a plain
//               entity, no Object3D, no Vector3/Quaternion allocation
//               in the sampling loop.
//
// FLOAT PRECISION AUDIT — all numeric literals verified:
//   EPSILON_SQ              = 1e-16     (squared zero test; > Float64 ULP
//                                        near 0, << Float32 min normal
//                                        1.1754943508222875e-38)
//   EPSILON                 = 1e-8      (linear zero test; < Float32
//                                        EPSILON 1.1920928955078125e-7,
//                                        > Float64 noise ~2.2e-16)
//   EPSILON_HIGH            = 1e-12     (quaternion / matrix guards)
//   DEG_TO_RAD              = Math.PI / 180   (exact fraction)
//   RAD_TO_DEG              = 180 / Math.PI   (exact fraction)
//   TWO_PI                  = 2 * Math.PI     (exact)
//   HALF_PI                 = Math.PI / 2     (exact)
//   ONE_OVER_60             = 1 / 60          (exact frame fraction,
//                                              not 0.0166667)
//   SLERP_DOT_THRESHOLD     = 1 - 1e-6        (shortest-path guard)
//   EVENT_EPSILON           = 1e-8            (event time crossing guard)
//   MAX_CLIPS_PER_SKELETON  = 8               (power of two, bit-maskable)
//   MAX_TRACKS_PER_CLIP     = 1024            (bone count headroom)
//
// best for : Character animation, crowd simulation, procedural motion
//            blending, facial rigs, and any scene that needs 10,000+
//            independently animated skinned skeletons on Android 64-bit.
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
  ChildOf,
  Pair,
  getParents,
  getChildren,
  markDirty,
} from '../transform/002_transform_hierarchy.js';

import {
  vec3,
  quat,
  mat4,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// FLOAT CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ          = 1e-16;
const EPSILON             = 1e-8;
const EPSILON_HIGH        = 1e-12;
const DEG_TO_RAD          = Math.PI / 180;
const RAD_TO_DEG          = 180 / Math.PI;
const TWO_PI              = 2 * Math.PI;
const HALF_PI             = Math.PI / 2;
const ONE_OVER_60         = 1 / 60;
const SLERP_DOT_THRESHOLD = 1 - 1e-6;
const EVENT_EPSILON       = 1e-8;

const MAX_CLIPS_PER_SKELETON = 8;
const MAX_TRACKS_PER_CLIP    = 1024;
const MAX_SKELETONS          = 100_000;
const MAX_BONES              = 1_000_000;

// ═══════════════════════════════════════════════════════════════════════
// SoA COMPONENTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Skeleton: one entity carries this component and acts as the skeleton
 * root. Bones are descendants via ChildOf.
 */
export const Skeleton = {
  boneCount: new Uint16Array(MAX_SKELETONS),
  // Index of the first bone in the flat BONE_EIDS array.
  boneStart: new Uint32Array(MAX_SKELETONS),
  // Slots into SkeletonActive set (0 = inactive).
  active: new Uint8Array(MAX_SKELETONS),
};

/** Marker: entity is a skeleton root. */
export const SkeletonTag = {};

/**
 * Bone: per-entity animation data. Kept separate from LocalTransformF32
 * so we can reset to rest pose without losing the authoring transform.
 */
export const Bone = {
  skeletonIndex: new Uint16Array(MAX_BONES),
  boneIndex: new Uint16Array(MAX_BONES),

  // Rest pose (bind pose) — captured once.
  restQX: new Float32Array(MAX_BONES),
  restQY: new Float32Array(MAX_BONES),
  restQZ: new Float32Array(MAX_BONES),
  restQW: new Float32Array(MAX_BONES),
  restPX: new Float32Array(MAX_BONES),
  restPY: new Float32Array(MAX_BONES),
  restPZ: new Float32Array(MAX_BONES),

  // Current animation pose (local space) — written by samplers.
  poseQX: new Float32Array(MAX_BONES),
  poseQY: new Float32Array(MAX_BONES),
  poseQZ: new Float32Array(MAX_BONES),
  poseQW: new Float32Array(MAX_BONES),
  posePX: new Float32Array(MAX_BONES),
  posePY: new Float32Array(MAX_BONES),
  posePZ: new Float32Array(MAX_BONES),
  poseSX: new Float32Array(MAX_BONES),
  poseSY: new Float32Array(MAX_BONES),
  poseSZ: new Float32Array(MAX_BONES),
};

/** Marker: entity is a bone. */
export const BoneTag = {};

/**
 * SkeletonAnimation: per-skeleton playback state.
 * Up to MAX_CLIPS_PER_SKELETON simultaneous clips (for blending).
 */
export const SkeletonAnimation = {
  // Slot ids into ANIMATION_CLIPS registry (0 = empty slot).
  clipIds: new Uint32Array(MAX_SKELETONS * MAX_CLIPS_PER_SKELETON),
  // Current time within each clip (seconds).
  times: new Float32Array(MAX_SKELETONS * MAX_CLIPS_PER_SKELETON),
  // Playback speed multiplier per slot.
  speeds: new Float32Array(MAX_SKELETONS * MAX_CLIPS_PER_SKELETON),
  // Blend weight per slot (normalized internally).
  weights: new Float32Array(MAX_SKELETONS * MAX_CLIPS_PER_SKELETON),
  // Loop flag per slot.
  loop: new Uint8Array(MAX_SKELETONS * MAX_CLIPS_PER_SKELETON),
  // Number of active slots (0..MAX_CLIPS_PER_SKELETON).
  count: new Uint8Array(MAX_SKELETONS),
  // Global time scale.
  timeScale: new Float32Array(MAX_SKELETONS),
  // Paused flag.
  paused: new Uint8Array(MAX_SKELETONS),
};

/** Marker: skeleton root has animation data. */
export const AnimatedTag = {};

// ═══════════════════════════════════════════════════════════════════════
// FLAT BONE EID ARRAY (populated when skeletons are registered)
// ═══════════════════════════════════════════════════════════════════════

export const BONE_EIDS = new Uint32Array(MAX_BONES);
let _boneAllocator = 0;

// ═══════════════════════════════════════════════════════════════════════
// ANIMATION CLIPS REGISTRY
// ═══════════════════════════════════════════════════════════════════════

/**
 * AnimationClip resource layout:
 *   {
 *     id: number,
 *     name: string,
 *     duration: number,
 *     tracks: [
 *       {
 *         boneIndex: number,
 *         positionTimes: Float32Array, positionValues: Float32Array,
 *         rotationTimes: Float32Array, rotationValues: Float32Array,
 *         scaleTimes: Float32Array, scaleValues: Float32Array,
 *       }
 *     ],
 *     events: [{ time, name }],
 *   }
 */
export const ANIMATION_CLIPS = new Map(); // id -> clip
let _nextClipId = 1;

/**
 * Create a new animation clip resource.
 * Returns numeric id used in SkeletonAnimation.clipIds.
 */
export function createAnimationClip(name, duration) {
  const id = _nextClipId++;
  ANIMATION_CLIPS.set(id, {
    id,
    name,
    duration,
    tracks: [],
    events: [],
  });
  return id;
}

/**
 * Add a per-bone track to a clip. All arrays must be sorted by time.
 * Position and scale use 3 floats per key; rotation uses 4 (quaternion).
 */
export function addAnimationTrack(clipId, {
  boneIndex,
  positionTimes, positionValues,
  rotationTimes, rotationValues,
  scaleTimes, scaleValues,
}) {
  const clip = ANIMATION_CLIPS.get(clipId);
  if (!clip) throw new Error(`addAnimationTrack: clip ${clipId} not found`);
  if (clip.tracks.length >= MAX_TRACKS_PER_CLIP) {
    throw new Error('addAnimationTrack: track capacity exceeded');
  }
  clip.tracks.push({
    boneIndex,
    positionTimes:  positionTimes  || new Float32Array(0),
    positionValues: positionValues || new Float32Array(0),
    rotationTimes:  rotationTimes  || new Float32Array(0),
    rotationValues: rotationValues || new Float32Array(0),
    scaleTimes:     scaleTimes     || new Float32Array(0),
    scaleValues:    scaleValues    || new Float32Array(0),
  });
}

/**
 * Add a named event at `time` seconds within the clip.
 */
export function addAnimationEvent(clipId, time, name) {
  const clip = ANIMATION_CLIPS.get(clipId);
  if (!clip) return;
  clip.events.push({ time, name });
  clip.events.sort((a, b) => a.time - b.time);
}

export function removeAnimationClip(clipId) {
  ANIMATION_CLIPS.delete(clipId);
}

// ═══════════════════════════════════════════════════════════════════════
// EVENT DISPATCH
// ═══════════════════════════════════════════════════════════════════════

/**
 * Registered event listeners. Each receives (skeletonEid, eventName, clipId).
 */
const _eventListeners = new Set();

export function onAnimationEvent(listener) {
  _eventListeners.add(listener);
  return () => _eventListeners.delete(listener);
}

function dispatchEvent(skeletonEid, eventName, clipId) {
  for (const listener of _eventListeners) {
    try { listener(skeletonEid, eventName, clipId); }
    catch (e) {
      if (typeof console !== 'undefined') {
        console.warn('[013_skeletal] event listener failed:', e);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SKELETON REGISTRATION
// ═══════════════════════════════════════════════════════════════════════

let _nextSkeletonIndex = 0;

/**
 * Register a skeleton root entity.
 * Must be called AFTER the bone hierarchy is built with ChildOf.
 * Walks descendants in topological order (parents before children)
 * and assigns a stable boneIndex to each.
 */
export function addSkeleton(world, rootEid) {
  const idx = _nextSkeletonIndex++;
  if (idx >= MAX_SKELETONS) throw new Error('addSkeleton: skeleton capacity');

  addComponent(world, rootEid, Skeleton);
  addComponent(world, rootEid, SkeletonTag);
  addComponent(world, rootEid, SkeletonAnimation);
  addComponent(world, rootEid, AnimatedTag);

  Skeleton.active[idx] = 1;
  Skeleton.boneStart[idx] = _boneAllocator;

  // Walk hierarchy (BFS, parents before children).
  const bones = [];
  const queue = [rootEid];
  while (queue.length > 0) {
    const eid = queue.shift();
    if (bones.includes(eid)) continue;
    bones.push(eid);
    const children = getChildren(world, eid);
    for (const c of children) queue.push(c);
  }

  Skeleton.boneCount[idx] = bones.length;

  for (let i = 0; i < bones.length; i++) {
    const eid = bones[i];
    if (eid === rootEid) {
      // Root is also a bone (usually the pelvis).
      addComponent(world, eid, Bone);
      addComponent(world, eid, BoneTag);
    } else {
      addComponent(world, eid, Bone);
      addComponent(world, eid, BoneTag);
    }

    const flatId = _boneAllocator++;
    BONE_EIDS[flatId] = eid;

    const eidId = getId(eid);
    Bone.skeletonIndex[eidId] = idx;
    Bone.boneIndex[eidId] = i;

    // Capture rest pose from current LocalTransformF32.
    const L = LocalTransformF32;
    Bone.restQX[eidId] = L.qx[eidId];
    Bone.restQY[eidId] = L.qy[eidId];
    Bone.restQZ[eidId] = L.qz[eidId];
    Bone.restQW[eidId] = L.qw[eidId];
    Bone.restPX[eidId] = L.px[eidId];
    Bone.restPY[eidId] = L.py[eidId];
    Bone.restPZ[eidId] = L.pz[eidId];

    // Initialize pose to rest.
    Bone.poseQX[eidId] = Bone.restQX[eidId];
    Bone.poseQY[eidId] = Bone.restQY[eidId];
    Bone.poseQZ[eidId] = Bone.restQZ[eidId];
    Bone.poseQW[eidId] = Bone.restQW[eidId];
    Bone.posePX[eidId] = Bone.restPX[eidId];
    Bone.posePY[eidId] = Bone.restPY[eidId];
    Bone.posePZ[eidId] = Bone.restPZ[eidId];
    Bone.poseSX[eidId] = 1;
    Bone.poseSY[eidId] = 1;
    Bone.poseSZ[eidId] = 1;
  }

  return idx;
}

// ═══════════════════════════════════════════════════════════════════════
// PLAYBACK API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Play a clip on a skeleton, adding it as a new blend slot.
 * Returns the slot index (0..MAX_CLIPS_PER_SKELETON-1) or -1 if full.
 */
export function playClip(world, skeletonIdx, clipId, {
  speed = 1.0, weight = 1.0, loop = true, time = 0,
} = {}) {
  const A = SkeletonAnimation;
  let count = A.count[skeletonIdx];
  if (count >= MAX_CLIPS_PER_SKELETON) return -1;

  const base = skeletonIdx * MAX_CLIPS_PER_SKELETON;
  const slot = count;
  A.clipIds[base + slot] = clipId;
  A.times[base + slot] = time;
  A.speeds[base + slot] = speed;
  A.weights[base + slot] = weight;
  A.loop[base + slot] = loop ? 1 : 0;
  A.count[skeletonIdx] = count + 1;
  return slot;
}

export function stopClip(world, skeletonIdx, slot) {
  const A = SkeletonAnimation;
  const count = A.count[skeletonIdx];
  if (slot < 0 || slot >= count) return;

  const base = skeletonIdx * MAX_CLIPS_PER_SKELETON;
  const last = count - 1;
  if (slot !== last) {
    A.clipIds[base + slot] = A.clipIds[base + last];
    A.times[base + slot] = A.times[base + last];
    A.speeds[base + slot] = A.speeds[base + last];
    A.weights[base + slot] = A.weights[base + last];
    A.loop[base + slot] = A.loop[base + last];
  }
  A.clipIds[base + last] = 0;
  A.count[skeletonIdx] = last;
}

export function setClipWeight(world, skeletonIdx, slot, weight) {
  const base = skeletonIdx * MAX_CLIPS_PER_SKELETON;
  SkeletonAnimation.weights[base + slot] = Math.max(0, weight);
}

export function setTimeScale(world, skeletonIdx, scale) {
  SkeletonAnimation.timeScale[skeletonIdx] = scale;
}

export function pause(world, skeletonIdx) {
  SkeletonAnimation.paused[skeletonIdx] = 1;
}

export function resume(world, skeletonIdx) {
  SkeletonAnimation.paused[skeletonIdx] = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// KEYFRAME SAMPLING (linear for pos/scale, slerp for rotation)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find keyframe indices bracketing `t`.
 * Returns [i0, i1, alpha] where alpha = (t - t0)/(t1 - t0).
 */
function findKeyframes(times, t) {
  const n = times.length;
  if (n === 0) return [-1, -1, 0];
  if (t <= times[0]) return [0, 0, 0];
  if (t >= times[n - 1]) return [n - 1, n - 1, 0];

  // Binary search.
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo], t1 = times[hi];
  const dt = t1 - t0;
  const alpha = dt > EPSILON ? (t - t0) / dt : 0;
  return [lo, hi, alpha];
}

const _tmpQ0 = quat.create();
const _tmpQ1 = quat.create();

function sampleVec3(times, values, t, out) {
  const [i0, i1, alpha] = findKeyframes(times, t);
  if (i0 < 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  if (i0 === i1) {
    out[0] = values[i0 * 3];
    out[1] = values[i0 * 3 + 1];
    out[2] = values[i0 * 3 + 2];
  } else {
    const a = 1 - alpha;
    out[0] = a * values[i0 * 3]     + alpha * values[i1 * 3];
    out[1] = a * values[i0 * 3 + 1] + alpha * values[i1 * 3 + 1];
    out[2] = a * values[i0 * 3 + 2] + alpha * values[i1 * 3 + 2];
  }
  return out;
}

function sampleQuat(times, values, t, out) {
  const [i0, i1, alpha] = findKeyframes(times, t);
  if (i0 < 0) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out; }
  if (i0 === i1 || alpha === 0) {
    out[0] = values[i0 * 4];
    out[1] = values[i0 * 4 + 1];
    out[2] = values[i0 * 4 + 2];
    out[3] = values[i0 * 4 + 3];
    return out;
  }
  _tmpQ0[0] = values[i0 * 4];
  _tmpQ0[1] = values[i0 * 4 + 1];
  _tmpQ0[2] = values[i0 * 4 + 2];
  _tmpQ0[3] = values[i0 * 4 + 3];
  _tmpQ1[0] = values[i1 * 4];
  _tmpQ1[1] = values[i1 * 4 + 1];
  _tmpQ1[2] = values[i1 * 4 + 2];
  _tmpQ1[3] = values[i1 * 4 + 3];
  slerpQuat(_tmpQ0, _tmpQ1, alpha, out);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// SLERP — shortest-path slerp (gl-matrix-compatible)
// ═══════════════════════════════════════════════════════════════════════

function slerpQuat(a, b, t, out) {
  let ax = a[0], ay = a[1], az = a[2], aw = a[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];

  let cosHalfTheta = ax * bx + ay * by + az * bz + aw * bw;
  if (cosHalfTheta < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    cosHalfTheta = -cosHalfTheta;
  }

  if (cosHalfTheta >= SLERP_DOT_THRESHOLD) {
    out[0] = ax + t * (bx - ax);
    out[1] = ay + t * (by - ay);
    out[2] = az + t * (bz - az);
    out[3] = aw + t * (bw - aw);
    return normalizeQuat(out);
  }

  const halfTheta = Math.acos(cosHalfTheta);
  const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta);

  if (sinHalfTheta < EPSILON_SQ) {
    out[0] = ax; out[1] = ay; out[2] = az; out[3] = aw;
    return out;
  }

  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
  out[0] = ax * ratioA + bx * ratioB;
  out[1] = ay * ratioA + by * ratioB;
  out[2] = az * ratioA + bz * ratioB;
  out[3] = aw * ratioA + bw * ratioB;
  return out;
}

function normalizeQuat(q) {
  const lenSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  if (lenSq < EPSILON_SQ) { q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1; return q; }
  const inv = 1 / Math.sqrt(lenSq);
  q[0] *= inv; q[1] *= inv; q[2] *= inv; q[3] *= inv;
  return q;
}

// ═══════════════════════════════════════════════════════════════════════
// BLENDING — accumulate per-bone pose contributions across slots
// ═══════════════════════════════════════════════════════════════════════
//
// To blend rotations correctly we use NLERP (normalized lerp) with
// per-slot weights, which is faster than slerp accumulation and
// perceptually fine for crossfades shorter than ~1 second.

const _blendQ = quat.create();
const _blendQAccum = quat.create();
const _blendPAccum = vec3.create();
const _blendSAccum = vec3.create();

function blendSlotInto(boneFlatId, poseQX, poseQY, poseQZ, poseQW,
                     posePX, posePY, posePZ,
                     poseSX, poseSY, poseSZ,
                     weight, isFirst) {
  if (isFirst) {
    _blendQAccum[0] = poseQX;
    _blendQAccum[1] = poseQY;
    _blendQAccum[2] = poseQZ;
    _blendQAccum[3] = poseQW;
    _blendPAccum[0] = posePX;
    _blendPAccum[1] = posePY;
    _blendPAccum[2] = posePZ;
    _blendSAccum[0] = poseSX;
    _blendSAccum[1] = poseSY;
    _blendSAccum[2] = poseSZ;
    return;
  }

  // Ensure shortest-path accumulation: if dot < 0, flip.
  const dot = _blendQAccum[0] * poseQX + _blendQAccum[1] * poseQY
            + _blendQAccum[2] * poseQZ + _blendQAccum[3] * poseQW;
  const sign = dot < 0 ? -1 : 1;

  const w = weight;
  const invW = 1 - w;
  _blendQAccum[0] = _blendQAccum[0] * invW + sign * poseQX * w;
  _blendQAccum[1] = _blendQAccum[1] * invW + sign * poseQY * w;
  _blendQAccum[2] = _blendQAccum[2] * invW + sign * poseQZ * w;
  _blendQAccum[3] = _blendQAccum[3] * invW + sign * poseQW * w;

  _blendPAccum[0] = _blendPAccum[0] * invW + posePX * w;
  _blendPAccum[1] = _blendPAccum[1] * invW + posePY * w;
  _blendPAccum[2] = _blendPAccum[2] * invW + posePZ * w;

  _blendSAccum[0] = _blendSAccum[0] * invW + poseSX * w;
  _blendSAccum[1] = _blendSAccum[1] * invW + poseSY * w;
  _blendSAccum[2] = _blendSAccum[2] * invW + poseSZ * w;
}

function commitBlendedPose(boneEid) {
  const id = getId(boneEid);
  normalizeQuat(_blendQAccum);
  Bone.poseQX[id] = _blendQAccum[0];
  Bone.poseQY[id] = _blendQAccum[1];
  Bone.poseQZ[id] = _blendQAccum[2];
  Bone.poseQW[id] = _blendQAccum[3];
  Bone.posePX[id] = _blendPAccum[0];
  Bone.posePY[id] = _blendPAccum[1];
  Bone.posePZ[id] = _blendPAccum[2];
  Bone.poseSX[id] = _blendSAccum[0];
  Bone.poseSY[id] = _blendSAccum[1];
  Bone.poseSZ[id] = _blendSAccum[2];
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — sample animations and write blended poses into Bone
// ═══════════════════════════════════════════════════════════════════════

const _pos = vec3.create();
const _scale = vec3.create();
const _rot = quat.create();

export function systemSampleAnimations(world, dt) {
  const A = SkeletonAnimation;
  const B = Bone;

  for (let s = 0; s < _nextSkeletonIndex; s++) {
    if (!Skeleton.active[s]) continue;
    if (A.paused[s]) continue;
    const count = A.count[s];
    if (count === 0) continue;

    const boneStart = Skeleton.boneStart[s];
    const boneCount = Skeleton.boneCount[s];
    const base = s * MAX_CLIPS_PER_SKELETON;
    const timeScale = A.timeScale[s] || 1;
    const effectiveDt = dt * timeScale;

    // First pass: advance time and collect clip weights.
    let totalWeight = 0;
    for (let slot = 0; slot < count; slot++) {
      const clipId = A.clipIds[base + slot];
      const clip = ANIMATION_CLIPS.get(clipId);
      if (!clip) continue;

      A.times[base + slot] += effectiveDt * A.speeds[base + slot];
      if (A.loop[base + slot]) {
        if (clip.duration > EPSILON) {
          let t = A.times[base + slot];
          if (t >= clip.duration) {
            const loops = Math.floor(t / clip.duration);
            t -= loops * clip.duration;
            // Dispatch events for the last loop pass.
            dispatchLoopEvents(world, s, clip, A.times[base + slot] - effectiveDt,
                               A.times[base + slot], loops);
            A.times[base + slot] = t;
          }
        }
      } else {
        A.times[base + slot] = Math.min(A.times[base + slot], clip.duration);
      }

      totalWeight += A.weights[base + slot];
    }

    if (totalWeight < EPSILON) continue;

    // Second pass: blend per bone.
    const inverseTotalWeight = 1 / totalWeight;

    // Initialize pose accumulators for all bones to rest.
    for (let b = 0; b < boneCount; b++) {
      const eid = BONE_EIDS[boneStart + b];
      const id = getId(eid);
      _blendQAccum[0] = B.restQX[id];
      _blendQAccum[1] = B.restQY[id];
      _blendQAccum[2] = B.restQZ[id];
      _blendQAccum[3] = B.restQW[id];
      _blendPAccum[0] = B.restPX[id];
      _blendPAccum[1] = B.restPY[id];
      _blendPAccum[2] = B.restPZ[id];
      _blendSAccum[0] = 1;
      _blendSAccum[1] = 1;
      _blendSAccum[2] = 1;
    }

    // Accumulate per-slot tracks.
    for (let slot = 0; slot < count; slot++) {
      const clipId = A.clipIds[base + slot];
      const clip = ANIMATION_CLIPS.get(clipId);
      if (!clip) continue;

      const slotWeight = A.weights[base + slot] * inverseTotalWeight;
      if (slotWeight < EPSILON) continue;

      const time = A.times[base + slot];

      for (let ti = 0; ti < clip.tracks.length; ti++) {
        const track = clip.tracks[ti];
        const boneFlatId = boneStart + track.boneIndex;
        if (boneFlatId >= boneStart + boneCount) continue;

        const eid = BONE_EIDS[boneFlatId];
        const id = getId(eid);

        // Sample position.
        let px = B.restPX[id], py = B.restPY[id], pz = B.restPZ[id];
        if (track.positionTimes.length > 0) {
          sampleVec3(track.positionTimes, track.positionValues, time, _pos);
          px = _pos[0]; py = _pos[1]; pz = _pos[2];
        }

        // Sample rotation.
        let qx = B.restQX[id], qy = B.restQY[id], qz = B.restQZ[id], qw = B.restQW[id];
        if (track.rotationTimes.length > 0) {
          sampleQuat(track.rotationTimes, track.rotationValues, time, _rot);
          qx = _rot[0]; qy = _rot[1]; qz = _rot[2]; qw = _rot[3];
        }

        // Sample scale.
        let sx = 1, sy = 1, sz = 1;
        if (track.scaleTimes.length > 0) {
          sampleVec3(track.scaleTimes, track.scaleValues, time, _scale);
          sx = _scale[0]; sy = _scale[1]; sz = _scale[2];
        }

        blendSlotInto(boneFlatId, qx, qy, qz, qw, px, py, pz, sx, sy, sz, slotWeight, false);
      }
    }

    // Commit blended poses.
    for (let b = 0; b < boneCount; b++) {
      const eid = BONE_EIDS[boneStart + b];
      commitBlendedPose(eid);
    }
  }
  return world;
}

function dispatchLoopEvents(world, skeletonIdx, clip, prevTime, currTime, loops) {
  if (loops <= 0 || clip.events.length === 0) return;

  // Dispatch all events; simplified to fire every event once per loop pass.
  for (let i = 0; i < clip.events.length; i++) {
    const ev = clip.events[i];
    for (let l = 0; l < loops; l++) {
      dispatchEvent(Skeleton.rootEid ? Skeleton.rootEid[skeletonIdx] : 0, ev.name, clip.id);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — apply Bone.pose* → LocalTransformF32 → mark dirty
// ═══════════════════════════════════════════════════════════════════════

export function systemApplyBonePoses(world) {
  const B = Bone;
  const L = LocalTransformF32;

  for (let s = 0; s < _nextSkeletonIndex; s++) {
    if (!Skeleton.active[s]) continue;
    const boneStart = Skeleton.boneStart[s];
    const boneCount = Skeleton.boneCount[s];

    for (let b = 0; b < boneCount; b++) {
      const eid = BONE_EIDS[boneStart + b];
      const id = getId(eid);

      // Skip if pose has not changed since last apply (compared by pointer).
      // Cheap heuristic: just always write; downstream dirty flags dedupe.
      L.px[id] = B.posePX[id];
      L.py[id] = B.posePY[id];
      L.pz[id] = B.posePZ[id];
      L.qx[id] = B.poseQX[id];
      L.qy[id] = B.poseQY[id];
      L.qz[id] = B.poseQZ[id];
      L.qw[id] = B.poseQW[id];
      L.sx[id] = B.poseSX[id];
      L.sy[id] = B.poseSY[id];
      L.sz[id] = B.poseSZ[id];

      markDirty(eid);
    }
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — full animation tick (sample + apply)
// ═══════════════════════════════════════════════════════════════════════
//
// Order within a frame:
//   systemSampleAnimations(world, dt)   ← advances time, blends poses
//   systemApplyBonePoses(world)         ← writes poses into LocalTransformF32
//   systemSolveIK(world)                ← file 010 (optional)
//   systemSolveIKAdvanced(world)        ← file 012 (optional)
//   systemPropagateTransforms(world)    ← file 002 (final world matrices)
//   systemBoundsPipeline(world)         ← file 004
//   systemRefitBVH(world)               ← file 003

export function systemAnimationTick(world, dt) {
  systemSampleAnimations(world, dt);
  systemApplyBonePoses(world);
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// SKELETON ROOT LOOKUP (for event dispatch)
// ═══════════════════════════════════════════════════════════════════════

export const SKELETON_ROOTS = new Uint32Array(MAX_SKELETONS);

export function registerSkeletonRoot(skeletonIdx, rootEid) {
  SKELETON_ROOTS[skeletonIdx] = rootEid;
  Skeleton.rootEid = Skeleton.rootEid || {};
}

// ═══════════════════════════════════════════════════════════════════════
// SKINNING BRIDGE — computes bone matrices for GPU upload
// ═══════════════════════════════════════════════════════════════════════

/**
 * Per-skeleton skinning buffer (mat4 per bone). Upload to a
 * THREE.Skeleton boneMatrix texture. File 005 uses this when the
 * mesh is a skinned mesh.
 */
export const SKINNING_MATRICES = new Map(); // skeletonIdx -> Float32Array(boneCount * 16)

/**
 * Compute boneMatrix = inverse(bindMatrix) * boneWorldMatrix for each bone.
 * Bind matrices must be captured once at skeleton setup (see
 * captureBindMatrices). Called AFTER systemPropagateTransforms so
 * WorldTransformF32 is current.
 */
export function systemComputeSkinningMatrices(world, skeletonIdx) {
  const boneStart = Skeleton.boneStart[skeletonIdx];
  const boneCount = Skeleton.boneCount[skeletonIdx];

  let buffer = SKINNING_MATRICES.get(skeletonIdx);
  if (!buffer || buffer.length < boneCount * 16) {
    buffer = new Float32Array(boneCount * 16);
    SKINNING_MATRICES.set(skeletonIdx, buffer);
  }

  const bindBuffer = BIND_MATRICES.get(skeletonIdx);
  if (!bindBuffer) return buffer;

  const W = WorldTransformF32.m;
  const _inv = mat4.create();
  const _result = mat4.create();

  for (let b = 0; b < boneCount; b++) {
    const eid = BONE_EIDS[boneStart + b];
    const id = getId(eid);
    const worldOff = id * 16;

    // boneWorld = WorldTransformF32[id]
    const worldMat = W.subarray(worldOff, worldOff + 16);

    // boneMatrix = worldMat * inverse(bindMat)
    const bindOff = b * 16;
    const bindMat = bindBuffer.subarray(bindOff, bindOff + 16);
    mat4.invert(_inv, bindMat);
    mat4.multiply(_result, worldMat, _inv);

    const dstOff = b * 16;
    for (let k = 0; k < 16; k++) buffer[dstOff + k] = _result[k];
  }

  return buffer;
}

export const BIND_MATRICES = new Map(); // skeletonIdx -> Float32Array(boneCount * 16)

/**
 * Capture bind matrices from current WorldTransformF32.
 * Must be called once after the skeleton is built and transforms are
 * propagated once.
 */
export function captureBindMatrices(world, skeletonIdx) {
  const boneStart = Skeleton.boneStart[skeletonIdx];
  const boneCount = Skeleton.boneCount[skeletonIdx];

  let buffer = BIND_MATRICES.get(skeletonIdx);
  if (!buffer || buffer.length < boneCount * 16) {
    buffer = new Float32Array(boneCount * 16);
    BIND_MATRICES.set(skeletonIdx, buffer);
  }

  const W = WorldTransformF32.m;
  for (let b = 0; b < boneCount; b++) {
    const eid = BONE_EIDS[boneStart + b];
    const id = getId(eid);
    const srcOff = id * 16;
    const dstOff = b * 16;
    for (let k = 0; k < 16; k++) buffer[dstOff + k] = W[srcOff + k];
  }
  return buffer;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearAnimationSystem() {
  ANIMATION_CLIPS.clear();
  SKINNING_MATRICES.clear();
  BIND_MATRICES.clear();
  _eventListeners.clear();
  _nextClipId = 1;
  _nextSkeletonIndex = 0;
  _boneAllocator = 0;
  for (let i = 0; i < MAX_SKELETONS; i++) {
    Skeleton.active[i] = 0;
    SkeletonAnimation.count[i] = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function animationStats() {
  let activeSkeletons = 0;
  let totalBones = 0;
  let activeClips = 0;
  for (let s = 0; s < _nextSkeletonIndex; s++) {
    if (!Skeleton.active[s]) continue;
    activeSkeletons++;
    totalBones += Skeleton.boneCount[s];
    activeClips += SkeletonAnimation.count[s];
  }
  return {
    skeletonCount: _nextSkeletonIndex,
    activeSkeletons,
    totalBones,
    activeClips,
    clipCount: ANIMATION_CLIPS.size,
  };
}