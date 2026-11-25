// file number : 017
// full path name : src/particle_showcase.js
// description : "PARTICLE THEATRE" — a 3D particle showcase in the spirit of
//               a three.js r185 Points scene, but with three.js fully
//               REPLACED by the provided SOA math stack + bitECS:
//                 three.js r185 concept        ->  our replacement
//                 THREE.Vector2/3/4            ->  002/003/004 SOA + flat
//                 THREE.Matrix3/4, camera math ->  006 mat3 grading, 007 mat4
//                 THREE.Quaternion slerp/spring->  008 quat (frame slerp)
//                 rigid body transforms        ->  009 quat2 comet DQ orbits
//                 scene graph / buffers        ->  010 bitECS world, SOA
//                                                   components, queries,
//                                                   spatial grid, animation
//                                                   system, color system,
//                                                   floating origin
//                 loaders / snapshots          ->  011 serialization (dynamic,
//                                                   graceful fallback codec)
//               80,000 particles (10k–300k slider) live in a bitECS world and
//               perform 8 choreographed ACTS with AUTO-CYCLE (12 s) and
//               AUTO-RANDOMIZATION (new seed, palette drift, formation frame
//               quaternion, attractor paths and burst layout on every switch):
//                 0 ORBITAL GALAXY   differential-rotation disc
//                 1 PLASMA FOUNTAINS ballistic parametric fireworks
//                 2 CYCLONE VORTEX   tornado column with recycle
//                 3 WAVE LATTICE     triple-sine ocean sheet
//                 4 ATTRACTOR FLOCK  010 spring-damped swarm around 3 lures
//                 5 MORPH FORMATIONS sphere/torus/knot/cube/disc slerp-frame
//                                    morphing (mat4 + quat frame)
//                 6 STORM FRONT      trig turbulence + lightning exposure
//                 7 COMET ENTOURAGE  5 quat2 dual-quat Kepler comets with
//                                    glow trails, particles as retinue
//               Renderer: raw WebGL2/WebGL1 additive point sprites with soft
//               halo shader, nebula + god-ray backdrop, comet line trails,
//               shockwave tap impulses, pointer force field via spatial grid,
//               Canvas2D fallback, adaptive draw governor. Full live control
//               deck, HUD with act timeline, ambient synth audio with visible
//               mute, staged boot, snapshot export. Zero CDN, zero build.
// best for : 3d graphics — validating the whole replacement stack in one
//            living scene: SOA particle physics, ECS queries/systems,
//            quaternion formation frames, dual-quat orbital comets, color
//            grading, floating origin and chunked non-blocking spawning at
//            60 fps on Android mobile 64-bit.
// license : MIT
// usage : <script type="module" src="./particle_showcase.js"></script>
// ============================================================================

import * as vec2  from "./math/002_vec2.js";
import * as vec3  from "./math/003_vec3.js";
import * as vec4  from "./math/004_vec4.js";
import * as mat2  from "./math/005_mat2.js";
import * as mat4  from "./math/007_mat4.js";
import * as quat  from "./math/008_quat.js";
import * as quat2 from "./math/009_quat2.js";

// 010 bitECS core: dynamic import with graceful fatal panel (never breaks).
let ecs = null;
// 011 serialization: optional export path with internal fallback codec.
let ser11 = null;
import("./math/011_bitECS_serialization.js")
    .then(m => { ser11 = m; markLink(); })
    .catch(() => { ser11 = null; markLink(); });

// ============================================================================
// 1. CONFIG / STATE
// ============================================================================
const ACT_TIME   = 12.0;
const FORM_DUR   = 4.0;
const BLEND      = 1.6;
const BOUND_R    = 55;
const COMETS     = 5;
const TRAIL_LEN  = 46;
const ACTS = [
    "ORBITAL GALAXY", "PLASMA FOUNTAINS", "CYCLONE VORTEX", "WAVE LATTICE",
    "ATTRACTOR FLOCK", "MORPH FORMATIONS", "STORM FRONT", "COMET ENTOURAGE"
];
const DEFAULTS = {
    count: 80000, timeScale: 1.0, turbulence: 0.6, glow: 1.0,
    pointSize: 1.0, fog: 0.004, hueDrift: 0.10, trail: 1.0,
    autoCycle: true, autoRandom: true, follow: false, forceMode: "attract",
    quality: "balanced"
};
const S = Object.assign({}, DEFAULTS);
let seed = 77123;

let world = null, C = null, pList = [];
let grid = null, animSys = null, colorSys = null, fo = null;
let animN = 0, trsView = null, animTargets = null, animRotView = null;
let N = 0, drawN = 0;

let act = 0, actT = 0, simTime = 0, paused = false, rebuilding = false;
let flash = 0, nextFlash = 2, hueTick = 0;
let originShifts = 0;
const origin64 = new Float64Array(3);

// formations
let shapes = null, shapeNames = ["SPHERE", "TORUS", "KNOT", "CUBE", "DISC"];
let formA = 0, formB = 1, morphClock = 0;
const stag = { arr: null };
// formation frame (quaternion showcase)
const frameQuat = quat.create(), frameTarget = quat.create(), frameVel = new Float32Array(4);
const frameMat = mat4.acquire();

// attractors
const atts = [vec3.create(), vec3.create(), vec3.create()];
const attP = { f: [0.21, 0.33, 0.27], a: [22, 18, 26], ph: [0, 2, 4] };

// comets (dual-quat Kepler)
let cometDQ = null, cometPos = null, cometEls = null, cometM = null, cometN = null;
let trailBuf = null, trailIdx = 0;

// fountains
const fountains = [vec3.create(), vec3.create(), vec3.create()];

// palette (vec4 lerp transitions)
const PAL_SETS = [
    [[1.0, 0.62, 0.22], [0.30, 0.85, 1.0], [1.0, 0.28, 0.55]],
    [[0.55, 1.0, 0.35], [0.35, 0.9, 0.95], [0.95, 0.85, 0.25]],
    [[1.0, 0.35, 0.75], [0.45, 0.5, 1.0], [0.3, 0.95, 0.8]],
    [[0.95, 0.9, 1.0], [1.0, 0.55, 0.3], [0.4, 0.8, 1.0]]
];
let palIdx = 0;
const colA = vec4.fromValues(1, 0.62, 0.22, 1);
const colB = vec4.fromValues(0.3, 0.85, 1.0, 1);
const colC = vec4.fromValues(1.0, 0.28, 0.55, 1);
const colTA = vec4.create(), colTB = vec4.create(), colTC = vec4.create();
let uHue = 0;

// shocks (tap impulses)
const shocks = [];

// timings / governor
let fpsEma = 60;
const timings = { sim: 0, grid: 0, render: 0 };

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
// 2. DOM + STYLE (self-contained theatre console)
// ============================================================================
const root = document.createElement("div");
root.id = "pt-root";
root.innerHTML = `
<style>
#pt-root{position:fixed;inset:0;display:flex;flex-direction:column;overflow:hidden;
  --bg:#07040d;--surface:rgba(16,10,28,.88);--line:rgba(255,120,220,.16);
  --text:#f4e9ff;--dim:#9a7fb0;--acc:#ff5fd0;--acc2:#ffc44d;--ok:#b6ff3d;
  --warn:#ffd23d;--danger:#ff3d5e;
  font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:var(--text);background:var(--bg)}
#pt-root *{box-sizing:border-box;margin:0}
#pt-top{height:48px;flex:0 0 48px;display:flex;align-items:center;gap:12px;padding:0 16px;
  background:linear-gradient(90deg,rgba(14,6,20,.95),rgba(26,10,34,.9));
  border-bottom:1px solid var(--line);z-index:20;position:relative;
  animation:ptDrop .7s cubic-bezier(.2,.9,.25,1) both}
#pt-top h1{font-size:14px;letter-spacing:.3em;font-weight:700;white-space:nowrap;
  background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;
  background-clip:text;color:transparent}
#pt-top .sub{color:var(--dim);font-size:10px;letter-spacing:.14em;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
#pt-top .sp{flex:1}
#pt-cycle{position:absolute;left:0;bottom:0;height:2px;width:0%;
  background:linear-gradient(90deg,var(--acc),var(--acc2));box-shadow:0 0 8px var(--acc);
  transition:width .2s linear}
.pt-chip{font-size:10px;padding:3px 9px;border:1px solid var(--line);border-radius:99px;
  color:var(--dim);letter-spacing:.1em;white-space:nowrap}
.pt-chip.on{color:var(--ok);border-color:rgba(182,255,61,.35)}
#pt-mute{cursor:pointer;user-select:none;font-size:11px;padding:6px 12px;border-radius:8px;
  border:1px solid var(--line);background:rgba(30,14,40,.7);color:var(--acc2);
  letter-spacing:.08em;transition:all .2s}
#pt-mute:hover{border-color:var(--acc2);box-shadow:0 0 14px rgba(255,196,77,.3)}
#pt-main{flex:1;display:flex;min-height:0}
#pt-stage{flex:1;position:relative;min-width:0;background:#000}
#pt-gl,#pt-fb{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab}
#pt-gl:active{cursor:grabbing}
#pt-fb{display:none}
#pt-hud{position:absolute;top:12px;left:12px;pointer-events:none;font-size:10.5px;line-height:1.75;
  color:var(--acc2);text-shadow:0 1px 3px #000;white-space:pre;letter-spacing:.04em;
  background:linear-gradient(180deg,rgba(10,4,14,.6),transparent);padding:8px 12px 16px;
  border-left:2px solid var(--acc);animation:ptFade 1.2s .3s both;max-width:min(430px,62vw)}
#pt-compass{position:absolute;top:12px;right:12px;width:52px;height:52px;pointer-events:none;opacity:.9}
#pt-hint{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);pointer-events:none;
  font-size:10px;color:var(--dim);letter-spacing:.18em;background:rgba(10,4,14,.6);
  padding:6px 14px;border-radius:99px;border:1px solid var(--line);white-space:nowrap;
  animation:ptFade 1s 1.2s both}
#pt-boot{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:14px;z-index:15;transition:opacity .8s;letter-spacing:.3em;
  font-size:11px;color:var(--acc);
  background:radial-gradient(ellipse at 50% 60%,rgba(40,12,50,.92),rgba(4,2,8,.98))}
#pt-boot .bar{width:min(340px,72%);height:3px;background:rgba(255,120,220,.12);
  border-radius:2px;overflow:hidden}
#pt-boot .bar i{display:block;height:100%;width:0%;
  background:linear-gradient(90deg,var(--acc),var(--acc2));transition:width .15s;
  box-shadow:0 0 12px var(--acc2)}
#pt-boot.gone{opacity:0;pointer-events:none}
#pt-panel{width:308px;flex:0 0 308px;background:var(--surface);
  border-left:1px solid var(--line);overflow-y:auto;overflow-x:hidden;padding:14px 16px 22px;
  z-index:10;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  animation:ptSlide .7s .15s cubic-bezier(.2,.9,.25,1) both;
  scrollbar-width:thin;scrollbar-color:var(--acc) rgba(255,120,220,.07)}
#pt-panel::-webkit-scrollbar{width:10px}
#pt-panel::-webkit-scrollbar-track{background:linear-gradient(180deg,rgba(255,120,220,.05),rgba(255,120,220,.1));border-radius:5px}
#pt-panel::-webkit-scrollbar-thumb{background:linear-gradient(180deg,var(--acc),var(--acc2));
  border-radius:5px;border:2px solid rgba(10,4,14,.85)}
#pt-panel::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,var(--acc2),var(--acc))}
.pt-sec{margin:16px 0 8px;font-size:9.5px;letter-spacing:.3em;color:var(--dim);
  display:flex;align-items:center;gap:8px}
.pt-sec::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
.pt-sec b{color:var(--acc);font-weight:700}
.pt-row{margin:9px 0}
.pt-row label{display:flex;justify-content:space-between;font-size:10.5px;letter-spacing:.06em;margin-bottom:5px}
.pt-row label output{color:var(--acc2);font-weight:700}
.pt-row input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:22px;
  background:transparent;cursor:pointer}
.pt-row input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;
  background:linear-gradient(90deg,var(--acc),var(--acc2));box-shadow:0 0 8px rgba(255,196,77,.2)}
.pt-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;
  margin-top:-5.5px;border-radius:50%;background:#160a1e;border:2px solid var(--acc2);
  box-shadow:0 0 10px var(--acc2);transition:transform .15s}
.pt-row input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.25)}
.pt-row input[type=range]::-moz-range-track{height:4px;border-radius:2px;
  background:linear-gradient(90deg,var(--acc),var(--acc2))}
.pt-row input[type=range]::-moz-range-thumb{width:13px;height:13px;border-radius:50%;
  background:#160a1e;border:2px solid var(--acc2)}
.pt-sel{width:100%;padding:8px 10px;background:rgba(26,14,36,.9);color:var(--text);
  border:1px solid var(--line);border-radius:8px;font:inherit;font-size:11.5px;cursor:pointer;outline:none}
.pt-sel:focus{border-color:var(--acc2)}
.pt-tog{display:flex;align-items:center;justify-content:space-between;padding:7px 0;
  font-size:11px;letter-spacing:.06em;cursor:pointer;user-select:none;-webkit-user-select:none}
.pt-tog .sw{width:36px;height:19px;border-radius:99px;background:rgba(255,120,220,.12);
  border:1px solid var(--line);position:relative;transition:all .2s;flex:0 0 36px}
.pt-tog .sw::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;
  border-radius:50%;background:var(--dim);transition:all .2s}
.pt-tog.on .sw{background:linear-gradient(90deg,var(--acc),var(--acc2));border-color:transparent;
  box-shadow:0 0 12px rgba(255,95,208,.25)}
.pt-tog.on .sw::after{left:19px;background:#120618}
.pt-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.pt-btn{padding:10px 6px;border-radius:9px;border:1px solid var(--line);cursor:pointer;
  background:linear-gradient(180deg,rgba(40,20,54,.9),rgba(16,8,22,.9));color:var(--text);
  font:inherit;font-size:10.5px;letter-spacing:.12em;transition:all .18s;text-align:center;
  touch-action:manipulation}
.pt-btn:hover{border-color:var(--acc);color:var(--acc);box-shadow:0 0 16px rgba(255,95,208,.25);
  transform:translateY(-1px)}
.pt-btn:active{transform:none}
.pt-btn.pri{grid-column:1/-1;border-color:rgba(255,196,77,.4);color:var(--acc2)}
.pt-btn.pri:hover{box-shadow:0 0 18px rgba(255,196,77,.3)}
.pt-btn[disabled]{opacity:.45;pointer-events:none}
.pt-keys{margin-top:14px;font-size:9.5px;color:var(--dim);letter-spacing:.08em;line-height:1.9}
.pt-keys b{color:var(--acc2);font-weight:700}
.pt-stack{margin-top:12px;font-size:9px;color:var(--dim);letter-spacing:.1em;line-height:1.8;
  border-top:1px dashed var(--line);padding-top:10px}
.pt-stack .ok{color:var(--ok)} .pt-stack .fb{color:var(--warn)}
#pt-toasts{position:absolute;left:14px;bottom:14px;display:flex;flex-direction:column;gap:8px;
  z-index:30;pointer-events:none;max-width:min(360px,72vw)}
.pt-toast{padding:9px 14px;font-size:11px;letter-spacing:.06em;background:rgba(14,6,20,.92);
  border:1px solid var(--line);border-left:3px solid var(--acc2);border-radius:8px;
  animation:ptToast .3s cubic-bezier(.2,.9,.3,1.2) both;box-shadow:0 6px 24px rgba(0,0,0,.5)}
.pt-toast.ok{border-left-color:var(--ok)} .pt-toast.warn{border-left-color:var(--warn)}
.pt-toast.err{border-left-color:var(--danger)}
.pt-toast.out{animation:ptToastOut .3s both}
#pt-fatal{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;
  padding:20px;background:rgba(4,2,8,.97)}
#pt-fatal .box{max-width:560px;border:1px solid rgba(255,61,94,.4);border-left:3px solid var(--danger);
  border-radius:14px;background:var(--surface);padding:26px 28px;display:flex;flex-direction:column;gap:14px}
#pt-fatal h2{font-size:14px;letter-spacing:.22em;color:var(--danger)}
#pt-fatal p{font-size:11px;line-height:1.9;letter-spacing:.05em}
#pt-fatal code{color:var(--acc2);background:rgba(255,196,77,.08);padding:1px 6px;border-radius:4px}
@keyframes ptDrop{from{transform:translateY(-100%);opacity:0}to{transform:none;opacity:1}}
@keyframes ptSlide{from{transform:translateX(40px);opacity:0}to{transform:none;opacity:1}}
@keyframes ptFade{from{opacity:0}to{opacity:1}}
@keyframes ptToast{from{transform:translateX(-24px);opacity:0}to{transform:none;opacity:1}}
@keyframes ptToastOut{to{transform:translateX(-24px);opacity:0}}
@media (max-width:860px){
  #pt-main{flex-direction:column}
  #pt-panel{width:100%;flex:0 0 40vh;border-left:none;border-top:1px solid var(--line)}
  #pt-top .sub{display:none}
  #pt-hint{display:none}
  #pt-hud{font-size:9.5px}
}
@media (prefers-reduced-motion:reduce){
  #pt-root *{animation-duration:.01s!important;transition-duration:.01s!important}
}
</style>
<div id="pt-top">
  <h1>PARTICLE THEATRE</h1>
  <span class="sub">bitECS PARTICLE SHOWCASE · SOA MATH REPLACES three.js r185</span>
  <span class="sp"></span>
  <span class="pt-chip on" id="pt-glchip">GL…</span>
  <span class="pt-chip" id="pt-linkchip">011 …</span>
  <span id="pt-mute">♪ SOUND ON</span>
  <div id="pt-cycle"></div>
</div>
<div id="pt-main">
  <div id="pt-stage">
    <canvas id="pt-gl"></canvas>
    <canvas id="pt-fb"></canvas>
    <div id="pt-hud"></div>
    <canvas id="pt-compass" width="52" height="52"></canvas>
    <div id="pt-boot"><span id="pt-bootlbl">BUILDING THEATRE</span>
      <div class="bar"><i id="pt-bootbar"></i></div><span id="pt-bootpct">0%</span></div>
    <div id="pt-hint">DRAG ORBIT · WHEEL / PINCH ZOOM · TAP = SHOCKWAVE</div>
    <div id="pt-toasts"></div>
  </div>
  <div id="pt-panel"></div>
</div>
<div id="pt-fatal"><div class="box">
  <h2>ECS CORE UNAVAILABLE</h2>
  <p id="pt-fatal-msg"></p>
  <p>This showcase requires <code>./math/010_bitECS_core.js</code> (native ES module).
     Some browsers block local module imports from <code>file://</code> — open the
     <code>src/</code> folder from any environment with local module access.</p>
</div></div>`;

function mount() { document.body.appendChild(root); }
if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", mount); }
else { mount(); }

const $ = id => root.querySelector("#" + id);
const stage = $("pt-stage"), glCanvas = $("pt-gl"), fbCanvas = $("pt-fb");
const ctx2d = fbCanvas.getContext("2d");
const hudEl = $("pt-hud"), panel = $("pt-panel"), toasts = $("pt-toasts");
const bootEl = $("pt-boot"), bootBar = $("pt-bootbar"), bootPct = $("pt-bootpct"), bootLbl = $("pt-bootlbl");
const compCtx = $("pt-compass").getContext("2d");
const cycleBar = $("pt-cycle");

function toast(msg, kind) {
    const t = document.createElement("div");
    t.className = "pt-toast " + (kind || "");
    t.textContent = msg;
    toasts.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 320); }, 2600);
}
function markLink() {
    const c = $("pt-linkchip");
    if (!c) { return; }
    c.textContent = ser11 ? "011 LINKED" : "011 FALLBACK";
    c.classList.toggle("on", !!ser11);
    const s = root.querySelector("#pt-stack11");
    if (s) { s.textContent = ser11 ? "LINKED" : "FALLBACK CODEC"; s.className = ser11 ? "ok" : "fb"; }
}
function setBoot(pct, label) {
    bootBar.style.width = pct + "%";
    bootPct.textContent = Math.round(pct) + "%";
    if (label) { bootLbl.textContent = label; }
}

// ============================================================================
// 3. POOLED TEMPORARIES + CAMERA
// ============================================================================
const T = {
    view: mat4.acquire(), proj: mat4.acquire(), vp: mat4.acquire(), inv: mat4.acquire(),
    eye: vec3.create(), target: vec3.create(), goal: vec3.create(),
    targetVel: vec3.create(), up: vec3.fromValues(0, 1, 0),
    fwd: vec3.create(), right: vec3.create(), cup: vec3.create(),
    v3a: vec3.create(), v3b: vec3.create(), m2: mat2.create(),
    ptr: vec2.create(), ptrLast: vec2.create()
};
const KEY_DIR = vec3.normalize(vec3.create(), vec3.fromValues(-0.5, 0.6, 0.45));
let W = 2, H = 2, DPR = 1;
const QUALITY_DPR = { low: 1, balanced: 1.5, high: 2 };

const cam = { yaw: 0.9, pitch: 0.42, dist: 88, yawT: 0.9, pitchT: 0.42, distT: 88 };

function resize() {
    const r = stage.getBoundingClientRect();
    W = Math.max(2, r.width); H = Math.max(2, r.height);
    DPR = Math.min(window.devicePixelRatio || 1, QUALITY_DPR[S.quality]);
    glCanvas.width = Math.floor(W * DPR); glCanvas.height = Math.floor(H * DPR);
    fbCanvas.width = Math.floor(W * DPR); fbCanvas.height = Math.floor(H * DPR);
    if (glOK) { gl.viewport(0, 0, glCanvas.width, glCanvas.height); }
}
window.addEventListener("resize", resize);

function updateCamera(dt) {
    if (!dragging) { cam.yawT += dt * 0.04; }
    const k = 1 - Math.exp(-dt * 8);
    cam.yaw += (cam.yawT - cam.yaw) * k;
    cam.pitch += (cam.pitchT - cam.pitch) * k;
    cam.dist += (cam.distT - cam.dist) * k;
    if (S.follow && cometPos) {
        T.goal[0] = cometPos.x[0]; T.goal[1] = cometPos.y[0]; T.goal[2] = cometPos.z[0];
    } else { vec3.set(T.goal, 0, 0, 0); }
    vec3.springDamp3(T.target, T.target, T.goal, T.targetVel, 0.35, dt, 120);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    T.eye[0] = T.target[0] + cam.dist * cp * Math.sin(cam.yaw);
    T.eye[1] = T.target[1] + cam.dist * sp;
    T.eye[2] = T.target[2] + cam.dist * cp * Math.cos(cam.yaw);
    mat4.lookAt(T.view, T.eye, T.target, T.up);
    mat4.perspectiveNO(T.proj, 55 * Math.PI / 180, W / H, 0.1, 900);
    mat4.multiply(T.vp, T.proj, T.view);
    mat4.invert(T.inv, T.view);
    T.right[0] = T.inv[0]; T.right[1] = T.inv[1]; T.right[2] = T.inv[2];
    T.cup[0] = T.inv[4]; T.cup[1] = T.inv[5]; T.cup[2] = T.inv[6];
    T.fwd[0] = -T.inv[8]; T.fwd[1] = -T.inv[9]; T.fwd[2] = -T.inv[10];
}
function pointerToWorld(nx, ny, out) {
    const tanF = Math.tan(55 * Math.PI / 360), tanA = tanF * (W / H), d = cam.dist;
    out[0] = T.eye[0] + T.fwd[0] * d + T.right[0] * nx * d * tanA + T.cup[0] * ny * d * tanF;
    out[1] = T.eye[1] + T.fwd[1] * d + T.right[1] * nx * d * tanA + T.cup[1] * ny * d * tanF;
    out[2] = T.eye[2] + T.fwd[2] * d + T.right[2] * nx * d * tanA + T.cup[2] * ny * d * tanF;
    return out;
}

// ============================================================================
// 4. RANDOMIZATION (auto + manual)
// ============================================================================
function randomizeFrameQuat() {
    const rng = prng((seed ^ 0x9e3779b9) >>> 0);
    const u1 = rng(), u2 = rng() * Math.PI * 2, u3 = rng() * Math.PI * 2;
    const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
    quat.set(frameTarget, s1 * Math.sin(u2), s1 * Math.cos(u2), s2 * Math.sin(u3), s2 * Math.cos(u3));
}
function randomizeAttractors() {
    const rng = prng((seed ^ 0x85ebca6b) >>> 0);
    for (let i = 0; i < 3; i++) {
        attP.f[i] = 0.12 + rng() * 0.3;
        attP.a[i] = 14 + rng() * 18;
        attP.ph[i] = rng() * Math.PI * 2;
    }
}
function randomizeFountains() {
    const rng = prng((seed ^ 0xc2b2ae35) >>> 0);
    for (let i = 0; i < 3; i++) {
        fountains[i][0] = (rng() - 0.5) * 44;
        fountains[i][1] = -14 + rng() * 6;
        fountains[i][2] = (rng() - 0.5) * 44;
    }
}
function randomizeComets() {
    if (!cometEls) { return; }
    const rng = prng((seed ^ 0x27d4eb2f) >>> 0);
    for (let i = 0; i < COMETS; i++) {
        const a = 16 + rng() * 26;
        cometEls.a[i] = a;
        cometEls.e[i] = 0.15 + rng() * 0.35;
        cometEls.inc[i] = (rng() - 0.5) * 0.8;
        cometEls.Om[i] = rng() * Math.PI * 2;
        cometEls.om[i] = rng() * Math.PI * 2;
        cometM[i] = rng() * Math.PI * 2;
        cometN[i] = Math.sqrt(500 / (a * a * a));
    }
    trailIdx = 0;
    if (trailBuf) { trailBuf.fill(0); }
}
function randomizePalette() {
    palIdx = (palIdx + 1 + ((Math.random() * 2) | 0)) % PAL_SETS.length;
    const P = PAL_SETS[palIdx];
    vec4.set(colTA, P[0][0], P[0][1], P[0][2], 1);
    vec4.set(colTB, P[1][0], P[1][1], P[1][2], 1);
    vec4.set(colTC, P[2][0], P[2][1], P[2][2], 1);
}
function randomizeAll(lite) {
    seed = (Math.random() * 1e9) | 0;
    randomizeFrameQuat();
    randomizeAttractors();
    randomizeFountains();
    randomizeComets();
    randomizePalette();
    if (!lite) { toast("AUTO-RANDOMIZED · SEED #" + seed, "ok"); }
}

// ============================================================================
// 5. WORLD REBUILD (chunked spawn, zero UI freeze, staged boot)
// ============================================================================
async function rebuild(reason) {
    if (rebuilding || !ecs) { return; }
    rebuilding = true;
    bootEl.classList.remove("gone");
    setBoot(2, "CREATING WORLD");
    try {
        N = S.count;
        world = ecs.createWorld();
        C = {
            Particle: {}, Comet: {},
            Position: { x: new Float32Array(N + 16), y: new Float32Array(N + 16), z: new Float32Array(N + 16) },
            Velocity: { x: new Float32Array(N + 16), y: new Float32Array(N + 16), z: new Float32Array(N + 16) },
            Color:    { x: new Float32Array(N + 16), y: new Float32Array(N + 16), z: new Float32Array(N + 16), w: new Float32Array(N + 16) },
            Meta:     { seed: new Float32Array(N + 16), size: new Float32Array(N + 16) },
            Rotation: { x: new Float32Array(N + 16), y: new Float32Array(N + 16), z: new Float32Array(N + 16), w: new Float32Array(N + 16) }
        };
        let counted = 0;
        const unsub = ecs.observe(world, ecs.onAdd(C.Particle), () => { counted++; });

        setBoot(6, "SPAWNING " + fmtK(N) + " PARTICLES");
        const res = await ecs.scatterEntitiesChunked(world, N, {
            bounds: { x: [-46, 46], y: [-20, 20], z: [-46, 46] },
            seed: seed, noiseScale: 0.05, chunkSize: 32768, yieldEvery: 6,
            spawn: (w) => {
                const e = ecs.addEntity(w);
                ecs.addComponents(w, e, [C.Particle]);
                return e;
            }
        });

        setBoot(30, "BINDING SOA COMPONENTS");
        const P = C.Position, V = C.Velocity, COL = C.Color, M = C.Meta, R = C.Rotation;
        const ents = res.entities, rp = res.position;
        const rng = prng(seed);
        const chunk = 65536;
        for (let s = 0; s < N; s += chunk) {
            const e1 = Math.min(s + chunk, N);
            for (let i = s; i < e1; i++) {
                const e = ents[i];
                P.x[e] = rp.x[i]; P.y[e] = rp.y[i]; P.z[e] = rp.z[i];
                V.x[e] = 0; V.y[e] = 0; V.z[e] = 0;
                const band = i % 3;
                COL.x[e] = band === 0 ? 1 : band === 1 ? 0.4 : 0.9;
                COL.y[e] = band === 0 ? 0.6 : band === 1 ? 0.85 : 0.4;
                COL.z[e] = band === 0 ? 0.25 : band === 1 ? 1.0 : 0.95;
                COL.w[e] = 1;
                M.seed[e] = rng();
                M.size[e] = 0.7 + rng() * 1.6;
                R.w[e] = 1;
            }
            setBoot(30 + (e1 / N) * 24, "BINDING SOA " + fmtK(e1));
            await yieldMain();
        }
        unsub();

        pList = ecs.query(world, [C.Particle]);

        setBoot(56, "CALIBRATING SYSTEMS");
        grid = ecs.createSpatialGrid(6, { maxEntities: N + 32, gridDim: 64, queryCapacity: 2048 });
        animN = Math.min(N, 20000);
        animSys = ecs.createAnimationSystem({ maxEntries: animN });
        for (let i = 0; i < animN; i++) {
            animSys.add(i, { smoothTime: 0.4 + (i % 7) * 0.06, maxSpeed: 34 });
        }
        trsView = {
            position: { x: P.x.subarray(1, 1 + animN), y: P.y.subarray(1, 1 + animN), z: P.z.subarray(1, 1 + animN) },
            rotation: { x: R.x.subarray(1, 1 + animN), y: R.y.subarray(1, 1 + animN), z: R.z.subarray(1, 1 + animN), w: R.w.subarray(1, 1 + animN) }
        };
        animRotView = { x: R.x.subarray(1, 1 + animN), y: R.y.subarray(1, 1 + animN), z: R.z.subarray(1, 1 + animN), w: R.w.subarray(1, 1 + animN) };
        animTargets = ecs.createTransformSOA(animN);
        animTargets.rotation.w.fill(1);
        colorSys = ecs.createColorSystem();
        fo = ecs.createFloatingOrigin({ threshold: 800 });
        await yieldMain();

        setBoot(64, "SCULPTING FORMATIONS");
        shapes = [
            vec3.createVec3SOA(N), vec3.createVec3SOA(N), vec3.createVec3SOA(N),
            vec3.createVec3SOA(N), vec3.createVec3SOA(N)
        ];
        await genShapes();
        stag.arr = new Float32Array(N + 16);
        for (let i = 0; i < N; i++) { stag.arr[i] = (i % 137) / 137 * 1.2; }

        setBoot(82, "LAUNCHING COMETS");
        cometDQ = quat2.createQuat2SOA(COMETS);
        cometPos = vec3.createVec3SOA(COMETS);
        cometEls = {
            a: new Float32Array(COMETS), e: new Float32Array(COMETS),
            inc: new Float32Array(COMETS), Om: new Float32Array(COMETS), om: new Float32Array(COMETS)
        };
        cometM = new Float32Array(COMETS);
        cometN = new Float32Array(COMETS);
        trailBuf = new Float32Array(COMETS * TRAIL_LEN * 3);
        randomizeComets();

        if (glOK) { reallocParticleBuffers(); }
        drawN = N;

        setBoot(100, "CURTAIN UP");
        await yieldMain();
        if (reason) { toast(reason + " · " + fmtK(N) + " PARTICLES", "ok"); }
    } catch (err) {
        console.error("[particle_showcase] rebuild failed:", err);
        toast("REBUILD FAILED — see console", "err");
    }
    rebuilding = false;
    bootEl.classList.add("gone");
}

// formation shapes (chunked, seeded)
async function genShapes() {
    const rng = prng(seed ^ 0x51ed270b);
    const n = N;
    const chunk = 65536;
    // SPHERE (fibonacci)
    for (let s = 0; s < n; s += chunk) {
        const e1 = Math.min(s + chunk, n);
        for (let i = s; i < e1; i++) {
            const ga = i * 2.39996322972865332;
            const y = 1 - (i / (n - 1)) * 2;
            const r = Math.sqrt(Math.max(0, 1 - y * y)) * 26;
            shapes[0].x[i] = Math.cos(ga) * r; shapes[0].y[i] = y * 26; shapes[0].z[i] = Math.sin(ga) * r;
        }
        await yieldMain();
    }
    // TORUS
    for (let s = 0; s < n; s += chunk) {
        const e1 = Math.min(s + chunk, n);
        for (let i = s; i < e1; i++) {
            const uu = (i / n) * Math.PI * 2 * 29;
            const vv = (i * 0.61803398875 % 1) * Math.PI * 2;
            const R = 22, r = 7;
            shapes[1].x[i] = Math.cos(uu) * (R + Math.cos(vv) * r);
            shapes[1].y[i] = Math.sin(vv) * r;
            shapes[1].z[i] = Math.sin(uu) * (R + Math.cos(vv) * r);
        }
        await yieldMain();
    }
    // TREFOIL KNOT
    for (let s = 0; s < n; s += chunk) {
        const e1 = Math.min(s + chunk, n);
        for (let i = s; i < e1; i++) {
            const t = (i / n) * Math.PI * 2;
            const j = (rng() - 0.5) * 2.4;
            shapes[2].x[i] = (Math.sin(t) + 2 * Math.sin(2 * t)) * 8 + j;
            shapes[2].y[i] = (Math.cos(t) - 2 * Math.cos(2 * t)) * 8 + j * 0.6;
            shapes[2].z[i] = -Math.sin(3 * t) * 8 + j;
        }
        await yieldMain();
    }
    // CUBE SHELL
    for (let s = 0; s < n; s += chunk) {
        const e1 = Math.min(s + chunk, n);
        for (let i = s; i < e1; i++) {
            const f = i % 6, u = (rng() - 0.5) * 40, v = (rng() - 0.5) * 40, h = 20;
            if (f === 0) { shapes[3].x[i] = h; shapes[3].y[i] = u; shapes[3].z[i] = v; }
            else if (f === 1) { shapes[3].x[i] = -h; shapes[3].y[i] = u; shapes[3].z[i] = v; }
            else if (f === 2) { shapes[3].y[i] = h; shapes[3].x[i] = u; shapes[3].z[i] = v; }
            else if (f === 3) { shapes[3].y[i] = -h; shapes[3].x[i] = u; shapes[3].z[i] = v; }
            else if (f === 4) { shapes[3].z[i] = h; shapes[3].x[i] = u; shapes[3].y[i] = v; }
            else { shapes[3].z[i] = -h; shapes[3].x[i] = u; shapes[3].y[i] = v; }
        }
        await yieldMain();
    }
    // SPIRAL DISC
    for (let s = 0; s < n; s += chunk) {
        const e1 = Math.min(s + chunk, n);
        for (let i = s; i < e1; i++) {
            const arm = i % 3, t = i / n;
            const ang = arm * (Math.PI * 2 / 3) + t * 10;
            const rad = 2 + t * 30;
            shapes[4].x[i] = Math.cos(ang) * rad + (rng() - 0.5) * 3;
            shapes[4].y[i] = (rng() - 0.5) * 2.4;
            shapes[4].z[i] = Math.sin(ang) * rad + (rng() - 0.5) * 3;
        }
        await yieldMain();
    }
}

// ============================================================================
// 6. ACT SYSTEMS — target velocity fields + parametric acts
// ============================================================================
function updateAttractors(t) {
    for (let i = 0; i < 3; i++) {
        atts[i][0] = Math.sin(t * attP.f[i] + attP.ph[i]) * attP.a[i];
        atts[i][1] = Math.sin(t * attP.f[i] * 1.7 + attP.ph[i] * 2) * 9 + 3;
        atts[i][2] = Math.cos(t * attP.f[i] * 0.9 + attP.ph[i]) * attP.a[i];
    }
}

function stepParticles(dt) {
    const list = pList, n = list.length;
    const P = C.Position, V = C.Velocity, M = C.Meta;
    const px = P.x, py = P.y, pz = P.z, vx = V.x, vy = V.y, vz = V.z;
    const t = simTime, turb = S.turbulence;
    const kBlend = 1 - Math.exp(-dt * BLEND);

    switch (act) {

    case 0: { // ORBITAL GALAXY — differential rotation disc
        for (let kk = 0; kk < n; kk++) {
            const e = list[kk];
            const x = px[e], y = py[e], z = pz[e];
            const r = Math.sqrt(x * x + z * z) + 0.001;
            const w = (5.6 / (Math.pow(r, 1.4) + 3)) * (1 + turb * 0.4);
            const br = Math.sin(t * 0.5 + M.seed[e] * 6.28) * 0.35;
            vx[e] += ((-z / r) * r * w + (x / r) * br - vx[e]) * kBlend;
            vz[e] += ((x / r) * r * w + (z / r) * br - vz[e]) * kBlend;
            vy[e] += (-y * 0.8 - vy[e]) * kBlend;
            px[e] += vx[e] * dt; py[e] += vy[e] * dt; pz[e] += vz[e] * dt;
        }
        break;
    }

    case 1: { // PLASMA FOUNTAINS — ballistic parametric fireworks
        const TL = 3.2;
        for (let kk = 0; kk < n; kk++) {
            const e = list[kk];
            const sd = M.seed[e];
            const f = fountains[(e % 3)];
            const tt = ((t * 0.32 + sd * 7.31) % 1) * TL;
            const ang = sd * 6.28318 + e * 0.0001;
            const spread = 0.24 + turb * 0.2;
            const sp = 13 + (sd * 0.618 % 1) * 11;
            const dx = Math.cos(ang) * Math.sin(spread) * sp;
            const dz = Math.sin(ang) * Math.sin(spread) * sp;
            const dy = Math.cos(spread) * sp;
            const ox = px[e], oy = py[e], oz = pz[e];
            px[e] = f[0] + dx * tt;
            py[e] = f[1] + dy * tt - 6.5 * tt * tt;
            pz[e] = f[2] + dz * tt;
            vx[e] = (px[e] - ox) / Math.max(dt, 1e-4);
            vy[e] = (py[e] - oy) / Math.max(dt, 1e-4);
            vz[e] = (pz[e] - oz) / Math.max(dt, 1e-4);
        }
        break;
    }

    case 2: { // CYCLONE VORTEX
        for (let kk = 0; kk < n; kk++) {
            const e = list[kk];
            const x = px[e], y = py[e], z = pz[e];
            const r = Math.sqrt(x * x + z * z) + 0.001;
            const w = (10 / (r + 5)) * (0.8 + turb * 0.6);
            const up = 5.5 + Math.sin(r * 0.28 - t * 1.6) * 2.6;
            const inn = (15 - r) * 0.16;
            vx[e] += ((-z / r) * r * w + (x / r) * inn - vx[e]) * kBlend;
            vz[e] += ((x / r) * r * w + (z / r) * inn - vz[e]) * kBlend;
            vy[e] += (up - 18 * (y / 34) - vy[e]) * kBlend;
            px[e] += vx[e] * dt; py[e] += vy[e] * dt; pz[e] += vz[e] * dt;
            if (py[e] > 30) { py[e] -= 44; }
            if (py[e] < -16) { py[e] += 44; }
        }
        break;
    }

    case 3: { // WAVE LATTICE
        for (let kk = 0; kk < n; kk++) {
            const e = list[kk];
            const sd = M.seed[e];
            const gx = ((sd * 0.713 % 1) - 0.5) * 96;
            const gz = ((sd * 0.389 % 1) - 0.5) * 96;
            const wy = Math.sin(gx * 0.14 + t * 1.15) * 2.8
                     + Math.sin(gz * 0.17 - t * 0.95) * 2.4
                     + Math.sin((gx + gz) * 0.08 + t * 0.6) * 1.8;
            const oy = py[e];
            px[e] += (gx - px[e]) * Math.min(1, dt * 3);
            pz[e] += (gz - pz[e]) * Math.min(1, dt * 3);
            py[e] += (wy * (1 + turb * 0.6) - py[e]) * Math.min(1, dt * 6);
            vx[e] = 0; vz[e] = 0;
            vy[e] = (py[e] - oy) / Math.max(dt, 1e-4);
        }
        break;
    }

    case 4: { // ATTRACTOR FLOCK — 010 spring system on first animN
        const tp = animTargets.position;
        for (let i = 0; i < animN; i++) {
            const a = atts[i % 3];
            const ph = (i * 0.618 % 1) * 6.28318 + t * 0.9;
            const rr = 2 + (i % 11) * 0.45;
            tp.x[i] = a[0] + Math.cos(ph) * rr;
            tp.y[i] = a[1] + Math.sin(ph * 1.3) * rr * 0.5;
            tp.z[i] = a[2] + Math.sin(ph) * rr;
        }
        animSys.step(dt, trsView, animTargets);
        for (let kk = animN; kk < n; kk++) {
            const e = list[kk];
            const a = atts[e % 3];
            const dx = a[0] - px[e], dy = a[1] - py[e], dz = a[2] - pz[e];
            vx[e] += (dx * 1.4 - vx[e]) * kBlend;
            vy[e] += (dy * 1.4 - vy[e]) * kBlend;
            vz[e] += (dz * 1.4 - vz[e]) * kBlend;
            px[e] += vx[e] * dt; py[e] += vy[e] * dt; pz[e] += vz[e] * dt;
        }
        break;
    }

    case 5: { // MORPH FORMATIONS — staggered lerp inside a slerped quat frame
        quat.springDamp(frameQuat, frameQuat, frameTarget, frameVel, 1.1, dt, 12);
        const sBreath = 1 + Math.sin(t * 0.5) * 0.07;
        const qx = frameQuat[0], qy = frameQuat[1], qz = frameQuat[2], qw = frameQuat[3];
        const A = shapes[formA], B = shapes[formB];
        for (let kk = 0; kk < n; kk++) {
            const e = list[kk];
            let tt = (morphClock - stag.arr[e]) / 1.4;
            tt = tt < 0 ? 0 : (tt > 1 ? 1 : tt);
            tt = tt * tt * (3 - 2 * tt);
            const lx = (A.x[e] + (B.x[e] - A.x[e]) * tt) * sBreath;
            const ly = (A.y[e] + (B.y[e] - A.y[e]) * tt) * sBreath;
            const lz = (A.z[e] + (B.z[e] - A.z[e]) * tt) * sBreath;
            // rotate by frame quaternion (inline, zero alloc)
            const tx = qy * lz - qz * ly, ty = qz * lx - qx * lz, tz = qx * ly - qy * lx;
            const rx = lx + 2 * (qw * tx + qy * tz - qz * ty);
            const ry = ly + 2 * (qw * ty + qz * tx - qx * tz);
            const rz = lz + 2 * (qw * tz + qx * ty - qy * tx);
            const ox = px[e], oy = py[e], oz = pz[e];
            px[e] += (rx - ox) * Math.min(1, dt * 7);
            py[e] += (ry - oy) * Math.min(1, dt * 7);
            pz[e] += (rz - oz) * Math.min(1, dt * 7);
            vx[e] = (px[e] - ox) / Math.max(dt, 1e-4);
            vy[e] = (py[e] - oy) / Math.max(dt, 1e-4);
            vz[e] = (pz[e] - oz) / Math.max(dt, 1e-4);
        }
        morphClock += dt;
        if (morphClock > FORM_DUR + 1.6) {
            formA = formB;
            formB = (formB + 1 + ((Math.random() * 3) | 0)) % shapes.length;
            morphClock = 0;
        }
        break;
    }

    case 6: { // STORM FRONT — trig turbulence + lightning
        for (let kk = 0; kk < n; kk++) {
            const e = list[kk];
            const x = px[e], y = py[e], z = pz[e];
            const fx = Math.sin(y * 0.22 + t * 1.1) + Math.sin(z * 0.17 - t * 0.7);
            const fy = Math.sin(z * 0.19 + t * 0.9) + Math.sin(x * 0.23 + t * 1.3);
            const fz = Math.sin(x * 0.21 - t * 1.2) + Math.sin(y * 0.16 + t * 0.8);
            const sp = 6 * (0.5 + turb);
            vx[e] += (fx * sp - vx[e]) * kBlend;
            vy[e] += (fy * sp - vy[e]) * kBlend;
            vz[e] += (fz * sp - vz[e]) * kBlend;
            px[e] += vx[e] * dt; py[e] += vy[e] * dt; pz[e] += vz[e] * dt;
        }
        nextFlash -= dt;
        if (nextFlash <= 0) {
            nextFlash = 1.6 + Math.random() * 3.4;
            flash = 1;
            audio.crackle();
        }
        break;
    }

    case 7: { // COMET ENTOURAGE — particles trail 5 dual-quat comets
        for (let kk = 0; kk < n; kk++) {
            const e = list[kk];
            const c = e % COMETS;
            const sd = M.seed[e];
            const cp = cometPos;
            const ph = sd * 6.28318 + t * (0.7 + sd);
            const rr = 1.2 + (sd * 0.618 % 1) * 3.4;
            const gx = cp.x[c] + Math.cos(ph) * rr;
            const gy = cp.y[c] + Math.sin(ph * 1.4) * rr * 0.7;
            const gz = cp.z[c] + Math.sin(ph) * rr;
            vx[e] += ((gx - px[e]) * 2.4 - vx[e]) * kBlend;
            vy[e] += ((gy - py[e]) * 2.4 - vy[e]) * kBlend;
            vz[e] += ((gz - pz[e]) * 2.4 - vz[e]) * kBlend;
            px[e] += vx[e] * dt; py[e] += vy[e] * dt; pz[e] += vz[e] * dt;
        }
        break;
    }
    }

    // containment + shocks + pointer force (stateful acts only)
    const parametric = (act === 1 || act === 3 || act === 5);
    if (!parametric) {
        const R2 = BOUND_R * BOUND_R;
        for (let kk = 0; kk < n; kk++) {
            const e = list[kk];
            const x = px[e], y = py[e], z = pz[e];
            if (x * x + y * y + z * z > R2) {
                vx[e] -= x * dt * 0.6; vy[e] -= y * dt * 0.6; vz[e] -= z * dt * 0.6;
            }
        }
    }
    // shockwaves
    for (let si = shocks.length - 1; si >= 0; si--) {
        const sh = shocks[si];
        const age = simTime - sh.t;
        if (age > 0.6) { shocks.splice(si, 1); continue; }
        const pw = (1 - age / 0.6) * 46;
        for (let kk = 0; kk < n; kk += 2) {
            const e = list[kk];
            const dx = px[e] - sh.x, dy = py[e] - sh.y, dz = pz[e] - sh.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < 324 && d2 > 0.01) {
                const inv = pw / Math.sqrt(d2);
                vx[e] += dx * inv * dt * 8;
                vy[e] += dy * inv * dt * 8;
                vz[e] += dz * inv * dt * 8;
            }
        }
    }
    // pointer force field (grid-queried neighborhood)
    if (pointerActive && gridNearby > 0) {
        const res = grid.getQueryResults();
        const cnt = Math.min(gridNearby, 1400);
        const mode = S.forceMode;
        for (let k = 0; k < cnt; k++) {
            const e = res[k];
            if (e >= px.length) { continue; }
            const dx = px[e] - pointerPos[0], dy = py[e] - pointerPos[1], dz = pz[e] - pointerPos[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > 196 || d2 < 0.01) { continue; }
            const d = Math.sqrt(d2);
            const f = (1 - d / 14) * 30 * dt;
            if (mode === "attract") {
                vx[e] -= dx / d * f; vy[e] -= dy / d * f; vz[e] -= dz / d * f;
            } else if (mode === "repel") {
                vx[e] += dx / d * f; vy[e] += dy / d * f; vz[e] += dz / d * f;
            } else {
                vx[e] += -dz / d * f * 1.6; vz[e] += dx / d * f * 1.6;
            }
        }
    }
}

function stepComets(dt) {
    if (!cometDQ) { return; }
    for (let i = 0; i < COMETS; i++) { cometM[i] += cometN[i] * dt; }
    quat2.soaFromOrbitalElements(cometDQ, cometEls.a, cometEls.e, cometM, cometEls.inc, cometEls.Om, cometEls.om);
    quat2.soaGetTranslation(cometPos, cometDQ);
    // push trail ring buffer
    const base = trailIdx * 3;
    for (let c = 0; c < COMETS; c++) {
        const o = c * TRAIL_LEN * 3 + base;
        trailBuf[o] = cometPos.x[c]; trailBuf[o + 1] = cometPos.y[c]; trailBuf[o + 2] = cometPos.z[c];
    }
    trailIdx = (trailIdx + 1) % TRAIL_LEN;
}

// ============================================================================
// 7. FLOATING ORIGIN
// ============================================================================
function applyOriginShift(sx, sy, sz) {
    origin64[0] += sx; origin64[1] += sy; origin64[2] += sz;
    originShifts++;
    for (let i = 0; i < 3; i++) {
        atts[i][0] -= sx; atts[i][1] -= sy; atts[i][2] -= sz;
        fountains[i][0] -= sx; fountains[i][1] -= sy; fountains[i][2] -= sz;
    }
    vec3.set(T.targetVel, 0, 0, 0);
    toast("FLOATING ORIGIN RECENTERED · Δ " + Math.round(Math.hypot(sx, sy, sz)) + " km", "ok");
    audio.blip(660); audio.blip(990);
}
function checkOrigin() {
    const before0 = T.target[0], before1 = T.target[1], before2 = T.target[2];
    if (fo.recenter(T.target, { position: { x: C.Position.x, y: C.Position.y, z: C.Position.z, count: N + 16 } })) {
        applyOriginShift(before0, before1, before2);
    }
}
function manualRecenter() {
    const sx = T.target[0], sy = T.target[1], sz = T.target[2];
    if (Math.abs(sx) + Math.abs(sy) + Math.abs(sz) < 1) { return; }
    const P = C.Position, n = N + 16;
    for (let i = 0; i < n; i++) { P.x[i] -= sx; P.y[i] -= sy; P.z[i] -= sz; }
    applyOriginShift(sx, sy, sz);
}

// ============================================================================
// 8. WEBGL RENDERER — additive point theatre
// ============================================================================
let gl = null, glOK = false, glLost = false, isGL2 = false, angleExt = null;
let progBG, progPts, progGlow, progLine;
let bufBG, bufPts, bufStatic, bufGlow, bufTrail, bufTrailT;
let staging = null, glowStaging = new Float32Array((COMETS + 4) * 8);
let staticStaging = null;

const BG_VS = `
precision highp float;
attribute vec2 a_pos; varying vec2 v_uv;
void main(){ v_uv = a_pos; gl_Position = vec4(a_pos, 0.9999, 1.0); }`;
const BG_FS = `
precision highp float;
varying vec2 v_uv;
uniform vec3 u_right, u_up, u_fwd, u_keyDir, u_colA, u_colB, u_colC;
uniform float u_time, u_tanA, u_tanF, u_flash;
float h3(vec3 p){ p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = h3(i), b = h3(i + vec3(1,0,0)), c = h3(i + vec3(0,1,0)), d = h3(i + vec3(1,1,0));
  float e = h3(i + vec3(0,0,1)), g = h3(i + vec3(1,0,1)), h = h3(i + vec3(0,1,1)), k = h3(i + vec3(1,1,1));
  return mix(mix(mix(a,b,f.x), mix(c,d,f.x), f.y), mix(mix(e,g,f.x), mix(h,k,f.x), f.y), f.z);
}
float fbm(vec3 p){ float s = 0.0, a = 0.55; for (int i = 0; i < 3; i++){ s += a * noise(p); p *= 2.1; a *= 0.5; } return s; }
void main(){
  vec3 dir = normalize(u_fwd + u_right * v_uv.x * u_tanA + u_up * v_uv.y * u_tanF);
  float t = u_time * 0.008;
  float neb = fbm(dir * 2.4 + vec3(t, -t * 0.6, t * 0.3));
  float neb2 = fbm(dir * 5.0 - vec3(t * 0.5, t, 0.0));
  vec3 col = vec3(0.012, 0.008, 0.02);
  col += mix(u_colA, u_colB, neb2) * pow(neb, 2.6) * 0.16;
  col += u_colC * pow(neb2, 3.6) * 0.07;
  float align = max(dot(dir, u_keyDir), 0.0);
  float streak = noise(dir * 9.0 + vec3(0.0, u_time * 0.02, 0.0));
  col += u_colB * (pow(align, 42.0) * 0.7 + pow(align, 7.0) * 0.13 * (0.5 + 0.5 * streak));
  vec3 sp = dir * 150.0;
  float sh = h3(floor(sp));
  if (sh > 0.9955) {
    vec3 f = fract(sp) - 0.5;
    float star = exp(-dot(f, f) * 26.0);
    float tw = 0.6 + 0.4 * sin(u_time * 2.4 + sh * 90.0);
    col += vec3(0.9, 0.95, 1.0) * star * tw * 1.3;
  }
  float vig = 1.0 - dot(v_uv * 0.6, v_uv * 0.6);
  col *= clamp(vig, 0.25, 1.0);
  col += u_colA * u_flash * 0.5;
  gl_FragColor = vec4(col, 1.0);
}`;
const PTS_VS = `
precision highp float;
attribute vec3 a_pos; attribute vec2 a_dat;
uniform mat4 u_vp; uniform float u_dpr, u_size;
varying float v_seed; varying float v_heat; varying float v_depth;
void main(){
  vec4 cp = u_vp * vec4(a_pos, 1.0);
  gl_Position = cp;
  gl_PointSize = clamp(a_dat.x * u_size * u_dpr * 240.0 / max(cp.w, 0.5), 1.0, 58.0);
  v_seed = fract(a_dat.y * 0.618);
  v_heat = clamp(a_dat.y, 0.0, 1.6);
  v_depth = cp.w;
}`;
const PTS_FS = `
precision highp float;
varying float v_seed; varying float v_heat; varying float v_depth;
uniform vec3 u_colA, u_colB, u_colC;
uniform float u_glow, u_fog, u_hue, u_flash;
vec3 hueRot(vec3 c, float a){
  float co = cos(a), si = sin(a);
  mat3 m = mat3(
    0.299 + 0.701*co + 0.168*si, 0.587 - 0.587*co + 0.330*si, 0.114 - 0.114*co - 0.497*si,
    0.299 - 0.299*co - 0.328*si, 0.587 + 0.413*co + 0.035*si, 0.114 - 0.114*co + 0.292*si,
    0.299 - 0.300*co + 1.250*si, 0.587 - 0.588*co - 1.050*si, 0.114 + 0.886*co - 0.203*si);
  return m * c;
}
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) { discard; }
  float core = exp(-r * r * 9.0);
  float halo = exp(-r * r * 2.6) * 0.32;
  vec3 base = v_seed < 0.5
      ? mix(u_colA, u_colB, v_seed * 2.0)
      : mix(u_colB, u_colC, (v_seed - 0.5) * 2.0);
  base = hueRot(base, u_hue);
  vec3 col = mix(base, vec3(1.0, 0.98, 0.92), min(1.0, v_heat * 0.55));
  float fogF = exp(-v_depth * u_fog);
  float a = (core + halo) * u_glow * fogF * (1.0 + u_flash * 1.4);
  gl_FragColor = vec4(col * a, a);
}`;
const GLOW_VS = `
precision highp float;
attribute vec3 a_pos; attribute float a_size; attribute vec3 a_col;
uniform mat4 u_vp; uniform float u_dpr;
varying vec3 v_col;
void main(){
  vec4 cp = u_vp * vec4(a_pos, 1.0);
  gl_Position = cp;
  gl_PointSize = clamp(a_size * u_dpr * 300.0 / max(cp.w, 0.5), 2.0, 170.0);
  v_col = a_col;
}`;
const GLOW_FS = `
precision highp float;
varying vec3 v_col; uniform float u_glow;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float a = exp(-r * r * 3.4) * (1.0 - smoothstep(0.8, 1.0, r));
  gl_FragColor = vec4(v_col * a * u_glow * 1.6, a);
}`;
const LINE_VS = `
precision highp float;
attribute vec3 a_pos; attribute float a_t;
uniform mat4 u_vp;
varying float v_t;
void main(){ gl_Position = u_vp * vec4(a_pos, 1.0); v_t = a_t; }`;
const LINE_FS = `
precision highp float;
varying float v_t; uniform vec3 u_col; uniform float u_glow;
void main(){
  float a = v_t * v_t * 0.85 * u_glow;
  gl_FragColor = vec4(u_col * a, a);
}`;

function compile(vs, fs) {
    const p = gl.createProgram();
    const v = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(v, vs); gl.compileShader(v);
    const f = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(f, fs); gl.compileShader(f);
    if (!gl.getShaderParameter(v, gl.COMPILE_STATUS)) { throw new Error("VS: " + gl.getShaderInfoLog(v)); }
    if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) { throw new Error("FS: " + gl.getShaderInfoLog(f)); }
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { throw new Error("LINK: " + gl.getProgramInfoLog(p)); }
    const u = {}, a = {};
    const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) { const inf = gl.getActiveUniform(p, i); u[inf.name] = gl.getUniformLocation(p, inf.name); }
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < na; i++) { const inf = gl.getActiveAttrib(p, i); a[inf.name] = gl.getAttribLocation(p, inf.name); }
    return { p, u, a };
}
function divisor(loc, d) {
    if (isGL2) { gl.vertexAttribDivisor(loc, d); } else { angleExt.vertexAttribDivisorANGLE(loc, d); }
}
function initGL() {
    try {
        gl = glCanvas.getContext("webgl2", { antialias: true, alpha: false, powerPreference: "high-performance" });
        isGL2 = !!gl;
        if (!gl) {
            gl = glCanvas.getContext("webgl", { antialias: true, alpha: false });
            if (gl) { angleExt = gl.getExtension("ANGLE_instanced_arrays"); }
            if (!gl || !angleExt) { gl = null; }
        }
    } catch (e) { gl = null; }
    if (!gl) {
        glOK = false;
        $("pt-glchip").textContent = "CANVAS FALLBACK";
        glCanvas.style.display = "none"; fbCanvas.style.display = "block";
        return;
    }
    try {
        progBG = compile(BG_VS, BG_FS);
        progPts = compile(PTS_VS, PTS_FS);
        progGlow = compile(GLOW_VS, GLOW_FS);
        progLine = compile(LINE_VS, LINE_FS);
    } catch (e) {
        console.error("[particle_showcase] GL init:", e);
        glOK = false; gl = null;
        $("pt-glchip").textContent = "CANVAS FALLBACK";
        glCanvas.style.display = "none"; fbCanvas.style.display = "block";
        return;
    }
    bufBG = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufBG);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    bufPts = gl.createBuffer();
    bufStatic = gl.createBuffer();
    bufGlow = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufGlow);
    gl.bufferData(gl.ARRAY_BUFFER, glowStaging.byteLength, gl.DYNAMIC_DRAW);
    bufTrail = gl.createBuffer();
    bufTrailT = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufTrailT);
    const tt = new Float32Array(TRAIL_LEN);
    for (let i = 0; i < TRAIL_LEN; i++) { tt[i] = i / (TRAIL_LEN - 1); }
    gl.bufferData(gl.ARRAY_BUFFER, tt, gl.STATIC_DRAW);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.01, 0.006, 0.02, 1);
    glOK = true; glLost = false;
    $("pt-glchip").textContent = isGL2 ? "WEBGL2 · POINTS" : "WEBGL1 · POINTS";
    resize();
}
function reallocParticleBuffers() {
    staging = new Float32Array(N * 5);
    staticStaging = new Float32Array(N * 2);
    const M = C.Meta, COL = C.Color;
    for (let k = 0; k < N; k++) {
        const e = pList[k];
        staticStaging[k * 2] = M.size[e];
        staticStaging[k * 2 + 1] = M.seed[e] * 100;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufPts);
    gl.bufferData(gl.ARRAY_BUFFER, staging.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufStatic);
    gl.bufferData(gl.ARRAY_BUFFER, staticStaging, gl.STATIC_DRAW);
}
glCanvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault(); glLost = true;
    $("pt-glchip").textContent = "GL LOST · RECOVERING";
    $("pt-glchip").classList.remove("on");
});
glCanvas.addEventListener("webglcontextrestored", () => {
    initGL();
    if (glOK && C) { reallocParticleBuffers(); }
    toast("GL CONTEXT RESTORED", "ok");
});

function packParticles() {
    const list = pList, n = drawN;
    const P = C.Position, V = C.Velocity, M = C.Meta;
    let o = 0;
    for (let k = 0; k < n; k++) {
        const e = list[k];
        staging[o] = P.x[e]; staging[o + 1] = P.y[e]; staging[o + 2] = P.z[e];
        staging[o + 3] = M.size[e];
        const sp = Math.sqrt(V.x[e] * V.x[e] + V.y[e] * V.y[e] + V.z[e] * V.z[e]);
        staging[o + 4] = Math.min(1.6, sp * 0.08);
        o += 5;
    }
}

function buildGlowPoints() {
    let o = 0, cnt = 0;
    const push = (x, y, z, size, r, g, b) => {
        glowStaging[o] = x; glowStaging[o + 1] = y; glowStaging[o + 2] = z;
        glowStaging[o + 3] = size; glowStaging[o + 4] = r; glowStaging[o + 5] = g; glowStaging[o + 6] = b;
        o += 7; cnt++;
    };
    if (cometPos) {
        for (let c = 0; c < COMETS; c++) {
            push(cometPos.x[c], cometPos.y[c], cometPos.z[c],
                2.4 + Math.sin(simTime * 3 + c) * 0.5, colB[0], colB[1], colB[2]);
        }
    }
    if (act === 4) {
        for (let i = 0; i < 3; i++) {
            push(atts[i][0], atts[i][1], atts[i][2], 2.0, colC[0], colC[1], colC[2]);
        }
    }
    if (act === 1) {
        for (let i = 0; i < 3; i++) {
            push(fountains[i][0], fountains[i][1] + 1, fountains[i][2], 1.6, colA[0], colA[1], colA[2]);
        }
    }
    return cnt;
}

function renderGL() {
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const tanF = Math.tan(55 * Math.PI / 360);

    // background
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(progBG.p);
    gl.uniform3fv(progBG.u.u_right, T.right);
    gl.uniform3fv(progBG.u.u_up, T.cup);
    gl.uniform3fv(progBG.u.u_fwd, T.fwd);
    gl.uniform3fv(progBG.u.u_keyDir, KEY_DIR);
    gl.uniform3f(progBG.u.u_colA, colA[0], colA[1], colA[2]);
    gl.uniform3f(progBG.u.u_colB, colB[0], colB[1], colB[2]);
    gl.uniform3f(progBG.u.u_colC, colC[0], colC[1], colC[2]);
    gl.uniform1f(progBG.u.u_time, simTime);
    gl.uniform1f(progBG.u.u_tanA, tanF * (W / H));
    gl.uniform1f(progBG.u.u_tanF, tanF);
    gl.uniform1f(progBG.u.u_flash, flash);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufBG);
    const bgLoc = progBG.a.a_pos;
    gl.enableVertexAttribArray(bgLoc);
    gl.vertexAttribPointer(bgLoc, 2, gl.FLOAT, false, 8, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);

    // particles (additive)
    gl.useProgram(progPts.p);
    gl.uniformMatrix4fv(progPts.u.u_vp, false, T.vp);
    gl.uniform1f(progPts.u.u_dpr, DPR);
    gl.uniform1f(progPts.u.u_size, S.pointSize);
    gl.uniform3f(progPts.u.u_colA, colA[0], colA[1], colA[2]);
    gl.uniform3f(progPts.u.u_colB, colB[0], colB[1], colB[2]);
    gl.uniform3f(progPts.u.u_colC, colC[0], colC[1], colC[2]);
    gl.uniform1f(progPts.u.u_glow, S.glow);
    gl.uniform1f(progPts.u.u_fog, S.fog);
    gl.uniform1f(progPts.u.u_hue, uHue);
    gl.uniform1f(progPts.u.u_flash, flash);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufPts);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, staging.subarray(0, drawN * 5));
    const pLoc = progPts.a.a_pos;
    gl.enableVertexAttribArray(pLoc);
    gl.vertexAttribPointer(pLoc, 3, gl.FLOAT, false, 20, 0);
    const dLoc = progPts.a.a_dat;
    gl.enableVertexAttribArray(dLoc);
    gl.vertexAttribPointer(dLoc, 2, gl.FLOAT, false, 20, 12);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    gl.drawArrays(gl.POINTS, 0, drawN);

    // glow sprites (comets / attractors / fountains)
    const gc = buildGlowPoints();
    if (gc > 0) {
        gl.useProgram(progGlow.p);
        gl.uniformMatrix4fv(progGlow.u.u_vp, false, T.vp);
        gl.uniform1f(progGlow.u.u_dpr, DPR);
        gl.uniform1f(progGlow.u.u_glow, S.glow);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufGlow);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, glowStaging.subarray(0, gc * 7));
        const gLoc = progGlow.a.a_pos;
        gl.enableVertexAttribArray(gLoc);
        gl.vertexAttribPointer(gLoc, 3, gl.FLOAT, false, 28, 0);
        const sLoc = progGlow.a.a_size;
        gl.enableVertexAttribArray(sLoc);
        gl.vertexAttribPointer(sLoc, 1, gl.FLOAT, false, 28, 12);
        const cLoc = progGlow.a.a_col;
        gl.enableVertexAttribArray(cLoc);
        gl.vertexAttribPointer(cLoc, 3, gl.FLOAT, false, 28, 16);
        gl.drawArrays(gl.POINTS, 0, gc);
    }

    // comet trails
    if (trailBuf && S.trail > 0.05) {
        gl.useProgram(progLine.p);
        gl.uniformMatrix4fv(progLine.u.u_vp, false, T.vp);
        gl.uniform3f(progLine.u.u_col, colB[0], colB[1], colB[2]);
        gl.uniform1f(progLine.u.u_glow, S.glow * S.trail);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufTrailT);
        const tLoc = progLine.a.a_t;
        gl.enableVertexAttribArray(tLoc);
        gl.vertexAttribPointer(tLoc, 1, gl.FLOAT, false, 4, 0);
        const lLoc = progLine.a.a_pos;
        gl.enableVertexAttribArray(lLoc);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufTrail);
        gl.bufferData(gl.ARRAY_BUFFER, trailBuf.subarray(0, COMETS * TRAIL_LEN * 3), gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(lLoc, 3, gl.FLOAT, false, 12, 0);
        for (let c = 0; c < COMETS; c++) {
            gl.drawArrays(gl.LINE_STRIP, c * TRAIL_LEN, TRAIL_LEN);
        }
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
}

// Canvas2D fallback (same simulation, reduced visuals)
function renderFallback() {
    const c = ctx2d;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.globalCompositeOperation = "source-over";
    c.fillStyle = "#07040d";
    c.fillRect(0, 0, W, H);
    const M = T.vp, P = C.Position, V = C.Velocity;
    const n = Math.min(drawN, 20000);
    const step = Math.max(1, Math.floor(drawN / n));
    c.globalCompositeOperation = "lighter";
    const rA = (colA[0] * 255) | 0, gA = (colA[1] * 255) | 0, bA = (colA[2] * 255) | 0;
    const rB = (colB[0] * 255) | 0, gB = (colB[1] * 255) | 0, bB = (colB[2] * 255) | 0;
    for (let k = 0; k < drawN; k += step) {
        const e = pList[k];
        const x = P.x[e], y = P.y[e], z = P.z[e];
        const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
        if (cw < 0.4) { continue; }
        const inv = 1 / cw;
        const px = ((M[0] * x + M[4] * y + M[8] * z + M[12]) * inv * 0.5 + 0.5) * W;
        const py = (1 - ((M[1] * x + M[5] * y + M[9] * z + M[13]) * inv * 0.5 + 0.5)) * H;
        if (px < -4 || px > W + 4 || py < -4 || py > H + 4) { continue; }
        const sp = Math.sqrt(V.x[e] * V.x[e] + V.y[e] * V.y[e] + V.z[e] * V.z[e]);
        const hot = Math.min(1, sp * 0.06);
        const rr = (rA + (rB - rA) * hot) | 0, gg = (gA + (gB - gA) * hot) | 0, bb = (bA + (bB - bA) * hot) | 0;
        c.fillStyle = "rgba(" + rr + "," + gg + "," + bb + "," + (0.5 * S.glow).toFixed(2) + ")";
        const sz = Math.max(1, Math.min(3.4, 5 * S.pointSize / cw * 8));
        c.fillRect(px, py, sz, sz);
    }
    c.globalCompositeOperation = "source-over";
}

// ============================================================================
// 9. INPUT
// ============================================================================
let dragging = false, moved = 0, pointerActive = false, pointerDecay = 0, gridNearby = 0;
const pointers = new Map();
let pinchDist = 0;
const pointerPos = vec3.create();

for (const cv of [glCanvas, fbCanvas]) {
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
        const r = cv.getBoundingClientRect();
        pointerToWorld(((e.clientX - r.left) / r.width) * 2 - 1,
            -(((e.clientY - r.top) / r.height) * 2 - 1), pointerPos);
        pointerActive = true; pointerDecay = 1.5;
        if (pointers.size === 2) {
            const p = Array.from(pointers.values());
            const d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
            if (pinchDist > 0) { cam.distT = Math.max(18, Math.min(320, cam.distT * (pinchDist / d))); }
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
                    -(((e.clientY - r.top) / r.height) * 2 - 1), T.v3a);
                shocks.push({ x: T.v3a[0], y: T.v3a[1], z: T.v3a[2], t: simTime });
                if (shocks.length > 3) { shocks.shift(); }
                audio.blip(240); audio.blip(180);
            }
            dragging = false; pinchDist = 0;
        }
    });
    cv.addEventListener("pointercancel", (e) => { pointers.delete(e.pointerId); dragging = false; pinchDist = 0; });
    cv.addEventListener("wheel", (e) => {
        e.preventDefault();
        cam.distT = Math.max(18, Math.min(320, cam.distT * Math.exp(e.deltaY * 0.0012)));
    }, { passive: false });
}

window.addEventListener("keydown", (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { return; }
    const k = e.key.toLowerCase();
    if (k === " ") { e.preventDefault(); togglePause(); }
    else if (k === "n") { nextAct(); }
    else if (k === "r") { randomizeAll(false); }
    else if (k === "o") { manualRecenter(); }
    else if (k === "e") { exportSnapshot(); }
    else if (k === "m") { audio.toggle(); }
    else if (k === "f") { S.follow = !S.follow; syncControls(); toast(S.follow ? "FOLLOWING COMET" : "FREE ORBIT"); }
    else if (k === "a") { S.autoCycle = !S.autoCycle; syncControls(); }
});

// ============================================================================
// 10. AUDIO (ambient theatre pad + event sounds, one-touch mute)
// ============================================================================
const audio = (function () {
    let ctxA = null, master = null, muted = false, started = false;
    function ensure() {
        if (started) { return; }
        try {
            ctxA = new (window.AudioContext || window.webkitAudioContext)();
            master = ctxA.createGain(); master.gain.value = 0.5; master.connect(ctxA.destination);
            const lp = ctxA.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 260; lp.Q.value = 1.4;
            const dg = ctxA.createGain(); dg.gain.value = 0.045;
            lp.connect(dg); dg.connect(master);
            [55, 55.6, 110.4, 164.8].forEach(f => {
                const o = ctxA.createOscillator(); o.type = "sawtooth"; o.frequency.value = f;
                o.connect(lp); o.start();
            });
            const lfo = ctxA.createOscillator(); lfo.frequency.value = 0.05;
            const lg = ctxA.createGain(); lg.gain.value = 110;
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
        actChime(i) {
            ensure();
            const base = 320 + (i % 8) * 60;
            tone(base, 0.35, 0.05, "sine");
            setTimeout(() => tone(base * 1.5, 0.3, 0.04, "sine"), 90);
        },
        crackle() {
            if (!ctxA || muted) { return; }
            const o = ctxA.createOscillator(), g = ctxA.createGain();
            o.type = "square";
            o.frequency.setValueAtTime(90, ctxA.currentTime);
            o.frequency.exponentialRampToValueAtTime(2400, ctxA.currentTime + 0.06);
            g.gain.setValueAtTime(0.035, ctxA.currentTime);
            g.gain.exponentialRampToValueAtTime(0.0001, ctxA.currentTime + 0.25);
            o.connect(g); g.connect(master);
            o.start(); o.stop(ctxA.currentTime + 0.26);
        },
        toggle() {
            muted = !muted;
            if (!muted) { ensure(); }
            if (master) { master.gain.value = muted ? 0 : 0.5; }
            const el = $("pt-mute");
            el.textContent = muted ? "♪ SOUND OFF" : "♪ SOUND ON";
            el.style.color = muted ? "var(--dim)" : "var(--acc2)";
            return muted;
        }
    };
})();
$("pt-mute").addEventListener("pointerdown", (e) => { e.preventDefault(); audio.toggle(); });

// ============================================================================
// 11. ACTIONS — act switching / pause / reset / export
// ============================================================================
function nextAct() {
    act = (act + 1) % ACTS.length;
    actT = 0;
    if (act === 5) { formA = (Math.random() * shapes.length) | 0; formB = (formA + 1) % (shapes ? shapes.length : 5); morphClock = 0; }
    if (S.autoRandom) { randomizeAll(true); }
    toast("ACT " + (act + 1) + " / 8 · " + ACTS[act], "ok");
    audio.actChime(act);
}
function togglePause() {
    paused = !paused;
    const b = panel.querySelector('[data-act="pause"]');
    if (b) { b.textContent = paused ? "▶ RESUME" : "⏸ PAUSE"; }
    toast(paused ? "PERFORMANCE HELD" : "PERFORMANCE LIVE", paused ? "warn" : "ok");
    audio.blip(paused ? 440 : 880);
}
function resetAll() {
    Object.assign(S, DEFAULTS);
    seed = 77123;
    origin64.fill(0); originShifts = 0;
    act = 0; actT = 0; flash = 0;
    cam.yawT = 0.9; cam.pitchT = 0.42; cam.distT = 88;
    palIdx = 0;
    const P = PAL_SETS[0];
    vec4.set(colA, P[0][0], P[0][1], P[0][2], 1);
    vec4.set(colB, P[1][0], P[1][1], P[1][2], 1);
    vec4.set(colC, P[2][0], P[2][1], P[2][2], 1);
    vec4.copy(colTA, colA); vec4.copy(colTB, colB); vec4.copy(colTC, colC);
    syncControls(); resize();
    rebuild("THEATRE RESET");
    audio.blip(520);
}

let exportBusy = false;
async function exportSnapshot() {
    if (exportBusy || !world || rebuilding) { return; }
    exportBusy = true;
    const btn = panel.querySelector('[data-act="export"]');
    if (btn) { btn.disabled = true; }
    toast("PACKING SNAPSHOT…");
    try {
        const K = Math.min(N, 16384);
        const step = Math.max(1, Math.floor(N / K));
        const eids = new Uint32Array(K);
        const trs = ecs.createTransformSOA(K);
        const col = ecs.createColorSOA(K);
        trs.rotation.w.fill(1);
        trs.scale.x.fill(1); trs.scale.y.fill(1); trs.scale.z.fill(1);
        const P = C.Position, M = C.Meta, COL = C.Color;
        for (let k = 0; k < K; k++) {
            const e = pList[k * step];
            eids[k] = e;
            trs.position.x[k] = P.x[e]; trs.position.y[k] = P.y[e]; trs.position.z[k] = P.z[e];
            trs.scale.x[k] = M.size[e]; trs.scale.y[k] = M.size[e]; trs.scale.z[k] = M.size[e];
            col.x[k] = COL.x[e]; col.y[k] = COL.y[e]; col.z[k] = COL.z[e]; col.w[k] = COL.w[e];
        }
        let bytes;
        if (ser11) {
            const writer = ser11.createByteWriter(1 << 22);
            await ser11.serializeScene(writer, { eids: eids, trs: trs, colors: col }, { chunkSize: 4096 });
            bytes = writer.slice();
            writer.release();
        } else {
            const buf = new ArrayBuffer(30 + K * 32);
            const dv = new DataView(buf);
            dv.setUint32(0, 0x50544854); dv.setUint16(4, 1); dv.setUint32(6, K);
            dv.setFloat64(10, origin64[0]); dv.setFloat64(18, origin64[1]); dv.setFloat64(26, origin64[2] + 4);
            let o = 30;
            for (let k = 0; k < K; k++) {
                dv.setFloat32(o, trs.position.x[k]); dv.setFloat32(o + 4, trs.position.y[k]); dv.setFloat32(o + 8, trs.position.z[k]);
                dv.setFloat32(o + 12, col.x[k]); dv.setFloat32(o + 16, col.y[k]);
                dv.setFloat32(o + 20, col.z[k]); dv.setFloat32(o + 24, col.w[k]);
                dv.setFloat32(o + 28, trs.scale.x[k]);
                o += 32;
            }
            bytes = buf;
        }
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "particle-theatre-" + fmtK(K) + "-" + (ser11 ? "011" : "ptth") + ".bin";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast("EXPORTED " + (bytes.byteLength / 1048576).toFixed(2) + " MB · " + K + " PARTICLES", "ok");
        audio.blip(880); audio.blip(1320);
    } catch (e) {
        console.error("[particle_showcase] export:", e);
        toast("EXPORT FAILED — see console", "err");
    }
    exportBusy = false;
    if (btn) { btn.disabled = false; }
}

// ============================================================================
// 12. CONTROL DECK (permanently visible, everything live)
// ============================================================================
const controlRefs = {};
let rebuildTimer = 0;
function scheduleRebuild(reason) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => { rebuild(reason); }, 260);
}
function addSection(letter, title) {
    const d = document.createElement("div");
    d.className = "pt-sec";
    d.innerHTML = "<b>" + letter + "</b> " + title;
    panel.appendChild(d);
}
function addRange(key, label, min, max, step, fmt, onInput) {
    const row = document.createElement("div");
    row.className = "pt-row";
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
    row.className = "pt-row";
    row.innerHTML = `<label>${label}</label><select class="pt-sel">${
        options.map(o => `<option value="${o[0]}" ${S[key] === o[0] ? "selected" : ""}>${o[1]}</option>`).join("")
    }</select>`;
    const sel = row.querySelector("select");
    sel.addEventListener("change", () => { S[key] = sel.value; onChange(sel.value); });
    panel.appendChild(row);
    controlRefs[key] = { input: sel };
}
function addToggle(key, label, onChange) {
    const row = document.createElement("div");
    row.className = "pt-tog" + (S[key] ? " on" : "");
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
function addButton(act2, label, cls, fn) {
    const b = document.createElement("button");
    b.className = "pt-btn " + (cls || "");
    b.textContent = label;
    b.dataset.act = act2;
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); fn(); });
    return b;
}
function buildPanel() {
    addSection("A", "PERFORMANCE");
    addRange("count", "PARTICLES", 10000, 300000, 10000, v => fmtK(v), () => scheduleRebuild("FIELD RESIZED"));
    addRange("timeScale", "TIME SCALE", 0, 4, 0.05, v => v.toFixed(2) + "×", () => {});
    addToggle("autoCycle", "AUTO-CYCLE ACTS");
    addToggle("autoRandom", "AUTO-RANDOMIZE");

    addSection("B", "MOTION & LOOK");
    addRange("turbulence", "TURBULENCE", 0, 2, 0.05, v => v.toFixed(2), () => {});
    addRange("glow", "GLOW", 0, 2.5, 0.05, v => v.toFixed(2), () => {});
    addRange("pointSize", "POINT SIZE", 0.4, 2.5, 0.05, v => v.toFixed(2) + "×", () => {});
    addRange("fog", "DEPTH FOG", 0, 0.02, 0.0005, v => (v * 1000).toFixed(1) + "‰", () => {});
    addRange("hueDrift", "HUE DRIFT", 0, 1, 0.02, v => v.toFixed(2) + " rad/s", () => {});
    addRange("trail", "COMET TRAILS", 0, 1.5, 0.05, v => v.toFixed(2), () => {});

    addSection("C", "CAMERA & INTERACTION");
    addToggle("follow", "FOLLOW COMET");
    addSelect("forceMode", "POINTER FORCE",
        [["attract", "Attract"], ["repel", "Repel"], ["vortex", "Vortex swirl"]], () => {});
    addSelect("quality", "QUALITY (PIXEL RATIO)",
        [["low", "Low · 1.0×"], ["balanced", "Balanced · 1.5×"], ["high", "High · 2.0×"]], () => resize());

    addSection("D", "ACTIONS");
    const gridBtns = document.createElement("div");
    gridBtns.className = "pt-btns";
    gridBtns.appendChild(addButton("pause", "⏸ PAUSE", "", togglePause));
    gridBtns.appendChild(addButton("next", "⏭ NEXT ACT", "", nextAct));
    gridBtns.appendChild(addButton("random", "🎲 RANDOMIZE", "", () => randomizeAll(false)));
    gridBtns.appendChild(addButton("recenter", "🌍 RECENTER", "", manualRecenter));
    gridBtns.appendChild(addButton("export", "⬇ EXPORT SNAPSHOT (.bin)", "pri", exportSnapshot));
    gridBtns.appendChild(addButton("reset", "↺ RESET", "", resetAll));
    panel.appendChild(gridBtns);

    const keys = document.createElement("div");
    keys.className = "pt-keys";
    keys.innerHTML = "<b>SPACE</b> pause · <b>N</b> next act · <b>R</b> randomize · <b>A</b> auto-cycle<br><b>F</b> follow · <b>O</b> recenter · <b>E</b> export · <b>M</b> mute · <b>tap</b> shockwave";
    panel.appendChild(keys);

    const stack = document.createElement("div");
    stack.className = "pt-stack";
    stack.innerHTML = `REPLACEMENT STACK (no three.js)<br>002–009 SOA math · <span class="ok">CORE</span><br>010 bitECS world · <span class="ok">ENGINE</span><br>011 serialization · <span id="pt-stack11" class="fb">PROBING…</span>`;
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
// 13. HUD + COMPASS + TIMELINE
// ============================================================================
let hudTick = 0;
function updateHUD() {
    if (++hudTick % 8 !== 0) { return; }
    hudEl.textContent =
        "PARTICLE THEATRE · ACT " + (act + 1) + "/8\n" +
        ACTS[act] + " · next in " + Math.max(0, ACT_TIME - actT).toFixed(0) + "s" +
        (S.autoCycle ? "" : " · manual") + "\n" +
        "fps " + fpsEma.toFixed(0) + " · particles " + fmtK(drawN) + "/" + fmtK(N) +
        " · seed #" + seed + "\n" +
        "systems ms · sim " + timings.sim.toFixed(1) + " · grid " + timings.grid.toFixed(1) +
        " · draw " + timings.render.toFixed(1) + "\n" +
        "formation : " + (shapes ? shapeNames[formA] + " → " + shapeNames[formB] : "—") +
        " · grid " + gridNearby + " near pointer\n" +
        "origin    : shifts " + originShifts + " · " +
        (origin64[0] / 1000).toFixed(2) + ", " + (origin64[1] / 1000).toFixed(2) + ", " +
        (origin64[2] / 1000).toFixed(2) + " Mm" + (paused ? " · HELD" : "");
    cycleBar.style.width = (S.autoCycle ? (actT / ACT_TIME) * 100 : 0) + "%";
    mat2.fromRotation(T.m2, -cam.yaw);
    const c = compCtx;
    c.clearRect(0, 0, 52, 52);
    c.strokeStyle = "rgba(255,120,220,.3)";
    c.beginPath(); c.arc(26, 26, 22, 0, 6.2832); c.stroke();
    const nx = T.m2[0] * 0 + T.m2[2] * -1, ny = T.m2[1] * 0 + T.m2[3] * -1;
    c.strokeStyle = "#ffc44d"; c.lineWidth = 2;
    c.beginPath(); c.moveTo(26, 26); c.lineTo(26 + nx * 18, 26 + ny * 18); c.stroke();
}

// ============================================================================
// 14. MAIN LOOP
// ============================================================================
let lastT = 0, fpsAcc = 0, fpsN = 0, fpsClock = 0;
function frame(now) {
    requestAnimationFrame(frame);
    now *= 0.001;
    const dt = Math.min(0.05, now - lastT || 0.016);
    lastT = now;

    fpsAcc += dt; fpsN++;
    if (now - fpsClock > 0.5) {
        fpsEma = fpsEma * 0.75 + (fpsN / Math.max(fpsAcc, 1e-4)) * 0.25;
        // adaptive governor: draw count only, never resolution
        if (fpsEma < 38) { drawN = Math.max(8000, Math.floor(drawN * 0.85)); }
        else if (fpsEma > 55 && drawN < N) { drawN = Math.min(N, Math.floor(drawN * 1.1) + 500); }
        fpsAcc = 0; fpsN = 0; fpsClock = now;
    }

    if (!paused && !rebuilding && world) {
        const simDt = dt * S.timeScale;
        simTime += simDt;
        actT += simDt;
        if (S.autoCycle && actT > ACT_TIME) { nextAct(); }

        // palette transition (vec4 lerp)
        const pk = 1 - Math.exp(-dt * 2.2);
        vec4.lerp(colA, colA, colTA, pk);
        vec4.lerp(colB, colB, colTB, pk);
        vec4.lerp(colC, colC, colTC, pk);
        uHue += S.hueDrift * simDt;

        let t0 = performance.now();
        updateAttractors(simTime);
        stepComets(simDt);
        stepParticles(simDt);
        flash *= Math.exp(-dt * 5);
        timings.sim = timings.sim * 0.9 + (performance.now() - t0) * 0.1;

        t0 = performance.now();
        if (grid) {
            grid.clear();
            const list = pList, P = C.Position;
            const gStride = Math.max(1, Math.floor(N / 24000));
            for (let k = 0; k < list.length; k += gStride) {
                const e = list[k];
                grid.insert(e, P.x[e], P.y[e], P.z[e]);
            }
            if (pointerActive) {
                gridNearby = grid.querySphere(pointerPos[0], pointerPos[1], pointerPos[2], 12);
            } else { gridNearby = 0; }
        }
        timings.grid = timings.grid * 0.9 + (performance.now() - t0) * 0.1;

        pointerDecay -= dt;
        if (pointerDecay <= 0) { pointerActive = false; }

        checkOrigin();
    }

    if (world && !rebuilding) {
        updateCamera(dt);
        const t0 = performance.now();
        if (glOK && !glLost) {
            packParticles();
            renderGL();
        } else {
            renderFallback();
        }
        timings.render = timings.render * 0.9 + (performance.now() - t0) * 0.1;
        updateHUD();
    }
}

// ============================================================================
// 15. BOOT — dynamic ECS import, staged entrance
// ============================================================================
(async function main() {
    resize();
    setBoot(1, "LINKING bitECS CORE");
    try {
        ecs = await import("./math/010_bitECS_core.js");
    } catch (err) {
        console.error("[particle_showcase] ECS core failed to load:", err);
        bootEl.classList.add("gone");
        $("pt-fatal-msg").textContent = "Failed to load ./math/010_bitECS_core.js — " +
            (err && err.message ? err.message : String(err));
        $("pt-fatal").style.display = "flex";
        return;
    }
    initGL();
    randomizeFrameQuat();
    randomizeAttractors();
    randomizeFountains();
    const P0 = PAL_SETS[0];
    vec4.set(colTA, P0[0][0], P0[0][1], P0[0][2], 1);
    vec4.set(colTB, P0[1][0], P0[1][1], P0[1][2], 1);
    vec4.set(colTC, P0[2][0], P0[2][1], P0[2][2], 1);
    await rebuild(null);
    toast("CURTAIN UP · 8 ACTS · AUTO-CYCLE ON", "ok");
    requestAnimationFrame(frame);
})();