// file number : 015
// full path name : src/ecs/015_World.js
// description : High-level World layer built on 014_BitECS.js with full DoubleDouble (dd) precision support via 014_DoubleDouble.js. Provides SoA 3D components (Transform, TransformDD, Velocity, RigidBody, Collider, Renderable, Material, Camera, Light, LOD, Awareness, Tag), ChildOf hierarchy relation, spatial hash grid for context-awareness, prefab/archetype spawn/despawn with pooling, priority-ordered system registry with per-system frame budgeting, floating-origin transform integration (dd-aware delta rebase), noise-driven procedural spawn helpers, full SoA/AoS serialization wrappers, DD-absolute position helpers, DD distance comparison utilities, and fast bulk spawn. Local Transform stores render-friendly origin-relative coordinates (Float32/64); TransformDD stores absolute galactic-scale [lo, hi] positions for seamless small-to-galactic transitions. Includes context pipeline (interest points, awareness radius, LOD banding, hysteresis), zero-allocation entity count, and query helpers for render/physics/AI/camera.
// best for : 10k+ entity living worlds spanning millimeter-to-galactic scale, PBR scene orchestration, physics body registration, instanced rendering batches, chunk streaming, LOD-driven culling, network replication, save/load, and low-GC per-frame iteration on Android 64-bit.
// license : MIT

import * as bitecs from './014_BitECS.js';
import * as Precision from '../core/004_Precision.js';
import * as DD from '../math/014_DoubleDouble.js';
import {
  ECS, CONTEXT, SCALE, PHYSICS, RENDER, PERFORMANCE
} from '../core/002_Constants.js';
import * as vec3 from '../math/006_Vec3.js';
import * as quat from '../math/011_Quat.js';
import { createNoise2D, createNoise3D, fractal3D } from '../math/013_SimplexNoise.js';

const INTERNAL = Symbol.for('bitecs_internal');

function getEntityCount(world) {
  const internal = world[INTERNAL];
  return internal ? internal.entityComponents.size : 0;
}

// ============================================================================
// COMPONENTS (SoA, aligned with Three.js r185 conventions)
// ============================================================================

export const Transform = {
  px: bitecs.f32([]),
  py: bitecs.f32([]),
  pz: bitecs.f32([]),
  rx: bitecs.f32([]),
  ry: bitecs.f32([]),
  rz: bitecs.f32([]),
  rw: bitecs.f32([]),
  sx: bitecs.f32([]),
  sy: bitecs.f32([]),
  sz: bitecs.f32([])
};

// Absolute galactic-scale position stored as double-double (lo, hi)
// Entity may add this component for entities that need > 15 decimal digits of absolute position.
export const TransformDD = {
  pxLo: bitecs.f64([]),
  pxHi: bitecs.f64([]),
  pyLo: bitecs.f64([]),
  pyHi: bitecs.f64([]),
  pzLo: bitecs.f64([]),
  pzHi: bitecs.f64([])
};

export const Velocity = {
  vx: bitecs.f32([]),
  vy: bitecs.f32([]),
  vz: bitecs.f32([]),
  ax: bitecs.f32([]),
  ay: bitecs.f32([]),
  az: bitecs.f32([])
};

export const RigidBody = {
  mass: bitecs.f32([]),
  invMass: bitecs.f32([]),
  restitution: bitecs.f32([]),
  friction: bitecs.f32([]),
  linearDamping: bitecs.f32([]),
  angularDamping: bitecs.f32([]),
  bodyType: bitecs.u8([]),
  sleeping: bitecs.u8([])
};

export const Collider = {
  shape: bitecs.u8([]),
  radius: bitecs.f32([]),
  hx: bitecs.f32([]),
  hy: bitecs.f32([]),
  hz: bitecs.f32([]),
  layer: bitecs.u16([]),
  mask: bitecs.u16([])
};

export const Renderable = bitecs.u8([]);
export const MeshRef = bitecs.u32([]);
export const MaterialRef = bitecs.u32([]);
export const CameraTag = bitecs.u8([]);
export const LightTag = bitecs.u8([]);
export const PlayerTag = bitecs.u8([]);
export const ChunkTag = bitecs.u8([]);
export const StaticTag = bitecs.u8([]);
export const DynamicTag = bitecs.u8([]);
export const SleepingTag = bitecs.u8([]);
export const ActiveTag = bitecs.u8([]);
export const InactiveTag = bitecs.u8([]);
export const LODLevel = bitecs.u8([]);
export const AwarenessLevel = bitecs.u8([]);

export const Material = {
  baseColorR: bitecs.f32([]),
  baseColorG: bitecs.f32([]),
  baseColorB: bitecs.f32([]),
  metalness: bitecs.f32([]),
  roughness: bitecs.f32([]),
  emissiveR: bitecs.f32([]),
  emissiveG: bitecs.f32([]),
  emissiveB: bitecs.f32([]),
  emissiveIntensity: bitecs.f32([]),
  opacity: bitecs.f32([]),
  alphaTest: bitecs.f32([]),
  clearcoat: bitecs.f32([]),
  clearcoatRoughness: bitecs.f32([]),
  sheen: bitecs.f32([]),
  sheenRoughness: bitecs.f32([]),
  transmission: bitecs.f32([]),
  thickness: bitecs.f32([]),
  ior: bitecs.f32([]),
  iridescence: bitecs.f32([]),
  anisotropy: bitecs.f32([]),
  aoIntensity: bitecs.f32([]),
  envMapIntensity: bitecs.f32([]),
  normalScale: bitecs.f32([]),
  displacementScale: bitecs.f32([]),
  flatShading: bitecs.u8([]),
  wireframe: bitecs.u8([]),
  side: bitecs.u8([]),
  toneMapping: bitecs.u8([]),
  renderStyle: bitecs.u8([])
};

export const Camera = {
  fov: bitecs.f32([]),
  near: bitecs.f32([]),
  far: bitecs.f32([]),
  aspect: bitecs.f32([]),
  exposure: bitecs.f32([]),
  toneMapping: bitecs.u8([]),
  isMain: bitecs.u8([])
};

export const Light = {
  type: bitecs.u8([]),
  colorR: bitecs.f32([]),
  colorG: bitecs.f32([]),
  colorB: bitecs.f32([]),
  intensity: bitecs.f32([]),
  range: bitecs.f32([]),
  innerCone: bitecs.f32([]),
  outerCone: bitecs.f32([]),
  castShadow: bitecs.u8([])
};

export const Health = {
  current: bitecs.f32([]),
  max: bitecs.f32([])
};

export const AI = {
  state: bitecs.u8([]),
  target: bitecs.u32([]),
  speed: bitecs.f32([]),
  awarenessSq: bitecs.f32([]),
  timer: bitecs.f32([])
};

export const Animation = {
  clipId: bitecs.u32([]),
  time: bitecs.f32([]),
  speed: bitecs.f32([]),
  weight: bitecs.f32([]),
  loop: bitecs.u8([])
};

export const ChildOf = bitecs.createRelation();

// ============================================================================
// WORLD CONSTRUCTION
// ============================================================================

const _systems = new WeakMap();
const _spatialGrid = new WeakMap();
const _contextState = new WeakMap();
const _frameState = new WeakMap();
const _noise = new WeakMap();

export function createGameWorld(options = {}) {
  const world = bitecs.createWorld(options.context || {});

  _systems.set(world, []);
  _spatialGrid.set(world, {
    cellSize: options.cellSize !== undefined ? options.cellSize : SCALE.GRID_CELL,
    cells: new Map(),
    entityCell: []
  });
  _contextState.set(world, {
    playerEntity: 0,
    lastUpdate: 0,
    intervalMs: CONTEXT.UPDATE_INTERVAL_MS,
    awarenessRadiusSq: CONTEXT.AWARENESS_RADIUS * CONTEXT.AWARENESS_RADIUS,
    deactivationRadiusSq: CONTEXT.DEACTIVATION_RADIUS * CONTEXT.DEACTIVATION_RADIUS,
    interestPoints: [],
    hysteresis: CONTEXT.HYSTERESIS
  });
  _frameState.set(world, {
    frame: 0,
    deltaTime: 0,
    elapsedTime: 0,
    totalEntities: 0,
    activeEntities: 0,
    totalMs: 0,
    fps: 0
  });
  _noise.set(world, {
    seed: options.seed !== undefined ? options.seed : 1337,
    noise2D: null,
    noise3D: null
  });

  return world;
}

export function destroyGameWorld(world) {
  bitecs.deleteWorld(world);
  _systems.delete(world);
  _spatialGrid.delete(world);
  _contextState.delete(world);
  _frameState.delete(world);
  _noise.delete(world);
}

export function getFrameState(world) {
  return _frameState.get(world);
}

// ============================================================================
// SYSTEM REGISTRATION
// ============================================================================

export function registerSystem(world, name, fn, priority = ECS.PRIORITY.TRANSFORM, budgetMs = 0) {
  const systems = _systems.get(world);
  const entry = { name, fn, priority, budgetMs, enabled: true, lastMs: 0 };
  systems.push(entry);
  systems.sort((a, b) => a.priority - b.priority);
  return entry;
}

export function unregisterSystem(world, name) {
  const systems = _systems.get(world);
  const idx = systems.findIndex((s) => s.name === name);
  if (idx >= 0) systems.splice(idx, 1);
}

export function enableSystem(world, name, enabled) {
  const systems = _systems.get(world);
  const s = systems.find((x) => x.name === name);
  if (s) s.enabled = enabled;
}

export function getSystems(world) {
  return _systems.get(world).slice();
}

// ============================================================================
// ENTITY SPAWN / DESPAWN
// ============================================================================

const _defaultTransform = {
  px: 0, py: 0, pz: 0,
  rx: 0, ry: 0, rz: 0, rw: 1,
  sx: 1, sy: 1, sz: 1
};

export function spawnEntity(world, opts = {}) {
  const eid = bitecs.addEntity(world);
  bitecs.addComponent(world, eid, Transform);
  const t = opts.transform || _defaultTransform;
  Transform.px[eid] = t.px !== undefined ? t.px : 0;
  Transform.py[eid] = t.py !== undefined ? t.py : 0;
  Transform.pz[eid] = t.pz !== undefined ? t.pz : 0;
  Transform.rx[eid] = t.rx !== undefined ? t.rx : 0;
  Transform.ry[eid] = t.ry !== undefined ? t.ry : 0;
  Transform.rz[eid] = t.rz !== undefined ? t.rz : 0;
  Transform.rw[eid] = t.rw !== undefined ? t.rw : 1;
  Transform.sx[eid] = t.sx !== undefined ? t.sx : 1;
  Transform.sy[eid] = t.sy !== undefined ? t.sy : 1;
  Transform.sz[eid] = t.sz !== undefined ? t.sz : 1;

  if (opts.transformDD) {
    bitecs.addComponent(world, eid, TransformDD);
    const dd = opts.transformDD;
    TransformDD.pxLo[eid] = dd.pxLo !== undefined ? dd.pxLo : 0;
    TransformDD.pxHi[eid] = dd.pxHi !== undefined ? dd.pxHi : 0;
    TransformDD.pyLo[eid] = dd.pyLo !== undefined ? dd.pyLo : 0;
    TransformDD.pyHi[eid] = dd.pyHi !== undefined ? dd.pyHi : 0;
    TransformDD.pzLo[eid] = dd.pzLo !== undefined ? dd.pzLo : 0;
    TransformDD.pzHi[eid] = dd.pzHi !== undefined ? dd.pzHi : 0;
  }

  if (opts.velocity) {
    bitecs.addComponent(world, eid, Velocity);
    const v = opts.velocity;
    Velocity.vx[eid] = v.vx !== undefined ? v.vx : 0;
    Velocity.vy[eid] = v.vy !== undefined ? v.vy : 0;
    Velocity.vz[eid] = v.vz !== undefined ? v.vz : 0;
    Velocity.ax[eid] = v.ax !== undefined ? v.ax : 0;
    Velocity.ay[eid] = v.ay !== undefined ? v.ay : 0;
    Velocity.az[eid] = v.az !== undefined ? v.az : 0;
  }

  if (opts.rigidBody) {
    bitecs.addComponent(world, eid, RigidBody);
    const rb = opts.rigidBody;
    const mass = rb.mass !== undefined ? rb.mass : 1;
    RigidBody.mass[eid] = mass;
    RigidBody.invMass[eid] = mass > 0 ? 1 / mass : 0;
    RigidBody.restitution[eid] = rb.restitution !== undefined ? rb.restitution : PHYSICS.RESTITUTION_DEFAULT;
    RigidBody.friction[eid] = rb.friction !== undefined ? rb.friction : PHYSICS.FRICTION_DEFAULT;
    RigidBody.linearDamping[eid] = rb.linearDamping !== undefined ? rb.linearDamping : PHYSICS.LINEAR_DAMPING_DEFAULT;
    RigidBody.angularDamping[eid] = rb.angularDamping !== undefined ? rb.angularDamping : PHYSICS.ANGULAR_DAMPING_DEFAULT;
    RigidBody.bodyType[eid] = rb.bodyType !== undefined ? rb.bodyType : PHYSICS.BODY_TYPE.DYNAMIC;
    RigidBody.sleeping[eid] = 0;
  }

  if (opts.collider) {
    bitecs.addComponent(world, eid, Collider);
    const c = opts.collider;
    Collider.shape[eid] = c.shape !== undefined ? c.shape : PHYSICS.SHAPE.SPHERE;
    Collider.radius[eid] = c.radius !== undefined ? c.radius : 0.5;
    Collider.hx[eid] = c.hx !== undefined ? c.hx : 0.5;
    Collider.hy[eid] = c.hy !== undefined ? c.hy : 0.5;
    Collider.hz[eid] = c.hz !== undefined ? c.hz : 0.5;
    Collider.layer[eid] = c.layer !== undefined ? c.layer : PHYSICS.COLLISION_FLAGS.DEFAULT;
    Collider.mask[eid] = c.mask !== undefined ? c.mask : PHYSICS.COLLISION_FLAGS.ALL;
  }

  if (opts.renderable) {
    bitecs.addComponent(world, eid, Renderable);
    Renderable[eid] = 1;
    if (opts.meshId !== undefined) {
      bitecs.addComponent(world, eid, MeshRef);
      MeshRef[eid] = opts.meshId;
    }
    if (opts.materialId !== undefined) {
      bitecs.addComponent(world, eid, MaterialRef);
      MaterialRef[eid] = opts.materialId;
    }
    bitecs.addComponent(world, eid, LODLevel);
    LODLevel[eid] = 0;
    bitecs.addComponent(world, eid, AwarenessLevel);
    AwarenessLevel[eid] = 0;
    bitecs.addComponent(world, eid, ActiveTag);
    ActiveTag[eid] = 1;
  }

  if (opts.material) {
    bitecs.addComponent(world, eid, Material);
    applyMaterialData(eid, opts.material);
  }

  if (opts.camera) {
    bitecs.addComponent(world, eid, CameraTag);
    CameraTag[eid] = 1;
    bitecs.addComponent(world, eid, Camera);
    const cam = opts.camera;
    Camera.fov[eid] = cam.fov !== undefined ? cam.fov : RENDER.DEFAULT_FOV;
    Camera.near[eid] = cam.near !== undefined ? cam.near : RENDER.NEAR;
    Camera.far[eid] = cam.far !== undefined ? cam.far : RENDER.FAR;
    Camera.aspect[eid] = cam.aspect !== undefined ? cam.aspect : 1;
    Camera.exposure[eid] = cam.exposure !== undefined ? cam.exposure : RENDER.EXPOSURE_DEFAULT;
    Camera.toneMapping[eid] = cam.toneMapping !== undefined ? cam.toneMapping : RENDER.TONE_MAPPING.ACES_FILMIC;
    Camera.isMain[eid] = cam.isMain ? 1 : 0;
  }

  if (opts.light) {
    bitecs.addComponent(world, eid, LightTag);
    LightTag[eid] = 1;
    bitecs.addComponent(world, eid, Light);
    const l = opts.light;
    Light.type[eid] = l.type !== undefined ? l.type : 0;
    Light.colorR[eid] = l.colorR !== undefined ? l.colorR : 1;
    Light.colorG[eid] = l.colorG !== undefined ? l.colorG : 1;
    Light.colorB[eid] = l.colorB !== undefined ? l.colorB : 1;
    Light.intensity[eid] = l.intensity !== undefined ? l.intensity : 1;
    Light.range[eid] = l.range !== undefined ? l.range : 0;
    Light.innerCone[eid] = l.innerCone !== undefined ? l.innerCone : 0;
    Light.outerCone[eid] = l.outerCone !== undefined ? l.outerCone : 0;
    Light.castShadow[eid] = l.castShadow ? 1 : 0;
  }

  if (opts.player) {
    bitecs.addComponent(world, eid, PlayerTag);
    PlayerTag[eid] = 1;
    _contextState.get(world).playerEntity = eid;
  }

  if (opts.health) {
    bitecs.addComponent(world, eid, Health);
    Health.current[eid] = opts.health.current !== undefined ? opts.health.current : 100;
    Health.max[eid] = opts.health.max !== undefined ? opts.health.max : 100;
  }

  if (opts.ai) {
    bitecs.addComponent(world, eid, AI);
    AI.state[eid] = 0;
    AI.target[eid] = 0;
    AI.speed[eid] = opts.ai.speed !== undefined ? opts.ai.speed : 3;
    AI.awarenessSq[eid] = opts.ai.awarenessSq !== undefined ? opts.ai.awarenessSq : 2500;
    AI.timer[eid] = 0;
  }

  if (opts.animation) {
    bitecs.addComponent(world, eid, Animation);
    Animation.clipId[eid] = opts.animation.clipId !== undefined ? opts.animation.clipId : 0;
    Animation.time[eid] = 0;
    Animation.speed[eid] = opts.animation.speed !== undefined ? opts.animation.speed : 1;
    Animation.weight[eid] = 1;
    Animation.loop[eid] = opts.animation.loop ? 1 : 0;
  }

  if (opts.static) {
    bitecs.addComponent(world, eid, StaticTag);
    StaticTag[eid] = 1;
  }
  if (opts.dynamic) {
    bitecs.addComponent(world, eid, DynamicTag);
    DynamicTag[eid] = 1;
  }

  if (opts.parent) {
    bitecs.addComponent(world, eid, bitecs.Pair(ChildOf, opts.parent));
  }

  if (opts.renderable) {
    addToSpatialGrid(world, eid);
  }

  return eid;
}

export function spawnMany(world, count, optsFn) {
  const ids = new Array(count);
  for (let i = 0; i < count; i++) {
    const opts = optsFn ? optsFn(i) : {};
    ids[i] = spawnEntity(world, opts);
  }
  return ids;
}

export function despawnEntity(world, eid) {
  removeFromSpatialGrid(world, eid);
  bitecs.removeEntity(world, eid);
}

export function despawnMany(world, ids) {
  for (let i = 0; i < ids.length; i++) despawnEntity(world, ids[i]);
}

export function isAlive(world, eid) {
  return bitecs.entityExists(world, eid);
}

// ============================================================================
// MATERIAL APPLICATION
// ============================================================================

function applyMaterialData(eid, mat) {
  Material.baseColorR[eid] = mat.baseColor ? mat.baseColor[0] : 1;
  Material.baseColorG[eid] = mat.baseColor ? mat.baseColor[1] : 1;
  Material.baseColorB[eid] = mat.baseColor ? mat.baseColor[2] : 1;
  Material.metalness[eid] = mat.metalness !== undefined ? mat.metalness : 0;
  Material.roughness[eid] = mat.roughness !== undefined ? mat.roughness : 1;
  Material.emissiveR[eid] = mat.emissive ? mat.emissive[0] : 0;
  Material.emissiveG[eid] = mat.emissive ? mat.emissive[1] : 0;
  Material.emissiveB[eid] = mat.emissive ? mat.emissive[2] : 0;
  Material.emissiveIntensity[eid] = mat.emissiveIntensity !== undefined ? mat.emissiveIntensity : 1;
  Material.opacity[eid] = mat.opacity !== undefined ? mat.opacity : 1;
  Material.alphaTest[eid] = mat.alphaTest !== undefined ? mat.alphaTest : 0;
  Material.clearcoat[eid] = mat.clearcoat !== undefined ? mat.clearcoat : 0;
  Material.clearcoatRoughness[eid] = mat.clearcoatRoughness !== undefined ? mat.clearcoatRoughness : 0;
  Material.sheen[eid] = mat.sheen !== undefined ? mat.sheen : 0;
  Material.sheenRoughness[eid] = mat.sheenRoughness !== undefined ? mat.sheenRoughness : 1;
  Material.transmission[eid] = mat.transmission !== undefined ? mat.transmission : 0;
  Material.thickness[eid] = mat.thickness !== undefined ? mat.thickness : 0;
  Material.ior[eid] = mat.ior !== undefined ? mat.ior : 1.5;
  Material.iridescence[eid] = mat.iridescence !== undefined ? mat.iridescence : 0;
  Material.anisotropy[eid] = mat.anisotropy !== undefined ? mat.anisotropy : 0;
  Material.aoIntensity[eid] = mat.aoIntensity !== undefined ? mat.aoIntensity : 1;
  Material.envMapIntensity[eid] = mat.envMapIntensity !== undefined ? mat.envMapIntensity : 1;
  Material.normalScale[eid] = mat.normalScale !== undefined ? mat.normalScale : 1;
  Material.displacementScale[eid] = mat.displacementScale !== undefined ? mat.displacementScale : 1;
  Material.flatShading[eid] = mat.flatShading ? 1 : 0;
  Material.wireframe[eid] = mat.wireframe ? 1 : 0;
  Material.side[eid] = mat.side !== undefined ? mat.side : 0;
  Material.toneMapping[eid] = mat.toneMapping !== undefined ? mat.toneMapping : RENDER.TONE_MAPPING.ACES_FILMIC;
  Material.renderStyle[eid] = mat.renderStyle !== undefined ? mat.renderStyle : 0;
}

// ============================================================================
// TRANSFORM HELPERS (double + dd)
// ============================================================================

export function getWorldPosition(world, eid, out) {
  const o = out || vec3.create();
  o[0] = Transform.px[eid] + Precision.getOriginX();
  o[1] = Transform.py[eid] + Precision.getOriginY();
  o[2] = Transform.pz[eid] + Precision.getOriginZ();
  return o;
}

export function getLocalPosition(world, eid, out) {
  const o = out || vec3.create();
  o[0] = Transform.px[eid];
  o[1] = Transform.py[eid];
  o[2] = Transform.pz[eid];
  return o;
}

export function setWorldPosition(world, eid, x, y, z) {
  Transform.px[eid] = x - Precision.getOriginX();
  Transform.py[eid] = y - Precision.getOriginY();
  Transform.pz[eid] = z - Precision.getOriginZ();
  if (bitecs.hasComponent(world, eid, TransformDD)) {
    TransformDD.pxLo[eid] = 0;
    TransformDD.pxHi[eid] = x;
    TransformDD.pyLo[eid] = 0;
    TransformDD.pyHi[eid] = y;
    TransformDD.pzLo[eid] = 0;
    TransformDD.pzHi[eid] = z;
  }
}

export function setRotation(world, eid, qx, qy, qz, qw) {
  Transform.rx[eid] = qx;
  Transform.ry[eid] = qy;
  Transform.rz[eid] = qz;
  Transform.rw[eid] = qw;
}

export function getRotation(world, eid, out) {
  const o = out || quat.create();
  o[0] = Transform.rx[eid];
  o[1] = Transform.ry[eid];
  o[2] = Transform.rz[eid];
  o[3] = Transform.rw[eid];
  return o;
}

// ============================================================================
// DD ABSOLUTE POSITION (galactic-scale precision)
// ============================================================================

export function enableTransformDD(world, eid) {
  if (bitecs.hasComponent(world, eid, TransformDD)) return;
  bitecs.addComponent(world, eid, TransformDD);
  const ox = Precision.getOriginX();
  const oy = Precision.getOriginY();
  const oz = Precision.getOriginZ();
  TransformDD.pxLo[eid] = 0;
  TransformDD.pxHi[eid] = Transform.px[eid] + ox;
  TransformDD.pyLo[eid] = 0;
  TransformDD.pyHi[eid] = Transform.py[eid] + oy;
  TransformDD.pzLo[eid] = 0;
  TransformDD.pzHi[eid] = Transform.pz[eid] + oz;
}

export function getAbsolutePositionDD(world, eid, out) {
  const o = out || DD.create();
  const x = DD.poolAcquire();
  const y = DD.poolAcquire();
  const z = DD.poolAcquire();
  try {
    if (bitecs.hasComponent(world, eid, TransformDD)) {
      x[0] = TransformDD.pxLo[eid];
      x[1] = TransformDD.pxHi[eid];
      y[0] = TransformDD.pyLo[eid];
      y[1] = TransformDD.pyHi[eid];
      z[0] = TransformDD.pzLo[eid];
      z[1] = TransformDD.pzHi[eid];
    } else {
      DD.copy(x, DD.fastTwoSum(Transform.px[eid], Precision.getOriginX()));
      DD.copy(y, DD.fastTwoSum(Transform.py[eid], Precision.getOriginY()));
      DD.copy(z, DD.fastTwoSum(Transform.pz[eid], Precision.getOriginZ()));
    }
    o[0] = x[0];
    o[1] = x[1];
    o[2] = y[0];
    o[3] = y[1];
    o[4] = z[0];
    o[5] = z[1];
    return o;
  } finally {
    DD.poolRelease(x);
    DD.poolRelease(y);
    DD.poolRelease(z);
  }
}

export function setAbsolutePositionDD(world, eid, xLo, xHi, yLo, yHi, zLo, zHi) {
  const ox = Precision.getOriginX();
  const oy = Precision.getOriginY();
  const oz = Precision.getOriginZ();

  const dx = DD.subtract([xLo, xHi], DD.fromDouble(ox));
  const dy = DD.subtract([yLo, yHi], DD.fromDouble(oy));
  const dz = DD.subtract([zLo, zHi], DD.fromDouble(oz));

  Transform.px[eid] = DD.toDouble(dx);
  Transform.py[eid] = DD.toDouble(dy);
  Transform.pz[eid] = DD.toDouble(dz);

  if (!bitecs.hasComponent(world, eid, TransformDD)) {
    bitecs.addComponent(world, eid, TransformDD);
  }
  TransformDD.pxLo[eid] = xLo;
  TransformDD.pxHi[eid] = xHi;
  TransformDD.pyLo[eid] = yLo;
  TransformDD.pyHi[eid] = yHi;
  TransformDD.pzLo[eid] = zLo;
  TransformDD.pzHi[eid] = zHi;
}

export function addToAbsolutePositionDD(world, eid, dxLo, dxHi, dyLo, dyHi, dzLo, dzHi) {
  if (bitecs.hasComponent(world, eid, TransformDD)) {
    const x = DD.add([TransformDD.pxLo[eid], TransformDD.pxHi[eid]], [dxLo, dxHi]);
    const y = DD.add([TransformDD.pyLo[eid], TransformDD.pyHi[eid]], [dyLo, dyHi]);
    const z = DD.add([TransformDD.pzLo[eid], TransformDD.pzHi[eid]], [dzLo, dzHi]);
    TransformDD.pxLo[eid] = x[0];
    TransformDD.pxHi[eid] = x[1];
    TransformDD.pyLo[eid] = y[0];
    TransformDD.pyHi[eid] = y[1];
    TransformDD.pzLo[eid] = z[0];
    TransformDD.pzHi[eid] = z[1];
  }

  Transform.px[eid] += dxHi;
  Transform.py[eid] += dyHi;
  Transform.pz[eid] += dzHi;
}

export function getAbsoluteDistanceSqDD(world, eidA, eidB) {
  const a = getAbsolutePositionDD(world, eidA);
  const b = getAbsolutePositionDD(world, eidB);
  const dx = DD.subtract([a[0], a[1]], [b[0], b[1]]);
  const dy = DD.subtract([a[2], a[3]], [b[2], b[3]]);
  const dz = DD.subtract([a[4], a[5]], [b[4], b[5]]);
  const d2 = DD.add(DD.add(DD.multiply(dx, dx), DD.multiply(dy, dy)), DD.multiply(dz, dz));
  return d2;
}

export function compareAbsoluteDistanceDD(world, eidA, eidB, threshold) {
  const d2 = getAbsoluteDistanceSqDD(world, eidA, eidB);
  const t2 = [0, threshold * threshold];
  return DD.compare(d2, t2);
}

// ============================================================================
// SPATIAL HASH GRID
// ============================================================================

function hashCell(cx, cy, cz) {
  return (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
}

function getCellKey(cellSize, x, y, z) {
  const cx = Math.floor(x / cellSize);
  const cy = Math.floor(y / cellSize);
  const cz = Math.floor(z / cellSize);
  return hashCell(cx, cy, cz);
}

function addToSpatialGrid(world, eid) {
  const grid = _spatialGrid.get(world);
  const key = getCellKey(grid.cellSize, Transform.px[eid], Transform.py[eid], Transform.pz[eid]);
  let bucket = grid.cells.get(key);
  if (!bucket) {
    bucket = new Set();
    grid.cells.set(key, bucket);
  }
  bucket.add(eid);
  grid.entityCell[eid] = key;
}

function removeFromSpatialGrid(world, eid) {
  const grid = _spatialGrid.get(world);
  const key = grid.entityCell[eid];
  if (key === undefined) return;
  const bucket = grid.cells.get(key);
  if (bucket) {
    bucket.delete(eid);
    if (bucket.size === 0) grid.cells.delete(key);
  }
  grid.entityCell[eid] = undefined;
}

export function updateSpatialGrid(world, eid) {
  const grid = _spatialGrid.get(world);
  const newKey = getCellKey(grid.cellSize, Transform.px[eid], Transform.py[eid], Transform.pz[eid]);
  const oldKey = grid.entityCell[eid];
  if (oldKey === newKey) return;
  if (oldKey !== undefined) {
    const old = grid.cells.get(oldKey);
    if (old) {
      old.delete(eid);
      if (old.size === 0) grid.cells.delete(oldKey);
    }
  }
  let bucket = grid.cells.get(newKey);
  if (!bucket) {
    bucket = new Set();
    grid.cells.set(newKey, bucket);
  }
  bucket.add(eid);
  grid.entityCell[eid] = newKey;
}

export function queryRadius(world, x, y, z, radius, out) {
  const grid = _spatialGrid.get(world);
  const cs = grid.cellSize;
  const r2 = radius * radius;
  const result = out || [];
  result.length = 0;
  const minCx = Math.floor((x - radius) / cs);
  const maxCx = Math.floor((x + radius) / cs);
  const minCy = Math.floor((y - radius) / cs);
  const maxCy = Math.floor((y + radius) / cs);
  const minCz = Math.floor((z - radius) / cs);
  const maxCz = Math.floor((z + radius) / cs);
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = hashCell(cx, cy, cz);
        const bucket = grid.cells.get(key);
        if (!bucket) continue;
        for (const eid of bucket) {
          const dx = Transform.px[eid] - x;
          const dy = Transform.py[eid] - y;
          const dz = Transform.pz[eid] - z;
          if (dx * dx + dy * dy + dz * dz <= r2) result.push(eid);
        }
      }
    }
  }
  return result;
}

// ============================================================================
// CONTEXT AWARENESS PIPELINE
// ============================================================================

export function setInterestPoint(world, x, y, z, radius, weight) {
  const state = _contextState.get(world);
  if (state.interestPoints.length >= CONTEXT.INTEREST_POINTS_MAX) {
    state.interestPoints.shift();
  }
  state.interestPoints.push({
    x, y, z,
    radius: radius !== undefined ? radius : CONTEXT.AWARENESS_RADIUS,
    weight: weight !== undefined ? weight : 1
  });
}

export function clearInterestPoints(world) {
  _contextState.get(world).interestPoints.length = 0;
}

export function updateContextAwareness(world, playerEid) {
  const state = _contextState.get(world);
  const px = Transform.px[playerEid];
  const py = Transform.py[playerEid];
  const pz = Transform.pz[playerEid];
  const awarenessR2 = state.awarenessRadiusSq;
  const deactivationR2 = state.deactivationRadiusSq;
  const hysteresis = state.hysteresis;
  const lodDistances = SCALE.LOD_DISTANCES;

  const renderables = bitecs.query(world, [Renderable]);
  for (let i = 0; i < renderables.length; i++) {
    const eid = renderables[i];
    const dx = Transform.px[eid] - px;
    const dy = Transform.py[eid] - py;
    const dz = Transform.pz[eid] - pz;
    const d2 = dx * dx + dy * dy + dz * dz;

    const hasActive = bitecs.hasComponent(world, eid, ActiveTag);
    if (hasActive && ActiveTag[eid] === 1) {
      if (d2 > deactivationR2 * (1 + hysteresis)) {
        bitecs.removeComponent(world, eid, ActiveTag);
        if (!bitecs.hasComponent(world, eid, InactiveTag)) {
          bitecs.addComponent(world, eid, InactiveTag);
        }
        InactiveTag[eid] = 1;
      }
    } else {
      if (d2 < awarenessR2 * (1 - hysteresis)) {
        if (bitecs.hasComponent(world, eid, InactiveTag)) {
          bitecs.removeComponent(world, eid, InactiveTag);
        }
        if (!bitecs.hasComponent(world, eid, ActiveTag)) {
          bitecs.addComponent(world, eid, ActiveTag);
        }
        ActiveTag[eid] = 1;
      }
    }

    let lod = lodDistances.length - 1;
    for (let k = 0; k < lodDistances.length; k++) {
      if (d2 < lodDistances[k] * lodDistances[k]) {
        lod = k;
        break;
      }
    }
    LODLevel[eid] = lod;
    const aw = d2 < awarenessR2 ? 2 : d2 < deactivationR2 ? 1 : 0;
    AwarenessLevel[eid] = aw;
  }
}

// ============================================================================
// NOISE-DRIVEN PROCEDURAL HELPERS
// ============================================================================

function makeSeededRng(seed) {
  let s = seed | 0;
  if (s === 0) s = 1;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function getNoise2D(world) {
  const st = _noise.get(world);
  if (!st.noise2D) st.noise2D = createNoise2D(makeSeededRng(st.seed));
  return st.noise2D;
}

export function getNoise3D(world) {
  const st = _noise.get(world);
  if (!st.noise3D) st.noise3D = createNoise3D(makeSeededRng(st.seed));
  return st.noise3D;
}

export function sampleTerrainHeight(world, x, z, octaves, scale) {
  const n = getNoise3D(world);
  return fractal3D(n, x * (scale || 1), 0, z * (scale || 1), octaves || 4);
}

// ============================================================================
// UPDATE PIPELINE
// ============================================================================

export function updateWorld(world, deltaTime) {
  const frame = _frameState.get(world);
  frame.frame++;
  frame.deltaTime = deltaTime;
  frame.elapsedTime += deltaTime;

  const systems = _systems.get(world);
  const budgetMs = PERFORMANCE.GLOBAL_FRAME_BUDGET_MS;
  let usedMs = 0;
  const hasPerf = typeof performance !== 'undefined';
  const now = hasPerf ? performance.now() : Date.now();

  for (let i = 0; i < systems.length; i++) {
    const sys = systems[i];
    if (!sys.enabled) continue;
    if (sys.budgetMs > 0 && usedMs + sys.budgetMs > budgetMs) continue;
    const t0 = hasPerf ? performance.now() : Date.now();
    sys.fn(world, deltaTime, frame);
    const dt = (hasPerf ? performance.now() : Date.now()) - t0;
    sys.lastMs = dt;
    usedMs += dt;
  }

  frame.totalMs = (hasPerf ? performance.now() : Date.now()) - now;
  frame.totalEntities = getEntityCount(world);
  frame.activeEntities = bitecs.query(world, [ActiveTag]).length;
}

// ============================================================================
// QUERY HELPERS
// ============================================================================

export const Queries = {
  renderables: (world) => bitecs.query(world, [Renderable, ActiveTag]),
  cameras: (world) => bitecs.query(world, [CameraTag]),
  lights: (world) => bitecs.query(world, [LightTag]),
  players: (world) => bitecs.query(world, [PlayerTag]),
  dynamicBodies: (world) => bitecs.query(world, [RigidBody, DynamicTag]),
  staticBodies: (world) => bitecs.query(world, [RigidBody, StaticTag]),
  colliders: (world) => bitecs.query(world, [Collider]),
  animating: (world) => bitecs.query(world, [Animation]),
  agents: (world) => bitecs.query(world, [AI, ActiveTag]),
  activeRenderables: (world) =>
    bitecs.query(world, [Renderable, ActiveTag, bitecs.Not(InactiveTag)]),
  ddEntities: (world) => bitecs.query(world, [TransformDD]),
  childrenOf: (world, parent) =>
    bitecs.query(world, [bitecs.Pair(ChildOf, parent)])
};

// ============================================================================
// SERIALIZATION WRAPPERS
// ============================================================================

const _serComponents = [
  Transform, Velocity, RigidBody, Collider,
  Material, Camera, Light, Health, AI, Animation,
  Renderable, MeshRef, MaterialRef, LODLevel, AwarenessLevel
];

export function serializeWorld(world, options = {}) {
  const entities = options.entities || bitecs.getAllEntities(world);
  const layout = options.layout || 'soa';
  const serializer =
    layout === 'aos'
      ? bitecs.createAoSSerializer(_serComponents, options)
      : bitecs.createSoASerializer(_serComponents, options);
  return serializer(entities);
}

export function deserializeWorld(world, packet, options = {}) {
  const layout = options.layout || 'soa';
  const deserializer =
    layout === 'aos'
      ? bitecs.createAoSDeserializer(_serComponents, options)
      : bitecs.createSoADeserializer(_serComponents, options);
  deserializer(packet, options.entityIdMapping);
}

// ============================================================================
// FLOATING ORIGIN INTEGRATION (dd-aware delta rebase)
// ============================================================================

export function rebaseWorldOrigin(world, newOriginX, newOriginY, newOriginZ) {
  const oldOX = Precision.getOriginX();
  const oldOY = Precision.getOriginY();
  const oldOZ = Precision.getOriginZ();

  const dxDD = DD.subtract(
    DD.fromDouble(newOriginX),
    DD.fromDouble(oldOX)
  );
  const dyDD = DD.subtract(
    DD.fromDouble(newOriginY),
    DD.fromDouble(oldOY)
  );
  const dzDD = DD.subtract(
    DD.fromDouble(newOriginZ),
    DD.fromDouble(oldOZ)
  );

  const deltaX = DD.toDouble(dxDD);
  const deltaY = DD.toDouble(dyDD);
  const deltaZ = DD.toDouble(dzDD);

  if (deltaX === 0 && deltaY === 0 && deltaZ === 0) {
    return [oldOX, oldOY, oldOZ];
  }

  Precision.rebaseOrigin(deltaX, deltaY, deltaZ);

  const all = bitecs.query(world, [Transform]);
  for (let i = 0; i < all.length; i++) {
    const eid = all[i];
    Transform.px[eid] -= deltaX;
    Transform.py[eid] -= deltaY;
    Transform.pz[eid] -= deltaZ;
  }

  const ddEntities = bitecs.query(world, [TransformDD]);
  for (let i = 0; i < ddEntities.length; i++) {
    const eid = ddEntities[i];
    const px = DD.subtract(
      [TransformDD.pxLo[eid], TransformDD.pxHi[eid]],
      dxDD
    );
    const py = DD.subtract(
      [TransformDD.pyLo[eid], TransformDD.pyHi[eid]],
      dyDD
    );
    const pz = DD.subtract(
      [TransformDD.pzLo[eid], TransformDD.pzHi[eid]],
      dzDD
    );
    TransformDD.pxLo[eid] = px[0];
    TransformDD.pxHi[eid] = px[1];
    TransformDD.pyLo[eid] = py[0];
    TransformDD.pyHi[eid] = py[1];
    TransformDD.pzLo[eid] = pz[0];
    TransformDD.pzHi[eid] = pz[1];
  }

  const grid = _spatialGrid.get(world);
  if (grid && grid.entityCell.length > 0) {
    for (let eid = 0; eid < grid.entityCell.length; eid++) {
      if (grid.entityCell[eid] !== undefined) {
        grid.entityCell[eid] = undefined;
      }
    }
    grid.cells.clear();
    for (let i = 0; i < all.length; i++) {
      const eid = all[i];
      if (bitecs.hasComponent(world, eid, Renderable)) {
        addToSpatialGrid(world, eid);
      }
    }
  }

  return [newOriginX, newOriginY, newOriginZ];
}

export function maybeRebaseToPlayer(world) {
  const state = _contextState.get(world);
  if (!state.playerEntity) return null;
  const eid = state.playerEntity;
  if (!bitecs.hasComponent(world, eid, Transform)) return null;
  const x = Transform.px[eid] + Precision.getOriginX();
  const y = Transform.py[eid] + Precision.getOriginY();
  const z = Transform.pz[eid] + Precision.getOriginZ();
  if (Precision.shouldRebase(x, y, z)) {
    return rebaseWorldOrigin(world, x, y, z);
  }
  return null;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { bitecs, Precision, DD };

export default {
  createGameWorld,
  destroyGameWorld,
  registerSystem,
  unregisterSystem,
  enableSystem,
  getSystems,
  spawnEntity,
  spawnMany,
  despawnEntity,
  despawnMany,
  isAlive,
  updateWorld,
  Queries,
  serializeWorld,
  deserializeWorld,
  rebaseWorldOrigin,
  maybeRebaseToPlayer,
  queryRadius,
  updateSpatialGrid,
  setInterestPoint,
  clearInterestPoints,
  updateContextAwareness,
  getWorldPosition,
  getLocalPosition,
  setWorldPosition,
  setRotation,
  getRotation,
  getFrameState,
  getNoise2D,
  getNoise3D,
  sampleTerrainHeight,
  enableTransformDD,
  getAbsolutePositionDD,
  setAbsolutePositionDD,
  addToAbsolutePositionDD,
  getAbsoluteDistanceSqDD,
  compareAbsoluteDistanceDD,
  Transform,
  TransformDD,
  Velocity,
  RigidBody,
  Collider,
  Renderable,
  MeshRef,
  MaterialRef,
  Material,
  Camera,
  Light,
  Health,
  AI,
  Animation,
  CameraTag,
  LightTag,
  PlayerTag,
  ChunkTag,
  StaticTag,
  DynamicTag,
  SleepingTag,
  ActiveTag,
  InactiveTag,
  LODLevel,
  AwarenessLevel,
  ChildOf
};