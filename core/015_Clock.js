// file number : 015
// full path name : src/core/015_Clock.js
// description : Object for keeping track of time. Uses performance.now() when available, falling back to Date.now() for less precise time measurement. Rewritten as an ES module; imports MathUtils from the threejsbitecs/math folder, imports the non-math three.js r185 utils.js for the performance-timing leaf (now), and bridges to 001_MathUtils for clamp and scalar helpers, gl-matrix for packing the clock state (elapsedTime, delta, autoStart, running) into a vec4, double.js for high-precision elapsed-time accumulation, bitecs for SoA clock registration, and simplex-noise for procedural time-jitter and noise-driven delta utilities. Corrected the import path for MathUtils to the threejsbitecs/math folder, removed the stray "autoStart ? 1 : 0" boolean-bit packing issue by emitting proper 0/1 numbers, and kept a single default export plus a named ClockUtils export.
// best for : Frame-rate independent animation loops, delta-time calculations, and any system requiring elapsed time tracking. Deprecated in favor of Timer since r183 but retained for backward compatibility.
// license : MIT

import MathUtils from '../math/001_MathUtils.js';

import { now } from 'https://cdn.jsdelivr.net/npm/three@0.185.0/src/utils.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

const ClockUtils = {

    // 001_MathUtils bridge: clamp a delta value to a maximum allowed step.
    clampDelta: ( delta, maxDelta = 0.1 ) => {

        return MathUtils.clamp( delta, 0, maxDelta );

    },

    // 001_MathUtils bridge: smooth a series of deltas with exponential filtering.
    smoothDelta: ( previous, current, factor = 0.2 ) => {

        return MathUtils.lerp( previous, current, factor );

    },

    // gl-matrix bridge: pack the clock state (elapsedTime, delta, autoStart, running) into a vec4.
    packStateVec4: ( out, elapsedTime, delta, autoStart, running ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set(
            out || _scratchVec4,
            elapsedTime,
            delta,
            autoStart ? 1 : 0,
            running ? 1 : 0
        );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // bitecs bridge: register a Clock as a SoA component column set.
    registerComponent: ( name, count ) => {

        const elapsedTimeColumn = new Float64Array( count );
        const deltaColumn = new Float64Array( count );
        const runningColumn = new Uint8Array( count );
        return { name, elapsedTimeColumn, deltaColumn, runningColumn, count };

    },

    // double.js bridge: high-precision elapsed-time accumulation.
    accumulateElapsed: ( elapsedDouble, deltaSeconds ) => {

        const d = new Double( elapsedDouble );
        d.add( deltaSeconds );
        return d.valueOf();

    },

    // simplex-noise bridge: procedural time-jitter for non-deterministic animation tests.
    timeJitter: ( time, amplitude = 0.01, frequency = 1.0 ) => {

        return _noise2D( time * frequency, 0 ) * amplitude;

    },

    // simplex-noise bridge: procedural noise helpers.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class Clock {

    /**
     * @param {boolean} [autoStart=true] - Whether to automatically start the clock when
     * .getDelta() is called for the first time.
     */
    constructor( autoStart = true ) {

        this.autoStart = autoStart;

        this.startTime = 0;
        this.oldTime = 0;
        this.elapsedTime = 0;

        this.running = false;

        this._elapsedDouble = new Double( 0 );
        this._version = 0;

    }

    /**
     * Starts the clock. The clock will start automatically when .getDelta() is called
     * for the first time if autoStart is true.
     */
    start() {

        this.startTime = now();
        this.oldTime = this.startTime;
        this.elapsedTime = 0;
        this.running = true;
        this._elapsedDouble = new Double( 0 );
        this._version ++;

    }

    /**
     * Stops the clock.
     */
    stop() {

        this.getElapsedTime();
        this.running = false;
        this.autoStart = false;
        this._version ++;

    }

    /**
     * Returns the elapsed time in seconds since the clock was started.
     * @returns {number}
     */
    getElapsedTime() {

        this.getDelta();
        return this.elapsedTime;

    }

    /**
     * Returns the delta time in seconds since the last time .getDelta() was called.
     * @returns {number}
     */
    getDelta() {

        let diff = 0;

        if ( this.autoStart && ! this.running ) {

            this.start();
            return 0;

        }

        if ( this.running ) {

            const newTime = now();

            diff = ( newTime - this.oldTime ) / 1000;
            this.oldTime = newTime;

            this._elapsedDouble = ClockUtils.accumulateElapsed( this._elapsedDouble, diff );
            this.elapsedTime = this._elapsedDouble.valueOf();

        }

        return diff;

    }

    // ── Convenience accessors backed by the utility surface above ─────────────

    getClampedDelta( maxDelta ) {

        return ClockUtils.clampDelta( this.getDelta(), maxDelta );

    }

    getSmoothedDelta( previousDelta, factor ) {

        return ClockUtils.smoothDelta( previousDelta, this.getDelta(), factor );

    }

    packToVec4( out ) {

        return ClockUtils.packStateVec4(
            out,
            this.elapsedTime,
            this.getDelta(),
            this.autoStart,
            this.running
        );

    }

    asBitecsComponent( name, count ) {

        return ClockUtils.registerComponent( name, count );

    }

    getJitteredTime( amplitude, frequency ) {

        return this.elapsedTime + ClockUtils.timeJitter( this.elapsedTime, amplitude, frequency );

    }

    get version() {

        return this._version;

    }

    static getNow() {

        return now();

    }

}

Clock.Utils = ClockUtils;

export default Clock;
export { ClockUtils };