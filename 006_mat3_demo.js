// ============================================================================
// File number : 006-D  (demo companion to 006_mat3.js)
// Full path name : src/006_mat3_demo.js
// Description : Three self-contained, production-grade 3D cube laboratories
//               driven by the ./math/ glMatrix-SOA modules (002..009) and
//               Three.js r185 (CDN, multi-origin fallback, never blocked).
//               EX-01 "TBN FORGE"    : up to 100k instanced PBR cubes with
//                 per-instance tangent frames (006.soaBuildTBN), orientation
//                 fields (008.soaFillFromNoise / soaFillSpinFrom4DNoise),
//                 UV spin (005.fromRotation), live color grading
//                 (006.fromHueRotation / fromSaturation / soaApplyColorMatrix),
//                 Anime / Semi-real / Full-PBR material blend.
//               EX-02 "ORBITAL SWARM": up to 1,000,000 Keplerian cubes solved
//                 in parallel on the GPU (formula parity with
//                 006.fromOrbitalFrame + 003.keplerOrbit3D), CPU heroes via
//                 009.fromOrbitalElements -> 007.fromQuat2, floating origin
//                 recenter via 003.soaToRelative, mm -> Mpc scale ladder with
//                 live precision readout.
//               EX-03 "KINETIC CHAIN": FABRIK / CCD cube spine
//                 (003.fabrikStep3 / ccdStep3), bone frames
//                 (006.fromBoneDirection), pose blending (006.blendRotation),
//                 spring followers (003.springDamp3 + 008.soaFillFromVelocity),
//                 draggable IK target, trails.
//               Shared shell: single rAF loop, damped orbit/pinch/pan rig,
//               capped pixel ratio, baked PMREM environment + throttled static
//               shadows, HDR bloom pipeline (bright/blur/composite, ACES),
//               fog, dust, nebula dome, light shafts, adaptive quality
//               governor (never degrades while dragging), zero-GC pools,
//               chunked non-blocking generation, WebAudio ambience with a
//               single top-level mute, themed scrollbars, PNG/JSON export,
//               keyboard shortcuts, context-loss recovery, full disposal.
// Best for : 3d graphics -- instanced PBR / anime rendering at 1M scale,
//            procedural orientation & TBN fields, orbital mechanics, natural
//            IK motion, floating-origin galactic navigation, Android 64-bit
//            real-time reference implementation of the 002..009 math stack.
// License : MIT
//
// TOPOLOGICAL ORDER (dependencies first -- all already exist, imported here):
//   001  src/math/002_vec2.js   (2D vectors, curves, polar)
//   002  src/math/003_vec3.js   (3D vectors, SOA, noise, IK, Kepler)
//   003  src/math/004_vec4.js   (4D vectors, SOA, color, flat pack)
//   004  src/math/005_mat2.js   (2x2 rotation -> UV spin uniform)
//   005  src/math/006_mat3.js   (3x3 SOA, TBN, frames, grading, blend)
//   006  src/math/007_mat4.js   (TRS compose, fromQuat2, scale)
//   007  src/math/008_quat.js   (quat SOA, noise spin, velocity align)
//   008  src/math/009_quat2.js  (dual quats, orbital elements)
//   009  src/006_mat3_demo.js   <-- THIS FILE (self-mounting ES module)
//
// HOST (no build step, no Vite/Vue/client tooling -- any http origin or
// Android WebView; file:// blocks ES modules by browser policy):
//   <!doctype html><html><head><meta charset="utf-8">
//   <meta name="viewport" content="width=device-width,initial-scale=1">
//   </head><body><script type="module" src="./006_mat3_demo.js"></script>
//   </body></html>
// ============================================================================

/* global document, window, performance, requestAnimationFrame, cancelAnimationFrame,
          ResizeObserver, TextEncoder, URL, Blob, AudioContext, webkitAudioContext */

const M3D_VERSION = "1.0.0";
const THREE_CDNS = [
  "https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.module.js",
  "https://unpkg.com/three@0.185.0/build/three.module.js",
  "https://esm.sh/three@0.185.0"
];
const MATH_FILES = {
  vec2: "002_vec2.js", vec3: "003_vec3.js", vec4: "004_vec4.js",
  mat2: "005_mat2.js", mat3: "006_mat3.js", mat4: "007_mat4.js",
  quat: "008_quat.js", quat2: "009_quat2.js"
};
const PAL = {
  bg0: "#05070f", bg1: "#0a1022", surface: "#0d1530", surface2: "#111c3d",
  line: "#1d2b55", line2: "#2a3d78", cyan: "#3fd6ff", blue: "#4f7dff",
  magenta: "#ff3d9e", amber: "#ffb02e", green: "#43f5a0", red: "#ff5470",
  violet: "#8b5cff", text: "#e9eeff", muted: "#93a0c8", dim: "#5b6890"
};
const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ----------------------------------------------------------------------------
// 0. Tiny utilities (zero-GC hot paths, pooled scratch)
// ----------------------------------------------------------------------------
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const dampK = (dt, rate) => 1 - Math.exp(-dt * rate);
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function yieldToMain() {
  return new Promise(r => {
    if (typeof setTimeout === "function") setTimeout(r, 0); else r();
  });
}
function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n | 0);
}
function fmtMeters(m) {
  const a = Math.abs(m);
  if (a < 1e-3) return (m * 1e6).toFixed(1) + " µm";
  if (a < 1) return (m * 1e3).toFixed(1) + " mm";
  if (a < 1e3) return m.toFixed(2) + " m";
  if (a < 1.496e11 * 0.05) return (m / 1e3).toFixed(1) + " km";
  if (a < 9.461e15 * 0.05) return (m / 1.496e11).toFixed(2) + " AU";
  if (a < 3.086e16 * 500) return (m / 9.461e15).toFixed(2) + " ly";
  if (a < 3.086e22 * 0.5) return (m / 3.086e16).toFixed(2) + " pc";
  return (m / 3.086e22).toFixed(2) + " Mpc";
}
function download(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 400);
}
class Pool {
  constructor(factory, reset, cap = 128) { this.f = factory; this.r = reset; this.cap = cap; this.items = []; }
  acquire() { return this.items.length ? this.items.pop() : this.f(); }
  release(v) { if (this.r) this.r(v); if (this.items.length < this.cap) this.items.push(v); }
}
const scratchPool = new Pool(() => new Float32Array(4), a => { a[0] = a[1] = a[2] = a[3] = 0; }, 64);

// ----------------------------------------------------------------------------
// 1. Shell DOM + themed CSS (self-mounting, fixed viewport, own scrollbars)
// ----------------------------------------------------------------------------
const CSS = `
#m3d-root{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;
  background:radial-gradient(120% 90% at 70% -10%,#101a3d 0%,${PAL.bg1} 42%,${PAL.bg0} 100%);
  color:${PAL.text};font-family:"Segoe UI",system-ui,-apple-system,Roboto,sans-serif;
  font-size:14px;line-height:1.4;overflow:hidden;-webkit-tap-highlight-color:transparent}
#m3d-root *{box-sizing:border-box;margin:0;padding:0}
#m3d-root button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}
#m3d-root .mono{font-family:ui-monospace,"Cascadia Mono","Roboto Mono",Menlo,Consolas,monospace}
#m3d-top{flex:0 0 56px;display:flex;align-items:center;gap:14px;padding:0 16px;
  background:linear-gradient(90deg,rgba(13,21,48,.92),rgba(10,16,34,.88));
  border-bottom:1px solid ${PAL.line};backdrop-filter:blur(12px) saturate(1.4);position:relative;z-index:5}
#m3d-logo{width:26px;height:26px;perspective:120px;flex:0 0 auto}
#m3d-logo .c{width:100%;height:100%;position:relative;transform-style:preserve-3d;
  animation:m3dspin 9s linear infinite}
#m3d-logo .f{position:absolute;inset:3px;border:1.5px solid ${PAL.cyan};
  background:linear-gradient(135deg,rgba(63,214,255,.22),rgba(255,61,158,.16));border-radius:2px}
#m3d-logo .f:nth-child(1){transform:translateZ(10px)}
#m3d-logo .f:nth-child(2){transform:rotateY(90deg) translateZ(10px);border-color:${PAL.magenta}}
#m3d-logo .f:nth-child(3){transform:rotateX(90deg) translateZ(10px);border-color:${PAL.amber}}
@keyframes m3dspin{from{transform:rotateX(-24deg) rotateY(0)}to{transform:rotateX(-24deg) rotateY(360deg)}}
#m3d-title{font-weight:700;letter-spacing:.14em;font-size:15px;
  background:linear-gradient(90deg,${PAL.cyan},${PAL.blue} 55%,${PAL.magenta});
  -webkit-background-clip:text;background-clip:text;color:transparent;white-space:nowrap}
#m3d-sub{color:${PAL.dim};font-size:11px;letter-spacing:.08em;white-space:nowrap}
#m3d-top .sp{flex:1}
.m3d-tbtn{display:flex;align-items:center;gap:7px;padding:7px 12px;border-radius:9px;
  border:1px solid ${PAL.line2};background:rgba(17,28,61,.7);color:${PAL.muted};
  font-size:12px;letter-spacing:.05em;transition:border-color .18s,color .18s,box-shadow .18s}
.m3d-tbtn:hover{border-color:${PAL.cyan};color:${PAL.text};box-shadow:0 0 14px rgba(63,214,255,.25)}
.m3d-tbtn[aria-pressed="true"]{border-color:${PAL.green};color:${PAL.green}}
.m3d-tbtn svg{width:15px;height:15px;fill:currentColor}
#m3d-tabs{flex:0 0 auto;display:flex;gap:10px;padding:10px 16px;overflow-x:auto;
  background:rgba(8,12,26,.6);border-bottom:1px solid ${PAL.line};scrollbar-width:thin;
  scrollbar-color:${PAL.line2} transparent;position:relative;z-index:4}
#m3d-tabs::-webkit-scrollbar{height:6px}
#m3d-tabs::-webkit-scrollbar-thumb{background:${PAL.line2};border-radius:3px}
.m3d-tab{flex:1 1 0;min-width:210px;text-align:left;padding:9px 13px;border-radius:11px;
  border:1px solid ${PAL.line};background:linear-gradient(160deg,rgba(17,28,61,.55),rgba(10,16,34,.55));
  transition:transform .18s,border-color .18s,box-shadow .18s;position:relative;overflow:hidden}
.m3d-tab:hover{transform:translateY(-1px);border-color:${PAL.line2}}
.m3d-tab .n{font-size:10px;letter-spacing:.22em;color:${PAL.dim}}
.m3d-tab .t{font-weight:700;font-size:13.5px;letter-spacing:.06em;margin:1px 0}
.m3d-tab .d{font-size:10.5px;color:${PAL.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m3d-tab[aria-selected="true"]{border-color:var(--ac);box-shadow:0 0 0 1px var(--ac),0 6px 22px -6px var(--ac)}
.m3d-tab[aria-selected="true"] .n{color:var(--ac)}
.m3d-tab[aria-selected="true"]::before{content:"";position:absolute;inset:0;
  background:linear-gradient(120deg,transparent 30%,color-mix(in srgb,var(--ac) 14%,transparent) 50%,transparent 70%)}
#m3d-main{flex:1;display:flex;min-height:0;position:relative}
#m3d-stage{flex:1;position:relative;min-width:0;min-height:0;background:${PAL.bg0}}
#m3d-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none}
#m3d-hud{position:absolute;top:10px;left:12px;display:flex;flex-wrap:wrap;gap:6px;
  pointer-events:none;z-index:3;max-width:calc(100% - 130px)}
.m3d-chip{display:flex;align-items:center;gap:6px;padding:4px 9px;border-radius:8px;
  background:rgba(8,13,29,.72);border:1px solid ${PAL.line};font-size:11px;color:${PAL.muted};
  backdrop-filter:blur(6px)}
.m3d-chip b{color:${PAL.cyan};font-weight:600}
.m3d-chip.warn b{color:${PAL.amber}}
#m3d-spark{width:96px;height:24px;display:block}
#m3d-quick{position:absolute;top:10px;right:12px;display:flex;gap:7px;z-index:3}
.m3d-qbtn{width:36px;height:36px;border-radius:10px;border:1px solid ${PAL.line2};
  background:rgba(13,21,48,.8);color:${PAL.muted};display:flex;align-items:center;justify-content:center;
  transition:all .16s;backdrop-filter:blur(6px)}
.m3d-qbtn:hover{color:${PAL.cyan};border-color:${PAL.cyan};box-shadow:0 0 12px rgba(63,214,255,.3)}
.m3d-qbtn svg{width:16px;height:16px;fill:currentColor}
.m3d-qbtn[aria-pressed="true"]{color:${PAL.amber};border-color:${PAL.amber}}
#m3d-hint{position:absolute;left:12px;bottom:12px;z-index:3;padding:7px 12px;border-radius:9px;
  background:rgba(8,13,29,.78);border:1px solid ${PAL.line};color:${PAL.muted};font-size:11.5px;
  pointer-events:none;transition:opacity .8s;backdrop-filter:blur(6px)}
#m3d-scale{position:absolute;right:12px;bottom:12px;z-index:3;padding:8px 12px;border-radius:10px;
  background:rgba(8,13,29,.8);border:1px solid ${PAL.amber};color:${PAL.text};font-size:11.5px;
  pointer-events:none;display:none;backdrop-filter:blur(6px);text-align:right}
#m3d-scale b{color:${PAL.amber}}
#m3d-panel{flex:0 0 358px;display:flex;flex-direction:column;min-height:0;
  background:linear-gradient(180deg,rgba(13,21,48,.96),rgba(9,14,30,.96));
  border-left:1px solid ${PAL.line};position:relative;z-index:4}
#m3d-panel::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;
  background-image:radial-gradient(rgba(63,214,255,.05) 1px,transparent 1px);background-size:22px 22px}
#m3d-pscroll{flex:1;overflow-y:auto;overflow-x:hidden;padding:14px 16px 20px;position:relative;
  scrollbar-width:thin;scrollbar-color:${PAL.cyan} ${PAL.bg1};touch-action:pan-y}
#m3d-pscroll::-webkit-scrollbar{width:10px}
#m3d-pscroll::-webkit-scrollbar-track{background:linear-gradient(180deg,${PAL.bg1},${PAL.surface});border-radius:5px}
#m3d-pscroll::-webkit-scrollbar-thumb{background:linear-gradient(180deg,${PAL.cyan},${PAL.blue});
  border-radius:5px;border:2px solid ${PAL.bg1}}
#m3d-pscroll::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,${PAL.magenta},${PAL.cyan})}
.m3d-sec{margin-bottom:16px;border:1px solid ${PAL.line};border-radius:12px;overflow:hidden;
  background:rgba(10,16,34,.55)}
.m3d-sec>h3{display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:10.5px;
  letter-spacing:.24em;color:var(--ac,${PAL.cyan});border-bottom:1px solid ${PAL.line};
  background:linear-gradient(90deg,color-mix(in srgb,var(--ac,${PAL.cyan}) 10%,transparent),transparent)}
.m3d-sec>h3::before{content:"";width:7px;height:7px;border-radius:2px;background:var(--ac,${PAL.cyan});
  box-shadow:0 0 8px var(--ac,${PAL.cyan})}
.m3d-sec .body{padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.m3d-row{display:flex;flex-direction:column;gap:4px}
.m3d-row .lab{display:flex;justify-content:space-between;align-items:baseline;font-size:11.5px;color:${PAL.muted}}
.m3d-row .lab output{color:var(--ac,${PAL.cyan});font-size:11px}
.m3d-row input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:22px;background:transparent;cursor:pointer}
.m3d-row input[type=range]::-webkit-slider-runnable-track{height:5px;border-radius:3px;
  background:linear-gradient(90deg,var(--ac,${PAL.cyan}) var(--fill,50%),${PAL.line} var(--fill,50%))}
.m3d-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;margin-top:-5px;
  border-radius:50%;background:${PAL.text};border:2px solid var(--ac,${PAL.cyan});
  box-shadow:0 0 8px color-mix(in srgb,var(--ac,${PAL.cyan}) 60%,transparent);transition:transform .12s}
.m3d-row input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.2)}
.m3d-row input[type=range]::-moz-range-track{height:5px;border-radius:3px;background:${PAL.line}}
.m3d-row input[type=range]::-moz-range-progress{height:5px;border-radius:3px;background:var(--ac,${PAL.cyan})}
.m3d-row input[type=range]::-moz-range-thumb{width:13px;height:13px;border-radius:50%;background:${PAL.text};
  border:2px solid var(--ac,${PAL.cyan})}
.m3d-row select{width:100%;padding:7px 9px;border-radius:8px;border:1px solid ${PAL.line2};
  background:${PAL.surface2};color:${PAL.text};font-size:12px;outline:none}
.m3d-row select:focus-visible{border-color:${PAL.amber}}
.m3d-inline{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11.5px;color:${PAL.muted}}
.m3d-switch{position:relative;width:38px;height:20px;flex:0 0 auto}
.m3d-switch input{position:absolute;opacity:0;inset:0;cursor:pointer;margin:0}
.m3d-switch i{position:absolute;inset:0;border-radius:10px;background:${PAL.line};transition:background .18s;pointer-events:none}
.m3d-switch i::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;
  background:${PAL.muted};transition:transform .18s,background .18s}
.m3d-switch input:checked+i{background:color-mix(in srgb,var(--ac,${PAL.cyan}) 45%,${PAL.line})}
.m3d-switch input:checked+i::after{transform:translateX(18px);background:var(--ac,${PAL.cyan});
  box-shadow:0 0 8px var(--ac,${PAL.cyan})}
.m3d-switch input:focus-visible+i{outline:2px solid ${PAL.amber};outline-offset:2px}
.m3d-seg{display:flex;gap:4px;background:${PAL.bg1};border:1px solid ${PAL.line};border-radius:9px;padding:3px}
.m3d-seg button{flex:1;padding:6px 4px;border-radius:6px;font-size:11px;letter-spacing:.04em;color:${PAL.muted};
  transition:all .15s;white-space:nowrap}
.m3d-seg button[aria-pressed="true"]{color:${PAL.bg0};font-weight:700;
  background:linear-gradient(120deg,var(--ac,${PAL.cyan}),color-mix(in srgb,var(--ac,${PAL.cyan}) 55%,${PAL.blue}))}
.m3d-btn{padding:8px 12px;border-radius:9px;border:1px solid ${PAL.line2};font-size:12px;letter-spacing:.05em;
  background:rgba(17,28,61,.7);color:${PAL.text};transition:all .16s;text-align:center}
.m3d-btn:hover{border-color:var(--ac,${PAL.cyan});box-shadow:0 0 12px color-mix(in srgb,var(--ac,${PAL.cyan}) 35%,transparent)}
.m3d-btn.primary{border:none;font-weight:700;color:${PAL.bg0};
  background:linear-gradient(120deg,${PAL.cyan},${PAL.blue} 55%,${PAL.magenta})}
.m3d-btn.primary:hover{filter:brightness(1.15)}
.m3d-btn.danger:hover{border-color:${PAL.red};box-shadow:0 0 12px rgba(255,84,112,.35)}
.m3d-btnrow{display:flex;gap:8px}.m3d-btnrow .m3d-btn{flex:1}
.m3d-row input[type=color]{width:100%;height:30px;border:1px solid ${PAL.line2};border-radius:8px;
  background:${PAL.surface2};padding:2px;cursor:pointer}
#m3d-foot{flex:0 0 auto;padding:8px 16px;border-top:1px solid ${PAL.line};font-size:10px;
  color:${PAL.dim};letter-spacing:.08em;display:flex;justify-content:space-between}
#m3d-toasts{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:9;
  display:flex;flex-direction:column;gap:7px;align-items:center;pointer-events:none}
.m3d-toast{padding:8px 15px;border-radius:10px;background:rgba(9,14,30,.92);border:1px solid var(--tc,${PAL.cyan});
  color:${PAL.text};font-size:12px;box-shadow:0 8px 26px -8px var(--tc,${PAL.cyan});
  animation:m3dtoast .25s ease-out;backdrop-filter:blur(8px);max-width:78vw;text-align:center}
@keyframes m3dtoast{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
#m3d-keys{position:absolute;top:60px;right:14px;z-index:10;width:230px;padding:12px 14px;border-radius:12px;
  background:rgba(9,14,30,.96);border:1px solid ${PAL.line2};display:none;box-shadow:0 14px 40px -10px #000}
#m3d-keys.open{display:block}
#m3d-keys h4{font-size:10px;letter-spacing:.22em;color:${PAL.cyan};margin-bottom:8px}
#m3d-keys div{display:flex;justify-content:space-between;font-size:11.5px;color:${PAL.muted};padding:2.5px 0}
#m3d-keys kbd{font-family:ui-monospace,monospace;color:${PAL.amber};background:${PAL.surface2};
  border:1px solid ${PAL.line2};border-radius:4px;padding:0 6px;font-size:10.5px}
#m3d-loader{position:absolute;inset:0;z-index:50;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:18px;background:radial-gradient(100% 100% at 50% 30%,#0e1735 0%,${PAL.bg0} 80%);
  transition:opacity .5s}
#m3d-loader.done{opacity:0;pointer-events:none}
#m3d-lcube{width:74px;height:74px;perspective:400px}
#m3d-lcube .c{width:100%;height:100%;position:relative;transform-style:preserve-3d;animation:m3dspin 3.2s linear infinite}
#m3d-lcube .f{position:absolute;inset:8px;border:2px solid ${PAL.cyan};border-radius:4px;
  background:linear-gradient(135deg,rgba(63,214,255,.18),rgba(255,61,158,.14))}
#m3d-lcube .f:nth-child(1){transform:translateZ(29px)}
#m3d-lcube .f:nth-child(2){transform:rotateY(90deg) translateZ(29px);border-color:${PAL.magenta}}
#m3d-lcube .f:nth-child(3){transform:rotateY(180deg) translateZ(29px);border-color:${PAL.blue}}
#m3d-lcube .f:nth-child(4){transform:rotateY(-90deg) translateZ(29px);border-color:${PAL.amber}}
#m3d-lcube .f:nth-child(5){transform:rotateX(90deg) translateZ(29px);border-color:${PAL.green}}
#m3d-lcube .f:nth-child(6){transform:rotateX(-90deg) translateZ(29px);border-color:${PAL.violet}}
#m3d-ltitle{font-size:13px;letter-spacing:.3em;color:${PAL.cyan}}
#m3d-lbar{width:min(340px,72vw);height:5px;border-radius:3px;background:${PAL.line};overflow:hidden}
#m3d-lbar i{display:block;height:100%;width:0%;border-radius:3px;transition:width .25s;
  background:linear-gradient(90deg,${PAL.cyan},${PAL.blue},${PAL.magenta})}
#m3d-lstep{font-size:11.5px;color:${PAL.muted};min-height:16px}
#m3d-lmods{display:flex;gap:5px;flex-wrap:wrap;justify-content:center;max-width:340px}
.m3d-mod{font-size:9.5px;font-family:ui-monospace,monospace;padding:2px 7px;border-radius:5px;
  border:1px solid ${PAL.line};color:${PAL.dim};transition:all .3s}
.m3d-mod.live{border-color:${PAL.green};color:${PAL.green}}
.m3d-mod.shim{border-color:${PAL.amber};color:${PAL.amber}}
#m3d-lerr{display:none;max-width:400px;text-align:center;color:${PAL.red};font-size:12px;line-height:1.6}
#m3d-lerr .m3d-btn{margin-top:10px}
#m3d-prog{position:absolute;top:56px;left:50%;transform:translateX(-50%);z-index:8;padding:5px 14px;
  border-radius:8px;background:rgba(9,14,30,.9);border:1px solid ${PAL.cyan};color:${PAL.cyan};
  font-size:11px;display:none;pointer-events:none}
@media (max-width:900px){
  #m3d-main{flex-direction:column}
  #m3d-panel{flex:0 0 40vh;min-height:250px;border-left:none;border-top:1px solid ${PAL.line}}
  #m3d-sub{display:none}
  .m3d-tab{min-width:170px}
  #m3d-hud{max-width:calc(100% - 110px)}
  #m3d-scale{bottom:8px;right:8px;font-size:10.5px}
}
@media (prefers-reduced-motion:reduce){
  #m3d-logo .c,#m3d-lcube .c{animation:none}
  .m3d-toast{animation:none}
}
`;

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}
const ICONS = {
  sound: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm18.6 3 2.1-2.1-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4-2.1-2.1z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M12 3 2 12h3v8h6v-6h2v6h6v-8h3L12 3z"/></svg>',
  help: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm.1 15.5a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4zm1.6-6.1c-.7.5-.8.8-.8 1.6h-1.8c0-1.4.4-2.1 1.4-2.8.8-.6 1.2-1 1.2-1.7 0-.8-.6-1.3-1.5-1.3-1 0-1.6.6-1.7 1.6H8.6C8.7 6.9 10 5.7 12.1 5.7c2 0 3.4 1.1 3.4 2.8 0 1.2-.6 2-1.8 2.9z"/></svg>'
};

function buildShell() {
  const style = document.createElement("style");
  style.id = "m3d-style"; style.textContent = CSS;
  document.head.appendChild(style);
  document.title = "MAT3 · Cube Lab — 006_mat3_demo";
  const root = el("div"); root.id = "m3d-root";
  root.innerHTML = `
  <div id="m3d-top">
    <div id="m3d-logo"><div class="c"><div class="f"></div><div class="f"></div><div class="f"></div></div></div>
    <div><div id="m3d-title">MAT3 · CUBE LAB</div></div>
    <div id="m3d-sub" class="mono">006_mat3_demo · three r185 · MIT</div>
    <div class="sp"></div>
    <button class="m3d-tbtn" id="m3d-sound" aria-pressed="true" aria-label="Toggle sound">${ICONS.sound}<span>Sound On</span></button>
    <button class="m3d-tbtn" id="m3d-help" aria-label="Shortcuts">${ICONS.help}</button>
  </div>
  <div id="m3d-tabs" role="tablist" aria-label="Examples"></div>
  <div id="m3d-main">
    <div id="m3d-stage">
      <canvas id="m3d-canvas" tabindex="0" aria-label="3D viewport"></canvas>
      <div id="m3d-hud"></div>
      <div id="m3d-quick">
        <button class="m3d-qbtn" id="m3d-qpause" aria-pressed="false" aria-label="Pause simulation">${ICONS.pause}</button>
        <button class="m3d-qbtn" id="m3d-qhome" aria-label="Reset view">${ICONS.home}</button>
        <button class="m3d-qbtn" id="m3d-qsnap" aria-label="Snapshot PNG">${ICONS.cam}</button>
      </div>
      <div id="m3d-hint">Drag to orbit · wheel / pinch to zoom · right-drag / two-finger drag to pan · double-click resets</div>
      <div id="m3d-scale" class="mono"></div>
      <div id="m3d-prog" class="mono"></div>
      <div id="m3d-toasts"></div>
      <div id="m3d-keys">
        <h4>SHORTCUTS</h4>
        <div><span>Examples</span><span><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></span></div>
        <div><span>Pause / resume</span><kbd>Space</kbd></div>
        <div><span>Reset view</span><kbd>R</kbd></div>
        <div><span>Mute</span><kbd>M</kbd></div>
        <div><span>Grid</span><kbd>G</kbd></div>
        <div><span>Snapshot</span><kbd>S</kbd></div>
      </div>
    </div>
    <div id="m3d-panel">
      <div id="m3d-pscroll"></div>
      <div id="m3d-foot"><span>MIT · math 002–009</span><span id="m3d-mathsrc" class="mono">linking…</span></div>
    </div>
  </div>
  <div id="m3d-loader">
    <div id="m3d-lcube"><div class="c"><div class="f"></div><div class="f"></div><div class="f"></div><div class="f"></div><div class="f"></div><div class="f"></div></div></div>
    <div id="m3d-ltitle">MAT3 · CUBE LAB</div>
    <div id="m3d-lbar"><i></i></div>
    <div id="m3d-lstep" class="mono">Linking math lattice…</div>
    <div id="m3d-lmods"></div>
    <div id="m3d-lerr"></div>
  </div>`;
  document.body.appendChild(root);
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  const $ = id => root.querySelector("#" + id);
  return {
    root, style,
    tabs: $("m3d-tabs"), stage: $("m3d-stage"), canvas: $("m3d-canvas"),
    hud: $("m3d-hud"), hint: $("m3d-hint"), scale: $("m3d-scale"), prog: $("m3d-prog"),
    toasts: $("m3d-toasts"), keys: $("m3d-keys"), panel: $("m3d-pscroll"),
    mathsrc: $("m3d-mathsrc"), loader: $("m3d-loader"), lbar: $("m3d-lbar").firstElementChild,
    lstep: $("m3d-lstep"), lmods: $("m3d-lmods"), lerr: $("m3d-lerr"),
    sound: $("m3d-sound"), help: $("m3d-help"),
    qpause: $("m3d-qpause"), qhome: $("m3d-qhome"), qsnap: $("m3d-qsnap")
  };
}

// ----------------------------------------------------------------------------
// 2. Math shims (emergency fallback, formula-parity with the provided modules;
//    used ONLY if a ./math/ module fails to load, so the demo never breaks)
// ----------------------------------------------------------------------------
function makeShims() {
  const F32 = Float32Array, EPS = 1e-6, PI2 = Math.PI * 2;
  const soa = (n, c) => {
    const buf = new ArrayBuffer(n * c * 4), arrays = [];
    for (let i = 0; i < c; i++) arrays.push(new F32(buf, i * n * 4, n));
    return { arrays, buffer: buf, count: n, components: c };
  };
  const hash3 = (x, y, z) => {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2246822519)) | 0;
    h = (h ^ (h >>> 13)) | 0; h = Math.imul(h, 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const kepler = (M, e) => { let E = M; for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); return E; };
  const v3pool = []; for (let i = 0; i < 64; i++) v3pool.push(new F32(3));
  const noise3 = (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    const a = hash3(xi, yi, zi), b = hash3(xi + 1, yi, zi), c = hash3(xi, yi + 1, zi), d = hash3(xi + 1, yi + 1, zi);
    const e = hash3(xi, yi, zi + 1), f = hash3(xi + 1, yi, zi + 1), g = hash3(xi, yi + 1, zi + 1), h = hash3(xi + 1, yi + 1, zi + 1);
    const x00 = a + (b - a) * u, x10 = c + (d - c) * u, x01 = e + (f - e) * u, x11 = g + (h - g) * u;
    const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  };
  const quatFromMat3 = (out, m) => {
    const tr = m[0] + m[4] + m[8]; let S;
    if (tr > 0) { S = Math.sqrt(tr + 1); out[3] = .5 * S; S = .5 / S; out[0] = (m[5] - m[7]) * S; out[1] = (m[6] - m[2]) * S; out[2] = (m[1] - m[3]) * S; }
    else if (m[0] > m[4] && m[0] > m[8]) { S = Math.sqrt(1 + m[0] - m[4] - m[8]); out[0] = .5 * S; S = .5 / S; out[3] = (m[5] - m[7]) * S; out[1] = (m[1] + m[3]) * S; out[2] = (m[6] + m[2]) * S; }
    else if (m[4] > m[8]) { S = Math.sqrt(1 + m[4] - m[0] - m[8]); out[1] = .5 * S; S = .5 / S; out[3] = (m[6] - m[2]) * S; out[0] = (m[1] + m[3]) * S; out[2] = (m[5] + m[7]) * S; }
    else { S = Math.sqrt(1 + m[8] - m[0] - m[4]); out[2] = .5 * S; S = .5 / S; out[3] = (m[1] - m[3]) * S; out[0] = (m[6] + m[2]) * S; out[1] = (m[5] + m[7]) * S; }
    return out;
  };
  const quatToBasis = (qx, qy, qz, qw) => {
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    return [1 - yy - zz, xy + wz, xz - wy, xy - wz, 1 - xx - zz, yz + wx, xz + wy, yz - wx, 1 - xx - yy];
  };
  const noiseQuat = (px, py, pz, s) => {
    const gx = Math.floor(px * s), gy = Math.floor(py * s), gz = Math.floor(pz * s);
    const u1 = hash3(gx, gy, gz), u2 = hash3(gx + 17, gy + 23, gz + 5), u3 = hash3(gx + 3, gy + 11, gz + 29);
    const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
    return [s1 * Math.sin(PI2 * u2), s1 * Math.cos(PI2 * u2), s2 * Math.sin(PI2 * u3), s2 * Math.cos(PI2 * u3)];
  };
  const lookAt3 = (out, fx, fy, fz, ux, uy, uz) => {
    let l = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1e-9; fx /= l; fy /= l; fz /= l;
    const bx = -fx, by = -fy, bz = -fz;
    let rx = uy * bz - uz * by, ry = uz * bx - ux * bz, rz = ux * by - uy * bx;
    const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (rl < EPS) { rx = 1; ry = 0; rz = 0; if (Math.abs(fx) > .9) { rx = 0; ry = 1; rz = 0; } }
    else { const i = 1 / rl; rx *= i; ry *= i; rz *= i; }
    const upx = by * rz - bz * ry, upy = bz * rx - bx * rz, upz = bx * ry - by * rx;
    out[0] = rx; out[1] = ry; out[2] = rz; out[3] = upx; out[4] = upy; out[5] = upz; out[6] = bx; out[7] = by; out[8] = bz;
    return out;
  };
  const springComp = (c, t, v, om, exp, dt, mc) => {
    let ch = c - t; const ot = t;
    if (ch > mc) ch = mc; else if (ch < -mc) ch = -mc;
    t = c - ch; const tmp = (v + om * ch) * dt;
    let nv = (v - om * tmp) * exp, o = t + (ch + tmp) * exp;
    if ((ot - c > 0) === (o > ot)) { o = ot; nv = 0; }
    return [o, nv];
  };
  return {
    vec2: () => ({
      create: () => new F32(2),
      ellipsePoint(out, cx, cy, a, b, t) { out[0] = cx + a * Math.cos(t); out[1] = cy + b * Math.sin(t); return out; }
    }),
    vec3: () => ({
      create: () => new F32(3),
      set(o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; },
      copy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
      sub(o, a, b) { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
      normalize(o, a) { let l = a[0] * a[0] + a[1] * a[1] + a[2] * a[2]; if (l > 0) l = 1 / Math.sqrt(l); o[0] = a[0] * l; o[1] = a[1] * l; o[2] = a[2] * l; return o; },
      length(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); },
      distance(a, b) { const x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2]; return Math.sqrt(x * x + y * y + z * z); },
      acquire() { return v3pool.length ? v3pool.pop() : new F32(3); },
      release(v) { v[0] = v[1] = v[2] = 0; if (v3pool.length < 128) v3pool.push(v); },
      createVec3SOA(n) { const s = soa(n, 3); return { x: s.arrays[0], y: s.arrays[1], z: s.arrays[2], ...s }; },
      soaGet(o, s, i) { o[0] = s.x[i]; o[1] = s.y[i]; o[2] = s.z[i]; return o; },
      soaSet(s, i, v) { s.x[i] = v[0]; s.y[i] = v[1]; s.z[i] = v[2]; return s; },
      soaToRelative(o, a, ox, oy, oz) { for (let i = 0; i < a.count; i++) { o.x[i] = a.x[i] - ox; o.y[i] = a.y[i] - oy; o.z[i] = a.z[i] - oz; } return o; },
      fbm3D(x, y, z, oct = 4) { let s = 0, a = 1, f = 1, n = 0; for (let i = 0; i < oct; i++) { s += a * (noise3(x * f, y * f, z * f) * 2 - 1); n += a; f *= 2; a *= .5; } return .5 + .5 * (s / n); },
      springDamp3(out, cur, tgt, vel, st, dt, ms = Infinity) {
        st = Math.max(st, 1e-4); const om = 2 / st, x = om * dt, exp = 1 / (1 + x + .48 * x * x + .235 * x * x * x), mc = ms * st;
        for (let i = 0; i < 3; i++) { const r = springComp(cur[i], tgt[i], vel[i], om, exp, dt, mc); out[i] = r[0]; vel[i] = r[1]; }
        return out;
      },
      keplerOrbit3D(out, a, e, M, inc, Om, om) {
        const E = kepler(M, e), xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
        const cw = Math.cos(om), sw = Math.sin(om), x1 = xp * cw - yp * sw, y1 = xp * sw + yp * cw;
        const ci = Math.cos(inc), si = Math.sin(inc), y2 = y1 * ci, z2 = y1 * si;
        const cO = Math.cos(Om), sO = Math.sin(Om);
        out[0] = x1 * cO - y2 * sO; out[1] = x1 * sO + y2 * cO; out[2] = z2; return out;
      },
      fabrikStep3(pos, lens, target, tol) {
        const n = lens.length + 1, li = (n - 1) * 3;
        let dx = target[0] - pos[li], dy = target[1] - pos[li + 1], dz = target[2] - pos[li + 2];
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) < tol) return 0;
        const rx = pos[0], ry = pos[1], rz = pos[2];
        pos[li] = target[0]; pos[li + 1] = target[1]; pos[li + 2] = target[2];
        for (let i = n - 2; i >= 0; i--) {
          const id = i * 3, nx = pos[id + 3], ny = pos[id + 4], nz = pos[id + 5];
          const ex = nx - pos[id], ey = ny - pos[id + 1], ez = nz - pos[id + 2];
          const d = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9, r = lens[i] / d;
          pos[id] = nx - ex * r; pos[id + 1] = ny - ey * r; pos[id + 2] = nz - ez * r;
        }
        pos[0] = rx; pos[1] = ry; pos[2] = rz;
        for (let j = 1; j < n; j++) {
          const id = j * 3, pid = id - 3;
          const ex = pos[id] - pos[pid], ey = pos[id + 1] - pos[pid + 1], ez = pos[id + 2] - pos[pid + 2];
          const d = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9, r = lens[j - 1] / d;
          pos[id] = pos[pid] + ex * r; pos[id + 1] = pos[pid + 1] + ey * r; pos[id + 2] = pos[pid + 2] + ez * r;
        }
        dx = pos[li] - target[0]; dy = pos[li + 1] - target[1]; dz = pos[li + 2] - target[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
      },
      ccdStep3(pos, target, iters = 1) {
        const n = (pos.length / 3) | 0;
        for (let k = 0; k < iters; k++) for (let i = n - 2; i >= 0; i--) {
          const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
          let ex = target[0] - px, ey = target[1] - py, ez = target[2] - pz;
          let fx = pos[(n - 1) * 3] - px, fy = pos[(n - 1) * 3 + 1] - py, fz = pos[(n - 1) * 3 + 2] - pz;
          const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-9, fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1e-9;
          ex /= el; ey /= el; ez /= el; fx /= fl; fy /= fl; fz /= fl;
          const c = ex * fx + ey * fy + ez * fz; if (c > .9999) continue;
          const ang = Math.acos(clamp(c, -1, 1));
          let ax = fy * ez - fz * ey, ay = fz * ex - fx * ez, az = fx * ey - fy * ex;
          const al = Math.sqrt(ax * ax + ay * ay + az * az); if (al < 1e-9) continue;
          ax /= al; ay /= al; az /= al;
          const s = Math.sin(ang), co = Math.cos(ang), ic = 1 - co;
          for (let j = i + 1; j < n; j++) {
            const rx = pos[j * 3] - px, ry = pos[j * 3 + 1] - py, rz = pos[j * 3 + 2] - pz;
            const dp = ax * rx + ay * ry + az * rz;
            const cx = ay * rz - az * ry, cy = az * rx - ax * rz, cz = ax * ry - ay * rx;
            pos[j * 3] = px + rx * co + cx * s + ax * dp * ic;
            pos[j * 3 + 1] = py + ry * co + cy * s + ay * dp * ic;
            pos[j * 3 + 2] = pz + rz * co + cz * s + az * dp * ic;
          }
        }
        const dx = pos[(n - 1) * 3] - target[0], dy = pos[(n - 1) * 3 + 1] - target[1], dz = pos[(n - 1) * 3 + 2] - target[2];
        return dx * dx + dy * dy + dz * dz;
      }
    }),
    vec4: () => ({
      createVec4SOA(n) { const s = soa(n, 4); return { x: s.arrays[0], y: s.arrays[1], z: s.arrays[2], w: s.arrays[3], ...s }; },
      soaSet(s, i, v) { s.x[i] = v[0]; s.y[i] = v[1]; s.z[i] = v[2]; s.w[i] = v[3]; return s; },
      soaToFlat(o, s, off = 0) { for (let i = 0; i < s.count; i++) { const j = off + i * 4; o[j] = s.x[i]; o[j + 1] = s.y[i]; o[j + 2] = s.z[i]; o[j + 3] = s.w[i]; } return o; }
    }),
    mat2: () => ({
      create() { const o = new F32(4); o[0] = o[3] = 1; return o; },
      fromRotation(o, r) { const s = Math.sin(r), c = Math.cos(r); o[0] = c; o[1] = s; o[2] = -s; o[3] = c; return o; }
    }),
    mat3: () => ({
      create() { const o = new F32(9); o[0] = o[4] = o[8] = 1; return o; },
      createMat3SOA(n) {
        const s = soa(n, 9);
        return { m00: s.arrays[0], m01: s.arrays[1], m02: s.arrays[2], m10: s.arrays[3], m11: s.arrays[4], m12: s.arrays[5], m20: s.arrays[6], m21: s.arrays[7], m22: s.arrays[8], ...s };
      },
      soaFromQuatSOA(out, q) {
        for (let i = 0; i < out.count; i++) {
          const b = quatToBasis(q.x[i], q.y[i], q.z[i], q.w[i]);
          out.m00[i] = b[0]; out.m01[i] = b[1]; out.m02[i] = b[2];
          out.m10[i] = b[3]; out.m11[i] = b[4]; out.m12[i] = b[5];
          out.m20[i] = b[6]; out.m21[i] = b[7]; out.m22[i] = b[8];
        } return out;
      },
      soaFillFromNoise(out, p, s = 1) {
        for (let i = 0; i < out.count; i++) {
          const q = noiseQuat(p.x[i], p.y[i], p.z[i], s), b = quatToBasis(q[0], q[1], q[2], q[3]);
          out.m00[i] = b[0]; out.m01[i] = b[1]; out.m02[i] = b[2];
          out.m10[i] = b[3]; out.m11[i] = b[4]; out.m12[i] = b[5];
          out.m20[i] = b[6]; out.m21[i] = b[7]; out.m22[i] = b[8];
        } return out;
      },
      soaTransformVec3(ox, oy, oz, m, v) {
        for (let i = 0; i < m.count; i++) {
          const x = v.x[i], y = v.y[i], z = v.z[i];
          ox[i] = m.m00[i] * x + m.m10[i] * y + m.m20[i] * z;
          oy[i] = m.m01[i] * x + m.m11[i] * y + m.m21[i] * z;
          oz[i] = m.m02[i] * x + m.m12[i] * y + m.m22[i] * z;
        } return ox;
      },
      soaBuildTBN(out, N, T, H) {
        for (let i = 0; i < out.count; i++) {
          const nx = N.x[i], ny = N.y[i], nz = N.z[i];
          let tx = T.x[i], ty = T.y[i], tz = T.z[i];
          const d = tx * nx + ty * ny + tz * nz; tx -= d * nx; ty -= d * ny; tz -= d * nz;
          let l = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (l < EPS) { if (Math.abs(nx) < .99) { tx = 0; ty = -nz; tz = ny; } else { tx = 1; ty = 0; tz = 0; } l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1; }
          const il = 1 / l; tx *= il; ty *= il; tz *= il;
          let bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
          if (H && H[i] < 0) { bx = -bx; by = -by; bz = -bz; }
          out.m00[i] = tx; out.m01[i] = ty; out.m02[i] = tz;
          out.m10[i] = bx; out.m11[i] = by; out.m12[i] = bz;
          out.m20[i] = nx; out.m21[i] = ny; out.m22[i] = nz;
        } return out;
      },
      fromHueRotation(o, rad) {
        const cA = Math.cos(rad), sA = Math.sin(rad);
        const yr = .299, yg = .587, yb = .114, ir = .596, ig = -.274, ib = -.322, qr = .211, qg = -.523, qb = .312;
        const nir = cA * ir - sA * qr, nig = cA * ig - sA * qg, nib = cA * ib - sA * qb;
        const nqr = sA * ir + cA * qr, nqg = sA * ig + cA * qg, nqb = sA * ib + cA * qb;
        o[0] = yr + .956 * nir + .621 * nqr; o[1] = yg + .956 * nig + .621 * nqg; o[2] = yb + .956 * nib + .621 * nqb;
        o[3] = yr - .272 * nir - .647 * nqr; o[4] = yg - .272 * nig - .647 * nqg; o[5] = yb - .272 * nib - .647 * nqb;
        o[6] = yr - 1.106 * nir + 1.703 * nqr; o[7] = yg - 1.106 * nig + 1.703 * nqg; o[8] = yb - 1.106 * nib + 1.703 * nqb;
        return o;
      },
      fromSaturation(o, s) {
        const lr = .2126, lg = .7152, lb = .0722, iv = 1 - s;
        o[0] = lr * iv + s; o[1] = lg * iv; o[2] = lb * iv;
        o[3] = lr * iv; o[4] = lg * iv + s; o[5] = lb * iv;
        o[6] = lr * iv; o[7] = lg * iv; o[8] = lb * iv + s; return o;
      },
      soaApplyColorMatrix(out, c, m) {
        for (let i = 0; i < c.count; i++) {
          const r = c.x[i], g = c.y[i], b = c.z[i];
          out.x[i] = m[0] * r + m[1] * g + m[2] * b;
          out.y[i] = m[3] * r + m[4] * g + m[5] * b;
          out.z[i] = m[6] * r + m[7] * g + m[8] * b;
        } return out;
      },
      fromOrbitalFrame(o, inc, Om, om) {
        const cw = Math.cos(om), sw = Math.sin(om), ci = Math.cos(inc), si = Math.sin(inc), cO = Math.cos(Om), sO = Math.sin(Om);
        o[0] = cO * cw - sO * sw * ci; o[1] = sO * cw + cO * sw * ci; o[2] = sw * si;
        o[3] = -cO * sw - sO * cw * ci; o[4] = -sO * sw + cO * cw * ci; o[5] = cw * si;
        o[6] = sO * si; o[7] = -cO * si; o[8] = ci; return o;
      },
      soaFillFromOrbitalFrame(out, I, O, W) {
        const t = new F32(9);
        for (let i = 0; i < out.count; i++) {
          this.fromOrbitalFrame(t, I[i], O[i], W[i]);
          out.m00[i] = t[0]; out.m01[i] = t[1]; out.m02[i] = t[2];
          out.m10[i] = t[3]; out.m11[i] = t[4]; out.m12[i] = t[5];
          out.m20[i] = t[6]; out.m21[i] = t[7]; out.m22[i] = t[8];
        } return out;
      },
      fromBoneDirection(o, dx, dy, dz, ux, uy, uz) { return lookAt3(o, dx, dy, dz, ux, uy, uz); },
      compose(o, sx, sy, sz, qx, qy, qz, qw) {
        const b = quatToBasis(qx, qy, qz, qw);
        o[0] = b[0] * sx; o[1] = b[1] * sx; o[2] = b[2] * sx;
        o[3] = b[3] * sy; o[4] = b[4] * sy; o[5] = b[5] * sy;
        o[6] = b[6] * sz; o[7] = b[7] * sz; o[8] = b[8] * sz; return o;
      },
      blendRotation(out, a, b, t) {
        const dec = m => {
          const sx = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]) || 1;
          const sy = Math.sqrt(m[3] * m[3] + m[4] * m[4] + m[5] * m[5]) || 1;
          const sz = Math.sqrt(m[6] * m[6] + m[7] * m[7] + m[8] * m[8]) || 1;
          const r = new F32(9);
          r[0] = m[0] / sx; r[1] = m[1] / sx; r[2] = m[2] / sx;
          r[3] = m[3] / sy; r[4] = m[4] / sy; r[5] = m[5] / sy;
          r[6] = m[6] / sz; r[7] = m[7] / sz; r[8] = m[8] / sz;
          const q = new F32(4); quatFromMat3(q, r); return [q, sx, sy, sz];
        };
        const A = dec(a), B = dec(b);
        let [aq, asx, asy, asz] = A, [bq, bsx, bsy, bsz] = B;
        let d = aq[0] * bq[0] + aq[1] * bq[1] + aq[2] * bq[2] + aq[3] * bq[3];
        if (d < 0) { bq = bq.map(v => -v); d = -d; }
        let s0, s1;
        if (1 - d > EPS) { const om = Math.acos(clamp(d, -1, 1)), sn = Math.sin(om); s0 = Math.sin((1 - t) * om) / sn; s1 = Math.sin(t * om) / sn; }
        else { s0 = 1 - t; s1 = t; }
        return this.compose(out, lerp(asx, bsx, t), lerp(asy, bsy, t), lerp(asz, bsz, t),
          s0 * aq[0] + s1 * bq[0], s0 * aq[1] + s1 * bq[1], s0 * aq[2] + s1 * bq[2], s0 * aq[3] + s1 * bq[3]);
      }
    }),
    mat4: () => ({
      create() { const o = new F32(16); o[0] = o[5] = o[10] = o[15] = 1; return o; },
      fromRotationTranslationScale(o, q, v, s) {
        const b = quatToBasis(q[0], q[1], q[2], q[3]);
        const sx = typeof s === "number" ? s : s[0], sy = typeof s === "number" ? s : s[1], sz = typeof s === "number" ? s : s[2];
        o[0] = b[0] * sx; o[1] = b[1] * sx; o[2] = b[2] * sx; o[3] = 0;
        o[4] = b[3] * sy; o[5] = b[4] * sy; o[6] = b[5] * sy; o[7] = 0;
        o[8] = b[6] * sz; o[9] = b[7] * sz; o[10] = b[8] * sz; o[11] = 0;
        o[12] = v[0]; o[13] = v[1]; o[14] = v[2]; o[15] = 1; return o;
      },
      fromQuat2(o, a) {
        const bx = -a[0], by = -a[1], bz = -a[2], bw = a[3];
        const ax = a[4], ay = a[5], az = a[6], aw = a[7];
        const t = [
          (ax * bw + aw * bx + ay * bz - az * by) * 2,
          (ay * bw + aw * by + az * bx - ax * bz) * 2,
          (az * bw + aw * bz + ax * by - ay * bx) * 2];
        return this.fromRotationTranslationScale(o, a, t, 1);
      },
      scale(o, a, v) {
        const x = v[0], y = v[1], z = v[2];
        o[0] = a[0] * x; o[1] = a[1] * x; o[2] = a[2] * x; o[3] = a[3] * x;
        o[4] = a[4] * y; o[5] = a[5] * y; o[6] = a[6] * y; o[7] = a[7] * y;
        o[8] = a[8] * z; o[9] = a[9] * z; o[10] = a[10] * z; o[11] = a[11] * z;
        o[12] = a[12]; o[13] = a[13]; o[14] = a[14]; o[15] = a[15]; return o;
      }
    }),
    quat: () => ({
      create() { const o = new F32(4); o[3] = 1; return o; },
      fromMat3: quatFromMat3,
      normalize(o, a) { let l = a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]; if (l > 0) l = 1 / Math.sqrt(l); o[0] = a[0] * l; o[1] = a[1] * l; o[2] = a[2] * l; o[3] = a[3] * l; return o; },
      slerp(o, a, b, t) {
        let bx = b[0], by = b[1], bz = b[2], bw = b[3];
        let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
        if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        let s0, s1;
        if (1 - d > EPS) { const om = Math.acos(clamp(d, -1, 1)), sn = Math.sin(om); s0 = Math.sin((1 - t) * om) / sn; s1 = Math.sin(t * om) / sn; }
        else { s0 = 1 - t; s1 = t; }
        o[0] = s0 * a[0] + s1 * bx; o[1] = s0 * a[1] + s1 * by; o[2] = s0 * a[2] + s1 * bz; o[3] = s0 * a[3] + s1 * bw; return o;
      },
      createQuatSOA(n) { const s = soa(n, 4); s.arrays[3].fill(1); return { x: s.arrays[0], y: s.arrays[1], z: s.arrays[2], w: s.arrays[3], ...s }; },
      soaFillFromNoise(out, p, s = 1) {
        for (let i = 0; i < out.count; i++) { const q = noiseQuat(p.x[i], p.y[i], p.z[i], s); out.x[i] = q[0]; out.y[i] = q[1]; out.z[i] = q[2]; out.w[i] = q[3]; }
        return out;
      },
      soaFillSpinFrom4DNoise(out, p, time, freq = 1, amp = PI2) {
        for (let i = 0; i < out.count; i++) {
          const x = p.x[i] * freq, y = p.y[i] * freq, z = p.z[i] * freq;
          const ax = (hash3(Math.floor(x), Math.floor(y), Math.floor(z)) + time * .31) * amp;
          const ay = (hash3(Math.floor(y) + 41, Math.floor(z) + 17, Math.floor(x) + 23) + time * .73) * amp;
          const az = (hash3(Math.floor(z) + 3, Math.floor(x) + 11, Math.floor(y) + 29) + time * .97) * amp;
          const sx = Math.sin(ax * .5), cx = Math.cos(ax * .5), sy = Math.sin(ay * .5), cy = Math.cos(ay * .5), sz = Math.sin(az * .5), cz = Math.cos(az * .5);
          out.x[i] = sx * cy * cz - cx * sy * sz; out.y[i] = cx * sy * cz + sx * cy * sz;
          out.z[i] = cx * cy * sz - sx * sy * cz; out.w[i] = cx * cy * cz + sx * sy * sz;
        } return out;
      },
      soaFillFromVelocity(out, v) {
        for (let i = 0; i < out.count; i++) {
          let dx = v.x[i], dy = v.y[i], dz = v.z[i];
          const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (l < EPS) { out.x[i] = 0; out.y[i] = 0; out.z[i] = 0; out.w[i] = 1; continue; }
          const il = 1 / l; dx *= il; dy *= il; dz *= il;
          const w = 1 + dx;
          if (w < EPS) { out.x[i] = 0; out.y[i] = 1; out.z[i] = 0; out.w[i] = 0; }
          else {
            let qx = 0, qy = -dz, qz = dy, qw = w;
            const ql = 1 / Math.sqrt(qy * qy + qz * qz + qw * qw);
            out.x[i] = qx * ql; out.y[i] = qy * ql; out.z[i] = qz * ql; out.w[i] = qw * ql;
          }
        } return out;
      }
    }),
    quat2: () => ({
      create() { const o = new F32(8); o[3] = 1; return o; },
      getReal(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; return o; },
      getTranslation(o, a) {
        const ax = a[4], ay = a[5], az = a[6], aw = a[7];
        const bx = -a[0], by = -a[1], bz = -a[2], bw = a[3];
        o[0] = (ax * bw + aw * bx + ay * bz - az * by) * 2;
        o[1] = (ay * bw + aw * by + az * bx - ax * bz) * 2;
        o[2] = (az * bw + aw * bz + ax * by - ay * bx) * 2; return o;
      },
      fromOrbitalElements(out, a, e, M, inc, Om, om) {
        const E = kepler(M, e), xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
        const hO = Om * .5, hI = inc * .5, hW = om * .5;
        const sO = Math.sin(hO), cO = Math.cos(hO), sI = Math.sin(hI), cI = Math.cos(hI), sW = Math.sin(hW), cW = Math.cos(hW);
        const qz0 = cO * sI, qz1 = sO * sI, qz2 = sO * cI, qz3 = cO * cI;
        const qx = qz0 * cW + qz1 * sW, qy = qz1 * cW - qz0 * sW, qz = qz2 * cW + qz3 * sW, qw = qz3 * cW - qz2 * sW;
        const r00 = cO * cW - sO * sW * cI, r01 = -cO * sW - sO * cW * cI;
        const r10 = sO * cW + cO * sW * cI, r11 = -sO * sW + cO * cW * cI;
        const px = r00 * xp + r01 * yp, py = r10 * xp + r11 * yp, pz = sW * sI * xp + cW * sI * yp;
        const ax = px * .5, ay = py * .5, az = pz * .5;
        out[0] = qx; out[1] = qy; out[2] = qz; out[3] = qw;
        out[4] = ax * qw + ay * qz - az * qy; out[5] = ay * qw + az * qx - ax * qz;
        out[6] = az * qw + ax * qy - ay * qx; out[7] = -ax * qx - ay * qy - az * qz;
        return out;
      }
    })
  };
}

async function loadMath(shell) {
  const shims = makeShims();
  const M = {}, sources = {};
  const names = Object.keys(MATH_FILES);
  for (let i = 0; i < names.length; i++) {
    const name = names[i], file = MATH_FILES[name];
    const chip = el("span", "m3d-mod", file.slice(0, 3));
    shell.lmods.appendChild(chip);
    let mod = null;
    for (const base of ["./math/", "./"]) {
      try {
        const m = await import(base + file);
        if (m && typeof m.create === "function" || m && typeof m.createVec3SOA === "function" || m && typeof m.fromOrbitalElements === "function") { mod = m; break; }
      } catch (e) { /* try next base, then shim */ }
    }
    if (mod) { M[name] = mod; sources[name] = "live"; chip.classList.add("live"); }
    else { M[name] = shims[name](); sources[name] = "shim"; chip.classList.add("shim"); }
    shell.lbar.style.width = (8 + (i + 1) / names.length * 30) + "%";
    shell.lstep.textContent = "Linking " + file + (sources[name] === "shim" ? " (fallback shim)" : "");
    await yieldToMain();
  }
  const live = Object.values(sources).filter(s => s === "live").length;
  shell.mathsrc.textContent = live === names.length ? "math: live 002–009" : `math: ${live} live / ${names.length - live} shim`;
  shell.mathsrc.style.color = live === names.length ? PAL.green : PAL.amber;
  return { M, sources };
}

function importTimeout(url, ms) {
  return Promise.race([
    import(url),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + url)), ms))
  ]);
}
async function loadThree(shell) {
  shell.lstep.textContent = "Igniting Three.js r185 (CDN)…";
  let lastErr = null;
  for (let i = 0; i < THREE_CDNS.length; i++) {
    try {
      const T = await importTimeout(THREE_CDNS[i], 14000);
      if (T && T.WebGLRenderer) { shell.lbar.style.width = "52%"; return T; }
    } catch (e) { lastErr = e; shell.lstep.textContent = "CDN " + (i + 1) + " unavailable — trying next origin…"; }
  }
  throw lastErr || new Error("All Three.js CDN origins failed");
}

// ----------------------------------------------------------------------------
// 3. WebAudio engine (ambience + visible-action feedback, single top mute)
// ----------------------------------------------------------------------------
class AudioEngine {
  constructor() { this.ctx = null; this.master = null; this.enabled = true; this.started = false; this._tickAt = 0; this.amb = null; }
  _ensure() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.14 : 0;
    this.master.connect(this.ctx.destination);
    const g = this.ctx.createGain(); g.gain.value = 0.5; g.connect(this.master);
    const lp = this.ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420; lp.Q.value = 0.4; lp.connect(g);
    const o1 = this.ctx.createOscillator(); o1.type = "triangle"; o1.frequency.value = 110;
    const o2 = this.ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = 165;
    const g1 = this.ctx.createGain(); g1.gain.value = 0.35; const g2 = this.ctx.createGain(); g2.gain.value = 0.22;
    o1.connect(g1); g1.connect(lp); o2.connect(g2); g2.connect(lp);
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = this.ctx.createGain(); lfoG.gain.value = 0.16;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    const nb = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const nd = nb.getChannelData(0); let l = 0;
    for (let i = 0; i < nd.length; i++) { l = l * 0.97 + (Math.random() * 2 - 1) * 0.03; nd[i] = l * 6; }
    const ns = this.ctx.createBufferSource(); ns.buffer = nb; ns.loop = true;
    const bp = this.ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 800; bp.Q.value = 0.6;
    const ng = this.ctx.createGain(); ng.gain.value = 0.05;
    ns.connect(bp); bp.connect(ng); ng.connect(this.master);
    o1.start(); o2.start(); lfo.start(); ns.start();
    this.amb = { o1, o2, g1, g2, lp, ng, bp };
    return true;
  }
  unlock() {
    if (!this._ensure()) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.started = true;
  }
  setEnabled(on) {
    this.enabled = on;
    if (this.ctx && this.master) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(on ? 0.14 : 0, t, 0.05);
    }
  }
  setDemo(idx) {
    if (!this.ctx || !this.amb) return;
    const t = this.ctx.currentTime, a = this.amb;
    const cfg = [
      { f1: 110, f2: 165, lp: 420, ng: 0.04, bp: 800 },
      { f1: 55, f2: 82.5, lp: 300, ng: 0.09, bp: 620 },
      { f1: 82.4, f2: 123.5, lp: 520, ng: 0.03, bp: 1100 }][idx] || { f1: 110, f2: 165, lp: 420, ng: 0.04, bp: 800 };
    a.o1.frequency.setTargetAtTime(cfg.f1, t, 0.6);
    a.o2.frequency.setTargetAtTime(cfg.f2, t, 0.6);
    a.lp.frequency.setTargetAtTime(cfg.lp, t, 0.6);
    a.ng.gain.setTargetAtTime(cfg.ng, t, 0.6);
    a.bp.frequency.setTargetAtTime(cfg.bp, t, 0.6);
  }
  _blip(freq, dur, gain, type = "square") {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const f = this.ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = freq; f.Q.value = 2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  tick(v01) {
    const now = performance.now();
    if (now - this._tickAt < 70) return;
    this._tickAt = now;
    this._blip(900 + v01 * 1400, 0.05, 0.05);
  }
  whoosh() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const nb = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.4, this.ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const s = this.ctx.createBufferSource(); s.buffer = nb;
    const f = this.ctx.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(2600, t + 0.32);
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t);
    this._blip(523, 0.3, 0.05, "sine"); this._blip(784, 0.34, 0.04, "sine");
  }
  shutter() { this._blip(2400, 0.04, 0.09); setTimeout(() => this._blip(1600, 0.05, 0.07), 60); }
  sparkle() { [660, 880, 1174, 1568].forEach((f, i) => setTimeout(() => this._blip(f, 0.12, 0.05, "sine"), i * 55)); }
  dispose() { if (this.ctx) { try { this.ctx.close(); } catch (e) { /* noop */ } this.ctx = null; } }
}

// ----------------------------------------------------------------------------
// 4. Main application (deferred init after deps resolve)
// ----------------------------------------------------------------------------
async function main() {
  const shell = buildShell();
  const audio = new AudioEngine();
  const setLoad = (pct, label) => { shell.lbar.style.width = pct + "%"; if (label) shell.lstep.textContent = label; };

  let M, mathSources, THREE;
  try {
    ({ M, sources: mathSources } = await loadMath(shell));
    THREE = await loadThree(shell);
  } catch (err) {
    shell.lerr.style.display = "block";
    shell.lerr.innerHTML = `<b>Renderer could not start.</b><br>${String(err && err.message || err)}<br>
      <span style="color:${PAL.muted}">ES modules need an http origin (file:// is blocked by the browser).
      Any static host or Android WebView works — no build step required.</span><br>
      <button class="m3d-btn primary" id="m3d-retry">Retry CDN</button>`;
    shell.lerr.querySelector("#m3d-retry").addEventListener("click", async () => {
      shell.lerr.style.display = "none";
      try { THREE = await loadThree(shell); boot(); } catch (e) { shell.lerr.style.display = "block"; }
    });
    return;
  }

  // --------------------------------------------------------------------------
  // Renderer + HDR bloom pipeline (bright -> blur half -> blur quarter -> comp)
  // --------------------------------------------------------------------------
  const canvas = shell.canvas;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false,
      powerPreference: "high-performance", preserveDrawingBuffer: false
    });
  } catch (err) {
    shell.lerr.style.display = "block";
    shell.lerr.innerHTML = "<b>WebGL2 unavailable on this device.</b><br>" + String(err.message || err);
    return;
  }
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  const hasFloat = !!renderer.extensions.get("EXT_color_buffer_float");
  const RT_TYPE = hasFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;

  const QUALITY = {
    high: { dpr: 2, samples: 4, bloomDiv: 2 },
    balanced: { dpr: 1.5, samples: 0, bloomDiv: 2 },
    perf: { dpr: 1, samples: 0, bloomDiv: 3 }
  };
  const state = {
    qualityMode: "auto", tier: "balanced", autoTierIdx: 1,
    paused: false, dragging: false, active: 0, simTime: 0,
    bloom: 1.0, exposure: 1.05, fog: 0.012, grid: true, atmosphere: true,
    autoOrbit: true, keyColor: "#bfe9ff", keyIntensity: 3,
    disposed: false, contextLost: false
  };
  const TIERS = ["perf", "balanced", "high"];

  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quadCam = new THREE.Camera();
  const quadScene = new THREE.Scene();
  const quadMesh = new THREE.Mesh(quadGeo, null);
  quadMesh.frustumCulled = false;
  quadScene.add(quadMesh);
  const QUAD_VS = `varying vec2 vUv;void main(){vUv=position.xy*0.5+0.5;gl_Position=vec4(position.xy,0.0,1.0);}`;
  const brightMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uThresh: { value: 0.85 }, uKnee: { value: 0.4 } },
    vertexShader: QUAD_VS, depthTest: false, depthWrite: false,
    fragmentShader: `uniform sampler2D tSrc;uniform float uThresh,uKnee;varying vec2 vUv;
      void main(){vec3 c=texture2D(tSrc,vUv).rgb;float l=dot(c,vec3(0.2126,0.7152,0.0722));
      float w=smoothstep(uThresh,uThresh+uKnee,l);gl_FragColor=vec4(c*w,1.0);}`
  });
  const blurMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2() } },
    vertexShader: QUAD_VS, depthTest: false, depthWrite: false,
    fragmentShader: `uniform sampler2D tSrc;uniform vec2 uDir,uTexel;varying vec2 vUv;
      void main(){vec2 o=uDir*uTexel;
      vec3 c=texture2D(tSrc,vUv).rgb*0.227027;
      c+=(texture2D(tSrc,vUv+o*1.3846).rgb+texture2D(tSrc,vUv-o*1.3846).rgb)*0.3162162;
      c+=(texture2D(tSrc,vUv+o*3.2308).rgb+texture2D(tSrc,vUv-o*3.2308).rgb)*0.0702703;
      gl_FragColor=vec4(c,1.0);}`
  });
  const compMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null }, tBloomA: { value: null }, tBloomB: { value: null },
      uBloom: { value: 1 }, uExposure: { value: 1.05 }, uVig: { value: 0.32 },
      uGrain: { value: REDUCED ? 0 : 0.035 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }
    },
    vertexShader: QUAD_VS, depthTest: false, depthWrite: false,
    fragmentShader: `uniform sampler2D tScene,tBloomA,tBloomB;
      uniform float uBloom,uExposure,uVig,uGrain,uTime;uniform vec2 uRes;varying vec2 vUv;
      vec3 aces(vec3 x){return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0);}
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      void main(){
        vec3 c=texture2D(tScene,vUv).rgb;
        c+=(texture2D(tBloomA,vUv).rgb*0.65+texture2D(tBloomB,vUv).rgb*0.85)*uBloom;
        c*=uExposure; c=aces(c);
        vec2 q=vUv-0.5; c*=1.0-uVig*dot(q,q)*2.4;
        c+=(hash(vUv*uRes+fract(uTime)*7.0)-0.5)*uGrain;
        c=pow(max(c,0.0),vec3(1.0/2.2));
        gl_FragColor=vec4(c,1.0);}`
  });
  const pipeline = {
    rtScene: null, rtA: null, rtB: null, rtC: null, rtD: null, w: 2, h: 2,
    make(w, h, samples) {
      const o = { type: RT_TYPE, depthBuffer: true, samples: samples || 0 };
      return new THREE.WebGLRenderTarget(Math.max(2, w), Math.max(2, h), o);
    },
    resize(cssW, cssH) {
      const q = QUALITY[state.tier];
      const dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
      renderer.setPixelRatio(dpr);
      renderer.setSize(cssW, cssH, false);
      const w = Math.max(2, Math.floor(cssW * dpr)), h = Math.max(2, Math.floor(cssH * dpr));
      this.w = w; this.h = h;
      for (const k of ["rtScene", "rtA", "rtB", "rtC", "rtD"]) if (this[k]) this[k].dispose();
      this.rtScene = this.make(w, h, q.samples);
      const bw = Math.max(2, Math.floor(w / q.bloomDiv)), bh = Math.max(2, Math.floor(h / q.bloomDiv));
      const qw = Math.max(2, bw >> 1), qh = Math.max(2, bh >> 1);
      this.rtA = this.make(bw, bh, 0); this.rtB = this.make(bw, bh, 0);
      this.rtC = this.make(qw, qh, 0); this.rtD = this.make(qw, qh, 0);
      compMat.uniforms.uRes.value.set(w, h);
    },
    pass(mat, target) {
      quadMesh.material = mat;
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCam);
    },
    render(scene, camera) {
      renderer.setRenderTarget(this.rtScene);
      renderer.render(scene, camera);
      brightMat.uniforms.tSrc.value = this.rtScene.texture;
      this.pass(brightMat, this.rtA);
      blurMat.uniforms.tSrc.value = this.rtA.texture;
      blurMat.uniforms.uTexel.value.set(1 / this.rtA.width, 1 / this.rtA.height);
      blurMat.uniforms.uDir.value.set(1, 0); this.pass(blurMat, this.rtB);
      blurMat.uniforms.tSrc.value = this.rtB.texture;
      blurMat.uniforms.uDir.value.set(0, 1); this.pass(blurMat, this.rtA);
      blurMat.uniforms.tSrc.value = this.rtA.texture;
      blurMat.uniforms.uTexel.value.set(1 / this.rtC.width, 1 / this.rtC.height);
      blurMat.uniforms.uDir.value.set(1, 0); this.pass(blurMat, this.rtC);
      blurMat.uniforms.tSrc.value = this.rtC.texture;
      blurMat.uniforms.uDir.value.set(0, 1); this.pass(blurMat, this.rtD);
      compMat.uniforms.tScene.value = this.rtScene.texture;
      compMat.uniforms.tBloomA.value = this.rtA.texture;
      compMat.uniforms.tBloomB.value = this.rtD.texture;
      compMat.uniforms.uBloom.value = state.bloom;
      compMat.uniforms.uExposure.value = state.exposure;
      compMat.uniforms.uTime.value = state.simTime;
      this.pass(compMat, null);
    },
    dispose() { for (const k of ["rtScene", "rtA", "rtB", "rtC", "rtD"]) if (this[k]) this[k].dispose(); }
  };

  // --------------------------------------------------------------------------
  // Scene, camera, damped orbit rig (drag / wheel / pinch / pan)
  // --------------------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAL.bg0);
  scene.fog = new THREE.FogExp2(new THREE.Color("#070c1c"), state.fog);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);

  const rig = {
    theta: 0.8, phi: 1.1, radius: 26, target: new THREE.Vector3(0, 3, 0),
    tTheta: 0.8, tPhi: 1.1, tRadius: 26, tTarget: new THREE.Vector3(0, 3, 0),
    minR: 4, maxR: 400, lastInput: 0,
    preset(p) {
      this.tTheta = p.theta; this.tPhi = p.phi; this.tRadius = p.radius;
      this.tTarget.set(p.tx, p.ty, p.tz); this.minR = p.minR || 4; this.maxR = p.maxR || 400;
    },
    rotate(dx, dy) { this.tTheta -= dx * 0.0052; this.tPhi = clamp(this.tPhi - dy * 0.0052, 0.08, Math.PI - 0.08); this.lastInput = performance.now(); },
    dolly(f) { this.tRadius = clamp(this.tRadius * f, this.minR, this.maxR); this.lastInput = performance.now(); },
    pan(dx, dy) {
      const k = this.radius * 0.0016;
      const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
      const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
      const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
      this.tTarget.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      if (this.tTarget.length() > 600) this.tTarget.setLength(600);
      this.lastInput = performance.now();
    },
    update(dt) {
      if (state.autoOrbit && !REDUCED && performance.now() - this.lastInput > 2600 && !state.dragging)
        this.tTheta += dt * 0.07;
      const k = dampK(dt, 9);
      this.theta = lerp(this.theta, this.tTheta, k);
      this.phi = lerp(this.phi, this.tPhi, k);
      this.radius = lerp(this.radius, this.tRadius, k);
      this.target.lerp(this.tTarget, k);
      const sp = Math.sin(this.phi);
      camera.position.set(
        this.target.x + this.radius * sp * Math.sin(this.theta),
        this.target.y + this.radius * Math.cos(this.phi),
        this.target.z + this.radius * sp * Math.cos(this.theta));
      camera.lookAt(this.target);
      camera.near = Math.max(0.02, this.radius * 0.002);
      camera.far = this.radius * 40 + 500;
      camera.updateProjectionMatrix();
    }
  };

  // --------------------------------------------------------------------------
  // Shared assets: baked PMREM env, nebula dome, dust, floor, lights, shafts
  // --------------------------------------------------------------------------
  setLoad(58, "Baking environment & atmosphere…");
  await yieldToMain();

  function bakeEnvironment() {
    const env = new THREE.Scene();
    env.background = new THREE.Color("#0a0f22");
    const mk = (w, h, col, pos, rot) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(...col), side: THREE.DoubleSide }));
      m.position.set(...pos); if (rot) m.rotation.set(...rot);
      env.add(m); return m;
    };
    const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 16, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.03, 0.05, 0.12), side: THREE.BackSide }));
    env.add(dome);
    mk(20, 2, [3, 3, 3], [0, 14, 0], [Math.PI / 2, 0, 0]);
    mk(10, 4, [0.4, 2.2, 3], [0, 8, -14]);
    mk(6, 3, [3, 0.5, 1.6], [-12, 4, 8], [0, Math.PI / 3, 0]);
    mk(5, 5, [3, 1.6, 0.4], [12, 6, 6], [0, -Math.PI / 3, 0]);
    const pm = new THREE.PMREMGenerator(renderer);
    const tex = pm.fromScene(env, 0.04).texture;
    pm.dispose();
    env.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    return tex;
  }
  scene.environment = bakeEnvironment();
  scene.environmentIntensity = 0.85;

  const bgUniforms = {
    uTop: { value: new THREE.Color("#0b1233") }, uBot: { value: new THREE.Color("#05070f") },
    uNebA: { value: new THREE.Color("#123a5e") }, uNebB: { value: new THREE.Color("#3a1a5e") },
    uTime: { value: 0 }
  };
  const bgTarget = { top: new THREE.Color(), bot: new THREE.Color(), a: new THREE.Color(), b: new THREE.Color() };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(420, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: bgUniforms, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: `varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `uniform vec3 uTop,uBot,uNebA,uNebB;uniform float uTime;varying vec3 vDir;
        float h21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
          return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);}
        void main(){vec3 d=normalize(vDir);
          vec3 c=mix(uBot,uTop,smoothstep(-0.25,0.65,d.y));
          vec2 sp=d.xz/(abs(d.y)+0.35);
          float n=vn(sp*3.0+uTime*0.008)*0.6+vn(sp*7.0-uTime*0.005)*0.4;
          c+=mix(uNebA,uNebB,vn(sp*2.0+4.7))*n*n*0.55;
          vec2 cell=floor(d.xy*300.0+d.z*170.0);
          float s=h21(cell);
          if(s>0.9985){float tw=0.6+0.4*sin(uTime*1.5+s*90.0);c+=vec3(0.9,0.95,1.0)*tw*smoothstep(0.9985,1.0,s)*1.6;}
          gl_FragColor=vec4(c,1.0);}`
    }));
  dome.renderOrder = -10; dome.frustumCulled = false;
  scene.add(dome);

  // Dust field — vec4 SOA (xyz + size) packed via 004.soaToFlat, interleaved.
  const DUST_N = 1400;
  const dustSOA = M.vec4.createVec4SOA(DUST_N);
  {
    const rng = mulberry32(777);
    const v = scratchPool.acquire();
    for (let i = 0; i < DUST_N; i++) {
      const r = 18 + rng() * 46, th = rng() * Math.PI * 2, ph = Math.acos(rng() * 2 - 1);
      v[0] = r * Math.sin(ph) * Math.cos(th); v[1] = (rng() - 0.3) * 34; v[2] = r * Math.sin(ph) * Math.sin(th);
      v[3] = 0.5 + rng() * 1.7;
      M.vec4.soaSet(dustSOA, i, v);
    }
    scratchPool.release(v);
  }
  const dustFlat = new Float32Array(DUST_N * 4);
  M.vec4.soaToFlat(dustFlat, dustSOA, 0);
  const dustIB = new THREE.InterleavedBuffer(dustFlat, 4);
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.InterleavedBufferAttribute(dustIB, 3, 0));
  dustGeo.setAttribute("aSize", new THREE.InterleavedBufferAttribute(dustIB, 1, 3));
  const dustUniforms = {
    uTime: { value: 0 }, uPx: { value: 1 }, uColor: { value: new THREE.Color(PAL.cyan) },
    uFog: { value: state.fog }, uIntensity: { value: 0.5 }
  };
  const dust = new THREE.Points(dustGeo, new THREE.ShaderMaterial({
    uniforms: dustUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aSize;uniform float uTime,uPx,uFog;varying float vA;
      void main(){vec3 p=position+vec3(sin(uTime*0.12+position.y*0.35),sin(uTime*0.09+position.x*0.27),cos(uTime*0.10+position.z*0.31))*1.6;
      vec4 mv=modelViewMatrix*vec4(p,1.0);float dist=max(1.0,-mv.z);
      gl_PointSize=clamp(aSize*uPx*160.0/dist,1.0,48.0);
      vA=exp(-uFog*dist*0.8);gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `uniform vec3 uColor;uniform float uIntensity;varying float vA;
      void main(){float d=length(gl_PointCoord-0.5);float a=smoothstep(0.5,0.08,d)*vA*uIntensity;
      gl_FragColor=vec4(uColor*a,a);}`
  }));
  dust.frustumCulled = false;
  scene.add(dust);

  // Floor + grid (demos 1 & 3)
  function makeFloorTexture() {
    const c = document.createElement("canvas"); c.width = c.height = 512;
    const g = c.getContext("2d");
    g.fillStyle = "#0a1124"; g.fillRect(0, 0, 512, 512);
    g.strokeStyle = "rgba(63,214,255,0.13)"; g.lineWidth = 1;
    for (let r = 30; r < 360; r += 30) { g.beginPath(); g.arc(256, 256, r, 0, Math.PI * 2); g.stroke(); }
    for (let a = 0; a < 24; a++) {
      g.beginPath(); g.moveTo(256, 256);
      g.lineTo(256 + Math.cos(a / 24 * Math.PI * 2) * 360, 256 + Math.sin(a / 24 * Math.PI * 2) * 360); g.stroke();
    }
    const rad = g.createRadialGradient(256, 256, 0, 256, 256, 250);
    rad.addColorStop(0, "rgba(63,214,255,0.10)"); rad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rad; g.fillRect(0, 0, 512, 512);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }
  const floorGroup = new THREE.Group();
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(64, 64),
    new THREE.MeshStandardMaterial({ map: makeFloorTexture(), color: 0xffffff, roughness: 0.94, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  floorGroup.add(floor);
  const grid = new THREE.GridHelper(128, 64, new THREE.Color(PAL.cyan), new THREE.Color("#16224a"));
  grid.position.y = 0.02; grid.material.transparent = true; grid.material.opacity = 0.32;
  floorGroup.add(grid);
  scene.add(floorGroup);

  // Light rig — colored key / rim / fill, throttled static shadows
  const hemi = new THREE.HemisphereLight(new THREE.Color("#2a3d78"), new THREE.Color("#05070f"), 0.5);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(new THREE.Color(state.keyColor), state.keyIntensity);
  key.position.set(9, 14, 6); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -34; key.shadow.camera.right = 34;
  key.shadow.camera.top = 34; key.shadow.camera.bottom = -34;
  key.shadow.camera.near = 1; key.shadow.camera.far = 70;
  key.shadow.bias = -0.0006;
  scene.add(key); scene.add(key.target);
  const rim = new THREE.DirectionalLight(new THREE.Color(PAL.magenta), 1.15);
  rim.position.set(-10, 4, -8); scene.add(rim);
  const fill = new THREE.PointLight(new THREE.Color(PAL.amber), 26, 0, 2);
  fill.position.set(0, 3, -10); scene.add(fill);

  // Volumetric-style light shaft (cheap additive cone)
  const shaftUniforms = { uColor: { value: new THREE.Color(PAL.cyan) }, uIntensity: { value: 0.16 }, uTime: { value: 0 } };
  const shaft = new THREE.Mesh(
    new THREE.ConeGeometry(7, 30, 24, 1, true),
    new THREE.ShaderMaterial({
      uniforms: shaftUniforms, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `uniform vec3 uColor;uniform float uIntensity,uTime;varying vec2 vUv;
        void main(){float a=pow(1.0-vUv.y,2.2)*smoothstep(0.0,0.18,vUv.y);
        a*=0.85+0.15*sin(uTime*0.7+vUv.x*20.0);
        gl_FragColor=vec4(uColor*a*uIntensity,a*uIntensity);}`
    }));
  shaft.position.set(6, 12, 4); shaft.rotation.z = 0.32; shaft.rotation.x = 0.18;
  scene.add(shaft);

  function makeGlowTexture() {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d");
    const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.25, "rgba(255,230,180,0.55)");
    r.addColorStop(1, "rgba(255,200,120,0)");
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const glowTex = makeGlowTexture();

  // Shared cube geometry + procedural normal map + toon ramp
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  function makeNormalTexture() {
    const S = 256, c = document.createElement("canvas"); c.width = c.height = S;
    const g = c.getContext("2d");
    const h = new Float32Array(S * S);
    const rng = mulberry32(4242);
    const bumps = [];
    for (let i = 0; i < 26; i++) bumps.push([rng() * S, rng() * S, 6 + rng() * 16, 0.5 + rng()]);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let v = 0.5 + 0.16 * Math.sin(x * 0.55 + Math.sin(y * 0.05) * 3) + 0.08 * Math.sin((x + y) * 0.21);
      const ex = Math.min(x, S - 1 - x), ey = Math.min(y, S - 1 - y);
      const edge = Math.min(ex, ey);
      if (edge < 10) v -= (10 - edge) * 0.055;
      for (let b = 0; b < bumps.length; b++) {
        const dx = x - bumps[b][0], dy = y - bumps[b][1], r = bumps[b][2];
        const d2 = dx * dx + dy * dy;
        if (d2 < r * r) v += bumps[b][3] * 0.35 * (1 - d2 / (r * r));
      }
      h[y * S + x] = v;
    }
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S, xp = (x + 1) % S, ym = (y - 1 + S) % S, yp = (y + 1) % S;
      const dx = (h[y * S + xp] - h[y * S + xm]) * 2.2;
      const dy = (h[yp * S + x] - h[ym * S + x]) * 2.2;
      const il = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * S + x) * 4;
      img.data[i] = (-dx * il * 0.5 + 0.5) * 255;
      img.data[i + 1] = (-dy * il * 0.5 + 0.5) * 255;
      img.data[i + 2] = (il * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
    return t;
  }
  const normalTex = makeNormalTexture();
  const rampData = new Uint8Array([70, 160, 255]);
  const toonRamp = new THREE.DataTexture(rampData, 3, 1, THREE.RedFormat);
  toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
  toonRamp.needsUpdate = true;

  // Scratch (module-level, zero per-frame GC)
  const _v3a = M.vec3.create(), _v3b = M.vec3.create(), _v3c = M.vec3.create(), _v3d = M.vec3.create();
  const _q = M.quat.create(), _q2 = M.quat.create();
  const _m3 = M.mat3.create(), _m3b = M.mat3.create();
  const _m4 = M.mat4.create();
  const _dq = M.quat2.create();
  const _v2 = M.vec2.create();
  const _uvrot = M.mat2.create();
  const _grade = M.mat3.create(), _grade2 = M.mat3.create();
  const _threeV = new THREE.Vector3(), _threeV2 = new THREE.Vector3();
  const _plane = new THREE.Plane();
  const _ray = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();

  // --------------------------------------------------------------------------
  // Material factory — injects math-driven instancing into Standard / Toon
  // --------------------------------------------------------------------------
  function injectField(mat, demoKey, U, opts) {
    const hasNMap = !!opts.normalMap;
    const orbital = !!opts.orbital;
    mat.customProgramCacheKey = () => "m3d-" + demoKey + "-" + (orbital ? "orb" : "tbn") + "-" + (hasNMap ? "n" : "p");
    mat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, U);
      const preludeV = orbital ? `
        attribute vec4 aE0;attribute vec3 aE1;attribute vec4 aMisc;attribute vec3 aColor;
        uniform float uTime,uTimeScale,uWorldScale;uniform vec3 uOrigin;
        varying vec3 vColor;varying float vPhase;
        mat3 gF;mat3 gR;vec3 gOrb;
        mat3 orbFrame(vec3 e){
          float cw=cos(e.z),sw=sin(e.z),ci=cos(e.x),si=sin(e.x),cO=cos(e.y),sO=sin(e.y);
          float r00=cO*cw-sO*sw*ci,r01=-cO*sw-sO*cw*ci,r02=sO*si;
          float r10=sO*cw+cO*sw*ci,r11=-sO*sw+cO*cw*ci,r12=-cO*si;
          float r20=sw*si,r21=cw*si,r22=ci;
          return mat3(vec3(r00,r10,r20),vec3(r01,r11,r21),vec3(r02,r12,r22));}
        mat3 rotY3(float a){float s=sin(a),c=cos(a);return mat3(vec3(c,0.,-s),vec3(0.,1.,0.),vec3(s,0.,c));}
        void orbSolve(){
          float Mn=aE0.z+uTime*uTimeScale*aE0.w;float e=aE0.y;float E=Mn;
          for(int i=0;i<4;i++){E-=(E-e*sin(E)-Mn)/(1.0-e*cos(E));}
          float xp=aE0.x*(cos(E)-e);float yp=aE0.x*sqrt(max(0.0,1.0-e*e))*sin(E);
          gF=orbFrame(aE1);gR=rotY3(uTime*aMisc.y+aMisc.z*6.2831853);
          gOrb=gF*vec3(xp,yp,0.0)*uWorldScale-uOrigin;}
      ` : `
        attribute mat3 aBasis;attribute mat3 aTBN;attribute vec3 aOffset;attribute vec4 aMisc;attribute vec3 aColor;
        uniform float uTime,uTurb;
        varying vec3 vColor;varying float vPhase;varying mat3 vTBN;
      `;
      const preludeF = `
        varying vec3 vColor;varying float vPhase;
        uniform float uEmissive,uRimStrength,uTime;uniform vec3 uRimColor;
        ${hasNMap ? "varying mat3 vTBN;uniform float uNormalStrength,uDebug;uniform mat2 uUvRot;" : ""}
      `;
      shader.vertexShader = preludeV + shader.vertexShader;
      shader.fragmentShader = preludeF + shader.fragmentShader;
      shader.vertexShader = shader.vertexShader.replace("#include <beginnormal_vertex>", orbital ? `
        orbSolve();
        vec3 objectNormal = normalize(gF*(gR*normal));
        #ifdef USE_TANGENT
        vec3 objectTangent = vec3(tangent.xyz);
        #endif
      ` : `
        vec3 objectNormal = normalize(aBasis*normal);
        #ifdef USE_TANGENT
        vec3 objectTangent = vec3(tangent.xyz);
        #endif
      `);
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", orbital ? `
        vec3 transformed = gF*(gR*(position*aMisc.x)) + gOrb;
        vColor = aColor; vPhase = aMisc.z;
      ` : `
        float ph = dot(aOffset, vec3(0.317,0.241,0.173)) + aMisc.y*6.2831853;
        vec3 wv = vec3(sin(uTime*0.71+ph*1.7)*uTurb*0.35, sin(uTime*1.35+ph)*uTurb, cos(uTime*0.93+ph*1.3)*uTurb*0.35);
        vec3 transformed = aBasis*(position*aMisc.x) + aOffset + wv;
        vColor = aColor; vPhase = aMisc.y;
        ${hasNMap ? `vTBN = mat3(normalize(normalMatrix*(aBasis*aTBN[0])),normalize(normalMatrix*(aBasis*aTBN[1])),normalize(normalMatrix*(aBasis*aTBN[2])));` : ""}
      `);
      shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `
        #include <color_fragment>
        diffuseColor.rgb *= vColor;
      `);
      if (hasNMap) {
        shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", `
          #ifdef USE_NORMALMAP_TANGENTSPACE
            vec3 mapN = texture2D(normalMap, uUvRot*(vNormalMapUv-0.5)+0.5).xyz*2.0-1.0;
            mapN.xy *= normalScale;
            vec3 tbnN = normalize(vTBN*mapN);
            normal = normalize(mix(normal, tbnN, clamp(uNormalStrength,0.0,2.0)));
          #endif
        `);
      }
      shader.fragmentShader = shader.fragmentShader.replace("#include <emissivemap_fragment>", `
        #include <emissivemap_fragment>
        totalEmissiveRadiance *= uEmissive*(0.55+0.45*sin(uTime*2.0+vPhase*6.2831853));
      `);
      shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `
        float rimF = pow(1.0-saturate(dot(normal,normalize(vViewPosition))),3.0);
        outgoingLight += uRimColor*rimF*uRimStrength;
        ${hasNMap ? "if(uDebug>0.5){outgoingLight = normal*0.5+0.5;}" : ""}
        #include <opaque_fragment>
      `);
      mat.userData.shader = shader;
    };
    return mat;
  }

  // --------------------------------------------------------------------------
  // Toasts / progress / HUD
  // --------------------------------------------------------------------------
  function toast(msg, color) {
    const t = el("div", "m3d-toast", msg);
    t.style.setProperty("--tc", color || PAL.cyan);
    shell.toasts.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .4s"; setTimeout(() => t.remove(), 420); }, 2400);
    while (shell.toasts.children.length > 4) shell.toasts.firstChild.remove();
  }
  let progTimer = 0;
  function progress(label, pct) {
    if (label === null) { shell.prog.style.display = "none"; return; }
    shell.prog.style.display = "block";
    shell.prog.textContent = label + (pct !== undefined ? " · " + Math.round(pct * 100) + "%" : "");
    clearTimeout(progTimer);
    progTimer = setTimeout(() => { shell.prog.style.display = "none"; }, 4000);
  }

  const hudChips = {};
  function chip(id, label, warn) {
    const c = el("div", "m3d-chip" + (warn ? " warn" : ""), `<span>${label}</span><b class="mono">—</b>`);
    shell.hud.appendChild(c);
    hudChips[id] = c.querySelector("b");
    return c;
  }
  const sparkChip = el("div", "m3d-chip", '<canvas id="m3d-spark" width="96" height="24"></canvas>');
  shell.hud.appendChild(sparkChip);
  chip("fps", "fps"); chip("ms", "ms"); chip("calls", "draws");
  chip("tris", "tris"); chip("inst", "cubes"); chip("tier", "tier");
  const sparkCtx = sparkChip.querySelector("canvas").getContext("2d");
  const frameRing = new Float32Array(96); let frameIdx = 0;
  let emaMs = 16, emaFps = 60, hudAt = 0, sparkAt = 0;
  function drawSpark() {
    const w = 96, h = 24;
    sparkCtx.clearRect(0, 0, w, h);
    sparkCtx.beginPath();
    for (let i = 0; i < 96; i++) {
      const v = frameRing[(frameIdx + i) % 96];
      const y = h - clamp(v / 40, 0, 1) * (h - 3) - 1;
      if (i === 0) sparkCtx.moveTo(i, y); else sparkCtx.lineTo(i, y);
    }
    sparkCtx.strokeStyle = PAL.cyan; sparkCtx.lineWidth = 1.2; sparkCtx.stroke();
    sparkCtx.lineTo(95, h); sparkCtx.lineTo(0, h); sparkCtx.closePath();
    const gr = sparkCtx.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "rgba(63,214,255,0.35)"); gr.addColorStop(1, "rgba(63,214,255,0)");
    sparkCtx.fillStyle = gr; sparkCtx.fill();
  }

  // --------------------------------------------------------------------------
  // DEMO 1 — TBN FORGE
  // --------------------------------------------------------------------------
  const D1_DEFAULTS = {
    formation: "galaxy", count: 12000, scale: 0.72, turbulence: 0.55, flow: 0.8,
    normalStrength: 1.0, uvSpin: 0, hue: 0, saturation: 1.05,
    metalness: 0.85, roughness: 0.32, emissive: 0.55,
    mode: "pbr", debugTBN: false, wireframe: false, seed: 1337
  };
  const demo1 = {
    id: 0, name: "TBN FORGE", accent: PAL.cyan,
    desc: "006·soaBuildTBN → 008·soaFillFromNoise → 005·fromRotation → 006·hue/sat grading",
    params: { ...D1_DEFAULTS }, built: false, building: false, group: new THREE.Group(),
    capacity: 0, mesh: null, geo: null, mats: null, flowRunning: false, buildToken: 0,
    U: {
      uTime: { value: 0 }, uTurb: { value: 0.55 }, uEmissive: { value: 0.55 },
      uRimStrength: { value: 0.15 }, uRimColor: { value: new THREE.Color(PAL.cyan) },
      uNormalStrength: { value: 1 }, uDebug: { value: 0 }, uUvRot: { value: new THREE.Matrix2 ? new THREE.Matrix2() : { elements: [1, 0, 0, 1] } }
    },
    soa: null,
    preset: { theta: 0.8, phi: 1.08, radius: 30, tx: 0, ty: 4, tz: 0, minR: 5, maxR: 220 },

    alloc(cap) {
      if (this.capacity >= cap) return;
      const n = Math.max(cap, 16384);
      this.capacity = n;
      const S = this.soa = {
        pos: M.vec3.createVec3SOA(n), rot: M.quat.createQuatSOA(n),
        basis: M.mat3.createMat3SOA(n), tbn: M.mat3.createMat3SOA(n),
        nrm: M.vec3.createVec3SOA(n), tan: M.vec3.createVec3SOA(n),
        up: M.vec3.createVec3SOA(n), xAxis: M.vec3.createVec3SOA(n),
        colBase: M.vec3.createVec3SOA(n), col: M.vec3.createVec3SOA(n),
        hand: new Float32Array(n), misc: new Float32Array(n * 4)
      };
      S.up.y.fill(1); S.xAxis.x.fill(1);
      const old = this.geo;
      const g = this.geo = new THREE.InstancedBufferGeometry();
      const box = boxGeo.clone();
      g.index = box.index;
      g.setAttribute("position", box.getAttribute("position"));
      g.setAttribute("normal", box.getAttribute("normal"));
      g.setAttribute("uv", box.getAttribute("uv"));
      this.attrs = {
        basis: new THREE.InstancedBufferAttribute(S.basis.buffer, 9).setUsage(THREE.DynamicDrawUsage),
        tbn: new THREE.InstancedBufferAttribute(S.tbn.buffer, 9).setUsage(THREE.DynamicDrawUsage),
        offset: new THREE.InstancedBufferAttribute(S.pos.buffer, 3),
        misc: new THREE.InstancedBufferAttribute(S.misc, 4),
        color: new THREE.InstancedBufferAttribute(S.col.buffer, 3)
      };
      // NOTE: mat3 SOA buffers are component-major; attributes need interleaved.
      // We therefore upload via dedicated packed arrays (below) instead.
      this.packed = {
        basis: new Float32Array(n * 9), tbn: new Float32Array(n * 9),
        offset: new Float32Array(n * 3), color: new Float32Array(n * 3)
      };
      this.attrs.basis = new THREE.InstancedBufferAttribute(this.packed.basis, 9).setUsage(THREE.DynamicDrawUsage);
      this.attrs.tbn = new THREE.InstancedBufferAttribute(this.packed.tbn, 9).setUsage(THREE.DynamicDrawUsage);
      this.attrs.offset = new THREE.InstancedBufferAttribute(this.packed.offset, 3);
      this.attrs.color = new THREE.InstancedBufferAttribute(this.packed.color, 3);
      g.setAttribute("aBasis", this.attrs.basis);
      g.setAttribute("aTBN", this.attrs.tbn);
      g.setAttribute("aOffset", this.attrs.offset);
      g.setAttribute("aMisc", this.attrs.misc);
      g.setAttribute("aColor", this.attrs.color);
      g.instanceCount = 0;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      if (!this.mesh) {
        this.mesh = new THREE.Mesh(g, null);
        this.mesh.frustumCulled = false;
        this.mesh.castShadow = true; this.mesh.receiveShadow = true;
        this.group.add(this.mesh);
      } else this.mesh.geometry = g;
      if (old) old.dispose();
    },

    makeMaterials() {
      // mat2.fromRotation drives the UV-spin uniform (005 module).
      this.U.uUvRot = { value: new THREE.Matrix2() };
      const std = new THREE.MeshStandardMaterial({
        color: 0xffffff, metalness: this.params.metalness, roughness: this.params.roughness,
        normalMap: normalTex, emissive: new THREE.Color(PAL.cyan), envMapIntensity: 1.1
      });
      std.normalScale.set(1, 1);
      injectField(std, "d1std", this.U, { normalMap: true });
      const toon = new THREE.MeshToonMaterial({
        color: 0xffffff, gradientMap: toonRamp, normalMap: normalTex,
        emissive: new THREE.Color(PAL.cyan)
      });
      toon.normalScale.set(1, 1);
      injectField(toon, "d1toon", this.U, { normalMap: true });
      this.mats = { std, toon };
      this.applyMode();
    },

    applyMode() {
      const m = this.params.mode;
      if (!this.mats) return;
      this.mesh.material = m === "anime" ? this.mats.toon : this.mats.std;
      this.mats.std.wireframe = this.params.wireframe;
      this.mats.toon.wireframe = this.params.wireframe;
      if (m === "semi") { this.U.uRimStrength.value = 0.9; this.mats.std.envMapIntensity = 0.55; }
      else { this.U.uRimStrength.value = 0.15; this.mats.std.envMapIntensity = 1.15; }
      this.U.uRimColor.value.set(m === "anime" ? PAL.magenta : PAL.cyan);
    },

    packRange(s, e) {
      const B = this.soa.basis, T = this.soa.tbn, P = this.soa.pos, C = this.soa.col;
      const pb = this.packed.basis, pt = this.packed.tbn, po = this.packed.offset, pc = this.packed.color;
      for (let i = s; i < e; i++) {
        const j = i * 9;
        pb[j] = B.m00[i]; pb[j + 1] = B.m01[i]; pb[j + 2] = B.m02[i];
        pb[j + 3] = B.m10[i]; pb[j + 4] = B.m11[i]; pb[j + 5] = B.m12[i];
        pb[j + 6] = B.m20[i]; pb[j + 7] = B.m21[i]; pb[j + 8] = B.m22[i];
        pt[j] = T.m00[i]; pt[j + 1] = T.m01[i]; pt[j + 2] = T.m02[i];
        pt[j + 3] = T.m10[i]; pt[j + 4] = T.m11[i]; pt[j + 5] = T.m12[i];
        pt[j + 6] = T.m20[i]; pt[j + 7] = T.m21[i]; pt[j + 8] = T.m22[i];
        const k = i * 3;
        po[k] = P.x[i]; po[k + 1] = P.y[i]; po[k + 2] = P.z[i];
        pc[k] = C.x[i]; pc[k + 1] = C.y[i]; pc[k + 2] = C.z[i];
      }
    },

    gradeColors() {
      const p = this.params, n = this.soa.col.count;
      const view = { x: this.soa.colBase.x.subarray(0, p.count), y: this.soa.colBase.y.subarray(0, p.count), z: this.soa.colBase.z.subarray(0, p.count), count: p.count };
      const out = { x: this.soa.col.x.subarray(0, p.count), y: this.soa.col.y.subarray(0, p.count), z: this.soa.col.z.subarray(0, p.count), count: p.count };
      M.mat3.fromHueRotation(_grade, p.hue * Math.PI / 180);
      M.mat3.soaApplyColorMatrix(out, view, _grade);
      M.mat3.fromSaturation(_grade2, p.saturation);
      M.mat3.soaApplyColorMatrix(out, out, _grade2);
      this.packRangeColors(0, p.count);
      this.attrs.color.needsUpdate = true;
      void n;
    },
    packRangeColors(s, e) {
      const C = this.soa.col, pc = this.packed.color;
      for (let i = s; i < e; i++) { const k = i * 3; pc[k] = C.x[i]; pc[k + 1] = C.y[i]; pc[k + 2] = C.z[i]; }
    },

    async build() {
      if (this.building) return;
      this.building = true;
      const token = ++this.buildToken;
      const p = this.params;
      this.alloc(p.count);
      if (!this.mats) this.makeMaterials();
      const n = p.count, rng = mulberry32(p.seed);
      const S = this.soa;
      const stops = [[0.25, 0.84, 1.0], [0.31, 0.49, 1.0], [1.0, 0.24, 0.62], [1.0, 0.69, 0.18]];
      const CH = 8192;
      for (let s = 0; s < n; s += CH) {
        if (token !== this.buildToken) { this.building = false; return; }
        const e = Math.min(s + CH, n);
        for (let i = s; i < e; i++) {
          const u = i / n;
          let x, y, z;
          if (p.formation === "lattice") {
            const side = Math.ceil(Math.cbrt(n));
            const ix = i % side, iy = ((i / side) | 0) % side, iz = (i / (side * side)) | 0;
            const sp = 1.55;
            x = (ix - side / 2) * sp; y = (iy - side / 2) * sp + side * sp * 0.5 + 1; z = (iz - side / 2) * sp;
          } else if (p.formation === "sphere") {
            const ga = Math.PI * (3 - Math.sqrt(5));
            const yy = 1 - 2 * u, rr = Math.sqrt(Math.max(0, 1 - yy * yy)), th = ga * i;
            const R = 9 + Math.cbrt(n) * 0.32;
            x = Math.cos(th) * rr * R; y = yy * R + R + 2; z = Math.sin(th) * rr * R;
          } else if (p.formation === "helix") {
            const turns = 7, t = u * turns * Math.PI * 2;
            M.vec2.ellipsePoint(_v2, 0, 0, 8 + Math.sin(u * 12) * 1.5, 8 + Math.sin(u * 12) * 1.5, t);
            x = _v2[0]; y = u * 26 + 1; z = _v2[1];
          } else { // galaxy
            const arm = i % 3, r = Math.pow(u, 0.55) * 20;
            const a = r * 0.42 + arm * (Math.PI * 2 / 3) + rng() * 0.35;
            x = Math.cos(a) * r; z = Math.sin(a) * r;
            y = 6 + (M.vec3.fbm3D(x * 0.2, 0, z * 0.2, 3) - 0.5) * 5 * (1 - u * 0.6);
          }
          const j = (M.vec3.fbm3D(x * 0.3 + p.seed, y * 0.3, z * 0.3, 3) - 0.5) * 1.6;
          S.pos.x[i] = x + j; S.pos.y[i] = y + j * 0.5; S.pos.z[i] = z - j;
          const t = clamp(u * 3, 0, 2.999), si = t | 0, f = t - si;
          const A = stops[si], B = stops[si + 1];
          S.colBase.x[i] = lerp(A[0], B[0], f); S.colBase.y[i] = lerp(A[1], B[1], f); S.colBase.z[i] = lerp(A[2], B[2], f);
          S.hand[i] = rng() > 0.5 ? 1 : -1;
          const m = i * 4;
          S.misc[m] = p.scale * (0.65 + rng() * 0.7);
          S.misc[m + 1] = rng(); S.misc[m + 2] = rng(); S.misc[m + 3] = 0;
        }
        progress("Seeding cubes", e / n * 0.5);
        await yieldToMain();
      }
      // Orientation field: 008.soaFillFromNoise -> 006.soaFromQuatSOA
      for (let s = 0; s < n; s += CH) {
        if (token !== this.buildToken) { this.building = false; return; }
        const e = Math.min(s + CH, n), c = e - s;
        const pv = { x: S.pos.x.subarray(s, e), y: S.pos.y.subarray(s, e), z: S.pos.z.subarray(s, e), count: c };
        const rv = { x: S.rot.x.subarray(s, e), y: S.rot.y.subarray(s, e), z: S.rot.z.subarray(s, e), w: S.rot.w.subarray(s, e), count: c };
        const bv = this.soaView(S.basis, s, e);
        M.quat.soaFillFromNoise(rv, pv, 0.35);
        M.mat3.soaFromQuatSOA(bv, rv);
        this.buildTBNSlice(s, e);
        this.packRange(s, e);
        progress("Building TBN frames", 0.5 + e / n * 0.5);
        await yieldToMain();
      }
      this.gradeColors();
      this.attrs.basis.needsUpdate = true;
      this.attrs.tbn.needsUpdate = true;
      this.attrs.offset.needsUpdate = true;
      this.attrs.misc.needsUpdate = true;
      this.geo.instanceCount = n;
      this.applyAll();
      this.built = true; this.building = false;
      progress(null);
      renderer.shadowMap.needsUpdate = true;
      this.ensureFlow();
    },

    soaView(m3soa, s, e) {
      return {
        m00: m3soa.m00.subarray(s, e), m01: m3soa.m01.subarray(s, e), m02: m3soa.m02.subarray(s, e),
        m10: m3soa.m10.subarray(s, e), m11: m3soa.m11.subarray(s, e), m12: m3soa.m12.subarray(s, e),
        m20: m3soa.m20.subarray(s, e), m21: m3soa.m21.subarray(s, e), m22: m3soa.m22.subarray(s, e),
        count: e - s
      };
    },
    v3View(soa, s, e) { return { x: soa.x.subarray(s, e), y: soa.y.subarray(s, e), z: soa.z.subarray(s, e), count: e - s }; },

    buildTBNSlice(s, e) {
      const S = this.soa;
      const bv = this.soaView(S.basis, s, e);
      const nv = this.v3View(S.nrm, s, e), tv = this.v3View(S.tan, s, e);
      const uv = this.v3View(S.up, s, e), xv = this.v3View(S.xAxis, s, e);
      M.mat3.soaTransformVec3(nv.x, nv.y, nv.z, bv, uv);
      M.mat3.soaTransformVec3(tv.x, tv.y, tv.z, bv, xv);
      const tbnv = this.soaView(S.tbn, s, e);
      M.mat3.soaBuildTBN(tbnv, nv, tv, S.hand.subarray(s, e));
    },

    ensureFlow() {
      if (this.flowRunning || !this.built) return;
      this.flowRunning = true;
      const self = this;
      (async function loop() {
        let cursor = 0;
        while (state.active === 0 && !state.disposed && self.built) {
          if (self.params.flow <= 0 || state.paused) { await new Promise(r => setTimeout(r, 120)); continue; }
          const n = self.params.count, S = self.soa;
          const slice = Math.min(8192, n);
          const s = cursor % n, e = Math.min(s + slice, n);
          const pv = self.v3View(S.pos, s, e);
          const rv = { x: S.rot.x.subarray(s, e), y: S.rot.y.subarray(s, e), z: S.rot.z.subarray(s, e), w: S.rot.w.subarray(s, e), count: e - s };
          M.quat.soaFillSpinFrom4DNoise(rv, pv, state.simTime * self.params.flow * 0.25, 0.4, Math.PI * 2);
          M.mat3.soaFromQuatSOA(self.soaView(S.basis, s, e), rv);
          self.buildTBNSlice(s, e);
          self.packRange(s, e);
          const ab = self.attrs.basis, at = self.attrs.tbn;
          if (typeof ab.addUpdateRange === "function") {
            ab.clearUpdateRanges(); ab.addUpdateRange(s * 9, (e - s) * 9);
            at.clearUpdateRanges(); at.addUpdateRange(s * 9, (e - s) * 9);
          }
          ab.needsUpdate = true; at.needsUpdate = true;
          cursor = e >= n ? 0 : e;
          await yieldToMain();
        }
        self.flowRunning = false;
      })();
    },

    applyAll() {
      const p = this.params;
      this.U.uTurb.value = p.turbulence;
      this.U.uEmissive.value = p.emissive;
      this.U.uNormalStrength.value = p.normalStrength;
      this.U.uDebug.value = p.debugTBN ? 1 : 0;
      M.mat2.fromRotation(_uvrot, p.uvSpin * Math.PI / 180);
      this.U.uUvRot.value.elements[0] = _uvrot[0]; this.U.uUvRot.value.elements[1] = _uvrot[1];
      this.U.uUvRot.value.elements[2] = _uvrot[2]; this.U.uUvRot.value.elements[3] = _uvrot[3];
      if (this.mats) {
        this.mats.std.metalness = p.metalness;
        this.mats.std.roughness = p.roughness;
      }
      this.applyMode();
    },

    apply(key, v) {
      const p = this.params;
      if (key === "count" || key === "formation" || key === "seed") { p[key] = v; this.scheduleRebuild(); return; }
      p[key] = v;
      if (key === "hue" || key === "saturation") { this.gradeColors(); return; }
      if (key === "scale") {
        const rng = mulberry32(p.seed + 9);
        for (let i = 0; i < p.count; i++) this.soa.misc[i * 4] = v * (0.65 + rng() * 0.7);
        this.attrs.misc.needsUpdate = true; return;
      }
      if (key === "flow") { this.ensureFlow(); return; }
      this.applyAll();
      if (key === "mode") {
        const presets = { anime: [0.0, 0.9], semi: [0.35, 0.5], pbr: [0.85, 0.32] };
        const pr = presets[v];
        p.metalness = pr[0]; p.roughness = pr[1];
        this.applyAll(); syncUI(this);
        toast(v === "anime" ? "Anime flat — 3-band toon ramp" : v === "semi" ? "Semi-real — rim-lit standard" : "Full PBR — GGX + baked env", this.accent);
      }
    },
    scheduleRebuild() {
      clearTimeout(this._rb);
      this._rb = setTimeout(() => this.build(), 180);
    },
    update(dt) { this.U.uTime.value = state.simTime; void dt; },
    randomize() {
      this.params.seed = (Math.random() * 1e9) | 0;
      this.params.hue = Math.round((Math.random() * 2 - 1) * 120);
      this.params.turbulence = +(0.2 + Math.random() * 1.1).toFixed(2);
      this.params.uvSpin = Math.round((Math.random() * 2 - 1) * 180);
      this.build(); syncUI(this);
    },
    reset() { this.params = { ...D1_DEFAULTS }; this.build(); syncUI(this); },
    instanceCount() { return this.params.count; },
    dispose() {
      this.buildToken++;
      if (this.geo) this.geo.dispose();
      if (this.mats) { this.mats.std.dispose(); this.mats.toon.dispose(); }
    }
  };

  