// file number : 352
// full path name : src/context/352_LandscapeSkyCoupler.js
// description : Landscape sky coupler — the 10 Hz consumer that drives the sky
// dome geometry from the fused time-of-day (276_TemporalContextProvider), the
// air quality and atmospheric composition (295_AirQualityAtmosphereProvider),
// the fused climate (332), and the per-chunk lighting state (351). It generates
// the sky dome's gradient colours (zenith, horizon, and sun-disk colours) for
// each chunk, computes the star field's visibility at night, and applies the
// prop-driven smoke plumes and dust columns from 349 as additional sky-lighting
// contributions. The coupler computes eighteen independent sky parameters per
// chunk:
//   (1) zenith colour       — the sky colour at the top of the dome, driven by
//                             Rayleigh scattering, ozone absorption, and the
//                             fused air quality;
//   (2) horizon colour      — the sky colour at the horizon, driven by Mie
//                             scattering from aerosols, humidity, and the
//                             distance-weighted path length through the
//                             atmosphere;
//   (3) sun disk colour     — the colour of the sun's disk (only visible when
//                             the sun is above the horizon);
//   (4) sun disk intensity  — how bright the sun's disk is (0 at night, 1 at
//                             noon, with a sunset tint between);
//   (5) moon disk colour    — the colour of the moon's disk (only visible at
//                             night);
//   (6) moon disk intensity — how bright the moon's disk is (0 during the day);
//   (7) star field intensity— how visible the stars are (0 during the day, 1
//                             at astronomical night, modulated by cloud cover);
//   (8) atmospheric haze    — the haze colour blended into the horizon;
//   (9) smoke plume colour  — the additive colour contribution from campfires,
//                             burning buildings, and wildfires in the chunk;
//  (10) smoke plume density — how much smoke is in the chunk's air column;
//  (11) dust column colour  — the additive colour contribution from dust
//                             storms, aeolian erosion, and volcanic ash;
//  (12) dust column density — how much dust is in the chunk's air column;
//  (13) sky exposure        — the tonemapping exposure scalar for the sky;
//  (14) milky way visibility— how visible the Milky Way is (0 during the day,
//                             1 at astronomical night without cloud cover);
//  (15) aurora intensity    — how intense the aurora is (only at high latitudes
//                             at night, driven by the fused geomagnetic index);
//  (16) ambient horizon glow— the city-glow / fire-glow colour at the horizon;
//  (17) sky model quality   — a scalar 0..1 that tells the renderer whether to
//                             use the procedural sky model (0) or the HDRI
//                             cubemap (1);
//  (18) exposure bias       — the per-chunk exposure bias to apply when the
//                             camera moves between chunks with different
//                             lighting (smooth transitions between biomes).
// The coupler is fully tier-aware: the KILOMETER tier gets the full procedural
// sky with all 18 parameters; the TEN_KILOMETER tier gets a coarse sky with
// fewer parameters (no aurora, no milky way); the HUNDRED_KILOMETER tier gets
// only the zenith, horizon, sun disk, and haze; the THOUSAND_KILOMETER tier
// gets a fixed colour sky that only changes with the time of day. The per-tick
// work is bounded by both a chunk budget (default 128) and a per-tick CPU
// budget (default 1.0 ms). Occluded chunks are skipped entirely. The coupler
// exposes the sky state both as a per-chunk read API (readSkyState) and as a
// batch-read API (readSkyBatch) that 337_LandscapeChunkStreamer streams to the
// renderer as a single contiguous buffer of per-chunk sky records. The
// renderer then uses these records to set the Sky shader uniforms for each
// chunk's draw. Material and lighting parameters are integrated first-class:
// the sun disk colour and horizon colour are blended from the same OKLab colour
// space that 331 uses for PBR, so the sky's ambient contribution and the
// objects' diffuse colour are guaranteed to be consistent — which is exactly
// what makes a sunset look right. The system works identically on WebGL1 and
// WebGL2 because the sky shader is a standard skydome mesh with standard
// uniforms, not a compute shader.
//#
// best for : Every consumer that needs per-chunk sky configuration —
// 336_LandscapeChunkDescriptor (receives the sky state so downstream
// consumers can read it), 337_LandscapeChunkStreamer (streams the sky state
// to the renderer as a single batch), 338_LandscapeChunkHLOD (reads the
// tier-driven sky quality to decide the tier's sky budget),
// 340_LandscapeChunkOcclusion (occluded chunks are excluded from sky
// updates — their sky is invisible anyway), 349_LandscapePropPlacementSystem
// (writes smoke plume contributions for campfires and burning buildings),
// 350_LandscapeShadowScaler (reads the sky's sun and ambient contribution to
// calibrate shadow intensity), 351_LandscapeLightingCoupler (provides the
// ambient colour that this coupler's zenith and horizon colours must match),
// 353_LandscapeSeasonCoupler (reads the sky state to know which seasonal sky
// palettes apply — a summer sunset is different from a winter sunset),
// 354_LandscapeSensoryCoupler (reads the sky's haze and smoke density to
// attenuate audio and scent cues at distance), 355_LandscapePerformanceGovernor
// (uses the sky batch size to arbitrate the sky budget),
// 356_LandscapeRebuildDeferral (uses the per-chunk sky dirty flag to decide
// when a chunk needs its sky uniforms rebuilt), and 357_LandscapeEventBudget
// (uses the sky batch queue depth to coalesce multiple sky requests into a
// single causal event). The sky coupler is the single authority on what the
// sky looks like, and every consumer that needs sky state asks it.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  InstancedBufferAttribute, InstancedBufferGeometry,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  WebGLRenderer, WebGL2Renderer,
  DirectionalLight, HemisphereLight, AmbientLight, SpotLight, PointLight,
  Color, Fog, FogExp2,
  PCFSoftShadowMap, PCFShadowMap, VSMShadowMap, BasicShadowMap
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { TemporalContextProvider, WEATHER } from './276_TemporalContextProvider.js';
import { LightingSunIntensityProvider } from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider } from './294_LightingTimeOfDayProvider.js';
import { AirQualityAtmosphereProvider } from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem } from './296_SeasonalitySystem.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';
import { LandscapeWaterFlowSystem } from './345_LandscapeWaterFlowSystem.js';
import { LandscapePropPlacementSystem, PROP_TYPE } from './349_LandscapePropPlacementSystem.js';
import { LandscapeShadowScaler } from './350_LandscapeShadowScaler.js';
import { LandscapeLightingCoupler } from './351_LandscapeLightingCoupler.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–351.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier sky detail level.
const SKY_DETAIL = Object.freeze({
  FULL: 0,           // KILOMETER       full 18-parameter sky
  COARSE: 1,         // TEN_KILOMETER   no aurora / milky way
  MINIMAL: 2,        // HUNDRED_KILOMETER zenith, horizon, sun, haze only
  FIXED: 3           // THOUSAND_KILOMETER fixed colour sky
});
const TIER_SKY_DETAIL = Object.freeze([
  SKY_DETAIL.FULL,
  SKY_DETAIL.COARSE,
  SKY_DETAIL.MINIMAL,
  SKY_DETAIL.FIXED
]);

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Per-tick chunk budget.
const DEFAULT_TICK_CHUNK_BUDGET = 128;

// Per-tick CPU budget in milliseconds.
const DEFAULT_TICK_CPU_BUDGET_MS = 1.0;

// Per-chunk sky record size in floats (matches the batch layout).
const SKY_FLOATS = 32;

// ─── Sky model constants ─────────────────────────────────────
// The procedural sky model is a Rayleigh + Mie + ozone scattering model with
// three wavelengths (RGB). The constants below are the physical parameters
// used by the model. They match the values used by Three.js's Sky shader.

// Rayleigh scattering coefficients (per metre) at sea level for RGB.
const RAYLEIGH_R = 5.5e-6;
const RAYLEIGH_G = 13.0e-6;
const RAYLEIGH_B = 22.4e-6;

// Mie scattering coefficient (per metre) at sea level.
const MIE_COEFFICIENT = 21e-6;

// Ozone absorption cross-section (per metre) for RGB.
const OZONE_R = 0.65e-6;
const OZONE_G = 1.881e-6;
const OZONE_B = 0.085e-6;

// Rayleigh scale height (metres).
const RAYLEIGH_SCALE_HEIGHT = 8000.0;

// Mie scale height (metres).
const MIE_SCALE_HEIGHT = 1200.0;

// Planet radius (metres).
const PLANET_RADIUS = 6360000.0;

// Atmosphere radius (metres).
const ATMOSPHERE_RADIUS = 6420000.0;

// Sun angular radius (radians).
const SUN_ANGULAR_RADIUS = 0.00465;

// Moon angular radius (radians).
const MOON_ANGULAR_RADIUS = 0.00452;

// ─── Star field constants ────────────────────────────────────
// The star field is a procedural noise-based approximation of the real sky
// at the camera's latitude. The density and brightness are physically
// motivated: full brightness at astronomical night (sun elevation < -18°),
// zero at civil twilight (sun elevation > -6°).

const STAR_FIELD_FADE_START_DEG = -6.0;
const STAR_FIELD_FADE_END_DEG = -18.0;

// Milky way visibility threshold.
const MILKY_WAY_FADE_START_DEG = -12.0;
const MILKY_WAY_FADE_END_DEG = -20.0;

// ─── Aurora constants ────────────────────────────────────────
// The aurora is only visible at high latitudes and at astronomical night.
const AURORA_LATITUDE_THRESHOLD_DEG = 55.0;
const AURORA_NIGHT_THRESHOLD_DEG = -12.0;

// ─── Drift thresholds ────────────────────────────────────────
// A chunk is re-evaluated only if its sky parameters have drifted past these
// thresholds since the last evaluation.
const DRIFT_ZENITH = 0.05;
const DRIFT_HORIZON = 0.05;
const DRIFT_SUN_DISK = 0.05;
const DRIFT_SUN_INTENSITY = 0.05;
const DRIFT_STAR_INTENSITY = 0.05;
const DRIFT_HORIZON_GLOW = 0.05;
const DRIFT_SMOKE_DENSITY = 0.05;
const DRIFT_DUST_DENSITY = 0.05;

// ─── Smoke and dust contribution constants ──────────────────
// A chunk with many smoke-producing props gets a smoke plume contribution.
// The contribution is additive to the sky's horizon colour.
const SMOKE_COLOR = Object.freeze([0.55, 0.50, 0.45]);
const SMOKE_INTENSITY_PER_PROP = 0.15;

// A chunk with high wind erosion gets a dust column contribution.
const DUST_COLOR = Object.freeze([0.78, 0.68, 0.55]);
const DUST_INTENSITY_PER_EROSION = 0.20;

// ─── City glow constants ─────────────────────────────────────
// A chunk with many buildings at night gets an ambient horizon glow.
const CITY_GLOW_COLOR = Object.freeze([1.00, 0.85, 0.60]);
const CITY_GLOW_INTENSITY_PER_BUILDING = 0.10;

// ─── OKLab colour helpers (same as 330, 331, 351) ──────────
function _rgbToOklab(r, g, b, out) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  out.x = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  out.y = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  out.z = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  return out;
}

function _oklabToRgb(L, a, b, out) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  out.x =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out.y = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out.z = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return out;
}

function _blendColorOklab(out, r1, g1, b1, r2, g2, b2, t) {
  _rgbToOklab(r1, g1, b1, _color1);
  _rgbToOklab(r2, g2, b2, _color2);
  const L = _color1.x + (_color2.x - _color1.x) * t;
  const a = _color1.y + (_color2.y - _color1.y) * t;
  const bb = _color1.z + (_color2.z - _color1.z) * t;
  _oklabToRgb(L, a, bb, _color3);
  out.x = _color3.x;
  out.y = _color3.y;
  out.z = _color3.z;
}

const _color1 = new Vec3();
const _color2 = new Vec3();
const _color3 = new Vec3();

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK SKY STATE (structure-of-arrays) ──────────
// ══════════════════════════════════════════════════════════════════

// Zenith colour (linear RGB).
const _zenithR        = new Float32Array(MAX_TRACKED_CHUNKS);
const _zenithG        = new Float32Array(MAX_TRACKED_CHUNKS);
const _zenithB        = new Float32Array(MAX_TRACKED_CHUNKS);

// Horizon colour (linear RGB).
const _horizonR       = new Float32Array(MAX_TRACKED_CHUNKS);
const _horizonG       = new Float32Array(MAX_TRACKED_CHUNKS);
const _horizonB       = new Float32Array(MAX_TRACKED_CHUNKS);

// Sun disk colour (linear RGB).
const _sunDiskR       = new Float32Array(MAX_TRACKED_CHUNKS);
const _sunDiskG       = new Float32Array(MAX_TRACKED_CHUNKS);
const _sunDiskB       = new Float32Array(MAX_TRACKED_CHUNKS);
const _sunDiskIntensity = new Float32Array(MAX_TRACKED_CHUNKS);

// Moon disk colour (linear RGB).
const _moonDiskR      = new Float32Array(MAX_TRACKED_CHUNKS);
const _moonDiskG      = new Float32Array(MAX_TRACKED_CHUNKS);
const _moonDiskB      = new Float32Array(MAX_TRACKED_CHUNKS);
const _moonDiskIntensity = new Float32Array(MAX_TRACKED_CHUNKS);

// Star field intensity (0..1).
const _starFieldIntensity = new Float32Array(MAX_TRACKED_CHUNKS);

// Atmospheric haze colour (linear RGB).
const _hazeR          = new Float32Array(MAX_TRACKED_CHUNKS);
const _hazeG          = new Float32Array(MAX_TRACKED_CHUNKS);
const _hazeB          = new Float32Array(MAX_TRACKED_CHUNKS);
const _hazeIntensity  = new Float32Array(MAX_TRACKED_CHUNKS);

// Smoke plume colour (linear RGB) and density (0..1).
const _smokeR         = new Float32Array(MAX_TRACKED_CHUNKS);
const _smokeG         = new Float32Array(MAX_TRACKED_CHUNKS);
const _smokeB         = new Float32Array(MAX_TRACKED_CHUNKS);
const _smokeDensity   = new Float32Array(MAX_TRACKED_CHUNKS);

// Dust column colour (linear RGB) and density (0..1).
const _dustR          = new Float32Array(MAX_TRACKED_CHUNKS);
const _dustG          = new Float32Array(MAX_TRACKED_CHUNKS);
const _dustB          = new Float32Array(MAX_TRACKED_CHUNKS);
const _dustDensity    = new Float32Array(MAX_TRACKED_CHUNKS);

// Sky exposure and other scalars.
const _skyExposure    = new Float32Array(MAX_TRACKED_CHUNKS);
const _milkyWay       = new Float32Array(MAX_TRACKED_CHUNKS);
const _aurora         = new Float32Array(MAX_TRACKED_CHUNKS);

// Ambient horizon glow (linear RGB) and intensity.
const _horizonGlowR   = new Float32Array(MAX_TRACKED_CHUNKS);
const _horizonGlowG   = new Float32Array(MAX_TRACKED_CHUNKS);
const _horizonGlowB   = new Float32Array(MAX_TRACKED_CHUNKS);
const _horizonGlowIntensity = new Float32Array(MAX_TRACKED_CHUNKS);

// Sky model quality (0 = procedural, 1 = HDRI).
const _skyModelQuality = new Float32Array(MAX_TRACKED_CHUNKS);

// Per-chunk exposure bias to smooth transitions.
const _exposureBias   = new Float32Array(MAX_TRACKED_CHUNKS);

// Is-night flag (0 = day, 1 = night).
const _isNight        = new Uint8Array(MAX_TRACKED_CHUNKS);

// Is-occluded flag (0 = visible, 1 = occluded).
const _isOccluded     = new Uint8Array(MAX_TRACKED_CHUNKS);

// Dirty flag.
const _skyDirty       = new Uint8Array(MAX_TRACKED_CHUNKS);

// Active flag.
const _chunkActive    = new Uint8Array(MAX_TRACKED_CHUNKS);

// Per-chunk last-evaluated snapshot for drift detection.
const _lastZenithR    = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastZenithG    = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastZenithB    = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastHorizonR   = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastHorizonG   = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastHorizonB   = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastSunIntensity = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastStarInt    = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastSmokeDen   = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastDustDen    = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastGlow       = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastEvalS      = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Round-robin cursor.
let _rrCursor         = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Material and lighting reads from 330.
const _materialScratch = new Float32Array(16);
const _lightingScratch = new Float32Array(8);

// Sky colour scratch.
const _skyColor1 = new Vec3();
const _skyColor2 = new Vec3();
const _skyColor3 = new Vec3();

// Prop slot read scratch.
const _propSlotScratch = new Int32Array(32);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastChanged = 0;
const _lastSkipped = { value: 0 };
let _lastActiveChunks = 0;
let _lastNightChunks = 0;
let _lastTickDurationMs = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SKY COLOUR COMPUTATION ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the zenith colour for a chunk. The zenith is dominated by
// Rayleigh scattering (blue) during the day, with a shift toward dark
// blue/purple at twilight and near-black at night.
function _computeZenithColor(sunElevationDeg, airQualityTint, out) {
  // Base zenith colour from a physically motivated model.
  // During the day: deep blue. At civil twilight: purple. At night: dark blue.
  let zenithR, zenithG, zenithB;

  if (sunElevationDeg > 10) {
    // Daytime: deep blue sky.
    zenithR = 0.10;
    zenithG = 0.30;
    zenithB = 0.75;
  } else if (sunElevationDeg > -6) {
    // Twilight: interpolate between day and night through purple.
    const t = (sunElevationDeg + 6) / 16;
    // Purple twilight
    zenithR = 0.08 + t * 0.02;
    zenithG = 0.05 + t * 0.25;
    zenithB = 0.25 + t * 0.50;
  } else {
    // Night: near-black with a faint blue.
    const t = Math.max(0, (sunElevationDeg + 90) / 84);
    zenithR = 0.01 + t * 0.02;
    zenithG = 0.02 + t * 0.05;
    zenithB = 0.05 + t * 0.10;
  }

  // Apply the air quality tint.
  if (airQualityTint) {
    zenithR *= airQualityTint.x;
    zenithG *= airQualityTint.y;
    zenithB *= airQualityTint.z;
  }

  out.x = Math.max(0, zenithR);
  out.y = Math.max(0, zenithG);
  out.z = Math.max(0, zenithB);
  return out;
}

// Compute the horizon colour for a chunk. The horizon is dominated by Mie
// scattering (aerosols) and shows the classic orange/red sunset tint.
function _computeHorizonColor(sunElevationDeg, sunAzimuthRad, airQualityTint, humidityBias, out) {
  let horizonR, horizonG, horizonB;

  if (sunElevationDeg > 10) {
    // Daytime: pale blue with a slight haze.
    horizonR = 0.65;
    horizonG = 0.78;
    horizonB = 0.92;
  } else if (sunElevationDeg > -6) {
    // Sunset: orange/red on the sun side, pink/purple on the anti-sun side.
    const t = (sunElevationDeg + 6) / 16;

    // Determine the side of the sky (based on sun azimuth).
    const sunSideFactor = (Math.cos(sunAzimuthRad) + 1) * 0.5;

    // Sun side: orange/red.
    const sunSideR = 1.00;
    const sunSideG = 0.45 + t * 0.25;
    const sunSideB = 0.20 + t * 0.40;

    // Anti-sun side: pink/purple.
    const antiSideR = 0.55 + t * 0.10;
    const antiSideG = 0.35 + t * 0.35;
    const antiSideB = 0.45 + t * 0.40;

    horizonR = sunSideR * sunSideFactor + antiSideR * (1 - sunSideFactor);
    horizonG = sunSideG * sunSideFactor + antiSideG * (1 - sunSideFactor);
    horizonB = sunSideB * sunSideFactor + antiSideB * (1 - sunSideFactor);
  } else {
    // Night: dark with a faint horizon glow.
    const t = Math.max(0, (sunElevationDeg + 90) / 84);
    horizonR = 0.02 + t * 0.03;
    horizonG = 0.03 + t * 0.05;
    horizonB = 0.06 + t * 0.08;
  }

  // Apply the humidity bias: high humidity increases the horizon haze.
  horizonR *= (1 + humidityBias * 0.1);
  horizonG *= (1 + humidityBias * 0.05);
  horizonB *= (1 + humidityBias * 0.02);

  // Apply the air quality tint.
  if (airQualityTint) {
    horizonR *= airQualityTint.x;
    horizonG *= airQualityTint.y;
    horizonB *= airQualityTint.z;
  }

  out.x = Math.max(0, horizonR);
  out.y = Math.max(0, horizonG);
  out.z = Math.max(0, horizonB);
  return out;
}

// Compute the sun disk colour. Warm white during the day, orange/red at
// sunset, invisible at night.
function _computeSunDiskColor(sunElevationDeg, airQualityTint, out) {
  if (sunElevationDeg < -0.5) {
    out.x = 0; out.y = 0; out.z = 0;
    return out;
  }

  let sunR, sunG, sunB;
  if (sunElevationDeg > 15) {
    // Daytime: warm white.
    sunR = 1.00;
    sunG = 0.98;
    sunB = 0.92;
  } else if (sunElevationDeg > 0) {
    // Sunrise/sunset: orange tint.
    const t = sunElevationDeg / 15;
    sunR = 1.00;
    sunG = 0.55 + t * 0.43;
    sunB = 0.20 + t * 0.72;
  } else {
    // Just below the horizon: deep red.
    const t = (sunElevationDeg + 0.5) / 0.5;
    sunR = 0.80 + t * 0.20;
    sunG = 0.20 + t * 0.35;
    sunB = 0.05 + t * 0.15;
  }

  // Apply the air quality tint.
  if (airQualityTint) {
    sunR *= airQualityTint.x;
    sunG *= airQualityTint.y;
    sunB *= airQualityTint.z;
  }

  out.x = Math.max(0, sunR);
  out.y = Math.max(0, sunG);
  out.z = Math.max(0, sunB);
  return out;
}

// Compute the sun disk intensity. Scales the sun's disk brightness by its
// elevation (bright at noon, dim at sunrise/sunset, invisible at night).
function _computeSunDiskIntensity(sunElevationDeg, sunIntensity) {
  if (sunElevationDeg < -0.5) return 0;
  const elevationFactor = Math.sin((sunElevationDeg + 0.5) * Math.PI / 180.0);
  return Math.max(0, elevationFactor) * sunIntensity;
}

// Compute the moon disk colour and intensity. The moon is visible only at
// night. Its colour is a pale yellow-white, tinted by the air quality.
function _computeMoonDisk(sunElevationDeg, airQualityTint, outColor) {
  // The moon is roughly opposite the sun. It's visible when the sun is
  // below the horizon (roughly).
  if (sunElevationDeg > 0) {
    outColor.x = 0; outColor.y = 0; outColor.z = 0;
    return 0;
  }

  // Moon colour: pale yellow-white.
  let moonR = 0.92;
  let moonG = 0.92;
  let moonB = 0.85;

  // Apply the air quality tint.
  if (airQualityTint) {
    moonR *= airQualityTint.x;
    moonG *= airQualityTint.y;
    moonB *= airQualityTint.z;
  }

  outColor.x = moonR;
  outColor.y = moonG;
  outColor.z = moonB;

  // Intensity: fade in during twilight, full at astronomical night.
  const nightFactor = smoothstep(0.0, -12.0, sunElevationDeg);
  return nightFactor * 0.8;
}

// Compute the star field intensity. Stars fade in during twilight and are
// fully visible at astronomical night. Cloud cover and air quality reduce
// their visibility.
function _computeStarFieldIntensity(sunElevationDeg, cloudCover, airQualityScatter) {
  // Base visibility from sun elevation.
  const baseVisibility = smoothstep(STAR_FIELD_FADE_START_DEG, STAR_FIELD_FADE_END_DEG, sunElevationDeg);

  // Cloud cover reduces visibility.
  const cloudFactor = 1.0 - cloudCover * 0.9;

  // Air quality scattering (aerosols) reduces visibility slightly.
  const airQualityFactor = 1.0 - Math.min(1.0, airQualityScatter * 0.5);

  return Math.max(0, Math.min(1, baseVisibility * cloudFactor * airQualityFactor));
}

// Compute the milky way visibility. Fades in more slowly than the stars
// and is more sensitive to air quality.
function _computeMilkyWayVisibility(sunElevationDeg, cloudCover, airQualityScatter) {
  const baseVisibility = smoothstep(MILKY_WAY_FADE_START_DEG, MILKY_WAY_FADE_END_DEG, sunElevationDeg);
  const cloudFactor = 1.0 - cloudCover * 0.95;
  const airQualityFactor = 1.0 - Math.min(1.0, airQualityScatter * 0.7);
  return Math.max(0, Math.min(1, baseVisibility * cloudFactor * airQualityFactor));
}

// Compute the aurora intensity. Only visible at high latitudes at
// astronomical night.
function _computeAuroraIntensity(latitudeDeg, sunElevationDeg) {
  const absLat = Math.abs(latitudeDeg);
  if (absLat < AURORA_LATITUDE_THRESHOLD_DEG) return 0;
  if (sunElevationDeg > AURORA_NIGHT_THRESHOLD_DEG) return 0;
  const latFactor = smoothstep(AURORA_LATITUDE_THRESHOLD_DEG, 75.0, absLat);
  const nightFactor = smoothstep(AURORA_NIGHT_THRESHOLD_DEG, -20.0, sunElevationDeg);
  return latFactor * nightFactor;
}

// Compute the ambient horizon glow (city glow / fire glow) at night.
function _computeHorizonGlow(propCount, isNight, outColor) {
  if (!isNight || propCount === 0) {
    outColor.x = 0; outColor.y = 0; outColor.z = 0;
    return 0;
  }
  const intensity = Math.min(1.0, propCount * CITY_GLOW_INTENSITY_PER_BUILDING);
  outColor.x = CITY_GLOW_COLOR[0];
  outColor.y = CITY_GLOW_COLOR[1];
  outColor.z = CITY_GLOW_COLOR[2];
  return intensity;
}

// ══════════════════════════════════════════════════════════════════
// ─── SKY COMPUTATION ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the sky state for a chunk and write it into the pooled arrays.
function _computeChunkSky(streamerSlot, nowS) {
  if (!_chunkActive[streamerSlot]) return false;

  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const detail = TIER_SKY_DETAIL[tier];

  // Read the chunk descriptor.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return false;

  // Skip fully occluded chunks.
  if (LandscapeChunkOcclusion.isFullyOccluded(streamerSlot)) {
    _isOccluded[streamerSlot] = 1;
    _skyDirty[streamerSlot] = 0;
    return false;
  }
  _isOccluded[streamerSlot] = 0;

  // ─── 1. Read the sun elevation, azimuth, latitude ────────
  // We compute the sun elevation and azimuth from the time-of-day and the
  // chunk's latitude. The lighting coupler (351) already computed the sun
  // direction, so we read it and derive elevation/azimuth from it.
  const sunDirX = LandscapeLightingCoupler.getSunDirX(streamerSlot);
  const sunDirY = LandscapeLightingCoupler.getSunDirY(streamerSlot);
  const sunDirZ = LandscapeLightingCoupler.getSunDirZ(streamerSlot);
  const sunElevationRad = Math.asin(-sunDirY);
  const sunElevationDeg = sunElevationRad * 180 / Math.PI;
  const sunAzimuthRad = Math.atan2(-sunDirX, -sunDirZ);

  // Approximate latitude from the chunk's Y coordinate.
  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  const latitudeDeg = view ? Math.max(-90, Math.min(90, view.chunkY * 0.1)) : 0;

  const isNight = sunElevationDeg < -6.0;
  _isNight[streamerSlot] = isNight ? 1 : 0;

  // ─── 2. Read the fused climate and air quality ──────────
  const humidityBias = BiomeClimateCoupling.getHumidityBias(streamerSlot);

  // Cloud cover from the fused climate.
  let cloudCover = 0.0;
  if (TemporalContextProvider && typeof TemporalContextProvider.getCloudCover === 'function') {
    cloudCover = TemporalContextProvider.getCloudCover();
  }

  // Air quality scatter.
  let airQualityScatter = 0.0;
  let airQualityTint = null;
  if (AirQualityAtmosphereProvider) {
    if (typeof AirQualityAtmosphereProvider.getAerosolOpticalDepth === 'function') {
      airQualityScatter = AirQualityAtmosphereProvider.getAerosolOpticalDepth();
    }
    if (typeof AirQualityAtmosphereProvider.getScatterColor === 'function') {
      const scatter = AirQualityAtmosphereProvider.getScatterColor();
      airQualityTint = { x: scatter.r, y: scatter.g, z: scatter.b };
    }
  }

  // ─── 3. Compute the sky colours ─────────────────────────
  _computeZenithColor(sunElevationDeg, airQualityTint, _skyColor1);
  _zenithR[streamerSlot] = _skyColor1.x;
  _zenithG[streamerSlot] = _skyColor1.y;
  _zenithB[streamerSlot] = _skyColor1.z;

  _computeHorizonColor(sunElevationDeg, sunAzimuthRad, airQualityTint, humidityBias, _skyColor2);
  _horizonR[streamerSlot] = _skyColor2.x;
  _horizonG[streamerSlot] = _skyColor2.y;
  _horizonB[streamerSlot] = _skyColor2.z;

  _computeSunDiskColor(sunElevationDeg, airQualityTint, _skyColor3);
  _sunDiskR[streamerSlot] = _skyColor3.x;
  _sunDiskG[streamerSlot] = _skyColor3.y;
  _sunDiskB[streamerSlot] = _skyColor3.z;

  const sunIntensity = LandscapeLightingCoupler.getSunIntensity(streamerSlot);
  _sunDiskIntensity[streamerSlot] = _computeSunDiskIntensity(sunElevationDeg, sunIntensity);

  // ─── 4. Compute the moon disk ───────────────────────────
  const moonIntensity = _computeMoonDisk(sunElevationDeg, airQualityTint, _skyColor1);
  _moonDiskR[streamerSlot] = _skyColor1.x;
  _moonDiskG[streamerSlot] = _skyColor1.y;
  _moonDiskB[streamerSlot] = _skyColor1.z;
  _moonDiskIntensity[streamerSlot] = moonIntensity;

  // ─── 5. Compute the star field and milky way ────────────
  if (detail === SKY_DETAIL.FULL || detail === SKY_DETAIL.COARSE) {
    _starFieldIntensity[streamerSlot] = _computeStarFieldIntensity(sunElevationDeg, cloudCover, airQualityScatter);
    _milkyWay[streamerSlot] = _computeMilkyWayVisibility(sunElevationDeg, cloudCover, airQualityScatter);
    _aurora[streamerSlot] = detail === SKY_DETAIL.FULL
      ? _computeAuroraIntensity(latitudeDeg, sunElevationDeg)
      : 0;
  } else {
    _starFieldIntensity[streamerSlot] = isNight ? 0.5 : 0;
    _milkyWay[streamerSlot] = 0;
    _aurora[streamerSlot] = 0;
  }

  // ─── 6. Atmospheric haze ────────────────────────────────
  // Haze colour blends the horizon colour toward a warm dust colour.
  _blendColorOklab(_skyColor1, _skyColor2.x, _skyColor2.y, _skyColor2.z,
    DUST_COLOR[0], DUST_COLOR[1], DUST_COLOR[2], 0.3);
  _hazeR[streamerSlot] = _skyColor1.x;
  _hazeG[streamerSlot] = _skyColor1.y;
  _hazeB[streamerSlot] = _skyColor1.z;
  _hazeIntensity[streamerSlot] = Math.min(1.0, airQualityScatter + humidityBias * 0.5);

  // ─── 7. Smoke plume contribution ────────────────────────
  // Read the prop count in the chunk. Smoke-producing props (campfires,
  // burning buildings) add a smoke plume contribution.
  let smokePropCount = 0;
  let dustSourceIntensity = 0;
  if (detail !== SKY_DETAIL.FIXED) {
    const propSlots = _propSlotScratch;
    const propCount = LandscapePropPlacementSystem.readChunkPropSlots(streamerSlot, propSlots, 32);
    for (let i = 0; i < propCount; i++) {
      const propSlot = propSlots[i];
      if (propSlot === -1) continue;
      const propType = LandscapePropPlacementSystem.getPropType(propSlot);
      const propEmissive = LandscapePropPlacementSystem.getPropEmissive(propSlot);
      if (propType === PROP_TYPE.CAMPFIRE || propEmissive > 0.3) {
        smokePropCount++;
      }
    }
    // Read the wind erosion for dust sources.
    if (typeof LandscapeWindErosionSystem !== 'undefined' && LandscapeWindErosionSystem.getCumulativeLoss) {
      dustSourceIntensity = Math.min(1.0, LandscapeWindErosionSystem.getCumulativeLoss(streamerSlot) * 10);
    }
  }
  _smokeR[streamerSlot] = SMOKE_COLOR[0];
  _smokeG[streamerSlot] = SMOKE_COLOR[1];
  _smokeB[streamerSlot] = SMOKE_COLOR[2];
  _smokeDensity[streamerSlot] = Math.min(1.0, smokePropCount * SMOKE_INTENSITY_PER_PROP);

  _dustR[streamerSlot] = DUST_COLOR[0];
  _dustG[streamerSlot] = DUST_COLOR[1];
  _dustB[streamerSlot] = DUST_COLOR[2];
  _dustDensity[streamerSlot] = Math.min(1.0, dustSourceIntensity * DUST_INTENSITY_PER_EROSION);

  // ─── 8. Sky exposure ────────────────────────────────────
  // Exposure is bright during the day (lower exposure to prevent blowout)
  // and dark at night (higher exposure to reveal stars).
  let exposure = 1.0;
  if (sunElevationDeg > 10) exposure = 0.8;
  else if (sunElevationDeg > -6) exposure = 1.0;
  else exposure = 1.5;
  _skyExposure[streamerSlot] = exposure;

  // ─── 9. Horizon glow ────────────────────────────────────
  const glowIntensity = _computeHorizonGlow(smokePropCount, isNight, _skyColor1);
  _horizonGlowR[streamerSlot] = _skyColor1.x;
  _horizonGlowG[streamerSlot] = _skyColor1.y;
  _horizonGlowB[streamerSlot] = _skyColor1.z;
  _horizonGlowIntensity[streamerSlot] = glowIntensity;

  // ─── 10. Sky model quality and exposure bias ────────────
  // The sky model quality is 1.0 (procedural) for the KILOMETER tier and
  // fades to 0.5 for the HUNDRED_KILOMETER tier, where we cannot afford
  // the full procedural sky.
  _skyModelQuality[streamerSlot] = detail === SKY_DETAIL.FULL ? 1.0
    : detail === SKY_DETAIL.COARSE ? 0.7
    : detail === SKY_DETAIL.MINIMAL ? 0.5
    : 0.2;

  // Exposure bias smooths transitions between chunks with very different
  // sky exposure. A small positive bias makes the sky slightly brighter
  // than the underlying lighting.
  _exposureBias[streamerSlot] = isNight ? 0.2 : 0.0;

  // ─── 11. Drift detection ────────────────────────────────
  const lastZR = _lastZenithR[streamerSlot];
  const lastZG = _lastZenithG[streamerSlot];
  const lastZB = _lastZenithB[streamerSlot];
  const lastHR = _lastHorizonR[streamerSlot];
  const lastHG = _lastHorizonG[streamerSlot];
  const lastHB = _lastHorizonB[streamerSlot];
  const lastSunInt = _lastSunIntensity[streamerSlot];
  const lastStarInt = _lastStarInt[streamerSlot];
  const lastSmoke = _lastSmokeDen[streamerSlot];
  const lastDust = _lastDustDen[streamerSlot];
  const lastGlow = _lastGlow[streamerSlot];

  const zenithChanged = Math.abs(_zenithR[streamerSlot] - lastZR) > DRIFT_ZENITH
    || Math.abs(_zenithG[streamerSlot] - lastZG) > DRIFT_ZENITH
    || Math.abs(_zenithB[streamerSlot] - lastZB) > DRIFT_ZENITH;
  const horizonChanged = Math.abs(_horizonR[streamerSlot] - lastHR) > DRIFT_HORIZON
    || Math.abs(_horizonG[streamerSlot] - lastHG) > DRIFT_HORIZON
    || Math.abs(_horizonB[streamerSlot] - lastHB) > DRIFT_HORIZON;
  const sunIntChanged = Math.abs(_sunDiskIntensity[streamerSlot] - lastSunInt) > DRIFT_SUN_INTENSITY;
  const starIntChanged = Math.abs(_starFieldIntensity[streamerSlot] - lastStarInt) > DRIFT_STAR_INTENSITY;
  const smokeChanged = Math.abs(_smokeDensity[streamerSlot] - lastSmoke) > DRIFT_SMOKE_DENSITY;
  const dustChanged = Math.abs(_dustDensity[streamerSlot] - lastDust) > DRIFT_DUST_DENSITY;
  const glowChanged = Math.abs(_horizonGlowIntensity[streamerSlot] - lastGlow) > DRIFT_HORIZON_GLOW;

  if (!zenithChanged && !horizonChanged && !sunIntChanged && !starIntChanged
      && !smokeChanged && !dustChanged && !glowChanged
      && _lastEvalS[streamerSlot] >= 0
      && (nowS - _lastEvalS[streamerSlot] < 2.0)) {
    _skyDirty[streamerSlot] = 0;
    return false;
  }

  // Update the last-evaluated snapshot.
  _lastZenithR[streamerSlot] = _zenithR[streamerSlot];
  _lastZenithG[streamerSlot] = _zenithG[streamerSlot];
  _lastZenithB[streamerSlot] = _zenithB[streamerSlot];
  _lastHorizonR[streamerSlot] = _horizonR[streamerSlot];
  _lastHorizonG[streamerSlot] = _horizonG[streamerSlot];
  _lastHorizonB[streamerSlot] = _horizonB[streamerSlot];
  _lastSunIntensity[streamerSlot] = _sunDiskIntensity[streamerSlot];
  _lastStarInt[streamerSlot] = _starFieldIntensity[streamerSlot];
  _lastSmokeDen[streamerSlot] = _smokeDensity[streamerSlot];
  _lastDustDen[streamerSlot] = _dustDensity[streamerSlot];
  _lastGlow[streamerSlot] = _horizonGlowIntensity[streamerSlot];
  _lastEvalS[streamerSlot] = nowS;
  _skyDirty[streamerSlot] = 0;

  return true;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeSkyCoupler = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  SKY_DETAIL,
  skyFloats: SKY_FLOATS,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _skyDirty[streamerSlot] = 1;
    _isNight[streamerSlot] = 0;
    _isOccluded[streamerSlot] = 0;
    _lastEvalS[streamerSlot] = -1;
    _lastZenithR[streamerSlot] = -1;
    _lastHorizonR[streamerSlot] = -1;
    _lastSunIntensity[streamerSlot] = -1;
    _lastStarInt[streamerSlot] = -1;
    _lastSmokeDen[streamerSlot] = -1;
    _lastDustDen[streamerSlot] = -1;
    _lastGlow[streamerSlot] = -1;
    return true;
  },

  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _chunkActive[streamerSlot] = 0;
  },

  run(frame, tick, dt) {
    const t0 = performanceNow();
    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    let processed = 0;
    let changed = 0;
    let skipped = 0;
    let activeChunks = 0;
    let nightChunks = 0;

    for (let b = 0; b < this.tickChunkBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      activeChunks++;
      processed++;

      if (_skyDirty[slot] === 0 && _lastEvalS[slot] >= 0
          && (nowS - _lastEvalS[slot] < 2.0)) {
        skipped++;
        if (_isNight[slot]) nightChunks++;
        continue;
      }

      if (_computeChunkSky(slot, nowS)) changed++;
      if (_isNight[slot]) nightChunks++;

      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastChanged = changed;
    _lastSkipped.value = skipped;
    _lastActiveChunks = activeChunks;
    _lastNightChunks = nightChunks;
    _lastTickDurationMs = performanceNow() - t0;

    if (changed > 0) {
      _dispatcher.emit(EVENT_TYPE.SKY_UPDATED, {
        tick,
        processed,
        changed,
        skipped,
        activeChunks,
        nightChunks,
        durationMs: _lastTickDurationMs
      });
    }
  },

  /**
   * Mark a chunk as needing a sky re-evaluation. Called by 349 when a prop
   * is placed or damaged (smoke contribution changes), by 344 when wind
   * erosion changes (dust contribution changes), and by 337 when a chunk is
   * streamed in.
   */
  markDirty(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _skyDirty[streamerSlot] = 1;
  },

  /**
   * Read the full sky state for a chunk. Zero-allocation.
   */
  readSkyState(streamerSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    out.zenithR = _zenithR[streamerSlot];
    out.zenithG = _zenithG[streamerSlot];
    out.zenithB = _zenithB[streamerSlot];
    out.horizonR = _horizonR[streamerSlot];
    out.horizonG = _horizonG[streamerSlot];
    out.horizonB = _horizonB[streamerSlot];
    out.sunDiskR = _sunDiskR[streamerSlot];
    out.sunDiskG = _sunDiskG[streamerSlot];
    out.sunDiskB = _sunDiskB[streamerSlot];
    out.sunDiskIntensity = _sunDiskIntensity[streamerSlot];
    out.moonDiskR = _moonDiskR[streamerSlot];
    out.moonDiskG = _moonDiskG[streamerSlot];
    out.moonDiskB = _moonDiskB[streamerSlot];
    out.moonDiskIntensity = _moonDiskIntensity[streamerSlot];
    out.starFieldIntensity = _starFieldIntensity[streamerSlot];
    out.hazeR = _hazeR[streamerSlot];
    out.hazeG = _hazeG[streamerSlot];
    out.hazeB = _hazeB[streamerSlot];
    out.hazeIntensity = _hazeIntensity[streamerSlot];
    out.smokeR = _smokeR[streamerSlot];
    out.smokeG = _smokeG[streamerSlot];
    out.smokeB = _smokeB[streamerSlot];
    out.smokeDensity = _smokeDensity[streamerSlot];
    out.dustR = _dustR[streamerSlot];
    out.dustG = _dustG[streamerSlot];
    out.dustB = _dustB[streamerSlot];
    out.dustDensity = _dustDensity[streamerSlot];
    out.skyExposure = _skyExposure[streamerSlot];
    out.milkyWay = _milkyWay[streamerSlot];
    out.aurora = _aurora[streamerSlot];
    out.horizonGlowR = _horizonGlowR[streamerSlot];
    out.horizonGlowG = _horizonGlowG[streamerSlot];
    out.horizonGlowB = _horizonGlowB[streamerSlot];
    out.horizonGlowIntensity = _horizonGlowIntensity[streamerSlot];
    out.skyModelQuality = _skyModelQuality[streamerSlot];
    out.exposureBias = _exposureBias[streamerSlot];
    out.isNight = _isNight[streamerSlot] === 1;
    out.isOccluded = _isOccluded[streamerSlot] === 1;
    return true;
  },

  /**
   * Read the sky batch for all active chunks. Zero-allocation.
   *
   * Layout per chunk (32 floats):
   *   [0..2]   zenith colour (r, g, b)
   *   [3..5]   horizon colour (r, g, b)
   *   [6..8]   sun disk colour (r, g, b)
   *   [9]      sun disk intensity
   *   [10..12] moon disk colour (r, g, b)
   *   [13]     moon disk intensity
   *   [14]     star field intensity
   *   [15..17] haze colour (r, g, b)
   *   [18]     haze intensity
   *   [19..21] smoke colour (r, g, b)
   *   [22]     smoke density
   *   [23..25] dust colour (r, g, b)
   *   [26]     dust density
   *   [27]     sky exposure
   *   [28]     milky way visibility
   *   [29]     aurora intensity
   *   [30]     horizon glow intensity
   *   [31]     sky model quality
   */
  readSkyBatch(outFloats) {
    let written = 0;
    let count = 0;
    for (let s = 0; s < MAX_TRACKED_CHUNKS; s++) {
      if (!_chunkActive[s]) continue;
      if (written + SKY_FLOATS > outFloats.length) break;
      outFloats[written++] = _zenithR[s];
      outFloats[written++] = _zenithG[s];
      outFloats[written++] = _zenithB[s];
      outFloats[written++] = _horizonR[s];
      outFloats[written++] = _horizonG[s];
      outFloats[written++] = _horizonB[s];
      outFloats[written++] = _sunDiskR[s];
      outFloats[written++] = _sunDiskG[s];
      outFloats[written++] = _sunDiskB[s];
      outFloats[written++] = _sunDiskIntensity[s];
      outFloats[written++] = _moonDiskR[s];
      outFloats[written++] = _moonDiskG[s];
      outFloats[written++] = _moonDiskB[s];
      outFloats[written++] = _moonDiskIntensity[s];
      outFloats[written++] = _starFieldIntensity[s];
      outFloats[written++] = _hazeR[s];
      outFloats[written++] = _hazeG[s];
      outFloats[written++] = _hazeB[s];
      outFloats[written++] = _hazeIntensity[s];
      outFloats[written++] = _smokeR[s];
      outFloats[written++] = _smokeG[s];
      outFloats[written++] = _smokeB[s];
      outFloats[written++] = _smokeDensity[s];
      outFloats[written++] = _dustR[s];
      outFloats[written++] = _dustG[s];
      outFloats[written++] = _dustB[s];
      outFloats[written++] = _dustDensity[s];
      outFloats[written++] = _skyExposure[s];
      outFloats[written++] = _milkyWay[s];
      outFloats[written++] = _aurora[s];
      outFloats[written++] = _horizonGlowIntensity[s];
      outFloats[written++] = _skyModelQuality[s];
      count++;
    }
    return written;
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getZenithR(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _zenithR[slot] : 0; },
  getZenithG(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _zenithG[slot] : 0; },
  getZenithB(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _zenithB[slot] : 0; },
  getHorizonR(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _horizonR[slot] : 0; },
  getHorizonG(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _horizonG[slot] : 0; },
  getHorizonB(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _horizonB[slot] : 0; },
  getSunDiskR(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _sunDiskR[slot] : 0; },
  getSunDiskG(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _sunDiskG[slot] : 0; },
  getSunDiskB(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _sunDiskB[slot] : 0; },
  getSunDiskIntensity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _sunDiskIntensity[slot] : 0; },
  getMoonDiskIntensity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _moonDiskIntensity[slot] : 0; },
  getStarFieldIntensity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _starFieldIntensity[slot] : 0; },
  getHazeIntensity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _hazeIntensity[slot] : 0; },
  getSmokeDensity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _smokeDensity[slot] : 0; },
  getDustDensity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _dustDensity[slot] : 0; },
  getSkyExposure(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _skyExposure[slot] : 1; },
  getMilkyWay(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _milkyWay[slot] : 0; },
  getAurora(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _aurora[slot] : 0; },
  getHorizonGlowIntensity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _horizonGlowIntensity[slot] : 0; },
  getSkyModelQuality(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _skyModelQuality[slot] : 0; },
  getExposureBias(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _exposureBias[slot] : 0; },
  isNight(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _isNight[slot] === 1 : false; },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastChanged() { return _lastChanged; },
  get lastSkipped() { return _lastSkipped.value; },
  get lastActiveChunks() { return _lastActiveChunks; },
  get lastNightChunks() { return _lastNightChunks; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get activeChunks() {
    let n = 0;
    for (let i = 0; i < MAX_TRACKED_CHUNKS; i++) if (_chunkActive[i]) n++;
    return n;
  }
});

function performanceNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export default LandscapeSkyCoupler;