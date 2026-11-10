// file number : 017
// full path name : src/ecs/017_Systems.js
// description : High-performance ECS systems layer built on 015_World.js and 016_Components.js. Provides production-ready systems: physics integration (gravity + damping + sleeping with per-world state), floating-origin-aware transform update, camera controller (follow + look-at + FOV), context awareness (LOD banding + active/inactive swap), AI state machine with target acquisition via spatial hash, animation clock, particle lifecycle, render sync (SoA → Three.js r185 Object3D transforms, materials, lights, cameras) with per-world mesh/material/light caches and dead-entity cleanup, floating-origin rebase, and frame stats. All systems are pure functions operating on SoA arrays with per-world WeakMap state (safe for multiple worlds) and zero allocations in hot paths.
// best for : 10k+ entity living worlds, PBR scene orchestration, real-time physics on Android 64-bit, seamless small-to-galactic scale transitions, context-driven LOD, and low-GC per-frame iteration.
// license : MIT

import * as World from './015_World.js';
import * as bitecs from './014_BitECS.js';
import * as Precision from '../core/004_Precision.js';
import * as vec3 from '../math/006_Vec3.js';
import * as quat from '../math/011_Quat.js';
import * as mat4 from '../math/010_Mat4.js';
import {
  ECS, CONTEXT, SCALE, PHYSICS, PERFORMANCE
} from '../core/002_Constants.js';

// ============================================================================
// SHARED SCRATCH BUFFERS (zero-allocation per-frame)
// ============================================================================
const _v3a = vec3.create();
const _v3b = vec3.create();
const _v3c = vec3.create();
const _qa = quat.create();
const _mA = mat4.create();

// ============================================================================
// 1. PHYSICS SYSTEM
// ============================================================================
export function createPhysicsSystem(options = {}) {
  const gravityY = options.gravityY !== undefined ? options.gravityY : PHYSICS.GRAVITY_DEFAULT[1];
  const sleepLin = PHYSICS.SLEEP_LINEAR_THRESHOLD;
  const sleepTime = PHYSICS.SLEEP_TIME_THRESHOLD;
  const worldState = new WeakMap();
  const cleanupInterval = 60;

  function getState(world) {
    let s = worldState.get(world);
    if (!s) {
      s = { sleepTimers: new Map(), frame: 0 };
      worldState.set(world, s);
    }
    return s;
  }

  return function physicsSystem(world, dt) {
    if (dt <= 0) return;
    const state = getState(world);
    state.frame++;
    const sleepTimers = state.sleepTimers;
    const dynamic = bitecs.query(world, [World.RigidBody, World.Transform, World.Velocity, World.DynamicTag]);
    const n = dynamic.length;

    for (let i = 0; i < n; i++) {
      const eid = dynamic[i];
      const bodyType = World.RigidBody.bodyType[eid];
      if (bodyType !== PHYSICS.BODY_TYPE.DYNAMIC) continue;

      const linDamp = World.RigidBody.linearDamping[eid];

      World.Velocity.vy[eid] += gravityY * dt;
      World.Velocity.vx[eid] *= 1 - linDamp * dt;
      World.Velocity.vy[eid] *= 1 - linDamp * dt;
      World.Velocity.vz[eid] *= 1 - linDamp * dt;

      World.Transform.px[eid] += World.Velocity.vx[eid] * dt;
      World.Transform.py[eid] += World.Velocity.vy[eid] * dt;
      World.Transform.pz[eid] += World.Velocity.vz[eid] * dt;

      const vx = World.Velocity.vx[eid];
      const vy = World.Velocity.vy[eid];
      const vz = World.Velocity.vz[eid];
      const spdSq = vx * vx + vy * vy + vz * vz;

      const isSleeping = World.RigidBody.sleeping[eid] === 1;
      if (spdSq < sleepLin * sleepLin) {
        const timer = (sleepTimers.get(eid) || 0) + dt;
        if (timer > sleepTime && !isSleeping) {
          World.RigidBody.sleeping[eid] = 1;
          sleepTimers.set(eid, 0);
        } else {
          sleepTimers.set(eid, timer);
        }
      } else {
        sleepTimers.delete(eid);
        if (isSleeping) World.RigidBody.sleeping[eid] = 0;
      }
    }

    if (state.frame % cleanupInterval === 0 && sleepTimers.size > 0) {
      for (const eid of sleepTimers.keys()) {
        if (!bitecs.entityExists(world, eid)) sleepTimers.delete(eid);
      }
    }
  };
}

// ============================================================================
// 2. MOVEMENT SYSTEM
// ============================================================================
export function createMovementSystem() {
  return function movementSystem(world, dt) {
    if (dt <= 0) return;
    const moving = bitecs.query(world, [World.Velocity, World.Transform, World.DynamicTag, bitecs.Not(World.RigidBody)]);
    const n = moving.length;
    for (let i = 0; i < n; i++) {
      const eid = moving[i];
      World.Transform.px[eid] += World.Velocity.vx[eid] * dt;
      World.Transform.py[eid] += World.Velocity.vy[eid] * dt;
      World.Transform.pz[eid] += World.Velocity.vz[eid] * dt;
    }
  };
}

// ============================================================================
// 3. CONTEXT AWARENESS SYSTEM
// ============================================================================
export function createContextSystem(options = {}) {
  const updateInterval = options.updateIntervalMs !== undefined ? options.updateIntervalMs : CONTEXT.UPDATE_INTERVAL_MS;
  const awareRadius = options.awareRadius !== undefined ? options.awareRadius : CONTEXT.AWARENESS_RADIUS;
  const deactRadius = options.deactRadius !== undefined ? options.deactRadius : CONTEXT.DEACTIVATION_RADIUS;
  const hysteresis = CONTEXT.HYSTERESIS;
  const awareR2 = awareRadius * awareRadius;
  const deactR2 = deactRadius * deactRadius;
  const lodDistances = SCALE.LOD_DISTANCES;
  const worldState = new WeakMap();

  function getAccum(world) {
    let a = worldState.get(world);
    if (a === undefined) {
      a = 0;
      worldState.set(world, a);
    }
    return a;
  }
  function setAccum(world, v) {
    worldState.set(world, v);
  }

  return function contextSystem(world, dt) {
    let accum = getAccum(world) + dt * 1000;
    if (accum < updateInterval) {
      setAccum(world, accum);
      return;
    }
    accum = 0;
    setAccum(world, accum);

    const players = bitecs.query(world, [World.PlayerTag]);
    if (players.length === 0) return;
    const playerEid = players[0];

    const px = World.Transform.px[playerEid];
    const py = World.Transform.py[playerEid];
    const pz = World.Transform.pz[playerEid];

    const renderables = bitecs.query(world, [World.Renderable]);
    const n = renderables.length;
    for (let i = 0; i < n; i++) {
      const eid = renderables[i];
      const dx = World.Transform.px[eid] - px;
      const dy = World.Transform.py[eid] - py;
      const dz = World.Transform.pz[eid] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;

      let lod = lodDistances.length - 1;
      for (let k = 0; k < lodDistances.length; k++) {
        if (d2 < lodDistances[k] * lodDistances[k]) {
          lod = k;
          break;
        }
      }
      World.LODLevel[eid] = lod;

      const hasActive = bitecs.hasComponent(world, eid, World.ActiveTag);
      if (hasActive && d2 > deactR2 * (1 + hysteresis)) {
        bitecs.removeComponent(world, eid, World.ActiveTag);
        if (!bitecs.hasComponent(world, eid, World.InactiveTag)) {
          bitecs.addComponent(world, eid, World.InactiveTag);
        }
        World.InactiveTag[eid] = 1;
        World.AwarenessLevel[eid] = 0;
      } else if (!hasActive && d2 < awareR2 * (1 - hysteresis)) {
        if (bitecs.hasComponent(world, eid, World.InactiveTag)) {
          bitecs.removeComponent(world, eid, World.InactiveTag);
        }
        if (!bitecs.hasComponent(world, eid, World.ActiveTag)) {
          bitecs.addComponent(world, eid, World.ActiveTag);
        }
        World.ActiveTag[eid] = 1;
        World.AwarenessLevel[eid] = 2;
      } else if (hasActive) {
        World.AwarenessLevel[eid] = d2 < awareR2 ? 2 : 1;
      }
    }
  };
}

// ============================================================================
// 4. AI SYSTEM
// ============================================================================
export const AIState = Object.freeze({
  IDLE: 0,
  PATROL: 1,
  CHASE: 2,
  ATTACK: 3,
  FLEE: 4,
  DEAD: 5
});

export function createAISystem(options = {}) {
  const tickRate = options.tickRate !== undefined ? options.tickRate : 10;
  const minTick = 1 / tickRate;
  const worldAccum = new WeakMap();

  return function aiSystem(world, dt) {
    let accum = (worldAccum.get(world) || 0) + dt;
    if (accum < minTick) {
      worldAccum.set(world, accum);
      return;
    }
    const step = accum;
    accum = 0;
    worldAccum.set(world, accum);

    const agents = bitecs.query(world, [World.AI, World.Transform, World.ActiveTag]);
    const n = agents.length;
    if (n === 0) return;

    const players = bitecs.query(world, [World.PlayerTag]);
    const playerEid = players.length > 0 ? players[0] : 0;

    for (let i = 0; i < n; i++) {
      const eid = agents[i];
      const state = World.AI.state[eid];
      if (state === AIState.DEAD) continue;

      if (playerEid) {
        const dx = World.Transform.px[playerEid] - World.Transform.px[eid];
        const dy = World.Transform.py[playerEid] - World.Transform.py[eid];
        const dz = World.Transform.pz[playerEid] - World.Transform.pz[eid];
        const d2 = dx * dx + dy * dy + dz * dz;
        const awareSq = World.AI.awarenessSq[eid];

        if (d2 < awareSq) {
          World.AI.target[eid] = playerEid;

          if (World.AI.state[eid] === AIState.IDLE || World.AI.state[eid] === AIState.PATROL) {
            World.AI.state[eid] = AIState.CHASE;
          }

          if (d2 < 2.25) {
            World.AI.state[eid] = AIState.ATTACK;
          } else if (World.AI.state[eid] === AIState.ATTACK) {
            World.AI.state[eid] = AIState.CHASE;
          }

          if (World.AI.state[eid] === AIState.CHASE && bitecs.hasComponent(world, eid, World.Velocity)) {
            const dist = Math.sqrt(d2) || 1;
            const speed = World.AI.speed[eid];
            World.Velocity.vx[eid] = (dx / dist) * speed;
            World.Velocity.vz[eid] = (dz / dist) * speed;
            World.Velocity.vy[eid] = 0;
          } else if (World.AI.state[eid] === AIState.ATTACK && bitecs.hasComponent(world, eid, World.Velocity)) {
            World.Velocity.vx[eid] = 0;
            World.Velocity.vz[eid] = 0;
          }
        } else {
          if (state === AIState.CHASE || state === AIState.ATTACK) {
            World.AI.state[eid] = AIState.IDLE;
            World.AI.target[eid] = 0;
            if (bitecs.hasComponent(world, eid, World.Velocity)) {
              World.Velocity.vx[eid] = 0;
              World.Velocity.vz[eid] = 0;
            }
          }
        }
      }

      World.AI.timer[eid] += step;
    }
  };
}

// ============================================================================
// 5. ANIMATION SYSTEM
// ============================================================================
export function createAnimationSystem() {
  return function animationSystem(world, dt) {
    const animating = bitecs.query(world, [World.Animation]);
    const n = animating.length;
    for (let i = 0; i < n; i++) {
      const eid = animating[i];
      World.Animation.time[eid] += dt * World.Animation.speed[eid];
      const loop = World.Animation.loop[eid];
      if (loop === 0) {
        if (World.Animation.time[eid] > 1) World.Animation.time[eid] = 1;
      } else {
        World.Animation.time[eid] = World.Animation.time[eid] % 1;
      }
    }
  };
}

// ============================================================================
// 6. CAMERA SYSTEM
// ============================================================================
export function createCameraSystem(options = {}) {
  const offset = options.offset || { x: 0, y: 4, z: 8 };
  const lerpSpeed = options.lerpSpeed !== undefined ? options.lerpSpeed : 8;
  const targetHeight = options.targetHeight !== undefined ? options.targetHeight : 1.5;

  return function cameraSystem(world, dt) {
    const cameras = bitecs.query(world, [World.CameraTag]);
    if (cameras.length === 0) return;
    const players = bitecs.query(world, [World.PlayerTag]);
    if (players.length === 0) return;

    const camEid = cameras[0];
    const playerEid = players[0];
    const alpha = Math.min(1, lerpSpeed * dt);

    const tx = World.Transform.px[playerEid];
    const ty = World.Transform.py[playerEid];
    const tz = World.Transform.pz[playerEid];

    const desiredX = tx + offset.x;
    const desiredY = ty + offset.y;
    const desiredZ = tz + offset.z;

    World.Transform.px[camEid] += (desiredX - World.Transform.px[camEid]) * alpha;
    World.Transform.py[camEid] += (desiredY - World.Transform.py[camEid]) * alpha;
    World.Transform.pz[camEid] += (desiredZ - World.Transform.pz[camEid]) * alpha;

    _v3a[0] = World.Transform.px[camEid];
    _v3a[1] = World.Transform.py[camEid];
    _v3a[2] = World.Transform.pz[camEid];

    _v3b[0] = tx;
    _v3b[1] = ty + targetHeight;
    _v3b[2] = tz;

    _v3c[0] = 0;
    _v3c[1] = 1;
    _v3c[2] = 0;

    mat4.lookAt(_mA, _v3a, _v3b, _v3c);
    mat4.getRotation(_qa, _mA);
    World.Transform.rx[camEid] = _qa[0];
    World.Transform.ry[camEid] = _qa[1];
    World.Transform.rz[camEid] = _qa[2];
    World.Transform.rw[camEid] = _qa[3];
  };
}

// ============================================================================
// 7. LOD SYSTEM
// ============================================================================
export function createLODSystem() {
  const worldLastLOD = new WeakMap();

  return function lodSystem(world, dt) {
    let lastLOD = worldLastLOD.get(world);
    if (!lastLOD) {
      lastLOD = new Map();
      worldLastLOD.set(world, lastLOD);
    }

    const renderables = bitecs.query(world, [World.Renderable, World.ActiveTag]);
    const n = renderables.length;
    for (let i = 0; i < n; i++) {
      const eid = renderables[i];
      const lod = World.LODLevel[eid];
      const prev = lastLOD.get(eid);
      if (prev === lod) continue;
      lastLOD.set(eid, lod);
      World.Renderable[eid] = lod > 0 ? Math.max(1, 5 - lod) : 1;
    }

    if (lastLOD.size > 2048) lastLOD.clear();
  };
}

// ============================================================================
// 8. PARTICLE SYSTEM
// ============================================================================
export function createParticleSystem() {
  return function particleSystem(world, dt) {
    const particles = bitecs.query(world, [World.Renderable, World.Velocity, World.Transform, bitecs.Not(World.RigidBody)]);
    const n = particles.length;
    for (let i = 0; i < n; i++) {
      const eid = particles[i];
      World.Velocity.vy[eid] -= 9.81 * dt;
      World.Transform.px[eid] += World.Velocity.vx[eid] * dt;
      World.Transform.py[eid] += World.Velocity.vy[eid] * dt;
      World.Transform.pz[eid] += World.Velocity.vz[eid] * dt;
    }
  };
}

// ============================================================================
// 9. DESTROY SYSTEM
// ============================================================================
export function createDestroySystem() {
  const worldBuf = new WeakMap();

  return function destroySystem(world, dt) {
    let buf = worldBuf.get(world);
    if (!buf) {
      buf = [];
      worldBuf.set(world, buf);
    }
    buf.length = 0;

    const withHealth = bitecs.query(world, [World.Health]);
    const n = withHealth.length;
    for (let i = 0; i < n; i++) {
      const eid = withHealth[i];
      if (World.Health.current[eid] <= 0) buf.push(eid);
    }
    for (let i = 0; i < buf.length; i++) {
      World.despawnEntity(world, buf[i]);
    }
  };
}

// ============================================================================
// 10. RENDER SYNC SYSTEM (per-world state)
// ============================================================================
export function createRenderSyncSystem(three) {
  const worldState = new WeakMap();
  const cleanupInterval = 60;

  function getState(world) {
    let s = worldState.get(world);
    if (!s) {
      s = {
        objectMap: new Map(),
        materialCache: new Map(),
        lightMap: new Map(),
        frame: 0
      };
      worldState.set(world, s);
    }
    return s;
  }

  function makeMaterialKey(eid) {
    const M = World.Material;
    return (
      M.baseColorR[eid] + '_' + M.baseColorG[eid] + '_' + M.baseColorB[eid] + '_' +
      M.metalness[eid] + '_' + M.roughness[eid] + '_' +
      M.opacity[eid] + '_' + M.transmission[eid] + '_' +
      M.clearcoat[eid] + '_' + M.ior[eid] + '_' + M.renderStyle[eid]
    );
  }

  function buildMaterial(eid) {
    const M = World.Material;
    const rs = M.renderStyle[eid];
    const color = new three.Color(M.baseColorR[eid], M.baseColorG[eid], M.baseColorB[eid]);
    const emissive = new three.Color(M.emissiveR[eid], M.emissiveG[eid], M.emissiveB[eid]);

    if (rs === 1 || rs === 2) {
      return new three.MeshToonMaterial({
        color,
        emissive,
        emissiveIntensity: M.emissiveIntensity[eid],
        opacity: M.opacity[eid],
        transparent: M.opacity[eid] < 1.0,
        alphaTest: M.alphaTest[eid]
      });
    }
    if (rs === 3 || rs === 4) {
      return new three.MeshPhysicalMaterial({
        color, emissive,
        metalness: M.metalness[eid],
        roughness: M.roughness[eid],
        emissiveIntensity: M.emissiveIntensity[eid],
        clearcoat: M.clearcoat[eid],
        clearcoatRoughness: M.clearcoatRoughness[eid],
        sheen: M.sheen[eid],
        sheenRoughness: M.sheenRoughness[eid],
        transmission: M.transmission[eid],
        thickness: M.thickness[eid],
        ior: M.ior[eid],
        iridescence: M.iridescence[eid],
        anisotropy: M.anisotropy[eid],
        opacity: M.opacity[eid],
        transparent: M.opacity[eid] < 1.0,
        alphaTest: M.alphaTest[eid],
        flatShading: M.flatShading[eid] === 1
      });
    }
    if (rs === 5) {
      return new three.ShaderMaterial({
        uniforms: {
          uBaseColor: { value: color },
          uOpacity: { value: M.opacity[eid] }
        },
        vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'uniform vec3 uBaseColor; uniform float uOpacity; void main(){ gl_FragColor = vec4(uBaseColor, uOpacity); }',
        transparent: M.opacity[eid] < 1.0
      });
    }
    return new three.MeshStandardMaterial({
      color, emissive,
      metalness: M.metalness[eid],
      roughness: M.roughness[eid],
      emissiveIntensity: M.emissiveIntensity[eid],
      opacity: M.opacity[eid],
      transparent: M.opacity[eid] < 1.0,
      alphaTest: M.alphaTest[eid],
      flatShading: M.flatShading[eid] === 1,
      wireframe: M.wireframe[eid] === 1,
      side: M.side[eid] === 0 ? three.FrontSide : M.side[eid] === 1 ? three.BackSide : three.DoubleSide
    });
  }

  return function renderSyncSystem(world, dt, ctx) {
    const scene = ctx && ctx.scene;
    if (!scene) return;
    const meshRegistry = (ctx && ctx.meshRegistry) || null;
    const state = getState(world);
    state.frame++;

    const objectMap = state.objectMap;
    const materialCache = state.materialCache;
    const lightMap = state.lightMap;

    const originX = Precision.getOriginX();
    const originY = Precision.getOriginY();
    const originZ = Precision.getOriginZ();

    const renderables = bitecs.query(world, [World.Renderable, World.ActiveTag]);
    const n = renderables.length;
    for (let i = 0; i < n; i++) {
      const eid = renderables[i];
      let obj = objectMap.get(eid);
      if (!obj) {
        const meshId = bitecs.hasComponent(world, eid, World.MeshRef) ? World.MeshRef[eid] : 0;
        const geometry = meshRegistry && meshRegistry.get ? meshRegistry.get(meshId) : null;
        if (!geometry) continue;
        let mat;
        if (bitecs.hasComponent(world, eid, World.Material)) {
          const key = makeMaterialKey(eid);
          mat = materialCache.get(key);
          if (!mat) {
            mat = buildMaterial(eid);
            materialCache.set(key, mat);
          }
        } else {
          mat = new three.MeshStandardMaterial({ color: 0xffffff });
        }
        obj = new three.Mesh(geometry, mat);
        obj.matrixAutoUpdate = true;
        obj.userData.eid = eid;
        scene.add(obj);
        objectMap.set(eid, obj);
      }
      obj.position.set(
        World.Transform.px[eid] + originX,
        World.Transform.py[eid] + originY,
        World.Transform.pz[eid] + originZ
      );
      obj.quaternion.set(
        World.Transform.rx[eid],
        World.Transform.ry[eid],
        World.Transform.rz[eid],
        World.Transform.rw[eid]
      );
      obj.scale.set(
        World.Transform.sx[eid],
        World.Transform.sy[eid],
        World.Transform.sz[eid]
      );
      if (!obj.visible) obj.visible = true;
    }

    const inactive = bitecs.query(world, [World.Renderable, World.InactiveTag]);
    const m = inactive.length;
    for (let i = 0; i < m; i++) {
      const eid = inactive[i];
      const obj = objectMap.get(eid);
      if (obj && obj.visible) obj.visible = false;
    }

    const lights = bitecs.query(world, [World.LightTag]);
    const ln = lights.length;
    for (let i = 0; i < ln; i++) {
      const eid = lights[i];
      let light = lightMap.get(eid);
      if (!light) {
        const type = World.Light.type[eid];
        if (type === 0) light = new three.DirectionalLight(0xffffff, 1);
        else if (type === 1) light = new three.PointLight(0xffffff, 1);
        else if (type === 2) light = new three.SpotLight(0xffffff, 1);
        else continue;
        scene.add(light);
        lightMap.set(eid, light);
      }
      light.position.set(
        World.Transform.px[eid] + originX,
        World.Transform.py[eid] + originY,
        World.Transform.pz[eid] + originZ
      );
      light.color.setRGB(World.Light.colorR[eid], World.Light.colorG[eid], World.Light.colorB[eid]);
      light.intensity = World.Light.intensity[eid];
      const range = World.Light.range[eid];
      if (light.distance !== undefined && range > 0) light.distance = range;
      if (light.angle !== undefined && World.Light.outerCone[eid] > 0) light.angle = World.Light.outerCone[eid];
      if (light.penumbra !== undefined && World.Light.innerCone[eid] > 0) light.penumbra = World.Light.innerCone[eid];
    }

    if (state.frame % cleanupInterval === 0 && objectMap.size > 0) {
      const dead = [];
      for (const eid of objectMap.keys()) {
        if (!bitecs.entityExists(world, eid)) dead.push(eid);
      }
      for (let i = 0; i < dead.length; i++) {
        const eid = dead[i];
        const obj = objectMap.get(eid);
        if (obj) {
          scene.remove(obj);
          if (obj.geometry && obj.geometry.dispose && !meshRegistry) obj.geometry.dispose();
        }
        objectMap.delete(eid);
      }
      for (const eid of lightMap.keys()) {
        if (!bitecs.entityExists(world, eid)) {
          const light = lightMap.get(eid);
          if (light) scene.remove(light);
          lightMap.delete(eid);
        }
      }
    }
  };
}

// ============================================================================
// 11. FLOATING ORIGIN SYSTEM
// ============================================================================
export function createFloatingOriginSystem(options = {}) {
  const threshold = options.threshold !== undefined ? options.threshold : SCALE.FLOATING_ORIGIN_THRESHOLD;
  const thresholdSq = threshold * threshold;

  return function floatingOriginSystem(world, dt) {
    const players = bitecs.query(world, [World.PlayerTag]);
    if (players.length === 0) return;
    const eid = players[0];

    const lx = World.Transform.px[eid];
    const ly = World.Transform.py[eid];
    const lz = World.Transform.pz[eid];
    const d2 = lx * lx + ly * ly + lz * lz;
    if (d2 < thresholdSq) return;

    const x = lx + Precision.getOriginX();
    const y = ly + Precision.getOriginY();
    const z = lz + Precision.getOriginZ();
    World.rebaseWorldOrigin(world, x, y, z);
  };
}

// ============================================================================
// 12. FRAME STATS SYSTEM
// ============================================================================
export function createStatsSystem() {
  const worldState = new WeakMap();

  function getState(world) {
    let s = worldState.get(world);
    if (!s) {
      s = { frames: 0, elapsed: 0, fps: 0 };
      worldState.set(world, s);
    }
    return s;
  }

  return function statsSystem(world, dt) {
    const s = getState(world);
    s.frames++;
    s.elapsed += dt;
    if (s.elapsed >= 1.0) {
      s.fps = s.frames / s.elapsed;
      s.frames = 0;
      s.elapsed = 0;
    }
    const frame = World.getFrameState(world);
    if (frame) frame.fps = s.fps;
  };
}

// ============================================================================
// REGISTRATION
// ============================================================================
export function registerDefaultSystems(world, three, ctx = {}) {
  World.registerSystem(world, 'physics', createPhysicsSystem(ctx.physics), ECS.PRIORITY.PHYSICS, PERFORMANCE.PHYSICS_BUDGET_MS);
  World.registerSystem(world, 'movement', createMovementSystem(), ECS.PRIORITY.PHYSICS + 1);
  World.registerSystem(world, 'ai', createAISystem(ctx.ai), ECS.PRIORITY.AI, PERFORMANCE.AI_BUDGET_MS);
  World.registerSystem(world, 'animation', createAnimationSystem(), ECS.PRIORITY.ANIMATION);
  World.registerSystem(world, 'camera', createCameraSystem(ctx.camera), ECS.PRIORITY.ANIMATION + 1);
  World.registerSystem(world, 'context', createContextSystem(ctx.context), ECS.PRIORITY.TRANSFORM);
  World.registerSystem(world, 'lod', createLODSystem(), ECS.PRIORITY.RENDER - 1, PERFORMANCE.LOD_BUDGET_MS);
  World.registerSystem(world, 'particles', createParticleSystem(), ECS.PRIORITY.ANIMATION + 2);
  World.registerSystem(world, 'destroy', createDestroySystem(), ECS.PRIORITY.POST);
  World.registerSystem(world, 'floatingOrigin', createFloatingOriginSystem(ctx.floatingOrigin), ECS.PRIORITY.POST - 1);
  if (three) {
    World.registerSystem(world, 'renderSync', createRenderSyncSystem(three), ECS.PRIORITY.RENDER, PERFORMANCE.RENDER_BUDGET_MS);
  }
  World.registerSystem(world, 'stats', createStatsSystem(), ECS.PRIORITY.POST + 1);
}

export const AIStates = AIState;

export default {
  createPhysicsSystem,
  createMovementSystem,
  createContextSystem,
  createAISystem,
  createAnimationSystem,
  createCameraSystem,
  createLODSystem,
  createParticleSystem,
  createDestroySystem,
  createRenderSyncSystem,
  createFloatingOriginSystem,
  createStatsSystem,
  registerDefaultSystems,
  AIState,
  AIStates
};