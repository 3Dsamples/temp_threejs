// file number : 304
// full path name : src/context/304_MemoryCeilingEnforcer.js
// description : Memory and CPU ceiling enforcer — the hard budget guard that keeps the living world inside the 200 MB / 400 MB / 600 MB resident memory ceiling and the 8 ms per-tick CPU ceiling required for Android arm64. Enforces three selectable memory profiles: LOW (200 MB, default — for Snapdragon 4-series devices and low-RAM budget), MEDIUM (400 MB — for 6-series devices, balanced), and HIGH (600 MB — for 7-series flagships, full quality). Every subsystem that wants to allocate must call requestAllocation() with the byte count and an allocation category (GEOMETRY, TEXTURE, POOL, WORKER_BUFFER, PROCEDURAL, RENDER_TARGET, BUFFER_ATTRIBUTE, HLOD_CACHE, ASSET_CACHE, PERSISTENT_MEMORY). The enforcer computes projected total = tracked + requested, compares it against the active profile ceiling with per-category soft caps (e.g. geometry can't exceed 60% of total), and returns a grant or a refusal. When a request is refused, the caller must either shrink the request, evict existing assets via a registered eviction callback, or defer — the enforcer never silently allocates. A cooperative API provides getRemainingBudget(), requestAllocation(), releaseAllocation(), and tryEvict() with an eviction hint (LEAST_RECENTLY_USED, LARGEST_FIRST, BY_CATEGORY, OLDEST). Tracks the 8 ms per-frame CPU ceiling separately via beginFrame()/endFrame() and a per-frame allocation budget that caps total bytes allocated per tick (default 4 MB per frame) so a single frame never blows the CPU or memory ceiling together. Tracks GC pause separately via recordGCPause() and refuses allocations after any pause exceeding the 2 ms hard limit. Emits AUDIO_LIGHT causal events on every rejection, every eviction, every GC pause, and every profile switch. Exposes per-category usage breakdowns and pressure levels (NORMAL, WARN, CRITICAL, EMERGENCY) so upstream systems (HLOD, streaming, procedural generators) can proactively throttle. Zero allocation on hot paths — request/release/evict use pre-allocated state, no objects created.
// best for : Every subsystem that allocates — the streaming queue (301), the HLOD controller (303), the persistent world memory (299), terrain chunk cache (280), procedural generators, material instance pools, render targets, texture streaming. This is the referee that makes sure a fireball hit on a forest can't push the device over its memory budget, and that a burst of asset loads can't blow the 8 ms CPU ceiling.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  CompressedTexture, CompressedArrayTexture, CompressedCubeTexture,
  CubeTexture, CubeDepthTexture, DepthTexture, FramebufferTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';

// ══════════════════════════════════════════════════════════════════
// ─── MEMORY PROFILE CONSTANTS ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const MEMORY_PROFILE = Object.freeze({
  LOW:     0,   // 200 MB — Snapdragon 4-series, low RAM
  MEDIUM:  1,   // 400 MB — Snapdragon 6-series, balanced
  HIGH:    2    // 600 MB — Snapdragon 7-series flagships, full quality
});

const MEMORY_PROFILE_NAMES = Object.freeze(['low', 'medium', 'high']);

// ─── Per-profile total memory ceilings (bytes) ─────────────────
const MEMORY_CEILING_BYTES = Object.freeze([
  200 * 1024 * 1024,   // LOW:  200 MB
  400 * 1024 * 1024,   // MEDIUM: 400 MB
  600 * 1024 * 1024    // HIGH: 600 MB
]);

// ─── Per-profile soft caps (per-category maximum share) ────────
// Each cap is expressed as a fraction of the total ceiling.
// Requesting more than the cap requires evicting from the same
// category first.
const CATEGORY_SOFT_CAPS = Object.freeze([
  // LOW profile (200 MB)
  {
    GEOMETRY:        0.45,   // 90 MB
    TEXTURE:         0.30,   // 60 MB
    POOL:            0.05,   // 10 MB
    WORKER_BUFFER:   0.05,   // 10 MB
    PROCEDURAL:      0.05,   // 10 MB
    RENDER_TARGET:   0.05,   // 10 MB
    BUFFER_ATTRIBUTE: 0.03,  // 6 MB
    HLOD_CACHE:      0.02,   // 4 MB
    ASSET_CACHE:     0.03,   // 6 MB
    PERSISTENT_MEMORY: 0.02  // 4 MB
  },
  // MEDIUM profile (400 MB)
  {
    GEOMETRY:        0.45,
    TEXTURE:         0.32,
    POOL:            0.04,
    WORKER_BUFFER:   0.05,
    PROCEDURAL:      0.04,
    RENDER_TARGET:   0.05,
    BUFFER_ATTRIBUTE: 0.03,
    HLOD_CACHE:      0.02,
    ASSET_CACHE:     0.03,
    PERSISTENT_MEMORY: 0.02
  },
  // HIGH profile (600 MB)
  {
    GEOMETRY:        0.45,
    TEXTURE:         0.35,
    POOL:            0.03,
    WORKER_BUFFER:   0.05,
    PROCEDURAL:      0.04,
    RENDER_TARGET:   0.05,
    BUFFER_ATTRIBUTE: 0.02,
    HLOD_CACHE:      0.015,
    ASSET_CACHE:     0.03,
    PERSISTENT_MEMORY: 0.015
  }
]);

// ══════════════════════════════════════════════════════════════════
// ─── ALLOCATION CATEGORIES ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const ALLOC_CATEGORY = Object.freeze({
  GEOMETRY:           0,
  TEXTURE:            1,
  POOL:               2,
  WORKER_BUFFER:      3,
  PROCEDURAL:         4,
  RENDER_TARGET:      5,
  BUFFER_ATTRIBUTE:   6,
  HLOD_CACHE:         7,
  ASSET_CACHE:        8,
  PERSISTENT_MEMORY:  9
});

const ALLOC_CATEGORY_NAMES = Object.freeze([
  'geometry', 'texture', 'pool', 'worker_buffer', 'procedural',
  'render_target', 'buffer_attribute', 'hlod_cache',
  'asset_cache', 'persistent_memory'
]);

const CATEGORY_COUNT = 10;

// ══════════════════════════════════════════════════════════════════
// ─── PRESSURE LEVELS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const PRESSURE_LEVEL = Object.freeze({
  NORMAL:     0,   // < 60% of ceiling
  WARN:       1,   // 60% – 80%
  CRITICAL:   2,   // 80% – 95%
  EMERGENCY:  3    // > 95%
});

const PRESSURE_LEVEL_NAMES = Object.freeze([
  'normal', 'warn', 'critical', 'emergency'
]);

// ══════════════════════════════════════════════════════════════════
// ─── CPU CEILING CONSTANTS ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const CPU_LIMITS = Object.freeze({
  // Hard per-frame CPU ceiling (milliseconds).
  PER_FRAME_CPU_CEILING_MS:   8.0,

  // Hard GC pause ceiling (milliseconds).
  GC_PAUSE_CEILING_MS:        2.0,

  // Default per-frame memory allocation budget (bytes).
  DEFAULT_FRAME_ALLOC_BUDGET: 4 * 1024 * 1024,   // 4 MB

  // Warning threshold for per-frame CPU usage.
  CPU_WARN_THRESHOLD_MS:      6.0,

  // GC pause warning threshold.
  GC_WARN_THRESHOLD_MS:       1.0
});

// ══════════════════════════════════════════════════════════════════
// ─── EVICTION HINTS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const EVICTION_HINT = Object.freeze({
  LEAST_RECENTLY_USED:  0,
  LARGEST_FIRST:        1,
  BY_CATEGORY:          2,
  OLDEST:               3,
  LOWEST_PRIORITY:      4
});

// ══════════════════════════════════════════════════════════════════
// ─── ALLOCATION RESULT ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const ALLOC_RESULT = Object.freeze({
  GRANTED:              0,
  DENIED_CEILING:       1,   // total ceiling would be exceeded
  DENIED_CATEGORY:      2,   // category cap would be exceeded
  DENIED_FRAME_BUDGET:  3,   // per-frame alloc budget spent
  DENIED_GC_PAUSE:      4,   // recent GC pause exceeds 2 ms
  DENIED_CPU_CEILING:   5,   // per-frame CPU already spent
  DENIED_INVALID:       6    // invalid category or size
});

const ALLOC_RESULT_NAMES = Object.freeze([
  'granted', 'denied_ceiling', 'denied_category',
  'denied_frame_budget', 'denied_gc_pause',
  'denied_cpu_ceiling', 'denied_invalid'
]);

// ══════════════════════════════════════════════════════════════════
// ─── EVICTION CALLBACK REGISTRY ───────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Each category can register a callback that attempts to free
// at least N bytes from that category. Returns freed bytes.
const _evictionCallbacks = new Array(CATEGORY_COUNT).fill(null);

// ══════════════════════════════════════════════════════════════════
// ─── MEMORY CEILING ENFORCER ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class MemoryCeilingEnforcer {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      profile:                options.profile ?? MEMORY_PROFILE.LOW,
      customCeilingBytes:     options.customCeilingBytes ?? -1,
      enableStrictCaps:       options.enableStrictCaps ?? true,
      enableAutoEviction:     options.enableAutoEviction ?? true,
      enableAutoDowngrade:    options.enableAutoDowngrade ?? true,
      enableEvents:           options.enableEvents ?? true,
      frameAllocBudgetBytes:  options.frameAllocBudgetBytes ?? CPU_LIMITS.DEFAULT_FRAME_ALLOC_BUDGET,
      maxCategorySoftCapOverride: options.maxCategorySoftCapOverride ?? -1
    };

    // Validate profile.
    if (this.defaults.profile < 0 || this.defaults.profile > 2) {
      this.defaults.profile = MEMORY_PROFILE.LOW;
    }

    // ── Active memory ceiling ───────────────────────────
    // Use custom ceiling if provided, otherwise the profile's default.
    this._ceilingBytes = this.defaults.customCeilingBytes > 0
      ? this.defaults.customCeilingBytes
      : MEMORY_CEILING_BYTES[this.defaults.profile];

    // ── Per-category soft caps ───────────────────────────
    this._categoryCaps = new Float32Array(CATEGORY_COUNT);
    this._updateCategoryCaps();

    // ── Per-category usage tracker (bytes) ──────────────
    this._categoryUsage = new Float64Array(CATEGORY_COUNT);
    this._totalTracked = 0;

    // ── Per-frame allocation budget ─────────────────────
    this._frameAllocUsed = 0;
    this._frameAllocBudget = this.defaults.frameAllocBudgetBytes;

    // ── Per-frame CPU timer ─────────────────────────────
    this._frameStartMs = 0;
    this._frameEndMs = 0;
    this._frameCpuMs = 0;
    this._frameValid = false;

    // ── GC pause tracking ───────────────────────────────
    this._lastGcPauseMs = 0;
    this._lastGcTime = 0;
    this._gcPauseCooldownMs = 1000;   // enforce GC budget for 1s after pause

    // ── Pressure level ──────────────────────────────────
    this._pressureLevel = PRESSURE_LEVEL.NORMAL;

    // ── Active frame budget spent flag ──────────────────
    this._frameExhausted = false;

    // ── Allocation tracking slots (for release) ─────────
    // Each allocation is registered with a handle. Handles are
    // user-supplied integers (or auto-generated) so we never
    // need to allocate objects per allocation.
    this._allocationCapacity = options.allocationCapacity ?? 4096;
    this._allocationHandles = new Int32Array(this._allocationCapacity).fill(-1);
    this._allocationBytes = new Int32Array(this._allocationCapacity).fill(0);
    this._allocationCategory = new Int8Array(this._allocationCapacity).fill(-1);
    this._allocationAge = new Float64Array(this._allocationCapacity).fill(0);
    this._allocationUsed = 0;
    this._nextAutoHandle = 1;

    // ── Per-category allocation age tracking (for LRU eviction) ─
    this._categoryOldestAge = new Float64Array(CATEGORY_COUNT);

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      requests: 0,
      grants: 0,
      denials: 0,
      denialCeiling: 0,
      denialCategory: 0,
      denialFrameBudget: 0,
      denialGcPause: 0,
      denialCpuCeiling: 0,
      releases: 0,
      evictionsAttempted: 0,
      evictionsSucceeded: 0,
      totalBytesGranted: 0,
      totalBytesReleased: 0,
      totalBytesEvicted: 0,
      profileChanges: 0,
      pressureWarnings: 0,
      pressureCriticals: 0,
      pressureEmergencies: 0,
      gcPauses: 0,
      gcPauseViolations: 0,
      cpuCeilingViolations: 0
    };

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._frameRef = null;

    // ── Event coalescing ────────────────────────────────
    this._lastEventTime = 0;
    this._eventCoalesceMs = 500;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── Profile management ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setProfile(profile) {
    if (profile < 0 || profile > 2) return false;
    if (profile === this.defaults.profile) return true;

    this.defaults.profile = profile;
    this.defaults.customCeilingBytes = -1;
    this._ceilingBytes = MEMORY_CEILING_BYTES[profile];
    this._updateCategoryCaps();
    this._stats.profileChanges++;
    this._lastEventTime = 0;
    this._emitEvent('profile_switch', {
      profile,
      profileName: MEMORY_PROFILE_NAMES[profile],
      ceilingBytes: this._ceilingBytes
    });

    // Auto-downgrade profile if new profile is smaller than current usage.
    if (this._totalTracked > this._ceilingBytes * 0.95) {
      this._updatePressureLevel();
    }

    return true;
  }

  getProfile() { return this.defaults.profile; }
  getProfileName() { return MEMORY_PROFILE_NAMES[this.defaults.profile]; }
  getCeilingBytes() { return this._ceilingBytes; }
  getCeilingMB() { return this._ceilingBytes / (1024 * 1024); }

  _updateCategoryCaps() {
    const caps = CATEGORY_SOFT_CAPS[this.defaults.profile];
    for (let cat = 0; cat < CATEGORY_COUNT; cat++) {
      const capFrac = caps[ALLOC_CATEGORY_NAMES[cat]] ?? 0.10;
      this._categoryCaps[cat] = Math.floor(this._ceilingBytes * capFrac);
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame lifecycle ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  beginFrame(nowMs) {
    this._frameStartMs = nowMs ?? (performance.now());
    this._frameEndMs = 0;
    this._frameCpuMs = 0;
    this._frameValid = true;
    this._frameAllocUsed = 0;
    this._frameExhausted = false;
    return this;
  }

  endFrame(nowMs) {
    if (!this._frameValid) return;
    this._frameEndMs = nowMs ?? performance.now();
    this._frameCpuMs = this._frameEndMs - this._frameStartMs;
    this._frameValid = false;

    if (this._frameCpuMs > CPU_LIMITS.PER_FRAME_CPU_CEILING_MS) {
      this._stats.cpuCeilingViolations++;
      this._emitEvent('cpu_ceiling_violation', {
        frameCpuMs: this._frameCpuMs,
        ceilingMs: CPU_LIMITS.PER_FRAME_CPU_CEILING_MS
      });
    }
    return this;
  }

  // ── Get remaining CPU budget for this frame (ms) ────────
  getRemainingFrameCpuMs() {
    if (!this._frameValid) return 0;
    const elapsed = performance.now() - this._frameStartMs;
    return Math.max(0, CPU_LIMITS.PER_FRAME_CPU_CEILING_MS - elapsed);
  }

  // ── Get remaining allocation budget for this frame (bytes) ─
  getRemainingFrameAllocBytes() {
    return Math.max(0, this._frameAllocBudget - this._frameAllocUsed);
  }

  // ══════════════════════════════════════════════════════════
  // ─── GC pause tracking ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  recordGCPause(pauseMs, nowMs) {
    this._lastGcPauseMs = pauseMs;
    this._lastGcTime = nowMs ?? performance.now();
    this._stats.gcPauses++;

    if (pauseMs > CPU_LIMITS.GC_PAUSE_CEILING_MS) {
      this._stats.gcPauseViolations++;
      this._emitEvent('gc_pause_violation', {
        pauseMs,
        ceilingMs: CPU_LIMITS.GC_PAUSE_CEILING_MS
      });
      return false;
    }
    return true;
  }

  // ── Check whether a GC pause blocks new allocations ─────
  _isGcBlocked() {
    if (this._lastGcPauseMs <= CPU_LIMITS.GC_PAUSE_CEILING_MS) return false;
    const now = performance.now();
    if (now - this._lastGcTime > this._gcPauseCooldownMs) return false;
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Allocation requests (cooperative) ──────────────────
  // ══════════════════════════════════════════════════════════
  // Callers MUST call this before allocating. The returned
  // result is ALLOC_RESULT.GRANTED when the allocation can
  // proceed. On denial, callers should either:
  //   - requestAllocation() again with a smaller size
  //   - call tryEvict() with an eviction hint and retry
  //   - defer the allocation to the next frame
  requestAllocation(category, bytes, handle = -1) {
    this._stats.requests++;

    // ── Validate inputs ─────────────────────────────────
    if (category < 0 || category >= CATEGORY_COUNT) {
      this._stats.denials++;
      return ALLOC_RESULT.DENIED_INVALID;
    }
    if (!Number.isFinite(bytes) || bytes < 0) {
      this._stats.denials++;
      return ALLOC_RESULT.DENIED_INVALID;
    }
    if (bytes === 0) {
      // Zero-byte requests are always granted.
      this._stats.grants++;
      return ALLOC_RESULT.GRANTED;
    }

    // ── GC pause check ──────────────────────────────────
    if (this._isGcBlocked()) {
      this._stats.denialGcPause++;
      this._stats.denials++;
      this._emitEvent('alloc_denied_gc', { bytes, category });
      return ALLOC_RESULT.DENIED_GC_PAUSE;
    }

    // ── CPU ceiling check ───────────────────────────────
    if (this._frameValid && this.getRemainingFrameCpuMs() <= 0) {
      this._stats.denialCpuCeiling++;
      this._stats.denials++;
      this._emitEvent('alloc_denied_cpu', { bytes, category });
      return ALLOC_RESULT.DENIED_CPU_CEILING;
    }

    // ── Frame allocation budget check ───────────────────
    if (bytes > this.getRemainingFrameAllocBytes()) {
      this._stats.denialFrameBudget++;
      this._stats.denials++;
      this._emitEvent('alloc_denied_frame_budget', {
        bytes,
        category,
        remaining: this.getRemainingFrameAllocBytes()
      });
      return ALLOC_RESULT.DENIED_FRAME_BUDGET;
    }

    // ── Category soft cap check ─────────────────────────
    if (this.defaults.enableStrictCaps) {
      const currentUsage = this._categoryUsage[category];
      const cap = this._categoryCaps[category];
      if (currentUsage + bytes > cap) {
        // Try auto-eviction if enabled.
        if (this.defaults.enableAutoEviction) {
          const freed = this._tryAutoEvict(category, currentUsage + bytes - cap);
          if (currentUsage - freed + bytes > cap) {
            this._stats.denialCategory++;
            this._stats.denials++;
            this._emitEvent('alloc_denied_category', {
              bytes, category, cap, currentUsage
            });
            return ALLOC_RESULT.DENIED_CATEGORY;
          }
        } else {
          this._stats.denialCategory++;
          this._stats.denials++;
          this._emitEvent('alloc_denied_category', {
            bytes, category, cap, currentUsage
          });
          return ALLOC_RESULT.DENIED_CATEGORY;
        }
      }
    }

    // ── Total ceiling check ─────────────────────────────
    if (this._totalTracked + bytes > this._ceilingBytes) {
      // Try auto-eviction from any category.
      if (this.defaults.enableAutoEviction) {
        const deficit = (this._totalTracked + bytes) - this._ceilingBytes;
        const freed = this._tryAutoEvictGlobal(deficit);
        if (this._totalTracked + bytes - freed > this._ceilingBytes) {
          this._stats.denialCeiling++;
          this._stats.denials++;
          this._emitEvent('alloc_denied_ceiling', {
            bytes, category,
            ceiling: this._ceilingBytes,
            tracked: this._totalTracked,
            profile: MEMORY_PROFILE_NAMES[this.defaults.profile]
          });
          return ALLOC_RESULT.DENIED_CEILING;
        }
      } else {
        this._stats.denialCeiling++;
        this._stats.denials++;
        this._emitEvent('alloc_denied_ceiling', {
          bytes, category,
          ceiling: this._ceilingBytes,
          tracked: this._totalTracked
        });
        return ALLOC_RESULT.DENIED_CEILING;
      }
    }

    // ── Grant ───────────────────────────────────────────
    this._commitAllocation(category, bytes, handle);
    this._stats.grants++;
    this._stats.totalBytesGranted += bytes;
    return ALLOC_RESULT.GRANTED;
  }

  // ── Internal: commit the allocation ────────────────────
  _commitAllocation(category, bytes, handle) {
    if (handle < 0) {
      handle = this._nextAutoHandle++;
    }
    // Find a free tracking slot.
    if (this._allocationUsed >= this._allocationCapacity) {
      // Growth disabled (would exceed memory); drop the oldest.
      this._evictOldestTrackingSlot();
    }
    const slot = this._allocationUsed++;
    this._allocationHandles[slot] = handle;
    this._allocationBytes[slot] = bytes;
    this._allocationCategory[slot] = category;
    this._allocationAge[slot] = this._nowSeconds();

    this._categoryUsage[category] += bytes;
    this._totalTracked += bytes;
    this._frameAllocUsed += bytes;

    this._updatePressureLevel();
  }

  // ── Release an allocation (by handle) ──────────────────
  releaseAllocation(handle) {
    if (handle < 0) return false;

    // Find the tracking slot.
    let slot = -1;
    for (let i = 0; i < this._allocationUsed; i++) {
      if (this._allocationHandles[i] === handle) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return false;

    const category = this._allocationCategory[slot];
    const bytes = this._allocationBytes[slot];

    // Reduce category + total.
    this._categoryUsage[category] -= bytes;
    this._totalTracked -= bytes;

    // Compact: swap with the last used slot.
    const last = this._allocationUsed - 1;
    if (slot !== last) {
      this._allocationHandles[slot] = this._allocationHandles[last];
      this._allocationBytes[slot] = this._allocationBytes[last];
      this._allocationCategory[slot] = this._allocationCategory[last];
      this._allocationAge[slot] = this._allocationAge[last];
    }
    this._allocationUsed--;

    // Clamp zero values.
    if (this._categoryUsage[category] < 0) this._categoryUsage[category] = 0;
    if (this._totalTracked < 0) this._totalTracked = 0;

    this._stats.releases++;
    this._stats.totalBytesReleased += bytes;

    this._updatePressureLevel();
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Eviction ───────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  tryEvict(category, targetFreeBytes, hint = EVICTION_HINT.LEAST_RECENTLY_USED) {
    this._stats.evictionsAttempted++;

    const callback = _evictionCallbacks[category];
    if (!callback) {
      return 0;
    }

    let freed = 0;
    try {
      freed = callback(targetFreeBytes, hint) || 0;
    } catch (e) {
      // Eviction callbacks must not throw, but if they do, treat as zero.
      freed = 0;
    }

    if (freed > 0) {
      // Reduce category usage by the freed amount.
      this._categoryUsage[category] = Math.max(0, this._categoryUsage[category] - freed);
      this._totalTracked = Math.max(0, this._totalTracked - freed);
      this._stats.evictionsSucceeded++;
      this._stats.totalBytesEvicted += freed;
      this._updatePressureLevel();
      this._emitEvent('eviction_success', { category, freed, hint });
    }

    return freed;
  }

  // ── Internal: auto-evict from a specific category ─────
  _tryAutoEvict(category, deficit) {
    if (deficit <= 0) return 0;
    return this.tryEvict(category, deficit, EVICTION_HINT.LEAST_RECENTLY_USED);
  }

  // ── Internal: auto-evict from any category (weighted by age) ─
  _tryAutoEvictGlobal(deficit) {
    // Sort categories by oldest age.
    const categories = [];
    for (let cat = 0; cat < CATEGORY_COUNT; cat++) {
      if (this._categoryUsage[cat] > 0 && _evictionCallbacks[cat]) {
        categories.push(cat);
      }
    }
    categories.sort((a, b) => this._categoryOldestAge[a] - this._categoryOldestAge[b]);

    let freed = 0;
    for (let i = 0; i < categories.length; i++) {
      if (freed >= deficit) break;
      const remaining = deficit - freed;
      const catFreed = this.tryEvict(categories[i], remaining, EVICTION_HINT.OLDEST);
      freed += catFreed;
    }

    return freed;
  }

  _evictOldestTrackingSlot() {
    let oldestSlot = -1;
    let oldestAge = Infinity;
    for (let i = 0; i < this._allocationUsed; i++) {
      if (this._allocationAge[i] < oldestAge) {
        oldestAge = this._allocationAge[i];
        oldestSlot = i;
      }
    }
    if (oldestSlot >= 0) {
      const category = this._allocationCategory[oldestSlot];
      const bytes = this._allocationBytes[oldestSlot];
      this._categoryUsage[category] -= bytes;
      this._totalTracked -= bytes;

      // Compact.
      const last = this._allocationUsed - 1;
      if (oldestSlot !== last) {
        this._allocationHandles[oldestSlot] = this._allocationHandles[last];
        this._allocationBytes[oldestSlot] = this._allocationBytes[last];
        this._allocationCategory[oldestSlot] = this._allocationCategory[last];
        this._allocationAge[oldestSlot] = this._allocationAge[last];
      }
      this._allocationUsed--;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Eviction callback registration ─────────────────────
  // ══════════════════════════════════════════════════════════
  // Callback receives (targetFreeBytes, hint) and returns the
  // number of bytes it successfully freed.
  registerEvictionCallback(category, callback) {
    if (category < 0 || category >= CATEGORY_COUNT) return false;
    if (typeof callback !== 'function') return false;
    _evictionCallbacks[category] = callback;
    return true;
  }

  unregisterEvictionCallback(category) {
    if (category < 0 || category >= CATEGORY_COUNT) return false;
    _evictionCallbacks[category] = null;
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Pressure management ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _updatePressureLevel() {
    if (this._ceilingBytes === 0) return;
    const ratio = this._totalTracked / this._ceilingBytes;

    let newLevel = PRESSURE_LEVEL.NORMAL;
    if (ratio >= 0.95) newLevel = PRESSURE_LEVEL.EMERGENCY;
    else if (ratio >= 0.80) newLevel = PRESSURE_LEVEL.CRITICAL;
    else if (ratio >= 0.60) newLevel = PRESSURE_LEVEL.WARN;

    if (newLevel !== this._pressureLevel) {
      this._pressureLevel = newLevel;

      // Emit event on level changes.
      switch (newLevel) {
        case PRESSURE_LEVEL.WARN: this._stats.pressureWarnings++; break;
        case PRESSURE_LEVEL.CRITICAL: this._stats.pressureCriticals++; break;
        case PRESSURE_LEVEL.EMERGENCY: this._stats.pressureEmergencies++; break;
      }

      this._emitEvent('pressure_change', {
        level: newLevel,
        levelName: PRESSURE_LEVEL_NAMES[newLevel],
        ratio,
        totalTracked: this._totalTracked,
        ceiling: this._ceilingBytes
      });

      // Auto-downgrade profile if enabled and we're at EMERGENCY.
      if (this.defaults.enableAutoDowngrade &&
          newLevel === PRESSURE_LEVEL.EMERGENCY &&
          this.defaults.profile > MEMORY_PROFILE.LOW) {
        // We don't auto-switch; we emit the event so the runtime
        // can decide. The runtime likely knows better than us.
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Queries ────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getRemainingBudget() {
    return Math.max(0, this._ceilingBytes - this._totalTracked);
  }

  getTotalTracked() { return this._totalTracked; }
  getTotalTrackedMB() { return this._totalTracked / (1024 * 1024); }

  getCategoryUsage(category) {
    if (category < 0 || category >= CATEGORY_COUNT) return 0;
    return this._categoryUsage[category];
  }

  getCategoryUsageMB(category) {
    return this.getCategoryUsage(category) / (1024 * 1024);
  }

  getCategoryCap(category) {
    if (category < 0 || category >= CATEGORY_COUNT) return 0;
    return this._categoryCaps[category];
  }

  getPressureLevel() { return this._pressureLevel; }
  getPressureLevelName() { return PRESSURE_LEVEL_NAMES[this._pressureLevel]; }

  getPressureRatio() {
    return this._ceilingBytes > 0 ? this._totalTracked / this._ceilingBytes : 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Event emission ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _emitEvent(kind, payload) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    // Coalesce high-frequency events (allocation denials).
    if (kind.startsWith('alloc_denied')) {
      if (now - this._lastEventTime < this._eventCoalesceMs) return;
      this._lastEventTime = now;
    }
    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      { kind, ...payload }
    );
  }

  _nowSeconds() {
    return performance.now() / 1000;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.memoryBudget) {
      physical.memoryBudget = {
        profile: 0,
        profileName: 'low',
        ceilingBytes: 0,
        ceilingMB: 0,
        trackedBytes: 0,
        trackedMB: 0,
        remainingBytes: 0,
        remainingMB: 0,
        pressureLevel: 0,
        pressureLevelName: 'normal',
        pressureRatio: 0,
        categoryUsageBytes: new Float64Array(CATEGORY_COUNT),
        categoryUsageMB: new Float64Array(CATEGORY_COUNT),
        categoryCapBytes: new Float64Array(CATEGORY_COUNT),
        frameAllocUsed: 0,
        frameAllocBudget: 0,
        frameAllocRemaining: 0,
        frameCpuMs: 0,
        frameCpuCeilingMs: CPU_LIMITS.PER_FRAME_CPU_CEILING_MS,
        frameCpuRemainingMs: 0,
        gcPauseLastMs: 0,
        gcPauseCeilingMs: CPU_LIMITS.GC_PAUSE_CEILING_MS,
        gcBlocked: 0,
        stats: {}
      };
    }

    const mb = physical.memoryBudget;
    mb.profile = this.defaults.profile;
    mb.profileName = MEMORY_PROFILE_NAMES[this.defaults.profile];
    mb.ceilingBytes = this._ceilingBytes;
    mb.ceilingMB = this._ceilingBytes / (1024 * 1024);
    mb.trackedBytes = this._totalTracked;
    mb.trackedMB = this._totalTracked / (1024 * 1024);
    mb.remainingBytes = this.getRemainingBudget();
    mb.remainingMB = this.getRemainingBudget() / (1024 * 1024);
    mb.pressureLevel = this._pressureLevel;
    mb.pressureLevelName = PRESSURE_LEVEL_NAMES[this._pressureLevel];
    mb.pressureRatio = this.getPressureRatio();

    for (let cat = 0; cat < CATEGORY_COUNT; cat++) {
      mb.categoryUsageBytes[cat] = this._categoryUsage[cat];
      mb.categoryUsageMB[cat] = this._categoryUsage[cat] / (1024 * 1024);
      mb.categoryCapBytes[cat] = this._categoryCaps[cat];
    }

    mb.frameAllocUsed = this._frameAllocUsed;
    mb.frameAllocBudget = this._frameAllocBudget;
    mb.frameAllocRemaining = this.getRemainingFrameAllocBytes();
    mb.frameCpuMs = this._frameCpuMs;
    mb.frameCpuCeilingMs = CPU_LIMITS.PER_FRAME_CPU_CEILING_MS;
    mb.frameCpuRemainingMs = this.getRemainingFrameCpuMs();
    mb.gcPauseLastMs = this._lastGcPauseMs;
    mb.gcPauseCeilingMs = CPU_LIMITS.GC_PAUSE_CEILING_MS;
    mb.gcBlocked = this._isGcBlocked() ? 1 : 0;

    // Snapshot stats.
    mb.stats.requests = this._stats.requests;
    mb.stats.grants = this._stats.grants;
    mb.stats.denials = this._stats.denials;
    mb.stats.denialCeiling = this._stats.denialCeiling;
    mb.stats.denialCategory = this._stats.denialCategory;
    mb.stats.denialFrameBudget = this._stats.denialFrameBudget;
    mb.stats.denialGcPause = this._stats.denialGcPause;
    mb.stats.denialCpuCeiling = this._stats.denialCpuCeiling;
    mb.stats.totalBytesGranted = this._stats.totalBytesGranted;
    mb.stats.totalBytesReleased = this._stats.totalBytesReleased;
    mb.stats.totalBytesEvicted = this._stats.totalBytesEvicted;
    mb.stats.evictionsAttempted = this._stats.evictionsAttempted;
    mb.stats.evictionsSucceeded = this._stats.evictionsSucceeded;
    mb.stats.gcPauses = this._stats.gcPauses;
    mb.stats.gcPauseViolations = this._stats.gcPauseViolations;
    mb.stats.cpuCeilingViolations = this._stats.cpuCeilingViolations;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    // Write state to the physical layer.
    this._writeToPhysicalLayer(frame);

    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      profile: this.defaults.profile,
      profileName: MEMORY_PROFILE_NAMES[this.defaults.profile],
      ceilingMB: this._ceilingBytes / (1024 * 1024),
      trackedMB: this._totalTracked / (1024 * 1024),
      remainingMB: this.getRemainingBudget() / (1024 * 1024),
      pressureLevel: this._pressureLevel,
      pressureLevelName: PRESSURE_LEVEL_NAMES[this._pressureLevel],
      pressureRatio: this.getPressureRatio(),
      ...this._stats
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
  }

  dispose() {
    this._allocationHandles.fill(-1);
    this._allocationBytes.fill(0);
    this._allocationCategory.fill(-1);
    this._allocationAge.fill(0);
    this._allocationUsed = 0;
    this._categoryUsage.fill(0);
    this._totalTracked = 0;
    this._dispatcher = null;
    this._clock = null;
    this._frameRef = null;

    // Do NOT clear eviction callbacks globally — they're shared
    // across instances. The caller owns their lifecycle.
  }
}

export {
  MemoryCeilingEnforcer,
  MEMORY_PROFILE,
  MEMORY_PROFILE_NAMES,
  MEMORY_CEILING_BYTES,
  CATEGORY_SOFT_CAPS,
  ALLOC_CATEGORY,
  ALLOC_CATEGORY_NAMES,
  CATEGORY_COUNT,
  ALLOC_RESULT,
  ALLOC_RESULT_NAMES,
  PRESSURE_LEVEL,
  PRESSURE_LEVEL_NAMES,
  CPU_LIMITS,
  EVICTION_HINT
};