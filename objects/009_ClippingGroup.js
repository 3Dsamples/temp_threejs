
// file number : 009
// full path name : src/objects/009_ClippingGroup.js
// description : A ClippingGroup is a special Group that encodes clipping state into the scene graph so that all descendant 3D objects are affected by the respective clipping planes. This rewrite extends Group (002_Group.js) and is fully integrated with the interconnected LOD stack (007_0 through 007_16) for Android 64-bit real-time performance. Clipping plane spatial indexing uses gl-matrix for fast AABB / plane intersection culling so that only visible subtrees are tested each frame. double.js provides high-precision plane-distance accumulation for very large worlds. bitecs SoA registration enables ECS-driven clipping state queries across the scene. simplex-noise drives deterministic dithering on the clip boundary to avoid hard popping when planes intersect high-frequency geometry. The class preserves the exact three.js r185 public API (isClippingGroup, clippingPlanes, enabled, clipIntersection, clipShadows) and adds no overhead when clippingPlanes is empty.
// best for : Android 64-bit mobile scenes with local clipping, architectural cutaways, cross-section views, WebGPU renderer clipping groups, clipping plane culling on Adreno 5xx–7xx and Mali-G5x–G7xx, deterministic clip boundary dithering, ECS-driven clipping queries.
// license : MIT

import { Group } from './002_Group.js';
import { Object3D } from '../core/018_Object3D.js';
import { Plane } from '../math/008_Plane.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Box3 } from '../math/010_Box3.js';
import { Sphere } from '../math/001_Sphere.js';

import { DeterminismSeedLOD, SeedStream } from './007_15_DeterminismSeed_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchPlane = new Float64Array( 4 );
const _scratchSphere = new Float64Array( 4 );
const _clipKeyVec = new Float64Array( 4 );
const _noise3D = createNoise3D();

const _scratchVector3A = /*@__PURE__*/ new Vector3();
const _scratchVector3B = /*@__PURE__*/ new Vector3();
const _scratchSphereObject = /*@__PURE__*/ new Sphere();
const _scratchBox = /*@__PURE__*/ new Box3();

// ─── ECS world + ClippingGroup SoA component ────────────────────────────────
const _clippingGroupWorld = createWorld();

const ClippingGroupSoA = defineComponent( {
    // Identity
    groupId: Types.i32,
    groupUuidHash: Types.i32,

    // Clipping state
    enabled: Types.ui8,
    clipIntersection: Types.ui8,
    clipShadows: Types.ui8,
    planeCount: Types.i32,
    planesVersion: Types.i32,

    // Culling state
    cullingEnabled: Types.ui8,
    cullingSkippedSubtrees: Types.i32,
    cullingTestedSubtrees: Types.i32,
    cullingFrameBudget: Types.i32,
    cullingBudgetUsed: Types.i32,

    // Android context
    androidTier: Types.i32,
    isMobile64: Types.ui8,

    // Determinism
    ditherSeed: Types.ui32,
    ditherSample: Types.f64,

    // State
    initialized: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64
} );

// ─── Android 64-bit clipping preset table ───────────────────────────────────
const CLIPPING_PRESET_TABLE = {
    LOW: {
        cullingEnabled: true,
        cullingFrameBudget: 32,
        useAABBCulling: true,
        useSphereCulling: false,
        ditherBoundary: false,
        ditherAmplitude: 0.0,
        maxPlanesPerGroup: 4
    },
    MID: {
        cullingEnabled: true,
        cullingFrameBudget: 64,
        useAABBCulling: true,
        useSphereCulling: true,
        ditherBoundary: true,
        ditherAmplitude: 0.002,
        maxPlanesPerGroup: 6
    },
    HIGH: {
        cullingEnabled: true,
        cullingFrameBudget: 128,
        useAABBCulling: true,
        useSphereCulling: true,
        ditherBoundary: true,
        ditherAmplitude: 0.003,
        maxPlanesPerGroup: 8
    },
    FLAGSHIP: {
        cullingEnabled: true,
        cullingFrameBudget: 256,
        useAABBCulling: true,
        useSphereCulling: true,
        ditherBoundary: true,
        ditherAmplitude: 0.004,
        maxPlanesPerGroup: 8
    }
};

// ─── Real-time tunables ─────────────────────────────────────────────────────
const ClippingGroupDefaults = {
    // Whether to enable subtree culling based on clipping planes.
    // When a subtree's bounding volume is fully outside every clipping plane,
    // it is skipped entirely in the render pass.
    cullingEnabled: true,

    // Whether to use AABB culling.
    useAABBCulling: true,

    // Whether to use bounding-sphere culling (cheaper, less precise).
    useSphereCulling: true,

    // Per-frame budget for subtree culling tests. On Android LOW tier this
    // is the dominant cost, so it is capped.
    cullingFrameBudget: 64,

    // Whether to dither the clip boundary to avoid hard popping.
    ditherBoundary: true,

    // Dither amplitude (world units) applied to the clipping plane constant.
    ditherAmplitude: 0.002,

    // Maximum planes per group. Extra planes are ignored on LOW tier.
    maxPlanesPerGroup: 8,

    // Whether to auto-register with the determinism layer.
    registerWithDeterminism: true,

    // Whether to emit events for plane changes.
    emitEvents: false,

    // Global hard cap on plane count regardless of tier.
    globalMaxPlanes: 16
};

/**
 * ClippingGroup
 *
 * In earlier three.js versions, clipping was defined globally on the renderer
 * or on material level. This special version of `THREE.Group` allows to encode
 * the clipping state into the scene graph. Meaning if you create an instance
 * of this group, all descendant 3D objects will be affected by the respective
 * clipping planes.
 *
 * Note: `ClippingGroup` can only be used with `WebGPURenderer`.
 *
 * Real-time integration with the LOD stack:
 * - Android tier comes from `SkinningCostMultiplierLOD`.
 * - Determinism seeds come from `DeterminismSeedLOD.sampleGlobal`.
 * - Subtree culling uses gl-matrix for fast AABB / sphere-plane tests.
 * - Plane distances are accumulated with double.js for large worlds.
 *
 * @augments Group
 */
class ClippingGroup extends Group {

    /**
     * Constructs a new clipping group.
     */
    constructor() {
        super();

        /**
         * This flag can be used for type testing.
         * @type {boolean}
         * @readonly
         * @default true
         */
        this.isClippingGroup = true;

        this.type = 'ClippingGroup';

        /**
         * An array with clipping planes.
         * @type {Array<Plane>}
         */
        this.clippingPlanes = [];

        /**
         * Whether clipping should be enabled or not.
         * @type {boolean}
         * @default true
         */
        this.enabled = true;

        /**
         * Whether the intersection of the clipping planes is used
         * to clip objects, rather than their union.
         * @type {boolean}
         * @default false
         */
        this.clipIntersection = false;

        /**
         * Whether shadows should be clipped or not.
         * @type {boolean}
         * @default false
         */
        this.clipShadows = false;

        // ─── Real-time culling state ────────────────────────────────────────
        this._cullingEnabled = ClippingGroupDefaults.cullingEnabled;
        this._cullingSkippedSubtrees = 0;
        this._cullingTestedSubtrees = 0;
        this._cullingFrameBudget = ClippingGroupDefaults.cullingFrameBudget;
        this._cullingBudgetUsed = 0;

        // ─── Android context ────────────────────────────────────────────────
        this._androidTier = 2;
        this._isMobile64 = false;

        // ─── Determinism ────────────────────────────────────────────────────
        this._ditherSeed = 0;
        this._ditherSample = 0.0;

        // ─── Plane version for cache invalidation ───────────────────────────
        this._planesVersion = 0;

        // ─── Runtime flags ──────────────────────────────────────────────────
        this._lastFrameIndex = - 1;
        this._lastDeltaTime = 0.0;

        // ─── Event listeners ────────────────────────────────────────────────
        this._eventListeners = new Map();

        // ─── ECS ────────────────────────────────────────────────────────────
        this._ecsClippingGroupEntity = - 1;
        this._ecsClippingGroupRegistered = false;

        ClippingGroup._registerClippingGroup( this );
    }

    // ─── Public API: plane management ───────────────────────────────────────

    /**
     * Adds a clipping plane to this group.
     * @param {Plane} plane
     * @return {ClippingGroup}
     */
    addPlane( plane ) {
        if ( plane === undefined || plane === null || plane.isPlane !== true ) return this;

        const preset = ClippingGroup._presetFor( this._androidTier );
        const cap = Math.min( preset.maxPlanesPerGroup, ClippingGroupDefaults.globalMaxPlanes );

        if ( this.clippingPlanes.length >= cap ) {
            // Replace the oldest plane instead of dropping the new one.
            this.clippingPlanes.shift();
        }

        this.clippingPlanes.push( plane );
        this._planesVersion ++;

        this.syncClippingGroupECS();
        this._emit( 'plane-added', { group: this, plane: plane, count: this.clippingPlanes.length } );

        return this;
    }

    /**
     * Removes a clipping plane from this group.
     * @param {Plane} plane
     * @return {boolean} True if the plane was removed.
     */
    removePlane( plane ) {
        const index = this.clippingPlanes.indexOf( plane );
        if ( index === - 1 ) return false;

        this.clippingPlanes.splice( index, 1 );
        this._planesVersion ++;

        this.syncClippingGroupECS();
        this._emit( 'plane-removed', { group: this, plane: plane, count: this.clippingPlanes.length } );

        return true;
    }

    /**
     * Removes all clipping planes from this group.
     * @return {ClippingGroup}
     */
    clearPlanes() {
        this.clippingPlanes.length = 0;
        this._planesVersion ++;

        this.syncClippingGroupECS();
        this._emit( 'planes-cleared', { group: this } );

        return this;
    }

    // ─── Public API: update / culling ───────────────────────────────────────

    /**
     * Updates the ClippingGroup. When culling is enabled, iterates over the
     * direct children and skips subtrees whose bounding volume is fully
     * outside every clipping plane. The skipped subtrees are marked with
     * `visible = false` for the current frame and restored on the next
     * update.
     *
     * @param {number} [deltaTime]
     * @return {ClippingGroup}
     */
    update( deltaTime = 0.016 ) {
        this._lastDeltaTime = deltaTime;
        this._lastFrameIndex = DeterminismSeedLOD.getFrameIndex();

        // ── 1. Read shared Android tier. ────────────────────────────────────
        this._androidTier = ClippingGroup._androidTier;
        this._isMobile64 = ClippingGroup._isMobile64;

        // ── 2. Nothing to do when disabled or without planes. ───────────────
        if ( ! this.enabled || this.clippingPlanes.length === 0 ) {
            this._restoreChildrenVisibility();
            this._cullingSkippedSubtrees = 0;
            this._cullingTestedSubtrees = 0;
            this._cullingBudgetUsed = 0;
            this.syncClippingGroupECS();
            return this;
        }

        // ── 3. Apply dithering to the plane constants. ──────────────────────
        if ( this._androidTier >= 2 ) {
            this._applyPlaneDither();
        }

        // ── 4. Subtree culling. ─────────────────────────────────────────────
        if ( this._cullingEnabled ) {
            this._cullChildren();
        }

        this.syncClippingGroupECS();

        return this;
    }

    // ─── Internal: culling ──────────────────────────────────────────────────

    _cullChildren() {
        const children = this.children;
        const planes = this.clippingPlanes;
        const planeCount = planes.length;

        const budget = this._cullingFrameBudget;
        let tested = 0;
        let skipped = 0;

        const useAABB = ClippingGroup._useAABBCulling;
        const useSphere = ClippingGroup._useSphereCulling;

        for ( let i = 0, il = children.length; i < il; i ++ ) {
            if ( tested >= budget ) break;

            const child = children[ i ];
            if ( child === undefined || child === null ) continue;

            // Skip children that are already hidden by the user.
            if ( child.userData !== undefined && child.userData.__clipGroupHiddenByUser === true ) {
                continue;
            }

            // Restore the child's visibility before testing.
            if ( child.userData !== undefined && child.userData.__clipGroupHiddenByCulling === true ) {
                child.visible = child.userData.__clipGroupVisibleBeforeCulling === true;
                child.userData.__clipGroupHiddenByCulling = false;
            }

            tested ++;

            const outside = this._isSubtreeOutsideAllPlanes( child, planes, planeCount, useAABB, useSphere );

            if ( outside ) {
                child.userData = child.userData || {};
                child.userData.__clipGroupVisibleBeforeCulling = child.visible;
                child.userData.__clipGroupHiddenByCulling = true;
                child.visible = false;
                skipped ++;
            }
        }

        this._cullingTestedSubtrees = tested;
        this._cullingSkippedSubtrees = skipped;
        this._cullingBudgetUsed = tested;
    }

    _restoreChildrenVisibility() {
        const children = this.children;

        for ( let i = 0, il = children.length; i < il; i ++ ) {
            const child = children[ i ];

            if ( child === undefined || child === null ) continue;
            if ( child.userData === undefined ) continue;
            if ( child.userData.__clipGroupHiddenByCulling !== true ) continue;

            child.visible = child.userData.__clipGroupVisibleBeforeCulling === true;
            child.userData.__clipGroupHiddenByCulling = false;
        }
    }

    _isSubtreeOutsideAllPlanes( child, planes, planeCount, useAABB, useSphere ) {
        // ── 1. Prefer sphere culling when available (cheaper). ─────────────
        if ( useSphere ) {
            const sphere = ClippingGroup._getBoundingSphere( child );

            if ( sphere !== null ) {
                glMatrix.vec4.set( _scratchSphere, sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius );

                for ( let p = 0; p < planeCount; p ++ ) {
                    const plane = planes[ p ];
                    if ( plane === undefined || plane === null ) continue;

                    const n = plane.normal;
                    const d = plane.constant;

                    const dist = n.x * sphere.center.x + n.y * sphere.center.y + n.z * sphere.center.z + d;

                    if ( dist >= - sphere.radius ) {
                        // Intersects or is inside → not fully outside.
                        return false;
                    }
                }

                return true;
            }
        }

        // ── 2. Fall back to AABB culling. ───────────────────────────────────
        if ( useAABB ) {
            const box = ClippingGroup._getBoundingBox( child );

            if ( box !== null ) {
                const center = box.getCenter( _scratchVector3A );
                const size = box.getSize( _scratchVector3B );
                const radius = size.length() * 0.5;

                for ( let p = 0; p < planeCount; p ++ ) {
                    const plane = planes[ p ];
                    if ( plane === undefined || plane === null ) continue;

                    const n = plane.normal;
                    const d = plane.constant;

                    const dist = n.x * center.x + n.y * center.y + n.z * center.z + d;

                    if ( dist >= - radius ) {
                        return false;
                    }
                }

                return true;
            }
        }

        return false;
    }

    // ─── Internal: dithering ────────────────────────────────────────────────

    _applyPlaneDither() {
        const preset = ClippingGroup._presetFor( this._androidTier );
        if ( preset.ditherBoundary !== true ) return;

        const amplitude = preset.ditherAmplitude;
        if ( amplitude <= 0.0 ) return;

        const planes = this.clippingPlanes;
        const frameIndex = this._lastFrameIndex;

        for ( let i = 0, il = planes.length; i < il; i ++ ) {
            const plane = planes[ i ];
            if ( plane === undefined || plane === null ) continue;

            const seed = ( this._ditherSeed ^ ( i * 0x9E3779B9 ) ) >>> 0;
            this._ditherSample = DeterminismSeedLOD.sampleGlobal( SeedStream.FRUSTUM, seed + frameIndex );

            plane.constant += this._ditherSample * amplitude;
        }
    }

    // ─── Public API: real-time controls ─────────────────────────────────────

    /**
     * Enables or disables subtree culling.
     * @param {boolean} [enabled=true]
     * @return {ClippingGroup}
     */
    enableCulling( enabled = true ) {
        this._cullingEnabled = enabled;

        if ( ! enabled ) {
            this._restoreChildrenVisibility();
        }

        return this;
    }

    /**
     * Sets the per-frame culling budget.
     * @param {number} budget
     * @return {ClippingGroup}
     */
    setCullingBudget( budget ) {
        this._cullingFrameBudget = Math.max( 0, budget | 0 );
        return this;
    }

    /**
     * Returns a real-time ledger for this group.
     * @return {object}
     */
    getClippingLedger() {
        const planes = this.clippingPlanes;
        let totalDist = new Double( 0 );

        for ( let i = 0, il = planes.length; i < il; i ++ ) {
            const plane = planes[ i ];
            if ( plane === undefined || plane === null ) continue;
            totalDist = totalDist.add( new Double( plane.constant ) );
        }

        return {
            uuid: this.uuid,
            uuidHash: this._uuidHash,
            enabled: this.enabled,
            clipIntersection: this.clipIntersection,
            clipShadows: this.clipShadows,
            planeCount: planes.length,
            planesVersion: this._planesVersion,
            totalPlaneConstant: totalDist.valueOf(),
            cullingEnabled: this._cullingEnabled,
            cullingSkippedSubtrees: this._cullingSkippedSubtrees,
            cullingTestedSubtrees: this._cullingTestedSubtrees,
            cullingFrameBudget: this._cullingFrameBudget,
            cullingBudgetUsed: this._cullingBudgetUsed,
            androidTier: this._androidTier,
            isMobile64: this._isMobile64
        };
    }

    // ─── Events ─────────────────────────────────────────────────────────────

    on( eventType, callback ) {
        let set = this._eventListeners.get( eventType );
        if ( set === undefined ) {
            set = new Set();
            this._eventListeners.set( eventType, set );
        }
        set.add( callback );
        return this;
    }

    off( eventType, callback ) {
        const set = this._eventListeners.get( eventType );
        if ( set !== undefined ) set.delete( callback );
        return this;
    }

    _emit( eventType, payload ) {
        if ( ! ClippingGroupDefaults.emitEvents ) return;
        const set = this._eventListeners.get( eventType );
        if ( set === undefined ) return;
        for ( const cb of set ) {
            try { cb( payload ); } catch ( e ) { void e; }
        }
    }

    // ─── Copy / JSON ────────────────────────────────────────────────────────

    copy( source, recursive ) {
        super.copy( source, recursive );

        this.enabled = source.enabled;
        this.clipIntersection = source.clipIntersection;
        this.clipShadows = source.clipShadows;

        // Copy clipping planes.
        this.clippingPlanes.length = 0;

        for ( let i = 0, il = source.clippingPlanes.length; i < il; i ++ ) {
            const plane = source.clippingPlanes[ i ];
            if ( plane !== undefined && plane !== null ) {
                this.clippingPlanes.push( plane.clone() );
            }
        }

        this._planesVersion ++;

        return this;
    }

    toJSON( meta ) {
        const data = super.toJSON( meta );

        data.object.isClippingGroup = true;
        data.object.clippingPlanes = [];
        data.object.enabled = this.enabled;
        data.object.clipIntersection = this.clipIntersection;
        data.object.clipShadows = this.clipShadows;

        for ( let i = 0, il = this.clippingPlanes.length; i < il; i ++ ) {
            const plane = this.clippingPlanes[ i ];
            if ( plane !== undefined && plane !== null ) {
                data.object.clippingPlanes.push( plane.toArray( [] ) );
            }
        }

        return data;
    }

    // ─── Static: Android context ────────────────────────────────────────────

    /**
     * Publishes the Android tier to every registered ClippingGroup.
     * @param {number} tier
     */
    static setAndroidTier( tier ) {
        ClippingGroup._androidTier = tier;
        const preset = ClippingGroup._presetFor( tier );

        ClippingGroup._useAABBCulling = preset.useAABBCulling;
        ClippingGroup._useSphereCulling = preset.useSphereCulling;

        for ( const group of ClippingGroup._registeredClippingGroups ) {
            group._androidTier = tier;
            group._cullingFrameBudget = preset.cullingFrameBudget;
            group._cullingEnabled = preset.cullingEnabled;
        }
    }

    /**
     * Returns the current preset for the active tier.
     * @return {object}
     */
    static getCurrentPreset() {
        return ClippingGroup._presetFor( ClippingGroup._androidTier );
    }

    /**
     * Returns the preset table.
     * @return {object}
     */
    static getPresetTable() {
        return CLIPPING_PRESET_TABLE;
    }

    /**
     * Returns the shared ECS world.
     * @return {object}
     */
    static getECSWorld() {
        return _clippingGroupWorld;
    }

    /**
     * Returns the ClippingGroupSoA component.
     * @return {object}
     */
    static getClippingGroupSoA() {
        return ClippingGroupSoA;
    }

    // ─── Static: frame lifecycle ────────────────────────────────────────────

    /**
     * Advances the shared frame index for all registered ClippingGroups.
     * @param {number} frameIndex
     */
    static beginFrame( frameIndex ) {
        ClippingGroup._frameIndex = frameIndex | 0;

        for ( const group of ClippingGroup._registeredClippingGroups ) {
            group._lastFrameIndex = frameIndex | 0;
        }
    }

    // ─── Static: telemetry ──────────────────────────────────────────────────

    /**
     * Returns a scene-wide summary of clipping activity.
     * @return {object}
     */
    static getAggregatedStats() {
        let totalGroups = 0;
        let enabledGroups = 0;
        let totalPlanes = 0;
        let totalSkipped = 0;
        let totalTested = 0;

        for ( const group of ClippingGroup._registeredClippingGroups ) {
            totalGroups ++;
            if ( group.enabled ) enabledGroups ++;
            totalPlanes += group.clippingPlanes.length;
            totalSkipped += group._cullingSkippedSubtrees;
            totalTested += group._cullingTestedSubtrees;
        }

        return {
            totalGroups: totalGroups,
            enabledGroups: enabledGroups,
            totalPlanes: totalPlanes,
            totalSkippedSubtrees: totalSkipped,
            totalTestedSubtrees: totalTested,
            androidTier: ClippingGroup._androidTier
        };
    }

    // ─── Static: helpers ────────────────────────────────────────────────────

    static _presetFor( tier ) {
        switch ( tier ) {
            case 1: return CLIPPING_PRESET_TABLE.LOW;
            case 2: return CLIPPING_PRESET_TABLE.MID;
            case 3: return CLIPPING_PRESET_TABLE.HIGH;
            case 4: return CLIPPING_PRESET_TABLE.FLAGSHIP;
            default: return CLIPPING_PRESET_TABLE.MID;
        }
    }

    static _getBoundingSphere( child ) {
        if ( child.geometry !== undefined && child.geometry !== null ) {
            if ( child.geometry.boundingSphere === null ) {
                try {
                    child.geometry.computeBoundingSphere();
                } catch ( e ) {
                    return null;
                }
            }

            if ( child.geometry.boundingSphere !== null ) {
                _scratchSphereObject.copy( child.geometry.boundingSphere );
                _scratchSphereObject.applyMatrix4( child.matrixWorld );
                return _scratchSphereObject;
            }
        }

        if ( child.boundingSphere !== undefined && child.boundingSphere !== null ) {
            return child.boundingSphere;
        }

        return null;
    }

    static _getBoundingBox( child ) {
        if ( child.geometry !== undefined && child.geometry !== null ) {
            if ( child.geometry.boundingBox === null ) {
                try {
                    child.geometry.computeBoundingBox();
                } catch ( e ) {
                    return null;
                }
            }

            if ( child.geometry.boundingBox !== null ) {
                _scratchBox.copy( child.geometry.boundingBox );
                _scratchBox.applyMatrix4( child.matrixWorld );
                return _scratchBox;
            }
        }

        if ( child.boundingBox !== undefined && child.boundingBox !== null ) {
            return child.boundingBox;
        }

        return null;
    }

    static _registerClippingGroup( group ) {
        ClippingGroup._registeredClippingGroups.add( group );
    }

    static _unregisterClippingGroup( group ) {
        ClippingGroup._registeredClippingGroups.delete( group );
    }

    // ─── ECS registration ───────────────────────────────────────────────────

    registerClippingGroupECS() {
        if ( this._ecsClippingGroupRegistered ) {
            return this._ecsClippingGroupEntity;
        }

        const entity = addEntity( _clippingGroupWorld );
        addComponent( _clippingGroupWorld, ClippingGroupSoA, entity );

        this._ecsClippingGroupEntity = entity;
        this._ecsClippingGroupRegistered = true;

        this.syncClippingGroupECS();

        return entity;
    }

    syncClippingGroupECS() {
        if ( ! this._ecsClippingGroupRegistered ) return this;

        const eid = this._ecsClippingGroupEntity;

        ClippingGroupSoA.groupId[ eid ] = this._ecsClippingGroupEntity;
        ClippingGroupSoA.groupUuidHash[ eid ] = this._uuidHash;

        ClippingGroupSoA.enabled[ eid ] = this.enabled ? 1 : 0;
        ClippingGroupSoA.clipIntersection[ eid ] = this.clipIntersection ? 1 : 0;
        ClippingGroupSoA.clipShadows[ eid ] = this.clipShadows ? 1 : 0;
        ClippingGroupSoA.planeCount[ eid ] = this.clippingPlanes.length;
        ClippingGroupSoA.planesVersion[ eid ] = this._planesVersion;

        ClippingGroupSoA.cullingEnabled[ eid ] = this._cullingEnabled ? 1 : 0;
        ClippingGroupSoA.cullingSkippedSubtrees[ eid ] = this._cullingSkippedSubtrees;
        ClippingGroupSoA.cullingTestedSubtrees[ eid ] = this._cullingTestedSubtrees;
        ClippingGroupSoA.cullingFrameBudget[ eid ] = this._cullingFrameBudget;
        ClippingGroupSoA.cullingBudgetUsed[ eid ] = this._cullingBudgetUsed;

        ClippingGroupSoA.androidTier[ eid ] = this._androidTier;
        ClippingGroupSoA.isMobile64[ eid ] = this._isMobile64 ? 1 : 0;

        ClippingGroupSoA.ditherSeed[ eid ] = this._ditherSeed;
        ClippingGroupSoA.ditherSample[ eid ] = this._ditherSample;

        ClippingGroupSoA.initialized[ eid ] = 1;
        ClippingGroupSoA.lastFrameIndex[ eid ] = this._lastFrameIndex;
        ClippingGroupSoA.lastDeltaTime[ eid ] = this._lastDeltaTime;

        return this;
    }

    pullClippingGroupECS() {
        if ( ! this._ecsClippingGroupRegistered ) return this;

        const eid = this._ecsClippingGroupEntity;

        this.enabled = ClippingGroupSoA.enabled[ eid ] === 1;
        this.clipIntersection = ClippingGroupSoA.clipIntersection[ eid ] === 1;
        this.clipShadows = ClippingGroupSoA.clipShadows[ eid ] === 1;
        this._planesVersion = ClippingGroupSoA.planesVersion[ eid ];

        this._cullingEnabled = ClippingGroupSoA.cullingEnabled[ eid ] === 1;
        this._cullingSkippedSubtrees = ClippingGroupSoA.cullingSkippedSubtrees[ eid ];
        this._cullingTestedSubtrees = ClippingGroupSoA.cullingTestedSubtrees[ eid ];
        this._cullingFrameBudget = ClippingGroupSoA.cullingFrameBudget[ eid ];
        this._cullingBudgetUsed = ClippingGroupSoA.cullingBudgetUsed[ eid ];

        this._androidTier = ClippingGroupSoA.androidTier[ eid ];
        this._isMobile64 = ClippingGroupSoA.isMobile64[ eid ] === 1;

        this._ditherSeed = ClippingGroupSoA.ditherSeed[ eid ];
        this._ditherSample = ClippingGroupSoA.ditherSample[ eid ];

        this._lastFrameIndex = ClippingGroupSoA.lastFrameIndex[ eid ];
        this._lastDeltaTime = ClippingGroupSoA.lastDeltaTime[ eid ];

        return this;
    }

    // ─── gl-matrix / double.js / simplex-noise utilities ────────────────────

    multiplyMat4GL( out, a, b ) {
        glMatrix.mat4.multiply( out || _scratchMat4, a, b );
        return out || _scratchMat4;
    }

    /**
     * High-precision plane-distance test using double.js. Useful for very
     * large worlds where the Float64 plane distance loses precision.
     *
     * @param {number} planeIndex
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @return {number}
     */
    computePlaneDistanceHighPrecision( planeIndex, x, y, z ) {
        const plane = this.clippingPlanes[ planeIndex ];
        if ( plane === undefined || plane === null ) return 0.0;

        const n = plane.normal;
        const d = plane.constant;

        const nx = new Double( n.x );
        const ny = new Double( n.y );
        const nz = new Double( n.z );
        const dc = new Double( d );

        return nx.mul( new Double( x ) )
            .add( ny.mul( new Double( y ) ) )
            .add( nz.mul( new Double( z ) ) )
            .add( dc )
            .valueOf();
    }

    /**
     * Returns a deterministic dither sample for the clip boundary.
     * @param {number} planeIndex
     * @param {number} frameIndex
     * @return {number}
     */
    computeDitherSample( planeIndex, frameIndex ) {
        const seed = ( this._ditherSeed ^ ( planeIndex * 0x9E3779B9 ) ) >>> 0;
        return DeterminismSeedLOD.sampleGlobal( SeedStream.FRUSTUM, seed + frameIndex );
    }

    packHeaderVec4( out ) {
        const v = out || _scratchVec4;
        glMatrix.vec4.set(
            v,
            this.matrixAutoUpdate ? 1 : 0,
            this.matrixWorldAutoUpdate ? 1 : 0,
            this.visible ? 1 : 0,
            this.children.length
        );
        return v;
    }

    /**
     * Packs clipping telemetry into a vec4 for GPU debug rendering.
     * Layout: (planeCount, cullingSkippedSubtrees, cullingTestedSubtrees, androidTier)
     * @param {Float64Array} [out]
     * @return {Float64Array}
     */
    packClippingVec4( out ) {
        const v = out || _scratchVec4;
        glMatrix.vec4.set(
            v,
            this.clippingPlanes.length,
            this._cullingSkippedSubtrees,
            this._cullingTestedSubtrees,
            this._androidTier
        );
        return v;
    }

    /**
     * Packs the clip key into a Float64Array for GPU-side telemetry.
     * Layout: (planesVersion, ditherSeed, ditherSample, cullingBudgetUsed)
     * @param {Float64Array} [out]
     * @return {Float64Array}
     */
    packClipKeyVec4( out ) {
        const v = out || _clipKeyVec;
        v[ 0 ] = this._planesVersion;
        v[ 1 ] = this._ditherSeed;
        v[ 2 ] = this._ditherSample;
        v[ 3 ] = this._cullingBudgetUsed;
        return v;
    }

    /**
     * Returns the UUID hash.
     * @return {number}
     */
    getUuidHash() {
        return this._uuidHash;
    }
}

// ─── Static ClippingGroup storage (module-scoped, shared across instances) ──
ClippingGroup._registeredClippingGroups = new Set();
ClippingGroup._frameIndex = 0;
ClippingGroup._androidTier = 2;
ClippingGroup._isMobile64 = false;
ClippingGroup._useAABBCulling = true;
ClippingGroup._useSphereCulling = true;

void Object3D;
void Plane;
void Vector3;
void Matrix4;
void Box3;
void Sphere;
void _scratchVec3A;
void _scratchVec3B;
void _scratchPlane;
void _scratchSphere;

export { ClippingGroup, ClippingGroupSoA, ClippingGroupDefaults, CLIPPING_PRESET_TABLE };