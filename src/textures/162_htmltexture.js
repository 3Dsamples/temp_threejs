// file number : 162
// full path name : src/textures/162_htmltexture.js
// description : HTMLTexture (custom three.js extension) rewritten as a pure ES module with zero CDN imports and completely dynamic features. Extends Texture (151) to create textures from live HTML DOM elements by rasterizing them into an offscreen canvas. Preserves the full custom API — element reference, devicePixelRatio, generateMipmaps=false, flipY=false, unpackAlignment=1, isHTMLTexture flag, plus clone(), copy(), toJSON() inherited from Texture. Adds dynamic feature toggles: dynamic capture-function swapping (html2canvas, foreignObject SVG, custom DOM-to-canvas), dynamic DPR switching for device resolution changes, dynamic auto-refresh on DOM mutations via MutationObserver, dynamic throttled refresh (configurable Hz), dynamic layout-change detection via ResizeObserver, Float64 cumulativeOffsetPrecise (native JS IEEE-754 doubles — no double.js) for pixel-accurate hit-testing across deeply nested trees, SimplexNoise-dithered paintPlaceholder for pending DOM, dynamic sampleGlMat for CPU-side lookups, dynamic element replacement without recreating the texture, dynamic visibility-based auto-pause (skips captures when element is off-screen), and dynamic color-space switching. Uses a flat typed-array HTMLTextureBatch for multi-element pipelines (UI panels, dynamic labels, ad boards, mixed HTML/WebGL apps), and full pool integration via acquire()/release()/clearPool(). Designed for 10k+ HTML textures on Android 64-bit with zero CDN dependencies.
// best for : Rendering HTML DOM nodes as three.js textures (UI panels, HTML overlays, dynamic text labels, embedded iframes/widgets), 3D web applications that mix HTML UI with WebGL content, ad boards, in-world kiosks, diegetic UI, in-game browsers, dynamic signage, AR/VR panels, mixed HTML/WebGL scenes, and any workflow that needs to project a live HTML tree onto a 3D surface with runtime-switchable features at 10k+ entity scale on Android 64-bit.
// license : MIT

import { Constants } from '../core/002_Constants.js';
import { Common } from '../core/003_Common.js';
import { Precision } from '../core/004_Precision.js';
import { Vec2 } from '../math/005_Vec2.js';
import { Vec3 } from '../math/006_Vec3.js';
import { Vec4 } from '../math/007_Vec4.js';
import { Mat2 } from '../math/008_Mat2.js';
import { Mat3 } from '../math/009_Mat3.js';
import { Mat4 } from '../math/010_Mat4.js';
import { Quat } from '../math/011_Quat.js';
import { Quat2 } from '../math/012_Quat2.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';
import { BitECS } from '../ecs/014_BitECS.js';
import { World } from '../ecs/015_World.js';
import { Components } from '../ecs/016_Components.js';
import { Systems } from '../ecs/017_Systems.js';
import { Texture } from './151_texture.js';

// ---------------------------------------------------------------------------
// Local aliases for the project's Constants.
// ---------------------------------------------------------------------------
const LinearFilter       = Constants.LinearFilter;
const RGBAFormat         = Constants.RGBAFormat;
const UnsignedByteType   = Constants.UnsignedByteType;
const NoColorSpace       = Constants.NoColorSpace;
const SRGBColorSpace     = Constants.SRGBColorSpace;
const LinearSRGBColorSpace = Constants.LinearSRGBColorSpace;
const UVMapping          = Constants.UVMapping;
const ClampToEdgeWrapping = Constants.ClampToEdgeWrapping;

// ---------------------------------------------------------------------------
// Static pool for HTMLTexture instances — recycled to eliminate per-mesh
// allocation churn when 10k+ HTML textures spawn/despawn in an ECS scene.
// ---------------------------------------------------------------------------
const _htmlPool = [];

function _acquireHtml() {
  const t = _htmlPool.pop();
  if (t) {
    t._resetForPool();
    return t;
  }
  return new HTMLTexture(null);
}

function _releaseHtml(t) {
  if (_htmlPool.length < 128) _htmlPool.push(t);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _rgba = new Float32Array(4);
const _vec2 = new Float32Array(2);
const _vec3 = new Float32Array(3);
const _rect = new Int32Array(4);

// ---------------------------------------------------------------------------
// HTMLTextureBatch — flat typed-array batch coordinator for multi-element
// DOM pipelines (UI panels, dynamic labels, ad boards).
// ---------------------------------------------------------------------------
const HTML_MODE_RAW        = 0;
const HTML_MODE_THROTTLED  = 1;
const HTML_MODE_RESIZE     = 2;
const HTML_MODE_PLACEHOLDER = 3;

class HTMLTextureBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._texPtr      = new Int32Array(capacity);
    this._width       = new Int32Array(capacity);
    this._height      = new Int32Array(capacity);
    this._dpr         = new Float64Array(capacity);
    this._mode        = new Uint8Array(capacity);
    this._dirty       = new Uint8Array(capacity);
    this._applied     = new Uint8Array(capacity);

    this._textures = [];
    this._capacity = capacity;
  }

  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 64);

    const a = new Int32Array(newCap);   a.set(this._texPtr);   this._texPtr = a;
    const b = new Int32Array(newCap);   b.set(this._width);    this._width = b;
    const c = new Int32Array(newCap);   c.set(this._height);   this._height = c;
    const d = new Float64Array(newCap); d.set(this._dpr);      this._dpr = d;
    const e = new Uint8Array(newCap);   e.set(this._mode);     this._mode = e;
    const f = new Uint8Array(newCap);   f.set(this._dirty);    this._dirty = f;
    const g = new Uint8Array(newCap);   g.set(this._applied);  this._applied = g;

    this._capacity = newCap;
  }

  addTexture(texture) {
    this._textures.push(texture);
    return this._textures.length - 1;
  }

  addJob(textureId, mode = HTML_MODE_RAW) {
    this._ensure(this._count + 1);
    const i = this._count++;
    const texture = this._textures[textureId];

    this._texPtr[i] = textureId;
    this._width[i] = texture ? (texture.image.width || 0) : 0;
    this._height[i] = texture ? (texture.image.height || 0) : 0;
    this._dpr[i] = texture ? texture.devicePixelRatio : 1;
    this._mode[i] = mode;
    this._dirty[i] = 0;
    this._applied[i] = 0;

    return i;
  }

  process() {
    const n = this._count;

    for (let i = 0; i < n; i++) {
      const texture = this._textures[this._texPtr[i]];
      if (!texture || !texture.element) {
        this._applied[i] = 0;
        continue;
      }

      const element = texture.element;
      if (typeof element.getBoundingClientRect !== 'function') {
        this._applied[i] = 0;
        continue;
      }

      const rect = element.getBoundingClientRect();
      const dpr = this._dpr[i] || 1;

      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));

      this._width[i] = w;
      this._height[i] = h;

      // Resize mode: update texture dimensions without re-rasterizing
      if (this._mode[i] === HTML_MODE_RESIZE) {
        if (texture.image.width !== w || texture.image.height !== h) {
          texture.image.width = w;
          texture.image.height = h;
          if (texture.image instanceof HTMLCanvasElement) {
            texture.image.width = w;
            texture.image.height = h;
          }
          this._dirty[i] = 1;
        }
        this._applied[i] = 1;
        continue;
      }

      // Placeholder mode: paint the dithered placeholder
      if (this._mode[i] === HTML_MODE_PLACEHOLDER) {
        texture.paintPlaceholder(0.5);
        this._applied[i] = 1;
        continue;
      }

      // Raw / throttled: mark for re-rasterization
      texture.update();
      this._dirty[i] = 1;
      this._applied[i] = 1;
    }
  }

  results() {
    return this._applied.subarray(0, this._count);
  }

  reset() {
    this._count = 0;
  }

  asBitecsComponent(name) {
    return {
      name,
      count: this._count,
      texPtr: this._texPtr,
      width: this._width,
      height: this._height,
      dpr: this._dpr,
      mode: this._mode,
      dirty: this._dirty,
      applied: this._applied,
    };
  }
}

// ---------------------------------------------------------------------------
// Float64 cumulative DOM offset accumulation. JS numbers are IEEE-754
// doubles — accumulation is bit-exact up to 2^53.
// ---------------------------------------------------------------------------
function cumulativeOffsetPrecise(element) {
  let x = 0;
  let y = 0;

  let current = element;
  while (current) {
    x += current.offsetLeft || 0;
    y += current.offsetTop || 0;
    current = current.offsetParent;
  }

  return { x, y };
}

// ---------------------------------------------------------------------------
// SimplexNoise-dithered placeholder painting while DOM is not ready.
// ---------------------------------------------------------------------------
function paintHtmlPlaceholder(canvas, amplitude = 0.5) {
  if (!canvas || typeof canvas.getContext !== 'function') return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const imageData = ctx.createImageData(canvas.width, canvas.height);
  const data = imageData.data;
  const invAmp = amplitude / 255;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const p = (y * canvas.width + x) * 4;
      const d = SimplexNoise.noise2D(x * 0.05, y * 0.05) * invAmp;

      // Diagonal hatch placeholder
      const hatch = ((x + y) & 15) < 8 ? 0.6 : 0.4;
      data[p]     = Math.floor(Math.max(0, Math.min(1, hatch + d)) * 255);
      data[p + 1] = Math.floor(Math.max(0, Math.min(1, hatch + d)) * 255);
      data[p + 2] = Math.floor(Math.max(0, Math.min(1, hatch + d)) * 255);
      data[p + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

// ---------------------------------------------------------------------------
// HTMLTexture — extends three.js Texture for HTML DOM sources with
// completely dynamic features.
// ---------------------------------------------------------------------------
class HTMLTexture extends Texture {
  /**
   * @param {HTMLElement} [element=null]
   * @param {number} [devicePixelRatio=window.devicePixelRatio||1]
   * @param {number} [mapping=Texture.DEFAULT_MAPPING]
   * @param {number} [wrapS=ClampToEdgeWrapping]
   * @param {number} [wrapT=ClampToEdgeWrapping]
   * @param {number} [magFilter=LinearFilter]
   * @param {number} [minFilter=LinearFilter]
   * @param {number} [format=RGBAFormat]
   * @param {number} [type=UnsignedByteType]
   * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY]
   */
  constructor(
    element = null,
    devicePixelRatio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
    mapping = Texture.DEFAULT_MAPPING,
    wrapS = ClampToEdgeWrapping,
    wrapT = ClampToEdgeWrapping,
    magFilter = LinearFilter,
    minFilter = LinearFilter,
    format = RGBAFormat,
    type = UnsignedByteType,
    anisotropy = Texture.DEFAULT_ANISOTROPY
  ) {
    const canvas = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }

    super(canvas, mapping, wrapS, wrapT, magFilter, minFilter, format, type, anisotropy);

    this.isHTMLTexture = true;
    this.element = element;
    this.devicePixelRatio = devicePixelRatio;

    this.generateMipmaps = false;
    this.flipY = false;
    this.unpackAlignment = 1;

    // Capture function (pluggable)
    this._captureFn = null;

    // Auto-refresh state
    this._mutationObserver = null;
    this._resizeObserver = null;
    this._refreshInterval = 0;
    this._refreshTimer = 0;
    this._lastRefreshTime = 0;

    // Throttle state
    this._targetHz = 0;
    this._lastCaptureTime = 0;

    // Visibility state
    this._visible = true;
    this._intersectionObserver = null;

    // Dynamic feature flags (all opt-in, toggled at runtime)
    this.dynamicFeatures = {
      autoRefresh: false,
      mutationWatch: false,
      resizeWatch: false,
      throttledRefresh: false,
      dprSwitch: false,
      elementSwap: false,
      visibilityPause: false,
      colorSpaceSwitch: false,
      proceduralPlaceholder: false,
    };
  }

  // -----------------------------------------------------------------------
  // Dynamic feature toggles
  // -----------------------------------------------------------------------

  setFeature(name, enabled = true) {
    if (this.dynamicFeatures.hasOwnProperty(name)) {
      this.dynamicFeatures[name] = !!enabled;
      this.needsUpdate = true;
    }
    return this;
  }

  toggleFeature(name) {
    if (!this.dynamicFeatures.hasOwnProperty(name)) return false;
    this.dynamicFeatures[name] = !this.dynamicFeatures[name];
    this.needsUpdate = true;
    return this.dynamicFeatures[name];
  }

  hasFeature(name) {
    return this.dynamicFeatures[name] === true;
  }

  // -----------------------------------------------------------------------
  // Dynamic capture-function swapping
  // -----------------------------------------------------------------------

  /**
   * Set the DOM → canvas rasterization function. Called as
   * `fn(element, canvas, dpr)`.
   * @param {Function} fn
   * @returns {this}
   */
  setCaptureFunction(fn) {
    this._captureFn = fn;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic DPR switching
  // -----------------------------------------------------------------------

  /**
   * Update the device pixel ratio used for rasterization.
   * @param {number} dpr
   * @returns {this}
   */
  setDevicePixelRatio(dpr) {
    this.devicePixelRatio = Math.max(0.5, dpr);
    this.dynamicFeatures.dprSwitch = true;
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic element swapping
  // -----------------------------------------------------------------------

  /**
   * Replace the source DOM element without recreating the texture.
   * @param {HTMLElement} newElement
   * @returns {this}
   */
  swapElement(newElement) {
    this.disconnectObservers();
    this.element = newElement;
    this.dynamicFeatures.elementSwap = true;
    if (this.dynamicFeatures.autoRefresh) this._connectObservers();
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic auto-refresh
  // -----------------------------------------------------------------------

  /**
   * Enable auto-refresh: re-rasterize the DOM element when it changes.
   * @param {object} [options={}]
   * @param {boolean} [options.mutation=true] — use MutationObserver
   * @param {boolean} [options.resize=true] — use ResizeObserver
   * @param {number} [options.hz=0] — throttle to N Hz (0 = no throttle)
   * @returns {this}
   */
  enableAutoRefresh(options = {}) {
    this.dynamicFeatures.autoRefresh = true;

    if (options.mutation !== false && typeof MutationObserver !== 'undefined') {
      this.dynamicFeatures.mutationWatch = true;
    }

    if (options.resize !== false && typeof ResizeObserver !== 'undefined') {
      this.dynamicFeatures.resizeWatch = true;
    }

    if (options.hz !== undefined && options.hz > 0) {
      this.setTargetHz(options.hz);
    }

    this._connectObservers();
    return this;
  }

  /**
   * Disable auto-refresh.
   * @returns {this}
   */
  disableAutoRefresh() {
    this.dynamicFeatures.autoRefresh = false;
    this.dynamicFeatures.mutationWatch = false;
    this.dynamicFeatures.resizeWatch = false;
    this.disconnectObservers();
    return this;
  }

  _connectObservers() {
    this.disconnectObservers();

    if (!this.element) return;

    const scope = this;

    if (this.dynamicFeatures.mutationWatch && typeof MutationObserver !== 'undefined') {
      this._mutationObserver = new MutationObserver(function () {
        if (scope.dynamicFeatures.visibilityPause && !scope._visible) return;
        scope._throttledUpdate();
      });
      this._mutationObserver.observe(this.element, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    if (this.dynamicFeatures.resizeWatch && typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(function () {
        if (scope.dynamicFeatures.visibilityPause && !scope._visible) return;
        scope._throttledUpdate();
      });
      this._resizeObserver.observe(this.element);
    }
  }

  /**
   * Disconnect all observers (mutation and resize).
   * @returns {this}
   */
  disconnectObservers() {
    if (this._mutationObserver) {
      this._mutationObserver.disconnect();
      this._mutationObserver = null;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic throttled refresh
  // -----------------------------------------------------------------------

  /**
   * Set a target refresh rate in Hz (0 = unlimited).
   * @param {number} hz
   * @returns {this}
   */
  setTargetHz(hz) {
    this._targetHz = Math.max(0, hz | 0);
    this.dynamicFeatures.throttledRefresh = this._targetHz > 0;
    return this;
  }

  /** @returns {number} */
  get targetHz() {
    return this._targetHz;
  }

  _throttledUpdate() {
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    if (this._targetHz > 0) {
      const minInterval = 1000 / this._targetHz;
      if (now - this._lastCaptureTime < minInterval) return;
    }

    this._lastCaptureTime = now;
    this.update();
  }

  // -----------------------------------------------------------------------
  // Dynamic visibility-based pause
  // -----------------------------------------------------------------------

  /**
   * Enable visibility-based auto-pause (skips captures when the element is
   * off-screen). Requires IntersectionObserver.
   * @returns {this}
   */
  enableVisibilityPause() {
    if (typeof IntersectionObserver === 'undefined') return this;

    this.dynamicFeatures.visibilityPause = true;

    if (this.element && !this._intersectionObserver) {
      const scope = this;
      this._intersectionObserver = new IntersectionObserver(function (entries) {
        for (let i = 0; i < entries.length; i++) {
          scope._visible = entries[i].isIntersecting;
          if (scope._visible) scope._throttledUpdate();
        }
      });
      this._intersectionObserver.observe(this.element);
    }

    return this;
  }

  disableVisibilityPause() {
    this.dynamicFeatures.visibilityPause = false;
    if (this._intersectionObserver) {
      this._intersectionObserver.disconnect();
      this._intersectionObserver = null;
    }
    this._visible = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic color-space switching
  // -----------------------------------------------------------------------

  /**
   * Switch between sRGB and Linear color spaces.
   * @param {'srgb'|'linear'} space
   * @returns {this}
   */
  setColorSpaceMode(space) {
    this.dynamicFeatures.colorSpaceSwitch = true;
    this.colorSpace = space === 'linear' ? LinearSRGBColorSpace : SRGBColorSpace;
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Rasterization
  // -----------------------------------------------------------------------

  /**
   * Rasterize the DOM element into the backing canvas.
   * @returns {this}
   */
  update() {
    const element = this.element;
    const canvas = this.image;

    if (!element || !(canvas instanceof HTMLCanvasElement)) return this;
    if (typeof element.getBoundingClientRect !== 'function') return this;

    const rect = element.getBoundingClientRect();
    const dpr = this.devicePixelRatio;

    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    canvas.width = width;
    canvas.height = height;

    if (typeof this._captureFn === 'function') {
      try {
        this._captureFn(element, canvas, dpr);
      } catch (e) {
        paintHtmlPlaceholder(canvas, 0.5);
      }
    } else if (typeof window !== 'undefined' && typeof window.html2canvas === 'function') {
      window.html2canvas(element).then((captured) => {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(captured, 0, 0, width, height);
        this.needsUpdate = true;
      }).catch(() => {
        paintHtmlPlaceholder(canvas, 0.5);
        this.needsUpdate = true;
      });
    } else {
      paintHtmlPlaceholder(canvas, 0.5);
    }

    this._lastRefreshTime = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic sampling
  // -----------------------------------------------------------------------

  /**
   * Zero-allocation pixel sample via the project's Vec4 module.
   * @param {Float32Array} [out]
   * @param {number} [u=0.5]
   * @param {number} [v=0.5]
   * @returns {Float32Array|null}
   */
  sampleGlMat(out = _rgba, u = 0.5, v = 0.5) {
    const canvas = this.image;
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    if (canvas.width === 0 || canvas.height === 0) return null;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const x = Math.min(canvas.width - 1, Math.max(0, Math.floor(u * canvas.width)));
    const y = Math.min(canvas.height - 1, Math.max(0, Math.floor(v * canvas.height)));

    const imageData = ctx.getImageData(x, y, 1, 1);
    const p = 0;

    Vec4.set(
      out,
      imageData.data[p] / 255,
      imageData.data[p + 1] / 255,
      imageData.data[p + 2] / 255,
      imageData.data[p + 3] / 255
    );
    return out;
  }

  /**
   * Float64 cumulative DOM offset from the document root (no double.js).
   * @returns {{x: number, y: number}}
   */
  getCumulativeOffsetPrecise() {
    if (!this.element) return { x: 0, y: 0 };
    return cumulativeOffsetPrecise(this.element);
  }

  // -----------------------------------------------------------------------
  // Dynamic placeholder painting
  // -----------------------------------------------------------------------

  /**
   * Paint a SimplexNoise-dithered placeholder into the backing canvas.
   * @param {number} [amplitude=0.5]
   * @returns {this}
   */
  paintPlaceholder(amplitude = 0.5) {
    const canvas = this.image;
    if (!(canvas instanceof HTMLCanvasElement)) return this;

    paintHtmlPlaceholder(canvas, amplitude);
    this.dynamicFeatures.proceduralPlaceholder = true;
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Copy / serialize
  // -----------------------------------------------------------------------

  copy(source) {
    super.copy(source);

    this.element = source.element;
    this.devicePixelRatio = source.devicePixelRatio;
    this._captureFn = source._captureFn;

    this.generateMipmaps = source.generateMipmaps;
    this.flipY = source.flipY;
    this.unpackAlignment = source.unpackAlignment;

    this._targetHz = source._targetHz;
    this._lastCaptureTime = source._lastCaptureTime;
    this._lastRefreshTime = source._lastRefreshTime;
    this._visible = source._visible;

    if (source.dynamicFeatures) {
      this.dynamicFeatures = { ...source.dynamicFeatures };
    }

    if (this.dynamicFeatures.autoRefresh) this._connectObservers();
    if (this.dynamicFeatures.visibilityPause) this.enableVisibilityPause();

    return this;
  }

  toJSON(meta) {
    const isRootObject = meta === undefined || typeof meta === 'string';
    const output = super.toJSON(meta);

    output.image = {
      width: this.image ? this.image.width : 0,
      height: this.image ? this.image.height : 0,
      devicePixelRatio: this.devicePixelRatio,
    };

    if (this.element && this.element.id) {
      output.elementId = this.element.id;
    }

    output.dynamicFeatures = { ...this.dynamicFeatures };
    output.targetHz = this._targetHz;

    if (!isRootObject) {
      meta.textures[this.uuid] = output;
    }
    return output;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  dispose() {
    this.disconnectObservers();
    if (this._intersectionObserver) {
      this._intersectionObserver.disconnect();
      this._intersectionObserver = null;
    }
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = 0;
    }
    super.dispose();
  }

  // -----------------------------------------------------------------------
  // Pool + batch helpers
  // -----------------------------------------------------------------------

  static createBatch() {
    return new HTMLTextureBatch();
  }

  static acquire() {
    return _acquireHtml();
  }

  release() {
    this.dispose();
    if (this.source) {
      this.source.release();
      this.source = null;
    }
    _releaseHtml(this);
  }

  static clearPool() {
    _htmlPool.length = 0;
  }

  _resetForPool() {
    const parentReset = Texture.prototype._resetForPool;
    if (typeof parentReset === 'function') parentReset.call(this);

    this.isHTMLTexture = true;
    this.element = null;
    this.devicePixelRatio = 1;

    this.generateMipmaps = false;
    this.flipY = false;
    this.unpackAlignment = 1;

    this._captureFn = null;
    this._mutationObserver = null;
    this._resizeObserver = null;
    this._intersectionObserver = null;
    this._refreshInterval = 0;
    this._refreshTimer = 0;
    this._lastRefreshTime = 0;
    this._targetHz = 0;
    this._lastCaptureTime = 0;
    this._visible = true;

    this.dynamicFeatures = {
      autoRefresh: false,
      mutationWatch: false,
      resizeWatch: false,
      throttledRefresh: false,
      dprSwitch: false,
      elementSwap: false,
      visibilityPause: false,
      colorSpaceSwitch: false,
      proceduralPlaceholder: false,
    };
  }

  asBitecsComponent(name) {
    const base = super.asBitecsComponent(name);
    return {
      ...base,
      isHTMLTexture: 1,
      width: this.image ? this.image.width : 0,
      height: this.image ? this.image.height : 0,
      devicePixelRatio: this.devicePixelRatio,
      targetHz: this._targetHz,
      visible: this._visible ? 1 : 0,
      autoRefresh: this.dynamicFeatures.autoRefresh ? 1 : 0,
      mutationWatch: this.dynamicFeatures.mutationWatch ? 1 : 0,
      resizeWatch: this.dynamicFeatures.resizeWatch ? 1 : 0,
      visibilityPause: this.dynamicFeatures.visibilityPause ? 1 : 0,
      hasCaptureFn: this._captureFn ? 1 : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  HTMLTexture,
  HTMLTextureBatch,
  cumulativeOffsetPrecise,
  paintHtmlPlaceholder,
};
export default HTMLTexture;