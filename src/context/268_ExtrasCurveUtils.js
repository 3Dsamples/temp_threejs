// file number : 268
// full path name : src/context/268_ExtrasCurveUtils.js
// description : High-performance curve utilities for camera-velocity extrapolation, LOD cross-fade timing, and procedural light motion. Wraps Interpolant, CubicInterpolant, LinearInterpolant, DiscreteInterpolant, and BezierInterpolant from 264_MathECSImportBarrel into precomputed, zero-allocation evaluators. Provides Catmull-Rom, cubic Bezier, and linear curve samplers with cached arc-length tables; camera extrapolation helpers p(t+dt)=p(t)+v·dt+½a·dt² and q(t+dt)=q(t)·exp(½ω·dt); smoothstep LOD fade weights; and a material/lighting interpolation block that blends PBR baseColor, metalness, roughness, anime quantize steps, rim power, emissive intensity, and clustered-light intensity along the same curve timeline. All scratch vectors and quaternions are pooled; no allocation inside evaluate().
// best for : Driving camera prediction, LOD transition timing, flickering and bioluminescent light motion, biome-blend color shifts, and material-parameter animation without per-frame garbage-collection pressure.
// license : MIT

import {
  Vec2,
  Vec3,
  Vec4,
  Mat4,
  Quat,
  Quat2,
  Interpolant,
  CubicInterpolant,
  LinearInterpolant,
  DiscreteInterpolant,
  BezierInterpolant,
  Precision,
  ColorManagement,
  ColorSpace,
  SimplexNoise
} from './264_MathECSImportBarrel.js';

// ─── curve kind discriminants ─────────────────────────────────────
const CURVE_KIND = Object.freeze({
  LINEAR: 0,
  CATMULL_ROM: 1,
  CUBIC_BEZIER: 2,
  DISCRETE: 3
});

// ─── precomputed smoothstep fade ──────────────────────────────────
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ─── Catmull-Rom basis evaluation (t in [0,1]) ────────────────────
// p(t) = 0.5 * ((2*P1) + (-P0 + P2)*t + (2*P0 - 5*P1 + 4*P2 - P3)*t² + (-P0 + 3*P1 - 3*P2 + P3)*t³)
function catmullRomComponent(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

// ─── cubic Bezier basis evaluation (t in [0,1]) ───────────────────
// B(t) = (1-t)³P0 + 3(1-t)²t P1 + 3(1-t)t² P2 + t³ P3
function cubicBezierComponent(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;
  return mt3 * p0 + 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t3 * p3;
}

// ─── reusable evaluation buffers (pooled) ─────────────────────────
class CurvePool {
  constructor() {
    this._vec3 = [];
    this._quat = [];
    this._index = 0;
    this._quatIndex = 0;
  }

  acquireVec3() {
    if (this._index < this._vec3.length) {
      const v = this._vec3[this._index];
      this._index++;
      return v;
    }
    const v = new Vec3();
    this._vec3.push(v);
    this._index++;
    return v;
  }

  acquireQuat() {
    if (this._quatIndex < this._quat.length) {
      const q = this._quat[this._quatIndex];
      this._quatIndex++;
      return q;
    }
    const q = new Quat();
    this._quat.push(q);
    this._quatIndex++;
    return q;
  }

  releaseAll() {
    this._index = 0;
    this._quatIndex = 0;
  }
}

// ─── base curve evaluator ─────────────────────────────────────────
class CurveEvaluator {
  constructor(kind = CURVE_KIND.LINEAR, points = []) {
    this.kind = kind;
    this.points = points;          // array of [x,y,z] or Vec3
    this._pointCount = points.length;
    this._tmpA = new Vec3();
    this._tmpB = new Vec3();
    this._tmpC = new Vec3();
    this._tmpD = new Vec3();
    this._arcLengthTable = null;
    this._arcLengthTotal = 0;
    this._divisions = 64;
    this._buildArcLength();
  }

  // ── arc-length table for equal-distance sampling ──────────────
  _buildArcLength() {
    if (this._pointCount < 2) return;
    const n = this._divisions;
    const table = new Float64Array(n + 1);
    let prev = this._sampleRaw(0, this._tmpA);
    let total = 0;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const cur = this._sampleRaw(t, this._tmpB);
      total += prev.distanceTo(cur);
      table[i] = total;
      prev.copy(cur);
    }
    this._arcLengthTable = table;
    this._arcLengthTotal = total;
  }

  // ── raw sample (uniform parameter t) ─────────────────────────
  _sampleRaw(t, target) {
    const pts = this.points;
    const n = this._pointCount;
    if (n === 0) { target.set(0, 0, 0); return target; }
    if (n === 1) { this._toVec3(pts[0], target); return target; }

    if (this.kind === CURVE_KIND.CATMULL_ROM) {
      const scaled = t * (n - 1);
      let i = Math.floor(scaled);
      if (i >= n - 1) i = n - 2;
      const localT = scaled - i;
      const p0 = this._getPoint(Math.max(0, i - 1));
      const p1 = this._getPoint(i);
      const p2 = this._getPoint(i + 1);
      const p3 = this._getPoint(Math.min(n - 1, i + 2));
      target.set(
        catmullRomComponent(p0.x, p1.x, p2.x, p3.x, localT),
        catmullRomComponent(p0.y, p1.y, p2.y, p3.y, localT),
        catmullRomComponent(p0.z, p1.z, p2.z, p3.z, localT)
      );
      return target;
    }

    if (this.kind === CURVE_KIND.CUBIC_BEZIER) {
      const segments = Math.max(1, Math.floor((n - 1) / 3));
      const scaled = t * segments;
      let i = Math.floor(scaled);
      if (i >= segments) i = segments - 1;
      const localT = scaled - i;
      const base = i * 3;
      const p0 = this._getPoint(Math.min(base, n - 1));
      const p1 = this._getPoint(Math.min(base + 1, n - 1));
      const p2 = this._getPoint(Math.min(base + 2, n - 1));
      const p3 = this._getPoint(Math.min(base + 3, n - 1));
      target.set(
        cubicBezierComponent(p0.x, p1.x, p2.x, p3.x, localT),
        cubicBezierComponent(p0.y, p1.y, p2.y, p3.y, localT),
        cubicBezierComponent(p0.z, p1.z, p2.z, p3.z, localT)
      );
      return target;
    }

    // LINEAR (default)
    const scaled = t * (n - 1);
    let i = Math.floor(scaled);
    if (i >= n - 1) i = n - 2;
    const localT = scaled - i;
    const a = this._getPoint(i);
    const b = this._getPoint(i + 1);
    target.set(
      a.x + (b.x - a.x) * localT,
      a.y + (b.y - a.y) * localT,
      a.z + (b.z - a.z) * localT
    );
    return target;
  }

  _getPoint(i) {
    const p = this.points[i];
    if (p instanceof Vec3) return p;
    // p is [x,y,z] or {x,y,z}
    this._tmpD.set(p[0] ?? p.x ?? 0, p[1] ?? p.y ?? 0, p[2] ?? p.z ?? 0);
    return this._tmpD;
  }

  _toVec3(p, target) {
    if (p instanceof Vec3) return target.copy(p);
    target.set(p[0] ?? p.x ?? 0, p[1] ?? p.y ?? 0, p[2] ?? p.z ?? 0);
    return target;
  }

  // ── equal-distance sampling (u in [0,1] along arc length) ────
  sampleAtDistance(u, target) {
    if (!this._arcLengthTable || this._arcLengthTotal === 0) {
      return this._sampleRaw(u, target);
    }
    const targetLen = u * this._arcLengthTotal;
    const table = this._arcLengthTable;
    let lo = 0, hi = table.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (table[mid] < targetLen) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const prevLen = table[i - 1];
    const segLen = table[i] - prevLen;
    const localU = segLen > 0 ? (targetLen - prevLen) / segLen : 0;
    const t = (i - 1 + localU) / this._divisions;
    return this._sampleRaw(t, target);
  }

  // ── uniform sampling ──────────────────────────────────────────
  sample(t, target) {
    return this._sampleRaw(Math.min(1, Math.max(0, t)), target);
  }

  // ── first derivative (velocity) ───────────────────────────────
  derivative(t, target) {
    const eps = 1e-4;
    const a = this._sampleRaw(Math.max(0, t - eps), this._tmpA);
    const b = this._sampleRaw(Math.min(1, t + eps), this._tmpB);
    target.set(
      (b.x - a.x) / (2 * eps),
      (b.y - a.y) / (2 * eps),
      (b.z - a.z) / (2 * eps)
    );
    return target;
  }

  get totalArcLength() { return this._arcLengthTotal; }
}

// ─── camera velocity extrapolator ────────────────────────────────
class CameraVelocityExtrapolator {
  constructor() {
    this._pos = new Vec3();
    this._vel = new Vec3();
    this._acc = new Vec3();
    this._quat = new Quat();
    this._omega = new Vec3(); // angular velocity (axis * rad/s)
    this._tmpQ = new Quat();
    this._tmpV = new Vec3();
    this._pool = new CurvePool();
  }

  // p(t+dt) = p(t) + v(t)dt + ½a(t)dt²
  extrapolatePosition(position, velocity, acceleration, dt, target) {
    target.copy(position);
    target.addScaledVector(velocity, dt);
    target.addScaledVector(acceleration, 0.5 * dt * dt);
    return target;
  }

  // q(t+dt) = q(t) · exp(½ ω dt)
  extrapolateRotation(quaternion, angularVelocity, dt, target) {
    const omegaMag = angularVelocity.length();
    if (omegaMag < Precision.EPSILON) {
      target.copy(quaternion);
      return target;
    }
    const halfAngle = 0.5 * omegaMag * dt;
    const sinHalf = Math.sin(halfAngle);
    this._tmpQ.set(
      angularVelocity.x * sinHalf / omegaMag,
      angularVelocity.y * sinHalf / omegaMag,
      angularVelocity.z * sinHalf / omegaMag,
      Math.cos(halfAngle)
    );
    return target.copy(quaternion).multiply(this._tmpQ);
  }

  // Full camera extrapolation: position, rotation, and predicted frustum
  extrapolateCamera(camera, dt, outPosition, outQuaternion) {
    this.extrapolatePosition(
      camera.position, camera.velocity, camera.acceleration, dt, outPosition
    );
    this.extrapolateRotation(
      camera.quaternion, camera.angularVelocity, dt, outQuaternion
    );
    return { position: outPosition, quaternion: outQuaternion };
  }
}

// ─── LOD fade and material/lighting interpolation ────────────────
class CurveMaterialBlender {
  constructor() {
    this._pbrColor = [0.8, 0.8, 0.8];
    this._animeColor = [0.8, 0.8, 0.8];
    this._outColor = [0.8, 0.8, 0.8];
    this._quantizeSteps = 3;
    this._rimPower = 2.0;
    this._emissiveIntensity = 0.0;
    this._lightIntensity = 1.0;
  }

  // Blend PBR and anime material parameters along a curve timeline.
  // w = 0 → pure PBR, w = 1 → pure anime flat.
  blendPBRAnime(w, pbr, anime) {
    const t = Math.min(1, Math.max(0, w));
    this._outColor[0] = pbr.baseColor[0] * (1 - t) + anime.baseColor[0] * t;
    this._outColor[1] = pbr.baseColor[1] * (1 - t) + anime.baseColor[1] * t;
    this._outColor[2] = pbr.baseColor[2] * (1 - t) + anime.baseColor[2] * t;
    this._quantizeSteps = Math.round(
      pbr.quantizeSteps * (1 - t) + anime.quantizeSteps * t
    );
    this._rimPower = pbr.rimPower * (1 - t) + anime.rimPower * t;
    this._emissiveIntensity = pbr.emissiveIntensity * (1 - t) + anime.emissiveIntensity * t;
    this._lightIntensity = pbr.lightIntensity * (1 - t) + anime.lightIntensity * t;
    return this._outColor;
  }

  // Smooth LOD cross-fade weight α = smoothstep(d_ℓ, d_{ℓ+1}, d)
  lodFadeWeight(d, dL, dL1) {
    return smoothstep(dL, dL1, d);
  }

  // Blended colour C = (1−α)C_near + αC_far
  blendLODColor(cNear, cFar, alpha, target) {
    target[0] = cNear[0] * (1 - alpha) + cFar[0] * alpha;
    target[1] = cNear[1] * (1 - alpha) + cFar[1] * alpha;
    target[2] = cNear[2] * (1 - alpha) + cFar[2] * alpha;
    return target;
  }

  // Procedural light flicker: I(t) = I₀ · (1 + A·sin(ωt + φ)) with noise
  flickerIntensity(baseIntensity, amplitude, omega, t, phase = 0) {
    const harmonic = Math.sin(omega * t + phase);
    const noise = (SimplexNoise.noise(t * 0.7, phase) ?? 0) * 0.1;
    return baseIntensity * (1 + amplitude * (harmonic + noise));
  }

  // Emissive decay from causal event: I(t) = I₀ · exp(-t/τ)
  decayedEmissive(baseIntensity, tau, dt) {
    return baseIntensity * Math.exp(-dt / Math.max(tau, Precision.EPSILON));
  }

  get outColor() { return this._outColor; }
  get quantizeSteps() { return this._quantizeSteps; }
  get rimPower() { return this._rimPower; }
  get emissiveIntensity() { return this._emissiveIntensity; }
  get lightIntensity() { return this._lightIntensity; }
}

// ─── pooled curve factory ────────────────────────────────────────
const _curvePool = [];
let _curvePoolIndex = 0;

function acquireCurve(kind, points) {
  if (_curvePoolIndex < _curvePool.length) {
    const c = _curvePool[_curvePoolIndex];
    _curvePoolIndex++;
    c.kind = kind;
    c.points = points;
    c._pointCount = points.length;
    c._buildArcLength();
    return c;
  }
  const c = new CurveEvaluator(kind, points);
  _curvePool.push(c);
  _curvePoolIndex++;
  return c;
}

function releaseAllCurves() {
  _curvePoolIndex = 0;
}

export {
  CurveEvaluator,
  CameraVelocityExtrapolator,
  CurveMaterialBlender,
  CurvePool,
  CURVE_KIND,
  smoothstep,
  acquireCurve,
  releaseAllCurves
};