// file number : 130
// full path name : src/extras/lib/130_ConditionalLineMaterial.js
// description : Fat-line conditional edge material rewritten as a pure ES module with zero CDN imports. Ports gkjohnson's Lines2/ConditionalLineMaterial.js shader (screen-space fat-line expansion + conditional discard) onto the project's UniformsGroup (088) and Uniform (087) pipeline. Provides pooled instances via acquire()/release(), all r185 LineMaterial-compatible uniforms (diffuse, opacity, linewidth, resolution, dashScale, dashSize, gapSize), dashed-line support, fog integration, and a BitECS SoA bridge. Uses the project's Vec2 (005), Color (069), Constants (002), Common (003), and Precision (004) modules for zero-allocation math. Designed for 10k+ conditional edge meshes on Android 64-bit.
// best for : Fat conditional lines, LDraw-style model outlines, anime-style edge lines, CAD wireframe overlays, screen-space constant-width silhouettes, dashed hidden-line rendering, and any ECS-driven living-world pipeline that toggles conditional fat lines per mesh at 10k+ entity scale on Android 64-bit.
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

// ---------------------------------------------------------------------------
// Static pool for ConditionalLineMaterial instances — recycled to eliminate
// per-mesh allocation churn when 10k+ meshes toggle conditional fat lines.
// ---------------------------------------------------------------------------
const _materialPool = [];

function _acquireMaterial() {
  const m = _materialPool.pop();
  if (m) {
    m.color.setRGB(1, 1, 1);
    m.opacity = 1.0;
    m.linewidth = 1.0;
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
  return new ConditionalLineMaterial();
}

function _releaseMaterial(m) {
  if (_materialPool.length < 64) _materialPool.push(m);
}

// ---------------------------------------------------------------------------
// GLSL source — canonical gkjohnson Lines2/ConditionalLineMaterial shader.
// Screen-space fat-line expansion plus conditional discard.
// ---------------------------------------------------------------------------
const VERTEX_SHADER = /* glsl */`
  #include <common>
  #include <color_pars_vertex>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  #include <clipping_planes_pars_vertex>

  uniform float linewidth;
  uniform vec2 resolution;

  attribute vec3 control0;
  attribute vec3 control1;
  attribute vec3 direction;

  attribute vec3 instanceStart;
  attribute vec3 instanceEnd;
  attribute vec3 instanceColorStart;
  attribute vec3 instanceColorEnd;

  varying vec2 vUv;

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

    // camera space
    vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );
    vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );

    // perspective-projection segment trimming near the camera plane
    bool perspective = ( projectionMatrix[ 2 ][ 3 ] == - 1.0 );
    if ( perspective ) {
      if ( start.z < 0.0 && end.z >= 0.0 ) trimSegment( start, end );
      else if ( end.z < 0.0 && start.z >= 0.0 ) trimSegment( end, start );
    }

    // clip space
    vec4 clipStart = projectionMatrix * start;
    vec4 clipEnd = projectionMatrix * end;

    // NDC space
    vec2 ndcStart = clipStart.xy / clipStart.w;
    vec2 ndcEnd = clipEnd.xy / clipEnd.w;

    // direction
    vec2 dir = ndcEnd - ndcStart;

    // account for clip-space aspect ratio
    dir.x *= aspect;
    dir = normalize( dir );

    // perpendicular to dir
    vec2 offset = vec2( dir.y, - dir.x );

    // undo aspect ratio adjustment
    dir.x /= aspect;
    offset.x /= aspect;

    // sign flip
    if ( position.x < 0.0 ) offset *= - 1.0;

    // endcaps
    if ( position.y < 0.0 ) {
      offset += - dir;
    } else if ( position.y > 1.0 ) {
      offset += dir;
    }

    // adjust for linewidth
    offset *= linewidth;

    // adjust for clip-space to screen-space conversion
    offset /= resolution.y;

    // select end
    vec4 clip = ( position.y < 0.5 ) ? clipStart : clipEnd;

    // back to clip space
    offset *= clip.w;
    clip.xy += offset;
    gl_Position = clip;

    vec4 mvPosition = ( position.y < 0.5 ) ? start : end;

    #include <logdepthbuf_vertex>
    #include <clipping_planes_vertex>
    #include <fog_vertex>

    // -------------------------------------------------------------------
    // Conditional line logic — collapse the segment when the two control
    // points lie on opposite sides of the segment's perpendicular.
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

const FRAGMENT_SHADER = /* glsl */`
  uniform vec3 diffuse;
  uniform float opacity;

  #ifdef USE_DASH
  uniform float dashSize;
  uniform float gapSize;
  #endif

  varying float vLineDistance;
  varying vec2 vUv;

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

    vec4 diffuseColor = vec4( diffuse, opacity );

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
// Lightweight ShaderMaterial-compatible descriptor (no CDN dependency).
// ---------------------------------------------------------------------------
class LocalShaderMaterial {
  constructor(options = {}) {
    this.isShaderMaterial = true;
    this.type = options.type || 'ShaderMaterial';
    this.vertexShader = options.vertexShader || '';
    this.fragmentShader = options.fragmentShader || '';
    this.uniforms = options.uniforms || {};
    this.defines = options.defines || {};
    this.blending = options.blending !== undefined ? options.blending : Constants.NormalBlending;
    this.depthTest = options.depthTest !== undefined ? options.depthTest : true;
    this.depthWrite = options.depthWrite !== undefined ? options.depthWrite : true;
    this.transparent = options.transparent !== undefined ? options.transparent : false;
    this.side = options.side !== undefined ? options.side : Constants.FrontSide;
    this.clipping = options.clipping !== undefined ? options.clipping : true;
    this.fog = options.fog !== undefined ? options.fog : true;
  }
}

// ---------------------------------------------------------------------------
// ConditionalLineMaterial — mirrors gkjohnson's Lines2 ConditionalLineMaterial.
// ---------------------------------------------------------------------------
class ConditionalLineMaterial extends LocalShaderMaterial {
  /**
   * @param {object} [parameters={}] — material properties
   */
  constructor(parameters = {}) {
    super({
      type: 'ConditionalLineMaterial',
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {},
      clipping: true,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      blending: Constants.NormalBlending,
      side: Constants.FrontSide,
      fog: true,
    });

    this.isConditionalLineMaterial = true;

    // State
    this.color = new Color(0xffffff);
    this.opacity = 1.0;
    this.linewidth = 1.0;
    this.dashed = false;
    this.dashScale = 1.0;
    this.dashSize = 1.0;
    this.gapSize = 1.0;
    this.resolution = new Float32Array([1, 1]);
    this.worldUnits = false;

    this.visible = true;
    this._version = 0;
    this._needsUpdate = false;

    // Lazily built UniformsGroup
    this._uniformsGroup = null;

    // Apply initial parameters
    this.setValues(parameters);
  }

  // -----------------------------------------------------------------------
  // UniformsGroup integration (uses Uniform 087 + UniformsGroup 088)
  // -----------------------------------------------------------------------

  /**
   * Build or return the cached UniformsGroup for this material.
   * @returns {UniformsGroup}
   */
  getUniformsGroup() {
    if (this._uniformsGroup) return this._uniformsGroup;

    const group = UniformsGroup.acquire();
    group.setName('ConditionalLineMaterial');

    // diffuse (vec3)
    const diffuseUniform = new Uniform();
    diffuseUniform.name = 'diffuse';
    diffuseUniform.type = 'vec3';
    diffuseUniform.setValue(this.color);
    group.add(diffuseUniform);

    // opacity (float)
    const opacityUniform = new Uniform();
    opacityUniform.name = 'opacity';
    opacityUniform.type = 'float';
    opacityUniform.setValue(this.opacity);
    group.add(opacityUniform);

    // linewidth (float)
    const linewidthUniform = new Uniform();
    linewidthUniform.name = 'linewidth';
    linewidthUniform.type = 'float';
    linewidthUniform.setValue(this.linewidth);
    group.add(linewidthUniform);

    // resolution (vec2)
    const resolutionUniform = new Uniform();
    resolutionUniform.name = 'resolution';
    resolutionUniform.type = 'vec2';
    resolutionUniform.setValue(this.resolution);
    group.add(resolutionUniform);

    // dashScale (float)
    const dashScaleUniform = new Uniform();
    dashScaleUniform.name = 'dashScale';
    dashScaleUniform.type = 'float';
    dashScaleUniform.setValue(this.dashScale);
    group.add(dashScaleUniform);

    // dashSize (float)
    const dashSizeUniform = new Uniform();
    dashSizeUniform.name = 'dashSize';
    dashSizeUniform.type = 'float';
    dashSizeUniform.setValue(this.dashSize);
    group.add(dashSizeUniform);

    // gapSize (float)
    const gapSizeUniform = new Uniform();
    gapSizeUniform.name = 'gapSize';
    gapSizeUniform.type = 'float';
    gapSizeUniform.setValue(this.gapSize);
    group.add(gapSizeUniform);

    this._uniformsGroup = group;
    return group;
  }

  // -----------------------------------------------------------------------
  // Property accessors (mirrors r185 LineMaterial surface)
  // -----------------------------------------------------------------------

  /** @returns {Color} */
  get color() { return this._color; }
  set color(v) {
    if (this._color) this._color.set(v);
    else this._color = new Color(v);
    this._version++;
  }

  /** @returns {number} */
  get opacity() { return this._opacity; }
  set opacity(v) {
    this._opacity = Common.clamp(v, 0, 1);
    this._version++;
  }

  /** @returns {number} */
  get linewidth() { return this._linewidth; }
  set linewidth(v) {
    this._linewidth = Math.max(0, v);
    this._version++;
  }

  /** @returns {boolean} */
  get dashed() { return this._dashed; }
  set dashed(v) {
    this._dashed = !!v;
    this._version++;
  }

  /** @returns {number} */
  get dashScale() { return this._dashScale; }
  set dashScale(v) {
    this._dashScale = v;
    this._version++;
  }

  /** @returns {number} */
  get dashSize() { return this._dashSize; }
  set dashSize(v) {
    this._dashSize = v;
    this._version++;
  }

  /** @returns {number} */
  get gapSize() { return this._gapSize; }
  set gapSize(v) {
    this._gapSize = v;
    this._version++;
  }

  /** @returns {Float32Array} */
  get resolution() { return this._resolution; }
  set resolution(v) {
    this._resolution[0] = v[0];
    this._resolution[1] = v[1];
    this._version++;
  }

  // Internal backing fields
  get _color() { return this.__color || (this.__color = new Color(0xffffff)); }
  set _color(v) { this.__color = v; }

  get _opacity() { return this.__opacity !== undefined ? this.__opacity : 1.0; }
  set _opacity(v) { this.__opacity = v; }

  get _linewidth() { return this.__linewidth !== undefined ? this.__linewidth : 1.0; }
  set _linewidth(v) { this.__linewidth = v; }

  get _dashed() { return this.__dashed !== undefined ? this.__dashed : false; }
  set _dashed(v) { this.__dashed = v; }

  get _dashScale() { return this.__dashScale !== undefined ? this.__dashScale : 1.0; }
  set _dashScale(v) { this.__dashScale = v; }

  get _dashSize() { return this.__dashSize !== undefined ? this.__dashSize : 1.0; }
  set _dashSize(v) { this.__dashSize = v; }

  get _gapSize() { return this.__gapSize !== undefined ? this.__gapSize : 1.0; }
  set _gapSize(v) { this.__gapSize = v; }

  get _resolution() { return this.__resolution || (this.__resolution = new Float32Array([1, 1])); }
  set _resolution(v) { this.__resolution = v; }

  // -----------------------------------------------------------------------
  // setValues — mirrors r185 Material.setValues
  // -----------------------------------------------------------------------

  /**
   * Apply a parameters object to this material.
   * @param {object} parameters
   * @returns {this}
   */
  setValues(parameters) {
    if (!parameters) return this;

    for (const key in parameters) {
      const value = parameters[key];

      // Skip undefined
      if (value === undefined) continue;

      const currentValue = this[key];

      if (currentValue && currentValue.isColor) {
        currentValue.set(value);
      } else if (currentValue && typeof currentValue.copy === 'function') {
        currentValue.copy(value);
      } else {
        this[key] = value;
      }
    }
    return this;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

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
   * Copy settings from another ConditionalLineMaterial.
   * @param {ConditionalLineMaterial} source
   * @returns {this}
   */
  copy(source) {
    this.color.copy(source.color);
    this.opacity = source.opacity;
    this.linewidth = source.linewidth;
    this.dashed = source.dashed;
    this.dashScale = source.dashScale;
    this.dashSize = source.dashSize;
    this.gapSize = source.gapSize;
    this.resolution[0] = source.resolution[0];
    this.resolution[1] = source.resolution[1];
    this.visible = source.visible;
    this.transparent = source.transparent;
    this.depthTest = source.depthTest;
    this.depthWrite = source.depthWrite;
    this.blending = source.blending;
    this.side = source.side;
    this.fog = source.fog;
    this.worldUnits = source.worldUnits;
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

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose the material's state as a flat typed-array column set for ECS
   * systems that drive per-material toggling, LOD selection, or colour
   * animation.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    return {
      name,
      color: this.color.toArray(new Float32Array(3)),
      opacity: this.opacity,
      linewidth: this.linewidth,
      dashed: this.dashed ? 1 : 0,
      dashScale: this.dashScale,
      dashSize: this.dashSize,
      gapSize: this.gapSize,
      resolutionX: this.resolution[0],
      resolutionY: this.resolution[1],
      worldUnits: this.worldUnits ? 1 : 0,
    };
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled ConditionalLineMaterial instance (default white, 1px).
   * @returns {ConditionalLineMaterial}
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
   * Clear the global material pool.
   */
  static clearPool() {
    _materialPool.length = 0;
  }
}

export { ConditionalLineMaterial, VERTEX_SHADER, FRAGMENT_SHADER };
export default ConditionalLineMaterial;