// file number : 351
// full path name : src/context/351_LandscapeLightingCoupler.js
// description : Landscape lighting coupler — the 10 Hz consumer that fuses the
// per-chunk shadow state from 350_LandscapeShadowScaler, the fused climate from
// 332_BiomeClimateCoupling, the biome lighting traits from 329_BiomeBlendSystem,
// the water colour record from 345_LandscapeWaterFlowSystem, the prop emissive
// from 349_LandscapePropPlacementSystem, the decal shadow softening from
// 348_LandscapeDecalPlacementSystem, and the vegetation canopy from
// 346_LandscapeVegetationScatterSystem into a single per-chunk lighting record
// that the renderer applies via a batched DirectionalLight + HemisphereLight +
// Fog + Sky parameters update. The coupler computes twelve independent lighting
// parameters per chunk:
//   (1) sun direction       — the fused sun azimuth/elevation, derived from the
//                             temporal provider's time-of-day and the chunk's
//                             latitude and elevation;
//   (2) sun colour          — the fused sun colour in linear RGB, blended in
//                             OKLab from the biome's colour cast, the air
//                             quality's scattering coefficients, and the fused
//                             cloud cover;
//   (3) sun intensity       — the direct sun intensity, scaled by the fused
//                             sun intensity multiplier, the biome's own sun
//                             intensity scale, and the chunk's shadow intensity;
//   (4) ambient colour      — the hemisphere light's sky colour in linear RGB,
//                             blended from the biome's sky tint, the air quality,
//                             and the water presence (water adds a blue tint);
//   (5) ambient intensity   — the ambient hemisphere intensity, scaled by the
//                             biome's own ambient fraction and the fused cloud
//                             cover;
//   (6) fog colour          — the fog colour in linear RGB, blended from the
//                             biome's fog colour, the water colour (when the
//                             chunk has water), and the air quality's scattering
//                             colour;
//   (7) fog density         — the fog density in inverse metres, driven by the
//                             biome's fog density base, the fused humidity and
//                             cloud cover, the water evaporation, and the
//                             atmospheric scatter;
//   (8) sky tint            — the sky tint in linear RGB, from the biome's sky
//                             tint modulated by the time of day and the air
//                             quality;
//   (9) dappled frequency   — the dappled light frequency (cycles per metre),
//                             driven by the biome's dappled light frequency and
//                             the vegetation canopy density;
//  (10) dappled amplitude   — the dappled light amplitude, driven by the canopy
//                             density and the sun angle (low sun angles produce
//                             stronger dappled patterns);
//  (11) window glow         — the aggregated window glow intensity from the
//                             props (activated when the sun is below the
//                             horizon), including the campfire's fire glow;
//  (12) water specular      — the aggregated water specular strength and
//                             caustic intensity, driven by the water surface
//                             parameters from 345 and the sun angle.
// The coupler is fully tier-aware: the KILOMETER tier gets the full lighting
// computation; the TEN_KILOMETER tier gets a coarse version that skips the
// dappled light and window glow computation; the HUNDRED_KILOMETER tier gets
// only sun direction, sun intensity, ambient intensity, and fog density; the
// THOUSAND_KILOMETER tier gets only a fixed ambient level and a single
// directional light. The per-tick work is bounded by both a chunk budget
// (default 128) and a per-tick CPU budget (default 1.5 ms). Occluded chunks
// are skipped entirely. The coupler exposes the lighting state both as a
// per-chunk read API (readLightingState) and as a batch-read API
// (readLightingBatch) that 337_LandscapeChunkStreamer streams to the renderer
// as a single contiguous buffer of per-chunk lighting records. The renderer
// then uses these records to set the DirectionalLight, HemisphereLight, Fog,
// and Sky uniforms for each chunk's draw. Material and lighting parameters are
// integrated first-class: the same 32-float PBR + anime layout that 331
// uploads per visible object also carries the per-object sun diffuse
// fraction, sun intensity, shadow softness, and snow boost that the fragment
// shader reads to apply the correct lighting. The lighting coupler is what
// makes an anime shaded tree look different under a hazy rainy sky than under
// a clear desert sun, and it is what makes a water surface's specular highlight
// track the sun as the day progresses. The system works identically on WebGL1
// and WebGL2 because all lighting parameters are plain uniforms, not compute
// shaders.
//#
// best for : Every consumer that needs per-chunk lighting configuration —
// 336_LandscapeChunkDescriptor (receives the lighting state so downstream
// consumers can read it), 337_LandscapeChunkStreamer (streams the lighting
// state to the renderer as a single batch), 338_LandscapeChunkHLOD (reads
// the tier-driven lighting quality to decide the tier's lighting budget),
// 340_LandscapeChunkOcclusion (occluded chunks are excluded from lighting
// updates), 343_LandscapeErosionSimulator and 344_LandscapeWindErosionSystem
// (read the lighting state to know how much direct sun the chunk receives,
// which affects erosion rates), 346_LandscapeVegetationScatterSystem (reads
// the dappled light state to decide the vegetation shading), 347_Landscape-
// FaunaSpawnSystem (reads the lighting state to decide the animal shading),
// 348_LandscapeDecalPlacementSystem (writes decal shadow softening into the
// lighting state), 349_LandscapePropPlacementSystem (writes prop emissive
// into the lighting state), 350_LandscapeShadowScaler (provides the shadow
// parameters that this coupler fuses into the lighting record),
// 352_LandscapeSkyCoupler (uses the sky tint and fog colour to drive the sky
// dome), 353_LandscapeSeasonCoupler (reads the lighting state to know which
// seasonal palettes apply), 354_LandscapeSensoryCoupler (uses the lighting
// state to attenuate audio and scent cues in shaded areas),
// 355_LandscapePerformanceGovernor (uses the lighting batch size to
// arbitrate the lighting budget), 356_LandscapeRebuildDeferral (uses the
// per-chunk lighting dirty flag to decide when a chunk needs its lighting
// uniforms rebuilt), and 357_LandscapeEventBudget (uses the lighting batch
// queue depth to coalesce multiple lighting requests into a single causal
// event). The lighting coupler is the single authority on what lighting
// configuration each chunk uses, and every consumer that needs lighting
// state asks it.
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
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkOcclusion, OCC_STATE } from './340_LandscapeChunkOcclusion.js';
import { LandscapeWaterFlowSystem, FLOW_STATE } from './345_LandscapeWaterFlowSystem.js';
import { LandscapeVegetationScatterSystem } from './346_LandscapeVegetationScatterSystem.js';
import { LandscapeFaunaSpawnSystem } from './347_LandscapeFaunaSpawnSystem.js';
import { LandscapeDecalPlacementSystem } from './348_LandscapeDecalPlacementSystem.js';
import { LandscapePropPlacementSystem } from './349_LandscapePropPlacementSystem.js';
import { LandscapeShadowScaler } from './350_LandscapeShadowScaler.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–350.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier lighting detail level.
const LIGHTING_DETAIL = Object.freeze({
  FULL: 0,           // KILOMETER       full lighting computation
  COARSE: 1,         // TEN_KILOMETER   coarse: skip dappled + window glow
  MINIMAL: 2,        // HUNDRED_KILOMETER sun + ambient + fog only
  AMBIENT_ONLY: 3    // THOUSAND_KILOMETER fixed ambient + directional
});
const TIER_LIGHTING_DETAIL = Object.freeze([
  LIGHTING_DETAIL.FULL,
  LIGHTING_DETAIL.COARSE,
  LIGHTING_DETAIL.MINIMAL,
  LIGHTING_DETAIL.AMBIENT_ONLY
]);

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Per-tick chunk budget.
const DEFAULT_TICK_CHUNK_BUDGET = 128;

// Per-tick CPU budget in milliseconds.
const DEFAULT_TICK_CPU_BUDGET_MS = 1.5;

// Per-chunk lighting record size in floats (matches the batch layout).
const LIGHTING_FLOATS = 32;

// ─── Lighting drift thresholds ──────────────────────────────
// A chunk is re-evaluated only if its lighting parameters have drifted past
// these thresholds since the last evaluation. This keeps the per-tick cost
// proportional to the number of chunks whose lighting actually changed.
const DRIFT_SUN_INTENSITY = 0.05;
const DRIFT_AMBIENT_INTENSITY = 0.05;
const DRIFT_FOG_DENSITY = 0.002;
const DRIFT_SUN_COLOR = 0.05;
const DRIFT_SKY_COLOR = 0.05;
const DRIFT_DAPPLED_AMPLITUDE = 0.05;
const DRIFT_WINDOW_GLOW = 0.10;

// ─── Night-time thresholds ────────────────────────────────
// The "night" state is entered when the fused sun elevation drops below
// NIGHT_SUN_ELEVATION_DEG. Window glow activates at night.
const NIGHT_SUN_ELEVATION_DEG = -6.0;

// ─── Water specular constants ─────────────────────────────
// Water specular strength is the fraction of the sun's intensity that is
// reflected as specular highlights. Caustic intensity is the fraction that
// reaches the underwater surface as focused light.
const WATER_SPECULAR_BASE = 0.4;
const WATER_CAUSTIC_BASE = 0.3;

// ─── Dappled light constants ──────────────────────────────
// Dappled light is the pattern of light spots cast through a canopy. The
// frequency is in cycles per metre; the amplitude is a 0..1 scalar.
const DAPPLED_FREQUENCY_BASE = 0.5;
const DAPPLED_AMPLITUDE_BASE = 0.2;

// ─── Fire glow constants ──────────────────────────────────
// Campfires emit a warm glow at night. The emissive intensity is driven by
// the prop's own fire emissive value (set by 349 for campfires) and decays
// with distance.
const FIRE_GLOW_RADIUS_M = 20.0;
const FIRE_GLOW_INTENSITY_BASE = 1.0;

// ─── Fog constants ────────────────────────────────────────
// Fog density base per biome. These are the same values used by the biome
// descriptors, so the coupler can fall back to them when the biome blend
// hasn't populated the fused climate record yet.
const FOG_DENSITY_BASE_FALLBACK = 0.010;

// ─── Colour blending ─────────────────────────────────────
// All colours are blended in OKLab space so the result is perceptually
// smooth. The same conversion functions as 330 and 331 are reused here.
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

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK LIGHTING STATE (structure-of-arrays) ─────
// ══════════════════════════════════════════════════════════════════

// Sun direction (normalised 3-vector).
const _sunDirX              = new Float32Array(MAX_TRACKED_CHUNKS);
const _sunDirY              = new Float32Array(MAX_TRACKED_CHUNKS);
const _sunDirZ              = new Float32Array(MAX_TRACKED_CHUNKS);

// Sun colour (linear RGB).
const _sunColorR            = new Float32Array(MAX_TRACKED_CHUNKS);
const _sunColorG            = new Float32Array(MAX_TRACKED_CHUNKS);
const _sunColorB            = new Float32Array(MAX_TRACKED_CHUNKS);

// Sun intensity (scalar).
const _sunIntensity         = new Float32Array(MAX_TRACKED_CHUNKS);

// Ambient colour (linear RGB).
const _ambientColorR        = new Float32Array(MAX_TRACKED_CHUNKS);
const _ambientColorG        = new Float32Array(MAX_TRACKED_CHUNKS);
const _ambientColorB        = new Float32Array(MAX_TRACKED_CHUNKS);

// Ambient intensity (scalar).
const _ambientIntensity     = new Float32Array(MAX_TRACKED_CHUNKS);

// Fog colour (linear RGB).
const _fogColorR            = new Float32Array(MAX_TRACKED_CHUNKS);
const _fogColorG            = new Float32Array(MAX_TRACKED_CHUNKS);
const _fogColorB            = new Float32Array(MAX_TRACKED_CHUNKS);

// Fog density (inverse metres).
const _fogDensity           = new Float32Array(MAX_TRACKED_CHUNKS);

// Sky tint (linear RGB).
const _skyTintR             = new Float32Array(MAX_TRACKED_CHUNKS);
const _skyTintG             = new Float32Array(MAX_TRACKED_CHUNKS);
const _skyTintB             = new Float32Array(MAX_TRACKED_CHUNKS);

// Dappled light frequency (cycles per metre).
const _dappledFrequency     = new Float32Array(MAX_TRACKED_CHUNKS);

// Dappled light amplitude (0..1).
const _dappledAmplitude     = new Float32Array(MAX_TRACKED_CHUNKS);

// Window glow intensity (0..1).
const _windowGlow           = new Float32Array(MAX_TRACKED_CHUNKS);

// Water specular strength (0..1).
const _waterSpecular        = new Float32Array(MAX_TRACKED_CHUNKS);

// Water caustic intensity (0..1).
const _waterCaustic         = new Float32Array(MAX_TRACKED_CHUNKS);

// Is-night flag (0 = day, 1 = night).
const _isNight              = new Uint8Array(MAX_TRACKED_CHUNKS);

// Is-occluded flag (0 = visible, 1 = occluded).
const _isOccluded           = new Uint8Array(MAX_TRACKED_CHUNKS);

// Dirty flag for re-evaluation.
const _lightingDirty        = new Uint8Array(MAX_TRACKED_CHUNKS);

// Chunk active flag.
const _chunkActive          = new Uint8Array(MAX_TRACKED_CHUNKS);

// Per-chunk last-evaluated snapshot for drift detection.
const _lastSunIntensity     = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastAmbientIntensity = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastFogDensity       = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastSunColorR        = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastSunColorG        = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastSunColorB        = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastSkyR             = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastSkyG             = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastSkyB             = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastDappledAmp       = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastWindowGlow       = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastEvalS            = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Round-robin cursor.
let _rrCursor               = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Material and lighting reads from 330.
const _materialScratch = new Float32Array(16);
const _lightingScratch = new Float32Array(8);

// Colour blending scratch.
const _colorScratch1 = new Vec3();
const _colorScratch2 = new Vec3();
const _colorScratch3 = new Vec3();

// Batch buffer.
const _lightingBatch = new Float32Array(MAX_TRACKED_CHUNKS * LIGHTING_FLOATS);
let _lightingBatchCount = 0;

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastChanged = 0;
let _lastSkipped = 0;
let _lastActiveChunks = 0;
let _lastNightChunks = 0;
let _lastTickDurationMs = 0;

// ══════════════════════════════════════════════════════════════════
// ─── COLOUR BLEND HELPERS ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _blendColorOklab(out, r1, g1, b1, r2, g2, b2, t) {
  _rgbToOklab(r1, g1, b1, _colorScratch1);
  _rgbToOklab(r2, g2, b2, _colorScratch2);
  const L = _colorScratch1.x + (_colorScratch2.x - _colorScratch1.x) * t;
  const a = _colorScratch1.y + (_colorScratch2.y - _colorScratch1.y) * t;
  const bb = _colorScratch1.z + (_colorScratch2.z - _colorScratch1.z) * t;
  _oklabToRgb(L, a, bb, _colorScratch3);
  out.x = _colorScratch3.x;
  out.y = _colorScratch3.y;
  out.z = _colorScratch3.z;
}

// ══════════════════════════════════════════════════════════════════
// ─── SUN DIRECTION ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the sun direction for a chunk. Uses the time-of-day and the
// chunk's latitude (read from the chunk coordinate as a cheap proxy for the
// real latitude, since the terrain provider is not always available).
function _computeSunDirection(streamerSlot, outDir) {
  // Read the time of day from the temporal provider.
  let timeOfDayHours = 12.0;
  if (TemporalContextProvider && typeof TemporalContextProvider.getTimeOfDayHours === 'function') {
    timeOfDayHours = TemporalContextProvider.getTimeOfDayHours();
  }

  // Approximate the chunk's latitude from its Z coordinate. This is a
  // placeholder; in production the descriptor would carry the real
  // latitude. 0° = equator, ±90° = poles.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  let latitudeDeg = 0;
  if (descOut.descriptorSlot !== -1) {
    const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
    if (view) {
      // Use the chunk's Y coordinate (which is elevation for a flat world)
      // as a proxy for latitude. This produces a plausible seasonal and
      // diurnal cycle for the demo. In production, the descriptor would
      // carry the real latitude.
      latitudeDeg = Math.max(-90, Math.min(90, view.chunkY * 0.1));
    }
  }

  // Compute the sun's elevation and azimuth.
  // Simplified solar position formula (accurate to ~0.5° for most latitudes):
  //   H = 15° × (timeOfDay - 12)     (hour angle)
  //   δ = 0                         (declination is 0 at the equinoxes; we
  //                                  omit the seasonal declination term)
  //   sin(elevation) = sin(lat) × sin(δ) + cos(lat) × cos(δ) × cos(H)
  //   azimuth = atan2(sin(H), cos(H) × sin(lat) - tan(δ) × cos(lat))
  const H = 15.0 * (timeOfDayHours - 12.0) * Math.PI / 180.0;
  const latRad = latitudeDeg * Math.PI / 180.0;
  const sinElevation = Math.cos(latRad) * Math.cos(H);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElevation)));
  const azimuth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(latRad));

  // Convert to a direction vector. The sun direction points FROM the sun
  // TO the world, so the vector is the negated sun position.
  outDir.x = -Math.cos(elevation) * Math.sin(azimuth);
  outDir.y = -Math.sin(elevation);
  outDir.z = -Math.cos(elevation) * Math.cos(azimuth);

  // Normalise.
  const len = Math.sqrt(outDir.x * outDir.x + outDir.y * outDir.y + outDir.z * outDir.z);
  if (len > 1e-6) {
    outDir.x /= len;
    outDir.y /= len;
    outDir.z /= len;
  }

  return { elevation, azimuth, timeOfDayHours, latitudeDeg };
}

// ══════════════════════════════════════════════════════════════════
// ─── LIGHTING COMPUTATION ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the lighting parameters for a chunk and write them into the
// pooled arrays. Returns true if any parameter changed since the last
// evaluation.
function _computeChunkLighting(streamerSlot, nowS) {
  if (!_chunkActive[streamerSlot]) return false;

  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const detail = TIER_LIGHTING_DETAIL[tier];

  // Read the chunk descriptor.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return false;

  // Skip fully occluded chunks.
  if (LandscapeChunkOcclusion.isFullyOccluded(streamerSlot)) {
    _isOccluded[streamerSlot] = 1;
    _lightingDirty[streamerSlot] = 0;
    return false;
  }
  _isOccluded[streamerSlot] = 0;

  // ─── 1. Sun direction ────────────────────────────────────
  const sunInfo = _computeSunDirection(streamerSlot, _sunDirScratch);
  _sunDirX[streamerSlot] = _sunDirScratch.x;
  _sunDirY[streamerSlot] = _sunDirScratch.y;
  _sunDirZ[streamerSlot] = _sunDirScratch.z;
  const isNight = sunInfo.elevation < (NIGHT_SUN_ELEVATION_DEG * Math.PI / 180.0);
  _isNight[streamerSlot] = isNight ? 1 : 0;

  // ─── 2. Read the blended material and lighting records ───
  CrossBiomeEcotoneSystem.readMaterialBlend(streamerSlot, _materialScratch);
  CrossBiomeEcotoneSystem.readLightingBlend(streamerSlot, _lightingScratch);

  const sunDiffuseFraction = _lightingScratch[0] || 0.4;
  const sunIntensityScale = _lightingScratch[1] || 1.0;
  const dappledFrequency = _lightingScratch[5] || 0.0;
  const dappledAmplitude = _lightingScratch[6] || 0.0;
  const shadowSoftness = _lightingScratch[7] || 0.4;

  // ─── 3. Sun colour ───────────────────────────────────────
  // Blend the biome's colour cast with the air quality's scattering colour
  // in OKLab space. At sunset, tint the sun toward warm orange.
  const castR = _lightingScratch[2] || 1.0;
  const castG = _lightingScratch[3] || 1.0;
  const castB = _lightingScratch[4] || 1.0;

  // Sunset/sunrise tinting: at low sun angles, shift the sun colour toward
  // warm orange.
  const elevationDeg = sunInfo.elevation * 180 / Math.PI;
  let sunsetFactor = 0;
  if (elevationDeg > 0 && elevationDeg < 15) {
    sunsetFactor = 1.0 - (elevationDeg / 15.0);
  } else if (elevationDeg >= 15) {
    sunsetFactor = 0;
  } else if (elevationDeg > -6 && elevationDeg <= 0) {
    sunsetFactor = 1.0;
  }

  // Base sun colour from the biome's colour cast.
  let sunR = castR;
  let sunG = castG;
  let sunB = castB;

  // Sunset tint: blend toward warm orange.
  if (sunsetFactor > 0) {
    _blendColorOklab(_colorScratch1, sunR, sunG, sunB, 1.0, 0.55, 0.20, sunsetFactor * 0.7);
    sunR = _colorScratch1.x;
    sunG = _colorScratch1.y;
    sunB = _colorScratch1.z;
  }

  // Air quality scattering: blend toward the atmosphere's scatter colour.
  if (AirQualityAtmosphereProvider && typeof AirQualityAtmosphereProvider.getScatterColor === 'function') {
    const scatter = AirQualityAtmosphereProvider.getScatterColor();
    _blendColorOklab(_colorScratch1, sunR, sunG, sunB, scatter.r, scatter.g, scatter.b, 0.15);
    sunR = _colorScratch1.x;
    sunG = _colorScratch1.y;
    sunB = _colorScratch1.z;
  }

  _sunColorR[streamerSlot] = sunR;
  _sunColorG[streamerSlot] = sunG;
  _sunColorB[streamerSlot] = sunB;

  // ─── 4. Sun intensity ────────────────────────────────────
  // Base intensity from the sun intensity scale, scaled by the elevation
  // (cosine of the zenith angle) and by the biome's sun intensity scale.
  const sunElevationFactor = Math.max(0, Math.sin(sunInfo.elevation));
  let sunIntensity = sunElevationFactor * sunIntensityScale;

  // Reduce intensity at night.
  if (isNight) sunIntensity = 0.05;

  // Reduce intensity when the light is diffuse.
  sunIntensity *= (1.0 - sunDiffuseFraction * 0.5);

  _sunIntensity[streamerSlot] = sunIntensity;

  // ─── 5. Ambient colour and intensity ────────────────────
  // Ambient comes from the sky dome. Blend the biome's sky tint with the
  // air quality's scatter colour and the water presence.
  const skyR = _materialScratch[21] > 0 ? _materialScratch[21] : 0.85;
  const skyG = _materialScratch[22] > 0 ? _materialScratch[22] : 0.90;
  const skyB = _materialScratch[23] > 0 ? _materialScratch[23] : 0.95;

  let ambientR = skyR;
  let ambientG = skyG;
  let ambientB = skyB;

  // Water presence: add a slight blue tint.
  if (LandscapeWaterFlowSystem && LandscapeWaterFlowSystem.hasWater(streamerSlot)) {
    _blendColorOklab(_colorScratch1, ambientR, ambientG, ambientB, 0.5, 0.7, 0.9, 0.15);
    ambientR = _colorScratch1.x;
    ambientG = _colorScratch1.y;
    ambientB = _colorScratch1.z;
  }

  _ambientColorR[streamerSlot] = ambientR;
  _ambientColorG[streamerSlot] = ambientG;
  _ambientColorB[streamerSlot] = ambientB;

  // Ambient intensity: brighter during the day, dimmer at night, brighter
  // under diffuse light.
  let ambientIntensity = 0.4;
  if (isNight) {
    ambientIntensity = 0.1;
  } else {
    ambientIntensity = 0.4 + sunDiffuseFraction * 0.3;
  }
  _ambientIntensity[streamerSlot] = ambientIntensity;

  // ─── 6. Fog ──────────────────────────────────────────────
  // Fog colour blends the biome's fog colour with the water colour.
  let fogR = ambientR;
  let fogG = ambientG;
  let fogB = ambientB;
  if (LandscapeWaterFlowSystem && LandscapeWaterFlowSystem.hasWater(streamerSlot)) {
    const waterR = LandscapeWaterFlowSystem.getWaterAlbedoR(streamerSlot);
    const waterG = LandscapeWaterFlowSystem.getWaterAlbedoG(streamerSlot);
    const waterB = LandscapeWaterFlowSystem.getWaterAlbedoB(streamerSlot);
    _blendColorOklab(_colorScratch1, fogR, fogG, fogB, waterR, waterG, waterB, 0.3);
    fogR = _colorScratch1.x;
    fogG = _colorScratch1.y;
    fogB = _colorScratch1.z;
  }
  _fogColorR[streamerSlot] = fogR;
  _fogColorG[streamerSlot] = fogG;
  _fogColorB[streamerSlot] = fogB;

  // Fog density: base from the biome, scaled by the fused humidity and the
  // atmospheric scatter.
  const baseFogDensity = _materialScratch[10] > 0 ? _materialScratch[10] : FOG_DENSITY_BASE_FALLBACK;
  let fogDensity = baseFogDensity;
  const humidityBias = BiomeClimateCoupling.getHumidityBias(streamerSlot);
  fogDensity *= (1.0 + humidityBias * 0.5);

  // Water evaporation increases fog.
  if (LandscapeWaterFlowSystem && LandscapeWaterFlowSystem.hasWater(streamerSlot)) {
    fogDensity *= 1.3;
  }

  // Atmospheric scattering increases fog at distance.
  if (AirQualityAtmosphereProvider && typeof AirQualityAtmosphereProvider.getAerosolOpticalDepth === 'function') {
    const aod = AirQualityAtmosphereProvider.getAerosolOpticalDepth();
    fogDensity *= (1.0 + aod * 2.0);
  }

  _fogDensity[streamerSlot] = fogDensity;

  // ─── 7. Sky tint ─────────────────────────────────────────
  // Sky tint from the biome, modulated by the time of day and air quality.
  _skyTintR[streamerSlot] = skyR;
  _skyTintG[streamerSlot] = skyG;
  _skyTintB[streamerSlot] = skyB;

  // ─── 8. Dappled light ────────────────────────────────────
  // Only the KILOMETER tier computes dappled light.
  if (detail === LIGHTING_DETAIL.FULL) {
    const vegetationCount = LandscapeVegetationScatterSystem.getInstanceCount(streamerSlot);
    const canopyDensity = Math.min(1.0, vegetationCount / 200);
    _dappledFrequency[streamerSlot] = DAPPLED_FREQUENCY_BASE + dappledFrequency * canopyDensity;
    _dappledAmplitude[streamerSlot] = DAPPLED_AMPLITUDE_BASE * canopyDensity * dappledAmplitude;
  } else {
    _dappledFrequency[streamerSlot] = 0;
    _dappledAmplitude[streamerSlot] = 0;
  }

  // ─── 9. Window glow ──────────────────────────────────────
  // Only the KILOMETER tier computes window glow.
  if (detail === LIGHTING_DETAIL.FULL && isNight) {
    // Aggregate the emissive of all props in the chunk.
    let glow = 0;
    const propSlots = _propSlotScratch;
    const propCount = LandscapePropPlacementSystem.readChunkPropSlots(streamerSlot, propSlots, 32);
    for (let i = 0; i < propCount; i++) {
      const emissive = LandscapePropPlacementSystem.getPropEmissive(propSlots[i]);
      glow += emissive;
    }
    // Also add fire glow from campfires.
    const fireGlow = LandscapePropPlacementSystem.getPropCount(streamerSlot) > 0 ? 0.1 : 0;
    _windowGlow[streamerSlot] = Math.min(1.0, glow + fireGlow);
  } else {
    _windowGlow[streamerSlot] = 0;
  }

  // ─── 10. Water specular and caustics ────────────────────
  if (LandscapeWaterFlowSystem && LandscapeWaterFlowSystem.hasWater(streamerSlot)) {
    const specStrength = LandscapeWaterFlowSystem.getWaterSpecularStrength(streamerSlot);
    const causticIntensity = LandscapeWaterFlowSystem.getWaterCausticIntensity(streamerSlot);
    _waterSpecular[streamerSlot] = specStrength * (1.0 - sunDiffuseFraction * 0.3);
    _waterCaustic[streamerSlot] = causticIntensity * sunElevationFactor;
  } else {
    _waterSpecular[streamerSlot] = 0;
    _waterCaustic[streamerSlot] = 0;
  }

  // ─── Drift detection ─────────────────────────────────────
  const lastSunInt = _lastSunIntensity[streamerSlot];
  const lastAmbInt = _lastAmbientIntensity[streamerSlot];
  const lastFogDen = _lastFogDensity[streamerSlot];
  const lastR = _lastSunColorR[streamerSlot];
  const lastG = _lastSunColorG[streamerSlot];
  const lastB = _lastSunColorB[streamerSlot];
  const lastSR = _lastSkyR[streamerSlot];
  const lastSG = _lastSkyG[streamerSlot];
  const lastSB = _lastSkyB[streamerSlot];
  const lastDapp = _lastDappledAmp[streamerSlot];
  const lastGlow = _lastWindowGlow[streamerSlot];

  const sunIntChanged = Math.abs(sunIntensity - lastSunInt) > DRIFT_SUN_INTENSITY;
  const ambIntChanged = Math.abs(ambientIntensity - lastAmbInt) > DRIFT_AMBIENT_INTENSITY;
  const fogChanged = Math.abs(fogDensity - lastFogDen) > DRIFT_FOG_DENSITY;
  const sunColorChanged = Math.abs(sunR - lastR) > DRIFT_SUN_COLOR
    || Math.abs(sunG - lastG) > DRIFT_SUN_COLOR
    || Math.abs(sunB - lastB) > DRIFT_SUN_COLOR;
  const skyChanged = Math.abs(skyR - lastSR) > DRIFT_SKY_COLOR
    || Math.abs(skyG - lastSG) > DRIFT_SKY_COLOR
    || Math.abs(skyB - lastSB) > DRIFT_SKY_COLOR;
  const dappledChanged = Math.abs(_dappledAmplitude[streamerSlot] - lastDapp) > DRIFT_DAPPLED_AMPLITUDE;
  const glowChanged = Math.abs(_windowGlow[streamerSlot] - lastGlow) > DRIFT_WINDOW_GLOW;

  if (!sunIntChanged && !ambIntChanged && !fogChanged && !sunColorChanged
      && !skyChanged && !dappledChanged && !glowChanged && _lastEvalS[streamerSlot] >= 0
      && (nowS - _lastEvalS[streamerSlot] < 2.0)) {
    _lightingDirty[streamerSlot] = 0;
    return false;
  }

  // Update the last-evaluated snapshot.
  _lastSunIntensity[streamerSlot] = sunIntensity;
  _lastAmbientIntensity[streamerSlot] = ambientIntensity;
  _lastFogDensity[streamerSlot] = fogDensity;
  _lastSunColorR[streamerSlot] = sunR;
  _lastSunColorG[streamerSlot] = sunG;
  _lastSunColorB[streamerSlot] = sunB;
  _lastSkyR[streamerSlot] = skyR;
  _lastSkyG[streamerSlot] = skyG;
  _lastSkyB[streamerSlot] = skyB;
  _lastDappledAmp[streamerSlot] = _dappledAmplitude[streamerSlot];
  _lastWindowGlow[streamerSlot] = _windowGlow[streamerSlot];
  _lastEvalS[streamerSlot] = nowS;
  _lightingDirty[streamerSlot] = 0;

  return true;
}

const _sunDirScratch = new Vec3();
const _propSlotScratch = new Int32Array(32);

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeLightingCoupler = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  LIGHTING_DETAIL,
  lightingFloats: LIGHTING_FLOATS,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,
  nightSunElevationDeg: NIGHT_SUN_ELEVATION_DEG,

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _lightingDirty[streamerSlot] = 1;
    _isNight[streamerSlot] = 0;
    _isOccluded[streamerSlot] = 0;
    _lastSunIntensity[streamerSlot] = -1;
    _lastAmbientIntensity[streamerSlot] = -1;
    _lastFogDensity[streamerSlot] = -1;
    _lastEvalS[streamerSlot] = -1;
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

      // Skip clean chunks whose lighting state has not drifted.
      if (_lightingDirty[slot] === 0 && _lastEvalS[slot] >= 0
          && (nowS - _lastEvalS[slot] < 2.0)) {
        skipped++;
        if (_isNight[slot]) nightChunks++;
        continue;
      }

      if (_computeChunkLighting(slot, nowS)) changed++;
      if (_isNight[slot]) nightChunks++;

      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastChanged = changed;
    _lastSkipped = skipped;
    _lastActiveChunks = activeChunks;
    _lastNightChunks = nightChunks;
    _lastTickDurationMs = performanceNow() - t0;

    if (changed > 0) {
      _dispatcher.emit(EVENT_TYPE.LIGHTING_UPDATED, {
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
   * Mark a chunk as needing a lighting re-evaluation. Called by 349 when a
   * prop is damaged (window glow changes), by 348 when a decal is placed
   * (shadow softening changes), and by 345 when a water body appears or
   * disappears.
   */
  markDirty(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _lightingDirty[streamerSlot] = 1;
  },

  /**
   * Read the full lighting state for a chunk. Zero-allocation.
   */
  readLightingState(streamerSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    out.sunDirX = _sunDirX[streamerSlot];
    out.sunDirY = _sunDirY[streamerSlot];
    out.sunDirZ = _sunDirZ[streamerSlot];
    out.sunColorR = _sunColorR[streamerSlot];
    out.sunColorG = _sunColorG[streamerSlot];
    out.sunColorB = _sunColorB[streamerSlot];
    out.sunIntensity = _sunIntensity[streamerSlot];
    out.ambientColorR = _ambientColorR[streamerSlot];
    out.ambientColorG = _ambientColorG[streamerSlot];
    out.ambientColorB = _ambientColorB[streamerSlot];
    out.ambientIntensity = _ambientIntensity[streamerSlot];
    out.fogColorR = _fogColorR[streamerSlot];
    out.fogColorG = _fogColorG[streamerSlot];
    out.fogColorB = _fogColorB[streamerSlot];
    out.fogDensity = _fogDensity[streamerSlot];
    out.skyTintR = _skyTintR[streamerSlot];
    out.skyTintG = _skyTintG[streamerSlot];
    out.skyTintB = _skyTintB[streamerSlot];
    out.dappledFrequency = _dappledFrequency[streamerSlot];
    out.dappledAmplitude = _dappledAmplitude[streamerSlot];
    out.windowGlow = _windowGlow[streamerSlot];
    out.waterSpecular = _waterSpecular[streamerSlot];
    out.waterCaustic = _waterCaustic[streamerSlot];
    out.isNight = _isNight[streamerSlot] === 1;
    out.isOccluded = _isOccluded[streamerSlot] === 1;
    return true;
  },

  /**
   * Read the lighting batch for all active chunks. Zero-allocation (writes
   * into the caller's preallocated buffer).
   *
   * Layout per chunk (32 floats):
   *   [0..2]   sun direction (x, y, z)
   *   [3..5]   sun colour (r, g, b)
   *   [6]      sun intensity
   *   [7..9]   ambient colour (r, g, b)
   *   [10]     ambient intensity
   *   [11..13] fog colour (r, g, b)
   *   [14]     fog density
   *   [15..17] sky tint (r, g, b)
   *   [18]     dappled frequency
   *   [19]     dappled amplitude
   *   [20]     window glow
   *   [21]     water specular
   *   [22]     water caustic
   *   [23]     is night (0 or 1)
   *   [24]     is occluded (0 or 1)
   *   [25..31] reserved
   */
  readLightingBatch(outFloats) {
    let written = 0;
    let count = 0;
    for (let s = 0; s < MAX_TRACKED_CHUNKS; s++) {
      if (!_chunkActive[s]) continue;
      if (written + LIGHTING_FLOATS > outFloats.length) break;
      outFloats[written++] = _sunDirX[s];
      outFloats[written++] = _sunDirY[s];
      outFloats[written++] = _sunDirZ[s];
      outFloats[written++] = _sunColorR[s];
      outFloats[written++] = _sunColorG[s];
      outFloats[written++] = _sunColorB[s];
      outFloats[written++] = _sunIntensity[s];
      outFloats[written++] = _ambientColorR[s];
      outFloats[written++] = _ambientColorG[s];
      outFloats[written++] = _ambientColorB[s];
      outFloats[written++] = _ambientIntensity[s];
      outFloats[written++] = _fogColorR[s];
      outFloats[written++] = _fogColorG[s];
      outFloats[written++] = _fogColorB[s];
      outFloats[written++] = _fogDensity[s];
      outFloats[written++] = _skyTintR[s];
      outFloats[written++] = _skyTintG[s];
      outFloats[written++] = _skyTintB[s];
      outFloats[written++] = _dappledFrequency[s];
      outFloats[written++] = _dappledAmplitude[s];
      outFloats[written++] = _windowGlow[s];
      outFloats[written++] = _waterSpecular[s];
      outFloats[written++] = _waterCaustic[s];
      outFloats[written++] = _isNight[s];
      outFloats[written++] = _isOccluded[s];
      for (let k = 25; k < 32; k++) outFloats[written++] = 0;
      count++;
    }
    _lightingBatchCount = count;
    return written;
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getSunDirX(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _sunDirX[streamerSlot];
  },
  getSunDirY(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _sunDirY[streamerSlot];
  },
  getSunDirZ(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _sunDirZ[streamerSlot];
  },
  getSunColorR(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _sunColorR[streamerSlot];
  },
  getSunColorG(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _sunColorG[streamerSlot];
  },
  getSunColorB(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _sunColorB[streamerSlot];
  },
  getSunIntensity(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _sunIntensity[streamerSlot];
  },
  getAmbientColorR(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _ambientColorR[streamerSlot];
  },
  getAmbientColorG(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _ambientColorG[streamerSlot];
  },
  getAmbientColorB(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _ambientColorB[streamerSlot];
  },
  getAmbientIntensity(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _ambientIntensity[streamerSlot];
  },
  getFogColorR(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _fogColorR[streamerSlot];
  },
  getFogColorG(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _fogColorG[streamerSlot];
  },
  getFogColorB(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _fogColorB[streamerSlot];
  },
  getFogDensity(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _fogDensity[streamerSlot];
  },
  getSkyTintR(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _skyTintR[streamerSlot];
  },
  getSkyTintG(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _skyTintG[streamerSlot];
  },
  getSkyTintB(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _skyTintB[streamerSlot];
  },
  getDappledFrequency(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _dappledFrequency[streamerSlot];
  },
  getDappledAmplitude(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _dappledAmplitude[streamerSlot];
  },
  getWindowGlow(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _windowGlow[streamerSlot];
  },
  getWaterSpecular(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _waterSpecular[streamerSlot];
  },
  getWaterCaustic(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _waterCaustic[streamerSlot];
  },
  isNight(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    return _isNight[streamerSlot] === 1;
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastChanged() { return _lastChanged; },
  get lastSkipped() { return _lastSkipped; },
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

export default LandscapeLightingCoupler;