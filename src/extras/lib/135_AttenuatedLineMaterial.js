// file number : 135
// full path name : src/extras/lib/135_AttenuatedLineMaterial.js
// description : Distance-attenuated conditional line material rewritten as a pure ES module with zero CDN imports. Extends ConditionalLineMaterial (130) and adds GPU-side width and opacity attenuation via minLinewidth, maxLinewidth, attenuationDistance, and minOpacity uniforms. The vertex shader computes `t = clamp(-mvPosition.z / attenuationDistance, 0, 1)` and interpolates linewidth from maxLinewidth (near) to minLinewidth (far), and opacity from opacity (near) to minOpacity (far), so distant conditional lines fade smoothly instead of staying at a constant screen-space thickness. Zero per-frame JS cost — all attenuation happens in the GPU. Reuses UniformsGroup (088) and Uniform (087) for the full uniform set, Colour (069) for the diffuse tint, and pooled instances via acquire()/release(). Includes a BitECS SoA bridge exposing the attenuation parameters for ECS-driven LOD systems. Designed for 10k+ conditional line meshes on Android 64-bit where distant outlines must not visually overpower near geometry, matching the LOD-aware line hierarchy used in anime and CAD renderers.
// best for : Conditional lines on 10k+ meshes where distant outlines must thin and fade, anime/cel outlines with depth-based weight hierarchy, CAD wireframe overlays with LOD-aware line widths, large open worlds where sub-pixel line density would otherwise shimmer, and any ECS-driven living-world pipeline that needs per-material LOD-driven line attenuation at 10k+ entity scale on Android 64-bit.
// license : MIT — shader ported from gkjohnson/threejs-sandbox (conditional-lines)

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
import { ConditionalLineMaterial } from './130_ConditionalLineMaterial.js';

// ---------------------------------------------------------------------------
// Static pool for AttenuatedLineMaterial instances — recycled to eliminate
// per-mesh allocation churn when 10k+ meshes toggle attenuated fat lines.
// ---------------------------------------------------------------------------
const _materialPool = [];

function _acquireMaterial() {
  const m = _materialPool.pop();
  if (m) {
    m.color.setRGB(1, 1, 1);
    m.opacity = 1.0;
    m.linewidth = 1.0;
    m.minLinewidth = 0.5;
    m.maxLinewidth = 2.0;
    m.attenuationDistance = 100.0;
    m.minOpacity = 0.0;
    m.dashed = false;
    m.dashScale = 1.0;
    m.dashSize = 1.0;
    m.gapSize = 1.0;
    m.resolution[0] = 1;
    m.resolution[1] = 1;
    m.visible = true;
    m.transparent = false;
    m.depthTest = true;
    m.depthWrite = true;
    m.blending = Constants.NormalBlending;
    m.side = Constants.FrontSide;
    m.fog = true;
    m.worldUnits = false;
    m._version = 0;
    m._needsUpdate = false;
    if (m._uniformsGroup) {
      m._uniformsGroup.release();
      m._uniformsGroup = null;
    }
    return m;
  }
  return new AttenuatedLineMaterial();
}

function _releaseMaterial(m) {
  if (_materialPool.length < 64) _materialPool.push(m);
}

// ---------------------------------------------------------------------------
// GLSL vertex shader — fat-line expansion + conditional discard + attenuation.
// Adds two new uniforms (minLinewidth, maxLinewidth, attenuationDistance) and
// mixes linewidth based on the current view-space distance. Uses the same
// screen-space fat-line math as 130, with the attenuation applied just
// before the offset is scaled.
// ---------------------------------------------------------------------------
const ATTENUATED_VERTEX_SHADER = /* glsl */`
  #include <common>
  #include <color_pars_vertex>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  #include <clipping_planes_pars_vertex>

  uniform float linewidth;
  uniform float minLinewidth;
  uniform float maxLinewidth;
  uniform float attenuationDistance;
  uniform vec2 resolution;

  attribute vec3 control0;
  attribute vec3 control1;
  attribute vec3 direction;

  attribute vec3 instanceStart;
  attribute vec3 instanceEnd;
  attribute vec3 instanceColorStart;
  attribute vec3 instanceColorEnd;

  varying vec2 vUv;
  varying float vAttenuation;

  #ifdef USE_DASH
  uniform float dashScale;
  attribute float instanceDistanceStart;
  attribute float instanceDistanceEnd;
  varying float vLineDistance;
  #endif

  void trimSegment( const in vec4 start, inout vec4 end ) {
    float a = projectionMatrix[ 2 ][ 2 ];
    float b = projectionMatrix[ 3 ][ 2 ];
    float nearEstimate = - 0.5 * b / a;
    float alpha = ( nearEstimate - start.z ) / ( end.z - start.z );
    end.xyz = mix( start.xyz, end.xyz, alpha );
  }

  void main() {
    #ifdef USE_COLOR
    vColor.xyz = ( position.y < 0.5 ) ? instanceColorStart : instanceColorEnd;
    #endif

    #ifdef USE_DASH
    vLineDistance = ( position.y < 0.5 ) ?
      dashScale * instanceDistanceStart :
      dashScale * instanceDistanceEnd;
    #endif

    float aspect = resolution.x / resolution.y;
    vUv = uv;

    // Camera-space endpoints
    vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );
    vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );

    // Perspective-project segment trimming near the camera plane
    bool perspective = ( projectionMatrix[ 2 ][ 3 ] == - 1.0 );
    if ( perspective ) {
      if ( start.z < 0.0 && end.z >= 0.0 ) trimSegment( start, end );
      else if ( end.z < 0.0 && start.z >= 0.0 ) trimSegment( end, start );
    }

    // Clip-space endpoints
    vec4 clipStart = projectionMatrix * start;
    vec4 clipEnd = projectionMatrix * end;

    // NDC-space endpoints
    vec2 ndcStart = clipStart.xy / clipStart.w;
    vec2 ndcEnd = clipEnd.xy / clipEnd.w;

    // Direction
    vec2 dir = ndcEnd - ndcStart;
    dir.x *= aspect;
    dir = normalize( dir );

    // Perpendicular to direction
    vec2 offset = vec2( dir.y, - dir.x );
    dir.x /= aspect;
    offset.x /= aspect;

    // Sign flip
    if ( position.x < 0.0 ) offset *= - 1.0;

    // Endcaps
    if ( position.y < 0.0 ) offset += - dir;
    else if ( position.y > 1.0 ) offset += dir;

    // -------------------------------------------------------------------
    // Distance-based attenuation.
    // view-space depth is -(mvPosition.z); attenuation t goes 0 (near) → 1 (far).
    // -------------------------------------------------------------------
    vec4 mvPosition = ( position.y < 0.5 ) ? start : end;
    float viewDepth = max( - mvPosition.z, 0.0 );
    float t = clamp( viewDepth / max( attenuationDistance, 1e-4 ), 0.0, 1.0 );

    // Effective linewidth: near = maxLinewidth, far = minLinewidth
    float effLinewidth = mix( maxLinewidth, minLinewidth, t );
    // Also clamp by the material base `linewidth` so callers can still scale the whole envelope
    effLinewidth *= linewidth;

    // Pass attenuation factor for opacity mixing in the fragment shader
    vAttenuation = t;

    // Adjust for linewidth + clip-space → screen-space
    offset *= effLinewidth;
    offset /= resolution.y;

    // Select endpoint
    vec4 clip = ( position.y < 0.5 ) ? clipStart : clipEnd;

    // Back to clip space
    offset *= clip.w;
    clip.xy += offset;
    gl_Position = clip;

    #include <logdepthbuf_vertex>
    #include <clipping_planes_vertex>
    #include <fog_vertex>

    // -------------------------------------------------------------------
    // Conditional line discard — identical logic to 130.
    // Collapse the segment when control0 and control1 sit on opposite sides
    // of the segment's perpendicular.
    // -------------------------------------------------------------------
    vec4 c0 = projectionMatrix * modelViewMatrix * vec4( control0, 1.0 );
    vec4 c1 = projectionMatrix * modelViewMatrix * vec4( control1, 1.0 );
    vec4 p0 = projectionMatrix * modelViewMatrix * vec4( instanceStart, 1.0 );
    vec4 p1 = projectionMatrix * modelViewMatrix * vec4( instanceStart + direction, 1.0 );

    c0 /= c0.w;
    c1 /= c1.w;
    p0 /= p0.w;
    p1 /= p1.w;

    vec2 segDir = p1.xy - p0.xy;
    vec2 norm = vec2( - segDir.y, segDir.x );

    vec2 c0dir = c0.xy - p1.xy;
    vec2 c1dir = c1.xy - p1.xy;

    float d0 = dot( normalize( norm ), normalize( c0dir ) );
    float d1 = dot( normalize( norm ), normalize( c1dir ) );

    float discardFlag = float( sign( d0 ) != sign( d1 ) );
    gl_Position = discardFlag > 0.5 ? c0 : gl_Position;
  }
`;

// ---------------------------------------------------------------------------
// GLSL fragment shader — mixes opacity from base `opacity` (near) to
// `minOpacity` (far), using vAttenuation from the vertex shader.
// ---------------------------------------------------------------------------
const ATTENUATED_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 diffuse;
  uniform float opacity;
  uniform float minOpacity;

  #ifdef USE_DASH
  uniform float dashSize;
  uniform float gapSize;
  #endif

  varying float vLineDistance;
  varying vec2 vUv;
  varying float vAttenuation;

  #include <common>
  #include <color_pars_fragment>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  #include <clipping_planes_pars_fragment>

  void main() {
    #include <clipping_planes_fragment>

    #ifdef USE_DASH
    if ( vUv.y < - 1.0 || vUv.y > 1.0 ) discard;
    if ( mod( vLineDistance, dashSize + gapSize ) > dashSize ) discard;
    #endif

    if ( abs( vUv.y ) > 1.0 ) {
      float a = vUv.x;
      float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
      float len2 = a * a + b * b;
      if ( len2 > 1.0 ) discard;
    }

    // Opacity attenuation: near = opacity, far = minOpacity
    float effOpacity = mix( opacity, minOpacity, vAttenuation );

    vec4 diffuseColor = vec4( diffuse, effOpacity );

    #include <logdepthbuf_fragment>
    #include <color_fragment>

    gl_FragColor = vec4( diffuseColor.rgb, diffuseColor.a );

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
    #include <premultiplied_alpha_fragment>
  }
`;

// ---------------------------------------------------------------------------
// AttenuatedLineMaterial — extends ConditionalLineMaterial (130) with
// distance-driven width and opacity attenuation.
// ---------------------------------------------------------------------------
class AttenuatedLineMaterial extends ConditionalLineMaterial {
  /**
   * @param {object} [parameters={}]
   * @param {number} [parameters.minLinewidth=0.5] — line width at attenuationDistance
   * @param {number} [parameters.maxLinewidth=2.0] — line width when near
   * @param {number} [parameters.attenuationDistance=100] — distance over which
   *   the linewidth and opacity fully attenuate from their near values
   * @param {number} [parameters.minOpacity=0.0] — opacity at attenuationDistance
   */
  constructor(parameters = {}) {
    super(parameters);

    this.isAttenuatedLineMaterial = true;
    this.type = 'AttenuatedLineMaterial';

    // Override shaders with the attenuated variants
    this.vertexShader = ATTENUATED_VERTEX_SHADER;
    this.fragmentShader = ATTENUATED_FRAGMENT_SHADER;

    // Attenuation parameters (initialised from parameters or defaults)
    this.minLinewidth = parameters.minLinewidth !== undefined ? parameters.minLinewidth : 0.5;
    this.maxLinewidth = parameters.maxLinewidth !== undefined ? parameters.maxLinewidth : 2.0;
    this.attenuationDistance = parameters.attenuationDistance !== undefined ? parameters.attenuationDistance : 100.0;
    this.minOpacity = parameters.minOpacity !== undefined ? parameters.minOpacity : 0.0;

    // Invalidate the parent's cached UniformsGroup — we rebuild with the
    // attenuation uniforms below.
    if (this._uniformsGroup) {
      this._uniformsGroup.release();
      this._uniformsGroup = null;
    }
  }

  // -----------------------------------------------------------------------
  // UniformsGroup — full rebuild with the attenuation uniforms added
  // -----------------------------------------------------------------------

  /**
   * Build or return the cached UniformsGroup for this material.
   * Exposes all base conditional-line uniforms plus the four new attenuation
   * uniforms.
   *
   * @returns {UniformsGroup}
   */
  getUniformsGroup() {
    if (this._uniformsGroup) return this._uniformsGroup;

    const group = UniformsGroup.acquire();
    group.setName('AttenuatedLineMaterial');

    // --- Base conditional-line uniforms (mirrors 130) ---

    const diffuseUniform = new Uniform();
    diffuseUniform.name = 'diffuse';
    diffuseUniform.type = 'vec3';
    diffuseUniform.setValue(this.color);
    group.add(diffuseUniform);

    const opacityUniform = new Uniform();
    opacityUniform.name = 'opacity';
    opacityUniform.type = 'float';
    opacityUniform.setValue(this.opacity);
    group.add(opacityUniform);

    const linewidthUniform = new Uniform();
    linewidthUniform.name = 'linewidth';
    linewidthUniform.type = 'float';
    linewidthUniform.setValue(this.linewidth);
    group.add(linewidthUniform);

    const resolutionUniform = new Uniform();
    resolutionUniform.name = 'resolution';
    resolutionUniform.type = 'vec2';
    resolutionUniform.setValue(this.resolution);
    group.add(resolutionUniform);

    const dashScaleUniform = new Uniform();
    dashScaleUniform.name = 'dashScale';
    dashScaleUniform.type = 'float';
    dashScaleUniform.setValue(this.dashScale);
    group.add(dashScaleUniform);

    const dashSizeUniform = new Uniform();
    dashSizeUniform.name = 'dashSize';
    dashSizeUniform.type = 'float';
    dashSizeUniform.setValue(this.dashSize);
    group.add(dashSizeUniform);

    const gapSizeUniform = new Uniform();
    gapSizeUniform.name = 'gapSize';
    gapSizeUniform.type = 'float';
    gapSizeUniform.setValue(this.gapSize);
    group.add(gapSizeUniform);

    // --- Attenuation uniforms (new in 135) ---

    const minLinewidthUniform = new Uniform();
    minLinewidthUniform.name = 'minLinewidth';
    minLinewidthUniform.type = 'float';
    minLinewidthUniform.setValue(this.minLinewidth);
    group.add(minLinewidthUniform);

    const maxLinewidthUniform = new Uniform();
    maxLinewidthUniform.name = 'maxLinewidth';
    maxLinewidthUniform.type = 'float';
    maxLinewidthUniform.setValue(this.maxLinewidth);
    group.add(maxLinewidthUniform);

    const attenuationDistanceUniform = new Uniform();
    attenuationDistanceUniform.name = 'attenuationDistance';
    attenuationDistanceUniform.type = 'float';
    attenuationDistanceUniform.setValue(this.attenuationDistance);
    group.add(attenuationDistanceUniform);

    const minOpacityUniform = new Uniform();
    minOpacityUniform.name = 'minOpacity';
    minOpacityUniform.type = 'float';
    minOpacityUniform.setValue(this.minOpacity);
    group.add(minOpacityUniform);

    this._uniformsGroup = group;
    return group;
  }

  // -----------------------------------------------------------------------
  // Attenuation setters (convenience — each setter invalidates the cache)
  // -----------------------------------------------------------------------

  /**
   * Set the line width at attenuationDistance (far).
   * @param {number} value
   * @returns {this}
   */
  setMinLinewidth(value) {
    this.minLinewidth = Math.max(0, value);
    this._version++;
    return this;
  }

  /**
   * Set the line width when near.
   * @param {number} value
   * @returns {this}
   */
  setMaxLinewidth(value) {
    this.maxLinewidth = Math.max(0, value);
    this._version++;
    return this;
  }

  /**
   * Set the distance over which attenuation happens.
   * @param {number} value
   * @returns {this}
   */
  setAttenuationDistance(value) {
    this.attenuationDistance = Math.max(1e-4, value);
    this._version++;
    return this;
  }

  /**
   * Set the opacity at attenuationDistance (far).
   * @param {number} value
   * @returns {this}
   */
  setMinOpacity(value) {
    this.minOpacity = Common.clamp(value, 0, 1);
    this._version++;
    return this;
  }

  /**
   * Compute the effective linewidth at a given view-space distance.
   * Matches the vertex shader's `mix(maxLinewidth, minLinewidth, t)` formula.
   * @param {number} distance
   * @returns {number}
   */
  getLinewidthAtDistance(distance) {
    const t = Common.clamp(distance / Math.max(this.attenuationDistance, 1e-4), 0, 1);
    return Common.lerp
      ? Common.lerp(this.maxLinewidth, this.minLinewidth, t)
      : this.maxLinewidth + (this.minLinewidth - this.maxLinewidth) * t;
  }

  /**
   * Compute the effective opacity at a given view-space distance.
   * Matches the fragment shader's `mix(opacity, minOpacity, t)` formula.
   * @param {number} distance
   * @returns {number}
   */
  getOpacityAtDistance(distance) {
    const t = Common.clamp(distance / Math.max(this.attenuationDistance, 1e-4), 0, 1);
    return this.opacity + (this.minOpacity - this.opacity) * t;
  }

  // -----------------------------------------------------------------------
  // Copy / dispose
  // -----------------------------------------------------------------------

  /**
   * Copy settings from another AttenuatedLineMaterial.
   * @param {AttenuatedLineMaterial} source
   * @returns {this}
   */
  copy(source) {
    super.copy(source);
    this.minLinewidth = source.minLinewidth;
    this.maxLinewidth = source.maxLinewidth;
    this.attenuationDistance = source.attenuationDistance;
    this.minOpacity = source.minOpacity;
    this._version++;
    return this;
  }

  dispose() {
    super.dispose();
    if (this._uniformsGroup) {
      this._uniformsGroup.release();
      this._uniformsGroup = null;
    }
  }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose the material's state — including the attenuation parameters — as
   * a flat typed-array column set for ECS-driven per-material LOD systems.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const base = super.asBitecsComponent(name);
    return {
      ...base,
      minLinewidth: this.minLinewidth,
      maxLinewidth: this.maxLinewidth,
      attenuationDistance: this.attenuationDistance,
      minOpacity: this.minOpacity,
    };
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled AttenuatedLineMaterial instance (defaults:
   * white, maxLinewidth=2, minLinewidth=0.5, attenuationDistance=100,
   * minOpacity=0).
   * @returns {AttenuatedLineMaterial}
   */
  static acquire() {
    return _acquireMaterial();
  }

  /**
   * Return this material to the pool. Caller must not use it afterward.
   */
  release() {
    this.dispose();
    _releaseMaterial(this);
  }

  /**
   * Clear the global AttenuatedLineMaterial pool.
   */
  static clearPool() {
    _materialPool.length = 0;
  }
}

export {
  AttenuatedLineMaterial,
  ATTENUATED_VERTEX_SHADER,
  ATTENUATED_FRAGMENT_SHADER,
};
export default AttenuatedLineMaterial;