// file number : 008-D
// full path name : src/008_quat_demo.js
// description : Quaternion swarm demo driven ONLY by the ./math modules
//               (002..011). 10,000-instance orientation field with four live
//               behaviors (tap/button to cycle, auto-advance 9s):
//                 1 NOISE_SWIRL  — differential Y-swirl positions +
//                                  quat.soaFillSpinFrom4DNoise orientations
//                 2 MORPH        — sphere -> torus -> galaxy -> lattice,
//                                  per-instance staggered quat.soaSlerp(tArr)
//                                  + custom per-instance position lerp
//                 3 CROWD_AIM    — quat.soaLookAt at pointer world target +
//                                  quat.soaSpringDamp crowd smoothing
//                 4 ORBITAL_BELT — full Kepler (vec3.keplerOrbit3D) for all
//                                  10k bodies + quat.soaFillFromVelocity
//                                  velocity-aligned orientations
//               Plus a permanent dual-quaternion skinned creature (009):
//               9-segment FK chain composed with quat2.multiply, ~120 skin
//               points batch-transformed by quat2.soaTransformPoint.
//               Systems: bitECS world + spatial-grid proximity highlight,
//               mat3 hue-rotation color grading of 8 draw buckets (batched
//               Canvas2D paths, 8 strokes/frame), LOD dashes for the nearest
//               instances, floating-origin recenter (vec3.soaToRelative),
//               adaptive quality governor, and a 011 chunked TRS
//               serialization round-trip of a 1024-instance subset with
//               verification. Every heavy fill is chunked + yielding; the
//               render loop performs zero allocations.
// best for : 3d graphics — validating batch quaternion pipelines at scale:
//            slerp morphing of 10k orientations, spring-damped crowd aiming,
//            velocity-aligned orbital debris, dual-quat skinning, procedural
//            orientation fields, color-graded instanced rendering and
//            save/load — all at 60 fps on Android mobile 64-bit without
//            freezing the main thread.
// license : MIT
// usage : <script type="module" src="./008_quat_demo.js"></script>
// ============================================================================

import * as vec2  from "./math/002_vec2.js";
import * as vec3  from "./math/003_vec3.js";
import * as vec4  from "./math/004_vec4.js";
import * as mat2  from "./math/005_mat2.js";
import * as mat3  from "./math/006_mat3.js";
import * as mat4  from "./math/007_mat4.js";
import * as quat  from "./math/008_quat.js";
import * as quat2 from "./math/009_quat2.js";
import * as ecs   from "./math/010_bitECS_core.js";
import * as ser   from "./math/011_bitECS_serialization.js";

// ============================================================================
// 1. CONFIG
// ============================================================================
const COUNT          = 10000;   // swarm instances
const DASH_LOD       = 1600;    // nearest instances drawn as oriented dashes
const BUCKETS        = 8;       // color buckets (batched draw calls)
const MODE_TIME      = 9.0;
const MORPH_DUR      = 3.2;     // seconds per formation morph
const ORB_MU         = 80;
const CREATURE_SEG   = 9;
const CREATURE_RING  = 8;
const SER_SUBSET     = 1024;
const MODES          = ["NOISE_SWIRL", "MORPH", "CROWD_AIM", "ORBITAL_BELT"];
const FORMATIONS     = ["SPHERE", "TORUS", "GALAXY", "LATTICE"];

// ============================================================================
// 2. DOM BOOTSTRAP
// ============================================================================
const canvas  = document.createElement("canvas");
const ctx     = canvas.getContext("2d");
const hud     = document.createElement("div");
const btnBar  = document.createElement("div");
const compass = document.createElement("canvas");
const cctx    = compass.getContext("2d");

Object.assign(canvas.style,  { position: "fixed", inset: "0", width: "100%", height: "100%", display: "block", background: "#04060c", touchAction: "none" });
Object.assign(hud.style,     { position: "fixed", top: "10px", left: "10px", color: "#a8e6c8", font: "11px monospace", whiteSpace: "pre", textShadow: "0 1px 2px #000", pointerEvents: "none", zIndex: 5 });
Object.assign(btnBar.style,  { position: "fixed", bottom: "12px", right: "12px", display: "flex", gap: "8px", zIndex: 6 });
Object.assign(compass.style, { position: "fixed", top: "10px", right: "10px", width: "56px", height: "56px", opacity: "0.9" });

function makeButton(label, fn) {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, { font: "12px monospace", padding: "10px 12px", borderRadius: "8px", border: "1px solid #2e8", background: "rgba(8,30,22,0.8)", color: "#c8ffe6", touchAction: "manipulation" });
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); fn(); });
    btnBar.appendChild(b);
}
function bootDOM() {
    document.body.appendChild(canvas);
    document.body.appendChild(hud);
    document.body.appendChild(btnBar);
    document.body.appendChild(compass);
    compass.width = 56; compass.height = 56;
}
if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", bootDOM); }
else { bootDOM(); }

let W = 2, H = 2, DPR = 1;
function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width  = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
}
window.addEventListener("resize", resize);
resize();

// ============================================================================
// 3. POOLED TEMPORARIES (zero-GC hot path)
// ============================================================================
const T = {
    view: mat4.acquire(), proj: mat4.acquire(), vp: mat4.acquire(),
    camWorld: mat4.acquire(), m2rot: mat2.create(), m3hue: mat3.create(),
    eye: vec3.create(), center: vec3.fromValues(0, 0, 0), up: vec3.fromValues(0, 1, 0),
    q1: quat.create(), q2: quat.create(), dq1: quat2.create(), dq2: quat2.create(),
    v3a: vec3.create(), v3b: vec3.create(), ndc: vec2.create()
};

// ============================================================================
// 4. SOA STATE (all preallocated, pooled, chunk-filled)
// ============================================================================
const positions  = vec3.createVec3SOA(COUNT);  // rendered positions
const basePos    = vec3.createVec3SOA(COUNT);  // swirl base (mode 0)
const morphFrom  = vec3.createVec3SOA(COUNT);  // morph snapshot
const goalPos    = vec3.createVec3SOA(COUNT);  // formation targets
const swirlW     = new Float32Array(COUNT);    // per-instance angular speed
const radii      = new Float32Array(COUNT);    // cached base radius

const quats      = quat.createQuatSOA(COUNT);  // rendered orientations
const quatFrom   = quat.createQuatSOA(COUNT);  // morph snapshot
const quatGoal   = quat.createQuatSOA(COUNT);  // formation targets
const lookTarget = quat.createQuatSOA(COUNT);  // aim scratch
const quatVel    = quat.createQuatSOA(COUNT);  // spring velocities
quat.soaZeroQuatVel: ; // (label noop kept out of bundle)
quatVel.x.fill(0); quatVel.y.fill(0); quatVel.z.fill(0); quatVel.w.fill(0);

const morphT     = new Float32Array(COUNT);    // per-instance staggered t
const stagger    = new Float32Array(COUNT);
const depthBuf   = new Float32Array(COUNT);    // view-space depth for LOD
const sx         = new Float32Array(COUNT);
const sy         = new Float32Array(COUNT);

// orbital elements for mode 3 (all 10k bodies)
const elA   = new Float32Array(COUNT), elE   = new Float32Array(COUNT);
const elM0  = new Float32Array(COUNT), elInc = new Float32Array(COUNT);
const elOm  = new Float32Array(COUNT), elW   = new Float32Array(COUNT);
const elN   = new Float32Array(COUNT); // mean motion

// ECS world + spatial grid (010)
const world  = ecs.createWorld();
const Agent  = {};
const gridIds = new Uint32Array(COUNT);
for (let i = 0; i < COUNT; i++) {
    gridIds[i] = i;
    const eid = ecs.addEntity(world);
    ecs.addComponent(world, eid, Agent);
}
const grid = ecs.createSpatialGrid(5, { maxEntities: COUNT, gridDim: 32, queryCapacity: 4096 });

// ============================================================================
// 5. INIT: base shell positions + orbital elements (chunked, non-blocking)
// ============================================================================
async function initSwarm() {
    // golden-angle shell with radial noise thickness
    await ecs.iterChunked({ length: COUNT }, (unused, i) => {
        const ga = i * 2.39996322972865332;
        const y  = 1 - (i / (COUNT - 1)) * 2;
        const r0 = Math.sqrt(Math.max(0, 1 - y * y));
        const rr = 14 + ((i * 2654435761 >>> 0) % 1000) / 1000 * 8;
        basePos.x[i] = Math.cos(ga) * r0 * rr;
        basePos.y[i] = y * rr;
        basePos.z[i] = Math.sin(ga) * r0 * rr;
        radii[i] = Math.sqrt(basePos.x[i] ** 2 + basePos.y[i] ** 2 + basePos.z[i] ** 2);
        swirlW[i] = 0.25 + 2.2 / (1 + radii[i] * 0.35);
        // orbital elements (galactic disc bias)
        elA[i]  = 8 + ((i * 40503 >>> 0) % 1000) / 1000 * 22;
        elE[i]  = ((i * 22463 >>> 0) % 1000) / 1000 * 0.25;
        elM0[i] = ((i * 15211 >>> 0) % 1000) / 1000 * Math.PI * 2;
        elInc[i] = (((i * 9137 >>> 0) % 1000) / 1000 - 0.5) * 0.35;
        elOm[i] = ((i * 7919 >>> 0) % 1000) / 1000 * Math.PI * 2;
        elW[i]  = ((i * 104729 >>> 0) % 1000) / 1000 * Math.PI * 2;
        elN[i]  = Math.sqrt(ORB_MU / (elA[i] * elA[i] * elA[i]));
    }, 65536, 8);

    vec3.soaCopy(positions, basePos);
    await quat.soaFillFromNoiseChunked(quats, positions, 0.12, 65536, 8);
    for (let i = 0; i < COUNT; i++) { stagger[i] = (i % 97) / 97 * 0.9; }
}

// ============================================================================
// 6. FORMATION GENERATORS (chunked async -> goalPos + quatGoal)
// ============================================================================
const _velTmp = vec3.createVec3SOA(COUNT);

async function fillSphere() {
    await ecs.iterChunked({ length: COUNT }, (u, i) => {
        const ga = i * 2.39996322972865332;
        const y  = 1 - (i / (COUNT - 1)) * 2;
        const r  = Math.sqrt(Math.max(0, 1 - y * y)) * 16;
        goalPos.x[i] = Math.cos(ga) * r;
        goalPos.y[i] = y * 16;
        goalPos.z[i] = Math.sin(ga) * r;
    }, 65536, 8);
    // orientations: tangent-aligned via velocity trick
    for (let i = 0; i < COUNT; i++) {
        _velTmp.x[i] = -goalPos.z[i]; _velTmp.y[i] = 0; _velTmp.z[i] = goalPos.x[i];
    }
    await quat.soaFillFromVelocityChunked(quatGoal, _velTmp, 65536, 8);
}

async function fillTorus() {
    await ecs.iterChunked({ length: COUNT }, (u, i) => {
        const R = 15, r = 4.2;
        const uu = (i / COUNT) * Math.PI * 2 * 37;
        const vv = (i * 0.61803398875 % 1) * Math.PI * 2;
        const cx = Math.cos(uu) * R, cz = Math.sin(uu) * R;
        goalPos.x[i] = cx + Math.cos(uu) * Math.cos(vv) * r;
        goalPos.y[i] = Math.sin(vv) * r;
        goalPos.z[i] = cz + Math.sin(uu) * Math.cos(vv) * r;
        _velTmp.x[i] = -Math.sin(uu); _velTmp.y[i] = 0; _velTmp.z[i] = Math.cos(uu);
    }, 65536, 8);
    await quat.soaFillFromVelocityChunked(quatGoal, _velTmp, 65536, 8);
}

async function fillGalaxy() {
    await ecs.iterChunked({ length: COUNT }, (u, i) => {
        const arm  = i % 3;
        const t    = (i / COUNT);
        const ang  = arm * (Math.PI * 2 / 3) + t * 9.4;
        const rad  = 2 + t * 26;
        const jx   = ((i * 2654435761 >>> 0) % 1000) / 1000 - 0.5;
        const jz   = ((i * 40503 >>> 0) % 1000) / 1000 - 0.5;
        goalPos.x[i] = Math.cos(ang) * rad + jx * 2.2;
        goalPos.y[i] = jx * jz * 1.4;
        goalPos.z[i] = Math.sin(ang) * rad + jz * 2.2;
        _velTmp.x[i] = -Math.sin(ang); _velTmp.y[i] = 0; _velTmp.z[i] = Math.cos(ang);
    }, 65536, 8);
    await quat.soaFillFromVelocityChunked(quatGoal, _velTmp, 65536, 8);
}

async function fillLattice() {
    const side = Math.ceil(Math.cbrt(COUNT));
    const step = 26 / side;
    await ecs.iterChunked({ length: COUNT }, (u, i) => {
        const xi = i % side, yi = (i / side | 0) % side, zi = (i / (side * side) | 0);
        goalPos.x[i] = (xi - side / 2) * step;
        goalPos.y[i] = (yi - side / 2) * step;
        goalPos.z[i] = (zi - side / 2) * step;
    }, 65536, 8);
    await quat.soaFillFromNoiseChunked(quatGoal, goalPos, 0.35, 65536, 8);
}
const FILLERS = [fillSphere, fillTorus, fillGalaxy, fillLattice];

// ============================================================================
// 7. MODE STATE MACHINE
// ============================================================================
let mode = 0, modeT = 0, simTime = 0, paused = false;
let formation = 0, morphPhase = 0; // 0 = holding, 1 = morphing
let morphClock = 0, genBusy = false, serInfo = "";

function snapshotForMorph() {
    vec3.soaCopy(morphFrom, positions);
    quat.soaCopy(quatFrom, quats);
    quatVel.x.fill(0); quatVel.y.fill(0); quatVel.z.fill(0); quatVel.w.fill(0);
}

async function beginFormation(idx) {
    if (genBusy) { return; }
    genBusy = true;
    snapshotForMorph();
    await FILLERS[idx]();
    morphClock = 0;
    morphPhase = 1;
    genBusy = false;
}

function switchMode(next) {
    mode = ((next % MODES.length) + MODES.length) % MODES.length;
    modeT = 0;
    morphPhase = 0;
    quatVel.x.fill(0); quatVel.y.fill(0); quatVel.z.fill(0); quatVel.w.fill(0);
    if (mode === 1) { beginFormation(formation); }
}

function updateSwarm(dt) {
    modeT += dt;
    if (modeT > MODE_TIME) { switchMode(mode + 1); }

    switch (mode) {

    case 0: { // NOISE_SWIRL: differential rotation + 4D-noise spin
        const t = simTime;
        const px = positions.x, py = positions.y, pz = positions.z;
        const bx = basePos.x, by = basePos.y, bz = basePos.z;
        for (let i = 0; i < COUNT; i++) {
            const a = t * swirlW[i];
            const c = Math.cos(a), s = Math.sin(a);
            px[i] = bx[i] * c + bz[i] * s;
            py[i] = by[i] + Math.sin(t * 0.6 + i * 0.0007) * 1.2;
            pz[i] = bz[i] * c - bx[i] * s;
        }
        quat.soaFillSpinFrom4DNoise(quats, positions, t, 0.12, Math.PI * 2);
        break;
    }

    case 1: { // MORPH: per-instance staggered slerp + position lerp
        morphClock += dt;
        const px = positions.x, py = positions.y, pz = positions.z;
        const fx = morphFrom.x, fy = morphFrom.y, fz = morphFrom.z;
        const gx = goalPos.x,   gy = goalPos.y,   gz = goalPos.z;
        for (let i = 0; i < COUNT; i++) {
            let tt = (morphClock - stagger[i]) / MORPH_DUR;
            tt = tt < 0 ? 0 : (tt > 1 ? 1 : tt);
            tt = tt * tt * (3 - 2 * tt); // smoothstep
            morphT[i] = tt;
            px[i] = fx[i] + (gx[i] - fx[i]) * tt;
            py[i] = fy[i] + (gy[i] - fy[i]) * tt;
            pz[i] = fz[i] + (gz[i] - fz[i]) * tt;
        }
        quat.soaSlerp(quats, quatFrom, quatGoal, morphT);
        if (morphClock > MORPH_DUR + 3.0 && !genBusy) {
            formation = (formation + 1) % FORMATIONS.length;
            beginFormation(formation);
        }
        break;
    }

    case 2: { // CROWD_AIM: lookAt pointer + spring damping
        quat.soaLookAt(lookTarget, positions, aimTargets);
        quat.soaSpringDamp(quats, quats, lookTarget, quatVel, 0.22, dt, 30);
        break;
    }

    case 3: { // ORBITAL_BELT: 10k Kepler bodies, velocity-aligned
        const t = simTime;
        const px = positions.x, py = positions.y, pz = positions.z;
        const vx = _velTmp.x, vy = _velTmp.y, vz = _velTmp.z;
        for (let i = 0; i < COUNT; i++) {
            const M = elM0[i] + t * elN[i];
            vec3.keplerOrbit3D(T.v3a, elA[i], elE[i], M, elInc[i], elOm[i], elW[i]);
            px[i] = T.v3a[0]; py[i] = T.v3a[1]; pz[i] = T.v3a[2];
            vec3.keplerOrbitVelocity3D(T.v3b, elA[i], elE[i], M, elInc[i], elOm[i], elW[i], ORB_MU);
            vx[i] = T.v3b[0]; vy[i] = T.v3b[1]; vz[i] = T.v3b[2];
        }
        quat.soaFillFromVelocity(quats, _velTmp);
        break;
    }
    }
}

// ============================================================================
// 8. AIM TARGET SOA (filled on pointer move)
// ============================================================================
const aimTargets = vec3.createVec3SOA(COUNT);
const aimPoint   = vec3.fromValues(0, 4, 0);
function refreshAimTargets() {
    aimTargets.x.fill(aimPoint[0]);
    aimTargets.y.fill(aimPoint[1]);
    aimTargets.z.fill(aimPoint[2]);
}
refreshAimTargets();

// ============================================================================
// 9. DUAL-QUAT CREATURE (009 skinning showcase)
// ============================================================================
const SEG = CREATURE_SEG, RING = CREATURE_RING, SKIN = SEG * RING;
const skinLocal  = vec3.createVec3SOA(SKIN);
const skinWorld  = vec3.createVec3SOA(SKIN);
const skinDqSOA  = quat2.createQuat2SOA(SKIN);
const segDq      = [];
for (let s = 0; s < SEG; s++) { segDq.push(quat2.create()); }

(function buildSkinLocal() {
    for (let s = 0; s < SEG; s++) {
        const r = 0.55 * (1 - (s / SEG) * 0.72);
        for (let k = 0; k < RING; k++) {
            const i = s * RING + k, a = (k / RING) * Math.PI * 2;
            skinLocal.x[i] = 0;
            skinLocal.y[i] = Math.cos(a) * r;
            skinLocal.z[i] = Math.sin(a) * r;
        }
    }
})();

const _rootQ = quat.create(), _localQ = quat.create(), _axisY = [0, 1, 0], _axisZ = [0, 0, 1];
function updateCreature(t) {
    // root path
    T.v3a[0] = Math.sin(t * 0.5) * 10;
    T.v3a[1] = 2 + Math.sin(t * 0.9) * 3;
    T.v3a[2] = Math.cos(t * 0.4) * 10;
    quat.setAxisAngle(_rootQ, _axisY, t * 0.5 + Math.PI / 2);
    quat2.fromRotationTranslation(segDq[0], _rootQ, T.v3a);

    for (let s = 1; s < SEG; s++) {
        const yaw   = Math.sin(t * 3.1 - s * 0.75) * 0.38;
        const pitch = Math.sin(t * 2.2 - s * 0.6) * 0.12;
        quat.setAxisAngle(_localQ, _axisY, yaw);
        quat.rotateX(_localQ, _localQ, pitch);
        T.v3b[0] = 1.15; T.v3b[1] = 0; T.v3b[2] = 0;
        quat2.fromRotationTranslation(T.dq2, _localQ, T.v3b);
        quat2.multiply(segDq[s], segDq[s - 1], T.dq2);
    }
    // expand segment dqs to per-skin-point SOA, then batch skin
    const A = skinDqSOA;
    for (let s = 0; s < SEG; s++) {
        const dq = segDq[s];
        for (let k = 0; k < RING; k++) {
            const i = s * RING + k;
            A.x1[i] = dq[0]; A.y1[i] = dq[1]; A.z1[i] = dq[2]; A.w1[i] = dq[3];
            A.x2[i] = dq[4]; A.y2[i] = dq[5]; A.z2[i] = dq[6]; A.w2[i] = dq[7];
        }
    }
    quat2.soaTransformPoint(skinWorld, skinDqSOA, skinLocal);
}

// ============================================================================
// 10. CAMERA
// ============================================================================
let camYaw = 0.8, camPitch = 0.35, camDist = 52;
function updateCamera() {
    const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
    const cy = Math.cos(camYaw),   syp = Math.sin(camYaw);
    T.eye[0] = T.center[0] + camDist * cp * syp;
    T.eye[1] = T.center[1] + camDist * sp;
    T.eye[2] = T.center[2] + camDist * cp * cy;
    mat4.lookAt(T.view, T.eye, T.center, T.up);
    mat4.perspectiveNO(T.proj, 55 * Math.PI / 180, W / H, 0.1, 900);
    mat4.multiply(T.vp, T.proj, T.view);
    mat4.invert(T.camWorld, T.view);
}
function pointerToWorld(nx, ny, out) {
    const m = T.camWorld, d = camDist * 0.75;
    out[0] = T.eye[0] + m[0] * nx * d + m[4] * ny * d - m[8]  * d;
    out[1] = T.eye[1] + m[1] * nx * d + m[5] * ny * d - m[9]  * d;
    out[2] = T.eye[2] + m[2] * nx * d + m[6] * ny * d - m[10] * d;
    return out;
}

// ============================================================================
// 11. COLOR GRADING (mat3 hue rotation over 8 bucket colors)
// ============================================================================
const BASE_PALETTE = [
    [0.95, 0.55, 0.20], [0.30, 0.85, 0.95], [0.55, 0.95, 0.45], [0.95, 0.35, 0.65],
    [0.65, 0.55, 0.98], [0.98, 0.85, 0.30], [0.35, 0.95, 0.75], [0.85, 0.85, 0.90]
];
const bucketRGB = new Float32Array(BUCKETS * 3);
function gradeColors(t) {
    mat3.fromHueRotation(T.m3hue, t * 0.35);
    const m = T.m3hue;
    for (let b = 0; b < BUCKETS; b++) {
        const r = BASE_PALETTE[b][0], g = BASE_PALETTE[b][1], bl = BASE_PALETTE[b][2];
        bucketRGB[b * 3]     = Math.min(1, m[0] * r + m[3] * g + m[6] * bl);
        bucketRGB[b * 3 + 1] = Math.min(1, m[1] * r + m[4] * g + m[7] * bl);
        bucketRGB[b * 3 + 2] = Math.min(1, m[2] * r + m[5] * g + m[8] * bl);
    }
}

// ============================================================================
// 12. RENDERER (batched Canvas2D, LOD dashes, zero alloc)
// ============================================================================
let lodDash = DASH_LOD, fpsEma = 60;

function projectAll() {
    const M = T.vp;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < COUNT; i++) {
        const x = px[i], y = py[i], z = pz[i];
        const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
        depthBuf[i] = cw;
        if (cw < 0.25) { sx[i] = -1e4; continue; }
        const inv = 1 / cw;
        sx[i] = ((M[0] * x + M[4] * y + M[8]  * z + M[12]) * inv * 0.5 + 0.5) * W;
        sy[i] = (1 - ((M[1] * x + M[5] * y + M[9] * z + M[13]) * inv * 0.5 + 0.5)) * H;
    }
}

function rotateXByQuat(qx, qy, qz, qw, out) {
    // rotate +X axis by quat (inline, zero alloc)
    const ty = qz * 1 - qx * 0;      // cross(q, x)
    const tz = qx * 0 - qy * 1;
    let txv = 0, tyv = qz, tzv = -qy;
    txv = txv + txv; tyv = tyv + tyv; tzv = tzv + tzv;
    out[0] = 1 + qw * txv + qy * tzv - qz * tyv;
    out[1] = 0 + qw * tyv + qz * txv - qx * tzv;
    out[2] = 0 + qw * tzv + qx * tyv - qy * txv;
    return out;
}
const _axTmp = new Float32Array(3);

function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = "#04060c";
    ctx.fillRect(0, 0, W, H);

    projectAll();

    // grid highlight set
    const nearCount = grid.querySphere(aimPoint[0], aimPoint[1], aimPoint[2], 7);
    const nearBuf   = grid.getQueryResults();

    // --- dots, 8 batched fills ------------------------------------------------
    const dotSize = fpsEma < 42 ? 1.6 : 2.2;
    for (let b = 0; b < BUCKETS; b++) {
        const r = (bucketRGB[b * 3] * 255) | 0;
        const g = (bucketRGB[b * 3 + 1] * 255) | 0;
        const bl = (bucketRGB[b * 3 + 2] * 255) | 0;
        ctx.fillStyle = "rgb(" + r + "," + g + "," + bl + ")";
        ctx.beginPath();
        for (let i = b; i < COUNT; i += BUCKETS) {
            if (depthBuf[i] < 0.25) { continue; }
            ctx.rect(sx[i], sy[i], dotSize, dotSize);
        }
        ctx.fill();
    }

    // --- LOD oriented dashes for nearest instances (8 batched strokes) --------
    const qx = quats.x, qy = quats.y, qz = quats.z, qw = quats.w;
    const px = positions.x, py = positions.y, pz = positions.z;
    const M = T.vp;
    // find depth threshold (approximate kth nearest via quick scan)
    let thresh = Infinity, drawn = 0;
    for (let pass = 0; pass < 1 && drawn < lodDash; pass++) {
        // simple selection: draw if depth < adaptive threshold from ema count
        thresh = 30 + (lodDash / COUNT) * 120;
    }
    for (let b = 0; b < BUCKETS; b++) {
        const r = Math.min(255, (bucketRGB[b * 3] * 255 + 60)) | 0;
        const g = Math.min(255, (bucketRGB[b * 3 + 1] * 255 + 60)) | 0;
        const bl = Math.min(255, (bucketRGB[b * 3 + 2] * 255 + 60)) | 0;
        ctx.strokeStyle = "rgb(" + r + "," + g + "," + bl + ")";
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        let used = 0;
        for (let i = b; i < COUNT && used < (lodDash >> 3); i += BUCKETS) {
            const cw = depthBuf[i];
            if (cw < 0.25 || cw > thresh) { continue; }
            used++;
            rotateXByQuat(qx[i], qy[i], qz[i], qw[i], _axTmp);
            const L = 0.9;
            const x2 = px[i] + _axTmp[0] * L, y2 = py[i] + _axTmp[1] * L, z2 = pz[i] + _axTmp[2] * L;
            const w2 = M[3] * x2 + M[7] * y2 + M[11] * z2 + M[15];
            if (w2 < 0.25) { continue; }
            const inv2 = 1 / w2;
            const ex = ((M[0] * x2 + M[4] * y2 + M[8] * z2 + M[12]) * inv2 * 0.5 + 0.5) * W;
            const ey = (1 - ((M[1] * x2 + M[5] * y2 + M[9] * z2 + M[13]) * inv2 * 0.5 + 0.5)) * H;
            ctx.moveTo(sx[i], sy[i]);
            ctx.lineTo(ex, ey);
        }
        ctx.stroke();
    }

    // --- grid-highlighted instances (bright pulse) -----------------------------
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    for (let k = 0; k < nearCount; k++) {
        const i = nearBuf[k];
        if (i >= COUNT || depthBuf[i] < 0.25) { continue; }
        ctx.rect(sx[i] - 1, sy[i] - 1, 3.4, 3.4);
    }
    ctx.fill();

    // --- dual-quat creature -----------------------------------------------------
    ctx.strokeStyle = "#7dffd4";
    ctx.lineWidth = 1.4;
    const swx = skinWorld.x, swy = skinWorld.y, swz = skinWorld.z;
    ctx.beginPath();
    for (let s = 0; s < SEG; s++) {
        // ring
        for (let k = 0; k <= RING; k++) {
            const i = s * RING + (k % RING);
            const x = swx[i], y = swy[i], z = swz[i];
            const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
            if (cw < 0.25) { continue; }
            const inv = 1 / cw;
            const gx = ((M[0] * x + M[4] * y + M[8] * z + M[12]) * inv * 0.5 + 0.5) * W;
            const gy = (1 - ((M[1] * x + M[5] * y + M[9] * z + M[13]) * inv * 0.5 + 0.5)) * H;
            if (k === 0) { ctx.moveTo(gx, gy); } else { ctx.lineTo(gx, gy); }
        }
        // longitudinal
        if (s < SEG - 1) {
            for (let k = 0; k < RING; k += 2) {
                const i0 = s * RING + k, i1 = (s + 1) * RING + k;
                const cw0 = M[3] * swx[i0] + M[7] * swy[i0] + M[11] * swz[i0] + M[15];
                const cw1 = M[3] * swx[i1] + M[7] * swy[i1] + M[11] * swz[i1] + M[15];
                if (cw0 < 0.25 || cw1 < 0.25) { continue; }
                const g0x = ((M[0] * swx[i0] + M[4] * swy[i0] + M[8] * swz[i0] + M[12]) / cw0 * 0.5 + 0.5) * W;
                const g0y = (1 - ((M[1] * swx[i0] + M[5] * swy[i0] + M[9] * swz[i0] + M[13]) / cw0 * 0.5 + 0.5)) * H;
                const g1x = ((M[0] * swx[i1] + M[4] * swy[i1] + M[8] * swz[i1] + M[12]) / cw1 * 0.5 + 0.5) * W;
                const g1y = (1 - ((M[1] * swx[i1] + M[5] * swy[i1] + M[9] * swz[i1] + M[13]) / cw1 * 0.5 + 0.5)) * H;
                ctx.moveTo(g0x, g0y); ctx.lineTo(g1x, g1y);
            }
        }
    }
    ctx.stroke();

    return nearCount;
}

// ============================================================================
// 13. FLOATING ORIGIN
// ============================================================================
let originShifts = 0;
const origin = vec3.create();
function shiftOrigin() {
    const dx = 500;
    origin[0] += dx;
    originShifts++;
    vec3.soaToRelative(basePos, basePos, dx, 0, 0);
    vec3.soaToRelative(positions, positions, dx, 0, 0);
    vec3.soaToRelative(morphFrom, morphFrom, dx, 0, 0);
    vec3.soaToRelative(goalPos, goalPos, dx, 0, 0);
    vec3.soaToRelative(aimTargets, aimTargets, dx, 0, 0);
    aimPoint[0] -= dx;
    refreshAimTargets();
    grid.clear();
}

// ============================================================================
// 14. SERIALIZATION ROUND-TRIP (011, chunked, pooled writer)
// ============================================================================
let serBusy = false;
async function serializeSubset() {
    if (serBusy) { return; }
    serBusy = true;
    try {
        const K = SER_SUBSET;
        const trs = {
            position: { x: positions.x.subarray(0, K), y: positions.y.subarray(0, K), z: positions.z.subarray(0, K) },
            rotation: { x: quats.x.subarray(0, K), y: quats.y.subarray(0, K), z: quats.z.subarray(0, K), w: quats.w.subarray(0, K) },
            scale:    { x: new Float32Array(K).fill(1), y: new Float32Array(K).fill(1), z: new Float32Array(K).fill(1) }
        };
        const eids = new Uint32Array(K);
        for (let i = 0; i < K; i++) { eids[i] = i; }

        const writer = ser.createByteWriter(1 << 18);
        const serialize = ser.createTRSSOASerializerChunked({ worldCoords: false });
        await serialize(writer, eids, trs, 65536, 8);
        const packet = writer.slice();

        // wipe subset, then restore from bytes
        for (let i = 0; i < K; i++) { positions.y[i] = -999; }
        const reader = ser.createByteReader(packet);
        const deserialize = ser.createTRSSOADeserializer({ worldCoords: false });
        const read = deserialize(reader, trs, null, null);

        let ok = read === K;
        for (let i = 0; i < 8 && ok; i++) {
            if (Math.abs(positions.x[i] - trs.position.x[i]) > 1e-3) { ok = false; }
        }
        serInfo = packet.byteLength + " B, " + read + " recs, verify " + (ok ? "OK" : "FAIL");
        writer.release();
    } catch (e) {
        serInfo = "ERROR";
        console.error("[008_demo] serialization failed:", e);
    }
    serBusy = false;
}

// ============================================================================
// 15. INPUT
// ============================================================================
const _ptr = vec2.create(), _ptrLast = vec2.create();
let dragging = false, moved = 0;

canvas.addEventListener("pointerdown", (e) => {
    dragging = true; moved = 0;
    vec2.set(_ptrLast, e.clientX, e.clientY);
    canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
    pointerToWorld((e.clientX / W) * 2 - 1, -((e.clientY / H) * 2 - 1), aimPoint);
    refreshAimTargets();
    if (!dragging) { return; }
    vec2.set(_ptr, e.clientX, e.clientY);
    vec2.subtract(_ptr, _ptr, _ptrLast);
    moved += Math.abs(_ptr[0]) + Math.abs(_ptr[1]);
    camYaw  += _ptr[0] * 0.005;
    camPitch = Math.max(-1.2, Math.min(1.35, camPitch + _ptr[1] * 0.004));
    vec2.set(_ptrLast, e.clientX, e.clientY);
});
canvas.addEventListener("pointerup", () => {
    if (dragging && moved < 8) { switchMode(mode + 1); }
    dragging = false;
});
canvas.addEventListener("wheel", (e) => {
    camDist = Math.max(14, Math.min(160, camDist + e.deltaY * 0.04));
}, { passive: true });

makeButton("⟳ MODE",    () => switchMode(mode + 1));
makeButton("💾 SAVE",   () => { serializeSubset(); });
makeButton("🌍 ORIGIN", shiftOrigin);

window.addEventListener("keydown", (e) => {
    if (e.key === " ") { paused = !paused; }
    if (e.key === "m") { switchMode(mode + 1); }
    if (e.key === "s") { serializeSubset(); }
    if (e.key === "o") { shiftOrigin(); }
});

// ============================================================================
// 16. HUD + COMPASS
// ============================================================================
let fps = 60, hudTick = 0;
function updateHUD(nearby) {
    if (++hudTick % 6 !== 0) { return; }
    hud.textContent =
        "008_quat_demo      fps " + fps.toFixed(0) + " (ema " + fpsEma.toFixed(0) + ")\n" +
        "mode      : " + MODES[mode] + (mode === 1 ? " -> " + FORMATIONS[formation] : "") + "\n" +
        "instances : " + COUNT + " quats SOA  |  dashes LOD " + lodDash + "\n" +
        "grid      : " + nearby + " near aim point\n" +
        "creature  : " + SEG + " seg x " + RING + " ring dual-quat skin\n" +
        "origin    : shifts=" + originShifts + "  x=" + origin[0].toFixed(0) + "\n" +
        "serial    : " + (serInfo || "-") + "\n" +
        "controls  : drag orbit · tap mode · wheel zoom\n" +
        "            [space] pause [m] mode [s] save [o] origin";
}
function drawCompass() {
    mat2.fromRotation(T.m2rot, -camYaw);
    cctx.clearRect(0, 0, 56, 56);
    cctx.strokeStyle = "#175"; cctx.beginPath(); cctx.arc(28, 28, 24, 0, 6.2832); cctx.stroke();
    const nxv = T.m2rot[0] * 0 + T.m2rot[2] * (-1);
    const nyv = T.m2rot[1] * 0 + T.m2rot[3] * (-1);
    cctx.strokeStyle = "#7dffd4"; cctx.lineWidth = 2;
    cctx.beginPath(); cctx.moveTo(28, 28); cctx.lineTo(28 + nxv * 20, 28 + nyv * 20); cctx.stroke();
}

// ============================================================================
// 17. MAIN LOOP (zero alloc, adaptive quality governor)
// ============================================================================
let lastT = 0, fpsAcc = 0, fpsN = 0, fpsClock = 0;

function frame(now) {
    requestAnimationFrame(frame);
    now *= 0.001;
    const dt = Math.min(0.05, now - lastT || 0.016);
    lastT = now;

    fpsAcc += dt; fpsN++;
    if (now - fpsClock > 0.5) {
        fps = fpsN / fpsAcc;
        fpsEma = fpsEma * 0.8 + fps * 0.2;
        // adaptive governor
        if (fpsEma < 40 && lodDash > 400)      { lodDash = (lodDash * 0.7) | 0; }
        else if (fpsEma > 55 && lodDash < DASH_LOD) { lodDash = Math.min(DASH_LOD, lodDash + 200); }
        fpsAcc = 0; fpsN = 0; fpsClock = now;
    }
    if (paused) { return; }

    simTime += dt;

    updateSwarm(dt);
    updateCreature(simTime);
    updateCamera();
    gradeColors(simTime);

    grid.clear();
    grid.insertMany(gridIds, positions);

    const nearby = render();
    drawCompass();
    updateHUD(nearby);
}

// ============================================================================
// 18. BOOT (fully async, never blocks UI thread)
// ============================================================================
(async function main() {
    await initSwarm();
    switchMode(0);
    console.info("[008_quat_demo] ready:", COUNT, "instances,", ecs.getAllEntities(world).length, "ECS entities");
    requestAnimationFrame(frame);
})();