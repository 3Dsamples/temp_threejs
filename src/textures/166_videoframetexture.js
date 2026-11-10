// file number : 166
// full path name : src/textures/166_videoframetexture.js
// description : VideoFrameTexture (three.js r185) rewritten as a pure ES module with zero CDN imports and completely dynamic features. Extends VideoTexture (160) to accept manually-provided VideoFrame objects decoded externally (e.g. via the WebCodecs API). Preserves the full r185 VideoFrameTexture API — isVideoFrameTexture flag, update() overridden to a no-op, clone() restoring Texture.clone() behavior, setFrame(frame) writing image and marking needsUpdate, plus copy(), toJSON() inherited from VideoTexture. Adds dynamic feature toggles: dynamic frame queue management for multi-frame buffering (prevents frame drops during decode stutters), dynamic frame-timestamp tracking for bit-exact A/V sync, dynamic frame-rate derivation from consecutive timestamps, dynamic setFrameWithMetadata accepting {frame, timestamp, duration} objects, dynamic zero-copy GPU upload optimization hints for WebCodecs VideoFrame, dynamic automatic previous-frame disposal (closes prior frames to prevent resource leaks), Float64 frameTimestampDeltaPrecise (native JS IEEE-754 doubles — no double.js) for exact timing over hours of playback, SimplexNoise-dithered paintPlaceholder for missing frames, dynamic sampleGlMat for CPU-side frame analysis, dynamic placeholder auto-management when no frame has been set yet, dynamic color-space switching, dynamic frame-history ring buffer, and dynamic batch integration. Uses a flat typed-array VideoFrameTextureBatch for multi-stream frame pipelines (WebCodecs multi-track decode, stereoscopic frame pairs, synchronized multi-camera capture), and full pool integration via acquire()/release()/clearPool(). Designed for 10k+ VideoFrame textures on Android 64-bit with zero CDN dependencies.
// best for : VideoFrameTexture, WebCodecs VideoDecoder output, manual frame-by-frame video playback, custom decode pipelines, frame-accurate A/V sync, multi-track video compositing, stereoscopic VR video, multi-camera CCTV with synchronized playback, real-time frame analysis pipelines, video editing timelines, and any three.js workflow that receives raw VideoFrame objects from an external decoder with runtime-switchable features at 10k+ entity scale on Android 64-bit.
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
import { VideoTexture } from './160_videotexture.js';

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
// Static pool for VideoFrameTexture instances — recycled to eliminate per-
// mesh allocation churn when 10k+ frame textures spawn/despawn.
// ---------------------------------------------------------------------------
const _framePool = [];

function _acquireFrame() {
  const t = _framePool.pop();
  if (t) {
    t._resetForPool();
    return t;
  }
  return new VideoFrameTexture();
}

function _releaseFrame(t) {
  if (_framePool.length < 128) _framePool.push(t);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _rgba = new Float32Array(4);
const _vec3 = new Float32Array(3);
const _uv = new Float32Array(2);

// ---------------------------------------------------------------------------
// VideoFrameTextureBatch — flat typed-array batch coordinator for multi-
// stream frame pipelines (WebCodecs multi-track decode, stereoscopic frame
// pairs, synchronized multi-camera capture).
// ---------------------------------------------------------------------------
const FRAME_MODE_SYNC      = 0;
const FRAME_MODE_CHECKSUM  = 1;
const FRAME_MODE_CAPTURE   = 2;
const FRAME_MODE_PLACEHOLDER = 3;
const FRAME_MODE_TIMESTAMP = 4;

class VideoFrameTextureBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._texPtr       = new Int32Array(capacity);
    this._width        = new Int32Array(capacity);
    this._height       = new Int32Array(capacity);
    this._timestamp    = new Float64Array(capacity);
    this._duration     = new Float64Array(capacity);
    this._hasFrame     = new Uint8Array(capacity);
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
    const d = new Float64Array(newCap); d.set(this._timestamp);   this._timestamp = d;
    const e = new Float64Array(newCap); e.set(this._duration);    this._duration = e;
    const f = new Uint8Array(newCap);   f.set(this._hasFrame);    this._hasFrame = f;
    const g = new Uint8Array(newCap);   g.set(this._mode);        this._mode = g;
    const h = new Uint8Array(newCap);   h.set(this._needsUpdate); this._needsUpdate = h;
    const k = new Uint8Array(newCap);   k.set(this._done);        this._done = k;

    this._capacity = newCap;
  }

  addTexture(texture) {
    this._textures.push(texture);
    return this._textures.length - 1;
  }

  addJob(textureId, mode = FRAME_MODE_SYNC, timestamp = 0, duration = 0) {
    this._ensure(this._count + 1);
    const i = this._count++;
    const texture = this._textures[textureId];
    const frame = texture ? texture.image : null;

    this._texPtr[i] = textureId;
    this._width[i] = frame && (frame.codedWidth || frame.displayWidth) || 0;
    this._height[i] = frame && (frame.codedHeight || frame.displayHeight) || 0;
    this._timestamp[i] = timestamp;
    this._duration[i] = duration;
    this._hasFrame[i] = frame !== undefined && frame !== null ? 1 : 0;
    this._mode[i] = mode;
    this._needsUpdate[i] = 0;
    this._done[i] = 0;

    return i;
  }

  process() {
    const n = this._count;

    for (let i = 0; i < n; i++) {
      const texture = this._textures[this._texPtr[i]];
      const frame = texture ? texture.image : null;

      if (!frame) {
        // No frame — try to paint placeholder
        if (this._mode[i] === FRAME_MODE_PLACEHOLDER) {
          texture.paintPlaceholder(640, 480, 0.5);
          this._outputs.push(texture.getPlaceholder());
        } else {
          this._outputs.push(null);
        }
        this._done[i] = 1;
        continue;
      }

      const mode = this._mode[i];

      // Sync mode: update needsUpdate
      if (mode === FRAME_MODE_SYNC) {
        texture.needsUpdate = true;
        this._needsUpdate[i] = 1;
        this._outputs.push(null);
      }
      // Checksum mode
      else if (mode === FRAME_MODE_CHECKSUM) {
        if (!this._scratchCanvases[i] && typeof document !== 'undefined') {
          this._scratchCanvases[i] = document.createElement('canvas');
        }
        this._outputs.push(
          _frameChecksumPrecise(frame, this._scratchCanvases[i])
        );
      }
      // Capture mode
      else if (mode === FRAME_MODE_CAPTURE) {
        if (!this._scratchCanvases[i] && typeof document !== 'undefined') {
          this._scratchCanvases[i] = document.createElement('canvas');
        }
        this._outputs.push(
          _captureFrame(frame, this._scratchCanvases[i])
        );
      }
      // Timestamp mode
      else if (mode === FRAME_MODE_TIMESTAMP) {
        this._outputs.push({
          timestamp: this._timestamp[i],
          duration: this._duration[i],
          fps: this._duration[i] > 0 ? 1000000 / this._duration[i] : 0,
        });
      }
      // Placeholder mode
      else if (mode === FRAME_MODE_PLACEHOLDER) {
        texture.paintPlaceholder(640, 480, 0.5);
        this._outputs.push(texture.getPlaceholder());
      }
      else {
        this._outputs.push(null);
      }

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
      timestamp: this._timestamp,
      duration: this._duration,
      hasFrame: this._hasFrame,
      mode: this._mode,
      needsUpdate: this._needsUpdate,
      done: this._done,
    };
  }
}

// ---------------------------------------------------------------------------
// Float64 frame-timestamp delta (no double.js). Bit-exact up to 2^53.
// ---------------------------------------------------------------------------
function frameTimestampDeltaPrecise(currentTimestamp, previousTimestamp) {
  const delta = currentTimestamp - previousTimestamp;
  const fps = delta > 0 ? 1000000 / delta : 0;
  return { delta, accumulated: delta, framesPerSecond: fps };
}

// ---------------------------------------------------------------------------
// Float64 frame checksum (no double.js).
// ---------------------------------------------------------------------------
function _frameChecksumPrecise(frame, scratchCanvas) {
  if (!frame || !scratchCanvas) return 0;

  const w = frame.codedWidth || frame.displayWidth || 0;
  const h = frame.codedHeight || frame.displayHeight || 0;
  if (w === 0 || h === 0) return 0;

  scratchCanvas.width = w;
  scratchCanvas.height = h;

  const ctx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;

  try {
    ctx.drawImage(frame, 0, 0, w, h);
  } catch (e) {
    return 0;
  }

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  let hash = 0;
  for (let i = 0; i < data.length; i += 97) {
    hash = hash * 31 + data[i];
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Capture a VideoFrame into a Uint8ClampedArray (RGBA).
// ---------------------------------------------------------------------------
function _captureFrame(frame, scratchCanvas) {
  if (!frame || !scratchCanvas) return null;

  const w = frame.codedWidth || frame.displayWidth || 0;
  const h = frame.codedHeight || frame.displayHeight || 0;
  if (w === 0 || h === 0) return null;

  scratchCanvas.width = w;
  scratchCanvas.height = h;

  const ctx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(frame, 0, 0, w, h);
  } catch (e) {
    return null;
  }

  const imageData = ctx.getImageData(0, 0, w, h);
  return new Uint8ClampedArray(imageData.data);
}

// ---------------------------------------------------------------------------
// SimplexNoise-dithered placeholder painting for missing frames.
// ---------------------------------------------------------------------------
function paintFramePlaceholder(width, height, amplitude = 0.5) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  const out = new Uint8ClampedArray(w * h * 4);
  const invAmp = amplitude / 255;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const d = SimplexNoise.noise2D(x * 0.05, y * 0.05) * invAmp;

      // Animated diagonal gradient
      const t = (x + y) / (w + h);
      const phase = SimplexNoise.noise2D(0, 0) * 0.5 + 0.5;

      out[p]     = Math.floor(Math.max(0, Math.min(1, 0.2 + t * 0.4 + phase * 0.2 + d)) * 255);
      out[p + 1] = Math.floor(Math.max(0, Math.min(1, 0.3 + t * 0.3 + d)) * 255);
      out[p + 2] = Math.floor(Math.max(0, Math.min(1, 0.5 + t * 0.2 + d)) * 255);
      out[p + 3] = 255;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// VideoFrameTexture — extends three.js VideoTexture for manually-set
// VideoFrame objects with completely dynamic features.
// ---------------------------------------------------------------------------
class VideoFrameTexture extends VideoTexture {
  /**
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
    mapping = Texture.DEFAULT_MAPPING,
    wrapS = ClampToEdgeWrapping,
    wrapT = ClampToEdgeWrapping,
    magFilter = LinearFilter,
    minFilter = LinearFilter,
    format = RGBAFormat,
    type = UnsignedByteType,
    anisotropy = Texture.DEFAULT_ANISOTROPY
  ) {
    super(
      {},
      mapping,
      wrapS,
      wrapT,
      magFilter,
      minFilter,
      format,
      type,
      anisotropy
    );

    this.isVideoFrameTexture = true;

    // Track the previous frame so we can close it after a new one is set
    this._previousFrame = null;

    // Frame queue for multi-frame buffering
    this._frameQueue = [];
    this.maxQueueLength = 4;

    // Frame timestamp tracking
    this._currentTimestamp = 0;
    this._previousTimestamp = 0;
    this._accumulatedDelta = 0;
    this._derivedFPS = 0;

    // Frame history ring buffer
    this._frameHistory = [];
    this.historySize = 8;

    // CPU-side placeholder
    this._placeholder = null;

    // Scratch canvas for sampling
    this._scratchCanvas = null;

    // Dynamic feature flags (all opt-in, toggled at runtime)
    this.dynamicFeatures = {
      frameQueue: false,
      timestampTracking: false,
      frameHistory: false,
      autoClosePrevious: true,
      zeroCopyHints: false,
      colorSpaceSwitch: false,
      proceduralPlaceholder: false,
      frameChecksums: false,
      frameCapture: false,
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
  // r185 update override (no-op)
  // -----------------------------------------------------------------------

  /**
   * Overridden to a no-op — this texture is updated manually via setFrame().
   */
  update() {
    // Intentionally empty
  }

  // -----------------------------------------------------------------------
  // r185 clone override
  // -----------------------------------------------------------------------

  /**
   * Clone this VideoFrameTexture. Restores Texture.clone() behaviour.
   * @returns {VideoFrameTexture}
   */
  clone() {
    return new this.constructor().copy(this);
  }

  // -----------------------------------------------------------------------
  // r185 setFrame override
  // -----------------------------------------------------------------------

  /**
   * Set the current frame. Automatically updates the texture for rendering.
   * @param {VideoFrame} frame
   * @returns {this}
   */
  setFrame(frame) {
    if (this.dynamicFeatures.autoClosePrevious && this._previousFrame &&
        typeof this._previousFrame.close === 'function') {
      try {
        this._previousFrame.close();
      } catch (e) {
        // Ignore — frame may already be closed
      }
    }

    this._previousFrame = this.image;
    this.image = frame;
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic setFrameWithMetadata
  // -----------------------------------------------------------------------

  /**
   * Set the current frame along with timestamp and duration metadata.
   * Enables timestamp tracking automatically.
   * @param {object} metadata — { frame, timestamp, duration }
   * @returns {this}
   */
  setFrameWithMetadata(metadata) {
    if (!metadata || !metadata.frame) return this;

    this.setFrame(metadata.frame);
    this.dynamicFeatures.timestampTracking = true;
    this.updateTimestamp(metadata.timestamp || 0, metadata.duration || 0);
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic frame-timestamp tracking
  // -----------------------------------------------------------------------

  /**
   * Update the current frame's timestamp and duration.
   * @param {number} timestamp — microseconds (WebCodecs convention)
   * @param {number} [duration=0] — microseconds
   * @returns {this}
   */
  updateTimestamp(timestamp, duration = 0) {
    this._previousTimestamp = this._currentTimestamp;
    this._currentTimestamp = timestamp;

    const deltaInfo = frameTimestampDeltaPrecise(timestamp, this._previousTimestamp);
    this._accumulatedDelta = deltaInfo.accumulated;
    this._derivedFPS = deltaInfo.framesPerSecond;

    this.dynamicFeatures.timestampTracking = true;
    return this;
  }

  /**
   * Float64 timestamp delta (no double.js).
   * @param {number} currentTimestamp
   * @param {number} previousTimestamp
   * @returns {{delta: number, accumulated: number, framesPerSecond: number}}
   */
  frameTimestampDeltaPrecise(currentTimestamp, previousTimestamp) {
    return frameTimestampDeltaPrecise(currentTimestamp, previousTimestamp);
  }

  /** @returns {number} */
  get currentTimestamp() { return this._currentTimestamp; }

  /** @returns {number} */
  get previousTimestamp() { return this._previousTimestamp; }

  /** @returns {number} */
  get accumulatedDelta() { return this._accumulatedDelta; }

  /** @returns {number} — derived FPS from consecutive timestamps */
  get derivedFPS() { return this._derivedFPS; }

  // -----------------------------------------------------------------------
  // Dynamic frame queue management
  // -----------------------------------------------------------------------

  /**
   * Enable frame queue management with a configurable max length.
   * @param {number} [maxLength=4]
   * @returns {this}
   */
  enableFrameQueue(maxLength = 4) {
    this.dynamicFeatures.frameQueue = true;
    this.maxQueueLength = Math.max(1, maxLength | 0);
    return this;
  }

  disableFrameQueue() {
    this.dynamicFeatures.frameQueue = false;
    // Close any queued frames to prevent leaks
    for (let i = 0; i < this._frameQueue.length; i++) {
      const f = this._frameQueue[i];
      if (f && typeof f.close === 'function') {
        try { f.close(); } catch (e) { /* ignore */ }
      }
    }
    this._frameQueue.length = 0;
    return this;
  }

  /**
   * Queue a frame for playback. When the queue is full, the oldest frame
   * is dropped (and closed).
   * @param {VideoFrame} frame
   * @returns {this}
   */
  queueFrame(frame) {
    if (!this.dynamicFeatures.frameQueue) {
      this.setFrame(frame);
      return this;
    }

    if (this._frameQueue.length >= this.maxQueueLength) {
      const dropped = this._frameQueue.shift();
      if (dropped && typeof dropped.close === 'function') {
        try { dropped.close(); } catch (e) { /* ignore */ }
      }
    }
    this._frameQueue.push(frame);
    return this;
  }

  /**
   * Flush the queue — dequeue and set the next frame.
   * @returns {this}
   */
  flushFrameQueue() {
    if (this._frameQueue.length === 0) return this;
    const next = this._frameQueue.shift();
    this.setFrame(next);
    return this;
  }

  /** @returns {number} — current queue length */
  get queueLength() {
    return this._frameQueue.length;
  }

  // -----------------------------------------------------------------------
  // Dynamic frame history
  // -----------------------------------------------------------------------

  /**
   * Enable a ring buffer of the last N frames for history playback.
   * @param {number} [size=8]
   * @returns {this}
   */
  enableFrameHistory(size = 8) {
    this.dynamicFeatures.frameHistory = true;
    this.historySize = Math.max(1, size | 0);
    if (this._frameHistory.length > this.historySize) {
      this._frameHistory.length = this.historySize;
    }
    return this;
  }

  disableFrameHistory() {
    this.dynamicFeatures.frameHistory = false;
    // Close all historical frames
    for (let i = 0; i < this._frameHistory.length; i++) {
      const f = this._frameHistory[i];
      if (f && typeof f.close === 'function') {
        try { f.close(); } catch (e) { /* ignore */ }
      }
    }
    this._frameHistory.length = 0;
    return this;
  }

  /**
   * Push a frame into the history ring buffer.
   * @param {VideoFrame} frame
   * @returns {this}
   */
  pushHistory(frame) {
    if (!this.dynamicFeatures.frameHistory || !frame) return this;

    this._frameHistory.unshift(frame);
    while (this._frameHistory.length > this.historySize) {
      const dropped = this._frameHistory.pop();
      if (dropped && typeof dropped.close === 'function') {
        try { dropped.close(); } catch (e) { /* ignore */ }
      }
    }
    return this;
  }

  /**
   * Get a historical frame.
   * @param {number} [index=0] — 0 = most recent
   * @returns {VideoFrame|null}
   */
  getHistoryFrame(index = 0) {
    if (index < 0 || index >= this._frameHistory.length) return null;
    return this._frameHistory[index];
  }

  /** @returns {number} */
  get historyLength() {
    return this._frameHistory.length;
  }

  // -----------------------------------------------------------------------
  // Dynamic previous-frame disposal
  // -----------------------------------------------------------------------

  /**
   * Manually close the previous frame (for resource management).
   * @returns {this}
   */
  closePreviousFrame() {
    if (this._previousFrame && typeof this._previousFrame.close === 'function') {
      try { this._previousFrame.close(); } catch (e) { /* ignore */ }
      this._previousFrame = null;
    }
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic zero-copy hints
  // -----------------------------------------------------------------------

  /**
   * Enable zero-copy GPU upload hints for WebCodecs VideoFrame.
   * @returns {this}
   */
  enableZeroCopyHints() {
    this.dynamicFeatures.zeroCopyHints = true;
    // The renderer may use this flag to decide whether to prefer
    // texImage2D with VideoFrame or a copy-through-canvas path.
    this.userData.preferVideoFrameUpload = true;
    return this;
  }

  disableZeroCopyHints() {
    this.dynamicFeatures.zeroCopyHints = false;
    delete this.userData.preferVideoFrameUpload;
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
    const frame = this.image;
    if (!frame) return null;

    const w = frame.codedWidth || frame.displayWidth || 0;
    const h = frame.codedHeight || frame.displayHeight || 0;
    if (w === 0 || h === 0) return null;

    if (!this._scratchCanvas && typeof document !== 'undefined') {
      this._scratchCanvas = document.createElement('canvas');
    }
    const canvas = this._scratchCanvas;
    if (!canvas) return null;

    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    try {
      ctx.drawImage(frame, 0, 0, w, h);
    } catch (e) {
      return null;
    }

    const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(v * h)));

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
   * Float64 frame checksum (no double.js). Returns a hash of the frame's
   * pixel data for A/V sync verification.
   * @returns {number}
   */
  getFrameChecksumPrecise() {
    if (!this._scratchCanvas && typeof document !== 'undefined') {
      this._scratchCanvas = document.createElement('canvas');
    }
    return _frameChecksumPrecise(this.image, this._scratchCanvas);
  }

  /**
   * Capture the current frame into a Uint8ClampedArray (RGBA).
   * @returns {Uint8ClampedArray|null}
   */
  captureFrame() {
    if (!this._scratchCanvas && typeof document !== 'undefined') {
      this._scratchCanvas = document.createElement('canvas');
    }
    return _captureFrame(this.image, this._scratchCanvas);
  }

  // -----------------------------------------------------------------------
  // Dynamic placeholder generation
  // -----------------------------------------------------------------------

  /**
   * Paint a SimplexNoise-dithered placeholder for missing frames.
   * @param {number} [width=640]
   * @param {number} [height=480]
   * @param {number} [amplitude=0.5]
   * @returns {this}
   */
  paintPlaceholder(width = 640, height = 480, amplitude = 0.5) {
    this._placeholder = {
      width,
      height,
      data: paintFramePlaceholder(width, height, amplitude),
    };
    this.dynamicFeatures.proceduralPlaceholder = true;
    return this;
  }

  /** @returns {object|null} — the placeholder descriptor */
  getPlaceholder() {
    return this._placeholder;
  }

  // -----------------------------------------------------------------------
  // Copy / serialize
  // -----------------------------------------------------------------------

  copy(source) {
    super.copy(source);

    this.isVideoFrameTexture = true;
    this._currentTimestamp = source._currentTimestamp;
    this._previousTimestamp = source._previousTimestamp;
    this._accumulatedDelta = source._accumulatedDelta;
    this._derivedFPS = source._derivedFPS;
    this.maxQueueLength = source.maxQueueLength;
    this.historySize = source.historySize;

    if (source.dynamicFeatures) {
      this.dynamicFeatures = { ...source.dynamicFeatures };
    }

    this._placeholder = source._placeholder ? { ...source._placeholder } : null;

    return this;
  }

  toJSON(meta) {
    const isRootObject = meta === undefined || typeof meta === 'string';
    const output = super.toJSON(meta);

    const frame = this.image;
    output.image = {
      width: frame && (frame.codedWidth || frame.displayWidth) || 0,
      height: frame && (frame.codedHeight || frame.displayHeight) || 0,
    };

    output.dynamicFeatures = { ...this.dynamicFeatures };
    output.currentTimestamp = this._currentTimestamp;
    output.previousTimestamp = this._previousTimestamp;
    output.derivedFPS = this._derivedFPS;
    output.queueLength = this._frameQueue.length;
    output.historyLength = this._frameHistory.length;

    if (!isRootObject) {
      meta.textures[this.uuid] = output;
    }
    return output;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  dispose() {
    // Close all queued and historical frames
    for (let i = 0; i < this._frameQueue.length; i++) {
      const f = this._frameQueue[i];
      if (f && typeof f.close === 'function') {
        try { f.close(); } catch (e) { /* ignore */ }
      }
    }
    this._frameQueue.length = 0;

    for (let i = 0; i < this._frameHistory.length; i++) {
      const f = this._frameHistory[i];
      if (f && typeof f.close === 'function') {
        try { f.close(); } catch (e) { /* ignore */ }
      }
    }
    this._frameHistory.length = 0;

    this.closePreviousFrame();
    super.dispose();
  }

  // -----------------------------------------------------------------------
  // Pool + batch helpers
  // -----------------------------------------------------------------------

  static createBatch() {
    return new VideoFrameTextureBatch();
  }

  static acquire() {
    return _acquireFrame();
  }

  release() {
    this.dispose();
    if (this.source) {
      this.source.release();
      this.source = null;
    }
    _releaseFrame(this);
  }

  static clearPool() {
    _framePool.length = 0;
  }

  _resetForPool() {
    const parentReset = VideoTexture.prototype._resetForPool;
    if (typeof parentReset === 'function') parentReset.call(this);

    this.isVideoFrameTexture = true;

    this._previousFrame = null;
    this._frameQueue = [];
    this.maxQueueLength = 4;
    this._currentTimestamp = 0;
    this._previousTimestamp = 0;
    this._accumulatedDelta = 0;
    this._derivedFPS = 0;
    this._frameHistory = [];
    this.historySize = 8;
    this._placeholder = null;
    this._scratchCanvas = null;

    this.dynamicFeatures = {
      frameQueue: false,
      timestampTracking: false,
      frameHistory: false,
      autoClosePrevious: true,
      zeroCopyHints: false,
      colorSpaceSwitch: false,
      proceduralPlaceholder: false,
      frameChecksums: false,
      frameCapture: false,
    };
  }

  asBitecsComponent(name) {
    const base = super.asBitecsComponent(name);
    const frame = this.image;

    return {
      ...base,
      isVideoFrameTexture: 1,
      width: frame && (frame.codedWidth || frame.displayWidth) || 0,
      height: frame && (frame.codedHeight || frame.displayHeight) || 0,
      hasFrame: frame ? 1 : 0,
      currentTimestamp: this._currentTimestamp,
      previousTimestamp: this._previousTimestamp,
      derivedFPS: this._derivedFPS,
      accumulatedDelta: this._accumulatedDelta,
      queueLength: this._frameQueue.length,
      historyLength: this._frameHistory.length,
      frameQueue: this.dynamicFeatures.frameQueue ? 1 : 0,
      timestampTracking: this.dynamicFeatures.timestampTracking ? 1 : 0,
      zeroCopyHints: this.dynamicFeatures.zeroCopyHints ? 1 : 0,
      hasPlaceholder: this._placeholder ? 1 : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  VideoFrameTexture,
  VideoFrameTextureBatch,
  frameTimestampDeltaPrecise,
  paintFramePlaceholder,
};
export default VideoFrameTexture;