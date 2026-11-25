// file number : 007-D
// full path name : src/007_mat4_demo.js
// description : Interactive 3D cube demo driven ONLY by the ./math modules
//               (002..011). One hero cube + 8 Keplerian satellite cubes +
//               1500-instance ECS debris field + 6-bone FABRIK IK arm,
//               rendered by a dependency-free Canvas2D software pipeline
//               (no server, no vite, no vue, no CDN blocking — works from
//               file:// on Android 64-bit WebView/Chrome).
//               Behaviors (auto-cycle 7s, tap to switch):
//                 1 SPRING_FOLLOW  — mat4.springDampTranslation + quat.springDamp
//                 2 KEYFRAME_SLERP — mat4.blendTRS (quat slerp + lerp T/S)
//                 3 ORBITAL        — mat4.fromOrbitalElements + quat2 velocity-align
//                 4 AIM_LOOKAT     — quat.lookAt -> mat4.fromRotationTranslationScale
//               Systems: bitECS world (hero/satellite/debris entities + query),
//               spatial grid proximity query, instance batch packing, dual-quat
//               pose storage, mat3 normal matrices + hue-rotation color grading,
//               mat2 compass, vec4 HDR exposure pulse, floating-origin recenter
//               (mat4.soaToRelative) and full 011 serialization round-trip
//               (chunked, non-blocking) of hero + satellite TRS SOA.
// best for : 3d graphics — validating the whole math/ECS stack on one living
//            scene: instancing, procedural placement, animation springs,
//            slerp blending, IK, orbital motion, camera/projection, color
//            grading, floating origin and save/load at 60 fps on mobile.
// license : MIT
// usage : <script type="module" src="./007_mat4_demo.js"></script>
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
const SAT_COUNT      = 8;
const DEBRIS_COUNT   = 1500;
const IK_BONES       = 6;
const ORIGIN_STEP    = 250;
const BEHAVIOR_TIME  = 7.0;
const MU             = 60;
const BEHAVIORS      = ["SPRING_FOLLOW", "KEYFRAME_SLERP", "ORBITAL", "AIM_LOOKAT"];

// ============================================================================
// 2. DOM BOOTSTRAP (self-contained, DPR-aware, mobile safe)
// ============================================================================
const canvas  = document.createElement("canvas");
const ctx     = canvas.getContext("2d");
const compass = document.createElement("canvas");
const cctx    = compass.getContext("2d");
const hud     = document.createElement("div");
const btnBar  = document.createElement("div");

Object.assign(canvas.style,  { position: "fixed", inset: "0", width: "100%", height: "100%", display: "block", background: "#05070d", touchAction: "none" });
Object.assign(compass.style, { position: "fixed", top: "10px", right: "10px", width: "56px", height: "56px", opacity: "0.9" });
Object.assign(hud.style,     { position: "fixed", top: "10px", left: "10px", color: "#9fd8ff", font: "11px monospace", whiteSpace: "pre", textShadow: "0 1px 2px #000", pointerEvents: "none", zIndex: 5 });
Object.assign(btnBar.style,  { position: "fixed", bottom: "12px", right: "12px", display: "flex", gap: "8px", zIndex: 6 });

function makeButton(label, fn) {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, { font: "12px monospace", padding: "10px 12px", borderRadius: "8px", border: "1px solid #3af", background: "rgba(10,25,40,0.8)", color: "#bfe9ff", touchAction: "manipulation" });
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); fn(); });
    btnBar.appendChild(b);
}

function bootDOM() {
    document.body.appendChild(canvas);
    document.body.appendChild(compass);
    document.body.appendChild(hud);
    document.body.appendChild(btnBar);
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
    view:      mat4.acquire(), proj:     mat4.acquire(), vp:       mat4.acquire(),
    mv:        mat4.acquire(), camWorld: mat4.acquire(), heroMat:  mat4.acquire(),
    model:     mat4.acquire(), m3:       mat3.create(),  norm:     mat3.create(),
    q1:        quat.create(),  q2:       quat.create(),  dq:       quat2.create(),
    v3a:       vec3.create(),  v3b:      vec3.create(),  v3c:      vec3.create(),
    v4a:       vec4.fromValues(1, 1, 1, 1),
    eye:       vec3.create(),  target:   vec3.create(),  up:       vec3.fromValues(0, 1, 0),
    ndc:       vec2.create(),  m2rot:    mat2.create()
};
const LIGHT_DIR = vec3.normalize(vec3.create(), vec3.fromValues(-0.45, 0.8, 0.5));

// ============================================================================
// 4. CUBE GEOMETRY (unit cube, 8 verts, 6 quads + outward normals)
// ============================================================================
const CUBE_V = new Float32Array([
    -0.5,-0.5,-0.5,   0.5,-0.5,-0.5,   0.5, 0.5,-0.5,  -0.5, 0.5,-0.5,
    -0.5,-0.5, 0.5,   0.5,-0.5, 0.5,   0.5, 0.5, 0.5,  -0.5, 0.5, 0.5
]);
const CUBE_F = [
    { v: [4,5,6,7], n: [ 0, 0, 1] }, { v: [1,0,3,2], n: [ 0, 0,-1] },
    { v: [5,1,2,6], n: [ 1, 0, 0] }, { v: [0,4,7,3], n: [-1, 0, 0] },
    { v: [3,7,6,2], n: [ 0, 1, 0] }, { v: [0,1,5,4], n: [ 0,-1, 0] }
];
// pooled face record list for painter's algorithm
const MAX_FACES = (1 + SAT_COUNT + IK_BONES) * 6;
const facePool = [];
for (let i = 0; i < MAX_FACES; i++) {
    facePool.push({ z: 0, sx: new Float32Array(4), sy: new Float32Array(4), r: 0, g: 0, b: 0 });
}
let faceCount = 0;

// ============================================================================
// 5. ECS WORLD (010) — hero, satellites, debris
// ============================================================================
const world   = ecs.createWorld();
const Hero    = {};
const Sat     = {};
const Debris  = {};
const Orbit   = {
    a:   new Float32Array(SAT_COUNT), e:   new Float32Array(SAT_COUNT),
    M:   new Float32Array(SAT_COUNT), inc: new Float32Array(SAT_COUNT),
    Om:  new Float32Array(SAT_COUNT), om:  new Float32Array(SAT_COUNT)
};

const heroEid = ecs.addEntity(world);
ecs.addComponent(world, heroEid, Hero);

const satEids = new Uint32Array(SAT_COUNT);
for (let i = 0; i < SAT_COUNT; i++) {
    satEids[i] = ecs.addEntity(world);
    ecs.addComponents(world, satEids[i], [Sat]);
    Orbit.a[i]   = 4.5 + i * 1.15;
    Orbit.e[i]   = 0.08 + (i % 3) * 0.07;
    Orbit.M[i]   = (i / SAT_COUNT) * Math.PI * 2;
    Orbit.inc[i] = 0.15 + (i % 4) * 0.12;
    Orbit.Om[i]  = i * 0.7;
    Orbit.om[i]  = i * 1.3;
}

// ============================================================================
// 6. SOA STATE
// ============================================================================
const satMats   = mat4.createMat4SOA(SAT_COUNT);
const satTRS    = ecs.createTransformSOA(SAT_COUNT);
const heroTRS   = ecs.createTransformSOA(1);
const heroColor = vec4.fromValues(1.0, 0.62, 0.18, 1.0);

// hero kinematic state
const heroPos   = vec3.fromValues(0, 1, 0);
const heroQuat  = quat.create();
const heroScale = vec3.fromValues(1.4, 1.4, 1.4);
const heroVelT  = vec3.create();          // translation spring velocity
const heroVelR  = vec4.fromValues(0,0,0,0); // quat spring velocity

// orbital elements for hero ORBITAL behavior
const HERO_ORB = { a: 9, e: 0.4, M: 0, inc: 0.45, Om: 0.3, om: 0.8 };

// keyframe poses for SLERP behavior
const poseA = mat4.acquire(), poseB = mat4.acquire();
mat4.fromRotationTranslationScale(poseA, quat.setAxisAngle(quat.create(), [0,1,0],  0.6), [-4, 1, 0], [1.0,1.0,1.0]);
mat4.fromRotationTranslationScale(poseB, quat.setAxisAngle(quat.create(), [0,1,0], -2.2), [ 4, 3, 1], [1.5,1.5,1.5]);

// ============================================================================
// 7. FLOATING ORIGIN
// ============================================================================
const origin = vec3.create();
let originShifts = 0;
const _tmpMat = mat4.acquire();

function shiftOrigin() {
    origin[0] += ORIGIN_STEP;
    originShifts++;
    // hero + IK base
    vec3.subtract(heroPos, heroPos, [ORIGIN_STEP, 0, 0]);
    vec3.subtract(ikBase, ikBase, [ORIGIN_STEP, 0, 0]);
    // debris positions (SOA, tight loop)
    const px = debrisResult.position.x, n = DEBRIS_COUNT;
    for (let i = 0; i < n; i++) { px[i] -= ORIGIN_STEP; }
    // debris model matrices (SOA batch recenter)
    mat4.soaToRelative(debrisMats, debrisMats, ORIGIN_STEP, 0, 0);
    grid.clear();
    grid.insertMany(debrisIds, debrisResult.position);
}

// ============================================================================
// 8. DEBRIS FIELD (chunked, non-blocking) + SPATIAL GRID + INSTANCE BATCH
// ============================================================================
let debrisResult = null, debrisMats = null, debrisIds = null, grid = null, batch = null;

async function initDebris() {
    debrisResult = await ecs.scatterEntitiesChunked(world, DEBRIS_COUNT, {
        bounds: { x: [-42, 42], y: [-6, 6], z: [-42, 42] },
        seed: 20261124, noiseScale: 0.05, chunkSize: 65536, yieldEvery: 8,
        spawn: (w) => { const e = ecs.addEntity(w); ecs.addComponent(w, e, Debris); return e; }
    });
    // scale down scatter scale for pebble look
    const s = debrisResult.scale, n = DEBRIS_COUNT;
    for (let i = 0; i < n; i++) { s.x[i] *= 0.35; s.y[i] *= 0.35; s.z[i] *= 0.35; }

    debrisMats = mat4.createMat4SOA(DEBRIS_COUNT);
    await mat4.soaComposeTRSChunked(debrisMats, debrisResult.position, debrisResult.rotation, debrisResult.scale, 65536, 8);

    debrisIds = new Uint32Array(DEBRIS_COUNT);
    for (let i = 0; i < DEBRIS_COUNT; i++) { debrisIds[i] = i; }

    grid = ecs.createSpatialGrid(4, { maxEntities: DEBRIS_COUNT, gridDim: 32, queryCapacity: 2048 });
    grid.insertMany(debrisIds, debrisResult.position);

    batch = ecs.createInstanceBatch({ maxSize: SAT_COUNT + 1 });
}

// ============================================================================
// 9. IK ARM (FABRIK via 003, joint frames via 006/007)
// ============================================================================
const ikBase = vec3.fromValues(0, -4, 0);
const ikPos  = new Float32Array(IK_BONES * 3);
const ikLens = new Float32Array(IK_BONES - 1).fill(1.25);
const ikTarget = vec3.fromValues(0, 0, 0);
const ikMats = [];
for (let i = 0; i < IK_BONES; i++) {
    ikMats.push(mat4.acquire());
    ikPos[i*3] = ikBase[0]; ikPos[i*3+1] = ikBase[1] + i * 1.25; ikPos[i*3+2] = ikBase[2];
}
let ikErr = 0;

function stepIK() {
    ikErr = vec3.fabrikStep3(ikPos, ikLens, ikTarget, 0.002);
    vec3.fabrikStep3(ikPos, ikLens, ikTarget, 0.002);
    // build per-joint world matrices: orientation from bone direction
    for (let i = 0; i < IK_BONES; i++) {
        const jx = ikPos[i*3], jy = ikPos[i*3+1], jz = ikPos[i*3+2];
        let dx = 0, dy = 1, dz = 0;
        if (i < IK_BONES - 1) {
            dx = ikPos[(i+1)*3] - jx; dy = ikPos[(i+1)*3+1] - jy; dz = ikPos[(i+1)*3+2] - jz;
        } else if (i > 0) {
            dx = jx - ikPos[(i-1)*3]; dy = jy - ikPos[(i-1)*3+1]; dz = jz - ikPos[(i-1)*3+2];
        }
        mat3.fromLookAt(T.m3, dx, dy, dz, 0, 1, 0);
        T.v3a[0] = jx; T.v3a[1] = jy; T.v3a[2] = jz;
        mat4.fromMat3Translation(ikMats[i], T.m3, T.v3a);
    }
}

// ============================================================================
// 10. CAMERA
// ============================================================================
let camYaw = 0.7, camPitch = 0.42, camDist = 16;

function updateCamera() {
    const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
    const cy = Math.cos(camYaw),   sy = Math.sin(camYaw);
    T.eye[0] = heroPos[0] + camDist * cp * sy;
    T.eye[1] = heroPos[1] + camDist * sp;
    T.eye[2] = heroPos[2] + camDist * cp * cy;
    vec3.copy(T.target, heroPos);
    mat4.lookAt(T.view, T.eye, T.target, T.up);
    mat4.perspectiveNO(T.proj, 55 * Math.PI / 180, W / H, 0.1, 500);
    mat4.multiply(T.vp, T.proj, T.view);
    mat4.invert(T.camWorld, T.view);
}

// pointer -> approximate world target on camera-facing plane
function pointerToWorld(nx, ny, out) {
    const right = T.camWorld, dist = camDist;
    out[0] = T.eye[0] + right[0] * nx * dist * 0.9 + right[4] * ny * dist * 0.9 - right[8]  * dist * 0.9;
    out[1] = T.eye[1] + right[1] * nx * dist * 0.9 + right[5] * ny * dist * 0.9 - right[9]  * dist * 0.9;
    out[2] = T.eye[2] + right[2] * nx * dist * 0.9 + right[6] * ny * dist * 0.9 - right[10] * dist * 0.9;
    return out;
}

// ============================================================================
// 11. HERO BEHAVIOR STATE MACHINE
// ============================================================================
let behavior = 0, behaviorT = 0, simTime = 0, paused = false;

function switchBehavior(next) {
    behavior = next % BEHAVIORS.length;
    behaviorT = 0;
    vec3.set(heroVelT, 0, 0, 0);
    vec4.set(heroVelR, 0, 0, 0, 0);
}

function updateHero(dt) {
    behaviorT += dt;
    if (behaviorT > BEHAVIOR_TIME) { switchBehavior(behavior + 1); }
    const t = simTime;

    switch (behavior) {

    case 0: { // SPRING_FOLLOW: lissajous target, critically damped
        T.v3a[0] = Math.sin(t * 0.9) * 5;
        T.v3a[1] = 1.5 + Math.sin(t * 1.7) * 2;
        T.v3a[2] = Math.cos(t * 0.6) * 5;
        mat4.springDampTranslation(T.heroMat, T.heroMat, T.v3a, heroVelT, 0.35, dt, 40);
        heroPos[0] = T.heroMat[12]; heroPos[1] = T.heroMat[13]; heroPos[2] = T.heroMat[14];
        quat.setAxisAngle(T.q2, [0,1,0], t * 1.2);
        quat.springDamp(heroQuat, heroQuat, T.q2, heroVelR, 0.3, dt, 20);
        break;
    }

    case 1: { // KEYFRAME_SLERP: blendTRS between poseA and poseB
        const k = 0.5 - 0.5 * Math.cos(behaviorT * 1.4);
        mat4.blendTRS(T.heroMat, poseA, poseB, k);
        mat4.getTranslation(heroPos, T.heroMat);
        mat4.getRotation(heroQuat, T.heroMat);
        break;
    }

    case 2: { // ORBITAL: Kepler + dual-quat velocity alignment (009)
        HERO_ORB.M += Math.sqrt(MU / (HERO_ORB.a ** 3)) * dt;
        vec3.keplerOrbit3D(T.v3a, HERO_ORB.a, HERO_ORB.e, HERO_ORB.M, HERO_ORB.inc, HERO_ORB.Om, HERO_ORB.om);
        vec3.keplerOrbitVelocity3D(T.v3b, HERO_ORB.a, HERO_ORB.e, HERO_ORB.M, HERO_ORB.inc, HERO_ORB.Om, HERO_ORB.om, MU);
        vec3.subtract(T.v3a, T.v3a, origin);          // floating-origin aware
        quat2.fromVelocityTranslation(T.dq, T.v3b, T.v3a);
        mat4.fromQuat2(T.heroMat, T.dq);
        quat2.getTranslation(T.v3c, T.dq);
        vec3.copy(heroPos, T.v3c);
        mat4.getRotation(heroQuat, T.heroMat);
        break;
    }

    case 3: { // AIM_LOOKAT: track satellite 0 with quat.lookAt spring
        const s = satMats.arrays;
        T.v3a[0] = s[12][0]; T.v3a[1] = s[13][0]; T.v3a[2] = s[14][0];
        T.v3b[0] = Math.sin(t * 0.5) * 2; T.v3b[1] = 2.5 + Math.sin(t * 1.1) * 0.5; T.v3b[2] = Math.cos(t * 0.5) * 2;
        vec3.subtract(T.v3b, T.v3b, [origin[0], 0, 0]);
        quat.lookAt(T.q2, T.v3b, T.v3a, T.up);
        quat.springDamp(heroQuat, heroQuat, T.q2, heroVelR, 0.25, dt, 25);
        vec3.lerp(heroPos, heroPos, T.v3b, Math.min(1, dt * 3));
        break;
    }
    }

    // compose final hero matrix + hero TRS SOA (for batch & serialization)
    mat4.fromRotationTranslationScale(T.heroMat, heroQuat, heroPos, heroScale);
    vec3.copy(heroTRS.position.x.subarray ? heroPos : heroPos, heroPos);
    heroTRS.position.x[0] = heroPos[0]; heroTRS.position.y[0] = heroPos[1]; heroTRS.position.z[0] = heroPos[2];
    heroTRS.rotation.x[0] = heroQuat[0]; heroTRS.rotation.y[0] = heroQuat[1];
    heroTRS.rotation.z[0] = heroQuat[2]; heroTRS.rotation.w[0] = heroQuat[3];
    heroTRS.scale.x[0] = heroScale[0]; heroTRS.scale.y[0] = heroScale[1]; heroTRS.scale.z[0] = heroScale[2];
}

// ============================================================================
// 12. SATELLITE SYSTEM (ECS query -> SOA Kepler batch -> dual-quat mirror)
// ============================================================================
const _satDq = quat2.create();
function updateSatellites(dt) {
    const list = ecs.query(world, [Sat]);
    const n = list.length;
    const nrm = Math.sqrt(MU / 125); // mean-motion scale
    for (let i = 0; i < n; i++) { Orbit.M[i] += nrm * dt * (1.5 - Orbit.a[i] * 0.06); }
    mat4.soaFromOrbitalElements(satMats, Orbit.a, Orbit.e, Orbit.M, Orbit.inc, Orbit.Om, Orbit.om);
    // floating origin + dual-quat mirror of pose 0 (009 showcase)
    const A = satMats.arrays;
    for (let i = 0; i < n; i++) { A[12][i] -= origin[0]; A[13][i] -= origin[1]; A[14][i] -= origin[2]; }
    mat4.soaGet(_tmpMat, satMats, 0);
    quat2.fromMat4(_satDq, _tmpMat);
}

// ============================================================================
// 13. COLOR GRADING (mat3 hue rotation + vec4 exposure)
// ============================================================================
const hueM3 = mat3.create();
const _rgb = vec3.create();
function gradedColor(out, base, hueRad, exposure) {
    mat3.fromHueRotation(hueM3, hueRad);
    _rgb[0] = base[0]; _rgb[1] = base[1]; _rgb[2] = base[2];
    out[0] = hueM3[0]*_rgb[0] + hueM3[3]*_rgb[1] + hueM3[6]*_rgb[2];
    out[1] = hueM3[1]*_rgb[0] + hueM3[4]*_rgb[1] + hueM3[7]*_rgb[2];
    out[2] = hueM3[2]*_rgb[0] + hueM3[5]*_rgb[1] + hueM3[8]*_rgb[2];
    out[3] = base[3];
    return vec4.expose(out, out, exposure);
}

// ============================================================================
// 14. SOFTWARE RENDERER (painter's algorithm, backface cull, Lambert)
// ============================================================================
const _viewV = vec3.create(), _clipV = vec3.create();

function pushCube(model, r, g, b) {
    mat4.multiply(T.mv, T.view, model);
    mat3.normalFromMat4(T.norm, model);
    const nm = T.norm;

    // 8 verts -> view space (pooled temp arrays)
    const vx = pushCube._vx || (pushCube._vx = new Float32Array(8));
    const vy = pushCube._vy || (pushCube._vy = new Float32Array(8));
    const vz = pushCube._vz || (pushCube._vz = new Float32Array(8));
    for (let i = 0; i < 8; i++) {
        T.v3a[0] = CUBE_V[i*3]; T.v3a[1] = CUBE_V[i*3+1]; T.v3a[2] = CUBE_V[i*3+2];
        vec3.transformMat4(_viewV, T.v3a, T.mv);
        vx[i] = _viewV[0]; vy[i] = _viewV[1]; vz[i] = _viewV[2];
    }

    for (let f = 0; f < 6; f++) {
        const face = CUBE_F[f];
        // world normal via normal matrix (column-major mat3)
        const wnx = nm[0]*face.n[0] + nm[3]*face.n[1] + nm[6]*face.n[2];
        const wny = nm[1]*face.n[0] + nm[4]*face.n[1] + nm[7]*face.n[2];
        const wnz = nm[2]*face.n[0] + nm[5]*face.n[1] + nm[8]*face.n[2];

        // face center in view space + backface test
        let cx = 0, cyv = 0, cz = 0;
        for (let k = 0; k < 4; k++) { cx += vx[face.v[k]]; cyv += vy[face.v[k]]; cz += vz[face.v[k]]; }
        cx *= 0.25; cyv *= 0.25; cz *= 0.25;
        // view-space normal (rotate only)
        const vm = T.mv;
        const vnx = vm[0]*face.n[0] + vm[4]*face.n[1] + vm[8] *face.n[2];
        const vny = vm[1]*face.n[0] + vm[5]*face.n[1] + vm[9] *face.n[2];
        const vnz = vm[2]*face.n[0] + vm[6]*face.n[1] + vm[10]*face.n[2];
        if (vnx*cx + vny*cyv + vnz*cz > 0) { continue; } // facing away

        const rec = facePool[faceCount++];
        rec.z = cz;
        let ok = true;
        for (let k = 0; k < 4; k++) {
            T.v3a[0] = vx[face.v[k]]; T.v3a[1] = vy[face.v[k]]; T.v3a[2] = vz[face.v[k]];
            vec3.transformMat4(_clipV, T.v3a, T.proj);
            if (_clipV[2] < -1.2 || _clipV[2] > 1.2) { ok = false; break; }
            rec.sx[k] = (_clipV[0] * 0.5 + 0.5) * W;
            rec.sy[k] = (1 - (_clipV[1] * 0.5 + 0.5)) * H;
        }
        if (!ok) { faceCount--; continue; }
        const lam = Math.max(0, wnx*LIGHT_DIR[0] + wny*LIGHT_DIR[1] + wnz*LIGHT_DIR[2]);
        const sh = 0.22 + 0.85 * lam;
        rec.r = Math.min(255, r * sh) | 0;
        rec.g = Math.min(255, g * sh) | 0;
        rec.b = Math.min(255, b * sh) | 0;
    }
}

function render(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // background gradient (cheap)
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, W, H);

    faceCount = 0;

    // hero (graded color, exposure pulse on behavior switch)
    gradedColor(T.v4a, heroColor, simTime * 0.6, 1 + 1.5 * Math.max(0, 1 - behaviorT * 2));
    pushCube(T.heroMat, T.v4a[0] * 255, T.v4a[1] * 255, T.v4a[2] * 255);

    // satellites
    const _c = vec4.create();
    for (let i = 0; i < SAT_COUNT; i++) {
        mat4.soaGet(_tmpMat, satMats, i);
        gradedColor(_c, heroColor, i * 0.85 + simTime * 0.2, 0.9);
        pushCube(_tmpMat, _c[0] * 200, _c[1] * 200, _c[2] * 200);
    }

    // IK joints (small cubes)
    const _s = mat4.acquire();
    for (let i = 0; i < IK_BONES; i++) {
        mat4.scale(_s, ikMats[i], [0.32, 0.32, 0.32]);
        pushCube(_s, 120, 235, 190);
    }
    mat4.release(_s);

    // painter sort (far first: view z ascending)
    const faces = facePool.slice(0, faceCount).sort((a, b) => a.z - b.z);
    for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        ctx.fillStyle = "rgb(" + f.r + "," + f.g + "," + f.b + ")";
        ctx.beginPath();
        ctx.moveTo(f.sx[0], f.sy[0]);
        ctx.lineTo(f.sx[1], f.sy[1]);
        ctx.lineTo(f.sx[2], f.sy[2]);
        ctx.lineTo(f.sx[3], f.sy[3]);
        ctx.closePath();
        ctx.fill();
    }

    // debris as depth-faded points (manual clip-space transform, zero alloc)
    const M = T.vp, dp = debrisResult.position, dn = DEBRIS_COUNT;
    for (let i = 0; i < dn; i++) {
        const x = dp.x[i], y = dp.y[i], z = dp.z[i];
        const cw = M[3]*x + M[7]*y + M[11]*z + M[15];
        if (cw < 0.35) { continue; }
        const cx2 = (M[0]*x + M[4]*y + M[8] *z + M[12]) / cw;
        const cy2 = (M[1]*x + M[5]*y + M[9] *z + M[13]) / cw;
        if (cx2 < -1 || cx2 > 1 || cy2 < -1 || cy2 > 1) { continue; }
        const px = (cx2 * 0.5 + 0.5) * W;
        const py = (1 - (cy2 * 0.5 + 0.5)) * H;
        const sz = Math.max(1, Math.min(3.5, 5 / cw));
        ctx.globalAlpha = Math.max(0.12, Math.min(0.8, 4 / cw));
        ctx.fillStyle = "#7fb2ff";
        ctx.fillRect(px, py, sz, sz);
    }
    ctx.globalAlpha = 1;

    // mat2 compass (camera yaw)
    mat2.fromRotation(T.m2rot, -camYaw);
    cctx.clearRect(0, 0, 56, 56);
    cctx.strokeStyle = "#274"; cctx.beginPath(); cctx.arc(28, 28, 24, 0, 6.2832); cctx.stroke();
    const nxv = T.m2rot[0] * 0 + T.m2rot[2] * (-1);
    const nyv = T.m2rot[1] * 0 + T.m2rot[3] * (-1);
    cctx.strokeStyle = "#6fd9ff"; cctx.lineWidth = 2;
    cctx.beginPath(); cctx.moveTo(28, 28); cctx.lineTo(28 + nxv * 20, 28 + nyv * 20); cctx.stroke();
}

// ============================================================================
// 15. SERIALIZATION ROUND-TRIP (011 — chunked, pooled writer)
// ============================================================================
let lastSerBytes = 0, serBusy = false;
const _idMapH = new Map(), _idMapS = new Map();

async function serializeRoundTrip() {
    if (serBusy) { return; }
    serBusy = true;
    try {
        // decompose satellite matrices -> TRS SOA
        mat4.soaDecompose(satTRS.position, satTRS.rotation, satTRS.scale, satMats);

        const writer = ser.createByteWriter(1 << 16);
        const serialize = ser.createTRSSOASerializerChunked({ worldCoords: false });
        const heroEids = Uint32Array.of(heroEid);
        await serialize(writer, heroEids,  heroTRS, 64, 1);
        await serialize(writer, satEids,   satTRS,  64, 1);
        const packet = writer.slice();
        lastSerBytes = packet.byteLength;

        // wipe visible state (cube teleports away)...
        heroPos[1] = -60;
        mat4.fromRotationTranslationScale(T.heroMat, heroQuat, heroPos, heroScale);

        // ...then restore from bytes after a beat
        setTimeout(() => {
            const reader = ser.createByteReader(packet);
            const deserialize = ser.createTRSSOADeserializer({ worldCoords: false });
            _idMapH.clear(); _idMapH.set(heroEid, 0);
            _idMapS.clear();
            for (let i = 0; i < SAT_COUNT; i++) { _idMapS.set(satEids[i], i); }
            deserialize(reader, heroTRS, _idMapH, null);
            deserialize(reader, satTRS,  _idMapS, null);
            heroPos[0] = heroTRS.position.x[0]; heroPos[1] = heroTRS.position.y[0]; heroPos[2] = heroTRS.position.z[0];
            heroQuat[0] = heroTRS.rotation.x[0]; heroQuat[1] = heroTRS.rotation.y[0];
            heroQuat[2] = heroTRS.rotation.z[0]; heroQuat[3] = heroTRS.rotation.w[0];
            mat4.soaComposeTRS(satMats, satTRS.position, satTRS.rotation, satTRS.scale);
            writer.release();
            serBusy = false;
        }, 550);
    } catch (e) {
        serBusy = false;
        console.error("[007_demo] serialization failed:", e);
    }
}

// ============================================================================
// 16. INPUT (drag orbit / tap cycle / pinch zoom / buttons / keys)
// ============================================================================
const _ptr = vec2.create(), _ptrLast = vec2.create();
let dragging = false, moved = 0, pinchDist = 0;

canvas.addEventListener("pointerdown", (e) => {
    dragging = true; moved = 0;
    vec2.set(_ptrLast, e.clientX, e.clientY);
    canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
    if (!dragging) { return; }
    vec2.set(_ptr, e.clientX, e.clientY);
    vec2.subtract(_ptr, _ptr, _ptrLast);
    moved += Math.abs(_ptr[0]) + Math.abs(_ptr[1]);
    camYaw   += _ptr[0] * 0.005;
    camPitch  = Math.max(-1.2, Math.min(1.35, camPitch + _ptr[1] * 0.004));
    vec2.set(_ptrLast, e.clientX, e.clientY);
    pointerToWorld((e.clientX / W) * 2 - 1, -((e.clientY / H) * 2 - 1), ikTarget);
});
canvas.addEventListener("pointerup", () => {
    if (dragging && moved < 8) { switchBehavior(behavior + 1); } // tap = cycle
    dragging = false;
});
canvas.addEventListener("wheel", (e) => {
    camDist = Math.max(6, Math.min(60, camDist + e.deltaY * 0.02));
}, { passive: true });

makeButton("⟳ BEHAVIOR", () => switchBehavior(behavior + 1));
makeButton("💾 SAVE/LOAD", () => { serializeRoundTrip(); });
makeButton("🌍 ORIGIN", shiftOrigin);

window.addEventListener("keydown", (e) => {
    if (e.key === " ")  { paused = !paused; }
    if (e.key === "b")  { switchBehavior(behavior + 1); }
    if (e.key === "s")  { serializeRoundTrip(); }
    if (e.key === "o")  { shiftOrigin(); }
});

// ============================================================================
// 17. HUD
// ============================================================================
let fps = 60, hudTick = 0;
function updateHUD(nearby) {
    if (++hudTick % 6 !== 0) { return; }
    hud.textContent =
        "007_mat4_demo        fps " + fps.toFixed(0) + "\n" +
        "behavior  : " + BEHAVIORS[behavior] + "  (t " + behaviorT.toFixed(1) + "/" + BEHAVIOR_TIME + ")\n" +
        "hero      : " + heroPos[0].toFixed(1) + ", " + heroPos[1].toFixed(1) + ", " + heroPos[2].toFixed(1) + "\n" +
        "entities  : 1 hero + " + SAT_COUNT + " sats + " + DEBRIS_COUNT + " debris (ECS)\n" +
        "grid      : " + nearby + " debris within r=6 of hero\n" +
        "ik err    : " + ikErr.toFixed(4) + "\n" +
        "origin    : shifts=" + originShifts + "  x=" + origin[0].toFixed(0) + "\n" +
        "batch     : " + (batch ? batch.count : 0) + " instances packed\n" +
        "serial    : " + lastSerBytes + " bytes last round-trip\n" +
        "controls  : drag orbit · tap cycle · wheel zoom\n" +
        "            [space] pause [b] behavior [s] save [o] origin";
}

// ============================================================================
// 18. MAIN LOOP
// ============================================================================
let lastT = 0, fpsAcc = 0, fpsN = 0, fpsClock = 0;

function frame(now) {
    requestAnimationFrame(frame);
    now *= 0.001;
    let dt = Math.min(0.05, now - lastT || 0.016);
    lastT = now;

    fpsAcc += dt; fpsN++;
    if (now - fpsClock > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; fpsClock = now; }
    if (paused) { render(now); return; }

    simTime += dt;

    // -- systems (ECS-driven) ------------------------------------------------
    updateHero(dt);
    updateSatellites(dt);
    stepIK();

    // grid proximity query (rebuild is cheap at 1500)
    grid.clear();
    grid.insertMany(debrisIds, debrisResult.position);
    const nearby = grid.querySphere(heroPos[0] + origin[0], heroPos[1], heroPos[2], 6);

    // instance batch packing (010 rendering API)
    batch.clear();
    batch.addFromTRS(heroEid, heroTRS, 0, heroColor);
    for (let i = 0; i < SAT_COUNT; i++) {
        mat4.soaGet(_tmpMat, satMats, i);
        satTRS.position.x[i] = _tmpMat[12]; satTRS.position.y[i] = _tmpMat[13]; satTRS.position.z[i] = _tmpMat[14];
        satTRS.scale.x[i] = 1; satTRS.scale.y[i] = 1; satTRS.scale.z[i] = 1;
    }
    batch.addManyFromTRS(satEids, satTRS);

    updateCamera();
    render(now);
    updateHUD(nearby);
}

// ============================================================================
// 19. BOOT (fully async, never blocks the UI thread)
// ============================================================================
(async function main() {
    await initDebris();
    switchBehavior(0);
    pointerToWorld(0, 0.3, ikTarget);
    console.info("[007_mat4_demo] ready:", DEBRIS_COUNT, "debris,", SAT_COUNT, "satellites, ECS entities =", ecs.getAllEntities(world).length);
    requestAnimationFrame(frame);
})();