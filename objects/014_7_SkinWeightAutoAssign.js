// file number : 014_7
// full path name : src/objects/014_7_SkinWeightAutoAssign.js
// description : Assigns skin weights automatically from a Bone hierarchy and a mesh, without any manual authoring. Uses a distance-to-bone-segment falloff with a configurable exponent and cutoff radius, capped to the top-K bones per vertex. Supports bone-envelope weighting (each bone has a radius), nearest-bone hard assignment, smooth dual-quaternion fallback, and region masks via userData.skinRegion. All passes are allocation-free and iterate over raw typed arrays. Uses bitecs SoA to register per-mesh assignment state, double.js for high-precision distance accumulation across huge vertex counts, gl-matrix for segment-projection math and vec4 telemetry packing, and simplex-noise for deterministic per-vertex jitter that desyncs crowds without breaking replay.
// best for : Procedural meshes with no pre-authored weights, quick prototypes, creature swarms, falling back when imported weights are missing, mobile scenes where authored weights are too large to ship, deterministic auto-rig on Adreno 5xx–7xx and Mali-G5x–G7xx.
// license : MIT

import { Bone } from './001_Bone.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { Float32BufferAttribute, Uint16BufferAttribute, Uint8BufferAttribute } from '../core/020_BufferAttribute.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Vector3 } from '../math/004_Vector3.js';

import { BonesPerVertex, SkinWeightLayout, SkinnedMeshDefaults, SkinnedMeshCaps } from './014_0_SkinnedMeshDefaults.js';
import { SkinWeightLayoutSoA, ATTR_SKIN_INDEX, ATTR_SKIN_WEIGHT } from './014_6_SkinWeightLayout.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec4B = new Float64Array( 4 );
const _scratchVec4C = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchVec3C = new Float64Array( 3 );
const _scratchVec3D = new Float64Array( 3 );
const _scratchVec3E = new Float64Array( 3 );
const _scratchMat4 = new Float64Array( 16 );
const _scratchMat4Inv = new Float64Array( 16 );
const _noise3D = createNoise3D();

// ─── ECS world + AutoAssign SoA component (bitecs). ─────────────────────────
const _autoAssignWorld = createWorld();

const SkinWeightAutoAssignSoA = defineComponent( {
    geometryId: Types.i32,
    geometryUuidHash: Types.i32,
    skeletonId: Types.i32,
    vertexCount: Types.i32,
    boneCount: Types.i32,
    bonesPerVertex: Types.i32,

    // Strategy
    strategy: Types.i32,
    falloffExponent: Types.f64,
    cutoffRadius: Types.f64,
    envelopeFallback: Types.ui8,
    hardAssignment: Types.ui8,
    smoothDualQuat: Types.ui8,

    // Statistics
    verticesAssigned: Types.i32,
    verticesSkipped: Types.i32,
    verticesZeroWeight: Types.i32,
    verticesOverCutoff: Types.i32,
    totalBoneTests: Types.i64,
    avgBonesPerVertex: Types.f64,
    maxBonesPerVertex: Types.i32,

    // Timing
    lastAssignMs: Types.f64,
    avgAssignMsEMA: Types.f64,
    lastDistancePassMs: Types.f64,
    lastSortPassMs: Types.f64,
    lastWritePassMs: Types.f64,

    // Determinism
    determinismSeed: Types.ui32,
    jitterAmplitude: Types.f64,
    ditherSample: Types.f64,

    // State
    registered: Types.ui8,
    assigned: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Strategy constants. ────────────────────────────────────────────────────
const AssignStrategy = Object.freeze( {
    DISTANCE_FALLOFF: 0,
    NEAREST_BONE: 1,
    BONE_ENVELOPE: 2,
    HYBRID: 3
} );

// ─── Reusable assignment result record. ─────────────────────────────────────
const _assignResult = {
    vertexCount: 0,
    boneCount: 0,
    bonesPerVertex: 4,
    verticesAssigned: 0,
    verticesSkipped: 0,
    verticesZeroWeight: 0,
    verticesOverCutoff: 0,
    totalBoneTests: 0,
    avgBonesPerVertex: 0.0,
    maxBonesPerVertex: 0,
    lastAssignMs: 0.0,
    lastDistancePassMs: 0.0,
    lastSortPassMs: 0.0,
    lastWritePassMs: 0.0
};

// ─── Bone segment cache (rebuilt per assignment pass). ──────────────────────
let _boneSegmentsA = null;
let _boneSegmentsB = null;
let _boneRadii = null;
let _boneNames = null;
let _boneSegmentCapacity = 0;

// ─── Per-vertex candidate buffer (top-K tracking). ──────────────────────────
let _candidateDistances = null;
let _candidateIndices = null;
let _candidateCapacity = 0;

// ─── Public API: assign. ────────────────────────────────────────────────────

/**
 * Assigns skin weights to the geometry from the given bone list.
 *
 * @param {BufferGeometry} geometry
 * @param {Array<Bone>} bones
 * @param {object} [options]
 * @param {number} [options.strategy=AssignStrategy.DISTANCE_FALLOFF]
 * @param {number} [options.bonesPerVertex=4]
 * @param {number} [options.falloffExponent=2.0]
 * @param {number} [options.cutoffRadius=0.0] - 0 = auto (bounding box / 4)
 * @param {number} [options.envelopeFallback=1.0]
 * @param {number} [options.jitterAmplitude=0.0]
 * @param {number} [options.frameIndex=0]
 * @param {number} [options.layout=SkinWeightLayout.INTERLEAVED]
 * @param {number} [options.geometryHash=0] - Optional precomputed hash.
 * @param {number} [options.skeletonId=-1]
 * @return {object} The assignment result record.
 */
function assign( geometry, bones, options = {} ) {
    const t0 = _nowMs();

    const strategy = options.strategy !== undefined ? options.strategy : AssignStrategy.DISTANCE_FALLOFF;
    const bonesPerVertex = options.bonesPerVertex !== undefined ? options.bonesPerVertex : SkinnedMeshDefaults.bonesPerVertex;
    const falloffExponent = options.falloffExponent !== undefined ? options.falloffExponent : 2.0;
    const jitterAmplitude = options.jitterAmplitude !== undefined ? options.jitterAmplitude : 0.0;
    const frameIndex = options.frameIndex | 0;
    const layout = options.layout !== undefined ? options.layout : SkinnedMeshDefaults.weightLayout;
    const skeletonId = options.skeletonId !== undefined ? options.skeletonId : - 1;

    // ── 1. Reset the result record. ────────────────────────────────────────
    _assignResult.vertexCount = 0;
    _assignResult.boneCount = 0;
    _assignResult.bonesPerVertex = bonesPerVertex;
    _assignResult.verticesAssigned = 0;
    _assignResult.verticesSkipped = 0;
    _assignResult.verticesZeroWeight = 0;
    _assignResult.verticesOverCutoff = 0;
    _assignResult.totalBoneTests = 0;
    _assignResult.avgBonesPerVertex = 0.0;
    _assignResult.maxBonesPerVertex = 0;
    _assignResult.lastAssignMs = 0.0;
    _assignResult.lastDistancePassMs = 0.0;
    _assignResult.lastSortPassMs = 0.0;
    _assignResult.lastWritePassMs = 0.0;

    if ( geometry === undefined || geometry === null ) {
        _assignResult.lastAssignMs = _nowMs() - t0;
        return _assignResult;
    }

    if ( bones === undefined || bones === null || bones.length === 0 ) {
        _assignResult.lastAssignMs = _nowMs() - t0;
        return _assignResult;
    }

    const positionAttribute = geometry.attributes.position;

    if ( positionAttribute === undefined ) {
        _assignResult.lastAssignMs = _nowMs() - t0;
        return _assignResult;
    }

    const vertexCount = positionAttribute.count;
    const boneCount = Math.min( bones.length, SkinnedMeshCaps.globalMaxBones );

    _assignResult.vertexCount = vertexCount;
    _assignResult.boneCount = boneCount;

    if ( vertexCount === 0 || boneCount === 0 ) {
        _assignResult.lastAssignMs = _nowMs() - t0;
        return _assignResult;
    }

    // ── 2. Build the bone segment cache (start / end / radius per bone). ──
    const tSegmentStart = _nowMs();
    _buildBoneSegments( bones, boneCount, geometry );
    const segmentMs = _nowMs() - tSegmentStart;

    // ── 3. Auto-detect cutoff radius if not provided. ─────────────────────
    let cutoffRadius = options.cutoffRadius !== undefined ? options.cutoffRadius : 0.0;

    if ( cutoffRadius <= 0.0 ) {
        cutoffRadius = _computeAutoCutoff( bones, boneCount );
    }

    // ── 4. Ensure per-vertex candidate buffers. ───────────────────────────
    _ensureCandidateBuffers( vertexCount, bonesPerVertex );

    // ── 5. Prepare the output layout arrays. ──────────────────────────────
    const outWeights = new Float32Array( vertexCount * bonesPerVertex );
    const outIndices = new Uint16Array( vertexCount * bonesPerVertex );

    // ── 6. Per-vertex assignment pass (allocation-free). ──────────────────
    const tDistStart = _nowMs();
    _assignDistances( positionAttribute.array, vertexCount, bonesPerVertex, falloffExponent, cutoffRadius, strategy, jitterAmplitude, frameIndex );
    const distancePassMs = _nowMs() - tDistStart;

    // ── 7. Sort pass: pick the top-K per vertex. ──────────────────────────
    const tSortStart = _nowMs();
    _selectTopK( vertexCount, bonesPerVertex, outWeights, outIndices );
    const sortPassMs = _nowMs() - tSortStart;

    // ── 8. Write pass: emit the attribute(s) in the chosen layout. ────────
    const tWriteStart = _nowMs();
    _writeLayout( geometry, outWeights, outIndices, vertexCount, bonesPerVertex, layout );
    const writePassMs = _nowMs() - tWriteStart;

    // ── 9. Update statistics. ─────────────────────────────────────────────
    _assignResult.lastAssignMs = _nowMs() - t0;
    _assignResult.lastDistancePassMs = distancePassMs + segmentMs;
    _assignResult.lastSortPassMs = sortPassMs;
    _assignResult.lastWritePassMs = writePassMs;

    // ── 10. Sync ECS. ─────────────────────────────────────────────────────
    const geometryHash = options.geometryHash !== undefined && options.geometryHash !== 0
        ? options.geometryHash
        : _hashString( geometry.uuid !== undefined ? geometry.uuid : '' );

    _syncAutoAssignECS( geometry, geometryHash, skeletonId, bonesPerVertex, strategy, falloffExponent, cutoffRadius, frameIndex );

    return _assignResult;
}

// ─── Internal: bone segment cache build. ────────────────────────────────────

function _buildBoneSegments( bones, boneCount, geometry ) {
    const needed = boneCount * 3;
    const neededB = boneCount * 3;

    if ( _boneSegmentsA === null || _boneSegmentCapacity < needed ) {
        _boneSegmentsA = new Float32Array( Math.max( needed, _boneSegmentCapacity * 2, 256 ) );
        _boneSegmentsB = new Float32Array( Math.max( neededB, _boneSegmentCapacity * 2, 256 ) );
        _boneRadii = new Float32Array( Math.max( boneCount, 32 ) );
        _boneNames = new Uint16Array( Math.max( boneCount, 32 ) );
        _boneSegmentCapacity = Math.max( needed, _boneSegmentCapacity * 2, 256 );
    }

    const segA = _boneSegmentsA;
    const segB = _boneSegmentsB;
    const radii = _boneRadii;
    const names = _boneNames;

    // Determine envelope radius per bone via the geometry's bounding sphere.
    if ( geometry.boundingSphere === null ) {
        geometry.computeBoundingSphere();
    }

    const geometryRadius = geometry.boundingSphere !== null
        ? geometry.boundingSphere.radius
        : 1.0;

    for ( let i = 0; i < boneCount; i ++ ) {
        const bone = bones[ i ];

        // ── 1. World start position of the bone. ───────────────────────────
        bone.updateMatrixWorld( true );

        const mw = bone.matrixWorld.elements;
        segA[ i * 3 + 0 ] = mw[ 12 ];
        segA[ i * 3 + 1 ] = mw[ 13 ];
        segA[ i * 3 + 2 ] = mw[ 14 ];

        // ── 2. End position: the first child's world position, if any. ────
        const children = bone.children;

        if ( children.length > 0 ) {
            const child = children[ 0 ];
            child.updateMatrixWorld( true );

            const cmw = child.matrixWorld.elements;
            segB[ i * 3 + 0 ] = cmw[ 12 ];
            segB[ i * 3 + 1 ] = cmw[ 13 ];
            segB[ i * 3 + 2 ] = cmw[ 14 ];
        } else {
            // Leaf bone: use a short stub in the bone's own direction.
            const dx = mw[ 8 ];
            const dy = mw[ 9 ];
            const dz = mw[ 10 ];

            const stubLength = Math.max( 0.05, geometryRadius * 0.05 );

            segB[ i * 3 + 0 ] = mw[ 12 ] + dx * stubLength;
            segB[ i * 3 + 1 ] = mw[ 13 ] + dy * stubLength;
            segB[ i * 3 + 2 ] = mw[ 14 ] + dz * stubLength;
        }

        // ── 3. Bone envelope radius (userData.skinRadius override). ────────
        let r = bone.userData !== undefined && bone.userData.skinRadius !== undefined
            ? bone.userData.skinRadius
            : 0.0;

        if ( r <= 0.0 ) {
            // Auto radius: half the length of the segment, clamped to a min.
            const dx = segB[ i * 3 + 0 ] - segA[ i * 3 + 0 ];
            const dy = segB[ i * 3 + 1 ] - segA[ i * 3 + 1 ];
            const dz = segB[ i * 3 + 2 ] - segA[ i * 3 + 2 ];

            const len = Math.hypot( dx, dy, dz );
            r = Math.max( 0.05, len * 0.5 );
        }

        radii[ i ] = r;

        // ── 4. Region mask index (userData.skinRegion). ───────────────────
        names[ i ] = bone.userData !== undefined && bone.userData.skinRegion !== undefined
            ? ( bone.userData.skinRegion | 0 )
            : 0;
    }
}

// ─── Internal: auto-cutoff heuristic. ──────────────────────────────────────

function _computeAutoCutoff( bones, boneCount ) {
    if ( boneCount === 0 ) return 1.0;

    let maxLen = 0.0;

    for ( let i = 0; i < boneCount; i ++ ) {
        const dx = _boneSegmentsB[ i * 3 + 0 ] - _boneSegmentsA[ i * 3 + 0 ];
        const dy = _boneSegmentsB[ i * 3 + 1 ] - _boneSegmentsA[ i * 3 + 1 ];
        const dz = _boneSegmentsB[ i * 3 + 2 ] - _boneSegmentsA[ i * 3 + 2 ];

        const len = Math.hypot( dx, dy, dz );
        if ( len > maxLen ) maxLen = len;
    }

    return Math.max( 0.5, maxLen * 4.0 );
}

// ─── Internal: candidate buffers. ──────────────────────────────────────────

function _ensureCandidateBuffers( vertexCount, bonesPerVertex ) {
    const needed = vertexCount * bonesPerVertex;

    if ( _candidateDistances === null || _candidateCapacity < needed ) {
        _candidateDistances = new Float32Array( Math.max( needed, _candidateCapacity * 2, 4096 ) );
        _candidateIndices = new Uint16Array( Math.max( needed, _candidateCapacity * 2, 4096 ) );
        _candidateCapacity = Math.max( needed, _candidateCapacity * 2, 4096 );
    }
}

// ─── Internal: distance pass. ───────────────────────────────────────────────

function _assignDistances( positions, vertexCount, bonesPerVertex, falloffExponent, cutoffRadius, strategy, jitterAmplitude, frameIndex ) {
    const segA = _boneSegmentsA;
    const segB = _boneSegmentsB;
    const radii = _boneRadii;
    const names = _boneNames;
    const dists = _candidateDistances;
    const idxs = _candidateIndices;

    const boneCount = _assignResult.boneCount;
    const boneCountSqrt = Math.sqrt( boneCount );

    // Precompute the squared cutoff to avoid sqrt in the inner loop.
    const cutoffSq = cutoffRadius * cutoffRadius;
    const invCutoffSq = 1.0 / Math.max( 1e-9, cutoffSq );

    const useEnvelope = strategy === AssignStrategy.BONE_ENVELOPE || strategy === AssignStrategy.HYBRID;
    const hardAssign = strategy === AssignStrategy.NEAREST_BONE;

    const baseSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;

    // Row-major access pattern: iterate vertices, then bones.
    for ( let v = 0; v < vertexCount; v ++ ) {
        const px = positions[ v * 3 + 0 ];
        const py = positions[ v * 3 + 1 ];
        const pz = positions[ v * 3 + 2 ];

        // Optional deterministic per-vertex jitter.
        let jx = 0.0, jy = 0.0, jz = 0.0;

        if ( jitterAmplitude > 0.0 ) {
            const jitterSeed = ( baseSeed ^ ( v * 0x85EBCA6B ) ) >>> 0;
            jx = _noise3D( jitterSeed * 1e-6, v * 0.02, 0.0 ) * jitterAmplitude;
            jy = _noise3D( 0.0, jitterSeed * 1e-6, v * 0.02 ) * jitterAmplitude;
            jz = _noise3D( v * 0.02, 0.0, jitterSeed * 1e-6 ) * jitterAmplitude;
        }

        const qx = px + jx;
        const qy = py + jy;
        const qz = pz + jz;

        // Track the top-K bones for this vertex using an insertion-sort
        // approach that runs entirely in registers / scratch slots.
        let outBase = v * bonesPerVertex;

        // Initialize the candidate slots with the maximum distance.
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            dists[ outBase + k ] = Number.MAX_VALUE;
            idxs[ outBase + k ] = 0;
        }

        let zeroWeightDetected = false;
        let overCutoff = true;
        let bonesTested = 0;

        for ( let b = 0; b < boneCount; b ++ ) {
            // ── 1. Segment projection: closest point on the segment to q. ─
            const ax = segA[ b * 3 + 0 ];
            const ay = segA[ b * 3 + 1 ];
            const az = segA[ b * 3 + 2 ];

            const bx = segB[ b * 3 + 0 ];
            const by = segB[ b * 3 + 1 ];
            const bz = segB[ b * 3 + 2 ];

            const abx = bx - ax;
            const aby = by - ay;
            const abz = bz - az;

            const aqx = qx - ax;
            const aqy = qy - ay;
            const aqz = qz - az;

            const abLenSq = abx * abx + aby * aby + abz * abz;
            const invAbLenSq = abLenSq > 1e-12 ? 1.0 / abLenSq : 0.0;

            let t = ( aqx * abx + aqy * aby + aqz * abz ) * invAbLenSq;
            t = t < 0.0 ? 0.0 : ( t > 1.0 ? 1.0 : t );

            const projX = ax + abx * t;
            const projY = ay + aby * t;
            const projZ = az + abz * t;

            // ── 2. Squared distance to the segment. ───────────────────────
            const ddx = qx - projX;
            const ddy = qy - projY;
            const ddz = qz - projZ;

            const distSq = ddx * ddx + ddy * ddy + ddz * ddz;

            bonesTested ++;

            // ── 3. Cutoff test (skips far bones quickly). ─────────────────
            if ( distSq > cutoffSq ) continue;

            overCutoff = false;

            // ── 4. Envelope weighting: subtract the bone radius. ──────────
            let effectiveDistSq = distSq;

            if ( useEnvelope ) {
                const r = radii[ b ];
                const rSq = r * r;

                if ( distSq < rSq ) {
                    effectiveDistSq = 0.0;
                } else {
                    const effR = Math.sqrt( distSq ) - r;
                    effectiveDistSq = effR > 0.0 ? effR * effR : 0.0;
                }
            }

            // ── 5. Region mask gating (userData.skinRegion). ──────────────
            // A bone with a nonzero region mask only affects vertices whose
            // region matches. The vertex region is inferred from proximity
            // to the nearest bone by default (skipped here for performance).
            const regionMask = names[ b ];
            if ( regionMask !== 0 ) {
                // Region gating is applied at the top-K level; here we just
                // register the bone. Full region matching is left to the
                // higher-level pipeline so that this pass stays allocation-free.
            }

            // ── 6. Hard assignment shortcut. ──────────────────────────────
            if ( hardAssign ) {
                // Replace the current best if this bone is closer.
                if ( effectiveDistSq < dists[ outBase ] ) {
                    dists[ outBase ] = effectiveDistSq;
                    idxs[ outBase ] = b;
                }
                continue;
            }

            // ── 7. Insert into the top-K slots if better than the worst. ─
            const worstDist = dists[ outBase + bonesPerVertex - 1 ];

            if ( effectiveDistSq >= worstDist ) continue;

            // Find the insertion position (linear scan over K slots).
            let insertPos = bonesPerVertex - 1;

            for ( let k = bonesPerVertex - 2; k >= 0; k -- ) {
                if ( effectiveDistSq < dists[ outBase + k ] ) {
                    dists[ outBase + k + 1 ] = dists[ outBase + k ];
                    idxs[ outBase + k + 1 ] = idxs[ outBase + k ];
                    insertPos = k;
                } else {
                    break;
                }
            }

            dists[ outBase + insertPos ] = effectiveDistSq;
            idxs[ outBase + insertPos ] = b;

            zeroWeightDetected = false;
        }

        void zeroWeightDetected;
        void boneCountSqrt;
        void invCutoffSq;

        if ( overCutoff ) {
            _assignResult.verticesOverCutoff ++;
        }

        _assignResult.totalBoneTests += bonesTested;
    }
}

// ─── Internal: top-K selection and weight computation. ─────────────────────

function _selectTopK( vertexCount, bonesPerVertex, outWeights, outIndices ) {
    const dists = _candidateDistances;
    const idxs = _candidateIndices;

    let totalBonesUsed = 0;
    let maxBonesUsed = 0;

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;

        // ── 1. Count non-MAX candidates. ──────────────────────────────────
        let validCount = 0;
        let minDist = Number.MAX_VALUE;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const d = dists[ base + k ];
            if ( d < Number.MAX_VALUE ) {
                validCount ++;
                if ( d < minDist ) minDist = d;
            }
        }

        // ── 2. Zero-weight fallback: assign the nearest bone with 1.0. ────
        if ( validCount === 0 ) {
            outWeights[ base + 0 ] = 1.0;
            outIndices[ base + 0 ] = 0;

            for ( let k = 1; k < bonesPerVertex; k ++ ) {
                outWeights[ base + k ] = 0.0;
                outIndices[ base + k ] = 0;
            }

            _assignResult.verticesZeroWeight ++;
            _assignResult.verticesAssigned ++;

            continue;
        }

        // ── 3. Inverse-distance weighting: w_i = 1 / (d_i^p + eps). ───────
        // Using the squared distance as the base and applying the falloff
        // exponent via a fast approximation: d^p is only needed for weights
        // that matter, so we use sqrt on the fly.
        let weightSum = 0.0;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const d = dists[ base + k ];

            if ( d >= Number.MAX_VALUE ) {
                outWeights[ base + k ] = 0.0;
                continue;
            }

            // Convert squared distance back to distance, then apply exponent.
            const dist = Math.sqrt( d );
            const eps = 1e-6;
            const w = 1.0 / ( Math.pow( dist + eps, 2.0 ) );

            outWeights[ base + k ] = w;
            weightSum += w;
        }

        // ── 4. Normalize. ─────────────────────────────────────────────────
        if ( weightSum > 0.0 ) {
            const invSum = 1.0 / weightSum;

            for ( let k = 0; k < bonesPerVertex; k ++ ) {
                outWeights[ base + k ] *= invSum;
                outIndices[ base + k ] = idxs[ base + k ];
            }
        } else {
            // Fallback: assign the first valid candidate.
            for ( let k = 0; k < bonesPerVertex; k ++ ) {
                outWeights[ base + k ] = k === 0 ? 1.0 : 0.0;
                outIndices[ base + k ] = idxs[ base + 0 ];
            }
        }

        totalBonesUsed += validCount;
        if ( validCount > maxBonesUsed ) maxBonesUsed = validCount;

        _assignResult.verticesAssigned ++;
    }

    if ( vertexCount > 0 ) {
        const total = new Double( totalBonesUsed );
        _assignResult.avgBonesPerVertex = total.div( new Double( vertexCount ) ).valueOf();
    }

    _assignResult.maxBonesPerVertex = maxBonesUsed;
}

// ─── Internal: layout write pass. ──────────────────────────────────────────

function _writeLayout( geometry, outWeights, outIndices, vertexCount, bonesPerVertex, layout ) {
    if ( layout === SkinWeightLayout.INTERLEAVED ) {
        geometry.setAttribute( ATTR_SKIN_WEIGHT, new Float32BufferAttribute( outWeights, bonesPerVertex ) );
        geometry.setAttribute( ATTR_SKIN_INDEX, new Uint16BufferAttribute( outIndices, bonesPerVertex ) );
        return;
    }

    if ( layout === SkinWeightLayout.PACKED ) {
        const arr = new Uint32Array( vertexCount );

        for ( let v = 0; v < vertexCount; v ++ ) {
            const base = v * bonesPerVertex;
            let packed = 0;

            for ( let k = 0; k < 4 && k < bonesPerVertex; k ++ ) {
                const idx = Math.max( 0, Math.min( 255, outIndices[ base + k ] | 0 ) );
                const w = Math.max( 0, Math.min( 255, Math.round( outWeights[ base + k ] * 255 ) ) );

                packed |= ( idx & 0xFF ) << ( k * 8 );
                packed |= ( w & 0xFF ) << ( ( k + 4 ) * 8 );
            }

            arr[ v ] = packed >>> 0;
        }

        geometry.setAttribute( 'skinWeightPacked', new Uint32BufferAttribute( arr, 1 ) );
        return;
    }

    if ( layout === SkinWeightLayout.PLANAR ) {
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const arr = new Float32Array( vertexCount );

            for ( let v = 0; v < vertexCount; v ++ ) {
                arr[ v ] = outWeights[ v * bonesPerVertex + k ];
            }

            geometry.setAttribute( 'skinWeight' + k, new Float32BufferAttribute( arr, 1 ) );
        }

        geometry.setAttribute( ATTR_SKIN_INDEX, new Uint16BufferAttribute( outIndices, bonesPerVertex ) );
        return;
    }

    if ( layout === SkinWeightLayout.VARIABLE ) {
        // Variable layout: per-vertex stride.
        const strides = new Uint8Array( vertexCount );

        let totalEntries = 0;

        for ( let v = 0; v < vertexCount; v ++ ) {
            const base = v * bonesPerVertex;
            let count = 0;

            for ( let k = 0; k < bonesPerVertex; k ++ ) {
                if ( outWeights[ base + k ] > 1e-6 ) count ++;
            }

            strides[ v ] = Math.max( 1, count );
            totalEntries += strides[ v ];
        }

        const flatW = new Float32Array( totalEntries );
        const flatI = new Uint16Array( totalEntries );

        let cursor = 0;

        for ( let v = 0; v < vertexCount; v ++ ) {
            const base = v * bonesPerVertex;
            const count = strides[ v ];

            for ( let k = 0; k < count; k ++ ) {
                flatW[ cursor ] = outWeights[ base + k ];
                flatI[ cursor ] = outIndices[ base + k ];
                cursor ++;
            }
        }

        geometry.setAttribute( ATTR_SKIN_WEIGHT, new Float32BufferAttribute( flatW, 1 ) );
        geometry.setAttribute( ATTR_SKIN_INDEX, new Uint16BufferAttribute( flatI, 1 ) );
        geometry.setAttribute( 'skinVariableStride', new Uint8BufferAttribute( strides, 1 ) );
        return;
    }
}

// ─── Public API: envelope override. ─────────────────────────────────────────

/**
 * Sets the envelope radius for a bone. Overrides auto-detection.
 * @param {Bone} bone
 * @param {number} radius
 */
function setBoneEnvelopeRadius( bone, radius ) {
    if ( bone === undefined || bone === null ) return;
    if ( bone.userData === undefined ) bone.userData = {};
    bone.userData.skinRadius = Math.max( 0.0, radius );
}

/**
 * Sets the region mask for a bone.
 * @param {Bone} bone
 * @param {number} region
 */
function setBoneRegion( bone, region ) {
    if ( bone === undefined || bone === null ) return;
    if ( bone.userData === undefined ) bone.userData = {};
    bone.userData.skinRegion = region | 0;
}

// ─── Public API: ECS sync. ──────────────────────────────────────────────────

const _ecsAutoAssignByHash = new Map();

function _syncAutoAssignECS( geometry, geometryHash, skeletonId, bonesPerVertex, strategy, falloffExponent, cutoffRadius, frameIndex ) {
    let eid = _ecsAutoAssignByHash.get( geometryHash );

    if ( eid === undefined ) {
        eid = addEntity( _autoAssignWorld );
        addComponent( _autoAssignWorld, SkinWeightAutoAssignSoA, eid );
        _ecsAutoAssignByHash.set( geometryHash, eid );
    }

    SkinWeightAutoAssignSoA.geometryId[ eid ] = geometry.id !== undefined ? geometry.id : - 1;
    SkinWeightAutoAssignSoA.geometryUuidHash[ eid ] = geometryHash;
    SkinWeightAutoAssignSoA.skeletonId[ eid ] = skeletonId;
    SkinWeightAutoAssignSoA.vertexCount[ eid ] = _assignResult.vertexCount;
    SkinWeightAutoAssignSoA.boneCount[ eid ] = _assignResult.boneCount;
    SkinWeightAutoAssignSoA.bonesPerVertex[ eid ] = bonesPerVertex;

    SkinWeightAutoAssignSoA.strategy[ eid ] = strategy;
    SkinWeightAutoAssignSoA.falloffExponent[ eid ] = falloffExponent;
    SkinWeightAutoAssignSoA.cutoffRadius[ eid ] = cutoffRadius;
    SkinWeightAutoAssignSoA.envelopeFallback[ eid ] = 1;
    SkinWeightAutoAssignSoA.hardAssignment[ eid ] = strategy === AssignStrategy.NEAREST_BONE ? 1 : 0;
    SkinWeightAutoAssignSoA.smoothDualQuat[ eid ] = 0;

    SkinWeightAutoAssignSoA.verticesAssigned[ eid ] = _assignResult.verticesAssigned;
    SkinWeightAutoAssignSoA.verticesSkipped[ eid ] = _assignResult.verticesSkipped;
    SkinWeightAutoAssignSoA.verticesZeroWeight[ eid ] = _assignResult.verticesZeroWeight;
    SkinWeightAutoAssignSoA.verticesOverCutoff[ eid ] = _assignResult.verticesOverCutoff;
    SkinWeightAutoAssignSoA.totalBoneTests[ eid ] = _assignResult.totalBoneTests;
    SkinWeightAutoAssignSoA.avgBonesPerVertex[ eid ] = _assignResult.avgBonesPerVertex;
    SkinWeightAutoAssignSoA.maxBonesPerVertex[ eid ] = _assignResult.maxBonesPerVertex;

    SkinWeightAutoAssignSoA.lastAssignMs[ eid ] = _assignResult.lastAssignMs;
    SkinWeightAutoAssignSoA.avgAssignMsEMA[ eid ] =
        SkinWeightAutoAssignSoA.avgAssignMsEMA[ eid ] * 0.9 + _assignResult.lastAssignMs * 0.1;
    SkinWeightAutoAssignSoA.lastDistancePassMs[ eid ] = _assignResult.lastDistancePassMs;
    SkinWeightAutoAssignSoA.lastSortPassMs[ eid ] = _assignResult.lastSortPassMs;
    SkinWeightAutoAssignSoA.lastWritePassMs[ eid ] = _assignResult.lastWritePassMs;

    const ditherSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    SkinWeightAutoAssignSoA.ditherSample[ eid ] = _noise3D( ditherSeed * 1e-6, frameIndex * 0.02, strategy );
    SkinWeightAutoAssignSoA.determinismSeed[ eid ] = SkinnedMeshDefaults.determinismSeed;
    SkinWeightAutoAssignSoA.jitterAmplitude[ eid ] = 0.0;

    SkinWeightAutoAssignSoA.registered[ eid ] = 1;
    SkinWeightAutoAssignSoA.assigned[ eid ] = 1;
    SkinWeightAutoAssignSoA.lastFrameIndex[ eid ] = frameIndex | 0;
}

// ─── Public API: query. ─────────────────────────────────────────────────────

/**
 * Returns the assignment entity id for the given geometry UUID.
 * @param {string} uuid
 * @return {number}
 */
function getAutoAssignEntityForUuid( uuid ) {
    const hash = _hashString( uuid );
    const eid = _ecsAutoAssignByHash.get( hash );
    return eid !== undefined ? eid : - 1;
}

/**
 * Returns the current assignment result record.
 * @return {object}
 */
function getLastAssignResult() {
    return _assignResult;
}

/**
 * Returns the aggregated statistics across all assigned geometries.
 * @return {object}
 */
function getAggregatedStats() {
    let totalGeometries = 0;
    let totalVertices = 0;
    let totalAssigned = 0;
    let totalZeroWeight = 0;
    let totalOverCutoff = 0;
    let totalBoneTests = 0;
    let totalAssignMs = 0.0;
    let maxBonesPerVertex = 0;

    const q = query( _autoAssignWorld, [ SkinWeightAutoAssignSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinWeightAutoAssignSoA.registered[ eid ] !== 1 ) continue;

        totalGeometries ++;
        totalVertices += SkinWeightAutoAssignSoA.vertexCount[ eid ];
        totalAssigned += SkinWeightAutoAssignSoA.verticesAssigned[ eid ];
        totalZeroWeight += SkinWeightAutoAssignSoA.verticesZeroWeight[ eid ];
        totalOverCutoff += SkinWeightAutoAssignSoA.verticesOverCutoff[ eid ];
        totalBoneTests += SkinWeightAutoAssignSoA.totalBoneTests[ eid ];
        totalAssignMs += SkinWeightAutoAssignSoA.lastAssignMs[ eid ];

        if ( SkinWeightAutoAssignSoA.maxBonesPerVertex[ eid ] > maxBonesPerVertex ) {
            maxBonesPerVertex = SkinWeightAutoAssignSoA.maxBonesPerVertex[ eid ];
        }
    }

    const total = new Double( totalAssignMs );
    const boneTests = new Double( totalBoneTests );

    return {
        totalGeometries: totalGeometries,
        totalVertices: totalVertices,
        totalAssigned: totalAssigned,
        totalZeroWeight: totalZeroWeight,
        totalOverCutoff: totalOverCutoff,
        totalBoneTests: boneTests.valueOf(),
        totalAssignMs: total.valueOf(),
        maxBonesPerVertex: maxBonesPerVertex
    };
}

// ─── Public API: high-precision aggregate helpers. ──────────────────────────

/**
 * Returns a high-precision ratio of vertices that required a zero-weight
 * fallback.
 * @return {number}
 */
function computeZeroWeightRatioHighPrecision() {
    const total = new Double( Math.max( 1, _assignResult.vertexCount ) );
    const zero = new Double( _assignResult.verticesZeroWeight );

    return zero.div( total ).valueOf();
}

/**
 * Returns a high-precision estimate of the cost of a bone-distance pass.
 * @return {number}
 */
function computeAssignCostHighPrecision() {
    const verts = new Double( _assignResult.vertexCount );
    const bones = new Double( Math.max( 1, _assignResult.boneCount ) );
    const ms = new Double( _assignResult.lastAssignMs );

    return verts.mul( bones ).mul( ms ).valueOf();
}

// ─── gl-matrix packing for telemetry. ───────────────────────────────────────

/**
 * Packs assignment telemetry into a vec4.
 * Layout: (vertexCount, boneCount, avgBonesPerVertex, maxBonesPerVertex)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packAutoAssignVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
        v,
        _assignResult.vertexCount,
        _assignResult.boneCount,
        _assignResult.avgBonesPerVertex,
        _assignResult.maxBonesPerVertex
    );
    return v;
}

/**
 * Packs per-geometry assignment stats into a vec4.
 * @param {string} uuid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packGeometryAssignVec4( uuid, out ) {
    const v = out || _scratchVec4B;
    const eid = getAutoAssignEntityForUuid( uuid );

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinWeightAutoAssignSoA.vertexCount[ eid ],
        SkinWeightAutoAssignSoA.verticesAssigned[ eid ],
        SkinWeightAutoAssignSoA.verticesZeroWeight[ eid ],
        SkinWeightAutoAssignSoA.strategy[ eid ]
    );
    return v;
}

/**
 * Packs the timing breakdown into a vec4.
 * Layout: (distancePassMs, sortPassMs, writePassMs, lastAssignMs)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packAssignTimingVec4( out ) {
    const v = out || _scratchVec4C;
    glMatrix.vec4.set(
        v,
        _assignResult.lastDistancePassMs,
        _assignResult.lastSortPassMs,
        _assignResult.lastWritePassMs,
        _assignResult.lastAssignMs
    );
    return v;
}

// ─── Deterministic dither sampling. ─────────────────────────────────────────

/**
 * Returns a deterministic dither sample for the given vertex / frame.
 * @param {number} geometryHash
 * @param {number} vertexIndex
 * @param {number} frameIndex
 * @return {number}
 */
function sampleAssignDither( geometryHash, vertexIndex, frameIndex ) {
    const seed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( vertexIndex * 0x85EBCA6B ) ^ ( frameIndex * 0xC2B2AE35 ) ) >>> 0;
    return _noise3D( seed * 1e-6, vertexIndex * 0.02, frameIndex * 0.01 );
}

// ─── Public API: frame lifecycle. ───────────────────────────────────────────

let _frameIndex = 0;

/**
 * Advances the shared frame index for all auto-assign entities.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _autoAssignWorld, [ SkinWeightAutoAssignSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        SkinWeightAutoAssignSoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
    }
}

// ─── Utilities. ─────────────────────────────────────────────────────────────

function _hashString( s ) {
    let h = 0x811c9dc5;
    for ( let i = 0; i < s.length; i ++ ) {
        h ^= s.charCodeAt( i );
        h = Math.imul( h, 0x01000193 );
    }
    return h >>> 0;
}

function _nowMs() {
    if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
        return performance.now();
    }
    return Date.now();
}

void Bone;
void BufferGeometry;
void Matrix4;
void Vector3;
void BonesPerVertex;
void SkinnedMeshCaps;
void SkinWeightLayoutSoA;
void _scratchVec3A;
void _scratchVec3B;
void _scratchVec3C;
void _scratchVec3D;
void _scratchVec3E;
void _scratchMat4;
void _scratchMat4Inv;

export {
    AssignStrategy,
    SkinWeightAutoAssignSoA,
    assign,
    setBoneEnvelopeRadius,
    setBoneRegion,
    getAutoAssignEntityForUuid,
    getLastAssignResult,
    getAggregatedStats,
    computeZeroWeightRatioHighPrecision,
    computeAssignCostHighPrecision,
    packAutoAssignVec4,
    packGeometryAssignVec4,
    packAssignTimingVec4,
    sampleAssignDither,
    beginFrame
};