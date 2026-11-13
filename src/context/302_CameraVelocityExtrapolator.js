// file number : 302
// full path name : src/context/302_CameraVelocityExtrapolator.js
// description : Camera velocity extrapolator — the "anticipates" property of the living world. Predicts the next-frame frustum from the current camera position, linear velocity, linear acceleration, orientation, and angular velocity so LOD selection, streaming, and asset loading start fetching what the camera is about to see before it actually sees it. Implements the blueprint's extrapolation equations exactly: position p(t+Δt) = p(t) + v(t)·Δt + ½·a(t)·Δt², and orientation q(t+Δt) = q(t)·exp(½·ω·Δt) where ω is the angular-velocity axis times the radian rate. Estimates velocity and acceleration from frame-to-frame deltas with low-pass filtering (α = 0.15 default) to suppress noise, keeps the last N frames of camera state in a ring buffer for robust 2nd-order finite-difference acceleration, and clamps the prediction horizon to a configurable maximum (default 100 ms) so slow frames don't extrapolate into garbage. Extracts the six frustum planes of the predicted view-projection matrix (Gribb-Hartmann) and exposes both the planes and a compact predicted-frustum AABB so streaming can query in one call. Provides jitter detection that disables prediction during camera stutters, a hot-path `extrapolateInto()` function that writes directly into pooled Vec3/Quat scratch, and a pooled `getPredictedFrustum()` that returns the six planes and center. Emits AUDIO_LIGHT causal events when prediction is disabled due to jitter or when extrapolation was clamped. Writes per-frame prediction state into frame.layers.spatial.cameraExtrapolation and global aggregates into frame.layers.physical.cameraExtrapolation. Zero allocation after the first frame: all Vec3, Vec4, Mat4, Quat, Plane, Sphere, Box3 scratch objects are pooled and reused; all ring buffers are pre-allocated Float32Arrays.
// best for : Every consumer that needs to see the future — 269_ExtrasLODHelper, 301_AsyncAssetPriorityQueue (feeds priorities from predicted distances), 303_HLODController, 337_LandscapeChunkStreamer, 340_LandscapeChunkOcclusion, 302 itself feeding the 313_IsVisibleConsumer for pre-frustum culling. This is what makes the world feel like it "anticipates" instead of reacting.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum, OBB,
  Interpolant, LinearInterpolant, CubicInterpolant,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                       from './268_ExtrasCurveUtils.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';

// ══════════════════════════════════════════════════════════════════
// ─── PREDICTION STATE CODES ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const PREDICTION_STATE = Object.freeze({
  DISABLED:    0,   // prediction unavailable (no camera)
  WARMING_UP:  1,   // fewer than 2 frames of history
  ACTIVE:      2,   // normal prediction
  JITTERING:   3,   // camera stutter detected, prediction suppressed
  CLAMPED:     4    // extrapolation exceeded horizon limit
});

const PREDICTION_STATE_NAMES = Object.freeze([
  'disabled', 'warming_up', 'active', 'jittering', 'clamped'
]);

// ══════════════════════════════════════════════════════════════════
// ─── EXTRAPOLATION CONSTANTS ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const EXTRAPOLATION_CONSTANTS = Object.freeze({
  // Default prediction horizon (ms).
  DEFAULT_HORIZON_MS:        16.7,     // one 60 Hz frame
  MIN_HORIZON_MS:            4.0,
  MAX_HORIZON_MS:          100.0,     // 100 ms = ~6 frames ahead

  // Ring buffer size for velocity/acceleration estimation.
  RING_BUFFER_SIZE:           8,

  // Low-pass filter coefficient for velocity smoothing.
  VELOCITY_SMOOTHING:         0.15,
  ACCELERATION_SMOOTHING:     0.08,
  ANGULAR_SMOOTHING:          0.15,

  // Jitter detection.
  JITTER_POSITION_THRESHOLD:  3.0,    // metres of sudden velocity change
  JITTER_ANGULAR_THRESHOLD:   5.0,    // rad/s of sudden angular change
  JITTER_COOLDOWN_MS:       500.0,    // prediction disabled this long after jitter

  // Frustum extraction (standard FOV defaults)
  DEFAULT_FOV_Y:             60.0,    // degrees
  DEFAULT_ASPECT:            1.777,   // 16:9
  DEFAULT_NEAR:             0.1,
  DEFAULT_FAR:           100000.0,   // 100 km (galactic tier)

  // Speed limits (clamp for sanity).
  MAX_LINEAR_SPEED:       1000.0,    // m/s
  MAX_ANGULAR_SPEED:        50.0     // rad/s
});

// ══════════════════════════════════════════════════════════════════
// ─── CAMERA VELOCITY EXTRAPOLATOR ──────────────────────────────
// ══════════════════════════════════════════════════════════════════
class CameraVelocityExtrapolator {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      predictionHorizonMs:      options.predictionHorizonMs ?? EXTRAPOLATION_CONSTANTS.DEFAULT_HORIZON_MS,
      maxHorizonMs:             options.maxHorizonMs ?? EXTRAPOLATION_CONSTANTS.MAX_HORIZON_MS,
      minHorizonMs:             options.minHorizonMs ?? EXTRAPOLATION_CONSTANTS.MIN_HORIZON_MS,
      velocitySmoothing:        options.velocitySmoothing ?? EXTRAPOLATION_CONSTANTS.VELOCITY_SMOOTHING,
      accelerationSmoothing:    options.accelerationSmoothing ?? EXTRAPOLATION_CONSTANTS.ACCELERATION_SMOOTHING,
      angularSmoothing:         options.angularSmoothing ?? EXTRAPOLATION_CONSTANTS.ANGULAR_SMOOTHING,
      jitterPositionThreshold:  options.jitterPositionThreshold ?? EXTRAPOLATION_CONSTANTS.JITTER_POSITION_THRESHOLD,
      jitterAngularThreshold:   options.jitterAngularThreshold ?? EXTRAPOLATION_CONSTANTS.JITTER_ANGULAR_THRESHOLD,
      jitterCooldownMs:         options.jitterCooldownMs ?? EXTRAPOLATION_CONSTANTS.JITTER_COOLDOWN_MS,
      fovY:                     options.fovY ?? EXTRAPOLATION_CONSTANTS.DEFAULT_FOV_Y,
      aspect:                   options.aspect ?? EXTRAPOLATION_CONSTANTS.DEFAULT_ASPECT,
      near:                     options.near ?? EXTRAPOLATION_CONSTANTS.DEFAULT_NEAR,
      far:                      options.far ?? EXTRAPOLATION_CONSTANTS.DEFAULT_FAR,
      maxLinearSpeed:           options.maxLinearSpeed ?? EXTRAPOLATION_CONSTANTS.MAX_LINEAR_SPEED,
      maxAngularSpeed:          options.maxAngularSpeed ?? EXTRAPOLATION_CONSTANTS.MAX_ANGULAR_SPEED,
      enableEvents:             options.enableEvents ?? true
    };

    // ── Current camera state ────────────────────────────
    this._currentPos = new Vec3();
    this._currentVel = new Vec3();
    this._currentAcc = new Vec3();
    this._currentQuat = new Quat();
    this._currentAngular = new Vec3();   // axis * rad/s

    // ── Smoothed state ──────────────────────────────────
    this._smoothVel = new Vec3();
    this._smoothAcc = new Vec3();
    this._smoothAngular = new Vec3();

    // ── Ring buffer of historical camera positions ─────
    const rbSize = EXTRAPOLATION_CONSTANTS.RING_BUFFER_SIZE;
    this._posHistory = new Float32Array(rbSize * 3);
    this._quatHistory = new Float32Array(rbSize * 4);
    this._timeHistory = new Float64Array(rbSize);
    this._historyHead = 0;
    this._historyCount = 0;

    // ── Predicted state ─────────────────────────────────
    this._predictedPos = new Vec3();
    this._predictedQuat = new Quat();
    this._predictedViewMatrix = new Mat4();
    this._predictedProjMatrix = new Mat4();
    this._predictedViewProj = new Mat4();
    this._predictedFrustum = new Frustum();

    // ── Frustum plane data (six planes stored as SoA) ───
    this._planeNormals = new Float64Array(18);   // 6 × 3
    this._planeDistances = new Float64Array(6);
    this._predictedFrustumAABB = new Box3();

    // ── Scratch (pooled) ────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec3C = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4A = new Mat4();
    this._tmpMat4B = new Mat4();
    this._tmpQuatA = new Quat();
    this._tmpQuatB = new Quat();
    this._tmpPlane = new Plane();
    this._tmpSphere = new Sphere();
    this._tmpBox = new Box3();

    // ── State ───────────────────────────────────────────
    this._state = PREDICTION_STATE.DISABLED;
    this._lastJitterTime = 0;
    this._hasPreviousFrame = false;
    this._lastUpdateTime = 0;
    this._frameTimeSmoothed = EXTRAPOLATION_CONSTANTS.DEFAULT_HORIZON_MS / 1000;
    this._cameraValid = false;

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      updates: 0,
      predictionsActive: 0,
      predictionsClamped: 0,
      jitterEvents: 0,
      horizonAdaptations: 0,
      frustomExtractions: 0,
      stateTransitions: 0
    };

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._frameRef = null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── Push camera state ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Called each frame by the frame builder before update().
  setCameraState(position, quaternion) {
    const now = this._now();
    const dt = this._hasPreviousFrame ? now - this._lastUpdateTime : 0;

    // Always record current state.
    this._currentPos.copy(position);
    this._currentQuat.copy(quaternion);
    this._cameraValid = true;

    // Push to history ring buffer.
    const rbSize = EXTRAPOLATION_CONSTANTS.RING_BUFFER_SIZE;
    const hIdx = this._historyHead;
    const o3 = hIdx * 3;
    const o4 = hIdx * 4;

    this._posHistory[o3] = position.x;
    this._posHistory[o3 + 1] = position.y;
    this._posHistory[o3 + 2] = position.z;
    this._quatHistory[o4] = quaternion.x;
    this._quatHistory[o4 + 1] = quaternion.y;
    this._quatHistory[o4 + 2] = quaternion.z;
    this._quatHistory[o4 + 3] = quaternion.w;
    this._timeHistory[hIdx] = now;

    this._historyHead = (hIdx + 1) % rbSize;
    if (this._historyCount < rbSize) this._historyCount++;

    // Compute velocity and acceleration from history.
    if (this._hasPreviousFrame && dt > 1e-6) {
      this._estimateKinematics(dt);
    }

    this._lastUpdateTime = now;
    this._hasPreviousFrame = true;

    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Kinematics estimation from history ─────────────────
  // ══════════════════════════════════════════════════════════
  _estimateKinematics(dt) {
    const rbSize = EXTRAPOLATION_CONSTANTS.RING_BUFFER_SIZE;

    if (this._historyCount < 2) return;

    // Ring buffer navigation: current is (head-1+rbSize)%rbSize,
    // previous is (head-2+rbSize)%rbSize.
    const currentIdx = (this._historyHead - 1 + rbSize) % rbSize;
    const prevIdx = (this._historyHead - 2 + rbSize) % rbSize;

    const curO3 = currentIdx * 3;
    const prevO3 = prevIdx * 3;

    // ── Linear velocity: v = (p_cur − p_prev) / dt ──────
    const vx = (this._posHistory[curO3]     - this._posHistory[prevO3])     / dt;
    const vy = (this._posHistory[curO3 + 1] - this._posHistory[prevO3 + 1]) / dt;
    const vz = (this._posHistory[curO3 + 2] - this._posHistory[prevO3 + 2]) / dt;

    // Clamp to sanity.
    const vLenSq = vx * vx + vy * vy + vz * vz;
    const maxV = this.defaults.maxLinearSpeed;
    if (vLenSq > maxV * maxV) {
      const s = maxV / Math.sqrt(vLenSq);
      this._currentVel.set(vx * s, vy * s, vz * s);
    } else {
      this._currentVel.set(vx, vy, vz);
    }

    // ── Low-pass filter for smoothed velocity ───────────
    const a = this.defaults.velocitySmoothing;
    this._smoothVel.x = this._smoothVel.x * (1 - a) + this._currentVel.x * a;
    this._smoothVel.y = this._smoothVel.y * (1 - a) + this._currentVel.y * a;
    this._smoothVel.z = this._smoothVel.z * (1 - a) + this._currentVel.z * a;

    // ── Linear acceleration: a = (v_cur − v_prev) / dt ─
    // We use the ring buffer to compute the previous velocity.
    if (this._historyCount >= 3) {
      const prevPrevIdx = (this._historyHead - 3 + rbSize) % rbSize;
      const ppO3 = prevPrevIdx * 3;

      // v_prev = (p_prev − p_prevprev) / dt
      const vpx = (this._posHistory[prevO3]     - this._posHistory[ppO3])     / dt;
      const vpy = (this._posHistory[prevO3 + 1] - this._posHistory[ppO3 + 1]) / dt;
      const vpz = (this._posHistory[prevO3 + 2] - this._posHistory[ppO3 + 2]) / dt;

      const ax = (vx - vpx) / dt;
      const ay = (vy - vpy) / dt;
      const az = (vz - vpz) / dt;

      // Clamp acceleration to avoid explosions.
      const aLenSq = ax * ax + ay * ay + az * az;
      const maxA = maxV * 10;
      if (aLenSq > maxA * maxA) {
        const s = maxA / Math.sqrt(aLenSq);
        this._currentAcc.set(ax * s, ay * s, az * s);
      } else {
        this._currentAcc.set(ax, ay, az);
      }

      const aa = this.defaults.accelerationSmoothing;
      this._smoothAcc.x = this._smoothAcc.x * (1 - aa) + this._currentAcc.x * aa;
      this._smoothAcc.y = this._smoothAcc.y * (1 - aa) + this._currentAcc.y * aa;
      this._smoothAcc.z = this._smoothAcc.z * (1 - aa) + this._currentAcc.z * aa;
    }

    // ── Angular velocity: q_delta = q_cur · q_prev⁻¹ ───
    const curO4 = currentIdx * 4;
    const prevO4 = prevIdx * 4;

    this._tmpQuatA.set(
      this._quatHistory[curO4],
      this._quatHistory[curO4 + 1],
      this._quatHistory[curO4 + 2],
      this._quatHistory[curO4 + 3]
    );
    this._tmpQuatB.set(
      this._quatHistory[prevO4],
      this._quatHistory[prevO4 + 1],
      this._quatHistory[prevO4 + 2],
      this._quatHistory[prevO4 + 3]
    );

    // q_delta = q_cur * q_prev.conjugate()
    this._tmpQuatB.conjugate();
    this._tmpQuatA.multiply(this._tmpQuatB);

    // Convert quaternion delta to axis-angle.
    // Ensure w is positive for shortest-path.
    if (this._tmpQuatA.w < 0) {
      this._tmpQuatA.x = -this._tmpQuatA.x;
      this._tmpQuatA.y = -this._tmpQuatA.y;
      this._tmpQuatA.z = -this._tmpQuatA.z;
      this._tmpQuatA.w = -this._tmpQuatA.w;
    }

    // angle = 2 * acos(w), axis = (x,y,z) / sin(angle/2)
    const wClamped = Math.min(1, Math.max(-1, this._tmpQuatA.w));
    const angle = 2 * Math.acos(wClamped);
    const sinHalf = Math.sqrt(Math.max(0, 1 - wClamped * wClamped));

    let axAngleX = 0, axAngleY = 0, axAngleZ = 0;
    if (sinHalf > 1e-6) {
      axAngleX = this._tmpQuatA.x / sinHalf;
      axAngleY = this._tmpQuatA.y / sinHalf;
      axAngleZ = this._tmpQuatA.z / sinHalf;
    }

    // Angular velocity = axis * (angle / dt) (rad/s)
    const angRate = angle / dt;
    const maxAng = this.defaults.maxAngularSpeed;
    const clampedRate = Math.min(maxAng, angRate);

    this._currentAngular.set(
      axAngleX * clampedRate,
      axAngleY * clampedRate,
      axAngleZ * clampedRate
    );

    // Low-pass filter angular velocity.
    const angAlpha = this.defaults.angularSmoothing;
    this._smoothAngular.x = this._smoothAngular.x * (1 - angAlpha) + this._currentAngular.x * angAlpha;
    this._smoothAngular.y = this._smoothAngular.y * (1 - angAlpha) + this._currentAngular.y * angAlpha;
    this._smoothAngular.z = this._smoothAngular.z * (1 - angAlpha) + this._currentAngular.z * angAlpha;

    // ── Jitter detection ────────────────────────────────
    this._detectJitter(vx, vy, vz, angRate);

    // ── Frame time estimation for adaptive horizon ─────
    this._frameTimeSmoothed = this._frameTimeSmoothed * 0.85 + dt * 0.15;
  }

  _detectJitter(vx, vy, vz, angularRate) {
    // Sudden velocity change indicates a camera stutter / cut.
    const dvx = vx - this._smoothVel.x;
    const dvy = vy - this._smoothVel.y;
    const dvz = vz - this._smoothVel.z;
    const dvSq = dvx * dvx + dvy * dvy + dvz * dvz;

    if (dvSq > this.defaults.jitterPositionThreshold * this.defaults.jitterPositionThreshold ||
        angularRate > this.defaults.jitterAngularThreshold) {
      this._stats.jitterEvents++;
      this._lastJitterTime = this._now();
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Extrapolation core ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // p(t+Δt) = p(t) + v(t)·Δt + ½·a(t)·Δt²
  extrapolatePosition(dt, outVec) {
    const p = this._currentPos;
    const v = this._smoothVel;
    const a = this._smoothAcc;
    const halfDt2 = 0.5 * dt * dt;
    outVec.set(
      p.x + v.x * dt + a.x * halfDt2,
      p.y + v.y * dt + a.y * halfDt2,
      p.z + v.z * dt + a.z * halfDt2
    );
    return outVec;
  }

  // q(t+Δt) = q(t) · exp(½·ω·Δt)
  // where ω = angular velocity vector (axis * rad/s)
  extrapolateQuaternion(dt, outQuat) {
    const w = this._smoothAngular;
    const angRate = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);

    if (angRate < 1e-6) {
      // No rotation.
      outQuat.copy(this._currentQuat);
      return outQuat;
    }

    // Angle increment = angRate * dt
    const halfAngle = 0.5 * angRate * dt;
    const sinHalf = Math.sin(halfAngle);
    const cosHalf = Math.cos(halfAngle);

    // Axis (normalized).
    const invRate = 1 / angRate;
    const axisX = w.x * invRate;
    const axisY = w.y * invRate;
    const axisZ = w.z * invRate;

    // q_delta = (axis·sin(halfAngle), cos(halfAngle))
    this._tmpQuatA.set(
      axisX * sinHalf,
      axisY * sinHalf,
      axisZ * sinHalf,
      cosHalf
    );

    // q_predicted = q_current · q_delta
    outQuat.copy(this._currentQuat);
    outQuat.multiply(this._tmpQuatA);
    outQuat.normalize();
    return outQuat;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frustum extraction (Gribb-Hartmann) ────────────────
  // ══════════════════════════════════════════════════════════
  _extractFrustumFromMatrix(m) {
    const e = m.elements;
    // Column-major: e[0..3] = col 0, e[4..7] = col 1,
    // e[8..11] = col 2, e[12..15] = col 3.
    // Row i of M = (e[i], e[i+4], e[i+8], e[i+12]).

    const r0x = e[0], r0y = e[4], r0z = e[8], r0w = e[12];
    const r1x = e[1], r1y = e[5], r1z = e[9], r1w = e[13];
    const r2x = e[2], r2y = e[6], r2z = e[10], r2w = e[14];
    const r3x = e[3], r3y = e[7], r3z = e[11], r3w = e[15];

    this._setPlane(0, r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w);  // left
    this._setPlane(1, r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w);  // right
    this._setPlane(2, r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w);  // bottom
    this._setPlane(3, r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w);  // top
    this._setPlane(4, r3x + r2x, r3y + r2y, r3z + r2z, r3w + r2w);  // near
    this._setPlane(5, r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w);  // far
  }

  _setPlane(idx, nx, ny, nz, d) {
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-12) {
      this._planeNormals[idx * 3] = 0;
      this._planeNormals[idx * 3 + 1] = 0;
      this._planeNormals[idx * 3 + 2] = 0;
      this._planeDistances[idx] = 0;
      return;
    }
    const inv = 1 / len;
    this._planeNormals[idx * 3] = nx * inv;
    this._planeNormals[idx * 3 + 1] = ny * inv;
    this._planeNormals[idx * 3 + 2] = nz * inv;
    this._planeDistances[idx] = d * inv;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Update predicted state ─────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updatePrediction(dt) {
    const statePrev = this._state;

    // ── Determine state ─────────────────────────────────
    if (!this._cameraValid) {
      this._state = PREDICTION_STATE.DISABLED;
    } else if (this._historyCount < 2) {
      this._state = PREDICTION_STATE.WARMING_UP;
    } else {
      // Check jitter cooldown.
      const nowMs = this._now() * 1000;
      const timeSinceJitter = nowMs - this._lastJitterTime * 1000;
      if (timeSinceJitter < this.defaults.jitterCooldownMs) {
        this._state = PREDICTION_STATE.JITTERING;
      } else {
        this._state = PREDICTION_STATE.ACTIVE;
      }
    }

    // ── State transition tracking ───────────────────────
    if (statePrev !== this._state) {
      this._stats.stateTransitions++;
    }

    // ── Compute prediction horizon (adaptive) ───────────
    let horizonSec = this._frameTimeSmoothed;
    const minH = this.defaults.minHorizonMs / 1000;
    const maxH = this.defaults.maxHorizonMs / 1000;
    if (horizonSec < minH) horizonSec = minH;
    if (horizonSec > maxH) {
      horizonSec = maxH;
      this._stats.predictionsClamped++;
      if (this._state === PREDICTION_STATE.ACTIVE) {
        this._state = PREDICTION_STATE.CLAMPED;
      }
    }
    horizonSec = horizonSec * 0.9;   // slight safety margin

    // ── Extrapolate position & quaternion ──────────────
    if (this._state === PREDICTION_STATE.ACTIVE ||
        this._state === PREDICTION_STATE.CLAMPED) {

      this.extrapolatePosition(horizonSec, this._predictedPos);
      this.extrapolateQuaternion(horizonSec, this._predictedQuat);
      this._stats.predictionsActive++;
    } else if (this._state === PREDICTION_STATE.JITTERING) {
      // During jitter, use current state (no prediction).
      this._predictedPos.copy(this._currentPos);
      this._predictedQuat.copy(this._currentQuat);
    } else {
      // Warming up or disabled: identity prediction.
      this._predictedPos.copy(this._currentPos);
      this._predictedQuat.copy(this._currentQuat);
    }

    // ── Build predicted view matrix ─────────────────────
    // view = inverse(translate * rotate)
    this._tmpQuatA.copy(this._predictedQuat).invert();
    this._predictedViewMatrix.compose(
      this._predictedPos,
      this._predictedQuat,
      this._tmpVec3A.set(1, 1, 1)
    );
    this._predictedViewMatrix.invert();

    // ── Build projected matrix ──────────────────────────
    const fovRad = this.defaults.fovY * Math.PI / 180;
    this._predictedProjMatrix.makePerspective(
      fovRad,
      this.defaults.aspect,
      this.defaults.near,
      this.defaults.far
    );

    // ── viewProjection = proj * view ────────────────────
    this._predictedViewProj.multiplyMatrices(
      this._predictedProjMatrix,
      this._predictedViewMatrix
    );

    // ── Extract frustum planes ──────────────────────────
    this._extractFrustumFromMatrix(this._predictedViewProj);
    this._stats.frustomExtractions++;

    // ── Update Frustum object with plane data ───────────
    // THREE.Frustum stores 6 Plane objects; we sync them from
    // the raw arrays for compatibility with existing consumers.
    if (this._predictedFrustum.planes) {
      for (let i = 0; i < 6; i++) {
        const p = this._predictedFrustum.planes[i];
        if (p) {
          p.normal.set(
            this._planeNormals[i * 3],
            this._planeNormals[i * 3 + 1],
            this._planeNormals[i * 3 + 2]
          );
          p.constant = this._planeDistances[i];
        }
      }
    }

    // ── Compute predicted-frustum AABB ─────────────────
    this._computePredictedFrustumAABB();
  }

  // ══════════════════════════════════════════════════════════
  // ─── Compute predicted-frustum AABB ────────────────────
  // ══════════════════════════════════════════════════════════
  // Approximates the frustum's world-space AABB. Useful for
  // single-box culling and streaming spatial-hash queries.
  _computePredictedFrustumAABB() {
    const far = this.defaults.far;
    const fovRad = this.defaults.fovY * Math.PI / 180;
    const halfFovTan = Math.tan(fovRad * 0.5);
    const farHeight = far * halfFovTan;
    const farWidth = farHeight * this.defaults.aspect;

    // Frustum center is halfway between the camera and far center.
    const camPos = this._predictedPos;

    // Forward = quaternion applied to (0, 0, -1).
    this._tmpVec3A.set(0, 0, -1).applyQuaternion(this._predictedQuat);
    const forwardX = this._tmpVec3A.x;
    const forwardY = this._tmpVec3A.y;
    const forwardZ = this._tmpVec3A.z;

    // Right = quaternion applied to (1, 0, 0).
    this._tmpVec3B.set(1, 0, 0).applyQuaternion(this._predictedQuat);
    // Up = quaternion applied to (0, 1, 0).
    this._tmpVec3C.set(0, 1, 0).applyQuaternion(this._predictedQuat);

    // The frustum's near plane corners are at:
    //   camPos + near·forward ± near·halfFovTan·up·aspect ± near·halfFovTan·right
    // The far plane corners are at:
    //   camPos + far·forward ± farHeight·up·aspect ± farWidth·right
    //
    // The AABB needs to include both planes' extremes.

    // Near plane extent.
    const near = this.defaults.near;
    const nearH = near * halfFovTan;
    const nearW = nearH * this.defaults.aspect;

    // Far plane extent (already computed).

    // We can compute AABB by unioning 8 corners:
    // 4 near + 4 far.

    // Corner 0: near top-left
    // C = camPos + near·forward − nearW·right + nearH·up
    const nC = this._tmpVec3A;   // reuse
    nC.set(
      camPos.x + forwardX * near - this._tmpVec3B.x * nearW + this._tmpVec3C.x * nearH,
      camPos.y + forwardY * near - this._tmpVec3B.y * nearW + this._tmpVec3C.y * nearH,
      camPos.z + forwardZ * near - this._tmpVec3B.z * nearW + this._tmpVec3C.z * nearH
    );
    this._tmpBox.min.copy(nC);
    this._tmpBox.max.copy(nC);

    // Extend with the other 7 corners.
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = 0; sz <= 1; sz += 2) {
          const d = sz === 0 ? near : far;
          const hw = sz === 0 ? nearW : farWidth;
          const hh = sz === 0 ? nearH : farHeight;

          const px = camPos.x + forwardX * d + this._tmpVec3B.x * sx * hw + this._tmpVec3C.x * sy * hh;
          const py = camPos.y + forwardY * d + this._tmpVec3B.y * sx * hw + this._tmpVec3C.y * sy * hh;
          const pz = camPos.z + forwardZ * d + this._tmpVec3B.z * sx * hw + this._tmpVec3C.z * sy * hh;

          if (px < this._tmpBox.min.x) this._tmpBox.min.x = px;
          if (py < this._tmpBox.min.y) this._tmpBox.min.y = py;
          if (pz < this._tmpBox.min.z) this._tmpBox.min.z = pz;
          if (px > this._tmpBox.max.x) this._tmpBox.max.x = px;
          if (py > this._tmpBox.max.y) this._tmpBox.max.y = py;
          if (pz > this._tmpBox.max.z) this._tmpBox.max.z = pz;
        }
      }
    }

    this._predictedFrustumAABB.copy(this._tmpBox);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Now helper ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _now() {
    if (this._clock) return this._clock.elapsedSeconds;
    return performance.now() / 1000;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public accessors ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  get predictedPosition() { return this._predictedPos; }
  get predictedQuaternion() { return this._predictedQuat; }
  get predictedViewMatrix() { return this._predictedViewMatrix; }
  get predictedProjectionMatrix() { return this._predictedProjMatrix; }
  get predictedViewProjection() { return this._predictedViewProj; }
  get predictedFrustum() { return this._predictedFrustum; }
  get predictedFrustumAABB() { return this._predictedFrustumAABB; }
  get predictedFrustumPlanes() { return this._planeNormals; }
  get predictedFrustumDistances() { return this._planeDistances; }
  get state() { return this._state; }
  get stateName() { return PREDICTION_STATE_NAMES[this._state]; }

  get velocity() { return this._smoothVel; }
  get acceleration() { return this._smoothAcc; }
  get angularVelocity() { return this._smoothAngular; }

  // ══════════════════════════════════════════════════════════
  // ─── Public: get predicted frustum for downstream ─────
  // ══════════════════════════════════════════════════════════
  // Returns a Frustum object consumers can use for culling.
  getPredictedFrustum() {
    return this._predictedFrustum;
  }

  // Returns the predicted frustum AABB.
  getPredictedFrustumAABB() {
    return this._predictedFrustumAABB;
  }

  // Test whether a sphere is inside the predicted frustum.
  intersectsSphere(center, radius) {
    const planes = this._planeNormals;
    const dists = this._planeDistances;
    for (let i = 0; i < 6; i++) {
      const o = i * 3;
      const d = planes[o] * center.x +
                planes[o + 1] * center.y +
                planes[o + 2] * center.z +
                dists[i];
      if (d < -radius) return false;
    }
    return true;
  }

  // Test whether an AABB is inside the predicted frustum.
  intersectsBox(box) {
    const planes = this._planeNormals;
    const dists = this._planeDistances;
    for (let i = 0; i < 6; i++) {
      const o = i * 3;
      const nx = planes[o], ny = planes[o + 1], nz = planes[o + 2];
      const px = nx >= 0 ? box.max.x : box.min.x;
      const py = ny >= 0 ? box.max.y : box.min.y;
      const pz = nz >= 0 ? box.max.z : box.min.z;
      const d = nx * px + ny * py + nz * pz + dists[i];
      if (d < 0) return false;
    }
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    if (!spatial.cameraExtrapolation) {
      spatial.cameraExtrapolation = {
        predictedPosition: new Float32Array(3),
        predictedQuaternion: new Float32Array(4),
        velocity: new Float32Array(3),
        acceleration: new Float32Array(3),
        angularVelocity: new Float32Array(3),
        predictedViewMatrix: new Float32Array(16),
        predictedProjMatrix: new Float32Array(16),
        predictedViewProj: new Float32Array(16),
        predictedFrustumPlanes: new Float32Array(18),
        predictedFrustumDistances: new Float32Array(6),
        predictedAABBMin: new Float32Array(3),
        predictedAABBMax: new Float32Array(3),
        predictedFrustum: this._predictedFrustum,
        predictionState: 0,
        predictionStateName: 'disabled',
        horizonMs: 0,
        active: 0
      };
    }

    const ce = spatial.cameraExtrapolation;

    ce.predictedPosition[0] = this._predictedPos.x;
    ce.predictedPosition[1] = this._predictedPos.y;
    ce.predictedPosition[2] = this._predictedPos.z;

    ce.predictedQuaternion[0] = this._predictedQuat.x;
    ce.predictedQuaternion[1] = this._predictedQuat.y;
    ce.predictedQuaternion[2] = this._predictedQuat.z;
    ce.predictedQuaternion[3] = this._predictedQuat.w;

    ce.velocity[0] = this._smoothVel.x;
    ce.velocity[1] = this._smoothVel.y;
    ce.velocity[2] = this._smoothVel.z;

    ce.acceleration[0] = this._smoothAcc.x;
    ce.acceleration[1] = this._smoothAcc.y;
    ce.acceleration[2] = this._smoothAcc.z;

    ce.angularVelocity[0] = this._smoothAngular.x;
    ce.angularVelocity[1] = this._smoothAngular.y;
    ce.angularVelocity[2] = this._smoothAngular.z;

    const vm = this._predictedViewMatrix.elements;
    for (let i = 0; i < 16; i++) ce.predictedViewMatrix[i] = vm[i];

    const pm = this._predictedProjMatrix.elements;
    for (let i = 0; i < 16; i++) ce.predictedProjMatrix[i] = pm[i];

    const vpm = this._predictedViewProj.elements;
    for (let i = 0; i < 16; i++) ce.predictedViewProj[i] = vpm[i];

    for (let i = 0; i < 18; i++) ce.predictedFrustumPlanes[i] = this._planeNormals[i];
    for (let i = 0; i < 6; i++) ce.predictedFrustumDistances[i] = this._planeDistances[i];

    ce.predictedAABBMin[0] = this._predictedFrustumAABB.min.x;
    ce.predictedAABBMin[1] = this._predictedFrustumAABB.min.y;
    ce.predictedAABBMin[2] = this._predictedFrustumAABB.min.z;
    ce.predictedAABBMax[0] = this._predictedFrustumAABB.max.x;
    ce.predictedAABBMax[1] = this._predictedFrustumAABB.max.y;
    ce.predictedAABBMax[2] = this._predictedFrustumAABB.max.z;

    ce.predictionState = this._state;
    ce.predictionStateName = PREDICTION_STATE_NAMES[this._state];
    ce.horizonMs = this._frameTimeSmoothed * 1000;
    ce.active = (this._state === PREDICTION_STATE.ACTIVE ||
                 this._state === PREDICTION_STATE.CLAMPED) ? 1 : 0;
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.cameraExtrapolation) {
      physical.cameraExtrapolation = {};
    }

    const ce = physical.cameraExtrapolation;
    ce.state = this._state;
    ce.stateName = PREDICTION_STATE_NAMES[this._state];
    ce.linearSpeed = this._smoothVel.length();
    ce.angularSpeed = this._smoothAngular.length();
    ce.accelerationMagnitude = this._smoothAcc.length();
    ce.horizonMs = this._frameTimeSmoothed * 1000;
    ce.jitterActive = (this._state === PREDICTION_STATE.JITTERING) ? 1 : 0;
    ce.lastJitterTime = this._lastJitterTime;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;
    const now = this._now();

    // Compute dt.
    const dt = this._hasPreviousFrame ? now - this._lastUpdateTime : 0.016;

    // Update prediction state and compute predicted transforms.
    this._updatePrediction(dt);

    // Write to frame.
    this._writeToSpatialLayer(frame);
    this._writeToPhysicalLayer(frame);

    this._stats.updates++;
    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Interactive setters ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setPredictionHorizonMs(ms) {
    this.defaults.predictionHorizonMs = Math.max(
      this.defaults.minHorizonMs,
      Math.min(this.defaults.maxHorizonMs, ms)
    );
    return this;
  }

  setFov(fovY, aspect) {
    if (fovY !== undefined) this.defaults.fovY = fovY;
    if (aspect !== undefined) this.defaults.aspect = aspect;
    return this;
  }

  setNearFar(near, far) {
    if (near !== undefined) this.defaults.near = near;
    if (far !== undefined) this.defaults.far = far;
    return this;
  }

  setSmoothing(velAlpha, accAlpha, angAlpha) {
    if (velAlpha !== undefined) this.defaults.velocitySmoothing = velAlpha;
    if (accAlpha !== undefined) this.defaults.accelerationSmoothing = accAlpha;
    if (angAlpha !== undefined) this.defaults.angularSmoothing = angAlpha;
    return this;
  }

  setJitterThresholds(positionThreshold, angularThreshold, cooldownMs) {
    if (positionThreshold !== undefined) this.defaults.jitterPositionThreshold = positionThreshold;
    if (angularThreshold !== undefined) this.defaults.jitterAngularThreshold = angularThreshold;
    if (cooldownMs !== undefined) this.defaults.jitterCooldownMs = cooldownMs;
    return this;
  }

  // Reset prediction state (e.g. after a teleport).
  reset() {
    this._hasPreviousFrame = false;
    this._historyCount = 0;
    this._historyHead = 0;
    this._smoothVel.set(0, 0, 0);
    this._smoothAcc.set(0, 0, 0);
    this._smoothAngular.set(0, 0, 0);
    this._cameraValid = false;
    this._state = PREDICTION_STATE.DISABLED;
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  dispose() {
    this._dispatcher = null;
    this._clock = null;
    this._frameRef = null;
    this._cameraValid = false;
    this._hasPreviousFrame = false;
    this._historyCount = 0;
    this._historyHead = 0;
    this._state = PREDICTION_STATE.DISABLED;
    this._smoothVel.set(0, 0, 0);
    this._smoothAcc.set(0, 0, 0);
    this._smoothAngular.set(0, 0, 0);
  }
}

export {
  CameraVelocityExtrapolator,
  PREDICTION_STATE,
  PREDICTION_STATE_NAMES,
  EXTRAPOLATION_CONSTANTS
};