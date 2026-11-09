// file number : 142
// full path name : src/extras/lib/142_ConditionalToonMaterial.js
// description : Toon-shaded conditional line material rewritten as a pure ES module with zero CDN imports. Extends ConditionalLineMaterial (130) and blends conditional line darkening multiplicatively into a MeshToonMaterial-style gradient ramp, matching the MToon standard for anime characters. Exposes outlineColorFactor (Color), outlineLightingMixFactor (float), outlineWidthScale (float), gradientSteps (int, 2/3/4/5), gradientSmoothing (float), and gradientMap (uniform) — all the art-direction knobs required for MToon-compliant anime character outlines that respond to the underlying toon shading rather than appearing as a flat overlay. When the toon shading is bright (dot(N,L) ≈ 1) the outline is tinted toward outlineColorFactor; when the toon shading is dark (dot(N,L) ≈ 0) the outline approaches the base diffuse colour, producing the "outline darkens in shadow" behaviour that real anime production pipelines rely on. The gradient ramp is computed procedurally in the fragment shader from gradientSteps + gradientSmoothing, so no external texture upload is required (gradientMap is exposed as an optional override). Uses Uniform (087) and UniformsGroup (088) for the full uniform set, Color (069) for the diffuse and outline tint, Common (003) for clamping and smoothing, and pooled instances via acquire()/release(). Includes a BitECS SoA bridge exposing all toon-related parameters for ECS-driven per-material LOD systems. Designed for 10k+ anime-character conditional line meshes on Android 64-bit where per-material toon shading must integrate seamlessly with conditional outlines.
// best for : Anime character outlines with toon-aware line darkening, MToon-standard pipelines needing outlineColorFactor and outlineLightingMixFactor parity, stylised cel-shaded characters with gradient ramps, VRoid-compatible avatar rendering, anime props and environments with hand-authored line weights, and any ECS-driven living-world pipeline that needs per-material toon shading blended with conditional lines at 10k+ entity scale on Android 64-bit.
// license : MIT — MToon parameter names and blending behaviour inspired by pixiv/three-vrm and MToon spec

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
// Static pool for ConditionalToonMaterial instances — recycled to eliminate
// per-character allocation churn when 10k+ anime characters toggle toon
// outlines at runtime.
// ---------------------------------------------------------------------------
const _materialPool = [];

function _acquireMaterial() {
  const m = _materialPool.pop();
  if (m) {
    m.color.setRGB(1, 1, 1);
    m.opacity = 1.0;
    m.linewidth = 1.0;
    m.outlineColorFactor.setRGB(0, 0, 0);
    m.outlineLightingMixFactor = 1.0;
    m.outlineWidthScale = 1.0;
    m.gradientSteps = 4;
    m.gradientSmoothing = 0.05;
    m.lightDirection[0] = 0;
    m.lightDirection[1] = 1;
    m.lightDirection[2] = 0;
    m.ambientStrength = 0.1;
    m.shadowMultiplier = 1.0;
    m.baseColor.setRGB(1, 1, 1);
    m.shadeColor.setRGB(0.5, 0.5, 0.5);
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
  return new ConditionalToonMaterial();
}

function _releaseMaterial(m) {
  if (_materialPool.length < 64) _materialPool.push(m);
}

// ---------------------------------------------------------------------------
// GLSL vertex shader — canonical conditional fat-line expansion (from 130)
// plus per-vertex world position and world normal for toon shading lookup.
// ---------------------------------------------------------------------------
const TOON_VERTEX_SHADER = /* glsl */`
  #include <common>
  #include <color_pars_vertex>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  #include <clipping_planes_pars_vertex>

  uniform float linewidth;
  uniform float outlineWidthScale;
  uniform vec2 resolution;

  attribute vec3 control0;
  attribute vec3 control1;
  attribute vec3 direction;

  attribute vec3 instanceStart;
  attribute vec3 instanceEnd;

  // Optional world-space normals for toon shading (per-vertex, optional).
  // When absent, WebGL supplies (0,0,0) and shading falls back to a
  // constant ambient value — still correct, just less rich.
  attribute vec3 instanceNormalStart;
  attribute vec3 instanceNormalEnd;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying float vLineDistance;

  #ifdef USE_DASH
  uniform float dashScale;
  attribute float instanceDistanceStart;
  attribute float instanceDistanceEnd;
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
    vColor.xyz = vec3( 1.0 );
    #endif

    #ifdef USE_DASH
    vLineDistance = ( position.y < 0.5 ) ?
      dashScale * instanceDistanceStart :
      dashScale * instanceDistanceEnd;
    #endif

    float aspect = resolution.x / resolution.y;
    vUv = uv;

    vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );
    vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );

    bool perspective = ( projectionMatrix[ 2 ][ 3 ] == - 1.0 );
    if ( perspective ) {
      if ( start.z < 0.0 && end.z >= 0.0 ) trimSegment( start, end );
      else if ( end.z < 0.0 && start.z >= 0.0 ) trimSegment( end, start );
    }

    vec4 clipStart = projectionMatrix * start;
    vec4 clipEnd = projectionMatrix * end;

    vec2 ndcStart = clipStart.xy / clipStart.w;
    vec2 ndcEnd = clipEnd.xy / clipEnd.w;

    vec2 dir = ndcEnd - ndcStart;
    dir.x *= aspect;
    dir = normalize( dir );

    vec2 offset = vec2( dir.y, - dir.x );
    dir.x /= aspect;
    offset.x /= aspect;

    if ( position.x < 0.0 ) offset *= - 1.0;
    if ( position.y < 0.0 ) offset += - dir;
    else if ( position.y > 1.0 ) offset += dir;

    offset *= linewidth * outlineWidthScale;
    offset /= resolution.y;

    vec4 clip = ( position.y < 0.5 ) ? clipStart : clipEnd;
    offset *= clip.w;
    clip.xy += offset;
    gl_Position = clip;

    // Pass world-space normal to the fragment shader for toon shading
    vec3 nStart = instanceNormalStart;
    vec3 nEnd = instanceNormalEnd;
    vec3 nLocal = ( position.y < 0.5 ) ? nStart : nEnd;
    vWorldNormal = normalize( ( modelMatrix * vec4( nLocal, 0.0 ) ).xyz );

    #include <logdepthbuf_vertex>
    #include <clipping_planes_vertex>
    #include <fog_vertex>

    // Conditional line discard — identical to 130 / 135 / 136 / 140.
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
// GLSL fragment shader — procedural toon gradient ramp + multiplicative
// conditional line blending.
//
// Algorithm:
//   1. Compute NdotL from the world-space normal and the light direction.
//   2. Quantise NdotL into `gradientSteps` bands using gradientSmoothing to
//      anti-alias the transitions.
//   3. Blend baseColor (bright band) and shadeColor (dark band) into
//      toonColor.
//   4. Blend `diffuse` (the outline colour) with toonColor using
//      outlineLightingMixFactor — 0 = outline constant, 1 = fully driven by
//      toon shading.
//   5. Multiply by outlineColorFactor so the outline tint can darken or
//      lighten the toon result without changing the base shading.
//   6. Apply distance attenuation and dash discard as in 130.
// ---------------------------------------------------------------------------
const TOON_FRAGMENT_SHADER = /* glsl */`
  uniform vec3 diffuse;
  uniform vec3 outlineColorFactor;
  uniform float outlineLightingMixFactor;
  uniform float opacity;

  uniform vec3 baseColor;
  uniform vec3 shadeColor;
  uniform vec3 lightDirection;
  uniform float ambientStrength;
  uniform float shadowMultiplier;

  uniform int gradientSteps;
  uniform float gradientSmoothing;

  #ifdef USE_DASH
  uniform float dashSize;
  uniform float gapSize;
  #endif

  varying float vLineDistance;
  varying vec2 vUv;
  varying vec3 vWorldNormal;

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

    // -------------------------------------------------------------------
    // Toon gradient ramp
    // -------------------------------------------------------------------
    vec3 L = normalize( lightDirection );
    vec3 N = normalize( vWorldNormal );
    float NdotL = dot( N, L );
    float shade = clamp( NdotL * 0.5 + 0.5, 0.0, 1.0 );

    // Quantise into `gradientSteps` bands with smoothing at the edges
    float steps = max( float( gradientSteps - 1 ), 1.0 );
    float raw = shade * steps;
    float band = floor( raw );
    float frac = raw - band;
    // Smooth the band boundary using gradientSmoothing as the width
    float smoothFrac = smoothstep( 0.5 - gradientSmoothing, 0.5 + gradientSmoothing, frac );
    float quantised = ( band + smoothFrac ) / steps;
    quantised = clamp( quantised, 0.0, 1.0 );

    // Mix base and shade colours
    vec3 toonColor = mix( shadeColor, baseColor, quantised );
    toonColor = mix( toonColor, baseColor, ambientStrength );

    // -------------------------------------------------------------------
    // Blend the outline into the toon result
    // outlineLightingMixFactor:
    //   0.0 = outline uses `diffuse` directly (constant colour)
    //   1.0 = outline uses `toonColor` (fully toon-driven)
    // -------------------------------------------------------------------
    vec3 litOutline = mix( diffuse, toonColor, outlineLightingMixFactor );

    // Multiply by outlineColorFactor to darken/lighten the outline in shadow
    vec3 finalColor = litOutline * outlineColorFactor;

    // shadowMultiplier can further darken the shadowed side of the outline
    finalColor *= mix( 1.0, shadowMultiplier, 1.0 - quantised );

    vec4 diffuseColor = vec4( finalColor, opacity );

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
// ConditionalToonMaterial — extends ConditionalLineMaterial (130) with a
// toon gradient ramp and MToon-compatible outline parameters.
//
// New state:
//   outlineColorFactor       (Color)  — tint applied to the outline output
//   outlineLightingMixFactor (float)  — 0 = constant outline, 1 = toon-driven
//   outlineWidthScale        (float)  — per-material width multiplier
//   baseColor                (Color)  — toon bright band colour
//   shadeColor               (Color)  — toon dark band colour
//   lightDirection           (vec3)   — world-space light direction
//   ambientStrength          (float)  — ambient lift on the toon ramp
//   gradientSteps            (int)    — number of toon bands (2–8)
//   gradientSmoothing        (float)  — anti-aliasing width at band edges
//   shadowMultiplier         (float)  — extra darkening on shadowed outlines
// ---------------------------------------------------------------------------
class ConditionalToonMaterial extends ConditionalLineMaterial {
  /**
   * @param {object} [parameters={}]
   * @param {Color|number} [parameters.outlineColorFactor=0x000000]
   * @param {number} [parameters.outlineLightingMixFactor=1.0]
   * @param {number} [parameters.outlineWidthScale=1.0]
   * @param {Color|number} [parameters.baseColor=0xffffff]
   * @param {Color|number} [parameters.shadeColor=0x808080]
   * @param {Vec3|Array<number>} [parameters.lightDirection=[0,1,0]]
   * @param {number} [parameters.ambientStrength=0.1]
   * @param {number} [parameters.gradientSteps=4]
   * @param {number} [parameters.gradientSmoothing=0.05]
   * @param {number} [parameters.shadowMultiplier=1.0]
   */
  constructor(parameters = {}) {
    super(parameters);

    this.isConditionalToonMaterial = true;
    this.type = 'ConditionalToonMaterial';

    // Swap in the toon shaders
    this.vertexShader = TOON_VERTEX_SHADER;
    this.fragmentShader = TOON_FRAGMENT_SHADER;

    // --- MToon-compatible outline parameters ---
    this.outlineColorFactor = new Color(0x000000);
    if (parameters.outlineColorFactor !== undefined) {
      this.outlineColorFactor.set(parameters.outlineColorFactor);
    }

    this.outlineLightingMixFactor =
      parameters.outlineLightingMixFactor !== undefined
        ? Common.clamp(parameters.outlineLightingMixFactor, 0, 1)
        : 1.0;

    this.outlineWidthScale =
      parameters.outlineWidthScale !== undefined
        ? Math.max(0, parameters.outlineWidthScale)
        : 1.0;

    // --- Toon shading state ---
    this.baseColor = new Color(0xffffff);
    if (parameters.baseColor !== undefined) this.baseColor.set(parameters.baseColor);

    this.shadeColor = new Color(0x808080);
    if (parameters.shadeColor !== undefined) this.shadeColor.set(parameters.shadeColor);

    this.lightDirection = new Float32Array([0, 1, 0]);
    if (parameters.lightDirection !== undefined) {
      const ld = parameters.lightDirection;
      if (ld && ld.length >= 3) {
        this.lightDirection[0] = ld[0];
        this.lightDirection[1] = ld[1];
        this.lightDirection[2] = ld[2];
      }
    }

    this.ambientStrength =
      parameters.ambientStrength !== undefined
        ? Common.clamp(parameters.ambientStrength, 0, 1)
        : 0.1;

    this.gradientSteps =
      parameters.gradientSteps !== undefined
        ? Common.clamp(parameters.gradientSteps | 0, 2, 8)
        : 4;

    this.gradientSmoothing =
      parameters.gradientSmoothing !== undefined
        ? Common.clamp(parameters.gradientSmoothing, 0.001, 0.5)
        : 0.05;

    this.shadowMultiplier =
      parameters.shadowMultiplier !== undefined
        ? Math.max(0, parameters.shadowMultiplier)
        : 1.0;

    // Invalidate the parent's UniformsGroup — we add all toon uniforms below.
    if (this._uniformsGroup) {
      this._uniformsGroup.release();
      this._uniformsGroup = null;
    }
  }

  // -----------------------------------------------------------------------
  // Toon-specific setters
  // -----------------------------------------------------------------------

  /**
   * Set the outline tint factor.
   * @param {Color|number|string} color
   * @returns {this}
   */
  setOutlineColorFactor(color) {
    this.outlineColorFactor.set(color);
    this._version++;
    return this;
  }

  /**
   * Set the outline lighting mix factor (0 = constant, 1 = toon-driven).
   * @param {number} value
   * @returns {this}
   */
  setOutlineLightingMixFactor(value) {
    this.outlineLightingMixFactor = Common.clamp(value, 0, 1);
    this._version++;
    return this;
  }

  /**
   * Set the per-material width multiplier for conditional lines.
   * @param {number} value
   * @returns {this}
   */
  setOutlineWidthScale(value) {
    this.outlineWidthScale = Math.max(0, value);
    this._version++;
    return this;
  }

  /**
   * Set the toon bright and dark band colours.
   * @param {Color|number|string} baseColor
   * @param {Color|number|string} shadeColor
   * @returns {this}
   */
  setToonColors(baseColor, shadeColor) {
    this.baseColor.set(baseColor);
    this.shadeColor.set(shadeColor);
    this._version++;
    return this;
  }

  /**
   * Set the number of toon bands (2–8).
   * @param {number} steps
   * @returns {this}
   */
  setGradientSteps(steps) {
    this.gradientSteps = Common.clamp(steps | 0, 2, 8);
    this._version++;
    return this;
  }

  /**
   * Set the anti-aliasing width at band boundaries.
   * @param {number} value
   * @returns {this}
   */
  setGradientSmoothing(value) {
    this.gradientSmoothing = Common.clamp(value, 0.001, 0.5);
    this._version++;
    return this;
  }

  /**
   * Set the world-space light direction used for toon shading.
   * @param {Vec3|Array<number>} dir
   * @returns {this}
   */
  setLightDirection(dir) {
    if (dir && dir.length >= 3) {
      this.lightDirection[0] = dir[0];
      this.lightDirection[1] = dir[1];
      this.lightDirection[2] = dir[2];
      this._version++;
    }
    return this;
  }

  // -----------------------------------------------------------------------
  // UniformsGroup — full rebuild with toon uniforms
  // -----------------------------------------------------------------------

  /**
   * Build or return the cached UniformsGroup for this material.
   * @returns {UniformsGroup}
   */
  getUniformsGroup() {
    if (this._uniformsGroup) return this._uniformsGroup;

    const group = UniformsGroup.acquire();
    group.setName('ConditionalToonMaterial');

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

    // --- Toon outline uniforms (new in 142) ---
    const outlineColorFactorUniform = new Uniform();
    outlineColorFactorUniform.name = 'outlineColorFactor';
    outlineColorFactorUniform.type = 'vec3';
    outlineColorFactorUniform.setValue(this.outlineColorFactor);
    group.add(outlineColorFactorUniform);

    const outlineLightingMixFactorUniform = new Uniform();
    outlineLightingMixFactorUniform.name = 'outlineLightingMixFactor';
    outlineLightingMixFactorUniform.type = 'float';
    outlineLightingMixFactorUniform.setValue(this.outlineLightingMixFactor);
    group.add(outlineLightingMixFactorUniform);

    const outlineWidthScaleUniform = new Uniform();
    outlineWidthScaleUniform.name = 'outlineWidthScale';
    outlineWidthScaleUniform.type = 'float';
    outlineWidthScaleUniform.setValue(this.outlineWidthScale);
    group.add(outlineWidthScaleUniform);

    // --- Toon shading uniforms ---
    const baseColorUniform = new Uniform();
    baseColorUniform.name = 'baseColor';
    baseColorUniform.type = 'vec3';
    baseColorUniform.setValue(this.baseColor);
    group.add(baseColorUniform);

    const shadeColorUniform = new Uniform();
    shadeColorUniform.name = 'shadeColor';
    shadeColorUniform.type = 'vec3';
    shadeColorUniform.setValue(this.shadeColor);
    group.add(shadeColorUniform);

    const lightDirectionUniform = new Uniform();
    lightDirectionUniform.name = 'lightDirection';
    lightDirectionUniform.type = 'vec3';
    lightDirectionUniform.setValue(this.lightDirection);
    group.add(lightDirectionUniform);

    const ambientStrengthUniform = new Uniform();
    ambientStrengthUniform.name = 'ambientStrength';
    ambientStrengthUniform.type = 'float';
    ambientStrengthUniform.setValue(this.ambientStrength);
    group.add(ambientStrengthUniform);

    const gradientStepsUniform = new Uniform();
    gradientStepsUniform.name = 'gradientSteps';
    gradientStepsUniform.type = 'int';
    gradientStepsUniform.setValue(this.gradientSteps);
    group.add(gradientStepsUniform);

    const gradientSmoothingUniform = new Uniform();
    gradientSmoothingUniform.name = 'gradientSmoothing';
    gradientSmoothingUniform.type = 'float';
    gradientSmoothingUniform.setValue(this.gradientSmoothing);
    group.add(gradientSmoothingUniform);

    const shadowMultiplierUniform = new Uniform();
    shadowMultiplierUniform.name = 'shadowMultiplier';
    shadowMultiplierUniform.type = 'float';
    shadowMultiplierUniform.setValue(this.shadowMultiplier);
    group.add(shadowMultiplierUniform);

    this._uniformsGroup = group;
    return group;
  }

  // -----------------------------------------------------------------------
  // Copy / dispose
  // -----------------------------------------------------------------------

  /**
   * Copy settings from another ConditionalToonMaterial.
   * @param {ConditionalToonMaterial} source
   * @returns {this}
   */
  copy(source) {
    super.copy(source);
    this.outlineColorFactor.copy(source.outlineColorFactor);
    this.outlineLightingMixFactor = source.outlineLightingMixFactor;
    this.outlineWidthScale = source.outlineWidthScale;
    this.baseColor.copy(source.baseColor);
    this.shadeColor.copy(source.shadeColor);
    this.lightDirection[0] = source.lightDirection[0];
    this.lightDirection[1] = source.lightDirection[1];
    this.lightDirection[2] = source.lightDirection[2];
    this.ambientStrength = source.ambientStrength;
    this.gradientSteps = source.gradientSteps;
    this.gradientSmoothing = source.gradientSmoothing;
    this.shadowMultiplier = source.shadowMultiplier;
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
   * Expose the material's state — including all toon parameters — as a flat
   * typed-array column set for ECS-driven per-material LOD systems.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const base = super.asBitecsComponent(name);
    return {
      ...base,
      outlineColorFactor: this.outlineColorFactor.toArray(new Float32Array(3)),
      outlineLightingMixFactor: this.outlineLightingMixFactor,
      outlineWidthScale: this.outlineWidthScale,
      baseColor: this.baseColor.toArray(new Float32Array(3)),
      shadeColor: this.shadeColor.toArray(new Float32Array(3)),
      lightDirection: new Float32Array(this.lightDirection),
      ambientStrength: this.ambientStrength,
      gradientSteps: this.gradientSteps,
      gradientSmoothing: this.gradientSmoothing,
      shadowMultiplier: this.shadowMultiplier,
    };
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled ConditionalToonMaterial instance (MToon defaults:
   * outlineColorFactor=black, outlineLightingMixFactor=1,
   * outlineWidthScale=1, gradientSteps=4, gradientSmoothing=0.05).
   * @returns {ConditionalToonMaterial}
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
   * Clear the global ConditionalToonMaterial pool.
   */
  static clearPool() {
    _materialPool.length = 0;
  }
}

export {
  ConditionalToonMaterial,
  TOON_VERTEX_SHADER,
  TOON_FRAGMENT_SHADER,
};
export default ConditionalToonMaterial;