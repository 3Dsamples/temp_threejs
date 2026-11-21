"use strict";
//File number : 013
// File : src/math/013_simplex-noise.cjs
//Description : Fast simplex noise (2D/3D/4D — every original export preserved byte-for-byte numerically identical) + SOA batch fills for 1M+ points at real time, zero-GC pooling of seeded noise instances, chunked async parallelism that never freezes the Android UI thread, fBm / turbulence / ridged / domain-warped variants, gradient + curl noise for procedural flow fields, and a bitECS-driven noise-field system for procedural world generation (terrain, clouds, volumetric, galaxies). Same coordinate semantics as the original (finite, within ±2³¹) so scenes stay seamless from millimetres to megaparsecs.
//####
//Best for : 3d procedural generation with glMatrix+bitECS — 1M+ instance terrain heightmaps, cloud/fog/nebula density fields, asteroid-belt deformation, star-cluster seeding, galaxy arm patterns (via fBm+turbulence), foliage noise scatter, procedural damage/rust masks, planet surface detail, dust flow (via curl noise), wind and water direction fields (curl = divergence-free), animated noise (4D with time axis) for ocean/plasma/fire, seamless small-to-galactic scale by scaling coordinates independently of Float32 world positions.
//License : MIT (original simplex-noise © 2024 Jonas Wagner, MIT)
// ============================================================================
// 0. IMPORTS
// ============================================================================
var glMatrix = require("./001_common.js");
var vec2 = require("./002_vec2.js");
var vec3 = require("./003_vec3.js");
var vec4 = require("./004_vec4.js");
var bitecs = require("./010_bitECS_core.js");
// ============================================================================
// 1. CONSTANTS (identical to original)
// ============================================================================
var SQRT3 = Math.sqrt(3.0);
var SQRT5 = Math.sqrt(5.0);
var F2 = 0.5 * (SQRT3 - 1.0);
var G2 = (3.0 - SQRT3) / 6.0;
var F3 = 1.0 / 3.0;
var G3 = 1.0 / 6.0;
var F4 = (SQRT5 - 1.0) / 4.0;
var G4 = (5.0 - SQRT5) / 20.0;
var fastFloor = function (x) { return Math.floor(x) | 0; };
var grad2 = new Float64Array([
1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0,
1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1
]);
var grad3 = new Float64Array([
1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1
]);
var grad4 = new Float64Array([
0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1,
0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1,
1, 0, 1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1,
-1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1,
1, 1, 0, 1, 1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1,
-1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1,
1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0,
-1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0
]);
// ============================================================================
// 2. buildPermutationTable (exact copy from original)
// ============================================================================
function buildPermutationTable(random) {
random = random || Math.random;
var tableSize = 512;
var p = new Uint8Array(tableSize);
var i;
for (i = 0; i < tableSize / 2; i++) p[i] = i;
for (i = 0; i < tableSize / 2 - 1; i++) {
var r = i + ~~(random() * (256 - i));
var aux = p[i];
p[i] = p[r];
p[r] = aux;
}
for (i = 256; i < tableSize; i++) p[i] = p[i - 256];
return p;
}
// ============================================================================
// 3. ORIGINAL createNoise2D (byte-identical algorithm)
// ============================================================================
function createNoise2D(random) {
random = random || Math.random;
var perm = buildPermutationTable(random);
var permGrad2x = new Float64Array(perm).map(function (v) { return grad2[(v % 12) * 2]; });
var permGrad2y = new Float64Array(perm).map(function (v) { return grad2[(v % 12) * 2 + 1]; });
return function noise2D(x, y) {
var n0 = 0, n1 = 0, n2 = 0;
var s = (x + y) * F2;
var i = fastFloor(x + s);
var j = fastFloor(y + s);
var t = (i + j) * G2;
var X0 = i - t, Y0 = j - t;
var x0 = x - X0, y0 = y - Y0;
var i1, j1;
if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
var x2 = x0 - 1.0 + 2.0 * G2, y2 = y0 - 1.0 + 2.0 * G2;
var ii = i & 255, jj = j & 255;
var t0 = 0.5 - x0 * x0 - y0 * y0;
if (t0 >= 0) {
var gi0 = ii + perm[jj];
var g0x = permGrad2x[gi0], g0y = permGrad2y[gi0];
t0 *= t0;
n0 = t0 * t0 * (g0x * x0 + g0y * y0);
}
var t1 = 0.5 - x1 * x1 - y1 * y1;
if (t1 >= 0) {
var gi1 = ii + i1 + perm[jj + j1];
var g1x = permGrad2x[gi1], g1y = permGrad2y[gi1];
t1 *= t1;
n1 = t1 * t1 * (g1x * x1 + g1y * y1);
}
var t2 = 0.5 - x2 * x2 - y2 * y2;
if (t2 >= 0) {
var gi2 = ii + 1 + perm[jj + 1];
var g2x = permGrad2x[gi2], g2y = permGrad2y[gi2];
t2 *= t2;
n2 = t2 * t2 * (g2x * x2 + g2y * y2);
}
return 70.0 * (n0 + n1 + n2);
};
}
// ============================================================================
// 4. ORIGINAL createNoise3D (byte-identical algorithm)
// ============================================================================
function createNoise3D(random) {
random = random || Math.random;
var perm = buildPermutationTable(random);
var permGrad3x = new Float64Array(perm).map(function (v) { return grad3[(v % 12) * 3]; });
var permGrad3y = new Float64Array(perm).map(function (v) { return grad3[(v % 12) * 3 + 1]; });
var permGrad3z = new Float64Array(perm).map(function (v) { return grad3[(v % 12) * 3 + 2]; });
return function noise3D(x, y, z) {
var n0, n1, n2, n3;
var s = (x + y + z) * F3;
var i = fastFloor(x + s);
var j = fastFloor(y + s);
var k = fastFloor(z + s);
var t = (i + j + k) * G3;
var X0 = i - t, Y0 = j - t, Z0 = k - t;
var x0 = x - X0, y0 = y - Y0, z0 = z - Z0;
var i1, j1, k1, i2, j2, k2;
if (x0 >= y0) {
if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
} else {
if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
}
var x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
var x2 = x0 - i2 + 2.0 * G3, y2 = y0 - j2 + 2.0 * G3, z2 = z0 - k2 + 2.0 * G3;
var x3 = x0 - 1.0 + 3.0 * G3, y3 = y0 - 1.0 + 3.0 * G3, z3 = z0 - 1.0 + 3.0 * G3;
var ii = i & 255, jj = j & 255, kk = k & 255;
var t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
if (t0 < 0) n0 = 0.0;
else {
var gi0 = ii + perm[jj + perm[kk]];
t0 *= t0;
n0 = t0 * t0 * (permGrad3x[gi0] * x0 + permGrad3y[gi0] * y0 + permGrad3z[gi0] * z0);
}
var t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
if (t1 < 0) n1 = 0.0;
else {
var gi1 = ii + i1 + perm[jj + j1 + perm[kk + k1]];
t1 *= t1;
n1 = t1 * t1 * (permGrad3x[gi1] * x1 + permGrad3y[gi1] * y1 + permGrad3z[gi1] * z1);
}
var t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
if (t2 < 0) n2 = 0.0;
else {
var gi2 = ii + i2 + perm[jj + j2 + perm[kk + k2]];
t2 *= t2;
n2 = t2 * t2 * (permGrad3x[gi2] * x2 + permGrad3y[gi2] * y2 + permGrad3z[gi2] * z2);
}
var t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
if (t3 < 0) n3 = 0.0;
else {
var gi3 = ii + 1 + perm[jj + 1 + perm[kk + 1]];
t3 *= t3;
n3 = t3 * t3 * (permGrad3x[gi3] * x3 + permGrad3y[gi3] * y3 + permGrad3z[gi3] * z3);
}
return 32.0 * (n0 + n1 + n2 + n3);
};
}
// ============================================================================
// 5. ORIGINAL createNoise4D (byte-identical algorithm)
// ============================================================================
function createNoise4D(random) {
random = random || Math.random;
var perm = buildPermutationTable(random);
var permGrad4x = new Float64Array(perm).map(function (v) { return grad4[(v % 32) * 4]; });
var permGrad4y = new Float64Array(perm).map(function (v) { return grad4[(v % 32) * 4 + 1]; });
var permGrad4z = new Float64Array(perm).map(function (v) { return grad4[(v % 32) * 4 + 2]; });
var permGrad4w = new Float64Array(perm).map(function (v) { return grad4[(v % 32) * 4 + 3]; });
return function noise4D(x, y, z, w) {
var n0, n1, n2, n3, n4;
var s = (x + y + z + w) * F4;
var i = fastFloor(x + s);
var j = fastFloor(y + s);
var k = fastFloor(z + s);
var l = fastFloor(w + s);
var t = (i + j + k + l) * G4;
var X0 = i - t, Y0 = j - t, Z0 = k - t, W0 = l - t;
var x0 = x - X0, y0 = y - Y0, z0 = z - Z0, w0 = w - W0;
var rankx = 0, ranky = 0, rankz = 0, rankw = 0;
if (x0 > y0) rankx++; else ranky++;
if (x0 > z0) rankx++; else rankz++;
if (x0 > w0) rankx++; else rankw++;
if (y0 > z0) ranky++; else rankz++;
if (y0 > w0) ranky++; else rankw++;
if (z0 > w0) rankz++; else rankw++;
var i1 = rankx >= 3 ? 1 : 0, j1 = ranky >= 3 ? 1 : 0, k1 = rankz >= 3 ? 1 : 0, l1 = rankw >= 3 ? 1 : 0;
var i2 = rankx >= 2 ? 1 : 0, j2 = ranky >= 2 ? 1 : 0, k2 = rankz >= 2 ? 1 : 0, l2 = rankw >= 2 ? 1 : 0;
var i3 = rankx >= 1 ? 1 : 0, j3 = ranky >= 1 ? 1 : 0, k3 = rankz >= 1 ? 1 : 0, l3 = rankw >= 1 ? 1 : 0;
var x1 = x0 - i1 + G4, y1 = y0 - j1 + G4, z1 = z0 - k1 + G4, w1 = w0 - l1 + G4;
var x2 = x0 - i2 + 2.0 * G4, y2 = y0 - j2 + 2.0 * G4, z2 = z0 - k2 + 2.0 * G4, w2 = w0 - l2 + 2.0 * G4;
var x3 = x0 - i3 + 3.0 * G4, y3 = y0 - j3 + 3.0 * G4, z3 = z0 - k3 + 3.0 * G4, w3 = w0 - l3 + 3.0 * G4;
var x4 = x0 - 1.0 + 4.0 * G4, y4 = y0 - 1.0 + 4.0 * G4, z4 = z0 - 1.0 + 4.0 * G4, w4 = w0 - 1.0 + 4.0 * G4;
var ii = i & 255, jj = j & 255, kk = k & 255, ll = l & 255;
var t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0 - w0 * w0;
if (t0 < 0) n0 = 0.0;
else {
var gi0 = ii + perm[jj + perm[kk + perm[ll]]];
t0 *= t0;
n0 = t0 * t0 * (permGrad4x[gi0] * x0 + permGrad4y[gi0] * y0 + permGrad4z[gi0] * z0 + permGrad4w[gi0] * w0);
}
var t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1 - w1 * w1;
if (t1 < 0) n1 = 0.0;
else {
var gi1 = ii + i1 + perm[jj + j1 + perm[kk + k1 + perm[ll + l1]]];
t1 *= t1;
n1 = t1 * t1 * (permGrad4x[gi1] * x1 + permGrad4y[gi1] * y1 + permGrad4z[gi1] * z1 + permGrad4w[gi1] * w1);
}
var t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2 - w2 * w2;
if (t2 < 0) n2 = 0.0;
else {
var gi2 = ii + i2 + perm[jj + j2 + perm[kk + k2 + perm[ll + l2]]];
t2 *= t2;
n2 = t2 * t2 * (permGrad4x[gi2] * x2 + permGrad4y[gi2] * y2 + permGrad4z[gi2] * z2 + permGrad4w[gi2] * w2);
}
var t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3 - w3 * w3;
if (t3 < 0) n3 = 0.0;
else {
var gi3 = ii + i3 + perm[jj + j3 + perm[kk + k3 + perm[ll + l3]]];
t3 *= t3;
n3 = t3 * t3 * (permGrad4x[gi3] * x3 + permGrad4y[gi3] * y3 + permGrad4z[gi3] * z3 + permGrad4w[gi3] * w3);
}
var t4 = 0.6 - x4 * x4 - y4 * y4 - z4 * z4 - w4 * w4;
if (t4 < 0) n4 = 0.0;
else {
var gi4 = ii + 1 + perm[jj + 1 + perm[kk + 1 + perm[ll + 1]]];
t4 *= t4;
n4 = t4 * t4 * (permGrad4x[gi4] * x4 + permGrad4y[gi4] * y4 + permGrad4z[gi4] * z4 + permGrad4w[gi4] * w4);
}
return 27.0 * (n0 + n1 + n2 + n3 + n4);
};
}
// ============================================================================
// 6. POOL — reusable seeded noise instances
// ============================================================================
function makeNoiseHandle(kind, seed) {
var rng = glMatrix.mulberry32(seed >>> 0 || 1);
var fn = kind === 2 ? createNoise2D(rng)
: kind === 3 ? createNoise3D(rng)
: createNoise4D(rng);
return { kind: kind, seed: seed, fn: fn, inUse: false };
}
function createNoisePool(kind, capacity, seed) {
capacity = capacity || 16;
var counter = 0;
return glMatrix.createPool(
function () {
var s = seed !== undefined ? (seed + counter++) : ((Math.random() * 0xffffffff) >>> 0);
return makeNoiseHandle(kind, s);
},
capacity,
function (h) { h.inUse = false; }
);
}
var _pools = { 2: null, 3: null, 4: null };
function pool2D() { if (!_pools[2]) _pools[2] = createNoisePool(2, 8); return _pools[2]; }
function pool3D() { if (!_pools[3]) _pools[3] = createNoisePool(3, 16); return _pools[3]; }
function pool4D() { if (!_pools[4]) _pools[4] = createNoisePool(4, 8); return _pools[4]; }
function acquireNoise2D(seed) {
if (seed !== undefined) return makeNoiseHandle(2, seed).fn;
var h = pool2D().acquire(); h.inUse = true; return h.fn;
}
function acquireNoise3D(seed) {
if (seed !== undefined) return makeNoiseHandle(3, seed).fn;
var h = pool3D().acquire(); h.inUse = true; return h.fn;
}
function acquireNoise4D(seed) {
if (seed !== undefined) return makeNoiseHandle(4, seed).fn;
var h = pool4D().acquire(); h.inUse = true; return h.fn;
}
// ============================================================================
// 7. SOA FILLS — 1M+ points at real time (sync, tight loops)
// ============================================================================
function soaFillNoise3D(outF32, positions, noiseFn, scale) {
if (scale === undefined) scale = 1;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
for (var i = 0; i < n; i++) {
outF32[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale);
}
return outF32;
}
function soaFillNoise2D(outF32, positions, noiseFn, scale) {
if (scale === undefined) scale = 1;
var n = positions.count;
var px = positions.x, py = positions.y;
for (var i = 0; i < n; i++) {
outF32[i] = noiseFn(px[i] * scale, py[i] * scale);
}
return outF32;
}
function soaFillNoise4D(outF32, positions, noiseFn, scale, time) {
if (scale === undefined) scale = 1;
if (time === undefined) time = 0;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
for (var i = 0; i < n; i++) {
outF32[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale, time);
}
return outF32;
}
// --- Fractional Brownian Motion (multi-octave, normalized to ~[-1,1]) ---
function soaFillFBM3D(outF32, positions, noiseFn, scale, octaves, lacunarity, gain) {
if (scale === undefined) scale = 1;
if (!octaves) octaves = 4;
if (!lacunarity) lacunarity = 2.0;
if (!gain) gain = 0.5;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
for (var i = 0; i < n; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
var sum = 0, amp = 1, freq = 1, norm = 0;
for (var o = 0; o < octaves; o++) {
sum += amp * noiseFn(x * freq, y * freq, z * freq);
norm += amp;
freq *= lacunarity;
amp *= gain;
}
outF32[i] = sum / norm;
}
return outF32;
}
function soaFillFBM2D(outF32, positions, noiseFn, scale, octaves, lacunarity, gain) {
if (scale === undefined) scale = 1;
if (!octaves) octaves = 4;
if (!lacunarity) lacunarity = 2.0;
if (!gain) gain = 0.5;
var n = positions.count;
var px = positions.x, py = positions.y;
for (var i = 0; i < n; i++) {
var x = px[i] * scale, y = py[i] * scale;
var sum = 0, amp = 1, freq = 1, norm = 0;
for (var o = 0; o < octaves; o++) {
sum += amp * noiseFn(x * freq, y * freq);
norm += amp;
freq *= lacunarity;
amp *= gain;
}
outF32[i] = sum / norm;
}
return outF32;
}
function soaFillFBM4D(outF32, positions, noiseFn, scale, time, octaves, lacunarity, gain) {
if (scale === undefined) scale = 1;
if (time === undefined) time = 0;
if (!octaves) octaves = 4;
if (!lacunarity) lacunarity = 2.0;
if (!gain) gain = 0.5;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
for (var i = 0; i < n; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
var sum = 0, amp = 1, freq = 1, norm = 0;
for (var o = 0; o < octaves; o++) {
sum += amp * noiseFn(x * freq, y * freq, z * freq, time * freq);
norm += amp;
freq *= lacunarity;
amp *= gain;
}
outF32[i] = sum / norm;
}
return outF32;
}
// --- Turbulence (billowy clouds) — sum of |noise| * amp, in [0,1] ---
function soaFillTurbulence3D(outF32, positions, noiseFn, scale, octaves, lacunarity, gain) {
if (scale === undefined) scale = 1;
if (!octaves) octaves = 4;
if (!lacunarity) lacunarity = 2.0;
if (!gain) gain = 0.5;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
for (var i = 0; i < n; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
var sum = 0, amp = 1, freq = 1, norm = 0;
for (var o = 0; o < octaves; o++) {
sum += amp * Math.abs(noiseFn(x * freq, y * freq, z * freq));
norm += amp;
freq *= lacunarity;
amp *= gain;
}
outF32[i] = sum / norm;
}
return outF32;
}
// --- Ridged (mountain ridges) — sum of (1-|noise|)² * amp, in [0,1] ---
function soaFillRidged3D(outF32, positions, noiseFn, scale, octaves, lacunarity, gain) {
if (scale === undefined) scale = 1;
if (!octaves) octaves = 4;
if (!lacunarity) lacunarity = 2.0;
if (!gain) gain = 0.5;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
for (var i = 0; i < n; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
var sum = 0, amp = 1, freq = 1, norm = 0;
for (var o = 0; o < octaves; o++) {
var v = 1 - Math.abs(noiseFn(x * freq, y * freq, z * freq));
sum += amp * v * v;
norm += amp;
freq *= lacunarity;
amp *= gain;
}
outF32[i] = sum / norm;
}
return outF32;
}
// --- Domain warping (natural, flowing look) ---
var WARP_OFFSET = 31.416;
function soaFillWarped3D(outF32, positions, noiseFn, scale, warpStrength, octaves) {
if (scale === undefined) scale = 1;
if (warpStrength === undefined) warpStrength = 0.5;
if (!octaves) octaves = 4;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
for (var i = 0; i < n; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
var wx = noiseFn(x * 0.5 + WARP_OFFSET, y * 0.5, z * 0.5);
var wy = noiseFn(x * 0.5, y * 0.5 + WARP_OFFSET * 1.5, z * 0.5);
var wz = noiseFn(x * 0.5, y * 0.5, z * 0.5 + WARP_OFFSET * 2.5);
var sx = x + wx * warpStrength;
var sy = y + wy * warpStrength;
var sz = z + wz * warpStrength;
var sum = 0, amp = 1, freq = 1, norm = 0;
for (var o = 0; o < octaves; o++) {
sum += amp * noiseFn(sx * freq, sy * freq, sz * freq);
norm += amp;
freq *= 2.0;
amp *= 0.5;
}
outF32[i] = sum / norm;
}
return outF32;
}
// --- Curl noise (divergence-free flow field) ---
var CURL_OFF_Y = 31.416;
var CURL_OFF_Z = 47.123;
function soaFillCurl3D(outVec3, positions, noiseFn, scale, epsilon) {
if (scale === undefined) scale = 1;
if (!epsilon) epsilon = 0.001;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
var ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
var inv2e = 1 / (2 * epsilon);
for (var i = 0; i < n; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
var dVy_dz = (noiseFn(x + CURL_OFF_Y, y, z + epsilon) - noiseFn(x + CURL_OFF_Y, y, z - epsilon)) * inv2e;
var dVz_dy = (noiseFn(x, y + epsilon + CURL_OFF_Z, z) - noiseFn(x, y - epsilon + CURL_OFF_Z, z)) * inv2e;
var dVz_dx = (noiseFn(x + epsilon, y + CURL_OFF_Z, z) - noiseFn(x - epsilon, y + CURL_OFF_Z, z)) * inv2e;
var dVx_dz = (noiseFn(x, y, z + epsilon) - noiseFn(x, y, z - epsilon)) * inv2e;
var dVx_dy = (noiseFn(x, y + epsilon, z) - noiseFn(x, y - epsilon, z)) * inv2e;
var dVy_dx = (noiseFn(x + epsilon + CURL_OFF_Y, y, z) - noiseFn(x - epsilon + CURL_OFF_Y, y, z)) * inv2e;
ox[i] = dVz_dy - dVy_dz;
oy[i] = dVx_dz - dVz_dx;
oz[i] = dVy_dx - dVx_dy;
}
return outVec3;
}
// --- Gradient (finite-difference) — the surface normal primitive ---
function soaFillGradient3D(outVec3, positions, noiseFn, scale, epsilon) {
if (scale === undefined) scale = 1;
if (!epsilon) epsilon = 0.001;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
var ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
var inv2e = 1 / (2 * epsilon);
for (var i = 0; i < n; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
ox[i] = (noiseFn(x + epsilon, y, z) - noiseFn(x - epsilon, y, z)) * inv2e;
oy[i] = (noiseFn(x, y + epsilon, z) - noiseFn(x, y - epsilon, z)) * inv2e;
oz[i] = (noiseFn(x, y, z + epsilon) - noiseFn(x, y, z - epsilon)) * inv2e;
}
return outVec3;
}
// ============================================================================
// 8. CHUNKED ASYNC — mobile-safe for 1M+ points, yields to UI thread
// ============================================================================
async function soaFillNoise3DChunked(out, positions, noiseFn, scale, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
if (scale === undefined) scale = 1;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
out[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale);
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
return out;
}
async function soaFillFBM3DChunked(out, positions, noiseFn, scale, octaves, lacunarity, gain, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
if (scale === undefined) scale = 1;
if (!octaves) octaves = 4;
if (!lacunarity) lacunarity = 2.0;
if (!gain) gain = 0.5;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
var sum = 0, amp = 1, freq = 1, norm = 0;
for (var o = 0; o < octaves; o++) {
sum += amp * noiseFn(x * freq, y * freq, z * freq);
norm += amp;
freq *= lacunarity;
amp *= gain;
}
out[i] = sum / norm;
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
return out;
}
async function soaFillTurbulence3DChunked(out, positions, noiseFn, scale, octaves, lacunarity, gain, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
if (scale === undefined) scale = 1;
if (!octaves) octaves = 4;
if (!lacunarity) lacunarity = 2.0;
if (!gain) gain = 0.5;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
var sum = 0, amp = 1, freq = 1, norm = 0;
for (var o = 0; o < octaves; o++) {
sum += amp * Math.abs(noiseFn(x * freq, y * freq, z * freq));
norm += amp;
freq *= lacunarity;
amp *= gain;
}
out[i] = sum / norm;
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
return out;
}
async function soaFillRidged3DChunked(out, positions, noiseFn, scale, octaves, lacunarity, gain, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
if (scale === undefined) scale = 1;
if (!octaves) octaves = 4;
if (!lacunarity) lacunarity = 2.0;
if (!gain) gain = 0.5;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
var sum = 0, amp = 1, freq = 1, norm = 0;
for (var o = 0; o < octaves; o++) {
var v = 1 - Math.abs(noiseFn(x * freq, y * freq, z * freq));
sum += amp * v * v;
norm += amp;
freq *= lacunarity;
amp *= gain;
}
out[i] = sum / norm;
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
return out;
}
async function soaFillCurl3DChunked(outVec3, positions, noiseFn, scale, epsilon, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
if (scale === undefined) scale = 1;
if (!epsilon) epsilon = 0.001;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
var ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
var inv2e = 1 / (2 * epsilon);
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
var dVy_dz = (noiseFn(x + CURL_OFF_Y, y, z + epsilon) - noiseFn(x + CURL_OFF_Y, y, z - epsilon)) * inv2e;
var dVz_dy = (noiseFn(x, y + epsilon + CURL_OFF_Z, z) - noiseFn(x, y - epsilon + CURL_OFF_Z, z)) * inv2e;
var dVz_dx = (noiseFn(x + epsilon, y + CURL_OFF_Z, z) - noiseFn(x - epsilon, y + CURL_OFF_Z, z)) * inv2e;
var dVx_dz = (noiseFn(x, y, z + epsilon) - noiseFn(x, y, z - epsilon)) * inv2e;
var dVx_dy = (noiseFn(x, y + epsilon, z) - noiseFn(x, y - epsilon, z)) * inv2e;
var dVy_dx = (noiseFn(x + epsilon + CURL_OFF_Y, y, z) - noiseFn(x - epsilon + CURL_OFF_Y, y, z)) * inv2e;
ox[i] = dVz_dy - dVy_dz;
oy[i] = dVx_dz - dVz_dx;
oz[i] = dVy_dx - dVx_dy;
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
return outVec3;
}
async function soaFillGradient3DChunked(outVec3, positions, noiseFn, scale, epsilon, chunkSize, yieldEvery) {
chunkSize = chunkSize || glMatrix.CHUNK_SIZE;
yieldEvery = yieldEvery || glMatrix.CHUNK_YIELD_EVERY;
if (scale === undefined) scale = 1;
if (!epsilon) epsilon = 0.001;
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
var ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
var inv2e = 1 / (2 * epsilon);
var c = 0;
for (var start = 0; start < n; start += chunkSize) {
var end = Math.min(start + chunkSize, n);
for (var i = start; i < end; i++) {
var x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
ox[i] = (noiseFn(x + epsilon, y, z) - noiseFn(x - epsilon, y, z)) * inv2e;
oy[i] = (noiseFn(x, y + epsilon, z) - noiseFn(x, y - epsilon, z)) * inv2e;
oz[i] = (noiseFn(x, y, z + epsilon) - noiseFn(x, y, z - epsilon)) * inv2e;
}
if (++c >= yieldEvery) { c = 0; await glMatrix.yieldToMain(); }
}
return outVec3;
}
// ============================================================================
// 9. BITECS INTEGRATION — procedural world generation
// ============================================================================
// CORRECTION: Replaced closure-based noise selection with direct conditional
// branches inside the hot loop to maintain strict Zero-GC compliance.
function createNoiseFieldSystem(world, options) {
options = options || {};
var noiseFn = options.noiseFn || acquireNoise3D(options.seed);
var scale = options.scale !== undefined ? options.scale : 0.01;
var mode = options.mode || "fbm";
var octaves = options.octaves || 4;
var lacunarity = options.lacunarity || 2.0;
var gain = options.gain || 0.5;
var warpStrength = options.warpStrength || 0.5;
var threshold = options.threshold !== undefined ? options.threshold : -Infinity;
var eidsQuery = options.query || null;
return {
noiseFn: noiseFn,
/** Synchronous fill (fast, blocks the thread for 1M+). */
fillSync: function (outF32, positions) {
var n = positions.count;
var px = positions.x, py = positions.y, pz = positions.z;
// CORRECTION: Direct conditional branches instead of closure allocation
if (mode === "fbm") {
return soaFillFBM3D(outF32, positions, noiseFn, scale, octaves, lacunarity, gain);
} else if (mode === "turbulence") {
return soaFillTurbulence3D(outF32, positions, noiseFn, scale, octaves, lacunarity, gain);
} else if (mode === "ridged") {
return soaFillRidged3D(outF32, positions, noiseFn, scale, octaves, lacunarity, gain);
} else if (mode === "warped") {
return soaFillWarped3D(outF32, positions, noiseFn, scale, warpStrength, octaves);
} else {
return soaFillNoise3D(outF32, positions, noiseFn, scale);
}
},
/** Chunked async fill — mobile-safe for 1M+ entities. */
fillChunked: async function (outF32, positions, chunkSize, yieldEvery) {
if (mode === "fbm") {
return soaFillFBM3DChunked(outF32, positions, noiseFn, scale, octaves, lacunarity, gain, chunkSize, yieldEvery);
} else if (mode === "turbulence") {
return soaFillTurbulence3DChunked(outF32, positions, noiseFn, scale, octaves, lacunarity, gain, chunkSize, yieldEvery);
} else if (mode === "ridged") {
return soaFillRidged3DChunked(outF32, positions, noiseFn, scale, octaves, lacunarity, gain, chunkSize, yieldEvery);
} else {
return soaFillNoise3DChunked(outF32, positions, noiseFn, scale, chunkSize, yieldEvery);
}
},
/**
* Apply the noise field to entity positions (write into `.y` by default,
* or into a custom channel via `options.channel`).
*/
applyToPositions: function (positions, channel) {
channel = channel || "y";
var out = positions[channel];
return this.fillSync(out, positions);
},
threshold: threshold
};
}
// ============================================================================
// 10. EXPORTS
// ============================================================================
module.exports = {
// ---- original types (documented via JSDoc) ----
// RandomFn, NoiseFunction2D, NoiseFunction3D, NoiseFunction4D
// ---- original functions (byte-identical) ----
buildPermutationTable: buildPermutationTable,
createNoise2D: createNoise2D,
createNoise3D: createNoise3D,
createNoise4D: createNoise4D,
// ---- pools ----
createNoisePool: createNoisePool,
acquireNoise2D: acquireNoise2D,
acquireNoise3D: acquireNoise3D,
acquireNoise4D: acquireNoise4D,
// ---- SOA fills (sync) ----
soaFillNoise2D: soaFillNoise2D,
soaFillNoise3D: soaFillNoise3D,
soaFillNoise4D: soaFillNoise4D,
soaFillFBM2D: soaFillFBM2D,
soaFillFBM3D: soaFillFBM3D,
soaFillFBM4D: soaFillFBM4D,
soaFillTurbulence3D: soaFillTurbulence3D,
soaFillRidged3D: soaFillRidged3D,
soaFillWarped3D: soaFillWarped3D,
soaFillCurl3D: soaFillCurl3D,
soaFillGradient3D: soaFillGradient3D,
// ---- SOA fills (chunked async) ----
soaFillNoise3DChunked: soaFillNoise3DChunked,
soaFillFBM3DChunked: soaFillFBM3DChunked,
soaFillTurbulence3DChunked: soaFillTurbulence3DChunked,
soaFillRidged3DChunked: soaFillRidged3DChunked,
soaFillCurl3DChunked: soaFillCurl3DChunked,
soaFillGradient3DChunked: soaFillGradient3DChunked,
// ---- bitECS integration ----
createNoiseFieldSystem: createNoiseFieldSystem,
// ---- math modules re-exported for convenience ----
math: {
common: glMatrix, vec2: vec2, vec3: vec3, vec4: vec4, bitecs: bitecs
}
};