// file number : 002
// full path name : src/core/002_Constants.js
// description : Global constants for precision, scale, physics, rendering, PBR, ECS, and mobile targets. Includes float32/float64 precision control, galactic-scale thresholds, and material enums.
// best for : Central configuration of the entire engine; ensures consistent precision, scale thresholds, and CDN loading across all modules.
// license : MIT

import { HIERARCHY } from './001_Hierarchy.js';

// ============================================================================
// PRECISION
// ============================================================================
export const PRECISION = Object.freeze({
  FLOAT32: 32,
  FLOAT64: 64,
  DUAL: 'dual',
  DEFAULT: 32,
  EPSILON_32: 1e-6,
  EPSILON_64: 1e-15,
  MAX_32: 3.4028234663852886e38,
  MIN_32: 1.1754943508222875e-38,
  MAX_64: Number.MAX_VALUE,
  MIN_64: Number.MIN_VALUE,
  SAFE_INT_32: 16777216,
  SAFE_INT_64: Number.MAX_SAFE_INTEGER
});

// ============================================================================
// SCALE (small → galactic)
// ============================================================================
export const SCALE = Object.freeze({
  MICRO: 1e-6,
  MILLI: 1e-3,
  UNIT: 1.0,
  KILO: 1e3,
  MEGA: 1e6,
  GIGA: 1e9,
  TERA: 1e12,
  PETA: 1e15,
  SOLAR: 1.495978707e11,
  AU: 1.495978707e11,
  LIGHT_YEAR: 9.4607304725808e15,
  PARSEC: 3.0856775814913673e16,
  GALACTIC: 1e21,
  FLOAT32_SAFE: 1e5,
  FLOAT32_LIMIT: 1e7,
  FLOAT64_SAFE: 1e15,
  FLOAT64_LIMIT: 1e308,
  CAMERA_NEAR_MIN: 1e-4,
  CAMERA_FAR_MAX: 1e20,
  FLOATING_ORIGIN_THRESHOLD: 1e4,
  FLOATING_ORIGIN_SNAP: 1e-3,
  CHUNK_SIZE: 1e4,
  GRID_CELL: 1e3,
  LOD_DISTANCES: Object.freeze([10, 100, 1e3, 1e4, 1e5, 1e6, 1e7])
});

// ============================================================================
// COORDINATE SYSTEM
// ============================================================================
export const AXIS = Object.freeze({
  X: 0, Y: 1, Z: 2, W: 3,
  UP: Object.freeze([0, 1, 0]),
  FORWARD: Object.freeze([0, 0, -1]),
  RIGHT: Object.freeze([1, 0, 0]),
  HANDEDNESS: 'right',
  COLUMN_MAJOR: true
});

// ============================================================================
// RENDER
// ============================================================================
export const RENDER = Object.freeze({
  DEFAULT_FOV: 60,
  MIN_FOV: 1,
  MAX_FOV: 179,
  NEAR: 0.1,
  FAR: 1e7,
  PIXEL_RATIO_MAX: 2,
  TARGET_FPS: 60,
  ADAPTIVE_FPS_MIN: 30,
  ANTIALIAS_SAMPLES: 4,
  MSAA_SAMPLES: 4,
  SHADOW_MAP_SIZES: Object.freeze([512, 1024, 2048, 4096]),
  SHADOW_DEFAULT: 2048,
  TONE_MAPPING: Object.freeze({
    NONE: 0, LINEAR: 1, REINHARD: 2, CINEON: 3,
    ACES_FILMIC: 4, AGX: 5, NEUTRAL: 6
  }),
  OUTPUT_COLOR_SPACE: 'srgb',
  WORKING_COLOR_SPACE: 'linear-srgb',
  ENV_MAP_INTENSITY: 1.0,
  EXPOSURE_DEFAULT: 1.0,
  BLEND_MODES: Object.freeze({
    NORMAL: 1, ADDITIVE: 2, SUBTRACTIVE: 3, MULTIPLY: 4,
    SCREEN: 5, OVERLAY: 6, SOFT_LIGHT: 7
  }),
  DEPTH_FUNCS: Object.freeze({
    NEVER: 0, LESS: 1, EQUAL: 2, LEQUAL: 3,
    GREATER: 4, NOTEQUAL: 5, GEQUAL: 6, ALWAYS: 7
  })
});

// ============================================================================
// PBR MATERIAL
// ============================================================================
export const PBR = Object.freeze({
  METALNESS_DEFAULT: 0.0,
  ROUGHNESS_DEFAULT: 1.0,
  AO_INTENSITY_DEFAULT: 1.0,
  CLEARCOAT_DEFAULT: 0.0,
  CLEARCOAT_ROUGHNESS_DEFAULT: 0.0,
  SHEEN_DEFAULT: 0.0,
  SHEEN_ROUGHNESS_DEFAULT: 1.0,
  SHEEN_COLOR_DEFAULT: Object.freeze([1, 1, 1]),
  IRIDESCENCE_DEFAULT: 0.0,
  IRIDESCENCE_IOR_DEFAULT: 1.3,
  IRIDESCENCE_THICKNESS_MIN: 100,
  IRIDESCENCE_THICKNESS_MAX: 400,
  TRANSMISSION_DEFAULT: 0.0,
  THICKNESS_DEFAULT: 0.0,
  IOR_DEFAULT: 1.5,
  IOR_MIN: 1.0,
  IOR_MAX: 2.333,
  SPECULAR_INTENSITY_DEFAULT: 1.0,
  SPECULAR_COLOR_DEFAULT: Object.freeze([1, 1, 1]),
  EMISSIVE_INTENSITY_DEFAULT: 1.0,
  ANISOTROPY_DEFAULT: 0.0,
  ANISOTROPY_ROTATION_DEFAULT: 0.0,
  DISPERSION_DEFAULT: 0.0,
  ATTENUATION_DISTANCE_DEFAULT: Infinity,
  ATTENUATION_COLOR_DEFAULT: Object.freeze([1, 1, 1]),
  BUMP_SCALE_DEFAULT: 1.0,
  NORMAL_SCALE_DEFAULT: Object.freeze([1, 1]),
  DISPLACEMENT_SCALE_DEFAULT: 1.0,
  DISPLACEMENT_BIAS_DEFAULT: 0.0,
  ENV_MAP_INTENSITY_DEFAULT: 1.0,
  FLAT_SHADING_DEFAULT: false,
  FOG_DEFAULT: true,
  WIREFRAME_DEFAULT: false,
  SIDE: Object.freeze({ FRONT: 0, BACK: 1, DOUBLE: 2 }),
  ALPHA_TEST_DEFAULT: 0.0,
  ALPHA_HASH_SCALE: 1.0,
  ALPHA_MAP_DEFAULT: null
});

// ============================================================================
// ANIME / FLAT MATERIAL
// ============================================================================
export const ANIME = Object.freeze({
  BASE_COLOR_DEFAULT: Object.freeze([1, 1, 1]),
  SHADE_COLOR_DEFAULT: Object.freeze([0.5, 0.5, 0.5]),
  SHADOW_THRESHOLD_DEFAULT: 0.5,
  SHADOW_SOFTNESS_DEFAULT: 0.01,
  RIM_POWER_DEFAULT: 3.0,
  RIM_INTENSITY_DEFAULT: 0.5,
  RIM_COLOR_DEFAULT: Object.freeze([1, 1, 1]),
  SPECULAR_POWER_DEFAULT: 8.0,
  SPECULAR_INTENSITY_DEFAULT: 1.0,
  SPECULAR_COLOR_DEFAULT: Object.freeze([1, 1, 1]),
  OUTLINE_WIDTH_DEFAULT: 0.02,
  OUTLINE_COLOR_DEFAULT: Object.freeze([0, 0, 0]),
  OUTLINE_THRESHOLD_DEFAULT: 0.1,
  EMISSION_INTENSITY_DEFAULT: 0.0,
  MATCAP_INTENSITY_DEFAULT: 1.0,
  GRADIENT_MAP_DEFAULT: null
});

// ============================================================================
// SEMI-REALISTIC MATERIAL
// ============================================================================
export const SEMI_REALISTIC = Object.freeze({
  TOON_BLEND_DEFAULT: 0.5,
  SHADOW_TINT_DEFAULT: Object.freeze([0.7, 0.7, 0.8]),
  HIGHLIGHT_INTENSITY_DEFAULT: 0.8,
  HIGHLIGHT_POWER_DEFAULT: 32.0,
  SUBSURFACE_DEFAULT: 0.0,
  SUBSURFACE_COLOR_DEFAULT: Object.freeze([1, 0.5, 0.5]),
  SUBSURFACE_DISTORTION_DEFAULT: 0.1,
  SUBSURFACE_POWER_DEFAULT: 4.0,
  SUBSURFACE_SCALE_DEFAULT: 1.0,
  FRESNEL_POWER_DEFAULT: 5.0,
  FRESNEL_BIAS_DEFAULT: 0.0,
  FRESNEL_SCALE_DEFAULT: 1.0,
  AMBIENT_INTENSITY_DEFAULT: 0.3
});

// ============================================================================
// PHYSICS
// ============================================================================
export const PHYSICS = Object.freeze({
  GRAVITY_DEFAULT: Object.freeze([0, -9.81, 0]),
  GRAVITY_GALACTIC: Object.freeze([0, 0, 0]),
  FIXED_TIMESTEP: 1 / 60,
  MAX_SUBSTEPS: 4,
  SOLVER_ITERATIONS: 8,
  SLEEP_LINEAR_THRESHOLD: 0.01,
  SLEEP_ANGULAR_THRESHOLD: 0.01,
  SLEEP_TIME_THRESHOLD: 0.5,
  CONTACT_SKIN: 0.001,
  RESTITUTION_DEFAULT: 0.3,
  FRICTION_DEFAULT: 0.5,
  FRICTION_STATIC_DEFAULT: 0.6,
  FRICTION_DYNAMIC_DEFAULT: 0.4,
  DENSITY_DEFAULT: 1000,
  LINEAR_DAMPING_DEFAULT: 0.05,
  ANGULAR_DAMPING_DEFAULT: 0.05,
  COLLISION_MARGIN: 0.04,
  MAX_BODIES: 10000,
  MAX_CONTACTS: 65536,
  BROADPHASE: Object.freeze({ BRUTE: 0, SWEEP: 1, BVH: 2, GRID: 3, OCTREE: 4 }),
  BROADPHASE_DEFAULT: 3,
  SHAPE: Object.freeze({
    SPHERE: 0, BOX: 1, CAPSULE: 2, CYLINDER: 3,
    CONVEX: 4, TRIMESH: 5, HEIGHTFIELD: 6, PLANE: 7
  }),
  BODY_TYPE: Object.freeze({ STATIC: 0, KINEMATIC: 1, DYNAMIC: 2 }),
  COLLISION_FLAGS: Object.freeze({
    DEFAULT: 0x0001, PLAYER: 0x0002, ENEMY: 0x0004,
    PROJECTILE: 0x0008, DEBRIS: 0x0010, TRIGGER: 0x0020,
    ALL: 0xFFFF
  })
});

// ============================================================================
// ECS (bitECS-compatible)
// ============================================================================
export const ECS = Object.freeze({
  MAX_ENTITIES: 100000,
  MAX_COMPONENTS: 256,
  MAX_SYSTEMS: 128,
  WORLD_POOL_SIZE: 4,
  QUERY_CACHE: 64,
  TICK_RATE: 60,
  TICK_RATE_MIN: 15,
  TICK_RATE_MAX: 240,
  PRIORITY: Object.freeze({
    INPUT: 0, AI: 1, PHYSICS: 2, ANIMATION: 3,
    TRANSFORM: 4, RENDER: 5, POST: 6, UI: 7
  }),
  COMPONENT_TYPE: Object.freeze({
    TRANSFORM: 0, RENDERABLE: 1, RIGIDBODY: 2, COLLIDER: 3,
    MATERIAL: 4, CAMERA: 5, LIGHT: 6, ANIMATION: 7,
    AI: 8, SCRIPT: 9, AUDIO: 10, PARTICLE: 11,
    LOD: 12, CHUNK: 13, BATCH: 14, INSTANCE: 15
  })
});

// ============================================================================
// SIMPLEX NOISE
// ============================================================================
export const NOISE = Object.freeze({
  DEFAULT_SEED: 1337,
  FREQUENCY_DEFAULT: 1.0,
  OCTAVES_DEFAULT: 4,
  PERSISTENCE_DEFAULT: 0.5,
  LACUNARITY_DEFAULT: 2.0,
  AMPLITUDE_DEFAULT: 1.0,
  NOISE_TYPES: Object.freeze({ SIMPLEX_2D: 2, SIMPLEX_3D: 3, SIMPLEX_4D: 4 })
});

// ============================================================================
// MEMORY & POOLING
// ============================================================================
export const MEMORY = Object.freeze({
  POOL_SIZES: Object.freeze({
    VEC2: 1024, VEC3: 1024, VEC4: 512,
    MAT2: 128, MAT3: 128, MAT4: 128, QUAT: 256, QUAT2: 128
  }),
  TYPED_ARRAY_CHUNK: 65536,
  GC_HINT_INTERVAL_MS: 5000,
  MAX_POOL_OVERFLOW: 2.0
});

// ============================================================================
// PERFORMANCE (Android 64-bit)
// ============================================================================
export const PERFORMANCE = Object.freeze({
  TARGET_PLATFORM: 'android64',
  ENABLE_WASM_SIMD: true,
  ENABLE_WORKERS: true,
  WORKER_COUNT: Math.min(4, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4),
  ENABLE_SHARED_ARRAY_BUFFER: true,
  ENABLE_INSTANCING: true,
  ENABLE_BATCHING: true,
  MAX_DRAW_CALLS: 1000,
  MAX_INSTANCES: 10000,
  FRAME_BUDGET_MS: 16.67,
  GLOBAL_FRAME_BUDGET_MS: 12,
  PHYSICS_BUDGET_MS: 4,
  RENDER_BUDGET_MS: 6,
  LOD_BUDGET_MS: 0.5,
  AI_BUDGET_MS: 1.5
});

// ============================================================================
// CONTEXT AWARENESS
// ============================================================================
export const CONTEXT = Object.freeze({
  INTEREST_POINTS_MAX: 64,
  PLAYER_RADIUS: 3.0,
  AWARENESS_RADIUS: 50.0,
  DEACTIVATION_RADIUS: 100.0,
  HYSTERESIS: 0.2,
  UPDATE_INTERVAL_MS: 250,
  LOD_BIAS_DEFAULT: 1.0,
  FADE_DISTANCE: 5.0
});

// ============================================================================
// ENGINE META
// ============================================================================
export const ENGINE = Object.freeze({
  NAME: 'NovaEngine',
  VERSION: '1.0.0',
  THREE_VERSION: '0.185.0',
  TARGET: 'three-r185',
  HIERARCHY: Object.freeze(HIERARCHY),
  LICENSE: 'MIT',
  RENDERER: 'webgpu',
  RENDERER_FALLBACK: 'webgl2'
});

// ============================================================================
// HELPERS
// ============================================================================
export const HELPERS = Object.freeze({
  DEG2RAD: Math.PI / 180,
  RAD2DEG: 180 / Math.PI,
  TAU: Math.PI * 2,
  HALF_PI: Math.PI / 2,
  QUARTER_PI: Math.PI / 4,
  INV_PI: 1 / Math.PI,
  INV_TAU: 1 / (Math.PI * 2),
  SQRT2: Math.SQRT2,
  SQRT1_2: Math.SQRT1_2,
  GOLDEN_RATIO: (1 + Math.sqrt(5)) / 2
});

export default {
  PRECISION, SCALE, AXIS, RENDER, PBR, ANIME, SEMI_REALISTIC,
  PHYSICS, ECS, NOISE, MEMORY, PERFORMANCE, CONTEXT,
  ENGINE, HELPERS
};