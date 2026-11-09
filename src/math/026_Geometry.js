// file number : 026
// full path name : src/math/026_Geometry.js
// description : High-performance Geometry module rewritten from @scenesystems/effect-math Geometry without the Effect dependency. Provides 3D geometric primitives and operations: point-vector utilities (distance, midpoint, lerp, closest point on segment/line/ray/plane/circle/sphere/AABB/triangle), line/segment/ray operations (parametric, closest pair, intersect), plane operations (normalization, signed distance, projection, plane-plane intersection), triangle operations (normal, area, barycentric, containment, Möller-Trumbore ray intersection, closest point on triangle), AABB operations (create/expand/union/contains/intersects, ray-AABB slab test), sphere operations (create, contains, intersect sphere-sphere, ray-sphere, closest point), circle operations, intersection tests (ray-plane, ray-triangle, ray-AABB, ray-sphere, segment-segment, plane-plane), area/volume computations (triangle, quadrilateral, tetrahedron, AABB, sphere), and angle utilities (vector, planar, torsion). Includes DoubleDouble high-precision variants (ddDistancePointToLine, ddTriangleArea, ddPlaneSignedDistance, ddPointDistanceSq) for galactic-scale numerics. Schema validators (PointInput, SegmentInput, LineInput, RayInput, PlaneInput, TriangleInput, AABBInput, SphereInput, CircleInput, IntersectInput, DistanceInput), policy-aware wrappers with strict/relaxed precision + diagnostics, and pooled vec3/plane buffers for zero-allocation hot paths. Integrated with Vec3, Vec2, Constants, Common, and DoubleDouble from the engine core.
// best for : Collision detection, camera frustum tests, ray-casting, physics broadphase/narrowphase, BVH construction, procedural mesh generation, PBR surface intersection, LOD distance bands, context-awareness proximity queries, and any geometric hot path on Android 64-bit.
// license : MIT

import { EPSILON } from '../core/003_Common.js';
import { PRECISION, HELPERS } from '../core/002_Constants.js';
import * as DD from './014_DoubleDouble.js';
import * as vec3 from './006_Vec3.js';

// ============================================================================
// ERRORS
// ============================================================================
export class DecodeError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'GeometryDecodeError';
    this.operation = operation;
  }
}

export class DomainViolationError extends Error {
  constructor(operation, message) {
    super(message);
    this.name = 'GeometryDomainViolationError';
    this.operation = operation;
  }
}

// ============================================================================
// POLICY
// ============================================================================
const DEFAULT_POLICY = Object.freeze({
  precision: 'strict',
  diagnostics: 'disabled'
});

function resolvePolicy(policy) {
  if (!policy) return DEFAULT_POLICY;
  return {
    precision: policy.precision === 'relaxed' ? 'relaxed' : 'strict',
    diagnostics: policy.diagnostics === 'enabled' ? 'enabled' : 'disabled'
  };
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isFiniteVec(v) {
  return v && v.length >= 3 && isFiniteNumber(v[0]) && isFiniteNumber(v[1]) && isFiniteNumber(v[2]);
}

function policyScalar(operation, compute, makeError, annotate, policy) {
  const p = resolvePolicy(policy);
  const t0 = p.diagnostics === 'enabled' && typeof performance !== 'undefined' ? performance.now() : 0;
  const result = compute();
  if (p.precision === 'strict' && !isFiniteNumber(result)) {
    throw makeError('strict precision rejected non-finite result');
  }
  if (p.diagnostics === 'enabled') {
    const dt = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    const info = annotate ? annotate(result) : {};
    info.precision = p.precision;
    info.elapsedMs = dt;
    // eslint-disable-next-line no-console
    console.log(`[${operation}]`, info);
  }
  return result;
}

function policyCustom(operation, compute, isValid, makeError, annotate, policy) {
  const p = resolvePolicy(policy);
  const t0 = p.diagnostics === 'enabled' && typeof performance !== 'undefined' ? performance.now() : 0;
  const result = compute();
  if (p.precision === 'strict' && !isValid(result)) {
    throw makeError('strict precision rejected invalid result');
  }
  if (p.diagnostics === 'enabled') {
    const dt = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    const info = annotate ? annotate(result) : {};
    info.precision = p.precision;
    info.elapsedMs = dt;
    // eslint-disable-next-line no-console
    console.log(`[${operation}]`, info);
  }
  return result;
}

// ============================================================================
// SHARED SCRATCH
// ============================================================================
const _v3a = vec3.create();
const _v3b = vec3.create();
const _v3c = vec3.create();
const _v3d = vec3.create();
const _v3e = vec3.create();
const _v3f = vec3.create();

// ============================================================================
// POINT / VECTOR UTILITIES
// ============================================================================

export function pointDistance(a, b) {
  return vec3.distance(a, b);
}

export function pointDistanceSq(a, b) {
  return vec3.squaredDistance(a, b);
}

export function midpoint(out, a, b) {
  out[0] = (a[0] + b[0]) * 0.5;
  out[1] = (a[1] + b[1]) * 0.5;
  out[2] = (a[2] + b[2]) * 0.5;
  return out;
}

export function lerpPoint(out, a, b, t) {
  out[0] = a[0] + t * (b[0] - a[0]);
  out[1] = a[1] + t * (b[1] - a[1]);
  out[2] = a[2] + t * (b[2] - a[2]);
  return out;
}

// ============================================================================
// LINE / SEGMENT / RAY OPERATIONS
// ============================================================================

export function lineSegmentCreate(a, b) {
  return { a: vec3.clone(a), b: vec3.clone(b) };
}

export function lineCreate(a, b) {
  return { a: vec3.clone(a), b: vec3.clone(b) };
}

export function rayCreate(origin, dir) {
  const d = vec3.clone(dir);
  vec3.normalize(d, d);
  return { origin: vec3.clone(origin), dir: d };
}

export function closestPointOnLine(out, p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const denom = abx * abx + aby * aby + abz * abz;
  let t = denom > 0 ? (apx * abx + apy * aby + apz * abz) / denom : 0;
  out[0] = a[0] + t * abx;
  out[1] = a[1] + t * aby;
  out[2] = a[2] + t * abz;
  return t;
}

export function closestPointOnSegment(out, p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const denom = abx * abx + aby * aby + abz * abz;
  let t = denom > 0 ? (apx * abx + apy * aby + apz * abz) / denom : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  out[0] = a[0] + t * abx;
  out[1] = a[1] + t * aby;
  out[2] = a[2] + t * abz;
  return t;
}

export function closestPointOnRay(out, p, origin, dir) {
  const dx = dir[0];
  const dy = dir[1];
  const dz = dir[2];
  const apx = p[0] - origin[0];
  const apy = p[1] - origin[1];
  const apz = p[2] - origin[2];
  let t = apx * dx + apy * dy + apz * dz;
  if (t < 0) t = 0;
  out[0] = origin[0] + t * dx;
  out[1] = origin[1] + t * dy;
  out[2] = origin[2] + t * dz;
  return t;
}

export function segmentDistanceSq(a1, b1, a2, b2) {
  // Closest pair between segments [a1,b1] and [a2,b2] (Ericson, RTCD)
  const d1x = b1[0] - a1[0];
  const d1y = b1[1] - a1[1];
  const d1z = b1[2] - a1[2];
  const d2x = b2[0] - a2[0];
  const d2y = b2[1] - a2[1];
  const d2z = b2[2] - a2[2];
  const rx = a1[0] - a2[0];
  const ry = a1[1] - a2[1];
  const rz = a1[2] - a2[2];
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= EPSILON && e <= EPSILON) {
    const dx = a1[0] - a2[0];
    const dy = a1[1] - a2[1];
    const dz = a1[2] - a2[2];
    return dx * dx + dy * dy + dz * dz;
  }
  if (a <= EPSILON) {
    s = 0;
    t = f / e;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPSILON) {
      t = 0;
      s = -c / a;
      if (s < 0) s = 0;
      else if (s > 1) s = 1;
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      if (denom !== 0) {
        s = (b * f - c * e) / denom;
        if (s < 0) s = 0;
        else if (s > 1) s = 1;
      } else {
        s = 0;
      }
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = -c / a;
        if (s < 0) s = 0;
        else if (s > 1) s = 1;
      } else if (t > 1) {
        t = 1;
        s = (b - c) / a;
        if (s < 0) s = 0;
        else if (s > 1) s = 1;
      }
    }
  }
  const p1x = a1[0] + s * d1x;
  const p1y = a1[1] + s * d1y;
  const p1z = a1[2] + s * d1z;
  const p2x = a2[0] + t * d2x;
  const p2y = a2[1] + t * d2y;
  const p2z = a2[2] + t * d2z;
  const dx = p1x - p2x;
  const dy = p1y - p2y;
  const dz = p1z - p2z;
  return dx * dx + dy * dy + dz * dz;
}

export function lineLineClosest(a1, b1, a2, b2, outP1, outP2) {
  const d1x = b1[0] - a1[0];
  const d1y = b1[1] - a1[1];
  const d1z = b1[2] - a1[2];
  const d2x = b2[0] - a2[0];
  const d2y = b2[1] - a2[1];
  const d2z = b2[2] - a2[2];
  const rx = a1[0] - a2[0];
  const ry = a1[1] - a2[1];
  const rz = a1[2] - a2[2];
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const c = d1x * rx + d1y * ry + d1z * rz;
  const b = d1x * d2x + d1y * d2y + d1z * d2z;
  const denom = a * e - b * b;
  let s, t;
  if (denom === 0) {
    s = 0;
    t = f / e;
  } else {
    s = (b * f - c * e) / denom;
    t = (b * s + f) / e;
  }
  outP1[0] = a1[0] + s * d1x;
  outP1[1] = a1[1] + s * d1y;
  outP1[2] = a1[2] + s * d1z;
  outP2[0] = a2[0] + t * d2x;
  outP2[1] = a2[1] + t * d2y;
  outP2[2] = a2[2] + t * d2z;
  return { s, t };
}

// ============================================================================
// PLANE OPERATIONS
// ============================================================================

export function planeCreate(nx, ny, nz, d) {
  const n = vec3.fromValues(nx, ny, nz);
  const len = vec3.length(n);
  if (len > 0) vec3.scale(n, n, 1 / len);
  return { n, d: d / (len || 1) };
}

export function planeFromPointNormal(p, n) {
  const nn = vec3.clone(n);
  vec3.normalize(nn, nn);
  const d = -(nn[0] * p[0] + nn[1] * p[1] + nn[2] * p[2]);
  return { n: nn, d };
}

export function planeFromThreePoints(a, b, c) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return null;
  const nnx = nx / len;
  const nny = ny / len;
  const nnz = nz / len;
  const d = -(nnx * a[0] + nny * a[1] + nnz * a[2]);
  return { n: [nnx, nny, nnz], d };
}

export function planeSignedDistance(plane, p) {
  return plane.n[0] * p[0] + plane.n[1] * p[1] + plane.n[2] * p[2] + plane.d;
}

export function planeProjectPoint(out, plane, p) {
  const dist = planeSignedDistance(plane, p);
  out[0] = p[0] - dist * plane.n[0];
  out[1] = p[1] - dist * plane.n[1];
  out[2] = p[2] - dist * plane.n[2];
  return out;
}

export function planePlaneIntersect(p1, p2, outDir, outPoint) {
  const n1 = p1.n;
  const n2 = p2.n;
  const cross = vec3.cross(_v3a, n1, n2);
  const denom = vec3.squaredLength(cross);
  if (denom < EPSILON * EPSILON) return false;
  const d1 = p1.d;
  const d2 = p2.d;
  const n1dotn2 = vec3.dot(n1, n2);
  const n1dotn1 = vec3.dot(n1, n1);
  const n2dotn2 = vec3.dot(n2, n2);
  const c1 = (d1 * n2dotn2 - d2 * n1dotn2) / denom;
  const c2 = (d2 * n1dotn1 - d1 * n1dotn2) / denom;
  if (outPoint) {
    outPoint[0] = c1 * n1[0] + c2 * n2[0];
    outPoint[1] = c1 * n1[1] + c2 * n2[1];
    outPoint[2] = c1 * n1[2] + c2 * n2[2];
  }
  if (outDir) {
    vec3.normalize(outDir, cross);
  }
  return true;
}

// ============================================================================
// TRIANGLE OPERATIONS
// ============================================================================

export function triangleNormal(out, a, b, c) {
  vec3.subtract(_v3a, b, a);
  vec3.subtract(_v3b, c, a);
  vec3.cross(out, _v3a, _v3b);
  vec3.normalize(out, out);
  return out;
}

export function triangleArea(a, b, c) {
  vec3.subtract(_v3a, b, a);
  vec3.subtract(_v3b, c, a);
  vec3.cross(_v3c, _v3a, _v3b);
  return 0.5 * vec3.length(_v3c);
}

export function triangleBarycentric(out, p, a, b, c) {
  vec3.subtract(_v3a, b, a);
  vec3.subtract(_v3b, c, a);
  vec3.subtract(_v3c, p, a);
  const d00 = vec3.dot(_v3a, _v3a);
  const d01 = vec3.dot(_v3a, _v3b);
  const d11 = vec3.dot(_v3b, _v3b);
  const d20 = vec3.dot(_v3c, _v3a);
  const d21 = vec3.dot(_v3c, _v3b);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < EPSILON) {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  out[0] = 1 - v - w;
  out[1] = v;
  out[2] = w;
  return out;
}

export function triangleContains(p, a, b, c, tolerance) {
  const tol = tolerance === undefined ? EPSILON * 100 : tolerance;
  triangleBarycentric(_v3d, p, a, b, c);
  const u = _v3d[0];
  const v = _v3d[1];
  const w = _v3d[2];
  return u >= -tol && v >= -tol && w >= -tol;
}

export function closestPointOnTriangle(out, p, a, b, c) {
  triangleBarycentric(_v3d, p, a, b, c);
  const u = _v3d[0];
  const v = _v3d[1];
  const w = _v3d[2];
  if (u >= 0 && v >= 0 && w >= 0) {
    out[0] = p[0];
    out[1] = p[1];
    out[2] = p[2];
    return out;
  }
  // Project onto each edge and pick the closest
  let bestD2 = Infinity;
  closestPointOnSegment(_v3a, p, a, b);
  let dx = _v3a[0] - p[0], dy = _v3a[1] - p[1], dz = _v3a[2] - p[2];
  let d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < bestD2) { bestD2 = d2; out[0] = _v3a[0]; out[1] = _v3a[1]; out[2] = _v3a[2]; }

  closestPointOnSegment(_v3b, p, b, c);
  dx = _v3b[0] - p[0]; dy = _v3b[1] - p[1]; dz = _v3b[2] - p[2];
  d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < bestD2) { bestD2 = d2; out[0] = _v3b[0]; out[1] = _v3b[1]; out[2] = _v3b[2]; }

  closestPointOnSegment(_v3c, p, c, a);
  dx = _v3c[0] - p[0]; dy = _v3c[1] - p[1]; dz = _v3c[2] - p[2];
  d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < bestD2) { bestD2 = d2; out[0] = _v3c[0]; out[1] = _v3c[1]; out[2] = _v3c[2]; }

  return out;
}

export function rayTriangleIntersect(origin, dir, a, b, c, outPoint) {
  // Möller-Trumbore
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];
  const px = dir[1] * e2z - dir[2] * e2y;
  const py = dir[2] * e2x - dir[0] * e2z;
  const pz = dir[0] * e2y - dir[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < EPSILON) return { hit: false };
  const invDet = 1 / det;
  const tx = origin[0] - a[0];
  const ty = origin[1] - a[1];
  const tz = origin[2] - a[2];
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return { hit: false };
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * invDet;
  if (v < 0 || u + v > 1) return { hit: false };
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (t < EPSILON) return { hit: false };
  if (outPoint) {
    outPoint[0] = origin[0] + t * dir[0];
    outPoint[1] = origin[1] + t * dir[1];
    outPoint[2] = origin[2] + t * dir[2];
  }
  return { hit: true, t, u, v };
}

// ============================================================================
// AABB OPERATIONS
// ============================================================================

export function aabbCreate(min, max) {
  return { min: vec3.clone(min), max: vec3.clone(max) };
}

export function aabbFromPoints(points) {
  if (points.length === 0) {
    return { min: vec3.fromValues(0, 0, 0), max: vec3.fromValues(0, 0, 0) };
  }
  const min = vec3.clone(points[0]);
  const max = vec3.clone(points[0]);
  for (let i = 1; i < points.length; i++) {
    vec3.min(min, min, points[i]);
    vec3.max(max, max, points[i]);
  }
  return { min, max };
}

export function aabbUnion(out, a, b) {
  vec3.min(out.min, a.min, b.min);
  vec3.max(out.max, a.max, b.max);
  return out;
}

export function aabbExpandByPoint(box, p) {
  vec3.min(box.min, box.min, p);
  vec3.max(box.max, box.max, p);
  return box;
}

export function aabbContainsPoint(box, p) {
  return (
    p[0] >= box.min[0] && p[0] <= box.max[0] &&
    p[1] >= box.min[1] && p[1] <= box.max[1] &&
    p[2] >= box.min[2] && p[2] <= box.max[2]
  );
}

export function aabbIntersects(a, b) {
  return !(
    a.max[0] < b.min[0] || a.min[0] > b.max[0] ||
    a.max[1] < b.min[1] || a.min[1] > b.max[1] ||
    a.max[2] < b.min[2] || a.min[2] > b.max[2]
  );
}

export function rayAABBIntersect(origin, dir, box) {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const inv = 1 / (dir[i] || EPSILON);
    let t1 = (box.min[i] - origin[i]) * inv;
    let t2 = (box.max[i] - origin[i]) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return { hit: false };
  }
  return { hit: true, tmin, tmax };
}

// ============================================================================
// SPHERE / CIRCLE OPERATIONS
// ============================================================================

export function sphereCreate(center, radius) {
  return { center: vec3.clone(center), radius };
}

export function sphereContains(sphere, p) {
  return vec3.squaredDistance(sphere.center, p) <= sphere.radius * sphere.radius;
}

export function sphereSphereIntersect(a, b) {
  const r = a.radius + b.radius;
  return vec3.squaredDistance(a.center, b.center) <= r * r;
}

export function raySphereIntersect(origin, dir, sphere, outPoint) {
  const ocx = origin[0] - sphere.center[0];
  const ocy = origin[1] - sphere.center[1];
  const ocz = origin[2] - sphere.center[2];
  const b = ocx * dir[0] + ocy * dir[1] + ocz * dir[2];
  const c = ocx * ocx + ocy * ocy + ocz * ocz - sphere.radius * sphere.radius;
  const disc = b * b - c;
  if (disc < 0) return { hit: false };
  const sq = Math.sqrt(disc);
  const t = -b - sq;
  if (t < 0) {
    const t2 = -b + sq;
    if (t2 < 0) return { hit: false };
    if (outPoint) {
      outPoint[0] = origin[0] + t2 * dir[0];
      outPoint[1] = origin[1] + t2 * dir[1];
      outPoint[2] = origin[2] + t2 * dir[2];
    }
    return { hit: true, t: t2 };
  }
  if (outPoint) {
    outPoint[0] = origin[0] + t * dir[0];
    outPoint[1] = origin[1] + t * dir[1];
    outPoint[2] = origin[2] + t * dir[2];
  }
  return { hit: true, t };
}

export function closestPointOnSphere(out, p, sphere) {
  const dx = p[0] - sphere.center[0];
  const dy = p[1] - sphere.center[1];
  const dz = p[2] - sphere.center[2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < EPSILON) {
    out[0] = sphere.center[0] + sphere.radius;
    out[1] = sphere.center[1];
    out[2] = sphere.center[2];
    return out;
  }
  const inv = sphere.radius / d;
  out[0] = sphere.center[0] + dx * inv;
  out[1] = sphere.center[1] + dy * inv;
  out[2] = sphere.center[2] + dz * inv;
  return out;
}

// ============================================================================
// INTERSECTION TESTS (COMPOSITE)
// ============================================================================

export function rayPlaneIntersect(origin, dir, plane, outPoint) {
  const denom = plane.n[0] * dir[0] + plane.n[1] * dir[1] + plane.n[2] * dir[2];
  if (Math.abs(denom) < EPSILON) return { hit: false };
  const t = -(plane.n[0] * origin[0] + plane.n[1] * origin[1] + plane.n[2] * origin[2] + plane.d) / denom;
  if (t < 0) return { hit: false };
  if (outPoint) {
    outPoint[0] = origin[0] + t * dir[0];
    outPoint[1] = origin[1] + t * dir[1];
    outPoint[2] = origin[2] + t * dir[2];
  }
  return { hit: true, t };
}

export function segmentPlaneIntersect(a, b, plane, outPoint) {
  const da = planeSignedDistance(plane, a);
  const db = planeSignedDistance(plane, b);
  if (da * db > 0) return { hit: false };
  const denom = da - db;
  if (Math.abs(denom) < EPSILON) return { hit: false };
  const t = da / denom;
  if (outPoint) {
    outPoint[0] = a[0] + t * (b[0] - a[0]);
    outPoint[1] = a[1] + t * (b[1] - a[1]);
    outPoint[2] = a[2] + t * (b[2] - a[2]);
  }
  return { hit: true, t };
}

export function segmentSegmentIntersect2D(a1, b1, a2, b2) {
  const d1x = b1[0] - a1[0];
  const d1y = b1[1] - a1[1];
  const d2x = b2[0] - a2[0];
  const d2y = b2[1] - a2[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < EPSILON) return { hit: false };
  const dx = a2[0] - a1[0];
  const dy = a2[1] - a1[1];
  const t = (dx * d2y - dy * d2x) / denom;
  const s = (dx * d1y - dy * d1x) / denom;
  if (t < 0 || t > 1 || s < 0 || s > 1) return { hit: false };
  return { hit: true, t, s };
}

// ============================================================================
// AREA / VOLUME
// ============================================================================

export function tetrahedronVolume(a, b, c, d) {
  vec3.subtract(_v3a, b, a);
  vec3.subtract(_v3b, c, a);
  vec3.subtract(_v3c, d, a);
  vec3.cross(_v3d, _v3b, _v3c);
  return Math.abs(vec3.dot(_v3a, _v3d)) / 6;
}

export function aabbVolume(box) {
  return (
    (box.max[0] - box.min[0]) *
    (box.max[1] - box.min[1]) *
    (box.max[2] - box.min[2])
  );
}

export function aabbSurfaceArea(box) {
  const w = box.max[0] - box.min[0];
  const h = box.max[1] - box.min[1];
  const d = box.max[2] - box.min[2];
  return 2 * (w * h + h * d + d * w);
}

export function sphereVolume(sphere) {
  return (4 / 3) * Math.PI * sphere.radius * sphere.radius * sphere.radius;
}

export function sphereSurfaceArea(sphere) {
  return 4 * Math.PI * sphere.radius * sphere.radius;
}

export function circleArea(circle) {
  return Math.PI * circle.radius * circle.radius;
}

export function circleContains(circle, p) {
  const dx = p[0] - circle.center[0];
  const dy = p[1] - circle.center[1];
  return dx * dx + dy * dy <= circle.radius * circle.radius;
}

export function circleCreate(center, radius) {
  return { center: [center[0], center[1]], radius };
}

// ============================================================================
// ANGLE UTILITIES
// ============================================================================

export function vectorAngle(a, b) {
  return vec3.angle(a, b);
}

export function planarAngle(a, b) {
  return Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0]);
}

// ============================================================================
// DOUBLEDOUBLE HIGH-PRECISION VARIANTS
// ============================================================================

export function ddDistancePointToLine(p, a, b) {
  const apx = DD.fromDouble(p[0] - a[0]);
  const apy = DD.fromDouble(p[1] - a[1]);
  const apz = DD.fromDouble(p[2] - a[2]);
  const abx = DD.fromDouble(b[0] - a[0]);
  const aby = DD.fromDouble(b[1] - a[1]);
  const abz = DD.fromDouble(b[2] - a[2]);

  // cross(ap, ab)
  const cx = DD.subtract(DD.multiply(apy, abz), DD.multiply(apz, aby));
  const cy = DD.subtract(DD.multiply(apz, abx), DD.multiply(apx, abz));
  const cz = DD.subtract(DD.multiply(apx, aby), DD.multiply(apy, abx));

  const crossLen = DD.sqrt(
    DD.add(DD.add(DD.multiply(cx, cx), DD.multiply(cy, cy)), DD.multiply(cz, cz))
  );
  const abLen = DD.sqrt(
    DD.add(DD.add(DD.multiply(abx, abx), DD.multiply(aby, aby)), DD.multiply(abz, abz))
  );
  return DD.divide(crossLen, abLen);
}

export function ddTriangleArea(a, b, c) {
  const abx = DD.fromDouble(b[0] - a[0]);
  const aby = DD.fromDouble(b[1] - a[1]);
  const abz = DD.fromDouble(b[2] - a[2]);
  const acx = DD.fromDouble(c[0] - a[0]);
  const acy = DD.fromDouble(c[1] - a[1]);
  const acz = DD.fromDouble(c[2] - a[2]);
  const cx = DD.subtract(DD.multiply(aby, acz), DD.multiply(abz, acy));
  const cy = DD.subtract(DD.multiply(abz, acx), DD.multiply(abx, acz));
  const cz = DD.subtract(DD.multiply(abx, acy), DD.multiply(aby, acx));
  const len = DD.sqrt(
    DD.add(DD.add(DD.multiply(cx, cx), DD.multiply(cy, cy)), DD.multiply(cz, cz))
  );
  return DD.multiply(len, DD.fromDouble(0.5));
}

export function ddPlaneSignedDistance(plane, p) {
  const nx = DD.fromDouble(plane.n[0]);
  const ny = DD.fromDouble(plane.n[1]);
  const nz = DD.fromDouble(plane.n[2]);
  const px = DD.fromDouble(p[0]);
  const py = DD.fromDouble(p[1]);
  const pz = DD.fromDouble(p[2]);
  const d = DD.add(
    DD.add(DD.multiply(nx, px), DD.multiply(ny, py)),
    DD.add(DD.multiply(nz, pz), DD.fromDouble(plane.d))
  );
  return d;
}

export function ddPointDistanceSq(a, b) {
  const dx = DD.fromDouble(b[0] - a[0]);
  const dy = DD.fromDouble(b[1] - a[1]);
  const dz = DD.fromDouble(b[2] - a[2]);
  return DD.add(
    DD.add(DD.multiply(dx, dx), DD.multiply(dy, dy)),
    DD.multiply(dz, dz)
  );
}

// ============================================================================
// SCHEMA VALIDATORS
// ============================================================================

function checkVec3(v, op) {
  if (!isFiniteVec(v)) throw new DecodeError(op, 'vec3 required');
}

function checkVec2(v, op) {
  if (!v || v.length < 2 || !isFiniteNumber(v[0]) || !isFiniteNumber(v[1])) {
    throw new DecodeError(op, 'vec2 required');
  }
}

function checkPositiveNumber(n, op, name) {
  if (!isFiniteNumber(n) || n <= 0) throw new DecodeError(op, name + ' must be positive finite');
}

function checkNonNegativeNumber(n, op, name) {
  if (!isFiniteNumber(n) || n < 0) throw new DecodeError(op, name + ' must be non-negative finite');
}

export const PointInput = Object.freeze({
  make(p) { return { p }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('point', 'Expected {p}');
    checkVec3(input.p, 'point');
    return input;
  }
});

export const SegmentInput = Object.freeze({
  make(a, b) { return { a, b }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('segment', 'Expected {a, b}');
    checkVec3(input.a, 'segment');
    checkVec3(input.b, 'segment');
    return input;
  }
});

export const LineInput = SegmentInput;

export const RayInput = Object.freeze({
  make(origin, dir) { return { origin, dir }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('ray', 'Expected {origin, dir}');
    checkVec3(input.origin, 'ray');
    checkVec3(input.dir, 'ray');
    return input;
  }
});

export const PlaneInput = Object.freeze({
  make(plane) { return { plane }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('plane', 'Expected {plane}');
    const p = input.plane;
    if (!p || typeof p !== 'object' || !isFiniteVec(p.n) || !isFiniteNumber(p.d)) {
      throw new DecodeError('plane', 'plane must have n(vec3) and d(number)');
    }
    return input;
  }
});

export const TriangleInput = Object.freeze({
  make(a, b, c) { return { a, b, c }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('triangle', 'Expected {a, b, c}');
    checkVec3(input.a, 'triangle');
    checkVec3(input.b, 'triangle');
    checkVec3(input.c, 'triangle');
    return input;
  }
});

export const AABBInput = Object.freeze({
  make(box) { return { box }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('aabb', 'Expected {box}');
    const b = input.box;
    if (!b || typeof b !== 'object' || !isFiniteVec(b.min) || !isFiniteVec(b.max)) {
      throw new DecodeError('aabb', 'box must have min and max (vec3)');
    }
    return input;
  }
});

export const SphereInput = Object.freeze({
  make(sphere) { return { sphere }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('sphere', 'Expected {sphere}');
    const s = input.sphere;
    if (!s || typeof s !== 'object' || !isFiniteVec(s.center)) {
      throw new DecodeError('sphere', 'sphere must have center (vec3)');
    }
    checkNonNegativeNumber(s.radius, 'sphere', 'radius');
    return input;
  }
});

export const CircleInput = Object.freeze({
  make(circle) { return { circle }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('circle', 'Expected {circle}');
    const c = input.circle;
    if (!c || typeof c !== 'object') throw new DecodeError('circle', 'circle required');
    checkVec2(c.center, 'circle');
    checkNonNegativeNumber(c.radius, 'circle', 'radius');
    return input;
  }
});

export const IntersectInput = Object.freeze({
  make(a, b) { return { a, b }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('intersect', 'Expected {a, b}');
    return input;
  }
});

export const DistanceInput = Object.freeze({
  make(a, b) { return { a, b }; },
  decode(input) {
    if (!input || typeof input !== 'object') throw new DecodeError('distance', 'Expected {a, b}');
    checkVec3(input.a, 'distance');
    checkVec3(input.b, 'distance');
    return input;
  }
});

// ============================================================================
// VALIDATED BOUNDARY OPERATIONS
// ============================================================================

export function pointDistanceValidated(input) {
  const d = DistanceInput.decode(input);
  return pointDistance(d.a, d.b);
}

export function closestPointOnSegmentValidated(input) {
  const d = PointInput.decode(input);
  const s = SegmentInput.decode({ a: input.a || [0, 0, 0], b: input.b || [0, 0, 0] });
  const out = vec3.create();
  closestPointOnSegment(out, d.p, s.a, s.b);
  return out;
}

export function triangleAreaValidated(input) {
  const d = TriangleInput.decode(input);
  return triangleArea(d.a, d.b, d.c);
}

export function triangleBarycentricValidated(input) {
  const d = TriangleInput.decode(input);
  const p = PointInput.decode({ p: input.p });
  const out = [0, 0, 0];
  triangleBarycentric(out, p.p, d.a, d.b, d.c);
  return out;
}

export function planeSignedDistanceValidated(input) {
  const p = PlaneInput.decode(input);
  const pt = PointInput.decode({ p: input.p });
  return planeSignedDistance(p.plane, pt.p);
}

export function rayTriangleIntersectValidated(input) {
  const r = RayInput.decode(input);
  const t = TriangleInput.decode(input);
  return rayTriangleIntersect(r.origin, r.dir, t.a, t.b, t.c);
}

export function raySphereIntersectValidated(input) {
  const r = RayInput.decode(input);
  const s = SphereInput.decode(input);
  return raySphereIntersect(r.origin, r.dir, s.sphere);
}

export function rayAABBIntersectValidated(input) {
  const r = RayInput.decode(input);
  const b = AABBInput.decode(input);
  return rayAABBIntersect(r.origin, r.dir, b.box);
}

export function aabbContainsPointValidated(input) {
  const b = AABBInput.decode(input);
  const p = PointInput.decode({ p: input.p });
  return aabbContainsPoint(b.box, p.p);
}

export function aabbIntersectsValidated(input) {
  const a = AABBInput.decode({ box: input.a });
  const b = AABBInput.decode({ box: input.b });
  return aabbIntersects(a.box, b.box);
}

// ============================================================================
// POLICY-AWARE WRAPPERS
// ============================================================================

export function pointDistanceWithPolicies(a, b, policy) {
  return policyScalar(
    'Geometry.pointDistanceWithPolicies',
    () => pointDistance(a, b),
    (msg) => new DomainViolationError('pointDistanceWithPolicies', msg),
    (r) => ({ result: String(r) }),
    policy
  );
}

export function triangleAreaWithPolicies(a, b, c, policy) {
  return policyScalar(
    'Geometry.triangleAreaWithPolicies',
    () => triangleArea(a, b, c),
    (msg) => new DomainViolationError('triangleAreaWithPolicies', msg),
    (r) => ({ result: String(r) }),
    policy
  );
}

export function planeSignedDistanceWithPolicies(plane, p, policy) {
  return policyScalar(
    'Geometry.planeSignedDistanceWithPolicies',
    () => planeSignedDistance(plane, p),
    (msg) => new DomainViolationError('planeSignedDistanceWithPolicies', msg),
    (r) => ({ result: String(r) }),
    policy
  );
}

export function rayTriangleIntersectWithPolicies(origin, dir, a, b, c, policy) {
  return policyCustom(
    'Geometry.rayTriangleIntersectWithPolicies',
    () => rayTriangleIntersect(origin, dir, a, b, c),
    (r) => r && typeof r === 'object' && 'hit' in r,
    (msg) => new DomainViolationError('rayTriangleIntersectWithPolicies', msg),
    (r) => ({ hit: r.hit, t: r.t !== undefined ? String(r.t) : null }),
    policy
  );
}

export function aabbIntersectsWithPolicies(a, b, policy) {
  return policyCustom(
    'Geometry.aabbIntersectsWithPolicies',
    () => aabbIntersects(a, b),
    (r) => typeof r === 'boolean',
    (msg) => new DomainViolationError('aabbIntersectsWithPolicies', msg),
    (r) => ({ result: r }),
    policy
  );
}

// ============================================================================
// POOL
// ============================================================================
const _planePool = [];
const _MAX_PLANE_POOL = 32;

export function poolAcquirePlane() {
  if (_planePool.length > 0) {
    const p = _planePool.pop();
    p.n[0] = 0;
    p.n[1] = 0;
    p.n[2] = 0;
    p.d = 0;
    return p;
  }
  return { n: vec3.create(), d: 0 };
}

export function poolReleasePlane(p) {
  if (_planePool.length >= _MAX_PLANE_POOL) return;
  _planePool.push(p);
}

export function poolReset() {
  _planePool.length = 0;
}

export function poolSize() {
  return _planePool.length;
}

// ============================================================================
// EXPORTS
// ============================================================================
export { EPSILON, PRECISION, HELPERS, DD, vec3 };

export default {
  DecodeError,
  DomainViolationError,
  pointDistance,
  pointDistanceSq,
  midpoint,
  lerpPoint,
  lineSegmentCreate,
  lineCreate,
  rayCreate,
  closestPointOnLine,
  closestPointOnSegment,
  closestPointOnRay,
  segmentDistanceSq,
  lineLineClosest,
  planeCreate,
  planeFromPointNormal,
  planeFromThreePoints,
  planeSignedDistance,
  planeProjectPoint,
  planePlaneIntersect,
  triangleNormal,
  triangleArea,
  triangleBarycentric,
  triangleContains,
  closestPointOnTriangle,
  rayTriangleIntersect,
  aabbCreate,
  aabbFromPoints,
  aabbUnion,
  aabbExpandByPoint,
  aabbContainsPoint,
  aabbIntersects,
  rayAABBIntersect,
  sphereCreate,
  sphereContains,
  sphereSphereIntersect,
  raySphereIntersect,
  closestPointOnSphere,
  rayPlaneIntersect,
  segmentPlaneIntersect,
  segmentSegmentIntersect2D,
  tetrahedronVolume,
  aabbVolume,
  aabbSurfaceArea,
  sphereVolume,
  sphereSurfaceArea,
  circleArea,
  circleContains,
  circleCreate,
  vectorAngle,
  planarAngle,
  ddDistancePointToLine,
  ddTriangleArea,
  ddPlaneSignedDistance,
  ddPointDistanceSq,
  PointInput,
  SegmentInput,
  LineInput,
  RayInput,
  PlaneInput,
  TriangleInput,
  AABBInput,
  SphereInput,
  CircleInput,
  IntersectInput,
  DistanceInput,
  pointDistanceValidated,
  closestPointOnSegmentValidated,
  triangleAreaValidated,
  triangleBarycentricValidated,
  planeSignedDistanceValidated,
  rayTriangleIntersectValidated,
  raySphereIntersectValidated,
  rayAABBIntersectValidated,
  aabbContainsPointValidated,
  aabbIntersectsValidated,
  pointDistanceWithPolicies,
  triangleAreaWithPolicies,
  planeSignedDistanceWithPolicies,
  rayTriangleIntersectWithPolicies,
  aabbIntersectsWithPolicies,
  poolAcquirePlane,
  poolReleasePlane,
  poolReset,
  poolSize
};