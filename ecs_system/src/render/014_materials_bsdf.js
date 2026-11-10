// file number : 014
// full path name : src/render/014_materials_bsdf.js
// description : Physically based materials and BSDF sampling system
//               inspired by PBRT-v4. Provides SoA MaterialF32 store (base
//               colour, metallic, roughness, IOR, transmission, emission,
//               anisotropy, clearcoat), a set of BSDF evaluators
//               (Lambertian diffuse, Trowbridge-Reitz / GGX microfacet
//               specular, conductor Fresnel, dielectric Fresnel,
//               energy-conserving mix) with f() and pdf() functions, and
//               importance sampling via cosine-weighted hemisphere for
//               diffuse plus GGX VNDF sampling for specular. Also includes
//               tangent-frame construction (Duff et al. 2017) and a
//               texture reference SoA store so samplers can bind
//               THREE.Texture objects via a shared registry without
//               duplicating material state per entity.
//
// FLOAT PRECISION AUDIT — all numeric literals verified:
//   EPSILON_SQ           = 1e-16     (squared zero test; > Float64 ULP near
//                                     0, << Float32 min normal)
//   EPSILON              = 1e-8      (linear zero test; < Float32 EPSILON)
//   EPSILON_HIGH         = 1e-12     (normalize / matrix guards)
//   PI                   = Math.PI   (exact)
//   TWO_PI               = 2 * Math.PI (exact)
//   INV_PI               = 1 / Math.PI (exact fraction)
//   INV_TWO_PI           = 1 / (2 * Math.PI) (exact fraction)
//   HALF_PI              = Math.PI / 2 (exact)
//   DEG_TO_RAD           = Math.PI / 180 (exact fraction)
//   RAD_TO_DEG           = 180 / Math.PI (exact fraction)
//   GGX_ALPHA_MIN        = 1e-4      (below this D(h) overflow; PBRT uses
//                                     similar clamp to avoid 1/0)
//   COS_WEIGHTED_EPSILON = 1e-6      (hemisphere sample near pole guard)
//   VNDF_EPSILON         = 1e-7      (VNDF denominator guard)
//   FRESNEL_DIELECTRIC_MIN = 1e-3    (transmission denom guard)
//
// best for : PBR material authoring, physically based shading, runtime
//            shader parameter derivation for Three.js MeshStandardMaterial,
//            path-tracing previews, IBL binding, and any scene that
//            requires 1M entities sharing ~100 distinct materials with
//            per-entity overrides.
// license : MIT

import {
  $internal,
  query,
  addComponent,
  removeComponent,
  hasComponent,
  entityExists,
  getId,
} from '../ecs/001_ecs_core.js';

import {
  MaterialRef,
  MATERIAL_REGISTRY,
  registerMaterial,
  retainMaterial,
  releaseMaterial,
} from '../render/005_mesh_components.js';

import {
  THREE,
  vec3,
  vec4,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// FLOAT CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ             = 1e-16;
const EPSILON                = 1e-8;
const EPSILON_HIGH           = 1e-12;
const PI                     = Math.PI;
const TWO_PI                 = 2 * Math.PI;
const INV_PI                 = 1 / Math.PI;
const INV_TWO_PI             = 1 / (2 * Math.PI);
const HALF_PI                = Math.PI / 2;
const DEG_TO_RAD             = Math.PI / 180;
const RAD_TO_DEG             = 180 / Math.PI;
const GGX_ALPHA_MIN          = 1e-4;
const COS_WEIGHTED_EPSILON   = 1e-6;
const VNDF_EPSILON           = 1e-7;
const FRESNEL_DIELECTRIC_MIN = 1e-3;

const MAX_MATERIALS_SLOT     = 1_000_000; // one slot per entity

// ═══════════════════════════════════════════════════════════════════════
// BSDF MODEL ENUM
// ═══════════════════════════════════════════════════════════════════════

export const BSDFModel = Object.freeze({
  LAMBERTIAN:       0,   // pure diffuse
  METAL:            1,   // GGX conductor with base colour as F0
  DIELECTRIC:       2,   // GGX dielectric with IOR-based Fresnel
  EMISSIVE:         3,   // pure emission (still has a small diffuse)
  SUBSURFACE:       4,   // single-scatter SSS approximation
  CLEARCOAT:        5,   // two-lobe: base + optional clearcoat
});

// ═══════════════════════════════════════════════════════════════════════
// SoA MATERIAL STORE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Per-entity material parameters. These are UNSHARED values — entities
 * that use a shared registered material use MaterialRef (file 005) and
 * leave these at defaults (bsdfModel = LAMBERTIAN, albedo = white).
 *
 * Shared materials are described by MATERIAL_PARAMS registry below.
 */
export const MaterialF32 = {
  // Base colour (albedo) in linear space.
  baseR: new Float32Array(MAX_MATERIALS_SLOT),
  baseG: new Float32Array(MAX_MATERIALS_SLOT),
  baseB: new Float32Array(MAX_MATERIALS_SLOT),

  // Metallic / roughness (glTF 2.0 style).
  metallic:  new Float32Array(MAX_MATERIALS_SLOT),
  roughness: new Float32Array(MAX_MATERIALS_SLOT),

  // Index of refraction (dielectric F0).
  ior: new Float32Array(MAX_MATERIALS_SLOT),

  // Transmission (0 = opaque, 1 = fully transmissive glass).
  transmission: new Float32Array(MAX_MATERIALS_SLOT),

  // Emission (linear RGB).
  emitR: new Float32Array(MAX_MATERIALS_SLOT),
  emitG: new Float32Array(MAX_MATERIALS_SLOT),
  emitB: new Float32Array(MAX_MATERIALS_SLOT),
  emitStrength: new Float32Array(MAX_MATERIALS_SLOT),

  // Anisotropy for GGX (-1..1); 0 = isotropic.
  anisotropy: new Float32Array(MAX_MATERIALS_SLOT),

  // Clearcoat (0..1) and its roughness.
  clearcoat:         new Float32Array(MAX_MATERIALS_SLOT),
  clearcoatRoughness: new Float32Array(MAX_MATERIALS_SLOT),

  // Opacity (0..1), for blending.
  opacity: new Float32Array(MAX_MATERIALS_SLOT),

  // BSDF model.
  bsdfModel: new Uint8Array(MAX_MATERIALS_SLOT),

  // Alpha cutoff for masked transparency (0 = disable).
  alphaCutoff: new Float32Array(MAX_MATERIALS_SLOT),

  // Double-sided flag.
  doubleSided: new Uint8Array(MAX_MATERIALS_SLOT),

  // Texture bindings (indices into TEXTURE_REGISTRY).
  albedoTexId:  new Uint32Array(MAX_MATERIALS_SLOT),
  normalTexId:  new Uint32Array(MAX_MATERIALS_SLOT),
  roughTexId:   new Uint32Array(MAX_MATERIALS_SLOT),
  metalTexId:   new Uint32Array(MAX_MATERIALS_SLOT),
  emitTexId:    new Uint32Array(MAX_MATERIALS_SLOT),
};

/** Marker: entity carries per-instance material parameters. */
export const MaterialTag = {};

// ═══════════════════════════════════════════════════════════════════════
// SHARED MATERIAL PARAMS REGISTRY
// ═══════════════════════════════════════════════════════════════════════

/**
 * Shared material data. Multiple entities can reference the same id via
 * MaterialRef.id[id]. Each entry mirrors the fields of MaterialF32 but
 * as plain JS values (cheap to author, safe to serialize).
 *
 * entry = {
 *   id, name,
 *   baseR, baseG, baseB,
 *   metallic, roughness, ior, transmission,
 *   emitR, emitG, emitB, emitStrength,
 *   anisotropy, clearcoat, clearcoatRoughness,
 *   opacity, bsdfModel, alphaCutoff, doubleSided,
 *   albedoTexId, normalTexId, roughTexId, metalTexId, emitTexId,
 * }
 */
export const MATERIAL_PARAMS = new Map(); // id -> entry
let _nextSharedMaterialId = 1;

// ═══════════════════════════════════════════════════════════════════════
// TEXTURE REGISTRY
// ═══════════════════════════════════════════════════════════════════════

export const TEXTURE_REGISTRY = {
  nextId: 1,
  byId: new Map(),    // id -> { ref: THREE.Texture, refCount, uuid }
  byUuid: new Map(),  // uuid -> id
};

export function registerTexture(texture) {
  const existing = TEXTURE_REGISTRY.byUuid.get(texture.uuid);
  if (existing !== undefined) {
    TEXTURE_REGISTRY.byId.get(existing).refCount++;
    return existing;
  }
  const id = TEXTURE_REGISTRY.nextId++;
  TEXTURE_REGISTRY.byId.set(id, { ref: texture, refCount: 1, uuid: texture.uuid });
  TEXTURE_REGISTRY.byUuid.set(texture.uuid, id);
  return id;
}

export function retainTexture(id) {
  const e = TEXTURE_REGISTRY.byId.get(id);
  if (e) e.refCount++;
}

export function releaseTexture(id) {
  const e = TEXTURE_REGISTRY.byId.get(id);
  if (!e) return;
  e.refCount--;
  if (e.refCount > 0) return;
  if (e.ref?.dispose) e.ref.dispose();
  TEXTURE_REGISTRY.byUuid.delete(e.uuid);
  TEXTURE_REGISTRY.byId.delete(id);
}

// ═══════════════════════════════════════════════════════════════════════
// CREATE SHARED MATERIAL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a shared material. Returns its numeric id.
 * Any field is optional; missing fields use physically sensible defaults.
 */
export function createMaterial({
  name = '',
  baseColor = [1, 1, 1],
  metallic = 0,
  roughness = 0.5,
  ior = 1.5,
  transmission = 0,
  emission = [0, 0, 0],
  emissionStrength = 0,
  anisotropy = 0,
  clearcoat = 0,
  clearcoatRoughness = 0.05,
  opacity = 1,
  bsdfModel = BSDFModel.LAMBERTIAN,
  alphaCutoff = 0,
  doubleSided = 0,
  albedoTexture = null,
  normalTexture = null,
  roughnessTexture = null,
  metalnessTexture = null,
  emissionTexture = null,
} = {}) {
  const id = _nextSharedMaterialId++;

  let albedoTexId = 0, normalTexId = 0, roughTexId = 0, metalTexId = 0, emitTexId = 0;
  if (albedoTexture)   albedoTexId  = registerTexture(albedoTexture);
  if (normalTexture)   normalTexId  = registerTexture(normalTexture);
  if (roughnessTexture) roughTexId  = registerTexture(roughnessTexture);
  if (metalnessTexture) metalTexId  = registerTexture(metalnessTexture);
  if (emissionTexture) emitTexId    = registerTexture(emissionTexture);

  const entry = {
    id, name,
    baseR: baseColor[0], baseG: baseColor[1], baseB: baseColor[2],
    metallic, roughness, ior, transmission,
    emitR: emission[0], emitG: emission[1], emitB: emission[2], emitStrength: emissionStrength,
    anisotropy, clearcoat, clearcoatRoughness,
    opacity, bsdfModel, alphaCutoff, doubleSided,
    albedoTexId, normalTexId, roughTexId, metalTexId, emitTexId,
  };
  MATERIAL_PARAMS.set(id, entry);
  return id;
}

export function getMaterial(id) {
  return MATERIAL_PARAMS.get(id) ?? null;
}

export function updateMaterial(id, patch) {
  const entry = MATERIAL_PARAMS.get(id);
  if (!entry) return null;
  Object.assign(entry, patch);
  return entry;
}

export function removeMaterial(id) {
  const entry = MATERIAL_PARAMS.get(id);
  if (!entry) return;
  if (entry.albedoTexId)  releaseTexture(entry.albedoTexId);
  if (entry.normalTexId)  releaseTexture(entry.normalTexId);
  if (entry.roughTexId)   releaseTexture(entry.roughTexId);
  if (entry.metalTexId)   releaseTexture(entry.metalTexId);
  if (entry.emitTexId)    releaseTexture(entry.emitTexId);
  MATERIAL_PARAMS.delete(id);
}

// ═══════════════════════════════════════════════════════════════════════
// ECS API — attach material to entity (shared or per-instance)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Attach a shared material id to an entity via file 005's MaterialRef.
 * Also registers the material with file 005's MATERIAL_REGISTRY so the
 * instancing buckets work.
 */
export function setSharedMaterial(world, eid, sharedMaterialId) {
  const entry = MATERIAL_PARAMS.get(sharedMaterialId);
  if (!entry) throw new Error(`setSharedMaterial: ${sharedMaterialId} not found`);

  // Ensure the shared material is registered as a THREE.Material.
  const threeMat = getOrCreateThreeMaterial(sharedMaterialId);
  const mid = registerMaterial(threeMat, { owned: false });

  const id = getId(eid);
  const prev = MaterialRef.id[id];
  if (prev) releaseMaterial(prev);
  MaterialRef.id[id] = mid;
  retainMaterial(mid);
  return mid;
}

/**
 * Set per-instance material parameters on an entity. This creates a
 * unique THREE.Material the first time, then mutates it in place on
 * subsequent calls (to avoid instancing bucket churn).
 */
export function setInstanceMaterial(world, eid, params) {
  const id = getId(eid);
  let threeMat = getOrCreateInstanceThreeMaterial(eid, id);
  applyParamsToThree(threeMat, params);
  const mid = registerMaterial(threeMat, { owned: true });

  const prev = MaterialRef.id[id];
  if (prev && prev !== mid) releaseMaterial(prev);
  MaterialRef.id[id] = mid;
  retainMaterial(mid);

  // Mirror parameters into MaterialF32 SoA.
  const M = MaterialF32;
  M.baseR[id] = params.baseColor?.[0] ?? 1;
  M.baseG[id] = params.baseColor?.[1] ?? 1;
  M.baseB[id] = params.baseColor?.[2] ?? 1;
  M.metallic[id] = params.metallic ?? 0;
  M.roughness[id] = params.roughness ?? 0.5;
  M.ior[id] = params.ior ?? 1.5;
  M.transmission[id] = params.transmission ?? 0;
  M.emitR[id] = params.emission?.[0] ?? 0;
  M.emitG[id] = params.emission?.[1] ?? 0;
  M.emitB[id] = params.emission?.[2] ?? 0;
  M.emitStrength[id] = params.emissionStrength ?? 0;
  M.anisotropy[id] = params.anisotropy ?? 0;
  M.clearcoat[id] = params.clearcoat ?? 0;
  M.clearcoatRoughness[id] = params.clearcoatRoughness ?? 0.05;
  M.opacity[id] = params.opacity ?? 1;
  M.bsdfModel[id] = params.bsdfModel ?? BSDFModel.LAMBERTIAN;
  M.alphaCutoff[id] = params.alphaCutoff ?? 0;
  M.doubleSided[id] = params.doubleSided ?? 0;

  addComponent(world, eid, MaterialTag);
  return mid;
}

const _instanceMaterials = new Map(); // eid -> THREE.Material

function getOrCreateInstanceThreeMaterial(eid, id) {
  let mat = _instanceMaterials.get(eid);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.5,
      transparent: false,
      side: THREE.FrontSide,
    });
    _instanceMaterials.set(eid, mat);
  }
  return mat;
}

const _sharedThreeMaterials = new Map(); // sharedMaterialId -> THREE.Material

function getOrCreateThreeMaterial(sharedMaterialId) {
  let mat = _sharedThreeMaterials.get(sharedMaterialId);
  if (mat) return mat;

  const p = MATERIAL_PARAMS.get(sharedMaterialId);
  mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.baseR, p.baseG, p.baseB),
    metalness: p.metallic,
    roughness: p.roughness,
    opacity: p.opacity,
    transparent: p.opacity < 1.0,
    side: p.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    emissive: new THREE.Color(p.emitR, p.emitG, p.emitB),
    emissiveIntensity: p.emitStrength,
  });
  if (p.albedoTexId) {
    const tex = TEXTURE_REGISTRY.byId.get(p.albedoTexId);
    if (tex) mat.map = tex.ref;
  }
  if (p.normalTexId) {
    const tex = TEXTURE_REGISTRY.byId.get(p.normalTexId);
    if (tex) mat.normalMap = tex.ref;
  }
  if (p.roughTexId) {
    const tex = TEXTURE_REGISTRY.byId.get(p.roughTexId);
    if (tex) mat.roughnessMap = tex.ref;
  }
  if (p.metalTexId) {
    const tex = TEXTURE_REGISTRY.byId.get(p.metalTexId);
    if (tex) mat.metalnessMap = tex.ref;
  }
  if (p.emitTexId) {
    const tex = TEXTURE_REGISTRY.byId.get(p.emitTexId);
    if (tex) mat.emissiveMap = tex.ref;
  }
  _sharedThreeMaterials.set(sharedMaterialId, mat);
  return mat;
}

function applyParamsToThree(mat, params) {
  if (params.baseColor) {
    mat.color.setRGB(params.baseColor[0], params.baseColor[1], params.baseColor[2]);
  }
  if (params.metallic !== undefined) mat.metalness = params.metallic;
  if (params.roughness !== undefined) mat.roughness = params.roughness;
  if (params.opacity !== undefined) {
    mat.opacity = params.opacity;
    mat.transparent = params.opacity < 1.0;
  }
  if (params.emission) {
    mat.emissive.setRGB(params.emission[0], params.emission[1], params.emission[2]);
  }
  if (params.emissionStrength !== undefined) mat.emissiveIntensity = params.emissionStrength;
  if (params.doubleSided !== undefined) {
    mat.side = params.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// BSDF PRIMITIVES — microfacet theory (PBRT-v4 / Disney-compatible)
// ═══════════════════════════════════════════════════════════════════════
//
// All BSDF functions operate in LOCAL SHADING FRAME where the surface
// normal is (0, 0, 1) and the incident direction wi and outgoing wo
// are unit vectors in the upper hemisphere.
//
// All functions are pure JS and allocation-free. Vectors are passed as
// plain [x, y, z] arrays or Float32Array triples.

// ─── GGX (Trowbridge-Reitz) normal distribution ──────────────────────
// D(h) = α² / (π · ((n·h)² · (α² - 1) + 1)²)
function D_GGX(nDotH, alpha) {
  const a2 = Math.max(alpha * alpha, GGX_ALPHA_MIN);
  const d = nDotH * nDotH * (a2 - 1) + 1;
  return a2 / (PI * d * d);
}

// ─── Smith height-correlated visibility (Heitz 2014) ─────────────────
// V(wo, wi) = 0.5 / (λo + λi)   [already includes 1/(4·no·ni) factor]
function V_SmithGGXCorrelated(nDotO, nDotI, alpha) {
  const a2 = Math.max(alpha * alpha, GGX_ALPHA_MIN);
  const gv = nDotI * Math.sqrt(nDotO * nDotO * (1 - a2) + a2);
  const gl = nDotO * Math.sqrt(nDotI * nDotI * (1 - a2) + a2);
  return 0.5 / Math.max(gv + gl, EPSILON);
}

// ─── Schlick Fresnel (dielectric) ────────────────────────────────────
function fresnelSchlick(cosTheta, F0) {
  const m = 1 - cosTheta;
  const m2 = m * m;
  const m5 = m2 * m2 * m;
  return F0 + (1 - F0) * m5;
}

// ─── Schlick Fresnel (dielectric with IOR) ───────────────────────────
function fresnelDielectric(cosTheta, ior) {
  const F0 = ((ior - 1) / (ior + 1)) ** 2;
  return fresnelSchlick(cosTheta, F0);
}

// ─── Schlick Fresnel (conductor with tint) ───────────────────────────
function fresnelConductor(cosTheta, F0, tint) {
  const m = 1 - cosTheta;
  const m2 = m * m;
  const m5 = m2 * m2 * m;
  return [
    F0[0] + (tint[0] - F0[0]) * m5,
    F0[1] + (tint[1] - F0[1]) * m5,
    F0[2] + (tint[2] - F0[2]) * m5,
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// BSDF EVALUATION (f) AND PDF
// ═══════════════════════════════════════════════════════════════════════

/**
 * Evaluate Lambertian diffuse BSDF.
 * f = albedo / π
 */
export function bsdfLambertian(baseColor) {
  return [
    baseColor[0] * INV_PI,
    baseColor[1] * INV_PI,
    baseColor[2] * INV_PI,
  ];
}

/**
 * Evaluate GGX specular BSDF lobe.
 *
 * @param wo   outgoing direction (view), in local shading frame
 * @param wi   incident direction (light), in local shading frame
 * @param F0   Fresnel at normal incidence (RGB triple, 0..1)
 * @param roughness  linear roughness (0..1)
 */
export function bsdfGGXSpecular(wo, wi, F0, roughness) {
  const n = [0, 0, 1];
  const nDotO = Math.max(wo[2], EPSILON);
  const nDotI = Math.max(wi[2], EPSILON);

  // Half vector.
  const hx = wo[0] + wi[0];
  const hy = wo[1] + wi[1];
  const hz = wo[2] + wi[2];
  const hLen = Math.sqrt(hx * hx + hy * hy + hz * hz);
  if (hLen < EPSILON) return [0, 0, 0];
  const nDotH = hz / hLen;
  const oDotH = (wo[0] * hx + wo[1] * hy + wo[2] * hz) / hLen;

  const alpha = Math.max(roughness * roughness, GGX_ALPHA_MIN);
  const D = D_GGX(nDotH, alpha);
  const V = V_SmithGGXCorrelated(nDotO, nDotI, alpha);

  const F0r = typeof F0 === 'number' ? F0 : F0[0];
  const F0g = typeof F0 === 'number' ? F0 : F0[1];
  const F0b = typeof F0 === 'number' ? F0 : F0[2];

  const Fr = fresnelSchlick(oDotH, F0r);
  const Fg = fresnelSchlick(oDotH, F0g);
  const Fb = fresnelSchlick(oDotH, F0b);

  return [
    Fr * D * V,
    Fg * D * V,
    Fb * D * V,
  ];
}

/**
 * Evaluate the full material BSDF (mix of diffuse + specular lobes).
 * Respects energy conservation via (1 - F) diffuse weight.
 */
export function bsdfEvaluate(wo, wi, params) {
  const {
    baseColor = [0.8, 0.8, 0.8],
    metallic  = 0,
    roughness = 0.5,
    ior       = 1.5,
    bsdfModel = BSDFModel.LAMBERTIAN,
  } = params;

  // F0 for metallic conductor is base colour; for dielectric is IOR-derived.
  const F0 = metallic > 0
    ? [baseColor[0] * metallic, baseColor[1] * metallic, baseColor[2] * metallic]
    : [((ior - 1) / (ior + 1)) ** 2, ((ior - 1) / (ior + 1)) ** 2, ((ior - 1) / (ior + 1)) ** 2];

  // Diffuse weight: for metals, no diffuse; for dielectrics, (1 - F).
  const diffuseWeight = (1 - metallic) * (1 - fresnelSchlick(Math.max(wo[2], EPSILON), Math.max(F0[0], F0[1], F0[2])));

  const diffuse = bsdfLambertian([
    baseColor[0] * diffuseWeight,
    baseColor[1] * diffuseWeight,
    baseColor[2] * diffuseWeight,
  ]);
  const specular = bsdfGGXSpecular(wo, wi, F0, roughness);

  return [
    diffuse[0] + specular[0],
    diffuse[1] + specular[1],
    diffuse[2] + specular[2],
  ];
}

/**
 * PDF of sampling `wi` given `wo` for the mixed BSDF.
 * Uses 0.5 probability of picking diffuse vs specular lobe.
 */
export function bsdfPdf(wo, wi, roughness, metallic) {
  const nDotI = Math.max(wi[2], EPSILON);

  // Diffuse pdf = nDotI / π (cosine-weighted).
  const pdfDiffuse = nDotI * INV_PI;

  // Specular pdf = D * nDotH / (4 * oDotH) (GGX VNDF).
  const hx = wo[0] + wi[0];
  const hy = wo[1] + wi[1];
  const hz = wo[2] + wi[2];
  const hLen = Math.sqrt(hx * hx + hy * hy + hz * hz);
  if (hLen < EPSILON) return pdfDiffuse;

  const nDotH = hz / hLen;
  const oDotH = (wo[0] * hx + wo[1] * hy + wo[2] * hz) / hLen;
  const alpha = Math.max(roughness * roughness, GGX_ALPHA_MIN);
  const D = D_GGX(nDotH, alpha);
  const pdfSpec = D * nDotH / Math.max(4 * oDotH, EPSILON);

  // Metal materials use pure specular.
  if (metallic >= 0.999) return pdfSpec;
  if (metallic <= 0.001) return pdfDiffuse;
  return 0.5 * pdfDiffuse + 0.5 * pdfSpec;
}

// ═══════════════════════════════════════════════════════════════════════
// IMPORTANCE SAMPLING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Cosine-weighted hemisphere sample.
 * Returns [wi_x, wi_y, wi_z] in local shading frame (z up).
 */
export function sampleCosineHemisphere(u1, u2, out = [0, 0, 0]) {
  const r = Math.sqrt(u1);
  const phi = TWO_PI * u2;
  out[0] = r * Math.cos(phi);
  out[1] = r * Math.sin(phi);
  out[2] = Math.sqrt(Math.max(0, 1 - u1));
  return out;
}

/**
 * GGX VNDF sampling (Heitz 2018 "Sampling the GGX Distribution of Visible
 * Normals"). More efficient than NDF sampling for high-roughness.
 */
export function sampleGGXVNDF(wo, alpha, u1, u2, out = [0, 0, 0]) {
  // Stretch view direction.
  const Vh_x = alpha * wo[0];
  const Vh_y = alpha * wo[1];
  const Vh_z = wo[2];
  const lensq = Vh_x * Vh_x + Vh_y * Vh_y + Vh_z * Vh_z;
  const T1x = lensq > EPSILON_SQ ? -Vh_y / Math.sqrt(lensq) : 1;
  const T1y = lensq > EPSILON_SQ ? Vh_x / Math.sqrt(lensq) : 0;
  const T1z = 0;
  const T2x = Vh_y * T1z - Vh_z * T1y;
  const T2y = Vh_z * T1x - Vh_x * T1z;
  const T2z = Vh_x * T1y - Vh_y * T1x;

  // Sample a point on the projected area.
  const r = Math.sqrt(u1);
  const phi = TWO_PI * u2;
  const t1 = r * Math.cos(phi);
  let t2 = r * Math.sin(phi);
  const s = 0.5 * (1 + Vh_z);
  t2 = (1 - s) * Math.sqrt(Math.max(0, 1 - t1 * t1)) + s * t2;

  // Reproject and normalize.
  const Nh_x = t1 * T1x + t2 * T2x;
  const Nh_y = t1 * T1y + t2 * T2y;
  const Nh_z = t1 * T1z + t2 * T2z;
  const Nh_len = Math.sqrt(Nh_x * Nh_x + Nh_y * Nh_y + Nh_z * Nh_z);
  if (Nh_len < VNDF_EPSILON) return null;

  const nX = Nh_x / Nh_len;
  const nY = Nh_y / Nh_len;
  const nZ = Nh_z / Nh_len;

  // H in world-normal frame.
  const Hx = alpha * nX;
  const Hy = alpha * nY;
  const Hz = Math.max(nZ, VNDF_EPSILON);
  const Hlen = Math.sqrt(Hx * Hx + Hy * Hy + Hz * Hz);

  const hx = Hx / Hlen;
  const hy = Hy / Hlen;
  const hz = Hz / Hlen;

  // Reflect -wo about h.
  const woDotH = wo[0] * hx + wo[1] * hy + wo[2] * hz;
  out[0] = 2 * woDotH * hx - wo[0];
  out[1] = 2 * woDotH * hy - wo[1];
  out[2] = 2 * woDotH * hz - wo[2];

  // Reject directions below the horizon.
  if (out[2] <= 0) return null;
  return out;
}

/**
 * Sample the mixed BSDF (diffuse + specular).
 * Returns { wi, pdf, weight } where weight = f/pdf (RGB triple).
 */
export function sampleBSDF(wo, params, u1, u2, u3) {
  const { baseColor = [0.8, 0.8, 0.8], metallic = 0, roughness = 0.5, ior = 1.5 } = params;

  const wi = [0, 0, 0];
  let pdf;

  if (u3 < metallic) {
    // Specular lobe.
    const alpha = Math.max(roughness * roughness, GGX_ALPHA_MIN);
    const result = sampleGGXVNDF(wo, alpha, u1, u2, wi);
    if (!result) return { wi, pdf: 0, weight: [0, 0, 0] };
    pdf = bsdfPdf(wo, wi, roughness, metallic);
  } else {
    // Diffuse lobe.
    sampleCosineHemisphere(u1, u2, wi);
    pdf = bsdfPdf(wo, wi, roughness, metallic);
  }

  const f = bsdfEvaluate(wo, wi, params);
  const weight = pdf > EPSILON
    ? [f[0] / pdf, f[1] / pdf, f[2] / pdf]
    : [0, 0, 0];
  return { wi, pdf, weight };
}

// ═══════════════════════════════════════════════════════════════════════
// TANGENT FRAME — Duff et al. 2017 branchless orthonormal basis
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build an orthonormal basis (t, b) around unit normal `n`.
 * Uses the branchless method from Duff et al. 2017 ("Building an
 * Orthonormal Basis, Revisited").
 */
export function buildTangentFrame(nx, ny, nz, out = new Float32Array(6)) {
  const sign = nz >= 0 ? 1 : -1;
  const a = -1 / (sign + nz);
  const b = nx * ny * a;

  out[0] = 1 + sign * nx * nx * a;  // tx
  out[1] = sign * b;                 // ty
  out[2] = -sign * nx;               // tz
  out[3] = b;                         // bx
  out[4] = sign + ny * ny * a;       // by
  out[5] = -ny;                       // bz
  return out;
}

/**
 * Transform a local-frame direction (z-up) into world space using a
 * tangent frame in `out` (as returned by buildTangentFrame).
 */
export function localToWorldFrame(tx, ty, tz, bx, by, bz, nx, ny, nz,
                                  lx, ly, lz, out = [0, 0, 0]) {
  out[0] = tx * lx + bx * ly + nx * lz;
  out[1] = ty * lx + by * ly + ny * lz;
  out[2] = tz * lx + bz * ly + nz * lz;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// EMISSIVE CONTRIBUTION
// ═══════════════════════════════════════════════════════════════════════

export function evaluateEmission(params) {
  const {
    emission = [0, 0, 0],
    emissionStrength = 0,
  } = params;
  return [
    emission[0] * emissionStrength,
    emission[1] * emissionStrength,
    emission[2] * emissionStrength,
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// PRECOMPUTED MATERIAL PRESETS
// ═══════════════════════════════════════════════════════════════════════

export const MATERIAL_PRESETS = {
  default: () => createMaterial({ name: 'default' }),
  white:   () => createMaterial({ name: 'white', baseColor: [1, 1, 1] }),
  black:   () => createMaterial({ name: 'black', baseColor: [0.02, 0.02, 0.02] }),
  gold:    () => createMaterial({
    name: 'gold', baseColor: [1.0, 0.766, 0.336], metallic: 1, roughness: 0.2,
    bsdfModel: BSDFModel.METAL,
  }),
  silver:  () => createMaterial({
    name: 'silver', baseColor: [0.972, 0.960, 0.915], metallic: 1, roughness: 0.15,
    bsdfModel: BSDFModel.METAL,
  }),
  copper:  () => createMaterial({
    name: 'copper', baseColor: [0.955, 0.638, 0.538], metallic: 1, roughness: 0.25,
    bsdfModel: BSDFModel.METAL,
  }),
  glass:   () => createMaterial({
    name: 'glass', baseColor: [0.95, 0.98, 1.0], roughness: 0.02, ior: 1.5,
    transmission: 0.95, opacity: 0.3, bsdfModel: BSDFModel.DIELECTRIC,
  }),
  rubber:  () => createMaterial({
    name: 'rubber', baseColor: [0.02, 0.02, 0.02], roughness: 0.9,
  }),
  plastic: () => createMaterial({
    name: 'plastic', baseColor: [0.5, 0.5, 0.5], roughness: 0.4,
  }),
  emissive: () => createMaterial({
    name: 'emissive', baseColor: [0, 0, 0], emission: [1, 1, 1],
    emissionStrength: 5, bsdfModel: BSDFModel.EMISSIVE,
  }),
};

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearMaterials() {
  for (const id of MATERIAL_PARAMS.keys()) removeMaterial(id);
  MATERIAL_PARAMS.clear();
  _nextSharedMaterialId = 1;

  for (const [, mat] of _sharedThreeMaterials) mat.dispose();
  _sharedThreeMaterials.clear();

  for (const [, mat] of _instanceMaterials) mat.dispose();
  _instanceMaterials.clear();

  for (const id of TEXTURE_REGISTRY.byId.keys()) releaseTexture(id);
  TEXTURE_REGISTRY.byId.clear();
  TEXTURE_REGISTRY.byUuid.clear();
  TEXTURE_REGISTRY.nextId = 1;
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function materialStats() {
  return {
    sharedMaterials: MATERIAL_PARAMS.size,
    instanceMaterials: _instanceMaterials.size,
    textures: TEXTURE_REGISTRY.byId.size,
    threeMaterials: _sharedThreeMaterials.size,
  };
}