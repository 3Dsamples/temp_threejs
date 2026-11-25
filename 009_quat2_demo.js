// file number : 009-D
// full path name : src/009_quat2_demo.js
// description : "DEEP FIELD" — a dual-quaternion asteroid-belt observatory.
//               50,000 rigid bodies (up to 150k) stored purely as quat2 SOA
//               (8 floats : rotation + translation in one primitive) and
//               consumed DIRECTLY by the GPU as vec4+vec4 instance attributes
//               (no per-instance matrices on the hot path). Keplerian motion
//               via quat2.soaFromOrbitalElements on staggered slice views with
//               GPU velocity extrapolation (zero visual stepping, ~2ms CPU).
//               A 16-bone space whale is skinned every frame with dual-quat
//               linear blending (quat2.lerp + normalize + soaTransformPoint +
//               soaGetReal -> quat.soaRotateVec3 for normals), its root driven
//               by quat2.springDamp toward a tappable lure. Floating origin
//               via quat2.soaRecenter (Float64 origin ledger, auto + manual).
//               Export bakes quat2.soaToMat4Chunked -> mat4.soaDecompose ->
//               011 TRS snapshot when 011 is loadable, else an internal
//               DQBL binary codec (graceful degradation, never blocks).
//               Renderer : raw WebGL2/WebGL1 instancing, GLSL100, dramatic
//               key/rim/fill lighting, nebula + god-ray background, additive
//               glow sprites, fog, wireframe mode; Canvas2D fallback if no GL.
//               Full live control deck (9 sliders, 2 selects, 5 toggles,
//               5 actions), damped orbit/zoom/pinch, ambient synth audio with
//               one-touch mute, adaptive slice governor, context-loss repair.
// best for : 3d graphics — validating dual-quaternion pipelines at scale:
//            GPU-friendly 8-float rigid instancing, DQ skinning, spring follow
//            in dual-quat space, orbital fields, floating-origin persistence
//            and small-to-galactic zoom on Android mobile 64-bit at 60 fps.
// license : MIT
//
// topological hierarchy (dependencies first — this file is last):
//   src/math/002_vec2.js   (self-contained)
//   src/math/003_vec3.js   (self-contained)
//   src/math/004_vec4.js   (self-contained)
//   src/math/005_mat2.js   (self-contained)
//   src/math/007_mat4.js   (self-contained)
//   src/math/008_quat.js   (self-contained)
//   src/math/009_quat2.js  (self-contained)  <- star of this demo
//   src/math/010_bitECS_core.js        (optional, transitive via 011)
//   src/math/011_bitECS_serialization.js (optional, dynamic import + fallback)
//   src/009_quat2_demo.js  <- THIS FILE
//
// usage : <script type="module" src="./009_quat2_demo.js"></script>
//         (native ES modules — no vite / no vue / no build / no CDN required)
// ============================================================================

import * as vec2  from "./math/002_vec2.js";
import * as vec3  from "./math/003_vec3.js";
import * as vec4  from "./math/004_vec4.js";
import * as mat2  from "./math/005_mat2.js";
import * as mat4  from "./math/007_mat4.js";
import * as quat  from "./math/008_quat.js";
import * as quat2 from "./math/009_quat2.js";

// Optional link: 011 serialization (pulls 010/006 transitively). If any of
// those modules fail to parse/load on this device, we degrade to the internal
// DQBL codec — the core experience never depends on them.
let ser11 = null;
import("./math/011_bitECS_serialization.js").then(m => { ser11 = m; markLink(); })
    .catch(() => { ser11 = null; markLink(); });

// ============================================================================
// 1. THEMES / CONFIG / STATE
// ============================================================================
const THEMES = {
    ember: { name: "Ember Belt",
        baseA: [1.00, 0.60, 0.23], baseB: [0.98, 0.30, 0.16],
        key: [1.00, 0.78, 0.50], rim: [0.22, 0.90, 1.00], fill: [1.00, 0.24, 0.50],
        fog: [0.035, 0.050, 0.100], whaleA: [0.05, 0.16, 0.22], whaleB: [0.10, 0.50, 0.55],
        glow: [0.35, 0.95, 1.00], acc: "#ffb347", acc2: "#37e6ff", bg: "#05060e" },
    ion: { name: "Ion Storm",
        baseA: [0.25, 0.55, 1.00], baseB: [0.55, 0.85, 1.00],
        key: [0.75, 0.85, 1.00], rim: [1.00, 0.25, 0.75], fill: [0.30, 1.00, 0.90],
        fog: [0.030, 0.040, 0.100], whaleA: [0.06, 0.10, 0.24], whaleB: [0.20, 0.40, 0.90],
        glow: [0.60, 0.80, 1.00], acc: "#4da3ff", acc2: "#ff4dc4", bg: "#04050f" },
    acid: { name: "Acid Reef",
        baseA: [0.55, 1.00, 0.25], baseB: [0.90, 1.00, 0.40],
        key: [1.00, 0.90, 0.50], rim: [0.60, 0.30, 1.00], fill: [1.00, 0.50, 0.20],
        fog: [0.030, 0.070, 0.050], whaleA: [0.04, 0.16, 0.10], whaleB: [0.20, 0.55, 0.25],
        glow: [0.70, 1.00, 0.30], acc: "#b6ff3d", acc2: "#9a5cff", bg: "#04080a" },
    rose: { name: "Void Rose",
        baseA: [1.00, 0.30, 0.60], baseB: [1.00, 0.60, 0.85],
        key: [1.00, 0.70, 0.80], rim: [0.30, 0.95, 1.00], fill: [0.50, 0.40, 1.00],
        fog: [0.080, 0.030, 0.070], whaleA: [0.18, 0.05, 0.14], whaleB: [0.55, 0.15, 0.40],
        glow: [1.00, 0.45, 0.80], acc: "#ff4d9d", acc2: "#37e6ff", bg: "#0a0409" }
};
const MU = 420;
const DEFAULTS = {
    count: 50000, timeScale: 1.0, spread: 1.0, ecc: 0.28, inc: 0.30,
    turb: 0.22, rockScale: 1.0, glow: 1.0, fog: 0.006,
    theme: "ember", quality: "balanced",
    autoOrbit: true, follow: false, wander: true, wireframe: false, autoRecenter: true
};
const S = Object.assign({}, DEFAULTS);
let seed = 20261124;
let paused = false, rebuilding = false, rebuildPct = 0;
let simTime = 0, frameIdx = 0, fpsEma = 60, bakeMs = 0;
let originShifts = 0;
const origin = new Float64Array(3);          // galactic-scale ledger
const QUALITY_DPR = { low: 1, balanced: 1.5, high: 2 };

// ============================================================================
// 2. DOM + STYLE (self-contained art direction, custom scrollbars)
// ============================================================================
const root = document.createElement("div");
root.id = "dq-deepfield";
root.innerHTML = `
<style>
#dq-deepfield{position:fixed;inset:0;display:flex;flex-direction:column;background:var(--bg);
  --bg:#05060e;--surface:rgba(10,14,26,.86);--line:rgba(120,160,255,.16);--text:#dfe8ff;
  --dim:#7d8bb0;--acc:#ffb347;--acc2:#37e6ff;--ok:#b6ff3d;--warn:#ffd23d;--danger:#ff3d81;
  font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text);
  overflow:hidden;transition:background .6s}
#dq-deepfield *{box-sizing:border-box;margin:0}
#dq-top{height:48px;flex:0 0 48px;display:flex;align-items:center;gap:14px;padding:0 16px;
  background:linear-gradient(90deg,rgba(8,10,20,.95),rgba(14,18,34,.9));
  border-bottom:1px solid var(--line);z-index:20;animation:dqDrop .7s cubic-bezier(.2,.9,.25,1) both}
#dq-top h1{font-size:14px;letter-spacing:.28em;font-weight:700;
  background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;
  background-clip:text;color:transparent;white-space:nowrap}
#dq-top .sub{color:var(--dim);font-size:10px;letter-spacing:.14em;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
#dq-top .sp{flex:1}
.dq-chip{font-size:10px;padding:3px 9px;border:1px solid var(--line);border-radius:99px;
  color:var(--dim);letter-spacing:.1em;white-space:nowrap}
.dq-chip.on{color:var(--ok);border-color:rgba(182,255,61,.35)}
#dq-mute{cursor:pointer;user-select:none;font-size:11px;padding:6px 12px;border-radius:8px;
  border:1px solid var(--line);background:rgba(20,26,46,.7);color:var(--acc2);letter-spacing:.08em;
  transition:all .2s}
#dq-mute:hover{border-color:var(--acc2);box-shadow:0 0 14px rgba(55,230,255,.25)}
#dq-main{flex:1;display:flex;min-height:0}
#dq-stage{flex:1;position:relative;min-width:0;background:#000}
#dq-gl,#dq-fb{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;
  cursor:grab}
#dq-gl:active{cursor:grabbing}
#dq-fb{display:none}
#dq-hud{position:absolute;top:12px;left:12px;pointer-events:none;font-size:10.5px;
  color:var(--acc2);text-shadow:0 1px 3px #000;white-space:pre;letter-spacing:.05em;
  background:linear-gradient(180deg,rgba(5,8,16,.55),transparent);padding:8px 12px 14px;
  border-left:2px solid var(--acc);animation:dqFade 1.2s .3s both}
#dq-compass{position:absolute;top:12px;right:12px;width:52px;height:52px;pointer-events:none;opacity:.9}
#dq-boot{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:14px;background:radial-gradient(ellipse at 50% 60%,rgba(20,26,50,.9),rgba(3,4,10,.97));
  z-index:15;transition:opacity .8s;letter-spacing:.3em;font-size:11px;color:var(--acc)}
#dq-boot .bar{width:min(320px,70%);height:3px;background:rgba(120,160,255,.12);border-radius:2px;overflow:hidden}
#dq-boot .bar i{display:block;height:100%;width:0%;background:linear-gradient(90deg,var(--acc),var(--acc2));
  transition:width .15s;box-shadow:0 0 12px var(--acc2)}
#dq-boot.gone{opacity:0;pointer-events:none}
#dq-hint{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);pointer-events:none;
  font-size:10px;color:var(--dim);letter-spacing:.18em;background:rgba(5,8,16,.6);
  padding:6px 14px;border-radius:99px;border:1px solid var(--line);animation:dqFade 1s 1.2s both;
  white-space:nowrap}
#dq-panel{width:308px;flex:0 0 308px;background:var(--surface);border-left:1px solid var(--line);
  overflow-y:auto;overflow-x:hidden;padding:14px 16px 22px;z-index:10;
  backdrop-filter:blur(10px);animation:dqSlide .7s .15s cubic-bezier(.2,.9,.25,1) both;
  scrollbar-width:thin;scrollbar-color:var(--acc) rgba(120,160,255,.07)}
#dq-panel::-webkit-scrollbar{width:10px}
#dq-panel::-webkit-scrollbar-track{background:linear-gradient(180deg,rgba(120,160,255,.05),rgba(120,160,255,.1));border-radius:5px}
#dq-panel::-webkit-scrollbar-thumb{background:linear-gradient(180deg,var(--acc),var(--acc2));border-radius:5px;border:2px solid rgba(5,8,16,.8)}
#dq-panel::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,var(--acc2),var(--acc))}
.dq-sec{margin:16px 0 8px;font-size:9.5px;letter-spacing:.3em;color:var(--dim);
  display:flex;align-items:center;gap:8px}
.dq-sec::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
.dq-sec b{color:var(--acc);font-weight:700}
.dq-row{margin:9px 0}
.dq-row label{display:flex;justify-content:space-between;font-size:10.5px;color:var(--text);
  letter-spacing:.06em;margin-bottom:5px}
.dq-row label output{color:var(--acc2);font-weight:700}
.dq-row input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:22px;background:transparent;cursor:pointer}
.dq-row input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;
  background:linear-gradient(90deg,var(--acc),var(--acc2));box-shadow:0 0 8px rgba(55,230,255,.2)}
.dq-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;
  margin-top:-5.5px;border-radius:50%;background:#0a0e1a;border:2px solid var(--acc2);
  box-shadow:0 0 10px var(--acc2);transition:transform .15s}
.dq-row input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.25)}
.dq-row input[type=range]::-moz-range-track{height:4px;border-radius:2px;background:linear-gradient(90deg,var(--acc),var(--acc2))}
.dq-row input[type=range]::-moz-range-thumb{width:13px;height:13px;border-radius:50%;background:#0a0e1a;border:2px solid var(--acc2)}
.dq-sel{width:100%;padding:8px 10px;background:rgba(16,22,40,.9);color:var(--text);
  border:1px solid var(--line);border-radius:8px;font:inherit;font-size:11.5px;cursor:pointer;outline:none}
.dq-sel:focus{border-color:var(--acc2)}
.dq-tog{display:flex;align-items:center;justify-content:space-between;padding:7px 0;
  font-size:11px;letter-spacing:.06em;cursor:pointer;user-select:none}
.dq-tog .sw{width:36px;height:19px;border-radius:99px;background:rgba(120,160,255,.14);
  border:1px solid var(--line);position:relative;transition:all .2s;flex:0 0 36px}
.dq-tog .sw::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;
  border-radius:50%;background:var(--dim);transition:all .2s}
.dq-tog.on .sw{background:linear-gradient(90deg,var(--acc),var(--acc2));border-color:transparent}
.dq-tog.on .sw::after{left:19px;background:#06080f}
.dq-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.dq-btn{padding:10px 6px;border-radius:9px;border:1px solid var(--line);cursor:pointer;
  background:linear-gradient(180deg,rgba(24,32,58,.9),rgba(12,16,30,.9));color:var(--text);
  font:inherit;font-size:10.5px;letter-spacing:.12em;transition:all .18s;text-align:center}
.dq-btn:hover{border-color:var(--acc);color:var(--acc);box-shadow:0 0 16px rgba(255,179,71,.2);transform:translateY(-1px)}
.dq-btn:active{transform:translateY(0)}
.dq-btn.pri{grid-column:1/-1;border-color:rgba(55,230,255,.4);color:var(--acc2)}
.dq-btn.pri:hover{box-shadow:0 0 18px rgba(55,230,255,.3)}
.dq-btn[disabled]{opacity:.45;pointer-events:none}
.dq-keys{margin-top:14px;font-size:9.5px;color:var(--dim);letter-spacing:.08em;line-height:1.9}
.dq-keys b{color:var(--acc2);font-weight:700}
.dq-stack{margin-top:12px;font-size:9px;color:var(--dim);letter-spacing:.1em;line-height:1.8;
  border-top:1px dashed var(--line);padding-top:10px}
.dq-stack .ok{color:var(--ok)} .dq-stack .fb{color:var(--warn)}
#dq-toasts{position:absolute;left:14px;bottom:14px;display:flex;flex-direction:column;gap:8px;z-index:30;pointer-events:none}
.dq-toast{padding:9px 14px;font-size:11px;letter-spacing:.06em;background:rgba(8,12,24,.92);
  border:1px solid var(--line);border-left:3px solid var(--acc2);border-radius:8px;
  animation:dqToast .3s cubic-bezier(.2,.9,.3,1.2) both;box-shadow:0 6px 24px rgba(0,0,0,.5)}
.dq-toast.ok{border-left-color:var(--ok)} .dq-toast.warn{border-left-color:var(--warn)}
.dq-toast.err{border-left-color:var(--danger)}
.dq-toast.out{animation:dqToastOut .3s both}
@keyframes dqDrop{from{transform:translateY(-100%);opacity:0}to{transform:none;opacity:1}}
@keyframes dqSlide{from{transform:translateX(40px);opacity:0}to{transform:none;opacity:1}}
@keyframes dqFade{from{opacity:0}to{opacity:1}}
@keyframes dqToast{from{transform:translateX(-24px);opacity:0}to{transform:none;opacity:1}}
@keyframes dqToastOut{to{transform:translateX(-24px);opacity:0}}
@media (max-width:860px){
  #dq-main{flex-direction:column}
  #dq-panel{width:100%;flex:0 0 40vh;border-left:none;border-top:1px solid var(--line);
    animation:dqDrop .6s .1s both}
  #dq-top .sub{display:none}
  #dq-hint{display:none}
  #dq-hud{font-size:9.5px}
}
@media (prefers-reduced-motion:reduce){
  #dq-deepfield *{animation-duration:.01s!important}
}
</style>
<div id="dq-top">
  <h1>DEEP FIELD</h1>
  <span class="sub">DUAL-QUATERNION BELT OBSERVATORY · 009_quat2</span>
  <span class="sp"></span>
  <span class="dq-chip" id="dq-glchip">GL…</span>
  <span class="dq-chip" id="dq-linkchip">011 …</span>
  <span id="dq-mute">♪ SOUND ON</span>
</div>
<div id="dq-main">
  <div id="dq-stage">
    <canvas id="dq-gl"></canvas>
    <canvas id="dq-fb"></canvas>
    <div id="dq-hud"></div>
    <canvas id="dq-compass" width="52" height="52"></canvas>
    <div id="dq-boot"><span>CALIBRATING FIELD</span><div class="bar"><i id="dq-bootbar"></i></div><span id="dq-bootpct">0%</span></div>
    <div id="dq-hint">DRAG ORBIT · WHEEL / PINCH ZOOM · TAP SETS THE WHALE'S LURE</div>
    <div id="dq-toasts"></div>
  </div>
  <div id="dq-panel"></div>
</div>`;
function mount() { document.body.appendChild(root); }
if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", mount); } else { mount(); }

const $ = id => root.querySelector("#" + id);
const stage = $("dq-stage"), glCanvas = $("dq-gl"), fbCanvas = $("dq-fb");
const hudEl = $("dq-hud"), bootEl = $("dq-boot"), bootBar = $("dq-bootbar"), bootPct = $("dq-bootpct");
const panel = $("dq-panel"), toasts = $("dq-toasts");
const compCtx = $("dq-compass").getContext("2d");
const fbCtx = fbCanvas.getContext("2d");

function toast(msg, kind) {
    const t = document.createElement("div");
    t.className = "dq-toast " + (kind || "");
    t.textContent = msg;
    toasts.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 320); }, 2600);
}
function markLink() {
    const c = $("dq-linkchip");
    if (!c) { return; }
    c.textContent = ser11 ? "011 LINKED" : "011 FALLBACK";
    c.classList.toggle("on", !!ser11);
}
function applyThemeCSS() {
    const th = THEMES[S.theme];
    root.style.setProperty("--acc", th.acc);
    root.style.setProperty("--acc2", th.acc2);
    root.style.setProperty("--bg", th.bg);
}

// ============================================================================
// 3. POOLED TEMPORARIES (zero-GC hot path)
// ============================================================================
const T = {
    view: mat4.acquire(), proj: mat4.acquire(), vp: mat4.acquire(), inv: mat4.acquire(),
    eye: vec3.create(), target: vec3.fromValues(0, 0, 0), targetGoal: vec3.create(),
    targetVel: vec3.create(), up: vec3.fromValues(0, 1, 0),
    fwd: vec3.create(), right: vec3.create(), cup: vec3.create(),
    v3a: vec3.create(), v3b: vec3.create(), v3c: vec3.create(),
    dqT: quat2.acquire(), dqL: quat2.acquire(), dqTmp: quat2.acquire(),
    q1: quat.create(), m2: mat2.create(), ptr: vec2.create(), ptrLast: vec2.create(),
    col: vec4.create()
};
const KEY_DIR  = vec3.normalize(vec3.create(), vec3.fromValues(-0.55, 0.62, 0.42));
const FILL_DIR = vec3.normalize(vec3.create(), vec3.fromValues(0.6, -0.25, -0.7));

// deterministic PRNG (mulberry32) — seeded, reproducible fields
function prng(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function yieldMain() { return new Promise(r => setTimeout(r, 0)); }

// ============================================================================
// 4. BELT STATE — pure dual-quaternion SOA + staggered slice baking
// ============================================================================
let N = 0, SLICES = 8, sliceSize = 0;
let belt = null, prevPos = null, velSOA = null, metaSOA = null;
let elA = null, elE = null, elM = null, elInc = null, elOm = null, elW = null, elN = null;
let bakeTime = null, lastBake = null, sliceViews = null, staging = null;
let beacons = new Uint32Array(0), beaconCount = 48;

function dqView(soa, s, e) {
    const v = {
        x1: soa.x1.subarray(s, e), y1: soa.y1.subarray(s, e), z1: soa.z1.subarray(s, e), w1: soa.w1.subarray(s, e),
        x2: soa.x2.subarray(s, e), y2: soa.y2.subarray(s, e), z2: soa.z2.subarray(s, e), w2: soa.w2.subarray(s, e),
        count: e - s
    };
    v.arrays = [v.x1, v.y1, v.z1, v.w1, v.x2, v.y2, v.z2, v.w2];
    return v;
}
function v3View(soa, s, e) {
    return { x: soa.x.subarray(s, e), y: soa.y.subarray(s, e), z: soa.z.subarray(s, e), count: e - s };
}

function allocBelt(count) {
    N = count;
    SLICES = Math.max(8, Math.ceil(N / 4000));
    sliceSize = Math.ceil(N / SLICES);
    belt = quat2.createQuat2SOA(N);
    quat2.soaIdentity(belt);
    prevPos = vec3.createVec3SOA(N);
    velSOA = vec3.createVec3SOA(N);
    metaSOA = vec4.createVec4SOA(N);
    elA = new Float32Array(N); elE = new Float32Array(N); elM = new Float32Array(N);
    elInc = new Float32Array(N); elOm = new Float32Array(N); elW = new Float32Array(N);
    elN = new Float32Array(N);
    bakeTime = new Float32Array(N);
    lastBake = new Float64Array(SLICES);
    sliceViews = new Array(SLICES);
    staging = new Float32Array(sliceSize * 12);
    for (let s = 0; s < SLICES; s++) {
        const a = s * sliceSize, b = Math.min(a + sliceSize, N);
        sliceViews[s] = {
            a, b, dq: dqView(belt, a, b), pos: v3View(prevPos, a, b),
            ea: elA.subarray(a, b), ee: elE.subarray(a, b), em: elM.subarray(a, b),
            ei: elInc.subarray(a, b), eo: elOm.subarray(a, b), ew: elW.subarray(a, b)
        };
    }
    const nb = Math.min(beaconCount, N);
    beacons = new Uint32Array(nb);
    for (let i = 0; i < nb; i++) { beacons[i] = (i * 7919 + 13) % N; }
}

function seedElements() {
    const rng = prng(seed);
    for (let i = 0; i < N; i++) {
        const a = (8 + rng() * 38) * S.spread;
        elA[i] = a;
        elE[i] = Math.pow(rng(), 1.6) * S.ecc;
        elM[i] = rng() * Math.PI * 2;
        elInc[i] = (rng() - 0.5) * S.inc;
        elOm[i] = rng() * Math.PI * 2;
        elW[i] = rng() * Math.PI * 2;
        elN[i] = Math.sqrt(MU / (a * a * a));
        metaSOA.x[i] = 0.18 + rng() * 0.37;              // scale
        metaSOA.y[i] = rng();                            // hue seed
        metaSOA.z[i] = rng() < 0.055 ? 0.6 + rng() * 0.9 : 0.04; // emissive
        metaSOA.w[i] = rng();                            // phase
    }
}

// pack one slice into interleaved staging + upload
function packSlice(s) {
    const v = sliceViews[s], n = v.b - v.a;
    const X1 = belt.x1, Y1 = belt.y1, Z1 = belt.z1, W1 = belt.w1;
    const X2 = belt.x2, Y2 = belt.y2, Z2 = belt.z2, W2 = belt.w2;
    const vx = velSOA.x, vy = velSOA.y, vz = velSOA.z;
    let o = 0;
    for (let i = v.a; i < v.b; i++) {
        staging[o] = X1[i]; staging[o + 1] = Y1[i]; staging[o + 2] = Z1[i]; staging[o + 3] = W1[i];
        staging[o + 4] = X2[i]; staging[o + 5] = Y2[i]; staging[o + 6] = Z2[i]; staging[o + 7] = W2[i];
        staging[o + 8] = vx[i]; staging[o + 9] = vy[i]; staging[o + 10] = vz[i]; staging[o + 11] = bakeTime[i];
        o += 12;
    }
    if (glOK) {
        gl.bindBuffer(gl.ARRAY_BUFFER, bufInstDyn);
        gl.bufferSubData(gl.ARRAY_BUFFER, v.a * 48, staging.subarray(0, n * 12));
    }
}

function bakeSlice(s, elapsed) {
    const v = sliceViews[s];
    if (v.b <= v.a) { return; }
    const em = v.em, en = elN;
    for (let i = v.a; i < v.b; i++) { em[i - v.a] += en[i] * elapsed; }
    // ★ the heart of the demo: 1M-capable orbital dual-quats on a slice view
    quat2.soaFromOrbitalElements(v.dq, v.ea, v.ee, em, v.ei, v.eo, v.ew);
    const tmpPos = v3View(T_bakePos, v.a, v.b);
    quat2.soaGetTranslation(tmpPos, v.dq);
    const inv = elapsed > 1e-5 ? 1 / elapsed : 0;
    const px = prevPos.x, py = prevPos.y, pz = prevPos.z;
    const vx = velSOA.x, vy = velSOA.y, vz = velSOA.z;
    for (let i = v.a; i < v.b; i++) {
        const nx = tmpPos.x[i - v.a], ny = tmpPos.y[i - v.a], nz = tmpPos.z[i - v.a];
        vx[i] = (nx - px[i]) * inv; vy[i] = (ny - py[i]) * inv; vz[i] = (nz - pz[i]) * inv;
        px[i] = nx; py[i] = ny; pz[i] = nz;
        bakeTime[i] = simTime;
    }
    lastBake[s] = simTime;
    packSlice(s);
}
const T_bakePos = vec3.createVec3SOA(200000); // shared scratch (>= max count)

async function rebuildBelt(reason) {
    if (rebuilding) { return; }
    rebuilding = true; rebuildPct = 0;
    bootEl.classList.remove("gone");
    allocBelt(S.count);
    seedElements();
    if (glOK) { reallocInstanceBuffers(); }
    for (let s = 0; s < SLICES; s++) {
        bakeSlice(s, 0);
        rebuildPct = Math.round(((s + 1) / SLICES) * 100);
        bootBar.style.width = rebuildPct + "%";
        bootPct.textContent = rebuildPct + "%";
        await yieldMain();
    }
    rebuilding = false;
    bootEl.classList.add("gone");
    if (reason) { toast(reason + " · " + N.toLocaleString() + " bodies", "ok"); }
}

// ============================================================================
// 5. SPACE WHALE — dual-quat linear-blend skinning (009 showcase)
// ============================================================================
const BONES = 16, RING = 10, SEG_LEN = 0.62;
const PROFILE = [0.30, 0.46, 0.55, 0.58, 0.56, 0.52, 0.47, 0.42, 0.36, 0.30, 0.24, 0.19, 0.14, 0.10, 0.07, 0.045];
const whaleRoot = quat2.create();
quat2.fromTranslation(whaleRoot, [6, 2, 0]);
const rootVel = new Float32Array(8);
const boneDQ = new Float32Array(BONES * 8);
const boneViews = [];
for (let i = 0; i < BONES; i++) { boneViews.push(boneDQ.subarray(i * 8, i * 8 + 8)); }
const lure = vec3.fromValues(10, 3, 6);
let lureManual = false, singT = 0, singPulse = 0;

// bind mesh
const bindList = [], nrmList = [], glowList = [], wA = [], wB = [], wW = [];
function addVert(x, y, z, nx, ny, nz, g, b0, b1, w) {
    bindList.push(x, y, z); nrmList.push(nx, ny, nz); glowList.push(g);
    wA.push(b0); wB.push(b1); wW.push(w);
}
(function buildWhale() {
    for (let s = 0; s < BONES; s++) {
        const r = PROFILE[s];
        for (let k = 0; k < RING; k++) {
            const a = (k / RING) * Math.PI * 2;
            const cy = Math.cos(a), sz = Math.sin(a);
            const stripe = (s % 3 === 0 && cy > 0.55) ? 0.85 : 0.10;
            addVert(0, cy * r, sz * r, 0, cy, sz, stripe, s, Math.max(0, s - 1), s === 0 ? 0 : 0.3);
        }
    }
    // nose tip + tail tip
    addVert(0.52, 0, 0, 1, 0, 0, 0.3, 0, 0, 0);
    addVert(-0.42, 0, 0, -1, 0, 0, 0.5, BONES - 1, BONES - 1, 0);
    // tail fluke (horizontal, swishes with yaw wave)
    addVert(-0.15, 0, 0.62, 0, 1, 0, 0.6, BONES - 1, BONES - 2, 0.2);
    addVert(-0.55, 0, 0.34, 0, 1, 0, 0.4, BONES - 1, BONES - 2, 0.2);
    addVert(-0.15, 0, -0.62, 0, 1, 0, 0.6, BONES - 1, BONES - 2, 0.2);
    addVert(-0.55, 0, -0.34, 0, 1, 0, 0.4, BONES - 1, BONES - 2, 0.2);
    // dorsal + pectorals
    addVert(-0.1, 0.62, 0, 0, 0.6, 0.8, 0.5, 4, 3, 0.3);
    addVert(-0.45, 0.30, 0, 0, 0.6, 0.8, 0.3, 4, 3, 0.3);
    addVert(-0.1, -0.1, 0.66, 0, -0.3, 0.9, 0.45, 3, 2, 0.3);
    addVert(-0.1, -0.1, -0.66, 0, -0.3, -0.9, 0.45, 3, 2, 0.3);
    // eyes
    addVert(0.16, 0.14, 0.30, 0.3, 0.3, 0.9, 1.0, 1, 0, 0.2);
    addVert(0.16, 0.14, -0.30, 0.3, 0.3, -0.9, 1.0, 1, 0, 0.2);
})();
const VCOUNT = glowList.length;
const NOSE = BONES * RING, TAIL = NOSE + 1, FLK = TAIL + 1, DOR = FLK + 4, PEC = DOR + 2, EYE = PEC + 2;
const bindPos = vec3.createVec3SOA(VCOUNT);
const bindNrm = vec3.createVec3SOA(VCOUNT);
const worldPos = vec3.createVec3SOA(VCOUNT);
const worldNrm = vec3.createVec3SOA(VCOUNT);
const vertDQ = quat2.createQuat2SOA(VCOUNT);
const vertReal = quat.createQuatSOA(VCOUNT);
const vertGlow = new Float32Array(glowList);
for (let i = 0; i < VCOUNT; i++) {
    bindPos.x[i] = bindList[i * 3]; bindPos.y[i] = bindList[i * 3 + 1]; bindPos.z[i] = bindList[i * 3 + 2];
    bindNrm.x[i] = nrmList[i * 3]; bindNrm.y[i] = nrmList[i * 3 + 1]; bindNrm.z[i] = nrmList[i * 3 + 2];
}
const whaleIdx = (function () {
    const idx = [];
    for (let s = 0; s < BONES - 1; s++) {
        for (let k = 0; k < RING; k++) {
            const a = s * RING + k, b = s * RING + (k + 1) % RING;
            const c = (s + 1) * RING + k, d = (s + 1) * RING + (k + 1) % RING;
            idx.push(a, c, b, b, c, d);
        }
    }
    for (let k = 0; k < RING; k++) { idx.push(NOSE, (k + 1) % RING, k); }
    for (let k = 0; k < RING; k++) {
        const a = (BONES - 1) * RING + k, b = (BONES - 1) * RING + (k + 1) % RING;
        idx.push(TAIL, a, b);
    }
    idx.push(FLK, FLK + 1, TAIL, FLK + 2, TAIL, FLK + 3);
    idx.push(DOR, DOR + 1, 4 * RING + 2);
    idx.push(PEC, 3 * RING + 0, PEC + 1);
    idx.push(EYE, 1 * RING + 1, EYE + 1);
    return new Uint16Array(idx);
})();
const whaleStaging = new Float32Array(VCOUNT * 7);

function updateWhale(dt, t) {
    // lure: wander path or manual tap point
    if (!lureManual && S.wander) {
        lure[0] = Math.sin(t * 0.21) * 26; lure[1] = 3 + Math.sin(t * 0.34) * 7; lure[2] = Math.cos(t * 0.17) * 26;
    }
    quat2.getTranslation(T.v3a, whaleRoot);
    vec3.subtract(T.v3b, lure, T.v3a);
    const d = vec3.length(T.v3b);
    const speed = Math.min(7.5, d * 1.1);
    if (d > 1e-4) { vec3.scale(T.v3b, T.v3b, speed / d); }
    vec3.scaleAndAdd(T.v3c, T.v3a, T.v3b, dt);
    if (speed > 0.05) { quat2.fromVelocityTranslation(T.dqT, T.v3b, T.v3c); }
    else { quat2.lookAtDQ(T.dqT, T.v3c, lure, T.up); }
    // ★ spring in dual-quat space: orientation lags organically behind velocity
    quat2.springDamp(whaleRoot, whaleRoot, T.dqT, rootVel, 0.42, dt, 30);

    // FK chain via flat dual-quat composition
    quat2.copy(boneViews[0], whaleRoot);
    for (let i = 1; i < BONES; i++) {
        const yaw = Math.sin(t * 2.3 - i * 0.55) * 0.20 * (0.4 + speed * 0.1);
        const pitch = Math.sin(t * 1.7 - i * 0.4) * 0.07;
        quat.setAxisAngle(T.q1, [0, 1, 0], yaw);
        quat.rotateX(T.q1, T.q1, pitch);
        T.v3a[0] = -SEG_LEN; T.v3a[1] = 0; T.v3a[2] = 0;
        quat2.fromRotationTranslation(T.dqL, T.q1, T.v3a);
        quat2.multiply(boneViews[i], boneViews[i - 1], T.dqL);
    }
    // ★ dual-quat linear blend skinning: lerp (antipodal-safe) + normalize
    for (let i = 0; i < VCOUNT; i++) {
        quat2.lerp(T.dqTmp, boneViews[wA[i]], boneViews[wB[i]], wW[i]);
        quat2.normalize(T.dqTmp, T.dqTmp);
        quat2.soaSet(vertDQ, i, T.dqTmp);
    }
    quat2.soaTransformPoint(worldPos, vertDQ, bindPos);
    quat2.soaGetReal(vertReal, vertDQ);
    quat.soaRotateVec3(worldNrm, vertReal, bindNrm);

    // pack + upload
    let o = 0;
    for (let i = 0; i < VCOUNT; i++) {
        whaleStaging[o] = worldPos.x[i]; whaleStaging[o + 1] = worldPos.y[i]; whaleStaging[o + 2] = worldPos.z[i];
        whaleStaging[o + 3] = worldNrm.x[i]; whaleStaging[o + 4] = worldNrm.y[i]; whaleStaging[o + 5] = worldNrm.z[i];
        whaleStaging[o + 6] = vertGlow[i];
        o += 7;
    }
    if (glOK) {
        gl.bindBuffer(gl.ARRAY_BUFFER, bufWhale);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, whaleStaging);
    }
    // occasional song — sound tied to a visible glow pulse
    singT -= dt;
    if (singT <= 0) { singT = 8 + Math.random() * 6; singPulse = 1; audio.whaleSong(); }
    singPulse = Math.max(0, singPulse - dt * 0.7);
}

// ============================================================================
// 6. CAMERA — damped orbit / zoom / pinch / follow
// ============================================================================
const cam = { yaw: 0.9, pitch: 0.42, dist: 62, yawT: 0.9, pitchT: 0.42, distT: 62 };
let W = 2, H = 2, DPR = 1;
const FOV = 55 * Math.PI / 180;

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
    if (S.autoOrbit && !dragging) { cam.yawT += dt * 0.045; }
    const k = 1 - Math.exp(-dt * 8);
    cam.yaw += (cam.yawT - cam.yaw) * k;
    cam.pitch += (cam.pitchT - cam.pitch) * k;
    cam.dist += (cam.distT - cam.dist) * k;
    if (S.follow) { quat2.getTranslation(T.targetGoal, whaleRoot); }
    else { vec3.set(T.targetGoal, 0, 0, 0); }
    vec3.springDamp3(T.target, T.target, T.targetGoal, T.targetVel, 0.35, dt, 120);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    T.eye[0] = T.target[0] + cam.dist * cp * Math.sin(cam.yaw);
    T.eye[1] = T.target[1] + cam.dist * sp;
    T.eye[2] = T.target[2] + cam.dist * cp * Math.cos(cam.yaw);
    mat4.lookAt(T.view, T.eye, T.target, T.up);
    mat4.perspectiveNO(T.proj, FOV, W / H, 0.1, 900);
    mat4.multiply(T.vp, T.proj, T.view);
    mat4.invert(T.inv, T.view);
    T.right[0] = T.inv[0]; T.right[1] = T.inv[1]; T.right[2] = T.inv[2];
    T.cup[0] = T.inv[4]; T.cup[1] = T.inv[5]; T.cup[2] = T.inv[6];
    T.fwd[0] = -T.inv[8]; T.fwd[1] = -T.inv[9]; T.fwd[2] = -T.inv[10];
    // auto floating origin — seamless small-to-galactic
    if (S.autoRecenter) {
        const m = Math.abs(T.target[0]) + Math.abs(T.target[1]) + Math.abs(T.target[2]);
        if (m > 1500) { recenterOrigin(); }
    }
}

function pointerToWorld(nx, ny, out) {
    const tanF = Math.tan(FOV / 2), tanA = tanF * (W / H), d = cam.dist;
    out[0] = T.eye[0] + T.fwd[0] * d + T.right[0] * nx * d * tanA + T.cup[0] * ny * d * tanF;
    out[1] = T.eye[1] + T.fwd[1] * d + T.right[1] * nx * d * tanA + T.cup[1] * ny * d * tanF;
    out[2] = T.eye[2] + T.fwd[2] * d + T.right[2] * nx * d * tanA + T.cup[2] * ny * d * tanF;
    return out;
}

// ============================================================================
// 7. FLOATING ORIGIN — quat2.soaRecenter over the whole field
// ============================================================================
function recenterOrigin() {
    const sx = T.target[0], sy = T.target[1], sz = T.target[2];
    if (Math.abs(sx) + Math.abs(sy) + Math.abs(sz) < 1) { return; }
    quat2.soaRecenter(belt, belt, sx, sy, sz);
    for (let i = 0; i < N; i++) {
        prevPos.x[i] -= sx; prevPos.y[i] -= sy; prevPos.z[i] -= sz;
    }
    for (let s = 0; s < SLICES; s++) { packSlice(s); }
    quat2.getTranslation(T.v3a, whaleRoot);
    T.v3a[0] -= sx; T.v3a[1] -= sy; T.v3a[2] -= sz;
    quat2.fromRotationTranslation(whaleRoot, whaleRoot, T.v3a);
    lure[0] -= sx; lure[1] -= sy; lure[2] -= sz;
    T.target[0] -= sx; T.target[1] -= sy; T.target[2] -= sz;
    T.targetGoal[0] -= sx; T.targetGoal[1] -= sy; T.targetGoal[2] -= sz;
    origin[0] += sx; origin[1] += sy; origin[2] += sz;
    originShifts++;
    toast("ORIGIN RECENTERED · Δ " + Math.round(Math.hypot(sx, sy, sz)) + " km", "ok");
    audio.blip(660); audio.blip(990);
}

// ============================================================================
// 8. WEBGL RENDERER — instanced dual-quaternion pipeline
// ============================================================================
let gl = null, glOK = false, glLost = false, isGL2 = false, angleExt = null;
let progRock, progWhale, progGlow, progBG;
let bufRock, bufWire, bufBG, bufInstStatic, bufInstDyn, bufWhale, bufWhaleIdx, bufGlow;
const glowStaging = new Float32Array((BONES + 2 + 64) * 7);
let glowCount = 0;

const VS_COMMON = `
vec3 rotQ(vec4 q, vec3 v){ return v + 2.0*cross(q.xyz, cross(q.xyz,v) + q.w*v); }
vec3 dqT(vec4 r, vec4 d){ return 2.0*(r.w*d.xyz - d.w*r.xyz + cross(r.xyz,d.xyz)); }
`;
const ROCK_VS = `
precision highp float;
attribute vec3 a_pos; attribute vec3 a_nrm;
attribute vec4 a_dqR; attribute vec4 a_dqD; attribute vec3 a_vel; attribute float a_bake;
attribute vec4 a_meta;
uniform mat4 u_vp; uniform float u_time, u_turb, u_scale;
varying vec3 v_nrm; varying vec3 v_world; varying float v_hue; varying float v_emis; varying float v_depth;
${VS_COMMON}
void main(){
  vec3 p = rotQ(a_dqR, a_pos * a_meta.x * u_scale);
  vec3 n = rotQ(a_dqR, a_nrm);
  vec3 t = dqT(a_dqR, a_dqD) + a_vel * (u_time - a_bake);
  vec3 w = p + t + n * sin(u_time*1.3 + a_meta.w*6.2831 + t.x*0.15) * u_turb * a_meta.x;
  v_nrm = n; v_world = w; v_hue = a_meta.y; v_emis = a_meta.z;
  vec4 cp = u_vp * vec4(w, 1.0);
  v_depth = cp.w;
  gl_Position = cp;
}`;
const ROCK_FS = `
precision highp float;
varying vec3 v_nrm; varying vec3 v_world; varying float v_hue; varying float v_emis; varying float v_depth;
uniform vec3 u_cam, u_keyDir, u_fillDir, u_key, u_rim, u_fill, u_baseA, u_baseB, u_fog;
uniform float u_fogD, u_glow, u_wire;
void main(){
  vec3 n = normalize(v_nrm);
  vec3 V = normalize(u_cam - v_world);
  vec3 base = mix(u_baseA, u_baseB, v_hue);
  if (u_wire > 0.5) {
    vec3 wc = mix(u_rim, u_baseA, v_hue) * 1.3;
    float wf = 1.0 - exp(-v_depth * u_fog * 1.6);
    gl_FragColor = vec4(mix(wc, u_fog, wf), 1.0); return;
  }
  float key = max(dot(n, u_keyDir), 0.0);
  float fill = max(dot(n, u_fillDir), 0.0);
  float ndv = max(dot(n, V), 0.0);
  float rim = pow(1.0 - ndv, 3.0);
  vec3 H = normalize(u_keyDir + V);
  float spec = pow(max(dot(n, H), 0.0), 26.0) * 0.4;
  float hemi = 0.16 + 0.10 * (n.y * 0.5 + 0.5);
  vec3 col = base * (hemi + key * 1.2) * u_key + base * fill * 0.35 * u_fill
           + u_rim * rim * 0.85 + u_key * spec
           + base * v_emis * u_glow * 1.7;
  float f = 1.0 - exp(-v_depth * u_fogD);
  col = mix(col, u_fog, clamp(f, 0.0, 1.0));
  col = pow(col / (1.0 + col), vec3(0.85));
  gl_FragColor = vec4(col, 1.0);
}`;
const WHALE_VS = `
precision highp float;
attribute vec3 a_pos; attribute vec3 a_nrm; attribute float a_glow;
uniform mat4 u_vp;
varying vec3 v_nrm; varying vec3 v_world; varying float v_glow; varying float v_depth;
void main(){
  v_nrm = a_nrm; v_world = a_pos; v_glow = a_glow;
  vec4 cp = u_vp * vec4(a_pos, 1.0);
  v_depth = cp.w; gl_Position = cp;
}`;
const WHALE_FS = `
precision highp float;
varying vec3 v_nrm; varying vec3 v_world; varying float v_glow; varying float v_depth;
uniform vec3 u_cam, u_keyDir, u_key, u_rim, u_whaleA, u_whaleB, u_glowCol, u_fog;
uniform float u_fogD, u_glow, u_time, u_sing;
void main(){
  vec3 n = normalize(v_nrm);
  vec3 V = normalize(u_cam - v_world);
  float key = max(dot(n, u_keyDir), 0.0);
  float rim = pow(1.0 - max(dot(n, V), 0.0), 2.2);
  float pulse = 0.75 + 0.25 * sin(u_time * 2.6 + v_world.x * 0.8);
  vec3 base = mix(u_whaleA, u_whaleB, n.y * 0.5 + 0.5);
  vec3 col = base * (0.22 + key * 1.1) * u_key
           + u_rim * rim * 1.1
           + u_glowCol * v_glow * pulse * (u_glow * 1.4 + u_sing * 2.2);
  float f = 1.0 - exp(-v_depth * u_fogD);
  col = mix(col, u_fog, clamp(f, 0.0, 1.0));
  col = pow(col / (1.0 + col), vec3(0.85));
  gl_FragColor = vec4(col, 1.0);
}`;
const GLOW_VS = `
precision highp float;
attribute vec3 a_pos; attribute float a_size; attribute vec3 a_col;
uniform mat4 u_vp; uniform float u_dpr;
varying vec3 v_col;
void main(){
  vec4 cp = u_vp * vec4(a_pos, 1.0);
  gl_Position = cp;
  gl_PointSize = clamp(a_size * u_dpr * 260.0 / max(cp.w, 0.5), 2.0, 150.0);
  v_col = a_col;
}`;
const GLOW_FS = `
precision highp float;
varying vec3 v_col; uniform float u_glow;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float a = exp(-r * r * 3.6) * (1.0 - smoothstep(0.85, 1.0, r));
  gl_FragColor = vec4(v_col * a * u_glow, a);
}`;
const BG_VS = `
precision highp float;
attribute vec2 a_pos; varying vec2 v_uv;
void main(){ v_uv = a_pos; gl_Position = vec4(a_pos, 0.9999, 1.0); }`;
const BG_FS = `
precision highp float;
varying vec2 v_uv;
uniform vec3 u_right, u_up, u_fwd, u_keyDir, u_baseA, u_baseB, u_rim, u_fog;
uniform float u_time, u_tanA, u_tanF;
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
  vec3 col = u_fog * 0.7;
  col += mix(u_baseA, u_baseB, neb2) * pow(neb, 2.4) * 0.30;
  col += u_rim * pow(neb2, 3.5) * 0.10;
  float align = max(dot(dir, u_keyDir), 0.0);
  float streak = noise(dir * 9.0 + vec3(0.0, u_time * 0.02, 0.0));
  col += u_baseA * (pow(align, 42.0) * 0.85 + pow(align, 7.0) * 0.16 * (0.5 + 0.5 * streak));
  vec3 sp = dir * 160.0;
  vec3 cell = floor(sp);
  float sh = h3(cell);
  if (sh > 0.9955) {
    vec3 f = fract(sp) - 0.5;
    float star = exp(-dot(f, f) * 26.0);
    float tw = 0.6 + 0.4 * sin(u_time * 2.4 + sh * 90.0);
    col += vec3(0.9, 0.95, 1.0) * star * tw * 1.4;
  }
  float vig = 1.0 - dot(v_uv * 0.62, v_uv * 0.62);
  col *= clamp(vig, 0.25, 1.0);
  col += (h3(vec3(gl_FragCoord.xy, fract(u_time) * 7.0)) - 0.5) * 0.028;
  gl_FragColor = vec4(col, 1.0);
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
function drawInstanced(mode, first, count, inst) {
    if (isGL2) { gl.drawArraysInstanced(mode, first, count, inst); }
    else { angleExt.drawArraysInstancedANGLE(mode, first, count, inst); }
}

// deformed octahedron shard — flat normals, 8 faces
function buildRock() {
    const base = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    const faces = [[0,2,4],[2,1,4],[1,3,4],[3,0,4],[2,0,5],[1,2,5],[3,1,5],[0,3,5]];
    const rng = prng(777);
    const verts = base.map(v => {
        const s = 0.75 + rng() * 0.5;
        return [v[0] * s * 1.0, v[1] * s * 0.62, v[2] * s * 0.8];
    });
    const pos = [], nrm = [];
    for (const f of faces) {
        const A = verts[f[0]], B = verts[f[1]], C = verts[f[2]];
        const ux = B[0]-A[0], uy = B[1]-A[1], uz = B[2]-A[2];
        const vx = C[0]-A[0], vy = C[1]-A[1], vz = C[2]-A[2];
        let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
        const l = Math.hypot(nx, ny, nz) || 1; nx/=l; ny/=l; nz/=l;
        const cx = (A[0]+B[0]+C[0])/3, cy = (A[1]+B[1]+C[1])/3, cz = (A[2]+B[2]+C[2])/3;
        if (nx*cx + ny*cy + nz*cz < 0) { nx=-nx; ny=-ny; nz=-nz; }
        for (const V of [A, B, C]) { pos.push(V[0], V[1], V[2]); nrm.push(nx, ny, nz); }
    }
    const inter = new Float32Array(24 * 6);
    for (let i = 0; i < 24; i++) {
        inter[i*6] = pos[i*3]; inter[i*6+1] = pos[i*3+1]; inter[i*6+2] = pos[i*3+2];
        inter[i*6+3] = nrm[i*3]; inter[i*6+4] = nrm[i*3+1]; inter[i*6+5] = nrm[i*3+2];
    }
    const wire = new Float32Array(24 * 3);
    const edges = [[0,2],[2,4],[4,0],[1,2],[2,5],[5,1],[0,3],[3,4],[4,0],[1,3],[3,5],[5,1]];
    let o = 0;
    for (const e of edges) {
        for (const idx of e) { wire[o++] = verts[idx][0]; wire[o++] = verts[idx][1]; wire[o++] = verts[idx][2]; }
    }
    return { inter, wire };
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
        $("dq-glchip").textContent = "CANVAS FALLBACK";
        glCanvas.style.display = "none"; fbCanvas.style.display = "block";
        return;
    }
    try {
        progRock = compile(ROCK_VS, ROCK_FS);
        progWhale = compile(WHALE_VS, WHALE_FS);
        progGlow = compile(GLOW_VS, GLOW_FS);
        progBG = compile(BG_VS, BG_FS);
    } catch (e) {
        console.error("[009_demo] GL init:", e);
        glOK = false; gl = null;
        $("dq-glchip").textContent = "CANVAS FALLBACK";
        glCanvas.style.display = "none"; fbCanvas.style.display = "block";
        return;
    }
    const rock = buildRock();
    bufRock = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufRock); gl.bufferData(gl.ARRAY_BUFFER, rock.inter, gl.STATIC_DRAW);
    bufWire = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufWire); gl.bufferData(gl.ARRAY_BUFFER, rock.wire, gl.STATIC_DRAW);
    bufBG = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufBG);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    bufWhale = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufWhale);
    gl.bufferData(gl.ARRAY_BUFFER, whaleStaging.byteLength, gl.DYNAMIC_DRAW);
    bufWhaleIdx = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufWhaleIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, whaleIdx, gl.STATIC_DRAW);
    bufGlow = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufGlow);
    gl.bufferData(gl.ARRAY_BUFFER, glowStaging.byteLength, gl.DYNAMIC_DRAW);
    bufInstStatic = gl.createBuffer(); bufInstDyn = gl.createBuffer();
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.01, 0.012, 0.03, 1);
    glOK = true; glLost = false;
    $("dq-glchip").textContent = isGL2 ? "WEBGL2 · DQ INSTANCED" : "WEBGL1 · DQ INSTANCED";
    $("dq-glchip").classList.add("on");
    resize();
}
function reallocInstanceBuffers() {
    gl.bindBuffer(gl.ARRAY_BUFFER, bufInstStatic);
    gl.bufferData(gl.ARRAY_BUFFER, metaSOA.arrays ? new Float32Array(metaSOA.buffer) : metaSOA.buffer, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufInstDyn);
    gl.bufferData(gl.ARRAY_BUFFER, N * 48, gl.DYNAMIC_DRAW);
}

glCanvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault(); glLost = true;
    $("dq-glchip").textContent = "GL LOST · RECOVERING";
    $("dq-glchip").classList.remove("on");
});
glCanvas.addEventListener("webglcontextrestored", () => {
    initGL();
    if (glOK && belt) { reallocInstanceBuffers(); for (let s = 0; s < SLICES; s++) { packSlice(s); } }
    toast("GL CONTEXT RESTORED", "ok");
});

function setPalette(prog) {
    const th = THEMES[S.theme], u = prog.u;
    if (u.u_key) { gl.uniform3fv(u.u_key, th.key); }
    if (u.u_rim) { gl.uniform3fv(u.u_rim, th.rim); }
    if (u.u_fill) { gl.uniform3fv(u.u_fill, th.fill); }
    if (u.u_baseA) { gl.uniform3fv(u.u_baseA, th.baseA); }
    if (u.u_baseB) { gl.uniform3fv(u.u_baseB, th.baseB); }
    if (u.u_fog) { gl.uniform3fv(u.u_fog, th.fog); }
    if (u.u_whaleA) { gl.uniform3fv(u.u_whaleA, th.whaleA); }
    if (u.u_whaleB) { gl.uniform3fv(u.u_whaleB, th.whaleB); }
    if (u.u_glowCol) { gl.uniform3fv(u.u_glowCol, th.glow); }
    if (u.u_keyDir) { gl.uniform3fv(u.u_keyDir, KEY_DIR); }
    if (u.u_fillDir) { gl.uniform3fv(u.u_fillDir, FILL_DIR); }
    if (u.u_cam) { gl.uniform3fv(u.u_cam, T.eye); }
    if (u.u_fogD) { gl.uniform1f(u.u_fogD, S.fog); }
    if (u.u_glow) { gl.uniform1f(u.u_glow, S.glow); }
    if (u.u_vp) { gl.uniformMatrix4fv(u.u_vp, false, T.vp); }
    if (u.u_time) { gl.uniform1f(u.u_time, simTime); }
}
function bindAttr(prog, name, buf, size, stride, offset, div) {
    const loc = prog.a[name];
    if (loc === undefined || loc < 0) { return; }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    divisor(loc, div || 0);
}
function disableDivisors(prog, names) {
    for (const n of names) {
        const loc = prog.a[n];
        if (loc !== undefined && loc >= 0) { divisor(loc, 0); gl.disableVertexAttribArray(loc); }
    }
}

function buildGlowPoints() {
    glowCount = 0;
    const th = THEMES[S.theme];
    let o = 0;
    const push = (x, y, z, size, r, g, b) => {
        glowStaging[o] = x; glowStaging[o + 1] = y; glowStaging[o + 2] = z; glowStaging[o + 3] = size;
        glowStaging[o + 4] = r; glowStaging[o + 5] = g; glowStaging[o + 6] = b;
        o += 7; glowCount++;
    };
    // whale spine lights (pulse with song)
    for (let i = 0; i < BONES; i += 2) {
        quat2.getTranslation(T.v3a, boneViews[i]);
        const s = (0.55 - i * 0.02) * (1 + singPulse * 1.6);
        push(T.v3a[0], T.v3a[1], T.v3a[2], s, th.glow[0], th.glow[1], th.glow[2]);
    }
    // lure beacon
    const lp = 1.6 + Math.sin(simTime * 4) * 0.4;
    push(lure[0], lure[1], lure[2], lp, th.rim[0], th.rim[1], th.rim[2]);
    // emissive belt beacons (extrapolated like the GPU does)
    const nb = Math.min(beacons.length, fpsEma < 42 ? 24 : beacons.length);
    for (let k = 0; k < nb; k++) {
        const i = beacons[k];
        const dt = simTime - bakeTime[i];
        const x = prevPos.x[i] + velSOA.x[i] * dt;
        const y = prevPos.y[i] + velSOA.y[i] * dt;
        const z = prevPos.z[i] + velSOA.z[i] * dt;
        const m = metaSOA.z[i];
        push(x, y, z, 0.35 + m * 0.4, th.baseA[0] * m, th.baseA[1] * m, th.baseA[2] * m);
    }
}

function renderGL() {
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // --- background nebula + god rays + stars ---
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(progBG.p);
    setPalette(progBG);
    const tanF = Math.tan(FOV / 2);
    gl.uniform3fv(progBG.u.u_right, T.right);
    gl.uniform3fv(progBG.u.u_up, T.cup);
    gl.uniform3fv(progBG.u.u_fwd, T.fwd);
    gl.uniform1f(progBG.u.u_tanA, tanF * (W / H));
    gl.uniform1f(progBG.u.u_tanF, tanF);
    bindAttr(progBG, "a_pos", bufBG, 2, 8, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);

    if (!rebuilding && belt) {
        // --- 50k dual-quaternion asteroids, one instanced draw ---
        gl.useProgram(progRock.p);
        setPalette(progRock);
        gl.uniform1f(progRock.u.u_turb, S.turb);
        gl.uniform1f(progRock.u.u_scale, S.rockScale);
        gl.uniform1f(progRock.u.u_wire, S.wireframe ? 1 : 0);
        if (S.wireframe) {
            bindAttr(progRock, "a_pos", bufWire, 3, 12, 0, 0);
            const nl = progRock.a.a_nrm; if (nl >= 0) { gl.disableVertexAttribArray(nl); gl.vertexAttrib3f(nl, 0, 1, 0); }
        } else {
            bindAttr(progRock, "a_pos", bufRock, 3, 24, 0, 0);
            bindAttr(progRock, "a_nrm", bufRock, 3, 24, 12, 0);
        }
        bindAttr(progRock, "a_dqR", bufInstDyn, 4, 48, 0, 1);
        bindAttr(progRock, "a_dqD", bufInstDyn, 4, 48, 16, 1);
        bindAttr(progRock, "a_vel", bufInstDyn, 3, 48, 32, 1);
        bindAttr(progRock, "a_bake", bufInstDyn, 1, 48, 44, 1);
        bindAttr(progRock, "a_meta", bufInstStatic, 4, 16, 0, 1);
        drawInstanced(S.wireframe ? gl.LINES : gl.TRIANGLES, 0, 24, N);
        disableDivisors(progRock, ["a_dqR", "a_dqD", "a_vel", "a_bake", "a_meta"]);
    }

    // --- skinned whale ---
    gl.useProgram(progWhale.p);
    setPalette(progWhale);
    gl.uniform1f(progWhale.u.u_sing, singPulse);
    bindAttr(progWhale, "a_pos", bufWhale, 3, 28, 0, 0);
    bindAttr(progWhale, "a_nrm", bufWhale, 3, 28, 12, 0);
    bindAttr(progWhale, "a_glow", bufWhale, 1, 28, 24, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufWhaleIdx);
    gl.drawElements(gl.TRIANGLES, whaleIdx.length, gl.UNSIGNED_SHORT, 0);

    // --- additive glow sprites (bloom feel) ---
    buildGlowPoints();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufGlow);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, glowStaging.subarray(0, glowCount * 7));
    gl.useProgram(progGlow.p);
    gl.uniformMatrix4fv(progGlow.u.u_vp, false, T.vp);
    gl.uniform1f(progGlow.u.u_dpr, DPR);
    gl.uniform1f(progGlow.u.u_glow, S.glow);
    bindAttr(progGlow, "a_pos", bufGlow, 3, 28, 0, 0);
    bindAttr(progGlow, "a_size", bufGlow, 1, 28, 12, 0);
    bindAttr(progGlow, "a_col", bufGlow, 3, 28, 16, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    gl.drawArrays(gl.POINTS, 0, glowCount);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
}

// ============================================================================
// 9. CANVAS2D FALLBACK (same simulation, graceful degradation)
// ============================================================================
const FB_CAP = 20000;
function renderFallback() {
    const c = fbCtx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    const th = THEMES[S.theme];
    const grd = c.createRadialGradient(W * 0.5, H * 0.55, 10, W * 0.5, H * 0.55, Math.max(W, H) * 0.8);
    grd.addColorStop(0, th.bg); grd.addColorStop(1, "#000");
    c.fillStyle = grd; c.fillRect(0, 0, W, H);
    const M = T.vp;
    if (belt && !rebuilding) {
        const n = Math.min(N, FB_CAP);
        const step = Math.max(1, Math.floor(N / n));
        c.fillStyle = th.acc;
        for (let i = 0; i < N; i += step) {
            const dt = simTime - bakeTime[i];
            const x = prevPos.x[i] + velSOA.x[i] * dt;
            const y = prevPos.y[i] + velSOA.y[i] * dt;
            const z = prevPos.z[i] + velSOA.z[i] * dt;
            const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
            if (cw < 0.4) { continue; }
            const inv = 1 / cw;
            const px = ((M[0] * x + M[4] * y + M[8] * z + M[12]) * inv * 0.5 + 0.5) * W;
            const py = (1 - ((M[1] * x + M[5] * y + M[9] * z + M[13]) * inv * 0.5 + 0.5)) * H;
            if (px < -4 || px > W + 4 || py < -4 || py > H + 4) { continue; }
            const sz = Math.max(1, Math.min(3.4, 4.5 * S.rockScale / cw * 8));
            c.globalAlpha = Math.max(0.12, Math.min(0.9, (1 - cw * S.fog * 0.9))) * Math.min(1, S.glow);
            c.fillRect(px, py, sz, sz);
        }
        c.globalAlpha = 1;
    }
    // whale wireframe
    c.strokeStyle = th.acc2; c.lineWidth = 1.3; c.globalAlpha = 0.9;
    c.beginPath();
    for (let s = 0; s < BONES; s++) {
        for (let k = 0; k <= RING; k++) {
            const i = s * RING + (k % RING);
            const x = worldPos.x[i], y = worldPos.y[i], z = worldPos.z[i];
            const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
            if (cw < 0.4) { continue; }
            const inv = 1 / cw;
            const px = ((M[0] * x + M[4] * y + M[8] * z + M[12]) * inv * 0.5 + 0.5) * W;
            const py = (1 - ((M[1] * x + M[5] * y + M[9] * z + M[13]) * inv * 0.5 + 0.5)) * H;
            if (k === 0) { c.moveTo(px, py); } else { c.lineTo(px, py); }
        }
    }
    c.stroke();
    // lure
    const lw = M[3] * lure[0] + M[7] * lure[1] + M[11] * lure[2] + M[15];
    if (lw > 0.4) {
        const lx = ((M[0] * lure[0] + M[4] * lure[1] + M[8] * lure[2] + M[12]) / lw * 0.5 + 0.5) * W;
        const ly = (1 - ((M[1] * lure[0] + M[5] * lure[1] + M[9] * lure[2] + M[13]) / lw * 0.5 + 0.5)) * H;
        c.strokeStyle = th.acc2; c.globalAlpha = 0.8;
        c.beginPath(); c.arc(lx, ly, 8 + Math.sin(simTime * 4) * 3, 0, 6.2832); c.stroke();
    }
    c.globalAlpha = 1;
}

// ============================================================================
// 10. AUDIO — ambient drone + event blips + whale song (one-touch mute)
// ============================================================================
const audio = (function () {
    let ctx = null, master = null, muted = false, started = false;
    function ensure() {
        if (started || muted) { return; }
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
            const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 240; lp.Q.value = 2;
            const dg = ctx.createGain(); dg.gain.value = 0.05;
            lp.connect(dg); dg.connect(master);
            for (const f of [55, 55.7, 110.3]) {
                const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f;
                o.connect(lp); o.start();
            }
            const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
            const lg = ctx.createGain(); lg.gain.value = 90;
            lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
            started = true;
        } catch (e) { /* audio unavailable — silent, non-fatal */ }
    }
    function tone(freq, dur, vol, type) {
        if (!ctx || muted) { return; }
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type || "sine"; o.frequency.value = freq;
        g.gain.setValueAtTime(vol, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
        o.connect(g); g.connect(master);
        o.start(); o.stop(ctx.currentTime + dur);
    }
    return {
        ensure,
        blip(f) { ensure(); tone(f || 880, 0.14, 0.06, "triangle"); },
        whaleSong() {
            if (!ctx || muted) { return; }
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = "sine";
            o.frequency.setValueAtTime(180, ctx.currentTime);
            o.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 1.4);
            o.frequency.exponentialRampToValueAtTime(140, ctx.currentTime + 2.8);
            g.gain.setValueAtTime(0.0001, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.6);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 3);
            o.connect(g); g.connect(master);
            o.start(); o.stop(ctx.currentTime + 3.1);
        },
        toggle() {
            muted = !muted;
            if (!muted) { ensure(); }
            if (master) { master.gain.value = muted ? 0 : 0.5; }
            const el = $("dq-mute");
            el.textContent = muted ? "♪ SOUND OFF" : "♪ SOUND ON";
            el.style.color = muted ? "var(--dim)" : "var(--acc2)";
            return muted;
        },
        get muted() { return muted; }
    };
})();
$("dq-mute").addEventListener("pointerdown", (e) => { e.preventDefault(); audio.toggle(); });

// ============================================================================
// 11. ACTIONS — reset / randomize / export (011 or DQBL fallback)
// ============================================================================
let exportBusy = false;
function resetAll() {
    Object.assign(S, DEFAULTS);
    seed = 20261124;
    origin.fill(0); originShifts = 0;
    cam.yawT = 0.9; cam.pitchT = 0.42; cam.distT = 62;
    lureManual = false;
    quat2.fromTranslation(whaleRoot, [6, 2, 0]);
    rootVel.fill(0);
    applyThemeCSS(); syncControls(); resize();
    rebuildBelt("FIELD RESET");
    audio.blip(520);
}
function randomize() {
    seed = (Math.random() * 1e9) | 0;
    rebuildBelt("FIELD RESEEDED · #" + seed);
    audio.blip(700); audio.blip(940);
}
async function exportSnapshot() {
    if (exportBusy || !belt || rebuilding) { return; }
    exportBusy = true;
    const btn = panel.querySelector('[data-act="export"]');
    if (btn) { btn.disabled = true; }
    toast("BAKING DQ → MAT4 → TRS…");
    try {
        // ★ interop path: dual-quats -> matrices (chunked) -> TRS
        const mats = mat4.createMat4SOA(N);
        await quat2.soaToMat4Chunked(mats, belt, 16384, 1);
        const pos = vec3.createVec3SOA(N), rot = quat.createQuatSOA(N), scl = vec3.createVec3SOA(N);
        mat4.soaDecompose(pos, rot, scl, mats);
        let bytes;
        if (ser11) {
            const writer = ser11.createByteWriter(Math.max(1 << 20, N * 60 + 64));
            writer.writeU32(0x4451424C);            // "DQBL"
            writer.writeU16(1);
            writer.writeF64(origin[0]); writer.writeF64(origin[1]); writer.writeF64(origin[2]);
            const eids = new Uint32Array(N);
            for (let i = 0; i < N; i++) { eids[i] = i; }
            const trs = { position: pos, rotation: rot, scale: scl };
            const serialize = ser11.createTRSSOASerializerChunked({ worldCoords: false });
            await serialize(writer, eids, trs, 16384, 1);
            bytes = writer.slice();
            writer.release();
        } else {
            const buf = new ArrayBuffer(34 + N * 32);
            const dv = new DataView(buf);
            dv.setUint32(0, 0x4451424C); dv.setUint16(4, 1);
            dv.setFloat64(6, origin[0]); dv.setFloat64(14, origin[1]); dv.setFloat64(22, origin[2]);
            dv.setUint32(30, N);
            let o = 34;
            for (let i = 0; i < N; i++) {
                dv.setFloat32(o, pos.x[i]); dv.setFloat32(o + 4, pos.y[i]); dv.setFloat32(o + 8, pos.z[i]);
                dv.setFloat32(o + 12, rot.x[i]); dv.setFloat32(o + 16, rot.y[i]);
                dv.setFloat32(o + 20, rot.z[i]); dv.setFloat32(o + 24, rot.w[i]);
                dv.setFloat32(o + 28, scl.x[i]);
                o += 32;
            }
            bytes = buf;
        }
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "deep-field-" + N + "-" + (ser11 ? "011" : "dqbl") + ".bin";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast("EXPORTED " + (bytes.byteLength / 1048576).toFixed(2) + " MB · " + (ser11 ? "011 TRS" : "DQBL codec"), "ok");
        audio.blip(880); audio.blip(1320);
    } catch (e) {
        console.error("[009_demo] export:", e);
        toast("EXPORT FAILED — see console", "err");
    }
    exportBusy = false;
    if (btn) { btn.disabled = false; }
}

// ============================================================================
// 12. CONTROL DECK — permanently visible, everything live
// ============================================================================
const controlRefs = {};
let rebuildTimer = 0;
function scheduleRebuild(reason) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => { rebuildBelt(reason); }, 140);
}
function addSection(letter, title) {
    const d = document.createElement("div");
    d.className = "dq-sec";
    d.innerHTML = "<b>" + letter + "</b> " + title;
    panel.appendChild(d);
}
function addRange(key, label, min, max, step, fmt, onInput) {
    const row = document.createElement("div");
    row.className = "dq-row";
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
    row.className = "dq-row";
    row.innerHTML = `<label>${label}</label><select class="dq-sel">${
        options.map(o => `<option value="${o[0]}" ${S[key] === o[0] ? "selected" : ""}>${o[1]}</option>`).join("")
    }</select>`;
    const sel = row.querySelector("select");
    sel.addEventListener("change", () => { S[key] = sel.value; onChange(sel.value); });
    panel.appendChild(row);
    controlRefs[key] = { input: sel };
}
function addToggle(key, label, onChange) {
    const row = document.createElement("div");
    row.className = "dq-tog" + (S[key] ? " on" : "");
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
    b.className = "dq-btn " + (cls || "");
    b.textContent = label;
    b.dataset.act = act;
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); fn(); });
    return b;
}
function buildPanel() {
    addSection("A", "SIMULATION");
    addRange("count", "BODIES", 5000, 150000, 5000, v => (v / 1000) + "k", () => scheduleRebuild("FIELD RESIZED"));
    addRange("timeScale", "TIME SCALE", 0, 4, 0.05, v => v.toFixed(2) + "×", () => {});
    addToggle("wander", "WHALE WANDERS", v => { if (v) { lureManual = false; } });

    addSection("B", "ORBITAL FIELD");
    addRange("spread", "BELT SPREAD", 0.4, 2.5, 0.05, v => v.toFixed(2) + "×", () => scheduleRebuild("SPREAD RETUNED"));
    addRange("ecc", "ECCENTRICITY", 0, 0.6, 0.02, v => v.toFixed(2), () => scheduleRebuild("ECCENTRICITY RETUNED"));
    addRange("inc", "INCLINATION", 0, 1.2, 0.02, v => (v * 57.3).toFixed(0) + "°", () => scheduleRebuild("INCLINATION RETUNED"));

    addSection("C", "RENDER");
    addRange("turb", "TURBULENCE", 0, 1.5, 0.02, v => v.toFixed(2), () => {});
    addRange("rockScale", "SHARD SCALE", 0.3, 3, 0.05, v => v.toFixed(2) + "×", () => {});
    addRange("glow", "GLOW / EMISSIVE", 0, 2.5, 0.05, v => v.toFixed(2), () => {});
    addRange("fog", "FOG DENSITY", 0, 0.02, 0.0005, v => (v * 1000).toFixed(1) + "‰", () => {});
    addSelect("theme", "PALETTE", Object.keys(THEMES).map(k => [k, THEMES[k].name]), () => {
        applyThemeCSS(); toast("PALETTE · " + THEMES[S.theme].name.toUpperCase()); audio.blip(760);
    });
    addSelect("quality", "QUALITY (PIXEL RATIO)", [["low", "Low · 1.0×"], ["balanced", "Balanced · 1.5×"], ["high", "High · 2.0×"]], () => resize());
    addToggle("wireframe", "WIREFRAME SHARDS");

    addSection("D", "CAMERA & ORIGIN");
    addToggle("autoOrbit", "AUTO ORBIT DRIFT");
    addToggle("follow", "FOLLOW THE WHALE");
    addToggle("autoRecenter", "AUTO FLOATING ORIGIN");

    addSection("E", "ACTIONS");
    const grid = document.createElement("div");
    grid.className = "dq-btns";
    grid.appendChild(addButton("pause", "⏸ PAUSE", "", togglePause));
    grid.appendChild(addButton("recenter", "🌍 RECENTER", "", recenterOrigin));
    grid.appendChild(addButton("random", "🎲 RANDOMIZE", "", randomize));
    grid.appendChild(addButton("reset", "↺ RESET", "", resetAll));
    grid.appendChild(addButton("export", "⬇ EXPORT SNAPSHOT (.bin)", "pri", exportSnapshot));
    panel.appendChild(grid);

    const keys = document.createElement("div");
    keys.className = "dq-keys";
    keys.innerHTML = "<b>SPACE</b> pause · <b>R</b> reset · <b>F</b> follow · <b>O</b> recenter<br><b>E</b> export · <b>M</b> mute · <b>1–4</b> palettes · <b>tap</b> lure";
    panel.appendChild(keys);

    const stack = document.createElement("div");
    stack.className = "dq-stack";
    stack.id = "dq-stackinfo";
    stack.innerHTML = `MODULE STACK<br>009 quat2 · <span class="ok">CORE</span><br>007 mat4 · 008 quat · 003 vec3 · 004 vec4<br>005 mat2 · 002 vec2 · <span class="ok">LINKED</span><br>011 serialization · <span id="dq-stack11" class="fb">PROBING…</span>`;
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
function togglePause() {
    paused = !paused;
    const b = panel.querySelector('[data-act="pause"]');
    if (b) { b.textContent = paused ? "▶ RESUME" : "⏸ PAUSE"; }
    toast(paused ? "SIMULATION HELD" : "SIMULATION LIVE", paused ? "warn" : "ok");
    audio.blip(paused ? 440 : 880);
}
buildPanel();
applyThemeCSS();
setTimeout(() => {
    const el = root.querySelector("#dq-stack11");
    if (el) { el.textContent = ser11 ? "LINKED" : "FALLBACK CODEC"; el.className = ser11 ? "ok" : "fb"; }
}, 1500);

// ============================================================================
// 13. INPUT — drag orbit, wheel/pinch zoom, tap lure
// ============================================================================
let dragging = false, moved = 0;
const pointers = new Map();
let pinchDist = 0;

glCanvas.style.touchAction = "none";
fbCanvas.style.touchAction = "none";
function inputTarget() { return glOK && !glLost ? glCanvas : fbCanvas; }
function attachInput() {
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
            if (pointers.size === 2) {
                const p = Array.from(pointers.values());
                const d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
                if (pinchDist > 0) { cam.distT = Math.max(8, Math.min(400, cam.distT * (pinchDist / d))); }
                pinchDist = d;
                return;
            }
            if (!dragging) { return; }
            vec2.set(T.ptr, e.clientX, e.clientY);
            vec2.subtract(T.ptr, T.ptr, T.ptrLast);
            moved += Math.abs(T.ptr[0]) + Math.abs(T.ptr[1]);
            cam.yawT += T.ptr[0] * 0.005;
            cam.pitchT = Math.max(-1.35, Math.min(1.35, cam.pitchT + T.ptr[1] * 0.004));
            vec2.set(T.ptrLast, e.clientX, e.clientY);
        });
        cv.addEventListener("pointerup", (e) => {
            pointers.delete(e.pointerId);
            if (pointers.size === 0) {
                if (dragging && moved < 8) {
                    const r = cv.getBoundingClientRect();
                    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
                    const ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
                    pointerToWorld(nx, ny, lure);
                    lureManual = true;
                    if (S.wander) { S.wander = false; syncControls(); }
                    toast("LURE SET · the whale turns", "ok");
                    audio.blip(1180);
                }
                dragging = false; pinchDist = 0;
            }
        });
        cv.addEventListener("pointercancel", (e) => { pointers.delete(e.pointerId); dragging = false; pinchDist = 0; });
        cv.addEventListener("wheel", (e) => {
            e.preventDefault();
            cam.distT = Math.max(8, Math.min(400, cam.distT * Math.exp(e.deltaY * 0.0012)));
        }, { passive: false });
    }
}
attachInput();

window.addEventListener("keydown", (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { return; }
    const k = e.key.toLowerCase();
    if (k === " ") { e.preventDefault(); togglePause(); }
    else if (k === "r") { resetAll(); }
    else if (k === "f") { S.follow = !S.follow; syncControls(); toast(S.follow ? "FOLLOWING THE WHALE" : "FREE ORBIT"); }
    else if (k === "o") { recenterOrigin(); }
    else if (k === "e") { exportSnapshot(); }
    else if (k === "m") { audio.toggle(); }
    else if (k >= "1" && k <= "4") {
        S.theme = Object.keys(THEMES)[parseInt(k, 10) - 1];
        applyThemeCSS(); syncControls();
        toast("PALETTE · " + THEMES[S.theme].name.toUpperCase());
    }
});

// ============================================================================
// 14. HUD + COMPASS
// ============================================================================
let hudTick = 0;
function updateHUD() {
    if (++hudTick % 6 !== 0) { return; }
    const th = THEMES[S.theme];
    hudEl.textContent =
        "DEEP FIELD · " + th.name.toUpperCase() + "\n" +
        "fps " + fpsEma.toFixed(0) + " · bake " + bakeMs.toFixed(1) + " ms · slices " + SLICES + "\n" +
        "bodies " + (N ? N.toLocaleString() : "—") + " × 8f DQ · " + (glOK && !glLost ? "1 instanced draw" : "canvas fallback") + "\n" +
        "whale " + BONES + " bones · DLB skin " + VCOUNT + " verts" + (singPulse > 0.1 ? " · ♪ singing" : "") + "\n" +
        "origin " + (origin[0] / 1000).toFixed(2) + ", " + (origin[1] / 1000).toFixed(2) + ", " + (origin[2] / 1000).toFixed(2) + " Mm · shifts " + originShifts + "\n" +
        "cam " + cam.dist.toFixed(0) + " km" + (S.follow ? " · FOLLOW" : "") + (paused ? " · HELD" : "");
    // mat2 compass
    mat2.fromRotation(T.m2, -cam.yaw);
    const c = compCtx;
    c.clearRect(0, 0, 52, 52);
    c.strokeStyle = "rgba(120,160,255,.3)";
    c.beginPath(); c.arc(26, 26, 22, 0, 6.2832); c.stroke();
    const nx = T.m2[0] * 0 + T.m2[2] * -1, ny = T.m2[1] * 0 + T.m2[3] * -1;
    c.strokeStyle = th.acc2; c.lineWidth = 2;
    c.beginPath(); c.moveTo(26, 26); c.lineTo(26 + nx * 18, 26 + ny * 18); c.stroke();
    c.fillStyle = th.acc; c.beginPath(); c.arc(26, 26, 2.4, 0, 6.2832); c.fill();
}

// ============================================================================
// 15. MAIN LOOP — one rAF, damped everything, adaptive slice governor
// ============================================================================
let lastT = 0, fpsAcc = 0, fpsN = 0, fpsClock = 0;
function frame(now) {
    requestAnimationFrame(frame);
    now *= 0.001;
    let dt = Math.min(0.05, now - lastT || 0.016);
    lastT = now;
    fpsAcc += dt; fpsN++;
    if (now - fpsClock > 0.5) {
        fpsEma = fpsEma * 0.75 + (fpsN / Math.max(fpsAcc, 1e-4)) * 0.25;
        fpsAcc = 0; fpsN = 0; fpsClock = now;
    }
    const simDt = paused ? 0 : dt * S.timeScale;
    simTime += simDt;

    // staggered Kepler bake — N/SLICES bodies per frame, GPU extrapolates
    if (!rebuilding && belt && simDt > 0) {
        const s = frameIdx % SLICES;
        const elapsed = simTime - lastBake[s];
        const t0 = performance.now();
        bakeSlice(s, elapsed);
        bakeMs = bakeMs * 0.9 + (performance.now() - t0) * 0.1;
    }
    frameIdx++;

    updateWhale(paused ? 0 : dt * Math.max(S.timeScale, 0.0001), simTime);
    updateCamera(dt);

    if (glOK && !glLost) { renderGL(); }
    else { renderFallback(); }
    updateHUD();
}

// ============================================================================
// 16. BOOT — fully async, never blocks the UI thread
// ============================================================================
(async function main() {
    initGL();
    resize();
    await rebuildBelt(null);
    markLink();
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        S.autoOrbit = false; S.timeScale = 0.6; syncControls();
    }
    console.info("[009_quat2_demo] DEEP FIELD ready ·", N, "dual-quaternion bodies ·",
        glOK ? (isGL2 ? "WebGL2" : "WebGL1") : "Canvas2D fallback ·",
        VCOUNT, "skinned verts ·", BONES, "bones");
    toast("FIELD ONLINE · " + N.toLocaleString() + " rigid dual-quats", "ok");
    requestAnimationFrame(frame);
})();