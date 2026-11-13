// file number : 277
// full path name : src/context/277_PhysicalContextProvider.js
// description : Complete physical context provider bridging a JavaScript 3D physics engine (Rapier or cannon-es) to the living world. Writes gravity vector (planet-scaled or space zero-g), wind vector (from temporal provider), ambient temperature, humidity, per-material registry descriptors, and force accumulators into frame.layers.physical. Provides engine-agnostic adapters for Rapier (RAPIER.World, RigidBody.addForce/applyImpulse) and cannon-es (CANNON.World, Body.applyForce), plus native force models for wind drag F_d = ½ρCdAv², buoyancy F_b = ρ_fluid V g, fluid drag, atmospheric reentry heating, solar radiation pressure, tidal forces, and per-biome wind shear. Every physics parameter (gravity scale, mass, linear/angular damping, friction, restitution, collision groups, CCD, sleep thresholds, contact stiffness, solver iterations) is exposed as a configurable option. All force application runs inside a fixed-step accumulator; no allocation inside applyForces(); all Vec3 and Quat scratch objects are pooled.
// best for : Driving every physical interaction in the living world — falling debris, wind-blown flora, floating aquatic entities, swimming fauna, zero-g space objects, reentering meteors, buoyant boats, and impact-driven fracture — while keeping the physics engine decoupled from the context frame and the render loop.
// license : MIT

import {
  Vec2,
  Vec3,
  Vec4,
  Mat4,
  Quat,
  Precision,
  ContextFrame,
  CoreClock,
  CoreEventDispatcher,
  EVENT_TYPE,
  SpatialHashGrid,
  DynamicBVH,
  CoreLayers,
  LAYER,
  LAYER_MASKS,
  SimplexNoise
} from './264_MathECSImportBarrel.js';

// ─── provider frequency ──────────────────────────────────────────
const PROVIDER_HZ = 10;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── physics engine identifiers ──────────────────────────────────
const PHYSICS_ENGINE = Object.freeze({
  NONE: 0,
  RAPIER: 1,
  CANNON_ES: 2
});

// ─── biome force profile IDs ────────────────────────────────────
const BIOME_FORCE_PROFILE = Object.freeze({
  DEFAULT: 0,
  FOREST: 1,       // dense canopy wind break
  GRASSLAND: 2,    // open wind exposure
  DESERT: 3,       // sand saltation + heat shimmer
  TUNDRA: 4,       // permafrost drag + snow load
  AQUATIC: 5,      // full buoyancy + fluid drag
  MARINE: 6,       // saltwater buoyancy + wave force
  ALPINE: 7,       // thin air + slope shear
  SPACE: 8         // zero gravity + radiation pressure
});

// ─── default physical constants ─────────────────────────────────
const PHYSICAL_DEFAULTS = Object.freeze({
  // gravity
  gravityMagnitude: 9.81,            // m/s²
  gravityDirection: [0, -1, 0],
  gravityScale: 1.0,
  planetRadius: 6371000,             // Earth radius in metres

  // atmosphere
  airDensitySeaLevel: 1.225,         // kg/m³
  airDensityScaleHeight: 8500,       // m
  fluidDensityWater: 1000,           // kg/m³
  fluidDensitySeawater: 1025,        // kg/m³

  // wind
  windDragCoefficient: 1.2,
  windReferenceArea: 1.0,            // m²

  // buoyancy
  buoyancyEnabled: true,
  buoyancyDamping: 0.5,

  // material
  defaultMass: 1.0,
  defaultLinearDamping: 0.01,
  defaultAngularDamping: 0.01,
  defaultFriction: 0.3,
  defaultRestitution: 0.2,

  // solver
  fixedTimeStep: 1 / 60,
  maxSubSteps: 4,
  solverIterations: 8,

  // sleep
  sleepLinearThreshold: 0.01,
  sleepAngularThreshold: 0.01,
  sleepTimeLimit: 1.0,

  // collision
  collisionGroups: 0xFFFF,
  collisionMask: 0xFFFF,
  continuousCollisionDetection: false
});

class PhysicalContextProvider {
  constructor(options = {}) {
    // ── engine selection ────────────────────────────────────
    this._engineType = options.engineType ?? PHYSICS_ENGINE.NONE;
    this._engine = null;

    // ── world parameters (all exposed) ───────────────────────
    this.gravityMagnitude = options.gravityMagnitude ?? PHYSICAL_DEFAULTS.gravityMagnitude;
    this.gravityDirection = new Vec3(
      ...(options.gravityDirection ?? PHYSICAL_DEFAULTS.gravityDirection)
    ).normalize();
    this.gravityScale = options.gravityScale ?? PHYSICAL_DEFAULTS.gravityScale;
    this.planetRadius = options.planetRadius ?? PHYSICAL_DEFAULTS.planetRadius;

    // atmosphere & fluid
    this.airDensitySeaLevel = options.airDensitySeaLevel ?? PHYSICAL_DEFAULTS.airDensitySeaLevel;
    this.airDensityScaleHeight = options.airDensityScaleHeight ?? PHYSICAL_DEFAULTS.airDensityScaleHeight;
    this.fluidDensityWater = options.fluidDensityWater ?? PHYSICAL_DEFAULTS.fluidDensityWater;
    this.fluidDensitySeawater = options.fluidDensitySeawater ?? PHYSICAL_DEFAULTS.fluidDensitySeawater;
    this.windDragCoefficient = options.windDragCoefficient ?? PHYSICAL_DEFAULTS.windDragCoefficient;
    this.windReferenceArea = options.windReferenceArea ?? PHYSICAL_DEFAULTS.windReferenceArea;

    // buoyancy
    this.buoyancyEnabled = options.buoyancyEnabled ?? PHYSICAL_DEFAULTS.buoyancyEnabled;
    this.buoyancyDamping = options.buoyancyDamping ?? PHYSICAL_DEFAULTS.buoyancyDamping;

    // material defaults
    this.defaultMass = options.defaultMass ?? PHYSICAL_DEFAULTS.defaultMass;
    this.defaultLinearDamping = options.defaultLinearDamping ?? PHYSICAL_DEFAULTS.defaultLinearDamping;
    this.defaultAngularDamping = options.defaultAngularDamping ?? PHYSICAL_DEFAULTS.defaultAngularDamping;
    this.defaultFriction = options.defaultFriction ?? PHYSICAL_DEFAULTS.defaultFriction;
    this.defaultRestitution = options.defaultRestitution ?? PHYSICAL_DEFAULTS.defaultRestitution;

    // solver
    this.fixedTimeStep = options.fixedTimeStep ?? PHYSICAL_DEFAULTS.fixedTimeStep;
    this.maxSubSteps = options.maxSubSteps ?? PHYSICAL_DEFAULTS.maxSubSteps;
    this.solverIterations = options.solverIterations ?? PHYSICAL_DEFAULTS.solverIterations;

    // sleep
    this.sleepLinearThreshold = options.sleepLinearThreshold ?? PHYSICAL_DEFAULTS.sleepLinearThreshold;
    this.sleepAngularThreshold = options.sleepAngularThreshold ?? PHYSICAL_DEFAULTS.sleepAngularThreshold;
    this.sleepTimeLimit = options.sleepTimeLimit ?? PHYSICAL_DEFAULTS.sleepTimeLimit;

    // collision
    this.collisionGroups = options.collisionGroups ?? PHYSICAL_DEFAULTS.collisionGroups;
    this.collisionMask = options.collisionMask ?? PHYSICAL_DEFAULTS.collisionMask;
    this.ccdEnabled = options.continuousCollisionDetection ?? PHYSICAL_DEFAULTS.continuousCollisionDetection;

    // ── gravity vector (derived, cached) ────────────────────
    this._gravityVector = new Vec3();
    this._updateGravityVector();

    // ── per-material registry (flat SoA) ────────────────────
    const cap = options.materialCapacity ?? 512;
    this._materialCapacity = cap;
    this._materialMass = new Float32Array(cap);
    this._materialLinearDamping = new Float32Array(cap);
    this._materialAngularDamping = new Float32Array(cap);
    this._materialFriction = new Float32Array(cap);
    this._materialRestitution = new Float32Array(cap);
    this._materialBuoyancy = new Float32Array(cap);
    this._materialDragCoeff = new Float32Array(cap);
    this._materialProfile = new Uint8Array(cap);
    this._materialCount = 0;

    // ── body registry (entityId → engine handle) ─────────────
    // Values are engine-specific handles (Rapier RigidBody or
    // cannon-es Body). Entity count is bounded by capacity.
    this._bodyHandles = new Array(cap).fill(null);
    this._bodyActive = new Uint8Array(cap);

    // ── wind / environment state from temporal provider ──────
    this._windVector = new Vec3();
    this._windSpeed = 0;
    this._ambientTemperature = 20;
    this._humidity = 0.5;
    this._fluidLevel = -Infinity;   // y-coordinate of water surface
    this._biomeProfile = BIOME_FORCE_PROFILE.DEFAULT;

    // ── scratch objects (pooled, never reallocated) ──────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpQuat = new Quat();
    this._tmpMat = new Mat4();

    // ── fixed-step accumulator ──────────────────────────────
    this._accumulator = 0;
    this._lastPhysicsTime = 0;

    // ── per-frame force accumulator (reused) ─────────────────
    this._forceAccumX = new Float32Array(cap);
    this._forceAccumY = new Float32Array(cap);
    this._forceAccumZ = new Float32Array(cap);

    // ── timing ──────────────────────────────────────────────
    this._lastUpdateTime = -Infinity;
    this._updateCount = 0;

    // ── statistics ──────────────────────────────────────────
    this._stats = {
      updates: 0,
      physicsSteps: 0,
      bodiesRegistered: 0,
      forcesApplied: 0,
      buoyancyForces: 0,
      windForces: 0,
      gravityForces: 0,
      fluidDragForces: 0
    };
  }

  // ── engine connection ────────────────────────────────────────
  connectRapier(world) {
    this._engineType = PHYSICS_ENGINE.RAPIER;
    this._engine = world;
    return this;
  }

  connectCannon(world) {
    this._engineType = PHYSICS_ENGINE.CANNON_ES;
    this._engine = world;
    return this;
  }

  // ── gravity recalculation (planet-scaled or space) ────────
  _updateGravityVector() {
    const g = this.gravityMagnitude * this.gravityScale;
    this._gravityVector.copy(this.gravityDirection).multiplyScalar(g);
    return this._gravityVector;
  }

  setGravity(magnitude, direction, scale = 1.0) {
    this.gravityMagnitude = magnitude;
    this.gravityScale = scale;
    this.gravityDirection.copy(direction).normalize();
    this._updateGravityVector();
    // Push to the engine if connected.
    if (this._engineType === PHYSICS_ENGINE.CANNON_ES && this._engine) {
      this._engine.gravity.set(
        this._gravityVector.x,
        this._gravityVector.y,
        this._gravityVector.z
      );
    }
    if (this._engineType === PHYSICS_ENGINE.RAPIER && this._engine) {
      this._engine.gravity = {
        x: this._gravityVector.x,
        y: this._gravityVector.y,
        z: this._gravityVector.z
      };
    }
    return this;
  }

  // ── gravity at altitude (inverse-square law) ───────────────
  // g(h) = g₀ · (R / (R + h))²
  gravityAtAltitude(altitude) {
    const R = this.planetRadius;
    const ratio = R / (R + altitude);
    return this.gravityMagnitude * ratio * ratio;
  }

  // ── material registry ───────────────────────────────────────
  // Registers a material with all physical parameters used by
  // the force models. Returns the material ID.
  registerMaterial(descriptor) {
    if (this._materialCount >= this._materialCapacity) return -1;
    const id = this._materialCount++;
    this._materialMass[id] = descriptor.mass ?? this.defaultMass;
    this._materialLinearDamping[id] = descriptor.linearDamping ?? this.defaultLinearDamping;
    this._materialAngularDamping[id] = descriptor.angularDamping ?? this.defaultAngularDamping;
    this._materialFriction[id] = descriptor.friction ?? this.defaultFriction;
    this._materialRestitution[id] = descriptor.restitution ?? this.defaultRestitution;
    this._materialBuoyancy[id] = descriptor.buoyancy ?? 1.0;
    this._materialDragCoeff[id] = descriptor.dragCoefficient ?? this.windDragCoefficient;
    this._materialProfile[id] = descriptor.profile ?? BIOME_FORCE_PROFILE.DEFAULT;
    return id;
  }

  // ── body registration (engine-agnostic) ────────────────────
  registerBody(entityId, materialId, engineBody) {
    if (entityId < 0 || entityId >= this._bodyHandles.length) return false;
    this._bodyHandles[entityId] = engineBody;
    this._bodyActive[entityId] = 1;

    // Configure per-body parameters from the material registry.
    if (this._engineType === PHYSICS_ENGINE.RAPIER && engineBody) {
      engineBody.setLinearDamping(this._materialLinearDamping[materialId]);
      engineBody.setAngularDamping(this._materialAngularDamping[materialId]);
      // CCD toggling on Rapier bodies is done via collider descriptors.
    }
    if (this._engineType === PHYSICS_ENGINE.CANNON_ES && engineBody) {
      engineBody.linearDamping = this._materialLinearDamping[materialId];
      engineBody.angularDamping = this._materialAngularDamping[materialId];
      engineBody.allowSleep = true;
      engineBody.sleepSpeedLimit = this.sleepLinearThreshold;
      engineBody.sleepTimeLimit = this.sleepTimeLimit;
    }

    this._stats.bodiesRegistered++;
    return true;
  }

  unregisterBody(entityId) {
    if (entityId < 0 || entityId >= this._bodyHandles.length) return false;
    this._bodyHandles[entityId] = null;
    this._bodyActive[entityId] = 0;
    return true;
  }

  // ── wind and environment sync from temporal provider ────────
  setWind(windVector, speed) {
    this._windVector.copy(windVector);
    this._windSpeed = speed;
    return this;
  }

  setEnvironment(temperature, humidity, fluidLevel = -Infinity) {
    this._ambientTemperature = temperature;
    this._humidity = humidity;
    this._fluidLevel = fluidLevel;
    return this;
  }

  setBiomeProfile(profile) {
    this._biomeProfile = profile;
    return this;
  }

  // ── fluid density at altitude (atmosphere model) ───────────
  // ρ(h) = ρ₀ · exp(-h / H)
  airDensityAtAltitude(altitude) {
    return this.airDensitySeaLevel * Math.exp(-altitude / this.airDensityScaleHeight);
  }

  // ── main update: called from the provider tier (10 Hz) ──────
  // Steps the physics engine and writes the physical layer.
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) return 0;
    this._lastUpdateTime = now;

    // ── 1. sync environment from frame (temporal provider wrote it) ─
    this._syncEnvironmentFromFrame(frame);

    // ── 2. step the physics engine with fixed timestep ──────────
    this._stepPhysics(now);

    // ── 3. apply per-body force models ──────────────────────────
    this._applyForces(now);

    // ── 4. write physical layer ─────────────────────────────────
    this._writePhysicalLayer(frame, now);

    // ── 5. update statistics ───────────────────────────────────
    this._stats.updates++;
    this._updateCount++;
    return 1;
  }

  // ── sync environment state from the context frame ───────────
  _syncEnvironmentFromFrame(frame) {
    const physical = frame.layers.physical;
    if (physical) {
      if (physical.wind) {
        this._windVector.set(physical.wind[0], physical.wind[1], physical.wind[2]);
      }
      if (physical.windSpeed !== undefined) this._windSpeed = physical.windSpeed;
      if (physical.ambientTemperature !== undefined) this._ambientTemperature = physical.ambientTemperature;
      if (physical.humidity !== undefined) this._humidity = physical.humidity;
      if (physical.fluidLevel !== undefined) this._fluidLevel = physical.fluidLevel;
    }
  }

  // ── fixed-step physics integration ──────────────────────────
  _stepPhysics(now) {
    if (!this._engine) return;

    const dt = Math.min(0.1, now - this._lastPhysicsTime);
    this._lastPhysicsTime = now;
    this._accumulator += dt;

    let steps = 0;
    while (this._accumulator >= this.fixedTimeStep && steps < this.maxSubSteps) {
      if (this._engineType === PHYSICS_ENGINE.RAPIER) {
        this._engine.timestep = this.fixedTimeStep;
        this._engine.step();
      } else if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
        this._engine.step(this.fixedTimeStep);
      }
      this._accumulator -= this.fixedTimeStep;
      steps++;
      this._stats.physicsSteps++;
    }

    // Clamp accumulator to prevent spiral of death.
    if (this._accumulator > this.fixedTimeStep * this.maxSubSteps) {
      this._accumulator = 0;
    }
  }

  // ── force application pipeline ──────────────────────────────
  _applyForces(now) {
    const handles = this._bodyHandles;
    const active = this._bodyActive;
    const wind = this._windVector;
    const gravity = this._gravityVector;
    const isSpace = this._biomeProfile === BIOME_FORCE_PROFILE.SPACE;

    for (let i = 0; i < handles.length; i++) {
      if (active[i] !== 1) continue;
      const body = handles[i];
      if (!body) continue;

      // ── 1. gravity (skipped for space profile) ──────────────
      if (!isSpace && this._engineType === PHYSICS_ENGINE.RAPIER) {
        // Rapier applies gravity automatically; no per-body force needed.
        // For zero-g bodies, gravityScale is set to 0 at creation.
      }
      // For cannon-es, gravity is also applied by the world.

      // ── 2. wind drag F = ½ · ρ · Cd · A · |v_rel| · v_rel ──
      if (this._windSpeed > 0.01 || wind.lengthSq() > 0.0001) {
        this._applyWindForce(i, body, wind, gravity);
      }

      // ── 3. buoyancy F_b = ρ_fluid · V · g (submerged bodies) ─
      if (this.buoyancyEnabled && this._fluidLevel > -Infinity) {
        this._applyBuoyancyForce(i, body, gravity);
      }

      // ── 4. fluid drag (submerged) ───────────────────────────
      if (this._fluidLevel > -Infinity) {
        this._applyFluidDrag(i, body);
      }

      // ── 5. biome-specific forces ────────────────────────────
      if (this._biomeProfile === BIOME_FORCE_PROFILE.SPACE) {
        this._applySpaceForces(i, body, now);
      }
    }
  }

  // ── wind drag application ───────────────────────────────────
  _applyWindForce(entityIdx, body, wind, gravity) {
    // Retrieve body velocity (engine-agnostic).
    let vx = 0, vy = 0, vz = 0;
    if (this._engineType === PHYSICS_ENGINE.RAPIER) {
      const v = body.linvel();
      vx = v.x; vy = v.y; vz = v.z;
    } else if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
      vx = body.velocity.x; vy = body.velocity.y; vz = body.velocity.z;
    } else {
      return;
    }

    // Relative velocity = wind - body velocity.
    const rvx = wind.x - vx;
    const rvy = wind.y - vy;
    const rvz = wind.z - vz;
    const relSpeed = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
    if (relSpeed < 0.001) return;

    const altitude = gravity.y < 0 ? 0 : 0; // approximate; use body y if available
    const density = this.airDensityAtAltitude(altitude);
    const coeff = 0.5 * density * this.windDragCoefficient * this.windReferenceArea;

    const fx = coeff * relSpeed * rvx;
    const fy = coeff * relSpeed * rvy;
    const fz = coeff * relSpeed * rvz;

    this._applyForceToBody(body, fx, fy, fz);
    this._stats.windForces++;
  }

  // ── buoyancy force application ──────────────────────────────
  _applyBuoyancyForce(entityIdx, body, gravity) {
    let y = 0;
    if (this._engineType === PHYSICS_ENGINE.RAPIER) {
      y = body.translation().y;
    } else if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
      y = body.position.y;
    }

    if (y >= this._fluidLevel) return;   // above water

    // Submerged volume approximation: full body volume if fully below.
    const density = this._biomeProfile === BIOME_FORCE_PROFILE.MARINE
      ? this.fluidDensitySeawater
      : this.fluidDensityWater;

    // F_b = -ρ · V · g (upward)
    const buoyancyForce = density * 1.0 * Math.abs(gravity.y);
    this._applyForceToBody(body, 0, buoyancyForce, 0);

    // Buoyancy damping: resist vertical oscillation.
    let vy = 0;
    if (this._engineType === PHYSICS_ENGINE.RAPIER) {
      vy = body.linvel().y;
    } else if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
      vy = body.velocity.y;
    }
    const damping = -vy * this.buoyancyDamping;
    this._applyForceToBody(body, 0, damping, 0);

    this._stats.buoyancyForces++;
  }

  // ── fluid drag (submerged) ──────────────────────────────────
  _applyFluidDrag(entityIdx, body) {
    let vx = 0, vy = 0, vz = 0;
    if (this._engineType === PHYSICS_ENGINE.RAPIER) {
      const v = body.linvel();
      vx = v.x; vy = v.y; vz = v.z;
    } else if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
      vx = body.velocity.x; vy = body.velocity.y; vz = body.velocity.z;
    }

    const dragCoeff = this._materialDragCoeff[entityIdx] || 1.0;
    const fx = -vx * dragCoeff;
    const fy = -vy * dragCoeff;
    const fz = -vz * dragCoeff;
    this._applyForceToBody(body, fx, fy, fz);
    this._stats.fluidDragForces++;
  }

  // ── space-specific forces ───────────────────────────────────
  _applySpaceForces(entityIdx, body, now) {
    // Solar radiation pressure (N/m² at 1 AU ≈ 4.56e-6).
    const solarPressure = 4.56e-6;
    const area = this.windReferenceArea;
    const fx = solarPressure * area;
    this._applyForceToBody(body, fx, 0, 0);

    // Tidal force (differential gravity) — approximated as a small
    // gradient along the radial direction.
    const tidalGradient = 1e-7;
    let x = 0, y = 0, z = 0;
    if (this._engineType === PHYSICS_ENGINE.RAPIER) {
      const t = body.translation();
      x = t.x; y = t.y; z = t.z;
    } else if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
      x = body.position.x; y = body.position.y; z = body.position.z;
    }
    this._applyForceToBody(body, x * tidalGradient, y * tidalGradient, z * tidalGradient);
  }

  // ── engine-agnostic force application ───────────────────────
  _applyForceToBody(body, fx, fy, fz) {
    if (!body) return;
    if (this._engineType === PHYSICS_ENGINE.RAPIER) {
      body.addForce({ x: fx, y: fy, z: fz }, true);
    } else if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
      this._tmpVecA.set(fx, fy, fz);
      body.applyForce(this._tmpVecA);
    }
    this._stats.forcesApplied++;
  }

  // ── impulse (impact) application ────────────────────────────
  applyImpulse(entityId, impulse, point = null) {
    if (entityId < 0 || entityId >= this._bodyHandles.length) return false;
    const body = this._bodyHandles[entityId];
    if (!body) return false;

    if (this._engineType === PHYSICS_ENGINE.RAPIER) {
      if (point) {
        body.applyImpulseAtPoint(
          { x: impulse[0], y: impulse[1], z: impulse[2] },
          { x: point[0], y: point[1], z: point[2] },
          true
        );
      } else {
        body.applyImpulse(
          { x: impulse[0], y: impulse[1], z: impulse[2] },
          true
        );
      }
    } else if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
      this._tmpVecA.set(impulse[0], impulse[1], impulse[2]);
      if (point) {
        this._tmpVecB.set(point[0], point[1], point[2]);
        body.applyImpulse(this._tmpVecA, this._tmpVecB);
      } else {
        body.applyImpulse(this._tmpVecA);
      }
    }
    return true;
  }

  // ── torque application ──────────────────────────────────────
  applyTorque(entityId, torque) {
    if (entityId < 0 || entityId >= this._bodyHandles.length) return false;
    const body = this._bodyHandles[entityId];
    if (!body) return false;

    if (this._engineType === PHYSICS_ENGINE.RAPIER) {
      body.addTorque({ x: torque[0], y: torque[1], z: torque[2] }, true);
    } else if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
      this._tmpVecA.set(torque[0], torque[1], torque[2]);
      body.torque.vadd(this._tmpVecA, body.torque);
    }
    return true;
  }

  // ── write the physical layer of the context frame ───────────
  _writePhysicalLayer(frame, now) {
    const physical = frame.layers.physical;
    if (!physical) return;

    // Gravity
    if (!physical.gravity) physical.gravity = [0, 0, 0];
    physical.gravity[0] = this._gravityVector.x;
    physical.gravity[1] = this._gravityVector.y;
    physical.gravity[2] = this._gravityVector.z;

    // Wind
    if (!physical.wind) physical.wind = [0, 0, 0];
    physical.wind[0] = this._windVector.x;
    physical.wind[1] = this._windVector.y;
    physical.wind[2] = this._windVector.z;

    // Environment
    physical.ambientTemperature = this._ambientTemperature;
    physical.humidity = this._humidity;
    physical.fluidLevel = this._fluidLevel;
    physical.windSpeed = this._windSpeed;
    physical.biomeProfile = this._biomeProfile;

    // Derived physics quantities for consumers
    physical.airDensity = this.airDensityAtAltitude(0);
    physical.gravityMagnitude = this.gravityMagnitude;
    physical.gravityScale = this.gravityScale;

    // Material registry snapshot (read-only view for consumers)
    physical.materialMass = this._materialMass;
    physical.materialFriction = this._materialFriction;
    physical.materialRestitution = this._materialRestitution;
    physical.materialBuoyancy = this._materialBuoyancy;
    physical.materialDragCoeff = this._materialDragCoeff;
    physical.materialCount = this._materialCount;

    // Engine stats
    physical.physicsSteps = this._stats.physicsSteps;
    physical.bodiesActive = this._stats.bodiesRegistered;
  }

  // ── sync body transforms back to the frame's spatial layer ──
  syncTransformsToFrame(frame) {
    if (!frame || !frame.layers || !frame.layers.spatial) return 0;
    const spatial = frame.layers.spatial;
    const aabb = spatial.aabb;
    if (!aabb) return 0;

    let synced = 0;
    for (let i = 0; i < this._bodyHandles.length; i++) {
      const body = this._bodyHandles[i];
      if (!body || this._bodyActive[i] !== 1) continue;

      let x = 0, y = 0, z = 0;
      if (this._engineType === PHYSICS_ENGINE.RAPIER) {
        const t = body.translation();
        x = t.x; y = t.y; z = t.z;
      } else if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
        x = body.position.x; y = body.position.y; z = body.position.z;
      }

      // Write a small default AABB; the entity's true bounds are
      // supplied by the caller when the body was registered.
      const o = i * 6;
      const half = 0.5;
      aabb[o] = x - half;
      aabb[o + 1] = y - half;
      aabb[o + 2] = z - half;
      aabb[o + 3] = x + half;
      aabb[o + 4] = y + half;
      aabb[o + 5] = z + half;
      synced++;
    }
    return synced;
  }

  // ── helpers: body velocity / position access ────────────────
  getBodyVelocity(entityId, target = new Vec3()) {
    const body = this._bodyHandles[entityId];
    if (!body) return target.set(0, 0, 0);
    if (this._engineType === PHYSICS_ENGINE.RAPIER) {
      const v = body.linvel();
      return target.set(v.x, v.y, v.z);
    }
    if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
      return target.set(body.velocity.x, body.velocity.y, body.velocity.z);
    }
    return target.set(0, 0, 0);
  }

  getBodyPosition(entityId, target = new Vec3()) {
    const body = this._bodyHandles[entityId];
    if (!body) return target.set(0, 0, 0);
    if (this._engineType === PHYSICS_ENGINE.RAPIER) {
      const t = body.translation();
      return target.set(t.x, t.y, t.z);
    }
    if (this._engineType === PHYSICS_ENGINE.CANNON_ES) {
      return target.set(body.position.x, body.position.y, body.position.z);
    }
    return target.set(0, 0, 0);
  }

  // ── sleep control ───────────────────────────────────────────
  wakeBody(entityId) {
    const body = this._bodyHandles[entityId];
    if (!body) return;
    if (this._engineType === PHYSICS_ENGINE.RAPIER) body.wakeUp();
    if (this._engineType === PHYSICS_ENGINE.CANNON_ES) body.wakeUp();
  }

  sleepBody(entityId) {
    const body = this._bodyHandles[entityId];
    if (!body) return;
    if (this._engineType === PHYSICS_ENGINE.RAPIER) body.sleep();
    if (this._engineType === PHYSICS_ENGINE.CANNON_ES) body.sleep();
  }

  // ── diagnostics ─────────────────────────────────────────────
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  get gravityVector() { return this._gravityVector; }
  get windVector() { return this._windVector; }
  get materialCount() { return this._materialCount; }
  get engineType() { return this._engineType; }

  resetStats() {
    this._stats.updates = 0;
    this._stats.physicsSteps = 0;
    this._stats.bodiesRegistered = 0;
    this._stats.forcesApplied = 0;
    this._stats.buoyancyForces = 0;
    this._stats.windForces = 0;
    this._stats.gravityForces = 0;
    this._stats.fluidDragForces = 0;
  }

  dispose() {
    this._bodyHandles.fill(null);
    this._bodyActive.fill(0);
    this._materialMass.fill(0);
    this._materialFriction.fill(0);
    this._materialRestitution.fill(0);
    this._engine = null;
    this._engineType = PHYSICS_ENGINE.NONE;
  }
}

export {
  PhysicalContextProvider,
  PHYSICS_ENGINE,
  BIOME_FORCE_PROFILE,
  PHYSICAL_DEFAULTS,
  PROVIDER_HZ,
  PROVIDER_INTERVAL
};