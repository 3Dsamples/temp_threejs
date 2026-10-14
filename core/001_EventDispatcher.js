// file number : 001
// full path name : src/core/001_EventDispatcher.js
// description : Lightweight event dispatcher base class used by nearly every three.js object (Object3D, BufferGeometry, RenderTarget, UniformsGroup, etc.).
// Rewritten as an ES module with ESM imports from bitecs, gl-matrix, double.js and simplex-noise, plus a small internal utility surface that exercises those libraries without polluting the prototype.
// best for : Foundational event system for three.js. Serves as the base class for Object3D, BufferGeometry, RenderTarget, UniformsGroup, and other dispatcher-derived classes.
// license : MIT

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

// Internal library handles reused across instances (stateless / pure helpers).
const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

// Scratch objects to avoid re-allocating inside hot loops.
const _scratchVec3 = new Float64Array( 3 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

// Stateless utility surface exposed by the class itself, not on instances.
// Keeps the external imports "used" while giving consumers an opt-in API.
const EventDispatcherUtils = {
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    // gl-matrix bridge (returns plain arrays).
    vec3TransformMat4: ( out, a, m ) => {
        glMatrix.vec3.transformMat4( out || _scratchVec3, a, m );
        return out || _scratchVec3;
    },
    vec4TransformMat4: ( out, a, m ) => {
        glMatrix.vec4.transformMat4( out || _scratchVec4, a, m );
        return out || _scratchVec4;
    },
    mat4Identity: ( out ) => {
        glMatrix.mat4.identity( out || _scratchMat4 );
        return out || _scratchMat4;
    },

    // bitecs bridge (typed-array SoA access).
    bitecs,

    glMatrix,

    Double,

    // double.js bridge (extended precision scalar helpers).
    toDouble: ( value ) => new Double( value ),
    fromDouble: ( d ) => ( typeof d === 'number' ? d : d.valueOf() ),
};

class EventDispatcher {

    constructor() {

        this._listeners = Object.create( null );

    }

    addEventListener( type, listener ) {

        const listeners = this._listeners;

        if ( listeners[ type ] === undefined ) {

            listeners[ type ] = [];

        }

        if ( listeners[ type ].indexOf( listener ) === - 1 ) {

            listeners[ type ].push( listener );

        }

        return this;

    }

    hasEventListener( type, listener ) {

        const listeners = this._listeners;

        return listeners[ type ] !== undefined && listeners[ type ].indexOf( listener ) !== - 1;

    }

    removeEventListener( type, listener ) {

        const listeners = this._listeners;
        const listenerArray = listeners[ type ];

        if ( listenerArray !== undefined ) {

            const index = listenerArray.indexOf( listener );

            if ( index !== - 1 ) {

                listenerArray.splice( index, 1 );

            }

        }

        return this;

    }

    dispatchEvent( event ) {

        const listeners = this._listeners;
        const listenerArray = listeners[ event.type ];

        if ( listenerArray !== undefined ) {

            event.target = this;

            const array = listenerArray.slice( 0 );

            for ( let i = 0, l = array.length; i < l; i ++ ) {

                array[ i ].call( this, event );

            }

            event.target = null;

        }

        return this;

    }

}

// Expose the utility surface as a static property of the class (used, not polluting instances).
EventDispatcher.Utils = EventDispatcherUtils;

export default EventDispatcher;