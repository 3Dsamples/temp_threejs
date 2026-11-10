// file number : 016
// full path name : src/ecs/016_Components.js
// description : Component library, metadata registry, and material presets built on 015_World.js. Provides typed component schemas (SoA-friendly), default-value factories, material preset catalogs (PBR, Anime, Semi-Realistic, Custom Shader, Physics Material), prefab archetypes (player, camera, light, prop, terrain chunk, AI agent, projectile, particle), fast spawn helpers using presets, component validation, and preset registries. All presets align with Three.js r185 material parameters and are exposed as frozen objects for zero-allocation reuse.
// best for : Rapid entity authoring at 10k+ scale, consistent material configuration across PBR/Anime/Semi-Realistic scenes, prefab-based spawn pipelines, ECS archetype management, and low-GC component composition on Android 64-bit.
// license : MIT

import * as World from './015_World.js';
import * as bitecs from './014_BitECS.js';
import {
  PBR, ANIME, PHYSICS, RENDER, CONTEXT
} from '../core/002_Constants.js';

// ============================================================================
// MATERIAL PRESETS (Three.js r185 aligned, frozen)
// ============================================================================

export const MaterialPresets = Object.freeze({
  PBR_DEFAULT: Object.freeze({
    baseColor: Object.freeze([1, 1, 1]),
    metalness: PBR.METALNESS_DEFAULT,
    roughness: PBR.ROUGHNESS_DEFAULT,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: PBR.EMISSIVE_INTENSITY_DEFAULT,
    opacity: 1,
    alphaTest: PBR.ALPHA_TEST_DEFAULT,
    clearcoat: PBR.CLEARCOAT_DEFAULT,
    clearcoatRoughness: PBR.CLEARCOAT_ROUGHNESS_DEFAULT,
    sheen: PBR.SHEEN_DEFAULT,
    sheenRoughness: PBR.SHEEN_ROUGHNESS_DEFAULT,
    transmission: PBR.TRANSMISSION_DEFAULT,
    thickness: PBR.THICKNESS_DEFAULT,
    ior: PBR.IOR_DEFAULT,
    iridescence: PBR.IRIDESCENCE_DEFAULT,
    anisotropy: PBR.ANISOTROPY_DEFAULT,
    aoIntensity: PBR.AO_INTENSITY_DEFAULT,
    envMapIntensity: PBR.ENV_MAP_INTENSITY_DEFAULT,
    normalScale: PBR.NORMAL_SCALE_DEFAULT[0],
    displacementScale: PBR.DISPLACEMENT_SCALE_DEFAULT,
    flatShading: PBR.FLAT_SHADING_DEFAULT,
    wireframe: PBR.WIREFRAME_DEFAULT,
    side: PBR.SIDE.FRONT,
    toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
    renderStyle: 0
  }),

  PBR_METAL: Object.freeze({
    baseColor: Object.freeze([0.9, 0.9, 0.92]),
    metalness: 1.0,
    roughness: 0.25,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: 1,
    opacity: 1,
    alphaTest: 0,
    clearcoat: 0.0,
    clearcoatRoughness: 0.0,
    sheen: 0,
    sheenRoughness: 1,
    transmission: 0,
    thickness: 0,
    ior: PBR.IOR_DEFAULT,
    iridescence: 0,
    anisotropy: 0.3,
    aoIntensity: 1,
    envMapIntensity: 1.2,
    normalScale: 1,
    displacementScale: 1,
    flatShading: false,
    wireframe: false,
    side: PBR.SIDE.FRONT,
    toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
    renderStyle: 0
  }),

  PBR_PLASTIC: Object.freeze({
    baseColor: Object.freeze([0.85, 0.15, 0.15]),
    metalness: 0.0,
    roughness: 0.5,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: 1,
    opacity: 1,
    alphaTest: 0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.1,
    sheen: 0,
    sheenRoughness: 1,
    transmission: 0,
    thickness: 0,
    ior: PBR.IOR_DEFAULT,
    iridescence: 0,
    anisotropy: 0,
    aoIntensity: 1,
    envMapIntensity: 1,
    normalScale: 1,
    displacementScale: 1,
    flatShading: false,
    wireframe: false,
    side: PBR.SIDE.FRONT,
    toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
    renderStyle: 0
  }),

  PBR_GLASS: Object.freeze({
    baseColor: Object.freeze([1, 1, 1]),
    metalness: 0.0,
    roughness: 0.05,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: 1,
    opacity: 0.3,
    alphaTest: 0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.0,
    sheen: 0,
    sheenRoughness: 1,
    transmission: 1.0,
    thickness: 0.5,
    ior: 1.52,
    iridescence: 0,
    anisotropy: 0,
    aoIntensity: 1,
    envMapIntensity: 1.5,
    normalScale: 1,
    displacementScale: 1,
    flatShading: false,
    wireframe: false,
    side: PBR.SIDE.DOUBLE,
    toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
    renderStyle: 0
  }),

  PBR_EMISSIVE: Object.freeze({
    baseColor: Object.freeze([0, 0, 0]),
    metalness: 0.0,
    roughness: 1.0,
    emissive: Object.freeze([1, 0.6, 0.1]),
    emissiveIntensity: 4.0,
    opacity: 1,
    alphaTest: 0,
    clearcoat: 0,
    clearcoatRoughness: 0,
    sheen: 0,
    sheenRoughness: 1,
    transmission: 0,
    thickness: 0,
    ior: PBR.IOR_DEFAULT,
    iridescence: 0,
    anisotropy: 0,
    aoIntensity: 1,
    envMapIntensity: 0,
    normalScale: 1,
    displacementScale: 1,
    flatShading: false,
    wireframe: false,
    side: PBR.SIDE.FRONT,
    toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
    renderStyle: 0
  }),

  PBR_SKIN: Object.freeze({
    baseColor: Object.freeze([0.95, 0.75, 0.65]),
    metalness: 0.0,
    roughness: 0.55,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: 1,
    opacity: 1,
    alphaTest: 0,
    clearcoat: 0.1,
    clearcoatRoughness: 0.6,
    sheen: 0.2,
    sheenRoughness: 0.5,
    transmission: 0.0,
    thickness: 0,
    ior: PBR.IOR_DEFAULT,
    iridescence: 0,
    anisotropy: 0,
    aoIntensity: 1,
    envMapIntensity: 1,
    normalScale: 1,
    displacementScale: 1,
    flatShading: false,
    wireframe: false,
    side: PBR.SIDE.FRONT,
    toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
    renderStyle: 0
  }),

  ANIME_FLAT: Object.freeze({
    baseColor: Object.freeze([0.9, 0.85, 0.75]),
    metalness: 0.0,
    roughness: 0.9,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: ANIME.EMISSION_INTENSITY_DEFAULT,
    opacity: 1,
    alphaTest: 0,
    clearcoat: 0,
    clearcoatRoughness: 0,
    sheen: 0,
    sheenRoughness: 1,
    transmission: 0,
    thickness: 0,
    ior: 1.0,
    iridescence: 0,
    anisotropy: 0,
    aoIntensity: 0,
    envMapIntensity: 0,
    normalScale: 1,
    displacementScale: 1,
    flatShading: true,
    wireframe: false,
    side: PBR.SIDE.FRONT,
    toneMapping: RENDER.TONE_MAPPING.NONE,
    renderStyle: 1
  }),

  ANIME_OUTLINED: Object.freeze({
    baseColor: Object.freeze([0.85, 0.55, 0.35]),
    metalness: 0.0,
    roughness: 1.0,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: 0,
    opacity: 1,
    alphaTest: 0.01,
    clearcoat: 0,
    clearcoatRoughness: 0,
    sheen: 0,
    sheenRoughness: 1,
    transmission: 0,
    thickness: 0,
    ior: 1.0,
    iridescence: 0,
    anisotropy: 0,
    aoIntensity: 0,
    envMapIntensity: 0,
    normalScale: 1,
    displacementScale: 1,
    flatShading: true,
    wireframe: false,
    side: PBR.SIDE.FRONT,
    toneMapping: RENDER.TONE_MAPPING.NONE,
    renderStyle: 2
  }),

  SEMI_REALISTIC: Object.freeze({
    baseColor: Object.freeze([0.8, 0.75, 0.7]),
    metalness: 0.05,
    roughness: 0.6,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: 1,
    opacity: 1,
    alphaTest: 0,
    clearcoat: 0.15,
    clearcoatRoughness: 0.4,
    sheen: 0.1,
    sheenRoughness: 0.7,
    transmission: 0,
    thickness: 0,
    ior: 1.45,
    iridescence: 0,
    anisotropy: 0,
    aoIntensity: 0.6,
    envMapIntensity: 0.8,
    normalScale: 1,
    displacementScale: 1,
    flatShading: false,
    wireframe: false,
    side: PBR.SIDE.FRONT,
    toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
    renderStyle: 3
  }),

  SEMI_REALISTIC_TOON: Object.freeze({
    baseColor: Object.freeze([0.7, 0.7, 0.75]),
    metalness: 0.0,
    roughness: 0.7,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: 1,
    opacity: 1,
    alphaTest: 0,
    clearcoat: 0.2,
    clearcoatRoughness: 0.5,
    sheen: 0.3,
    sheenRoughness: 0.6,
    transmission: 0,
    thickness: 0,
    ior: 1.4,
    iridescence: 0,
    anisotropy: 0,
    aoIntensity: 0.5,
    envMapIntensity: 0.7,
    normalScale: 1,
    displacementScale: 1,
    flatShading: false,
    wireframe: false,
    side: PBR.SIDE.FRONT,
    toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
    renderStyle: 4
  }),

  PHYSICS_METAL: Object.freeze({
    baseColor: Object.freeze([0.55, 0.55, 0.6]),
    metalness: 0.9,
    roughness: 0.35,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: 1,
    opacity: 1,
    alphaTest: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.3,
    sheen: 0,
    sheenRoughness: 1,
    transmission: 0,
    thickness: 0,
    ior: PBR.IOR_DEFAULT,
    iridescence: 0.2,
    anisotropy: 0.4,
    aoIntensity: 1,
    envMapIntensity: 1.3,
    normalScale: 1,
    displacementScale: 1,
    flatShading: false,
    wireframe: false,
    side: PBR.SIDE.FRONT,
    toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
    renderStyle: 0
  }),

  PHYSICS_RUBBER: Object.freeze({
    baseColor: Object.freeze([0.15, 0.15, 0.15]),
    metalness: 0.0,
    roughness: 0.95,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: 1,
    opacity: 1,
    alphaTest: 0,
    clearcoat: 0,
    clearcoatRoughness: 0,
    sheen: 0.15,
    sheenRoughness: 0.9,
    transmission: 0,
    thickness: 0,
    ior: 1.5,
    iridescence: 0,
    anisotropy: 0,
    aoIntensity: 0.8,
    envMapIntensity: 0.5,
    normalScale: 1,
    displacementScale: 1,
    flatShading: false,
    wireframe: false,
    side: PBR.SIDE.FRONT,
    toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
    renderStyle: 0
  }),

  CUSTOM_SHADER: Object.freeze({
    baseColor: Object.freeze([1, 1, 1]),
    metalness: 0,
    roughness: 1,
    emissive: Object.freeze([0, 0, 0]),
    emissiveIntensity: 1,
    opacity: 1,
    alphaTest: 0,
    clearcoat: 0,
    clearcoatRoughness: 0,
    sheen: 0,
    sheenRoughness: 1,
    transmission: 0,
    thickness: 0,
    ior: 1.0,
    iridescence: 0,
    anisotropy: 0,
    aoIntensity: 1,
    envMapIntensity: 1,
    normalScale: 1,
    displacementScale: 1,
    flatShading: false,
    wireframe: false,
    side: PBR.SIDE.DOUBLE,
    toneMapping: RENDER.TONE_MAPPING.NONE,
    renderStyle: 5
  })
});

// ============================================================================
// MATERIAL PRESET REGISTRY
// ============================================================================

const _presetRegistry = new Map();

export function registerMaterialPreset(name, preset) {
  if (typeof name !== 'string' || !preset) return false;
  _presetRegistry.set(name, Object.freeze(preset));
  return true;
}

export function getMaterialPreset(name) {
  return _presetRegistry.get(name) || null;
}

export function hasMaterialPreset(name) {
  return _presetRegistry.has(name);
}

export function listMaterialPresets() {
  return Array.from(_presetRegistry.keys());
}

for (const key of Object.keys(MaterialPresets)) {
  _presetRegistry.set(key, MaterialPresets[key]);
}

// ============================================================================
// PREFAB ARCHETYPES
// ============================================================================

export const Prefabs = Object.freeze({
  PLAYER: 'player',
  CAMERA: 'camera',
  DIRECTIONAL_LIGHT: 'directionalLight',
  POINT_LIGHT: 'pointLight',
  SPOT_LIGHT: 'spotLight',
  PROP_STATIC: 'propStatic',
  PROP_DYNAMIC: 'propDynamic',
  AI_AGENT: 'aiAgent',
  PROJECTILE: 'projectile',
  PARTICLE: 'particle',
  TERRAIN_CHUNK: 'terrainChunk',
  TRIGGER_ZONE: 'triggerZone'
});

export function buildPlayerPrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 0, py: 1.7, pz: 0, rw: 1 },
    velocity: opts.velocity || { vx: 0, vy: 0, vz: 0 },
    rigidBody: opts.rigidBody || {
      mass: 70,
      restitution: PHYSICS.RESTITUTION_DEFAULT,
      friction: PHYSICS.FRICTION_DEFAULT,
      bodyType: PHYSICS.BODY_TYPE.DYNAMIC
    },
    collider: opts.collider || {
      shape: PHYSICS.SHAPE.CAPSULE,
      radius: 0.3,
      hy: 0.85,
      layer: PHYSICS.COLLISION_FLAGS.PLAYER,
      mask: PHYSICS.COLLISION_FLAGS.ALL
    },
    renderable: true,
    meshId: opts.meshId !== undefined ? opts.meshId : 0,
    materialId: opts.materialId !== undefined ? opts.materialId : 0,
    material: opts.material || MaterialPresets.SEMI_REALISTIC,
    health: opts.health || { current: 100, max: 100 },
    animation: opts.animation || { clipId: 0, speed: 1, loop: true },
    player: true,
    dynamic: true
  };
}

export function buildCameraPrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 0, py: 1.7, pz: 0, rw: 1 },
    camera: opts.camera || {
      fov: RENDER.DEFAULT_FOV,
      near: RENDER.NEAR,
      far: RENDER.FAR,
      aspect: 1,
      exposure: RENDER.EXPOSURE_DEFAULT,
      toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
      isMain: true
    }
  };
}

export function buildDirectionalLightPrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 50, py: 100, pz: 50, rw: 1 },
    light: opts.light || {
      type: 0,
      colorR: 1,
      colorG: 0.98,
      colorB: 0.95,
      intensity: 1.5,
      castShadow: true
    }
  };
}

export function buildPointLightPrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 0, py: 3, pz: 0, rw: 1 },
    light: opts.light || {
      type: 1,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1,
      range: 12,
      castShadow: false
    }
  };
}

export function buildSpotLightPrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 0, py: 5, pz: 0, rw: 1 },
    light: opts.light || {
      type: 2,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 2,
      range: 15,
      innerCone: 0.3,
      outerCone: 0.6,
      castShadow: true
    }
  };
}

export function buildStaticPropPrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 0, py: 0, pz: 0, rw: 1 },
    rigidBody: opts.rigidBody || {
      mass: 0,
      bodyType: PHYSICS.BODY_TYPE.STATIC
    },
    collider: opts.collider || {
      shape: PHYSICS.SHAPE.BOX,
      hx: 0.5,
      hy: 0.5,
      hz: 0.5,
      layer: PHYSICS.COLLISION_FLAGS.DEFAULT,
      mask: PHYSICS.COLLISION_FLAGS.ALL
    },
    renderable: true,
    meshId: opts.meshId !== undefined ? opts.meshId : 0,
    materialId: opts.materialId !== undefined ? opts.materialId : 0,
    material: opts.material || MaterialPresets.PBR_DEFAULT,
    static: true
  };
}

export function buildDynamicPropPrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 0, py: 1, pz: 0, rw: 1 },
    velocity: opts.velocity || { vx: 0, vy: 0, vz: 0 },
    rigidBody: opts.rigidBody || {
      mass: 5,
      restitution: PHYSICS.RESTITUTION_DEFAULT,
      friction: PHYSICS.FRICTION_DEFAULT,
      bodyType: PHYSICS.BODY_TYPE.DYNAMIC
    },
    collider: opts.collider || {
      shape: PHYSICS.SHAPE.BOX,
      hx: 0.25,
      hy: 0.25,
      hz: 0.25,
      layer: PHYSICS.COLLISION_FLAGS.DEFAULT,
      mask: PHYSICS.COLLISION_FLAGS.ALL
    },
    renderable: true,
    meshId: opts.meshId !== undefined ? opts.meshId : 0,
    materialId: opts.materialId !== undefined ? opts.materialId : 0,
    material: opts.material || MaterialPresets.PBR_METAL,
    dynamic: true
  };
}

export function buildAIAgentPrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 0, py: 0, pz: 0, rw: 1 },
    velocity: opts.velocity || { vx: 0, vy: 0, vz: 0 },
    rigidBody: opts.rigidBody || {
      mass: 60,
      restitution: PHYSICS.RESTITUTION_DEFAULT,
      friction: PHYSICS.FRICTION_DEFAULT,
      bodyType: PHYSICS.BODY_TYPE.DYNAMIC
    },
    collider: opts.collider || {
      shape: PHYSICS.SHAPE.CAPSULE,
      radius: 0.35,
      hy: 0.9,
      layer: PHYSICS.COLLISION_FLAGS.ENEMY,
      mask: PHYSICS.COLLISION_FLAGS.ALL
    },
    renderable: true,
    meshId: opts.meshId !== undefined ? opts.meshId : 0,
    materialId: opts.materialId !== undefined ? opts.materialId : 0,
    material: opts.material || MaterialPresets.SEMI_REALISTIC,
    health: opts.health || { current: 50, max: 50 },
    ai: opts.ai || { speed: 3, awarenessSq: CONTEXT.AWARENESS_RADIUS * CONTEXT.AWARENESS_RADIUS },
    animation: opts.animation || { clipId: 0, speed: 1, loop: true },
    dynamic: true
  };
}

export function buildProjectilePrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 0, py: 0, pz: 0, rw: 1 },
    velocity: opts.velocity || { vx: 0, vy: 0, vz: -25 },
    rigidBody: opts.rigidBody || {
      mass: 0.5,
      restitution: 0.1,
      friction: 0.05,
      bodyType: PHYSICS.BODY_TYPE.DYNAMIC
    },
    collider: opts.collider || {
      shape: PHYSICS.SHAPE.SPHERE,
      radius: 0.08,
      layer: PHYSICS.COLLISION_FLAGS.PROJECTILE,
      mask: PHYSICS.COLLISION_FLAGS.DEFAULT | PHYSICS.COLLISION_FLAGS.ENEMY
    },
    renderable: true,
    meshId: opts.meshId !== undefined ? opts.meshId : 0,
    materialId: opts.materialId !== undefined ? opts.materialId : 0,
    material: opts.material || MaterialPresets.PBR_EMISSIVE,
    dynamic: true
  };
}

export function buildParticlePrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 0, py: 0, pz: 0, rw: 1 },
    velocity: opts.velocity || { vx: 0, vy: 0.5, vz: 0 },
    renderable: true,
    meshId: opts.meshId !== undefined ? opts.meshId : 0,
    materialId: opts.materialId !== undefined ? opts.materialId : 0,
    material: opts.material || MaterialPresets.PBR_EMISSIVE,
    dynamic: true
  };
}

export function buildTerrainChunkPrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 0, py: 0, pz: 0, rw: 1 },
    rigidBody: opts.rigidBody || {
      mass: 0,
      bodyType: PHYSICS.BODY_TYPE.STATIC
    },
    collider: opts.collider || {
      shape: PHYSICS.SHAPE.HEIGHTFIELD,
      hx: 500,
      hy: 100,
      hz: 500,
      layer: PHYSICS.COLLISION_FLAGS.DEFAULT,
      mask: PHYSICS.COLLISION_FLAGS.ALL
    },
    renderable: true,
    meshId: opts.meshId !== undefined ? opts.meshId : 0,
    materialId: opts.materialId !== undefined ? opts.materialId : 0,
    material: opts.material || MaterialPresets.PBR_DEFAULT,
    static: true
  };
}

export function buildTriggerZonePrefab(opts = {}) {
  return {
    transform: opts.transform || { px: 0, py: 0, pz: 0, rw: 1 },
    collider: opts.collider || {
      shape: PHYSICS.SHAPE.BOX,
      hx: 2,
      hy: 2,
      hz: 2,
      layer: PHYSICS.COLLISION_FLAGS.TRIGGER,
      mask: PHYSICS.COLLISION_FLAGS.PLAYER | PHYSICS.COLLISION_FLAGS.ENEMY
    },
    static: true
  };
}

// ============================================================================
// PREFAB REGISTRY
// ============================================================================

const _prefabRegistry = new Map();

export function registerPrefab(name, builder) {
  if (typeof name !== 'string' || typeof builder !== 'function') return false;
  _prefabRegistry.set(name, builder);
  return true;
}

export function hasPrefab(name) {
  return _prefabRegistry.has(name);
}

export function listPrefabs() {
  return Array.from(_prefabRegistry.keys());
}

_prefabRegistry.set(Prefabs.PLAYER, buildPlayerPrefab);
_prefabRegistry.set(Prefabs.CAMERA, buildCameraPrefab);
_prefabRegistry.set(Prefabs.DIRECTIONAL_LIGHT, buildDirectionalLightPrefab);
_prefabRegistry.set(Prefabs.POINT_LIGHT, buildPointLightPrefab);
_prefabRegistry.set(Prefabs.SPOT_LIGHT, buildSpotLightPrefab);
_prefabRegistry.set(Prefabs.PROP_STATIC, buildStaticPropPrefab);
_prefabRegistry.set(Prefabs.PROP_DYNAMIC, buildDynamicPropPrefab);
_prefabRegistry.set(Prefabs.AI_AGENT, buildAIAgentPrefab);
_prefabRegistry.set(Prefabs.PROJECTILE, buildProjectilePrefab);
_prefabRegistry.set(Prefabs.PARTICLE, buildParticlePrefab);
_prefabRegistry.set(Prefabs.TERRAIN_CHUNK, buildTerrainChunkPrefab);
_prefabRegistry.set(Prefabs.TRIGGER_ZONE, buildTriggerZonePrefab);

// ============================================================================
// SPAWN FROM PREFAB
// ============================================================================

export function spawnPrefab(world, name, overrides = {}) {
  const builder = _prefabRegistry.get(name);
  if (!builder) throw new Error('Unknown prefab: ' + name);
  const opts = builder(overrides);
  return World.spawnEntity(world, opts);
}

export function spawnPrefabMany(world, name, count, overridesFn) {
  const builder = _prefabRegistry.get(name);
  if (!builder) throw new Error('Unknown prefab: ' + name);
  const ids = new Array(count);
  for (let i = 0; i < count; i++) {
    const overrides = overridesFn ? overridesFn(i) : {};
    ids[i] = World.spawnEntity(world, builder(overrides));
  }
  return ids;
}

// ============================================================================
// COMPONENT METADATA
// ============================================================================

export const ComponentMeta = Object.freeze({
  Transform: Object.freeze({
    name: 'Transform',
    fields: ['px', 'py', 'pz', 'rx', 'ry', 'rz', 'rw', 'sx', 'sy', 'sz'],
    category: 'core',
    serialize: true
  }),
  Velocity: Object.freeze({
    name: 'Velocity',
    fields: ['vx', 'vy', 'vz', 'ax', 'ay', 'az'],
    category: 'physics',
    serialize: true
  }),
  RigidBody: Object.freeze({
    name: 'RigidBody',
    fields: ['mass', 'invMass', 'restitution', 'friction', 'linearDamping', 'angularDamping', 'bodyType', 'sleeping'],
    category: 'physics',
    serialize: true
  }),
  Collider: Object.freeze({
    name: 'Collider',
    fields: ['shape', 'radius', 'hx', 'hy', 'hz', 'layer', 'mask'],
    category: 'physics',
    serialize: true
  }),
  Renderable: Object.freeze({
    name: 'Renderable',
    fields: [],
    category: 'render',
    serialize: true
  }),
  Material: Object.freeze({
    name: 'Material',
    fields: [
      'baseColorR', 'baseColorG', 'baseColorB',
      'metalness', 'roughness',
      'emissiveR', 'emissiveG', 'emissiveB', 'emissiveIntensity',
      'opacity', 'alphaTest',
      'clearcoat', 'clearcoatRoughness',
      'sheen', 'sheenRoughness',
      'transmission', 'thickness', 'ior',
      'iridescence', 'anisotropy',
      'aoIntensity', 'envMapIntensity',
      'normalScale', 'displacementScale',
      'flatShading', 'wireframe', 'side',
      'toneMapping', 'renderStyle'
    ],
    category: 'render',
    serialize: true
  }),
  Camera: Object.freeze({
    name: 'Camera',
    fields: ['fov', 'near', 'far', 'aspect', 'exposure', 'toneMapping', 'isMain'],
    category: 'render',
    serialize: true
  }),
  Light: Object.freeze({
    name: 'Light',
    fields: ['type', 'colorR', 'colorG', 'colorB', 'intensity', 'range', 'innerCone', 'outerCone', 'castShadow'],
    category: 'render',
    serialize: true
  }),
  Health: Object.freeze({
    name: 'Health',
    fields: ['current', 'max'],
    category: 'gameplay',
    serialize: true
  }),
  AI: Object.freeze({
    name: 'AI',
    fields: ['state', 'target', 'speed', 'awarenessSq', 'timer'],
    category: 'gameplay',
    serialize: true
  }),
  Animation: Object.freeze({
    name: 'Animation',
    fields: ['clipId', 'time', 'speed', 'weight', 'loop'],
    category: 'animation',
    serialize: true
  })
});

// ============================================================================
// COMPONENT LOOKUP TABLE
// ============================================================================

const _componentTable = new Map();

export function registerComponentMeta(key, meta) {
  if (typeof key !== 'string' || !meta) return false;
  _componentTable.set(key, meta);
  return true;
}

export function getComponentMeta(key) {
  return _componentTable.get(key) || null;
}

export function listComponentMeta() {
  return Array.from(_componentTable.keys());
}

for (const key of Object.keys(ComponentMeta)) {
  _componentTable.set(key, ComponentMeta[key]);
}

// ============================================================================
// COMPONENT FACTORIES
// ============================================================================

export function defaultTransform() {
  return {
    px: 0, py: 0, pz: 0,
    rx: 0, ry: 0, rz: 0, rw: 1,
    sx: 1, sy: 1, sz: 1
  };
}

export function defaultVelocity() {
  return { vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0 };
}

export function defaultRigidBody(mass = 1) {
  return {
    mass,
    invMass: mass > 0 ? 1 / mass : 0,
    restitution: PHYSICS.RESTITUTION_DEFAULT,
    friction: PHYSICS.FRICTION_DEFAULT,
    linearDamping: PHYSICS.LINEAR_DAMPING_DEFAULT,
    angularDamping: PHYSICS.ANGULAR_DAMPING_DEFAULT,
    bodyType: PHYSICS.BODY_TYPE.DYNAMIC,
    sleeping: 0
  };
}

export function defaultCollider(shape = PHYSICS.SHAPE.BOX) {
  return {
    shape,
    radius: 0.5,
    hx: 0.5,
    hy: 0.5,
    hz: 0.5,
    layer: PHYSICS.COLLISION_FLAGS.DEFAULT,
    mask: PHYSICS.COLLISION_FLAGS.ALL
  };
}

export function defaultCamera(isMain = false) {
  return {
    fov: RENDER.DEFAULT_FOV,
    near: RENDER.NEAR,
    far: RENDER.FAR,
    aspect: 1,
    exposure: RENDER.EXPOSURE_DEFAULT,
    toneMapping: RENDER.TONE_MAPPING.ACES_FILMIC,
    isMain
  };
}

export function defaultLight(type = 0) {
  return {
    type,
    colorR: 1, colorG: 1, colorB: 1,
    intensity: 1,
    range: 10,
    innerCone: 0.3,
    outerCone: 0.6,
    castShadow: false
  };
}

export function defaultHealth(current = 100, max = 100) {
  return { current, max };
}

export function defaultAI(speed = 3) {
  return {
    state: 0,
    target: 0,
    speed,
    awarenessSq: CONTEXT.AWARENESS_RADIUS * CONTEXT.AWARENESS_RADIUS,
    timer: 0
  };
}

export function defaultAnimation(clipId = 0) {
  return { clipId, time: 0, speed: 1, weight: 1, loop: 1 };
}

// ============================================================================
// MATERIAL PRESET APPLICATION
// ============================================================================

export function applyMaterialPreset(world, eid, presetName) {
  const preset = _presetRegistry.get(presetName);
  if (!preset) return false;
  if (!bitecs.hasComponent(world, eid, World.Material)) {
    bitecs.addComponent(world, eid, World.Material);
  }
  const M = World.Material;
  M.baseColorR[eid] = preset.baseColor[0];
  M.baseColorG[eid] = preset.baseColor[1];
  M.baseColorB[eid] = preset.baseColor[2];
  M.metalness[eid] = preset.metalness;
  M.roughness[eid] = preset.roughness;
  M.emissiveR[eid] = preset.emissive[0];
  M.emissiveG[eid] = preset.emissive[1];
  M.emissiveB[eid] = preset.emissive[2];
  M.emissiveIntensity[eid] = preset.emissiveIntensity;
  M.opacity[eid] = preset.opacity;
  M.alphaTest[eid] = preset.alphaTest;
  M.clearcoat[eid] = preset.clearcoat;
  M.clearcoatRoughness[eid] = preset.clearcoatRoughness;
  M.sheen[eid] = preset.sheen;
  M.sheenRoughness[eid] = preset.sheenRoughness;
  M.transmission[eid] = preset.transmission;
  M.thickness[eid] = preset.thickness;
  M.ior[eid] = preset.ior;
  M.iridescence[eid] = preset.iridescence;
  M.anisotropy[eid] = preset.anisotropy;
  M.aoIntensity[eid] = preset.aoIntensity;
  M.envMapIntensity[eid] = preset.envMapIntensity;
  M.normalScale[eid] = preset.normalScale;
  M.displacementScale[eid] = preset.displacementScale;
  M.flatShading[eid] = preset.flatShading ? 1 : 0;
  M.wireframe[eid] = preset.wireframe ? 1 : 0;
  M.side[eid] = preset.side;
  M.toneMapping[eid] = preset.toneMapping;
  M.renderStyle[eid] = preset.renderStyle;
  return true;
}

// ============================================================================
// BULK COMPONENT UTILITIES
// ============================================================================

export function addTransformBulk(world, eids, transformFn) {
  for (let i = 0; i < eids.length; i++) {
    const eid = eids[i];
    if (!bitecs.hasComponent(world, eid, World.Transform)) {
      bitecs.addComponent(world, eid, World.Transform);
    }
    const t = transformFn ? transformFn(i, eid) : null;
    if (t) {
      World.Transform.px[eid] = t.px !== undefined ? t.px : 0;
      World.Transform.py[eid] = t.py !== undefined ? t.py : 0;
      World.Transform.pz[eid] = t.pz !== undefined ? t.pz : 0;
      World.Transform.rx[eid] = t.rx !== undefined ? t.rx : 0;
      World.Transform.ry[eid] = t.ry !== undefined ? t.ry : 0;
      World.Transform.rz[eid] = t.rz !== undefined ? t.rz : 0;
      World.Transform.rw[eid] = t.rw !== undefined ? t.rw : 1;
      World.Transform.sx[eid] = t.sx !== undefined ? t.sx : 1;
      World.Transform.sy[eid] = t.sy !== undefined ? t.sy : 1;
      World.Transform.sz[eid] = t.sz !== undefined ? t.sz : 1;
    }
  }
}

export function assignMaterialPresetBulk(world, eids, presetName) {
  const preset = _presetRegistry.get(presetName);
  if (!preset) return;
  const M = World.Material;
  for (let i = 0; i < eids.length; i++) {
    const eid = eids[i];
    if (!bitecs.hasComponent(world, eid, M)) {
      bitecs.addComponent(world, eid, M);
    }
    M.baseColorR[eid] = preset.baseColor[0];
    M.baseColorG[eid] = preset.baseColor[1];
    M.baseColorB[eid] = preset.baseColor[2];
    M.metalness[eid] = preset.metalness;
    M.roughness[eid] = preset.roughness;
    M.emissiveR[eid] = preset.emissive[0];
    M.emissiveG[eid] = preset.emissive[1];
    M.emissiveB[eid] = preset.emissive[2];
    M.emissiveIntensity[eid] = preset.emissiveIntensity;
    M.opacity[eid] = preset.opacity;
    M.alphaTest[eid] = preset.alphaTest;
    M.clearcoat[eid] = preset.clearcoat;
    M.clearcoatRoughness[eid] = preset.clearcoatRoughness;
    M.sheen[eid] = preset.sheen;
    M.sheenRoughness[eid] = preset.sheenRoughness;
    M.transmission[eid] = preset.transmission;
    M.thickness[eid] = preset.thickness;
    M.ior[eid] = preset.ior;
    M.iridescence[eid] = preset.iridescence;
    M.anisotropy[eid] = preset.anisotropy;
    M.aoIntensity[eid] = preset.aoIntensity;
    M.envMapIntensity[eid] = preset.envMapIntensity;
    M.normalScale[eid] = preset.normalScale;
    M.displacementScale[eid] = preset.displacementScale;
    M.flatShading[eid] = preset.flatShading ? 1 : 0;
    M.wireframe[eid] = preset.wireframe ? 1 : 0;
    M.side[eid] = preset.side;
    M.toneMapping[eid] = preset.toneMapping;
    M.renderStyle[eid] = preset.renderStyle;
  }
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================

export default {
  MaterialPresets,
  Prefabs,
  registerMaterialPreset,
  getMaterialPreset,
  hasMaterialPreset,
  listMaterialPresets,
  registerPrefab,
  hasPrefab,
  listPrefabs,
  spawnPrefab,
  spawnPrefabMany,
  buildPlayerPrefab,
  buildCameraPrefab,
  buildDirectionalLightPrefab,
  buildPointLightPrefab,
  buildSpotLightPrefab,
  buildStaticPropPrefab,
  buildDynamicPropPrefab,
  buildAIAgentPrefab,
  buildProjectilePrefab,
  buildParticlePrefab,
  buildTerrainChunkPrefab,
  buildTriggerZonePrefab,
  ComponentMeta,
  registerComponentMeta,
  getComponentMeta,
  listComponentMeta,
  defaultTransform,
  defaultVelocity,
  defaultRigidBody,
  defaultCollider,
  defaultCamera,
  defaultLight,
  defaultHealth,
  defaultAI,
  defaultAnimation,
  applyMaterialPreset,
  addTransformBulk,
  assignMaterialPresetBulk
};