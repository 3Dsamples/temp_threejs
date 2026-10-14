// file number : 016
// full path name : src/core/016_Raycaster.js
// description : This class is designed to assist with raycasting. Raycasting is used for mouse picking (working out what objects in the 3D space the mouse is over) amongst other things. Rewritten as an ES module; imports the local 001_EventDispatcher and 003_Layers, plus 002_Vector2, 003_Vector3, 007_Matrix4, and 013_Ray from the threejsbitecs/math folder. Bridges to 001_MathUtils for clamp and scalar helpers, gl-matrix for packing the raycaster header (near, far, layerMask, paramsCount) into a vec4, double.js for high-precision distance accumulation, bitecs for SoA raycaster registration, and simplex-noise for procedural ray jitter. All non-math three.js r185 imports (Camera from ../cameras/Camera.js, error from ../utils.js) are imported explicitly so the module remains self-contained. Corrected import paths and a single default export.
// best for : Mouse picking, click selection, collision detection, line-of-sight checks, and any interaction system that requires testing whether a ray intersects scene objects.
// license : MIT

import EventDispatcher from './001_EventDispatcher.js';
import Layers from './003_Layers.js';

import MathUtils from '../math/001_MathUtils.js';
import Vector2 from '../math/002_Vector2.js';
import Vector3 from '../math/003_Vector3.js';
import Matrix4 from '../math/007_Matrix4.js';
import Ray from '../math/013_Ray.js';

import { Camera } from 'https://cdn.jsdelivr.net/npm/three@0.185.0/src/cameras/Camera.js';
import { error } from 'https://cdn.jsdelivr.net/npm/three@0.185.0/src/utils.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

// ── Module-private scratch (mirrors r185 source) ───────────────────────────
const _matrix = new Matrix4();
const _rayDirection = new Vector3();

// ── Sort helpers (mirrors r185 source) ─────────────────────────────────────
function ascSort( a, b ) {

    return a.distance - b.distance;

}

function intersectObject( object, raycaster, intersects, recursive ) {

    let propagate = true;

    if ( object.layers.test( raycaster.layers ) ) {

        const result = object.raycast( raycaster, intersects );

        if ( result === false ) propagate = false;

    }

    if ( propagate === true && recursive === true ) {

        const children = object.children;

        for ( let i = 0, l = children.length; i < l; i ++ ) {

            intersectObject( children[ i ], raycaster, intersects, true );

        }

    }

}

const RaycasterUtils = {

    // 001_MathUtils bridge: clamp near/far to valid ranges.
    clampNear: ( near, far ) => {

        return MathUtils.clamp( near, 0, far );

    },
    clampFar: ( far, near ) => {

        return MathUtils.clamp( far, near, Infinity );

    },

    // gl-matrix bridge: pack the raycaster header (near, far, layerMask, paramsCount) into a vec4.
    packHeaderVec4: ( out, near, far, layerMask, paramsCount ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set( out || _scratchVec4, near, far, layerMask, paramsCount );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // bitecs bridge: register a Raycaster as a SoA component column set.
    registerComponent: ( name, count ) => {

        const nearColumn = new Float64Array( count );
        const farColumn = new Float64Array( count );
        const layerMaskColumn = new Uint32Array( count );
        return { name, nearColumn, farColumn, layerMaskColumn, count };

    },

    // double.js bridge: high-precision total distance of all intersections.
    totalDistance: ( intersections ) => {

        let total = new Double( 0 );
        for ( let i = 0; i < intersections.length; i ++ ) {

            total.add( intersections[ i ].distance );

        }
        return total.valueOf();

    },

    // simplex-noise bridge: jitter a ray direction by procedural noise (useful for soft/area shadows or debug scatter).
    jitterDirection: ( out, direction, amplitude = 0.01, seed = 0 ) => {

        const dir = out || _rayDirection;
        dir.copy( direction );
        dir.x += _noise3D( seed, 0, 0 ) * amplitude;
        dir.y += _noise3D( 0, seed, 0 ) * amplitude;
        dir.z += _noise3D( 0, 0, seed ) * amplitude;
        dir.normalize();
        return dir;

    },

    // simplex-noise bridge: procedural noise helpers.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class Raycaster {

    /**
     * Constructs a new raycaster.
     * @param {Vector3} origin - The origin vector where the ray casts from.
     * @param {Vector3} direction - The (normalized) direction vector that gives direction to the ray.
     * @param {number} [near=0] - All results returned are further away than near. Near can't be negative.
     * @param {number} [far=Infinity] - All results returned are closer than far. Far can't be lower than near.
     */
    constructor( origin, direction, near = 0, far = Infinity ) {

        this.ray = new Ray( origin, direction );

        this.near = near;
        this.far = far;

        this.camera = null;

        this.layers = new Layers();

        this.params = {
            Mesh: {},
            Line: { threshold: 1 },
            LOD: {},
            Points: { threshold: 1 },
            Sprite: {},
        };

        this._version = 0;

    }

    /**
     * Updates the ray with a new origin and direction by copying the values from the arguments.
     * @param {Vector3} origin - The origin vector where the ray casts from.
     * @param {Vector3} direction - The (normalized) direction vector that gives direction to the ray.
     */
    set( origin, direction ) {

        this.ray.set( origin, direction );
        this._version ++;

        return this;

    }

    /**
     * Uses the given coordinates and camera to compute a new origin and direction for the internal ray.
     * @param {Vector2} coords - 2D coordinates of the mouse, in normalized device coordinates (NDC). X and Y components should be between -1 and 1.
     * @param {Camera} camera - The camera from which the ray should originate.
     */
    setFromCamera( coords, camera ) {

        if ( camera.isPerspectiveCamera ) {

            this.ray.origin.setFromMatrixPosition( camera.matrixWorld );
            this.ray.direction.set( coords.x, coords.y, 0.5 ).unproject( camera ).sub( this.ray.origin ).normalize();
            this.camera = camera;

        } else if ( camera.isOrthographicCamera ) {

            this.ray.origin.set( coords.x, coords.y, camera.projectionMatrix.elements[ 14 ] ).unproject( camera );
            this.ray.direction.set( 0, 0, - 1 ).transformDirection( camera.matrixWorld );
            this.camera = camera;

        } else {

            error( 'Raycaster: Unsupported camera type: ' + camera.type );

        }

        this._version ++;

        return this;

    }

    /**
     * Uses the given WebXR controller to compute a new origin and direction for the internal ray.
     * @param {WebXRController} controller - The controller to copy the position and direction from.
     */
    setFromXRController( controller ) {

        _matrix.identity().extractRotation( controller.matrixWorld );
        this.ray.origin.setFromMatrixPosition( controller.matrixWorld );
        this.ray.direction.set( 0, 0, - 1 ).applyMatrix4( _matrix );

        this._version ++;

        return this;

    }

    /**
     * Checks all intersection between the ray and the object with or without the descendants.
     * @param {Object3D} object - The 3D object to check for intersection with the ray.
     * @param {boolean} [recursive=true] - If set to true, it also checks all descendants.
     * @param {Array} [intersects=[]] - The target array that holds the result of the method.
     */
    intersectObject( object, recursive = true, intersects = [] ) {

        intersectObject( object, this, intersects, recursive );

        intersects.sort( ascSort );

        return intersects;

    }

    /**
     * Checks all intersection between the ray and the objects with or without the descendants.
     * @param {Array} objects - The 3D objects to check for intersection with the ray.
     * @param {boolean} [recursive=true] - If set to true, it also checks all descendants.
     * @param {Array} [intersects=[]] - The target array that holds the result of the method.
     */
    intersectObjects( objects, recursive = true, intersects = [] ) {

        for ( let i = 0, l = objects.length; i < l; i ++ ) {

            intersectObject( objects[ i ], this, intersects, recursive );

        }

        intersects.sort( ascSort );

        return intersects;

    }

    // ── Convenience accessors backed by the utility surface above ─────────────

    clampNearFar() {

        this.near = RaycasterUtils.clampNear( this.near, this.far );
        this.far = RaycasterUtils.clampFar( this.far, this.near );
        return this;

    }

    packHeaderToVec4( out ) {

        return RaycasterUtils.packHeaderVec4(
            out,
            this.near,
            this.far,
            this.layers.mask,
            Object.keys( this.params ).length
        );

    }

    asBitecsComponent( name, count ) {

        return RaycasterUtils.registerComponent( name, count );

    }

    getTotalDistance( intersections ) {

        return RaycasterUtils.totalDistance( intersections );

    }

    jitterDirection( amplitude, seed ) {

        return RaycasterUtils.jitterDirection( this.ray.direction, this.ray.direction, amplitude, seed );

    }

    get version() {

        return this._version;

    }

}

Raycaster.Utils = RaycasterUtils;

export default Raycaster;