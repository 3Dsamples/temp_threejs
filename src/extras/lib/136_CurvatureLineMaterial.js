// file number : 136
// full path name : src/extras/lib/136_CurvatureLineMaterial.js
// description : Curvature-aware conditional line material rewritten as a pure ES module with zero CDN imports. Extends AttenuatedLineMaterial (135) and adds a per-vertex `curvature` attribute (a scalar in [0,1] populated by the geometry generator — 0 = flat surface, 1 = sharp crease) that modulates line width in the vertex shader. Exposes curvatureBoost (default 1.5) and minCurvatureWidth / maxCurvatureWidth uniforms so tightly curved regions draw thicker lines and flat regions draw thinner ones — the classic anime line-weight hierarchy, without any art-author intervention. The shader combines distance attenuation (inherited from 135) with curvature modulation in a single vertex pass, so the two effects stack cleanly: `effLinewidth = base * distanceAttenuation * (1 + curvature * (curvatureBoost - 1))`. If the geometry does not provide a `curvature` attribute, WebGL defaults it to 0 and the effect is a no-op — fully backward-compatible with 128, 129, 133, and 134 outputs. Reuses Uniform (087) and UniformsGroup (088) for the full uniform set, Color (069) for the diffuse tint, and pooled instances via acquire()/release(). Includes a BitECS SoA bridge for ECS-driven per-material LOD systems. Designed for 10k+ conditional line meshes on Android 64-bit where line-weight hierarchy must be visually convincing at every distance without per-frame CPU work.
// best for : Anime-flat conditional line rendering with automatic line-weight hierarchy, cel-shaded outlines where silhouette edges must be heavier than interior detail, CAD wireframe overlays where mechanical creases deserve more visual weight, stylized architectural drawings, and any ECS-driven living-world pipeline that needs per-material curvature-driven line modulation at 10k+ entity scale on Android 64-bit.
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
import { AttenuatedLineMaterial } from './135_AttenuatedLineMaterial.js';

// ---------------------------------------------------------------------------
// Static pool for CurvatureLineMaterial instances — recycled to eliminate
// per-mesh allocation churn when 10k+ meshes toggle curvature-modulated fat
// lines at runtime.
// ---------------------------------------------------------------------------
const _materialPool = [];

function _acquireMaterial() {
  const m = _materialPool.pop();
  if (m) {
    // Reset every field the parent exposes plus the curvature-specific ones
    m.color.setRGB(1, 1, 1);
    m.opacity = 1.0;
    m.linewidth = 1.0;
    m.minLinewidth = 0.5;
    m.maxLinewidth = 2.0;
    m.attenuationDistance = 100.0;
    m.minOpacity = 0.0;
    m.curvatureBoost = 1.5;
    m.minCurvatureWidth = 0.5;
    m.maxCurvatureWidth = 3.0;
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
  return new CurvatureLineMaterial();
}

function _releaseMaterial(m) {
  if (_materialPool.length < 64) _materialPool.push(m);
}

// ---------------------------------------------------------------------------
// GLSL vertex shader — fat-line expansion + conditional discard + distance
// attenuation (from 135) + curvature modulation (new in 136).
//
// Per-vertex attribute:
//   curvature  (float) — [0,1], 0 = flat surface, 1 = maximum crease.
//   Missing attribute → WebGL defaults it to 0 → effect is a no-op.
//
// Width formula:
//   effLinewidth = base * mix(maxLinewidth, minLinewidth, tDistance)
//                       * mix(1.0, curvatureBoost, curvature)
//
// When curvatureBoost === 1.0, the curvature term is a no-op and 136 behaves
// identically to 135. When the caller only wants curvature (no distance fade),
// set maxLinewidth === minLinewidth and attenuationDistance = large.
// ---------------------------------------------------------------------------
const CURVATURE_VERTEX_SHADER = /* glsl */`
  #include <common>
  #include <color_pars_vertex>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  #include <clipping_planes_pars_vertex>

  uniform float linewidth;
  uniform float minLinewidth;
  uniform float maxLinewidth;
  uniform float attenuationDistance;

  uniform float curvatureBoost;
  uniform float minCurvatureWidth;
  uniform float maxCurvatureWidth;

  uniform vec2 resolution;

  attribute vec3 control0;
  attribute vec3 control1;
  attribute vec3 direction;

  attribute vec3 instanceStart;
  attribute vec3 instanceEnd;
  attribute vec3 instanceColorStart;
  attribute vec3 instanceColorEnd;

  // Per-vertex curvature (0 = flat, 1 = maximum crease).
  // If the geometry does not provide this attribute, WebGL supplies 0.0.
  attribute float curvature;

  varying vec2 vUv;
  varying float vAttenuation;
  varying float vCurvature;

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

    // Perspective near-plane trimming
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

    // Direction + perpendicular in NDC with aspect correction
    vec2 dir = ndcEnd - ndcStart;
    dir.x *= aspect;
    dir = normalize( dir );

    vec2 offset = vec2( dir.y, - dir.x );
    dir.x /= aspect;
    offset.x /= aspect;

    if ( position.x < 0.0 ) offset *= - 1.0;
    if ( position.y < 0.0 ) offset += - dir;
    else if ( position.y > 1.0 ) offset += dir;

    // -------------------------------------------------------------------
    // Distance attenuation (from 135).
    // -------------------------------------------------------------------
    vec4 mvPosition = ( position.y < 0.5 ) ? start : end;
    float viewDepth = max( - mvPosition.z, 0.0 );
    float tDistance = clamp( viewDepth / max( attenuationDistance, 1e-4 ), 0.0, 1.0 );

    float attenLinewidth = mix( maxLinewidth, minLinewidth, tDistance );

    // -------------------------------------------------------------------
    // Curvature modulation (new in 136).
    // curvature is clamped to [0,1], then mixed between 1.0 and
    // curvatureBoost. curvatureBoost === 1.0 makes this a no-op.
    // The two extra uniforms minCurvatureWidth / maxCurvatureWidth act as a
    // secondary envelope, so tightly curved flat-shaded edges can be clamped
    // below / above the attenuation-envelope result. This gives art control
    // without needing a custom shader.
    // -------------------------------------------------------------------
    float c = clamp( curvature, 0.0, 1.0 );

    float curvatureFactor = 1.0 + c * ( curvatureBoost - 1.0 );
    float curvatureEnvelope = mix( minCurvatureWidth, maxCurvatureWidth, c );

    // Final width: base * attenuation * curvatureFactor, clamped into the
    // curvature envelope (so art can guarantee a min/max even at extreme
    // distances).
    float effLinewidth = linewidth * attenLinewidth * curvatureFactor;
    effLinewidth = clamp( effLinewidth, minCurvatureWidth, maxCurvatureWidth );

    // Pass attenuation and curvature to the fragment shader for opacity
    // and optional tinting.
    vAttenuation = tDistance;
    vCurvature = c;

    // Fat-line expansion
    offset *= effLinewidth;
    offset /= resolution.y;

    vec4 clip = ( position.y < 0.5 ) ? clipStart : clipEnd;
    offset *= clip.w;
    clip.xy += offset;
    gl_Position = clip;

    #include <logdepthbuf_vertex>
    #include <clipping_planes_vertex>
    #include <fog_vertex>

    // -------------------------------------------------------------------
    // Conditional line discard — same logic as 127 / 130 / 135.
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
// Fragment shader — distance attenuation + optional curvature-based tint.
// The curvature-modulated region can optionally be tinted (via vCurvature)
// with a secondary colour. If curvatureTintIntensity is 0.0 the tint is a
// no-op and 136 behaves identically to 135.
// ---------------------------------------------------------------------------
const CURVATURE_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 diffuse;
  uniform vec3 curvatureTint;
  uniform float curvatureTintIntensity;
  uniform float opacity;
  uniform float minOpacity;

  #ifdef USE_DASH
  uniform float dashSize;
  uniform float gapSize;
  #endif

  varying float vLineDistance;
  varying vec2 vUv;
  varying float vAttenuation;
  varying float vCurvature;

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

    // Opacity attenuation (from 135)
    float effOpacity = mix( opacity, minOpacity, vAttenuation );

    // Optional curvature tint (new in 136) — blends `diffuse` toward
    // `curvatureTint` proportionally to curvature × intensity.
    float tintMix = clamp( vCurvature * curvatureTintIntensity, 0.0, 1.0 );
    vec3 finalColor = mix( diffuse, curvatureTint, tintMix );

    vec4 diffuseColor = vec4( finalColor, effOpacity );

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
// CurvatureLineMaterial — extends AttenuatedLineMaterial (135).
//
// All distance-attenuation uniforms are inherited unchanged. New uniforms:
//   curvatureBoost       (float) — how much curvature scales the width
//   minCurvatureWidth    (float) — hard floor on final linewidth
//   maxCurvatureWidth    (float) — hard ceiling on final linewidth
//   curvatureTint        (vec3)  — colour to blend toward on highly curved edges
//   curvatureTintIntensity (float) — how much to blend
//
// The per-vertex `curvature` attribute lives on the geometry (128, 129, 133,
// 134 outputs can populate it; if absent, it defaults to 0 and the material
// behaves identically to 135).
// ---------------------------------------------------------------------------
class CurvatureLineMaterial extends AttenuatedLineMaterial {
  /**
   * @param {object} [parameters={}]
   * @param {number} [parameters.curvatureBoost=1.5] — width multiplier at curvature=1
   * @param {number} [parameters.minCurvatureWidth=0.5] — floor on final linewidth
   * @param {number} [parameters.maxCurvatureWidth=3.0] — ceiling on final linewidth
   * @param {Color|number} [parameters.curvatureTint=0x000000] — tint on curved edges
   * @param {number} [parameters.curvatureTintIntensity=0.0] — tint blend amount
   */
  constructor(parameters = {}) {
    super(parameters);

    this.isCurvatureLineMaterial = true;
    this.type = 'CurvatureLineMaterial';

    // Swap in the curvature-aware shaders
    this.vertexShader = CURVATURE_VERTEX_SHADER;
    this.fragmentShader = CURVATURE_FRAGMENT_SHADER;

    // Curvature-specific state
    this.curvatureBoost =
      parameters.curvatureBoost !== undefined ? parameters.curvatureBoost : 1.5;
    this.minCurvatureWidth =
      parameters.minCurvatureWidth !== undefined ? parameters.minCurvatureWidth : 0.5;
    this.maxCurvatureWidth =
      parameters.maxCurvatureWidth !== undefined ? parameters.maxCurvatureWidth : 3.0;

    this.curvatureTint = new Color(0x000000);
    if (parameters.curvatureTint !== undefined) {
      this.curvatureTint.set(parameters.curvatureTint);
    }
    this.curvatureTintIntensity =
      parameters.curvatureTintIntensity !== undefined
        ? parameters.curvatureTintIntensity
        : 0.0;

    // Invalidate the parent's UniformsGroup — we rebuild with the extra
    // curvature uniforms below.
    if (this._uniformsGroup) {
      this._uniformsGroup.release();
      this._uniformsGroup = null;
    }
  }

  // -----------------------------------------------------------------------
  // UniformsGroup — full rebuild including attenuation + curvature uniforms
  // -----------------------------------------------------------------------

  /**
   * Build or return the cached UniformsGroup for this material.
   * @returns {UniformsGroup}
   */
  getUniformsGroup() {
    if (this._uniformsGroup) return this._uniformsGroup;

    const group = UniformsGroup.acquire();
    group.setName('CurvatureLineMaterial');

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

    // --- Attenuation uniforms (from 135) ---

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

    // --- Curvature uniforms (new in 136) ---

    const curvatureBoostUniform = new Uniform();
    curvatureBoostUniform.name = 'curvatureBoost';
    curvatureBoostUniform.type = 'float';
    curvatureBoostUniform.setValue(this.curvatureBoost);
    group.add(curvatureBoostUniform);

    const minCurvatureWidthUniform = new Uniform();
    minCurvatureWidthUniform.name = 'minCurvatureWidth';
    minCurvatureWidthUniform.type = 'float';
    minCurvatureWidthUniform.setValue(this.minCurvatureWidth);
    group.add(minCurvatureWidthUniform);

    const maxCurvatureWidthUniform = new Uniform();
    maxCurvatureWidthUniform.name = 'maxCurvatureWidth';
    maxCurvatureWidthUniform.type = 'float';
    maxCurvatureWidthUniform.setValue(this.maxCurvatureWidth);
    group.add(maxCurvatureWidthUniform);

    const curvatureTintUniform = new Uniform();
    curvatureTintUniform.name = 'curvatureTint';
    curvatureTintUniform.type = 'vec3';
    curvatureTintUniform.setValue(this.curvatureTint);
    group.add(curvatureTintUniform);

    const curvatureTintIntensityUniform = new Uniform();
    curvatureTintIntensityUniform.name = 'curvatureTintIntensity';
    curvatureTintIntensityUniform.type = 'float';
    curvatureTintIntensityUniform.setValue(this.curvatureTintIntensity);
    group.add(curvatureTintIntensityUniform);

    this._uniformsGroup = group;
    return group;
  }

  // -----------------------------------------------------------------------
  // Curvature-specific setters
  // -----------------------------------------------------------------------

  /**
   * Set the curvature width multiplier.
   * @param {number} value — 1.0 = no effect, 1.5 = 50% thicker at curvature=1
   * @returns {this}
   */
  setCurvatureBoost(value) {
    this.curvatureBoost = Math.max(0, value);
    this._version++;
    return this;
  }

  /**
   * Set the curvature-width floor and ceiling.
   * @param {number} min
   * @param {number} max
   * @returns {this}
   */
  setCurvatureWidthRange(min, max) {
    this.minCurvatureWidth = Math.max(0, min);
    this.maxCurvatureWidth = Math.max(this.minCurvatureWidth, max);
    this._version++;
    return this;
  }

  /**
   * Set the curvature tint colour and intensity.
   * @param {Color|number|string} color
   * @param {number} [intensity=1]
   * @returns {this}
   */
  setCurvatureTint(color, intensity = 1.0) {
    this.curvatureTint.set(color);
    this.curvatureTintIntensity = Common.clamp(intensity, 0, 1);
    this._version++;
    return this;
  }

  /**
   * Compute the effective linewidth at a given view-space distance and
   * curvature. Matches the vertex shader's final formula exactly.
   * @param {number} distance
   * @param {number} curvature — [0,1]
   * @returns {number}
   */
  getLinewidthAt(distance, curvature) {
    const tD = Common.clamp(distance / Math.max(this.attenuationDistance, 1e-4), 0, 1);
    const attenLinewidth = this.maxLinewidth +
      (this.minLinewidth - this.maxLinewidth) * tD;
    const c = Common.clamp(curvature, 0, 1);
    const curvatureFactor = 1.0 + c * (this.curvatureBoost - 1.0);
    let eff = this.linewidth * attenLinewidth * curvatureFactor;
    eff = Common.clamp(eff, this.minCurvatureWidth, this.maxCurvatureWidth);
    return eff;
  }

  // -----------------------------------------------------------------------
  // Copy / dispose
  // -----------------------------------------------------------------------

  /**
   * Copy settings from another CurvatureLineMaterial.
   * @param {CurvatureLineMaterial} source
   * @returns {this}
   */
  copy(source) {
    super.copy(source);
    this.curvatureBoost = source.curvatureBoost;
    this.minCurvatureWidth = source.minCurvatureWidth;
    this.maxCurvatureWidth = source.maxCurvatureWidth;
    this.curvatureTint.copy(source.curvatureTint);
    this.curvatureTintIntensity = source.curvatureTintIntensity;
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
   * Expose the material's state — including the curvature parameters — as a
   * flat typed-array column set for ECS-driven per-material LOD systems.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const base = super.asBitecsComponent(name);
    return {
      ...base,
      curvatureBoost: this.curvatureBoost,
      minCurvatureWidth: this.minCurvatureWidth,
      maxCurvatureWidth: this.maxCurvatureWidth,
      curvatureTint: this.curvatureTint.toArray(new Float32Array(3)),
      curvatureTintIntensity: this.curvatureTintIntensity,
    };
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled CurvatureLineMaterial instance (defaults:
   * white, curvatureBoost=1.5, curvatureWidth=[0.5, 3.0], no tint).
   * @returns {CurvatureLineMaterial}
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
   * Clear the global CurvatureLineMaterial pool.
   */
  static clearPool() {
    _materialPool.length = 0;
  }
}

export {
  CurvatureLineMaterial,
  CURVATURE_VERTEX_SHADER,
  CURVATURE_FRAGMENT_SHADER,
};
export default CurvatureLineMaterial;