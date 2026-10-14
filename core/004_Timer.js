// file number : 004
// full path name : src/core/004_Timer.js
// description : Modern replacement for the legacy Clock. Driven by an explicit update() call, with Page Visibility API integration to avoid huge deltas when the tab is hidden. Rewritten as an ES module; bridges to 001_MathUtils for clamp/lerp-based fixed-step smoothing, gl-matrix for high-precision time-matrix packing, double.js for safe accumulated-elapsed tracking, bitecs for SoA timer registration, and simplex-noise for procedural time-jitter utilities.
// best for : Frame-accurate, visibility-aware timing in animation loops and fixed-step physics simulations. Recommended over Clock since r183.
// license : MIT

import MathUtils from '../math/001_MathUtils.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

const TimerUtils = {

    // 001_MathUtils bridge: clamp a raw delta to a maximum allowed step (seconds).
    clampDelta: ( delta, maxDelta = 0.1 ) => {

        return MathUtils.clamp( delta, 0, maxDelta );

    },

    // 001_MathUtils bridge: smooth a series of deltas with a simple exponential filter.
    smoothDelta: ( previous, current, factor = 0.2 ) => {

        return MathUtils.lerp( previous, current, factor );

    },

    // gl-matrix bridge: pack elapsed/delta/timescale into a vec4 for GPU-side time uniforms.
    packTimeVec4: ( out, elapsed, delta, timescale, fixedDelta ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set( out || _scratchVec4, elapsed, delta, timescale, fixedDelta );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // bitecs bridge: register a Timer as a SoA component column (elapsed, delta, timescale).
    registerComponent: ( name, count ) => {

        const elapsedColumn = new Float64Array( count );
        const deltaColumn = new Float64Array( count );
        const timescaleColumn = new Float64Array( count );
        return { name, elapsedColumn, deltaColumn, timescaleColumn, count };

    },

    // double.js bridge: high-precision accumulation of elapsed time.
    accumulateElapsed: ( elapsedDouble, deltaSeconds ) => {

        const d = new Double( elapsedDouble );
        d.add( deltaSeconds );
        return d.valueOf();

    },

    // simplex-noise bridge: procedural time-jitter for non-deterministic animation tests.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class Timer {

    constructor() {

        this._previousTime = 0;
        this._currentTime = 0;

        this._delta = 0;
        this._elapsed = 0;

        this._timescale = 1;

        this._useFixedDelta = false;
        this._fixedDelta = 16.67; // ms, corresponds to approx. 60 FPS

        // Page Visibility API (https://github.com/mrdoob/three.js/issues/20575)
        this._usePageVisibilityAPI = typeof document !== 'undefined' && document.hidden !== undefined;
        this._pageVisibilityHandler = undefined;

    }

    // Connect the Page Visibility API to avoid large delta values when the tab is inactive.
    connect() {

        if ( this._usePageVisibilityAPI ) {

            this._pageVisibilityHandler = _handleVisibilityChange.bind( this );
            document.addEventListener( 'visibilitychange', this._pageVisibilityHandler, false );

        }

        return this;

    }

    dispose() {

        if ( this._usePageVisibilityAPI && this._pageVisibilityHandler ) {

            document.removeEventListener( 'visibilitychange', this._pageVisibilityHandler );

        }

        return this;

    }

    disableFixedDelta() {

        this._useFixedDelta = false;
        return this;

    }

    enableFixedDelta() {

        this._useFixedDelta = true;
        return this;

    }

    getDelta() {

        return this._delta / 1000;

    }

    getElapsedTime() {

        return this._elapsed / 1000;

    }

    getFixedDelta() {

        return this._fixedDelta / 1000;

    }

    getTimescale() {

        return this._timescale;

    }

    reset() {

        this._currentTime = _now();
        return this;

    }

    setFixedDelta( fixedDelta ) {

        this._fixedDelta = fixedDelta * 1000;
        return this;

    }

    setTimescale( timescale ) {

        this._timescale = timescale;
        return this;

    }

    update() {

        if ( this._useFixedDelta === true ) {

            this._delta = this._fixedDelta;

        } else {

            this._previousTime = this._currentTime;
            this._currentTime = _now();

            this._delta = this._currentTime - this._previousTime;

        }

        this._delta *= this._timescale;

        this._elapsed = TimerUtils.accumulateElapsed( this._elapsed, this._delta );

        return this;

    }

    // For THREE.Clock backward compatibility.
    get elapsedTime() {

        return this.getElapsedTime();

    }

    // Convenience accessors backed by the utility surface above.
    getClampedDelta( maxDelta ) {

        return TimerUtils.clampDelta( this.getDelta(), maxDelta );

    }

    packToVec4( out ) {

        return TimerUtils.packTimeVec4(
            out,
            this.getElapsedTime(),
            this.getDelta(),
            this._timescale,
            this.getFixedDelta()
        );

    }

    asBitecsComponent( name, count ) {

        return TimerUtils.registerComponent( name, count );

    }

}

Timer.Utils = TimerUtils;

function _now() {

    return ( typeof performance === 'undefined' ? Date : performance ).now();

}

function _handleVisibilityChange() {

    if ( document.hidden === false ) this.reset();

}

export default Timer;