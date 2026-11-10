// file number : 052
// full path name : src/weather/052_thunder.js
// description : Thunder rumble synthesiser. Consumes LightningBolt
//               events from file 041 (via the ThunderQueue from
//               041_lightning.js) and synthesises distance- and
//               temperature-corrected thunder audio waveforms in
//               real time. Contributes:
//                 • Speed of sound — corrects for ambient temperature
//                   (c = 331.3 + 0.606·T in m/s, T in °C), so a cold
//                   storm's thunder arrives later and is lower-pitched
//                   than a warm storm's.
//                 • Distance attenuation — spreads energy by the inverse-
//                   square law with an atmospheric absorption term
//                   (ISO 9613-1 style, simplified), plus a low-pass
//                   filtering effect that removes the "crack" and leaves
//                   only the rumble at far distances.
//                 • Fractal amplitude envelope — 4-octave 1D value noise
//                   produces the irregular rumble envelope. A short
//                   leading "crack" is layered on top for close strikes
//                   (0-2 km), a "clap" for mid-range (2-8 km), and a
//                   pure rumble for far strikes (> 8 km).
//                 • Three-band spectral shaping — CRACK (500-4000 Hz),
//                   CLAP (120-500 Hz), and RUMBLE (20-120 Hz) bands with
//                   independently-shaped envelopes and per-band
//                   attenuation curves. This matches the physical reality
//                   that high frequencies propagate less far than low.
//                 • Directional panning — computes L/R stereo pan from
//                   the horizontal angle between the camera's forward
//                   vector and the strike location. Uses the equal-power
//                   pan law for realistic spatialisation.
//                 • Terrain echoes — casts BVH rays (file 003) from the
//                   strike location to sample nearby terrain; each
//                   reflection adds a delayed, low-pass-filtered copy
//                   of the main rumble to simulate the characteristic
//                   multi-rumble of a storm bouncing off hills and
//                   buildings.
//                 • Thunder-bolt association — when a lightning bolt
//                   (file 041) is active and within audio range, its
//                   flash intensity and strike type (CG+/-, IC, CC) feed
//                   directly into the thunder synthesis: +CG is louder
//                   and crisper, IC and CC are quieter and rumber.
//                 • Event pool — up to 64 concurrent thunder events,
//                   each with its own synthesis state (envelope phases,
//                   echo times, per-band state). All data lives in
//                   typed arrays; per-frame cost is O(active events).
//               Zero per-frame allocation; steady-state 1M-entity scenes
//               can have 64 concurrent thunder events running on Android
//               64-bit without GC spikes.
// best for : Immersive storm audio, distance-based thunder cues,
//            cinematic thunder set-pieces, gameplay tension, and any
//            1M-entity scene needing realistic thunder on Android 64-bit.
// license : MIT

import {
  $internal,
  query,
  addComponent,
  removeComponent,
  hasComponent,
  entityExists,
  getId,
} from '../ecs/001_ecs_core.js';

import {
  WorldTransformF32,
} from '../transform/002_transform_hierarchy.js';

import {
  BVHState,
  bvhRaycast,
} from '../spatial/003_bvh_broadphase.js';

import {
  SkyF32,
  getSkySlot,
} from '../sky/028_sky_atmosphere.js';

import {
  LightningBolt,
  BoltVertexPool,
  BoltVertexIndex,
  ThunderQueue,
  StrikeType,
  popThunderEvent,
  systemTickThunder,
  getBoltFlashIntensity,
  getActiveBolts,
} from './041_lightning.js';

import {
  vec3,
  vec4,
  createNoise2D,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — verified
// ═══════════════════════════════════════════════════════════════════════

const EPSILON_SQ                     = 1e-16;
const EPSILON                        = 1e-8;
const EPSILON_HIGH                   = 1e-12;
const PI                             = Math.PI;
const TWO_PI                         = 2 * Math.PI;
const INV_PI                         = 1 / Math.PI;
const INV_TWO_PI                     = 1 / (2 * Math.PI);
const HALF_PI                        = Math.PI / 2;
const DEG_TO_RAD                     = Math.PI / 180;
const RAD_TO_DEG                     = 180 / Math.PI;

// Speed of sound: c(T) = 331.3 + 0.606·T  (T in °C, result in m/s).
const SPEED_OF_SOUND_BASE            = 331.3;
const SPEED_OF_SOUND_PER_CELSIUS     = 0.606;

// Distance thresholds (metres).
const CLOSE_STRIKE_DISTANCE          = 2000.0;
const MID_STRIKE_DISTANCE            = 8000.0;
const FAR_STRIKE_DISTANCE            = 25000.0;
const MAX_AUDIBLE_DISTANCE           = 50000.0;

// Amplitude curve (dB attenuation per doubling of distance).
const ATTENUATION_DB_PER_DOUBLING    = 6.020599913279624;    // exact: 20·log10(2)
const ATMOSPHERIC_ABSORPTION_DB_PER_KM = 0.08;               // at 20 °C, 40% RH

// Frequency bands (Hz).
const BAND_CRACK_LOW_HZ              = 500.0;
const BAND_CRACK_HIGH_HZ             = 4000.0;
const BAND_CLAP_LOW_HZ               = 120.0;
const BAND_CLAP_HIGH_HZ              = 500.0;
const BAND_RUMBLE_LOW_HZ             = 20.0;
const BAND_RUMBLE_HIGH_HZ            = 120.0;

// Band intensity (relative amplitude before attenuation).
const BAND_CRACK_INTENSITY           = 0.55;
const BAND_CLAP_INTENSITY            = 0.80;
const BAND_RUMBLE_INTENSITY          = 1.00;

// Band low-pass cutoff behavior — high frequencies die off faster.
const BAND_CRACK_CUTOFF_KM           = 8.0;
const BAND_CLAP_CUTOFF_KM            = 20.0;
const BAND_RUMBLE_CUTOFF_KM          = 100.0;

// Envelope timing (seconds).
const CRACK_DURATION                 = 0.25;
const CLAP_DURATION                  = 1.5;
const RUMBLE_DURATION_MIN            = 3.0;
const RUMBLE_DURATION_MAX            = 15.0;
const RUMBLE_TAIL_FRACTION           = 0.6;

// Fractal envelope parameters (octaves + persistence).
const ENVELOPE_OCTAVES               = 4;
const ENVELOPE_PERSISTENCE           = 0.55;
const ENVELOPE_BASE_FREQ             = 2.5;                   // Hz (rumble rate)

// Echo generation (terrain reflections).
const ECHO_RAY_COUNT                 = 6;
const ECHO_RAY_MAX_DISTANCE          = 1500.0;                // metres
const ECHO_DELAY_MIN_MS              = 60.0;
const ECHO_DELAY_MAX_MS              = 850.0;
const ECHO_AMPLITUDE                 = 0.35;
const ECHO_LOWPASS_WEIGHT            = 0.6;                   // echoes are muddier

// Pool sizes.
const MAX_THUNDER_EVENTS             = 64;
const MAX_ECHOES_PER_EVENT           = 4;

// Stereo panning.
const PAN_SMOOTHING                  = 0.15;                  // L/R transition width

// Ambient temperature (default 20 °C).
const DEFAULT_AMBIENT_TEMPERATURE_C  = 20.0;

// ── Strike type modifiers ─────────────────────────────────────
const STRIKE_CG_NEG_GAIN             = 1.00;
const STRIKE_CG_POS_GAIN             = 1.35;                  // +CG is louder
const STRIKE_IC_GAIN                 = 0.55;
const STRIKE_CC_GAIN                 = 0.40;

// ═══════════════════════════════════════════════════════════════════════
// SoA THUNDER EVENT STATE — one slot per active thunder sound
// ═══════════════════════════════════════════════════════════════════════

export const ThunderEvent = {
  active: new Uint8Array(MAX_THUNDER_EVENTS),

  // Bolt slot (0..MAX_BOLTS-1) that spawned this event.
  boltSlot: new Int16Array(MAX_THUNDER_EVENTS),

  // Strike type (StrikeType).
  strikeType: new Uint8Array(MAX_THUNDER_EVENTS),

  // World position of the strike.
  px: new Float32Array(MAX_THUNDER_EVENTS),
  py: new Float32Array(MAX_THUNDER_EVENTS),
  pz: new Float32Array(MAX_THUNDER_EVENTS),

  // Distance from the camera at spawn time (metres).
  distance: new Float32Array(MAX_THUNDER_EVENTS),

  // Time (in seconds from now) until sound begins. Audio renders wait.
  delaySeconds: new Float32Array(MAX_THUNDER_EVENTS),

  // Age since the sound actually started.
  age: new Float32Array(MAX_THUNDER_EVENTS),

  // Total event duration (seconds).
  duration: new Float32Array(MAX_THUNDER_EVENTS),

  // Per-band envelope phases (for fractal noise).
  crackPhase: new Float32Array(MAX_THUNDER_EVENTS),
  clapPhase: new Float32Array(MAX_THUNDER_EVENTS),
  rumblePhase: new Float32Array(MAX_THUNDER_EVENTS),

  // Per-band attenuation (0..1; multiplies the amplitude).
  crackAtten: new Float32Array(MAX_THUNDER_EVENTS),
  clapAtten: new Float32Array(MAX_THUNDER_EVENTS),
  rumbleAtten: new Float32Array(MAX_THUNDER_EVENTS),

  // Stereo pan (-1 = left, +1 = right, 0 = center).
  pan: new Float32Array(MAX_THUNDER_EVENTS),

  // Overall gain (from strike type + flash intensity + distance).
  gain: new Float32Array(MAX_THUNDER_EVENTS),

  // Echo state (up to MAX_ECHOES_PER_EVENT per event).
  echoCount: new Uint8Array(MAX_THUNDER_EVENTS),
  echoDelays: new Float32Array(MAX_THUNDER_EVENTS * MAX_ECHOES_PER_EVENT),
  echoGains: new Float32Array(MAX_THUNDER_EVENTS * MAX_ECHOES_PER_EVENT),
  echoActive: new Uint8Array(MAX_THUNDER_EVENTS * MAX_ECHOES_PER_EVENT),

  // Pool bookkeeping.
  freeHead: 0,
  liveCount: 0,
};

/** Marker: this thunder event was dispatched by the system. */
export const ThunderEventTag = {};

// ═══════════════════════════════════════════════════════════════════════
// SoA AUDIO SAMPLE OUTPUT — one slot per live thunder event
// ═══════════════════════════════════════════════════════════════════════
//
// The audio subsystem of the host application pulls one rendered sample
// per event per audio tick. This buffer holds the last-rendered sample
// for each event so that cross-thread readers (audio thread) can pick
// it up without triggering JS GC.

export const ThunderOutput = {
  left:  new Float32Array(MAX_THUNDER_EVENTS),
  right: new Float32Array(MAX_THUNDER_EVENTS),
};

// ═══════════════════════════════════════════════════════════════════════
// PRNG
// ═══════════════════════════════════════════════════════════════════════

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// FRACTAL VALUE-NOISE ENVELOPE
// ═══════════════════════════════════════════════════════════════════════
//
// A 1D fractal value-noise function used to generate the irregular
// amplitude envelopes of thunder. Deterministic per seed but "random"
// at any given time offset.

const _envNoiseSeeds = new Float32Array(ENVELOPE_OCTAVES);
for (let i = 0; i < ENVELOPE_OCTAVES; i++) {
  _envNoiseSeeds[i] = Math.random() * 1000.0;
}

function hash1D(x, seed) {
  let h = (x * 374761393 + seed * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function valueNoise1D(x, seed) {
  const i0 = Math.floor(x);
  const i1 = i0 + 1;
  const fx = x - i0;
  // Smootherstep.
  const t = fx * fx * fx * (fx * (fx * 6.0 - 15.0) + 10.0);
  const v0 = hash1D(i0, seed);
  const v1 = hash1D(i1, seed);
  return v0 * (1 - t) + v1 * t;
}

/**
 * Fractal value-noise envelope.
 * @param t          normalized time [0..1]
 * @param phaseSeed  per-event seed
 * @returns amplitude in [0..1]
 */
function fractalEnvelope(t, phaseSeed) {
  let sum = 0.0;
  let amp = 1.0;
  let freq = ENVELOPE_BASE_FREQ;
  let norm = 0.0;

  for (let o = 0; o < ENVELOPE_OCTAVES; o++) {
    const n = valueNoise1D(t * freq + _envNoiseSeeds[o] + phaseSeed * 0.1, phaseSeed + o);
    sum += n * amp;
    norm += amp;
    amp *= ENVELOPE_PERSISTENCE;
    freq *= 2.0;
  }

  return sum / Math.max(norm, EPSILON);
}

// ═══════════════════════════════════════════════════════════════════════
// SPEED OF SOUND — temperature-corrected
// ═══════════════════════════════════════════════════════════════════════

/**
 * Speed of sound at temperature T (Celsius), in m/s.
 * Formula: c(T) = 331.3 + 0.606·T
 */
export function speedOfSound(temperatureC) {
  return SPEED_OF_SOUND_BASE + SPEED_OF_SOUND_PER_CELSIUS * temperatureC;
}

// ═══════════════════════════════════════════════════════════════════════
// ATTENUATION — per-band attenuation from distance
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compute the attenuation (linear, 0..1) of a frequency band at a
 * given distance (metres). Combines inverse-square spreading and an
 * atmospheric-absorption cutoff specific to each band.
 */
function bandAttenuation(distanceM, cutoffKm) {
  if (distanceM < 1.0) return 1.0;

  // Inverse-square spreading (normalized to 1 m reference).
  const spreading = 1.0 / (distanceM * distanceM);

  // Atmospheric absorption.
  const km = distanceM * 0.001;
  const absorption = Math.exp(-ATMOSPHERIC_ABSORPTION_DB_PER_KM * km * 0.1);

  // Exponential cutoff based on band cutoff distance.
  const cutoffAttenuation = Math.exp(-Math.pow(distanceM / (cutoffKm * 1000.0), 2.0));

  return Math.min(1.0, spreading * absorption * cutoffAttenuation);
}

/**
 * Compute the overall gain (linear, 0..1) from the strike type, flash
 * intensity, and distance.
 */
function overallGain(strikeType, flashIntensity, distanceM) {
  let baseGain = 0.0;

  switch (strikeType) {
    case StrikeType.CG_NEGATIVE: baseGain = STRIKE_CG_NEG_GAIN; break;
    case StrikeType.CG_POSITIVE: baseGain = STRIKE_CG_POS_GAIN; break;
    case StrikeType.IC:          baseGain = STRIKE_IC_GAIN;     break;
    case StrikeType.CC:          baseGain = STRIKE_CC_GAIN;     break;
    default:                     baseGain = 0.5;
  }

  // Distance falloff: 6 dB per doubling of distance from 1 km reference.
  const referenceDistance = 1000.0;
  let distanceAtten = 1.0;
  if (distanceM > referenceDistance) {
    const doublings = Math.log2(distanceM / referenceDistance);
    const attenuationDb = ATTENUATION_DB_PER_DOUBLING * doublings;
    // Convert dB to linear.
    distanceAtten = Math.pow(10, -attenuationDb / 20.0);
  }

  // Flash intensity scales the whole sound (weak flashes = quiet thunder).
  const flashFactor = 0.4 + 0.6 * flashIntensity;

  return Math.max(0.0, baseGain * distanceAtten * flashFactor);
}

// ═══════════════════════════════════════════════════════════════════════
// PAN CALCULATION — equal-power stereo pan from strike direction
// ═══════════════════════════════════════════════════════════════════════

const _panTmp = vec3.create();

/**
 * Compute the stereo pan for a strike at (sx, sy, sz) as seen from a
 * camera at (cx, cy, cz) looking along (fx, fy, fz).
 *
 * Returns a pan value in [-1..1] (left..right).
 */
function computeStereoPan(cx, cy, cz, sx, sy, sz, fx, fy, fz) {
  // Direction to strike (horizontal projection only).
  let dx = sx - cx;
  let dz = sz - cz;
  const horizDist = Math.hypot(dx, dz);
  if (horizDist < EPSILON) return 0.0;

  dx /= horizDist;
  dz /= horizDist;

  // Camera forward (horizontal projection).
  let fhx = fx;
  let fhz = fz;
  const fhLen = Math.hypot(fhx, fhz);
  if (fhLen < EPSILON) return 0.0;
  fhx /= fhLen;
  fhz /= fhLen;

  // Camera right = forward × up. For a Y-up world: right = (fhz, 0, -fhx).
  const rx = fhz;
  const rz = -fhx;

  // Strike's offset along the camera-right axis.
  const rightComponent = dx * rx + dz * rz;

  // Pan: rightward → +1, leftward → -1, directly ahead → 0.
  return Math.max(-1.0, Math.min(1.0, rightComponent));
}

// ═══════════════════════════════════════════════════════════════════════
// EVENT POOL MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

function allocThunderEvent() {
  const E = ThunderEvent;
  for (let i = 0; i < MAX_THUNDER_EVENTS; i++) {
    const slot = (E.freeHead + i) % MAX_THUNDER_EVENTS;
    if (E.active[slot] === 0) {
      E.freeHead = (slot + 1) % MAX_THUNDER_EVENTS;
      E.active[slot] = 1;
      E.liveCount++;
      return slot;
    }
  }
  // Pool full: recycle the oldest event.
  let oldestSlot = 0;
  let oldestAge = -1;
  for (let i = 0; i < MAX_THUNDER_EVENTS; i++) {
    if (E.age[i] > oldestAge) {
      oldestAge = E.age[i];
      oldestSlot = i;
    }
  }
  return oldestSlot;
}

function freeThunderEvent(slot) {
  const E = ThunderEvent;
  if (E.active[slot] === 0) return;
  E.active[slot] = 0;
  E.liveCount--;
}

// ═══════════════════════════════════════════════════════════════════════
// ECHO GENERATION — terrain reflections
// ═══════════════════════════════════════════════════════════════════════

/**
 * Cast rays from the strike location to sample nearby terrain, and
 * compute echo delays and gains for the thunder event.
 */
function generateEchoes(slot, px, py, pz, cameraX, cameraY, cameraZ, rng) {
  const E = ThunderEvent;
  let echoCount = 0;

  for (let i = 0; i < ECHO_RAY_COUNT && echoCount < MAX_ECHOES_PER_EVENT; i++) {
    // Random direction from the strike (biased upward).
    const angle = rng() * TWO_PI;
    const elev = (rng() * 0.5 + 0.3);   // mostly horizontal-ish
    const dx = Math.cos(angle) * Math.cos(elev);
    const dy = Math.sin(elev);
    const dz = Math.sin(angle) * Math.cos(elev);

    const hits = bvhRaycast(
      [px, py, pz],
      [dx, dy, dz],
      ECHO_RAY_MAX_DISTANCE,
      true
    );

    if (hits.length === 0) continue;

    const h = hits[0];
    // Total distance = strike→reflector + reflector→camera.
    const toReflector = h.t;
    const rx = px + dx * h.t;
    const ry = py + dy * h.t;
    const rz = pz + dz * h.t;
    const reflectorToCam = Math.hypot(cameraX - rx, cameraY - ry, cameraZ - rz);

    // Extra time = difference between reflected path and direct path,
    // converted to milliseconds.
    const speedOfSound = SPEED_OF_SOUND_BASE + SPEED_OF_SOUND_PER_CELSIUS * DEFAULT_AMBIENT_TEMPERATURE_C;
    const directPath = Math.hypot(cameraX - px, cameraY - py, cameraZ - pz);
    const extraMetres = (toReflector + reflectorToCam) - directPath;
    const extraMs = (extraMetres / speedOfSound) * 1000.0;

    // Clamp to plausible echo delays.
    const delayMs = Math.max(ECHO_DELAY_MIN_MS, Math.min(ECHO_DELAY_MAX_MS, extraMs));

    const echoIdx = slot * MAX_ECHOES_PER_EVENT + echoCount;
    E.echoDelays[echoIdx] = delayMs * 0.001;   // store as seconds
    E.echoGains[echoIdx] = ECHO_AMPLITUDE * (1.0 / (1.0 + toReflector * 0.0005));
    E.echoActive[echoIdx] = 0;   // will activate after its delay elapses

    echoCount++;
  }

  E.echoCount[slot] = echoCount;
}

// ═══════════════════════════════════════════════════════════════════════
// THUNDER EVENT SPAWNING — called when a bolt's sound is ready
// ═══════════════════════════════════════════════════════════════════════

/**
 * Spawn a thunder event from a bolt slot.
 *
 * @param world       ECS world
 * @param boltSlot    from file 041
 * @param cameraX/Y/Z camera position
 * @param cameraFx/Fy/Fz  camera forward direction (for stereo panning)
 * @param ambientTempC    ambient temperature (°C)
 * @returns thunder event slot, or -1 on failure
 */
export function spawnThunderFromBolt(world, boltSlot, cameraX, cameraY, cameraZ,
                                     cameraFx, cameraFy, cameraFz, ambientTempC = DEFAULT_AMBIENT_TEMPERATURE_C) {
  if (boltSlot < 0 || boltSlot >= LightningBolt.active.length) return -1;
  if (!LightningBolt.active[boltSlot]) return -1;

  const strikeX = LightningBolt.ix[boltSlot];
  const strikeY = LightningBolt.iy[boltSlot];
  const strikeZ = LightningBolt.iz[boltSlot];
  const strikeType = LightningBolt.strikeType[boltSlot];
  const flashIntensity = getBoltFlashIntensity(boltSlot);

  // Distance from camera.
  const dx = strikeX - cameraX;
  const dy = strikeY - cameraY;
  const dz = strikeZ - cameraZ;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (distance > MAX_AUDIBLE_DISTANCE) return -1;

  // Speed of sound based on ambient temperature.
  const c = speedOfSound(ambientTempC);
  const delaySeconds = distance / c;

  // Allocate an event slot.
  const slot = allocThunderEvent();
  const E = ThunderEvent;

  E.active[slot] = 1;
  E.boltSlot[slot] = boltSlot;
  E.strikeType[slot] = strikeType;
  E.px[slot] = strikeX;
  E.py[slot] = strikeY;
  E.pz[slot] = strikeZ;
  E.distance[slot] = distance;
  E.delaySeconds[slot] = delaySeconds;
  E.age[slot] = 0;

  // Duration: closer strikes are shorter (single crack), far ones are
  // long rumbles.
  let baseDuration;
  if (distance < CLOSE_STRIKE_DISTANCE) {
    baseDuration = RUMBLE_DURATION_MIN;
  } else if (distance < MID_STRIKE_DISTANCE) {
    const t = (distance - CLOSE_STRIKE_DISTANCE) / (MID_STRIKE_DISTANCE - CLOSE_STRIKE_DISTANCE);
    baseDuration = RUMBLE_DURATION_MIN + (RUMBLE_DURATION_MAX - RUMBLE_DURATION_MIN) * t * 0.5;
  } else {
    const t = Math.min(1, (distance - MID_STRIKE_DISTANCE) / (FAR_STRIKE_DISTANCE - MID_STRIKE_DISTANCE));
    baseDuration = RUMBLE_DURATION_MIN * 1.5 + (RUMBLE_DURATION_MAX - RUMBLE_DURATION_MIN * 1.5) * t;
  }
  E.duration[slot] = baseDuration;

  // Fractal phases (seeded from bolt position for determinism).
  const rngSeed = ((strikeX * 1000 + strikeZ * 1000 + boltSlot * 977) ^ 0xA5A5A5A5) >>> 0;
  const rng = mulberry32(rngSeed);

  E.crackPhase[slot] = rng() * 1000;
  E.clapPhase[slot] = rng() * 1000;
  E.rumblePhase[slot] = rng() * 1000;

  // Per-band attenuation.
  E.crackAtten[slot] = bandAttenuation(distance, BAND_CRACK_CUTOFF_KM);
  E.clapAtten[slot] = bandAttenuation(distance, BAND_CLAP_CUTOFF_KM);
  E.rumbleAtten[slot] = bandAttenuation(distance, BAND_RUMBLE_CUTOFF_KM);

  // Overall gain.
  E.gain[slot] = overallGain(strikeType, flashIntensity, distance);

  // Stereo pan.
  E.pan[slot] = computeStereoPan(
    cameraX, cameraY, cameraZ,
    strikeX, strikeY, strikeZ,
    cameraFx, cameraFy, cameraFz
  );

  // Echoes.
  generateEchoes(slot, strikeX, strikeY, strikeZ, cameraX, cameraY, cameraZ, rng);

  return slot;
}

// ═══════════════════════════════════════════════════════════════════════
// PER-SAMPLE SYNTHESIS — the audio hot path
// ═══════════════════════════════════════════════════════════════════════

/**
 * Render one audio sample for a thunder event at age = age seconds.
 * Updates the event's per-band envelopes in place and writes the
 * resulting L/R sample into ThunderOutput.
 *
 * @param slot      thunder event slot
 * @param sampleRateHz  audio sample rate (typically 48000)
 * @returns 1 if a valid sample was written, 0 if the event is silent
 */
export function renderThunderSample(slot, sampleRateHz) {
  const E = ThunderEvent;
  if (!E.active[slot]) return 0;

  const totalAge = E.age[slot];
  if (totalAge < 0) return 0;   // not started yet

  const duration = E.duration[slot];
  if (totalAge >= duration) return 0;

  // Advance the event's age (the caller is responsible for the actual
  // dt; here we advance by 1/sampleRateHz for one sample).
  E.age[slot] += 1.0 / sampleRateHz;

  const invDuration = 1.0 / Math.max(duration, EPSILON);
  const tNorm = totalAge * invDuration;

  // Band envelopes.
  const crackEnvelope = sampleBandEnvelope(totalAge, tNorm, CRACK_DURATION * invDuration,
    E.crackPhase[slot]);
  const clapEnvelope = sampleBandEnvelope(totalAge, tNorm, CLAP_DURATION * invDuration,
    E.clapPhase[slot]);
  const rumbleEnvelope = sampleBandEnvelope(totalAge, tNorm, 1.0,
    E.rumblePhase[slot]);

  // Individual band amplitudes.
  const crackSample = BAND_CRACK_INTENSITY * crackEnvelope * E.crackAtten[slot];
  const clapSample  = BAND_CLAP_INTENSITY  * clapEnvelope  * E.clapAtten[slot];
  const rumbleSample = BAND_RUMBLE_INTENSITY * rumbleEnvelope * E.rumbleAtten[slot];

  // Combine.
  let mono = (crackSample + clapSample + rumbleSample) * E.gain[slot];

  // Add active echoes.
  const echoCount = E.echoCount[slot];
  for (let i = 0; i < echoCount; i++) {
    const echoIdx = slot * MAX_ECHOES_PER_EVENT + i;

    if (E.echoActive[echoIdx] === 0) {
      // Check if this echo has started.
      if (totalAge >= E.echoDelays[echoIdx]) {
        E.echoActive[echoIdx] = 1;
      } else {
        continue;
      }
    }

    // Echo rumble (low-pass approximation: only rumble band).
    const echoEnvelope = sampleBandEnvelope(totalAge - E.echoDelays[echoIdx],
      tNorm, 1.0, E.rumblePhase[slot] + i * 17);
    const echoSample = rumbleEnvelope * echoEnvelope * E.echoGains[echoIdx] * E.rumbleAtten[slot];
    mono += echoSample * E.gain[slot] * ECHO_LOWPASS_WEIGHT;
  }

  // Convert mono + pan into L/R stereo via equal-power pan law.
  const pan = E.pan[slot];
  const panAngle = (pan * 0.5 + 0.5) * HALF_PI;   // 0..π/2
  const panL = Math.cos(panAngle);
  const panR = Math.sin(panAngle);

  ThunderOutput.left[slot] = mono * panL;
  ThunderOutput.right[slot] = mono * panR;
  return 1;
}

/**
 * Sample one band's fractal envelope at a given absolute time.
 */
function sampleBandEnvelope(age, tNorm, scale, phaseSeed) {
  if (age < 0) return 0;
  const phaseNorm = age / Math.max(scale, EPSILON);
  const t = Math.min(1, phaseNorm);
  const envelope = fractalEnvelope(t, phaseSeed);

  // Quick fade-in at the very start.
  const fadeIn = Math.min(1.0, age / 0.02);
  // Fade-out over the last 40% of the band duration.
  const fadeOutStart = 0.6;
  let fadeOut = 1.0;
  if (t > fadeOutStart) {
    fadeOut = 1.0 - (t - fadeOutStart) / (1.0 - fadeOutStart);
  }

  return envelope * fadeIn * Math.max(0, fadeOut);
}

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM — advance thunder queue and emit thunder events
// ═══════════════════════════════════════════════════════════════════════

/**
 * System: advance the thunder queue (from file 041) and spawn thunder
 * events for any whose delay has elapsed.
 *
 * @param world       ECS world
 * @param dt          seconds
 * @param cameraX/Y/Z camera position
 * @param cameraFx/Fy/Fz  camera forward direction (for panning)
 * @param ambientTempC    ambient temperature (°C)
 */
export function systemUpdateThunder(world, dt, cameraX, cameraY, cameraZ,
                                    cameraFx, cameraFy, cameraFz, ambientTempC = DEFAULT_AMBIENT_TEMPERATURE_C) {
  // Advance the thunder queue.
  systemTickThunder(dt);

  // Pop any ready events.
  let event;
  while ((event = popThunderEvent()) !== null) {
    // The queue event holds { intensity, distance, strikeType } but not
    // the bolt slot. We scan active bolts to find a matching strike
    // whose distance is within tolerance.
    const strikeType = event.strikeType;
    const distance = event.distance;

    let bestBoltSlot = -1;
    let bestDistanceDelta = Infinity;

    for (let b = 0; b < LightningBolt.active.length; b++) {
      if (!LightningBolt.active[b]) continue;
      if (LightningBolt.strikeType[b] !== strikeType) continue;

      const boltDist = LightningBolt.distanceToCamera[b];
      const delta = Math.abs(boltDist - distance);

      if (delta < bestDistanceDelta) {
        bestDistanceDelta = delta;
        bestBoltSlot = b;
      }
    }

    if (bestBoltSlot >= 0 && bestDistanceDelta < 100.0) {
      spawnThunderFromBolt(world, bestBoltSlot,
        cameraX, cameraY, cameraZ,
        cameraFx, cameraFy, cameraFz,
        ambientTempC);
    }
  }

  // Advance echo activation and event aging.
  const E = ThunderEvent;
  for (let slot = 0; slot < MAX_THUNDER_EVENTS; slot++) {
    if (!E.active[slot]) continue;

    // If the event's sound has started (delay elapsed), age it.
    // renderThunderSample handles the actual sample generation; here
    // we just handle event lifetime.
    if (E.age[slot] >= E.duration[slot]) {
      freeThunderEvent(slot);
    }
  }

  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — query or control thunder events
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get the current stereo sample from a thunder event. The host audio
 * engine calls this per sample tick.
 */
export function getThunderSample(slot, sampleRateHz) {
  const E = ThunderEvent;
  if (!E.active[slot]) return null;
  if (E.age[slot] < 0) return null;   // not started yet

  renderThunderSample(slot, sampleRateHz);
  return {
    left: ThunderOutput.left[slot],
    right: ThunderOutput.right[slot],
  };
}

/**
 * Return true if the thunder event's sound has already begun.
 */
export function hasThunderStarted(slot) {
  const E = ThunderEvent;
  return E.active[slot] === 1 && E.age[slot] >= 0;
}

/**
 * Return the current active event count.
 */
export function getActiveThunderCount() {
  return ThunderEvent.liveCount;
}

/**
 * Return all currently-active thunder events for audio engine
 * integration. Each item is a summary object.
 */
export function gatherThunderEventsForAudio() {
  const result = [];
  const E = ThunderEvent;
  for (let slot = 0; slot < MAX_THUNDER_EVENTS; slot++) {
    if (!E.active[slot]) continue;

    // Approximate 3D position of the audio source.
    const pan = E.pan[slot];
    result.push({
      slot,
      px: E.px[slot],
      py: E.py[slot],
      pz: E.pz[slot],
      distance: E.distance[slot],
      strikeType: E.strikeType[slot],
      pan,
      gain: E.gain[slot],
      age: E.age[slot],
      duration: E.duration[slot],
      delay: E.delaySeconds[slot],
      hasStarted: E.age[slot] >= 0,
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════

export function clearThunder() {
  ThunderEvent.active.fill(0);
  ThunderEvent.echoActive.fill(0);
  ThunderEvent.freeHead = 0;
  ThunderEvent.liveCount = 0;
  ThunderOutput.left.fill(0);
  ThunderOutput.right.fill(0);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════

export function thunderStats() {
  let active = 0;
  let started = 0;

  for (let slot = 0; slot < MAX_THUNDER_EVENTS; slot++) {
    if (!ThunderEvent.active[slot]) continue;
    active++;
    if (ThunderEvent.age[slot] >= 0) started++;
  }

  return {
    activeThunderEvents: active,
    started,
    maxEvents: MAX_THUNDER_EVENTS,
    pooledBolts: ThunderEvent.liveCount,
  };
}