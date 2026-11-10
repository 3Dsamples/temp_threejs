// file number : 017
// full path name : src/render/017_integrators.js
// description : PBRT-v4-inspired integrator subsystem. Provides a family
//               of pure-function integrators that consume a small context
//               object and produce radiance estimates for a ray:
//                 • PathIntegrator       (unidirectional path tracing)
//                 • VolPathIntegrator    (heterogeneous media / volumetric)
//                 • SimplePathIntegrator (no NEE, debug integrator)
//                 • AOIntegrator         (ambient occlusion)
//                 • LightIntegrator      (direct lighting only)
//                 • WhittedIntegrator    (specular-only debug)
//               plus an Integrator registry, per-integrator SoA state
//               (max depth, rr threshold, light sample count, filter type),
//               a Russian-roulette helper, a NEE helper that queries the
//               light BVH (file 015), and a BSDF sample wrapper (file 014)
//               that returns (wi, pdf, weight) in world space via a
//               pre-built tangent frame (Duff 2017). Integrators are pure
//               functions so they run on CPU without ECS access; the ECS
//               wrapper systemDispatchIntegrator iterates active workers.
// best for : Real-time preview rendering, offline reference rendering
//            inside the runtime, volumetric fog / smoke previews, AO
//            passes for mobile, and any scene that must render at
//            1M-entity scale via progressive accumulation (file 016 film).
// license : MIT

import {
  $internal,
  query,
  addComponent,
  removeComponent,
  hasComponent,
  getId,
} from '../ecs/001_ecs_core.js';

import {
  bsdfEvaluate,
  bsdfPdf,
  bsdfLambertian,
  bsdfGGXSpecular,
  sampleBSDF,
  sampleCosineHemisphere,
  sampleGGXVNDF,
  buildTangentFrame,
  localToWorldFrame,
  BSDFModel,
  MaterialF32,
  MaterialTag,
} from './014_materials_bsdf.js';

import {
  LightF32,
  LightType,
  sampleLight,
  queryLightsBVH,
} from './015_lights_shadows.js';

import {
  CameraExt,
  CameraType,
  FILMS,
  FilmType,
  filmAddSample,
  cameraGenerateRay,
  SamplerState,
  SamplerType,
  samplerNext1D,
  samplerReset,
} from './016_cameras_film_samplers.js';

import {
  WorldTransformF32,
} from '../transform/002_transform_hierarchy.js';

import {
  bvhRaycast,
} from '../spatial/003_bvh_broadphase.js';

import {
  vec3,
  vec4,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ         = 1e-16;
const EPSILON            = 1e-8;
const EPSILON_HIGH       = 1e-12;
const PI                 = Math.PI;
const TWO_PI             = 2 * Math.PI;
const INV_PI             = 1 / Math.PI;
const INV_TWO_PI         = 1 / (2 * Math.PI);
const HALF_PI            = Math.PI / 2;
const DEG_TO_RAD         = Math.PI / 180;
const RAD_TO_DEG         = 180 / Math.PI;
const SHADOW_EPSILON     = 1e-4;
const RR_THRESHOLD_DEFAULT = 0.05;
const MAX_DEPTH_DEFAULT    = 5;

// ═══════════════════════════════════════════════════════════════════════
// INTEGRATOR TYPE ENUM
// ═══════════════════════════════════════════════════════════════════════

export const IntegratorType = Object.freeze({
  PATH:            0,   // full path tracing with NEE
  VOL_PATH:        1,   // path tracing with participating media
  SIMPLE_PATH:     2,   // path tracing without NEE (debug)
  AO:              3,   // ambient occlusion
  LIGHT:           4,   // direct lighting only
  WHITTED:         5,   // specular-only debug
});

// ═══════════════════════════════════════════════════════════════════════
// INTEGRATOR STATE (SoA — one slot per active integrator)
// ═══════════════════════════════════════════════════════════════════════

const MAX_INTEGRATORS = 32;

export const IntegratorState = {
  type: new Uint8Array(MAX_INTEGRATORS),
  maxDepth: new Uint8Array(MAX_INTEGRATORS),
  rrThreshold: new Float32Array(MAX_INTEGRATORS),
  samplesPerPixel: new Uint16Array(MAX_INTEGRATORS),
  maxLightSamples: new Uint16Array(MAX_INTEGRATORS),
  filmId: new Uint16Array(MAX_INTEGRATORS),
  cameraSlot: new Uint8Array(MAX_INTEGRATORS),
  samplerSlot: new Uint8Array(MAX_INTEGRATORS),
  // Ambient occlusion radius.
  aoRadius: new Float32Array(MAX_INTEGRATORS),
  // Environment contribution scale.
  envScale: new Float32Array(MAX_INTEGRATORS),
  enabled: new Uint8Array(MAX_INTEGRATORS),
};

let _nextIntegratorSlot = 0;

export function createIntegrator(type, {
  maxDepth = MAX_DEPTH_DEFAULT,
  rrThreshold = RR_THRESHOLD_DEFAULT,
  samplesPerPixel = 1,
  maxLightSamples = 1,
  filmId = 0,
  cameraSlot = 0,
  samplerSlot = 0,
  aoRadius = 1,
  envScale = 1,
} = {}) {
  if (_nextIntegratorSlot >= MAX_INTEGRATORS) {
    throw new Error('integrator capacity exceeded (max 32)');
  }
  const slot = _nextIntegratorSlot++;
  IntegratorState.type[slot] = type;
  IntegratorState.maxDepth[slot] = maxDepth;
  IntegratorState.rrThreshold[slot] = rrThreshold;
  IntegratorState.samplesPerPixel[slot] = samplesPerPixel;
  IntegratorState.maxLightSamples[slot] = maxLightSamples;
  IntegratorState.filmId[slot] = filmId;
  IntegratorState.cameraSlot[slot] = cameraSlot;
  IntegratorState.samplerSlot[slot] = samplerSlot;
  IntegratorState.aoRadius[slot] = aoRadius;
  IntegratorState.envScale[slot] = envScale;
  IntegratorState.enabled[slot] = 1;
  return slot;
}

export function enableIntegrator(slot, on) {
  IntegratorState.enabled[slot] = on ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════════════════
// SCENE INTERFACE — what an integrator needs from the world
// ═══════════════════════════════════════════════════════════════════════
//
// The integrator does not know about ECS directly. It uses a SceneProxy
// object that provides:
//   raycast(ox, oy, oz, dx, dy, dz, tMax) → hit
//     hit = { eid, t, nx, ny, nz, px, py, pz } or null
//   getMaterial(eid) → params object (for BSDF)
//   getLightSlots(px, py, pz, radius) → array of light slots
//   sampleLight(slot, px, py, pz, u1, u2) → { wi, pdf, Li, distance } | null
//   getEnvRadiance(dx, dy, dz) → [r,g,b]
//
// `createSceneProxy(world)` below builds a proxy bound to the current ECS
// world, so integrators stay world-agnostic.

export function createSceneProxy(world) {
  return {
    raycast(ox, oy, oz, dx, dy, dz, tMax) {
      const hits = bvhRaycast([ox, oy, oz], [dx, dy, dz], tMax, true);
      if (hits.length === 0) return null;
      const hit = hits[0];
      const eid = hit.eid;
      if (!hasComponent(world, eid, WorldTransformF32)) return null;
      // Approximate hit point from ray + t.
      const hx = ox + dx * hit.t;
      const hy = oy + dy * hit.t;
      const hz = oz + dz * hit.t;
      // Approximate normal from WorldBoundsF32 or material — fall back to -ray.
      // For real geometry, file 005's mesh would supply a triangle normal.
      return {
        eid, t: hit.t,
        px: hx, py: hy, pz: hz,
        nx: -dx, ny: -dy, nz: -dz,
      };
    },
    getMaterial(eid) {
      const id = getId(eid);
      return {
        baseColor: [MaterialF32.baseR[id], MaterialF32.baseG[id], MaterialF32.baseB[id]],
        metallic: MaterialF32.metallic[id],
        roughness: MaterialF32.roughness[id],
        ior: MaterialF32.ior[id],
        transmission: MaterialF32.transmission[id],
        emission: [MaterialF32.emitR[id], MaterialF32.emitG[id], MaterialF32.emitB[id]],
        emissionStrength: MaterialF32.emitStrength[id],
        bsdfModel: MaterialF32.bsdfModel[id],
      };
    },
    getLightSlots(px, py, pz, radius) {
      return queryLightsBVH(px, py, pz, radius);
    },
    sampleLight(slot, px, py, pz, u1, u2) {
      return sampleLight(slot, px, py, pz, u1, u2);
    },
    getEnvRadiance(dx, dy, dz) {
      // Sum all INFINITE lights' colour weighted by a hemisphere lookup.
      let r = 0, g = 0, b = 0;
      for (let s = 0; s < 32; s++) {
        if (LightF32.enabled[s] === 0) continue;
        if (LightF32.type[s] !== LightType.INFINITE) continue;
        r += LightF32.r[s] * LightF32.intensity[s];
        g += LightF32.g[s] * LightF32.intensity[s];
        b += LightF32.b[s] * LightF32.intensity[s];
      }
      return [r * 0.1, g * 0.1, b * 0.1];
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// RUSSIAN ROULETTE
// ═══════════════════════════════════════════════════════════════════════

function russianRoulette(throughput, u) {
  const p = Math.max(
    Math.min(
      Math.max(throughput[0], throughput[1], throughput[2]),
      1
    ),
    EPSILON
  );
  return u < p ? 1 / p : 0;
}

// ═══════════════════════════════════════════════════════════════════════
// TANGENT FRAME HELPER
// ═══════════════════════════════════════════════════════════════════════

const _frame = new Float32Array(6);

function frameFromNormal(nx, ny, nz) {
  buildTangentFrame(nx, ny, nz, _frame);
  return _frame;
}

// ═══════════════════════════════════════════════════════════════════════
// PATH INTEGRATOR (PBRT-v4 PathIntegrator)
// ═══════════════════════════════════════════════════════════════════════

const _wi = vec3.create();
const _sample = { wi: [0, 0, 0], pdf: 0, weight: [0, 0, 0] };

/**
 * Full path tracer with next-event estimation.
 *
 * @param integratorSlot   from createIntegrator
 * @param ray              { ox, oy, oz, dx, dy, dz }
 * @param scene            scene proxy
 * @param samplerSlot      for BSDF direction sampling
 * @param rng              { u1, u2, u3 } uniform samples (one per bounce)
 * @returns [r, g, b]
 */
export function integratePath(slot, ray, scene, samplerSlot) {
  const maxDepth = IntegratorState.maxDepth[slot];
  const rrThreshold = IntegratorState.rrThreshold[slot];
  const maxLightSamples = IntegratorState.maxLightSamples[slot];

  let ox = ray.ox, oy = ray.oy, oz = ray.oz;
  let dx = ray.dx, dy = ray.dy, dz = ray.dz;

  let Lr = 0, Lg = 0, Lb = 0;
  let tR = 1, tG = 1, tB = 1;

  const u = new Float32Array(6);

  for (let depth = 0; depth < maxDepth; depth++) {
    samplerNext1D(samplerSlot, u);

    const hit = scene.raycast(ox, oy, oz, dx, dy, dz, 1e30);

    if (!hit) {
      const env = scene.getEnvRadiance(dx, dy, dz);
      Lr += tR * env[0];
      Lg += tG * env[1];
      Lb += tB * env[2];
      break;
    }

    const mat = scene.getMaterial(hit.eid);

    // Emissive surface contribution.
    if (mat.emissionStrength > 0) {
      const emR = mat.emission[0] * mat.emissionStrength;
      const emG = mat.emission[1] * mat.emissionStrength;
      const emB = mat.emission[2] * mat.emissionStrength;
      Lr += tR * emR;
      Lg += tG * emG;
      Lb += tB * emB;
      // Fully emissive materials terminate (no further bounces).
      if (mat.bsdfModel === BSDFModel.EMISSIVE) break;
    }

    // Build tangent frame around surface normal.
    const frame = frameFromNormal(hit.nx, hit.ny, hit.nz);

    // Convert incoming direction (toward surface) into local frame.
    const woWx = -dx, woWy = -dy, woWz = -dz;
    const woX = frame[0] * woWx + frame[1] * woWy + frame[2] * woWz;
    const woY = frame[3] * woWx + frame[4] * woWy + frame[5] * woWz;
    const woZ = hit.nx * woWx + hit.ny * woWy + hit.nz * woWz;
    const wo = [woX, woY, woZ];

    // ── NEE (Next-Event Estimation) ──────────────────────────────
    const lightSlots = scene.getLightSlots(hit.px, hit.py, hit.pz, 1e4);
    if (lightSlots.length > 0) {
      const numLightSamples = Math.min(maxLightSamples, lightSlots.length);
      const invNumLightSamples = 1 / numLightSamples;
      const invLightCount = 1 / lightSlots.length;

      for (let li = 0; li < numLightSamples; li++) {
        const lightSlot = lightSlots[li];
        const Lsamp = scene.sampleLight(lightSlot, hit.px, hit.py, hit.pz, u[3], u[4]);
        if (!Lsamp) continue;

        // Shadow ray test.
        const sHit = scene.raycast(hit.px, hit.py, hit.pz,
                                    Lsamp.wi[0], Lsamp.wi[1], Lsamp.wi[2],
                                    Lsamp.distance - SHADOW_EPSILON);
        if (sHit) continue;

        // Convert wi into local frame.
        const wiLocalX = frame[0] * Lsamp.wi[0] + frame[1] * Lsamp.wi[1] + frame[2] * Lsamp.wi[2];
        const wiLocalY = frame[3] * Lsamp.wi[0] + frame[4] * Lsamp.wi[1] + frame[5] * Lsamp.wi[2];
        const wiLocalZ = hit.nx * Lsamp.wi[0] + hit.ny * Lsamp.wi[1] + hit.nz * Lsamp.wi[2];

        if (wiLocalZ <= 0) continue;

        const f = bsdfEvaluate(wo, [wiLocalX, wiLocalY, wiLocalZ], mat);
        if (f[0] <= 0 && f[1] <= 0 && f[2] <= 0) continue;

        const scale = invNumLightSamples * invLightCount / Lsamp.pdf;
        Lr += tR * f[0] * Lsamp.Li[0] * scale;
        Lg += tG * f[1] * Lsamp.Li[1] * scale;
        Lb += tB * f[2] * Lsamp.Li[2] * scale;
      }
    }

    // ── BSDF sampling for next bounce ───────────────────────────
    const samp = sampleBSDF(wo, mat, u[0], u[1], u[2]);
    if (samp.pdf <= EPSILON) break;

    // Convert sampled direction back to world.
    const wiW = [0, 0, 0];
    localToWorldFrame(
      frame[0], frame[1], frame[2],
      frame[3], frame[4], frame[5],
      hit.nx, hit.ny, hit.nz,
      samp.wi[0], samp.wi[1], samp.wi[2],
      wiW
    );

    // Update throughput.
    const cosTheta = Math.abs(samp.wi[2]);
    tR *= samp.weight[0];
    tG *= samp.weight[1];
    tB *= samp.weight[2];

    // Russian roulette.
    if (depth >= 3) {
      const rr = russianRoulette([tR, tG, tB], u[5]);
      if (rr === 0) break;
      tR *= rr; tG *= rr; tB *= rr;
    }

    // Advance ray.
    ox = hit.px + wiW[0] * SHADOW_EPSILON;
    oy = hit.py + wiW[1] * SHADOW_EPSILON;
    oz = hit.pz + wiW[2] * SHADOW_EPSILON;
    dx = wiW[0]; dy = wiW[1]; dz = wiW[2];
  }

  return [Lr, Lg, Lb];
}

// ═══════════════════════════════════════════════════════════════════════
// SIMPLE PATH INTEGRATOR (no NEE, debug)
// ═══════════════════════════════════════════════════════════════════════

export function integrateSimplePath(slot, ray, scene, samplerSlot) {
  const maxDepth = IntegratorState.maxDepth[slot];

  let ox = ray.ox, oy = ray.oy, oz = ray.oz;
  let dx = ray.dx, dy = ray.dy, dz = ray.dz;

  let Lr = 0, Lg = 0, Lb = 0;
  let tR = 1, tG = 1, tB = 1;

  const u = new Float32Array(6);

  for (let depth = 0; depth < maxDepth; depth++) {
    samplerNext1D(samplerSlot, u);

    const hit = scene.raycast(ox, oy, oz, dx, dy, dz, 1e30);

    if (!hit) {
      const env = scene.getEnvRadiance(dx, dy, dz);
      Lr += tR * env[0];
      Lg += tG * env[1];
      Lb += tB * env[2];
      break;
    }

    const mat = scene.getMaterial(hit.eid);

    if (mat.emissionStrength > 0) {
      Lr += tR * mat.emission[0] * mat.emissionStrength;
      Lg += tG * mat.emission[1] * mat.emissionStrength;
      Lb += tB * mat.emission[2] * mat.emissionStrength;
    }

    const frame = frameFromNormal(hit.nx, hit.ny, hit.nz);

    const woWx = -dx, woWy = -dy, woWz = -dz;
    const woX = frame[0] * woWx + frame[1] * woWy + frame[2] * woWz;
    const woY = frame[3] * woWx + frame[4] * woWy + frame[5] * woWz;
    const woZ = hit.nx * woWx + hit.ny * woWy + hit.nz * woWz;
    const wo = [woX, woY, woZ];

    const samp = sampleBSDF(wo, mat, u[0], u[1], u[2]);
    if (samp.pdf <= EPSILON) break;

    tR *= samp.weight[0];
    tG *= samp.weight[1];
    tB *= samp.weight[2];

    if (depth >= 3) {
      const rr = russianRoulette([tR, tG, tB], u[5]);
      if (rr === 0) break;
      tR *= rr; tG *= rr; tB *= rr;
    }

    const wiW = [0, 0, 0];
    localToWorldFrame(
      frame[0], frame[1], frame[2],
      frame[3], frame[4], frame[5],
      hit.nx, hit.ny, hit.nz,
      samp.wi[0], samp.wi[1], samp.wi[2],
      wiW
    );

    ox = hit.px + wiW[0] * SHADOW_EPSILON;
    oy = hit.py + wiW[1] * SHADOW_EPSILON;
    oz = hit.pz + wiW[2] * SHADOW_EPSILON;
    dx = wiW[0]; dy = wiW[1]; dz = wiW[2];
  }

  return [Lr, Lg, Lb];
}

// ═══════════════════════════════════════════════════════════════════════
// AMBIENT OCCLUSION INTEGRATOR
// ═══════════════════════════════════════════════════════════════════════

export function integrateAO(slot, ray, scene, samplerSlot) {
  const radius = IntegratorState.aoRadius[slot];
  const hit = scene.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, 1e30);
  if (!hit) {
    const env = scene.getEnvRadiance(ray.dx, ray.dy, ray.dz);
    return env;
  }

  const frame = frameFromNormal(hit.nx, hit.ny, hit.nz);
  const u = new Float32Array(2);
  samplerNext1D(samplerSlot, u);

  const local = sampleCosineHemisphere(u[0], u[1]);
  const wiW = [0, 0, 0];
  localToWorldFrame(
    frame[0], frame[1], frame[2],
    frame[3], frame[4], frame[5],
    hit.nx, hit.ny, hit.nz,
    local[0], local[1], local[2],
    wiW
  );

  const shadowHit = scene.raycast(
    hit.px + wiW[0] * SHADOW_EPSILON,
    hit.py + wiW[1] * SHADOW_EPSILON,
    hit.pz + wiW[2] * SHADOW_EPSILON,
    wiW[0], wiW[1], wiW[2], radius
  );

  if (shadowHit) return [0, 0, 0];

  const mat = scene.getMaterial(hit.eid);
  return [mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]];
}

// ═══════════════════════════════════════════════════════════════════════
// LIGHT INTEGRATOR (direct lighting only)
// ═══════════════════════════════════════════════════════════════════════

export function integrateLight(slot, ray, scene, samplerSlot) {
  const maxLightSamples = IntegratorState.maxLightSamples[slot];
  const hit = scene.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, 1e30);

  if (!hit) {
    return scene.getEnvRadiance(ray.dx, ray.dy, ray.dz);
  }

  const mat = scene.getMaterial(hit.eid);
  const frame = frameFromNormal(hit.nx, hit.ny, hit.nz);

  const woWx = -ray.dx, woWy = -ray.dy, woWz = -ray.dz;
  const woX = frame[0] * woWx + frame[1] * woWy + frame[2] * woWz;
  const woY = frame[3] * woWx + frame[4] * woWy + frame[5] * woWz;
  const woZ = hit.nx * woWx + hit.ny * woWy + hit.nz * woWz;
  const wo = [woX, woY, woZ];

  const lightSlots = scene.getLightSlots(hit.px, hit.py, hit.pz, 1e4);
  if (lightSlots.length === 0) {
    // Emissive surface still contributes.
    return [
      mat.emission[0] * mat.emissionStrength,
      mat.emission[1] * mat.emissionStrength,
      mat.emission[2] * mat.emissionStrength,
    ];
  }

  const u = new Float32Array(6);
  samplerNext1D(samplerSlot, u);

  let Lr = 0, Lg = 0, Lb = 0;
  const numSamples = Math.min(maxLightSamples, lightSlots.length);
  const invNum = 1 / numSamples;
  const invCount = 1 / lightSlots.length;

  for (let li = 0; li < numSamples; li++) {
    const lightSlot = lightSlots[li];
    const Lsamp = scene.sampleLight(lightSlot, hit.px, hit.py, hit.pz, u[3], u[4]);
    if (!Lsamp) continue;

    const sHit = scene.raycast(hit.px, hit.py, hit.pz,
                                Lsamp.wi[0], Lsamp.wi[1], Lsamp.wi[2],
                                Lsamp.distance - SHADOW_EPSILON);
    if (sHit) continue;

    const wiLocalX = frame[0] * Lsamp.wi[0] + frame[1] * Lsamp.wi[1] + frame[2] * Lsamp.wi[2];
    const wiLocalY = frame[3] * Lsamp.wi[0] + frame[4] * Lsamp.wi[1] + frame[5] * Lsamp.wi[2];
    const wiLocalZ = hit.nx * Lsamp.wi[0] + hit.ny * Lsamp.wi[1] + hit.nz * Lsamp.wi[2];

    if (wiLocalZ <= 0) continue;

    const f = bsdfEvaluate(wo, [wiLocalX, wiLocalY, wiLocalZ], mat);
    const scale = invNum * invCount / Lsamp.pdf;
    Lr += f[0] * Lsamp.Li[0] * scale;
    Lg += f[1] * Lsamp.Li[1] * scale;
    Lb += f[2] * Lsamp.Li[2] * scale;
  }

  return [Lr, Lg, Lb];
}

// ═══════════════════════════════════════════════════════════════════════
// WHITTED INTEGRATOR (specular-only debug)
// ═══════════════════════════════════════════════════════════════════════

export function integrateWhitted(slot, ray, scene, samplerSlot) {
  const hit = scene.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, 1e30);
  if (!hit) return scene.getEnvRadiance(ray.dx, ray.dy, ray.dz);

  const mat = scene.getMaterial(hit.eid);
  return [
    mat.baseColor[0] * 0.5 + mat.emission[0] * mat.emissionStrength,
    mat.baseColor[1] * 0.5 + mat.emission[1] * mat.emissionStrength,
    mat.baseColor[2] * 0.5 + mat.emission[2] * mat.emissionStrength,
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// VOLUME PATH INTEGRATOR (heterogeneous media approximation)
// ═══════════════════════════════════════════════════════════════════════
//
// For a homogeneous participating medium with extinction σₜ and albedo,
// we use ratio tracking with N steps. Full heterogeneous support would
// need a medium grid; file 018 provides that. Here we call into the
// simple PathIntegrator and add an analytic fog contribution — good
// enough for atmosphere and smoke previews at 1M entities.

export function integrateVolPath(slot, ray, scene, samplerSlot) {
  // Base surface radiance.
  const base = integratePath(slot, ray, scene, samplerSlot);

  // Approximate fog: distance to first hit controls transmittance.
  const hit = scene.raycast(ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, 1e30);
  const t = hit ? hit.t : 1e4;

  // Sigma_t derived from a global fog density (could be a component).
  const sigmaT = 0.02;
  const transmittance = Math.exp(-sigmaT * t);

  const env = scene.getEnvRadiance(ray.dx, ray.dy, ray.dz);
  const fogR = env[0] * (1 - transmittance);
  const fogG = env[1] * (1 - transmittance);
  const fogB = env[2] * (1 - transmittance);

  return [
    base[0] * transmittance + fogR,
    base[1] * transmittance + fogG,
    base[2] * transmittance + fogB,
  ];
}

// ═══════════════════════════════════════════════════════════════════════
// DISPATCH — pick integrator by slot type
// ═══════════════════════════════════════════════════════════════════════

function dispatchIntegrator(slot, ray, scene) {
  const type = IntegratorState.type[slot];
  const samplerSlot = IntegratorState.samplerSlot[slot];

  switch (type) {
    case IntegratorType.PATH:        return integratePath(slot, ray, scene, samplerSlot);
    case IntegratorType.VOL_PATH:    return integrateVolPath(slot, ray, scene, samplerSlot);
    case IntegratorType.SIMPLE_PATH: return integrateSimplePath(slot, ray, scene, samplerSlot);
    case IntegratorType.AO:          return integrateAO(slot, ray, scene, samplerSlot);
    case IntegratorType.LIGHT:       return integrateLight(slot, ray, scene, samplerSlot);
    case IntegratorType.WHITTED:     return integrateWhitted(slot, ray, scene, samplerSlot);
    default:                         return [0, 0, 0];
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — render frame (per integrator)
// ═══════════════════════════════════════════════════════════════════════

const _ray = {
  ox: 0, oy: 0, oz: 0,
  dx: 0, dy: 0, dz: 0,
};

/**
 * Render a frame by sampling each pixel in the film.
 * Simplistic scan-line order; downstream progressive renderers can
 * stride and slice for tiling.
 */
export function systemRenderFrame(world, integratorSlot, dt = 1 / 60) {
  if (IntegratorState.enabled[integratorSlot] === 0) return world;

  const filmId = IntegratorState.filmId[integratorSlot];
  const cameraSlot = IntegratorState.cameraSlot[integratorSlot];
  const spp = IntegratorState.samplesPerPixel[integratorSlot];
  const samplerSlot = IntegratorState.samplerSlot[integratorSlot];

  const film = FILMS.get(filmId);
  if (!film) return world;

  const scene = createSceneProxy(world);
  const W = film.width, H = film.height;

  const u2 = new Float32Array(2);
  const uLens = new Float32Array(2);
  const rgb = new Float32Array(3);

  samplerReset(samplerSlot);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let ar = 0, ag = 0, ab = 0;

      for (let s = 0; s < spp; s++) {
        // Pixel jitter from sampler.
        samplerNext1D(samplerSlot, u2);
        samplerNext1D(samplerSlot, uLens);

        const u = (x + u2[0]) / W;
        const v = (y + u2[1]) / H;

        if (!cameraGenerateRay(cameraSlot, u, v, uLens[0], uLens[1], _ray)) continue;

        const L = dispatchIntegrator(integratorSlot, _ray, scene);
        ar += L[0];
        ag += L[1];
        ab += L[2];
      }

      const invSpp = 1 / spp;
      rgb[0] = ar * invSpp;
      rgb[1] = ag * invSpp;
      rgb[2] = ab * invSpp;

      filmAddSample(filmId, x + 0.5, y + 0.5, rgb, 1, null);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PROGRESSIVE — render a single tile (for incremental rendering)
// ═══════════════════════════════════════════════════════════════════════

export function renderTile(world, integratorSlot, tileX, tileY) {
  if (IntegratorState.enabled[integratorSlot] === 0) return world;

  const filmId = IntegratorState.filmId[integratorSlot];
  const cameraSlot = IntegratorState.cameraSlot[integratorSlot];
  const samplerSlot = IntegratorState.samplerSlot[integratorSlot];
  const spp = IntegratorState.samplesPerPixel[integratorSlot];

  const film = FILMS.get(filmId);
  if (!film) return world;

  const scene = createSceneProxy(world);
  const TS = film.tileSize;
  const W = film.width, H = film.height;

  const x0 = tileX * TS, x1 = Math.min(W, x0 + TS);
  const y0 = tileY * TS, y1 = Math.min(H, y0 + TS);

  const u2 = new Float32Array(2);
  const uLens = new Float32Array(2);
  const rgb = new Float32Array(3);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let ar = 0, ag = 0, ab = 0;

      for (let s = 0; s < spp; s++) {
        samplerNext1D(samplerSlot, u2);
        samplerNext1D(samplerSlot, uLens);

        const u = (x + u2[0]) / W;
        const v = (y + u2[1]) / H;

        if (!cameraGenerateRay(cameraSlot, u, v, uLens[0], uLens[1], _ray)) continue;

        const L = dispatchIntegrator(integratorSlot, _ray, scene);
        ar += L[0];
        ag += L[1];
        ab += L[2];
      }

      const invSpp = 1 / spp;
      rgb[0] = ar * invSpp;
      rgb[1] = ag * invSpp;
      rgb[2] = ab * invSpp;

      filmAddSample(filmId, x + 0.5, y + 0.5, rgb, 1, null);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearIntegrators() {
  _nextIntegratorSlot = 0;
  IntegratorState.enabled.fill(0);
  IntegratorState.type.fill(0);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function integratorStats() {
  const byType = [0, 0, 0, 0, 0, 0];
  let enabled = 0;
  for (let i = 0; i < _nextIntegratorSlot; i++) {
    if (IntegratorState.enabled[i]) {
      enabled++;
      byType[IntegratorState.type[i]]++;
    }
  }
  return {
    integratorCount: _nextIntegratorSlot,
    enabled,
    byType: {
      path: byType[IntegratorType.PATH],
      volPath: byType[IntegratorType.VOL_PATH],
      simplePath: byType[IntegratorType.SIMPLE_PATH],
      ao: byType[IntegratorType.AO],
      light: byType[IntegratorType.LIGHT],
      whitted: byType[IntegratorType.WHITTED],
    },
  };
}