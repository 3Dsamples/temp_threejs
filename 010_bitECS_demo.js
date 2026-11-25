// file number : 014
// full path name : src/010_bitECS_demo.js
// description : "BIT CITY" — a living ECS world-engine demo driven by
//               010_bitECS_core.js. Up to 1,000,000 entities (default 150k)
//               spawned chunked with progress, stored in SOA components and
//               driven every frame by real bitECS systems with per-system
//               timing readouts:
//                 · query/observe        — Drone/Orbital/Beacon archetypes,
//                                          live add-observer spawn counter
//                 · flow system          — 1M-body curl-ish drift + containment
//                 · createAnimationSystem— 24k spring-damped drones chasing a
//                                          wandering attractor (tap to lure)
//                 · createOrbitalSystem  — Kepler belt (spawnOrbitalBodies),
//                                          positions written through SOA
//                 · createIKSystem       — 6 FABRIK crane chains reaching the
//                                          attractor, live error readout
//                 · createColorSystem    — hue-drift grading over the Drone
//                                          color SOA view (per-entity colors
//                                          visible in the grid-highlight pass)
//                 · createSpatialGrid    — stride-sampled rebuild, querySphere
//                                          neighborhood highlight around lure
//                 · createInstanceBatch  — packed per frame, rendered from the
//                                          batch mat4 SOA (GPU-upload path)
//                 · createFloatingOrigin — auto recenter of the whole world,
//                                          Float64 origin ledger in the HUD
//               Renderer is dependency-free Canvas2D (stars/nebula backdrop,
//               projected ground grid, 3-bucket point clouds, glow sprites,
//               IK polylines) with adaptive governor, full live control deck
//               (8 sliders, 1 select, 4 toggles, 5 actions), custom
//               scrollbars, ambient synth audio with visible mute, staged
//               boot, and snapshot export via 011 when loadable (graceful
//               internal fallback). 010 itself is dynamically imported: if the
//               host blocks it, a diagnostic panel appears — the page never
//               breaks. Zero CDN, zero build, Android 64-bit safe.
// best for : 3d graphics — validating the whole ECS layer at scale: SOA
//            components, queries/observers, grid culling, spring animation,
//            IK, orbital integration, color grading, instance batching and
//            floating-origin persistence in one 60 fps living world.
// license : MIT
// usage : <script type="module" src="./010_bitECS_demo.js"></script>
// ============================================================================

import * as vec2 from "./math/002_vec2.js";
import * as vec3 from "./math/003_vec3.js";
import * as mat2 from "./math/005_mat2.js";
import * as mat4 from "./math/007_mat4.js";

// Optional link: 011 serialization (export path). Falls back to internal codec.
let ser11 = null;
import("./math/011_bitECS_serialization.js")
    .then(m => { ser11 = m; markLink(); })
    .catch(() => { ser11 = null; markLink(); });

// ============================================================================
// 1. CONFIG / STATE
// ============================================================================
const MAX_HARD   = 1000000;
const ORB_CAP    = 120000;
const ANIM_CAP   = 24000;
const BATCH_SIZE = 8192;
const IK_CHAINS  = 6;
const IK_BONES   = 7;

const DEFAULTS = {
    count: 150000, orbShare: 0.14, timeScale: 1.0, flow: 1.0,
    hueDrift: 0.35, gridRadius: 12, fov: 55,
    autoOrbit: true, follow: true, autoOrigin: true,
    quality: "balanced", drawCap: 45000, dotSize: 2.0, ground: true
};
const S = Object.assign({}, DEFAULTS);
let seed = 930211;

let ecs = null;                 // 010 core (dynamic import)
let world = null;               // recreated per rebuild
let C = null;                   // component set (sized per rebuild)
let crowdList = [], orbList = [], beaconList = [];
let animSys = null, orbSys = null, ikSys = null, colorSys = null, fo = null;
let grid = null, batch = null;
let orbResult = null, orbPos = null, animN = 0;
let trsView = null, targetTRS = null, crowdTRSView = null;
let phaseArr = null, radiiArr = null;
let gridStride = 1, gridInterval = 2, frameIdx = 0;

let simTime = 0, paused = false, rebuilding = false, spawnCounted = 0;
let origin64 = new Float64Array(3), originShifts = 0;
let fpsEma = 60, govDrawCap = Infinity;
const timings = { flow: 0, anim: 0, orb: 0, ik: 0, grid: 0, color: 0, batch: 0, render: 0 };
const att = { pos: vec3.fromValues(14, 4, 0), manual: 0 };
let nearbyCount = 0;

// ============================================================================
// 2. DOM + STYLE (self-contained observatory-console art direction)
// ============================================================================
const root = document.createElement("div");
root.id = "bc-root";
root.innerHTML = `
<style>
#bc-root{position:fixed;inset:0;display:flex;flex-direction:column;overflow:hidden;
  --bg:#04070c;--surface:rgba(8,16,18,.88);--line:rgba(61,230,160,.16);
  --text:#d9fff0;--dim:#6d948a;--acc:#3de6a0;--acc2:#37c8ff;--ok:#b6ff3d;
  --warn:#ffd23d;--danger:#ff3d81;
  font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:var(--text);background:var(--bg)}
#bc-root *{box-sizing:border-box;margin:0}
#bc-top{height:48px;flex:0 0 48px;display:flex;align-items:center;gap:12px;padding:0 16px;
  background:linear-gradient(90deg,rgba(6,12,12,.95),rgba(10,22,20,.9));
  border-bottom:1px solid var(--line);z-index:20;animation:bcDrop .7s cubic-bezier(.2,.9,.25,1) both}
#bc-top h1{font-size:14px;letter-spacing:.3em;font-weight:700;white-space:nowrap;
  background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;
  background-clip:text;color:transparent}
#bc-top .sub{color:var(--dim);font-size:10px;letter-spacing:.14em;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
#bc-top .sp{flex:1}
.bc-chip{font-size:10px;padding:3px 9px;border:1px solid var(--line);border-radius:99px;
  color:var(--dim);letter-spacing:.1em;white-space:nowrap}
.bc-chip.on{color:var(--ok);border-color:rgba(182,255,61,.35)}
#bc-mute{cursor:pointer;user-select:none;font-size:11px;padding:6px 12px;border-radius:8px;
  border:1px solid var(--line);background:rgba(14,30,26,.7);color:var(--acc2);
  letter-spacing:.08em;transition:all .2s}
#bc-mute:hover{border-color:var(--acc2);box-shadow:0 0 14px rgba(55,200,255,.25)}
#bc-main{flex:1;display:flex;min-height:0}
#bc-stage{flex:1;position:relative;min-width:0;background:#000}
#bc-cv{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab}
#bc-cv:active{cursor:grabbing}
#bc-hud{position:absolute;top:12px;left:12px;pointer-events:none;font-size:10.5px;line-height:1.75;
  color:var(--acc);text-shadow:0 1px 3px #000;white-space:pre;letter-spacing:.04em;
  background:linear-gradient(180deg,rgba(4,10,8,.6),transparent);padding:8px 12px 16px;
  border-left:2px solid var(--acc);animation:bcFade 1.2s .3s both;max-width:min(430px,62vw)}
#bc-compass{position:absolute;top:12px;right:12px;width:52px;height:52px;pointer-events:none;opacity:.9}
#bc-hint{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);pointer-events:none;
  font-size:10px;color:var(--dim);letter-spacing:.18em;background:rgba(4,10,8,.6);
  padding:6px 14px;border-radius:99px;border:1px solid var(--line);white-space:nowrap;
  animation:bcFade 1s 1.2s both}
#bc-boot{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:14px;z-index:15;transition:opacity .8s;letter-spacing:.3em;
  font-size:11px;color:var(--acc);
  background:radial-gradient(ellipse at 50% 60%,rgba(10,30,24,.92),rgba(2,5,6,.98))}
#bc-boot .bar{width:min(340px,72%);height:3px;background:rgba(61,230,160,.12);
  border-radius:2px;overflow:hidden}
#bc-boot .bar i{display:block;height:100%;width:0%;
  background:linear-gradient(90deg,var(--acc),var(--acc2));transition:width .15s;
  box-shadow:0 0 12px var(--acc2)}
#bc-boot.gone{opacity:0;pointer-events:none}
#bc-panel{width:308px;flex:0 0 308px;background:var(--surface);
  border-left:1px solid var(--line);overflow-y:auto;overflow-x:hidden;padding:14px 16px 22px;
  z-index:10;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  animation:bcSlide .7s .15s cubic-bezier(.2,.9,.25,1) both;
  scrollbar-width:thin;scrollbar-color:var(--acc) rgba(61,230,160,.07)}
#bc-panel::-webkit-scrollbar{width:10px}
#bc-panel::-webkit-scrollbar-track{background:linear-gradient(180deg,rgba(61,230,160,.05),rgba(61,230,160,.1));border-radius:5px}
#bc-panel::-webkit-scrollbar-thumb{background:linear-gradient(180deg,var(--acc),var(--acc2));
  border-radius:5px;border:2px solid rgba(4,10,8,.85)}
#bc-panel::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,var(--acc2),var(--acc))}
.bc-sec{margin:16px 0 8px;font-size:9.5px;letter-spacing:.3em;color:var(--dim);
  display:flex;align-items:center;gap:8px}
.bc-sec::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
.bc-sec b{color:var(--acc);font-weight:700}
.bc-row{margin:9px 0}
.bc-row label{display:flex;justify-content:space-between;font-size:10.5px;letter-spacing:.06em;margin-bottom:5px}
.bc-row label output{color:var(--acc2);font-weight:700}
.bc-row input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:22px;
  background:transparent;cursor:pointer}
.bc-row input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;
  background:linear-gradient(90deg,var(--acc),var(--acc2));box-shadow:0 0 8px rgba(55,200,255,.18)}
.bc-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;
  margin-top:-5.5px;border-radius:50%;background:#071410;border:2px solid var(--acc2);
  box-shadow:0 0 10px var(--acc2);transition:transform .15s}
.bc-row input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.25)}
.bc-row input[type=range]::-moz-range-track{height:4px;border-radius:2px;
  background:linear-gradient(90deg,var(--acc),var(--acc2))}
.bc-row input[type=range]::-moz-range-thumb{width:13px;height:13px;border-radius:50%;
  background:#071410;border:2px solid var(--acc2)}
.bc-sel{width:100%;padding:8px 10px;background:rgba(12,26,22,.9);color:var(--text);
  border:1px solid var(--line);border-radius:8px;font:inherit;font-size:11.5px;cursor:pointer;outline:none}
.bc-sel:focus{border-color:var(--acc2)}
.bc-tog{display:flex;align-items:center;justify-content:space-between;padding:7px 0;
  font-size:11px;letter-spacing:.06em;cursor:pointer;user-select:none;-webkit-user-select:none}
.bc-tog .sw{width:36px;height:19px;border-radius:99px;background:rgba(61,230,160,.12);
  border:1px solid var(--line);position:relative;transition:all .2s;flex:0 0 36px}
.bc-tog .sw::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;
  border-radius:50%;background:var(--dim);transition:all .2s}
.bc-tog.on .sw{background:linear-gradient(90deg,var(--acc),var(--acc2));border-color:transparent;
  box-shadow:0 0 12px rgba(61,230,160,.22)}
.bc-tog.on .sw::after{left:19px;background:#04120c}
.bc-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.bc-btn{padding:10px 6px;border-radius:9px;border:1px solid var(--line);cursor:pointer;
  background:linear-gradient(180deg,rgba(18,38,32,.9),rgba(8,18,16,.9));color:var(--text);
  font:inherit;font-size:10.5px;letter-spacing:.12em;transition:all .18s;text-align:center;
  touch-action:manipulation}
.bc-btn:hover{border-color:var(--acc);color:var(--acc);box-shadow:0 0 16px rgba(61,230,160,.2);
  transform:translateY(-1px)}
.bc-btn:active{transform:none}
.bc-btn.pri{grid-column:1/-1;border-color:rgba(55,200,255,.4);color:var(--acc2)}
.bc-btn.pri:hover{box-shadow:0 0 18px rgba(55,200,255,.3)}
.bc-btn[disabled]{opacity:.45;pointer-events:none}
.bc-keys{margin-top:14px;font-size:9.5px;color:var(--dim);letter-spacing:.08em;line-height:1.9}
.bc-keys b{color:var(--acc2);font-weight:700}
.bc-stack{margin-top:12px;font-size:9px;color:var(--dim);letter-spacing:.1em;line-height:1.8;
  border-top:1px dashed var(--line);padding-top:10px}
.bc-stack .ok{color:var(--ok)} .bc-stack .fb{color:var(--warn)}
#bc-toasts{position:absolute;left:14px;bottom:14px;display:flex;flex-direction:column;gap:8px;
  z-index:30;pointer-events:none;max-width:min(360px,72vw)}
.bc-toast{padding:9px 14px;font-size:11px;letter-spacing:.06em;background:rgba(6,14,12,.92);
  border:1px solid var(--line);border-left:3px solid var(--acc2);border-radius:8px;
  animation:bcToast .3s cubic-bezier(.2,.9,.3,1.2) both;box-shadow:0 6px 24px rgba(0,0,0,.5)}
.bc-toast.ok{border-left-color:var(--ok)} .bc-toast.warn{border-left-color:var(--warn)}
.bc-toast.err{border-left-color:var(--danger)}
.bc-toast.out{animation:bcToastOut .3s both}
#bc-fatal{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;
  padding:20px;background:rgba(2,5,6,.97)}
#bc-fatal .box{max-width:560px;border:1px solid rgba(255,61,129,.4);border-left:3px solid var(--danger);
  border-radius:14px;background:var(--surface);padding:26px 28px;display:flex;flex-direction:column;gap:14px}
#bc-fatal h2{font-size:14px;letter-spacing:.22em;color:var(--danger)}
#bc-fatal p{font-size:11px;line-height:1.9;letter-spacing:.05em}
#bc-fatal code{color:var(--acc2);background:rgba(55,200,255,.08);padding:1px 6px;border-radius:4px}
@keyframes bcDrop{from{transform:translateY(-100%);opacity:0}to{transform:none;opacity:1}}
@keyframes bcSlide{from{transform:translateX(40px);opacity:0}to{transform:none;opacity:1}}
@keyframes bcFade{from{opacity:0}to{opacity:1}}
@keyframes bcToast{from{transform:translateX(-24px);opacity:0}to{transform:none;opacity:1}}
@keyframes bcToastOut{to{transform:translateX(-24px);opacity:0}}
@media (max-width:860px){
  #bc-main{flex-direction:column}
  #bc-panel{width:100%;flex:0 0 40vh;border-left:none;border-top:1px solid var(--line)}
  #bc-top .sub{display:none}
  #bc-hint{display:none}
  #bc-hud{font-size:9.5px}
}
@media (prefers-reduced-motion:reduce){
  #bc-root *{animation-duration:.01s!important;transition-duration:.01s!important}
}
</style>
<div id="bc-top">
  <h1>BIT CITY</h1>
  <span class="sub">bitECS WORLD ENGINE · 010 · SOA SYSTEMS AT SCALE</span>
  <span class="sp"></span>
  <span class="bc-chip on" id="bc-glchip">CANVAS2D · SOA</span>
  <span class="bc-chip" id="bc-linkchip">011 …</span>
  <span id="bc-mute">♪ SOUND ON</span>
</div>
<div id="bc-main">
  <div id="bc-stage">
    <canvas id="bc-cv"></canvas>
    <div id="bc-hud"></div>
    <canvas id="bc-compass" width="52" height="52"></canvas>
    <div id="bc-boot"><span id="bc-bootlbl">SPAWNING WORLD</span>
      <div class="bar"><i id="bc-bootbar"></i></div><span id="bc-bootpct">0%</span></div>
    <div id="bc-hint">DRAG ORBIT · WHEEL / PINCH ZOOM · TAP MOVES THE ATTRACTOR</div>
    <div id="bc-toasts"></div>
  </div>
  <div id="bc-panel"></div>
</div>
<div id="bc-fatal"><div class="box">
  <h2>ECS CORE UNAVAILABLE</h2>
  <p id="bc-fatal-msg"></p>
  <p>This demo requires <code>./math/010_bitECS_core.js</code> (native ES module).
     Some browsers block local module imports from <code>file://</code> — open the
     <code>src/</code> folder from any environment with local module access.</p>
</div></div>`;

function mount() { document.body.appendChild(root); }
if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", mount); }
else { mount(); }

const $ = id => root.querySelector("#" + id);
const stage = $("bc-stage"), cv = $("bc-cv"), ctx = cv.getContext("2d");
const hudEl = $("bc-hud"), panel = $("bc-panel"), toasts = $("bc-toasts");
const bootEl = $("bc-boot"), bootBar = $("bc-bootbar"), bootPct = $("bc-bootpct"), bootLbl = $("bc-bootlbl");
const compCtx = $("bc-compass").getContext("2d");

function toast(msg, kind) {
    const t = document.createElement("div");
    t.className = "bc-toast " + (kind || "");
    t.textContent = msg;
    toasts.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 320); }, 2600);
}
function markLink() {
    const c = $("bc-linkchip");
    if (!c) { return; }
    c.textContent = ser11 ? "011 LINKED" : "011 FALLBACK";
    c.classList.toggle("on", !!ser11);
    const s = root.querySelector("#bc-stack11");
    if (s) { s.textContent = ser11 ? "LINKED" : "FALLBACK CODEC"; s.className = ser11 ? "ok" : "fb"; }
}
function setBoot(pct, label) {
    bootBar.style.width = pct + "%";
    bootPct.textContent = Math.round(pct) + "%";
    if (label) { bootLbl.textContent = label; }
}
function prng(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const yieldMain = () => new Promise(r => setTimeout(r, 0));
function fmtK(v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : Math.round(v / 1000) + "k"; }

// ============================================================================
// 3. POOLED TEMPORARIES + BACKDROP (zero-GC hot path)
// ============================================================================
const T = {
    view: mat4.acquire(), proj: mat4.acquire(), vp: mat4.acquire(), inv: mat4.acquire(),
    eye: vec3.create(), target: vec3.create(), goal: vec3.create(),
    targetVel: vec3.create(), up: vec3.fromValues(0, 1, 0),
    fwd: vec3.create(), right: vec3.create(), cup: vec3.create(),
    v3a: vec3.create(), v3b: vec3.create(), m2: mat2.create(),
    ptr: vec2.create(), ptrLast: vec2.create()
};
let W = 2, H = 2, DPR = 1;
const QUALITY_DPR = { low: 1, balanced: 1.5, high: 2 };
let backdrop = null, glowSprite = null;

function buildBackdrop() {
    backdrop = document.createElement("canvas");
    backdrop.width = Math.max(2, Math.floor(W * DPR));
    backdrop.height = Math.max(2, Math.floor(H * DPR));
    const b = backdrop.getContext("2d");
    const g = b.createLinearGradient(0, 0, 0, backdrop.height);
    g.addColorStop(0, "#020409"); g.addColorStop(0.55, "#041014"); g.addColorStop(1, "#020608");
    b.fillStyle = g; b.fillRect(0, 0, backdrop.width, backdrop.height);
    const rng = prng(4242);
    for (let i = 0; i < 700; i++) {
        const x = rng() * backdrop.width, y = rng() * backdrop.height * 0.9;
        const r = rng() * 1.4 + 0.3, a = 0.25 + rng() * 0.6;
        b.fillStyle = "rgba(" + (180 + (rng() * 75 | 0)) + ",235,255," + a.toFixed(2) + ")";
        b.fillRect(x, y, r, r);
    }
    for (let i = 0; i < 5; i++) {
        const x = rng() * backdrop.width, y = rng() * backdrop.height * 0.7;
        const rr = (0.18 + rng() * 0.3) * backdrop.width;
        const ng = b.createRadialGradient(x, y, 0, x, y, rr);
        const hue = rng() > 0.5 ? "61,230,160" : "55,200,255";
        ng.addColorStop(0, "rgba(" + hue + ",0.05)");
        ng.addColorStop(1, "rgba(" + hue + ",0)");
        b.fillStyle = ng; b.fillRect(0, 0, backdrop.width, backdrop.height);
    }
}
function buildGlowSprite() {
    glowSprite = document.createElement("canvas");
    glowSprite.width = 64; glowSprite.height = 64;
    const g = glowSprite.getContext("2d");
    const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, "rgba(255,255,255,0.95)");
    rg.addColorStop(0.3, "rgba(182,255,220,0.5)");
    rg.addColorStop(1, "rgba(61,230,160,0)");
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
}
function resize() {
    const r = stage.getBoundingClientRect();
    W = Math.max(2, r.width); H = Math.max(2, r.height);
    DPR = Math.min(window.devicePixelRatio || 1, QUALITY_DPR[S.quality]);
    cv.width = Math.floor(W * DPR); cv.height = Math.floor(H * DPR);
    buildBackdrop();
}
window.addEventListener("resize", resize);
buildGlowSprite();

// ============================================================================
// 4. CAMERA (damped orbit / zoom / pinch / follow)
// ============================================================================
const cam = { yaw: 0.9, pitch: 0.5, dist: 74, yawT: 0.9, pitchT: 0.5, distT: 74 };

function updateCamera(dt) {
    if (S.autoOrbit && !dragging) { cam.yawT += dt * 0.05; }
    const k = 1 - Math.exp(-dt * 8);
    cam.yaw += (cam.yawT - cam.yaw) * k;
    cam.pitch += (cam.pitchT - cam.pitch) * k;
    cam.dist += (cam.distT - cam.dist) * k;
    if (S.follow) { vec3.copy(T.goal, att.pos); } else { vec3.set(T.goal, 0, 0, 0); }
    vec3.springDamp3(T.target, T.target, T.goal, T.targetVel, 0.35, dt, 120);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    T.eye[0] = T.target[0] + cam.dist * cp * Math.sin(cam.yaw);
    T.eye[1] = T.target[1] + cam.dist * sp;
    T.eye[2] = T.target[2] + cam.dist * cp * Math.cos(cam.yaw);
    mat4.lookAt(T.view, T.eye, T.target, T.up);
    mat4.perspectiveNO(T.proj, S.fov * Math.PI / 180, W / H, 0.1, 900);
    mat4.multiply(T.vp, T.proj, T.view);
    mat4.invert(T.inv, T.view);
    T.right[0] = T.inv[0]; T.right[1] = T.inv[1]; T.right[2] = T.inv[2];
    T.cup[0] = T.inv[4]; T.cup[1] = T.inv[5]; T.cup[2] = T.inv[6];
    T.fwd[0] = -T.inv[8]; T.fwd[1] = -T.inv[9]; T.fwd[2] = -T.inv[10];
}
function pointerToWorld(nx, ny, out) {
    const tanF = Math.tan(S.fov * Math.PI / 360), tanA = tanF * (W / H), d = cam.dist;
    out[0] = T.eye[0] + T.fwd[0] * d + T.right[0] * nx * d * tanA + T.cup[0] * ny * d * tanF;
    out[1] = T.eye[1] + T.fwd[1] * d + T.right[1] * nx * d * tanA + T.cup[1] * ny * d * tanF;
    out[2] = T.eye[2] + T.fwd[2] * d + T.right[2] * nx * d * tanA + T.cup[2] * ny * d * tanF;
    return out;
}

// ============================================================================
// 5. WORLD REBUILD (chunked spawn, zero UI freeze, progress boot)
// ============================================================================
function allocComponents(totalN) {
    const n = totalN + 16;
    return {
        Agent: {}, Drone: {}, Orbital: {}, Beacon: {},
        Position: { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) },
        Velocity: { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) },
        Rotation: { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), w: new Float32Array(n) },
        Scale:    { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) },
        Color:    { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), w: new Float32Array(n) }
    };
}

async function rebuild(reason) {
    if (rebuilding || !ecs) { return; }
    rebuilding = true;
    bootEl.classList.remove("gone");
    setBoot(2, "CREATING WORLD");
    try {
        const crowdN = S.count;
        const orbN = Math.min(Math.floor(crowdN * S.orbShare), ORB_CAP);
        const totalN = crowdN + orbN;

        world = ecs.createWorld();
        C = allocComponents(totalN);
        spawnCounted = 0;

        // live observer: counts Drone component additions during spawn
        const unsub = ecs.observe(world, ecs.onAdd(C.Drone), () => { spawnCounted++; });

        // ---- crowd: procedural scatter with Agent+Drone components ----------
        setBoot(4, "SCATTERING " + fmtK(crowdN) + " DRONES");
        const rng = prng(seed);
        const res = await ecs.scatterEntitiesChunked(world, crowdN, {
            bounds: { x: [-52, 52], y: [-5, 7], z: [-52, 52] },
            seed: seed, noiseScale: 0.06, chunkSize: 32768, yieldEvery: 6,
            spawn: (w) => {
                const e = ecs.addEntity(w);
                ecs.addComponents(w, e, [C.Agent, C.Drone]);
                return e;
            }
        });

        // ---- copy scatter result into eid-indexed SOA components ------------
        const P = C.Position, V = C.Velocity, R = C.Rotation, SC = C.Scale, COL = C.Color;
        const ents = res.entities, rp = res.position;
        const chunk = 65536;
        let cc = 0;
        for (let s = 0; s < crowdN; s += chunk) {
            const e1 = Math.min(s + chunk, crowdN);
            for (let i = s; i < e1; i++) {
                const e = ents[i];
                P.x[e] = rp.x[i]; P.y[e] = rp.y[i]; P.z[e] = rp.z[i];
                const u1 = rng(), u2 = rng(), u3 = rng();
                V.x[e] = (u1 - 0.5) * 2.4; V.y[e] = (u2 - 0.5) * 0.5; V.z[e] = (u3 - 0.5) * 2.4;
                R.w[e] = 1;
                SC.x[e] = 1; SC.y[e] = 1; SC.z[e] = 1;
                const band = (e % 3);
                COL.x[e] = band === 0 ? 0.20 : band === 1 ? 0.24 : 0.16;
                COL.y[e] = band === 0 ? 0.85 : band === 1 ? 0.65 : 1.00;
                COL.z[e] = band === 0 ? 0.62 : band === 1 ? 0.95 : 0.80;
                COL.w[e] = 0.10;
            }
            setBoot(4 + (e1 / crowdN) * 46, "BINDING COMPONENTS " + fmtK(e1));
            if (++cc % 2 === 0) { await yieldMain(); }
        }
        unsub();

        // ---- orbital belt ----------------------------------------------------
        setBoot(52, "SEEDING ORBITAL BELT " + fmtK(orbN));
        orbSys = ecs.createOrbitalSystem({ timeScale: 1, mu: 640 });
        orbResult = ecs.spawnOrbitalBodies(world, orbN, {
            aMin: 30, aMax: 88, eMin: 0, eMax: 0.30, incMax: 0.45, seed: seed + 7,
            spawn: (w) => {
                const e = ecs.addEntity(w);
                ecs.addComponents(w, e, [C.Agent, C.Orbital]);
                return e;
            }
        });
        for (let k = 0; k < orbN; k++) {
            const e = orbResult.entities[k];
            R.w[e] = 1; SC.x[e] = 1; SC.y[e] = 1; SC.z[e] = 1;
            COL.x[e] = 1.0; COL.y[e] = 0.72; COL.z[e] = 0.25; COL.w[e] = 0.25;
        }
        orbPos = ecs.vec3.createVec3SOA(Math.max(1, orbN));
        orbSys.setBodies(orbResult);
        await yieldMain();

        // ---- beacons ----------------------------------------------------------
        setBoot(62, "IGNITING BEACONS");
        beaconList = [];
        const bStride = Math.max(1, Math.floor(crowdN / 420));
        for (let i = 0; i < crowdN; i += bStride) {
            const e = ents[i];
            ecs.addComponent(world, e, C.Beacon);
            COL.x[e] = 0.85; COL.y[e] = 1.0; COL.z[e] = 0.9; COL.w[e] = 1.0;
            beaconList.push(e);
        }

        // ---- cache archetype queries ------------------------------------------
        crowdList = ecs.query(world, [C.Drone]);
        orbList = ecs.query(world, [C.Orbital]);
        beaconList = ecs.query(world, [C.Beacon]);

        // ---- animation system (spring-damped drones) ---------------------------
        animN = Math.min(crowdN, ANIM_CAP);
        animSys = ecs.createAnimationSystem({ maxEntries: animN });
        phaseArr = new Float32Array(animN);
        radiiArr = new Float32Array(animN);
        const rng2 = prng(seed ^ 0x5f3759df);
        for (let i = 0; i < animN; i++) {
            animSys.add(i, { smoothTime: 0.35 + rng2() * 0.5, maxSpeed: 26 });
            phaseArr[i] = rng2() * Math.PI * 2;
            radiiArr[i] = 3 + rng2() * 11;
        }
        trsView = {
            position: { x: P.x.subarray(1, 1 + animN), y: P.y.subarray(1, 1 + animN), z: P.z.subarray(1, 1 + animN) },
            rotation: { x: R.x.subarray(1, 1 + animN), y: R.y.subarray(1, 1 + animN), z: R.z.subarray(1, 1 + animN), w: R.w.subarray(1, 1 + animN) }
        };
        targetTRS = ecs.createTransformSOA(animN);
        targetTRS.rotation.w.fill(1);
        crowdTRSView = { position: { x: P.x, y: P.y, z: P.z, count: totalN + 16 } };

        // ---- IK cranes ----------------------------------------------------------
        if (!ikSys) { ikSys = ecs.createIKSystem({ maxChains: 8, maxBones: 10 }); }
        ikChainIdx = [];
        for (let i = 0; i < IK_CHAINS; i++) {
            const a = (i / IK_CHAINS) * Math.PI * 2;
            const pos = new Float32Array(IK_BONES * 3);
            const lens = new Float32Array(IK_BONES - 1);
            for (let b = 0; b < IK_BONES; b++) {
                pos[b * 3] = Math.cos(a) * 16;
                pos[b * 3 + 1] = -7 + b * 1.35;
                pos[b * 3 + 2] = Math.sin(a) * 16;
            }
            lens.fill(1.35);
            const idx = ikSys.addChain({
                boneCount: IK_BONES, pos: pos, lens: lens,
                target: [att.pos[0], att.pos[1], att.pos[2]],
                iterations: 7, method: "fabrik"
            });
            ikChainIdx.push(idx);
        }

        // ---- color / grid / batch / floating origin ------------------------------
        colorSys = ecs.createColorSystem();
        grid = ecs.createSpatialGrid(6, { maxEntities: totalN + 32, gridDim: 64, queryCapacity: 4096 });
        gridStride = Math.max(1, Math.floor(crowdN / 200000));
        if (!batch) { batch = ecs.createInstanceBatch({ maxSize: BATCH_SIZE }); }
        if (!fo) { fo = ecs.createFloatingOrigin({ threshold: 420 }); }

        setBoot(100, "WORLD ONLINE");
        await yieldMain();
        if (reason) { toast(reason + " · " + fmtK(totalN) + " ENTITIES", "ok"); }
    } catch (err) {
        console.error("[010_demo] rebuild failed:", err);
        toast("REBUILD FAILED — see console", "err");
    }
    rebuilding = false;
    bootEl.classList.add("gone");
}
let ikChainIdx = [];

// ============================================================================
// 6. SYSTEMS (per-frame, individually timed)
// ============================================================================
function flowSystem(dt) {
    const list = crowdList, n = list.length;
    const px = C.Position.x, py = C.Position.y, pz = C.Position.z;
    const vx = C.Velocity.x, vy = C.Velocity.y, vz = C.Velocity.z;
    const s = S.flow * dt, sw = 0.10 * dt * S.flow;
    for (let k = 0; k < n; k++) {
        const e = list[k];
        const x = px[e], y = py[e], z = pz[e];
        vx[e] += -z * sw - vx[e] * 0.015;
        vz[e] +=  x * sw - vz[e] * 0.015;
        vy[e] += -y * 0.04 - vy[e] * 0.04;
        let nx = x + vx[e] * s, ny = y + vy[e] * s, nz = z + vz[e] * s;
        if (nx * nx + nz * nz > 4900) { nx *= 0.998; nz *= 0.998; }
        px[e] = nx; py[e] = ny; pz[e] = nz;
    }
}

function animSystem(dt) {
    const tp = targetTRS.position;
    const ax = att.pos[0], ay = att.pos[1], az = att.pos[2];
    const t = simTime;
    for (let i = 0; i < animN; i++) {
        const ph = phaseArr[i], r = radiiArr[i];
        tp.x[i] = ax + Math.cos(t * 0.7 + ph) * r;
        tp.y[i] = ay + Math.sin(t * 1.1 + ph * 1.7) * (r * 0.35);
        tp.z[i] = az + Math.sin(t * 0.7 + ph) * r;
    }
    animSys.step(dt, trsView, targetTRS);
}

function orbitalSystem(dt) {
    if (!orbResult || orbResult.entities.length === 0) { return; }
    orbSys.step(dt, orbPos);
    const eids = orbResult.entities, n = eids.length;
    const P = C.Position, op = orbPos;
    const ox = origin64[0], oy = origin64[1], oz = origin64[2];
    for (let k = 0; k < n; k++) {
        const e = eids[k];
        P.x[e] = op.x[k] - ox; P.y[e] = op.y[k] - oy; P.z[e] = op.z[k] - oz;
    }
}

function ikSystem() {
    for (let i = 0; i < ikChainIdx.length; i++) {
        const off = i * 1.047;
        ikSys.setTarget(ikChainIdx[i],
            att.pos[0] + Math.cos(off) * 2, att.pos[1] + Math.sin(simTime + off), att.pos[2] + Math.sin(off) * 2);
    }
    ikSys.step();
}
function ikAvgError() {
    let sum = 0;
    for (let i = 0; i < ikChainIdx.length; i++) {
        const p = ikSys.getChainPositions(ikChainIdx[i]);
        const li = (IK_BONES - 1) * 3;
        const dx = p[li] - att.pos[0], dy = p[li + 1] - att.pos[1], dz = p[li + 2] - att.pos[2];
        sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return ikChainIdx.length ? sum / ikChainIdx.length : 0;
}

function colorSystem(dtStep) {
    // hue-drift over the drone color view (dense eid range 1..crowdN)
    const n = crowdList.length;
    const view = {
        x: C.Color.x.subarray(1, 1 + n), y: C.Color.y.subarray(1, 1 + n),
        z: C.Color.z.subarray(1, 1 + n), count: n
    };
    colorSys.hueRotate(view, view, S.hueDrift * dtStep);
}

function gridSystem() {
    grid.clear();
    const list = crowdList, n = list.length;
    const px = C.Position.x, py = C.Position.y, pz = C.Position.z;
    for (let k = 0; k < n; k += gridStride) {
        const e = list[k];
        grid.insert(e, px[e], py[e], pz[e]);
    }
    nearbyCount = grid.querySphere(att.pos[0], att.pos[1], att.pos[2], S.gridRadius);
}

function batchSystem() {
    batch.clear();
    const list = crowdList, n = list.length;
    const bStride = Math.max(1, Math.floor(n / batch.maxSize));
    const worldTRS = { position: C.Position, rotation: C.Rotation, scale: C.Scale };
    for (let k = 0; k < n && batch.count < batch.maxSize; k += bStride) {
        const e = list[k];
        batch.addFromTRS(e, worldTRS, e, null);
    }
    batch.getInstanceMatrixBuffer(); // proves the flat GPU-upload path
}

function floatingOriginCheck() {
    if (!S.autoOrigin) { return; }
    const before0 = T.target[0], before1 = T.target[1], before2 = T.target[2];
    if (fo.recenter(T.target, crowdTRSView)) { applyOriginShift(before0, before1, before2); }
}
function applyOriginShift(sx, sy, sz) {
    origin64[0] += sx; origin64[1] += sy; origin64[2] += sz;
    originShifts++;
    att.pos[0] -= sx; att.pos[1] -= sy; att.pos[2] -= sz;
    for (let i = 0; i < ikChainIdx.length; i++) {
        const p = ikSys.getChainPositions(ikChainIdx[i]);
        for (let b = 0; b < IK_BONES; b++) { p[b * 3] -= sx; p[b * 3 + 1] -= sy; p[b * 3 + 2] -= sz; }
    }
    vec3.set(T.targetVel, 0, 0, 0);
    toast("FLOATING ORIGIN RECENTERED · Δ " + Math.round(Math.hypot(sx, sy, sz)) + " km", "ok");
    audio.blip(660); audio.blip(990);
}
function manualRecenter() {
    const sx = T.target[0], sy = T.target[1], sz = T.target[2];
    if (Math.abs(sx) + Math.abs(sy) + Math.abs(sz) < 1) { return; }
    const P = C.Position, n = crowdTRSView.position.count;
    for (let i = 0; i < n; i++) { P.x[i] -= sx; P.y[i] -= sy; P.z[i] -= sz; }
    applyOriginShift(sx, sy, sz);
}

function updateAttractor(dt) {
    if (att.manual > 0) { att.manual -= dt; return; }
    const t = simTime;
    att.pos[0] = Math.sin(t * 0.23) * 24;
    att.pos[1] = 4 + Math.sin(t * 0.37) * 5;
    att.pos[2] = Math.cos(t * 0.19) * 24;
}

// ============================================================================
// 7. RENDERER (Canvas2D, bucketed draws, zero alloc)
// ============================================================================
const _proj = { x: 0, y: 0, w: 0 };
function project(x, y, z) {
    const M = T.vp;
    const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (cw < 0.3) { return false; }
    const inv = 1 / cw;
    _proj.x = ((M[0] * x + M[4] * y + M[8] * z + M[12]) * inv * 0.5 + 0.5) * W;
    _proj.y = (1 - ((M[1] * x + M[5] * y + M[9] * z + M[13]) * inv * 0.5 + 0.5)) * H;
    _proj.w = cw;
    return true;
}

function drawGround() {
    if (!S.ground) { return; }
    ctx.strokeStyle = "rgba(61,230,160,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const Y = -8, R = 90, STEP = 10;
    for (let i = -R; i <= R; i += STEP) {
        if (project(i, Y, -R)) { ctx.moveTo(_proj.x, _proj.y); }
        if (project(i, Y, R)) { ctx.lineTo(_proj.x, _proj.y); }
        if (project(-R, Y, i)) { ctx.moveTo(_proj.x, _proj.y); }
        if (project(R, Y, i)) { ctx.lineTo(_proj.x, _proj.y); }
    }
    ctx.stroke();
}

function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (backdrop) { ctx.drawImage(backdrop, 0, 0, W, H); }
    else { ctx.fillStyle = "#04070c"; ctx.fillRect(0, 0, W, H); }

    drawGround();

    const P = C.Position, COL = C.Color;
    const list = crowdList, n = list.length;
    const cap = Math.min(S.drawCap, govDrawCap);
    const stride = Math.max(1, Math.floor(n / cap));
    const ds = S.dotSize;

    // --- drones (single batched path) ---
    ctx.fillStyle = "rgba(88,214,255,0.75)";
    ctx.beginPath();
    for (let k = 0; k < n; k += stride) {
        const e = list[k];
        if (!project(P.x[e], P.y[e], P.z[e])) { continue; }
        ctx.rect(_proj.x, _proj.y, ds, ds);
    }
    ctx.fill();

    // --- orbitals ---
    if (orbList.length) {
        ctx.fillStyle = "rgba(255,183,77,0.8)";
        ctx.beginPath();
        const oStride = Math.max(1, Math.floor(orbList.length / 20000));
        for (let k = 0; k < orbList.length; k += oStride) {
            const e = orbList[k];
            if (!project(P.x[e], P.y[e], P.z[e])) { continue; }
            ctx.rect(_proj.x, _proj.y, ds * 0.9, ds * 0.9);
        }
        ctx.fill();
    }

    // --- instance-batch subset (rendered from the batch mat4 SOA) ---
    const BM = batch.transforms.arrays;
    ctx.fillStyle = "rgba(61,230,160,0.9)";
    ctx.beginPath();
    for (let i = 0; i < batch.count; i += 4) {
        if (!project(BM[12][i], BM[13][i], BM[14][i])) { continue; }
        const s = ds + 1.2;
        ctx.rect(_proj.x - s * 0.5, _proj.y - s * 0.5, s, s);
    }
    ctx.fill();

    // --- grid neighborhood: per-entity colors from the Color SOA ---
    const near = Math.min(nearbyCount, 1400);
    const results = grid.getQueryResults();
    for (let k = 0; k < near; k++) {
        const e = results[k];
        if (e >= COL.x.length || !project(P.x[e], P.y[e], P.z[e])) { continue; }
        ctx.fillStyle = "rgba(" + ((COL.x[e] * 255) | 0) + "," + ((COL.y[e] * 255) | 0) + "," + ((COL.z[e] * 255) | 0) + ",0.95)";
        ctx.fillRect(_proj.x - 1.4, _proj.y - 1.4, 3.2, 3.2);
    }

    // --- beacons (glow sprites) ---
    for (let k = 0; k < beaconList.length; k++) {
        const e = beaconList[k];
        if (!project(P.x[e], P.y[e], P.z[e])) { continue; }
        const s = Math.max(4, Math.min(26, 90 / _proj.w));
        ctx.globalAlpha = Math.max(0.25, Math.min(0.9, 6 / _proj.w));
        ctx.drawImage(glowSprite, _proj.x - s * 0.5, _proj.y - s * 0.5, s, s);
    }
    ctx.globalAlpha = 1;

    // --- IK cranes ---
    ctx.lineWidth = 1.4;
    for (let i = 0; i < ikChainIdx.length; i++) {
        const p = ikSys.getChainPositions(ikChainIdx[i]);
        ctx.strokeStyle = "rgba(182,255,61,0.85)";
        ctx.beginPath();
        let started = false;
        for (let b = 0; b < IK_BONES; b++) {
            if (!project(p[b * 3], p[b * 3 + 1], p[b * 3 + 2])) { started = false; continue; }
            if (!started) { ctx.moveTo(_proj.x, _proj.y); started = true; }
            else { ctx.lineTo(_proj.x, _proj.y); }
        }
        ctx.stroke();
    }

    // --- attractor marker ---
    if (project(att.pos[0], att.pos[1], att.pos[2])) {
        const pulse = 10 + Math.sin(simTime * 4) * 3;
        ctx.strokeStyle = att.manual > 0 ? "rgba(255,61,129,0.9)" : "rgba(55,200,255,0.8)";
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(_proj.x, _proj.y, pulse, 0, 6.2832); ctx.stroke();
        ctx.drawImage(glowSprite, _proj.x - 14, _proj.y - 14, 28, 28);
    }
}

// ============================================================================
// 8. HUD + COMPASS
// ============================================================================
let hudTick = 0;
function updateHUD() {
    if (++hudTick % 8 !== 0) { return; }
    const total = crowdList.length + orbList.length;
    hudEl.textContent =
        "BIT CITY · bitECS 010 WORLD\n" +
        "fps " + fpsEma.toFixed(0) + " · entities " + fmtK(total) +
        " (" + fmtK(crowdList.length) + " drones + " + fmtK(orbList.length) + " orbital)\n" +
        "systems ms · flow " + timings.flow.toFixed(1) + " · anim " + timings.anim.toFixed(1) +
        " · orb " + timings.orb.toFixed(1) + " · ik " + timings.ik.toFixed(1) + "\n" +
        "           grid " + timings.grid.toFixed(1) + " · color " + timings.color.toFixed(1) +
        " · batch " + timings.batch.toFixed(1) + " · draw " + timings.render.toFixed(1) + "\n" +
        "grid      : " + nearbyCount + " neighbors · r " + S.gridRadius.toFixed(0) +
        " · stride " + gridStride + " · every " + gridInterval + "f\n" +
        "ik        : " + IK_CHAINS + " FABRIK chains · err " + ikAvgError().toFixed(2) + "\n" +
        "batch     : " + batch.count + " instances packed (mat4 SOA)\n" +
        "origin    : shifts " + originShifts + " · " +
        (origin64[0] / 1000).toFixed(2) + ", " + (origin64[1] / 1000).toFixed(2) + ", " +
        (origin64[2] / 1000).toFixed(2) + " Mm" + (paused ? " · HELD" : "");
    mat2.fromRotation(T.m2, -cam.yaw);
    const c = compCtx;
    c.clearRect(0, 0, 52, 52);
    c.strokeStyle = "rgba(61,230,160,.3)";
    c.beginPath(); c.arc(26, 26, 22, 0, 6.2832); c.stroke();
    const nx = T.m2[0] * 0 + T.m2[2] * -1, ny = T.m2[1] * 0 + T.m2[3] * -1;
    c.strokeStyle = "#3de6a0"; c.lineWidth = 2;
    c.beginPath(); c.moveTo(26, 26); c.lineTo(26 + nx * 18, 26 + ny * 18); c.stroke();
}

// ============================================================================
// 9. AUDIO (ambient pad + event blips, one-touch mute)
// ============================================================================
const audio = (function () {
    let ctxA = null, master = null, muted = false, started = false;
    function ensure() {
        if (started) { return; }
        try {
            ctxA = new (window.AudioContext || window.webkitAudioContext)();
            master = ctxA.createGain(); master.gain.value = 0.5; master.connect(ctxA.destination);
            const lp = ctxA.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 210; lp.Q.value = 1.6;
            const dg = ctxA.createGain(); dg.gain.value = 0.045;
            lp.connect(dg); dg.connect(master);
            [41.2, 41.6, 82.8].forEach(f => {
                const o = ctxA.createOscillator(); o.type = "sawtooth"; o.frequency.value = f;
                o.connect(lp); o.start();
            });
            const lfo = ctxA.createOscillator(); lfo.frequency.value = 0.06;
            const lg = ctxA.createGain(); lg.gain.value = 70;
            lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
            started = true;
        } catch (e) { /* silent */ }
    }
    function tone(freq, dur, vol, type) {
        if (!ctxA || muted) { return; }
        const o = ctxA.createOscillator(), g = ctxA.createGain();
        o.type = type || "sine"; o.frequency.value = freq;
        g.gain.setValueAtTime(vol, ctxA.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctxA.currentTime + dur);
        o.connect(g); g.connect(master);
        o.start(); o.stop(ctxA.currentTime + dur);
    }
    return {
        ensure,
        blip(f) { ensure(); tone(f || 880, 0.13, 0.06, "triangle"); },
        sweep() {
            if (!ctxA || muted) { return; }
            const o = ctxA.createOscillator(), g = ctxA.createGain();
            o.type = "sine";
            o.frequency.setValueAtTime(120, ctxA.currentTime);
            o.frequency.exponentialRampToValueAtTime(480, ctxA.currentTime + 1.6);
            g.gain.setValueAtTime(0.0001, ctxA.currentTime);
            g.gain.exponentialRampToValueAtTime(0.035, ctxA.currentTime + 0.5);
            g.gain.exponentialRampToValueAtTime(0.0001, ctxA.currentTime + 2.2);
            o.connect(g); g.connect(master);
            o.start(); o.stop(ctxA.currentTime + 2.3);
        },
        toggle() {
            muted = !muted;
            if (!muted) { ensure(); }
            if (master) { master.gain.value = muted ? 0 : 0.5; }
            const el = $("bc-mute");
            el.textContent = muted ? "♪ SOUND OFF" : "♪ SOUND ON";
            el.style.color = muted ? "var(--dim)" : "var(--acc2)";
            return muted;
        }
    };
})();
$("bc-mute").addEventListener("pointerdown", (e) => { e.preventDefault(); audio.toggle(); });

// ============================================================================
// 10. ACTIONS — reset / randomize / export / pause
// ============================================================================
let rebuildTimer = 0;
function scheduleRebuild(reason) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => { rebuild(reason); }, 260);
}
function resetAll() {
    Object.assign(S, DEFAULTS);
    seed = 930211;
    origin64.fill(0); originShifts = 0;
    cam.yawT = 0.9; cam.pitchT = 0.5; cam.distT = 74;
    att.manual = 0;
    syncControls(); resize();
    rebuild("WORLD RESET");
    audio.blip(520);
}
function randomize() {
    seed = (Math.random() * 1e9) | 0;
    rebuild("WORLD RESEEDED · #" + seed);
    audio.blip(700); audio.blip(940);
}
function togglePause() {
    paused = !paused;
    const b = panel.querySelector('[data-act="pause"]');
    if (b) { b.textContent = paused ? "▶ RESUME" : "⏸ PAUSE"; }
    toast(paused ? "SIMULATION HELD" : "SIMULATION LIVE", paused ? "warn" : "ok");
    audio.blip(paused ? 440 : 880);
}

let exportBusy = false;
async function exportSnapshot() {
    if (exportBusy || !world || rebuilding) { return; }
    exportBusy = true;
    const btn = panel.querySelector('[data-act="export"]');
    if (btn) { btn.disabled = true; }
    toast("PACKING WORLD SNAPSHOT…");
    try {
        const K = Math.min(8192, crowdList.length);
        const step = Math.max(1, Math.floor(crowdList.length / K));
        const eids = new Uint32Array(K);
        const trs = ecs.createTransformSOA(K);
        const col = ecs.createColorSOA(K);
        const P = C.Position, R = C.Rotation, SC = C.Scale, COL = C.Color;
        for (let k = 0; k < K; k++) {
            const e = crowdList[k * step];
            eids[k] = e;
            trs.position.x[k] = P.x[e]; trs.position.y[k] = P.y[e]; trs.position.z[k] = P.z[e];
            trs.rotation.x[k] = R.x[e]; trs.rotation.y[k] = R.y[e]; trs.rotation.z[k] = R.z[e]; trs.rotation.w[k] = R.w[e];
            trs.scale.x[k] = SC.x[e]; trs.scale.y[k] = SC.y[e]; trs.scale.z[k] = SC.z[e];
            col.x[k] = COL.x[e]; col.y[k] = COL.y[e]; col.z[k] = COL.z[e]; col.w[k] = COL.w[e];
        }
        let bytes;
        if (ser11) {
            const writer = ser11.createByteWriter(1 << 22);
            await ser11.serializeScene(writer, { eids: eids, trs: trs, colors: col }, { chunkSize: 4096 });
            bytes = writer.slice();
            writer.release();
        } else {
            const buf = new ArrayBuffer(30 + K * 28);
            const dv = new DataView(buf);
            dv.setUint32(0, 0x42435459); dv.setUint16(4, 1); dv.setUint32(6, K);
            dv.setFloat64(10, origin64[0]); dv.setFloat64(18, origin64[1]); dv.setFloat64(26, origin64[2] - 4);
            let o = 30;
            for (let k = 0; k < K; k++) {
                dv.setFloat32(o, trs.position.x[k]); dv.setFloat32(o + 4, trs.position.y[k]); dv.setFloat32(o + 8, trs.position.z[k]);
                dv.setFloat32(o + 12, col.x[k]); dv.setFloat32(o + 16, col.y[k]);
                dv.setFloat32(o + 20, col.z[k]); dv.setFloat32(o + 24, col.w[k]);
                o += 28;
            }
            bytes = buf;
        }
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "bit-city-" + fmtK(crowdList.length) + "-" + (ser11 ? "011" : "bcty") + ".bin";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast("EXPORTED " + (bytes.byteLength / 1048576).toFixed(2) + " MB · " + K + " entities", "ok");
        audio.blip(880); audio.blip(1320);
    } catch (e) {
        console.error("[010_demo] export:", e);
        toast("EXPORT FAILED — see console", "err");
    }
    exportBusy = false;
    if (btn) { btn.disabled = false; }
}

// ============================================================================
// 11. CONTROL DECK (permanently visible, everything live)
// ============================================================================
const controlRefs = {};
function addSection(letter, title) {
    const d = document.createElement("div");
    d.className = "bc-sec";
    d.innerHTML = "<b>" + letter + "</b> " + title;
    panel.appendChild(d);
}
function addRange(key, label, min, max, step, fmt, onInput) {
    const row = document.createElement("div");
    row.className = "bc-row";
    row.innerHTML = `<label>${label}<output>${fmt(S[key])}</output></label>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${S[key]}">`;
    const input = row.querySelector("input"), out = row.querySelector("output");
    input.addEventListener("input", () => {
        S[key] = parseFloat(input.value);
        out.textContent = fmt(S[key]);
        onInput(S[key]);
    });
    panel.appendChild(row);
    controlRefs[key] = { input, out, fmt };
}
function addSelect(key, label, options, onChange) {
    const row = document.createElement("div");
    row.className = "bc-row";
    row.innerHTML = `<label>${label}</label><select class="bc-sel">${
        options.map(o => `<option value="${o[0]}" ${S[key] === o[0] ? "selected" : ""}>${o[1]}</option>`).join("")
    }</select>`;
    const sel = row.querySelector("select");
    sel.addEventListener("change", () => { S[key] = sel.value; onChange(sel.value); });
    panel.appendChild(row);
    controlRefs[key] = { input: sel };
}
function addToggle(key, label, onChange) {
    const row = document.createElement("div");
    row.className = "bc-tog" + (S[key] ? " on" : "");
    row.innerHTML = `<span>${label}</span><span class="sw"></span>`;
    row.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        S[key] = !S[key];
        row.classList.toggle("on", S[key]);
        audio.blip(S[key] ? 980 : 620);
        if (onChange) { onChange(S[key]); }
    });
    panel.appendChild(row);
    controlRefs[key] = { input: row, isToggle: true };
}
function addButton(act, label, cls, fn) {
    const b = document.createElement("button");
    b.className = "bc-btn " + (cls || "");
    b.textContent = label;
    b.dataset.act = act;
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); fn(); });
    return b;
}
function buildPanel() {
    addSection("A", "WORLD");
    addRange("count", "ENTITIES", 10000, MAX_HARD, 10000, v => fmtK(v), () => scheduleRebuild("FIELD RESIZED"));
    addRange("orbShare", "ORBITAL SHARE", 0, 0.4, 0.02, v => Math.round(v * 100) + "%", () => scheduleRebuild("ORBITAL RETUNED"));

    addSection("B", "SYSTEMS");
    addRange("timeScale", "TIME SCALE", 0, 4, 0.05, v => v.toFixed(2) + "×", () => {});
    addRange("flow", "FLOW SPEED", 0, 3, 0.05, v => v.toFixed(2), () => {});
    addRange("hueDrift", "HUE DRIFT", 0, 2, 0.05, v => v.toFixed(2) + " rad/s", () => {});
    addRange("gridRadius", "GRID QUERY RADIUS", 4, 30, 1, v => v.toFixed(0), () => {});

    addSection("C", "CAMERA & ORIGIN");
    addRange("fov", "FIELD OF VIEW", 35, 90, 1, v => v.toFixed(0) + "°", () => {});
    addToggle("autoOrbit", "AUTO ORBIT DRIFT");
    addToggle("follow", "FOLLOW ATTRACTOR");
    addToggle("autoOrigin", "AUTO FLOATING ORIGIN");

    addSection("D", "RENDER");
    addSelect("quality", "QUALITY (PIXEL RATIO)",
        [["low", "Low · 1.0×"], ["balanced", "Balanced · 1.5×"], ["high", "High · 2.0×"]], () => resize());
    addRange("drawCap", "DRAW CAP", 5000, 150000, 5000, v => fmtK(v), () => {});
    addRange("dotSize", "DOT SIZE", 1, 4, 0.25, v => v.toFixed(2) + "px", () => {});
    addToggle("ground", "GROUND GRID");

    addSection("E", "ACTIONS");
    const gridBtns = document.createElement("div");
    gridBtns.className = "bc-btns";
    gridBtns.appendChild(addButton("pause", "⏸ PAUSE", "", togglePause));
    gridBtns.appendChild(addButton("recenter", "🌍 RECENTER", "", manualRecenter));
    gridBtns.appendChild(addButton("random", "🎲 RANDOMIZE", "", randomize));
    gridBtns.appendChild(addButton("reset", "↺ RESET", "", resetAll));
    gridBtns.appendChild(addButton("export", "⬇ EXPORT SNAPSHOT (.bin)", "pri", exportSnapshot));
    panel.appendChild(gridBtns);

    const keys = document.createElement("div");
    keys.className = "bc-keys";
    keys.innerHTML = "<b>SPACE</b> pause · <b>R</b> reset · <b>O</b> recenter · <b>E</b> export<br><b>M</b> mute · <b>F</b> follow · <b>G</b> ground · <b>tap</b> lure";
    panel.appendChild(keys);

    const stack = document.createElement("div");
    stack.className = "bc-stack";
    stack.innerHTML = `MODULE STACK<br>010 bitECS core · <span class="ok">ENGINE</span><br>003 vec3 · 005 mat2 · 007 mat4 · 002 vec2 · <span class="ok">LINKED</span><br>011 serialization · <span id="bc-stack11" class="fb">PROBING…</span>`;
    panel.appendChild(stack);
}
function syncControls() {
    for (const k in controlRefs) {
        const c = controlRefs[k];
        if (c.isToggle) { c.input.classList.toggle("on", !!S[k]); }
        else if (c.input.tagName === "SELECT") { c.input.value = S[k]; }
        else { c.input.value = S[k]; if (c.out) { c.out.textContent = c.fmt(S[k]); } }
    }
}
buildPanel();
setTimeout(markLink, 1500);

// ============================================================================
// 12. INPUT — drag orbit, wheel/pinch zoom, tap lure
// ============================================================================
let dragging = false, moved = 0;
const pointers = new Map();
let pinchDist = 0;

cv.addEventListener("pointerdown", (e) => {
    audio.ensure();
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) {
        dragging = true; moved = 0;
        vec2.set(T.ptrLast, e.clientX, e.clientY);
    } else if (pointers.size === 2) {
        const p = Array.from(pointers.values());
        pinchDist = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
    }
});
cv.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) { return; }
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
        const p = Array.from(pointers.values());
        const d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
        if (pinchDist > 0) { cam.distT = Math.max(14, Math.min(360, cam.distT * (pinchDist / d))); }
        pinchDist = d;
        return;
    }
    if (!dragging) { return; }
    vec2.set(T.ptr, e.clientX, e.clientY);
    vec2.subtract(T.ptr, T.ptr, T.ptrLast);
    moved += Math.abs(T.ptr[0]) + Math.abs(T.ptr[1]);
    cam.yawT += T.ptr[0] * 0.005;
    cam.pitchT = Math.max(-1.3, Math.min(1.4, cam.pitchT + T.ptr[1] * 0.004));
    vec2.set(T.ptrLast, e.clientX, e.clientY);
});
cv.addEventListener("pointerup", (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
        if (dragging && moved < 8) {
            const r = cv.getBoundingClientRect();
            pointerToWorld(((e.clientX - r.left) / r.width) * 2 - 1,
                -(((e.clientY - r.top) / r.height) * 2 - 1), att.pos);
            att.manual = 8;
            toast("ATTRACTOR SET · drones + cranes respond", "ok");
            audio.blip(1180);
        }
        dragging = false; pinchDist = 0;
    }
});
cv.addEventListener("pointercancel", (e) => { pointers.delete(e.pointerId); dragging = false; pinchDist = 0; });
cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    cam.distT = Math.max(14, Math.min(360, cam.distT * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });

window.addEventListener("keydown", (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { return; }
    const k = e.key.toLowerCase();
    if (k === " ") { e.preventDefault(); togglePause(); }
    else if (k === "r") { resetAll(); }
    else if (k === "o") { manualRecenter(); }
    else if (k === "e") { exportSnapshot(); }
    else if (k === "m") { audio.toggle(); }
    else if (k === "f") { S.follow = !S.follow; syncControls(); toast(S.follow ? "FOLLOWING ATTRACTOR" : "FREE ORBIT"); }
    else if (k === "g") { S.ground = !S.ground; syncControls(); }
});

// ============================================================================
// 13. MAIN LOOP — one rAF, timed systems, adaptive governor
// ============================================================================
let lastT = 0, fpsAcc = 0, fpsN = 0, fpsClock = 0, songT = 9;

function frame(now) {
    requestAnimationFrame(frame);
    now *= 0.001;
    const dt = Math.min(0.05, now - lastT || 0.016);
    lastT = now;

    fpsAcc += dt; fpsN++;
    if (now - fpsClock > 0.5) {
        fpsEma = fpsEma * 0.75 + (fpsN / Math.max(fpsAcc, 1e-4)) * 0.25;
        // adaptive governor: never touches resolution, only workload
        if (fpsEma < 38) {
            govDrawCap = Math.max(8000, Math.min(govDrawCap, S.drawCap) * 0.8);
            gridInterval = Math.min(6, gridInterval + 1);
        } else if (fpsEma > 54) {
            govDrawCap = Math.min(S.drawCap, govDrawCap * 1.15 + 500);
            if (govDrawCap >= S.drawCap * 0.95) { gridInterval = Math.max(2, gridInterval - 1); }
        }
        fpsAcc = 0; fpsN = 0; fpsClock = now;
    }

    if (!paused && !rebuilding && world) {
        const simDt = dt * S.timeScale;
        simTime += simDt;

        let t0 = performance.now();
        updateAttractor(simDt);
        flowSystem(simDt);
        timings.flow = timings.flow * 0.9 + (performance.now() - t0) * 0.1;

        t0 = performance.now();
        if (animN > 0) { animSystem(simDt); }
        timings.anim = timings.anim * 0.9 + (performance.now() - t0) * 0.1;

        t0 = performance.now();
        orbitalSystem(simDt);
        timings.orb = timings.orb * 0.9 + (performance.now() - t0) * 0.1;

        t0 = performance.now();
        ikSystem();
        timings.ik = timings.ik * 0.9 + (performance.now() - t0) * 0.1;

        t0 = performance.now();
        if (frameIdx % gridInterval === 0) { gridSystem(); }
        timings.grid = timings.grid * 0.9 + (performance.now() - t0) * 0.1;

        t0 = performance.now();
        if (frameIdx % 2 === 0 && S.hueDrift > 0) { colorSystem(simDt * 2); }
        timings.color = timings.color * 0.9 + (performance.now() - t0) * 0.1;

        t0 = performance.now();
        batchSystem();
        timings.batch = timings.batch * 0.9 + (performance.now() - t0) * 0.1;

        floatingOriginCheck();
        frameIdx++;

        songT -= dt;
        if (songT <= 0) { songT = 11 + Math.random() * 7; audio.sweep(); }
    }

    if (world) {
        updateCamera(dt);
        const t0 = performance.now();
        render();
        timings.render = timings.render * 0.9 + (performance.now() - t0) * 0.1;
        updateHUD();
    }
}

// ============================================================================
// 14. BOOT — dynamic ECS import, graceful fatal panel, staged entrance
// ============================================================================
(async function main() {
    resize();
    setBoot(1, "LINKING bitECS CORE");
    try {
        ecs = await import("./math/010_bitECS_core.js");
    } catch (err) {
        console.error("[010_demo] ECS core failed to load:", err);
        bootEl.classList.add("gone");
        $("bc-fatal-msg").textContent = "Failed to load ./math/010_bitECS_core.js — " +
            (err && err.message ? err.message : String(err));
        $("bc-fatal").style.display = "flex";
        return;
    }
    await rebuild(null);
    toast("WORLD ONLINE · " + fmtK(S.count) + " ENTITIES · ALL SYSTEMS NOMINAL", "ok");
    requestAnimationFrame(frame);
})();