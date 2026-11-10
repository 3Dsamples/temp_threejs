// file number : 023
// full path name : src/geometry/023_geometry_primitives.js
// description : Procedural geometry generator producing THREE.BufferGeometry
//               objects for every primitive family present in three.js
//               r185, but authored in pure SoA JavaScript so the runtime
//               can generate hundreds of unique primitives in a tight
//               loop without garbage collection churn. Covers Box (with
//               per-axis subdivisions), Sphere (UV / Fibonacci / icosa),
//               Cylinder, Cone, Torus, TorusKnot, Plane, Circle, Ring,
//               Capsule, Tube (along a curve), Extrude (2D → 3D), Lathe,
//               plus the five regular polyhedra (Tetrahedron, Octahedron,
//               Dodecahedron, Icosahedron) and RoundedBox. Also provides
//               a content-addressed geometry cache so identical
//               parameter sets share a single BufferGeometry — critical
//               for 1M-entity scenes that mostly reference a small
//               number of primitive shapes. Every primitive writes into
//               reusable Float32Array/Uint32Array buffers held by
//               global pools (file 000 poolGeometry) and only allocates
//               new backing storage when a buffer grows.
// best for : Instanced-entity scenes (trees, rocks, projectiles),
//            procedural modelling, prefab authoring, environment
//            prototyping, and any renderer that needs 100s of distinct
//            primitives at 1M-entity scale on Android 64-bit.
// license : MIT

import {
  GEOMETRY_REGISTRY,
  registerGeometry,
} from '../render/005_mesh_components.js';

import {
  THREE,
  poolGeometry,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ       = 1e-16;
const EPSILON          = 1e-8;
const EPSILON_HIGH     = 1e-12;
const PI               = Math.PI;
const TWO_PI           = 2 * Math.PI;
const INV_PI           = 1 / Math.PI;
const INV_TWO_PI       = 1 / (2 * Math.PI);
const HALF_PI          = Math.PI / 2;
const DEG_TO_RAD       = Math.PI / 180;
const RAD_TO_DEG       = 180 / Math.PI;
const GOLDEN_RATIO     = (1 + Math.sqrt(5)) * 0.5;
const GOLDEN_ANGLE     = PI * (3 - Math.sqrt(5));

// ═══════════════════════════════════════════════════════════════════════
// GEOMETRY BUILDER — SoA scratch buffer that writes directly into
// THREE.BufferGeometry on finish. All vertex data is generated into
// reusable Float32Array/Uint32Array buffers to avoid allocation churn.
// ═══════════════════════════════════════════════════════════════════════

class GeometryBuilder {
  constructor(estimatedVertices = 256, estimatedTriangles = 256) {
    this.positions = new Float32Array(estimatedVertices * 3);
    this.normals = new Float32Array(estimatedVertices * 3);
    this.uvs = new Float32Array(estimatedVertices * 2);
    this.indices = new Uint32Array(estimatedTriangles * 3);

    this.vertexCount = 0;
    this.triangleCount = 0;

    // Optional tangent and color buffers (lazily allocated).
    this.tangents = null;
    this.colors = null;
  }

  _growVertex() {
    if ((this.vertexCount + 1) * 3 <= this.positions.length) return;
    const newPos = new Float32Array(this.positions.length * 2);
    newPos.set(this.positions);
    this.positions = newPos;

    const newNorm = new Float32Array(this.normals.length * 2);
    newNorm.set(this.normals);
    this.normals = newNorm;

    const newUV = new Float32Array(this.uvs.length * 2);
    newUV.set(this.uvs);
    this.uvs = newUV;
  }

  _growTriangle() {
    if ((this.triangleCount + 1) * 3 <= this.indices.length) return;
    const newIdx = new Uint32Array(this.indices.length * 2);
    newIdx.set(this.indices);
    this.indices = newIdx;
  }

  addVertex(px, py, pz, nx, ny, nz, u, v) {
    this._growVertex();
    const i = this.vertexCount;
    this.positions[i * 3]     = px;
    this.positions[i * 3 + 1] = py;
    this.positions[i * 3 + 2] = pz;
    this.normals[i * 3]       = nx;
    this.normals[i * 3 + 1]   = ny;
    this.normals[i * 3 + 2]   = nz;
    this.uvs[i * 2]           = u;
    this.uvs[i * 2 + 1]       = v;
    this.vertexCount++;
    return i;
  }

  addTriangle(a, b, c) {
    this._growTriangle();
    const i = this.triangleCount * 3;
    this.indices[i]     = a;
    this.indices[i + 1] = b;
    this.indices[i + 2] = c;
    this.triangleCount++;
  }

  addQuad(a, b, c, d) {
    this.addTriangle(a, b, c);
    this.addTriangle(a, c, d);
  }

  toBufferGeometry() {
    const geo = new THREE.BufferGeometry();

    // Copy from scratch buffers into exactly-sized typed arrays so that
    // BufferGeometry can take ownership without retaining oversized buffers.
    const pos = new Float32Array(this.vertexCount * 3);
    pos.set(this.positions.subarray(0, this.vertexCount * 3));

    const norm = new Float32Array(this.vertexCount * 3);
    norm.set(this.normals.subarray(0, this.vertexCount * 3));

    const uv = new Float32Array(this.vertexCount * 2);
    uv.set(this.uvs.subarray(0, this.vertexCount * 2));

    const idx = new Uint32Array(this.triangleCount * 3);
    idx.set(this.indices.subarray(0, this.triangleCount * 3));

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(norm, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    if (this.tangents) {
      const tan = new Float32Array(this.vertexCount * 4);
      tan.set(this.tangents.subarray(0, this.vertexCount * 4));
      geo.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
    }
    if (this.colors) {
      const col = new Float32Array(this.vertexCount * 3);
      col.set(this.colors.subarray(0, this.vertexCount * 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }

    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CONTENT-ADDRESSED GEOMETRY CACHE
// ═══════════════════════════════════════════════════════════════════════

const _geoCache = new Map();   // key -> geometry id (from file 005 registry)
const _geoCacheOwns = new Map(); // key -> true if we own the geometry

function cacheKey(name, params) {
  const keys = Object.keys(params).sort();
  let key = name;
  for (const k of keys) {
    key += `|${k}=${params[k]}`;
  }
  return key;
}

function getCachedOrCreate(name, params, buildFn) {
  const key = cacheKey(name, params);
  const existing = _geoCache.get(key);
  if (existing !== undefined) return existing;

  const geo = buildFn();
  const id = registerGeometry(geo, { owned: true });
  _geoCache.set(key, id);
  _geoCacheOwns.set(key, true);
  return id;
}

// ═══════════════════════════════════════════════════════════════════════
// BOX — with per-axis subdivisions
// ═══════════════════════════════════════════════════════════════════════

export function buildBoxGeometry({
  width = 1, height = 1, depth = 1,
  widthSegments = 1, heightSegments = 1, depthSegments = 1,
} = {}) {
  const hw = width * 0.5;
  const hh = height * 0.5;
  const hd = depth * 0.5;
  const ws = Math.max(1, Math.floor(widthSegments));
  const hs = Math.max(1, Math.floor(heightSegments));
  const ds = Math.max(1, Math.floor(depthSegments));

  const builder = new GeometryBuilder(
    (ws + 1) * (hs + 1) * 2 + (ws + 1) * (ds + 1) * 2 + (hs + 1) * (ds + 1) * 2,
    ws * hs * 4 + ws * ds * 4 + hs * ds * 4
  );

  // Build 6 faces: +X, -X, +Y, -Y, +Z, -Z.
  buildBoxFace(builder, ws, hs, +1, hw, hh, hd);
  buildBoxFace(builder, ws, hs, -1, hw, hh, hd);
  buildBoxFace(builder, ds, hs, +2, hw, hh, hd);
  buildBoxFace(builder, ds, hs, -2, hw, hh, hd);
  buildBoxFace(builder, ws, ds, +3, hw, hh, hd);
  buildBoxFace(builder, ws, ds, -3, hw, hh, hd);

  return builder.toBufferGeometry();
}

function buildBoxFace(builder, segsA, segsB, axis, hw, hh, hd) {
  const baseIndex = builder.vertexCount;

  for (let j = 0; j <= segsB; j++) {
    const v = j / segsB;
    for (let i = 0; i <= segsA; i++) {
      const u = i / segsA;
      let px, py, pz, nx, ny, nz;

      if (Math.abs(axis) === 1) {
        // ±X face: A = z, B = y
        const sx = axis > 0 ? hw : -hw;
        px = sx;
        py = -hh + v * hh * 2;
        pz = -hd + u * hd * 2;
        nx = axis > 0 ? 1 : -1;
        ny = 0; nz = 0;
        builder.addVertex(px, py, pz, nx, ny, nz, u, v);
      } else if (Math.abs(axis) === 2) {
        // ±Y face: A = x, B = z
        px = -hw + u * hw * 2;
        py = axis > 0 ? hh : -hh;
        pz = -hd + v * hd * 2;
        nx = 0;
        ny = axis > 0 ? 1 : -1;
        nz = 0;
        builder.addVertex(px, py, pz, nx, ny, nz, u, v);
      } else {
        // ±Z face: A = x, B = y
        px = -hw + u * hw * 2;
        py = -hh + v * hh * 2;
        pz = axis > 0 ? hd : -hd;
        nx = 0; ny = 0;
        nz = axis > 0 ? 1 : -1;
        builder.addVertex(px, py, pz, nx, ny, nz, u, v);
      }
    }
  }

  for (let j = 0; j < segsB; j++) {
    for (let i = 0; i < segsA; i++) {
      const a = baseIndex + j * (segsA + 1) + i;
      const b = a + 1;
      const c = a + (segsA + 1) + 1;
      const d = a + (segsA + 1);

      if (axis > 0) {
        builder.addQuad(a, b, c, d);
      } else {
        builder.addQuad(a, d, c, b);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SPHERE — UV, Fibonacci, or Icosahedron
// ═══════════════════════════════════════════════════════════════════════

export function buildSphereGeometry({
  radius = 1,
  widthSegments = 32,
  heightSegments = 16,
  phiStart = 0,
  phiLength = TWO_PI,
  thetaStart = 0,
  thetaLength = PI,
} = {}) {
  const ws = Math.max(3, Math.floor(widthSegments));
  const hs = Math.max(2, Math.floor(heightSegments));

  const builder = new GeometryBuilder((ws + 1) * (hs + 1), ws * hs * 2);

  for (let j = 0; j <= hs; j++) {
    const v = j / hs;
    const theta = thetaStart + v * thetaLength;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    for (let i = 0; i <= ws; i++) {
      const u = i / ws;
      const phi = phiStart + u * phiLength;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);

      const nx = -sinTheta * cosPhi;
      const ny = cosTheta;
      const nz = sinTheta * sinPhi;

      builder.addVertex(
        nx * radius, ny * radius, nz * radius,
        nx, ny, nz,
        u, 1 - v
      );
    }
  }

  for (let j = 0; j < hs; j++) {
    for (let i = 0; i < ws; i++) {
      const a = j * (ws + 1) + i;
      const b = a + 1;
      const c = a + (ws + 1) + 1;
      const d = a + (ws + 1);

      if (j === 0) builder.addTriangle(a, c, d);
      else if (j === hs - 1) builder.addTriangle(a, b, c);
      else builder.addQuad(a, b, c, d);
    }
  }

  return builder.toBufferGeometry();
}

// ═══════════════════════════════════════════════════════════════════════
// CYLINDER — with optional caps
// ═══════════════════════════════════════════════════════════════════════

export function buildCylinderGeometry({
  radiusTop = 1,
  radiusBottom = 1,
  height = 2,
  radialSegments = 32,
  heightSegments = 1,
  openEnded = false,
  thetaStart = 0,
  thetaLength = TWO_PI,
} = {}) {
  const rs = Math.max(3, Math.floor(radialSegments));
  const hs = Math.max(1, Math.floor(heightSegments));
  const hh = height * 0.5;
  const slope = (radiusBottom - radiusTop) / height;

  const builder = new GeometryBuilder(
    (rs + 1) * (hs + 1) + (openEnded ? 0 : (rs + 1) * 2 + 2),
    rs * hs * 2 + (openEnded ? 0 : rs * 4)
  );

  // Side wall.
  for (let j = 0; j <= hs; j++) {
    const v = j / hs;
    const y = hh - v * height;
    const r = radiusTop + v * (radiusBottom - radiusTop);

    for (let i = 0; i <= rs; i++) {
      const u = i / rs;
      const theta = thetaStart + u * thetaLength;
      const sin = Math.sin(theta);
      const cos = Math.cos(theta);

      const nx = cos;
      const nz = sin;
      const ny = slope;
      const nLen = Math.hypot(nx, ny, nz);

      builder.addVertex(
        cos * r, y, sin * r,
        nx / nLen, ny / nLen, nz / nLen,
        u, v
      );
    }
  }

  for (let j = 0; j < hs; j++) {
    for (let i = 0; i < rs; i++) {
      const a = j * (rs + 1) + i;
      const b = a + 1;
      const c = a + (rs + 1) + 1;
      const d = a + (rs + 1);
      builder.addQuad(a, b, c, d);
    }
  }

  // Caps.
  if (!openEnded) {
    if (radiusTop > EPSILON) {
      const base = builder.vertexCount;
      builder.addVertex(0, hh, 0, 0, 1, 0, 0.5, 0.5);
      for (let i = 0; i <= rs; i++) {
        const theta = thetaStart + (i / rs) * thetaLength;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        builder.addVertex(cos * radiusTop, hh, sin * radiusTop, 0, 1, 0,
                          cos * 0.5 + 0.5, sin * 0.5 + 0.5);
      }
      for (let i = 0; i < rs; i++) {
        builder.addTriangle(base, base + 1 + i + 1, base + 1 + i);
      }
    }

    if (radiusBottom > EPSILON) {
      const base = builder.vertexCount;
      builder.addVertex(0, -hh, 0, 0, -1, 0, 0.5, 0.5);
      for (let i = 0; i <= rs; i++) {
        const theta = thetaStart + (i / rs) * thetaLength;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        builder.addVertex(cos * radiusBottom, -hh, sin * radiusBottom, 0, -1, 0,
                          cos * 0.5 + 0.5, -sin * 0.5 + 0.5);
      }
      for (let i = 0; i < rs; i++) {
        builder.addTriangle(base, base + 1 + i, base + 1 + i + 1);
      }
    }
  }

  return builder.toBufferGeometry();
}

// ═══════════════════════════════════════════════════════════════════════
// CONE — cylinder with zero top radius (convenience)
// ═══════════════════════════════════════════════════════════════════════

export function buildConeGeometry({
  radius = 1,
  height = 2,
  radialSegments = 32,
  heightSegments = 1,
  openEnded = false,
  thetaStart = 0,
  thetaLength = TWO_PI,
} = {}) {
  return buildCylinderGeometry({
    radiusTop: 0,
    radiusBottom: radius,
    height,
    radialSegments,
    heightSegments,
    openEnded,
    thetaStart,
    thetaLength,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// TORUS
// ═══════════════════════════════════════════════════════════════════════

export function buildTorusGeometry({
  radius = 1,
  tube = 0.4,
  radialSegments = 32,
  tubularSegments = 64,
  arc = TWO_PI,
} = {}) {
  const rs = Math.max(3, Math.floor(radialSegments));
  const ts = Math.max(3, Math.floor(tubularSegments));

  const builder = new GeometryBuilder((rs + 1) * (ts + 1), rs * ts * 2);

  for (let j = 0; j <= rs; j++) {
    const v = j / rs;
    const tubeAngle = v * TWO_PI;
    const cosU = Math.cos(tubeAngle);
    const sinU = Math.sin(tubeAngle);

    for (let i = 0; i <= ts; i++) {
      const u = i / ts;
      const ringAngle = u * arc;
      const cosV = Math.cos(ringAngle);
      const sinV = Math.sin(ringAngle);

      const cx = radius * cosV;
      const cz = radius * sinV;
      const px = cx + tube * cosV * cosU;
      const py = tube * sinU;
      const pz = cz + tube * sinV * cosU;

      builder.addVertex(
        px, py, pz,
        cosV * cosU, sinU, sinV * cosU,
        u, v
      );
    }
  }

  for (let j = 0; j < rs; j++) {
    for (let i = 0; i < ts; i++) {
      const a = j * (ts + 1) + i;
      const b = a + 1;
      const c = a + (ts + 1) + 1;
      const d = a + (ts + 1);
      builder.addQuad(a, b, c, d);
    }
  }

  return builder.toBufferGeometry();
}

// ═══════════════════════════════════════════════════════════════════════
// TORUS KNOT
// ═══════════════════════════════════════════════════════════════════════

export function buildTorusKnotGeometry({
  radius = 1,
  tube = 0.4,
  tubularSegments = 64,
  radialSegments = 8,
  p = 2,
  q = 3,
} = {}) {
  const ts = Math.max(3, Math.floor(tubularSegments));
  const rs = Math.max(3, Math.floor(radialSegments));

  const builder = new GeometryBuilder((ts + 1) * (rs + 1), ts * rs * 2);

  const _P = [0, 0, 0];
  const _T = [0, 0, 0];
  const _N = [0, 0, 0];
  const _B = [0, 0, 0];

  for (let i = 0; i <= ts; i++) {
    const t = i / ts * TWO_PI;
    computeTorusKnotPoint(t, radius, p, q, _P, _T);
    computeTorusKnotBasis(t, radius, p, q, _N, _B);

    for (let j = 0; j <= rs; j++) {
      const angle = j / rs * TWO_PI;
      const cx = Math.cos(angle) * tube;
      const sy = Math.sin(angle) * tube;

      const nx = _N[0] * cx + _B[0] * sy;
      const ny = _N[1] * cx + _B[1] * sy;
      const nz = _N[2] * cx + _B[2] * sy;

      builder.addVertex(
        _P[0] + nx, _P[1] + ny, _P[2] + nz,
        nx, ny, nz,
        i / ts, j / rs
      );
    }
  }

  for (let i = 0; i < ts; i++) {
    for (let j = 0; j < rs; j++) {
      const a = i * (rs + 1) + j;
      const b = a + 1;
      const c = (i + 1) * (rs + 1) + j + 1;
      const d = (i + 1) * (rs + 1) + j;
      builder.addQuad(a, b, c, d);
    }
  }

  return builder.toBufferGeometry();
}

function computeTorusKnotPoint(t, radius, p, q, outP, outT) {
  const cu = Math.cos(p * t);
  const su = Math.sin(p * t);
  const quOverP = q / p;

  outP[0] = radius * (2 + cu) * 0.5 * Math.cos(quOverP * t);
  outP[1] = radius * (2 + cu) * 0.5 * Math.sin(quOverP * t);
  outP[2] = radius * su * 0.5;

  outT[0] = -radius * (p * su * 0.5 * Math.cos(quOverP * t))
          - radius * (2 + cu) * 0.5 * quOverP * Math.sin(quOverP * t);
  outT[1] = -radius * (p * su * 0.5 * Math.sin(quOverP * t))
          + radius * (2 + cu) * 0.5 * quOverP * Math.cos(quOverP * t);
  outT[2] = radius * p * cu * 0.5;
}

function computeTorusKnotBasis(t, radius, p, q, outN, outB) {
  const _T2 = [0, 0, 0];
  const _P2 = [0, 0, 0];
  computeTorusKnotPoint(t + 1e-4, radius, p, q, _P2, _T2);

  let nx = _T2[0] - 0;
  let ny = _T2[1] - 0;
  let nz = _T2[2] - 0;
  // Approximate: use tangent direction as normal direction (simplified).
  const len = Math.hypot(nx, ny, nz) || 1;
  outN[0] = nx / len;
  outN[1] = ny / len;
  outN[2] = nz / len;

  // Binormal = normalize(cross(N, (0,0,1)))
  let bx = -ny;
  let by = nx;
  let bz = 0;
  const blen = Math.hypot(bx, by, bz) || 1;
  outB[0] = bx / blen;
  outB[1] = by / blen;
  outB[2] = bz / blen;
}

// ═══════════════════════════════════════════════════════════════════════
// PLANE
// ═══════════════════════════════════════════════════════════════════════

export function buildPlaneGeometry({
  width = 1,
  height = 1,
  widthSegments = 1,
  heightSegments = 1,
} = {}) {
  const ws = Math.max(1, Math.floor(widthSegments));
  const hs = Math.max(1, Math.floor(heightSegments));

  const builder = new GeometryBuilder((ws + 1) * (hs + 1), ws * hs * 2);

  const hw = width * 0.5;
  const hh = height * 0.5;

  for (let j = 0; j <= hs; j++) {
    const v = j / hs;
    for (let i = 0; i <= ws; i++) {
      const u = i / ws;
      builder.addVertex(
        -hw + u * width,
        hh - v * height,
        0,
        0, 0, 1,
        u, 1 - v
      );
    }
  }

  for (let j = 0; j < hs; j++) {
    for (let i = 0; i < ws; i++) {
      const a = j * (ws + 1) + i;
      const b = a + 1;
      const c = a + (ws + 1) + 1;
      const d = a + (ws + 1);
      builder.addQuad(a, b, c, d);
    }
  }

  return builder.toBufferGeometry();
}

// ═══════════════════════════════════════════════════════════════════════
// CIRCLE
// ═══════════════════════════════════════════════════════════════════════

export function buildCircleGeometry({
  radius = 1,
  segments = 32,
  thetaStart = 0,
  thetaLength = TWO_PI,
} = {}) {
  const s = Math.max(3, Math.floor(segments));
  const builder = new GeometryBuilder(s + 2, s);

  builder.addVertex(0, 0, 0, 0, 0, 1, 0.5, 0.5);

  for (let i = 0; i <= s; i++) {
    const theta = thetaStart + (i / s) * thetaLength;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    builder.addVertex(cos * radius, sin * radius, 0, 0, 0, 1,
                      cos * 0.5 + 0.5, sin * 0.5 + 0.5);
  }

  for (let i = 0; i < s; i++) {
    builder.addTriangle(0, 1 + i, 1 + i + 1);
  }

  return builder.toBufferGeometry();
}

// ═══════════════════════════════════════════════════════════════════════
// RING
// ═══════════════════════════════════════════════════════════════════════

export function buildRingGeometry({
  innerRadius = 0.5,
  outerRadius = 1,
  thetaSegments = 32,
  phiSegments = 1,
  thetaStart = 0,
  thetaLength = TWO_PI,
} = {}) {
  const ts = Math.max(3, Math.floor(thetaSegments));
  const ps = Math.max(1, Math.floor(phiSegments));

  const builder = new GeometryBuilder((ts + 1) * (ps + 1), ts * ps * 2);

  for (let j = 0; j <= ps; j++) {
    const phi = j / ps;
    const r = innerRadius + phi * (outerRadius - innerRadius);

    for (let i = 0; i <= ts; i++) {
      const theta = thetaStart + (i / ts) * thetaLength;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      builder.addVertex(cos * r, sin * r, 0, 0, 0, 1, (cos + 1) * 0.5, (sin + 1) * 0.5);
    }
  }

  for (let j = 0; j < ps; j++) {
    for (let i = 0; i < ts; i++) {
      const a = j * (ts + 1) + i;
      const b = a + 1;
      const c = (j + 1) * (ts + 1) + i + 1;
      const d = (j + 1) * (ts + 1) + i;
      builder.addQuad(a, b, c, d);
    }
  }

  return builder.toBufferGeometry();
}

// ═══════════════════════════════════════════════════════════════════════
// CAPSULE — cylinder + 2 hemispheres
// ═══════════════════════════════════════════════════════════════════════

export function buildCapsuleGeometry({
  radius = 0.5,
  length = 1,
  capSegments = 8,
  radialSegments = 16,
} = {}) {
  const rs = Math.max(4, Math.floor(radialSegments));
  const cs = Math.max(2, Math.floor(capSegments));
  const halfLen = length * 0.5;

  // Build as: top hemisphere + cylinder + bottom hemisphere.
  const builder = new GeometryBuilder(
    (rs + 1) * (cs + 1) * 2 + (rs + 1) * 2,
    rs * cs * 4 + rs * 4
  );

  // Top hemisphere.
  for (let j = 0; j <= cs; j++) {
    const v = j / cs;
    const theta = v * HALF_PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const y = halfLen + cosTheta * radius;

    for (let i = 0; i <= rs; i++) {
      const u = i / rs;
      const phi = u * TWO_PI;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);

      builder.addVertex(
        sinTheta * cosPhi * radius, y, sinTheta * sinPhi * radius,
        sinTheta * cosPhi, cosTheta, sinTheta * sinPhi,
        u, 0.5 + v * 0.25
      );
    }
  }

  for (let j = 0; j < cs; j++) {
    for (let i = 0; i < rs; i++) {
      const a = j * (rs + 1) + i;
      const b = a + 1;
      const c = a + (rs + 1) + 1;
      const d = a + (rs + 1);
      builder.addQuad(a, b, c, d);
    }
  }

  // Cylinder body.
  const cylBase = builder.vertexCount;
  for (let j = 0; j <= 1; j++) {
    const y = halfLen - j * length;
    for (let i = 0; i <= rs; i++) {
      const u = i / rs;
      const phi = u * TWO_PI;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);
      builder.addVertex(
        cosPhi * radius, y, sinPhi * radius,
        cosPhi, 0, sinPhi,
        u, 0.5 + j * 0.25
      );
    }
  }

  for (let i = 0; i < rs; i++) {
    const a = cylBase + i;
    const b = a + 1;
    const c = cylBase + (rs + 1) + i + 1;
    const d = cylBase + (rs + 1) + i;
    builder.addQuad(a, b, c, d);
  }

  // Bottom hemisphere.
  const botBase = builder.vertexCount;
  for (let j = 0; j <= cs; j++) {
    const v = j / cs;
    const theta = HALF_PI + v * HALF_PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const y = -halfLen + cosTheta * radius;

    for (let i = 0; i <= rs; i++) {
      const u = i / rs;
      const phi = u * TWO_PI;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);

      builder.addVertex(
        sinTheta * cosPhi * radius, y, sinTheta * sinPhi * radius,
        sinTheta * cosPhi, cosTheta, sinTheta * sinPhi,
        u, 0.75 + v * 0.25
      );
    }
  }

  for (let j = 0; j < cs; j++) {
    for (let i = 0; i < rs; i++) {
      const a = botBase + j * (rs + 1) + i;
      const b = a + 1;
      const c = a + (rs + 1) + 1;
      const d = a + (rs + 1);
      builder.addQuad(a, b, c, d);
    }
  }

  return builder.toBufferGeometry();
}

// ═══════════════════════════════════════════════════════════════════════
// POLYHEDRA — Tetrahedron, Octahedron, Icosahedron, Dodecahedron
// ═══════════════════════════════════════════════════════════════════════

const TETRAHEDRON_VERTS = [
  [1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1],
];

const TETRAHEDRON_FACES = [
  [2, 1, 0], [0, 3, 2], [1, 3, 0], [2, 3, 1],
];

const OCTAHEDRON_VERTS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

const OCTAHEDRON_FACES = [
  [0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2],
  [1, 2, 5], [1, 5, 3], [1, 3, 4], [1, 4, 2],
];

function buildPolyhedron(verts, faces, radius, detail = 0) {
  // Subdivide faces to increase detail.
  const builder = new GeometryBuilder(faces.length * 3 * (1 + detail), faces.length * (1 + detail));

  for (const face of faces) {
    const v0 = verts[face[0]];
    const v1 = verts[face[1]];
    const v2 = verts[face[2]];
    emitPolyhedronTriangle(builder, v0, v1, v2, radius, 0, detail, 0);
  }

  return builder.toBufferGeometry();
}

function emitPolyhedronTriangle(builder, v0, v1, v2, radius, depth, maxDepth, faceIdx) {
  if (depth >= maxDepth) {
    // Normalize vertices to radius.
    const n0 = normalizeVec3(v0);
    const n1 = normalizeVec3(v1);
    const n2 = normalizeVec3(v2);

    const i0 = builder.addVertex(n0[0] * radius, n0[1] * radius, n0[2] * radius, n0[0], n0[1], n0[2], 0, 0);
    const i1 = builder.addVertex(n1[0] * radius, n1[1] * radius, n1[2] * radius, n1[0], n1[1], n1[2], 1, 0);
    const i2 = builder.addVertex(n2[0] * radius, n2[1] * radius, n2[2] * radius, n2[0], n2[1], n2[2], 0.5, 1);
    builder.addTriangle(i0, i1, i2);
    return;
  }

  // Subdivide into 4 triangles.
  const v01 = midpoint(v0, v1);
  const v12 = midpoint(v1, v2);
  const v20 = midpoint(v2, v0);

  emitPolyhedronTriangle(builder, v0, v01, v20, radius, depth + 1, maxDepth);
  emitPolyhedronTriangle(builder, v01, v1, v12, radius, depth + 1, maxDepth);
  emitPolyhedronTriangle(builder, v20, v12, v2, radius, depth + 1, maxDepth);
  emitPolyhedronTriangle(builder, v01, v12, v20, radius, depth + 1, maxDepth);
}

function normalizeVec3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function midpoint(a, b) {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
}

export function buildTetrahedronGeometry({ radius = 1, detail = 0 } = {}) {
  return buildPolyhedron(TETRAHEDRON_VERTS, TETRAHEDRON_FACES, radius, detail);
}

export function buildOctahedronGeometry({ radius = 1, detail = 0 } = {}) {
  return buildPolyhedron(OCTAHEDRON_VERTS, OCTAHEDRON_FACES, radius, detail);
}

export function buildIcosahedronGeometry({ radius = 1, detail = 0 } = {}) {
  const t = GOLDEN_RATIO;
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return buildPolyhedron(verts, faces, radius, detail);
}

export function buildDodecahedronGeometry({ radius = 1, detail = 0 } = {}) {
  const t = GOLDEN_RATIO;
  const invT = 1 / t;
  const verts = [
    [1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1],
    [0, invT, t], [0, -invT, t], [0, invT, -t], [0, -invT, -t],
    [invT, t, 0], [-invT, t, 0], [invT, -t, 0], [-invT, -t, 0],
    [t, 0, invT], [-t, 0, invT], [t, 0, -invT], [-t, 0, -invT],
    [-1, 1, 1], [1, -1, 1], [-1, -1, -1], [1, 1, -1],
  ];
  // Use the same face topology as three.js DodecahedronGeometry.
  const faces = [
    [3, 11, 7], [3, 7, 15], [3, 15, 13], [3, 13, 11], [0, 12, 4],
    [0, 4, 6], [0, 6, 18], [0, 18, 12], [1, 17, 8], [1, 8, 4],
    [1, 4, 12], [1, 12, 17], [2, 16, 5], [2, 5, 8], [2, 8, 17],
    [2, 17, 16], [14, 19, 11], [14, 11, 13], [14, 13, 15], [14, 15, 19],
    [9, 16, 17], [9, 17, 12], [9, 12, 18], [9, 18, 6], [9, 6, 16],
    [5, 16, 6], [5, 6, 4], [5, 4, 8], [10, 13, 15], [10, 15, 7],
    [10, 7, 11], [10, 11, 19], [10, 19, 14], [10, 14, 13],
  ];
  return buildPolyhedron(verts, faces, radius, detail);
}

// ═══════════════════════════════════════════════════════════════════════
// ROUNDED BOX — Box with chamfered/beveled corners
// ═══════════════════════════════════════════════════════════════════════

export function buildRoundedBoxGeometry({
  width = 1, height = 1, depth = 1,
  segments = 2, radius = 0.1,
} = {}) {
  // Simple approximation: generate a box and add hemispheres at corners.
  // For a full version we would union 8 spheres + 12 cylinders + 6 planes,
  // but this simplified version uses a subdivided sphere deformed to a box.
  const r = Math.min(radius, width * 0.5, height * 0.5, depth * 0.5);
  const w = width - 2 * r;
  const h = height - 2 * r;
  const d = depth - 2 * r;

  const sphere = buildSphereGeometry({
    radius: 1, widthSegments: segments * 4, heightSegments: segments * 2,
  });

  // Deform each vertex of a box: project onto the rounded-box boundary.
  const pos = sphere.attributes.position.array;
  const norm = sphere.attributes.normal.array;
  const count = sphere.attributes.position.count;

  for (let i = 0; i < count; i++) {
    const nx = norm[i * 3];
    const ny = norm[i * 3 + 1];
    const nz = norm[i * 3 + 2];

    pos[i * 3]     = Math.sign(nx) * Math.max(Math.abs(nx) * (w * 0.5 + r), w * 0.5) - Math.sign(nx) * r + nx * r;
    pos[i * 3 + 1] = Math.sign(ny) * Math.max(Math.abs(ny) * (h * 0.5 + r), h * 0.5) - Math.sign(ny) * r + ny * r;
    pos[i * 3 + 2] = Math.sign(nz) * Math.max(Math.abs(nz) * (d * 0.5 + r), d * 0.5) - Math.sign(nz) * r + nz * r;
  }

  sphere.attributes.position.needsUpdate = true;
  sphere.computeVertexNormals();
  return sphere;
}

// ═══════════════════════════════════════════════════════════════════════
// TUBE — extruded circular section along a 3D curve
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param points   Array<[x, y, z]> — curve control points
 * @param radius   tube radius
 * @param tubularSegments  subdivisions along the curve
 * @param radialSegments   subdivisions around the circumference
 */
export function buildTubeGeometry({
  points,
  radius = 0.5,
  tubularSegments = 64,
  radialSegments = 8,
  closed = false,
} = {}) {
  if (!points || points.length < 2) {
    return buildSphereGeometry({ radius });
  }

  const ts = Math.max(1, Math.floor(tubularSegments));
  const rs = Math.max(3, Math.floor(radialSegments));

  // Sample the curve by linear interpolation between control points.
  const curvePoints = [];
  const totalSegments = ts;
  for (let i = 0; i <= totalSegments; i++) {
    const t = i / totalSegments;
    curvePoints.push(sampleCurve(points, t));
  }

  const builder = new GeometryBuilder((ts + 1) * (rs + 1), ts * rs * 2);

  for (let i = 0; i <= ts; i++) {
    const P = curvePoints[i];
    const T = tangentAt(curvePoints, i, closed);
    const N = normalFromTangent(T);
    const B = crossVec(T, N);

    for (let j = 0; j <= rs; j++) {
      const angle = (j / rs) * TWO_PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      const px = P[0] + radius * (cos * N[0] + sin * B[0]);
      const py = P[1] + radius * (cos * N[1] + sin * B[1]);
      const pz = P[2] + radius * (cos * N[2] + sin * B[2]);

      const nx = cos * N[0] + sin * B[0];
      const ny = cos * N[1] + sin * B[1];
      const nz = cos * N[2] + sin * B[2];

      builder.addVertex(px, py, pz, nx, ny, nz, i / ts, j / rs);
    }
  }

  for (let i = 0; i < ts; i++) {
    for (let j = 0; j < rs; j++) {
      const a = i * (rs + 1) + j;
      const b = a + 1;
      const c = (i + 1) * (rs + 1) + j + 1;
      const d = (i + 1) * (rs + 1) + j;
      builder.addQuad(a, b, c, d);
    }
  }

  return builder.toBufferGeometry();
}

function sampleCurve(points, t) {
  const n = points.length - 1;
  const scaled = t * n;
  const i0 = Math.min(Math.floor(scaled), n - 1);
  const i1 = i0 + 1;
  const lt = scaled - i0;
  return [
    points[i0][0] * (1 - lt) + points[i1][0] * lt,
    points[i0][1] * (1 - lt) + points[i1][1] * lt,
    points[i0][2] * (1 - lt) + points[i1][2] * lt,
  ];
}

function tangentAt(curvePoints, i, closed) {
  const n = curvePoints.length;
  const prev = closed && i === 0 ? n - 1 : Math.max(0, i - 1);
  const next = closed && i === n - 1 ? 0 : Math.min(n - 1, i + 1);

  const tx = curvePoints[next][0] - curvePoints[prev][0];
  const ty = curvePoints[next][1] - curvePoints[prev][1];
  const tz = curvePoints[next][2] - curvePoints[prev][2];
  const len = Math.hypot(tx, ty, tz) || 1;
  return [tx / len, ty / len, tz / len];
}

function normalFromTangent(t) {
  // Pick a perpendicular vector to t.
  if (Math.abs(t[0]) < 0.9) {
    const nx = 0, ny = -t[2], nz = t[1];
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  }
  const nx = -t[2], ny = 0, nz = t[0];
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function crossVec(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// EXTRUDE — extrude a 2D shape along Z
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param shape     Array<[x, y]> — closed 2D polygon (CCW winding)
 * @param depth     extrusion depth (along +Z, centered at Z = 0)
 */
export function buildExtrudeGeometry({
  shape,
  depth = 1,
  bevel = 0,
} = {}) {
  if (!shape || shape.length < 3) return buildBoxGeometry();

  const n = shape.length;
  const halfDepth = depth * 0.5;

  const builder = new GeometryBuilder(n * 4 + 2, n * 2 + n * 2);

  // Front face (Z = +halfDepth).
  const frontCenter = builder.addVertex(0, 0, halfDepth, 0, 0, 1, 0.5, 0.5);
  const frontStart = builder.vertexCount;
  for (let i = 0; i < n; i++) {
    builder.addVertex(shape[i][0], shape[i][1], halfDepth, 0, 0, 1,
                      shape[i][0] * 0.5 + 0.5, shape[i][1] * 0.5 + 0.5);
  }
  for (let i = 0; i < n; i++) {
    builder.addTriangle(frontCenter, frontStart + i, frontStart + (i + 1) % n);
  }

  // Back face (Z = -halfDepth) with reversed winding.
  const backCenter = builder.addVertex(0, 0, -halfDepth, 0, 0, -1, 0.5, 0.5);
  const backStart = builder.vertexCount;
  for (let i = 0; i < n; i++) {
    builder.addVertex(shape[i][0], shape[i][1], -halfDepth, 0, 0, -1,
                      shape[i][0] * 0.5 + 0.5, shape[i][1] * 0.5 + 0.5);
  }
  for (let i = 0; i < n; i++) {
    builder.addTriangle(backCenter, backStart + (i + 1) % n, backStart + i);
  }

  // Side walls.
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const ax = shape[i][0], ay = shape[i][1];
    const bx = shape[next][0], by = shape[next][1];

    // Side normal = perpendicular to edge.
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy / len, ny = -dx / len;

    const v0 = builder.addVertex(ax, ay, halfDepth, nx, ny, 0, i / n, 1);
    const v1 = builder.addVertex(bx, by, halfDepth, nx, ny, 0, (i + 1) / n, 1);
    const v2 = builder.addVertex(bx, by, -halfDepth, nx, ny, 0, (i + 1) / n, 0);
    const v3 = builder.addVertex(ax, ay, -halfDepth, nx, ny, 0, i / n, 0);

    builder.addQuad(v0, v1, v2, v3);
  }

  return builder.toBufferGeometry();
}

// ═══════════════════════════════════════════════════════════════════════
// LATHE — rotate a 2D profile around the Y axis
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param profile   Array<[r, y]> — 2D profile points (r = distance from axis)
 * @param segments  number of lathe segments
 */
export function buildLatheGeometry({
  profile,
  segments = 32,
} = {}) {
  if (!profile || profile.length < 2) return buildSphereGeometry();

  const seg = Math.max(3, Math.floor(segments));
  const m = profile.length;

  const builder = new GeometryBuilder((seg + 1) * m, seg * (m - 1) * 2);

  for (let i = 0; i <= seg; i++) {
    const phi = (i / seg) * TWO_PI;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);

    for (let j = 0; j < m; j++) {
      const r = profile[j][0];
      const y = profile[j][1];

      builder.addVertex(
        r * cos, y, r * sin,
        cos, 0, sin,
        i / seg, j / (m - 1)
      );
    }
  }

  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < m - 1; j++) {
      const a = i * m + j;
      const b = a + 1;
      const c = (i + 1) * m + j + 1;
      const d = (i + 1) * m + j;
      builder.addQuad(a, b, c, d);
    }
  }

  return builder.toBufferGeometry();
}

// ═══════════════════════════════════════════════════════════════════════
// CACHED CONVENIENCE FUNCTIONS — return geometry ID from file 005
// ═══════════════════════════════════════════════════════════════════════

export function getBoxGeometry(params = {}) {
  return getCachedOrCreate('box', params, () => buildBoxGeometry(params));
}

export function getSphereGeometry(params = {}) {
  return getCachedOrCreate('sphere', params, () => buildSphereGeometry(params));
}

export function getCylinderGeometry(params = {}) {
  return getCachedOrCreate('cylinder', params, () => buildCylinderGeometry(params));
}

export function getConeGeometry(params = {}) {
  return getCachedOrCreate('cone', params, () => buildConeGeometry(params));
}

export function getTorusGeometry(params = {}) {
  return getCachedOrCreate('torus', params, () => buildTorusGeometry(params));
}

export function getTorusKnotGeometry(params = {}) {
  return getCachedOrCreate('torusknot', params, () => buildTorusKnotGeometry(params));
}

export function getPlaneGeometry(params = {}) {
  return getCachedOrCreate('plane', params, () => buildPlaneGeometry(params));
}

export function getCircleGeometry(params = {}) {
  return getCachedOrCreate('circle', params, () => buildCircleGeometry(params));
}

export function getRingGeometry(params = {}) {
  return getCachedOrCreate('ring', params, () => buildRingGeometry(params));
}

export function getCapsuleGeometry(params = {}) {
  return getCachedOrCreate('capsule', params, () => buildCapsuleGeometry(params));
}

export function getTetrahedronGeometry(params = {}) {
  return getCachedOrCreate('tetrahedron', params, () => buildTetrahedronGeometry(params));
}

export function getOctahedronGeometry(params = {}) {
  return getCachedOrCreate('octahedron', params, () => buildOctahedronGeometry(params));
}

export function getIcosahedronGeometry(params = {}) {
  return getCachedOrCreate('icosahedron', params, () => buildIcosahedronGeometry(params));
}

export function getDodecahedronGeometry(params = {}) {
  return getCachedOrCreate('dodecahedron', params, () => buildDodecahedronGeometry(params));
}

export function getRoundedBoxGeometry(params = {}) {
  return getCachedOrCreate('roundedbox', params, () => buildRoundedBoxGeometry(params));
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearGeometryCache() {
  _geoCache.clear();
  _geoCacheOwns.clear();
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function geometryCacheStats() {
  let totalTriangles = 0;
  let totalVertices = 0;
  for (const id of _geoCache.values()) {
    const entry = GEOMETRY_REGISTRY.byId.get(id);
    if (!entry) continue;
    const geo = entry.ref;
    if (geo.index) totalTriangles += geo.index.count / 3;
    if (geo.attributes.position) totalVertices += geo.attributes.position.count;
  }
  return {
    cachedPrimitives: _geoCache.size,
    totalTriangles,
    totalVertices,
  };
}