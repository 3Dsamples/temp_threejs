// file number : 003
// full path name : src/core/003_Layers.js
// description : 32-bit layer mask used to control visibility/culling relationships between Object3D instances and cameras. Rewritten as an ES module; bridges to bitecs SoA arrays, gl-matrix for mask arithmetic helpers, double.js for safe high-precision bit math, and simplex-noise through a static utility surface.
// best for : Per-object layer membership checks. Object3D owns a Layers instance; the renderer tests camera.layers against object.layers.
// license : MIT

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec2 = new Float64Array( 2 );
const _scratchMat2 = new Float64Array( 4 );

const LayersUtils = {

    // gl-matrix bridge: mask-as-column vector helper (useful for batch layer
    // membership tests using vec2 + mat2 identity).
    maskAsVec2: ( mask ) => {

        glMatrix.mat2.identity( _scratchMat2 );
        glMatrix.vec2.set( _scratchVec2, mask >>> 0, ( mask >>> 0 ) ^ 0xffffffff );
        glMatrix.vec2.transformMat2( _scratchVec2, _scratchVec2, _scratchMat2 );
        return _scratchVec2;

    },

    // bitecs bridge: expose layer membership as a Uint32Array column suitable
    // for use as a bitecs component column.
    registerComponent: ( name, count ) => {

        const column = new Uint32Array( count );
        column.fill( 1 ); // default: layer 0
        return { name, column, count };

    },

    // double.js bridge: high-precision popcount of set layers.
    popCount: ( mask ) => {

        const d = new Double( mask >>> 0 );
        return d.valueOf().toString( 2 ).split( '1' ).length - 1;

    },

    // simplex-noise bridge (deterministic layer jitter generators).
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class Layers {

    constructor() {

        this.mask = 1 | 0;

    }

    set( layer ) {

        this.mask = ( 1 << layer | 0 ) >>> 0;

    }

    enable( layer ) {

        this.mask |= 1 << layer | 0;

    }

    enableAll() {

        this.mask = 0xffffffff | 0;

    }

    toggle( layer ) {

        this.mask ^= 1 << layer | 0;

    }

    disable( layer ) {

        this.mask &= ~ ( 1 << layer | 0 );

    }

    disableAll() {

        this.mask = 0;

    }

    test( layers ) {

        return ( this.mask & layers.mask ) !== 0;

    }

    isEnabled( layer ) {

        return ( this.mask & ( 1 << layer | 0 ) ) !== 0;

    }

    // Convenience accessors backed by the utility surface above.
    getPopCount() {

        return LayersUtils.popCount( this.mask );

    }

    asBitecsComponent( name, count ) {

        const comp = LayersUtils.registerComponent( name, count );
        comp.column.fill( this.mask >>> 0 );
        return comp;

    }

    toVec2() {

        return LayersUtils.maskAsVec2( this.mask );

    }

    copy( source ) {

        this.mask = source.mask | 0;
        return this;

    }

}

Layers.Utils = LayersUtils;

export default Layers;