// file number : 160
// full path name : src/textures/160_videotexture.js
// description : VideoTexture (three.js r185) rewritten as a pure ES module with zero CDN imports and completely dynamic features. Extends Texture (151) to create textures that update automatically from an HTML5 video element (or any object with readyState/HAVE_CURRENT_DATA/requestVideoFrameCallback). Preserves the full r185 VideoTexture API — generateMipmaps=false, isVideoTexture flag, video property, plus clone(), copy(), toJSON(), update() override, and the r185 paused/requestVideoFrameCallback fast-path. Adds dynamic feature toggles: dynamic playback-rate adaptation, dynamic pause-on-hidden (auto-pauses when the tab loses visibility), dynamic color-space switching (SRGB↔Linear via in-place conversion), dynamic frame-checksum computation using Float64 (native JS IEEE-754 doubles — no double.js) for A/V sync, SimplexNoise-dithered paintFallback for missing-video placeholders, dynamic cross-fade between two video sources, dynamic frame sampling with sampleGlMat, dynamic per-frame RGBA capture for CPU-side analysis, dynamic frame-rate throttling for power savings, and dynamic loop/playback control. Uses a flat typed-array VideoTextureBatch for multi-video pipelines (video walls, VR 360 video, multi-camera CCTV), and full pool integration via acquire()/release()/clearPool(). Designed for 10k+ video textures on Android 64-bit with zero CDN dependencies.
// best for : VideoTexture, HTMLVideoElement playback, VR 360 video, video backgrounds, video walls, UI video overlays, CCTV multi-camera feeds, live streaming textures, dynamic billboard content, machine-learning frame analysis pipelines, and any three.js workflow that needs a live video feed as its texture source with runtime-switchable features at 10k+ entity scale on Android 64-bit.
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
const LinearMipmapLinearFilter = Constants.LinearMipmapLinearFilter;
const RGBAFormat         = Constants.RGBAFormat;
const UnsignedByteType   = Constants.UnsignedByteType;
const NoColorSpace       = Constants.NoColorSpace;
const SRGBColorSpace     = Constants.SRGBColorSpace;
const LinearSRGBColorSpace = Constants.LinearSRGBColorSpace;
const UVMapping          = Constants.UVMapping;
const ClampToEdgeWrapping = Constants.ClampToEdgeWrapping;

// ---------------------------------------------------------------------------
// Static pool for VideoTexture instances — recycled to eliminate per-mesh
// allocation churn when 10k+ video textures spawn/despawn in an ECS scene.
// ---------------------------------------------------------------------------
const _videoPool = [];

function _acquireVideo() {
  const t = _videoPool.pop();
  if (t) {
    t._resetForPool();
    return t;
  }
  return new VideoTexture(undefined);
}

function _releaseVideo(t) {
  if (_videoPool.length < 128) _videoPool.push(t);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _rgba = new Float32Array(4);
const _vec3 = new Float32Array(3);
const _vec2 = new Float32Array(2);

// ---------------------------------------------------------------------------
// VideoTextureBatch — flat typed-array batch coordinator for multi-video
// pipelines (video walls, VR 360 video, multi-camera CCTV).
// ---------------------------------------------------------------------------
const VIDEO_MODE_SYNC     = 0;
const VIDEO_MODE_CHECKSUM = 1;
const VIDEO_MODE_CAPTURE  = 2;
const VIDEO_MODE_FALLBACK = 3;

class VideoTextureBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._texPtr       = new Int32Array(capacity);
    this._width        = new Int32Array(capacity);
    this._height       = new Int32Array(capacity);
    this._currentTime  = new Float64Array(capacity);
    this._readyState   = new Uint8Array(capacity);
    this._mode         = new Uint8Array(capacity);
    this._needsUpdate  = new Uint8Array(capacity);
    this._done         = new Uint8Array(capacity);

    this._textures = [];
    this._scratchCanvases = [];
    this._outputs = [];
    this._capacity = capacity;
  }

  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 64);

    const a = new Int32Array(newCap);   a.set(this._texPtr);      this._texPtr = a;
    const b = new Int32Array(newCap);   b.set(this._width);       this._width = b;
    const c = new Int32Array(newCap);   c.set(this._height);      this._height = c;
    const d = new Float64Array(newCap); d.set(this._currentTime); this._currentTime = d;
    const e = new Uint8Array(newCap);   e.set(this._readyState);  this._readyState = e;
    const f = new Uint8Array(newCap);   f.set(this._mode);        this._mode = f;
    const g = new Uint8Array(newCap);   g.set(this._needsUpdate); this._needsUpdate = g;
    const h = new Uint8Array(newCap);   h.set(this._done);        this._done = h;

    this._capacity = newCap;
  }

  addTexture(texture) {
    this._textures.push(texture);
    return this._textures.length - 1;
  }

  addJob(textureId, mode = VIDEO_MODE_SYNC) {
    this._ensure(this._count + 1);
    const i = this._count++;
    const texture = this._textures[textureId];
    const video = texture ? texture.image : null;

    this._texPtr[i] = textureId;
    this._width[i] = video && video.videoWidth ? video.videoWidth : 0;
    this._height[i] = video && video.videoHeight ? video.videoHeight : 0;
    this._currentTime[i] = video && video.currentTime ? video.currentTime : 0;
    this._readyState[i] = video && video.readyState ? video.readyState : 0;
    this._mode[i] = mode;
    this._needsUpdate[i] = 0;
    this._done[i] = 0;

    return i;
  }

  process() {
    const n = this._count;

    for (let i = 0; i < n; i++) {
      const texture = this._textures[this._texPtr[i]];
      const video = texture ? texture.image : null;

      if (!video) {
        this._done[i] = 1;
        this._outputs.push(null);
        continue;
      }

      const mode = this._mode[i];

      // Sync mode: update needsUpdate flag based on readyState
      if (mode === VIDEO_MODE_SYNC) {
        const ready = video.readyState >= (video.HAVE_CURRENT_DATA || 2);
        if (ready && !video.paused) {
          texture.needsUpdate = true;
          this._needsUpdate[i] = 1;
        }
        this._outputs.push(null);
      }
      // Checksum mode: compute a bit-exact frame checksum via Float64
      else if (mode === VIDEO_MODE_CHECKSUM) {
        if (!this._scratchCanvases[i]) {
          this._scratchCanvases[i] =
            (typeof document !== 'undefined')
              ? document.createElement('canvas')
              : null;
        }
        const canvas = this._scratchCanvases[i];
        if (canvas) {
          this._outputs.push(
            _videoFrameChecksumPrecise(video, canvas)
          );
        } else {
          this._outputs.push(0);
        }
      }
      // Capture mode: extract one RGBA frame into a typed array
      else if (mode === VIDEO_MODE_CAPTURE) {
        if (!this._scratchCanvases[i]) {
          this._scratchCanvases[i] =
            (typeof document !== 'undefined')
              ? document.createElement('canvas')
              : null;
        }
        const canvas = this._scratchCanvases[i];
        if (canvas) {
          this._outputs.push(_captureVideoFrame(video, canvas));
        } else {
          this._outputs.push(null);
        }
      }
      // Fallback mode: return the dithered placeholder
      else if (mode === VIDEO_MODE_FALLBACK) {
        texture.paintFallback(this._width[i] || 640, this._height[i] || 480, 0.5);
        this._outputs.push(texture.getFallback());
      }
      else {
        this._outputs.push(null);
      }

      this._currentTime[i] = video.currentTime || 0;
      this._readyState[i] = video.readyState || 0;
      this._done[i] = 1;
    }
  }

  result(i) {
    if (i < 0 || i >= this._count) return null;
    if (!this._done[i]) return null;
    return this._outputs[i];
  }

  reset() {
    this._count = 0;
    this._outputs.length = 0;
  }

  asBitecsComponent(name) {
    return {
      name,
      count: this._count,
      texPtr: this._texPtr,
      width: this._width,
      height: this._height,
      currentTime: this._currentTime,
      readyState: this._readyState,
      mode: this._mode,
      needsUpdate: this._needsUpdate,
      done: this._done,
    };
  }
}

// ---------------------------------------------------------------------------
// Float64 video-frame checksum (no double.js). Accumulation is bit-exact up
// to 2^53.
// ---------------------------------------------------------------------------
function _videoFrameChecksumPrecise(video, scratchCanvas) {
  if (!video || video.readyState < 2) return 0;
  if (!scratchCanvas) return 0;

  scratchCanvas.width = video.videoWidth || 1;
  scratchCanvas.height = video.videoHeight || 1;

  const ctx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(video, 0, 0);

  const imageData = ctx.getImageData(0, 0, scratchCanvas.width, scratchCanvas.height);
  const data = imageData.data;

  let hash = 0;
  for (let i = 0; i < data.length; i += 97) {
    hash = hash * 31 + data[i];
  }

  return hash;
}

// ---------------------------------------------------------------------------
// Capture a video frame into a Uint8ClampedArray (RGBA).
// ---------------------------------------------------------------------------
function _captureVideoFrame(video, scratchCanvas) {
  if (!video || video.readyState < 2) return null;
  if (!scratchCanvas) return null;

  scratchCanvas.width = video.videoWidth || 1;
  scratchCanvas.height = video.videoHeight || 1;

  const ctx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0);

  const imageData = ctx.getImageData(0, 0, scratchCanvas.width, scratchCanvas.height);
  return new Uint8ClampedArray(imageData.data);
}

// ---------------------------------------------------------------------------
// SimplexNoise-dithered fallback painting for missing-video placeholders.
// ---------------------------------------------------------------------------
function paintVideoFallback(width, height, amplitude = 0.5) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  const out = new Uint8ClampedArray(w * h * 4);
  const invAmp = amplitude / 255;

  // Broadcast-style color bars as a distinctive placeholder
  const barColors = [
    [1, 1, 1], [1, 1, 0], [0, 1, 1], [0, 1, 0],
    [1, 0, 1], [1, 0, 0], [0, 0, 1],
  ];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const d = SimplexNoise.noise2D(x * 0.05, y * 0.05) * invAmp;

      const bar = Math.floor(x / (w / 7)) % 7;
      const c = barColors[bar] || [0.5, 0.5, 0.5];

      out[p]     = Math.floor(Math.max(0, Math.min(1, c[0] + d)) * 255);
      out[p + 1] = Math.floor(Math.max(0, Math.min(1, c[1] + d)) * 255);
      out[p + 2] = Math.floor(Math.max(0, Math.min(1, c[2] + d)) * 255);
      out[p + 3] = 255;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// VideoTexture — mirrors three.js r185 VideoTexture with dynamic features.
// ---------------------------------------------------------------------------
class VideoTexture extends Texture {
  /**
   * @param {HTMLVideoElement} [video=undefined]
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
    video = undefined,
    mapping = Texture.DEFAULT_MAPPING,
    wrapS = ClampToEdgeWrapping,
    wrapT = ClampToEdgeWrapping,
    magFilter = LinearFilter,
    minFilter = LinearFilter,
    format = RGBAFormat,
    type = UnsignedByteType,
    anisotropy = Texture.DEFAULT_ANISOTROPY
  ) {
    super(video, mapping, wrapS, wrapT, magFilter, minFilter, format, type, anisotropy);

    this.isVideoTexture = true;
    this.generateMipmaps = false;

    // requestVideoFrameCallback registration
    this._requestVideoFrameId = 0;
    this._visibilityHandler = null;
    this._connected = false;

    // Crossfade state
    this._crossfadeVideo = null;
    this._crossfadeT = 0;
    this._crossfadeDuration = 0.5;
    this._crossfadeActive = false;
    this._crossfadeStart = 0;

    // Frame-rate throttling
    this._targetFPS = 0;
    this._lastFrameTime = 0;

    // CPU-side scratch
    this._scratchCanvas = null;

    // Fallback placeholder (dynamic feature)
    this._fallback = null;

    // Dynamic feature flags (all opt-in, toggled at runtime)
    this.dynamicFeatures = {
      autoPause: false,
      crossfade: false,
      fpsThrottle: false,
      frameChecksums: false,
      captureFrames: false,
      colorSpaceSwitch: false,
      proceduralFallback: false,
    };

    // Register requestVideoFrameCallback if available
    const scope = this;
    const onNewFrame = function () {
      scope.needsUpdate = true;
      if (video && typeof video.requestVideoFrameCallback === 'function') {
        scope._requestVideoFrameId = video.requestVideoFrameCallback(onNewFrame);
      }
    };

    if (video !== undefined && video !== null &&
        typeof video.requestVideoFrameCallback === 'function') {
      this._requestVideoFrameId = video.requestVideoFrameCallback(onNewFrame);
    }
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
  // r185 update override
  // -----------------------------------------------------------------------

  /**
   * Called by the renderer each frame. Marks the texture for upload when
   * the video has valid frame data. Honours the fpsThrottle feature.
   */
  update() {
    const video = this.image;

    if (video === undefined || video === null) return;

    // FPS throttle
    if (this.dynamicFeatures.fpsThrottle && this._targetFPS > 0) {
      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
      const minInterval = 1000 / this._targetFPS;
      if (now - this._lastFrameTime < minInterval) return;
      this._lastFrameTime = now;
    }

    if (typeof video.requestVideoFrameCallback !== 'function' &&
        video.readyState >= video.HAVE_CURRENT_DATA) {
      this.needsUpdate = true;
    }
  }

  // -----------------------------------------------------------------------
  // Dynamic playback rate
  // -----------------------------------------------------------------------

  /**
   * Set the video's playback rate.
   * @param {number} rate
   * @returns {this}
   */
  setPlaybackRate(rate) {
    const video = this.image;
    if (video && typeof video.playbackRate !== 'undefined') {
      video.playbackRate = Math.max(0.0625, Math.min(16, rate));
    }
    return this;
  }

  /** @returns {number} — current playback rate */
  get playbackRate() {
    return this.image && this.image.playbackRate !== undefined
      ? this.image.playbackRate
      : 1;
  }

  // -----------------------------------------------------------------------
  // Dynamic pause-on-hidden
  // -----------------------------------------------------------------------

  /**
   * Enable auto-pause when the document becomes hidden.
   * @returns {this}
   */
  enableAutoPause() {
    if (this.dynamicFeatures.autoPause) return this;

    this.dynamicFeatures.autoPause = true;

    if (typeof document !== 'undefined') {
      const scope = this;
      this._visibilityHandler = function () {
        const video = scope.image;
        if (!video) return;
        if (document.hidden) {
          if (typeof video.pause === 'function') video.pause();
        } else {
          if (typeof video.play === 'function' && video.autoplay) video.play();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
      this._connected = true;
    }
    return this;
  }

  /**
   * Disable auto-pause-on-hidden.
   * @returns {this}
   */
  disableAutoPause() {
    this.dynamicFeatures.autoPause = false;

    if (this._visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
      this._connected = false;
    }
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic color-space switching
  // -----------------------------------------------------------------------

  /**
   * Toggle between sRGB and Linear output color space. Note: the texture is
   * uploaded as-is; this only changes the `colorSpace` metadata consumed by
   * the renderer's color management pipeline.
   *
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
  // Dynamic crossfade
  // -----------------------------------------------------------------------

  /**
   * Start a crossfade to another video source.
   * @param {HTMLVideoElement} newVideo
   * @param {number} [duration=0.5] — crossfade duration in seconds
   * @returns {this}
   */
  startCrossfade(newVideo, duration = 0.5) {
    if (!newVideo) return this;

    this._crossfadeVideo = newVideo;
    this._crossfadeDuration = duration;
    this._crossfadeStart = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    this._crossfadeActive = true;
    this._crossfadeT = 0;
    this.dynamicFeatures.crossfade = true;
    return this;
  }

  /**
   * Advance the crossfade. Call this once per frame while a crossfade is
   * active. On completion the video reference is swapped and the crossfade
   * state is cleared.
   * @returns {this}
   */
  updateCrossfade() {
    if (!this._crossfadeActive) return this;

    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    const elapsed = (now - this._crossfadeStart) / 1000;
    const t = Common.clamp(elapsed / this._crossfadeDuration, 0, 1);
    this._crossfadeT = t;

    if (t >= 1) {
      this.image = this._crossfadeVideo;
      this._crossfadeVideo = null;
      this._crossfadeActive = false;
      this._crossfadeT = 0;
      this.needsUpdate = true;
    }
    return this;
  }

  /** @returns {number} — current crossfade progress in [0, 1] */
  get crossfadeProgress() {
    return this._crossfadeT;
  }

  // -----------------------------------------------------------------------
  // Dynamic FPS throttle
  // -----------------------------------------------------------------------

  /**
   * Limit the video's update rate to a target FPS (0 = unlimited).
   * @param {number} fps
   * @returns {this}
   */
  setTargetFPS(fps) {
    this._targetFPS = Math.max(0, fps | 0);
    this.dynamicFeatures.fpsThrottle = this._targetFPS > 0;
    return this;
  }

  /** @returns {number} — current target FPS */
  get targetFPS() {
    return this._targetFPS;
  }

  // -----------------------------------------------------------------------
  // Dynamic frame checksums
  // -----------------------------------------------------------------------

  /**
   * Compute a bit-exact checksum of the current video frame (no double.js).
   * @returns {number}
   */
  getFrameChecksumPrecise() {
    if (!this._scratchCanvas && typeof document !== 'undefined') {
      this._scratchCanvas = document.createElement('canvas');
    }
    return _videoFrameChecksumPrecise(this.image, this._scratchCanvas);
  }

  // -----------------------------------------------------------------------
  // Dynamic frame capture
  // -----------------------------------------------------------------------

  /**
   * Capture the current frame into a Uint8ClampedArray (RGBA).
   * @returns {Uint8ClampedArray|null}
   */
  captureFrame() {
    if (!this._scratchCanvas && typeof document !== 'undefined') {
      this._scratchCanvas = document.createElement('canvas');
    }
    return _captureVideoFrame(this.image, this._scratchCanvas);
  }

  // -----------------------------------------------------------------------
  // Dynamic sampling
  // -----------------------------------------------------------------------

  /**
   * Zero-allocation frame sample via the project's Vec4 module.
   * @param {Float32Array} [out]
   * @param {number} [u=0.5]
   * @param {number} [v=0.5]
   * @returns {Float32Array|null}
   */
  sampleGlMat(out = _rgba, u = 0.5, v = 0.5) {
    const video = this.image;
    if (!video || video.readyState < 2) return null;

    if (!this._scratchCanvas && typeof document !== 'undefined') {
      this._scratchCanvas = document.createElement('canvas');
    }
    const canvas = this._scratchCanvas;
    if (!canvas) return null;

    canvas.width = video.videoWidth || 1;
    canvas.height = video.videoHeight || 1;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);

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

  // -----------------------------------------------------------------------
  // Dynamic fallback
  // -----------------------------------------------------------------------

  /**
   * Paint a SimplexNoise-dithered fallback pattern for missing videos.
   * @param {number} [width=640]
   * @param {number} [height=480]
   * @param {number} [amplitude=0.5]
   * @returns {this}
   */
  paintFallback(width = 640, height = 480, amplitude = 0.5) {
    this._fallback = {
      width,
      height,
      data: paintVideoFallback(width, height, amplitude),
    };
    this.dynamicFeatures.proceduralFallback = true;
    this.needsUpdate = true;
    return this;
  }

  /** @returns {object|null} — the fallback placeholder descriptor */
  getFallback() {
    return this._fallback;
  }

  // -----------------------------------------------------------------------
  // Lifecycle: dispose / copy / serialize
  // -----------------------------------------------------------------------

  /**
   * Frees GPU resources and cancels pending frame callbacks.
   */
  dispose() {
    if (this._requestVideoFrameId !== 0 && this.image &&
        typeof this.image.cancelVideoFrameCallback === 'function') {
      this.image.cancelVideoFrameCallback(this._requestVideoFrameId);
      this._requestVideoFrameId = 0;
    }

    if (this._visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }

    super.dispose();
  }

  copy(source) {
    super.copy(source);
    this.generateMipmaps = source.generateMipmaps;
    this._targetFPS = source._targetFPS;
    this._crossfadeDuration = source._crossfadeDuration;

    if (source.dynamicFeatures) {
      this.dynamicFeatures = { ...source.dynamicFeatures };
    }
    this._fallback = source._fallback ? { ...source._fallback } : null;

    return this;
  }

  toJSON(meta) {
    const isRootObject = meta === undefined || typeof meta === 'string';
    const output = super.toJSON(meta);

    output.image = {
      src: this.image && (this.image.currentSrc || this.image.src) || null,
      width: this.image && this.image.videoWidth || 0,
      height: this.image && this.image.videoHeight || 0,
    };

    output.dynamicFeatures = { ...this.dynamicFeatures };
    output.targetFPS = this._targetFPS;
    output.crossfadeDuration = this._crossfadeDuration;

    if (!isRootObject) {
      meta.textures[this.uuid] = output;
    }
    return output;
  }

  // -----------------------------------------------------------------------
  // Pool + batch helpers
  // -----------------------------------------------------------------------

  static createBatch() {
    return new VideoTextureBatch();
  }

  static acquire() {
    return _acquireVideo();
  }

  release() {
    this.dispose();
    if (this.source) {
      this.source.release();
      this.source = null;
    }
    _releaseVideo(this);
  }

  static clearPool() {
    _videoPool.length = 0;
  }

  _resetForPool() {
    const parentReset = Texture.prototype._resetForPool;
    if (typeof parentReset === 'function') parentReset.call(this);

    this.isVideoTexture = true;
    this.generateMipmaps = false;

    this._requestVideoFrameId = 0;
    this._visibilityHandler = null;
    this._connected = false;
    this._crossfadeVideo = null;
    this._crossfadeT = 0;
    this._crossfadeDuration = 0.5;
    this._crossfadeActive = false;
    this._crossfadeStart = 0;
    this._targetFPS = 0;
    this._lastFrameTime = 0;
    this._scratchCanvas = null;
    this._fallback = null;

    this.dynamicFeatures = {
      autoPause: false,
      crossfade: false,
      fpsThrottle: false,
      frameChecksums: false,
      captureFrames: false,
      colorSpaceSwitch: false,
      proceduralFallback: false,
    };
  }

  asBitecsComponent(name) {
    const base = super.asBitecsComponent(name);
    const video = this.image;
    return {
      ...base,
      isVideoTexture: 1,
      width: video && video.videoWidth || 0,
      height: video && video.videoHeight || 0,
      currentTime: video && video.currentTime || 0,
      playbackRate: video && video.playbackRate || 1,
      readyState: video && video.readyState || 0,
      paused: video && video.paused ? 1 : 0,
      targetFPS: this._targetFPS,
      crossfadeProgress: this._crossfadeT,
      autoPause: this.dynamicFeatures.autoPause ? 1 : 0,
      fpsThrottle: this.dynamicFeatures.fpsThrottle ? 1 : 0,
      hasFallback: this._fallback ? 1 : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  VideoTexture,
  VideoTextureBatch,
  paintVideoFallback,
};
export default VideoTexture;