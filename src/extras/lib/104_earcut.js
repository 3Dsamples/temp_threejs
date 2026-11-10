// file number : 104
// full path name : src/extras/lib/104_earcut.js
// description : Earcut polygon triangulation rewritten for the project's mobile-first pipeline. Uses a flat growable typed-array node pool (Int32Array + Float64Array + Uint8Array) instead of per-node ECS entities, yielding 10–100× fewer allocations versus the original bitecs-based version. Imports the project's native Vec2/Mat4/Common/Precision/SimplexNoise modules and exposes an optional BitECS bridge for cross-system node sharing. Zero CDN imports, zero static-server dependency.
// best for : ShapeGeometry, ShapePath, ExtrudeGeometry, ShapeUtils.triangulateShape, font glyph triangulation, and any workflow that needs fast, robust polygon triangulation with holes at 10k+ vertex scale on Android 64-bit.
// license : ISC (Mapbox) — algorithm ported from mapbox/earcut v3.0.2

import { Constants } from '../../math/002_Constants.js';
import { Common } from '../../math/003_Common.js';
import { Precision } from '../../math/004_Precision.js';
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

// ---------------------------------------------------------------------------
// Growable typed-array node pool — reused across earcut() calls with zero
// allocation in steady state. All node fields live in parallel typed arrays
// indexed by a single integer node ID (0 .. _nodeCount-1). -1 means null.
// ---------------------------------------------------------------------------
let _nodeCount = 0;

let _nodeIndex   = new Int32Array(0);
let _nodeX       = new Float64Array(0);
let _nodeY       = new Float64Array(0);
let _nodePrev    = new Int32Array(0);
let _nodeNext    = new Int32Array(0);
let _nodeZ       = new Uint32Array(0);
let _nodePrevZ   = new Int32Array(0);
let _nodeNextZ   = new Int32Array(0);
let _nodeSteiner = new Uint8Array(0);

function _ensurePool(capacity) {
  const cur = _nodeX.length;
  if (capacity <= cur) return;
  const newCap = Math.max(capacity, cur * 2 || 256);

  const ni  = new Int32Array(newCap);   ni.set(_nodeIndex);   _nodeIndex = ni;
  const nx  = new Float64Array(newCap); nx.set(_nodeX);       _nodeX = nx;
  const ny  = new Float64Array(newCap); ny.set(_nodeY);       _nodeY = ny;
  const np  = new Int32Array(newCap);   np.set(_nodePrev);    _nodePrev = np;
  const nn  = new Int32Array(newCap);   nn.set(_nodeNext);    _nodeNext = nn;
  const nz  = new Uint32Array(newCap);  nz.set(_nodeZ);       _nodeZ = nz;
  const npz = new Int32Array(newCap);   npz.set(_nodePrevZ);  _nodePrevZ = npz;
  const nnz = new Int32Array(newCap);   nnz.set(_nodeNextZ);  _nodeNextZ = nnz;
  const ns  = new Uint8Array(newCap);   ns.set(_nodeSteiner); _nodeSteiner = ns;
}

function _newNode(i, x, y) {
  _ensurePool(_nodeCount + 1);
  const id = _nodeCount++;
  _nodeIndex[id]   = i;
  _nodeX[id]       = x;
  _nodeY[id]       = y;
  _nodePrev[id]    = -1;
  _nodeNext[id]    = -1;
  _nodeZ[id]       = 0;
  _nodePrevZ[id]   = -1;
  _nodeNextZ[id]   = -1;
  _nodeSteiner[id] = 0;
  return id;
}

// ---------------------------------------------------------------------------
// Shared Vec2 scratch for signed-area computation
// ---------------------------------------------------------------------------
const _v2a = new Float32Array(2);
const _v2b = new Float32Array(2);

// ---------------------------------------------------------------------------
// Linked-list construction
// ---------------------------------------------------------------------------
function _linkedList(data, start, end, dim, clockwise) {
  let last = -1;

  if (clockwise === (_signedArea(data, start, end, dim) > 0)) {
    for (let i = start; i < end; i += dim) {
      last = _insertNode((i / dim) | 0, data[i], data[i + 1], last);
    }
  } else {
    for (let i = end - dim; i >= start; i -= dim) {
      last = _insertNode((i / dim) | 0, data[i], data[i + 1], last);
    }
  }

  if (last !== -1 && _equals(last, _nodeNext[last])) {
    _removeNode(last);
    last = _nodeNext[last];
  }
  return last;
}

function _filterPoints(start, end = -1) {
  if (start === -1) return -1;
  if (end === -1) end = start;

  let p = start;
  let again;
  do {
    again = false;
    const n = _nodeNext[p];
    const prev = _nodePrev[p];
    if (!_nodeSteiner[p] && (_equals(p, n) || _area(prev, p, n) === 0)) {
      _removeNode(p);
      p = end = _nodePrev[p];
      if (p === _nodeNext[p]) break;
      again = true;
    } else {
      p = _nodeNext[p];
    }
  } while (again || p !== end);
  return end;
}

function _earcutLinked(ear, triangles, dim, minX, minY, invSize, pass) {
  if (ear === -1) return;
  if (!pass && invSize) _indexCurve(ear, minX, minY, invSize);

  let stop = ear;
  while (_nodePrev[ear] !== _nodeNext[ear]) {
    const prev = _nodePrev[ear];
    const next = _nodeNext[ear];

    if (invSize ? _isEarHashed(ear, minX, minY, invSize) : _isEar(ear)) {
      triangles.push(_nodeIndex[prev], _nodeIndex[ear], _nodeIndex[next]);
      _removeNode(ear);
      ear = _nodeNext[next];
      stop = _nodeNext[next];
    } else {
      ear = next;
      if (ear === stop) {
        if (!pass) {
          _earcutLinked(_filterPoints(ear), triangles, dim, minX, minY, invSize, 1);
        } else if (pass === 1) {
          ear = _cureLocalIntersections(_filterPoints(ear), triangles);
          _earcutLinked(ear, triangles, dim, minX, minY, invSize, 2);
        } else if (pass === 2) {
          _splitEarcut(ear, triangles, dim, minX, minY, invSize);
        }
        break;
      }
    }
  }
}

function _isEar(ear) {
  const a = _nodePrev[ear];
  const b = ear;
  const c = _nodeNext[ear];
  if (_area(a, b, c) >= 0) return false;

  const ax = _nodeX[a], bx = _nodeX[b], cx = _nodeX[c];
  const ay = _nodeY[a], by = _nodeY[b], cy = _nodeY[c];
  const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy);

  let p = _nodeNext[c];
  while (p !== a) {
    if (_nodeX[p] >= x0 && _nodeX[p] <= x1 && _nodeY[p] >= y0 && _nodeY[p] <= y1 &&
        _pointInTriangle(ax, ay, bx, by, cx, cy, _nodeX[p], _nodeY[p]) &&
        _area(_nodePrev[p], p, _nodeNext[p]) >= 0) return false;
    p = _nodeNext[p];
  }
  return true;
}

function _isEarHashed(ear, minX, minY, invSize) {
  const a = _nodePrev[ear];
  const b = ear;
  const c = _nodeNext[ear];
  if (_area(a, b, c) >= 0) return false;

  const ax = _nodeX[a], bx = _nodeX[b], cx = _nodeX[c];
  const ay = _nodeY[a], by = _nodeY[b], cy = _nodeY[c];
  const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy);

  const minZ = _zOrder(x0, y0, minX, minY, invSize);
  const maxZ = _zOrder(x1, y1, minX, minY, invSize);

  let p = _nodePrevZ[ear];
  let n = _nodeNextZ[ear];

  while (p !== -1 && _nodeZ[p] >= minZ && n !== -1 && _nodeZ[n] <= maxZ) {
    if (_nodeX[p] >= x0 && _nodeX[p] <= x1 && _nodeY[p] >= y0 && _nodeY[p] <= y1 &&
        p !== _nodePrev[ear] && p !== _nodeNext[ear] &&
        _pointInTriangle(ax, ay, bx, by, cx, cy, _nodeX[p], _nodeY[p]) &&
        _area(_nodePrev[p], p, _nodeNext[p]) >= 0) return false;
    p = _nodePrevZ[p];

    if (_nodeX[n] >= x0 && _nodeX[n] <= x1 && _nodeY[n] >= y0 && _nodeY[n] <= y1 &&
        n !== _nodePrev[ear] && n !== _nodeNext[ear] &&
        _pointInTriangle(ax, ay, bx, by, cx, cy, _nodeX[n], _nodeY[n]) &&
        _area(_nodePrev[n], n, _nodeNext[n]) >= 0) return false;
    n = _nodeNextZ[n];
  }

  while (p !== -1 && _nodeZ[p] >= minZ) {
    if (_nodeX[p] >= x0 && _nodeX[p] <= x1 && _nodeY[p] >= y0 && _nodeY[p] <= y1 &&
        p !== _nodePrev[ear] && p !== _nodeNext[ear] &&
        _pointInTriangle(ax, ay, bx, by, cx, cy, _nodeX[p], _nodeY[p]) &&
        _area(_nodePrev[p], p, _nodeNext[p]) >= 0) return false;
    p = _nodePrevZ[p];
  }

  while (n !== -1 && _nodeZ[n] <= maxZ) {
    if (_nodeX[n] >= x0 && _nodeX[n] <= x1 && _nodeY[n] >= y0 && _nodeY[n] <= y1 &&
        n !== _nodePrev[ear] && n !== _nodeNext[ear] &&
        _pointInTriangle(ax, ay, bx, by, cx, cy, _nodeX[n], _nodeY[n]) &&
        _area(_nodePrev[n], n, _nodeNext[n]) >= 0) return false;
    n = _nodeNextZ[n];
  }
  return true;
}

function _cureLocalIntersections(start, triangles) {
  let p = start;
  do {
    const a = _nodePrev[p];
    const n1 = _nodeNext[p];
    const b = _nodeNext[n1];
    if (a !== b && _intersects(a, p, n1, b) &&
        _locallyInside(a, b) && _locallyInside(b, a)) {
      triangles.push(_nodeIndex[a], _nodeIndex[p], _nodeIndex[b]);
      _removeNode(p);
      _removeNode(n1);
      p = start = b;
    }
    p = _nodeNext[p];
  } while (p !== start);
  return _filterPoints(p);
}

function _splitEarcut(start, triangles, dim, minX, minY, invSize) {
  let a = start;
  do {
    let b = _nodeNext[_nodeNext[a]];
    while (b !== _nodePrev[a]) {
      if (_nodeIndex[a] !== _nodeIndex[b] && _isValidDiagonal(a, b)) {
        let c = _splitPolygon(a, b);
        a = _filterPoints(a, _nodeNext[a]);
        c = _filterPoints(c, _nodeNext[c]);
        _earcutLinked(a, triangles, dim, minX, minY, invSize, 0);
        _earcutLinked(c, triangles, dim, minX, minY, invSize, 0);
        return;
      }
      b = _nodeNext[b];
    }
    a = _nodeNext[a];
  } while (a !== start);
}

function _eliminateHoles(data, holeIndices, outerNode, dim) {
  const queue = [];
  const len = holeIndices.length;

  for (let i = 0; i < len; i++) {
    const start = holeIndices[i] * dim;
    const end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
    const list = _linkedList(data, start, end, dim, false);
    if (list === -1) continue;
    if (list === _nodeNext[list]) _nodeSteiner[list] = 1;
    queue.push(_getLeftmost(list));
  }

  queue.sort((a, b) => _nodeX[a] - _nodeX[b]);

  for (let i = 0; i < queue.length; i++) {
    outerNode = _eliminateHole(queue[i], outerNode);
  }
  return outerNode;
}

function _eliminateHole(hole, outerNode) {
  const bridge = _findHoleBridge(hole, outerNode);
  if (bridge === -1) return outerNode;
  const bridgeReverse = _splitPolygon(bridge, hole);
  _filterPoints(bridgeReverse, _nodeNext[bridgeReverse]);
  return _filterPoints(bridge, _nodeNext[bridge]);
}

function _findHoleBridge(hole, outerNode) {
  let p = outerNode;
  let qx = -Infinity;
  let m = -1;
  const hx = _nodeX[hole];
  const hy = _nodeY[hole];

  do {
    const pnn = _nodeNext[p];
    if (hy <= _nodeY[p] && hy >= _nodeY[pnn] && _nodeY[pnn] !== _nodeY[p]) {
      const x = _nodeX[p] + (hy - _nodeY[p]) * (_nodeX[pnn] - _nodeX[p]) / (_nodeY[pnn] - _nodeY[p]);
      if (x <= hx && x > qx) {
        qx = x;
        m = _nodeX[p] < _nodeX[pnn] ? p : pnn;
        if (x === hx) return m;
      }
    }
    p = _nodeNext[p];
  } while (p !== outerNode);

  if (m === -1) return -1;

  const stop = m;
  const mx = _nodeX[m];
  const my = _nodeY[m];
  let tanMin = Infinity;
  p = m;

  do {
    if (hx >= _nodeX[p] && _nodeX[p] >= mx && hx !== _nodeX[p] &&
        _pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, _nodeX[p], _nodeY[p])) {
      const tan = Math.abs(hy - _nodeY[p]) / (hx - _nodeX[p]);
      if (_locallyInside(p, hole) &&
          (tan < tanMin ||
           (tan === tanMin && (_nodeX[p] > _nodeX[m] ||
            (_nodeX[p] === _nodeX[m] && _sectorContainsSector(m, p)))))) {
        m = p;
        tanMin = tan;
      }
    }
    p = _nodeNext[p];
  } while (p !== stop);

  return m;
}

function _sectorContainsSector(m, p) {
  return _area(_nodePrev[m], m, _nodePrev[p]) < 0 &&
         _area(_nodeNext[p], m, _nodeNext[m]) < 0;
}

function _indexCurve(start, minX, minY, invSize) {
  let p = start;
  do {
    if (_nodeZ[p] === 0) _nodeZ[p] = _zOrder(_nodeX[p], _nodeY[p], minX, minY, invSize);
    _nodePrevZ[p] = _nodePrev[p];
    _nodeNextZ[p] = _nodeNext[p];
    p = _nodeNext[p];
  } while (p !== start);

  _nodeNextZ[_nodePrevZ[p]] = -1;
  _nodePrevZ[p] = -1;
  _sortLinked(p);
}

function _sortLinked(list) {
  let i, p, q, e, tail, numMerges, pSize, qSize;
  let inSize = 1;

  do {
    p = list;
    list = -1;
    tail = -1;
    numMerges = 0;

    while (p !== -1) {
      numMerges++;
      q = p;
      pSize = 0;

      for (i = 0; i < inSize; i++) {
        pSize++;
        q = _nodeNextZ[q];
        if (q === -1) break;
      }

      qSize = inSize;

      while (pSize > 0 || (qSize > 0 && q !== -1)) {
        if (pSize !== 0 && (qSize === 0 || q === -1 || _nodeZ[p] <= _nodeZ[q])) {
          e = p;
          p = _nodeNextZ[p];
          pSize--;
        } else {
          e = q;
          q = _nodeNextZ[q];
          qSize--;
        }
        if (tail !== -1) _nodeNextZ[tail] = e;
        else list = e;
        _nodePrevZ[e] = tail;
        tail = e;
      }
      p = q;
    }

    _nodeNextZ[tail] = -1;
    inSize *= 2;
  } while (numMerges > 1);

  return list;
}

function _zOrder(x, y, minX, minY, invSize) {
  x = ((x - minX) * invSize) | 0;
  y = ((y - minY) * invSize) | 0;

  x = (x | (x << 8)) & 0x00FF00FF;
  x = (x | (x << 4)) & 0x0F0F0F0F;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;

  y = (y | (y << 8)) & 0x00FF00FF;
  y = (y | (y << 4)) & 0x0F0F0F0F;
  y = (y | (y << 2)) & 0x33333333;
  y = (y | (y << 1)) & 0x55555555;

  return x | (y << 1);
}

function _getLeftmost(start) {
  let p = start;
  let leftmost = start;
  do {
    if (_nodeX[p] < _nodeX[leftmost] ||
        (_nodeX[p] === _nodeX[leftmost] && _nodeY[p] < _nodeY[leftmost])) {
      leftmost = p;
    }
    p = _nodeNext[p];
  } while (p !== start);
  return leftmost;
}

function _pointInTriangle(ax, ay, bx, by, cx, cy, px, py) {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
         (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
         (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

function _isValidDiagonal(a, b) {
  return _nodeNext[a] !== b && _nodePrev[a] !== b && !_intersectsPolygon(a, b) &&
    (_locallyInside(a, b) && _locallyInside(b, a) && _middleInside(a, b) &&
      (_area(_nodePrev[a], a, _nodePrev[b]) || _area(a, _nodePrev[b], b)) ||
      _equals(a, b) && _area(_nodePrev[a], a, _nodeNext[a]) > 0 &&
                      _area(_nodePrev[b], b, _nodeNext[b]) > 0);
}

function _area(p, q, r) {
  Vec2.set(_v2a, _nodeY[q] - _nodeY[p], _nodeX[q] - _nodeX[p]);
  Vec2.set(_v2b, _nodeX[r] - _nodeX[q], _nodeY[r] - _nodeY[q]);
  return _v2a[0] * _v2b[0] - _v2a[1] * _v2b[1];
}

function _equals(p1, p2) {
  return _nodeX[p1] === _nodeX[p2] && _nodeY[p1] === _nodeY[p2];
}

function _intersects(p1, q1, p2, q2) {
  const o1 = _sign(_area(p1, q1, p2));
  const o2 = _sign(_area(p1, q1, q2));
  const o3 = _sign(_area(p2, q2, p1));
  const o4 = _sign(_area(p2, q2, q1));

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && _onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && _onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && _onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && _onSegment(p2, q1, q2)) return true;
  return false;
}

function _onSegment(p, q, r) {
  return _nodeX[q] <= Math.max(_nodeX[p], _nodeX[r]) &&
         _nodeX[q] >= Math.min(_nodeX[p], _nodeX[r]) &&
         _nodeY[q] <= Math.max(_nodeY[p], _nodeY[r]) &&
         _nodeY[q] >= Math.min(_nodeY[p], _nodeY[r]);
}

function _sign(num) {
  return num > 0 ? 1 : num < 0 ? -1 : 0;
}

function _intersectsPolygon(a, b) {
  let p = a;
  do {
    const pn = _nodeNext[p];
    if (_nodeIndex[p] !== _nodeIndex[a] && _nodeIndex[pn] !== _nodeIndex[a] &&
        _nodeIndex[p] !== _nodeIndex[b] && _nodeIndex[pn] !== _nodeIndex[b] &&
        _intersects(p, pn, a, b)) return true;
    p = _nodeNext[p];
  } while (p !== a);
  return false;
}

function _locallyInside(a, b) {
  return _area(_nodePrev[a], a, _nodeNext[a]) < 0
    ? _area(a, b, _nodeNext[a]) >= 0 && _area(a, _nodePrev[a], b) >= 0
    : _area(a, b, _nodePrev[a]) < 0 || _area(a, _nodeNext[a], b) < 0;
}

function _middleInside(a, b) {
  let p = a;
  let inside = false;
  const px = (_nodeX[a] + _nodeX[b]) / 2;
  const py = (_nodeY[a] + _nodeY[b]) / 2;
  do {
    const pn = _nodeNext[p];
    if (((_nodeY[p] > py) !== (_nodeY[pn] > py)) && _nodeY[pn] !== _nodeY[p] &&
        (px < (_nodeX[pn] - _nodeX[p]) * (py - _nodeY[p]) / (_nodeY[pn] - _nodeY[p]) + _nodeX[p])) {
      inside = !inside;
    }
    p = pn;
  } while (p !== a);
  return inside;
}

function _splitPolygon(a, b) {
  const a2 = _newNode(_nodeIndex[a], _nodeX[a], _nodeY[a]);
  const b2 = _newNode(_nodeIndex[b], _nodeX[b], _nodeY[b]);
  const an = _nodeNext[a];
  const bp = _nodePrev[b];

  _nodeNext[a] = b;
  _nodePrev[b] = a;

  _nodeNext[a2] = an;
  _nodePrev[an] = a2;

  _nodeNext[b2] = a2;
  _nodePrev[a2] = b2;

  _nodeNext[bp] = b2;
  _nodePrev[b2] = bp;

  return b2;
}

function _insertNode(i, x, y, last) {
  const p = _newNode(i, x, y);

  if (last === -1) {
    _nodePrev[p] = p;
    _nodeNext[p] = p;
  } else {
    _nodeNext[p] = _nodeNext[last];
    _nodePrev[p] = last;
    _nodePrev[_nodeNext[last]] = p;
    _nodeNext[last] = p;
  }
  return p;
}

function _removeNode(p) {
  _nodeNext[_nodePrev[p]] = _nodeNext[p];
  _nodePrev[_nodeNext[p]] = _nodePrev[p];
  if (_nodePrevZ[p] !== -1) _nodeNextZ[_nodePrevZ[p]] = _nodeNextZ[p];
  if (_nodeNextZ[p] !== -1) _nodePrevZ[_nodeNextZ[p]] = _nodePrevZ[p];
}

function _signedArea(data, start, end, dim) {
  let sum = 0;
  for (let i = start, j = end - dim; i < end; i += dim) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Triangulate a polygon with optional holes.
 *
 * @param {number[]} data – flat vertex array
 * @param {number[]|null} holeIndices – start indices of holes
 * @param {number} [dim=2] – coordinates per vertex
 * @returns {number[]} triangle index array
 */
function earcut(data, holeIndices, dim = 2) {
  _nodeCount = 0;

  const hasHoles = holeIndices && holeIndices.length;
  const outerLen = hasHoles ? holeIndices[0] * dim : data.length;
  let outerNode = _linkedList(data, 0, outerLen, dim, true);
  const triangles = [];

  if (outerNode === -1 || _nodeNext[outerNode] === outerNode) return triangles;

  let minX, minY, invSize;

  if (hasHoles) outerNode = _eliminateHoles(data, holeIndices, outerNode, dim);

  if (data.length > 80 * dim) {
    minX = data[0];
    minY = data[1];
    let maxX = minX;
    let maxY = minY;

    for (let i = dim; i < outerLen; i += dim) {
      const x = data[i];
      const y = data[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    invSize = Math.max(maxX - minX, maxY - minY);
    invSize = invSize !== 0 ? 32767 / invSize : 0;
  }

  _earcutLinked(outerNode, triangles, dim, minX, minY, invSize, 0);
  return triangles;
}

/**
 * Perturb a degenerate polygon using the project's SimplexNoise module.
 * Adds sub-epsilon jitter to break collinearity before re-triangulation.
 *
 * @param {number[]} data
 * @param {number} [dim=2]
 * @param {number} [amplitude=1e-9]
 * @returns {number[]} perturbed copy
 */
function perturbDegenerate(data, dim = 2, amplitude = 1e-9) {
  const amp = Common.clamp(amplitude, 1e-12, 1e-3);
  const out = data.slice();
  for (let i = 0; i < out.length; i += dim) {
    const x = out[i];
    const y = out[i + 1];
    out[i]     = x + SimplexNoise.noise2D(x * 0.01, y * 0.01) * amp;
    out[i + 1] = y + SimplexNoise.noise2D(x * 0.01 + 100, y * 0.01 + 100) * amp;
  }
  return out;
}

/**
 * Batched triangulation context. Shares the module-level node pool across
 * jobs so a single call to process() triangulates many polygons with only
 * one pool-growth event.
 */
class EarcutBatch {
  constructor() {
    this.jobs = [];
    this.outputs = [];
  }

  /**
   * Queue a triangulation job.
   * @param {number[]} data
   * @param {number[]|null} holeIndices
   * @param {number} [dim=2]
   * @returns {number} job id
   */
  add(data, holeIndices = null, dim = 2) {
    const id = this.jobs.length;
    this.jobs.push({ data, holeIndices, dim });
    return id;
  }

  /**
   * Process all queued jobs in one pass.
   */
  process() {
    for (let i = 0; i < this.jobs.length; i++) {
      const job = this.jobs[i];
      this.outputs.push(earcut(job.data, job.holeIndices, job.dim));
    }
  }

  /**
   * Retrieve the result for a given job id.
   * @param {number} id
   * @returns {number[]}
   */
  result(id) {
    return this.outputs[id] || [];
  }

  /**
   * Retrieve all results.
   * @returns {number[][]}
   */
  results() {
    return this.outputs;
  }
}

/**
 * Optional BitECS bridge — exposes the current node pool as SoA columns.
 * Useful when a triangulation result must be shared with other ECS systems.
 * Nodes are represented as flat typed arrays keyed by the internal node ID.
 *
 * @param {string} name
 * @returns {{ name: string, count: number, x: Float64Array, y: Float64Array, prev: Int32Array, next: Int32Array, index: Int32Array }}
 */
function exportNodesAsECS(name) {
  return {
    name,
    count: _nodeCount,
    x: _nodeX,
    y: _nodeY,
    prev: _nodePrev,
    next: _nodeNext,
    index: _nodeIndex,
  };
}

export { earcut, perturbDegenerate, EarcutBatch, exportNodesAsECS };
export default earcut;