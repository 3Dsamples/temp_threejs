// file number : 127
// full path name : src/extras/lib/127_ConditionalEdgesShader.js
// description : Conditional edges shader definition rewritten as a pure ES module with zero CDN imports. Exports the canonical ConditionalEdgesShader object (uniforms + GLSL vertex/fragment source) that implements the LDraw-style conditional line technique: a line segment is discarded when its two adjacent control points lie on opposite sides of the segment normal. Integrates with the project's Color (069_Color.js), Uniform (087_Uniform.js), and UniformsGroup (088_UniformsGroup.js) modules so the shader can be fed directly into the project's material pipeline. Includes a lightweight pooled ShaderMaterial-compatible descriptor that keeps allocation-free hot paths for 10k+ edge meshes on Android 64-bit. Uses Constants (002_Constants.js) for blending and depth defaults.
// best for : Conditional line rendering on every 3D mesh, LDraw-style model outlines, anime-style edge lines, CAD wireframe overlays, and any ECS-driven living-world pipeline that needs on/off conditional edges toggled per mesh at 10k+ entity scale on Android 64-bit.
// license : MIT

import { Constants } from '../../core/002_Constants.js';
import { Common } from '../../core/003_Common.js';
import { Precision } from '../../core/004_Precision.js';
import { Vec2 } from '../../math/005_Vec2.js';
import { Vec3 } from '../../math/006_Vec3.js';
import { Vec4 } from '../../math/007_Vec4.js';
import { Mat2 } from '../../math/008_Mat2.js';
import { Mat3 } from '../../math/009_Mat3.js';
import { Mat4 } from '../../math/010_Mat4.js';
import { Quat } from '../../math/011_Quat.js';
import { Quat2 } from '../../math/012_Quat2.js';
import { SimplexNoise } from '../../math/013_SimplexNoise.js';
import { BitECS } from '../../ecs/014_BitECS.js';
import { World } from '../../ecs/015_World.js';
import { Components } from '../../ecs/016_Components.js';
import { Systems } from '../../ecs/017_Systems.js';
import { Color } from '../../core/069_Color.js';
import { Uniform } from '../../core/087_Uniform.js';
import { UniformsGroup } from '../../core/088_UniformsGroup.js';

// ---------------------------------------------------------------------------
// Static pool for ConditionalEdgesMaterial instances – recycled to eliminate
// per-mesh allocation churn when 10k+ meshes toggle conditional edges at runtime.
// ---------------------------------------------------------------------------
const _materialPool = [];

/**
 * Acquire a ConditionalEdgesMaterial from the pool (reset to default state).
 * @returns {ConditionalEdgesMaterial}
 */
function acquireMaterial() {
  const m = _materialPool.pop();
  if (m) {
    m.diffuse.setRGB(1, 1, 1);
    m.opacity = 1.0;
    m.visible = true;
    m.transparent = false;
    m.depthTest = true;
    m.depthWrite = true;
    m.blending = Constants.NormalBlending;
    m.side = Constants.FrontSide;
    m._version = 0;
    m._needsUpdate = false;
    return m;
  }
  return new ConditionalEdgesMaterial();
}

/**
 * Return a ConditionalEdgesMaterial to the pool. Caller must not use it afterward.
 * @param {ConditionalEdgesMaterial} m
 */
function releaseMaterial(m) {
  if (_materialPool.length < 64) _materialPool.push(m);
}

// ---------------------------------------------------------------------------
// GLSL source (canonical gkjohnson implementation, verbatim logic).
// The vertex shader collapses a line to c0 when d0 and d1 have opposite signs,
// which makes the rasterizer produce zero-area triangles for that segment.
// ---------------------------------------------------------------------------
const VERTEX_SHADER = /* glsl */`
  attribute vec3 control0;
  attribute vec3 control1;
  attribute vec3 direction;

  #include <common>
  #include <color_pars_vertex>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  #include <clipping_planes_pars_vertex>

  void main() {
    #include <color_vertex>

    vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mvPosition;

    // Transform the line segment ends and control points into camera clip space
    vec4 c0 = projectionMatrix * modelViewMatrix * vec4( control0, 1.0 );
    vec4 c1 = projectionMatrix * modelViewMatrix * vec4( control1, 1.0 );
    vec4 p0 = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    vec4 p1 = projectionMatrix * modelViewMatrix * vec4( position + direction, 1.0 );

    c0 /= c0.w;
    c1 /= c1.w;
    p0 /= p0.w;
    p1 /= p1.w;

    // Get the direction of the segment and an orthogonal vector
    vec2 dir = p1.xy - p0.xy;
    vec2 norm = vec2( -dir.y, dir.x );

    // Get control point directions from the line
    vec2 c0dir = c0.xy - p1.xy;
    vec2 c1dir = c1.xy - p1.xy;

    // If the vectors to the control points are pointed in different directions
    // away from the line segment then the line should not be drawn.
    float d0 = dot( normalize( norm ), normalize( c0dir ) );
    float d1 = dot( normalize( norm ), normalize( c1dir ) );

    float discardFlag = float( sign( d0 ) != sign( d1 ) );

    // Collapse the segment when the discard flag is set
    gl_Position = discardFlag > 0.5 ? c0 : gl_Position;

    #include <logdepthbuf_vertex>
    #include <clipping_planes_vertex>
    #include <fog_vertex>
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  uniform vec3 diffuse;
  uniform float opacity;

  #include <common>
  #include <color_pars_fragment>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  #include <clipping_planes_pars_fragment>

  void main() {
    #include <clipping_planes_fragment>

    vec3 outgoingLight = vec3( 0.0 );
    vec4 diffuseColor = vec4( diffuse, opacity );

    #include <logdepthbuf_fragment>
    #include <color_fragment>

    outgoingLight = diffuseColor.rgb; // simple shader
    gl_FragColor = vec4( outgoingLight, diffuseColor.a );

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
    #include <premultiplied_alpha_fragment>
  }
`;

// ---------------------------------------------------------------------------
// Canonical Shader object (matches gkjohnson's ConditionalEdgesShader).
// This is a singleton and can be safely shared by all meshes.
// ---------------------------------------------------------------------------
const _diffuseColor = new Color(0xffffff);

const ConditionalEdgesShader = {
  uniforms: {
    diffuse: { value: _diffuseColor },
    opacity: { value: 1.0 },
  },
  vertexShader: VERTEX_SHADER,
  fragmentShader: FRAGMENT_SHADER,
};

// ---------------------------------------------------------------------------
// Lightweight ShaderMaterial-compatible descriptor. Exposes only the fields
// the project's material pipeline needs, with zero CDN dependencies.
// ---------------------------------------------------------------------------
class ConditionalEdgesMaterial {
  constructor() {
    this.isConditionalEdgesMaterial = true;

    // Uniforms
    this.diffuse = new Color(0xffffff);
    this.opacity = 1.0;

    // Render state
    this.visible = true;
    this.transparent = false;
    this.depthTest = true;
    this.depthWrite = true;
    this.blending = Constants.NormalBlending;
    this.side = Constants.FrontSide;
    this.fog = true;

    // Version tracking
    this._version = 0;
    this._needsUpdate = false;

    // Cached UniformsGroup (built lazily on first access)
    this._uniformsGroup = null;
  }

  /**
   * Set the diffuse color from RGB floats.
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @returns {this}
   */
  setDiffuse(r, g, b) {
    this.diffuse.setRGB(r, g, b);
    this._version++;
    return this;
  }

  /**
   * Set the uniform opacity.
   * @param {number} value
   * @returns {this}
   */
  setOpacity(value) {
    this.opacity = Common.clamp(value, 0, 1);
    this._version++;
    return this;
  }

  /**
   * Build (or return cached) UniformsGroup for this material.
   * Uses the project's Uniform (087) and UniformsGroup (088) modules.
   * @returns {UniformsGroup}
   */
  getUniformsGroup() {
    if (this._uniformsGroup) return this._uniformsGroup;

    const group = UniformsGroup.acquire();
    group.setName('ConditionalEdgesMaterial');

    const diffuseUniform = new Uniform();
    diffuseUniform.name = 'diffuse';
    diffuseUniform.type = 'vec3';
    diffuseUniform.setValue(this.diffuse);

    const opacityUniform = new Uniform();
    opacityUniform.name = 'opacity';
    opacityUniform.type = 'float';
    opacityUniform.setValue(this.opacity);

    group.add(diffuseUniform);
    group.add(opacityUniform);

    this._uniformsGroup = group;
    return group;
  }

  /** @returns {number} */
  get version() { return this._version; }

  /** @returns {boolean} */
  get needsUpdate() { return this._needsUpdate; }

  set needsUpdate(v) {
    if (v) {
      this._version++;
      this._needsUpdate = true;
    } else {
      this._needsUpdate = false;
    }
  }

  /**
   * Copy settings from another ConditionalEdgesMaterial.
   * @param {ConditionalEdgesMaterial} source
   * @returns {this}
   */
  copy(source) {
    this.diffuse.copy(source.diffuse);
    this.opacity = source.opacity;
    this.visible = source.visible;
    this.transparent = source.transparent;
    this.depthTest = source.depthTest;
    this.depthWrite = source.depthWrite;
    this.blending = source.blending;
    this.side = source.side;
    this.fog = source.fog;
    this._version++;
    return this;
  }

  /**
   * Dispose of internal resources.
   */
  dispose() {
    if (this._uniformsGroup) {
      this._uniformsGroup.release();
      this._uniformsGroup = null;
    }
  }

  // --- Pooling ------------------------------------------------------------

  /**
   * Acquire a pooled ConditionalEdgesMaterial instance.
   * @returns {ConditionalEdgesMaterial}
   */
  static acquire() {
    return acquireMaterial();
  }

  /**
   * Return this material to the pool. Caller must not use it afterward.
   */
  release() {
    this.dispose();
    releaseMaterial(this);
  }

  /**
   * Clear the global material pool.
   */
  static clearPool() {
    _materialPool.length = 0;
  }
}

export {
  ConditionalEdgesShader,
  ConditionalEdgesMaterial,
  VERTEX_SHADER,
  FRAGMENT_SHADER,
};
export default ConditionalEdgesShader;